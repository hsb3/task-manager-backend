#!/usr/bin/env bun
/**E2E test of the OAuth2 boot hook (`pb_hooks/oauth.pb.js`); spawns its own
clean-room `pocketbase serve` processes (temp --dir / --migrationsDir copy /
--hooksDir with only oauth.pb.js) — never touches the repo's real
pb_migrations, pb_hooks, or pb_data.

Headless-provable: with no GITHUB_CLIENT_ID/SECRET, auth-methods shows oauth2
disabled (boot hook no-ops); with dummy creds injected into the subprocess
env, it advertises a github provider with a PKCE authURL (S256, correct
scope/state/client_id, secret never appears), the SDK's oauth2-redirect
endpoint exists (307), and the boot hook's runtime save writes no migration
file. A third room stands up a FAKE OpenID provider in-process (a provider entry
whose authURL/tokenURL/userInfoURL point at a local http server) and drives a real
POST /api/collections/users/auth-with-oauth2 through it, which is what proves the
request hook's verified=true and its PBTT-529 account-linking on email_key.
NOT provable here (needs a real GitHub login in a browser): GitHub's own consent
round-trip and its profile-populated name/avatar.

Ports 8099 (env UNSET room), 8094 (env SET room), 8099 again (the LINKING room),
all + PB_PORT_OFFSET, run sequentially so they're never both in use. The fake
provider binds an EPHEMERAL port (bind 0) — it is not a PocketBase room and takes
no band.
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  py_get,
  py_str,
  run_checked,
  splitlines,
  sqlite_connect,
  tup,
  truthy,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const OAUTH_HOOK_SRC = path.join(REPO_ROOT, "pb_hooks", "oauth.pb.js");
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
// the ONLY file that enables _superusers MFA — dropped from the room's copy so a
// plain superuser auth-with-password returns a token (house clean-room idiom).
// Suffix, never a timestamp: a baseline rebuild renames it and a stale literal leaves MFA on.
const MFA_SUFFIX = "superuser_mfa.js";

// dummy creds, not real secrets — real ones live in .env / Railway service
// vars; this only proves the boot hook reacts to *some* env values.
const DUMMY_CLIENT_ID = "test_client_id_m17";
const DUMMY_CLIENT_SECRET = "test_secret_m17_do_not_use";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  const mark = ok ? "✅" : "❌ MISMATCH";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

async function api(
  base_url: string,
  method: string,
  path: string,
  body: any = null,
  token: string | null = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(base_url + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  if (r.ok) {
    if (r.status === 204) return [204, {}];
    return [r.status, JSON.parse(raw)];
  }
  try {
    return [r.status, JSON.parse(raw || "{}")];
  } catch {
    return [r.status, {}];
  }
}

// No-redirect fetch: /api/oauth2-redirect must be checked as a 307, not
// silently followed.
async function get_status_no_redirect(base_url: string, path: string): Promise<number> {
  const r = await fetch(base_url + path, { method: "GET", redirect: "manual" });
  return r.status;
}

function count_migration_files(migrations_dir: string): number {
  return fs.readdirSync(migrations_dir).filter((f) => f.endsWith(".js")).length;
}

// shortcut: urlparse's netloc/path/query split and parse_qs's drop-blank + unquote_plus only,
// the authURL shape PocketBase emits; upgrade if a second suite needs the rest of urllib.parse.
function urlparse(url: string): { netloc: string; path: string; query: string } {
  const m = /^(?:[^:/?#]+:)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/.exec(url)!;
  return { netloc: m[1] ?? "", path: m[2], query: m[3] ?? "" };
}

function parse_qs(query: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pair of query.split("&")) {
    const i = pair.indexOf("=");
    if (i < 0 || i === pair.length - 1) continue;
    const k = decodeURIComponent(pair.slice(0, i).replaceAll("+", " "));
    const v = decodeURIComponent(pair.slice(i + 1).replaceAll("+", " "));
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

/** One self-contained `pocketbase serve` clean-room: fresh --dir, a COPY
of pb_migrations as --migrationsDir, and a temp --hooksDir containing only
a copy of oauth.pb.js. `extra_env` is merged onto the subprocess env.

all_hooks=True takes the WHOLE pb_hooks/ instead: the account-linking room needs
auth_identity.pb.js too, since the email_key it links on is that hook's output.*/
class Room {
  port: number;
  extra_env: Record<string, string>;
  base_url: string;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  hooks_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number, extra_env: Record<string, string> | null = null, all_hooks = false) {
    this.port = port;
    this.extra_env = extra_env ?? {};
    this.base_url = `http://127.0.0.1:${port}`;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-oauth-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    for (const name of fs.readdirSync(this.migrations_dir)) {
      if (name.endsWith(MFA_SUFFIX)) {
        fs.rmSync(path.join(this.migrations_dir, name));
      }
    }
    if (all_hooks) {
      this.hooks_dir = roomkit.hooks_dir(this.tmp);
    } else {
      this.hooks_dir = path.join(this.tmp, "pb_hooks");
      fs.mkdirSync(this.hooks_dir, { recursive: true });
      fs.copyFileSync(OAUTH_HOOK_SRC, path.join(this.hooks_dir, "oauth.pb.js"));
    }
    this.proc = null;
  }

  async start(): Promise<void> {
    await roomkit.require_free_port(this.port);
    // upsert BEFORE serve: an empty --dir with no superuser makes serve launch
    // the installer link in the machine's default browser (CLAUDE.md clean-room law).
    run_checked(
      [
        POCKETBASE_BIN,
        "superuser",
        "upsert",
        "probe@example.com",
        "probe123456",
        "--dir",
        this.data_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    // roomkit.serve() has no env= param; the oauth hook reads env vars, so they ride
    // process.env for the spawn it makes (it passes env: process.env) and are restored after.
    const saved = Object.keys(this.extra_env).map((k) => [k, process.env[k]] as const);
    Object.assign(process.env, this.extra_env);
    try {
      this.proc = await roomkit.serve(
        this.port,
        this.data_dir,
        this.migrations_dir,
        this.hooks_dir,
      );
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

function get_auth_methods(base_url: string): Promise<[number, any]> {
  return api(base_url, "GET", "/api/collections/users/auth-methods");
}

function providers_of(methods: any): any[] {
  const providers = py_get(py_get(methods, "oauth2", {}), "providers", []);
  return truthy(providers) ? providers : [];
}

function find_github_provider(auth_methods: any): any {
  for (const p of providers_of(auth_methods)) {
    if (py_get(p, "name") === "github") {
      return p;
    }
  }
  return null;
}

let status: number;
let methods: any;
let su_status: number;
let su_auth: any;
let su_token: string | null;

// COVERS: boot:oauth.pb.js
console.log("\n── UNSET room (no GITHUB_CLIENT_ID/SECRET): oauth2 stays disabled ──");
const unset_room = new Room(8099 + PORT_OFFSET, {});
try {
  await unset_room.start();
  [status, methods] = await get_auth_methods(unset_room.base_url);
  check("auth-methods request succeeds", status, 200);
  check("oauth2.enabled", py_get(py_get(methods, "oauth2", {}), "enabled"), false);
  const provider_names = providers_of(methods).map((p) => py_get(p, "name"));
  check("github NOT in providers", provider_names.includes("github"), false);
} finally {
  await unset_room.stop();
  unset_room.cleanup_tmp();
}

// COVERS: boot:oauth.pb.js
console.log("\n── SET room (dummy GITHUB_CLIENT_ID/SECRET): github provider live ──");
const set_room = new Room(8094 + PORT_OFFSET, {
  GITHUB_CLIENT_ID: DUMMY_CLIENT_ID,
  GITHUB_CLIENT_SECRET: DUMMY_CLIENT_SECRET,
});
const migrations_before = count_migration_files(set_room.migrations_dir);
try {
  await set_room.start();
  [status, methods] = await get_auth_methods(set_room.base_url);
  check("auth-methods request succeeds", status, 200);
  check("oauth2.enabled", py_get(py_get(methods, "oauth2", {}), "enabled"), true);

  const github = find_github_provider(methods);
  check("github provider present", github !== null, true);

  if (github !== null) {
    const auth_url = py_get(github, "authURL", "");
    const parsed = urlparse(auth_url);
    check("authURL host+path", parsed.netloc + parsed.path, "github.com/login/oauth/authorize");

    const qs = parse_qs(parsed.query);
    check("code_challenge_method", py_get(qs, "code_challenge_method", [null])[0], "S256");
    const scope = py_get(qs, "scope", [""])[0];
    check("scope contains user:email", scope.includes("user:email"), true);
    check("state is present", truthy(py_get(qs, "state", [""])[0]), true);
    check(
      "client_id matches injected env clientId",
      py_get(qs, "client_id", [null])[0],
      DUMMY_CLIENT_ID,
    );
    check("client secret never appears in authURL", auth_url.includes(DUMMY_CLIENT_SECRET), false);
  } else {
    // Keep the check count meaningful even if the provider is missing.
    check("authURL host+path", null, "github.com/login/oauth/authorize");
    check("code_challenge_method", null, "S256");
    check("scope contains user:email", false, true);
    check("state is present", false, true);
    check("client_id matches injected env clientId", null, DUMMY_CLIENT_ID);
    check("client secret never appears in authURL", true, false);
  }

  const redirect_status = await get_status_no_redirect(set_room.base_url, "/api/oauth2-redirect");
  check("GET /api/oauth2-redirect", redirect_status, 307);

  const migrations_after = count_migration_files(set_room.migrations_dir);
  check(
    "boot-hook runtime save writes no migration file (copy dir count)",
    migrations_after,
    migrations_before,
  );

  // ── APPROVAL GATE (documented-stub, TASK-017.19 AC#4): a real GitHub round trip
  // isn't scriptable here, but the state a first-time GitHub sign-in lands in IS
  // reproducible without GitHub — oauth.pb.js's onRecordAuthWithOAuth2Request sets
  // verified=true on first sign-in but never touches approved, so a directly-created
  // verified=true/approved=false record hits the exact same authRule rejection a
  // brand-new GitHub user would on their very first auth-with-oauth2 call.
  console.log("\n── APPROVAL GATE (documented-stub): verified-but-unapproved account is 403'd ──");
  [su_status, su_auth] = await api(
    set_room.base_url,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    { identity: "probe@example.com", password: "probe123456" },
  );
  check("superuser auth (for the approval-gate stub)", su_status, 200);
  su_token = su_auth.token ?? null;

  const [create_status, create_body] = await api(
    set_room.base_url,
    "POST",
    "/api/collections/users/records",
    {
      email: "pending-oauth@example.com",
      password: "pending123456",
      passwordConfirm: "pending123456",
      verified: true,
    },
    su_token,
  );
  check("superuser creates a verified=true, approved=false record", create_status, 200);
  check(
    "record starts approved=false (createRule blocks the client, superuser default)",
    create_body.approved ?? null,
    false,
  );

  const [reject_status, reject_body] = await api(
    set_room.base_url,
    "POST",
    "/api/collections/users/auth-with-password",
    { identity: "pending-oauth@example.com", password: "pending123456" },
  );
  check("authRule 403s the same way a first-time GitHub sign-in would", reject_status, 403);
  check(
    "403 body matches the documented authRule-rejection message",
    reject_body.message ?? null,
    "The request doesn't satisfy the collection requirements to authenticate.",
  );
} finally {
  await set_room.stop();
  set_room.cleanup_tmp();
}

// COVERS: hook:oauth.pb.js#onRecordAuthWithOAuth2Request:users
console.log(
  "\n── LINKING room (fake OpenID provider): a folded provider address links, never duplicates ──",
);

// The smallest provider PocketBase's oauth2 client will talk to: any POST is the token
// exchange, any GET is userinfo. `PROVIDER_USER` is what the next login presents.
let PROVIDER_USER: Record<string, any> = {};
// port 0 = OS-assigned: the fake provider is not a PocketBase room, so it takes no band
// and cannot collide with a concurrently running suite.
const idp = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method === "POST") {
      await req.arrayBuffer();
      return Response.json({ access_token: "fake-token", token_type: "Bearer", expires_in: 3600 });
    }
    return Response.json({ ...PROVIDER_USER });
  },
});
const idp_url = `http://127.0.0.1:${idp.port}`;

const link_room = new Room(8099 + PORT_OFFSET, null, true);
try {
  await link_room.start();
  let s: number;
  [s, su_auth] = await api(
    link_room.base_url,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    { identity: "probe@example.com", password: "probe123456" },
  );
  check("superuser auth (linking room)", s, 200);
  su_token = su_auth.token ?? null;

  // The provider entry is written over the API rather than by the boot hook: only the
  // endpoint overrides make a local, scriptable provider possible. PocketBase persists
  // clientId/clientSecret on this path (it is a collection save, so it also auto-writes a
  // *_updated_users.js into THIS ROOM'S scratch migrations copy — never the repo's).
  [s] = await api(
    link_room.base_url,
    "PATCH",
    "/api/collections/users",
    {
      oauth2: {
        enabled: true,
        providers: [
          {
            name: "oidc",
            clientId: "fake-client",
            clientSecret: "fake-secret",
            authURL: idp_url + "/authorize",
            tokenURL: idp_url + "/token",
            userInfoURL: idp_url + "/userinfo",
            displayName: "Fake",
            pkce: false,
          },
        ],
      },
    },
    su_token,
  );
  check("fake OpenID provider configured", s, 200);

  const oauth_login = (
    email: string,
    subject: string,
    name = "OAuth Person",
  ): Promise<[number, any]> => {
    PROVIDER_USER = { sub: subject, email: email, email_verified: true, name };
    return api(link_room.base_url, "POST", "/api/collections/users/auth-with-oauth2", {
      provider: "oidc",
      code: "fake-code",
      codeVerifier: "",
      redirectURL: link_room.base_url + "/api/oauth2-redirect",
    });
  };

  const users_on_key = (key: string): any[] => {
    const con = sqlite_connect(path.join(link_room.data_dir, "data.db"), { timeout: 15 });
    try {
      return con
        .query("SELECT id FROM users WHERE email_key = ?")
        .values(key)
        .map((r) => r[0]);
    } finally {
      con.close();
    }
  };

  const external_auths = (): any[] => {
    const con = sqlite_connect(path.join(link_room.data_dir, "data.db"), { timeout: 15 });
    try {
      return con
        .query("SELECT recordRef, provider, providerId FROM _externalAuths")
        .values()
        .map((r) => tup(...r));
    } finally {
      con.close();
    }
  };

  let existing: any;
  [s, existing] = await api(
    link_room.base_url,
    "POST",
    "/api/collections/users/records",
    {
      email: "Link.Target+signup@Gmail.com",
      password: "linking123456",
      passwordConfirm: "linking123456",
      name: "Link Target",
      verified: true,
      approved: true,
    },
    su_token,
  );
  check("(fixture) password account at a dotted+tagged gmail address", s, 200);
  const existing_id = existing.id ?? null;
  check("(fixture) it stored the folded key", users_on_key("linktarget@gmail.com"), [existing_id]);

  // The provider hands back a DIFFERENT fold of the same mailbox — the exact case the old
  // LOWER(email) lookup missed, minting a second account for one person.
  let linked: any;
  [s, linked] = await oauth_login("LinkTarget+github@GMAIL.com", "fake-subject-link");
  check("OAuth login with a differently-folded address → 200", s, 200);
  check(
    "…authenticates the EXISTING account, not a new one",
    py_get(py_get(linked, "record", {}), "id"),
    existing_id,
  );
  check("…still exactly one account on that key", users_on_key("linktarget@gmail.com"), [
    existing_id,
  ]);
  check("…and the external identity is attached to it", external_auths(), [
    tup(existing_id, "oidc", "fake-subject-link"),
  ]);

  // Control 1: an address that folds onto nothing must still mint a fresh account —
  // linking must not be a catch-all. The new account is unapproved, so the token is 403'd
  // by the same approval gate stubbed above; the ROW is what this control is about.
  [s] = await oauth_login("Brand.New+tag@gmail.com", "fake-subject-fresh");
  check("OAuth login for an unknown address → 403 (approval gate, not a link)", s, 403);
  const fresh_ids = users_on_key("brandnew@gmail.com");
  check("…minted exactly one NEW account", fresh_ids.length, 1);
  check("…which is not the linked one", !Bun.deepEquals(fresh_ids, [existing_id], true), true);
  check("…and the linked account is untouched", users_on_key("linktarget@gmail.com"), [
    existing_id,
  ]);

  // Control 2: the domain boundary — off gmail, dots stay significant, so this is a
  // different mailbox and must NOT link.
  let other: any;
  [s, other] = await api(
    link_room.base_url,
    "POST",
    "/api/collections/users/records",
    {
      email: "no.fold@example.com",
      password: "linking123456",
      passwordConfirm: "linking123456",
      name: "No Fold",
      verified: true,
      approved: true,
    },
    su_token,
  );
  check("(fixture) a dotted NON-gmail account", s, 200);
  [s] = await oauth_login("nofold@example.com", "fake-subject-nonlink");
  check("OAuth login with the undotted variant → 403 (a new, unapproved account)", s, 403);
  check(
    "…did NOT link: the dotted account still stands alone",
    users_on_key("no.fold@example.com"),
    [other.id ?? null],
  );
  const undotted = users_on_key("nofold@example.com");
  check("…and the undotted address became its own account", undotted.length, 1);
  check(
    "…a different one (off gmail, dots are significant)",
    !Bun.deepEquals(undotted, [other.id ?? null], true),
    true,
  );

  // decision:user-settings-write-checks: a blank profile name from the provider is stored empty, never refused.
  for (const [blank, mail] of [
    ["", "blank.empty@example.com"],
    ["   ", "blank.spaces@example.com"],
  ]) {
    [s] = await oauth_login(mail, `fake-subject-${mail}`, blank);
    check(
      `OAuth signup whose provider name is ${py_str(JSON.stringify(blank))} → 403 (approval gate, not a 400)`,
      s,
      403,
    );
    const con = sqlite_connect(path.join(link_room.data_dir, "data.db"), { timeout: 15 });
    try {
      check(
        "…minted one account with an empty name",
        con
          .query("SELECT name FROM users WHERE email = ?")
          .values(mail)
          .map((r) => r[0]),
        [""],
      );
    } finally {
      con.close();
    }
  }
} finally {
  await link_room.stop();
  link_room.cleanup_tmp();
  await idp.stop(true);
}

console.log("\n── real pb_migrations/ untouched by either clean-room ──");
const git_status = run_checked(["git", "status", "--porcelain", "pb_migrations/"], {
  cwd: REPO_ROOT,
  capture_output: true,
  text: true,
}).stdout!;
// only NEWLY WRITTEN *_updated_*.js files count as a boot-hook leak — a
// deletion line (porcelain leading "D") is an intentional removal, not a
// stray write.
const bad_lines = splitlines(git_status).filter(
  (line) => line.includes("_updated_") && !line.slice(0, 2).includes("D"),
);
check("no auto-written *_updated_*.js migration in real pb_migrations/", bad_lines, []);
console.log(
  `      git status --porcelain pb_migrations/ :\n${truthy(git_status) ? git_status : "      (clean)"}`,
);

console.log(`\n${"=".repeat(70)}`);
if (failures) {
  console.log(`❌ ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("✅ all checks passed");
  process.exit(0);
}

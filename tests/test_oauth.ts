#!/usr/bin/env bun
/**E2E test of the OAuth2 boot hook (`pb_hooks/oauth.pb.js`); spawns its own
clean-room `pocketbase serve` processes (temp --dir / --migrationsDir copy /
--hooksDir with only oauth.pb.js) — never touches the repo's real
pb_migrations, pb_hooks, or pb_data.

Headless-provable: with no GITHUB_ or GOOGLE_CLIENT_ID/SECRET, auth-methods shows oauth2
disabled (boot hook no-ops, one boot log line per missing pair); with dummy creds injected into
the subprocess env, it advertises a github provider (a GOOGLE room does the same for google) with a PKCE authURL (S256, correct
scope/state/client_id, secret never appears), the SDK's oauth2-redirect
endpoint exists (307), and the boot hook's runtime save writes no migration
file. A third room stands up a FAKE OpenID provider in-process (a provider entry
whose authURL/tokenURL/userInfoURL point at a local http server) and drives a real
POST /api/collections/users/auth-with-oauth2 through it, which is what proves the
request hook's verified=true and its PBTT-529 account-linking on email_key.
NOT provable here (needs a real GitHub login in a browser): GitHub's own consent
round-trip and its profile-populated name/avatar.

Ports 8099 (env UNSET room), 8094 (env SET room, then the GOOGLE room), 8099 again (the LINKING room),
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
const DUMMY_GOOGLE_ID = "test_google_id_6n7n.apps.googleusercontent.com";
const DUMMY_GOOGLE_SECRET = "test_google_secret_6n7n_do_not_use";

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
    // the installer link in the machine's default browser (AGENTS.md clean-room law).
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
      // --dev echoes the boot hook's logger lines into the log file; outside dev mode they reach
      // only the logs DB, a few seconds after boot.
      this.proc = await roomkit.serve(
        this.port,
        this.data_dir,
        this.migrations_dir,
        this.hooks_dir,
        null,
        ["--dev"],
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

  // Boot-log lines carrying the hook's exact "pair missing" message for `prefix`.
  boot_log_lines(prefix: string): number {
    const text = fs.readFileSync(this.proc!.roomkit_log, "utf8");
    return splitlines(text).filter((l) => l.includes(`no ${prefix}_CLIENT_ID/SECRET`)).length;
  }

  // Same pb_data, new env: what a redeploy with changed variables does to stored providers.
  async restart(extra_env: Record<string, string>): Promise<void> {
    await this.stop();
    this.extra_env = extra_env;
    await this.start();
  }
}

function get_auth_methods(base_url: string): Promise<[number, any]> {
  return api(base_url, "GET", "/api/collections/users/auth-methods");
}

function providers_of(methods: any): any[] {
  const providers = py_get(py_get(methods, "oauth2", {}), "providers", []);
  return truthy(providers) ? providers : [];
}

function find_provider(auth_methods: any, name: string): any {
  for (const p of providers_of(auth_methods)) {
    if (py_get(p, "name") === name) {
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
  check("google NOT in providers", provider_names.includes("google"), false);
  check("one boot log line names the missing GITHUB pair", unset_room.boot_log_lines("GITHUB"), 1);
  check("one boot log line names the missing GOOGLE pair", unset_room.boot_log_lines("GOOGLE"), 1);
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

  const github = find_provider(methods, "github");
  check("github provider present", github !== null, true);
  check("google NOT in providers (its pair is unset)", find_provider(methods, "google"), null);
  check("one boot log line names the missing GOOGLE pair", set_room.boot_log_lines("GOOGLE"), 1);
  check("no boot log line calls the GITHUB pair missing", set_room.boot_log_lines("GITHUB"), 0);

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

// COVERS: boot:oauth.pb.js
console.log(
  "\n── GOOGLE room (dummy GOOGLE_CLIENT_ID/SECRET only): google provider live, github off ──",
);
const google_room = new Room(8094 + PORT_OFFSET, {
  GOOGLE_CLIENT_ID: DUMMY_GOOGLE_ID,
  GOOGLE_CLIENT_SECRET: DUMMY_GOOGLE_SECRET,
});
try {
  await google_room.start();
  [status, methods] = await get_auth_methods(google_room.base_url);
  check("auth-methods request succeeds", status, 200);
  check("oauth2.enabled", py_get(py_get(methods, "oauth2", {}), "enabled"), true);
  const google = find_provider(methods, "google");
  check("google provider present", google !== null, true);
  const auth_url = google === null ? "" : py_get(google, "authURL", "");
  const parsed = urlparse(auth_url);
  check("authURL host+path", parsed.netloc + parsed.path, "accounts.google.com/o/oauth2/v2/auth");
  const qs = parse_qs(parsed.query);
  check("code_challenge_method", py_get(qs, "code_challenge_method", [null])[0], "S256");
  check(
    "client_id matches injected env clientId",
    py_get(qs, "client_id", [null])[0],
    DUMMY_GOOGLE_ID,
  );
  check("client secret never appears in authURL", auth_url.includes(DUMMY_GOOGLE_SECRET), false);
  check("github NOT in providers (its pair is unset)", find_provider(methods, "github"), null);
  check("one boot log line names the missing GITHUB pair", google_room.boot_log_lines("GITHUB"), 1);
  check("no boot log line calls the GOOGLE pair missing", google_room.boot_log_lines("GOOGLE"), 0);

  console.log(
    "\n── same pb_data rebooted with NO pairs: stored providers go off, not just unlogged ──",
  );
  await google_room.restart({});
  [status, methods] = await get_auth_methods(google_room.base_url);
  check("auth-methods request succeeds", status, 200);
  check(
    "oauth2.enabled after reboot without env",
    py_get(py_get(methods, "oauth2", {}), "enabled"),
    false,
  );
  check("google gone after reboot without env", find_provider(methods, "google"), null);
} finally {
  await google_room.stop();
  google_room.cleanup_tmp();
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
// The battery points every suite at one shared hooks dir; the scratch hook below needs a private copy.
link_room.hooks_dir = path.join(link_room.tmp, "pb_hooks_private");
fs.cpSync(path.join(REPO_ROOT, "pb_hooks"), link_room.hooks_dir, { recursive: true });
// Scratch hook: the verified save of a "refuse." account is refused with a status, as a rule hook of the app could.
fs.writeFileSync(
  path.join(link_room.hooks_dir, "zz_probe_refuse.pb.js"),
  `onRecordUpdate((e) => {
  if (e.record.email().startsWith("refuse.") && e.record.getBool("verified")) throw new BadRequestError("Probe refusal.");
  e.next();
}, "users");
`,
);
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

  // The sign-ins here outrun the auth rate limit; this room's limiter is not under test.
  [s] = await api(
    link_room.base_url,
    "PATCH",
    "/api/settings",
    { rateLimits: { enabled: false } },
    su_token,
  );
  check("rate limits off (linking room)", s, 200);

  const oauth_login = (
    email: string,
    subject: string,
    name = "OAuth Person",
    createData: Record<string, any> | undefined = undefined,
  ): Promise<[number, any]> => {
    PROVIDER_USER = { sub: subject, email: email, email_verified: true, name };
    return api(link_room.base_url, "POST", "/api/collections/users/auth-with-oauth2", {
      provider: "oidc",
      code: "fake-code",
      codeVerifier: "",
      redirectURL: link_room.base_url + "/api/oauth2-redirect",
      createData,
    });
  };

  const password_login = async (email: string, password: string): Promise<number> =>
    (
      await api(link_room.base_url, "POST", "/api/collections/users/auth-with-password", {
        identity: email,
        password,
      })
    )[0];

  const db_run = (sql: string): void => {
    const c = sqlite_connect(path.join(link_room.data_dir, "data.db"), { timeout: 15 });
    try {
      c.run(sql);
    } finally {
      c.close();
    }
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

  const verified_on_key = (key: string): any[] => {
    const con = sqlite_connect(path.join(link_room.data_dir, "data.db"), { timeout: 15 });
    try {
      return con
        .query("SELECT verified FROM users WHERE email_key = ?")
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
  check(
    "…saved verified (the provider proved the address)",
    verified_on_key("brandnew@gmail.com"),
    [1],
  );
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

  // A database failure saving the verified flag answers 500 with the shared body, never PB's generic 400.
  // Mixed case: the stored email is folded, so core's own verified save is skipped and the hook's is the one that runs.
  const dbfail_mail = "DbFail.Signup@Example.com";
  const con = sqlite_connect(path.join(link_room.data_dir, "data.db"), { timeout: 15 });
  let body: any;
  try {
    con.run(
      "CREATE TRIGGER zz_probe_update BEFORE UPDATE OF verified ON users WHEN NEW.verified = 1 BEGIN SELECT RAISE(ABORT, 'probe db failure'); END",
    );
    [s, body] = await oauth_login(dbfail_mail, "fake-subject-dbfail");
  } finally {
    con.run("DROP TRIGGER IF EXISTS zz_probe_update");
    con.close();
  }
  check("first OAuth sign-in, verified-flag save fails at the database → 500", s, 500);
  check(
    "…the shared error body with a behaviour message",
    [body.status, body.message, typeof body.data],
    [500, "The sign-in could not be completed.", "object"],
  );
  let logged: any = null;
  for (let i = 0; i < 20 && !logged; i++) {
    const [, l] = await api(
      link_room.base_url,
      "GET",
      "/api/logs?perPage=200&filter=level%20%3E%3D%208",
      null,
      su_token,
    );
    logged = (l.items ?? []).find((x: any) => String(x.message).includes("oauth sign-in failed"));
    if (!logged) await new Promise((r) => setTimeout(r, 500));
  }
  check("…and the failure is logged", Boolean(logged), true);
  check(
    "…naming the database's own cause",
    String(logged?.data?.cause ?? "").includes("probe db failure"),
    true,
  );
  [s] = await oauth_login(dbfail_mail, "fake-subject-dbfail");
  check("…a retry once the database recovers → 403 (approval gate)", s, 403);
  check("…and the account is saved verified", verified_on_key("dbfail.signup@example.com"), [1]);

  // A refusal from the verified save keeps its own status and message, even though e.next() also refused.
  [s, body] = await oauth_login("Refuse.Signup@Example.com", "fake-subject-refuse");
  check(
    "first OAuth sign-in, verified save refused with a status → its own 400",
    [s, body.message],
    [400, "Probe refusal."],
  );

  // Pre-registration takeover: an unverified account at someone's address holds a password a stranger
  // knows (a signup can no longer set one, decision:password-signup-verify-first, so a superuser builds it),
  // then the owner signs in through the provider.
  for (const [planted, presented, key, label] of [
    [
      "victim.exact@example.com",
      "victim.exact@example.com",
      "victim.exact@example.com",
      "the exact",
    ],
    ["Vic.Tim+pre@gmail.com", "victim@gmail.com", "victim@gmail.com", "a folded gmail"],
    [
      "Mixed.Case+Plant@GoogleMail.com",
      "MixedCase@GOOGLEMAIL.com",
      "mixedcase@googlemail.com",
      "a mixed-case googlemail",
    ],
  ]) {
    [s] = await api(
      link_room.base_url,
      "POST",
      "/api/collections/users/records",
      {
        email: planted,
        password: "attacker123456",
        passwordConfirm: "attacker123456",
        verified: false,
      },
      su_token,
    );
    check(`(fixture) unverified account at ${planted} with a known password`, s, 200);
    const [pre_id] = users_on_key(key);
    db_run(
      `INSERT INTO _externalAuths (collectionRef, recordRef, provider, providerId) VALUES ('_pb_users_auth_', '${pre_id}', 'github', 'attacker-${pre_id}')`,
    );
    const subject = `fake-subject-victim-${pre_id}`;
    [s] = await oauth_login(presented, subject);
    check(`OAuth sign-in at ${label} address of that account → 403 (approval gate)`, s, 403);
    check("…the account is saved verified", verified_on_key(key), [1]);
    check(
      "…and the provider just used is its only link",
      external_auths().filter((r: any) => r[0] === pre_id),
      [tup(pre_id, "oidc", subject)],
    );
    [s] = await api(
      link_room.base_url,
      "PATCH",
      `/api/collections/users/records/${pre_id}`,
      { approved: true, verified: true },
      su_token,
    );
    check("(fixture) a superuser approves it", s, 200);
    check(
      "…the signup's password no longer signs in",
      await password_login(planted, "attacker123456"),
      400,
    );
    [s, body] = await oauth_login(presented, subject);
    check("…while the provider sign-in reaches that account", [s, body.record?.id], [200, pre_id]);
  }

  // A provider link that fails at the database during a first sign-in leaves no account behind.
  db_run(
    "CREATE TRIGGER zz_probe_link BEFORE INSERT ON _externalAuths WHEN NEW.providerId = 'fake-subject-orphan' BEGIN SELECT RAISE(ABORT, 'probe link failure'); END",
  );
  try {
    [s, body] = await oauth_login("Orphan.Signup@Example.com", "fake-subject-orphan");
  } finally {
    db_run("DROP TRIGGER IF EXISTS zz_probe_link");
  }
  check(
    "first OAuth sign-in whose provider link fails at the database → 500",
    [s, body.message],
    [500, "The sign-in could not be completed."],
  );
  check("…and leaves no account behind", users_on_key("orphan.signup@example.com"), []);

  const user_row = (id: string): any[] => {
    const c = sqlite_connect(path.join(link_room.data_dir, "data.db"), { timeout: 15 });
    try {
      return c.query("SELECT verified, password FROM users WHERE id = ?").values(id)[0] as any[];
    } finally {
      c.close();
    }
  };
  const links_of = (id: string): any[] => external_auths().filter((r: any) => r[0] === id);
  const su_user = async (email: string, verified: boolean): Promise<string> => {
    const [st, rec] = await api(
      link_room.base_url,
      "POST",
      "/api/collections/users/records",
      {
        email,
        password: "precede123456",
        passwordConfirm: "precede123456",
        verified,
        approved: true,
      },
      su_token,
    );
    check(`(fixture) account at ${email}`, st, 200);
    return rec.id;
  };

  // D1: an existing provider link outranks the fold — a linked subject whose address now folds onto another account stays on its own.
  const d1_a = await su_user("d1.alpha@example.com", true);
  const d1_b = await su_user("D1.Beta@gmail.com", true);
  [s, body] = await oauth_login("d1.alpha@example.com", "fake-subject-d1");
  check("(fixture) the provider account links to A", [s, body.record?.id], [200, d1_a]);
  [s, body] = await oauth_login("d1beta+moved@gmail.com", "fake-subject-d1");
  check(
    "a linked provider account whose address folds onto B signs into A",
    [s, body.record?.id],
    [200, d1_a],
  );
  check("…B gains no link", links_of(d1_b), []);

  // D2: the signed-in account outranks the fold — adding a provider whose address folds onto another account links to the caller.
  const d2_l = await su_user("d2.signed@example.com", true);
  const d2_m = await su_user("D2.Target@gmail.com", false);
  const d2_m_before = user_row(d2_m);
  const [, l_auth] = await api(
    link_room.base_url,
    "POST",
    "/api/collections/users/auth-with-password",
    {
      identity: "d2.signed@example.com",
      password: "precede123456",
    },
  );
  PROVIDER_USER = {
    sub: "fake-subject-d2",
    email: "d2target@gmail.com",
    email_verified: true,
    name: "D2",
  };
  [s, body] = await api(
    link_room.base_url,
    "POST",
    "/api/collections/users/auth-with-oauth2",
    {
      provider: "oidc",
      code: "fake-code",
      codeVerifier: "",
      redirectURL: link_room.base_url + "/api/oauth2-redirect",
    },
    l_auth.token,
  );
  check(
    "signed-in L adds a provider whose address folds onto unverified M → L",
    [s, body.record?.id],
    [200, d2_l],
  );
  check("…the link is L's", links_of(d2_l), [tup(d2_l, "oidc", "fake-subject-d2")]);
  check(
    "…M is untouched (still unverified, same password, no link)",
    [user_row(d2_m), links_of(d2_m)],
    [d2_m_before, []],
  );

  // The provider proved only its own address, so an account createData points elsewhere stays unverified.
  [s] = await oauth_login("prover@example.com", "fake-subject-createdata", "OAuth Person", {
    email: "unproven.createdata@example.com",
  });
  check("OAuth signup whose createData names another address → 403", s, 403);
  check(
    "…that account is not saved verified",
    verified_on_key("unproven.createdata@example.com"),
    [0],
  );

  // COVERS: hook:auth_identity.pb.js#onRecordCreateRequest:users
  // createData may carry a password and an email the provider never proved (decision:password-signup-verify-first).
  [s] = await oauth_login("prover2@example.com", "fake-subject-createdata-pw", "OAuth Person", {
    email: "planted.createdata@example.com",
    password: "attacker123456",
    passwordConfirm: "attacker123456",
  });
  check("OAuth signup whose createData carries a password → 403", s, 403);
  // Flipped in the database, past every hook, so only the signup decides which password the account holds.
  db_run(
    "UPDATE users SET verified = 1, approved = 1 WHERE email = 'planted.createdata@example.com'",
  );
  check(
    "…once verified and approved, that password does not sign in",
    await password_login("planted.createdata@example.com", "attacker123456"),
    400,
  );
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

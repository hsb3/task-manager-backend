#!/usr/bin/env bun
/**
 * E2E proof of the settings collections: a global `app_settings` key/value
 * store (superuser-write / any-authed-read, null-rule idiom), a per-user
 * `user_settings` strict self-only 1:1 companion row (auto-provisioned +
 * backfilled for every user), and the `workspaces.default_project`
 * same-workspace guard (WHO stays the owner/admin updateRule; VALUE is
 * enforced by a hook, not a rule).
 *
 * Needs superuser creds from env (PB_SUPERUSER_EMAIL/PASSWORD) to mint
 * throwaway users and read back rows across accounts. Self-contained &
 * rerunnable: every throwaway user is su-deleted at the end (cascadeDelete
 * removes their workspaces/projects/workspace_members/user_settings rows).
 */

import { randomBytes } from "node:crypto";
import { py_str, tup, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;
let failures = 0;

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  let raw: string;
  try {
    r = await fetch(PB + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(PB, e);
  }
  return [r.status, raw ? JSON.parse(raw) : {}];
}

tierkit.use(api);

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (want ${py_str(expected)})`,
  );
}

function check_in(label: string, got: any, allowed: any[]): void {
  const ok = allowed.some((a) => Bun.deepEquals(got, a, true));
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (want one of ${py_str(tup(...allowed))})`,
  );
}

function esc(value: string): string {
  return value.replaceAll("'", "\\'");
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<any> {
  const filt = `${field}='${esc(value)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

async function superuser_token(): Promise<string> {
  const [su_email, su_password] = roomkit.superuser_creds();
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: su_email,
    password: su_password,
  });
  return roomkit.token_of(PB, su_email, r);
}

/** Create a throwaway user (also fires the auto-provision hook). */
async function make_user(
  su: string,
  name: string,
  approved: boolean = true,
): Promise<[string, string]> {
  const email = `settings-${randomBytes(4).toString("hex")}@example.com`;
  const [, r] = await api("POST", "/api/collections/users/records", su, {
    email,
    password: "test123456",
    passwordConfirm: "test123456",
    name,
    verified: true,
    approved,
  });
  return [email, r.id];
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(PB, email, r), r.record.id];
}

const su = await superuser_token();
const created_user_ids: string[] = [];
let s: number;
let r: any;

// ── shared fixture: Alice (seeded, non-superuser) for app_settings checks ──
const [alice] = await login("alice@example.com");

console.log("\n── APP_SETTINGS: authed read / anon list-empty / non-superuser write denied ──");

const APP_SETTINGS_ID = await find_id("app_settings", "key", "trash_retention_days", su);
check("setup: app_settings trash_retention_days row exists", APP_SETTINGS_ID !== null, true);

// COVERS: rule:app_settings.view
let row: any;
[s, row] = await api("GET", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, alice);
check("app_settings authed read trash_retention_days", tup(s, row.value ?? null), tup(200, 30));

// COVERS: rule:app_settings.list
[s, r] = await api("GET", "/api/collections/app_settings/records"); // anonymous, no token
check("app_settings anon list empty", tup(s, r.items ?? null), tup(200, []));

// COVERS: rule:app_settings.create
[s] = await api("POST", "/api/collections/app_settings/records", alice, {
  key: `settings-test-probe-${randomBytes(4).toString("hex")}`,
  value: 1,
});
check("app_settings non-superuser create denied 403", s, 403);

// COVERS: rule:app_settings.update
[s] = await api("PATCH", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, alice, {
  value: 999,
});
check("app_settings non-superuser update denied 403", s, 403);

// COVERS: rule:app_settings.delete
[s] = await api("DELETE", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, alice);
check("app_settings non-superuser delete denied 403", s, 403);

[s, r] = await api("PATCH", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, su, {
  value: 45,
});
check("app_settings superuser PATCH value", tup(s, r.value ?? null), tup(200, 45));
// restore seeded value so the suite is rerunnable and other suites see 30.
[s] = await api("PATCH", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, su, {
  value: 30,
});
check("cleanup: app_settings value restored to 30", s, 200);

console.log(
  "\n── USER_SETTINGS: self read/update; other row filtered/404; create-for-other/dup denied ──",
);

const [uma_email, uma_id] = await make_user(su, "Uma Settings");
created_user_ids.push(uma_id);
const [uma] = await login(uma_email);
// COVERS: hook:main.pb.js#onRecordAfterCreateSuccess:users
const UMA_SETTINGS = await find_id("user_settings", "user", uma_id, su);
check("setup: Uma's auto-provisioned user_settings row exists", UMA_SETTINGS !== null, true);

const bob_id = await find_id("users", "email", "bob@example.com", su);
const BOB_SETTINGS = await find_id("user_settings", "user", bob_id, su);
check("setup: Bob's (seeded/backfilled) user_settings row exists", BOB_SETTINGS !== null, true);

// COVERS: rule:user_settings.view
[s, r] = await api("GET", `/api/collections/user_settings/records/${UMA_SETTINGS}`, uma);
check("user_settings self read", s, 200);

// COVERS: rule:user_settings.update
[s, r] = await api("PATCH", `/api/collections/user_settings/records/${UMA_SETTINGS}`, uma, {
  theme: "dark",
});
check("user_settings self update", tup(s, r.theme ?? null), tup(200, "dark"));

// COVERS: rule:user_settings.list
let qs = urlencode({ filter: `user='${esc(bob_id)}'` });
[s, r] = await api("GET", `/api/collections/user_settings/records?${qs}`, uma);
check("user_settings other row list-empty", tup(s, r.items ?? null), tup(200, []));

// COVERS: rule:user_settings.view
[s] = await api("GET", `/api/collections/user_settings/records/${BOB_SETTINGS}`, uma);
check("user_settings other row view 404", s, 404);

// COVERS: rule:user_settings.create
[s] = await api("POST", "/api/collections/user_settings/records", uma, {
  user: bob_id,
  theme: "light",
});
check("user_settings create-for-other 400", s, 400);

// Uma already owns a row; a second one for herself passes the rule but fails
// the UNIQUE index.
[s] = await api("POST", "/api/collections/user_settings/records", uma, {
  user: uma_id,
  theme: "light",
});
check("user_settings second row same user rejected 400", s, 400);

console.log("\n── USER_SETTINGS.time_zone: starts empty; self write/read-back ──");

// COVERS: rule:user_settings.view
[s, r] = await api("GET", `/api/collections/user_settings/records/${UMA_SETTINGS}`, uma);
check("time_zone starts empty on auto-provisioned row", tup(s, r.time_zone ?? null), tup(200, ""));

// COVERS: rule:user_settings.update
[s, r] = await api("PATCH", `/api/collections/user_settings/records/${UMA_SETTINGS}`, uma, {
  time_zone: "Pacific/Kiritimati",
});
check("time_zone self write", tup(s, r.time_zone ?? null), tup(200, "Pacific/Kiritimati"));

[s, r] = await api("GET", `/api/collections/user_settings/records/${UMA_SETTINGS}`, uma);
check("time_zone self read-back", tup(s, r.time_zone ?? null), tup(200, "Pacific/Kiritimati"));

console.log(
  "\n── DEFAULT_PROJECT: cross-workspace guard; owner/admin write; plain member denied ──",
);

const [wendy_email, wendy_id] = await make_user(su, "Wendy Settings");
created_user_ids.push(wendy_id);
const [wendy] = await login(wendy_email);
const WENDY_WORKSPACE = await find_id("workspaces", "owner", wendy_id, su);
// shadow=false: decision:shadow-project provisions an invisible container project FIRST, so an
// unfiltered find-first here resolves it instead of the visible default project — and the
// container is deliberately not choosable as a default_project.
const _wendy_projects =
  (
    await api(
      "GET",
      "/api/collections/projects/records?" +
        urlencode({ filter: `workspace='${esc(WENDY_WORKSPACE)}' && shadow=false` }),
      su,
    )
  )[1].items || [];
const WENDY_MY_PROJECT = _wendy_projects.length ? _wendy_projects[0].id : null;
check(
  "setup: Wendy auto-provisioned a workspace + default project",
  tup(WENDY_WORKSPACE !== null, WENDY_MY_PROJECT !== null),
  tup(true, true),
);

let second_proj: any;
[s, second_proj] = await api("POST", "/api/collections/projects/records", wendy, {
  name: "Second Project",
  owner: wendy_id,
  workspace: WENDY_WORKSPACE,
});
check_in("setup: Wendy creates a second project in her own workspace", s, [200, 201]);
const SECOND_PROJECT = second_proj.id ?? null;

const ALICE_WEBSITE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);

// COVERS: hook:main.pb.js#onRecordUpdateRequest:workspaces
[s] = await api("PATCH", `/api/collections/workspaces/records/${WENDY_WORKSPACE}`, wendy, {
  default_project: ALICE_WEBSITE_PROJECT,
});
check("default_project cross-workspace rejected 400", s, 400);

// COVERS: rule:workspaces.update
[s, r] = await api("PATCH", `/api/collections/workspaces/records/${WENDY_WORKSPACE}`, wendy, {
  default_project: SECOND_PROJECT,
});
check(
  "default_project own-workspace owner 200",
  tup(s, r.default_project ?? null),
  tup(200, SECOND_PROJECT),
);

// Xavier: promoted to admin out-of-band (workspace_members.updateRule is owner-only).
const [xavier_email, xavier_id] = await make_user(su, "Xavier Settings");
created_user_ids.push(xavier_id);
const [xavier] = await login(xavier_email);
[s] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: WENDY_WORKSPACE,
  user: xavier_id,
  role: "member",
  status: "active",
});
check_in("setup: Xavier added to Wendy's workspace", s, [200, 201]);
// A PATCH's 200 says the request was accepted, not that the tier changed — the admin proof
// below is only about the admin tier if the stored role reads back as admin.
const xavier_tier = await tierkit.actor_at_tier(WENDY_WORKSPACE, xavier_id, "admin", su, "Xavier");

// COVERS: rule:workspaces.update
[s, r] = await api("PATCH", `/api/collections/workspaces/records/${WENDY_WORKSPACE}`, xavier, {
  default_project: WENDY_MY_PROJECT,
});
check(
  "default_project own-workspace admin 200",
  tup(await xavier_tier.now(), s, r.default_project ?? null),
  tup("admin", 200, WENDY_MY_PROJECT),
);

// Yara: a plain member of Wendy's workspace.
const [yara_email, yara_id] = await make_user(su, "Yara Settings");
created_user_ids.push(yara_id);
const [yara] = await login(yara_email);
[s] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: WENDY_WORKSPACE,
  user: yara_id,
  role: "member",
  status: "active",
});
check_in("setup: Yara added to Wendy's workspace as a plain member", s, [200, 201]);
// A non-member gets the same 404, so Yara's tier rides in the assertion — resolved by
// (workspace,user), because a membership row pointing at ANY OTHER workspace also reads 'member'.
const yara_tier = await tierkit.actor_at_tier(WENDY_WORKSPACE, yara_id, "member", su, "Yara");

// COVERS: rule:workspaces.update
[s] = await api("PATCH", `/api/collections/workspaces/records/${WENDY_WORKSPACE}`, yara, {
  default_project: SECOND_PROJECT,
});
check("default_project plain member 404", tup(await yara_tier.now(), s), tup("member", 404));

await tierkit.verify_tiers();

console.log("\n── cleanup: delete throwaway users (cascade removes their fixtures) ──");
for (const uid of created_user_ids) {
  if (truthy(uid)) {
    [s] = await api("DELETE", `/api/collections/users/records/${uid}`, su);
    check(`cleanup user ${uid.slice(0, 8)}`, s, 204);
  }
}

console.log(
  `\n${failures === 0 ? "✅ all settings-suite proofs passed" : `❌ ${failures} FAILED`}`,
);
process.exit(failures ? 1 : 0);

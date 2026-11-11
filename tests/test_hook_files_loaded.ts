#!/usr/bin/env bun
/**
 * Every pb_hooks file is actually LOADED in a booted room, proven by tripping it.
 *
 * PocketBase prints `failed to execute <file>.pb.js` to stderr and SERVES ANYWAY with that
 * file's hooks absent, so a hook file that throws at load (or is simply missing) leaves every
 * rule it enforces silently unenforced and every suite that never trips it passing green.
 * Two tiers cover the whole directory:
 *
 *   §1 boot scan — roomkit.serve() refuses any room whose output carries that line. This is
 *      the ONLY cover for the onBootstrap-only files (settings wiring, cron registration):
 *      they have no request-tier observable to trip, so nothing here fakes one.
 *   §2 one probe per hook file that registers a request/route/realtime handler: the cheapest
 *      assertion whose result differs when that file is absent.
 *
 * Absence, not correctness: each probe is the minimum that flips when the file is gone; the
 * behaviour itself is proven by that file's own suite.
 *
 * Port 8124 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_get,
  py_repr,
  py_str,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const REAL_HOOKS_DIR = path.join(REPO_ROOT, "pb_hooks");

const PORT = 8124 + roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

// Hook files with nothing a request in this room can observe: onBootstrap settings wiring, cron
// registration, or a hook that acts only through an outside service (OAuth provider, SMTP), so
// §1's boot scan is their whole cover here; their own suites probe them against that service.
const BOOT_SCAN_ONLY = new Set([
  "_cron_env.pb.js",
  "alerts.pb.js",
  "backups.pb.js",
  "files.pb.js",
  "invitation_expiry.pb.js",
  "mail.pb.js",
  "oauth.pb.js",
  "signup_purge.pb.js",
]);

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(64)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
  );
}

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

async function find_by_filter(
  collection: string,
  filt: string,
  token: string | null,
  per_page = 200,
): Promise<any[]> {
  const qs = urlencode({ filter: filt, perPage: per_page });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return truthy(r.items) ? r.items : [];
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null,
): Promise<any> {
  const items = await find_by_filter(collection, `${field}='${esc(value)}'`, token);
  return items.length ? getitem(items[0], "id") : null;
}

async function login(email: string, password = "test123456"): Promise<[any, any]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password,
  });
  return [r.token, (truthy(r.record) ? r.record : {}).id];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-hookload-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  run_checked(
    [
      PB_BIN,
      "superuser",
      "upsert",
      SU_EMAIL,
      SU_PASSWORD,
      "--dir",
      DATA_DIR,
      "--migrationsDir",
      MIG_DIR,
    ],
    { cwd: REPO_ROOT, capture_output: true },
  );
  const hooks = roomkit.hooks_dir(S);
  // §1: this call is the boot scan — it refuses the room if any hook file failed to load.
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, hooks);

  console.log("\n── §1 boot scan: no hook file failed to load ──");
  check("roomkit.serve() accepted the room (no 'failed to execute')", server !== null, true);
  const present = fs
    .readdirSync(hooks)
    .filter((f) => f.endsWith(".pb.js"))
    .sort(by_code_point);
  console.log(`  hook files in the room: ${present.length}`);

  const seed_proc = Bun.spawn([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: BASE_URL,
      PB_SUPERUSER_EMAIL: SU_EMAIL,
      PB_SUPERUSER_PASSWORD: SU_PASSWORD,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [seed_out, seed_err, seed_rc] = await Promise.all([
    new Response(seed_proc.stdout).text(),
    new Response(seed_proc.stderr).text(),
    seed_proc.exited,
  ]);
  check("seed.ts exit code", seed_rc, 0);
  if (seed_rc !== 0) {
    console.log(seed_out, seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  let status: number;
  let r: any;
  [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = roomkit.token_of(BASE_URL, SU_EMAIL, r);
  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const BOB_WS = await find_id("workspaces", "name", "Bob's Workspace", su);
  const PROJ = await find_id("projects", "name", "Website Redesign", alice);
  const ST_A =
    (await find_by_filter("statuses", `workspace='${ALICE_WS}'`, alice)).map((s) =>
      getitem(s, "id"),
    )[0] ?? null;
  const ST_BOB =
    (await find_by_filter("statuses", `workspace='${BOB_WS}'`, su)).map((s) =>
      getitem(s, "id"),
    )[0] ?? null;
  check(
    "fixtures resolved",
    [su, alice, bob, ALICE_WS, BOB_WS, PROJ, ST_A, ST_BOB].every(truthy),
    true,
  );

  console.log("\n── §2 one probe per hook file that registers a request/route/realtime handler ──");

  // scope.pb.js + keys.pb.js + ordinal.pb.js: one create, three observables.
  let task: any;
  [status, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "hookload probe A",
    project: PROJ,
    status: ST_A,
  });
  check("scope.pb.js: a create with project but no workspace is accepted", status, 200);
  check("scope.pb.js: workspace defaulted from the project", task.workspace, ALICE_WS);
  check("keys.pb.js: the created task carries a minted key", truthy(task.key), true);
  check(
    "ordinal.pb.js: the created task carries a non-zero ordinal",
    py_get(task, "ordinal", 0) > 0,
    true,
  );

  // main.pb.js: a status belonging to ANOTHER workspace is refused.
  [status] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "hookload probe B",
    workspace: ALICE_WS,
    status: ST_BOB,
  });
  check("main.pb.js: a cross-workspace status is refused 400", status, 400);

  // names.pb.js: PB's own `required` accepts whitespace-only; this hook is what refuses it.
  [status] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "   ",
    workspace: ALICE_WS,
  });
  check("names.pb.js: a whitespace-only title is refused 400", status, 400);

  // shadow.pb.js: an item created with no project lands in the workspace's shadow project.
  let shadowed: any;
  [status, shadowed] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "hookload probe C",
    workspace: ALICE_WS,
  });
  check(
    "shadow.pb.js: a project-less create is placed in a project",
    truthy(shadowed.project),
    true,
  );

  // author.pb.js: `author` is stamped from the caller, never from the submitted body.
  let decision: any;
  [status, decision] = await api("POST", "/api/collections/decisions/records", bob, {
    title: "hookload probe D",
    workspace: ALICE_WS,
    project: PROJ,
    author: alice_id,
  });
  check("author.pb.js: author stamped from the caller, not the body", decision.author, bob_id);

  // owner.pb.js: `owner` is stamped from the caller when the body omits it.
  // COVERS: hook:owner.pb.js#onRecordCreateRequest:projects, hook:owner.pb.js#onRecordCreateRequest:workspaces, hook:owner.pb.js#onRecordCreateRequest:saved_views
  const owner_bodies: [string, Record<string, unknown>][] = [
    ["projects", { name: "hookload owner P", workspace: ALICE_WS }],
    ["workspaces", { name: "hookload owner W" }],
    [
      "saved_views",
      { name: "hookload owner V", workspace: ALICE_WS, filterData: [], scope: "personal" },
    ],
  ];
  for (const [coll, body] of owner_bodies) {
    let created: any;
    [status, created] = await api("POST", `/api/collections/${coll}/records`, bob, body);
    check(
      `owner.pb.js: ${coll} created without owner is owned by the caller`,
      tup(status, created.owner ?? null),
      tup(200, bob_id),
    );
  }

  // invitations.pb.js onRecordEnrich: every read of an invitation carries the computed expiry.
  // COVERS: hook:invitations.pb.js#onRecordEnrich:workspace_invitations
  let inv: any;
  [status, inv] = await api("POST", "/api/collections/workspace_invitations/records", su, {
    workspace: ALICE_WS,
    email: "hookload-enrich@example.com",
    role: "member",
  });
  [status, inv] = await api("GET", `/api/collections/workspace_invitations/records/${inv.id}`, su);
  check(
    "invitations.pb.js: a read of an invitation carries expires_at and expired",
    tup(status, truthy(inv.expires_at), inv.expired),
    tup(200, true, false),
  );

  // notify.pb.js: creating a task auto-subscribes its creator.
  let bob_task: any;
  [status, bob_task] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "hookload probe E",
    workspace: ALICE_WS,
    project: PROJ,
  });
  const subs = await find_by_filter(
    "task_subscribers",
    `task='${py_str(bob_task.id)}' && user='${bob_id}'`,
    su,
  );
  check("notify.pb.js: the creator was auto-subscribed to his task", subs.length, 1);

  // precondition.pb.js: a submitted expected_updated_at is honoured, never dropped.
  [status] = await api("PATCH", `/api/collections/tasks/records/${getitem(task, "id")}`, alice, {
    title: "hookload probe A (edited)",
    expected_updated_at: "not-a-real-timestamp",
  });
  check("precondition.pb.js: an unusable expected_updated_at is refused 400", status, 400);

  // membership_status.pb.js: an out-of-enum status is refused by the HOOK's own message,
  // not PB's generic field validation — `status` is now active|suspended only, so field
  // validation alone would ALSO 400 a nonsense value with a different shape; the hook's
  // own onRecordUpdateRequest runs BEFORE that validation and throws first, which is the
  // only remaining way this probe differs with the file present vs absent.
  const bob_row = await find_by_filter(
    "workspace_members",
    `workspace='${ALICE_WS}' && user='${bob_id}'`,
    su,
  );
  let body: any;
  [status, body] = await api(
    "PATCH",
    `/api/collections/workspace_members/records/${getitem(bob_row[0], "id")}`,
    alice,
    { status: "invited" },
  );
  check("membership_status.pb.js: an out-of-enum status is refused 400", status, 400);
  check(
    "…by the HOOK's own message, proving the hook (not bare field validation) fired",
    py_str(py_get(body, "message", "")).toLowerCase(),
    "that is not a valid membership status.",
  );

  // activity.pb.js: an update writes a task_activity row.
  [status] = await api("PATCH", `/api/collections/tasks/records/${getitem(task, "id")}`, alice, {
    title: "hookload probe A (renamed)",
  });
  check("activity.pb.js fixture: the update landed", status, 200);
  let deadline = Date.now() + 10000;
  let acts: any[] = [];
  while (Date.now() < deadline) {
    acts = await find_by_filter("task_activity", `task='${getitem(task, "id")}'`, su);
    if (acts.length) break;
    await Bun.sleep(200);
  }
  check("activity.pb.js: the update wrote a task_activity row", acts.length > 0, true);

  // realtime.pb.js: a create broadcasts on the workspace topic.
  const listener = new roomkit.SSEListener(BASE_URL, alice, `rt:project_items:${ALICE_WS}`);
  check("realtime.pb.js fixture: the SSE stream opened", truthy(await listener.start()), true);
  await Bun.sleep(1000);
  [status] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "hookload probe F",
    workspace: ALICE_WS,
    project: PROJ,
  });
  deadline = Date.now() + 10000;
  while (Date.now() < deadline && !listener.of("tasks", "create").length) {
    await Bun.sleep(200);
  }
  listener.stop = true;
  check(
    "realtime.pb.js: the create broadcast on the workspace topic",
    listener.of("tasks", "create").length > 0,
    true,
  );

  // trash.pb.js: the first DELETE soft-trashes instead of destroying the row.
  [status] = await api(
    "DELETE",
    `/api/collections/tasks/records/${getitem(shadowed, "id")}`,
    alice,
  );
  check("trash.pb.js fixture: the DELETE returned 204", status, 204);
  let row: any;
  [status, row] = await api("GET", `/api/collections/tasks/records/${getitem(shadowed, "id")}`, su);
  check("trash.pb.js: the row survives the DELETE", status, 200);
  check("trash.pb.js: it survives with `trashed` set", truthy(row.trashed), true);

  // routes.pb.js: the custom search route is registered (a missing file 404s).
  [status] = await api("GET", "/api/tracker/search?q=hookload", alice);
  check("routes.pb.js: GET /api/tracker/search is registered", status, 200);

  // counts.pb.js: its group-counts route is registered.
  [status] = await api(
    "GET",
    `/api/tracker/project-items/counts?group=status&filter=workspace%3D%27${ALICE_WS}%27`,
    alice,
  );
  check("counts.pb.js: GET /api/tracker/project-items/counts is registered", status, 200);

  // item_list.pb.js: the project_items list names a field whose operator it cannot answer.
  let listed: any;
  [status, listed] = await api(
    "GET",
    `/api/collections/project_items/records?filter=${encodeURIComponent('status ~ "x"')}`,
    alice,
  );
  check(
    "item_list.pb.js: an unsupported filter operator is refused naming the field",
    tup(status, listed?.data?.status?.code ?? null),
    tup(400, "operator_not_supported"),
  );

  // cycles.pb.js: its rollover route is registered.
  [status] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("cycles.pb.js: POST /api/tracker/cycles/rollover is registered", status, 200);

  // auth_identity.pb.js: login is case-insensitive; PB's own match is BINARY.
  const [token] = await login("ALICE@EXAMPLE.COM");
  check("auth_identity.pb.js: an upper-cased identity still authenticates", truthy(token), true);

  // schema_guards.pb.js: PB itself silently drops a body key that names no field.
  [status] = await api("POST", "/api/collections/app_docs/records", su, {
    slug: "concept:hookload-probe",
    title: "P",
    body: "p",
    kind: "concept",
  });
  check("schema_guards.pb.js: an unknown app_docs body key is refused 400", status, 400);

  // api_keys.pb.js: its create hook returns a tmk_ key and its middleware authenticates it.
  let minted: any;
  [status, minted] = await api("POST", "/api/collections/api_keys/records", alice, {
    name: "hookload probe",
    scope: "read",
  });
  check(
    "api_keys.pb.js: a key create returns a tmk_ key",
    tup(status, /^tmk_/.test(minted.key ?? "")),
    tup(200, true),
  );
  [status] = await api("GET", "/api/collections/workspaces/records", `tmk_${"A".repeat(40)}`);
  check("api_keys.pb.js: an unknown tmk_ key is refused 401", status, 401);

  // invitations.pb.js: its invitee-list route is registered (a missing file 404s).
  let mine_body: any;
  [status, mine_body] = await api("GET", "/api/tracker/invitations/mine", alice);
  check(
    "invitations.pb.js: GET /api/tracker/invitations/mine is registered",
    tup(status, mine_body),
    tup(200, { items: [] }),
  );

  // user_settings.pb.js: its settings route is registered (a missing file 404s on the caller's own id).
  let settings_body: any;
  [status, settings_body] = await api("GET", `/api/tracker/users/${alice_id}/settings`, alice);
  check(
    "user_settings.pb.js: GET /api/tracker/users/{id}/settings is registered",
    tup(status, typeof settings_body?.display_name),
    tup(200, "string"),
  );

  // landing.pb.js: its landing route is registered (a missing file 404s).
  let landing_body: any;
  [status, landing_body] = await api("GET", "/api/tracker/me/landing", alice);
  check(
    "landing.pb.js: GET /api/tracker/me/landing is registered",
    tup(status, "landing" in landing_body),
    tup(200, true),
  );

  // me.pb.js: its me route is registered (a missing file 404s).
  let me_body: any;
  [status, me_body] = await api("GET", "/api/tracker/me", alice);
  check(
    "me.pb.js: GET /api/tracker/me is registered",
    tup(status, Array.isArray(me_body?.workspaces)),
    tup(200, true),
  );

  // api_key_manage.pb.js: its key list route is registered (a missing file 404s).
  let keys_body: any;
  [status, keys_body] = await api("GET", "/api/tracker/keys", alice);
  check(
    "api_key_manage.pb.js: GET /api/tracker/keys is registered",
    tup(status, Array.isArray(keys_body?.items)),
    tup(200, true),
  );

  // oauth_server.pb.js: its metadata route is registered (a missing file 404s).
  let as_meta: any;
  [status, as_meta] = await api("GET", "/.well-known/oauth-authorization-server");
  check(
    "oauth_server.pb.js: GET /.well-known/oauth-authorization-server is registered",
    tup(status, as_meta?.issuer === BASE_URL),
    tup(200, true),
  );

  // internal_caller.pb.js: a forged sentinel X-Real-IP is dropped, so the log records the caller.
  const marker = `hookload${Date.now()}`;
  const forged = await fetch(`${BASE_URL}/api/health?${marker}`, {
    headers: { "X-Real-IP": "192.0.2.254" },
  });
  await forged.body?.cancel();
  let logged: any = null;
  for (let i = 0; i < 60 && !logged; i++) {
    const [, lg] = await api(
      "GET",
      `/api/logs?${urlencode({ filter: `data.url~'${marker}'` })}`,
      su,
    );
    logged = lg.items?.[0] ?? null;
    if (!logged) await Bun.sleep(250);
  }
  check(
    "internal_caller.pb.js: a forged sentinel X-Real-IP is not the logged address",
    tup(!!logged, logged?.data?.userIP === "192.0.2.254"),
    tup(true, false),
  );

  console.log("\n── §3 every hook file is dispositioned ──");
  const probed = new Set([
    "activity.pb.js",
    "api_key_manage.pb.js",
    "api_keys.pb.js",
    "auth_identity.pb.js",
    "author.pb.js",
    "counts.pb.js",
    "cycles.pb.js",
    "internal_caller.pb.js",
    "invitations.pb.js",
    "item_list.pb.js",
    "keys.pb.js",
    "landing.pb.js",
    "main.pb.js",
    "me.pb.js",
    "membership_status.pb.js",
    "names.pb.js",
    "notify.pb.js",
    "oauth_server.pb.js",
    "ordinal.pb.js",
    "owner.pb.js",
    "precondition.pb.js",
    "realtime.pb.js",
    "routes.pb.js",
    "schema_guards.pb.js",
    "scope.pb.js",
    "shadow.pb.js",
    "trash.pb.js",
    "user_settings.pb.js",
  ]);
  // Reconciled against the ROOM's own hooksDir, never the repo's: a hook file simply
  // MISSING from the room prints nothing at all, so §1's boot scan cannot see it and a
  // boot-scan-only file would vanish with the suite still green.
  const in_room = new Set(fs.readdirSync(hooks).filter((f) => f.endsWith(".pb.js")));
  const dispositioned = new Set([...probed, ...BOOT_SCAN_ONLY]);
  check(
    "no hook file in the room is left undispositioned",
    [...in_room].filter((f) => !dispositioned.has(f)).sort(by_code_point),
    [],
  );
  check(
    "every dispositioned hook file reached the room",
    [...dispositioned].filter((f) => !in_room.has(f)).sort(by_code_point),
    [],
  );
  const in_repo = new Set(fs.readdirSync(REAL_HOOKS_DIR).filter((f) => f.endsWith(".pb.js")));
  check(
    "the room's hook files are the repo's hook files",
    [...in_repo, ...in_room].filter((f) => in_repo.has(f) !== in_room.has(f)).sort(by_code_point),
    [],
  );
  console.log(
    `  boot-scan-only (onBootstrap, nothing a request can trip): ${py_repr([...BOOT_SCAN_ONLY].sort(by_code_point))}`,
  );
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} hook-load check(s) FAILED`);
  process.exit(1);
}
console.log("✅ every pb_hooks file is loaded in a booted room");
process.exit(0);

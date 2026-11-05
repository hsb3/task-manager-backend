#!/usr/bin/env bun
/**
 * E2E proof of the soft-delete trash mechanism: DELETE interception (first
 * DELETE traps to trash, second DELETE purges), LIST-surface exclusion,
 * project-trash traversal cascade for tasks, owner-only workspace trash, a
 * superuser hard-purge escape hatch, and the age-based expiry sweep (manual
 * trigger + app_settings-driven / 30-day-fallback retention window). Also
 * covers the trashed_by actor stamp, the GET /api/tracker/trash listing route
 * role matrix, and the restore-conflict guard (refused untrash when the
 * item's parent project is trashed).
 *
 * Carol is promoted to admin of Alice's workspace in-suite via a superuser
 * PATCH (updateRule on workspace_members is owner-only). Needs superuser creds
 * from env (PB_SUPERUSER_EMAIL/PASSWORD) to promote Carol, inject aged
 * `trashed` timestamps, mint/clean up throwaways, and drive the purge route.
 *
 * verify_grep tokens for model/target/*.yml — keep in sync:
 *     surface-exclusion — trashed rows absent from LIST surfaces
 *     delete-to-trash    — member DELETE traps to trash 204 + trashed set
 *     trash-restore      — PATCH trashed="" returns row to lists
 *     purge-rights       — member 2nd DELETE 400 veto; owner/admin purge 204
 *     cron-expiry        — trigger purges aged rows, spares fresh
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";
import { migrate_up, pb_bin_path } from "../scripts/pb_migrate.ts";
import {
  by_code_point,
  json_dumps,
  py_repr,
  py_str,
  py_strip,
  read_text,
  tup,
  urlencode,
  truthy,
  sqlite_connect,
} from "../scripts/_py.ts";

// .env is gitignored — no secrets hard-coded here.
function load_env(path = ".env"): void {
  if (fs.existsSync(path)) {
    for (let line of read_text(path).split(/\r\n|\r|\n/)) {
      line = py_strip(line);
      if (line && !line.startsWith("#") && line.includes("=")) {
        const i = line.indexOf("=");
        const k = line.slice(0, i);
        const v = line.slice(i + 1);
        if (!(k in process.env)) process.env[k] = v;
      }
    }
  }
}

load_env();

// R1 sentence pin: a no-server half of the R1 proof (the live half is T21, below). Replays
// pb_migrations/ into a throwaway dir (no port, no running server) and asserts the tasks
// app_docs body carries the ruled sentence — fails if the sentence is edited out or reworded
// away from its "id survives, expand omits it" claim.
const _REPO_ROOT = path.dirname(import.meta.dir);

function check_r1_app_docs_sentence(): void {
  const pb_bin = pb_bin_path(_REPO_ROOT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbr1doc_"));
  try {
    const [ok, out] = migrate_up(pb_bin, tmp, path.join(_REPO_ROOT, "pb_migrations"));
    if (!ok) {
      console.log(`  migrate up failed:\n${out}`);
      check("R1 app_docs pin: migrate up succeeded (no server needed)", ok, true);
      return;
    }
    const con = sqlite_connect(path.join(tmp, "data.db"));
    let row: any;
    try {
      row = con.query("SELECT body FROM app_docs WHERE id = ?").get("pbcpjr5oudnntf7");
    } finally {
      con.close();
    }
    const body: string = row ? row.body : "";
    check(
      "R1 app_docs pin: collection:tasks documents the id-survives/expand-omits rule",
      body.includes("a relation field such as parent always returns the id it stores") &&
        body.includes("an absent expand key as hidden state"),
      true,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;

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

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(PB, email, r), r.record.id];
}

function esc(value: string): string {
  return value.replaceAll("'", "\\'");
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<string | null> {
  const filt = `${field}='${esc(value)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

async function status_id(ws_id: string, word: string, tok: string | null): Promise<string | null> {
  // status is a relation to `statuses` — map the legacy free-text word to
  // the workspace's seeded status name, then resolve its record id.
  const name =
    ({ todo: "Todo", doing: "In Progress", done: "Done" } as Record<string, string>)[word] ?? word;
  const filt = `workspace='${esc(ws_id)}' && name='${esc(name)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/statuses/records?${qs}`, tok);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

tierkit.use(api);

const FAILS: string[] = [];

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_str(got)} (expected ${py_str(expected)})`,
  );
}

function check_in(label: string, got: any, allowed: any[]): void {
  const ok = allowed.some((a) => Bun.deepEquals(got, a, true));
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_str(got)} (expected one of ${py_repr(tup(...allowed))})`,
  );
}

check_r1_app_docs_sentence();

/**
 * True iff a plain id-filtered LIST returns the record — the direct proof
 * of surface-exclusion (a trashed row 200-empties out of every LIST).
 */
async function list_has(
  collection: string,
  rid: string,
  token: string | null,
): Promise<[number, boolean]> {
  const qs = urlencode({ filter: `id='${esc(rid)}'` });
  const [s, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return [s, truthy(r.items?.length)];
}

/**
 * True iff GET /api/tracker/trash hands the record to `token` — the enumeration that
 * replaces the rule-scoped read card htsr removed.
 */
async function trash_route_has(
  rid: string,
  token: string | null,
  workspace: string | null = null,
): Promise<boolean> {
  const ws = workspace || ALICE_WORKSPACE;
  const [, body] = await api("GET", `/api/tracker/trash?workspace=${ws}`, token);
  return (body.items || []).some((it: any) => (it.record || {}).id === rid);
}

/** GET /api/tracker/trash with its query params encoded. */
function trash_q(ws: string, params: Record<string, string | number> = {}): string {
  return `/api/tracker/trash?${urlencode({ workspace: ws, ...params })}`;
}

function ts_of(dt: Date): string {
  return dt.toISOString().slice(0, 19).replace("T", " ") + ".000Z";
}

function past_ts(days: number): string {
  return ts_of(new Date(Date.now() - days * 86400 * 1000));
}

function now_ts(): string {
  return ts_of(new Date());
}

const token_hex = (n: number): string => randomBytes(n).toString("hex");

// ── Superuser + base fixtures ──────────────────────────────────────────────
let s: number;
let r: any;
let row: any;
let body: any;
let present: boolean;
const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
[, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su = roomkit.token_of(PB, SU_EMAIL, r);

const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");

const ALICE_WORKSPACE = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
const ALICE_TODO_STATUS = await status_id(ALICE_WORKSPACE, "todo", alice);
// The seeded premise of every "Bob (member) …" proof below — a Bob with no row is denied by
// tenancy with the codes T1/T3 read as the trash hook's own answers.
const bob_tier = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "member", alice, "Bob");

async function su_create_user(name: string, email: string): Promise<string> {
  const [s, r] = await api("POST", "/api/collections/users/records", su, {
    email: email,
    password: "test123456",
    passwordConfirm: "test123456",
    name: name,
    verified: true,
    approved: true,
  });
  check_in(`setup: su creates throwaway user ${name}`, s, [200, 201]);
  return r.id;
}

const THROWAWAY_USERS: string[] = []; // user ids to su-delete in the final cleanup pass
const LEFTOVER_TASKS: string[] = []; // task ids not purged by their own scenario, cleaned up via su hard-delete

// T1-T4: task trash / restore / purge-veto / owner-purge lifecycle.
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
console.log(
  "\n── T1: Bob (member) DELETE live task -> trash (204), trashed set, absent from list ──",
);
let task_a: any;
[s, task_a] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_a",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_a", s, [200, 201]);
const TASK_A = task_a.id;

[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_A}`, bob);
check("T1: Bob (member) DELETE live task_a -> trash", s, 204);
[s, row] = await api("GET", `/api/collections/tasks/records/${TASK_A}`, bob);
check("T1: GET-by-id task_a is 404 for the member (card htsr: viewRule mirrors listRule)", s, 404);
let su_row: any;
[s, su_row] = await api("GET", `/api/collections/tasks/records/${TASK_A}`, su);
check("T1: task_a still exists (superuser GET 200)", s, 200);
check("T1: task_a.trashed is set (non-empty, superuser view)", truthy(su_row.trashed), true);
check("T1: task_a.trashed_by is Bob's id (superuser view)", su_row.trashed_by, bob_id);
[s, present] = await list_has("tasks", TASK_A, bob);
check(
  "T1: task_a absent from the LIST surface (surface-exclusion)",
  tup(s, present),
  tup(200, false),
);
check(
  "T1: GET /api/tracker/trash still hands task_a to the member (the read that replaces it)",
  await trash_route_has(TASK_A, bob),
  true,
);

console.log('\n── T2: Bob PATCH trashed="" on task_a -> restore (200), present in list again ──');
[s, row] = await api("PATCH", `/api/collections/tasks/records/${TASK_A}`, bob, { trashed: "" });
check("T2: Bob restores task_a (trashed='')", s, 200);
check("T2: task_a.trashed reads back empty", row.trashed ?? "", "");
[s, present] = await list_has("tasks", TASK_A, bob);
check(
  "T2: task_a present in the LIST surface again (trash-restore)",
  tup(s, present),
  tup(200, true),
);

// COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
console.log("\n── T3: Bob second DELETE on a trashed task -> 400 purge veto ──");
[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_A}`, bob);
check("setup: Bob re-trashes task_a (first DELETE since restore)", s, 204);
[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_A}`, bob);
check(
  "T3: Bob (member) second DELETE on trashed task_a -> 400 (purge veto)",
  tup(await bob_tier.now(), s),
  tup("member", 400),
);
[s] = await api("GET", `/api/collections/tasks/records/${TASK_A}`, alice);
check("T3: the trashed task_a is 404 even for the workspace OWNER (card htsr)", s, 404);
[s, row] = await api("GET", `/api/collections/tasks/records/${TASK_A}`, su);
check("T3: task_a still exists after the veto (superuser GET 200)", s, 200);
check("T3: task_a.trashed still set after the veto", truthy(row.trashed), true);
check(
  "T3: the owner still reaches task_a through GET /api/tracker/trash after the veto",
  await trash_route_has(TASK_A, alice),
  true,
);

// COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
console.log("\n── T4: Alice (owner) second DELETE on the trashed task -> 204 purge, GET 404 ──");
[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_A}`, alice);
check("T4: Alice (owner) second DELETE on trashed task_a -> 204 (purge-rights)", s, 204);
[s] = await api("GET", `/api/collections/tasks/records/${TASK_A}`, alice);
check("T4: task_a is gone after the owner purge (GET 404)", s, 404);
// Since card htsr a member 404 also covers "trashed but present", so REAL deletion is only
// provable through the superuser, whose read no rule narrows.
[s] = await api("GET", `/api/collections/tasks/records/${TASK_A}`, su);
check("T4: task_a is really deleted, not merely hidden (superuser GET 404)", s, 404);

// T5: plain-member purge attempt is denied by the RULE, not the hook.
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:projects
console.log("\n── T5: Carol (admin) trash/restore/purge a project; task traversal cascade ──");
const carol_user_id = (await find_id("users", "email", "carol@example.com", su))!;
[s] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: carol_user_id,
  role: "member",
  status: "active",
});
check_in("setup: Carol added to Alice's workspace", s, [200, 201]);
// T5's admin-tier trash/restore/purge proofs rest on the promotion having STORED, not on a
// PATCH having been accepted.
const carol_admin = await tierkit.actor_at_tier(
  ALICE_WORKSPACE,
  carol_user_id,
  "admin",
  su,
  "Carol",
);
const [carol, carol_id] = await login("carol@example.com");

let proj: any;
[s, proj] = await api("POST", "/api/collections/projects/records", alice, {
  name: "trash-test: project_t5",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Alice creates project_t5", s, [200, 201]);
const PROJECT_T5 = proj.id;
let task_t5: any;
[s, task_t5] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_t5",
  status: ALICE_TODO_STATUS,
  project: PROJECT_T5,
});
check_in("setup: Alice creates task_t5 in project_t5", s, [200, 201]);
const TASK_T5 = task_t5.id;

[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_T5}`, carol);
check("T5: Carol (admin) DELETE live project_t5 -> trash (204)", s, 204);
[s, row] = await api("GET", `/api/collections/projects/records/${PROJECT_T5}`, alice);
check("T5: GET-by-id project_t5 is 200 for the workspace OWNER (trashed set)", s, 200);
check("T5: project_t5.trashed is set (non-empty)", truthy(row.trashed), true);
[s, present] = await list_has("projects", PROJECT_T5, alice);
check(
  "T5: project_t5 still present in the OWNER's projects LIST (card jwwp carve-out)",
  tup(s, present),
  tup(200, true),
);
// The carve-out is per-tier: card jwwp hides a trashed project from a plain member on both
// surfaces while the Trash screen (owner/admin) keeps enumerating it through this same rule.
[s, present] = await list_has("projects", PROJECT_T5, carol);
check(
  "T5: project_t5 still present in the ADMIN's projects LIST (card jwwp)",
  tup(s, present),
  tup(200, true),
);
[s] = await api("GET", `/api/collections/projects/records/${PROJECT_T5}`, carol);
check("T5: GET-by-id project_t5 is 200 for the ADMIN (card jwwp)", s, 200);
[s, present] = await list_has("projects", PROJECT_T5, bob);
check(
  "T5: project_t5 absent from the plain MEMBER's projects LIST (card jwwp)",
  tup(s, present),
  tup(200, false),
);
[s] = await api("GET", `/api/collections/projects/records/${PROJECT_T5}`, bob);
check("T5: GET-by-id project_t5 is 404 for the plain MEMBER (card jwwp)", s, 404);
// PB answers a successful PATCH with the whole record whatever the viewRule says, so the WRITE
// rule is the only thing keeping a trashed project's name from a member the read rule refused.
[s, row] = await api("PATCH", `/api/collections/projects/records/${PROJECT_T5}`, bob, {});
check(
  "T5: no-op PATCH of project_t5 is 404 for the plain MEMBER, so the response cannot hand " +
    "back the name the viewRule just withheld (card jwwp)",
  tup(s, row.name ?? ""),
  tup(404, ""),
);
// The trash actor set is owner/admin (deleteRule), so the restore actor set has to match it.
[s] = await api("PATCH", `/api/collections/projects/records/${PROJECT_T5}`, bob, { trashed: "" });
check("T5: the plain MEMBER cannot RESTORE project_t5 either (card jwwp)", s, 404);
[s, row] = await api("GET", `/api/collections/projects/records/${PROJECT_T5}`, su);
check(
  "T5: project_t5 is still trashed after the plain MEMBER restore attempt",
  truthy(row.trashed),
  true,
);

[s] = await api("GET", `/api/collections/tasks/records/${TASK_T5}`, alice);
check("T5: task_t5 is 404 by id too — the view cascades project.trashed (card htsr)", s, 404);
[s, row] = await api("GET", `/api/collections/tasks/records/${TASK_T5}`, su);
check("T5: task_t5.trashed is itself still empty (no task-side marker)", row.trashed ?? "", "");
[s, present] = await list_has("tasks", TASK_T5, alice);
check(
  "T5: task_t5 absent from the tasks LIST (traversal cascade via project.trashed)",
  tup(s, present),
  tup(200, false),
);

[s, row] = await api("PATCH", `/api/collections/projects/records/${PROJECT_T5}`, carol, {
  trashed: "",
});
check("T5: Carol (admin) restores project_t5 (trashed='')", s, 200);
[s, present] = await list_has("projects", PROJECT_T5, alice);
check("T5: project_t5 present in the projects LIST again", tup(s, present), tup(200, true));
[s, present] = await list_has("tasks", TASK_T5, alice);
check(
  "T5: task_t5 present in the tasks LIST again (traversal restore)",
  tup(s, present),
  tup(200, true),
);

[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_T5}`, bob);
check(
  "T5: Bob (plain member) DELETE project_t5 -> 404 (rule-denied, not owner/admin)",
  tup(await bob_tier.now(), s),
  tup("member", 404),
);
[s] = await api("GET", `/api/collections/projects/records/${PROJECT_T5}`, alice);
check("T5: project_t5 untouched by Bob's denied attempt (still GET 200)", s, 200);

[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_T5}`, carol);
check("setup: Carol re-trashes project_t5 (first DELETE since restore)", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_T5}`, carol);
check("T5: Carol (admin) second DELETE on trashed project_t5 -> 204 purge (cascade)", s, 204);
[s] = await api("GET", `/api/collections/projects/records/${PROJECT_T5}`, alice);
check("T5: project_t5 is gone after the purge (GET 404)", s, 404);
[s] = await api("GET", `/api/collections/tasks/records/${TASK_T5}`, alice);
check("T5: task_t5 is gone too (project purge cascadeDelete)", s, 404);

// COVERS: hook:trash.pb.js#onRecordDeleteRequest:workspaces
console.log("\n── T6: workspace trash owner-only; Bob (member) denied; owner traps to trash ──");
const dave_email = `trash-dave-${token_hex(4)}@example.com`;
const dave_id = await su_create_user("Dave", dave_email);
THROWAWAY_USERS.push(dave_id);
const [dave] = await login(dave_email);
const DAVE_WORKSPACE = (await find_id("workspaces", "owner", dave_id, su))!;
check("setup: Dave auto-provisioned exactly one workspace", DAVE_WORKSPACE !== null, true);
[s] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: DAVE_WORKSPACE,
  user: bob_id,
  role: "member",
  status: "active",
});
check_in("setup: Bob added to Dave's workspace as a plain member", s, [200, 201]);
// Bob's stored role rides in the assertion: without this membership row a NON-member's 404
// would read the same, and T6 would prove tenancy instead of the owner-only rule.
const bob_in_dave_ws = await tierkit.actor_at_tier(DAVE_WORKSPACE, bob_id, "member", su, "Bob");

[s] = await api("DELETE", `/api/collections/workspaces/records/${DAVE_WORKSPACE}`, bob);
check(
  "T6: Bob (member) DELETE Dave's workspace -> 404 (owner-only)",
  tup(await bob_in_dave_ws.now(), s),
  tup("member", 404),
);
await bob_in_dave_ws.done(); // Dave's workspace is trashed next; the membership goes with his account

[s] = await api("DELETE", `/api/collections/workspaces/records/${DAVE_WORKSPACE}`, dave);
check("T6: Dave (owner) DELETE his own workspace -> 204 (trash)", s, 204);
[s] = await api("GET", `/api/collections/workspaces/records/${DAVE_WORKSPACE}`, dave);
check('T6: GET-by-id Dave\'s trashed workspace is 404 (viewRule carries trashed = "")', s, 404);
// The owner's Trash surface is the one read that serves a trashed workspace (routes bypass rules).
let dave_trash: any;
[s, dave_trash] = await api("GET", "/api/tracker/workspaces/trash", dave);
row = (dave_trash.items ?? []).find((w: any) => w.id === DAVE_WORKSPACE) ?? {};
check("T6: Dave's own Trash surface lists it", tup(s, row.id), tup(200, DAVE_WORKSPACE));
check("T6: Dave's workspace.trashed is set (non-empty)", truthy(row.trashed), true);
[s, present] = await list_has("workspaces", DAVE_WORKSPACE, dave);
check("T6: Dave's workspace absent from the switcher LIST", tup(s, present), tup(200, false));

// COVERS: hook:main.pb.js#onRecordAfterDeleteSuccess:workspaces
console.log(
  "\n── T6B: superuser hard-purge of a sole LIVE workspace -> owner fully reprovisioned ──",
);
let frank_email = `trash-frank-${token_hex(4)}@example.com`;
let frank_id = await su_create_user("Frank", frank_email);
THROWAWAY_USERS.push(frank_id);

const FRANK_WS1 = (await find_id("workspaces", "owner", frank_id, su))!;
check("setup: Frank auto-provisioned exactly one workspace", FRANK_WS1 !== null, true);

let qs = urlencode({ filter: `workspace='${esc(FRANK_WS1)}' && user='${esc(frank_id)}'` });
[, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
let items = r.items || [];
check("setup: Frank has a self-membership row in his sole workspace", items.length === 1, true);
const FRANK_MEMBERSHIP1 = items.length ? items[0].id : null;

let ws1_row: any;
[s, ws1_row] = await api("GET", `/api/collections/workspaces/records/${FRANK_WS1}`, su);
check("setup: GET Frank's sole workspace -> 200", s, 200);
const FRANK_PROJECT1 = ws1_row.default_project;
check("setup: Frank's sole workspace has a default_project set", truthy(FRANK_PROJECT1), true);

const FRANK_SETTINGS1 = await find_id("user_settings", "user", frank_id, su);
check(
  "setup: Frank has a user_settings row (from account creation)",
  FRANK_SETTINGS1 !== null,
  true,
);

[s] = await api("DELETE", `/api/collections/workspaces/records/${FRANK_WS1}`, su);
check(
  "T6B: superuser DELETE Frank's LIVE sole workspace -> 204 (hard purge, bypasses trash)",
  s,
  204,
);
[s] = await api("GET", `/api/collections/workspaces/records/${FRANK_WS1}`, su);
check("T6B: Frank's original workspace is gone (GET 404, no trash step)", s, 404);

const FRANK_WS2 = (await find_id("workspaces", "owner", frank_id, su))!;
check("T6B: Frank has a FRESH workspace after the hard purge", FRANK_WS2 !== null, true);
check("T6B: the fresh workspace is a NEW row (different id)", FRANK_WS2 !== FRANK_WS1, true);

qs = urlencode({ filter: `workspace='${esc(FRANK_WS2)}' && user='${esc(frank_id)}'` });
[, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
items = r.items || [];
check("T6B: Frank has a FRESH self-membership row in the new workspace", items.length === 1, true);
const FRANK_MEMBERSHIP2 = items.length ? items[0].id : null;
check(
  "T6B: the fresh membership is a NEW row (different id)",
  FRANK_MEMBERSHIP2 !== null && FRANK_MEMBERSHIP2 !== FRANK_MEMBERSHIP1,
  true,
);

let ws2_row: any;
[s, ws2_row] = await api("GET", `/api/collections/workspaces/records/${FRANK_WS2}`, su);
check("T6B: GET the fresh workspace -> 200", s, 200);
const FRANK_PROJECT2 = ws2_row.default_project;
check("T6B: the fresh workspace has a default_project set", truthy(FRANK_PROJECT2), true);
check(
  "T6B: the fresh default_project is a NEW row (different id)",
  FRANK_PROJECT2 !== FRANK_PROJECT1,
  true,
);
let proj2_row: any;
[s, proj2_row] = await api("GET", `/api/collections/projects/records/${FRANK_PROJECT2}`, su);
check("T6B: GET the fresh default_project -> 200", s, 200);
check(
  "T6B: the fresh default_project belongs to the fresh workspace",
  proj2_row.workspace,
  FRANK_WS2,
);

// user_settings has no relation to workspace (cascadeDelete ties only to the user),
// so it is never deleted by the workspace purge — the reprovision hook's guarded
// find-first must skip re-creating it. Prove the idempotent-skip: same row
// persists (not duplicated), rather than "re-created" (it was never gone).
qs = urlencode({ filter: `user='${esc(frank_id)}'` });
[, r] = await api("GET", `/api/collections/user_settings/records?${qs}`, su);
items = r.items || [];
check(
  "T6B: Frank still has EXACTLY ONE user_settings row (idempotent-skip, not duplicated)",
  items.length,
  1,
);
check(
  "T6B: that user_settings row is the SAME pre-existing row (untouched, not re-created)",
  items.length ? items[0].id : null,
  FRANK_SETTINGS1,
);

// COVERS: route:POST /api/tracker/trash/purge
console.log("\n── T7: cron expiry (manual trigger) — aged row purged, fresh row spared ──");
const APP_SETTINGS_ID = await find_id("app_settings", "key", "trash_retention_days", su);
check("setup: app_settings trash_retention_days row exists", APP_SETTINGS_ID !== null, true);
[s] = await api("PATCH", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, su, {
  value: 5,
});
check("T7 setup: superuser lowers trash_retention_days to 5", s, 200);

let task_x: any;
[s, task_x] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_x (T7)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_x", s, [200, 201]);
const TASK_X = task_x.id;
let task_y: any;
[s, task_y] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_y (T7)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_y", s, [200, 201]);
const TASK_Y = task_y.id;

[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_X}`, su, { trashed: past_ts(40) });
check("setup: superuser injects a 40-day-old trashed on task_x", s, 200);
[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_Y}`, su, { trashed: now_ts() });
check("setup: superuser injects a just-now trashed on task_y", s, 200);

let purge_result: any;
[s, purge_result] = await api("POST", "/api/tracker/trash/purge", su);
check("T7: POST /api/tracker/trash/purge (superuser) succeeds", s, 200);
check("T7: purge response reports at least one purged row", (purge_result.purged ?? 0) >= 1, true);

[s] = await api("GET", `/api/collections/tasks/records/${TASK_X}`, su);
check("T7: task_x (40 days old, retention=5) is purged (superuser GET 404)", s, 404);
[s] = await api("GET", `/api/collections/tasks/records/${TASK_Y}`, su);
check("T7: task_y (trashed just now) survives (superuser GET 200)", s, 200);
check(
  "T7: the survivor is still reachable by its workspace owner through the trash route",
  await trash_route_has(TASK_Y, alice),
  true,
);
LEFTOVER_TASKS.push(TASK_Y);

[s] = await api("PATCH", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, su, {
  value: 30,
});
check("cleanup: app_settings trash_retention_days restored to 30", s, 200);

// COVERS: boot:trash.pb.js, cron:trash-purge
console.log(
  "\n── T7B: trash-purge cron is registered and firing it purges an aged row (fresh control survives) ──",
);
[s] = await api("PATCH", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, su, {
  value: 5,
});
check("T7B setup: superuser lowers trash_retention_days to 5", s, 200);

let task_aged: any;
[s, task_aged] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_aged (T7B)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_aged", s, [200, 201]);
const TASK_AGED_T7B = task_aged.id;
let task_fresh: any;
[s, task_fresh] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_fresh (T7B)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_fresh (control)", s, [200, 201]);
const TASK_FRESH_T7B = task_fresh.id;

[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_AGED_T7B}`, su, {
  trashed: past_ts(40),
});
check("setup: superuser injects a 40-day-old trashed on task_aged", s, 200);
[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_FRESH_T7B}`, su, {
  trashed: now_ts(),
});
check("setup: superuser injects a just-now trashed on task_fresh (control)", s, 200);

let crons: any;
[s, crons] = await api("GET", "/api/crons", su);
check("T7B: GET /api/crons -> 200", s, 200);
const cron_ids = Array.isArray(crons) ? crons.map((c: any) => c.id) : [];
check("T7B: trash-purge is registered in GET /api/crons", cron_ids.includes("trash-purge"), true);

[s] = await api("POST", "/api/crons/trash-purge", su);
check("T7B: POST /api/crons/trash-purge (fire the scheduled cron) -> 204", s, 204);

// the cron trigger runs the sweep in the background (fire-and-forget), unlike the
// synchronous /api/tracker/trash/purge route in T7 — poll briefly for it to land.
let aged_status: number | null = null;
for (let _ = 0; _ < 20; _++) {
  [aged_status] = await api("GET", `/api/collections/tasks/records/${TASK_AGED_T7B}`, su);
  if (aged_status === 404) {
    break;
  }
  await Bun.sleep(500);
}
check(
  "T7B: task_aged (40 days old, retention=5) purged by the scheduled cron (superuser GET 404)",
  aged_status,
  404,
);
[s] = await api("GET", `/api/collections/tasks/records/${TASK_FRESH_T7B}`, su);
check(
  "T7B: task_fresh (trashed just now) survives the cron sweep (superuser GET 200, control)",
  s,
  200,
);
check(
  "T7B: the survivor is still reachable by its workspace owner through the trash route",
  await trash_route_has(TASK_FRESH_T7B, alice),
  true,
);
LEFTOVER_TASKS.push(TASK_FRESH_T7B);

[s] = await api("PATCH", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, su, {
  value: 30,
});
check("cleanup: app_settings trash_retention_days restored to 30 (T7B)", s, 200);

// COVERS: route:POST /api/tracker/trash/purge
console.log("\n── T8: no app_settings row -> fallback 30d default retention ──");
let task_x2: any;
[s, task_x2] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_x2 (T8)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_x2", s, [200, 201]);
const TASK_X2 = task_x2.id;
let task_y2: any;
[s, task_y2] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_y2 (T8)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_y2", s, [200, 201]);
const TASK_Y2 = task_y2.id;

[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_X2}`, su, { trashed: past_ts(40) });
check("setup: superuser injects a 40-day-old trashed on task_x2", s, 200);
[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_Y2}`, su, { trashed: past_ts(10) });
check("setup: superuser injects a 10-day-old trashed on task_y2", s, 200);

[s] = await api("DELETE", `/api/collections/app_settings/records/${APP_SETTINGS_ID}`, su);
check("T8 setup: superuser deletes the app_settings trash_retention_days row", s, 204);

[s, purge_result] = await api("POST", "/api/tracker/trash/purge", su);
check("T8: POST /api/tracker/trash/purge (superuser, no app_settings row) succeeds", s, 200);

[s] = await api("GET", `/api/collections/tasks/records/${TASK_X2}`, su);
check("T8: task_x2 (40 days old, 30d fallback) is purged (superuser GET 404)", s, 404);
[s] = await api("GET", `/api/collections/tasks/records/${TASK_Y2}`, su);
check("T8: task_y2 (10 days old, 30d fallback) survives (superuser GET 200)", s, 200);
check(
  "T8: the survivor is still reachable by its workspace owner through the trash route",
  await trash_route_has(TASK_Y2, alice),
  true,
);
LEFTOVER_TASKS.push(TASK_Y2);

// restore app_settings row for suite rerunnability / other consumers.
[s] = await api("POST", "/api/collections/app_settings/records", su, {
  key: "trash_retention_days",
  value: 30,
});
check_in("cleanup: app_settings trash_retention_days row recreated (value=30)", s, [200, 201]);

// COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
console.log("\n── T9: superuser DELETE on a LIVE task bypasses trash (hard purge) ──");
let task_t9: any;
[s, task_t9] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_t9 (T9)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_t9 (live)", s, [200, 201]);
const TASK_T9 = task_t9.id;

[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_T9}`, su);
check("T9: superuser DELETE on a LIVE task -> 204 (hard purge, bypasses trash)", s, 204);
[s] = await api("GET", `/api/collections/tasks/records/${TASK_T9}`, alice);
check("T9: task_t9 is gone immediately (GET 404, no trash step)", s, 404);

// COVERS: hook:trash.pb.js#onRecordDeleteRequest:decisions
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:documents
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:milestones
console.log(
  "\n── T10: trashed_by set on member DELETE trap-to-trash (decisions/documents/milestones) ──",
);
let dec_t10: any;
[s, dec_t10] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "trash-test: decision_t10",
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Bob creates decision_t10", s, [200, 201]);
const DECISION_T10 = dec_t10.id;
[s] = await api("DELETE", `/api/collections/decisions/records/${DECISION_T10}`, bob);
check("T10: Bob (member) DELETE live decision_t10 -> trash (204)", s, 204);
[s, row] = await api("GET", `/api/collections/decisions/records/${DECISION_T10}`, su);
check("T10: decision_t10.trashed_by is Bob's id (superuser view)", row.trashed_by, bob_id);

let doc_t10: any;
[s, doc_t10] = await api("POST", "/api/collections/documents/records", bob, {
  title: "trash-test: document_t10",
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Bob creates document_t10", s, [200, 201]);
const DOCUMENT_T10 = doc_t10.id;
[s] = await api("DELETE", `/api/collections/documents/records/${DOCUMENT_T10}`, bob);
check("T10: Bob (member) DELETE live document_t10 -> trash (204)", s, 204);
[s, row] = await api("GET", `/api/collections/documents/records/${DOCUMENT_T10}`, su);
check("T10: document_t10.trashed_by is Bob's id (superuser view)", row.trashed_by, bob_id);

let mile_t10: any;
[s, mile_t10] = await api("POST", "/api/collections/milestones/records", bob, {
  name: "trash-test: milestone_t10",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
});
check_in("setup: Bob creates milestone_t10", s, [200, 201]);
const MILESTONE_T10 = mile_t10.id;
[s] = await api("DELETE", `/api/collections/milestones/records/${MILESTONE_T10}`, bob);
check("T10: Bob (member) DELETE live milestone_t10 -> trash (204)", s, 204);
[s, row] = await api("GET", `/api/collections/milestones/records/${MILESTONE_T10}`, su);
check("T10: milestone_t10.trashed_by is Bob's id (superuser view)", row.trashed_by, bob_id);

console.log("\n── T11: GET /api/tracker/trash role matrix ──");
const eve_email = `trash-eve-${token_hex(4)}@example.com`;
const eve_id = await su_create_user("Eve", eve_email);
THROWAWAY_USERS.push(eve_id);
const [eve] = await login(eve_email);
qs = urlencode({ filter: `workspace='${esc(ALICE_WORKSPACE)}' && user='${esc(eve_id)}'` });
[s, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
check(
  "setup: confirmed Eve has NO workspace_members row in Alice's workspace (non-member)",
  tup(s, r.items || []),
  tup(200, []),
);
check(
  "setup: confirmed Eve is not Alice's workspace owner either",
  ALICE_WORKSPACE !== (await find_id("workspaces", "owner", eve_id, su)),
  true,
);

// COVERS: route:GET /api/tracker/trash
[s] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, eve);
check("T11: Eve (confirmed non-member) GET trash -> 403", s, 403);
[s] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, null);
check("T11: anon (no token) GET trash -> 401", s, 401);
[s] = await api("GET", trash_q(ALICE_WORKSPACE, { filter: 'type = "task"', page: 2 }), eve);
check("T11: Eve (non-member) GET trash with filter/page params -> 403", s, 403);
[s] = await api("GET", trash_q(ALICE_WORKSPACE, { group: "status" }), null);
check("T11: anon grouped GET trash -> 401", s, 401);
[s] = await api("GET", "/api/tracker/trash", bob);
check("T11: member GET trash with missing workspace param -> 400", s, 400);
[s] = await api("GET", "/api/tracker/trash?workspace=zzzzzzzzzzzzzzz", bob);
check("T11: member GET trash for a nonexistent workspace id -> 403 (no existence leak)", s, 403);

// A second, LATER-trashed decision to prove the per-collection -trashed sort.
let dec_t11b: any;
[s, dec_t11b] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "trash-test: decision_t11_later",
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Bob creates decision_t11_later", s, [200, 201]);
const DECISION_T11B = dec_t11b.id;
[s] = await api("DELETE", `/api/collections/decisions/records/${DECISION_T11B}`, bob);
check("setup: Bob DELETE decision_t11_later -> trash (204, trashed AFTER decision_t10)", s, 204);

// A live (never-trashed) decision that must never surface in the listing.
let dec_live: any;
[s, dec_live] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "trash-test: decision_live_t11",
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Bob creates decision_live_t11 (kept live)", s, [200, 201]);
const DECISION_LIVE_T11 = dec_live.id;

// (collection, id) pairs are Map keys here: JS has no tuple keys.
const pair = (coll: any, rid: any): string => `${coll}\0${rid}`;

// COVERS: route:GET /api/tracker/trash
[s, body] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, bob);
check("T11: member (Bob) GET trash -> 200", s, 200);
check(
  "T11: trash response 'workspace' field echoes the queried workspace",
  body.workspace,
  ALICE_WORKSPACE,
);
items = body.items || [];
const by_key = new Map<string, any>(
  items.map((it: any) => [pair(it.collection, (it.record || {}).id), it]),
);
check(
  "T11: trash listing includes decision_t10",
  by_key.has(pair("decisions", DECISION_T10)),
  true,
);
check(
  "T11: trash listing includes document_t10",
  by_key.has(pair("documents", DOCUMENT_T10)),
  true,
);
check(
  "T11: trash listing includes milestone_t10",
  by_key.has(pair("milestones", MILESTONE_T10)),
  true,
);
check(
  "T11: non-trashed decision_live_t11 never appears in the trash listing",
  by_key.has(pair("decisions", DECISION_LIVE_T11)),
  false,
);

const dec_item = (by_key.get(pair("decisions", DECISION_T10)) ?? {}).record ?? {};
const expand_trashed_by = (dec_item.expand || {}).trashed_by || {};
check("T11: decision_t10 row carries expand.trashed_by == Bob's id", expand_trashed_by.id, bob_id);

const dec_order = items
  .filter((it: any) => it.collection === "decisions")
  .map((it: any) => it.record.id);
const idx_new = dec_order.indexOf(DECISION_T11B);
const idx_old = dec_order.indexOf(DECISION_T10);
check(
  "T11: decisions sorted -trashed (the more-recently-trashed row appears first)",
  idx_new >= 0 && idx_old >= 0 && idx_new < idx_old,
  true,
);

[s] = await api("DELETE", `/api/collections/decisions/records/${DECISION_LIVE_T11}`, su);
check("cleanup: superuser hard-deletes decision_live_t11", s, 204);
for (const [cname, rid] of [
  ["decisions", DECISION_T10],
  ["decisions", DECISION_T11B],
  ["documents", DOCUMENT_T10],
  ["milestones", MILESTONE_T10],
]) {
  [s] = await api("DELETE", `/api/collections/${cname}/records/${rid}`, su);
  check(`cleanup: superuser hard-deletes trashed ${cname} fixture ${rid!.slice(0, 8)}`, s, 204);
}

// COVERS: route:GET /api/tracker/trash
console.log(
  "\n── T11S: a trashed task's parent and blocker statuses carry the served terminal flag ──",
);
{
  const done_status = await status_id(ALICE_WORKSPACE, "done", alice);
  const mk = async (title: string, extra: Record<string, any>): Promise<string> => {
    const [st, rec] = await api("POST", "/api/collections/tasks/records", alice, {
      workspace: ALICE_WORKSPACE,
      project: ALICE_PROJECT,
      title,
      ...extra,
    });
    check(`T11S: setup ${title} -> 200`, st, 200);
    LEFTOVER_TASKS.push(rec.id);
    return rec.id;
  };
  const t11s_parent = await mk("T11S done parent", { status: done_status });
  const t11s_blocker = await mk("T11S done blocker", { status: done_status });
  const t11s_task = await mk("T11S trashed child", {
    parent: t11s_parent,
    dependencies: [t11s_blocker],
  });
  [s] = await api("DELETE", `/api/collections/tasks/records/${t11s_task}`, alice);
  check("T11S: the child is trashed -> 204", s, 204);
  qs = urlencode({ workspace: ALICE_WORKSPACE, filter: `id='${t11s_task}'` });
  [s, r] = await api("GET", `/api/tracker/trash?${qs}`, alice);
  const t11s_rec = ((r.items || [])[0] || {}).record || {};
  check(
    "T11S: expand.parent.expand.status carries (terminal, off_pipeline)",
    tup(
      s,
      t11s_rec.expand?.parent?.expand?.status?.terminal ?? "missing",
      t11s_rec.expand?.parent?.expand?.status?.off_pipeline ?? "missing",
    ),
    tup(200, true, false),
  );
  check(
    "T11S: the blocker's expand.status carries terminal",
    t11s_rec.expand?.dependencies?.[0]?.expand?.status?.terminal ?? "missing",
    true,
  );
}

console.log("\n── T11C: trash listing applies the draft branch — a peer's draft never surfaces ──");
// The route BYPASSES collection rules, so a trashed draft used to reach every active member
// even though their REST view of it 404s (PBTT-544). Frank (second plain member) and Vic
// (viewer) are the leak detectors; the non-draft row is the control that they still see trash.
frank_email = `trash-frank-${token_hex(4)}@example.com`;
frank_id = await su_create_user("Frank", frank_email);
THROWAWAY_USERS.push(frank_id);
const vic_email = `trash-vic-${token_hex(4)}@example.com`;
const vic_id = await su_create_user("Vic", vic_email);
THROWAWAY_USERS.push(vic_id);
for (const [uid, role] of [
  [frank_id, "member"],
  [vic_id, "viewer"],
]) {
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WORKSPACE,
    user: uid,
    role: role,
    status: "active",
  });
  check_in(`setup: ${role} membership row created`, s, [200, 201]);
}
const frank_tier = await tierkit.actor_at_tier(ALICE_WORKSPACE, frank_id, "member", su, "Frank");
const vic_tier = await tierkit.actor_at_tier(ALICE_WORKSPACE, vic_id, "viewer", su, "Vic");
const [frank] = await login(frank_email);
const [vic] = await login(vic_email);

const T11C: Record<string, [string, string]> = {};
[s, r] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "trash-test: bob draft decision",
  workspace: ALICE_WORKSPACE,
  draft: true,
  context: "TRASHED SECRET CONTEXT",
});
check_in("setup: Bob creates a DRAFT decision", s, [200, 201]);
T11C.bob_draft = ["decisions", r.id];
check("setup: draft decision author is Bob", r.author, bob_id);
[s, r] = await api("POST", "/api/collections/documents/records", carol, {
  title: "trash-test: carol draft document",
  workspace: ALICE_WORKSPACE,
  draft: true,
  body: "TRASHED SECRET BODY",
});
check_in("setup: Carol (admin) creates a DRAFT document", s, [200, 201]);
T11C.carol_draft = ["documents", r.id];
// A superuser create keeps the submitted author — none here, so this is a LEGACY empty-author
// draft: it matches nobody's author leg and must stay owner/admin-only.
[s, r] = await api("POST", "/api/collections/milestones/records", su, {
  name: "trash-test: authorless draft milestone",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
  draft: true,
});
check_in("setup: superuser creates an author-less DRAFT milestone", s, [200, 201]);
check("setup: the author-less draft really has no author", r.author ?? "", "");
T11C.legacy_draft = ["milestones", r.id];
[s, r] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "trash-test: bob non-draft decision",
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Bob creates a NON-draft decision", s, [200, 201]);
T11C.nondraft = ["decisions", r.id];
// Who may trash what is already the rules' business: a plain member's DELETE on a peer's
// draft is 404, so Carol (admin) traps the two drafts Bob cannot reach.
for (const [label, trasher, who] of [
  ["bob_draft", bob, "Bob (author)"],
  ["carol_draft", carol, "Carol (admin)"],
  ["legacy_draft", carol, "Carol (admin)"],
  ["nondraft", bob, "Bob (author)"],
] as [string, string, string][]) {
  const [coll, rid] = T11C[label]!;
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, trasher);
  check(`setup: ${who} trashes the ${label} row (204)`, s, 204);
}
[s] = await api(
  "DELETE",
  `/api/collections/${T11C.carol_draft![0]}/records/${T11C.carol_draft![1]}`,
  frank,
);
check("T11C: a plain member's DELETE on a peer's draft is refused (404)", s, 404);

async function trash_ids(token: string): Promise<Set<string>> {
  const [s, body] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, token);
  check("T11C: GET trash -> 200", s, 200);
  return new Set((body.items || []).map((it: any) => pair(it.collection, (it.record || {}).id)));
}

const seen_by: Record<string, Set<string>> = {
  "Alice (owner)": await trash_ids(alice),
  "Carol (admin)": await trash_ids(carol),
  "Bob (author, member)": await trash_ids(bob),
  "Frank (plain member)": await trash_ids(frank),
  "Vic (viewer)": await trash_ids(vic),
};
const expected: Record<string, string[]> = {
  bob_draft: ["Alice (owner)", "Carol (admin)", "Bob (author, member)"],
  carol_draft: ["Alice (owner)", "Carol (admin)"],
  legacy_draft: ["Alice (owner)", "Carol (admin)"],
  nondraft: Object.keys(seen_by), // a non-draft trashed row is unchanged for every member
};
for (const [label, who_may] of Object.entries(expected)) {
  for (const [who, ids] of Object.entries(seen_by)) {
    check(
      `T11C: ${label} in ${who}'s trash listing`,
      ids.has(pair(...T11C[label]!)),
      who_may.includes(who),
    );
  }
}
// Filtering on draft never widens the carve-out: the route ANDs the caller's filter onto it.
const draft_labels = ["bob_draft", "carol_draft", "legacy_draft"];
const draft_only: Record<string, string> = {
  "Alice (owner)": alice,
  "Bob (author, member)": bob,
  "Frank (plain member)": frank,
  "Vic (viewer)": vic,
};
for (const [who, tok] of Object.entries(draft_only)) {
  [s, body] = await api("GET", trash_q(ALICE_WORKSPACE, { filter: "draft = true" }), tok);
  const got = new Set(
    (body.items || []).map((it: any) => pair(it.collection, (it.record || {}).id)),
  );
  check(
    `T11C: ${who}'s filter=draft = true serves exactly the drafts they may see`,
    tup(
      s,
      draft_labels.filter((l) => got.has(pair(...T11C[l]!))),
      got.size,
    ),
    tup(
      200,
      draft_labels.filter((l) => expected[l]!.includes(who)),
      draft_labels.filter((l) => expected[l]!.includes(who)).length,
    ),
  );
}
// The REST counterpart of the same denial — the route must not out-run the collection rule.
for (const label of ["bob_draft", "carol_draft", "legacy_draft"]) {
  const [coll, rid] = T11C[label]!;
  [s] = await api("GET", `/api/collections/${coll}/records/${rid}`, frank);
  check(`T11C: Frank's REST view of ${label} is 404 (rule idiom)`, s, 404);
}
[s] = await api("GET", `/api/collections/decisions/records/${T11C.carol_draft![1]}`, bob);
check("T11C: even Bob's REST view of Carol's draft is 404 (plain member)", s, 404);

// Restore on a row a member CAN see is untouched by the draft branch.
const [nd_coll, nd_id] = T11C.nondraft!;
[s] = await api("PATCH", `/api/collections/${nd_coll}/records/${nd_id}`, frank, { trashed: "" });
check("T11C: Frank restores the non-draft row he can see (200)", s, 200);
check(
  "T11C: the restored row leaves Frank's trash listing",
  (await trash_ids(frank)).has(pair(...T11C.nondraft!)),
  false,
);
for (const [label, [coll, rid]] of Object.entries(T11C)) {
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, su);
  check(`cleanup: superuser hard-deletes the T11C ${label} row`, s, 204);
}
await frank_tier.done();
await vic_tier.done();

// COVERS: hook:trash.pb.js#onRecordUpdateRequest:tasks
console.log("\n── T12: restore-conflict guard — happy path (parent project live) -> 200 ──");
let task_c1: any;
[s, task_c1] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_c1 (restore-guard happy)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates task_c1 (parent project live)", s, [200, 201]);
const TASK_C1 = task_c1.id;
[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_C1}`, alice);
check("setup: Alice traps task_c1 to trash (204)", s, 204);
[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_C1}`, alice, { trashed: "" });
check("T12: restore task_c1 (parent project live) -> 200 (happy path)", s, 200);
[s, present] = await list_has("tasks", TASK_C1, alice);
check(
  "T12: task_c1 present in the LIST surface again after restore",
  tup(s, present),
  tup(200, true),
);
[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_C1}`, su);
check("cleanup: superuser hard-deletes task_c1", s, 204);

// COVERS: hook:trash.pb.js#onRecordUpdateRequest:tasks
console.log("\n── T13: restore-conflict guard — parent project trashed -> 400 ──");
let proj_c2: any;
[s, proj_c2] = await api("POST", "/api/collections/projects/records", alice, {
  name: "trash-test: project_c2 (restore-guard conflict)",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Alice creates project_c2", s, [200, 201]);
const PROJECT_C2 = proj_c2.id;
let task_c2: any;
[s, task_c2] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_c2 (restore-guard conflict)",
  status: ALICE_TODO_STATUS,
  project: PROJECT_C2,
});
check_in("setup: Alice creates task_c2 in project_c2", s, [200, 201]);
const TASK_C2 = task_c2.id;

// trash the CHILD first — trashing the project first, then the child, risks nothing
// here (trash never cascadeDeletes), but the child-first order matches the purge
// traversal precedent (T5) and keeps this scenario robust if that ever changes.
[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_C2}`, alice);
check("setup: Alice traps task_c2 to trash (204, child trashed BEFORE parent)", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C2}`, alice);
check("setup: Alice traps project_c2 to trash (204)", s, 204);

[s, body] = await api("PATCH", `/api/collections/tasks/records/${TASK_C2}`, alice, { trashed: "" });
check(
  "T13: restore task_c2 while parent project_c2 is trashed -> 400 (restore-conflict guard)",
  s,
  400,
);
check(
  "T13: 400 reason mentions the parent project",
  (body.message ?? "").includes("parent project"),
  true,
);
// the "project missing" sub-case (dangling relation) is unreachable: cascadeDelete
// purges the child alongside a hard-deleted project, so the class collapses to
// "project trashed" — only that path is exercised here.

[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_C2}`, su);
check("cleanup: superuser hard-deletes task_c2", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C2}`, su);
check("cleanup: superuser hard-deletes project_c2", s, 204);

// COVERS: hook:trash.pb.js#onRecordUpdateRequest:decisions
console.log(
  "\n── T14: restore-conflict guard also refuses restore for decisions (cheap second collection) ──",
);
let proj_c3: any;
[s, proj_c3] = await api("POST", "/api/collections/projects/records", alice, {
  name: "trash-test: project_c3 (restore-guard, decisions)",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Alice creates project_c3", s, [200, 201]);
const PROJECT_C3 = proj_c3.id;
let dec_c3: any;
[s, dec_c3] = await api("POST", "/api/collections/decisions/records", alice, {
  title: "trash-test: decision_c3 (restore-guard)",
  workspace: ALICE_WORKSPACE,
  project: PROJECT_C3,
});
check_in("setup: Alice creates decision_c3 in project_c3", s, [200, 201]);
const DECISION_C3 = dec_c3.id;

[s] = await api("DELETE", `/api/collections/decisions/records/${DECISION_C3}`, alice);
check("setup: Alice traps decision_c3 to trash (204, child trashed BEFORE parent)", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C3}`, alice);
check("setup: Alice traps project_c3 to trash (204)", s, 204);

[s, body] = await api("PATCH", `/api/collections/decisions/records/${DECISION_C3}`, alice, {
  trashed: "",
});
check(
  "T14: restore decision_c3 while parent project_c3 is trashed -> 400 (restore-conflict guard)",
  s,
  400,
);
check(
  "T14: 400 reason mentions the parent project (decisions)",
  (body.message ?? "").includes("parent project"),
  true,
);

[s] = await api("DELETE", `/api/collections/decisions/records/${DECISION_C3}`, su);
check("cleanup: superuser hard-deletes decision_c3", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C3}`, su);
check("cleanup: superuser hard-deletes project_c3", s, 204);

// COVERS: hook:trash.pb.js#onRecordUpdateRequest:documents
console.log("\n── T15: restore-conflict guard also refuses restore for documents ──");
let proj_c4: any;
[s, proj_c4] = await api("POST", "/api/collections/projects/records", alice, {
  name: "trash-test: project_c4 (restore-guard, documents)",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Alice creates project_c4", s, [200, 201]);
const PROJECT_C4 = proj_c4.id;
let doc_c4: any;
[s, doc_c4] = await api("POST", "/api/collections/documents/records", alice, {
  title: "trash-test: document_c4 (restore-guard)",
  workspace: ALICE_WORKSPACE,
  project: PROJECT_C4,
});
check_in("setup: Alice creates document_c4 in project_c4", s, [200, 201]);
const DOCUMENT_C4 = doc_c4.id;

[s] = await api("DELETE", `/api/collections/documents/records/${DOCUMENT_C4}`, alice);
check("setup: Alice traps document_c4 to trash (204, child trashed BEFORE parent)", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C4}`, alice);
check("setup: Alice traps project_c4 to trash (204)", s, 204);

[s, body] = await api("PATCH", `/api/collections/documents/records/${DOCUMENT_C4}`, alice, {
  trashed: "",
});
check(
  "T15: restore document_c4 while parent project_c4 is trashed -> 400 (restore-conflict guard)",
  s,
  400,
);
check(
  "T15: 400 reason mentions the parent project (documents)",
  (body.message ?? "").includes("parent project"),
  true,
);

[s] = await api("DELETE", `/api/collections/documents/records/${DOCUMENT_C4}`, su);
check("cleanup: superuser hard-deletes document_c4", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C4}`, su);
check("cleanup: superuser hard-deletes project_c4", s, 204);

// COVERS: hook:trash.pb.js#onRecordUpdateRequest:milestones
console.log("\n── T16: restore-conflict guard also refuses restore for milestones ──");
let proj_c5: any;
[s, proj_c5] = await api("POST", "/api/collections/projects/records", alice, {
  name: "trash-test: project_c5 (restore-guard, milestones)",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Alice creates project_c5", s, [200, 201]);
const PROJECT_C5 = proj_c5.id;
// milestones.project is required (projTrashReq) — every milestone has a parent project.
let mile_c5: any;
[s, mile_c5] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "trash-test: milestone_c5 (restore-guard)",
  workspace: ALICE_WORKSPACE,
  project: PROJECT_C5,
});
check_in("setup: Alice creates milestone_c5 in project_c5", s, [200, 201]);
const MILESTONE_C5 = mile_c5.id;

[s] = await api("DELETE", `/api/collections/milestones/records/${MILESTONE_C5}`, alice);
check("setup: Alice traps milestone_c5 to trash (204, child trashed BEFORE parent)", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C5}`, alice);
check("setup: Alice traps project_c5 to trash (204)", s, 204);

[s, body] = await api("PATCH", `/api/collections/milestones/records/${MILESTONE_C5}`, alice, {
  trashed: "",
});
check(
  "T16: restore milestone_c5 while parent project_c5 is trashed -> 400 (restore-conflict guard)",
  s,
  400,
);
check(
  "T16: 400 reason mentions the parent project (milestones)",
  (body.message ?? "").includes("parent project"),
  true,
);

[s] = await api("DELETE", `/api/collections/milestones/records/${MILESTONE_C5}`, su);
check("cleanup: superuser hard-deletes milestone_c5", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_C5}`, su);
check("cleanup: superuser hard-deletes project_c5", s, 204);

// COVERS: hook:trash.pb.js#onRecordCreateRequest:tasks
// COVERS: hook:trash.pb.js#onRecordCreateRequest:decisions
// COVERS: hook:trash.pb.js#onRecordCreateRequest:documents
// COVERS: hook:trash.pb.js#onRecordCreateRequest:milestones
// COVERS: hook:trash.pb.js#onRecordCreateRequest:projects
// COVERS: hook:trash.pb.js#onRecordCreateRequest:workspaces
console.log(
  "\n── T17: create-side trash guard — born-trashed / spoofed trashed_by neutralized (PBTT-339) ──",
);
// trashed/trashed_by are set ONLY by the DELETE path; a member create that submits
// them must be cleared, else a member could bypass the trash flow or frame another user.
let born_task: any;
[s, born_task] = await api("POST", "/api/collections/tasks/records", bob, {
  title: "trash-test: T17 born-trashed task",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
  trashed: now_ts(),
  trashed_by: alice_id,
});
check_in("setup: Bob (member) creates a task with trashed + trashed_by set", s, [200, 201]);
const T17_TASK = born_task.id;
LEFTOVER_TASKS.push(T17_TASK);
[s, row] = await api("GET", `/api/collections/tasks/records/${T17_TASK}`, su);
check(
  "T17: born-trashed task -> trashed cleared server-side (stored '')",
  row.trashed ?? "<x>",
  "",
);
check(
  "T17: spoofed trashed_by on task create -> cleared server-side (stored '')",
  row.trashed_by ?? "<x>",
  "",
);
[s, present] = await list_has("tasks", T17_TASK, bob);
check(
  "T17: the create is live, not born-trashed (present in the LIST surface)",
  tup(s, present),
  tup(200, true),
);

let born_dec: any;
[s, born_dec] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "trash-test: T17 born-trashed decision",
  workspace: ALICE_WORKSPACE,
  trashed: now_ts(),
  trashed_by: alice_id,
});
check_in("setup: Bob (member) creates a decision with trashed + trashed_by set", s, [200, 201]);
const T17_DEC = born_dec.id;
[s, row] = await api("GET", `/api/collections/decisions/records/${T17_DEC}`, su);
check(
  "T17: born-trashed decision -> trashed cleared server-side (stored '')",
  row.trashed ?? "<x>",
  "",
);
check(
  "T17: spoofed trashed_by on decision create -> cleared server-side (stored '')",
  row.trashed_by ?? "<x>",
  "",
);
[s] = await api("DELETE", `/api/collections/decisions/records/${T17_DEC}`, su);
check("cleanup: superuser hard-deletes T17 decision fixture", s, 204);

// The remaining trashed_by-bearing item collections (documents/milestones): same guard.
for (const [coll, body0] of [
  ["documents", { title: "trash-test: T17 born-trashed document", workspace: ALICE_WORKSPACE }],
  [
    "milestones",
    {
      name: "trash-test: T17 born-trashed milestone",
      workspace: ALICE_WORKSPACE,
      project: ALICE_PROJECT,
    },
  ],
] as [string, any][]) {
  body = { ...body0, trashed: now_ts(), trashed_by: alice_id };
  let rec: any;
  [s, rec] = await api("POST", `/api/collections/${coll}/records`, bob, body);
  check_in(
    `setup: Bob (member) creates a ${coll.slice(0, -1)} with trashed + trashed_by set`,
    s,
    [200, 201],
  );
  [s, row] = await api("GET", `/api/collections/${coll}/records/${rec.id}`, su);
  check(
    `T17: born-trashed ${coll.slice(0, -1)} -> trashed cleared server-side (stored '')`,
    row.trashed ?? "<x>",
    "",
  );
  check(
    `T17: spoofed trashed_by on ${coll.slice(0, -1)} create -> cleared server-side (stored '')`,
    row.trashed_by ?? "<x>",
    "",
  );
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rec.id}`, su);
  check(`cleanup: superuser hard-deletes T17 ${coll.slice(0, -1)} fixture`, s, 204);
}

// projects/workspaces carry `trashed` but NO trashed_by field — guard clears only trashed.
let born_proj: any;
[s, born_proj] = await api("POST", "/api/collections/projects/records", bob, {
  name: "trash-test: T17 born-trashed project",
  owner: bob_id,
  workspace: ALICE_WORKSPACE,
  trashed: now_ts(),
});
check_in("setup: Bob (member) creates a project with trashed set", s, [200, 201]);
const T17_PROJ = born_proj.id;
[s, row] = await api("GET", `/api/collections/projects/records/${T17_PROJ}`, su);
check(
  "T17: born-trashed project -> trashed cleared server-side (stored '')",
  row.trashed ?? "<x>",
  "",
);
[s] = await api("DELETE", `/api/collections/projects/records/${T17_PROJ}`, su);
check("cleanup: superuser hard-deletes T17 project fixture", s, 204);

// Bob creates a workspace he owns (workspaces.createRule = owner-self); guard clears trashed.
let born_ws: any;
[s, born_ws] = await api("POST", "/api/collections/workspaces/records", bob, {
  name: "trash-test: T17 born-trashed workspace",
  owner: bob_id,
  trashed: now_ts(),
});
check_in("setup: Bob creates a workspace he owns with trashed set", s, [200, 201]);
const T17_WS = born_ws.id;
[s, row] = await api("GET", `/api/collections/workspaces/records/${T17_WS}`, su);
check(
  "T17: born-trashed workspace -> trashed cleared server-side (stored '')",
  row.trashed ?? "<x>",
  "",
);
[s] = await api("DELETE", `/api/collections/workspaces/records/${T17_WS}`, su);
check("cleanup: superuser hard-deletes T17 workspace fixture", s, 204);

// COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:decisions
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:documents
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:milestones
console.log("\n── T18: trash broadcasts re-check membership at DELIVERY (PBTT-484) ──");
// The four inlined trash-SET broadcasts sent to every subscriber of the workspace topic, so a
// member suspended mid-stream kept receiving rows they already 404 on. Two controls on the same
// channel keep a zero-delivery result honest: an ACTIVE member and the workspace OWNER.

class SSEListener extends roomkit.SSEListener {
  constructor(token: string, topic: string) {
    // This suite's stream sits idle across the whole purge sweep, so one read blocks
    // far longer here than in the sibling realtime suites.
    super(PB, token, topic, 120);
  }

  trash_events(collection: string): any[] {
    return this.events.filter(
      (e) =>
        e.collection === collection &&
        e.action === "update" &&
        (e.rawChangedFields || []).includes("trashed"),
    );
  }
}

const grace_email = `trash-grace-${token_hex(4)}@example.com`;
const grace_id = await su_create_user("Grace", grace_email);
THROWAWAY_USERS.push(grace_id);
const [grace] = await login(grace_email);
let grace_row: any;
[s, grace_row] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: grace_id,
  role: "member",
  status: "active",
});
check_in("setup: Grace added to Alice's workspace as an ACTIVE member", s, [200, 201]);
const GRACE_ROW = grace_row.id;

const TOPIC = `rt:project_items:${ALICE_WORKSPACE}`;
const listeners: Record<string, SSEListener> = {
  "Grace (suspended mid-stream)": new SSEListener(grace, TOPIC),
  "Bob (active member)": new SSEListener(bob, TOPIC),
  "Alice (workspace owner)": new SSEListener(alice, TOPIC),
};
for (const [who, listener] of Object.entries(listeners)) {
  check(
    `setup: ${who} opened a realtime stream on the workspace topic`,
    truthy(await listener.start()),
    true,
  );
}
await Bun.sleep(1000); // let the authorize POSTs land before the first write

const T18_ITEMS: Record<string, string> = {};
for (const [coll, body0] of [
  ["tasks", { title: "T18 rt task", status: ALICE_TODO_STATUS, project: ALICE_PROJECT }],
  ["decisions", { title: "T18 rt decision", workspace: ALICE_WORKSPACE }],
  ["documents", { title: "T18 rt document", workspace: ALICE_WORKSPACE }],
  ["milestones", { name: "T18 rt milestone", workspace: ALICE_WORKSPACE, project: ALICE_PROJECT }],
] as [string, any][]) {
  let made: any;
  [s, made] = await api("POST", `/api/collections/${coll}/records`, alice, body0);
  check_in(`setup: Alice creates the ${coll.slice(0, -1)} T18 will trash`, s, [200, 201]);
  T18_ITEMS[coll] = made.id;
}
await Bun.sleep(1500);
// Grace is still ACTIVE here: without this the zero below could just mean a dead listener.
const grace_live = listeners["Grace (suspended mid-stream)"]!.events.length;
check("control: Grace receives the workspace's events while ACTIVE", grace_live > 0, true);

[s, row] = await api("PATCH", `/api/collections/workspace_members/records/${GRACE_ROW}`, su, {
  status: "suspended",
});
check(
  "T18: Grace suspended MID-SUBSCRIPTION (her stream left open)",
  tup(s, row.status),
  tup(200, "suspended"),
);

for (const [coll, rid] of Object.entries(T18_ITEMS)) {
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
  check(`T18: Alice soft-trashes the ${coll.slice(0, -1)} (204)`, s, 204);
}
await Bun.sleep(2000);

for (const coll of Object.keys(T18_ITEMS)) {
  check(
    `T18: SUSPENDED Grace receives NO trash broadcast for the ${coll.slice(0, -1)}`,
    listeners["Grace (suspended mid-stream)"]!.trash_events(coll).length,
    0,
  );
  for (const who of ["Bob (active member)", "Alice (workspace owner)"]) {
    check(
      `T18: ${who} still receives the ${coll.slice(0, -1)} trash broadcast`,
      listeners[who]!.trash_events(coll).length,
      1,
    );
  }
}
check(
  "T18: Grace's LIVE stream stopped at suspension (no event of any kind since)",
  listeners["Grace (suspended mid-stream)"]!.events.length,
  grace_live,
);

// COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:decisions
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:documents
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:milestones
console.log("\n── T18b: soft-trashing a row ALREADY hidden by its project broadcasts nothing ──");
// The envelope carries the whole record, and a row inside a trashed project is 404 for every
// recipient before AND after the trash-set — hidden -> hidden is no transition. T18's four
// 1-event results above are this block's control: the live -> trashed hide still broadcasts.
let t18b_proj: any;
[s, t18b_proj] = await api("POST", "/api/collections/projects/records", alice, {
  name: "T18b trashed project",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Alice creates the project T18b will trash", s, [200, 201]);
const T18B_PROJECT = t18b_proj.id;
const T18B_ITEMS: Record<string, string> = {};
for (const [coll, body0] of [
  ["tasks", { title: "T18b rt task", status: ALICE_TODO_STATUS, project: T18B_PROJECT }],
  ["decisions", { title: "T18b rt decision", workspace: ALICE_WORKSPACE, project: T18B_PROJECT }],
  ["documents", { title: "T18b rt document", workspace: ALICE_WORKSPACE, project: T18B_PROJECT }],
  ["milestones", { name: "T18b rt milestone", workspace: ALICE_WORKSPACE, project: T18B_PROJECT }],
] as [string, any][]) {
  let made: any;
  [s, made] = await api("POST", `/api/collections/${coll}/records`, alice, body0);
  check_in(`setup: Alice creates the ${coll.slice(0, -1)} T18b will trash`, s, [200, 201]);
  T18B_ITEMS[coll] = made.id;
}
[s] = await api("DELETE", `/api/collections/projects/records/${T18B_PROJECT}`, alice);
check("T18b setup: Alice trashes the project, hiding all four rows (204)", s, 204);
check(
  "T18b setup: Bob (member) 404s one of them on both read surfaces",
  tup(
    (await api("GET", `/api/collections/tasks/records/${T18B_ITEMS.tasks}`, bob))[0],
    (await api("GET", `/api/collections/project_items/records/${T18B_ITEMS.tasks}`, bob))[0],
  ),
  tup(404, 404),
);
await Bun.sleep(1500);
const marks: Record<string, number> = {};
for (const [who, listener] of Object.entries(listeners)) marks[who] = listener.events.length;
for (const [coll, rid] of Object.entries(T18B_ITEMS)) {
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
  check(`T18b: Alice soft-trashes the already-hidden ${coll.slice(0, -1)} (204)`, s, 204);
}
await Bun.sleep(2000);
for (const who of ["Bob (active member)", "Alice (workspace owner)"]) {
  const listener = listeners[who]!;
  const t18b_ids = new Set(Object.values(T18B_ITEMS));
  check(
    `T18b: ${who} receives NO envelope for any of the four hidden rows`,
    listener.events
      .slice(marks[who])
      .map((e) => e.id)
      .filter((id) => t18b_ids.has(id))
      .sort(by_code_point),
    [],
  );
  check(
    // only the window after the project was trashed: the four rows WERE live when they
    // were created, so their create envelopes were owed and are not part of this claim.
    `T18b: …and no envelope carrying their titles reached ${who} after the hide`,
    listener.events.slice(marks[who]).filter((e) => json_dumps(e).includes("T18b rt ")).length,
    0,
  );
}

for (const listener of Object.values(listeners)) {
  listener.stop = true;
}
for (const [coll, rid] of Object.entries(T18_ITEMS)) {
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, su);
  check(`cleanup: superuser hard-deletes the trashed T18 ${coll.slice(0, -1)}`, s, 204);
}
[s] = await api("DELETE", `/api/collections/projects/records/${T18B_PROJECT}`, su);
check("cleanup: superuser hard-deletes the T18b project (cascades its four rows)", s, 204);

// COVERS: route:GET /api/tracker/summary
console.log(
  "\n── T19: GET /api/tracker/summary excludes trashed tasks and trashed-project tasks ──",
);
let base: any;
[s, base] = await api("GET", "/api/tracker/summary", alice);
check("T19 setup: baseline summary read (200)", s, 200);
const [BASE_TOTAL, BASE_ASSIGNED] = [base.total, base.assignedToMe];

let task_s1: any;
[s, task_s1] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_s1 (T19)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
  assignee: alice_id,
});
check_in("setup: Alice creates task_s1 assigned to herself", s, [200, 201]);
const TASK_S1 = task_s1.id;

[s, r] = await api("GET", "/api/tracker/summary", alice);
check("T19: total counts the live task_s1", r.total, BASE_TOTAL + 1);
check("T19: assignedToMe counts the live task_s1", r.assignedToMe, BASE_ASSIGNED + 1);

[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_S1}`, alice);
check("setup: Alice traps task_s1 to trash (204)", s, 204);
[s, r] = await api("GET", "/api/tracker/summary", alice);
check("T19: total drops when task_s1 is trashed", r.total, BASE_TOTAL);
check("T19: assignedToMe drops when task_s1 is trashed", r.assignedToMe, BASE_ASSIGNED);

[s] = await api("PATCH", `/api/collections/tasks/records/${TASK_S1}`, alice, { trashed: "" });
check("T19: restore task_s1 (trashed='')", s, 200);
[s, r] = await api("GET", "/api/tracker/summary", alice);
check("T19: total returns after restore", r.total, BASE_TOTAL + 1);
check("T19: assignedToMe returns after restore", r.assignedToMe, BASE_ASSIGNED + 1);

let proj_s2: any;
[s, proj_s2] = await api("POST", "/api/collections/projects/records", alice, {
  name: "trash-test: project_s2 (T19)",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Alice creates project_s2", s, [200, 201]);
const PROJECT_S2 = proj_s2.id;
let task_s2: any;
[s, task_s2] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: task_s2 (T19)",
  status: ALICE_TODO_STATUS,
  project: PROJECT_S2,
  assignee: alice_id,
});
check_in("setup: Alice creates task_s2 in project_s2, assigned to herself", s, [200, 201]);
const TASK_S2 = task_s2.id;

[s, r] = await api("GET", "/api/tracker/summary", alice);
check("T19: total counts both live tasks", r.total, BASE_TOTAL + 2);
check("T19: assignedToMe counts both live tasks", r.assignedToMe, BASE_ASSIGNED + 2);

[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_S2}`, alice);
check("setup: Alice traps project_s2 to trash (204, task_s2 itself stays live)", s, 204);
[s, r] = await api("GET", "/api/tracker/summary", alice);
check(
  "T19: total excludes task_s2 via trashed PARENT project (traversal)",
  r.total,
  BASE_TOTAL + 1,
);
check(
  "T19: assignedToMe excludes task_s2 via trashed PARENT project (traversal)",
  r.assignedToMe,
  BASE_ASSIGNED + 1,
);

[s] = await api("DELETE", `/api/collections/tasks/records/${TASK_S1}`, su);
check("cleanup: superuser hard-deletes task_s1", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_S2}`, su);
check("cleanup: superuser hard-deletes project_s2 (cascades task_s2)", s, 204);

// COVERS: route:GET /api/tracker/trash
console.log(
  "\n── T20: GET /api/tracker/trash counts and pages past 500 rows of one kind (planted 501) ──",
);

/**
 * 501 rows via /api/batch (settings: batch.maxRequests=50) — far fewer round trips
 * than one POST per row. `token` must be the superuser: 501+501 sub-requests blow past
 * the general 300/60s API rate limit that gates a regular authenticated user (superusers
 * are exempt, v1:1785150000_settings.js). Returns the created ids in request order.
 */
async function batch_create(
  coll: string,
  bodies: any[],
  token: string,
  chunk = 50,
): Promise<string[]> {
  const url = `/api/collections/${coll}/records`;
  const ids: string[] = [];
  for (let i = 0; i < bodies.length; i += chunk) {
    const part = bodies.slice(i, i + chunk);
    const reqs = part.map((b) => ({ method: "POST", url: url, body: b }));
    const [s, resp] = await api("POST", "/api/batch", token, { requests: reqs });
    check_in(`T20: batch create ${coll} [${i}:${i + part.length}] -> 200`, s, [200]);
    for (const item of Array.isArray(resp) ? resp : []) {
      check_in(`T20: batch create ${coll} item -> 200/201`, item.status, [200, 201]);
      ids.push((item.body || {}).id);
    }
  }
  return ids;
}

async function batch_patch(
  coll: string,
  ids: string[],
  body: any,
  token: string,
  chunk = 50,
): Promise<void> {
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const reqs = part.map((rid) => ({
      method: "PATCH",
      url: `/api/collections/${coll}/records/${rid}`,
      body: body,
    }));
    const [s, resp] = await api("POST", "/api/batch", token, { requests: reqs });
    check_in(`T20: batch patch ${coll} [${i}:${i + part.length}] -> 200`, s, [200]);
    for (const item of Array.isArray(resp) ? resp : []) {
      check_in(`T20: batch patch ${coll} item -> 200`, item.status, [200]);
    }
  }
}

const zara_email = `trash-zara-${token_hex(4)}@example.com`;
const zara_id = await su_create_user("Zara", zara_email);
THROWAWAY_USERS.push(zara_id);
const [zara] = await login(zara_email);
const ZARA_WS = (await find_id("workspaces", "owner", zara_id, su))!;
check("T20 setup: resolved Zara's auto-provisioned workspace", truthy(ZARA_WS), true);

// PB aborts a whole batch as a bare 400 once it runs past batch.timeout (v1:1785150000_settings.js),
// which a loaded host crosses at 50 creates; the bulk fixture is not what T20 proves.
let settings: any;
[, settings] = await api("GET", "/api/settings", su);
const BATCH_TIMEOUT = settings.batch.timeout;
[s] = await api("PATCH", "/api/settings", su, { batch: { timeout: 60 } });
check("T20 setup: fixture batch timeout raised -> 200", s, 200);

const zara_task_ids = await batch_create(
  "tasks",
  Array.from({ length: 501 }, (_, i) => ({
    title: `trash501 zara ${String(i).padStart(4, "0")}`,
    workspace: ZARA_WS,
  })),
  su,
);
check("T20 setup: 501 zara tasks created", zara_task_ids.length, 501);

// Every zara task shares ONE trashed stamp, so only the route's id tiebreak can make paging a
// total order. Writes ride the superuser (rate limit); the READ rides Zara's own token — the
// route scopes by e.auth. Trash 3 first to prove the first proof is not a tautology.
const ZARA_TRASHED = past_ts(1);
await batch_patch("tasks", zara_task_ids.slice(0, 3), { trashed: ZARA_TRASHED }, su);
[s, body] = await api("GET", trash_q(ZARA_WS), zara);
check("T20: GET trash (3 planted) -> 200", s, 200);
check("T20: count == 3", body.count, 3);
check("T20: the response carries no truncated field (nothing is cut)", "truncated" in body, false);

await batch_patch("tasks", zara_task_ids.slice(3), { trashed: ZARA_TRASHED }, su);
[s] = await api("PATCH", "/api/settings", su, { batch: { timeout: BATCH_TIMEOUT } });
check("T20 cleanup: batch timeout restored -> 200", s, 200);
qs = urlencode({ filter: `workspace='${esc(ZARA_WS)}' && trashed != ''`, perPage: "1" });
let count_body: any;
[s, count_body] = await api("GET", `/api/collections/tasks/records?${qs}`, su);
check(
  "T20: superuser totalItems confirms all 501 zara tasks landed trashed",
  count_body.totalItems,
  501,
);

// Two decisions trashed NOW, i.e. after the tasks' day-old stamp: the -trashed order's head.
const zara_dec_ids: string[] = [];
for (const t of ["trash-test: zara decision a", "trash-test: zara decision b"]) {
  [s, r] = await api("POST", "/api/collections/decisions/records", zara, {
    title: t,
    workspace: ZARA_WS,
  });
  check_in(`T20 setup: Zara creates ${t}`, s, [200, 201]);
  zara_dec_ids.push(r.id);
  [s] = await api("DELETE", `/api/collections/decisions/records/${r.id}`, zara);
  check(`T20 setup: Zara trashes ${t} (204)`, s, 204);
}
const ZARA_TOTAL = 503;

[s, body] = await api("GET", trash_q(ZARA_WS), zara);
check("T20: GET trash (501 tasks + 2 decisions trashed) -> 200", s, 200);
check("T20: count is the true total, never capped at 500", body.count, ZARA_TOTAL);
check("T20: default page is 1", body.page, 1);
check("T20: default perPage is 500", body.perPage, 500);
check("T20: page 1 serves perPage rows", (body.items || []).length, 500);
check(
  "T20: default -trashed order puts the two later-trashed decisions first",
  (body.items || []).slice(0, 2).map((it: any) => it.collection),
  ["decisions", "decisions"],
);

// Walk every page at a small perPage: pages must be disjoint and their union the full set.
const PER = 37;
const LAST = Math.ceil(ZARA_TOTAL / PER);
const walked = new Set<string>();
let served = 0;
let echo_ok = true;
for (let page = 1; page <= LAST + 1; page++) {
  [s, body] = await api("GET", trash_q(ZARA_WS, { perPage: PER, page }), zara);
  if (s !== 200 || body.count !== ZARA_TOTAL || body.page !== page || body.perPage !== PER)
    echo_ok = false;
  const its = body.items || [];
  if (its.length !== (page < LAST ? PER : page === LAST ? ZARA_TOTAL - PER * (LAST - 1) : 0))
    echo_ok = false;
  for (const it of its) {
    walked.add(pair(it.collection, (it.record || {}).id));
    served++;
  }
}
check("T20: every page -> 200, count 503, echoes page/perPage, right length", echo_ok, true);
check("T20: pages are disjoint (rows served == distinct rows)", served, walked.size);
check("T20: union of pages is the full trashed set", walked.size, ZARA_TOTAL);
check(
  "T20: union of pages holds every trashed zara task and decision",
  zara_task_ids.every((id) => walked.has(pair("tasks", id))) &&
    zara_dec_ids.every((id) => walked.has(pair("decisions", id))),
  true,
);

[s, body] = await api("GET", trash_q(ZARA_WS, { perPage: 1000 }), zara);
check(
  "T20: perPage above 500 clamps to 500",
  tup(s, body.perPage, (body.items || []).length),
  tup(200, 500, 500),
);
[s, body] = await api("GET", trash_q(ZARA_WS, { perPage: 0 }), zara);
check(
  "T20: perPage below 1 clamps to 1",
  tup(s, body.perPage, (body.items || []).length),
  tup(200, 1, 1),
);

console.log("\n── T22: trash route filters, sorts, groups and dates in PocketBase ──");
// COVERS: route:GET /api/tracker/trash
[s, body] = await api("GET", trash_q(ZARA_WS, { filter: 'type = "decision"' }), zara);
check('T22: filter type = "decision" -> 200', s, 200);
check('T22: filter type = "decision" counts the two decisions', body.count, 2);
check(
  'T22: filter type = "decision" serves decisions only',
  (body.items || []).map((it: any) => it.collection),
  ["decisions", "decisions"],
);
[s, body] = await api("GET", trash_q(ZARA_WS, { filter: 'title ~ "0007"' }), zara);
check(
  'T22: filter title ~ "0007" -> exactly zara task 0007',
  tup(
    s,
    body.count,
    (body.items || []).map((it: any) => it.record.id),
  ),
  tup(200, 1, [zara_task_ids[7]]),
);
const titles_of = (b: any): string[] => (b.items || []).map((it: any) => it.record.title);
[s, body] = await api(
  "GET",
  trash_q(ZARA_WS, { filter: 'type = "task"', sort: "title", perPage: 3 }),
  zara,
);
check(
  "T22: sort=title ascends",
  tup(s, body.count, titles_of(body)),
  tup(200, 501, ["trash501 zara 0000", "trash501 zara 0001", "trash501 zara 0002"]),
);
[s, body] = await api(
  "GET",
  trash_q(ZARA_WS, { filter: 'type = "task"', sort: "-title", perPage: 3 }),
  zara,
);
check("T22: sort=-title descends", titles_of(body), [
  "trash501 zara 0500",
  "trash501 zara 0499",
  "trash501 zara 0498",
]);
[s, body] = await api("GET", trash_q(ZARA_WS, { sort: "trashed", perPage: 1 }), zara);
check(
  "T22: sort=trashed puts a day-old task first",
  tup(s, (body.items || [])[0]?.collection),
  tup(200, "tasks"),
);
[s, body] = await api("GET", trash_q(ZARA_WS, { sort: "-trashed", perPage: 2 }), zara);
check(
  "T22: sort=-trashed puts the just-trashed decisions first",
  (body.items || []).map((it: any) => it.collection),
  ["decisions", "decisions"],
);

for (const [label, filter] of [
  ["@request.auth.id", '@request.auth.id != ""'],
  ["a dotted path (a.b)", 'workspace.owner = "x"'],
  ["a {: bound parameter", "workspace = {:w}"],
  ["a // comment", 'title = "x" // c'],
  ["an unbalanced paren", '(title = "x"'],
  ["an unterminated quote", 'title = "x'],
  ["more than 3500 characters", `title = "${"x".repeat(3500)}"`],
]) {
  [s] = await api("GET", trash_q(ZARA_WS, { filter }), zara);
  check(`T22: a filter carrying ${label} is refused 400`, s, 400);
}
for (const sort of ["title;drop", "-title,", "workspace.owner", "@request.auth.id", "title desc"]) {
  [s] = await api("GET", trash_q(ZARA_WS, { sort }), zara);
  check(`T22: sort=${JSON.stringify(sort)} is refused 400`, s, 400);
}
[s] = await api("GET", trash_q(ZARA_WS, { filter: 'nope = "x"' }), zara);
check("T22: a filter on an unknown column is refused 400", s, 400);
[s] = await api("GET", trash_q(ZARA_WS, { sort: "nope" }), zara);
check("T22: a sort on an unknown column is refused 400", s, 400);

[s, body] = await api("GET", trash_q(ZARA_WS, { group: "status" }), zara);
check("T22: group=status -> 200", s, 200);
check("T22: group=status total equals the trash count", body.total, ZARA_TOTAL);
check(
  "T22: group=status buckets sum to the total",
  (body.items || []).reduce((n: number, it: any) => n + it.count, 0),
  ZARA_TOTAL,
);
[s, body] = await api(
  "GET",
  trash_q(ZARA_WS, { group: "project", filter: 'type = "decision"' }),
  zara,
);
check("T22: group honours filter (decisions only -> total 2)", tup(s, body.total), tup(200, 2));
[s] = await api("GET", trash_q(ZARA_WS, { group: "bogus" }), zara);
check("T22: an unknown group is refused 400", s, 400);
[s] = await api("GET", trash_q(ZARA_WS, { group: "status" }), eve);
check("T22: a non-member's grouped read is still 403", s, 403);

// purge_at = trashed + retention, read from app_settings exactly as the sweep reads it.
const purge_of = (trashed: string, days: number): string =>
  new Date(Date.parse(trashed.replace(" ", "T")) + days * 86400000).toISOString().replace("T", " ");
const id_filter = `id = "${zara_dec_ids[0]}"`;
// T8 recreated the row under a new id, so it is resolved afresh here.
const RETENTION_ROW = await find_id("app_settings", "key", "trash_retention_days", su);
[s] = await api("PATCH", `/api/collections/app_settings/records/${RETENTION_ROW}`, su, {
  value: 7,
});
check("T22 setup: superuser sets trash_retention_days to 7", s, 200);
[s, body] = await api("GET", trash_q(ZARA_WS, { filter: id_filter }), zara);
let purge_item = (body.items || [])[0] ?? {};
check(
  "T22: purge_at is PB datetime format",
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z$/.test(purge_item.purge_at ?? ""),
  true,
);
check(
  "T22: purge_at = trashed + 7 days with retention set to 7",
  purge_item.purge_at,
  purge_of(purge_item.record?.trashed ?? "", 7),
);
[s] = await api("PATCH", `/api/collections/app_settings/records/${RETENTION_ROW}`, su, {
  value: 30,
});
check("cleanup: app_settings trash_retention_days restored to 30", s, 200);
[s, body] = await api("GET", trash_q(ZARA_WS, { filter: id_filter }), zara);
purge_item = (body.items || [])[0] ?? {};
check(
  "T22: purge_at = trashed + 30 days at the default retention",
  purge_item.purge_at,
  purge_of(purge_item.record?.trashed ?? "", 30),
);
[s, body] = await api("GET", trash_q(ZARA_WS, { filter: 'nope = "x"' }), zara);
check(
  "T22: the unknown-column 400 names no PocketBase internals",
  /GoError|unknown field|nope/.test(JSON.stringify(body)),
  false,
);

// Group parity: the same rows bucket identically live (counts route) and trashed (this route),
// a RETIRED priority included — it must land in the unset bucket on both sides.
let zws: any;
[s, zws] = await api("GET", `/api/collections/workspaces/records/${ZARA_WS}`, zara);
const zprio: any[] = zws.priorities || [];
check("T22 setup: Zara's workspace has at least three priorities", zprio.length >= 3, true);
const zlabels: string[] = [];
for (const name of ["parity-l1", "parity-l2"]) {
  [s, r] = await api("POST", "/api/collections/labels/records", zara, { name, workspace: ZARA_WS });
  check_in(`T22 setup: Zara creates label ${name}`, s, [200, 201]);
  zlabels.push(r.id);
}
const parity_tasks: string[] = [];
for (const [title, extra] of [
  ["parity t1", { priority: zprio[0]?.id, labels: [zlabels[0]], assignee: zara_id }],
  ["parity t2", { priority: zprio[1]?.id, labels: zlabels }],
  ["parity t3 retired", { priority: zprio[2]?.id, assignee: zara_id }],
  ["parity t4 bare", {}],
] as [string, Record<string, unknown>][]) {
  [s, r] = await api("POST", "/api/collections/tasks/records", zara, {
    title,
    workspace: ZARA_WS,
    ...extra,
  });
  check_in(`T22 setup: Zara creates ${title}`, s, [200, 201]);
  parity_tasks.push(r.id);
}
const retired = zprio[2]?.id;
[s] = await api("PATCH", `/api/collections/workspaces/records/${ZARA_WS}`, zara, {
  priorities: zprio.filter((p: any) => p.id !== retired),
});
check("T22 setup: Zara retires the priority parity t3 carries", s, 200);
const PARITY = 'title ~ "parity"';
const sorted_buckets = (b: any): string =>
  JSON.stringify(
    (b.items || [])
      .map((it: any) => [it.key, it.count])
      .sort((x: any, y: any) => String(x[0]).localeCompare(String(y[0]))),
  );
const live: Record<string, string> = {};
for (const group of ["priority", "label", "assignee"]) {
  [s, body] = await api(
    "GET",
    `/api/tracker/project-items/counts?${urlencode({ group, filter: `workspace = "${ZARA_WS}" && ${PARITY}` })}`,
    zara,
  );
  check(
    `T22 setup: counts route group=${group} over the live parity rows -> 200, total 4`,
    tup(s, body.total),
    tup(200, 4),
  );
  live[group] = sorted_buckets(body);
}
for (const tid of parity_tasks) {
  [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, zara);
  check("T22 setup: Zara trashes a parity task (204)", s, 204);
}
for (const group of ["priority", "label", "assignee"]) {
  [s, body] = await api("GET", trash_q(ZARA_WS, { group, filter: PARITY }), zara);
  check(
    `T22: trash group=${group} buckets equal the counts route's on the same rows`,
    tup(s, sorted_buckets(body)),
    tup(200, live[group]),
  );
  if (group === "priority")
    check(
      "T22: the retired priority and the unset one share the none bucket",
      (body.items || []).find((it: any) => it.key === "none")?.count,
      2,
    );
}

// R1 (owner ruling, collection:tasks): a relation field keeps a hidden target's raw id;
// expand omits the entry, never the id — mutation-proven by removing this section.
console.log(
  "\n── T21: R1 — a relation field keeps a hidden record's id; expand omits it, not the id ──",
);
let r1_parent: any;
[s, r1_parent] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: T21 r1 parent",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("setup: Alice creates T21 parent task", s, [200, 201]);
const T21_PARENT = r1_parent.id;
LEFTOVER_TASKS.push(T21_PARENT);

let r1_child: any;
[s, r1_child] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "trash-test: T21 r1 child",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
  parent: T21_PARENT,
});
check_in("setup: Alice creates T21 child task with parent = T21 parent", s, [200, 201]);
const T21_CHILD = r1_child.id;
LEFTOVER_TASKS.push(T21_CHILD);

[s, row] = await api("GET", `/api/collections/tasks/records/${T21_CHILD}?expand=parent`, bob);
check("T21 sanity: Bob (member) reads child while parent is live -> 200", s, 200);
check("T21 sanity: parent id present while live", row.parent, T21_PARENT);
check(
  "T21 sanity: expand.parent resolves while the parent is live",
  ((row.expand || {}).parent ?? {}).id,
  T21_PARENT,
);

[s] = await api("DELETE", `/api/collections/tasks/records/${T21_PARENT}`, alice);
check(
  "setup: Alice (owner) traps T21 parent to trash — a superuser DELETE always hard-purges (204)",
  s,
  204,
);

[s, row] = await api("GET", `/api/collections/tasks/records/${T21_CHILD}?expand=parent`, bob);
check("T21: child still readable — its own trashed state is untouched -> 200", s, 200);
check(
  "T21: parent id survives on the relation field (not stripped at the app tier)",
  row.parent,
  T21_PARENT,
);
check(
  "T21: expand omits the now-hidden parent (absent key, not an empty relation)",
  "parent" in (row.expand || {}),
  false,
);

console.log("\n── cleanup ──");
for (const tid of LEFTOVER_TASKS) {
  [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, su);
  check(`cleanup: superuser hard-deletes leftover task ${tid.slice(0, 8)}`, s, 204);
}
await carol_admin.done();
[s] = await api("DELETE", `/api/collections/workspace_members/records/${carol_admin.id}`, alice);
check("cleanup: Carol's admin membership removed (Carol is a non-member again)", s, 204);
for (const uid of THROWAWAY_USERS) {
  if (uid) {
    [s] = await api("DELETE", `/api/collections/users/records/${uid}`, su);
    check(`cleanup: superuser deletes throwaway user ${uid.slice(0, 8)}`, s, 204);
  }
}

await tierkit.verify_tiers();

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} FAILED: ${py_repr(FAILS)}`);
  process.exit(1);
}
console.log("✅ all trash-mechanism proofs passed");
process.exit(0);

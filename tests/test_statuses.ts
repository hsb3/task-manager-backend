#!/usr/bin/env bun
/**
 * E2E proof of the G1 (#74) first-class `statuses` collection: role-tiered CRUD,
 * the Linear-style six-category enum, the partial-unique is_default guard, the five
 * seeded non-triage defaults on provisioning, the cross-workspace status guard
 * on tasks, the completedAt lifecycle, and project_stats bucket math.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy (status hooks under test
 * live there), scripts/seed.ts fixtures. Port 8130 + PB_PORT_OFFSET — the 8100+ suite
 * self-boot band (.agents/rules/ports.md).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_get,
  py_repr,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8130 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(64)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

tierkit.use(api);

function esc(value: string): string {
  return value.replaceAll("'", "\\'");
}

async function find_by_filter(
  collection: string,
  filt: string,
  token: string | null = null,
  per_page = 200,
): Promise<any[]> {
  const qs = urlencode({ filter: filt, perPage: per_page });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return r.items || [];
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<string | null> {
  const items = await find_by_filter(collection, `${field}='${esc(value)}'`, token);
  return items.length ? getitem(items[0], "id") : null;
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!tok) throw new Error(`superuser auth failed: ${py_repr(r)}`);
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-statuses-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
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
  server = await start_server(DATA_DIR, MIG_DIR);
  const su = await superuser_token();

  console.log("\n── seed: alice/bob/carol fixtures (scripts/seed.ts) ──");
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
    console.log(seed_out);
    console.log(seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const [carol, carol_id] = await login("carol@example.com");

  let s: number;
  let r: any;
  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  const BOB_WS = await find_id("workspaces", "owner", bob_id, bob);
  const bob_statuses = await find_by_filter(
    "statuses",
    `(workspace='${BOB_WS}' && name='Todo')`,
    bob,
  );
  const BOB_TODO_STATUS = bob_statuses.length ? getitem(bob_statuses[0], "id") : null;
  check(
    "resolved Bob's OWN-workspace 'Todo' status (cross-ws fixture)",
    truthy(BOB_TODO_STATUS),
    true,
  );

  const alice_todo = await find_by_filter(
    "statuses",
    `(workspace='${ALICE_WS}' && name='Todo')`,
    alice,
  );
  const alice_done = await find_by_filter(
    "statuses",
    `(workspace='${ALICE_WS}' && name='Done')`,
    alice,
  );
  const ALICE_TODO = alice_todo.length ? getitem(alice_todo[0], "id") : null;
  const ALICE_DONE = alice_done.length ? getitem(alice_done[0], "id") : null;

  // ══════════════════ 1. CRUD × role matrix ══════════════════════════════════
  // COVERS: rule:statuses.create, rule:statuses.update, rule:statuses.delete, rule:statuses.list, rule:statuses.view
  console.log("\n── (1) OWNER (Alice): create/update/delete ──");
  let made: any;
  [s, made] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "Owner Status",
    category: "unstarted",
  });
  check("Alice (owner) creates a status", s, 200);
  const owner_status_id = made.id;
  [s, r] = await api("PATCH", `/api/collections/statuses/records/${owner_status_id}`, alice, {
    name: "Owner Status Renamed",
  });
  check("Alice (owner) renames it", s, 200);
  check("rename took effect", r.name, "Owner Status Renamed");
  [s] = await api("DELETE", `/api/collections/statuses/records/${owner_status_id}`, alice);
  check("Alice (owner) deletes it", s, 204);

  console.log("\n── (1) ADMIN (Bob promoted to admin): create/update/delete ──");
  await tierkit.actor_at_tier(ALICE_WS!, bob_id, "admin", alice, "Bob");
  [s, made] = await api("POST", "/api/collections/statuses/records", bob, {
    workspace: ALICE_WS,
    name: "Admin Status",
    category: "started",
  });
  check("Bob (admin) creates a status", s, 200);
  const admin_status_id = made.id;
  [s, r] = await api("PATCH", `/api/collections/statuses/records/${admin_status_id}`, bob, {
    name: "Admin Status Renamed",
  });
  check("Bob (admin) renames it", s, 200);
  [s] = await api("DELETE", `/api/collections/statuses/records/${admin_status_id}`, bob);
  check("Bob (admin) deletes it", s, 204);
  const bob_tier = await tierkit.actor_at_tier(ALICE_WS!, bob_id, "member", alice, "Bob");

  console.log("\n── (1) MEMBER (Bob, plain member): write denied, read allowed ──");
  let target: any;
  [s, target] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "Member Target Status",
    category: "unstarted",
  });
  check("(fixture) Alice creates a target status for Bob to probe", s, 200);
  const member_target_id = target.id;
  [s] = await api("POST", "/api/collections/statuses/records", bob, {
    workspace: ALICE_WS,
    name: "Member Attempt Status",
    category: "unstarted",
  });
  check("Bob (member) create → denied", tup(await bob_tier.now(), s), tup("member", 400));
  [s] = await api("PATCH", `/api/collections/statuses/records/${member_target_id}`, bob, {
    name: "hijacked",
  });
  check("Bob (member) update → denied", tup(await bob_tier.now(), s), tup("member", 404));
  [s] = await api("DELETE", `/api/collections/statuses/records/${member_target_id}`, bob);
  check("Bob (member) delete → denied", tup(await bob_tier.now(), s), tup("member", 404));
  [s, r] = await api(
    "GET",
    `/api/collections/statuses/records?filter=(workspace='${ALICE_WS}')`,
    bob,
  );
  check("Bob (member) list → 200", tup(await bob_tier.now(), s), tup("member", 200));
  check(
    "Bob (member) list is non-empty",
    tup(await bob_tier.now(), py_get(r, "items", []).length > 0),
    tup("member", true),
  );
  [s] = await api("GET", `/api/collections/statuses/records/${member_target_id}`, bob);
  check("Bob (member) view → 200", tup(await bob_tier.now(), s), tup("member", 200));

  console.log("\n── (1) NON-MEMBER (Carol) ──");
  [s, r] = await api(
    "GET",
    `/api/collections/statuses/records?filter=(workspace='${ALICE_WS}')`,
    carol,
  );
  check("Carol (non-member) list Alice-ws statuses → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/statuses/records/${member_target_id}`, carol);
  check("Carol (non-member) view → 404", s, 404);

  console.log("\n── (1) ANON ──");
  [s, r] = await api(
    "GET",
    `/api/collections/statuses/records?filter=(workspace='${ALICE_WS}')`,
    null,
  );
  check("Anon list Alice-ws statuses → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/statuses/records/${member_target_id}`, null);
  check("Anon view → 404", s, 404);
  [s] = await api("POST", "/api/collections/statuses/records", null, {
    workspace: ALICE_WS,
    name: "Anon Status",
    category: "unstarted",
  });
  check("Anon create → 400", s, 400);
  [s] = await api("PATCH", `/api/collections/statuses/records/${member_target_id}`, null, {
    name: "x",
  });
  check("Anon update → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/statuses/records/${member_target_id}`, null);
  check("Anon delete → 404", s, 404);

  [s] = await api("DELETE", `/api/collections/statuses/records/${member_target_id}`, alice);
  check("cleanup: member-target status removed", s, 204);

  // ══════════════════ 1b. name is trimmed before the UNIQUE index sees it ═════
  // COVERS: hook:main.pb.js#onRecordCreate:statuses, hook:main.pb.js#onRecordUpdate:statuses
  console.log(
    "\n── (1b) card 3k7z: a padded name is trimmed before storage and the unique check ──",
  );
  let base: any;
  [s, base] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "TrimStatus",
    category: "unstarted",
  });
  check("(fixture) 'TrimStatus' created", s, 200);
  const trim_status_id = base.id;
  let dup: any;
  [s, dup] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "TrimStatus ",
    category: "unstarted",
  });
  check("create with a trailing-space duplicate name → 400", s, 400);
  // A stray record here (guard absent) would raw-collide with the rename check below
  // for the wrong reason — clean it up so that check only proves the trim itself.
  if (dup.id) {
    await api("DELETE", `/api/collections/statuses/records/${dup.id}`, alice);
  }
  let fresh: any;
  [s, fresh] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "  TrimStatusFresh  ",
    category: "unstarted",
  });
  check("create with a padded fresh name → 200", s, 200);
  check("stored name has surrounding spaces removed", fresh.name, "TrimStatusFresh");
  const fresh_status_id = fresh.id;
  [s] = await api("PATCH", `/api/collections/statuses/records/${fresh_status_id}`, alice, {
    name: "TrimStatus ",
  });
  check("rename to a trailing-space duplicate name → 400", s, 400);
  for (const sid of [trim_status_id, fresh_status_id]) {
    if (sid) {
      [s] = await api("DELETE", `/api/collections/statuses/records/${sid}`, alice);
      check(`cleanup: trim-test status ${sid.slice(0, 8)} removed`, s, 204);
    }
  }

  // ══════════════════ 2. category ∈ the six ═══════════════════════════════════
  console.log("\n── (2) category enum: valid category ok, bogus category rejected ──");
  [s, made] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "Started-Cat Status",
    category: "started",
  });
  check("category='started' → 200", s, 200);
  if (made.id) {
    [s] = await api("DELETE", `/api/collections/statuses/records/${made.id}`, alice);
    check("cleanup: started-cat fixture removed", s, 204);
  }
  [s] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "Bogus-Cat Status",
    category: "not_a_category",
  });
  check("bogus category → 400", s, 400);

  // ══════════════════ 3. is_default uniqueness per workspace ══════════════════
  console.log("\n── (3) is_default: a 2nd is_default=true in the same workspace → 400 ──");
  [s] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "Second Default",
    category: "unstarted",
    is_default: true,
  });
  check("2nd is_default=true status in the same ws → 400", s, 400);

  // ══════════════════ 4. five non-triage defaults seeded on provision ═════════
  // COVERS: hook:main.pb.js#onRecordAfterCreateSuccess:users
  console.log("\n── (4) provisioning: exactly 5 default statuses, no triage, 1 is_default ──");
  const throwaway_email = `stat-prov-${randomBytes(4).toString("hex")}@example.com`;
  let u: any;
  [s, u] = await api("POST", "/api/collections/users/records", su, {
    email: throwaway_email,
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Throwaway Provision User",
    verified: true,
    approved: true,
  });
  check("(fixture) throwaway user created", s, 200);
  const throwaway_uid = u.id;
  const throwaway_ws_rows = await find_by_filter("workspaces", `owner='${throwaway_uid}'`, su);
  check(
    "(fixture) throwaway user auto-provisioned exactly 1 workspace",
    throwaway_ws_rows.length,
    1,
  );
  const throwaway_ws = throwaway_ws_rows.length ? getitem(throwaway_ws_rows[0], "id") : null;
  const prov_statuses = await find_by_filter("statuses", `workspace='${throwaway_ws}'`, su);
  check("exactly 5 default statuses on a fresh workspace", prov_statuses.length, 5);
  const prov_categories = prov_statuses.map((r) => getitem(r, "category")).sort(by_code_point);
  check(
    "categories are the 5 non-triage ones (no 'triage')",
    prov_categories,
    ["backlog", "unstarted", "started", "completed", "canceled"].sort(by_code_point),
  );
  const defaults = prov_statuses.filter((r) => truthy(r.is_default));
  check("exactly one is_default status", defaults.length, 1);
  check(
    "the is_default status is 'Backlog'",
    defaults.length ? getitem(defaults[0], "name") : null,
    "Backlog",
  );
  [s] = await api("DELETE", `/api/collections/users/records/${throwaway_uid}`, su);
  check("cleanup: throwaway user removed (cascades workspace/statuses/labels)", s, 204);

  // ══════════════════ 4b. vocab seeder fires on ANY workspace create ═══════════
  // A collection-level hook seeds default vocab for EVERY new workspace row, not
  // just the user-create-provisioned one — including one POSTed directly.
  // COVERS: hook:main.pb.js#onRecordAfterCreateSuccess:workspaces
  console.log("\n── (4b) vocab seeder fires on a DIRECTLY-created (non-provision) workspace ──");
  let direct_ws: any;
  [s, direct_ws] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Alice Direct Workspace",
    owner: alice_id,
    priorities: [],
  });
  check("(fixture) Alice creates a SECOND workspace directly via POST", s, 200);
  const direct_ws_id = direct_ws.id;
  const direct_statuses = await find_by_filter("statuses", `workspace='${direct_ws_id}'`, alice);
  const direct_defaults = direct_statuses.filter((r) => truthy(r.is_default));
  const vocab_seeded_ok =
    direct_statuses.length === 5 &&
    Bun.deepEquals(
      direct_statuses.map((r) => getitem(r, "name")).sort(by_code_point),
      ["Backlog", "Todo", "In Progress", "Done", "Canceled"].sort(by_code_point),
      true,
    ) &&
    direct_defaults.length === 1 &&
    getitem(direct_defaults[0], "name") === "Backlog";
  check("vocab seeded on any workspace create (not just provision)", vocab_seeded_ok, true);
  check(
    "exactly 5 statuses on the directly-created workspace (no double-seed)",
    direct_statuses.length,
    5,
  );
  check("exactly one is_default on the directly-created workspace", direct_defaults.length, 1);
  [s] = await api("DELETE", `/api/collections/workspaces/records/${direct_ws_id}`, alice);
  check("cleanup: directly-created workspace removed", s, 204);

  // ══════════════════ 5. cross-workspace guard ═════════════════════════════════
  // COVERS: hook:main.pb.js#onRecordCreateRequest:tasks, hook:main.pb.js#onRecordUpdateRequest:tasks
  console.log("\n── (5) a task's status must belong to the task's OWN workspace ──");
  [s] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G1-cross-ws-status-create",
    project: ALICE_PROJECT,
    status: BOB_TODO_STATUS,
  });
  check("CREATE task with a status from a DIFFERENT workspace → 400", s, 400);
  let valid_task: any;
  [s, valid_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G1-cross-ws-status-update",
    project: ALICE_PROJECT,
  });
  check("(fixture) valid task created (default status)", s, 200);
  const valid_task_id = valid_task.id;
  [s] = await api("PATCH", `/api/collections/tasks/records/${valid_task_id}`, alice, {
    status: BOB_TODO_STATUS,
  });
  check("UPDATE task's status to one from a DIFFERENT workspace → 400", s, 400);
  [s] = await api("DELETE", `/api/collections/tasks/records/${valid_task_id}`, alice);
  check("cleanup: cross-ws-status fixture task removed", s, 204);

  // ══════════════════ 6. completedAt lifecycle ═════════════════════════════════
  // COVERS: hook:main.pb.js#onRecordCreateRequest:tasks, hook:main.pb.js#onRecordUpdateRequest:tasks
  console.log("\n── (6) completedAt: set on crossing INTO completed, cleared crossing OUT ──");
  let t: any;
  [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G1-completedAt-fixture",
    project: ALICE_PROJECT,
    status: ALICE_TODO,
  });
  check("(fixture) task created with non-completed status", s, 200);
  const ca_task_id = t.id;
  check("completedAt empty on a non-completed task", t.completedAt, "");
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${ca_task_id}`, alice, {
    status: ALICE_DONE,
  });
  check("PATCH status -> completed-category status", s, 200);
  check("completedAt non-empty after crossing INTO completed", truthy(r.completedAt), true);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${ca_task_id}`, alice, {
    status: ALICE_TODO,
  });
  check("PATCH status -> non-completed status", s, 200);
  check("completedAt cleared after crossing OUT of completed", r.completedAt, "");
  [s] = await api("DELETE", `/api/collections/tasks/records/${ca_task_id}`, alice);
  check("cleanup: completedAt fixture task removed", s, 204);

  // ══════════════════ 7. project_stats bucket math ═════════════════════════════
  console.log("\n── (7) project_stats: known task distribution -> exact bucket counts ──");
  const alice_statuses: Record<string, string> = Object.fromEntries(
    (await find_by_filter("statuses", `workspace='${ALICE_WS}'`, alice)).map((r) => [
      getitem(r, "name"),
      getitem(r, "id"),
    ]),
  );
  let stats_proj: any;
  [s, stats_proj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "G1-Stats-Project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  check("(fixture) dedicated stats project created", s, 200);
  const stats_proj_id = stats_proj.id;

  const distribution: [string, number][] = [
    ["Todo", 2],
    ["In Progress", 1],
    ["Done", 1],
    ["Canceled", 1],
  ];
  const made_task_ids: string[] = [];
  for (const [status_name, n] of distribution) {
    for (let i = 0; i < n; i++) {
      [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
        title: `G1-stats-${status_name}-${i}`,
        project: stats_proj_id,
        status: getitem(alice_statuses, status_name),
      });
      check(`(fixture) task[${status_name}][${i}] created`, s, 200);
      made_task_ids.push(t.id);
    }
  }

  // COVERS: rule:project_stats.view
  [s, r] = await api("GET", `/api/collections/project_stats/records/${stats_proj_id}`, alice);
  check("GET project_stats", s, 200);
  check("project_stats.total", r.total, 5);
  check("project_stats.unstarted (2x Todo)", r.unstarted, 2);
  check("project_stats.started (1x In Progress)", r.started, 1);
  check("project_stats.completed (1x Done)", r.completed, 1);
  check("project_stats.canceled (1x Canceled)", r.canceled, 1);
  check("project_stats.backlog (none created)", r.backlog, 0);
  check("project_stats.triage (none created)", r.triage, 0);

  for (const tid of made_task_ids) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
    check(`cleanup: stats task ${tid.slice(0, 8)} removed`, s, 204);
  }
  [s] = await api("DELETE", `/api/collections/projects/records/${stats_proj_id}`, alice);
  check("cleanup: stats project removed", s, 204);

  // ══════════════════ 7b. custom vocabulary -> same bucket math ════════════════
  // Ordered after (7): a status rename is workspace-wide, so the default-vocabulary
  // baseline above must finish asserting before this section mutates the vocabulary.
  console.log("\n── (7b) project_stats honors a CUSTOM vocabulary (renamed + added statuses) ──");
  let cv_proj: any;
  [s, cv_proj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "G1-Custom-Vocab-Project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  check("(fixture) dedicated custom-vocab project created", s, 200);
  const cv_proj_id = cv_proj.id;

  const in_progress_id = getitem(alice_statuses, "In Progress");
  [s, r] = await api("PATCH", `/api/collections/statuses/records/${in_progress_id}`, alice, {
    name: "Cooking",
  });
  check("rename seeded default 'In Progress' -> 'Cooking'", s, 200);
  check("renamed status keeps category 'started'", r.category, "started");

  const cv_added: Record<string, string> = {};
  // 'Peer Review' shares the started bucket with the renamed default; 'Inbox' sits in a
  // category no default vocabulary seeds at all.
  for (const [cv_name, cv_category] of [
    ["Peer Review", "started"],
    ["Inbox", "triage"],
  ]) {
    [s, made] = await api("POST", "/api/collections/statuses/records", alice, {
      workspace: ALICE_WS,
      name: cv_name,
      category: cv_category,
    });
    check(`(fixture) custom status ${py_repr(cv_name)} (${cv_category}) created`, s, 200);
    cv_added[cv_name] = made.id;
  }

  const cv_ids: Record<string, string> = {
    ...alice_statuses,
    Cooking: in_progress_id,
    ...cv_added,
  };
  const cv_distribution: [string, number][] = [
    ["Cooking", 2],
    ["Peer Review", 3],
    ["Inbox", 1],
    ["Backlog", 1],
    ["Todo", 1],
    ["Done", 1],
    ["Canceled", 1],
  ];
  const cv_task_ids: string[] = [];
  for (const [status_name, n] of cv_distribution) {
    for (let i = 0; i < n; i++) {
      [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
        title: `G1-cv-${status_name}-${i}`,
        project: cv_proj_id,
        status: getitem(cv_ids, status_name),
      });
      check(`(fixture) custom-vocab task[${status_name}][${i}] created`, s, 200);
      cv_task_ids.push(t.id);
    }
  }

  // COVERS: rule:project_stats.view
  [s, r] = await api("GET", `/api/collections/project_stats/records/${cv_proj_id}`, alice);
  check("GET project_stats (custom vocabulary)", s, 200);
  check("custom-vocab project_stats.total", r.total, 10);
  check("custom-vocab project_stats.triage (1x Inbox, no default is triage)", r.triage, 1);
  check("custom-vocab project_stats.backlog (1x Backlog)", r.backlog, 1);
  check("custom-vocab project_stats.unstarted (1x Todo)", r.unstarted, 1);
  check("custom-vocab project_stats.started (2x Cooking + 3x Peer Review)", r.started, 5);
  check("custom-vocab project_stats.completed (1x Done)", r.completed, 1);
  check("custom-vocab project_stats.canceled (1x Canceled)", r.canceled, 1);

  // Second DELETE purges out of trash — a merely-trashed task still holds the status
  // relation, and a referenced status cannot be deleted.
  for (const tid of cv_task_ids) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
    check(`cleanup: custom-vocab task ${tid.slice(0, 8)} trashed`, s, 204);
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
    check(`cleanup: custom-vocab task ${tid.slice(0, 8)} purged`, s, 204);
  }
  [s] = await api("DELETE", `/api/collections/projects/records/${cv_proj_id}`, alice);
  check("cleanup: custom-vocab project removed", s, 204);
  for (const [cv_name, cv_id] of Object.entries(cv_added)) {
    [s] = await api("DELETE", `/api/collections/statuses/records/${cv_id}`, alice);
    check(`cleanup: custom status ${py_repr(cv_name)} removed`, s, 204);
  }
  [s] = await api("PATCH", `/api/collections/statuses/records/${in_progress_id}`, alice, {
    name: "In Progress",
  });
  check("cleanup: 'Cooking' renamed back to 'In Progress'", s, 200);

  await tierkit.verify_tiers();
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all status proofs passed");
  process.exit(0);
}

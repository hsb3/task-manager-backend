#!/usr/bin/env bun
/**
 * E2E test of pb_hooks: the unassigned-on-bare-create semantics, the status-validation
 * hook (module 10), and the custom routes. Run from the repo root against the live
 * server. Fixtures are resolved by query-by-name — no hard-coded record ids.
 */

import { by_code_point, py_str, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;
const ALICE_PROJECT_NAME = "Website Redesign";

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
  if (!r.ok) return [r.status, JSON.parse(raw || "{}")];
  if (r.status === 204) return [204, {}];
  return [r.status, JSON.parse(raw)];
}

// fetch follows 3xx by default — redirect "manual" refuses the redirect so a raw
// 302 + Location can be asserted instead of the followed-to page.
async function raw_get_no_redirect(path: string): Promise<[number, string | null]> {
  try {
    const r = await fetch(PB + path, { method: "GET", redirect: "manual" });
    await r.arrayBuffer();
    return [r.status, r.headers.get("Location")];
  } catch (e) {
    return roomkit.die_no_server(PB, e);
  }
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(PB, email, r), r.record.id];
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

async function status_id(ws_id: any, word: string, tok: string | null): Promise<any> {
  // status is a relation to `statuses` — map the word to a seeded status name.
  const name =
    ({ todo: "Todo", doing: "In Progress", done: "Done" } as Record<string, string>)[word] ?? word;
  const filt = `workspace='${esc(ws_id)}' && name='${esc(name)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/statuses/records?${qs}`, tok);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  const tag = ok ? "✅" : "❌ MISMATCH";
  console.log(`  ${tag}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

const [alice, alice_id] = await login("alice@example.com");
const [bob] = await login("bob@example.com");

const BOB_ID = await find_id("users", "name", "Bob", alice); // email is hidden; not filterable non-superuser
const ALICE_PROJECT = await find_id("projects", "name", ALICE_PROJECT_NAME, alice);
const ALICE_WORKSPACE = await find_id("workspaces", "name", "Alice's Workspace", alice);
// workspaces listRule is owner-only, so Bob's own token resolves his workspace.
const BOB_WORKSPACE = await find_id("workspaces", "name", "Bob's Workspace", bob);
const ALICE_TODO_STATUS = await status_id(ALICE_WORKSPACE, "todo", alice);
// Cross-workspace fixture: a status from Bob's workspace, invalid on Alice's tasks.
const BOB_TODO_STATUS = await status_id(BOB_WORKSPACE, "todo", bob);

let s: number;
let r: any;

// decision:tasks-have-no-default-assignee: nothing fills a task's assignee at create — an item created without one is
// Unassigned, and only an explicit write puts a person on it.
// COVERS: hook:main.pb.js#onRecordCreateRequest:tasks
console.log("\n── SEMANTICS: a bare task create stays UNASSIGNED ──");
[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "hook test (auto)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check("create without assignee", s, 200);
check("bare create leaves assignee empty (unassigned)", r.assignee ?? null, "");
const auto_id = r.id;

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "hook test (explicit)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
  assignee: BOB_ID,
});
check("explicit assignee left untouched", r.assignee ?? null, BOB_ID);
const explicit_id = r.id;

// COVERS: hook:main.pb.js#onRecordCreateRequest:tasks
console.log("\n── HOOK: task.status validated as belonging to the task's own workspace ──");
// BOB_TODO_STATUS is a real row, but from Bob's workspace — rejected on create+update.
[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "hook test (bad status)",
  status: BOB_TODO_STATUS,
  project: ALICE_PROJECT,
});
check("create with a status from a DIFFERENT workspace", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "hook test (valid status)",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check("create with a valid status", s, 200);
const valid_status_id = r.id;

// COVERS: hook:main.pb.js#onRecordUpdateRequest:tasks
[s] = await api("PATCH", `/api/collections/tasks/records/${valid_status_id}`, alice, {
  status: BOB_TODO_STATUS,
});
check("update an existing task to a status from a DIFFERENT workspace", s, 400);

console.log("\n── HOOK: task item-relation invariants — parent / milestone / blocked_by ──");
const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob);
// tasks listRule scopes to owner/member/assignee — Bob's task is invisible to alice's token.
const SET_UP_CI_TASK = await find_id("tasks", "title", "Set up CI", bob);
const DESIGN_HOMEPAGE_TASK = await find_id("tasks", "title", "Design homepage", alice);
const V1_LAUNCH_MILESTONE = await find_id("milestones", "name", "v1 launch", alice);

const relation_task_ids: string[] = [];
const relation_project_ids: string[] = [];

// COVERS: hook:main.pb.js#onRecordCreateRequest:tasks
[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  id: "selfparent0001x",
  title: "self-parent (create)",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  parent: "selfparent0001x",
});
check("create with parent = self", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "self-parent update target",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
});
check("create valid task (self-parent update probe)", s, 200);
if (truthy(r.id)) relation_task_ids.push(r.id);
const self_parent_target = r.id;

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "cross-workspace parent",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  parent: SET_UP_CI_TASK,
});
check("create with parent from a DIFFERENT workspace", s, 400);

[s, r] = await api("POST", "/api/collections/projects/records", alice, {
  name: "Hooks Probe Proj",
  workspace: ALICE_WORKSPACE,
  owner: alice_id,
});
check("create 2nd Alice project for cross-project probe", s, 200);
if (truthy(r.id)) relation_project_ids.push(r.id);
const hooks_probe_project = r.id;

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "cross-project parent (same workspace)",
  project: hooks_probe_project,
  status: ALICE_TODO_STATUS,
  parent: DESIGN_HOMEPAGE_TASK,
});
check("create with parent from a DIFFERENT project, same workspace", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "valid same-project parent",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  parent: DESIGN_HOMEPAGE_TASK,
});
check("create with a valid same-project parent", s, 200);
if (truthy(r.id)) relation_task_ids.push(r.id);

[s, r] = await api("POST", "/api/collections/tasks/records", bob, {
  title: "cross-project milestone",
  project: BOB_PROJECT,
  status: BOB_TODO_STATUS,
  milestone: V1_LAUNCH_MILESTONE,
});
check("create with milestone from a DIFFERENT project", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "valid same-project milestone",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  milestone: V1_LAUNCH_MILESTONE,
});
check("create with a valid same-project milestone", s, 200);
if (truthy(r.id)) relation_task_ids.push(r.id);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "cross-project blocker",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  dependencies: [SET_UP_CI_TASK],
});
check("create with a blocker from a DIFFERENT project", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "parent also a blocker",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  parent: DESIGN_HOMEPAGE_TASK,
  dependencies: [DESIGN_HOMEPAGE_TASK],
});
check("create with parent also listed as a blocker", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "valid same-project blocker",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  dependencies: [DESIGN_HOMEPAGE_TASK],
});
check("create with a valid same-project blocker", s, 200);
if (truthy(r.id)) relation_task_ids.push(r.id);

// COVERS: hook:main.pb.js#onRecordUpdateRequest:tasks
[s, r] = await api("PATCH", `/api/collections/tasks/records/${self_parent_target}`, alice, {
  parent: self_parent_target,
});
check("update parent = self", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "self-blocker update target",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
});
check("create valid task (self-blocker update probe)", s, 200);
if (truthy(r.id)) relation_task_ids.push(r.id);
const self_blocker_target = r.id;

[s, r] = await api("PATCH", `/api/collections/tasks/records/${self_blocker_target}`, alice, {
  dependencies: [self_blocker_target],
});
check("update dependencies = [self]", s, 400);

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "child-as-blocker parent",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
});
check("create fresh parent task (child-as-blocker probe)", s, 200);
if (truthy(r.id)) relation_task_ids.push(r.id);
const child_blocker_parent = r.id;

[s, r] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "child-as-blocker child",
  project: ALICE_PROJECT,
  status: ALICE_TODO_STATUS,
  parent: child_blocker_parent,
});
check("create fresh child task (child-as-blocker probe)", s, 200);
if (truthy(r.id)) relation_task_ids.push(r.id);
const child_blocker_child = r.id;

[s, r] = await api("PATCH", `/api/collections/tasks/records/${child_blocker_parent}`, alice, {
  dependencies: [child_blocker_child],
});
check("update dependencies to a blocker that is this task's own child", s, 400);

// COVERS: route:GET /api/tracker/summary
console.log("\n── ROUTE: /api/tracker/summary (requireAuth + server-side aggregation) ──");
[s] = await api("GET", "/api/tracker/summary");
check("anonymous request", s, 401);
[s, r] = await api("GET", "/api/tracker/summary", alice);
check("authenticated request", s, 200);
check("summary fields present", Object.keys(r).sort(by_code_point), [
  "assignedToMe",
  "byStatus",
  "total",
  "user",
]);
check(
  "counts add up",
  (Object.values(r.byStatus) as number[]).reduce((a, b) => a + b, 0),
  r.total,
);

// COVERS: route:GET /admin
console.log("\n── ROUTE: /admin redirects (302) to the dashboard UI at /_/ ──");
let location: string | null;
[s, location] = await raw_get_no_redirect("/admin");
check("GET /admin status", s, 302);
check("GET /admin Location header", location, "/_/");

// COVERS: route:GET /api/tracker/inspire
console.log("\n── ROUTE: /api/tracker/inspire (external API via $http.send) ──");
// Auth gate only: the authenticated outcome and response shape assert in tests/test_inspire.ts,
// which boots its own room against a local stub rather than calling a live upstream from here.
[s] = await api("GET", "/api/tracker/inspire");
check("anonymous request", s, 401);

for (const tid of [auto_id, explicit_id, valid_status_id, ...relation_task_ids]) {
  [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
}
check("\ncleanup: demo tasks deleted", s, 204);

for (const pid of relation_project_ids) {
  [s] = await api("DELETE", `/api/collections/projects/records/${pid}`, alice);
}
check("cleanup: demo projects deleted", s, 204);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
}

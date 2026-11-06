#!/usr/bin/env bun
/**
 * E2E proof of the collaboration rules: workspace membership opens
 * projects/tasks/comments to members, an assignment grants nothing past the membership, a hook
 * restricts assignment to members, a `viewer` reads but never writes (not even a subtask under
 * their own assigned task), and a
 * `draft` decision/document/milestone
 * is reachable only by its author, the workspace owner and admin members. Proves the
 * policy from the outside against the running server.
 *
 * Fixtures (user / project / task ids) are resolved by query-by-name — no hard-coded
 * ids. A record a caller can't see is resolved AS a caller who can (Alice) and handed
 * to the denied caller as an opaque string, exactly as test_rules.ts does.
 *
 * Seed contract (scripts/seed.ts): Alice owns "Website Redesign" in "Alice's
 * Workspace"; Bob is a NON-OWNER member of Alice's workspace and the assignee of
 * "Wire up nav"; Carol is a NON-MEMBER of Alice's workspace (owns her own).
 */

import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";
import {
  by_code_point,
  json_dumps,
  py_repr,
  py_str,
  tup,
  urlencode,
  truthy,
} from "../scripts/_py.ts";

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

tierkit.use(api);

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

async function status_id(ws_id: string | null, word: string, tok: string | null): Promise<string> {
  const name =
    ({ todo: "Todo", doing: "In Progress", done: "Done" } as Record<string, string>)[word] ?? word;
  const items = (
    await api(
      "GET",
      `/api/collections/statuses/records?filter=(workspace='${ws_id}')&perPage=50`,
      tok,
    )
  )[1].items;
  return items.find((i: any) => i.name === name).id;
}

async function purge_item(collection: string, rec_id: string, tok: string | null): Promise<number> {
  // An item DELETE only traps to trash (trash.pb.js); the SECOND delete is the purge.
  await api("DELETE", `/api/collections/${collection}/records/${rec_id}`, tok);
  return (await api("DELETE", `/api/collections/${collection}/records/${rec_id}`, tok))[0];
}

// Only a superuser can mint an author-less row (author.pb.js stamps every
// user-authenticated create); the battery exports these dummies, a bare run may not.
const SU_EMAIL = process.env.PB_SUPERUSER_EMAIL ?? "ci@example.test";
const SU_PASSWORD = process.env.PB_SUPERUSER_PASSWORD ?? "ci-battery-dummy-pw-000";

async function superuser_token(): Promise<string | null> {
  const [s, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  return s === 200 ? r.token : null;
}

const FAILS: string[] = [];

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`,
  );
}

function check_in(label: string, got: any, allowed: any[]): void {
  const ok = allowed.some((a) => Bun.deepEquals(got, a, true));
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (expected one of ${py_repr(tup(...allowed))})`,
  );
}

/**
 * createRule is null (only superuser/system mints a membership row now — the invite+accept
 * join flow is proven separately in tests/test_invitations.ts); this helper mints an ACTIVE
 * row directly via the superuser so the rest of this suite can set up a role tier without
 * re-proving the join flow at every call site. `user_tok`/`inviter` are unused, kept so every
 * call site below reads unchanged.
 */
async function admit(
  ws: string | null,
  user_id: string,
  _user_tok: string,
  role: string,
  _inviter: string,
): Promise<[number, any]> {
  return api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ws,
    user: user_id,
    role: role,
    status: "active",
  });
}

const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");
const [carol, carol_id] = await login("carol@example.com");
const su = (await superuser_token())!;
if (!su) {
  throw new roomkit.SystemExit(
    `❌ no superuser token for ${SU_EMAIL} — every membership-create fixture below needs ` +
      `it (createRule is null); set PB_SUPERUSER_EMAIL/PASSWORD to this room's superuser`,
  );
}

// Ids for Alice-workspace records are resolved AS Alice (or Bob, a member) and only
// ever handed to Carol as opaque strings she is forbidden to use.
const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
const ALICE_WORKSPACE = await find_id("workspaces", "name", "Alice's Workspace", alice);
const WIRE_UP_NAV = await find_id("tasks", "title", "Wire up nav", alice); // Bob is its assignee
const DESIGN_HOMEPAGE = await find_id("tasks", "title", "Design homepage", alice);
const ALICE_TODO = await status_id(ALICE_WORKSPACE, "todo", alice);
// The seeded premise of every "Bob (member) …" proof: a Bob with no row would be denied by
// tenancy with the very codes those checks read as their rule's answer.
let bob_member = await tierkit.actor_at_tier(ALICE_WORKSPACE!, bob_id, "member", alice, "Bob");

// COVERS: rule:workspace_members.create, rule:workspace_members.delete
console.log(
  "\n── MEMBER MANAGEMENT: createRule is null — NO user token may create a membership ──",
);
// createRule is null now for every caller, owner included (decision:invitation-keyed-by-email): the only way in is
// the invite+accept join flow (tests/test_invitations.ts) or a superuser/system create. A null
// rule refuses with 403 before field validation ever runs — the rule idiom's "no rule at all"
// case, distinct from an explicit rule evaluating false (400).
let s: number;
let r: any;
[s, r] = await api("POST", "/api/collections/workspace_members/records", bob, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "member",
  status: "active",
});
check(
  "Bob (non-owner member) adds a member to Alice's ws (null rule → 403)",
  tup(await bob_member.now(), s),
  tup("member", 403),
);
[s, r] = await api("POST", "/api/collections/workspace_members/records", alice, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "member",
  status: "active",
});
check("Alice (owner) adds Carol directly too — same null rule, same 403", s, 403);
let made: any;
[s, made] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "member",
  status: "active",
});
check_in("superuser adds Carol to Alice's workspace (system-only create path)", s, [200, 201]);
const added_member = made.id;
// cleanup so Carol stays a NON-member for the rows below and on any re-run
if (added_member) {
  [s] = await api("DELETE", `/api/collections/workspace_members/records/${added_member}`, alice);
  check(
    "cleanup: Carol's membership removed by the OWNER (deleteRule still open, Carol is a " +
      "non-member again)",
    s,
    204,
  );
}

// COVERS: rule:projects.list
console.log("\n── PROJECT VISIBILITY: member sees workspace projects; non-member filtered ──");
[, r] = await api("GET", "/api/collections/projects/records", bob);
const bob_projects = r.items.map((i: any) => i.name);
check(
  "Bob (member) lists projects — includes 'Website Redesign'",
  bob_projects.includes("Website Redesign"),
  true,
);
[, r] = await api("GET", "/api/collections/projects/records", carol);
const carol_projects = r.items.map((i: any) => i.name);
check(
  "Carol (non-member) lists projects — excludes 'Website Redesign'",
  carol_projects.includes("Website Redesign"),
  false,
);

// COVERS: rule:tasks.view
console.log("\n── TASK VISIBILITY: non-member views an Alice-ws task by id → 404 ──");
[s] = await api("GET", `/api/collections/tasks/records/${WIRE_UP_NAV}`, carol);
check("Carol (non-member) views 'Wire up nav' by id", s, 404);
[s] = await api("GET", `/api/collections/tasks/records/${WIRE_UP_NAV}`, bob);
check("Bob (member) views 'Wire up nav' by id", s, 200);

// COVERS: hook:main.pb.js#onRecordCreateRequest:tasks
console.log("\n── ASSIGNMENT: hook restricts assignee to members (400 on create & update) ──");
[s] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "assign-to-nonmember",
  status: ALICE_TODO,
  project: ALICE_PROJECT,
  assignee: carol_id,
});
check("Alice creates task assigned to Carol (non-member) — CREATE blocked", s, 400);
[s, made] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "assign-to-member",
  status: ALICE_TODO,
  project: ALICE_PROJECT,
  assignee: bob_id,
});
check_in("Alice creates task assigned to Bob (member)", s, [200, 201]);
const fixture = made.id;
// reassigning to a non-member must ALSO 400 — a rule would 404 on update;
// that's why assignment is a hook, not a rule.
// COVERS: hook:main.pb.js#onRecordUpdateRequest:tasks
[s] = await api("PATCH", `/api/collections/tasks/records/${fixture}`, alice, {
  assignee: carol_id,
});
check("Reassign that task to Carol (non-member) — UPDATE blocked", s, 400);
[s] = await api("PATCH", `/api/collections/tasks/records/${fixture}`, alice, {
  assignee: alice_id,
});
check_in("Reassign that task to Alice (member)", s, [200, 201]);

// COVERS: rule:tasks.create
console.log("\n── TASK CREATE: a member creates a task in a workspace project ──");
let bob_task: any;
[s, bob_task] = await api("POST", "/api/collections/tasks/records", bob, {
  title: "Bob's member task",
  status: ALICE_TODO,
  project: ALICE_PROJECT,
});
check_in("Bob (member) creates a task in 'Website Redesign'", s, [200, 201]);
const bob_task_id = bob_task.id;

// COVERS: rule:comments.create
console.log("\n── COMMENTS: assignee comments (201); non-member/non-assignee blocked (400) ──");
[s] = await api("POST", "/api/collections/comments/records", bob, {
  task: WIRE_UP_NAV,
  author: bob_id,
  body: "On it — wiring the nav.",
});
check_in("Bob (assignee of 'Wire up nav') comments on it", s, [200, 201]);
[s] = await api("POST", "/api/collections/comments/records", carol, {
  task: WIRE_UP_NAV,
  author: carol_id,
  body: "I shouldn't be able to.",
});
check("Carol (non-member, non-assignee) comments on an Alice-ws task (blocked)", s, 400);

console.log("\n── SUBTASKS: assignee of a parent may create a subtask; non-member blocked ──");
[s] = await api("POST", "/api/collections/tasks/records", bob, {
  title: "nav: mobile breakpoint",
  status: ALICE_TODO,
  project: ALICE_PROJECT,
  parent: WIRE_UP_NAV,
});
check_in("Bob (assignee of 'Wire up nav') creates a subtask under it", s, [200, 201]);
[s] = await api("POST", "/api/collections/tasks/records", carol, {
  title: "carol subtask",
  status: ALICE_TODO,
  project: ALICE_PROJECT,
  parent: WIRE_UP_NAV,
});
check("Carol (non-member, non-assignee) creates a subtask under it (blocked)", s, 400);

// a freshly created workspace has no self-membership row yet; validateTaskAssignee must
// short-circuit on the workspace owner or an owner self-assigning there would 400.
// COVERS: rule:workspaces.create
console.log("\n── FRESH WORKSPACE: owner assignable without a workspace_members row ──");
let ws2: any;
[s, ws2] = await api("POST", "/api/collections/workspaces/records", alice, {
  name: "Alice Solo Workspace",
  owner: alice_id,
  priorities: [],
});
check_in("Alice creates a second workspace (no membership rows)", s, [200, 201]);
// COVERS: rule:projects.create
let proj2: any;
[s, proj2] = await api("POST", "/api/collections/projects/records", alice, {
  name: "Solo Project",
  owner: alice_id,
  workspace: ws2.id,
});
check_in("Alice creates a project in it", s, [200, 201]);
const WS2_TODO = await status_id(ws2.id, "todo", alice);
let solo_task: any;
[s, solo_task] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "solo task",
  status: WS2_TODO,
  project: proj2.id,
  assignee: alice_id,
});
check_in("task create assigning the owner, who has no membership row", s, [200, 201]);
check("  ↳ the owner is the stored assignee", solo_task.assignee, alice_id);

// member READ opens on workspaces/milestones/decisions; WRITE stays owner-only.
// Carol was re-removed in Row 1, so she's a non-member here.
const ALICE_MILESTONE = await find_id("milestones", "name", "v1 launch", alice);
// Runtime decision fixture in Alice's workspace (created as the owner).
// COVERS: rule:decisions.create
let decrec: any;
[s, decrec] = await api("POST", "/api/collections/decisions/records", alice, {
  title: "Adopt member-read rules",
  status: "proposed",
  context: "wave 14",
  decision: "open member read",
  consequences: "members can read",
  workspace: ALICE_WORKSPACE,
});
check_in("Alice creates a runtime decision in her workspace", s, [200, 201]);
const ALICE_DECISION = decrec.id;

// COVERS: rule:workspaces.list, rule:workspaces.view
console.log("\n── WORKSPACES: member enumerates/reads a shared workspace; non-member cannot ──");
[, r] = await api("GET", "/api/collections/workspaces/records", bob);
const bob_ws = r.items.map((i: any) => i.name);
check(
  "Bob (member) lists workspaces — includes 'Alice's Workspace'",
  bob_ws.includes("Alice's Workspace"),
  true,
);
[s] = await api("GET", `/api/collections/workspaces/records/${ALICE_WORKSPACE}`, bob);
check("Bob (member) views Alice's workspace by id", s, 200);
[, r] = await api("GET", "/api/collections/workspaces/records", carol);
const carol_ws = r.items.map((i: any) => i.name);
check(
  "Carol (non-member) lists workspaces — excludes 'Alice's Workspace'",
  carol_ws.includes("Alice's Workspace"),
  false,
);
[s] = await api("GET", `/api/collections/workspaces/records/${ALICE_WORKSPACE}`, carol);
check("Carol (non-member) views Alice's workspace by id", s, 404);

// COVERS: rule:milestones.list, rule:milestones.view
console.log("\n── MILESTONES: member lists/views; non-member filtered/404 ──");
[, r] = await api("GET", "/api/collections/milestones/records", bob);
const bob_miles = r.items.map((i: any) => i.name);
check(
  "Bob (member) lists milestones — includes 'v1 launch'",
  bob_miles.includes("v1 launch"),
  true,
);
[s] = await api("GET", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob);
check("Bob (member) views Alice's milestone by id", s, 200);
[, r] = await api("GET", "/api/collections/milestones/records", carol);
check("Carol (non-member) lists milestones — filtered empty", r.items, []);
[s] = await api("GET", `/api/collections/milestones/records/${ALICE_MILESTONE}`, carol);
check("Carol (non-member) views Alice's milestone by id", s, 404);

// COVERS: rule:decisions.list, rule:decisions.view
console.log("\n── DECISIONS: member lists/views; non-member filtered/404 ──");
[, r] = await api("GET", "/api/collections/decisions/records", bob);
const bob_decs = r.items.map((i: any) => i.id);
check(
  "Bob (member) lists decisions — includes the runtime decision",
  bob_decs.includes(ALICE_DECISION),
  true,
);
[s] = await api("GET", `/api/collections/decisions/records/${ALICE_DECISION}`, bob);
check("Bob (member) views Alice's decision by id", s, 200);
[, r] = await api("GET", "/api/collections/decisions/records", carol);
check("Carol (non-member) lists decisions — filtered empty", r.items, []);
[s] = await api("GET", `/api/collections/decisions/records/${ALICE_DECISION}`, carol);
check("Carol (non-member) views Alice's decision by id", s, 404);

// COVERS: rule:milestones.create, rule:decisions.create
console.log("\n── W1 (#64): member create/edit now ALLOWED; only DELETE stays owner/admin ──");
let made_ms: any;
[s, made_ms] = await api("POST", "/api/collections/milestones/records", bob, {
  name: "Bob milestone",
  workspace: ALICE_WORKSPACE,
});
check_in("Bob (member) creates a milestone in Alice's ws (allowed, W1)", s, [200, 201]);
const bob_milestone_id = made_ms.id;
let made_dec: any;
[s, made_dec] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "Bob decision",
  status: "proposed",
  workspace: ALICE_WORKSPACE,
});
check_in("Bob (member) creates a decision in Alice's ws (allowed, W1)", s, [200, 201]);
const bob_decision_id = made_dec.id;
// COVERS: rule:milestones.update
[s] = await api("PATCH", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob, {
  name: "hijack",
});
check("Bob (member) updates Alice's milestone (allowed, W1)", s, 200);
// DELETE traps to trash (204) rather than owner/admin-denied; row survives with
// `trashed` set. Purge stays owner/admin (test_trash.ts).
// COVERS: rule:milestones.delete
[s] = await api("DELETE", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob);
check("Bob (member) deletes Alice's milestone → traps to trash (204, W3 #66)", s, 204);
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:milestones
[s, r] = await api("GET", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob);
check("trashed milestone is 404 by id too (card htsr: viewRule mirrors listRule)", s, 404);
[s, r] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, bob);
let row = (r.items ?? []).find((i: any) => (i.record || {}).id === ALICE_MILESTONE) ?? {};
check(
  "the milestone survived the trap and reaches the member through GET /api/tracker/trash",
  tup(s, truthy((row.record || {}).trashed)),
  tup(200, true),
);
[s, r] = await api("GET", "/api/collections/milestones/records", bob);
check(
  "trashed milestone absent from member's list",
  (r.items ?? []).map((i: any) => i.id).includes(ALICE_MILESTONE),
  false,
);
// 'v1 launch' is resolved by NAME through a LIST that filters trashed rows out, so the
// rename + trash above make a second run against the same room fail to find it at all.
[s] = await api("PATCH", `/api/collections/milestones/records/${ALICE_MILESTONE}`, alice, {
  name: "v1 launch",
  trashed: "",
  trashed_by: "",
});
check("restore: 'v1 launch' renamed back and untrashed (re-runnable)", s, 200);
// COVERS: rule:decisions.update
[s] = await api("PATCH", `/api/collections/decisions/records/${ALICE_DECISION}`, bob, {
  title: "hijack",
});
check("Bob (member) updates Alice's decision (allowed, W1)", s, 200);
// COVERS: rule:decisions.delete
[s] = await api("DELETE", `/api/collections/decisions/records/${ALICE_DECISION}`, bob);
check("Bob (member) deletes Alice's decision → traps to trash (204, W3 #66)", s, 204);
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:decisions
[s, r] = await api("GET", `/api/collections/decisions/records/${ALICE_DECISION}`, bob);
check("trashed decision is 404 by id too (card htsr: viewRule mirrors listRule)", s, 404);
[s, r] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, bob);
row = (r.items ?? []).find((i: any) => (i.record || {}).id === ALICE_DECISION) ?? {};
check(
  "the decision survived the trap and reaches the member through GET /api/tracker/trash",
  tup(s, truthy((row.record || {}).trashed)),
  tup(200, true),
);
[s, r] = await api("GET", "/api/collections/decisions/records", bob);
check(
  "trashed decision absent from member's list",
  (r.items ?? []).map((i: any) => i.id).includes(ALICE_DECISION),
  false,
);

// cleanup the milestone/decision Bob created above (owner deletes them)
if (bob_milestone_id) {
  [s] = await api("DELETE", `/api/collections/milestones/records/${bob_milestone_id}`, alice);
  check("cleanup: Bob's milestone removed", s, 204);
}
if (bob_decision_id) {
  [s] = await api("DELETE", `/api/collections/decisions/records/${bob_decision_id}`, alice);
  check("cleanup: Bob's decision removed", s, 204);
}

// cleanup the runtime decision as its owner
if (ALICE_DECISION) {
  [s] = await api("DELETE", `/api/collections/decisions/records/${ALICE_DECISION}`, alice);
  check("cleanup: runtime decision removed", s, 204);
}

console.log("\n── cleanup ──");
for (const tid of [fixture, bob_task_id]) {
  if (tid) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
    check("cleanup: fixture task deleted", s, 204);
  }
}
if (solo_task.id) {
  [s] = await api("DELETE", `/api/collections/tasks/records/${solo_task.id}`, alice);
  check("cleanup: solo task deleted", s, 204);
}
if (proj2.id) {
  [s] = await api("DELETE", `/api/collections/projects/records/${proj2.id}`, alice);
  check("cleanup: solo project deleted", s, 204);
}
if (ws2.id) {
  [s] = await api("DELETE", `/api/collections/workspaces/records/${ws2.id}`, alice);
  check("cleanup: solo workspace deleted", s, 204);
}

// TASK-008.06/.07: workspace_members gains a read-only `viewer` role + a `status`
// select (membership lifecycle: active/suspended only — decision:invitation-keyed-by-email retires "invited" from
// this collection to workspace_invitations). Each
// block below is self-contained (its own setup + cleanup) and restores Carol to a
// non-member at the end, preserving the invariant the rest of this suite relies on.

// COVERS: rule:workspace_members.create
console.log("\n── VIEWER ROLE: owner adds a read-only viewer ──");
let made_viewer: any;
[s, made_viewer] = await admit(ALICE_WORKSPACE, carol_id, carol, "viewer", alice);
check_in("Alice (owner) adds Carol as a viewer", s, [200, 201]);
// Every denial below is a bare status code, and tenancy denies with the SAME code — so the
// tier is established against the server here and rides in the assertions themselves.
const carol_viewer = await tierkit.actor_at_tier(
  ALICE_WORKSPACE!,
  carol_id,
  "viewer",
  alice,
  "Carol",
);

// COVERS: rule:projects.list, rule:tasks.view, rule:workspaces.view
console.log("\n── VIEWER READS: same read access as a member (≥3 collections) ──");
[, r] = await api("GET", "/api/collections/projects/records", carol);
const carol_viewer_projects = r.items.map((i: any) => i.name);
check(
  "Carol (viewer) lists projects — includes 'Website Redesign'",
  carol_viewer_projects.includes("Website Redesign"),
  true,
);
[s] = await api("GET", `/api/collections/tasks/records/${WIRE_UP_NAV}`, carol);
check("Carol (viewer) views 'Wire up nav' by id", s, 200);
[s] = await api("GET", `/api/collections/workspaces/records/${ALICE_WORKSPACE}`, carol);
check("Carol (viewer) views Alice's workspace by id", s, 200);

// COVERS: rule:tasks.create, rule:comments.create, rule:saved_views.create
// COVERS: rule:milestones.create, rule:decisions.create
console.log("\n── VIEWER WRITES: member-grade writes denied (≥3 collections, 400) ──");
[s] = await api("POST", "/api/collections/tasks/records", carol, {
  title: "viewer task",
  status: ALICE_TODO,
  project: ALICE_PROJECT,
});
check(
  "Carol (viewer) creates a task in 'Website Redesign' (blocked)",
  tup(await carol_viewer.now(), s),
  tup("viewer", 400),
);
[s] = await api("POST", "/api/collections/comments/records", carol, {
  task: WIRE_UP_NAV,
  author: carol_id,
  body: "viewers can't comment",
});
check(
  "Carol (viewer) comments on 'Wire up nav' (blocked)",
  tup(await carol_viewer.now(), s),
  tup("viewer", 400),
);
[s] = await api("POST", "/api/collections/saved_views/records", carol, {
  workspace: ALICE_WORKSPACE,
  owner: carol_id,
  name: "viewer view",
  scope: "personal",
});
check(
  "Carol (viewer) creates a saved_view in Alice's ws (blocked)",
  tup(await carol_viewer.now(), s),
  tup("viewer", 400),
);
[s] = await api("POST", "/api/collections/milestones/records", carol, {
  name: "viewer milestone",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
});
check(
  "Carol (viewer) creates a milestone in Alice's ws (blocked)",
  tup(await carol_viewer.now(), s),
  tup("viewer", 400),
);
[s] = await api("POST", "/api/collections/decisions/records", carol, {
  title: "viewer decision",
  status: "proposed",
  workspace: ALICE_WORKSPACE,
});
check(
  "Carol (viewer) creates a decision in Alice's ws (blocked)",
  tup(await carol_viewer.now(), s),
  tup("viewer", 400),
);

// COVERS: rule:tasks.update, rule:tasks.delete
// COVERS: rule:comments.update, rule:comments.delete
// COVERS: rule:saved_views.update, rule:saved_views.delete
// COVERS: rule:milestones.update, rule:milestones.delete
// COVERS: rule:decisions.update, rule:decisions.delete
// tasks/milestones/decisions deny on the `role ?!= "viewer"` clause; comments.delete and
// saved_views.update/delete carry no viewer clause at all (author/owner/admin only), so a
// viewer's 404 there is the right answer for the wrong reason — bounded coverage.
console.log("\n── VIEWER WRITES: update/delete on EXISTING rows denied (404, not 400) ──");
let viewer_comment: any;
[s, viewer_comment] = await api("POST", "/api/collections/comments/records", bob, {
  task: WIRE_UP_NAV,
  author: bob_id,
  body: "viewer-probe target",
});
check_in("setup: Bob (member) creates a comment to probe", s, [200, 201]);
let viewer_view: any;
[s, viewer_view] = await api("POST", "/api/collections/saved_views/records", bob, {
  workspace: ALICE_WORKSPACE,
  owner: bob_id,
  name: "viewer-probe view",
  scope: "workspace",
});
check_in("setup: Bob (member) creates a saved_view to probe", s, [200, 201]);
let viewer_ms: any;
[s, viewer_ms] = await api("POST", "/api/collections/milestones/records", bob, {
  name: "viewer-probe milestone",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
});
check_in("setup: Bob (member) creates a milestone to probe", s, [200, 201]);
let viewer_dec: any;
[s, viewer_dec] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "viewer-probe decision",
  status: "proposed",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
});
check_in("setup: Bob (member) creates a decision to probe", s, [200, 201]);

// A reactions-only PATCH is the one comments.update branch open to a plain member, so it
// is the only body whose denial isolates the viewer clause from the author/admin gate.
const VIEWER_TARGETS: [string, string, any][] = [
  ["tasks", WIRE_UP_NAV!, { title: "viewer hijack" }],
  ["comments", viewer_comment.id, { reactions: { "👍": [carol_id] } }],
  ["saved_views", viewer_view.id, { name: "viewer hijack" }],
  ["milestones", viewer_ms.id, { name: "viewer hijack" }],
  ["decisions", viewer_dec.id, { title: "viewer hijack" }],
];
for (const [col, rid, patch] of VIEWER_TARGETS) {
  [s] = await api("PATCH", `/api/collections/${col}/records/${rid}`, carol, patch);
  check(
    `Carol (viewer) updates an existing ${col} row (blocked)`,
    tup(await carol_viewer.now(), s),
    tup("viewer", 404),
  );
}
for (const [col, rid] of VIEWER_TARGETS) {
  [s] = await api("DELETE", `/api/collections/${col}/records/${rid}`, carol);
  check(
    `Carol (viewer) deletes an existing ${col} row (blocked)`,
    tup(await carol_viewer.now(), s),
    tup("viewer", 404),
  );
}

const viewer_left: string[] = [];
for (const [col, rid] of [
  ["comments", viewer_comment.id],
  ["saved_views", viewer_view.id],
]) {
  if ((await api("DELETE", `/api/collections/${col}/records/${rid}`, alice))[0] !== 204) {
    viewer_left.push(col);
  }
}
for (const [col, rid] of [
  ["milestones", viewer_ms.id],
  ["decisions", viewer_dec.id],
]) {
  if ((await purge_item(col, rid, alice)) !== 204) viewer_left.push(col);
}
check("cleanup: viewer-probe fixtures removed", viewer_left, []);

await carol_viewer.done();
[s] = await api("DELETE", `/api/collections/workspace_members/records/${carol_viewer.id}`, alice);
check("cleanup: Carol's viewer membership removed (Carol is a non-member again)", s, 204);

// COVERS: rule:workspace_members.update
console.log("\n── MEMBERSHIP STATUS: suspend/restore are owner/admin-only ──");
let qs = urlencode({ filter: `(workspace='${ALICE_WORKSPACE}' && user='${bob_id}')` });
[, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, alice);
const bob_member_id = r.items[0].id;

// pending_approval is not a status value. The superuser create bypasses every rule, so
// only the select vocabulary can refuse it; the owner PATCH passes updateRule and meets the
// status-transition hook, which refuses any value outside the vocabulary first.
console.log("\n── REMOVED VALUE: no create or PATCH reaches status pending_approval ──");
[s, r] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member_id}`, alice, {
  status: "pending_approval",
});
console.log(`     wire: PATCH → ${s} ${json_dumps(r)}`);
check(
  "OWNER (Alice) PATCHes Bob into pending_approval (refused as not a status)",
  tup(
    s,
    py_str(r.message ?? "")
      .toLowerCase()
      .includes("not a valid membership status"),
  ),
  tup(400, true),
);
[, r] = await api("GET", `/api/collections/workspace_members/records/${bob_member_id}`, alice);
check("  ↳ Bob's status is still active", r.status, "active");
[s, r] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "member",
  status: "pending_approval",
});
console.log(`     wire: superuser POST → ${s} ${json_dumps(r)}`);
check(
  "SUPERUSER creates a membership with status pending_approval (refused by the vocabulary)",
  tup(s, (r.data ?? {}).status?.code),
  tup(400, "validation_invalid_value"),
);
[s, r] = await api("POST", "/api/collections/workspace_members/records", alice, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "member",
  status: "pending_approval",
});
console.log(`     wire: owner POST → ${s} ${json_dumps(r)}`);
// createRule is null, so the owner's create never reaches the vocabulary check at all —
// the null-rule 403 answers first regardless of body (MEMBER MANAGEMENT, above).
check("OWNER (Alice) creates a membership with status pending_approval (null rule → 403)", s, 403);
[, r] = await api(
  "GET",
  "/api/collections/workspace_members/records?" +
    urlencode({ filter: `(workspace='${ALICE_WORKSPACE}' && user='${carol_id}')` }),
  alice,
);
check("  ↳ no pending_approval row was created for Carol", r.items, []);

let made_admin: any;
[s, made_admin] = await admit(ALICE_WORKSPACE, carol_id, carol, "admin", alice);
check_in("Alice (owner) adds Carol as an admin", s, [200, 201]);
const carol_admin = await tierkit.actor_at_tier(
  ALICE_WORKSPACE!,
  carol_id,
  "admin",
  alice,
  "Carol",
);

[s, r] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member_id}`, carol, {
  status: "suspended",
});
check("ADMIN (Carol) suspends Bob: active → suspended", s, 200);
check("Bob's status is now suspended", r.status, "suspended");

[s, r] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member_id}`, carol, {
  status: "active",
});
check("ADMIN (Carol) restores Bob: suspended → active", s, 200);
check("Bob's status is restored to active", r.status, "active");

bob_member = await tierkit.actor_at_tier(ALICE_WORKSPACE!, bob_id, "member", alice, "Bob");
[s] = await api("PATCH", `/api/collections/workspace_members/records/${carol_admin.id}`, bob, {
  status: "suspended",
});
// Both standings ride in the assertion: an absent target row and a caller with no membership
// each 404 for their own reason — the same code this check reads as the member-tier denial.
check(
  "MEMBER (Bob) PATCHes Carol's status (denied)",
  tup(await bob_member.now(), await carol_admin.now(), s),
  tup("member", "admin", 404),
);

[s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member_id}`, null, {
  status: "suspended",
});
check("ANON PATCHes Bob's status (denied)", s, 404);

[s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member_id}`, alice, {
  status: "bogus",
});
check("invalid status value rejected", s, 400);

await carol_admin.done();
[s] = await api("DELETE", `/api/collections/workspace_members/records/${carol_admin.id}`, alice);
check("cleanup: Carol's admin membership removed (Carol is a non-member again)", s, 204);

// role + status are REQUIRED. createRule is null for every user token (proven in MEMBER
// MANAGEMENT above), so a user-token create is refused 403 before validation ever runs — only a
// superuser reaches field validation, since rules never apply to a superuser caller.
console.log("\n── REQUIRED FIELDS: a membership create missing role or status is refused ──");
[s, r] = await api("POST", "/api/collections/workspace_members/records", alice, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "member",
});
check("Alice (owner) adds Carol with status omitted (null rule → 403, not validation)", s, 403);
for (const [field, body] of [
  ["status", { workspace: ALICE_WORKSPACE, user: carol_id, role: "member" }],
  ["role", { workspace: ALICE_WORKSPACE, user: carol_id, status: "active" }],
  ["status", { workspace: ALICE_WORKSPACE, user: carol_id, role: "member", status: "" }],
  ["role", { workspace: ALICE_WORKSPACE, user: carol_id, role: "", status: "active" }],
] as [string, any][]) {
  const shape = body[field] === "" ? "blank" : "omitted";
  [s, r] = await api("POST", "/api/collections/workspace_members/records", su, body);
  check(`superuser adds Carol with ${field} ${shape} (refused)`, s, 400);
  check(
    `  ↳ ${field} rejected as validation_required`,
    (r.data ?? {})[field]?.code,
    "validation_required",
  );
}
[, r] = await api(
  "GET",
  "/api/collections/workspace_members/records?" +
    urlencode({ filter: `(workspace='${ALICE_WORKSPACE}' && user='${carol_id}')` }),
  alice,
);
check("  ↳ no partial row survived any refusal", r.items, []);

// TASK-017.17: draft privacy. Self-contained like the blocks above — Carol is added,
// promoted to admin, then removed, ending the run a non-member again.
const DRAFT_COLS = ["decisions", "documents", "milestones"];

function item_body(collection: string, tag: string, extra: any = {}): any {
  // milestones.project is REQUIRED (W4 R9); the other two carry it for parity.
  const base: Record<string, any> = {
    decisions: { title: `draft-privacy decision (${tag})`, status: "proposed" },
    documents: {
      title: `draft-privacy document (${tag})`,
      body: "peers must not be able to read this",
    },
    milestones: { name: `draft-privacy milestone (${tag})` },
  };
  return { ...base[collection], workspace: ALICE_WORKSPACE, project: ALICE_PROJECT, ...extra };
}

// COVERS: hook:author.pb.js#onRecordCreateRequest:decisions
// COVERS: hook:author.pb.js#onRecordCreateRequest:documents
// COVERS: hook:author.pb.js#onRecordCreateRequest:milestones
// COVERS: rule:decisions.create, rule:documents.create, rule:milestones.create
console.log("\n── DRAFT AUTHOR: create stamps the caller; a submitted author loses ──");
const DRAFT: Record<string, string> = {};
const OPEN: Record<string, string> = {};
const NOAUTHOR: Record<string, string> = {};
for (const col of DRAFT_COLS) {
  [s, made] = await api(
    "POST",
    `/api/collections/${col}/records`,
    bob,
    item_body(col, "draft", { draft: true }),
  );
  check_in(`Bob (member) creates a ${col} draft`, s, [200, 201]);
  check(`${col} draft: author stamped with Bob's id`, made.author, bob_id);
  DRAFT[col] = made.id;
  [s, made] = await api(
    "POST",
    `/api/collections/${col}/records`,
    bob,
    item_body(col, "open", { draft: false, author: alice_id }),
  );
  check_in(`Bob (member) creates a non-draft ${col}`, s, [200, 201]);
  check(`${col}: submitted author=Alice overwritten with the caller`, made.author, bob_id);
  OPEN[col] = made.id;
}

for (const col of DRAFT_COLS) {
  [s, made] = await api(
    "POST",
    `/api/collections/${col}/records`,
    su,
    item_body(col, "no author", { draft: true }),
  );
  check_in(`superuser creates a ${col} draft, no author submitted`, s, [200, 201]);
  check(`${col}: superuser create leaves author empty`, made.author, "");
  NOAUTHOR[col] = made.id;
}

// COVERS: rule:decisions.list, rule:decisions.view, rule:decisions.update, rule:decisions.delete
// COVERS: rule:documents.list, rule:documents.view, rule:documents.update, rule:documents.delete
// COVERS: rule:milestones.list, rule:milestones.view, rule:milestones.update, rule:milestones.delete
console.log("\n── DRAFT PRIVACY: a peer member is shut out of another member's draft ──");
[s, made] = await admit(ALICE_WORKSPACE, carol_id, carol, "member", alice);
check_in("Alice (owner) adds Carol as a plain member", s, [200, 201]);
// Every 404 below reads the same for a non-member, so the peer tier is established against the
// server; the promotion at the end of the block re-reads it and fails if it dissolved meanwhile.
let carol_peer = await tierkit.actor_at_tier(ALICE_WORKSPACE!, carol_id, "member", alice, "Carol");
const ids_of = (rr: any): string[] => (rr.items ?? []).map((i: any) => i.id);
for (const col of DRAFT_COLS) {
  [, r] = await api("GET", `/api/collections/${col}/records?perPage=200`, carol);
  check(
    `Carol (peer member) lists ${col} — Bob's draft absent`,
    ids_of(r).includes(DRAFT[col]!),
    false,
  );
  [s] = await api("GET", `/api/collections/${col}/records/${DRAFT[col]}`, carol);
  check(
    `Carol (peer member) views the ${col} draft by id`,
    tup(await carol_peer.now(), s),
    tup("member", 404),
  );
  // a 200 here would hand back the whole record body — why the predicate rides update.
  [s] = await api("PATCH", `/api/collections/${col}/records/${DRAFT[col]}`, carol, { draft: true });
  check(
    `Carol (peer member) blind-PATCHes the ${col} draft`,
    tup(await carol_peer.now(), s),
    tup("member", 404),
  );
  [s] = await api("DELETE", `/api/collections/${col}/records/${DRAFT[col]}`, carol);
  check(
    `Carol (peer member) deletes the ${col} draft`,
    tup(await carol_peer.now(), s),
    tup("member", 404),
  );
}
for (const [col, draft_id] of Object.entries(NOAUTHOR)) {
  [, r] = await api("GET", `/api/collections/${col}/records?perPage=200`, bob);
  check(
    `Bob (member) lists ${col} — the author-less draft absent`,
    ids_of(r).includes(draft_id),
    false,
  );
  [s] = await api("GET", `/api/collections/${col}/records/${draft_id}`, bob);
  check(
    `Bob (member) views the author-less ${col} draft`,
    tup(await bob_member.now(), s),
    tup("member", 404),
  );
}

console.log("\n── NON-DRAFT UNCHANGED: a peer member still lists/views/patches open rows ──");
for (const col of DRAFT_COLS) {
  [, r] = await api("GET", `/api/collections/${col}/records?perPage=200`, carol);
  check(
    `Carol (peer member) lists ${col} — the non-draft row present`,
    ids_of(r).includes(OPEN[col]!),
    true,
  );
  [s] = await api("GET", `/api/collections/${col}/records/${OPEN[col]}`, carol);
  check(`Carol (peer member) views the non-draft ${col}`, s, 200);
  [s] = await api("PATCH", `/api/collections/${col}/records/${OPEN[col]}`, carol, { draft: false });
  check(`Carol (peer member) patches the non-draft ${col}`, s, 200);
}

// COVERS: rule:workspace_members.update
console.log("\n── DRAFT PRIVACY: the workspace owner and admin members keep full access ──");
for (const col of DRAFT_COLS) {
  [, r] = await api("GET", `/api/collections/${col}/records?perPage=200`, alice);
  check(`Alice (owner) lists ${col} — Bob's draft present`, ids_of(r).includes(DRAFT[col]!), true);
  [s] = await api("GET", `/api/collections/${col}/records/${DRAFT[col]}`, alice);
  check(`Alice (owner) views the ${col} draft by id`, s, 200);
}
for (const [col, draft_id] of Object.entries(NOAUTHOR)) {
  [s] = await api("GET", `/api/collections/${col}/records/${draft_id}`, alice);
  check(`Alice (owner) views the author-less ${col} draft`, s, 200);
}
[s] = await api("PATCH", `/api/collections/workspace_members/records/${carol_peer.id}`, alice, {
  role: "admin",
});
check("Alice (owner) promotes Carol from member to admin", s, 200);
// A 200 on the PATCH is not the promotion — the tier is re-established from the stored row, or
// every "Carol (admin)" check below could be satisfied by a Carol who is still a plain member.
carol_peer = await tierkit.actor_at_tier(ALICE_WORKSPACE!, carol_id, "admin", alice, "Carol");
for (const col of DRAFT_COLS) {
  [, r] = await api("GET", `/api/collections/${col}/records?perPage=200`, carol);
  check(`Carol (admin) lists ${col} — Bob's draft present`, ids_of(r).includes(DRAFT[col]!), true);
  [s] = await api("GET", `/api/collections/${col}/records/${DRAFT[col]}`, carol);
  check(`Carol (admin) views the ${col} draft by id`, s, 200);
}
for (const [col, draft_id] of Object.entries(NOAUTHOR)) {
  [, r] = await api("GET", `/api/collections/${col}/records?perPage=200`, carol);
  check(
    `Carol (admin) lists ${col} — the author-less draft present`,
    ids_of(r).includes(draft_id),
    true,
  );
  [s] = await api("GET", `/api/collections/${col}/records/${draft_id}`, carol);
  check(`Carol (admin) views the author-less ${col} draft`, s, 200);
}

await carol_peer.done();
[s] = await api("DELETE", `/api/collections/workspace_members/records/${carol_peer.id}`, alice);
check("cleanup: Carol's membership removed (Carol is a non-member again)", s, 204);
console.log("\n── DRAFT PRIVACY: a non-member sees no Alice-workspace rows at all ──");
for (const col of DRAFT_COLS) {
  [, r] = await api("GET", `/api/collections/${col}/records?perPage=200`, carol);
  const known = new Set([DRAFT[col], OPEN[col], NOAUTHOR[col]]);
  check(
    `Carol (non-member) lists ${col} — no Alice-ws row leaks`,
    (r.items ?? []).map((i: any) => i.id).filter((id: string) => known.has(id)),
    [],
  );
  [s] = await api("GET", `/api/collections/${col}/records/${DRAFT[col]}`, carol);
  check(`Carol (non-member) views the ${col} draft by id`, s, 404);
}

const draft_left: string[] = [];
for (const [tag, ids] of [
  ["draft", DRAFT],
  ["open", OPEN],
  ["no author", NOAUTHOR],
] as [string, Record<string, string>][]) {
  for (const [col, rid] of Object.entries(ids)) {
    if ((await purge_item(col, rid, alice)) !== 204) draft_left.push(`${col} (${tag})`);
  }
}
check("cleanup: every draft-privacy fixture purged", draft_left, []);

// PBTT-359/365/INVITE-BY-EMAIL retired from this file (decision:invitation-keyed-by-email): resolve-member-email
// now mints a workspace_invitations row, never a workspace_members row, and the role/status
// authorization matrix (owner vs active/suspended admin, pending-invitation-confers-nothing,
// hidden-email regression) is the FULL oracle in tests/test_invite_mirror.ts and
// tests/test_invitations.ts — this file keeps only the membership-RULE proofs above/below.

// PBTT-431 (decision:active-membership-grants-access): a membership whose status is not "active" loses READ as well as
// WRITE — full revocation, Linear-style. Everything below runs in a workspace of its OWN so the
// seeded fixtures the rest of this suite depends on stay untouched. tierkit refuses a non-active
// tier by design, so each cell brackets its block by reading the stored (role, status) back at
// both ends: a row that dissolved mid-cell cannot pass as a role denial.
console.log("\n══ PBTT-431 ROLE×STATUS GATE: only an ACTIVE membership confers read or write ══");

const TAG = "zqx431"; // nonce in every READ fixture's title so the search probe matches ONLY these
const GM = "/api/collections/workspace_members/records";
const GATE_ACCOUNTS: string[] = [];

async function gate_account(tag: string, label: string): Promise<[string, string]> {
  const email = `pbtt431-${tag}@example.test`;
  const [s, made] = await api("POST", "/api/collections/users/records", su, {
    email: email,
    password: "test123456",
    passwordConfirm: "test123456",
    name: `PBTT431 ${label}`,
    verified: true,
    approved: true,
  });
  check_in(`setup: superuser mints the ${label} probe account`, s, [200, 201]);
  GATE_ACCOUNTS.push(made.id);
  const [tok, uid] = await login(email);
  return [tok, uid];
}

async function gate_make(
  coll: string,
  body: any,
  label: string,
  token: string | null = null,
): Promise<string> {
  const [s, made] = await api("POST", `/api/collections/${coll}/records`, token || alice, body);
  check_in(`setup: gate fixture — ${label}`, s, [200, 201]);
  return made.id;
}

console.log(
  "\n── setup: a private workspace, one probe account per surface, one fixture per rule ──",
);
const [probe, probe_id] = await gate_account("probe", "role×status");
const [peer, peer_id] = await gate_account("peer", "always-active peer");
const [assignee_tok, assignee_id] = await gate_account("assignee", "suspended assignee");
const [victim_tok, victim_id] = await gate_account("victim", "membership delete target");
const [pin_tok, pin_id] = await gate_account("pin", "role-pin target");

const GW = await gate_make(
  "workspaces",
  { name: `PBTT-431 gate workspace ${TAG}`, owner: alice_id, priorities: [] },
  "workspace",
);
const GW_TODO = await status_id(GW, "todo", alice);
const GP = await gate_make(
  "projects",
  { name: `gate project ${TAG}`, owner: alice_id, workspace: GW },
  "project",
);
const GT = await gate_make(
  "tasks",
  { title: `gate task ${TAG}`, status: GW_TODO, project: GP },
  "task",
);
const GDOC = await gate_make(
  "documents",
  { title: `gate document ${TAG}`, workspace: GW, project: GP, draft: false },
  "document",
);
const GDEC = await gate_make(
  "decisions",
  {
    title: `gate decision ${TAG}`,
    status: "proposed",
    workspace: GW,
    project: GP,
    draft: false,
  },
  "decision",
);
const GMS = await gate_make(
  "milestones",
  { name: `gate milestone ${TAG}`, workspace: GW, project: GP, draft: false },
  "milestone",
);
const GLBL = await gate_make("labels", { workspace: GW, name: `gate label ${TAG}` }, "label");
const GTPL = await gate_make(
  "templates",
  { workspace: GW, type: "task", name: `gate template ${TAG}` },
  "template",
);
const GSV = await gate_make(
  "saved_views",
  { workspace: GW, owner: alice_id, name: `gate view ${TAG}`, scope: "workspace" },
  "saved_view",
);
// comments carries THREE membership paths (task./document./decision.workspace) — one fixture each.
const GC_TASK = await gate_make(
  "comments",
  { task: GT, author: alice_id, body: "gate comment on a task" },
  "comment@task",
);
const GC_DOC = await gate_make(
  "comments",
  { document: GDOC, author: alice_id, body: "gate comment on a document" },
  "comment@document",
);
const GC_DEC = await gate_make(
  "comments",
  { decision: GDEC, author: alice_id, body: "gate comment on a decision" },
  "comment@decision",
);
// A draft authored by the OWNER: only the owner and an ACTIVE admin may see it (export carve-out).
const GDRAFT = await gate_make(
  "documents",
  { title: `gate draft document ${TAG}`, workspace: GW, project: GP, draft: true },
  "owner-authored draft document",
);
[, r] = await api("GET", `/api/collections/task_subscribers/records?filter=(task='${GT}')`, alice);
const GSUB = r.items?.length
  ? r.items[0].id
  : await gate_make("task_subscribers", { task: GT, user: alice_id }, "task_subscribers row");
// task_activity rows are written by the activity hook, never by a client — provoke one.
await api("PATCH", `/api/collections/tasks/records/${GT}`, alice, { title: `gate task ${TAG} v2` });
await api("PATCH", `/api/collections/tasks/records/${GT}`, alice, { title: `gate task ${TAG}` });
[, r] = await api(
  "GET",
  `/api/collections/task_activity/records?filter=(task='${GT}')&perPage=1`,
  alice,
);
const GACT: string | null = r.items?.length ? r.items[0].id : null;
check("setup: an activity row exists for the gate task", truthy(GACT), true);

let PROBE_ROW = await gate_make(
  "workspace_members",
  { workspace: GW, user: probe_id, role: "member", status: "active" },
  "probe membership row",
  su,
);
let PEER_ROW = await gate_make(
  "workspace_members",
  { workspace: GW, user: peer_id, role: "member", status: "active" },
  "always-active peer membership row",
  su,
);

async function standing(row_id: string): Promise<any> {
  const [, row] = await api("GET", `${GM}/${row_id}`, alice);
  return tup(row.role, row.status);
}

// Status moves only active<->suspended by PATCH (decision:invitation-keyed-by-email: the join flow no longer PATCHes
// this collection at all), so any other move re-mints the row as superuser; callers keep the id.
async function set_standing(
  row_id: string,
  role: string,
  status: string,
  who = "probe",
): Promise<string> {
  const [, row] = await api("GET", `${GM}/${row_id}`, su);
  let s: number;
  if (
    row.status === status ||
    (row.status !== status &&
      ["active", "suspended"].includes(row.status) &&
      ["active", "suspended"].includes(status))
  ) {
    [s] = await api("PATCH", `${GM}/${row_id}`, alice, { role: role, status: status });
  } else {
    await api("DELETE", `${GM}/${row_id}`, su);
    let made: any;
    [s, made] = await api("POST", GM, su, {
      workspace: row.workspace,
      user: row.user,
      role: role,
      status: status,
    });
    row_id = made.id;
  }
  check(
    `setup: ${who} membership → ${role}/${status}`,
    tup(s, await standing(row_id)),
    tup(200, tup(role, status)),
  );
  return row_id;
}

// id-filtered list: present → the row is readable, empty-200 → the list rule filtered it out.
async function reads(coll: string, rid: string | null, token: string | null): Promise<any> {
  const [, r] = await api("GET", `/api/collections/${coll}/records?filter=(id='${rid}')`, token);
  const listed = (r.items ?? []).map((i: any) => i.id).includes(rid);
  const [view] = await api("GET", `/api/collections/${coll}/records/${rid}`, token);
  return tup(listed, view);
}

// Every workspace-scoped read surface the gate migration touched.
const READ_TARGETS: [string, string, string | null][] = [
  ["tasks", "tasks", GT],
  ["projects", "projects", GP],
  ["labels", "labels", GLBL],
  ["statuses", "statuses", GW_TODO],
  ["templates", "templates", GTPL],
  ["documents", "documents", GDOC],
  ["decisions", "decisions", GDEC],
  ["milestones", "milestones", GMS],
  ["comments (task path)", "comments", GC_TASK],
  ["comments (document path)", "comments", GC_DOC],
  ["comments (decision path)", "comments", GC_DEC],
  ["saved_views", "saved_views", GSV],
  ["task_subscribers", "task_subscribers", GSUB],
  ["task_activity", "task_activity", GACT],
  ["workspaces", "workspaces", GW],
  ["workspace_members", "workspace_members", PEER_ROW],
  ["project_stats", "project_stats", GP],
];

// (label, collection, create body, update target, update patch, create-allowed roles,
// update-allowed roles) — role sets apply ONLY at status=active; a non-active row is denied
// everywhere. `null` means the rule is null: PB answers 403 for every non-superuser caller.
const UID = "@probe-uid@";
const WRITE_TARGETS: [
  string,
  string,
  any,
  string | null,
  any,
  Set<string> | null,
  Set<string> | null,
][] = [
  [
    "tasks",
    "tasks",
    { title: "gate write probe", status: GW_TODO, project: GP },
    GT,
    { title: `gate task ${TAG}` },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  [
    "projects",
    "projects",
    { name: "gate write project", owner: UID, workspace: GW },
    GP,
    { name: `gate project ${TAG}` },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  [
    "labels",
    "labels",
    { workspace: GW, name: "gate write label" },
    GLBL,
    { name: `gate label ${TAG}` },
    new Set(["admin"]),
    new Set(["admin"]),
  ],
  [
    "statuses",
    "statuses",
    { workspace: GW, name: "gate write status", category: "backlog" },
    GW_TODO,
    { color: "teal" },
    new Set(["admin"]),
    new Set(["admin"]),
  ],
  [
    "templates",
    "templates",
    { workspace: GW, type: "task", name: "gate write template" },
    GTPL,
    { name: `gate template ${TAG}` },
    new Set(["admin"]),
    new Set(["admin"]),
  ],
  [
    "documents",
    "documents",
    { title: "gate write document", workspace: GW, project: GP, draft: false },
    GDOC,
    { body: "patched by the matrix" },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  [
    "decisions",
    "decisions",
    { title: "gate write decision", status: "proposed", workspace: GW, draft: false },
    GDEC,
    { context: "patched by the matrix" },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  [
    "milestones",
    "milestones",
    { name: "gate write milestone", workspace: GW, project: GP, draft: false },
    GMS,
    { description: "patched by the matrix" },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  [
    "comments (task path)",
    "comments",
    { task: GT, body: "gate write comment" },
    GC_TASK,
    { reactions: { "👍": [UID] } },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  [
    "comments (document path)",
    "comments",
    { document: GDOC, body: "gate write comment" },
    GC_DOC,
    { reactions: { "👍": [UID] } },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  [
    "comments (decision path)",
    "comments",
    { decision: GDEC, body: "gate write comment" },
    GC_DEC,
    { reactions: { "👍": [UID] } },
    new Set(["admin", "member"]),
    new Set(["admin", "member"]),
  ],
  // saved_views.update carries no viewer clause at all (owner/ws-owner/admin) — GSV is Alice's,
  // so a plain member's 404 there is the right answer for the wrong reason. Bounded.
  [
    "saved_views",
    "saved_views",
    { workspace: GW, owner: UID, name: "gate write view", scope: "personal" },
    GSV,
    { name: `gate view ${TAG}` },
    new Set(["admin", "member"]),
    new Set(["admin"]),
  ],
  // task_subscribers.create is probed separately in the loop: the (task,user) unique index
  // makes a repeat create a 400 for the WRONG reason, so each cell needs an untouched task.
  ["task_subscribers", "task_subscribers", null, GSUB, { user: UID }, new Set(), null],
  [
    "task_activity",
    "task_activity",
    { task: GT, field: "title", from: '""', to: '"x"' },
    GACT,
    { field: "status" },
    null,
    null,
  ],
  [
    "workspaces",
    "workspaces",
    null,
    GW,
    { name: `PBTT-431 gate workspace ${TAG}` },
    new Set(),
    new Set(["admin"]),
  ],
  // createRule is null (decision:invitation-keyed-by-email): no tier, however privileged, may create a membership
  // directly — the create half is the null-rule 403 path regardless of role/status; the update
  // half still exercises the unchanged admin-role update rule.
  [
    "workspace_members",
    "workspace_members",
    { workspace: GW, user: pin_id, role: "member", status: "active" },
    PEER_ROW,
    { status: "active" },
    null,
    new Set(["admin"]),
  ],
];

// Deletes need a throwaway row per cell (a permitted delete really removes/trashes one).
// comments/labels hard-delete; the task DELETE traps to trash (204) — either way disposable.
const DELETE_TARGETS: [string, string, any, Set<string>][] = [
  [
    "tasks",
    "tasks",
    { title: "gate delete probe", status: GW_TODO, project: GP },
    new Set(["admin", "member"]),
  ],
  [
    "comments (task path)",
    "comments",
    { task: GT, author: null, body: "gate delete probe" },
    new Set(["admin"]),
  ],
  ["labels", "labels", { workspace: GW, name: "gate delete label" }, new Set(["admin"])],
];

const SEARCH_HITS = ["decisions", "documents", "milestones", "projects", "tasks"];
const MADE: [string, string][] = []; // (collection, id) created by the write matrix — purged at the end of the block
const READ_MAP = new Map<string, Record<string, any>>();

function sub_uid(body: any, uid: string): any {
  if (body === UID) return uid;
  if (Array.isArray(body)) return body.map((v) => sub_uid(v, uid));
  if (body !== null && typeof body === "object") {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, sub_uid(v, uid)]));
  }
  return body;
}

for (const role of ["admin", "member", "viewer"]) {
  for (const status of ["active", "suspended"]) {
    const live = status === "active";
    PROBE_ROW = await set_standing(PROBE_ROW, role, status);

    console.log(`\n── ${role}/${status}: READ every gated collection ──`);
    const seen: Record<string, any> = {};
    for (const [label, coll, rid] of READ_TARGETS) {
      const got = await reads(coll, rid, probe);
      seen[label] = got;
      const want = live ? tup(true, 200) : tup(false, 404);
      check(`${role}/${status} reads ${label}`, got, want);
    }
    READ_MAP.set(`${role}/${status}`, seen);

    // Custom routes BYPASS collection rules, so the rule coverage above proves NOTHING here.
    console.log(`\n── ${role}/${status}: hook/route surfaces (rules do not apply) ──`);
    [s, r] = await api("GET", "/api/tracker/search?" + urlencode({ q: TAG }), probe);
    check(
      `${role}/${status} full-text search over the gate workspace`,
      tup(
        s,
        [...new Set<string>((r.results ?? []).map((x: any) => x.collection))].sort(by_code_point),
      ),
      live ? tup(200, SEARCH_HITS) : tup(200, []),
    );
    [s] = await api("GET", `/api/tracker/trash?workspace=${GW}`, probe);
    check(`${role}/${status} trash-list route`, s, live ? 200 : 403);
    [s, r] = await api("POST", "/api/tracker/export", probe, { workspace: GW });
    const exported = new Set<string>();
    for (const arr of Object.values((r.data || {}) as Record<string, any[]>)) {
      for (const row of arr) {
        if (row !== null && typeof row === "object" && !Array.isArray(row) && "id" in row) {
          exported.add(row.id);
        }
      }
    }
    check(
      `${role}/${status} workspace export route`,
      tup(s, live ? exported.has(GT) : exported),
      live ? tup(200, true) : tup(404, new Set()),
    );
    // The export's draft carve-out rides the SAME status conjunct as the rule's.
    check(
      `${role}/${status} export draft carve-out (owner-authored draft)`,
      exported.has(GDRAFT),
      live && role === "admin",
    );
    [s] = await api("POST", `/api/tracker/workspaces/${GW}/vocab`, probe, {});
    check(`${role}/${status} vocab-replace route`, s, live && role === "admin" ? 200 : 404);

    console.log(`\n── ${role}/${status}: WRITE every gated collection ──`);
    for (const [label, coll, body, target, patch, c_roles, u_roles] of WRITE_TARGETS) {
      let made: any;
      if (c_roles === null) {
        [s] = await api("POST", `/api/collections/${coll}/records`, probe, sub_uid(body, probe_id));
        check(`${role}/${status} creates ${label} (null rule)`, s, 403);
      } else if (body !== null) {
        const ok = live && c_roles.has(role);
        [s, made] = await api(
          "POST",
          `/api/collections/${coll}/records`,
          probe,
          sub_uid(body, probe_id),
        );
        if (ok) {
          check_in(`${role}/${status} creates ${label}`, s, [200, 201]);
        } else {
          check(`${role}/${status} creates ${label}`, s, 400);
        }
        if ((s === 200 || s === 201) && made.id) {
          // (workspace,user) is UNIQUE: leaving the row would make the NEXT cell's
          // create 400 on the index instead of on the rule.
          if (coll === "workspace_members") {
            await api("DELETE", `${GM}/${made.id}`, alice);
          } else {
            MADE.push([coll, made.id]);
          }
        }
      }
      if (u_roles === null) {
        [s] = await api(
          "PATCH",
          `/api/collections/${coll}/records/${target}`,
          probe,
          sub_uid(patch, probe_id),
        );
        check(`${role}/${status} updates ${label} (null rule)`, s, 403);
      } else {
        const ok = live && u_roles.has(role);
        [s] = await api(
          "PATCH",
          `/api/collections/${coll}/records/${target}`,
          probe,
          sub_uid(patch, probe_id),
        );
        check(`${role}/${status} updates ${label}`, s, ok ? 200 : 404);
      }
    }
    // Commenting on a task auto-subscribes the author, and (task,user) is UNIQUE — so a
    // repeat create would 400 on the index, not on the rule. Each cell gets its own task.
    const sub_task = await gate_make(
      "tasks",
      { title: "gate subscribe probe", status: GW_TODO, project: GP },
      "subscribe probe task",
    );
    let ok = live && ["admin", "member"].includes(role);
    [s, made] = await api("POST", "/api/collections/task_subscribers/records", probe, {
      task: sub_task,
      user: probe_id,
    });
    if (ok) {
      check_in(`${role}/${status} creates task_subscribers`, s, [200, 201]);
    } else {
      check(`${role}/${status} creates task_subscribers`, s, 400);
    }
    if ((s === 200 || s === 201) && made.id) {
      await api("DELETE", `/api/collections/task_subscribers/records/${made.id}`, probe);
    }
    await api("DELETE", `/api/collections/tasks/records/${sub_task}`, alice);
    await api("DELETE", `/api/collections/tasks/records/${sub_task}`, alice);

    for (const [label, coll, body, d_roles] of DELETE_TARGETS) {
      const disposable = await gate_make(
        coll,
        coll === "comments" ? { ...body, author: alice_id } : body,
        `${label} delete probe`,
      );
      ok = live && d_roles.has(role);
      [s] = await api("DELETE", `/api/collections/${coll}/records/${disposable}`, probe);
      check(`${role}/${status} deletes ${label}`, s, ok ? 204 : 404);
      await api("DELETE", `/api/collections/${coll}/records/${disposable}`, alice);
      await api("DELETE", `/api/collections/${coll}/records/${disposable}`, alice);
    }

    check(
      `tier held: the probe row was ${role}/${status} for the whole cell`,
      await standing(PROBE_ROW),
      tup(role, status),
    );
  }
}

// The OWNER row of the matrix: ownership is a separate, deliberately UNGATED branch, so the
// owner must keep every surface no matter what any membership row says.
console.log(
  "\n── OWNER ceiling: the workspace owner reads every gated surface (ungated branch) ──",
);
for (const [label, coll, rid] of READ_TARGETS) {
  check(`Alice (workspace owner) reads ${label}`, await reads(coll, rid, alice), tup(true, 200));
}

console.log("\n── ANON + NON-MEMBER floor: the same surfaces with no membership at all ──");
for (const [label, coll, rid] of READ_TARGETS) {
  check(`Carol (non-member) reads ${label}`, await reads(coll, rid, carol), tup(false, 404));
}
for (const [label, coll, rid] of READ_TARGETS) {
  check(`anon reads ${label}`, await reads(coll, rid, null), tup(false, 404));
}
[s] = await api("GET", "/api/tracker/search?" + urlencode({ q: TAG }), null);
check("anon full-text search", s, 401);
[s] = await api("POST", "/api/tracker/export", null, { workspace: GW });
check("anon workspace export", s, 401);

// TRAP 3 (the known gap): the status conjunct sits BESIDE `role ?!= "viewer"` in the write
// rules. If the two interacted wrongly an active viewer would lose reads — equality is the
// proof, cell by cell, not a spot check.
console.log("\n── TRAP: an ACTIVE VIEWER still reads everything an ACTIVE MEMBER reads ──");
check(
  "active viewer's read map == active member's read map (every gated collection)",
  READ_MAP.get("viewer/active"),
  READ_MAP.get("member/active"),
);

// TRAP 2: the ruling names every non-active status, not just the obvious one — but a PENDING
// invitation (decision:invitation-keyed-by-email's replacement for the retired "invited" membership status) is not a
// membership row at all, so it must read EXACTLY like a non-member, workspace view included (the
// old invited-member viewRule carve-out is gone too; R2 carries workspace_name instead).
console.log(
  "\n── TRAP: a PENDING invitation (no membership row) reads EXACTLY like a non-member ──",
);
[s] = await api("DELETE", `${GM}/${PROBE_ROW}`, alice);
check("setup: the probe's membership row is removed entirely", s, 204);
let inv_made: any;
[s, inv_made] = await api("POST", "/api/collections/workspace_invitations/records", alice, {
  workspace: GW,
  email: "pbtt431-probe@example.test",
  role: "admin",
});
check_in("setup: the probe holds a PENDING admin invitation, no membership row", s, [200, 201]);
const pending_map: Record<string, any> = {};
for (const [label, coll, rid] of READ_TARGETS) pending_map[label] = await reads(coll, rid, probe);
check(
  "pending-invitee read map == suspended read map (every gated collection, workspace view too)",
  pending_map,
  READ_MAP.get("admin/suspended"),
);
[s] = await api("DELETE", `/api/collections/workspace_invitations/records/${inv_made.id}`, alice);
check("cleanup: the pending invitation removed", s, 204);
PROBE_ROW = await gate_make(
  "workspace_members",
  { workspace: GW, user: probe_id, role: "admin", status: "active" },
  "probe membership row (re-minted after the pending-invitation trap)",
  su,
);

// TRAP 1: PB binds the `?`-operators of ONE back-relation path to a SINGLE joined row. With an
// ACTIVE admin (the peer) and a SUSPENDED admin (the probe) in the same workspace, a per-operator
// bind would let the suspended one borrow the peer's `status = "active"` — role matches BOTH rows,
// so only the row-binding stops it. Probed on two rules whose membership branch has THREE
// `?`-operators, plus the plain read path.
console.log(
  "\n── TRAP: an ACTIVE row for one user must not authorize a SUSPENDED row for another ──",
);
const VICTIM_BODY = { workspace: GW, user: victim_id, role: "member", status: "active" };
PEER_ROW = await set_standing(PEER_ROW, "admin", "active", "peer");
PROBE_ROW = await set_standing(PROBE_ROW, "admin", "active");
let victim_row = await gate_make("workspace_members", VICTIM_BODY, "membership delete target", su);
[s] = await api("PATCH", `/api/collections/workspaces/records/${GW}`, probe, {
  name: `ws ${TAG} ok`,
});
check(
  "control: an ACTIVE admin updates the workspace",
  tup(await standing(PROBE_ROW), await standing(PEER_ROW), s),
  tup(tup("admin", "active"), tup("admin", "active"), 200),
);
[s] = await api("DELETE", `${GM}/${victim_row}`, probe);
check("control: an ACTIVE admin deletes another member's row", s, 204);

PROBE_ROW = await set_standing(PROBE_ROW, "admin", "suspended");
victim_row = await gate_make("workspace_members", VICTIM_BODY, "membership delete target", su);
[s] = await api("PATCH", `/api/collections/workspaces/records/${GW}`, probe, { name: "hijacked" });
check(
  "SUSPENDED admin updates the workspace beside an ACTIVE admin (3 ?-ops, one row)",
  tup(await standing(PROBE_ROW), await standing(PEER_ROW), s),
  tup(tup("admin", "suspended"), tup("admin", "active"), 404),
);
[s] = await api("DELETE", `${GM}/${victim_row}`, probe);
check(
  "SUSPENDED admin deletes another member's row beside an ACTIVE admin (3 ?-ops, one row)",
  tup(await standing(PROBE_ROW), await standing(PEER_ROW), s),
  tup(tup("admin", "suspended"), tup("admin", "active"), 404),
);
check(
  "SUSPENDED admin still reads nothing beside an ACTIVE admin",
  await reads("tasks", GT, probe),
  tup(false, 404),
);
check(
  "the ACTIVE peer beside them reads normally (the workspace is not simply dark)",
  await reads("tasks", GT, peer),
  tup(true, 200),
);
[s] = await api("DELETE", `${GM}/${victim_row}`, alice);
check("cleanup: membership delete target removed", s, 204);

// PBTT-428 (decision:role-tiers, the admin-mints-only-member role pin) and PBTT-464 (the
// mint-only-"invited"-status pin) are RETIRED: createRule is null (decision:invitation-keyed-by-email), so no tier —
// not even an ACTIVE admin or the OWNER — may create a membership row directly any more, for
// any role or status. That single fact is already proven for owner and non-owner alike in
// MEMBER MANAGEMENT above and inside the write matrix's null-rule cell; the join-flow
// authorization matrix these two pins used to gate (who may invite whom to which role) moved to
// workspace_invitations.createRule and is the full oracle in tests/test_invite_mirror.ts.
const [outsider_tok] = await gate_account("outsider", "S-MEMBERS non-member caller");

// Purge is the SECOND delete. A suspended admin is refused — the collection's own deleteRule
// answers first (404), and the inline guard in trash.pb.js is the second line of defence.
console.log("\n── PURGE: a SUSPENDED admin cannot permanently delete a trashed item ──");
const PURGE_BODIES: [string, any][] = [
  ["tasks", { title: "gate purge task", status: GW_TODO, project: GP }],
  ["documents", { title: "gate purge document", workspace: GW, project: GP }],
  ["decisions", { title: "gate purge decision", status: "proposed", workspace: GW }],
  ["milestones", { name: "gate purge milestone", workspace: GW, project: GP }],
  ["projects", { name: "gate purge project", owner: alice_id, workspace: GW }],
];
for (const [coll, body] of PURGE_BODIES) {
  const rid = await gate_make(coll, body, `${coll} purge probe`);
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
  check(`setup: ${coll} purge probe trapped to trash`, s, 204);
  PROBE_ROW = await set_standing(PROBE_ROW, "admin", "suspended");
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, probe);
  check(
    `SUSPENDED admin purges the trashed ${coll}`,
    tup(await standing(PROBE_ROW), s),
    tup(tup("admin", "suspended"), 404),
  );
  PROBE_ROW = await set_standing(PROBE_ROW, "admin", "active");
  [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, probe);
  check(
    `ACTIVE admin purges the trashed ${coll} (the guard is reachable)`,
    tup(await standing(PROBE_ROW), s),
    tup(tup("admin", "active"), 204),
  );
}

// The deleteRule answers a suspended admin first, so the checks above never reach the inline
// guard. An ACTIVE MEMBER does pass tasks.deleteRule and is refused BY THE HOOK (400, not 404) —
// proof the second line of defence is live. Bounded to tasks; the other three share its shape.
const member_purge = await gate_make(
  "tasks",
  { title: "gate member purge probe", status: GW_TODO, project: GP },
  "member purge probe",
);
[s] = await api("DELETE", `/api/collections/tasks/records/${member_purge}`, alice);
check("setup: member purge probe trapped to trash", s, 204);
PROBE_ROW = await set_standing(PROBE_ROW, "member", "active");
[s, r] = await api("DELETE", `/api/collections/tasks/records/${member_purge}`, probe);
check(
  "ACTIVE member purges a trashed task — refused by the trash.pb.js guard, not the rule",
  tup(await standing(PROBE_ROW), s, py_str(r).toLowerCase().includes("cannot purge")),
  tup(tup("member", "active"), 400, true),
);
[s] = await api("DELETE", `/api/collections/tasks/records/${member_purge}`, alice);
check("cleanup: member purge probe purged by the owner", s, 204);

// PBTT-461 (decision:active-membership-grants-access): saved_views.update/delete used to grant on `owner = @request.auth.id`
// alone, so a suspended member kept editing and deleting a view they already 404'd on reading.
// Workspace ownership stays the one ungated branch, so Alice is the control that keeps a 404 here
// from meaning "the rule is simply shut".
// COVERS: rule:saved_views.update, rule:saved_views.delete
console.log("\n── PBTT-461: writing your OWN saved view needs an ACTIVE membership ──");
PROBE_ROW = await set_standing(PROBE_ROW, "member", "active");
const OWN_VIEW = await gate_make(
  "saved_views",
  { workspace: GW, owner: probe_id, name: `own view ${TAG}`, scope: "workspace" },
  "saved view owned by the probe",
  probe,
);
[s] = await api("PATCH", `/api/collections/saved_views/records/${OWN_VIEW}`, probe, {
  name: `own view ${TAG}`,
});
check(
  "ACTIVE member updates their OWN saved view",
  tup(await standing(PROBE_ROW), s),
  tup(tup("member", "active"), 200),
);
PROBE_ROW = await set_standing(PROBE_ROW, "member", "suspended");
check(
  "premise: that SUSPENDED member can no longer READ the view they own",
  await reads("saved_views", OWN_VIEW, probe),
  tup(false, 404),
);
[s] = await api("PATCH", `/api/collections/saved_views/records/${OWN_VIEW}`, probe, {
  name: "revoked edit",
});
check(
  "SUSPENDED member updates their OWN saved view",
  tup(await standing(PROBE_ROW), s),
  tup(tup("member", "suspended"), 404),
);
[s] = await api("DELETE", `/api/collections/saved_views/records/${OWN_VIEW}`, probe);
check(
  "SUSPENDED member deletes their OWN saved view",
  tup(await standing(PROBE_ROW), s),
  tup(tup("member", "suspended"), 404),
);
let row2: any;
[s, row2] = await api("GET", `/api/collections/saved_views/records/${OWN_VIEW}?fields=name`, su);
check(
  "neither refused write landed (the view still carries its old name)",
  tup(s, row2.name),
  tup(200, `own view ${TAG}`),
);
[s] = await api("PATCH", `/api/collections/saved_views/records/${OWN_VIEW}`, alice, {
  name: `own view ${TAG}`,
});
check(
  "control: the workspace OWNER still updates that same view (ungated branch)",
  tup(await standing(PROBE_ROW), s),
  tup(tup("member", "suspended"), 200),
);
PROBE_ROW = await set_standing(PROBE_ROW, "member", "active");
[s] = await api("DELETE", `/api/collections/saved_views/records/${OWN_VIEW}`, probe);
check(
  "control: re-activated, the same member deletes their OWN saved view",
  tup(await standing(PROBE_ROW), s),
  tup(tup("member", "active"), 204),
);

// main.pb.js#validateTaskAssignee reads the MERGED record, so re-checking an UNTOUCHED assignee
// 400'd every unrelated edit to a task whose assignee had since been suspended. It now validates
// only an assignee CHANGE (original() is empty on create, so creates still validate).
console.log(
  "\n── ASSIGNEE ELIGIBILITY: a suspended member is unassignable; untouched edits survive ──",
);
// The row starts ACTIVE directly (superuser create) — "invited" is no longer a reachable
// membership status, so suspended is the only non-active state left to probe here.
let ASSIGNEE_ROW = await gate_make(
  "workspace_members",
  { workspace: GW, user: assignee_id, role: "member", status: "active" },
  "assignee membership row",
  su,
);
const ASG_TAG = "qzr431asg"; // its own nonce: TAG is searched by the matrix above, which ran already
// GTA is assigned while the row is active, so the move to suspended must be a PATCH: re-minting
// the row would unassign it (main.pb.js unassigns a leaver's tasks).
const GTA = await gate_make(
  "tasks",
  {
    title: `gate assigned task ${ASG_TAG}`,
    status: GW_TODO,
    project: GP,
    assignee: assignee_id,
  },
  "task assigned to an ACTIVE member",
);
ASSIGNEE_ROW = await set_standing(ASSIGNEE_ROW, "member", "suspended", "assignee");
[s] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "assign to non-active",
  status: GW_TODO,
  project: GP,
  assignee: assignee_id,
});
check(
  "owner CREATES a task assigned to a SUSPENDED member (blocked)",
  tup(await standing(ASSIGNEE_ROW), s),
  tup(tup("member", "suspended"), 400),
);
[s] = await api("PATCH", `/api/collections/tasks/records/${GT}`, alice, { assignee: assignee_id });
check(
  "owner REASSIGNS a task to a SUSPENDED member (blocked)",
  tup(await standing(ASSIGNEE_ROW), s),
  tup(tup("member", "suspended"), 400),
);
[s] = await api("PATCH", `/api/collections/tasks/records/${GTA}`, alice, {
  title: `renamed, same assignee ${ASG_TAG}`, // the nonce rides on: it is searched below
});
check(
  "REGRESSION: owner patches only the TITLE of a task whose assignee is now suspended",
  tup(await standing(ASSIGNEE_ROW), s),
  tup(tup("member", "suspended"), 200),
);

// decision:active-membership-grants-access: a suspended assignee keeps nothing; self-leave stays ungated.
console.log("\n── RESIDUAL: a suspended assignee keeps nothing; self-leave stays ungated ──");
check(
  "a SUSPENDED assignee no longer READS their task",
  await reads("tasks", GTA, assignee_tok),
  tup(false, 404),
);
// The title carries the search nonce, so this write targets `description` to keep it intact.
[s] = await api("PATCH", `/api/collections/tasks/records/${GTA}`, assignee_tok, {
  description: "not writable by a suspended assignee",
});
check(
  "a SUSPENDED assignee no longer WRITES their task",
  tup(await standing(ASSIGNEE_ROW), s),
  tup(tup("member", "suspended"), 404),
);
check(
  "…but that same suspended assignee reads NO other row in the workspace",
  await reads("tasks", GT, assignee_tok),
  tup(false, 404),
);
// The search route mirrors the rule: a suspended assignee no longer finds their own task.
[s, r] = await api("GET", "/api/tracker/search?" + urlencode({ q: ASG_TAG }), assignee_tok);
check(
  "search: a SUSPENDED assignee no longer finds their task",
  tup(
    s,
    (r.results ?? []).map((x: any) => x.id),
  ),
  tup(200, []),
);
[s, r] = await api("GET", "/api/tracker/search?" + urlencode({ q: TAG }), assignee_tok);
check("…and nothing else in that workspace is searchable to them", tup(s, r.results), tup(200, []));
// tasks.createRule has no parent-assignee branch: a subtask needs the same membership a top-level
// task does. Fixture titles here deliberately carry NO nonce: the search probes above pin an exact result set.
console.log("\n── creating a SUBTASK under one's own assigned parent grants nothing extra ──");
[s] = await api("POST", "/api/collections/tasks/records", assignee_tok, {
  title: "subtask by a suspended assignee",
  status: GW_TODO,
  project: GP,
  parent: GTA,
});
check(
  "a SUSPENDED assignee creates a subtask under their assigned parent (blocked)",
  tup(await standing(ASSIGNEE_ROW), s),
  tup(tup("member", "suspended"), 400),
);
// `role ?!= "viewer"` excludes an active viewer from the membership branches, so a viewer cannot
// subtask even their OWN assigned task (decision:role-tiers).
const [viewer_asg_tok, viewer_asg_id] = await gate_account("vwasg", "active viewer assignee");
const VIEWER_ASG_ROW = await gate_make(
  "workspace_members",
  { workspace: GW, user: viewer_asg_id, role: "viewer", status: "active" },
  "active viewer assignee membership row",
  su,
);
const GTV = await gate_make(
  "tasks",
  {
    title: "gate task assigned to an active viewer",
    status: GW_TODO,
    project: GP,
    assignee: viewer_asg_id,
  },
  "task assigned to an ACTIVE viewer",
);
[s] = await api("POST", "/api/collections/tasks/records", viewer_asg_tok, {
  title: "top-level by an active viewer",
  status: GW_TODO,
  project: GP,
});
check(
  "control: that ACTIVE VIEWER creates a TOP-LEVEL task (blocked)",
  tup(await standing(VIEWER_ASG_ROW), s),
  tup(tup("viewer", "active"), 400),
);
[s] = await api("POST", "/api/collections/tasks/records", viewer_asg_tok, {
  title: "subtask by an active viewer assignee",
  status: GW_TODO,
  project: GP,
  parent: GTV,
});
check(
  "an ACTIVE VIEWER assignee creates a subtask under their assigned parent (blocked)",
  tup(await standing(VIEWER_ASG_ROW), s),
  tup(tup("viewer", "active"), 400),
);
// The owner may hold no workspace_members row at all, so ownership grants it.
[s] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "subtask by the workspace owner",
  status: GW_TODO,
  project: GP,
  parent: GTA,
});
check_in("the workspace OWNER still creates a subtask", s, [200, 201]);

[s] = await api("DELETE", `${GM}/${ASSIGNEE_ROW}`, assignee_tok);
check(
  "UNGATED self-leave branch: a SUSPENDED member may still delete their OWN membership row",
  s,
  204,
);

// S-MEMBERS: status moves only active<->suspended (decision:invitation-keyed-by-email retires "invited" and the
// invitee's own-accept PATCH clause from this collection entirely — the join flow is now R1
// mint + R3 accept, the full oracle in tests/test_invitations.ts). This block keeps only the
// membership-RULE proofs that still apply to an EXISTING active/suspended row, plus one proof
// that a bare PENDING invitation (no membership row) confers zero read here too.
// COVERS: rule:workspace_members.update
// COVERS: rule:workspace_members.list, rule:workspace_members.view, rule:workspace_members.delete
// COVERS: rule:workspaces.view
// COVERS: hook:membership_status.pb.js#onRecordUpdateRequest:workspace_members
console.log("\n══ S-MEMBERS: membership status transitions and a pending invitee's view ══");
// Probe accounts are reused, not minted: every login spends PB's in-memory auth rate limit.
const [inv_tok, inv_id] = [pin_tok, pin_id];
const inv_email = "pbtt431-pin@example.test"; // gate_account()'s own naming convention
const [adm_tok, adm_id] = [probe, probe_id];
const [act_tok, act_id] = [peer, peer_id];
const [sus_tok, sus_id] = [assignee_tok, assignee_id];
const [dec_tok, dec_id] = [victim_tok, victim_id];
const IW = await gate_make(
  "workspaces",
  { name: "S-MEMBERS invite workspace", owner: alice_id, priorities: [] },
  "ws",
);
const IW_TODO = await status_id(IW, "todo", alice);
const IP = await gate_make(
  "projects",
  { name: "invite project", owner: alice_id, workspace: IW },
  "proj",
);
const IT = await gate_make("tasks", { title: "invite task", status: IW_TODO, project: IP }, "task");

async function su_member(user: string, role: string, status: string): Promise<string> {
  const [s, made] = await api("POST", GM, su, {
    workspace: IW,
    user: user,
    role: role,
    status: status,
  });
  check_in(`setup: superuser mints a ${role}/${status} row`, s, [200, 201]);
  return made.id;
}

async function row_status(rid: string): Promise<any> {
  return (await api("GET", `${GM}/${rid}`, su))[1].status;
}

const ADM_ROW = await su_member(adm_id, "admin", "active");
const ACT_ROW = await su_member(act_id, "member", "active");
const SUS_ROW = await su_member(sus_id, "member", "suspended");

console.log("\n── S-MEMBERS createRule: no user token, including the OWNER, mints any row ──");
for (const [who, tok] of [
  ["OWNER", alice],
  ["ACTIVE admin", adm_tok],
] as [string, string][]) {
  [s, r] = await api("POST", GM, tok, {
    workspace: IW,
    user: inv_id,
    role: "member",
    status: "active",
  });
  check(`${who} mints an ACTIVE row (null rule → 403)`, s, 403);
}

console.log("\n── S-MEMBERS pending invitee: a bare invitation confers ZERO read here too ──");
[s, inv_made] = await api("POST", "/api/collections/workspace_invitations/records", alice, {
  workspace: IW,
  email: inv_email,
  role: "member",
});
check_in("setup: OWNER invites the pending account (no membership row yet)", s, [200, 201]);
const INV_ID = inv_made.id;
check(
  "pending invitee has no membership row of their own",
  await reads("workspace_members", ACT_ROW, inv_tok),
  tup(false, 404),
);
[s, r] = await api("GET", `/api/collections/workspaces/records/${IW}`, inv_tok);
check(
  "pending invitee views the workspace (denied — the old invited-view carve-out is gone)",
  s,
  404,
);
check(
  "pending invitee reads the workspace projects",
  await reads("projects", IP, inv_tok),
  tup(false, 404),
);
check(
  "pending invitee reads the workspace tasks",
  await reads("tasks", IT, inv_tok),
  tup(false, 404),
);
check(
  "pending invitee cannot list/view the invitations collection directly (owner/admin only)",
  await reads("workspace_invitations", INV_ID, inv_tok),
  tup(false, 404),
);
[s] = await api("DELETE", `/api/collections/workspace_invitations/records/${INV_ID}`, alice);
check("cleanup: the pending invitation removed", s, 204);

[s] = await api("GET", `/api/collections/workspaces/records/${IW}`, sus_tok);
check(
  "SUSPENDED member views the workspace beside ACTIVE members (one joined row)",
  tup(await row_status(SUS_ROW), await row_status(ACT_ROW), s),
  tup("suspended", "active", 404),
);
check(
  "SUSPENDED member still reads their OWN row",
  await reads("workspace_members", SUS_ROW, sus_tok),
  tup(true, 200),
);
[s] = await api("GET", `/api/collections/workspaces/records/${IW}`, outsider_tok);
check("NON-member views the workspace beside ACTIVE members", s, 404);
[s] = await api("GET", `/api/collections/workspaces/records/${IW}`, null);
check("anon views the workspace", s, 404);

console.log("\n── S-MEMBERS forbidden transitions: refused with a 400 and a plain message ──");
const FORBIDDEN: [string, string, string, string, string][] = [
  ["ACTIVE admin", adm_tok, ACT_ROW, "active", "invited"],
  ["OWNER", alice, ACT_ROW, "active", "invited"],
  ["superuser", su, ACT_ROW, "active", "invited"],
  ["ACTIVE admin", adm_tok, SUS_ROW, "suspended", "invited"],
  ["OWNER", alice, ACT_ROW, "active", "bogus"],
];
for (const [who, tok, rid, frm, to] of FORBIDDEN) {
  [s, r] = await api("PATCH", `${GM}/${rid}`, tok, { status: to });
  const msg = py_str(r.message ?? "");
  check(
    `${who} PATCHes ${frm} → ${to} (refused)`,
    tup(
      s,
      await row_status(rid),
      truthy(msg),
      ["hook", "field", "rule"].some((w) => msg.toLowerCase().includes(w)),
    ),
    tup(400, frm, true, false),
  );
}

console.log("\n── S-MEMBERS allowed transitions ──");
for (const [who, tok, rid, to] of [
  ["ACTIVE admin", adm_tok, ACT_ROW, "suspended"],
  ["ACTIVE admin", adm_tok, ACT_ROW, "active"],
  ["OWNER", alice, ACT_ROW, "suspended"],
  ["OWNER", alice, ACT_ROW, "active"],
] as [string, string, string, string][]) {
  [s, r] = await api("PATCH", `${GM}/${rid}`, tok, { status: to });
  check(`${who} PATCHes the member row to ${to}`, tup(s, r.status), tup(200, to));
}
const before = (await api("GET", `${GM}/${ACT_ROW}`, su))[1].updated ?? "";
await Bun.sleep(10); // the stamp has millisecond resolution and a local round trip is faster
[s, r] = await api("PATCH", `${GM}/${ACT_ROW}`, alice, { status: "suspended" });
check(
  "a status change moves the stored updated stamp",
  tup(s, ((await api("GET", `${GM}/${ACT_ROW}`, su))[1].updated ?? "") !== before),
  tup(200, true),
);
await api("PATCH", `${GM}/${ACT_ROW}`, alice, { status: "active" });
[s] = await api("PATCH", `${GM}/${ACT_ROW}`, inv_tok, { status: "suspended" });
check(
  "the pending invitee (no membership row) tries to suspend a real member (denied)",
  tup(s, await row_status(ACT_ROW)),
  tup(404, "active"),
);

// The claim and the row write share one transaction, so a save failing after the claim must roll
// the claim back rather than leave the privilege columns half-written.
// COVERS: hook:membership_status.pb.js#onRecordUpdateExecute:workspace_members
console.log(
  "\n── S-MEMBERS half-write: a save failing AFTER the claim leaves both columns alone ──",
);
const HALF_ROW = await su_member(dec_id, "member", "active");
[s, r] = await api("PATCH", `${GM}/${HALF_ROW}`, su, {
  status: "suspended",
  role: "viewer",
  user: act_id,
});
console.log(`     wire: superuser PATCH → ${s} ${json_dumps(r)}`);
const half_after = (await api("GET", `${GM}/${HALF_ROW}`, su))[1];
check(
  "a PATCH colliding on (workspace,user) is refused after the claim",
  tup(s, (r.data ?? {}).user?.code),
  tup(400, "validation_not_unique"),
);
check(
  "  ↳ the stored row still reads active/member, and still belongs to the invitee",
  tup(half_after.status, half_after.role, half_after.user),
  tup("active", "member", dec_id),
);
[s] = await api("DELETE", `${GM}/${HALF_ROW}`, su);
check("cleanup: half-write probe row removed", s, 204);

// COVERS: hook:membership_status.pb.js#onRecordUpdateExecute:workspace_members
console.log("\n── S-MEMBERS race: a status change and a role change fired together on one row ──");
// PB writes the whole row it loaded at request start, so a PATCH racing another can write back
// a stale status or role; every 200 must be visible in the stored row, and a loser gets 409.
const RACE_ROUNDS = 30;

async function race(
  rid: string,
  a: [string, string, any],
  b: [string, string, any],
): Promise<[Record<string, [number, any]>, any, any]> {
  const got: Record<string, [number, any]> = {};
  // Both requests are issued in the same tick: a staggered pair proves nothing.
  await Promise.all(
    [a, b].map(async ([key, tok, body]) => {
      got[key] = await api("PATCH", `${GM}/${rid}`, tok, body);
    }),
  );
  const row = (await api("GET", `${GM}/${rid}`, su))[1];
  await api("DELETE", `${GM}/${rid}`, su);
  return [got, row.status, row.role];
}

for (const [label, mover, start, to] of [
  ["ACTIVE admin SUSPENDS", adm_tok, "active", "suspended"],
  ["ACTIVE admin RESTORES", adm_tok, "suspended", "active"],
] as [string, string, string, string][]) {
  const status_lost: number[] = [];
  const role_lost: number[] = [];
  const odd: any[] = [];
  const refusals = new Set<any>();
  for (let n = 0; n < RACE_ROUNDS; n++) {
    [s, made] = await api("POST", GM, su, {
      workspace: IW,
      user: dec_id,
      role: "member",
      status: start,
    });
    if (s !== 200 && s !== 201) {
      odd.push(tup(n, "setup", s));
      continue;
    }
    const [got, st, role] = await race(
      made.id,
      ["status", mover, { status: to }],
      ["role", alice, { role: "viewer" }],
    );
    const codes = Object.values(got)
      .map(([c]) => c)
      .sort((x, y) => x - y);
    for (const [c, rr] of Object.values(got)) if (c === 409) refusals.add(rr.message);
    if (got.status![0] === 200 && st !== to) status_lost.push(n);
    if (got.role![0] === 200 && role !== "viewer") role_lost.push(n);
    if (!Bun.deepEquals(codes, [200, 200]) && !Bun.deepEquals(codes, [200, 409])) {
      odd.push(tup(n, codes));
    }
  }
  check(
    `${label} racing an OWNER role change: no 200 status change undone`,
    `${status_lost.length}/${RACE_ROUNDS}`,
    `0/${RACE_ROUNDS}`,
  );
  check(
    `${label} racing an OWNER role change: no 200 role change undone`,
    `${role_lost.length}/${RACE_ROUNDS}`,
    `0/${RACE_ROUNDS}`,
  );
  check(`${label} race: every round is 200+200 or 200+409`, odd, []);
  check_in(
    `${label} race: a loser is told to reload`,
    [...refusals].sort((x, y) => by_code_point(String(x), String(y))),
    [[], ["This membership changed while you were editing it. Reload and try again."]],
  );
}

[s] = await api("DELETE", `/api/collections/workspaces/records/${IW}`, alice);
check("cleanup: invite workspace trapped to trash", s, 204);

console.log("\n── cleanup: gate-workspace fixtures and probe accounts ──");
const gate_left: string[] = [];
for (const [coll, rid] of MADE) {
  const code = (await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice))[0];
  if (code !== 204 && code !== 404) gate_left.push(`${coll}/${rid}`);
  await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
}
check("cleanup: every row the write matrix created is gone", gate_left, []);
[s] = await api("DELETE", `${GM}/${PROBE_ROW}`, alice);
check("cleanup: probe membership row removed", s, 204);
[s] = await api("DELETE", `/api/collections/workspaces/records/${GW}`, alice);
check("cleanup: gate workspace trapped to trash", s, 204);
const acct_left: string[] = [];
for (const uid of GATE_ACCOUNTS) {
  if ((await api("DELETE", `/api/collections/users/records/${uid}`, su))[0] !== 204) {
    acct_left.push(uid);
  }
}
check("cleanup: every probe account removed (re-runnable)", acct_left, []);

await tierkit.verify_tiers();

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} FAILED: ${py_repr(FAILS)}`);
  process.exit(1);
}
console.log("✅ all membership-rule proofs passed");
process.exit(0);

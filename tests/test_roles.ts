#!/usr/bin/env bun
/**
 * E2E proof of the role model: a `role` (admin/member) select field on
 * `workspace_members`, the permission matrix enforced across every
 * workspace-scoped collection, and its lifecycle hooks (unassign-on-leave,
 * account-delete guard, last-workspace auto-provision). Status-code idiom
 * per .agents/rules/pocketbase.md.
 *
 * Fixtures: owner=Alice, member=Bob (his seeded membership row is
 * role="member"/status="active" — both are required fields). admin=Carol,
 * promoted in-suite via a superuser PATCH (updateRule on workspace_members
 * is owner-only, so admin can't self-promote). Throwaways (Dave/Heidi/Eve/
 * Frank/Grace) are minted via superuser and cleaned up at the end, each
 * isolating one hook-driven mechanic so mutating one never contaminates
 * another check.
 *
 * Needs superuser creds from .env / the battery's exported env to promote
 * Carol, mint throwaways, and clean up.
 */

import { randomBytes } from "node:crypto";
import { getitem, py_repr, py_str, tup, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, load_env } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";

// .env is gitignored — no secrets hard-coded here.
load_env();

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
  return [roomkit.token_of(PB, email, r), getitem(getitem(r, "record"), "id")];
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
  return items.length ? getitem(items[0], "id") : null;
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
  )[1];
  return getitem(
    getitem(items, "items").find((i: any) => i.name === name),
    "id",
  );
}

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
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_str(got)} (expected one of ${py_str(tup(...allowed))})`,
  );
}

let _shadow: any;
let admin_proj: any;
let after: any;
let alice_comment: any;
let bob_dec: any;
let bob_ms: any;
let bob_proj: any;
let dave_mem: any;
let dave_task: any;
let doc1: any;
let frank_mem: any;
let grace_trash: any;
let heidi_mem: any;
let ivan_mem: any;
let ivan_task: any;
let ivan_task_read: any;
let ivy_proj: any;
let ivy_ws: any;
let r: any;
let s: number;

// ── Superuser + base fixtures ──────────────────────────────────────────────────
const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
[, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su = roomkit.token_of(PB, SU_EMAIL, r);

const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");
const [carol, carol_id] = await login("carol@example.com");

const ALICE_WORKSPACE = await find_id("workspaces", "name", "Alice's Workspace", alice);
const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
const WIRE_UP_NAV = await find_id("tasks", "title", "Wire up nav", alice); // Bob is its assignee
const ALICE_TODO = await status_id(ALICE_WORKSPACE, "todo", alice);

async function su_create_user(name: string, email: string): Promise<string> {
  const [s, r] = await api("POST", "/api/collections/users/records", su, {
    email,
    password: "test123456",
    passwordConfirm: "test123456",
    name,
    verified: true,
    approved: true,
  });
  check_in(`setup: su creates throwaway user ${name}`, s, [200, 201]);
  return r.id;
}

const THROWAWAYS: any[] = []; // user ids to su-delete in the final cleanup pass

console.log("\n── SETUP: Carol promoted to admin in Alice's workspace ──");
[s] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "member",
  status: "active",
});
check_in("setup: Carol added to Alice's workspace", s, [200, 201]);
// Every "Carol (admin)" check below is only about the admin tier if the promotion actually
// stored — a 200 on a PATCH alone would not tell a promotion from a silent no-op.
let carol_admin = await tierkit.actor_at_tier(ALICE_WORKSPACE, carol_id, "admin", su, "Carol");

// ── outsider throwaway (never a member of Alice's workspace) ───────────────────
const outsider_email = `role-outsider-${randomBytes(4).toString("hex")}@example.com`;
let outsider_id = await su_create_user("Outsider", outsider_email);
THROWAWAYS.push(outsider_id);
const [outsider] = await login(outsider_email);

// The premise of every "Bob (plain member) … denied" check below. role + status are
// required, so the tier is carried by a stored value rather than by an empty field.
console.log("\n── R-4: Bob is a plain active member (invariant) ──");
let bob_member = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "member", alice, "Bob");

// COVERS: rule:workspace_members.list, rule:workspace_members.view
console.log(
  "\n── ROSTER MEMBER-READ: member lists/views own workspace's roster; non-member filtered ──",
);
[s, r] = await api("GET", "/api/collections/workspace_members/records", bob);
check(
  "roster member-read: Bob (member) lists Alice's workspace roster (non-empty)",
  tup(s, (r.items ?? []).length > 0),
  tup(200, true),
);
[s] = await api("GET", `/api/collections/workspace_members/records/${bob_member.id}`, bob);
check("roster member-read: Bob (member) views his own membership row by id", s, 200);
[s, r] = await api("GET", "/api/collections/workspace_members/records", outsider);
// outsider has her own auto-provisioned workspace, so assert Alice's rows are
// excluded (not global emptiness).
let outsider_rows_ws = (r.items ?? []).map((i: any) => i.workspace);
check(
  "roster member-read: outsider (non-member) list excludes Alice's workspace rows",
  tup(s, outsider_rows_ws.includes(ALICE_WORKSPACE)),
  tup(200, false),
);
[s] = await api("GET", `/api/collections/workspace_members/records/${bob_member.id}`, outsider);
check("roster member-read: outsider (non-member) views a membership row by id", s, 404);

// COVERS: rule:workspace_members.delete, hook:main.pb.js#onRecordAfterDeleteSuccess:workspace_members
console.log(
  "\n── SELF-LEAVE + TASK UNASSIGN: a member's own membership DELETE clears their assignments ──",
);
const dave_email = `role-dave-${randomBytes(4).toString("hex")}@example.com`;
let dave_id = await su_create_user("Dave", dave_email);
THROWAWAYS.push(dave_id);
const [dave] = await login(dave_email);
[s, dave_mem] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: dave_id,
  role: "member",
  status: "active",
});
check_in("setup: Dave added to Alice's workspace as a member", s, [200, 201]);
const DAVE_MEMBERSHIP = dave_mem["id"];
[s, dave_task] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "role-test: Dave's task",
  status: ALICE_TODO,
  project: ALICE_PROJECT,
  assignee: dave_id,
});
check_in("setup: Dave assigned a task in Alice's workspace", s, [200, 201]);
const DAVE_TASK = dave_task["id"];

[s] = await api("DELETE", `/api/collections/workspace_members/records/${DAVE_MEMBERSHIP}`, dave);
check("self-leave + task unassign: Dave (member) deletes his own membership row", s, 204);
[s, after] = await api("GET", `/api/collections/tasks/records/${DAVE_TASK}`, alice);
check(
  "self-leave + task unassign: Dave's task assignee is cleared by the hook",
  after["assignee"],
  "",
);

// TASK-055: a project-less task's assignee must clear too — the leaver-hook
// filter used to key on project.workspace, which is empty when project is unset.
const ivan_email = `role-ivan-${randomBytes(4).toString("hex")}@example.com`;
let ivan_id = await su_create_user("Ivan", ivan_email);
THROWAWAYS.push(ivan_id);
const [ivan] = await login(ivan_email);
[s, ivan_mem] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: ivan_id,
  role: "member",
  status: "active",
});
check_in("setup: Ivan added to Alice's workspace as a member", s, [200, 201]);
const IVAN_MEMBERSHIP = ivan_mem["id"];
[s, ivan_task] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "role-test: Ivan's project-less task",
  status: ALICE_TODO,
  workspace: ALICE_WORKSPACE,
  assignee: ivan_id,
});
check_in("setup: Ivan assigned a project-less task in Alice's workspace", s, [200, 201]);
const IVAN_PL_TASK = ivan_task["id"];

[s, ivan_task_read] = await api("GET", `/api/collections/tasks/records/${IVAN_PL_TASK}`, alice);
// decision:shadow-project: a create with no project lands in the workspace shadow project, which only a
// superuser can resolve — the projects rules hide it from every tenant role.
[, _shadow] = await api(
  "GET",
  "/api/collections/projects/records?" +
    urlencode({ filter: `workspace='${esc(ALICE_WORKSPACE)}' && shadow=true` }),
  su,
);
const ALICE_SHADOW_PROJECT = (_shadow.items?.length ? _shadow.items : [{}])[0].id ?? null;
check(
  "setup: Ivan's project-less task sits in the workspace shadow project",
  ivan_task_read["project"],
  ALICE_SHADOW_PROJECT,
);
check(
  "setup: Ivan's project-less task carries the workspace directly",
  ivan_task_read["workspace"],
  ALICE_WORKSPACE,
);
check(
  "setup: Ivan's project-less task is really assigned to Ivan (hook didn't override)",
  ivan_task_read["assignee"],
  ivan_id,
);

[s] = await api("DELETE", `/api/collections/workspace_members/records/${IVAN_MEMBERSHIP}`, ivan);
check(
  "self-leave + task unassign (project-less): Ivan (member) deletes his own membership row",
  s,
  204,
);
[s, after] = await api("GET", `/api/collections/tasks/records/${IVAN_PL_TASK}`, alice);
check(
  "self-leave + task unassign (project-less): Ivan's task assignee is cleared by the hook (TASK-055)",
  after["assignee"],
  "",
);
[s] = await api("GET", `/api/collections/tasks/records/${IVAN_PL_TASK}`, ivan);
check("self-leave + task unassign (project-less): Ivan lost read on his former task", s, 404);
[s] = await api("PATCH", `/api/collections/tasks/records/${IVAN_PL_TASK}`, ivan, {
  title: "ivan still writes",
});
check("self-leave + task unassign (project-less): Ivan lost write on his former task", s, 404);
[s, after] = await api("GET", `/api/collections/tasks/records/${IVAN_PL_TASK}`, alice);
check(
  "self-leave + task unassign (project-less): title unchanged — Ivan's PATCH truly did nothing",
  after["title"],
  "role-test: Ivan's project-less task",
);

// COVERS: rule:workspaces.update
console.log("\n── WORKSPACE ADMIN EDIT: admin updates the workspace name; plain member denied ──");
[s] = await api("PATCH", `/api/collections/workspaces/records/${ALICE_WORKSPACE}`, carol, {
  name: "Alice's Workspace",
});
check("workspace admin edit: Carol (admin) updates the workspace name", s, 200);
[s] = await api("PATCH", `/api/collections/workspaces/records/${ALICE_WORKSPACE}`, bob, {
  name: "hijacked-by-bob",
});
check(
  "workspace admin edit: Bob (plain member) update denied",
  tup(await bob_member.now(), s),
  tup("member", 404),
);

// COVERS: rule:workspace_members.update
console.log("\n── ROLE-CHANGE OWNER-ONLY: admin denied; owner allowed ──");
[s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member.id}`, carol, {
  role: "admin",
});
// Carol's stored role rides in the assertion: a non-member is denied by the same 404, and the
// point here is that even an ADMIN cannot change a role.
check(
  "role-change owner-only: admin (Carol) updates Bob's role — denied",
  tup(await carol_admin.now(), s),
  tup("admin", 404),
);
[s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member.id}`, alice, {
  role: "admin",
});
check("role-change owner-only: owner (Alice) updates Bob's role — allowed", s, 200);
[s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_member.id}`, alice, {
  role: "member",
});
check("cleanup: Bob's role reverted to member", s, 200);
// Load-bearing, not hygiene: every "Bob (plain member) … denied" check after this point would
// pass for the wrong reason if the revert silently left him admin.
bob_member = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "member", alice, "Bob");

// COVERS: rule:workspace_members.create, rule:workspace_members.delete
// decision:invitation-keyed-by-email: createRule is null — only superuser/system (the accept route) mints a
// membership row; direct create by an admin is now refused outright. deleteRule is
// untouched, so admin roster-removal still works.
console.log(
  "\n── ADMIN ADD/REMOVE MEMBER: direct create refused; admin still removes a roster row ──",
);
const heidi_email = `role-heidi-${randomBytes(4).toString("hex")}@example.com`;
let heidi_id = await su_create_user("Heidi", heidi_email);
THROWAWAYS.push(heidi_id);
[s] = await api("POST", "/api/collections/workspace_members/records", carol, {
  workspace: ALICE_WORKSPACE,
  user: heidi_id,
  role: "member",
  status: "active",
});
check("admin add/remove member: Carol (admin) direct-create is refused (null createRule)", s, 403);
[s, heidi_mem] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: heidi_id,
  role: "member",
  status: "active",
});
check_in("setup: superuser adds Heidi to Alice's workspace", s, [200, 201]);
const HEIDI_MEMBERSHIP = heidi_mem["id"];
[s] = await api("DELETE", `/api/collections/workspace_members/records/${HEIDI_MEMBERSHIP}`, carol);
check("admin add/remove member: Carol (admin) removes Heidi from Alice's workspace", s, 204);

// COVERS: rule:projects.create
console.log("\n── PROJECT CREATE-GUARD: non-member create denied; member create allowed ──");
[s] = await api("POST", "/api/collections/projects/records", outsider, {
  name: "role-test: intruder project",
  owner: outsider_id,
  workspace: ALICE_WORKSPACE,
});
check("project create-guard: outsider (non-member) create in Alice's workspace denied", s, 400);
[s, bob_proj] = await api("POST", "/api/collections/projects/records", bob, {
  name: "role-test: Bob's member project",
  owner: bob_id,
  workspace: ALICE_WORKSPACE,
});
check_in(
  "project create-guard: Bob (member) creates a project in Alice's workspace",
  s,
  [200, 201],
);
const BOB_PROJECT = bob_proj["id"];

// COVERS: rule:projects.update, rule:projects.delete
console.log(
  "\n── PROJECT EDIT/DELETE: member edits (decision:project-write-access); delete stays owner/admin (OQ-1) ──",
);
[s, admin_proj] = await api("POST", "/api/collections/projects/records", alice, {
  name: "role-test: admin edit/delete project",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("setup: throwaway project for the admin edit/delete proof", s, [200, 201]);
const ADMIN_PROJ = admin_proj["id"];
[s] = await api("PATCH", `/api/collections/projects/records/${ADMIN_PROJ}`, carol, {
  name: "role-test: admin-edited project",
});
check("project edit/delete: admin (Carol) edits a project she doesn't own", s, 200);
[s] = await api("PATCH", `/api/collections/projects/records/${ADMIN_PROJ}`, bob, {
  name: "member-edited",
});
check(
  "project edit/delete: plain member (Bob) edit allowed (decision:project-write-access)",
  tup(await bob_member.now(), s),
  tup("member", 200),
);
[s] = await api("DELETE", `/api/collections/projects/records/${BOB_PROJECT}`, bob);
check(
  "project edit/delete: Bob (member) delete of his OWN created project denied (OQ-1)",
  tup(await bob_member.now(), s),
  tup("member", 404),
);
[s] = await api("DELETE", `/api/collections/projects/records/${ADMIN_PROJ}`, carol);
check("project edit/delete: admin (Carol) deletes the project", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${BOB_PROJECT}`, carol);
check("cleanup: admin deletes Bob's member-created project", s, 204);

// COVERS: rule:milestones.create, rule:milestones.update, rule:milestones.delete, rule:decisions.create, rule:decisions.update, rule:decisions.delete
console.log(
  "\n── MEMBER DECISION/MILESTONE CREATE+UPDATE: opened; destructive delete stays owner/admin ──",
);
[s, bob_ms] = await api("POST", "/api/collections/milestones/records", bob, {
  name: "role-test: Bob's milestone",
  workspace: ALICE_WORKSPACE,
});
check_in(
  "member decision/milestone create+update: Bob (member) creates a milestone",
  s,
  [200, 201],
);
const BOB_MILESTONE = bob_ms["id"];
[s] = await api("PATCH", `/api/collections/milestones/records/${BOB_MILESTONE}`, bob, {
  name: "role-test: Bob's milestone (edited)",
});
check("member decision/milestone create+update: Bob (member) updates his milestone", s, 200);
[s, bob_dec] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "role-test: Bob's decision",
  status: "proposed",
  workspace: ALICE_WORKSPACE,
});
check_in("member decision/milestone create+update: Bob (member) creates a decision", s, [200, 201]);
const BOB_DECISION = bob_dec["id"];
[s] = await api("PATCH", `/api/collections/decisions/records/${BOB_DECISION}`, bob, {
  title: "role-test: Bob's decision (edited)",
});
check("member decision/milestone create+update: Bob (member) updates his decision", s, 200);
// first DELETE traps to trash (204, row survives with `trashed` set); admin's
// second DELETE below is the purge.
// COVERS: rule:milestones.view, rule:milestones.list, hook:trash.pb.js#onRecordDeleteRequest:milestones, hook:trash.pb.js#onRecordDeleteRequest:decisions
[s] = await api("DELETE", `/api/collections/milestones/records/${BOB_MILESTONE}`, bob);
check(
  "member decision/milestone: Bob (member) delete → traps milestone to trash (204, W3 #66)",
  s,
  204,
);
[s, r] = await api("GET", `/api/collections/milestones/records/${BOB_MILESTONE}`, bob);
check(
  "member decision/milestone: trashed milestone is 404 by id too (card htsr: view mirrors list)",
  s,
  404,
);
[s, r] = await api("GET", `/api/collections/milestones/records/${BOB_MILESTONE}`, su);
check(
  "member decision/milestone: the row survived the trap (superuser GET 200, trashed set)",
  tup(s, truthy(r["trashed"])),
  tup(200, true),
);
[s, r] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, bob);
check(
  "member decision/milestone: Bob still reaches it through GET /api/tracker/trash",
  tup(s, (r.items ?? []).map((i: any) => (i.record || {}).id).includes(BOB_MILESTONE)),
  tup(200, true),
);
[s, r] = await api("GET", "/api/collections/milestones/records", bob);
check(
  "member decision/milestone: trashed milestone absent from Bob's list",
  (r.items ?? []).map((i: any) => getitem(i, "id")).includes(BOB_MILESTONE),
  false,
);
[s] = await api("DELETE", `/api/collections/decisions/records/${BOB_DECISION}`, bob);
check(
  "member decision/milestone: Bob (member) delete → traps decision to trash (204, W3 #66)",
  s,
  204,
);
[s] = await api("DELETE", `/api/collections/milestones/records/${BOB_MILESTONE}`, carol);
check("cleanup: admin deletes Bob's milestone", s, 204);
[s] = await api("DELETE", `/api/collections/decisions/records/${BOB_DECISION}`, carol);
check("cleanup: admin deletes Bob's decision", s, 204);

// COVERS: rule:comments.create, rule:comments.update, rule:comments.delete
console.log("\n── COMMENTS ADMIN-EDIT RIDE-ALONG: non-author member denied; admin allowed ──");
[s, alice_comment] = await api("POST", "/api/collections/comments/records", alice, {
  task: WIRE_UP_NAV,
  author: alice_id,
  body: "role-test: alice's note",
});
check_in("setup: Alice comments on 'Wire up nav'", s, [200, 201]);
const ALICE_COMMENT = alice_comment["id"];
[s] = await api("PATCH", `/api/collections/comments/records/${ALICE_COMMENT}`, bob, {
  body: "hijack",
});
check(
  "comments admin-edit ride-along: non-author member (Bob) update denied",
  tup(await bob_member.now(), s),
  tup("member", 404),
);
[s] = await api("DELETE", `/api/collections/comments/records/${ALICE_COMMENT}`, bob);
check(
  "comments admin-edit ride-along: non-author member (Bob) delete denied",
  tup(await bob_member.now(), s),
  tup("member", 404),
);
[s] = await api("PATCH", `/api/collections/comments/records/${ALICE_COMMENT}`, carol, {
  body: "role-test: admin-edited",
});
check("comments admin-edit ride-along: admin (Carol) edits another's comment — allowed", s, 200);
[s] = await api("DELETE", `/api/collections/comments/records/${ALICE_COMMENT}`, alice);
check("cleanup: Alice's comment deleted", s, 204);

// COVERS: rule:project_stats.list
console.log("\n── PROJECT_STATS MEMBER READ: member sees workspace rows; non-member filtered ──");
[s, r] = await api("GET", "/api/collections/project_stats/records", bob);
let stat_names = (r.items ?? []).map((i: any) => i.name);
check(
  "project_stats member read: Bob (member) lists project_stats — non-empty",
  tup(s, stat_names.includes("Website Redesign")),
  tup(200, true),
);
[s, r] = await api("GET", "/api/collections/project_stats/records", outsider);
// outsider has her own auto-provisioned project — assert Alice's row is
// excluded, not global emptiness.
let outsider_stat_names = (r.items ?? []).map((i: any) => i.name);
check(
  "project_stats member read: outsider (non-member) list excludes Alice's project",
  tup(s, outsider_stat_names.includes("Website Redesign")),
  tup(200, false),
);

// COVERS: rule:project_stats.create, rule:project_stats.update, rule:project_stats.delete
console.log("\n── PROJECT_STATS NULL-WRITE: view collection — client writes all denied ──");
const STATS_ID = await find_id("project_stats", "name", "Website Redesign", bob);
check("setup: Bob resolves project_stats row for Website Redesign", STATS_ID !== null, true);
[s] = await api("POST", "/api/collections/project_stats/records", bob, { name: "hack" });
check("project_stats null-write: client create denied (view collection, 400)", s, 400);
[s] = await api("PATCH", `/api/collections/project_stats/records/${STATS_ID}`, bob, {
  name: "hijacked",
});
check("project_stats null-write: client update denied (view collection, 400)", s, 400);
[s] = await api("DELETE", `/api/collections/project_stats/records/${STATS_ID}`, bob);
check("project_stats null-write: client delete denied (view collection, 400)", s, 400);

// COVERS: rule:project_stats.list, rule:project_stats.view
console.log("\n── PROJECT_STATS ANON READ-GUARD: zero-member workspace row invisible to anon ──");
const ivy_email = `role-ivy-${randomBytes(4).toString("hex")}@example.com`;
let ivy_id = await su_create_user("Ivy", ivy_email);
THROWAWAYS.push(ivy_id);
const [ivy] = await login(ivy_email);
// A workspace with NO membership row — its empty back-relation join is the "" an anonymous
// caller's empty @request.auth.id used to match. Every create gives the owner a row, so the
// operator removes it.
[s, ivy_ws] = await api("POST", "/api/collections/workspaces/records", ivy, {
  name: "role-test: zero-member workspace",
  owner: ivy_id,
});
check_in("setup: Ivy creates a workspace through the public API", s, [200, 201]);
const IVY_WS = ivy_ws["id"];
let qs = urlencode({ filter: `workspace='${esc(IVY_WS)}'` });
[, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
[s] = await api("DELETE", `/api/collections/workspace_members/records/${r.items?.[0]?.id}`, su);
check("setup: superuser removes the owner's provisioned row", s, 204);
[, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
check(
  "project_stats anon read-guard: the new workspace has ZERO workspace_members rows",
  r["totalItems"],
  0,
);
const IVY_TODO = await status_id(IVY_WS, "todo", ivy);
[s, ivy_proj] = await api("POST", "/api/collections/projects/records", ivy, {
  name: "role-test: zero-member project",
  owner: ivy_id,
  workspace: IVY_WS,
});
check_in("setup: Ivy creates a project in the zero-member workspace", s, [200, 201]);
const IVY_PROJECT = ivy_proj["id"];
[s] = await api("POST", "/api/collections/tasks/records", ivy, {
  title: "role-test: zero-member task",
  status: IVY_TODO,
  project: IVY_PROJECT,
});
check_in("setup: Ivy adds a task so project_stats carries a row for that project", s, [200, 201]);

[s, r] = await api("GET", "/api/collections/project_stats/records?perPage=200");
let anon_ids = (r.items ?? []).map((i: any) => i.id);
check(
  "project_stats anon read-guard: anon list (no Authorization) excludes the zero-member row",
  tup(s, anon_ids.includes(IVY_PROJECT)),
  tup(200, false),
);
check(
  "project_stats anon read-guard: anon list is rule-filtered to zero rows (200 empty idiom)",
  tup(s, r["totalItems"]),
  tup(200, 0),
);
[s, r] = await api("GET", `/api/collections/project_stats/records/${IVY_PROJECT}`);
check(
  "project_stats anon read-guard: anon view-by-id of the zero-member row denied (404 idiom)",
  s,
  404,
);
check(
  "project_stats anon read-guard: the denied anon view returns no row fields",
  ["name", "owner", "workspace", "total"].filter((k) => Object.hasOwn(r, k)),
  [],
);
// Alice's workspace has members, so this row read as denied even BEFORE the guard —
// only the zero-member row above discriminates fixed from unfixed.
[s] = await api("GET", `/api/collections/project_stats/records/${STATS_ID}`);
check("project_stats anon read-guard: anon view-by-id of a member-backed row denied (404)", s, 404);

[s, r] = await api("GET", "/api/collections/project_stats/records?perPage=200", ivy);
check(
  "project_stats anon read-guard: owner (Ivy) still lists her zero-member project's row",
  tup(s, (r.items ?? []).map((i: any) => i.id).includes(IVY_PROJECT)),
  tup(200, true),
);
[s, r] = await api("GET", `/api/collections/project_stats/records/${IVY_PROJECT}`, ivy);
check(
  "project_stats anon read-guard: owner (Ivy) views that row by id — 200, 1 task counted",
  tup(s, r["name"], r["total"]),
  tup(200, "role-test: zero-member project", 1),
);
[s, r] = await api("GET", `/api/collections/project_stats/records/${STATS_ID}`, bob);
check(
  "project_stats anon read-guard: member (Bob) view-by-id of his workspace's row still 200",
  tup(s, r["name"]),
  tup(200, "Website Redesign"),
);

// COVERS: hook:main.pb.js#onRecordDeleteRequest:users, rule:users.delete
console.log(
  "\n── ACCOUNT-DELETE SOLE-OWNER GUARD: blocked while sole owner of a shared workspace ──",
);
const eve_email = `role-eve-${randomBytes(4).toString("hex")}@example.com`;
let eve_id = await su_create_user("Eve", eve_email);
const [eve] = await login(eve_email);
const EVE_WORKSPACE = await find_id("workspaces", "owner", eve_id, su);
check("setup: Eve auto-provisioned exactly one workspace", EVE_WORKSPACE !== null, true);

const frank_email = `role-frank-${randomBytes(4).toString("hex")}@example.com`;
let frank_id = await su_create_user("Frank", frank_email);
THROWAWAYS.push(frank_id);
[s, frank_mem] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: EVE_WORKSPACE,
  user: frank_id,
  role: "member",
  status: "active",
});
check_in("setup: Frank added to Eve's workspace as a member", s, [200, 201]);
const FRANK_MEMBERSHIP = frank_mem["id"];

[s] = await api("DELETE", `/api/collections/users/records/${eve_id}`, eve);
check(
  "account-delete sole-owner guard: Eve blocked while sole owner of a shared workspace",
  s,
  400,
);
[s] = await api("GET", `/api/collections/users/records/${eve_id}`, su);
check(
  "account-delete sole-owner guard: Eve's account still exists after the blocked delete",
  s,
  200,
);

[s] = await api("DELETE", `/api/collections/workspace_members/records/${FRANK_MEMBERSHIP}`, su);
check("setup: Frank's membership removed — Eve is solo owner again", s, 204);

[s] = await api("DELETE", `/api/collections/users/records/${eve_id}`, eve);
check("account-delete sole-owner guard: Eve's solo self-delete succeeds and cascades", s, 204);
[s] = await api("GET", `/api/collections/users/records/${eve_id}`, su);
check("account-delete sole-owner guard: Eve's account is gone after the solo self-delete", s, 404);
qs = urlencode({ filter: `owner='${esc(eve_id)}'` });
[, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, su);
check("account-delete sole-owner guard: no orphan workspace remains owned by Eve", r["items"], []);

// a DELETE only trashes the workspace (real-delete reprovision never fires on
// the programmatic trash-save); trash.pb.js reprovisions inline when the owner
// has no other live workspace, so the old workspace stays trashed while a
// fresh one appears — "every user has at least one visible workspace" holds.
// COVERS: rule:workspaces.delete, hook:trash.pb.js#onRecordDeleteRequest:workspaces
console.log(
  "\n── LAST-WORKSPACE TRASH + REPROVISION: trash your last ws -> a fresh one appears ──",
);
const grace_email = `role-grace-${randomBytes(4).toString("hex")}@example.com`;
let grace_id = await su_create_user("Grace", grace_email);
THROWAWAYS.push(grace_id);
const [grace] = await login(grace_email);
qs = urlencode({ filter: `owner='${esc(grace_id)}'` });
[, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, grace);
let grace_ws_before = r.items ?? [];
check("setup: Grace has exactly one auto-provisioned workspace", grace_ws_before.length, 1);
const GRACE_WS1 = grace_ws_before.length ? getitem(grace_ws_before[0], "id") : null;

[s] = await api("DELETE", `/api/collections/workspaces/records/${GRACE_WS1}`, grace);
check("last-workspace trash: Grace deletes her own last workspace (204)", s, 204);
[s] = await api("GET", `/api/collections/workspaces/records/${GRACE_WS1}`, grace);
check(
  "last-workspace trash: the trashed workspace is no longer readable through the collection (404)",
  s,
  404,
);
// viewRule carries `trashed = ""` since 1785162800, so the owner's Trash surface is the one
// read that still serves a trashed workspace — routes bypass collection rules.
[s, grace_trash] = await api("GET", "/api/tracker/workspaces/trash", grace);
let grace_trashed = Object.fromEntries(
  (grace_trash.items ?? []).map((w: any) => [getitem(w, "id"), w]),
);
check(
  "last-workspace trash: the old workspace is TRASHED, not removed (owner Trash lists it, trashed set)",
  tup(s, Object.hasOwn(grace_trashed, GRACE_WS1), truthy((grace_trashed[GRACE_WS1] ?? {}).trashed)),
  tup(200, true, true),
);
// listRule excludes trashed rows, so Grace's re-list only shows the fresh one.
[, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, grace);
let grace_ws_after = r.items ?? [];
check(
  "last-workspace trash: exactly one FRESH live workspace afterward (reprovisioned)",
  grace_ws_after.length,
  1,
);
check(
  "last-workspace trash: the fresh workspace is a NEW record, not the trashed one",
  grace_ws_after.length ? getitem(grace_ws_after[0], "id") !== GRACE_WS1 : false,
  true,
);

console.log(
  "\n── APP_DOCS DUP-SLUG RIDE-ALONG: duplicate-slug create rejected (400), RUNS here ──",
);
const dup_slug = `concept:roles-test-dup-${randomBytes(4).toString("hex")}`;
[s, doc1] = await api("POST", "/api/collections/app_docs/records", su, {
  slug: dup_slug,
  title: "role-test dup",
  body: "first",
});
check_in("app_docs dup-slug ride-along: first create with a fresh slug succeeds", s, [200, 201]);
[s] = await api("POST", "/api/collections/app_docs/records", su, {
  slug: dup_slug,
  title: "role-test dup 2",
  body: "second",
});
check("app_docs dup-slug ride-along: duplicate-slug create rejected", s, 400);

// COVERS: rule:app_docs.list, rule:app_docs.view
console.log(
  "\n── APP_DOCS PUBLIC READ: anon list/view without a token (public listRule/viewRule) ──",
);
[s, r] = await api("GET", "/api/collections/app_docs/records");
check(
  "app_docs public read: anon list (no token) succeeds (non-empty)",
  tup(s, (r.items ?? []).length > 0),
  tup(200, true),
);
[s] = await api("GET", `/api/collections/app_docs/records/${doc1.id}`);
check("app_docs public read: anon view-by-id (no token) succeeds", s, 200);

// COVERS: rule:app_docs.update, rule:app_docs.delete
console.log("\n── APP_DOCS NULL-WRITE: client update/delete denied (null rule) ──");
[s] = await api("PATCH", `/api/collections/app_docs/records/${doc1.id}`, bob, {
  title: "hijacked",
});
check("app_docs null-write: client (Bob) update denied (403)", s, 403);
[s] = await api("DELETE", `/api/collections/app_docs/records/${doc1.id}`, bob);
check("app_docs null-write: client (Bob) delete denied (403)", s, 403);

if (doc1.id) {
  [s] = await api("DELETE", `/api/collections/app_docs/records/${doc1.id}`, su);
  check("cleanup: dup-slug test doc deleted", s, 204);
}

console.log("\n── cleanup ──");
if (DAVE_TASK) {
  [s] = await api("DELETE", `/api/collections/tasks/records/${DAVE_TASK}`, alice);
  check("cleanup: Dave's (now-unassigned) task deleted", s, 204);
}
if (IVAN_PL_TASK) {
  [s] = await api("DELETE", `/api/collections/tasks/records/${IVAN_PL_TASK}`, alice);
  check("cleanup: Ivan's (now-unassigned) project-less task deleted", s, 204);
}
await carol_admin.done();
[s] = await api("DELETE", `/api/collections/workspace_members/records/${carol_admin.id}`, alice);
check("cleanup: Carol's admin membership removed (Carol is a non-member again)", s, 204);
for (const uid of THROWAWAYS) {
  if (uid) {
    [s] = await api("DELETE", `/api/collections/users/records/${uid}`, su);
    check(`cleanup: superuser deletes throwaway user ${uid}`, s, 204);
  }
}

await tierkit.verify_tiers();

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} FAILED: ${py_str(FAILS)}`);
  process.exit(1);
}
console.log("✅ all role-matrix proofs passed");

#!/usr/bin/env bun
/**Prove the cross-relation rules on `tasks`: see/edit if you own the project OR
are the assignee; only the project owner may delete; create only in your own
project; an UNASSIGNED task is not world-writable (TASK-049 anon-write guard).
Self-contained & rerunnable — creates and cleans up its own fixture.
 */

import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";
import { py_str, tup, urlencode, truthy } from "../scripts/_py.ts";

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
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 → empty body
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

async function status_id(
  ws_id: string | null,
  word: string,
  tok: string | null,
): Promise<string | null> {
  // status is a relation to `statuses` — map the word to a seeded status name.
  const name =
    ({ todo: "Todo", doing: "In Progress", done: "Done" } as Record<string, string>)[word] ?? word;
  const filt = `workspace='${esc(ws_id!)}' && name='${esc(name)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/statuses/records?${qs}`, tok);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  const tag = ok ? "✅" : "❌ MISMATCH";
  console.log(`  ${tag}  ${label.padEnd(52)} → ${py_str(got)} (want ${py_str(expected)})`);
}

// decision:invitation-keyed-by-email: workspace_members.createRule is null — only a superuser (or the R3 accept
// route) mints a membership row now, so fixture setup below creates directly as superuser.
const SU_EMAIL = process.env.PB_SUPERUSER_EMAIL ?? "ci@example.test";
const SU_PASSWORD = process.env.PB_SUPERUSER_PASSWORD ?? "ci-battery-dummy-pw-000";

async function superuser_token(): Promise<string | null> {
  const [s, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  return s === 200 ? (r.token ?? null) : null;
}

const su = await superuser_token();

const [alice, ALICE_ID] = await login("alice@example.com");
const [bob, BOB_ID] = await login("bob@example.com");
const [carol, CAROL_ID] = await login("carol@example.com");

// Each user resolves their OWN project by name; Bob's id is never used to
// prove Alice can see Bob's data.
const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob);
const ALICE_WORKSPACE = await find_id("workspaces", "name", "Alice's Workspace", alice);
const TODO_STATUS = await status_id(ALICE_WORKSPACE, "todo", alice);
const DOING_STATUS = await status_id(ALICE_WORKSPACE, "doing", alice);

let s: number;
let r: any;

console.log("\n── LIST: each sees tasks whose project they own OR are assigned to ──");
for (const [who, tok] of [
  ["Alice", alice],
  ["Bob", bob],
] as const) {
  [, r] = await api("GET", "/api/collections/tasks/records?expand=project", tok);
  const rows: string[] = [];
  for (const i of r.items) {
    // expand is OMITTED when you lack view access to the related record
    const expand = i.expand === undefined ? {} : i.expand;
    const project = expand.project === undefined ? {} : expand.project;
    const proj = project.name === undefined ? "<project hidden by rule>" : project.name;
    rows.push(`${i.title} (proj=${proj})`);
  }
  console.log(`  ${who} sees ${rows.length}: ${py_str(rows)}`);
}

// COVERS: rule:tasks.create
console.log("\n── CREATE: only in a project you own (project.owner traversal) ──");
let made: any;
[s, made] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "RULE-TEST fixture",
  status: TODO_STATUS,
  project: ALICE_PROJECT,
  assignee: BOB_ID,
});
check("Alice adds task to HER project", s, 200);
const fixture = made.id;
[s] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "Intruder",
  status: TODO_STATUS,
  project: BOB_PROJECT,
});
check("Alice adds task to BOB's project (blocked)", s, 400);

// COVERS: rule:tasks.update
console.log("\n── UPDATE: the assignee (not owner) can edit ──");
[s] = await api("PATCH", `/api/collections/tasks/records/${fixture}`, bob, {
  status: DOING_STATUS,
});
check("Bob (assignee) updates the fixture task", s, 200);

console.log("\n── DELETE: member traps to trash; owner/admin purges (W3 #66) ──");
// COVERS: rule:tasks.delete
[s] = await api("DELETE", `/api/collections/tasks/records/${fixture}`, bob); // member → trash
check("Bob (member/assignee) delete → traps task to trash (204, W3 #66)", s, 204);
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
[s, r] = await api("GET", `/api/collections/tasks/records/${fixture}`, bob);
check("trashed task is 404 by id too (card htsr: viewRule mirrors listRule)", s, 404);
[s, r] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, bob);
const row = (r.items ?? []).find((i: any) => ((i.record ?? null) || {}).id === fixture) ?? {};
check(
  "the task survived the trap and reaches the member through GET /api/tracker/trash",
  tup(s, truthy(((row.record ?? null) || {}).trashed)),
  tup(200, true),
);
[s, r] = await api("GET", "/api/collections/tasks/records", bob);
check(
  "trashed task absent from member's list",
  (r.items ?? []).map((i: any) => i.id).includes(fixture),
  false,
);
[s] = await api("DELETE", `/api/collections/tasks/records/${fixture}`, alice); // owner → second-delete purge
check("Alice (project owner) purges the trashed task (204)", s, 204);

// ── ANON WRITE GUARD (TASK-049) ───────────────────────────────────────────────
// decision:tasks-have-no-default-assignee: a bare create is Unassigned, so the read-back is the guard that these probes
// are not passing on an assignee branch nothing here submitted.
async function unassigned_task(title: string): Promise<string> {
  const [s, made] = await api("POST", "/api/collections/tasks/records", alice, {
    title,
    status: TODO_STATUS,
    project: ALICE_PROJECT,
  });
  check(`setup: '${title}' created unassigned`, tup(s, made.assignee ?? null), tup(200, ""));
  return made.id;
}

const made_tasks: string[] = [];
let back: any;

// COVERS: rule:tasks.update
console.log("\n── ANON WRITES: an UNASSIGNED task is not world-writable (TASK-049) ──");
let t = await unassigned_task("ANON title");
made_tasks.push(t);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, null, { title: "PWNED BY ANON" });
check("anon PATCH title on unassigned task (denied)", s, 404);
[, back] = await api("GET", `/api/collections/tasks/records/${t}`, alice);
check("  ↳ title unchanged (owner read-back)", back.title ?? null, "ANON title");

t = await unassigned_task("ANON empty body");
made_tasks.push(t);
// An empty-body PATCH that passes the rule returns the WHOLE record — a read leak around the anon-cannot-view-tasks 404.
let leaked: any;
[s, leaked] = await api("PATCH", `/api/collections/tasks/records/${t}`, null, {});
check("anon PATCH {} on unassigned task (denied)", s, 404);
check("  ↳ no record fields returned", leaked.title ?? null, null);

t = await unassigned_task("ANON trashed");
made_tasks.push(t);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, null, {
  trashed: "2020-01-01 00:00:00",
});
check("anon PATCH trashed= (delayed-purge chain, denied)", s, 404);
[, back] = await api("GET", `/api/collections/tasks/records/${t}`, alice);
check("  ↳ trashed still empty (owner read-back)", back.trashed ?? null, "");

t = await unassigned_task("ANON detach");
made_tasks.push(t);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, null, { project: "" });
check('anon PATCH project="" (detach, denied)', s, 404);
[, back] = await api("GET", `/api/collections/tasks/records/${t}`, alice);
check("  ↳ project unchanged (owner read-back)", back.project ?? null, ALICE_PROJECT);

t = await unassigned_task("ANON assignee");
made_tasks.push(t);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, null, { assignee: BOB_ID });
check("anon PATCH assignee=<member> (denied)", s, 404);
[, back] = await api("GET", `/api/collections/tasks/records/${t}`, alice);
check("  ↳ assignee still empty (owner read-back)", back.assignee ?? null, "");

console.log("\n── AUTHORIZED UPDATES on the SAME unassigned shape still work ──");
t = await unassigned_task("ROLE matrix");
made_tasks.push(t);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, alice, { title: "owner edit" });
check("Alice (workspace owner) updates", s, 200);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, bob, { title: "member edit" });
check("Bob (member) updates", s, 200);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, carol, { title: "outsider edit" });
check("Carol (non-member) updates (denied)", s, 404);

[s, r] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: CAROL_ID,
  role: "admin",
  status: "active",
});
check("setup: superuser adds Carol as an admin member", [200, 201].includes(s), true);
const carol_admin = await tierkit.actor_at_tier(
  ALICE_WORKSPACE!,
  CAROL_ID,
  "admin",
  alice,
  "Carol",
);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, carol, { title: "admin edit" });
check("Carol (admin member) updates", tup(await carol_admin.now(), s), tup("admin", 200));
await carol_admin.done();
[s] = await api("DELETE", `/api/collections/workspace_members/records/${carol_admin.id}`, alice);
check("cleanup: admin membership removed", s, 204);

// The viewer-denied and viewer+assignee-allowed checks below are a PAIR: same actor, same tier,
// the assignee bit the only difference — together they isolate the `assignee =` clause.
[s, r] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: CAROL_ID,
  role: "viewer",
  status: "active",
});
check("setup: superuser adds Carol as a viewer", [200, 201].includes(s), true);
const carol_viewer = await tierkit.actor_at_tier(
  ALICE_WORKSPACE!,
  CAROL_ID,
  "viewer",
  alice,
  "Carol",
);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, carol, { title: "viewer edit" });
// A Carol with no membership in THIS workspace is denied by the same 404, so the scoped tier
// rides in the assertion — this check exists to prove the VIEWER clause specifically.
check(
  "Carol (viewer, NOT assignee) updates (denied)",
  tup(await carol_viewer.now(), s),
  tup("viewer", 404),
);
[s] = await api("PATCH", `/api/collections/tasks/records/${t}`, alice, { assignee: CAROL_ID });
check("setup: Alice assigns the task to Carol", s, 200);
let assigned: any;
[, assigned] = await api("GET", `/api/collections/tasks/records/${t}`, alice);
check("  ↳ read-back confirms Carol is the assignee", assigned.assignee ?? null, CAROL_ID);
[s, r] = await api("PATCH", `/api/collections/tasks/records/${t}`, carol, {
  title: "assignee edit",
});
// Same tier as the denial above (member/admin would grant this 200 through the member clause
// instead), so the tier rides here too; what the pair does NOT read is the rule text itself.
check(
  "Carol (viewer AND assignee) updates",
  tup(await carol_viewer.now(), s, r.title ?? null),
  tup("viewer", 200, "assignee edit"),
);
await carol_viewer.done();
[s] = await api("DELETE", `/api/collections/workspace_members/records/${carol_viewer.id}`, alice);
check("cleanup: viewer membership removed", s, 204);

await tierkit.verify_tiers();

for (const tid of made_tasks) {
  await api("DELETE", `/api/collections/tasks/records/${tid}`, alice); // 1st → trash
  await api("DELETE", `/api/collections/tasks/records/${tid}`, alice); // 2nd → purge
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
  process.exit(0);
}

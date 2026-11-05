#!/usr/bin/env bun
/**
 * E2E proof of dual-scope items: workspace + optional project on
 * tasks/decisions/documents, required project on milestones, draft flag on
 * decisions/documents/milestones, rescope, and project-trash cascading to
 * project-scoped items of all types.
 *
 * verify_grep tokens for MODEL_DIR/target/*.yml — do not rename without
 * updating the model target facets in lockstep:
 *     workspace-immutable
 *     projects-workspace-immutable
 *     project-must-belong-to-workspace
 *     workspace-defaulted-from-project
 *     project-defaulted-from-default-project
 *     scope.rescope
 */

import fs from "node:fs";
import path from "node:path";
import {
  py_get,
  by_code_point,
  os_walk,
  py_join,
  py_str,
  py_strip,
  read_text,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

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
): Promise<any> {
  const filt = `${field}='${esc(value)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

async function status_id(ws_id: any, word: string, tok: string | null): Promise<any> {
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
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_str(got)} (expected one of ${py_str(tup(...allowed))})`,
  );
}

async function list_has(
  collection: string,
  rid: string,
  token: string | null,
): Promise<[number, boolean]> {
  // True iff a plain id-filtered LIST returns the record — the direct proof
  // of listRule visibility (present/absent from the primary LIST surface).
  const qs = urlencode({ filter: `id='${esc(rid)}'` });
  const [s, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return [s, truthy(r.items)];
}

async function su_list_all(
  collection: string,
  token: string | null,
  expand: string | null = null,
): Promise<any[]> {
  const qs: Record<string, any> = { perPage: 200 };
  if (expand) qs.expand = expand;
  const [, r] = await api("GET", `/api/collections/${collection}/records?${urlencode(qs)}`, token);
  return r.items || [];
}

function title_field(collection: string): string {
  return ["milestones", "labels", "templates"].includes(collection) ? "name" : "title";
}

const CREATED: [string, string][] = []; // (collection, id) — hard-purged in cleanup

function track(collection: string, rid: any): any {
  if (rid) CREATED.push(tup(collection, rid));
  return rid;
}

let _lb: any;
let _mr: any;
let _shadow: any;
let back: any;
let made: any;
let p_s12: any;
let proj_a2: any;
let proj_s11: any;
let proj_s8: any;
let r: any;
let s: number;
let t_plain: any;
let t_scoped: any;
let ws_a2: any;
let ws_row: any;

let body: any;
let rid: any;
let resp: any;
let ws: any;
let _qs: any;
let s2: number;
let present: boolean;
let proj: any;
let expanded: any;
let proj_ws: any;
// ── Superuser + base fixtures ──────────────────────────────────────────────
const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
[, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su = roomkit.token_of(PB, SU_EMAIL, r);

const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");
const [carol, carol_id] = await login("carol@example.com");

const ALICE_WORKSPACE = await find_id("workspaces", "name", "Alice's Workspace", su);
const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", su);
const BOB_WORKSPACE = await find_id("workspaces", "name", "Bob's Workspace", su);
const BOB_PROJECT = await find_id("projects", "name", "Mobile App", su);
// Carol: no owner/member relationship to A or B — S10's foreign-project fixture.
const CAROL_PROJECT = await find_id("projects", "name", "My Project", su);
// decision-052: an item created with no project lands here. Only a superuser can resolve it —
// the projects rules exclude it from list and view for every tenant role.
[, _shadow] = await api(
  "GET",
  "/api/collections/projects/records?" +
    urlencode({ filter: `workspace='${esc(ALICE_WORKSPACE)}' && shadow=true` }),
  su,
);
const ALICE_SHADOW_PROJECT = (_shadow.items?.length ? _shadow.items : [{}])[0].id ?? null;
check("setup: Alice's shadow project resolved", ALICE_SHADOW_PROJECT !== null, true);
check("setup: Alice's workspace resolved", ALICE_WORKSPACE !== null, true);
check("setup: Alice's project resolved", ALICE_PROJECT !== null, true);
check("setup: Bob's workspace resolved", BOB_WORKSPACE !== null, true);
check("setup: Bob's project resolved", BOB_PROJECT !== null, true);
check("setup: Carol's (foreign) project resolved", CAROL_PROJECT !== null, true);

// status is a relation scoped per-workspace; BOB_TODO_STATUS belongs to ws B —
// the cross-workspace-status 400 fixture (S6).
const ALICE_TODO_STATUS = await status_id(ALICE_WORKSPACE, "todo", su);
const BOB_TODO_STATUS = await status_id(BOB_WORKSPACE, "todo", su);
check("setup: Alice's ws 'Todo' status resolved", ALICE_TODO_STATUS !== null, true);
check("setup: Bob's ws 'Todo' status resolved (cross-ws fixture)", BOB_TODO_STATUS !== null, true);

console.log(
  "\n── S1: backfill totality — tasks.workspace non-empty + == project.workspace; milestones.project non-empty ──",
);
let all_tasks = await su_list_all("tasks", su, "project");
const ws_mismatches: string[] = [];
for (const t of all_tasks) {
  ws = t.workspace || "";
  if (!ws) {
    ws_mismatches.push(`${t.id}: empty workspace`);
    continue;
  }
  proj = t.project || "";
  if (proj) {
    expanded = (t.expand || {}).project || {};
    proj_ws = expanded.workspace;
    if (proj_ws !== ws) {
      ws_mismatches.push(`${t.id}: workspace=${ws} != project.workspace=${proj_ws}`);
    }
  }
}
check(
  "S1: every task.workspace non-empty and == project.workspace when project set",
  ws_mismatches,
  [],
);

let all_miles = await su_list_all("milestones", su);
const mile_empties = all_miles.filter((m: any) => !m.project).map((m: any) => m.id);
check("S1: every milestone has a non-empty project", mile_empties, []);

// COVERS: hook:scope.pb.js#onRecordCreate:tasks, hook:scope.pb.js#onRecordCreate:decisions, hook:scope.pb.js#onRecordCreate:documents, hook:scope.pb.js#onRecordCreate:milestones
console.log(
  "\n── S2: mismatch on CREATE (workspace=A, project=ws-B project) → 400, all four collections ──",
);
for (const col of ["tasks", "decisions", "documents", "milestones"]) {
  body = {
    [title_field(col)]: `scope-test S2 ${col}`,
    workspace: ALICE_WORKSPACE,
    project: BOB_PROJECT,
  };
  if (col === "tasks") {
    body.status = ALICE_TODO_STATUS;
  }
  [s] = await api("POST", `/api/collections/${col}/records`, alice, body);
  check(
    `S2 [${col}]: create with mismatched workspace/project → 400 (project-must-belong-to-workspace)`,
    s,
    400,
  );

  // item starts project-scoped within ws A so the update only changes `project`.
  // COVERS: hook:scope.pb.js#onRecordUpdate:tasks, hook:scope.pb.js#onRecordUpdate:decisions, hook:scope.pb.js#onRecordUpdate:documents, hook:scope.pb.js#onRecordUpdate:milestones
}
console.log(
  "\n── S3: mismatch on UPDATE (patch project → ws-B project) → 400, all four collections ──",
);
for (const col of ["tasks", "decisions", "documents", "milestones"]) {
  body = {
    [title_field(col)]: `scope-test S3 ${col}`,
    workspace: ALICE_WORKSPACE,
    project: ALICE_PROJECT,
  };
  if (col === "tasks") {
    body.status = ALICE_TODO_STATUS;
  }
  [s, made] = await api("POST", `/api/collections/${col}/records`, alice, body);
  check_in(`S3 setup [${col}]: create a valid ws-A project-scoped item`, s, [200, 201]);
  rid = track(col, made["id"]);
  [s] = await api("PATCH", `/api/collections/${col}/records/${rid}`, alice, {
    project: BOB_PROJECT,
  });
  check(
    `S3 [${col}]: update project to a ws-B project → 400 (project-must-belong-to-workspace)`,
    s,
    400,
  );

  // item starts workspace-scoped (no project) to isolate the immutability guard
  // from the mismatch guard (S3).
  // COVERS: hook:scope.pb.js#onRecordUpdateRequest:tasks, hook:scope.pb.js#onRecordUpdateRequest:decisions, hook:scope.pb.js#onRecordUpdateRequest:documents
}
console.log("\n── S4: workspace-immutable — patch workspace → ws B → 400, all four collections ──");
for (const col of ["tasks", "decisions", "documents"]) {
  body = { [title_field(col)]: `scope-test S4 ${col}`, workspace: ALICE_WORKSPACE };
  if (col === "tasks") {
    body.status = ALICE_TODO_STATUS;
  }
  [s, made] = await api("POST", `/api/collections/${col}/records`, alice, body);
  check_in(`S4 setup [${col}]: create a ws-A workspace-scoped item`, s, [200, 201]);
  rid = track(col, made["id"]);
  [s] = await api("PATCH", `/api/collections/${col}/records/${rid}`, alice, {
    workspace: BOB_WORKSPACE,
  });
  check(`S4 [${col}]: update workspace to ws B → 400 (workspace-immutable)`, s, 400);
  // COVERS: hook:scope.pb.js#onRecordUpdateRequest:milestones
  // milestones.project is required — prove immutability on a project-scoped one.
}
[s, made] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "scope-test S4 milestones",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
});
check_in("S4 setup [milestones]: create a ws-A project-scoped milestone", s, [200, 201]);
rid = track("milestones", made["id"]);
[s] = await api("PATCH", `/api/collections/milestones/records/${rid}`, alice, {
  workspace: BOB_WORKSPACE,
});
check("S4 [milestones]: update workspace to ws B → 400 (workspace-immutable)", s, 400);

console.log("\n── S4b: milestones.target date coercion (G3 #74) ──");
[s, made] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "target-coercion good",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
  target: "2026-12-01",
});
check_in("S4b: create milestone with a well-formed target date → 201", s, [200, 201]);
rid = track("milestones", made["id"]);
check(
  "S4b: well-formed target persisted (starts with 2026-12-01)",
  py_str(py_get(made, "target", "")).startsWith("2026-12-01"),
  true,
);

[s, made] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "target-coercion bad",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
  target: "not-a-date",
});
check_in(
  "S4b: create milestone with an unparseable target → 200/201 (coerced, not 400)",
  s,
  tup(200, 201),
);
rid = track("milestones", made["id"]);
check("S4b: unparseable target coerced to empty string", py_get(made, "target", ""), "");

// COVERS: hook:scope.pb.js#onRecordUpdateRequest:decisions
console.log(
  "\n── S5: scope.rescope — Bob (member) moves an item's project within ws A → all 200 ──",
);
[s, proj_a2] = await api("POST", "/api/collections/projects/records", alice, {
  name: "scope-test: rescope target",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("S5 setup: Alice creates a second ws-A project (rescope target)", s, [200, 201]);
const PROJECT_A2 = track("projects", proj_a2["id"]);

[s, made] = await api("POST", "/api/collections/decisions/records", alice, {
  title: "scope-test S5 decision",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
});
check_in("S5 setup: create a ws-A project-scoped decision", s, [200, 201]);
const D_S5 = track("decisions", made["id"]);

[s] = await api("PATCH", `/api/collections/decisions/records/${D_S5}`, bob, { project: "" });
check("S5: Bob (member) clears project (project-scoped → workspace-scoped) → 200", s, 200);
[s2, present] = await list_has("decisions", D_S5, bob);
check("S5: item stays visible to Bob after clearing project", tup(s2, present), tup(200, true));

[s] = await api("PATCH", `/api/collections/decisions/records/${D_S5}`, bob, {
  project: PROJECT_A2,
});
check("S5: Bob (member) sets project to another ws-A project → 200 (scope.rescope)", s, 200);
[s2, present] = await list_has("decisions", D_S5, bob);
check(
  "S5: item stays visible to Bob after rescoping to another project",
  tup(s2, present),
  tup(200, true),
);

// status validates against the task's OWN workspace when there's no project;
// assignee is left alone (decision-042: a bare create is Unassigned).
// COVERS: hook:scope.pb.js#onRecordCreateRequest:tasks, hook:main.pb.js#onRecordCreateRequest:tasks
console.log("\n── S6: workspace-scoped task lifecycle (workspace=A, no project) ──");
[s, made] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "scope-test S6 task",
  status: ALICE_TODO_STATUS,
  workspace: ALICE_WORKSPACE,
});
check_in("S6: create a workspace-scoped task (workspace=A, no project) → 201", s, [200, 201]);
const TASK_S6 = track("tasks", made["id"]);
check(
  "S6: created task lands in the workspace shadow project (decision-052)",
  py_get(made, "project", ""),
  ALICE_SHADOW_PROJECT,
);
check("S6: workspace-scoped bare create stays unassigned", made["assignee"], "");

[s] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "scope-test S6 bad-status",
  status: BOB_TODO_STATUS,
  workspace: ALICE_WORKSPACE,
});
check("S6: workspace-scoped task with a status from a DIFFERENT workspace (ws B) → 400", s, 400);

[s2, present] = await list_has("tasks", TASK_S6, bob);
check("S6: workspace-scoped task visible in Bob's (member) LIST", tup(s2, present), tup(200, true));

console.log(
  "\n── S7: milestone project placement — create with only workspace=A → the workspace container ──",
);
[, ws_row] = await api("GET", `/api/collections/workspaces/records/${ALICE_WORKSPACE}`, su);
const ALICE_DEFAULT_PROJECT = ws_row["default_project"];
check("S7 setup: ws A has a non-empty default_project", truthy(ALICE_DEFAULT_PROJECT), true);

[s, made] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "scope-test S7 milestone",
  workspace: ALICE_WORKSPACE,
});
check_in("S7: create a milestone with only workspace=A → 201", s, [200, 201]);
const MILESTONE_S7 = track("milestones", made["id"]);
check(
  "S7: milestone.project placed in the workspace shadow project (project-placed-in-workspace-container)",
  made["project"],
  ALICE_SHADOW_PROJECT,
);
check(
  "S7: and NOT in the workspace default_project, which no longer decides this",
  made.project !== ALICE_DEFAULT_PROJECT,
  true,
);

// purge cascades via `cascadeDelete=true` on the projects relation — no
// project-specific trash hook needed; a workspace-scoped (no-project) item
// in the same workspace must survive both the trash and the purge.
console.log(
  "\n── S8: D5 project lifecycle — trash/restore/purge cascades project-scoped items of all four types ──",
);
[s, proj_s8] = await api("POST", "/api/collections/projects/records", alice, {
  name: "scope-test S8 project",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("S8 setup: Alice creates project_s8", s, [200, 201]);
const PROJECT_S8 = proj_s8["id"]; // own delete lifecycle, tracked separately below

[s, made] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "scope-test S8 task",
  status: ALICE_TODO_STATUS,
  project: PROJECT_S8,
});
check_in("S8 setup: create a project_s8-scoped task", s, [200, 201]);
const TASK_S8 = made["id"];
[s, made] = await api("POST", "/api/collections/decisions/records", alice, {
  title: "scope-test S8 decision",
  workspace: ALICE_WORKSPACE,
  project: PROJECT_S8,
});
check_in("S8 setup: create a project_s8-scoped decision", s, [200, 201]);
const DEC_S8 = made["id"];
[s, made] = await api("POST", "/api/collections/documents/records", alice, {
  title: "scope-test S8 document",
  workspace: ALICE_WORKSPACE,
  project: PROJECT_S8,
});
check_in("S8 setup: create a project_s8-scoped document", s, [200, 201]);
const DOC_S8 = made["id"];
[s, made] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "scope-test S8 milestone",
  workspace: ALICE_WORKSPACE,
  project: PROJECT_S8,
});
check_in("S8 setup: create a project_s8-scoped milestone", s, [200, 201]);
const MIL_S8 = made["id"];
[s, made] = await api("POST", "/api/collections/decisions/records", alice, {
  title: "scope-test S8 ws-scoped decision",
  workspace: ALICE_WORKSPACE,
});
check_in("S8 setup: create a decision in the same workspace submitting no project", s, [200, 201]);
const WSDEC_S8 = track("decisions", made["id"]);
check(
  "S8 setup: it landed in the workspace shadow project, not project_s8 (decision-052)",
  made["project"],
  ALICE_SHADOW_PROJECT,
);

[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_S8}`, alice);
check("S8: Alice (owner) first DELETE on project_s8 → 204 (trash)", s, 204);

[s2, present] = await list_has("tasks", TASK_S8, alice);
check(
  "S8: project_s8-scoped task ABSENT from LIST after project trash",
  tup(s2, present),
  tup(200, false),
);
[s2, present] = await list_has("decisions", DEC_S8, alice);
check(
  "S8: project_s8-scoped decision ABSENT from LIST after project trash",
  tup(s2, present),
  tup(200, false),
);
[s2, present] = await list_has("documents", DOC_S8, alice);
check(
  "S8: project_s8-scoped document ABSENT from LIST after project trash",
  tup(s2, present),
  tup(200, false),
);
[s2, present] = await list_has("milestones", MIL_S8, alice);
check(
  "S8: project_s8-scoped milestone ABSENT from LIST after project trash",
  tup(s2, present),
  tup(200, false),
);
[s2, present] = await list_has("decisions", WSDEC_S8, alice);
check(
  "S8: shadow-project decision still PRESENT after project_s8 trash",
  tup(s2, present),
  tup(200, true),
);

[s] = await api("PATCH", `/api/collections/projects/records/${PROJECT_S8}`, alice, { trashed: "" });
check("S8: Alice restores project_s8 (trashed='') → 200", s, 200);
[s2, present] = await list_has("tasks", TASK_S8, alice);
check(
  "S8: project_s8-scoped task reappears in LIST after restore",
  tup(s2, present),
  tup(200, true),
);
[s2, present] = await list_has("decisions", DEC_S8, alice);
check(
  "S8: project_s8-scoped decision reappears in LIST after restore",
  tup(s2, present),
  tup(200, true),
);
[s2, present] = await list_has("documents", DOC_S8, alice);
check(
  "S8: project_s8-scoped document reappears in LIST after restore",
  tup(s2, present),
  tup(200, true),
);
[s2, present] = await list_has("milestones", MIL_S8, alice);
check(
  "S8: project_s8-scoped milestone reappears in LIST after restore",
  tup(s2, present),
  tup(200, true),
);

[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_S8}`, alice);
check("S8: Alice re-trashes project_s8 (first DELETE since restore) → 204", s, 204);
[s] = await api("DELETE", `/api/collections/projects/records/${PROJECT_S8}`, alice);
check(
  "S8: Alice (owner) second DELETE on trashed project_s8 → 204 (purge, cascadeDelete=TRUE)",
  s,
  204,
);

[s] = await api("GET", `/api/collections/tasks/records/${TASK_S8}`, alice);
check("S8: project_s8-scoped task purged (GET 404)", s, 404);
[s] = await api("GET", `/api/collections/decisions/records/${DEC_S8}`, alice);
check("S8: project_s8-scoped decision purged (GET 404)", s, 404);
[s] = await api("GET", `/api/collections/documents/records/${DOC_S8}`, alice);
check("S8: project_s8-scoped document purged (GET 404)", s, 404);
[s] = await api("GET", `/api/collections/milestones/records/${MIL_S8}`, alice);
check("S8: project_s8-scoped milestone purged (GET 404)", s, 404);
[s] = await api("GET", `/api/collections/decisions/records/${WSDEC_S8}`, alice);
check("S8: shadow-project decision survives the project_s8 purge (GET 200)", s, 200);

console.log("\n── S9: draft flags — decisions/documents/milestones ──");
[s, made] = await api("POST", "/api/collections/decisions/records", alice, {
  title: "scope-test S9 draft decision",
  workspace: ALICE_WORKSPACE,
  draft: true,
});
check_in("S9: create a draft decision → 201", s, [200, 201]);
track("decisions", made["id"]);
check("S9: draft decision persists draft=true", made["draft"], true);

[s, made] = await api("POST", "/api/collections/documents/records", alice, {
  title: "scope-test S9 draft document",
  workspace: ALICE_WORKSPACE,
  draft: true,
});
check_in("S9: create a draft document → 201", s, [200, 201]);
track("documents", made["id"]);
check("S9: draft document persists draft=true", made["draft"], true);

[s, made] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "scope-test S9 draft milestone",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
  draft: true,
});
check_in("S9: create a draft milestone → 201", s, [200, 201]);
track("milestones", made["id"]);
check("S9: draft milestone persists draft=true", made["draft"], true);

// dual-path createRule: project-only create defaults workspace from
// project.workspace; a genuinely-foreign project is denied.
// COVERS: hook:scope.pb.js#onRecordCreateRequest:tasks, rule:tasks.create
console.log("\n── S10: Bob (member) project-only task create — dual-path createRule proof ──");
[s, made] = await api("POST", "/api/collections/tasks/records", bob, {
  title: "scope-test S10 project-only",
  status: ALICE_TODO_STATUS,
  project: ALICE_PROJECT,
});
check_in("S10: Bob (member) creates a task with ONLY project=ws-A project → 201", s, [200, 201]);
const TASK_S10 = track("tasks", made["id"]);
check(
  "S10: created task's workspace was defaulted to project.workspace (workspace-defaulted-from-project)",
  made["workspace"],
  ALICE_WORKSPACE,
);

[s] = await api("POST", "/api/collections/tasks/records", bob, {
  title: "scope-test S10 foreign-project",
  status: ALICE_TODO_STATUS,
  project: CAROL_PROJECT,
});
check(
  "S10: Bob creates a task with ONLY a genuinely-foreign project (Carol's) → 400 (createRule denial)",
  s,
  400,
);

// The D1 guard rides the UNIVERSAL create/update tier for all six guarded collections
// (TASK-057 tasks, TASK-075 the rest), so it also fires for programmatic e.app.save().
// main.pb.js's leaver-unassign sweep wraps its WHOLE loop in one try/catch, so a guard that
// threw on an ALREADY-incoherent row would swallow the error and strand every remaining
// assignee — silently re-opening TASK-055. TASK-071 closed the tenant route to incoherence,
// so building one now needs the superuser that scope.pb.js's projects guard deliberately
// exempts.
// COVERS: hook:main.pb.js#onRecordAfterDeleteSuccess:workspace_members
console.log(
  "\n── S11: an incoherent row of EVERY guarded collection must not abort the leaver sweep ──",
);
// owner must be passed explicitly: the owner-forcing hook reads e.auth, which is undefined
// for a superuser create, and projects.owner is required
[s, proj_s11] = await api("POST", "/api/collections/projects/records", su, {
  name: "scope-test S11 project",
  workspace: ALICE_WORKSPACE,
  owner: alice_id,
});
check_in("S11: su creates a dedicated project in ws-A", s, [200, 201]);
const P_S11 = track("projects", proj_s11["id"]);

[s, t_scoped] = await api("POST", "/api/collections/tasks/records", su, {
  title: "scope-test S11 project-scoped",
  status: ALICE_TODO_STATUS,
  workspace: ALICE_WORKSPACE,
  project: P_S11,
  assignee: bob_id,
});
check_in("S11: su creates a project-scoped task assigned to Bob", s, [200, 201]);
const T_SCOPED = track("tasks", t_scoped["id"]);

[s, t_plain] = await api("POST", "/api/collections/tasks/records", su, {
  title: "scope-test S11 project-less",
  status: ALICE_TODO_STATUS,
  workspace: ALICE_WORKSPACE,
  assignee: bob_id,
});
check_in("S11: su creates a project-less task assigned to Bob", s, [200, 201]);
const T_PLAIN = track("tasks", t_plain["id"]);

const GUARDED = tup("decisions", "documents", "milestones", "labels", "templates");
const S11_ROWS: Record<string, any> = {};
for (const col of GUARDED) {
  body = {
    [title_field(col)]: `scope-test S11 ${col}`,
    workspace: ALICE_WORKSPACE,
    project: P_S11,
  };
  if (col === "templates") {
    body.type = "task";
  }
  [s, made] = await api("POST", `/api/collections/${col}/records`, su, body);
  check_in(`S11 [${col}]: su creates a coherent project-scoped row`, s, [200, 201]);
  S11_ROWS[col] = track(col, made["id"]);

  // Rescoping the PROJECT (not the items) strands every row still pointing at it: each row's
  // own workspace still says ws-A while project.workspace now says ws-B.
}
[s] = await api("PATCH", `/api/collections/projects/records/${P_S11}`, su, {
  workspace: BOB_WORKSPACE,
});
check("S11: su rescopes the project to ws-B → 200 (superuser exemption, TASK-071)", s, 200);
[s, back] = await api("GET", `/api/collections/tasks/records/${T_SCOPED}`, su);
check(
  "S11: the project-scoped task is now incoherent (its workspace != project.workspace)",
  back.workspace === ALICE_WORKSPACE && back.project === P_S11,
  true,
);

// The touchesScope predicate: a save that changes neither scope field must pass on an
// already-incoherent row, and one that touches the pair must still be refused.
[s] = await api("PATCH", `/api/collections/tasks/records/${T_SCOPED}`, su, {
  title: "scope-test S11 project-scoped (retitled)",
});
check("S11 [tasks]: su title-only PATCH on the stranded task → 200", s, 200);
for (const col of GUARDED) {
  [s] = await api("PATCH", `/api/collections/${col}/records/${S11_ROWS[col]}`, su, {
    [title_field(col)]: `scope-test S11 ${col} (renamed)`,
  });
  check(
    `S11 [${col}]: su title-only PATCH on an incoherent row → 200 (touchesScope predicate)`,
    s,
    200,
  );
  [s] = await api("PATCH", `/api/collections/${col}/records/${S11_ROWS[col]}`, su, {
    project: BOB_PROJECT,
  });
  check(`S11 [${col}]: su PATCH that TOUCHES the scope pair on an incoherent row → 400`, s, 400);

  // must match BOTH fields — Bob also has a membership row in his OWN workspace
}
_qs = urlencode({ filter: `workspace='${esc(ALICE_WORKSPACE)}' && user='${esc(bob_id)}'` });
[, _mr] = await api("GET", `/api/collections/workspace_members/records?${_qs}`, su);
const MEMBER_ROW = (_mr.items?.length ? _mr.items : [{}])[0].id ?? null;
check("S11: found Bob's ws-A membership row", truthy(MEMBER_ROW), true);
[s] = await api("DELETE", `/api/collections/workspace_members/records/${MEMBER_ROW}`, su);
check_in("S11: su removes Bob's ws-A membership (fires the leaver-unassign sweep)", s, [204, 200]);

[s, back] = await api("GET", `/api/collections/tasks/records/${T_SCOPED}`, su);
check(
  "S11: the INCOHERENT task was still unassigned (guard must not throw on it)",
  back["assignee"],
  "",
);
[s, back] = await api("GET", `/api/collections/tasks/records/${T_PLAIN}`, su);
check(
  "S11: the coherent task in the same sweep was unassigned too (loop not aborted)",
  back["assignee"],
  "",
);

// restore Bob's membership so the shared room is left as we found it
[s] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: bob_id,
  role: "member",
  status: "active",
});
check_in("S11: restore Bob's ws-A membership", s, [200, 201]);
let bob_tier = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "member", su, "Bob");

// COVERS: hook:scope.pb.js#onRecordUpdateRequest:projects
console.log("\n── S12: projects.workspace is immutable below the superuser tier (TASK-071) ──");
[s, ws_a2] = await api("POST", "/api/collections/workspaces/records", alice, {
  name: "scope-test S12 second workspace",
  owner: alice_id,
});
check_in("S12 setup: Alice creates a second workspace she also owns", s, [200, 201]);
const WS_A2 = track("workspaces", ws_a2["id"]);
[s, p_s12] = await api("POST", "/api/collections/projects/records", alice, {
  name: "scope-test S12 project",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check_in("S12 setup: Alice creates a ws-A project", s, [200, 201]);
const P_S12 = track("projects", p_s12["id"]);

[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, null, { workspace: WS_A2 });
check("S12: anon patches projects.workspace → 404 (update denied)", s, 404);
[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, carol, { workspace: WS_A2 });
check("S12: non-member patches projects.workspace → 404 (update denied)", s, 404);
[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, bob, { workspace: WS_A2 });
// decision-023 widened projects.updateRule to non-viewer members, so Bob now PASSES the rule
// and the immutability hook (scope.pb.js) rejects the repoint → 400, not a rule-denial 404.
// bob_tier is resolved by (workspace,user), because a row in ANY OTHER workspace reads 'member'.
check(
  "S12: plain member patches projects.workspace → 400 (projects-workspace-immutable)",
  tup(await bob_tier.now(), s),
  tup("member", 400),
);

bob_tier = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "admin", su, "Bob");
[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, bob, { workspace: WS_A2 });
check(
  "S12: workspace admin patches projects.workspace → 400 (projects-workspace-immutable)",
  tup(await bob_tier.now(), s),
  tup("admin", 400),
);
bob_tier = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "member", su, "Bob");

[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, alice, { workspace: WS_A2 });
check(
  "S12: workspace owner (owns BOTH workspaces) patches projects.workspace → 400 " +
    "(projects-workspace-immutable)",
  s,
  400,
);
[, back] = await api("GET", `/api/collections/projects/records/${P_S12}`, su);
check("S12: the project did not move", back["workspace"], ALICE_WORKSPACE);
[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, alice, {
  name: "scope-test S12 renamed",
});
check("S12: workspace owner patches a NON-scope field → 200 (guard does not over-fire)", s, 200);
[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, alice, {
  workspace: ALICE_WORKSPACE,
});
check("S12: workspace owner re-submits the SAME workspace → 200 (a no-op is not a move)", s, 200);
[s] = await api("PATCH", `/api/collections/projects/records/${P_S12}`, su, { workspace: WS_A2 });
check(
  "S12: superuser patches projects.workspace → 200 (exemption keeps S11 constructible)",
  s,
  200,
);

console.log("\n── S13: tripwires — guard tier and the saveNoValidate hole (TASK-072) ──");
const REPO_ROOT = path.dirname(import.meta.dir);
const _novalidate: string[] = [];
for (const _root of ["pb_hooks", "pb_migrations", "scripts"]) {
  for (const [_dirpath, _dirs, _names] of os_walk(py_join(REPO_ROOT, _root))) {
    for (const _nm of [..._names].sort(by_code_point)) {
      if (!(_nm.endsWith(".js") || _nm.endsWith(".ts"))) continue;
      const _p = py_join(_dirpath, _nm);
      // dotted call form only ($app./e.app.) — prose mentioning the API must not trip it
      if (read_text(_p, "replace").includes(".saveNoValidate(")) {
        _novalidate.push(path.relative(REPO_ROOT, _p));
      }
    }
  }
}
// saveNoValidate skips the relation validation the D1 guard leans on; a first call site
// means the "no live writer" bound in that guard's comment has to be re-derived.
check(
  "S13: no .saveNoValidate( call sites under pb_hooks/, pb_migrations/, scripts/",
  _novalidate,
  [],
);

const _scope_src = read_text(py_join(REPO_ROOT, "pb_hooks", "scope.pb.js"));
const _regs = new Set(
  [
    ..._scope_src.matchAll(
      /^(onRecord[\p{L}\p{N}_]+)\(\(e\) => \{.*?^\}, "([\p{L}\p{N}_]+)"\)/gmsu,
    ),
  ].map((m) => JSON.stringify([m[1], m[2]])),
);
for (const col of ["tasks", ...GUARDED]) {
  check(
    `S13 [${col}]: D1 guard registered on the UNIVERSAL create+update tier`,
    tup(
      _regs.has(JSON.stringify(["onRecordCreate", col])),
      _regs.has(JSON.stringify(["onRecordUpdate", col])),
    ),
    tup(true, true),
  );
}

console.log(
  "\n── S14: a DANGLING project id is rejected identically by all six guarded collections (TASK-080) ──",
);
const DANGLING_PROJECT = "zzzzzzzzzzzzzzz"; // syntactically valid record id, never issued
const SIX = ["tasks", ...GUARDED];
// the guard's message is the tier evidence: PB's own relation validation says "Failed to
// create record." with per-field data, so a message match proves WHICH tier answered.
const GUARD_NOUN: Record<string, string> = { labels: "label", templates: "template" };
for (const col of SIX) {
  body = {
    [title_field(col)]: `scope-test S14 ${col}`,
    workspace: ALICE_WORKSPACE,
    project: DANGLING_PROJECT,
  };
  if (col === "tasks") body.status = ALICE_TODO_STATUS;
  if (col === "templates") body.type = "task";
  [s, resp] = await api("POST", `/api/collections/${col}/records`, alice, body);
  check(
    `S14 [${col}]: create with a dangling project → 400, NOT 404 (project-must-belong-to-workspace)`,
    s,
    400,
  );
  check(
    `S14 [${col}]: the 400 is the universal coherence guard's, not PB relation validation`,
    py_get(resp, "message", ""),
    `Project must belong to the ${GUARD_NOUN[col] ?? "item"}'s workspace.`,
  );
  check(
    `S14 [${col}]: rejected, not silently created (no record carries the submitted title)`,
    await find_id(col, title_field(col), `scope-test S14 ${col}`, su),
    null,
  );
}

// The workspace-LESS shape reaches the hooks only as superuser: below that tier the dangling
// project makes every createRule branch unresolvable, so the request is denied before any hook.
console.log(
  "\n── S14b: the same dangling project id, workspace omitted (hook wsId-resolution sites) ──",
);
_qs = urlencode({ filter: `workspace='${esc(ALICE_WORKSPACE)}' && name='Bug'` });
[, _lb] = await api("GET", `/api/collections/labels/records?${_qs}`, su);
const ALICE_LABEL = (_lb.items?.length ? _lb.items : [{}])[0].id ?? null;
check("S14b setup: Alice's ws core label resolved", truthy(ALICE_LABEL), true);

[s] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "scope-test S14b member",
  project: DANGLING_PROJECT,
  status: ALICE_TODO_STATUS,
});
check("S14b [tasks]: member create with ONLY a dangling project → 400 (createRule denial)", s, 400);
check(
  "S14b [tasks]: member's rejected create persisted nothing",
  await find_id("tasks", "title", "scope-test S14b member", su),
  null,
);

for (const col of SIX) {
  body = { [title_field(col)]: `scope-test S14b ${col}`, project: DANGLING_PROJECT };
  if (col === "templates") body.type = "task";
  [s, resp] = await api("POST", `/api/collections/${col}/records`, su, body);
  check(
    `S14b [${col}]: su create (rules bypassed) with ONLY a dangling project → 400, NOT 404`,
    s,
    400,
  );
  check(
    `S14b [${col}]: the 400 is the universal coherence guard's`,
    py_get(resp, "message", ""),
    `Project must belong to the ${GUARD_NOUN[col] ?? "item"}'s workspace.`,
  );
  check(
    `S14b [${col}]: rejected, not silently created (no record carries the submitted title)`,
    await find_id(col, title_field(col), `scope-test S14b ${col}`, su),
    null,
  );
}

// one su create per tasks hook that resolves a workspace from the submitted project
for (const [_label, _extra] of [
  ["status", { status: ALICE_TODO_STATUS }],
  ["assignee", { assignee: alice_id }],
  ["labels", { labels: [ALICE_LABEL] }],
  ["parent+milestone", { parent: TASK_S6, milestone: MILESTONE_S7 }],
] as [string, Record<string, any>][]) {
  body = { title: `scope-test S14b tasks+${_label}`, project: DANGLING_PROJECT };
  Object.assign(body, _extra);
  [s, resp] = await api("POST", "/api/collections/tasks/records", su, body);
  check(`S14b [tasks+${_label}]: su create with a dangling project → 400, NOT 404`, s, 400);
  check(
    `S14b [tasks+${_label}]: rejected, not silently created (no task carries the submitted title)`,
    await find_id("tasks", "title", `scope-test S14b tasks+${_label}`, su),
    null,
  );
}

// ── cleanup: superuser hard-purges everything this suite created ──
console.log("\n── cleanup ──");
for (const [col, rid] of CREATED) {
  [s] = await api("DELETE", `/api/collections/${col}/records/${rid}`, su);
  check_in(`cleanup: superuser hard-deletes ${col}/${rid.slice(0, 8)}`, s, [204, 404]);
}

await tierkit.verify_tiers();

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} FAILED: ${py_str(FAILS)}`);
  process.exit(1);
}
console.log("✅ all dual-scope-items proofs passed");

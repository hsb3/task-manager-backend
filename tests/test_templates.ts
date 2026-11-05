#!/usr/bin/env bun
/**
 * E2E proof of the G3 (#74) `templates` collection: role-tiered CRUD
 * (owner/admin write, plain-member read-only), templateData shape validation
 * (object-only, type-keyed key whitelist), the dual-scope (project-not-in-workspace)
 * guard, and the create-from-template client round-trip (read a template's
 * templateData, use it to instantiate a task).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy (scope.pb.js "templates"
 * hooks under test live there), scripts/seed.ts fixtures. Port 8131 + PB_PORT_OFFSET.
 */

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
const PORT = 8131 + PORT_OFFSET;
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
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-templates-test-"));
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
  const PRIO: Record<string, string> = Object.fromEntries(
    getitem(
      (await api("GET", `/api/collections/workspaces/records/${ALICE_WS}`, alice))[1],
      "priorities",
    ).map((p: any) => [getitem(p, "name"), getitem(p, "id")]),
  );
  const BOB_WS = await find_id("workspaces", "name", "Bob's Workspace", bob);
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob);
  const ALICE_STATUS = await find_id("statuses", "name", "Todo", alice);
  const ALICE_LABEL = await find_id("labels", "name", "Bug", alice);
  check("fixture: Bob's OWN workspace resolved (a different tenant)", ALICE_WS !== BOB_WS, true);
  check("fixture: a status in Alice's workspace resolved", truthy(ALICE_STATUS), true);
  check("fixture: a label in Alice's workspace resolved", truthy(ALICE_LABEL), true);
  const cleanup_template_ids: string[] = [];
  const cleanup_task_ids: string[] = [];

  // COVERS: rule:templates.create, rule:templates.update, rule:templates.delete
  // ══════════════════ 1. CRUD × role matrix ══════════════════════════════════
  console.log("\n── (1) OWNER (Alice): create/update/delete ──");
  let made: any;
  [s, made] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Owner Template",
  });
  check("Alice (owner) creates a template", s, 200);
  const owner_tpl_id = made.id;
  [s, r] = await api("PATCH", `/api/collections/templates/records/${owner_tpl_id}`, alice, {
    name: "Owner Template Renamed",
  });
  check("Alice (owner) renames it", s, 200);
  check("rename took effect", r.name, "Owner Template Renamed");
  [s] = await api("DELETE", `/api/collections/templates/records/${owner_tpl_id}`, alice);
  check("Alice (owner) deletes it", s, 204);

  console.log("\n── (1) ADMIN (Bob promoted to admin): create/update/delete ──");
  await tierkit.actor_at_tier(ALICE_WS!, bob_id, "admin", alice, "Bob");
  [s, made] = await api("POST", "/api/collections/templates/records", bob, {
    workspace: ALICE_WS,
    type: "document",
    name: "Admin Template",
  });
  check("Bob (admin) creates a template", s, 200);
  const admin_tpl_id = made.id;
  [s, r] = await api("PATCH", `/api/collections/templates/records/${admin_tpl_id}`, bob, {
    name: "Admin Template Renamed",
  });
  check("Bob (admin) renames it", s, 200);
  [s] = await api("DELETE", `/api/collections/templates/records/${admin_tpl_id}`, bob);
  check("Bob (admin) deletes it", s, 204);
  let bob_tier = await tierkit.actor_at_tier(ALICE_WS!, bob_id, "member", alice, "Bob");

  // COVERS: rule:templates.view, rule:templates.list
  console.log("\n── (1) MEMBER (Bob, plain member): write denied, read allowed ──");
  let target: any;
  [s, target] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Member Target Template",
  });
  check("(fixture) Alice creates a target template for Bob to probe", s, 200);
  const member_target_id = target.id;
  [s] = await api("POST", "/api/collections/templates/records", bob, {
    workspace: ALICE_WS,
    type: "task",
    name: "Member Attempt Template",
  });
  check("Bob (member) create → denied", tup(await bob_tier.now(), s), tup("member", 400));
  [s] = await api("PATCH", `/api/collections/templates/records/${member_target_id}`, bob, {
    name: "hijacked",
  });
  check("Bob (member) update → denied", tup(await bob_tier.now(), s), tup("member", 404));
  [s] = await api("DELETE", `/api/collections/templates/records/${member_target_id}`, bob);
  check("Bob (member) delete → denied", tup(await bob_tier.now(), s), tup("member", 404));
  [s, r] = await api(
    "GET",
    `/api/collections/templates/records?filter=(workspace='${ALICE_WS}')`,
    bob,
  );
  check("Bob (member) list → 200", tup(await bob_tier.now(), s), tup("member", 200));
  check(
    "Bob (member) list is non-empty",
    tup(await bob_tier.now(), py_get(r, "items", []).length > 0),
    tup("member", true),
  );
  [s] = await api("GET", `/api/collections/templates/records/${member_target_id}`, bob);
  check("Bob (member) view → 200", tup(await bob_tier.now(), s), tup("member", 200));

  console.log("\n── (1) NON-MEMBER (Carol) ──");
  [s, r] = await api(
    "GET",
    `/api/collections/templates/records?filter=(workspace='${ALICE_WS}')`,
    carol,
  );
  check("Carol (non-member) list Alice-ws templates → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/templates/records/${member_target_id}`, carol);
  check("Carol (non-member) view → 404", s, 404);

  console.log("\n── (1) ANON ──");
  [s, r] = await api(
    "GET",
    `/api/collections/templates/records?filter=(workspace='${ALICE_WS}')`,
    null,
  );
  check("Anon list Alice-ws templates → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("POST", "/api/collections/templates/records", null, {
    workspace: ALICE_WS,
    type: "task",
    name: "Anon Template",
  });
  check("Anon create → 400", s, 400);

  [s] = await api("DELETE", `/api/collections/templates/records/${member_target_id}`, alice);
  check("cleanup: member-target template removed", s, 204);

  // ══════════════════ 2. templateData shape validation ═══════════════════════
  // COVERS: hook:scope.pb.js#onRecordCreateRequest:templates
  console.log("\n── (2) templateData shape validation (type=task) ──");
  [s, r] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Shape1",
    templateData: { title: "x", status: ALICE_STATUS },
  });
  check("task templateData {title,status} (whitelisted keys) → 200", s, 200);
  if (s === 200) cleanup_template_ids.push(getitem(r, "id"));

  [s] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Shape2",
    templateData: { bogus: 1 },
  });
  check("task templateData {bogus} (unknown key) → 400", s, 400);

  [s] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Shape3",
    templateData: ["a"],
  });
  check("task templateData ['a'] (JSON array) → 400", s, 400);

  [s] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Shape4",
    templateData: "str",
  });
  check("task templateData 'str' (JSON string) → 400", s, 400);

  [s, r] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Shape5",
    templateData: {},
  });
  check("task templateData {} (empty object) → 200", s, 200);
  if (s === 200) cleanup_template_ids.push(getitem(r, "id"));

  console.log("\n── (2) templateData shape validation (type=document) ──");
  [s, r] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "document",
    name: "Shape6",
    templateData: { body: "hi" },
  });
  check("document templateData {body} → 200", s, 200);
  if (s === 200) cleanup_template_ids.push(getitem(r, "id"));

  [s] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "document",
    name: "Shape7",
    templateData: { status: "x" },
  });
  check("document templateData {status} (not a document key) → 400", s, 400);

  // COVERS: hook:scope.pb.js#onRecordUpdateRequest:templates
  console.log("\n── (2) templateData shape validation on PATCH (update handler) ──");
  let patch_target: any;
  [s, patch_target] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "PatchTarget",
    templateData: { title: "seed" },
  });
  check("(fixture) create a template to PATCH", s, 200);
  const patch_id = patch_target.id;
  [s] = await api("PATCH", `/api/collections/templates/records/${patch_id}`, alice, {
    templateData: ["x"],
  });
  check("PATCH templateData to ['x'] (array) → 400", s, 400);
  [s, r] = await api("PATCH", `/api/collections/templates/records/${patch_id}`, alice, {
    templateData: { title: "ok" },
  });
  check("PATCH templateData to {title:ok} → 200", s, 200);
  cleanup_template_ids.push(patch_id);

  // ══════════════════ 3. dual-scope mismatch ══════════════════════════════════
  // COVERS: hook:scope.pb.js#onRecordCreate:templates
  console.log("\n── (3) template.project must belong to template.workspace ──");
  [s] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    project: BOB_PROJECT,
    type: "task",
    name: "Mismatched",
  });
  check("template with project from a DIFFERENT workspace → 400", s, 400);

  // COVERS: hook:scope.pb.js#onRecordUpdate:templates
  console.log("\n── (3b) PATCH template.project to a cross-workspace project → 400 ──");
  let scope_target: any;
  [s, scope_target] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    project: ALICE_PROJECT,
    type: "task",
    name: "PatchScopeTarget",
  });
  check("(fixture) Alice creates a ws-A project-scoped template", s, 200);
  const scope_target_id = scope_target.id;
  [s] = await api("PATCH", `/api/collections/templates/records/${scope_target_id}`, alice, {
    project: BOB_PROJECT,
  });
  check("PATCH template.project to a DIFFERENT workspace's project → 400", s, 400);
  cleanup_template_ids.push(scope_target_id);

  // ══════════════════ 4. create-from-template round trip ══════════════════════
  console.log("\n── (4) create-from-template client round-trip ──");
  [s, made] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Bug Report",
    templateData: { title: "From Template", priority: getitem(PRIO, "high") },
  });
  check("(fixture) Alice creates 'Bug Report' template", s, 200);
  const bug_report_id = made.id;
  cleanup_template_ids.push(bug_report_id);

  let view: any;
  [s, view] = await api("GET", `/api/collections/templates/records/${bug_report_id}`, alice);
  check("view the created template → 200", s, 200);
  const tdata = view.templateData || {};
  check(
    "templateData round-trips {title,priority}",
    { title: tdata.title, priority: tdata.priority },
    { title: "From Template", priority: getitem(PRIO, "high") },
  );

  let task: any;
  [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: tdata.title ?? null,
    priority: tdata.priority ?? null,
    project: ALICE_PROJECT,
  });
  check("instantiate a task from templateData → 200", s, 200);
  check("created task's title == templateData.title", task.title, "From Template");
  if (task.id) cleanup_task_ids.push(task.id);

  // ══════════════════ 5. card 5mhz — templateData VALUES at SAVE ══════════════
  // A vocabulary the workspace cannot honour used to save with 200 and fail later, on the
  // member instantiating the template rather than the admin who wrote it.
  console.log(
    "\n── (5) fixtures for the out-of-vocabulary values (another workspace, a non-member) ──",
  );
  let bob_label: any;
  [s, bob_label] = await api("POST", "/api/collections/labels/records", bob, {
    workspace: BOB_WS,
    name: "Bobs Label",
    color: "red",
  });
  check("(fixture) Bob creates a label in HIS workspace", s, 200);
  const BOB_LABEL = bob_label.id;
  let bob_ms: any;
  [s, bob_ms] = await api("POST", "/api/collections/milestones/records", bob, {
    workspace: BOB_WS,
    project: BOB_PROJECT,
    name: "Bobs Milestone",
  });
  check("(fixture) Bob creates a milestone in HIS workspace", s, 200);
  const BOB_MILESTONE = bob_ms.id;
  await find_id("statuses", "name", "Todo", bob);
  const bob_statuses = await find_by_filter(
    "statuses",
    `workspace='${BOB_WS}' && name='Todo'`,
    bob,
  );
  const BOB_STATUS = bob_statuses.length ? getitem(bob_statuses[0], "id") : null;
  check("(fixture) a status in Bob's OWN workspace resolved", truthy(BOB_STATUS), true);
  check("(fixture) it is NOT Alice's status of the same name", BOB_STATUS !== ALICE_STATUS, true);

  console.log("\n── (5) each out-of-vocabulary templateData value is refused at SAVE ──");
  const OUT_OF_VOCAB: [string, any, string][] = [
    ["priority not in the workspace vocabulary", { priority: "not-a-priority" }, "priority"],
    ["priority given by name instead of id", { priority: "high" }, "priority"],
    ["status from another workspace", { status: BOB_STATUS }, "status"],
    ["label from another workspace", { labels: [BOB_LABEL] }, "labels"],
    ["milestone from another workspace", { milestone: BOB_MILESTONE }, "milestone"],
    ["project from another workspace", { project: BOB_PROJECT }, "project"],
    ["assignee who is not an active member", { assignee: carol_id }, "assignee"],
    ["due that names no date", { due: "not-a-date" }, "due"],
  ];
  for (const [label, tdata, field] of OUT_OF_VOCAB) {
    [s, r] = await api("POST", "/api/collections/templates/records", alice, {
      workspace: ALICE_WS,
      type: "task",
      name: "Vocab " + field,
      templateData: tdata,
    });
    check(`CREATE template with ${label} → 400`, s, 400);
    check(
      `…and the 400 binds to templateData.${field}`,
      Object.keys(r.data || {}).sort(by_code_point),
      [`templateData.${field}`],
    );
    if (s === 200 && r.id) cleanup_template_ids.push(r.id);
  }

  console.log("\n── (5b) the same refusal on PATCH, and nothing persists ──");
  let vocab_target: any;
  [s, vocab_target] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "VocabPatchTarget",
    templateData: {},
  });
  check("(fixture) create an empty-templateData template to PATCH", s, 200);
  const vocab_id = vocab_target.id;
  cleanup_template_ids.push(vocab_id);
  for (const [label, tdata, field] of OUT_OF_VOCAB) {
    [s, r] = await api("PATCH", `/api/collections/templates/records/${vocab_id}`, alice, {
      templateData: tdata,
    });
    check(`PATCH templateData to ${label} → 400`, s, 400);
    check(
      `…and the 400 binds to templateData.${field}`,
      Object.keys(r.data || {}).sort(by_code_point),
      [`templateData.${field}`],
    );
  }
  [s, r] = await api("GET", `/api/collections/templates/records/${vocab_id}`, alice);
  check("…and none of them persisted", tup(s, r.templateData), tup(200, {}));

  console.log("\n── (5c) the workspace's OWN vocabulary still saves ──");
  [s, r] = await api("PATCH", `/api/collections/templates/records/${vocab_id}`, alice, {
    templateData: {
      title: "Fully bound",
      priority: getitem(PRIO, "high"),
      status: ALICE_STATUS,
      labels: [ALICE_LABEL],
      project: ALICE_PROJECT,
      assignee: alice_id,
      due: "2026-12-01 00:00:00.000Z",
    },
  });
  check("PATCH templateData naming only this workspace's vocabulary → 200", s, 200);
  check("…and it persisted", (r.templateData || {}).priority, getitem(PRIO, "high"));
  [s, r] = await api("PATCH", `/api/collections/templates/records/${vocab_id}`, alice, {
    templateData: { title: "Left blank", priority: "", status: "", due: "" },
  });
  check("PATCH templateData whose values are all EMPTY → 200 (a template may leave them)", s, 200);

  console.log(
    "\n── (5d) an active MEMBER of the workspace is assignable, a suspended one is not ──",
  );
  bob_tier = await tierkit.actor_at_tier(ALICE_WS!, bob_id, "member", alice, "Bob");
  [s] = await api("PATCH", `/api/collections/templates/records/${vocab_id}`, alice, {
    templateData: { assignee: bob_id },
  });
  check("assignee who IS an active member → 200", tup(await bob_tier.now(), s), tup("member", 200));
  const BOB_ROW = bob_tier.id;
  await bob_tier.done();
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${BOB_ROW}`, su, {
    status: "suspended",
  });
  check("(fixture) superuser suspends Bob's membership", s, 200);
  const bob_suspended = await tierkit.actor_at_tier(
    ALICE_WS!,
    bob_id,
    "member",
    su,
    "Bob",
    "suspended",
  );
  [s, r] = await api("PATCH", `/api/collections/templates/records/${vocab_id}`, alice, {
    templateData: { assignee: bob_id },
  });
  check(
    "assignee whose membership is SUSPENDED → 400",
    tup(tup(...(await bob_suspended.standing())), s),
    tup(tup("member", "suspended"), 400),
  );
  await bob_suspended.done();
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${BOB_ROW}`, su, {
    status: "active",
  });
  check("(fixture) superuser restores Bob's membership", s, 200);
  await tierkit.actor_at_tier(ALICE_WS!, bob_id, "member", alice, "Bob");

  // ══════════════════ 6. card 5mhz — the task-create refusal names the field ═══
  console.log(
    "\n── (6) creating a task from an out-of-vocabulary value names the field in data ──",
  );
  const TASK_REFUSALS: [string, any][] = [
    ["priority", { priority: "not-a-priority" }],
    ["status", { status: BOB_STATUS }],
    ["labels", { labels: [BOB_LABEL] }],
    ["assignee", { assignee: carol_id }],
  ];
  for (const [field, extra] of TASK_REFUSALS) {
    const body = {
      title: "Instantiate " + field,
      project: ALICE_PROJECT,
      workspace: ALICE_WS,
      ...extra,
    };
    [s, r] = await api("POST", "/api/collections/tasks/records", alice, body);
    check(`POST task carrying a bad ${field} → 400`, s, 400);
    check(
      `…and the 400 binds to the ${field} field`,
      Object.keys(r.data || {}).sort(by_code_point),
      [field],
    );
    if (s === 200 && r.id) cleanup_task_ids.push(r.id);
  }

  // ══════════════════ cleanup ══════════════════════════════════════════════════
  console.log("\n── cleanup ──");
  [s] = await api("DELETE", `/api/collections/milestones/records/${BOB_MILESTONE}`, bob);
  check("cleanup: Bob's milestone removed", s, 204);
  [s] = await api("DELETE", `/api/collections/labels/records/${BOB_LABEL}`, bob);
  check("cleanup: Bob's label removed", s, 204);
  for (const tid of cleanup_task_ids) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
    check(`cleanup: task ${tid.slice(0, 8)} removed`, s, 204);
  }
  for (const lid of cleanup_template_ids) {
    [s] = await api("DELETE", `/api/collections/templates/records/${lid}`, alice);
    check(`cleanup: template ${lid.slice(0, 8)} removed`, s, 204);
  }

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
  console.log("✅ all template proofs passed");
  process.exit(0);
}

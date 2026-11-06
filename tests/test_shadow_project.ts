#!/usr/bin/env bun
/**
 * decision:shadow-project: every workspace owns one invisible shadow project, and an item created with
 * no project lands in it.
 *
 *   §1 a plain member creates an item with no project and it reads back in the shadow project
 *   §2 invisibility for owner / active admin / active plain member — list, view by id,
 *      expand=project, and the per-workspace realtime feed (two custom-route bounds printed)
 *   §3 the shadow project follows its workspace through trash and restore, and a re-provisioned
 *      last workspace gets its own
 *   §5 the rule tier refuses mint, flip, rename and delete of the shadow project
 *   §6 a forced placement failure leaves the project empty, writes a log row, and self-heals
 *      on the next save (mwf4)
 *
 * Mints its own users; scripts/seed.ts runs nowhere. Self-contained clean room.
 * Port 8123 + PB_PORT_OFFSET — the suite self-boot band (CLAUDE.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  json_dumps,
  py_repr,
  py_str,
  run_checked,
  truthy,
  urlencode,
  py_get,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8123 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Dummy superuser — NOT a real secret.
const SU_EMAIL = "shadow-ci@example.test";
const SU_PASSWORD = "shadow-ci-dummy-pw-0";
const PASSWORD = "test123456"; // shared app-user password, same convention as scripts/seed.ts

// §6 fault injection. A workspace whose name starts with this marker is the ONLY reachable
// way into landInShadowProject's catch: every other way to make the container unresolvable
// also makes the item's own workspace relation invalid, so the item never persists.
const FAULT_MARKER = "shadow-s6-FAULT-INJECT";
const FAULT_PROBE_HOOK = `/// <reference path="../pb_data/types.d.ts" />
// tests/test_shadow_project.ts §6 — refuses the container create for one marked workspace.
onRecordCreate((e) => {
  let wsName = "";
  try {
    wsName = String(
      e.app.findRecordById("workspaces", e.record.get("workspace")).get("name") || "",
    );
  } catch (_) {
    wsName = "";
  }
  if (e.record.get("shadow") && wsName.indexOf("__MARKER__") === 0) {
    throw new BadRequestError("test probe: container create refused");
  }
  return e.next();
}, "projects");
`.replace("__MARKER__", FAULT_MARKER);

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)}` +
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
  if (r.status === 204) return [204, {}];
  const raw = await r.text();
  if (r.status >= 400) {
    try {
      return [r.status, raw ? JSON.parse(raw) : {}];
    } catch {
      return [r.status, {}];
    }
  }
  return [r.status, raw ? JSON.parse(raw) : {}];
}

class Room {
  // A `pocketbase serve` clean room on the current tree.
  port: number;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  hooks_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number) {
    this.port = port;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-shadow-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    this.hooks_dir = path.join(this.tmp, "pb_hooks_room");
    this.proc = null;
  }

  _build_tree(): void {
    fs.rmSync(this.migrations_dir, { recursive: true, force: true });
    fs.rmSync(this.hooks_dir, { recursive: true, force: true });
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    for (const name of fs.readdirSync(this.migrations_dir)) {
      if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(this.migrations_dir, name));
    }
    const source = roomkit.hooks_dir(path.join(this.tmp, "hooks_src"));
    fs.cpSync(source, this.hooks_dir, { recursive: true, dereference: true });
    // Written into every room: inert until §6 mints the one workspace it names.
    const probe = path.join(this.hooks_dir, "zz_shadow_fault_probe.pb.js");
    fs.writeFileSync(probe, FAULT_PROBE_HOOK, "utf-8");
  }

  async start(): Promise<void> {
    this._build_tree();
    run_checked(
      [
        PB_BIN,
        "superuser",
        "upsert",
        SU_EMAIL,
        SU_PASSWORD,
        "--dir",
        this.data_dir,
        "--migrationsDir",
        this.migrations_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    this.proc = await roomkit.serve(this.port, this.data_dir, this.migrations_dir, this.hooks_dir);
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    const proc = this.proc;
    this.proc = null;
    await roomkit.stop(proc);
  }

  cleanup(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

async function login(email: string): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: PASSWORD,
  });
  return roomkit.token_of(BASE_URL, email, r);
}

async function make_user(su: string, name: string, email: string): Promise<string> {
  const [status, r] = await api("POST", "/api/collections/users/records", su, {
    email: email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    name: name,
    verified: true,
    approved: true,
  });
  if (status !== 200) {
    throw new roomkit.SystemExit(`user create failed for ${email}: ${status} ${py_str(r)}`);
  }
  return getitem(r, "id");
}

async function records(
  collection: string,
  token: string | null,
  filt: string | null = null,
  per_page = 200,
): Promise<any[]> {
  const params: Record<string, any> = { perPage: per_page };
  if (filt) params.filter = filt;
  const qs = urlencode(params);
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return r.items || [];
}

async function shadow_of(su: string, workspace_id: string): Promise<any> {
  // The workspace's shadow project, read as SUPERUSER — no tenant role can see it.
  const rows = await records("projects", su, `(workspace='${esc(workspace_id)}' && shadow=true)`);
  if (rows.length !== 1) {
    throw new roomkit.SystemExit(
      `expected exactly one shadow project in ${workspace_id}, got ${py_str(rows)}`,
    );
  }
  return rows[0];
}

async function project_row(su: string, project_id: string): Promise<Record<string, any>> {
  const [, r] = await api("GET", `/api/collections/projects/records/${project_id}`, su);
  const out: Record<string, any> = {};
  for (const k of ["id", "name", "key", "shadow", "trashed"]) out[k] = r[k] ?? null;
  return out;
}

// Alice owns the workspace, Bob is an active plain member, Dana an active admin. Their workspace and default project are auto-provisioned.
const OWNER_EMAIL = "shadow-alice@example.com";
const MEMBER_EMAIL = "shadow-bob@example.com";
const ADMIN_EMAIL = "shadow-dana@example.com";

const PARITY_ITEMS: [string, string, string][] = [
  ["tasks", "title", "parity-projectless-task"],
  ["decisions", "title", "parity-projectless-decision"],
  ["documents", "title", "parity-projectless-document"],
];

async function seed_fixtures(su: string): Promise<[string, string]> {
  // Mint the users and memberships. Returns (owner_id, workspace_id).
  const owner_id = await make_user(su, "ShadowAlice", OWNER_EMAIL);
  const member_id = await make_user(su, "ShadowBob", MEMBER_EMAIL);
  const admin_id = await make_user(su, "ShadowDana", ADMIN_EMAIL);
  const ws = await records("workspaces", su, `(owner='${esc(owner_id)}')`);
  if (ws.length !== 1) {
    throw new roomkit.SystemExit(
      `expected one auto-provisioned workspace for the owner, got ${py_str(ws)}`,
    );
  }
  for (const [uid, role] of [
    [member_id, "member"],
    [admin_id, "admin"],
  ]) {
    const [status, r] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: getitem(ws[0], "id"),
      user: uid,
      role: role,
      status: "active",
    });
    if (status !== 200) {
      throw new roomkit.SystemExit(`membership create failed for ${role}: ${status} ${py_str(r)}`);
    }
  }
  return [owner_id, getitem(ws[0], "id")];
}

async function create_projectless(
  token: string,
  workspace_id: string,
): Promise<Record<string, any[]>> {
  // One item per collection that accepts an empty project, created with no project.
  const out: Record<string, any[]> = {};
  for (const [coll, title_field, title] of PARITY_ITEMS) {
    const body: Record<string, any> = { [title_field]: title, workspace: workspace_id };
    if (coll === "decisions") body.status = "proposed";
    const [status, rec] = await api("POST", `/api/collections/${coll}/records`, token, body);
    out[coll] = [status, rec.id ?? null, rec.project ?? null, rec.key ?? null];
  }
  return out;
}

console.log(
  `════════ test_shadow_project.ts — decision:shadow-project shadow project (room on :${PORT}) ════════`,
);
const room = new Room(PORT);
try {
  await room.start();
  let status: number;
  const su = await superuser_token();
  const [OWNER_ID, WS] = await seed_fixtures(su);
  const alice = await login(OWNER_EMAIL); // workspace OWNER
  const bob = await login(MEMBER_EMAIL); // active PLAIN member
  const dana = await login(ADMIN_EMAIL); // active ADMIN member
  const SHADOW = await shadow_of(su, WS);
  const NORMAL = (await records("projects", su, `(workspace='${esc(WS)}')`)).find(
    (p) => !truthy(getitem(p, "shadow")),
  );
  if (NORMAL === undefined) throw new Error("StopIteration");
  console.log(
    `  fixtures: WS=${WS}  shadow=${getitem(SHADOW, "id")}  normal project=${getitem(NORMAL, "id")} ` +
      `(${py_repr(getitem(NORMAL, "name"))})`,
  );

  // The parity fixture, captured BEFORE anything else writes into the shadow project.
  const parity_a = await create_projectless(bob, WS);
  console.log(`  parity items (room A): ${json_dumps(parity_a)}`);

  // ── §1 an item created with no project lands in the workspace's shadow project ──
  // COVERS: hook:shadow.pb.js#onRecordCreate:tasks, hook:shadow.pb.js#onRecordCreate:decisions
  // COVERS: hook:shadow.pb.js#onRecordCreate:documents
  // COVERS: hook:shadow.pb.js#onRecordUpdate:tasks, hook:shadow.pb.js#onRecordUpdate:decisions
  // COVERS: hook:shadow.pb.js#onRecordUpdate:documents
  console.log("\n── §1 a plain member creates an item with NO project ──");
  let task: any;
  let back: any;
  [status, task] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-no-project",
    workspace: WS,
  });
  check("POST task with no project → 200", status, 200);
  [status, back] = await api("GET", `/api/collections/tasks/records/${getitem(task, "id")}`, bob);
  check("GET it back → 200", status, 200);
  check(
    "the stored project IS the workspace shadow project (resolved as superuser)",
    back.project ?? null,
    getitem(SHADOW, "id"),
  );
  check("it carries no display key, as a project-less item did", back.key ?? null, "");
  for (const [coll] of PARITY_ITEMS) {
    const [status, , project, key] = getitem(parity_a, coll);
    check(`${coll}: create with no project → 200`, status, 200);
    check(`${coll}: landed in the shadow project`, project, getitem(SHADOW, "id"));
    check(`${coll}: carries no display key`, key, "");
  }
  const listed = (await records("tasks", bob, `(workspace='${esc(WS)}')`)).map((t) =>
    getitem(t, "id"),
  );
  check(
    "the shadow-project task still lists under its workspace",
    listed.includes(getitem(task, "id")),
    true,
  );
  let qs = urlencode({ q: "shadow-s1-no-project", workspace: WS });
  const [, found] = await api("GET", `/api/tracker/search?${qs}`, bob);
  check(
    "the shadow-project task is still returned by search",
    py_get(found, "results", []).map((r: any) => getitem(r, "id")),
    [getitem(task, "id")],
  );

  // main.pb.js's parent/dependencies guards compare the SUBMITTED project against the
  // referenced item's, and resolve an absent one to where it will land — otherwise a write
  // carrying no project reads as project-less against a parent already placed.
  console.log("\n── §1 items that REFERENCE an item created with no project ──");
  let child: any;
  [status, child] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-child",
    workspace: WS,
    parent: getitem(task, "id"),
  });
  check("a sub-task of a shadow-project task, submitting no project → 200", status, 200);
  check("it landed in the same shadow project", child.project ?? null, getitem(SHADOW, "id"));
  let dep: any;
  [status, dep] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-blocked",
    workspace: WS,
    dependencies: [getitem(task, "id")],
  });
  check("a task blocked by a shadow-project task, submitting no project → 200", status, 200);
  check("it landed in the shadow project too", dep.project ?? null, getitem(SHADOW, "id"));
  // The guard must be RESTORED, not widened: a normal project on the other side still refuses.
  let in_normal: any;
  [status, in_normal] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-in-normal",
    workspace: WS,
    project: getitem(NORMAL, "id"),
  });
  check("control fixture: a task inside the NORMAL project → 200", status, 200);
  // Asserted, not assumed: the two CONTROLs below only mean anything while this task really
  // sits in the normal project — in the container they would pass for the opposite reason.
  check(
    "control fixture: it really is stored in the NORMAL project",
    in_normal.project ?? null,
    getitem(NORMAL, "id"),
  );
  // 1dy0 inherits the parent's project on create, so this create is no longer refused.
  let child_normal: any;
  [status, child_normal] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-child-normal",
    workspace: WS,
    parent: getitem(in_normal, "id"),
  });
  check("a sub-task of a NORMAL-project task, no project → 200", status, 200);
  check(
    "it inherited the PARENT's project, not the shadow container",
    child_normal.project ?? null,
    getitem(NORMAL, "id"),
  );
  [status] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-blocked-normal",
    workspace: WS,
    dependencies: [getitem(in_normal, "id")],
  });
  check("CONTROL: a task blocked by a NORMAL-project task, no project → 400", status, 400);
  [status] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-child-same",
    workspace: WS,
    project: getitem(NORMAL, "id"),
    parent: getitem(in_normal, "id"),
  });
  check("CONTROL: a sub-task naming the parent's own project → 200", status, 200);
  const [status_mst, mst] = await api("POST", "/api/collections/milestones/records", bob, {
    name: "shadow-s1-milestone",
    workspace: WS,
  });
  // COVERS: hook:shadow.pb.js#onRecordCreate:milestones, hook:shadow.pb.js#onRecordUpdate:milestones
  check("a milestone created with no project → 200", status_mst, 200);
  check(
    "it lands in the shadow project, like every other item type",
    mst.project ?? null,
    getitem(SHADOW, "id"),
  );
  let mtask: any;
  [status, mtask] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-milestone-task",
    workspace: WS,
    milestone: mst.id ?? null,
  });
  check("a task on that milestone, submitting no project → 200", status, 200);
  // milestones.project is REQUIRED, so this also proves the placement runs before validation.
  let moved: any;
  [status, moved] = await api(
    "PATCH",
    `/api/collections/milestones/records/${getitem(mst, "id")}`,
    bob,
    { project: getitem(NORMAL, "id") },
  );
  check("a milestone moved into a normal project → 200", status, 200);
  let recleared: any;
  [status, recleared] = await api(
    "PATCH",
    `/api/collections/milestones/records/${getitem(mst, "id")}`,
    bob,
    { project: "" },
  );
  check("clearing a milestone's project → 200, not a required-field refusal", status, 200);
  check("and it re-landed in the shadow project", recleared.project ?? null, getitem(SHADOW, "id"));
  let orphan: any;
  [status, orphan] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s1-orphan",
  });
  check("a create carrying neither project nor workspace is still refused, unchanged", status, 400);

  // decision:shadow-project must survive an UPDATE, not only a create.
  console.log("\n── §1 clearing an item's project re-lands it in the shadow project ──");
  for (const [coll, title_field] of PARITY_ITEMS) {
    const body: Record<string, any> = {
      [title_field]: `shadow-s1-cleared-${coll}`,
      workspace: WS,
      project: getitem(NORMAL, "id"),
    };
    if (coll === "decisions") body.status = "proposed";
    let rec: any;
    let cleared: any;
    [status, rec] = await api("POST", `/api/collections/${coll}/records`, bob, body);
    check(`${coll}: create inside a normal project → 200`, status, 200);
    [status, cleared] = await api(
      "PATCH",
      `/api/collections/${coll}/records/${getitem(rec, "id")}`,
      bob,
      { project: "" },
    );
    check(`${coll}: PATCH project to empty → 200`, status, 200);
    check(
      `${coll}: it re-landed in the shadow project`,
      cleared.project ?? null,
      getitem(SHADOW, "id"),
    );
  }

  // decision:shadow-project — the container is a placement, never a choice.
  console.log("\n── §1 the container cannot be named by a client, and nothing may point at it ──");
  // COVERS: hook:shadow.pb.js#onRecordCreateRequest:tasks, hook:shadow.pb.js#onRecordCreateRequest:decisions
  // COVERS: hook:shadow.pb.js#onRecordCreateRequest:documents, hook:shadow.pb.js#onRecordCreateRequest:milestones
  // COVERS: hook:shadow.pb.js#onRecordUpdateRequest:tasks, hook:shadow.pb.js#onRecordUpdateRequest:decisions
  // COVERS: hook:shadow.pb.js#onRecordUpdateRequest:documents, hook:shadow.pb.js#onRecordUpdateRequest:milestones
  let placed: any;
  for (const [coll, title_field] of [
    ["tasks", "title"],
    ["decisions", "title"],
    ["documents", "title"],
    ["milestones", "name"],
  ]) {
    const base: Record<string, any> = {
      [title_field]: `shadow-s1-explicit-${coll}`,
      workspace: WS,
    };
    if (coll === "decisions") base.status = "proposed";
    [status] = await api("POST", `/api/collections/${coll}/records`, bob, {
      ...base,
      project: getitem(SHADOW, "id"),
    });
    check(`${coll}: CREATE naming the shadow project → 400`, status, 400);
    [status, placed] = await api("POST", `/api/collections/${coll}/records`, bob, {
      ...base,
      project: getitem(NORMAL, "id"),
    });
    check(`CONTROL: ${coll}: the same create naming a normal project → 200`, status, 200);
    [status] = await api(
      "PATCH",
      `/api/collections/${coll}/records/${getitem(placed, "id")}`,
      bob,
      { project: getitem(SHADOW, "id") },
    );
    check(`${coll}: PATCH INTO the shadow project → 400`, status, 400);
  }
  const in_np = placed;
  [status] = await api("PATCH", `/api/collections/tasks/records/${getitem(task, "id")}`, bob, {
    title: "shadow-s1-no-project (edited)",
  });
  check("CONTROL: editing an item ALREADY in the shadow project → 200", status, 200);
  [status] = await api("PATCH", `/api/collections/tasks/records/${getitem(task, "id")}`, bob, {
    project: getitem(NORMAL, "id"),
  });
  check("CONTROL: moving an item OUT of the shadow project → 200", status, 200);
  let moved_back: any;
  [status, moved_back] = await api(
    "PATCH",
    `/api/collections/tasks/records/${getitem(task, "id")}`,
    bob,
    { project: "" },
  );
  check("and clearing it again puts it back", moved_back.project ?? null, getitem(SHADOW, "id"));

  const POINTERS: [string, string, string, any, any][] = [
    [
      "workspaces.default_project",
      "PATCH",
      `/api/collections/workspaces/records/${WS}`,
      { default_project: getitem(SHADOW, "id") },
      { default_project: getitem(NORMAL, "id") },
    ],
    [
      "saved_views.project",
      "POST",
      "/api/collections/saved_views/records",
      {
        name: "shadow-view-a",
        workspace: WS,
        owner: OWNER_ID,
        scope: "personal",
        project: getitem(SHADOW, "id"),
        filterData: {},
      },
      {
        name: "shadow-view-b",
        workspace: WS,
        owner: OWNER_ID,
        scope: "personal",
        project: getitem(NORMAL, "id"),
        filterData: {},
      },
    ],
    [
      "labels.project",
      "POST",
      "/api/collections/labels/records",
      { name: "shadow-label-a", workspace: WS, color: "red", project: getitem(SHADOW, "id") },
      { name: "shadow-label-b", workspace: WS, color: "red", project: getitem(NORMAL, "id") },
    ],
    [
      "templates.project",
      "POST",
      "/api/collections/templates/records",
      {
        name: "shadow-tpl-a",
        workspace: WS,
        type: "task",
        templateData: '{"title":"x"}',
        project: getitem(SHADOW, "id"),
      },
      {
        name: "shadow-tpl-b",
        workspace: WS,
        type: "task",
        templateData: '{"title":"x"}',
        project: getitem(NORMAL, "id"),
      },
    ],
    // The project a template PLANTS in the task it makes is a pointer at the container too:
    // accepting it here only moves the refusal to whoever uses the template later.
    [
      "templates.templateData.project",
      "POST",
      "/api/collections/templates/records",
      {
        name: "shadow-tpl-data-a",
        workspace: WS,
        type: "task",
        templateData: { title: "x", project: getitem(SHADOW, "id") },
      },
      {
        name: "shadow-tpl-data-b",
        workspace: WS,
        type: "task",
        templateData: { title: "x", project: getitem(NORMAL, "id") },
      },
    ],
  ];
  for (const [label, verb, path, refuse_body, allow_body] of POINTERS) {
    [status] = await api(verb, path, alice, refuse_body);
    check(`${label} pointed at the shadow project → 400`, status, 400);
    [status] = await api(verb, path, alice, allow_body);
    check(`CONTROL: ${label} pointed at a normal project → 200`, status, 200);
  }
  // COVERS: hook:scope.pb.js#onRecordCreateRequest:user_settings, hook:scope.pb.js#onRecordUpdateRequest:user_settings
  const settings = await records("user_settings", su, `(user='${esc(OWNER_ID)}')`);
  [status] = await api(
    "PATCH",
    `/api/collections/user_settings/records/${getitem(settings[0], "id")}`,
    alice,
    { default_project: getitem(SHADOW, "id") },
  );
  check("user_settings.default_project pointed at the shadow project → 400", status, 400);
  [status] = await api(
    "PATCH",
    `/api/collections/user_settings/records/${getitem(settings[0], "id")}`,
    alice,
    { default_project: getitem(NORMAL, "id") },
  );
  check("CONTROL: user_settings.default_project pointed at a normal project → 200", status, 200);

  // The refusal a person meets is bound to the field they typed in and says what to do
  // instead; the same guard rides both verbs, so a save that edits an existing template into
  // the container is refused exactly like a create that starts there.
  // COVERS: hook:scope.pb.js#onRecordCreateRequest:templates, hook:scope.pb.js#onRecordUpdateRequest:templates
  let tpl: any;
  [status, tpl] = await api("POST", "/api/collections/templates/records", alice, {
    name: "shadow-tpl-data-edit",
    workspace: WS,
    type: "task",
    templateData: { title: "x", project: getitem(NORMAL, "id") },
  });
  check("(fixture) a template planting a normal project → 200", status, 200);
  for (const [verb, path, body] of [
    [
      "POST",
      "/api/collections/templates/records",
      {
        name: "shadow-tpl-data-c",
        workspace: WS,
        type: "task",
        templateData: { title: "x", project: getitem(SHADOW, "id") },
      },
    ],
    [
      "PATCH",
      `/api/collections/templates/records/${py_str(tpl.id ?? null)}`,
      { templateData: { title: "x", project: getitem(SHADOW, "id") } },
    ],
  ] as [string, string, any][]) {
    let refused: any;
    [status, refused] = await api(verb, path, alice, body);
    const bound = (refused.data || {})["templateData.project"] || {};
    check(`templateData.project → the container: ${verb} → 400`, status, 400);
    check(`${verb}: the refusal is bound to the field the person typed in`, truthy(bound), true);
    const message = refused.message || "";
    check(
      `${verb}: the refusal says what to choose instead`,
      message.includes("project list"),
      true,
    );
    // A person cannot act on the container's own name, so it never appears in the message.
    for (const word of ["container", "shadow", "Workspace items"]) {
      check(
        `${verb}: the refusal does not say ${py_repr(word)}`,
        message.toLowerCase().includes(word.toLowerCase()),
        false,
      );
    }
  }
  let kept: any;
  [status, kept] = await api(
    "GET",
    `/api/collections/templates/records/${py_str(tpl.id ?? null)}`,
    alice,
  );
  check(
    "the refused edit left the template pointing at its normal project",
    (kept.templateData || {}).project ?? null,
    getitem(NORMAL, "id"),
  );

  // ── §2 invisibility, quoted separately for the three reading roles ──
  console.log("\n── §2 the shadow project is invisible to owner, admin and plain member ──");
  const TIERS: [string, string][] = [
    ["Alice (workspace owner)", alice],
    ["Dana (active admin)", dana],
    ["Bob (active plain member)", bob],
  ];
  for (const [who, token] of TIERS) {
    const ids = (await records("projects", token, `(workspace='${esc(WS)}')`)).map((p) =>
      getitem(p, "id"),
    );
    check(
      `${who}: the shadow id is ABSENT from the project list`,
      ids.includes(getitem(SHADOW, "id")),
      false,
    );
    check(`${who}: the normal project IS listed`, ids.includes(getitem(NORMAL, "id")), true);
  }
  for (const [who, token] of TIERS) {
    [status] = await api(
      "GET",
      `/api/collections/projects/records/${getitem(SHADOW, "id")}`,
      token,
    );
    check(`${who}: GET the shadow project by id → 404 (view denied)`, status, 404);
  }
  for (const [who, token] of TIERS) {
    let rec: any;
    [status, rec] = await api(
      "GET",
      `/api/collections/tasks/records/${getitem(task, "id")}?expand=project`,
      token,
    );
    check(`${who}: reads the shadow-project item → 200`, status, 200);
    check(`${who}: expand=project is EMPTY`, py_get(rec, "expand", {}), {});
  }
  // project_stats is a VIEW over projects, a second rule-tier read surface for the same rows.
  for (const [who, token] of TIERS) {
    const rows = await records("project_stats", token);
    check(
      `${who}: the shadow project has NO project_stats row`,
      rows.filter((x) => getitem(x, "id") === getitem(SHADOW, "id")).map((x) => getitem(x, "id")),
      [],
    );
    check(
      `${who}: the normal project still has one`,
      rows.map((x) => getitem(x, "id")).includes(getitem(NORMAL, "id")),
      true,
    );
    [status] = await api(
      "GET",
      `/api/collections/project_stats/records/${getitem(SHADOW, "id")}`,
      token,
    );
    check(`${who}: GET project_stats by the shadow id → 404`, status, 404);
  }
  check(
    "the row does not exist even for a superuser — it is excluded in the view query",
    (await records("project_stats", su))
      .filter((x) => getitem(x, "id") === getitem(SHADOW, "id"))
      .map((x) => getitem(x, "id")),
    [],
  );

  console.log("\n── §2 realtime: no envelope announces the shadow project ──");
  const TOPIC = `rt:project_items:${WS}`;
  const sse = new roomkit.SSEListener(BASE_URL, alice, TOPIC);
  if (!(await sse.start())) throw new roomkit.SystemExit("SSE never received a clientId");
  await Bun.sleep(500);
  let rt_task: any;
  [status, rt_task] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "shadow-s2-realtime",
    workspace: WS,
  });
  check("realtime fixture: create with no project → 200", status, 200);
  [status] = await api("PATCH", `/api/collections/tasks/records/${getitem(rt_task, "id")}`, bob, {
    title: "shadow-s2-realtime (edited)",
  });
  check("realtime fixture: update → 200", status, 200);
  const deadline = Date.now() / 1000 + 10;
  while (Date.now() / 1000 < deadline && sse.events.length < 2) {
    await Bun.sleep(200);
  }
  sse.stop = true;
  const mine = sse.events.filter((e) => py_get(e, "rawRecord", {}).id === getitem(rt_task, "id"));
  check("both envelopes for the shadow-project item arrived", mine.length, 2);
  check(
    "NO envelope announces a projects record",
    sse.events.filter((e) => (e.collection ?? null) === "projects"),
    [],
  );
  check(
    "the envelopes name the item collection only",
    [...new Set(mine.map((e) => getitem(e, "collection")))].sort(by_code_point),
    ["tasks"],
  );
  console.log(
    "  DECLARED BOUND — the envelope carries the shadow project id in rawRecord.project: " +
      `${py_repr(mine.map((e) => py_get(e, "rawRecord", {}).project ?? null))} (shadow=${py_repr(getitem(SHADOW, "id"))}). ` +
      "The RECORD stays unreachable; the id is not secret — the REST read of the same item " +
      "returns it too. Nothing strips it and nothing asserts it away.",
  );

  console.log("\n── §2 custom routes: two surfaces read projects outside the rule tier ──");
  qs = urlencode({ q: getitem(SHADOW, "name"), workspace: WS });
  const [, hits] = await api("GET", `/api/tracker/search?${qs}`, bob);
  const search_hit = py_get(hits, "results", []).filter(
    (r: any) => (r.id ?? null) === getitem(SHADOW, "id"),
  );
  const [, xport] = await api("POST", "/api/tracker/export", bob, { workspace: WS });
  const exported = (xport.data || {}).projects || [];
  const export_hit = exported.filter((p: any) => (p.id ?? null) === getitem(SHADOW, "id"));
  check("search does not return the shadow project", search_hit, []);
  qs = urlencode({ q: "shadow-s1-no-project", workspace: WS });
  const [, item_hits] = await api("GET", `/api/tracker/search?${qs}`, bob);
  check(
    "search still returns the items that live in it",
    py_get(item_hits, "results", [])
      .map((h: any) => h.id ?? null)
      .includes(getitem(task, "id")),
    true,
  );
  check("export does not carry the shadow project record", export_hit, []);
  const export_data = xport.data || {};
  check(
    "export still carries the items that live in it",
    py_get(export_data, "tasks", [])
      .map((t: any) => t.id ?? null)
      .includes(getitem(task, "id")),
    true,
  );
  const [, narrowed] = await api("POST", "/api/tracker/export", bob, {
    workspace: WS,
    projects: [getitem(NORMAL, "id")],
  });
  const narrowed_data = narrowed.data || {};
  check(
    "an export NARROWED to one project still carries the workspace-level items",
    py_get(narrowed_data, "tasks", [])
      .map((t: any) => t.id ?? null)
      .includes(getitem(task, "id")),
    true,
  );

  // ── §3 the shadow project follows its workspace, and never moves on its own ──
  // COVERS: hook:shadow.pb.js#onRecordAfterCreateSuccess:workspaces
  console.log("\n── §3 workspace trash and restore ──");
  const eve_id = await make_user(su, "ShadowEve", "shadow-eve@example.com");
  const eve = await login("shadow-eve@example.com");
  const eve_ws = await records("workspaces", su, `(owner='${esc(eve_id)}')`);
  check("a freshly minted user owns exactly one workspace", eve_ws.length, 1);
  const EWS = getitem(eve_ws[0], "id");
  const eve_shadow = await shadow_of(su, EWS);
  const eve_normal = (await records("projects", su, `(workspace='${esc(EWS)}')`)).filter(
    (p) => !truthy(getitem(p, "shadow")),
  );
  check(
    "the auto-provisioned workspace got its own shadow project",
    getitem(eve_shadow, "name"),
    "Workspace items",
  );
  check("and one ordinary default project beside it", eve_normal.length, 1);
  const before = [
    await project_row(su, getitem(eve_shadow, "id")),
    await project_row(su, getitem(eve_normal[0], "id")),
  ];
  console.log(
    `  before trash:  shadow=${py_str(before[0])}\n                 normal=${py_str(before[1])}`,
  );
  [status] = await api("DELETE", `/api/collections/workspaces/records/${EWS}`, eve);
  check("Eve DELETEs her workspace → 204 (soft trash)", status, 204);
  const [, ws_row] = await api("GET", `/api/collections/workspaces/records/${EWS}`, su);
  check("the workspace really is trashed", (ws_row.trashed ?? null) !== "", true);
  const after = [
    await project_row(su, getitem(eve_shadow, "id")),
    await project_row(su, getitem(eve_normal[0], "id")),
  ];
  console.log(
    `  after trash:   shadow=${py_str(after[0])}\n                 normal=${py_str(after[1])}`,
  );
  check("the shadow project row is UNCHANGED by the workspace trash", after[0], before[0]);
  check("the normal project row is unchanged too — same treatment", after[1], before[1]);
  // decision:workspace-trash-cascades hides a trashed workspace's contents by rule traversal, so the container
  // disappears with the workspace without anything being stamped on it.
  check(
    "Eve lists NO project of the trashed workspace, shadow or ordinary",
    (await records("projects", eve, `(workspace='${esc(EWS)}')`)).map((p) => getitem(p, "id")),
    [],
  );
  const fresh = (await records("workspaces", su, `(owner='${esc(eve_id)}')`)).filter(
    (w) => getitem(w, "id") !== EWS,
  );
  check("trashing the LAST live workspace re-provisions one", fresh.length, 1);
  check(
    "the re-provisioned workspace is named My Workspace",
    getitem(fresh[0], "name"),
    "My Workspace",
  );
  const fresh_projects = await records(
    "projects",
    su,
    `(workspace='${esc(getitem(fresh[0], "id"))}')`,
  );
  check(
    "it carries My Project as before",
    fresh_projects
      .filter((p) => !truthy(getitem(p, "shadow")))
      .map((p) => getitem(p, "name"))
      .sort(by_code_point),
    ["My Project"],
  );
  check(
    "and it gets its OWN shadow project from the hook",
    fresh_projects.filter((p) => truthy(getitem(p, "shadow"))).map((p) => getitem(p, "name")),
    ["Workspace items"],
  );
  check(
    "membership on the re-provisioned workspace is restored",
    (
      await records(
        "workspace_members",
        su,
        `(workspace='${esc(getitem(fresh[0], "id"))}' && user='${esc(eve_id)}')`,
      )
    ).length,
    1,
  );
  [status] = await api("PATCH", `/api/collections/workspaces/records/${EWS}`, eve, { trashed: "" });
  check("Eve restores the trashed workspace → 200", status, 200);
  const restored = [
    await project_row(su, getitem(eve_shadow, "id")),
    await project_row(su, getitem(eve_normal[0], "id")),
  ];
  console.log(
    `  after restore: shadow=${py_str(restored[0])}\n                 normal=${py_str(restored[1])}`,
  );
  check("the shadow project row is unchanged by the restore as well", restored[0], before[0]);
  check("the normal project row likewise", restored[1], before[1]);
  check(
    "the restored workspace still has exactly one shadow project",
    (await records("projects", su, `(workspace='${esc(EWS)}')`)).filter((p) =>
      truthy(getitem(p, "shadow")),
    ).length,
    1,
  );
  check(
    "and Eve can list its ordinary project again",
    (await records("projects", eve, `(workspace='${esc(EWS)}')`)).map((p) => getitem(p, "name")),
    ["My Project"],
  );

  // A superuser can hard-delete the row; the next item that needs it must not fall back to
  // having no project at all.
  console.log("\n── §3 self-heal after the container row is deleted ──");
  [status] = await api(
    "DELETE",
    `/api/collections/projects/records/${getitem(eve_shadow, "id")}`,
    su,
  );
  check("superuser DELETEs the shadow project → 204", status, 204);
  check(
    "the workspace has no container for a moment",
    (await records("projects", su, `(workspace='${esc(EWS)}' && shadow=true)`)).length,
    0,
  );
  let healed: any;
  [status, healed] = await api("POST", "/api/collections/tasks/records", eve, {
    title: "shadow-s3-heal",
    workspace: EWS,
  });
  check("the next item created with no project → 200", status, 200);
  const rebuilt = await records("projects", su, `(workspace='${esc(EWS)}' && shadow=true)`);
  check("exactly one container exists again", rebuilt.length, 1);
  check(
    "and the item landed in it",
    healed.project ?? null,
    rebuilt.length ? getitem(rebuilt[0], "id") : null,
  );

  // ── §5 the rule tier refuses every reach for the shadow project ──
  console.log("\n── §5 mint, flip, rename and delete are all refused ──");
  [status] = await api("POST", "/api/collections/projects/records", alice, {
    name: "minted-shadow",
    owner: OWNER_ID,
    workspace: WS,
    shadow: true,
  });
  check("owner creates a project with shadow:true → 400 (create denied)", status, 400);
  [status] = await api("POST", "/api/collections/projects/records", alice, {
    name: "minted-shadow-false",
    owner: OWNER_ID,
    workspace: WS,
    shadow: false,
  });
  check("even shadow:false is refused — the rule pins the field PRESENCE", status, 400);
  let ok_proj: any;
  [status, ok_proj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Deletable",
    owner: OWNER_ID,
    workspace: WS,
  });
  check("a project that omits the field is created normally → 200", status, 200);
  [status] = await api(
    "PATCH",
    `/api/collections/projects/records/${getitem(ok_proj, "id")}`,
    alice,
    { shadow: true },
  );
  check("PATCH shadow:true onto a normal project → 404 (update denied)", status, 404);
  check("and the flag did not move", (await project_row(su, getitem(ok_proj, "id"))).shadow, false);
  for (const [who, token] of TIERS) {
    [status] = await api(
      "PATCH",
      `/api/collections/projects/records/${getitem(SHADOW, "id")}`,
      token,
      { name: "renamed" },
    );
    check(`${who}: PATCH the shadow project → 404 (rename denied)`, status, 404);
    [status] = await api(
      "DELETE",
      `/api/collections/projects/records/${getitem(SHADOW, "id")}`,
      token,
    );
    check(`${who}: DELETE the shadow project → 404 (delete denied)`, status, 404);
  }
  check(
    "the shadow project survived every attempt",
    (await project_row(su, getitem(SHADOW, "id"))).name,
    "Workspace items",
  );
  [status] = await api(
    "DELETE",
    `/api/collections/projects/records/${getitem(ok_proj, "id")}`,
    alice,
  );
  check(
    "the owner can still DELETE an ordinary project → 204 (the owner branch of the " +
      "deleteRule survives the shadow conjunct)",
    status,
    204,
  );

  // ── §6 a placement failure leaves the project empty, is logged, and self-heals ──
  console.log("\n── §6 forced placement failure: empty project, one log row, self-heal ──");

  async function placement_failures(): Promise<number> {
    // `_logs` rows from landInShadowProject's catch — the only thing that tells a
    // swallowed placement failure apart from a placement that never had to run.
    const qs = urlencode({
      filter: 'message ~ "shadow project placement failed"',
      perPage: 200,
    });
    const body = (await api("GET", `/api/logs?${qs}`, su))[1];
    return py_get(body, "totalItems", -1);
  }

  async function wait_for_placement_failure(): Promise<boolean> {
    // PocketBase holds each entry ~3s, so a read straight after the write is empty
    // whatever happened; poll to a deadline rather than sleeping once.
    const deadline = Date.now() / 1000 + 20;
    while (Date.now() / 1000 < deadline) {
      if ((await placement_failures()) > 0) return true;
      await Bun.sleep(250);
    }
    return false;
  }

  let fault_ws: any;
  [status, fault_ws] = await api("POST", "/api/collections/workspaces/records", su, {
    name: `${FAULT_MARKER} workspace`,
    owner: OWNER_ID,
  });
  check("a workspace whose container create the probe hook refuses → 200", status, 200);
  const FWS = fault_ws.id ?? null;
  check(
    "it is left with NO container at all",
    (await records("projects", su, `(workspace='${esc(FWS)}' && shadow=true)`)).length,
    0,
  );
  let fault_task: any;
  [status, fault_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "shadow-s6-placement-failure",
    workspace: FWS,
  });
  check("a task created with no project is still WRITTEN → 200", status, 200);
  check(
    "its project is left EMPTY — the swallow admits the write it cannot place",
    fault_task.project ?? null,
    "",
  );
  check(
    "it keeps ordinal 0, the same as a project-less item before decision:shadow-project",
    fault_task.ordinal ?? null,
    0,
  );
  check("the swallowed failure IS logged", await wait_for_placement_failure(), true);
  [status] = await api("PATCH", `/api/collections/workspaces/records/${py_str(FWS)}`, su, {
    name: "shadow-s6 healed workspace",
  });
  check("the injected fault is removed (the workspace is renamed) → 200", status, 200);
  let healed6: any;
  [status, healed6] = await api(
    "PATCH",
    `/api/collections/tasks/records/${getitem(fault_task, "id")}`,
    alice,
    { title: "shadow-s6-healed" },
  );
  check("the next ordinary save of that same task → 200", status, 200);
  const rebuilt6 = await records("projects", su, `(workspace='${esc(FWS)}' && shadow=true)`);
  check("the container exists now", rebuilt6.length, 1);
  check(
    "and the item self-healed into it, with no repair step of its own",
    healed6.project ?? null,
    rebuilt6.length ? getitem(rebuilt6[0], "id") : null,
  );
  check(
    "its ordinal is STILL 0 — the number is claimed after create only",
    healed6.ordinal ?? null,
    0,
  );
} finally {
  await room.stop();
  room.cleanup();
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ all shadow-project proofs passed");
process.exit(0);

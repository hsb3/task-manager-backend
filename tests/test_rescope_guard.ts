#!/usr/bin/env bun
/**
 * PBTT-326 / PBTT-427 — no tenant-anchor relation field may be repointed on update (multi-tenant guard).
 *
 * Derives every relation field on the content-chain + membership/settings + taxonomy/tooling
 * collections from the generated model tree (scripts/model/current/), classifies each as either
 * LEGITIMATELY repointable (ALLOWLIST, with a reason) or a tenant-anchor edge that must be
 * immutable, then proves — against a running server, as the most-privileged non-superuser actor —
 * that a foreign-tenant repoint of every tenant-anchor edge is REJECTED (4xx) and the stored value
 * is unchanged. Reading real behavior (not rule text) means a hook guard counts identical to a rule
 * guard: projects.workspace is immutable by hook (TASK-071), workspaces.owner by rule (PBTT-326),
 * the four taxonomy collections' workspace by rule (PBTT-427, 1785157100), and projects.owner by
 * rule (9fkw, 1785162500) — both pointers on a project are now frozen after create.
 *
 * A new relation field that is neither allowlisted nor given a fixture fails the run LOUD — that
 * is the ruling-F derived coverage: future tenant edges (content-chain OR taxonomy) cannot ship
 * unguarded and unnoticed.
 *
 * verify_grep tokens for scripts/model/target/*.yml (scope.rescope facets; projects.owner is
 * cited by the owner-immutable-after-create invariant) — do not rename without updating those
 * targets in lockstep:
 *     rescope-immutable:workspaces.owner
 *     rescope-immutable:workspace_members.workspace
 *     rescope-immutable:workspace_members.user
 *     rescope-immutable:user_settings.user
 *     rescope-immutable:projects.owner
 *
 * Self-booting clean room, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_repr,
  py_str,
  read_text,
  run_checked,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const MODEL_DIR = path.join(REPO_ROOT, "scripts", "model", "current");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8139 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

// Python tuple keys → JSON.stringify([collection, field]) in Map/Set (PORTING.md).
const tkey = (c: string, f: string): string => JSON.stringify([c, f]);
const by_pair = (a: [string, string], b: [string, string]): number =>
  by_code_point(a[0], b[0]) || by_code_point(a[1], b[1]);

// ── The tenant tree: user → workspace → project → task/items, plus the membership and
// settings satellites, plus the taxonomy/tooling collections (labels/statuses/templates/
// saved_views) whose workspace anchor PBTT-427 froze — every one of these collections' relation
// fields is classified below. ───────────────────────────────────────────────────────────────
const IN_SCOPE_COLLECTIONS = [
  "workspaces",
  "projects",
  "tasks",
  "decisions",
  "documents",
  "milestones",
  "comments",
  "workspace_members",
  "user_settings",
  "labels",
  "saved_views",
  "statuses",
  "templates",
];

// (collection, field) → why this relation is legitimately repointable. Everything on an
// in-scope collection that is NOT here defaults to must-be-immutable; a stale key (a field
// no longer in the schema) fails the run.
const ALLOWLIST = new Map<string, string>(
  (
    [
      [
        ["workspaces", "default_project"],
        "workspace's default-project pointer; a foreign value is rejected by the default_project-belongs-to-workspace hook",
      ],
      [
        ["tasks", "project"],
        "within-workspace rescope; a foreign value is rejected by the project-must-belong-to-workspace hook",
      ],
      [
        ["tasks", "assignee"],
        "assignee reassignment; a foreign value is rejected by the assignee-membership hook",
      ],
      [
        ["tasks", "milestone"],
        "milestone assignment; a foreign value is rejected by the scope hook",
      ],
      [
        ["tasks", "cycle"],
        "cycle assignment; a foreign value is rejected by the cycle-belongs-to-workspace hook",
      ],
      [
        ["tasks", "parent"],
        "subtask threading; a foreign value is rejected by the same-project hook",
      ],
      [
        ["tasks", "dependencies"],
        "dependency links; a foreign value is rejected by the same-project hook",
      ],
      [
        ["tasks", "status"],
        "status assignment; a foreign value is rejected by the status-belongs-to-workspace hook",
      ],
      [
        ["tasks", "labels"],
        "label assignment; a foreign value is rejected by the dual-scope label hook",
      ],
      [
        ["tasks", "trashed_by"],
        "stamped by the trash hook; an attribution field, not a tenant-anchor edge",
      ],
      [["tasks", "author"], "attribution set from the caller at create; not a tenant-anchor edge"],
      [
        ["decisions", "project"],
        "within-workspace rescope; a foreign value is rejected by the project-mismatch hook",
      ],
      [
        ["decisions", "author"],
        "attribution set from the caller at create; not a tenant-anchor edge",
      ],
      [
        ["decisions", "trashed_by"],
        "stamped by the trash hook; an attribution field, not a tenant-anchor edge",
      ],
      [
        ["documents", "project"],
        "within-workspace rescope; a foreign value is rejected by the project-mismatch hook",
      ],
      [
        ["documents", "author"],
        "attribution set from the caller at create; not a tenant-anchor edge",
      ],
      [
        ["documents", "trashed_by"],
        "stamped by the trash hook; an attribution field, not a tenant-anchor edge",
      ],
      [
        ["milestones", "project"],
        "within-workspace rescope; a foreign value is rejected by the project-must-belong-to-workspace hook",
      ],
      [
        ["milestones", "author"],
        "attribution set from the caller at create; not a tenant-anchor edge",
      ],
      [
        ["milestones", "trashed_by"],
        "stamped by the trash hook; an attribution field, not a tenant-anchor edge",
      ],
      [
        ["comments", "author"],
        "attribution set from the caller at create; not a tenant-anchor edge",
      ],
      [
        ["user_settings", "default_view"],
        "the user's own default saved-view pointer on a self-private record",
      ],
      [
        ["user_settings", "default_project"],
        "the user's own default-project pointer on a self-private record",
      ],
      // ── taxonomy/tooling (PBTT-427): workspace is the tenant anchor (fixtured immutable
      // below); the project/owner pointers below are within-tenant, not tenant anchors. ──
      [
        ["labels", "project"],
        "within-workspace label scoping; a foreign value is rejected by the label-project-workspace-match hook (scope.pb.js G1)",
      ],
      [
        ["templates", "project"],
        "within-workspace template scoping; a foreign value is rejected by the template-project-workspace-match hook (scope.pb.js G3)",
      ],
      [
        ["saved_views", "owner"],
        "the view's creator; a within-workspace attribution set to the caller at create, not a tenant-anchor edge (the view stays readable only to its workspace's members)",
      ],
      [
        ["saved_views", "project"],
        "within-workspace view scoping; a foreign value is rejected by the view-project-workspace-match hook (scope.pb.js PBTT-429)",
      ],
    ] as [[string, string], string][]
  ).map(([k, why]) => [tkey(k[0], k[1]), why]),
);

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

function fail(label: string): void {
  failures += 1;
  console.log(`  ❌ ${label}`);
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

function esc(value: string): string {
  return value.replaceAll("'", "\\'");
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null,
): Promise<any> {
  const qs = urlencode({ filter: `${field}='${esc(value)}'` });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? getitem(items[0], "id") : null;
}

async function query(collection: string, filt: string, token: string | null): Promise<any[]> {
  const qs = urlencode({ filter: filt, perPage: 50 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return r.items || [];
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
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

// ── Derive the relation-field universe from the generated model tree ────────────────────────
// YAML: only the keys `relations` and `field` are read, and every `field` value in the model
// tree is a plain identifier (none in the YAML 1.1 bool/int set), so Bun's 1.2 typing agrees.
function derive_relation_fields(): Map<string, [string, string]> {
  const fields = new Map<string, [string, string]>();
  for (const coll of IN_SCOPE_COLLECTIONS) {
    const doc: any = Bun.YAML.parse(read_text(path.join(MODEL_DIR, `${coll}.yml`)));
    for (const rel of doc.relations || []) {
      fields.set(tkey(coll, getitem(rel, "field")), [coll, getitem(rel, "field")]);
    }
  }
  return fields;
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-rescope-guard-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log("════════ test_rescope_guard.ts — PBTT-326 tenant-anchor immutability ════════");

  // (1) Static coverage: every allowlist key exists, and no tenant edge is left unclassified.
  console.log("\n── (1) derived-schema coverage: allowlist freshness + no unclassified edge ──");
  const derived = derive_relation_fields();
  const allow_pairs = [...ALLOWLIST.keys()].map((k) => JSON.parse(k) as [string, string]);
  for (const key of allow_pairs.sort(by_pair)) {
    if (!derived.has(tkey(key[0], key[1]))) {
      fail(`ALLOWLIST names ${key[0]}.${key[1]} but the schema has no such relation (stale)`);
    }
  }
  const must_immutable = [...derived.entries()]
    .filter(([k]) => !ALLOWLIST.has(k))
    .map(([, v]) => v)
    .sort(by_pair);
  console.log(
    `  derived ${derived.size} relation field(s) on ${IN_SCOPE_COLLECTIONS.length} collection(s); ` +
      `${ALLOWLIST.size} allowlisted, ${must_immutable.length} must be immutable`,
  );

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
  // dave: a fourth user, no membership in Alice's workspace. dave auto-provisions his own
  // settings row, so the one-per-user unique index ALSO rejects a user-repoint — but with a
  // 400 (validation_not_unique), whereas the rule guard denies with 404. The 404 the proof
  // asserts is the guard firing; the status code is what distinguishes it from the index.
  const [, dave] = await api("POST", "/api/collections/users/records", su, {
    email: "dave@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Dave",
  });
  const dave_id = getitem(dave, "id");

  const AWS = await find_id("workspaces", "name", "Alice's Workspace", su);
  const BWS = await find_id("workspaces", "name", "Bob's Workspace", su);
  const APROJ = await find_id("projects", "name", "Website Redesign", alice);

  // Bob → ADMIN of Alice's workspace: the most-privileged non-owner, non-superuser actor.
  const bob_mem = await find_id("workspace_members", "user", bob_id, alice);
  await api("PATCH", `/api/collections/workspace_members/records/${py_str(bob_mem)}`, alice, {
    role: "admin",
  });
  // Carol → plain member of Alice's workspace: the membership row an admin will try to move.
  const [, carol_mem] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: AWS,
    user: carol_id,
    role: "member",
    status: "active",
  });
  const carol_mem_id = getitem(carol_mem, "id");

  // POST as `token` and return the new record's id (Python: api(...)[1]["id"]).
  const created = async (collection: string, token: string, body: any): Promise<any> =>
    getitem((await api("POST", `/api/collections/${collection}/records`, token, body))[1], "id");

  // AWS-side records to attack, and BWS-side foreign values to point them at.
  const a_task = await created("tasks", alice, {
    title: "guard-task",
    workspace: AWS,
    project: APROJ,
  });
  const a_dec = await created("decisions", alice, { title: "guard-dec", workspace: AWS });
  const a_doc = await created("documents", alice, { title: "guard-doc", workspace: AWS });
  const a_mile = await created("milestones", alice, {
    name: "guard-mile",
    workspace: AWS,
    project: APROJ,
  });
  const a_comment = await created("comments", alice, { task: a_task, body: "guard-comment" });
  let a_settings = await find_id("user_settings", "user", alice_id, alice);
  if (!truthy(a_settings)) {
    a_settings = await created("user_settings", alice, { user: alice_id });
  }
  const a_project = APROJ;

  // PBTT-427 taxonomy/tooling records in Alice's workspace — the workspace anchor an admin
  // will try to repoint into Bob's workspace (cross-tenant exfiltration).
  const a_label = await created("labels", alice, { name: "guard-label", workspace: AWS });
  const a_view = await created("saved_views", alice, {
    name: "guard-view",
    workspace: AWS,
    owner: alice_id,
    scope: "workspace",
  });
  const a_status = await created("statuses", alice, {
    name: "guard-status",
    workspace: AWS,
    category: "started",
  });
  const a_template = await created("templates", alice, {
    name: "guard-template",
    workspace: AWS,
    type: "task",
  });

  const b_task = getitem((await query("tasks", `workspace='${BWS}'`, su))[0], "id");
  const b_dec = await created("decisions", bob, { title: "foreign-dec", workspace: BWS });
  const b_doc = await created("documents", bob, { title: "foreign-doc", workspace: BWS });
  const b_comment = await created("comments", bob, { task: b_task, body: "foreign-comment" });

  // (collection, field) → (record_id, field, foreign_value, actor_token, actor_label).
  // actor is the most-privileged caller that could plausibly succeed at the repoint.
  type Fixture = [any, string, any, string, string];
  const FIXTURES = new Map<string, Fixture>(
    (
      [
        [
          ["workspaces", "owner"],
          [AWS, "owner", bob_id, bob, "admin Bob (owner-takeover attack)"],
        ],
        [
          ["projects", "workspace"],
          [a_project, "workspace", BWS, alice, "owner Alice"],
        ],
        // Carol is still a plain ACTIVE member here — section (4) only promotes/suspends her
        // afterwards, so this is the un-privileged self-grab the guard has to refuse.
        [
          ["projects", "owner"],
          [a_project, "owner", carol_id, carol, "member Carol (owner-grab attack)"],
        ],
        [
          ["tasks", "workspace"],
          [a_task, "workspace", BWS, alice, "owner Alice"],
        ],
        [
          ["decisions", "workspace"],
          [a_dec, "workspace", BWS, alice, "owner Alice"],
        ],
        [
          ["documents", "workspace"],
          [a_doc, "workspace", BWS, alice, "owner Alice"],
        ],
        [
          ["milestones", "workspace"],
          [a_mile, "workspace", BWS, alice, "owner Alice"],
        ],
        [
          ["comments", "task"],
          [a_comment, "task", b_task, alice, "author Alice"],
        ],
        [
          ["comments", "document"],
          [a_comment, "document", b_doc, alice, "author Alice"],
        ],
        [
          ["comments", "decision"],
          [a_comment, "decision", b_dec, alice, "author Alice"],
        ],
        [
          ["comments", "parent"],
          [a_comment, "parent", b_comment, alice, "author Alice"],
        ],
        [
          ["workspace_members", "workspace"],
          [carol_mem_id, "workspace", BWS, bob, "admin Bob"],
        ],
        [
          ["workspace_members", "user"],
          [carol_mem_id, "user", dave_id, bob, "admin Bob"],
        ],
        [
          ["user_settings", "user"],
          [a_settings, "user", dave_id, alice, "owner Alice (self)"],
        ],
        [
          ["labels", "workspace"],
          [a_label, "workspace", BWS, bob, "admin Bob"],
        ],
        [
          ["saved_views", "workspace"],
          [a_view, "workspace", BWS, bob, "admin Bob"],
        ],
        [
          ["statuses", "workspace"],
          [a_status, "workspace", BWS, bob, "admin Bob"],
        ],
        [
          ["templates", "workspace"],
          [a_template, "workspace", BWS, bob, "admin Bob"],
        ],
      ] as [[string, string], Fixture][]
    ).map(([k, v]) => [tkey(k[0], k[1]), v]),
  );

  // (2) Every must-immutable edge needs a fixture — an un-fixtured tenant edge fails LOUD.
  console.log("\n── (2) every tenant-anchor edge has a repoint fixture (no silent skip) ──");
  const missing = must_immutable
    .filter(([c, f]) => !FIXTURES.has(tkey(c, f)))
    .map(([c, f]) => `${c}.${f}`);
  if (missing.length) {
    for (const m of missing) {
      fail(`tenant-anchor edge ${m} has no repoint fixture — add one to FIXTURES`);
    }
  } else {
    console.log(`  ✅  all ${must_immutable.length} tenant-anchor edge(s) fixtured`);
  }
  for (const k of FIXTURES.keys()) {
    const key = JSON.parse(k) as [string, string];
    if (ALLOWLIST.has(k)) fail(`${key[0]}.${key[1]} is both allowlisted and fixtured — pick one`);
    if (!derived.has(k)) {
      fail(`FIXTURES names ${key[0]}.${key[1]} but the schema has no such relation (stale)`);
    }
  }

  // (3) Behavioral proof: a foreign-tenant repoint of every tenant-anchor edge is refused.
  console.log(
    "\n── (3) repoint of each tenant-anchor edge → rejected (4xx) AND stored value unchanged ──",
  );
  for (const [coll, field] of must_immutable) {
    if (!FIXTURES.has(tkey(coll, field))) continue;
    const [rid, fld, foreign, actor, who] = FIXTURES.get(tkey(coll, field))!;
    const before = (await api("GET", `/api/collections/${coll}/records/${py_str(rid)}`, su))[1];
    const [status] = await api("PATCH", `/api/collections/${coll}/records/${py_str(rid)}`, actor, {
      [fld]: foreign,
    });
    const after = (await api("GET", `/api/collections/${coll}/records/${py_str(rid)}`, su))[1];
    const rejected = status >= 400;
    const unchanged = Bun.deepEquals(before[fld] ?? null, after[fld] ?? null, true);
    const ok = rejected && unchanged;
    if (!ok) failures += 1;
    const glyph = ok ? "✅" : "❌ LEAK";
    console.log(
      `  ${glyph}  ${coll}.${field.padEnd(14)} by ${who.padEnd(34)} → ${status} unchanged=${py_str(unchanged)}`,
    );
  }

  // (4) The guards do not over-fire: the legitimate paths still work.
  console.log("\n── (4) legitimate paths still succeed (guard does not over-fire) ──");
  let s: number;
  // FIRST, while Carol is still an active plain member — section (4) promotes then suspends her.
  [s] = await api("POST", "/api/collections/projects/records", alice, {
    name: "guard-proj-create-owner",
    owner: alice_id,
    workspace: AWS,
  });
  check("workspace owner CREATEs a project (payload carries owner)", s, 200);
  [s] = await api("POST", "/api/collections/projects/records", carol, {
    name: "guard-proj-create-member",
    owner: carol_id,
    workspace: AWS,
  });
  check("member CREATEs a project (payload carries owner)", s, 200);
  [s] = await api("PATCH", `/api/collections/projects/records/${py_str(a_project)}`, alice, {
    name: "guard-proj renamed by owner",
    description: "owner edit",
  });
  check("workspace owner PATCHes project name+description", s, 200);
  [s] = await api("PATCH", `/api/collections/projects/records/${py_str(a_project)}`, carol, {
    name: "guard-proj renamed by member",
  });
  check("member PATCHes project name", s, 200);
  [s] = await api("PATCH", `/api/collections/user_settings/records/${py_str(a_settings)}`, alice, {
    theme: "dark",
  });
  check("owner edits own settings.theme", s, 200);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${py_str(AWS)}`, bob, {
    name: "AWS renamed by admin",
  });
  check("admin edits workspace.name (non-owner field)", s, 200);
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${carol_mem_id}`, alice, {
    role: "admin",
  });
  check("owner changes a member's role", s, 200);
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${carol_mem_id}`, bob, {
    status: "suspended",
  });
  check("admin changes a member's status (role untouched)", s, 200);
  const p2 = await created("projects", alice, {
    name: "guard-proj2",
    owner: alice_id,
    workspace: AWS,
  });
  [s] = await api("PATCH", `/api/collections/tasks/records/${a_task}`, alice, { project: p2 });
  check("owner rescopes a task to another project in the same workspace", s, 200);
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ all tenant-anchor immutability proofs passed");
process.exit(0);

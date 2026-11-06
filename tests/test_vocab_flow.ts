#!/usr/bin/env bun
/**
 * G1 (#74) — the vocabulary INTEGRATION flow: statuses + labels as first-class,
 * workspace-scoped collections (relations, not JSON/text), project_stats bucketed by
 * statuses.category, and the status-delete-while-referenced guard.
 *
 * Fully self-contained clean-room server, real `pb_hooks/`, scripts/seed.ts fixtures.
 *
 * All steps run as Alice (the workspace owner) unless noted:
 *   §1 create a CUSTOM status + a CUSTOM label → 200.
 *   §2 create a task using both → expand=status,labels matches (a live relation).
 *   §3 board math: project_stats' buckets match a live tasks query; moving a task to
 *      a `completed`-category status increments the bucket and stamps completedAt.
 *   §4 renaming the custom status/label is reflected through a referencing task's
 *      expand (relation, not a copied string).
 *   §5 deleting a referenced status is BLOCKED (400); repointing then deleting
 *      succeeds (204).
 *
 * Port: 8094 + PB_PORT_OFFSET (per CLAUDE.md's port bands).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  py_get,
  py_repr,
  py_rstrip,
  py_str,
  py_strip,
  run_checked,
  splitlines,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const SEED_SCRIPT = path.join(REPO_ROOT, "scripts", "seed.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8094 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Dummy superuser — NOT a real secret; scripts/seed.ts reads these same env var names.
const SU_EMAIL = "vocab-ci@example.test";
const SU_PASSWORD = "vocab-ci-dummy-pw-000";

// Every six Linear-style status categories, for the board-math bucket comparison.
const CATEGORIES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  const mark = ok ? "✅" : "❌ MISMATCH";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label.padEnd(64)} → ${py_str(got)} (expected ${py_str(expected)})`);
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
  if (r.ok) {
    if (r.status === 204) return [204, {}];
    return [r.status, raw ? JSON.parse(raw) : {}];
  }
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, {}];
  }
}

class Room {
  // A self-contained `pocketbase serve` clean-room using the repo's REAL
  // pb_hooks/ (the vocab hooks under test, and seed.ts's provisioning, live there).
  port: number;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number) {
    this.port = port;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-vocab-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    for (const f of fs.readdirSync(this.migrations_dir)) {
      if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(this.migrations_dir, f));
    }
    this.proc = null;
  }

  async start(): Promise<void> {
    run_checked(
      [
        POCKETBASE_BIN,
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
    this.proc = await roomkit.serve(
      this.port,
      this.data_dir,
      this.migrations_dir,
      roomkit.hooks_dir(this.tmp),
    );
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

async function seed_room(): Promise<string> {
  const proc = Bun.spawn([process.execPath, SEED_SCRIPT], {
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
  const [stdout, stderr, returncode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (returncode !== 0) {
    throw new roomkit.SystemExit(
      `scripts/seed.ts failed (rc=${returncode}):\n${stdout}\n${stderr}`,
    );
  }
  return stdout;
}

async function login(email: string, password = "test123456"): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password,
  });
  const tok = r.token;
  if (!truthy(tok)) throw new roomkit.SystemExit(`login failed for ${email}: ${py_str(r)}`);
  return tok;
}

async function find_one(collection: string, filt: string, token: string | null): Promise<any> {
  const qs = urlencode({ filter: filt, perPage: 1 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = truthy(r.items) ? r.items : [];
  if (!items.length) {
    throw new roomkit.SystemExit(
      `no ${collection} record matched filter ${py_repr(filt)}: ${py_str(r)}`,
    );
  }
  return items[0];
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null,
): Promise<any> {
  return getitem(await find_one(collection, `${field}='${esc(value)}'`, token), "id");
}

// Independently compute {total, <category>: count} from a live tasks query
// with expand=status — the same numbers project_stats' SQL view should produce.
async function bucket_tasks(
  project_id: string,
  token: string | null,
): Promise<Record<string, number>> {
  const qs = urlencode({ filter: `project='${project_id}'`, expand: "status", perPage: 200 });
  const [, r] = await api("GET", `/api/collections/tasks/records?${qs}`, token);
  const items = truthy(r.items) ? r.items : [];
  const out: Record<string, number> = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  out.total = items.length;
  for (const it of items) {
    const expand = truthy(it.expand) ? it.expand : {};
    const cat = py_get(py_get(expand, "status", {}), "category", null);
    if (Object.hasOwn(out, cat)) out[cat] += 1;
  }
  return out;
}

async function get_project_stats(project_id: string, token: string | null): Promise<any> {
  const [, r] = await api("GET", `/api/collections/project_stats/records/${project_id}`, token);
  return r;
}

console.log(
  `════════ test_vocab_flow.ts — G1 vocabulary integration flow (room on :${PORT}) ════════`,
);
const room = new Room(PORT);
try {
  await room.start();
  const seed_log = await seed_room();
  console.log(
    "  " +
      (py_strip(seed_log) ? splitlines(py_rstrip(seed_log)).at(-1) : "(seed produced no output)"),
  );

  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com"); // seeded non-owner member of Alice's workspace
  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  console.log(`  fixtures: ALICE_WS=${ALICE_WS}  ALICE_PROJECT=${ALICE_PROJECT}`);

  let s: number;

  // ── §1 create a CUSTOM status + a CUSTOM label (owner may) ─────────────────
  console.log("\n── §1 create custom status + custom label (owner/admin may, 200) ──");
  let status_rec: any;
  [s, status_rec] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "In Review",
    category: "started",
    color: "purple",
  });
  check("create custom status 'In Review' (category=started)", s, 200);
  const STATUS_ID = status_rec.id;

  let label_rec: any;
  [s, label_rec] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "urgent",
    color: "red",
  });
  check("create custom label 'urgent'", s, 200);
  const LABEL_ID = label_rec.id;

  // ── §2 a task USING the custom status + label; expand proves the relation ──
  console.log("\n── §2 task using the custom status + label; expand reflects both ──");
  let task_rec: any;
  [s, task_rec] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "VOCAB-FLOW fixture task",
    workspace: ALICE_WS,
    project: ALICE_PROJECT,
    status: STATUS_ID ?? null,
    labels: [LABEL_ID ?? null],
  });
  check("create task with custom status + label", s, 200);
  const TASK_ID = task_rec.id;

  let expanded: any;
  [s, expanded] = await api(
    "GET",
    `/api/collections/tasks/records/${TASK_ID}?expand=status,labels`,
    alice,
  );
  check("GET task w/ expand → 200", s, 200);
  const exp = py_get(expanded, "expand", {});
  check("expanded status.name == 'In Review'", py_get(exp, "status", {}).name, "In Review");
  const label_names = py_get(exp, "labels", []).map((lbl: any) => lbl.name);
  check("expanded labels include 'urgent'", label_names.includes("urgent"), true);

  // ── §3 board math ────────────────────────────────────────────────────────
  console.log("\n── §3 board math: project_stats matches the actual task distribution ──");
  const expected = await bucket_tasks(ALICE_PROJECT, alice);
  const stats = await get_project_stats(ALICE_PROJECT, alice);
  check("project_stats.total == live task count", stats.total, expected.total);
  for (const cat of CATEGORIES) {
    check(`project_stats.${cat} == live count`, stats[cat], expected[cat]);
  }

  console.log("  · moving a task to a completed-category status …");
  const move_task = await find_one(
    "tasks",
    `project='${esc(ALICE_PROJECT)}' && title='Wire up nav'`,
    alice,
  );
  const done_status = await find_one(
    "statuses",
    `workspace='${esc(ALICE_WS)}' && name='Done'`,
    alice,
  );
  const before_completed = getitem(stats, "completed");
  [s] = await api("PATCH", `/api/collections/tasks/records/${getitem(move_task, "id")}`, alice, {
    status: getitem(done_status, "id"),
  });
  check("PATCH task status -> 'Done' (completed category)", s, 200);

  const stats_after = await get_project_stats(ALICE_PROJECT, alice);
  const expected_after = await bucket_tasks(ALICE_PROJECT, alice);
  check("project_stats.completed incremented by 1", stats_after.completed, before_completed + 1);
  check(
    "project_stats (fresh GET) matches live recompute",
    Object.fromEntries(CATEGORIES.map((c) => [c, stats_after[c]])),
    Object.fromEntries(CATEGORIES.map((c) => [c, expected_after[c]])),
  );

  let moved: any;
  [s, moved] = await api(
    "GET",
    `/api/collections/tasks/records/${getitem(move_task, "id")}`,
    alice,
  );
  check("moved task's completedAt is non-empty", truthy(moved.completedAt), true);

  // ── §3b completedAt is server-owned at CREATE (PBTT-339 mass-assignment) ───
  // A member submitting completedAt on a non-completed create must NOT stick
  // (it would poison cycle-time reporting); a completed-status create still stamps.
  console.log(
    "\n── §3b completedAt server-owned at create: non-completed cleared, completed stamped ──",
  );
  let backlog_status = await find_one(
    "statuses",
    `workspace='${esc(ALICE_WS)}' && name='Backlog'`,
    alice,
  );
  const done_status_3b = await find_one(
    "statuses",
    `workspace='${esc(ALICE_WS)}' && name='Done'`,
    alice,
  );

  let born: any;
  [s, born] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "PBTT-339 completedAt spoof",
    project: ALICE_PROJECT,
    status: getitem(backlog_status, "id"),
    completedAt: "2020-01-01 00:00:00.000Z",
  });
  check("member creates Backlog task with a spoofed completedAt -> 200", s, 200);
  check(
    "spoofed completedAt on a non-completed create is neutralized (stored '')",
    py_get(born, "completedAt", "<missing>"),
    "",
  );

  let born_done: any;
  [s, born_done] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "PBTT-339 completedAt create-stamp",
    project: ALICE_PROJECT,
    status: getitem(done_status_3b, "id"),
  });
  check("member creates a Done-status task -> 200", s, 200);
  check(
    "completed-status create still stamps completedAt (non-empty)",
    truthy(born_done.completedAt),
    true,
  );

  // ── §4 rename the custom status + label; expand on a referencing task ──────
  console.log("\n── §4 rename custom status/label → referencing task's expand reflects it ──");
  [s] = await api("PATCH", `/api/collections/statuses/records/${STATUS_ID}`, alice, {
    name: "Reviewing",
  });
  check("PATCH status name 'In Review' -> 'Reviewing'", s, 200);
  [s] = await api("PATCH", `/api/collections/labels/records/${LABEL_ID}`, alice, {
    name: "critical",
  });
  check("PATCH label name 'urgent' -> 'critical'", s, 200);

  let expanded2: any;
  [s, expanded2] = await api(
    "GET",
    `/api/collections/tasks/records/${TASK_ID}?expand=status,labels`,
    alice,
  );
  check("GET task w/ expand after rename → 200", s, 200);
  const exp2 = py_get(expanded2, "expand", {});
  check(
    "expanded status.name now 'Reviewing' (live relation, not a copy)",
    py_get(exp2, "status", {}).name,
    "Reviewing",
  );
  const label_names2 = py_get(exp2, "labels", []).map((lbl: any) => lbl.name);
  check("expanded labels now include 'critical'", label_names2.includes("critical"), true);

  // ── §5 delete-status-while-referenced is BLOCKED, then succeeds once clear ──
  // COVERS: hook:main.pb.js#onRecordDeleteRequest:statuses
  console.log(
    "\n── §5 delete a referenced status is blocked (400); clear+delete succeeds (204) ──",
  );
  [s] = await api("DELETE", `/api/collections/statuses/records/${STATUS_ID}`, alice);
  check("DELETE status while task references it → 400", s, 400);
  [s] = await api("GET", `/api/collections/statuses/records/${STATUS_ID}`, alice);
  check("status still exists after the blocked delete", s, 200);

  backlog_status = await find_one(
    "statuses",
    `workspace='${esc(ALICE_WS)}' && name='Backlog'`,
    alice,
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${TASK_ID}`, alice, {
    status: getitem(backlog_status, "id"),
  });
  check("repoint the task off the custom status -> 200", s, 200);

  [s] = await api("DELETE", `/api/collections/statuses/records/${STATUS_ID}`, alice);
  check("DELETE status once unreferenced -> 204", s, 204);
  [s] = await api("GET", `/api/collections/statuses/records/${STATUS_ID}`, alice);
  check("status gone (404) after the successful delete", s, 404);
} finally {
  await room.stop();
  room.cleanup_tmp();
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
  process.exit(0);
}

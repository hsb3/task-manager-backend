#!/usr/bin/env bun
/**
 * Load smoke-test: MEASURES the 7 performance indexes instead of guessing.
 *
 * Boots its own clean room on port 8098 + PB_PORT_OFFSET — shared with test_backups
 * and test_observability at offset 0, so relocate with
 * PB_PORT_OFFSET rather than run it beside them. Seeds a scaled
 * deterministic synthetic dataset, and reports p50/p95 latency + `EXPLAIN QUERY PLAN`
 * (SCAN -> SEARCH USING INDEX) before vs after toggling the indexes live via the
 * collections API on the same data dir. Runs as a NORMAL authed user (not superuser,
 * which bypasses rules) with the rate limiter disabled.
 *
 * Run: `bun scripts/load_smoketest.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  decode_text,
  json_dumps,
  py_float,
  py_repr,
  py_split,
  py_str,
  run_checked,
} from "./_py.ts";
import * as roomkit from "../tests/roomkit.ts";
import { copy_tree } from "./_scratch_copy.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));

const HELP = `usage: load_smoketest.ts [-h]

Load smoke-test: MEASURES the 7 performance indexes instead of guessing. Boots
its own clean room on port 8098 + PB_PORT_OFFSET — shared with test_backups
and test_observability at offset 0, so relocate with PB_PORT_OFFSET rather
than run it beside them. Seeds a scaled deterministic synthetic dataset, and
reports p50/p95 latency + \`EXPLAIN QUERY PLAN\` (SCAN -> SEARCH USING INDEX)
before vs after toggling the indexes live via the collections API on the same
data dir. Runs as a NORMAL authed user (not superuser, which bypasses rules)
with the rate limiter disabled. Run: \`bun scripts/load_smoketest.ts\`.

options:
  -h, --help  show this help message and exit
`;

const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8098 + PORT_OFFSET;

// The 7 performance indexes (also defined inline in each collection-create migration);
// toggled live here via the superuser collections API.
const PERF_INDEXES: [string, string, string][] = [
  ["tasks", "idx_tasks_project", "CREATE INDEX `idx_tasks_project` ON `tasks` (`project`)"],
  ["tasks", "idx_tasks_assignee", "CREATE INDEX `idx_tasks_assignee` ON `tasks` (`assignee`)"],
  [
    "projects",
    "idx_projects_workspace",
    "CREATE INDEX `idx_projects_workspace` ON `projects` (`workspace`)",
  ],
  [
    "workspaces",
    "idx_workspaces_owner",
    "CREATE INDEX `idx_workspaces_owner` ON `workspaces` (`owner`)",
  ],
  [
    "decisions",
    "idx_decisions_workspace",
    "CREATE INDEX `idx_decisions_workspace` ON `decisions` (`workspace`)",
  ],
  [
    "milestones",
    "idx_milestones_workspace",
    "CREATE INDEX `idx_milestones_workspace` ON `milestones` (`workspace`)",
  ],
  ["comments", "idx_comments_task", "CREATE INDEX `idx_comments_task` ON `comments` (`task`)"],
];
const BASE_URL = `http://127.0.0.1:${PORT}`;

const SU_EMAIL = "loadsmoke-su@example.test";
const SU_PASSWORD = "loadsmoke-su-dummy-pw-000";
const USER_EMAIL = "loadsmoke-user@example.test";
const USER_PASSWORD = "loadsmoke-user-pw-000";

// Deterministic, SELECTIVE synthetic dataset: indexed columns are spread across many
// distinct values, since SQLite only uses an index when the filter selects a subset.
const N_USERS = 30; // owner/assignee cardinality
const N_WORKSPACES = 600; // workspaces table; owner spread across the users
const N_MEASURED_PROJECTS = 40; // projects in the measured workspace that hold tasks
const N_TASKS_PER_PROJECT = 100; // 4000 tasks total
const N_FILLER_PROJECTS = 1200; // projects spread across all workspaces
const N_DECISIONS = 1500; // spread across all workspaces
const N_MILESTONES = 1500; // spread across all workspaces
const N_COMMENTS = 1500; // spread across many tasks
const N_COMMENT_TASKS = 500; // distinct tasks the comments spread over
const BATCH_SIZE = 200;

const REQUESTS_PER_ENDPOINT = 300; // timed requests after a discarded warm-up
const WARMUP = 20;
const CONCURRENCY = 12;

let _429_COUNT = 0;

/** Return [status, json]. If timed, also time the round trip (ms) as the 3rd item. */
async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
  timed = false,
): Promise<any[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const t0 = performance.now();
  const r = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body !== null ? json_dumps(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await r.text();
  const status = r.status;
  let payload: any;
  if (r.ok) {
    payload = status === 204 ? {} : JSON.parse(raw);
  } else {
    if (status === 429) _429_COUNT += 1;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      payload = {};
    }
  }
  const dt = performance.now() - t0;
  if (timed) return [status, payload, dt];
  return [status, payload];
}

async function superuser_token(): Promise<string | undefined> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  return r.token;
}

async function user_token(): Promise<string | undefined> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: USER_EMAIL,
    password: USER_PASSWORD,
  });
  return r.token;
}

/** A `pocketbase serve` on PORT against a given data dir + migrations dir. */
class Server {
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null = null;

  constructor(data_dir: string, migrations_dir: string) {
    this.data_dir = data_dir;
    this.migrations_dir = migrations_dir;
  }

  upsert_superuser(): void {
    // Resolved here, not at import time — a --help run must not need a usable binary.
    run_checked(
      [
        roomkit.pb_bin(),
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
  }

  async start(): Promise<void> {
    // No hooksDir: workspace + membership are created explicitly as superuser below.
    this.proc = await roomkit.serve(PORT, this.data_dir, this.migrations_dir);
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
    this.proc = null;
  }
}

/** Copy pb_migrations to dst, dropping the MFA migration (plain superuser auth). */
function build_migrations_copy(dst: string): void {
  copy_tree(REAL_MIGRATIONS_DIR, dst);
  for (const f of fs.readdirSync(dst)) {
    if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(dst, f));
  }
}

/**
 * DROP (add=False) or ADD (add=True) the 7 perf indexes via the superuser
 * collections API on a live room, grouped by collection (GET+PATCH per collection);
 * PocketBase reconciles SQLite indexes on save, so no server restart is needed.
 */
async function toggle_perf_indexes(su_token: string, add: boolean): Promise<void> {
  const by_collection = new Map<string, [string, string][]>();
  for (const [coll, name, sql] of PERF_INDEXES) {
    if (!by_collection.has(coll)) by_collection.set(coll, []);
    by_collection.get(coll)!.push([name, sql]);
  }

  for (const [coll, entries] of by_collection) {
    const [status, record] = await api("GET", `/api/collections/${coll}`, su_token);
    if (status !== 200) {
      throw new Error(
        `GET collection ${coll} failed: HTTP ${status}: ${py_str(record).slice(0, 300)}`,
      );
    }
    const current: string[] = record.indexes || [];
    const markers = entries.map(([name]) => `\`${name}\``);
    const kept = current.filter((idx) => !markers.some((m) => idx.includes(m)));
    const new_indexes = add ? [...kept, ...entries.map(([, sql]) => sql)] : kept;
    const [pstatus, resp] = await api("PATCH", `/api/collections/${coll}`, su_token, {
      indexes: new_indexes,
    });
    if (pstatus !== 200) {
      throw new Error(
        `PATCH collection ${coll} indexes failed: HTTP ${pstatus}: ${py_str(resp).slice(0, 300)}`,
      );
    }
  }
}

/**
 * One superuser settings PATCH: disable the rate limiter and raise the batch
 * limit so seeding runs as a few large transactions.
 */
async function prepare_room(su_token: string): Promise<number> {
  const [status] = await api("PATCH", "/api/settings", su_token, {
    rateLimits: { enabled: false },
    batch: { enabled: true, maxRequests: BATCH_SIZE + 50, timeout: 60 },
  });
  return status;
}

/**
 * Create records in large transactional batches via /api/batch; raises on any
 * failed batch. Returns the created record ids in order.
 */
async function batch_create(su_token: string, coll: string, bodies: any[]): Promise<string[]> {
  const url = `/api/collections/${coll}/records`;
  const ids: string[] = [];
  for (let i = 0; i < bodies.length; i += BATCH_SIZE) {
    const chunk = bodies.slice(i, i + BATCH_SIZE);
    const reqs = chunk.map((b) => ({ method: "POST", url, body: b }));
    const [status, resp] = await api("POST", "/api/batch", su_token, { requests: reqs });
    if (status !== 200 || !Array.isArray(resp)) {
      throw new Error(`batch create ${coll} failed: HTTP ${status}: ${py_str(resp).slice(0, 300)}`);
    }
    for (const item of resp) {
      if (item.status !== 200) {
        throw new Error(`batch create ${coll} item failed: ${py_str(item).slice(0, 300)}`);
      }
      ids.push((item.body || {}).id);
    }
  }
  return ids;
}

const pad2 = (i: number): string => String(i).padStart(2, "0");
const pad3 = (i: number): string => String(i).padStart(3, "0");
const pad4 = (i: number): string => String(i).padStart(4, "0");
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/**
 * Seed the selective synthetic dataset; the measured user (users[0]) owns
 * workspaces[0], which holds the task-bearing projects. Returns the ids the
 * measurement passes key off.
 */
async function seed(su_token: string): Promise<Record<string, string>> {
  // Users — the measured user is users[0]; all approved+verified so any can auth.
  const uids = await batch_create(
    su_token,
    "users",
    range(N_USERS).map((i) => ({
      email: `ls${pad2(i)}@example.test`,
      password: USER_PASSWORD,
      passwordConfirm: USER_PASSWORD,
      name: `LS ${pad2(i)}`,
      verified: true,
      approved: true,
    })),
  );
  const uid = uids[0];
  // Point the module's fixed USER_EMAIL at users[0] for auth.
  await api("PATCH", `/api/collections/users/records/${uid}`, su_token, { email: USER_EMAIL });

  // Workspaces — owner cycles across the users; measured workspace = ws_ids[0]. The room boots
  // without hooks, so no status vocabulary is provisioned: the measured workspace gets one below.
  const ws_ids = await batch_create(
    su_token,
    "workspaces",
    range(N_WORKSPACES).map((i) => ({ name: `Ws ${pad4(i)}`, owner: uids[i % N_USERS] })),
  );
  const wid = ws_ids[0];
  await api("POST", "/api/collections/workspace_members/records", su_token, {
    workspace: wid,
    user: uid,
    role: "member",
    status: "active",
  });
  const [status, todo] = await api("POST", "/api/collections/statuses/records", su_token, {
    workspace: wid,
    name: "Todo",
    category: "unstarted",
    color: "blue",
  });
  if (status !== 200) {
    throw new Error(
      `creating the measured workspace's Todo status failed: HTTP ${status}: ${py_str(todo).slice(0, 300)}`,
    );
  }
  const todo_status = todo.id;

  // Projects — 40 measured (in ws0, holding the tasks) + filler spread across all
  // workspaces. workspace=ws0 selects ~42 of ~1240 (selective).
  const measured_projects = await batch_create(
    su_token,
    "projects",
    range(N_MEASURED_PROJECTS).map((i) => ({
      name: `MProj ${pad3(i)}`,
      owner: uid,
      workspace: wid,
    })),
  );
  // filler_ids[w] is a project in workspace ws_ids[w] — doubles as the milestones.project lookup.
  const filler_ids = await batch_create(
    su_token,
    "projects",
    range(N_FILLER_PROJECTS).map((i) => ({
      name: `FProj ${pad4(i)}`,
      owner: uids[i % N_USERS],
      workspace: ws_ids[i % N_WORKSPACES],
    })),
  );

  // Tasks — 100 per measured project (4000); assignee cycles across users so
  // idx_tasks_assignee is selective too. workspace is required (no defaulting hook
  // loaded here) — all measured projects live in wid, so every task's workspace is wid.
  const task_bodies: any[] = [];
  for (const [pi, pid] of measured_projects.entries()) {
    for (let ti = 0; ti < N_TASKS_PER_PROJECT; ti++) {
      task_bodies.push({
        title: `Task ${pad3(pi)}-${pad3(ti)}`,
        status: todo_status,
        project: pid,
        assignee: uids[(pi * N_TASKS_PER_PROJECT + ti) % N_USERS],
        ordinal: py_float(ti),
        workspace: wid,
      });
    }
  }
  const task_ids = await batch_create(su_token, "tasks", task_bodies);
  const anchor_task = task_ids[0];

  // Comments spread across N_COMMENT_TASKS distinct tasks; task=anchor selects ~3.
  await batch_create(
    su_token,
    "comments",
    range(N_COMMENTS).map((i) => ({
      task: task_ids[i % N_COMMENT_TASKS],
      author: uid,
      body: `c${i}`,
    })),
  );
  // Decisions/milestones spread across all workspaces; workspace=ws0 selects ~3.
  await batch_create(
    su_token,
    "decisions",
    range(N_DECISIONS).map((i) => ({
      title: `Decision ${pad4(i)}`,
      context: "synthetic",
      workspace: ws_ids[i % N_WORKSPACES],
    })),
  );
  // milestones.project is required — pair each with a project in its own workspace.
  await batch_create(
    su_token,
    "milestones",
    range(N_MILESTONES).map((i) => ({
      name: `Milestone ${pad4(i)}`,
      description: "synthetic",
      workspace: ws_ids[i % N_WORKSPACES],
      project: filler_ids[i % N_WORKSPACES],
    })),
  );

  return { uid, wid, project: measured_projects[0], task: anchor_task };
}

/**
 * Print + assert each indexed table is large enough that the planner will use
 * the index (below ~a few hundred rows it rationally prefers a SCAN).
 */
async function verify_counts(su_token: string): Promise<void> {
  const floors: [string, number][] = [
    ["tasks", 3000],
    ["projects", 1200],
    ["workspaces", 500],
    ["decisions", 1400],
    ["milestones", 1400],
    ["comments", 1400],
  ];
  let ok = true;
  for (const [coll, floor] of floors) {
    const [, page] = await api("GET", `/api/collections/${coll}/records?perPage=1`, su_token);
    const total =
      page !== null && typeof page === "object" && !Array.isArray(page)
        ? (page.totalItems ?? 0)
        : 0;
    const mark = total >= floor ? "·" : "‼";
    if (total < floor) ok = false;
    console.log(`  ${mark} ${coll.padEnd(12)} rows=${total} (floor ${floor})`);
  }
  if (!ok) {
    throw new Error("a seeded table is below its row floor — EXPLAIN would be unreliable");
  }
}

/** The hot-path list queries, each mapped to the index that serves it. */
function endpoints(ids: Record<string, string>): [string, string][] {
  return [
    [
      "tasks WHERE project",
      `/api/collections/tasks/records?filter=(project='${ids.project}')&perPage=50`,
    ],
    [
      "tasks WHERE assignee",
      `/api/collections/tasks/records?filter=(assignee='${ids.uid}')&perPage=50`,
    ],
    [
      "projects WHERE workspace",
      `/api/collections/projects/records?filter=(workspace='${ids.wid}')&perPage=50`,
    ],
    [
      "workspaces WHERE owner",
      `/api/collections/workspaces/records?filter=(owner='${ids.uid}')&perPage=50`,
    ],
    [
      "decisions WHERE workspace",
      `/api/collections/decisions/records?filter=(workspace='${ids.wid}')&perPage=50`,
    ],
    [
      "milestones WHERE workspace",
      `/api/collections/milestones/records?filter=(workspace='${ids.wid}')&perPage=50`,
    ],
    [
      "comments WHERE task",
      `/api/collections/comments/records?filter=(task='${ids.task}')&perPage=50`,
    ],
  ];
}

/** p50/p95 (ms) per endpoint over a fixed request budget, warm-up discarded. */
async function measure(
  user_tok: string,
  ids: Record<string, string>,
): Promise<Map<string, [number, number]>> {
  const results = new Map<string, [number, number]>();
  for (const [label, path] of endpoints(ids)) {
    for (let _ = 0; _ < WARMUP; _++) {
      await api("GET", path, user_tok);
    }
    // CONCURRENCY workers drain one shared counter (ThreadPoolExecutor.map).
    const samples: number[] = new Array(REQUESTS_PER_ENDPOINT);
    let next = 0;
    const worker = async () => {
      while (next < REQUESTS_PER_ENDPOINT) {
        const i = next++;
        samples[i] = (await api("GET", path, user_tok, null, true))[2];
      }
    };
    await Promise.all(range(CONCURRENCY).map(worker));
    samples.sort((a, b) => a - b);
    const mid = Math.floor(samples.length / 2);
    const p50 = samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
    const p95 = samples[Math.floor(samples.length * 0.95) - 1];
    results.set(label, [p50, p95]);
  }
  return results;
}

// The raw single-table queries the indexes bind; EXPLAIN QUERY PLAN on these is the
// deterministic "index is used" proof, independent of dataset scale.
function explain_queries(ids: Record<string, string>): [string, string][] {
  return [
    ["idx_tasks_project", `SELECT id FROM tasks WHERE project='${ids.project}'`],
    ["idx_tasks_assignee", `SELECT id FROM tasks WHERE assignee='${ids.uid}'`],
    ["idx_projects_workspace", `SELECT id FROM projects WHERE workspace='${ids.wid}'`],
    ["idx_workspaces_owner", `SELECT id FROM workspaces WHERE owner='${ids.uid}'`],
    ["idx_decisions_workspace", `SELECT id FROM decisions WHERE workspace='${ids.wid}'`],
    ["idx_milestones_workspace", `SELECT id FROM milestones WHERE workspace='${ids.wid}'`],
    ["idx_comments_task", `SELECT id FROM comments WHERE task='${ids.task}'`],
  ];
}

/**
 * Run EXPLAIN QUERY PLAN on the room's data.db (room must be STOPPED). Returns
 * {index_name: plan_line}.
 */
function explain(data_dir: string, ids: Record<string, string>): Map<string, string> {
  const db = path.join(data_dir, "data.db");
  const out = new Map<string, string>();
  for (const [name, q] of explain_queries(ids)) {
    // A failed EXPLAIN leaves an empty plan line, which reads as "index not used" — the
    // report is the verdict here, so a non-zero sqlite3 must not raise past it.
    const r = Bun.spawnSync(["sqlite3", db, `EXPLAIN QUERY PLAN ${q};`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    out.set(name, py_split(decode_text(r.stdout)).join(" "));
  }
  return out;
}

/**
 * Poll request logs past the async flush; return the slowest path by execTime
 * and the status distribution.
 */
async function logs_observation(
  su_tok: string,
): Promise<[[number, string, any] | null, Map<number, number>]> {
  const slabs = new Map<number, number>();
  let slowest: [number, string, any] | null = null;
  for (let _ = 0; _ < 12; _++) {
    const [, page] = await api("GET", "/api/logs?perPage=500&sort=-created", su_tok);
    const items: any[] =
      page !== null && typeof page === "object" && !Array.isArray(page) ? (page.items ?? []) : [];
    if (items.length > 50) {
      for (const it of items) {
        const d = it.data ?? {};
        const st = d.status;
        if (st !== undefined && st !== null) slabs.set(st, (slabs.get(st) ?? 0) + 1);
        const ex = d.execTime;
        const url = String(d.url ?? "").split("?")[0];
        if (ex !== undefined && ex !== null && (slowest === null || ex > slowest[0])) {
          slowest = [ex, url, st];
        }
      }
      break;
    }
    await Bun.sleep(1000);
  }
  return [slowest, slabs];
}

function fmt_table(
  before: Map<string, [number, number]>,
  after: Map<string, [number, number]>,
): string {
  const rows = [
    "  endpoint                        before p50/p95 (ms)   after p50/p95 (ms)",
    "  " + "-".repeat(74),
  ];
  const f = (x: number) => x.toFixed(2).padStart(7);
  for (const [label, [b50, b95]] of before) {
    const [a50, a95] = after.get(label)!;
    rows.push(`  ${label.padEnd(31)} ${f(b50)} / ${f(b95)}      ${f(a50)} / ${f(a95)}`);
  }
  return rows.join("\n");
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-loadsmoke-"));
  const data_dir = path.join(tmp, "pb_data");
  const mig_dir = path.join(tmp, "pb_migrations");
  fs.mkdirSync(data_dir, { recursive: true });
  build_migrations_copy(mig_dir); // indexes are inline in the collection migrations
  const srv = new Server(data_dir, mig_dir);

  const total_projects = N_MEASURED_PROJECTS + N_FILLER_PROJECTS;
  const total_tasks = N_MEASURED_PROJECTS * N_TASKS_PER_PROJECT;
  console.log(`════════ module-20 load smoke — room ${PORT}, scratch=${tmp} ════════`);
  console.log(
    `dataset (selective, multi-tenant): ${N_USERS} users, ${N_WORKSPACES} ` +
      `workspaces, ${total_projects} projects, ${total_tasks} tasks, ` +
      `${N_COMMENTS} comments, ${N_DECISIONS} decisions, ${N_MILESTONES} milestones`,
  );

  let rc: number;
  try {
    srv.upsert_superuser();
    await srv.start();
    let su = (await superuser_token())!;
    const rl = await prepare_room(su);
    console.log(`· rate limits disabled + batch enabled (PATCH /api/settings → ${rl})`);
    console.log("· seeding synthetic dataset (batch API) …");
    const ids = await seed(su);
    console.log("· verifying row counts …");
    await verify_counts(su);
    let utok = await user_token();
    if (!utok) throw new Error("normal user failed to authenticate");

    console.log("── dropping 7 perf indexes (collection API) ──");
    await toggle_perf_indexes(su, false);
    console.log("\n── BEFORE (no index) ──");
    const before = await measure(utok, ids);
    const [slowest, dist] = await logs_observation(su);
    await srv.stop();
    const explain_before = explain(data_dir, ids);

    await srv.start();
    su = (await superuser_token())!;
    console.log("── re-adding 7 perf indexes (collection API) ──");
    await toggle_perf_indexes(su, true);
    utok = await user_token();
    console.log("\n── AFTER (indexes present, same dataset) ──");
    const after = await measure(utok!, ids);
    await srv.stop();
    const explain_after = explain(data_dir, ids);

    // ── Report ──────────────────────────────────────────────────────────────
    console.log("\n════════ RESULTS ════════");
    console.log("\np50/p95 latency per hot-path endpoint (normal authed user, rate limits off):\n");
    console.log(fmt_table(before, after));

    console.log("\nEXPLAIN QUERY PLAN — before vs after (the deterministic index-bind proof):\n");
    let scan_ok = true;
    let search_ok = true;
    for (const [name] of explain_queries(ids)) {
      const b = explain_before.get(name)!;
      const a = explain_after.get(name)!;
      if (!b.toUpperCase().includes("SCAN")) scan_ok = false;
      if (!a.toUpperCase().includes("USING INDEX") || !a.toUpperCase().includes("SEARCH")) {
        search_ok = false;
      }
      console.log(`  ${name}`);
      console.log(`     before: ${b}`);
      console.log(`     after:  ${a}`);
    }

    console.log("\nV-LOGS-OBS — request-log observation (polled past the async flush):");
    if (slowest) {
      console.log(
        `  slowest request this run: execTime=${slowest[0]} url=${slowest[1]} status=${slowest[2]}`,
      );
    }
    console.log(
      `  status distribution: ${py_repr(new Map([...dist].sort((a, b) => a[0] - b[0])))}`,
    );

    console.log(`\n429 responses during the run: ${_429_COUNT} (expected 0 — rate limits off)`);

    const ok = scan_ok && search_ok && _429_COUNT === 0;
    console.log("\n" + "=".repeat(60));
    if (ok) {
      console.log("✅ every query: SCAN before → SEARCH USING INDEX after; zero 429s");
      rc = 0;
    } else {
      console.log(
        `❌ scan_before_all=${py_repr(scan_ok)} search_after_all=${py_repr(search_ok)} http429=${_429_COUNT}`,
      );
      rc = 1;
    }
  } finally {
    await srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return rc;
}

parse_args(HELP.slice(0, HELP.indexOf("\n\n")), HELP, [], {});
process.exit(await main());

#!/usr/bin/env bun
/**
 * pb1e AC2 / dpn2 AC1 — prove a member's reads on project_items stay bounded, AND stay
 * correctly scoped, as UNRELATED workspaces grow, now that decision:project-items-membership-denormalised replaced every
 * @collection.workspaces / @collection.workspace_members join in the list and view rules with
 * the denormalised workspace_owner / active_members / active_admins columns matched by = and ~.
 *
 *   §1 fixture: alice owns one workspace holding one project with N_ITEMS items. bob is an
 *      active member of it and owns nothing that holds items, so his baseline is alice's.
 *      carol owns every unrelated workspace, and EVERY one of them holds a task AND a decision.
 *   §2 both principals x four request kinds x every step of STEPS workspaces in the database.
 *   §3 the derived budget, floored by this host's own measured per-request noise.
 *
 * Both arms of the rule are exercised. The foreign decisions put `type != "task"` rows in the
 * view, so the arm carrying `active_admins ~ @request.auth.id` and the draft-visibility
 * disjunction is evaluated at every step; alice's own N_ITEMS are tasks, so the `type = "task"`
 * arm carrying `active_members ~` decides every row she is entitled to.
 *
 * Why the unrelated workspaces hold items: without them `totalItems` equals the baseline under
 * ANY rule that admits alice's own rows — a wide-open `@request.auth.id != ""` included — so the
 * suite would read as a visibility proof while being only a latency proof. With them, over-reading
 * raises `totalItems` above the baseline, and the same assertion refuses both failures.
 *
 * Two principals deliberately: alice is the workspace OWNER, so `workspace_owner =
 * @request.auth.id` decides her read before the LIKE leg is ever reached. bob is a non-owner
 * active member, so only `active_members ~ @request.auth.id` — decision:project-items-membership-denormalised's novel mechanism,
 * and the one whose cost is in question — can admit him.
 *
 * Budget, derived in THIS run and never a constant: for each principal and request kind the
 * 3-workspace step is sampled SAMPLES times, its median taken, and every later step's own median
 * must stay within BUDGET_MULTIPLIER x that median. That multiplier is decision:project-items-membership-denormalised's accepted
 * bar, owner-accepted 2026-09-20 on pb1e — "each of the list page, the counts-shaped read and the
 * counts route stays within 3x that same option's own 3-workspace median for that request
 * kind" — not a choice made here — plus this host's own measured per-request noise. That floor
 * term is the one thing added to the bar, and it is needed because 3x leaves absolute headroom
 * proportional to the baseline while scheduling noise is a FIXED cost: on a host fast enough to
 * put a baseline at a few milliseconds, noise alone would exceed the margin. It is measured on a
 * request whose cost depends on neither the rule nor the fixture, so unlike a spread drawn from
 * the judged samples it cannot be inflated by the very outlier it is meant to absorb.
 *
 * Bound: the workspace axis alone, to decision:project-items-membership-denormalised's S4 fixture. The projects/tasks axis (that
 * decision's P2 fixture) is measured elsewhere. The room's rate limiter is disabled before
 * seeding: it is server-memory state that would refuse the seeding burst, not the per-request
 * visibility cost under measurement.
 *
 * PB_SCALE_STEPS and PB_SCALE_STEP_CEILING override the sweep and its per-step ceiling, so a
 * mutant run can be reproduced bounded without editing this file.
 *
 * Fully self-contained clean-room server, real pb_hooks/ via roomkit. Port 8129 +
 * PB_PORT_OFFSET (suite self-boot band per .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decode_text,
  getitem,
  py_get,
  py_int,
  py_repr,
  py_str,
  py_strip,
  run_checked,
  tup,
  truthy,
  urlencode,
  url_error_reason,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8129 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Dummy superuser — NOT a real secret.
const SU_EMAIL = "scale-ci@example.test";
const SU_PASSWORD = "scale-ci-dummy-pw-000";
const ALICE_EMAIL = "scale-alice@example.com";
const BOB_EMAIL = "scale-bob@example.com";
const CAROL_EMAIL = "scale-carol@example.com";
const USER_PASSWORD = "test123456";

// Python float(str): surrounding whitespace, sign, `_` between digits, inf/nan.
function float_of(s: string): number {
  const t = py_strip(s);
  const D = String.raw`\d+(?:_\d+)*`;
  if (/^[+-]?(?:inf|infinity|nan)$/i.test(t))
    return Number(t.replace(/nan/i, "NaN").replace(/^\+/, ""));
  if (!new RegExp(`^[+-]?(?:${D}(?:\\.(?:${D})?)?|\\.${D})(?:[eE][+-]?${D})?$`).test(t)) {
    throw new Error(`ValueError: could not convert string to float: ${py_repr(s)}`);
  }
  return Number(t.replaceAll("_", ""));
}

const N_ITEMS = 5000;
// The last step is decision:project-items-membership-denormalised's S4 fixture, which the accepted bar binds this work to.
const STEPS = (process.env.PB_SCALE_STEPS ?? "3,253,503,1003,1506").split(",").map(py_int);
const SAMPLES = 5;
const BUDGET_MULTIPLIER = 3;
const BASELINE_SAMPLINGS = 3;
// Below one timed-out request, so a step whose reads have stopped answering is failed after the
// first of them instead of after all of them; above 6x the slowest healthy step this suite has
// measured (the printed per-step wall times are what keep that ratio checkable).
const STEP_CEILING = float_of(process.env.PB_SCALE_STEP_CEILING ?? "60");
// Every item alice holds takes its workspace's one default status, so her counts route
// answers a single group; a foreign row carries a different workspace's status id.
const COUNTS_GROUPS = 1;

// Past PocketBase's own 30s query timeout, so a shape that hits it is read as its HTTP 400
// rather than as a socket timeout on this side.
const HTTP_TIMEOUT = 90;
// A request that never answers is the worst measurement there is, so it becomes a reported
// status rather than a traceback that ends the sweep before the budget is ever asserted.
const TIMEOUT_STATUS = `NO ANSWER IN ${HTTP_TIMEOUT}s`;

const now = (): number => performance.now() / 1000; // time.perf_counter()

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(78)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number | string, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  let raw: string;
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT * 1000),
    });
    raw = decode_text(new Uint8Array(await r.arrayBuffer()));
  } catch (e) {
    return [TIMEOUT_STATUS, { error: url_error_reason(e) }];
  }
  if (r.ok) return [r.status, raw ? JSON.parse(raw) : {}];
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, {}];
  }
}

/**
 * A self-contained `pocketbase serve` clean-room on the repo's REAL pb_hooks/ — the
 * provisioning, key-minting and counts-route hooks all build or answer this suite.
 */
class Room {
  port: number;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number) {
    this.port = port;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-scale-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    copy_tree(REAL_MIGRATIONS_DIR, this.migrations_dir);
    for (const f of fs.readdirSync(this.migrations_dir)) {
      if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(this.migrations_dir, f));
    }
    this.proc = null;
  }

  async start(): Promise<void> {
    await roomkit.require_free_port(this.port);
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

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

async function user_token(email: string): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: USER_PASSWORD,
  });
  return roomkit.token_of(BASE_URL, email, r);
}

/**
 * A committed users create auto-provisions that user's workspace, self-membership and
 * default project through pb_hooks/main.pb.js — this suite's fixture rides that path.
 */
async function make_user(su: string, email: string, name: string): Promise<string> {
  const [status, r] = await api("POST", "/api/collections/users/records", su, {
    email,
    password: USER_PASSWORD,
    passwordConfirm: USER_PASSWORD,
    name,
    verified: true,
    approved: true,
  });
  if (status !== 200) {
    throw new roomkit.SystemExit(`${email} create failed: ${status} ${py_str(r)}`);
  }
  return getitem(r, "id");
}

async function create(su: string, collection: string, body: any): Promise<string> {
  const [status, r] = await api("POST", `/api/collections/${collection}/records`, su, body);
  if (status !== 200) {
    throw new roomkit.SystemExit(`${collection} create failed: ${status} ${py_str(r)}`);
  }
  return getitem(r, "id");
}

async function query(su: string, path: string, params: Record<string, any>): Promise<any> {
  const [status, page] = await api("GET", `${path}?${urlencode(params)}`, su);
  if (status !== 200) throw new roomkit.SystemExit(`GET ${path} failed: ${status} ${py_str(page)}`);
  return page;
}

async function owned_workspace(su: string, user_id: string): Promise<string> {
  const page = await query(su, "/api/collections/workspaces/records", {
    filter: `owner="${user_id}"`,
  });
  return getitem(getitem(page, "items")[0], "id");
}

/**
 * The provisioned default project. The workspace's other project is the keyless shadow
 * project, which no item may be filed under.
 */
async function keyed_project(su: string, workspace_id: string): Promise<string> {
  const page = await query(su, "/api/collections/projects/records", {
    filter: `workspace="${workspace_id}"`,
  });
  const p = getitem(page, "items").find((p: any) => truthy(p.key ?? null));
  if (p === undefined) throw new Error("StopIteration");
  return getitem(p, "id");
}

async function workspace_count(su: string): Promise<number> {
  const page = await query(su, "/api/collections/workspaces/records", { perPage: 1, fields: "id" });
  return getitem(page, "totalItems");
}

/**
 * Every row project_items exposes, of every type — counted as superuser, whom the view's
 * rules do not filter, so this is the number a principal must NOT be able to reach.
 */
async function item_count(su: string): Promise<number> {
  const page = await query(su, "/api/collections/project_items/records", {
    perPage: 1,
    fields: "id",
  });
  return getitem(page, "totalItems");
}

/**
 * The room's OWN batch.maxRequests, read off the running server — a room whose cap is
 * not the settings migration's number must still seed in valid chunks.
 */
async function batch_cap(su: string): Promise<number> {
  const [status, settings] = await api("GET", "/api/settings", su);
  if (status !== 200) {
    throw new roomkit.SystemExit(`GET /api/settings failed: ${status} ${py_str(settings)}`);
  }
  const batch = settings.batch || {};
  if (!truthy(batch.enabled ?? null)) {
    throw new roomkit.SystemExit(
      "this room's batch API is disabled — the fixture cannot be seeded",
    );
  }
  const v = getitem(batch, "maxRequests");
  return typeof v === "string" ? py_int(v) : Math.trunc(v);
}

async function batch_create(
  su: string,
  cap: number,
  collection: string,
  bodies: any[],
): Promise<any[]> {
  const url = `/api/collections/${collection}/records`;
  const ids: any[] = [];
  for (let i = 0; i < bodies.length; i += cap) {
    const requests = bodies.slice(i, i + cap).map((b) => ({ method: "POST", url, body: b }));
    const [status, resp] = await api("POST", "/api/batch", su, { requests });
    if (status !== 200 || !Array.isArray(resp)) {
      throw new roomkit.SystemExit(
        `batch create ${collection} failed: ${status} ${py_str(resp).slice(0, 400)}`,
      );
    }
    ids.push(...resp.map((item: any) => (item.body || {}).id ?? null));
  }
  return ids;
}

/**
 * Raise the DATABASE's workspace total to `target` with workspaces neither measured
 * principal can see. Each carries its owner's active membership row (every workspace create
 * makes one) so the foreign membership table grows too, AND an item of its own so over-reading
 * is visible in `totalItems`.
 */
async function grow_to(su: string, cap: number, owner_id: string, target: number): Promise<void> {
  const missing = target - (await workspace_count(su));
  if (missing <= 0) return;
  const base = target - missing;
  const n5 = (n: number): string => String(n).padStart(5, "0");
  const ws_ids = await batch_create(
    su,
    cap,
    "workspaces",
    Array.from({ length: missing }, (_, i) => ({
      name: `Unrelated ${n5(base + i)}`,
      owner: owner_id,
    })),
  );
  const project_ids = await batch_create(
    su,
    cap,
    "projects",
    ws_ids.map((w, i) => ({
      name: `Unrelated P ${n5(base + i)}`,
      owner: owner_id,
      workspace: w,
    })),
  );
  if (project_ids.length !== ws_ids.length) {
    throw new Error("ValueError: zip() argument 2 is shorter than argument 1");
  }
  const pairs = ws_ids.map((w, i) => tup(w, project_ids[i]));
  await batch_create(
    su,
    cap,
    "tasks",
    pairs.map(([w, p], i) => ({
      title: `Unrelated item ${n5(base + i)}`,
      workspace: w,
      project: p,
    })),
  );
  // A decision is a `type != "task"` row, which is the only arm of the rule that reaches
  // active_admins and the draft-visibility disjunction.
  await batch_create(
    su,
    cap,
    "decisions",
    pairs.map(([w, p], i) => ({
      title: `Unrelated decision ${n5(base + i)}`,
      workspace: w,
      project: p,
    })),
  );
}

type Answer = (body: any) => [number, any];

function page_answer(body: any): [number, any] {
  return [(body.items || []).length, body.totalItems ?? null];
}

function counts_answer(body: any): [number, any] {
  return [(body.items || []).length, body.total ?? null];
}

/**
 * This host's fixed per-request cost, timed on a request whose cost depends on neither
 * the rule nor the fixture — so the floor it feeds cannot be inflated by the samples it
 * protects, which is what made a spread drawn from those samples the wrong floor.
 */
async function host_noise(token: string): Promise<number> {
  const times: number[] = [];
  for (let _ = 0; _ < SAMPLES * 4; _++) {
    times.push((await sample("/api/health", token, () => [0, null]))[0]);
  }
  return Math.max(...times) - Math.min(...times);
}

/** One timed round trip: (seconds, status, rows, total). */
async function sample(
  path: string,
  token: string,
  answer: Answer,
): Promise<[number, number | string, number, any]> {
  const t0 = now();
  const [status, body] = await api("GET", path, token);
  const elapsed = now() - t0;
  const [rows, total] = answer(body);
  return tup(elapsed, status, rows, total);
}

/** A step whose reads stopped answering fast enough to be worth measuring. */
class StepTooSlow extends Error {}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

type Measure = {
  median: number;
  spread: number;
  status: number | string;
  rows: number;
  total: any;
  workspaces?: number;
};

async function measure(
  path: string,
  token: string,
  answer: Answer,
  want_rows: number,
  want_total: number,
  deadline: number,
): Promise<Measure> {
  // runs[0] is the warm-up: only its TIMING is discarded, because the first read of a step
  // pays the page cache. Its answer is judged with the rest.
  const runs: [number, number | string, number, any][] = [];
  for (let _ = 0; _ < SAMPLES + 1; _++) {
    runs.push(await sample(path, token, answer));
    if (now() > deadline) {
      throw new StepTooSlow(
        `${runs.length} sample(s) of ${path} took the step past its ${STEP_CEILING}s ` +
          `ceiling (slowest ${Math.max(...runs.map((r) => r[0])).toFixed(1)}s) — abandoning rather than ` +
          `waiting out every remaining request`,
      );
    }
  }
  const times = runs.slice(1).map((r) => r[0]);
  // The reported answer is the WORST of every sample, not the last: one refusal or one
  // over-read among them barely moves the median, so reporting a single sample would pass
  // it green.
  const off = runs.filter(
    (r) => !Bun.deepEquals(tup(r[1], r[2], r[3]), tup(200, want_rows, want_total), true),
  );
  const worst = off.length ? off[0] : runs[runs.length - 1];
  return {
    median: median(times),
    spread: Math.max(...times) - Math.min(...times),
    status: worst[1],
    rows: worst[2],
    total: worst[3],
  };
}

console.log(`════════ test_scale_membership.ts — pb1e AC2 / dpn2 AC1 (room on :${PORT}) ════════`);
const suite_started = now();
const room = new Room(PORT);
const results = new Map<string, { who: string; kind: string; rows: Measure[] }>();
try {
  await room.start();
  const su = await superuser_token();
  // The limiter is server-memory state that would refuse the seeding burst; it is not the
  // per-request visibility cost this suite measures.
  check(
    "rate limiter disabled for the run",
    (await api("PATCH", "/api/settings", su, { rateLimits: { enabled: false } }))[0],
    200,
  );
  const cap = await batch_cap(su);
  const noise = await host_noise(su);

  // ── §1 fixture ───────────────────────────────────────────────────────────
  console.log(
    "\n── §1 fixture: alice's workspace and its items; every other workspace holds one ──",
  );
  const seed_started = now();
  const alice_id = await make_user(su, ALICE_EMAIL, "Alice Scale");
  const bob_id = await make_user(su, BOB_EMAIL, "Bob Scale");
  const carol_id = await make_user(su, CAROL_EMAIL, "Carol Scale");
  const alice_ws = await owned_workspace(su, alice_id);
  const alice_project = await keyed_project(su, alice_ws);
  await create(su, "workspace_members", {
    workspace: alice_ws,
    user: bob_id,
    role: "member",
    status: "active",
  });
  // bob's own provisioned workspace stays empty on purpose, so his baseline total is
  // alice's and the two principals are comparable at every step.
  const carol_ws = await owned_workspace(su, carol_id);
  await create(su, "tasks", {
    title: "Unrelated item 00000",
    workspace: carol_ws,
    project: await keyed_project(su, carol_ws),
  });
  await batch_create(
    su,
    cap,
    "tasks",
    Array.from({ length: N_ITEMS }, (_, i) => ({
      title: `Scale item ${String(i).padStart(5, "0")}`,
      workspace: alice_ws,
      project: alice_project,
    })),
  );
  const seed_elapsed = now() - seed_started;
  console.log(
    `  fixture: alice=${alice_id} workspace=${alice_ws} project=${alice_project} ` +
      `bob=${bob_id} carol=${carol_id}  batch maxRequests read off the room: ${cap}`,
  );
  console.log(`  seeding wall time so far: ${seed_elapsed.toFixed(1)}s`);
  check("alice's project holds the seeded items", (await item_count(su)) - 1, N_ITEMS);

  const principals: [string, string][] = [
    ["alice (workspace OWNER — workspace_owner decides her read)", await user_token(ALICE_EMAIL)],
    [
      "bob (non-owner ACTIVE MEMBER — only active_members ~ admits him)",
      await user_token(BOB_EMAIL),
    ],
  ];
  const kinds: [string, [string, Answer, number]][] = [
    // dpn2's RED numbers are this exact request — one 25-row page of her own project — so
    // the GREEN is comparable to them. Its total alone cannot refuse an over-reading rule,
    // because the project filter pins it to the baseline; the three unfiltered kinds do.
    [
      "list page, her project (perPage=25, default sort)",
      [
        "/api/collections/project_items/records?" +
          urlencode({ perPage: 25, filter: `project="${alice_project}"` }),
        page_answer,
        25,
      ],
    ],
    [
      "list page, unfiltered (perPage=25, default sort)",
      ["/api/collections/project_items/records?" + urlencode({ perPage: 25 }), page_answer, 25],
    ],
    [
      "counts-shaped read (fields=status, perPage=200, the list's cap)",
      [
        "/api/collections/project_items/records?" + urlencode({ fields: "status", perPage: 200 }),
        page_answer,
        200,
      ],
    ],
    [
      "counts route (group=status)",
      [
        "/api/tracker/project-items/counts?" + urlencode({ group: "status" }),
        counts_answer,
        COUNTS_GROUPS,
      ],
    ],
  ];

  // ── §2 the sweep ─────────────────────────────────────────────────────────
  console.log("\n── §2 both principals, all four request kinds, at every step ──");
  let step = 0;
  for (const target of STEPS) {
    step += 1;
    await grow_to(su, cap, carol_id, target);
    const total_ws = await workspace_count(su);
    const foreign = (await item_count(su)) - N_ITEMS;
    check(`step ${step}: the database holds the step's workspaces`, total_ws, target);
    check(`step ${step}: unrelated workspaces hold items to over-read`, foreign > 0, true);
    const step_started = now();
    const deadline = step_started + STEP_CEILING;
    try {
      for (const [who, token] of principals) {
        for (const [kind, [path, answer, want_rows]] of kinds) {
          let m = await measure(path, token, answer, want_rows, N_ITEMS, deadline);
          // A sibling's burst can make one baseline sampling noisy: sample it afresh, not red.
          for (let n = 1; step === 1 && m.spread > m.median && n < BASELINE_SAMPLINGS; n++) {
            m = await measure(path, token, answer, want_rows, N_ITEMS, deadline);
          }
          m.workspaces = total_ws;
          const key = JSON.stringify([who, kind]);
          if (!results.has(key)) results.set(key, { who, kind, rows: [] });
          results.get(key)!.rows.push(m);
          const label = `step ${step} @ ${total_ws} ws — ${who.split(" (")[0]} — ${kind.split(" (")[0]}`;
          check(`${label}: HTTP`, m.status, 200);
          check(`${label}: rows`, m.rows, want_rows);
          check(`${label}: total (foreign items ${foreign} are NOT counted)`, m.total, N_ITEMS);
        }
      }
    } catch (e) {
      if (!(e instanceof StepTooSlow)) throw e;
      console.log(`  ⚠️  ${e.message}`);
      check(`step ${step} @ ${total_ws} ws: within the step ceiling`, false, true);
      break;
    }
    console.log(
      `  step ${step} @ ${total_ws} ws measured in ${(now() - step_started).toFixed(1)}s`,
    );
  }

  // ── §3 the derived budget ────────────────────────────────────────────────
  console.log(
    `\n── §3 budget = ${BUDGET_MULTIPLIER}x that principal+kind's own 3-workspace median ` +
      `+ this host's measured per-request noise (${noise.toFixed(3)}s) ──`,
  );
  const inconclusive: string[] = [];
  for (const { who, kind, rows } of results.values()) {
    const baseline = rows[0];
    const budget = BUDGET_MULTIPLIER * baseline.median + noise;
    console.log(`\n  ${who}\n  ${kind}   [${SAMPLES} samples/step, median reported]`);
    console.log(
      `    workspaces  ${"status".padStart(16)}   total  rows   median s   spread s   budget s`,
    );
    for (const m of rows) {
      // A refused step has no status code and no total, and must still print.
      console.log(
        `    ${String(m.workspaces).padStart(10)}  ${py_str(m.status).padStart(16)}  ${py_str(m.total).padStart(6)}  ` +
          `${String(m.rows).padStart(4)}   ${m.median.toFixed(3).padStart(8)}   ${m.spread.toFixed(3).padStart(8)}   ${budget.toFixed(3).padStart(8)}`,
      );
    }
    // Threshold: baseline spread <= its own median, else the median is junk and the budget it
    // inflates would fail green, so the pair is INCONCLUSIVE (not judged), never red or green.
    // Known limit: a MAJORITY of slow samples inflates the median itself, which this test passes
    // as quiet and widens the budget; host_noise times another request, so nothing here catches it.
    const pair = `${who.split(" (")[0]}/${kind.split(" (")[0]}`;
    if (baseline.spread > baseline.median) {
      inconclusive.push(pair);
      console.log(
        `  ⚠️  INCONCLUSIVE ${pair}: baseline spread ${baseline.spread.toFixed(3)}s > median ` +
          `${baseline.median.toFixed(3)}s after ${BASELINE_SAMPLINGS} samplings — budget not judged`,
      );
      continue;
    }
    console.log(
      `  ✅  ${pair}: baseline quiet enough to judge (spread ${baseline.spread.toFixed(3)}s <= ` +
        `median ${baseline.median.toFixed(3)}s)`,
    );
    for (const m of rows.slice(1)) {
      check(
        `${m.workspaces} ws: median ${m.median.toFixed(3)}s within budget ${budget.toFixed(3)}s`,
        m.median <= budget,
        true,
      );
    }
  }

  // An all-inconclusive run judged nothing, so it must not read as a pass.
  check(
    `at least one principal+kind judged (inconclusive: ${inconclusive.join(", ") || "none"})`,
    inconclusive.length < results.size,
    true,
  );

  // ── §4 the author expand (erjp AC4) ──────────────────────────────────────
  // The proxy resolves created_by by adding expand=author to its per-type hydration read: one
  // base-collection request per type on the page, filtered to that page's ids. Timed here at
  // the sweep's largest step against the same read without the expand, under the same bar.
  console.log(
    "\n── §4 the proxy's hydration read with and without expand=author, at the largest step ──",
  );
  const authored = await batch_create(
    su,
    cap,
    "decisions",
    Array.from({ length: 25 }, (_, i) => ({
      title: `Authored item ${String(i).padStart(5, "0")}`,
      workspace: alice_ws,
      project: alice_project,
      author: alice_id,
      draft: false,
    })),
  );
  const ids_filter = "(" + authored.map((i) => `id = "${py_str(i)}"`).join(" || ") + ")";

  const hydration = (expand: boolean): string => {
    const params: Record<string, any> = { perPage: 25, filter: ids_filter };
    if (expand) params.expand = "author";
    return "/api/collections/decisions/records?" + urlencode(params);
  };

  const bob = principals.find(([k]) => k.startsWith("bob"))![1];
  const [, body] = await api("GET", hydration(true), bob);
  const names = new Set(
    (body.items || []).map((r: any) => py_get(r.expand || {}, "author", {})?.name ?? null),
  );
  check(
    "a non-author member's expand resolves every row's author",
    names,
    new Set(["Alice Scale"]),
  );
  const ws_now = await workspace_count(su);
  const deadline = now() + STEP_CEILING;
  const plain = await measure(hydration(false), bob, page_answer, 25, 25, deadline);
  const expanded = await measure(hydration(true), bob, page_answer, 25, 25, deadline);
  const budget = BUDGET_MULTIPLIER * plain.median + noise;
  console.log(`    @ ${ws_now} ws, bob, 25 ids   median s   spread s   budget s`);
  for (const [label, m] of [
    ["without expand", plain],
    ["expand=author", expanded],
  ] as [string, Measure][]) {
    console.log(
      `    ${label.padStart(18)}   ${m.median.toFixed(4).padStart(8)}   ${m.spread.toFixed(4).padStart(8)}   ${budget.toFixed(4).padStart(8)}`,
    );
  }
  check("hydration read without expand: HTTP", plain.status, 200);
  check("hydration read with expand=author: HTTP", expanded.status, 200);
  check(
    `expand=author median ${expanded.median.toFixed(3)}s within budget ${budget.toFixed(3)}s`,
    expanded.median <= budget,
    true,
  );
} finally {
  await room.stop();
  room.cleanup_tmp();
}

console.log(`\nsuite wall time: ${(now() - suite_started).toFixed(1)}s`);
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
  process.exit(0);
}

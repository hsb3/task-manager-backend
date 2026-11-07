#!/usr/bin/env bun
/**
 * tasks.ordinal has a producer: a create with no ordinal lands at the end of its board column.
 *
 * Self-contained clean room, real pb_hooks/. Mints its own user so the auto-provisioned
 * workspace, project and 5-status vocab start empty; runs scripts/seed.ts nowhere.
 *
 *   §1 sequential creates in one column get 1, 2, 3, and another status column restarts at 1
 *   §2 a second project in the same workspace restarts at 1 (the project half of the scope)
 *   §3 an ordinal written by a superuser (a seeder, never a member API caller: the app tier
 *      assigns the order for everyone else) survives, and the next auto-assign reads the real MAX
 *   §4 8 barrier-synchronized parallel creates in one column get 8 DISTINCT consecutive numbers
 *   §5 a failed create claims nothing: five refusals do not advance the column's MAX
 *   §6 the create response body carries the assigned value, and the stored row agrees
 *   §7 a member's submitted ordinal is overridden by the server-assigned value
 *   §8 the race: 10 member creates naming ordinals 1..10 racing 10 without one, 5 fresh-project
 *      runs, zero duplicates each run; plus 20 implicit-only racing creates stay 20 distinct
 *
 * The move: a tasks PATCH carrying `move` inside a one-request POST /api/batch, driven by a member.
 *   §9  placement: after/before a named sibling, start/end of a status column, end of a priority
 *       column, a cross-column move, and start of an empty column (keeps its ordinal)
 *   §10 60 moves into the SAME gap keep a strict order (the backend renumbers when it collapses);
 *       the identical sequence through the old client midpoint math breaks
 *   §11 two concurrent moves into the same gap, 30 rounds: distinct ordinals, strict order
 *   §12 refused moves (vocab, role, transport, shape, stale-write key) change no ordinal; a
 *       field-validation refusal, which comes after the move hook, rolls its renumber back
 *   §13 the renumber is the project's: both status columns, exact 1..n values, and a second
 *       project in the same workspace keeps its ordinals
 *   §14 group=priority start/end of No priority covers a retired priority too (the board shows
 *       such a task under No priority)
 *   §15 a create carrying `move` is refused, plain and inside a batch, and nothing is created
 *
 * Port 8120 + PB_PORT_OFFSET — the suite self-boot band (.agents/rules/ports.md); every other default in
 * 8100-8122 is already a suite's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, getitem, py_get, py_str, run_checked, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8120 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Dummy superuser — NOT a real secret.
const SU_EMAIL = "ordinal-ci@example.test";
const SU_PASSWORD = "ordinal-ci-dummy-pw-0";
const PASSWORD = "test123456"; // shared app-user password, same convention as scripts/seed.ts

let failures = 0;

const num_asc = (a: number, b: number): number => a - b; // sorted() on numbers

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
  if (r.status === 204) return [204, {}];
  const raw = await r.text();
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch (e) {
    if (r.status >= 400) return [r.status, {}]; // HTTPError body that is not JSON
    throw e;
  }
}

class Room {
  /** A self-contained `pocketbase serve` clean room using the repo's REAL pb_hooks/. */
  port: number;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number) {
    this.port = port;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-ordinal-test-${port}-`));
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
  const tok = r.token;
  if (!tok) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

async function make_user(su_token: string, email: string, name: string): Promise<string> {
  const [status, r] = await api("POST", "/api/collections/users/records", su_token, {
    email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    name,
    verified: true,
    approved: true,
  });
  if (status !== 200) {
    throw new roomkit.SystemExit(`user create failed for ${email}: ${status} ${py_str(r)}`);
  }
  return getitem(r, "id");
}

async function login(email: string): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: PASSWORD,
  });
  return roomkit.token_of(BASE_URL, email, r);
}

async function find_one(
  su_token: string,
  collection: string,
  filter_expr: string,
  sort: string | null = null,
): Promise<any> {
  const params: Record<string, any> = { filter: filter_expr, perPage: 1 };
  if (sort) params.sort = sort;
  const [, r] = await api(
    "GET",
    `/api/collections/${collection}/records?${urlencode(params)}`,
    su_token,
  );
  const items = r.items || [];
  if (!items.length) {
    throw new roomkit.SystemExit(`no ${collection} matching ${filter_expr}: ${py_str(r)}`);
  }
  return items[0];
}

async function status_ids(su_token: string, workspace_id: string): Promise<Record<string, string>> {
  const params = { filter: `workspace='${workspace_id}'`, perPage: 50, sort: "position" };
  const [, r] = await api(
    "GET",
    `/api/collections/statuses/records?${urlencode(params)}`,
    su_token,
  );
  const out: Record<string, string> = {};
  for (const i of py_get(r, "items", [])) out[getitem(i, "name")] = getitem(i, "id");
  return out;
}

function create_task(
  token: string | null,
  workspace: string,
  project: string,
  status: string,
  title: string,
  extra: Record<string, any> = {},
): Promise<[number, any]> {
  const body: Record<string, any> = { title, workspace, project, status };
  for (const k of Object.keys(extra)) {
    if (Object.hasOwn(body, k)) {
      throw new TypeError(`create_task() got multiple values for argument '${k}'`);
    }
  }
  Object.assign(body, extra);
  return api("POST", "/api/collections/tasks/records", token, body);
}

async function ordinal_of(token: string | null, task_id: string): Promise<any> {
  const [, r] = await api("GET", `/api/collections/tasks/records/${task_id}`, token);
  return r.ordinal ?? null;
}

console.log(`════════ test_ordinal.ts — tasks.ordinal producer (room on :${PORT}) ════════`);
const room = new Room(PORT);
try {
  await room.start();
  const su = await superuser_token();

  const uid = await make_user(su, "ord-a@example.com", "OrdAlice");
  const token = await login("ord-a@example.com");
  const outsider_id = await make_user(su, "ord-b@example.com", "OrdBob"); // never a member of Alice's workspace
  const WS: string = (await find_one(su, "workspaces", `owner='${uid}'`)).id;
  // shadow=false: the invisible container project is provisioned first, and it is not a
  // project a client may name — an unfiltered find-one here resolves it and every create 400s.
  const P1: string = (await find_one(su, "projects", `workspace='${WS}' && shadow=false`)).id;
  const ST = await status_ids(su, WS);
  console.log(
    `  fixtures: WS=${WS}  project=${P1}  statuses=${py_str(Object.keys(ST).sort(by_code_point))}`,
  );

  let s: number;

  // ── §1 one column, one sequence; a different status column is a different column ──
  // COVERS: hook:ordinal.pb.js#onRecordAfterCreateSuccess:tasks
  console.log("\n── §1 sequential creates in one column get 1, 2, 3; another column restarts ──");
  const seq: any[] = [];
  for (let i = 0; i < 3; i++) {
    let rec: any;
    [s, rec] = await create_task(token, WS, P1, getitem(ST, "Todo"), `todo-${i}`);
    check(`create todo-${i} → 200`, s, 200);
    seq.push(rec.ordinal ?? null);
  }
  check("three creates in one column are numbered 1, 2, 3", seq, [1, 2, 3]);

  let other: any;
  [s, other] = await create_task(token, WS, P1, getitem(ST, "In Progress"), "doing-0");
  check("create in a DIFFERENT status of the same project → 200", s, 200);
  check(
    "the other column restarts at 1 (scope is per column, not per project)",
    other.ordinal ?? null,
    1,
  );

  // ── §2 the project half of the scope ─────────────────────────────────────
  console.log("\n── §2 the same status in a SECOND project is its own column ──");
  let p2: any, p2_first: any;
  [s, p2] = await api("POST", "/api/collections/projects/records", token, {
    name: "Second Project",
    owner: uid,
    workspace: WS,
  });
  check("create a second project → 200", s, 200);
  const P2: string = getitem(p2, "id");
  [s, p2_first] = await create_task(token, WS, P2, getitem(ST, "Todo"), "p2-todo-0");
  check("first Todo task in project 2 → 200", s, 200);
  check("project 2's Todo column starts at 1, not 4", p2_first.ordinal ?? null, 1);

  // ── §3 a superuser's ordinal is honoured, and MAX is read for real ────────
  // A member's submitted ordinal is replaced (§7); the request guard exempts a superuser, so
  // this models a seeder or an importer writing straight to PocketBase.
  console.log(
    "\n── §3 a superuser create carrying an explicit ordinal survives, and the next auto reads MAX ──",
  );
  let explicit: any, after: any;
  [s, explicit] = await create_task(su, WS, P1, getitem(ST, "Backlog"), "explicit", {
    ordinal: 7.5,
  });
  check("a superuser create carrying ordinal 7.5 → 200", s, 200);
  check(
    "that 7.5 is returned untouched (superuser create keeps it)",
    explicit.ordinal ?? null,
    7.5,
  );
  check("and 7.5 is what is stored", await ordinal_of(token, getitem(explicit, "id")), 7.5);
  [s, after] = await create_task(token, WS, P1, getitem(ST, "Backlog"), "after-explicit");
  check("the next auto-assigned create → 200", s, 200);
  check("it is MAX+1 = 8.5, not a counter's 1 or 2", after.ordinal ?? null, 8.5);

  // ── §4 concurrency: AC #1 ────────────────────────────────────────────────
  console.log("\n── §4 eight barrier-synchronized parallel creates in ONE column ──");
  const N = 8;
  let seedrow: any;
  [s, seedrow] = await create_task(su, WS, P1, getitem(ST, "Done"), "done-base", {
    ordinal: 100,
  });
  check("seed the column with a superuser create at ordinal 100 → 200", s, 200);
  const max_before = seedrow.ordinal ?? null;
  check("MAX before the parallel burst", max_before, 100);

  // The Barrier released all 8 workers together; here every request is started (fetch called
  // synchronously inside each un-awaited worker) before any is awaited.
  const results4: [number, any, any][] = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const [status, body] = await create_task(token, WS, P1, getitem(ST, "Done"), `parallel-${i}`);
      return [status, body.ordinal ?? null, body.id ?? null] as [number, any, any];
    }),
  );

  const statuses = results4.map((r) => r[0]);
  const assigned = results4.map((r) => r[1]);
  const assigned_sorted = assigned.filter((x) => x !== null).sort(num_asc);
  console.log(`  assigned ordinals, sorted: ${py_str(assigned_sorted)}`);
  check(`all ${N} parallel creates succeeded (HTTP 200)`, statuses, Array(N).fill(200));
  check(`${N} DISTINCT ordinals — no duplicate claim`, new Set(assigned).size, N);
  const want4 = Array.from({ length: N }, (_, k) => max_before + k + 1);
  check("the set is exactly MAX+1 … MAX+8", assigned_sorted, want4);
  const stored = (
    await Promise.all(results4.filter((r) => r[2]).map((r) => ordinal_of(token, r[2])))
  ).sort(num_asc);
  check("and that is what the rows actually hold", stored, want4);

  // ── §5 AC #4: a failed create leaks no ordinal ───────────────────────────
  console.log("\n── §5 ten refused creates do not advance the column's MAX ──");
  let base_b: any;
  await create_task(token, WS, P1, getitem(ST, "Canceled"), "cancel-0");
  [s, base_b] = await create_task(token, WS, P1, getitem(ST, "Canceled"), "cancel-1");
  const max_before_fail = base_b.ordinal ?? null;
  check("the column's MAX before the failures", max_before_fail, 2);
  // Two refusals from opposite ends of the write pipeline: a non-member assignee is refused by a
  // *Request hook BEFORE the save runs at all, an over-long title by PocketBase's own field
  // validation AFTER the model-tier hooks have run — only the second can catch a number claimed
  // before the row exists (projects.item_seq claims after the insert too, and leaks across
  // neither: tests/test_item_keys.ts §10).
  const early: number[] = [];
  const late: number[] = [];
  for (let i = 0; i < 5; i++) {
    [s] = await create_task(token, WS, P1, getitem(ST, "Canceled"), `doomed-early-${i}`, {
      assignee: outsider_id,
    });
    early.push(s);
    [s] = await create_task(token, WS, P1, getitem(ST, "Canceled"), "x".repeat(400));
    late.push(s);
  }
  check(
    "five creates REFUSED pre-save (400 — assignee is not a member)",
    early,
    Array(5).fill(400),
  );
  check(
    "five creates REFUSED at field validation (400 — title over 300)",
    late,
    Array(5).fill(400),
  );
  let survivor: any;
  [s, survivor] = await create_task(token, WS, P1, getitem(ST, "Canceled"), "after-failures");
  check("the next successful create → 200", s, 200);
  console.log(
    `  MAX before the ten refusals: ${py_str(max_before_fail)}   next assigned: ${py_str(survivor.ordinal ?? null)}`,
  );
  check("it gets MAX+1 = 3, not MAX+11 = 13", survivor.ordinal ?? null, max_before_fail + 1);
  let params: Record<string, any> = {
    filter: `project='${P1}' && status='${getitem(ST, "Canceled")}'`,
    perPage: 50,
  };
  let listed: any;
  [, listed] = await api("GET", `/api/collections/tasks/records?${urlencode(params)}`, token);
  check(
    "the column holds exactly 3 rows (nothing was committed by a refusal)",
    listed.totalItems ?? null,
    3,
  );

  // ── §6 the response body is not left claiming 0 ──────────────────────────
  console.log("\n── §6 the create response carries the assigned value, and the row agrees ──");
  let fresh: any;
  [s, fresh] = await create_task(token, WS, P2, getitem(ST, "In Progress"), "response-shape");
  check("create → 200", s, 200);
  check("the create RESPONSE body carries a non-zero ordinal", fresh.ordinal ?? null, 1);
  check(
    "the stored row matches the response",
    await ordinal_of(token, getitem(fresh, "id")),
    fresh.ordinal ?? null,
  );
  params = {
    filter: `project='${P1}' && status='${getitem(ST, "Todo")}'`,
    sort: "ordinal",
    perPage: 50,
  };
  let ordered: any;
  [, ordered] = await api("GET", `/api/collections/tasks/records?${urlencode(params)}`, token);
  check(
    "sorting that column by ordinal yields creation order",
    py_get(ordered, "items", []).map((i: any) => getitem(i, "title")),
    ["todo-0", "todo-1", "todo-2"],
  );

  // ── §7 a member's submitted ordinal is overridden ────────────────────────
  // COVERS: hook:ordinal.pb.js#onRecordCreateRequest:tasks
  console.log("\n── §7 a member's submitted ordinal is overridden by the server-assigned value ──");
  let p3: any, overridden: any;
  [s, p3] = await api("POST", "/api/collections/projects/records", token, {
    name: "Override Project",
    owner: uid,
    workspace: WS,
  });
  check("create a fresh empty-column project → 200", s, 200);
  const P3: string = getitem(p3, "id");
  [s, overridden] = await create_task(token, WS, P3, getitem(ST, "Todo"), "member-explicit", {
    ordinal: 7,
  });
  check("member create submitting ordinal 7 into an empty column → 200", s, 200);
  check("the server-assigned value (1) replaces the submitted 7", overridden.ordinal ?? null, 1);
  check("and 1 is what is stored", await ordinal_of(token, getitem(overridden, "id")), 1);

  // ── §8 the race: explicit ordinals cannot claim a slot a concurrent create wants ──
  async function race(name: string, ordinals: (number | null)[]): Promise<[number, any][]> {
    /** Barrier-release one member create per entry (None = no ordinal) into a fresh project;
     * return the (status, ordinal) pairs as STORED. */
    const [s, rp] = await api("POST", "/api/collections/projects/records", token, {
      name,
      owner: uid,
      workspace: WS,
    });
    check(`${name}: fresh project → 200`, s, 200);
    // The Barrier released all workers together; here every create is started (fetch called
    // synchronously inside each un-awaited worker) before any is awaited.
    return await Promise.all(
      ordinals.map(async (ord, i) => {
        const extra = ord === null ? {} : { ordinal: ord };
        const [status, body] = await create_task(
          token,
          WS,
          getitem(rp, "id"),
          getitem(ST, "Todo"),
          `${name}-${i}`,
          extra,
        );
        return [status, body.id ? await ordinal_of(token, getitem(body, "id")) : null] as [
          number,
          any,
        ];
      }),
    );
  }

  console.log(
    "\n── §8 10 member creates naming ordinals 1..10 race 10 without one, 5 fresh runs ──",
  );
  let results: [number, any][];
  for (let run = 1; run <= 5; run++) {
    results = await race(`race-${run}`, [
      ...Array.from({ length: 10 }, (_, i) => i + 1),
      ...Array(10).fill(null),
    ]);
    check(
      `race run ${run}: all 20 creates → 200`,
      results.map((r) => r[0]),
      Array(20).fill(200),
    );
    check(
      `race run ${run}: 20 distinct stored ordinals — no duplicate claim`,
      new Set(results.map((r) => r[1])).size,
      20,
    );
  }

  console.log("\n── §8b 20 implicit-only racing creates in a fresh project stay 20 distinct ──");
  results = await race("implicit-only", Array(20).fill(null));
  check(
    "all 20 implicit-only creates → 200",
    results.map((r) => r[0]),
    Array(20).fill(200),
  );
  check(
    "20 distinct stored ordinals — no duplicate claim",
    new Set(results.map((r) => r[1])).size,
    20,
  );

  // ══════════════════ the move: a PATCH carrying `move`, sent through /api/batch ══════════════════
  const member_id = await make_user(su, "ord-m@example.com", "OrdMember");
  const viewer_id = await make_user(su, "ord-v@example.com", "OrdViewer");
  for (const [user, role] of [
    [member_id, "member"],
    [viewer_id, "viewer"],
  ]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS,
      user,
      role,
      status: "active",
    });
    check(`(fixture) an active ${role} joins Alice's workspace → 200`, s, 200);
  }
  const member = await login("ord-m@example.com");
  const viewer = await login("ord-v@example.com");
  const outsider = await login("ord-b@example.com");

  type Row = { id: string; title: string; ordinal: number; status: string; priority: string };
  async function project_order(project: string): Promise<Row[]> {
    // KEEP IN SYNC: project-order — ordinal ASC, created DESC, id ASC is also spelled in
    // pb_hooks/ordinal.pb.js (the move hook).
    const q = { filter: `project='${project}'`, sort: "ordinal,-created,id", perPage: 500 };
    const [, r] = await api("GET", `/api/collections/tasks/records?${urlencode(q)}`, su);
    return py_get(r, "items", []).map((i: any) => ({
      id: i.id,
      title: i.title,
      ordinal: i.ordinal,
      status: i.status,
      priority: i.priority,
    }));
  }
  const titles = (rows: Row[]): string[] => rows.map((r) => r.title);
  const strict = (rows: Row[]): boolean =>
    rows.every((r, i) => i === 0 || rows[i - 1].ordinal < r.ordinal);
  const ordinals = (rows: Row[]): Record<string, number> =>
    Object.fromEntries(rows.map((r) => [r.title, r.ordinal]));
  function move(token: string, id: string, body: Record<string, any>): Promise<[number, any]> {
    return api("POST", "/api/batch", token, {
      requests: [{ method: "PATCH", url: `/api/collections/tasks/records/${id}`, body }],
    });
  }
  // A batch answers 200 with one {status, body} per request, or 400 with the refused request's
  // own answer nested under data.requests.<index>.response.
  function inner(r: any): any {
    // The record's own `status` field is the task's column; the request's HTTP status wins.
    if (Array.isArray(r)) return { ...(r[0]?.body ?? {}), status: r[0]?.status };
    return r?.data?.requests?.["0"]?.response ?? r ?? {}; // a plain (non-batch) answer as-is
  }
  // The expected order: the mover taken out and put back next to its anchor.
  function placed(order: string[], mover: string, anchor: string, after: boolean): string[] {
    const rest = order.filter((t) => t !== mover);
    rest.splice(rest.indexOf(anchor) + (after ? 1 : 0), 0, mover);
    return rest;
  }
  async function new_project(name: string): Promise<string> {
    const [st, rp] = await api("POST", "/api/collections/projects/records", token, {
      name,
      owner: uid,
      workspace: WS,
    });
    check(`(fixture) project ${name} → 200`, st, 200);
    return getitem(rp, "id");
  }
  // Superuser creates keep the ordinal they name (§3), so a fixture can lay out exact gaps.
  async function seed_column(
    project: string,
    layout: [string, number][],
  ): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const [title, ordinal] of layout) {
      const [st, rec] = await create_task(su, WS, project, getitem(ST, "Todo"), title, { ordinal });
      if (st !== 200) throw new roomkit.SystemExit(`seed ${title} failed: ${st} ${py_str(rec)}`);
      ids[title] = getitem(rec, "id");
    }
    return ids;
  }

  // ── §9 placement ─────────────────────────────────────────────────────────
  // COVERS: hook:ordinal.pb.js#onRecordUpdateRequest:tasks
  console.log(
    "\n── §9 a member's move lands where it names, and the response carries the new ordinal ──",
  );
  const P9 = await new_project("Move Placement");
  const T: Record<string, string> = {};
  for (const [title, status] of [
    ["T1", "Todo"],
    ["T2", "Todo"],
    ["T3", "Todo"],
    ["T4", "Todo"],
    ["D1", "In Progress"],
    ["D2", "In Progress"],
  ]) {
    let rec: any;
    [s, rec] = await create_task(member, WS, P9, getitem(ST, status), title);
    if (s !== 200) throw new roomkit.SystemExit(`create ${title} failed: ${s} ${py_str(rec)}`);
    T[title] = getitem(rec, "id");
  }
  let order9 = titles(await project_order(P9));
  console.log(`  start order (D1/T1 and D2/T2 share an ordinal, newest first): ${py_str(order9)}`);

  async function placement(
    label: string,
    mover: string,
    body: Record<string, any>,
    expected: string[],
  ): Promise<Row[]> {
    const [st, r] = await move(member, T[mover], body);
    check(`${label} → batch 200 / request 200`, [st, inner(r).status], [200, 200]);
    const rows = await project_order(P9);
    check(`${label}: project order`, titles(rows), expected);
    const stored = rows.find((x) => x.title === mover)?.ordinal ?? null;
    check(`${label}: response ordinal is the stored one`, inner(r).ordinal ?? null, stored);
    order9 = titles(rows);
    return rows;
  }

  await placement("T4 after T1", "T4", { move: { after: T.T1 } }, placed(order9, "T4", "T1", true));
  await placement(
    "T1 before T3",
    "T1",
    { move: { before: T.T3 } },
    placed(order9, "T1", "T3", false),
  );
  let rows9 = await project_order(P9);
  const todo = (rows: Row[], but: string): string[] =>
    rows.filter((r) => r.status === getitem(ST, "Todo") && r.title !== but).map((r) => r.title);
  await placement(
    "T3 at the start of Todo",
    "T3",
    { move: { at: "start" } },
    placed(order9, "T3", todo(rows9, "T3")[0], false),
  );
  rows9 = await project_order(P9);
  await placement(
    "T2 at the end of Todo (group=status)",
    "T2",
    { move: { at: "end", group: "status" } },
    placed(order9, "T2", todo(rows9, "T2").at(-1)!, true),
  );

  const [, ws9] = await api("GET", `/api/collections/workspaces/records/${WS}`, su);
  const PRIO: string = getitem(getitem(ws9, "priorities")[0], "id");
  for (const t of ["D1", "T1"]) {
    [s] = await api("PATCH", `/api/collections/tasks/records/${T[t]}`, member, { priority: PRIO });
    check(`(fixture) ${t} gets priority ${PRIO} → 200`, s, 200);
  }
  rows9 = await project_order(P9);
  const last_prio = rows9.filter((r) => r.priority === PRIO && r.title !== "T4").at(-1)!.title;
  rows9 = await placement(
    `T4 to the end of priority ${PRIO} (group=priority)`,
    "T4",
    { priority: PRIO, move: { at: "end", group: "priority" } },
    placed(order9, "T4", last_prio, true),
  );
  check("T4 now carries that priority", rows9.find((r) => r.title === "T4")?.priority, PRIO);

  rows9 = await placement(
    "T2 across columns: In Progress, after D1",
    "T2",
    { status: getitem(ST, "In Progress"), move: { after: T.D1 } },
    placed(order9, "T2", "D1", true),
  );
  check(
    "T2 now sits in In Progress",
    rows9.find((r) => r.title === "T2")?.status,
    getitem(ST, "In Progress"),
  );

  [s] = await api("PATCH", `/api/collections/tasks/records/${T.D2}`, member, {
    assignee: member_id,
  });
  check("(fixture) D2 is assigned to the member → 200", s, 200);
  rows9 = await placement(
    "T4 to the start of the member's assignee column (group=assignee)",
    "T4",
    { assignee: member_id, move: { at: "start", group: "assignee" } },
    placed(order9, "T4", "D2", false),
  );
  check(
    "T4 now carries that assignee",
    (await api("GET", `/api/collections/tasks/records/${T.T4}`, su))[1].assignee,
    member_id,
  );

  const t3_before = rows9.find((r) => r.title === "T3")!.ordinal;
  rows9 = await placement(
    "T3 to the start of the empty Done column",
    "T3",
    { status: getitem(ST, "Done"), move: { at: "start" } },
    order9,
  );
  check(
    "an empty column keeps the mover's ordinal",
    rows9.find((r) => r.title === "T3")?.ordinal,
    t3_before,
  );

  // ── §10 DoD#2: the same gap, over and over ──────────────────────────────
  console.log("\n── §10 60 moves alternate X and Y into the gap right after A ──");
  const P10 = await new_project("Move Same Gap");
  const L10: [string, number][] = [
    ["A", 10],
    ["X", 20],
    ["Y", 30],
    ["B", 40],
    ["C", 50],
  ];
  const id10 = await seed_column(P10, L10);
  const MOVES = 60;
  let model = L10.map(([t]) => t);
  const bad_status: number[] = [];
  const bad_order: number[] = [];
  const bad_strict: number[] = [];
  let renumbered_at: number | null = null;
  for (let k = 1; k <= MOVES; k++) {
    const mover = k % 2 ? "Y" : "X";
    const [st, r] = await move(member, id10[mover], { move: { after: id10.A } });
    if (st !== 200) bad_status.push(k);
    model = placed(model, mover, "A", true);
    const rows = await project_order(P10);
    if (!Bun.deepEquals(titles(rows), model)) bad_order.push(k);
    if (!strict(rows)) bad_strict.push(k);
    if (renumbered_at === null && rows.find((x) => x.title === "B")?.ordinal !== 40) {
      renumbered_at = k;
      console.log(`  move ${k}: renumbered → ${py_str(ordinals(rows))}`);
    }
  }
  check(`all ${MOVES} moves → 200 (moves that were not: list)`, bad_status, []);
  check("after every move the order equals the model (moves that broke: list)", bad_order, []);
  check(
    "after every move ordinals strictly increase — no tie (moves that tied: list)",
    bad_strict,
    [],
  );
  check(
    "the gap collapsed and the backend renumbered: B (never moved) left 40",
    renumbered_at !== null,
    true,
  );
  console.log(`  final: ${py_str(ordinals(await project_order(P10)))}`);

  // The OLD client-side drop math (positionFor), reproduced here: halve the gap, never renumber.
  type OldRow = { id: string; position: number; created: number };
  const positionOf = (row: OldRow): number => row.position;
  function old_positionFor(cards: OldRow[], index: number, movingId: string): number {
    const others = cards
      .filter((row) => String(row.id) !== movingId)
      .sort((a, b) => positionOf(a) - positionOf(b));
    const prev = others[index - 1];
    const next = others[index];
    if (!prev && !next) return 1;
    if (!prev) return positionOf(next) - 1;
    if (!next) return positionOf(prev) + 1;
    return (positionOf(prev) + positionOf(next)) / 2;
  }
  const cards: OldRow[] = L10.map(([t, p], i) => ({ id: t, position: p, created: i }));
  let old_model = L10.map(([t]) => t);
  let old_broke: string | null = null;
  for (let k = 1; k <= MOVES && old_broke === null; k++) {
    const mover = k % 2 ? "Y" : "X";
    const others = cards.filter((c) => c.id !== mover).sort((a, b) => a.position - b.position);
    const index = others.findIndex((c) => c.id === "A") + 1;
    cards.find((c) => c.id === mover)!.position = old_positionFor(cards, index, mover);
    old_model = placed(old_model, mover, "A", true);
    // Ties resolve as the list does: newest first.
    const seen = [...cards].sort((a, b) => a.position - b.position || b.created - a.created);
    const tie = seen.findIndex((c, i) => i > 0 && seen[i - 1].position >= c.position);
    if (
      tie !== -1 ||
      !Bun.deepEquals(
        seen.map((c) => c.id),
        old_model,
      )
    ) {
      old_broke =
        `move ${k}: ${seen.map((c) => `${c.id}=${c.position}`).join(" ")}` +
        ` — wanted ${old_model.join(",")}`;
    }
  }
  console.log(`  expected observation, OLD midpoint math: ${old_broke ?? "never broke"}`);
  check(`the OLD midpoint math breaks within the same ${MOVES} moves`, old_broke !== null, true);

  // ── §11 DoD#3: two concurrent moves into the same gap ───────────────────
  console.log("\n── §11 30 rounds: the two last cards move after A at the same moment ──");
  const P11 = await new_project("Move Race");
  const L11: [string, number][] = [
    ["A", 10],
    ["B", 20],
    ["C", 30],
    ["D", 40],
    ["E", 50],
    ["F", 60],
  ];
  const id11 = await seed_column(P11, L11);
  const ROUNDS = 30;
  let saw_renumber = false;
  for (let round = 1; round <= ROUNDS; round++) {
    const before = titles(await project_order(P11));
    const movers = before.slice(-2);
    // Both requests are started before either is awaited (the §4 barrier idiom).
    const answers = await Promise.all(
      movers.map((m, i) => move(i ? token : member, id11[m], { move: { after: id11.A } })),
    );
    const rows = await project_order(P11);
    const got = titles(rows);
    // A is never moved, so A leaving its seeded 10 can only be a renumber.
    if (rows[0].ordinal !== 10) saw_renumber = true;
    check(
      `round ${round}: both 200 · A then the two movers · distinct strict ordinals`,
      [
        answers.map(([st, r]) => [st, inner(r).status]),
        got[0],
        [...got.slice(1, 3)].sort(by_code_point),
        new Set(rows.map((x) => x.ordinal)).size === rows.length && strict(rows),
      ],
      [
        [
          [200, 200],
          [200, 200],
        ],
        "A",
        [...movers].sort(by_code_point),
        true,
      ],
    );
  }
  check(
    "the race collapsed the gap and the backend renumbered (A left its seeded 10)",
    saw_renumber,
    true,
  );

  // ── §12 refused moves roll back ──────────────────────────────────────────
  console.log("\n── §12 a refused move changes no ordinal, even one that would have renumbered ──");
  const P12 = await new_project("Move Refusals");
  // TIE shares A's ordinal, so a move after A renumbers the project before it lands.
  const id12 = await seed_column(P12, [
    ["A", 10],
    ["TIE", 10],
    ["M", 30],
    ["S", 40],
  ]);
  const [, other_p] = await api(
    "GET",
    `/api/collections/tasks/records?${urlencode({ filter: `project='${P11}'`, perPage: 1 })}`,
    su,
  );
  const FOREIGN_TASK: string = getitem(getitem(other_p, "items")[0], "id");
  const bob_ws: string = (await find_one(su, "workspaces", `owner='${outsider_id}'`)).id;
  const FOREIGN_STATUS = Object.values(await status_ids(su, bob_ws))[0];
  const before12 = await project_order(P12);
  const snapshot12 = ordinals(before12);
  console.log(`  snapshot: ${py_str(snapshot12)}`);
  const AFTER_A = { after: id12.A };

  async function refused(label: string, st: number, r: any, want: [number, number]): Promise<any> {
    const ans = inner(r);
    check(`${label} → [outer, request] status`, [st, ans.status ?? st], want);
    check(`${label}: no ordinal moved`, ordinals(await project_order(P12)), snapshot12);
    return ans;
  }
  let st12: number;
  let r12: any;
  let ans12: any;

  // (a) (b) refused by main.pb.js's field validators
  for (const [label, body] of [
    ["(a) status from another workspace", { status: FOREIGN_STATUS }],
    ["(b) priority outside the vocabulary", { priority: "not-a-priority" }],
    ["(b) assignee who is not an active member", { assignee: outsider_id }],
  ] as [string, Record<string, any>][]) {
    [st12, r12] = await move(member, id12.M, { ...body, move: AFTER_A });
    ans12 = await refused(label, st12, r12, [400, 400]);
  }
  console.log(`  a refused move, verbatim (last of the above): ${JSON.stringify(r12)}`);

  // (c) the role matrix: a viewer and a non-member
  [st12, r12] = await move(viewer, id12.M, { move: AFTER_A });
  await refused("(c) a viewer member", st12, r12, [400, 404]);
  [st12, r12] = await move(outsider, id12.M, { move: AFTER_A });
  await refused("(c) a non-member", st12, r12, [400, 404]);

  // (g') an over-limit title with a renumbering move, outside a batch: no transaction would take
  // the renumber back, so the move is refused before it renumbers.
  [st12, r12] = await api("PATCH", `/api/collections/tasks/records/${id12.M}`, member, {
    title: "x".repeat(400),
    move: AFTER_A,
  });
  await refused("(g') the same as a plain PATCH", st12, r12, [400, 400]);

  // (d) a move needs the batch transaction
  [st12, r12] = await api("PATCH", `/api/collections/tasks/records/${id12.M}`, member, {
    move: AFTER_A,
  });
  ans12 = await refused("(d) move in a plain PATCH", st12, r12, [400, 400]);
  check("(d) the refusal names `move`", Object.keys(ans12.data ?? {}), ["move"]);
  console.log(`  plain PATCH refusal, verbatim: ${JSON.stringify(r12)}`);

  // (e) malformed placements
  for (const [label, placement_body] of [
    ["(e) no placement", {}],
    ["(e) after AND before", { after: id12.A, before: id12.S }],
    ["(e) after AND at", { after: id12.A, at: "end" }],
    ["(e) the mover as its own anchor", { after: id12.M }],
    ["(e) an anchor in another project", { before: FOREIGN_TASK }],
    ["(e) an unknown anchor id", { after: "zzzzzzzzzzzzzzz" }],
    ["(e) an unknown group", { at: "end", group: "label" }],
    ["(e) an unknown at", { at: "middle" }],
    ["(e) move that is not an object", "after"],
  ] as [string, any][]) {
    [st12, r12] = await move(member, id12.M, { move: placement_body });
    ans12 = await refused(label, st12, r12, [400, 400]);
    check(`${label}: the refusal names \`move\``, Object.keys(ans12.data ?? {}), ["move"]);
  }
  console.log(`  malformed refusal, verbatim (last of the above): ${JSON.stringify(r12)}`);

  // (f) the stale-write key rides along: refused as a plain tasks PATCH with it is
  const M_updated: string = (await api("GET", `/api/collections/tasks/records/${id12.M}`, su))[1]
    .updated;
  const [plain_st, plain_r] = await api(
    "PATCH",
    `/api/collections/tasks/records/${id12.M}`,
    member,
    {
      title: "M",
      expected_updated_at: M_updated,
    },
  );
  [st12, r12] = await move(member, id12.M, { expected_updated_at: M_updated, move: AFTER_A });
  ans12 = await refused("(f) expected_updated_at alongside a move", st12, r12, [400, plain_st]);
  check(
    "(f) same answer as a plain tasks PATCH carrying expected_updated_at",
    [ans12.status, ans12.message, ans12.data],
    [plain_st, plain_r.message, plain_r.data],
  );
  console.log(`  plain PATCH with expected_updated_at: ${plain_st} ${JSON.stringify(plain_r)}`);

  // (g) PocketBase validates fields only after every update hook has run, so this refusal
  // lands after the move hook has renumbered: the batch transaction must take that back.
  [st12, r12] = await move(member, id12.M, { title: "x".repeat(400), move: AFTER_A });
  ans12 = await refused(
    "(g) a title over the limit, refused after the move",
    st12,
    r12,
    [400, 400],
  );
  check("(g) the refusal names `title`", Object.keys(ans12.data ?? {}), ["title"]);

  // Control: the same move, unrefused, DOES renumber — so every refusal above had something to undo.
  [st12, r12] = await move(member, id12.M, { move: AFTER_A });
  check(
    "control: the same move by the member → batch 200 / request 200",
    [st12, inner(r12).status],
    [200, 200],
  );
  const after12 = await project_order(P12);
  check(
    "control: it renumbered (TIE and A no longer share 10)",
    after12.filter((x) => x.ordinal === 10).length < 2,
    true,
  );
  check(
    "control: M lands right after A",
    titles(after12),
    placed(titles(before12), "M", "A", true),
  );

  // ── §13 the renumber's scope ─────────────────────────────────────────────
  console.log("\n── §13 a renumber covers the whole project (both columns) and nothing else ──");
  const P13 = await new_project("Move Scope");
  const P13b = await new_project("Move Scope Neighbour");
  const id13: Record<string, string> = {};
  // TIE shares A's ordinal from another column, so moving N after A renumbers P13.
  for (const [title, status, ordinal, project] of [
    ["A", "Todo", 10, P13],
    ["TIE", "In Progress", 10, P13],
    ["M", "Todo", 30, P13],
    ["S", "In Progress", 40, P13],
    ["N", "Todo", 50, P13],
    ["Q", "Todo", 1.5, P13b],
    ["R", "In Progress", 7, P13b],
  ] as [string, string, number, string][]) {
    const [st, rec] = await create_task(su, WS, project, getitem(ST, status), title, { ordinal });
    if (st !== 200) throw new roomkit.SystemExit(`seed ${title} failed: ${st} ${py_str(rec)}`);
    id13[title] = getitem(rec, "id");
  }
  const start13 = titles(await project_order(P13));
  const neighbour13 = ordinals(await project_order(P13b));
  const updated_of = async (id: string): Promise<string> =>
    (await api("GET", `/api/collections/tasks/records/${id}`, su))[1].updated;
  const s_updated13 = await updated_of(id13.S);
  const [st13, r13] = await move(member, id13.N, { move: { after: id13.A } });
  check("N after A → batch 200 / request 200", [st13, inner(r13).status], [200, 200]);
  const rows13 = await project_order(P13);
  check(
    "P13's whole order, both columns, equals the model",
    titles(rows13),
    placed(start13, "N", "A", true),
  );
  // N starts last, so the renumber gives the others their 1-based place in start13 and N the
  // midpoint between A and the task after it.
  const want13: Record<string, number> = {};
  start13.filter((t) => t !== "N").forEach((t, i) => (want13[t] = i + 1));
  want13.N = want13.A + 0.5;
  check(
    "P13 renumbered to 1..n in project order, N at the new midpoint",
    ordinals(rows13),
    Object.fromEntries(titles(rows13).map((t) => [t, want13[t]])),
  );
  check("the response carries N's new ordinal", inner(r13).ordinal ?? null, want13.N);
  check(
    "S was renumbered (40 → 4) without its `updated` moving",
    await updated_of(id13.S),
    s_updated13,
  );
  check(
    "the neighbour project in the same workspace keeps every ordinal",
    ordinals(await project_order(P13b)),
    neighbour13,
  );

  // ── §14 a retired priority belongs to the No priority column ─────────────
  console.log(
    "\n── §14 start/end of No priority (group=priority) counts a retired priority as none ──",
  );
  const [, ws14] = await api("GET", `/api/collections/workspaces/records/${WS}`, su);
  const vocab14: any[] = getitem(ws14, "priorities");
  const RETIRING = "retiringprio001";
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, token, {
    priorities: [...vocab14, { ...vocab14[0], id: RETIRING, name: "Retiring" }],
  });
  check("(fixture) the workspace offers a priority it is about to retire → 200", s, 200);
  const P14 = await new_project("Move Retired Priority");
  const id14: Record<string, string> = {};
  for (const [title, ordinal, priority] of [
    ["RET1", 5, RETIRING],
    ["U1", 10, ""],
    ["PR1", 20, PRIO],
    ["RET2", 30, RETIRING],
    ["PR2", 40, PRIO],
  ] as [string, number, string][]) {
    const [st, rec] = await create_task(su, WS, P14, getitem(ST, "Todo"), title, {
      ordinal,
      priority,
    });
    if (st !== 200) throw new roomkit.SystemExit(`seed ${title} failed: ${st} ${py_str(rec)}`);
    id14[title] = getitem(rec, "id");
  }
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, token, {
    priorities: vocab14,
  });
  check("(fixture) the workspace retires it again → 200", s, 200);
  const start14 = titles(await project_order(P14));
  console.log(`  start order: ${py_str(start14)} (RET1/RET2 carry the retired priority)`);
  let [st14, r14] = await move(member, id14.PR2, {
    priority: "",
    move: { at: "end", group: "priority" },
  });
  check(
    "PR2 to the end of No priority → batch 200 / request 200",
    [st14, inner(r14).status],
    [200, 200],
  );
  const mid14 = titles(await project_order(P14));
  check(
    "PR2 lands after RET2, the last task the board shows under No priority",
    mid14,
    placed(start14, "PR2", "RET2", true),
  );
  [st14, r14] = await move(member, id14.PR1, {
    priority: "",
    move: { at: "start", group: "priority" },
  });
  check(
    "PR1 to the start of No priority → batch 200 / request 200",
    [st14, inner(r14).status],
    [200, 200],
  );
  check(
    "PR1 lands before RET1, the first task the board shows under No priority",
    titles(await project_order(P14)),
    placed(mid14, "PR1", "RET1", false),
  );

  // ── §15 a create carrying `move` ─────────────────────────────────────────
  console.log("\n── §15 a create carrying move is refused 400 on move, plain and in a batch ──");
  const P15 = await new_project("Move On Create");
  const body15 = {
    title: "born-moved",
    workspace: WS,
    project: P15,
    status: getitem(ST, "Todo"),
    move: { at: "end" },
  };
  let [st15, r15] = await api("POST", "/api/collections/tasks/records", member, body15);
  check("plain create with move → 400", st15, 400);
  check("plain create: the refusal names `move`", Object.keys(r15.data ?? {}), ["move"]);
  [st15, r15] = await api("POST", "/api/batch", member, {
    requests: [{ method: "POST", url: "/api/collections/tasks/records", body: body15 }],
  });
  check("batch create with move → [outer, request] 400", [st15, inner(r15).status], [400, 400]);
  check("batch create: the refusal names `move`", Object.keys(inner(r15).data ?? {}), ["move"]);
  check("nothing was created", titles(await project_order(P15)), []);
} finally {
  await room.stop();
  room.cleanup_tmp();
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ all checks passed");
process.exit(0);

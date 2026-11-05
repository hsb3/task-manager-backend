#!/usr/bin/env bun
/**
 * E2E proof of POST /api/tracker/workspaces/{id}/vocab: atomic full-array replace of a
 * workspace's statuses+labels (reorder/position repaint, rename-by-id, add-without-id,
 * delete-by-omission, referenced/core-label delete guards with rollback), off_pipeline
 * rejection, and the owner/admin/member/non-member/anon route auth matrix.
 *
 * Self-contained clean-room server (--hooksDir from a pb_hooks copy; the route under test lives there),
 * scripts/seed.ts fixtures. Port 8137 + PB_PORT_OFFSET — 8100+ suite self-boot band
 * (.agents/rules/ports.md).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, json_dumps, py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8137 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  return [r.status, raw ? JSON.parse(raw) : {}];
}

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
  return items.length ? items[0].id : null;
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [r.token, r.record.id];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!tok) {
    throw new Error(`superuser auth failed: ${py_repr(r)}`);
  }
  return tok;
}

async function su_create_user(su: string, name: string, email: string): Promise<string> {
  const [s, r] = await api("POST", "/api/collections/users/records", su, {
    email,
    password: "test123456",
    passwordConfirm: "test123456",
    name,
    verified: true,
    approved: true,
  });
  check(`(fixture) throwaway user ${name} created`, s, 200);
  return r.id;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

async function get_statuses(ws_id: string, token: string | null): Promise<any[]> {
  const qs = urlencode({ filter: `workspace='${esc(ws_id)}'`, sort: "position", perPage: 200 });
  const [, r] = await api("GET", `/api/collections/statuses/records?${qs}`, token);
  return r.items || [];
}

async function get_labels(ws_id: string, token: string | null): Promise<any[]> {
  const qs = urlencode({ filter: `workspace='${esc(ws_id)}'`, sort: "created", perPage: 200 });
  const [, r] = await api("GET", `/api/collections/labels/records?${qs}`, token);
  return r.items || [];
}

async function snapshot_statuses(ws_id: string, token: string | null): Promise<string> {
  // Sorted by id (not position) so a REJECTED reorder can't shuffle the snapshot
  // itself — this proves byte-identical state, not just byte-identical ordering.
  const slim = (await get_statuses(ws_id, token))
    .map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      position: r.position ?? null,
      is_default: r.is_default ?? null,
    }))
    .sort((a, b) => by_code_point(a.id, b.id));
  return json_dumps(slim, { sort_keys: true });
}

async function snapshot_labels(ws_id: string, token: string | null): Promise<string> {
  const slim = (await get_labels(ws_id, token))
    .map((r) => ({ id: r.id, name: r.name, core: r.core ?? null }))
    .sort((a, b) => by_code_point(a.id, b.id));
  return json_dumps(slim, { sort_keys: true });
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-vocab-upsert-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) {
    fs.rmSync(path.join(MIG_DIR, name));
  }
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

  const ALICE_WS = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  const VOCAB_URL = `/api/tracker/workspaces/${ALICE_WS}/vocab`;

  const statuses = await get_statuses(ALICE_WS, alice);
  check("seed default vocab: exactly 5 statuses", statuses.length, 5);
  const by_name: Record<string, any> = Object.fromEntries(statuses.map((r) => [r.name, r]));
  const [backlog_id, todo_id] = [by_name["Backlog"].id, by_name["Todo"].id];
  const [inprog_id, done_id, canceled_id] = [
    by_name["In Progress"].id,
    by_name["Done"].id,
    by_name["Canceled"].id,
  ];

  const labels = await get_labels(ALICE_WS, alice);
  check("seed default vocab: exactly 3 core labels", labels.length, 3);
  check(
    "seed default vocab: all 3 labels are core",
    labels.every((lbl) => lbl.core),
    true,
  );
  const label_by_name: Record<string, any> = Object.fromEntries(labels.map((l) => [l.name, l]));
  const feature_id = label_by_name["Feature"].id;

  // referenced-status set: Website Redesign holds the only tasks in Alice's workspace
  // (Mobile App belongs to Bob's workspace) — Todo/In Progress/Done are referenced,
  // Backlog/Canceled are not (used below for the delete-by-omission case).
  const proj_tasks = await find_by_filter("tasks", `project='${ALICE_PROJECT}'`, alice);
  const referenced_status_ids = new Set(proj_tasks.filter((t) => t.status).map((t) => t.status));
  check("(fixture) Todo is referenced by a seeded task", referenced_status_ids.has(todo_id), true);
  check(
    "(fixture) In Progress is referenced by a seeded task",
    referenced_status_ids.has(inprog_id),
    true,
  );
  check("(fixture) Done is referenced by a seeded task", referenced_status_ids.has(done_id), true);
  check(
    "(fixture) Canceled is UNreferenced (delete-by-omission target)",
    referenced_status_ids.has(canceled_id),
    false,
  );

  // ══════ (1)(2)(3)(4) one atomic call: reorder+position-repaint, rename-by-id,
  // add-without-id (terminal true/false), delete-by-omission (unreferenced) ══════
  // COVERS: route:POST /api/tracker/workspaces/{id}/vocab
  console.log("\n── (1-4) atomic reorder + rename + add + delete-by-omission ──");
  const submit = [
    { id: done_id, name: "Done", terminal: true }, // terminal explicit: preserve completed
    { id: inprog_id, name: "In Progress" }, // terminal omitted: non-terminal cat preserved
    { id: todo_id, name: "To Do" }, // rename-by-id
    { id: backlog_id, name: "Backlog" },
    { name: "Blocked", terminal: true }, // add-without-id -> completed
    { name: "Someday", terminal: false }, // add-without-id -> unstarted
    // canceled_id omitted -> delete-by-omission (unreferenced, must succeed)
  ];
  let [s, body] = await api("POST", VOCAB_URL, alice, { statuses: submit });
  check("(1-4) POST vocab (statuses) -> 200", s, 200);
  check("(1-4) response is the saved workspace", body.id ?? null, ALICE_WS);

  const after = await get_statuses(ALICE_WS, alice);
  check("(4) exactly 6 statuses after the call (5 seeded -1 deleted +2 added)", after.length, 6);
  const after_by_name: Record<string, any> = Object.fromEntries(after.map((r) => [r.name, r]));
  check(
    "(4) 'Canceled' is gone (delete-by-omission, unreferenced)",
    "Canceled" in after_by_name,
    false,
  );

  const positions = after.map((r) => r.position).sort((a, b) => a - b);
  check("(1) positions are contiguous 0..5", positions, [0, 1, 2, 3, 4, 5]);
  const ordered_ids = [...after].sort((a, b) => a.position - b.position).map((r) => r.id);
  const blocked_id = after_by_name["Blocked"].id;
  const someday_id = after_by_name["Someday"].id;
  const expected_order = [done_id, inprog_id, todo_id, backlog_id, blocked_id, someday_id];
  check("(1) position order == submitted array order", ordered_ids, expected_order);

  const to_do_row = after.find((r) => r.id === todo_id);
  check("(2) rename-by-id: name changed to 'To Do'", to_do_row.name, "To Do");
  check("(2) rename-by-id: id stayed stable", to_do_row.id, todo_id);

  check(
    "(3) add-without-id terminal:true -> category completed",
    after_by_name["Blocked"].category,
    "completed",
  );
  check(
    "(3) add-without-id terminal:false -> category unstarted",
    after_by_name["Someday"].category,
    "unstarted",
  );
  check(
    "(bonus) Done kept category 'completed' (terminal explicitly preserved)",
    after_by_name["Done"].category,
    "completed",
  );
  check(
    "(bonus) In Progress kept category 'started' (non-terminal, terminal omitted)",
    after_by_name["In Progress"].category,
    "started",
  );

  // ══════════════════ (5) rejected-delete rollback: referenced status ══════════
  console.log("\n── (5) omitting a status still referenced by a task -> 400, full rollback ──");
  const before_snap = await snapshot_statuses(ALICE_WS, alice);
  const bad_statuses = [
    { id: done_id, name: "Done Attempted Rename", terminal: true },
    { id: todo_id, name: "To Do Attempted Rename" },
    { id: backlog_id, name: "Backlog" },
    // inprog_id omitted (REFERENCED by 'Design homepage') -> must reject the WHOLE call
  ];
  [s, body] = await api("POST", VOCAB_URL, alice, { statuses: bad_statuses });
  check("(5) omit referenced status -> 400", s, 400);
  check(
    "(5) 400 message mentions 'referenced'",
    (body.message ?? "").toLowerCase().includes("referenced"),
    true,
  );
  const after_snap = await snapshot_statuses(ALICE_WS, alice);
  check(
    "(5) statuses snapshot BYTE-IDENTICAL after rejected call (atomic rollback)",
    after_snap,
    before_snap,
  );

  // ══════════════════ (6) rejected-delete rollback: core label ═════════════════
  console.log("\n── (6) omitting a core label -> 400, full rollback ──");
  const before_labels_snap = await snapshot_labels(ALICE_WS, alice);
  const bad_labels = [{ id: feature_id, name: "Feature Attempted Rename" }];
  // 'Bug' and 'Improvement' (both core) omitted -> must reject the whole call
  [s, body] = await api("POST", VOCAB_URL, alice, { labels: bad_labels });
  check("(6) omit a core label -> 400", s, 400);
  const msg = (body.message ?? "").toLowerCase();
  check(
    "(6) 400 message mentions core labels cannot be deleted",
    msg.includes("core labels") && msg.includes("cannot be deleted"),
    true,
  );
  const after_labels_snap = await snapshot_labels(ALICE_WS, alice);
  check(
    "(6) labels snapshot BYTE-IDENTICAL after rejected call (atomic rollback)",
    after_labels_snap,
    before_labels_snap,
  );

  // ══════════════════ (7) off_pipeline rejected ═════════════════════════════════
  console.log("\n── (7) off_pipeline:true is rejected ──");
  [s, body] = await api("POST", VOCAB_URL, alice, {
    statuses: [{ id: todo_id, name: "To Do", off_pipeline: true }],
  });
  check("(7) off_pipeline:true -> 400", s, 400);
  const after_offpipeline_snap = await snapshot_statuses(ALICE_WS, alice);
  check(
    "(7) statuses untouched (pre-tx validation, no write attempted)",
    after_offpipeline_snap,
    after_snap,
  );

  // ══════════════════ (8) role matrix ═══════════════════════════════════════════
  console.log("\n── (8) role matrix: owner/admin/member/non-member/anon ──");
  tierkit.use(api);
  const bob_admin = await tierkit.actor_at_tier(ALICE_WS, bob_id, "admin", su, "Bob");

  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: carol_id,
    role: "member",
    status: "active",
  });
  check("(fixture) su creates Carol's membership row", s, 200);
  const carol_member = await tierkit.actor_at_tier(ALICE_WS, carol_id, "member", su, "Carol");

  const erin_email = `vocab-nonmember-${randomBytes(4).toString("hex")}@example.com`;
  const erin_id = await su_create_user(su, "Erin", erin_email);
  const [erin] = await login(erin_email);
  const erin_membership = await find_by_filter(
    "workspace_members",
    `(workspace='${ALICE_WS}' && user='${erin_id}')`,
    su,
  );
  check(
    "(fixture) confirmed Erin has NO membership row in Alice's workspace (non-member)",
    erin_membership,
    [],
  );

  [s] = await api("POST", VOCAB_URL, alice, {});
  check("(8) owner (Alice) empty-body POST -> 200", s, 200);
  [s] = await api("POST", VOCAB_URL, bob, {});
  check(
    "(8) admin-member (Bob) empty-body POST -> 200",
    tup(await bob_admin.now(), s),
    tup("admin", 200),
  );
  [s] = await api("POST", VOCAB_URL, carol, {});
  // The non-member check below expects the SAME 404, so Carol's workspace-scoped tier rides
  // in this assertion — a Carol with no membership in ALICE_WS would satisfy it otherwise.
  check(
    "(8) plain-member (Carol) empty-body POST -> 404",
    tup(await carol_member.now(), s),
    tup("member", 404),
  );
  [s] = await api("POST", VOCAB_URL, erin, {});
  check("(8) non-member (Erin) empty-body POST -> 404", s, 404);
  [s] = await api("POST", VOCAB_URL, null, {});
  check("(8) anon (no token) empty-body POST -> 401", s, 401);

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
  console.log("✅ all vocab-upsert proofs passed");
  process.exit(0);
}

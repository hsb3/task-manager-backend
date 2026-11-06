#!/usr/bin/env bun
/**E2E walk-through of the G2 (#74) collaboration flow (plan §3): one task carries
assign → comment → complete, asserting notification fan-out AND task_activity rows
at each step, unsubscribe stopping fan-out, replay idempotence, and the
g2-notification-digest cron sending exactly one email per user with unread
notifications (captured via a local SMTP sink).

Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
Port 8104 + PB_PORT_OFFSET — suite self-boot band (solo runs). SMTP sink on
2532 + PB_PORT_OFFSET (2526/2527 are the battery's).*/

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_repr,
  py_strip,
  read_text,
  run_checked,
  splitlines,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const SMTP_SINK = path.join(REPO_ROOT, "scripts", "smtp_sink.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8104 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const SINK_PORT = 2532 + PORT_OFFSET;

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

// connect_ex(...) == 0 on a 0.5 s timeout; a graceful end() so the sink sees a clean close
function connect_ex_ok(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.setTimeout(500);
    sock.once("connect", () => {
      sock.end();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
}

async function wait_for_port_open(port: number, timeout = 10): Promise<boolean> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (await connect_ex_ok(port)) return true;
    await Bun.sleep(200);
  }
  return false;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function start_sink(mail_dir: string): Promise<Bun.Subprocess> {
  const proc = Bun.spawn([process.execPath, SMTP_SINK], {
    env: { ...process.env, SINK_PORT: String(SINK_PORT), MAIL_DIR: mail_dir },
    stdout: "ignore",
  });
  await wait_for_port_open(SINK_PORT);
  return proc;
}

async function stop_sink(proc: Bun.Subprocess | null): Promise<void> {
  if (proc === null) return;
  proc.kill();
  if ((await Promise.race([proc.exited, Bun.sleep(10000).then(() => null)])) === null) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  if (!(await roomkit.wait_for_port_free(SINK_PORT))) {
    console.log(`  ⚠️  sink port ${SINK_PORT} still occupied after stopping`);
  }
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-collab-flow-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const MAIL_DIR = path.join(S, "mail");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MAIL_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
let sink: Bun.Subprocess | null = null;
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
  sink = await start_sink(MAIL_DIR);
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

  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("resolved Alice's workspace", truthy(ALICE_WS), true);
  check("resolved Alice's project", truthy(ALICE_PROJECT), true);
  const statuses: Record<string, string> = {};
  for (const r of await find_by_filter("statuses", `(workspace='${ALICE_WS}')`, alice)) {
    statuses[getitem(r, "name")] = getitem(r, "id");
  }
  const DONE_STATUS = statuses.Done ?? null;
  const TODO_STATUS = statuses.Todo ?? null;
  check("resolved 'Done' status (category completed)", truthy(DONE_STATUS), true);
  check("resolved 'Todo' status (non-completed)", truthy(TODO_STATUS), true);

  const subscriber_users = async (task_id: string): Promise<string[]> =>
    (await find_by_filter("task_subscribers", `(task='${task_id}')`, su)).map((r) =>
      getitem(r, "user"),
    );

  const notif_count = async (task_id: string, user_id: string, kind: string): Promise<number> =>
    (
      await find_by_filter(
        "notifications",
        `(task='${task_id}' && user='${user_id}' && kind='${kind}')`,
        su,
      )
    ).length;

  const activity_count = async (task_id: string, field: string | null = null): Promise<number> => {
    const filt = field === null ? `(task='${task_id}')` : `(task='${task_id}' && field='${field}')`;
    return (await find_by_filter("task_activity", filt, alice)).length;
  };

  let s: number, task: any;
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:tasks
  // ══════════════════ Setup ════════════════════════════════════════════════
  console.log("\n── setup: Alice owns a task (auto-subscribed) ──");
  [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-collab-flow",
    project: ALICE_PROJECT,
  });
  check("Alice creates the flow task", s, 200);
  const T = getitem(task, "id");
  check("Alice auto-subscribed on create", (await subscriber_users(T)).includes(alice_id), true);

  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:tasks, hook:activity.pb.js#onRecordUpdateRequest:tasks
  // ══════════════════ (a) assign ═══════════════════════════════════════════
  console.log("\n── (a) Alice assigns Bob ──");
  [s] = await api("PATCH", `/api/collections/tasks/records/${T}`, alice, { assignee: bob_id });
  check("assign PATCH → 200", s, 200);
  check("Bob notified (assigned), exactly once", await notif_count(T, bob_id, "assigned"), 1);
  check(
    "task_activity row for field=assignee exists",
    (await activity_count(T, "assignee")) >= 1,
    true,
  );
  const assignee_rows = await find_by_filter(
    "task_activity",
    `(task='${T}' && field='assignee')`,
    alice,
  );
  check("task_activity assignee row actor=Alice", getitem(assignee_rows[0], "actor"), alice_id);

  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments, rule:comments.create
  // ══════════════════ (b) comment ══════════════════════════════════════════
  console.log("\n── (b) Bob comments on the task ──");
  const baseline_activity = await activity_count(T);
  [s] = await api("POST", "/api/collections/comments/records", bob, {
    task: T,
    author: bob_id,
    body: "Looks good, starting now.",
  });
  check("Bob's comment create → 200", s, 200);
  check("Alice notified (commented), exactly once", await notif_count(T, alice_id, "commented"), 1);
  check("Bob NOT notified of his own comment", await notif_count(T, bob_id, "commented"), 0);
  check("comment produced NO new task_activity row", await activity_count(T), baseline_activity);

  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:tasks, hook:activity.pb.js#onRecordUpdateRequest:tasks
  // ══════════════════ (c) complete ═════════════════════════════════════════
  console.log("\n── (c) Alice moves the task to a completed-category status ──");
  [s] = await api("PATCH", `/api/collections/tasks/records/${T}`, alice, { status: DONE_STATUS });
  check("status→Done PATCH → 200", s, 200);
  check(
    "every subscriber except Alice notified (status_done): Bob, exactly once",
    await notif_count(T, bob_id, "status_done"),
    1,
  );
  check(
    "Alice (actor) NOT notified of her own status change",
    await notif_count(T, alice_id, "status_done"),
    0,
  );
  check(
    "task_activity row for field=status exists",
    (await activity_count(T, "status")) >= 1,
    true,
  );

  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:tasks, rule:task_subscribers.delete
  // ══════════════════ (d) unsubscribe stops fan-out ════════════════════════
  console.log("\n── (d) Bob unsubscribes; further changes do NOT notify him ──");
  const bob_sub_id =
    (await find_by_filter("task_subscribers", `(task='${T}')`, su))
      .filter((r) => getitem(r, "user") === bob_id)
      .map((r) => getitem(r, "id"))[0] ?? null;
  check("resolved Bob's (task,bob) subscriber row", truthy(bob_sub_id), true);
  [s] = await api("DELETE", `/api/collections/task_subscribers/records/${bob_sub_id}`, bob);
  check("Bob DELETE his own subscriber row → 204", s, 204);
  check("Bob no longer a subscriber", (await subscriber_users(T)).includes(bob_id), false);

  [s] = await api("PATCH", `/api/collections/tasks/records/${T}`, alice, { status: TODO_STATUS });
  check("Alice re-opens the task (status→Todo) → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/tasks/records/${T}`, alice, { status: DONE_STATUS });
  check("Alice re-completes the task (status→Done) → 200", s, 200);
  check(
    "Bob receives NO new status_done notification post-unsubscribe",
    await notif_count(T, bob_id, "status_done"),
    1,
  );

  // ══════════════════ (e) idempotence ══════════════════════════════════════
  console.log("\n── (e) idempotence: replay the assign PATCH verbatim ──");
  [s] = await api("PATCH", `/api/collections/tasks/records/${T}`, alice, { assignee: bob_id });
  check("replay assign (same value) → 200", s, 200);
  check("no duplicate {bob,assigned} notification", await notif_count(T, bob_id, "assigned"), 1);

  // COVERS: boot:notify.pb.js, cron:g2-notification-digest
  // ══════════════════ (f) digest ═══════════════════════════════════════════
  console.log("\n── (f) digest cron: one email per user with unread notifications ──");
  [s] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "127.0.0.1", port: SINK_PORT, tls: false },
    meta: { senderName: "Task Tracker", senderAddress: "digest@example.com" },
  });
  check("superuser PATCH /api/settings (repoint SMTP at the sink) → 200", s, 200);

  let crons: any;
  [s, crons] = await api("GET", "/api/crons", su);
  check("GET /api/crons → 200", s, 200);
  const cron_ids = Array.isArray(crons) ? crons.map((c) => c.id ?? null) : [];
  check("g2-notification-digest is registered", cron_ids.includes("g2-notification-digest"), true);

  [s] = await api("POST", "/api/crons/g2-notification-digest", su);
  check("POST /api/crons/g2-notification-digest → 204", s, 204);

  await Bun.sleep(2000); // sink writes asynchronously relative to the cron POST
  const eml_files = fs
    .readdirSync(MAIL_DIR)
    .filter((f) => f.endsWith(".eml"))
    .sort(by_code_point);
  const recipients: string[] = [];
  for (const fname of eml_files) {
    const content = read_text(path.join(MAIL_DIR, fname));
    const to_line = splitlines(content).find((ln) => ln.startsWith("To:")) ?? "";
    recipients.push(to_line ? py_strip(to_line.slice(to_line.indexOf(":") + 1)) : "");
  }

  check(
    "exactly TWO digest emails captured (Alice + Bob have unread; Carol has none)",
    eml_files.length,
    2,
  );
  check(
    "digest recipients are exactly {alice, bob}, one each",
    recipients.sort(by_code_point),
    ["alice@example.com", "bob@example.com"].sort(by_code_point),
  );
} finally {
  await stop_sink(sink);
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all collab-flow proofs passed");
  process.exit(0);
}

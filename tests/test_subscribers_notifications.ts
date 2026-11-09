#!/usr/bin/env bun
/**
 * E2E proof of G2 (#74) auto-subscribe (task_subscribers) + notification fan-out
 * (notifications) from pb_hooks/notify.pb.js: the auto-subscribe matrix on task
 * create/assign/comment, exactly-once minus-actor fan-out with replay idempotence,
 * the notifications role/field-scoped update rule, cross-user leakage, the
 * subscriber self-toggle (subscribe/unsubscribe), the trash surface exclusion on the
 * inbox listRule plus the digest cron count and the bulk read-all route that mirror it,
 * and the @mention fan-out (handle resolution, dedupe, replay guard on edit) with the
 * comment/status snapshot fields every kind carries. A second room plants two save
 * failures — one notification, one auto-subscribe — to prove neither is silently lost
 * nor allowed to abort the write it hangs off.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
 * Port 8134 + PB_PORT_OFFSET — suite self-boot band (8100+, solo runs); SMTP sink on
 * 2533 + PB_PORT_OFFSET (2526/2527 are the battery's).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  py_repr,
  py_split,
  read_text,
  run_checked,
  splitlines,
  tup,
  urlencode,
  truthy,
  sqlite_connect,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8134 + PORT_OFFSET;
const SINK_PORT = 2533 + PORT_OFFSET;
const SMTP_SINK = path.join(REPO_ROOT, "scripts", "smtp_sink.ts");
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
  if (!tok) throw new Error(`superuser auth failed: ${py_repr(r)}`);
  return tok;
}

function start_server(
  data_dir: string,
  migrations_dir: string,
  hooks: string | null = null,
): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, hooks || roomkit.hooks_dir(S));
}

async function start_sink(mail_dir: string): Promise<Bun.Subprocess> {
  const proc = Bun.spawn([process.execPath, SMTP_SINK], {
    env: { ...process.env, SINK_PORT: String(SINK_PORT), MAIL_DIR: mail_dir },
    stdout: "ignore",
  });
  const deadline = Date.now() + 15000;
  while (await roomkit.port_is_free(SINK_PORT)) {
    if (Date.now() >= deadline) {
      throw new Error(`SMTP sink never opened 127.0.0.1:${SINK_PORT}`);
    }
    await Bun.sleep(200);
  }
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
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-subs-notif-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const MAIL_DIR = path.join(S, "mail");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MAIL_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
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
  let su = await superuser_token();

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

  let [alice, alice_id] = await login("alice@example.com");
  let [bob, bob_id] = await login("bob@example.com");
  let [carol, carol_id] = await login("carol@example.com");

  const ALICE_WS = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
  const PRIO: Record<string, string> = {};
  for (const p of (await api("GET", `/api/collections/workspaces/records/${ALICE_WS}`, alice))[1]
    .priorities) {
    PRIO[p.name] = p.id;
  }
  let ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("resolved Alice's workspace", truthy(ALICE_WS), true);
  check("resolved Alice's project", truthy(ALICE_PROJECT), true);
  let done_rows = await find_by_filter(
    "statuses",
    `(workspace='${ALICE_WS}' && name='Done')`,
    alice,
  );
  const DONE_STATUS = done_rows.length ? done_rows[0].id : null;
  check("resolved Alice ws 'Done' status (category completed)", truthy(DONE_STATUS), true);

  async function subscriber_users(task_id: string): Promise<string[]> {
    return (await find_by_filter("task_subscribers", `(task='${task_id}')`, su)).map((r) => r.user);
  }

  async function notif_count(task_id: string, user_id: string, kind: string): Promise<number> {
    return (
      await find_by_filter(
        "notifications",
        `(task='${task_id}' && user='${user_id}' && kind='${kind}')`,
        su,
      )
    ).length;
  }

  let s: number, d: number, r: any, task: any;

  // ══════════════════ 1. AUTO-SUBSCRIBE MATRIX ════════════════════════════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:tasks
  console.log("\n── (1) auto-subscribe: create → assign → comment ──");
  [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-subs-fixture",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task", s, 200);
  const T1 = task.id;
  check(
    "(task,alice) subscriber row exists after create",
    (await subscriber_users(T1)).includes(alice_id),
    true,
  );

  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:tasks
  [s] = await api("PATCH", `/api/collections/tasks/records/${T1}`, alice, { assignee: bob_id });
  check("Alice assigns Bob", s, 200);
  check(
    "(task,bob) subscriber row appears after assign",
    (await subscriber_users(T1)).includes(bob_id),
    true,
  );
  check(
    "Carol is NOT auto-subscribed by anything",
    (await subscriber_users(T1)).includes(carol_id),
    false,
  );

  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  [s] = await api("POST", "/api/collections/comments/records", bob, {
    task: T1,
    author: bob_id,
    body: "first comment",
  });
  check("Bob comments on the task", s, 200);
  const bob_sub_rows = (await find_by_filter("task_subscribers", `(task='${T1}')`, su)).filter(
    (r) => r.user === bob_id,
  );
  check("(task,bob) subscriber row still exactly one (idempotent)", bob_sub_rows.length, 1);

  // ══════════════════ 2. FAN-OUT MINUS-ACTOR, EXACTLY ONCE ═══════════════════
  console.log("\n── (2) fan-out exactly-once + replay idempotence ──");
  check(
    "exactly ONE {bob,assigned} notification from the assign",
    await notif_count(T1, bob_id, "assigned"),
    1,
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${T1}`, alice, { assignee: bob_id });
  check("replay: re-PATCH SAME assignee=bob → 200", s, 200);
  check(
    "replay produced 0 NEW {bob,assigned} notifications",
    await notif_count(T1, bob_id, "assigned"),
    1,
  );

  check(
    "exactly ONE {alice,commented} notification from Bob's comment",
    await notif_count(T1, alice_id, "commented"),
    1,
  );
  check("Bob NOT notified of his own comment", await notif_count(T1, bob_id, "commented"), 0);

  [s] = await api("PATCH", `/api/collections/tasks/records/${T1}`, alice, { status: DONE_STATUS });
  check("Alice moves the task to 'Done' (completed category)", s, 200);
  check(
    "exactly ONE {bob,status_done} notification (bob is subscriber, alice is actor)",
    await notif_count(T1, bob_id, "status_done"),
    1,
  );
  check(
    "Alice (actor) NOT notified of her own status change",
    await notif_count(T1, alice_id, "status_done"),
    0,
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${T1}`, alice, { status: DONE_STATUS });
  check("replay: re-PATCH SAME status=Done → 200", s, 200);
  check(
    "replay produced 0 NEW {bob,status_done} notifications",
    await notif_count(T1, bob_id, "status_done"),
    1,
  );

  // ══════════════════ 3. NOTIFICATIONS RULES ══════════════════════════════════
  // COVERS: rule:notifications.create, rule:notifications.update
  console.log("\n── (3) notifications rules: null create, owner-only + field-scoped update ──");
  const bob_assigned_rows = await find_by_filter(
    "notifications",
    `(task='${T1}' && user='${bob_id}' && kind='assigned')`,
    su,
  );
  const BOB_NOTIF = bob_assigned_rows.length ? bob_assigned_rows[0].id : null;
  check("resolved Bob's 'assigned' notification", truthy(BOB_NOTIF), true);

  [s] = await api("POST", "/api/collections/notifications/records", bob, {
    user: bob_id,
    task: T1,
    kind: "assigned",
  });
  check("Bob POST create notification → 403 (null createRule)", s, 403);

  // The declared set is read from the generated schema, so widening `kind` cannot leave a
  // stale literal here still claiming a value is undeclared.
  const kind_values: string[] = JSON.parse(
    read_text(path.join(REPO_ROOT, "schema", "notifications.json")),
  ).fields.find((f: any) => f.name === "kind").values;
  const undeclared_kind = "not_" + kind_values.join("_");
  check("the probe kind is genuinely undeclared", kind_values.includes(undeclared_kind), false);
  for (const kind of kind_values) {
    [s, r] = await api("POST", "/api/collections/notifications/records", su, {
      user: bob_id,
      kind,
    });
    check(`superuser create notification kind=${py_repr(kind)} (declared) → 200`, s, 200);
    // Deleted immediately: a probe row left behind would land in the inbox counts below.
    [d] = await api("DELETE", `/api/collections/notifications/records/${r.id ?? "None"}`, su);
    check(`…probe row for kind=${py_repr(kind)} removed → 204`, d, 204);
  }
  [s, r] = await api("POST", "/api/collections/notifications/records", su, {
    user: bob_id,
    kind: undeclared_kind,
  });
  check(
    "superuser create notification with an UNDECLARED kind → 400 validation_invalid_value",
    tup(s, ((r.data || {}).kind || {}).code),
    tup(400, "validation_invalid_value"),
  );
  check(
    "…and no row was created for it",
    (await find_by_filter("notifications", `kind='${esc(undeclared_kind)}'`, su)).length,
    0,
  );

  [s, r] = await api("PATCH", `/api/collections/notifications/records/${BOB_NOTIF}`, bob, {
    read: true,
  });
  check("Bob PATCH {read:true} on his own notification → 200", s, 200);
  [s, r] = await api("PATCH", `/api/collections/notifications/records/${BOB_NOTIF}`, bob, {
    snoozed_until: "2030-01-01 00:00:00",
  });
  check("Bob PATCH {snoozed_until} → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/notifications/records/${BOB_NOTIF}`, bob, {
    kind: "commented",
  });
  check("Bob PATCH {kind} (blocked field) → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/notifications/records/${BOB_NOTIF}`, bob, {
    user: alice_id,
  });
  check("Bob PATCH {user} (blocked field) → 404", s, 404);

  // ══════════════════ 3.5 DELETE CLOSED — DISMISS INSTEAD ═══════════════════════
  // COVERS: rule:notifications.delete, rule:notifications.update
  console.log(
    "\n── (3.5) notifications delete: closed to clients (null deleteRule); dismiss instead ──",
  );
  const alice_commented_rows = await find_by_filter(
    "notifications",
    `(task='${T1}' && user='${alice_id}' && kind='commented')`,
    su,
  );
  const ALICE_NOTIF = alice_commented_rows.length ? alice_commented_rows[0].id : null;
  check("resolved Alice's 'commented' notification", truthy(ALICE_NOTIF), true);
  [s] = await api("DELETE", `/api/collections/notifications/records/${ALICE_NOTIF}`, carol);
  check("Carol DELETE Alice's notification → 403 (null deleteRule)", s, 403);
  [s] = await api("DELETE", `/api/collections/notifications/records/${ALICE_NOTIF}`, alice);
  check("Alice DELETE her own notification → 403 (null deleteRule)", s, 403);
  check(
    "…and the row survives",
    (await find_by_filter("notifications", `(id='${ALICE_NOTIF}')`, su)).length,
    1,
  );
  [s, r] = await api("PATCH", `/api/collections/notifications/records/${ALICE_NOTIF}`, alice, {
    dismissed: true,
  });
  check(
    "Alice PATCH {dismissed:true} on her own notification → 200",
    tup(s, r.dismissed),
    tup(200, true),
  );
  [s] = await api("PATCH", `/api/collections/notifications/records/${ALICE_NOTIF}`, carol, {
    dismissed: false,
  });
  check("Carol PATCH {dismissed} on Alice's notification → 404", s, 404);

  // ══════════════════ 4. CROSS-USER LEAKAGE ═══════════════════════════════════
  // COVERS: rule:notifications.list, rule:notifications.view
  console.log("\n── (4) cross-user leakage: Carol sees none of Alice's/Bob's notifications ──");
  [s, r] = await api("GET", "/api/collections/notifications/records", carol);
  check("Carol list notifications → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/notifications/records/${BOB_NOTIF}`, carol);
  check("Carol view Bob's notification by id → 404", s, 404);

  // ══════════════════ 5. SELF TOGGLE (unsubscribe) ════════════════════════════
  // COVERS: rule:task_subscribers.delete
  console.log("\n── (5) subscriber self-toggle: Bob unsubscribes ──");
  const bob_sub_id = (await find_by_filter("task_subscribers", `(task='${T1}')`, su)).find(
    (r) => r.user === bob_id,
  )?.id;
  check("resolved Bob's (task,bob) subscriber row", truthy(bob_sub_id), true);
  [s] = await api("DELETE", `/api/collections/task_subscribers/records/${bob_sub_id}`, bob);
  check("Bob DELETE his own subscriber row → 204", s, 204);
  check("Bob no longer a subscriber", (await subscriber_users(T1)).includes(bob_id), false);

  // ══════════════════ 6. SUBSCRIBER RULE TIERS (member-scoped tokens) ══════════
  // Bob is BOTH a workspace member of Alice's ws AND this task's assignee (seed.ts);
  // Carol is a non-member — reads/creates above go through `su` (bypasses rules).
  // COVERS: rule:task_subscribers.create
  console.log("\n── (6) subscriber rule tiers: member create/list/view + null-update-deny ──");
  [s, r] = await api("POST", "/api/collections/task_subscribers/records", bob, {
    task: T1,
    user: bob_id,
  });
  check("Bob re-subscribes himself (self-guard createRule) → 200", s, 200);
  const BOB_SUB2 = r.id;
  check("resolved Bob's new subscriber row id", truthy(BOB_SUB2), true);
  check("Bob is a subscriber again", (await subscriber_users(T1)).includes(bob_id), true);

  // self-guard `user = @request.auth.id` is checked against SUBMITTED data → create-denied 400.
  [s] = await api("POST", "/api/collections/task_subscribers/records", bob, {
    task: T1,
    user: alice_id,
  });
  check("Bob POST subscriber for Alice (not self) → 400 (self-guard createRule)", s, 400);

  [s] = await api("POST", "/api/collections/task_subscribers/records", carol, {
    task: T1,
    user: carol_id,
  });
  check("Carol (non-member) POST own subscriber row → 400 (createRule)", s, 400);

  // COVERS: rule:task_subscribers.list, rule:task_subscribers.view
  [s, r] = await api(
    "GET",
    `/api/collections/task_subscribers/records?filter=(task='${esc(T1)}')`,
    bob,
  );
  check("Bob (member/assignee) list subscribers → 200", s, 200);
  check("Bob's list is non-empty (rule let him read)", (r.items ?? []).length > 0, true);
  [s] = await api("GET", `/api/collections/task_subscribers/records/${BOB_SUB2}`, bob);
  check("Bob (member/assignee) view a subscriber row → 200", s, 200);

  [s, r] = await api(
    "GET",
    `/api/collections/task_subscribers/records?filter=(task='${esc(T1)}')`,
    carol,
  );
  check("Carol (non-member) list subscribers → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/task_subscribers/records/${BOB_SUB2}`, carol);
  check("Carol (non-member) view a subscriber row by id → 404", s, 404);

  // COVERS: rule:task_subscribers.update
  // updateRule is null → client update denied. null rule ⇒ 403 (not the set-but-denied 404).
  [s] = await api("PATCH", `/api/collections/task_subscribers/records/${BOB_SUB2}`, bob, {
    user: alice_id,
  });
  check("Bob PATCH his own subscriber row → 403 (null updateRule)", s, 403);

  // ══════════════════ 7. PROJECT-LESS TASK TRAVERSAL PROBE ═════════════════════
  // TASK-013.10: task_subscribers + task_activity list/view rules now scope through
  // task.workspace directly (not task.project.workspace), so owner/member reads survive
  // for a project-less task (tasks.project is OPTIONAL; tasks.workspace is required and,
  // via the D1 guard + workspace immutability, always equals project.workspace for project
  // tasks). This proves the corrected owner/member visibility AND that a non-member of the
  // task's workspace still leaks nothing.
  console.log("\n── (7) project-less task traversal probe (subscribers + activity) ──");
  let ptask: any;
  [s, ptask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-projectless-fixture",
    workspace: ALICE_WS,
  });
  check("Alice creates a PROJECT-LESS task (workspace set, no project)", s, 200);
  const PLT = ptask.id;
  // decision:shadow-project: a create with no project lands in the workspace shadow project, which only
  // a superuser can resolve — the projects rules hide it from every tenant role.
  const [, _shadow] = await api(
    "GET",
    "/api/collections/projects/records?" +
      urlencode({ filter: `workspace='${ALICE_WS}' && shadow=true` }),
    su,
  );
  check(
    "the task submitted with no project sits in the workspace shadow project",
    ptask.project,
    (_shadow.items || [{}])[0].id,
  );
  check(
    "(task,alice) subscriber row exists after project-less create",
    (await subscriber_users(PLT)).includes(alice_id),
    true,
  );

  // A whitelisted-field PATCH writes a task_activity row; assign Bob to make him assignee.
  [s] = await api("PATCH", `/api/collections/tasks/records/${PLT}`, alice, {
    priority: PRIO.high,
  });
  check("Alice PATCH priority on project-less task → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/tasks/records/${PLT}`, alice, { assignee: bob_id });
  check("Alice assigns Bob on the project-less task → 200", s, 200);
  const pl_activity = await find_by_filter("task_activity", `(task='${esc(PLT)}')`, su);
  check("project-less task has activity rows (superuser view)", pl_activity.length > 0, true);
  const pl_activity_id = pl_activity.length ? pl_activity[0].id : null;
  const pl_sub_id = (await find_by_filter("task_subscribers", `(task='${esc(PLT)}')`, su)).find(
    (r) => r.user === alice_id,
  )?.id;

  // Both Alice (workspace OWNER) and Bob (assignee) can VIEW the task itself: tasks rules
  // key on workspace.owner / assignee directly (no project traversal).
  [s] = await api("GET", `/api/collections/tasks/records/${PLT}`, alice);
  check("Alice (owner) can view the project-less task itself → 200", s, 200);
  [s] = await api("GET", `/api/collections/tasks/records/${PLT}`, bob);
  check("Bob (assignee) can view the project-less task itself → 200", s, 200);

  // PROBE — assignee tier (survives, no project traversal):
  [s, r] = await api(
    "GET",
    `/api/collections/task_subscribers/records?filter=(task='${esc(PLT)}')`,
    bob,
  );
  console.log(
    `     [probe] Bob(assignee) list subscribers → ${s}, items=${(r.items ?? []).length}`,
  );
  [s, r] = await api(
    "GET",
    `/api/collections/task_activity/records?filter=(task='${esc(PLT)}')`,
    bob,
  );
  console.log(
    `     [probe] Bob(assignee) list activity    → ${s}, items=${(r.items ?? []).length}`,
  );

  // PROBE — workspace-owner tier (traverses task.project.workspace.owner; project empty):
  let s_own_sub_l: number;
  [s_own_sub_l, r] = await api(
    "GET",
    `/api/collections/task_subscribers/records?filter=(task='${esc(PLT)}')`,
    alice,
  );
  const own_sub_list_n = (r.items ?? []).length;
  console.log(
    `     [probe] Alice(owner) list subscribers  → ${s_own_sub_l}, items=${own_sub_list_n}`,
  );
  const [s_own_sub_v] = await api(
    "GET",
    `/api/collections/task_subscribers/records/${pl_sub_id}`,
    alice,
  );
  console.log(`     [probe] Alice(owner) view own sub row   → ${s_own_sub_v}`);
  let s_own_act_l: number;
  [s_own_act_l, r] = await api(
    "GET",
    `/api/collections/task_activity/records?filter=(task='${esc(PLT)}')`,
    alice,
  );
  const own_act_list_n = (r.items ?? []).length;
  console.log(
    `     [probe] Alice(owner) list activity      → ${s_own_act_l}, items=${own_act_list_n}`,
  );
  const [s_own_act_v] = await api(
    "GET",
    `/api/collections/task_activity/records/${pl_activity_id}`,
    alice,
  );
  console.log(`     [probe] Alice(owner) view activity row  → ${s_own_act_v}`);

  // CORRECTED OUTCOME (TASK-013.10): task.workspace scoping restores owner/member reads.
  check(
    "owner lists subscribers on project-less task → 200 non-empty",
    tup(s_own_sub_l, own_sub_list_n > 0),
    tup(200, true),
  );
  check("owner views own subscriber row → 200", s_own_sub_v, 200);
  check(
    "owner lists activity on project-less task → 200 non-empty",
    tup(s_own_act_l, own_act_list_n > 0),
    tup(200, true),
  );
  check("owner views activity row → 200", s_own_act_v, 200);

  // ── (7b) NON-MEMBER leakage: Carol is not in Alice's workspace and is not the
  // assignee — the corrected task.workspace scoping must still deny her every read.
  console.log("     [probe] non-member (Carol) must leak nothing");
  [s, r] = await api(
    "GET",
    `/api/collections/task_subscribers/records?filter=(task='${esc(PLT)}')`,
    carol,
  );
  check(
    "non-member list subscribers on project-less task → 200 empty",
    tup(s, r.items),
    tup(200, []),
  );
  [s] = await api("GET", `/api/collections/task_subscribers/records/${pl_sub_id}`, carol);
  check("non-member view subscriber row by id → 404", s, 404);
  [s, r] = await api(
    "GET",
    `/api/collections/task_activity/records?filter=(task='${esc(PLT)}')`,
    carol,
  );
  check("non-member list activity on project-less task → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/task_activity/records/${pl_activity_id}`, carol);
  check("non-member view activity row by id → 404", s, 404);

  // ══════════════════ 8. PROJECT-LESS EXPLICIT SELF-SUBSCRIBE (createRule) ═════
  // TASK-013.10 follow-up: task_subscribers.createRule ALSO traversed
  // task.project.workspace (collapses to empty for project-less tasks), blocking
  // explicit self-subscribe for every tier, not just list/view. Re-scoped to
  // task.workspace directly (schema/task_subscribers.rules.json), matching the
  // corrected list/view rule while retaining `user = @request.auth.id`.
  console.log("\n── (8) project-less explicit self-subscribe: owner + member vs non-member ──");
  let ptask2: any;
  [s, ptask2] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-projectless-createRule-fixture",
    workspace: ALICE_WS,
  });
  check("Alice creates a SECOND project-less task (workspace set, no project)", s, 200);
  const PLT2 = ptask2.id;

  // The auto-subscribe hook runs with elevated privileges and bypasses createRule,
  // so it does not exercise the rule under test — remove it and prove Alice (owner)
  // can explicitly self-subscribe via the actual API rule instead.
  const auto_sub_id = (await find_by_filter("task_subscribers", `(task='${esc(PLT2)}')`, su)).find(
    (r) => r.user === alice_id,
  )?.id;
  check("resolved Alice's auto-subscribe row on PLT2", truthy(auto_sub_id), true);
  [s] = await api("DELETE", `/api/collections/task_subscribers/records/${auto_sub_id}`, alice);
  check("Alice removes her auto-subscribe row (own delete) → 204", s, 204);

  [s, r] = await api("POST", "/api/collections/task_subscribers/records", alice, {
    task: PLT2,
    user: alice_id,
  });
  check("Alice (workspace OWNER, not assignee) explicit self-subscribe → 200", s, 200);
  check(
    "Alice is a subscriber on the project-less task",
    (await subscriber_users(PLT2)).includes(alice_id),
    true,
  );

  [s, r] = await api("POST", "/api/collections/task_subscribers/records", bob, {
    task: PLT2,
    user: bob_id,
  });
  check("Bob (workspace MEMBER, not owner/assignee) explicit self-subscribe → 200", s, 200);
  check(
    "Bob is a subscriber on the project-less task",
    (await subscriber_users(PLT2)).includes(bob_id),
    true,
  );

  [s] = await api("POST", "/api/collections/task_subscribers/records", carol, {
    task: PLT2,
    user: carol_id,
  });
  check("Carol (non-member of Alice's workspace) self-subscribe → 400 (createRule denied)", s, 400);
  check(
    "Carol did NOT become a subscriber (tenant isolation intact)",
    (await subscriber_users(PLT2)).includes(carol_id),
    false,
  );

  // ══════════════════ 9. TRASH SURFACE EXCLUSION (inbox + digest) ═════════════
  // COVERS: rule:notifications.list, cron:g2-notification-digest
  console.log("\n── (9) trash surface exclusion: inbox listRule + digest count ──");

  async function bob_inbox(): Promise<any[]> {
    const [, r] = await api("GET", "/api/collections/notifications/records?perPage=200", bob);
    return r.items || [];
  }

  async function bob_inbox_ids(): Promise<string[]> {
    return (await bob_inbox()).map((x) => x.id);
  }

  let tt: any;
  [s, tt] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-trash-surface-fixture",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task in her project", s, 200);
  const TT = tt.id;
  [s] = await api("PATCH", `/api/collections/tasks/records/${TT}`, alice, { assignee: bob_id });
  check("Alice assigns Bob (the fan-out writes his notification)", s, 200);
  const tt_rows = await find_by_filter(
    "notifications",
    `(task='${esc(TT)}' && user='${esc(bob_id)}')`,
    su,
  );
  const TT_NOTIF = tt_rows.length ? tt_rows[0].id : null;
  check("resolved Bob's notification for the live task", truthy(TT_NOTIF), true);
  check(
    "Bob's inbox lists it while the task is live",
    (await bob_inbox_ids()).includes(TT_NOTIF),
    true,
  );
  [s] = await api("GET", `/api/collections/notifications/records/${TT_NOTIF}`, bob);
  check("Bob fetches it by id while the task is live → 200", s, 200);

  [s] = await api("DELETE", `/api/collections/tasks/records/${TT}`, alice);
  check("Alice trashes the task → 204", s, 204);
  check(
    "surface-exclusion: trashing the task removes it from the inbox",
    (await bob_inbox_ids()).includes(TT_NOTIF),
    false,
  );
  [s] = await api("GET", `/api/collections/notifications/records/${TT_NOTIF}`, bob);
  check("surface-exclusion: fetching the trashed one by id → 404 (view denied)", s, 404);
  check(
    "the notification row itself survives (list is filtered, not deleted)",
    (await find_by_filter("notifications", `(id='${esc(TT_NOTIF)}')`, su)).length,
    1,
  );

  [s] = await api("PATCH", `/api/collections/tasks/records/${TT}`, alice, { trashed: "" });
  check("Alice restores the task → 200", s, 200);
  check(
    "surface-exclusion: restoring the task returns it to the inbox",
    (await bob_inbox_ids()).includes(TT_NOTIF),
    true,
  );
  [s] = await api("GET", `/api/collections/notifications/records/${TT_NOTIF}`, bob);
  check("fetching it by id after restore → 200 again", s, 200);

  // Project-trash cascade: the task keeps an empty `trashed` of its own, so only the
  // traversal through project can hide its notification.
  let p2: any, tt2: any;
  [s, p2] = await api("POST", "/api/collections/projects/records", alice, {
    name: "G2-trash-surface-project",
    workspace: ALICE_WS,
    owner: alice_id,
  });
  check("Alice creates a second project", s, 200);
  const P2 = p2.id;
  [s, tt2] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-trash-surface-project-task",
    project: P2,
  });
  check("Alice creates a task inside that project", s, 200);
  const TT2 = tt2.id;
  [s] = await api("PATCH", `/api/collections/tasks/records/${TT2}`, alice, { assignee: bob_id });
  check("Alice assigns Bob on the project task", s, 200);
  const tt2_rows = await find_by_filter(
    "notifications",
    `(task='${esc(TT2)}' && user='${esc(bob_id)}')`,
    su,
  );
  const TT2_NOTIF = tt2_rows.length ? tt2_rows[0].id : null;
  check("resolved Bob's notification for the project task", truthy(TT2_NOTIF), true);
  check(
    "Bob's inbox lists it while the project is live",
    (await bob_inbox_ids()).includes(TT2_NOTIF),
    true,
  );

  [s] = await api("DELETE", `/api/collections/projects/records/${P2}`, alice);
  check("Alice trashes the PROJECT → 204", s, 204);
  check(
    "the task itself carries no trash marker",
    (await find_by_filter("tasks", `(id='${esc(TT2)}')`, su))[0].trashed,
    "",
  );
  check(
    "surface-exclusion: trashing the PROJECT removes its task notification",
    (await bob_inbox_ids()).includes(TT2_NOTIF),
    false,
  );
  [s] = await api("PATCH", `/api/collections/projects/records/${P2}`, alice, { trashed: "" });
  check("Alice restores the project → 200", s, 200);
  check(
    "restoring the project returns its task notification to the inbox",
    (await bob_inbox_ids()).includes(TT2_NOTIF),
    true,
  );

  // createRule is null and every emitter stamps a task, so the task-less row this
  // empty-relation branch exists for is only constructible by a superuser.
  let taskless: any;
  [s, taskless] = await api("POST", "/api/collections/notifications/records", su, {
    user: bob_id,
    kind: "commented",
  });
  check("superuser writes a task-less notification for Bob → 200", s, 200);
  const TASKLESS = taskless.id;
  check("the row really carries no task", taskless.task, "");
  check(
    "surface-exclusion: a notification with no task still lists",
    (await bob_inbox_ids()).includes(TASKLESS),
    true,
  );

  // ── (9b) the digest cron counts what the inbox lists ────────────────────────
  console.log("\n── (9b) digest cron: the unread count names only listed work ──");
  [s] = await api("DELETE", `/api/collections/tasks/records/${TT}`, alice);
  check("Alice re-trashes the first task → 204", s, 204);
  const hidden = (await find_by_filter("notifications", `(id='${esc(TT_NOTIF)}')`, su))[0];
  check("Bob still holds that notification, unread and now hidden", hidden.read, false);
  check("…and the inbox does not list it", (await bob_inbox_ids()).includes(TT_NOTIF), false);

  // A successful PATCH returns the record body and honours ?expand= no matter what viewRule
  // says, so update/delete carry the read predicate too — otherwise the write path hands back
  // exactly what the read path just refused.
  const [s_hidden_patch, body_hidden] = await api(
    "PATCH",
    `/api/collections/notifications/records/${TT_NOTIF}?expand=task`,
    bob,
    { read: true },
  );
  console.log(`     [probe] PATCH the HIDDEN notification → ${s_hidden_patch}`);
  check("surface-exclusion: PATCH on a hidden notification is denied → 404", s_hidden_patch, 404);
  check("…and the refusal carries no record body", "id" in body_hidden, false);
  check("…nor any expanded task", "expand" in body_hidden, false);
  check(
    "the hidden notification is still unread in the database",
    (await find_by_filter("notifications", `(id='${esc(TT_NOTIF)}')`, su))[0].read,
    false,
  );

  // DELETE must not tell a hidden row apart from one that was never there.
  const [s_hidden_del] = await api(
    "DELETE",
    `/api/collections/notifications/records/${TT_NOTIF}`,
    bob,
  );
  const [s_ghost_del] = await api(
    "DELETE",
    "/api/collections/notifications/records/zzzzzzzzzzzzzzz",
    bob,
  );
  console.log(`     [probe] DELETE hidden → ${s_hidden_del}, DELETE nonexistent → ${s_ghost_del}`);
  check("surface-exclusion: DELETE on a hidden notification is denied", s_hidden_del !== 204, true);
  check("…and is indistinguishable from a nonexistent id", s_hidden_del, s_ghost_del);
  check(
    "the hidden notification still exists (delete refused, not silently applied)",
    (await find_by_filter("notifications", `(id='${esc(TT_NOTIF)}')`, su)).length,
    1,
  );

  // The regression that would matter: a VISIBLE notification is still markable, and it sticks.
  [s] = await api("PATCH", `/api/collections/notifications/records/${TT2_NOTIF}`, bob, {
    read: true,
  });
  check("mark-as-read on a LISTED notification still works → 200", s, 200);
  check(
    "…and the read flag actually stored",
    ((await bob_inbox()).find((x) => x.id === TT2_NOTIF) ?? {}).read,
    true,
  );

  // Restore hands the notification back, and it is markable again afterwards.
  [s] = await api("PATCH", `/api/collections/tasks/records/${TT}`, alice, { trashed: "" });
  check("Alice restores the task once more → 200", s, 200);
  check("the notification is listed again", (await bob_inbox_ids()).includes(TT_NOTIF), true);
  [s] = await api("PATCH", `/api/collections/notifications/records/${TT_NOTIF}`, bob, {
    read: true,
  });
  check("mark-as-read works again after restore → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/notifications/records/${TT_NOTIF}`, bob, {
    read: false,
  });
  check("…and Bob can put it back to unread → 200", s, 200);
  [s] = await api("DELETE", `/api/collections/tasks/records/${TT}`, alice);
  check("Alice trashes it again so the digest has something hidden to skip → 204", s, 204);

  const inbox_unread = (await bob_inbox()).filter((x) => !x.read).length;
  check(
    "Bob's listed-and-unread count is non-zero (the digest has something to say)",
    inbox_unread > 0,
    true,
  );

  sink = await start_sink(MAIL_DIR);
  [s] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "127.0.0.1", port: SINK_PORT, tls: false },
    meta: { senderName: "Task Tracker", senderAddress: "digest@example.com" },
  });
  check("superuser repoints SMTP at the sink → 200", s, 200);
  [s] = await api("POST", "/api/crons/g2-notification-digest", su);
  check("POST /api/crons/g2-notification-digest → 204", s, 204);

  // The cron sends off the request goroutine, so the sink writes after the 204 returns.
  let deadline = Date.now() + 20000;
  let bob_subjects: string[] = [];
  while (Date.now() < deadline) {
    bob_subjects = [];
    for (const fname of fs
      .readdirSync(MAIL_DIR)
      .filter((f) => f.endsWith(".eml"))
      .sort(by_code_point)) {
      const lines = splitlines(read_text(path.join(MAIL_DIR, fname)));
      const to = lines.find((ln) => ln.startsWith("To:")) ?? "";
      if (to.includes("bob@example.com")) {
        bob_subjects.push(...lines.filter((ln) => ln.startsWith("Subject:")));
      }
    }
    if (bob_subjects.length) break;
    await Bun.sleep(300);
  }
  check("exactly one digest email addressed to Bob", bob_subjects.length, 1);
  let digest_count: number | null = null;
  if (bob_subjects.length === 1) {
    digest_count = roomkit.py_int(py_split(py_split(bob_subjects[0]!, "]", 1)[1]!)[0]!);
  }
  console.log(
    `     [probe] Bob digest subject: ${bob_subjects.length ? bob_subjects[0] : "(none)"}`,
  );
  check("digest count matches the inbox", digest_count, inbox_unread);

  // ── (9c) bulk read-all is ONE server-side statement ─────────────────────────
  // COVERS: route:POST /api/tracker/notifications/read-all
  // A client marks the inbox read with ONE `/api/tracker/notifications/read-all` call — a
  // PATCH per row spends the caller's whole /api/ rate-limit budget and half-marks a big inbox.
  console.log("\n── (9c) bulk read-all: one request marks exactly the listed set ──");
  const READ_ALL = "/api/tracker/notifications/read-all";
  const listed_unread = (await bob_inbox()).filter((x) => !x.read).map((x) => x.id);
  check("Bob's listed inbox has unread rows to clear", listed_unread.length > 0, true);
  const alice_unread_before = (
    await find_by_filter("notifications", `(user='${esc(alice_id)}' && read=false)`, su)
  ).length;
  check("Alice holds unread rows of her own", alice_unread_before > 0, true);

  [s] = await api("POST", READ_ALL, null);
  check("read-all refuses an unauthenticated caller → 401", s, 401);
  check(
    "…and nothing was marked read by the refusal",
    (await bob_inbox()).filter((x) => !x.read).length,
    listed_unread.length,
  );

  [s, r] = await api("POST", READ_ALL, bob);
  check("Bob calls read-all ONCE → 200", s, 200);
  check("…and it reports exactly the count his inbox was showing", r.updated, listed_unread.length);
  check(
    "Bob's listed inbox is fully read afterwards",
    (await bob_inbox()).some((x) => !x.read),
    false,
  );
  check(
    "the hidden notification is not in the set it marked, and stays unread",
    tup(
      listed_unread.includes(TT_NOTIF),
      (await find_by_filter("notifications", `(id='${esc(TT_NOTIF)}')`, su))[0].read,
    ),
    tup(false, false),
  );
  check(
    "another user's unread rows are untouched — the route marks only the caller's",
    (await find_by_filter("notifications", `(user='${esc(alice_id)}' && read=false)`, su)).length,
    alice_unread_before,
  );
  [s, r] = await api("POST", READ_ALL, bob);
  check("a second call answers 0 — nothing left listed and unread", tup(s, r.updated), tup(200, 0));
  const read_row = (
    await find_by_filter("notifications", `(id='${esc(listed_unread[0]!)}')`, su)
  )[0];
  check(
    "a row it marked carries a fresh `updated`, so read_at is the moment it was read",
    read_row.updated > read_row.created,
    true,
  );

  // ══════════════════ 10. @MENTION FAN-OUT + COMMENT/STATUS SNAPSHOTS ═════════
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:comments
  console.log("\n── (10) @mention fan-out: resolution, dedupe, replay guard, snapshot fields ──");

  async function make_user(name: string, email: string): Promise<string> {
    const [s, r] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`superuser creates ${name} (${email})`, s, 200);
    return r.id;
  }

  const dave_id = await make_user("Dave", "dave@example.com");
  const erin_id = await make_user("Erin", "erin@example.com");
  let dave_mem: any;
  [s, dave_mem] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: dave_id,
    role: "member",
    status: "active",
  });
  check("Dave joins Alice's workspace as an ACTIVE member", s, 200);
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: erin_id,
    role: "member",
    status: "suspended",
  });
  check("Erin joins Alice's workspace SUSPENDED (not active)", s, 200);

  async function mentioned_rows(task_id: string, user_id: string): Promise<any[]> {
    return find_by_filter(
      "notifications",
      `(task='${esc(task_id)}' && user='${esc(user_id)}' && kind='mentioned')`,
      su,
    );
  }

  async function mentioned_total(task_id: string): Promise<number> {
    return (
      await find_by_filter("notifications", `(task='${esc(task_id)}' && kind='mentioned')`, su)
    ).length;
  }

  let mtask: any;
  [s, mtask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-mention-fixture",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task for the mention probes", s, 200);
  const MT = mtask.id;

  const BODY1 = "hi @bob and @bob again, cc @alice @nobody @carol @erin";
  let c1: any;
  [s, c1] = await api("POST", "/api/collections/comments/records", alice, {
    task: MT,
    author: alice_id,
    body: BODY1,
  });
  check("Alice comments naming @bob twice, herself, an unknown handle, carol and erin", s, 200);
  const C1 = c1.id;
  const bob_mentions = await mentioned_rows(MT, bob_id);
  check("exactly ONE {bob,mentioned} row (named twice, notified once)", bob_mentions.length, 1);
  check(
    "…it links the comment it came from",
    bob_mentions.length ? bob_mentions[0].comment : null,
    C1,
  );
  check(
    "…and snapshots the comment body as the preview",
    bob_mentions.length ? bob_mentions[0].comment_preview : null,
    BODY1,
  );
  check(
    "self-mention: the actor gets no row of her own",
    (await mentioned_rows(MT, alice_id)).length,
    0,
  );
  check(
    "a NON-MEMBER of the workspace (@carol) is not mentionable",
    (await mentioned_rows(MT, carol_id)).length,
    0,
  );
  check(
    "a SUSPENDED member (@erin) is not mentionable",
    (await mentioned_rows(MT, erin_id)).length,
    0,
  );
  check(
    "an unknown handle (@nobody) resolves to nobody — 1 row on the task in total",
    await mentioned_total(MT),
    1,
  );

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: MT,
    author: alice_id,
    body: "mail bob@example.com for the details",
  });
  check("Alice posts a body carrying a bare email address", s, 200);
  check("an @ glued to a word is not a handle — still 1 mention row", await mentioned_total(MT), 1);

  // Replay guard: the members resolved from the pre-e.next() original() body are subtracted.
  [s] = await api("PATCH", `/api/collections/comments/records/${C1}`, alice, { body: BODY1 });
  check("re-saving the SAME comment body → 200", s, 200);
  check("replay wrote no new {bob,mentioned} row", (await mentioned_rows(MT, bob_id)).length, 1);
  const BODY2 = BODY1 + " and @dave too";
  [s] = await api("PATCH", `/api/collections/comments/records/${C1}`, alice, { body: BODY2 });
  check("Alice edits the body to add @dave → 200", s, 200);
  check(
    "exactly ONE {dave,mentioned} row for the newly-named member",
    (await mentioned_rows(MT, dave_id)).length,
    1,
  );
  check(
    "the already-mentioned member gets nothing new",
    (await mentioned_rows(MT, bob_id)).length,
    1,
  );
  check(
    "comment_preview is a SNAPSHOT: the comment now reads BODY2, the preview still BODY1",
    tup(
      (await find_by_filter("comments", `(id='${esc(C1)}')`, su))[0].body,
      (await mentioned_rows(MT, bob_id))[0].comment_preview,
    ),
    tup(BODY2, BODY1),
  );

  // The workspace OWNER is a mention candidate in her own right, not only via a member row.
  const alice_mem = (
    await find_by_filter(
      "workspace_members",
      `(workspace='${esc(ALICE_WS)}' && user='${esc(alice_id)}')`,
      su,
    )
  )[0]?.id;
  check("resolved Alice's self-membership row", truthy(alice_mem), true);
  [s] = await api("DELETE", `/api/collections/workspace_members/records/${alice_mem}`, su);
  check("superuser removes it, leaving Alice as OWNER with no member row → 204", s, 204);
  [s] = await api("POST", "/api/collections/comments/records", bob, {
    task: MT,
    author: bob_id,
    body: "over to you @alice",
  });
  check("Bob comments naming @alice → 200", s, 200);
  check(
    "the workspace owner is mentionable without a member row",
    (await mentioned_rows(MT, alice_id)).length,
    1,
  );
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: alice_id,
    role: "admin",
    status: "active",
  });
  check("superuser restores Alice's self-membership row", s, 200);

  // ── (10b) preview truncation ────────────────────────────────────────────────
  console.log("\n── (10b) comment_preview truncation at 140 characters ──");
  let mtask2: any;
  [s, mtask2] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-mention-preview-fixture",
    project: ALICE_PROJECT,
  });
  check("Alice creates a second mention fixture task", s, 200);
  const MT2 = mtask2.id;
  const LONG_BODY = "@bob " + "x".repeat(200);
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: MT2,
    author: alice_id,
    body: LONG_BODY,
  });
  check("Alice posts a comment body longer than 140 characters", s, 200);
  const long_rows = await mentioned_rows(MT2, bob_id);
  check("the mention row exists", long_rows.length, 1);
  check(
    "comment_preview is exactly 140 characters",
    long_rows.length ? [...long_rows[0].comment_preview].length : null,
    140,
  );
  check(
    "…and it is the first 140 characters of the body",
    long_rows.length ? long_rows[0].comment_preview : null,
    LONG_BODY.slice(0, 140),
  );

  // ── (10c) the other two fan-outs carry their own snapshot fields ────────────
  console.log("\n── (10c) commented carries comment+preview; status_done carries status_label ──");
  let mtask3: any;
  [s, mtask3] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-mention-snapshot-fixture",
    project: ALICE_PROJECT,
  });
  check("Alice creates a third fixture task (she is auto-subscribed)", s, 200);
  const MT3 = mtask3.id;
  const PLAIN = "no handles in this one";
  let c3: any;
  [s, c3] = await api("POST", "/api/collections/comments/records", bob, {
    task: MT3,
    author: bob_id,
    body: PLAIN,
  });
  check("Bob comments on it → 200", s, 200);
  const C3 = c3.id;
  const commented_rows = await find_by_filter(
    "notifications",
    `(task='${esc(MT3)}' && user='${esc(alice_id)}' && kind='commented')`,
    su,
  );
  check("Alice (subscriber) got exactly ONE commented row", commented_rows.length, 1);
  check("…linking the comment", commented_rows.length ? commented_rows[0].comment : null, C3);
  check(
    "…and carrying its preview",
    commented_rows.length ? commented_rows[0].comment_preview : null,
    PLAIN,
  );
  check(
    "…and no status_label (that is the status_done trigger's field)",
    commented_rows.length ? commented_rows[0].status_label : null,
    "",
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${MT3}`, alice, { status: DONE_STATUS });
  check("Alice moves it to 'Done' → 200", s, 200);
  done_rows = await find_by_filter(
    "notifications",
    `(task='${esc(MT3)}' && user='${esc(bob_id)}' && kind='status_done')`,
    su,
  );
  check("Bob (subscriber) got exactly ONE status_done row", done_rows.length, 1);
  check(
    "…carrying the destination status name as status_label",
    done_rows.length ? done_rows[0].status_label : null,
    "Done",
  );

  // ── (10d) the three new fields are locked on update, like user/task/kind ────
  // COVERS: rule:notifications.update
  console.log(
    "\n── (10d) update rule: the recipient cannot rewrite the linkage or the snapshots ──",
  );
  const BOB_MENTION = bob_mentions.length ? bob_mentions[0].id : null;
  check("resolved Bob's mention notification", truthy(BOB_MENTION), true);
  for (const [field, value] of [
    ["comment", C3],
    ["comment_preview", "tampered preview"],
    ["status_label", "tampered label"],
  ] as const) {
    [s] = await api("PATCH", `/api/collections/notifications/records/${BOB_MENTION}`, bob, {
      [field]: value,
    });
    check(`Bob PATCH {${field}} on his own row → 404 (blocked field)`, s, 404);
  }
  const stored = (await find_by_filter("notifications", `(id='${esc(BOB_MENTION)}')`, su))[0];
  check("the stored linkage is untouched", stored.comment, C1);
  check("the stored preview is untouched", stored.comment_preview, BODY1);
  [s] = await api("PATCH", `/api/collections/notifications/records/${BOB_MENTION}`, bob, {
    read: true,
  });
  check("Bob PATCH {read:true} on the same row still → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/notifications/records/${BOB_MENTION}`, bob, {
    snoozed_until: "2030-01-01 00:00:00",
  });
  check("Bob PATCH {snoozed_until} on the same row still → 200", s, 200);

  // ── (10e) a target with no task has no mention fan-out ──────────────────────
  console.log(
    "\n── (10e) document/decision comments name nobody (no task, no subscriber model) ──",
  );
  const all_mentions = (await find_by_filter("notifications", "(kind='mentioned')", su)).length;
  let docrec: any, decrec: any;
  [s, docrec] = await api("POST", "/api/collections/documents/records", alice, {
    title: "G2-mention-doc",
    workspace: ALICE_WS,
  });
  check("Alice creates a document", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    document: docrec.id,
    author: alice_id,
    body: "hi @bob look at this",
  });
  check("Alice comments on the DOCUMENT naming @bob → 200", s, 200);
  [s, decrec] = await api("POST", "/api/collections/decisions/records", alice, {
    title: "G2-mention-decision",
    workspace: ALICE_WS,
  });
  check("Alice creates a decision", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    decision: decrec.id,
    author: alice_id,
    body: "hi @bob and @dave here too",
  });
  check("Alice comments on the DECISION naming @bob and @dave → 200", s, 200);
  check(
    "neither wrote a mention notification",
    (await find_by_filter("notifications", "(kind='mentioned')", su)).length,
    all_mentions,
  );

  // ── (10f) handle grammar: sentence punctuation, case, ambiguity ─────────────
  console.log("\n── (10f) handle grammar: trailing punctuation, case-insensitivity, ambiguity ──");
  const gina_a = await make_user("Gina A", "gina@example.com");
  const gina_b = await make_user("Gina B", "gina@other.example");
  for (const [uid, label] of [
    [gina_a, "gina@example.com"],
    [gina_b, "gina@other.example"],
  ] as const) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: ALICE_WS,
      user: uid,
      role: "member",
      status: "active",
    });
    check(`${label} joins Alice's workspace as an ACTIVE member`, s, 200);
  }

  async function mention_probe(body: string): Promise<string> {
    /** A fresh task per body, so each probe counts only its own fan-out. */
    const [, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title: "G2-handle-grammar",
      project: ALICE_PROJECT,
    });
    await api("POST", "/api/collections/comments/records", alice, {
      task: t.id,
      author: alice_id,
      body,
    });
    return t.id;
  }

  // A trailing period is the commonest form in prose — the token must not swallow it.
  for (const [body, label] of [
    ["thanks @bob.", "sentence-final period"],
    ["see @bob. thanks", "period mid-paragraph"],
    ["@bob...", "ellipsis"],
    ["@bob_ hello", "trailing underscore"],
    ["@bob- hello", "trailing hyphen"],
    ["@bob! nice", "exclamation"],
    ["hi @bob, please", "comma"],
    ["(@bob)", "parenthesized"],
  ] as const) {
    const t = await mention_probe(body);
    check(
      `${label}: ${py_repr(body)} mentions bob exactly once`,
      (await mentioned_rows(t, bob_id)).length,
      1,
    );
  }

  for (const body of ["hi @BOB", "hi @Bob"]) {
    const t = await mention_probe(body);
    check(
      `case-insensitive: ${py_repr(body)} mentions bob exactly once`,
      (await mentioned_rows(t, bob_id)).length,
      1,
    );
  }

  const t_gina = await mention_probe("hi @gina please look");
  check(
    "an AMBIGUOUS handle (two active members share the local part) mentions nobody",
    tup(
      (await mentioned_rows(t_gina, gina_a)).length,
      (await mentioned_rows(t_gina, gina_b)).length,
      await mentioned_total(t_gina),
    ),
    tup(0, 0, 0),
  );

  // ══════════════════ 11. ACCESS-LOSS SURFACE EXCLUSION ═══════════════════════
  // COVERS: rule:notifications.list, rule:notifications.view, cron:g2-notification-digest
  // A task_subscribers row outlives suspension and hard removal, so without the access
  // predicate a departed member keeps receiving comment TEXT in comment_preview.
  console.log("\n── (11) access loss hides the row (and its preview), like trash already does ──");
  const SECRET = "CONFIDENTIAL salary review notes";

  async function inbox_of(token: string): Promise<any[]> {
    const [, r] = await api("GET", "/api/collections/notifications/records?perPage=200", token);
    return r.items || [];
  }

  async function build_access_fixture(
    label: string,
    email: string,
  ): Promise<[string, string, string, string, string | undefined, string | null]> {
    /** A member subscribed to a task, holding one commented row carrying the secret. */
    const uid = await make_user(label, email);
    let [s, mem] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: ALICE_WS,
      user: uid,
      role: "member",
      status: "active",
    });
    check(`${label} joins Alice's workspace ACTIVE`, s, 200);
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `G2-access-${label}`,
      project: ALICE_PROJECT,
    });
    check(`Alice creates a task for ${label}`, s, 200);
    const [tok] = await login(email);
    [s] = await api("POST", "/api/collections/task_subscribers/records", tok, {
      task: t.id,
      user: uid,
    });
    check(`${label} subscribes to it`, s, 200);
    let c: any;
    [s, c] = await api("POST", "/api/collections/comments/records", alice, {
      task: t.id,
      author: alice_id,
      body: SECRET,
    });
    check(`Alice comments the secret; ${label} is fanned out to`, s, 200);
    const rows = await find_by_filter(
      "notifications",
      `(task='${esc(t.id)}' && user='${esc(uid)}')`,
      su,
    );
    check(`${label} holds exactly one notification carrying the preview`, rows.length, 1);
    check(
      `…and the preview really is the comment text (${label})`,
      rows.length ? rows[0].comment_preview : null,
      SECRET,
    );
    return [uid, tok, t.id, c.id, mem.id, rows.length ? rows[0].id : null];
  }

  async function assert_hidden(
    label: string,
    tok: string,
    comment_id: string,
    task_id: string,
    notif_id: string | null,
    task_status = 404,
    rows_left = 1,
  ): Promise<void> {
    const [s_c] = await api("GET", `/api/collections/comments/records/${comment_id}`, tok);
    const [s_t] = await api("GET", `/api/collections/tasks/records/${task_id}`, tok);
    check(`${label} can no longer read the comment → 404`, s_c, 404);
    // Since decision:workspace-trash-cascades (g7kg) tasks.listRule carries the workspace.trashed clause too, so a
    // trashed workspace hides the comment, its preview and the task itself.
    check(`${label} reads the task → ${task_status}`, s_t, task_status);
    const previews = (await inbox_of(tok)).map((x) => x.comment_preview);
    check(`${label}'s inbox no longer carries the comment text`, previews.includes(SECRET), false);
    check(
      `${label}'s notification is not listed`,
      (await inbox_of(tok)).map((x) => x.id).includes(notif_id),
      false,
    );
    const [s_v] = await api("GET", `/api/collections/notifications/records/${notif_id}`, tok);
    check(`${label} fetching it by id → 404`, s_v, 404);
    const [s_u] = await api("PATCH", `/api/collections/notifications/records/${notif_id}`, tok, {
      read: true,
    });
    check(`${label} marking it read → 404`, s_u, 404);
    const [s_d] = await api("DELETE", `/api/collections/notifications/records/${notif_id}`, tok);
    check(`${label} deleting it → not 204`, s_d !== 204, true);
    // Losing ACCESS filters the surface and keeps the row; trashing the WORKSPACE drops it
    // for good (owner ruling 2026-09-07, rdmq — pb_hooks/trash.pb.js), hence rows_left.
    check(
      `rows left in the database for ${label}: ${rows_left}`,
      (await find_by_filter("notifications", `(id='${esc(notif_id!)}')`, su)).length,
      rows_left,
    );
  }

  // (11a) hard-deleted member
  const [dan_id, dan, dan_task, dan_comment, dan_mem, dan_notif] = await build_access_fixture(
    "Dan",
    "dan@example.com",
  );
  [s] = await api("DELETE", `/api/collections/workspace_members/records/${dan_mem}`, su);
  check("superuser hard-deletes Dan's membership row → 204", s, 204);
  check(
    "his subscriber row OUTLIVES the membership (this is why the rule must re-check)",
    (
      await find_by_filter(
        "task_subscribers",
        `(task='${esc(dan_task)}' && user='${esc(dan_id)}')`,
        su,
      )
    ).length,
    1,
  );
  await assert_hidden("Dan (removed)", dan, dan_comment, dan_task, dan_notif);

  // (11b) suspended member
  const [frank_id, frank, frank_task, frank_comment, frank_mem, frank_notif] =
    await build_access_fixture("Frank", "frank@example.com");
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${frank_mem}`, su, {
    status: "suspended",
  });
  check("superuser suspends Frank's membership → 200", s, 200);
  await assert_hidden("Frank (suspended)", frank, frank_comment, frank_task, frank_notif);

  // (11c) trashed workspace — comments.listRule already excludes it, notifications must too
  const zed_id = await make_user("Zed", "zed@example.com");
  let zed_ws: any;
  [s, zed_ws] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "Zed WS",
    owner: alice_id,
  });
  check("superuser creates a second workspace owned by Alice", s, 200);
  const ZWS = zed_ws.id;
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ZWS,
    user: zed_id,
    role: "member",
    status: "active",
  });
  check("Zed joins it ACTIVE", s, 200);
  let ztask: any;
  [s, ztask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-access-zed",
    workspace: ZWS,
  });
  check("Alice creates a project-less task in it", s, 200);
  const ZT = ztask.id;
  const [zed] = await login("zed@example.com");
  [s] = await api("POST", "/api/collections/task_subscribers/records", zed, {
    task: ZT,
    user: zed_id,
  });
  check("Zed subscribes to it", s, 200);
  let zcomment: any;
  [s, zcomment] = await api("POST", "/api/collections/comments/records", alice, {
    task: ZT,
    author: alice_id,
    body: SECRET,
  });
  check("Alice comments the secret there", s, 200);
  const zrows = await find_by_filter(
    "notifications",
    `(task='${esc(ZT)}' && user='${esc(zed_id)}')`,
    su,
  );
  check("Zed holds exactly one notification carrying the preview", zrows.length, 1);
  const ZNOTIF = zrows.length ? zrows[0].id : null;
  [s] = await api("DELETE", `/api/collections/workspaces/records/${ZWS}`, alice);
  check("Alice trashes the WORKSPACE → 204", s, 204);
  check(
    "the task itself carries no trash marker",
    (await find_by_filter("tasks", `(id='${esc(ZT)}')`, su))[0].trashed,
    "",
  );
  await assert_hidden("Zed (workspace trashed)", zed, zcomment.id, ZT, ZNOTIF, 404, 0);

  // (11d) an ACTIVE member is untouched by any of it, and the digest mirrors the rule
  console.log(
    "\n── (11d) an active member keeps everything; the digest counts what the inbox lists ──",
  );
  let gtask: any;
  [s, gtask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-access-active",
    project: ALICE_PROJECT,
  });
  check("Alice creates one more task", s, 200);
  const GT = gtask.id;
  [s] = await api("POST", "/api/collections/task_subscribers/records", bob, {
    task: GT,
    user: bob_id,
  });
  check("Bob (ACTIVE member) subscribes", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: GT,
    author: alice_id,
    body: "still visible to an active member",
  });
  check("Alice comments on it", s, 200);
  const grows = await find_by_filter(
    "notifications",
    `(task='${esc(GT)}' && user='${esc(bob_id)}')`,
    su,
  );
  check("Bob got the notification", grows.length, 1);
  const GNOTIF = grows.length ? grows[0].id : null;
  check("…and his inbox lists it", (await inbox_of(bob)).map((x) => x.id).includes(GNOTIF), true);
  [s] = await api("GET", `/api/collections/notifications/records/${GNOTIF}`, bob);
  check("…and he can fetch it by id → 200", s, 200);
  check(
    "…carrying the preview",
    ((await inbox_of(bob)).find((x) => x.id === GNOTIF) ?? {}).comment_preview,
    "still visible to an active member",
  );

  // The cron GROUP BY must count exactly the rows the inbox lists — including the
  // access predicate, or a departed member is emailed about work they cannot see.
  for (const [tok, name] of [
    [dan, "Dan"],
    [frank, "Frank"],
    [zed, "Zed"],
  ] as const) {
    check(
      `${name}'s listed-and-unread count is 0`,
      (await inbox_of(tok)).filter((x) => !x.read).length,
      0,
    );
  }
  const bob_unread = (await inbox_of(bob)).filter((x) => !x.read).length;
  check("Bob's listed-and-unread count is non-zero", bob_unread > 0, true);
  for (const fname of fs.readdirSync(MAIL_DIR)) {
    fs.rmSync(path.join(MAIL_DIR, fname));
  }
  [s] = await api("POST", "/api/crons/g2-notification-digest", su);
  check("POST /api/crons/g2-notification-digest (second tick) → 204", s, 204);
  const watched = ["bob@example.com", "dan@example.com", "frank@example.com", "zed@example.com"];
  deadline = Date.now() + 20000;
  let digest: Record<string, number | null> = Object.fromEntries(watched.map((w) => [w, null]));
  while (Date.now() < deadline) {
    digest = Object.fromEntries(watched.map((w) => [w, null]));
    for (const fname of fs
      .readdirSync(MAIL_DIR)
      .filter((f) => f.endsWith(".eml"))
      .sort(by_code_point)) {
      const lines = splitlines(read_text(path.join(MAIL_DIR, fname)));
      const to = lines.find((ln) => ln.startsWith("To:")) ?? "";
      const subject = lines.find((ln) => ln.startsWith("Subject:")) ?? "";
      for (const email of watched) {
        if (to.includes(email) && subject) {
          digest[email] = roomkit.py_int(py_split(py_split(subject, "]", 1)[1]!)[0]!);
        }
      }
    }
    if (digest["bob@example.com"] !== null) break;
    await Bun.sleep(300);
  }
  console.log(`     [probe] digest counts for the watched addresses: ${py_repr(digest)}`);
  check(
    "the digest counts Bob exactly what his inbox lists",
    digest["bob@example.com"],
    bob_unread,
  );
  for (const [name, email] of [
    ["Dan", "dan@example.com"],
    ["Frank", "frank@example.com"],
    ["Zed", "zed@example.com"],
  ] as const) {
    check(`${name} gets no digest at all (nothing his inbox lists)`, digest[email], null);
  }

  // ══════════════════ 12. MENTION COLLAPSES THE SUBSCRIBER COPY ═══════════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  console.log("\n── (12) a subscriber who is also mentioned gets ONE row, not two ──");
  let ctask: any;
  [s, ctask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-mention-collapse",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task for the collapse probe", s, 200);
  let CT = ctask.id;
  [s] = await api("POST", "/api/collections/task_subscribers/records", bob, {
    task: CT,
    user: bob_id,
  });
  check("Bob subscribes to it (he is BOTH subscriber and about to be mentioned)", s, 200);
  [s] = await api("POST", "/api/collections/task_subscribers/records", su, {
    task: CT,
    user: dave_id,
  });
  check("Dave subscribes to it too (subscriber only, never named)", s, 200);
  const COLLAPSE_BODY = "@bob please look, cc nobody else";
  let cc: any;
  [s, cc] = await api("POST", "/api/collections/comments/records", alice, {
    task: CT,
    author: alice_id,
    body: COLLAPSE_BODY,
  });
  check("Alice comments naming @bob → 200", s, 200);
  let CC = cc.id;
  const bob_rows = await find_by_filter(
    "notifications",
    `(user='${esc(bob_id)}' && comment='${esc(CC)}')`,
    su,
  );
  check("Bob holds exactly ONE notification for that comment", bob_rows.length, 1);
  check(
    "…and it is the mention, not the subscriber copy",
    bob_rows.length ? bob_rows[0].kind : null,
    "mentioned",
  );
  check(
    "…still carrying the comment preview",
    bob_rows.length ? bob_rows[0].comment_preview : null,
    COLLAPSE_BODY,
  );
  const dave_rows = await find_by_filter(
    "notifications",
    `(user='${esc(dave_id)}' && comment='${esc(CC)}')`,
    su,
  );
  check("Dave (subscriber, not mentioned) still gets his commented row", dave_rows.length, 1);
  check(
    "…and it really is the subscriber copy",
    dave_rows.length ? dave_rows[0].kind : null,
    "commented",
  );

  // ══════════════════ 13. MENTION RESOLUTION AT MEMBER SCALE ══════════════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  // The candidate emails are read in ONE batched id-filtered query, so a member past the
  // first page of any implicit limit must still resolve — hence the last member is named.
  console.log("\n── (13) one batched email lookup: the LAST of 35 members still resolves ──");
  let bws: any;
  [s, bws] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "G2-batch",
    owner: alice_id,
  });
  check("superuser creates a workspace owned by Alice for the scale probe", s, 200);
  const BWS = bws.id;
  const batch_ids: string[] = [];
  const batch_statuses = new Set<number>();
  for (let i = 0; i < 35; i++) {
    let u: any;
    [s, u] = await api("POST", "/api/collections/users/records", su, {
      email: `b1m${String(i).padStart(2, "0")}@example.com`,
      password: "test123456",
      passwordConfirm: "test123456",
      name: `Batch ${String(i).padStart(2, "0")}`,
      verified: true,
      approved: true,
    });
    batch_statuses.add(s);
    batch_ids.push(u.id);
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: BWS,
      user: u.id,
      role: "member",
      status: "active",
    });
    batch_statuses.add(s);
  }
  check("35 users created and joined ACTIVE (every call 200)", batch_statuses, new Set([200]));
  check(
    "the workspace really carries 36 active members: the 35 joined and its owner",
    (await find_by_filter("workspace_members", `(workspace='${esc(BWS)}' && status='active')`, su))
      .length,
    36,
  );
  let btask: any;
  [s, btask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-batch-mention",
    workspace: BWS,
  });
  check("Alice creates a project-less task in it", s, 200);
  const BT = btask.id;
  let bc: any;
  [s, bc] = await api("POST", "/api/collections/comments/records", alice, {
    task: BT,
    author: alice_id,
    body: "ping @b1m34 only",
  });
  check("Alice comments naming the LAST member (@b1m34) → 200", s, 200);
  const BC = bc.id;
  check(
    "exactly ONE mention row on the task, and it belongs to @b1m34",
    tup(
      (await find_by_filter("notifications", `(task='${esc(BT)}' && kind='mentioned')`, su)).length,
      (await mentioned_rows(BT, batch_ids[34]!)).length,
    ),
    tup(1, 1),
  );
  check(
    "the FIRST member (@b1m00) was not notified",
    (await mentioned_rows(BT, batch_ids[0]!)).length,
    0,
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${BC}`, alice, {
    body: "ping @b1m00 instead",
  });
  check("Alice edits the body to name the FIRST member → 200", s, 200);
  check(
    "the edit resolves through the same batched lookup: @b1m00 notified exactly once",
    (await mentioned_rows(BT, batch_ids[0]!)).length,
    1,
  );
  check(
    "…and the earlier mention row is untouched (2 on the task in total)",
    tup((await mentioned_rows(BT, batch_ids[34]!)).length, await mentioned_total(BT)),
    tup(1, 2),
  );

  // ══════════════════ 14. EDIT REPLAY GUARD IS PER-COMMENT, NOT RECOMPUTED ════
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:comments
  // Membership moves under a comment: a handle that resolved to nobody at write time
  // resolves to a member by the time the body is edited, and that edit must notify.
  console.log("\n── (14) edit replay guard: what was already sent, not what would resolve now ──");
  const ivy_id = await make_user("Ivy", "ivy@example.com");
  // decision:invitation-keyed-by-email: a pending invitee holds NO membership row — a pending workspace_invitations
  // row for Ivy's address instead (workspace_members.createRule is null; only R3 mints one).
  let ivy_inv: any;
  [s, ivy_inv] = await api("POST", "/api/collections/workspace_invitations/records", su, {
    workspace: ALICE_WS,
    email: "ivy@example.com",
    role: "member",
  });
  check("Ivy holds a pending invitation to Alice's workspace, no membership yet", s, 200);
  let itask: any;
  [s, itask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-replay-guard",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task for the replay probe", s, 200);
  const IT = itask.id;
  let ic: any;
  [s, ic] = await api("POST", "/api/collections/comments/records", alice, {
    task: IT,
    author: alice_id,
    body: "@ivy hi",
  });
  check("Alice comments naming @ivy while Ivy's invitation is PENDING → 200", s, 200);
  const IC = ic.id;
  check(
    "Ivy is not mentionable yet, so no row was written",
    (await mentioned_rows(IT, ivy_id)).length,
    0,
  );
  // Only the invitee can accept: Ivy's own token, minted by impersonation (no login spent).
  const [, imp] = await api("POST", `/api/collections/users/impersonate/${ivy_id}`, su, {});
  [s] = await api("POST", `/api/tracker/invitations/${ivy_inv.id}/accept`, imp.token);
  check("Ivy accepts her invitation (R3) → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/comments/records/${IC}`, alice, {
    body: "@ivy hi (edited)",
  });
  check("Alice edits the comment body → 200", s, 200);
  check(
    "the edit notifies Ivy, exactly once (she was never notified for this comment)",
    (await mentioned_rows(IT, ivy_id)).length,
    1,
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${IC}`, alice, {
    body: "@ivy hi (edited)",
  });
  check("re-saving that SAME body → 200", s, 200);
  check("…writes nothing new: the guard still holds", (await mentioned_rows(IT, ivy_id)).length, 1);
  [s] = await api("PATCH", `/api/collections/comments/records/${IC}`, alice, {
    body: "@ivy hi (edited 2)",
  });
  check("a FURTHER edit still naming @ivy → 200", s, 200);
  check(
    "…also writes nothing new for the same comment",
    (await mentioned_rows(IT, ivy_id)).length,
    1,
  );
  let ic2: any;
  [s, ic2] = await api("POST", "/api/collections/comments/records", alice, {
    task: IT,
    author: alice_id,
    body: "@ivy again",
  });
  check("a SEPARATE comment naming @ivy → 200", s, 200);
  check(
    "…is its own notification: the guard is per comment, not per task",
    tup(
      (await mentioned_rows(IT, ivy_id)).length,
      (
        await find_by_filter(
          "notifications",
          `(comment='${esc(ic2.id)}' && user='${esc(ivy_id)}' && kind='mentioned')`,
          su,
        )
      ).length,
    ),
    tup(2, 1),
  );

  // ══════════════════ 15. ITEM-PROSE @MENTIONS ════════════════════════════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:documents, hook:notify.pb.js#onRecordCreateRequest:decisions
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:documents, hook:notify.pb.js#onRecordUpdateRequest:decisions
  // No collection but tasks has a `description`: the item's OWN prose is scanned, which is
  // `body` on a document and all three prose fields on a decision (card zr3d).
  console.log("\n── (15) item-prose @mentions: task/document/decision, create and update ──");

  async function prose_rows(rel: string, item_id: string, user_id: string): Promise<any[]> {
    /** Mention rows raised by ITEM PROSE — comment = '' is what tells them from a
     * comment mention on the same item. */
    return find_by_filter(
      "notifications",
      `(${rel}='${esc(item_id)}' && user='${esc(user_id)}' && kind='mentioned' && comment='')`,
      su,
    );
  }

  async function prose_total(rel: string, item_id: string): Promise<number> {
    return (
      await find_by_filter(
        "notifications",
        `(${rel}='${esc(item_id)}' && kind='mentioned' && comment='')`,
        su,
      )
    ).length;
  }

  const hank_id = await make_user("Hank", "hank@example.com");
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: hank_id,
    role: "member",
    status: "active",
  });
  check("Hank joins Alice's workspace as an ACTIVE member", s, 200);

  // ── (15a) a task description names people on CREATE ─────────────────────────
  [s, ptask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-prose-create",
    project: ALICE_PROJECT,
    description: "kick off with @bob, cc @carol @erin @nobody",
  });
  check("Alice creates a task naming bob, a non-member, a suspended member and nobody", s, 200);
  const PT = ptask.id;
  const pt_bob = await prose_rows("task", PT, bob_id);
  check("exactly ONE {bob,mentioned} row from the description on CREATE", pt_bob.length, 1);
  check(
    "…it names the task and carries no comment and no preview",
    pt_bob.length ? tup(pt_bob[0].task, pt_bob[0].comment, pt_bob[0].comment_preview) : null,
    tup(PT, "", ""),
  );
  check(
    "a NON-MEMBER (@carol) is not mentionable from prose",
    (await prose_rows("task", PT, carol_id)).length,
    0,
  );
  check(
    "a SUSPENDED member (@erin) is not mentionable from prose",
    (await prose_rows("task", PT, erin_id)).length,
    0,
  );
  check(
    "an unknown handle names nobody — 1 prose mention on the task",
    await prose_total("task", PT),
    1,
  );

  // ── (15b) …and on UPDATE, with the same replay guard comments carry ─────────
  const BODY_PT = "kick off with @bob and @dave, thanks @alice";
  [s] = await api("PATCH", `/api/collections/tasks/records/${PT}`, alice, {
    description: BODY_PT,
  });
  check("Alice edits the description to add @dave and herself → 200", s, 200);
  check(
    "exactly ONE {dave,mentioned} row for the newly-named member",
    (await prose_rows("task", PT, dave_id)).length,
    1,
  );
  check(
    "the already-named member gets nothing new",
    (await prose_rows("task", PT, bob_id)).length,
    1,
  );
  check(
    "self-mention: the actor gets no row of her own",
    (await prose_rows("task", PT, alice_id)).length,
    0,
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${PT}`, alice, {
    description: BODY_PT,
  });
  check("re-saving the SAME description → 200", s, 200);
  check(
    "replay wrote no new prose mention on that task",
    tup(
      (await prose_rows("task", PT, bob_id)).length,
      (await prose_rows("task", PT, dave_id)).length,
    ),
    tup(1, 1),
  );

  // ── (15c) a document has no `description` — its BODY is the prose ───────────
  let pdoc: any;
  [s, pdoc] = await api("POST", "/api/collections/documents/records", alice, {
    title: "G2-prose-doc",
    workspace: ALICE_WS,
    body: "spec owner @bob",
  });
  check("Alice creates a document whose body names @bob", s, 200);
  const PD = pdoc.id;
  const pd_bob = await prose_rows("document", PD, bob_id);
  check("exactly ONE {bob,mentioned} row from the document body", pd_bob.length, 1);
  check(
    "…it names the document, with no task and no comment",
    pd_bob.length ? tup(pd_bob[0].document, pd_bob[0].task, pd_bob[0].comment) : null,
    tup(PD, "", ""),
  );
  const DOC_NOTIF = pd_bob.length ? pd_bob[0].id : null;
  [s] = await api("PATCH", `/api/collections/documents/records/${PD}`, alice, {
    body: "spec owner @bob, reviewer @dave",
  });
  check("Alice edits the body to add @dave → 200", s, 200);
  check(
    "exactly ONE {dave,mentioned} row for the document",
    (await prose_rows("document", PD, dave_id)).length,
    1,
  );
  check(
    "the already-named member gets nothing new",
    (await prose_rows("document", PD, bob_id)).length,
    1,
  );

  // ── (15d) a decision has THREE prose fields, and all three are scanned ──────
  let pdec: any;
  [s, pdec] = await api("POST", "/api/collections/decisions/records", alice, {
    title: "G2-prose-dec",
    workspace: ALICE_WS,
    context: "@bob raised it",
  });
  check("Alice creates a decision whose CONTEXT names @bob", s, 200);
  const PDEC = pdec.id;
  const pdec_bob = await prose_rows("decision", PDEC, bob_id);
  check("exactly ONE {bob,mentioned} row from the decision context", pdec_bob.length, 1);
  check(
    "…it names the decision, with no task and no comment",
    pdec_bob.length ? tup(pdec_bob[0].decision, pdec_bob[0].task, pdec_bob[0].comment) : null,
    tup(PDEC, "", ""),
  );
  const DEC_NOTIF = pdec_bob.length ? pdec_bob[0].id : null;
  [s] = await api("PATCH", `/api/collections/decisions/records/${PDEC}`, alice, {
    decision: "@dave decides",
  });
  check("Alice writes the DECISION field naming @dave → 200", s, 200);
  check(
    "the decision field is scanned too",
    (await prose_rows("decision", PDEC, dave_id)).length,
    1,
  );
  [s] = await api("PATCH", `/api/collections/decisions/records/${PDEC}`, alice, {
    consequences: "@hank owns the rollout",
  });
  check("Alice writes the CONSEQUENCES field naming @hank → 200", s, 200);
  check(
    "the consequences field is scanned too",
    (await prose_rows("decision", PDEC, hank_id)).length,
    1,
  );

  // ── (15e) a comment mention and a prose mention never suppress each other ───
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: PT,
    author: alice_id,
    body: "ping @bob",
  });
  check("Alice comments naming @bob on the task whose description ALREADY named him", s, 200);
  const pt_bob_all = await find_by_filter(
    "notifications",
    `(task='${esc(PT)}' && user='${esc(bob_id)}' && kind='mentioned')`,
    su,
  );
  check("Bob holds TWO mention rows on that task", pt_bob_all.length, 2);
  check(
    "…exactly one of them is the prose row (the other links the comment)",
    pt_bob_all.filter((r) => !r.comment).length,
    1,
  );
  let xtask: any;
  [s, xtask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-prose-after-comment",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task with NO description", s, 200);
  const XT = xtask.id;
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: XT,
    author: alice_id,
    body: "look @bob",
  });
  check("Alice names @bob in a COMMENT first → 200", s, 200);
  check(
    "the comment mention landed, and it is not a prose row",
    (await prose_rows("task", XT, bob_id)).length,
    0,
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${XT}`, alice, {
    description: "and here too @bob",
  });
  check("Alice then names him in the DESCRIPTION → 200", s, 200);
  check(
    "the earlier comment mention did not suppress the prose one",
    (await prose_rows("task", XT, bob_id)).length,
    1,
  );

  // ── (15f) one write, one row: the mention wins over the same write's fan-out ─
  let ctask2: any;
  [s, ctask2] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-prose-collapse",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task for the collapse probe", s, 200);
  const CT2 = ctask2.id;
  [s] = await api("PATCH", `/api/collections/tasks/records/${CT2}`, alice, {
    assignee: dave_id,
    description: "over to you @dave",
  });
  check("ONE PATCH both reassigns to Dave and names him in the description → 200", s, 200);
  const dave_ct2 = await find_by_filter(
    "notifications",
    `(task='${esc(CT2)}' && user='${esc(dave_id)}')`,
    su,
  );
  check("Dave holds exactly ONE notification for that write", dave_ct2.length, 1);
  check(
    "…and it is the mention, not the assignment",
    dave_ct2.length ? dave_ct2[0].kind : null,
    "mentioned",
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${CT2}`, alice, { assignee: bob_id });
  check("a reassignment that names NOBODY still notifies → 200", s, 200);
  check(
    "Bob, reassigned without being named, gets his assigned row",
    (
      await find_by_filter("notifications", `(task='${esc(CT2)}' && user='${esc(bob_id)}')`, su)
    ).map((r) => r.kind),
    ["assigned"],
  );
  [s] = await api("POST", "/api/collections/task_subscribers/records", su, {
    task: CT2,
    user: hank_id,
  });
  check("Hank subscribes to that task (so a completion would reach him)", s, 200);
  [s] = await api("PATCH", `/api/collections/tasks/records/${CT2}`, alice, {
    status: DONE_STATUS,
    description: "shipping it, thanks @hank",
  });
  check("ONE PATCH both completes the task and names its subscriber → 200", s, 200);
  const hank_ct2 = await find_by_filter(
    "notifications",
    `(task='${esc(CT2)}' && user='${esc(hank_id)}')`,
    su,
  );
  check("Hank holds exactly ONE notification for that write", hank_ct2.length, 1);
  check(
    "…and it is the mention, not the completion",
    hank_ct2.length ? hank_ct2[0].kind : null,
    "mentioned",
  );

  // ── (15f-ii) …but only THIS write's mention: a stale one subtracts nobody ───
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:tasks
  // The subtraction is the rows this write added, not every mention row the task holds:
  // naming somebody once must not mute every later trigger for them, forever.
  async function kinds_on(task_id: string, user_id: string): Promise<string[]> {
    return (
      await find_by_filter(
        "notifications",
        `(task='${esc(task_id)}' && user='${esc(user_id)}')`,
        su,
      )
    )
      .map((r) => r.kind as string)
      .sort(by_code_point);
  }

  let stask: any;
  [s, stask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-stale-mention",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task for the stale-mention probe", s, 200);
  let ST = stask.id;
  [s] = await api("POST", "/api/collections/task_subscribers/records", su, {
    task: ST,
    user: hank_id,
  });
  check("Hank subscribes to it (Dave does not — the assignment will subscribe him)", s, 200);
  [s] = await api("PATCH", `/api/collections/tasks/records/${ST}`, alice, {
    description: "cc @dave and @hank",
  });
  check("Alice names them both in the description, changing nothing else → 200", s, 200);
  check("Dave holds only that mention", await kinds_on(ST, dave_id), ["mentioned"]);
  check("…and so does Hank", await kinds_on(ST, hank_id), ["mentioned"]);
  [s] = await api("PATCH", `/api/collections/tasks/records/${ST}`, alice, { assignee: dave_id });
  check("a LATER write reassigns to Dave, naming nobody → 200", s, 200);
  check("the earlier mention does not mute the assignment", await kinds_on(ST, dave_id), [
    "assigned",
    "mentioned",
  ]);
  check("…nor for the subscriber it also named", await kinds_on(ST, hank_id), [
    "assigned",
    "mentioned",
  ]);
  [s] = await api("PATCH", `/api/collections/tasks/records/${ST}`, alice, { status: DONE_STATUS });
  check("a later write completes the task, naming nobody → 200", s, 200);
  check(
    "…and the completion reaches them both, older mention or not",
    tup(await kinds_on(ST, dave_id), await kinds_on(ST, hank_id)),
    tup(["assigned", "mentioned", "status_done"], ["assigned", "mentioned", "status_done"]),
  );

  // ── (15g) a draft names nobody until it is published ───────────────────────
  let ddoc: any;
  [s, ddoc] = await api("POST", "/api/collections/documents/records", alice, {
    title: "G2-prose-draft",
    workspace: ALICE_WS,
    draft: true,
    body: "early @bob",
  });
  check("Alice creates a DRAFT document naming @bob", s, 200);
  const DD = ddoc.id;
  check(
    "a draft names nobody — its readers cannot open it",
    (await prose_rows("document", DD, bob_id)).length,
    0,
  );
  [s] = await api("PATCH", `/api/collections/documents/records/${DD}`, alice, { draft: false });
  check("Alice publishes it → 200", s, 200);
  check("publishing sends the mention", (await prose_rows("document", DD, bob_id)).length, 1);

  // ── (15h) the read predicate guards the new links exactly like `task` ───────
  check(
    "Bob's inbox lists the document mention",
    (await bob_inbox_ids()).includes(DOC_NOTIF),
    true,
  );
  check("…and the decision mention", (await bob_inbox_ids()).includes(DEC_NOTIF), true);
  [s] = await api("DELETE", `/api/collections/documents/records/${PD}`, alice);
  check("Alice trashes the document → 204", s, 204);
  check(
    "surface-exclusion: the document mention leaves the inbox",
    (await bob_inbox_ids()).includes(DOC_NOTIF),
    false,
  );
  const [s_doc_view] = await api("GET", `/api/collections/notifications/records/${DOC_NOTIF}`, bob);
  check("…and fetching it by id → 404", s_doc_view, 404);
  [s] = await api("PATCH", `/api/collections/documents/records/${PD}`, alice, { trashed: "" });
  check("Alice restores the document → 200", s, 200);
  check(
    "…and the notification returns to the inbox",
    (await bob_inbox_ids()).includes(DOC_NOTIF),
    true,
  );
  [s] = await api("DELETE", `/api/collections/decisions/records/${PDEC}`, alice);
  check("Alice trashes the decision → 204", s, 204);
  check(
    "surface-exclusion: the decision mention leaves the inbox",
    (await bob_inbox_ids()).includes(DEC_NOTIF),
    false,
  );
  [s] = await api("PATCH", `/api/collections/decisions/records/${PDEC}`, alice, { trashed: "" });
  check("Alice restores the decision → 200", s, 200);
  check("…and that notification returns too", (await bob_inbox_ids()).includes(DEC_NOTIF), true);

  // ── (15i) the new relations are producer-written, so update locks them ──────
  const [s_lock_doc] = await api(
    "PATCH",
    `/api/collections/notifications/records/${DOC_NOTIF}`,
    bob,
    { document: PD },
  );
  check("Bob cannot rewrite the document linkage on his own row → 404", s_lock_doc, 404);
  const [s_lock_dec] = await api(
    "PATCH",
    `/api/collections/notifications/records/${DOC_NOTIF}`,
    bob,
    { decision: PDEC },
  );
  check("nor the decision linkage → 404", s_lock_dec, 404);
  const [s_read_ok] = await api(
    "PATCH",
    `/api/collections/notifications/records/${DOC_NOTIF}`,
    bob,
    { read: true },
  );
  check("…while marking that same row read still works → 200", s_read_ok, 200);

  // ── (15j) a workspace trash drops these rows too (rdmq, owner ruling) ───────
  let tws: any;
  [s, tws] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "G2-prose-ws",
    owner: alice_id,
  });
  check("superuser creates a second workspace for the trash probe", s, 200);
  const TWS = tws.id;
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: TWS,
    user: bob_id,
    role: "member",
    status: "active",
  });
  check("Bob joins it as an ACTIVE member", s, 200);
  let twdoc: any;
  [s, twdoc] = await api("POST", "/api/collections/documents/records", alice, {
    title: "G2-prose-ws-doc",
    workspace: TWS,
    body: "over here @bob",
  });
  check("Alice writes a document there naming @bob", s, 200);
  const TWD = twdoc.id;
  check(
    "the mention row exists before the trash",
    (await prose_rows("document", TWD, bob_id)).length,
    1,
  );
  [s] = await api("DELETE", `/api/collections/workspaces/records/${TWS}`, alice);
  check("Alice trashes that workspace → 204", s, 204);
  check(
    "the document mention is DELETED with it, not merely hidden",
    (await prose_rows("document", TWD, bob_id)).length,
    0,
  );

  // ── (15k) the digest count carries the same predicate through the new links ─
  // A trashed item leaves the inbox but keeps its unread row, so a digest predicate that
  // walks only `task` would count these two and name work Bob cannot open.
  [s] = await api("PATCH", `/api/collections/notifications/records/${DOC_NOTIF}`, bob, {
    read: false,
  });
  check("Bob puts the document mention back to unread → 200", s, 200);
  [s] = await api("DELETE", `/api/collections/documents/records/${PD}`, alice);
  check("Alice trashes the document again → 204", s, 204);
  [s] = await api("DELETE", `/api/collections/decisions/records/${PDEC}`, alice);
  check("Alice trashes the decision again → 204", s, 204);
  const hidden_ids = [DOC_NOTIF, DEC_NOTIF];
  const hidden_reads: any[] = [];
  for (const nid of hidden_ids) {
    hidden_reads.push((await find_by_filter("notifications", `(id='${esc(nid)}')`, su))[0].read);
  }
  check("both rows are still unread in the database", hidden_reads, [false, false]);
  const inbox_ids_15 = await bob_inbox_ids();
  check(
    "…and neither is listed",
    hidden_ids.map((nid) => inbox_ids_15.includes(nid)),
    [false, false],
  );
  const bob_unread_15 = (await bob_inbox()).filter((x) => !x.read).length;
  check("Bob's listed-and-unread count is non-zero", bob_unread_15 > 0, true);
  check(
    "…and it includes at least one item-prose mention",
    (await bob_inbox()).some((x) => !x.read && x.kind === "mentioned" && !x.comment),
    true,
  );
  for (const fname of fs.readdirSync(MAIL_DIR)) {
    fs.rmSync(path.join(MAIL_DIR, fname));
  }
  [s] = await api("POST", "/api/crons/g2-notification-digest", su);
  check("POST /api/crons/g2-notification-digest (third tick) → 204", s, 204);
  deadline = Date.now() + 20000;
  let bob_digest_15: number | null = null;
  while (Date.now() < deadline) {
    bob_digest_15 = null;
    for (const fname of fs
      .readdirSync(MAIL_DIR)
      .filter((f) => f.endsWith(".eml"))
      .sort(by_code_point)) {
      const lines = splitlines(read_text(path.join(MAIL_DIR, fname)));
      const to = lines.find((ln) => ln.startsWith("To:")) ?? "";
      const subject = lines.find((ln) => ln.startsWith("Subject:")) ?? "";
      if (to.includes("bob@example.com") && subject) {
        bob_digest_15 = roomkit.py_int(py_split(py_split(subject, "]", 1)[1]!)[0]!);
      }
    }
    if (bob_digest_15 !== null) break;
    await Bun.sleep(300);
  }
  console.log(`     [probe] Bob digest with item-prose rows: ${py_repr(bob_digest_15)}`);
  check("the digest counts Bob exactly what his inbox lists", bob_digest_15, bob_unread_15);
  // PB holds a log entry ~3s before it is queryable, so this polls instead of sleeping.
  deadline = Date.now() + 12000;
  let cron_errors: any[] = [];
  while (Date.now() < deadline) {
    const [, logs] = await api("GET", "/api/logs?perPage=200&sort=-created", su);
    cron_errors = (logs.items || []).filter(
      (x: any) => x.message === "notification digest cron failed",
    );
    if (cron_errors.length) break;
    await Bun.sleep(300);
  }
  check(
    "the digest query raised nothing (a broken predicate logs and sends nobody)",
    cron_errors.length,
    0,
  );

  // ══════════════════ 15.5 MENTION RESOLUTION PAST THE FILTER CAP ═════════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments, hook:notify.pb.js#onRecordUpdateRequest:comments
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:tasks, hook:notify.pb.js#onRecordUpdateRequest:tasks
  // Section 13 sizes the batched lookup where PB's filter parser still accepts an
  // expression per member; this workspace sits past that ceiling, so any site that
  // regrew an id-per-member OR chain resolves nobody here while every smaller probe
  // stays green. All four mention sites read the same workspace.
  console.log("\n── (15.5) all four mention sites resolve past the filter-expression cap ──");
  const CAP_MEMBERS = 200;
  let cws: any;
  [s, cws] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "G2-cap",
    owner: alice_id,
  });
  check("superuser creates a workspace owned by Alice for the cap probe", s, 200);
  const CWS = cws.id;
  // Straight into SQLite: the API path bcrypt-hashes a password per user, and these
  // members exist only to be counted by the mention lookup — none of them ever logs in.
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const cap_ids = Array.from({ length: CAP_MEMBERS }, (_, i) => `g2cap${pad(i, 10)}`);
  const cap_stamp = new Date().toISOString().slice(0, 19).replace("T", " ") + ".000Z";
  const cap_users = Array.from({ length: CAP_MEMBERS }, (_, i) => [
    cap_ids[i]!,
    `g2cap${pad(i, 3)}@example.com`,
    `g2cap${pad(i, 3)}@example.com`,
    `Cap ${pad(i, 3)}`,
    `g2capkey${pad(i, 7)}`,
    cap_stamp,
    cap_stamp,
  ]);
  const cap_members = Array.from({ length: CAP_MEMBERS }, (_, i) => [
    `g2capmem${pad(i, 7)}`,
    CWS,
    cap_ids[i]!,
    "member",
    "active",
    cap_stamp,
    cap_stamp,
  ]);
  const cap_db = sqlite_connect(path.join(DATA_DIR, "data.db"), { timeout: 15 });
  try {
    const insert_users = cap_db.prepare(
      "INSERT INTO users (id, email, email_key, name, tokenKey, created, updated," +
        " password, avatar, emailVisibility, verified, approved)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 0, 1, 1)",
    );
    const insert_members = cap_db.prepare(
      "INSERT INTO workspace_members (id, workspace, [user], role, status, created, updated)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    cap_db.transaction(() => {
      for (const row of cap_users) insert_users.run(...row);
      for (const row of cap_members) insert_members.run(...row);
    })();
  } finally {
    cap_db.close();
  }
  check(
    "every bulk-inserted member is ACTIVE in the workspace beside its owner, and PocketBase sees them",
    (
      await find_by_filter(
        "workspace_members",
        `(workspace='${esc(CWS)}' && status='active')`,
        su,
        500,
      )
    ).length,
    CAP_MEMBERS + 1,
  );
  [s, ctask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-cap-item",
    workspace: CWS,
    description: `kickoff @g2cap${pad(CAP_MEMBERS - 1, 3)} please`,
  });
  check("Alice creates a task there naming the LAST member in its prose → 200", s, 200);
  CT = ctask.id;
  check(
    "ITEM CREATE resolved him: one mention row on the task, and it is his",
    tup(await mentioned_total(CT), (await mentioned_rows(CT, cap_ids.at(-1)!)).length),
    tup(1, 1),
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${CT}`, alice, {
    description: `handing over to @g2cap${pad(CAP_MEMBERS - 2, 3)}`,
  });
  check("Alice edits the task prose to name a second member → 200", s, 200);
  check(
    "ITEM UPDATE resolved her",
    tup(await mentioned_total(CT), (await mentioned_rows(CT, cap_ids.at(-2)!)).length),
    tup(2, 1),
  );
  let ccomment: any;
  [s, ccomment] = await api("POST", "/api/collections/comments/records", alice, {
    task: CT,
    author: alice_id,
    body: `@g2cap${pad(CAP_MEMBERS - 3, 3)} can you review`,
  });
  check("Alice comments on it naming a third member → 200", s, 200);
  CC = ccomment.id;
  check(
    "COMMENT CREATE resolved him",
    tup(await mentioned_total(CT), (await mentioned_rows(CT, cap_ids.at(-3)!)).length),
    tup(3, 1),
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${CC}`, alice, {
    body: `@g2cap${pad(CAP_MEMBERS - 4, 3)} review this instead`,
  });
  check("Alice edits that comment to name a fourth member → 200", s, 200);
  check(
    "COMMENT UPDATE resolved her",
    tup(await mentioned_total(CT), (await mentioned_rows(CT, cap_ids.at(-4)!)).length),
    tup(4, 1),
  );
  check(
    "…and the member no body ever named got nothing from any of the four sites",
    (await mentioned_rows(CT, cap_ids[0]!)).length,
    0,
  );

  // ══════════════════ 16. A FAILING FAN-OUT SAVE IS LOUD, AND PARTIAL ═════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  // SECOND ROOM, same port: its pb_hooks copy makes ONE recipient's notification
  // unsavable (an invalid `kind`), which is what a save failure in production looks
  // like. The comment is already committed by then, so the loss can only be seen in
  // the log and in the recipients who did NOT get their row.
  console.log(
    "\n── (16) one unsavable notification: the comment stands, the rest still fan out ──",
  );
  await stop_sink(sink);
  sink = null;
  await stop_server(server);
  server = null;
  const BOOM_HOOKS = path.join(S, "pb_hooks_boom");
  copy_tree(roomkit.hooks_dir(S), BOOM_HOOKS);
  const BOOM_HOOK_FILE = path.join(BOOM_HOOKS, "notify.pb.js");
  const boom_src = read_text(BOOM_HOOK_FILE);
  // The FIRST row the loop builds is the one that cannot save, whatever order the
  // subscriber rows come back in — so a recipient after it proves the loop carried on.
  const BOOM_ANCHOR =
    '      const _ncol = e.app.findCollectionByNameOrId("notifications");\n' +
    "      for (let i = 0; i < _subs.length; i++) {\n" +
    '        const uid = _subs[i].get("user");\n' +
    "        if (uid === actor || _skip.indexOf(uid) !== -1) continue;\n" +
    "        const n = new Record(_ncol);\n" +
    '        n.set("user", uid);\n' +
    '        n.set("task", taskId);\n' +
    '        n.set("workspace", _ws);\n' +
    '        n.set("kind", "commented");\n' +
    '        n.set("read", false);\n' +
    '        n.set("actor", actor);\n' +
    '        n.set("comment", e.record.id);\n' +
    '        n.set("comment_preview", preview);';
  // An over-long preview (the column caps at 140) fails validation without touching any
  // field the assertions read back.
  const BOOM_INJECT =
    BOOM_ANCHOR.replace(
      "      for (let i = 0;",
      () => "      let _boomDone = false;\n      for (let i = 0;",
    ) +
    '\n        if (String(preview).indexOf("BOOM") !== -1 && !_boomDone) {\n' +
    "          _boomDone = true;\n" +
    '          n.set("comment_preview", "x".repeat(200));\n' +
    "        }";
  // Second planted failure, for §17: the commenter's own auto-subscribe row cannot save. The
  // `const preview` line above it is what makes this the comments-create copy of four identical
  // subscribe-upsert blocks; a relation naming no record is refused by PB the way a real
  // constraint violation would be.
  const SUB_ANCHOR =
    '    const preview = String(e.record.get("body") || "").slice(0, 140);\n' +
    "    // A comment has no workspace of its own; its notifications carry the task one.\n" +
    '    let _ws = "";\n' +
    "    try {\n" +
    '      _ws = e.app.findRecordById("tasks", taskId).get("workspace");\n' +
    "    } catch (_) {}\n" +
    "    // KEEP IN SYNC (subscribe-upsert): idempotent find-first-or-create, backed by the " +
    "(task,user) unique index\n" +
    "    {\n" +
    "      const uid = actor;\n" +
    "      if (uid) {\n" +
    "        try {\n" +
    "          e.app.findFirstRecordByFilter(\n" +
    '            "task_subscribers",\n' +
    '            "task = {:t} && user = {:u}",\n' +
    "            { t: taskId, u: uid },\n" +
    "          );\n" +
    "        } catch (_) {\n" +
    '          const c = e.app.findCollectionByNameOrId("task_subscribers");\n' +
    "          const r = new Record(c);\n" +
    '          r.set("task", taskId);\n' +
    '          r.set("user", uid);';
  const SUB_INJECT =
    SUB_ANCHOR +
    '\n          if (String(preview).indexOf("SUBFAIL") !== -1)\n' +
    '            r.set("task", "nosuchtask0000");';
  check(
    "the commented fan-out site is unambiguous in the hooks copy",
    boom_src.split(BOOM_ANCHOR).length - 1,
    1,
  );
  check(
    "the comments-create subscribe-upsert site is unambiguous in the hooks copy",
    boom_src.split(SUB_ANCHOR).length - 1,
    1,
  );
  fs.writeFileSync(
    BOOM_HOOK_FILE,
    boom_src.replaceAll(BOOM_ANCHOR, () => BOOM_INJECT).replaceAll(SUB_ANCHOR, () => SUB_INJECT),
  );
  const BOOM_DATA = path.join(S, "pb_data_boom");
  fs.mkdirSync(BOOM_DATA, { recursive: true });
  run_checked(
    [
      PB_BIN,
      "superuser",
      "upsert",
      SU_EMAIL,
      SU_PASSWORD,
      "--dir",
      BOOM_DATA,
      "--migrationsDir",
      MIG_DIR,
    ],
    { cwd: REPO_ROOT, capture_output: true },
  );
  server = await start_server(BOOM_DATA, MIG_DIR, BOOM_HOOKS);
  su = await superuser_token();
  const seed2_proc = Bun.spawn([process.execPath, "scripts/seed.ts"], {
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
  const [seed2_out, seed2_err, seed2_rc] = await Promise.all([
    new Response(seed2_proc.stdout).text(),
    new Response(seed2_proc.stderr).text(),
    seed2_proc.exited,
  ]);
  check("second room seeded", seed2_rc, 0);
  if (seed2_rc !== 0) {
    console.log(seed2_out);
    console.log(seed2_err);
    throw new roomkit.SystemExit("second-room seed failed — cannot proceed");
  }
  [alice, alice_id] = await login("alice@example.com");
  [bob, bob_id] = await login("bob@example.com");
  [carol, carol_id] = await login("carol@example.com");
  ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  let ftask: any;
  [s, ftask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-fanout-failure",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task in the second room", s, 200);
  const FT = ftask.id;
  [s] = await api("POST", "/api/collections/task_subscribers/records", bob, {
    task: FT,
    user: bob_id,
  });
  check("Bob subscribes (the first row the loop builds is the unsavable one)", s, 200);
  [s] = await api("POST", "/api/collections/task_subscribers/records", su, {
    task: FT,
    user: carol_id,
  });
  check("Carol subscribes too (whoever comes second must survive the first's failure)", s, 200);
  const FAIL_BODY = "status update BOOM for the fan-out";
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: FT,
    author: alice_id,
    body: FAIL_BODY,
  });
  check("Alice comments while one recipient's notification cannot be saved → 200", s, 200);
  check(
    "the comment itself is committed (the write the user asked for stands)",
    (await find_by_filter("comments", `(task='${esc(FT)}' && body='${esc(FAIL_BODY)}')`, su))
      .length,
    1,
  );
  const fan_rows = await find_by_filter(
    "notifications",
    `(task='${esc(FT)}' && kind='commented')`,
    su,
  );
  check(
    "the recipient AFTER the failure still got her row — one bad row does not kill the fan-out",
    fan_rows.length,
    1,
  );
  check(
    "…and it belongs to one of the two subscribers",
    fan_rows.length ? [bob_id, carol_id].includes(fan_rows[0].user) : null,
    true,
  );
  // PB holds a log entry ~3s before it is queryable, so this polls instead of sleeping.
  deadline = Date.now() + 25000;
  let fanout_errors: any[] = [];
  while (Date.now() < deadline) {
    const [, logs] = await api("GET", "/api/logs?perPage=200&sort=-created", su);
    fanout_errors = (logs.items || []).filter(
      (x: any) => x.message === "notification fan-out save failed",
    );
    if (fanout_errors.length) break;
    await Bun.sleep(300);
  }
  console.log(
    `     [probe] fan-out error log rows: ${py_repr(fanout_errors.map((x) => x.data).slice(0, 2))}`,
  );
  check("the failure is in the log, exactly once", fanout_errors.length, 1);
  const lost = fanout_errors.length ? (fanout_errors[0].data || {}).user : null;
  check(
    "…naming the kind and the recipient it lost — the OTHER subscriber",
    tup(
      fanout_errors.length ? (fanout_errors[0].data || {}).kind : null,
      fanout_errors.length && fan_rows.length
        ? [...new Set([lost, fan_rows[0].user])].sort(by_code_point)
        : null,
    ),
    tup("commented", [bob_id, carol_id].sort(by_code_point)),
  );
  check(
    "…and carrying the underlying error",
    fanout_errors.length
      ? String((fanout_errors[0].data || {}).error ?? "None").includes("comment_preview")
      : null,
    true,
  );

  // ══════════════════ 17. A FAILING AUTO-SUBSCRIBE IS LOUD, NOT FATAL ═════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  // Same boom room: its pb_hooks copy makes the COMMENTER's own auto-subscribe row
  // unsavable. That save runs before the fan-out in the same callback, so unguarded it
  // throws post-commit and every recipient after it is lost while the comment stands.
  console.log("\n── (17) an unsavable auto-subscribe: the fan-out still reaches everyone ──");
  [s, stask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-subscribe-failure",
    project: ALICE_PROJECT,
  });
  check("Alice creates a task (she is auto-subscribed as its creator)", s, 200);
  ST = stask.id;
  [s] = await api("POST", "/api/collections/task_subscribers/records", su, {
    task: ST,
    user: carol_id,
  });
  check("Carol subscribes too — two recipients are owed a notification", s, 200);
  check(
    "Bob is NOT subscribed yet, so his comment must mint his subscription",
    (await find_by_filter("task_subscribers", `(task='${esc(ST)}' && user='${esc(bob_id)}')`, su))
      .length,
    0,
  );
  const SUB_BODY = "SUBFAIL while subscribing the commenter";
  [s] = await api("POST", "/api/collections/comments/records", bob, {
    task: ST,
    author: bob_id,
    body: SUB_BODY,
  });
  check("Bob comments while his own subscribe row cannot be saved → 200", s, 200);
  check(
    "the comment itself is committed (the write the user asked for stands)",
    (await find_by_filter("comments", `(task='${esc(ST)}' && body='${esc(SUB_BODY)}')`, su)).length,
    1,
  );
  check(
    "the subscribe row really did fail — Bob is still not subscribed",
    (await find_by_filter("task_subscribers", `(task='${esc(ST)}' && user='${esc(bob_id)}')`, su))
      .length,
    0,
  );
  const sub_rows = await find_by_filter(
    "notifications",
    `(task='${esc(ST)}' && kind='commented')`,
    su,
  );
  check(
    "BOTH recipients were still notified — one failed subscribe does not kill the fan-out",
    sub_rows.map((x) => x.user as string).sort(by_code_point),
    [alice_id, carol_id].sort(by_code_point),
  );
  // PB holds a log entry ~3s before it is queryable, so this polls instead of sleeping.
  deadline = Date.now() + 25000;
  let sub_errors: any[] = [];
  while (Date.now() < deadline) {
    const [, logs] = await api("GET", "/api/logs?perPage=200&sort=-created", su);
    sub_errors = (logs.items || []).filter((x: any) => x.message === "auto-subscribe save failed");
    if (sub_errors.length) break;
    await Bun.sleep(300);
  }
  console.log(
    `     [probe] auto-subscribe error log rows: ${py_repr(sub_errors.map((x) => x.data).slice(0, 2))}`,
  );
  check("the failure is in the log, exactly once", sub_errors.length, 1);
  check(
    "…naming the task, the user it could not subscribe, and the underlying error",
    tup(
      sub_errors.length ? (sub_errors[0].data || {}).task : null,
      sub_errors.length ? (sub_errors[0].data || {}).user : null,
      sub_errors.length
        ? String((sub_errors[0].data || {}).error ?? "None").includes("task")
        : null,
    ),
    tup(ST, bob_id, true),
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
  console.log("✅ all subscriber/notification proofs passed");
  process.exit(0);
}

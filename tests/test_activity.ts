#!/usr/bin/env bun
/**
 * E2E proof of `task_activity` (audit trail written by pb_hooks/activity.pb.js): one
 * row per changed whitelisted task field per PATCH, no-op/failed-PATCH phantom safety,
 * null CRUD rules (no client writes), member-read scoping, and the trashed-task/trashed-project
 * read exclusion with its restore round trip (card 2yty).
 *
 * Also the programmatic-save path: a DELETE-to-trash sets `trashed` through an `e.app.save()`
 * that fires no *Request hook, so the audit row and the realtime envelope both ride the
 * universal tier. The envelope half is asserted here because trash.pb.js emits its own inline
 * copy of it — the two writers have to stay exactly one.
 *
 * Silence is ambiguous, so the hidden-workspace legs also prove HOW the arms went quiet: a probe
 * hook written into this room's own hooks copy shows the hook chain was handed on, and `_logs`
 * shows nothing threw on the way (card 96a3).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
 * Port 8101 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  by_code_point,
  json_dumps,
  py_repr,
  py_str,
  run_checked,
  truthy,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8101 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

const CHAIN_TOPIC = "probe:delete_chain";
// realtime.pb.js's four delete arms end their hidden-workspace leg with `return e.next()`;
// a bare `return` silences the broadcast exactly as the guard does AND stops the hook chain,
// so only a handler downstream of them can tell the two apart. `priority` is what puts this
// one downstream: pb_hooks FILE load order is not stable per boot (.agents/rules/pocketbase.md),
// so "my file loads last" would be a per-boot race.
const CHAIN_PROBE_HOOK = `/// <reference path="../pb_data/types.d.ts" />
// tests/test_activity.ts's delete-chain probe — written into this room's hooks copy only.
$app.onRecordAfterDeleteSuccess().bind({
  id: "activitySuiteDeleteChainProbe",
  priority: 1000,
  func: (e) => {
    var n = e.record.collection().name;
    if (n === "tasks" || n === "decisions" || n === "documents" || n === "milestones") {
      var msg = new SubscriptionMessage({
        name: "__TOPIC__",
        data: JSON.stringify({ collection: n, id: e.record.id }),
      });
      var clients = e.app.subscriptionsBroker().clients();
      for (var cid in clients) {
        if (clients[cid].hasSubscription("__TOPIC__")) clients[cid].send(msg);
      }
    }
    e.next();
  },
});
`.replaceAll("__TOPIC__", CHAIN_TOPIC);

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
  if (!tok) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

class SSEListener extends roomkit.SSEListener {
  constructor(token: string, topic: string) {
    super(BASE_URL, token, topic);
  }

  updates_for(record_id: string | null): any[] {
    return this.events.filter((e) => e.id === record_id && e.action === "update");
  }

  /**
   * `updates_for` once it has stopped growing — a duplicate envelope arrives on the
   * same socket microseconds after the first, so a bare read cannot see one too many.
   */
  async settled_updates_for(record_id: string | null, want: number): Promise<any[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && this.updates_for(record_id).length < want) {
      await Bun.sleep(100);
    }
    await Bun.sleep(1500);
    return this.updates_for(record_id);
  }
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, HOOKS_DIR);
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
  if (!(await roomkit.wait_for_port_free(PORT))) {
    console.log(`  ⚠️  port ${PORT} still occupied after stopping server`);
  }
}

function days_ago_ts(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) + " 00:00:00.000Z";
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-activity-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

// A copy this suite alone owns — the probe hook below is written INTO it, and under the
// battery roomkit.hooks_dir() hands every self-booting suite ONE shared tree.
const HOOKS_DIR = path.join(S, "hooks");
copy_tree(roomkit.hooks_dir(S), HOOKS_DIR);
fs.writeFileSync(path.join(HOOKS_DIR, "zz_delete_chain_probe.pb.js"), CHAIN_PROBE_HOOK, "utf-8");

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

  const ALICE_WS = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
  const PRIO: Record<string, any> = Object.fromEntries(
    getitem(
      (await api("GET", `/api/collections/workspaces/records/${ALICE_WS}`, alice))[1],
      "priorities",
    ).map((p: any) => [getitem(p, "name"), getitem(p, "id")]),
  );
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("resolved Alice's workspace", truthy(ALICE_WS), true);
  check("resolved Alice's project", truthy(ALICE_PROJECT), true);

  const statuses = await find_by_filter("statuses", `(workspace='${ALICE_WS}')`, alice);
  const STATUS_A = (() => {
    const st = statuses.find((st) => getitem(st, "name") === "Backlog");
    return st ? getitem(st, "id") : null;
  })();
  const STATUS_B = (() => {
    const st = statuses.find((st) => getitem(st, "name") === "In Progress");
    return st ? getitem(st, "id") : null;
  })();
  check("resolved status 'Backlog'", truthy(STATUS_A), true);
  check("resolved status 'In Progress'", truthy(STATUS_B), true);

  async function activity_count(task_id: string | null): Promise<number> {
    return (await find_by_filter("task_activity", `(task='${task_id}')`, su)).length;
  }

  // ══════════════════ (1) create → 0 rows ═════════════════════════════════════
  // COVERS: hook:activity.pb.js#onRecordUpdateRequest:tasks
  console.log("\n── (1) create a task, then PATCH 3 whitelisted + 1 non-whitelisted field ──");
  let task: any;
  [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-activity-fixture",
    project: ALICE_PROJECT,
    status: STATUS_A,
  });
  check("(fixture) Alice creates a task", s, 200);
  const task_id = task.id ?? null;
  check("0 activity rows right after create", await activity_count(task_id), 0);

  [s, r] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
    title: "G2-activity-fixture-v2",
    priority: getitem(PRIO, "high"),
    status: STATUS_B,
    description: "desc change",
  });
  check("PATCH 3 whitelisted + 1 non-whitelisted field", s, 200);

  const rows = await find_by_filter("task_activity", `(task='${task_id}')`, su);
  check("exactly 3 new task_activity rows", rows.length, 3);
  check(
    "every row's actor == Alice",
    rows.every((r) => getitem(r, "actor") === alice_id),
    true,
  );
  check(
    "every row's operator == '' (member edit)",
    rows.every((r) => getitem(r, "operator") === ""),
    true,
  );
  check(
    "row fields == {title,priority,status}",
    rows.map((r) => getitem(r, "field")).sort(by_code_point),
    ["title", "priority", "status"].sort(by_code_point),
  );
  check(
    "no row for 'description' (non-whitelisted)",
    rows.some((r) => getitem(r, "field") === "description"),
    false,
  );

  // ══════════════════ (2) no-op PATCH → 0 new rows ════════════════════════════
  console.log("\n── (2) no-op PATCH (re-send identical values) → 0 new rows ──");
  [s] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
    title: "G2-activity-fixture-v2",
    priority: getitem(PRIO, "high"),
    status: STATUS_B,
  });
  check("no-op PATCH → 200", s, 200);
  check("still exactly 3 rows (no new rows written)", await activity_count(task_id), 3);

  // ══════════════════ (3) validation-failing PATCH → phantom-safe ════════════
  console.log("\n── (3) PATCH with an invalid status id → 400, phantom-safe ──");
  [s] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
    status: "bogus000000000",
  });
  check("invalid status PATCH → 400", s, 400);
  check(
    "still exactly 3 rows (validation failure wrote nothing)",
    await activity_count(task_id),
    3,
  );

  // ══════════════════ (3b) superuser PATCH → operator, not actor ══════════════
  // COVERS: hook:activity.pb.js#onRecordUpdateRequest:tasks
  console.log(
    "\n── (3b) a superuser PATCH stamps operator (the caller's email), leaves actor empty ──",
  );
  const before_su = await activity_count(task_id);
  [s] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, su, {
    priority: getitem(PRIO, "low"),
  });
  check("superuser PATCHes a whitelisted field → 200", s, 200);
  check(
    "exactly 1 new row from the superuser PATCH",
    (await activity_count(task_id)) - before_su,
    1,
  );
  const su_row = (await find_by_filter("task_activity", `(task='${task_id}')`, su)).find(
    (r) =>
      getitem(r, "field") === "priority" && getitem(r, "to") === json_dumps(getitem(PRIO, "low")),
  );
  check("superuser-edit row: actor is empty", getitem(su_row, "actor"), "");
  check(
    "superuser-edit row: operator == the superuser's email",
    getitem(su_row, "operator"),
    SU_EMAIL,
  );

  // ══════════════════ (4) no client writes (null createRule/updateRule/deleteRule) ══
  // COVERS: rule:task_activity.create, rule:task_activity.update, rule:task_activity.delete
  console.log("\n── (4) no client writes: create/update/delete all 403 ──");
  [s] = await api("POST", "/api/collections/task_activity/records", alice, {
    task: task_id,
    field: "title",
    from: '"a"',
    to: '"b"',
  });
  check("Alice POST task_activity → 403 (null createRule)", s, 403);

  const victim_row_id = getitem(rows[0], "id");
  [s] = await api("PATCH", `/api/collections/task_activity/records/${victim_row_id}`, alice, {
    field: "hijacked",
  });
  check("Alice PATCH a task_activity row → 403 (null updateRule)", s, 403);
  [s] = await api("DELETE", `/api/collections/task_activity/records/${victim_row_id}`, alice);
  check("Alice DELETE a task_activity row → 403 (null deleteRule)", s, 403);

  // ══════════════════ (5) member-read scoping ═════════════════════════════════
  // COVERS: rule:task_activity.list, rule:task_activity.view
  console.log("\n── (5) member-read scoping: Bob in, Carol out ──");
  [s, r] = await api(
    "GET",
    `/api/collections/task_activity/records?filter=(task='${task_id}')`,
    bob,
  );
  check("Bob (member) list task_activity → 200", s, 200);
  check("Bob (member) list is non-empty", (r.items ?? []).length > 0, true);
  [s] = await api("GET", `/api/collections/task_activity/records/${victim_row_id}`, bob);
  check("Bob (member) view a row → 200", s, 200);

  [s, r] = await api(
    "GET",
    `/api/collections/task_activity/records?filter=(task='${task_id}')`,
    carol,
  );
  check("Carol (non-member) list task_activity → 200 empty", tup(s, r.items ?? null), tup(200, []));
  [s] = await api("GET", `/api/collections/task_activity/records/${victim_row_id}`, carol);
  check("Carol (non-member) view a row → 404", s, 404);

  // ══════════════════ (6) card 2yty — trashed work hides its own audit trail ══
  // COVERS: rule:task_activity.list, rule:task_activity.view
  // (the trashed predicate half of those rules)
  // A row holds the from/to VALUES of a rename, so an unnarrowed read replayed a trashed
  // task's former and current title while tasks.list already returned nothing for it.
  console.log("\n── (6) trashed task / trashed project: activity excluded, restore returns it ──");

  async function make_renamed_task(title: string, project: string | null): Promise<string | null> {
    const [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title,
      project,
      status: STATUS_A,
    });
    check(`(fixture) task ${title} created`, s, 200);
    const [s2] = await api("PATCH", `/api/collections/tasks/records/${getitem(t, "id")}`, alice, {
      title: title + "-v2",
    });
    check(`(fixture) task ${title} renamed`, s2, 200);
    return getitem(t, "id");
  }

  function bob_rows(task_id_: string | null): Promise<any[]> {
    return find_by_filter("task_activity", `(task='${task_id_}')`, bob);
  }

  function su_rows(task_id_: string | null): Promise<any[]> {
    return find_by_filter("task_activity", `(task='${task_id_}')`, su);
  }

  const victim_task = await make_renamed_task("2yty-victim", ALICE_PROJECT);
  const control_task = await make_renamed_task("2yty-control", ALICE_PROJECT);
  const victim_row = getitem((await su_rows(victim_task))[0], "id");
  const control_row = getitem((await su_rows(control_task))[0], "id");
  check(
    "BEFORE trash: Bob lists the victim task's rows",
    (await bob_rows(victim_task)).length > 0,
    true,
  );
  check(
    "BEFORE trash: Bob views a victim row → 200",
    (await api("GET", `/api/collections/task_activity/records/${victim_row}`, bob))[0],
    200,
  );
  const rename_row = (await su_rows(victim_task)).find((r) => getitem(r, "field") === "title");
  check(
    "BEFORE trash: the row really carries the renamed-away title",
    JSON.parse(getitem(rename_row, "from")) === "2yty-victim",
    true,
  );

  const before_trash = (await su_rows(victim_task)).length;
  [s] = await api("DELETE", `/api/collections/tasks/records/${victim_task}`, bob);
  check("Bob trashes the victim task (DELETE) → 204", s, 204);
  check(
    "WRITE PATH INTACT: the trash transition wrote its own activity row",
    (await su_rows(victim_task)).length,
    before_trash + 1,
  );
  check(
    "…and that row is the `trashed` field change",
    (await su_rows(victim_task)).some((r) => getitem(r, "field") === "trashed"),
    true,
  );
  check(
    "AFTER trash: Bob's list of the victim task's rows is empty",
    await bob_rows(victim_task),
    [],
  );
  check(
    "AFTER trash: Bob views the victim row → 404",
    (await api("GET", `/api/collections/task_activity/records/${victim_row}`, bob))[0],
    404,
  );
  check(
    "AFTER trash: Alice (owner) is excluded too",
    await find_by_filter("task_activity", `(task='${victim_task}')`, alice),
    [],
  );
  check(
    "AFTER trash: the LIVE control task's feed is unaffected",
    (await bob_rows(control_task)).length > 0,
    true,
  );
  check(
    "AFTER trash: Bob still views the control row → 200",
    (await api("GET", `/api/collections/task_activity/records/${control_row}`, bob))[0],
    200,
  );

  [s] = await api("PATCH", `/api/collections/tasks/records/${victim_task}`, bob, { trashed: "" });
  check("Bob restores the victim task (PATCH trashed='') → 200", s, 200);
  check(
    "AFTER restore: Bob lists the victim task's rows again",
    (await bob_rows(victim_task)).length > 0,
    true,
  );
  check(
    "AFTER restore: Bob views the victim row again → 200",
    (await api("GET", `/api/collections/task_activity/records/${victim_row}`, bob))[0],
    200,
  );

  // The project arm of the predicate: a LIVE task under a TRASHED project.
  [s] = await api("DELETE", `/api/collections/projects/records/${ALICE_PROJECT}`, alice);
  check("Alice trashes the project (DELETE) → 204", s, 204);
  check(
    "trashed PROJECT: Bob's list of a live task's rows is empty",
    await bob_rows(control_task),
    [],
  );
  check(
    "trashed PROJECT: Bob views the control row → 404",
    (await api("GET", `/api/collections/task_activity/records/${control_row}`, bob))[0],
    404,
  );
  [s] = await api("PATCH", `/api/collections/projects/records/${ALICE_PROJECT}`, alice, {
    trashed: "",
  });
  check("Alice restores the project → 200", s, 200);
  check(
    "AFTER project restore: Bob lists the live task's rows again",
    (await bob_rows(control_task)).length > 0,
    true,
  );

  // A task created with no project lands in the workspace shadow project (decision:shadow-project), which
  // is never trashed on its own — so this exercises the `task.project.trashed = ""` arm and
  // proves a workspace-level task's trail stays readable.
  let ptask: any;
  [s, ptask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "2yty-projectless",
    workspace: ALICE_WS,
    status: STATUS_A,
  });
  check("(fixture) task created with no project", s, 200);
  await api("PATCH", `/api/collections/tasks/records/${getitem(ptask, "id")}`, alice, {
    title: "2yty-projectless-v2",
  });
  check(
    'shadow-project task: Bob still lists its rows (task.project.trashed = "" arm)',
    (await bob_rows(getitem(ptask, "id"))).length > 0,
    true,
  );

  // ══════════════════ (7) DELETE-to-trash — the programmatic-save path ════════
  // COVERS: hook:activity.pb.js#onRecordUpdate:tasks, hook:realtime.pb.js#onRecordUpdate:tasks
  // A DELETE is intercepted and turned into a `trashed` save by trash.pb.js's own
  // e.app.save(), which fires no *Request hook, yet it owes the `trashed` audit row and exactly
  // ONE realtime envelope, because trash.pb.js emits its own copy inline.
  console.log("\n── (7) DELETE-to-trash writes its audit row, and one envelope ──");
  const sse = new SSEListener(bob, `rt:project_items:${ALICE_WS}`);
  check("(fixture) Bob's realtime client connected", truthy(await sse.start()), true);

  let dtask: any;
  [s, dtask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "delete-arm-fixture",
    project: ALICE_PROJECT,
    status: STATUS_A,
  });
  check("(fixture) Alice creates a task for Bob to delete", s, 200);
  const del_id = dtask.id ?? null;
  check("0 activity rows before the DELETE", (await su_rows(del_id)).length, 0);

  // Bob, not Alice: the row has to name whoever pressed delete, not whoever created the task.
  [s] = await api("DELETE", `/api/collections/tasks/records/${del_id}`, bob);
  check("Bob (member) DELETEs the task → 204 (soft-trash, not a purge)", s, 204);
  let after: any;
  [s, after] = await api("GET", `/api/collections/tasks/records/${del_id}`, su);
  check(
    "(fixture) the DELETE really trashed it rather than purging it",
    tup(s, truthy(after.trashed), after.trashed_by ?? null),
    tup(200, true, bob_id),
  );
  check(
    "the DELETE-to-trash wrote its own activity row, with the deleting member as actor",
    (await su_rows(del_id)).map((r) => tup(getitem(r, "field"), getitem(r, "actor"))),
    [tup("trashed", bob_id)],
  );
  check(
    "…and that row records the transition out of the live state",
    (await su_rows(del_id)).map((r) =>
      tup(getitem(r, "from"), JSON.parse(getitem(r, "to")) === (after.trashed ?? null)),
    ),
    [tup('""', true)],
  );
  let envelopes = await sse.settled_updates_for(del_id, 1);
  check(
    "exactly ONE realtime update envelope for the soft-trash (trash.pb.js owns it)",
    envelopes.length,
    1,
  );
  check(
    "…carrying the deleting member as actor",
    envelopes.map((e) => e.actorId ?? null),
    [bob_id],
  );

  // The other caller of the same class: the cycle-rollover sweep moves a task with a
  // programmatic save too, and nothing but trash.pb.js emits an envelope for it.
  console.log("\n── (7b) the cycle-rollover sweep is the same class of save ──");
  let ended: any;
  [s, ended] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Activity Rollover Cycle",
    starts_on: days_ago_ts(15),
    ends_on: days_ago_ts(1),
  });
  check("(fixture) Alice's workspace ran a cycle that ended yesterday", s, 200);
  let rtask: any;
  [s, rtask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "rollover-arm-fixture",
    project: ALICE_PROJECT,
    status: STATUS_A,
    cycle: ended.id ?? null,
  });
  check("(fixture) an unfinished task on that ended cycle", s, 200);
  const roll_id = rtask.id ?? null;
  check("0 activity rows before the sweep", (await su_rows(roll_id)).length, 0);

  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("superuser triggers the rollover sweep → 200", s, 200);
  let rolled: any;
  [s, rolled] = await api("GET", `/api/collections/tasks/records/${roll_id}`, su);
  check(
    "(fixture) the sweep really moved the task off the ended cycle",
    tup(s, (rolled.cycle ?? null) !== (ended.id ?? null), truthy(rolled.cycle)),
    tup(200, true, true),
  );
  check(
    "the rollover wrote a `cycle` activity row, actorless (the sweep is systemic)",
    (await su_rows(roll_id)).map((r) => tup(getitem(r, "field"), getitem(r, "actor"))),
    [tup("cycle", "")],
  );
  envelopes = await sse.settled_updates_for(roll_id, 1);
  check(
    "…and exactly ONE realtime update envelope, so live clients see the move",
    envelopes.map((e) => tup(envelopes.length, e.actorId ?? null, e.rawChangedFields ?? null)),
    [tup(1, "", ["cycle"])],
  );

  // ══════════════════ (7c) a hidden row is never broadcast ════════════════════
  // A programmatic save reaches rows no API caller could have touched, and the envelope
  // carries the whole record — so the broadcast has to mirror tasks.viewRule's state clause
  // `trashed = "" && (project = "" || project.trashed = "")`. A live task under a TRASHED
  // project is the leak that has no other reader at all: GET /api/tracker/trash filters on
  // the ITEM's own trashed, so it does not list this row either.
  console.log("\n── (7c) a live task under a TRASHED project is not broadcast by the sweep ──");
  let ptrash: any;
  [s, ptrash] = await api("POST", "/api/collections/projects/records", alice, {
    name: "activity-trashed-project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  check("(fixture) Alice creates a second project", s, 200);
  let hidden_task: any;
  [s, hidden_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "hidden-under-a-trashed-project",
    project: ptrash.id ?? null,
    status: STATUS_A,
    cycle: ended.id ?? null,
  });
  check("(fixture) an unfinished task in it, on the cycle that ended", s, 200);
  const hidden_id = hidden_task.id ?? null;
  let ctrl_task: any;
  [s, ctrl_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "visible-under-a-live-project",
    project: ALICE_PROJECT,
    status: STATUS_A,
    cycle: ended.id ?? null,
  });
  check("(fixture) and one in the LIVE project, as the socket's liveness control", s, 200);
  const ctrl_id = ctrl_task.id ?? null;
  [s] = await api("DELETE", `/api/collections/projects/records/${ptrash.id ?? null}`, alice);
  check("(fixture) Alice trashes the second project (DELETE)", s, 204);
  check(
    "(fixture) Bob (member) now 404s that task over HTTP, on both read surfaces",
    tup(
      (await api("GET", `/api/collections/tasks/records/${hidden_id}`, bob))[0],
      (await api("GET", `/api/collections/project_items/records/${hidden_id}`, bob))[0],
    ),
    tup(404, 404),
  );
  const before_hidden = sse.updates_for(hidden_id).length;
  const before_ctrl = sse.updates_for(ctrl_id).length;
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("superuser triggers the sweep, which moves BOTH tasks → 200", s, 200);
  // The control lands first, so its settle window is also the hidden task's.
  check(
    "the LIVE task is broadcast (the socket is up and the sweep did run)",
    (await sse.settled_updates_for(ctrl_id, before_ctrl + 1)).length - before_ctrl,
    1,
  );
  check(
    "the task under the trashed project is NOT broadcast to a member who cannot read it",
    sse.absent_count(sse.updates_for(hidden_id).length - before_hidden),
    0,
  );

  // ══════════════════ (7d) an ALREADY-trashed row is never broadcast ══════════
  console.log("\n── (7d) removing a member does not broadcast their trashed tasks ──");
  let mem: any;
  [s, mem] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: carol_id,
    role: "member",
    status: "active",
  });
  check("(fixture) Alice adds Carol as an active member", s, 200);
  let leaver_task: any;
  [s, leaver_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "trashed-and-assigned",
    project: ALICE_PROJECT,
    assignee: carol_id,
  });
  check("(fixture) a task assigned to Carol", s, 200);
  const leaver_id = leaver_task.id ?? null;
  [s] = await api("DELETE", `/api/collections/tasks/records/${leaver_id}`, alice);
  check("(fixture) Alice trashes it, so it is hidden before the removal", s, 204);
  check(
    "(fixture) Bob 404s it over HTTP",
    (await api("GET", `/api/collections/tasks/records/${leaver_id}`, bob))[0],
    404,
  );
  let live_assigned: any;
  [s, live_assigned] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "live-and-assigned",
    project: ALICE_PROJECT,
    assignee: carol_id,
  });
  check("(fixture) a LIVE task assigned to Carol, the socket's liveness control", s, 200);
  const live_assigned_id = live_assigned.id ?? null;
  const before_leaver = (await sse.settled_updates_for(leaver_id, 1)).length;
  const before_live = (await sse.settled_updates_for(live_assigned_id, 1)).length;
  [s] = await api("DELETE", `/api/collections/workspace_members/records/${mem.id ?? null}`, alice);
  check("(fixture) Alice removes Carol's membership", s, 204);
  let unassigned: any;
  [s, unassigned] = await api("GET", `/api/collections/tasks/records/${leaver_id}`, su);
  check(
    "(fixture) the leaver sweep DID save that trashed task (it cleared the assignee)",
    tup(s, unassigned.assignee ?? null),
    tup(200, ""),
  );
  check(
    "the LIVE task Carol also held IS broadcast (the socket is up and the sweep did run)",
    (await sse.settled_updates_for(live_assigned_id, before_live + 1)).length - before_live,
    1,
  );
  check(
    "…and broadcast nothing for it, because it was hidden on both sides of that save",
    sse.absent_count(
      (await sse.settled_updates_for(leaver_id, before_leaver + 1)).length - before_leaver,
    ),
    0,
  );

  // ══════════════════ (7e) a row CREATED already hidden is never broadcast ════
  // COVERS: hook:realtime.pb.js#onRecordCreateRequest:tasks
  // COVERS: hook:realtime.pb.js#onRecordCreateRequest:decisions
  // COVERS: hook:realtime.pb.js#onRecordCreateRequest:documents
  // COVERS: hook:realtime.pb.js#onRecordCreateRequest:milestones
  // The create envelope carries the whole record, so an item created straight INTO a trashed
  // project would hand every subscriber a row it 404s on both read surfaces. A VIEWER is the
  // tier with the least reach, so it is the one subscribed here.
  console.log("\n── (7e) an item created INTO a trashed project is broadcast to nobody ──");
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: carol_id,
    role: "viewer",
    status: "active",
  });
  check("(fixture) Carol re-added as an ACTIVE VIEWER", s, 200);
  const vsse = new SSEListener(carol, `rt:project_items:${ALICE_WS}`);
  check("(fixture) Carol's (viewer) realtime client connected", truthy(await vsse.start()), true);
  await Bun.sleep(1000); // the authorize POST must land before the first create

  function events_for(listener: SSEListener, record_id: string | null): any[] {
    return listener.events.filter((e) => e.id === record_id);
  }

  /** `events_for` once it has stopped growing (settled_updates_for's contract). */
  async function settled_events_for(
    listener: SSEListener,
    record_id: string | null,
    want: number,
  ): Promise<any[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && events_for(listener, record_id).length < want) {
      await Bun.sleep(100);
    }
    await Bun.sleep(1500);
    return events_for(listener, record_id);
  }

  /** How many delivered envelopes carry `needle` anywhere in their payload. */
  function titles_delivered(listener: SSEListener, needle: string): number {
    return listener.events.filter((e) => json_dumps(e).includes(needle)).length;
  }

  const CREATE_BODIES: [string, string, string][] = [
    ["tasks", "title", "7e-created-hidden-task"],
    ["decisions", "title", "7e-created-hidden-decision"],
    ["documents", "title", "7e-created-hidden-document"],
    ["milestones", "name", "7e-created-hidden-milestone"],
  ];

  function create_body(coll: string, field: string, title: string, project: string | null) {
    // tasks take their workspace from scope.pb.js's backfill; the rest carry it themselves.
    const body: Record<string, any> = { [field]: title, project };
    if (coll === "tasks") {
      body.status = STATUS_A;
    } else {
      body.workspace = ALICE_WS;
    }
    return body;
  }

  const hidden_created: Record<string, any> = {};
  for (const [coll, field, needle] of CREATE_BODIES) {
    let made: any;
    // Only a superuser can still put a row under a trashed project (an API create is refused, card 6nrc).
    [s, made] = await api(
      "POST",
      `/api/collections/${coll}/records`,
      su,
      create_body(coll, field, needle, ptrash.id ?? null),
    );
    check(
      `(fixture) a superuser creates a ${coll.slice(0, -1)} inside the TRASHED project`,
      s,
      200,
    );
    hidden_created[coll] = made.id ?? null;
  }
  const live_created: Record<string, any> = {};
  for (const [coll, field, needle] of CREATE_BODIES) {
    let made: any;
    [s, made] = await api(
      "POST",
      `/api/collections/${coll}/records`,
      alice,
      create_body(coll, field, needle.replace("hidden", "live"), ALICE_PROJECT),
    );
    check(
      `(fixture) …and a ${coll.slice(0, -1)} in the LIVE project, the liveness control`,
      s,
      200,
    );
    live_created[coll] = made.id ?? null;
  }

  for (const [who, listener] of [
    ["Bob (member)", sse],
    ["Carol (viewer)", vsse],
  ] as [string, SSEListener][]) {
    for (const [coll, , needle] of CREATE_BODIES) {
      check(
        `${who} receives the LIVE ${coll.slice(0, -1)}'s create envelope (the socket is up)`,
        (await settled_events_for(listener, live_created[coll], 1)).length,
        1,
      );
      check(
        `${who} receives NOTHING for the ${coll.slice(0, -1)} created in the trashed project`,
        listener.absent_count(events_for(listener, hidden_created[coll]).length),
        0,
      );
      check(
        `…and no envelope of any kind carries the ${coll.slice(0, -1)}'s title bytes`,
        listener.absent_count(titles_delivered(listener, needle)),
        0,
      );
    }
  }
  for (const [coll, rid] of Object.entries(hidden_created)) {
    check(
      `(fixture) Carol (viewer) 404s that ${coll.slice(0, -1)} on both read surfaces`,
      tup(
        (await api("GET", `/api/collections/${coll}/records/${rid}`, carol))[0],
        (await api("GET", `/api/collections/project_items/records/${rid}`, carol))[0],
      ),
      tup(404, 404),
    );
  }

  // ══════════════════ (7f) trash.pb.js's own envelope obeys the same guard ════
  // COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks
  // COVERS: hook:trash.pb.js#onRecordDeleteRequest:decisions
  // COVERS: hook:trash.pb.js#onRecordDeleteRequest:documents
  // COVERS: hook:trash.pb.js#onRecordDeleteRequest:milestones
  // Soft-trashing a row that was ALREADY inside a trashed project is a hidden→hidden move,
  // not a transition — the hide transition of a LIVE row still has to go out, or a client
  // never learns the row left its list.
  console.log(
    "\n── (7f) soft-trashing an ALREADY hidden row broadcasts nothing; a live one does ──",
  );
  const marks: Record<string, number> = {
    "Bob (member)": sse.events.length,
    "Carol (viewer)": vsse.events.length,
  };
  for (const [coll, rid] of Object.entries(hidden_created)) {
    [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
    check(`Alice soft-trashes the hidden ${coll.slice(0, -1)} → 204`, s, 204);
  }
  for (const [coll, rid] of Object.entries(live_created)) {
    [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
    check(`Alice soft-trashes the LIVE ${coll.slice(0, -1)} → 204`, s, 204);
  }
  for (const [who, listener] of [
    ["Bob (member)", sse],
    ["Carol (viewer)", vsse],
  ] as [string, SSEListener][]) {
    for (const [coll, , needle] of CREATE_BODIES) {
      check(
        `${who} receives the LIVE ${coll.slice(0, -1)}'s hide transition (still broadcast)`,
        (await listener.settled_updates_for(live_created[coll], 1)).length,
        1,
      );
      check(
        `${who} receives no trash envelope for the already-hidden ${coll.slice(0, -1)}`,
        listener.absent_count(events_for(listener, hidden_created[coll]).length),
        0,
      );
      check(
        `…and still no envelope carries the hidden ${coll.slice(0, -1)}'s title bytes`,
        listener.absent_count(titles_delivered(listener, needle)),
        0,
      );
    }
    check(
      `${who}'s stream grew ONLY by the four live transitions`,
      listener.events.length - getitem(marks, who),
      4,
    );
  }

  // ══════════════════ (7g) every UPDATE arm obeys the hidden-state guard ══════
  // COVERS: hook:realtime.pb.js#onRecordUpdateRequest:decisions
  // COVERS: hook:realtime.pb.js#onRecordUpdateRequest:documents
  // COVERS: hook:realtime.pb.js#onRecordUpdateRequest:milestones
  // An update envelope carries the whole record too, so renaming a row that is hidden on BOTH
  // sides of the save hands every subscriber a title it 404s. The item updateRule reads
  // neither `trashed` nor the stored `project.trashed` (only a SUBMITTED project, card 2vpm),
  // so the owner can still PATCH such a row in place.
  console.log(
    "\n── (7g) renaming a row hidden on both sides broadcasts nothing; a live one does ──",
  );
  const listeners: [string, SSEListener][] = [
    ["Bob (member)", sse],
    ["Carol (viewer)", vsse],
  ];
  const live_for_update: Record<string, any> = {};
  for (const [coll, field] of CREATE_BODIES) {
    let made: any;
    [s, made] = await api(
      "POST",
      `/api/collections/${coll}/records`,
      alice,
      create_body(coll, field!, `7g-live-${coll}`, ALICE_PROJECT),
    );
    check(`(fixture) a live ${coll.slice(0, -1)} for the update arm`, s, 200);
    live_for_update[coll] = made.id ?? null;
  }
  for (const [who, listener] of listeners) {
    for (const [coll] of CREATE_BODIES) {
      check(
        `(fixture) ${who} saw the live ${coll.slice(0, -1)}'s create envelope`,
        (await settled_events_for(listener, live_for_update[coll], 1)).length,
        1,
      );
    }
  }
  const marks7g: Record<string, { hidden: Record<string, number>; live: Record<string, number> }> =
    Object.fromEntries(
      listeners.map(([who, li]) => [
        who,
        {
          hidden: Object.fromEntries(
            CREATE_BODIES.map(([c]) => [c, events_for(li, hidden_created[c]).length]),
          ),
          live: Object.fromEntries(
            CREATE_BODIES.map(([c]) => [c, events_for(li, live_for_update[c]).length]),
          ),
        },
      ]),
    );
  for (const [coll, field] of CREATE_BODIES) {
    [s] = await api("PATCH", `/api/collections/${coll}/records/${hidden_created[coll]}`, alice, {
      [field]: `7g-hidden-${coll}-renamed`,
    });
    check(
      `Alice renames the HIDDEN ${coll.slice(0, -1)} (updateRule reads no hidden state) → 200`,
      s,
      200,
    );
    [s] = await api("PATCH", `/api/collections/${coll}/records/${live_for_update[coll]}`, alice, {
      [field]: `7g-live-${coll}-renamed`,
    });
    check(`Alice renames the live ${coll.slice(0, -1)} → 200`, s, 200);
  }
  for (const [who, listener] of listeners) {
    for (const [coll] of CREATE_BODIES) {
      const was = getitem(getitem(getitem(marks7g, who), "live"), coll);
      check(
        `${who} receives the live ${coll.slice(0, -1)}'s rename (the socket is up)`,
        (await settled_events_for(listener, live_for_update[coll], was + 1)).length - was,
        1,
      );
      check(
        `${who} receives nothing for the hidden ${coll.slice(0, -1)}'s rename`,
        listener.absent_count(
          events_for(listener, hidden_created[coll]).length -
            getitem(getitem(getitem(marks7g, who), "hidden"), coll),
        ),
        0,
      );
      check(
        `…and no envelope carries the hidden ${coll.slice(0, -1)}'s new title bytes`,
        listener.absent_count(titles_delivered(listener, `7g-hidden-${coll}-renamed`)),
        0,
      );
    }
  }

  // A hide TRANSITION is not a hidden→hidden move — the client has to learn the row left its list.
  const tmarks: Record<string, Record<string, number>> = Object.fromEntries(
    listeners.map(([who, li]) => [
      who,
      Object.fromEntries(
        CREATE_BODIES.map(([c]) => [c, events_for(li, live_for_update[c]).length]),
      ),
    ]),
  );
  for (const [coll] of CREATE_BODIES) {
    [s] = await api("DELETE", `/api/collections/${coll}/records/${live_for_update[coll]}`, alice);
    check(`Alice DELETEs the live ${coll.slice(0, -1)} into the trash → 204`, s, 204);
  }
  for (const [who, listener] of listeners) {
    for (const [coll] of CREATE_BODIES) {
      const was = getitem(getitem(tmarks, who), coll);
      check(
        `${who} still receives the ${coll.slice(0, -1)}'s hide transition`,
        (await settled_events_for(listener, live_for_update[coll], was + 1)).length - was,
        1,
      );
    }
  }

  // ══════════════════ (7h) a TRASHED WORKSPACE hides every row under it ═══════
  // Every item collection's read rules carry `workspace.trashed = ""`, so once the owner
  // trashes a workspace every row under it 404s for every tier — while the arms still carry
  // the whole record. On the purge leg the workspace record is already gone when the cascade
  // reaches its rows, so only the guard's unreadable-workspace branch can catch them.
  console.log(
    "\n── (7h) a trashed workspace: no envelope, no new subscription, unhiding restores ──",
  );

  /** An absence needs a bounded window; the pre-fix run proves this one is long enough. */
  async function settle(): Promise<void> {
    await Bun.sleep(2500);
  }

  /**
   * `_logs` rows from a broadcast arm's catch-and-log. A guard loose enough to let a
   * null workspace reach `.get("owner")` throws INSIDE that catch, which delivers nothing
   * exactly as a working guard does — this row is the only thing that tells them apart.
   */
  async function broadcast_failures(): Promise<number> {
    const qs = urlencode({ filter: 'message ~ "broadcast failed"', perPage: 200 });
    return (await api("GET", `/api/logs?${qs}`, su))[1].totalItems ?? -1;
  }

  /**
   * PocketBase holds each entry ~3s, so an ABSENCE read straight after the leg is empty
   * whatever happened; poll for a sentinel request logged AFTER it instead of sleeping.
   */
  async function logs_caught_up(tag: string): Promise<boolean> {
    await api("GET", `/api/collections/tasks/records/${tag}`, su); // 404 — a logged request error
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const qs = urlencode({ filter: `data.url ~ "${tag}"`, perPage: 1 });
      if (truthy((await api("GET", `/api/logs?${qs}`, su))[1].totalItems)) return true;
      await Bun.sleep(250);
    }
    return false;
  }

  let ws2: any;
  [s, ws2] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "7h Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a second workspace", s, 200);
  const WS2 = ws2.id ?? null;
  let p2: any;
  [s, p2] = await api("POST", "/api/collections/projects/records", alice, {
    name: "7h Project",
    owner: alice_id,
    workspace: WS2,
  });
  check("(fixture) …with a project in it", s, 200);
  const P2 = p2.id ?? null;
  const w2_statuses = await find_by_filter("statuses", `(workspace='${WS2}')`, alice);
  const STATUS_W2 = w2_statuses.length ? getitem(w2_statuses[0], "id") : null;
  check("(fixture) the new workspace seeded its own statuses", truthy(STATUS_W2), true);
  for (const [uid, role] of [
    [bob_id, "member"],
    [carol_id, "viewer"],
  ] as [string, string][]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS2,
      user: uid,
      role,
      status: "active",
    });
    check(`(fixture) an active ${role} on the second workspace`, s, 200);
  }

  function w2_body(coll: string, field: string, title: string) {
    // tasks take their workspace from scope.pb.js's backfill; the rest carry it themselves.
    const body: Record<string, any> = { [field]: title, project: P2 };
    if (coll === "tasks") {
      body.status = STATUS_W2;
    } else {
      body.workspace = WS2;
    }
    return body;
  }

  const w2_items: Record<string, any> = {};
  for (const [coll, field] of CREATE_BODIES) {
    let made: any;
    [s, made] = await api(
      "POST",
      `/api/collections/${coll}/records`,
      alice,
      w2_body(coll, field!, `7h-live-${coll}`),
    );
    check(`(fixture) a live ${coll.slice(0, -1)} under the second workspace`, s, 200);
    w2_items[coll] = made.id ?? null;
  }
  // tasks.milestone is the one relation under a workspace that does NOT cascade-delete, so
  // the purge SAVES this task mid-cascade (milestone -> "") while the membership rows still
  // exist. Without the link nothing reaches the update arm and the purge rows cannot go red.
  [s] = await api("PATCH", `/api/collections/tasks/records/${w2_items.tasks}`, alice, {
    milestone: w2_items.milestones,
  });
  check("(fixture) the task is linked to the milestone (a non-cascading relation)", s, 200);
  const bob2 = new SSEListener(bob, `rt:project_items:${WS2}`);
  const carol2 = new SSEListener(carol, `rt:project_items:${WS2}`);
  // A purge cascade deletes the membership rows too, so a member's delivery check fails on
  // its own; only a superuser subscriber stays authorized long enough to catch that leak.
  const su2 = new SSEListener(su, `rt:project_items:${WS2}`);
  check(
    "(fixture) Bob's client on the second workspace connected",
    truthy(await bob2.start()),
    true,
  );
  check(
    "(fixture) Carol's client on the second workspace connected",
    truthy(await carol2.start()),
    true,
  );
  check(
    "(fixture) a superuser client on the second workspace connected",
    truthy(await su2.start()),
    true,
  );
  await Bun.sleep(1000); // the authorize POST must land before the first event
  const w2_listeners: [string, SSEListener][] = [
    ["Bob (member)", bob2],
    ["Carol (viewer)", carol2],
    ["a superuser", su2],
  ];

  for (const [coll, field] of CREATE_BODIES) {
    [s] = await api("PATCH", `/api/collections/${coll}/records/${w2_items[coll]}`, alice, {
      [field]: `7h-live-${coll}-touched`,
    });
    check(`Alice renames the ${coll.slice(0, -1)} while the workspace is LIVE → 200`, s, 200);
  }
  for (const [who, listener] of w2_listeners) {
    for (const [coll] of CREATE_BODIES) {
      check(
        `${who} receives it (a subscription on a live workspace delivers)`,
        (await settled_events_for(listener, w2_items[coll], 1)).length,
        1,
      );
    }
  }

  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS2}`, alice);
  check("Alice (owner) DELETEs the second workspace → 204 (soft-trash)", s, 204);
  check(
    "(fixture) the workspace really carries a trashed stamp",
    truthy((await api("GET", `/api/collections/workspaces/records/${WS2}`, su))[1].trashed),
    true,
  );
  check(
    "(fixture) Bob now 404s a row under it on both read surfaces",
    tup(
      (await api("GET", `/api/collections/tasks/records/${w2_items.tasks}`, bob))[0],
      (await api("GET", `/api/collections/project_items/records/${w2_items.tasks}`, bob))[0],
    ),
    tup(404, 404),
  );
  check(
    "(fixture) even the owner cannot PATCH it now, so the update leg needs a superuser",
    (
      await api("PATCH", `/api/collections/tasks/records/${w2_items.tasks}`, alice, {
        title: "x",
      })
    )[0],
    404,
  );

  const w2_marks: Record<string, Record<string, number>> = Object.fromEntries(
    w2_listeners.map(([who, li]) => [
      who,
      Object.fromEntries(CREATE_BODIES.map(([c]) => [c, events_for(li, w2_items[c]).length])),
    ]),
  );
  for (const [coll, field] of CREATE_BODIES) {
    [s] = await api("PATCH", `/api/collections/${coll}/records/${w2_items[coll]}`, su, {
      [field]: `7h-trashed-ws-${coll}-renamed`,
    });
    check(`a superuser PATCHes the ${coll.slice(0, -1)} under the trashed workspace → 200`, s, 200);
  }
  await settle();
  for (const [who, listener] of w2_listeners) {
    for (const [coll] of CREATE_BODIES) {
      check(
        `${who} receives nothing for the ${coll.slice(0, -1)} under the trashed workspace`,
        listener.absent_count(
          events_for(listener, w2_items[coll]).length - getitem(getitem(w2_marks, who), coll),
        ),
        0,
      );
      check(
        `…and no envelope carries that ${coll.slice(0, -1)}'s title bytes`,
        listener.absent_count(titles_delivered(listener, `7h-trashed-ws-${coll}-renamed`)),
        0,
      );
    }
  }

  // The subscribe guard is only observable on the stream: PB answers the authorize POST 204
  // whether the topic survived the guard or not.
  // COVERS: hook:realtime.pb.js#onRealtimeSubscribeRequest
  const bob_late = new SSEListener(bob, `rt:project_items:${WS2}`);
  check(
    "(fixture) Bob opens a SECOND client, subscribing while the workspace is trashed",
    truthy(await bob_late.start()),
    true,
  );
  await Bun.sleep(1000);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS2}`, alice, { trashed: "" });
  check("Alice restores the workspace (PATCH trashed='') → 200", s, 200);
  const carol_late = new SSEListener(carol, `rt:project_items:${WS2}`);
  check("(fixture) Carol opens a client AFTER the restore", truthy(await carol_late.start()), true);
  await Bun.sleep(1000);
  // Every item collection carries the same `workspace.trashed = ""` read clause, so the
  // restore has to reopen the feed for all four — one PATCH each, then ONE settle: a
  // per-check poll would idle the pre-trash sockets past the 60s their read tolerates.
  const restore_marks: Record<string, Record<string, number>> = Object.fromEntries(
    w2_listeners.map(([who, li]) => [
      who,
      Object.fromEntries(CREATE_BODIES.map(([c]) => [c, events_for(li, w2_items[c]).length])),
    ]),
  );
  for (const [coll, field] of CREATE_BODIES) {
    [s] = await api("PATCH", `/api/collections/${coll}/records/${w2_items[coll]}`, alice, {
      [field]: `7h-after-restore-${coll}`,
    });
    check(`Alice renames the ${coll.slice(0, -1)} after the restore → 200`, s, 200);
  }
  await settle();
  for (const [who, listener] of w2_listeners) {
    for (const [coll] of CREATE_BODIES) {
      const was = getitem(getitem(restore_marks, who), coll);
      check(
        `${who}'s pre-trash subscription delivers the ${coll.slice(0, -1)} again ` +
          `(unhiding restores the feed)`,
        events_for(listener, w2_items[coll]).length - was,
        1,
      );
    }
  }
  for (const [coll] of CREATE_BODIES) {
    check(
      `a client that subscribed AFTER the restore receives the ${coll.slice(0, -1)} ` +
        `(a fresh subscribe is kept)`,
      events_for(carol_late, w2_items[coll]).length,
      1,
    );
    check(
      `the client that subscribed WHILE it was trashed receives no ${coll.slice(0, -1)} ` +
        `(guard dropped it)`,
      bob_late.absent_count(events_for(bob_late, w2_items[coll]).length),
      0,
    );
  }
  check("…and no envelope of any kind reached that client", bob_late.absent_count(), 0);

  console.log(
    "\n── (7h purge) purging the trashed workspace saves its rows; none may be broadcast ──",
  );
  // Opened HERE, not with the w2 listeners: it watches the probe hook's topic, whose only
  // traffic is the purge below.
  const chain = new SSEListener(su, CHAIN_TOPIC); // the probe hook's own topic, not an item topic
  check("(fixture) the delete-chain probe's client connected", truthy(await chain.start()), true);
  await Bun.sleep(1000);
  const purge_needle: Record<string, string> = Object.fromEntries(
    CREATE_BODIES.map(([c]) => [c, `7h-after-restore-${c}`]),
  );
  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS2}`, alice);
  check("Alice re-trashes the workspace → 204", s, 204);
  const purge_marks: Record<string, Record<string, number>> = Object.fromEntries(
    w2_listeners.map(([who, li]) => [
      who,
      Object.fromEntries(CREATE_BODIES.map(([c]) => [c, events_for(li, w2_items[c]).length])),
    ]),
  );
  const purge_bytes: Record<string, Record<string, number>> = Object.fromEntries(
    w2_listeners.map(([who, li]) => [
      who,
      Object.fromEntries(CREATE_BODIES.map(([c]) => [c, titles_delivered(li, purge_needle[c]!)])),
    ]),
  );
  const purge_len: Record<string, number> = Object.fromEntries(
    w2_listeners.map(([who, li]) => [who, li.events.length]),
  );
  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS2}`, alice);
  check("Alice DELETEs it a second time → 204 (purge)", s, 204);
  check(
    "(fixture) the workspace record is gone",
    (await api("GET", `/api/collections/workspaces/records/${WS2}`, su))[0],
    404,
  );
  await settle();
  for (const [who, listener] of w2_listeners) {
    console.log(
      `  ℹ️  ${who} envelopes after the purge: ` +
        py_repr(
          listener.events
            .slice(getitem(purge_len, who))
            .map((e) => tup(e.collection ?? null, e.action ?? null)),
        ),
    );
    for (const [coll] of CREATE_BODIES) {
      check(
        `${who} receives no envelope for the ${coll.slice(0, -1)} when the workspace is purged`,
        listener.absent_count(
          events_for(listener, w2_items[coll]).length - getitem(getitem(purge_marks, who), coll),
        ),
        0,
      );
      check(
        `…and no new envelope carries that ${coll.slice(0, -1)}'s title bytes`,
        listener.absent_count(
          titles_delivered(listener, getitem(purge_needle, coll)) -
            getitem(getitem(purge_bytes, who), coll),
        ),
        0,
      );
    }
  }
  // Silence alone cannot tell a guard from a stopped hook chain: a bare `return` in place of
  // each arm's `return e.next()` suppresses the envelope too. `settle()` above is the same
  // window the absence rows just used, so this reads what already arrived.
  for (const [coll] of CREATE_BODIES) {
    check(
      `the ${coll.slice(0, -1)}'s delete arm handed the hook chain on past its guard`,
      events_for(chain, w2_items[coll]).length,
      1,
    );
  }

  // The delete arm still has to broadcast a purge under a LIVE workspace, or the assertions
  // above would pass on a broadcast that never happens for any purge at all.
  console.log("\n── (7h control) a purge under a LIVE workspace is still broadcast ──");
  for (const [coll] of CREATE_BODIES) {
    const rid = live_for_update[coll];
    const was = events_for(sse, rid).length;
    [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
    check(`Alice purges the trashed ${coll.slice(0, -1)} (second DELETE) → 204`, s, 204);
    check(
      `Bob (member) receives the ${coll.slice(0, -1)}'s purge envelope`,
      (await settled_events_for(sse, rid, was + 1)).length - was,
      1,
    );
  }

  // ══════════════════ (7i) the quiet arms went quiet WITHOUT throwing ═════════
  // A guard loose enough to deref a null workspace throws inside the arm's own catch, and
  // every absence row above passes on that just as it does on a working guard. Last, because
  // this is the only check whose window has to outlast the ~3s PocketBase holds a log entry.
  console.log("\n── (7i) no arm reached its catch-and-log on any hidden-workspace leg ──");
  check(
    "(log flush) a sentinel request logged after the last leg is queryable",
    await logs_caught_up("logflushsentinel"),
    true,
  );
  check("no 'broadcast failed' row for the whole run", await broadcast_failures(), 0);
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all task_activity proofs passed");
  process.exit(0);
}

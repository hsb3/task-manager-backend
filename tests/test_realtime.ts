#!/usr/bin/env bun
/**E2E proof of pb_hooks/realtime.pb.js: the normalized realtime event feed (TASK-008.08).

Each create/update/purge of an item collection (tasks/decisions/documents/milestones)
broadcasts a raw envelope {collection,id,action,actorId,rawChangedFields,rawRecord} on the
PER-WORKSPACE topic `rt:project_items:{workspaceId}` to that workspace's subscribers. A
client reshapes the envelope into its own event type. This suite proves the emit side on the wire.

Tenant isolation (the reason the topic is workspace-scoped + guarded by
onRealtimeSubscribeRequest): a NON-MEMBER who tries to subscribe to another workspace's topic
receives ZERO events for that workspace's activity.

Trash coverage (TASK-122): the first DELETE soft-trashes via a programmatic save that
bypasses the request-hook broadcast tier, so trash.pb.js emits the update envelope inline —
this suite proves that event reaches a second subscribed client for all four collections,
and that restore (PATCH trashed="") still broadcasts via the normal update path.

Purge coverage: the two REAL production purge paths (the daily trash-purge cron and the
POST /api/tracker/trash/purge route, trash.pb.js) call app.delete() PROGRAMMATICALLY, which
does NOT fire onRecordDeleteRequest — so the delete broadcast rides onRecordAfterDeleteSuccess
(fires for both HTTP purges and programmatic deletes). This suite drives the manual purge
route and asserts a delete event fires. actor on a purge is "" (unresolvable in After*Success;
cron is systemic, the route is superuser).

Revocation coverage (PBTT-462): membership is re-checked at DELIVERY, not only at subscribe, so
suspending a member mid-stream stops that stream at once while an active member and the workspace
owner on the same topic keep receiving.

Draft privacy (PBTT-543): a DRAFT decision/document/milestone is delivered only to its author,
the workspace owner and ACTIVE admins — the same predicate those collections' viewRule carries.
Tasks have no draft concept, so a task broadcast always reaches every member. The
trash-SET envelope inlined in trash.pb.js carries the same branch and is proven here on the same
socket, since a soft-trash DELETE is the one broadcast that never rides this file's hooks.

Presence is deliberately NOT covered — decision-007 rules it OUT of v1 (parked DRAFT-015).

Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
Port 8107 + PB_PORT_OFFSET — the 8100+ suite self-boot band (CLAUDE.md).
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_repr,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8107 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(60)} → ${py_repr(got)}` +
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
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

function esc(value: string): string {
  return value.replaceAll("'", "\\'");
}

async function find_by_filter(
  collection: string,
  filt: string,
  token: string | null,
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
  token: string | null,
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
  return getitem(r, "token");
}

const SSEListener = (token: string, topic: string): roomkit.SSEListener =>
  new roomkit.SSEListener(BASE_URL, token, topic);

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-realtime-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
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
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));

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
    console.log(seed_out, seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const su = await superuser_token();
  const [alice, alice_id] = await login("alice@example.com");
  const [carol, carol_id] = await login("carol@example.com"); // NON-member of Alice's workspace
  const WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const PRIO: Record<string, string> = {};
  for (const p of getitem(
    (await api("GET", `/api/collections/workspaces/records/${WS}`, alice))[1],
    "priorities",
  )) {
    PRIO[getitem(p, "name")] = getitem(p, "id");
  }
  const PROJ = await find_id("projects", "name", "Website Redesign", alice);
  const statuses = await find_by_filter("statuses", `(workspace='${WS}')`, alice);
  const ST_A = statuses.find((s) => getitem(s, "name") === "Backlog")?.id ?? null;
  const ST_B = statuses.find((s) => getitem(s, "name") === "In Progress")?.id ?? null;
  check(
    "resolved workspace/project/statuses",
    [WS, PROJ, ST_A, ST_B].every((v) => truthy(v)),
    true,
  );

  const TOPIC = `rt:project_items:${WS}`;
  // Alice (owner/member) subscribes to her workspace's topic — should receive events.
  const alice_sse = SSEListener(alice, TOPIC);
  // Carol (NON-member) attempts to subscribe to ALICE's workspace topic — the
  // onRealtimeSubscribeRequest guard must drop it, so she receives ZERO events.
  // COVERS: hook:realtime.pb.js#onRealtimeSubscribeRequest
  const carol_sse = SSEListener(carol, TOPIC);
  if (!(await alice_sse.start())) throw new Error("Alice SSE never received a clientId");
  if (!(await carol_sse.start())) throw new Error("Carol SSE never received a clientId");
  await Bun.sleep(1000); // let both authorize POSTs land before the first write

  const creates: Record<string, any> = {
    tasks: { title: "RT task", project: PROJ, status: ST_A },
    decisions: { title: "RT decision", project: PROJ, workspace: WS, status: "proposed" },
    documents: { title: "RT doc", project: PROJ, workspace: WS, body: "hello" },
    milestones: { name: "RT milestone", project: PROJ, workspace: WS },
  };
  const ids: Record<string, any> = {};
  let s: number, rec: any, evs: any[], e: any;

  // ══════════════ CREATE → broadcast with actor + all fields + record ══════════════
  // COVERS: hook:realtime.pb.js#onRecordCreateRequest:tasks, hook:realtime.pb.js#onRecordCreateRequest:decisions
  // COVERS: hook:realtime.pb.js#onRecordCreateRequest:documents, hook:realtime.pb.js#onRecordCreateRequest:milestones
  console.log(
    "\n── CREATE: each item broadcasts {actor, all-fields changed, record} on the ws topic ──",
  );
  for (const [coll, body] of Object.entries(creates)) {
    [s, rec] = await api("POST", `/api/collections/${coll}/records`, alice, body);
    check(`${coll}: create → 200`, s, 200);
    ids[coll] = rec.id ?? null;
  }
  await Bun.sleep(1500);
  for (const coll of Object.keys(creates)) {
    evs = alice_sse.of(coll, "create");
    check(`${coll}: create broadcast received (member)`, evs.length >= 1, true);
    if (evs.length) {
      e = evs[evs.length - 1];
      check(`${coll}: create actorId == Alice`, e.actorId ?? null, alice_id);
      check(
        `${coll}: create rawRecord.id matches`,
        (e.rawRecord ?? {}).id ?? null,
        getitem(ids, coll),
      );
      check(`${coll}: create rawRecord.workspace == WS`, (e.rawRecord ?? {}).workspace ?? null, WS);
      check(
        `${coll}: create rawChangedFields non-empty (all fields)`,
        (e.rawChangedFields ?? []).length > 0,
        true,
      );
    }
  }

  // ══════════════ UPDATE → broadcast with actor + diffed changed fields ══════════════
  // COVERS: hook:realtime.pb.js#onRecordUpdateRequest:tasks, hook:realtime.pb.js#onRecordUpdateRequest:decisions
  // COVERS: hook:realtime.pb.js#onRecordUpdateRequest:documents, hook:realtime.pb.js#onRecordUpdateRequest:milestones
  console.log("\n── UPDATE: broadcast carries the exact diffed raw fields ──");
  const updates: Record<string, any> = {
    tasks: { status: ST_B, priority: getitem(PRIO, "high") },
    decisions: { status: "accepted" },
    documents: { body: "world" },
    milestones: { name: "RT milestone v2" },
  };
  const expect_changed: Record<string, Set<string>> = {
    tasks: new Set(["status", "priority"]),
    decisions: new Set(["status"]),
    documents: new Set(["body"]),
    milestones: new Set(["name"]),
  };
  for (const [coll, patch] of Object.entries(updates)) {
    [s] = await api(
      "PATCH",
      `/api/collections/${coll}/records/${getitem(ids, coll)}`,
      alice,
      patch,
    );
    check(`${coll}: update → 200`, s, 200);
  }
  await Bun.sleep(1500);
  for (const coll of Object.keys(updates)) {
    evs = alice_sse.of(coll, "update");
    check(`${coll}: update broadcast received`, evs.length >= 1, true);
    if (evs.length) {
      e = evs[evs.length - 1];
      check(`${coll}: update actorId == Alice`, e.actorId ?? null, alice_id);
      check(
        `${coll}: update rawChangedFields == ${py_repr([...getitem(expect_changed, coll)].sort(by_code_point))}`,
        new Set(e.rawChangedFields ?? []),
        getitem(expect_changed, coll),
      );
    }
  }

  // ══════════════ TENANT ISOLATION: non-member sees NOTHING ══════════════
  console.log("\n── TENANT ISOLATION: Carol (non-member) subscribed to Alice's ws topic ──");
  check(
    "Carol (non-member) received ZERO events for Alice's workspace",
    carol_sse.absent_count(),
    0,
  );

  // ══════════════ TRASH-SET → update broadcast (inlined in the DeleteRequest hook) ══════════════
  // The first DELETE soft-trashes via a programmatic save that bypasses the request-hook
  // broadcast tier, so trash.pb.js emits the update envelope inline (TASK-122).
  // COVERS: hook:trash.pb.js#onRecordDeleteRequest:tasks, hook:trash.pb.js#onRecordDeleteRequest:decisions
  // COVERS: hook:trash.pb.js#onRecordDeleteRequest:documents, hook:trash.pb.js#onRecordDeleteRequest:milestones
  console.log(
    "\n── TRASH-SET: 1st DELETE broadcasts an update with trashed changed (no delete event) ──",
  );
  for (const [coll, rid] of Object.entries(ids)) {
    await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice); // soft-trash
  }
  await Bun.sleep(1500);
  for (const coll of Object.keys(ids)) {
    check(
      `${coll}: soft-trash did NOT broadcast a delete`,
      alice_sse.absent_count(alice_sse.of(coll, "delete").length),
      0,
    );
    evs = alice_sse
      .of(coll, "update")
      .filter((e) => (e.rawChangedFields ?? []).includes("trashed"));
    check(`${coll}: trash-SET broadcast EXACTLY one trashed-change update`, evs.length, 1);
    if (evs.length) {
      check(`${coll}: trash-SET actorId == Alice`, evs[evs.length - 1].actorId ?? null, alice_id);
      check(
        `${coll}: trash-SET rawRecord.trashed is set`,
        ((evs[evs.length - 1].rawRecord ?? {}).trashed ?? "") !== "",
        true,
      );
    }
  }

  // ══════════════ RESTORE → normal PATCH path still broadcasts (bounded: tasks only) ══════════════
  console.log("\n── RESTORE: untrash rides the normal update request path and broadcasts ──");
  [s] = await api("PATCH", `/api/collections/tasks/records/${getitem(ids, "tasks")}`, alice, {
    trashed: "",
  });
  check("tasks: restore (PATCH trashed='') → 200", s, 200);
  await Bun.sleep(1500);
  evs = alice_sse
    .of("tasks", "update")
    .filter((e) => (e.rawChangedFields ?? []).includes("trashed"));
  check("tasks: restore broadcast a second trashed-change update", evs.length, 2);
  if (evs.length >= 2) {
    check(
      "tasks: restore rawRecord.trashed cleared",
      (evs[evs.length - 1].rawRecord ?? {}).trashed ?? null,
      "",
    );
  }
  [s] = await api("DELETE", `/api/collections/tasks/records/${getitem(ids, "tasks")}`, alice); // re-trash for the purge below
  check("tasks: re-trash → 204", s, 204);
  await Bun.sleep(1000);

  // ══════════════ DELETE via HTTP purge (double-DELETE) → AfterDeleteSuccess ══════════════
  // COVERS: hook:realtime.pb.js#onRecordAfterDeleteSuccess:tasks, hook:realtime.pb.js#onRecordAfterDeleteSuccess:decisions
  // COVERS: hook:realtime.pb.js#onRecordAfterDeleteSuccess:documents, hook:realtime.pb.js#onRecordAfterDeleteSuccess:milestones
  console.log("\n── DELETE (HTTP purge): 2nd DELETE purges (1 delete event) ──");
  for (const [coll, rid] of Object.entries(ids)) {
    await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice); // purge
  }
  await Bun.sleep(1500);
  for (const [coll, rid] of Object.entries(ids)) {
    evs = alice_sse.of(coll, "delete");
    check(`${coll}: purge broadcast EXACTLY one delete (no double-fire)`, evs.length, 1);
    if (evs.length) {
      e = evs[evs.length - 1];
      check(`${coll}: delete actorId == '' (unresolvable in After*Success)`, e.actorId ?? null, "");
      check(`${coll}: delete rawChangedFields empty`, e.rawChangedFields ?? null, []);
      check(`${coll}: delete rawRecord.id preserved`, (e.rawRecord ?? {}).id ?? null, rid);
    }
  }

  // ══════════════ DELETE via PROGRAMMATIC purge route (app.delete, not HTTP DELETE) ══════════════
  console.log(
    "\n── DELETE (programmatic): /api/tracker/trash/purge sweep must broadcast a delete ──",
  );
  let tsk: any, body: any;
  [s, tsk] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "RT purge-route task",
    project: PROJ,
    status: ST_A,
  });
  check("purge-route fixture task created", s, 200);
  const purge_id = tsk.id ?? null;
  await api("DELETE", `/api/collections/tasks/records/${purge_id}`, alice); // soft-trash
  // Backdate `trashed` past the 30-day retention so the sweep selects it (superuser write).
  [s] = await api("PATCH", `/api/collections/tasks/records/${purge_id}`, su, {
    trashed: "2000-01-01 00:00:00",
  });
  check("backdated trashed via superuser PATCH", s, 200);
  [s, body] = await api("POST", "/api/tracker/trash/purge", su);
  check("purge route → 200", s, 200);
  check("purge route swept ≥1 row", (body.purged ?? 0) >= 1, true);
  await Bun.sleep(1500);
  const purged_evs = alice_sse
    .of("tasks", "delete")
    .filter((e) => (e.rawRecord ?? {}).id === purge_id);
  check("programmatic purge broadcast a delete for the swept task", purged_evs.length, 1);
  if (purged_evs.length) {
    check(
      "programmatic-purge delete actorId == '' (systemic/superuser)",
      purged_evs[purged_evs.length - 1].actorId ?? null,
      "",
    );
  }

  check("Carol STILL received ZERO events after all activity", carol_sse.absent_count(), 0);

  // ══════════════ PBTT-431: a SUSPENDED member's subscription is refused ══════════════
  // The subscribe guard carries the same status='active' conjunct as tasks.listRule, so
  // revoking a membership must cut the live feed too — otherwise a suspended member keeps
  // receiving every row of a workspace they can no longer read. The active leg is the
  // control: without it a zero-event count could just mean a broken listener.
  console.log("\n── PBTT-431: a member's subscribe is dropped while their status is not active ──");
  const [bob, bob_id] = await login("bob@example.com");
  const bob_row = await find_by_filter(
    "workspace_members",
    `(workspace='${WS}' && user='${bob_id}')`,
    su,
  );
  check("Bob has exactly one membership row in Alice's workspace", bob_row.length, 1);
  const bob_row_id = getitem(bob_row[0], "id");
  let row: any;
  for (const [status, want_events] of [
    ["suspended", false],
    ["active", true],
  ] as [string, boolean][]) {
    [s, row] = await api("PATCH", `/api/collections/workspace_members/records/${bob_row_id}`, su, {
      status,
    });
    check(`Bob's membership → ${status}`, tup(s, row.status ?? null), tup(200, status));
    const bob_sse = SSEListener(bob, TOPIC);
    if (!(await bob_sse.start())) throw new Error("Bob SSE never received a clientId");
    await Bun.sleep(1000); // let the authorize POST land before the write below
    [s, tsk] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `RT gate task (${status})`,
      project: PROJ,
      status: ST_A,
    });
    check(`gate fixture task created while Bob is ${status}`, s, 200);
    await Bun.sleep(1500);
    check(
      `Bob (${status}) receives the workspace's realtime events`,
      bob_sse.events.length > 0,
      want_events,
    );
    bob_sse.stop = true;
    await api("DELETE", `/api/collections/tasks/records/${tsk.id ?? null}`, alice); // trash
    await api("DELETE", `/api/collections/tasks/records/${tsk.id ?? null}`, alice); // purge
  }

  // ══════════════ PBTT-462: revocation cuts a LIVE subscription, no reconnect needed ══════════════
  // realtime.pb.js re-checks the subscribe guard's predicate at DELIVERY, so suspending a member
  // mid-stream stops their feed at once. Two controls on the same channel keep a zero-delivery
  // result honest: Carol (promoted to an ACTIVE member here) and Alice (workspace OWNER, who
  // holds no workspace_members row at all and must never be cut off by the membership lookup).
  console.log("\n── PBTT-462: suspension mid-subscription stops delivery without a reconnect ──");
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: WS,
    user: carol_id,
    role: "member",
    status: "active",
  });
  check("Carol promoted to an ACTIVE member of Alice's workspace", s, 200);
  const live: Record<string, roomkit.SSEListener> = {
    "Bob (member)": SSEListener(bob, TOPIC),
    "Carol (member)": SSEListener(carol, TOPIC),
  };
  live["Alice (owner)"] = SSEListener(alice, TOPIC);
  for (const [who, listener] of Object.entries(live)) {
    if (!(await listener.start())) throw new Error(`${who} SSE never received a clientId`);
  }
  await Bun.sleep(1000); // let the authorize POSTs land before the first write
  let live_task: any;
  [s, live_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "RT revocation task",
    project: PROJ,
    status: ST_A,
  });
  check("pre-revocation fixture task created", s, 200);
  await Bun.sleep(1500);
  const before: Record<string, number> = {};
  for (const [who, listener] of Object.entries(live)) before[who] = listener.events.length;
  for (const who of Object.keys(live)) {
    check(`${who} received the pre-revocation broadcast`, getitem(before, who) > 0, true);
  }

  [s, row] = await api("PATCH", `/api/collections/workspace_members/records/${bob_row_id}`, su, {
    status: "suspended",
  });
  check(
    "Bob suspended MID-SUBSCRIPTION (stream left open)",
    tup(s, row.status ?? null),
    tup(200, "suspended"),
  );
  [s] = await api("PATCH", `/api/collections/tasks/records/${live_task.id ?? null}`, alice, {
    title: "RT revocation task v2",
  });
  check("post-revocation update → 200", s, 200);
  await Bun.sleep(1500);
  check(
    "Bob's LIVE stream stopped at suspension (zero further events)",
    getitem(live, "Bob (member)").events.length,
    getitem(before, "Bob (member)"),
  );
  for (const who of ["Carol (member)", "Alice (owner)"]) {
    check(
      `${who} still receives after Bob's revocation`,
      getitem(live, who).events.length > getitem(before, who),
      true,
    );
  }
  for (const listener of Object.values(live)) listener.stop = true;

  // ══════════════ PBTT-543: a DRAFT item is delivered only to author/owner/active admin ══════════════
  // Delivery now carries the prose collections' viewRule draft branch, so the socket can no
  // longer hand a plain member or viewer a body their REST view answers 404 for. Bob authors
  // every draft below; Dave (plain member) and Vic (viewer) are the leak detectors, and the
  // un-drafted / non-draft controls keep a zero-delivery result honest.
  console.log("\n── PBTT-543: draft delivery matrix (author/owner/admin only) ──");

  const su_user = async (name: string, email: string): Promise<any> => {
    const [s, r] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`setup: superuser creates ${name}`, [200, 201].includes(s), true);
    return r.id ?? null;
  };

  const member_row = async (user_id: string, role: string, status: string): Promise<void> => {
    const [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS,
      user: user_id,
      role,
      status,
    });
    check(`setup: ${role}/${status} membership row created`, s, 200);
  };

  const dave_id = await su_user("Dave", "rt-dave@example.com");
  const vic_id = await su_user("Vic", "rt-vic@example.com");
  const sam_id = await su_user("Sam", "rt-sam@example.com");
  await su_user("Nemo", "rt-nemo@example.com"); // deliberately gets NO membership row
  await member_row(dave_id, "member", "active");
  await member_row(vic_id, "viewer", "active");
  await member_row(sam_id, "member", "suspended");
  // Bob was suspended by the PBTT-462 block above; restore him as the draft AUTHOR.
  [s, row] = await api("PATCH", `/api/collections/workspace_members/records/${bob_row_id}`, su, {
    status: "active",
    role: "member",
  });
  check(
    "setup: Bob back to active plain member (draft author)",
    tup(s, row.role ?? null),
    tup(200, "member"),
  );
  const carol_row = await find_by_filter(
    "workspace_members",
    `(workspace='${WS}' && user='${carol_id}')`,
    su,
  );
  [s, row] = await api(
    "PATCH",
    `/api/collections/workspace_members/records/${getitem(carol_row[0], "id")}`,
    su,
    { role: "admin", status: "active" },
  );
  check("setup: Carol promoted to ACTIVE admin", tup(s, row.role ?? null), tup(200, "admin"));

  const login_pw = async (email: string): Promise<string> => {
    const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: "test123456",
    });
    return getitem(r, "token");
  };

  const dave = await login_pw("rt-dave@example.com");
  const vic = await login_pw("rt-vic@example.com");
  const sam = await login_pw("rt-sam@example.com");
  const nemo = await login_pw("rt-nemo@example.com");

  const watchers: Record<string, roomkit.SSEListener> = {
    "Alice (owner)": SSEListener(alice, TOPIC),
    "Bob (author, member)": SSEListener(bob, TOPIC),
    "Carol (active admin)": SSEListener(carol, TOPIC),
    "Dave (plain member)": SSEListener(dave, TOPIC),
    "Vic (viewer)": SSEListener(vic, TOPIC),
    "Sam (suspended member)": SSEListener(sam, TOPIC),
    "Nemo (non-member)": SSEListener(nemo, TOPIC),
  };
  const ALLOWED = ["Alice (owner)", "Bob (author, member)", "Carol (active admin)"];
  const DENIED = [
    "Dave (plain member)",
    "Vic (viewer)",
    "Sam (suspended member)",
    "Nemo (non-member)",
  ];
  for (const [who, listener] of Object.entries(watchers)) {
    if (!(await listener.start())) throw new Error(`${who} SSE never received a clientId`);
  }
  await Bun.sleep(1000); // let every authorize POST land before the first draft write

  const seen = (who: string, coll: string, action: string, rid: string | null): any[] =>
    getitem(watchers, who)
      .of(coll, action)
      .filter((ev: any) => (ev.rawRecord || {}).id === rid);

  const matrix = (label: string, coll: string, action: string, rid: string | null): void => {
    for (const who of ALLOWED) {
      check(
        `${label}: ${who} RECEIVES the ${action}`,
        seen(who, coll, action, rid).length >= 1,
        true,
      );
    }
    for (const who of DENIED) {
      check(`${label}: ${who} receives NOTHING`, seen(who, coll, action, rid).length, 0);
    }
  };

  const drafts: Record<string, any> = {
    decisions: {
      title: "draft decision",
      workspace: WS,
      project: PROJ,
      draft: true,
      context: "DRAFT SECRET CONTEXT",
    },
    documents: {
      title: "draft doc",
      workspace: WS,
      project: PROJ,
      draft: true,
      body: "DRAFT SECRET BODY",
    },
    milestones: {
      name: "draft milestone",
      workspace: WS,
      project: PROJ,
      draft: true,
      description: "DRAFT SECRET DESCRIPTION",
    },
  };
  const draft_ids: Record<string, any> = {};
  for (const [coll, dbody] of Object.entries(drafts)) {
    [s, rec] = await api("POST", `/api/collections/${coll}/records`, bob, dbody);
    check(`${coll}: Bob creates a DRAFT → 200`, s, 200);
    draft_ids[coll] = rec.id ?? null;
    check(`${coll}: draft author stamped as Bob`, rec.author ?? null, bob_id);
  }
  await Bun.sleep(1500);
  for (const coll of Object.keys(drafts)) {
    matrix(`${coll} draft CREATE`, coll, "create", getitem(draft_ids, coll));
    // The REST counterpart of the same denial — the socket must not out-run the rule.
    [s] = await api("GET", `/api/collections/${coll}/records/${getitem(draft_ids, coll)}`, dave);
    check(`${coll} draft: Dave's REST view is 404 (rule idiom)`, s, 404);
  }

  const patches: Record<string, any> = {
    decisions: { context: "DRAFT SECRET CONTEXT v2" },
    documents: { body: "DRAFT SECRET BODY v2" },
    milestones: { description: "DRAFT SECRET DESCRIPTION v2" },
  };
  for (const [coll, patch] of Object.entries(patches)) {
    [s] = await api(
      "PATCH",
      `/api/collections/${coll}/records/${getitem(draft_ids, coll)}`,
      bob,
      patch,
    );
    check(`${coll}: Bob updates his draft → 200`, s, 200);
  }
  await Bun.sleep(1500);
  for (const coll of Object.keys(drafts)) {
    matrix(`${coll} draft UPDATE`, coll, "update", getitem(draft_ids, coll));
  }

  // SOFT-TRASH tier: the first DELETE saves programmatically, so trash.pb.js emits its OWN
  // envelope inline — the one broadcast that never rides realtime.pb.js's hooks (PBTT-543).
  for (const coll of Object.keys(drafts)) {
    [s] = await api("DELETE", `/api/collections/${coll}/records/${getitem(draft_ids, coll)}`, bob);
    check(`${coll}: Bob soft-trashes his draft → 204`, s, 204);
  }
  await Bun.sleep(1500);

  const trashed_evs = (who: string, coll: string, rid: string | null): any[] =>
    seen(who, coll, "update", rid).filter((ev) => (ev.rawChangedFields || []).includes("trashed"));

  for (const coll of Object.keys(drafts)) {
    const rid = getitem(draft_ids, coll);
    for (const who of ALLOWED) {
      check(
        `${coll} draft SOFT-TRASH: ${who} RECEIVES the trash-SET update`,
        trashed_evs(who, coll, rid).length >= 1,
        true,
      );
    }
    for (const who of DENIED) {
      check(
        `${coll} draft SOFT-TRASH: ${who} receives NOTHING`,
        seen(who, coll, "update", rid).length,
        0,
      );
    }
  }

  // DELETE tier: backdate `trashed` via superuser (a plain update, not the trash hook), then
  // drive the PROGRAMMATIC purge — app.delete() fires only onRecordAfterDeleteSuccess.
  for (const coll of Object.keys(drafts)) {
    [s] = await api("PATCH", `/api/collections/${coll}/records/${getitem(draft_ids, coll)}`, su, {
      trashed: "2000-01-01 00:00:00",
    });
    check(`${coll}: draft backdated into the purge window`, s, 200);
  }
  [s, body] = await api("POST", "/api/tracker/trash/purge", su);
  check("programmatic purge route → 200", s, 200);
  check("programmatic purge swept ≥3 rows", (body.purged ?? 0) >= 3, true);
  await Bun.sleep(1500);
  for (const coll of Object.keys(drafts)) {
    matrix(`${coll} draft DELETE (programmatic purge)`, coll, "delete", getitem(draft_ids, coll));
  }

  // ── control 1: the SAME draft, un-drafted, reaches Dave and Vic ──
  console.log("\n── PBTT-543 controls: un-drafted / non-draft still reach everyone ──");
  let ctrl: any;
  [s, ctrl] = await api("POST", "/api/collections/documents/records", bob, {
    title: "control doc",
    workspace: WS,
    project: PROJ,
    draft: true,
    body: "hidden",
  });
  check("control: Bob creates a draft document → 200", s, 200);
  const ctrl_id = ctrl.id ?? null;
  await Bun.sleep(1500);
  for (const who of ["Dave (plain member)", "Vic (viewer)"]) {
    check(
      `control: ${who} sees nothing while it is a draft`,
      seen(who, "documents", "create", ctrl_id).length,
      0,
    );
  }
  [s] = await api("PATCH", `/api/collections/documents/records/${ctrl_id}`, bob, {
    draft: false,
  });
  check("control: Bob un-drafts the document → 200", s, 200);
  await Bun.sleep(1500);
  for (const who of ["Dave (plain member)", "Vic (viewer)"]) {
    check(
      `control: ${who} RECEIVES the update once it is no longer a draft`,
      seen(who, "documents", "update", ctrl_id).length >= 1,
      true,
    );
  }

  // ── control 2: a NON-draft decision reaches every active member, all fields REST-readable ──
  let plain: any;
  [s, plain] = await api("POST", "/api/collections/decisions/records", bob, {
    title: "non-draft decision",
    workspace: WS,
    project: PROJ,
    context: "open",
  });
  check("control: Bob creates a NON-draft decision → 200", s, 200);
  const plain_id = plain.id ?? null;
  await Bun.sleep(1500);
  for (const who of ["Dave (plain member)", "Vic (viewer)"]) {
    check(
      `control: ${who} RECEIVES the non-draft create`,
      seen(who, "decisions", "create", plain_id).length >= 1,
      true,
    );
  }
  // PBTT-543 AC#2 — every field on the wire must be REST-readable by the recipient.
  const dave_ev = seen("Dave (plain member)", "decisions", "create", plain_id);
  let dave_rest: any;
  [s, dave_rest] = await api("GET", `/api/collections/decisions/records/${plain_id}`, dave);
  check("AC#2: Dave's REST view of the non-draft decision is 200", s, 200);
  if (dave_ev.length) {
    check(
      "AC#2: rawRecord ships no field Dave's REST view withholds",
      Object.keys(getitem(dave_ev[dave_ev.length - 1], "rawRecord"))
        .filter((k) => !Object.hasOwn(dave_rest, k))
        .sort(by_code_point),
      [],
    );
  }
  const carol_ev = seen("Carol (active admin)", "documents", "create", ctrl_id);
  let carol_rest: any;
  [s, carol_rest] = await api("GET", `/api/collections/documents/records/${ctrl_id}`, carol);
  check("AC#2: Carol's REST view of the (then-draft) document is 200", s, 200);
  if (carol_ev.length) {
    check(
      "AC#2: draft rawRecord ships no field the admin's REST view withholds",
      Object.keys(getitem(carol_ev[carol_ev.length - 1], "rawRecord"))
        .filter((k) => !Object.hasOwn(carol_rest, k))
        .sort(by_code_point),
      [],
    );
  }

  // ── control 4: the soft-trash envelope of a NON-draft row still reaches every member ──
  [s] = await api("DELETE", `/api/collections/decisions/records/${plain_id}`, bob);
  check("control: Bob soft-trashes the non-draft decision → 204", s, 204);
  await Bun.sleep(1500);
  for (const who of ["Dave (plain member)", "Vic (viewer)"]) {
    check(
      `control: ${who} RECEIVES the non-draft trash-SET update (unchanged)`,
      trashed_evs(who, "decisions", plain_id).length >= 1,
      true,
    );
  }

  // ── control 5: suspending the AUTHOR mid-stream cuts their own draft off too ──
  // The author leg must be conjoined with the active-membership re-check, not short-circuit
  // past it: a revoked author with an open socket is still revoked (PBTT-462 × PBTT-543).
  console.log("\n── PBTT-543 × PBTT-462: a suspended author's own draft stops reaching them ──");
  let own: any;
  [s, own] = await api("POST", "/api/collections/documents/records", bob, {
    title: "own draft",
    workspace: WS,
    project: PROJ,
    draft: true,
    body: "OWN v1",
  });
  check("Bob (active author) creates his own draft → 200", s, 200);
  const own_id = own.id ?? null;
  [s] = await api("PATCH", `/api/collections/documents/records/${own_id}`, bob, { body: "OWN v2" });
  check("pre-suspension update of his own draft → 200", s, 200);
  await Bun.sleep(1500);
  const before_author = seen("Bob (author, member)", "documents", "update", own_id).length;
  check("control: the ACTIVE author receives his own draft's update", before_author >= 1, true);

  [s, row] = await api("PATCH", `/api/collections/workspace_members/records/${bob_row_id}`, su, {
    status: "suspended",
  });
  check(
    "Bob (the AUTHOR) suspended MID-SUBSCRIPTION (stream left open)",
    tup(s, row.status ?? null),
    tup(200, "suspended"),
  );
  [s] = await api("PATCH", `/api/collections/documents/records/${own_id}`, carol, {
    body: "OWN v3 AFTER SUSPEND",
  });
  check("post-suspension update by Carol (admin) → 200", s, 200);
  await Bun.sleep(1500);
  check(
    "the suspended AUTHOR receives NOTHING further about his own draft",
    seen("Bob (author, member)", "documents", "update", own_id).length,
    before_author,
  );
  for (const who of ["Alice (owner)", "Carol (active admin)"]) {
    check(
      `control: ${who} still receives that same post-suspension update`,
      seen(who, "documents", "update", own_id).length >= 1,
      true,
    );
  }
  [s] = await api("GET", `/api/collections/documents/records/${own_id}`, bob);
  check("the suspended author's REST view of his own draft is 404", s, 404);

  for (const who of ["Sam (suspended member)", "Nemo (non-member)"]) {
    check(
      `${who} received ZERO events across the whole section`,
      getitem(watchers, who).absent_count(),
      0,
    );
  }
  for (const listener of Object.values(watchers)) listener.stop = true;

  alice_sse.stop = true;
  carol_sse.stop = true;
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ all realtime event-shape + tenant-isolation + purge-path proofs passed");
process.exit(0);

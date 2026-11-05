#!/usr/bin/env bun
/**
 * Proof that every notification carries the workspace of the item it is about (card vx7y).
 *
 * One recipient, Mo, is an ACTIVE member of two workspaces A and B owned by Ola. Every emitter in
 * pb_hooks/notify.pb.js writes one row for Mo, and each row must carry its item's workspace (a
 * comment row: its task's). The ownership-transfer notice still carries its own. read-all with
 * ?workspace=A marks A rows and rows with no workspace and leaves B rows unread; without it every
 * non-dismissed row is marked.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures built by name.
 * Port 8127 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, getitem, py_repr, py_str, run_checked, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8127 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";

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
  let r: Response;
  let raw: string;
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  return [r.status, raw ? JSON.parse(raw) : {}];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-notif-workspace-test-"));
// Resolved ONCE: hooks_dir() re-copies on every call, and PB restarts on any write to its hooksDir.
const HOOKS = roomkit.hooks_dir(S);

function make_room(name: string): [string, string] {
  const mig = path.join(S, name, "pb_migrations");
  const data = path.join(S, name, "pb_data");
  fs.mkdirSync(data, { recursive: true });
  fs.cpSync(REAL_MIGRATIONS_DIR, mig, { recursive: true, dereference: true });
  for (const f of fs.readdirSync(mig)) {
    if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(mig, f));
  }
  run_checked(
    [PB_BIN, "superuser", "upsert", SU_EMAIL, SU_PASSWORD, "--dir", data, "--migrationsDir", mig],
    { cwd: REPO_ROOT, capture_output: true },
  );
  return [data, mig];
}

async function su_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  return roomkit.token_of(BASE_URL, SU_EMAIL, r);
}

function ref(display: string, user_id: string): string {
  return `@[${display}](${user_id})`;
}

async function world(su: string) {
  /** Ola owns A, B and C; Mo is an ACTIVE member of all three. */
  async function make_user(name: string, email: string): Promise<[string, string]> {
    const [s, rec] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name,
      verified: true,
      approved: true,
    });
    if (s !== 200 && s !== 201) {
      throw new roomkit.SystemExit(
        `❌ fixture user ${email} not created: HTTP ${s} ${py_str(rec)}`,
      );
    }
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    return [roomkit.token_of(BASE_URL, email, auth), getitem(rec, "id")];
  }

  const [ola, ola_id] = await make_user("Ola", "ola@example.com");
  const [mo, mo_id] = await make_user("Mo", "mo@example.com");

  async function make_ws(name: string): Promise<[string, string]> {
    let s: number;
    let ws: any, proj: any;
    [s, ws] = await api("POST", "/api/collections/workspaces/records", ola, {
      name,
      owner: ola_id,
    });
    check(`Ola creates workspace ${name}`, s, 200);
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: getitem(ws, "id"),
      user: mo_id,
      role: "member",
      status: "active",
    });
    check(`Mo joins ${name} as an ACTIVE member`, s, 200);
    [s, proj] = await api("POST", "/api/collections/projects/records", ola, {
      name: `${name}-project`,
      owner: ola_id,
      workspace: getitem(ws, "id"),
    });
    check(`Ola creates a project in ${name}`, s, 200);
    return [getitem(ws, "id"), getitem(proj, "id")];
  }

  return { ola, ola_id, mo, mo_id, make_ws };
}

async function rows_of(su: string, flt: string): Promise<any[]> {
  const qs = urlencode({ filter: flt, perPage: 500 });
  return (await api("GET", `/api/collections/notifications/records?${qs}`, su))[1].items || [];
}

async function one(su: string, flt: string): Promise<any> {
  const rows = await rows_of(su, flt);
  return rows.length === 1 ? rows[0] : { id: null, workspace: `<${rows.length} rows>` };
}

let server: roomkit.Room | null = null;
try {
  console.log(
    "═════════ test_notifications_workspace.ts — every notification carries its workspace ═════════",
  );
  const [DATA, MIG] = make_room("room1");
  server = await roomkit.serve(PORT, DATA, MIG, HOOKS);
  const su = await su_token();

  console.log("\n── fixtures ──");
  const { ola, ola_id, mo, mo_id, make_ws } = await world(su);
  const [WA, PA] = await make_ws("wsa");
  const [WB, PB] = await make_ws("wsb");
  const [WC] = await make_ws("wsc");
  check("A and B are distinct workspaces", WA !== WB, true);

  async function task(project: string, title: string, extra: Record<string, any> = {}) {
    const [s, t] = await api("POST", "/api/collections/tasks/records", ola, {
      title,
      project,
      ...extra,
    });
    if (s !== 200) {
      throw new roomkit.SystemExit(`❌ fixture task ${title} not created: HTTP ${s} ${py_str(t)}`);
    }
    return getitem(t, "id");
  }

  // ═══════════ (1) every emitter stamps its item's workspace ═══════════════════
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:tasks
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:comments
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:tasks
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:documents
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:documents
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:decisions
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:decisions
  // COVERS: route:POST /api/tracker/workspaces/{id}/transfer-ownership
  console.log("\n── (1) every emitter writes workspace = its item's workspace ──");
  const stamped = new Map<string, [any, string]>(); // label -> (row id, expected workspace)

  function expect(label: string, row: any, ws: string): void {
    check(
      `${label}: row carries workspace ${ws === WA ? "A" : ws === WB ? "B" : "C"}`,
      row.workspace ?? null,
      ws,
    );
    stamped.set(label, [row.id ?? null, ws]);
  }

  let s: number;
  let c: any, d: any, dc: any, sts: any;

  const TA = await task(PA, "assign-a");
  [s] = await api("PATCH", `/api/collections/tasks/records/${TA}`, ola, { assignee: mo_id });
  check("Ola assigns a task in A to Mo → 200", s, 200);
  expect(
    "tasks update assigned",
    await one(su, `task='${TA}' && user='${mo_id}' && kind='assigned'`),
    WA,
  );

  [s, sts] = await api(
    "GET",
    "/api/collections/statuses/records?" +
      urlencode({ filter: `workspace='${WB}' && category='completed'` }),
    su,
  );
  const DONE_B = ((sts.items || [{}])[0] as any).id ?? null;
  const TB = await task(PB, "done-b", { assignee: mo_id });
  [s] = await api("PATCH", `/api/collections/tasks/records/${TB}`, ola, { status: DONE_B });
  check("Ola completes Mo's task in B → 200", s, 200);
  expect(
    "tasks update status_done",
    await one(su, `task='${TB}' && user='${mo_id}' && kind='status_done'`),
    WB,
  );

  [s, c] = await api("POST", "/api/collections/comments/records", ola, {
    task: TA,
    author: ola_id,
    body: "plain note",
  });
  check("Ola comments on the A task → 200", s, 200);
  expect(
    "comments create commented",
    await one(su, `comment='${py_str(c.id ?? null)}' && user='${mo_id}' && kind='commented'`),
    WA,
  );

  [s, c] = await api("POST", "/api/collections/comments/records", ola, {
    task: TB,
    author: ola_id,
    body: `hey ${ref("Mo", mo_id)}`,
  });
  check("Ola comments naming Mo on the B task → 200", s, 200);
  expect(
    "comments create mentioned",
    await one(su, `comment='${py_str(c.id ?? null)}' && user='${mo_id}' && kind='mentioned'`),
    WB,
  );

  [s, c] = await api("POST", "/api/collections/comments/records", ola, {
    task: TA,
    author: ola_id,
    body: "draft",
  });
  [s] = await api("PATCH", `/api/collections/comments/records/${py_str(c.id ?? null)}`, ola, {
    body: `now ${ref("Mo", mo_id)}`,
  });
  check("Ola edits an A comment to name Mo → 200", s, 200);
  expect(
    "comments update mentioned",
    await one(su, `comment='${py_str(c.id ?? null)}' && user='${mo_id}' && kind='mentioned'`),
    WA,
  );

  const TP = await task(PB, "prose-create-b", { description: ref("Mo", mo_id) });
  expect(
    "tasks create item mention",
    await one(su, `task='${TP}' && comment='' && user='${mo_id}' && kind='mentioned'`),
    WB,
  );
  const TU = await task(PA, "prose-update-a");
  [s] = await api("PATCH", `/api/collections/tasks/records/${TU}`, ola, {
    description: ref("Mo", mo_id),
  });
  check("Ola names Mo in an A task description → 200", s, 200);
  expect(
    "tasks update item mention",
    await one(su, `task='${TU}' && comment='' && user='${mo_id}' && kind='mentioned'`),
    WA,
  );

  [s, d] = await api("POST", "/api/collections/documents/records", ola, {
    title: "doc-a",
    workspace: WA,
    body: ref("Mo", mo_id),
  });
  check("Ola creates an A document naming Mo → 200", s, 200);
  expect(
    "documents create item mention",
    await one(su, `document='${py_str(d.id ?? null)}' && user='${mo_id}'`),
    WA,
  );
  [s, d] = await api("POST", "/api/collections/documents/records", ola, {
    title: "doc-b",
    workspace: WB,
  });
  [s] = await api("PATCH", `/api/collections/documents/records/${py_str(d.id ?? null)}`, ola, {
    body: ref("Mo", mo_id),
  });
  check("Ola names Mo in a B document body → 200", s, 200);
  expect(
    "documents update item mention",
    await one(su, `document='${py_str(d.id ?? null)}' && user='${mo_id}'`),
    WB,
  );

  [s, dc] = await api("POST", "/api/collections/decisions/records", ola, {
    title: "dec-b",
    workspace: WB,
    context: ref("Mo", mo_id),
  });
  check("Ola creates a B decision naming Mo → 200", s, 200);
  expect(
    "decisions create item mention",
    await one(su, `decision='${py_str(dc.id ?? null)}' && user='${mo_id}'`),
    WB,
  );
  [s, dc] = await api("POST", "/api/collections/decisions/records", ola, {
    title: "dec-a",
    workspace: WA,
  });
  [s] = await api("PATCH", `/api/collections/decisions/records/${py_str(dc.id ?? null)}`, ola, {
    consequences: ref("Mo", mo_id),
  });
  check("Ola names Mo in an A decision → 200", s, 200);
  expect(
    "decisions update item mention",
    await one(su, `decision='${py_str(dc.id ?? null)}' && user='${mo_id}'`),
    WA,
  );

  [s] = await api("POST", `/api/tracker/workspaces/${WC}/transfer-ownership`, ola, {
    user: mo_id,
  });
  check("Ola hands workspace C to Mo → 200", s, 200);
  expect(
    "ownership transfer",
    await one(su, `user='${mo_id}' && kind='ownership_transferred'`),
    WC,
  );

  // ═══════════ (2) read-all takes the workspace scope ══════════════════════════
  // COVERS: route:POST /api/tracker/notifications/read-all
  console.log("\n── (2) read-all ?workspace=A marks A + no-workspace rows, leaves B unread ──");
  let loose: any, r: any;
  [s, loose] = await api("POST", "/api/collections/notifications/records", su, {
    user: mo_id,
    kind: "assigned",
  });
  check("superuser writes a no-workspace row for Mo → 200", s, 200);
  const LOOSE = loose.id ?? null;
  const b_rows: string[] = (await rows_of(su, `user='${mo_id}' && workspace='${WB}'`)).map((x) =>
    getitem(x, "id"),
  );
  const a_rows: string[] = (await rows_of(su, `user='${mo_id}' && workspace='${WA}'`)).map((x) =>
    getitem(x, "id"),
  );
  check("Mo holds rows in A", a_rows.length >= 5, true);
  check("Mo holds rows in B", b_rows.length >= 5, true);
  const DISMISSED_B = b_rows.length ? b_rows[0] : null;
  [s] = await api("PATCH", `/api/collections/notifications/records/${py_str(DISMISSED_B)}`, mo, {
    dismissed: true,
  });
  check("Mo dismisses one B row → 200", s, 200);

  async function read_of(row_id: string | null): Promise<any> {
    return (
      (await api("GET", `/api/collections/notifications/records/${py_str(row_id)}`, su))[1].read ??
      null
    );
  }
  async function reads_of(ids: string[]): Promise<any[]> {
    const out: any[] = [];
    for (const x of ids) out.push(await read_of(x));
    return out;
  }

  check(
    "every Mo row starts unread",
    [...new Set((await rows_of(su, `user='${mo_id}'`)).map((x) => py_str(x.read ?? null)))].sort(
      by_code_point,
    ),
    ["False"],
  );
  [s, r] = await api("POST", `/api/tracker/notifications/read-all?workspace=${WA}`, mo);
  check("Mo read-all ?workspace=A → 200", s, 200);
  check("…every A row is read", await reads_of(a_rows), Array(a_rows.length).fill(true));
  check("…the no-workspace row is read", await read_of(LOOSE), true);
  check("…every B row is still unread", await reads_of(b_rows), Array(b_rows.length).fill(false));
  check(
    "…the C transfer notice is still unread",
    await read_of(stamped.get("ownership transfer")![0]),
    false,
  );
  check("…updated counts A rows plus the no-workspace row", r.updated ?? null, a_rows.length + 1);

  [s, r] = await api("POST", "/api/tracker/notifications/read-all", mo);
  check("Mo read-all with no workspace → 200", s, 200);
  check(
    "…every non-dismissed B row is read",
    await reads_of(b_rows.slice(1)),
    Array(Math.max(b_rows.length - 1, 0)).fill(true),
  );
  check(
    "…the C transfer notice is read",
    await read_of(stamped.get("ownership transfer")![0]),
    true,
  );
  check("…the dismissed B row stays unread", await read_of(DISMISSED_B), false);

  await roomkit.stop(server);
  server = null;

  console.log("\n" + "═".repeat(90));
  console.log(failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);

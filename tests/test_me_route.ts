#!/usr/bin/env bun
/**
 * GET /api/tracker/me: the caller's workspaces with role, status, counts and capabilities, plus the unread count, in one call.
 *
 * Fully self-contained clean-room server, scripts/seed.ts fixtures. Port 8177 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8177 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  const raw = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  return [r.status, raw.length ? JSON.parse(text) : {}]; // 204 -> empty body
}

async function find_by_filter(collection: string, filt: string, token: string): Promise<any[]> {
  const qs = urlencode({ filter: filt, perPage: 200 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return r.items || [];
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
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-me-route-test-"));
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
  const ws_of = async (name: string) =>
    getitem((await find_by_filter("workspaces", `name='${name}\\'s Workspace'`, su))[0], "id");
  const A_WS = await ws_of("Alice");
  const B_WS = await ws_of("Bob");
  const C_WS = await ws_of("Carol");
  const ME = "/api/tracker/me";
  const me = async (token: string) => {
    const [s, r] = await api("GET", ME, token);
    if (s !== 200) console.log(`     GET ${ME} → ${s} ${py_str(r)}`);
    return r;
  };
  const entry = (r: any, ws: string) =>
    (Array.isArray(r?.workspaces) ? r.workspaces : []).find((w: any) => w.id === ws) ?? null;
  const ids = (r: any) =>
    (Array.isArray(r?.workspaces) ? r.workspaces : []).map((w: any) => w.id).sort();
  const open_items = async (ws: string, token: string) =>
    entry(await me(token), ws)?.counts?.open_items ?? null;

  console.log("\n── who may call ──");
  // COVERS: route:GET /api/tracker/me
  let [s] = await api("GET", ME);
  check("anonymous GET /api/tracker/me → 401", s, 401);
  [s] = await api("GET", ME, su);
  check("superuser GET /api/tracker/me → 403", s, 403);

  console.log("\n── one call: workspaces with role, status, counts and capabilities ──");
  let r = await me(alice);
  check(
    "alice: user is herself",
    [r?.user?.id ?? null, r?.user?.name ?? null],
    [alice_id, "Alice"],
  );
  check("alice: lists only the workspace she owns", ids(r), [A_WS]);
  check("alice @ own workspace", entry(r, A_WS), {
    id: A_WS,
    name: "Alice's Workspace",
    role: "owner",
    status: "active",
    counts: { projects: 1, open_items: 4 },
    capabilities: { write: true, manage: true, own: true },
  });
  r = await me(bob);
  check("bob: lists his own and alice's", ids(r), [A_WS, B_WS].sort());
  check("bob @ alice's, a member", entry(r, A_WS), {
    id: A_WS,
    name: "Alice's Workspace",
    role: "member",
    status: "active",
    counts: { projects: 1, open_items: 4 },
    capabilities: { write: true, manage: false, own: false },
  });
  check("bob @ own workspace, open items = its two open tasks", entry(r, B_WS)?.counts ?? null, {
    projects: 1,
    open_items: 2,
  });
  check("bob @ own workspace → role owner", entry(r, B_WS)?.role ?? null, "owner");

  console.log("\n── a task in a custom done status is not counted open ──");
  let st: any;
  [s, st] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: A_WS,
    name: "Shipped",
    category: "completed",
  });
  check("fixture: alice adds custom done status Shipped → 200", s, 200);
  const nav = (await find_by_filter("tasks", "title='Wire up nav'", alice))[0];
  [s] = await api("PATCH", `/api/collections/tasks/records/${nav.id}`, alice, { status: st.id });
  check("fixture: Wire up nav moves to Shipped → 200", s, 200);
  check("open items drop to 3 for alice", await open_items(A_WS, alice), 3);
  check("open items drop to 3 for bob (same workspace)", await open_items(A_WS, bob), 3);
  let wont: any;
  [s, wont] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: A_WS,
    name: "Won't do",
    category: "canceled",
  });
  let review: any;
  [, review] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: A_WS,
    name: "In review",
    category: "started",
  });
  const home = (await find_by_filter("tasks", "title='Design homepage'", alice))[0];
  [s] = await api("PATCH", `/api/collections/tasks/records/${home.id}`, alice, {
    status: review.id,
  });
  check("custom started status In review stays open → still 3", await open_items(A_WS, alice), 3);
  [s] = await api("PATCH", `/api/collections/tasks/records/${home.id}`, alice, {
    status: wont.id,
  });
  check("custom canceled status is not open → 2", await open_items(A_WS, alice), 2);
  const sub = (await find_by_filter("tasks", "title='Pick a color palette'", alice))[0];
  [s] = await api("DELETE", `/api/collections/tasks/records/${sub.id}`, alice);
  check("fixture: alice trashes a subtask → 204", s, 204);
  check("a trashed task is not counted → 1", await open_items(A_WS, alice), 1);
  [s] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Second",
    workspace: A_WS,
  });
  check("fixture: alice adds a project → 200", s, 200);
  check(
    "project count is 2 (the hidden shadow project is never counted)",
    entry(await me(alice), A_WS)?.counts?.projects ?? null,
    2,
  );
  const second = (
    await find_by_filter("projects", `workspace='${A_WS}' && name='Second'`, alice)
  )[0];
  const todo = (
    await find_by_filter("statuses", `workspace='${A_WS}' && category='unstarted'`, alice)
  )[0];
  let extra: any;
  [s, extra] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Second task",
    project: second.id,
    status: todo.id,
  });
  check("fixture: a task in the new project → 200", s, 200);
  check("an open task in the new project counts → 2", await open_items(A_WS, alice), 2);
  [s] = await api("PATCH", `/api/collections/tasks/records/${extra.id}`, alice, { status: "" });
  check("fixture: its status is cleared → 200", s, 200);
  check("a task with no status counts as open → 2", await open_items(A_WS, alice), 2);
  [s] = await api("DELETE", `/api/collections/projects/records/${second.id}`, alice);
  check("fixture: alice trashes the new project → 204", s, 204);
  check(
    "a task in a trashed project is not counted, nor the project",
    entry(await me(alice), A_WS)?.counts ?? null,
    { projects: 1, open_items: 1 },
  );

  console.log("\n── capabilities follow the role ──");
  const add_carol = async (role: string) => {
    const rows = await find_by_filter(
      "workspace_members",
      `workspace='${A_WS}' && user='${carol_id}'`,
      su,
    );
    if (rows.length)
      return (
        await api("PATCH", `/api/collections/workspace_members/records/${rows[0].id}`, su, {
          role,
          status: "active",
        })
      )[0];
    return (
      await api("POST", "/api/collections/workspace_members/records", su, {
        workspace: A_WS,
        user: carol_id,
        role,
        status: "active",
      })
    )[0];
  };
  check("fixture: carol joins alice's as viewer", await add_carol("viewer"), 200);
  r = entry(await me(carol), A_WS);
  check("carol viewer: role", r?.role ?? null, "viewer");
  check("carol viewer: capabilities", r?.capabilities ?? null, {
    write: false,
    manage: false,
    own: false,
  });
  check("carol viewer: counts still served", r?.counts ?? null, { projects: 1, open_items: 1 });
  check("fixture: carol becomes admin", await add_carol("admin"), 200);
  check("carol admin: capabilities", entry(await me(carol), A_WS)?.capabilities ?? null, {
    write: true,
    manage: true,
    own: false,
  });

  console.log("\n── a suspended membership is listed with its status, nothing else ──");
  const row = (
    await find_by_filter("workspace_members", `workspace='${A_WS}' && user='${carol_id}'`, su)
  )[0];
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${row.id}`, alice, {
    status: "suspended",
  });
  check("fixture: alice suspends carol → 200", s, 200);
  check("carol suspended @ alice's", entry(await me(carol), A_WS), {
    id: A_WS,
    name: null,
    role: "admin",
    status: "suspended",
    counts: null,
    capabilities: { write: false, manage: false, own: false },
  });

  console.log("\n── a trashed workspace is not listed ──");
  [s] = await api("DELETE", `/api/collections/workspaces/records/${C_WS}`, carol);
  const c_ws = (await find_by_filter("workspaces", `id='${C_WS}'`, su))[0];
  check("fixture: carol trashes her workspace", [s, Boolean(c_ws?.trashed)], [204, true]);
  r = await me(carol);
  check("carol's trashed workspace is not listed", ids(r).includes(C_WS), false);
  check("…while alice's (suspended) still is", ids(r).includes(A_WS), true);
  [s] = await api("DELETE", `/api/collections/workspace_members/records/${row.id}`, su);
  check("fixture: carol is removed from alice's → 204", s, 204);
  check("a removed membership is not listed", ids(await me(carol)).includes(A_WS), false);

  console.log("\n── unread count: the inbox's own read=false total ──");
  const t_ids = (await find_by_filter("tasks", `workspace='${A_WS}'`, alice)).map((t: any) => t.id);
  const notify = async (task: string, read: boolean, dismissed = false) =>
    (
      await api("POST", "/api/collections/notifications/records", su, {
        user: bob_id,
        task,
        workspace: A_WS,
        kind: "assigned",
        read,
        dismissed,
      })
    )[0];
  const before = (await me(bob))?.unread_notifications ?? null;
  check("bob's unread count is a number", typeof before, "number");
  for (const t of t_ids.slice(0, 3)) await notify(t, false);
  await notify(t_ids[0], true);
  await notify(t_ids[0], false, true);
  const inbox_unread = async (token: string) => {
    const [, l] = await api(
      "GET",
      `/api/collections/notifications/records?${urlencode({ filter: "read=false", perPage: 1 })}`,
      token,
    );
    return l.totalItems ?? null;
  };
  check(
    "three unread, one read, one dismissed → +3",
    (await me(bob))?.unread_notifications,
    before + 3,
  );
  check(
    "equals the inbox's read=false total",
    (await me(bob))?.unread_notifications,
    await inbox_unread(bob),
  );
  const pre_trash = (await me(bob))?.unread_notifications;
  const doomed = t_ids[1];
  [s] = await api("DELETE", `/api/collections/tasks/records/${doomed}`, alice);
  check("fixture: alice trashes a notified task → 204", s, 204);
  check(
    "a row the inbox hides (trashed task) is not counted",
    (await me(bob))?.unread_notifications,
    await inbox_unread(bob),
  );
  check("…so the count fell", (await me(bob))?.unread_notifications < pre_trash, true);
  [s] = await api("POST", "/api/tracker/notifications/read-all", bob);
  check("after read-all → 0", (await me(bob))?.unread_notifications, 0);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all me-route proofs passed");
  process.exit(0);
}

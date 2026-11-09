#!/usr/bin/env bun
/**
 * Notifications name the user whose act produced them (actor) and the server time the recipient read them (read_at).
 *
 * Fully self-contained clean-room server, scripts/seed.ts fixtures. Port 8178 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8178 + PORT_OFFSET;
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-notification-actor-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
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
  const N = "/api/collections/notifications/records";
  const latest = async (user: string, kind: string) =>
    (
      await find_by_filter("notifications", `user='${user}' && kind='${kind}'`, su).then((rows) =>
        rows.sort((a: any, b: any) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0)),
      )
    )[0] ?? null;
  const task = async (title: string) => (await find_by_filter("tasks", `title='${title}'`, su))[0];
  const nav = await task("Wire up nav");
  const ship = await task("Ship landing page");
  const home = await task("Design homepage");
  let s: number;
  let r: any;

  console.log("\n── every fan-out names the member who acted ──");
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: nav.id,
    author: alice_id,
    body: "nav first",
  });
  check("fixture: alice comments on bob's task → 200", s, 200);
  check("commented → actor alice", (await latest(bob_id, "commented"))?.actor ?? null, alice_id);
  [s] = await api("PATCH", `/api/collections/tasks/records/${ship.id}`, alice, {
    assignee: bob_id,
  });
  check("fixture: alice assigns bob → 200", s, 200);
  check("assigned → actor alice", (await latest(bob_id, "assigned"))?.actor ?? null, alice_id);
  const done = (
    await find_by_filter("statuses", `workspace='${A_WS}' && category='completed'`, su)
  )[0];
  [s] = await api("PATCH", `/api/collections/tasks/records/${nav.id}`, alice, { status: done.id });
  check("fixture: alice completes bob's task → 200", s, 200);
  check(
    "status_done → actor alice",
    (await latest(bob_id, "status_done"))?.actor ?? null,
    alice_id,
  );
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: home.id,
    author: alice_id,
    body: `cc @[Bob](${bob_id})`,
  });
  check("fixture: alice mentions bob in a comment → 200", s, 200);
  r = await latest(bob_id, "mentioned");
  check("comment mention → actor alice", [r?.actor ?? null, Boolean(r?.comment)], [alice_id, true]);
  [s] = await api("PATCH", `/api/collections/tasks/records/${home.id}`, alice, {
    description: `over to @[Bob](${bob_id})`,
  });
  check("fixture: alice mentions bob in a task description → 200", s, 200);
  r = await latest(bob_id, "mentioned");
  check("item mention → actor alice", [r?.actor ?? null, r?.comment ?? null], [alice_id, ""]);
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: B_WS,
    user: alice_id,
    role: "admin",
    status: "active",
  });
  check("fixture: alice joins bob's workspace as admin → 200", s, 200);
  [s] = await api("POST", `/api/tracker/workspaces/${B_WS}/transfer-ownership`, bob, {
    user: alice_id,
  });
  check("fixture: bob hands his workspace to alice → 200", s, 200);
  check(
    "ownership_transferred → actor bob, on both parties' rows",
    [
      (await latest(alice_id, "ownership_transferred"))?.actor ?? null,
      (await latest(bob_id, "ownership_transferred"))?.actor ?? null,
    ],
    [bob_id, bob_id],
  );
  [s] = await api("POST", `/api/tracker/workspaces/${B_WS}/transfer-ownership`, su, {
    user: bob_id,
    current_owner: alice_id,
  });
  check("fixture: a superuser hands it back to bob → 200", s, 200);
  check(
    "a superuser transfer names no user on either row",
    [
      (await latest(alice_id, "ownership_transferred"))?.actor ?? null,
      (await latest(bob_id, "ownership_transferred"))?.actor ?? null,
    ],
    ["", ""],
  );
  [s] = await api("POST", "/api/collections/comments/records", su, {
    task: nav.id,
    author: alice_id,
    body: "operator note",
  });
  check("fixture: a superuser comments → 200", s, 200);
  check(
    "a superuser's act names no user (no fabricated actor)",
    (await latest(bob_id, "commented"))?.actor ?? null,
    "",
  );

  console.log("\n── read_at is the server's time of reading ──");
  const row = await latest(bob_id, "assigned");
  check("an unread row has no read_at", row?.read_at ?? null, "");
  const t0 = Date.now();
  [s, r] = await api("PATCH", `${N}/${row.id}`, bob, { read: true });
  const t1 = Date.now();
  const at = Date.parse(String(r?.read_at ?? "").replace(" ", "T"));
  check("bob marks it read → 200", s, 200);
  check(
    "read_at is stamped now by the server",
    Number.isFinite(at) && at >= t0 - 2000 && at <= t1 + 2000,
    true,
  );
  const stamped = r?.read_at ?? null;
  [s] = await api("PATCH", `${N}/${row.id}`, bob, {
    read: true,
    read_at: "2001-01-01 00:00:00.000Z",
  });
  check("a client-sent read_at is refused → 404", s, 404);
  [s] = await api("PATCH", `${N}/${row.id}`, bob, { actor: carol_id });
  check("a client-sent actor is refused → 404", s, 404);
  r = (await find_by_filter("notifications", `id='${row.id}'`, su))[0];
  check("…and neither was stored", [r?.read_at ?? null, r?.actor ?? null], [stamped, alice_id]);
  await Bun.sleep(20);
  [s, r] = await api("PATCH", `${N}/${row.id}`, bob, { read: true });
  check(
    "marking an already-read row keeps the first read_at",
    [s, r?.read_at ?? null],
    [200, stamped],
  );
  [s, r] = await api("PATCH", `${N}/${row.id}`, bob, { read: false });
  check("marking it unread clears read_at", [s, r?.read_at ?? null], [200, ""]);
  const r0 = Date.now();
  [s, r] = await api("POST", "/api/tracker/notifications/read-all", bob);
  const r1 = Date.now();
  check("bob reads all → 200", s, 200);
  const all = await find_by_filter("notifications", `user='${bob_id}' && read=true`, bob);
  check(
    "read-all stamps read_at on every row it marks",
    all.length > 0 &&
      all.every((n: any) => {
        const t = Date.parse(String(n.read_at || "").replace(" ", "T"));
        return Number.isFinite(t) && t >= r0 - 2000 && t <= r1 + 2000;
      }),
    true,
  );

  console.log("\n── a deleted actor leaves the notification, unnamed ──");
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: A_WS,
    user: carol_id,
    role: "member",
    status: "active",
  });
  check("fixture: carol joins alice's → 200", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", carol, {
    task: nav.id,
    author: carol_id,
    body: "carol was here",
  });
  check("fixture: carol comments on bob's task → 200", s, 200);
  const by_carol = await latest(bob_id, "commented");
  check("commented → actor carol", by_carol?.actor ?? null, carol_id);
  [s] = await api("DELETE", `/api/collections/users/records/${carol_id}`, su);
  check("fixture: carol's account is deleted → 204", s, 204);
  r = (await find_by_filter("notifications", `id='${by_carol?.id}'`, su))[0] ?? null;
  check("bob's row survives with no actor", [Boolean(r), r?.actor ?? null], [true, ""]);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all notification actor and read_at proofs passed");
  process.exit(0);
}

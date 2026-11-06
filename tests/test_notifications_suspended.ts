#!/usr/bin/env bun
/**
 * A notification that names only a workspace is hidden from a member suspended from that workspace, on list, view, update, export and read-all.
 *
 * Fully self-contained clean-room server, scripts/seed.ts fixtures. Port 8179 + PB_PORT_OFFSET.
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
const PORT = 8179 + PORT_OFFSET;
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-notifications-suspended-test-"));
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
  const N = "/api/collections/notifications/records";
  const listed = async (token: string) =>
    (await find_by_filter("notifications", "id != ''", token)).map((n: any) => n.id).sort();
  let s: number;
  let r: any;

  console.log("\n── fixture: bob hands his workspace to carol, both are told ──");
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: B_WS,
    user: carol_id,
    role: "admin",
    status: "active",
  });
  check("carol joins bob's workspace as admin → 200", s, 200);
  [s] = await api("POST", `/api/tracker/workspaces/${B_WS}/transfer-ownership`, bob, {
    user: carol_id,
  });
  check("bob transfers to carol → 200", s, 200);
  const notice = (
    await find_by_filter(
      "notifications",
      `user='${bob_id}' && kind='ownership_transferred' && workspace='${B_WS}'`,
      su,
    )
  )[0];
  check("bob holds an ownership_transferred row for that workspace", Boolean(notice), true);
  [s] = await api("POST", N, su, { user: bob_id, kind: "ownership_transferred" });
  check("fixture: a workspace-less row for bob → 200", s, 200);
  const loose = (
    await find_by_filter("notifications", `user='${bob_id}' && workspace='' && task=''`, su)
  )[0];
  check(
    "control: bob, still active, lists the row",
    (await listed(bob)).includes(notice?.id),
    true,
  );

  console.log("\n── carol suspends bob from that workspace ──");
  const bob_row = (
    await find_by_filter("workspace_members", `workspace='${B_WS}' && user='${bob_id}'`, su)
  )[0];
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_row.id}`, carol, {
    status: "suspended",
  });
  check("carol suspends bob → 200", s, 200);
  const ids = await listed(bob);
  check("list: the workspace-only row is hidden", ids.includes(notice?.id), false);
  check("list: the workspace-less row stays", ids.includes(loose?.id), true);
  [s] = await api("GET", `${N}/${notice?.id}`, bob);
  check("view by id → 404", s, 404);
  [s] = await api("PATCH", `${N}/${notice?.id}`, bob, { read: true });
  check("update (mark read) → 404", s, 404);
  [s, r] = await api("POST", "/api/tracker/export", bob, {
    workspace: A_WS,
    collections: ["notifications"],
  });
  check("export as bob (active in alice's) → 200", s, 200);
  check(
    "export returns the same notification ids as list",
    (r?.data?.notifications ?? []).map((n: any) => n.id).sort(),
    ids,
  );
  [s] = await api("PATCH", `${N}/${notice?.id}`, su, { read: false });
  check("fixture: the row is unread before read-all → 200", s, 200);
  [s] = await api("POST", "/api/tracker/notifications/read-all", bob);
  check("bob reads all → 200", s, 200);
  r = (await find_by_filter("notifications", `id='${notice?.id}'`, su))[0];
  check("read-all left the hidden row unread", r?.read ?? null, false);

  console.log("\n── reinstated, bob sees it again ──");
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_row.id}`, carol, {
    status: "active",
  });
  check("carol reinstates bob → 200", s, 200);
  check("list: the row is back", (await listed(bob)).includes(notice?.id), true);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all suspended-member notification proofs passed");
  process.exit(0);
}

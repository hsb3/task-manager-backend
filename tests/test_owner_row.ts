#!/usr/bin/env bun
/**
 * The owner's membership row: every new workspace gives its owner an active admin row, that row
 * cannot be demoted, suspended or deleted by the owner or an admin (409 last_active_owner) until ownership moves
 * through transfer-ownership, and a membership or invitation created without a role is a member.
 *
 * Fully self-contained clean-room server, scripts/seed.ts fixtures. Port 8174 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8174 + PORT_OFFSET;
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-owner-row-test-"));
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
  const [, bob_id] = await login("bob@example.com");
  const [carol, carol_id] = await login("carol@example.com");
  const ALICE_WS = getitem(
    (await find_by_filter("workspaces", "name='Alice\\'s Workspace'", alice))[0],
    "id",
  );
  const MEMBERS = "/api/collections/workspace_members/records";
  const roster = async (ws: string) =>
    (await find_by_filter("workspace_members", `workspace='${ws}'`, su))
      .map((m: any) => [m.user, m.role, m.status])
      .sort();
  const row_of = async (ws: string, uid: string) =>
    (await find_by_filter("workspace_members", `workspace='${ws}' && user='${uid}'`, su))[0] ??
    null;
  const code = (r: any, field: string) => r?.data?.[field]?.code ?? null;
  let s: number;
  let r: any;

  [s, r] = await api("POST", MEMBERS, su, {
    workspace: ALICE_WS,
    user: carol_id,
    role: "admin",
    status: "active",
  });
  check("fixture: carol joins Alice's workspace as an active admin", s, 200);

  console.log("\n── every new workspace gives its owner an active admin row ──");
  // COVERS: rule:workspaces.create
  [s, r] = await api("POST", "/api/collections/workspaces/records", alice, { name: "Second" });
  check("alice creates a workspace through the API → 200", s, 200);
  const WS2: string = r.id;
  check("its roster is alice alone, admin and active", await roster(WS2), [
    [alice_id, "admin", "active"],
  ]);
  [s, r] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "Bob by operator",
    owner: bob_id,
  });
  check("a superuser creates a workspace owned by bob → 200", s, 200);
  check("its roster is bob alone, admin and active", await roster(r.id), [
    [bob_id, "admin", "active"],
  ]);
  const own = await row_of(ALICE_WS, alice_id);
  check(
    "the signup-provisioned workspace's owner row is admin and active",
    tup(own?.role ?? null, own?.status ?? null),
    tup("admin", "active"),
  );

  console.log("\n── neither the owner nor an admin demotes, suspends or removes the owner row ──");
  const OWN = own?.id ?? "missing";
  // COVERS: rule:workspace_members.update, rule:workspace_members.delete
  const attempts: [string, string, string | null, any][] = [
    ["owner PATCH own row {role: viewer}", "PATCH", alice, { role: "viewer" }],
    ["owner PATCH own row {status: suspended}", "PATCH", alice, { status: "suspended" }],
    ["admin PATCH owner's row {status: suspended}", "PATCH", carol, { status: "suspended" }],
    ["admin DELETE owner's row", "DELETE", carol, null],
    ["owner DELETE own row", "DELETE", alice, null],
  ];
  for (const [label, method, tok, body] of attempts) {
    [s, r] = await api(method, `${MEMBERS}/${OWN}`, tok, body);
    const field = body ? Object.keys(body)[0] : "user";
    console.log(`     ${label} → ${s} ${py_repr(r.message ?? "")}`);
    check(
      `${label} → 409 last_active_owner`,
      tup(s, code(r, field)),
      tup(409, "last_active_owner"),
    );
  }
  const after = await row_of(ALICE_WS, alice_id);
  check(
    "the owner's row is still admin and active",
    tup(after?.role ?? null, after?.status ?? null),
    tup("admin", "active"),
  );
  [s, r] = await api("PATCH", `${MEMBERS}/${OWN}`, su, { role: "member" });
  check(
    "an operator (superuser) may still change it → 200",
    tup(s, r.role ?? null),
    tup(200, "member"),
  );
  [s, r] = await api("PATCH", `${MEMBERS}/${OWN}`, su, { role: "admin" });
  check("and put it back → 200 admin", tup(s, r.role ?? null), tup(200, "admin"));
  const BOB_ROW = getitem(await row_of(ALICE_WS, bob_id), "id");
  [s, r] = await api("PATCH", `${MEMBERS}/${BOB_ROW}`, alice, { role: "viewer" });
  check(
    "control: owner demotes bob's row → 200 viewer",
    tup(s, r.role ?? null),
    tup(200, "viewer"),
  );
  [s, r] = await api("PATCH", `${MEMBERS}/${BOB_ROW}`, alice, { role: "member" });
  check(
    "control: owner restores bob's row → 200 member",
    tup(s, r.role ?? null),
    tup(200, "member"),
  );

  console.log("\n── after a transfer the protection moves to the new owner ──");
  [s] = await api("POST", MEMBERS, su, {
    workspace: WS2,
    user: carol_id,
    role: "admin",
    status: "active",
  });
  check("fixture: carol joins Second as an active admin", s, 200);
  // COVERS: route:POST /api/tracker/workspaces/{id}/transfer-ownership
  [s, r] = await api("POST", `/api/tracker/workspaces/${WS2}/transfer-ownership`, alice, {
    user: carol_id,
  });
  check("alice hands Second to carol → 200", s, 200);
  const carol_row = getitem(await row_of(WS2, carol_id), "id");
  const alice_row = getitem(await row_of(WS2, alice_id), "id");
  [s, r] = await api("PATCH", `${MEMBERS}/${carol_row}`, carol, { status: "suspended" });
  console.log(`     new owner PATCH own row {status: suspended} → ${s}`);
  check(
    "new owner PATCH own row {status: suspended} → 409",
    tup(s, code(r, "status")),
    tup(409, "last_active_owner"),
  );
  [s, r] = await api("DELETE", `${MEMBERS}/${carol_row}`, alice);
  console.log(`     previous owner (now admin) DELETE new owner's row → ${s}`);
  check(
    "previous owner (now admin) DELETE new owner's row → 409",
    tup(s, code(r, "user")),
    tup(409, "last_active_owner"),
  );
  [s, r] = await api("PATCH", `${MEMBERS}/${alice_row}`, carol, { role: "member" });
  console.log(`     new owner PATCH previous owner's row {role: member} → ${s}`);
  check(
    "new owner PATCH previous owner's row {role: member} → 200",
    tup(s, r.role ?? null),
    tup(200, "member"),
  );
  [s, r] = await api("PATCH", `${MEMBERS}/${alice_row}`, carol, { status: "suspended" });
  check(
    "new owner suspends the previous owner's row → 200",
    tup(s, r.status ?? null),
    tup(200, "suspended"),
  );

  console.log("\n── a membership or invitation created without a role is a member ──");
  [s, r] = await api("POST", MEMBERS, su, { workspace: WS2, user: bob_id, status: "active" });
  console.log(`     superuser membership create without role → ${s} ${py_repr(r.message ?? "")}`);
  check(
    "superuser membership create without role → 200 member",
    tup(s, r.role ?? null),
    tup(200, "member"),
  );
  const BOB_WS2_ROW: string = r.id ?? "missing";
  // COVERS: route:POST /api/tracker/workspaces/{id}/resolve-member-email
  [s, r] = await api("POST", `/api/tracker/workspaces/${ALICE_WS}/resolve-member-email`, carol, {
    email: "dora@example.com",
  });
  check("admin invites dora without a role → 200", s, 200);
  const inv = (
    await find_by_filter("workspace_invitations", "email_key='dora@example.com'", su)
  )[0];
  check("dora's invitation reads back role member", inv?.role ?? null, "member");
  const DORA_INV: string = inv?.id ?? "missing";
  [s] = await api("POST", "/api/collections/users/records", su, {
    email: "dora@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Dora",
    verified: true,
    approved: true,
  });
  check("fixture: dora signs up", s, 200);
  const [dora, dora_id] = await login("dora@example.com");
  [s, r] = await api("POST", `/api/tracker/invitations/${DORA_INV}/accept`, dora);
  check("dora accepts → 200 member", tup(s, r.role ?? null), tup(200, "member"));
  const dora_row = await row_of(ALICE_WS, dora_id);
  check("dora's membership row reads back role member", dora_row?.role ?? null, "member");

  console.log("\n── an owner handed a member row may raise it, never lower it ──");
  [s] = await api("POST", `/api/tracker/workspaces/${WS2}/transfer-ownership`, carol, {
    user: bob_id,
  });
  check("carol hands Second to bob, whose row is member → 200", s, 200);
  const [bob] = await login("bob@example.com");
  [s, r] = await api("PATCH", `${MEMBERS}/${BOB_WS2_ROW}`, bob, { role: "viewer" });
  check(
    "new owner PATCH own member row {role: viewer} → 409",
    tup(s, code(r, "role")),
    tup(409, "last_active_owner"),
  );
  [s, r] = await api("PATCH", `${MEMBERS}/${BOB_WS2_ROW}`, bob, { role: "admin" });
  check(
    "new owner PATCH own member row {role: admin} → 200",
    tup(s, r.role ?? null),
    tup(200, "admin"),
  );
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all owner-row proofs passed");
  process.exit(0);
}

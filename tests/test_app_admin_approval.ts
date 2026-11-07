#!/usr/bin/env bun
/**
 * E2E proof of the in-app account-approval path (TASK-017.21, decision:signup-approval): an
 * app administrator lists accounts awaiting approval and approves one, after which
 * that account's login flips 403 -> 200; every non-app-admin caller — including a
 * workspace OWNER of their own auto-provisioned workspace — gets 404 on both routes,
 * and users.updateRule's `approved:isset` guard is left intact.
 *
 * Self-contained clean-room server (--hooksDir from a pb_hooks copy; the routes under test live
 * there), APP_ADMIN_EMAILS injected into the server process, scripts/seed.ts
 * fixtures. Port 8109 + PB_PORT_OFFSET — 8100+ suite self-boot band (.agents/rules/ports.md),
 * distinct from the ports claimed by test_labels/test_statuses/test_comments/test_search/
 * test_productivity_flow/test_user_settings_font/test_vocab_upsert/test_realtime/
 * test_signup.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decode_text,
  getitem,
  py_repr,
  py_str,
  splitlines,
  truthy,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8109 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

const LIST_URL = "/api/tracker/admin/pending-users";

// Mixed case + padding + a second entry that matches no account: the gate must
// normalize before comparing, and must not admit an empty entry.
const APP_ADMIN_EMAILS = " Alice@Example.COM ,nobody@example.com,";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

let server: Bun.Subprocess | null = null;
let server_log_fd: number | null = null;

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
  _retried = false,
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
    // macOS hooksDir-watcher restart drops the listener mid-run (HANDOFF Testing
    // gotcha); refused = the request never reached a listener, so one retry after
    // re-health is safe even for creates.
    if (_retried || (e as { code?: unknown } | null)?.code !== "ECONNREFUSED") throw e;
    console.log(
      `  ⚠️  connection refused on ${method} ${path} — server restarting? re-health + one retry`,
    );
    await roomkit.wait_for_health(BASE_URL, server!);
    return api(method, path, token, body, true);
  }
  return [r.status, raw ? JSON.parse(raw) : {}];
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<string | null> {
  const qs = urlencode({ filter: `${field}='${esc(value)}'`, perPage: 200 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? getitem(items[0], "id") : null;
}

// The suite stays under the 10/60s users auth-with-password rate limit
// (the app_settings rate limits) — every call below is counted, budget is 8.
async function login(email: string): Promise<[number, string | null]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [s, r.token ?? null];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token ?? null;
  if (!tok) {
    throw new Error(`superuser auth failed: ${py_str(r)}`);
  }
  return tok;
}

async function su_create_user(
  su: string,
  name: string,
  email: string,
  verified: boolean,
  approved: boolean,
): Promise<string | null> {
  const [s, r] = await api("POST", "/api/collections/users/records", su, {
    email: email,
    password: "test123456",
    passwordConfirm: "test123456",
    name: name,
    verified: verified,
    approved: approved,
  });
  check(
    `(fixture) ${name} created verified=${py_str(verified)} approved=${py_str(approved)}`,
    s,
    200,
  );
  return r.id ?? null;
}

async function su_read_user(su: string, uid: string | null): Promise<any> {
  const [, r] = await api("GET", `/api/collections/users/records/${uid}`, su);
  return r;
}

async function start_server(data_dir: string, migrations_dir: string): Promise<Bun.Subprocess> {
  // APP_ADMIN_EMAILS is only readable by the hooks if it is in the SERVER's
  // environment — it is never a request input.
  const env = { ...process.env, APP_ADMIN_EMAILS: APP_ADMIN_EMAILS };
  await roomkit.require_free_port(PORT);
  server_log_fd = fs.openSync(path.join(S, "server.log"), "a"); // the server writes to it until stop_server
  const proc = Bun.spawn(
    [
      PB_BIN,
      "serve",
      `--http=127.0.0.1:${PORT}`,
      "--dir",
      data_dir,
      "--migrationsDir",
      migrations_dir,
      "--hooksDir",
      roomkit.hooks_dir(S),
    ],
    { cwd: REPO_ROOT, env: env, stdout: server_log_fd, stderr: server_log_fd },
  );
  server = proc;
  await roomkit.wait_for_health(BASE_URL, proc);
  await roomkit.require_own_room(PORT, proc);
  return proc;
}

async function stop_server(proc: Bun.Subprocess | null): Promise<void> {
  if (proc === null) return;
  proc.kill();
  const timeout = Symbol("timeout");
  if ((await Promise.race([proc.exited, Bun.sleep(10_000).then(() => timeout)])) === timeout) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  if (!(await roomkit.wait_for_port_free(PORT))) {
    console.log(`  ⚠️  port ${PORT} still occupied after stopping server`);
  }
}

function pending_ids(payload: any): any[] {
  return (payload.users || []).map((u: any) => u.id);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-app-admin-approval-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let crashed = false;
try {
  const up = Bun.spawnSync(
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
    { cwd: REPO_ROOT },
  );
  if (up.exitCode !== 0) {
    throw new Error(`Command failed with exit status ${up.exitCode}: ${up.stderr.toString()}`);
  }
  await start_server(DATA_DIR, MIG_DIR);
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

  // Alice is the ONLY account APP_ADMIN_EMAILS names; Bob owns his own seeded workspace
  // AND is promoted to admin of Alice's, Carol holds a plain member row — none of the
  // three workspace standings is an app admin.
  let s: number;
  let body: any;
  let alice: string | null;
  let bob: string | null;
  let carol: string | null;
  [s, alice] = await login("alice@example.com");
  check("(fixture) alice (the app administrator) logs in", s, 200);
  [s, bob] = await login("bob@example.com");
  check("(fixture) bob (owner of his OWN workspace, not an app admin) logs in", s, 200);
  [s, carol] = await login("carol@example.com");
  check("(fixture) carol (plain member, not an app admin) logs in", s, 200);

  const bob_id = await find_id("users", "email", "bob@example.com", su);
  const carol_id = await find_id("users", "email", "carol@example.com", su);
  const alice_ws = await find_id("workspaces", "name", "Alice's Workspace", su);
  const carol_ws = await find_id("workspaces", "name", "Carol's Workspace", su);
  const bob_ws_owner = await find_id("workspaces", "owner", bob_id!, su);
  check("(fixture) bob really owns an auto-provisioned workspace", truthy(bob_ws_owner), true);

  tierkit.use(api);
  const bob_owner = await tierkit.owner_of_workspace(bob_ws_owner!, bob_id!, su, "Bob");

  // Re-read at the denial: a lost ownership turns (3) from a role denial into tenancy.
  const bob_owns = async (): Promise<boolean> => (await bob_owner.now()) === bob_id;

  const bob_admin = await tierkit.actor_at_tier(alice_ws!, bob_id!, "admin", su, "Bob");
  const carol_member = await tierkit.actor_at_tier(carol_ws!, carol_id!, "member", su, "Carol");

  const tag = randomBytes(4).toString("hex");
  const a_email = `pending-a-${tag}@example.com`;
  const b_email = `pending-b-${tag}@example.com`;
  const c_email = `pending-c-${tag}@example.com`;
  const d_email = `pending-d-${tag}@example.com`;
  const a_id = await su_create_user(su, "Pending A", a_email, true, false);
  const b_id = await su_create_user(su, "Pending B", b_email, true, false);
  const c_id = await su_create_user(su, "Pending C", c_email, false, false);
  // approved but never confirmed — the defect this slice fixes (TASK-083): dropped
  // off the old "approved = false"-only filter while still unable to sign in.
  const d_id = await su_create_user(su, "Pending D", d_email, false, true);

  // ══════════════ (1) the app administrator sees the waiting accounts ══════════
  // COVERS: route:GET /api/tracker/admin/pending-users
  console.log("\n── (1) app administrator lists the accounts awaiting approval ──");
  [s, body] = await api("GET", LIST_URL, alice);
  check("(1) app admin GET pending list → 200", s, 200);
  const listed = pending_ids(body);
  check("(1) count matches the returned array", body.count, listed.length);
  check("(1) Pending A is listed", listed.includes(a_id), true);
  check("(1) Pending B is listed", listed.includes(b_id), true);
  check("(1) Pending C is listed", listed.includes(c_id), true);
  check(
    "(1) Pending D (approved but unverified) is listed (TASK-083)",
    listed.includes(d_id),
    true,
  );
  check(
    "(1) an APPROVED account is NOT listed",
    listed.includes(await find_id("users", "email", "alice@example.com", su)),
    false,
  );
  const row_a = (body.users || []).find((u: any) => u.id === a_id) ?? {};
  // users.email is hidden on other people's records over the collection API — the
  // route reads it server-side, so the surface can show who is waiting.
  check("(1) row carries the waiting account's email", row_a.email, a_email);
  check("(1) row carries the waiting account's name", row_a.name, "Pending A");
  check("(1) row reports email-confirmation state (A confirmed)", row_a.verified, true);
  check("(1) row reports approval state (A not yet approved)", row_a.approved, false);
  const row_c = (body.users || []).find((u: any) => u.id === c_id) ?? {};
  check("(1) row reports email-confirmation state (C not confirmed)", row_c.verified, false);
  const row_d = (body.users || []).find((u: any) => u.id === d_id) ?? {};
  check("(1) row reports approval state (D already approved, unverified)", row_d.approved, true);
  check("(1) row carries a signup timestamp", truthy(row_a.created), true);

  // ══════════════ (2) THE LOGIN TRANSITION: 403 before, 200 after ══════════════
  // COVERS: route:POST /api/tracker/admin/pending-users/{id}/approve
  console.log("\n── (2) approve Pending A → their login flips 403 → 200 ──");
  [s] = await login(a_email);
  check("(2) BEFORE: Pending A login → 403 (authRule: approved=false)", s, 403);

  [s, body] = await api("POST", `${LIST_URL}/${a_id}/approve`, alice);
  check("(2) app admin POST approve → 200", s, 200);
  check("(2) approve response echoes the account id", body.id, a_id);
  check("(2) approve response reports approved", body.approved, true);
  check(
    "(2) users.approved re-read from the record is true",
    (await su_read_user(su, a_id)).approved,
    true,
  );

  let a_token: string | null;
  [s, a_token] = await login(a_email);
  check("(2) AFTER: Pending A login → 200 (same credentials, no dashboard step)", s, 200);
  check("(2) AFTER: login returned a usable token", truthy(a_token), true);

  [s, body] = await api("GET", LIST_URL, alice);
  check("(2) approved account drops off the waiting list", pending_ids(body).includes(a_id), false);

  // ══════════ (3) approval is APP-level: no workspace role confers it ══════════
  console.log("\n── (3) decision:signup-approval: workspace owner/admin/member are all denied ──");
  [s, body] = await api("GET", LIST_URL, bob);
  check(
    "(3) workspace OWNER+ADMIN (bob) GET pending list → 404",
    tup(await bob_owns(), await bob_admin.now(), s),
    tup(true, "admin", 404),
  );
  check("(3) …and the 404 body leaks no account data", Object.hasOwn(body, "users"), false);
  [s] = await api("GET", LIST_URL, carol);
  check(
    "(3) workspace MEMBER (carol) GET pending list → 404",
    tup(await carol_member.now(), s),
    tup("member", 404),
  );
  [s] = await api("GET", LIST_URL, null);
  check("(3) anonymous GET pending list → 401", s, 401);

  [s] = await api("POST", `${LIST_URL}/${b_id}/approve`, bob);
  check(
    "(3) workspace OWNER+ADMIN (bob) POST approve → 404",
    tup(await bob_owns(), await bob_admin.now(), s),
    tup(true, "admin", 404),
  );
  [s] = await api("POST", `${LIST_URL}/${b_id}/approve`, carol);
  check(
    "(3) workspace MEMBER (carol) POST approve → 404",
    tup(await carol_member.now(), s),
    tup("member", 404),
  );
  [s] = await api("POST", `${LIST_URL}/${b_id}/approve`, null);
  check("(3) anonymous POST approve → 401", s, 401);
  [s] = await api("POST", `${LIST_URL}/${b_id}/approve`, a_token);
  check("(3) a just-approved ordinary account POST approve → 404", s, 404);

  check(
    "(3) Pending B is STILL unapproved after every denied attempt",
    (await su_read_user(su, b_id)).approved,
    false,
  );
  [s] = await login(b_email);
  check("(3) Pending B login still → 403 (the escalation path is closed)", s, 403);

  console.log("\n── (3b) users.updateRule's `approved:isset` guard is untouched ──");
  [s] = await api("PATCH", `/api/collections/users/records/${bob_id}`, bob, { approved: true });
  check("(3b) bob PATCHing approved on his OWN record → 404 (isset guard)", s, 404);
  [s] = await api("PATCH", `/api/collections/users/records/${b_id}`, bob, { approved: true });
  check("(3b) bob PATCHing approved on ANOTHER record → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/users/records/${bob_id}`, bob, {
    name: "Bob Renamed",
  });
  check("(3b) …while a NON-approved field on his own record still PATCHes → 200", s, 200);

  // ══════════ (4) superuser passes the gate; unknown id is a 404 ═══════════════
  console.log("\n── (4) superuser passes the same gate; unknown ids 404 ──");
  [s, body] = await api("GET", LIST_URL, su);
  check("(4) superuser GET pending list → 200", s, 200);
  check("(4) superuser sees Pending B waiting", pending_ids(body).includes(b_id), true);
  [s] = await api("POST", `${LIST_URL}/doesnotexist999/approve`, alice);
  check("(4) app admin approve on an unknown id → 404", s, 404);
  [s] = await api("POST", `${LIST_URL}/doesnotexist999/approve`, bob);
  check("(4) non-app-admin approve on an unknown id → 404 (indistinguishable)", s, 404);

  // ══════════ (5) approving does not confirm anyone's email ════════════════════
  console.log("\n── (5) approval is only half the gate — it never sets verified ──");
  [s] = await api("POST", `${LIST_URL}/${c_id}/approve`, alice);
  check("(5) app admin approves the unconfirmed account → 200", s, 200);
  const rec_c = await su_read_user(su, c_id);
  check("(5) users.approved flipped to true", rec_c.approved, true);
  check("(5) users.verified was NOT touched", rec_c.verified, false);
  [s] = await login(c_email);
  check("(5) unconfirmed-but-approved login still → 403", s, 403);
  [s, body] = await api("GET", LIST_URL, alice);
  check(
    "(5) approved-but-unverified account does NOT drop off the waiting list",
    pending_ids(body).includes(c_id),
    true,
  );

  // ══════ (6) a 200-strong sticky (verified=false) population cannot starve a ══
  // ══════ genuine newcomer (approved=false) out of its OWN bound (TASK-083 follow-up) ══
  console.log("\n── (6) sticky unconfirmed accounts cannot starve a genuine newcomer ──");
  let sticky_ok = 0;
  for (let i = 0; i < 200; i++) {
    [s] = await api("POST", "/api/collections/users/records", su, {
      email: `sticky-${tag}-${i}@example.com`,
      password: "test123456",
      passwordConfirm: "test123456",
      name: `Sticky ${i}`,
      verified: false,
      approved: true,
    });
    if (s === 200) sticky_ok += 1;
  }
  check(
    "(6) 200 abandoned unconfirmed accounts seeded (superuser bypasses the create rate limit)",
    sticky_ok,
    200,
  );

  const newcomer_email = `newcomer-${tag}@example.com`;
  const newcomer_id = await su_create_user(su, "Newcomer", newcomer_email, true, false);
  [s, body] = await api("GET", LIST_URL, alice);
  check("(6) app admin GET pending list → 200", s, 200);
  check(
    "(6) newcomer is STILL listed despite 200 older sticky unconfirmed accounts",
    pending_ids(body).includes(newcomer_id),
    true,
  );

  await tierkit.verify_tiers();
} catch (e) {
  crashed = true;
  throw e;
} finally {
  await stop_server(server);
  if (server_log_fd !== null) fs.closeSync(server_log_fd);
  if (failures || crashed) {
    const log_path = path.join(S, "server.log");
    if (fs.existsSync(log_path)) {
      const tail = splitlines(
        decode_text(new Uint8Array(fs.readFileSync(log_path)), "replace"),
      ).slice(-40);
      console.log("── server.log tail (suite failed; scratch dir is about to be removed) ──");
      for (const line of tail) {
        console.log(`  ${line}`);
      }
    }
  }
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all app-admin approval proofs passed");
  process.exit(0);
}

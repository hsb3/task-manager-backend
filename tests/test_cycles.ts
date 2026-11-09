#!/usr/bin/env bun
/**
 * E2E proof of the K5 `cycles` collection: role-tiered CRUD, workspace-scope isolation,
 * the default two-week span, the range guard, the overlap guard, workspace immutability,
 * assigning a task to a cycle (same-workspace only, project-preserving, view-filterable), and
 * the end-of-cycle rollover of unfinished work (§9, driven through the superuser route
 * and, in §9n, through the registered cron job itself).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy (the cycle hooks
 * under test live there), scripts/seed.ts fixtures. Port 8117 + PB_PORT_OFFSET (suite
 * self-boot band per .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  py_repr,
  read_text,
  run_checked,
  splitlines,
  tup,
  urlencode,
  truthy,
  sqlite_connect,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8117 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

// Dates are sent in the stored format so a comparison against the response is byte-exact.
const JAN5 = "2026-01-05 00:00:00.000Z";
const JAN19 = "2026-01-19 00:00:00.000Z";
const JAN10 = "2026-01-10 00:00:00.000Z";
const JAN20 = "2026-01-20 00:00:00.000Z";
const JAN25 = "2026-01-25 00:00:00.000Z";
const FEB3 = "2026-02-03 00:00:00.000Z";
const MAR5 = "2026-03-05 00:00:00.000Z";
const MAR1 = "2026-03-01 00:00:00.000Z";
const APR2027 = "2027-04-01 00:00:00.000Z";

// §9 needs dates relative to the server's clock. Read once: a run crossing midnight UTC must
// not shift a fixture date out from under an assertion made about it.
const _now = new Date();
const TODAY = Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate());

// §9n drives the cron job, which returns 204 BEFORE its sweep runs, so its outcome is polled.
const CRON_POLL_DEADLINE_S = 20.0;
const CRON_POLL_INTERVAL_S = 0.1;

let failures = 0;

/** A cycle date `offset` days from today, in the stored midnight-UTC format. */
function day(offset: number): string {
  return new Date(TODAY + offset * 86400000).toISOString().slice(0, 10) + " 00:00:00.000Z";
}

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
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

tierkit.use(api);

function esc(value: string): string {
  return value.replaceAll("'", "\\'");
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

async function status_id(ws_id: string, name: string, token: string): Promise<string | null> {
  const items = await find_by_filter(
    "statuses",
    `workspace='${esc(ws_id)}' && name='${esc(name)}'`,
    token,
  );
  return items.length ? items[0].id : null;
}

async function list_cycles(ws_id: string, token: string | null): Promise<[number, any[]]> {
  const qs = urlencode({ filter: `workspace='${esc(ws_id)}'`, perPage: 200 });
  const [s, r] = await api("GET", `/api/collections/cycles/records?${qs}`, token);
  return [s, r.items || []];
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(BASE_URL, email, r), r.record.id];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  return roomkit.token_of(BASE_URL, SU_EMAIL, r);
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cycles-test-"));
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
  const [carol] = await login("carol@example.com");

  const ALICE_WS = (await find_id("workspaces", "name", "Alice's Workspace", alice)) as string;
  const BOB_WS = (await find_id("workspaces", "name", "Bob's Workspace", bob)) as string;
  check("(fixture) resolved Alice's workspace", truthy(ALICE_WS), true);
  check("(fixture) resolved Bob's workspace", truthy(BOB_WS), true);

  let s: number;
  let r: any;

  // ══════════════════ 1. CRUD × role matrix ══════════════════════════════════
  // COVERS: rule:cycles.create, rule:cycles.update, rule:cycles.delete, rule:cycles.list, rule:cycles.view
  console.log("\n── (1) OWNER (Alice): create/update/delete ──");
  const owns_a = await tierkit.owner_of_workspace(ALICE_WS, alice_id, su, "Alice");
  let made: any;
  [s, made] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Owner Cycle",
    starts_on: "2026-04-01 00:00:00.000Z",
  });
  check("Alice (owner) creates a cycle", tup(await owns_a.now(), s), tup(alice_id, 200));
  const owner_cycle_id = made.id;
  [s, r] = await api("PATCH", `/api/collections/cycles/records/${owner_cycle_id}`, alice, {
    name: "Owner Cycle Renamed",
  });
  check("Alice (owner) renames it", s, 200);
  check("rename took effect", r.name, "Owner Cycle Renamed");
  [s] = await api("DELETE", `/api/collections/cycles/records/${owner_cycle_id}`, alice);
  check("Alice (owner) deletes it (hard delete, no trash)", s, 204);
  [s] = await api("GET", `/api/collections/cycles/records/${owner_cycle_id}`, su);
  check("the deleted cycle is GONE for the superuser too (not trashed)", s, 404);

  console.log("\n── (1) ADMIN (Bob promoted to admin): create/update/delete ──");
  let bob_tier = await tierkit.actor_at_tier(ALICE_WS, bob_id, "admin", alice, "Bob");
  [s, made] = await api("POST", "/api/collections/cycles/records", bob, {
    workspace: ALICE_WS,
    name: "Admin Cycle",
    starts_on: "2026-05-01 00:00:00.000Z",
  });
  check("Bob (admin) creates a cycle", tup(await bob_tier.now(), s), tup("admin", 200));
  const admin_cycle_id = made.id;
  [s] = await api("PATCH", `/api/collections/cycles/records/${admin_cycle_id}`, bob, {
    name: "Admin Cycle Renamed",
  });
  check("Bob (admin) renames it", tup(await bob_tier.now(), s), tup("admin", 200));
  [s] = await api("DELETE", `/api/collections/cycles/records/${admin_cycle_id}`, bob);
  check("Bob (admin) deletes it", tup(await bob_tier.now(), s), tup("admin", 204));

  // One probe target and one create window PER denied actor: sharing either would let a
  // hijack that succeeded (or the overlap guard refusing the second attempt) answer the
  // next actor's check, so a rules regression could read as a denial.
  const targets: Record<string, string> = {};
  for (const [who, month] of [
    ["member", "06"],
    ["viewer", "07"],
    ["carol", "08"],
    ["anon", "09"],
    ["suspended", "05"],
  ]) {
    let target: any;
    [s, target] = await api("POST", "/api/collections/cycles/records", alice, {
      workspace: ALICE_WS,
      name: `Target for ${who}`,
      starts_on: `2026-${month}-01 00:00:00.000Z`,
    });
    check(`(fixture) Alice creates the ${who} probe target`, s, 200);
    targets[who] = target.id;
  }

  for (const [role, month] of [
    ["member", "10"],
    ["viewer", "11"],
  ]) {
    console.log(`\n── (1) ${role.toUpperCase()} (Bob): write denied, read allowed ──`);
    bob_tier = await tierkit.actor_at_tier(ALICE_WS, bob_id, role, alice, "Bob");
    const target_id = targets[role];
    [s] = await api("POST", "/api/collections/cycles/records", bob, {
      workspace: ALICE_WS,
      name: `${role} Attempt`,
      starts_on: `2026-${month}-01 00:00:00.000Z`,
    });
    check(`Bob (${role}) create → denied`, tup(await bob_tier.now(), s), tup(role, 400));
    check(
      `Bob (${role}) create left nothing behind`,
      tup(await bob_tier.now(), await find_id("cycles", "name", `${role} Attempt`, su)),
      tup(role, null),
    );
    [s] = await api("PATCH", `/api/collections/cycles/records/${target_id}`, bob, {
      name: "hijacked",
    });
    check(`Bob (${role}) update → denied`, tup(await bob_tier.now(), s), tup(role, 404));
    [s] = await api("DELETE", `/api/collections/cycles/records/${target_id}`, bob);
    check(`Bob (${role}) delete → denied`, tup(await bob_tier.now(), s), tup(role, 404));
    let items: any[];
    [s, items] = await list_cycles(ALICE_WS, bob);
    check(`Bob (${role}) list → 200`, tup(await bob_tier.now(), s), tup(role, 200));
    check(
      `Bob (${role}) list sees the ${role} target`,
      tup(await bob_tier.now(), items.map((i) => i.id).includes(target_id)),
      tup(role, true),
    );
    [s, r] = await api("GET", `/api/collections/cycles/records/${target_id}`, bob);
    check(`Bob (${role}) view → 200`, tup(await bob_tier.now(), s), tup(role, 200));
    check(
      `Bob (${role}) target survived both write attempts`,
      tup(await bob_tier.now(), r.name),
      tup(role, `Target for ${role}`),
    );
  }

  console.log("\n── (1) NON-MEMBER (Carol) ──");
  let items: any[];
  [s, items] = await list_cycles(ALICE_WS, carol);
  check("Carol (non-member) list Alice-ws cycles → 200 empty", tup(s, items), tup(200, []));
  [s] = await api("GET", `/api/collections/cycles/records/${targets.carol}`, carol);
  check("Carol (non-member) view → 404", s, 404);
  [s] = await api("POST", "/api/collections/cycles/records", carol, {
    workspace: ALICE_WS,
    name: "Carol Attempt",
    starts_on: "2026-12-01 00:00:00.000Z",
  });
  check("Carol (non-member) create → 400", s, 400);
  check(
    "Carol (non-member) create left nothing behind",
    await find_id("cycles", "name", "Carol Attempt", su),
    null,
  );
  [s] = await api("PATCH", `/api/collections/cycles/records/${targets.carol}`, carol, {
    name: "x",
  });
  check("Carol (non-member) update → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/cycles/records/${targets.carol}`, carol);
  check("Carol (non-member) delete → 404", s, 404);
  [s, r] = await api("GET", `/api/collections/cycles/records/${targets.carol}`, su);
  check("Carol's target survived every attempt", r.name, "Target for carol");

  console.log("\n── (1) ANON ──");
  [s, items] = await list_cycles(ALICE_WS, null);
  check("Anon list Alice-ws cycles → 200 empty", tup(s, items), tup(200, []));
  [s] = await api("GET", `/api/collections/cycles/records/${targets.anon}`, null);
  check("Anon view → 404", s, 404);
  [s] = await api("POST", "/api/collections/cycles/records", null, {
    workspace: ALICE_WS,
    name: "Anon Cycle",
    starts_on: "2027-01-01 00:00:00.000Z",
  });
  check("Anon create → 400", s, 400);
  check("Anon create left nothing behind", await find_id("cycles", "name", "Anon Cycle", su), null);
  [s] = await api("PATCH", `/api/collections/cycles/records/${targets.anon}`, null, { name: "x" });
  check("Anon update → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/cycles/records/${targets.anon}`, null);
  check("Anon delete → 404", s, 404);
  [s, r] = await api("GET", `/api/collections/cycles/records/${targets.anon}`, su);
  check("the anon target survived every attempt", r.name, "Target for anon");

  console.log("\n── (1) SUSPENDED ADMIN (Bob): an inactive membership confers nothing ──");
  // Suspended at the ADMIN role on purpose: the only thing left denying him is the status,
  // so a rules regression that dropped the status conjunct cannot read as a role denial.
  bob_tier = await tierkit.actor_at_tier(ALICE_WS, bob_id, "admin", alice, "Bob");
  const standing = async () => tup(...(await bob_tier.standing()));
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_tier.id}`, alice, {
    status: "suspended",
  });
  check(
    "setup: Bob is an ADMIN whose membership is suspended",
    tup(s, await standing()),
    tup(200, tup("admin", "suspended")),
  );
  [s, items] = await list_cycles(ALICE_WS, bob);
  check(
    "Bob (suspended admin) list → 200 empty",
    tup(await standing(), s, items),
    tup(tup("admin", "suspended"), 200, []),
  );
  [s] = await api("GET", `/api/collections/cycles/records/${targets.suspended}`, bob);
  check(
    "Bob (suspended admin) view → 404",
    tup(await standing(), s),
    tup(tup("admin", "suspended"), 404),
  );
  [s] = await api("POST", "/api/collections/cycles/records", bob, {
    workspace: ALICE_WS,
    name: "Suspended Attempt",
    starts_on: "2027-02-01 00:00:00.000Z",
  });
  check(
    "Bob (suspended admin) create → 400",
    tup(await standing(), s),
    tup(tup("admin", "suspended"), 400),
  );
  check(
    "Bob (suspended admin) create left nothing behind",
    await find_id("cycles", "name", "Suspended Attempt", su),
    null,
  );
  [s] = await api("PATCH", `/api/collections/cycles/records/${targets.suspended}`, bob, {
    name: "hijacked",
  });
  check(
    "Bob (suspended admin) update → 404",
    tup(await standing(), s),
    tup(tup("admin", "suspended"), 404),
  );
  [s] = await api("DELETE", `/api/collections/cycles/records/${targets.suspended}`, bob);
  check(
    "Bob (suspended admin) delete → 404",
    tup(await standing(), s),
    tup(tup("admin", "suspended"), 404),
  );
  [s, r] = await api("GET", `/api/collections/cycles/records/${targets.suspended}`, su);
  check("the suspended-admin target survived every attempt", r.name, "Target for suspended");
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${bob_tier.id}`, alice, {
    status: "active",
  });
  check(
    "cleanup: Bob's membership is active again",
    tup(s, await standing()),
    tup(200, tup("admin", "active")),
  );

  // ══════════════════ 2. Workspace-scope isolation ════════════════════════════
  console.log("\n── (2) a member of workspace A neither sees nor writes workspace B's cycles ──");
  const owns_b = await tierkit.owner_of_workspace(BOB_WS, bob_id, su, "Bob");
  let foreign: any;
  [s, foreign] = await api("POST", "/api/collections/cycles/records", bob, {
    workspace: BOB_WS,
    name: "Bob WS Cycle",
    starts_on: JAN5,
  });
  check("Bob (owner of ws B) creates a cycle there", tup(await owns_b.now(), s), tup(bob_id, 200));
  const foreign_id = foreign.id;
  [s, items] = await list_cycles(BOB_WS, alice);
  check("Alice list ws-B cycles → 200 empty", tup(s, items), tup(200, []));
  [s] = await api("GET", `/api/collections/cycles/records/${foreign_id}`, alice);
  check("Alice view a ws-B cycle → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/cycles/records/${foreign_id}`, alice, { name: "x" });
  check("Alice update a ws-B cycle → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/cycles/records/${foreign_id}`, alice);
  check("Alice delete a ws-B cycle → 404", s, 404);
  [s] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: BOB_WS,
    name: "Alice In Bobs WS",
    starts_on: MAR1,
  });
  check("Alice create a cycle IN ws B → 400", s, 400);

  // ══════════════════ 3. Default two-week span ════════════════════════════════
  // COVERS: hook:cycles.pb.js#onRecordCreate:cycles
  console.log("\n── (3) default span: a create without ends_on gets starts_on plus 14 days ──");
  let c1: any;
  [s, c1] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Cycle 1",
    starts_on: JAN5,
  });
  check("default span: create with starts_on only → 200", s, 200);
  check("default span: ends_on is starts_on plus 14 days", c1.ends_on, JAN19);
  const c1_id = c1.id;
  let custom: any;
  [s, custom] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Custom Span",
    starts_on: MAR1,
    ends_on: MAR5,
  });
  check(
    "default span: a submitted ends_on is kept, not overwritten",
    tup(s, custom.ends_on),
    tup(200, MAR5),
  );
  [s] = await api("DELETE", `/api/collections/cycles/records/${custom.id}`, alice);
  check("cleanup: custom-span fixture removed", s, 204);

  // ══════════════════ 4. Range guard ══════════════════════════════════════════
  console.log("\n── (4) range refused: ends_on must be strictly after starts_on ──");
  for (const [label, ends] of [
    ["equal to", MAR1],
    ["before", "2026-02-20 00:00:00.000Z"],
  ]) {
    [s, r] = await api("POST", "/api/collections/cycles/records", alice, {
      workspace: ALICE_WS,
      name: `Bad ${label}`,
      starts_on: MAR1,
      ends_on: ends,
    });
    check(`range refused on CREATE: ends_on ${label} starts_on → 400`, s, 400);
    check(
      `range refusal on CREATE (${label}) names the RANGE guard, not the overlap one`,
      (r.message ?? "").toLowerCase().includes("must end after the day it starts"),
      true,
    );
    check(
      `range refused on CREATE (${label}): nothing persisted`,
      await find_id("cycles", "name", `Bad ${label}`, su),
      null,
    );
  }
  [s, r] = await api("PATCH", `/api/collections/cycles/records/${c1_id}`, alice, {
    ends_on: "2026-01-01 00:00:00.000Z",
  });
  check("range refused on UPDATE: ends_on moved before starts_on → 400", s, 400);
  [s, r] = await api("PATCH", `/api/collections/cycles/records/${c1_id}`, alice, { ends_on: "" });
  check("range refused on UPDATE: clearing ends_on → 400", s, 400);
  [s, r] = await api("GET", `/api/collections/cycles/records/${c1_id}`, alice);
  check("range refused on UPDATE: the stored span is untouched", r.ends_on, JAN19);

  // ══════════════════ 5. Overlap guard ════════════════════════════════════════
  // COVERS: hook:cycles.pb.js#onRecordUpdate:cycles
  console.log("\n── (5) overlap refused: one workspace runs one cycle at a time ──");
  [s, r] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Overlapper",
    starts_on: JAN10,
    ends_on: JAN25,
  });
  check("overlap refused on CREATE: a span crossing Cycle 1 → 400", s, 400);
  check(
    "overlap refusal on CREATE names the OVERLAP guard, not the range one",
    (r.message ?? "").toLowerCase().includes("run into another cycle"),
    true,
  );
  check(
    "overlap refused on CREATE: nothing persisted",
    await find_id("cycles", "name", "Overlapper", su),
    null,
  );
  let c2: any;
  [s, c2] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Cycle 2",
    starts_on: JAN20,
  });
  check("adjacent cycle starting the day after Cycle 1 ends → 200", s, 200);
  check("adjacent cycle got its own default span", c2.ends_on, FEB3);
  const c2_id = c2.id;
  [s] = await api("PATCH", `/api/collections/cycles/records/${c2_id}`, alice, {
    starts_on: JAN10,
  });
  check("overlap refused on UPDATE: dragging Cycle 2 back into Cycle 1 → 400", s, 400);
  [s, r] = await api("GET", `/api/collections/cycles/records/${c2_id}`, alice);
  check("overlap refused on UPDATE: the stored start is untouched", r.starts_on, JAN20);
  [s] = await api("PATCH", `/api/collections/cycles/records/${c2_id}`, alice, {
    name: "Cycle 2 Renamed",
  });
  check("an update that leaves the dates alone still passes both guards", s, 200);

  console.log("\n── (5b) overlap is per WORKSPACE: ws B may run the same dates as ws A ──");
  let twin: any;
  [s, twin] = await api("POST", "/api/collections/cycles/records", bob, {
    workspace: BOB_WS,
    name: "Bob Twin Span",
    starts_on: JAN20,
    ends_on: FEB3,
  });
  check(
    "a ws-B cycle with a ws-A cycle's exact dates → 200",
    tup(await owns_b.now(), s),
    tup(bob_id, 200),
  );
  [s] = await api("DELETE", `/api/collections/cycles/records/${twin.id}`, bob);
  check("cleanup: ws-B twin-span fixture removed", s, 204);

  console.log("\n── (5c) a cycle is a CALENDAR-DAY object: submitted times are discarded ──");
  // Its own decade, so the day-granularity spans cannot brush any span above.
  let dayspan: any;
  [s, dayspan] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Day Span",
    starts_on: "2031-07-10 13:45:00.000Z",
    ends_on: "2031-07-24 09:15:00.000Z",
  });
  check("a create carrying a time of day → 200", s, 200);
  check(
    "the submitted time of day is discarded, both ends stored at midnight",
    tup(dayspan.starts_on, dayspan.ends_on),
    tup("2031-07-10 00:00:00.000Z", "2031-07-24 00:00:00.000Z"),
  );
  const dayspan_id = dayspan.id;
  [s, r] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "One Millisecond",
    starts_on: "2031-06-01 00:00:00.000Z",
    ends_on: "2031-06-01 00:00:00.001Z",
  });
  check("a span of ONE MILLISECOND is one day, so the range guard refuses it → 400", s, 400);
  check(
    "the millisecond refusal names the RANGE guard",
    (r.message ?? "").toLowerCase().includes("must end after the day it starts"),
    true,
  );
  check(
    "the millisecond span persisted nothing",
    await find_id("cycles", "name", "One Millisecond", su),
    null,
  );
  [s, r] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Half A Day",
    starts_on: "2031-06-05 00:00:00.000Z",
    ends_on: "2031-06-05 12:00:00.000Z",
  });
  check("an intraday span ending the same calendar day → 400", s, 400);
  check(
    "the intraday span persisted nothing",
    await find_id("cycles", "name", "Half A Day", su),
    null,
  );
  [s, r] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Same Day As Day Span Ends",
    starts_on: "2031-07-24 12:00:00.000Z",
    ends_on: "2031-08-01 00:00:00.000Z",
  });
  check("a cycle starting on the day another one ENDS → 400 (boundaries are inclusive)", s, 400);
  check(
    "the inclusive-boundary refusal names the OVERLAP guard",
    (r.message ?? "").toLowerCase().includes("run into another cycle"),
    true,
  );
  check(
    "the same-day starter persisted nothing",
    await find_id("cycles", "name", "Same Day As Day Span Ends", su),
    null,
  );
  let dayafter: any;
  [s, dayafter] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Day After Day Span",
    starts_on: "2031-07-25 18:30:00.000Z",
  });
  check("a cycle starting the calendar day AFTER another ends → 200", s, 200);
  check(
    "its defaulted span is exactly 14 midnight-to-midnight days",
    tup(dayafter.starts_on, dayafter.ends_on),
    tup("2031-07-25 00:00:00.000Z", "2031-08-08 00:00:00.000Z"),
  );
  [s, r] = await api("PATCH", `/api/collections/cycles/records/${dayspan_id}`, alice, {
    ends_on: "2031-07-25 23:59:59.000Z",
  });
  check("an UPDATE dragging an end onto the next cycle's start day → 400", s, 400);
  [s, r] = await api("GET", `/api/collections/cycles/records/${dayspan_id}`, alice);
  check("the refused update left the stored end day alone", r.ends_on, "2031-07-24 00:00:00.000Z");
  // The day stored is the UTC day: PocketBase converts an offset-bearing submission before
  // the hook reads the field, so the offset can carry the date to its neighbour.
  const offset_ids: string[] = [];
  for (const [label, submitted, stored] of [
    ["west of UTC, so the day rolls forward", "2027-05-01T23:30:00-05:00", "2027-05-02"],
    ["east of UTC, so the day rolls back", "2027-06-01T00:30:00+05:00", "2027-05-31"],
  ]) {
    let off: any;
    [s, off] = await api("POST", "/api/collections/cycles/records", alice, {
      workspace: ALICE_WS,
      name: `Offset ${stored}`,
      starts_on: submitted,
    });
    check(`a create carrying a UTC offset (${label}) → 200`, s, 200);
    check(
      `the day stored is the UTC day, not the submitted one (${label})`,
      off.starts_on,
      stored + " 00:00:00.000Z",
    );
    offset_ids.push(off.id);
  }

  for (const [label, rid] of [
    ["day-span", dayspan_id],
    ["day-after", dayafter.id],
    ["offset-forward", offset_ids[0]],
    ["offset-back", offset_ids[1]],
  ]) {
    [s] = await api("DELETE", `/api/collections/cycles/records/${rid}`, alice);
    check(`cleanup: ${label} fixture removed`, s, 204);
  }

  // ══════════════════ 6. Workspace immutability ═══════════════════════════════
  console.log("\n── (6) workspace immutable: an update that sends workspace is refused ──");
  [s] = await api("PATCH", `/api/collections/cycles/records/${c1_id}`, alice, {
    workspace: BOB_WS,
  });
  check("workspace immutable: re-tenanting a cycle → 404", s, 404);
  [s, r] = await api("GET", `/api/collections/cycles/records/${c1_id}`, alice);
  check("workspace immutable: the cycle still belongs to ws A", r.workspace, ALICE_WS);
  [s] = await api("PATCH", `/api/collections/cycles/records/${c1_id}`, alice, {
    workspace: ALICE_WS,
  });
  check("workspace immutable: resending the SAME workspace is refused too → 404", s, 404);

  // ══════════════════ 7. Assigning a task to a cycle ══════════════════════════
  // COVERS: hook:cycles.pb.js#onRecordCreate:tasks, hook:cycles.pb.js#onRecordUpdate:tasks
  console.log("\n── (7) assignment: a task carries a cycle of its OWN workspace ──");
  // Its own dates and its own probe targets: sharing either with §1-§6 would let the
  // overlap guard (which 400s every create) answer a tenancy check.
  let cyc_a: any;
  [s, cyc_a] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Assignment Cycle A",
    starts_on: APR2027,
  });
  check("(fixture) Alice creates the ws-A assignment cycle", s, 200);
  const cyc_a_id = cyc_a.id;
  let cyc_b: any;
  [s, cyc_b] = await api("POST", "/api/collections/cycles/records", bob, {
    workspace: BOB_WS,
    name: "Assignment Cycle B",
    starts_on: APR2027,
  });
  check(
    "(fixture) Bob creates the ws-B assignment cycle",
    tup(await owns_b.now(), s),
    tup(bob_id, 200),
  );
  const cyc_b_id = cyc_b.id;

  const proj_one = (await find_id("projects", "name", "Website Redesign", alice)) as string;
  check("(fixture) resolved Alice's seeded project", truthy(proj_one), true);
  let proj_two_rec: any;
  [s, proj_two_rec] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Cycle Second Project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  check("(fixture) Alice creates a SECOND project in ws A", s, 200);
  const proj_two = proj_two_rec.id;

  let task_one: any;
  [s, task_one] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Cycle Task One",
    workspace: ALICE_WS,
    project: proj_one,
  });
  check("(fixture) task one created in project one", s, 200);
  const task_one_id = task_one.id;
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${task_one_id}`, alice, {
    cycle: cyc_a_id,
  });
  check("assigning a same-workspace cycle → 200", s, 200);
  check("the assignment stuck", r.cycle, cyc_a_id);
  check("assigning a cycle leaves the task in its project", r.project, proj_one);

  let task_two: any;
  [s, task_two] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Cycle Task Two",
    workspace: ALICE_WS,
    project: proj_two,
    cycle: cyc_a_id,
  });
  check("a task in ANOTHER project takes the SAME cycle → 200", s, 200);
  const task_two_id = task_two.id;
  check(
    "one cycle spans two projects: both tasks hold it, each in its own project",
    tup(task_two.cycle, task_two.project, task_one.project),
    tup(cyc_a_id, proj_two, proj_one),
  );

  console.log("\n── (7b) cross-workspace refused: a ws-A task cannot take a ws-B cycle ──");
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Cross Workspace Create",
    workspace: ALICE_WS,
    project: proj_one,
    cycle: cyc_b_id,
  });
  check("cross-workspace cycle refused on CREATE → 400", s, 400);
  check(
    "cross-workspace refusal on CREATE speaks of the workspace",
    (r.message ?? "").toLowerCase().includes("workspace"),
    true,
  );
  check(
    "cross-workspace cycle refused on CREATE: nothing persisted",
    await find_id("tasks", "title", "Cross Workspace Create", su),
    null,
  );

  let task_three: any;
  [s, task_three] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Cycle Task Three",
    workspace: ALICE_WS,
    project: proj_one,
    cycle: cyc_a_id,
  });
  check("(fixture) task three created holding the ws-A cycle", s, 200);
  const task_three_id = task_three.id;
  [s] = await api("PATCH", `/api/collections/tasks/records/${task_three_id}`, alice, {
    cycle: cyc_b_id,
  });
  check("cross-workspace cycle refused on UPDATE → 400", s, 400);
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_three_id}`, alice);
  check(
    "the refused task survived, still in its project, still on the ws-A cycle",
    tup(s, r.cycle, r.project),
    tup(200, cyc_a_id, proj_one),
  );

  console.log("\n── (7c) the project_items view really filters by cycle ──");
  const in_cycle = await find_by_filter("project_items", `cycle='${esc(cyc_a_id)}'`, alice);
  check(
    "view filter by cycle returns exactly the tasks in that cycle",
    in_cycle.map((i) => i.id).sort(by_code_point),
    [task_one_id, task_two_id, task_three_id].sort(by_code_point),
  );
  // The ws-B cycle needs a task of its OWN before the next check means anything: an empty
  // result over a cycle nothing points at holds whether the filter works or not.
  let foreign_task: any;
  [s, foreign_task] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "Foreign Cycle Task",
    workspace: BOB_WS,
    project: await find_id("projects", "name", "Mobile App", bob),
    cycle: cyc_b_id,
  });
  check(
    "(fixture) Bob puts a ws-B task on the ws-B cycle",
    tup(await owns_b.now(), s),
    tup(bob_id, 200),
  );
  const foreign_task_id = foreign_task.id;
  check(
    "view filter by the OTHER workspace's cycle returns nothing",
    await find_by_filter("project_items", `cycle='${esc(cyc_b_id)}'`, alice),
    [],
  );
  check(
    "the same filter run by a ws-B member returns exactly that ws-B task",
    (await find_by_filter("project_items", `cycle='${esc(cyc_b_id)}'`, bob)).map((i) => i.id),
    [foreign_task_id],
  );

  console.log("\n── (7d) deleting a cycle clears the pointer and keeps every task ──");
  [s] = await api("DELETE", `/api/collections/cycles/records/${cyc_a_id}`, alice);
  check("Alice deletes the assignment cycle → 204", s, 204);
  for (const [label, tid] of [
    ["one", task_one_id],
    ["two", task_two_id],
    ["three", task_three_id],
  ]) {
    [s, r] = await api("GET", `/api/collections/tasks/records/${tid}`, alice);
    check(
      `deleting a cycle clears the pointer and keeps the task (${label})`,
      tup(s, r.cycle, r.title),
      tup(200, "", `Cycle Task ${label[0].toUpperCase()}${label.slice(1)}`),
    );
  }

  for (const tid of [task_one_id, task_two_id, task_three_id]) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, su);
    check(`cleanup: superuser removes tasks/${tid.slice(0, 8)}`, s, 204);
  }
  [s] = await api("DELETE", `/api/collections/projects/records/${proj_two}`, su);
  check("cleanup: superuser removes the second project", s, 204);
  [s] = await api("DELETE", `/api/collections/cycles/records/${cyc_b_id}`, su);
  check("cleanup: superuser removes the ws-B assignment cycle", s, 204);

  // A row made bad behind the hooks stays saveable on fields the guards do not check.
  // COVERS: hook:cycles.pb.js#onRecordUpdate:cycles, hook:cycles.pb.js#onRecordUpdate:tasks
  console.log("\n── (7e) an already-bad row still saves an unrelated field ──");
  const T_JAN1 = "2028-01-01 00:00:00.000Z";
  const T_JAN10 = "2028-01-10 00:00:00.000Z";
  const T_FEB1 = "2028-02-01 00:00:00.000Z";
  const T_FEB10 = "2028-02-10 00:00:00.000Z";
  const T_MAR1 = "2028-03-01 00:00:00.000Z";
  const T_MAR10 = "2028-03-10 00:00:00.000Z";
  const touch_ids: Record<string, string> = {};
  for (const [label, token, ws, starts, ends] of [
    ["span", alice, ALICE_WS, T_JAN1, T_JAN10],
    ["kept", alice, ALICE_WS, T_FEB1, T_FEB10],
    ["moved", alice, ALICE_WS, T_MAR1, T_MAR10],
    ["foreign", bob, BOB_WS, T_JAN1, T_JAN10],
  ] as const) {
    [s, r] = await api("POST", "/api/collections/cycles/records", token, {
      workspace: ws,
      name: `Touches Cycle ${label}`,
      starts_on: starts,
      ends_on: ends,
    });
    check(`(fixture) valid cycle '${label}' created`, s, 200);
    touch_ids[label] = r.id;
  }
  for (const label of ["bad", "clean"]) {
    [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `Touches Task ${label}`,
      workspace: ALICE_WS,
      project: proj_one,
      cycle: label === "bad" ? touch_ids.span : "",
    });
    check(`(fixture) valid task '${label}' created`, s, 200);
    touch_ids[`task_${label}`] = r.id;
  }
  const touch_db = sqlite_connect(path.join(DATA_DIR, "data.db"));
  try {
    touch_db.run("UPDATE tasks SET cycle = ? WHERE id = ?", [
      touch_ids.foreign!,
      touch_ids.task_bad!,
    ]);
    touch_db.run("UPDATE cycles SET ends_on = ? WHERE id = ?", [JAN5, touch_ids.span!]);
    touch_db.run("UPDATE cycles SET starts_on = ?, ends_on = ? WHERE id = ?", [
      "2028-02-05 00:00:00.000Z",
      "2028-02-15 00:00:00.000Z",
      touch_ids.moved!,
    ]);
  } finally {
    touch_db.close();
  }
  [s, r] = await api("GET", `/api/collections/tasks/records/${touch_ids.task_bad}`, su);
  check("(fixture) the task now points at another workspace's cycle", r.cycle, touch_ids.foreign);

  [s] = await api("PATCH", `/api/collections/tasks/records/${touch_ids.task_bad}`, alice, {
    title: "Touches Task bad, renamed by owner",
  });
  check("owner renames a task already on a foreign cycle → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/tasks/records/${touch_ids.task_bad}`, su, {
    title: "Touches Task bad, renamed by superuser",
  });
  check("superuser renames a task already on a foreign cycle → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/cycles/records/${touch_ids.span}`, alice, {
    name: "Touches Cycle span, renamed",
  });
  check("owner renames a cycle already ending before it starts → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/cycles/records/${touch_ids.moved}`, alice, {
    name: "Touches Cycle moved, renamed",
  });
  check("owner renames a cycle already overlapping another → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/cycles/records/${touch_ids.kept}`, su, {
    name: "Touches Cycle kept, renamed",
  });
  check("superuser renames the cycle that was overlapped → 200", s, 200);

  [s] = await api("PATCH", `/api/collections/tasks/records/${touch_ids.task_clean}`, alice, {
    cycle: touch_ids.foreign,
  });
  check("control: a save that MOVES a task onto a foreign cycle → 400", s, 400);
  // The range guard is registered first, so each refusal is told apart by its message.
  [s, r] = await api("PATCH", `/api/collections/cycles/records/${touch_ids.kept}`, alice, {
    ends_on: "2028-01-20 00:00:00.000Z",
  });
  check(
    "control: a save that sets an ends_on before starts_on → 400 (range)",
    tup(s, (r.message ?? "").includes("must end after")),
    tup(400, true),
  );
  [s, r] = await api("PATCH", `/api/collections/cycles/records/${touch_ids.kept}`, alice, {
    ends_on: "2028-02-12 00:00:00.000Z",
  });
  check(
    "control: a save that moves dates into another cycle → 400 (overlap)",
    tup(s, (r.message ?? "").includes("run into another cycle")),
    tup(400, true),
  );

  for (const tid of [touch_ids.task_bad, touch_ids.task_clean]) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, su);
    check(`cleanup: superuser removes tasks/${tid!.slice(0, 8)}`, s, 204);
  }
  for (const label of ["span", "kept", "moved", "foreign"]) {
    [s] = await api("DELETE", `/api/collections/cycles/records/${touch_ids[label]}`, su);
    check(`cleanup: superuser removes the '${label}' touches cycle`, s, 204);
  }

  // ══════════════════ 8. Cleanup ══════════════════════════════════════════════
  console.log("\n── (8) cleanup ──");
  for (const rid of [...Object.values(targets), c1_id, c2_id, foreign_id]) {
    [s] = await api("DELETE", `/api/collections/cycles/records/${rid}`, su);
    check(`cleanup: superuser removes cycles/${rid.slice(0, 8)}`, s, 204);
  }

  // ══════════════════ 9. Rollover at cycle end ════════════════════════════════
  // COVERS: boot:cycles.pb.js, cron:cycle-rollover, route:POST /api/tracker/cycles/rollover
  console.log("\n── (9) rollover: unfinished work follows the workspace into the next cycle ──");
  let every: any;
  [s, every] = await api("GET", "/api/collections/cycles/records?perPage=200", su);
  check(
    "(fixture) sections 1-8 left no cycle behind, so every count below is this section's",
    tup(s, every.totalItems),
    tup(200, 0),
  );

  async function cycle_of(task_id: string): Promise<any> {
    const [, rec] = await api("GET", `/api/collections/tasks/records/${task_id}`, su);
    return rec.cycle;
  }

  function cycles_in(ws_id: string): Promise<any[]> {
    return find_by_filter("cycles", `workspace='${esc(ws_id)}'`, su);
  }

  console.log(
    "\n── (9a) an ended cycle hands its unfinished work to a cycle that does not exist yet ──",
  );
  let src_a: any;
  [s, src_a] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ALICE_WS,
    name: "Ended Cycle A",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check("(fixture) ws A ran a cycle that ended yesterday", s, 200);
  const src_a_id = src_a.id;
  let proj_roll: any;
  [s, proj_roll] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Rollover Second Project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  check("(fixture) a SECOND ws-A project, so a roll is watched across two of them", s, 200);
  const proj_roll_id = proj_roll.id;

  // Workspace provisioning seeds five statuses and no triage one, so the category that
  // decides whether "unfinished" is read as a positive list or as "not resolved" has to be
  // created before it can be probed.
  let triage: any;
  [s, triage] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "Triage",
    category: "triage",
    position: 5,
  });
  check(
    "(fixture) Alice adds a triage status to ws A",
    tup(s, triage.category),
    tup(200, "triage"),
  );

  const rolling: Record<string, [string, string]> = {};
  for (const [label, status_name, proj] of [
    ["backlog", "Backlog", proj_one],
    ["unstarted", "Todo", proj_roll_id],
    ["started", "In Progress", proj_one],
    ["triage", "Triage", proj_one],
  ]) {
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `Rollover ${label} task`,
      workspace: ALICE_WS,
      project: proj,
      status: await status_id(ALICE_WS, status_name, alice),
      cycle: src_a_id,
    });
    check(`(fixture) an unfinished task in the ${label} category on the ended cycle`, s, 200);
    rolling[label] = [t.id, proj];
  }

  // A create fills the workspace default status, so the status-less case is reached by
  // clearing it afterwards — it is representable (tasks.status is optional) and must roll.
  let bare: any;
  [s, bare] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Rollover statusless task",
    workspace: ALICE_WS,
    project: proj_one,
    cycle: src_a_id,
  });
  check("(fixture) a task on the ended cycle, created with no status of its own", s, 200);
  [s, bare] = await api("PATCH", `/api/collections/tasks/records/${bare.id}`, alice, {
    status: "",
  });
  check(
    "(fixture) its status is cleared, so it carries no category at all",
    tup(s, bare.status),
    tup(200, ""),
  );
  rolling["status-less"] = [bare.id, proj_one];

  const resolved: Record<string, string> = {};
  for (const [label, status_name] of [
    ["completed", "Done"],
    ["canceled", "Canceled"],
  ]) {
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `Rollover ${label} task`,
      workspace: ALICE_WS,
      project: proj_one,
      status: await status_id(ALICE_WS, status_name, alice),
      cycle: src_a_id,
    });
    check(`(fixture) a ${label} task on the ended cycle`, s, 200);
    resolved[label] = t.id;
  }

  console.log("\n── (9b) ws B ends a cycle on the same days, with its next one ALREADY made ──");
  let src_b: any;
  [s, src_b] = await api("POST", "/api/collections/cycles/records", bob, {
    workspace: BOB_WS,
    name: "Ended Cycle B",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check(
    "(fixture) ws B ran its own cycle over the same days",
    tup(await owns_b.now(), s),
    tup(bob_id, 200),
  );
  const src_b_id = src_b.id;
  // A 21-day successor, not 14: a next cycle the sweep MADE instead of finding would carry
  // the ended cycle's length, so the stored dates tell the two branches apart.
  let next_b: any;
  [s, next_b] = await api("POST", "/api/collections/cycles/records", bob, {
    workspace: BOB_WS,
    name: "Next Cycle B",
    starts_on: day(0),
    ends_on: day(20),
  });
  check("(fixture) ws B already has its next cycle, of a different length", s, 200);
  const next_b_id = next_b.id;
  const proj_b = await find_id("projects", "name", "Mobile App", bob);
  check("(fixture) resolved Bob's seeded project", truthy(proj_b), true);
  let task_b: any;
  [s, task_b] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "Rollover ws-B task",
    workspace: BOB_WS,
    project: proj_b,
    status: await status_id(BOB_WS, "Todo", bob),
    cycle: src_b_id,
  });
  check("(fixture) an unfinished ws-B task on the ws-B ended cycle", s, 200);
  const task_b_id = task_b.id;

  console.log(
    "\n── (9c) the trigger is superuser-only (a custom route bypasses collection rules) ──",
  );
  [s] = await api("POST", "/api/tracker/cycles/rollover", alice);
  check("Alice (owner of ws A, not a superuser) cannot trigger rollover", s, 403);
  [s] = await api("POST", "/api/tracker/cycles/rollover", null);
  check("Anon cannot trigger rollover", s, 401);
  check(
    "the refused triggers moved nothing: the backlog task is still on the ended cycle",
    await cycle_of(rolling.backlog[0]),
    src_a_id,
  );

  console.log("\n── (9d) one run: unfinished work moves, resolved work stays ──");
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("superuser triggers rollover → 200", s, 200);

  const a_cycles = await cycles_in(ALICE_WS);
  check("ws A now runs two cycles: the one that ended and its successor", a_cycles.length, 2);
  const made_a = a_cycles.find((c) => c.id !== src_a_id) ?? {};
  const new_a_id = made_a.id;
  check("the auto-created next cycle starts the day after the ended one", made_a.starts_on, day(0));
  check(
    "the auto-created next cycle is the same length as the cycle that ended",
    made_a.ends_on,
    day(14),
  );
  check(
    "the auto-created cycle is named for the day it starts",
    made_a.name,
    "Cycle " + day(0).slice(0, 10),
  );
  check(
    "the auto-created cycle belongs to the workspace whose cycle ended",
    made_a.workspace,
    ALICE_WS,
  );
  for (const [label, [tid, proj]] of Object.entries(rolling)) {
    [s, r] = await api("GET", `/api/collections/tasks/records/${tid}`, su);
    check(`the ${label} task rolled into the next cycle`, tup(s, r.cycle), tup(200, new_a_id));
    check(`a rolled task keeps its project (${label})`, r.project, proj);
  }
  for (const [label, tid] of Object.entries(resolved)) {
    [s, r] = await api("GET", `/api/collections/tasks/records/${tid}`, su);
    check(
      `a ${label} task is resolved, so it stays on the ended cycle`,
      tup(s, r.cycle),
      tup(200, src_a_id),
    );
  }
  check(
    "rollover moved exactly the five unfinished ws-A tasks into the new cycle, no others",
    (await find_by_filter("tasks", `cycle='${esc(new_a_id || "")}'`, su))
      .map((t) => t.id)
      .sort(by_code_point),
    Object.values(rolling)
      .map(([tid]) => tid)
      .sort(by_code_point),
  );

  const b_cycles = await cycles_in(BOB_WS);
  check(
    "an existing next cycle is used, and no second one is created",
    b_cycles.map((c) => c.id).sort(by_code_point),
    [src_b_id, next_b_id].sort(by_code_point),
  );
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_b_id}`, su);
  check(
    "rollover never crosses a workspace boundary: the ws-B task landed in the ws-B cycle",
    tup(r.cycle, r.cycle === new_a_id),
    tup(next_b_id, false),
  );
  check(
    "the ws-B move landed exactly the one unfinished ws-B task, no others",
    (await find_by_filter("tasks", `cycle='${esc(next_b_id || "")}'`, su)).map((t) => t.id),
    [task_b_id],
  );

  console.log("\n── (9e) idempotence: a second run over the same data moves nothing ──");
  const watched = [
    ...Object.values(rolling).map(([tid]) => tid),
    ...Object.values(resolved),
    task_b_id,
  ];
  const cycles_of = async (): Promise<Record<string, any>> => {
    const out: Record<string, any> = {};
    for (const tid of watched) out[tid] = await cycle_of(tid);
    return out;
  };
  const before = await cycles_of();
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("a second rollover run succeeds", s, 200);
  check(
    "a second run moves nothing: every task still holds the cycle it already held",
    await cycles_of(),
    before,
  );
  check("a second run creates no further ws-A cycle", (await cycles_in(ALICE_WS)).length, 2);
  check("a second run creates no further ws-B cycle", (await cycles_in(BOB_WS)).length, 2);

  console.log("\n── (9f) a cycle still running is left alone, whether it ends today or later ──");
  let ws_c: any;
  [s, ws_c] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Future Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a workspace of its own for the future cycle", s, 200);
  const ws_c_id = ws_c.id;
  let live_c: any;
  [s, live_c] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_c_id,
    name: "Not Over Yet",
    starts_on: day(5),
    ends_on: day(19),
  });
  check("(fixture) its only cycle has not even started", s, 200);
  const live_c_id = live_c.id;
  let task_c: any;
  [s, task_c] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Future cycle task",
    workspace: ws_c_id,
    status: await status_id(ws_c_id, "Todo", alice),
    cycle: live_c_id,
  });
  check("(fixture) an unfinished task planned into that future cycle", s, 200);
  const task_c_id = task_c.id;
  // A cycle runs THROUGH its ends_on day, so today is its last day, not its first day over.
  let today_c: any;
  [s, today_c] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_c_id,
    name: "Ends Today",
    starts_on: day(-14),
    ends_on: day(0),
  });
  check("(fixture) a second ws-C cycle whose last day is today", s, 200);
  const today_c_id = today_c.id;
  let task_today: any;
  [s, task_today] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Ends today task",
    workspace: ws_c_id,
    status: await status_id(ws_c_id, "Todo", alice),
    cycle: today_c_id,
  });
  check("(fixture) an unfinished task on the cycle whose last day is today", s, 200);
  const task_today_id = task_today.id;
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("a run facing only cycles still running succeeds", s, 200);
  check(
    "a cycle that has not ended is not swept: its task keeps it",
    await cycle_of(task_c_id),
    live_c_id,
  );
  check(
    "a cycle whose LAST DAY is today is still running, so its task keeps it too",
    await cycle_of(task_today_id),
    today_c_id,
  );
  check(
    "a cycle still running gets no successor made for it",
    (await cycles_in(ws_c_id)).map((c) => c.id).sort(by_code_point),
    [live_c_id, today_c_id].sort(by_code_point),
  );

  console.log("\n── (9g) catch-up: one run clears every cycle a dormant workspace has ended ──");
  let ws_d: any;
  [s, ws_d] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Catch Up Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a workspace that has been left dormant", s, 200);
  const ws_d_id = ws_d.id;
  let first_d: any;
  [s, first_d] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_d_id,
    name: "Dormant One",
    starts_on: day(-31),
    ends_on: day(-17),
  });
  check("(fixture) the first of two consecutively ended cycles", s, 200);
  const first_d_id = first_d.id;
  let second_d: any;
  [s, second_d] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_d_id,
    name: "Dormant Two",
    starts_on: day(-16),
    ends_on: day(-2),
  });
  check("(fixture) the second, starting the day after the first one ended", s, 200);
  const second_d_id = second_d.id;
  const todo_d = await status_id(ws_d_id, "Todo", alice);
  const dormant: Record<string, string> = {};
  for (const [label, cyc] of [
    ["one", first_d_id],
    ["two", second_d_id],
  ]) {
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `Dormant task ${label}`,
      workspace: ws_d_id,
      status: todo_d,
      cycle: cyc,
    });
    check(`(fixture) an unfinished task on dormant cycle ${label}`, s, 200);
    dormant[label] = t.id;
  }

  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("one run sweeps both ended cycles in date order", s, 200);
  const d_cycles = await cycles_in(ws_d_id);
  check("one run made exactly one new cycle for the dormant workspace", d_cycles.length, 3);
  const final_d = d_cycles.find((c) => ![first_d_id, second_d_id].includes(c.id)) ?? {};
  check(
    "the caught-up cycle starts the day after the LAST ended cycle",
    final_d.starts_on,
    day(-1),
  );
  check("the caught-up cycle carries the same length again", final_d.ends_on, day(13));
  for (const label of ["one", "two"]) {
    check(
      `one run lands the work in the final cycle, not an intermediate one (${label})`,
      await cycle_of(dormant[label]),
      final_d.id,
    );
  }
  // The activity trail records one row per real move: the final-cycle read-back alone cannot
  // tell a two-hop journey (through the second ended cycle) from a direct jump to the same spot.
  check(
    "the first task moved twice, hopping through the second cycle before landing",
    (await find_by_filter("task_activity", `task='${esc(dormant.one)}' && field='cycle'`, su))
      .length,
    2,
  );
  check(
    "the second task made only the final hop",
    (await find_by_filter("task_activity", `task='${esc(dormant.two)}' && field='cycle'`, su))
      .length,
    1,
  );
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check(
    "the caught-up cycle is still running, so a further run moves nothing",
    tup(s, await cycle_of(dormant.one), await cycle_of(dormant.two)),
    tup(200, final_d.id, final_d.id),
  );

  console.log(
    "\n── (9h) a workspace dormant for many spans lands its work in a cycle still running ──",
  );
  let ws_e: any;
  [s, ws_e] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Long Dormant Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a workspace dormant for months", s, 200);
  const ws_e_id = ws_e.id;
  let old_e: any;
  [s, old_e] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_e_id,
    name: "Long Gone",
    starts_on: day(-100),
    ends_on: day(-86),
  });
  check("(fixture) its only cycle ended many spans ago", s, 200);
  const old_e_id = old_e.id;
  let task_e: any;
  [s, task_e] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Long dormant task",
    workspace: ws_e_id,
    status: await status_id(ws_e_id, "Todo", alice),
    cycle: old_e_id,
  });
  check("(fixture) an unfinished task left on it", s, 200);
  const task_e_id = task_e.id;
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("one run moves the long-dormant task", s, 200);
  const e_cycles = await cycles_in(ws_e_id);
  check("one run made exactly one cycle for the long-dormant workspace", e_cycles.length, 2);
  const made_e = e_cycles.find((c) => c.id !== old_e_id) ?? {};
  // Contiguous spans of the same length from the day the old cycle ended: -85, -70, -55,
  // -40, -25, -10 is the first that has not itself ended.
  check(
    "the cycle it made is one still running, not another already over",
    tup(made_e.starts_on, made_e.ends_on),
    tup(day(-10), day(4)),
  );
  check("the long-dormant task is in that cycle", await cycle_of(task_e_id), made_e.id);
  // Only ONE intermediate cycle ever exists as a row (the skip-forward is arithmetic, not
  // sequential rows to sweep), so a single activity row is what "moved once" means here.
  check(
    "it moved in a single hop, straight to the cycle still running",
    (await find_by_filter("task_activity", `task='${esc(task_e_id)}' && field='cycle'`, su)).length,
    1,
  );
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check(
    "a workspace dormant for months is caught up by ONE run, not one run per span",
    tup(s, await cycle_of(task_e_id), (await cycles_in(ws_e_id)).length),
    tup(200, made_e.id, 2),
  );

  console.log("\n── (9i) trash holds work back from rollover ──");
  let ws_f: any;
  [s, ws_f] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Trash Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a workspace whose only held task will be trashed", s, 200);
  const ws_f_id = ws_f.id;
  let ended_f: any;
  [s, ended_f] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_f_id,
    name: "Trash Cycle",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check("(fixture) its only cycle ended yesterday", s, 200);
  const ended_f_id = ended_f.id;
  let task_f: any;
  [s, task_f] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Trashed rollover task",
    workspace: ws_f_id,
    status: await status_id(ws_f_id, "Todo", alice),
    cycle: ended_f_id,
  });
  check("(fixture) an unfinished task on that ended cycle", s, 200);
  const task_f_id = task_f.id;
  // DELETE traps to trash for a non-superuser, so this is the real user-facing trash path.
  [s] = await api("DELETE", `/api/collections/tasks/records/${task_f_id}`, alice);
  check("(fixture) Alice sends it to the trash", s, 204);
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_f_id}`, su);
  check("(fixture) it reads back trashed", tup(s, truthy(r.trashed)), tup(200, true));

  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("a workspace whose only task is trashed still sweeps without error", s, 200);
  check(
    "a task in the trash never rolls: it stays on the cycle that ended",
    await cycle_of(task_f_id),
    ended_f_id,
  );
  check(
    "a workspace whose only held task is trashed has no cycle minted for it",
    (await cycles_in(ws_f_id)).map((c) => c.id),
    [ended_f_id],
  );

  const f_before = (await cycles_in(ws_f_id)).map((c) => c.id);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${task_f_id}`, alice, {
    trashed: "",
  });
  check("(fixture) Alice restores the trashed task", tup(s, r.trashed ?? ""), tup(200, ""));
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("a restored task rolls on the NEXT sweep", s, 200);
  // `field='cycle'` excludes the trash/restore's own `trashed`-field activity rows.
  check(
    "…and it is the only move: one `cycle` activity row, not a repeated write",
    (await find_by_filter("task_activity", `task='${esc(task_f_id)}' && field='cycle'`, su)).length,
    1,
  );
  const f_cycles = await cycles_in(ws_f_id);
  const made_f = f_cycles.find((c) => c.id !== ended_f_id) ?? {};
  check(
    "the restore is what mints the successor cycle, one sweep late",
    tup(f_before, f_cycles.length, await cycle_of(task_f_id)),
    tup([ended_f_id], 2, made_f.id),
  );

  // ══════════════════ (9j) the move lands in the task's audit trail ═══════════
  // COVERS: hook:activity.pb.js#onRecordUpdate:tasks
  // The sweep moves a task with a programmatic e.app.save(), which fires no *Request hook —
  // so a row here exists only while the audit writer sits at the universal tier.
  console.log("\n── (9j) a rolled task records the move in its own activity trail ──");

  const activity_of = (task_id_: string): Promise<any[]> =>
    find_by_filter("task_activity", `task='${esc(task_id_)}'`, su);

  let ws_g: any;
  [s, ws_g] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Audit Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a workspace for the audit-trail arm", s, 200);
  const ws_g_id = ws_g.id;
  let ended_g: any;
  [s, ended_g] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_g_id,
    name: "Audited Cycle",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check("(fixture) its only cycle ended yesterday", s, 200);
  const ended_g_id = ended_g.id;
  let task_g: any;
  [s, task_g] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Audited rollover task",
    workspace: ws_g_id,
    status: await status_id(ws_g_id, "Todo", alice),
    cycle: ended_g_id,
  });
  check("(fixture) an unfinished task on that ended cycle", s, 200);
  const task_g_id = task_g.id;
  check(
    "(fixture) a create writes no activity row, so the trail starts empty",
    await activity_of(task_g_id),
    [],
  );

  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check(
    "(fixture) the sweep moves the audited task off the cycle that ended",
    tup(s, (await cycle_of(task_g_id)) !== ended_g_id),
    tup(200, true),
  );
  check(
    "the rollover wrote a `cycle` activity row, actorless (the sweep is systemic)",
    (await activity_of(task_g_id)).map((r) => tup(r.field, r.actor)),
    [tup("cycle", "")],
  );
  check(
    "…and the row names the cycle it left and the one it landed on",
    (await activity_of(task_g_id)).map((r) => tup(JSON.parse(r.from), JSON.parse(r.to))),
    [tup(ended_g_id, await cycle_of(task_g_id))],
  );

  // ══════════════════ (9k) a trashed PROJECT holds work back ═════════════════
  // A task is hidden from its own workspace when its PROJECT is trashed, exactly as when it
  // is trashed itself — so the sweep has to read the project bound, not just the task one.
  console.log("\n── (9k) a trashed project holds its work back from rollover ──");
  let ws_h: any;
  [s, ws_h] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Project Trash Workspace",
    owner: alice_id,
  });
  check(
    "(fixture) Alice creates a workspace whose only held task will sit in a trashed project",
    s,
    200,
  );
  const ws_h_id = ws_h.id;
  let ended_h: any;
  [s, ended_h] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_h_id,
    name: "Project Trash Cycle",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check("(fixture) its only cycle ended yesterday", s, 200);
  const ended_h_id = ended_h.id;
  let proj_h: any;
  [s, proj_h] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Trashed Rollover Project",
    owner: alice_id,
    workspace: ws_h_id,
  });
  check("(fixture) a project in that workspace, holding the only unfinished task", s, 200);
  const proj_h_id = proj_h.id;
  let task_h: any;
  [s, task_h] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Task under a trashed project",
    workspace: ws_h_id,
    project: proj_h_id,
    status: await status_id(ws_h_id, "Todo", alice),
    cycle: ended_h_id,
  });
  check("(fixture) an unfinished task on that ended cycle, inside that project", s, 200);
  const task_h_id = task_h.id;
  // DELETE traps to trash for a non-superuser, so this is the real user-facing trash path.
  [s] = await api("DELETE", `/api/collections/projects/records/${proj_h_id}`, alice);
  check("(fixture) Alice sends the PROJECT to the trash", s, 204);
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_h_id}`, su);
  // Load-bearing: without it this section would pass for §9i's reason, not its own.
  check("(fixture) the task itself is NOT trashed", tup(s, r.trashed ?? ""), tup(200, ""));

  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check("a workspace whose only held task sits in a trashed project still sweeps", s, 200);
  check(
    "a task whose project is in the trash never rolls: it stays on the cycle that ended",
    await cycle_of(task_h_id),
    ended_h_id,
  );
  check(
    "a workspace whose only held task is hidden by its project has no cycle minted for it",
    (await cycles_in(ws_h_id)).map((c) => c.id),
    [ended_h_id],
  );

  [s, r] = await api("PATCH", `/api/collections/projects/records/${proj_h_id}`, alice, {
    trashed: "",
  });
  check("(fixture) Alice restores the project", tup(s, r.trashed ?? ""), tup(200, ""));
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check(
    "restoring the project puts the task back in the running: the next sweep rolls it",
    tup(s, (await cycle_of(task_h_id)) !== ended_h_id),
    tup(200, true),
  );
  check(
    "…in one move: a single `cycle` activity row",
    (await find_by_filter("task_activity", `task='${esc(task_h_id)}' && field='cycle'`, su)).length,
    1,
  );

  // ══════════════════ (9l) the move reaches a live board ══════════════════════
  // COVERS: hook:realtime.pb.js#onRecordUpdate:tasks
  // The sweep moves a task with a programmatic e.app.save(), which fires no *Request hook —
  // so an envelope arrives here only while the broadcaster sits at the universal tier.
  console.log("\n── (9l) the rollover reaches a board left open ──");
  let ws_i: any;
  [s, ws_i] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Live Board Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a workspace for the live-board arm", s, 200);
  const ws_i_id = ws_i.id;
  let ended_i: any;
  [s, ended_i] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_i_id,
    name: "Watched Cycle",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check("(fixture) its only cycle ended yesterday", s, 200);
  const ended_i_id = ended_i.id;
  let task_i: any;
  [s, task_i] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Watched rollover task",
    workspace: ws_i_id,
    status: await status_id(ws_i_id, "Todo", alice),
    cycle: ended_i_id,
  });
  check("(fixture) an unfinished task on that ended cycle", s, 200);
  const task_i_id = task_i.id;

  const listener = new roomkit.SSEListener(BASE_URL, alice, `rt:project_items:${ws_i_id}`);
  check(
    "(fixture) Alice opens a live board on that workspace",
    truthy(await listener.start()),
    true,
  );
  await Bun.sleep(1000); // let the authorize POST land before the write it has to catch
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check(
    "(fixture) the sweep moves the watched task off the cycle that ended",
    tup(s, (await cycle_of(task_i_id)) !== ended_i_id),
    tup(200, true),
  );
  check(
    "…in one move: a single `cycle` activity row",
    (await find_by_filter("task_activity", `task='${esc(task_i_id)}' && field='cycle'`, su)).length,
    1,
  );
  await Bun.sleep(1500); // let the broadcast drain to the socket
  listener.stop = true;
  const moved = listener.of("tasks", "update").filter((ev) => ev.id === task_i_id);
  check(
    "the rollover reaches the live board: the moved task arrives on the workspace channel",
    truthy(moved.length),
    true,
  );
  const first = moved.length ? moved[0] : {};
  check(
    "…and the broadcast carries the cycle the task landed on",
    (first.rawRecord || {}).cycle,
    await cycle_of(task_i_id),
  );
  check("the broadcast is actorless, because the sweep is systemic", first.actorId, "");

  // ══════════════════ (9m) a trashed workspace is out of the sweep ════════════
  // COVERS: route:POST /api/tracker/cycles/rollover
  console.log("\n── (9m) a trashed workspace holds its whole board back from rollover ──");
  let ws_j: any;
  [s, ws_j] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Trashed Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates the workspace that will be trashed", s, 200);
  const ws_j_id = ws_j.id;
  let ended_j: any;
  [s, ended_j] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_j_id,
    name: "Frozen Cycle",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check("(fixture) its only cycle ended yesterday", s, 200);
  const ended_j_id = ended_j.id;
  let proj_j: any;
  [s, proj_j] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Frozen Rollover Project",
    owner: alice_id,
    workspace: ws_j_id,
  });
  check("(fixture) a project in that workspace, holding its only unfinished task", s, 200);
  const proj_j_id = proj_j.id;
  let task_j: any;
  [s, task_j] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Task in a workspace bound for the trash",
    workspace: ws_j_id,
    project: proj_j_id,
    status: await status_id(ws_j_id, "Todo", alice),
    cycle: ended_j_id,
  });
  check("(fixture) an unfinished task on that ended cycle", s, 200);
  const task_j_id = task_j.id;

  // The control runs in the SAME sweep: without it a green run could mean the sweep did
  // nothing at all, rather than that it skipped exactly the trashed workspace.
  let ws_k: any;
  [s, ws_k] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Live Control Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates a live control workspace of the same shape", s, 200);
  const ws_k_id = ws_k.id;
  let ended_k: any;
  [s, ended_k] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_k_id,
    name: "Control Cycle",
    starts_on: day(-15),
    ends_on: day(-1),
  });
  check("(fixture) the control workspace's only cycle ended yesterday too", s, 200);
  const ended_k_id = ended_k.id;
  let proj_k: any;
  [s, proj_k] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Control Rollover Project",
    owner: alice_id,
    workspace: ws_k_id,
  });
  check("(fixture) a project in the control workspace", s, 200);
  let task_k: any;
  [s, task_k] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Task in the live control workspace",
    workspace: ws_k_id,
    project: proj_k.id,
    status: await status_id(ws_k_id, "Todo", alice),
    cycle: ended_k_id,
  });
  check("(fixture) an unfinished task on the control workspace's ended cycle", s, 200);
  const task_k_id = task_k.id;

  // DELETE traps to trash for a non-superuser, so this is the real user-facing trash path.
  [s] = await api("DELETE", `/api/collections/workspaces/records/${ws_j_id}`, alice);
  check("(fixture) Alice sends the WORKSPACE to the trash", s, 204);
  [s, r] = await api("GET", `/api/collections/workspaces/records/${ws_j_id}`, su);
  check("(fixture) the workspace reads back trashed", tup(s, truthy(r.trashed)), tup(200, true));
  [s, r] = await api("GET", `/api/collections/workspaces/records/${ws_k_id}`, su);
  check("(fixture) the control workspace is not trashed", tup(s, r.trashed ?? ""), tup(200, ""));
  // Load-bearing: without both, this section could pass for §9i's or §9k's reason, not its own.
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_j_id}`, su);
  check(
    "(fixture) the task inside the trashed workspace is NOT itself trashed",
    tup(s, r.trashed ?? ""),
    tup(200, ""),
  );
  [s, r] = await api("GET", `/api/collections/projects/records/${proj_j_id}`, su);
  check("(fixture) its project is NOT trashed either", tup(s, r.trashed ?? ""), tup(200, ""));

  // The route's "rolled" count is whole-database, not per-workspace — an unrelated live
  // workspace with unfinished work on an ended cycle inflates it, so this reads the two
  // workspaces this section owns back directly instead of trusting the aggregate.
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check(
    "a trashed workspace is skipped: only the live control workspace rolls",
    tup(s, (await cycle_of(task_k_id)) !== ended_k_id, await cycle_of(task_j_id)),
    tup(200, true, ended_j_id),
  );
  check(
    "the control workspace's task rolled off the cycle that ended",
    (await cycle_of(task_k_id)) !== ended_k_id,
    true,
  );
  check(
    "a task in a trashed workspace never rolls: it stays on the cycle that ended",
    await cycle_of(task_j_id),
    ended_j_id,
  );
  check(
    "a trashed workspace has no cycle minted inside it",
    (await cycles_in(ws_j_id)).map((c) => c.id),
    [ended_j_id],
  );

  // workspaces.updateRule carries no trashed clause, so the owner's own PATCH is the restore.
  [s, r] = await api("PATCH", `/api/collections/workspaces/records/${ws_j_id}`, alice, {
    trashed: "",
  });
  check("(fixture) Alice (the workspace owner) restores it", tup(s, r.trashed ?? ""), tup(200, ""));
  [s] = await api("POST", "/api/tracker/cycles/rollover", su);
  check(
    "restoring the workspace puts its board back in the running: the next sweep rolls it",
    tup(s, (await cycle_of(task_j_id)) !== ended_j_id),
    tup(200, true),
  );

  // ══════════════════ (9n) the CRON copy of the sweep ═════════════════════════
  // COVERS: cron:cycle-rollover
  // §10 proves the two copies read alike; only running the registered job proves the cron
  // WRAPPER reaches the sweep at all.
  console.log("\n── (9n) the registered cron job runs the same sweep, trash boundary included ──");
  let crons: any;
  [s, crons] = await api("GET", "/api/crons", su);
  check(
    "(fixture) the job id this section drives is registered",
    tup(s, (Array.isArray(crons) ? crons : []).map((c: any) => c.id).includes("cycle-rollover")),
    tup(200, true),
  );
  let ws_l: any;
  [s, ws_l] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Cron Live Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates the live workspace the cron must sweep", s, 200);
  const ws_l_id = ws_l.id;
  let ws_t: any;
  [s, ws_t] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Rollover Cron Trashed Workspace",
    owner: alice_id,
  });
  check("(fixture) Alice creates the workspace the cron must skip", s, 200);
  const ws_t_id = ws_t.id;
  // The sweep enumerates +ends_on, so ending the skipped workspace's cycle FIRST makes the
  // live task's move proof that the earlier one was reached and passed over, not unreached.
  let ended_t: any;
  [s, ended_t] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_t_id,
    name: "Cron Frozen Cycle",
    starts_on: day(-30),
    ends_on: day(-20),
  });
  check("(fixture) the workspace bound for the trash ran the EARLIER ended cycle", s, 200);
  const ended_t_id = ended_t.id;
  let ended_l: any;
  [s, ended_l] = await api("POST", "/api/collections/cycles/records", alice, {
    workspace: ws_l_id,
    name: "Cron Live Cycle",
    starts_on: day(-15),
    ends_on: day(-2),
  });
  check("(fixture) the live workspace ran the LATER one", s, 200);
  const ended_l_id = ended_l.id;
  let task_t: any;
  [s, task_t] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Cron-swept task in a trashed workspace",
    workspace: ws_t_id,
    status: await status_id(ws_t_id, "Todo", alice),
    cycle: ended_t_id,
  });
  check("(fixture) an unfinished task on the earlier ended cycle", s, 200);
  const task_t_id = task_t.id;
  let task_l: any;
  [s, task_l] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Cron-swept task in a live workspace",
    workspace: ws_l_id,
    status: await status_id(ws_l_id, "Todo", alice),
    cycle: ended_l_id,
  });
  check("(fixture) an unfinished task on the later ended cycle", s, 200);
  const task_l_id = task_l.id;
  [s] = await api("DELETE", `/api/collections/workspaces/records/${ws_t_id}`, alice);
  check("(fixture) Alice sends that workspace to the trash", s, 204);
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_t_id}`, su);
  check(
    "(fixture) the task inside it is NOT itself trashed",
    tup(s, r.trashed ?? ""),
    tup(200, ""),
  );

  [s] = await api("POST", "/api/crons/cycle-rollover", su);
  check("superuser runs the registered cron job → 204", s, 204);
  // The job runs ASYNCHRONOUSLY — the 204 returns before the sweep does — so the outcome is
  // polled to a 20s deadline every 0.1s, and a timeout fails as loudly as a wrong result.
  const poll_deadline = Date.now() / 1000 + CRON_POLL_DEADLINE_S;
  while ((await cycle_of(task_l_id)) === ended_l_id && Date.now() / 1000 < poll_deadline) {
    await Bun.sleep(CRON_POLL_INTERVAL_S * 1000);
  }
  const moved_l = (await cycle_of(task_l_id)) !== ended_l_id;
  check(
    "the cron run moves the live workspace's task within the poll deadline",
    moved_l || `still on the ended cycle after ${CRON_POLL_DEADLINE_S}s`,
    true,
  );
  check(
    "the same cron run leaves a trashed workspace's task on the cycle that ended",
    await cycle_of(task_t_id),
    ended_t_id,
  );
  check(
    "the cron mints no cycle inside a trashed workspace",
    (await cycles_in(ws_t_id)).map((c) => c.id),
    [ended_t_id],
  );

  // ══════════════════ 10. One sweep, inlined twice ════════════════════════════
  console.log("\n── (10) the cron copy and the route copy of the sweep are one implementation ──");
  const hook_src = read_text(path.join(REPO_ROOT, "pb_hooks", "cycles.pb.js"));

  const sweep_body = (open_marker: string, close_marker: string): string => {
    const open_at = hook_src.indexOf(open_marker);
    if (open_at < 0) throw new Error("substring not found");
    const start = open_at + open_marker.length;
    const end = hook_src.indexOf(close_marker, start);
    if (end < 0) throw new Error("substring not found");
    return hook_src.slice(start, end);
  };

  const cron_sweep = sweep_body(
    "INLINED SWEEP (cron copy, uses $app) — KEEP IN SYNC with the route copy ──",
    "── END INLINED SWEEP (cron copy) ──",
  );
  const route_sweep = sweep_body(
    "INLINED SWEEP (route copy, uses e.app) — KEEP IN SYNC with the cron copy ──",
    "── END INLINED SWEEP (route copy) ──",
  );
  check(
    "(fixture) both inlined sweep bodies were located in the hook source",
    tup(cron_sweep.length > 1000, route_sweep.length > 1000),
    tup(true, true),
  );
  // Substituting $app -> e.app only proves the copies match if each one used the RIGHT
  // handle to start with — two copies that both already say e.app would substitute to
  // the same text and pass as "identical" without this pair of checks.
  check(
    "the cron copy uses the closure-scoped $app handle, never e.app",
    cron_sweep.includes("e.app"),
    false,
  );
  check(
    "the route copy uses the request-scoped e.app handle, never $app",
    route_sweep.includes("$app"),
    false,
  );
  // The cron closure cannot see onBootstrap's `e`, so it uses $app; substituting the handle
  // is the ONLY difference the two copies are allowed to carry.
  const cron_lines = splitlines(cron_sweep.replaceAll("$app", "e.app"));
  const route_lines = splitlines(route_sweep);
  let first_diff = "identical";
  for (let n = 0; n < Math.max(cron_lines.length, route_lines.length); n++) {
    const a = n < cron_lines.length ? cron_lines[n] : null;
    const b = n < route_lines.length ? route_lines[n] : null;
    if (a !== b) {
      first_diff = `line ${n + 1}: cron ${py_repr(a)} vs route ${py_repr(b)}`;
      break;
    }
  }
  check(
    "the two inlined sweep copies are byte-identical apart from the app handle",
    first_diff,
    "identical",
  );

  await tierkit.verify_tiers();
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all cycle proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * decision:backend-owns-business-rules owner/author defaulting: a create that omits `owner` (projects, workspaces,
 * saved_views) or `author` (comments) is stamped with the authenticated caller by PocketBase
 * itself (pb_hooks/owner.pb.js, pb_hooks/author.pb.js), so a client need not resolve and send
 * it. Authority never widens: a caller naming SOMEONE ELSE as owner is refused by the
 * createRule (400) and a spoofed comment author is overwritten; a superuser keeps what it
 * submitted (seed/import fidelity); a non-member, a viewer and anon stay refused.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
 * Port 8166 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8166 + PORT_OFFSET;
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

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-owner-defaults-test-"));
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
  const [carol] = await login("carol@example.com");

  const ALICE_WS = getitem(
    (await find_by_filter("workspaces", "name='Alice\\'s Workspace'", alice))[0],
    "id",
  );
  const TASK = getitem((await find_by_filter("tasks", "title='Design homepage'", alice))[0], "id");
  tierkit.use(api);
  const alice_owns = await tierkit.owner_of_workspace(ALICE_WS, alice_id, alice, "Alice");
  const bob_member = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");

  let s: number;
  let r: any;

  // A refused create must leave nothing behind under the attempted name.
  async function stored(collection: string, field: string, value: string): Promise<number> {
    return (await find_by_filter(collection, `${field}='${value}'`, su)).length;
  }

  // ── per-collection create bodies (owner/author deliberately absent) ──
  const COLLECTIONS: [string, (name: string) => Record<string, unknown>][] = [
    ["projects", (name) => ({ name, workspace: ALICE_WS })],
    ["workspaces", (name) => ({ name })],
    ["saved_views", (name) => ({ name, workspace: ALICE_WS, filterData: [], scope: "personal" })],
  ];

  // COVERS: rule:projects.create, rule:workspaces.create, rule:saved_views.create
  for (const [coll, body] of COLLECTIONS) {
    console.log(`\n── ${coll}: owner defaults to the caller; a spoof is refused ──`);
    [s, r] = await api("POST", `/api/collections/${coll}/records`, bob, body(`${coll} omitted`));
    check(
      `${coll}: Bob (member) creates with NO owner → 200, owner = Bob`,
      tup(await bob_member.now(), s, r.owner ?? null),
      tup("member", 200, bob_id),
    );

    [s, r] = await api("POST", `/api/collections/${coll}/records`, bob, {
      ...body(`${coll} self`),
      owner: bob_id,
    });
    check(
      `${coll}: Bob names HIMSELF as owner → 200, owner = Bob`,
      tup(s, r.owner ?? null),
      tup(200, bob_id),
    );

    [s] = await api("POST", `/api/collections/${coll}/records`, bob, {
      ...body(`${coll} spoof`),
      owner: alice_id,
    });
    check(`${coll}: Bob names ALICE as owner (spoof) → 400 refused`, s, 400);
    check(
      `${coll}: the refused spoof stored nothing`,
      await stored(coll, "name", `${coll} spoof`),
      0,
    );

    [s, r] = await api("POST", `/api/collections/${coll}/records`, su, {
      ...body(`${coll} su`),
      owner: bob_id,
    });
    check(
      `${coll}: superuser submits owner = Bob → 200, owner kept as Bob`,
      tup(s, r.owner ?? null),
      tup(200, bob_id),
    );

    [s] = await api("POST", `/api/collections/${coll}/records`, null, body(`${coll} anon`));
    check(`${coll}: anon creates with NO owner → 400`, s, 400);
    check(
      `${coll}: the refused anon create stored nothing`,
      await stored(coll, "name", `${coll} anon`),
      0,
    );
  }

  // workspaces.createRule has no membership clause (any signed-in user may open a workspace), so
  // the non-member/viewer refusals below apply to the workspace-scoped collections only.
  console.log("\n── projects / saved_views: non-member stays refused with an omitted owner ──");
  for (const [coll, body] of COLLECTIONS.filter(([c]) => c !== "workspaces")) {
    [s] = await api("POST", `/api/collections/${coll}/records`, carol, body(`${coll} carol`));
    check(`${coll}: Carol (non-member) creates with NO owner → 400`, s, 400);
    check(
      `${coll}: the refused non-member create stored nothing`,
      await stored(coll, "name", `${coll} carol`),
      0,
    );
  }

  // COVERS: rule:comments.create
  console.log("\n── comments: author defaults to the caller; a spoof is overwritten ──");
  [s, r] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK,
    body: "comment omitted",
  });
  check(
    "comments: Bob (member) creates with NO author → 200, author = Bob",
    tup(await bob_member.now(), s, r.author ?? null),
    tup("member", 200, bob_id),
  );
  [s, r] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK,
    body: "comment spoof",
    author: alice_id,
  });
  check(
    "comments: Bob names ALICE as author (spoof) → 200, OVERWRITTEN to Bob",
    tup(s, r.author ?? null),
    tup(200, bob_id),
  );
  [s, r] = await api("POST", "/api/collections/comments/records", su, {
    task: TASK,
    body: "comment su",
    author: bob_id,
  });
  check(
    "comments: superuser submits author = Bob → 200, author kept as Bob",
    tup(s, r.author ?? null),
    tup(200, bob_id),
  );
  [s] = await api("POST", "/api/collections/comments/records", carol, {
    task: TASK,
    body: "comment carol",
  });
  check("comments: Carol (non-member) creates with NO author → 400", s, 400);
  check(
    "comments: the refused non-member create stored nothing",
    await stored("comments", "body", "comment carol"),
    0,
  );
  [s] = await api("POST", "/api/collections/comments/records", null, {
    task: TASK,
    body: "comment anon",
  });
  check("comments: anon creates with NO author → 400", s, 400);

  await bob_member.done();

  console.log("\n── viewer stays refused with an omitted owner/author ──");
  const bob_viewer = await tierkit.actor_at_tier(ALICE_WS, bob_id, "viewer", alice, "Bob");
  for (const [coll, body] of COLLECTIONS.filter(([c]) => c !== "workspaces")) {
    [s] = await api("POST", `/api/collections/${coll}/records`, bob, body(`${coll} viewer`));
    check(
      `${coll}: Bob (viewer) creates with NO owner → 400`,
      tup(await bob_viewer.now(), s),
      tup("viewer", 400),
    );
    check(
      `${coll}: the refused viewer create stored nothing`,
      await stored(coll, "name", `${coll} viewer`),
      0,
    );
  }
  [s] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK,
    body: "comment viewer",
  });
  check(
    "comments: Bob (viewer) creates with NO author → 400",
    tup(await bob_viewer.now(), s),
    tup("viewer", 400),
  );
  await bob_viewer.done();
  await alice_owns.done();

  await tierkit.verify_tiers();
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all owner-defaults proofs passed");
  process.exit(0);
}

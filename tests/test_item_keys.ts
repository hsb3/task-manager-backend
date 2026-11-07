#!/usr/bin/env bun
/**
 * PBTT-422 / decision:item-display-keys — prove the two-layer item identity: the record id stays the only
 * real key, and the DISPLAY label is a per-project prefix plus ONE number sequence shared by
 * tasks, decisions, documents and milestones.
 *
 * Supersedes the G1 per-workspace `tasks.seq` proof this file used to carry; the counter moved
 * to projects.item_seq and the sigil-per-type label (TSK·/DEC·/DOC·/MIL·) is gone.
 *
 * Fully self-contained clean-room server, real `pb_hooks/`. Does NOT run scripts/seed.ts — mints
 * its own fresh user so its auto-provisioned workspace and project start empty.
 *
 *   §1 the project prefix: suggested from the name, choosable at create, unique per workspace,
 *      fixed afterwards.
 *   §2 ONE sequence per project, shared across all four item types.
 *   §3 per-project independence: a second project in the SAME workspace starts at 1.
 *   §4 20 barrier-synchronized parallel creates in one project -> 20 unique keys.
 *   §5 the key is immutable on every item type, and it FOLLOWS the item through a move to
 *      another project without colliding with that project's own numbering.
 *   §6 an item created with no project carries no key (declared bound) — it lands in the
 *      workspace shadow project, which takes no prefix of its own.
 *   §7 the addressable identity stays the opaque record id.
 *   §8 PBTT-487: a keyless item is keyless for life — no client-minted label, no mint at move.
 *   §10 a refused create burns no number: the counter is claimed after the insert commits,
 *      and concurrent accepted creates still take distinct, contiguous numbers.
 *
 * Port: 8099 + PB_PORT_OFFSET (per .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  decode_text,
  getitem,
  py_int,
  py_str,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8099 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Dummy superuser — NOT a real secret.
const SU_EMAIL = "keys-ci@example.test";
const SU_PASSWORD = "keys-ci-dummy-pw-000";
const PASSWORD = "test123456"; // shared app-user password, same convention as scripts/seed.ts

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  const mark = ok ? "✅" : "❌ MISMATCH";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label.padEnd(64)} → ${py_str(got)} (expected ${py_str(expected)})`);
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
  if (r.status === 204) return [204, {}];
  const raw = decode_text(new Uint8Array(await r.arrayBuffer()));
  if (r.ok) return [r.status, raw ? JSON.parse(raw) : {}];
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, {}];
  }
}

/**
 * A self-contained `pocketbase serve` clean-room using the repo's REAL
 * pb_hooks/ (a partial copy would strand the provisioning hooks fixtures need).
 */
class Room {
  port: number;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number) {
    this.port = port;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-item-keys-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    for (const f of fs.readdirSync(this.migrations_dir)) {
      if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(this.migrations_dir, f));
    }
    this.proc = null;
  }

  async start(): Promise<void> {
    run_checked(
      [
        POCKETBASE_BIN,
        "superuser",
        "upsert",
        SU_EMAIL,
        SU_PASSWORD,
        "--dir",
        this.data_dir,
        "--migrationsDir",
        this.migrations_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    this.proc = await roomkit.serve(
      this.port,
      this.data_dir,
      this.migrations_dir,
      roomkit.hooks_dir(this.tmp),
    );
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

/**
 * Create + approve a fresh user; its create hook auto-provisions an empty workspace,
 * membership, default vocab and one default project — the blank slate §2 needs.
 */
async function make_user(su_token: string, email: string, name: string): Promise<string> {
  const [status, r] = await api("POST", "/api/collections/users/records", su_token, {
    email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    name,
    verified: true,
    approved: true,
  });
  if (status !== 200) {
    throw new roomkit.SystemExit(`user create failed for ${email}: ${status} ${py_str(r)}`);
  }
  return getitem(r, "id");
}

async function login(email: string): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: PASSWORD,
  });
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new roomkit.SystemExit(`login failed for ${email}: ${py_str(r)}`);
  return tok;
}

async function find_workspace_id(su_token: string, owner_id: string): Promise<string> {
  const qs = urlencode({ filter: `owner='${owner_id}'`, perPage: 1 });
  const [, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, su_token);
  const items = r.items || [];
  if (!items.length) {
    throw new roomkit.SystemExit(
      `no auto-provisioned workspace found for owner ${owner_id}: ${py_str(r)}`,
    );
  }
  return getitem(items[0], "id");
}

async function find_project(su_token: string, workspace_id: string): Promise<any> {
  // shadow=false: the workspace shadow project (decision:shadow-project) is created BEFORE the default
  // one and would otherwise be picked here — it deliberately carries no prefix.
  const qs = urlencode({ filter: `workspace='${workspace_id}' && shadow=false`, perPage: 1 });
  const [, r] = await api("GET", `/api/collections/projects/records?${qs}`, su_token);
  const items = r.items || [];
  if (!items.length) {
    throw new roomkit.SystemExit(
      `no auto-provisioned project found for workspace ${workspace_id}: ${py_str(r)}`,
    );
  }
  return items[0];
}

function create_item(
  token: string,
  collection: string,
  workspace: string,
  project: string | null,
  label: string,
): Promise<[number, any]> {
  const body: Record<string, any> = { workspace };
  if (project !== null) body.project = project;
  body[collection === "milestones" ? "name" : "title"] = label;
  return api("POST", `/api/collections/${collection}/records`, token, body);
}

/**
 * The standing invariant: an item CREATED in a prefixed project wears a key — a committed
 * item never gains one later (PBTT-487), so a blank is permanent. Callers pass only projects
 * nothing keyless was MOVED into: §8's keep-empty ruling leaves such an arrival blank on
 * purpose, which is why the invariant cannot be phrased over a project's membership.
 */
async function unlabelled_items(su_token: string, project_ids: string[]): Promise<any[]> {
  const blank: any[] = [];
  for (const project_id of project_ids) {
    for (const collection of ["tasks", "decisions", "documents", "milestones"]) {
      const qs = urlencode({ filter: `project='${project_id}'`, perPage: 500 });
      const [, items] = await api("GET", `/api/collections/${collection}/records?${qs}`, su_token);
      for (const item of items.items || []) {
        if (!truthy(item.key ?? null)) blank.push(tup(collection, getitem(item, "id")));
      }
    }
  }
  return blank;
}

let s: number;

console.log(`════════ test_item_keys.ts — PBTT-422 identity proof (room on :${PORT}) ════════`);
const room = new Room(PORT);
try {
  await room.start();
  const su = await superuser_token();

  const uid = await make_user(su, "keys-a@example.com", "KeyAlice");
  const token = await login("keys-a@example.com");
  const WS = await find_workspace_id(su, uid);
  const default_project = await find_project(su, WS);
  console.log(`  fixtures: WS=${WS}  default project=${getitem(default_project, "id")}`);

  // ── §1 the project prefix ────────────────────────────────────────────────
  // COVERS: hook:keys.pb.js#onRecordCreate:projects
  // COVERS: hook:keys.pb.js#onRecordUpdate:projects
  console.log("\n── §1 project prefix: suggested from the name, choosable, unique, then fixed ──");
  check("the provisioned project got a prefix from its name", default_project.key ?? null, "MYP");

  let chosen: any;
  let dupe: any;
  let derived: any;
  let renamed: any;
  [s, chosen] = await api("POST", "/api/collections/projects/records", token, {
    name: "Website Redesign",
    key: "eng",
    owner: uid,
    workspace: WS,
  });
  check("create with a chosen prefix → 200", s, 200);
  check("the chosen prefix is stored uppercased", chosen.key ?? null, "ENG");

  [s, dupe] = await api("POST", "/api/collections/projects/records", token, {
    name: "Something Else",
    key: "ENG",
    owner: uid,
    workspace: WS,
  });
  check("a prefix already used in the workspace → 400", s, 400);

  [s, derived] = await api("POST", "/api/collections/projects/records", token, {
    name: "Marketing Site",
    owner: uid,
    workspace: WS,
  });
  check("create with no prefix → 200", s, 200);
  check("prefix suggested from the name", derived.key ?? null, "MAR");

  [s] = await api("PATCH", `/api/collections/projects/records/${getitem(chosen, "id")}`, token, {
    key: "ZZZ",
  });
  check("PATCHing a project's prefix → 400 (fixed after create)", s, 400);
  [s, renamed] = await api(
    "PATCH",
    `/api/collections/projects/records/${getitem(chosen, "id")}`,
    token,
    { name: "Renamed Entirely" },
  );
  check("renaming the project → 200", s, 200);
  check("the prefix does NOT follow the rename", renamed.key ?? null, "ENG");
  check("the project id does NOT change on rename", renamed.id ?? null, getitem(chosen, "id"));

  const P1 = getitem(default_project, "id");
  const P2 = getitem(chosen, "id");

  // ── §2 ONE sequence per project, shared by all four types ────────────────
  // COVERS: hook:keys.pb.js#onRecordCreate:tasks
  // COVERS: hook:keys.pb.js#onRecordCreate:decisions
  // COVERS: hook:keys.pb.js#onRecordCreate:documents
  // COVERS: hook:keys.pb.js#onRecordCreate:milestones
  console.log("\n── §2 one shared number sequence per project across all four item types ──");
  const minted: [string, any][] = [];
  for (const collection of ["tasks", "decisions", "documents", "milestones", "tasks"]) {
    let rec: any;
    [s, rec] = await create_item(token, collection, WS, P1, `${collection} item`);
    check(`create ${collection.padEnd(11)} in project 1 → 200`, s, 200);
    minted.push(tup(collection, rec));
  }
  const keys = minted.map(([, rec]) => rec.key ?? null);
  console.log(`  minted keys, in creation order: ${py_str(keys)}`);
  check("the four types draw from ONE sequence (no type sigil, no restart)", keys, [
    "MYP-1",
    "MYP-2",
    "MYP-3",
    "MYP-4",
    "MYP-5",
  ]);

  // ── §3 per-project independence ──────────────────────────────────────────
  console.log("\n── §3 a second project in the SAME workspace starts its own numbering at 1 ──");
  let p2_first: any;
  [s, p2_first] = await create_item(token, "tasks", WS, P2, "first in project 2");
  check("create task in project 2 → 200", s, 200);
  check("project 2's first item is numbered 1, not 6", p2_first.key ?? null, "ENG-1");

  // ── §4 concurrency ───────────────────────────────────────────────────────
  console.log("\n── §4 20 barrier-synchronized parallel creates in one project ──");
  const N = 20;
  // threading.Barrier(N) released all 20 threads together; here each worker's fetch is started
  // (create_item runs synchronously up to its fetch call) before any is awaited, so all 20
  // requests are in flight at once.
  const results: [number, any, any][] = await Promise.all(
    Array.from({ length: N }, async (_, i): Promise<[number, any, any]> => {
      const [status, body] = await create_item(token, "tasks", WS, P1, `parallel-${i}`);
      return tup(status, body.key ?? null, body.id ?? null);
    }),
  );

  const statuses = results.map((r) => r[0]);
  const parallel_keys = results.map((r) => r[1]);
  check("all 20 parallel creates succeeded (HTTP 200)", statuses, Array(N).fill(200));
  check(
    "all 20 keys are non-empty",
    parallel_keys.every((k) => truthy(k)),
    true,
  );
  console.log(
    `  sorted parallel keys: ${py_str(parallel_keys.filter((k) => truthy(k)).sort(by_code_point))}`,
  );
  check("20 keys are UNIQUE (no duplicates)", new Set(parallel_keys).size, N);

  // ── §5 immutability + the key follows the item through a move ────────────
  // COVERS: hook:keys.pb.js#onRecordUpdate:tasks
  // COVERS: hook:keys.pb.js#onRecordUpdate:decisions
  // COVERS: hook:keys.pb.js#onRecordUpdate:documents
  // COVERS: hook:keys.pb.js#onRecordUpdate:milestones
  console.log("\n── §5 the key is immutable, and it FOLLOWS the item across a project move ──");
  for (const [collection, rec] of minted.slice(0, 4)) {
    [s] = await api(
      "PATCH",
      `/api/collections/${collection}/records/${getitem(rec, "id")}`,
      token,
      { key: "HAX-1" },
    );
    check(`PATCHing ${collection.padEnd(11)} key → 400`, s, 400);
    let back: any;
    [s, back] = await api(
      "GET",
      `/api/collections/${collection}/records/${getitem(rec, "id")}`,
      token,
    );
    check(
      `${collection.padEnd(11)} key unchanged after the refusal`,
      back.key ?? null,
      rec.key ?? null,
    );
  }

  const mover = minted[0][1]; // MYP-1, a task
  let moved: any;
  [s, moved] = await api("PATCH", `/api/collections/tasks/records/${getitem(mover, "id")}`, token, {
    project: P2,
  });
  check("moving the task to project 2 → 200", s, 200);
  check("the item id is unchanged by the move", moved.id ?? null, getitem(mover, "id"));
  check("the key follows the item, prefix and all", moved.key ?? null, "MYP-1");
  check("the item now lives in project 2", moved.project ?? null, P2);

  let after_move: any;
  [s, after_move] = await create_item(token, "tasks", WS, P2, "next in project 2");
  check("project 2's next item → 200", s, 200);
  check("the moved item did NOT consume a project-2 number", after_move.key ?? null, "ENG-2");
  check("no collision with the moved item's key", (after_move.key ?? null) !== "MYP-1", true);

  // A client cannot squat a label: the server owns it outright.
  let squat: any;
  let squat2: any;
  [s, squat] = await create_item(token, "tasks", WS, P2, "squatter");
  check("a fresh create → 200", s, 200);
  [s, squat2] = await api("POST", "/api/collections/tasks/records", token, {
    title: "squatter 2",
    workspace: WS,
    project: P2,
    key: "MYP-1",
  });
  check("a client-submitted key is ignored, not honoured", (squat2.key ?? null) !== "MYP-1", true);

  // ── §6 an item with no project carries no key ────────────────────────────
  // decision:shadow-project: such an item now lands in the workspace shadow project, which takes no
  // prefix of its own — so the keyless bound below is unchanged.
  console.log("\n── §6 declared bound: an item created with no project has no prefix to wear ──");
  let loose: any;
  [s, loose] = await create_item(token, "tasks", WS, null, "workspace-scoped task");
  check("create a task submitting no project → 200", s, 200);
  check("it carries no key", loose.key ?? null, "");

  // ── §7 identity stays opaque ─────────────────────────────────────────────
  console.log("\n── §7 the addressable identity is the opaque id, never the prefix ──");
  check("the project id is a 15-char opaque string", P2.length, 15);
  check("the project name does not appear in its id", P2.toLowerCase().includes("renamed"), false);
  check(
    "the prefix does not appear in the item id",
    getitem(mover, "id").toLowerCase().includes("myp"),
    false,
  );
  let by_id: any;
  [s, by_id] = await api("GET", `/api/collections/projects/records/${P2}`, token);
  check("the renamed project is still reachable by that id", s, 200);

  // ── §8 keyless items are keyless for life ────────────────────────────────
  // COVERS: hook:keys.pb.js#onRecordUpdateRequest:tasks
  // COVERS: hook:keys.pb.js#onRecordUpdateRequest:decisions
  // COVERS: hook:keys.pb.js#onRecordUpdateRequest:documents
  // COVERS: hook:keys.pb.js#onRecordUpdateRequest:milestones
  // Bounded: for milestones the two tiers are indistinguishable from outside — `project` is
  // required there, so the keyless case only this hook refuses cannot be constructed.
  console.log("\n── §8 a keyless item stays keyless: no client-minted label, no mint at move ──");
  for (const collection of ["tasks", "decisions", "documents"]) {
    let keyless: any;
    [s, keyless] = await create_item(token, collection, WS, null, `keyless ${collection}`);
    check(
      `${collection.padEnd(9)} created with no project → 200, empty key`,
      tup(s, keyless.key ?? null),
      tup(200, ""),
    );
    [s] = await api(
      "PATCH",
      `/api/collections/${collection}/records/${getitem(keyless, "id")}`,
      token,
      { key: "ANY-99" },
    );
    check(`PATCHing a label onto the keyless ${collection.padEnd(9)} → 400`, s, 400);
    let back: any;
    [s, back] = await api(
      "GET",
      `/api/collections/${collection}/records/${getitem(keyless, "id")}`,
      token,
    );
    check(`the keyless ${collection.padEnd(9)} still carries no key`, back.key ?? null, "");
  }

  // Ruled keep-empty: assignItemKey is the only minter, so moving into a project with a
  // prefix does NOT retro-mint a label — the id tail keeps covering display.
  let p2_before: any;
  [s, p2_before] = await api("GET", `/api/collections/projects/records/${P2}`, token);
  const seq_before_move = getitem(p2_before, "item_seq");
  let arrived: any;
  [s, arrived] = await api(
    "PATCH",
    `/api/collections/tasks/records/${getitem(loose, "id")}`,
    token,
    { project: P2 },
  );
  check("moving a keyless task INTO a project → 200", s, 200);
  check("it is still keyless after the move (keep-empty ruling)", arrived.key ?? null, "");
  check("the move did land", arrived.project ?? null, P2);
  let next_item: any;
  [s, next_item] = await create_item(token, "tasks", WS, P2, "after the keyless arrival");
  check(
    "the keyless arrival consumed no project-2 number",
    next_item.key ?? null,
    `ENG-${seq_before_move + 1}`,
  );

  // ── §10 a refused create burns no number ─────────────────────────────────
  // COVERS: hook:keys.pb.js#onRecordAfterCreateSuccess:tasks
  // COVERS: hook:keys.pb.js#onRecordAfterCreateSuccess:decisions
  // COVERS: hook:keys.pb.js#onRecordAfterCreateSuccess:documents
  // COVERS: hook:keys.pb.js#onRecordAfterCreateSuccess:milestones
  console.log("\n── §10 a refused create leaves the sequence untouched; the next takes MAX+1 ──");
  let leak: any;
  [s, leak] = await api("POST", "/api/collections/projects/records", token, {
    name: "Leak Guard",
    key: "LEAK",
    owner: uid,
    workspace: WS,
  });
  check("a fresh project for the leak proof → 200", s, 200);
  const P3 = getitem(leak, "id");

  let first: any;
  [s, first] = await create_item(token, "tasks", WS, P3, "before the refusals");
  check("the project's first item is numbered 1", tup(s, first.key ?? null), tup(200, "LEAK-1"));
  let p3: any;
  [, p3] = await api("GET", `/api/collections/projects/records/${P3}`, token);
  check("the counter is at 1", p3.item_seq ?? null, 1);

  // A 400-char title exceeds tasks.title max=300, so PB refuses the write at validation —
  // which is downstream of the create hooks, where the number used to be claimed.
  const refused: number[] = [];
  for (let _ = 0; _ < 5; _++)
    refused.push((await create_item(token, "tasks", WS, P3, "X".repeat(400)))[0]);
  check("five over-long-title creates are each refused → 400", refused, Array(5).fill(400));
  let p3_after: any;
  [, p3_after] = await api("GET", `/api/collections/projects/records/${P3}`, token);
  check("five refusals advanced the counter by nothing", p3_after.item_seq ?? null, 1);

  let second: any;
  [s, second] = await create_item(token, "tasks", WS, P3, "after the refusals");
  check(
    "the next accepted create takes MAX+1, not MAX+6",
    tup(s, second.key ?? null),
    tup(200, "LEAK-2"),
  );

  // Claiming after the insert must not race: N barrier-released creates take N distinct,
  // contiguous numbers, or the fix traded a leak for duplicate labels.
  console.log("\n── §10b barrier-released concurrent creates take distinct, contiguous numbers ──");
  const M = 10;
  // As §4: all M fetches are started before any is awaited, which is what the Barrier guaranteed.
  const conc: [number, any][] = await Promise.all(
    Array.from({ length: M }, async (_, i): Promise<[number, any]> => {
      const [status, body] = await create_item(token, "tasks", WS, P3, `concurrent-${i}`);
      return tup(status, body.key ?? null);
    }),
  );
  const conc_statuses = conc.map((c) => c[0]);
  const num_key = (k: any): number => (truthy(k) ? py_int(k.split("-")[1]) : -1);
  const conc_keys = conc.map((c) => c[1]).sort((a, b) => num_key(a) - num_key(b));
  console.log(`  concurrent keys, in numeric order: ${py_str(conc_keys)}`);
  check(`all ${M} concurrent creates succeeded`, conc_statuses, Array(M).fill(200));
  check(
    `they took the next ${M} numbers with no gap and no duplicate`,
    conc_keys,
    Array.from({ length: M }, (_, i) => `LEAK-${3 + i}`),
  );
  let p3_final: any;
  [, p3_final] = await api("GET", `/api/collections/projects/records/${P3}`, token);
  check("the counter matches the highest number issued", p3_final.item_seq ?? null, 2 + M);

  // ── §10c the counter is server-owned ─────────────────────────────────────
  // COVERS: hook:keys.pb.js#onRecordUpdateRequest:projects
  // Rewinding it hands the next create a number an item already wears: the unique index on
  // (workspace, key) then refuses the label AFTER the row is committed, and PBTT-487 means
  // that item never gains one.
  console.log("\n── §10c no API caller may rewind the item counter ──");
  const seq_now = getitem(p3_final, "item_seq");
  [s] = await api("PATCH", `/api/collections/projects/records/${P3}`, token, { item_seq: 0 });
  check("a member PATCHing the item counter → 400", s, 400);
  [s] = await api("PATCH", `/api/collections/projects/records/${P3}`, su, { item_seq: 0 });
  check("a SUPERUSER PATCHing it over the API → 400 too", s, 400);
  let p3_guarded: any;
  [, p3_guarded] = await api("GET", `/api/collections/projects/records/${P3}`, token);
  check("the counter is unchanged by the refusals", p3_guarded.item_seq ?? null, seq_now);
  let ordinary: any;
  [s, ordinary] = await api("PATCH", `/api/collections/projects/records/${P3}`, token, {
    description: "an ordinary edit",
  });
  check("an edit that leaves the counter alone → 200", s, 200);
  let unrewound: any;
  [s, unrewound] = await create_item(token, "tasks", WS, P3, "after the refused rewind");
  check(
    "the next create still takes MAX+1 and wears a real key",
    tup(s, unrewound.key ?? null),
    tup(200, `LEAK-${seq_now + 1}`),
  );

  // ── §10d the standing invariant ──────────────────────────────────────────
  console.log("\n── §10d every item created in a prefixed project wears a key ──");
  const blank = await unlabelled_items(su, [P1, P3]);
  check("no item created in a prefixed project is missing its label", blank, []);
} finally {
  await room.stop();
  room.cleanup_tmp();
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
  process.exit(0);
}

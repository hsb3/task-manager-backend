#!/usr/bin/env bun
/**
 * E2E proof of the G3 (#74) `saved_views` collection: personal-vs-workspace
 * visibility (a personal view is owner-only visible; a workspace view is member-read),
 * the body-owner spoof guard on create, and update/delete authority (self-owner,
 * workspace-owner "+ws-owner lean", plain-member denial).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
 * Port 8132 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  py_get,
  py_repr,
  py_str,
  run_checked,
  truthy,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8132 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(64)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
): Promise<any> {
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
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-saved-views-test-"));
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

  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  tierkit.use(api);
  const bob_member = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");

  const cleanup_view_ids: string[] = [];
  let s: number;
  let r: any;

  // COVERS: rule:saved_views.create
  // ══════════════════ 1. create ═══════════════════════════════════════════════
  console.log("\n── (1) create: personal + workspace views; owner-spoof guard; anon ──");
  let personal: any;
  [s, personal] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: ALICE_WS,
    owner: alice_id,
    name: "Alice Personal",
    filterData: {},
    scope: "personal",
  });
  check("Alice creates a PERSONAL view → 200", s, 200);
  const alice_personal_id = personal.id ?? null;
  if (truthy(alice_personal_id)) cleanup_view_ids.push(alice_personal_id);

  let ws_view: any;
  [s, ws_view] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: ALICE_WS,
    owner: alice_id,
    name: "Alice Workspace View",
    filterData: {},
    scope: "workspace",
  });
  check("Alice creates a WORKSPACE view → 200", s, 200);
  const alice_ws_view_id = ws_view.id ?? null;
  if (truthy(alice_ws_view_id)) cleanup_view_ids.push(alice_ws_view_id);

  [s] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: ALICE_WS,
    owner: bob_id,
    name: "Spoof Attempt",
    filterData: {},
    scope: "personal",
  });
  check("Alice POST with owner=Bob's id (spoof) → 400", s, 400);

  [s] = await api("POST", "/api/collections/saved_views/records", null, {
    workspace: ALICE_WS,
    owner: alice_id,
    name: "Anon Attempt",
    filterData: {},
    scope: "personal",
  });
  check("Anon create → 400", s, 400);

  // COVERS: rule:saved_views.list, rule:saved_views.view
  // ══════════════════ 2. visibility ═══════════════════════════════════════════
  console.log("\n── (2) visibility: member sees workspace view, not owner's personal view ──");
  [s, r] = await api(
    "GET",
    `/api/collections/saved_views/records?filter=(workspace='${py_str(ALICE_WS)}')`,
    bob,
  );
  check("Bob (member) list Alice-ws views → 200", s, 200);
  const bob_list_ids = py_get(r, "items", []).map((i: any) => getitem(i, "id"));
  check(
    "Bob's list includes Alice's WORKSPACE view",
    bob_list_ids.includes(alice_ws_view_id),
    true,
  );
  check(
    "Bob's list does NOT include Alice's PERSONAL view",
    bob_list_ids.includes(alice_personal_id),
    false,
  );

  [s, r] = await api(
    "GET",
    `/api/collections/saved_views/records?filter=(workspace='${py_str(ALICE_WS)}')`,
    carol,
  );
  check("Carol (non-member) list → 200 empty", tup(s, r.items ?? null), tup(200, []));

  [s] = await api("GET", `/api/collections/saved_views/records/${py_str(alice_personal_id)}`, bob);
  check("Bob view of Alice's PERSONAL view → 404", s, 404);
  [s] = await api("GET", `/api/collections/saved_views/records/${py_str(alice_ws_view_id)}`, bob);
  check("Bob view of Alice's WORKSPACE view → 200", s, 200);

  // COVERS: rule:saved_views.create, rule:saved_views.list
  // ══════════════════ 3. Bob's own personal view is owner-only visible ═══════
  console.log("\n── (3) Bob's own personal view: visible to Bob, NOT to the ws-owner ──");
  let bob_personal: any;
  [s, bob_personal] = await api("POST", "/api/collections/saved_views/records", bob, {
    workspace: ALICE_WS,
    owner: bob_id,
    name: "Bob Personal",
    filterData: {},
    scope: "personal",
  });
  check("Bob creates his own PERSONAL view in Alice's ws → 200", s, 200);
  const bob_personal_id = bob_personal.id ?? null;

  [s, r] = await api(
    "GET",
    `/api/collections/saved_views/records?filter=(workspace='${py_str(ALICE_WS)}')`,
    alice,
  );
  const alice_list_ids = py_get(r, "items", []).map((i: any) => getitem(i, "id"));
  check(
    "Alice's list does NOT include Bob's personal view",
    alice_list_ids.includes(bob_personal_id),
    false,
  );

  [s, r] = await api(
    "GET",
    `/api/collections/saved_views/records?filter=(workspace='${py_str(ALICE_WS)}')`,
    bob,
  );
  const bob_list_ids2 = py_get(r, "items", []).map((i: any) => getitem(i, "id"));
  check(
    "Bob's own list DOES include his personal view",
    bob_list_ids2.includes(bob_personal_id),
    true,
  );

  // COVERS: rule:saved_views.update, rule:saved_views.delete
  // ══════════════════ 4. update/delete authority ══════════════════════════════
  console.log("\n── (4) update/delete authority ──");
  [s, r] = await api(
    "PATCH",
    `/api/collections/saved_views/records/${py_str(bob_personal_id)}`,
    bob,
    { name: "Bob Personal Renamed" },
  );
  check("owner (Bob) updates his own view → 200", s, 200);

  [s, r] = await api(
    "PATCH",
    `/api/collections/saved_views/records/${py_str(bob_personal_id)}`,
    alice,
    { name: "Bob Personal Renamed by Alice" },
  );
  check("ws-owner (Alice) updates Bob's view → 200 (+ws-owner lean)", s, 200);

  [s] = await api(
    "DELETE",
    `/api/collections/saved_views/records/${py_str(bob_personal_id)}`,
    alice,
  );
  check("ws-owner (Alice) deletes Bob's view → 204", s, 204);

  [s] = await api(
    "PATCH",
    `/api/collections/saved_views/records/${py_str(alice_ws_view_id)}`,
    bob,
    { name: "hijacked" },
  );
  check(
    "plain member (Bob, not owner/admin) updates Alice's view → 404",
    tup(await bob_member.now(), s),
    tup("member", 404),
  );

  [s] = await api(
    "PATCH",
    `/api/collections/saved_views/records/${py_str(alice_ws_view_id)}`,
    null,
    { name: "hijacked" },
  );
  check("anon update → 404", s, 404);
  [s] = await api(
    "DELETE",
    `/api/collections/saved_views/records/${py_str(alice_ws_view_id)}`,
    null,
  );
  check("anon delete → 404", s, 404);

  // Round-trip proof for the 1785153400 field additions rides the create/update/view rules.
  // COVERS: rule:saved_views.create, rule:saved_views.update, rule:saved_views.view
  // ══════════════════ 5. full-field create round-trip ═════════════════════════
  console.log("\n── (5) full-field create: every new field set at once, GET round-trip ──");
  const ALICE_PROJECT = getitem(
    (await find_by_filter("projects", `workspace='${py_str(ALICE_WS)}'`, alice))[0],
    "id",
  );

  const full_clauses = [
    { field: "status", op: "is", value: "open" },
    { field: "labels", op: "has", value: ["bug"] },
  ];
  const full_columns = ["priority", "due", "assignee"];
  const full_sort = { field: "due", order: "desc" };

  let full: any;
  [s, full] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: ALICE_WS,
    owner: alice_id,
    name: "Full Field View",
    scope: "personal",
    filterData: full_clauses,
    description: "A saved view with every optional field populated",
    columns: full_columns,
    sort: full_sort,
    position: 3,
    density: "compact",
    mode: "board",
    group_by: "priority",
    project: ALICE_PROJECT,
  });
  check("full-field create → 200", s, 200);
  const full_id = full.id ?? null;
  if (truthy(full_id)) cleanup_view_ids.push(full_id);

  let got: any;
  [s, got] = await api("GET", `/api/collections/saved_views/records/${py_str(full_id)}`, alice);
  check("full-field GET → 200", s, 200);
  check(
    "GET description",
    got.description ?? null,
    "A saved view with every optional field populated",
  );
  check("GET columns (ordered array)", got.columns ?? null, full_columns);
  check("GET sort object", got.sort ?? null, full_sort);
  check("GET position", got.position ?? null, 3);
  check("GET density", got.density ?? null, "compact");
  check("GET mode", got.mode ?? null, "board");
  check("GET group_by", got.group_by ?? null, "priority");
  check("GET project", got.project ?? null, ALICE_PROJECT);
  check("GET filterData clause array round-trips unchanged", got.filterData ?? null, full_clauses);

  // ══════════════════ 6. PATCH round-trip: mutate every new field ═════════════
  console.log("\n── (6) PATCH: mutate every new field, GET, verify each persisted ──");
  const patched_columns = ["due", "priority", "assignee"];
  const patched_sort = { field: "priority", order: "asc" };

  [s] = await api("PATCH", `/api/collections/saved_views/records/${py_str(full_id)}`, alice, {
    description: "Updated description text",
    columns: patched_columns,
    sort: patched_sort,
    position: 7,
    density: "cozy",
    mode: "list",
    group_by: "none",
    project: "",
  });
  check("full-field PATCH → 200", s, 200);

  let got2: any;
  [s, got2] = await api("GET", `/api/collections/saved_views/records/${py_str(full_id)}`, alice);
  check("post-PATCH GET → 200", s, 200);
  check("PATCHed description", got2.description ?? null, "Updated description text");
  check("PATCHed columns (reordered)", got2.columns ?? null, patched_columns);
  check("PATCHed sort object", got2.sort ?? null, patched_sort);
  check("PATCHed position", got2.position ?? null, 7);
  check("PATCHed density", got2.density ?? null, "cozy");
  check("PATCHed mode", got2.mode ?? null, "list");
  check("PATCHed group_by", got2.group_by ?? null, "none");
  check("PATCHed project cleared", got2.project ?? null, "");

  // ══════════════════ 7. negative select: out-of-enum value ═══════════════════
  console.log(
    "\n── (7) negative: out-of-enum select value is rejected, not stored as free text ──",
  );
  [s] = await api("PATCH", `/api/collections/saved_views/records/${py_str(full_id)}`, alice, {
    density: "spacious",
  });
  check("PATCH density to out-of-enum value → 400", s, 400);

  // ══════════════════ 8. cross-workspace project scope guard (PBTT-429) ═══════
  // COVERS: hook:scope.pb.js#onRecordCreate:saved_views, hook:scope.pb.js#onRecordUpdate:saved_views
  console.log("\n── (8) a view's project must belong to the view's workspace ──");
  const BOB_WS = await find_id("workspaces", "name", "Bob's Workspace", bob);
  const FOREIGN_PROJECT = getitem(
    (await find_by_filter("projects", `workspace='${py_str(BOB_WS)}'`, bob))[0],
    "id",
  );
  check(
    "Alice is NOT a member of Bob's workspace (foreign by construction)",
    await find_by_filter(
      "workspace_members",
      `(workspace='${py_str(BOB_WS)}' && user='${alice_id}')`,
      su,
    ),
    [],
  );

  let guard_view: any;
  [s, guard_view] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: ALICE_WS,
    owner: alice_id,
    name: "Scope Guard View",
    scope: "workspace",
    project: ALICE_PROJECT,
  });
  check("create with a SAME-workspace project → 200 (guard does not over-fire)", s, 200);
  const guard_view_id = guard_view.id ?? null;
  if (truthy(guard_view_id)) cleanup_view_ids.push(guard_view_id);

  [s] = await api("PATCH", `/api/collections/saved_views/records/${py_str(guard_view_id)}`, alice, {
    project: FOREIGN_PROJECT,
  });
  check("ws-owner PATCHes project to a FOREIGN-workspace project → 400", s, 400);
  let unchanged: any;
  [s, unchanged] = await api(
    "GET",
    `/api/collections/saved_views/records/${py_str(guard_view_id)}`,
    alice,
  );
  check(
    "rejected PATCH left the stored project unchanged",
    unchanged.project ?? null,
    ALICE_PROJECT,
  );

  [s] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: ALICE_WS,
    owner: alice_id,
    name: "Foreign Project At Create",
    scope: "workspace",
    project: FOREIGN_PROJECT,
  });
  check("create with a FOREIGN-workspace project → 400", s, 400);
  check(
    "no such view was stored",
    await find_by_filter("saved_views", "name='Foreign Project At Create'", su),
    [],
  );

  [s] = await api("PATCH", `/api/collections/saved_views/records/${py_str(guard_view_id)}`, alice, {
    name: "Scope Guard View renamed",
  });
  check("PATCH that leaves project alone still succeeds → 200", s, 200);

  // ══════════════════ 9. group_by value set (wjw7) ════════════════════════════
  // COVERS: rule:saved_views.create
  console.log("\n── (9) group_by stores the list grouping vocabulary and nothing wider ──");
  for (const group of ["status", "assignee", "priority", "none", "project"]) {
    let stored: any;
    [s, stored] = await api("POST", "/api/collections/saved_views/records", alice, {
      workspace: ALICE_WS,
      owner: alice_id,
      name: `Group By ${group}`,
      scope: "personal",
      group_by: group,
    });
    check(
      `create group_by=${py_repr(group)} → 200, stored`,
      tup(s, stored.group_by ?? null),
      tup(200, group),
    );
    if (truthy(stored.id)) cleanup_view_ids.push(getitem(stored, "id"));
  }

  // Countable by GET /project_items/counts but not renderable as a saved layout — the widen
  // is bounded to ListGroupKey, not to the counts endpoint's SUPPORTED_GROUPS.
  for (const group of ["type", "label"]) {
    [s] = await api("POST", "/api/collections/saved_views/records", alice, {
      workspace: ALICE_WS,
      owner: alice_id,
      name: `Group By ${group}`,
      scope: "personal",
      group_by: group,
    });
    check(`create group_by=${py_repr(group)} (countable, not layoutable) → 400`, s, 400);
    check(
      `no view stored for group_by=${py_repr(group)}`,
      await find_by_filter("saved_views", `name='Group By ${group}'`, su),
      [],
    );
  }

  // ══════════════════ cleanup ══════════════════════════════════════════════════
  console.log("\n── cleanup ──");
  for (const vid of cleanup_view_ids) {
    [s] = await api("DELETE", `/api/collections/saved_views/records/${vid}`, alice);
    check(`cleanup: view ${vid.slice(0, 8)} removed`, s, 204);
  }

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
  console.log("✅ all saved_views proofs passed");
  process.exit(0);
}

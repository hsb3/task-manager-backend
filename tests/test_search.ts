#!/usr/bin/env bun
/**
 * E2E proof of the G3 (#74) custom route `GET /api/tracker/search?q=`: anon 401,
 * self-scoped membership (the no-leak proof — a non-member must see ZERO results
 * across several alice-matching terms, a member sees the SAME task set as the
 * owner), title-over-body ranking, the CAP=20 result limit, and trash exclusion on
 * BOTH hops for every searchable type — a task/document/decision/milestone trashed on
 * its own marker, a trashed project, and a LIVE item whose PROJECT is trashed — each of
 * which returns to search on restore — plus the draft carve-out on documents/decisions/
 * milestones (author, workspace owner and ACTIVE admin member only; a plain member never
 * finds another user's draft, and non-draft rows stay searchable for everyone).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8103 + PB_PORT_OFFSET (suite self-boot band, 8100+).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  by_code_point,
  py_repr,
  py_rstrip,
  py_str,
  run_checked,
  truthy,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8103 + PORT_OFFSET;
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
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
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
  const tok = r.token;
  if (!tok) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

function search(term: string, token: string | null): Promise<[number, any]> {
  const qs = urlencode({ q: term });
  return api("GET", `/api/tracker/search?${qs}`, token);
}

function is_sorted_asc(ranks: number[]): boolean {
  return ranks.every((rank, i) => i === ranks.length - 1 || rank <= ranks[i + 1]!);
}

/** One LIVE row of each item type inside `project` (milestones require a project). */
async function make_items(
  token: string,
  workspace: string,
  project: string | null,
  tag: string,
): Promise<Record<string, any>> {
  const made: Record<string, any> = {};
  for (const [coll, payload] of [
    ["tasks", { title: `${tag} task` }],
    ["documents", { title: `${tag} doc` }],
    ["decisions", { title: `${tag} decision` }],
    ["milestones", { name: `${tag} milestone` }],
  ] as [string, Record<string, any>][]) {
    Object.assign(payload, { workspace, project });
    const [s, rec] = await api("POST", `/api/collections/${coll}/records`, token, payload);
    check(`(fixture) ${tag} ${coll} created`, s, 200);
    made[coll] = rec.id ?? null;
  }
  return made;
}

async function hits(term: string, token: string | null, label: string): Promise<Set<string>> {
  const [s, r] = await search(term, token);
  check(`${label}: search ${py_repr(term)} → 200`, s, 200);
  return new Set((r.results ?? []).map((row: any) => getitem(row, "id")));
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-search-test-"));
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

  // auth ONCE per user — the auth endpoint rate-limits (429) on repeated logins
  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const [carol, carol_id] = await login("carol@example.com");

  let s: number;
  let r: any;

  const ALICE_WS = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("resolved Alice's workspace", truthy(ALICE_WS), true);
  check("resolved Alice's project 'Website Redesign'", truthy(ALICE_PROJECT), true);
  const BOB_WS = await find_id("workspaces", "name", "Bob's Workspace", bob);
  const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob);
  check("resolved Bob's workspace", truthy(BOB_WS), true);
  check("resolved Bob's project 'Mobile App'", truthy(BOB_PROJECT), true);

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 1. anon ══════════════════════════════════════════════
  console.log("\n── (1) anon search → 401 ──");
  [s] = await search("design", null);
  check("anon GET /api/tracker/search?q=design → 401", s, 401);

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 1b. control characters stripped from q before escaping ═
  console.log(
    "\n── (1b) control-byte queries: stripped, never left dangling in the LIKE pattern ──",
  );
  [s, r] = await search("\x00", alice);
  check(
    "q='\\x00' (a lone control byte) → 200, empty results",
    tup(s, r.results ?? null),
    tup(200, []),
  );
  // The plain (no control byte) query is the control for the next check: stripping means
  // '\x00abc' is executed as 'abc', so 0 hits only proves stripping worked if 'abc' ALONE
  // also produces 0 — otherwise a 0 here could just mean nothing happened to match.
  const [s_plain, r_plain] = await search("abc", alice);
  check(
    "control: q='abc' (no control byte) → 200, count 0 (nothing in the fixtures matches)",
    tup(s_plain, r_plain.count ?? null),
    tup(200, 0),
  );
  [s, r] = await search("\x00abc", alice);
  check(
    "q='\\x00abc' → 200, count 0 — SAME answer as the plain 'abc' control above, proving " +
      "the NUL no longer opens the whole readable set (it does not just happen to not match)",
    tup(s, r.count ?? null),
    tup(200, 0),
  );
  [s, r] = await search("zzzznomatch", alice);
  check("q='zzzznomatch' (control, no match) → 200, count 0", tup(s, r.count ?? null), tup(200, 0));

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 1b2. a control RUN collapses to ONE space — fragments never fuse ═
  console.log("\n── (1b2) a run of control bytes becomes one space, so 'a\\x00bc' never fuses ──");
  let planted: any;
  [s, planted] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "abc plain title",
    project: ALICE_PROJECT,
  });
  check("(fixture) task 'abc plain title' created", s, 200);
  const PLANTED_ID = planted.id ?? null;
  [s, r] = await search("abc", alice);
  check(
    "control: q='abc' FINDS the planted row — so a 0 below is the substitution, not luck",
    tup(s, new Set((r.results ?? []).map((row: any) => getitem(row, "id"))).has(PLANTED_ID)),
    tup(200, true),
  );
  [s, r] = await search("a\x00bc", alice);
  check(
    "q='a\\x00bc' → 200, count 0 — the NUL becomes a space, so the fragments never fuse " +
      "into a word the caller never typed",
    tup(s, r.count ?? null),
    tup(200, 0),
  );
  check("q='a\\x00bc' echoes the substituted text 'a bc'", r.query ?? null, "a bc");
  [s, r] = await search("a\x00\x01\x02bc", alice);
  check(
    "q with a RUN of control bytes echoes ONE space, not one per byte",
    tup(s, r.query ?? null),
    tup(200, "a bc"),
  );
  [s, r] = await search("\x01\x02\x03", alice);
  check(
    "q of control bytes ONLY → the empty-q early return still fires (space, then trimmed)",
    tup(s, r.query ?? null, r.count ?? null, r.results ?? null),
    tup(200, "", 0, []),
  );
  // DECLARED BOUND: substitution happens before the LIKE pattern is built, so a title holding
  // a literal control byte cannot be spelled by any query.
  let ctrl_row: any;
  [s, ctrl_row] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "ctrlbyte\x01inside",
    project: ALICE_PROJECT,
  });
  check("(fixture) task whose TITLE holds a literal control byte created", s, 200);
  const CTRL_ID = ctrl_row.id ?? null;
  [s, r] = await search("ctrlbyte\x01inside", alice);
  check(
    "documented bound: spelling that title verbatim does NOT find it (count 0)",
    tup(
      s,
      new Set((r.results ?? []).map((row: any) => getitem(row, "id"))).has(PLANTED_ID),
      r.count ?? null,
    ),
    tup(200, false, 0),
  );
  [s, r] = await search("ctrlbyte", alice);
  check(
    "the surviving fragment IS reachable — the row is not lost, only its exact spelling",
    tup(s, new Set((r.results ?? []).map((row: any) => getitem(row, "id"))).has(CTRL_ID)),
    tup(200, true),
  );
  for (const rid of [PLANTED_ID, CTRL_ID]) {
    await api("DELETE", `/api/collections/tasks/records/${rid}`, alice);
  }

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 1b3. workspace= present but EMPTY is a client bug ════════════════
  console.log("\n── (1b3) an explicitly empty workspace= → 400; an OMITTED one still works ──");
  let qs = urlencode({ q: "design", workspace: "" });
  [s, r] = await api("GET", `/api/tracker/search?${qs}`, alice);
  check("q=design&workspace= (present but empty) → 400", s, 400);
  check(
    "…naming the empty param (PB capitalizes and period-terminates on the wire)",
    py_rstrip(py_str(r.message ?? "").toLowerCase(), "."),
    "workspace query param must not be empty",
  );
  qs = urlencode({ q: "design", workspace: "   " });
  [s] = await api("GET", `/api/tracker/search?${qs}`, alice);
  check("q=design&workspace=<whitespace> → 400 as well", s, 400);
  [s, r] = await api("GET", "/api/tracker/search?q=design", alice);
  check("CONTROL: workspace OMITTED still answers 200 (cross-workspace mode intact)", s, 200);
  check("CONTROL: the omitted form still returns hits", (r.count ?? 0) > 0, true);

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 1c. workspace scoping — the cap lands inside the addressed ws ═
  console.log("\n── (1c) workspace=<id>: the cap applies inside that one workspace ──");
  const WSTAG = "wsscope9k2z";
  const crowded_ids: any[] = [];
  for (let i = 0; i < 22; i++) {
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", bob, {
      title: `${WSTAG} crowd ${String(i).padStart(2, "0")}`,
      project: ALICE_PROJECT,
    });
    check(`(fixture) ${WSTAG} crowded task ${i} created (Alice's workspace, bob member)`, s, 200);
    crowded_ids.push(t.id ?? null);
  }
  let sparse: any;
  [s, sparse] = await api("POST", "/api/collections/tasks/records", bob, {
    title: `${WSTAG} sparse`,
    project: BOB_PROJECT,
  });
  check(`(fixture) ${WSTAG} sparse task created (Bob's own workspace)`, s, 200);
  const sparse_id = sparse.id ?? null;

  qs = urlencode({ q: WSTAG, workspace: BOB_WS });
  [s, r] = await api("GET", `/api/tracker/search?${qs}`, bob);
  check("bob search scoped to his OWN (sparse) workspace → 200", s, 200);
  const scoped_ids = new Set((r.results ?? []).map((row: any) => getitem(row, "id")));
  check("scoped search returns exactly the sparse-workspace row", scoped_ids, new Set([sparse_id]));
  check("scoped search count == 1", r.count ?? null, 1);
  check("scoped search truncated is False (1 hit, well under the cap)", r.truncated ?? null, false);

  for (const cid of crowded_ids) {
    await api("DELETE", `/api/collections/tasks/records/${cid}`, bob);
  }
  [s] = await api("DELETE", `/api/collections/tasks/records/${sparse_id}`, bob);
  check(`cleanup: ${WSTAG} sparse task trapped to trash`, s, 204);

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 2. alice: shape + rank ordering ══════════════════════
  console.log("\n── (2) alice search 'design' → 200, non-empty, well-shaped, rank-sorted ──");
  [s, r] = await search("design", alice);
  check("alice search 'design' → 200", s, 200);
  let results: any[] = r.results ?? [];
  check("alice search 'design' results non-empty", results.length > 0, true);
  for (const row of results) {
    check(
      `result ${(row.id ?? "?").slice(0, 8)} has keys collection/id/title/rank`,
      ["collection", "id", "title", "rank"].every((k) => Object.hasOwn(row, k)),
      true,
    );
  }
  const ranks = results.map((row) => getitem(row, "rank"));
  check("ranks sorted ascending (all 0s before 1s)", is_sorted_asc(ranks), true);

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 2b. every hit carries its project id ═════════════════
  console.log("\n── (2b) per-hit project: item → its project id, project hit → '' ──");
  const PTAG = "projhit7q3x";
  const proj_made = await make_items(alice, ALICE_WS, ALICE_PROJECT, PTAG);
  let loose: any;
  [s, loose] = await api("POST", "/api/collections/tasks/records", alice, {
    title: `${PTAG} loose task`,
    workspace: ALICE_WS,
  });
  check("(fixture) unprojected task created", s, 200);
  [s, r] = await search(PTAG, alice);
  const proj_of = new Map<string, any>((r.results ?? []).map((row: any) => [row.id, row.project]));
  for (const coll of ["tasks", "documents", "decisions", "milestones"]) {
    check(`${coll} hit carries its project id`, proj_of.get(proj_made[coll]), ALICE_PROJECT);
  }
  // A create hook homes an unprojected task in the workspace's shadow project (decision:shadow-project),
  // so the hit carries that project's id — the same id project_items reported.
  const [, shadow_rec] = await api("GET", `/api/collections/projects/records/${loose.project}`, su);
  check(
    "unprojected task hit carries its shadow project id",
    tup(proj_of.get(loose.id), shadow_rec.shadow),
    tup(loose.project, true),
  );
  [s, r] = await search("redesign", alice);
  const proj_hit = (r.results ?? []).find((row: any) => row.id === ALICE_PROJECT);
  check(
    "project hit is present and carries project ''",
    tup(proj_hit?.collection, proj_hit?.project),
    tup("projects", ""),
  );
  for (const [coll, id] of [...Object.entries(proj_made), ["tasks", loose.id]]) {
    await api("DELETE", `/api/collections/${coll}/records/${id}`, alice);
  }

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 3. membership scoping — THE critical no-leak proof ═══
  console.log("\n── (3) carol (non-member): ZERO leakage across several alice-matching terms ──");
  for (const term of ["design", "homepage", "redesign", "ship", "landing"]) {
    [s, r] = await search(term, carol);
    check(
      `carol search ${py_repr(term)} → 200 empty (no leak)`,
      tup(s, r.results ?? null),
      tup(200, []),
    );
  }

  console.log("\n── (3) bob (member): SAME alice-workspace task ids as alice for 'design' ──");
  [s, r] = await search("design", alice);
  const alice_task_ids = (r.results ?? [])
    .filter((row: any) => getitem(row, "collection") === "tasks")
    .map((row: any) => getitem(row, "id"))
    .sort(by_code_point);
  [s, r] = await search("design", bob);
  check("bob search 'design' → 200", s, 200);
  const bob_task_ids = (r.results ?? [])
    .filter((row: any) => getitem(row, "collection") === "tasks")
    .map((row: any) => getitem(row, "id"))
    .sort(by_code_point);
  check(
    "bob's alice-workspace task-id set == alice's (member parity)",
    bob_task_ids,
    alice_task_ids,
  );

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 4. ranking: title-hit (rank 0) before body-only (rank 1) ═
  console.log("\n── (4) title-hit sorts before body-only-hit ──");
  let ms: any;
  [s, ms] = await api("POST", "/api/collections/milestones/records", alice, {
    workspace: ALICE_WS,
    project: ALICE_PROJECT,
    name: "Q3 goals",
    description: "ship the widget",
  });
  check("(fixture) milestone 'Q3 goals' (body-only 'ship' match) created", s, 200);
  const ms_id = ms.id ?? null;
  let tk: any;
  [s, tk] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Ship the widget",
    project: ALICE_PROJECT,
  });
  check("(fixture) task 'Ship the widget' (title-hit) created", s, 200);
  const tk_id = tk.id ?? null;

  [s, r] = await search("ship", alice);
  check("alice search 'ship' → 200", s, 200);
  results = r.results ?? [];
  check("results non-empty for 'ship'", results.length > 0, true);
  check(
    "results[0].rank == 0 (a title-hit sorts first)",
    results.length ? getitem(results[0], "rank") : null,
    0,
  );
  const body_hit = results.find((row) => getitem(row, "id") === ms_id) ?? null;
  check("body-only milestone hit present", truthy(body_hit), true);
  check("body-only milestone hit has rank == 1", body_hit ? getitem(body_hit, "rank") : null, 1);
  const title_hit = results.find((row) => getitem(row, "id") === tk_id) ?? null;
  check("title-hit task present with rank == 0", title_hit ? getitem(title_hit, "rank") : null, 0);

  [s] = await api("DELETE", `/api/collections/milestones/records/${ms_id}`, alice);
  check("cleanup: 'Q3 goals' milestone removed", s, 204);
  [s] = await api("DELETE", `/api/collections/tasks/records/${tk_id}`, alice);
  check("cleanup: 'Ship the widget' task removed (trap-to-trash)", s, 204);

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 5. CAP == 20, sort-before-slice ═══════════════════════
  console.log("\n── (5) cap: 25 title-hit tasks created, search returns exactly 20 ──");
  [s, r] = await search("zqxcap", alice);
  check("alice search 'zqxcap' before fixtures → 200", s, 200);
  check("cap: truncated is False (0 hits, well under the cap)", r.truncated ?? null, false);
  const cap_ids: any[] = [];
  for (let i = 0; i < 25; i++) {
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `zqxcap ${String(i).padStart(2, "0")}`,
      project: ALICE_PROJECT,
    });
    check(`(fixture) cap task ${i} created`, s, 200);
    cap_ids.push(t.id ?? null);
  }
  [s, r] = await search("zqxcap", alice);
  check("alice search 'zqxcap' → 200", s, 200);
  check("cap: truncated is True (25 hits > cap of 20)", r.truncated ?? null, true);
  check("cap: len(results) == 20", (r.results ?? []).length, 20);
  check(
    "cap: all returned rows are title-hits (rank 0)",
    (r.results ?? []).every((row: any) => getitem(row, "rank") === 0),
    true,
  );
  for (const cid of cap_ids) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${cid}`, alice);
    check(`cleanup: cap task ${cid.slice(0, 8)} trapped to trash`, s, 204);
  }

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 6. trash excluded — own marker, project's marker, restore ═
  console.log("\n── (6a) an item of EACH type, trashed on its own marker, leaves search ──");
  const own = await make_items(alice, ALICE_WS, ALICE_PROJECT, "trashme-uniqtok");
  const live = await hits("trashme-uniqtok", alice, "before trash");
  check("before trash: exactly the four fixtures match", live.size, 4);
  for (const [coll, rid] of Object.entries(own)) {
    check(`${coll}: live row IS found before trash`, live.has(rid), true);
  }
  for (const [coll, rid] of Object.entries(own)) {
    [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
    check(`${coll}: DELETE trashes the row → 204`, s, 204);
  }
  const gone = await hits("trashme-uniqtok", alice, "after trash");
  for (const [coll, rid] of Object.entries(own)) {
    check(`${coll}: trashed row ABSENT from search`, gone.has(rid), false);
  }
  check("after trash: nothing matching 'trashme-uniqtok' is searchable", gone.size, 0);

  console.log("\n── (6b) restore (clearing trashed) returns each item to search ──");
  for (const [coll, rid] of Object.entries(own)) {
    [s] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, alice, { trashed: "" });
    check(`${coll}: PATCH clearing trashed (restore) → 200`, s, 200);
  }
  const back = await hits("trashme-uniqtok", alice, "after restore");
  for (const [coll, rid] of Object.entries(own)) {
    check(`${coll}: restored row is searchable again`, back.has(rid), true);
  }
  for (const [coll, rid] of Object.entries(own)) {
    // live again — the first DELETE trashes, the second purges (owner-authorized)
    await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
    [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
    check(`cleanup: ${coll} 'trashme-uniqtok' fixture purged`, s, 204);
  }

  console.log("\n── (6c) a TRASHED project leaves search, and so do its LIVE items ──");
  let p: any;
  [s, p] = await api("POST", "/api/collections/projects/records", su, {
    name: "zzptrash project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  check("(fixture) project 'zzptrash project' created", s, 200);
  const ptr = p.id ?? null;
  const under = await make_items(alice, ALICE_WS, ptr, "zzptrash");
  let seen = await hits("zzptrash", alice, "project live");
  check("the LIVE project is itself searchable", seen.has(ptr), true);
  for (const [coll, rid] of Object.entries(under)) {
    check(`${coll}: control — row under the LIVE project is searchable`, seen.has(rid), true);
  }
  [s] = await api("DELETE", `/api/collections/projects/records/${ptr}`, alice);
  check("first DELETE trashes the project → 204", s, 204);
  const hidden = await hits("zzptrash", alice, "project trashed");
  check("the TRASHED project is ABSENT from search", hidden.has(ptr), false);
  for (const [coll, rid] of Object.entries(under)) {
    check(`${coll}: LIVE row under the TRASHED project ABSENT`, hidden.has(rid), false);
  }
  check("after project trash: nothing matching 'zzptrash' is searchable", hidden.size, 0);

  console.log("\n── (6d) restoring the project returns it AND its items to search ──");
  [s] = await api("PATCH", `/api/collections/projects/records/${ptr}`, alice, { trashed: "" });
  check("PATCH clearing project.trashed (restore) → 200", s, 200);
  const revived = await hits("zzptrash", alice, "project restored");
  check("the restored project is searchable again", revived.has(ptr), true);
  for (const [coll, rid] of Object.entries(under)) {
    check(`${coll}: row under the RESTORED project is searchable again`, revived.has(rid), true);
  }
  await api("DELETE", `/api/collections/projects/records/${ptr}`, alice);
  [s] = await api("DELETE", `/api/collections/projects/records/${ptr}`, alice);
  check("cleanup: 'zzptrash project' purged (cascades to its items)", s, 204);

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 7. draft privacy — search matches the listRule carve-out ═
  console.log("\n── (7) drafts: fixtures for each draft-bearing type, per author ──");
  const DTOK = "zzdrafttok";
  const DRAFT_COLLS = ["documents", "decisions", "milestones"];

  async function make_item(actor: string, coll: string, label: string, draft: boolean) {
    const field = coll === "milestones" ? "name" : "title";
    const [s, rec] = await api("POST", `/api/collections/${coll}/records`, actor, {
      [field]: `${DTOK} ${label}`,
      workspace: ALICE_WS,
      project: ALICE_PROJECT,
      draft,
    });
    check(`(fixture) ${coll} ${py_repr(label)} created (draft=${py_str(draft)})`, s, 200);
    return rec;
  }

  const alice_drafts: Record<string, any> = {};
  const bob_drafts: Record<string, any> = {};
  const live_rows: Record<string, any> = {};
  const orphan_drafts: Record<string, any> = {};
  for (const coll of DRAFT_COLLS) {
    let rec = await make_item(alice, coll, `alice draft ${coll}`, true);
    alice_drafts[coll] = rec.id ?? null;
    check(`(fixture) ${coll}: alice's draft is authored by alice`, rec.author ?? null, alice_id);
    check(`(fixture) ${coll}: alice's draft has draft=true`, rec.draft ?? null, true);
    rec = await make_item(bob, coll, `bob draft ${coll}`, true);
    bob_drafts[coll] = rec.id ?? null;
    check(`(fixture) ${coll}: bob's draft is authored by bob`, rec.author ?? null, bob_id);
    live_rows[coll] = (await make_item(alice, coll, `live ${coll}`, false)).id ?? null;
    // A superuser create keeps an empty author (author.pb.js), the legacy/programmatic shape.
    rec = await make_item(su, coll, `orphan draft ${coll}`, true);
    orphan_drafts[coll] = rec.id ?? null;
    check(`(fixture) ${coll}: the orphan draft has no author`, rec.author ?? null, "");
  }

  console.log("\n── (7a) alice: author of her drafts AND owner of the workspace ──");
  seen = await hits(DTOK, alice, "alice (owner + author)");
  for (const coll of DRAFT_COLLS) {
    check(`${coll}: the author finds her own draft`, seen.has(alice_drafts[coll]), true);
    check(`${coll}: the workspace owner finds a member's draft`, seen.has(bob_drafts[coll]), true);
    check(
      `${coll}: the workspace owner finds the orphan draft`,
      seen.has(orphan_drafts[coll]),
      true,
    );
    check(`${coll}: alice finds the non-draft row`, seen.has(live_rows[coll]), true);
  }

  console.log("\n── (7b) bob (ACTIVE member, role=member): another user's draft is invisible ──");
  seen = await hits(DTOK, bob, "bob (active member)");
  for (const coll of DRAFT_COLLS) {
    check(
      `${coll}: a plain member does NOT find another user's draft`,
      seen.has(alice_drafts[coll]),
      false,
    );
    check(`${coll}: the author finds his own draft`, seen.has(bob_drafts[coll]), true);
    check(
      `${coll}: a plain member does NOT find the orphan draft`,
      seen.has(orphan_drafts[coll]),
      false,
    );
    check(`${coll}: a plain member still finds the non-draft row`, seen.has(live_rows[coll]), true);
  }

  console.log("\n── (7c) carol as an ACTIVE admin member ──");
  // Carol joins here and stays a member for the rest of the run — every section above
  // proves non-member behaviour and must run first.
  let membership: any;
  [s, membership] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: carol_id,
    role: "admin",
    status: "active",
  });
  check("(fixture) carol added to Alice's workspace as an ACTIVE admin", s, 200);
  const mem_id = membership.id ?? null;
  seen = await hits(DTOK, carol, "carol (active admin)");
  for (const coll of DRAFT_COLLS) {
    check(
      `${coll}: an ACTIVE admin member finds another user's draft`,
      seen.has(alice_drafts[coll]),
      true,
    );
    check(
      `${coll}: an ACTIVE admin member finds the orphan draft`,
      seen.has(orphan_drafts[coll]),
      true,
    );
    check(
      `${coll}: an ACTIVE admin member finds the non-draft row`,
      seen.has(live_rows[coll]),
      true,
    );
  }

  console.log("\n── (7d) a non-ACTIVE admin membership confers nothing (PBTT-431) ──");
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${mem_id}`, su, {
    status: "suspended",
  });
  check("(fixture) carol's admin membership set to suspended", s, 200);
  seen = await hits(DTOK, carol, "carol (admin, status=suspended)");
  for (const coll of DRAFT_COLLS) {
    check(
      `${coll}: a suspended admin does NOT find the draft`,
      seen.has(alice_drafts[coll]),
      false,
    );
    check(
      `${coll}: a suspended admin does not find the non-draft row either`,
      seen.has(live_rows[coll]),
      false,
    );
  }

  console.log("\n── (7d cont.): a PENDING admin invitation, no membership row, confers nothing ──");
  // decision:invitation-keyed-by-email: workspace_members.createRule is null (only R3 mints one); a pending invitee
  // holds NO membership row at all until she accepts.
  [s] = await api("DELETE", `/api/collections/workspace_members/records/${mem_id}`, su);
  check("(fixture) carol's admin membership removed", s, 204);
  [s] = await api("POST", "/api/collections/workspace_invitations/records", su, {
    workspace: ALICE_WS,
    email: "carol@example.com",
    role: "admin",
  });
  check("(fixture) carol holds a pending admin invitation instead", s, 200);
  seen = await hits(DTOK, carol, "carol (pending invitee, no membership)");
  for (const coll of DRAFT_COLLS) {
    check(
      `${coll}: a pending invitee does NOT find the draft`,
      seen.has(alice_drafts[coll]),
      false,
    );
    check(
      `${coll}: a pending invitee does not find the non-draft row either`,
      seen.has(live_rows[coll]),
      false,
    );
  }
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all search proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * E2E proof of TASK-123: tasks.priority is validated against the task's workspace
 * `priorities` vocabulary (a JSON array of {id, name}; a task stores the entry id) on create AND update, via
 * pb_hooks/main.pb.js's validateTaskPriorityWs — an empty priority always passes, and a
 * task carrying a stale value (removed from the vocab after write) stays writable on
 * unrelated fields.
 *
 * Also proves PBTT-384: the workspace vocabulary ITSELF is validated element-by-element by
 * validateWorkspacePriorities — the unset token "none", blank names, non-object entries and a
 * non-array value are all rejected 400, while a legitimate custom vocabulary is accepted.
 *
 * And PBTT-448's three rulings on the edges PBTT-384 left open: an exact duplicate entry is
 * refused, a case VARIANT of another entry is accepted (the sibling statuses/labels UNIQUE
 * indexes are binary-collated and admit the same pair), a case variant of the reserved unset
 * token is refused, and an empty vocabulary is refused on UPDATE while staying legal on
 * CREATE, where the afterCreate seeder replaces it with the defaults.
 *
 * And bbmc (sections 9-14): entries carry server-minted 15-char ids, a rename or reorder keeps
 * them, a task stores the id (a name is refused), and project_items ranks by the id position.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy (PB_HOOKS_DIR
 * points it at a baseline tree instead, for the revert-probe), scripts/seed.ts fixtures.
 * Port 8140 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_repr,
  py_str,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8140 + PORT_OFFSET;
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
  const tok = r.token;
  if (!tok) throw new Error(`superuser auth failed: ${py_str(r)}`);
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
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-priority-vocab-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

const is_dict = (p: any): boolean => p !== null && typeof p === "object" && !Array.isArray(p);

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
  await superuser_token();

  console.log("\n── seed: alice/bob fixtures (scripts/seed.ts) ──");
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

  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("resolved Alice's workspace", truthy(ALICE_WS), true);
  check("resolved Alice's project", truthy(ALICE_PROJECT), true);

  tierkit.use(api);
  const bob_member = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");

  const DEFAULT_NAMES = ["urgent", "high", "medium", "low"];
  const ID_SHAPE = /^[a-z0-9]{15}$/;

  const vocab_of = async (ws_id: any, token: string | null = alice): Promise<any> =>
    (await api("GET", `/api/collections/workspaces/records/${ws_id}`, token))[1].priorities ?? null;

  const names_of = (priorities: any): any[] =>
    (priorities || []).map((p: any) => (is_dict(p) ? (p.name ?? null) : p));

  const ids_by_name = (priorities: any): Map<any, any> =>
    new Map(
      (priorities || []).filter(is_dict).map((p: any) => [p.name ?? null, p.id ?? null] as const),
    );

  const patch_vocab = (ws_id: any, value: any, token: string | null = alice) =>
    api("PATCH", `/api/collections/workspaces/records/${ws_id}`, token, { priorities: value });

  let s: number;
  let r: any;
  let ws: any;
  [s, ws] = await api("GET", `/api/collections/workspaces/records/${ALICE_WS}`, alice);
  check("seeded vocab names are urgent/high/medium/low", names_of(ws.priorities), DEFAULT_NAMES);
  const DEFAULT_ENTRIES = ws.priorities || [];
  const PID = ids_by_name(DEFAULT_ENTRIES);
  const P = (name: string): any => PID.get(name) ?? null;

  // ══════════════════ 1. rogue priority on CREATE → 400 ══════════════════════
  console.log("\n── (1) rogue priority on CREATE → 400 ──");
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-rogue-create",
    project: ALICE_PROJECT,
    priority: "URGENTISSIMO",
  });
  check("Alice creates task with rogue priority → 400", s, 400);

  // ══════════════════ 2. valid vocab id on CREATE → 200 ═══════════════════════
  console.log("\n── (2) valid vocab id on CREATE → 200 ──");
  let task: any;
  [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-valid-create",
    project: ALICE_PROJECT,
    priority: P("high"),
  });
  check("Alice creates task with the id of 'high' → 200", s, 200);
  const task_id = task.id;
  check("stored priority is the id of 'high'", task.priority, P("high"));

  // ══════════════════ 3. rogue priority on UPDATE → 400 ═══════════════════════
  console.log("\n── (3) rogue priority on UPDATE → 400 ──");
  [s] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
    priority: "SUPER-DUPER",
  });
  check("Alice PATCHes rogue priority → 400", s, 400);
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_id}`, alice);
  check("rejected PATCH left the stored priority untouched", r.priority, P("high"));

  // ══════════════════ 4. empty/clear priority → 200 (create + update) ═════════
  console.log("\n── (4) empty/clear priority → 200 ──");
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-empty-create",
    project: ALICE_PROJECT,
  });
  check("Alice creates task with no priority submitted → 200", s, 200);
  check("unset priority stored as ''", r.priority, "");
  const empty_task_id = r.id;

  [s, r] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, { priority: "" });
  check("Alice clears priority via PATCH → 200", s, 200);
  check("cleared priority reads back ''", r.priority, "");

  // ══════════════════ 5. BOB (workspace member) sees the same enforcement ═════
  console.log("\n── (5) role matrix: Bob (member of Alice's workspace) also enforced ──");
  [s] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "PV-bob-rogue",
    project: ALICE_PROJECT,
    priority: "WHATEVER",
  });
  // A non-member gets the same 400 from the createRule, so Bob's tier rides in the
  // assertion — a Bob with no membership would satisfy it without the vocab guard firing.
  check(
    "Bob (member) creates task with rogue priority → 400",
    tup(await bob_member.now(), s),
    tup("member", 400),
  );
  let bob_task: any;
  [s, bob_task] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "PV-bob-valid",
    project: ALICE_PROJECT,
    priority: P("medium"),
  });
  check("Bob (member) creates task with the id of 'medium' → 200", s, 200);

  // ══════════════════ 6. project-less (workspace-scoped, D2) task ═════════════
  console.log("\n── (6) project-less task: optional-relation traversal must still be covered ──");
  [s] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-projectless-rogue",
    workspace: ALICE_WS,
    priority: "BOGUS",
  });
  check("Alice creates project-less task with rogue priority → 400", s, 400);
  let projless: any;
  [s, projless] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-projectless-valid",
    workspace: ALICE_WS,
    priority: P("low"),
  });
  check("Alice creates project-less task with the id of 'low' → 200", s, 200);
  // decision:shadow-project: a create with no project lands in the workspace shadow project, which only
  // a superuser can resolve — the projects rules hide it from every tenant role.
  const [, _shadow] = await api(
    "GET",
    "/api/collections/projects/records?" +
      urlencode({ filter: `workspace='${ALICE_WS}' && shadow=true` }),
    await superuser_token(),
  );
  check(
    "the task submitted with no project sits in the workspace shadow project",
    projless.project,
    (_shadow.items || [{}])[0].id,
  );

  // ══════════════════ 7. AC#3 — stale value survives an unrelated-field PATCH ═
  console.log("\n── (7) AC#3: stale priority (vocab entry removed) survives an unrelated PATCH ──");
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
    priority: P("high"),
  });
  check(
    "(fixture) reset task priority to the id of 'high'",
    tup(s, r.priority),
    tup(200, P("high")),
  );
  let ws2: any;
  [s, ws2] = await patch_vocab(
    ALICE_WS,
    DEFAULT_ENTRIES.filter((p: any) => !(is_dict(p) && p.name === "high")),
  );
  check("(fixture) vocab retires 'high' — the task's stored id is now stale", s, 200);
  check(
    "vocab no longer holds the id of 'high'",
    [...ids_by_name(ws2.priorities).values()].includes(P("high")),
    false,
  );
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
    title: "PV-retitled",
  });
  check("PATCHing an UNRELATED field on the stale-priority task → 200 (not blocked)", s, 200);
  check("stale priority id is preserved, not revalidated", r.priority, P("high"));
  check("unrelated field (title) actually changed", r.title, "PV-retitled");
  [s] = await patch_vocab(ALICE_WS, DEFAULT_ENTRIES);
  check("(cleanup) vocab restored to the seeded entries, ids included", s, 200);
  check("  …and 'high' is back under its original id", ids_by_name(await vocab_of(ALICE_WS)), PID);

  // ══ 8. PBTT-384 — the workspace vocabulary itself is validated ══════════════
  console.log("\n── (8) PBTT-384: workspaces.priorities is validated element-by-element ──");
  // COVERS: hook:main.pb.js#onRecordCreateRequest:workspaces, hook:main.pb.js#onRecordUpdateRequest:workspaces
  [s, r] = await patch_vocab(ALICE_WS, [{ name: "urgent" }, { name: "none" }]);
  check("PATCH vocab containing the unset token 'none' → 400", s, 400);
  check(
    "rejection message names the reserved token",
    (r.message ?? "").includes("none") && (r.message ?? "").includes("reserved"),
    true,
  );
  console.log(`      message: ${py_repr(r.message ?? null)}`);
  check(
    "rejected PATCH left the stored vocab untouched",
    await vocab_of(ALICE_WS),
    DEFAULT_ENTRIES,
  );

  for (const [label, value] of [
    ["blank name", [{ name: "urgent" }, { name: "  " }]],
    ["empty-string name", [{ name: "urgent" }, { name: "" }]],
    ["non-string name", [{ name: "urgent" }, { name: 3 }]],
    ["missing name", [{ name: "urgent" }, { id: "abcdefghijklmno" }]],
    ["bare-string element", ["urgent", "high"]],
    ["non-array value", "urgent"],
    ["nested-array element", [{ name: "urgent" }, ["high"]]],
  ] as const) {
    [s, r] = await patch_vocab(ALICE_WS, value);
    check(`PATCH vocab with a ${label} → 400`, s, 400);
    check(
      `  ${label}: message names the shape rule`,
      (r.message ?? "").toLowerCase().startsWith("priorities must be an array"),
      true,
    );
  }

  // CREATE path is guarded too — a brand-new workspace cannot smuggle the token in.
  [s, r] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PV-ws-none-create",
    owner: alice_id,
    priorities: [{ name: "urgent" }, { name: "none" }],
  });
  check("CREATE workspace with 'none' in the vocab → 400", s, 400);

  // Negative control: the guard is not a blanket denial.
  [s, r] = await patch_vocab(ALICE_WS, [{ name: "p0" }, { name: "p1" }, { name: "p2" }]);
  check("PATCH a legitimate custom vocab → 200", s, 200);
  check("custom vocab names stored verbatim", names_of(r.priorities), ["p0", "p1", "p2"]);
  let custom_entries = r.priorities || [];
  // ══ 8b. duplicates, case variants, and an emptied vocabulary ═════
  console.log("\n── (8b) PBTT-448: the three edges PBTT-384 left unruled ──");
  [s, r] = await patch_vocab(ALICE_WS, [{ name: "high" }, { name: "medium" }, { name: "high" }]);
  check("PATCH vocab repeating an entry → 400", s, 400);
  check(
    "duplicate refusal names the repeat rule",
    (r.message ?? "").toLowerCase().startsWith("priorities cannot repeat"),
    true,
  );
  console.log(`      message: ${py_repr(r.message ?? null)}`);
  check(
    "rejected duplicate PATCH left the stored vocab untouched",
    await vocab_of(ALICE_WS),
    custom_entries,
  );

  // ── card 3k7z: a name is trimmed before every check ──
  [s, r] = await patch_vocab(ALICE_WS, [{ name: "high" }, { name: "high " }]);
  check("PATCH vocab with a name and its padded duplicate → 400", s, 400);
  check(
    "padded duplicate refusal names the repeat rule",
    (r.message ?? "").toLowerCase().startsWith("priorities cannot repeat"),
    true,
  );
  [s, r] = await patch_vocab(ALICE_WS, [{ name: "p0" }, { name: "  urgent  " }]);
  check("PATCH vocab with a padded name → 200", s, 200);
  check("the padded name is stored trimmed", names_of(r.priorities), ["p0", "urgent"]);
  custom_entries = r.priorities || [];

  // A case VARIANT is a different entry, not a duplicate: the sibling vocabularies
  // (statuses/labels) accept "High" alongside "high" through binary-collated UNIQUE
  // indexes, so priorities is not made the one stricter vocabulary in the app.
  [s, r] = await patch_vocab(ALICE_WS, [{ name: "High" }, { name: "high" }]);
  check("PATCH vocab with a case VARIANT of another entry → 200 (accepted by ruling)", s, 200);
  check("case-variant vocab names stored verbatim", names_of(r.priorities), ["High", "high"]);
  const variant_entries = r.priorities || [];
  [s, r] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "PV448High",
    category: "backlog",
    color: "gray",
  });
  check("(prior art) sibling vocabulary accepts 'PV448High'", s, 200);
  const variant_status = r.id;
  [s, r] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "pv448high",
    category: "backlog",
    color: "gray",
  });
  check("(prior art) sibling vocabulary also accepts its case variant 'pv448high'", s, 200);
  const variant_status2 = r.id;
  [s] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: ALICE_WS,
    name: "PV448High",
    category: "backlog",
    color: "gray",
  });
  check("(prior art) sibling vocabulary REFUSES an exact duplicate name → 400", s, 400);
  for (const sid of [variant_status, variant_status2]) {
    if (sid) await api("DELETE", `/api/collections/statuses/records/${sid}`, alice);
  }

  // The reserved token is reserved as a WORD — a case variant is the same reservation.
  for (const variant of ["None", "NONE", "nOnE"]) {
    [s, r] = await patch_vocab(ALICE_WS, [{ name: "urgent" }, { name: variant }]);
    check(`PATCH vocab containing ${py_repr(variant)} → 400`, s, 400);
    check(
      `  ${py_repr(variant)}: refusal names the reserved token`,
      (r.message ?? "").includes("reserved"),
      true,
    );
  }
  [s] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-none-variant",
    project: ALICE_PROJECT,
    priority: "None",
  });
  check("a task can never carry priority='None' (it is not a legal vocab entry) → 400", s, 400);

  [s, r] = await patch_vocab(ALICE_WS, []);
  // Nothing re-seeds on update, so [] would persist and leave the workspace unable to
  // accept any task priority at all.
  check("PATCH an empty vocab → 400 (a workspace must keep at least one priority)", s, 400);
  check(
    "empty-vocab refusal names the rule",
    (r.message ?? "").toLowerCase().startsWith("priorities cannot be emptied"),
    true,
  );
  console.log(`      message: ${py_repr(r.message ?? null)}`);
  check("rejected empty PATCH left the vocab intact", await vocab_of(ALICE_WS), variant_entries);
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-still-assignable",
    project: ALICE_PROJECT,
    priority: ids_by_name(variant_entries).get("high") ?? null,
  });
  check("a priority is still assignable after the refused emptying → 200", s, 200);
  const still_task = r.id;
  if (still_task) await api("DELETE", `/api/collections/tasks/records/${still_task}`, alice);

  // card 3k7z: JSON null empties the vocab exactly like [] — same refusal on UPDATE.
  [s, r] = await patch_vocab(ALICE_WS, null);
  check("PATCH priorities:null → 400 (refused like an empty array)", s, 400);
  check(
    "null refusal names the same rule as an emptied array",
    (r.message ?? "").toLowerCase().startsWith("priorities cannot be emptied"),
    true,
  );
  check("rejected null PATCH left the vocab intact", await vocab_of(ALICE_WS), variant_entries);
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-still-assignable-null",
    project: ALICE_PROJECT,
    priority: ids_by_name(variant_entries).get("high") ?? null,
  });
  check("a priority is still assignable after the refused null-emptying → 200", s, 200);
  const still_task2 = r.id;
  if (still_task2) await api("DELETE", `/api/collections/tasks/records/${still_task2}`, alice);

  // CREATE keeps [] legal: the afterCreate seeder replaces it with the defaults, so the
  // workspace is never left vocabulary-less by that path.
  let empty_ws: any;
  [s, empty_ws] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PV-ws-empty-create",
    owner: alice_id,
    priorities: [],
  });
  check("CREATE workspace with an explicitly empty vocab → 200", s, 200);
  if (empty_ws.id) {
    await Bun.sleep(500); // the seeder runs in an afterCreateSuccess hook, after the response
    check(
      "the seeder healed the empty vocab to the defaults",
      names_of(await vocab_of(empty_ws.id)),
      DEFAULT_NAMES,
    );
  }

  // The guard must not break workspace-create defaulting (main.pb.js's afterCreate seeder).
  let fresh: any;
  [s, fresh] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PV-ws-fresh",
    owner: alice_id,
  });
  check("CREATE workspace with no vocab submitted → 200", s, 200);
  await Bun.sleep(500); // the seeder runs in an afterCreateSuccess hook, after the response
  const fresh_vocab = await vocab_of(fresh.id);
  check("fresh workspace still gets the default vocab", names_of(fresh_vocab), DEFAULT_NAMES);

  // card 3k7z: CREATE keeps null legal too, same as [] — the seeder fills it in.
  let null_ws: any;
  [s, null_ws] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PV-ws-null-create",
    owner: alice_id,
    priorities: null,
  });
  check("CREATE workspace with priorities:null → 200", s, 200);
  if (null_ws.id) {
    await Bun.sleep(500); // the seeder runs in an afterCreateSuccess hook, after the response
    check(
      "the seeder healed the null vocab to the defaults",
      names_of(await vocab_of(null_ws.id)),
      DEFAULT_NAMES,
    );
  }

  // Role matrix: the guard is a VALUE check — it does not change who may edit at all.
  [s] = await patch_vocab(ALICE_WS, [{ name: "urgent" }, { name: "none" }], bob);
  check("Bob (member, not owner/admin) PATCHing the vocab → 404 (update denied)", s, 404);
  [s] = await patch_vocab(ALICE_WS, [{ name: "x" }], null);
  check("anon PATCHing the vocab → 404 (update denied)", s, 404);

  [s] = await patch_vocab(ALICE_WS, DEFAULT_ENTRIES);
  check("(cleanup) vocab restored to the seeded entries", s, 200);

  // ══ 9. bbmc — a created workspace's priorities are {id, name} ═══════════════
  console.log(
    "\n── (9) bbmc: every seeded entry is {id, name} with a 15-char record-alphabet id ──",
  );
  for (const [label, raw_entries] of [
    ["seeded (signup)", DEFAULT_ENTRIES],
    ["direct API create", fresh_vocab],
  ] as const) {
    const entries: any[] = raw_entries || [];
    check(
      `${label}: every entry is an object keyed exactly id + name`,
      entries.map((p) => (is_dict(p) ? Object.keys(p).sort(by_code_point) : p)),
      DEFAULT_NAMES.map(() => ["id", "name"]),
    );
    check(
      `${label}: every id is 15 chars of [a-z0-9]`,
      entries.every((p) => is_dict(p) && ID_SHAPE.test(py_str(p.id ?? null))),
      true,
    );
    check(
      `${label}: ids are unique within the array`,
      new Set(entries.filter(is_dict).map((p) => p.id ?? null)).size,
      DEFAULT_NAMES.length,
    );
  }
  const fresh_ids = new Set(ids_by_name(fresh_vocab).values());
  check(
    "two workspaces never share minted ids",
    new Set([...ids_by_name(DEFAULT_ENTRIES).values()].filter((x) => fresh_ids.has(x))),
    new Set(),
  );

  // ══ 10. bbmc — a rename keeps the id, and the task holding it stays valid ═══
  console.log(
    "\n── (10) bbmc: renaming an entry keeps its id; the task holding it still validates ──",
  );
  let rn_task: any;
  [s, rn_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-rename",
    project: ALICE_PROJECT,
    priority: P("high"),
  });
  check("(fixture) task holding the id of 'high' → 200", s, 200);
  const renamed = DEFAULT_ENTRIES.map((p: any) =>
    is_dict(p) ? { id: p.id ?? null, name: p.name === "high" ? "elevated" : (p.name ?? null) } : p,
  );
  [s, r] = await patch_vocab(ALICE_WS, renamed);
  check("PATCH renames 'high' to 'elevated', same id → 200", s, 200);
  check("the renamed entry keeps its id and position", (r.priorities || [null, null])[1], {
    id: P("high"),
    name: "elevated",
  });
  [s, r] = await api("GET", `/api/collections/tasks/records/${rn_task.id}`, alice);
  check("the task still holds that id", r.priority, P("high"));
  await api("PATCH", `/api/collections/tasks/records/${rn_task.id}`, alice, { priority: "" });
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${rn_task.id}`, alice, {
    priority: P("high"),
  });
  check(
    "re-submitting that id after the rename validates → 200",
    tup(s, r.priority),
    tup(200, P("high")),
  );
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-rename-old-name",
    project: ALICE_PROJECT,
    priority: "high",
  });
  check("the OLD name is not a key → 400", s, 400);

  // ══ 11. bbmc — a comma-bearing name is storable and addressable by id ══════
  console.log("\n── (11) bbmc: a comma-bearing name is storable and a task can hold its id ──");
  [s, r] = await patch_vocab(ALICE_WS, [...renamed, { name: "high, urgent" }]);
  check("PATCH adds a 'high, urgent' entry → 200", s, 200);
  const comma_id = ids_by_name(r.priorities).get("high, urgent");
  check(
    "the comma-bearing entry got a minted id",
    truthy(comma_id && ID_SHAPE.test(comma_id)),
    true,
  );
  let comma_task: any;
  [s, comma_task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-comma",
    project: ALICE_PROJECT,
    priority: comma_id ?? null,
  });
  check(
    "task holding the comma-bearing entry's id → 200",
    tup(s, comma_task.priority),
    tup(200, comma_id),
  );
  check(
    "a filter on that id finds exactly that task",
    (await find_by_filter("tasks", `priority='${comma_id}'`, alice)).map((t) => t.id),
    [comma_task.id],
  );

  // ══ 12. bbmc — a NAME is refused where an id is required ═══════════════════
  console.log(
    "\n── (12) bbmc: a task write carrying a NAME instead of an id → priority_not_in_vocabulary ──",
  );
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "PV-name-create",
    project: ALICE_PROJECT,
    priority: "urgent",
  });
  check("CREATE with priority='urgent' (a name) → 400", s, 400);
  check(
    "  …bound to the priority field with code priority_not_in_vocabulary",
    ((r.data || {}).priority || {}).code,
    "priority_not_in_vocabulary",
  );
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
    priority: "medium",
  });
  check("UPDATE with priority='medium' (a name) → 400", s, 400);
  check(
    "  …bound to the priority field with code priority_not_in_vocabulary",
    ((r.data || {}).priority || {}).code,
    "priority_not_in_vocabulary",
  );

  // ══ 13. bbmc — the view ranks by id position, and follows a reorder ════════
  console.log(
    "\n── (13) bbmc: project_items.priority_rank follows the id's position after a reorder ──",
  );
  let rk_prj: any;
  [s, rk_prj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "PV Rank",
    workspace: ALICE_WS,
    owner: alice_id,
  });
  check("(fixture) rank project created", s, 200);
  const rank_ids: Record<string, any> = {};
  for (const name of ["urgent", "low"]) {
    [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `PV-rank-${name}`,
      project: rk_prj.id,
      priority: P(name),
    });
    check(`(fixture) task holding the id of ${py_repr(name)} → 200`, s, 200);
    rank_ids[name] = r.id;
  }

  const ranks = async (): Promise<Record<string, any>> => {
    const rows = await find_by_filter("project_items", `project='${rk_prj.id}'`, alice);
    return Object.fromEntries(
      rows.map((row) => [
        getitem(row, "title").replaceAll("PV-rank-", ""),
        tup(getitem(row, "priority_rank"), getitem(row, "has_priority")),
      ]),
    );
  };

  const current = (await vocab_of(ALICE_WS)) || [];
  check("before the reorder: urgent ranks 0, low ranks 3", await ranks(), {
    urgent: tup(0, 1),
    low: tup(3, 1),
  });
  [s] = await patch_vocab(ALICE_WS, [...current].reverse());
  check("PATCH reverses the vocabulary order, ids kept → 200", s, 200);
  const last = current.length - 1;
  check("after the reorder: low ranks 1 and urgent ranks last", await ranks(), {
    urgent: tup(last, 1),
    low: tup(last - 3, 1),
  });
  check(
    "the reorder kept every id",
    [...ids_by_name(await vocab_of(ALICE_WS)).values()].sort(by_code_point),
    [...ids_by_name(current).values()].sort(by_code_point),
  );

  // ══ 14. bbmc — ids are minted server-side; a malformed one is refused ══════
  console.log(
    "\n── (14) bbmc: an entry without an id gets one; a malformed supplied id is refused ──",
  );
  const before = (await vocab_of(ALICE_WS)) || [];
  [s, r] = await patch_vocab(ALICE_WS, [...before, { name: "PV-minted" }]);
  let after = r.priorities || [];
  check("PATCH appends an entry sent with a name only → 200", s, 200);
  check("  …the existing entries kept their ids", after.slice(0, before.length), before);
  const minted = after.length ? after[after.length - 1] : {};
  check(
    "  …and the new entry carries a minted 15-char id",
    tup(
      is_dict(minted) ? (minted.name ?? null) : minted,
      is_dict(minted) && ID_SHAPE.test(py_str(minted.id ?? null)),
    ),
    tup("PV-minted", true),
  );
  const stored = await vocab_of(ALICE_WS);
  for (const [label, bad] of [
    ["too short", "abc"],
    ["uppercase", "ABCDEFGHIJKLMNO"],
    ["punctuation", "abcdefghijklm-o"],
    ["sixteen chars", "abcdefghijklmnop"],
    ["non-string", 123456789012345],
  ] as const) {
    [s, r] = await patch_vocab(ALICE_WS, [...stored, { id: bad, name: `PV-bad-${label}` }]);
    check(`PATCH with a ${label} id → 400`, s, 400);
    check(
      `  ${label}: refusal names the id shape`,
      (r.message ?? "").includes("id must be 15 lowercase letters or digits"),
      true,
    );
  }
  const dup_id = is_dict((stored || [null])[0]) ? ((stored || [{}])[0].id ?? null) : null;
  [s, r] = await patch_vocab(ALICE_WS, [...stored, { id: dup_id, name: "PV-dup-id" }]);
  check("PATCH repeating an existing id under another name → 400", s, 400);
  check(
    "  …refusal names the repeated id",
    (r.message ?? "").toLowerCase().startsWith("priorities cannot repeat an id"),
    true,
  );
  check("none of the refused PATCHes changed the vocabulary", await vocab_of(ALICE_WS), stored);
  // A client resending names alone must not re-key the vocabulary and orphan every task.
  [s] = await patch_vocab(
    ALICE_WS,
    stored.map((p: any) => ({ name: getitem(p, "name") })),
  );
  check("PATCH resending the stored names without ids → 200", s, 200);
  check("  …every entry keeps its stored id", await vocab_of(ALICE_WS), stored);
  const renamed2 = [
    { id: getitem(stored[0], "id"), name: "PV-renamed" },
    ...stored.map((p: any) => ({ name: getitem(p, "name") })),
  ];
  [s, r] = await patch_vocab(ALICE_WS, renamed2);
  after = await vocab_of(ALICE_WS);
  check(
    "a name-only entry whose stored id is sent under a new name gets a fresh id",
    tup(
      s,
      getitem(after[0], "id") === getitem(stored[0], "id"),
      getitem(after[1], "name"),
      getitem(after[1], "id") !== getitem(stored[0], "id"),
    ),
    tup(200, true, getitem(stored[0], "name"), true),
  );
  [s] = await patch_vocab(ALICE_WS, stored);
  check("(restore) vocab back to the stored entries", s, 200);
  [s, r] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PV-ws-mint-create",
    owner: alice_id,
    priorities: [{ name: "only" }],
  });
  check(
    "CREATE with a name-only entry mints its id too",
    tup(
      s,
      (r.priorities || []).map((p: any) => is_dict(p) && ID_SHAPE.test(py_str(p.id ?? null))),
    ),
    tup(200, [true]),
  );

  [s] = await patch_vocab(ALICE_WS, DEFAULT_ENTRIES);
  check("(cleanup) vocab restored to the seeded entries", s, 200);
  for (const tid of [rn_task.id, comma_task.id, ...Object.values(rank_ids)]) {
    if (tid) await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
  }

  // ── cleanup ──
  for (const tid of [task_id, empty_task_id, bob_task.id, projless.id]) {
    if (tid) {
      [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
      check(`cleanup: task ${tid.slice(0, 8)} removed`, s, 204);
    }
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
  console.log("✅ all priority-vocab proofs passed");
  process.exit(0);
}

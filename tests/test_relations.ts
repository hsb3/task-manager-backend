#!/usr/bin/env bun
/**
 * E2E proof of the task item-relation invariants (validateTaskItemRelations,
 * pb_hooks/main.pb.js): parent / milestone / blocked_by must share the task's scope, and
 * card 1dy0 — a subtask created without a project INHERITS its parent's project (Linear's
 * sub-issue behaviour) instead of being refused, while a cross-project or cross-workspace
 * parent is still refused 400.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8125 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  py_get,
  py_repr,
  py_rstrip,
  py_str,
  py_strip,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8125 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(66)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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

function msg(body: any): string {
  // PB capitalizes and period-terminates a hook message on the wire — compare folded.
  return py_rstrip(py_strip(py_str(py_get(body, "message", ""))), ".").toLowerCase();
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

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [r.token, r.record.id];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!tok) throw new Error(`superuser auth failed: ${py_repr(r)}`);
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc !== null) await roomkit.stop(proc);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-relations-test-"));
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

  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const BOB_WS = await find_id("workspaces", "name", "Bob's Workspace", bob);
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob);
  check("fixture: Alice's workspace resolved", truthy(ALICE_WS), true);
  check("fixture: Bob's OWN workspace resolved (a different tenant)", ALICE_WS !== BOB_WS, true);
  check("fixture: Alice's project resolved", truthy(ALICE_PROJECT), true);
  check("fixture: Bob's project resolved", truthy(BOB_PROJECT), true);

  let s: number, r: any;
  // A second project in ALICE's OWN workspace: the cross-project (not cross-workspace)
  // refusal has to be provable without changing tenant.
  let other: any;
  [s, other] = await api("POST", "/api/collections/projects/records", alice, {
    workspace: ALICE_WS,
    name: "Second Project",
    owner: alice_id,
  });
  check("fixture: Alice creates a second project in her workspace", s, 200);
  const ALICE_PROJECT_2 = other.id ?? null;
  check("fixture: the second project resolved", truthy(ALICE_PROJECT_2), true);

  const rows = await find_by_filter("projects", `workspace='${ALICE_WS}' && shadow=true`, su);
  const ALICE_SHADOW = rows.length ? rows[0].id : null;
  check("fixture: Alice's shadow project resolved (superuser read)", truthy(ALICE_SHADOW), true);
  check(
    "fixture: Alice's project is NOT the shadow container",
    ALICE_PROJECT !== ALICE_SHADOW,
    true,
  );

  const cleanup_task_ids: string[] = [];

  async function mktask(token: string | null, body: any): Promise<[number, any]> {
    const [s, r] = await api("POST", "/api/collections/tasks/records", token, body);
    if (s === 200 && truthy(r.id)) cleanup_task_ids.push(r.id);
    return [s, r];
  }

  // COVERS: hook:main.pb.js#onRecordCreateRequest:tasks
  // ═════════ 1. card 1dy0 — a project-less subtask inherits its parent's project ═════════
  console.log(
    "\n── (1) OWNER: subtask with a parent and NO project inherits the parent's project ──",
  );
  let parent: any, child: any;
  [s, parent] = await mktask(alice, {
    title: "Relations parent A",
    workspace: ALICE_WS,
    project: ALICE_PROJECT,
  });
  check("(fixture) Alice creates a parent in project A", s, 200);
  const parent_id = parent.id ?? null;

  [s, child] = await mktask(alice, {
    title: "Relations child inherits",
    workspace: ALICE_WS,
    parent: parent_id,
  });
  check("Alice: create subtask naming parent, NO project → 200", s, 200);
  // The pair, not the id alone: the container id would satisfy an equality check written
  // against a None project, which is exactly the RED state this proves out of.
  check(
    "the subtask landed in the PARENT's project, not the workspace container",
    tup(child.project ?? null, (child.project ?? null) === ALICE_SHADOW),
    tup(ALICE_PROJECT, false),
  );

  console.log("\n── (1b) ACTIVE MEMBER (Bob) gets the same inheritance ──");
  const bob_tier = await tierkit.actor_at_tier(ALICE_WS!, bob_id, "member", alice, "Bob");
  let child2: any;
  [s, child2] = await mktask(bob, {
    title: "Relations child by member",
    workspace: ALICE_WS,
    parent: parent_id,
  });
  check(
    "Bob (active member): subtask with no project → 200",
    tup(await bob_tier.now(), s),
    tup("member", 200),
  );
  check("Bob's subtask landed in the parent's project", child2.project ?? null, ALICE_PROJECT);

  console.log("\n── (1c) NON-MEMBER (Carol) and ANON are still refused ──");
  [s] = await api("POST", "/api/collections/tasks/records", carol, {
    title: "Carol child",
    workspace: ALICE_WS,
    parent: parent_id,
  });
  check("Carol (non-member): subtask under Alice's parent → 400", s, 400);
  [s] = await api("POST", "/api/collections/tasks/records", null, {
    title: "Anon child",
    workspace: ALICE_WS,
    parent: parent_id,
  });
  check("Anon: subtask under Alice's parent → 400", s, 400);

  console.log("\n── (1d) an EXPLICIT project that is not the parent's is still refused ──");
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Relations child wrong project",
    workspace: ALICE_WS,
    project: ALICE_PROJECT_2,
    parent: parent_id,
  });
  check("Alice: subtask naming a DIFFERENT project than its parent → 400", s, 400);
  check("…and the message names the parent", msg(r), "parent must be in the same project");
  check("…and the 400 binds to the parent field", Object.keys(r.data || {}).sort(by_code_point), [
    "parent",
  ]);

  console.log("\n── (1e) a parent in ANOTHER workspace is still refused ──");
  let bob_parent: any;
  [s, bob_parent] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "Relations parent in Bob ws",
    workspace: BOB_WS,
    project: BOB_PROJECT,
  });
  check("(fixture) Bob creates a parent in his OWN workspace", s, 200);
  const bob_parent_id = bob_parent.id ?? null;
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Relations cross-ws child",
    workspace: ALICE_WS,
    parent: bob_parent_id,
  });
  check("Alice: subtask under a parent in ANOTHER workspace, no project → 400", s, 400);
  check("…and the message names the parent", msg(r), "parent must be in the same project");

  // COVERS: hook:shadow.pb.js#onRecordCreate:tasks
  console.log(
    "\n── (1f) a project-less parent still puts a project-less child in the container ──",
  );
  let bare_parent: any, bare_child: any;
  [s, bare_parent] = await mktask(alice, { title: "Relations bare parent", workspace: ALICE_WS });
  check("(fixture) Alice creates a parent with NO project", s, 200);
  check("the bare parent landed in the shadow project", bare_parent.project ?? null, ALICE_SHADOW);
  [s, bare_child] = await mktask(alice, {
    title: "Relations bare child",
    workspace: ALICE_WS,
    parent: bare_parent.id ?? null,
  });
  check("Alice: subtask under a project-less parent → 200", s, 200);
  check(
    "…and it lands in the same shadow project, not refused",
    bare_child.project ?? null,
    ALICE_SHADOW,
  );

  console.log("\n── (1g) the shadow project may still not be NAMED as a subtask's project ──");
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Relations names the container",
    workspace: ALICE_WS,
    project: ALICE_SHADOW,
    parent: bare_parent.id ?? null,
  });
  check("Alice: subtask naming the shadow project explicitly → 400", s, 400);
  check(
    "…and the message is the container refusal, not the parent one",
    msg(r),
    "that project cannot be chosen here; pick one from the project list",
  );

  // COVERS: hook:main.pb.js#onRecordUpdateRequest:tasks
  // ═════════ 2. the rest of the guard is unchanged ═════════════════════════════
  console.log("\n── (2) UPDATE: re-parenting across projects is still refused ──");
  let moving: any;
  [s, moving] = await mktask(alice, {
    title: "Relations movable",
    workspace: ALICE_WS,
    project: ALICE_PROJECT_2,
  });
  check("(fixture) Alice creates a task in her SECOND project", s, 200);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${moving.id ?? null}`, alice, {
    parent: parent_id,
  });
  check("PATCH parent to a task in another project → 400", s, 400);
  check("…and the message names the parent", msg(r), "parent must be in the same project");
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${moving.id ?? null}`, alice, {
    parent: moving.id ?? null,
  });
  check("PATCH a task to be its OWN parent → 400", s, 400);
  check("…and the message says so", msg(r), "a task cannot be its own parent");

  console.log("\n── (2b) milestone and blocked_by keep the same-project rule ──");
  let ms: any;
  [s, ms] = await api("POST", "/api/collections/milestones/records", alice, {
    name: "Relations milestone",
    workspace: ALICE_WS,
    project: ALICE_PROJECT_2,
  });
  check("(fixture) Alice creates a milestone in her second project", s, 200);
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "Relations cross milestone",
    workspace: ALICE_WS,
    project: ALICE_PROJECT,
    milestone: ms.id ?? null,
  });
  check("task in project A naming a milestone in project B → 400", s, 400);
  check("…and the message names the milestone", msg(r), "milestone must be in the same project");
  check(
    "…and the 400 binds to the milestone field",
    Object.keys(r.data || {}).sort(by_code_point),
    ["milestone"],
  );
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${parent_id}`, alice, {
    dependencies: [moving.id ?? null],
  });
  check("PATCH blocked_by to a task in another project → 400", s, 400);
  check("…and the message names blocked_by", msg(r), "blocked_by must be in the same project");
  check(
    "…and the 400 binds to the dependencies field",
    Object.keys(r.data || {}).sort(by_code_point),
    ["dependencies"],
  );

  console.log("\n── (2c) an inherited subtask is a normal task afterwards ──");
  [s, r] = await api("GET", `/api/collections/tasks/records/${child.id ?? null}`, alice);
  check("read the inherited subtask back → 200", s, 200);
  check("its project persisted as the parent's", r.project ?? null, ALICE_PROJECT);
  check("its parent persisted", r.parent ?? null, parent_id);
  // Born inside a real project, so it wears that project's display label — the container
  // takes no prefix, so a subtask that landed there still carries none.
  const [, parent_row] = await api("GET", `/api/collections/tasks/records/${parent_id}`, alice);
  check(
    "it wears a display key with the parent project's prefix",
    py_str(py_get(r, "key", "")).split("-")[0] ===
      py_str(py_get(parent_row, "key", "")).split("-")[0] && truthy(r.key),
    true,
  );
  const [, bare_row] = await api(
    "GET",
    `/api/collections/tasks/records/${bare_child.id ?? null}`,
    alice,
  );
  check("a subtask that landed in the container still wears none", bare_row.key ?? null, "");

  // ══════════════════ cleanup ══════════════════════════════════════════════════
  console.log("\n── cleanup ──");
  [s] = await api("DELETE", `/api/collections/milestones/records/${ms.id ?? null}`, alice);
  check("cleanup: milestone removed", s, 204);
  [s] = await api("DELETE", `/api/collections/tasks/records/${bob_parent_id}`, bob);
  check("cleanup: Bob's parent removed", s, 204);
  for (const tid of [...cleanup_task_ids].reverse()) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
    check(`cleanup: task ${tid.slice(0, 8)} removed`, s, 204);
  }
  [s] = await api("DELETE", `/api/collections/projects/records/${ALICE_PROJECT_2}`, alice);
  check("cleanup: second project removed", s, 204);

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
  console.log("✅ all task item-relation proofs passed");
  process.exit(0);
}

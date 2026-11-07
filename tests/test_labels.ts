#!/usr/bin/env bun
/**
 * E2E proof of the G1 (#74) first-class `labels` collection: role-tiered CRUD,
 * workspace/project scope-uniqueness, rename visibility through the relation, the
 * core-label delete guard (blocks even superusers), native task-side cleanup on a
 * custom label's delete, the impact-count query pattern, and the dual-scope
 * (project-not-in-workspace) guard.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy (label/status hooks under
 * test live there), scripts/seed.ts fixtures. Port 8100 + PB_PORT_OFFSET (suite self-boot
 * band per .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup, urlencode, truthy, by_code_point } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8100 + PORT_OFFSET;
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

tierkit.use(api);

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
  if (!tok) throw new Error(`superuser auth failed: ${JSON.stringify(r)}`);
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-labels-test-"));
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
  const [carol, carol_id] = await login("carol@example.com");

  const ALICE_WS = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob);
  const BUG_LABEL = await find_id("labels", "name", "Bug", alice); // scoped further below by ws

  // ══════════════════ 1. CRUD × role matrix ══════════════════════════════════
  // COVERS: rule:labels.create, rule:labels.update, rule:labels.delete, rule:labels.list, rule:labels.view
  console.log("\n── (1) OWNER (Alice): create/update/delete ──");
  let s: number, r: any, made: any;
  [s, made] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "Owner Label",
    color: "blue",
  });
  check("Alice (owner) creates a label", s, 200);
  const owner_label_id = made.id;
  [s, r] = await api("PATCH", `/api/collections/labels/records/${owner_label_id}`, alice, {
    name: "Owner Label Renamed",
  });
  check("Alice (owner) renames it", s, 200);
  check("rename took effect", r.name, "Owner Label Renamed");
  [s] = await api("DELETE", `/api/collections/labels/records/${owner_label_id}`, alice);
  check("Alice (owner) deletes it", s, 204);

  console.log("\n── (1) ADMIN (Bob promoted to admin): create/update/delete ──");
  let bob_tier = await tierkit.actor_at_tier(ALICE_WS, bob_id, "admin", alice, "Bob");
  [s, made] = await api("POST", "/api/collections/labels/records", bob, {
    workspace: ALICE_WS,
    name: "Admin Label",
    color: "green",
  });
  check("Bob (admin) creates a label", s, 200);
  const admin_label_id = made.id;
  [s, r] = await api("PATCH", `/api/collections/labels/records/${admin_label_id}`, bob, {
    name: "Admin Label Renamed",
  });
  check("Bob (admin) renames it", s, 200);
  [s] = await api("DELETE", `/api/collections/labels/records/${admin_label_id}`, bob);
  check("Bob (admin) deletes it", s, 204);
  bob_tier = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");

  console.log("\n── (1) MEMBER (Bob, plain member): write denied, read allowed ──");
  let target: any;
  [s, target] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "Member Target Label",
  });
  check("(fixture) Alice creates a target label for Bob to probe", s, 200);
  const member_target_id = target.id;
  [s] = await api("POST", "/api/collections/labels/records", bob, {
    workspace: ALICE_WS,
    name: "Member Attempt Label",
  });
  check("Bob (member) create → denied", tup(await bob_tier.now(), s), tup("member", 400));
  [s] = await api("PATCH", `/api/collections/labels/records/${member_target_id}`, bob, {
    name: "hijacked",
  });
  check("Bob (member) update → denied", tup(await bob_tier.now(), s), tup("member", 404));
  [s] = await api("DELETE", `/api/collections/labels/records/${member_target_id}`, bob);
  check("Bob (member) delete → denied", tup(await bob_tier.now(), s), tup("member", 404));
  [s, r] = await api(
    "GET",
    `/api/collections/labels/records?filter=(workspace='${ALICE_WS}')`,
    bob,
  );
  check("Bob (member) list → 200", tup(await bob_tier.now(), s), tup("member", 200));
  check(
    "Bob (member) list is non-empty",
    tup(await bob_tier.now(), (r.items ?? []).length > 0),
    tup("member", true),
  );
  [s] = await api("GET", `/api/collections/labels/records/${member_target_id}`, bob);
  check("Bob (member) view → 200", tup(await bob_tier.now(), s), tup("member", 200));

  console.log("\n── (1) NON-MEMBER (Carol) ──");
  [s, r] = await api(
    "GET",
    `/api/collections/labels/records?filter=(workspace='${ALICE_WS}')`,
    carol,
  );
  check("Carol (non-member) list Alice-ws labels → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/labels/records/${member_target_id}`, carol);
  check("Carol (non-member) view → 404", s, 404);

  console.log("\n── (1) ANON ──");
  [s, r] = await api(
    "GET",
    `/api/collections/labels/records?filter=(workspace='${ALICE_WS}')`,
    null,
  );
  check("Anon list Alice-ws labels → 200 empty", tup(s, r.items), tup(200, []));
  [s] = await api("GET", `/api/collections/labels/records/${member_target_id}`, null);
  check("Anon view → 404", s, 404);
  [s] = await api("POST", "/api/collections/labels/records", null, {
    workspace: ALICE_WS,
    name: "Anon Label",
  });
  check("Anon create → 400", s, 400);
  [s] = await api("PATCH", `/api/collections/labels/records/${member_target_id}`, null, {
    name: "x",
  });
  check("Anon update → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/labels/records/${member_target_id}`, null);
  check("Anon delete → 404", s, 404);

  // cleanup the member-target fixture (owner deletes it)
  [s] = await api("DELETE", `/api/collections/labels/records/${member_target_id}`, alice);
  check("cleanup: member-target label removed", s, 204);

  // ══════════════════ 1b. name is trimmed before the UNIQUE index sees it ═════
  // COVERS: hook:main.pb.js#onRecordCreate:labels, hook:main.pb.js#onRecordUpdate:labels
  console.log(
    "\n── (1b) card 3k7z: a padded name is trimmed before storage and the unique check ──",
  );
  let base: any, dup: any, fresh: any;
  [s, base] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "TrimLabel",
  });
  check("(fixture) 'TrimLabel' created", s, 200);
  const trim_label_id = base.id;
  [s, dup] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "TrimLabel ",
  });
  check("create with a trailing-space duplicate name → 400", s, 400);
  // A stray record here (guard absent) would raw-collide with the rename check below
  // for the wrong reason — clean it up so that check only proves the trim itself.
  if (dup.id) {
    await api("DELETE", `/api/collections/labels/records/${dup.id}`, alice);
  }
  [s, fresh] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "  TrimLabelFresh  ",
  });
  check("create with a padded fresh name → 200", s, 200);
  check("stored name has surrounding spaces removed", fresh.name, "TrimLabelFresh");
  const fresh_label_id = fresh.id;
  [s] = await api("PATCH", `/api/collections/labels/records/${fresh_label_id}`, alice, {
    name: "TrimLabel ",
  });
  check("rename to a trailing-space duplicate name → 400", s, 400);
  for (const lid of [trim_label_id, fresh_label_id]) {
    if (lid) {
      [s] = await api("DELETE", `/api/collections/labels/records/${lid}`, alice);
      check(`cleanup: trim-test label ${lid.slice(0, 8)} removed`, s, 204);
    }
  }

  // ══════════════════ 2. Scope uniqueness ═════════════════════════════════════
  console.log("\n── (2) workspace-level uniqueness: (workspace,name) where project='' ──");
  let dup1: any, proj_dup1: any;
  [s, dup1] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "DupTest",
  });
  check("Alice creates workspace-level 'DupTest'", s, 200);
  [s] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "DupTest",
  });
  check("2nd workspace-level 'DupTest' → 400 (validation_not_unique)", s, 400);

  console.log("\n── (2) same name allowed at PROJECT scope ──");
  [s, proj_dup1] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    project: ALICE_PROJECT,
    name: "DupTest",
  });
  check("project-scoped 'DupTest' (same name, different scope) → 200", s, 200);

  console.log("\n── (2) duplicate WITHIN the same project ──");
  [s] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    project: ALICE_PROJECT,
    name: "DupTest",
  });
  check("2nd project-scoped 'DupTest' in the SAME project → 400", s, 400);

  for (const lid of [dup1.id, proj_dup1.id]) {
    if (lid) {
      [s] = await api("DELETE", `/api/collections/labels/records/${lid}`, alice);
      check(`cleanup: scope-uniqueness fixture ${lid.slice(0, 8)} removed`, s, 204);
    }
  }

  // ══════════════════ 3. Rename visible via relation expand ═══════════════════
  console.log("\n── (3) rename is visible through the relation, not a copy ──");
  let rn: any, task: any;
  [s, rn] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "RenameMe",
  });
  check("(fixture) Alice creates 'RenameMe'", s, 200);
  const rn_id = rn.id;
  [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G1-label-expand-fixture",
    project: ALICE_PROJECT,
    labels: [rn_id],
  });
  check("(fixture) Alice creates a task referencing it", s, 200);
  const task_id = task.id;
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_id}?expand=labels`, alice);
  const expanded_names = ((r.expand ?? {}).labels ?? []).map((lbl: any) => lbl.name);
  check("expand shows original name 'RenameMe'", expanded_names, ["RenameMe"]);
  [s] = await api("PATCH", `/api/collections/labels/records/${rn_id}`, alice, {
    name: "RenameMe-v2",
  });
  check("Alice renames the label", s, 200);
  [s, r] = await api("GET", `/api/collections/tasks/records/${task_id}?expand=labels`, alice);
  const expanded_names2 = ((r.expand ?? {}).labels ?? []).map((lbl: any) => lbl.name);
  check("expand now shows renamed 'RenameMe-v2' (relation, not a copy)", expanded_names2, [
    "RenameMe-v2",
  ]);

  [s] = await api("DELETE", `/api/collections/tasks/records/${task_id}`, alice);
  check("cleanup: expand-fixture task removed", s, 204);
  [s] = await api("DELETE", `/api/collections/labels/records/${rn_id}`, alice);
  check("cleanup: expand-fixture label removed", s, 204);

  // ══════════════════ 4. Core seeded + core-delete blocked ═══════════════════
  // COVERS: hook:main.pb.js#onRecordDeleteRequest:labels
  console.log("\n── (4) core labels seeded (3) + core-delete blocked (owner AND superuser) ──");
  const core_rows = await find_by_filter("labels", `(workspace='${ALICE_WS}' && core=true)`, alice);
  check("exactly 3 core labels in Alice's workspace", core_rows.length, 3);
  check("core label names", core_rows.map((row) => row.name).sort(by_code_point), [
    "Bug",
    "Feature",
    "Improvement",
  ]);
  const bug_id = core_rows.find((row) => row.name === "Bug")?.id ?? null;
  check("resolved core label 'Bug'", truthy(bug_id), true);

  [s] = await api("DELETE", `/api/collections/labels/records/${bug_id}`, alice);
  check("owner DELETE core label 'Bug' → 400 (blocked)", s, 400);
  [s] = await api("DELETE", `/api/collections/labels/records/${bug_id}`, su);
  check("SUPERUSER DELETE core label 'Bug' → 400 (blocked)", s, 400);
  [s, r] = await api("GET", `/api/collections/labels/records/${bug_id}`, alice);
  check("'Bug' survives both delete attempts", tup(s, r.name), tup(200, "Bug"));

  // ══════════════════ 5/6. Custom-delete native cleanup + impact-count ═══════
  console.log("\n── (5/6) custom label: k tasks attached, 1 control, impact-count, delete ──");
  let sprint: any, control: any;
  [s, sprint] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "Sprint42",
    color: "teal",
  });
  check("(fixture) Alice creates custom label 'Sprint42'", s, 200);
  const sprint_id = sprint.id;

  const tagged_ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    // k = 2
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", alice, {
      title: `G1-sprint42-tagged-${i}`,
      project: ALICE_PROJECT,
      labels: [sprint_id],
    });
    check(`(fixture) tagged task ${i} created`, s, 200);
    tagged_ids.push(t.id);
  }
  [s, control] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G1-sprint42-control",
    project: ALICE_PROJECT,
  });
  check("(fixture) control task (no label) created", s, 200);
  const control_id = control.id;

  [s, r] = await api(
    "GET",
    `/api/collections/tasks/records?filter=(labels.id?='${sprint_id}')`,
    alice,
  );
  check("impact-count BEFORE delete: totalItems == k(2)", r.totalItems, 2);

  [s] = await api("DELETE", `/api/collections/labels/records/${sprint_id}`, alice);
  check("owner DELETE custom label 'Sprint42' → 204", s, 204);

  for (const tid of tagged_ids) {
    [s, r] = await api("GET", `/api/collections/tasks/records/${tid}`, alice);
    check(
      `tagged task ${tid.slice(0, 8)} no longer lists the deleted label id`,
      (r.labels ?? []).includes(sprint_id),
      false,
    );
  }
  [s, r] = await api("GET", `/api/collections/tasks/records/${control_id}`, alice);
  check("control task's labels untouched (empty)", r.labels ?? [], []);

  for (const tid of [...tagged_ids, control_id]) {
    [s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, alice);
    check(`cleanup: task ${tid.slice(0, 8)} removed`, s, 204);
  }

  // ══════════════════ 7. Dual-scope mismatch ══════════════════════════════════
  // COVERS: hook:scope.pb.js#onRecordCreate:labels
  console.log("\n── (7) label.project must belong to label.workspace ──");
  [s] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    project: BOB_PROJECT,
    name: "Mismatched",
  });
  check("label with project from a DIFFERENT workspace → 400", s, 400);

  // ══════════════════ 8. Dual-scope mismatch on UPDATE ════════════════════════
  // COVERS: hook:scope.pb.js#onRecordUpdate:labels
  console.log("\n── (8) PATCH label.project to a cross-workspace project → 400 ──");
  let patch_target: any;
  [s, patch_target] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: ALICE_WS,
    name: "PatchScopeTarget",
  });
  check("(fixture) Alice creates 'PatchScopeTarget'", s, 200);
  const patch_target_id = patch_target.id;
  [s] = await api("PATCH", `/api/collections/labels/records/${patch_target_id}`, alice, {
    project: BOB_PROJECT,
  });
  check("PATCH label.project to a DIFFERENT workspace's project → 400", s, 400);
  [s] = await api("DELETE", `/api/collections/labels/records/${patch_target_id}`, alice);
  check("cleanup: cross-workspace-PATCH fixture label removed", s, 204);

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
  console.log("✅ all label proofs passed");
  process.exit(0);
}

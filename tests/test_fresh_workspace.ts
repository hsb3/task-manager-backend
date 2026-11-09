#!/usr/bin/env bun
/**
 * E2E proof of decision:default-priority-vocabulary: a workspace nobody configured is immediately usable — a fresh
 * signup's auto-provisioned workspace, and a second workspace created straight through the API,
 * both come back with the default priority vocabulary (plus the statuses/labels seeded since G1),
 * and a task can carry a priority with zero manual setup.
 *
 * No fixtures beyond the signup itself: scripts/seed.ts PATCHes its own vocabularies, which would
 * hide the defaults this suite is about.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy (PB_HOOKS_DIR points it
 * at a stripped tree instead, for the revert-probe). Port 8138 + PB_PORT_OFFSET — the 8100+
 * suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  json_dumps,
  py_repr,
  run_checked,
  truthy,
  urlencode,
  by_code_point,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8138 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

const DEFAULT_PRIORITIES = ["urgent", "high", "medium", "low"];

const is_dict = (p: any): boolean => p !== null && typeof p === "object" && !Array.isArray(p);

function names_of(priorities: any): any[] {
  return (truthy(priorities) ? priorities : []).map((p: any) =>
    is_dict(p) ? (p.name ?? null) : p,
  );
}

function ids_by_name(priorities: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of truthy(priorities) ? priorities : []) {
    if (is_dict(p)) out[p.name ?? "None"] = p.id ?? null;
  }
  return out;
}

const USER_EMAIL = "fresh@example.com";
const USER_PASSWORD = "fresh123456";

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

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-fresh-workspace-test-"));
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

  let s: number, r: any;

  // ══════════════════ 1. signup → the provisioned workspace ═══════════════════
  console.log("\n── (1) public signup, then superuser approval (the only way in) ──");
  let signup: any;
  [s, signup] = await api("POST", "/api/collections/users/records", null, {
    email: USER_EMAIL,
    name: "Fresh User",
  });
  check("anonymous signup → 200", s, 200);
  const user_id = signup.id ?? null;
  // A signup carries no password (decision:password-signup-verify-first); the superuser sets one with the approval.
  [s] = await api("PATCH", `/api/collections/users/records/${user_id}`, su, {
    verified: true,
    approved: true,
    password: USER_PASSWORD,
    passwordConfirm: USER_PASSWORD,
  });
  check("superuser approves the account → 200", s, 200);
  let auth: any;
  [s, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: USER_EMAIL,
    password: USER_PASSWORD,
  });
  check("approved user authenticates → 200", s, 200);
  const token = auth.token ?? null;

  const workspaces = await find_by_filter("workspaces", `owner='${user_id}'`, token);
  check("exactly one auto-provisioned workspace", workspaces.length, 1);
  const ws = workspaces.length ? workspaces[0] : {};
  const ws_id = ws.id ?? null;

  // ══════════════════ 2. the seeded vocabularies ══════════════════════════════
  console.log(
    "\n── (2) decision:default-priority-vocabulary: the fresh workspace's vocabularies are seeded ──",
  );
  check("priorities default", names_of(ws.priorities), DEFAULT_PRIORITIES);
  const statuses = await find_by_filter("statuses", `workspace='${ws_id}'`, token);
  check("statuses seeded", statuses.length, 5);
  check("one status is the default", statuses.filter((st: any) => truthy(st.is_default)).length, 1);
  const labels = await find_by_filter("labels", `workspace='${ws_id}'`, token);
  check("core labels seeded", labels.map((lbl: any) => lbl.name ?? null).sort(by_code_point), [
    "Bug",
    "Feature",
    "Improvement",
  ]);

  // ══════════════════ 3. the workspace is usable with zero setup ══════════════
  console.log("\n── (3) a task can carry a priority with no manual configuration ──");
  let project: any;
  [s, project] = await api("POST", "/api/collections/projects/records", token, {
    name: "FW Project",
    owner: user_id,
    workspace: ws_id,
  });
  check("owner creates a project → 200", s, 200);
  const project_id = project.id ?? null;

  let task: any;
  [s, task] = await api("POST", "/api/collections/tasks/records", token, {
    title: "FW-prioritized",
    project: project_id,
    priority: ids_by_name(ws.priorities).high ?? null,
  });
  check("task with priority='high' → 200", s, 200);
  check(
    "stored priority is the id of 'high'",
    task.priority ?? null,
    ids_by_name(ws.priorities).high ?? null,
  );

  let err: any;
  [s, err] = await api("POST", "/api/collections/tasks/records", token, {
    title: "FW-bogus",
    project: project_id,
    priority: "bogus",
  });
  check("task with priority='bogus' → 400 (TASK-123 vocab guard)", s, 400);
  check("400 names the priority field", json_dumps(err).toLowerCase().includes("priority"), true);

  let plain: any;
  [s, plain] = await api("POST", "/api/collections/tasks/records", token, {
    title: "FW-unset",
    project: project_id,
  });
  check("task with NO priority → 200 (unset stays the no-priority state)", s, 200);
  check("unset priority stored as ''", plain.priority ?? null, "");

  // ══════════════════ 4. direct-API second workspace ══════════════════════════
  console.log("\n── (4) second workspace created straight through the API (no priorities key) ──");
  let ws2: any;
  [s, ws2] = await api("POST", "/api/collections/workspaces/records", token, {
    name: "FW Second",
    owner: user_id,
  });
  check("owner creates a second workspace → 200", s, 200);
  const ws2_id = ws2.id ?? null;
  let ws2_read: any;
  [s, ws2_read] = await api("GET", `/api/collections/workspaces/records/${ws2_id}`, token);
  check("re-read second workspace → 200", s, 200);
  check(
    "seeder filled priorities on the direct API create",
    names_of(ws2_read.priorities),
    DEFAULT_PRIORITIES,
  );
  check(
    "second workspace's statuses seeded too",
    (await find_by_filter("statuses", `workspace='${ws2_id}'`, token)).length,
    5,
  );

  let ws2_task: any;
  [s, ws2_task] = await api("POST", "/api/collections/tasks/records", token, {
    title: "FW-second-prioritized",
    workspace: ws2_id,
    priority: ids_by_name(ws2_read.priorities).urgent ?? null,
  });
  check("project-less task in the second workspace, priority='urgent' → 200", s, 200);
  check(
    "stored priority is the id of 'urgent'",
    ws2_task.priority ?? null,
    ids_by_name(ws2_read.priorities).urgent ?? null,
  );

  // ══════════════════ 5. the default is a starting point, not a lock ══════════
  console.log("\n── (5) the vocabulary stays per-workspace data the owner can edit ──");
  let edited: any;
  [s, edited] = await api("PATCH", `/api/collections/workspaces/records/${ws_id}`, token, {
    priorities: [{ name: "p0" }, { name: "p1" }],
  });
  check("owner narrows the vocabulary → 200", s, 200);
  check("stored vocabulary is the owner's", names_of(edited.priorities), ["p0", "p1"]);
  [s] = await api("POST", "/api/collections/tasks/records", token, {
    title: "FW-after-edit",
    project: project_id,
    priority: ids_by_name(edited.priorities).p0 ?? null,
  });
  check("task with the owner's own value → 200", s, 200);
  [s] = await api("POST", "/api/collections/tasks/records", token, {
    title: "FW-after-edit-default",
    project: project_id,
    priority: ids_by_name(ws.priorities).high ?? null,
  });
  check("task with a now-removed default value → 400", s, 400);

  // ══════════════════ 6. the trash reprovision path seeds too ════════════════
  console.log("\n── (6) trashing the last workspace reprovisions one, seeded the same way ──");
  [s] = await api("DELETE", `/api/collections/workspaces/records/${ws2_id}`, token);
  check("owner trashes the second workspace → 204", s, 204);
  [s] = await api("DELETE", `/api/collections/workspaces/records/${ws_id}`, token);
  check("owner trashes the last live workspace → 204", s, 204);
  const live = (await find_by_filter("workspaces", `owner='${user_id}'`, token)).filter(
    (w: any) => !((w.id ?? null) === ws_id || (w.id ?? null) === ws2_id),
  );
  check("a replacement workspace was provisioned", live.length, 1);
  check(
    "replacement carries the default priorities",
    live.length ? names_of(live[0].priorities) : null,
    DEFAULT_PRIORITIES,
  );
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all fresh-workspace proofs passed");
  process.exit(0);
}

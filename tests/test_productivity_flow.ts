#!/usr/bin/env bun
/**
 * E2E integration proof (G3 #74): a template-created task gets a server-assigned
 * display key, is discoverable via `/api/tracker/search`, and matches a saved view's stored
 * filter when that filter is applied to a real list query.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8135 + PB_PORT_OFFSET (suite self-boot band, 8100+).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_get, py_repr, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8135 + PORT_OFFSET;
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
  if (!tok) throw new Error(`superuser auth failed: ${py_repr(r)}`);
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

/** A json-field value comes back from the HTTP API as a native JSON type
 * already; tolerate a double-encoded string just in case. */
function as_obj(raw: any): any {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-productivity-flow-test-"));
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

  // auth ONCE — the auth endpoint rate-limits (429) on repeated logins
  const [alice, alice_id] = await login("alice@example.com");

  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const PRIO: Record<string, any> = {};
  for (const p of getitem(
    (await api("GET", `/api/collections/workspaces/records/${ALICE_WS}`, alice))[1],
    "priorities",
  )) {
    PRIO[getitem(p, "name")] = getitem(p, "id");
  }
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("resolved Alice's workspace", truthy(ALICE_WS), true);
  check("resolved Alice's project 'Website Redesign'", truthy(ALICE_PROJECT), true);

  let s: number, r: any;

  // COVERS: rule:templates.create
  // ══════════════════ 1. create a task template ═════════════════════════════
  console.log("\n── (1) alice creates a task template ──");
  let tmpl: any;
  [s, tmpl] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Flow Template",
    templateData: { title: "FlowTask-uniqtok", priority: getitem(PRIO, "high") },
  });
  check("alice creates template 'Flow Template' → 200", s, 200);
  const tmpl_id = tmpl.id ?? null;

  // COVERS: rule:templates.view
  // ══════════════════ 2. read it back, spawn a task from it ═════════════════
  console.log("\n── (2) read template back, create a task from its templateData ──");
  let got_tmpl: any;
  [s, got_tmpl] = await api("GET", `/api/collections/templates/records/${tmpl_id}`, alice);
  check("GET template → 200", s, 200);
  const tdata = as_obj(got_tmpl.templateData ?? null);
  check("templateData.title round-trips", tdata.title ?? null, "FlowTask-uniqtok");
  check("templateData.priority round-trips", tdata.priority ?? null, getitem(PRIO, "high"));

  let task: any;
  [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
    title: getitem(tdata, "title"),
    priority: tdata.priority ?? null,
    project: ALICE_PROJECT,
  });
  check("POST task built from templateData → 200", s, 200);
  const task_id = task.id ?? null;

  // COVERS: hook:main.pb.js#onRecordCreateRequest:tasks
  // COVERS: hook:keys.pb.js#onRecordCreate:tasks
  // ══════════════════ 3. server-assigned display key ═════════════════════════
  console.log("\n── (3) task carries a server-assigned key: its project prefix plus a number ──");
  const key = task.key ?? null;
  check("key is a string", typeof key === "string", true);
  check(
    "key reads as <PREFIX>-<number> (PBTT-422)",
    /^[A-Z][A-Z0-9]*-[0-9]+$/.test(truthy(key) ? key : ""),
    true,
  );

  // COVERS: route:GET /api/tracker/search
  // ══════════════════ 4. discoverable via search ═════════════════════════════
  console.log("\n── (4) template-created task is discoverable via /api/tracker/search ──");
  const qs = urlencode({ q: "FlowTask-uniqtok" });
  [s, r] = await api("GET", `/api/tracker/search?${qs}`, alice);
  check("search 'FlowTask-uniqtok' → 200", s, 200);
  const hit = py_get(r, "results", []).find(
    (row: any) => getitem(row, "collection") === "tasks" && getitem(row, "id") === task_id,
  );
  check("search results contain the flow task (collection=tasks)", truthy(hit), true);

  // COVERS: rule:saved_views.create, rule:saved_views.view, rule:tasks.list
  // ══════════════════ 5. saved view's stored filter selects the task ════════
  console.log("\n── (5) saved_view stores a filter; applied to a live list query ──");
  let sv: any;
  [s, sv] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: ALICE_WS,
    owner: alice_id,
    name: "Flow View",
    scope: "workspace",
    filterData: { filter: "title~'FlowTask-uniqtok'" },
  });
  check("alice creates saved_view 'Flow View' (scope=workspace) → 200", s, 200);
  const sv_id = sv.id ?? null;

  let got_sv: any;
  [s, got_sv] = await api("GET", `/api/collections/saved_views/records/${sv_id}`, alice);
  check("GET saved_view back → 200", s, 200);
  const fdata = as_obj(got_sv.filterData ?? null);
  const stored_filter = fdata.filter ?? null;
  check("stored filter round-trips", stored_filter, "title~'FlowTask-uniqtok'");

  const fqs = urlencode({ filter: stored_filter });
  [s, r] = await api("GET", `/api/collections/tasks/records?${fqs}`, alice);
  check("apply the saved view's filter to a live list query → 200", s, 200);
  const list_ids = py_get(r, "items", []).map((i: any) => getitem(i, "id"));
  check("the flow task is selected by the saved view's filter", list_ids.includes(task_id), true);

  // ── cleanup ──────────────────────────────────────────────────────────────
  [s] = await api("DELETE", `/api/collections/saved_views/records/${sv_id}`, alice);
  check("cleanup: saved_view removed", s, 204);
  [s] = await api("DELETE", `/api/collections/tasks/records/${task_id}`, alice);
  check("cleanup: flow task trapped to trash", s, 204);
  [s] = await api("DELETE", `/api/collections/templates/records/${tmpl_id}`, alice);
  check("cleanup: template removed", s, 204);
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all productivity-flow proofs passed");
  process.exit(0);
}

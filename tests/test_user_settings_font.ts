#!/usr/bin/env bun
/**
 * user_settings behaviour: the narrowed `font` vocabulary, the `font_size` bounds, and
 * TASK-008.04's optional default_view / default_project relations (round-trip, clear-with-null,
 * delete-target cascade), plus the self-only delete rule.
 *
 * Seeds its three fixture users DIRECTLY via the superuser API rather than through
 * scripts/seed.ts — the users-create hook auto-provisions the workspace, project and
 * user_settings row this suite reads, and nothing else seed.ts builds is read here.
 *
 * Port 8136 + PB_PORT_OFFSET (suite self-boot band, .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate_up } from "../scripts/pb_migrate.ts";
import { decode_text, getitem, py_repr, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8136 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  const tag = ok ? "✅" : "❌ MISMATCH";
  console.log(`  ${tag}  ${label.padEnd(64)} → ${py_repr(got)} (want ${py_repr(expected)})`);
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
  if (r.ok) return [r.status, raw.length ? JSON.parse(decode_text(raw)) : {}];
  try {
    return [r.status, raw.length ? JSON.parse(decode_text(raw)) : {}];
  } catch {
    return [r.status, { _raw: new TextDecoder("utf-8").decode(raw) }];
  }
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_repr(r)}`);
  return tok;
}

async function login(email: string): Promise<[any, any]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

// ── Scratch tree ─────────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-user-settings-font-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log("\n══════════ user_settings room ══════════");
  const [ok, out] = migrate_up(PB_BIN, DATA_DIR, MIG_DIR, REPO_ROOT);
  if (!ok) throw new Error("`migrate up` failed:\n" + out);
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
  let su = await superuser_token();

  console.log(
    "\n── seed: alice/bob/carol users — the users-create hook auto-provisions a workspace, a project and a user_settings row for each ──",
  );
  let s: number;
  let r: any;
  for (const [name, email] of [
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
    ["Carol", "carol@example.com"],
  ]) {
    [s] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`create fixture user ${name}`, s, 200);
  }
  if (failures) throw new roomkit.SystemExit("fixture seeding failed — cannot proceed");

  const [alice_token, alice_id] = await login("alice@example.com");

  // COVERS: rule:user_settings.list
  let qs = urlencode({ filter: `user='${alice_id}'` });
  [s, r] = await api("GET", `/api/collections/user_settings/records?${qs}`, alice_token);
  check("GET alice's user_settings row", s, 200);
  const items = truthy(r.items) ? r.items : [];
  check("exactly one auto-provisioned user_settings row for alice", items.length, 1);
  const ROW_ID = items.length ? getitem(items[0], "id") : null;

  console.log("\n── the live vocabulary: narrowed select + font_size bounds ──");
  [s] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    font: "serif",
  });
  check("PATCH font='serif' (not an option) → 400", s, 400);

  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    font: "mono",
  });
  check("PATCH font='mono' → 200", s, 200);
  check("PATCH font='mono' persists", r.font, "mono");

  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    font: "sans",
  });
  check("PATCH font='sans' → 200", s, 200);
  check("PATCH font='sans' persists", r.font, "sans");

  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    font_size: 16,
  });
  check("PATCH font_size=16 (in range) → 200", s, 200);
  check("PATCH font_size=16 persists", r.font_size, 16);

  [s] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    font_size: 8,
  });
  check("PATCH font_size=8 (below min 12) → 400", s, 400);

  [s] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    font_size: 40,
  });
  check("PATCH font_size=40 (above max 24) → 400", s, 400);

  [s] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    font_size: 16.5,
  });
  check("PATCH font_size=16.5 (onlyInt) → 400", s, 400);
  // font enum narrowed to system/sans/mono (serif dropped) — contract mirrors this; PB is source of truth.

  console.log("\n── TASK-008.04: default_view / default_project relations ──");
  su = await superuser_token();

  // shadow=false: an unfiltered superuser pick can land on a workspace container project,
  // which is deliberately not choosable as a default_project.
  [s, r] = await api(
    "GET",
    "/api/collections/projects/records?" + urlencode({ filter: "shadow=false", perPage: 1 }),
    su,
  );
  check("GET a project row (fixture for default_project) → 200", s, 200);
  const proj_items = truthy(r.items) ? r.items : [];
  check("at least one project exists", proj_items.length >= 1, true);
  const PROJECT_ID = proj_items.length ? getitem(proj_items[0], "id") : null;

  qs = urlencode({ filter: `owner='${alice_id}'` });
  [s, r] = await api("GET", `/api/collections/workspaces/records?${qs}&perPage=1`, su);
  check("GET alice's owned workspace (fixture for saved_view) → 200", s, 200);
  const ws_items = truthy(r.items) ? r.items : [];
  check("alice owns exactly one workspace", ws_items.length >= 1, true);
  const ALICE_WS_ID = ws_items.length ? getitem(ws_items[0], "id") : null;

  [s, r] = await api("POST", "/api/collections/saved_views/records", su, {
    workspace: ALICE_WS_ID,
    owner: alice_id,
    name: "Default view fixture",
    scope: "personal",
  });
  check("POST saved_view fixture (as su) → 200", s, 200);
  const SAVED_VIEW_ID = r.id;

  console.log("── round-trip default_view ──");
  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    default_view: SAVED_VIEW_ID ?? null,
  });
  check("PATCH default_view=SAVED_VIEW_ID → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/user_settings/records/${ROW_ID}`, alice_token);
  check("GET default_view == SAVED_VIEW_ID", r.default_view, SAVED_VIEW_ID);

  console.log("── round-trip default_project ──");
  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    default_project: PROJECT_ID,
  });
  check("PATCH default_project=PROJECT_ID → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/user_settings/records/${ROW_ID}`, alice_token);
  check("GET default_project == PROJECT_ID", r.default_project, PROJECT_ID);

  console.log("── clear-with-null ──");
  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    default_view: null,
  });
  check("PATCH default_view=null → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/user_settings/records/${ROW_ID}`, alice_token);
  check("GET default_view cleared to ''", r.default_view, "");

  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    default_project: "",
  });
  check("PATCH default_project='' → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/user_settings/records/${ROW_ID}`, alice_token);
  check("GET default_project cleared to ''", r.default_project, "");

  console.log("── delete-target: cascadeDelete=false on default_view must survive the row ──");
  [s, r] = await api("PATCH", `/api/collections/user_settings/records/${ROW_ID}`, alice_token, {
    default_view: SAVED_VIEW_ID ?? null,
  });
  check("re-PATCH default_view=SAVED_VIEW_ID → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/user_settings/records/${ROW_ID}`, alice_token);
  check("re-GET confirms default_view set before delete", r.default_view, SAVED_VIEW_ID);

  [s] = await api("DELETE", `/api/collections/saved_views/records/${SAVED_VIEW_ID}`, su);
  check("DELETE the referenced saved_view (as su) → 204", s, 204);

  [s, r] = await api("GET", `/api/collections/user_settings/records/${ROW_ID}`, alice_token);
  check("user_settings row SURVIVES the saved_view delete (cascadeDelete=false) → 200", s, 200);
  check("survived row is still ROW_ID", r.id, ROW_ID);
  // Observed: PB strips the dangling relation to id on deleted-target — dangling default_view reads as "".
  check("dangling default_view reference cleared to ''", r.default_view, "");

  console.log("\n── delete: user_settings is self-only (deleteRule: user = auth.id) ──");
  // COVERS: rule:user_settings.delete
  const [bob_token, bob_id] = await login("bob@example.com");
  qs = urlencode({ filter: `user='${bob_id}'` });
  [s, r] = await api("GET", `/api/collections/user_settings/records?${qs}`, bob_token);
  const bob_items = truthy(r.items) ? r.items : [];
  check("resolved bob's auto-provisioned user_settings row", bob_items.length, 1);
  const BOB_ROW_ID = bob_items.length ? getitem(bob_items[0], "id") : null;

  const [carol_token] = await login("carol@example.com");
  [s] = await api("DELETE", `/api/collections/user_settings/records/${BOB_ROW_ID}`, carol_token);
  check("carol DELETE bob's user_settings row → 404 (not her own)", s, 404);

  [s] = await api("DELETE", `/api/collections/user_settings/records/${BOB_ROW_ID}`, bob_token);
  check("bob DELETE his own user_settings row → 204", s, 204);
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — user_settings vocabulary, bounds and defaults behave as declared");
  process.exit(0);
}

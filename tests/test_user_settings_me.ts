#!/usr/bin/env bun
/**
 * /api/tracker/users/{id}/settings: one read joins users.name with the caller's user_settings
 * row, one write saves both or neither, and another user's settings are hidden (404).
 *
 * Port 8154 + PB_PORT_OFFSET (suite self-boot band, .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate_up } from "../scripts/pb_migrate.ts";
import { decode_text, py_repr, run_checked, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT = 8154 + roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
// PB sentenizes a BadRequestError message: capital first letter, closing period.
const SHADOW_MSG = "That project cannot be chosen here; pick one from the project list.";
const KEYS = [
  "display_name",
  "theme",
  "font",
  "font_size",
  "default_view",
  "default_project",
  "time_zone",
];

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  const tag = ok ? "✅" : "❌ MISMATCH";
  console.log(`  ${tag}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`);
}

async function api(
  method: string,
  p: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + p, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = new Uint8Array(await r.arrayBuffer());
  try {
    return [r.status, raw.length ? JSON.parse(decode_text(raw)) : {}];
  } catch {
    return [r.status, { _raw: new TextDecoder("utf-8").decode(raw) }];
  }
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [r.token, r.record?.id];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-user-settings-me-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log("\n══════════ user settings route room ══════════");
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
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const [, sua] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = sua.token;
  if (!su) throw new Error(`superuser auth failed: ${py_repr(sua)}`);

  console.log(
    "\n── seed: alice + bob (the users-create hook provisions each a user_settings row) ──",
  );
  let s: number;
  let r: any;
  for (const [name, email] of [
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
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
  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const ME = `/api/tracker/users/${alice_id}/settings`;
  const BOB_ME = `/api/tracker/users/${bob_id}/settings`;
  const settingsRow = async (uid: string) => {
    const [, l] = await api(
      "GET",
      "/api/collections/user_settings/records?" + urlencode({ filter: `user='${uid}'` }),
      su,
    );
    return l.items ?? [];
  };
  const userName = async (uid: string) =>
    (await api("GET", `/api/collections/users/records/${uid}`, su))[1].name;

  console.log("\n── anon ──");
  // COVERS: route:GET /api/tracker/users/{id}/settings
  [s] = await api("GET", ME);
  check("anon GET → 401", s, 401);
  // COVERS: route:PATCH /api/tracker/users/{id}/settings
  [s] = await api("PATCH", ME, null, { theme: "dark" });
  check("anon PATCH → 401", s, 401);

  console.log("\n── criterion 1: one read returns display_name with the settings ──");
  [s, r] = await api("GET", ME, alice);
  const ownGet = s;
  check("alice GET own settings → 200", s, 200);
  check("response carries exactly the seven keys", Object.keys(r).sort(), [...KEYS].sort());
  check("display_name is users.name", r.display_name, "Alice");
  check("theme / font are the provisioned defaults", [r.theme, r.font], ["system", "system"]);

  console.log("\n── PATCH happy path: both halves persist ──");
  [s, r] = await api("PATCH", ME, alice, {
    display_name: "Alice Renamed",
    theme: "dark",
    time_zone: "Europe/Paris",
  });
  check("alice PATCH display_name + theme + time_zone → 200", s, 200);
  check(
    "PATCH response reflects both halves",
    [r.display_name, r.theme, r.time_zone],
    ["Alice Renamed", "dark", "Europe/Paris"],
  );
  check("users.name read back through the records API", await userName(alice_id), "Alice Renamed");
  let rows = await settingsRow(alice_id);
  check(
    "user_settings read back through the records API",
    [rows.length, rows[0]?.theme, rows[0]?.time_zone],
    [1, "dark", "Europe/Paris"],
  );
  [s, r] = await api("GET", ME, alice);
  check(
    "GET after PATCH shows the new values",
    [r.display_name, r.theme],
    ["Alice Renamed", "dark"],
  );

  console.log("\n── criterion 2: settings half fails → users.name unchanged ──");
  [s, r] = await api("PATCH", ME, alice, {
    display_name: "Should Not Stick",
    time_zone: "x".repeat(65),
  });
  check("PATCH display_name + 65-char time_zone → 400", s, 400);
  check("400 names the time_zone field", Boolean(r?.data?.time_zone), true);
  check(
    "users.name rolled back (still 'Alice Renamed')",
    await userName(alice_id),
    "Alice Renamed",
  );
  rows = await settingsRow(alice_id);
  check("time_zone unchanged", rows[0]?.time_zone, "Europe/Paris");

  console.log("\n── body validation ──");
  [s, r] = await api("PATCH", ME, alice, {});
  check(
    "PATCH {} → 400 'No changes were supplied.'",
    [s, r?.message],
    [400, "No changes were supplied."],
  );
  for (const body of [{ user: bob_id }, { id: "abc" }, { bogus: 1, theme: "light" }]) {
    [s] = await api("PATCH", ME, alice, body);
    check(`PATCH ${JSON.stringify(body)} (unknown key) → 400`, s, 400);
  }
  [s] = await api("PATCH", ME, alice, { display_name: 42 });
  check("PATCH display_name=42 (not text) → 400", s, 400);
  [s] = await api("PATCH", ME, alice, { theme: "neon" });
  check("PATCH theme='neon' (not an option) → 400", s, 400);
  check("users.name untouched by refused bodies", await userName(alice_id), "Alice Renamed");

  console.log("\n── default_project: the shadow refusal holds on this route ──");
  const proj = async (shadow: boolean) =>
    (
      await api(
        "GET",
        "/api/collections/projects/records?" +
          urlencode({ filter: `shadow=${shadow} && workspace.owner='${alice_id}'`, perPage: 1 }),
        su,
      )
    )[1].items?.[0]?.id;
  const shadowId = await proj(true);
  const plainId = await proj(false);
  check(
    "fixtures: alice has a shadow and a plain project",
    [Boolean(shadowId), Boolean(plainId)],
    [true, true],
  );
  [s, r] = await api("PATCH", ME, alice, {
    display_name: "Shadow Pick",
    default_project: shadowId,
  });
  check("PATCH default_project=<shadow> → 400 shadow refusal", [s, r?.message], [400, SHADOW_MSG]);
  check("users.name unchanged by the shadow refusal", await userName(alice_id), "Alice Renamed");
  [s, r] = await api("PATCH", ME, alice, { default_project: plainId });
  check("PATCH default_project=<plain> → 200", [s, r?.default_project], [200, plainId]);

  console.log("\n── criterion 3: another user's settings are hidden ──");
  [s, r] = await api("GET", ME, bob);
  console.log(`     bob GET alice's settings → ${s} ${py_repr(r)}`);
  check(
    "bob GET alice's settings → 404 (route live: alice's own GET was 200)",
    [s, ownGet],
    [404, 200],
  );
  [s, r] = await api("PATCH", ME, bob, { display_name: "Hacked by Bob", theme: "light" });
  console.log(`     bob PATCH alice's settings → ${s} ${py_repr(r)}`);
  check("bob PATCH alice's settings → 404 (route live)", [s, ownGet], [404, 200]);
  check("alice's users.name unchanged", await userName(alice_id), "Alice Renamed");
  rows = await settingsRow(alice_id);
  check("alice's theme unchanged", rows[0]?.theme, "dark");
  [s] = await api("GET", "/api/tracker/users/doesnotexist123/settings", alice);
  check("GET an unknown user id → 404 (route live)", [s, ownGet], [404, 200]);

  console.log("\n── no settings row: GET answers defaults, PATCH creates the row ──");
  rows = await settingsRow(bob_id);
  [s] = await api("DELETE", `/api/collections/user_settings/records/${rows[0]?.id}`, bob);
  check("bob deletes his own user_settings row → 204", s, 204);
  [s, r] = await api("GET", BOB_ME, bob);
  check(
    "bob GET with no row → 200 defaults",
    [s, r.display_name, r.theme, r.font],
    [200, "Bob", "system", "system"],
  );
  [s, r] = await api("PATCH", BOB_ME, bob, { font_size: 14 });
  check("bob PATCH font_size=14 with no row → 200", [s, r.font_size], [200, 14]);
  rows = await settingsRow(bob_id);
  check(
    "exactly one row created, defaults filled",
    [rows.length, rows[0]?.font_size, rows[0]?.theme, rows[0]?.font],
    [1, 14, "system", "system"],
  );

  console.log("\n── API keys: a write key may PATCH, a read key may only GET ──");
  const [, readKey] = await api("POST", "/api/collections/api_keys/records", alice, {
    name: "r",
    scope: "read",
  });
  const [, writeKey] = await api("POST", "/api/collections/api_keys/records", alice, {
    name: "w",
    scope: "write",
  });
  [s] = await api("GET", ME, readKey.key);
  check("read key GET → 200", s, 200);
  [s, r] = await api("PATCH", ME, readKey.key, { theme: "light" });
  check("read key PATCH → 403 api_key_scope", [s, r?.data?.api_key?.code], [403, "api_key_scope"]);
  [s, r] = await api("PATCH", ME, writeKey.key, { theme: "light" });
  check("write key PATCH → 200", [s, r?.theme], [200, "light"]);
  [s, r] = await api("PATCH", ME, writeKey.key, { display_name: "Renamed by key", theme: "dark" });
  check(
    "write key PATCH display_name → 403 api_key_path (decision:api-keys: a key never changes the account)",
    [s, r?.data?.api_key?.code],
    [403, "api_key_path"],
  );
  [s, r] = await api("GET", ME, alice);
  check(
    "key rename refused whole: name and theme unchanged",
    [r?.display_name !== "Renamed by key", r?.theme],
    [true, "light"],
  );

  const USERS = `/api/collections/users/records/${alice_id}`;
  const aliceRow = (await settingsRow(alice_id))[0]?.id;
  const ROW = `/api/collections/user_settings/records/${aliceRow}`;
  const nameBefore = await userName(alice_id);

  console.log("\n── 2ghp: a blank name is refused on the route and on the users record ──");
  for (const blank of ["", "   "]) {
    [s, r] = await api("PATCH", ME, alice, { display_name: blank, theme: "dark" });
    check(
      `route display_name=${py_repr(blank)} → 400 naming display_name`,
      [s, Boolean(r?.data?.display_name)],
      [400, true],
    );
    [s, r] = await api("PATCH", USERS, alice, { name: blank });
    check(
      `users PATCH name=${py_repr(blank)} → 400 naming name`,
      [s, Boolean(r?.data?.name)],
      [400, true],
    );
  }
  [s, r] = await api("POST", "/api/collections/users/records", null, {
    email: "blank@example.com",
    name: "  ",
  });
  check("signup with name='  ' → 400 naming name", [s, Boolean(r?.data?.name)], [400, true]);
  check("users.name unchanged by the blank refusals", await userName(alice_id), nameBefore);
  [s, r] = await api("POST", "/api/collections/users/records", null, {
    email: "noname@example.com",
    name: "",
  });
  check("signup with name='' → 200 (an account may have no name)", [s, r?.name], [200, ""]);
  [s, r] = await api("PATCH", `/api/collections/users/records/${r?.id}`, su, {
    name: "",
    verified: true,
  });
  check("a resent unchanged empty name passes (form resave) → 200", [s, r?.verified], [200, true]);
  check(
    "theme unchanged by the refused route save",
    (await settingsRow(alice_id))[0]?.theme,
    "light",
  );
  [s, r] = await api("PATCH", ME, alice, { display_name: "  Alice Trimmed  " });
  check("route display_name is stored trimmed", [s, r?.display_name], [200, "Alice Trimmed"]);
  [s, r] = await api("PATCH", USERS, alice, { name: "  Alice Again " });
  check("users PATCH name is stored trimmed", [s, await userName(alice_id)], [200, "Alice Again"]);

  console.log("\n── 2ghp: a default project or view the caller cannot read is refused ──");
  const bobProj = (
    await api(
      "GET",
      "/api/collections/projects/records?" +
        urlencode({ filter: `shadow=false && workspace.owner='${bob_id}'`, perPage: 1 }),
      su,
    )
  )[1].items?.[0];
  const [, bobView] = await api("POST", "/api/collections/saved_views/records", bob, {
    workspace: bobProj?.workspace,
    name: "Bob's board",
    scope: "workspace",
  });
  const aliceWs = (await api("GET", `/api/collections/projects/records/${plainId}`, alice))[1]
    .workspace;
  const [, aliceView] = await api("POST", "/api/collections/saved_views/records", alice, {
    workspace: aliceWs,
    name: "Alice's board",
    scope: "personal",
  });
  check(
    "fixtures: bob's project, bob's view, alice's view",
    [Boolean(bobProj?.id), Boolean(bobView?.id), Boolean(aliceView?.id)],
    [true, true, true],
  );
  const missingCode = (await api("PATCH", ME, alice, { default_project: "zzzzzzzzzzzzzzz" }))[1]
    ?.data?.default_project?.code;
  for (const [field, id] of [
    ["default_project", bobProj?.id],
    ["default_view", bobView?.id],
  ]) {
    [s, r] = await api("PATCH", ME, alice, { [field]: id });
    check(
      `route ${field}=<bob's> → 400 answered like a missing id`,
      [s, r?.data?.[field]?.code],
      [400, missingCode],
    );
    [s, r] = await api("PATCH", ROW, alice, { [field]: id });
    check(
      `records PATCH ${field}=<bob's> → 400 naming ${field}`,
      [s, Boolean(r?.data?.[field])],
      [400, true],
    );
  }
  check("a missing id is itself refused (400 code present)", Boolean(missingCode), true);
  for (const [field, id, want] of [
    ["default_project", bobProj?.id, missingCode],
    ["default_view", bobView?.id, missingCode],
  ]) {
    [s, r] = await api("PATCH", ME, alice, { [field]: [id] });
    check(
      `route ${field}=[<bob's>] (an array) → 400 like the string form`,
      [s, r?.data?.[field]?.code],
      [400, want],
    );
  }
  [s, r] = await api("PATCH", ME, alice, { default_project: [shadowId] });
  check(
    "route default_project=[<shadow>] (an array) → 400 shadow refusal",
    [s, r?.message],
    [400, SHADOW_MSG],
  );
  rows = await settingsRow(alice_id);
  check(
    "alice's pointers unchanged",
    [rows[0]?.default_project, rows[0]?.default_view],
    [plainId, ""],
  );
  [s, r] = await api("PATCH", ME, alice, { default_view: aliceView?.id });
  check("route default_view=<alice's own> → 200", [s, r?.default_view], [200, aliceView?.id]);
  [s, r] = await api("PATCH", ROW, alice, { default_view: "", default_project: plainId });
  check("records PATCH a readable project, cleared view → 200", s, 200);
  rows = await settingsRow(bob_id);
  [s] = await api("DELETE", `/api/collections/user_settings/records/${rows[0]?.id}`, bob);
  check("bob deletes his row again → 204", s, 204);
  [s, r] = await api("POST", "/api/collections/user_settings/records", bob, {
    user: bob_id,
    default_project: plainId,
  });
  check(
    "records CREATE default_project=<alice's> → 400 naming default_project",
    [s, Boolean(r?.data?.default_project)],
    [400, true],
  );

  console.log("\n── 1853: an unknown time zone is refused; empty clears; a real name saves ──");
  for (const tz of ["Mars/Olympus", "Local", "Europe/Pariss"]) {
    [s, r] = await api("PATCH", ME, alice, { time_zone: tz });
    check(
      `route time_zone=${py_repr(tz)} → 400 naming time_zone`,
      [s, Boolean(r?.data?.time_zone)],
      [400, true],
    );
  }
  [s, r] = await api("PATCH", ROW, alice, { time_zone: "Not/AZone" });
  check(
    "records PATCH time_zone='Not/AZone' → 400 naming time_zone",
    [s, Boolean(r?.data?.time_zone)],
    [400, true],
  );
  [s, r] = await api("POST", "/api/collections/user_settings/records", bob, {
    user: bob_id,
    time_zone: "Mars/Olympus",
  });
  check(
    "records CREATE time_zone='Mars/Olympus' → 400 naming time_zone",
    [s, Boolean(r?.data?.time_zone)],
    [400, true],
  );
  [s, r] = await api("POST", "/api/collections/user_settings/records", bob, {
    user: bob_id,
    time_zone: "America/New_York",
  });
  check(
    "records CREATE time_zone='America/New_York' → 200",
    [s, r?.time_zone],
    [200, "America/New_York"],
  );
  check(
    "alice's stored time_zone unchanged",
    (await settingsRow(alice_id))[0]?.time_zone,
    "Europe/Paris",
  );
  [s, r] = await api("PATCH", ME, alice, { time_zone: "" });
  check("route time_zone='' clears it → 200", [s, r?.time_zone], [200, ""]);
  [s, r] = await api("PATCH", ME, alice, { time_zone: "Europe/Paris" });
  check("route time_zone='Europe/Paris' → 200", [s, r?.time_zone], [200, "Europe/Paris"]);
  [s, r] = await api("PATCH", ROW, alice, { time_zone: "Asia/Tokyo" });
  check("records PATCH time_zone='Asia/Tokyo' → 200", [s, r?.time_zone], [200, "Asia/Tokyo"]);
} finally {
  if (server) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log(
    "✅ PASS — the settings route reads and writes users.name with user_settings atomically, self-only",
  );
  process.exit(0);
}

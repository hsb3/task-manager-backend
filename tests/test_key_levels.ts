#!/usr/bin/env bun
/**
 * decision:api-key-reach-and-levels: a key request below its level (read < write < manage < own)
 * answers 403 api_key_scope, a purge needs manage, leaving or a role change needs own, and `me`
 * narrows capabilities by level; every non-GET registry route carries a level.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8210 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8210 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const USERS = "/api/collections/users/records";
const recs = (c: string) => `/api/collections/${c}/records`;
const MANAGE_MSG = "This action needs an API key at the manage level or above.";
const OWN_MSG = "This action needs an API key at the own level.";
// 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(76)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

async function api(
  method: string,
  url: string,
  auth: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await r.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { _raw: text };
  }
  return [r.status, parsed];
}

/** The whole refusal: status, top-level message, data.api_key code and message. */
const answer = ([s, r]: [number, any]) =>
  tup(s, r?.message ?? null, r?.data?.api_key?.code ?? null, r?.data?.api_key?.message ?? null);
const scope403 = (msg: string) => tup(403, msg, "api_key_scope", msg);

async function login(email: string): Promise<[string, string]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  if (s !== 200) throw new roomkit.SystemExit(`login ${email} failed: ${s} ${py_repr(r)}`);
  return [r.token, r.record.id];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-key-levels-test-"));
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
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  console.log(
    "\n── fixtures: Alice owns WA (PA) and WT; Bob owns WC and WD; Mia, Sam, Vic in WA ──",
  );
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const name of ["Alice", "Bob", "Mia", "Sam", "Vic"]) {
    const email = `${name.toLowerCase()}@example.com`;
    const [s] = await api("POST", USERS, su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`(fixture) ${name} created`, s, 200);
    [tokens[name], ids[name]] = await login(email);
  }
  const alice = tokens.Alice;
  const bob = tokens.Bob;
  const [, wl] = await api(
    "GET",
    `${recs("workspaces")}?${urlencode({ filter: `owner='${ids.Alice}'` })}`,
    su,
  );
  const WA: string = wl.items?.[0]?.id ?? "";
  const ws = async (token: string, name: string): Promise<string> => {
    const [st, w] = await api("POST", recs("workspaces"), token, { name });
    check(`(fixture) ${name} created`, st, 200);
    return w.id ?? "";
  };
  const WT = await ws(alice, "WT");
  const WC = await ws(bob, "WC");
  const WD = await ws(bob, "WD");
  let [s, r] = await api("POST", recs("projects"), alice, { name: "PA", workspace: WA });
  const PA: string = r.id ?? "";
  check("(fixture) project PA in WA", s, 200);
  const rows: Record<string, string> = {};
  for (const [who, w, role] of [
    ["Bob", WA, "admin"],
    ["Bob", WT, "member"],
    ["Mia", WA, "member"],
    ["Sam", WA, "member"],
    ["Vic", WA, "viewer"],
  ]) {
    [s, r] = await api("POST", recs("workspace_members"), su, {
      workspace: w,
      user: ids[who],
      role,
      status: "active",
    });
    rows[`${who}@${w}`] = r.id ?? "";
    check(`(fixture) ${who} is an active ${role} of ${w === WA ? "WA" : "WT"}`, s, 200);
  }
  const invite = async (w: string, label: string): Promise<string> => {
    const [st, inv] = await api("POST", recs("workspace_invitations"), bob, {
      workspace: w,
      email: "alice@example.com",
      role: "member",
    });
    check(`(fixture) Bob invites alice@example.com to ${label}`, st, 200);
    return inv.id ?? "";
  };
  const INV_C = await invite(WC, "WC");
  const INV_D = await invite(WD, "WD");
  const mint = async (token: string, name: string, scope: string): Promise<string> => {
    const [st, k] = await api("POST", KEYS, token, { name, scope });
    check(`(fixture) key ${name} minted`, st, 200);
    return k.key ?? "tmk_none";
  };
  const aRead = await mint(alice, "aRead", "read");
  const aWrite = await mint(alice, "aWrite", "write");
  const aManage = await mint(alice, "aManage", "manage");
  const aOwn = await mint(alice, "aOwn", "own");
  const bManage = await mint(bob, "bManage", "manage");
  const bOwn = await mint(bob, "bOwn", "own");
  const mOwn = await mint(tokens.Mia, "mOwn", "own");

  console.log("\n── me: capabilities narrowed by level ──");
  const caps = async (key: string) => {
    const [, m] = await api("GET", "/api/tracker/me", key);
    return (m.workspaces ?? []).find((w: any) => w.id === WA)?.capabilities ?? null;
  };
  for (const [label, key, want] of [
    ["aRead", aRead, [false, false, false]],
    ["aWrite", aWrite, [true, false, false]],
    ["aManage", aManage, [true, true, false]],
    ["aOwn", aOwn, [true, true, true]],
    ["mOwn", mOwn, [true, false, false]],
  ] as [string, string, boolean[]][]) {
    const [write, manage, own] = want;
    check(`${label} me: WA {write: ${write}, manage: ${manage}, own: ${own}}`, await caps(key), {
      write,
      manage,
      own,
    });
  }

  console.log("\n── a level above the role ──");
  const wa_name = async () => (await api("GET", `${recs("workspaces")}/${WA}`, su))[1].name;
  const name_before = await wa_name();
  [s] = await api("PATCH", `${recs("workspaces")}/${WA}`, mOwn, { name: "Mia's" });
  check(
    "mOwn PATCHes WA's name → 404, name unchanged",
    tup(s, await wa_name()),
    tup(404, name_before),
  );

  console.log("\n── purge needs manage ──");
  const trashed = async (c: string, id: string) => {
    const [st, x] = await api("GET", `${recs(c)}/${id}`, su);
    return st === 200 ? x.trashed !== "" : st;
  };
  [s, r] = await api("POST", recs("tasks"), aWrite, { title: "T", workspace: WA, project: PA });
  const T: string = r.id ?? "";
  const s2 = (await api("PATCH", `${recs("tasks")}/${T}`, aWrite, { title: "T2" }))[0];
  const s3 = (await api("DELETE", `${recs("tasks")}/${T}`, aWrite))[0];
  check(
    "aWrite creates, edits and trashes a task → 200, 200, 204",
    tup(s, s2, s3),
    tup(200, 200, 204),
  );
  const purge = await api("DELETE", `${recs("tasks")}/${T}`, aWrite);
  check(
    "aWrite purges the trashed task → 403 api_key_scope, still trashed",
    tup(answer(purge), await trashed("tasks", T)),
    tup(scope403(MANAGE_MSG), true),
  );
  [s] = await api("DELETE", `${recs("tasks")}/${T}`, aManage);
  check(
    "aManage purges it → 204, superuser reads 404",
    tup(s, await trashed("tasks", T)),
    tup(204, 404),
  );
  [, r] = await api("POST", recs("projects"), alice, { name: "PX", workspace: WA });
  const PX: string = r.id ?? "";
  [s] = await api("DELETE", `${recs("projects")}/${PX}`, aWrite);
  check(
    "aWrite trashes a live project → 204",
    tup(s, await trashed("projects", PX)),
    tup(204, true),
  );
  check(
    "aWrite purges it → 403",
    answer(await api("DELETE", `${recs("projects")}/${PX}`, aWrite)),
    scope403(MANAGE_MSG),
  );
  [s] = await api("DELETE", `${recs("projects")}/${PX}`, aManage);
  check("aManage → 204", tup(s, await trashed("projects", PX)), tup(204, 404));

  console.log("\n── write-level deletes stay write ──");
  [, r] = await api("POST", recs("tasks"), alice, { title: "T3", workspace: WA, project: PA });
  const T3: string = r.id ?? "";
  [s, r] = await api("POST", recs("comments"), aWrite, { task: T3, body: "hi" });
  check("(fixture) aWrite comments on T3", s, 200);
  check(
    "aWrite deletes its own comment → 204",
    (await api("DELETE", `${recs("comments")}/${r.id}`, aWrite))[0],
    204,
  );
  const form = new FormData();
  form.append("attachments+", new Blob([PNG], { type: "image/png" }), "a.png");
  const up = await fetch(`${BASE_URL}${recs("tasks")}/${T3}`, {
    method: "PATCH",
    headers: { Authorization: su },
    body: form,
  });
  const att: string = ((await up.json()) as any).attachments?.[0] ?? "";
  check("(fixture) superuser attaches a file to T3", tup(up.status, !!att), tup(200, true));
  [s, r] = await api("PATCH", `${recs("tasks")}/${T3}`, aWrite, { "attachments-": [att] });
  check(
    "aWrite removes an attachment (`attachments-` PATCH) → 200",
    tup(s, r.attachments ?? null),
    tup(200, []),
  );

  console.log("\n── workspace settings and vocabulary need manage ──");
  check(
    "aWrite PATCH WA name → 403 api_key_scope, manage message",
    answer(await api("PATCH", `${recs("workspaces")}/${WA}`, aWrite, { name: "WA w" })),
    scope403(MANAGE_MSG),
  );
  check(
    "aManage → 200",
    (await api("PATCH", `${recs("workspaces")}/${WA}`, aManage, { name: "WA m" }))[0],
    200,
  );
  const vocab = `/api/tracker/workspaces/${WA}/vocab`;
  check(
    "aWrite POST vocab on WA → 403",
    answer(await api("POST", vocab, aWrite, {})),
    scope403(MANAGE_MSG),
  );
  check("aManage → 200", (await api("POST", vocab, aManage, {}))[0], 200);
  const vocabBodies: [string, string, any][] = [
    ["label", "labels", { workspace: WA, name: "L" }],
    ["status", "statuses", { workspace: WA, name: "S", category: "started" }],
    ["cycle", "cycles", { workspace: WA, name: "C", starts_on: "2026-04-01 00:00:00.000Z" }],
    ["template", "templates", { workspace: WA, name: "Tp", type: "task" }],
  ];
  for (const [label, c, body] of vocabBodies) {
    check(
      `aWrite creates a ${label} in WA → 403`,
      answer(await api("POST", recs(c), aWrite, body)),
      scope403(MANAGE_MSG),
    );
  }
  for (const [label, c, body] of vocabBodies) {
    check(
      `aManage creates a ${label} in WA → 200`,
      (await api("POST", recs(c), aManage, body))[0],
      200,
    );
  }

  console.log("\n── invitations need manage ──");
  const inv = { workspace: WA, email: "z@example.com", role: "member" };
  check(
    "aWrite invites z@example.com to WA → 403",
    answer(await api("POST", recs("workspace_invitations"), aWrite, inv)),
    scope403(MANAGE_MSG),
  );
  check("aManage → 200", (await api("POST", recs("workspace_invitations"), aManage, inv))[0], 200);
  const rme = `/api/tracker/workspaces/${WA}/resolve-member-email`;
  check(
    "aWrite resolve-member-email on WA → 403",
    answer(await api("POST", rme, aWrite, { email: "y@example.com" })),
    scope403(MANAGE_MSG),
  );
  check("aManage → 200", (await api("POST", rme, aManage, { email: "y@example.com" }))[0], 200);

  console.log("\n── members: status manage, role and leaving own ──");
  const member = async (row: string) =>
    (await api("GET", `${recs("workspace_members")}/${row}`, su))[1];
  check(
    "aManage suspends Sam (PATCH status suspended) → 200",
    (
      await api("PATCH", `${recs("workspace_members")}/${rows[`Sam@${WA}`]}`, aManage, {
        status: "suspended",
      })
    )[0],
    200,
  );
  const mia = `${recs("workspace_members")}/${rows[`Mia@${WA}`]}`;
  check(
    "aManage changes Mia's role to admin → 403 own message, role unchanged",
    tup(
      answer(await api("PATCH", mia, aManage, { role: "admin" })),
      (await member(rows[`Mia@${WA}`])).role,
    ),
    tup(scope403(OWN_MSG), "member"),
  );
  [s] = await api("PATCH", mia, aOwn, { role: "admin" });
  check(
    "aOwn changes Mia's role to admin → 200",
    tup(s, (await member(rows[`Mia@${WA}`])).role),
    tup(200, "admin"),
  );
  check(
    "aManage removes Vic → 204",
    (await api("DELETE", `${recs("workspace_members")}/${rows[`Vic@${WA}`]}`, aManage))[0],
    204,
  );
  const bobRow = `${recs("workspace_members")}/${rows[`Bob@${WA}`]}`;
  check(
    "bManage leaves WA (deletes his own row) → 403",
    tup(answer(await api("DELETE", bobRow, bManage)), (await api("GET", bobRow, su))[0]),
    tup(scope403(OWN_MSG), 200),
  );
  check(
    "bOwn leaves WA → 204",
    tup((await api("DELETE", bobRow, bOwn))[0], (await api("GET", bobRow, su))[0]),
    tup(204, 404),
  );

  console.log("\n── accepting and declining invitations need own ──");
  const accept = (id: string, k: string) => api("POST", `/api/tracker/invitations/${id}/accept`, k);
  const decline = (id: string, k: string) =>
    api("POST", `/api/tracker/invitations/${id}/decline`, k);
  check(
    "aWrite accepts the WC invitation → 403 own message",
    answer(await accept(INV_C, aWrite)),
    scope403(OWN_MSG),
  );
  check("aOwn accepts it → 200", (await accept(INV_C, aOwn))[0], 200);
  check(
    "aWrite declines the WD invitation → 403",
    answer(await decline(INV_D, aWrite)),
    scope403(OWN_MSG),
  );
  [s] = await decline(INV_D, aOwn);
  check(
    "aOwn declines it → 200, invitation gone",
    tup(s, (await api("GET", `${recs("workspace_invitations")}/${INV_D}`, su))[0]),
    tup(200, 404),
  );

  console.log("\n── handing over and deleting a workspace need own ──");
  const xfer = `/api/tracker/workspaces/${WT}/transfer-ownership`;
  check(
    "aManage transfer-ownership of WT to Bob → 403",
    answer(await api("POST", xfer, aManage, { user: ids.Bob })),
    scope403(OWN_MSG),
  );
  [s] = await api("POST", xfer, aOwn, { user: ids.Bob });
  check(
    "aOwn → 200, WT owner is Bob",
    tup(s, (await api("GET", `${recs("workspaces")}/${WT}`, su))[1].owner),
    tup(200, ids.Bob),
  );
  check(
    "aManage deletes WA → 403",
    answer(await api("DELETE", `${recs("workspaces")}/${WA}`, aManage)),
    scope403(OWN_MSG),
  );
  [s] = await api("DELETE", `${recs("workspaces")}/${WA}`, aOwn);
  check("aOwn deletes WA → 204 (trashed)", tup(s, await trashed("workspaces", WA)), tup(204, true));

  console.log("\n── the level table covers the route registry ──");
  const req = createRequire(import.meta.url);
  const ROUTES = req(path.join(REPO_ROOT, "pb_hooks/lib/routes.js")).ROUTES;
  const ROUTE_LEVELS = req(path.join(REPO_ROOT, "pb_hooks/lib/api_keys.js")).ROUTE_LEVELS ?? {};
  const unclassified = Object.keys(ROUTES).filter((k) => {
    const spec = ROUTES[k];
    const [method, p] = k.split(" ");
    return (
      method !== "GET" &&
      method !== "HEAD" &&
      spec.auth !== "none" &&
      spec.internal !== true &&
      !p.startsWith("/api/tracker/admin/") &&
      !(k in ROUTE_LEVELS) &&
      k !== "POST /api/tracker/export"
    );
  });
  check("every non-GET registry route is classified → no unclassified route", unclassified, []);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all key-level proofs passed");
  process.exit(0);
}

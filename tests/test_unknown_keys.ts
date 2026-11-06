#!/usr/bin/env bun
/**
 * Unknown body keys: a create or an update through the records API that sends a key the collection
 * does not define is refused 400 with the key named, on every collection, JSON and multipart (file parts too),
 * single and batch; the non-field keys a hook reads (expected_updated_at, the auth password pair) still pass.
 *
 * Fully self-contained clean-room server, scripts/seed.ts fixtures. Port 8173 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8173 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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

async function find_by_filter(collection: string, filt: string, token: string): Promise<any[]> {
  const qs = urlencode({ filter: filt, perPage: 200 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return r.items || [];
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-unknown-keys-test-"));
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
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
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
  const KEY = "zz_unknown";
  const URL = (c: string) => `/api/collections/${c}/records`;
  const names = (r: any) =>
    tup(Object.keys(r?.data ?? {}).includes(KEY), String(r?.message ?? "").includes(KEY));
  let s: number;
  let r: any;

  // Fixtures for the collections seed.ts leaves empty, so every collection has a row to PATCH.
  const ALICE_WS = getitem(
    (await find_by_filter("workspaces", "name='Alice\\'s Workspace'", alice))[0],
    "id",
  );
  const TASK = getitem((await find_by_filter("tasks", `workspace='${ALICE_WS}'`, su))[0], "id");
  const fixtures: [string, any][] = [
    ["cycles", { name: "Cycle one", workspace: ALICE_WS, starts_on: "2027-01-04 00:00:00.000Z" }],
    ["decisions", { title: "Decision one", workspace: ALICE_WS }],
    ["documents", { title: "Document one", workspace: ALICE_WS }],
    ["saved_views", { name: "View one", workspace: ALICE_WS, owner: alice_id, scope: "personal" }],
    ["templates", { name: "Template one", workspace: ALICE_WS, type: "task", templateData: {} }],
    ["task_subscribers", { task: TASK, user: alice_id }],
    ["workspace_invitations", { workspace: ALICE_WS, email: "dora@example.com", role: "member" }],
    ["notifications", { user: alice_id, kind: "ownership_transferred", workspace: ALICE_WS }],
    ["task_activity", { task: TASK, workspace: ALICE_WS, actor: alice_id, field: "title" }],
    ["invitation_events", { kind: "decline", email_key: "dora@example.com", workspace: ALICE_WS }],
  ];
  for (const [c, body] of fixtures) {
    if ((await find_by_filter(c, "", su)).length) continue;
    [s, r] = await api("POST", URL(c), su, body);
    check(`fixture: superuser creates a ${c} row`, s, 200);
    if (s !== 200) console.log(`     ${py_repr(r)}`);
  }
  if ((await find_by_filter("api_keys", "", su)).length === 0) {
    [s, r] = await api("POST", URL("api_keys"), alice, { name: "probe key", scope: "read" });
    check("fixture: alice mints an api key", s, 200);
  }

  console.log("\n── every collection: create and update naming an unknown key ──");
  const [, cols] = await api(
    "GET",
    `/api/collections?perPage=200&filter=${encodeURIComponent("system=false && type!='view'")}`,
    su,
  );
  const collections: string[] = cols.items.map((c: any) => c.name).sort();
  check("collections probed (none may be skipped)", collections.length > 20, true);
  for (const c of collections) {
    [s, r] = await api("POST", URL(c), su, { [KEY]: 1 });
    check(
      `${c}: create naming ${KEY} → 400 naming it`,
      tup(s, names(r)),
      tup(400, tup(true, true)),
    );
    const first = (await find_by_filter(c, "", su))[0];
    if (!first) {
      check(`${c}: has a row to update`, false, true);
      continue;
    }
    [s, r] = await api("PATCH", `${URL(c)}/${first.id}`, su, { [KEY]: 1 });
    check(
      `${c}: update naming ${KEY} → 400 naming it`,
      tup(s, names(r)),
      tup(400, tup(true, true)),
    );
  }

  console.log("\n── a member's write: the known part is not saved either ──");
  [s, r] = await api("GET", `${URL("tasks")}/${TASK}`, alice);
  const title_before = r.title;
  [s, r] = await api("PATCH", `${URL("tasks")}/${TASK}`, alice, { title: "Renamed", estimate: 3 });
  console.log(`     PATCH {title, estimate} → ${s} ${py_repr(r.message ?? "")}`);
  check(
    "owner PATCH {title, estimate} → 400 naming estimate",
    tup(
      s,
      Object.keys(r?.data ?? {}).includes("estimate"),
      String(r.message ?? "").includes("estimate"),
    ),
    tup(400, true, true),
  );
  [s, r] = await api("GET", `${URL("tasks")}/${TASK}`, alice);
  check("the title is unchanged", r.title, title_before);
  [s, r] = await api("PATCH", `${URL("tasks")}/${TASK}`, alice, { "labels+": [], "nope+": 1 });
  check(
    "PATCH with an unknown modifier key nope+ → 400 naming it",
    tup(s, String(r.message ?? "").includes("nope+")),
    tup(400, true),
  );
  [s, r] = await api("PATCH", `${URL("tasks")}/${TASK}`, alice, { "labels+": [] });
  check("control: PATCH with a known modifier key labels+ → 200", s, 200);
  const fd = new FormData();
  fd.append("title", "Multipart rename");
  fd.append(KEY, "1");
  const mr = await fetch(`${BASE_URL}${URL("tasks")}/${TASK}`, {
    method: "PATCH",
    headers: { Authorization: alice },
    body: fd,
  });
  r = await mr.json();
  check(
    "multipart PATCH naming an unknown key → 400 naming it",
    tup(mr.status, names(r)),
    tup(400, tup(true, true)),
  );
  const filed = async (method: string, url: string, fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    f.append("zz_file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    const res = await fetch(BASE_URL + url, { method, headers: { Authorization: alice }, body: f });
    return tup(res.status, String(((await res.json()) as any).message ?? "").includes("zz_file"));
  };
  check(
    "multipart PATCH with an unknown FILE part → 400 naming it",
    await filed("PATCH", `${URL("tasks")}/${TASK}`, { title: "File rename" }),
    tup(400, true),
  );
  check(
    "multipart PATCH whose only part is an unknown file → 400 naming it",
    await filed("PATCH", `${URL("tasks")}/${TASK}`, {}),
    tup(400, true),
  );
  check(
    "multipart create with an unknown FILE part → 400 naming it",
    await filed("POST", URL("documents"), { title: "Filed doc", workspace: ALICE_WS }),
    tup(400, true),
  );
  [s, r] = await api("POST", "/api/batch", alice, {
    requests: [
      { method: "PATCH", url: `${URL("tasks")}/${TASK}`, body: { title: "Batch", [KEY]: 1 } },
    ],
  });
  console.log(
    `     batch PATCH naming an unknown key → ${s} ${py_repr(r.message ?? "")} ${py_repr(r.data ?? {})}`,
  );
  check(
    "batch PATCH naming an unknown key → 400 naming it",
    tup(s, JSON.stringify(r).includes(KEY)),
    tup(400, true),
  );

  console.log("\n── keys a hook reads are not unknown ──");
  const view = (await find_by_filter("saved_views", "", su))[0];
  [s, r] = await api("PATCH", `${URL("saved_views")}/${view.id}`, su, {
    name: "View renamed",
    expected_updated_at: view.updated,
  });
  check("saved_views PATCH {name, expected_updated_at: current} → 200", s, 200);
  [s, r] = await api("PATCH", `${URL("users")}/${alice_id}`, alice, {
    oldPassword: "test123456",
    password: "test654321",
    passwordConfirm: "test654321",
  });
  check("users PATCH own {oldPassword, password, passwordConfirm} → 200", s, 200);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all unknown-key proofs passed");
  process.exit(0);
}

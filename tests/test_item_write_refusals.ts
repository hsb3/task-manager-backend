#!/usr/bin/env bun
/**
 * Item write refusals (decision:shadow-project kept, decision:draft-private-publish-one-way): a document/decision/milestone
 * created with a project and no workspace fills its workspace from the project like a task; a project-less create still lands in
 * the shadow project; draft cannot be re-asserted on a draft or sent as a non-boolean, on create or update.
 *
 * Fully self-contained clean-room server, scripts/seed.ts fixtures. Port 8158 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8158 + PORT_OFFSET;
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

async function form(
  method: string,
  path: string,
  token: string,
  fields: Record<string, string>,
): Promise<[number, any]> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(BASE_URL + path, { method, headers: { Authorization: token }, body: fd });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : {}];
}

async function repeated(
  path: string,
  token: string,
  pairs: [string, string][],
): Promise<[number, any]> {
  const fd = new FormData();
  for (const [k, v] of pairs) fd.append(k, v);
  const r = await fetch(BASE_URL + path, {
    method: "PATCH",
    headers: { Authorization: token },
    body: fd,
  });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : {}];
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

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-item-write-refusals-test-"));
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
  const [bob, bob_id] = await login("bob@example.com");
  const [carol] = await login("carol@example.com");

  const ALICE_WS = getitem(
    (await find_by_filter("workspaces", "name='Alice\\'s Workspace'", alice))[0],
    "id",
  );
  const projs = await find_by_filter("projects", `workspace='${ALICE_WS}'`, su);
  const PROJ = getitem(
    projs.find((p) => !truthy(p.shadow)),
    "id",
  );
  const SHADOW = getitem(
    projs.find((p) => truthy(p.shadow)),
    "id",
  );
  tierkit.use(api);
  const alice_owns = await tierkit.owner_of_workspace(ALICE_WS, alice_id, alice, "Alice");
  const bob_member = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");

  let s: number;
  let r: any;
  const NAME: Record<string, string> = {
    documents: "title",
    decisions: "title",
    milestones: "name",
    tasks: "title",
  };
  const URL = (c: string) => `/api/collections/${c}/records`;
  const stored = async (c: string, v: string) =>
    (await find_by_filter(c, `${NAME[c]}='${v}'`, su)).length;

  const ITEMS = ["documents", "decisions", "milestones"];
  console.log("\n── workspace derives from project (member) ──");
  for (const c of ITEMS) {
    [s, r] = await api("POST", URL(c), bob, { [NAME[c]]: `${c} derived`, project: PROJ });
    check(
      `${c}: member create {project} no workspace → 200, workspace = project's`,
      tup(await bob_member.now(), s, r.workspace ?? null),
      tup("member", 200, ALICE_WS),
    );
  }

  console.log(
    "\n── project-less create still lands in the shadow project (decision:shadow-project) ──",
  );
  for (const c of ["tasks", ...ITEMS]) {
    [s, r] = await api("POST", URL(c), bob, { [NAME[c]]: `${c} shadowed`, workspace: ALICE_WS });
    check(
      `${c}: member create {workspace} no project → 200, shadow project`,
      tup(s, r.project ?? null),
      tup(200, SHADOW),
    );
  }
  await bob_member.done();

  console.log("\n── non-member and viewer stay refused on {project} only ──");
  for (const c of ITEMS) {
    [s] = await api("POST", URL(c), carol, { [NAME[c]]: `${c} carol`, project: PROJ });
    check(`${c}: Carol (non-member) {project} → 400`, s, 400);
    check(`${c}: …stored nothing`, await stored(c, `${c} carol`), 0);
  }
  const bob_viewer = await tierkit.actor_at_tier(ALICE_WS, bob_id, "viewer", alice, "Bob");
  for (const c of ITEMS) {
    [s] = await api("POST", URL(c), bob, { [NAME[c]]: `${c} viewer`, project: PROJ });
    check(`${c}: Bob (viewer) {project} → 400`, tup(await bob_viewer.now(), s), tup("viewer", 400));
    check(`${c}: …stored nothing`, await stored(c, `${c} viewer`), 0);
  }
  await bob_viewer.done();

  console.log("\n── draft is one-way and boolean ──");
  const MSG = "A published item cannot be returned to draft. Move it to trash instead.";
  const bob_member2 = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");
  for (const c of ITEMS) {
    const base = { [NAME[c]]: `${c} drafty`, workspace: ALICE_WS, project: PROJ };
    [s, r] = await api("POST", URL(c), bob, { ...base, draft: true });
    check(`${c}: create {draft:true} → 200, draft`, tup(s, r.draft ?? null), tup(200, true));
    const id = r.id;
    [s, r] = await api("PATCH", `${URL(c)}/${id}`, bob, { draft: true });
    check(
      `${c}: PATCH {draft:true} on a draft → 400 one-way message`,
      tup(s, r.message ?? null),
      tup(400, MSG),
    );
    [s, r] = await api("PATCH", `${URL(c)}/${id}`, bob, { draft: "yes" });
    console.log(`  (status for ${c} PATCH draft:"yes" = ${s})`);
    check(`${c}: PATCH {draft:"yes"} → 400`, s, 400);
    [s, r] = await api("PATCH", `${URL(c)}/${id}`, su, { draft: true });
    check(`${c}: superuser PATCH {draft:true} on a draft stays exempt → 200`, s, 200);
    [s, r] = await api("PATCH", `${URL(c)}/${id}`, bob, { draft: false });
    check(
      `${c}: PATCH {draft:false} publishes → 200, draft false`,
      tup(s, r.draft ?? null),
      tup(200, false),
    );
    [s, r] = await api("PATCH", `${URL(c)}/${id}`, bob, { draft: true });
    check(
      `${c}: PATCH {draft:true} on published → 400 one-way message`,
      tup(s, r.message ?? null),
      tup(400, MSG),
    );

    [s] = await api("POST", URL(c), bob, { ...base, [NAME[c]]: `${c} yes`, draft: "yes" });
    console.log(`  (status for ${c} create draft:"yes" = ${s})`);
    check(`${c}: create {draft:"yes"} → 400`, s, 400);
    check(`${c}: …stored nothing`, await stored(c, `${c} yes`), 0);
    [s] = await api("POST", URL(c), bob, { ...base, [NAME[c]]: `${c} strtrue`, draft: "true" });
    check(`${c}: create JSON {draft:"true"} (a string) → 400`, s, 400);

    // A form carries text: its draft field takes "true"/"false", its @jsonPayload is JSON.
    const fields = { ...base, [NAME[c]]: `${c} form` } as Record<string, string>;
    [s, r] = await form("POST", URL(c), bob, { ...fields, draft: "true" });
    check(`${c}: form create draft=true → 200, draft`, tup(s, r.draft ?? null), tup(200, true));
    const fid = r.id;
    [s] = await form("PATCH", `${URL(c)}/${fid}`, bob, { draft: "yes" });
    check(`${c}: form PATCH draft=yes → 400`, s, 400);
    [s] = await form("PATCH", `${URL(c)}/${fid}`, bob, {
      "@jsonPayload": JSON.stringify({ draft: "yes" }),
    });
    check(`${c}: form PATCH @jsonPayload {draft:"yes"} → 400`, s, 400);
    [s] = await form("PATCH", `${URL(c)}/${fid}`, bob, {
      "@jsonPayload": JSON.stringify({ draft: true }),
    });
    check(`${c}: form PATCH @jsonPayload {draft:true} on a draft → 400`, s, 400);
    // A repeated field is applied by PocketBase too, so every repeat is checked, not the first.
    [s] = await repeated(`${URL(c)}/${fid}`, bob, [
      ["draft", "false"],
      ["draft", "yes"],
    ]);
    check(`${c}: form PATCH draft=false&draft=yes → 400`, s, 400);
    [s] = await repeated(`${URL(c)}/${fid}`, bob, [
      ["@jsonPayload", JSON.stringify({ draft: false })],
      ["@jsonPayload", JSON.stringify({ draft: "yes" })],
    ]);
    check(`${c}: form PATCH with a second @jsonPayload {draft:"yes"} → 400`, s, 400);
    [s] = await repeated(`${URL(c)}/${fid}`, bob, [
      ["@jsonPayload", JSON.stringify({ title: "x" })],
      ["@jsonPayload", JSON.stringify({ draft: true })],
    ]);
    check(`${c}: form PATCH with a second @jsonPayload {draft:true} on a draft → 400`, s, 400);
    [s] = await form("POST", URL(c), bob, {
      "@jsonPayload": JSON.stringify({ ...base, [NAME[c]]: `${c} jp yes`, draft: "yes" }),
    });
    check(`${c}: form create @jsonPayload {draft:"yes"} → 400`, s, 400);
    check(`${c}: …stored nothing`, await stored(c, `${c} jp yes`), 0);

    // Every batch sub-request reaches the record hooks as a form with an @jsonPayload.
    const batch = (method: string, url: string, body: any) =>
      api("POST", "/api/batch", bob, { requests: [{ method, url, body }] });
    [s] = await batch("PATCH", `${URL(c)}/${fid}`, { draft: "yes" });
    check(`${c}: batch PATCH {draft:"yes"} → 400`, s, 400);
    [s] = await batch("PATCH", `${URL(c)}/${fid}`, { draft: true });
    check(`${c}: batch PATCH {draft:true} on a draft → 400`, s, 400);
    [s] = await batch("POST", URL(c), { ...base, [NAME[c]]: `${c} batch yes`, draft: "yes" });
    check(`${c}: batch create {draft:"yes"} → 400`, s, 400);
    check(`${c}: …stored nothing`, await stored(c, `${c} batch yes`), 0);
    [s, r] = await api("GET", `${URL(c)}/${fid}`, bob);
    check(
      `${c}: after every refusal the form item is still a draft`,
      tup(s, r.draft ?? null),
      tup(200, true),
    );
    [s, r] = await form("PATCH", `${URL(c)}/${fid}`, bob, { draft: "false" });
    check(`${c}: form PATCH draft=false publishes → 200`, tup(s, r.draft ?? null), tup(200, false));
  }
  await bob_member2.done();

  console.log("\n── a create into a trashed project is refused (card 6nrc) ──");
  const bob_member3 = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");
  [s, r] = await api("POST", URL("projects"), alice, {
    name: "trashed-project creates",
    workspace: ALICE_WS,
  });
  check("setup: owner creates a project → 200", s, 200);
  const TRASHED = r.id;
  const ALL = ["tasks", ...ITEMS];
  let PARENT = "";
  for (const c of ALL) {
    [s, r] = await api("POST", URL(c), alice, { [NAME[c]]: `${c} live project`, project: TRASHED });
    check(`${c}: owner create into the live project → 200`, s, 200);
    if (c === "tasks") PARENT = r.id;
  }
  [s] = await api("DELETE", `${URL("projects")}/${TRASHED}`, alice);
  check("setup: owner DELETE moves the project to the trash → 204", s, 204);
  for (const [who, tok] of [
    ["owner", alice],
    ["member", bob],
  ] as const) {
    for (const c of ALL) {
      [s] = await api("POST", URL(c), tok, { [NAME[c]]: `${c} ${who} trashed`, project: TRASHED });
      check(
        `${c}: ${who} create {project} into a trashed project → 400`,
        tup(await bob_member3.now(), s),
        tup("member", 400),
      );
      check(`${c}: …stored nothing`, await stored(c, `${c} ${who} trashed`), 0);
      [s] = await api("POST", URL(c), tok, {
        [NAME[c]]: `${c} ${who} trashed ws`,
        workspace: ALICE_WS,
        project: TRASHED,
      });
      check(`${c}: ${who} create {workspace, project} into a trashed project → 400`, s, 400);
      check(`${c}: …stored nothing`, await stored(c, `${c} ${who} trashed ws`), 0);
    }
    // a subtask names no project; the create hook would inherit the trashed one from its parent
    [s] = await api("POST", URL("tasks"), tok, {
      title: `subtask ${who} trashed`,
      workspace: ALICE_WS,
      parent: PARENT,
    });
    check(`tasks: ${who} subtask create {workspace, parent in a trashed project} → 400`, s, 400);
    check(`tasks: …stored nothing`, await stored("tasks", `subtask ${who} trashed`), 0);
  }
  await bob_member3.done();
  [s] = await api("PATCH", `${URL("projects")}/${TRASHED}`, alice, { trashed: "" });
  check("owner restores the project → 200", s, 200);
  for (const c of ALL) {
    [s] = await api("POST", URL(c), alice, { [NAME[c]]: `${c} restored`, project: TRASHED });
    check(`${c}: owner create into the restored project → 200`, s, 200);
  }
  for (const c of ALL) {
    const [, d] = await api(
      "GET",
      `/api/collections/app_docs/records?${urlencode({ filter: `slug='collection:${c}'` })}`,
      su,
    );
    check(
      `${c}: app_docs states the trashed-project refusal`,
      (d.items?.[0]?.body ?? "").includes("names a project in the trash is refused"),
      true,
    );
  }

  console.log("\n── measured (report only): trash with no workspace param ──");
  [s, r] = await api("GET", "/api/tracker/trash", alice);
  console.log(`  GET /api/tracker/trash (no workspace) → ${s} ${py_repr(r.message ?? r)}`);
  await alice_owns.done();

  await tierkit.verify_tiers();
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all item-write-refusal proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * PBTT-424 — prove scripts/bulk_load_projects.ts loads projects through /api/batch without
 * inventing, altering or half-writing a single project prefix.
 *
 *   §1 dry run is the default: it plans and writes nothing.
 *   §2 happy path: every explicit key is stored VERBATIM, and the key-minting hooks still
 *      run on a batch create (a task in a loaded project gets <KEY>-1).
 *   §3 refusals before any write: no key, an invalid key, a duplicate key, an oversized chunk.
 *   §4 a chunk is atomic: the failing chunk rolls back whole, earlier chunks persist, and
 *      re-running the fixed command resumes on the unique (workspace,key) index.
 *   §5 an input key already used in the workspace under a DIFFERENT name is ambiguous.
 *   §6 (PBTT-490) the chunk cap is READ from the running server, never restated: a room
 *      whose batch.maxRequests is not 50 is chunked and refused by ITS number.
 *
 * Bound: the loader is exercised against ONE workspace and a superuser identity only —
 * non-superuser callers and multi-workspace input are outside its CLI shape.
 *
 * Fully self-contained clean-room server, real pb_hooks/ via roomkit. Port 8114 +
 * PB_PORT_OFFSET (suite self-boot band per CLAUDE.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  by_code_point,
  json_dumps,
  py_repr,
  py_str,
  py_strip,
  run_checked,
  splitlines,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const LOADER = path.join(REPO_ROOT, "scripts", "bulk_load_projects.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8114 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Dummy superuser — NOT a real secret.
const SU_EMAIL = "bulkload-ci@example.test";
const SU_PASSWORD = "bulkload-ci-dummy-pw-000";
const OWNER_EMAIL = "bulk-owner@example.com";
const OWNER_PASSWORD = "test123456";
const WS_NAME = "Bulk Load Target";

// projects.name maxes at 200 (schema/projects.json) — the loader deliberately does not
// client-validate length, so this row reaches the server and 400s its whole chunk.
const TOO_LONG_NAME = "L".repeat(250);

const LOAD_ROWS: Record<string, string>[] = [
  { name: "Website Redesign", key: "ENG", description: "front of house" },
  { name: "Public API", key: "API" },
  { name: "Operations", key: "OPS" },
  { name: "Data Platform", key: "DATA" },
  { name: "Machine Learning", key: "ML" },
  { name: "Quality", key: "QA" },
  { name: "Marketing Site", key: "WEB2" },
];
const CAP_ROWS = [..."ABCD"].map((i) => ({ name: `Cap Probe ${i}`, key: `CAP${i}` }));
const NON_DEFAULT_CAP = 3; // not the 50 the settings migration seeds — the loader must read it
const RESUME_ROWS = [
  { name: "Resume One", key: "RESA" },
  { name: "Resume Two", key: "RESB" },
  { name: "Resume Three", key: "RESC" },
  { name: "Resume Four", key: "RESD" },
  { name: "Resume Five", key: "RESE" },
];

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
    body: body !== null ? json_dumps(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await r.text();
  if (r.ok) return [r.status, raw ? JSON.parse(raw) : {}];
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, {}];
  }
}

/**
 * A self-contained `pocketbase serve` clean-room on the repo's REAL pb_hooks/ — the
 * key-minting hooks are exactly what this suite has to see fire through /api/batch.
 */
class Room {
  port: number;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null = null;

  constructor(port: number) {
    this.port = port;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-bulkload-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    for (const f of fs.readdirSync(this.migrations_dir)) {
      if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(this.migrations_dir, f));
    }
  }

  async start(): Promise<void> {
    await roomkit.require_free_port(this.port);
    run_checked(
      [
        POCKETBASE_BIN,
        "superuser",
        "upsert",
        SU_EMAIL,
        SU_PASSWORD,
        "--dir",
        this.data_dir,
        "--migrationsDir",
        this.migrations_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    this.proc = await roomkit.serve(
      this.port,
      this.data_dir,
      this.migrations_dir,
      roomkit.hooks_dir(this.tmp),
    );
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!tok) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

async function make_owner(su: string): Promise<string> {
  const [status, r] = await api("POST", "/api/collections/users/records", su, {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    passwordConfirm: OWNER_PASSWORD,
    name: "Bulk Owner",
    verified: true,
    approved: true,
  });
  if (status !== 200) throw new roomkit.SystemExit(`owner create failed: ${status} ${py_str(r)}`);
  return getitem(r, "id");
}

/**
 * A workspace created by direct API POST gets its vocab seeded but NO default
 * project — so the loader's target starts with an empty key space.
 */
async function make_workspace(su: string, owner_id: string): Promise<string> {
  const [status, r] = await api("POST", "/api/collections/workspaces/records", su, {
    name: WS_NAME,
    owner: owner_id,
  });
  if (status !== 200) {
    throw new roomkit.SystemExit(`workspace create failed: ${status} ${py_str(r)}`);
  }
  return getitem(r, "id");
}

async function projects_by_key(su: string, workspace_id: string): Promise<Record<string, string>> {
  const qs = urlencode({
    filter: `workspace="${workspace_id}"`,
    perPage: 500,
    fields: "id,key,name",
  });
  const [status, page] = await api("GET", `/api/collections/projects/records?${qs}`, su);
  if (status !== 200)
    throw new roomkit.SystemExit(`project list failed: ${status} ${py_str(page)}`);
  const out: Record<string, string> = {};
  for (const p of page.items || []) if (p.key) out[p.key] = getitem(p, "name");
  return out;
}

async function project_id_for(
  su: string,
  workspace_id: string,
  key: string,
): Promise<string | null> {
  const qs = urlencode({ filter: `workspace="${workspace_id}" && key="${key}"` });
  const [, page] = await api("GET", `/api/collections/projects/records?${qs}`, su);
  const items = page.items || [];
  return items.length ? getitem(items[0], "id") : null;
}

/** The loader as an operator would run it: its own process, env pointed at this room. */
async function run_loader(
  scratch: string,
  rows: unknown[],
  workspace: string,
  owner: string,
  extra: string[] = [],
  filename = "input.json",
): Promise<[number, string]> {
  const file = path.join(scratch, filename);
  fs.writeFileSync(file, json_dumps(rows), "utf8");
  const proc = Bun.spawn(
    [
      process.execPath,
      LOADER,
      "--input",
      file,
      "--workspace",
      workspace,
      "--owner",
      owner,
      ...extra,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PB_URL: BASE_URL,
        PB_SUPERUSER_EMAIL: SU_EMAIL,
        PB_SUPERUSER_PASSWORD: SU_PASSWORD,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, rc] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return [rc, stdout + stderr];
}

/**
 * What the loader actually complained about: its per-row details when it listed
 * them, else the single REFUSED line.
 */
function refusal_lines(output: string): string[] {
  const lines = splitlines(output);
  const details = lines.filter((ln) => ln.startsWith("  · ")).map((ln) => py_strip(ln));
  if (details.length) return details;
  const refused = lines.filter((ln) => ln.startsWith("REFUSED:"));
  return refused.length ? refused : ["(none)"];
}

console.log(
  `════════ test_bulk_load_projects.ts — PBTT-424 bulk loader (room on :${PORT}) ════════`,
);
const room = new Room(PORT);
try {
  await room.start();
  const su = await superuser_token();
  const owner_id = await make_owner(su);
  const ws_id = await make_workspace(su, owner_id);
  console.log(
    `  fixtures: owner=${owner_id} (${OWNER_EMAIL})  workspace=${ws_id} (${py_repr(WS_NAME)})`,
  );
  let rc: number;
  let out: string;

  // ── §1 dry run is the default ────────────────────────────────────────────
  console.log("\n── §1 no --yes: the loader plans and writes nothing ──");
  [rc, out] = await run_loader(room.tmp, LOAD_ROWS, WS_NAME, OWNER_EMAIL);
  check("dry run exits 0", rc, 0);
  check("dry run says it wrote nothing", out.includes("dry run — nothing written."), true);
  check("dry run plans all 7 rows as creates", out.includes("7 to create"), true);
  check("the workspace still holds no project", await projects_by_key(su, ws_id), {});

  // ── §2 happy path ────────────────────────────────────────────────────────
  console.log("\n── §2 --yes: every explicit key is stored verbatim, and the hooks still fire ──");
  [rc, out] = await run_loader(room.tmp, LOAD_ROWS, WS_NAME, OWNER_EMAIL, ["--yes"]);
  check("load exits 0", rc, 0);
  check("the loader re-listed and verified", out.includes("verified:  all 7 input key(s)"), true);
  const stored = await projects_by_key(su, ws_id);
  check(
    "every key is present with its own name, verbatim",
    stored,
    Object.fromEntries(LOAD_ROWS.map((r) => [r.key, r.name])),
  );
  const eng_id = await project_id_for(su, ws_id, "ENG");
  const [status, task] = await api("POST", "/api/collections/tasks/records", su, {
    title: "first item in a bulk-loaded project",
    workspace: ws_id,
    project: eng_id,
  });
  check("a task in a bulk-loaded project → 200", status, 200);
  check("its display key numbers from 1 in that project", task.key, "ENG-1");

  // ── §3 refusals, each before any write ───────────────────────────────────
  console.log("\n── §3 the input is refused whole, with nothing written ──");
  let before = await projects_by_key(su, ws_id);
  const cases: [string, unknown[], string[], string][] = [
    [
      "a row with no key",
      [{ name: "Keyless" }, { name: "Fine", key: "ZZA" }],
      [],
      "row 1: missing or empty 'key'",
    ],
    [
      "a lowercase key (never normalized for you)",
      [{ name: "Lower", key: "zzb" }],
      [],
      "row 1: key 'zzb' does not match",
    ],
    [
      "two rows sharing one key",
      [
        { name: "First", key: "ZZC" },
        { name: "Second", key: "ZZC" },
      ],
      [],
      "row 2: key 'ZZC' duplicates row 1",
    ],
    [
      "--chunk 51, past the server's batch maxRequests",
      [{ name: "Chunky", key: "ZZD" }],
      ["--chunk", "51"],
      "exceeds the server's batch maxRequests (50)",
    ],
  ];
  for (const [label, rows, extra, reason] of cases) {
    [rc, out] = await run_loader(room.tmp, rows, WS_NAME, OWNER_EMAIL, ["--yes", ...extra]);
    check(`${label} → non-zero exit`, rc !== 0, true);
    check(`${label} → named by its cause`, out.includes(reason), true);
    for (const line of refusal_lines(out)) console.log(`        ${line}`);
  }
  check("nothing was written by any refusal", await projects_by_key(su, ws_id), before);

  // ── §4 a chunk is atomic, and a re-run resumes ───────────────────────────
  console.log("\n── §4 the failing chunk rolls back whole; the same command re-run resumes ──");
  const broken = RESUME_ROWS.map((r) => ({ ...r }));
  broken[3].name = TOO_LONG_NAME; // row 4, inside chunk 2 of --chunk 2
  [rc, out] = await run_loader(
    room.tmp,
    broken,
    WS_NAME,
    OWNER_EMAIL,
    ["--yes", "--chunk", "2"],
    "r.json",
  );
  check("the run exits non-zero", rc !== 0, true);
  check(
    "it names chunk 2 and its input rows",
    out.includes("chunk 2/3 (input rows 3-4) failed"),
    true,
  );
  check("chunk 1 reported its own elapsed ms", out.includes("chunk 1/3  input rows 1-2"), true);
  for (const line of refusal_lines(out)) console.log(`        ${line}`);
  const after_fail = await projects_by_key(su, ws_id);
  check(
    "chunk 1's two rows are committed",
    Object.keys(after_fail)
      .filter((k) => k.startsWith("RES"))
      .sort(by_code_point),
    ["RESA", "RESB"],
  );
  check("the whole failing chunk rolled back", Object.hasOwn(after_fail, "RESC"), false);
  check("no later chunk was attempted", Object.hasOwn(after_fail, "RESE"), false);

  [rc, out] = await run_loader(
    room.tmp,
    RESUME_ROWS,
    WS_NAME,
    OWNER_EMAIL,
    ["--yes", "--chunk", "2"],
    "r2.json",
  );
  check("the fixed re-run exits 0", rc, 0);
  check("chunk 1's rows are recognised as already loaded", out.includes("2 already loaded"), true);
  check("only the remaining 3 rows are planned", out.includes("3 to create"), true);
  const final = await projects_by_key(su, ws_id);
  check(
    "all five resume rows are present with their names",
    Object.fromEntries(Object.entries(final).filter(([k]) => k.startsWith("RES"))),
    Object.fromEntries(RESUME_ROWS.map((r) => [r.key, r.name])),
  );
  check(
    "the workspace holds exactly the loaded projects",
    Object.keys(final).length,
    LOAD_ROWS.length + 5,
  );

  // ── §5 an existing key under a different name is ambiguous ───────────────
  console.log("\n── §5 a key already used in the workspace under another name is refused ──");
  before = await projects_by_key(su, ws_id);
  [rc, out] = await run_loader(
    room.tmp,
    [{ name: "Not The Website Redesign", key: "ENG" }],
    WS_NAME,
    OWNER_EMAIL,
    ["--yes"],
    "ambiguous.json",
  );
  check("the ambiguous row → non-zero exit", rc !== 0, true);
  check("it names the ambiguity, not a collision", out.includes("ambiguous key(s)"), true);
  for (const line of refusal_lines(out)) console.log(`        ${line}`);
  check("nothing was written", await projects_by_key(su, ws_id), before);

  // ── §6 the cap comes from the server, not from the loader ────────────────
  console.log("\n── §6 this room's batch maxRequests is 3, and the loader obeys THAT ──");
  const [cap_status] = await api("PATCH", "/api/settings", su, {
    batch: { enabled: true, maxRequests: NON_DEFAULT_CAP, timeout: 30 },
  });
  check("the room's cap is changed to 3", cap_status, 200);
  [rc, out] = await run_loader(room.tmp, CAP_ROWS, WS_NAME, OWNER_EMAIL, [], "cap.json");
  check("no --chunk: it reads the cap off the server", out.includes("batch maxRequests: 3"), true);
  check("4 rows chunk by 3, not by 50", out.includes("2 chunk(s) of at most 3"), true);
  [rc, out] = await run_loader(room.tmp, CAP_ROWS, WS_NAME, OWNER_EMAIL, ["--yes"], "cap.json");
  check("the derived chunking loads exits 0", rc, 0);
  check("all 4 rows verified", out.includes("verified:  all 4 input key(s)"), true);
  [rc, out] = await run_loader(
    room.tmp,
    CAP_ROWS,
    WS_NAME,
    OWNER_EMAIL,
    ["--yes", "--chunk", "4"],
    "cap.json",
  );
  check("--chunk 4 (under 50, over this room's 3) → non-zero exit", rc !== 0, true);
  check("refused by the LIVE number", out.includes("batch maxRequests (3)"), true);
  for (const line of refusal_lines(out)) console.log(`        ${line}`);
  await api("PATCH", "/api/settings", su, { batch: { enabled: false } });
  [rc, out] = await run_loader(room.tmp, CAP_ROWS, WS_NAME, OWNER_EMAIL, ["--yes"]);
  check("batch API off → non-zero exit", rc !== 0, true);
  check("it refuses instead of writing", out.includes("batch API disabled"), true);
  for (const line of refusal_lines(out)) console.log(`        ${line}`);
} finally {
  await room.stop();
  room.cleanup_tmp();
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
  process.exit(0);
}

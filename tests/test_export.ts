#!/usr/bin/env bun
/**
 * Proof for `POST /api/tracker/export`: the per-collection read boundary is
 * re-enforced by hand (routes bypass rules), so this drives the FULL no-leak matrix — anon
 * 401, missing/blank workspace 400, an unreadable workspace 404, ZERO cross-tenant leakage
 * (a member of one workspace exporting it never pulls another tenant's rows), the draft
 * author-only carve-out (a plain member never receives another user's draft doc/decision/
 * milestone, the author does), self-only notifications + user_settings, the users email/
 * secret asymmetry (email rides the caller's own row only; password/tokenKey never),
 * project-selection narrowing that intersects with readable and cannot widen, and the
 * attachment payload on all four item types (tasks/documents/decisions/milestones): the
 * stored filenames ride, present-and-empty when a row has no files, and no bytes/URL/token.
 * Trash is excluded on BOTH hops — a row trashed on its own marker and a live row whose
 * PROJECT is trashed — and a restore of either brings the rows back.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8105 + PB_PORT_OFFSET (suite self-boot band, 8100+).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  by_code_point,
  getitem,
  json_dumps,
  py_get,
  py_repr,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8105 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

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

// A real, decodable PNG — the attachments field sniffs mime types.
function png_bytes(w: number, h: number, rgb: number[] = [40, 120, 200]): Buffer {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  function chunk(typ: Buffer, data: Buffer): Buffer {
    const c = Buffer.concat([typ, data]);
    return Buffer.concat([u32(data.length), c, u32(crc32(c))]);
  }

  const sig = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])]); // 8-bit RGB
  const px = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: w }, () => Buffer.from(rgb)),
  ]);
  const raw = Buffer.concat(Array.from({ length: h }, () => px));
  return Buffer.concat([
    sig,
    chunk(Buffer.from("IHDR"), ihdr),
    chunk(Buffer.from("IDAT"), deflateSync(raw)),
    chunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
}

async function multipart(
  method: string,
  coll: string,
  rid: string,
  token: string | null,
  field: string,
  filename: string,
  content: Uint8Array,
  ctype = "image/png",
): Promise<[number, any]> {
  // KEEP IN SYNC: tests/test_files.ts multipart() — fetch will not build `multipart/form-data; boundary=${b}` itself.
  const b = "----pb15boundary";
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${ctype}\r\n\r\n`),
    content,
    Buffer.from("\r\n"),
    Buffer.from(`--${b}--\r\n`),
  ]);
  const headers: Record<string, string> = {
    "Content-Type": `multipart/form-data; boundary=${b}`,
  };
  if (token) headers.Authorization = token;
  const r = await fetch(`${BASE_URL}/api/collections/${coll}/records/${rid}`, {
    method,
    headers,
    body,
  });
  return [r.status, JSON.parse((await r.text()) || "{}")];
}

// `export` is a reserved word in JS, so the Python helper `export` is `export_` here.
function export_(token: string | null, body: any): Promise<[number, any]> {
  return api("POST", "/api/tracker/export", token, body);
}

/** One LIVE row of each item type inside `project` (milestones require a project). */
async function make_items(
  token: string | null,
  workspace: string | null,
  project: string,
  tag: string,
): Promise<Record<string, string>> {
  const made: Record<string, string> = {};
  for (const [coll, payload] of [
    ["tasks", { title: `${tag} task` }],
    ["documents", { title: `${tag} doc` }],
    ["decisions", { title: `${tag} decision` }],
    ["milestones", { name: `${tag} milestone` }],
  ] as [string, Record<string, any>][]) {
    const [s, rec] = await api("POST", `/api/collections/${coll}/records`, token, {
      ...payload,
      workspace,
      project,
    });
    check(`(fixture) ${tag} ${coll} row created in ${project.slice(0, 8)}`, s, 200);
    made[coll] = rec.id;
  }
  return made;
}

/** Every record id across every collection array in an export's `data`. */
function ids_in(data: Record<string, any[]>): Set<string> {
  const out = new Set<string>();
  for (const arr of Object.values(data)) {
    for (const row of arr) {
      if (
        row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        Object.hasOwn(row, "id")
      ) {
        out.add(row.id);
      }
    }
  }
  return out;
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-export-test-"));
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

  let s: number;
  let r: any;
  let data: any;
  // auth ONCE per user — the auth endpoint rate-limits (429) on repeated logins
  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice); // tenant A
  const CAROL_WS = await find_id("workspaces", "name", "Carol's Workspace", carol); // tenant C
  const P1 = await find_id("projects", "name", "Website Redesign", alice); // A's project
  const BOB_WS = await find_id("workspaces", "name", "Bob's Workspace", bob); // tenant B
  const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob); // B's project
  const BOB_TASK = await find_id("tasks", "title", "Set up CI", bob); // B's task
  check("resolved Alice's workspace (A)", truthy(ALICE_WS), true);
  check("resolved Bob's workspace (B)", truthy(BOB_WS), true);
  check("resolved Bob's project 'Mobile App' (B)", truthy(BOB_PROJECT), true);
  check("resolved Bob's task 'Set up CI' (B)", truthy(BOB_TASK), true);

  console.log("\n── extra fixtures (drafts, notifications, second project, self settings) ──");
  // Draft doc/decision/milestone in A, authored by Alice (author.pb.js stamps the caller).
  [, r] = await api("POST", "/api/collections/documents/records", alice, {
    workspace: ALICE_WS,
    title: "Secret draft doc",
    draft: true,
  });
  check("draft document created (author=Alice)", r.draft, true);
  const DRAFT_DOC = r.id;
  [, r] = await api("POST", "/api/collections/documents/records", alice, {
    workspace: ALICE_WS,
    title: "Published doc",
  });
  const PUB_DOC = r.id;
  check("published document created", truthy(PUB_DOC), true);
  [, r] = await api("POST", "/api/collections/decisions/records", alice, {
    workspace: ALICE_WS,
    title: "Secret draft decision",
    draft: true,
  });
  const DRAFT_DEC = r.id;
  check("draft decision created (author=Alice)", r.draft, true);
  [, r] = await api("POST", "/api/collections/milestones/records", alice, {
    workspace: ALICE_WS,
    project: P1,
    name: "Secret draft milestone",
    draft: true,
  });
  const DRAFT_MS = r.id;
  check("draft milestone created (author=Alice)", r.draft, true);

  // Notifications, one per user (superuser-only create).
  [, r] = await api("POST", "/api/collections/notifications/records", su, {
    user: alice_id,
    kind: "assigned",
  });
  const ALICE_NOTIF = r.id;
  [, r] = await api("POST", "/api/collections/notifications/records", su, {
    user: bob_id,
    kind: "assigned",
  });
  const BOB_NOTIF = r.id;
  check("alice + bob notifications created", truthy(ALICE_NOTIF) && truthy(BOB_NOTIF), true);

  // user_settings — self-only read; ensure Alice has one so the absence assertion can bite.
  const existing = await find_by_filter("user_settings", `user='${alice_id}'`, su);
  let ALICE_SETTINGS: string;
  if (existing.length) {
    ALICE_SETTINGS = getitem(existing[0], "id");
  } else {
    [, r] = await api("POST", "/api/collections/user_settings/records", su, { user: alice_id });
    ALICE_SETTINGS = r.id;
  }
  check("Alice user_settings present", truthy(ALICE_SETTINGS), true);

  // Second project in A + a task in it (project-narrowing fixture).
  [, r] = await api("POST", "/api/collections/projects/records", su, {
    name: "Second Project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  const P2 = r.id;
  check("second project P2 created in A", truthy(P2), true);
  [, r] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "P2 only task",
    project: P2,
  });
  const P2_TASK = r.id;
  check("task in P2 created", truthy(P2_TASK), true);

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 1. auth + validation: 401 / 400 / 404 ═════════════
  console.log("\n── (1) auth + validation ──");
  [s] = await export_(null, { workspace: ALICE_WS });
  check("anon export → 401", s, 401);
  [s] = await export_(alice, {});
  check("alice export, no workspace → 400", s, 400);
  [s] = await export_(alice, { workspace: "   " });
  check("alice export, blank workspace → 400", s, 400);
  [s] = await export_(carol, { workspace: ALICE_WS });
  check("carol (non-member) export A → 404", s, 404);
  [s] = await export_(alice, { workspace: CAROL_WS });
  check("alice export Carol's ws (non-member) → 404", s, 404);

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 2. cross-tenant no-leak — Bob (member of A, owner of B) exports A ═════════════
  console.log("\n── (2) Bob exports A → ZERO rows from his OWN workspace B ──");
  [s, r] = await export_(bob, { workspace: ALICE_WS });
  check("bob export A → 200", s, 200);
  check("format_version == 1", r.format_version, 1);
  check("workspace echoed == A", r.workspace, ALICE_WS);
  check("exported_at present", truthy(r.exported_at), true);
  data = py_get(r, "data", {});
  const all_ids = ids_in(data);
  const proj_ids = new Set(py_get(data, "projects", []).map((p: any) => getitem(p, "id")));
  check("A export contains A's tasks (non-empty)", py_get(data, "tasks", []).length > 0, true);
  check("B project id ABSENT from A export (no leak)", all_ids.has(BOB_PROJECT!), false);
  check("B task id ABSENT from A export (no leak)", all_ids.has(BOB_TASK!), false);
  check("B project not in exported projects", proj_ids.has(BOB_PROJECT), false);
  for (const p of py_get(data, "projects", [])) {
    check(`exported project ${getitem(p, "id").slice(0, 8)} belongs to A`, p.workspace, ALICE_WS);
  }
  for (const t of py_get(data, "tasks", [])) {
    check(`exported task ${getitem(t, "id").slice(0, 8)} belongs to A`, t.workspace, ALICE_WS);
  }

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 3. draft carve-out — non-author member vs author ═════════════
  console.log("\n── (3) drafts: Bob (non-author member) excluded; Alice (author) included ──");
  [s, r] = await export_(bob, { workspace: ALICE_WS });
  const bob_ids = ids_in(py_get(r, "data", {}));
  check("bob export → 200", s, 200);
  check("Alice's draft DOC absent for Bob", bob_ids.has(DRAFT_DOC), false);
  check("Alice's draft DECISION absent for Bob", bob_ids.has(DRAFT_DEC), false);
  check("Alice's draft MILESTONE absent for Bob", bob_ids.has(DRAFT_MS), false);
  check("published doc PRESENT for Bob (only drafts are cut)", bob_ids.has(PUB_DOC), true);

  [s, r] = await export_(alice, { workspace: ALICE_WS });
  const alice_ids = ids_in(py_get(r, "data", {}));
  check("Alice's draft DOC present for Alice (author)", alice_ids.has(DRAFT_DOC), true);
  check("Alice's draft DECISION present for Alice (author)", alice_ids.has(DRAFT_DEC), true);
  check("Alice's draft MILESTONE present for Alice (author)", alice_ids.has(DRAFT_MS), true);

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 4. notifications / user_settings are self-only ═════════════
  console.log("\n── (4) notifications + user_settings belong ONLY to the caller ──");
  [s, r] = await export_(bob, { workspace: ALICE_WS });
  data = py_get(r, "data", {});
  const notifs: any[] = py_get(data, "notifications", []);
  const settings: any[] = py_get(data, "user_settings", []);
  check(
    "every notification row is Bob's",
    notifs.every((n) => n.user === bob_id),
    true,
  );
  check(
    "Bob's own notification present",
    new Set(notifs.map((n) => getitem(n, "id"))).has(BOB_NOTIF),
    true,
  );
  check(
    "Alice's notification ABSENT from Bob's export",
    new Set(notifs.map((n) => getitem(n, "id"))).has(ALICE_NOTIF),
    false,
  );
  check(
    "every user_settings row is Bob's",
    settings.every((us) => us.user === bob_id),
    true,
  );
  check(
    "Alice's user_settings ABSENT from Bob's export",
    new Set(settings.map((us) => getitem(us, "id"))).has(ALICE_SETTINGS),
    false,
  );

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 5. users: email caller-only, no password/tokenKey ever ═════════════
  console.log("\n── (5) users block: email asymmetry + no secrets ──");
  [s, r] = await export_(bob, { workspace: ALICE_WS });
  const users: any[] = py_get(py_get(r, "data", {}), "users", []);
  const by_id = new Map<string, any>(users.map((u) => [getitem(u, "id"), u]));
  check("Bob referenced in users", by_id.has(bob_id), true);
  check("Alice referenced in users (owner of A)", by_id.has(alice_id), true);
  check(
    "no user row carries 'password'",
    users.some((u) => Object.hasOwn(u, "password")),
    false,
  );
  check(
    "no user row carries 'tokenKey'",
    users.some((u) => Object.hasOwn(u, "tokenKey")),
    false,
  );
  check("Bob's own row carries email", py_get(by_id, bob_id, {}).email, "bob@example.com");
  check(
    "Alice's row carries NO email (not the caller)",
    Object.hasOwn(py_get(by_id, alice_id, {}), "email"),
    false,
  );
  const n_with_email = users.filter((u) => Object.hasOwn(u, "email")).length;
  check("exactly one user row (the caller) carries email", n_with_email, 1);

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 6. project selection narrows, cannot widen ═════════════
  console.log("\n── (6) projects selection intersects readable — narrow, never widen ──");
  [s, r] = await export_(alice, { workspace: ALICE_WS, projects: [P1] });
  check("alice export A projects=[P1] → 200", s, 200);
  check("scope.projects == [P1]", py_get(r, "scope", {}).projects, [P1]);
  data = py_get(r, "data", {});
  const sel_ids = ids_in(data);
  check(
    "only P1 in exported projects",
    new Set(py_get(data, "projects", []).map((p: any) => getitem(p, "id"))),
    new Set([P1]),
  );
  check("P2-only task ABSENT when only P1 selected", sel_ids.has(P2_TASK), false);
  check("a P1 task PRESENT when P1 selected", py_get(data, "tasks", []).length > 0, true);

  [s, r] = await export_(alice, { workspace: ALICE_WS, projects: [BOB_PROJECT] });
  check("alice export A projects=[B's project] → 200", s, 200);
  check("widen attempt: scope.projects intersected to []", py_get(r, "scope", {}).projects, []);
  const widen_ids = ids_in(py_get(r, "data", {}));
  check("widen attempt: B's project ABSENT", widen_ids.has(BOB_PROJECT!), false);
  check("widen attempt: B's task ABSENT", widen_ids.has(BOB_TASK!), false);

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 7. collections subset ═════════════
  console.log("\n── (7) collections subset emits only requested keys ──");
  [s, r] = await export_(alice, { workspace: ALICE_WS, collections: ["tasks"] });
  check("collections=[tasks] → 200", s, 200);
  check("data has only the 'tasks' key", Object.keys(py_get(r, "data", {})).sort(by_code_point), [
    "tasks",
  ]);
  check("scope.collections == [tasks]", py_get(r, "scope", {}).collections, ["tasks"]);

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 8. attachments: stored filenames ride, bytes/URLs/tokens never ═════════════
  console.log(
    "\n── (8) attachments on all four item types (tasks/documents/decisions/milestones) ──",
  );
  [, r] = await api("POST", "/api/collections/documents/records", alice, {
    workspace: ALICE_WS,
    title: "Attachment doc",
  });
  const ATT_DOC = r.id;
  [, r] = await api("POST", "/api/collections/decisions/records", alice, {
    workspace: ALICE_WS,
    title: "Attachment decision",
  });
  const ATT_DEC = r.id;
  [, r] = await api("POST", "/api/collections/milestones/records", alice, {
    workspace: ALICE_WS,
    project: P1,
    name: "Attachment milestone",
  });
  const ATT_MS = r.id;
  const attached: Record<string, string> = {
    tasks: P2_TASK,
    documents: ATT_DOC,
    decisions: ATT_DEC,
    milestones: ATT_MS,
  };
  check("attachment fixture rows created", Object.values(attached).every(truthy), true);

  const stored: Record<string, any[]> = {};
  for (const [coll, rid] of Object.entries(attached)) {
    let rec: any;
    [s, rec] = await multipart(
      "PATCH",
      coll,
      rid,
      alice,
      "attachments+",
      `${coll}-att.png`,
      png_bytes(60, 60),
    );
    stored[coll] = rec.attachments || [];
    check(
      `${coll}: upload → 200 with exactly one stored filename`,
      tup(s, stored[coll].length),
      tup(200, 1),
    );
  }

  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export after uploads → 200", s, 200);
  data = py_get(r, "data", {});
  for (const [coll, rid] of Object.entries(attached)) {
    let row: any = py_get(data, coll, []).find((x: any) => x.id === rid);
    check(`${coll}: the attached row is in the export`, row !== undefined, true);
    row = row ?? {};
    check(
      `${coll}: exported row carries the 'attachments' key`,
      Object.hasOwn(row, "attachments"),
      true,
    );
    check(`${coll}: attachments == the stored filename list`, row.attachments, stored[coll]);
    // Filenames only: no bytes, no download URL, no file token anywhere on the row.
    check(
      `${coll}: row carries no url/token/bytes key`,
      Object.keys(row)
        .filter((k) => k.toLowerCase().includes("url") || k.toLowerCase().includes("token"))
        .sort(by_code_point),
      [],
    );
    check(
      `${coll}: no token rides any VALUE on the row`,
      json_dumps(row).toLowerCase().includes("token"),
      false,
    );
    check(
      `${coll}: every attachments entry is a bare filename string`,
      (row.attachments || []).every((n: any) => typeof n === "string" && !n.includes("/")),
      true,
    );
  }
  const pub = py_get(data, "documents", []).find((x: any) => x.id === PUB_DOC) ?? {};
  check(
    "a row with NO files carries attachments == [] (present, not omitted)",
    py_get(pub, "attachments", "KEY-ABSENT"),
    [],
  );

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 9. trash exclusion — the row's own marker AND its project's ═════════════
  console.log("\n── (9a) a row trashed on its OWN marker is excluded (regression guard) ──");
  const trashed_items = await make_items(alice, ALICE_WS, P1!, "trashself");
  check(
    "(fixture) one live row of each item type in the LIVE project",
    Object.keys(trashed_items).length,
    4,
  );
  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export while the four rows are LIVE → 200", s, 200);
  const own_live_ids = ids_in(py_get(r, "data", {}));
  for (const [coll, rid] of Object.entries(trashed_items)) {
    check(`${coll}: control — the live row IS exported`, own_live_ids.has(rid), true);
  }
  for (const [coll, rid] of Object.entries(trashed_items)) {
    [s] = await api("DELETE", `/api/collections/${coll}/records/${rid}`, alice);
    check(`${coll}: first DELETE trashes the row → 204`, s, 204);
  }
  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export after trashing the four rows → 200", s, 200);
  const own_trash_ids = ids_in(py_get(r, "data", {}));
  for (const [coll, rid] of Object.entries(trashed_items)) {
    check(`${coll}: individually trashed row ABSENT from export`, own_trash_ids.has(rid), false);
  }

  console.log("\n── (9b) a LIVE row under a TRASHED project is excluded ──");
  [, r] = await api("POST", "/api/collections/projects/records", su, {
    name: "Trash Scope Project",
    owner: alice_id,
    workspace: ALICE_WS,
  });
  const P3 = r.id;
  check("(fixture) third project P3 created in A", truthy(P3), true);
  const under_p3 = await make_items(alice, ALICE_WS, P3, "underproj");
  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export while P3 is LIVE → 200", s, 200);
  const live_ids = ids_in(py_get(r, "data", {}));
  for (const [coll, rid] of Object.entries(under_p3)) {
    check(`${coll}: control — row under the LIVE project IS exported`, live_ids.has(rid), true);
  }

  [s] = await api("DELETE", `/api/collections/projects/records/${P3}`, alice);
  check("first DELETE trashes P3 → 204", s, 204);
  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export while P3 is TRASHED → 200", s, 200);
  data = py_get(r, "data", {});
  const hidden_ids = ids_in(data);
  check(
    "the trashed project itself is ABSENT from export",
    new Set(py_get(data, "projects", []).map((p: any) => getitem(p, "id"))).has(P3),
    false,
  );
  for (const [coll, rid] of Object.entries(under_p3)) {
    check(`${coll}: LIVE row under the TRASHED project ABSENT`, hidden_ids.has(rid), false);
  }

  console.log("\n── (9c) restore returns the rows to the export (project restore, then item) ──");
  [s] = await api("PATCH", `/api/collections/projects/records/${P3}`, alice, { trashed: "" });
  check("PATCH clearing P3.trashed (restore) → 200", s, 200);
  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export after restoring P3 → 200", s, 200);
  data = py_get(r, "data", {});
  const back_ids = ids_in(data);
  check(
    "the restored project is back in export",
    new Set(py_get(data, "projects", []).map((p: any) => getitem(p, "id"))).has(P3),
    true,
  );
  for (const [coll, rid] of Object.entries(under_p3)) {
    check(`${coll}: row under the RESTORED project is back in export`, back_ids.has(rid), true);
  }

  for (const [coll, rid] of Object.entries(trashed_items)) {
    [s] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, alice, { trashed: "" });
    check(`${coll}: PATCH clearing trashed (restore) → 200`, s, 200);
  }
  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export after restoring the four rows → 200", s, 200);
  const restored_ids = ids_in(py_get(r, "data", {}));
  for (const [coll, rid] of Object.entries(trashed_items)) {
    check(`${coll}: restored row is back in export`, restored_ids.has(rid), true);
  }

  // COVERS: route:POST /api/tracker/export
  // ═════════════ 10. the export carries the WORKSPACE's audit trail, not only its tasks ═══
  // Runs LAST: the transfer moves ownership of A, which every section above depends on.
  console.log("\n── (10) workspace-level activity: the ownership handover row rides the export ──");

  function taskless_activity(data: any): any[] {
    return py_get(data, "task_activity", []).filter((a: any) => !truthy(a.task));
  }

  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export A BEFORE any transfer → 200", s, 200);
  check(
    "before the transfer, A's export carries NO taskless activity row",
    taskless_activity(py_get(r, "data", {})),
    [],
  );
  [s, r] = await export_(carol, { workspace: CAROL_WS });
  check("CONTROL export of C (never transferred) → 200", s, 200);
  check(
    "CONTROL: C's export carries NO taskless activity row",
    taskless_activity(py_get(r, "data", {})),
    [],
  );

  [s] = await api("POST", `/api/tracker/workspaces/${ALICE_WS}/transfer-ownership`, alice, {
    user: bob_id,
  });
  check("alice transfers A's ownership to bob → 200", s, 200);

  [s, r] = await export_(alice, { workspace: ALICE_WS });
  check("export A AFTER the transfer (alice is now an admin member) → 200", s, 200);
  data = py_get(r, "data", {});
  const handover = taskless_activity(data);
  check("A's export now carries exactly one taskless activity row", handover.length, 1);
  const row = handover.length ? handover[0] : {};
  check("the handover row is anchored on the workspace itself", row.workspace, ALICE_WS);
  check("the handover row names alice as its actor", row.actor, alice_id);
  check("the handover row records the owner field", row.field, "owner");
  check(
    "its actor is resolved in the export's users block",
    new Set(py_get(data, "users", []).map((u: any) => getitem(u, "id"))).has(alice_id),
    true,
  );
  const exported_tasks = new Set(py_get(data, "tasks", []).map((t: any) => getitem(t, "id")));
  check(
    "every task-bearing activity row still belongs to an exported task " +
      "(the widened filter did not stop intersecting)",
    new Set(
      [
        ...new Set(
          py_get(data, "task_activity", [])
            .filter((a: any) => truthy(a.task))
            .map((a: any) => getitem(a, "task")),
        ),
      ].filter((id) => !exported_tasks.has(id)),
    ),
    new Set(),
  );

  [s, r] = await export_(carol, { workspace: CAROL_WS });
  check("CONTROL export of C after A's transfer → 200", s, 200);
  check(
    "CONTROL: C still carries NO taskless activity row (A's handover did not leak)",
    taskless_activity(py_get(r, "data", {})),
    [],
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
  console.log("✅ all export proofs passed");
  process.exit(0);
}

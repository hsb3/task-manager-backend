#!/usr/bin/env bun
/**
 * Write hygiene: a padded name/title/comment body is stored trimmed on create and update
 * (names.pb.js, one shared hook), an update that changes nothing answers 400 without leaking
 * existence to a caller the update rule denies, and the export route refuses a malformed
 * `projects` / `collections` selection.
 *
 * Port 8153 + PB_PORT_OFFSET (suite self-boot band, .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate_up } from "../scripts/pb_migrate.ts";
import { decode_text, getitem, py_repr, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8153 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  const tag = ok ? "✅" : "❌ MISMATCH";
  console.log(`  ${tag}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`);
}

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = {};
  if (!(body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body === null ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const raw = new Uint8Array(await r.arrayBuffer());
  try {
    return [r.status, raw.length ? JSON.parse(decode_text(raw)) : {}];
  } catch {
    return [r.status, { _raw: new TextDecoder("utf-8").decode(raw) }];
  }
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  if (!truthy(r.token)) throw new Error(`superuser auth failed: ${py_repr(r)}`);
  return r.token;
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

async function first_id(coll: string, filter: string, token: string): Promise<string | null> {
  const [, r] = await api(
    "GET",
    `/api/collections/${coll}/records?` + urlencode({ filter, perPage: 1 }),
    token,
  );
  return truthy(r.items) && r.items.length ? r.items[0].id : null;
}

// ── Scratch tree ─────────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-write-hygiene-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log("\n══════════ write hygiene room ══════════");
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
  const su = await superuser_token();

  console.log(
    "\n── seed: alice/bob — the users-create hook provisions a workspace, project and user_settings row ──",
  );
  let s: number;
  let r: any;
  for (const [name, email] of [
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
    ["Carol", "carol@example.com"],
    ["Dave", "dave@example.com"],
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
  const [alice, alice_id] = await login("alice@example.com");
  const [bob] = await login("bob@example.com");
  const WS = await first_id("workspaces", `owner='${alice_id}'`, alice);
  const PROJECT = await first_id("projects", `name='My Project' && workspace='${WS}'`, alice);
  const SETTINGS = await first_id("user_settings", `user='${alice_id}'`, alice);
  check("(fixture) resolved alice's workspace", truthy(WS), true);
  check("(fixture) resolved alice's project 'My Project'", truthy(PROJECT), true);
  check("(fixture) resolved alice's user_settings row", truthy(SETTINGS), true);
  const [carol, carol_id] = await login("carol@example.com");
  const [dave, dave_id] = await login("dave@example.com");
  for (const [who, uid, role] of [
    ["carol", carol_id, "member"],
    ["dave", dave_id, "admin"],
  ]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS,
      user: uid,
      role,
      status: "active",
    });
    check(`(fixture) ${who} joins alice's workspace as active ${role}`, s, 200);
  }
  if (failures) throw new roomkit.SystemExit("fixture seeding failed — cannot proceed");

  // ══════════════════ 1. the card's headline probe ══════════════════
  console.log("\n── (1) PATCH a project name with surrounding spaces ──");
  // COVERS: hook:names.pb.js#onRecordUpdateRequest:projects
  [s, r] = await api("PATCH", `/api/collections/projects/records/${PROJECT}`, alice, {
    name: "  Roadmap  ",
  });
  check('PATCH project {"name":"  Roadmap  "} → 200', s, 200);
  [, r] = await api("GET", `/api/collections/projects/records/${PROJECT}`, alice);
  check('read back name == "Roadmap"', r.name, "Roadmap");

  // ══════════════════ 2. trimmed on create AND update, every guarded collection ══════════════════
  console.log("\n── (2) padded name/title/body stored trimmed on create and update ──");
  [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
    project: PROJECT,
    title: "comment host",
  });
  check("(fixture) create a task to comment on → 200", s, 200);
  const HOST_TASK = r.id;
  const TRIM: [string, string, Record<string, any>][] = [
    ["workspaces", "name", { owner: alice_id }],
    ["projects", "name", { workspace: WS, owner: alice_id }],
    ["tasks", "title", { project: PROJECT }],
    ["documents", "title", { workspace: WS }],
    ["decisions", "title", { workspace: WS }],
    ["milestones", "name", { workspace: WS, project: PROJECT }],
    ["saved_views", "name", { workspace: WS, owner: alice_id, scope: "personal" }],
    ["templates", "name", { workspace: WS, type: "task" }],
    ["cycles", "name", { workspace: WS, starts_on: "2026-01-05 00:00:00.000Z" }],
    ["comments", "body", { task: HOST_TASK }],
  ];
  const CREATED: Record<string, string> = {};
  for (const [coll, field, base] of TRIM) {
    // COVERS: hook:names.pb.js#onRecordCreateRequest:<coll> (one shared trim, every collection below)
    [s, r] = await api("POST", `/api/collections/${coll}/records`, alice, {
      ...base,
      [field]: `  ${coll} created \n`,
    });
    check(`${coll}: create with padded ${field} → 200`, s, 200);
    check(`${coll}: created ${field} stored trimmed`, r[field], `${coll} created`);
    CREATED[coll] = r.id;
    [s, r] = await api("PATCH", `/api/collections/${coll}/records/${r.id}`, alice, {
      [field]: `\t ${coll} updated  `,
    });
    check(`${coll}: update with padded ${field} → 200`, s, 200);
    check(`${coll}: updated ${field} stored trimmed`, r[field], `${coll} updated`);
  }
  // COVERS: route:POST /api/tracker/workspaces/{id}/vocab
  [s, r] = await api("POST", `/api/tracker/workspaces/${WS}/vocab`, alice, {
    name: "  Vocab route  ",
  });
  check("vocab route: padded workspace name → 200", s, 200);
  check("vocab route: workspace name stored trimmed", r.name, "Vocab route");
  const MD = "    indented code\n\n- list\n";
  [s, r] = await api("PATCH", `/api/collections/documents/records/${CREATED.documents}`, alice, {
    body: MD,
  });
  check("documents: a markdown body (not required) is stored untouched", r.body, MD);

  // ══════════════════ 3. an update that changes nothing ══════════════════
  console.log("\n── (3) PATCH {} answers 400 naming no changes ──");
  const EMPTY: [string, string][] = [
    ["workspaces", WS!],
    ["projects", PROJECT!],
    ["cycles", CREATED.cycles],
    ["user_settings", SETTINGS!],
    ["tasks", CREATED.tasks],
    ["documents", CREATED.documents],
    ["decisions", CREATED.decisions],
    ["milestones", CREATED.milestones],
  ];
  for (const [coll, id] of EMPTY) {
    // COVERS: hook:names.pb.js#onRecordUpdateRequest:<coll> (refuseEmptyUpdate)
    [s, r] = await api("PATCH", `/api/collections/${coll}/records/${id}`, alice, {});
    console.log(`     ${coll}: PATCH {} → ${s} ${py_repr(r.message)}`);
    check(`${coll}: owner PATCH {} → 400`, s, 400);
    check(`${coll}: message names no changes`, /no changes/i.test(String(r.message)), true);
  }
  [s, r] = await api("PATCH", `/api/collections/projects/records/${PROJECT}`, su, {});
  check("projects: superuser PATCH {} → 400", s, 400);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${CREATED.tasks}`, alice, {
    no_such_field: 1,
  });
  check("tasks: PATCH naming only an unknown key → 400 (no change)", s, 400);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${CREATED.tasks}`, alice, {
    "labels+": [],
  });
  check("tasks: PATCH with a modifier key (labels+) is a change → 200", s, 200);

  console.log("── existence hiding: a caller the update rule denies still gets 404 ──");
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, dave, {});
  check("workspaces: admin dave PATCH {} → 400 (may update, changed nothing)", s, 400);
  [s] = await api("GET", `/api/collections/workspaces/records/${WS}`, carol);
  check("workspaces: plain member carol can VIEW alice's workspace → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, carol, {});
  check("workspaces: plain member carol PATCH {} (update denied) → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, bob, {});
  check("workspaces: non-member bob PATCH {} → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, null, {});
  check("workspaces: anon PATCH {} → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/projects/records/${PROJECT}`, bob, {});
  check("projects: non-member bob PATCH {} on alice's project → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/projects/records/${PROJECT}`, null, {});
  check("projects: anon PATCH {} on alice's project → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/tasks/records/${CREATED.tasks}`, bob, {});
  check("tasks: non-member bob PATCH {} on alice's task → 404", s, 404);

  console.log("── a change that carries no field key still goes through ──");
  const fd = new FormData();
  fd.append(
    "attachments",
    new Blob(["%PDF-1.4\n%âã\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"], {
      type: "application/pdf",
    }),
    "probe.pdf",
  );
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${CREATED.tasks}`, alice, fd);
  check("tasks: multipart PATCH carrying only a file → 200", s, 200);
  check("tasks: the file was attached", Array.isArray(r.attachments) && r.attachments.length, 1);
  [s] = await api(
    "PATCH",
    `/api/collections/tasks/records/${CREATED.tasks}`,
    alice,
    new FormData(),
  );
  check("tasks: empty multipart PATCH → 400", s, 400);
  [s, r] = await api("POST", "/api/batch", alice, {
    requests: [
      {
        method: "PATCH",
        url: `/api/collections/tasks/records/${CREATED.tasks}`,
        body: { move: { at: "start" } },
      },
    ],
  });
  check("tasks: batch PATCH carrying only a move → 200", s, 200);
  check("tasks: the move's inner request → 200", Array.isArray(r) ? r[0]?.status : r, 200);

  // ══════════════════ 4. export selection shape ══════════════════
  console.log("\n── (4) POST /api/tracker/export refuses a malformed selection ──");
  // COVERS: route:POST /api/tracker/export
  [s, r] = await api("POST", "/api/tracker/export", alice, { workspace: WS, projects: "abc" });
  check('export {"projects":"abc"} → 400', s, 400);
  [s, r] = await api("POST", "/api/tracker/export", alice, { workspace: WS, collections: [1] });
  check('export {"collections":[1]} → 400', s, 400);
  [s, r] = await api("POST", "/api/tracker/export", alice, { workspace: WS, projects: [1] });
  check('export {"projects":[1]} → 400', s, 400);
  [s, r] = await api("POST", "/api/tracker/export", alice, { workspace: WS, collections: "tasks" });
  check('export {"collections":"tasks"} → 400', s, 400);
  [s, r] = await api("POST", "/api/tracker/export", alice, {
    workspace: WS,
    projects: [PROJECT],
    collections: ["projects"],
  });
  check("export with valid project + collection arrays → 200", s, 200);
  check("export scope.projects is the selection", r?.scope?.projects, [PROJECT]);
  check("export carries only the selected collection", Object.keys(r?.data ?? {}), ["projects"]);
  [s, r] = await api("POST", "/api/tracker/export", alice, {
    workspace: WS,
    projects: null,
    collections: null,
  });
  check("export with null selections → 200 (null keeps meaning 'all')", s, 200);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — writes are trimmed, empty updates refused, export selections validated");
  process.exit(0);
}

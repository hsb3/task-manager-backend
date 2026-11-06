#!/usr/bin/env bun
/**
 * Prove workspace auto-provisioning (users onRecordAfterCreateSuccess hook),
 * in-app project CRUD rules, and the fleet-wide backfill invariants they uphold.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy. Port 8111 +
 * PB_PORT_OFFSET (the 8100+ suite self-boot band, .agents/rules/ports.md).
 * Creates throwaway users via superuser and cleans them up (cascadeDelete removes their
 * workspaces/projects).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_get,
  py_repr,
  py_str,
  run_checked,
  truthy,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { stop_server } from "./suitekit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8111 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

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
  return [r.status, raw ? JSON.parse(raw) : {}];
}

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (want ${py_str(expected)})`,
  );
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

// Create a throwaway user (superuser create path also fires the hook).
async function make_user(su: string, name: string, approved = true): Promise<[string, any]> {
  const email = `prov-${randomBytes(4).toString("hex")}@example.com`;
  const [, r] = await api("POST", "/api/collections/users/records", su, {
    email,
    password: "test123456",
    passwordConfirm: "test123456",
    name,
    verified: true,
    approved,
  });
  return [email, getitem(r, "id")];
}

async function login(email: string): Promise<[any, any]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-provision-test-"));
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
  const created_user_ids: any[] = [];

  let s: number;
  let r: any;
  let ws: any;
  let w: any;
  let mem: any;
  let proj: any;
  let us: any;

  // COVERS: hook:main.pb.js#onRecordAfterCreateSuccess:users, hook:main.pb.js#onRecordAfterCreateSuccess:workspaces
  console.log("\n── (1) AUTO-PROVISION: hook gives each new user one workspace + membership ──");
  // API-signup path (anonymous create), then approve via superuser so we can log in.
  const signup_email = `prov-signup-${randomBytes(4).toString("hex")}@example.com`;
  [s, r] = await api("POST", "/api/collections/users/records", null, {
    email: signup_email,
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Signup Provision",
  });
  check("anonymous signup create", s, 200);
  const signup_uid = r.id;
  created_user_ids.push(signup_uid);

  [s, ws] = await api(
    "GET",
    `/api/collections/workspaces/records?filter=(owner='${signup_uid}')`,
    su,
  );
  check("signup: exactly 1 workspace auto-provisioned", ws.totalItems, 1);
  if (truthy(ws.items)) {
    w = ws.items[0];
    check("signup: workspace name default", w.name, "My Workspace");
    // statuses/labels are first-class collections seeded by the provision hook.
    const [, sts] = await api(
      "GET",
      `/api/collections/statuses/records?filter=(workspace='${getitem(w, "id")}')`,
      su,
    );
    const st_names = py_get(sts, "items", [])
      .map((i: any) => i.name)
      .sort(by_code_point);
    check("signup: 5 statuses seeded", st_names, [
      "Backlog",
      "Canceled",
      "Done",
      "In Progress",
      "Todo",
    ]);
    const default_st_names = py_get(sts, "items", [])
      .filter((i: any) => truthy(i.is_default))
      .map((i: any) => i.name);
    check("signup: exactly one default status (Backlog)", default_st_names, ["Backlog"]);
    const [, lbs] = await api(
      "GET",
      `/api/collections/labels/records?filter=(workspace='${getitem(w, "id")}')`,
      su,
    );
    const lb_names = py_get(lbs, "items", [])
      .map((i: any) => i.name)
      .sort(by_code_point);
    check("signup: 3 core labels seeded", lb_names, ["Bug", "Feature", "Improvement"]);
    const core_lb_names = py_get(lbs, "items", [])
      .filter((i: any) => truthy(i.core))
      .map((i: any) => i.name)
      .sort(by_code_point);
    check("signup: all 3 seeded labels are core", core_lb_names, ["Bug", "Feature", "Improvement"]);
    check(
      "signup: priorities default",
      (truthy(w.priorities) ? w.priorities : []).map((p: any) =>
        typeof p === "object" && p !== null && !Array.isArray(p) ? p.name : p,
      ),
      ["urgent", "high", "medium", "low"],
    );
  }
  [s, mem] = await api(
    "GET",
    `/api/collections/workspace_members/records?filter=(user='${signup_uid}')`,
    su,
  );
  check("signup: exactly 1 self-membership", mem.totalItems, 1);
  // hook also seeds a default project so the board is never empty on first login.
  const signup_ws_id = truthy(ws.items) ? getitem(ws.items[0], "id") : "";
  // shadow=false (%26%26 is && in a raw query string): decision:shadow-project provisions an invisible
  // container alongside the default project, and it sorts first.
  [s, proj] = await api(
    "GET",
    `/api/collections/projects/records?filter=(workspace='${signup_ws_id}'%26%26shadow=false)`,
    su,
  );
  check("signup: exactly 1 default project auto-provisioned", proj.totalItems, 1);
  let shadow: any;
  [s, shadow] = await api(
    "GET",
    `/api/collections/projects/records?filter=(workspace='${signup_ws_id}'%26%26shadow=true)`,
    su,
  );
  check("signup: exactly 1 shadow project alongside it", shadow.totalItems, 1);
  if (truthy(proj.items)) {
    const dp = proj.items[0];
    check("signup: default project name", dp.name, "My Project");
    check("signup: default project owner is the user", dp.owner, signup_uid);
    // the provision hook points the workspace at its default project.
    check("signup: default_project set to My Project", w.default_project, dp.id);
  }
  // the provision hook also creates the user's 1:1 user_settings row.
  [s, us] = await api(
    "GET",
    `/api/collections/user_settings/records?filter=(user='${signup_uid}')`,
    su,
  );
  check("signup: exactly 1 user_settings row", us.totalItems, 1);

  // Superuser-create path — idempotency: also exactly one (no duplicate).
  const [, su_uid] = await make_user(su, "SU Provision");
  created_user_ids.push(su_uid);
  let ws2: any;
  [s, ws2] = await api("GET", `/api/collections/workspaces/records?filter=(owner='${su_uid}')`, su);
  check("superuser-created user: exactly 1 workspace (idempotent)", ws2.totalItems, 1);
  const su_ws_id = truthy(ws2.items) ? getitem(ws2.items[0], "id") : "";
  let proj2: any;
  [s, proj2] = await api(
    "GET",
    `/api/collections/projects/records?filter=(workspace='${su_ws_id}'%26%26shadow=false)`,
    su,
  );
  check(
    "superuser-created user: exactly 1 non-shadow default project (idempotent)",
    proj2.totalItems,
    1,
  );
  let shadow2: any;
  [s, shadow2] = await api(
    "GET",
    `/api/collections/projects/records?filter=(workspace='${su_ws_id}'%26%26shadow=true)`,
    su,
  );
  check("superuser-created user: exactly 1 shadow project (idempotent)", shadow2.totalItems, 1);
  if (truthy(ws2.items) && truthy(proj2.items)) {
    check(
      "superuser-created user: default_project set to My Project",
      ws2.items[0].default_project,
      proj2.items[0].id,
    );
  }
  let us2: any;
  [s, us2] = await api(
    "GET",
    `/api/collections/user_settings/records?filter=(user='${su_uid}')`,
    su,
  );
  check("superuser-created user: exactly 1 user_settings row", us2.totalItems, 1);

  // COVERS: hook:main.pb.js#onRecordCreateRequest:workspaces
  console.log("\n── (1b) CREATE-TIME GUARD: default_project must belong to the new workspace ──");
  // proj2 belongs to su_ws_id, a DIFFERENT (already-existing) workspace — so it's
  // foreign to any brand-new workspace record regardless of owner.
  [s] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "Foreign Default Project Probe",
    owner: su_uid,
    default_project: getitem(proj2.items[0], "id"),
  });
  check("create workspace with foreign default_project", s, 400);

  // COVERS: rule:projects.create, rule:projects.update, rule:projects.list
  console.log(
    "\n── (2) PROJECT CRUD: owner may create/rename/delete their workspace's projects ──",
  );
  // Approve the signup user and log in as the OWNER.
  await api("PATCH", `/api/collections/users/records/${signup_uid}`, su, {
    verified: true,
    approved: true,
  });
  const [owner_tok, owner_id] = await login(signup_email);
  let owner_ws: any;
  [, owner_ws] = await api("GET", "/api/collections/workspaces/records", owner_tok);
  const owner_ws_id = getitem(owner_ws.items[0], "id");

  [s, proj] = await api("POST", "/api/collections/projects/records", owner_tok, {
    name: "Owner Project",
    owner: owner_id,
    workspace: owner_ws_id,
  });
  check("owner CREATE project", s, 200);
  const proj_id = proj.id;

  [s, r] = await api("PATCH", `/api/collections/projects/records/${proj_id}`, owner_tok, {
    name: "Owner Project (renamed)",
  });
  check("owner RENAME project", s, 200);
  check("rename took effect", r.name, "Owner Project (renamed)");

  let lst: any;
  [s, lst] = await api(
    "GET",
    `/api/collections/projects/records?filter=(workspace='${owner_ws_id}')`,
    owner_tok,
  );
  check(
    "owner LISTS the project",
    py_get(lst, "items", []).some((p: any) => getitem(p, "id") === proj_id),
    true,
  );

  console.log("\n── (2b) NON-OWNER is denied ──");
  // A second user in a DIFFERENT workspace (not a member of the owner's workspace).
  const [other_email, other_id] = await make_user(su, "Other Person");
  created_user_ids.push(other_id);
  const [other_tok] = await login(other_email);

  [s] = await api("POST", "/api/collections/projects/records", other_tok, {
    name: "Spoofed",
    owner: owner_id,
    workspace: owner_ws_id,
  });
  check("non-owner CREATE with spoofed owner", s, 400);

  [s] = await api("PATCH", `/api/collections/projects/records/${proj_id}`, other_tok, {
    name: "hijacked",
  });
  check("non-owner UPDATE another's project", s, 404);

  [s] = await api("DELETE", `/api/collections/projects/records/${proj_id}`, other_tok);
  check("non-owner DELETE another's project", s, 404);

  // COVERS: rule:projects.delete
  console.log("\n── (2c) owner DELETE (204) ──");
  [s] = await api("DELETE", `/api/collections/projects/records/${proj_id}`, owner_tok);
  check("owner DELETE project", s, 204);

  console.log("\n── (3) BACKFILL INVARIANT: every user has a workspace or a membership (#46) ──");
  // the backfill migration heals pre-hook rows at boot only (untestable in-suite);
  // this asserts the invariant it upholds after boot.
  const [, allu] = await api("GET", "/api/collections/users/records?perPage=500", su);
  const dead_ends: any[] = [];
  for (const u of py_get(allu, "items", [])) {
    const uid = getitem(u, "id");
    [, ws] = await api("GET", `/api/collections/workspaces/records?filter=(owner='${uid}')`, su);
    [, mem] = await api(
      "GET",
      `/api/collections/workspace_members/records?filter=(user='${uid}')`,
      su,
    );
    if (
      (truthy(ws.totalItems) ? ws.totalItems : 0) < 1 &&
      (truthy(mem.totalItems) ? mem.totalItems : 0) < 1
    ) {
      dead_ends.push(uid);
    }
  }
  check("no workspace-less user (owned workspace OR membership for all)", dead_ends, []);

  // same invariant for user_settings, reusing the `allu` list above.
  const missing_settings: any[] = [];
  for (const u of py_get(allu, "items", [])) {
    const uid = getitem(u, "id");
    [, us] = await api("GET", `/api/collections/user_settings/records?filter=(user='${uid}')`, su);
    if ((truthy(us.totalItems) ? us.totalItems : 0) < 1) missing_settings.push(uid);
  }
  check("every user has a user_settings row", missing_settings, []);

  console.log("\n── (3b) PROJECT INVARIANT: every workspace has >= 1 project (#57) ──");
  // the backfill migration heals pre-hook (project-less) workspaces at boot only
  // (untestable in-suite); this asserts the invariant it upholds after boot.
  const [, allws] = await api("GET", "/api/collections/workspaces/records?perPage=500", su);
  const empty_boards: any[] = [];
  for (const wk of py_get(allws, "items", [])) {
    const [, p] = await api(
      "GET",
      `/api/collections/projects/records` +
        `?filter=(workspace='${getitem(wk, "id")}'%26%26shadow=false)&perPage=1`,
      su,
    );
    if ((truthy(p.totalItems) ? p.totalItems : 0) < 1) empty_boards.push(getitem(wk, "id"));
  }
  // shadow=false: every workspace now owns an invisible container, so counting ALL projects
  // could never come back empty and the invariant would be unfalsifiable.
  check("no board-less workspace (>= 1 VISIBLE project for all)", empty_boards, []);

  console.log("\n── cleanup: delete throwaway users (cascade removes workspaces/projects) ──");
  for (const uid of created_user_ids) {
    if (truthy(uid)) {
      [s] = await api("DELETE", `/api/collections/users/records/${uid}`, su);
      check(`cleanup user ${uid.slice(0, 8)}`, s, 204);
    }
  }
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log(
  `\n${failures === 0 ? "✅ all provisioning + project-CRUD proofs passed" : `❌ ${failures} FAILED`}`,
);
process.exit(failures ? 1 : 0);

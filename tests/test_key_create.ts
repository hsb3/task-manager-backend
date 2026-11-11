#!/usr/bin/env bun
/**
 * decision:api-key-reach-and-levels: an api_keys create takes a reach (all, workspace, projects),
 * a workspace, projects and the levels manage and own; an incoherent or unreachable choice answers
 * 400 naming its field and stores nothing; reach, workspace and projects are fixed after create;
 * deleting the workspace for good deletes its keys and a project deleted for good drops out.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8214 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8214 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const USERS = "/api/collections/users/records";
const recs = (c: string) => `/api/collections/${c}/records`;

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

async function login(email: string): Promise<[string, string]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  if (s !== 200) throw new roomkit.SystemExit(`login ${email} failed: ${s} ${py_repr(r)}`);
  return [r.token, r.record.id];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-key-create-test-"));
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

  console.log("\n── fixtures: Alice owns WA (PA1, PA2, trashed PA3) and WB; Bob owns WC (PC1) ──");
  for (const name of ["Alice", "Bob", "Carol"]) {
    const [s] = await api("POST", USERS, su, {
      email: `${name.toLowerCase()}@example.com`,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`(fixture) ${name} created`, s, 200);
  }
  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const [carol, carol_id] = await login("carol@example.com");
  const own_ws = async (uid: string): Promise<string> => {
    const [, l] = await api(
      "GET",
      `${recs("workspaces")}?${urlencode({ filter: `owner='${uid}'` })}`,
      su,
    );
    return l.items?.[0]?.id ?? "";
  };
  const WA = await own_ws(alice_id);
  const WC = await own_ws(bob_id);
  let [s, r] = await api("POST", recs("workspaces"), alice, { name: "WB" });
  const WB: string = r.id ?? "";
  check("(fixture) WA, WC provisioned; Alice creates WB", tup(!!WA, !!WC, s), tup(true, true, 200));
  const project = async (token: string, ws: string, name: string): Promise<string> => {
    const [st, p] = await api("POST", recs("projects"), token, { name, workspace: ws });
    check(`(fixture) project ${name} created`, st, 200);
    return p.id ?? "";
  };
  const PA1 = await project(alice, WA, "PA1");
  const PA2 = await project(alice, WA, "PA2");
  const PA3 = await project(alice, WA, "PA3");
  const PC1 = await project(bob, WC, "PC1");
  [s] = await api("DELETE", `${recs("projects")}/${PA3}`, alice);
  check("(fixture) Alice moves PA3 to the trash", s, 204);
  [, r] = await api(
    "GET",
    `${recs("projects")}?${urlencode({ filter: `workspace = '${WA}' && shadow = true` })}`,
    su,
  );
  const SHADOW: string = r.items?.[0]?.id ?? "";
  check("(fixture) WA's hidden container resolved", !!SHADOW, true);
  for (const [uid, who, status] of [
    [bob_id, "Bob", "active"],
    [carol_id, "Carol", "suspended"],
  ]) {
    [s] = await api("POST", recs("workspace_members"), su, {
      workspace: WA,
      user: uid,
      role: "member",
      status,
    });
    check(`(fixture) ${who} is a ${status} member of WA`, s, 200);
  }

  async function stored_named(name: string): Promise<number> {
    const [, l] = await api("GET", `${KEYS}?${urlencode({ filter: `name='${name}'` })}`, su);
    return l.items?.length ?? -1;
  }
  const shape = (rec: any) => tup(rec.reach, rec.workspace, rec.projects);

  console.log("\n── creates that succeed ──");
  [s, r] = await api("POST", KEYS, alice, { name: "k all", scope: "write" });
  check(
    "create without reach → 200, reach all, workspace '', projects []",
    tup(s, ...shape(r)),
    tup(200, "all", "", []),
  );
  [s, r] = await api("POST", KEYS, alice, {
    name: "k ws",
    scope: "write",
    reach: "workspace",
    workspace: WA,
  });
  const WS_KEY = r;
  check(
    "create reach workspace WA → 200, reach workspace, workspace WA",
    tup(s, ...shape(r)),
    tup(200, "workspace", WA, []),
  );
  [s, r] = await api("POST", KEYS, alice, {
    name: "k projects",
    scope: "write",
    reach: "projects",
    workspace: WA,
    projects: [PA1, PA2],
  });
  const PROJECTS_KEY = r;
  check(
    "create reach projects WA [PA1, PA2] write → 200",
    tup(s, r.reach, r.workspace, [...(r.projects ?? [])].sort()),
    tup(200, "projects", WA, [PA1, PA2].sort()),
  );
  for (const scope of ["manage", "own"]) {
    [s, r] = await api("POST", KEYS, alice, { name: `k ${scope}`, scope, reach: "all" });
    check(
      `create scope ${scope} reach all → 200`,
      tup(s, r.scope, r.reach),
      tup(200, scope, "all"),
    );
  }
  [s, r] = await api("POST", KEYS, bob, {
    name: "k bob ws",
    scope: "read",
    reach: "workspace",
    workspace: WA,
  });
  const BOB_WS_KEY = r;
  check("Bob creates reach workspace WA (member) → 200", tup(s, r.workspace), tup(200, WA));

  console.log("\n── creates refused: 400 naming the field, nothing stored ──");
  const refusals: [string, string, any, string, string, string][] = [
    [
      "create reach workspace without workspace → 400 workspace validation_required, nothing stored",
      alice,
      { reach: "workspace" },
      "workspace",
      "validation_required",
      "Choose the workspace this key is limited to.",
    ],
    [
      "create reach all naming WA → 400 workspace key_reach_mismatch",
      alice,
      { reach: "all", workspace: WA },
      "workspace",
      "key_reach_mismatch",
      "A key that reaches every workspace names no workspace or projects.",
    ],
    [
      "create reach workspace with projects → 400 projects key_reach_mismatch",
      alice,
      { reach: "workspace", workspace: WA, projects: [PA1] },
      "projects",
      "key_reach_mismatch",
      "Only a key limited to projects names projects.",
    ],
    [
      "create reach projects with none → 400 projects validation_required",
      alice,
      { reach: "projects", workspace: WA },
      "projects",
      "validation_required",
      "Choose at least one project.",
    ],
    [
      "Alice creates reach workspace WC (Bob's) → 400 workspace key_workspace_unreachable",
      alice,
      { reach: "workspace", workspace: WC },
      "workspace",
      "key_workspace_unreachable",
      "Choose a workspace you belong to.",
    ],
    [
      "Carol creates reach workspace WA (suspended) → 400 key_workspace_unreachable",
      carol,
      { reach: "workspace", workspace: WA },
      "workspace",
      "key_workspace_unreachable",
      "Choose a workspace you belong to.",
    ],
    [
      "create reach projects WA [PC1, a project Bob made in WC] → 400 projects key_project_unreachable",
      alice,
      { reach: "projects", workspace: WA, projects: [PC1] },
      "projects",
      "key_project_unreachable",
      "Each project must be a live project of the chosen workspace.",
    ],
    [
      "create reach projects WA [PA3 trashed] → 400 key_project_unreachable",
      alice,
      { reach: "projects", workspace: WA, projects: [PA3] },
      "projects",
      "key_project_unreachable",
      "Each project must be a live project of the chosen workspace.",
    ],
    [
      "create reach projects WA [WA's hidden container] → 400 key_project_unreachable",
      alice,
      { reach: "projects", workspace: WA, projects: [SHADOW] },
      "projects",
      "key_project_unreachable",
      "Each project must be a live project of the chosen workspace.",
    ],
    [
      "create reach projects scope manage → 400 scope key_level_above_write",
      alice,
      { reach: "projects", workspace: WA, projects: [PA1], scope: "manage" },
      "scope",
      "key_level_above_write",
      "A key limited to projects can only read or write.",
    ],
  ];
  let n = 0;
  for (const [label, token, body, field, code, message] of refusals) {
    const name = `refused ${n++}`;
    [s, r] = await api("POST", KEYS, token, { name, scope: "write", ...body });
    check(
      label,
      tup(
        s,
        r?.message ?? null,
        r?.data?.[field]?.code ?? null,
        r?.data?.[field]?.message ?? null,
        await stored_named(name),
      ),
      tup(400, "The key's reach or level is not valid.", code, message, 0),
    );
  }

  console.log("\n── reach, workspace and projects are fixed after create ──");
  const stored = async (id: string) => shape((await api("GET", `${KEYS}/${id}`, su))[1]);
  for (const [field, value] of [
    ["reach", "all"],
    ["workspace", WB],
    ["projects", [PA1]],
  ] as [string, any][]) {
    const before = await stored(WS_KEY.id);
    [s] = await api("PATCH", `${KEYS}/${WS_KEY.id}`, alice, { [field]: value });
    check(
      `owner PATCH ${field} → 404, unchanged`,
      tup(s, await stored(WS_KEY.id)),
      tup(404, before),
    );
  }

  console.log("\n── deletes for good: a project drops out, a workspace takes its keys ──");
  [s] = await api("DELETE", `${recs("projects")}/${PA2}`, su);
  check("(fixture) superuser deletes PA2 for good", s, 204);
  check(
    "superuser DELETEs PA2 → the projects key's record lists projects [PA1]",
    (await stored(PROJECTS_KEY.id))[2],
    [PA1],
  );
  const whoami = async (key: string) => {
    const [st, x] = await api("GET", "/api/tracker/me", key);
    return tup(st, x?.data?.api_key?.code ?? null);
  };
  check(
    "(control) the WA workspace key authenticates before the delete",
    (await whoami(WS_KEY.key))[0],
    200,
  );
  [s] = await api("DELETE", `${recs("workspaces")}/${WA}`, su);
  check("(fixture) superuser deletes WA for good", s, 204);
  for (const [label, rec] of [
    ["workspace", WS_KEY],
    ["projects", PROJECTS_KEY],
    ["Bob's workspace", BOB_WS_KEY],
  ]) {
    check(
      `superuser DELETEs WA → the ${label} key answers 401 api_key_invalid`,
      await whoami(rec.key),
      tup(401, "api_key_invalid"),
    );
  }
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all key-create proofs passed");
  process.exit(0);
}

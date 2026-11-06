#!/usr/bin/env bun
/**
 * Proof that only DELETE moves a workspace, project or item into the trash (card te4g).
 *
 * (1) A PATCH that sets or re-dates `trashed`, or sets `trashed_by`, is refused 400 on tasks, documents,
 *     decisions, milestones, projects and workspaces, for the owner and an admin alike, through JSON,
 *     multipart form and /api/batch; the row stays as it was.
 * (2) DELETE still trashes, stamping `trashed_by` on items, and a PATCH clearing `trashed` still restores.
 * (3) The owner (and an active admin) still restore a trashed workspace; a superuser write is exempt.
 * (4) Under a trashed workspace, what each role (a suspended admin included) lists of workspace_members
 *     and cycles is printed: the owner and active admins keep the roster and configuration a restore lands back into
 *     (decision:workspace-configuration-freeze), everyone else sees nothing.
 *
 * Self-booting clean room, port 8175 + PB_PORT_OFFSET (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const PORT = 8175 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";
const TS = "2026-01-01 00:00:00.000Z";
const TS2 = "2020-01-01 00:00:00.000Z";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(78)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
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
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : {}];
}

async function form_patch(
  p: string,
  token: string,
  fields: Record<string, string>,
): Promise<number> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(BASE_URL + p, {
    method: "PATCH",
    headers: { Authorization: token },
    body: fd,
  });
  await r.arrayBuffer();
  return r.status;
}

const rec = (coll: string, id = "") => `/api/collections/${coll}/records${id ? `/${id}` : ""}`;

async function su_make(su: string, coll: string, body: any, what: string): Promise<any> {
  const [s, r] = await api("POST", rec(coll), su, body);
  if (s !== 200) throw new roomkit.SystemExit(`fixture ${what}: HTTP ${s} ${py_str(r)}`);
  return r;
}

async function login(email: string): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: PASSWORD,
  });
  return getitem(r, "token");
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-trash-entry-test-"));
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
  const [, sur] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = sur.token;
  if (!truthy(su)) throw new Error(`superuser auth failed: ${py_str(sur)}`);

  console.log(
    "\n── fixtures: Olive owns a workspace; Ada admin, Mia member, Vic viewer, Nora outsider ──",
  );
  const ids: Record<string, string> = {};
  const tok: Record<string, string> = {};
  for (const name of ["Olive", "Ada", "Mia", "Vic", "Nora", "Sue"]) {
    const email = `${name.toLowerCase()}@example.com`;
    const u = await su_make(
      su,
      "users",
      {
        email,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        name,
        verified: true,
        approved: true,
      },
      `user ${name}`,
    );
    ids[name] = u.id;
    tok[name] = await login(email);
  }
  const [, wsl] = await api(
    "GET",
    `${rec("workspaces")}?${urlencode({ filter: `owner='${ids.Olive}'` })}`,
    su,
  );
  const W: string = getitem(wsl.items[0], "id");
  const [, pl] = await api(
    "GET",
    `${rec("projects")}?${urlencode({ filter: `workspace='${W}' && shadow=false` })}`,
    su,
  );
  const PRJ: string = getitem(pl.items[0], "id");
  const [, stl] = await api(
    "GET",
    `${rec("statuses")}?${urlencode({ filter: `workspace='${W}' && name='Todo'` })}`,
    su,
  );
  const TODO: string = getitem(stl.items[0], "id");
  for (const [name, role] of [
    ["Ada", "admin"],
    ["Mia", "member"],
    ["Vic", "viewer"],
  ] as const) {
    await su_make(
      su,
      "workspace_members",
      { workspace: W, user: ids[name], role, status: "active" },
      `${name} membership`,
    );
  }
  await su_make(
    su,
    "workspace_members",
    { workspace: W, user: ids.Sue, role: "admin", status: "suspended" },
    "Sue suspended-admin membership",
  );
  const { Olive: olive, Ada: ada, Mia: mia, Vic: vic, Nora: nora } = tok as Record<string, string>;
  const roles: [string, string][] = [
    ["owner", olive!],
    ["admin", ada!],
    ["member", mia!],
    ["viewer", vic!],
    ["non-member", nora!],
    ["suspended admin", tok.Sue!],
  ];

  const su_get = async (coll: string, id: string) => (await api("GET", rec(coll, id), su))[1];
  const state = async (coll: string, id: string) => {
    const r = await su_get(coll, id);
    return [String(r.trashed ?? ""), String(r.trashed_by ?? "")];
  };

  // ══════════ (1)+(2) items and projects ══════════
  const ITEMS: [string, any][] = [
    ["tasks", { title: "te4g task", status: TODO, project: PRJ }],
    ["documents", { title: "te4g doc", workspace: W, project: PRJ }],
    ["decisions", { title: "te4g decision", workspace: W, project: PRJ }],
    ["milestones", { name: "te4g milestone", workspace: W, project: PRJ }],
  ];
  for (const [coll, body] of ITEMS) {
    console.log(`\n── ${coll}: PATCH cannot trash; DELETE trashes; PATCH clearing restores ──`);
    const [cs, made] = await api("POST", rec(coll), mia, body);
    check(`${coll}: (fixture) Mia creates one`, cs, 200);
    const id: string = made.id;
    for (const [who, t] of [
      ["member", mia!],
      ["admin", ada!],
      ["owner", olive!],
    ] as const) {
      check(
        `${coll}: ${who} PATCH {trashed} on a live row → 400`,
        (await api("PATCH", rec(coll, id), t, { trashed: TS }))[0],
        400,
      );
    }
    check(
      `${coll}: member PATCH {trashed, trashed_by} → 400`,
      (await api("PATCH", rec(coll, id), mia, { trashed: TS, trashed_by: ids.Mia }))[0],
      400,
    );
    check(
      `${coll}: member PATCH {trashed_by: Olive} on a live row → 400`,
      (await api("PATCH", rec(coll, id), mia, { trashed_by: ids.Olive }))[0],
      400,
    );
    check(
      `${coll}: member form-data PATCH trashed → 400`,
      await form_patch(rec(coll, id), mia!, { trashed: TS }),
      400,
    );
    const [bs] = await api("POST", "/api/batch", mia, {
      requests: [{ method: "PATCH", url: rec(coll, id), body: { trashed: TS } }],
    });
    check(`${coll}: member /api/batch PATCH trashed → 400`, bs, 400);
    check(`${coll}: still live after every refused PATCH`, await state(coll, id), ["", ""]);
    check(
      `${coll}: an ordinary edit still saves (PATCH {trashed:""} on a live row)`,
      (await api("PATCH", rec(coll, id), mia, { trashed: "" }))[0],
      200,
    );

    check(`${coll}: member DELETE → 204`, (await api("DELETE", rec(coll, id), mia))[0], 204);
    const [tr, tb] = await state(coll, id);
    check(`${coll}: DELETE stamped trashed`, tr !== "", true);
    check(`${coll}: DELETE stamped trashed_by = Mia`, tb, ids.Mia);
    check(
      `${coll}: owner PATCH re-dating trashed → 400`,
      (await api("PATCH", rec(coll, id), olive, { trashed: TS2 }))[0],
      400,
    );
    check(
      `${coll}: member PATCH {trashed:"", trashed_by: Olive} → 400`,
      (await api("PATCH", rec(coll, id), mia, { trashed: "", trashed_by: ids.Olive }))[0],
      400,
    );
    check(
      `${coll}: member PATCH {trashed_by:""} while it stays trashed → 400`,
      (await api("PATCH", rec(coll, id), mia, { trashed_by: "" }))[0],
      400,
    );
    check(`${coll}: still trashed as DELETE left it`, await state(coll, id), [tr, tb]);
    check(
      `${coll}: member PATCH {trashed:""} restores → 200`,
      (await api("PATCH", rec(coll, id), mia, { trashed: "" }))[0],
      200,
    );
    check(`${coll}: restored`, (await state(coll, id))[0], "");
    check(
      `${coll}: superuser PATCH {trashed} stays allowed → 200`,
      (await api("PATCH", rec(coll, id), su, { trashed: TS }))[0],
      200,
    );
    check(
      `${coll}: superuser PATCH {trashed:""} → 200`,
      (await api("PATCH", rec(coll, id), su, { trashed: "" }))[0],
      200,
    );
  }

  console.log("\n── projects: the same shape (folded) ──");
  const [ps, proj] = await api("POST", rec("projects"), olive, {
    name: "te4g project",
    workspace: W,
  });
  check("projects: (fixture) Olive creates a project", ps, 200);
  for (const [who, t] of [
    ["member", mia!],
    ["admin", ada!],
    ["owner", olive!],
  ] as const) {
    check(
      `projects: ${who} PATCH {trashed} → 400`,
      (await api("PATCH", rec("projects", proj.id), t, { trashed: TS }))[0],
      400,
    );
  }
  check("projects: still live", (await state("projects", proj.id))[0], "");
  check(
    "projects: admin DELETE → 204",
    (await api("DELETE", rec("projects", proj.id), ada))[0],
    204,
  );
  const ptr = (await state("projects", proj.id))[0];
  check("projects: DELETE stamped trashed", ptr !== "", true);
  check(
    "projects: admin PATCH re-dating trashed → 400",
    (await api("PATCH", rec("projects", proj.id), ada, { trashed: TS2 }))[0],
    400,
  );
  check(
    'projects: admin PATCH {trashed:""} restores → 200',
    (await api("PATCH", rec("projects", proj.id), ada, { trashed: "" }))[0],
    200,
  );
  check("projects: restored", (await state("projects", proj.id))[0], "");

  // ══════════ (1)+(3)+(4) the workspace ══════════
  console.log("\n── workspace: PATCH cannot trash it ──");
  const [cys] = await api("POST", rec("cycles"), olive, {
    workspace: W,
    name: "te4g cycle",
    starts_on: "2026-04-01 00:00:00.000Z",
  });
  check("(fixture) Olive creates a cycle", cys, 200);
  let [s, r] = await api("PATCH", rec("workspaces", W), ada, { trashed: TS });
  check(
    "workspace: admin PATCH {trashed: 2026-01-01} is refused (400/403/404)",
    [400, 403, 404].includes(s),
    true,
  );
  console.log(`     (admin PATCH status = ${s}, message = ${py_repr(r.message ?? null)})`);
  check("workspace: still live after the admin's PATCH", (await state("workspaces", W))[0], "");
  check(
    "workspace: owner PATCH {trashed} → 400",
    (await api("PATCH", rec("workspaces", W), olive, { trashed: TS }))[0],
    400,
  );
  check(
    "workspace: member PATCH {trashed} → 404 (no update right at all)",
    (await api("PATCH", rec("workspaces", W), mia, { trashed: TS }))[0],
    404,
  );
  check(
    "workspace: owner form-data PATCH trashed → 400",
    await form_patch(rec("workspaces", W), olive!, { trashed: TS }),
    400,
  );
  check("workspace: still live", (await state("workspaces", W))[0], "");
  check(
    "workspace: owner renames it (ordinary edit) → 200",
    (await api("PATCH", rec("workspaces", W), olive, { name: "Olive WS" }))[0],
    200,
  );
  check(
    "workspace: admin DELETE → 404 (trash is the owner's)",
    (await api("DELETE", rec("workspaces", W), ada))[0],
    404,
  );
  check(
    "workspace: owner DELETE → 204",
    (await api("DELETE", rec("workspaces", W), olive))[0],
    204,
  );
  const wtr = (await state("workspaces", W))[0];
  check("workspace: DELETE stamped trashed", wtr !== "", true);
  check(
    "workspace: owner PATCH re-dating trashed → 400",
    (await api("PATCH", rec("workspaces", W), olive, { trashed: TS2 }))[0],
    400,
  );
  check("workspace: still trashed as DELETE left it", (await state("workspaces", W))[0], wtr);

  console.log("\n── (4) under the trashed workspace, what each role lists ──");
  const [, mall] = await api(
    "GET",
    `${rec("workspace_members")}?${urlencode({ filter: `workspace='${W}'` })}`,
    su,
  );
  const [, call] = await api(
    "GET",
    `${rec("cycles")}?${urlencode({ filter: `workspace='${W}'` })}`,
    su,
  );
  for (const [role, t] of roles) {
    const [ms, ml] = await api(
      "GET",
      `${rec("workspace_members")}?${urlencode({ filter: `workspace='${W}'` })}`,
      t,
    );
    const [cs2, cl] = await api(
      "GET",
      `${rec("cycles")}?${urlencode({ filter: `workspace='${W}'` })}`,
      t,
    );
    const keeps = role === "owner" || role === "admin";
    console.log(
      `     ${role.padEnd(10)} workspace_members: ${ms} ${(ml.items || []).length}/${mall.totalItems} rows · cycles: ${cs2} ${(cl.items || []).length}/${call.totalItems} rows`,
    );
    check(
      `(4) ${role}: workspace_members rows`,
      (ml.items || []).length,
      keeps ? mall.totalItems : 0,
    );
    check(`(4) ${role}: cycles rows`, (cl.items || []).length, keeps ? call.totalItems : 0);
  }
  check("(4) the roster really has rows to hide (4 memberships)", mall.totalItems >= 4, true);

  console.log("\n── (3) restore ──");
  check(
    'workspace: owner PATCH {trashed:""} restores → 200',
    (await api("PATCH", rec("workspaces", W), olive, { trashed: "" }))[0],
    200,
  );
  check(
    "workspace: owner views it again → 200",
    (await api("GET", rec("workspaces", W), olive))[0],
    200,
  );
  check(
    "workspace: owner DELETE again → 204",
    (await api("DELETE", rec("workspaces", W), olive))[0],
    204,
  );
  check(
    'workspace: active admin PATCH {trashed:""} restores → 200',
    (await api("PATCH", rec("workspaces", W), ada, { trashed: "" }))[0],
    200,
  );
  check("workspace: live again", (await state("workspaces", W))[0], "");
  check(
    "workspace: superuser PATCH {trashed} stays allowed → 200",
    (await api("PATCH", rec("workspaces", W), su, { trashed: TS }))[0],
    200,
  );
  check(
    "workspace: owner restores the superuser's trash → 200",
    (await api("PATCH", rec("workspaces", W), olive, { trashed: "" }))[0],
    200,
  );
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all trash-entry proofs passed");
  process.exit(0);
}

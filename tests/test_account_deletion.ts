#!/usr/bin/env bun
/**
 * Proof that a sole owner blocked from deleting their account is told a remedy that works.
 *
 * The guard refuses a sole owner's self-delete while a workspace they own still has other members.
 * Both remedies it used to name — hand the workspace over, or remove the other members — are
 * themselves refused while that workspace sits in the trash, so the refusal has to name restoring
 * it first. This suite walks the whole way out: refuse → restore → remove the member → the account
 * deletes. Then (4)-(5): an account delete leaves the projects, items and shared views it made
 * in someone else's workspace, before and after a workspace hand-over (kata bwpj).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures built by name.
 * Port 8110 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  py_get,
  py_repr,
  py_rstrip,
  py_str,
  run_checked,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8110 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";

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
  let r: Response;
  let raw: string;
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

/** PB capitalizes and period-terminates a hook message on the wire (pb-wire-message
 * normalization) — compare the text the caller actually reads, case-insensitively. */
function wire(body: any): string {
  return py_rstrip(py_str(py_get(body, "message", "")), ".").toLowerCase();
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(
    PORT,
    data_dir,
    migrations_dir,
    roomkit.hooks_dir(S),
    path.join(S, "pb_serve.log"),
    undefined,
    30,
  );
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc !== null) await roomkit.stop(proc);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-account-deletion-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log("═══════ test_account_deletion.ts — the self-delete refusal names a way out ═══════");
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
  let s: number, r: any;
  [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = roomkit.token_of(BASE_URL, SU_EMAIL, r);

  console.log(
    "\n── fixtures: an owner with one shared workspace, plus the member who shares it ──",
  );

  async function make_user(name: string, email: string): Promise<[string, string]> {
    const [s, rec] = await api("POST", "/api/collections/users/records", su, {
      email: email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name: name,
      verified: true,
      approved: true,
    });
    if (s !== 200 && s !== 201) {
      throw new roomkit.SystemExit(
        `❌ fixture user ${email} not created: HTTP ${s} ${py_str(rec)}`,
      );
    }
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    return [roomkit.token_of(BASE_URL, email, auth), getitem(rec, "id")];
  }

  const [tess, tess_id] = await make_user("Tess", "tess@example.com");
  const [toby, toby_id] = await make_user("Toby", "toby@example.com");

  async function owned_workspace(owner_id: string): Promise<any> {
    const qs = urlencode({ filter: `owner='${owner_id}'`, perPage: 50 });
    const [, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, su);
    return (r.items || [])[0];
  }

  const WS = getitem(await owned_workspace(tess_id), "id");
  check("Tess owns her auto-provisioned workspace", truthy(WS), true);
  let mem: any;
  [s, mem] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: WS,
    user: toby_id,
    role: "member",
    status: "active",
  });
  check("Toby joins it as an active member", s, 200);
  const MEMBER_ROW = getitem(mem, "id");

  // ══════════ (1) live workspace: the refusal names the two remedies that work ══
  console.log("\n── (1) a live shared workspace: the two remedies it names are open ──");
  [s, r] = await api("DELETE", `/api/collections/users/records/${tess_id}`, tess);
  check("Tess cannot delete her account while she is the sole owner", s, 400);
  check(
    "and the refusal names handing it over or removing the others",
    wire(r),
    "cannot delete account: you are the sole owner of a workspace that has other " +
      "members — transfer ownership or remove the other members first",
  );

  // ══════════ (2) trashed workspace: BOTH of those remedies are refused ═════════
  console.log("\n── (2) the same workspace in the trash: both of those remedies are refused ──");
  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, tess);
  check("Tess puts the workspace in the trash (DELETE)", s, 204);
  check(
    "handing it over is refused while it sits there",
    (
      await api("POST", `/api/tracker/workspaces/${WS}/transfer-ownership`, tess, {
        user: toby_id,
      })
    )[0],
    400,
  );
  check(
    "removing the other member is refused while it sits there",
    (await api("DELETE", `/api/collections/workspace_members/records/${MEMBER_ROW}`, tess))[0],
    404,
  );
  [s, r] = await api("DELETE", `/api/collections/users/records/${tess_id}`, tess);
  check("her account delete is still refused", s, 400);
  check(
    "and the refusal now names the step that reopens them",
    wire(r),
    "cannot delete account: you are the sole owner of a workspace in the trash that " +
      "has other members — restore it first, then hand it to someone else or remove " +
      "the other members",
  );
  check(
    "the account survived the refusal",
    (await api("GET", `/api/collections/users/records/${tess_id}`, su))[0],
    200,
  );

  // ══════════ (3) the named way out, walked end to end ═════════════════════════
  console.log("\n── (3) restore → remove the member → the account deletes ──");
  check(
    "Tess restores the workspace, exactly as the refusal told her to",
    (await api("PATCH", `/api/collections/workspaces/records/${WS}`, tess, { trashed: "" }))[0],
    200,
  );
  check(
    "removing the other member now works",
    (await api("DELETE", `/api/collections/workspace_members/records/${MEMBER_ROW}`, tess))[0],
    204,
  );
  check(
    "and her account deletes",
    (await api("DELETE", `/api/collections/users/records/${tess_id}`, tess))[0],
    204,
  );
  check(
    "the account really is gone",
    (await api("GET", `/api/collections/users/records/${tess_id}`, su))[0],
    404,
  );
  check(
    "Toby's own account is untouched",
    (await api("GET", `/api/collections/users/records/${toby_id}`, toby))[0],
    200,
  );

  // ══════════ (4) a member's delete leaves the shared work they made (kata bwpj) ══
  console.log(
    "\n── (4) Ari leaves: her project, its items and her shared view stay with the team ──",
  );
  const [bea, bea_id] = await make_user("Bea", "bea@example.com");
  const [ari, ari_id] = await make_user("Ari", "ari@example.com");
  const [cy, cy_id] = await make_user("Cy", "cy@example.com");
  const BWS = getitem(await owned_workspace(bea_id), "id");
  for (const uid of [ari_id, cy_id]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: BWS,
      user: uid,
      role: "member",
      status: "active",
    });
    check("(fixture) an active member joins Bea's workspace", s, 200);
  }
  let rec: any;
  [s, rec] = await api("POST", "/api/collections/projects/records", ari, {
    name: "Ari's shared project",
    workspace: BWS,
  });
  check("(fixture) Ari creates a project in Bea's workspace", s, 200);
  check("(fixture) and she is its owner", rec.owner ?? null, ari_id);
  const PROJ = getitem(rec, "id");
  const ari_items: [string, string][] = [];
  for (const [coll, body] of [
    ["tasks", { title: "ari-task" }],
    ["documents", { title: "ari-document" }],
    ["decisions", { title: "ari-decision", status: "proposed" }],
    ["milestones", { name: "ari-milestone" }],
  ] as [string, Record<string, any>][]) {
    [s, rec] = await api("POST", `/api/collections/${coll}/records`, ari, {
      ...body,
      workspace: BWS,
      project: PROJ,
    });
    check(`(fixture) Ari adds a ${coll} record to it`, s, 200);
    ari_items.push([coll, rec.id ?? ""]);
  }
  const views: Record<string, string> = {};
  for (const scope of ["workspace", "personal"]) {
    [s, rec] = await api("POST", "/api/collections/saved_views/records", ari, {
      name: `ari-${scope}-view`,
      workspace: BWS,
      scope,
    });
    check(`(fixture) Ari saves a ${scope} view there`, s, 200);
    views[scope] = rec.id ?? "";
  }
  [s, rec] = await api("POST", "/api/collections/saved_views/records", su, {
    name: "su-ownerless-personal",
    workspace: BWS,
    scope: "personal",
    owner: "",
  });
  check("(fixture) a superuser saves an ownerless personal view", s, 200);
  const stray = rec.id ?? "";
  async function listed_views(token: string): Promise<string[]> {
    const qs = urlencode({ filter: `workspace='${BWS}'`, perPage: 200 });
    const [, r] = await api("GET", `/api/collections/saved_views/records?${qs}`, token);
    return (r.items || []).map((v: any) => v.id);
  }
  check(
    "(fixture) Cy lists Ari's shared view before she leaves",
    (await listed_views(cy)).includes(views.workspace),
    true,
  );

  [s] = await api("DELETE", `/api/collections/users/records/${ari_id}`, ari);
  check("D1: Ari deletes her own account", s, 204);
  check(
    "D1: her account really is gone",
    (await api("GET", `/api/collections/users/records/${ari_id}`, su))[0],
    404,
  );
  check(
    "D1: Bea still reads the project Ari created",
    (await api("GET", `/api/collections/projects/records/${PROJ}`, bea))[0],
    200,
  );
  check(
    "D1: the project's owner is empty, not a dangling id",
    (await api("GET", `/api/collections/projects/records/${PROJ}`, su))[1].owner ?? null,
    "",
  );
  for (const [coll, id] of ari_items) {
    check(
      `D1: Bea still reads Ari's ${coll} record`,
      (await api("GET", `/api/collections/${coll}/records/${id}`, bea))[0],
      200,
    );
  }
  check(
    "D4: Bea still lists Ari's shared view",
    (await listed_views(bea)).includes(views.workspace),
    true,
  );
  check("D4: so does Cy, a plain member", (await listed_views(cy)).includes(views.workspace), true);
  check(
    "D4: Ari's personal view, which only she could reach, is deleted",
    (await api("GET", `/api/collections/saved_views/records/${views.personal}`, su))[0],
    404,
  );
  check(
    "D4: a superuser's ownerless personal view survives Ari's delete",
    (await api("GET", `/api/collections/saved_views/records/${stray}`, su))[0],
    200,
  );

  // ══════════ (5) after a hand-over, the old owner's delete keeps the shadow project ══
  console.log(
    "\n── (5) Bea hands her workspace to Cy, then leaves: the project-less items stay ──",
  );
  const loose: [string, string][] = [];
  for (const [coll, body] of [
    ["tasks", { title: "bea-loose-task" }],
    ["documents", { title: "bea-loose-document" }],
    ["decisions", { title: "bea-loose-decision", status: "proposed" }],
    ["milestones", { name: "bea-loose-milestone" }],
  ] as [string, Record<string, any>][]) {
    [s, rec] = await api("POST", `/api/collections/${coll}/records`, bea, {
      ...body,
      workspace: BWS,
    });
    check(`(fixture) Bea adds a project-less ${coll} record`, s, 200);
    loose.push([coll, rec.id ?? ""]);
  }
  const shadow_qs = urlencode({ filter: `workspace='${BWS}' && shadow=true`, perPage: 50 });
  const [, shadows] = await api("GET", `/api/collections/projects/records?${shadow_qs}`, su);
  check("(fixture) the workspace has one shadow project", (shadows.items || []).length, 1);
  const SHADOW = getitem((shadows.items || [])[0] || {}, "id");
  check("(fixture) and Bea owns it", (shadows.items || [])[0]?.owner ?? null, bea_id);
  const mine_qs = urlencode({ filter: `workspace='${BWS}' && shadow=false && owner='${bea_id}'` });
  const [, mine] = await api("GET", `/api/collections/projects/records?${mine_qs}`, su);
  check("(fixture) Bea owns one ordinary project there", (mine.items || []).length, 1);
  const BEA_PROJ = getitem((mine.items || [])[0] || {}, "id");
  [s, rec] = await api("POST", `/api/tracker/workspaces/${BWS}/transfer-ownership`, bea, {
    user: cy_id,
  });
  check("(fixture) Bea hands the workspace to Cy", s, 200);
  check(
    "(fixture) Cy owns it now",
    (await api("GET", `/api/collections/workspaces/records/${BWS}`, su))[1].owner ?? null,
    cy_id,
  );
  check(
    "(fixture) the shadow project's owner followed the hand-over to Cy",
    (await api("GET", `/api/collections/projects/records/${SHADOW}`, su))[1].owner ?? null,
    cy_id,
  );
  [s] = await api("DELETE", `/api/collections/users/records/${bea_id}`, bea);
  check("D2: Bea deletes her account", s, 204);
  check(
    "D2: the shadow project survives",
    (await api("GET", `/api/collections/projects/records/${SHADOW}`, su))[0],
    200,
  );
  for (const [coll, id] of loose) {
    check(
      `D2: Cy still reads Bea's project-less ${coll} record`,
      (await api("GET", `/api/collections/${coll}/records/${id}`, cy))[0],
      200,
    );
  }
  check(
    "D2: Bea's ordinary project survives too",
    (await api("GET", `/api/collections/projects/records/${BEA_PROJ}`, cy))[0],
    200,
  );

  console.log("\n" + "═".repeat(90));
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ all account-deletion proofs passed");
process.exit(0);

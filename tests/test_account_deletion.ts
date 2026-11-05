#!/usr/bin/env bun
/**
 * Proof that a sole owner blocked from deleting their account is told a remedy that works.
 *
 * The guard refuses a sole owner's self-delete while a workspace they own still has other members.
 * Both remedies it used to name — hand the workspace over, or remove the other members — are
 * themselves refused while that workspace sits in the trash, so the refusal has to name restoring
 * it first. This suite walks the whole way out: refuse → restore → remove the member → the account
 * deletes.
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

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8110 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";
const TRASH_TS = "2026-09-08 00:00:00.000Z"; // PocketBase date wire format, not ISO with a T

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
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
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
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, tess, {
    trashed: TRASH_TS,
  });
  check("Tess puts the workspace in the trash", s, 200);
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

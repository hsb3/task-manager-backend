#!/usr/bin/env bun
/**
 * An admin's list of a workspace's sent invitations carries the same expires_at and expired the invitee's own route reports, computed in one place in pb_hooks.
 *
 * Port 8185 + PB_PORT_OFFSET.
 */

// COVERS: route:GET /api/tracker/invitations/mine
// COVERS: rule:workspace_invitations.list

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  py_repr,
  py_str,
  run_checked,
  sqlite_connect,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const HOOKS_SRC = path.join(REPO_ROOT, "pb_hooks");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8185 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const INVITATIONS = "/api/collections/workspace_invitations/records";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(78)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
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
  let r: Response;
  try {
    r = await fetch(BASE_URL + p, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

// ── §static: the expiry instant has one definition in pb_hooks, and both reads use it ──
console.log("\n── the expiry instant is defined once ──");
const hookFiles: string[] = [];
const walk = (dir: string): void => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith(".js")) hookFiles.push(p);
  }
};
walk(HOOKS_SRC);
const sitesOf = (re: RegExp): string[] =>
  hookFiles
    .filter((f) => re.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(HOOKS_SRC, f))
    .sort();
const LIB = "lib/invitations.js";
check(
  'the "invitation_expiry_days" setting is read in one file',
  sitesOf(/["']invitation_expiry_days["']/),
  [LIB],
);
check("days are turned into an instant in one file", sitesOf(/days\)?\s*\*\s*86400000/), [LIB]);
const invitationsSrc = fs.readFileSync(path.join(HOOKS_SRC, "invitations.pb.js"), "utf8");
const usesLib = (start: RegExp): boolean => {
  const at = invitationsSrc.search(start);
  if (at === -1) return false;
  const next = invitationsSrc.slice(at + 1).search(/\n(routerAdd|on[A-Z]\w*)\(/);
  const body = invitationsSrc.slice(at, next === -1 ? undefined : at + 1 + next);
  return body.includes(`/${LIB}\`)`);
};
check(
  "the invitee's /mine read uses it",
  usesLib(/routerAdd\(\s*"GET",\s*"\/api\/tracker\/invitations\/mine"/),
  true,
);
check("the collection read (onRecordEnrich) uses it", usesLib(/\nonRecordEnrich\(/), true);

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-invitation-expiry-list-test-"));
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
  const su = sur.token;
  if (!truthy(su)) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(sur)}`);

  const mkuser = async (tag: string): Promise<[string, string]> => {
    const [s, u] = await api("POST", "/api/collections/users/records", su, {
      email: `expiry-${tag}@example.test`,
      password: "test123456",
      passwordConfirm: "test123456",
      name: tag,
      verified: true,
      approved: true,
    });
    if (s !== 200) throw new roomkit.SystemExit(`mkuser(${tag}) failed: ${s} ${py_str(u)}`);
    const [is, ir] = await api("POST", `/api/collections/users/impersonate/${u.id}`, su, {});
    if (is !== 200) throw new roomkit.SystemExit(`impersonate(${tag}) failed: ${py_str(ir)}`);
    return [u.id, getitem(ir, "token")];
  };

  console.log("\n── fixtures ──");
  const [, OWNER] = await mkuser("owner");
  const [admin_id, ADMIN] = await mkuser("admin");
  const [, FRESH] = await mkuser("fresh");
  const [, STALE] = await mkuser("stale");
  const [ws_s, ws] = await api("POST", "/api/collections/workspaces/records", OWNER, {
    name: "Expiry list",
  });
  check("(fixture) owner creates a workspace", ws_s, 200);
  const [m_s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ws.id,
    user: admin_id,
    role: "admin",
    status: "active",
  });
  check("(fixture) an active admin row", m_s, 200);
  const invite = async (tag: string): Promise<string> => {
    const [s, r] = await api("POST", INVITATIONS, OWNER, {
      workspace: ws.id,
      email: `expiry-${tag}@example.test`,
      role: "member",
    });
    if (s !== 200) throw new roomkit.SystemExit(`invite(${tag}) failed: ${s} ${py_str(r)}`);
    return r.id;
  };
  const fresh_inv = await invite("fresh");
  const stale_inv = await invite("stale");
  // Past the default 7-day window by a day; the fresh one is inside it.
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, ".000Z");
  const con = sqlite_connect(path.join(DATA_DIR, "data.db"));
  con.run("UPDATE workspace_invitations SET created = ? WHERE id = ?", [eightDaysAgo, stale_inv]);
  con.close();

  console.log("\n── an admin lists the workspace's sent invitations ──");
  const [ls, lr] = await api(
    "GET",
    `${INVITATIONS}?${urlencode({ filter: `workspace='${ws.id}'`, sort: "created" })}`,
    ADMIN,
  );
  check("admin list → 200 with both invitations", [ls, (lr.items ?? []).length], [200, 2]);
  const listed: Record<string, any> = {};
  for (const it of lr.items ?? []) listed[it.id] = it;
  for (const [label, id] of [
    ["fresh", fresh_inv],
    ["stale", stale_inv],
  ] as const) {
    const row = listed[id] ?? {};
    check(
      `${label} row carries expires_at and expired`,
      ["expires_at" in row, "expired" in row],
      [true, true],
    );
  }
  check("the stale invitation reads expired: true", listed[stale_inv]?.expired, true);
  check("the fresh invitation reads expired: false", listed[fresh_inv]?.expired, false);

  console.log("\n── the admin's list matches what each invitee's /mine reports ──");
  for (const [label, tok, id] of [
    ["fresh", FRESH, fresh_inv],
    ["stale", STALE, stale_inv],
  ] as const) {
    const [ms, mr] = await api("GET", "/api/tracker/invitations/mine", tok);
    const mine = (mr.items ?? []).find((i: any) => i.id === id) ?? {};
    const row = listed[id] ?? {};
    console.log(
      `     ${label}: list ${py_repr([row.expires_at, row.expired])} · mine ${py_repr([mine.expires_at, mine.expired])}`,
    );
    check(
      `${label}: list and /mine agree on expires_at and expired`,
      [ms, row.expires_at, row.expired],
      [200, mine.expires_at, mine.expired],
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
  console.log("✅ all invitation-expiry-list proofs passed");
  process.exit(0);
}

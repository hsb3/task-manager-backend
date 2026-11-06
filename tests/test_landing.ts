#!/usr/bin/env bun
/**
 * Where a signed-in user lands (owned, then active membership, then a live invitation, then the suspended fallback) and whether they may switch to a named workspace.
 *
 * Port 8186 + PB_PORT_OFFSET.
 */

// COVERS: route:GET /api/tracker/me/landing
// COVERS: route:GET /api/tracker/workspaces/{id}/switch

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

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8186 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const MEMBERS = "/api/collections/workspace_members/records";
const INVITATIONS = "/api/collections/workspace_invitations/records";
const LANDING = "/api/tracker/me/landing";
const SWITCH = (ws: string) => `/api/tracker/workspaces/${ws}/switch`;

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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-landing-test-"));
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

  const fixture = (label: string, s: number, want: number, r: any): void => {
    check(`(fixture) ${label}`, s, want);
    if (s !== want) throw new roomkit.SystemExit(`fixture failed: ${label}: ${py_str(r)}`);
  };
  const emailOf = (tag: string) => `landing-${tag}@example.test`;
  // Returns [user id, token, the auto-provisioned workspace id].
  const mkuser = async (tag: string): Promise<[string, string, string]> => {
    const [s, u] = await api("POST", "/api/collections/users/records", su, {
      email: emailOf(tag),
      password: "test123456",
      passwordConfirm: "test123456",
      name: tag,
      verified: true,
      approved: true,
    });
    fixture(`create user ${tag}`, s, 200, u);
    const [is, ir] = await api("POST", `/api/collections/users/impersonate/${u.id}`, su, {});
    fixture(`impersonate ${tag}`, is, 200, ir);
    const [, wl] = await api(
      "GET",
      `/api/collections/workspaces/records?${urlencode({ filter: `owner='${u.id}'` })}`,
      su,
    );
    if ((wl.items ?? []).length !== 1)
      throw new roomkit.SystemExit(`user ${tag}: expected one auto workspace, got ${py_str(wl)}`);
    return [u.id, getitem(ir, "token"), wl.items[0].id];
  };
  const rowOf = async (ws: string, user: string): Promise<string> => {
    const [, r] = await api(
      "GET",
      `${MEMBERS}?${urlencode({ filter: `workspace='${ws}' && user='${user}'` })}`,
      su,
    );
    return r.items?.[0]?.id ?? "";
  };
  const addMember = async (ws: string, user: string, status: string, label: string) => {
    const [s, r] = await api("POST", MEMBERS, su, { workspace: ws, user, role: "member", status });
    fixture(label, s, 200, r);
  };
  const invite = async (ws: string, ownerTok: string, tag: string): Promise<string> => {
    const [s, r] = await api("POST", INVITATIONS, ownerTok, {
      workspace: ws,
      email: emailOf(tag),
      role: "member",
    });
    fixture(`invite ${tag}`, s, 200, r);
    return r.id;
  };

  console.log("\n── fixtures ──");
  const [hId, H, HWS] = await mkuser("helper");
  // Gives a user's auto workspace to the helper through the real transfer route; the former
  // owner keeps an active admin row there, which each case then deletes, suspends or keeps.
  const giveAway = async (tok: string, ws: string, tag: string): Promise<string> => {
    const [ms, mr] = await api("POST", MEMBERS, su, {
      workspace: ws,
      user: hId,
      role: "admin",
      status: "active",
    });
    fixture(`helper joins ${tag}'s workspace`, ms, 200, mr);
    const [ts, tr] = await api("POST", `/api/tracker/workspaces/${ws}/transfer-ownership`, tok, {
      user: hId,
    });
    fixture(`${tag} transfers their workspace to helper`, ts, 200, tr);
    return ws;
  };
  const dropRow = async (ws: string, user: string, tag: string) => {
    const [s, r] = await api("DELETE", `${MEMBERS}/${await rowOf(ws, user)}`, su);
    fixture(`${tag}'s leftover membership removed`, s, 204, r);
  };
  const suspendRow = async (ws: string, user: string, tag: string) => {
    const [s, r] = await api("PATCH", `${MEMBERS}/${await rowOf(ws, user)}`, su, {
      status: "suspended",
    });
    fixture(`${tag}'s leftover membership suspended`, s, 200, r);
  };

  // owner + member: owns OWS, active member of HWS.
  const [oId, O, OWS] = await mkuser("owner");
  await addMember(HWS, oId, "active", "owner is also an active member of helper's workspace");

  // member-only: an earlier suspended row (former own workspace) and a later active row on HWS.
  const [mId, M, MWS] = await mkuser("member");
  await giveAway(M, MWS, "member");
  await suspendRow(MWS, mId, "member");
  await addMember(HWS, mId, "active", "member-only user gets an active row on helper's workspace");

  // invited-only: no rows; an invitation to a workspace later trashed, then one to HWS.
  const [iId, I, IWS] = await mkuser("invited");
  await giveAway(I, IWS, "invited");
  await dropRow(IWS, iId, "invited");

  // trashed owner: owns two; the older is trashed.
  const [, T, TWS_OLD] = await mkuser("trasher");
  const [ns, nw] = await api("POST", "/api/collections/workspaces/records", T, {
    name: "Trasher second",
  });
  fixture("trasher creates a second workspace", ns, 200, nw);
  const TWS_NEW = nw.id;
  const invTrashed = await invite(TWS_OLD, T, "invited");
  const [ds, dr] = await api("DELETE", `/api/collections/workspaces/records/${TWS_OLD}`, T);
  fixture("trasher trashes the older workspace", ds, 204, dr);
  const [vs, vr] = await api("GET", `${INVITATIONS}/${invTrashed}`, su);
  fixture("the invitation to the trashed workspace still exists", vs, 200, vr);
  const invLive = await invite(HWS, H, "invited");

  // suspended-only: the only row is suspended.
  const [sId, SU, SWS] = await mkuser("suspended");
  await giveAway(SU, SWS, "suspended");
  await suspendRow(SWS, sId, "suspended");

  // expired-only: a suspended row and an invitation past its window.
  const [xId, X, XWS] = await mkuser("expired");
  await giveAway(X, XWS, "expired");
  await suspendRow(XWS, xId, "expired");
  const invExpired = await invite(HWS, H, "expired");

  // re-invited while suspended: accepting leaves a suspended row as it is, so the invitation is no way back in.
  const [rId, R, RWS] = await mkuser("readmit");
  await giveAway(R, RWS, "readmit");
  await suspendRow(RWS, rId, "readmit");
  const invReadmit = await invite(RWS, H, "readmit");

  // blank status: the only row has an empty stored status, which reads as active.
  const [bId, B, BWS] = await mkuser("blank");
  await giveAway(B, BWS, "blank");

  // nothing: no rows, no invitations.
  const [nId, N, NWS] = await mkuser("nothing");
  await giveAway(N, NWS, "nothing");
  await dropRow(NWS, nId, "nothing");

  const eightDaysAgo = new Date(Date.now() - 8 * 86400000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, ".000Z");
  const con = sqlite_connect(path.join(DATA_DIR, "data.db"));
  con.run("UPDATE workspace_invitations SET created = ? WHERE id = ?", [eightDaysAgo, invExpired]);
  con.run("UPDATE workspace_members SET status = '' WHERE workspace = ? AND user = ?", [BWS, bId]);
  con.close();

  console.log("\n── landing order ──");
  const land = async (tok: string | null): Promise<[number, any]> => {
    const [s, r] = await api("GET", LANDING, tok);
    return [s, s === 200 ? (r.landing === undefined ? "field absent" : r.landing) : null];
  };
  const at = (workspace: string, reason: string, invitation: string | null = null) => ({
    workspace,
    reason,
    invitation,
  });
  const LANDINGS: [string, string, any][] = [
    ["owner who is also an active member → the owned workspace", O, at(OWS, "owned")],
    [
      "member-only (earlier suspended row, later active row) → the active membership",
      M,
      at(HWS, "member"),
    ],
    [
      "invited-only (earlier invitation to a trashed workspace) → the live invitation",
      I,
      at(HWS, "invitation", invLive),
    ],
    ["suspended-only → the suspended fallback", SU, at(SWS, "suspended")],
    ["owner of two, older trashed → the newer owned workspace", T, at(TWS_NEW, "owned")],
    ["expired invitation + suspended row → suspended, not the invitation", X, at(XWS, "suspended")],
    [
      "suspended member re-invited to the same workspace → suspended, not the invitation",
      R,
      at(RWS, "suspended"),
    ],
    ["only row has an empty stored status → reads as an active membership", B, at(BWS, "member")],
    ["nothing at all → null", N, null],
  ];
  for (const [label, tok, want] of LANDINGS) check(label, await land(tok), [200, want]);
  check("anon → 401", (await land(null))[0], 401);
  check("superuser → 403", (await land(su))[0], 403);

  console.log("\n── switch check ──");
  const sw = async (tok: string | null, ws: string): Promise<[number, any]> => {
    const [s, r] = await api("GET", SWITCH(ws), tok);
    return [s, s === 200 ? r : null];
  };
  const verdict = (
    workspace: string,
    allowed: boolean,
    reason: string | null,
    invitation: any = null,
  ) => [200, { workspace, allowed, reason, invitation }];
  const NOPE = "zzzzzzzzzzzzzzz";
  const SWITCHES: [string, string, string, any][] = [
    ["owner → allowed", O, OWS, verdict(OWS, true, null)],
    ["active member → allowed", O, HWS, verdict(HWS, true, null)],
    ["empty stored status → allowed", B, BWS, verdict(BWS, true, null)],
    ["suspended member → suspended", SU, SWS, verdict(SWS, false, "suspended")],
    ["stranger's workspace → not_found, no invitation", M, OWS, verdict(OWS, false, "not_found")],
    ["nonexistent id → not_found", O, NOPE, verdict(NOPE, false, "not_found")],
    ["owner's own trashed workspace → not_found", T, TWS_OLD, verdict(TWS_OLD, false, "not_found")],
    [
      "trashed workspace the caller was invited to → not_found, invitation null",
      I,
      TWS_OLD,
      verdict(TWS_OLD, false, "not_found"),
    ],
    [
      "refused workspace with a pending invitation → not_found + that invitation",
      I,
      HWS,
      verdict(HWS, false, "not_found", { id: invLive, expired: false }),
    ],
    [
      "refused workspace with an expired invitation → not_found + it, expired",
      X,
      HWS,
      verdict(HWS, false, "not_found", { id: invExpired, expired: true }),
    ],
    [
      "suspended row and an invitation to elsewhere → suspended, no invitation",
      X,
      XWS,
      verdict(XWS, false, "suspended"),
    ],
    [
      "suspended member with an invitation to the same workspace → suspended, no invitation",
      R,
      RWS,
      verdict(RWS, false, "suspended"),
    ],
  ];
  for (const [label, tok, ws, want] of SWITCHES) check(label, await sw(tok, ws), want);
  check("anon → 401", (await sw(null, OWS))[0], 401);
  check("superuser → 403", (await sw(su, OWS))[0], 403);
  check(
    "(fixture) the re-invitation still exists",
    (await api("GET", `${INVITATIONS}/${invReadmit}`, su))[0],
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
  console.log("✅ all landing and switch proofs passed");
  process.exit(0);
}

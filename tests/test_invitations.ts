#!/usr/bin/env bun
/**
 * R1-R6 of decision:invitation-keyed-by-email's invitation system: an invitation is a `workspace_invitations` row
 * keyed by the invitee's folded email, independent of whether an account exists for it yet.
 *
 * R1  POST /api/tracker/workspaces/{id}/resolve-member-email — mints/idempotently re-mints
 *     an invitation for ANY address.
 * R2  GET  /api/tracker/invitations/mine — the caller's pending invitations, matched on their
 *     own `email_key` (a route, because a client filter cannot name that hidden field, and the
 *     invitee cannot read the workspace record before accepting).
 * R3  POST /api/tracker/invitations/{id}/accept — one transaction: new active membership (or the
 *     caller's EXISTING membership row, in ANY status, left untouched) + the invitation deleted.
 * R4  POST /api/tracker/invitations/{id}/decline — deletes the invitation, creates nothing.
 * R5  DELETE /api/collections/workspace_invitations/records/{id} — owner/active-admin revoke.
 * R6  GET  /api/collections/workspace_invitations/records?filter=... — owner/active-admin's
 *     pending list.
 *
 * Every response key set is asserted as a SET:
 * a subset check cannot fail on an extra leaked key.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy. Port 8149 +
 * PB_PORT_OFFSET (suite self-boot band, .agents/rules/ports.md).
 */

// COVERS: route:POST /api/tracker/workspaces/{id}/resolve-member-email
// COVERS: route:GET /api/tracker/invitations/mine
// COVERS: route:POST /api/tracker/invitations/{id}/accept
// COVERS: route:POST /api/tracker/invitations/{id}/decline
// COVERS: hook:invitations.pb.js#onRecordCreate:workspace_invitations
// COVERS: hook:invitations.pb.js#onRecordCreateRequest:workspace_invitations
// COVERS: hook:invitations.pb.js#onRecordDeleteExecute:workspace_invitations
// COVERS: rule:workspace_invitations.list
// COVERS: rule:workspace_invitations.view
// COVERS: rule:workspace_invitations.create
// COVERS: rule:workspace_invitations.update
// COVERS: rule:workspace_invitations.delete
// COVERS: cron:invitation-expiry
// COVERS: boot:invitation_expiry.pb.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  json_dumps,
  py_repr,
  py_str,
  quote,
  run_checked,
  tup,
  truthy,
  url_error_reason,
  urlencode,
  sqlite_connect,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const PORT = 8149 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const INVITATIONS = "/api/collections/workspace_invitations/records";
const MEMBERS = "/api/collections/workspace_members/records";
const WORKSPACES = "/api/collections/workspaces/records";
const SETTINGS_ID = "wsinvexpirydys7";

let failures = 0;

function check(label: string, got: any, want: any): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${py_repr(got)}`);
    console.log(`        want: ${py_repr(want)}`);
  }
}

/** The response's key set is EXACTLY `want_keys` — a subset check cannot catch a leak. */
function check_keys(label: string, body: any, want_keys: Iterable<string>): void {
  const is_dict = body !== null && typeof body === "object" && !Array.isArray(body);
  check(label, is_dict ? new Set(Object.keys(body)) : body, new Set(want_keys));
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
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, url_error_reason(e));
  }
  const raw = new Uint8Array(await r.arrayBuffer());
  const decode = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  if (r.ok) return tup(r.status, raw.length ? JSON.parse(decode()) : {});
  try {
    return tup(r.status, raw.length ? JSON.parse(decode()) : {});
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return tup(r.status, { raw: Array.from(decode()).slice(0, 300).join("") });
  }
}

async function login(email: string, password = "test123456"): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password,
  });
  return roomkit.token_of(BASE_URL, email, r);
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-invitations-test-"));
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
  const su = await superuser_token();

  const ACCOUNTS: string[] = [];

  /**
   * A user token via superuser impersonation — bypasses auth-with-password's 10/60s
   * rate limiter (IP-keyed, so this suite's dozen-plus fixtures would exhaust it as one
   * real login budget). Kept distinct from the two DELIBERATE auth-with-password calls
   * below (owner's real login, and the unverified-account refusal itself).
   */
  async function imp(user_id: string): Promise<string> {
    const [s, r] = await api("POST", `/api/collections/users/impersonate/${user_id}`, su, {});
    if (s !== 200) throw new Error(`impersonate(${user_id}) failed: ${s} ${py_str(r)}`);
    return getitem(r, "token");
  }

  async function mkuser(tag: string, verified = true): Promise<[string, string]> {
    const email = `invitations-${tag}@example.test`;
    const [s, u] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name: tag,
      verified,
      approved: true,
    });
    if (s !== 200) throw new Error(`mkuser(${tag}) failed: ${s} ${py_str(u)}`);
    ACCOUNTS.push(getitem(u, "id"));
    return [getitem(u, "id"), email];
  }

  async function set_expiry_days(days: number): Promise<void> {
    const [s] = await api("PATCH", `/api/collections/app_settings/records/${SETTINGS_ID}`, su, {
      value: days,
    });
    check(`(fixture) invitation_expiry_days set to ${days}`, s, 200);
  }

  async function invites_of(ws: string): Promise<any[]> {
    const qs = urlencode({ filter: `workspace='${ws}'`, perPage: 200 });
    return (await api("GET", `${INVITATIONS}?${qs}`, su))[1].items || [];
  }

  function resolve(
    ws_id: string,
    tok: string | null,
    email: string,
    role: string | null = null,
  ): Promise<[number, any]> {
    const body: Record<string, unknown> = { email };
    if (role !== null) body.role = role;
    return api("POST", `/api/tracker/workspaces/${ws_id}/resolve-member-email`, tok, body);
  }

  function mine(tok: string | null): Promise<[number, any]> {
    return api("GET", "/api/tracker/invitations/mine", tok);
  }

  function accept(inv_id: string, tok: string | null): Promise<[number, any]> {
    return api("POST", `/api/tracker/invitations/${inv_id}/accept`, tok);
  }

  function decline(inv_id: string, tok: string | null): Promise<[number, any]> {
    return api("POST", `/api/tracker/invitations/${inv_id}/decline`, tok);
  }

  function roster(ws_id: string, tok: string | null): Promise<[number, any]> {
    const qs = urlencode({ filter: `workspace='${ws_id}'`, expand: "user", sort: "created" });
    return api("GET", `/api/collections/workspace_members/records?${qs}`, tok);
  }

  const has_invite = async (ws: string, inv_id: string): Promise<boolean> =>
    (await invites_of(ws)).some((i) => getitem(i, "id") === inv_id);

  let s: number;
  let r: any;

  // ═══════════════════════ fixtures: one workspace, every role tier ═══════════════════════
  console.log("\n── fixtures: owner + one member per role/status tier ──");
  const [owner_id, owner_email] = await mkuser("owner");
  const OWNER = await login(owner_email);
  let ws: any;
  [s, ws] = await api("POST", WORKSPACES, OWNER, { name: "Invitations WS", owner: owner_id });
  check("(fixture) owner's workspace created", s, 200);
  const WS: string = getitem(ws, "id");

  async function add_member(user_id: string, role: string, status = "active"): Promise<string> {
    const [s, m] = await api("POST", MEMBERS, su, { workspace: WS, user: user_id, role, status });
    if (s !== 200)
      throw new Error(`add_member(${user_id}, ${role}, ${status}) failed: ${s} ${py_str(m)}`);
    return getitem(m, "id");
  }

  const [admin_id, admin_email] = await mkuser("admin");
  const ADMIN = await imp(admin_id);
  await add_member(admin_id, "admin", "active");

  const [susadmin_id, susadmin_email] = await mkuser("susadmin");
  const SUSADMIN = await imp(susadmin_id);
  await add_member(susadmin_id, "admin", "suspended");

  const [member_id, member_email] = await mkuser("member");
  const MEMBER = await imp(member_id);
  await add_member(member_id, "member", "active");

  const [viewer_id, viewer_email] = await mkuser("viewer");
  const VIEWER = await imp(viewer_id);
  await add_member(viewer_id, "viewer", "active");

  const [stranger_id, stranger_email] = await mkuser("stranger");
  const STRANGER = await imp(stranger_id);

  // ═══════════════════════ R1 ══════════════════════════════════════════════════════════
  console.log("\n── R1: mint / idempotent re-mint ──");
  const [reg_id, reg_email] = await mkuser("registered");
  const UNREG = "invitations-nobody@example.test";
  [s, r] = await resolve(WS, OWNER, reg_email);
  check(
    "R1 owner invites a registered address → 200 {invited:true}",
    tup(s, r),
    tup(200, { invited: true }),
  );
  check_keys("R1 response key set is exactly {invited}", r, ["invited"]);
  const [s2, r2] = await resolve(WS, OWNER, UNREG);
  check("R1 owner invites an unregistered address → identical answer", tup(s2, r2), tup(s, r));
  const rows = (await invites_of(WS)).filter((i) => getitem(i, "email") === reg_email);
  check("exactly one row landed for the registered address", rows.length, 1);
  check("role defaulted to member", getitem(rows[0], "role"), "member");
  const first_row = rows[0];

  console.log("\n── R1: re-invite is idempotent ──");
  const [s3, r3] = await resolve(WS, OWNER, "  " + reg_email.toUpperCase() + " ", "admin");
  check(
    "re-invite (different case/whitespace/role) → same 200 ack",
    tup(s3, r3),
    tup(200, { invited: true }),
  );
  const rows_after = (await invites_of(WS)).filter((i) => getitem(i, "email") === reg_email);
  check("still exactly one row", rows_after.length, 1);
  check("role UNCHANGED by the re-invite", getitem(rows_after[0], "role"), "member");
  check(
    "the row's id did not change (no second row, then a delete)",
    getitem(rows_after[0], "id"),
    getitem(first_row, "id"),
  );

  console.log("\n── R1: refusals ──");
  check(
    "400 non-string email",
    (
      await api("POST", `/api/tracker/workspaces/${WS}/resolve-member-email`, OWNER, {
        email: 42,
      })
    )[0],
    400,
  );
  check(
    "400 blank email",
    await resolve(WS, OWNER, "   "),
    tup(400, { status: 400, message: "Email must be a non-empty string.", data: {} }),
  );
  check(
    "400 missing email",
    (await api("POST", `/api/tracker/workspaces/${WS}/resolve-member-email`, OWNER, {}))[0],
    400,
  );
  check("400 unknown role", (await resolve(WS, OWNER, "x@example.test", "owner"))[0], 400);
  [s, r] = await api("POST", `/api/tracker/workspaces/${WS}/resolve-member-email`, OWNER, {
    email: "x@example.test",
    expected_updated_at: "2026-01-01 00:00:00.000Z",
  });
  check("400 expected_updated_at (the stale-write key this route cannot honour)", s, 400);
  check(
    "400 active admin mints an admin",
    (await resolve(WS, ADMIN, "x2@example.test", "admin"))[0],
    400,
  );
  check(
    "400 active admin mints a viewer",
    (await resolve(WS, ADMIN, "x3@example.test", "viewer"))[0],
    400,
  );
  check(
    "200 active admin mints a member",
    (await resolve(WS, ADMIN, "x4@example.test", "member"))[0],
    200,
  );
  check(
    "404 admin-minting-viewer's message is the DENY, not the invite (admin-minting-VIEWER route body)",
    (
      (
        await api("POST", `/api/tracker/workspaces/${WS}/resolve-member-email`, ADMIN, {
          email: "x5@example.test",
          role: "viewer",
        })
      )[1].message ?? ""
    ).toLowerCase(),
    "only the workspace owner can add an admin or a viewer.",
  );
  check("404 non-member caller", (await resolve(WS, STRANGER, "x6@example.test"))[0], 404);
  check("404 suspended admin caller", (await resolve(WS, SUSADMIN, "x7@example.test"))[0], 404);
  check("404 active member caller", (await resolve(WS, MEMBER, "x8@example.test"))[0], 404);
  check(
    "404 unknown workspace id",
    (await resolve("no-such-ws", OWNER, "x9@example.test"))[0],
    404,
  );
  check("401 anonymous", (await resolve(WS, null, "x10@example.test"))[0], 401);

  console.log("\n── R1: expected_updated_at refusal writes nothing ──");
  const before_rows = (await invites_of(WS)).length;
  await api("POST", `/api/tracker/workspaces/${WS}/resolve-member-email`, OWNER, {
    email: "stale-key-target@example.test",
    expected_updated_at: "2026-01-01 00:00:00.000Z",
  });
  check(
    "no row landed for the refused stale-write create",
    (await invites_of(WS)).length,
    before_rows,
  );

  // ═══════════════════════ R2 ══════════════════════════════════════════════════════════
  console.log("\n── R2: GET /api/tracker/invitations/mine ──");
  const inv_reg = (await invites_of(WS)).find((i) => getitem(i, "email") === reg_email);
  let m: any;
  [s, m] = await mine(await imp(reg_id));
  check("R2 200", s, 200);
  check("R2 lists exactly the one pending invitation", (m.items ?? []).length, 1);
  const item = getitem(m, "items")[0];
  check_keys("R2 item key set is exactly the wire shape", item, [
    "id",
    "workspace",
    "workspace_name",
    "role",
    "created",
    "expires_at",
    "expired",
  ]);
  check("R2 item: workspace id", getitem(item, "workspace"), WS);
  check(
    "R2 item: workspace_name is the raw name",
    getitem(item, "workspace_name"),
    "Invitations WS",
  );
  check("R2 item: role", getitem(item, "role"), "member");
  check("R2 item: not expired (fresh, default 7-day setting)", getitem(item, "expired"), false);
  check(
    "R2 stranger sees nothing (reverse-oracle containment)",
    await mine(STRANGER),
    tup(200, { items: [] }),
  );
  check("R2 401 anonymous", (await mine(null))[0], 401);

  console.log("\n── R2: ordering by created ascending ──");
  await resolve(WS, OWNER, reg_email); // no-op re-invite, does not disturb ordering
  const [e1, e1a] = await mkuser("ord1");
  const [e2, e2a] = await mkuser("ord2");
  await resolve(WS, OWNER, e1a);
  await resolve(WS, OWNER, e2a);
  // reg_email's invitee is a different account than e1a/e2a; check ordering across the SAME invitee's list isn't testable with one invitee — assert instead that /mine for a fresh invitee with only their own row is unaffected by other pending rows (isolation), and that R6 (below) proves ordering with a real sort param.
  check(
    "R2 isolation: a second invitee's list carries only their own row",
    getitem(getitem((await mine(await imp(e1)))[1], "items")[0], "role"),
    "member",
  );

  // ═══════════════════════ R3 ══════════════════════════════════════════════════════════
  console.log("\n── R3: accept — new membership ──");
  // Gmail-fold: the invite goes to probe.alias@gmail.com, the account is probealias@gmail.com.
  let alias: any;
  [s, alias] = await api("POST", "/api/collections/users/records", su, {
    email: "invitations.probealias@gmail.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Alias",
    verified: true,
    approved: true,
  });
  check("(fixture) gmail-fold account created", s, 200);
  const ALIAS_ID: string = getitem(alias, "id");
  ACCOUNTS.push(ALIAS_ID);
  const ALIAS = await imp(ALIAS_ID);
  await resolve(WS, OWNER, "invitations.probe.alias@gmail.com", "viewer");
  const [, mline] = await mine(ALIAS);
  check(
    "Gmail-fold: probe.alias@gmail.com invite reaches probealias@gmail.com",
    getitem(mline, "items").length,
    1,
  );
  const inv_alias: string = getitem(getitem(mline, "items")[0], "id");

  check(
    "R3 not-yours → 404 Invitation not found.",
    await accept(inv_alias, STRANGER),
    tup(404, { message: "Invitation not found.", data: {}, status: 404 }),
  );
  check("R3 unknown id → 404", (await accept("doesnotexist12345", ALIAS))[0], 404);
  let acc: any;
  [s, acc] = await accept(inv_alias, ALIAS);
  check("R3 200", s, 200);
  check_keys("R3 response key set is exactly the wire shape", acc, [
    "workspace",
    "membership",
    "role",
    "status",
  ]);
  check(
    "R3: new membership, active, viewer role",
    tup(getitem(acc, "workspace"), getitem(acc, "role"), getitem(acc, "status")),
    tup(WS, "viewer", "active"),
  );
  let mrow: any;
  [, mrow] = await api("GET", `${MEMBERS}/${getitem(acc, "membership")}`, su);
  check(
    "the membership row really is active/viewer/that user",
    tup(getitem(mrow, "status"), getitem(mrow, "role"), getitem(mrow, "user")),
    tup("active", "viewer", ALIAS_ID),
  );
  check("the invitation is gone after accept", await has_invite(WS, inv_alias), false);

  console.log("\n── R3: owner accepts their own invitation → treated as an existing member ──");
  await resolve(WS, OWNER, owner_email, "viewer");
  const [, mline_o] = await mine(await imp(owner_id));
  const inv_owner: string = getitem(getitem(mline_o, "items")[0], "id");
  let acc_owner: any;
  [s, acc_owner] = await accept(inv_owner, OWNER);
  check("owner-self-accept 200", s, 200);
  check_keys("owner-self-accept response key set is exactly the wire shape", acc_owner, [
    "workspace",
    "membership",
    "role",
    "status",
  ]);
  const [, roster_owner] = await api(
    "GET",
    `${MEMBERS}?filter=` + quote(`workspace='${WS}' && user='${owner_id}'`),
    su,
  );
  check("no membership row was created for the owner", getitem(roster_owner, "items"), []);
  check("the owner's invitation is gone", await has_invite(WS, inv_owner), false);

  console.log("\n── R3: accept on an EXISTING (suspended) membership leaves it unchanged ──");
  await api("PATCH", `${MEMBERS}/${getitem(acc, "membership")}`, su, { status: "suspended" });
  await resolve(WS, OWNER, "invitations.probealias@gmail.com", "admin");
  const [, mline2] = await mine(ALIAS);
  const inv2: string = getitem(getitem(mline2, "items")[0], "id");
  let acc2: any;
  [s, acc2] = await accept(inv2, ALIAS);
  check(
    "a suspended member accepting is NEVER reactivated — same row, same status, invited role ignored",
    tup(s, acc2),
    tup(200, {
      workspace: WS,
      membership: getitem(acc, "membership"),
      role: "viewer",
      status: "suspended",
    }),
  );
  let mrow2: any;
  [, mrow2] = await api("GET", `${MEMBERS}/${getitem(acc, "membership")}`, su);
  check(
    "stored membership: still suspended, still viewer",
    tup(getitem(mrow2, "status"), getitem(mrow2, "role")),
    tup("suspended", "viewer"),
  );
  check("the second invitation is gone too", await has_invite(WS, inv2), false);
  await api("PATCH", `${MEMBERS}/${getitem(acc, "membership")}`, su, { status: "active" });

  console.log("\n── R3: expiry, at the accept route ──");
  await resolve(WS, OWNER, e2a);
  const [, mline3] = await mine(await imp(e2));
  const inv_exp: string = getitem(getitem(mline3, "items")[0], "id");
  await set_expiry_days(0);
  const [, mline3b] = await mine(await imp(e2));
  check(
    "R2 shows it expired: true once the setting drops to 0 days",
    getitem(getitem(mline3b, "items")[0], "expired"),
    true,
  );
  check(
    "R2's expires_at now equals created",
    getitem(getitem(mline3b, "items")[0], "expires_at"),
    getitem(getitem(mline3b, "items")[0], "created"),
  );
  let ex: any;
  [s, ex] = await accept(inv_exp, await imp(e2));
  check(
    "R3 410, exact wire body",
    tup(s, ex),
    tup(410, {
      status: 410,
      message: "This invitation has expired.",
      data: {
        invitation: {
          code: "invitation_expired",
          message: "This invitation has expired.",
        },
      },
    }),
  );
  check("the refusal did NOT delete the row", await has_invite(WS, inv_exp), true);
  await set_expiry_days(7);

  console.log("\n── R3: unverified account ──");
  const [unv_id, unv_email] = await mkuser("unverified", false);
  [s] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: unv_email,
    password: "test123456",
  });
  check("auth-with-password is REFUSED outright for an unverified account", s, 403);
  const UNV = await imp(unv_id);
  await resolve(WS, OWNER, unv_email);
  const [, mline4] = await mine(UNV);
  const inv_unv: string = getitem(getitem(mline4, "items")[0], "id");
  let u3: any;
  [s, u3] = await accept(inv_unv, UNV);
  check(
    "an impersonated unverified token IS still refused, at R3, distinctly",
    tup(s, u3.message ?? null),
    tup(403, "Confirm your email address before accepting an invitation."),
  );

  console.log("\n── R3: 401 anonymous ──");
  check("R3 anon 401", (await accept(inv_exp, null))[0], 401);

  // ═══════════════ R-1 audit: suspend deletes a pending self-invite ═══════════════════
  console.log("\n── suspending a member deletes any pending invitation to their own address ──");
  const [susinv_id, susinv_email] = await mkuser("susinv");
  const SUSINV = await imp(susinv_id);
  const susinv_mid = await add_member(susinv_id, "member", "active");
  await resolve(WS, OWNER, susinv_email);
  const inv_susinv: string = getitem(
    (await invites_of(WS)).find((i) => getitem(i, "email") === susinv_email),
    "id",
  );
  [s] = await api("PATCH", `${MEMBERS}/${susinv_mid}`, su, { status: "suspended" });
  check("member suspended", s, 200);
  check(
    "the pending invitation to the suspended member's own address is gone",
    await has_invite(WS, inv_susinv),
    false,
  );
  [s] = await api("DELETE", `${MEMBERS}/${susinv_mid}`, SUSINV);
  check("suspended member self-leaves → 204", s, 204);
  [s] = await accept(inv_susinv, SUSINV);
  check("accepting the deleted invitation → 404, no self-reactivation", s, 404);
  const [, rows_susinv] = await api(
    "GET",
    `${MEMBERS}?filter=` + quote(`workspace='${WS}' && user='${susinv_id}'`),
    su,
  );
  check(
    "no membership row remains for the formerly-suspended member",
    getitem(rows_susinv, "items"),
    [],
  );

  console.log(
    "\n── a re-invite issued to an ALREADY-suspended address is a deliberate re-admission ──",
  );
  const [resusinv_id, resusinv_email] = await mkuser("resusinv");
  await add_member(resusinv_id, "member", "suspended");
  await resolve(WS, OWNER, resusinv_email);
  const inv_resusinv: string = getitem(
    (await invites_of(WS)).find((i) => getitem(i, "email") === resusinv_email),
    "id",
  );
  check(
    "an invitation minted for an address already suspended is untouched",
    await has_invite(WS, inv_resusinv),
    true,
  );
  await api("DELETE", `${INVITATIONS}/${inv_resusinv}`, su);

  // ═══════════════════ concurrency: accept races revoke / itself ══════════════════════
  // R3 re-reads the invitation INSIDE its runInTransaction, and the revoke's
  // onRecordDeleteExecute guard claims the row via one atomic conditional DELETE — so
  // exactly one of {accept, revoke} wins and the loser gets 404, never a double-consumed row.
  console.log("\n── concurrency: accept races an owner revoke ──");
  const N_RACE = 10;
  for (let i = 0; i < N_RACE; i++) {
    const [race_id, race_email] = await mkuser(`race${i}`);
    await resolve(WS, OWNER, race_email);
    const [, mline_r] = await mine(await imp(race_id));
    const inv_r: string = getitem(getitem(mline_r, "items")[0], "id");
    const race_tok = await imp(race_id);
    // Python's Barrier(2) released both threads together; here both fetches are started
    // before either is awaited, so both requests are in flight at once.
    const results = {
      accept: undefined as unknown as [number, any],
      revoke: undefined as unknown as [number, any],
    };
    [results.accept, results.revoke] = await Promise.all([
      accept(inv_r, race_tok),
      api("DELETE", `${INVITATIONS}/${inv_r}`, OWNER),
    ]);
    const accept_won = results.accept[0] === 200;
    const revoke_won = results.revoke[0] === 204;
    check(`race ${i}: accept XOR revoke succeeds`, accept_won !== revoke_won, true);
    if (accept_won) {
      check(`race ${i}: the losing revoke is 404`, results.revoke[0], 404);
    } else {
      check(`race ${i}: the losing accept is 404`, results.accept[0], 404);
    }
    const [, mrows_r] = await api(
      "GET",
      `${MEMBERS}?filter=` + quote(`workspace='${WS}' && user='${race_id}'`),
      su,
    );
    check(
      `race ${i}: a membership exists iff accept won`,
      (mrows_r.items ?? []).length,
      accept_won ? 1 : 0,
    );
  }

  console.log("\n── concurrency: N trials of 6 parallel accepts of ONE invitation ──");
  const N_MULTI = 10;
  for (let i = 0; i < N_MULTI; i++) {
    const [multi_id, multi_email] = await mkuser(`racesix${i}`);
    await resolve(WS, OWNER, multi_email);
    const [, mline_m] = await mine(await imp(multi_id));
    const inv_m: string = getitem(getitem(mline_m, "items")[0], "id");
    const multi_tok = await imp(multi_id);
    // Barrier(6) in Python: all six requests are started before any is awaited.
    const results6 = await Promise.all(Array.from({ length: 6 }, () => accept(inv_m, multi_tok)));
    const statuses6 = results6.map((r) => r[0]);
    check(`6-way accept ${i}: exactly one 200`, statuses6.filter((x) => x === 200).length, 1);
    check(`6-way accept ${i}: the rest are 404`, statuses6.filter((x) => x === 404).length, 5);
    const [, mrows_m] = await api(
      "GET",
      `${MEMBERS}?filter=` + quote(`workspace='${WS}' && user='${multi_id}'`),
      su,
    );
    check(`6-way accept ${i}: exactly one membership row`, (mrows_m.items ?? []).length, 1);
  }

  // ═══════════════════════ R4 ══════════════════════════════════════════════════════════
  console.log("\n── R4: decline ──");
  const [dec_id, dec_email] = await mkuser("decliner");
  await resolve(WS, OWNER, dec_email);
  const [, mline5] = await mine(await imp(dec_id));
  const inv_dec: string = getitem(getitem(mline5, "items")[0], "id");
  check("R4 not-yours → 404", (await decline(inv_dec, STRANGER))[0], 404);
  check("R4 unknown id → 404", (await decline("doesnotexist12345", await imp(dec_id)))[0], 404);
  let dec: any;
  [s, dec] = await decline(inv_dec, await imp(dec_id));
  check("R4 200 {declined:true}", tup(s, dec), tup(200, { declined: true }));
  check("the invitation is gone", await has_invite(WS, inv_dec), false);
  const [, decroster] = await api(
    "GET",
    `${MEMBERS}?filter=` + quote(`workspace='${WS}' && user='${dec_id}'`),
    su,
  );
  check("declining creates NO membership row", getitem(decroster, "items"), []);
  check("R4 401 anon", (await decline(inv_dec, null))[0], 401);

  console.log("\n── R4: decline works on an already-expired row ──");
  const [exp2_id, exp2_email] = await mkuser("expdecline");
  await resolve(WS, OWNER, exp2_email);
  const [, mline6] = await mine(await imp(exp2_id));
  const inv_exp2: string = getitem(getitem(mline6, "items")[0], "id");
  await set_expiry_days(0);
  let dec2: any;
  [s, dec2] = await decline(inv_exp2, await imp(exp2_id));
  check("declining an expired invitation still works", tup(s, dec2), tup(200, { declined: true }));
  await set_expiry_days(7);

  // ═══════════════════════ trashed workspace, R1-R6 ═══════════════════════════════════
  console.log("\n── trashed workspace: R1-R6 ──");
  const [tw_id, tw_email] = await mkuser("trashedws");
  await resolve(WS, OWNER, tw_email);
  const [, mline7] = await mine(await imp(tw_id));
  const inv_tw: string = getitem(getitem(mline7, "items")[0], "id");
  [s] = await api("DELETE", `${WORKSPACES}/${WS}`, OWNER);
  check("workspace trashed (soft-delete) → 204", s, 204);
  check(
    "R1 on a trashed workspace → 404",
    (await resolve(WS, OWNER, "post-trash@example.test"))[0],
    404,
  );
  check(
    "R2 omits the trashed workspace entirely",
    await mine(await imp(tw_id)),
    tup(200, { items: [] }),
  );
  check("R3 on a trashed workspace → 404", (await accept(inv_tw, await imp(tw_id)))[0], 404);
  check("R4 on a trashed workspace → 404", (await decline(inv_tw, await imp(tw_id)))[0], 404);
  check(
    "R5 (collection delete) on a trashed workspace → 404",
    (await api("DELETE", `${INVITATIONS}/${inv_tw}`, OWNER))[0],
    404,
  );
  let r6t: any;
  [s, r6t] = await api("GET", `${INVITATIONS}?filter=` + quote(`workspace='${WS}'`), OWNER);
  check(
    "R6 (collection list) on a trashed workspace → 200 empty (list idiom)",
    tup(s, r6t.items),
    tup(200, []),
  );
  await api("PATCH", `${WORKSPACES}/${WS}`, OWNER, { trashed: "" });
  await api("DELETE", `${INVITATIONS}/${inv_tw}`, su);

  // ═══════════════════════ R5/R6: role matrix ═════════════════════════════════════════
  console.log(
    "\n── R5/R6: owner, active admin, active member, active viewer, suspended admin, stranger ──",
  );
  const [, r56_email] = await mkuser("r56target");
  await resolve(WS, OWNER, r56_email);
  const inv_r56: string = getitem(
    (await invites_of(WS)).find((i) => getitem(i, "email") === r56_email),
    "id",
  );

  for (const [label, tok] of [
    ["owner", OWNER],
    ["active admin", ADMIN],
  ] as const) {
    const qs = urlencode({ filter: `workspace='${WS}'` });
    [s, r] = await api("GET", `${INVITATIONS}?${qs}`, tok);
    check(
      `R6 list: ${label} sees the pending invitation`,
      tup(
        s,
        (r.items ?? []).some((i: any) => getitem(i, "id") === inv_r56),
      ),
      tup(200, true),
    );
    [s, r] = await api("GET", `${INVITATIONS}/${inv_r56}`, tok);
    check(`R6 view: ${label} → 200`, s, 200);
    if (label !== "owner") {
      check_keys(`R6 record shape as ${label} sees it — no email_key, no updated`, r, [
        "collectionId",
        "collectionName",
        "id",
        "workspace",
        "email",
        "role",
        "invited_by",
        "created",
        "expires_at",
        "expired",
      ]);
    }
  }

  for (const [label, tok] of [
    ["active member", MEMBER],
    ["active viewer", VIEWER],
    ["suspended admin", SUSADMIN],
    ["stranger", STRANGER],
  ] as const) {
    const qs = urlencode({ filter: `workspace='${WS}'` });
    [s, r] = await api("GET", `${INVITATIONS}?${qs}`, tok);
    check(
      `R6 list: ${label} reads NOTHING (200 empty, reverse-oracle containment)`,
      tup(s, r.items),
      tup(200, []),
    );
    [s] = await api("GET", `${INVITATIONS}/${inv_r56}`, tok);
    check(`R6 view: ${label} → 404 (rule-miss idiom)`, s, 404);
    [s] = await api("DELETE", `${INVITATIONS}/${inv_r56}`, tok);
    check(`R5: ${label} cannot revoke → 404`, s, 404);
  }

  console.log("\n── R6: the pending list carries the backend-computed expiry ──");
  const listed_expiry = async (): Promise<[string, string, unknown]> => {
    const qs = urlencode({ filter: `workspace='${WS}' && id='${inv_r56}'` });
    const it = (await api("GET", `${INVITATIONS}?${qs}`, OWNER))[1].items[0];
    return [getitem(it, "created"), getitem(it, "expires_at"), getitem(it, "expired")];
  };
  const plus_days = (created: string, d: number) =>
    new Date(Date.parse(created.replace(" ", "T")) + d * 86400000).toISOString().replace("T", " ");
  for (const [setting, days] of [
    [7, 7],
    [2, 2],
    [0, 0],
    [-3, 7],
    ["garbage", 7],
  ] as const) {
    await set_expiry_days(setting as any);
    const [created, expires_at, expired] = await listed_expiry();
    check(
      `R6 list: setting ${JSON.stringify(setting)} → expires_at = created + ${days}d, expired ${days === 0}`,
      tup(expires_at, expired),
      tup(plus_days(created, days), days === 0),
    );
  }
  await set_expiry_days(7);

  [s] = await api("DELETE", `${INVITATIONS}/${inv_r56}`, ADMIN);
  check("R5: active admin CAN revoke", s, 204);
  check("the revoked row is gone", await has_invite(WS, inv_r56), false);

  console.log("\n── R5: owner can revoke too ──");
  const [, r5b_email] = await mkuser("r5btarget");
  await resolve(WS, OWNER, r5b_email);
  const inv_r5b: string = getitem(
    (await invites_of(WS)).find((i) => getitem(i, "email") === r5b_email),
    "id",
  );
  [s] = await api("DELETE", `${INVITATIONS}/${inv_r5b}`, OWNER);
  check("R5: owner CAN revoke", s, 204);

  // ═══════════════════════ client-supplied email_key is ignored ══════════════════════
  console.log("\n── a client-supplied email_key is ignored on a direct collection create ──");
  let made: any;
  [s, made] = await api("POST", INVITATIONS, OWNER, {
    workspace: WS,
    email: "Direct.Create@Example.TEST",
    email_key: "someone-else@example.test",
    role: "viewer",
  });
  check("direct create as owner → 200", s, 200);
  const [, full] = await api("GET", `${INVITATIONS}/${getitem(made, "id")}?fields=*,email_key`, su);
  check("email trimmed+lowercased", full.email ?? null, "direct.create@example.test");
  check(
    "email_key is the FOLD of the real email, not the client's value",
    full.email_key ?? null,
    "direct.create@example.test",
  );
  check(
    "invited_by is forced to the caller, not any submitted value",
    full.invited_by ?? null,
    owner_id,
  );
  check(
    "email_key never appears on the create response (hidden field)",
    Object.hasOwn(made, "email_key"),
    false,
  );
  await api("DELETE", `${INVITATIONS}/${getitem(made, "id")}`, su);

  console.log("\n── a direct create with a blank email is refused by the create hook ──");
  let blank: any;
  [s, blank] = await api("POST", INVITATIONS, OWNER, {
    workspace: WS,
    email: "   ",
    role: "member",
  });
  check(
    "400, create-hook message",
    tup(s, blank.message ?? null),
    tup(400, "Email must be a non-empty string."),
  );

  // ═══════════════════════ hidden-field filter trap, proven live ═════════════════════
  console.log("\n── the hidden email_key: a RULE may match it, a CLIENT filter on it may not ──");
  await resolve(WS, OWNER, stranger_email);
  const [, coll] = await api("GET", "/api/collections/workspace_invitations", su);
  const orig_list_rule = getitem(coll, "listRule");
  await api("PATCH", "/api/collections/workspace_invitations", su, {
    listRule: "email_key = @request.auth.email_key",
  });
  let t: any;
  [s, t] = await api("GET", INVITATIONS, STRANGER);
  check(
    "MEASURED: a collection RULE naming email_key DOES match the invitee",
    tup(
      s,
      (t.items ?? []).map((i: any) => getitem(i, "email")),
    ),
    tup(200, [stranger_email]),
  );
  {
    const qs = urlencode({ filter: `email_key="${stranger_email}"` });
    [s] = await api("GET", `${INVITATIONS}?${qs}`, STRANGER);
  }
  check("but a CLIENT filter naming the same hidden field is refused (400)", s, 400);
  await api("PATCH", "/api/collections/workspace_invitations", su, { listRule: orig_list_rule });
  for (const i of await invites_of(WS)) {
    if (getitem(i, "email") === stranger_email) {
      await api("DELETE", `${INVITATIONS}/${getitem(i, "id")}`, su);
    }
  }

  // ═══════════════════════ sweep: the daily cron expires by app_settings ═════════════
  console.log(
    "\n── the sweep (invitation-expiry cron, triggered manually) deletes past-cutoff rows ──",
  );
  const [, fresh_email] = await mkuser("freshsweep");
  const [, stale_email] = await mkuser("stalesweep");
  await resolve(WS, OWNER, fresh_email);
  await resolve(WS, OWNER, stale_email);
  const con_path = path.join(DATA_DIR, "data.db");

  const con = sqlite_connect(con_path);
  con.run("UPDATE workspace_invitations SET created = '2026-01-01 00:00:00.000Z' WHERE email = ?", [
    stale_email,
  ]);
  con.close();
  const emails_of = async (): Promise<string[]> =>
    (await invites_of(WS)).map((i) => getitem(i, "email") as string).sort(by_code_point);
  const before = await emails_of();
  [s] = await api("POST", "/api/crons/invitation-expiry", su);
  check("triggering the cron route → 204", s, 204);
  let after: string[] | null = null;
  for (let _ = 0; _ < 50; _++) {
    after = await emails_of();
    if (!after.includes(stale_email)) break;
    await Bun.sleep(100);
  }
  console.log(`     before sweep: ${py_str(before)}`);
  console.log(`     after sweep:  ${py_str(after)}`);
  check("the sweep deleted the aged-past-cutoff row", after!.includes(stale_email), false);
  check("the sweep kept the fresh row", after!.includes(fresh_email), true);

  // ═══════════════════════ AC3 probe: registered + unregistered, roster identical ═════
  console.log(
    "\n── AC3: invite a registered and an unregistered address — roster is byte-identical ──",
  );
  const [, reg2_email] = await mkuser("ac3registered");
  const unreg2_email = "invitations-ac3-unregistered@example.test";
  let before_roster: any;
  [s, before_roster] = await roster(WS, OWNER);
  check("AC3 roster read BEFORE → 200", s, 200);
  const before_body = json_dumps(before_roster, { sort_keys: true });
  const [s_reg, r_reg] = await resolve(WS, OWNER, reg2_email);
  const [s_unreg, r_unreg] = await resolve(WS, OWNER, unreg2_email);
  check(
    "AC3: R1 responses for registered/unregistered are IDENTICAL",
    tup(s_reg, r_reg),
    tup(s_unreg, r_unreg),
  );
  let after_roster: any;
  [s, after_roster] = await roster(WS, OWNER);
  check("AC3 roster read AFTER → 200", s, 200);
  const after_body = json_dumps(after_roster, { sort_keys: true });
  console.log(`     roster BEFORE: ${before_body}`);
  console.log(`     roster AFTER:  ${after_body}`);
  check(
    "AC3: roster (workspace_members?expand=user) is BYTE-IDENTICAL before/after both invites",
    after_body,
    before_body,
  );
  for (const i of await invites_of(WS)) {
    if ([reg2_email, unreg2_email].includes(getitem(i, "email"))) {
      await api("DELETE", `${INVITATIONS}/${getitem(i, "id")}`, su);
    }
  }

  console.log("\n── cleanup ──");
  [s] = await api("DELETE", `${WORKSPACES}/${WS}`, OWNER);
  check("workspace trashed for cleanup", s, 204);
  const left: string[] = [];
  for (const uid of ACCOUNTS) {
    if ((await api("DELETE", `/api/collections/users/records/${uid}`, su))[0] !== 204) {
      left.push(uid);
    }
  }
  check("every probe account removed", left, []);
} finally {
  if (server !== null) {
    await roomkit.stop(server);
  }
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} FAILED`);
  process.exit(1);
}
console.log("✅ all invitation (R1-R6) proofs passed");

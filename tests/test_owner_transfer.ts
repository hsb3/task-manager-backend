#!/usr/bin/env bun
/**E2E proof of workspace ownership transfer: POST /api/tracker/workspaces/{id}/
transfer-ownership. The collections API cannot do this at all — workspaces.updateRule
ends `@request.body.owner:isset = false`, so an owner PATCH is denied 404 before any
hook runs, and the superuser PATCH that does land leaves the roster untouched. In ONE
transaction the route flips `workspaces.owner`, rewrites the OUTGOING owner's
`workspace_members` row, and records the handover: one `task_activity` row anchored to the
workspace, one `notifications` row to each party. The INCOMING owner's roster row is read for
eligibility and never written (mahh) — ownership lives on `workspaces.owner`, so that row is
the standing held beneath it.

Fixtures: owner=Alice, active member=Bob, non-member=Carol. Throwaways (Dana admin,
Ivan pending-invitation-only (no membership row), Pia suspended admin, Sue suspended,
Nate/Nora for the self-delete story)
are minted via superuser and cleaned up at the end, each isolating one refusal cause so
a denial by TENANCY can never read as a denial by ROLE.

Both membership-row cases are exercised: §4/§5 UPDATE the outgoing owner's existing row,
§6 MINTS one for a workspace created straight through the collections API (which has no
roster row for its own owner — only the users-create auto-provision makes one).

§9 and §10 fire two transfers by one owner SIMULTANEOUSLY: they go red on a route whose reads
sit outside the transaction, because both callers are then told 200 and the loser rewrites the
winner's roster. Both membership-row shapes are raced — §9 the MINT (direct-created workspace),
§10 the UPDATE of the outgoing owner's already-present row (provisioned workspace).

§14 races a SUPERUSER field, which the owner check cannot separate because a superuser is
authorized past it. What separates it is the `current_owner` the caller names: it is compared
INSIDE the transaction, so exactly one call of a simultaneous field can be naming the owner the
transaction actually finds. Eight callers, not two — the property is deterministic, so a second
acceptance is a defect rather than a coin flip, and a wider field makes one show up sooner.

§4b reads the record the transfer left, on both parties' own tokens and on a non-member's, and
proves a REFUSED transfer leaves none. §15 drives the operator recipe
(`scripts/transfer_workspace_ownership.ts`) as a subprocess, then forces its read-then-send race
by calling its two steps around a superuser owner change — no sleeping, no waiting on a window.

DECLARED BOUND — the recipe's stale-owner arm drives `read_owner` and `send_transfer` in
process. What is NOT proven is that the CLI's own single-shot path loses the same race: the
window between its two calls cannot be widened from outside without a flag this script does not
carry, and the two paths share the same functions.

DECLARED BOUND — the notification is proven as a stored, correctly-scoped row. Nothing here
proves how it RENDERS: that the reshaper maps `ownership_transferred` to the `ownership`
contract kind, and that the bell renders that kind, is proven by the web unit tests
(`web/lib/proxy/handlers/notifications.test.ts`, `web/components/shell/notifications-bell.test.ts`).

DECLARED BOUND — the round count here is deliberately small, because the app_settings rate
limit is one budget for the whole file. The idle-versus-loaded replication that a concurrency
claim really needs is a scratch probe, not an arm of this suite.

DECLARED BOUND — the transaction's ROLLBACK half is not proven here. §9 proves the reads and
writes are SERIALIZED, and every refusal check proves no write escaped a rejected call, but a
mid-transaction failure (first two writes done, third rejected) cannot be provoked from the
black box: the writes carry no constraint a caller can violate on demand, no hook rejects a
workspace_members save, and the (workspace, user) unique index is only reachable through a
window this route no longer has. Proving it needs fault injection inside the hooks copy —
dropping one of the writes makes the mint fail and shows the owner flip rolled back with it —
which this suite deliberately does not do.

Needs superuser creds from .env / the battery's exported env.*/

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";
import {
  getitem,
  by_code_point,
  json_dumps,
  py_repr,
  py_rstrip,
  py_str,
  py_strip,
  read_text,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as operator_recipe from "../scripts/transfer_workspace_ownership.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const HELPER = path.join(REPO_ROOT, "scripts", "transfer_workspace_ownership.ts");

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s); // Python b'...' literal

// .env is gitignored — no secrets hard-coded here.
function load_env(path = ".env"): void {
  if (fs.existsSync(path)) {
    for (let line of read_text(path).split(/\r\n|\r|\n/)) {
      line = py_strip(line);
      if (line && !line.startsWith("#") && line.includes("=")) {
        const i = line.indexOf("=");
        const k = line.slice(0, i);
        const v = line.slice(i + 1);
        if (!(k in process.env)) process.env[k] = v;
      }
    }
  }
}

load_env();

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;

const TRANSFER = "/api/tracker/workspaces/{ws}/transfer-ownership";
const transfer_path = (ws: string): string => TRANSFER.replace("{ws}", ws);
const CURRENT_OWNER_MSG = "current_owner is required: name the person who owns this workspace now";
const STALE_OWNER_MSG =
  "this workspace is owned by someone other than the person named as its current owner; " +
  "check who owns it and try again";

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
    r = await fetch(PB + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(PB, e);
  }
  return [r.status, raw ? JSON.parse(raw) : {}];
}

tierkit.use(api);

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(PB, email, r), getitem(getitem(r, "record"), "id")];
}

function esc(value: string): string {
  // PocketBase filter string literals escape an embedded quote with a backslash.
  return value.replaceAll("'", "\\'");
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<string | null> {
  const filt = `${field}='${esc(value)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? getitem(items[0], "id") : null;
}

const FAILS: string[] = [];

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_str(got)} (expected ${py_str(expected)})`,
  );
}

function check_in(label: string, got: any, allowed: any[]): void {
  const ok = allowed.some((a) => Bun.deepEquals(got, a, true));
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_str(got)} (expected one of ${py_str(tup(...allowed))})`,
  );
}

/**
 * A PB error message normalized for comparison — the wire form is capitalized and
 * period-terminated (.agents/memory/pb-wire-message-normalization.md).
 */
function wire(body: any): string {
  return py_rstrip(py_strip(body.message || ""), ".").toLowerCase();
}

async function transfer(ws: string, token: string | null, body: any): Promise<[number, string]> {
  const [s, r] = await api("POST", transfer_path(ws), token, body);
  return tup(s, wire(r));
}

/** The exact response BYTES — two 404s agreeing on every parsed field can still differ. */
async function post_raw(path: string, token: string | null, body: any): Promise<Uint8Array> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  try {
    const resp = await fetch(PB + path, { method: "POST", headers, body: JSON.stringify(body) });
    return new Uint8Array(await resp.arrayBuffer());
  } catch (exc) {
    return roomkit.die_no_server(PB, exc);
  }
}

/**
 * Every membership row for (ws, user) — a LIST, so a duplicate minted under concurrency
 * shows up instead of being read as the first one.
 */
async function roster_rows(ws: string, user: string, token: string | null): Promise<any[]> {
  const qs = urlencode({ filter: `(workspace='${ws}' && user='${user}')`, perPage: 5 });
  const [, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, token);
  return r.items || [];
}

/** (role, status) of the (ws, user) membership row, or None when there is none. */
async function roster(ws: string, user: string, token: string | null) {
  const rows = await roster_rows(ws, user, token);
  return rows.length ? tup(getitem(rows[0], "role"), getitem(rows[0], "status")) : null;
}

/**
 * (role, status, updated) — `updated` moves on ANY save, so an unchanged triple proves
 * the row was never written, not merely that it landed back on the same values.
 */
async function roster_stamp(ws: string, user: string, token: string | null) {
  const rows = await roster_rows(ws, user, token);
  return rows.length
    ? tup(getitem(rows[0], "role"), getitem(rows[0], "status"), getitem(rows[0], "updated"))
    : null;
}

/** {user: (role, status)} for EVERY membership row of the workspace. */
async function roster_all(ws: string, token: string | null): Promise<Record<string, any>> {
  const qs = urlencode({ filter: `workspace='${ws}'`, perPage: 50 });
  const [, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, token);
  return Object.fromEntries(
    (r.items || []).map(
      (i: any) =>
        [getitem(i, "user"), tup(getitem(i, "role"), getitem(i, "status"))] as [string, any],
    ),
  );
}

async function owner_of(ws: string, token: string | null): Promise<any> {
  return (await api("GET", `/api/collections/workspaces/records/${ws}`, token))[1].owner;
}

/**
 * The workspace-anchored `owner` audit rows, oldest first. [] also covers the 400 a server
 * with no `workspace` column answers a filter on it with, which is the RED shape.
 */
async function ownership_audit(ws: string, token: string | null): Promise<any[]> {
  const qs = urlencode({
    filter: `workspace='${ws}' && field='owner'`,
    perPage: 50,
    sort: "created",
  });
  const [, r] = await api("GET", `/api/collections/task_activity/records?${qs}`, token);
  return r.items || [];
}

async function ownership_notices(user: string, token: string | null): Promise<any[]> {
  const qs = urlencode({ filter: `user='${user}' && kind='ownership_transferred'`, perPage: 50 });
  const [, r] = await api("GET", `/api/collections/notifications/records?${qs}`, token);
  return r.items || [];
}

const token_hex = (n: number): string => randomBytes(n).toString("hex");

// ── Superuser + base fixtures ──────────────────────────────────────────────────
const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
let [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su = roomkit.token_of(PB, SU_EMAIL, r);
const su_id = getitem(getitem(r, "record"), "id");

const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");
const [carol, carol_id] = await login("carol@example.com");

const ALICE_WORKSPACE = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
const UNKNOWN_WS = "zzzzzzzzzzzzzzz"; // 15 chars, PB's record-id shape, guaranteed absent

const THROWAWAYS: (string | undefined)[] = []; // user ids to su-delete in the final cleanup pass

async function su_create_user(name: string): Promise<[string, string]> {
  const email = `xfer-${name.toLowerCase()}-${token_hex(4)}@example.com`;
  const [s, r] = await api("POST", "/api/collections/users/records", su, {
    email,
    password: "test123456",
    passwordConfirm: "test123456",
    name,
    verified: true,
    approved: true,
  });
  check_in(`setup: su creates throwaway user ${name}`, s, [200, 201]);
  THROWAWAYS.push(r.id ?? null);
  return [r.id ?? null, email];
}

async function su_add_member(
  ws: string,
  user: string,
  role: string,
  status: string,
  who: string,
): Promise<any> {
  const [s, r] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ws,
    user,
    role,
    status,
  });
  check_in(`setup: ${who} added to workspace ${ws} as ${role}/${status}`, s, [200, 201]);
  return r.id ?? null;
}

console.log("\n── SETUP: fixtures for every refusal cause ──");
const [dana_id, dana_email] = await su_create_user("Dana");
await su_add_member(ALICE_WORKSPACE, dana_id, "admin", "active", "Dana");
const [dana] = await login(dana_email);

const [ivan_id, ivan_email] = await su_create_user("Ivan");
// decision-073: `invited` retires from workspace_members — a pending invite is a
// workspace_invitations row, and Ivan holds NO membership row until he accepts one.
let [s] = await api("POST", "/api/collections/workspace_invitations/records", su, {
  workspace: ALICE_WORKSPACE,
  email: ivan_email,
  role: "member",
});
check_in("setup: Ivan has a pending invitation to Alice's workspace", s, [200, 201]);

const [pia_id] = await su_create_user("Pia");
await su_add_member(ALICE_WORKSPACE, pia_id, "admin", "suspended", "Pia");

const [sue_id] = await su_create_user("Sue");
await su_add_member(ALICE_WORKSPACE, sue_id, "member", "suspended", "Sue");

const [val_id] = await su_create_user("Val");
await su_add_member(ALICE_WORKSPACE, val_id, "viewer", "active", "Val");

// Every check below is only about the tier it names if the tier actually stored.
const alice_owns = await tierkit.owner_of_workspace(ALICE_WORKSPACE, alice_id, alice, "Alice");
const bob_member = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "member", alice, "Bob");
const dana_admin = await tierkit.actor_at_tier(ALICE_WORKSPACE, dana_id, "admin", alice, "Dana");
const pia_suspended_admin = await tierkit.actor_at_tier(
  ALICE_WORKSPACE,
  pia_id,
  "admin",
  su,
  "Pia",
  "suspended",
);
const sue_suspended = await tierkit.actor_at_tier(
  ALICE_WORKSPACE,
  sue_id,
  "member",
  su,
  "Sue",
  "suspended",
);
const val_viewer = await tierkit.actor_at_tier(ALICE_WORKSPACE, val_id, "viewer", su, "Val");

// COVERS: route:POST /api/tracker/workspaces/{id}/transfer-ownership
console.log("\n── §0 PREMISE: the collections API cannot transfer ownership at all ──");
[s] = await api("PATCH", `/api/collections/workspaces/records/${ALICE_WORKSPACE}`, alice, {
  owner: bob_id,
});
check(
  "premise: owner's own `owner` PATCH is denied by updateRule (404)",
  tup(await alice_owns.now(), s),
  tup(alice_id, 404),
);

console.log("\n── §1 CALLER MATRIX: only the owner may transfer; every refusal is the same 404 ──");
check(
  "caller: anon (no token) refused by requireAuth",
  await transfer(ALICE_WORKSPACE, null, { user: bob_id }),
  tup(401, "the request requires valid record authorization token"),
);
check(
  "caller: Bob (plain active member) → 404, no existence leak",
  tup(await bob_member.now(), ...(await transfer(ALICE_WORKSPACE, bob, { user: alice_id }))),
  tup("member", 404, "workspace not found"),
);
check(
  "caller: Dana (ACTIVE ADMIN) → 404 — admin confers no transfer authority",
  tup(await dana_admin.now(), ...(await transfer(ALICE_WORKSPACE, dana, { user: bob_id }))),
  tup("admin", 404, "workspace not found"),
);
check(
  "caller: Carol (non-member) → 404, identical to not-found",
  await transfer(ALICE_WORKSPACE, carol, { user: bob_id }),
  tup(404, "workspace not found"),
);
check(
  "caller: SUPERUSER is authorized past the 404 — refused only by target eligibility",
  await transfer(ALICE_WORKSPACE, su, { user: carol_id, current_owner: alice_id }),
  tup(400, "the new owner must be an active member of this workspace"),
);
check(
  "caller: owner Alice, unknown workspace id → 404, identical to a denial",
  await transfer(UNKNOWN_WS, alice, { user: bob_id }),
  tup(404, "workspace not found"),
);
// The `user` check reads no database, so it precedes the owner check (a transactional read) —
// a non-owner therefore sees this body 400, and it must not become an existence oracle.
check(
  "caller: Bob (non-owner) with no `user` → the body 400, SAME for an unknown workspace id",
  tup(await transfer(ALICE_WORKSPACE, bob, {}), await transfer(UNKNOWN_WS, bob, {})),
  tup(tup(400, "user is required"), tup(400, "user is required")),
);
// Naming yourself is judged only once the caller is known to be authorized, so a non-owner
// learns nothing here either — the answer is the same no-leak 404 a stranger gets.
check(
  "caller: Bob (non-owner) naming HIMSELF → the deny-404, SAME for an unknown workspace id",
  tup(
    await transfer(ALICE_WORKSPACE, bob, { user: bob_id }),
    await transfer(UNKNOWN_WS, bob, { user: bob_id }),
  ),
  tup(tup(404, "workspace not found"), tup(404, "workspace not found")),
);

// `current_owner` is a SUPERUSER operand; from anyone else it is ignored, and ignoring it must
// not turn it into an oracle — a right name and a wrong one buy the same 404.
check(
  "caller: Bob (non-owner) naming a current owner, right or wrong → the same deny-404",
  tup(
    await transfer(ALICE_WORKSPACE, bob, { user: alice_id, current_owner: alice_id }),
    await transfer(ALICE_WORKSPACE, bob, { user: alice_id, current_owner: bob_id }),
  ),
  tup(tup(404, "workspace not found"), tup(404, "workspace not found")),
);
check(
  "caller: …and that body is BYTE-IDENTICAL to the route's own unknown-id body",
  tup(
    await post_raw(transfer_path(ALICE_WORKSPACE), bob, { user: alice_id, current_owner: bob_id }),
    await post_raw(transfer_path(UNKNOWN_WS), bob, { user: alice_id, current_owner: bob_id }),
  ),
  tup(
    utf8('{"data":{},"message":"Workspace not found.","status":404}'),
    utf8('{"data":{},"message":"Workspace not found.","status":404}'),
  ),
);

console.log("\n── §2 BODY VALIDATION (owner caller) ──");
check(
  "body: `user` absent → 400",
  await transfer(ALICE_WORKSPACE, alice, {}),
  tup(400, "user is required"),
);
check(
  "body: `user` blank/whitespace → 400",
  await transfer(ALICE_WORKSPACE, alice, { user: "   " }),
  tup(400, "user is required"),
);
check(
  "body: `user` not a string → 400",
  await transfer(ALICE_WORKSPACE, alice, { user: 42 }),
  tup(400, "user is required"),
);
check(
  "body: `user` is the caller (self-transfer) → 400",
  await transfer(ALICE_WORKSPACE, alice, { user: alice_id }),
  tup(400, "the new owner is already the owner"),
);

console.log("\n── §3 TARGET ELIGIBILITY: an ACTIVE membership row, or 400 in plain language ──");
check(
  "target: Carol has no membership row → 400",
  tup(
    await roster(ALICE_WORKSPACE, carol_id, su),
    ...(await transfer(ALICE_WORKSPACE, alice, { user: carol_id })),
  ),
  tup(null, 400, "the new owner must be an active member of this workspace"),
);
const qs0 = urlencode({
  filter: `workspace='${esc(ALICE_WORKSPACE)}' && email='${esc(ivan_email)}'`,
});
const [, ivan_invites] = await api(
  "GET",
  `/api/collections/workspace_invitations/records?${qs0}`,
  su,
);
check(
  "target: Ivan has a pending invitation but NO membership row → 400 (an invitation confers nothing on its own)",
  tup(
    await roster(ALICE_WORKSPACE, ivan_id, su),
    (ivan_invites.items || []).length,
    ...(await transfer(ALICE_WORKSPACE, alice, { user: ivan_id })),
  ),
  tup(null, 1, 400, "the new owner must be an active member of this workspace"),
);
check(
  "target: Pia is a suspended ADMIN (role does not rescue the status) → 400",
  tup(
    await pia_suspended_admin.standing(),
    ...(await transfer(ALICE_WORKSPACE, alice, { user: pia_id })),
  ),
  tup(tup("admin", "suspended"), 400, "the new owner must be an active member of this workspace"),
);
check(
  "target: Sue is suspended → 400",
  tup(
    await sue_suspended.standing(),
    ...(await transfer(ALICE_WORKSPACE, alice, { user: sue_id })),
  ),
  tup(tup("member", "suspended"), 400, "the new owner must be an active member of this workspace"),
);
// A viewer IS an active member, so the membership refusal above would be a FALSE statement
// about one — the refusal names the real cause, and the read-only tier stays read-only.
const val_before = await roster_stamp(ALICE_WORKSPACE, val_id, su);
check(
  "target: Val is an ACTIVE viewer → 400 naming the viewer tier, not the membership refusal",
  tup(await val_viewer.now(), ...(await transfer(ALICE_WORKSPACE, alice, { user: val_id }))),
  tup("viewer", 400, "a viewer cannot be made the owner of this workspace"),
);
check(
  "target: the refused viewer's row was not written at all (role, status AND `updated`)",
  await roster_stamp(ALICE_WORKSPACE, val_id, su),
  val_before,
);
check(
  "target: after every refusal above, Alice still owns the workspace",
  await owner_of(ALICE_WORKSPACE, su),
  alice_id,
);
await pia_suspended_admin.done();
await sue_suspended.done();
await val_viewer.done();

console.log("\n── §4 TRANSFER to an active ADMIN (outgoing owner's roster row already EXISTS) ──");
// Every post-transfer assertion below rides the owner flip, so removing the route turns it
// RED: a row whose value is the same before and after would pass against no route at all.
check(
  "transfer→admin: before — Alice member/active (auto-provisioned), Dana admin/active",
  tup(await roster(ALICE_WORKSPACE, alice_id, su), await dana_admin.standing()),
  tup(tup("member", "active"), tup("admin", "active")),
);
await alice_owns.done();
await dana_admin.done();
const dana_before = await roster_stamp(ALICE_WORKSPACE, dana_id, su);
check(
  "transfer→admin: owner Alice hands the workspace to Dana",
  await api("POST", transfer_path(ALICE_WORKSPACE), alice, { user: dana_id }),
  tup(200, { ok: true }),
);
check("transfer→admin: workspaces.owner is now Dana", await owner_of(ALICE_WORKSPACE, su), dana_id);
check(
  "transfer→admin: outgoing owner Alice moved member → admin/active",
  await roster(ALICE_WORKSPACE, alice_id, su),
  tup("admin", "active"),
);
// mahh: ownership lives on workspaces.owner, so the roster row is the standing held BENEATH it.
// Paired with the owner flip, because "Dana is admin" reads the same before and after and would
// otherwise pass against a server with no transfer route at all.
check(
  "transfer→admin: owner is Dana AND her incoming row KEPT admin/active — no demotion",
  tup(await owner_of(ALICE_WORKSPACE, su), await roster(ALICE_WORKSPACE, dana_id, su)),
  tup(dana_id, tup("admin", "active")),
);
check(
  "transfer→admin: the incoming row was not written AT ALL (role, status AND `updated`)",
  await roster_stamp(ALICE_WORKSPACE, dana_id, su),
  dana_before,
);
check(
  "transfer→admin: Alice (now an admin, not the owner) may not transfer it back → 404",
  await transfer(ALICE_WORKSPACE, alice, { user: dana_id }),
  tup(404, "workspace not found"),
);

console.log("\n── §4b THE TRANSFER ABOVE IS ON THE RECORD: one audit row, one notice each ──");
const audit = await ownership_audit(ALICE_WORKSPACE, su);
// `operator` is read on this row too: an owner-initiated transfer must leave it EMPTY, or the
// reader would name a person who never touched it (decision-056).
check(
  "audit: ONE workspace-anchored row naming the actor, the outgoing owner and the incoming one",
  audit.map((a) =>
    tup(
      getitem(a, "actor"),
      a.operator ?? null,
      getitem(a, "field"),
      getitem(a, "from"),
      getitem(a, "to"),
      getitem(a, "task"),
    ),
  ),
  [tup(alice_id, "", "owner", json_dumps(alice_id), json_dumps(dana_id), "")],
);
check(
  "audit: the outgoing owner reads it on her OWN token — it is not superuser-only",
  (await ownership_audit(ALICE_WORKSPACE, alice)).map((a) => getitem(a, "id")),
  audit.map((a) => getitem(a, "id")),
);
check(
  "audit: Carol (non-member) reads nothing — the workspace leg is the read gate",
  await ownership_audit(ALICE_WORKSPACE, carol),
  [],
);
check(
  "notice: BOTH parties got exactly one unread notice naming the workspace, carrying no task",
  tup(
    (await ownership_notices(alice_id, su)).map((n) =>
      tup(getitem(n, "user"), getitem(n, "workspace"), getitem(n, "task"), getitem(n, "read")),
    ),
    (await ownership_notices(dana_id, su)).map((n) =>
      tup(getitem(n, "user"), getitem(n, "workspace"), getitem(n, "task"), getitem(n, "read")),
    ),
  ),
  tup([tup(alice_id, ALICE_WORKSPACE, "", false)], [tup(dana_id, ALICE_WORKSPACE, "", false)]),
);
check(
  "notice: the incoming owner reads her own notice on her OWN token",
  (await ownership_notices(dana_id, dana)).map((n) => getitem(n, "workspace")),
  [ALICE_WORKSPACE],
);
check(
  "notice: neither party can read the OTHER party's notice",
  tup(
    (await ownership_notices(alice_id, dana)).map((n) => getitem(n, "id")),
    (await ownership_notices(dana_id, alice)).map((n) => getitem(n, "id")),
  ),
  tup([], []),
);
// A recipient may mark a notice read; repointing it at another workspace is denied like the
// other locked fields, so a notice can never be made to name a workspace its reader never left.
const dana_notice = ((await ownership_notices(dana_id, dana))[0] ?? {}).id ?? null;
check(
  "notice: the recipient may mark it read but may NOT repoint it at another workspace",
  tup(
    (
      await api("PATCH", `/api/collections/notifications/records/${dana_notice}`, dana, {
        read: true,
      })
    )[0],
    (
      await api("PATCH", `/api/collections/notifications/records/${dana_notice}`, dana, {
        workspace: ALICE_WORKSPACE,
      })
    )[0],
  ),
  tup(200, 404),
);
// An audit trail that logs ATTEMPTS as facts lies about what happened: the writes sit inside
// the transaction a refusal aborts, so a refused transfer must leave nothing behind.
const audit_before = (await ownership_audit(ALICE_WORKSPACE, su)).length;
const notice_before = (await ownership_notices(alice_id, su)).length;
check(
  "record: a REFUSED transfer (Alice no longer owns it) writes no audit row and no notice",
  tup(
    await transfer(ALICE_WORKSPACE, alice, { user: bob_id }),
    (await ownership_audit(ALICE_WORKSPACE, su)).length,
    (await ownership_notices(alice_id, su)).length,
  ),
  tup(tup(404, "workspace not found"), audit_before, notice_before),
);

console.log("\n── §5 TRANSFER to a plain active MEMBER ──");
check("transfer→member: before — Bob is a plain member/active", await bob_member.now(), "member");
await bob_member.done();
const bob_before = await roster_stamp(ALICE_WORKSPACE, bob_id, su);
check(
  "transfer→member: owner Dana hands the workspace to Bob",
  await api("POST", transfer_path(ALICE_WORKSPACE), dana, { user: bob_id }),
  tup(200, { ok: true }),
);
// Paired with the owner flip on purpose: Bob's row reads member/active before AND after, so
// on its own this claim would pass against a server with no transfer route at all.
check(
  "transfer→member: owner is Bob AND his incoming row is member/active",
  tup(await owner_of(ALICE_WORKSPACE, su), await roster(ALICE_WORKSPACE, bob_id, su)),
  tup(bob_id, tup("member", "active")),
);
// The member-target half of mahh: keeping the prior role and rewriting it to member are the
// SAME observable value here, so only the untouched `updated` stamp separates them.
check(
  "transfer→member: his row was not written either (role, status AND `updated`)",
  await roster_stamp(ALICE_WORKSPACE, bob_id, su),
  bob_before,
);
check(
  "transfer→member: owner is Bob AND outgoing owner Dana moved member → admin/active",
  tup(await owner_of(ALICE_WORKSPACE, su), await roster(ALICE_WORKSPACE, dana_id, su)),
  tup(bob_id, tup("admin", "active")),
);

console.log("\n── §6 TRANSFER on a workspace whose owner has NO roster row (the row is MINTED) ──");
[s, r] = await api("POST", "/api/collections/workspaces/records", alice, {
  name: `Direct Workspace ${token_hex(3)}`,
  owner: alice_id,
});
check_in(
  "minted-row: Alice creates a workspace straight through the collections API",
  s,
  [200, 201],
);
const DIRECT_WS: string = r.id ?? null;
check(
  "minted-row: premise — a directly-created workspace has NO roster row for its owner",
  await roster(DIRECT_WS, alice_id, su),
  null,
);
await su_add_member(DIRECT_WS, bob_id, "member", "active", "Bob");
check(
  "minted-row: Alice hands the direct workspace to Bob",
  await api("POST", transfer_path(DIRECT_WS), alice, { user: bob_id }),
  tup(200, { ok: true }),
);
check("minted-row: workspaces.owner is now Bob", await owner_of(DIRECT_WS, su), bob_id);
check(
  "minted-row: outgoing owner Alice's row was CREATED as admin/active",
  await roster(DIRECT_WS, alice_id, su),
  tup("admin", "active"),
);
check(
  "minted-row: owner is Bob AND his incoming row is member/active",
  tup(await owner_of(DIRECT_WS, su), await roster(DIRECT_WS, bob_id, su)),
  tup(bob_id, tup("member", "active")),
);

console.log("\n── §7 THE SELF-DELETE DEAD-END IS CLOSED ──");
const [nate_id, nate_email] = await su_create_user("Nate");
const [nate] = await login(nate_email);
const NATE_WS = (await find_id("workspaces", "owner", nate_id, su))!;
check("dead-end: Nate has an auto-provisioned workspace", NATE_WS !== null, true);
const [nora_id] = await su_create_user("Nora");
await su_add_member(NATE_WS, nora_id, "member", "active", "Nora");
const nate_owns = await tierkit.owner_of_workspace(NATE_WS, nate_id, su, "Nate");

[s, r] = await api("DELETE", `/api/collections/users/records/${nate_id}`, nate);
check(
  "dead-end: sole owner of a shared workspace is REFUSED self-delete (400)",
  tup(await nate_owns.now(), s, wire(r)),
  tup(
    nate_id,
    400,
    "cannot delete account: you are the sole owner of a workspace that has other " +
      "members — transfer ownership or remove the other members first",
  ),
);
await nate_owns.done();
check(
  "dead-end: Nate transfers the workspace to Nora",
  await api("POST", transfer_path(NATE_WS), nate, { user: nora_id }),
  tup(200, { ok: true }),
);
check("dead-end: workspaces.owner is now Nora", await owner_of(NATE_WS, su), nora_id);
[s] = await api("DELETE", `/api/collections/users/records/${nate_id}`, nate);
check("dead-end: Nate now self-deletes successfully (204)", s, 204);
THROWAWAYS.splice(THROWAWAYS.indexOf(nate_id), 1);
[s] = await api("GET", `/api/collections/users/records/${nate_id}`, su);
check("dead-end: Nate's account is gone (superuser view → 404)", s, 404);

console.log("\n── §8 THE OUTGOING OWNER IS REINSTATED admin/active FROM A SUSPENDED ROW ──");
const [zoe_id, zoe_email] = await su_create_user("Zoe");
const [zoe] = await login(zoe_email);
const ZOE_WS = (await find_id("workspaces", "owner", zoe_id, su))!;
const [quinn_id] = await su_create_user("Quinn");
await su_add_member(ZOE_WS, quinn_id, "member", "active", "Quinn");
[s] = await api(
  "PATCH",
  `/api/collections/workspace_members/records/${(await roster_rows(ZOE_WS, zoe_id, su))[0].id}`,
  su,
  { role: "viewer", status: "suspended" },
);
check("suspended-owner: Zoe's own roster row is put at viewer/suspended", s, 200);
const zoe_suspended = await tierkit.actor_at_tier(ZOE_WS, zoe_id, "viewer", su, "Zoe", "suspended");
const zoe_owns = await tierkit.owner_of_workspace(ZOE_WS, zoe_id, su, "Zoe");
// Both tiers are closed BEFORE the transfer, which moves ownership and rewrites the row.
const zoe_standing = await zoe_suspended.standing();
await zoe_suspended.done();
await zoe_owns.done();
check(
  "suspended-owner: before — Zoe is viewer/suspended on the roster and still the owner",
  tup(zoe_standing, await owner_of(ZOE_WS, su)),
  tup(tup("viewer", "suspended"), zoe_id),
);
check(
  "suspended-owner: the transfer is accepted — owner authority is not membership-derived",
  await api("POST", transfer_path(ZOE_WS), zoe, { user: quinn_id }),
  tup(200, { ok: true }),
);
check(
  "suspended-owner: owner is Quinn AND Zoe's row went viewer/suspended → admin/active",
  tup(await owner_of(ZOE_WS, su), await roster(ZOE_WS, zoe_id, su)),
  tup(quinn_id, tup("admin", "active")),
);

console.log("\n── §9 CONCURRENCY: two simultaneous transfers by ONE owner of ONE workspace ──");
// Direct-created, so the outgoing row is MINTED — the shape that answered the loser with a raw
// validation_not_unique while the owner check and both roster reads sat outside the transaction.
[s, r] = await api("POST", "/api/collections/workspaces/records", alice, {
  name: `Race Workspace ${token_hex(3)}`,
  owner: alice_id,
});
check_in("concurrent: Alice creates a second direct workspace", s, [200, 201]);
const RACE_WS: string = r.id ?? null;
const [amy_id] = await su_create_user("Amy");
await su_add_member(RACE_WS, amy_id, "admin", "active", "Amy");
const [ben_id] = await su_create_user("Ben");
await su_add_member(RACE_WS, ben_id, "member", "active", "Ben");
const race_before: Record<string, any> = {};
for (const u of [amy_id, ben_id]) race_before[u] = await roster_stamp(RACE_WS, u, su);
const race = new Map<string, [number, string]>();

async function fire(target: string): Promise<void> {
  race.set(target, await transfer(RACE_WS, alice, { user: target }));
}

await Promise.all([amy_id, ben_id].map(fire));
check(
  "concurrent: exactly ONE of the two simultaneous transfers is accepted",
  [...race.values()].map(([status]) => status).sort((a, b) => a - b),
  [200, 404],
);
check(
  "concurrent: the loser gets the route's own deny-404, not a raw PocketBase error",
  [...race.values()].filter(([status]) => status !== 200).map(([, msg]) => msg),
  ["workspace not found"],
);
const race_won = await owner_of(RACE_WS, su);
const race_lost = race_won === amy_id ? ben_id : amy_id;
// Amy is an ADMIN and Ben a member, so a route that rewrote the incoming row to member would
// answer differently depending on which one won — under mahh NEITHER row is written at all.
check(
  "concurrent: the winner owns it and its row was never written (role, status AND `updated`)",
  tup([amy_id, ben_id].includes(race_won), await roster_stamp(RACE_WS, race_won, su)),
  tup(true, race_before[race_won]),
);
check(
  "concurrent: the LOSER's roster row was never written (role, status AND `updated`)",
  await roster_stamp(RACE_WS, race_lost, su),
  race_before[race_lost],
);
check(
  "concurrent: outgoing owner Alice got exactly ONE minted row, at admin/active",
  tup((await roster_rows(RACE_WS, alice_id, su)).length, await roster(RACE_WS, alice_id, su)),
  tup(1, tup("admin", "active")),
);

console.log("\n── §10 CONCURRENCY on a workspace whose owner ALREADY has a roster row ──");
// §9 races the MINT path; only the users-create auto-provision leaves the owner a row, so an
// auto-provisioned workspace is what races the UPDATE path — the one that can mint a SECOND row.
const [rex_id, rex_email] = await su_create_user("Rex");
const [rex] = await login(rex_email);
const REX_WS = (await find_id("workspaces", "owner", rex_id, su))!;
const rex_rows_before = await roster_rows(REX_WS, rex_id, su);
check(
  "provisioned-race: premise — Rex's own roster row exists, exactly one, member/active",
  tup(rex_rows_before.length, await roster(REX_WS, rex_id, su)),
  tup(1, tup("member", "active")),
);
const [sal_id] = await su_create_user("Sal");
await su_add_member(REX_WS, sal_id, "admin", "active", "Sal");
const [tom_id] = await su_create_user("Tom");
await su_add_member(REX_WS, tom_id, "member", "active", "Tom");
const prov_before: Record<string, any> = {};
for (const u of [sal_id, tom_id]) prov_before[u] = await roster_stamp(REX_WS, u, su);
const prov = new Map<string, [number, string]>();

async function fire_provisioned(target: string): Promise<void> {
  prov.set(target, await transfer(REX_WS, rex, { user: target }));
}

await Promise.all([sal_id, tom_id].map(fire_provisioned));
check(
  "provisioned-race: exactly ONE of the two simultaneous transfers is accepted",
  [...prov.values()].map(([status]) => status).sort((a, b) => a - b),
  [200, 404],
);
check(
  "provisioned-race: the loser gets the route's own deny-404, not a raw PocketBase error",
  [...prov.values()].filter(([status]) => status !== 200).map(([, msg]) => msg),
  ["workspace not found"],
);
// Expected as a LIST when the split is wrong, so a both-200 route mismatches instead of
// crashing the suite on an empty winner set.
const prov_winners = [...prov].filter(([, [status]]) => status === 200).map(([u]) => u);
const prov_owner = await owner_of(REX_WS, su);
check(
  "provisioned-race: workspaces.owner is the target of the ONE accepted call",
  prov_owner,
  prov_winners.length === 1 ? prov_winners[0] : prov_winners,
);
const prov_lost = prov_owner === sal_id ? tom_id : sal_id;
check(
  "provisioned-race: the LOSER's roster row was never written (role, status AND `updated`)",
  await roster_stamp(REX_WS, prov_lost, su),
  prov_before[prov_lost],
);
const rex_rows_after = await roster_rows(REX_WS, rex_id, su);
check(
  "provisioned-race: outgoing owner Rex's EXISTING row was updated to admin/active, no second",
  tup(
    rex_rows_after.length,
    await roster(REX_WS, rex_id, su),
    rex_rows_after.length ? getitem(rex_rows_after[0], "id") : null,
  ),
  tup(1, tup("admin", "active"), rex_rows_before.length ? getitem(rex_rows_before[0], "id") : null),
);

console.log("\n── §11 A TRASHED WORKSPACE REFUSES ITS OWN OWNER IN PLAIN LANGUAGE ──");
const TRASH_MSG = "this workspace is in the trash; restore it before transferring ownership";
const [tess_id, tess_email] = await su_create_user("Tess");
const [tess] = await login(tess_email);
const TESS_WS = (await find_id("workspaces", "owner", tess_id, su))!;
check("trashed: Tess has an auto-provisioned workspace", TESS_WS !== null, true);
const [toby_id, toby_email] = await su_create_user("Toby");
const [toby] = await login(toby_email);
await su_add_member(TESS_WS, toby_id, "member", "active", "Toby");
[s] = await api("DELETE", `/api/collections/workspaces/records/${TESS_WS}`, tess);
check(
  "trashed: Tess trashes her own workspace (204) and it is trashed, not gone",
  tup(
    s,
    (await api("GET", `/api/collections/workspaces/records/${TESS_WS}`, su))[1].trashed !== "",
  ),
  tup(204, true),
);
check(
  "trashed: owner Tess is refused in PLAIN LANGUAGE (400), not the deny-404",
  await transfer(TESS_WS, tess, { user: toby_id }),
  tup(400, TRASH_MSG),
);
check(
  "trashed: a superuser gets that same 400 — the trash is not a rule it can bypass",
  await transfer(TESS_WS, su, { user: toby_id, current_owner: tess_id }),
  tup(400, TRASH_MSG),
);
// Naming yourself is not a shortcut past the trash: the cause the caller is told must be the
// one that actually blocks the handover, or the refusal names a cure that does not apply.
check(
  "trashed: owner Tess naming HERSELF gets the TRASH cause, not the already-the-owner 400",
  await transfer(TESS_WS, tess, { user: tess_id }),
  tup(400, TRASH_MSG),
);
check(
  "trashed: a superuser naming its OWN id gets that same trash cause",
  await transfer(TESS_WS, su, { user: su_id, current_owner: tess_id }),
  tup(400, TRASH_MSG),
);
check(
  "trashed: a superuser naming the WRONG current owner still reads the TRASH cause first",
  await transfer(TESS_WS, su, { user: toby_id, current_owner: toby_id }),
  tup(400, TRASH_MSG),
);
check(
  "trashed: both refusals moved nobody — Tess still owns it, Toby is still a plain member",
  tup(await owner_of(TESS_WS, su), await roster(TESS_WS, toby_id, su)),
  tup(tess_id, tup("member", "active")),
);
// The escape this closes: trash the workspace, dump it on another member, then self-delete
// while the workspace lives on under its new owner.
[s, r] = await api("DELETE", `/api/collections/users/records/${tess_id}`, tess);
check(
  "trashed: the escape is closed — Tess is STILL refused self-delete by the sole-owner guard",
  tup(s, wire(r)),
  tup(
    400,
    "cannot delete account: you are the sole owner of a workspace in the trash " +
      "that has other members — restore it first, then hand it to someone else or " +
      "remove the other members",
  ),
);
check(
  "trashed: Tess's account survived the refused self-delete (superuser view → 200)",
  (await api("GET", `/api/collections/users/records/${tess_id}`, su))[0],
  200,
);
check(
  "trashed: Toby (plain member) gets the deny-404, never the trash cause — no existence leak",
  await transfer(TESS_WS, toby, { user: tess_id }),
  tup(404, "workspace not found"),
);
check(
  "trashed: …and Toby's body is BYTE-IDENTICAL to the route's own unknown-id body",
  tup(
    await post_raw(transfer_path(TESS_WS), toby, { user: tess_id }),
    await post_raw(transfer_path(UNKNOWN_WS), toby, { user: tess_id }),
  ),
  tup(
    utf8('{"data":{},"message":"Workspace not found.","status":404}'),
    utf8('{"data":{},"message":"Workspace not found.","status":404}'),
  ),
);
// The refusal names the cure, so the cure is proven: restore, and the identical call lands.
[s] = await api("PATCH", `/api/collections/workspaces/records/${TESS_WS}`, tess, { trashed: "" });
check("trashed: Tess restores the workspace → 200", s, 200);
check(
  "trashed: the identical transfer is now accepted and Toby owns it",
  tup(
    await api("POST", transfer_path(TESS_WS), tess, { user: toby_id }),
    await owner_of(TESS_WS, su),
  ),
  tup(tup(200, { ok: true }), toby_id),
);

console.log("\n── §12 THE HAND-BACK: THE TEMPORARY OWNER KEEPS ADMIN ──");
// Continues §11's pair: Tess handed the workspace to Toby, so this is the A → B → A leg.
check(
  "hand-back: before — Toby owns it, outgoing Tess is admin/active, Toby member/active",
  tup(
    await owner_of(TESS_WS, su),
    await roster(TESS_WS, tess_id, su),
    await roster(TESS_WS, toby_id, su),
  ),
  tup(toby_id, tup("admin", "active"), tup("member", "active")),
);
check(
  "hand-back: Toby hands the workspace straight back to Tess",
  await api("POST", transfer_path(TESS_WS), toby, { user: tess_id }),
  tup(200, { ok: true }),
);
check(
  "hand-back: Toby's FINAL role is admin — handing it back does NOT undo his promotion",
  await roster(TESS_WS, toby_id, su),
  tup("admin", "active"),
);
// Under mahh the incoming row is not written, so A → B → A leaves BOTH at admin: the standing
// each was given for relinquishing ownership is not taken back by receiving it again. Before
// mahh Tess landed back at member, and only the outgoing arm's write made her an admin again.
check(
  "hand-back: Tess owns it again and KEEPS the admin standing the first handover gave her",
  tup(await owner_of(TESS_WS, su), await roster(TESS_WS, tess_id, su)),
  tup(tess_id, tup("admin", "active")),
);
check(
  "hand-back: Toby is an admin who does not own it, so he cannot transfer it → 404",
  await transfer(TESS_WS, toby, { user: tess_id }),
  tup(404, "workspace not found"),
);

console.log("\n── §13 A SUPERUSER TRANSFERS THROUGH THIS ROUTE, REWRITING BOTH ROSTER ROWS ──");
const [ollie_id] = await su_create_user("Ollie");
const OLLIE_WS = (await find_id("workspaces", "owner", ollie_id, su))!;
const [nina_id] = await su_create_user("Nina");
await su_add_member(OLLIE_WS, nina_id, "member", "active", "Nina");
const ollie_before = (await roster_stamp(OLLIE_WS, ollie_id, su))!;
check(
  "superuser: before — Ollie owns it and holds his auto-provisioned member/active row",
  tup(await owner_of(OLLIE_WS, su), tup(...ollie_before.slice(0, 2))),
  tup(ollie_id, tup("member", "active")),
);
check(
  "superuser: naming the CURRENT owner → 400, the same string the owner branch answers with",
  await transfer(OLLIE_WS, su, { user: ollie_id, current_owner: ollie_id }),
  tup(400, "the new owner is already the owner"),
);
// Unguarded, that no-op call writes ONE row twice (member, then admin) and leaves its subject
// owner AND admin — `updated` moves on any save, so an unchanged triple proves it did not run.
check(
  "superuser: …and the named owner's row was not written at all (role, status AND `updated`)",
  await roster_stamp(OLLIE_WS, ollie_id, su),
  ollie_before,
);
// The caller id of a superuser is a _superusers record, so it can never hold a membership row —
// the refusal must say that, not tell the superuser it already owns someone else's workspace.
const ollie_roster_before = await roster_all(OLLIE_WS, su);
check(
  "superuser: naming its OWN _superusers id → 400 on ELIGIBILITY, not already-the-owner",
  await transfer(OLLIE_WS, su, { user: su_id, current_owner: ollie_id }),
  tup(400, "the new owner must be an active member of this workspace"),
);
check(
  "superuser: …and that refusal wrote nothing — the roster and the owner are untouched",
  tup(
    await roster_all(OLLIE_WS, su),
    await owner_of(OLLIE_WS, su),
    await roster_rows(OLLIE_WS, su_id, su),
  ),
  tup(ollie_roster_before, ollie_id, []),
);
// The operand a superuser is judged against comes from its own body, so an absent one is a body
// refusal: it reads no database and therefore answers a real and an unknown workspace id alike.
check(
  "superuser: `current_owner` absent → 400, SAME for an unknown workspace id",
  tup(
    await transfer(OLLIE_WS, su, { user: nina_id }),
    await transfer(UNKNOWN_WS, su, { user: nina_id }),
  ),
  tup(tup(400, CURRENT_OWNER_MSG), tup(400, CURRENT_OWNER_MSG)),
);
check(
  "superuser: `current_owner` blank/whitespace → that same 400",
  await transfer(OLLIE_WS, su, { user: nina_id, current_owner: "   " }),
  tup(400, CURRENT_OWNER_MSG),
);
check(
  "superuser: naming the WRONG current owner on a healthy workspace → 400, nothing moved",
  tup(
    await transfer(OLLIE_WS, su, { user: nina_id, current_owner: nina_id }),
    await owner_of(OLLIE_WS, su),
    await roster_all(OLLIE_WS, su),
  ),
  tup(tup(400, STALE_OWNER_MSG), ollie_id, ollie_roster_before),
);
check(
  "superuser: the superuser hands Ollie's workspace to Nina",
  await api("POST", transfer_path(OLLIE_WS), su, { user: nina_id, current_owner: ollie_id }),
  tup(200, { ok: true }),
);
check(
  "superuser: owner is Nina; Ollie UPDATED to admin/active, Nina member/active, no third row",
  tup(await owner_of(OLLIE_WS, su), await roster_all(OLLIE_WS, su)),
  tup(nina_id, { [ollie_id]: tup("admin", "active"), [nina_id]: tup("member", "active") }),
);
check(
  "superuser: no roster row was minted for the _superusers caller id",
  await roster_rows(OLLIE_WS, su_id, su),
  [],
);
// decision-056 — a superuser caller id belongs to _superusers, so it can never fill `actor` (a
// users relation); the identity rides `operator` instead, and the two are mutually exclusive:
// a row carrying neither would be an unattributed handover.
check(
  "superuser audit: ONE row naming the OPERATOR by email, with the actor left empty",
  (await ownership_audit(OLLIE_WS, su)).map((a) =>
    tup(
      a.actor ?? null,
      a.operator ?? null,
      getitem(a, "field"),
      getitem(a, "from"),
      getitem(a, "to"),
      getitem(a, "task"),
    ),
  ),
  [tup("", SU_EMAIL, "owner", json_dumps(ollie_id), json_dumps(nina_id), "")],
);
check(
  "superuser: the audit row names NO actor — a _superusers id is not a users relation",
  (await ownership_audit(OLLIE_WS, su)).map((a) =>
    tup(getitem(a, "actor"), getitem(a, "field"), getitem(a, "from"), getitem(a, "to")),
  ),
  [tup("", "owner", json_dumps(ollie_id), json_dumps(nina_id))],
);
check(
  "superuser: both parties were still notified, one notice each",
  [...(await ownership_notices(ollie_id, su)), ...(await ownership_notices(nina_id, su))]
    .map((n) => getitem(n, "user"))
    .sort(by_code_point),
  [nina_id, ollie_id].sort(by_code_point),
);
const [ursa_id] = await su_create_user("Ursa");
[s, r] = await api("POST", "/api/collections/workspaces/records", su, {
  name: `Superuser Direct Workspace ${token_hex(3)}`,
  owner: ursa_id,
});
check_in(
  "superuser-mint: a workspace is created straight through the collections API",
  s,
  [200, 201],
);
const SU_DIRECT_WS: string = r.id ?? null;
check(
  "superuser-mint: premise — that workspace has NO roster row for its owner Ursa",
  await roster(SU_DIRECT_WS, ursa_id, su),
  null,
);
const [vera_id] = await su_create_user("Vera");
await su_add_member(SU_DIRECT_WS, vera_id, "member", "active", "Vera");
check(
  "superuser-mint: the superuser hands that workspace to Vera",
  await api("POST", transfer_path(SU_DIRECT_WS), su, { user: vera_id, current_owner: ursa_id }),
  tup(200, { ok: true }),
);
check(
  "superuser-mint: owner is Vera; outgoing owner Ursa's row was CREATED as admin/active",
  tup(await owner_of(SU_DIRECT_WS, su), await roster_all(SU_DIRECT_WS, su)),
  tup(vera_id, { [ursa_id]: tup("admin", "active"), [vera_id]: tup("member", "active") }),
);

console.log("\n── §14 CONCURRENCY: simultaneous SUPERUSER transfers, one operand, one winner ──");
// §9/§10 race an OWNER, whose loser is refused by the owner check itself. A superuser is
// authorized past that check, so what separates a superuser field is the `current_owner` it
// names: exactly one call can be naming the owner the transaction actually finds.
const [wes_id] = await su_create_user("Wes");
[s, r] = await api("POST", "/api/collections/workspaces/records", su, {
  name: `Superuser Race Workspace ${token_hex(3)}`,
  owner: wes_id,
});
check_in("su-race: a workspace is created straight through the collections API", s, [200, 201]);
const SU_RACE_WS: string = r.id ?? null;
const SU_RACE_WIDTH = 8; // every extra caller is one more chance for a second acceptance to show
const su_race_targets: string[] = [];
for (let i = 0; i < SU_RACE_WIDTH; i++) su_race_targets.push((await su_create_user(`Race${i}`))[0]);

/** Back to the starting position: Wes owns it, the targets are its only member/active rows. */
async function su_race_reset(): Promise<void> {
  const qs = urlencode({ filter: `workspace='${SU_RACE_WS}'`, perPage: 50 });
  const [, listing] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
  for (const row of listing.items || []) {
    await api("DELETE", `/api/collections/workspace_members/records/${row.id}`, su);
  }
  await api("PATCH", `/api/collections/workspaces/records/${SU_RACE_WS}`, su, { owner: wes_id });
  for (const member of su_race_targets) {
    await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: SU_RACE_WS,
      user: member,
      role: "member",
      status: "active",
    });
  }
}

// Held to a handful of rounds ON PURPOSE: the property is deterministic, and the app_settings
// rate limit is a shared budget for the whole suite. The heavy idle/under-load replication runs
// outside this file.
const SU_RACE_ROUNDS = 5;
const su_race_accepted: number[] = [];
const su_race_refusals = new Set<string>();
const su_race_winner_owns: boolean[] = [];
const su_race_losers_unwritten: boolean[] = [];
const su_race_superuser_rows: any[][] = [];
for (let _round = 0; _round < SU_RACE_ROUNDS; _round++) {
  await su_race_reset();
  const su_race_before: Record<string, any> = {};
  for (const u of su_race_targets) su_race_before[u] = await roster_stamp(SU_RACE_WS, u, su);
  // all callers leave together; a staggered field proves nothing
  let arrived = 0;
  let open: () => void = () => {};
  const su_race_gate = new Promise<void>((resolve) => (open = resolve));
  const su_race_got = new Map<string, [number, string]>();

  const fire_superuser = async (target: string): Promise<void> => {
    if (++arrived === SU_RACE_WIDTH) open();
    await su_race_gate;
    su_race_got.set(
      target,
      await transfer(SU_RACE_WS, su, { user: target, current_owner: wes_id }),
    );
  };

  await Promise.all(su_race_targets.map(fire_superuser));
  su_race_accepted.push([...su_race_got.values()].filter(([status]) => status === 200).length);
  for (const [status, msg] of su_race_got.values()) if (status !== 200) su_race_refusals.add(msg);
  const su_race_owner = await owner_of(SU_RACE_WS, su);
  su_race_winner_owns.push(su_race_targets.includes(su_race_owner));
  let unwritten = true;
  for (const u of su_race_targets) {
    if (u === su_race_owner) continue;
    if (!Bun.deepEquals(await roster_stamp(SU_RACE_WS, u, su), su_race_before[u], true)) {
      unwritten = false;
      break;
    }
  }
  su_race_losers_unwritten.push(unwritten);
  su_race_superuser_rows.push(await roster_rows(SU_RACE_WS, su_id, su));
}

check(
  `su-race: exactly ONE of ${SU_RACE_WIDTH} simultaneous superuser transfers is accepted, ` +
    `all ${SU_RACE_ROUNDS} rounds`,
  su_race_accepted,
  Array(SU_RACE_ROUNDS).fill(1),
);
check(
  "su-race: every refusal names the operand, never a raw PocketBase error",
  [...su_race_refusals].sort(by_code_point),
  [STALE_OWNER_MSG],
);
check(
  "su-race: the winner owns the workspace after every round",
  su_race_winner_owns,
  Array(SU_RACE_ROUNDS).fill(true),
);
check(
  "su-race: EVERY loser's roster row was left unwritten (role, status AND `updated`)",
  su_race_losers_unwritten,
  Array(SU_RACE_ROUNDS).fill(true),
);
check(
  "su-race: no roster row was ever minted for the _superusers caller id",
  su_race_superuser_rows,
  Array.from({ length: SU_RACE_ROUNDS }, () => []),
);

console.log("\n── §15 THE OPERATOR RECIPE FOR THE SUPERUSER PATH ──");
// The route requires a superuser to name the owner it believes is current, and nothing in web/
// or scripts/ could send it (kca7). The recipe READS that owner, so the operator never types it.
const [gus_id, gus_email] = await su_create_user("Gus");
const GUS_WS = (await find_id("workspaces", "owner", gus_id, su))!;
check("recipe: Gus has an auto-provisioned workspace", GUS_WS !== null, true);
const [hal_id] = await su_create_user("Hal");
await su_add_member(GUS_WS, hal_id, "admin", "active", "Hal");
const [ida_id] = await su_create_user("Ida");
await su_add_member(GUS_WS, ida_id, "member", "active", "Ida");
const recipe_env = {
  ...process.env,
  PB_URL: PB,
  PB_SUPERUSER_EMAIL: SU_EMAIL,
  PB_SUPERUSER_PASSWORD: SU_PASSWORD,
};

async function run_recipe(
  ...args: string[]
): Promise<{ returncode: number; stdout: string; stderr: string }> {
  // a non-zero exit is an assertion here, not a crash
  const proc = Bun.spawn([process.execPath, HELPER, ...args], {
    env: recipe_env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, returncode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { returncode, stdout, stderr };
}

const dry = await run_recipe("--workspace", GUS_WS, "--to", hal_id);
check(
  "recipe: the dry run reports the owner it read and writes nothing",
  tup(dry.returncode, dry.stdout.includes(`owner is ${gus_id}`), dry.stdout.includes("dry run")),
  tup(0, true, true),
);
check("recipe: …and the workspace is untouched by it", await owner_of(GUS_WS, su), gus_id);
const done = await run_recipe("--workspace", GUS_WS, "--to", hal_id, "--yes");
// Hal is an ADMIN, so this is mahh through the recipe too: the incoming owner keeps admin.
check(
  "recipe: --yes transfers end to end, the operator never naming the current owner",
  tup(
    done.returncode,
    await owner_of(GUS_WS, su),
    await roster(GUS_WS, gus_id, su),
    await roster(GUS_WS, hal_id, su),
  ),
  tup(0, hal_id, tup("admin", "active"), tup("admin", "active")),
);
check(
  "recipe: the transfer it performed is on the record like any other",
  (await ownership_audit(GUS_WS, su)).map((a) =>
    tup(getitem(a, "field"), getitem(a, "actor"), getitem(a, "from"), getitem(a, "to")),
  ),
  [tup("owner", "", json_dumps(gus_id), json_dumps(hal_id))],
);
const back = await run_recipe("--workspace", GUS_WS, "--to", gus_email, "--yes");
check(
  "recipe: --to accepts an EMAIL and hands the workspace back",
  tup(back.returncode, await owner_of(GUS_WS, su)),
  tup(0, gus_id),
);
const refused = await run_recipe("--workspace", GUS_WS, "--to", carol_id, "--yes");
check(
  "recipe: a server refusal is reported on stderr and exits non-zero, moving nothing",
  tup(
    refused.returncode,
    refused.stderr.includes("must be an active member"),
    await owner_of(GUS_WS, su),
  ),
  tup(1, true, gus_id),
);
// The race current_owner exists for, FORCED rather than waited on: the owner changes between
// the recipe's read and its send, driven step by step so nothing sleeps and hopes.
const stale_owner = await operator_recipe.read_owner(PB, su, GUS_WS);
[s] = await api("PATCH", `/api/collections/workspaces/records/${GUS_WS}`, su, { owner: hal_id });
check("recipe-race: the owner is changed underneath the recipe, after its read", s, 200);
const [stale_status, stale_body] = await operator_recipe.send_transfer(
  PB,
  su,
  GUS_WS,
  ida_id,
  stale_owner,
);
check(
  "recipe-race: the send is refused with the STALE-OWNER shape, and Ida was never made owner",
  tup(stale_owner, stale_status, wire(stale_body), await owner_of(GUS_WS, su)),
  tup(gus_id, 400, STALE_OWNER_MSG, hal_id),
);
check(
  "recipe-race: the refused send left no audit row and no notice for Ida",
  tup(
    (await ownership_audit(GUS_WS, su)).map((a) => getitem(a, "to")),
    await ownership_notices(ida_id, su),
  ),
  tup([json_dumps(hal_id), json_dumps(gus_id)], []),
);
// Re-reading is the cure the refusal names, so the cure is proven.
const rerun = await run_recipe("--workspace", GUS_WS, "--to", ida_id, "--yes");
check(
  "recipe-race: re-running the recipe re-reads the new owner and succeeds",
  tup(rerun.returncode, await owner_of(GUS_WS, su)),
  tup(0, ida_id),
);

console.log("\n── cleanup ──");
[s] = await api("DELETE", `/api/collections/workspaces/records/${DIRECT_WS}`, su);
check("cleanup: direct workspace deleted", s, 204);
[s] = await api("DELETE", `/api/collections/workspaces/records/${RACE_WS}`, su);
check("cleanup: race workspace deleted", s, 204);
[s] = await api("DELETE", `/api/collections/workspaces/records/${SU_DIRECT_WS}`, su);
check("cleanup: superuser-transferred direct workspace deleted", s, 204);
[s] = await api("DELETE", `/api/collections/workspaces/records/${SU_RACE_WS}`, su);
check("cleanup: superuser-race workspace deleted", s, 204);
for (const uid of THROWAWAYS) {
  if (uid) {
    [s] = await api("DELETE", `/api/collections/users/records/${uid}`, su);
    check(`cleanup: superuser deletes throwaway user ${uid}`, s, 204);
  }
}

await tierkit.verify_tiers();

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} FAILED: ${py_str(FAILS)}`);
  process.exit(1);
}
console.log("✅ all ownership-transfer proofs passed");
process.exit(0);

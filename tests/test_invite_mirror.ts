#!/usr/bin/env bun
/**
 * E2E proof that POST /api/tracker/workspaces/{id}/resolve-member-email is an INVITATION, not an
 * email-to-user-id oracle, and that the slice of `workspace_invitations.createRule` (decision:invitation-keyed-by-email;
 * a membership row is now minted only by the accept route) it has to mirror really is mirrored.
 *
 * The route used to answer `{user_id}` to any caller who owned or actively administered the
 * workspace named in the PATH. Every signup auto-provisions a workspace, so every account cleared
 * that gate against its own workspace and could resolve any registered address to a user id. The
 * route now performs the invitation itself and answers a body that does not vary with the address.
 *
 * Five things are proven against a live server:
 *
 * (0a) THE ROLE ALLOW-LIST IS THE FIELD'S OWN — the route's hand-written list of acceptable roles
 *     is parsed out of its source and asserted equal to the values the live `role` select field
 *     declares. A value the list still accepts after a migration drops it passes every check in
 *     the route, fails at the save for a non-collision reason and re-throws: 400 for a registered
 *     address, 200 for an unregistered one. The differential matrix below CANNOT see that — both
 *     of its arms refuse such a cell and agree.
 * (1) NO ORACLE — every shape the route can be asked (registered, unregistered, already invited,
 *     the caller's own address, with and without a role, in a different case, whitespace-padded)
 *     is compared for status AND body, and every response is scanned for a record id in ANY
 *     header and anywhere in the body. The id
 *     SHAPE is derived from an id this server minted, so the scan cannot be satisfied by one
 *     hand-copied id going missing. Where a shape should land a row, the row is asserted — a
 *     uniform answer that is uniform because nothing happened proves nothing.
 * (2) THE RULE MIRROR, DIFFERENTIALLY — the route cannot ask PocketBase to evaluate the createRule
 *     for it ($app.canAccessRecord re-queries the PERSISTED row by id, so an unsaved record
 *     resolves against nothing and every rule, including a trivially true one, reads false), so the
 *     admin branch's `@request.body.role = "member"` conjunct is mirrored in the route (decision:invitation-keyed-by-email
 *     moved the createRule this mirrors from workspace_members onto workspace_invitations — a
 *     membership row is now minted only by the accept route, never by a direct create). The 21-cell
 *     matrix is 7 minting principals (owner, active admin, suspended admin, an admin-invitee who
 *     holds a PENDING admin invitation but no membership row at all, active member, active viewer,
 *     stranger) x 3 minted roles (member, admin, viewer). Every cell runs BOTH a direct
 *     workspace_invitations create (the live rule decides) and the route (the mirror decides); they
 *     must agree cell for cell, AND each cell's OWN expected allow/refuse is asserted by name — all
 *     seven principals share ONE workspace that also holds the active and suspended admin, so a rule
 *     whose `?=` conjuncts matched across DIFFERENT membership rows (an active member passing
 *     `role ?= "admin"` via someone else's row) would show as a wrong allow, not just a disagreement
 *     between the two arms.
 * (3) A REPEAT INVITATION IS INDISTINGUISHABLE FROM A FIRST ONE — the colliding row is minted by
 *     the caller's own first request, so a second answer that differed would separate registered
 *     from unregistered in two round trips with no roster read at all. The stale-write key the
 *     route cannot honour is refused here exactly as a direct collection create refuses it.
 * (4) WHY THE ROUTE EXISTS — `users.emailVisibility=false` excludes `email` from non-superuser
 *     FILTER matching, so a filtered lookup returns an empty 200 for every caller, including one
 *     filtering for their OWN address.
 *
 * Closed by decision:invitation-keyed-by-email (tests/test_invitations.ts's AC3 probe): the inviter's OWN roster
 * (workspace_members?expand=user) no longer gains a row for a registered address either — every
 * invite lands in workspace_invitations regardless of account existence, and the roster stays
 * byte-identical before/after. Read the uniformity below as a property of the ROUTE.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8144 + PB_PORT_OFFSET (suite self-boot band, .agents/rules/ports.md).
 */

// COVERS: route:POST /api/tracker/workspaces/{id}/resolve-member-email
// COVERS: rule:workspace_invitations.create

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  json_dumps,
  py_get,
  py_repr,
  py_split,
  py_str,
  read_text,
  run_checked,
  truthy,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const PORT = 8144 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const MEMBERS = "/api/collections/workspace_members/records";
const INVITATIONS = "/api/collections/workspace_invitations/records";
// The route's registered path, spelled as pb_hooks/routes.pb.js spells it — the anchor the
// allow-list parse below locates its handler by.
const ROUTE_PATH = "/api/tracker/workspaces/{id}/resolve-member-email";
// A stale-write key names an instant; any well-formed value is refused on a create, so the
// value here only has to be well-formed to prove the refusal is about the KEY.
const STALE_KEY_VALUE = "2026-01-01 00:00:00.000Z";

let failures = 0;

// Set once a real record id exists to derive it from — see "(0b) the disclosure scanner".
let PB_ID: RegExp | null = null;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

function check_in(label: string, got: any, allowed: any[]): void {
  const ok = allowed.some((a) => Bun.deepEquals(got, a, true));
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want one of ${py_repr(allowed)})`,
  );
}

// (status, body, headers). The HEADERS are returned because a disclosure does not have to
// ride the body — a suite that discarded them passed a route leaking the resolved id in one.
async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any, [string, string][]]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  let raw: Uint8Array;
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  const hdrs = [...r.headers.entries()] as [string, string][];
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (r.ok) return [r.status, raw.length ? JSON.parse(text) : {}, hdrs];
  try {
    return [r.status, raw.length ? JSON.parse(text) : {}, hdrs];
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return [r.status, { raw: Array.from(text).slice(0, 300).join("") }, hdrs];
  }
}

function pb_findall(s: string): string[] {
  return [...s.matchAll(PB_ID!)].map((m) => m[0]);
}

// EVERY call to the invite route goes through here, so the three disclosure assertions run
// on every shape the suite exercises rather than the few someone remembered to check.
// Returns (status, body) — the pair that must not vary with the address.
async function invite(
  label: string,
  route: string,
  tok: string | null,
  payload: any,
): Promise<[number, any]> {
  const [s, body, headers] = await api("POST", route, tok, payload);
  const leaky = headers.filter(([, v]) => pb_findall(py_str(v)).length > 0).map(([k]) => k);
  leaky.sort(by_code_point);
  check(`${label}: no record id in any response header`, leaky, []);
  check(`${label}: no record id anywhere in the body`, pb_findall(json_dumps(body)), []);
  if (s === 200) {
    check(
      `${label}: the 200 body is EXACTLY the acknowledgement`,
      tup(Object.keys(body).sort(by_code_point), body),
      tup(["invited"], { invited: true }),
    );
  }
  return tup(s, body);
}

// The role values pb_hooks/routes.pb.js accepts, parsed out of the route source at run
// time. Re-typing them here would only relocate the hand-written list this check exists to
// catch. Returns (values, condition) so a failure can print the source it read.
function route_allowed_roles(): [string[], string | null] {
  const src = read_text(path.join(REPO_ROOT, "pb_hooks", "routes.pb.js"));
  const at = src.indexOf(`"POST ${ROUTE_PATH}"`);
  if (at === -1) throw new Error("ValueError: substring not found");
  let handler = src.slice(at);
  const nxt = handler.indexOf("\nrequire(");
  if (nxt !== -1) handler = handler.slice(0, nxt);
  const m = /if \(([^()]*role !== [^()]*)\)\s*throw new BadRequestError/.exec(handler);
  if (!m) return [[], null];
  const cond = py_split(m[1]).join(" ");
  return [[...cond.matchAll(/role !== "([^"]+)"/g)].map((x) => x[1]), cond];
}

// The role select field's values as the RUNNING server declares them — schema/ is
// generated, and it is the live collection the route's list is actually checked against.
async function declared_roles(token: string): Promise<string[]> {
  const [, coll] = await api("GET", "/api/collections/workspace_invitations", token);
  for (const field of coll.fields || []) {
    if (field.name === "role") return field.values || [];
  }
  return [];
}

async function login(email: string, password = "test123456"): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: password,
  });
  return [roomkit.token_of(BASE_URL, email, r), getitem(getitem(r, "record"), "id")];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-invite-mirror-test-"));
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

  // ══════════════════ 0a. the route's allow-list IS the field's declared values ════════
  // A value the route still accepts after the field stops declaring it passes the role
  // check, passes the owner/admin mirror, reaches e.app.save() and fails for a
  // NON-collision reason, so the collision swallow re-throws it: 400 for a registered
  // address, 200 for an unregistered one. That is the oracle this route exists to close,
  // re-opened by an unrelated migration — and section (1) cannot see it, because both
  // sides of its comparison are refusals.
  console.log("\n── (0a) the route's role allow-list equals the collection's declared values ──");
  const [allowed, condition] = route_allowed_roles();
  const declared = await declared_roles(su);
  console.log(`     route source  → ${py_str(condition)}`);
  console.log(`     route allows  → ${py_str([...allowed].sort(by_code_point))}`);
  console.log(`     field declares→ ${py_str([...declared].sort(by_code_point))}`);
  check("the allow-list was PARSED out of the route source, not assumed", truthy(allowed), true);
  check(
    "…and the parse read the WHOLE condition — no clause silently dropped",
    condition,
    truthy(allowed) ? allowed.map((r) => `role !== "${r}"`).join(" && ") : condition,
  );
  check("the live role field declares values at all", truthy(declared), true);
  const allowed_set = [...new Set(allowed)].sort(by_code_point);
  const declared_set = [...new Set(declared)].sort(by_code_point);
  check("the route accepts exactly the roles the live field declares", allowed_set, declared_set);
  if (!Bun.deepEquals(allowed_set, declared_set, true)) {
    console.log(
      `     ONLY the route accepts: ${py_str(allowed_set.filter((x) => !declared_set.includes(x)).sort(by_code_point))}`,
    );
    console.log(
      `     ONLY the field declares: ${py_str(declared_set.filter((x) => !allowed_set.includes(x)).sort(by_code_point))}`,
    );
  }

  console.log("\n── seed: alice/bob fixtures (scripts/seed.ts) ──");
  const seed_proc = Bun.spawn([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: BASE_URL,
      PB_SUPERUSER_EMAIL: SU_EMAIL,
      PB_SUPERUSER_PASSWORD: SU_PASSWORD,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [seed_out, seed_err, seed_rc] = await Promise.all([
    new Response(seed_proc.stdout).text(),
    new Response(seed_proc.stderr).text(),
    seed_proc.exited,
  ]);
  check("seed.ts exit code", seed_rc, 0);
  if (seed_rc !== 0) {
    console.log(seed_out, seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const [alice, alice_id] = await login("alice@example.com");

  const ACCOUNTS: string[] = [];

  async function mkuser(tag: string, label: string): Promise<[string, string]> {
    const email = `invite-mirror-${tag}@example.test`;
    const [s, made] = await api("POST", "/api/collections/users/records", su, {
      email: email,
      password: "test123456",
      passwordConfirm: "test123456",
      name: `Mirror ${label}`,
      verified: true,
      approved: true,
    });
    check_in(`setup: superuser mints the ${label} account`, s, tup(200, 201));
    ACCOUNTS.push(getitem(made, "id"));
    return [getitem(made, "id"), email];
  }

  // Superuser-direct fixture setup: decision:invitation-keyed-by-email made workspace_members.createRule
  // `null` (a membership row is minted only by the accept route), so a normal user token
  // can no longer create one at all — fixtures here only need the RESULT.
  async function admit(
    ws: string,
    user_id: string,
    role: string,
    status = "active",
  ): Promise<[number, any]> {
    const [s, made] = await api("POST", MEMBERS, su, {
      workspace: ws,
      user: user_id,
      role: role,
      status: status,
    });
    return [s, made];
  }

  // ══════════════════ 0. one workspace, one actor per createRule branch ═══════════════
  console.log("\n── (0) fixtures: a private workspace, one actor per rule branch ──");
  let s: number;
  let ws: any;
  [s, ws] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "Invite Mirror Workspace",
    owner: alice_id,
  });
  check_in("Alice owns a private workspace for the matrix", s, tup(200, 201));
  const WS = getitem(ws, "id");
  const ROUTE = `/api/tracker/workspaces/${WS}/resolve-member-email`;

  const [admin_id, admin_email] = await mkuser("adminactive", "ACTIVE admin");
  const [susadmin_id, susadmin_email] = await mkuser("adminsuspended", "SUSPENDED admin");
  const [, admininvitee_email] = await mkuser(
    "admininvitee",
    "admin-INVITEE (pending, no membership)",
  );
  const [member_id] = await mkuser("member", "active member");
  const [viewer_id] = await mkuser("viewer", "active viewer");
  const [stranger_id, stranger_email] = await mkuser("stranger", "non-member");
  const [target_id, TARGET_EMAIL] = await mkuser("target", "invite target");

  const [admin_tok] = await login(admin_email);
  const [susadmin_tok] = await login(susadmin_email);
  const [admininvitee_tok] = await login(admininvitee_email);
  const [member_tok] = await login("invite-mirror-member@example.test");
  const [viewer_tok] = await login("invite-mirror-viewer@example.test");
  const [stranger_tok] = await login(stranger_email);

  [s] = await admit(WS, admin_id, "admin", "active");
  check("the ACTIVE admin's membership was seeded", s, 200);
  [s] = await admit(WS, susadmin_id, "admin", "suspended");
  check("the SUSPENDED admin's membership was seeded", s, 200);
  [s] = await api("POST", INVITATIONS, alice, {
    workspace: WS,
    email: admininvitee_email,
    role: "admin",
  });
  check_in("the admin-invitee holds a PENDING admin invitation, no membership", s, tup(200, 201));
  [s] = await admit(WS, member_id, "member", "active");
  check("the active member's membership was seeded", s, 200);
  [s] = await admit(WS, viewer_id, "viewer", "active");
  check("the active viewer's membership was seeded", s, 200);

  // ══════════════════ 0b. the disclosure scanner ══════════════════════════════════════
  // The pattern is DERIVED from an id this server just minted — a scan keyed on one
  // hand-copied id would go quiet the moment a leak carried a different record's id.
  console.log("\n── (0b) the id-shape scanner every route response is run through ──");
  const ID_CHARS = "a-z0-9";
  check(
    "a PocketBase record id is lowercase alphanumerics only",
    new RegExp(`^[${ID_CHARS}]+$`).test(target_id),
    true,
  );
  PB_ID = new RegExp(`(?<![${ID_CHARS}])[${ID_CHARS}]{${target_id.length}}(?![${ID_CHARS}])`, "g");
  check("the scanner FINDS a real record id — it can fail", pb_findall(target_id), [target_id]);
  check("…and is anchored: a shorter run is not an id", pb_findall(target_id.slice(0, -1)), []);
  check("…nor is a longer one", pb_findall(target_id + "0" + " " + target_id + "x"), []);

  // workspace_invitations rows for `email` — decision:invitation-keyed-by-email keys an invitation on the
  // address, never a user id, and the route mints ONLY this collection, never
  // workspace_members directly.
  async function rows_for(ws_id: string, email: string): Promise<any[]> {
    const qs = urlencode({ filter: `workspace='${ws_id}' && email='${email}'` });
    return (await api("GET", `${INVITATIONS}?${qs}`, su))[1].items || [];
  }

  async function target_row(): Promise<any> {
    const rows = await rows_for(WS, TARGET_EMAIL);
    return rows.length ? rows[0] : null;
  }

  async function clear_target(): Promise<void> {
    for (const row of await rows_for(WS, TARGET_EMAIL)) {
      await api("DELETE", `${INVITATIONS}/${getitem(row, "id")}`, su);
    }
  }

  // ══════════════════ 1. the oracle is closed (AC3, AC4) ═══════════════════════════════
  console.log("\n── (1) the response does not vary with the address ──");
  // Alice's OWN seeded workspace: the gate she trivially clears against a workspace she owns.
  const [, own] = await api("GET", "/api/collections/workspaces/records?perPage=200", alice);
  const own_ws = getitem(own, "items").find(
    (i: any) => getitem(i, "owner") === alice_id && getitem(i, "id") !== WS,
  );
  if (own_ws === undefined) throw new Error("StopIteration");
  const ALICE_OWN = getitem(own_ws, "id");
  const OWN_ROUTE = `/api/tracker/workspaces/${ALICE_OWN}/resolve-member-email`;
  const UNREGISTERED = "nobody-invite-mirror@example.test";

  const own_before = new Set((await rows_for(ALICE_OWN, "alice@example.com")).map((r) => r.id));
  const registered = await invite("registered-but-unrelated", OWN_ROUTE, alice, {
    email: stranger_email,
  });
  const unregistered = await invite("not-registered", OWN_ROUTE, alice, { email: UNREGISTERED });
  const own_address = await invite("the caller's OWN address", OWN_ROUTE, alice, {
    email: "alice@example.com",
  });
  const with_role = await invite("registered, with a role sent", OWN_ROUTE, alice, {
    email: stranger_email,
    role: "viewer",
  });
  console.log(`     registered-but-unrelated → ${py_str(registered)}`);
  console.log(`     not-registered           → ${py_str(unregistered)}`);
  console.log(`     the caller's OWN address → ${py_str(own_address)}`);
  console.log(`     registered, role sent    → ${py_str(with_role)}`);
  check(
    "an unrelated REGISTERED address and an UNREGISTERED one answer identically",
    registered,
    unregistered,
  );
  check("the caller's OWN address answers identically too", own_address, registered);
  check("sending a role changes nothing about the answer", with_role, registered);
  check("the answer carries no user id", json_dumps(registered[1]).includes("user_id"), false);
  for (const [label, [, bodyr]] of [
    ["registered", registered],
    ["unregistered", unregistered],
  ] as [string, [number, any]][]) {
    check(
      `the ${label} answer leaks no account id`,
      json_dumps(bodyr).includes(stranger_id),
      false,
    );
  }

  // Three more shapes a caller can send, each answering like the baseline — and each one
  // asserted to have LANDED the row it should, because a uniformity that holds because
  // nothing ever happens proves nothing about the route. Since decision:invitation-keyed-by-email, EVERY address
  // (registered or not) lands a workspace_invitations row — there is no longer a
  // registered-vs-unregistered fork at the database layer at all.
  async function clear_stranger(): Promise<void> {
    for (const row of await rows_for(ALICE_OWN, stranger_email)) {
      await api("DELETE", `${INVITATIONS}/${getitem(row, "id")}`, su);
    }
  }

  await clear_stranger();
  for (const row of await rows_for(ALICE_OWN, UNREGISTERED)) {
    await api("DELETE", `${INVITATIONS}/${getitem(row, "id")}`, su);
  }
  const unreg_role = await invite("not registered, with a role sent", OWN_ROUTE, alice, {
    email: UNREGISTERED,
    role: "viewer",
  });
  console.log(`     not registered, role sent→ ${py_str(unreg_role)}`);
  check("an UNREGISTERED address WITH a role answers identically", unreg_role, registered);
  check(
    '…and DOES land an invitation row, with the sent role — unregistered is not "no row"',
    (await rows_for(ALICE_OWN, UNREGISTERED)).map((r) => getitem(r, "role")),
    ["viewer"],
  );
  for (const row of await rows_for(ALICE_OWN, UNREGISTERED)) {
    await api("DELETE", `${INVITATIONS}/${getitem(row, "id")}`, su);
  }

  await clear_stranger();
  const CASE_VARIANT = stranger_email.toUpperCase();
  check(
    "setup: the case variant really differs from the address",
    CASE_VARIANT !== stranger_email,
    true,
  );
  const variant = await invite("a case-variant of a registered address", OWN_ROUTE, alice, {
    email: CASE_VARIANT,
  });
  console.log(`     case-variant address     → ${py_str(variant)}`);
  check("a CASE-VARIANT registered address answers identically", variant, registered);
  check(
    "…and folded to the SAME lowercased email — one row, that address",
    (await rows_for(ALICE_OWN, stranger_email)).map((r) => getitem(r, "email")),
    [stranger_email],
  );

  await clear_stranger();
  const PADDED = `  ${stranger_email}\t `;
  const padded = await invite("a whitespace-padded registered address", OWN_ROUTE, alice, {
    email: PADDED,
  });
  console.log(`     whitespace-padded address→ ${py_str(padded)}`);
  check("a WHITESPACE-PADDED registered address answers identically", padded, registered);
  check(
    "…and trimmed to the SAME email — one row, that address",
    (await rows_for(ALICE_OWN, stranger_email)).map((r) => getitem(r, "email")),
    [stranger_email],
  );

  // The invitation the owner-of-a-throwaway-workspace just performed is the ONLY thing they
  // learned, and it is about their own workspace.
  const planted = await rows_for(ALICE_OWN, stranger_email);
  check("the unrelated address was invited, not resolved", planted.length, 1);
  for (const row of planted) {
    await api("DELETE", `${INVITATIONS}/${getitem(row, "id")}`, su);
  }
  for (const row of await rows_for(ALICE_OWN, "alice@example.com")) {
    if (!own_before.has(getitem(row, "id"))) {
      await api("DELETE", `${INVITATIONS}/${getitem(row, "id")}`, su);
    }
  }

  console.log("\n── (1b) the legitimate invite path still works, owner and active admin ──");
  await clear_target();
  let r: any;
  let row: any;
  [s, r] = await invite("owner invites a new member", ROUTE, alice, { email: TARGET_EMAIL });
  row = await target_row();
  check(
    "Alice (owner) invites a new member — accepted, an invitation row for member",
    tup(s, r, truthy(row) ? getitem(row, "role") : row),
    tup(200, { invited: true }, "member"),
  );
  await clear_target();
  [s, r] = await invite("active admin invites a new member", ROUTE, admin_tok, {
    email: TARGET_EMAIL,
  });
  row = await target_row();
  check(
    "the ACTIVE admin invites a new member — accepted, an invitation row for member",
    tup(s, r, truthy(row) ? getitem(row, "role") : row),
    tup(200, { invited: true }, "member"),
  );
  await clear_target();

  console.log("\n── (1c) the shape of every refusal a caller can reach ──");
  check(
    "a caller who administers nothing here → 404",
    (await invite("stranger", ROUTE, stranger_tok, { email: TARGET_EMAIL }))[0],
    404,
  );
  check(
    "an anonymous caller → 401",
    (await invite("anonymous", ROUTE, null, { email: TARGET_EMAIL }))[0],
    401,
  );
  check(
    "an unknown workspace id → 404",
    (
      await invite(
        "unknown workspace",
        "/api/tracker/workspaces/no-such-workspace/resolve-member-email",
        alice,
        { email: TARGET_EMAIL },
      )
    )[0],
    404,
  );
  check(
    "a blank email → 400",
    (await invite("blank email", ROUTE, alice, { email: "   " }))[0],
    400,
  );
  check("a missing email → 400", (await invite("missing email", ROUTE, alice, {}))[0], 400);
  check(
    "a non-string email → 400",
    (await invite("non-string email", ROUTE, alice, { email: 42 }))[0],
    400,
  );
  check(
    "an unknown role → 400",
    (await invite("unknown role", ROUTE, alice, { email: TARGET_EMAIL, role: "owner" }))[0],
    400,
  );
  check("nothing was written by any refusal above", await target_row(), null);

  // ══════════════════ 2. the differential rule mirror ═══════════════════════════════════
  // The expectation is derived from the LIVE rule at run time, never from a copy of its text:
  // each cell asks the collection first and the route second, and they must agree.
  console.log("\n── (2) rule mirror, differential: collection create vs route, cell for cell ──");

  const permits: string[] = [];
  const refusals: string[] = [];

  async function mirror_cell(
    label: string,
    tok: string,
    role: string,
    expected: boolean,
  ): Promise<void> {
    await clear_target();
    const [s_rule] = await api("POST", INVITATIONS, tok, {
      workspace: WS,
      email: TARGET_EMAIL,
      role: role,
    });
    const rule_allows = [200, 201].includes(s_rule);
    await clear_target();
    const [s_route, body_route] = await invite(`matrix: ${label}`, ROUTE, tok, {
      email: TARGET_EMAIL,
      role: role,
    });
    // The BODY, not just the status: a 200 saying anything else is a different answer, and a
    // status-only comparison let a leaking route through a whole suite once.
    const route_allows = Bun.deepEquals([s_route, body_route], [200, { invited: true }], true);
    // The route answers 200 for an unresolvable address too, so the ROW is what proves its
    // 200 was an invitation rather than the uniform silence.
    const route_wrote = (await target_row()) !== null;
    await clear_target();
    check(
      `${label.padEnd(44)} rule/route/row`,
      tup(rule_allows, route_allows, route_wrote),
      tup(expected, expected, expected),
    );
    (rule_allows ? permits : refusals).push(label);
  }

  // 7 minting principals x 3 minted roles = 21 cells. All seven sit in ONE workspace that
  // ALSO holds the active and suspended admin (fixtures above), so a rule whose `?=`
  // conjuncts could match across DIFFERENT membership rows would show here as a wrong allow.
  const PRINCIPALS: [string, string][] = [
    ["owner", alice],
    ["active admin", admin_tok],
    ["suspended admin", susadmin_tok],
    ["admin-invitee (pending admin invitation, no membership)", admininvitee_tok],
    ["active member", member_tok],
    ["active viewer", viewer_tok],
    ["stranger", stranger_tok],
  ];
  for (const [principal_label, tok] of PRINCIPALS) {
    for (const role of ["member", "admin", "viewer"]) {
      let expected: boolean;
      if (principal_label === "owner") {
        expected = true;
      } else if (principal_label === "active admin") {
        expected = role === "member";
      } else {
        expected = false;
      }
      await mirror_cell(`${principal_label} mints ${role}`, tok, role, expected);
    }
  }

  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, alice);
  check("the workspace is trapped to trash for the last cell", s, 204);
  await mirror_cell("owner mints member, TRASHED workspace", alice, "member", false);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, alice, { trashed: "" });
  check("the workspace is restored", s, 200);

  // Vacuity guards: both arms refusing every cell would still "agree" cell for cell.
  console.log("\n── (2b) the matrix is not vacuous ──");
  check("at least one cell is PERMITTED", permits.length > 0, true);
  check("at least one cell is REFUSED", refusals.length > 0, true);
  check("exactly 21 + 1 (trashed) cells ran", permits.length + refusals.length, 22);
  check(
    "the permitted cells are exactly these, by name",
    [...permits].sort(by_code_point),
    [
      "owner mints member",
      "owner mints admin",
      "owner mints viewer",
      "active admin mints member",
    ].sort(by_code_point),
  );
  check(
    "the refused cells are exactly these, by name",
    [...refusals].sort(by_code_point),
    [
      "active admin mints admin",
      "active admin mints viewer",
      "suspended admin mints member",
      "suspended admin mints admin",
      "suspended admin mints viewer",
      "admin-invitee (pending admin invitation, no membership) mints member",
      "admin-invitee (pending admin invitation, no membership) mints admin",
      "admin-invitee (pending admin invitation, no membership) mints viewer",
      "active member mints member",
      "active member mints admin",
      "active member mints viewer",
      "active viewer mints member",
      "active viewer mints admin",
      "active viewer mints viewer",
      "stranger mints member",
      "stranger mints admin",
      "stranger mints viewer",
      "owner mints member, TRASHED workspace",
    ].sort(by_code_point),
  );

  // ══════════════════ 3. a repeat invitation looks like a first one ════════════════════
  // The colliding row is MINTED by the caller's own first request, so a second answer that
  // named the collision would separate a registered address from an unregistered one in two
  // round trips, with no roster read at all — the route's own answer would be the oracle.
  // NOT closed here and not closable in this route: the inviter's OWN roster still gains a row
  // only for an address that has an account (kata 729j — an email-keyed pending invitation is a
  // new collection). Read the uniformity below as a property of the ROUTE, not of the product.
  console.log("\n── (3) a repeat invitation is indistinguishable from a first one ──");
  await clear_target();
  const first = await invite("first invitation", ROUTE, alice, { email: TARGET_EMAIL });
  const landed = await target_row();
  const second = await invite("repeat invitation", ROUTE, alice, { email: TARGET_EMAIL });
  const third = await invite("unregistered address", ROUTE, alice, { email: UNREGISTERED });
  console.log(`     first invitation  → ${py_str(first)}`);
  console.log(`     repeat invitation → ${py_str(second)}`);
  console.log(`     never registered  → ${py_str(third)}`);
  check("setup: the first invitation landed a row", truthy(landed), true);
  check("a repeat invitation answers exactly like the first", second, first);
  check("both answer exactly like an address with no account", third, first);
  check("the repeat wrote no second row", (await rows_for(WS, TARGET_EMAIL)).length, 1);
  const after = await target_row();
  check(
    "the repeat left the existing row untouched",
    truthy(after)
      ? tup(getitem(after, "id"), getitem(after, "role"), getitem(after, "created"))
      : after,
    truthy(landed)
      ? tup(getitem(landed, "id"), getitem(landed, "role"), getitem(landed, "created"))
      : landed,
  );
  // An active admin repeating the owner's invitation is the same answer from the other tier.
  check(
    "an ACTIVE admin's repeat answers the same as the owner's first",
    await invite("repeat, by the active admin", ROUTE, admin_tok, { email: TARGET_EMAIL }),
    first,
  );
  check("…and still wrote no second row", (await rows_for(WS, TARGET_EMAIL)).length, 1);
  await clear_target();

  // ══════════════════ 3b. the stale-write key the route cannot honour ══════════════════
  // pb_hooks/precondition.pb.js refuses this key on every COLLECTION create; the route's
  // create is programmatic, out of that request-tier hook's reach, so the route mirrors the
  // refusal itself. Compared LIVE against the collection rather than against the hook source.
  console.log("\n── (3b) a create carrying a stale-write key is refused, route and collection ──");
  await clear_target();
  const [s_route, r_route] = await invite("invite carrying expected_updated_at", ROUTE, alice, {
    email: TARGET_EMAIL,
    expected_updated_at: STALE_KEY_VALUE,
  });
  check("the route refuses it → 400", s_route, 400);
  check("nothing was written", await target_row(), null);
  const [s_direct, r_direct] = await api("POST", INVITATIONS, alice, {
    workspace: WS,
    email: TARGET_EMAIL,
    role: "member",
    expected_updated_at: STALE_KEY_VALUE,
  });
  check("the direct collection create refuses it → 400", s_direct, 400);
  check("nothing was written by that either", await target_row(), null);
  check(
    "the two refusals say the SAME thing (the mirror, on the wire)",
    py_str(py_get(r_route, "message", "")).toLowerCase(),
    py_str(py_get(r_direct, "message", "")).toLowerCase(),
  );
  // Without the key the same owner create is accepted — so the 400 above is the key, not the shape.
  check(
    "the SAME create without the key is accepted — the 400 names the key",
    await invite("control: no stale-write key", ROUTE, alice, { email: TARGET_EMAIL }),
    tup(200, { invited: true }),
  );
  await clear_target();

  // ══════════════════ 4. why the route exists at all ═══════════════════════════════════
  console.log("\n── (4) emailVisibility=false hides email from every non-superuser filter ──");
  for (const [label, tok, addr] of [
    ["another account's address", stranger_tok, "alice@example.com"],
    ["their OWN address", stranger_tok, stranger_email],
  ]) {
    const qs = urlencode({ perPage: 1, filter: `email='${addr}'` });
    [s, r] = await api("GET", `/api/collections/users/records?${qs}`, tok);
    check(`filtering users by ${label} → empty 200`, tup(s, r.totalItems ?? null), tup(200, 0));
  }
  const qs = urlencode({ perPage: 1, filter: `email='${stranger_email}'` });
  [s, r] = await api("GET", `/api/collections/users/records?${qs}`, su);
  check(
    "the same filter as SUPERUSER finds the row — the rows exist, the field is hidden",
    tup(s, r.totalItems ?? null),
    tup(200, 1),
  );

  console.log("\n── cleanup ──");
  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, alice);
  check("the mirror workspace is trapped to trash", s, 204);
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
console.log("✅ all invite-mirror proofs passed");
process.exit(0);

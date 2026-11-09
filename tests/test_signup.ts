#!/usr/bin/env bun
/**E2E proof of the signup lifecycle, end to end in one clean room:

(a)-(g) a public signup — the same `POST /api/collections/users/records` call
a web client sends — gets the exact same auto-provisioned
workspace/workspace_members/project/user_settings shape a seeded user gets, once a
superuser flips verified+approved true (pb_hooks/main.pb.js's
onRecordAfterCreateSuccess("users") hook).

(h) PBTT-363: a stored email is always trimmed + lowercased, and a second account
differing from an existing one only by case is refused on create AND on update.
PBTT-529 adds the folded `users.email_key` behind it — Gmail dots and +tags collapse,
every other domain keeps them significant — proven as a table against the running
server, against the offline audit script's own fold, under a parallel race, and as a
value that never travels to another user.

(i) PBTT-290: the unconfirmed-signup purge cron deletes approved-but-unconfirmed
accounts older than 30 days and nothing else — the retention boundary is proven to
the hour, in both directions — and skips one that solely owns a workspace with another member.

Fully self-contained clean-room server: scratch --dir, a COPY of pb_migrations
(*superuser_mfa.js dropped so a plain superuser auth-with-password
returns a token directly), --hooksDir from a pb_hooks copy (the auto-provision hook lives in
pb_hooks/main.pb.js, not a single-file copy). Port 8108 + PB_PORT_OFFSET, self-boot
band (8100+).
*/

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  json_dumps,
  py_repr,
  py_str,
  run_checked,
  truthy,
  urlencode,
  sqlite_connect,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
// the ONLY file that enables _superusers MFA — dropped from the room's copy so a
// plain superuser auth-with-password returns a token (house clean-room idiom).
// Suffix, never a timestamp: a baseline rebuild renames it and a stale literal leaves MFA on.
const MFA_SUFFIX = "superuser_mfa.js";

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8108 + PORT_OFFSET;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  const mark = ok ? "✅" : "❌ MISMATCH";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

async function api(
  base_url: string,
  method: string,
  path: string,
  body: any = null,
  token: string | null = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(base_url + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return [204, {}];
  const raw = await r.text();
  if (r.ok) return [r.status, JSON.parse(raw)];
  try {
    return [r.status, JSON.parse(raw || "{}")];
  } catch {
    return [r.status, {}];
  }
}

async function find_by_filter(
  base_url: string,
  collection: string,
  filt: string,
  token: string | null = null,
  per_page = 200,
): Promise<any[]> {
  const qs = urlencode({ filter: filt, perPage: per_page });
  const [, r] = await api(
    base_url,
    "GET",
    `/api/collections/${collection}/records?${qs}`,
    null,
    token,
  );
  return r.items || [];
}

// Test-only hook for (h9b). Validation runs after the pre-scan and before the insert, so holding
// both creates there makes the pre-scan miss the winner every time and the unique index refuse the
// loser: the loser releases the winner only once past its own scan, then waits for the winner row.
const H9B_HOOK = `onRecordValidate((e) => {
  const email = e.record.getString("email");
  const key = e.record.getString("email_key");
  if (email.indexOf("forced.loser.") === 0) {
    e.app.store().set("h9b:" + key, true);
    for (let i = 0; i < 100; i++) {
      const rows = arrayOf(new DynamicModel({ id: "" }));
      const q = e.app.db().newQuery("SELECT id FROM users WHERE email_key = {:k}");
      q.bind({ k: key });
      q.all(rows);
      if (rows.length) break;
      sleep(50);
    }
  } else if (email.indexOf("+win@") !== -1) {
    for (let i = 0; i < 100 && !e.app.store().has("h9b:" + key); i++) sleep(50);
  }
  return e.next();
}, "users");
`;

class Room {
  /**One self-contained `pocketbase serve` clean-room: fresh --dir, a COPY of
  pb_migrations as --migrationsDir, and a scratch copy of the WHOLE pb_hooks/
  (the auto-provision hook under test lives in pb_hooks/main.pb.js, so a
  single-file hook copy isn't enough here).*/
  port: number;
  base_url: string;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number) {
    this.port = port;
    this.base_url = `http://127.0.0.1:${port}`;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-signup-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    copy_tree(REAL_MIGRATIONS_DIR, this.migrations_dir);
    for (const name of fs.readdirSync(this.migrations_dir)) {
      if (name.endsWith(MFA_SUFFIX)) fs.rmSync(path.join(this.migrations_dir, name));
    }
    this.proc = null;
  }

  async start(): Promise<void> {
    await roomkit.require_free_port(this.port);
    run_checked(
      [
        POCKETBASE_BIN,
        "superuser",
        "upsert",
        SU_EMAIL,
        SU_PASSWORD,
        "--dir",
        this.data_dir,
        "--migrationsDir",
        this.migrations_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    // A private hooks copy (the battery shares one) carrying the h9b interleaving hook.
    const hooks = path.join(this.tmp, "pb_hooks_h9b");
    copy_tree(roomkit.hooks_dir(this.tmp), hooks);
    fs.writeFileSync(path.join(hooks, "zz_test_h9b_interleave.pb.js"), H9B_HOOK);
    this.proc = await roomkit.serve(this.port, this.data_dir, this.migrations_dir, hooks);
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

const room = new Room(PORT);
try {
  await room.start();

  // COVERS: hook:main.pb.js#onRecordAfterCreateSuccess:users, rule:users.create
  console.log("\n── (a) public signup — same body shape a web client sends ──");
  const signup_email = "signup-e2e@example.com";
  const [signup_status, signup_body] = await api(
    room.base_url,
    "POST",
    "/api/collections/users/records",
    {
      email: signup_email,
      name: "Signup E2E",
    },
  );
  check("anonymous signup succeeds", signup_status, 200);
  check("new account starts verified=false", signup_body.verified, false);
  check("new account starts approved=false", signup_body.approved, false);
  const user_id = signup_body.id ?? null;

  console.log(
    "\n── (b) superuser flips verified+approved (the only way — updateRule blocks self) ──",
  );
  const [su_status, su_auth] = await api(
    room.base_url,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    { identity: SU_EMAIL, password: SU_PASSWORD },
  );
  check("superuser auth", su_status, 200);
  const su_token = su_auth.token ?? null;

  const [patch_status, patch_body] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(user_id)}`,
    // A signup carries no password (decision:password-signup-verify-first); the superuser sets one here.
    { verified: true, approved: true, password: "signup123456", passwordConfirm: "signup123456" },
    su_token,
  );
  check("superuser PATCH verified+approved", patch_status, 200);
  check("record now verified=true", patch_body.verified, true);
  check("record now approved=true", patch_body.approved, true);

  console.log("\n── (c) the new user can now authenticate ──");
  const [login_status, login_body] = await api(
    room.base_url,
    "POST",
    "/api/collections/users/auth-with-password",
    { identity: signup_email, password: "signup123456" },
  );
  check("auth-with-password after approval", login_status, 200);
  const user_token = login_body.token ?? null;

  console.log("\n── (d) auto-provisioned workspace ──");
  const workspaces = await find_by_filter(
    room.base_url,
    "workspaces",
    `owner='${py_str(user_id)}'`,
    user_token,
  );
  check("exactly one owned workspace", workspaces.length, 1);
  const ws = workspaces.length ? workspaces[0] : {};
  const ws_id = ws.id ?? null;
  check("workspace has a non-empty name", truthy(ws.name), true);

  console.log("\n── (e) auto-provisioned workspace_members row (self-membership) ──");
  const memberships = await find_by_filter(
    room.base_url,
    "workspace_members",
    `workspace='${py_str(ws_id)}' && user='${py_str(user_id)}'`,
    user_token,
  );
  check("exactly one self-membership row", memberships.length, 1);

  console.log("\n── (f) auto-provisioned default project ──");
  const projects = await find_by_filter(
    room.base_url,
    "projects",
    `workspace='${py_str(ws_id)}'`,
    user_token,
  );
  check("at least one project in the default workspace", projects.length >= 1, true);

  console.log("\n── (g) auto-provisioned user_settings row ──");
  const settings = await find_by_filter(
    room.base_url,
    "user_settings",
    `user='${py_str(user_id)}'`,
    user_token,
  );
  check("exactly one user_settings row", settings.length, 1);
  const us = settings.length ? settings[0] : {};
  check("user_settings.theme default", us.theme, "system");
  check("user_settings.font default", us.font, "system");

  // ══════════════════════════════════════════════════════════════════════════
  // (h) one address is one account
  // ══════════════════════════════════════════════════════════════════════════
  // COVERS: hook:auth_identity.pb.js#onRecordCreate:users, hook:auth_identity.pb.js#onRecordUpdate:users
  console.log("\n── (h) PBTT-363: a stored email is trimmed + lowercased ──");

  // The app_settings rate limits cap ANONYMOUS POST /api/collections/users/records at 5 per
  // 60s and a superuser token bypasses it, so only the checks that are specifically
  // about the public path spend from that budget — (a) plus two here.
  const signup = (email: string, name: string, token: string | null = null) =>
    api(
      room.base_url,
      "POST",
      "/api/collections/users/records",
      // Only a superuser create may carry a password (decision:password-signup-verify-first).
      token
        ? { email, password: "signup123456", passwordConfirm: "signup123456", name }
        : { email, name },
      token,
    );

  const stored_email = async (user_id: string | null): Promise<any> => {
    // users.emailVisibility=false hides email on other people's records — read it
    // back as the superuser, which is the only caller PB shows it to.
    const [, rec] = await api(
      room.base_url,
      "GET",
      `/api/collections/users/records/${py_str(user_id)}`,
      null,
      su_token,
    );
    return rec.email ?? null;
  };

  // sqlite3.connect(..., timeout=15) -> a 15 s busy timeout on a writable handle
  const open_db = (): Database => {
    return sqlite_connect(path.join(room.data_dir, "data.db"), { timeout: 15 });
  };

  let s: number, mixed_body: any;
  [s, mixed_body] = await signup("  Mixed.Case@Example.COM  ", "Mixed Case");
  check("signup with a padded mixed-case address succeeds", s, 200);
  const mixed_id = mixed_body.id ?? null;
  check(
    "stored email is trimmed + lowercased",
    await stored_email(mixed_id),
    "mixed.case@example.com",
  );

  // The first variant goes over the PUBLIC path — that 400 is what
  // a client treats as a verdict and shows the person verbatim.
  let dup_body: any;
  for (const [variant, as_su] of [
    ["mixed.case@example.com", false],
    ["MIXED.CASE@EXAMPLE.COM", true],
    ["Mixed.Case@Example.com", true],
  ] as [string, boolean][]) {
    [s, dup_body] = await signup(variant, `Dup ${variant}`, as_su ? su_token : null);
    check(`second signup as ${py_repr(variant)} → 400`, s, 400);
    check(
      `…and ${py_repr(variant)} is refused as a duplicate, not a validation slip`,
      dup_body.message ?? null,
      "An account with this email address already exists.",
    );
  }
  check(
    "still exactly one account for that address",
    (await find_by_filter(room.base_url, "users", "email='mixed.case@example.com'", su_token))
      .length,
    1,
  );

  console.log("\n── (h2) a legacy mixed-case row the BINARY unique index cannot see ──");
  // Written straight into the table, which is the only way a pre-hook row can exist:
  // `email = 'legacy.row@example.com'` would NOT match it, so PB's own unique index on
  // email admits the clash and the email_key the PBTT-529 backfill left is what refuses it.
  const legacy_db = open_db();
  legacy_db
    .query("UPDATE users SET email = ?, email_key = ? WHERE id = ?")
    .run("Legacy.Row@Example.com", "legacy.row@example.com", mixed_id);
  legacy_db.close();
  check(
    "legacy row now holds a mixed-case email",
    await stored_email(mixed_id),
    "Legacy.Row@Example.com",
  );
  [s] = await signup("legacy.row@example.com", "Legacy Clash", su_token);
  check("signup clashing with the legacy row ONLY by case → 400", s, 400);

  console.log("\n── (h3) the update path cannot reintroduce a case-variant either ──");
  let patched: any, occupied: any, clash: any;
  [s, patched] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(mixed_id)}`,
    { email: "Moved.Address@Example.com" },
    su_token,
  );
  check("superuser PATCH of email → 200", s, 200);
  check(
    "…and the new address is stored lowercased",
    patched.email ?? null,
    "moved.address@example.com",
  );
  [s, occupied] = await signup("occupied@example.com", "Occupied", su_token);
  check("(fixture) a second account at occupied@example.com", s, 200);
  [s, clash] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(mixed_id)}`,
    { email: "OCCUPIED@Example.com" },
    su_token,
  );
  check("PATCH onto a case-variant of ANOTHER account → 400", s, 400);
  check(
    "…the target account keeps its own address",
    await stored_email(occupied.id ?? null),
    "occupied@example.com",
  );
  check("…and the mover keeps its own", await stored_email(mixed_id), "moved.address@example.com");
  [s] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(mixed_id)}`,
    { name: "Mixed Case Renamed" },
    su_token,
  );
  check("a non-email update on a user is unaffected → 200", s, 200);

  // COVERS: hook:auth_identity.pb.js#onRecordAuthWithPasswordRequest:users
  console.log("\n── (h4) an AMBIGUOUS legacy pair authenticates nobody ──");
  // Moved here from tests/test_auth_rules.ts, which can no longer mint the pair: the
  // create guard refuses the second row, so only a direct column write reproduces one.
  // ONE shared password across both casings — under a `LIMIT 1` lookup either row would
  // authenticate, so the refusal cannot pass by accident.
  let amb_a_body: any, amb_b_body: any;
  [s, amb_a_body] = await signup("amb-pair-a@example.com", "Amb A", su_token);
  check("(fixture) first half of the ambiguous pair", s, 200);
  const amb_a = amb_a_body.id ?? null;
  [s, amb_b_body] = await signup("amb-pair-b@example.com", "Amb B", su_token);
  check("(fixture) second half of the ambiguous pair", s, 200);
  const amb_b = amb_b_body.id ?? null;
  // Both stored casings are made to differ from the identity submitted below, so PB's
  // own exact-case lookup misses and the hook's LOWER() retry is the thing under test.
  // verified/approved are set too: a wrongly-resolved login would then be a plain 200.
  const amb_db = open_db();
  amb_db
    .query("UPDATE users SET email = ?, verified = 1, approved = 1 WHERE id = ?")
    .run("Amb-Pair@example.com", amb_a);
  amb_db
    .query("UPDATE users SET email = ?, verified = 1, approved = 1 WHERE id = ?")
    .run("amb-Pair@Example.com", amb_b);
  amb_db.close();
  check("(fixture) pair half A stored casing", await stored_email(amb_a), "Amb-Pair@example.com");
  check("(fixture) pair half B stored casing", await stored_email(amb_b), "amb-Pair@Example.com");
  [s] = await api(room.base_url, "POST", "/api/collections/users/auth-with-password", {
    identity: "amb-pair@example.com",
    password: "signup123456",
  });
  check("login on an ambiguous case-duplicate → 400 (authenticates nobody)", s, 400);
  [s] = await api(room.base_url, "POST", "/api/collections/users/auth-with-password", {
    identity: "Amb-Pair@example.com",
    password: "signup123456",
  });
  check("…while an EXACT-cased identity still logs in → 200 (the pair is real)", s, 200);

  // ══════════════════════════════════════════════════════════════════════════
  // (h5)-(h9) PBTT-529: the folded email_key is what uniqueness compares on
  // ══════════════════════════════════════════════════════════════════════════
  const stored_key = (user_id: string | null): any => {
    // email_key is a hidden field: PB strips it from every non-superuser response, so
    // the column itself is the only place a test can read the stored value from.
    const con = open_db();
    try {
      const row = con.query("SELECT email_key FROM users WHERE id = ?").values(user_id)[0];
      return row ? row[0] : null;
    } finally {
      con.close();
    }
  };

  const rows_with_key = (key: string): any => {
    const con = open_db();
    try {
      return con.query("SELECT COUNT(*) FROM users WHERE email_key = ?").values(key)[0]![0];
    } finally {
      con.close();
    }
  };

  // The offline audit script (PBTT-528) folds the same policy; it is loaded here
  // so the two implementations are compared on every case rather than trusted to agree.
  const audit_path = path.join(REPO_ROOT, "scripts", "utilities", "email_collision_audit.ts");
  const audit = await import(audit_path);

  // COVERS: hook:auth_identity.pb.js#onRecordCreate:users
  console.log("\n── (h5/h8) the fold table — stored email, stored key, and Python/JS agreement ──");
  // (submitted address, stored email, expected email_key). Every key here is DISTINCT: the
  // collisions are exercised in (h6), so any accidental over-folding shows up as a 400.
  const fold_table: [string, string, string][] = [
    ["  Gmail.Dots+promo@GMAIL.com  ", "gmail.dots+promo@gmail.com", "gmaildots@gmail.com"],
    // the same local part at googlemail is a DIFFERENT account (owner ruling: not folded
    // into gmail.com), and its own dots/+tag still collapse
    [
      "Gmail.Dots+promo@googlemail.com",
      "gmail.dots+promo@googlemail.com",
      "gmaildots@googlemail.com",
    ],
    // off-gmail: dots and +tags stay significant, so these are three separate accounts
    ["Keep.Dots@Example.com", "keep.dots@example.com", "keep.dots@example.com"],
    ["keepdots@example.com", "keepdots@example.com", "keepdots@example.com"],
    ["keep.dots+promo@example.com", "keep.dots+promo@example.com", "keep.dots+promo@example.com"],
    // a gmail address with nothing to fold still round-trips unchanged
    ["nofold@gmail.com", "nofold@gmail.com", "nofold@gmail.com"],
  ];
  const fold_ids: Record<string, any> = {};
  let body: any;
  for (const [submitted, want_email, want_key] of fold_table) {
    [s, body] = await signup(submitted, `fold ${want_key}`, su_token);
    check(`create ${py_repr(submitted)} → 200`, s, 200);
    fold_ids[want_key] = body.id ?? null;
    check(`  stored email for ${want_key}`, await stored_email(body.id ?? null), want_email);
    check(`  stored email_key for ${want_key}`, stored_key(body.id ?? null), want_key);
    check(
      `  audit script folds ${py_repr(submitted)} the same`,
      audit.email_key(submitted),
      want_key,
    );
  }

  console.log("\n── (h6) a fold-equivalent second signup is refused ──");
  let dup: any;
  for (const variant of [
    "gmaildots@gmail.com", // the dots the first account typed are not significant
    "g.m.a.i.l.d.o.t.s@gmail.com",
    "gmail.dots+other-tag@gmail.com",
    "GMAILDOTS@GMAIL.COM",
  ]) {
    [s, dup] = await signup(variant, `dup ${variant}`, su_token);
    check(`second signup as ${py_repr(variant)} → 400`, s, 400);
    check(
      `…${py_repr(variant)} is refused as a duplicate, not a validation slip`,
      dup.message ?? null,
      "An account with this email address already exists.",
    );
  }
  check("still exactly one account on that key", rows_with_key("gmaildots@gmail.com"), 1);
  // the domain boundary: googlemail folds its own dots, onto its OWN account — the two
  // domains never merge, so both rows survive side by side.
  [s] = await signup("gmaildots@googlemail.com", "googlemail dup", su_token);
  check("the same local part at googlemail.com → 400 (its own account already holds it)", s, 400);
  check("one account per domain, still", rows_with_key("gmaildots@googlemail.com"), 1);

  // COVERS: hook:auth_identity.pb.js#onRecordUpdate:users
  console.log("\n── (h7) the update path recomputes the key, and cannot land on another's ──");
  const mover = getitem(fold_ids, "nofold@gmail.com");
  let moved: any;
  [s, moved] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(mover)}`,
    { email: "Now.Folded+tag@Gmail.com" },
    su_token,
  );
  check("PATCH onto a new gmail address → 200", s, 200);
  check(
    "…stored email keeps the dots and the tag",
    moved.email ?? null,
    "now.folded+tag@gmail.com",
  );
  check("…and the key is recomputed", stored_key(mover), "nowfolded@gmail.com");
  [s, clash] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(mover)}`,
    { email: "g.m.a.i.l.d.o.t.s+x@gmail.com" },
    su_token,
  );
  check("PATCH onto a fold-variant of ANOTHER account → 400", s, 400);
  check(
    "…refused with the duplicate verdict",
    clash.message ?? null,
    "An account with this email address already exists.",
  );
  check("…and the mover keeps its own key", stored_key(mover), "nowfolded@gmail.com");
  // The key must always DERIVE from the email, or the unique index guards nothing. PB drops
  // a hidden field from a normal caller's body, but LOADS it for a superuser — so the one
  // caller who can submit email_key is the one the hook has to overwrite.
  [s] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(mover)}`,
    { email_key: "not-my-address@example.com" },
    su_token,
  );
  check("a superuser PATCH of email_key alone → 200", s, 200);
  check(
    "…and the key is recomputed from the address, not taken",
    stored_key(mover),
    "nowfolded@gmail.com",
  );

  console.log("\n── (h8) email_key never travels to another user ──");
  // A peer account, verified+approved so it can hold a token; users' viewRule is
  // `@request.auth.id != ""`, so ANY authenticated user can read this record's fields.
  let peer: any, peer_auth: any, seen: any;
  [s, peer] = await signup("peer-reader@example.com", "Peer Reader", su_token);
  check("(fixture) peer account created", s, 200);
  const peer_id = peer.id ?? null;
  [s] = await api(
    room.base_url,
    "PATCH",
    `/api/collections/users/records/${py_str(peer_id)}`,
    // Marking an account verified drops an earlier password unless the same request sets one (decision:password-signup-verify-first).
    { verified: true, approved: true, password: "signup123456", passwordConfirm: "signup123456" },
    su_token,
  );
  check("(fixture) peer verified+approved", s, 200);
  [s, peer_auth] = await api(room.base_url, "POST", "/api/collections/users/auth-with-password", {
    identity: "peer-reader@example.com",
    password: "signup123456",
  });
  check("(fixture) peer authenticates", s, 200);
  const peer_token = peer_auth.token ?? null;
  check(
    "the peer's OWN auth record carries no email_key",
    Object.hasOwn(peer_auth.record ?? {}, "email_key"),
    false,
  );
  [s, seen] = await api(
    room.base_url,
    "GET",
    `/api/collections/users/records/${py_str(mover)}`,
    null,
    peer_token,
  );
  check("a peer CAN view another user's record → 200", s, 200);
  check("…but the body carries no email_key", Object.hasOwn(seen, "email_key"), false);
  check(
    "…and no email either (PB's own auth-collection rule)",
    Object.hasOwn(seen, "email"),
    false,
  );
  const listed = await find_by_filter(room.base_url, "users", "id != ''", peer_token);
  check("(fixture) the peer's list is non-empty", listed.length > 0, true);
  check(
    "no listed record carries an email_key",
    listed.filter((r) => Object.hasOwn(r, "email_key")),
    [],
  );
  [s] = await api(
    room.base_url,
    "GET",
    "/api/collections/users/records?" + urlencode({ filter: "email_key='nowfolded@gmail.com'" }),
    null,
    peer_token,
  );
  check("a peer cannot even filter on email_key → 400", s, 400);

  console.log("\n── (h9) two parallel fold-equivalent signups leave exactly one account ──");
  // The hook's read-then-write scan races (SQLite serializes the COMMIT, not the read);
  // the partial unique index on email_key is the backstop, and its refusal must still be
  // a clean 400 rather than a 500 or a second row.
  // Which refusal a free race produces depends on the interleaving (about 4 in 10 rounds reach
  // the index locally, fewer on a slow runner), so these rounds check only the invariants.
  const RACE_ROUNDS = 3;
  for (let round_no = 0; round_no < RACE_ROUNDS; round_no++) {
    const pair = [`race.${round_no}.pair@gmail.com`, `race${round_no}pair+tag@gmail.com`];
    const race_key = `race${round_no}pair@gmail.com`;
    const race_out: [number, any][] = await Promise.all(
      pair.map((email, i) => signup(email, `race ${round_no}-${i}`, su_token)),
    );
    const statuses = race_out.map((r) => r[0]).sort((a, b) => a - b);
    check(`round ${round_no}: one create wins, one is refused`, statuses, [200, 400]);
    check(`round ${round_no}: exactly one row on ${race_key}`, rows_with_key(race_key), 1);
    const loser = race_out.find(([st]) => st !== 200)?.[1] ?? null;
    check(
      `round ${round_no}: the refusal is a clean duplicate verdict`,
      ["An account with this email address already exists.", "Failed to create record."].includes(
        loser?.message,
      ),
      true,
    );
  }

  console.log(
    "\n── (h9b) the index-caught refusal is the body the sign-up screen must classify ──",
  );
  // The pre-scan's verdict never reaches this loser, so its per-field failure code is the
  // only thing naming what happened — that is what a client keys on. H9B_HOOK forces the
  // interleaving, so this pair reaches the index on every run.
  const forced: [number, any][] = await Promise.all([
    signup("forced.loser.pair@gmail.com", "forced loser", su_token),
    signup("forcedloserpair+win@gmail.com", "forced winner", su_token),
  ]);
  check(
    "forced pair: the winner 200, the loser 400",
    forced.map((r) => r[0]),
    [400, 200],
  );
  check("forced pair: exactly one row on the key", rows_with_key("forcedloserpair@gmail.com"), 1);
  const index_loser = forced[0][1];
  console.log(`  observed on the wire: ${json_dumps(index_loser, { sort_keys: true })}`);
  check("the index-caught refusal is a 400", index_loser.status ?? null, 400);
  check(
    "…it carries PB's generic create message, not the fold verdict",
    index_loser.message ?? null,
    "Failed to create record.",
  );
  check(
    "…and names the duplicate only by a per-field failure code",
    getitem(getitem(index_loser, "data"), "email_key").code ?? null,
    "validation_not_unique",
  );

  // ══════════════════════════════════════════════════════════════════════════
  // (i) abandoned unconfirmed signups expire after 30 days
  // ══════════════════════════════════════════════════════════════════════════
  // COVERS: boot:signup_purge.pb.js, cron:unconfirmed-signup-purge
  console.log("\n── (i) PBTT-290: the 30-day retention boundary ──");

  const su_signup = async (
    name: string,
    email: string,
    verified: boolean,
    approved: boolean,
  ): Promise<any> => {
    const [s, r] = await api(
      room.base_url,
      "POST",
      "/api/collections/users/records",
      {
        email,
        password: "signup123456",
        passwordConfirm: "signup123456",
        name,
        verified,
        approved,
      },
      su_token,
    );
    check(`(fixture) ${name} created`, s, 200);
    return r.id ?? null;
  };

  const backdate = (user_id: string, delta_ms: number): string => {
    // users.created is an autodate field: PB overwrites it on every save, so even a
    // superuser PATCH cannot age a row. Writing the column directly is the only way.
    const stamp =
      new Date(Date.now() - delta_ms).toISOString().slice(0, 19).replace("T", " ") + ".000Z";
    const con = open_db();
    con.query("UPDATE users SET created = ? WHERE id = ?").run(stamp, user_id);
    con.close();
    return stamp;
  };

  const user_alive = async (user_id: string | null): Promise<boolean> => {
    const [s] = await api(
      room.base_url,
      "GET",
      `/api/collections/users/records/${py_str(user_id)}`,
      null,
      su_token,
    );
    return s === 200;
  };

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  // (verified, approved, age) — the four unconfirmed rows bracket the cutoff from
  // 29 days out to one hour either side of it.
  const purge_fixtures: Record<string, [boolean, boolean, number]> = {
    "purge-29d": [false, true, 29 * DAY],
    "purge-30d-minus-1h": [false, true, 30 * DAY - HOUR],
    "purge-30d-plus-1h": [false, true, 30 * DAY + HOUR],
    "purge-31d": [false, true, 31 * DAY],
    "purge-31d-shared-owner": [false, true, 31 * DAY],
    "purge-confirmed-10y": [true, true, 3650 * DAY],
    "purge-unapproved-10y": [false, false, 3650 * DAY],
    "purge-today": [false, true, 0],
  };
  const purge_ids: Record<string, any> = {};
  for (const [name, [verified, approved, age]] of Object.entries(purge_fixtures)) {
    const uid = await su_signup(name, `${name}@example.com`, verified, approved);
    purge_ids[name] = uid;
    if (age) backdate(uid, age);
  }

  // A co-member in this account's workspace: the purge runs the account-delete
  // sole-owner veto itself (kata bwpj), so this account must outlive the sweep.
  const doomed = getitem(purge_ids, "purge-31d-shared-owner");
  const doomed_ws = await find_by_filter(
    room.base_url,
    "workspaces",
    `owner='${py_str(doomed)}'`,
    su_token,
  );
  check("(fixture) the doomed account owns a workspace", doomed_ws.length, 1);
  const doomed_ws_id = doomed_ws.length ? (doomed_ws[0].id ?? null) : null;
  const lodger_id = await su_signup("purge-lodger", "purge-lodger@example.com", true, true);
  [s] = await api(
    room.base_url,
    "POST",
    "/api/collections/workspace_members/records",
    { workspace: doomed_ws_id, user: lodger_id, role: "member", status: "active" },
    su_token,
  );
  check("(fixture) a co-member joins the doomed account's workspace", s, 200);
  // Views a purged account saved in a workspace that outlives it: the purge is a programmatic
  // delete, so this is the non-API half of the saved_views.owner proof (kata bwpj).
  const purged_views: Record<string, any> = {};
  for (const scope of ["workspace", "personal"]) {
    let v: any;
    [s, v] = await api(
      room.base_url,
      "POST",
      "/api/collections/saved_views/records",
      {
        name: `purged-${scope}-view`,
        workspace: doomed_ws_id,
        owner: getitem(purge_ids, "purge-31d"),
        scope,
      },
      su_token,
    );
    check(`(fixture) a purge-bound account's ${scope} view in that workspace`, s, 200);
    purged_views[scope] = v.id ?? null;
  }

  let cron_list: any;
  [s, cron_list] = await api(room.base_url, "GET", "/api/crons", null, su_token);
  check("GET /api/crons → 200", s, 200);
  const cron_ids = Array.isArray(cron_list) ? cron_list.map((c) => c.id ?? null) : [];
  check(
    "unconfirmed-signup-purge is registered",
    cron_ids.includes("unconfirmed-signup-purge"),
    true,
  );

  [s] = await api(room.base_url, "POST", "/api/crons/unconfirmed-signup-purge", null, su_token);
  check("POST /api/crons/unconfirmed-signup-purge → 204", s, 204);
  // The trigger runs the sweep in the background and a skipped account never disappears, so
  // wait on the sweep's own log lines; PB holds an entry ~3s before /api/logs returns it.
  const logged = async (message: string): Promise<number> => {
    const deadline = Date.now() + 20000;
    let n = 0;
    while (Date.now() < deadline) {
      const qs = urlencode({ filter: `message = "${message}"`, perPage: 50 });
      const [, r] = await api(room.base_url, "GET", `/api/logs?${qs}`, null, su_token);
      n = r.totalItems ?? 0;
      if (n > 0) break;
      await Bun.sleep(250);
    }
    return n;
  };
  check("the sweep ran to completion", (await logged("unconfirmed-signup-purge swept")) > 0, true);

  check("31 days unconfirmed → PURGED", await user_alive(getitem(purge_ids, "purge-31d")), false);
  check(
    "30 days + 1 hour unconfirmed → PURGED",
    await user_alive(getitem(purge_ids, "purge-30d-plus-1h")),
    false,
  );
  check(
    "30 days − 1 hour unconfirmed → SURVIVES",
    await user_alive(getitem(purge_ids, "purge-30d-minus-1h")),
    true,
  );
  check("29 days unconfirmed → SURVIVES", await user_alive(getitem(purge_ids, "purge-29d")), true);
  check(
    "today's unconfirmed signup → SURVIVES",
    await user_alive(getitem(purge_ids, "purge-today")),
    true,
  );
  check(
    "a CONFIRMED account 10 years old → SURVIVES",
    await user_alive(getitem(purge_ids, "purge-confirmed-10y")),
    true,
  );
  check(
    "an unapproved account 10 years old → SURVIVES (waiting on an admin, not an inbox)",
    await user_alive(getitem(purge_ids, "purge-unapproved-10y")),
    true,
  );
  check("the co-member's own account → SURVIVES", await user_alive(lodger_id), true);
  check(
    "31 days unconfirmed but sole owner of a shared workspace → SURVIVES (the veto)",
    await user_alive(doomed),
    true,
  );
  check(
    "…and the workspace its co-member relies on survives with it",
    (
      await api(
        room.base_url,
        "GET",
        `/api/collections/workspaces/records/${py_str(doomed_ws_id)}`,
        null,
        su_token,
      )
    )[0],
    200,
  );
  check(
    "…and the skip is logged",
    (await logged("unconfirmed-signup-purge skipped a sole owner of a shared workspace")) > 0,
    true,
  );
  const view_after = async (id: string | null): Promise<[number, any]> =>
    api(room.base_url, "GET", `/api/collections/saved_views/records/${py_str(id)}`, null, su_token);
  check(
    "a purged account's shared view survives, owner emptied",
    await view_after(purged_views.workspace).then(([st, v]) => [st, v.owner ?? null]),
    [200, ""],
  );
  check(
    "a purged account's personal view, reachable by no one now, is deleted",
    (await view_after(purged_views.personal))[0],
    404,
  );
  check(
    "a purged sole owner of an unshared workspace leaves no workspace behind",
    (
      await find_by_filter(
        room.base_url,
        "workspaces",
        `owner='${py_str(getitem(purge_ids, "purge-31d"))}'`,
        su_token,
      )
    ).length,
    0,
  );
  check(
    "the signup from (a) — verified + approved — is untouched",
    await user_alive(user_id),
    true,
  );
} finally {
  await room.stop();
  room.cleanup_tmp();
}

console.log(`\n${"=".repeat(70)}`);
if (failures) {
  console.log(`❌ ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("✅ all checks passed");
  process.exit(0);
}

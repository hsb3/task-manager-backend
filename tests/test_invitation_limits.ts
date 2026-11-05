#!/usr/bin/env bun
/**decision:invitation-send-limit-and-decline-block: the per-inviter daily invitation limit and decline suppression.

1  Every invitation an account sends is claimed from `app_settings.invitation_mint_limit_per_day`
   (default 50) over a rolling 24 hours, across every workspace it invites to, through the
   invite route AND a direct collection create; the next one is refused 429. A superuser is
   exempt. Neither revoking nor deleting the workspace refunds; a duplicate re-invite that lands
   nothing spends nothing.
2  A decline leaves a tombstone: the same workspace re-inviting the same address inside
   `invitation_expiry_days` is refused 409. Revoke leaves none.
3  `invitation_events` (the ledger) is superuser-only, and the daily sweep prunes rows older
   than max(1, invitation_expiry_days) days.

Fully self-contained clean-room server, --hooksDir from a pb_hooks copy. Port 8150 +
PB_PORT_OFFSET (suite self-boot band, .agents/rules/ports.md).*/

// COVERS: hook:invitations.pb.js#onRecordCreate:workspace_invitations
// COVERS: hook:invitations.pb.js#onRecordCreateRequest:workspace_invitations
// COVERS: route:POST /api/tracker/invitations/{id}/decline
// COVERS: route:POST /api/tracker/workspaces/{id}/resolve-member-email
// COVERS: rule:invitation_events.list
// COVERS: rule:invitation_events.view
// COVERS: rule:invitation_events.create
// COVERS: rule:invitation_events.update
// COVERS: rule:invitation_events.delete
// COVERS: cron:invitation-expiry

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  py_get,
  py_repr,
  run_checked,
  sqlite_connect,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8150 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const INVITATIONS = "/api/collections/workspace_invitations/records";
const MEMBERS = "/api/collections/workspace_members/records";
const WORKSPACES = "/api/collections/workspaces/records";
const EVENTS = "/api/collections/invitation_events/records";
const LIMIT_ID = "wsinvmintlim050";
const LIMIT_MSG = "You have reached the daily limit for sending invitations. Try again later.";
const DECLINED_MSG =
  "This person recently declined an invitation to this workspace. " +
  "You can invite them again later.";

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
  if (r.ok) return [r.status, raw ? JSON.parse(raw) : {}];
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, { raw: Array.from(raw).slice(0, 300).join("") }];
  }
}

function refusal(status: number, msg: string) {
  return tup(status, msg);
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-invitation-limits-test-"));
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
  let s: number;
  let r: any;
  [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = getitem(r, "token");
  const DB = path.join(DATA_DIR, "data.db");

  /** Impersonation, not auth-with-password: the login limiter would 429 a dozen fixtures. */
  async function imp(user_id: string): Promise<string> {
    const [s, r] = await api("POST", `/api/collections/users/impersonate/${user_id}`, su, {});
    if (s !== 200) {
      throw new Error(`impersonate(${user_id}) failed: ${s} ${py_repr(r)}`);
    }
    return getitem(r, "token");
  }

  async function mkuser(tag: string): Promise<[string, string, string]> {
    const email = `limits-${tag}@example.test`;
    const [s, u] = await api("POST", "/api/collections/users/records", su, {
      email: email,
      password: "test123456",
      passwordConfirm: "test123456",
      name: tag,
      verified: true,
      approved: true,
    });
    if (s !== 200) {
      throw new Error(`mkuser(${tag}) failed: ${s} ${py_repr(u)}`);
    }
    return [getitem(u, "id"), email, await imp(getitem(u, "id"))];
  }

  async function mkws(name: string, owner_id: string, tok: string): Promise<string> {
    const [s, ws] = await api("POST", WORKSPACES, tok, { name: name, owner: owner_id });
    if (s !== 200) {
      throw new Error(`mkws(${name}) failed: ${s} ${py_repr(ws)}`);
    }
    return getitem(ws, "id");
  }

  async function add_member(ws: string, user_id: string, role: string): Promise<void> {
    const [s, m] = await api("POST", MEMBERS, su, {
      workspace: ws,
      user: user_id,
      role: role,
      status: "active",
    });
    if (s !== 200) {
      throw new Error(`add_member failed: ${s} ${py_repr(m)}`);
    }
  }

  async function route(ws: string, tok: string | null, email: string) {
    const [s, r] = await api("POST", `/api/tracker/workspaces/${ws}/resolve-member-email`, tok, {
      email: email,
    });
    return tup(s, py_get(r, "message", r));
  }

  async function direct(
    ws: string,
    tok: string | null,
    email: string,
    extra: Record<string, any> = {},
  ) {
    const [s, r] = await api("POST", INVITATIONS, tok, {
      workspace: ws,
      email: email,
      role: "member",
      ...extra,
    });
    return tup(s, s !== 200 ? py_get(r, "message", r) : r);
  }

  async function invites(ws: string): Promise<any[]> {
    const qs = urlencode({ filter: `workspace='${ws}'`, perPage: 500 });
    return (await api("GET", `${INVITATIONS}?${qs}`, su))[1].items ?? [];
  }

  async function events(flt: string): Promise<any[]> {
    const qs = urlencode({ filter: flt, perPage: 500 });
    const [s, r] = await api("GET", `${EVENTS}?${qs}`, su);
    if (s !== 200) {
      throw new Error(`events(${flt}) failed: ${s} ${py_repr(r)}`);
    }
    return getitem(r, "items");
  }

  async function mints(user_id: string): Promise<number> {
    return (await events(`kind='mint' && inviter='${user_id}'`)).length;
  }

  async function set_setting(key: string, value: number): Promise<void> {
    const rec = getitem(
      getitem(
        (
          await api(
            "GET",
            "/api/collections/app_settings/records?" + urlencode({ filter: `key='${key}'` }),
            su,
          )
        )[1],
        "items",
      )[0],
      "id",
    );
    const [s] = await api("PATCH", `/api/collections/app_settings/records/${rec}`, su, {
      value: value,
    });
    check(`(fixture) ${key} set to ${value}`, s, 200);
  }

  function backdate(sql_filter: string, params: string[], when: string): void {
    const con = sqlite_connect(DB);
    con.run(`UPDATE invitation_events SET created = ? WHERE ${sql_filter}`, [when, ...params]);
    con.close();
  }

  function ago(kw: { days?: number; hours?: number; minutes?: number }): string {
    const ms = ((kw.days ?? 0) * 24 * 60 + (kw.hours ?? 0) * 60 + (kw.minutes ?? 0)) * 60_000;
    return new Date(Date.now() - ms)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, ".000Z");
  }

  // ═══════════════════════ fixtures ═══════════════════════
  console.log("\n── fixtures ──");
  const [a_id, a_email, A] = await mkuser("owner-a");
  const WS1 = await mkws("Limits A1", a_id, A);
  const WS2 = await mkws("Limits A2", a_id, A);
  const [b_id, b_email, B] = await mkuser("owner-b");
  const WS3 = await mkws("Limits B1", b_id, B);
  const WS4 = await mkws("Limits B2", b_id, B);
  const [adm_id, , ADMIN] = await mkuser("admin-a1");
  await add_member(WS1, adm_id, "admin");
  const [mem_id, , MEMBER] = await mkuser("member-a1");
  await add_member(WS1, mem_id, "member");
  const [, , STRANGER] = await mkuser("stranger");
  const [accepter_id, accepter_email, ACCEPTER] = await mkuser("accepter");
  const [decliner_id, decliner_email, DECLINER] = await mkuser("decliner");

  // ═══════════════════════ the setting and the ledger's rules ═══════════════════════
  console.log("\n── the setting row and the ledger's null rules (full role matrix) ──");
  let rec: any;
  [s, rec] = await api("GET", `/api/collections/app_settings/records/${LIMIT_ID}`, su);
  check(
    "invitation_mint_limit_per_day seeded at 50",
    tup(s, rec.key ?? null, rec.value ?? null),
    tup(200, "invitation_mint_limit_per_day", 50),
  );
  for (const [who, tok] of [
    ["owner", A],
    ["admin", ADMIN],
    ["member", MEMBER],
    ["non-member", STRANGER],
    ["anon", null],
  ] as [string, string | null][]) {
    check(`${who} lists invitation_events → 403`, (await api("GET", EVENTS, tok))[0], 403);
    check(
      `${who} views an invitation_events id → 403`,
      (await api("GET", `${EVENTS}/abcdefghijklmno`, tok))[0],
      403,
    );
    check(
      `${who} creates an invitation_events row → 403`,
      (
        await api("POST", EVENTS, tok, {
          kind: "mint",
          workspace: WS1,
          email_key: "x@example.test",
        })
      )[0],
      403,
    );
    check(
      `${who} updates an invitation_events id → 403`,
      (await api("PATCH", `${EVENTS}/abcdefghijklmno`, tok, { kind: "decline" }))[0],
      403,
    );
    check(
      `${who} deletes an invitation_events id → 403`,
      (await api("DELETE", `${EVENTS}/abcdefghijklmno`, tok))[0],
      403,
    );
  }
  check("superuser lists invitation_events → 200", (await api("GET", EVENTS, su))[0], 200);

  console.log("\n── refused inviters write no ledger row ──");
  check("member via route → 404", (await route(WS1, MEMBER, "nope1@example.test"))[0], 404);
  check("non-member via route → 404", (await route(WS1, STRANGER, "nope2@example.test"))[0], 404);
  check("anon via route → 401", (await route(WS1, null, "nope3@example.test"))[0], 401);
  check("member direct create → 400", (await direct(WS1, MEMBER, "nope4@example.test"))[0], 400);
  check("ledger still empty", (await events("id!=''")).length, 0);

  // ═══════════════════════ 1: 50 per inviter, both paths, across workspaces ═════════
  console.log("\n── 1: owner A sends 50 across two workspaces and both paths ──");
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) {
    const email = i === 0 ? accepter_email : `a1-${i}@example.test`;
    statuses.push((await route(WS1, A, email))[0]);
  }
  for (let i = 0; i < 25; i++) {
    statuses.push((await direct(WS2, A, `a2-${i}@example.test`))[0]);
  }
  check(
    "all 50 accepted (25 route to WS1, 25 direct create to WS2)",
    statuses,
    new Array(50).fill(200),
  );
  check("the ledger holds 50 mint rows for A", await mints(a_id), 50);
  check(
    "the 51st via the route (WS1) → 429 with the limit message",
    await route(WS1, A, "a1-over@example.test"),
    refusal(429, LIMIT_MSG),
  );
  check(
    "the 51st via a direct create (WS2) → 429 with the limit message",
    await direct(WS2, A, "a2-over@example.test"),
    refusal(429, LIMIT_MSG),
  );
  check(
    "neither refused invitation landed",
    [...(await invites(WS1)), ...(await invites(WS2))]
      .map((i) => getitem(i, "email"))
      .filter((e) => e.includes("over")),
    [],
  );
  check("refusals spent no slot (still 50)", await mints(a_id), 50);
  check(
    "re-inviting an already pending address at the limit is still the same 200 ack",
    await route(WS1, A, "a1-3@example.test"),
    tup(200, { invited: true }),
  );
  [s] = await direct(WS1, A, "a1-over-2@example.test");
  check("a direct create to the route's workspace (WS1) is refused too", s, 429);

  console.log("\n── 1: other accounts are unaffected ──");
  check("owner B (another inviter) → 200", (await route(WS3, B, "b-1@example.test"))[0], 200);
  check(
    "an active admin of A's workspace is its own inviter → 200",
    (await route(WS1, ADMIN, "adm-1@example.test"))[0],
    200,
  );
  check("that mint counted against the admin", await mints(adm_id), 1);

  console.log("\n── 1: a superuser is exempt ──");
  [s, r] = await direct(WS1, su, "su-1@example.test", { invited_by: a_id });
  check("superuser direct create stamped invited_by=A (at the limit) → 200", s, 200);
  check("and wrote no mint row", await mints(a_id), 50);

  console.log("\n── AC3: an invitation sent before the limit stays pending and acceptable ──");
  const pend = (await invites(WS1)).filter((i) => getitem(i, "email") === accepter_email);
  check("A's first invitation is still pending", pend.length, 1);
  [s, r] = await api("POST", `/api/tracker/invitations/${getitem(pend[0], "id")}/accept`, ACCEPTER);
  check("the invitee accepts it → 200 active member", tup(s, r.status ?? null), tup(200, "active"));
  check(
    "WS1 still holds A's other 24 pending invitations",
    (await invites(WS1)).filter((i) => getitem(i, "email").startsWith("a1-")).length,
    24,
  );

  console.log("\n── 1: the window rolls ──");
  backdate("kind='mint' AND inviter=?", [a_id], ago({ hours: 25 }));
  check(
    "with A's mints aged past 24h, A invites again → 200",
    (await route(WS1, A, "a1-rolled@example.test"))[0],
    200,
  );

  // ═══════════════════════ a lowered setting takes effect without restart ══════════
  console.log(
    "\n── a lowered setting applies at once; revoke does not refund; a duplicate spends nothing ──",
  );
  const [c_id, , C] = await mkuser("owner-c");
  const WS5 = await mkws("Limits C1", c_id, C);
  await set_setting("invitation_mint_limit_per_day", 3);
  check("C invites c-1 → 200", (await route(WS5, C, "c-1@example.test"))[0], 200);
  check("C re-invites c-1 (duplicate) → 200", (await route(WS5, C, "c-1@example.test"))[0], 200);
  check(
    "C direct-creates c-1 again (duplicate) → 400",
    (await direct(WS5, C, "c-1@example.test"))[0],
    400,
  );
  check("the duplicates spent no slot", await mints(c_id), 1);
  check("C invites c-2 → 200", (await route(WS5, C, "c-2@example.test"))[0], 200);
  const c2 = (await invites(WS5)).find((i) => getitem(i, "email") === "c-2@example.test");
  check(
    "C revokes c-2 → 204",
    (await api("DELETE", `${INVITATIONS}/${getitem(c2, "id")}`, C))[0],
    204,
  );
  check(
    "C re-sends c-2 after the revoke → 200 (revoke is not suppressed)",
    (await route(WS5, C, "c-2@example.test"))[0],
    200,
  );
  check("the revoke refunded nothing: C has spent 3", await mints(c_id), 3);
  check(
    "C's 4th under a limit of 3 → 429",
    await route(WS5, C, "c-3@example.test"),
    refusal(429, LIMIT_MSG),
  );
  await set_setting("invitation_mint_limit_per_day", 50);
  check("raised back to 50, C's 4th → 200", (await route(WS5, C, "c-3@example.test"))[0], 200);

  console.log("\n── concurrent sends cannot overshoot the limit ──");
  const [d_id, , D] = await mkuser("owner-d");
  const WS6 = await mkws("Limits D1", d_id, D);
  await set_setting("invitation_mint_limit_per_day", 5);
  // The Python Barrier(12) released all 12 threads together; every request is started
  // here before any is awaited, which puts all 12 on the wire at once.
  const results: number[] = (
    await Promise.all(Array.from({ length: 12 }, (_, n) => route(WS6, D, `d-${n}@example.test`)))
  ).map((t) => t[0]);
  check(
    "12 parallel sends under a limit of 5 → exactly 5 × 200, 7 × 429",
    results.sort((a, b) => a - b),
    [...new Array(5).fill(200), ...new Array(7).fill(429)],
  );
  check(
    "D's ledger holds exactly 5 mints and 5 invitations landed",
    tup(await mints(d_id), (await invites(WS6)).length),
    tup(5, 5),
  );
  await set_setting("invitation_mint_limit_per_day", 50);

  console.log("\n── deleting a workspace refunds none of its sends ──");
  const [e_id, , E] = await mkuser("owner-e");
  const WS7 = await mkws("Limits E1", e_id, E);
  const WS8 = await mkws("Limits E2", e_id, E);
  await set_setting("invitation_mint_limit_per_day", 3);
  const e_sends: number[] = [];
  for (let n = 0; n < 3; n++) e_sends.push((await route(WS7, E, `e-${n}@example.test`))[0]);
  check("E sends 3 from E1 → 3 × 200", e_sends, new Array(3).fill(200));
  check("E moves E1 to the trash → 204", (await api("DELETE", `${WORKSPACES}/${WS7}`, E))[0], 204);
  check("E deletes E1 permanently → 204", (await api("DELETE", `${WORKSPACES}/${WS7}`, E))[0], 204);
  check("E1 is gone for good", (await api("GET", `${WORKSPACES}/${WS7}`, su))[0], 404);
  check(
    "E's 3 sends are kept, their workspace cleared",
    (await events(`kind='mint' && inviter='${e_id}'`)).map((ev) => getitem(ev, "workspace")),
    new Array(3).fill(""),
  );
  check(
    "E's 4th, from E2, under a limit of 3 → 429",
    await route(WS8, E, "e-3@example.test"),
    refusal(429, LIMIT_MSG),
  );
  await set_setting("invitation_mint_limit_per_day", 50);

  // ═══════════════════════ 2: decline tombstone ═══════════════════════
  console.log("\n── 2: a decline blocks a repeat from that workspace ──");
  check("B invites the decliner to WS3 → 200", (await route(WS3, B, decliner_email))[0], 200);
  const inv = (await invites(WS3)).find((i) => getitem(i, "email") === decliner_email);
  [s, r] = await api("POST", `/api/tracker/invitations/${getitem(inv, "id")}/decline`, DECLINER);
  check("the invitee declines → 200", tup(s, r), tup(200, { declined: true }));
  check(
    "a decline tombstone was written for WS3",
    (await events(`kind='decline' && workspace='${WS3}'`)).length,
    1,
  );
  const before = await mints(b_id);
  check(
    "B re-invites via the route → 409 with the declined message",
    await route(WS3, B, decliner_email),
    refusal(409, DECLINED_MSG),
  );
  check(
    "B re-invites via a direct create (different case) → 409",
    await direct(WS3, B, "  " + decliner_email.toUpperCase()),
    refusal(409, DECLINED_MSG),
  );
  check(
    "no invitation landed and no slot was spent",
    tup(
      (await invites(WS3)).filter((i) => getitem(i, "email") === decliner_email),
      await mints(b_id),
    ),
    tup([], before),
  );
  check(
    "B's OTHER workspace may still invite the same address → 200",
    (await route(WS4, B, decliner_email))[0],
    200,
  );
  backdate("kind='decline' AND workspace=?", [WS3], ago({ days: 7, minutes: 1 }));
  check(
    "after invitation_expiry_days (7) have passed, B re-invites → 200",
    (await route(WS3, B, decliner_email))[0],
    200,
  );

  console.log("\n── 2: revoke leaves no tombstone ──");
  check("B invites r-1 → 200", (await route(WS3, B, "r-1@example.test"))[0], 200);
  const r1 = (await invites(WS3)).find((i) => getitem(i, "email") === "r-1@example.test");
  check("B revokes → 204", (await api("DELETE", `${INVITATIONS}/${getitem(r1, "id")}`, B))[0], 204);
  check("B re-invites r-1 at once → 200", (await route(WS3, B, "r-1@example.test"))[0], 200);
  check(
    "the only decline rows are the one real decline",
    (await events("kind='decline'")).length,
    1,
  );

  // ═══════════════════════ 3: the sweep prunes the ledger ═══════════════════════
  console.log("\n── 3: the daily sweep prunes events older than max(1, invitation_expiry_days) ──");
  const olds = await events(`kind='mint' && inviter='${b_id}'`);
  const old_id = getitem(olds[0], "id");
  const keep_id = getitem(olds[1], "id");
  backdate("id=?", [old_id], ago({ days: 8 }));
  backdate("id=?", [keep_id], ago({ days: 6 }));
  check(
    "triggering the sweep → 204",
    (await api("POST", "/api/crons/invitation-expiry", su))[0],
    204,
  );
  let ids = new Set<string>();
  for (let _ = 0; _ < 50; _++) {
    ids = new Set((await events("id!=''")).map((e) => getitem(e, "id")));
    if (!ids.has(old_id)) break;
    await Bun.sleep(100);
  }
  check("an 8-day-old event is pruned (7-day setting)", ids.has(old_id), false);
  check("a 6-day-old event is kept", ids.has(keep_id), true);
  await set_setting("invitation_expiry_days", 0);
  backdate("id=?", [keep_id], ago({ hours: 12 }));
  const older = getitem(olds[2], "id");
  backdate("id=?", [older], ago({ hours: 25 }));
  await api("POST", "/api/crons/invitation-expiry", su);
  for (let _ = 0; _ < 50; _++) {
    ids = new Set((await events("id!=''")).map((e) => getitem(e, "id")));
    if (!ids.has(older)) break;
    await Bun.sleep(100);
  }
  check(
    "at a 0-day setting the floor is one day: a 25-hour-old event is pruned",
    ids.has(older),
    false,
  );
  check("…and a 12-hour-old event (still in the daily count) is kept", ids.has(keep_id), true);
  await set_setting("invitation_expiry_days", 7);
} finally {
  if (server !== null) {
    await roomkit.stop(server);
  }
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} FAILED`);
  throw new roomkit.SystemExit(1);
}
console.log(
  "✅ all invitation-limit (decision:invitation-send-limit-and-decline-block) proofs passed",
);

#!/usr/bin/env bun
/**Invitation mail: a signed-in inviter's workspace_invitations create (collection create or the
invite route) mails the invitee once, answers `mail_sent`, and a re-invite of a pending address
resends the SAME invitation (an expired one is replaced). Superuser rows and a room without SMTP
send nothing and say so; the secret-guarded internal mail route refuses everyone else; a failed
send is logged with the address redacted; a second resend of the same
invitation inside a minute is refused 429; an unroutable mail server never holds the create
(decision:invitation-mail-and-resend).

Bounded: the resend window REOPENING after 60 s is not proven (the suite never waits a minute).

Clean room, --hooksDir from a pb_hooks copy, mail captured by scripts/smtp_sink.ts; the failure
path uses an in-suite SMTP listener on the sink port that rejects every recipient.
Port 8187 + PB_PORT_OFFSET (suite self-boot band); SMTP sink on 2535 + PB_PORT_OFFSET.*/

// COVERS: route:POST /api/tracker/workspaces/{id}/resolve-member-email
// COVERS: hook:invitations.pb.js#onRecordAfterCreateSuccess:workspace_invitations
// COVERS: hook:invitations.pb.js#onRecordCreateRequest:workspace_invitations
// COVERS: route:POST /internal/invitation-mail/{id}

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  py_repr,
  read_text,
  run_checked,
  splitlines,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const SMTP_SINK = path.join(REPO_ROOT, "scripts", "smtp_sink.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8187 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const SINK_PORT = 2535 + PORT_OFFSET;
const SENDER = "invites@example.com";
const MAIL_WAIT = 10; // seconds; the send follows the create response by milliseconds, so this is slack
const INVITATIONS = "/api/collections/workspace_invitations/records";
const EVENTS = "/api/collections/invitation_events/records";
const RESEND_MSG = "This invitation was sent again less than a minute ago. Try again later.";

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
  p: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  let raw: string;
  try {
    r = await fetch(BASE_URL + p, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, { _raw: raw.slice(0, 300) }];
  }
}

function connect_ok(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.setTimeout(500);
    sock.once("connect", () => {
      sock.end();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
}

async function start_sink(mail_dir: string): Promise<Bun.Subprocess> {
  fs.mkdirSync(mail_dir, { recursive: true });
  const proc = Bun.spawn([process.execPath, SMTP_SINK], {
    env: { ...process.env, SINK_PORT: String(SINK_PORT), MAIL_DIR: mail_dir },
    stdout: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await connect_ok(SINK_PORT))) await Bun.sleep(200);
  if (!(await connect_ok(SINK_PORT)))
    throw new roomkit.SystemExit(`SMTP sink never listened on ${SINK_PORT}`);
  return proc;
}

async function stop_sink(proc: Bun.Subprocess | null): Promise<void> {
  if (proc === null) return;
  proc.kill();
  if ((await Promise.race([proc.exited, Bun.sleep(10000).then(() => null)])) === null) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  if (!(await roomkit.wait_for_port_free(SINK_PORT))) {
    console.log(`  ⚠️  sink port ${SINK_PORT} still occupied after stopping`);
  }
}

function eml_count(mail_dir: string): number {
  return fs.existsSync(mail_dir)
    ? fs.readdirSync(mail_dir).filter((f) => f.endsWith(".eml")).length
    : 0;
}

// Captured messages addressed to `addr` (soft line breaks unfolded so a QP-wrapped link matches).
function mails_to(mail_dir: string, addr: string): string[] {
  if (!fs.existsSync(mail_dir)) return [];
  return fs
    .readdirSync(mail_dir)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => read_text(path.join(mail_dir, f)))
    .filter((c) => splitlines(c).some((ln) => /^To:/i.test(ln) && ln.toLowerCase().includes(addr)))
    .map((c) => c.replace(/=\r?\n/g, ""));
}

async function wait_for_mails(mail_dir: string, addr: string, n: number): Promise<string[]> {
  const deadline = Date.now() + MAIL_WAIT * 1000;
  while (Date.now() < deadline) {
    if (mails_to(mail_dir, addr).length >= n) break;
    await Bun.sleep(200);
  }
  await Bun.sleep(500); // settle: a duplicate send would land right behind the last
  return mails_to(mail_dir, addr);
}

const header = (msg: string, name: string): string | null =>
  splitlines(msg).find((ln) => ln.toLowerCase().startsWith(name.toLowerCase() + ":")) ?? null;

// Rejects every RCPT echoing the address back, so the transport error carries it (a refused
// connection's error never does, and could not prove the redaction).
function start_rejector() {
  return Bun.listen({
    hostname: "127.0.0.1",
    port: SINK_PORT,
    socket: {
      open(sock) {
        sock.write("220 rejector ESMTP\r\n");
      },
      data(sock, d) {
        for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
          const u = line.toUpperCase();
          if (u.startsWith("RCPT")) {
            sock.write(
              `550 5.1.1 ${line.slice(line.indexOf("<"))}: Recipient address rejected\r\n`,
            );
          } else if (u.startsWith("QUIT")) {
            sock.write("221 bye\r\n");
            sock.end();
          } else sock.write("250 ok\r\n");
        }
      },
    },
  });
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-invitation-mail-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const MAIL_DIR = path.join(S, "mail");
const MAIL_DIR_2 = path.join(S, "mail2"); // a restarted sink renumbers from 001 and would overwrite
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
let sink: Bun.Subprocess | null = null;
let rejector: ReturnType<typeof start_rejector> | null = null;
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
  sink = await start_sink(MAIL_DIR);
  const [, auth] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = auth.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(auth)}`);

  let s: number;
  let r: any;
  const SMTP_SINK_SETTINGS = { enabled: true, host: "127.0.0.1", port: SINK_PORT, tls: false };
  [s] = await api("PATCH", "/api/settings", su, {
    smtp: SMTP_SINK_SETTINGS,
    meta: { senderName: "Task Tracker", senderAddress: SENDER },
  });
  check("superuser PATCH /api/settings (SMTP → the sink) → 200", s, 200);
  if (failures) throw new roomkit.SystemExit("cannot point SMTP at the sink — cannot proceed");

  // ── fixtures (by name) ──
  console.log("\n── fixtures ──");
  const OWNER_NAME = "Olive Owner";
  const WS_NAME = "Mail Room Alpha";
  [s, r] = await api("POST", "/api/collections/users/records", su, {
    email: "mail-owner@example.test",
    password: "test123456",
    passwordConfirm: "test123456",
    name: OWNER_NAME,
    verified: true,
    approved: true,
  });
  if (s !== 200) throw new roomkit.SystemExit(`owner fixture failed: ${s} ${py_repr(r)}`);
  const owner_id: string = r.id;
  [s, r] = await api("POST", `/api/collections/users/impersonate/${owner_id}`, su, {});
  if (s !== 200) throw new roomkit.SystemExit(`owner impersonation failed: ${s} ${py_repr(r)}`);
  const OWNER: string = r.token;
  [s, r] = await api("POST", "/api/collections/workspaces/records", OWNER, {
    name: WS_NAME,
    owner: owner_id,
  });
  if (s !== 200) throw new roomkit.SystemExit(`workspace fixture failed: ${s} ${py_repr(r)}`);
  const WS: string = r.id;
  console.log(`  ·  owner ${OWNER_NAME} (${owner_id}) owns workspace ${WS_NAME} (${WS})`);

  const route = (email: string) =>
    api("POST", `/api/tracker/workspaces/${WS}/resolve-member-email`, OWNER, { email });
  const direct = (tok: string, email: string, role = "member") =>
    api("POST", INVITATIONS, tok, { workspace: WS, email, role });
  const rows_for = async (email: string): Promise<any[]> =>
    (await api("GET", `${INVITATIONS}?${urlencode({ filter: `email='${email}'` })}`, su))[1]
      .items ?? [];
  const mints = async (): Promise<number> => {
    const qs = urlencode({ filter: `kind='mint' && inviter='${owner_id}'`, perPage: 500 });
    const [st, ev] = await api("GET", `${EVENTS}?${qs}`, su);
    if (st !== 200)
      throw new roomkit.SystemExit(`invitation_events read failed: ${st} ${py_repr(ev)}`);
    return getitem(ev, "items").length;
  };
  const set_setting = async (key: string, value: number): Promise<void> => {
    const [, lst] = await api(
      "GET",
      "/api/collections/app_settings/records?" + urlencode({ filter: `key='${key}'` }),
      su,
    );
    const [st] = await api(
      "PATCH",
      `/api/collections/app_settings/records/${lst.items[0].id}`,
      su,
      {
        value,
      },
    );
    check(`(fixture) app_settings ${key} set to ${value} → 200`, st, 200);
  };
  // PocketBase batches log writes (~3s), so a row is polled for rather than read once.
  const wait_for_log = async (message: string, inv_id: string): Promise<any[]> => {
    const qs = urlencode({ filter: `message = "${message}" && data.invitation = "${inv_id}"` });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const [, lg] = await api("GET", `/api/logs?${qs}`, su);
      if (lg.items?.length) return lg.items;
      await Bun.sleep(250);
    }
    return [];
  };

  // ═══════════════════════ (a) ═══════════════════════
  console.log("\n── (a) an owner's collection create mails the invitee once ──");
  const ADDR_A = "invitee-alpha@example.test";
  [s, r] = await direct(OWNER, ADDR_A, "viewer");
  check("owner collection create → 200", s, 200);
  check(
    "create response key set is EXACTLY the wire shape plus mail_sent",
    new Set(Object.keys(r)),
    new Set([
      "collectionId",
      "collectionName",
      "created",
      "email",
      "expired",
      "expires_at",
      "id",
      "invited_by",
      "mail_sent",
      "role",
      "workspace",
    ]),
  );
  check("create response mail_sent === true", r.mail_sent, true);
  const inv_a: string = r.id;
  const mail_a = await wait_for_mails(MAIL_DIR, ADDR_A, 1);
  check(`exactly ONE mail To ${ADDR_A} within ${MAIL_WAIT} s`, mail_a.length, 1);
  const body_a = mail_a[0] ?? "";
  check(`the mail names the workspace (${WS_NAME})`, body_a.includes(WS_NAME), true);
  check("the mail carries the invitation id", body_a.includes(inv_a), true);
  check(`the mail carries the app URL ${BASE_URL}`, body_a.includes(BASE_URL), true);
  check(
    "the mail carries the accept call path",
    body_a.includes(`/api/tracker/invitations/${inv_a}/accept`),
    true,
  );
  check("the mail names the role (viewer)", body_a.includes("viewer"), true);
  check(`the mail names the inviter (${OWNER_NAME})`, body_a.includes(OWNER_NAME), true);
  check(
    "the mail carries the decline call path",
    body_a.includes(`/api/tracker/invitations/${inv_a}/decline`),
    true,
  );
  check(
    "Subject is exactly the invitation subject",
    header(body_a, "Subject"),
    `Subject: [Task Tracker] You are invited to join ${WS_NAME}`,
  );
  check(
    `From carries the configured sender address (${SENDER})`,
    header(body_a, "From")?.includes(SENDER) ?? false,
    true,
  );
  [s, r] = await api("GET", `${INVITATIONS}?${urlencode({ filter: `id='${inv_a}'` })}`, OWNER);
  check(
    "owner list read of that row → 200, one item, no mail_sent key",
    tup(s, r.items?.length ?? null, r.items?.[0] ? "mail_sent" in r.items[0] : null),
    tup(200, 1, false),
  );

  console.log("\n── (a) the internal mail route refuses a caller without the server secret ──");
  const SEND_ROUTE = `/internal/invitation-mail/${inv_a}`;
  check("no X-Invitation-Mail header → 404", (await api("POST", SEND_ROUTE))[0], 404);
  check(
    "a wrong X-Invitation-Mail value → 404",
    (
      await fetch(BASE_URL + SEND_ROUTE, {
        method: "POST",
        headers: { "X-Invitation-Mail": "guess" },
      })
    ).status,
    404,
  );
  check("the owner's bearer token → 404", (await api("POST", SEND_ROUTE, OWNER))[0], 404);
  await Bun.sleep(3000);
  check(`still exactly ONE mail To ${ADDR_A} after 3 s`, mails_to(MAIL_DIR, ADDR_A).length, 1);

  // ═══════════════════════ (b) ═══════════════════════
  console.log("\n── (b) the invite route mails the invitee once ──");
  const ADDR_B = "invitee-bravo@example.test";
  [s, r] = await route(ADDR_B);
  check(
    "route invite → 200 {invited: true, mail_sent: true} (exact)",
    tup(s, r),
    tup(200, { invited: true, mail_sent: true }),
  );
  check(`exactly ONE mail To ${ADDR_B}`, (await wait_for_mails(MAIL_DIR, ADDR_B, 1)).length, 1);
  const rows_b0 = await rows_for(ADDR_B);
  if (rows_b0.length !== 1)
    throw new roomkit.SystemExit(`no invitation row for ${ADDR_B}: ${py_repr(rows_b0)}`);
  const inv_b: string = rows_b0[0].id;
  const created_b: string = rows_b0[0].created;

  // ═══════════════════════ (c) ═══════════════════════
  console.log("\n── (c) re-inviting a pending address resends the SAME invitation ──");
  const mints_c = await mints();
  [s, r] = await route(ADDR_B);
  check(
    "route re-invite → 200 {invited: true, mail_sent: true} (exact)",
    tup(s, r),
    tup(200, { invited: true, mail_sent: true }),
  );
  const mail_b2 = await wait_for_mails(MAIL_DIR, ADDR_B, 2);
  check(`now TWO mails To ${ADDR_B}`, mail_b2.length, 2);
  check(
    "both carry the same invitation id",
    mail_b2.length === 2 && mail_b2.every((m) => m.includes(inv_b)),
    true,
  );
  const rows_b1 = await rows_for(ADDR_B);
  check(
    "still exactly one row for that address, same id and created",
    rows_b1.map((x: any) => tup(x.id, x.created)),
    [tup(inv_b, created_b)],
  );
  check("the resend spent no daily slot (mint count unchanged)", await mints(), mints_c);

  // ═══════════════════════ (d) ═══════════════════════
  console.log("\n── (d) re-inviting an EXPIRED address replaces the invitation ──");
  await set_setting("invitation_expiry_days", 0);
  const mints_d = await mints();
  [s, r] = await route(ADDR_B);
  check("route re-invite of the expired address → 200", s, 200);
  const rows_b2 = await rows_for(ADDR_B);
  const inv_b2: string | null = rows_b2[0]?.id ?? null;
  check(
    "exactly one row for that address, with a DIFFERENT id",
    tup(rows_b2.length, inv_b2 !== null && inv_b2 !== inv_b),
    tup(1, true),
  );
  const mail_b3 = await wait_for_mails(MAIL_DIR, ADDR_B, 3);
  check(
    "a third mail To that address carries the new id",
    tup(mail_b3.length, mail_b3.filter((m) => inv_b2 !== null && m.includes(inv_b2)).length),
    tup(3, 1),
  );
  check("the replacement spent exactly one daily slot", await mints(), mints_d + 1);
  await set_setting("invitation_expiry_days", 7);

  // ═══════════════════════ (e) ═══════════════════════
  console.log("\n── (e) the mailed invitation is accepted by a new account ──");
  [s, r] = await api("POST", "/api/collections/users/records", null, {
    email: ADDR_A,
    name: "Alpha Invitee",
  });
  check("anonymous signup for the invited address → 200", s, 200);
  const user_a: string = r.id;
  const login_a = () =>
    api("POST", "/api/collections/users/auth-with-password", null, {
      identity: ADDR_A,
      password: "signup123456",
    });
  [s] = await login_a();
  console.log(`  ·  sign-in before verification and approval → status ${s}`);
  check("sign-in before verification and approval → NOT 200", s !== 200, true);
  // A signup carries no password (decision:password-signup-verify-first); the superuser sets one with the approval.
  [s] = await api("PATCH", `/api/collections/users/records/${user_a}`, su, {
    verified: true,
    approved: true,
    password: "signup123456",
    passwordConfirm: "signup123456",
  });
  check("superuser marks the account verified and approved → 200", s, 200);
  [s, r] = await login_a();
  check("sign-in now → 200", s, 200);
  const A: string | null = r.token ?? null;
  [s, r] = await api("GET", "/api/tracker/invitations/mine", A);
  check(
    "GET /api/tracker/invitations/mine lists the mailed invitation id",
    tup(
      s,
      (r.items ?? []).some((i: any) => i.id === inv_a),
    ),
    tup(200, true),
  );
  [s, r] = await api("POST", `/api/tracker/invitations/${inv_a}/accept`, A);
  check(
    "accept the mailed invitation → 200 with role viewer",
    tup(s, r.role ?? null),
    tup(200, "viewer"),
  );

  // ═══════════════════════ (f) ═══════════════════════
  console.log("\n── (f) a superuser-created invitation sends nothing ──");
  const ADDR_F = "invitee-foxtrot@example.test";
  [s, r] = await api("POST", INVITATIONS, su, {
    workspace: WS,
    email: ADDR_F,
    role: "member",
    invited_by: owner_id,
  });
  check("superuser collection create → 200", s, 200);
  check("create response mail_sent === false", r.mail_sent, false);
  await Bun.sleep(3000);
  check(`ZERO mails To ${ADDR_F} after 3 s`, mails_to(MAIL_DIR, ADDR_F).length, 0);

  // ═══════════════════════ (g) ═══════════════════════
  console.log("\n── (g) no SMTP: the create still lands, says mail_sent false, logs the skip ──");
  [s] = await api("PATCH", "/api/settings", su, { smtp: { enabled: false } });
  check("superuser PATCH /api/settings (SMTP off) → 200", s, 200);
  const eml_g = eml_count(MAIL_DIR);
  const ADDR_G1 = "invitee-golf@example.test";
  [s, r] = await direct(OWNER, ADDR_G1);
  check("owner collection create with SMTP off → 200", s, 200);
  check("create response mail_sent === false", r.mail_sent, false);
  const inv_g1: string = r.id;
  check(
    "the row exists (superuser view) → 200",
    (await api("GET", `${INVITATIONS}/${inv_g1}`, su))[0],
    200,
  );
  check(
    'one log row "invitation email skipped: SMTP disabled" with data.invitation = that id',
    (await wait_for_log("invitation email skipped: SMTP disabled", inv_g1)).length,
    1,
  );
  const ADDR_G2 = "invitee-hotel@example.test";
  [s, r] = await route(ADDR_G2);
  check(
    "route invite with SMTP off → 200 {invited: true, mail_sent: false}",
    tup(s, r),
    tup(200, { invited: true, mail_sent: false }),
  );
  [s, r] = await route(ADDR_G2);
  check(
    "route resend with SMTP off → 200 {invited: true, mail_sent: false}",
    tup(s, r),
    tup(200, { invited: true, mail_sent: false }),
  );
  await Bun.sleep(3000);
  check("ZERO new mails arrived in the sink during this section", eml_count(MAIL_DIR) - eml_g, 0);
  [s, r] = await api(
    "GET",
    `/api/logs?${urlencode({ filter: 'message ~ "invitation email"', perPage: 500 })}`,
    su,
  );
  const log_text = JSON.stringify(r.items ?? []);
  check(
    'no "invitation email" log row carries an invitee address',
    [ADDR_A, ADDR_B, ADDR_F, ADDR_G1, ADDR_G2].filter((a) => log_text.includes(a)),
    [],
  );

  // ═══════════════════════ (g2) ═══════════════════════
  console.log("\n── (g2) a failed send keeps the invitation and logs it without the address ──");
  [s] = await api("PATCH", "/api/settings", su, { smtp: SMTP_SINK_SETTINGS });
  check("superuser PATCH /api/settings (SMTP → the sink port) → 200", s, 200);
  await stop_sink(sink);
  sink = null;
  rejector = start_rejector();
  const ADDR_FAIL = "invitee-kilo@example.test";
  [s, r] = await direct(OWNER, ADDR_FAIL);
  check(
    "owner collection create with every recipient rejected → 200, mail_sent === true",
    tup(s, r.mail_sent ?? null),
    tup(200, true),
  );
  const fail_logs = await wait_for_log("invitation email failed", r.id);
  check(
    'exactly one "invitation email failed" row with data.invitation = that id',
    fail_logs.length,
    1,
  );
  check(
    "that row carries the redaction marker, not the address",
    tup(
      JSON.stringify(fail_logs).includes("[address]"),
      JSON.stringify(fail_logs).includes(ADDR_FAIL),
    ),
    tup(true, false),
  );
  rejector.stop(true);
  rejector = null;
  sink = await start_sink(MAIL_DIR_2);

  // ═══════════════════════ (h) ═══════════════════════
  console.log("\n── (h) a second resend inside a minute is refused ──");
  const ADDR_H = "invitee-juliet@example.test";
  [s, r] = await route(ADDR_H);
  check(
    "route invite → 200 {invited: true, mail_sent: true} (exact)",
    tup(s, r),
    tup(200, { invited: true, mail_sent: true }),
  );
  const inv_h: string | null = (await rows_for(ADDR_H))[0]?.id ?? null;
  [s, r] = await route(ADDR_H);
  check(
    "first resend → 200 {invited: true, mail_sent: true} (exact)",
    tup(s, r),
    tup(200, { invited: true, mail_sent: true }),
  );
  check(`TWO mails To ${ADDR_H}`, (await wait_for_mails(MAIL_DIR_2, ADDR_H, 2)).length, 2);
  [s, r] = await route(ADDR_H);
  check(
    "an immediate second resend → 429 with the resend message and code",
    tup(s, r.message ?? null, r.data?.email?.code ?? null),
    tup(429, RESEND_MSG, "invitation_resend_too_soon"),
  );
  await Bun.sleep(3000);
  check(`still exactly TWO mails To ${ADDR_H} after 3 s`, mails_to(MAIL_DIR_2, ADDR_H).length, 2);
  check(
    "the invitation row is unchanged (one row, same id)",
    (await rows_for(ADDR_H)).map((x: any) => x.id),
    inv_h === null ? ["<no row after the first invite>"] : [inv_h],
  );

  // ═══════════════════════ (i) ═══════════════════════
  console.log("\n── (i) an unroutable mail server never holds the create ──");
  [s] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "10.255.255.1", port: 25, tls: false },
  });
  check("superuser PATCH /api/settings (SMTP → an unroutable host) → 200", s, 200);
  const BOUND_MS = 2000;
  const t0 = performance.now();
  [s, r] = await direct(OWNER, "invitee-india@example.test");
  const ms = performance.now() - t0;
  console.log(
    `  ·  collection create with SMTP unroutable → status ${s} after ${Math.round(ms)} ms`,
  );
  check(
    `owner collection create → 200 within ${BOUND_MS} ms, mail_sent === true (handed off)`,
    tup(s, ms < BOUND_MS, r.mail_sent ?? null),
    tup(200, true, true),
  );
  [s] = await api("PATCH", "/api/settings", su, { smtp: SMTP_SINK_SETTINGS });
  check("superuser PATCH /api/settings (SMTP → the sink again) → 200", s, 200);
} finally {
  rejector?.stop(true);
  await stop_sink(sink);
  if (server) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log(
    "✅ PASS — invitation mail is sent once, resent on re-invite, and never blocks the create",
  );
  process.exit(0);
}

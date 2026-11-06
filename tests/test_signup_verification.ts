#!/usr/bin/env bun
/**Public signup sends its own verification email: an anonymous `POST /api/collections/users/records`
yields exactly one verification mail, a superuser-created user yields none, a failed send
neither rolls the user back nor blocks a later `request-verification`, and an unroutable mail
server never holds the signup response (decision:signup-mail-off-request).

Clean room, --hooksDir from a pb_hooks copy, mail captured by scripts/smtp_sink.ts.
Port 8155 + PB_PORT_OFFSET (suite self-boot band); SMTP sink on 2534 + PB_PORT_OFFSET.*/

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { py_repr, read_text, run_checked, splitlines, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const SMTP_SINK = path.join(REPO_ROOT, "scripts", "smtp_sink.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8155 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const SINK_PORT = 2534 + PORT_OFFSET;
const MAIL_WAIT = 10; // seconds; the send follows the signup response by milliseconds, so this is slack

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

async function api(
  method: string,
  p: string,
  token: string | null = null,
  body: any = null,
  extra: Record<string, string> = {},
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + p, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, { _raw: raw }];
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

// Captured messages addressed to `addr` (soft line breaks unfolded so a QP-wrapped link matches).
function mails_to(mail_dir: string, addr: string): string[] {
  if (!fs.existsSync(mail_dir)) return [];
  return fs
    .readdirSync(mail_dir)
    .filter((f) => f.endsWith(".eml"))
    .map((f) => read_text(path.join(mail_dir, f)))
    .filter((c) => splitlines(c).some((ln) => /^To:/i.test(ln) && ln.toLowerCase().includes(addr)))
    .map((c) => c.replace(/=\r?\n/g, ""));
}

async function wait_for_mail(mail_dir: string, addr: string): Promise<string[]> {
  const deadline = Date.now() + MAIL_WAIT * 1000;
  while (Date.now() < deadline) {
    if (mails_to(mail_dir, addr).length) break;
    await Bun.sleep(200);
  }
  await Bun.sleep(500); // settle: a duplicate send would land right behind the first
  return mails_to(mail_dir, addr);
}

const signup_body = (email: string, name: string) => ({
  email,
  password: "signup123456",
  passwordConfirm: "signup123456",
  name,
});

async function user_by_email(su: string, email: string): Promise<any[]> {
  const qs = urlencode({ filter: `email='${email}'` });
  const [, r] = await api("GET", `/api/collections/users/records?${qs}`, su);
  return r.items || [];
}

// PocketBase batches log writes (~3s), so a row is polled for rather than read once.
async function wait_for_log(su: string, message: string, user_id: string): Promise<any[]> {
  const qs = urlencode({ filter: `message = "${message}" && data.user = "${user_id}"` });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [, r] = await api("GET", `/api/logs?${qs}`, su);
    if (r.items?.length) return r.items;
    await Bun.sleep(250);
  }
  return [];
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-signup-verification-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const MAIL_DIR = path.join(S, "mail");
const MAIL_DIR_2 = path.join(S, "mail2"); // a restarted sink renumbers from 001 and would overwrite
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
let sink: Bun.Subprocess | null = null;
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
  [s] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "127.0.0.1", port: SINK_PORT, tls: false },
    meta: { senderName: "Task Tracker", senderAddress: "verify@example.com" },
  });
  check("superuser PATCH /api/settings (SMTP → the sink) → 200", s, 200);
  if (failures) throw new roomkit.SystemExit("cannot point SMTP at the sink — cannot proceed");

  // COVERS: hook:mail.pb.js#onRecordCreateRequest:users
  console.log("\n── (b) a superuser-created user (seeding, import) gets no email ──");
  const SEEDED = "seeded-unverified@example.com";
  [s, r] = await api("POST", "/api/collections/users/records", su, {
    ...signup_body(SEEDED, "Seeded User"),
    verified: false,
  });
  check("superuser creates an unverified user → 200", s, 200);
  check("seeded user starts verified=false", r.verified, false);

  console.log("\n── (a) anonymous public signup sends exactly one verification email ──");
  const PUBLIC = "public-signup@example.com";
  [s, r] = await api("POST", "/api/collections/users/records", null, {
    ...signup_body(PUBLIC, "Public Signup"),
  });
  check("anonymous signup → 200", s, 200);
  check("public signup starts verified=false", r.verified, false);
  const public_mail = await wait_for_mail(MAIL_DIR, PUBLIC);
  check("exactly ONE mail captured To the public signup address", public_mail.length, 1);
  check(
    "that mail carries the confirm-verification link",
    public_mail.length === 1 && public_mail[0].includes("confirm-verification"),
    true,
  );
  check(
    "ZERO mails captured To the superuser-created address",
    mails_to(MAIL_DIR, SEEDED).length,
    0,
  );

  console.log("\n── (c) a failed send keeps the user; request-verification still works ──");
  await stop_sink(sink);
  sink = null;
  const FAILED = "failed-send@example.com";
  [s, r] = await api("POST", "/api/collections/users/records", null, {
    ...signup_body(FAILED, "Failed Send"),
  });
  console.log(`  ·  signup with the SMTP sink down → status ${s}`);
  check("anonymous signup with SMTP unreachable → 200 (not rolled back)", s, 200);
  check(
    "the user exists after the failed send (superuser lookup)",
    (await user_by_email(su, FAILED)).length,
    1,
  );
  const failed_logs = await wait_for_log(su, "signup verification email failed", r.id);
  check("the failed send is logged against the user id", failed_logs.length, 1);
  check(
    "that log row does not carry the address",
    JSON.stringify(failed_logs).includes(FAILED),
    false,
  );

  sink = await start_sink(MAIL_DIR_2);
  [s] = await api("POST", "/api/collections/users/request-verification", null, {
    email: FAILED,
  });
  console.log(`  ·  request-verification after the sink is back → status ${s}`);
  check("POST request-verification → 204", s, 204);
  const resent = await wait_for_mail(MAIL_DIR_2, FAILED);
  check("one verification mail arrives for the failed-send address", resent.length, 1);
  check(
    "that mail carries the confirm-verification link",
    resent.length === 1 && resent[0].includes("confirm-verification"),
    true,
  );

  console.log("\n── (d) SMTP disabled: the signup sends nothing (no sendmail fallback) ──");
  [s] = await api("PATCH", "/api/settings", su, { smtp: { enabled: false } });
  check("superuser PATCH /api/settings (SMTP off) → 200", s, 200);
  const NO_SMTP = "no-smtp@example.com";
  [s, r] = await api("POST", "/api/collections/users/records", null, {
    ...signup_body(NO_SMTP, "No Smtp"),
  });
  check("anonymous signup with SMTP off → 200", s, 200);
  check(
    "the skip is logged as a warning against the user id",
    (await wait_for_log(su, "signup verification email skipped: SMTP disabled", r.id)).length,
    1,
  );

  // pp2j: the send must not hold the signup. Each signup below has its own client address
  // (X-Forwarded-For is trusted) so the per-address signup rate limit never answers 429.
  console.log("\n── (e) signup answers within 2 s while SMTP is unreachable ──");
  const BOUND_MS = 2000;
  const timed = async (email: string, ip: string): Promise<[number, any, number]> => {
    const t0 = performance.now();
    const [st, rec] = await api(
      "POST",
      "/api/collections/users/records",
      null,
      signup_body(email, "Timed Signup"),
      {
        "X-Forwarded-For": ip,
      },
    );
    return [st, rec, performance.now() - t0];
  };
  [s] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "10.255.255.1", port: 25, tls: false },
  });
  check("superuser PATCH /api/settings (SMTP → an unroutable host) → 200", s, 200);
  const STUCK = "stuck-smtp@example.com";
  let ms: number;
  [s, r, ms] = await timed(STUCK, "203.0.113.11");
  console.log(`  ·  signup with SMTP unroutable → status ${s} after ${Math.round(ms)} ms`);
  check(
    `anonymous signup with SMTP unroutable → 200 within ${BOUND_MS} ms`,
    tup(s, ms < BOUND_MS),
    tup(200, true),
  );
  [s] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "127.0.0.1", port: SINK_PORT, tls: false },
  });
  check("superuser PATCH /api/settings (SMTP → the sink again) → 200", s, 200);
  [s] = await api("POST", "/api/collections/users/request-verification", null, { email: STUCK });
  check("request-verification for the stuck signup once SMTP is reachable → 204", s, 204);
  check(
    "one verification mail then arrives for the stuck signup",
    (await wait_for_mail(MAIL_DIR_2, STUCK)).length,
    1,
  );
  const QUICK = "quick-smtp@example.com";
  [s, r, ms] = await timed(QUICK, "203.0.113.12");
  console.log(`  ·  signup with SMTP reachable → status ${s} after ${Math.round(ms)} ms`);
  check(
    `anonymous signup with SMTP reachable → 200 within ${BOUND_MS} ms`,
    tup(s, ms < BOUND_MS),
    tup(200, true),
  );
  const quick_mail = await wait_for_mail(MAIL_DIR_2, QUICK);
  check(
    "exactly ONE verification mail, carrying the confirm link, follows it",
    tup(quick_mail.length, quick_mail[0]?.includes("confirm-verification") ?? false),
    tup(1, true),
  );
  const BATCHED = "batched-signup@example.com";
  [s, r] = await api(
    "POST",
    "/api/batch",
    null,
    {
      requests: [
        {
          method: "POST",
          url: "/api/collections/users/records",
          body: signup_body(BATCHED, "Batched"),
        },
      ],
    },
    { "X-Forwarded-For": "203.0.113.13" },
  );
  check(
    "anonymous batch signup → 200, its create 200",
    tup(s, r?.[0]?.status ?? null),
    tup(200, 200),
  );
  check(
    "exactly ONE verification mail follows the batch signup once it commits",
    (await wait_for_mail(MAIL_DIR_2, BATCHED)).length,
    1,
  );
  const SEND_ROUTE = `/internal/signup-verification/${r?.[0]?.body?.id}`;
  check(
    "the signup-mail route refuses a caller without the server secret → 404",
    tup(
      (await api("POST", SEND_ROUTE))[0],
      (await api("POST", SEND_ROUTE, su, null, { "X-Signup-Mail": "guess" }))[0],
    ),
    tup(404, 404),
  );
  check(
    "no further mail went to the batch signup",
    (await wait_for_mail(MAIL_DIR_2, BATCHED)).length,
    1,
  );

  // Last: this burst spends the API rate limit of 127.0.0.1, which every later call here shares.
  console.log(
    "\n── (f) a client spending the rate limit of the server address cannot stop the mail ──",
  );
  let limited = 0;
  for (let i = 0; i < 310; i++) {
    const h = await fetch(BASE_URL + "/api/health", {
      headers: { "X-Forwarded-For": "127.0.0.1" },
    });
    await h.body?.cancel();
    if (h.status === 429) limited++;
  }
  check("a forged 127.0.0.1 burst of /api/health reaches the limit (some 429s)", limited > 0, true);
  const AFTER_BURST = "after-burst@example.com";
  [s] = await api(
    "POST",
    "/api/collections/users/records",
    null,
    signup_body(AFTER_BURST, "After Burst"),
    { "X-Forwarded-For": "203.0.113.14" },
  );
  check("anonymous signup after the burst → 200", s, 200);
  check(
    "one verification mail still follows it",
    (await wait_for_mail(MAIL_DIR_2, AFTER_BURST)).length,
    1,
  );
} finally {
  await stop_sink(sink);
  if (server) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — public signup sends one verification email; seeding sends none");
  process.exit(0);
}

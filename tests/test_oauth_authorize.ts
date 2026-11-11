#!/usr/bin/env bun
/**
 * hosted-mcp-endpoint authorization page: a person signs in by password or emailed code,
 * unverified and unapproved accounts are refused, consent issues a code or access_denied, and a
 * malformed request answers an error page or an error redirect.
 *
 * Fully self-contained clean-room server. Port 8202 + PB_PORT_OFFSET; SMTP sink on
 * 8203 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { py_repr, read_text, run_checked, splitlines, tup } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import {
  PKCE,
  authorize_params,
  exchange,
  field,
  post_page,
  sign_in_and_approve,
} from "./oauthkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const SMTP_SINK = path.join(REPO_ROOT, "scripts", "smtp_sink.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8202 + PORT_OFFSET;
const SINK_PORT = 8203 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";
const ALICE = { email: "alice@example.com", password: PASSWORD };
const CODES = "/api/collections/oauth_codes/records";

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
  url: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : {}];
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
  if (!(await roomkit.wait_for_port_free(SINK_PORT)))
    console.log(`  ⚠️  sink port ${SINK_PORT} still occupied after stopping`);
}

// Captured messages addressed to `addr`, soft line breaks unfolded.
function mails_to(addr: string): string[] {
  if (!fs.existsSync(MAIL_DIR)) return [];
  return fs
    .readdirSync(MAIL_DIR)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => read_text(path.join(MAIL_DIR, f)))
    .filter((c) => splitlines(c).some((ln) => /^To:/i.test(ln) && ln.toLowerCase().includes(addr)))
    .map((c) => c.replace(/=\r?\n/g, ""));
}

/** The 8-digit code of the n-th mail to `addr` (1-based), waiting up to 10 s for it to land. */
async function nth_code(addr: string, n: number): Promise<string | null> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && mails_to(addr).length < n) await Bun.sleep(200);
  const mail = mails_to(addr)[n - 1];
  // Anchored on the users OTP mail's sentence: a hex MIME boundary can hold a bare 8-digit run.
  return /one-time password is: ([0-9]{8})(?![0-9])/.exec(mail ?? "")?.[1] ?? null;
}

type Answer = { status: number; text: string; headers: Headers };

async function answer(r: Response): Promise<Answer> {
  return { status: r.status, text: await r.text(), headers: r.headers };
}

/** GET the page with a raw query string. */
async function get_raw(query: string): Promise<Answer> {
  return answer(await fetch(`${BASE_URL}/oauth/authorize?${query}`, { redirect: "manual" }));
}

const get = (params: Record<string, string>) => get_raw(new URLSearchParams(params).toString());
const post = async (html: string, extra: Record<string, string>) =>
  answer(await post_page(BASE_URL, html, extra));

/** The redirect's target and query, or null when the answer is not a redirect. */
function redirect_of(a: Answer): { to: string; q: Record<string, string> } | null {
  const loc = a.headers.get("Location");
  if (!loc) return null;
  const u = new URL(loc);
  return { to: u.origin + u.pathname, q: Object.fromEntries(u.searchParams) };
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-oauth-authorize-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const MAIL_DIR = path.join(S, "mail");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
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
  process.env.MCP_PUBLIC_URL = "http://mcp.test";
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  // This suite sends far more than the /oauth/ rule's 30 a minute from one address.
  const [, settings] = await api("GET", "/api/settings", su);
  const [s_rl] = await api("PATCH", "/api/settings", su, {
    rateLimits: {
      ...settings.rateLimits,
      rules: settings.rateLimits.rules.map((r: any) =>
        r.label === "/oauth/" ? { ...r, maxRequests: 100000 } : r,
      ),
    },
  });
  check("fixture: superuser raises the /oauth/ rule → 200", s_rl, 200);

  async function user(name: string, verified: boolean, approved: boolean): Promise<string> {
    const [s, r] = await api("POST", "/api/collections/users/records", su, {
      email: `${name.toLowerCase()}@example.com`,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name,
      verified,
      approved,
    });
    check(`fixture: ${name} (verified ${verified}, approved ${approved}) → 200`, s, 200);
    return r.id;
  }
  const alice_id = await user("Alice", true, true);
  await user("Una", true, false);
  await user("Vic", false, true);

  sink = await start_sink(MAIL_DIR);
  const [s_smtp] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "127.0.0.1", port: SINK_PORT, tls: false },
    meta: { senderName: "Task Tracker", senderAddress: "signin@example.com" },
  });
  check("fixture: superuser points SMTP at the sink → 200", s_smtp, 200);

  const base = authorize_params();
  const codes_of = async (uid: string) =>
    (await api("GET", `${CODES}?filter=${encodeURIComponent(`user="${uid}"`)}`, su))[1]?.totalItems;
  /** The consent page for `params` after a password sign-in. */
  async function consent_page(params = base, who = ALICE): Promise<string> {
    const signin = (await get(params)).text;
    return (await post(signin, { action: "password", ...who })).text;
  }
  const START_AGAIN = "This sign-in took too long or was changed. Start again.";

  console.log("\n── request validation ──");
  let a = await get(base);
  check(
    "page_headers: 200 text/html, CSP frame-ancestors none, X-Frame-Options DENY, no-store, Sign in",
    tup(
      a.status,
      (a.headers.get("Content-Type") ?? "").startsWith("text/html"),
      (a.headers.get("Content-Security-Policy") ?? "").includes("frame-ancestors 'none'"),
      a.headers.get("X-Frame-Options"),
      a.headers.get("Cache-Control"),
      a.headers.get("Referrer-Policy"),
      a.text.includes("Sign in"),
    ),
    tup(200, true, true, "DENY", "no-store", "no-referrer", true),
  );
  a = await get({ ...base, client_id: "nope" });
  check(
    "unknown_client_page: client_id=nope → 400 page 'not known', no Location",
    tup(a.status, a.text.includes("not known"), a.headers.get("Location")),
    tup(400, true, null),
  );
  a = await get_raw(new URLSearchParams({ ...base, client_id: "constructor" }).toString());
  check(
    "unknown_client_page: client_id=constructor (an Object.prototype name) → 400 'not known'",
    tup(a.status, a.text.includes("not known")),
    tup(400, true),
  );
  const { redirect_uri: _drop, ...no_redirect } = base;
  a = await get(no_redirect);
  check(
    "missing_redirect_page: no redirect_uri → 400 'incomplete'",
    tup(a.status, a.text.includes("incomplete")),
    tup(400, true),
  );
  a = await get({ ...base, redirect_uri: "https://evil.example/cb" });
  check(
    "unregistered_redirect_page: https://evil.example/cb → 400 'has not registered', no Location",
    tup(a.status, a.text.includes("has not registered"), a.headers.get("Location")),
    tup(400, true, null),
  );
  check(
    "loopback_any_port: http://localhost:61234/callback → 200",
    (await get({ ...base, redirect_uri: "http://localhost:61234/callback" })).status,
    200,
  );
  check(
    "loopback_any_port: http://127.0.0.1:5555/callback (host not registered) → 400",
    (await get({ ...base, redirect_uri: "http://127.0.0.1:5555/callback" })).status,
    400,
  );
  check(
    "bad_response_type_page: response_type=token → 400",
    (await get({ ...base, response_type: "token" })).status,
    400,
  );
  a = await get_raw(
    new URLSearchParams(base).toString() + "&redirect_uri=" + encodeURIComponent(base.redirect_uri),
  );
  check(
    "repeated_param_page: redirect_uri twice → 400 'malformed', no Location",
    tup(a.status, a.text.includes("malformed"), a.headers.get("Location")),
    tup(400, true, null),
  );
  const { code_challenge: _cc, ...no_pkce } = base;
  const err_redirect = (error: string) => ({
    to: "http://localhost:5555/callback",
    q: { error, state: "xyz", iss: BASE_URL },
  });
  a = await get(no_pkce);
  check(
    "no_pkce_redirect: no code_challenge → 302 error=invalid_request, state, iss",
    tup(a.status, redirect_of(a)),
    tup(302, err_redirect("invalid_request")),
  );
  a = await get({ ...base, code_challenge_method: "plain" });
  check(
    "method_plain_redirect: code_challenge_method=plain → 302 error=invalid_request",
    tup(a.status, redirect_of(a)),
    tup(302, err_redirect("invalid_request")),
  );
  a = await get({ ...base, scope: "admin" });
  check(
    "bad_scope_redirect: scope=admin → 302 error=invalid_scope",
    tup(a.status, redirect_of(a)),
    tup(302, err_redirect("invalid_scope")),
  );
  a = await get({ ...base, resource: "http://other/mcp" });
  check(
    "bad_resource_redirect: resource=http://other/mcp → 302 error=invalid_target",
    tup(a.status, redirect_of(a)),
    tup(302, err_redirect("invalid_target")),
  );
  const { state: _st, ...no_state } = base;
  a = await get({ ...no_state, scope: "admin" });
  check(
    "error redirect without state: no state= in the Location",
    tup(a.status, (a.headers.get("Location") ?? "").includes("state="), redirect_of(a)?.q.error),
    tup(302, false, "invalid_scope"),
  );

  console.log("\n── password sign-in refusals ──");
  const signin = (await get(base)).text;
  a = await post(signin, { action: "password", email: ALICE.email, password: "wrong-password" });
  check(
    "wrong_password: 200 sign-in page 'do not match', no consent, no code for Alice",
    tup(
      a.status,
      a.text.includes("do not match"),
      a.text.includes('value="approve"'),
      await codes_of(alice_id),
    ),
    tup(200, true, false, 0),
  );
  a = await post(signin, { action: "password", email: "nobody@example.com", password: PASSWORD });
  check(
    "unknown_email_password: 200 'do not match'",
    tup(a.status, a.text.includes("do not match")),
    tup(200, true),
  );
  a = await post(signin, { action: "password", email: "una@example.com", password: PASSWORD });
  check(
    "unapproved_refused: Una → 'waiting for approval', no consent stage",
    tup(a.status, a.text.includes("waiting for approval"), a.text.includes('value="approve"')),
    tup(200, true, false),
  );
  a = await post(signin, { action: "password", email: "vic@example.com", password: PASSWORD });
  check(
    "unverified_refused: Vic → 'confirm your email address first', no consent stage",
    tup(
      a.status,
      a.text.includes("confirm your email address first"),
      a.text.includes('value="approve"'),
    ),
    tup(200, true, false),
  );
  a = await post(signin, { action: "password", email: SU_EMAIL, password: SU_PASSWORD });
  check(
    "superuser_cannot_sign_in: the superuser's credentials → 'do not match'",
    tup(a.status, a.text.includes("do not match"), a.text.includes('value="approve"')),
    tup(200, true, false),
  );

  console.log("\n── consent ──");
  {
    const page = await fetch(`${BASE_URL}/oauth/authorize?${new URLSearchParams(base)}`);
    const signin = await page.text();
    const pw = await post_page(BASE_URL, signin, { action: "password", ...ALICE });
    const consent = await pw.text();
    check(
      "password_consent_approve: consent names Cursor, localhost, the loopback warning, write checked",
      tup(
        pw.status,
        consent.includes("Cursor wants to use your Task Tracker account."),
        consent.includes("you return to localhost"),
        consent.includes("This app runs on your own computer."),
        /<input[^>]*value="write"[^>]*checked/.test(consent),
      ),
      tup(200, true, true, true, true),
    );
    const ap = await post_page(BASE_URL, consent, { action: "approve", access: "write" });
    const loc = ap.headers.get("Location") ?? "";
    const u = loc ? new URL(loc) : null;
    check(
      "password_consent_approve: approve → 302 to the callback with code, state, iss",
      tup(
        ap.status,
        u ? u.origin + u.pathname : null,
        /^[A-Za-z0-9]{40}$/.test(u?.searchParams.get("code") ?? ""),
        u?.searchParams.get("state"),
        u?.searchParams.get("iss"),
      ),
      tup(302, "http://localhost:5555/callback", true, "xyz", BASE_URL),
    );
    const ex = await exchange(BASE_URL, u?.searchParams.get("code") ?? "none", base);
    check(
      "password_consent_approve: the code exchanges → 200, scope read write",
      tup(ex.status, ex.body?.scope),
      tup(200, "read write"),
    );
  }

  {
    const { code } = await sign_in_and_approve(BASE_URL, base, ALICE, "read");
    const ex = await exchange(BASE_URL, code, base);
    const [s_me, me] = await api("GET", "/api/tracker/me", ex.body?.access_token ?? "tmk_none");
    check(
      "consent_read_only: approve with access=read → exchange scope read, /me key.scope read",
      tup(ex.status, ex.body?.scope, s_me, me?.key?.scope),
      tup(200, "read", 200, "read"),
    );
  }
  check(
    "scope_read_preselected: scope=read → the read radio is checked",
    /<input[^>]*value="read"[^>]*checked/.test(await consent_page({ ...base, scope: "read" })),
    true,
  );
  a = await post(await consent_page(), { action: "deny" });
  check(
    "deny: action=deny → 302 error=access_denied, state, iss",
    tup(a.status, redirect_of(a)),
    tup(302, err_redirect("access_denied")),
  );
  a = await post(await consent_page(), { action: "approve", access: "admin" });
  check(
    "consent_bad_access: access=admin → 200 consent again, no redirect",
    tup(a.status, a.text.includes('value="approve"'), a.headers.get("Location")),
    tup(200, true, null),
  );

  console.log("\n── flow token ──");
  const other = await consent_page({ ...base, state: "other" });
  a = await post(await consent_page(), {
    action: "approve",
    access: "write",
    flow: field(other, "flow") ?? "",
  });
  check(
    "flow_tampered: another request's consent flow → 200 sign-in 'Start again', no redirect",
    tup(
      a.status,
      a.text.includes(START_AGAIN),
      a.text.includes('value="password"'),
      a.headers.get("Location"),
    ),
    tup(200, true, true, null),
  );
  a = await post(await consent_page(), { action: "approve", access: "write", state: "changed" });
  check(
    "flow_tampered: state changed on the consent form → 200 'Start again', no redirect",
    tup(a.status, a.text.includes(START_AGAIN), a.headers.get("Location")),
    tup(200, true, null),
  );
  a = await post((await get(base)).text, { action: "approve", access: "write" });
  check(
    "flow_wrong_stage: approve with a signin-stage token → 200 'Start again', no redirect",
    tup(a.status, a.text.includes(START_AGAIN), a.headers.get("Location")),
    tup(200, true, null),
  );
  a = await post((await get(base)).text, { action: "nonsense" });
  check(
    "flow_wrong_stage: an unknown action → 200 'Start again'",
    tup(a.status, a.text.includes(START_AGAIN)),
    tup(200, true),
  );

  console.log("\n── emailed code ──");
  a = await post((await get(base)).text, { action: "send_code", email: ALICE.email });
  const alice_code = await nth_code(ALICE.email, 1);
  check(
    "code_sign_in: send_code → code page; one mail to Alice with an 8-digit code",
    tup(
      a.status,
      a.text.includes('value="verify_code"'),
      mails_to(ALICE.email).length,
      alice_code !== null,
    ),
    tup(200, true, 1, true),
  );
  let v = await post(a.text, { action: "verify_code", code: alice_code ?? "" });
  check(
    "code_sign_in: verify_code with it → consent page",
    tup(v.status, v.text.includes('value="approve"')),
    tup(200, true),
  );
  a = await post((await get(base)).text, { action: "send_code", email: ALICE.email });
  const right = (await nth_code(ALICE.email, 2)) ?? "";
  const wrong = right === "00000000" ? "11111111" : "00000000";
  let page = a.text;
  const tries: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    v = await post(page, { action: "verify_code", code: wrong });
    tries.push(v.status === 200 && v.text.includes("wrong or has expired"));
    page = v.text;
  }
  check("code_wrong_then_lockout: five wrong codes → each 'wrong or has expired'", tries, [
    true,
    true,
    true,
    true,
    true,
  ]);
  v = await post(page, { action: "verify_code", code: right });
  check(
    "code_wrong_then_lockout: the right code on the sixth try → still refused",
    tup(v.status, v.text.includes("wrong or has expired"), v.text.includes('value="approve"')),
    tup(200, true, false),
  );
  const before_mail = mails_to("nobody@example.com").length;
  a = await post((await get(base)).text, { action: "send_code", email: "nobody@example.com" });
  await Bun.sleep(1000);
  check(
    "code_unknown_email: code page 'If that address belongs', no mail to nobody",
    tup(
      a.status,
      a.text.includes("If that address belongs"),
      mails_to("nobody@example.com").length - before_mail,
    ),
    tup(200, true, 0),
  );
  v = await post(a.text, { action: "verify_code", code: "12345678" });
  check(
    "code_unknown_email: any code → refused",
    tup(v.status, v.text.includes("wrong or has expired"), v.text.includes('value="approve"')),
    tup(200, true, false),
  );
  a = await post((await get(base)).text, { action: "send_code", email: "una@example.com" });
  v = await post(a.text, {
    action: "verify_code",
    code: (await nth_code("una@example.com", 1)) ?? "",
  });
  check(
    "code_unapproved: Una's correct code → 'waiting for approval', no consent",
    tup(v.status, v.text.includes("waiting for approval"), v.text.includes('value="approve"')),
    tup(200, true, false),
  );

  console.log("\n── code purge ──");
  const [s_old, old] = await api("POST", CODES, su, {
    code_hash: "0".repeat(64),
    user: alice_id,
    client_id: "cursor",
    client_name: "Cursor",
    redirect_uri: base.redirect_uri,
    code_challenge: PKCE.challenge,
    scope: "write",
    expires: new Date(Date.now() - 60_000).toISOString(),
  });
  await sign_in_and_approve(BASE_URL, base, ALICE);
  check(
    "expired_codes_purged: an expired row inserted; a new approval → the row is gone (404)",
    tup(s_old, (await api("GET", `${CODES}/${old?.id}`, su))[0]),
    tup(200, 404),
  );
} finally {
  if (server !== null) await roomkit.stop(server);
  await stop_sink(sink);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all oauth-authorize proofs passed");
  process.exit(0);
}

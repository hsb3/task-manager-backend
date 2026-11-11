#!/usr/bin/env bun
/**
 * hosted-mcp-endpoint authorization page: a person signs in by password or emailed code,
 * unverified and unapproved accounts are refused, consent issues a code or access_denied, and a
 * malformed request answers an error page or an error redirect.
 *
 * Fully self-contained clean-room server. Port 8202 + PB_PORT_OFFSET; SMTP sink on
 * 8203 + PB_PORT_OFFSET; a stub of the MCP service's private listener on 8204 + PB_PORT_OFFSET.
 */

import { createHmac, randomBytes } from "node:crypto";
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
const STUB_PORT = 8204 + PORT_OFFSET;
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

const CC_URL = "https://claude.ai/oauth/claude-code-client-metadata";
const LOOP_CB = ["http://localhost/callback"];
const doc_client = (client_id: string, client_name: string, redirect_uris = LOOP_CB) => ({
  client: { client_id, client_name, redirect_uris },
  max_age: 0,
});
// A Cyrillic "с" in place of the Latin "c"; the stub answers it as a pre-fix service would.
const SPOOF_URL = "https://\u0441laude.ai/oauth/claude-code-client-metadata";
const PUNY_URL = "https://xn--laude-0ye.ai/meta";
const SWAP_URL = "https://swap.example/meta";
const STUB_ANSWERS: Record<string, [number, object | string]> = {
  [SPOOF_URL]: [200, doc_client(SPOOF_URL, "Claude Code")],
  [PUNY_URL]: [200, doc_client(PUNY_URL, "Puny")],
  [SWAP_URL]: [200, doc_client(CC_URL, "Swap")],
  "https://notjson.example/meta": [200, "not json"],
  "https://empty.example/meta": [200, {}],
  "https://nouris.example/meta": [
    200,
    { client: { client_id: "https://nouris.example/meta", client_name: "N" }, max_age: 0 },
  ],
  "https://long.example/meta": [200, doc_client("https://long.example/meta", "A".repeat(10240))],
  "https://idnredirect.example/meta": [
    200,
    doc_client("https://idnredirect.example/meta", "I", ["https://\u0441laude.ai/cb"]),
  ],
  "https://bsredirect.example/meta": [
    200,
    doc_client("https://bsredirect.example/meta", "B", ["https://evil.example\\@claude.ai/cb"]),
  ],
  "https://jsredirect.example/meta": [
    200,
    doc_client("https://jsredirect.example/meta", "J", ["javascript:alert(1)//"]),
  ],
  "https://evil.example\\@claude.ai/meta": [
    200,
    doc_client("https://evil.example\\@claude.ai/meta", "Claude Code"),
  ],
  "https://numredirect.example/meta": [
    200,
    doc_client("https://numredirect.example/meta", "N", ["https://0x7f.1/cb"]),
  ],
  "https://[2606:4700::1]/meta": [200, doc_client("https://[2606:4700::1]/meta", "V6")],
  "https://noname.example/meta": [200, doc_client("https://noname.example/meta", "")],
  "https://ctlredirect.example/meta": [
    200,
    doc_client("https://ctlredirect.example/meta", "T", ["https://x.exa\tmple/cb"]),
  ],
  [CC_URL]: [
    200,
    {
      client: {
        client_id: CC_URL,
        client_name: "Claude Code",
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      },
      max_age: 300,
    },
  ],
  "https://bad.example/meta": [422, { error: "client_id does not match the URL" }],
  "https://flaky.example/meta": [503, { error: "host did not answer" }],
};
const stub_seen: { client_id: string; secret: string | null }[] = [];
const FLOW_SECRET = randomBytes(20).toString("hex");
/** A flow token signed as pb_hooks/lib/oauth.js sign_flow signs one, with the pinned secret. */
const sign_flow = (stage: string, q: string, uid: string, otp: string, exp: number) => {
  const payload = [stage, q, uid, otp, exp].join("|");
  return payload + "|" + createHmac("sha256", FLOW_SECRET).update(payload).digest("hex");
};

let server: roomkit.Room | null = null;
let sink: Bun.Subprocess | null = null;
let stub: ReturnType<typeof Bun.serve> | null = null;
try {
  await roomkit.require_free_port(STUB_PORT);
  stub = Bun.serve({
    hostname: "127.0.0.1",
    port: STUB_PORT,
    async fetch(req) {
      const id = String(((await req.json().catch(() => ({}))) as any).client_id);
      stub_seen.push({ client_id: id, secret: req.headers.get("X-TM-Internal") });
      const [status, body] = STUB_ANSWERS[id] ?? [404, { error: "not_found" }];
      return typeof body === "string"
        ? new Response(body, { status })
        : Response.json(body, { status });
    },
  });
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
  process.env.MCP_INTERNAL_URL = `http://127.0.0.1:${STUB_PORT}`;
  process.env.MCP_INTERNAL_SECRET = "s3cret";
  // A private hooks copy (the battery shares one) whose test-only hook pins the flow secret to this run's value.
  const hooks = copy_tree(roomkit.hooks_dir(S), path.join(S, "pb_hooks_pinned"));
  fs.writeFileSync(
    path.join(hooks, "zz_test_flow_secret.pb.js"),
    `routerUse((e) => { e.app.store().set("oauthFlowSecret", ${JSON.stringify(FLOW_SECRET)}); return e.next(); });\n`,
  );
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, hooks);
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
  const ann_id = await user("Ann", true, true);
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
    check(
      "approve_redirect_headers: the 302 carries Cache-Control no-store, Referrer-Policy no-referrer",
      tup(ap.headers.get("Cache-Control"), ap.headers.get("Referrer-Policy")),
      tup("no-store", "no-referrer"),
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
  {
    const consent = await consent_page(base, { email: "ann@example.com", password: PASSWORD });
    const [s_un] = await api("PATCH", `/api/collections/users/records/${ann_id}`, su, {
      approved: false,
    });
    a = await post(consent, { action: "approve", access: "write" });
    check(
      "approve_rechecks_account: unapproved after sign-in → sign-in 'waiting for approval', no code",
      tup(
        s_un,
        a.status,
        a.text.includes("waiting for approval"),
        a.text.includes('value="password"'),
        a.headers.get("Location"),
        await codes_of(ann_id),
      ),
      tup(200, 200, true, true, null, 0),
    );
  }
  {
    const { location } = await sign_in_and_approve(BASE_URL, { ...base, state: "a&b" }, ALICE);
    check(
      "state_encoded: state a&b → the Location carries state=a%26b and reads back a&b",
      tup(location.includes("state=a%26b"), new URL(location).searchParams.get("state")),
      tup(true, "a&b"),
    );
  }

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
  {
    const consent = await consent_page();
    const parts = (field(consent, "flow") ?? "").split("|");
    const forged = (i: number, value: string) =>
      parts.map((p, j) => (j === i ? value : p)).join("|");
    const tampered: [string, Record<string, string>][] = [
      ["the user id changed, signature kept", { flow: forged(2, "zzzzzzzzzzzzzzz") }],
      ["the expiry extended, signature kept", { flow: forged(4, String(Date.now() + 86400000)) }],
      ["redirect_uri changed to another port", { redirect_uri: "http://localhost:6666/callback" }],
      ["code_challenge changed", { code_challenge: "A".repeat(43) }],
    ];
    for (const [what, extra] of tampered) {
      a = await post(consent, { action: "approve", access: "write", ...extra });
      check(
        `flow_tampered: ${what} → 200 'Start again', no redirect`,
        tup(a.status, a.text.includes(START_AGAIN), a.headers.get("Location")),
        tup(200, true, null),
      );
    }
  }
  {
    const signin = (await get(base)).text;
    const q = (field(signin, "flow") ?? "").split("|")[1] ?? "";
    const pw = { action: "password", ...ALICE };
    const fresh = await post(signin, {
      ...pw,
      flow: sign_flow("signin", q, "", "", Date.now() + 600000),
    });
    const expired = await post(signin, {
      ...pw,
      flow: sign_flow("signin", q, "", "", Date.now() - 1000),
    });
    check(
      "flow_expired: a self-signed fresh token → consent (pin holds); signed but expired → 'Start again'",
      tup(
        fresh.text.includes('value="approve"'),
        expired.status,
        expired.text.includes(START_AGAIN),
        expired.text.includes('value="approve"'),
      ),
      tup(true, 200, true, false),
    );
  }
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
  const known_flow = field(a.text, "flow");
  let v = await post(a.text, { action: "verify_code", code: alice_code ?? "" });
  check(
    "code_sign_in: verify_code with it → consent page",
    tup(v.status, v.text.includes('value="approve"')),
    tup(200, true),
  );
  v = await post(a.text, { action: "verify_code", code: alice_code ?? "" });
  check(
    "code_single_use: the same correct code again → 'wrong or has expired', no consent",
    tup(v.status, v.text.includes("wrong or has expired"), v.text.includes('value="approve"')),
    tup(200, true, false),
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
  const shape = (flow: string | null) =>
    (flow ?? "")
      .split("|")
      .slice(2, 4)
      .map((id) => /^[a-z0-9]{15}$/.test(id));
  check(
    "code_flow_same_shape: known and unknown email → user and code ids both 15 characters",
    tup(shape(known_flow), shape(field(a.text, "flow"))),
    tup([true, true], [true, true]),
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
    "code_unapproved: Una's correct code → 'waiting for approval', no consent, token keeps its ids",
    tup(
      v.status,
      v.text.includes("waiting for approval"),
      v.text.includes('value="approve"'),
      shape(field(v.text, "flow")),
    ),
    tup(200, true, false, [true, true]),
  );

  console.log("\n── metadata-document clients ──");
  {
    const cc = authorize_params({
      client_id: CC_URL,
      redirect_uri: "http://localhost:7777/callback",
    });
    const consent = await consent_page(cc);
    const { code } = await sign_in_and_approve(BASE_URL, cc, ALICE);
    const ex = await exchange(BASE_URL, code, cc);
    const [, me] = await api("GET", "/api/tracker/me", ex.body?.access_token ?? "tmk_none");
    check(
      "cimd_claude_code: consent names Claude Code and claude.ai; exchange 200; key client_id the URL",
      tup(
        consent.includes("Claude Code wants to use your Task Tracker account."),
        consent.includes("It identifies itself as claude.ai."),
        ex.status,
        me?.key?.client_id,
      ),
      tup(true, true, 200, CC_URL),
    );
    const before = stub_seen.filter((r) => r.client_id === CC_URL).length;
    a = await get(cc);
    check(
      "cimd_cached: a second GET → 200 sign-in, stub not asked again",
      tup(a.status, stub_seen.filter((r) => r.client_id === CC_URL).length),
      tup(200, before),
    );
    a = await get({ ...cc, redirect_uri: "https://claude.ai/other" });
    check(
      "cimd_redirect_not_listed: redirect_uri https://claude.ai/other → 400 'has not registered'",
      tup(a.status, a.text.includes("has not registered")),
      tup(400, true),
    );
    a = await get({ ...cc, client_id: "https://bad.example/meta" });
    check(
      "cimd_invalid_page: 422 from the service → 400 'could not be verified.'",
      tup(a.status, a.text.includes("could not be verified."), a.text.includes("right now")),
      tup(400, true, false),
    );
    a = await get({ ...cc, client_id: "https://flaky.example/meta" });
    check(
      "cimd_unavailable_page: 503 from the service → 400 'right now'",
      tup(a.status, a.text.includes("could not be verified right now")),
      tup(400, true),
    );
    check(
      "cimd_secret_sent: every stub request carried X-TM-Internal s3cret",
      tup(
        stub_seen.length > 0,
        stub_seen.every((r) => r.secret === "s3cret"),
      ),
      tup(true, true),
    );
    {
      const asked = stub_seen.length;
      a = await get({ ...cc, client_id: SPOOF_URL });
      check(
        "non_ascii_client_id: Cyrillic lookalike → 400 'could not be verified.', no consent, service not asked",
        tup(
          a.status,
          a.text.includes("could not be verified."),
          a.text.includes("right now"),
          field(a.text, "flow"),
          stub_seen.length - asked,
        ),
        tup(400, true, false, null, 0),
      );
    }
    for (const [label, id, redirect] of [
      ["redirect_non_ascii", "https://idnredirect.example/meta", "https://\u0441laude.ai/cb"],
      ["redirect_control", "https://ctlredirect.example/meta", "https://x.exa\tmple/cb"],
      [
        "redirect_backslash",
        "https://bsredirect.example/meta",
        "https://evil.example\\@claude.ai/cb",
      ],
      ["redirect_scheme", "https://jsredirect.example/meta", "javascript:alert(1)//"],
      ["redirect_numeric_host", "https://numredirect.example/meta", "https://0x7f.1/cb"],
      ["client_id_ip_literal", "https://[2606:4700::1]/meta", "http://localhost/callback"],
      ["client_id_backslash", "https://evil.example\\@claude.ai/meta", "http://localhost/callback"],
    ]) {
      a = await get({ ...cc, client_id: id!, redirect_uri: redirect! });
      check(
        `${label}: an id or returned redirect URI outside the URL rule → 400 'could not be verified.'`,
        tup(a.status, a.text.includes("could not be verified."), a.text.includes("right now")),
        tup(400, true, false),
      );
    }
    {
      const pc = { ...cc, client_id: PUNY_URL };
      const consent = await consent_page(pc);
      check(
        "punycode_client: consent shows the punycode host",
        consent.includes("It identifies itself as xn--laude-0ye.ai."),
        true,
      );
    }
    {
      const sc = { ...cc, client_id: SWAP_URL };
      const consent = await consent_page(sc);
      const { code } = await sign_in_and_approve(BASE_URL, sc, ALICE);
      const ex = await exchange(BASE_URL, code, sc);
      const [, me] = await api("GET", "/api/tracker/me", ex.body?.access_token ?? "tmk_none");
      check(
        "requested_client_id_kept: service answers another client_id → consent names swap.example; key client_id the requested URL",
        tup(
          consent.includes("It identifies itself as swap.example."),
          consent.includes("claude.ai"),
          ex.status,
          me?.key?.client_id,
        ),
        tup(true, false, 200, SWAP_URL),
      );
    }
    for (const id of [
      "https://notjson.example/meta",
      "https://empty.example/meta",
      "https://nouris.example/meta",
      "https://noname.example/meta",
    ]) {
      a = await get({ ...cc, client_id: id });
      check(
        `malformed_200: ${id} → 400 'right now'`,
        tup(a.status, a.text.includes("could not be verified right now")),
        tup(400, true),
      );
    }
    {
      const consent = await consent_page({ ...cc, client_id: "https://long.example/meta" });
      check(
        "client_name_bounded: a 10240-character name renders at most 200 characters",
        tup(consent.includes("A".repeat(200)), consent.includes("A".repeat(201))),
        tup(true, false),
      );
    }
    await stub.stop(true);
    stub = null;
    a = await get({ ...cc, client_id: "https://down.example/meta" });
    check(
      "cimd_unavailable_page: service down, uncached URL → 400 'right now'",
      tup(a.status, a.text.includes("could not be verified right now")),
      tup(400, true),
    );
  }

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
  if (stub !== null) await stub.stop(true);
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

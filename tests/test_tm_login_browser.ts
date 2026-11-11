#!/usr/bin/env bun
/**
 * tm login through the browser and tm keys create (clients/tm, decision:api-key-manages-keys):
 * the loopback callback, PKCE and state, the sign-in refusals, Ctrl-C, the flag checks made
 * before any network, and the same login run under Node.
 *
 * Fully self-contained clean-room server plus a fake authorization server; runs the CLI as a
 * subprocess with --no-browser and completes the page itself. Ports 8223/8224 + PB_PORT_OFFSET.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import { approve_with, post_consent, sign_in_to_consent } from "./oauthkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const TM = path.join(REPO_ROOT, "clients", "tm", "tm.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8223 + PORT_OFFSET;
const FAKE_PORT = 8224 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const FAKE_KEY = "tmk_" + "f".repeat(40);
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const WHO = { email: "alice@example.com", password: "test123456" };
const HOST = os.hostname();
const SIGNED_IN = "<p>Return to the terminal to finish signing in.</p>";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(76)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tm-login-browser-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const XDG = path.join(S, "xdg");
const FXDG = path.join(S, "fake-xdg");
const CFG = path.join(XDG, "tm", "config.json");
const FCFG = path.join(FXDG, "tm", "config.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

const read = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const saved_key = (f: string): string | undefined => JSON.parse(read(f) ?? "{}").key;

// ── the fake authorization server: metadata, an authorize that redirects per `mode`, a token route, /me ──
const mode: {
  no_meta?: boolean;
  iss?: string;
  error?: string;
  error_description?: string;
  no_code?: boolean;
  token_error?: boolean;
  me_fail?: boolean;
} = {};
let hits = 0;
let challenge = "";
let redirect = "";
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: FAKE_PORT,
  async fetch(req) {
    hits += 1;
    const u = new URL(req.url);
    if (u.pathname === "/.well-known/oauth-authorization-server")
      return mode.no_meta
        ? new Response("not found", { status: 404 })
        : Response.json({
            issuer: FAKE,
            authorization_endpoint: FAKE + "/authorize",
            token_endpoint: FAKE + "/token",
          });
    if (u.pathname === "/authorize") {
      const q = u.searchParams;
      challenge = q.get("code_challenge") ?? "";
      redirect = q.get("redirect_uri") ?? "";
      const back = new URL(redirect);
      if (!mode.no_code && !mode.error) back.searchParams.set("code", "fakecode");
      if (mode.error) back.searchParams.set("error", mode.error);
      if (mode.error_description)
        back.searchParams.set("error_description", mode.error_description);
      back.searchParams.set("state", q.get("state") ?? "");
      back.searchParams.set("iss", mode.iss ?? FAKE);
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const pkce = createHash("sha256")
        .update(f.get("code_verifier") ?? "")
        .digest("base64url");
      const good =
        f.get("grant_type") === "authorization_code" &&
        f.get("code") === "fakecode" &&
        f.get("client_id") === "tm" &&
        f.get("redirect_uri") === redirect &&
        pkce === challenge;
      if (mode.token_error || !good)
        return Response.json(
          { error: "invalid_grant", error_description: "The code is invalid." },
          { status: 400 },
        );
      return Response.json({
        access_token: FAKE_KEY,
        token_type: "Bearer",
        scope: "read write keys",
      });
    }
    if (u.pathname === "/api/tracker/me" && mode.me_fail)
      return Response.json({ status: 500, message: "boom", data: {} }, { status: 500 });
    if (u.pathname === "/api/tracker/me")
      return Response.json({
        user: { id: "fakeuser0000001", name: "Fake" },
        key: {
          id: "fakekey00000001",
          scope: "write",
          expires: "",
          client_id: "tm",
          manage_keys: true,
          reach: "all",
          workspace: "",
          projects: [],
        },
        workspaces: [],
        unread_notifications: 0,
      });
    return new Response("not found", { status: 404 });
  },
});

type Run = { code: number; stdout: string; stderr: string; json: any };

/** Starts tm; `url` resolves to the printed authorization URL (null if none is printed). */
function start(args: string[], xdg = XDG, cmd = [process.execPath, TM]) {
  const { TM_API_KEY, TM_URL, ...clean } = process.env;
  const proc = Bun.spawn([...cmd, ...args], {
    cwd: S,
    env: { ...clean, HOME: S, XDG_CONFIG_HOME: xdg, TM_CREDENTIAL_STORE: "file" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  let found: (u: string | null) => void = () => {};
  const url = new Promise<string | null>((r) => (found = r));
  const drained = (async () => {
    const dec = new TextDecoder();
    for await (const c of proc.stderr) {
      stderr += dec.decode(c, { stream: true });
      const m = /Open this page to sign in:\n(\S+)\n/.exec(stderr);
      if (m) found(m[1]);
    }
    found(null);
  })();
  const timer = setTimeout(() => proc.kill(), 20_000);
  const done = (async (): Promise<Run> => {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    await drained;
    clearTimeout(timer);
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {}
    return { code, stdout, stderr, json };
  })();
  return { proc, url, done };
}

/** A tm run that needs no browser: usage checks and the like. */
const tm = (args: string[], xdg = XDG) => start(args, xdg).done;

/** Completes the real consent page for the printed URL; returns the callback's answer. */
async function browser(
  au: string | null,
  fields: Record<string, string> | "deny",
): Promise<{ status: number; type: string; html: string }> {
  if (!au) return { status: 0, type: "", html: "no authorization URL printed" };
  const params = Object.fromEntries(new URL(au).searchParams);
  let location: string;
  if (fields === "deny") {
    const c = await sign_in_to_consent(BASE_URL, params, WHO);
    const r = await post_consent(BASE_URL, params, c.flow, { action: "deny" });
    location = r.headers.get("Location") ?? "";
  } else location = (await approve_with(BASE_URL, params, WHO, fields)).location;
  const cb = await fetch(location);
  return { status: cb.status, type: cb.headers.get("Content-Type") ?? "", html: await cb.text() };
}

/** Follows the fake authorize redirect to the listener; returns the callback's answer. */
async function fake_browser(au: string | null): Promise<{ status: number; html: string }> {
  if (!au) return { status: 0, html: "no authorization URL printed" };
  const r = await fetch(au, { redirect: "manual" });
  const cb = await fetch(r.headers.get("Location") ?? "");
  return { status: cb.status, html: await cb.text() };
}

const refused = async (u: string): Promise<boolean> => {
  try {
    await fetch(u);
    return false;
  } catch {
    return true;
  }
};

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
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  console.log("\n── fixtures: Alice; the /oauth/ rate limit raised ──");
  // This suite signs in more than the /oauth/ rule's 30 a minute from one address.
  const [, settings] = await api("GET", "/api/settings", su);
  let [s] = await api("PATCH", "/api/settings", su, {
    rateLimits: {
      ...settings.rateLimits,
      rules: settings.rateLimits.rules.map((r: any) =>
        r.label === "/oauth/" ? { ...r, maxRequests: 100000 } : r,
      ),
    },
  });
  check("fixture /oauth/ rule raised", s, 200);
  [s] = await api("POST", "/api/collections/users/records", su, {
    email: WHO.email,
    password: WHO.password,
    passwordConfirm: WHO.password,
    name: "Alice",
    verified: true,
    approved: true,
  });
  check("fixture Alice created", s, 200);

  console.log("\n── usage before network: flags are checked first, the server sees nothing ──");
  hits = 0;
  const later = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  for (const [args, msg] of [
    [["keys", "create", "--scope", "read"], "keys create needs --name"],
    [["keys", "create", "--name", "", "--scope", "read"], "--name wants 1 to 200 characters"],
    [
      ["keys", "create", "--name", "x".repeat(201), "--scope", "read"],
      "--name wants 1 to 200 characters",
    ],
    [["keys", "create", "--name", "x"], "keys create needs --scope"],
    [
      ["keys", "create", "--name", "x", "--scope", "admin"],
      "--scope wants read, write, manage or own",
    ],
    [
      ["keys", "create", "--name", "x", "--scope", "read", "--expires", "2020-01-01"],
      "--expires must be in the future",
    ],
    [
      ["keys", "create", "--name", "x", "--scope", "read", "--expires", "tomorrow"],
      "--expires wants YYYY-MM-DD or a date-time with a time zone",
    ],
    [
      ["keys", "create", "--name", "x", "--scope", "read", "--expires", "2099-02-30"],
      "--expires wants YYYY-MM-DD or a date-time with a time zone",
    ],
    [
      ["keys", "create", "--name", "x", "--scope", "read", "--expires", `${later}T00:00:00`],
      "--expires wants YYYY-MM-DD or a date-time with a time zone",
    ],
    [
      ["keys", "create", "--name", "x", "--scope", "read", "--expires", "2099-02-30T10:00:00Z"],
      "--expires wants YYYY-MM-DD or a date-time with a time zone",
    ],
    [
      ["keys", "create", "--name", "x", "--scope", "read", "--expires", "2099-01-01T24:00:00Z"],
      "--expires wants YYYY-MM-DD or a date-time with a time zone",
    ],
    [["login", "--scope", "admin"], "--scope wants read, write, manage or own"],
  ] as [string[], string][]) {
    const o = await tm([...args, "--url", FAKE, "--no-browser"]);
    check(
      `${args.join(" ").slice(0, 60)} → exit 2`,
      tup(o.code, o.stderr.split("\n")[0]),
      tup(2, `tm: ${msg}`),
    );
  }
  let o = await tm(["keys", "create", "--name", "x", "--scope", "read", "--no-browser"]);
  check(
    "keys create with no URL anywhere → exit 2",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(2, "tm: keys create needs --url or a saved login"),
  );
  o = await tm(["login", "--no-browser"]);
  check(
    "login with no URL anywhere → exit 2",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(2, "tm: login needs --url the first time"),
  );
  check("the fake server saw no request", hits, 0);

  console.log("\n── login real: the consent page approved with the box ticked ──");
  let t = start(["login", "--no-browser", "--url", BASE_URL]);
  let au = await t.url;
  const q = au ? new URL(au).searchParams : new URLSearchParams();
  check(
    "the authorization URL: client tm, S256, write keys, key name, loopback redirect",
    tup(
      au?.startsWith(`${BASE_URL}/oauth/authorize?`),
      q.get("response_type"),
      q.get("client_id"),
      q.get("code_challenge_method"),
      q.get("code_challenge")?.length,
      q.get("state")?.length,
      q.get("scope"),
      q.get("key_name"),
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(q.get("redirect_uri") ?? ""),
      q.has("key_expires"),
    ),
    tup(true, "code", "tm", "S256", 43, 22, "write keys", `tm on ${HOST}`, true, false),
  );
  let cb = await browser(au, { access: "write", workspace: "", manage_keys: "1" });
  o = await t.done;
  const first = saved_key(CFG) ?? "";
  const [, me1] = await api("GET", "/api/tracker/me", first);
  check(
    "login real → exit 0, logged in as Alice, key saved in the config file",
    tup(o.code, o.stdout),
    tup(0, `logged in to ${BASE_URL} as Alice; key ${me1.key?.id} saved in ${CFG}\n`),
  );
  check(
    "the callback page: 200, html, sends the person back to the terminal to finish",
    tup(cb.status, cb.type, cb.html.includes(SIGNED_IN)),
    tup(200, "text/html; charset=utf-8", true),
  );
  check(
    "the key is a tmk_ key, never on stderr",
    tup(first.startsWith("tmk_"), o.stderr.includes(first)),
    tup(true, false),
  );
  o = await tm(["list"]);
  check("tm list with the new login → exit 0", tup(o.code, o.stderr), tup(0, ""));
  o = await tm(["keys", "list", "--json"]);
  const mine = (o.json ?? []).find((k: any) => k.id === me1.key?.id) ?? {};
  check(
    "keys list shows it: tm on <hostname>, client tm, manage_keys true, no expiry",
    tup(mine.name, mine.client_id, mine.manage_keys, mine.expires, mine.current),
    tup(`tm on ${HOST}`, "tm", true, "", true),
  );
  const config_text = (
    fs.existsSync(path.join(XDG, "tm")) ? fs.readdirSync(path.join(XDG, "tm")) : []
  )
    .map((f) => fs.readFileSync(path.join(XDG, "tm", f), "utf8"))
    .join("\n");
  check(
    "no refresh token stored anywhere in the config dir",
    /refresh|tmr_/.test(config_text),
    false,
  );

  console.log("\n── login --json replaces the first login ──");
  t = start(["login", "--no-browser", "--json"]);
  cb = await browser(await t.url, { access: "write", workspace: "", manage_keys: "1" });
  o = await t.done;
  check(
    "login --json → saved, store file, url, user Alice, key manage_keys true",
    tup(
      o.code,
      o.json?.saved,
      o.json?.store,
      o.json?.url,
      o.json?.user?.name,
      o.json?.key?.manage_keys,
      o.json?.key?.client_id,
    ),
    tup(0, CFG, "file", BASE_URL, "Alice", true, "tm"),
  );
  const second = saved_key(CFG) ?? "";
  [s] = await api("GET", "/api/tracker/me", first);
  check("login replaces: the first key answers 401", tup(s, second !== first), tup(401, true));

  console.log("\n── login denied ──");
  t = start(["login", "--no-browser"]);
  cb = await browser(await t.url, "deny");
  o = await t.done;
  check(
    "denied → exit 1 with its message",
    tup(o.code, o.stderr.split("\n").at(-2)),
    tup(1, "tm: sign-in was denied in the browser"),
  );
  check(
    "the callback page: 400, Sign-in did not finish",
    tup(
      cb.status,
      cb.html.includes(
        "<p>Sign-in did not finish: sign-in was denied in the browser. Return to the terminal for details.</p>",
      ),
    ),
    tup(400, true),
  );
  [s] = await api("GET", "/api/tracker/me", saved_key(CFG));
  check("the earlier login still works", tup(s, saved_key(CFG) === second), tup(200, true));

  console.log("\n── keys create real: printed once, nothing saved ──");
  const before = read(CFG);
  t = start(["keys", "create", "--name", "ci bot", "--scope", "read", "--no-browser"]);
  au = await t.url;
  check(
    "keys create asks for read without keys, named ci bot",
    tup(
      au && new URL(au).searchParams.get("scope"),
      au && new URL(au).searchParams.get("key_name"),
    ),
    tup("read", "ci bot"),
  );
  cb = await browser(au, { access: "read", workspace: "" });
  o = await t.done;
  const made = o.stdout.trim();
  const [, me2] = await api("GET", "/api/tracker/me", made);
  check("exit 0, stdout is one tmk_ line", tup(o.code, /^tmk_\S+\n$/.test(o.stdout)), tup(0, true));
  check(
    "stderr names it, never shows it",
    tup(
      o.stderr.includes(
        `created key ${me2.key?.id} "ci bot" (read, expires never); it is shown only this once\n`,
      ),
      o.stderr.includes(made),
    ),
    tup(true, false),
  );
  check("the saved login is unchanged", read(CFG) === before, true);
  check(
    "the key's me: scope read, manage_keys false, client tm",
    tup(me2.key?.scope, me2.key?.manage_keys, me2.key?.client_id),
    tup("read", false, "tm"),
  );

  console.log("\n── keys create --json --expires ──");
  const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  t = start([
    "keys",
    "create",
    "--name",
    "dated",
    "--scope",
    "write",
    "--expires",
    day,
    "--json",
    "--no-browser",
  ]);
  au = await t.url;
  check(
    "key_expires sent as that day 00:00 UTC",
    au && new URL(au).searchParams.get("key_expires"),
    `${day}T00:00:00Z`,
  );
  cb = await browser(au, { access: "write", workspace: "" });
  o = await t.done;
  check(
    "--json → id, name, scope, client_id tm, manage_keys false, key tmk_",
    tup(
      o.code,
      o.json?.name,
      o.json?.scope,
      o.json?.client_id,
      o.json?.manage_keys,
      String(o.json?.key).startsWith("tmk_"),
    ),
    tup(0, "dated", "write", "tm", false, true),
  );
  const [, me3] = await api("GET", "/api/tracker/me", o.json?.key);
  check(
    "the record expires that day 00:00 UTC",
    tup(o.json?.id === me3.key?.id, me3.key?.expires, o.json?.expires),
    tup(true, `${day} 00:00:00.000Z`, `${day} 00:00:00.000Z`),
  );

  console.log("\n── interrupted: Ctrl-C while waiting ──");
  const kept = read(CFG);
  t = start(["login", "--no-browser"]);
  au = await t.url;
  const cb_url = au ? (new URL(au).searchParams.get("redirect_uri") ?? "") : "";
  t.proc.kill("SIGINT");
  o = await t.done;
  check(
    "SIGINT → exit 130, the saved login untouched",
    tup(o.code, read(CFG) === kept),
    tup(130, true),
  );
  check(
    "the listener port refuses connections afterwards",
    cb_url !== "" && (await refused(cb_url)),
    true,
  );

  console.log("\n── fake server: state mismatch, then the right state ──");
  t = start(["login", "--no-browser", "--url", FAKE], FXDG);
  au = await t.url;
  const loc = au ? ((await fetch(au, { redirect: "manual" })).headers.get("Location") ?? "") : "";
  const wrong = new URL(loc || "http://127.0.0.1:1/callback");
  wrong.searchParams.set("state", "wrong");
  let r = await fetch(wrong);
  check(
    "a wrong state → 400 state mismatch",
    tup(r.status, await r.text()),
    tup(400, "state mismatch"),
  );
  r = await fetch(new URL("/elsewhere", wrong));
  check("another path → 404 not found", tup(r.status, await r.text()), tup(404, "not found"));
  r = await fetch(loc);
  const ok_html = await r.text();
  o = await t.done;
  check(
    "then the right state → 200 page, exit 0 (PKCE S256 verified by the fake), key saved",
    tup(r.status, ok_html.includes(SIGNED_IN), o.code, saved_key(FCFG)),
    tup(200, true, 0, FAKE_KEY),
  );
  check("a request after success finds the listener closed", await refused(loc), true);

  console.log("\n── fake server: refusals ──");
  const fake_before = read(FCFG);
  const fake_case = async (label: string, m: typeof mode, msg: string, page?: string) => {
    for (const k of Object.keys(mode)) delete (mode as any)[k];
    Object.assign(mode, m);
    const ft = start(["login", "--no-browser", "--url", FAKE], FXDG);
    const fc = await fake_browser(await ft.url);
    const fo = await ft.done;
    check(
      `${label} → exit 1, ${msg.slice(0, 40)}`,
      tup(fo.code, fo.stderr.split("\n").at(-2), read(FCFG) === fake_before),
      tup(1, `tm: ${msg}`, true),
    );
    if (page)
      check(
        `  ${label}: the page says so, escaped`,
        tup(fc.status, fc.html.includes(page)),
        tup(400, true),
      );
    return fc;
  };
  await fake_case(
    "iss mismatch",
    { iss: "http://evil.test" },
    "sign-in answered for another server; nothing was saved",
  );
  await fake_case(
    "iss absent",
    { iss: "" },
    "sign-in answered for another server; nothing was saved",
  );
  {
    const fc = await fake_case(
      "token error",
      { token_error: true },
      "sign-in failed: The code is invalid.",
    );
    check(
      "  token error: the page never claimed success; it sent the person back to the terminal",
      tup(fc.html.includes("Signed in"), fc.html.includes(SIGNED_IN)),
      tup(false, true),
    );
  }
  await fake_case(
    "callback error",
    { error: "server_error", error_description: `<b>"x" & 'y'</b>` },
    `sign-in failed: <b>"x" & 'y'</b>`,
    "Sign-in did not finish: sign-in failed: &lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;.",
  );
  await fake_case("no code", { no_code: true }, "sign-in failed: the callback carried no code");
  await fake_case(
    "callback error carrying a terminal escape",
    { error: "server_error", error_description: "x\u001b[2Jy" },
    "sign-in failed: x\\u001b[2Jy",
  );
  for (const k of Object.keys(mode)) delete (mode as any)[k];
  mode.me_fail = true;
  {
    const mt = start(
      [
        "keys",
        "create",
        "--name",
        "lost?",
        "--scope",
        "read",
        "--json",
        "--no-browser",
        "--url",
        FAKE,
      ],
      FXDG,
    );
    await fake_browser(await mt.url);
    const mo = await mt.done;
    check(
      "keys create --json when the key's details cannot be read → exit 1, the key still printed, a note",
      tup(mo.code, mo.json?.key, mo.stderr.includes("the key was created")),
      tup(1, FAKE_KEY, true),
    );
  }
  {
    const lt = start(["login", "--no-browser", "--url", FAKE], FXDG);
    await fake_browser(await lt.url);
    const lo = await lt.done;
    check(
      "login when the key's details cannot be read → exit 1, says the login was saved, and it was",
      tup(lo.code, lo.stderr.includes("the login was saved"), read(FCFG)?.includes(FAKE_KEY)),
      tup(1, true, true),
    );
  }
  delete mode.me_fail;
  for (const k of Object.keys(mode)) delete (mode as any)[k];
  mode.no_meta = true;
  o = await tm(["login", "--no-browser", "--url", FAKE], FXDG);
  check(
    "no metadata (404) → exit 1, does not offer browser sign-in",
    tup(o.code, o.stderr.split("\n")[0], o.stderr.includes("Open this page")),
    tup(1, `tm: ${FAKE} does not offer browser sign-in; use tm login --with-key`, false),
  );
  delete mode.no_meta;

  console.log("\n── timeout, in-process ──");
  let msg = "";
  let printed = "";
  const sigint = process.listenerCount("SIGINT");
  const write = process.stderr.write.bind(process.stderr);
  try {
    const { sign_in } = await import("../clients/tm/src/oauth.ts");
    (process.stderr as any).write = (c: any) => ((printed += String(c)), true);
    try {
      await sign_in(FAKE, {
        scope: "write",
        key_name: "x",
        keys: true,
        open_browser: false,
        timeout_ms: 500,
      });
    } catch (e: any) {
      msg = `${e?.constructor?.name}: ${e?.message}`;
    } finally {
      (process.stderr as any).write = write;
    }
  } catch (e: any) {
    msg = `import failed: ${e?.message}`;
  }
  check(
    "timeout → ConfigError, the 5-minute message",
    msg,
    "ConfigError: sign-in was not finished within 5 minutes",
  );
  const t_url = /redirect_uri=([^&\s]+)/.exec(printed)?.[1];
  check(
    "the listener closed, the SIGINT handler removed",
    tup(!!t_url && (await refused(decodeURIComponent(t_url))), process.listenerCount("SIGINT")),
    tup(true, sigint),
  );

  console.log("\n── under Node ──");
  const found = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
  const version = found.success ? found.stdout.toString().trim() : "";
  const node_ok = found.success && Bun.semver.satisfies(version.replace(/^v/, ""), ">=22.18.0");
  check(`node 22.18.0 or later is on PATH (found ${version || "no node"})`, node_ok, true);
  if (node_ok) {
    const out = path.join(S, "node", "tm.mjs");
    const built = Bun.spawnSync(
      [process.execPath, "build", "--target=node", TM, "--outfile", out],
      { stdout: "pipe", stderr: "pipe" },
    );
    check(
      "bun build --target=node tm.ts",
      tup(built.exitCode, built.stderr.toString()),
      tup(0, ""),
    );
    const NXDG = path.join(S, "node-xdg");
    t = start(["login", "--no-browser", "--url", FAKE], NXDG, ["node", out]);
    const nc = await fake_browser(await t.url);
    o = await t.done;
    check(
      "node tm.mjs login → page 200, exit 0, the config file holds the key",
      tup(nc.status, o.code, saved_key(path.join(NXDG, "tm", "config.json"))),
      tup(200, 0, FAKE_KEY),
    );
  }
} finally {
  if (server !== null) await roomkit.stop(server);
  fake.stop(true);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all tm browser login proofs passed");
  process.exit(0);
}

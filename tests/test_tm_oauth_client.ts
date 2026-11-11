#!/usr/bin/env bun
/**
 * decision:api-key-manages-keys: the tm client's grants at the token endpoint mint a key with the
 * name, expiry and manage-keys permission asked for, and no refresh token; the consent page shows
 * them and offers the permission only to tm.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8221 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import {
  approve_with,
  authorize_params,
  exchange,
  PKCE,
  post_consent,
  sign_in_to_consent,
} from "./oauthkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8221 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const CODES = "/api/collections/oauth_codes/records";
const KEYS = "/api/collections/api_keys/records";
const TM_REDIRECT = "http://127.0.0.1:53123/callback";
const CURSOR_REDIRECT = "http://localhost:8787/callback";

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
  auth: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { _raw: text };
  }
  return [r.status, parsed];
}

async function form(url: string, fields: Record<string, string>): Promise<[number, any]> {
  const r = await fetch(BASE_URL + url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return [r.status, await r.json().catch(() => ({}))];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tm-oauth-client-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
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
  process.env.MCP_PUBLIC_URL = "http://mcp.test";
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  // This suite sends more than the /oauth/ rule's 30 a minute from one address.
  const [, settings] = await api("GET", "/api/settings", su);
  const [s_rl] = await api("PATCH", "/api/settings", su, {
    rateLimits: {
      ...settings.rateLimits,
      rules: settings.rateLimits.rules.map((r: any) =>
        r.label === "/oauth/" ? { ...r, maxRequests: 100000 } : r,
      ),
    },
  });
  check("(fixture) superuser raises the /oauth/ rule → 200", s_rl, 200);
  const [s_alice, alice] = await api("POST", "/api/collections/users/records", su, {
    email: "alice@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Alice",
    verified: true,
    approved: true,
  });
  check("(fixture) Alice (verified, approved) → 200", s_alice, 200);

  /** Inserts a code row as the superuser and returns the code. */
  async function code_row(over: Record<string, any>): Promise<string> {
    const code = crypto.randomUUID();
    const tm = (over.client_id ?? "tm") === "tm";
    const [s, r] = await api("POST", CODES, su, {
      code_hash: sha256(code),
      user: alice.id,
      client_id: "tm",
      client_name: tm ? "tm (command line)" : "Cursor",
      redirect_uri: tm ? TM_REDIRECT : CURSOR_REDIRECT,
      code_challenge: PKCE.challenge,
      scope: "write",
      expires: new Date(Date.now() + 300_000).toISOString(),
      ...over,
    });
    if (s !== 200) throw new roomkit.SystemExit(`code_row insert failed: ${s} ${py_repr(r)}`);
    return code;
  }
  const tmParams = { client_id: "tm", redirect_uri: TM_REDIRECT };
  /** The minted record, hidden fields included, read by the superuser through the key's /me. */
  const record = async (access: string): Promise<any> => {
    const [, me] = await api("GET", "/api/tracker/me", access);
    return (await api("GET", `${KEYS}/${me.key?.id}`, su))[1];
  };

  console.log("\n── tm grants at the token endpoint ──");
  const g1 = await exchange(BASE_URL, await code_row({ manage_keys: true }), tmParams);
  const r1 = await record(g1.body?.access_token);
  check(
    "tm code with manage_keys → 200, scope read write keys, no refresh_token, no expires_in",
    tup(
      g1.status,
      g1.body?.scope,
      "refresh_token" in (g1.body ?? {}),
      "expires_in" in (g1.body ?? {}),
    ),
    tup(200, "read write keys", false, false),
  );
  check(
    "  its record: client_id tm, manage_keys true, name tm, no expiry, no refresh hash",
    tup(r1.client_id, r1.manage_keys, r1.name, r1.expires, r1.refresh_hash),
    tup("tm", true, "tm", "", ""),
  );

  const g2 = await exchange(BASE_URL, await code_row({}), tmParams);
  check(
    "tm code without manage_keys → scope read write, record manage_keys false",
    tup(g2.status, g2.body?.scope, (await record(g2.body?.access_token)).manage_keys),
    tup(200, "read write", false),
  );

  const in2d = new Date(Date.now() + 2 * 86400_000);
  in2d.setUTCMilliseconds(0);
  const g3 = await exchange(
    BASE_URL,
    await code_row({ key_name: "ci bot", key_expires: in2d.toISOString() }),
    tmParams,
  );
  const r3 = await record(g3.body?.access_token);
  check(
    "tm key_name and key_expires → record name ci bot, expires equal, expires_in about 2 days",
    tup(
      g3.status,
      r3.name,
      Date.parse(String(r3.expires).replace(" ", "T")) === in2d.getTime(),
      g3.body?.expires_in > 172000 && g3.body?.expires_in <= 172800,
    ),
    tup(200, "ci bot", true, true),
  );

  const soon = await code_row({ key_expires: new Date(Date.now() + 1000).toISOString() });
  const [, before] = await api("GET", `${KEYS}?perPage=500`, su);
  await sleep(2000);
  const g4 = await exchange(BASE_URL, soon, tmParams);
  const [, after] = await api("GET", `${KEYS}?perPage=500`, su);
  check(
    "tm expiry passed at exchange → 400 invalid_grant with its message, no key minted",
    tup(
      g4.status,
      g4.body?.error,
      g4.body?.error_description,
      after.totalItems === before.totalItems,
    ),
    tup(400, "invalid_grant", "The requested key expiry has passed.", true),
  );
  const g4b = await exchange(BASE_URL, soon, tmParams);
  check(
    "  the same code again → 400 invalid_grant (consumed)",
    tup(g4b.status, g4b.body?.error),
    tup(400, "invalid_grant"),
  );

  const [s5, r5] = await form("/oauth/token", {
    grant_type: "refresh_token",
    client_id: "tm",
    refresh_token: "tmr_x",
  });
  check(
    "tm refresh refused → 400 invalid_grant with its message",
    tup(s5, r5.error, r5.error_description),
    tup(400, "invalid_grant", "tm grants are not refreshed."),
  );

  const g6 = await exchange(
    BASE_URL,
    await code_row({ client_id: "cursor", key_name: "x", manage_keys: true }),
    { client_id: "cursor", redirect_uri: CURSOR_REDIRECT },
  );
  const r6 = await record(g6.body?.access_token);
  check(
    "other client keeps its shape: name Cursor, manage_keys false, refresh_token present",
    tup(g6.status, r6.name, r6.manage_keys, typeof g6.body?.refresh_token),
    tup(200, "Cursor", false, "string"),
  );

  const [s7] = await form("/oauth/revoke", { token: g2.body?.access_token, client_id: "tm" });
  const [s7b, r7b] = await api("GET", "/api/tracker/me", g2.body?.access_token);
  check(
    "tm key revoked at /oauth/revoke → 200, the key then 401 api_key_invalid",
    tup(s7, s7b, r7b.data?.api_key?.code),
    tup(200, 401, "api_key_invalid"),
  );

  console.log("\n── the tm client on the authorization page ──");
  const who = { email: "alice@example.com", password: "test123456" };
  const base = authorize_params({
    client_id: "tm",
    redirect_uri: TM_REDIRECT,
    scope: "write keys",
  });
  const page = (await sign_in_to_consent(BASE_URL, base, who)).html;
  check(
    "tm page shown: client, registration, loopback warning, key name, expiry, ticked box",
    [
      "tm (command line)",
      "registered with Task Tracker as tm",
      "This app runs on your own computer",
      "Key name: tm",
      "Expires: never",
      '<input type="checkbox" name="manage_keys" value="1" checked>',
    ].map((t) => page.includes(t)),
    [true, true, true, true, true, true],
  );

  const a1 = await approve_with(BASE_URL, base, who, {
    access: "write",
    workspace: "",
    manage_keys: "1",
  });
  const loc = new URL(a1.location).searchParams;
  const t1 = await exchange(BASE_URL, a1.code, base);
  check(
    "tm approve with keys → 302 with code, state, iss; token scope read write keys; record manage_keys true",
    tup(
      !!loc.get("code"),
      loc.get("state"),
      loc.get("iss"),
      t1.body?.scope,
      (await record(t1.body?.access_token)).manage_keys,
    ),
    tup(true, base.state, BASE_URL, "read write keys", true),
  );
  const a2 = await approve_with(BASE_URL, base, who, { access: "write", workspace: "" });
  const t2 = await exchange(BASE_URL, a2.code, base);
  check(
    "tm approve with the box unticked → scope read write, record manage_keys false",
    tup(t2.body?.scope, (await record(t2.body?.access_token)).manage_keys),
    tup("read write", false),
  );

  const exp = new Date(Date.now() + 2 * 86400_000);
  exp.setUTCMilliseconds(0);
  const expText = exp.toISOString().replace(".000Z", "Z");
  const named = { ...base, key_name: "ci bot", key_expires: expText };
  const namedPage = (await sign_in_to_consent(BASE_URL, named, who)).html;
  const a3 = await approve_with(BASE_URL, named, who, { access: "write", workspace: "" });
  const r3b = await record((await exchange(BASE_URL, a3.code, named)).body?.access_token);
  check(
    "tm key_name and key_expires shown on the page and carried to the key",
    tup(
      namedPage.includes("Key name: ci bot"),
      namedPage.includes(`Expires: ${expText.slice(0, 16).replace("T", " ")} UTC`),
      r3b.name,
      Date.parse(String(r3b.expires).replace(" ", "T")) === exp.getTime(),
    ),
    tup(true, true, "ci bot", true),
  );

  const redirected = async (params: Record<string, string>): Promise<string | null> => {
    const q = new URLSearchParams(params).toString();
    const r = await fetch(`${BASE_URL}/oauth/authorize?${q}`, { redirect: "manual" });
    await r.body?.cancel();
    const l = r.headers.get("Location");
    return r.status === 302 && l ? new URL(l).searchParams.get("error") : `status ${r.status}`;
  };
  check(
    "key_expires past, key_name of 201 characters, key_name of spaces, key_expires=tomorrow → invalid_request",
    [
      await redirected({ ...base, key_expires: "2020-01-01T00:00:00Z" }),
      await redirected({ ...base, key_name: "x".repeat(201) }),
      await redirected({ ...base, key_name: "  " }),
      await redirected({ ...base, key_expires: "tomorrow" }),
    ],
    ["invalid_request", "invalid_request", "invalid_request", "invalid_request"],
  );

  const mgr = { ...base, scope: "manage keys" };
  const a4 = await approve_with(BASE_URL, mgr, who, {
    access: "manage",
    workspace: "",
    manage_keys: "1",
  });
  const t4 = await exchange(BASE_URL, a4.code, mgr);
  check(
    "tm at manage → token scope read write manage keys, record scope manage",
    tup(t4.body?.scope, (await record(t4.body?.access_token)).scope),
    tup("read write manage keys", "manage"),
  );

  const cursor = authorize_params({
    client_id: "cursor",
    redirect_uri: "http://localhost:5555/callback",
    scope: "read keys",
  });
  check("keys from another client → invalid_scope", await redirected(cursor), "invalid_scope");
  const cursorNamed = authorize_params({
    client_id: "cursor",
    redirect_uri: "http://localhost:5555/callback",
    key_name: "x",
  });
  const cursorPage = (await sign_in_to_consent(BASE_URL, cursorNamed, who)).html;
  const a5 = await approve_with(BASE_URL, cursorNamed, who, { access: "write", workspace: "" });
  const p5 = await record((await exchange(BASE_URL, a5.code, cursorNamed)).body?.access_token);
  check(
    "key_name ignored for another client: no Key name on the page, the key is named Cursor",
    tup(cursorPage.includes("Key name"), p5.name),
    tup(false, "Cursor"),
  );

  const c6 = await sign_in_to_consent(BASE_URL, base, who);
  const p6 = await post_consent(BASE_URL, { ...base, key_name: "changed" }, c6.flow, {
    action: "approve",
    access: "write",
    workspace: "",
  });
  const html6 = await p6.text();
  check(
    "flow binds key_name: a changed key_name re-renders the page, no code",
    tup(
      p6.status,
      p6.headers.get("Location"),
      html6.includes("This sign-in took too long or was changed. Start again."),
    ),
    tup(200, null, true),
  );
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all tm OAuth client proofs passed");
  process.exit(0);
}

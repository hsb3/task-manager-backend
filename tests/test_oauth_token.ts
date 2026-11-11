#!/usr/bin/env bun
/**
 * hosted-mcp-endpoint authorization server: RFC 8414 metadata, the code exchange that mints an
 * api_keys record, refresh rotation with replay detection, and RFC 7009 revocation, each error
 * answered with its OAuth code.
 *
 * Fully self-contained clean-room server. Port 8201 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8201 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const CODES = "/api/collections/oauth_codes/records";
const KEYS = "/api/collections/api_keys/records";
// RFC 7636 Appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://localhost:9999/callback";

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

type FormAnswer = { status: number; body: any; text: string; headers: Headers };

/** POSTs a form; pairs keep their order so a parameter can be sent twice. */
async function form(url: string, pairs: [string, string][]): Promise<FormAnswer> {
  const r = await fetch(BASE_URL + url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text };
  }
  return { status: r.status, body, text, headers: r.headers };
}

const err = (a: FormAnswer) => tup(a.status, a.body?.error ?? null);
const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const random_code = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(40)), (b) =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(b % 62),
  ).join("");

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-oauth-token-test-"));
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

  const [s_alice, alice_rec] = await api("POST", "/api/collections/users/records", su, {
    email: "alice@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Alice",
    verified: true,
    approved: true,
  });
  check("fixture: Alice (verified, approved) → 200", s_alice, 200);
  const alice_id: string = alice_rec.id;
  const [, alice_auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "alice@example.com",
    password: "test123456",
  });
  const alice: string = alice_auth.token;

  /** Inserts a fresh code row as the superuser and returns the code. */
  async function code_row(over: Record<string, any> = {}): Promise<string> {
    const code = random_code();
    const [s, r] = await api("POST", CODES, su, {
      code_hash: sha256(code),
      user: alice_id,
      client_id: "cursor",
      client_name: "Cursor",
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      scope: "write",
      expires: new Date(Date.now() + 600_000).toISOString(),
      ...over,
    });
    if (s !== 200) throw new roomkit.SystemExit(`code_row insert failed: ${s} ${py_repr(r)}`);
    return code;
  }

  const exchange_pairs = (code: string, over: Record<string, string> = {}): [string, string][] =>
    Object.entries({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: "cursor",
      code_verifier: VERIFIER,
      ...over,
    });
  const exchange = (code: string, over: Record<string, string> = {}) =>
    form("/oauth/token", exchange_pairs(code, over));
  const refresh = (token: string, over: Record<string, string> = {}) =>
    form(
      "/oauth/token",
      Object.entries({
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: "cursor",
        ...over,
      }),
    );
  const revoke = (token: string, client_id = "cursor") =>
    form("/oauth/revoke", [
      ["token", token],
      ["client_id", client_id],
    ]);
  const me_status = async (key: string) => (await api("GET", "/api/tracker/me", key))[0];

  /** A code exchanged for a grant: its access and refresh tokens and the api_keys record id. */
  async function grant(scope = "write") {
    const a = await exchange(await code_row({ scope }));
    if (a.status !== 200) throw new roomkit.SystemExit(`grant failed: ${a.status} ${a.text}`);
    const [, me] = await api("GET", "/api/tracker/me", a.body.access_token);
    return {
      access: a.body.access_token as string,
      refresh: a.body.refresh_token as string,
      record_id: me?.key?.id as string,
    };
  }

  console.log("\n── metadata ──");
  const meta = await fetch(BASE_URL + "/.well-known/oauth-authorization-server");
  check(
    "as_metadata: GET → 200, body is the contract's document",
    tup(meta.status, await meta.json()),
    tup(200, {
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      revocation_endpoint: `${BASE_URL}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "write"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  check(
    "as_metadata: Cache-Control is public, max-age=300",
    meta.headers.get("Cache-Control"),
    "public, max-age=300",
  );

  console.log("\n── the code exchange mints a key ──");
  const code1 = await code_row();
  const ex = await exchange(code1);
  check(
    "exchange_mints_key: 200, Bearer, 86400, read write, tmk_/tmr_ tokens, no-store",
    tup(
      ex.status,
      ex.body?.token_type,
      ex.body?.expires_in,
      ex.body?.scope,
      /^tmk_[A-Za-z0-9]{40}$/.test(ex.body?.access_token ?? ""),
      /^tmr_[A-Za-z0-9]{40}$/.test(ex.body?.refresh_token ?? ""),
      ex.headers.get("Cache-Control"),
    ),
    tup(200, "Bearer", 86400, "read write", true, true, "no-store"),
  );
  const [s_me, me1] = await api("GET", "/api/tracker/me", ex.body?.access_token ?? "tmk_none");
  const expires_ms = Date.parse(String(me1?.key?.expires ?? "").replace(" ", "T"));
  check(
    "minted_key_works: /me → 200, client_id cursor, scope write, expires ≈ now + 24 h",
    tup(
      s_me,
      me1?.key?.client_id,
      me1?.key?.scope,
      Math.abs(expires_ms - (Date.now() + 86_400_000)) < 120_000,
    ),
    tup(200, "cursor", "write", true),
  );
  const [, listed] = await api("GET", KEYS, alice);
  const minted = (listed.items ?? []).find((k: any) => k.id === me1?.key?.id);
  check(
    "minted_key_listed: Alice's key list holds it, client_id cursor, name Cursor",
    tup(minted?.client_id, minted?.name),
    tup("cursor", "Cursor"),
  );
  check(
    "code_reused: the same exchange again → 400 invalid_grant",
    err(await exchange(code1)),
    tup(400, "invalid_grant"),
  );

  console.log("\n── exchange failures ──");
  check(
    "code_expired: a code past its expiry → 400 invalid_grant",
    err(await exchange(await code_row({ expires: new Date(Date.now() - 60_000).toISOString() }))),
    tup(400, "invalid_grant"),
  );
  const burned = await code_row();
  check(
    "pkce_mismatch: verifier of 43 a → 400 invalid_grant",
    err(await exchange(burned, { code_verifier: "a".repeat(43) })),
    tup(400, "invalid_grant"),
  );
  check(
    "pkce_mismatch: the same code with the right verifier → 400 invalid_grant (burned)",
    err(await exchange(burned)),
    tup(400, "invalid_grant"),
  );
  check(
    "pkce_plain: verifier equal to the stored challenge → 400 invalid_grant",
    err(await exchange(await code_row(), { code_verifier: CHALLENGE })),
    tup(400, "invalid_grant"),
  );
  check(
    "verifier_malformed: verifier short → 400 invalid_request",
    err(await exchange(await code_row(), { code_verifier: "short" })),
    tup(400, "invalid_request"),
  );
  check(
    "redirect_mismatch: another redirect_uri → 400 invalid_grant",
    err(await exchange(await code_row(), { redirect_uri: "http://localhost:9998/callback" })),
    tup(400, "invalid_grant"),
  );
  check(
    "client_mismatch: client_id https://example.com/c → 400 invalid_client",
    err(await exchange(await code_row(), { client_id: "https://example.com/c" })),
    tup(400, "invalid_client"),
  );
  check(
    "missing_param: no code → 400 invalid_request",
    err(
      await form(
        "/oauth/token",
        exchange_pairs(await code_row()).filter(([k]) => k !== "code"),
      ),
    ),
    tup(400, "invalid_request"),
  );
  const twice = await code_row();
  check(
    "repeated_param: code twice → 400 invalid_request",
    err(await form("/oauth/token", [...exchange_pairs(twice), ["code", twice]])),
    tup(400, "invalid_request"),
  );
  check(
    "bad_grant_type: grant_type=password → 400 unsupported_grant_type",
    err(await exchange(await code_row(), { grant_type: "password" })),
    tup(400, "unsupported_grant_type"),
  );
  check(
    "resource_other: resource=http://other/mcp → 400 invalid_target",
    err(await exchange(await code_row(), { resource: "http://other/mcp" })),
    tup(400, "invalid_target"),
  );
  check(
    "resource_ok: resource=HTTP://MCP.TEST/mcp → 200",
    (await exchange(await code_row(), { resource: "HTTP://MCP.TEST/mcp" })).status,
    200,
  );

  const racing = await code_row({ client_id: "cursor", client_name: "Race" });
  const keys_before = (await api("GET", `${KEYS}?perPage=500`, su))[1].totalItems;
  const raced = await Promise.all(Array.from({ length: 10 }, () => exchange(racing)));
  const keys_after = (await api("GET", `${KEYS}?perPage=500`, su))[1].totalItems;
  check(
    "code_race: 10 parallel exchanges of one code → one 200, nine 400 invalid_grant, one new key",
    tup(
      raced.filter((x) => x.status === 200).length,
      raced.filter((x) => x.body?.error === "invalid_grant").length,
      keys_after - keys_before,
    ),
    tup(1, 9, 1),
  );

  console.log("\n── refresh ──");
  let g = await grant();
  let a = await refresh(g.refresh);
  const [, me_new] = await api("GET", "/api/tracker/me", a.body?.access_token ?? "tmk_none");
  check(
    "refresh_rotates: 200, new tokens; old access → 401, new → 200; record id kept",
    tup(
      a.status,
      a.body?.access_token !== g.access && a.body?.refresh_token !== g.refresh,
      await me_status(g.access),
      await me_status(a.body?.access_token ?? "tmk_none"),
      me_new?.key?.id === g.record_id,
    ),
    tup(200, true, 401, 200, true),
  );
  g = await grant();
  a = await refresh(g.refresh);
  check(
    "refresh_replay_ends_grant: the first refresh token again → 400 invalid_grant",
    err(await refresh(g.refresh)),
    tup(400, "invalid_grant"),
  );
  check(
    "refresh_replay_ends_grant: the newest access token → 401, newest refresh → invalid_grant",
    tup(
      await me_status(a.body?.access_token ?? "tmk_none"),
      err(await refresh(a.body?.refresh_token ?? "tmr_none")),
    ),
    tup(401, tup(400, "invalid_grant")),
  );
  g = await grant("write");
  check(
    "refresh_scope_narrowed: scope=read on a write grant → 400 invalid_scope",
    err(await refresh(g.refresh, { scope: "read" })),
    tup(400, "invalid_scope"),
  );
  check(
    "refresh_scope_narrowed: scope=write → 200",
    (await refresh(g.refresh, { scope: "write" })).status,
    200,
  );
  g = await grant();
  check(
    "refresh_other_client: client_id=other → 400 invalid_client",
    err(await refresh(g.refresh, { client_id: "other" })),
    tup(400, "invalid_client"),
  );
  g = await grant();
  const rec_before = JSON.stringify((await api("GET", `${KEYS}/${g.record_id}`, su))[1]);
  check(
    "refresh_wrong_client: a known other client uses the token → 400 invalid_client, record unchanged",
    tup(
      err(await refresh(g.refresh, { client_id: "https://example.com/c" })),
      JSON.stringify((await api("GET", `${KEYS}/${g.record_id}`, su))[1]) === rec_before,
    ),
    tup(tup(400, "invalid_client"), true),
  );
  g = await grant();
  const [s_rev] = await api("PATCH", `${KEYS}/${g.record_id}`, alice, { revoked: true });
  check(
    "refresh_after_revoke: Alice revokes the record; refresh → 400 invalid_grant",
    tup(s_rev, err(await refresh(g.refresh))),
    tup(200, tup(400, "invalid_grant")),
  );
  g = await grant();
  const [s_del] = await api("DELETE", `${KEYS}/${g.record_id}`, alice);
  check(
    "refresh_after_delete: Alice deletes the record; refresh → 400 invalid_grant",
    tup(s_del, err(await refresh(g.refresh))),
    tup(204, tup(400, "invalid_grant")),
  );
  g = await grant();
  const [s_exp] = await api("PATCH", `${KEYS}/${g.record_id}`, su, {
    refresh_expires: new Date(Date.now() - 60_000).toISOString(),
  });
  check(
    "refresh_expired: refresh_expires in the past; refresh → 400 invalid_grant",
    tup(s_exp, err(await refresh(g.refresh))),
    tup(200, tup(400, "invalid_grant")),
  );

  console.log("\n── revocation ──");
  g = await grant();
  let rv = await revoke(g.access);
  check(
    "revoke_access_token: 200, empty body; the key on /me → 401",
    tup(rv.status, rv.text, await me_status(g.access)),
    tup(200, "", 401),
  );
  g = await grant();
  rv = await revoke(g.refresh);
  check(
    "revoke_refresh_token: 200; a refresh with it → 400 invalid_grant",
    tup(rv.status, err(await refresh(g.refresh))),
    tup(200, tup(400, "invalid_grant")),
  );
  check(
    "revoke_unknown: tmk_ + 40 z → 200; garbage → 200",
    tup((await revoke(`tmk_${"z".repeat(40)}`)).status, (await revoke("garbage")).status),
    tup(200, 200),
  );
  g = await grant();
  const before = (await api("GET", `${KEYS}/${g.record_id}`, su))[1];
  rv = await revoke(g.access, "https://example.com/c");
  const after = (await api("GET", `${KEYS}/${g.record_id}`, su))[1];
  check(
    "revoke_other_client: another client → 400 invalid_client, record unchanged",
    tup(err(rv), JSON.stringify(after) === JSON.stringify(before)),
    tup(tup(400, "invalid_client"), true),
  );
  const [, hand] = await api("POST", KEYS, alice, { name: "by hand", scope: "read" });
  check(
    "revoke_hand_minted: 400 unsupported_token_type, the key still works",
    tup(err(await revoke(hand.key ?? "tmk_none")), await me_status(hand.key ?? "tmk_none")),
    tup(tup(400, "unsupported_token_type"), 200),
  );
  check(
    "revoke_missing_token: no token → 400 invalid_request",
    err(await form("/oauth/revoke", [["client_id", "cursor"]])),
    tup(400, "invalid_request"),
  );
  check(
    "unknown_client: /oauth/token code grant with client_id=nope → 400 invalid_client",
    err(await exchange(await code_row(), { client_id: "nope" })),
    tup(400, "invalid_client"),
  );
  check(
    "unknown_client: /oauth/revoke token=x client_id=nope → 400 invalid_client",
    err(await revoke("x", "nope")),
    tup(400, "invalid_client"),
  );
  check(
    "oauth_codes_closed: Alice's session lists oauth_codes → 403",
    (await api("GET", CODES, alice))[0],
    403,
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
  console.log("✅ all oauth-token proofs passed");
  process.exit(0);
}

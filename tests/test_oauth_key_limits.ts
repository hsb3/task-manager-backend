#!/usr/bin/env bun
/**
 * key-scoping OAuth consent: the page offers the person's live workspaces and the levels the
 * client asked for, a forged choice issues no code, and the minted key keeps its level and
 * workspace through the exchange and every refresh.
 *
 * Fully self-contained clean-room server. Port 8215 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import {
  authorize_params,
  exchange,
  post_consent,
  sign_in_and_approve,
  sign_in_to_consent,
} from "./oauthkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8215 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";
const ALICE = { email: "alice@example.com", password: PASSWORD };
const CHOOSE = "Choose one of the options shown.";

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

/** The radios named `name` on a page, in page order: [value, checked]. */
function radios(html: string, name: string): [string, boolean][] {
  const out: [string, boolean][] = [];
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\btype="radio"/.test(tag) || /\bname="([^"]*)"/.exec(tag)?.[1] !== name) continue;
    out.push([/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? "", /\schecked\b/.test(tag)]);
  }
  return out;
}

async function refresh(token: string, scope: string): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE_URL + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: "cursor",
      scope,
    }).toString(),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-oauth-key-limits-test-"));
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
  check("fixture: superuser raises the /oauth/ rule → 200", s_rl, 200);

  async function user(name: string): Promise<{ id: string; token: string }> {
    const email = `${name.toLowerCase()}@example.com`;
    const [s] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name,
      verified: true,
      approved: true,
    });
    const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    check(`fixture: ${name} created and signed in`, tup(s, Boolean(r.token)), tup(200, true));
    return { id: r.record?.id ?? "", token: r.token ?? "" };
  }
  const alice = await user("Alice");
  const bob = await user("Bob");
  const first_ws = async (token: string) =>
    ((await api("GET", "/api/tracker/me", token))[1].workspaces?.[0]?.id ?? "") as string;
  const make_ws = async (name: string) => {
    const [s, r] = await api("POST", "/api/collections/workspaces/records", alice.token, { name });
    check(`fixture: Alice creates workspace ${name} → 200`, s, 200);
    return r.id as string;
  };
  const WA = await first_ws(alice.token);
  const WB = await make_ws("WB");
  const WT = await make_ws("WT");
  const [s_wt] = await api("DELETE", `/api/collections/workspaces/records/${WT}`, alice.token);
  check("fixture: Alice moves WT to the trash → 204", s_wt, 204);
  const WC = await first_ws(bob.token);
  const [s_m] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: WC,
    user: alice.id,
    role: "member",
    status: "suspended",
  });
  check("fixture: Alice is a suspended member of Bob's WC → 200", s_m, 200);

  const base = authorize_params();
  const consent = (scope: string) => sign_in_to_consent(BASE_URL, { ...base, scope }, ALICE);
  /** Approve and exchange: the token answer, and the key's /me. */
  async function grant(scope: string, opts: { access: any; workspace?: string }) {
    const params = { ...base, scope };
    const { code } = await sign_in_and_approve(BASE_URL, params, ALICE, opts);
    const ex = await exchange(BASE_URL, code, params);
    const [, me] = await api("GET", "/api/tracker/me", ex.body?.access_token ?? "tmk_none");
    return { ex, me };
  }
  const codes_of_alice = async () =>
    (
      await api(
        "GET",
        `/api/collections/oauth_codes/records?filter=${encodeURIComponent(`user="${alice.id}"`)}`,
        su,
      )
    )[1]?.totalItems;

  console.log("\n── the consent page ──");
  let page = await consent("read write");
  check(
    "consent_lists_workspaces: All (checked), WA, WB in order; no trashed WT, no suspended WC",
    radios(page.html, "workspace"),
    [
      ["", true],
      [WA, false],
      [WB, false],
    ],
  );
  check(
    "consent_levels_default: scope=read write → read, write; write checked",
    radios(page.html, "access"),
    [
      ["read", false],
      ["write", true],
    ],
  );
  page = await consent("read");
  check(
    "consent_levels_read: scope=read → read, write; read checked",
    radios(page.html, "access"),
    [
      ["read", true],
      ["write", false],
    ],
  );
  page = await consent("offline_access");
  check(
    "scope_offline_only: scope=offline_access → read, write; read checked",
    radios(page.html, "access"),
    [
      ["read", true],
      ["write", false],
    ],
  );
  page = await consent("manage");
  check(
    "consent_levels_manage: scope=manage → read, write, manage; manage checked",
    radios(page.html, "access"),
    [
      ["read", false],
      ["write", false],
      ["manage", true],
    ],
  );
  page = await consent("own");
  check("consent_levels_own: scope=own → all four; own checked", radios(page.html, "access"), [
    ["read", false],
    ["write", false],
    ["manage", false],
    ["own", true],
  ]);

  console.log("\n── approving ──");
  const ws_grant = await grant("read write", { access: "write", workspace: WA });
  check(
    "approve_workspace_write: 200, scope read write; key reach workspace, WA; workspaces [WA]",
    tup(
      ws_grant.ex.status,
      ws_grant.ex.body?.scope,
      ws_grant.me?.key?.reach,
      ws_grant.me?.key?.workspace,
      (ws_grant.me?.workspaces ?? []).map((w: any) => w.id),
    ),
    tup(200, "read write", "workspace", WA, [WA]),
  );
  let g = await grant("read write", { access: "write" });
  check(
    "approve_all_default: key reach all; active workspaces [WA, WB]",
    tup(
      g.ex.status,
      g.me?.key?.reach,
      (g.me?.workspaces ?? []).filter((w: any) => w.status === "active").map((w: any) => w.id),
    ),
    tup(200, "all", [WA, WB]),
  );
  g = await grant("manage", { access: "manage" });
  check(
    "approve_manage: token scope read write manage; key.scope manage",
    tup(g.ex.status, g.ex.body?.scope, g.me?.key?.scope),
    tup(200, "read write manage", "manage"),
  );
  g = await grant("own", { access: "read" });
  check(
    "approve_lower_than_asked: scope=own, access=read → token scope read",
    tup(g.ex.status, g.ex.body?.scope),
    tup(200, "read"),
  );

  console.log("\n── forged choices ──");
  async function forged(label: string, scope: string, fields: Record<string, string>) {
    const before = await codes_of_alice();
    const c = await consent(scope);
    const r = await post_consent(BASE_URL, { ...base, scope }, c.flow, {
      action: "approve",
      ...fields,
    });
    const html = await r.text();
    check(
      label,
      tup(r.status, html.includes(CHOOSE), r.headers.get("Location"), await codes_of_alice()),
      tup(200, true, null, before),
    );
  }
  await forged("forged_level: scope=read write, access=own → 200 consent, no code", "read write", {
    access: "own",
  });
  await forged("forged_level: scope=read write, access=manage → same", "read write", {
    access: "manage",
  });
  await forged("forged_level: access=admin → same", "read write", { access: "admin" });
  await forged("forged_workspace: workspace=WC (suspended) → same", "read write", {
    access: "write",
    workspace: WC,
  });
  await forged("forged_workspace: workspace=WT (trashed) → same", "read write", {
    access: "write",
    workspace: WT,
  });
  await forged("forged_workspace: workspace=unknown id → same", "read write", {
    access: "write",
    workspace: "nope0000000000x",
  });

  console.log("\n── refresh ──");
  const key_id = (
    await api(
      "GET",
      `/api/collections/api_keys/records?filter=${encodeURIComponent(`workspace="${WA}" && user="${alice.id}"`)}`,
      su,
    )
  )[1]?.items?.[0]?.id;
  let rf = await refresh(ws_grant.ex.body?.refresh_token ?? "", "read write");
  const [, rec] = await api("GET", `/api/collections/api_keys/records/${key_id}`, su);
  check(
    "refresh_keeps_limits: 200; record reach workspace, WA, scope write, same id",
    tup(rf.status, rec?.reach, rec?.workspace, rec?.scope, rec?.id),
    tup(200, "workspace", WA, "write", key_id),
  );
  rf = await refresh(rf.body?.refresh_token ?? "", "read write manage");
  check(
    "refresh_keeps_limits: scope=read write manage → 400 invalid_scope",
    tup(rf.status, rf.body?.error),
    tup(400, "invalid_scope"),
  );

  console.log("\n── metadata ──");
  const [s_md, md] = await api("GET", "/.well-known/oauth-authorization-server");
  check(
    "metadata_scopes: scopes_supported read, write, manage, own",
    tup(s_md, md?.scopes_supported),
    tup(200, ["read", "write", "manage", "own"]),
  );

  console.log("\n── the workspace leaves after approval ──");
  {
    const params = { ...base };
    const { code } = await sign_in_and_approve(BASE_URL, params, ALICE, {
      access: "write",
      workspace: WB,
    });
    const [s_del] = await api("DELETE", `/api/collections/workspaces/records/${WB}`, alice.token);
    const ex = await exchange(BASE_URL, code, params);
    const [, keys] = await api(
      "GET",
      `/api/collections/api_keys/records?filter=${encodeURIComponent(`name="Cursor" && workspace="${WB}"`)}`,
      su,
    );
    check(
      "suspended_before_exchange: WB trashed after approval → 400 invalid_grant, no key for WB",
      tup(s_del, ex.status, ex.body?.error, keys?.totalItems),
      tup(204, 400, "invalid_grant", 0),
    );
  }
  {
    const WP = await make_ws("WP");
    const g = await grant("read write", { access: "write", workspace: WP });
    const [s_del] = await api("DELETE", `/api/collections/workspaces/records/${WP}`, su);
    const [s_me, me] = await api("GET", "/api/tracker/me", g.ex.body?.access_token ?? "tmk_none");
    check(
      "workspace_purged: key reached WP; superuser deletes WP → the key answers 401 api_key_invalid",
      tup(g.me?.key?.workspace, s_del, s_me, me?.data?.api_key?.code ?? me?.code ?? me),
      tup(WP, 204, 401, "api_key_invalid"),
    );
  }
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all oauth key-limit proofs passed");
  process.exit(0);
}

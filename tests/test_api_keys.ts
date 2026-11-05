#!/usr/bin/env bun
/**
 * decision:api-keys: a `tmk_` key from `api_keys` authenticates as its owning user, a read key
 * cannot write (403 api_key_scope), a revoked, expired, unknown or unapproved-owner key answers
 * 401, every auth and admin path refuses every key (403 api_key_path), and no key reaches /api/logs.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8146 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8146 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const USERS = "/api/collections/users/records";
const WORKSPACES = "/api/collections/workspaces/records";

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
    redirect: "manual",
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

// [status, data.api_key.code] — the wire shape every key refusal carries.
async function refusal(method: string, url: string, auth: string, body: any = null) {
  const [s, r] = await api(method, url, auth, body);
  return tup(s, r?.data?.api_key?.code ?? null);
}

const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// The id of the caller PB resolved: user_settings holds one owner-only row per user.
async function whoami(auth: string): Promise<string | null> {
  const [s, r] = await api("GET", "/api/collections/user_settings/records", auth);
  if (s !== 200) return `HTTP ${s}`;
  return r.items?.length === 1 ? r.items[0].user : null;
}

async function login(email: string, password = "test123456"): Promise<[string, string]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password,
  });
  if (s !== 200) throw new roomkit.SystemExit(`login ${email} failed: ${s} ${py_repr(r)}`);
  return [r.token, r.record.id];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-api-keys-test-"));
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
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  console.log("\n── fixtures: Alice, Bob, Dave (approved + verified) ──");
  for (const name of ["Alice", "Bob", "Dave"]) {
    const [s] = await api("POST", USERS, su, {
      email: `${name.toLowerCase()}@example.com`,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`fixture ${name} created`, s, 200);
  }
  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const [dave] = await login("dave@example.com");
  const [s_coll, coll] = await api("GET", "/api/collections/api_keys", su);
  check("api_keys collection exists", s_coll, 200);
  const KEYS_BY_ID = `/api/collections/${coll.id}/records`;

  let s: number;
  let r: any;

  // A refused create must leave nothing behind under the attempted name.
  async function stored_named(name: string): Promise<number> {
    const [, l] = await api("GET", `${KEYS}?${urlencode({ filter: `name='${name}'` })}`, su);
    return l.items?.length ?? -1;
  }

  async function mint(token: string, name: string, scope: string, extra: any = {}) {
    const [st, rec] = await api("POST", KEYS, token, { name, scope, ...extra });
    return [st, rec] as [number, any];
  }

  console.log("\n── issuing: the plaintext is returned once and never stored ──");
  const sse = new roomkit.SSEListener(BASE_URL, alice, "api_keys");
  await sse.start();
  check("realtime: Alice subscribes to api_keys", await (sse as any)._subscribe(), 204);
  let read_rec: any;
  [s, read_rec] = await mint(alice, "alice read", "read", { key_hash: "deadbeef" });
  const READ_KEY: string = read_rec.key ?? "";
  check(
    "Alice creates a read key → 200, key = tmk_ + 40 alnum, owner = Alice",
    tup(s, /^tmk_[A-Za-z0-9]{40}$/.test(READ_KEY), read_rec.user ?? null),
    tup(200, true, alice_id),
  );
  check("the create response carries no key_hash", "key_hash" in read_rec, false);
  const [, write_rec] = await mint(alice, "alice write", "write");
  const WRITE_KEY: string = write_rec.key ?? "";
  check("a second key differs from the first", WRITE_KEY !== READ_KEY && WRITE_KEY !== "", true);
  const [, bob_rec] = await mint(bob, "bob write", "write");
  const BOB_KEY: string = bob_rec.key ?? "";
  [s, r] = await api("GET", `${KEYS}/${read_rec.id}`, alice);
  check(
    "view by the owner: no key, no key_hash",
    tup(s, "key" in r, "key_hash" in r),
    tup(200, false, false),
  );
  [s, r] = await api("GET", KEYS, alice);
  check(
    "list by the owner: Alice sees her two keys, none carrying key or key_hash",
    tup(
      s,
      r.items?.length,
      r.items?.some((i: any) => "key" in i || "key_hash" in i),
    ),
    tup(200, 2, false),
  );
  [s, r] = await api("GET", `${KEYS}/${read_rec.id}`, su);
  check(
    "superuser view: key_hash = sha256(key), the client-sent hash overwritten, no key",
    tup(s, r.key_hash === sha256(READ_KEY), r.key_hash === "deadbeef", "key" in r),
    tup(200, true, false, false),
  );
  await Bun.sleep(300);
  const created_events = sse.events.filter((e) => e?.action === "create");
  check(
    "realtime create events delivered to the owner carry no key or key_hash",
    tup(
      sse.absent_count(created_events.length),
      created_events.some((e) => "key" in e.record || "key_hash" in e.record),
    ),
    tup(2, false),
  );
  sse.stop = true;
  [s, r] = await api("PATCH", `${KEYS}/${read_rec.id}`, alice, { name: "alice read" });
  check(
    "update response carries no key",
    tup(s, "key" in r, "key_hash" in r),
    tup(200, false, false),
  );

  console.log("\n── key_hash is no filter oracle ──");
  const by = async (filter: string) => {
    const [st, l] = await api("GET", `${KEYS}?${urlencode({ filter })}`, alice);
    return tup(st, l.items?.length ?? null);
  };
  check(
    "filter key_hash = <the true hash> answers exactly as a wrong hash does",
    tup(await by(`key_hash='${sha256(READ_KEY)}'`), await by(`key_hash='${sha256("tmk_wrong")}'`)),
    tup(tup(400, null), tup(400, null)), // a non-superuser filter on a hidden field is refused outright
  );
  check(
    "filter key_hash != '' answers as key_hash = 'x'",
    tup(await by("key_hash!=''"), (await by("name!=''"))[1]! > 0),
    tup(await by("key_hash='x'"), true),
  );

  console.log("\n── create rule: a key is only ever minted for the caller ──");
  [s] = await mint(alice, "alice spoof", "write", { user: bob_id });
  check("Alice creates a key naming Bob as user → 400", s, 400);
  check("the refused spoof stored nothing", await stored_named("alice spoof"), 0);
  [s] = await mint("", "anon key", "write");
  check("anon creates a key → 400", s, 400);
  check("the refused anon create stored nothing", await stored_named("anon key"), 0);
  [s, r] = await mint(alice, "alice self", "read", { user: alice_id });
  check("Alice names herself as user → 200", tup(s, r.user ?? null), tup(200, alice_id));

  console.log("\n── owner-only: Bob cannot see or touch Alice's keys ──");
  [s, r] = await api("GET", KEYS, bob);
  check("Bob lists api_keys → only his own", tup(s, r.items?.length), tup(200, 1));
  check("Bob views Alice's key → 404", (await api("GET", `${KEYS}/${read_rec.id}`, bob))[0], 404);
  check(
    "Bob patches Alice's key → 404",
    (await api("PATCH", `${KEYS}/${read_rec.id}`, bob, { revoked: true }))[0],
    404,
  );
  check(
    "Bob deletes Alice's key → 404",
    (await api("DELETE", `${KEYS}/${read_rec.id}`, bob))[0],
    404,
  );
  [s, r] = await api("GET", KEYS);
  check("anon lists api_keys → 200 empty", tup(s, r.items?.length), tup(200, 0));

  console.log("\n── update rule: name and one-way revoke only ──");
  const stored = async (id: string) => (await api("GET", `${KEYS}/${id}`, su))[1];
  for (const [label, body, refused] of [
    ["scope → write", { scope: "write" }, true],
    ["scope+ → write", { "scope+": "write" }, true],
    ["expires → 2099", { expires: "2099-01-01 00:00:00.000Z" }, true],
    ["user → Bob", { user: bob_id }, true],
    // PB drops a hidden field from a non-superuser body, so this PATCH succeeds as a no-op.
    ["key_hash → x", { key_hash: "x" }, false],
  ] as [string, any, boolean][]) {
    const before = await stored(read_rec.id);
    [s] = await api("PATCH", `${KEYS}/${read_rec.id}`, alice, body);
    const after = await stored(read_rec.id);
    check(
      `Alice patches her read key's ${label} → ${refused ? "refused" : "200"}, stored row unchanged`,
      tup(
        before.scope,
        s >= 400,
        JSON.stringify({ ...after, updated: 0 }) === JSON.stringify({ ...before, updated: 0 }),
      ),
      tup("read", refused, true),
    );
  }
  [s, r] = await api("PATCH", `${KEYS}/${read_rec.id}`, alice, { name: "renamed" });
  check("Alice renames her key → 200", tup(s, r.name ?? null), tup(200, "renamed"));

  console.log("\n── a key authenticates as its owner ──");
  check("Alice's read key → whoami = Alice", await whoami(READ_KEY), alice_id);
  check(
    "Alice's key with a Bearer prefix → whoami = Alice",
    await whoami(`Bearer ${READ_KEY}`),
    alice_id,
  );
  check("Bob's key → whoami = Bob", await whoami(BOB_KEY), bob_id);
  [s, r] = await api("GET", WORKSPACES, WRITE_KEY);
  const alice_ws = (await api("GET", WORKSPACES, alice))[1].items?.map((w: any) => w.id).sort();
  const bob_ws = (await api("GET", WORKSPACES, bob))[1].items?.map((w: any) => w.id);
  check(
    "Alice's key lists exactly Alice's workspaces, none of Bob's",
    tup(
      s,
      r.items?.map((w: any) => w.id).sort(),
      r.items?.some((w: any) => bob_ws.includes(w.id)),
    ),
    tup(200, alice_ws, false),
  );
  const rounds = await Promise.all(
    Array.from({ length: 24 }, (_, i) => (i % 2 ? whoami(BOB_KEY) : whoami(WRITE_KEY))),
  );
  check(
    "24 concurrent requests alternating Alice's and Bob's keys each see their own owner",
    rounds.every((id, i) => id === (i % 2 ? bob_id : alice_id)),
    true,
  );
  check("a JWT is untouched by the key middleware → whoami = Alice", await whoami(alice), alice_id);
  check("no Authorization header → anon (whoami resolves nobody)", await whoami(""), null);

  console.log("\n── scope: a read key cannot write; a write key can ──");
  const ALICE_WS = alice_ws[0];
  check("read key GET workspaces → 200", (await api("GET", WORKSPACES, READ_KEY))[0], 200);
  check(
    "read key HEAD workspaces → 200",
    (await fetch(BASE_URL + WORKSPACES, { method: "HEAD", headers: { Authorization: READ_KEY } }))
      .status,
    200,
  );
  check(
    "read key POST workspaces → 403 api_key_scope",
    await refusal("POST", WORKSPACES, READ_KEY, { name: "read key ws" }),
    tup(403, "api_key_scope"),
  );
  check(
    "read key PATCH a workspace → 403 api_key_scope",
    await refusal("PATCH", `${WORKSPACES}/${ALICE_WS}`, READ_KEY, { name: "x" }),
    tup(403, "api_key_scope"),
  );
  check(
    "read key DELETE a workspace → 403 api_key_scope",
    await refusal("DELETE", `${WORKSPACES}/${ALICE_WS}`, READ_KEY),
    tup(403, "api_key_scope"),
  );
  check(
    "read key POST /api/tracker/notifications/read-all → 403 api_key_scope",
    await refusal("POST", "/api/tracker/notifications/read-all", READ_KEY, {}),
    tup(403, "api_key_scope"),
  );
  [s, r] = await api("POST", "/api/files/token", READ_KEY, {});
  check("read key POST /api/files/token → 200 with a token", tup(s, !!r.token), tup(200, true));
  const ks = new roomkit.SSEListener(BASE_URL, READ_KEY, "workspaces");
  await ks.start();
  check(
    "read key opens realtime and subscribes (POST /api/realtime)",
    await (ks as any)._subscribe(),
    204,
  );
  ks.stop = true;
  check(
    "read key GET /api/tracker/summary → 200",
    (await api("GET", "/api/tracker/summary", READ_KEY))[0],
    200,
  );
  [s, r] = await api("POST", WORKSPACES, WRITE_KEY, { name: "write key ws" });
  check(
    "write key POST workspaces → 200, owner = Alice",
    tup(s, r.owner ?? null),
    tup(200, alice_id),
  );
  check(
    "write key PATCH that workspace → 200",
    (await api("PATCH", `${WORKSPACES}/${r.id}`, WRITE_KEY, { name: "write key ws 2" }))[0],
    200,
  );
  // e.requestInfo() in the middleware would buffer and parse this before PB's body limit.
  const big = await fetch(BASE_URL + `${WORKSPACES}/${r.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: WRITE_KEY },
    body: "x".repeat(33 * 1024 * 1024),
  });
  await big.body?.cancel();
  check("write key PATCH with a body over the size limit → 413", big.status, 413);
  check(
    "read key POST /api/tracker/export → 200 (export only reads)",
    (await api("POST", "/api/tracker/export", READ_KEY, { workspace: ALICE_WS }))[0],
    200,
  );
  check(
    "write key POST /api/tracker/notifications/read-all → 200",
    (await api("POST", "/api/tracker/notifications/read-all", WRITE_KEY, {}))[0],
    200,
  );

  console.log("\n── auth and admin paths refuse every key → 403 api_key_path ──");
  const refused: [string, string, any][] = [
    ["POST", "/api/collections/users/auth-refresh", {}],
    [
      "POST",
      "/api/collections/users/auth-with-password",
      { identity: "alice@example.com", password: "test123456" },
    ],
    ["GET", "/api/collections/users/auth-methods", null],
    ["POST", "/api/collections/users/request-otp", { email: "alice@example.com" }],
    ["POST", "/api/collections/users/request-password-reset", { email: "alice@example.com" }],
    [
      "POST",
      "/api/collections/users/confirm-password-reset",
      { token: "x", password: "y", passwordConfirm: "y" },
    ],
    ["POST", "/api/collections/users/request-verification", { email: "alice@example.com" }],
    ["POST", "/api/collections/users/confirm-verification", { token: "x" }],
    ["POST", "/api/collections/users/request-email-change", { newEmail: "a2@example.com" }],
    ["POST", `/api/collections/users/impersonate/${alice_id}`, {}],
    ["POST", `/api/collections/_superusers/impersonate/${alice_id}`, {}],
    ["GET", "/api/collections/_superusers/records", null],
    ["GET", "/api/settings", null],
    ["GET", "/api/logs", null],
    ["GET", "/api/collections", null],
    ["GET", "/api/collections/api_keys", null],
    ["GET", "/api/backups", null],
    ["GET", "/api/crons", null],
    ["GET", "/api/health", null],
    [
      "POST",
      "/api/batch",
      { requests: [{ method: "POST", url: KEYS, body: { name: "via batch", scope: "write" } }] },
    ],
    ["GET", "/api/tracker/admin/pending-users", null],
    ["GET", KEYS, null],
    ["POST", KEYS, { name: "key minted by key", scope: "write" }],
    ["GET", `${KEYS}/${read_rec.id}`, null],
    ["PATCH", `${KEYS}/${read_rec.id}`, { revoked: true }],
    ["DELETE", `${KEYS}/${read_rec.id}`, null],
    ["GET", "/api/collections/API_KEYS/records", null],
    ["GET", "/api/collections/api%5Fkeys/records", null],
    ["GET", KEYS_BY_ID, null],
    ["POST", KEYS_BY_ID, { name: "key minted by id", scope: "write" }],
    ["PATCH", `${USERS}/${alice_id}`, { name: "Alice by key" }],
    ["DELETE", `${USERS}/${alice_id}`, null],
  ];
  for (const [m, url, body] of refused) {
    for (const [kname, key] of [
      ["write", WRITE_KEY],
      ["read", READ_KEY],
    ]) {
      check(
        `${kname} key ${m} ${url.replace(alice_id, "{alice}").replace(read_rec.id, "{key}")} → 403 api_key_path`,
        await refusal(m, url, key, body),
        tup(403, "api_key_path"),
      );
    }
  }
  check(
    "no key was minted by a key, by any route",
    (await stored_named("via batch")) +
      (await stored_named("key minted by key")) +
      (await stored_named("key minted by id")),
    0,
  );
  check(
    "Alice's name is unchanged by the refused key PATCH",
    (await api("GET", `${USERS}/${alice_id}`, su))[1].name,
    "Alice",
  );
  // Accepted limit (decision:api-keys): a key reads its owner key metadata, never key or hash.
  [s, r] = await api("GET", `${USERS}/${alice_id}?expand=api_keys_via_user`, READ_KEY);
  const via = r.expand?.api_keys_via_user ?? [];
  check(
    "a key expands its owner api_keys metadata via users (accepted limit, pinned)",
    tup(
      s,
      via.length > 0,
      via.some((k: any) => "key" in k || "key_hash" in k),
    ),
    tup(200, true, false),
  );
  const meta = new roomkit.SSEListener(BASE_URL, READ_KEY, "api_keys");
  await meta.start();
  check(
    "a key subscribes to api_keys realtime (accepted limit, pinned)",
    await (meta as any)._subscribe(),
    204,
  );
  meta.stop = true;
  check(
    "write key GET users/{alice} → 200 (users are read-only, not refused)",
    (await api("GET", `${USERS}/${alice_id}`, WRITE_KEY))[0],
    200,
  );

  console.log("\n── invalid keys → 401 api_key_invalid ──");
  const forged = `tmk_${"A".repeat(40)}`;
  check(
    "forged tmk_ key → 401",
    await refusal("GET", WORKSPACES, forged),
    tup(401, "api_key_invalid"),
  );
  check("bare tmk_ → 401", await refusal("GET", WORKSPACES, "tmk_"), tup(401, "api_key_invalid"));
  check(
    "forged key with Bearer prefix → 401",
    await refusal("GET", WORKSPACES, `Bearer ${forged}`),
    tup(401, "api_key_invalid"),
  );
  const [, exp_rec] = await mint(alice, "alice expired", "write", {
    expires: "2001-01-01 00:00:00.000Z",
  });
  check(
    "expired key → 401",
    await refusal("GET", WORKSPACES, exp_rec.key ?? "tmk_none"),
    tup(401, "api_key_invalid"),
  );
  const [, fut_rec] = await mint(alice, "alice future", "read", {
    expires: "2099-01-01 00:00:00.000Z",
  });
  check(
    "key expiring in the future → whoami = Alice",
    await whoami(fut_rec.key ?? "tmk_none"),
    alice_id,
  );
  const [, dave_rec] = await mint(dave, "dave read", "read");
  check(
    "Dave's key → whoami = Dave (control)",
    (await whoami(dave_rec.key ?? "tmk_none")) !== null,
    true,
  );
  [s] = await api("PATCH", `${USERS}/${dave_rec.user}`, su, { approved: false });
  check("superuser un-approves Dave → 200", s, 200);
  check(
    "an unapproved owner's key → 401",
    await refusal("GET", WORKSPACES, dave_rec.key ?? "tmk_none"),
    tup(401, "api_key_invalid"),
  );
  [s] = await api("PATCH", `${USERS}/${bob_id}`, su, {
    password: "changed123456",
    passwordConfirm: "changed123456",
  });
  check(
    "a key survives its owner password change (accepted limit, pinned)",
    tup(s, await whoami(BOB_KEY)),
    tup(200, bob_id),
  );
  [s, r] = await mint(su, "minted for bob", "read", { user: bob_id });
  check(
    "a superuser mints a key for the user it names → 200, owner = Bob, whoami = Bob",
    tup(s, r.user ?? null, await whoami(r.key ?? "tmk_none")),
    tup(200, bob_id, bob_id),
  );
  // Accepted limit (decision:api-keys): an open stream keeps the auth it subscribed with.
  const stream = new roomkit.SSEListener(BASE_URL, WRITE_KEY, "workspaces");
  await stream.start();
  check("write key subscribes to workspaces", await (stream as any)._subscribe(), 204);
  [s, r] = await api("PATCH", `${KEYS}/${write_rec.id}`, alice, { revoked: true });
  check("Alice revokes her write key → 200, revoked", tup(s, r.revoked ?? null), tup(200, true));
  [s, r] = await api("POST", WORKSPACES, alice, { name: "after revoke" });
  const after_revoke = async () =>
    stream.events.some((ev) => ev?.action === "create" && ev?.record?.id === r.id);
  const until = Date.now() + 5000;
  while (Date.now() < until && !(await after_revoke())) await Bun.sleep(100);
  check(
    "a stream opened before the revoke still delivers (accepted limit, pinned)",
    tup(s, await after_revoke()),
    tup(200, true),
  );
  check("the revoked key re-subscribing → 401", await (stream as any)._subscribe(), 401);
  stream.stop = true;
  check(
    "a doubled-slash api_keys path with a key → redirected, never served",
    (await api("GET", `/${KEYS.replace("/records", "//records")}`, READ_KEY))[0],
    307,
  );
  check(
    "revoked key → 401",
    await refusal("GET", WORKSPACES, WRITE_KEY),
    tup(401, "api_key_invalid"),
  );
  check(
    "revoked key on an admin path → 401",
    await refusal("GET", "/api/settings", WRITE_KEY),
    tup(401, "api_key_invalid"),
  );
  [s] = await api("PATCH", `${KEYS}/${write_rec.id}`, alice, { revoked: false });
  check("Alice un-revokes it → refused (404)", s, 404);
  check("it stays revoked", (await stored(write_rec.id)).revoked, true);
  check(
    "revoked key still → 401",
    await refusal("GET", WORKSPACES, WRITE_KEY),
    tup(401, "api_key_invalid"),
  );
  [s] = await api("DELETE", `${KEYS}/${fut_rec.id}`, alice);
  check("Alice deletes a key → 204", s, 204);
  check(
    "deleted key → 401",
    await refusal("GET", WORKSPACES, fut_rec.key ?? "tmk_none"),
    tup(401, "api_key_invalid"),
  );
  [, r] = await api("GET", WORKSPACES, forged);
  check("a 401 message never echoes the key", JSON.stringify(r).includes(forged.slice(4)), false);

  console.log("\n── no key reaches /api/logs or the database ──");
  const marker = `m${Date.now()}`;
  await api("GET", `${WORKSPACES}?probe=${marker}ok`, READ_KEY); // success
  await api("GET", `${WORKSPACES}?probe=${marker}revoked`, WRITE_KEY); // 401
  await api("POST", `${WORKSPACES}?probe=${marker}scope`, READ_KEY, { name: "x" }); // 403 scope
  await api("GET", `/api/settings?probe=${marker}path`, READ_KEY); // 403 path
  const want = ["ok", "revoked", "scope", "path"].map((k) => marker + k);
  const deadline = Date.now() + 15000;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    const [, lg] = await api(
      "GET",
      `/api/logs?${urlencode({ filter: `data.url~'${marker}'`, perPage: 50 })}`,
      su,
    );
    seen = want.filter((w) => (lg.items ?? []).some((i: any) => (i.data?.url ?? "").includes(w)));
    if (seen.length === want.length) break;
    await Bun.sleep(250);
  }
  check("positive control: all four key requests reached /api/logs", seen, want);
  const all: any[] = [];
  for (let page = 1; ; page++) {
    const [, lg] = await api("GET", `/api/logs?${urlencode({ page, perPage: 500 })}`, su);
    all.push(...(lg.items ?? []));
    if (!lg.items?.length || page >= (lg.totalPages ?? 1)) break;
  }
  const log_json = JSON.stringify(all);
  check("the logs are non-trivial (control)", all.length > 50, true);
  for (const [kname, key] of [
    ["read", READ_KEY],
    ["revoked", WRITE_KEY],
    ["Bob", BOB_KEY],
    ["forged", forged],
  ]) {
    check(
      `/api/logs carries neither the ${kname} key nor its secret part`,
      tup(key.length > 4, log_json.includes(key), log_json.includes(key.slice(4))),
      tup(true, false, false),
    );
  }
  const db_bytes = ["data.db", "data.db-wal", "auxiliary.db", "auxiliary.db-wal"]
    .map((f) => path.join(DATA_DIR, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f).toString("latin1"))
    .join("");
  check(
    "the database files hold the hash (control)",
    READ_KEY !== "" && db_bytes.includes(sha256(READ_KEY)),
    true,
  );
  check(
    "the database files hold no key's secret part",
    [READ_KEY, WRITE_KEY, BOB_KEY].some((k) => k.length <= 4 || db_bytes.includes(k.slice(4))),
    false,
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
  console.log("✅ all api-keys proofs passed");
  process.exit(0);
}

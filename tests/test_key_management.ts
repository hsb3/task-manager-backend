#!/usr/bin/env bun
/**
 * decision:api-keys: manage_keys and last_used are server-written key fields.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8220 + PB_PORT_OFFSET.
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
const PORT = 8220 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const USERS = "/api/collections/users/records";
const LOCKED = "manage_keys and last_used are set only at create or by the server.";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-key-management-test-"));
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
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  console.log("\n── fixtures: Alice and Bob, verified and approved, signed in by password ──");
  const person = async (name: string): Promise<{ id: string; token: string }> => {
    const email = `${name.toLowerCase()}@example.com`;
    const [st, rec] = await api("POST", USERS, su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`(fixture) ${name} created`, st, 200);
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: "test123456",
    });
    return { id: rec.id ?? "", token: auth.token ?? "" };
  };
  const alice = await person("Alice");
  await person("Bob");
  const view = async (id: string) => (await api("GET", `${KEYS}/${id}`, su))[1];

  console.log("\n── manage_keys and last_used ──");
  const [s1, own] = await api("POST", KEYS, alice.token, {
    name: "a",
    scope: "read",
    manage_keys: true,
  });
  check(
    "session create ignores manage_keys → 200, manage_keys false, last_used empty",
    tup(s1, own.manage_keys, own.last_used),
    tup(200, false, ""),
  );
  const [s2, mk] = await api("POST", KEYS, su, {
    user: alice.id,
    name: "m",
    scope: "read",
    manage_keys: true,
  });
  check("superuser create keeps manage_keys → 200, true", tup(s2, mk.manage_keys), tup(200, true));

  const before = await view(own.id);
  check(
    "update refuses manage_keys → 404, record unchanged",
    tup(
      (await api("PATCH", `${KEYS}/${own.id}`, alice.token, { manage_keys: true }))[0],
      (await view(own.id)).manage_keys,
    ),
    tup(404, false),
  );
  check(
    "update refuses last_used → 404",
    (
      await api("PATCH", `${KEYS}/${own.id}`, alice.token, {
        last_used: "2020-01-01 00:00:00.000Z",
      })
    )[0],
    404,
  );
  const [s3, r3] = await api("PATCH", `${KEYS}/${mk.id}`, su, { manage_keys: false });
  check(
    "superuser update of manage_keys → 400 with the lock message",
    tup(s3, r3.message),
    tup(400, LOCKED),
  );
  const [s4, r4] = await api("PATCH", `${KEYS}/${mk.id}`, su, {
    last_used: "2020-01-01 00:00:00.000Z",
  });
  check(
    "superuser update of last_used → 400 with the lock message",
    tup(s4, r4.message),
    tup(400, LOCKED),
  );
  const [sb] = await api("POST", "/api/batch", su, {
    requests: [
      { method: "PATCH", url: `${KEYS}/${own.id}`, body: { name: "batch renamed" } },
      { method: "PATCH", url: `${KEYS}/${mk.id}`, body: { manage_keys: false } },
    ],
  });
  check(
    "superuser batch with one manage_keys change → 400, nothing committed",
    tup(sb, (await view(own.id)).name, (await view(mk.id)).manage_keys),
    tup(400, "a", true),
  );
  const [s6, r6] = await api("PATCH", `${KEYS}/${mk.id}`, su, { bogus: 1, manage_keys: false });
  check(
    "superuser update with an unknown key → 400 unknown field answers first",
    tup(s6, r6.message === LOCKED),
    tup(400, false),
  );
  check(
    "superuser rename of the same key → 200",
    (await api("PATCH", `${KEYS}/${mk.id}`, su, { name: "renamed" }))[0],
    200,
  );
  check(
    "superuser save resending unchanged manage_keys → 200",
    (await api("PATCH", `${KEYS}/${mk.id}`, su, { manage_keys: true, name: "m" }))[0],
    200,
  );

  check(
    "(fixture) Alice's key calls /api/tracker/me",
    (await api("GET", "/api/tracker/me", own.key))[0],
    200,
  );
  let used = await view(own.id);
  const deadline = Date.now() + 2000;
  while (!used.last_used && Date.now() < deadline) {
    await sleep(100);
    used = await view(own.id);
  }
  check(
    "last_used set on use, updated unchanged",
    tup(!!used.last_used, !!before.updated && used.updated === before.updated),
    tup(true, true),
  );
  await sleep(1000);
  check(
    "(fixture) second request a second later",
    (await api("GET", "/api/tracker/me", own.key))[0],
    200,
  );
  const again = (await view(own.id)).last_used;
  check(
    "last_used throttled: unchanged by the second request",
    tup(!!again, again === used.last_used),
    tup(true, true),
  );

  const [, mine] = await api("GET", "/api/tracker/me", mk.key);
  const [, plain] = await api("GET", "/api/tracker/me", own.key);
  check(
    "me reports manage_keys: true for the superuser-made key, false for Alice's own",
    tup(mine.key?.manage_keys, plain.key?.manage_keys),
    tup(true, false),
  );

  const [, unused] = await api("POST", KEYS, alice.token, { name: "never used", scope: "read" });
  check(
    "(fixture) Alice revokes a key never used",
    (await api("PATCH", `${KEYS}/${unused.id}`, alice.token, { revoked: true }))[0],
    200,
  );
  const [s5, r5] = await api("GET", "/api/tracker/me", unused.key);
  await sleep(500);
  check(
    "revoked key leaves last_used: 401 api_key_invalid, last_used still empty",
    tup(s5, r5.data?.api_key?.code, (await view(unused.id)).last_used),
    tup(401, "api_key_invalid", ""),
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
  console.log("✅ all key-management proofs passed");
  process.exit(0);
}

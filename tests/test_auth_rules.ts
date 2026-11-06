#!/usr/bin/env bun
/**
 * E2E test of the users auth collection (Module 6). Proves the policy from the outside:
 * open signup, verified-only login, case-insensitive login identity, any-authenticated
 * profile visibility, hidden emails, assignee expand. Needs superuser creds from .env to
 * flip `verified` and clean up.
 */

import { randomBytes } from "node:crypto";
import { getitem, py_repr, py_str, tup, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { load_env } from "./suitekit.ts";

// Load PB_* vars from the gitignored .env so no secret is hard-coded here.
load_env();

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;

let failures = 0;

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  let raw: string;
  try {
    r = await fetch(PB + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(PB, e);
  }
  if (!r.ok) return [r.status, JSON.parse(raw || "{}")];
  if (r.status === 204) return [204, {}];
  return [r.status, JSON.parse(raw)];
}

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  const tag = ok ? "✅" : "❌ MISMATCH";
  console.log(`  ${tag}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<string | null> {
  // No hard-coded ids — a re-seed regenerates every id, so always read back live.
  const qs = urlencode({ filter: `${field}='${value}'` });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? getitem(items[0], "id") : null;
}

const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
let [s, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su = roomkit.token_of(PB, SU_EMAIL, r);

[, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: "alice@example.com",
  password: "test123456",
});
const [alice, ALICE_ID] = [
  roomkit.token_of(PB, "alice@example.com", r),
  getitem(getitem(r, "record"), "id"),
];

// Superuser bypasses emailVisibility — used only to resolve Bob's id, not his token.
const BOB_ID = await find_id("users", "email", "bob@example.com", su);

const throwaway = `tmp-${randomBytes(4).toString("hex")}@example.com`;

// COVERS: rule:users.create
console.log('\n── SIGNUP is open (createRule ""), but accounts start unverified ──');
[s, r] = await api("POST", "/api/collections/users/records", null, {
  email: throwaway,
  password: "test123456",
  passwordConfirm: "test123456",
  name: "Throwaway",
});
check("anonymous signup", s, 200);
check("new account verified flag", r.verified, false);
const tmp_id = getitem(r, "id");

// COVERS: rule:users.auth
console.log("\n── LOGIN requires verified = true AND approved = true (authRule, #30) ──");
[s] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "test123456",
});
check("unverified login", s, 403);
[s] = await api("PATCH", `/api/collections/users/records/${tmp_id}`, su, { verified: true });
check("superuser flips verified", s, 200);
// verified alone isn't enough post-#30 — approved=true is also required (superuser-only).
[s] = await api("PATCH", `/api/collections/users/records/${tmp_id}`, su, { approved: true });
check("superuser flips approved", s, 200);
[s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "test123456",
});
check("verified+approved login", s, 200);
[s] = await api("POST", "/api/collections/users/auth-refresh", roomkit.token_of(PB, throwaway, r));
check("auth-refresh with fresh token", s, 200);

// COVERS: rule:users.list, rule:users.view
console.log("\n── PROFILES visible to any authenticated user; emails stay hidden ──");
[s, r] = await api("GET", "/api/collections/users/records", alice);
check("alice lists users (sees everyone)", getitem(r, "totalItems") >= 3, true);
[s, r] = await api("GET", `/api/collections/users/records/${BOB_ID}`, alice);
check("alice views bob", s, 200);
check("bob's email hidden (emailVisibility=false)", truthy(r.email), false);
[s, r] = await api("GET", `/api/collections/users/records/${ALICE_ID}`, alice);
check("alice sees her OWN email", truthy(r.email), true);
[s, r] = await api("GET", "/api/collections/users/records"); // anonymous
check("anon list users (rule filters to empty)", tup(s, getitem(r, "totalItems")), tup(200, 0));

// COVERS: rule:users.view
console.log("\n── EXPAND across users now works (viewRule no longer self-only) ──");
[, r] = await api("GET", "/api/collections/tasks/records?expand=assignee", alice);
const names = new Set<string>(
  getitem(r, "items")
    .filter((t: any) => truthy((t.expand ?? {}).assignee))
    .map((t: any) => getitem(getitem(getitem(t, "expand"), "assignee"), "name")),
);
check("alice sees other assignees via expand", names.has("Bob"), true);

// COVERS: hook:auth_identity.pb.js#onRecordAuthWithPasswordRequest:users
console.log("\n── LOGIN identity is case-insensitive ──");

async function login(identity: string, password: string): Promise<[number, any]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity,
    password,
  });
  // 429 = the room's 10/60s auth cap ran out, not a policy answer — a silent read of it
  // as one of the expected 400s would turn this whole section green for the wrong reason.
  if (s === 429) {
    console.log(`❌ ABORT — rate limited on login as ${py_repr(identity)}; auth budget exhausted`);
    process.exit(1);
  }
  return [s, r];
}

async function mkuser(email: string, password: string, name: string): Promise<string> {
  const [s, r] = await api("POST", "/api/collections/users/records", su, {
    email,
    password,
    passwordConfirm: password,
    name,
    verified: true,
    approved: true,
  });
  check(`superuser creates ${name}`, s, 200);
  return r.id;
}

const tag = randomBytes(4).toString("hex");
// The address is STORED lowercased, so the exact-case login below is the
// one PB's own BINARY lookup misses — the hook's LOWER() retry is what answers it. The
// other arm, an AMBIGUOUS case-duplicate pair, can no longer be minted over the API at
// all and is proven against a directly-written legacy row in tests/test_signup.ts (h4).
const mixed_id = await mkuser(`Mixed${tag}@Example.com`, "test123456", "case fixture");

[s] = await login(`Mixed${tag}@Example.com`, "test123456");
check("exact-case identity + correct password", s, 200);
[s, r] = await login(`mixed${tag}@example.com`, "test123456");
check("wrong-cased identity + correct password", s, 200);
check("wrong-cased login issues a token", truthy(r.token), true);
[s] = await login(`mixed${tag}@example.com`, "wrongwrong");
check("wrong-cased identity + WRONG password", s, 400);
[s] = await login(`NOBODY${tag}@EXAMPLE.COM`, "test123456");
check("nonexistent identity, any case", s, 400);

[s] = await api("DELETE", `/api/collections/users/records/${mixed_id}`, su);
check("cleanup: superuser deletes case fixture", s, 204);

[s] = await api("DELETE", `/api/collections/users/records/${tmp_id}`, su);
check("cleanup: superuser deletes throwaway user", s, 204);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
}

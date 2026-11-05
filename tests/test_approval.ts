#!/usr/bin/env bun
/**
 * E2E test of the signup-approval gate (#30): authRule requires verified=true &&
 * approved=true, and createRule/updateRule block self-approval via
 * `@request.body.approved:isset`. Needs superuser creds from .env.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { py_str, py_strip, read_text } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

// Load PB_* vars from the gitignored .env so no secret is hard-coded here.
function load_env(path = ".env"): void {
  if (fs.existsSync(path)) {
    for (let line of read_text(path).split(/\r\n|\r|\n/)) {
      line = py_strip(line);
      if (line && !line.startsWith("#") && line.includes("=")) {
        const i = line.indexOf("=");
        const k = line.slice(0, i);
        const v = line.slice(i + 1);
        if (!(k in process.env)) process.env[k] = v;
      }
    }
  }
}

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

const token_hex = (n: number): string => randomBytes(n).toString("hex");

// ── Superuser auth ────────────────────────────────────────────────────────────
const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
let s: number;
let r: any;
[, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su = roomkit.token_of(PB, SU_EMAIL, r);

const throwaway = `appr-${token_hex(4)}@example.com`;

// COVERS: rule:users.create
console.log("\n── (a) SIGNUP with no `approved` in the body starts unapproved ──");
[s, r] = await api("POST", "/api/collections/users/records", null, {
  email: throwaway,
  password: "test123456",
  passwordConfirm: "test123456",
  name: "Approval Throwaway",
});
check("anonymous signup", s, 200);
check("new account approved flag", r.approved ?? null, false);
check("new account verified flag", r.verified ?? null, false);
const tmp_id = r.id ?? null;

console.log("\n── (b)/(c) createRule blocks ANY `approved` key in the signup body ──");
// isset is true for both approved:true and approved:false — presence alone blocks.
[s] = await api("POST", "/api/collections/users/records", null, {
  email: `appr-${token_hex(4)}@example.com`,
  password: "test123456",
  passwordConfirm: "test123456",
  name: "Sneaky True",
  approved: true,
});
check("signup with approved:true", s, 400);
[s] = await api("POST", "/api/collections/users/records", null, {
  email: `appr-${token_hex(4)}@example.com`,
  password: "test123456",
  passwordConfirm: "test123456",
  name: "Sneaky False",
  approved: false,
});
check("signup with approved:false", s, 400);

// COVERS: rule:users.auth
console.log("\n── (d) LOGIN still 403s with verified=true but approved=false ──");
[s] = await api("PATCH", `/api/collections/users/records/${tmp_id}`, su, { verified: true });
check("superuser flips verified only", s, 200);
[s] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "test123456",
});
check("verified-but-unapproved login", s, 403);

console.log("\n── (e)/(h) superuser CAN set approved (bypasses the isset rule) ──");
[s] = await api("PATCH", `/api/collections/users/records/${tmp_id}`, su, { approved: true });
check("superuser-bypass: PATCH approved=true", s, 200);
[s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "test123456",
});
check("verified+approved login", s, 200);
const user_token = roomkit.token_of(PB, throwaway, r);

// COVERS: rule:users.update
console.log("\n── (f) updateRule blocks SELF-approval by the authenticated user ──");
[s] = await api("PATCH", `/api/collections/users/records/${tmp_id}`, user_token, {
  approved: true,
});
check("self-PATCH approved:true", s, 404);

console.log("\n── (g) normal self-edit (no `approved` key) still works ──");
[s] = await api("PATCH", `/api/collections/users/records/${tmp_id}`, user_token, {
  name: "Approved Renamed",
});
check("self-PATCH name only", s, 200);

// COVERS: rule:users.manage
console.log("\n── (i) manageRule is null — no OTHER user can manage this account ──");
[, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: "alice@example.com",
  password: "test123456",
});
const alice_token = roomkit.token_of(PB, "alice@example.com", r);
[s] = await api("PATCH", `/api/collections/users/records/${tmp_id}`, alice_token, {
  verified: false,
});
check(
  "alice (non-owner) PATCH verified on ANOTHER user's account (null manageRule, no escape)",
  s,
  404,
);

console.log("\n── CLEANUP ──");
[s] = await api("DELETE", `/api/collections/users/records/${tmp_id}`, su);
check("cleanup: superuser deletes throwaway user", s, 204);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
}

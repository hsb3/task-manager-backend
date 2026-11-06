#!/usr/bin/env bun
/**E2E proof of the module-18 production-hardening settings: request rate limiting
(with a superuser bypass), /api/batch (per-op status, atomic rollback, guest
denial), and the MFA/OTP flow on `_superusers`.

Needs PB_URL, .env (PB_SUPERUSER_EMAIL/PASSWORD), and PB_MAILDIR (a running SMTP
sink's maildir, smtp pointed at 127.0.0.1:2527 + PB_PORT_OFFSET) — the battery's
hardening room provides all three. A missing maildir, an undelivered OTP or an
unobtainable superuser token is a FAILURE of this suite, never a skipped section.
 */

import fs from "node:fs";
import * as roomkit from "./roomkit.ts";
import { load_env } from "./suitekit.ts";
import {
  getitem,
  by_code_point,
  decode_text,
  glob_sorted,
  py_repr,
  py_str,
  quopri_decodestring,
  SystemExit,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";

// Load PB_* vars from the gitignored .env so no secret is hard-coded here.
load_env();

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;
const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
const MAILDIR = process.env.PB_MAILDIR;
const SINK_PORT = process.env.PB_SINK_PORT ?? String(2527 + PORT_OFFSET);
const APP_URL = process.env.PB_PUBLIC_URL ?? "http://127.0.0.1:8090";

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(PB + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 → empty body
}

async function burst(
  method: string,
  path: string,
  n: number,
  token: string | null = null,
  body: any = null,
): Promise<[number, any][]> {
  const out: [number, any][] = [];
  for (let i = 0; i < n; i++) out.push(await api(method, path, token, body));
  return out;
}

const FAILS: string[] = [];

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`,
  );
}

function check_in(label: string, got: any, allowed: any[]): void {
  const ok = allowed.some((a) => Bun.deepEquals(got, a, true));
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (expected one of ${py_str(tup(...allowed))})`,
  );
}

if (!MAILDIR) {
  throw new SystemExit(
    `❌ PB_MAILDIR is unset — this suite cannot read the _superusers OTP back and ` +
      `every superuser-gated proof would be unproven. Start an SMTP sink on ` +
      `127.0.0.1:${SINK_PORT} and point PB_MAILDIR at its maildir (see the hardening ` +
      `room in scripts/run_suite_battery.sh).`,
  );
}

console.log(`(PB_MAILDIR=${MAILDIR}, sink expected on 127.0.0.1:${SINK_PORT})`);

// ── SUPERUSER AUTH / MFA: _superusers has MFA enabled on this room ──
console.log("\n── MFA CHALLENGE: _superusers/auth-with-password alone is insufficient ──");
let s: number;
let r: any;
[s, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
check(
  "superuser auth-with-password → 401 + mfaId (MFA enforced)",
  tup(s, Object.hasOwn(r, "mfaId")),
  tup(401, true),
);
const mfa_id = r.mfaId ?? null;

if (!truthy(mfa_id)) {
  throw new SystemExit("❌ auth-with-password returned no mfaId — is the MFA migration applied?");
}

console.log("\n── MFA: request-otp (expect 200 + otpId, email sent to the sink) ──");
let before: any = new Set(glob_sorted(MAILDIR, ".eml"));
[s, r] = await api("POST", "/api/collections/_superusers/request-otp", null, { email: SU_EMAIL });
check("request-otp → 200 + otpId", tup(s, Object.hasOwn(r, "otpId")), tup(200, true));
const otp_id = r.otpId ?? null;
if (!truthy(otp_id)) {
  throw new SystemExit(
    `❌ request-otp returned no otpId (${s}) — the OTP proofs below are unprovable`,
  );
}

console.log("\n── MFA: capture OTP from the sink's maildir, then auth-with-otp ──");
let code: string | null = null;
for (let _ = 0; _ < 20; _++) {
  const new_files = glob_sorted(MAILDIR, ".eml").filter((f) => !before.has(f));
  if (new_files.length) {
    const raw = fs.readFileSync(new_files.sort(by_code_point).at(-1)!);
    const txt = decode_text(quopri_decodestring(raw), "replace");
    // \b(\d{8})\b with Python's Unicode-aware \d and \b
    const m = /(?<![\p{L}\p{N}_])(\p{Nd}{8})(?![\p{L}\p{N}_])/u.exec(txt);
    if (m) {
      code = m[1]!;
      break;
    }
  }
  await Bun.sleep(500);
}
if (!code) {
  throw new SystemExit(
    `❌ no .eml carrying an 8-digit code reached PB_MAILDIR (${MAILDIR}) within 10s — ` +
      `is the SMTP sink on 127.0.0.1:${SINK_PORT} running and is smtp pointed at it?`,
  );
}
[s, r] = await api("POST", "/api/collections/_superusers/auth-with-otp", null, {
  otpId: otp_id,
  password: code,
  mfaId: mfa_id,
});
check(
  "auth-with-otp with sink-captured code → 200 + token",
  tup(s, truthy(r.token)),
  tup(200, true),
);
const su_token = r.token;
if (!truthy(su_token)) {
  throw new SystemExit(
    `❌ auth-with-otp returned no token (${s}) — every superuser proof below would go unproven`,
  );
}

console.log("\n── MFA: wrong code is rejected ──");
[s, r] = await api("POST", "/api/collections/_superusers/auth-with-otp", null, {
  otpId: otp_id,
  password: "00000000",
  mfaId: mfa_id,
});
check("auth-with-otp with a wrong code → 400", s, 400);

// ── mail.pb.js: appURL boot-hook line fires even with RESEND_API_KEY unset ──
// This room boots WITHOUT RESEND_API_KEY (run_suite_battery.sh's hard_room) — the
// only room in the battery that proves the PB_PUBLIC_URL line is independent of the
// SMTP guard, not accidentally nested inside it.
console.log("\n── mail.pb.js: settings.meta.appURL set independent of RESEND_API_KEY ──");
[s, r] = await api("GET", "/api/settings", su_token);
check("GET /api/settings", s, 200);
check(
  "meta.appURL set from PB_PUBLIC_URL fallback (RESEND unset)",
  (r.meta === undefined ? {} : r.meta).appURL,
  APP_URL,
);

// ── RATE LIMIT: guest burst trips 429 at the cap ──
console.log("\n── RATE LIMIT: guest burst on users/auth-with-password (cap 10/60s) ──");
const bad = { identity: "nobody@example.com", password: "wrongwrong" };
const guest_results = await burst(
  "POST",
  "/api/collections/users/auth-with-password",
  13,
  null,
  bad,
);
const guest_codes = guest_results.map(([c]) => c);
console.log(`  guest burst codes: ${py_str(guest_codes)}`);
check(
  "guest burst: early requests (under the cap) are not 429",
  guest_codes.slice(0, 8).some((c) => c !== 429),
  true,
);
check(
  "guest burst: trips 429 somewhere in the burst",
  guest_codes.some((c) => c === 429),
  true,
);
const limited = guest_results.find(([c]) => c === 429);
const limited_body = limited ? limited[1] : null;
if (limited_body !== null) {
  // Body also carries an empty "data": {} — assert load-bearing fields only.
  check("429 response message", limited_body.message, "Too Many Requests.");
  check("429 response status field", limited_body.status, 429);
}

// ── RATE LIMIT BYPASS: superuser burst on the SAME (already-exhausted) endpoint ──
console.log("\n── RATE LIMIT BYPASS: superuser burst on the same exhausted endpoint ──");
const su_results = await burst(
  "POST",
  "/api/collections/users/auth-with-password",
  13,
  su_token,
  bad,
);
const su_codes = su_results.map(([c]) => c);
console.log(`  superuser burst codes: ${py_str(su_codes)}`);
check(
  "superuser burst: never 429 (bypasses the limiter)",
  su_codes.some((c) => c === 429),
  false,
);

// ── BATCH: guest — outer 400, inner op 403 (app_docs is superuser-only to write) ──
// COVERS: rule:app_docs.create
console.log("\n── BATCH: guest create against app_docs (superuser-only) — outer 400, inner 403 ──");
const [sg, rg] = await api("POST", "/api/batch", null, {
  requests: [
    {
      method: "POST",
      url: "/api/collections/app_docs/records",
      body: { slug: "concept:batchtest-guest", title: "G", body: "g" },
    },
  ],
});
check("guest batch → outer 400", sg, 400);

function batch_inner_response(resp: any): [any, any] {
  // A succeeding batch returns a list of {status, body} per op; a failing batch
  // returns {"data": {"requests": {"<idx>": {"response": {...}}}}}. Handle both.
  if (Array.isArray(resp)) {
    const op = resp.length ? resp[0] : {};
    return [op.status, (truthy(op.body) ? op.body : {}).message];
  }
  const is_dict = (x: any): boolean => x !== null && typeof x === "object" && !Array.isArray(x);
  const reqs = is_dict(resp) ? (truthy(resp.data) ? resp.data : {}).requests : null;
  let first: any;
  if (is_dict(reqs)) first = Object.values(reqs)[0] ?? {};
  else if (Array.isArray(reqs)) first = reqs.length ? reqs[0] : {};
  else first = {};
  const inner = truthy(first.response) ? first.response : truthy(first.body) ? first.body : {};
  return [inner.status, inner.message];
}

const [guest_inner_status, guest_inner_message] = batch_inner_response(rg);
check("guest batch → inner op 403", guest_inner_status, 403);
check(
  "guest batch inner op message mentions superusers",
  (truthy(guest_inner_message) ? guest_inner_message : "").toLowerCase().includes("superuser"),
  true,
);

// ── BATCH: superuser — per-op 200, atomic rollback on a duplicate unique field ──
console.log("\n── BATCH: superuser 2 valid app_docs creates — outer 200, per-op 200 ──");
[s, r] = await api("POST", "/api/batch", su_token, {
  requests: [
    {
      method: "POST",
      url: "/api/collections/app_docs/records",
      body: { slug: "concept:batchtest-a", title: "A", body: "a" },
    },
    {
      method: "POST",
      url: "/api/collections/app_docs/records",
      body: { slug: "concept:batchtest-b", title: "B", body: "b" },
    },
  ],
});
check("batch: 2 valid app_docs creates → outer 200", s, 200);
const inner: any[] = Array.isArray(r) ? r : r.requests === undefined ? [] : r.requests;
check_in("batch: per-op status[0]", inner.length > 0 ? inner[0].status : null, [200, 201]);
check_in("batch: per-op status[1]", inner.length > 1 ? inner[1].status : null, [200, 201]);

console.log("\n── BATCH: atomic rollback — 1 valid + 1 duplicate-slug create ──");
let c: any;
[, c] = await api("GET", "/api/collections/app_docs/records?perPage=1", su_token);
before = getitem(c, "totalItems");
let s2: number;
let r2: any;
[s2, r2] = await api("POST", "/api/batch", su_token, {
  requests: [
    {
      method: "POST",
      url: "/api/collections/app_docs/records",
      body: { slug: "concept:batchtest-c", title: "C", body: "c" },
    },
    {
      method: "POST",
      url: "/api/collections/app_docs/records",
      body: {
        slug: "concept:batchtest-a",
        title: "dup",
        body: "dup",
      },
    },
  ],
});
check("batch: 1 valid + 1 duplicate-slug → outer 400", s2, 400);
const [, c2] = await api("GET", "/api/collections/app_docs/records?perPage=1", su_token);
const after = getitem(c2, "totalItems");
check("batch: atomic rollback — record count unchanged", after, before);

console.log("\n── cleanup: batch-created app_docs (concept:batchtest-*) ──");
const qs = urlencode({ filter: "slug~'batchtest-'", perPage: 200 });
const [, all_docs] = await api("GET", `/api/collections/app_docs/records?${qs}`, su_token);
for (const item of all_docs.items ?? []) {
  const [ds] = await api("DELETE", `/api/collections/app_docs/records/${item.id}`, su_token);
  check(`cleanup: deleted ${py_str(item.slug)}`, ds, 204);
}

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} FAILED: ${py_str(FAILS)}`);
  process.exit(1);
}
console.log("✅ all hardening proofs passed");
process.exit(0);

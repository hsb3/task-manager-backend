#!/usr/bin/env bun
/**
 * hosted-mcp-endpoint rate limits: a request carrying the MCP service's secret (X-TM-Internal) is
 * exempt from every per-address rule, a forged sentinel X-Real-IP is still counted, an unset
 * secret exempts nothing, and /oauth/ is limited to 30 per minute per address.
 *
 * Fully self-contained clean-room server. Port 8200 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8200 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const SECRET = "s3cret";

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

/** The statuses of `n` sequential GETs of `url` with the given headers. */
async function statuses(
  n: number,
  url: string,
  headers: Record<string, string>,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(BASE_URL + url, { headers });
    await r.body?.cancel();
    out.push(r.status);
  }
  return out;
}

async function superuser(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  if (!r.token) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(r)}`);
  return r.token;
}

const TEST_RULES = [
  { label: "/api/health", maxRequests: 3, duration: 60, audience: "" },
  { label: "/api/collections/users/records", maxRequests: 3, duration: 60, audience: "" },
];

/** PATCHes the rules read back from the room plus TEST_RULES; returns the rules it read. */
async function add_test_rules(su: string): Promise<any[]> {
  const [, settings] = await api("GET", "/api/settings", su);
  const rules = settings.rateLimits.rules;
  const [s] = await api("PATCH", "/api/settings", su, {
    rateLimits: { ...settings.rateLimits, rules: [...rules, ...TEST_RULES] },
  });
  check("fixture: superuser adds the two 3-per-minute test rules → 200", s, 200);
  return rules;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-internal-caller-test-"));
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
  const HOOKS = roomkit.hooks_dir(S);
  process.env.MCP_INTERNAL_SECRET = SECRET;
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, HOOKS);
  let su = await superuser();

  console.log("\n── the migration excludes the sentinel and limits /oauth/ ──");
  const [, settings] = await api("GET", "/api/settings", su);
  const oauth = (settings.rateLimits?.rules ?? []).find((r: any) => r.label === "/oauth/");
  check(
    "settings_migrated: excludedIPs has 192.0.2.254; /oauth/ is 30 per 60 s",
    [
      (settings.rateLimits?.excludedIPs ?? []).includes("192.0.2.254"),
      oauth?.maxRequests,
      oauth?.duration,
    ],
    [true, 30, 60],
  );
  const original_rules = await add_test_rules(su);

  console.log("\n── the secret exempts; anything else is counted ──");
  check(
    "exempt_with_secret: 6× /api/health with the secret → all 200",
    await statuses(6, "/api/health", { "X-TM-Internal": SECRET, "X-Real-IP": "203.0.113.10" }),
    [200, 200, 200, 200, 200, 200],
  );
  check(
    "counted_without_secret: 6× /api/health → 200 200 200 429 429 429",
    await statuses(6, "/api/health", { "X-Real-IP": "203.0.113.11" }),
    [200, 200, 200, 429, 429, 429],
  );
  check(
    "wrong_secret_counted: 6× /api/health with a wrong secret → three 200 then 429",
    await statuses(6, "/api/health", { "X-TM-Internal": "nope", "X-Real-IP": "203.0.113.12" }),
    [200, 200, 200, 429, 429, 429],
  );
  check(
    "forged_sentinel_counted: 6× /api/health from X-Real-IP 192.0.2.254 → three 200 then 429",
    await statuses(6, "/api/health", { "X-Real-IP": "192.0.2.254" }),
    [200, 200, 200, 429, 429, 429],
  );
  const listed = await statuses(6, "/api/collections/users/records", {
    "X-Real-IP": "1.1.1.1, 192.0.2.254",
  });
  check(
    "forged_sentinel_list_counted: 6× users records, X-Real-IP list naming the sentinel",
    [listed.slice(0, 3).every((s) => s !== 429), listed.slice(3)],
    [true, [429, 429, 429]],
  );
  const oauth_run = await statuses(31, "/oauth/nothing", { "X-Real-IP": "203.0.113.13" });
  check(
    "oauth_rule_counts: 31× /oauth/nothing → 30 × 404, then 429",
    [oauth_run.slice(0, 30).every((s) => s === 404), oauth_run[30]],
    [true, 429],
  );

  console.log("\n── second boot: an unset secret exempts nothing ──");
  // Restore the rules first so the next boot's health polls from 127.0.0.1 are not limited.
  const [s_restore] = await api("PATCH", "/api/settings", su, {
    rateLimits: { ...settings.rateLimits, rules: original_rules },
  });
  check("fixture: superuser restores the migrated rules → 200", s_restore, 200);
  await roomkit.stop(server);
  server = null;
  delete process.env.MCP_INTERNAL_SECRET;
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, HOOKS);
  su = await superuser();
  await add_test_rules(su);
  check(
    "unset_secret_counted: 6× /api/health with the secret → three 200 then 429",
    await statuses(6, "/api/health", { "X-TM-Internal": SECRET, "X-Real-IP": "203.0.113.20" }),
    [200, 200, 200, 429, 429, 429],
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
  console.log("✅ all internal-caller proofs passed");
  process.exit(0);
}

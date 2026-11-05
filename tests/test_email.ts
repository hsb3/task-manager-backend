#!/usr/bin/env bun
/**E2E test of transactional email: branded verification + OTP mail.

SINK vs PROD split (read this before trusting the exit code): a local dumb
SMTP sink (scripts/smtp_sink.ts) captures whatever PocketBase sends to
MAIL_DIR/NNN.eml. The test PATCHes /api/settings to repoint smtp.host/port
at the sink (after first proving the boot hook — pb_hooks/mail.pb.js —
configured real Resend SMTP from RESEND_API_KEY at startup), drives the
verification/OTP flows end-to-end, and reads the captured .eml files back
to assert the BRANDED "Task Tracker" copy and harvest the verification
token / OTP code.

What this proves: the boot hook populates settings.smtp from the env var;
the branded subject lines/bodies actually get sent; verify-then-login
(403 before / 200 after) and request-otp/auth-with-otp round trips work;
request-verification always returns 204 regardless of account state
(PocketBase's anti-enumeration invariant); the verification and
password-reset emails link to web/'s own /verify-email and
/reset-password routes (not the PB dashboard's /_/#/auth/... UI —
v1:pb_migrations/1785154700_users_web_auth_links.js); request-password-reset
round-trips end to end (old password rejected, new password accepted)
and is equally anti-enumerating.

What this CANNOT prove (deliberately out of scope): real delivery through
Resend, Resend accepting the API-key SMTP auth, and deliverability
(SPF/DKIM/inbox placement) — the sink never talks to Resend and accepts any
SMTP conversation unconditionally. Confirming real delivery is a post-merge
manual runbook step, gated on the sender-identity decision.
 */

import fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as roomkit from "./roomkit.ts";
import {
  getitem,
  decode_text,
  glob_sorted,
  py_float,
  py_repr,
  py_str,
  py_strip,
  PY_WS,
  quopri_decodestring,
  read_text,
  urlencode,
} from "../scripts/_py.ts";

// .env is gitignored — no secrets hard-coded here.
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
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8092 + PORT_OFFSET}`;
// never default to scripts/mail — not gitignored; risks committing .eml files.
const MAIL_DIR = process.env.MAIL_DIR ?? "/tmp/pb_mail";
const MAIL_SINK_HOST = process.env.MAIL_SINK_HOST ?? "127.0.0.1";
const MAIL_SINK_PORT = roomkit.py_int(process.env.MAIL_SINK_PORT ?? String(2526 + PORT_OFFSET));
const APP_URL = process.env.WEB_APP_URL ?? "http://127.0.0.1:3000";

let failures = 0;

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
  if (r.status === 204) return [204, {}];
  const raw = await r.text();
  if (r.ok) return [r.status, JSON.parse(raw)];
  return [r.status, JSON.parse(raw || "{}")];
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
  const qs = urlencode({ filter: `${field}='${value}'` });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? getitem(items[0], "id") : null;
}

function eml_files(): string[] {
  return glob_sorted(MAIL_DIR, ".eml");
}

function count_eml(): number {
  fs.mkdirSync(MAIL_DIR, { recursive: true });
  return eml_files().length;
}

async function newest_eml_after(
  baseline_count: number,
  timeout = 5.0,
  interval = 0.1,
): Promise<string> {
  // sink writes asynchronously relative to the triggering API call — poll briefly.
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const files = eml_files();
    if (files.length > baseline_count) return files[files.length - 1]!;
    await Bun.sleep(interval * 1000);
  }
  throw new Error(
    `no new .eml appeared in ${MAIL_DIR} within ${py_str(py_float(timeout))}s (baseline=${baseline_count})`,
  );
}

function decode_eml(file: string): string {
  // outgoing mail is quoted-printable encoded (soft line-wraps at ~76 cols);
  // decode to unbroken strings.
  return decode_text(quopri_decodestring(fs.readFileSync(file)), "replace");
}

function extract_subject(decoded: string): string | null {
  const m = new RegExp(`^Subject:[${PY_WS}]*([^\\n]+)$`, "mu").exec(decoded);
  return m ? py_strip(m[1]!) : null;
}

// \b(\d{8})\b with Python's Unicode-aware \d and \b
const OTP_WORD_RE = /(?<![\p{L}\p{N}_])(\p{Nd}{8})(?![\p{L}\p{N}_])/u;

// ── Superuser auth ────────────────────────────────────────────────────────────
const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
let s: number;
let r: any;
[, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su: string = getitem(r, "token");

// COVERS: boot:mail.pb.js
console.log("\n── BOOT HOOK: RESEND_API_KEY populated settings.smtp at startup ──");
[s, r] = await api("GET", "/api/settings", su);
check("GET /api/settings", s, 200);
const smtp = (k: string): any => (r.smtp === undefined ? {} : r.smtp)[k];
check("smtp.enabled", smtp("enabled"), true);
check("smtp.host", smtp("host"), "smtp.resend.com");
check("smtp.username", smtp("username"), "resend");
check("smtp.port", smtp("port"), 587);
check("smtp.tls", smtp("tls"), false);
// password is stripped on read — do NOT assert it.
check("meta.senderName", (r.meta === undefined ? {} : r.meta).senderName, "Task Tracker");

console.log("\n── REPOINT MAIL AT THE SINK (leave branding as the boot hook set it) ──");
// sink has no AUTH support; username/password must be cleared or PocketBase's
// mail client attempts AUTH LOGIN and the sink's malformed reply fails the send.
[s, r] = await api("PATCH", "/api/settings", su, {
  smtp: {
    enabled: true,
    host: MAIL_SINK_HOST,
    port: MAIL_SINK_PORT,
    tls: false,
    username: "",
    password: "",
  },
});
check("PATCH /api/settings → sink", s, 200);

let baseline = count_eml();

console.log("\n── SIGNUP a throwaway user (starts unverified) ──");
const throwaway = `tw-${randomBytes(4).toString("hex")}@example.com`;
[s, r] = await api("POST", "/api/collections/users/records", null, {
  email: throwaway,
  password: "test123456",
  passwordConfirm: "test123456",
  name: "Throwaway",
});
check("signup", s, 200);
check("new account verified flag", r.verified, false);
const tw_id = r.id;

console.log("\n── AUTH before verify (authRule: verified = true) ──");
[s] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "test123456",
});
check("unverified login", s, 403);

console.log("\n── request-verification (204; PocketBase sends the branded email) ──");
[s] = await api("POST", "/api/collections/users/request-verification", null, { email: throwaway });
check("request-verification", s, 204);

const verify_eml = await newest_eml_after(baseline);
baseline = count_eml();
const verify_content = decode_eml(verify_eml);
const verify_subject = extract_subject(verify_content);
check("verification subject (branded)", verify_subject, "Confirm your Task Tracker account");
check(
  "verification subject is NOT the stock default",
  verify_subject === "Verify your {APP_NAME} email",
  false,
);
check(
  "verification body contains branded welcome line",
  verify_content.includes("Welcome to Task Tracker"),
  true,
);

check(
  "verification link points at web/'s own route (not the PB dashboard)",
  verify_content.includes(`${APP_URL}/verify-email?token=`),
  true,
);
check(
  "verification link does NOT point at the PB dashboard confirm UI",
  verify_content.includes("/_/#/auth/confirm-verification/"),
  false,
);
let m: RegExpExecArray | null = /verify-email\?token=([A-Za-z0-9._-]+)/.exec(verify_content);
const token = m ? m[1]! : null;
check("verification token extracted", !!token, true);

console.log("\n── confirm-verification ──");
[s] = await api("POST", "/api/collections/users/confirm-verification", null, { token });
check("confirm-verification", s, 204);

// approval gate: authRule requires verified && approved, so a freshly-verified
// account is still inert until approved (superuser bypasses the self-approval guard).
[s] = await api("PATCH", `/api/collections/users/records/${tw_id}`, su, { approved: true });
check("superuser approves throwaway (#30 gate)", s, 200);

console.log("\n── AUTH after verify + approval (403-before / 200-after) ──");
[s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "test123456",
});
check("verified login", s, 200);

console.log("\n── request-otp (200 + otpId; PocketBase sends the branded email) ──");
[s, r] = await api("POST", "/api/collections/users/request-otp", null, { email: throwaway });
check("request-otp", s, 200);
const otp_id = r.otpId ?? null;
check("otpId present", !!otp_id, true);

const otp_eml = await newest_eml_after(baseline);
baseline = count_eml();
const otp_content = decode_eml(otp_eml);
const otp_subject = extract_subject(otp_content);
check("otp subject (branded)", otp_subject, "Your Task Tracker one-time password");

m = /<strong>(\p{Nd}{8})<\/strong>/u.exec(otp_content) || OTP_WORD_RE.exec(otp_content);
const code = m ? m[1]! : null;
check("otp code extracted", !!code, true);

console.log("\n── auth-with-otp ──");
[s, r] = await api("POST", "/api/collections/users/auth-with-otp", null, {
  otpId: otp_id,
  password: code,
});
check("auth-with-otp", s, 200);

console.log("\n── request-verification 204 invariant (anti account-enumeration) ──");
[s] = await api("POST", "/api/collections/users/request-verification", null, { email: throwaway });
check("request-verification on already-verified account", s, 204);
[s] = await api("POST", "/api/collections/users/request-verification", null, {
  email: `nonexistent-${randomBytes(4).toString("hex")}@example.com`,
});
check("request-verification on unknown account", s, 204);

console.log("\n── request-password-reset (204; PocketBase sends the branded email) ──");
[s] = await api("POST", "/api/collections/users/request-password-reset", null, {
  email: throwaway,
});
check("request-password-reset", s, 204);

const reset_eml = await newest_eml_after(baseline);
baseline = count_eml();
const reset_content = decode_eml(reset_eml);
const reset_subject = extract_subject(reset_content);
check("reset subject (branded)", reset_subject, "Reset your Task Tracker password");
check(
  "reset link points at web/'s own route (not the PB dashboard)",
  reset_content.includes(`${APP_URL}/reset-password?token=`),
  true,
);
check(
  "reset link does NOT point at the PB dashboard confirm UI",
  reset_content.includes("/_/#/auth/confirm-password-reset/"),
  false,
);

m = /reset-password\?token=([A-Za-z0-9._-]+)/.exec(reset_content);
const reset_token = m ? m[1]! : null;
check("reset token extracted", !!reset_token, true);

console.log("\n── confirm-password-reset ──");
[s] = await api("POST", "/api/collections/users/confirm-password-reset", null, {
  token: reset_token,
  password: "newpass456789",
  passwordConfirm: "newpass456789",
});
check("confirm-password-reset", s, 204);

console.log("\n── old password now fails, new password succeeds ──");
[s] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "test123456",
});
check("old password rejected after reset", s, 400);
[s] = await api("POST", "/api/collections/users/auth-with-password", null, {
  identity: throwaway,
  password: "newpass456789",
});
check("new password accepted after reset", s, 200);

console.log("\n── request-password-reset 204 invariant (anti account-enumeration) ──");
[s] = await api("POST", "/api/collections/users/request-password-reset", null, {
  email: throwaway,
});
check("request-password-reset on known account", s, 204);
[s] = await api("POST", "/api/collections/users/request-password-reset", null, {
  email: `nonexistent-${randomBytes(4).toString("hex")}@example.com`,
});
check("request-password-reset on unknown account", s, 204);

console.log("\n── CLEANUP ──");
[s] = await api("DELETE", `/api/collections/users/records/${tw_id}`, su);
check("cleanup: superuser deletes throwaway user", s, 204);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
  process.exit(0);
}

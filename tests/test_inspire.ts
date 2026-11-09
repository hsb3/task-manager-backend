#!/usr/bin/env bun
/**
 * E2E proof of GET /api/tracker/inspire against a LOCAL stub upstream: the auth gate, the
 * success relay and its response shape, and the upstream-failure classes that must all read
 * 502 — a non-200 response, an unparseable body, a body of the wrong shape, and a call that
 * throws before any response (socket hangup, then a dead address).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy. Port 8141 +
 * PB_PORT_OFFSET (suite
 * self-boot band per .agents/rules/ports.md; 8100-8109 are all taken). The stub upstream binds an
 * OS-assigned ephemeral port and the room is told about it through INSPIRE_UPSTREAM_URL, so
 * this suite makes no outbound call and can never collide with a band.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { by_code_point, getitem, json_dumps, py_repr, run_checked } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8141 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

const STUB_QUOTE = "Only a local stub answers here.";
const STUB_AUTHOR = "The Clean Room";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(64)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

/** A 502 answers with the shared error body {status, message, data}. */
function check_502_body(label: string, r: any): void {
  const ok =
    r?.status === 502 &&
    typeof r.message === "string" &&
    r.message !== "" &&
    !!r.data &&
    typeof r.data === "object" &&
    !Array.isArray(r.data);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${`${label}: the shared error body`.padEnd(64)} → ${py_repr(r)}`,
  );
}

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

// ── Stub upstream ───────────────────────────────────────────────────────────────
const stub_state = { mode: "ok", hits: 0 };

function _body(res: http.ServerResponse, payload: string, ctype = "application/json"): void {
  const raw = Buffer.from(payload, "utf8");
  res.writeHead(200, { "Content-Type": ctype, "Content-Length": String(raw.length) });
  res.end(raw);
}

const stub = http.createServer((req, res) => {
  stub_state.hits += 1;
  const mode = stub_state.mode;
  if (mode === "hangup") {
    // Close with zero bytes written: the caller's send throws BEFORE any response.
    req.socket.destroy();
    return;
  }
  if (mode === "status500") {
    res.writeHead(500, { "Content-Length": "0" });
    res.end();
    return;
  }
  if (mode === "notjson")
    return _body(res, "<html>upstream is having a moment</html>", "text/html");
  if (mode === "wrongshape") return _body(res, json_dumps({ not: "an array" }));
  return _body(res, json_dumps([{ q: STUB_QUOTE, a: STUB_AUTHOR, h: "<i>x</i>" }]));
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const STUB_PORT = (stub.address() as AddressInfo).port;
const STUB_URL = `http://127.0.0.1:${STUB_PORT}/api/random`;

async function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  // roomkit.serve() takes no env=; the room inherits process.env, restored so the var
  // reaches only the child.
  const saved = process.env.INSPIRE_UPSTREAM_URL;
  process.env.INSPIRE_UPSTREAM_URL = STUB_URL;
  try {
    return await roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
  } finally {
    if (saved === undefined) delete process.env.INSPIRE_UPSTREAM_URL;
    else process.env.INSPIRE_UPSTREAM_URL = saved;
  }
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-inspire-test-"));
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
  server = await start_server(DATA_DIR, MIG_DIR);

  console.log(
    `\n── seed: alice/bob/carol fixtures (scripts/seed.ts); stub upstream ${STUB_URL} ──`,
  );
  const seed_proc = Bun.spawn([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: BASE_URL,
      PB_SUPERUSER_EMAIL: SU_EMAIL,
      PB_SUPERUSER_PASSWORD: SU_PASSWORD,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [seed_out, seed_err, seed_rc] = await Promise.all([
    new Response(seed_proc.stdout).text(),
    new Response(seed_proc.stderr).text(),
    seed_proc.exited,
  ]);
  check("seed.ts exit code", seed_rc, 0);
  if (seed_rc !== 0) {
    console.log(seed_out);
    console.log(seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const [alice] = await login("alice@example.com");
  let s: number, r: any;

  // COVERS: route:GET /api/tracker/inspire
  // ══════════════════ 1. Auth gate ════════════════════════════════════════════
  console.log("\n── (1) the route stays auth-gated ──");
  [s] = await api("GET", "/api/tracker/inspire");
  check("anonymous request", s, 401);

  // ══════════════════ 2. Success relay against the stub ═══════════════════════
  console.log("\n── (2) INSPIRE_UPSTREAM_URL points the route at the local stub ──");
  stub_state.mode = "ok";
  const before = stub_state.hits;
  [s, r] = await api("GET", "/api/tracker/inspire", alice);
  check("authenticated request", s, 200);
  check("the stub was the upstream that answered", stub_state.hits > before, true);
  check("response shape", Object.keys(r).sort(by_code_point), ["author", "quote", "source"]);
  check("quote relayed from the stub", r.quote ?? null, STUB_QUOTE);
  check("author relayed from the stub", r.author ?? null, STUB_AUTHOR);
  check("source label", r.source ?? null, "zenquotes.io");

  // ══════════════════ 3. Upstream answers, but unusably ═══════════════════════
  console.log("\n── (3) a bad upstream RESPONSE is 502, never 400 ──");
  stub_state.mode = "status500";
  [s, r] = await api("GET", "/api/tracker/inspire", alice);
  check("upstream returns 500", s, 502);
  check_502_body("upstream returns 500", r);
  stub_state.mode = "notjson";
  [s, r] = await api("GET", "/api/tracker/inspire", alice);
  check("upstream returns 200 with an unparseable body", s, 502);
  check_502_body("upstream returns 200 with an unparseable body", r);
  stub_state.mode = "wrongshape";
  [s, r] = await api("GET", "/api/tracker/inspire", alice);
  check("upstream returns 200 with JSON of the wrong shape", s, 502);
  check_502_body("upstream returns 200 with JSON of the wrong shape", r);

  // ══════════════════ 4. The call throws before any response ══════════════════
  console.log("\n── (4) a THROWN upstream call is 502, never 400 (TASK-112) ──");
  stub_state.mode = "hangup";
  [s, r] = await api("GET", "/api/tracker/inspire", alice);
  check("upstream closes the socket with no response", s, 502);
  check_502_body("upstream closes the socket with no response", r);

  stub.close();
  check(
    "stub really is gone (its port reads free)",
    await roomkit.wait_for_port_free(STUB_PORT),
    true,
  );
  [s, r] = await api("GET", "/api/tracker/inspire", alice);
  check("upstream address is dead (connection refused)", s, 502);
  check_502_body("upstream address is dead (connection refused)", r);
} finally {
  try {
    stub.close(); // the stub may already be stopped
  } catch {}
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all inspire proofs passed");
  process.exit(0);
}

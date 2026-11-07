#!/usr/bin/env bun
/**
 * E2E test of the module-19 backups boot hook (`pb_hooks/backups.pb.js`). Fully
 * self-contained clean-room server(s) — never touches the repo's real pb_migrations,
 * pb_hooks, or pb_data.
 *
 * Proves: SET room (dummy PB_BACKUPS_S3_* env) — the boot hook wires the whole
 * settings.backups block from env with no migration file written. UNSET room — the
 * env guard no-ops (s3 disabled) and local-filesystem backup API round-trips.
 * Not provable here (needs a real S3 endpoint / live restart): a backup landing in
 * a bucket, the scheduled cron backup, and the point-in-time restore drill.
 *
 * Ports: 8095 (SET) then 8098 (UNSET) + PB_PORT_OFFSET, sequentially — see the port bands in
 * .agents/rules/ports.md.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decode_text, py_get, py_str, run_checked, splitlines, truthy } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const BACKUPS_HOOK_SRC = path.join(REPO_ROOT, "pb_hooks", "backups.pb.js");
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds

// Dummy superuser + S3 config — NOT real secrets (those live in Railway vars only).
const SU_EMAIL = process.env.PB_SUPERUSER_EMAIL ?? "backups-ci@example.test";
const SU_PASSWORD = process.env.PB_SUPERUSER_PASSWORD ?? "backups-ci-dummy-pw-000";
const DUMMY_S3: Record<string, string> = {
  PB_BACKUPS_S3_BUCKET: "ci-dummy-bucket",
  PB_BACKUPS_S3_ENDPOINT: "http://127.0.0.1:9", // unreachable on purpose; we never dial it
  PB_BACKUPS_S3_REGION: "us-east-1",
  PB_BACKUPS_S3_ACCESS_KEY: "CIDUMMYACCESS",
  PB_BACKUPS_S3_SECRET: "ci-dummy-secret-value",
  PB_BACKUPS_CRON: "0 3 * * *",
  PB_BACKUPS_CRON_MAX_KEEP: "30",
};

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  const mark = ok ? "✅" : "❌ MISMATCH";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

async function api(
  base_url: string,
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(base_url + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = decode_text(new Uint8Array(await r.arrayBuffer()));
  if (r.status === 204) return [204, {}];
  if (r.ok) return [r.status, JSON.parse(raw)];
  try {
    return [r.status, JSON.parse(raw || "{}")];
  } catch {
    return [r.status, {}];
  }
}

async function superuser_token(base_url: string): Promise<any> {
  const [, r] = await api(
    base_url,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    null,
    { identity: SU_EMAIL, password: SU_PASSWORD },
  );
  return r.token ?? null;
}

function count_migration_files(migrations_dir: string): number {
  return fs.readdirSync(migrations_dir).filter((f) => f.endsWith(".js")).length;
}

/** A self-contained `pocketbase serve` clean-room; `extra_env` is merged onto
 * the subprocess env (the PB_BACKUPS_S3_* vars the boot hook reads). */
class Room {
  port: number;
  extra_env: Record<string, string>;
  base_url: string;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  hooks_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number, extra_env: Record<string, string> | null = null) {
    this.port = port;
    this.extra_env = extra_env || {};
    this.base_url = `http://127.0.0.1:${port}`;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-backups-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    this.hooks_dir = path.join(this.tmp, "pb_hooks");
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    // Drop the superuser-MFA migration so plain auth-with-password returns a token.
    for (const f of fs.readdirSync(this.migrations_dir)) {
      if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(this.migrations_dir, f));
    }
    fs.mkdirSync(this.hooks_dir, { recursive: true });
    fs.copyFileSync(BACKUPS_HOOK_SRC, path.join(this.hooks_dir, "backups.pb.js"));
    this.proc = null;
  }

  async start(): Promise<void> {
    await roomkit.require_free_port(this.port);
    // --hooksDir deliberately omitted here so the boot hook doesn't run during upsert.
    run_checked(
      [
        POCKETBASE_BIN,
        "superuser",
        "upsert",
        SU_EMAIL,
        SU_PASSWORD,
        "--dir",
        this.data_dir,
        "--migrationsDir",
        this.migrations_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    // roomkit.serve() has no env= param; the backups hook reads env vars, so they ride
    // process.env for the spawn it makes (roomkit passes env: process.env) and are restored after.
    const saved = new Map<string, string | undefined>(
      Object.keys(this.extra_env).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, this.extra_env);
    try {
      this.proc = await roomkit.serve(
        this.port,
        this.data_dir,
        this.migrations_dir,
        this.hooks_dir,
      );
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

let tok: any;
let status: number;
let s: any;
let backups: any;
let listing: any;

// ── Room 1: env SET (dummy S3) — the hook wires settings.backups from env ─────
// COVERS: boot:backups.pb.js
console.log("\n── SET room (dummy PB_BACKUPS_S3_*): the boot hook wires settings.backups ──");
const set_room = new Room(8095 + PORT_OFFSET, DUMMY_S3);
const migrations_before = count_migration_files(set_room.migrations_dir);
try {
  await set_room.start();
  tok = await superuser_token(set_room.base_url);
  [status, s] = await api(set_room.base_url, "GET", "/api/settings", tok);
  check("GET /api/settings", status, 200);
  backups = py_get(s, "backups", {});
  const s3 = py_get(backups, "s3", {});
  check("backups.s3.enabled", py_get(s3, "enabled", null), true);
  check("backups.s3.bucket = env", py_get(s3, "bucket", null), DUMMY_S3["PB_BACKUPS_S3_BUCKET"]);
  check(
    "backups.s3.endpoint = env",
    py_get(s3, "endpoint", null),
    DUMMY_S3["PB_BACKUPS_S3_ENDPOINT"],
  );
  check("backups.s3.region = env", py_get(s3, "region", null), DUMMY_S3["PB_BACKUPS_S3_REGION"]);
  check(
    "backups.s3.accessKey = env",
    py_get(s3, "accessKey", null),
    DUMMY_S3["PB_BACKUPS_S3_ACCESS_KEY"],
  );
  check("backups.s3.forcePathStyle", py_get(s3, "forcePathStyle", null), true);
  // secret is stripped on read — never round-trips back over the API.
  check(
    "backups.s3.secret masked on read",
    py_get(s3, "secret", null) !== DUMMY_S3["PB_BACKUPS_S3_SECRET"],
    true,
  );
  check("backups.cron = env", py_get(backups, "cron", null), DUMMY_S3["PB_BACKUPS_CRON"]);
  check(
    "backups.cronMaxKeep = env",
    py_get(backups, "cronMaxKeep", null),
    roomkit.py_int(DUMMY_S3["PB_BACKUPS_CRON_MAX_KEEP"]),
  );
  const migrations_after = count_migration_files(set_room.migrations_dir);
  check("boot-hook runtime save writes no migration file", migrations_after, migrations_before);
} finally {
  await set_room.stop();
  set_room.cleanup_tmp();
}

// ── Room 2: env UNSET — the hook no-ops; local-filesystem backup API round-trips ─
// COVERS: boot:backups.pb.js
console.log("\n── UNSET room (no PB_BACKUPS_S3_*): hook no-ops + filesystem backup round-trip ──");
// Strip any ambient PB_BACKUPS_S3_* so the "unset" room genuinely sees them absent.
for (const k of Object.keys(process.env)) {
  if (k.startsWith("PB_BACKUPS_")) delete process.env[k];
}
const unset_room = new Room(8098 + PORT_OFFSET, {});
try {
  await unset_room.start();
  tok = await superuser_token(unset_room.base_url);
  [status, s] = await api(unset_room.base_url, "GET", "/api/settings", tok);
  check("GET /api/settings", status, 200);
  backups = py_get(s, "backups", {});
  check("backups.s3.enabled (no-op)", py_get(py_get(backups, "s3", {}), "enabled", null), false);
  check("backups.cron empty (no-op)", py_get(backups, "cron", null), "");

  // Filesystem backup API smoke: create → list → delete (no S3, no restart).
  [status] = await api(unset_room.base_url, "POST", "/api/backups", tok, {});
  check("POST /api/backups (filesystem) → 204", status, 204);
  await Bun.sleep(1000); // let the backup finish writing before listing
  [status, listing] = await api(unset_room.base_url, "GET", "/api/backups", tok);
  check("GET /api/backups", status, 200);
  const keys = (Array.isArray(listing) ? listing : []).map((b: any) => b.key ?? null);
  check("exactly one filesystem backup listed", keys.length, 1);
  const new_key = keys.length ? keys[0] : null;
  check("backup key present", truthy(new_key), true);
  if (truthy(new_key)) {
    [status] = await api(unset_room.base_url, "DELETE", `/api/backups/${new_key}`, tok);
    check("DELETE /api/backups/{key} → 204", status, 204);
    await Bun.sleep(500);
    [status, listing] = await api(unset_room.base_url, "GET", "/api/backups", tok);
    const remaining = (Array.isArray(listing) ? listing : []).map((b: any) => b.key ?? null);
    check("backup gone after delete", remaining.includes(new_key), false);
  }
} finally {
  await unset_room.stop();
  unset_room.cleanup_tmp();
}

// ── Repo-level guard: the real pb_migrations/ must stay git-clean ──────────────
console.log("\n── real pb_migrations/ untouched by either clean-room ──");
const git_status = run_checked(["git", "status", "--porcelain", "pb_migrations/"], {
  cwd: REPO_ROOT,
  capture_output: true,
  text: true,
}).stdout!;
const bad_lines = splitlines(git_status).filter(
  (line) => line.includes("_updated_") && !line.slice(0, 2).includes("D"),
);
check("no auto-written *_updated_*.js migration in real pb_migrations/", bad_lines, []);
console.log(`      git status --porcelain pb_migrations/ :\n${git_status || "      (clean)"}`);

console.log(`\n${"=".repeat(70)}`);
if (failures) {
  console.log(`❌ ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("✅ all checks passed");
  process.exit(0);
}

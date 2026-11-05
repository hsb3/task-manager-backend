#!/usr/bin/env bun
/**
 * Proof that a boot refusal names the setting a human must fix, not just the machinery.
 *
 * §1 a bad value in any of the five cron variables refuses `serve` and names THAT variable;
 * §2 a valid value and an unset variable both still boot healthy; §3 what the container start
 * guard reads — a migration refusing the database in front of it makes `serve` exit non-zero,
 * name the migration and never bind (PB 0.40.4; the guard reads that exit status); §4 the
 * fifth variable reaches PB's parser only with S3 armed, which is the deployed shape.
 *
 * Self-booting clean room (scratch copies of pb_migrations + pb_hooks), no seeded fixtures
 * and no auth: every assertion here is about the boot itself. Port 8122 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  py_repr,
  read_text,
  run_checked,
  splitlines,
  sqlite_connect,
  tup,
} from "../scripts/_py.ts";
import { migrate_up } from "../scripts/pb_migrate.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;

const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT = 8122 + roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

// Every cron variable a bad value can refuse the boot on. PB_BACKUPS_CRON reaches PB's parser
// through the backups settings save rather than a cronAdd, but only when S3 is armed (§4).
const CRON_VARS = [
  "ALERT_CRON",
  "CYCLE_ROLLOVER_CRON",
  "DIGEST_CRON",
  "PB_BACKUPS_CRON",
  "TRASH_PURGE_CRON",
];
// Arming S3 is what makes backups.pb.js read PB_BACKUPS_CRON at all; the values are never
// dialled, so dummies are enough to reach the parser.
const S3_ARMED: Record<string, string> = {
  PB_BACKUPS_S3_BUCKET: "fake-bucket",
  PB_BACKUPS_S3_SECRET: "fakesecret",
  PB_BACKUPS_S3_ENDPOINT: "https://example.invalid",
  PB_BACKUPS_S3_REGION: "auto",
  PB_BACKUPS_S3_ACCESS_KEY: "fakekey",
};
// What PB says when the backups settings save rejects the schedule: no variable name at all.
const ANONYMOUS_BACKUPS_ERROR = "backups: (cron:";
const BAD_EXPR = "not a cron";

// §3 needs a migration that can be made to refuse on real data. Derived, never pinned: the
// migration that imports the collections refuses any database already holding a table it
// creates, and a rebaselined tree renames the file but never stops carrying one.
function _collections_migration(): string {
  for (const name of fs.readdirSync(path.join(REPO_ROOT, "pb_migrations")).sort(by_code_point)) {
    if (read_text(path.join(REPO_ROOT, "pb_migrations", name)).includes("importCollections(")) {
      return name;
    }
  }
  throw new roomkit.SystemExit(
    "no migration in pb_migrations/ calls importCollections, so §3 has no refusal to " +
      "drive — the collection set moved and this derivation has to move with it.",
  );
}

const REFUSING_MIGRATION = _collections_migration();
// A table the import must create. Planted by hand, it is what the import then refuses.
const SQUATTED_TABLE = "tasks";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(66)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

function room_env(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  /** A child env with every cron variable cleared, then `overrides` applied — an ambient
   * value would otherwise decide what the control rooms are actually proving. */
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of [...CRON_VARS, ...Object.keys(S3_ARMED)]) delete env[name];
  return Object.assign(env, overrides);
}

function serve_argv(data_dir: string, migrations_dir: string): string[] {
  return [
    PB_BIN,
    "serve",
    `--http=127.0.0.1:${PORT}`,
    "--dir",
    data_dir,
    "--migrationsDir",
    migrations_dir,
    "--hooksDir",
    HOOKS_DIR,
  ];
}

function room_log(data_dir: string): string {
  /** One log file per room: the rooms here reuse the port sequentially, so a shared path
   * would let a later room truncate output an earlier check still has to read. */
  return data_dir + ".log";
}

function read_log(path: string): string {
  return read_text(path, "replace");
}

async function serve_until_exit(
  data_dir: string,
  migrations_dir: string,
  env: Record<string, string | undefined>,
  timeout = 30,
): Promise<[number | null, string]> {
  /** Boot a room expected to refuse. Returns (exit status or None when it had to be
   * killed, output) — a killed room's negative status would otherwise read as a refusal, so
   * a room that stays up must not be able to satisfy a refusal assertion.
   *
   * roomkit.serve() is the wrong tool for a boot that must FAIL, so this reproduces its
   * shape by hand: output to a FILE, never an undrained pipe that blocks the child. */
  await roomkit.require_free_port(PORT);
  const log_path = room_log(data_dir);
  const log = fs.openSync(log_path, "w");
  let rc: number | null;
  try {
    const proc = Bun.spawn(serve_argv(data_dir, migrations_dir), {
      cwd: REPO_ROOT,
      env,
      stdout: log,
      stderr: log,
    });
    let timer: Timer | undefined;
    const timed_out = Symbol("timeout");
    const waited = await Promise.race([
      proc.exited,
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(timed_out), timeout * 1000);
      }),
    ]);
    clearTimeout(timer);
    if (waited === timed_out) {
      proc.kill();
      await proc.exited;
      rc = null;
    } else {
      rc = waited as number;
    }
  } finally {
    fs.closeSync(log);
  }
  let out = read_log(log_path);
  if (rc === null) out += `\n[the room was still running after ${timeout}s]`;
  // Frees the port for the next room; never an assertion — by here the process is already
  // gone, so it could only ever report free. "Never bound" is read off SERVER_STARTED.
  await roomkit.wait_for_port_free(PORT);
  return [rc, out];
}

async function serve_healthy(
  data_dir: string,
  migrations_dir: string,
  env: Record<string, string | undefined>,
): Promise<[boolean, string]> {
  /** Boot a room expected to come up. Returns (healthy, output). */
  const log_path = room_log(data_dir);
  // roomkit.serve() takes no env=, and a scrubbed environment is this room's whole
  // premise, so process.env IS the child's env for the length of the boot.
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  let proc: roomkit.Room | null;
  try {
    proc = await roomkit.serve(PORT, data_dir, migrations_dir, HOOKS_DIR, log_path);
  } catch (e) {
    if (!(e instanceof roomkit.RoomNotHealthy || e instanceof roomkit.RoomNotOurs)) throw e;
    console.log(`     room refused to come up: ${e.message}`);
    proc = null;
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  if (proc === null) {
    await roomkit.wait_for_port_free(PORT);
    return [false, read_log(log_path)];
  }
  await roomkit.stop(proc);
  return [true, read_log(proc.roomkit_log)];
}

// 0.40.4 prints `<timestamp> failed to apply migration <file>: …`; 0.39 prefixed it `Error: `.
const REFUSAL_LINE = "failed to apply migration";

function refusal_lines(out: string): string[] {
  return splitlines(out).filter((line) => line.includes(REFUSAL_LINE));
}

// PB prints this only once it is actually listening, so its ABSENCE is the falsifiable form
// of "never bound" — a port probe after the process exits can only ever report free.
const SERVER_STARTED = "Server started at";

// ── Scratch tree: one migrated pb_data, cloned per room ─────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-boot-refusals-test-"));
const MIG_ALL = path.join(S, "pb_migrations");
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_ALL, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_ALL)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_ALL, name));
}
const HOOKS_DIR = roomkit.hooks_dir(S);

const BASE_DATA = path.join(S, "pb_data_base");
run_checked(
  [
    PB_BIN,
    "superuser",
    "upsert",
    SU_EMAIL,
    SU_PASSWORD,
    "--dir",
    BASE_DATA,
    "--migrationsDir",
    MIG_ALL,
  ],
  { cwd: REPO_ROOT, capture_output: true, text: true },
);

function clone_base(tag: string): string {
  const dest = path.join(S, `pb_data_${tag}`);
  fs.cpSync(BASE_DATA, dest, { recursive: true, dereference: true });
  return dest;
}

console.log(`════════ boot refusals (port ${PORT}, scratch ${S}) ════════`);

// ── §1 A bad cron value refuses boot, naming the variable ──────────────────────
// COVERS: boot:_cron_env.pb.js
console.log(`\n── §1 each cron variable set to ${py_repr(BAD_EXPR)} refuses boot by name ──`);
for (const v of CRON_VARS) {
  const [rc, out] = await serve_until_exit(
    clone_base(v.toLowerCase()),
    MIG_ALL,
    room_env({ [v]: BAD_EXPR }),
  );
  check(`${v}: serve refuses to run at all`, rc !== null, true);
  check(`${v}: its exit status is non-zero`, rc !== null ? rc !== 0 : null, true);
  check(`${v}: it never announced a listening server`, out.includes(SERVER_STARTED), false);
  check(`${v}: the output names the variable`, out.includes(v), true);
  const others = CRON_VARS.filter((n) => n !== v && out.includes(n)).sort(by_code_point);
  check(`${v}: no other cron variable is named`, others, []);
  if (!out.includes(v)) {
    console.log("     ── what the room actually printed ──");
    for (const line of splitlines(out).slice(0, 8)) console.log(`     ${line}`);
  }
}

// ── §2 Controls: the validator refuses bad values only ─────────────────────────
console.log("\n── §2 controls: a valid value and an unset variable both boot healthy ──");
let [healthy] = await serve_healthy(
  clone_base("valid"),
  MIG_ALL,
  room_env({ CYCLE_ROLLOVER_CRON: "*/7 * * * *" }),
);
check("CYCLE_ROLLOVER_CRON='*/7 * * * *': room boots healthy", healthy, true);
[healthy] = await serve_healthy(clone_base("unset"), MIG_ALL, room_env());
check("no cron variable set at all: room boots healthy", healthy, true);

// ── §3 A refusing migration makes serve exit non-zero and never bind ───────────
console.log("\n── §3 a refusing migration: `serve` exits non-zero, names it, and never binds ──");
const PLANTED_DATA = path.join(S, "pb_data_planted");
fs.mkdirSync(PLANTED_DATA);
const CORE_ONLY = path.join(S, "pb_migrations_core_only");
fs.mkdirSync(CORE_ONLY);
let [ok, out] = migrate_up(PB_BIN, PLANTED_DATA, CORE_ONLY);
check("a core-only database migrates cleanly", ok, true);

const db = sqlite_connect(path.join(PLANTED_DATA, "data.db"));
let planted_row: any;
try {
  db.run(`CREATE TABLE ${SQUATTED_TABLE} (id TEXT PRIMARY KEY)`);
  planted_row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(SQUATTED_TABLE);
} finally {
  db.close();
}
const planted = planted_row ? tup(...Object.values(planted_row)) : null;
check(
  `a table squatting the ${py_repr(SQUATTED_TABLE)} collection is planted`,
  planted,
  tup(SQUATTED_TABLE),
);

[ok, out] = migrate_up(PB_BIN, PLANTED_DATA, MIG_ALL);
check("migrate up over that table is reported as a failure", ok, false);
check(
  `its output carries a refusal line naming ${REFUSING_MIGRATION}`,
  refusal_lines(out).some((line) => line.includes(REFUSING_MIGRATION)),
  true,
);

let rc: number | null;
[rc, out] = await serve_until_exit(PLANTED_DATA, MIG_ALL, room_env());
check("serve against that database exits non-zero", rc !== null && rc !== 0, true);
check(`serve never announced a listening server on ${PORT}`, out.includes(SERVER_STARTED), false);
check(
  `serve's output carries a refusal line naming ${REFUSING_MIGRATION}`,
  refusal_lines(out).some((line) => line.includes(REFUSING_MIGRATION)),
  true,
);

// ── §4 PB_BACKUPS_CRON reaches the parser only with S3 armed — the deployed shape ──────
console.log("\n── §4 with S3 armed, a bad PB_BACKUPS_CRON is refused BY NAME ──");
[rc, out] = await serve_until_exit(
  clone_base("backups_armed"),
  MIG_ALL,
  room_env({ PB_BACKUPS_CRON: BAD_EXPR, ...S3_ARMED }),
);
check("S3 armed + bad PB_BACKUPS_CRON: exit status is non-zero", rc !== null && rc !== 0, true);
check(
  "S3 armed + bad PB_BACKUPS_CRON: the output names the variable",
  out.includes("PB_BACKUPS_CRON"),
  true,
);
// Without the shared validation site the backups settings save refuses instead, naming no
// variable — so this absence is what proves the validator, not the settings save, caught it.
check(
  "the refusal is not PB's anonymous backups-settings error",
  out.includes(ANONYMOUS_BACKUPS_ERROR),
  false,
);

fs.rmSync(S, { recursive: true, force: true });
console.log(`\n${failures ? "❌ " + failures + " failed check(s)" : "✅ all checks passed"}`);
process.exit(failures ? 1 : 0);

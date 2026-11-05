#!/usr/bin/env bun
/**
 * E2E test of the file-storage boot hook (`pb_hooks/files.pb.js`). Fully
 * self-contained clean-room server(s) — never touches the repo's real pb_migrations,
 * pb_hooks, or pb_data.
 *
 * Proves: SET room (dummy PB_FILES_S3_* env, unreachable endpoint, never dialled) —
 * the boot hook wires settings.s3 (FILE storage) from env, leaves settings.backups.s3
 * untouched, and writes no migration file. UNSET room — the env guard no-ops
 * (settings.s3 disabled) and a real local-filesystem upload round-trips: seeded user
 * uploads an avatar, reads it back byte-identical, and the file lands under the
 * room's pb_data/storage/. Not provable here (needs a real S3 endpoint): a file
 * actually landing in a bucket.
 *
 * Hooks dirs: the SET room copies ONLY files.pb.js (it just reads settings — the
 * hook under test in isolation); the UNSET room uses roomkit.hooks_dir's full
 * pb_hooks copy because its scripts/seed.ts fixtures need the provisioning/seq/vocab
 * hooks to build users, workspaces and statuses.
 *
 * Ports: 8112 (SET) then 8113 (UNSET) + PB_PORT_OFFSET, sequentially — see
 * .agents/rules/ports.md.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  os_walk,
  py_get,
  py_join,
  py_str,
  run_checked,
  splitlines,
  truthy,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const FILES_HOOK_SRC = path.join(REPO_ROOT, "pb_hooks", "files.pb.js");
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds

// Dummy superuser + S3 config — NOT real secrets (those live in Railway vars only).
const SU_EMAIL = process.env.PB_SUPERUSER_EMAIL ?? "files-ci@example.test";
const SU_PASSWORD = process.env.PB_SUPERUSER_PASSWORD ?? "files-ci-dummy-pw-000";
const DUMMY_S3: Record<string, string> = {
  PB_FILES_S3_BUCKET: "ci-dummy-files-bucket",
  PB_FILES_S3_ENDPOINT: "http://127.0.0.1:9", // unreachable on purpose; we never dial it
  PB_FILES_S3_REGION: "auto",
  PB_FILES_S3_ACCESS_KEY: "CIDUMMYFILESACCESS",
  PB_FILES_S3_SECRET: "ci-dummy-files-secret",
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
  const raw = await r.text();
  if (r.ok) return [r.status, raw ? JSON.parse(raw) : {}];
  try {
    return [r.status, JSON.parse(raw || "{}")];
  } catch {
    return [r.status, {}];
  }
}

async function get_raw(base_url: string, path: string): Promise<[number, Uint8Array]> {
  const r = await fetch(base_url + path);
  return [r.status, new Uint8Array(await r.arrayBuffer())];
}

async function multipart_patch(
  base_url: string,
  coll: string,
  rid: string,
  token: string,
  field: string,
  filename: string,
  content: Uint8Array,
  ctype = "image/png",
): Promise<[number, any]> {
  const b = "----pbfilesboundary";
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${ctype}\r\n\r\n`),
    content,
    Buffer.from("\r\n"),
    Buffer.from(`--${b}--\r\n`),
  ]);
  const r = await fetch(`${base_url}/api/collections/${coll}/records/${rid}`, {
    method: "PATCH",
    headers: { "Content-Type": `multipart/form-data; boundary=${b}`, Authorization: token },
    body,
  });
  return [r.status, JSON.parse((await r.text()) || "{}")];
}

function png_bytes(w: number, h: number, rgb: number[] = [40, 120, 200]): Buffer {
  // A real, decodable PNG — the avatar field only accepts image MIME types.
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  function chunk(typ: Buffer, data: Buffer): Buffer {
    const c = Buffer.concat([typ, data]);
    return Buffer.concat([u32(data.length), c, u32(crc32(c))]);
  }

  const sig = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])]);
  const px = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: w }, () => Buffer.from(rgb)),
  ]);
  const raw = Buffer.concat(Array.from({ length: h }, () => px));
  return Buffer.concat([
    sig,
    chunk(Buffer.from("IHDR"), ihdr),
    chunk(Buffer.from("IDAT"), deflateSync(raw)),
    chunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
}

async function superuser_token(base_url: string): Promise<string | undefined> {
  const [, r] = await api(
    base_url,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    null,
    {
      identity: SU_EMAIL,
      password: SU_PASSWORD,
    },
  );
  return r.token;
}

function count_migration_files(migrations_dir: string): number {
  return fs.readdirSync(migrations_dir).filter((f) => f.endsWith(".js")).length;
}

class Room {
  // A self-contained `pocketbase serve` clean-room; `extra_env` is merged onto
  // the subprocess env (the PB_FILES_S3_* vars the boot hook reads). `full_hooks`
  // picks roomkit.hooks_dir's full pb_hooks copy over the files.pb.js-only one.
  port: number;
  extra_env: Record<string, string>;
  base_url: string;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  hooks_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number, extra_env: Record<string, string> | null = null, full_hooks = false) {
    this.port = port;
    this.extra_env = extra_env ?? {};
    this.base_url = `http://127.0.0.1:${port}`;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-files-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    // Drop the superuser-MFA migration so plain auth-with-password returns a token.
    for (const f of fs.readdirSync(this.migrations_dir)) {
      if (f.endsWith("superuser_mfa.js")) fs.rmSync(path.join(this.migrations_dir, f));
    }
    if (full_hooks) {
      this.hooks_dir = roomkit.hooks_dir(this.tmp);
    } else {
      this.hooks_dir = path.join(this.tmp, "pb_hooks");
      fs.mkdirSync(this.hooks_dir, { recursive: true });
      fs.copyFileSync(FILES_HOOK_SRC, path.join(this.hooks_dir, "files.pb.js"));
    }
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
    // roomkit.serve() has no env= param; the S3 hook reads env vars, so they ride
    // process.env for the spawn call it makes (inherited) and are restored after.
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

// ── Room 1: env SET (dummy S3) — the hook wires settings.s3 from env ──────────
// COVERS: boot:files.pb.js
console.log("\n── SET room (dummy PB_FILES_S3_*): the boot hook wires settings.s3 ──");
const set_room = new Room(8112 + PORT_OFFSET, DUMMY_S3);
const migrations_before = count_migration_files(set_room.migrations_dir);
try {
  await set_room.start();
  let tok = await superuser_token(set_room.base_url);
  let [status, s] = await api(set_room.base_url, "GET", "/api/settings", tok);
  check("GET /api/settings", status, 200);
  const s3 = py_get(s, "s3", {});
  check("s3.enabled", s3.enabled, true);
  check("s3.bucket = env", s3.bucket, DUMMY_S3.PB_FILES_S3_BUCKET);
  check("s3.endpoint = env", s3.endpoint, DUMMY_S3.PB_FILES_S3_ENDPOINT);
  check("s3.region = env", s3.region, DUMMY_S3.PB_FILES_S3_REGION);
  check("s3.accessKey = env", s3.accessKey, DUMMY_S3.PB_FILES_S3_ACCESS_KEY);
  check("s3.forcePathStyle", s3.forcePathStyle, true);
  // secret is stripped on read — never round-trips back over the API.
  check("s3.secret masked on read", s3.secret !== DUMMY_S3.PB_FILES_S3_SECRET, true);
  // Proves the hook touched settings.s3 only — the backups block stays untouched.
  check("backups.s3.enabled untouched", py_get(py_get(s, "backups", {}), "s3", {}).enabled, false);
  const migrations_after = count_migration_files(set_room.migrations_dir);
  check("boot-hook runtime save writes no migration file", migrations_after, migrations_before);
} finally {
  await set_room.stop();
  set_room.cleanup_tmp();
}

// ── Room 2: env UNSET — the hook no-ops; local-filesystem upload round-trips ──
// COVERS: boot:files.pb.js
console.log("\n── UNSET room (no PB_FILES_S3_*): hook no-ops + filesystem upload round-trip ──");
// Strip any ambient PB_FILES_* so the "unset" room genuinely sees them absent.
for (const k of Object.keys(process.env)) {
  if (k.startsWith("PB_FILES_")) delete process.env[k];
}
const unset_room = new Room(8113 + PORT_OFFSET, {}, true);
try {
  await unset_room.start();
  const tok = await superuser_token(unset_room.base_url);
  let [status, s] = await api(unset_room.base_url, "GET", "/api/settings", tok);
  check("GET /api/settings", status, 200);
  check("s3.enabled (no-op)", py_get(s, "s3", {}).enabled, false);

  // Seed alice + fixtures, then a real local-filesystem upload round-trip.
  const seed_proc = Bun.spawn([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: unset_room.base_url,
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

  let r: any;
  [status, r] = await api(
    unset_room.base_url,
    "POST",
    "/api/collections/users/auth-with-password",
    null,
    { identity: "alice@example.com", password: "test123456" },
  );
  check("alice auth-with-password", status, 200);
  const alice_tok = r.token;
  const alice_id = py_get(r, "record", {}).id;

  const payload = png_bytes(64, 64);
  let rec: any;
  [status, rec] = await multipart_patch(
    unset_room.base_url,
    "users",
    alice_id,
    alice_tok,
    "avatar",
    "me.png",
    payload,
  );
  check("avatar upload on own record (200)", status, 200);
  const avatar_name = py_get(rec, "avatar", "");
  check("stored avatar filename non-empty", truthy(avatar_name), true);

  let body: Uint8Array;
  [status, body] = await get_raw(
    unset_room.base_url,
    `/api/files/users/${alice_id}/${avatar_name}`,
  );
  check("read avatar back (200)", status, 200);
  check("read-back bytes identical to upload", Buffer.from(body).equals(payload), true);

  // The file must have landed on the ROOM's local filesystem (s3 disabled).
  const on_disk: string[] = [];
  for (const [dirpath, _dirs, names] of os_walk(path.join(unset_room.data_dir, "storage"))) {
    on_disk.push(...names.filter((n) => n === avatar_name).map((n) => py_join(dirpath, n)));
  }
  check("file landed under the room's pb_data/storage/", on_disk.length, 1);
  if (on_disk.length) {
    check("on-disk size matches upload", fs.statSync(on_disk[0]).size, payload.length);
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
}).stdout as string;
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

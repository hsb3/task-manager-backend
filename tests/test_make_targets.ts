#!/usr/bin/env bun
/** Pin Make entrypoints (CI checks and the dev stack) against stub tools, never the real ones. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pinned_pb_version } from "../scripts/pb_migrate.ts";
import {
  decode_text,
  getitem,
  py_split,
  py_str,
  read_text,
  splitlines,
  sqlite_connect,
} from "../scripts/_py.ts";

const REPO = path.dirname(import.meta.dir);

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) FAILS.push(label);
}

// An enclosing `make battery BATTERY_SHARD=i/N` passes its command-line variables down through
// MAKEFLAGS (and the environment), which would reach these stubs as if a test had set them.
const { MAKEFLAGS, MFLAGS, MAKELEVEL, BATTERY_SHARD, BATTERY_MANIFEST, ...INHERITED } = process.env;

function run(root: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["make", "--no-print-directory", ...args], {
    cwd: root,
    env: { ...INHERITED, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { returncode: r.exitCode, stdout: decode_text(r.stdout), stderr: decode_text(r.stderr) };
}

function write_exe(file: string, body: string): void {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

const unlink_missing_ok = (p: string): void => fs.rmSync(p, { force: true });

/** The scripts `bun scripts/pb_migrate.ts --print-bin` needs in a scratch tree. */
function copy_resolver(root: string): void {
  for (const name of ["pb_migrate.ts", "_py.ts", "_argparse.ts"]) {
    fs.copyFileSync(path.join(REPO, "scripts", name), path.join(root, "scripts", name));
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "make-targets-"));
  try {
    const root = scratch;
    fs.copyFileSync(path.join(REPO, "Makefile"), path.join(root, "Makefile"));
    for (const dir of ["scripts/model", "battery-manifests"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    // The gate globs these; empty files suffice because the stub bun only records its argv.
    for (const name of [
      "gen_a.ts",
      "check_b.ts",
      "check_historical_migrations.ts",
      "check_migration_citations.ts",
    ]) {
      fs.writeFileSync(path.join(root, "scripts", name), "");
    }
    fs.writeFileSync(path.join(root, "battery-manifests/battery-manifest-1.txt"), "");
    const bin_dir = path.join(root, "bin");
    fs.mkdirSync(bin_dir);
    const log = path.join(root, "calls");
    const fake_pb = path.join(bin_dir, "pocketbase");
    write_exe(fake_pb, "#!/bin/sh\nexit 0\n");
    // Records every bun call except the binary lookup, which answers with the fake binary.
    write_exe(
      path.join(bin_dir, "bun"),
      '#!/bin/sh\ncase "$*" in *--print-bin*) echo "$FAKE_PB"; exit 0;; esac\n' +
        'printf \'bun|%s\\n\' "$*" >> "$CALLS"\n' +
        '[ "$*" != "$FAIL_ARGS" ] || exit 9\n',
    );
    write_exe(
      path.join(root, "scripts/run_suite_battery.sh"),
      '#!/bin/sh\nprintf \'battery|%s\\n\' "$BATTERY_SHARD" >> "$CALLS"\n',
    );
    const env: Record<string, string> = {
      PATH: `${bin_dir}:${process.env.PATH}`,
      CALLS: log,
      FAKE_PB: fake_pb,
      PB_PORT_OFFSET: "0",
    };

    const calls = (): string[][] =>
      fs.existsSync(log) ? splitlines(read_text(log)).map((line) => py_split(line, "|", 1)) : [];
    const same = (got: unknown, want: unknown): boolean => Bun.deepEquals(got, want, true);
    const STATIC = [
      ["bun", "run format:check"],
      ["bun", "run typecheck"],
      ["bun", "scripts/gen_a.ts --check"],
      ["bun", "scripts/model/extract_current.ts --check"],
      ["bun", "scripts/check_b.ts"],
      ["bun", "scripts/check_migration_citations.ts"],
      ["bun", "scripts/check_historical_migrations.ts --staged"],
    ];

    const static_run = run(root, ["check-static"], env);
    check(
      "check-static runs format, typecheck, every generator --check, then every checker",
      static_run.returncode === 0 && same(calls(), STATIC),
    );

    unlink_missing_ok(log);
    const static_failed = run(root, ["check-static"], {
      ...env,
      FAIL_ARGS: "scripts/gen_a.ts --check",
    });
    check(
      "a failing generator --check fails check-static and stops the remaining checks",
      static_failed.returncode !== 0 && same(calls(), STATIC.slice(0, 3)),
    );

    unlink_missing_ok(log);
    const whole = run(root, ["check"], env);
    check(
      "check runs check-static, then the whole battery",
      whole.returncode === 0 && same(calls(), [...STATIC, ["battery", ""]]),
    );

    unlink_missing_ok(log);
    const whole_failed = run(root, ["check"], { ...env, FAIL_ARGS: "run typecheck" });
    check(
      "a red static part never reaches the battery",
      whole_failed.returncode !== 0 && same(calls(), STATIC.slice(0, 2)),
    );

    unlink_missing_ok(log);
    const shard = run(root, ["battery", "BATTERY_SHARD=2/4"], env);
    const shard_env = run(root, ["battery"], { ...env, BATTERY_SHARD: "3/4" });
    check(
      "battery hands BATTERY_SHARD to the battery from the command line or the environment",
      shard.returncode === 0 &&
        shard_env.returncode === 0 &&
        same(calls(), [
          ["battery", "2/4"],
          ["battery", "3/4"],
        ]),
    );

    unlink_missing_ok(log);
    const verify = run(root, ["ci-battery-verify"], env);
    check(
      "ci-battery-verify unions the downloaded shard manifests",
      verify.returncode === 0 &&
        same(calls(), [
          [
            "bun",
            "scripts/check_battery_suites.ts --manifests battery-manifests/battery-manifest-1.txt",
          ],
        ]),
    );
    fs.writeFileSync(log, "");

    // A PATH that can still run make and the row-count helpers, but offers no sqlite3.
    const nosqlite = path.join(root, "nosqlite-bin");
    fs.mkdirSync(nosqlite);
    for (const tool of ["make", "mktemp", "cp", "rm"]) {
      fs.symlinkSync(Bun.which(tool)!, path.join(nosqlite, tool));
    }
    fs.copyFileSync(path.join(bin_dir, "bun"), path.join(nosqlite, "bun"));
    fs.writeFileSync(log, "");
    const unseeded = run(root, ["seed"], { ...env, PATH: nosqlite });
    check(
      "seed without sqlite3 refuses by name instead of reading the DB as empty",
      unseeded.returncode !== 0 && unseeded.stdout.includes("sqlite3") && same(calls(), []),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "make-dev-"));
  try {
    const root = scratch;
    fs.copyFileSync(path.join(REPO, "Makefile"), path.join(root, "Makefile"));
    fs.copyFileSync(path.join(REPO, "Dockerfile"), path.join(root, "Dockerfile"));
    fs.mkdirSync(path.join(root, "scripts"));
    copy_resolver(root);
    const bin_dir = path.join(root, "bin");
    fs.mkdirSync(bin_dir);
    const log = path.join(root, "calls");
    const up_marker = path.join(root, "up");
    const fake_pb =
      "#!/bin/sh\n" +
      '[ "$1" != --version ] || { echo "pocketbase version ${FAKE_VERSION:-' +
      pinned_pb_version(REPO) +
      '}"; exit 0; }\n' +
      'printf \'%s|%s\\n\' "$0" "$*" >> "$CALLS"\n' +
      '[ "$1" != serve ] || : > "$UP_MARKER"\n' +
      '[ "$1 $2" != "superuser create" ] || [ -z "$FAIL_CREATE" ] || ' +
      '{ echo "password: Must be at least 8 character(s)."; exit 1; }\n';
    for (const fake of [path.join(bin_dir, "pb-bin"), path.join(bin_dir, "pb-old")]) {
      write_exe(fake, fake_pb);
    }
    write_exe(
      path.join(bin_dir, "curl"),
      '#!/bin/sh\nprintf \'curl|%s\\n\' "$*" >> "$CALLS"\n' +
        'case "$*" in *api/health*) [ -f "$UP_MARKER" ] && exit 0;; esac\nexit 22\n',
    );
    const env: Record<string, string> = {
      PATH: `${bin_dir}:${process.env.PATH}`,
      CALLS: log,
      UP_MARKER: up_marker,
      PB_BIN: path.join(bin_dir, "pb-bin"),
      // A git hook exports GIT_DIR, which would resolve the real main checkout's binary.
      GIT_DIR: path.join(root, "not-a-repo"),
    };

    const pb_calls = (): string[] => (fs.existsSync(log) ? splitlines(read_text(log)) : []);
    const same = (got: unknown, want: unknown): boolean => Bun.deepEquals(got, want, true);

    const fresh = (): void => {
      for (const p of [log, up_marker, path.join(root, ".env"), path.join(root, "pocketbase")]) {
        unlink_missing_ok(p);
      }
      fs.rmSync(path.join(root, "pb_data"), { recursive: true, force: true });
    };

    const seed_db = (statements: [string, string[]][]): void => {
      fs.mkdirSync(path.join(root, "pb_data"));
      const db = sqlite_connect(path.join(root, "pb_data/data.db"));
      for (const [sql, params] of statements) db.run(sql, params);
      db.close();
    };

    fresh();
    const made = run(root, ["superuser"], env);
    check(
      "superuser with PB_BIN writes a local .env and creates (never upserts) through PB_BIN",
      made.returncode === 0 &&
        read_text(path.join(root, ".env")).includes("PB_SUPERUSER_EMAIL=admin@example.com") &&
        same(pb_calls(), [
          `${path.join(bin_dir, "pb-bin")}|superuser create admin@example.com changeme123456 --dir pb_data`,
        ]) &&
        !fs.existsSync(path.join(root, "pocketbase")),
    );

    fresh();
    const refused = run(root, ["superuser"], { ...env, FAIL_CREATE: "1" });
    check(
      "a refused create routes the reader to the password repair target",
      refused.returncode !== 0 && refused.stdout.includes("make superuser-password"),
    );

    fresh();
    seed_db([
      ["create table _superusers (email text)", []],
      ["insert into _superusers values ('admin@example.com')", []],
    ]);
    fs.writeFileSync(
      path.join(root, ".env"),
      "PB_SUPERUSER_EMAIL=admin@example.com\nPB_SUPERUSER_PASSWORD=rotated-123456\n",
    );
    const repaired = run(root, ["superuser-password"], env);
    check(
      "superuser-password updates the existing superuser rather than creating one",
      repaired.returncode === 0 &&
        same(pb_calls(), [
          `${path.join(bin_dir, "pb-bin")}|superuser update admin@example.com rotated-123456 --dir pb_data`,
        ]),
    );

    fresh();
    const kept = "PB_SUPERUSER_EMAIL=real@example.com\nPB_SUPERUSER_PASSWORD=real-password-1\n";
    fs.writeFileSync(path.join(root, ".env"), kept);
    fs.copyFileSync(path.join(bin_dir, "pb-bin"), path.join(root, "pocketbase"));
    const otp = run(root, ["otp"], { ...env, PB_BIN: "" });
    check(
      "without PB_BIN an existing .env and ./pocketbase are used unchanged",
      otp.returncode === 0 &&
        read_text(path.join(root, ".env")) === kept &&
        same(pb_calls(), [
          `${path.join(fs.realpathSync(root), "pocketbase")}|superuser otp real@example.com --dir pb_data`,
        ]),
    );

    fresh();
    const old = run(root, ["pocketbase"], {
      ...env,
      PB_BIN: path.join(bin_dir, "pb-old"),
      FAKE_VERSION: "0.1.0",
    });
    check(
      "an off-version PB_BIN is refused by name and never downloaded over",
      old.returncode !== 0 &&
        old.stdout.includes("PB_BIN is not a usable binary") &&
        old.stdout.includes("0.1.0") &&
        same(pb_calls(), []),
    );

    fresh();
    const download = run(root, ["pocketbase"], { ...env, PB_BIN: "" });
    check(
      "with no PB_BIN and no ./pocketbase the pinned version is downloaded, and a failure says so",
      download.returncode !== 0 &&
        download.stdout.includes("downloading") &&
        download.stdout.includes("failed") &&
        pb_calls().some(
          (c) => c.startsWith("curl|") && c.includes(`/v${pinned_pb_version(REPO)}/`),
        ),
    );

    fresh();
    const broken = run(root, ["dev"], { ...env, FAIL_CREATE: "1" });
    check(
      "a failed superuser step names itself and PocketBase is never served",
      broken.returncode !== 0 &&
        broken.stdout.includes("superuser step") &&
        broken.stdout.includes("never started") &&
        !pb_calls().some((c) => c.includes("|serve")),
    );

    fresh();
    const booted = run(root, ["dev"], env);
    const pb_args = pb_calls()
      .filter((c) => !c.startsWith("curl|"))
      .map((c) => py_split(c, "|", 1)[1]);
    check(
      "dev creates the superuser before the first serve, on this tree's pb_data",
      same(pb_args.slice(0, 2), [
        "superuser create admin@example.com changeme123456 --dir pb_data",
        "serve --http=127.0.0.1:8090 --dir pb_data",
      ]),
    );
    check(
      "a failed seed after dev started PocketBase says it is up and stops on exit",
      booted.returncode !== 0 &&
        booted.stdout.includes("seeding failed") &&
        booted.stdout.includes("is up and will stop as this command exits"),
    );

    const create = "superuser create admin@example.com changeme123456 --dir pb_data";
    const start = "serve --http=127.0.0.1:8090 --dir pb_data";
    const installer = "__pbinstaller@example.com";
    for (const [emails, expected_calls] of [
      [[], [create, start]],
      [[installer], [create, start]],
      [["owner@example.com"], [start]],
    ] as [string[], string[]][]) {
      fresh();
      seed_db([
        ["create table _superusers (email text)", []],
        ...emails.map((e): [string, string[]] => ["insert into _superusers values (?)", [e]]),
      ]);
      const backend = run(root, ["backend"], env);
      check(
        `backend on a pb_data with superusers ${py_str(emails)} creates one only when no real one`,
        backend.returncode === 0 &&
          same(
            pb_calls(),
            expected_calls.map((c) => `${path.join(bin_dir, "pb-bin")}|${c}`),
          ),
      );
    }

    fresh();
    fs.writeFileSync(up_marker, "");
    const reused = run(root, ["dev"], env);
    check(
      "a failed seed against an already-running PocketBase does not claim to have stopped it",
      reused.returncode !== 0 &&
        reused.stdout.includes("already running") &&
        reused.stdout.includes("seeding failed (above); PocketBase is up (make reset") &&
        same(
          pb_calls(),
          pb_calls().filter((c) => c.startsWith("curl|")),
        ),
    );

    const dev_on_seeded_db = (env_text: string) => {
      fresh();
      fs.writeFileSync(path.join(root, ".env"), env_text);
      seed_db([
        ["create table _superusers (email text)", []],
        ["insert into _superusers values ('owner@example.com')", []],
        ["create table users (id text)", []],
        ["insert into users values ('alice')", []],
      ]);
      return run(root, ["dev"], env);
    };

    const fictitious = dev_on_seeded_db(
      "PB_SUPERUSER_EMAIL=admin@example.com\nPB_SUPERUSER_PASSWORD=changeme123456\n",
    );
    check(
      "dev calls the dashboard email fictitious when it is the one make env writes",
      fictitious.returncode === 0 &&
        fictitious.stdout.includes("superuser OTP via make otp") &&
        fictitious.stdout.includes("email is fictitious"),
    );

    const own = dev_on_seeded_db(
      "PB_SUPERUSER_EMAIL=real@example.com\nPB_SUPERUSER_PASSWORD=real-password-1\n",
    );
    check(
      "dev drops the fictitious claim when .env carries the reader's own dashboard email",
      own.returncode === 0 &&
        own.stdout.includes("superuser OTP via make otp") &&
        !own.stdout.includes("fictitious"),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const workflow: any = Bun.YAML.parse(read_text(path.join(REPO, ".github/workflows/ci.yml")));
const jobs = getitem(workflow, "jobs");
const runs = (job: string): string[] =>
  getitem(getitem(jobs, job), "steps").map((step: any) => step.run ?? "");
for (const [job, command] of Object.entries({
  static: "make check-static",
  battery: "make battery",
  "battery-verify": "make ci-battery-verify",
})) {
  check(`${job} calls ${command}`, runs(job).includes(command));
}
const makefile = read_text(path.join(REPO, "Makefile"));
for (const job of Object.keys(jobs)) {
  for (const [, target] of runs(job)
    .join("\n")
    .matchAll(/(?<![\w-])make\s+([a-z][\w-]*)/g)) {
    check(
      `${job}'s make ${target} is a Makefile target`,
      new RegExp(`^${target}:`, "m").test(makefile),
    );
  }
}

process.exit(FAILS.length ? 1 : 0);

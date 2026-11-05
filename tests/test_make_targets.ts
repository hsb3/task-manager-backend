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

function run(root: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["make", "--no-print-directory", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
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
    fs.mkdirSync(path.join(root, "web"));
    fs.mkdirSync(path.join(root, "web-carbon"));
    fs.mkdirSync(path.join(root, "scripts"));
    write_exe(
      path.join(root, "scripts/ci_changes.sh"),
      '#!/bin/sh\nprintf "e2e=false\\nregister_only=true\\n"\n',
    );
    const bin_dir = path.join(root, "bin");
    fs.mkdirSync(bin_dir);
    const log = path.join(root, "calls");
    for (const command of ["bun", "npm", "npx"]) {
      write_exe(
        path.join(bin_dir, command),
        "#!/bin/sh\nprintf '%s|%s|%s\\n' \"" +
          command +
          '" "$*" "$NEXT_PUBLIC_PB_URL" >> "$CALLS"\n' +
          '[ "$FAIL_COMMAND" != "' +
          command +
          '" ] || exit 9\n' +
          (command === "npm"
            ? 'if [ "$*" = "run build" ]; then\n' +
              '  [ -z "$BUILD_DELAY" ] || sleep "$BUILD_DELAY"\n' +
              '  [ "$FAIL_BUILD" != 1 ] || exit 9\n' +
              '  [ -z "$BUILD_DONE" ] || : > "$BUILD_DONE"\n' +
              "fi\n"
            : "") +
          (command === "npx"
            ? 'case "$*" in playwright\\ test*)\n' +
              '  [ "$REQUIRE_BUILD_DONE" != 1 ] || [ -f "$BUILD_DONE" ] || exit 8\n' +
              ";; esac\n"
            : ""),
      );
    }
    const env: Record<string, string> = {
      PATH: `${bin_dir}:${process.env.PATH}`,
      CALLS: log,
      PB_PORT_OFFSET: "0",
    };

    const calls = (): string[][] =>
      splitlines(read_text(log)).map((line) => py_split(line, "|", 2));
    const same = (got: unknown, want: unknown): boolean => Bun.deepEquals(got, want, true);

    const selector = run(root, ["ci-changes"], env);
    check(
      "ci-changes forwards selector output without make noise",
      selector.stdout === "e2e=false\nregister_only=true\n",
    );

    const web = run(root, ["web-gates"], env);
    check(
      "web-gates runs the exact web checks in order",
      web.returncode === 0 &&
        same(calls(), [
          ["npm", "run typecheck", ""],
          ["npm", "run lint", ""],
          ["npm", "run format:check", ""],
          ["npm", "test", ""],
          ["npm", "run codegen:check", ""],
          ["npm", "run componentmap:check", ""],
        ]),
    );

    unlink_missing_ok(log);
    const carbon = run(root, ["carbon-gates"], env);
    check(
      "carbon gates check types and tests before building",
      carbon.returncode === 0 &&
        same(calls(), [
          ["npm", "run typecheck", ""],
          ["npm", "test", ""],
          ["npm", "run build", ""],
        ]),
    );
    unlink_missing_ok(log);
    const carbon_failed = run(root, ["carbon-gates"], { ...env, FAIL_COMMAND: "npm" });
    check(
      "carbon gate failure stops the remaining checks",
      carbon_failed.returncode !== 0 && same(calls(), [["npm", "run typecheck", ""]]),
    );
    unlink_missing_ok(log);
    const carbon_e2e = run(root, ["carbon-e2e"], env);
    check(
      "carbon e2e runs the sibling harness",
      carbon_e2e.returncode === 0 && same(calls(), [["npm", "run test:e2e", ""]]),
    );

    unlink_missing_ok(log);
    const register = run(root, ["ci-register-docs"], env);
    check(
      "register target runs the exact checks in order",
      register.returncode === 0 &&
        same(calls(), [
          ["bun", "scripts/gen_feature_register.ts --check", ""],
          ["bun", "scripts/gen_status.ts --check", ""],
          ["bun", "scripts/check_doc_frontmatter.ts", ""],
          ["bun", "scripts/check_decision_citations.ts", ""],
          ["bun", "scripts/check_keep_in_sync.ts", ""],
          ["bun", "tests/test_ci_changes.ts", ""],
        ]),
    );

    unlink_missing_ok(log);
    const build = run(root, ["e2e-build"], { ...env, PB_PORT_OFFSET: "400" });
    const test = run(root, ["e2e-test", "ARGS=--shard=2/4"], env);
    const recorded = calls();
    check(
      "e2e build sets the offset room URL",
      build.returncode === 0 &&
        recorded.some((c) => same(c, ["npm", "run build", "http://127.0.0.1:8592"])),
    );
    check(
      "e2e test forwards shard arguments",
      test.returncode === 0 &&
        recorded.some((c) => same(c, ["npx", "playwright test --shard=2/4", ""])),
    );

    unlink_missing_ok(log);
    const build_done = path.join(root, "build-done");
    const ordered = run(root, ["-j2", "e2e"], {
      ...env,
      BUILD_DELAY: "0.1",
      BUILD_DONE: build_done,
      REQUIRE_BUILD_DONE: "1",
    });
    check(
      "parallel e2e waits for its build",
      ordered.returncode === 0 &&
        same(calls(), [
          ["npm", "run build", "http://127.0.0.1:8192"],
          ["npx", "playwright test", ""],
        ]),
    );

    unlink_missing_ok(log);
    unlink_missing_ok(build_done);
    const failed_build = run(root, ["-j2", "e2e"], {
      ...env,
      BUILD_DONE: build_done,
      FAIL_BUILD: "1",
    });
    check(
      "failed e2e build never starts tests",
      failed_build.returncode !== 0 &&
        same(calls(), [["npm", "run build", "http://127.0.0.1:8192"]]),
    );

    const failed = run(root, ["ci-static-checks"], { ...env, FAIL_COMMAND: "npm" });
    check("Make preserves check failure", failed.returncode !== 0);

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
    fs.mkdirSync(path.join(root, "web"));
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
    // Stands in for the web dev server so `make dev` can reach its success tail and return.
    write_exe(path.join(bin_dir, "npm"), "#!/bin/sh\nexit 0\n");
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
const expected: Record<string, string> = {
  changes: 'make ci-changes >> "$GITHUB_OUTPUT"',
  "register-docs": "make ci-register-docs",
  "static-checks": "make ci-static-checks",
  "app-docs-coverage": "make ci-app-docs",
  "suite-battery": "make battery",
  "battery-verify": "make ci-battery-verify",
  "web-gates": "make web-gates",
  "web-image": "make web-image",
  "web-e2e": "make e2e-build",
  "carbon-gates": "make carbon-gates",
  "carbon-e2e": "make carbon-e2e",
};
for (const [job, command] of Object.entries(expected)) {
  check(
    `${job} calls ${command}`,
    getitem(getitem(jobs, job), "steps").some((step: any) => step.run === command),
  );
}
check(
  "e2e test target keeps the shard expression",
  getitem(getitem(jobs, "web-e2e"), "steps").some(
    (step: any) => step.run === "make e2e-test ARGS=--shard=${{ matrix.shard }}/4",
  ),
);
const prod: any = Bun.YAML.parse(read_text(path.join(REPO, ".github/workflows/prod-smoke.yml")));
check(
  "prod smoke calls its Make target",
  getitem(getitem(getitem(prod, "jobs"), "prod-smoke"), "steps").some(
    (step: any) => step.run === "make prod-smoke",
  ),
);

process.exit(FAILS.length ? 1 : 0);

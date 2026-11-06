#!/usr/bin/env bun
// Exercise battery startup copies without booting PocketBase.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { read_text, run_checked, splitlines } from "../scripts/_py.ts";

const ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] => !e[0].startsWith("GIT_") && e[1] !== undefined,
  ),
);
const REPO = path.resolve(import.meta.dir, "..");
const BATTERY = path.join(REPO, "scripts/run_suite_battery.sh");
// Stop before the first server/binary operation; run the real startup and migration-copy function.
const STARTUP = read_text(BATTERY).split("\nensure_binary\n")[0]!;
assert.ok(STARTUP !== read_text(BATTERY), "battery startup boundary moved");
// Deliberately NOT the timestamp the real pb_migrations/ carries: the strip has to find this by
// pattern, so a literal pin anywhere in the battery fails these cases instead of passing on a match.
const MFA_FIXTURE = "1799999999_superuser_mfa.js";

// shlex.quote: a path of safe characters stays bare, anything else is single-quoted.
const shlex_quote = (s: string): string =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, `'"'"'`) + "'";

function run_case(
  holder: string,
  kind: string,
  mfa_names: string[] = [MFA_FIXTURE],
  port_plan: "ok" | "refused" = "ok",
): void {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "battery-copy-test-"));
  try {
    const root = temp;
    const repo = path.join(root, "repo");
    const scripts = path.join(repo, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(path.join(scripts, "model/current"), { recursive: true });
    fs.writeFileSync(path.join(scripts, "verification-env.sh"), ":\n");
    // The battery's startup helpers (offset parse, copy-source refusal) import it.
    fs.copyFileSync(path.join(REPO, "scripts/_py.ts"), path.join(scripts, "_py.ts"));
    // The battery runs the port-plan checker before anything else; a stub stands in for the real one.
    fs.writeFileSync(
      path.join(scripts, "check_port_collisions.ts"),
      port_plan === "ok" ? "" : 'console.log("stub: port plan refused");\nprocess.exit(1);\n',
    );
    run_checked(["git", "init", "-q", repo], { env: ENV });
    assert.ok(
      fs.statSync(path.join(repo, ".git"), { throwIfNoEntry: false })?.isDirectory(),
      "git init did not initialize the intended fixture",
    );
    const scratch = path.join(root, "scratch");
    fs.mkdirSync(scratch);
    for (const directory of ["pb_hooks", "pb_migrations"]) {
      const source = path.join(repo, directory);
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "real.js"), "// original\n");
      if (directory === "pb_migrations") {
        for (const name of mfa_names) fs.writeFileSync(path.join(source, name), "// MFA\n");
      }
    }
    const outside = path.join(root, "outside.js");
    fs.writeFileSync(outside, "// outside\n");
    const source = path.join(repo, holder);
    let linked = source;
    if (kind === "root") {
      fs.renameSync(source, path.join(repo, "real-source"));
      fs.symlinkSync(path.join(repo, "real-source"), source, "dir");
    } else if (kind !== "ordinary") {
      linked = path.join(source, "linked.js");
      if (kind === "nested") {
        fs.mkdirSync(path.join(source, "nested"));
        linked = path.join(source, "nested/linked.js");
      }
      fs.symlinkSync(outside, linked);
    }
    const script = path.join(scripts, "run_suite_battery.sh");
    fs.writeFileSync(
      script,
      STARTUP +
        `
build_migration_copies
test "$(git rev-parse --show-toplevel)" -ef "$REPO_ROOT" || { echo "fixture Git context escaped"; exit 1; }
test -f "$HOOKS_DIR/real.js" || exit 1
test -f "$LEGACY_MIGRATIONS/real.js" || exit 1
compgen -G "$LEGACY_MIGRATIONS/$MFA_MIGRATION_GLOB" >/dev/null && exit 1
compgen -G "$HARD_MIGRATIONS/$MFA_MIGRATION_GLOB" >/dev/null || exit 1
`,
    );
    const bin_dir = path.join(root, "bin");
    fs.mkdirSync(bin_dir);
    const cp = path.join(bin_dir, "cp");
    fs.writeFileSync(
      cp,
      `#!/bin/sh
printf '%s\\n' "$2" >> "$COPY_LOG"
exec ` +
        shlex_quote(Bun.which("cp")!) +
        ' "$@"\n',
    );
    fs.chmodSync(cp, 0o755);
    const copy_log = path.join(root, "copies.log");
    const env: Record<string, string> = {
      ...ENV,
      TMPDIR: scratch,
      COPY_LOG: copy_log,
      PATH: bin_dir + path.delimiter + ENV.PATH,
    };
    delete env.KEEP_SCRATCH;
    const result = Bun.spawnSync(["bash", script], { env, stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString() + result.stderr.toString();
    if (port_plan === "refused") {
      assert.ok(result.exitCode !== 0, output);
      assert.ok(output.includes("port plan refused"), output);
      assert.ok(!fs.existsSync(copy_log), `${holder}: a refused port plan still copied`);
      console.log(`✅ RED→GREEN ${holder}: a refused port plan stops the battery before any copy`);
      return;
    }
    if (mfa_names.length !== 1) {
      assert.ok(result.exitCode !== 0, output);
      assert.ok(output.includes(`found ${mfa_names.length}`), output);
      console.log(
        // Never a bare ❌: run_suite_battery.sh reads one in a suite's output as a failed check
        // even when the suite exits 0, so the glyph pair would turn this pass into a red battery.
        `✅ RED→GREEN ${holder}: ${mfa_names.length} MFA migrations refused by the pattern strip`,
      );
      return;
    }
    if (kind === "ordinary") {
      assert.ok(result.exitCode === 0, output);
    } else {
      assert.ok(result.exitCode !== 0, `${holder}/${kind} was copied`);
      assert.ok(output.includes(linked) && output.includes("symlink"), output);
      const copies = fs.existsSync(copy_log) ? splitlines(read_text(copy_log)) : [];
      assert.ok(!copies.includes(source), `${holder}/${kind} refused only after copying`);
    }
    assert.ok(fs.readdirSync(scratch).length === 0, `${holder}/${kind} leaked scratch`);
    assert.ok(read_text(outside) === "// outside\n");
    if (holder === "pb_migrations") {
      assert.ok(read_text(path.join(source, MFA_FIXTURE)) === "// MFA\n");
    }
    console.log(`✅ ${holder}/${kind}: copy/refusal, source preservation and cleanup`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function check_hook_environment(): void {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "battery-hook-sentinel-"));
  try {
    run_checked(["git", "init", "-q", sentinel], { env: ENV });
    run_checked(
      [
        "git",
        "-C",
        sentinel,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-qm",
        "sentinel",
      ],
      { env: ENV },
    );
    const git_dir = path.join(sentinel, ".git");

    const snapshot = (): Record<string, string> => {
      const refs = path.join(git_dir, "refs");
      const out: Record<string, string> = {};
      for (const p of [
        path.join(git_dir, "config"),
        path.join(git_dir, "HEAD"),
        path.join(git_dir, "index"),
        path.join(git_dir, "packed-refs"),
        ...(fs.readdirSync(refs, { recursive: true }) as string[]).map((r) => path.join(refs, r)),
      ]) {
        if (fs.statSync(p, { throwIfNoEntry: false })?.isFile()) {
          out[path.relative(git_dir, p)] = fs.readFileSync(p).toString("base64");
        }
      }
      return out;
    };

    const before = snapshot();
    const result = Bun.spawnSync([process.execPath, import.meta.path, "--hook-fixture"], {
      cwd: sentinel,
      env: {
        ...ENV,
        GIT_DIR: git_dir,
        GIT_WORK_TREE: sentinel,
        GIT_INDEX_FILE: path.join(git_dir, "index"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.ok(
      Bun.deepEquals(snapshot(), before, true),
      "poisoned hook environment changed sentinel config/refs/index",
    );
    assert.ok(result.exitCode === 0, result.stdout.toString() + result.stderr.toString());
    console.log(
      "✅ poisoned hook environment: intended fixtures initialized; sentinel config/refs/index unchanged",
    );
  } finally {
    fs.rmSync(sentinel, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if (!argv.includes("--hook-environment-check")) {
  for (const holder of ["pb_hooks", "pb_migrations"]) {
    for (const kind of ["ordinary", "root", "direct", "nested"]) run_case(holder, kind);
  }
  // Zero and two are the two ways a pattern strip goes wrong silently; both must refuse.
  for (const mfa_names of [[], [MFA_FIXTURE, "1799999998_superuser_mfa.js"]]) {
    run_case("pb_migrations", "ordinary", mfa_names);
  }
  run_case("pb_hooks", "ordinary", [MFA_FIXTURE], "refused");
}
if (!argv.includes("--hook-fixture")) check_hook_environment();

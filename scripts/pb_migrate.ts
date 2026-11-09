#!/usr/bin/env bun
/**
 * One definition of `pocketbase migrate up` for every caller that replays migrations.
 *
 * migrate_up() refuses on a non-zero exit status (PocketBase 0.40.4, pinned by the
 * Dockerfile), so every caller (scripts/gen_*.ts, scripts/check_app_docs*.ts, tests/)
 * holds one verdict in one place.
 *
 * Importable from tests/:
 *     import { pb_bin_path } from "../scripts/pb_migrate.ts";
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decode_text, py_strip, read_text } from "./_py.ts";
import { parse_args } from "./_argparse.ts";
import { copy_tree } from "./_scratch_copy.ts";

export { decode_text };

export const DOCKERFILE = path.join(
  path.dirname(path.dirname(path.resolve(import.meta.path))),
  "Dockerfile",
);
export const HOOKS = path.join(path.dirname(DOCKERFILE), "pb_hooks");

const is_file = (p: string): boolean =>
  fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
const is_executable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// os.path.join: no normalisation, an absolute right side replaces the left.
const join = (a: string, b: string): string =>
  b.startsWith("/") ? b : !a || a.endsWith("/") ? a + b : `${a}/${b}`;

/**
 * The pinned PocketBase version: `<root>/Dockerfile`'s `ARG PB_VERSION=`, the canonical site.
 *
 * `root` lets scripts/check_pb_pin.ts read a scratch mirror's Dockerfile instead of this repo's.
 */
export function pinned_pb_version(root: string | null = null): string {
  // The image is what ships, so its pin is the one every other site is held to
  // (scripts/check_pb_pin.ts); reading it here keeps this file from holding another copy.
  const dockerfile = root ? join(root, "Dockerfile") : DOCKERFILE;
  const m = /^ARG PB_VERSION=(\S+)$/m.exec(read_text(dockerfile));
  if (!m) {
    throw new Error(
      `no ARG PB_VERSION=... line in ${dockerfile} — the pin is read from there so there ` +
        `is one canonical copy; restore that line or move the pin deliberately`,
    );
  }
  return m[1]!;
}

export const VERSION_TIMEOUT_S = 10;

/** `pb --version`'s x.y.z, or "unknown" — a hung or unrunnable binary answers, never hangs. */
export function pb_version(pb: string): string {
  let r;
  try {
    r = Bun.spawnSync([pb, "--version"], { env: process.env, timeout: VERSION_TIMEOUT_S * 1000 });
  } catch {
    return "unknown";
  }
  if (r.exitedDueToTimeout) return "unknown";
  const m = /\d+\.\d+\.\d+/.exec(decode_text(r.stdout) + decode_text(r.stderr));
  return m ? m[0] : "unknown";
}

/**
 * `pb`, or a path that CANNOT exist saying why, naming both versions.
 *
 * A sentinel rather than a raise: every caller already refuses a resolved path that does
 * not exist, with its own `❌`/exit line, and a library exception at their module-level
 * `PB = pb_bin_path(REPO)` would replace that with a traceback. Applied to every branch of
 * pb_bin_path — the pin is a property of the binary, not of how it was located, and
 * run_suite_battery.sh already refuses an off-version $PB_BIN.
 */
export function version_checked(pb: string): string {
  if (!(is_file(pb) && is_executable(pb))) {
    return `${pb} (not an executable file)`;
  }
  const want = pinned_pb_version();
  const got = pb_version(pb);
  if (got !== want) {
    return (
      `${pb} (is PocketBase ${got}, want ${want} — pinned by the Dockerfile's ARG PB_VERSION; ` +
      `a replay against the wrong version generates artifacts this repo cannot vouch ` +
      `for, so point PB_BIN at a matching binary or run \`make pocketbase\`)`
    );
  }
  return pb;
}

/**
 * Resolve the pocketbase binary: $PB_BIN, then this tree's own, then the main checkout's.
 *
 * A linked worktree has no ./pocketbase of its own — `git rev-parse --git-common-dir`
 * names the main checkout, which does. A probed path counts only if it is an executable
 * FILE (access alone passes a directory). When none of the three qualify, returns a
 * path that cannot exist and names BOTH places looked. A binary that IS found is
 * version_checked, which refuses the same way — every failure here is a path the caller's
 * own `no ./pocketbase at ...` refusal reports, so that stays the one error path.
 */
export function pb_bin_path(repo: string): string {
  const env = process.env.PB_BIN;
  if (env) {
    return version_checked(env);
  }
  const own = join(repo, "pocketbase");
  if (is_file(own) && is_executable(own)) {
    return version_checked(own);
  }
  let r;
  try {
    r = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { env: process.env, cwd: repo });
  } catch {
    return version_checked(own);
  }
  const out = py_strip(decode_text(r.stdout));
  if (r.exitCode !== 0 || !out) {
    return version_checked(own);
  }
  const common = join(repo, out);
  const main = join(path.dirname(path.resolve(common)), "pocketbase");
  if (main === own) {
    return version_checked(own);
  }
  if (is_file(main) && is_executable(main)) {
    return version_checked(main);
  }
  return `${own} (also looked: ${main})`;
}

/**
 * Apply `migrations_dir` into `data_dir` with hooks loaded. Returns [ok, combined output].
 *
 * Hooks: `hooks_dir`, else $PB_HOOKS_DIR, else a throwaway copy of this repo's pb_hooks/.
 * Throws when the chosen dir IS the live pb_hooks/ (PB watches its hooksDir).
 */
export function migrate_up(
  pb: string,
  data_dir: string,
  migrations_dir: string,
  cwd: string | null = null,
  hooks_dir: string | null = null,
): [boolean, string] {
  hooks_dir = hooks_dir || process.env.PB_HOOKS_DIR || null;
  if (hooks_dir && realpath(hooks_dir) === realpath(HOOKS)) {
    throw new Error(
      `hooks dir ${hooks_dir} is the live repo pb_hooks/ — PB watches its hooksDir, so ` +
        `pass a scratch copy (tests/roomkit.ts hooks_dir) or leave it unset for a throwaway one`,
    );
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"));
  let r;
  try {
    if (!hooks_dir) {
      hooks_dir = path.join(scratch, "pb_hooks");
      copy_tree(HOOKS, hooks_dir);
    }
    // Without --hooksDir (the Dockerfile CMD passes it too) no model-tier guard sees a save.
    r = Bun.spawnSync(
      [
        pb,
        "migrate",
        "up",
        "--dir",
        data_dir,
        "--migrationsDir",
        migrations_dir,
        "--hooksDir",
        hooks_dir,
      ],
      { env: process.env, cwd: cwd ?? undefined },
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const out = decode_text(r.stdout) + decode_text(r.stderr);
  // KEEP IN SYNC: Dockerfile's CMD preflight — same `exitCode` verdict (check_raw_migrate_up.ts reconciles the two).
  const ok = r.exitCode === 0;
  return [ok, out];
}

if (import.meta.main) {
  // Mostly a library — the one CLI mode lets a caller that cannot import it (a shell script)
  // resolve the same binary this repo's callers do, instead of re-implementing it.
  const usage = "usage: pb_migrate.ts [-h] [--print-bin]";
  const args = parse_args(
    usage,
    `${usage}

Library: import migrate_up()/pb_bin_path(). --print-bin is the one CLI mode.

options:
  -h, --help   show this help message and exit
  --print-bin  print pb_bin_path() for this file's own repo and exit
`,
    [["--print-bin", "store_true", "print_bin"]],
    { print_bin: false },
  );
  if (args.print_bin) {
    console.log(pb_bin_path(path.dirname(path.dirname(path.resolve(import.meta.path)))));
  } else {
    console.log("pb_migrate is a library — import migrate_up() / pb_bin_path().");
  }
}

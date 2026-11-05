#!/usr/bin/env bun
/**
 * CI / pre-commit check: every PB_VERSION pin site must equal the Dockerfile's canonical ARG.
 *
 * The Dockerfile's `ARG PB_VERSION=` line (scripts/pb_migrate.ts's pinned_pb_version) is the one
 * site every other copy is held to — a bump there and not everywhere else builds CI or a local
 * dev binary against a different PocketBase than the shipped image, silently. Every tracked text
 * file under root is scanned for the literal pattern `PB_VERSION` + `=`/`:=`/`:` + an optional
 * quote (single or double) + a semver, never a comment marker, so a NEW site anywhere is held too. Not proven: a job
 * that hardcodes a version in its download URL without a PB_VERSION variable is invisible to this
 * pattern. Port of ~/Developer/kit-pb/scripts/check-pb-pin.mjs.
 *
 * Usage:
 *     bun scripts/check_pb_pin.ts [--root DIR]
 */

import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  decode_text,
  os_error_text,
  os_walk,
  py_join,
  py_strip,
  read_text,
  splitlines,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import { pinned_pb_version } from "./pb_migrate.ts";

export const REPO = repo_root(import.meta.path);

export const PIN_RE = /PB_VERSION\s*(?::=|[:=])\s*["']?(\d+\.\d+\.\d+)["']?/g;

export const REQUIRED_SITES = [
  "Makefile",
  ".github/workflows/ci.yml",
  "scripts/run_suite_battery.sh",
];

// Only used when `root` is not a git work tree (a scratch mirror, a `git archive` extract).
// DECLARED SKIP: untracked build/dependency/data dirs; `git ls-files` never lists them either.
export const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "pb_data",
  "playwright-report",
  "test-results",
]);

/** Repo-relative paths this gate scans: `git ls-files`, or a walk when root has no `.git`. */
export function _tracked_files(root: string): string[] {
  const proc = Bun.spawnSync(["git", "-C", root, "ls-files"], { env: process.env });
  const out = decode_text(proc.stdout);
  if (proc.exitCode === 0 && py_strip(out)) return splitlines(out);
  const found: string[] = [];
  for (const [dirpath, dirnames, filenames] of os_walk(root)) {
    // DECLARED SKIP: see SKIP_DIR_NAMES
    dirnames.splice(0, dirnames.length, ...dirnames.filter((d) => !SKIP_DIR_NAMES.has(d)));
    for (const name of filenames) found.push(path.relative(root, py_join(dirpath, name)));
  }
  return found.sort(by_code_point);
}

/** File text, or null when it is not UTF-8 (a binary this gate cannot scan). */
export function _read(root: string, rel: string): string | null {
  try {
    return read_text(path.join(root, rel));
  } catch {
    return null;
  }
}

/** relpath -> [[1-based line, found version], ...] for every PB_VERSION pin match. */
export function _sites(root: string): Map<string, [number, string][]> {
  const sites = new Map<string, [number, string][]>();
  for (const rel of _tracked_files(root)) {
    const text = _read(root, rel);
    if (text === null) continue;
    const matches: [number, string][] = [...text.matchAll(PIN_RE)].map((m) => [
      text.slice(0, m.index).split("\n").length,
      m[1]!,
    ]);
    if (matches.length) sites.set(rel, matches);
  }
  return sites;
}

export function main(): number {
  const prog = path.basename(import.meta.path);
  const usage = `usage: ${prog} [-h] [--root ROOT]`;
  const args = parse_args(
    usage,
    `${usage}\n\nCI / pre-commit check: every PB_VERSION pin site must equal the Dockerfile's\ncanonical ARG.\n\n` +
      `options:\n  -h, --help   show this help message and exit\n` +
      `  --root ROOT  tree to check (default: this repo)\n`,
    [["--root", "store", "root"]],
    { root: REPO },
  );
  const root = path.resolve(args.root);

  let canonical: string;
  try {
    canonical = pinned_pb_version(root);
  } catch (exc) {
    const msg = (exc as Error).message;
    // pinned_pb_version's RuntimeError is printed as is; an OSError gets Python's str() text
    const text = msg.startsWith("no ARG PB_VERSION=")
      ? msg
      : os_error_text(exc, path.join(root, "Dockerfile"));
    console.log(`❌ check_pb_pin: ${text}`);
    return 1;
  }

  const sites = _sites(root);
  const errors: string[] = [];

  for (const required of REQUIRED_SITES) {
    if (!sites.has(required)) {
      errors.push(
        `${required} has no PB_VERSION pin — a site rewritten out of this pattern ` +
          `must refuse, not vanish silently`,
      );
    }
  }

  let total = 0;
  for (const rel of [...sites.keys()].sort(by_code_point)) {
    for (const [line, version] of sites.get(rel)!) {
      total += 1;
      if (version !== canonical) {
        errors.push(
          `${rel}:${line} pins PocketBase ${version}, the Dockerfile's ARG ` +
            `PB_VERSION is ${canonical}`,
        );
      }
    }
  }

  if (errors.length) {
    console.log("❌ check_pb_pin: PB_VERSION drift:");
    for (const e of errors) {
      console.log(`     • ${e}`);
    }
    return 1;
  }

  console.log(
    `✅ check_pb_pin: PocketBase ${canonical} — ${total} site(s) in ${sites.size} ` +
      `file(s) agree with the Dockerfile's ARG PB_VERSION.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

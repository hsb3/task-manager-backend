#!/usr/bin/env bun
/**
 * Historical-migration-edit guard, shared by the PreToolUse hook and the git pre-commit hook.
 *
 * CLAUDE.md migration law: a pb_migrations/ file already on origin/main is read-only — it
 * already ran. The one exception is a comment fix, because a false comment is fixable where a
 * reader lands on it but a comment runs nothing, so it can never touch behaviour. This module
 * holds that comment-only predicate ONCE:
 *
 * - `--tool-input` (stdin: a PreToolUse JSON payload) is the exact decision
 *   .claude/hooks/protect_historical_migrations/hook.sh delegates to: an Edit is allowed iff
 *   old_string and new_string are both comment-only and differ; anything else (Write included —
 *   a whole-file replacement can't be checked line-by-line) is refused outright.
 * - `--staged` is what lefthook.yml's pre-commit job calls: every staged pb_migrations/*.js file that
 *   already exists on origin/main (falling back to main) must have EVERY changed line —
 *   added or removed — be comment-only; a staged delete or rename of such a file is refused
 *   regardless of content.
 *
 * Exit 0 = allow, 1 = refuse.
 */

import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { decode_text, print, py_strip, run_checked, splitlines } from "./_py.ts";

export const COMMENT_PREFIXES = ["//", "/*", "*", "*/", "#"];

// Names the marker migration of a one-event guard suspension, or None (armed). decision-069
// (kata dzdh) set it for the pb1e one-baseline rebuild; that rebuild landed and re-armed it.
// There is no env var, CLI flag or file that turns the guard off: it is a source edit a PR reviews.
export const BASELINE_REBUILD_SUSPENSION: string | null = null;

/** A blank or comment-prefixed line — the syntactic unit both modes gate on. */
export function is_comment_line(line: string): boolean {
  const s = py_strip(line);
  return !s || COMMENT_PREFIXES.some((p) => s.startsWith(p));
}

/** Absent text (e.g. a pure deletion) is vacuously comment-only; each line is checked. */
export function text_is_comment_only(text: string | null | undefined): boolean {
  return splitlines(text || "").every(is_comment_line);
}

// Python `payload.get(key)`: a non-dict payload raises, it is not silently empty.
function get(d: any, key: string): any {
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    throw new Error("object has no attribute 'get'");
  }
  return d[key] ?? null;
}

export function check_tool_input(payload: any): [boolean, string] {
  if (get(payload, "tool_name") !== "Edit") {
    return [false, "not an Edit (comment-only fixes use Edit, never Write)"];
  }
  const d = get(payload, "tool_input") || {};
  const [old, new_] = [get(d, "old_string"), get(d, "new_string")];
  if (!(text_is_comment_only(old) && text_is_comment_only(new_))) {
    return [false, "old_string/new_string touch a non-comment line"];
  }
  if (old === new_) return [false, "old_string and new_string are identical"];
  return [true, "comment-only edit"];
}

export function resolve_ref(cwd: string | null = null): string | null {
  for (const ref of ["origin/main", "main"]) {
    const r = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], {
      stdout: "ignore",
      stderr: "ignore",
      cwd: cwd ?? undefined,
    });
    if (r.exitCode === 0) return ref;
  }
  return null;
}

/**
 * (status, path) for staged pb_migrations/*.js entries that exist on ref — --cached <ref>
 * diffs the ref straight against the index, so this already IS the staged-vs-historical set.
 */
export function staged_historical_migrations(ref: string): [string, string][] {
  const out = run_checked(
    ["git", "diff", "--cached", ref, "--name-status", "-M", "--", "pb_migrations/*.js"],
    { capture_output: true, text: true },
  ).stdout!;
  const entries: [string, string][] = [];
  for (const line of splitlines(out)) {
    if (!line) continue;
    const [status, ...paths] = line.split("\t");
    entries.push([status!, paths[0]!]);
  }
  return entries;
}

export function first_offending_diff_line(ref: string, path: string): string | null {
  const diff = run_checked(["git", "diff", "--cached", ref, "--", path], {
    capture_output: true,
    text: true,
  }).stdout!;
  for (const line of splitlines(diff)) {
    if (["+++", "---", "diff --git", "index ", "@@"].some((p) => line.startsWith(p))) continue;
    if ((line.startsWith("+") || line.startsWith("-")) && !is_comment_line(line.slice(1))) {
      return line;
    }
  }
  return null;
}

export function in_rev(rev: string | null, path: string, cwd: string | null = null): boolean {
  return (
    rev !== null &&
    Bun.spawnSync(["git", "cat-file", "-e", `${rev}:${path}`], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: cwd ?? undefined,
    }).exitCode === 0
  );
}

export function branch_point(ref: string): string | null {
  const base = Bun.spawnSync(["git", "merge-base", "HEAD", ref], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return base.exitCode === 0 ? py_strip(decode_text(base.stdout)) : null;
}

export function check_staged(): [boolean, string] {
  const ref = resolve_ref();
  if (ref === null) return [true, "no origin/main or main to compare against"];
  const problems: string[] = [];
  const base = branch_point(ref);
  for (const [status, path] of staged_historical_migrations(ref)) {
    if (status.startsWith("A")) continue; // not on ref yet — a brand-new migration, not a historical one
    if ("DR".includes(status[0]!) && !in_rev("HEAD", path) && !in_rev(base, path)) {
      continue; // main added it after this branch left: behind, not deleting
    }
    if (status.startsWith("D")) {
      problems.push(`${path}: deleted — historical migrations are never removed`);
    } else if (status.startsWith("R")) {
      problems.push(`${path}: renamed — historical migrations are never renamed`);
    } else {
      const offending = first_offending_diff_line(ref, path);
      if (offending !== null) problems.push(`${path}: non-comment change — ${offending}`);
    }
  }
  if (problems.length) return [false, problems.join("; ")];
  return [true, "ok"];
}

/** ARMED (guard as written) | SUSPENDED (decision-069's window) | EXPIRED (rebuild landed). */
export function suspension_state(marker_on_ref: boolean): string {
  if (BASELINE_REBUILD_SUSPENSION === null) return "ARMED";
  return marker_on_ref ? "SUSPENDED" : "EXPIRED";
}

/** The whole message a caller prints for a non-ARMED state — only here is the state known. */
export function suspension_message(state: string): string {
  if (state === "SUSPENDED") {
    return (
      "ALLOWED UNCHECKED: decision-069 (kata dzdh) suspends the historical-migration " +
      `guard until the one-baseline rebuild drops pb_migrations/${BASELINE_REBUILD_SUSPENSION}.`
    );
  }
  return (
    "the baseline rebuild has landed on the comparison ref " +
    `(pb_migrations/${BASELINE_REBUILD_SUSPENSION} is gone), so decision-069's one-event ` +
    "suspension is over and every pb_migrations/ change is refused: lift it by setting " +
    "BASELINE_REBUILD_SUSPENSION = null in scripts/check_historical_migrations.ts."
  );
}

/** The whole message an ARMED refusal prints: what tripped, then what to do instead. */
export function refusal_message(reason: string): string {
  return (
    `Blocked: ${reason}\n` +
    "A pb_migrations/ file already on the comparison ref is read-only: historical migrations " +
    "are never edited, deleted or renamed (CLAUDE.md migration law). Write a NEW migration " +
    "instead; `make next-migration-slot` prints the next free timestamp.\n" +
    "Correcting a FALSE COMMENT is the one exception: use Edit (not Write) with only comment " +
    "lines on both sides. Wrong behaviour is never fixed here — it already ran; supersede it " +
    "with a new migration."
  );
}

/** An unresolvable ref cannot prove the rebuild landed, so it reads as still-suspended. */
export function marker_on_ref(cwd: string | null = null): boolean {
  const ref = resolve_ref(cwd);
  return ref === null || in_rev(ref, `pb_migrations/${BASELINE_REBUILD_SUSPENSION}`, cwd);
}

export async function main(): Promise<number> {
  const prog = path.basename(process.argv[1] ?? "");
  const usage = `usage: ${prog} [-h] (--tool-input | --staged)`;
  const args = parse_args(
    usage,
    `${usage}

Historical-migration-edit guard, shared by the PreToolUse hook and the git
pre-commit hook. CLAUDE.md migration law: a pb_migrations/ file already on
origin/main is read-only — it already ran. The one exception is a comment fix,
because a false comment is fixable where a reader lands on it but a comment
runs nothing, so it can never touch behaviour. This module holds that comment-
only predicate ONCE: - \`--tool-input\` (stdin: a PreToolUse JSON payload) is
the exact decision .claude/hooks/protect_historical_migrations/hook.sh
delegates to: an Edit is allowed iff old_string and new_string are both
comment-only and differ; anything else (Write included — a whole-file
replacement can't be checked line-by-line) is refused outright. - \`--staged\`
is what lefthook.yml's pre-commit job calls: every staged pb_migrations/*.js
file that already exists on origin/main (falling back to main) must have EVERY
changed line — added or removed — be comment-only; a staged delete or rename
of such a file is refused regardless of content. Exit 0 = allow, 1 = refuse.

options:
  -h, --help    show this help message and exit
  --tool-input  read a PreToolUse JSON on stdin
  --staged      check the staged git index
`,
    [
      ["--tool-input", "store_true", "tool_input"],
      ["--staged", "store_true", "staged"],
    ],
    { tool_input: false, staged: false },
    undefined,
    [{ required: true, dests: ["tool_input", "staged"] }],
  );

  // stdin is drained before any early return: hook.sh pipes into us under `set -o pipefail`,
  // where an unread stdin SIGPIPEs the writer and the pipeline reads as a refusal.
  const raw = args.tool_input ? decode_text(await Bun.stdin.bytes()) : "";

  // EXPIRED is the tripwire that stops the suspension above being forgotten: it is red only
  // between the rebuild landing and the re-arm PR, both of which the same lane owns.
  // tests/test_historical_migration_guard.ts asserts the live state here is not EXPIRED, so
  // make check and CI raise that alarm too, not lefthook.yml's staged-paths job alone.
  const state = suspension_state(marker_on_ref());
  if (state !== "ARMED") {
    print(suspension_message(state));
    return state === "SUSPENDED" ? 0 : 1;
  }

  let ok: boolean, reason: string;
  if (args.tool_input) {
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch (exc) {
      print(`unparsable PreToolUse payload: ${(exc as Error).message}`);
      return 1;
    }
    [ok, reason] = check_tool_input(payload);
  } else {
    [ok, reason] = check_staged();
  }

  // An ARMED allow says everything in its exit code; the banners above are the load-bearing ones.
  if (!ok) print(refusal_message(reason));
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main());

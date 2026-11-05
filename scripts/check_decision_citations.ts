#!/usr/bin/env bun
/**
 * Gate: every `decision:<slug>` cited in a repo file names a registered decision, and no
 * numbered `decision-NNN` citation survives outside docs/generated/.
 *
 * Scans git-tracked files plus untracked, non-ignored ones (a new file cites before it is
 * added); `--staged` (the pre-commit hook) scans the index instead, register included, so the
 * verdict is about what the commit records. The register (docs/generated/decisions.md) holds one
 * `- **Slug:**` row per decision record; an empty register fails every slug citation. A slug
 * preceded by a word character or `.` is PocketBase rule text (`@request.body.decision:isset`),
 * not a citation. Needs no server and no kata daemon.
 *
 * Usage: bun scripts/check_decision_citations.ts [--repo DIR] [--register FILE] [--staged]
 */

import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { py_int, py_strip, read_text } from "./_py.ts";

export const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));
export const NUMBERED = /(?<![\p{L}\p{N}_])decision-(\p{Nd}{3})(?![\p{L}\p{N}_])/giu;
// KEEP IN SYNC: scripts/gen_decisions.ts DECISION_SLUG name part `[a-z0-9]+([-_][a-z0-9]+)*`
const NAME = "[a-z0-9]+([-_][a-z0-9]+)*";
export const SLUG = new RegExp(`(?<![\\p{L}\\p{N}_.])decision:(${NAME})(?![\\p{L}\\p{N}_-])`, "gu");
// `^` per line: after "\n" only (JS's `m` flag would also break on \r and U+2028/9).
export const REGISTER_SLUG = new RegExp(
  `(?<![^\\n])- \\*\\*Slug:\\*\\* \`decision:(${NAME})\``,
  "gu",
);
export const GENERATED = "docs/generated/";
// Fixture files that hold probe slugs on purpose; nothing else is exempt.
export const EXEMPT = new Set([
  "tests/test_gen_decisions.ts", // renderer probes: unregistered and malformed slugs
  "tests/test_name_validation.ts", // slug-shape probes: unregistered and malformed slugs
  "tests/test_decision_citations_checker.ts", // this gate's own planted citations
]);

export function git(repo: string, ...argv: string[]): [number, string, string] {
  // Bytes, decoded by hand: text mode would turn a lone CR into a record break.
  const r = Bun.spawnSync(["git", "-C", repo, ...argv]);
  const dec = new TextDecoder("utf-8");
  return [r.exitCode ?? -1, dec.decode(r.stdout), dec.decode(r.stderr)];
}

export function read_register(repo: string, register_path: string, staged: boolean): string {
  const rel = path.relative(repo, register_path);
  if (staged && !rel.startsWith("..")) {
    const [status, shown] = git(repo, "show", `:${rel}`);
    if (status === 0) return shown;
  }
  return read_text(register_path);
}

/** (path, lineno, line) for every text line naming a decision, from the index or the tree. */
export function* citing_lines(repo: string, staged: boolean): Generator<[string, number, string]> {
  const source = staged ? "--cached" : "--untracked";
  const [status, text, err] = git(
    repo,
    "grep",
    source,
    "-z",
    "-n",
    "-I",
    "-i",
    "-e",
    "decision-",
    "-e",
    "decision:",
    "--",
    ".",
  );
  if (status !== 0 && status !== 1) {
    // 1 = no match
    process.stderr.write(`check_decision_citations: git grep failed: ${py_strip(err)}\n`);
    process.exit(1);
  }
  // -z ends the path and line number with NUL but the matched text with a newline, so a path
  // may itself hold a newline: walk field by field instead of splitting records.
  let pos = 0;
  while (pos < text.length) {
    const rel_end = text.indexOf("\0", pos);
    const num_end = text.indexOf("\0", rel_end + 1);
    let line_end = text.indexOf("\n", num_end + 1);
    line_end = line_end === -1 ? text.length : line_end;
    yield [
      text.slice(pos, rel_end),
      py_int(text.slice(rel_end + 1, num_end)),
      text.slice(num_end + 1, line_end),
    ];
    pos = line_end + 1;
  }
}

const HELP = `usage: check_decision_citations.ts [-h] [--repo REPO] [--register REGISTER]
                                   [--staged]

Gate: every \`decision:<slug>\` cited in a repo file names a registered
decision, and no numbered \`decision-NNN\` citation survives outside
docs/generated/. Scans git-tracked files plus untracked, non-ignored ones (a
new file cites before it is added); \`--staged\` (the pre-commit hook) scans the
index instead, register included, so the verdict is about what the commit
records. The register (docs/generated/decisions.md) holds one \`- **Slug:**\`
row per decision record; an empty register fails every slug citation. A slug
preceded by a word character or \`.\` is PocketBase rule text
(\`@request.body.decision:isset\`), not a citation. Needs no server and no kata
daemon. Usage: bun scripts/check_decision_citations.ts [--repo DIR] [--register
FILE] [--staged]

options:
  -h, --help           show this help message and exit
  --repo REPO          repo root to scan (default: this checkout)
  --register REGISTER  decisions register path (default:
                       <repo>/docs/generated/decisions.md)
  --staged             scan the staged blobs (what a commit records) instead
                       of the working tree`;

export function main(): number {
  const args = parse_args(
    HELP.slice(0, HELP.indexOf("\n\n")),
    HELP + "\n",
    [
      ["--repo", "store", "repo"],
      ["--register", "store", "register"],
      ["--staged", "store_true", "staged"],
    ],
    { repo: REPO, register: null, staged: false },
  );
  const staged: boolean = args.staged;

  const repo = path.resolve(args.repo);
  const register_path = args.register
    ? path.resolve(args.register)
    : path.join(repo, "docs", "generated", "decisions.md");

  const registered = new Set(
    [...read_register(repo, register_path, staged).matchAll(REGISTER_SLUG)].map((m) => m[1]!),
  );
  const empty = registered.size ? "" : " (register is empty)";

  const misses: string[] = [];
  let cited = 0;
  for (const [rel, lineno, line] of citing_lines(repo, staged)) {
    if (EXEMPT.has(rel)) continue;
    for (const m of line.matchAll(SLUG)) {
      cited += 1;
      if (!registered.has(m[1]!)) {
        misses.push(`${rel}:${lineno}: decision:${m[1]} names no registered decision${empty}`);
      }
    }
    if (rel.startsWith(GENERATED)) continue;
    for (const m of line.matchAll(NUMBERED)) {
      misses.push(`${rel}:${lineno}: ${m[0]} is a numbered citation; cite decision:<slug>`);
    }
  }

  if (misses.length) {
    console.log(`❌ check_decision_citations: ${misses.length} unresolved citation(s)`);
    for (const miss of misses) {
      console.log(`  - ${miss}`);
    }
    console.log(
      "   Cite a decision by its app_docs slug decision:<slug>; a new decision needs its " +
        "app_docs record seeded, then: bun scripts/gen_decisions.ts",
    );
    return 1;
  }
  console.log(
    `✅ check_decision_citations: ${cited} citation(s), all ${registered.size} registered ` +
      "decisions resolve",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

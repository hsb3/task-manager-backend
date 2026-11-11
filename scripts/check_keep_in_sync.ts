#!/usr/bin/env bun
/**
 * CI / gate check: every KEEP IN SYNC marker's machine-resolvable referent still resolves.
 *
 * A `KEEP IN SYNC` marker is the repo's only record that two spellings of one fact must move
 * together, and until this gate nothing verified one. It checks the half a machine can read.
 *
 * The marker is the LINE carrying the words — continuation prose below it is not scanned, because
 * a wrapped sentence is where the operands stop being operands. Two kinds of referent come off
 * that line:
 *
 *   named file  — a path or bare filename with a source extension ("realtime.pb.js",
 *                 "pb_hooks/lib/workspace_rules.js"). Resolved against the repo root, then
 *                 against every ancestor directory of the marker's own file ("lib/workspace_rules.js"
 *                 from inside pb_hooks/), then by unique basename.
 *   literal     — the inner text of a backticked or double-quoted span. Delimiters are dropped,
 *                 so JSON's \" escaping cannot hide an otherwise identical match.
 *
 * The assertions, and only these:
 *
 *   1. every named file resolves to an existing file;
 *   2. a marker that names at least one resolved file quotes at least one literal that is really
 *      mirrored. Naming a file and quoting nothing verifiable is refused: such a marker is
 *      counted as enforced while the only thing checked is that a path exists;
 *   3. a mirrored literal appears in the body of EVERY member of its mirror set — the named
 *      file (or files) plus the marker's own file. Present everywhere is a live mirror; present
 *      in some and not others is exactly one side of a pair having moved. A body is the file
 *      with every KEEP IN SYNC comment run masked out, so no marker can satisfy another
 *      marker's claim with its own prose, and a whole-line comment outside Markdown is not
 *      presence either. A `KEEP IN SYNC (below)` marker narrows its own
 *      file's side to the BELOW_LINES code lines under its comment run, for a fact inlined at
 *      several sites of one file, where any other site would otherwise stand in for a moved one;
 *   4. a plain-form literal sits on at most one code line of its own file's body, since
 *      otherwise one of its sites can move unseen; such a fact takes the `(below)` form at
 *      each site. A whole-line comment is never a site, here or in a `(below)` window.
 *
 * FREE-FORM PROSE to this gate is a marker naming no file at all, and a literal on such a
 * marker. Those are counted and printed on every run (--table names them), never silently
 * stepped over, and never enforced.
 *
 * Bounds, all in the run output: prose markers are unenforced; a name matching several files by
 * basename is unresolvable, not an error; matching is substring, bounded at whichever edge of
 * the literal is itself a word character, so `5` does not match `15` while `--http=` matches
 * wherever those characters run; a literal is verified present, never semantically equivalent,
 * so a short or common token (`5`, `true`, a bare loop index) that happens to occur on both
 * sides reads as a live mirror and gates nothing — the choice of literal is still the author's
 * to get right; a referent that only continuation prose names is not seen at all.
 *
 * Usage:
 *     bun scripts/check_keep_in_sync.ts [--root DIR] [--table]
 *     bun scripts/check_keep_in_sync.ts --print-sites   # every file a verdict reads
 *
 */

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  decode_text,
  print,
  py_join,
  py_lstrip,
  py_repr,
  py_strip,
  read_text as read_file,
  splitlines,
  UnicodeDecodeError,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";

export const REPO = repo_root(import.meta.path);
export const SELF = path.basename(import.meta.path);

export const MARKER = "KEEP IN SYNC";
export const BELOW = `${MARKER} (below)`;
export const BELOW_LINES = 6;

export const PRUNE_DIR_NAMES = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "pb_data",
  "playwright-report",
  "test-results",
]);
// A generated tree copies its source's markers; the source is the only site a fix can land at.
export const PRUNE_REL_PREFIXES = ["docs/generated/"];

// \w is Unicode-aware in Python: letters, numbers and underscore.
const W = String.raw`[\p{L}\p{N}_]`;
export const FILE_EXTS = "js|mjs|cjs|ts|tsx|jsx|py|sh|json|yml|yaml|md|css|toml|sql";
export const FILE_TOKEN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_./-])((?:[\p{L}\p{N}_.@()\[\]+-]+/)*[\p{L}\p{N}_.@+-]+\.(?:` +
    FILE_EXTS +
    String.raw`))(?![\p{L}\p{N}_/-])`,
  "gu",
);
export const BACKTICKED = /`([^`]+)`/gu;
export const DOUBLE_QUOTED = /"([^"]+)"/gu;
export const COMMENT_PREFIXES = ["//", "#", "*", "--"];

const findall = (re: RegExp, s: string): string[] => [...s.matchAll(re)].map((m) => m[1]!);
const cp_len = (s: string): number => [...s].length;

/**
 * Root-relative paths of every tracked file; `root` must be a git work tree.
 *
 * Names come from the index, bytes from disk.
 */
export function scan_files(root: string): string[] {
  // An untracked file, ignored or not, is not source; a new file is checked once staged.
  const proc = Bun.spawnSync(["git", "-C", root, "ls-files", "--cached", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${root} is not a git work tree: ${py_strip(decode_text(proc.stderr))}`);
  }

  const found: string[] = [];
  for (const rel of decode_text(proc.stdout).split("\0")) {
    if (!rel) continue;
    const parts = rel.split("/");
    if (parts.slice(0, -1).some((d) => PRUNE_DIR_NAMES.has(d))) continue;
    if (PRUNE_REL_PREFIXES.some((p) => rel.startsWith(p)) || parts[parts.length - 1] === SELF) {
      continue;
    }
    // Indexed but deleted from the working tree — nothing left to read.
    if (!fs.statSync(py_join(root, rel), { throwIfNoEntry: false })?.isFile()) continue;
    found.push(rel);
  }
  return found.sort(by_code_point);
}

/** File text, or None when the bytes are not UTF-8 text this gate can search. */
export function read_text(root: string, rel: string): string | null {
  try {
    return read_file(py_join(root, rel));
  } catch (e) {
    if (e instanceof UnicodeDecodeError || typeof (e as any)?.code === "string") return null;
    throw e;
  }
}

export function comment_prefix(line: string): string | null {
  const stripped = py_lstrip(line);
  for (const prefix of COMMENT_PREFIXES) {
    if (stripped.startsWith(prefix)) return prefix;
  }
  return null;
}

/** File text with every marker's whole comment run blanked — prose is not a site. */
export function marker_body(lines: string[]): string {
  const masked = [...lines];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(MARKER)) continue;
    const prefix = comment_prefix(line);
    masked[i] = "";
    if (prefix === null) continue;
    let j = i - 1;
    while (j >= 0 && comment_prefix(lines[j]!) === prefix) {
      masked[j] = "";
      j -= 1;
    }
    j = i + 1;
    while (j < lines.length && comment_prefix(lines[j]!) === prefix) {
      masked[j] = "";
      j += 1;
    }
  }
  return masked.join("\n");
}

/** Inner text of each backticked then double-quoted span, delimiters dropped. */
export function literals_of(line: string): string[] {
  const found = findall(BACKTICKED, line).filter((m) => py_strip(m));
  const remainder = line.replace(BACKTICKED, " ");
  found.push(...findall(DOUBLE_QUOTED, remainder).filter((m) => py_strip(m)));
  return [...new Set(found)];
}

const occurrence_cache = new Map<string, RegExp>();

/** Bound each edge of the literal that is itself a word character; leave punctuation free. */
export function occurrence(literal: string): RegExp {
  let compiled = occurrence_cache.get(literal);
  if (compiled === undefined) {
    let pattern = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${W}`, "u").test(literal)) pattern = String.raw`(?<![\p{L}\p{N}_])` + pattern;
    if (new RegExp(`${W}$`, "u").test(literal)) pattern += String.raw`(?![\p{L}\p{N}_])`;
    compiled = new RegExp(pattern, "u");
    occurrence_cache.set(literal, compiled);
  }
  return compiled;
}

/** File tokens in the prose only — a quoted span is a literal, not a referent. */
export function named_files(line: string): string[] {
  const prose = line.replace(BACKTICKED, " ").replace(DOUBLE_QUOTED, " ");
  return [...new Set(findall(FILE_TOKEN, prose))];
}

/** A named file token -> (repo-relative path, one of resolved/missing/ambiguous). */
export function resolve(
  token: string,
  origin: string,
  on_disk: Set<string>,
  by_basename: Map<string, string[]>,
): [string | null, string] {
  const candidate = py_lstrip(token, "([");
  if (on_disk.has(candidate)) return [candidate, "resolved"];
  // A marker may name a path relative to an ancestor of its own file, not the repo root.
  const dir = path.posix.dirname(origin);
  const parts = dir !== "." ? dir.split("/") : [];
  for (let depth = parts.length; depth > 0; depth--) {
    const joined = [...parts.slice(0, depth), candidate].join("/");
    if (on_disk.has(joined)) return [joined, "resolved"];
  }
  const matches = by_basename.get(path.posix.basename(candidate)) ?? [];
  if (matches.length === 1) return [matches[0]!, "resolved"];
  if (!matches.length) return [null, "missing"];
  return [null, "ambiguous"];
}

/** Why a file-naming marker enforced nothing, and the two repairs open to its author. */
export function unverified_reason(rel: string, targets: string[], unmirrored: string[]): string {
  const repair =
    "quote in backticks the identifier, constant, string or regex that must recur in " +
    `${targets.filter((t) => t !== rel).join(" and ") || "the file it mirrors"}, or drop the ` +
    "file name so the marker reads as free-form prose.";
  if (new Set([...targets, rel]).size < 2) {
    return (
      `names only its own file ${rel} — a mirror needs a second file, so this marker ` +
      "verifies nothing; name the file it is held to and " +
      repair
    );
  }
  if (unmirrored.length) {
    return (
      `names ${targets.join(", ")}, and none of ${unmirrored.map((x) => py_repr(x)).join(", ")} ` +
      `appears in ${[rel, ...targets.filter((t) => t !== rel)].join(" + ")} — the marker ` +
      "claims a mirror that is not there; " +
      repair
    );
  }
  return (
    `names ${targets.join(", ")} but quotes no literal, so only the path was checked — ` + repair
  );
}

export class Report {
  errors: string[] = [];
  rows: [string, string, string][] = [];
  sites = new Set<string>();
  markers = 0;
  enforced = 0;
  file_refs = 0;
  mirrors = 0;
  prose_markers = 0;
  prose_literals = 0;
  ambiguous = 0;
}

export function audit(root: string): Report {
  const report = new Report();
  const files = scan_files(root);
  const texts = new Map(files.map((rel) => [rel, read_text(root, rel)] as const));
  const on_disk = new Set(files);
  const by_basename = new Map<string, string[]>();
  for (const rel of files) {
    const base = path.posix.basename(rel);
    by_basename.set(base, [...(by_basename.get(base) ?? []), rel]);
  }
  const bodies = new Map<string, string>();

  const body_of = (rel: string): string => {
    if (!bodies.has(rel)) {
      const text = texts.get(rel) || "";
      bodies.set(rel, text.includes(MARKER) ? marker_body(splitlines(text)) : text);
    }
    return bodies.get(rel)!;
  };
  // Prose is the mirror in Markdown, where `#` and `*` open headings and bullets, not comments.
  const code_of = (rel: string): string =>
    rel.endsWith(".md")
      ? body_of(rel)
      : splitlines(body_of(rel))
          .filter((l) => comment_prefix(l) === null)
          .join("\n");

  for (const rel of files) {
    const text = texts.get(rel);
    if (text === null || text === undefined || !text.includes(MARKER)) continue;
    const lines = splitlines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes(MARKER)) continue;
      report.markers += 1;
      report.sites.add(rel);
      const where = `${rel}:${i + 1}`;
      const targets: string[] = [];
      for (const token of named_files(line)) {
        const [target, how] = resolve(token, rel, on_disk, by_basename);
        if (how === "missing") {
          report.errors.push(
            `${where}: names ${token}, which matches no file in the tree — the ` +
              "marker points at nothing; fix the name or drop the marker.",
          );
        } else if (how === "ambiguous") {
          report.ambiguous += 1;
        } else if (!targets.includes(target!)) {
          report.file_refs += 1;
          report.sites.add(target!);
          targets.push(target!);
        }
      }

      const mirror = [rel, ...targets.filter((t) => t !== rel)];
      // `(below)`: the own-file side is the code under the marker run, so a twin elsewhere in
      // the same file cannot stand in for this site.
      let below: string | null = null;
      let window = rel;
      if (line.includes(BELOW)) {
        const prefix = comment_prefix(line);
        let j = i + 1;
        while (prefix !== null && j < lines.length && comment_prefix(lines[j]!) === prefix) j += 1;
        // A comment line is not a site, so it neither matches nor uses up the window.
        const code: number[] = [];
        for (; j < lines.length && code.length < BELOW_LINES; j++) {
          if (comment_prefix(lines[j]!) === null) code.push(j);
        }
        below = code.map((k) => lines[k]!).join("\n");
        window =
          `${rel}:${code[0]! + 1}-${code.at(-1)! + 1} ` +
          `(the ${BELOW_LINES} code lines under the marker)`;
      }
      const side = (m: string): string => (m === rel && below !== null ? below : code_of(m));
      const label = (m: string): string => (m === rel ? window : m);
      const enforced_literals: string[] = [];
      const unmirrored: string[] = [];
      for (const literal of literals_of(line)) {
        if (mirror.length < 2) {
          report.prose_literals += 1;
          continue;
        }
        const present = mirror.filter((m) => occurrence(literal).test(side(m)));
        if (!present.length) {
          report.prose_literals += 1;
          unmirrored.push(literal);
          continue;
        }
        report.mirrors += 1;
        enforced_literals.push(literal);
        const absent = mirror.filter((m) => !present.includes(m));
        if (absent.length) {
          report.errors.push(
            `${where}: ${py_repr(literal)} still appears in ${present.map(label).join(", ")} ` +
              `but no longer in ${absent.map(label).join(", ")} — the marker names these as ` +
              "one mirror and exactly one side moved.",
          );
        }
        const own =
          below === null
            ? splitlines(body_of(rel)).filter(
                (l) => comment_prefix(l) === null && occurrence(literal).test(l),
              ).length
            : 0;
        if (own > 1) {
          report.errors.push(
            `${where}: ${py_repr(literal)} occurs on ${own} code lines of ${rel}, so any one ` +
              "site can move while another still satisfies this marker — mark each site " +
              `\`${BELOW}:\` with the literal in the ${BELOW_LINES} lines under it.`,
          );
        }
      }

      if (!targets.length) {
        report.prose_markers += 1;
        report.rows.push([where, "free-form", [...py_strip(line)].slice(0, 110).join("")]);
      } else if (enforced_literals.length) {
        report.enforced += 1;
        report.rows.push([
          where,
          "enforced",
          "names " +
            targets.join(", ") +
            "; mirrors " +
            enforced_literals.map((x) => py_repr(x)).join(", ") +
            (unmirrored.length
              ? "; not mirrored " + unmirrored.map((x) => py_repr(x)).join(", ")
              : ""),
        ]);
      } else {
        report.rows.push([where, "unverified", "names " + targets.join(", ")]);
        report.errors.push(`${where}: ${unverified_reason(rel, targets, unmirrored)}`);
      }
    }
  }

  if (!report.markers) {
    report.errors.push(
      `no ${MARKER} marker found anywhere under ${root} — this gate's scan assumption ` +
        "broke; it must never report green over an empty sweep.",
    );
  }
  return report;
}

export function main(): number {
  const prog = path.basename(process.argv[1] ?? "");
  const usage = `usage: ${prog} [-h] [--root ROOT] [--table] [--print-sites]`;
  const args = parse_args(
    usage,
    `${usage}

CI / gate check: every KEEP IN SYNC marker's machine-resolvable referent still
resolves.

options:
  -h, --help     show this help message and exit
  --root ROOT    tree to audit (default: this checkout)
  --table        print every marker's disposition
  --print-sites  every file a verdict reads, one per line
`,
    [
      ["--root", "store", "root"],
      ["--table", "store_true", "table"],
      ["--print-sites", "store_true", "print_sites"],
    ],
    { root: REPO, table: false, print_sites: false },
  );
  const root = path.resolve(args.root);

  if (args.print_sites) {
    for (const rel of [...audit(root).sites].sort(by_code_point)) print(rel);
    return 0;
  }

  const report = audit(root);
  if (args.table) {
    const width = Math.max(1, ...report.rows.map((r) => cp_len(r[0])));
    const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - cp_len(s)));
    for (const [where, state, detail] of report.rows) {
      print(`${pad(where, width)}  ${pad(state, 9)}  ${detail}`);
    }
    print();
  }

  if (report.errors.length) {
    print("❌ check_keep_in_sync: a KEEP IN SYNC marker verifies nothing, or its referent");
    print("   no longer resolves:");
    for (const err of report.errors) print(`     • ${err}`);
    print(
      `   ${report.errors.length} finding(s) over ${report.markers} marker(s) scanned; ` +
        `${report.enforced} marker(s) do mirror a verified literal.`,
    );
    return 1;
  }

  print(
    `✅ check_keep_in_sync: ${report.markers} marker(s) scanned, ` +
      `${report.enforced} enforced — ` +
      `${report.file_refs} named-file reference(s) resolve, ` +
      `${report.mirrors} literal mirror(s) verified across the files their marker names.`,
  );
  print(
    `✅ check_keep_in_sync: NOT enforced — ${report.prose_markers} marker(s) name no file ` +
      `(free-form prose) and ${report.prose_literals} quoted literal(s) are not mirrored — ` +
      "their marker names no file, or they appear in no member of its mirror set while " +
      "another literal on the same marker does; " +
      `${report.ambiguous} referent(s) match several files by basename. ` +
      "--table lists every marker's disposition.",
  );
  return 0;
}

if (import.meta.main) process.exit(main());

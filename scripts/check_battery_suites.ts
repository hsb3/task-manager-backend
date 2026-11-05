#!/usr/bin/env bun
// make check-static gate: every tests/test_*.ts suite is run by scripts/run_suite_battery.sh, and
// every label the battery runs has exactly one CI shard in scripts/battery_shards.tsv.
//
// The battery names a suite in two places: the LEGACY_SUITES array (its loop invokes an
// unresolvable tests/${suite}.ts) and `run_suite` lines. A suite counts as run only where the
// runner OPENS the line — a name in a comment, a heredoc body, or an echo does not count. A
// suite file the battery never runs, and not excused in EXCLUSIONS, is an orphan. `--manifests`
// proves the union of CI's per-shard manifests ran every label exactly once.
//
// Bound: reachability is NOT analysed. A well-formed gate line inside an uncalled function, an
// `if false` block, or after an early `exit 0` still reads as wired.
//
// Usage:
//     bun scripts/check_battery_suites.ts [--table]
//     bun scripts/check_battery_suites.ts --manifests FILE [FILE ...]

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  PY_WS_RE,
  by_code_point,
  glob_sorted,
  print,
  py_int,
  py_join,
  py_repr,
  py_split,
  py_strip,
  read_text,
  splitlines,
  truthy,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";

export const REPO = repo_root(import.meta.path);
export const TESTS_DIR = py_join(REPO, "tests");
export const BATTERY = py_join(REPO, "scripts", "run_suite_battery.sh");
export const SHARDS = py_join(REPO, "scripts", "battery_shards.tsv");

// Python's Unicode `\w` (re on str patterns).
const W = "[\\p{L}\\p{N}_]";

// stem -> reason a suite legitimately never runs in the battery. Empty is the healthy
// state; an entry is a deliberate, reviewed carve-out, never a parking spot for a red suite.
export const EXCLUSIONS: Record<string, string> = {};

const sorted = (xs: Iterable<string>): string[] => [...xs].sort(by_code_point);
const minus = (a: Set<string>, b: Set<string>): Set<string> =>
  new Set([...a].filter((x) => !b.has(x)));
const dupes = (xs: string[]): string[] =>
  sorted(new Set(xs.filter((x) => xs.indexOf(x) !== xs.lastIndexOf(x))));

/** Blank out `#` comments so a commented-out run_suite line does not read as wired in. */
export function strip_shell_comments(text: string): string {
  const out: string[] = [];
  for (const line of splitlines(text)) {
    let quote: string | null = null;
    let cut: number | null = null;
    const chars = [...line];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === "#" && (i === 0 || PY_WS_RE.test(chars[i - 1]!))) {
        cut = i;
        break;
      }
    }
    out.push(cut === null ? line : chars.slice(0, cut).join(""));
  }
  return out.join("\n");
}

/** LEGACY_SUITES tokens in order, plus a parse-assumption error when the array is gone. */
export function legacy_suites(lines: string[]): [string[], string[]] {
  // The one legitimate non-runner source: the loop below it invokes tests/${suite}.ts, a
  // path no static reader can resolve.
  const array = /^LEGACY_SUITES=\(([^)]*)\)/m.exec(lines.join("\n"));
  if (array === null) {
    return [
      [],
      [
        "could not find the LEGACY_SUITES=( … ) array in " +
          "scripts/run_suite_battery.sh — this checker's parse assumption broke",
      ],
    ];
  }
  return [py_split(array[1]!).filter((tok) => tok.startsWith("test_")), []];
}

/** Suite stems the battery actually executes, plus any parse-assumption failures. */
export function battery_references(text: string): [Set<string>, string[]] {
  const lines = command_lines(text);
  const [legacy, errors] = legacy_suites(lines);
  const referenced = new Set(legacy);
  for (const line of lines) {
    if (BATTERY_OPENER.test(line)) {
      for (const m of line.replace(ECHO_ARG_RE, " ").matchAll(SUITE_PATH_RE)) referenced.add(m[1]!);
    }
  }
  return [referenced, errors];
}

export const RUN_SUITE_LABEL_RE = /^\s*run_suite\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** Every label the battery can run, in order: LEGACY_SUITES, then each run_suite line's first arg. */
export function battery_labels(text: string): [string[], string[]] {
  const lines = command_lines(text);
  const [labels, errors] = legacy_suites(lines);
  for (const line of lines) {
    const match = RUN_SUITE_LABEL_RE.exec(line);
    if (match === null) continue;
    const label = match.slice(1).find((g) => g !== undefined)!;
    // The legacy loop's `"$suite"`: its labels are the LEGACY_SUITES tokens above.
    if (label === "$suite") continue;
    if (label.includes("$")) {
      errors.push(
        `run_suite label ${py_repr(label)} is not a literal — no shard can be assigned a label ` +
          `this checker cannot read`,
      );
      continue;
    }
    labels.push(label);
  }
  for (const label of dupes(labels)) {
    errors.push(
      `battery label '${label}' is run more than once — a shard manifest cannot tell the runs apart`,
    );
  }
  return [labels, errors];
}

/** The shard table must assign every battery label exactly once, in 1..N, heaviest first. */
export function shard_errors(labels: string[], tsv_path: string): string[] {
  const name = path.basename(tsv_path);
  if (!fs.existsSync(tsv_path)) return [`${name} not found — no battery label has a CI shard`];
  const rows: [number, number, string][] = [];
  const errors: string[] = [];
  splitlines(read_text(tsv_path)).forEach((line, idx) => {
    const number = idx + 1;
    if (line.startsWith("#")) return;
    const fields = line.split("\t");
    // KEEP IN SYNC: the `[1-9][0-9]*` row awk in scripts/run_suite_battery.sh's shard selection.
    if (
      fields.length !== 3 ||
      !/^[1-9][0-9]*$/.test(fields[0]!) ||
      !/^[0-9]+$/.test(fields[1]!) ||
      !fields[2]
    ) {
      errors.push(
        `${name}:${number}: malformed row ${py_repr(line)} — want shard (int ≥1) TAB seconds (int ≥0) TAB label`,
      );
      return;
    }
    rows.push([py_int(fields[0]!), py_int(fields[1]!), fields[2]]);
  });

  const tsv_labels = rows.map(([, , label]) => label);
  for (const label of dupes(tsv_labels)) {
    errors.push(`${name}: '${label}' is listed more than once — it would run in two shards`);
  }
  for (const label of sorted(minus(new Set(labels), new Set(tsv_labels)))) {
    errors.push(
      `'${label}' is run by the battery but has no row in ${name} — CI runs it in no shard; ` +
        `add a row (its measured seconds, on the lightest shard)`,
    );
  }
  for (const label of sorted(minus(new Set(tsv_labels), new Set(labels)))) {
    errors.push(`${name}: '${label}' is not a label the battery runs — drop the row`);
  }
  const shards = [...new Set(rows.map(([shard]) => shard))].sort((a, b) => a - b);
  const last = shards[shards.length - 1]!;
  if (shards.length && !shards.every((s, i) => s === i + 1)) {
    errors.push(
      `${name}: shard numbers ${py_repr(shards)} are not contiguous 1..${last} — ` +
        `an empty shard runs nothing and still reads green`,
    );
  }
  const seconds = rows.map(([, sec]) => sec);
  if (!seconds.every((s, i) => i === 0 || seconds[i - 1]! >= s)) {
    errors.push(`${name}: rows are not sorted by seconds descending`);
  }
  return errors;
}

/** Union CI's per-shard manifests: every battery label ran in exactly one, and nothing else did. */
export function manifest_errors(labels: string[], paths: string[]): [string[], number] {
  const errors: string[] = [];
  // A Map: an integer-like label would be reordered as a plain-object key.
  const seen = new Map<string, string[]>();
  for (const p of paths) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      errors.push(`manifest ${p} does not exist — that shard reported nothing`);
      continue;
    }
    for (const line of splitlines(read_text(p))) {
      const label = py_strip(line);
      if (label) seen.set(label, [...(seen.get(label) ?? []), p]);
    }
  }
  const inventory = new Set(labels);
  for (const label of labels.filter((x) => !seen.has(x))) {
    errors.push(`'${label}' ran in no shard — no manifest reports it passing`);
  }
  for (const label of sorted(minus(new Set(seen.keys()), inventory))) {
    errors.push(`'${label}' is in a manifest but is not a label the battery runs`);
  }
  for (const label of sorted([...seen.keys()].filter((x) => seen.get(x)!.length > 1))) {
    const where = seen.get(label)!;
    errors.push(`'${label}' is reported ${where.length} times (${where.join(", ")})`);
  }
  return [errors, seen.size];
}

export const HEREDOC_OPEN_RE = new RegExp(`<<-?\\s*["']?(${W}+)["']?`, "u");

/** Shell lines that can execute: comments and heredoc bodies dropped, `\\` joins applied. */
export function command_lines(text: string): string[] {
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of splitlines(strip_shell_comments(text))) {
    if (terminator !== null) {
      if (py_strip(line) === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const opener = HEREDOC_OPEN_RE.exec(line);
    if (opener !== null) terminator = opener[1]!;
  }
  return splitlines(out.join("\n").replaceAll("\\\n", " "));
}

// Anywhere inside a runner line the whole line IS the command, so a path in any shape
// ($VAR prefix, quoted, behind `cd … &&` or an env assignment, with flags) counts — except
// an echo's arguments, which the runner prints rather than runs.
export const ECHO_ARG_RE = new RegExp(`(?<!${W})echo(?!${W})[^;&|]*`, "gu");
export const SUITE_PATH_RE = new RegExp(`tests/(test_${W}+)\\.ts`, "gu");
// The runner must OPEN the line: an echoed or quoted mention of the same text is not a gate.
export const BATTERY_OPENER = /^\s*run_suite\s/;
/** Disposition pass: wired / excluded-with-reason / orphan, plus the reverse drift. */
export function reconcile(
  on_disk: string[],
  referenced: Set<string>,
  exclusions: Record<string, string>,
  rel: string,
  noun: string,
  wired_label: string,
  homes: string,
  fix: string,
  map_name: string,
): [[string, string, string][], string[]] {
  const rows: [string, string, string][] = [];
  const errors: string[] = [];

  for (const stem of on_disk) {
    const wired = referenced.has(stem);
    const excluded = Object.hasOwn(exclusions, stem);
    if (wired && excluded) {
      errors.push(
        `${stem}: listed in ${map_name} but ${homes} runs it — ` +
          `drop the exclusion or the reference`,
      );
      rows.push([stem, "CONTRADICTION", exclusions[stem]!]);
    } else if (wired) {
      rows.push([stem, wired_label, ""]);
    } else if (excluded) {
      const reason = exclusions[stem]!;
      if (!py_strip(reason)) {
        errors.push(
          `${stem}: ${map_name} entry has an empty (or whitespace-only) reason — ` +
            `a non-empty reason is required to carve a ${noun} out of ${homes}`,
        );
        rows.push([stem, "❌ EMPTY REASON", reason]);
      } else {
        rows.push([stem, "excluded", reason]);
      }
    } else {
      errors.push(
        `${stem}: ${rel}${stem}.ts is never run by ${homes} and has no ` +
          `${map_name} entry — ${fix}`,
      );
      rows.push([stem, "❌ ORPHAN", "neither referenced nor excluded"]);
    }
  }

  const on_disk_set = new Set(on_disk);
  for (const stem of sorted(minus(referenced, on_disk_set))) {
    errors.push(`${stem}: referenced by ${homes} but ${rel}${stem}.ts does not exist`);
  }
  for (const stem of sorted(minus(new Set(Object.keys(exclusions)), on_disk_set))) {
    errors.push(`${stem}: listed in ${map_name} but ${rel}${stem}.ts does not exist`);
  }
  return [rows, errors];
}

// Python's `f"{s:<{width}}"`: pads by code points.
const ljust = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - [...s].length));

export function print_table(heading: string, rows: [string, string, string][]): void {
  if (!rows.length) throw new Error("max() iterable argument is empty");
  const width = Math.max(...rows.map((r) => [...r[0]].length));
  print(`${ljust(heading, width)}  disposition   reason`);
  for (const [stem, state, reason] of rows) {
    print(`${ljust(stem, width)}  ${ljust(state, 12)}  ${reason}`);
  }
  print();
}

const USAGE = "usage: check_battery_suites.ts [-h] [--table] [--manifests FILE [FILE ...]]";
const HELP = `${USAGE}

Check that every tests/test_*.ts runs in the battery and every battery label has one shard.

options:
  -h, --help            show this help message and exit
  --table               print the per-file reconciliation
  --manifests FILE [FILE ...]
                        reconcile CI's per-shard BATTERY_MANIFEST files
                        against the battery's labels
`;

// argparse's argument classes for this parser: no option looks like a negative number.
const NEGATIVE_NUMBER_RE = /^-\d+$|^-\d*\.\d+$/;
const is_value = (arg: string): boolean =>
  !arg.startsWith("-") || arg === "-" || NEGATIVE_NUMBER_RE.test(arg) || arg.includes(" ");

// shortcut: _argparse.ts has no nargs="+", so each `--manifests A B …` run is folded into one
// JSON-encoded value before parse_args sees it (the last run wins, as argparse's store does);
// a bare `--manifests` reads "expected one argument" where argparse says "expected at least
// one argument". Upgrade when _argparse.ts gains nargs="+".
function fold_manifests(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (name.length < 3 || !"--manifests".startsWith(name)) {
      out.push(arg);
    } else if (eq >= 0) {
      out.push(`${name}=${JSON.stringify([arg.slice(eq + 1)])}`);
    } else {
      const files: string[] = [];
      while (i + 1 < argv.length && is_value(argv[i + 1]!)) files.push(argv[++i]!);
      out.push(arg, ...(files.length ? [JSON.stringify(files)] : []));
    }
  }
  return out;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parse_args(
    USAGE,
    HELP,
    [
      ["--table", "store_true", "table"],
      ["--manifests", "store", "manifests"],
    ],
    { table: false, manifests: null },
    fold_manifests(argv),
  );
  const show_table: boolean = args.table;
  const manifests: string[] | null = args.manifests === null ? null : JSON.parse(args.manifests);

  if (!fs.existsSync(BATTERY)) {
    print(`❌ check_battery_suites: ${BATTERY} not found.`);
    return 1;
  }
  const text = read_text(BATTERY);
  const [labels, label_errors] = battery_labels(text);

  if (truthy(manifests)) {
    let [errors, reported] = manifest_errors(labels, manifests!);
    errors = [...label_errors, ...errors];
    if (errors.length) {
      print("❌ check_battery_suites: shard manifests do not cover the battery:");
      for (const e of errors) print(`     • ${e}`);
      return 1;
    }
    print(
      `✅ check_battery_suites: ${manifests!.length} shard manifest(s) report ` +
        `${reported} label(s) — every one of the battery's ${labels.length} ran exactly once.`,
    );
    return 0;
  }

  const on_disk = glob_sorted(TESTS_DIR, ".ts")
    .map((f) => path.basename(f))
    .filter((f) => f.startsWith("test_"))
    .map((f) => f.slice(0, -".ts".length));
  let [referenced, errors] = battery_references(text);
  const [suite_rows, suite_errors] = reconcile(
    on_disk,
    referenced,
    EXCLUSIONS,
    "tests/",
    "suite",
    "in battery",
    "the battery",
    "add it to scripts/run_suite_battery.sh or declare it in EXCLUSIONS with a reason",
    "EXCLUSIONS",
  );
  errors = [...errors, ...suite_errors];
  errors.push(...label_errors, ...shard_errors(labels, SHARDS));

  if (show_table) {
    print_table("suite", suite_rows);
  }

  if (errors.length) {
    print("❌ check_battery_suites: suite-coverage drift:");
    for (const e of errors) print(`     • ${e}`);
    return 1;
  }

  const n_excl = Object.keys(EXCLUSIONS).length;
  print(
    `✅ check_battery_suites: ${on_disk.length} suite file(s) reconciled against ` +
      `scripts/run_suite_battery.sh — ${on_disk.length - n_excl} run in the ` +
      `battery, ${n_excl} excluded with a reason.`,
  );
  print(
    `✅ check_battery_suites: ${labels.length} battery label(s) each assigned one CI shard ` +
      `in scripts/battery_shards.tsv.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

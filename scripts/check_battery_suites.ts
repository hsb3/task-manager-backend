#!/usr/bin/env bun
// CI / battery check: every tests/test_*.ts and every scripts/**/check_*.ts must have a home.
//
// Reconciles the on-disk suite files against the two places scripts/run_suite_battery.sh names
// a suite (the LEGACY_SUITES array, whose loop invokes an unresolvable tests/${suite}.ts, and
// `run_suite` lines), and every gate script found recursively under scripts/ against its three
// gate homes: scripts/run_suite_battery.sh, scripts/dod.sh and lefthook.yml's `pre-commit:` jobs
// (.githooks/pre-commit only launches Lefthook). Both halves count a file as wired only where a
// command could actually run it: the runner (run_suite/run_gate) must OPEN the line, or bun
// must sit in command position in a Lefthook `run:` — a name in a comment, a heredoc body, an
// echo, another hook's section, or an echo the runner itself is given, does not count.
// A file that is neither invoked nor listed in the matching
// exclusions map below is an orphan: it exists, it may even pass solo, and no gate ever runs it.
// Also flags the reverse drift — a referenced or excluded file that is gone, or a carve-out whose
// stated home no longer invokes it — and any run_gate scope token dod.sh's own scope vocabulary
// cannot produce. The battery's suite labels are also reconciled against
// scripts/battery_shards.tsv (CI's shard assignment), and `--manifests` proves the union of CI's
// per-shard manifests ran every label exactly once.
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
  os_walk,
  print,
  py_int,
  py_join,
  py_repr,
  py_rstrip,
  py_split,
  py_strip,
  read_text,
  splitlines,
  truthy,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";

export const REPO = repo_root(import.meta.path);
export const TESTS_DIR = py_join(REPO, "tests");
export const SCRIPTS_DIR = py_join(REPO, "scripts");
export const BATTERY = py_join(REPO, "scripts", "run_suite_battery.sh");
export const DOD = py_join(REPO, "scripts", "dod.sh");
export const PRECOMMIT = py_join(REPO, "lefthook.yml");
export const SHARDS = py_join(REPO, "scripts", "battery_shards.tsv");

// Python's Unicode `\w` (re on str patterns).
const W = "[\\p{L}\\p{N}_]";

// stem -> reason a suite legitimately never runs in the battery. Empty is the healthy
// state; an entry is a deliberate, reviewed carve-out, never a parking spot for a red suite.
export const EXCLUSIONS: Record<string, string> = {};

// stem -> reason a gate script legitimately runs in neither the battery nor dod. Same
// contract as EXCLUSIONS: a reviewed carve-out, never a parking spot for an unwired gate.
export const SCRIPT_EXCLUSIONS: Record<string, string> = {
  check_decision_cards:
    "queries the kata daemon (.kata.toml binding + KATA_SERVER/KATA_AUTH_TOKEN), which " +
    "neither CI nor make dod can reach — run it on demand after a decision-record write",
  check_board_labels:
    "queries the kata daemon like check_decision_cards — run it on demand after a triage " +
    "pass or bulk filing",
};

// key -> reason a gate runs ONLY in lefthook.yml's pre-commit jobs. Verified against that file:
// an entry the hook does not invoke is a stale carve-out, not a reviewed one.
export const PRECOMMIT_ONLY: Record<string, string> = {
  check_historical_migrations:
    "pre-commit-only gate: it reconciles the STAGED diff against origin/main (falling " +
    "back to a local main when no origin/main exists), which has no meaning in a battery " +
    "run; its logic is covered in both homes by tests/test_historical_migration_guard.ts",
};

// key -> reason a battery-wired gate needs no DIRECT run_gate line in scripts/dod.sh. dod's
// backend scope runs the whole battery, so a direct line only earns its place when a scope
// that does NOT run the battery (docs, frontend, ci, compose) has to reach the gate.
export const NO_DIRECT_DOD_GATE: Record<string, string> = {
  check_app_docs_quotes:
    "needs a pocketbase binary and a full migration replay into a throwaway DB, which " +
    "only the battery provisions; the prose it reads can be broken only from " +
    "pb_migrations/ or schema/, both of which put dod in the backend scope that runs " +
    "the battery",
  check_room_preflight:
    "reads tests/ and scripts/ alone, and only an edit there can introduce a blind port " +
    "bind or an undrained boot pipe — that path puts dod in the backend scope, which " +
    "runs the battery",
  check_superuser_before_serve:
    "walks tests/ but shares check_room_preflight's boot detector, so only a tests/ or " +
    "scripts/ edit can move a serve ahead of its superuser upsert — either path puts dod " +
    "in the backend scope, which runs the battery",
};

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
export const GATE_PATH_RE = new RegExp(
  `scripts/((?:[\\p{L}\\p{N}_.\\-]+/)*check_${W}+)\\.ts`,
  "gu",
);
// The runner must OPEN the line: an echoed or quoted mention of the same text is not a gate.
export const BATTERY_OPENER = /^\s*run_suite\s/;
export const DOD_OPENER = /^\s*run_gate\s/;
// Lefthook has no runner, so command position is the anchor: a `run: |` body line's start, just
// after `run:` / `- run:`, or after a separator.
// scripts/with_staged_tree.sh is a runner like run_gate: it execs its argv, so the bun it
// is handed is still in command position.
export const PRECOMMIT_OPENER = new RegExp(
  "(?:^\\s*(?:-\\s*)?(?:run:\\s*)?|\\$\\(|&&\\s*|\\|\\|\\s*|;\\s*|\\|\\s*|\\(\\s*)" +
    `(?:${W}+=\\S*\\s+)*(?:sh\\s+scripts/with_staged_tree\\.sh\\s+)?bun\\s`,
  "u",
);
export const PRECOMMIT_SECTION = "pre-commit";
export const RUN_GATE_SCOPES_RE = /^\s*run_gate\s+(\S+)\s/;

/** Only the lines of one top-level Lefthook hook; a pre-push job is not a pre-commit gate. */
export function lefthook_section(text: string, section: string): [string, boolean] {
  const out: string[] = [];
  let inside = false;
  let found = false;
  for (const line of splitlines(text)) {
    // Block-scalar bodies are always indented, so a column-0 key starts the next hook.
    if (!["", " ", "\t", "#"].includes(line.slice(0, 1))) {
      inside = py_rstrip(line.split("#", 1)[0]!) === `${section}:`;
      found = found || inside;
    }
    out.push(inside ? line : "");
  }
  return [out.join("\n"), found];
}

/** Gate-script keys a gate file actually INVOKES, plus any parse-assumption failures. */
export function gate_references(
  file: string,
  label: string,
  opener: RegExp,
  section: string | null = null,
): [Set<string>, string[]] {
  if (!fs.existsSync(file)) {
    return [new Set(), [`${label} not found — this checker's parse assumption broke`]];
  }
  let text = read_text(file);
  if (section !== null) {
    let found: boolean;
    [text, found] = lefthook_section(text, section);
    if (!found) {
      return [
        new Set(),
        [`${label} has no top-level \`${section}:\` hook — this checker's parse assumption broke`],
      ];
    }
  }
  const referenced = new Set<string>();
  for (let line of command_lines(text)) {
    if (!opener.test(line)) continue;
    line = line.replace(ECHO_ARG_RE, " ");
    for (const m of line.matchAll(GATE_PATH_RE)) referenced.add(m[1]!);
  }
  if (!referenced.size) {
    return [
      referenced,
      [`${label} invokes no scripts/check_*.ts gate — this checker's parse assumption broke`],
    ];
  }
  return [referenced, []];
}

/** Every run_gate scope token must be one dod.sh's own scope detection can produce. */
export function dod_scope_errors(file: string, label: string): string[] {
  if (!fs.existsSync(file)) return [];
  const raw = read_text(file);
  const lines = command_lines(raw);
  const detected = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(new RegExp(`add_scope\\s+([a-z0-9]+)(?!${W})`, "gu"))) {
      detected.add(m[1]!);
    }
  }
  // A scope with no add_scope arm is reachable only through SCOPE=; dod.sh names those in
  // prose, so deleting an arm cannot quietly legitimise the gate it just stranded.
  const opt_in = new RegExp(
    `(?<!${W})([a-z0-9]+(?:(?:,|\\s+and)\\s+[a-z0-9]+)*)\\s+are opt-in`,
    "u",
  ).exec(raw);
  const errors: string[] = [];
  if (!detected.size) {
    errors.push(`${label} has no literal \`add_scope <token>\` arm — parse assumption broke`);
  }
  if (opt_in === null) {
    errors.push(`${label} declares no '<scopes> are opt-in' vocabulary — parse assumption broke`);
  }
  if (errors.length || opt_in === null) return errors;
  const valid = new Set([...detected, ...py_strip(opt_in[1]!).split(/,|\s+and\s+|\s+/)]);
  for (const line of lines) {
    const token_match = RUN_GATE_SCOPES_RE.exec(line);
    if (token_match === null) continue;
    const token = token_match[1]!;
    for (const scope of token.split(",")) {
      if (!valid.has(scope)) {
        errors.push(
          `${label}: run_gate scope token '${scope}' (in '${token}') is not a scope ` +
            `dod.sh can produce — that gate never runs. Valid: ` +
            `${sorted(valid).join(", ")}`,
        );
      }
    }
  }
  return errors;
}

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

Check that every tests/test_*.ts and scripts/check_*.ts has a home in a gate.

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

  const gate_scripts: string[] = [];
  for (const [dir, , files] of os_walk(SCRIPTS_DIR)) {
    for (const f of files) {
      if (f.startsWith("check_") && f.endsWith(".ts")) {
        gate_scripts.push(path.relative(SCRIPTS_DIR, py_join(dir, f)).slice(0, -".ts".length));
      }
    }
  }
  gate_scripts.sort(by_code_point);
  const [battery_gates, battery_gate_errors] = gate_references(
    BATTERY,
    "scripts/run_suite_battery.sh",
    BATTERY_OPENER,
  );
  const [dod_gates, dod_gate_errors] = gate_references(DOD, "scripts/dod.sh", DOD_OPENER);
  const [precommit_gates, precommit_gate_errors] = gate_references(
    PRECOMMIT,
    "lefthook.yml pre-commit",
    PRECOMMIT_OPENER,
    PRECOMMIT_SECTION,
  );
  errors.push(...battery_gate_errors, ...dod_gate_errors, ...precommit_gate_errors);
  errors.push(...dod_scope_errors(DOD, "scripts/dod.sh"));

  for (const stem of sorted(minus(new Set(Object.keys(PRECOMMIT_ONLY)), precommit_gates))) {
    errors.push(
      `${stem}: listed in PRECOMMIT_ONLY, but lefthook.yml's pre-commit jobs do not invoke it — ` +
        `the carve-out's reason no longer holds; wire it into a gate or fix the map`,
    );
  }

  const carved = { ...SCRIPT_EXCLUSIONS, ...PRECOMMIT_ONLY };
  const [script_rows, script_errors] = reconcile(
    gate_scripts,
    new Set([...battery_gates, ...dod_gates]),
    carved,
    "scripts/",
    "gate script",
    "in a gate",
    "the battery or dod",
    "wire it into scripts/run_suite_battery.sh or scripts/dod.sh, or declare it in " +
      "SCRIPT_EXCLUSIONS (no home at all) or PRECOMMIT_ONLY (lefthook.yml's pre-commit " +
      "jobs are its only home) with a reason",
    "SCRIPT_EXCLUSIONS/PRECOMMIT_ONLY",
  );
  errors.push(...script_errors);

  // dod reaches every battery gate through `bash scripts/run_suite_battery.sh`, so the
  // question here is only whether a NON-battery scope needs its own direct line.
  const on_disk_gates = new Set(gate_scripts);
  const needs_dod_line = sorted(
    new Set([
      ...minus(
        new Set(gate_scripts.filter((g) => battery_gates.has(g))),
        new Set(Object.keys(carved)),
      ),
      ...Object.keys(NO_DIRECT_DOD_GATE).filter((g) => on_disk_gates.has(g)),
    ]),
  );
  // Narrowed to the population under review: a dod-ONLY gate is legitimately outside it,
  // and the full set would send it through the reverse-drift branch as a missing file.
  const [, dod_line_errors] = reconcile(
    needs_dod_line,
    new Set(needs_dod_line.filter((g) => dod_gates.has(g))),
    NO_DIRECT_DOD_GATE,
    "scripts/",
    "gate script",
    "in dod",
    "scripts/dod.sh",
    "add a run_gate line to scripts/dod.sh, or declare it in NO_DIRECT_DOD_GATE with " +
      "the reason dod's backend scope reaching it through the battery is enough",
    "NO_DIRECT_DOD_GATE",
  );
  errors.push(...dod_line_errors);
  errors.push(...label_errors, ...shard_errors(labels, SHARDS));

  if (show_table) {
    print_table("suite", suite_rows);
    print_table("gate script", script_rows);
  }

  if (errors.length) {
    print("❌ check_battery_suites: suite-coverage drift:");
    for (const e of errors) print(`     • ${e}`);
    return 1;
  }

  const n_excl = Object.keys(EXCLUSIONS).length;
  const n_carved = Object.keys(carved).length;
  print(
    `✅ check_battery_suites: ${on_disk.length} suite file(s) reconciled against ` +
      `scripts/run_suite_battery.sh — ${on_disk.length - n_excl} run in the ` +
      `battery, ${n_excl} excluded with a reason.`,
  );
  print(
    `✅ check_battery_suites: ${gate_scripts.length} gate script(s) reconciled against ` +
      `scripts/run_suite_battery.sh + scripts/dod.sh + lefthook.yml pre-commit — ` +
      `${gate_scripts.length - n_carved} wired into a gate, ` +
      `${n_carved} excluded with a reason, ` +
      `${Object.keys(NO_DIRECT_DOD_GATE).length} reached by dod through the battery alone.`,
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

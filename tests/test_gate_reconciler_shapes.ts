#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_battery_suites.ts's battery parser: which suite-line shapes read as run.
 *
 * Parser shapes only — no server, no DB, no port. Every fixture is an in-memory battery text; the
 * shipped battery is never read, so nothing here can rewrite a tracked file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { print, py_repr, read_text, tup } from "../scripts/_py.ts";
import * as cbs from "../scripts/check_battery_suites.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_battery_suites.ts");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "gateshapes_"));
const PROBE = "test_zprobe";
const ANCHOR = "test_anchor";
// Every fixture carries one real suite of each shape, so an empty parse reads as breakage
// rather than as "the probe is not wired".
const PREAMBLE = "LEGACY_SUITES=(test_legacy)\n" + 'run_suite "a" bun tests/test_anchor.ts\n';

// (expect_run, label, snippet)
const CASES: [boolean, string, string][] = [
  [false, "echo'd run_suite line", `echo 'run_suite "z" bun tests/test_zprobe.ts'`],
  [false, "heredoc body", 'cat > f <<EOF\nrun_suite "z" bun tests/test_zprobe.ts\nEOF'],
  [true, "single-quoted label", "run_suite 'test_zprobe' bun tests/test_zprobe.ts"],
  [true, "bare label", "run_suite test_zprobe bun tests/test_zprobe.ts"],
  [true, "$REPO_ROOT prefix", 'run_suite "z" bun "$REPO_ROOT/tests/test_zprobe.ts"'],
  [true, "bun --smol", 'run_suite "z" bun --smol tests/test_zprobe.ts'],
  [true, "behind env assignments", 'run_suite "z" env "PB_URL=x" bun tests/test_zprobe.ts'],
  [true, "a backslash-continued line", 'run_suite "z" env \\\n  bun tests/test_zprobe.ts'],
  [false, "run_suite given an echo", 'run_suite "z" echo see tests/test_zprobe.ts'],
  [false, "commented-out run_suite line", '# run_suite "z" bun tests/test_zprobe.ts'],
  // A whole-line `#` never reaches the runner regex anyway; only a trailing comment ON a
  // live suite line can tell whether comments are stripped at all.
  [
    false,
    "suite named only in a trailing comment",
    'run_suite "a" bun tests/test_anchor.ts  # bun tests/test_zprobe.ts',
  ],
  // The runner must OPEN the line: only a non-echo command quoting a suite line tests the anchor.
  [
    false,
    "a run_suite line quoted as another command's argument",
    `grep -q 'run_suite "z" bun tests/test_zprobe.ts' scripts/run_suite_battery.sh`,
  ],
];

let failures = 0;
let fixtures = 0;

function check(label: string, got: unknown, want: unknown): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  print(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok) {
    print(`        got:  ${py_repr(got)}`);
    print(`        want: ${py_repr(want)}`);
  }
}

/** A throwaway file holding `body`; the path is what the parser is pointed at. */
function fixture(body: string): string {
  fixtures += 1;
  const p = path.join(SCRATCH, `fixture_${fixtures}.txt`);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

print("── (a) suite-line shapes: what the parser counts as running a suite ──");
for (const [expect, label, snippet] of CASES) {
  const [got, errs] = cbs.battery_references(PREAMBLE + snippet + "\n");
  check(`${label}: the fixture's own anchor suite parses`, got.has(ANCHOR), true);
  check(`${label}: the LEGACY_SUITES token parses`, got.has("test_legacy"), true);
  check(`${label}: probe run`, got.has(PROBE), expect);
  check(`${label}: no parse-assumption error`, errs, []);
}

print("\n── (b) fail-closed default: a battery without LEGACY_SUITES is an error, never a pass ──");
{
  const [got, errs] = cbs.battery_references('run_suite "a" bun tests/test_anchor.ts\n');
  check("the run_suite line still parses", got.has(ANCHOR), true);
  check(
    "...and the missing array is a parse-assumption error",
    tup(errs.length, errs.length === 1 && errs[0]!.includes("LEGACY_SUITES")),
    tup(1, true),
  );
}

print("\n── (c) the declared reachability ceiling, held to the checker's own words ──");
const BOUND =
  "Bound: reachability is NOT analysed. A well-formed gate line inside an uncalled function, an\n" +
  "// `if false` block, or after an early `exit 0` still reads as wired.";
check(
  "check_battery_suites.ts still states the bound section (a) pins",
  read_text(CHECKER).includes(BOUND),
  true,
);
const [early] = cbs.battery_references(
  PREAMBLE + 'exit 0\nrun_suite "z" bun tests/test_zprobe.ts\n',
);
check("...a suite line after an early `exit 0` still reads as run", early.has(PROBE), true);
const [uncalled] = cbs.battery_references(
  PREAMBLE + 'never_called() {\n  run_suite "z" bun tests/test_zprobe.ts\n}\n',
);
check("...and so does one inside a function nothing calls", uncalled.has(PROBE), true);

print("\n── (d) battery labels: the inventory CI's shard table and manifests reconcile against ──");
const BATTERY_TEXT =
  "LEGACY_SUITES=(test_rules test_hooks)\n" +
  'for suite in "${LEGACY_SUITES[@]}"; do\n' +
  '  run_suite "$suite" env bun "tests/${suite}.ts"\n' +
  "done\n" +
  'run_suite "test_email" env bun tests/test_email.ts\n' +
  "run_suite 'check_quoted' bun scripts/check_quoted.ts\n" +
  "run_suite gen_bare bun scripts/gen_bare.ts --check\n" +
  '# run_suite "commented_out" bun tests/test_commented_out.ts\n' +
  "echo 'run_suite \"echoed\" bun tests/test_echoed.ts'\n" +
  'cat > f <<EOF\nrun_suite "heredoc" bun tests/test_heredoc.ts\nEOF\n';
const INVENTORY = ["test_rules", "test_hooks", "test_email", "check_quoted", "gen_bare"];
{
  let [labels, errs] = cbs.battery_labels(BATTERY_TEXT);
  check("LEGACY_SUITES tokens, then each run_suite first arg, in order", labels, INVENTORY);
  check("...with no parse error", errs, []);
  [labels, errs] = cbs.battery_labels(BATTERY_TEXT.replace("LEGACY_SUITES=", "OTHER="));
  check(
    "a missing LEGACY_SUITES array is a parse-assumption error",
    errs.length === 1 && errs[0]!.includes("LEGACY_SUITES"),
    true,
  );
  [labels, errs] = cbs.battery_labels(BATTERY_TEXT + 'run_suite "gen_bare" bun x.ts\n');
  check(
    "a label run twice is an error",
    errs.length === 1 && errs[0]!.includes("'gen_bare' is run more than once"),
    true,
  );
  [labels, errs] = cbs.battery_labels(
    BATTERY_TEXT + 'for l in a b; do\n  run_suite "$l" bun tests/test_looped.ts\ndone\n',
  );
  check(
    "a variable label other than the legacy loop's is an error, not a silent skip",
    errs.length === 1 &&
      errs[0]!.includes("'$l' is not a literal") &&
      Bun.deepEquals(labels, INVENTORY, true),
    true,
  );
}

function tsv(rows: string[], header = "# shard\tseconds\tlabel\n"): string {
  return fixture(header + rows.map((row) => `${row}\n`).join(""));
}

const GOOD_ROWS = [
  "1\t50\ttest_rules",
  "2\t40\ttest_hooks",
  "2\t9\ttest_email",
  "1\t9\tcheck_quoted",
  "2\t0\tgen_bare",
];

function shard_case(
  label: string,
  rows: string[],
  needle: string | null,
  labels: string[] = INVENTORY,
  p: string | null = null,
): void {
  const errs = cbs.shard_errors(labels, p || tsv(rows));
  if (needle === null) {
    check(label, errs, []);
  } else {
    check(label, errs.length === 1 && errs[0]!.includes(needle), true);
    if (!(errs.length === 1 && errs[0]!.includes(needle)))
      print(`        errors: ${py_repr(errs)}`);
  }
}

print(
  "\n── (e) shard table: every battery label in exactly one contiguous shard, heaviest first ──",
);
shard_case("a complete, sorted, contiguous table passes", GOOD_ROWS, null);
shard_case(
  "a battery label with no row",
  GOOD_ROWS.slice(0, -1),
  "'gen_bare' is run by the battery but has no row",
);
shard_case(
  "a label listed twice",
  [...GOOD_ROWS, "1\t0\tgen_bare"],
  "'gen_bare' is listed more than once",
);
shard_case(
  "a row the battery does not run",
  [...GOOD_ROWS, "1\t0\tghost"],
  "'ghost' is not a label the battery runs",
);
for (const bad of [
  "1\t0",
  "1\t0\tgen_bare\textra",
  "0\t0\tgen_bare",
  "x\t0\tgen_bare",
  "1\t-3\tgen_bare",
  "1\t0\t",
  "",
]) {
  shard_case(`a malformed row ${py_repr(bad)}`, [...GOOD_ROWS, bad], "malformed row");
}
shard_case(
  "shards not contiguous from 1",
  GOOD_ROWS.map((row) => (row.startsWith("2\t") ? row.replace("2\t", "3\t") : row)),
  "not contiguous",
);
shard_case(
  "rows not sorted by seconds descending",
  [GOOD_ROWS[1]!, GOOD_ROWS[0]!, ...GOOD_ROWS.slice(2)],
  "not sorted",
);
shard_case("a missing table", GOOD_ROWS, "not found", undefined, path.join(SCRATCH, "absent.tsv"));

function manifest(lines: string[]): string {
  return fixture(lines.map((line) => `${line}\n`).join(""));
}

function manifest_case(label: string, paths: string[], needle: string | null): void {
  const [errs] = cbs.manifest_errors(INVENTORY, paths);
  if (needle === null) {
    check(label, errs, []);
  } else {
    check(label, errs.length === 1 && errs[0]!.includes(needle), true);
    if (!(errs.length === 1 && errs[0]!.includes(needle)))
      print(`        errors: ${py_repr(errs)}`);
  }
}

print("\n── (f) --manifests: the union of CI's shard manifests ran every label exactly once ──");
const SHARD_1 = ["test_rules", "check_quoted"];
const SHARD_2 = ["test_hooks", "test_email", "gen_bare"];
manifest_case(
  "two manifests covering the inventory once pass",
  [manifest(SHARD_1), manifest(SHARD_2)],
  null,
);
manifest_case(
  "a label in no manifest",
  [manifest(SHARD_1), manifest(SHARD_2.slice(0, -1))],
  "'gen_bare' ran in no shard",
);
manifest_case(
  "a manifest label the battery does not run",
  [manifest([...SHARD_1, "ghost"]), manifest(SHARD_2)],
  "'ghost' is in a manifest but is not a label the battery runs",
);
manifest_case(
  "a label in two manifests",
  [manifest([...SHARD_1, "gen_bare"]), manifest(SHARD_2)],
  "'gen_bare' is reported 2 times",
);
manifest_case(
  "a named manifest that does not exist",
  [manifest(SHARD_1), manifest(SHARD_2), path.join(SCRATCH, "absent.txt")],
  "absent.txt does not exist",
);

print("\n── (g) no tracked file was touched ──");
check("every fixture lived under the scratch dir", fs.readdirSync(SCRATCH).length !== 0, true);
fs.rmSync(SCRATCH, { recursive: true, force: true });
check("scratch dir cleaned up", fs.existsSync(SCRATCH), false);

print();
if (failures) {
  print(`❌ test_gate_reconciler_shapes: ${failures} check(s) failed`);
  process.exit(1);
}
print(`✅ test_gate_reconciler_shapes: every check passed across ${fixtures} fixture(s)`);

#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_battery_suites.ts's gate-line parser: which shapes read as wired.
 *
 * Parser shapes only — no server, no DB, no port. Every fixture is a throwaway .sh under a
 * scratch dir; the shipped gate files are never read, so nothing here can rewrite a tracked file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { print, py_repr, read_text, truthy, tup } from "../scripts/_py.ts";
import * as cbs from "../scripts/check_battery_suites.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_battery_suites.ts");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "gateshapes_"));
const OPENER: Record<string, RegExp> = {
  dod: cbs.DOD_OPENER,
  bat: cbs.BATTERY_OPENER,
  pre: cbs.PRECOMMIT_OPENER,
};
const PROBE = "check_zprobe";
const ANCHOR = "check_anchor";
// Every fixture carries one real gate of each shape, so an empty parse reads as breakage
// rather than as "the probe is not wired".
const PREAMBLE =
  "run_gate x 'bun scripts/check_anchor.ts'\n" +
  'run_suite "a" bun scripts/check_anchor.ts\n' +
  'bun "$root/scripts/check_anchor.ts"\n';

// (home, expect_wired, label, snippet)
const CASES: [string, boolean, string, string][] = [
  ["dod", false, "echo'd run_gate line", `echo 'run_gate backend "bun scripts/check_zprobe.ts"'`],
  [
    "dod",
    false,
    "heredoc body",
    "bun run - <<'TS'\nrun_gate backend \"bun scripts/check_zprobe.ts\"\nTS",
  ],
  ["dod", false, "name in an echo message", 'echo "run: bun scripts/check_zprobe.ts"'],
  ["bat", false, "echo'd run_suite line", `echo 'run_suite "z" bun scripts/check_zprobe.ts'`],
  ["bat", false, "heredoc body", 'cat > f <<EOF\nrun_suite "z" bun scripts/check_zprobe.ts\nEOF'],
  ["bat", true, "single-quoted label", "run_suite 'check_zprobe' bun scripts/check_zprobe.ts"],
  ["bat", true, "bare label", "run_suite check_zprobe bun scripts/check_zprobe.ts"],
  ["bat", true, "$REPO_ROOT prefix", 'run_suite "z" bun "$REPO_ROOT/scripts/check_zprobe.ts"'],
  ["bat", true, "bun --smol", 'run_suite "z" bun --smol scripts/check_zprobe.ts'],
  ["dod", true, "cd web && ...", 'run_gate frontend "cd web && bun ../scripts/check_zprobe.ts"'],
  ["dod", true, "bun run subcommand form", 'run_gate backend "bun run scripts/check_zprobe.ts"'],
  ["dod", true, "line continuation", 'run_gate backend \\\n  "bun scripts/check_zprobe.ts"'],
  ["dod", true, "$REPO prefix", 'run_gate backend "bun $REPO/scripts/check_zprobe.ts"'],
  ["dod", true, "bun --smol", 'run_gate backend "bun --smol scripts/check_zprobe.ts"'],
  ["dod", true, "env-var prefix", 'run_gate backend "PB_URL=x bun scripts/check_zprobe.ts"'],
  ["dod", true, "multi-scope token", 'run_gate backend,docs "bun scripts/check_zprobe.ts"'],
  ["dod", true, "flag after path", 'run_gate backend "bun scripts/check_zprobe.ts --staged"'],
  ["pre", true, '"$root"/ outside the quotes', 'bun "$root"/scripts/check_zprobe.ts'],
  ["pre", true, "unquoted $root", "bun $root/scripts/check_zprobe.ts"],
  ["pre", true, "a variable other than $root", 'bun "$repo_root/scripts/check_zprobe.ts"'],
  [
    "pre",
    true,
    "command substitution",
    'out="$(bun "$root/scripts/check_zprobe.ts" --print-sites)"',
  ],
  ["pre", false, "name inside an echo message", 'echo "run: bun scripts/check_zprobe.ts"'],
  ["pre", true, "Lefthook `run: bun …`", "      run: bun scripts/check_zprobe.ts"],
  ["pre", true, "Lefthook `- run: bun …`", "        - run: bun scripts/check_zprobe.ts"],
  [
    "pre",
    false,
    "Lefthook `run: echo …` naming the gate",
    '      run: echo "bun scripts/check_zprobe.ts"',
  ],
  // Declared ceiling, not an oversight: reachability is not analysed, so an unreachable
  // gate line still reads as wired — section (c) holds the checker to saying so.
  [
    "dod",
    true,
    "BOUND: unreachable `if false` block",
    'if false; then\nrun_gate backend "bun scripts/check_zprobe.ts"\nfi',
  ],
  [
    "dod",
    true,
    "echo THEN the gate, ; separated",
    'run_gate backend "echo starting; bun scripts/check_zprobe.ts"',
  ],
  [
    "dod",
    true,
    "echo THEN the gate, && separated",
    'run_gate backend "echo starting && bun scripts/check_zprobe.ts"',
  ],
  [
    "dod",
    false,
    "runner given an echo",
    'run_gate backend "echo reminder: see scripts/check_zprobe.ts"',
  ],
  [
    "bat",
    false,
    "run_suite given an echo",
    'run_suite "z" echo see tests/check_zprobe.ts scripts/check_zprobe.ts',
  ],
  ["dod", false, "commented-out run_gate line", '# run_gate backend "bun scripts/check_zprobe.ts"'],
  ["bat", false, "commented-out run_suite line", '# run_suite "z" bun scripts/check_zprobe.ts'],
  ["pre", false, "commented-out hook invocation", '# bun "$root/scripts/check_zprobe.ts"'],
  // A whole-line `#` never reaches the runner regex anyway; only a trailing comment ON a
  // live gate line can tell whether comments are stripped at all.
  [
    "dod",
    false,
    "gate named only in a trailing comment",
    'run_gate backend "bun scripts/check_anchor.ts"  # bun scripts/check_zprobe.ts',
  ],
  [
    "bat",
    false,
    "suite named only in a trailing comment",
    'run_suite "a" bun scripts/check_anchor.ts  # bun scripts/check_zprobe.ts',
  ],
  [
    "pre",
    false,
    "hook gate named only in a trailing comment",
    'bun "$root/scripts/check_anchor.ts"  # bun "$root/scripts/check_zprobe.ts"',
  ],
  // The runner must OPEN the line: the echo cases above are also caught by the echo stripper,
  // so only a non-echo command quoting a gate line tests the anchor itself.
  [
    "dod",
    false,
    "a run_gate line quoted as another command's argument",
    `grep -q 'run_gate backend "bun scripts/check_zprobe.ts"' scripts/dod.sh`,
  ],
  [
    "bat",
    false,
    "a run_suite line quoted as another command's argument",
    `grep -q 'run_suite "z" bun scripts/check_zprobe.ts' scripts/run_suite_battery.sh`,
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

/** A throwaway gate file holding `body`; the path is what the parser is pointed at. */
function fixture(body: string): string {
  fixtures += 1;
  const p = path.join(SCRATCH, `fixture_${fixtures}.sh`);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

print("── (a) gate-line shapes: what the parser counts as an invocation ──");
for (const [home, expect, label, snippet] of CASES) {
  const [got, errs] = cbs.gate_references(
    fixture(PREAMBLE + snippet + "\n"),
    "probe",
    OPENER[home]!,
  );
  check(`[${home}] ${label}: the fixture's own anchor gate parses`, got.has(ANCHOR), true);
  check(`[${home}] ${label}: probe wired`, got.has(PROBE), expect);
  check(`[${home}] ${label}: no parse-assumption error`, errs, []);
}

print("\n── (b) fail-closed default: an unreadable gate file is an error, never an empty pass ──");
for (const home of ["dod", "bat", "pre"]) {
  const [got, errs] = cbs.gate_references(
    fixture('run_gate x "echo nothing runs here"\nrun_suite "a" echo nothing\n'),
    `${home} fixture`,
    OPENER[home]!,
  );
  check(`[${home}] a gate file invoking no check_*.ts parses nothing`, got, new Set());
  check(`[${home}] ...and says so rather than passing silently`, errs.length, 1);
  check(
    `[${home}] ...naming the file and the broken assumption`,
    truthy(errs) ? errs[0]!.startsWith(`${home} fixture invokes no scripts/check_*.ts gate`) : errs,
    true,
  );
}
{
  const [got, errs] = cbs.gate_references(
    path.join(SCRATCH, "absent.sh"),
    "absent",
    cbs.DOD_OPENER,
  );
  check(
    "a gate file that is not there is an error, not an empty result",
    tup(got, errs.length),
    tup(new Set(), 1),
  );
}

print("\n── (c) the declared reachability ceiling, held to the checker's own words ──");
const BOUND =
  "Bound: reachability is NOT analysed. A well-formed gate line inside an uncalled function, an\n" +
  "// `if false` block, or after an early `exit 0` still reads as wired.";
const checker_src = read_text(CHECKER);
check(
  "check_battery_suites.ts still states the bound section (a) pins",
  checker_src.includes(BOUND),
  true,
);
const [early] = cbs.gate_references(
  fixture(PREAMBLE + 'exit 0\nrun_gate backend "bun scripts/check_zprobe.ts"\n'),
  "probe",
  cbs.DOD_OPENER,
);
check("...a gate line after an early `exit 0` still reads as wired", early.has(PROBE), true);
const [uncalled] = cbs.gate_references(
  fixture(PREAMBLE + 'never_called() {\n  run_gate backend "bun scripts/check_zprobe.ts"\n}\n'),
  "probe",
  cbs.DOD_OPENER,
);
check("...and so does one inside a function nothing calls", uncalled.has(PROBE), true);

print(
  "\n── (d) lefthook.yml: only the top-level `pre-commit:` hook's jobs are pre-commit gates ──",
);
const LEFTHOOK =
  "# bun scripts/check_zprobe.ts\n" +
  "pre-push:\n" +
  "  jobs:\n" +
  "    - name: push-only\n" +
  "      run: bun scripts/check_zprobe.ts\n" +
  "pre-commit:\n" +
  "  jobs:\n" +
  "    - name: anchor\n" +
  "      run: |\n" +
  "        bun scripts/check_anchor.ts\n";
{
  let [got, errs] = cbs.gate_references(
    fixture(LEFTHOOK),
    "probe",
    cbs.PRECOMMIT_OPENER,
    "pre-commit",
  );
  check("a pre-commit job's gate is wired", got.has(ANCHOR), true);
  check("a pre-push job's gate is not a pre-commit gate", got.has(PROBE), false);
  check("...and the file parses without error", errs, []);
  [got, errs] = cbs.gate_references(
    fixture(LEFTHOOK.replace("pre-commit:", "commit-msg:")),
    "probe",
    cbs.PRECOMMIT_OPENER,
    "pre-commit",
  );
  check("a file with no `pre-commit:` hook wires nothing", got, new Set());
  check(
    "...and is a parse-assumption error, never an empty pass",
    errs.length === 1 && errs[0]!.includes("no top-level `pre-commit:`"),
    true,
  );
}

print("\n── (e) battery labels: the inventory CI's shard table and manifests reconcile against ──");
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
  "\n── (f) shard table: every battery label in exactly one contiguous shard, heaviest first ──",
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

print("\n── (g) --manifests: the union of CI's shard manifests ran every label exactly once ──");
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

print("\n── (h) no tracked file was touched ──");
check("every fixture lived under the scratch dir", fs.readdirSync(SCRATCH).length !== 0, true);
fs.rmSync(SCRATCH, { recursive: true, force: true });
check("scratch dir cleaned up", fs.existsSync(SCRATCH), false);

print();
if (failures) {
  print(`❌ test_gate_reconciler_shapes: ${failures} check(s) failed`);
  process.exit(1);
}
print(`✅ test_gate_reconciler_shapes: every check passed across ${fixtures} fixture(s)`);

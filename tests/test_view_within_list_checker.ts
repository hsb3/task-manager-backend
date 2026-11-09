#!/usr/bin/env bun
// Unit-pin scripts/check_view_within_list.ts: clause model, `||` precedence, escaped-quote literals, base + view collection coverage, end-to-end RED/GREEN against schema/, and the allowlist contract (no server, no DB).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, glob_sorted, py_repr, read_text, truthy } from "../scripts/_py.ts";
import * as vwl from "../scripts/check_view_within_list.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const CHECKER = path.join(REPO_ROOT, "scripts", "check_view_within_list.ts");
const SCHEMA_DIR = path.join(REPO_ROOT, "schema");
const TASKS_RULES = path.join(SCHEMA_DIR, "tasks.rules.json");
// Derived, never a literal: a new collection must not rot this pin into a lie.
const RULE_FILES = [
  ...glob_sorted(SCHEMA_DIR, ".rules.json"),
  ...glob_sorted(SCHEMA_DIR, ".view.json"),
].sort(by_code_point);
const SHIPPED = RULE_FILES.length;
const VIEW_FILES = glob_sorted(SCHEMA_DIR, ".view.json");

const TRASHED_CLAUSE = 'trashed = ""';
const AUTH_CLAUSE = '@request.auth.id != ""';
const TASKS_CUT = ` && ${TRASHED_CLAUSE}`;
const COMMENTS_CUT = `${AUTH_CLAUSE} && `;

let failures = 0;

function check(label: string, got: any, want: any): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${py_repr(got)}`);
    console.log(`        want: ${py_repr(want)}`);
  }
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort(by_code_point);
const pairs = (xs: [string, string][]): [string, string][] =>
  xs.sort((a, b) => by_code_point(a[0], b[0]) || by_code_point(a[1], b[1]));
const key = (c: string, cl: string): string => JSON.stringify([c, cl]);

function cli(...args: string[]): { returncode: number; stdout: string } {
  const proc = Bun.spawnSync([process.execPath, CHECKER, ...args]);
  return { returncode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

/** main()'s stdout for `rules_dir` with `allowlist` planted in the shipped constant. */
function rendered(rules_dir: string, allowlist: Map<string, string>): string {
  for (const [k, v] of allowlist) vwl.ALLOWLIST.set(k, v);
  const argv = process.argv;
  const write = process.stdout.write;
  let buf = "";
  try {
    process.argv = [argv[0]!, "check_view_within_list.ts", "--rules-dir", rules_dir];
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      buf += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    vwl.main();
  } finally {
    process.stdout.write = write;
    process.argv = argv;
    for (const k of allowlist.keys()) vwl.ALLOWLIST.delete(k);
  }
  return buf;
}

/** Delete `cut` from that collection's viewRule only; -> the mutated viewRule. */
function mutate(rules_dir: string, collection: string, cut: string): string {
  const file = path.join(rules_dir, `${collection}.rules.json`);
  const rules = JSON.parse(read_text(file));
  check(
    `${collection}.viewRule contains ${py_repr(cut)} exactly once`,
    rules.viewRule.split(cut).length - 1,
    1,
  );
  rules.viewRule = rules.viewRule.replace(cut, "");
  fs.writeFileSync(file, JSON.stringify(rules, null, 2));
  return rules.viewRule;
}

const copy_schema = (prefix: string): [string, string] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const schema = path.join(dir, "schema");
  copy_tree(SCHEMA_DIR, schema);
  return [dir, schema];
};

console.log("════════ test_view_within_list_checker.ts — viewRule ⊆ listRule gate pins ════════");

console.log("\n── (a) canon: order, whitespace, parens and string literals ──");
for (const [raw, want] of [
  ["B && A", "(A && B)"],
  ["A  &&   B", "(A && B)"],
  ["A && ((B))", "(A && B)"],
  ["(A && B)", "(A && B)"],
  // `&&` parts are sorted as canonical STRINGS, so a parenthesized group leads.
  ["A && (C || B)", "((B || C) && A)"],
  ["C || (B && A)", "((A && B) || C)"],
  ["A && B || C", "((A && B) || C)"],
  ['a.b="x"', 'a.b = "x"'],
  ['a.b   =    "x"', 'a.b = "x"'],
  // `&&`/`||`/parens inside a literal are content: the atom must never be split there.
  ['name = "a && b"', 'name = "a && b"'],
  ['name = "a || (b)"', 'name = "a || (b)"'],
  ['name  =  "a  &&  b"', 'name = "a  &&  b"'],
] as [string, string][]) {
  check(`canon(${py_repr(raw)})`, vwl.canon(raw), want);
}

console.log("\n── (b) conjuncts: only top-level `&&` parts are required clauses ──");
for (const [raw, want] of [
  ["A && B", ["A", "B"]],
  ["(A && B)", ["A", "B"]],
  ["A && (B || C)", ["(B || C)", "A"]],
  // `A && B || C` parses as `(A && B) || C`, so A is NOT required.
  ["A && B || C", ["((A && B) || C)"]],
  ["A || B", ["(A || B)"]],
  ["", []],
  ["A", ["A"]],
  ['name = "a && b" && A', ["A", 'name = "a && b"']],
  // `&&` nesting is flattened; a `||` group inside stays one clause.
  ["A && (B && C)", ["A", "B", "C"]],
  ["(A && B) && (C && D)", ["A", "B", "C", "D"]],
  ["A && ((B && C) && D)", ["A", "B", "C", "D"]],
  ["A && (B && (C || D))", ["(C || D)", "A", "B"]],
] as [string, string[]][]) {
  check(`conjuncts(${py_repr(raw)})`, sorted(vwl.conjuncts(raw)), want);
}

console.log("\n── (c) violations_for truth table — every adversarial pair, both directions ──");
for (const [list_rule, view_rule, want] of [
  // reordering
  ["A && B", "B && A", []],
  ["B && A", "A && B", []],
  // whitespace, inside and outside a comparison
  ["A &&  B", "A && B", []],
  ['a.b="x" && A', 'a.b = "x" && A', []],
  ['a.b = "x" && A', 'a.b="x" && A', []],
  // reordered disjuncts at depth
  ["A && (B || C)", "A && (C || B)", []],
  ["A && (C || B)", "A && (B || C)", []],
  // redundant parens
  ["A && ((B))", "A && B", []],
  ["A && B", "A && ((B))", []],
  // `&&` is associative: a parenthesised group of conjuncts is not a clause of its own
  ["A && (B && C)", "A && B && C", []],
  ["A && B && C", "A && (B && C)", []],
  ["A && B", "A && (B && C)", []],
  ["A && (B && C)", "A && B", ["C"]],
  ["(A && B) && C", "C && (B && A)", []],
  // a dropped conjunct
  ["A && B", "A", ["B"]],
  ["A", "A && B", []],
  // a top-level `||` in the view dissolves both clauses
  ["A && B", "(A && B) || C", ["A", "B"]],
  // a widened conjunct is a different clause
  ["A && B", "A && (B || C)", ["B"]],
  // A view tightened strictly BELOW its list is reported too — clauses, not semantics.
  ["A && (B || C)", "A && B", ["(B || C)"]],
  [
    'trashed = "" || owner = @request.auth.id',
    'trashed = ""',
    ['(owner = @request.auth.id || trashed = "")'],
  ],
  // `||` precedence on BOTH sides: same expression, different spelling
  ["A && B || C", "C || (B && A)", []],
  ["C || (B && A)", "A && B || C", []],
  // a disjunction is one clause, so any change to it is reported (conservative by design)
  ["A || B", "A || B || C", ["(A || B)"]],
  ["A || B || C", "A || B", ["(A || B || C)"]],
  // a literal is never split
  ['name = "a && b"', 'name = "a && b"', []],
  ['A && name = "a && b"', "A", ['name = "a && b"']],
  ['A && name = "a && b"', 'name = "a && b" && A', []],
  // null / empty
  [null, "", [vwl.SUPERUSER_ONLY]],
  [null, "A", [vwl.SUPERUSER_ONLY]],
  ["", null, []],
  [null, null, []],
  ["", "A", []],
  ["A", "", ["A"]],
  ["A && B", null, []],
] as [string | null, string | null, string[]][]) {
  check(
    `violations_for(${py_repr(list_rule)}, ${py_repr(view_rule)})`,
    vwl.violations_for(list_rule, view_rule),
    want,
  );
}

console.log("\n── (c2) an escaped quote is literal CONTENT, analysed exactly like its control ──");
// `\"` inside a literal must not desynchronise guards' quote scanner: the escaped rule and the
// escape-free control differ only in that literal's payload, so every verdict must match.
const ESCAPED_VIEW = '(title = "a\\"b" && project = "") || (project = "" && trashed = "")';
const CONTROL_VIEW = '(title = "ab" && project = "") || (project = "" && trashed = "")';
const ESCAPED_LIST = `${AUTH_CLAUSE} && title = "a\\"b"`;
const CONTROL_LIST = `${AUTH_CLAUSE} && title = "ab"`;
const unescape = (s: string): string => s.replaceAll('a\\"b', "ab");
check(
  "collapse_ws keeps an escaped quote and the whitespace behind it intact",
  vwl.collapse_ws('title  =  "a\\"  b"'),
  'title = "a\\"  b"',
);
check(
  "canon: the escaped rule canonicalises to the control's shape, payload aside",
  unescape(vwl.canon(ESCAPED_VIEW)),
  vwl.canon(CONTROL_VIEW),
);
check(
  "conjuncts: an escaped quote does not merge or split a clause",
  sorted([...vwl.conjuncts(ESCAPED_LIST)].map(unescape)),
  sorted(vwl.conjuncts(CONTROL_LIST)),
);
for (const [label, list_rule, esc_view, ctl_view] of [
  ["escape on the view side", TRASHED_CLAUSE, ESCAPED_VIEW, CONTROL_VIEW],
  ["escape on both sides", ESCAPED_LIST, ESCAPED_VIEW, CONTROL_VIEW],
] as [string, string, string, string][]) {
  check(
    `${label}: the escaped pair reports what the control reports`,
    vwl.violations_for(list_rule, esc_view).map(unescape),
    vwl.violations_for(unescape(list_rule), ctl_view).map(unescape),
  );
}
check(
  "the escaped view really is the leaking pair, not a vacuous one",
  vwl.violations_for(TRASHED_CLAUSE, ESCAPED_VIEW),
  [TRASHED_CLAUSE],
);
check(
  "an escaped quote on the LIST side still yields its clauses",
  vwl.violations_for(ESCAPED_LIST, AUTH_CLAUSE),
  ['title = "a\\"b"'],
);
check(
  "a backslash outside any literal is an opaque atom, not a parser desync",
  vwl.violations_for(`${AUTH_CLAUSE} && title ~ \\d`, AUTH_CLAUSE),
  ["title ~ \\d"],
);

let [scratch_dir, scratch_schema] = copy_schema("pbvwl_esc_");
try {
  const esc_path = path.join(scratch_schema, "tasks.rules.json");
  const esc_rules = JSON.parse(read_text(esc_path));
  esc_rules.viewRule = ESCAPED_VIEW;
  esc_rules.listRule = TRASHED_CLAUSE;
  fs.writeFileSync(esc_path, JSON.stringify(esc_rules, null, 2));

  const esc_report = vwl.run(scratch_schema);
  check(
    "run() reports the violation instead of refusing the rule",
    esc_report.violations.map((v: any) => [v.collection, v.clause]),
    [["tasks", TRASHED_CLAUSE]],
  );
  check("...and the report is not ok", esc_report.ok, false);
  check("...and `refused` is gone from the report entirely", "refused" in esc_report, false);

  const proc = cli("--rules-dir", scratch_schema);
  check("the CLI exits non-zero on the escaped leaking rule", proc.returncode, 1);
  check(
    "stdout names the collection and the leak",
    proc.stdout.includes("❌ tasks: viewRule admits a row its listRule excludes"),
    true,
  );
  check("stdout never mentions a refusal", proc.stdout.includes("refusing to analyse"), false);
  check(
    "summary counts it as a violation, not a refusal",
    proc.stdout.includes("❌ check_view_within_list: 1 viewRule clause(s) broader than listRule"),
    true,
  );
} finally {
  fs.rmSync(scratch_dir, { recursive: true });
}

// decision:invitation-keyed-by-email made workspaces.viewRule equal its listRule; card q46b leaves project_items' trash
// branch as the only shipped exception, and the synthetic cases below add to it.
const SHIPPED_ALLOW = new Map(vwl.ALLOWLIST);
const ALLOWED_COLLECTIONS = sorted([...SHIPPED_ALLOW.keys()].map((k) => JSON.parse(k)[0]));
check(
  "the only shipped exceptions are project_items' five trash-branch clauses",
  ALLOWED_COLLECTIONS,
  Array(5).fill("project_items"),
);

console.log(
  "\n── (c3) widening workspaces.viewRule beyond its listRule is a violation, unexempted ──",
);
const MUTANT_WS_VIEW =
  '@request.auth.id != "" && (owner = @request.auth.id || ' +
  'workspace_members_via_workspace.user ?= @request.auth.id) && trashed = ""';
[scratch_dir, scratch_schema] = copy_schema("vwl_ws_");
try {
  const ws_path = path.join(scratch_schema, "workspaces.rules.json");
  const ws_rules = JSON.parse(read_text(ws_path));
  ws_rules.viewRule = MUTANT_WS_VIEW;
  fs.writeFileSync(ws_path, JSON.stringify(ws_rules));
  const wider = vwl.run(scratch_schema);
  check(
    "the reviewer's wider workspaces viewRule is a violation",
    wider.violations.map((v: any) => v.collection),
    ["workspaces"],
  );
  check("...so the report is not ok", wider.ok, false);
  check("...and the real checker exits 1 on it", cli("--rules-dir", scratch_schema).returncode, 1);
} finally {
  fs.rmSync(scratch_dir, { recursive: true });
}

console.log("\n── (d) end-to-end GREEN on the shipped schema/ (subprocess, --json) ──");
let proc = cli("--json");
check("exit 0", proc.returncode, 0);
const report = JSON.parse(proc.stdout);
check("ok", report.ok, true);
check("0 violations", report.violations, []);
check("0 stale allowlist entries", report.stale_allowlist, []);
check("0 invalid allowlist entries", report.invalid_allowlist, []);
check(
  "shipped ALLOWLIST holds only the ruled project_items trash branch",
  report.allowlist_size,
  SHIPPED_ALLOW.size,
);
const escaped_shipped: [string, string][] = [];
for (const file of RULE_FILES) {
  for (const [name, rule] of Object.entries(JSON.parse(read_text(file)))) {
    if ((name === "listRule" || name === "viewRule") && rule && String(rule).includes("\\")) {
      escaped_shipped.push([path.basename(file), name]);
    }
  }
}
// Bounded coverage: the shipped tree never exercises the escape path, so (c2) is its only proof.
check("no shipped list/view rule contains a backslash", escaped_shipped, []);
check("every rules.json AND view.json was read", report.collections, SHIPPED);
check(
  "the shipped ALLOWLIST constant is the ruled set",
  sorted(vwl.ALLOWLIST.keys()),
  sorted(SHIPPED_ALLOW.keys()),
);

proc = cli();
check("plain run exits 0", proc.returncode, 0);
check(
  "success line quotes the collection count",
  proc.stdout.includes(`${SHIPPED} collection(s)`),
  true,
);
check(
  "success line quotes the allowlist size",
  proc.stdout.includes(`ALLOWLIST: ${SHIPPED_ALLOW.size} entry(ies)`),
  true,
);
check(
  "success line names both globs it scanned",
  proc.stdout.includes("schema/*.rules.json + schema/*.view.json"),
  true,
);
check("the tree really ships view collections to scan", VIEW_FILES.length > 0, true);

console.log("\n── (d2) end-to-end RED: a VIEW collection's viewRule loses a listRule clause ──");
// A view exposes listRule/viewRule and nothing else, so this pair is its whole read surface.
[scratch_dir, scratch_schema] = copy_schema("pbvwl_view_");
try {
  // project_items' viewRule is allowlisted-broader; mutate a view whose viewRule still equals its listRule.
  const victim = VIEW_FILES.map((f) => path.basename(f).slice(0, -".view.json".length)).find(
    (c) => !ALLOWED_COLLECTIONS.includes(c),
  )!;
  const victim_path = path.join(scratch_schema, `${victim}.view.json`);
  const victim_rules = JSON.parse(read_text(victim_path));
  check(
    `${victim}.view.json carries the pair to compare`,
    truthy(victim_rules.listRule) && truthy(victim_rules.viewRule),
    true,
  );
  check(
    `${victim}.viewRule starts with the auth guard the listRule requires`,
    victim_rules.viewRule.startsWith(COMMENTS_CUT),
    true,
  );
  victim_rules.viewRule = victim_rules.viewRule.replace(COMMENTS_CUT, "");
  fs.writeFileSync(victim_path, JSON.stringify(victim_rules, null, 2));

  proc = cli("--rules-dir", scratch_schema, "--json");
  const view_report = JSON.parse(proc.stdout);
  check("the mutant view file fails the checker", proc.returncode, 1);
  check(
    "the finding names the view collection and the dropped clause",
    view_report.violations.map((v: any) => [v.collection, v.clause]),
    [[victim, AUTH_CLAUSE]],
  );
  check("every other collection stays clean", view_report.violations.length, 1);
} finally {
  fs.rmSync(scratch_dir, { recursive: true });
}

console.log('\n── (e) end-to-end RED: tasks.viewRule loses its top-level `trashed = ""` ──');
const tasks_bytes_before = fs.readFileSync(TASKS_RULES);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pbvwl_"));
try {
  const mutant = path.join(scratch, "schema");
  copy_tree(SCHEMA_DIR, mutant);
  const mutant_view = mutate(mutant, "tasks", TASKS_CUT);
  check("the mutant viewRule really lost the clause", mutant_view.includes(TASKS_CUT), false);

  proc = cli("--rules-dir", mutant);
  check("the mutant copy fails the checker", proc.returncode, 1);
  check(
    "stdout names the collection",
    proc.stdout.includes("❌ tasks: viewRule admits a row"),
    true,
  );
  check(
    "stdout prints the clause AS WRITTEN in the listRule",
    proc.stdout.includes(`as written in listRule: ${TRASHED_CLAUSE}`),
    true,
  );
  check(
    "stdout labels the copyable ALLOWLIST key",
    proc.stdout.includes(`ALLOWLIST key:          ${TRASHED_CLAUSE}`),
    true,
  );
  check("stdout names the fix: a NEW migration", proc.stdout.includes("NEW pb_migrations/"), true);
  check("stdout names the fix: regenerate", proc.stdout.includes("scripts/gen_schema.ts"), true);
  check(
    "stdout forbids hand-editing schema/",
    proc.stdout.includes("never hand-edit schema/"),
    true,
  );
  check("stdout offers the ALLOWLIST escape hatch", proc.stdout.includes("ALLOWLIST entry"), true);
  check(
    "summary line counts the violation",
    proc.stdout.includes("❌ check_view_within_list: 1 viewRule clause(s) broader than listRule"),
    true,
  );

  check(
    "the real schema/tasks.rules.json is byte-identical",
    fs.readFileSync(TASKS_RULES).equals(tasks_bytes_before),
    true,
  );

  console.log("\n── (f) allowlist suppresses exactly its own case ──");
  const k = key("tasks", TRASHED_CLAUSE);
  const allowed = vwl.run(
    mutant,
    new Map([...SHIPPED_ALLOW, [k, "ruling: covered by a hook, not the rule"]]),
  );
  check("the allowlisted case reports 0 violations", allowed.violations, []);
  check(
    "...and is listed as allowlisted",
    sorted(allowed.allowlisted.map((e: any) => e.collection)),
    sorted([...ALLOWED_COLLECTIONS, "tasks"]),
  );
  check("...with no stale entry", allowed.stale_allowlist, []);
  check("...so the report is ok", allowed.ok, true);

  const comments_view = mutate(mutant, "comments", COMMENTS_CUT);
  check(
    "the comments viewRule really lost the guard",
    comments_view.startsWith(AUTH_CLAUSE),
    false,
  );

  const both = vwl.run(
    mutant,
    new Map([...SHIPPED_ALLOW, [k, "ruling: covered by a hook, not the rule"]]),
  );
  check(
    "a second, independent violation is STILL reported",
    both.violations.map((v: any) => [v.collection, v.clause]),
    [["comments", AUTH_CLAUSE]],
  );
  check(
    "...the tasks case stays suppressed",
    sorted(both.allowlisted.map((e: any) => e.collection)),
    sorted([...ALLOWED_COLLECTIONS, "tasks"]),
  );
  check("...and the report is not ok", both.ok, false);

  const bare = vwl.run(mutant, new Map(SHIPPED_ALLOW));
  check(
    "without the allowlist entry the tasks case is RED again",
    pairs(bare.violations.map((v: any) => [v.collection, v.clause])),
    [
      ["comments", AUTH_CLAUSE],
      ["tasks", TRASHED_CLAUSE],
    ],
  );

  console.log("\n── (g) an entry with an empty reason is an error and suppresses nothing ──");
  const empty_reason = vwl.run(mutant, new Map([...SHIPPED_ALLOW, [k, "   "]]));
  check("the empty-reason entry is reported invalid", empty_reason.invalid_allowlist, [
    { collection: "tasks", clause: TRASHED_CLAUSE },
  ]);
  check(
    "...and its case is still reported",
    pairs(empty_reason.violations.map((v: any) => [v.collection, v.clause])),
    [
      ["comments", AUTH_CLAUSE],
      ["tasks", TRASHED_CLAUSE],
    ],
  );
  check("...and it is not double-reported as stale", empty_reason.stale_allowlist, []);
  check("...and the report is not ok", empty_reason.ok, false);
} finally {
  fs.rmSync(scratch, { recursive: true });
}
check("scratch schema copy cleaned up", fs.existsSync(scratch), false);

console.log("\n── (h) a stale entry on the clean tree is an error ──");
const stale = vwl.run(
  SCHEMA_DIR,
  new Map([...SHIPPED_ALLOW, [key("tasks", TRASHED_CLAUSE), "no longer needed"]]),
);
check("no violations on the clean tree", stale.violations, []);
check(
  "the entry that matched nothing is named stale",
  stale.stale_allowlist.map((e: any) => [e.collection, e.clause]),
  [["tasks", TRASHED_CLAUSE]],
);
check("...and the report is not ok", stale.ok, false);
check(
  "an empty-reason entry on the clean tree is invalid, not stale",
  vwl.run(SCHEMA_DIR, new Map([[key("tasks", TRASHED_CLAUSE), ""]])).stale_allowlist,
  [],
);
check(
  "...it is reported invalid",
  vwl.run(SCHEMA_DIR, new Map([[key("tasks", TRASHED_CLAUSE), ""]])).invalid_allowlist,
  [{ collection: "tasks", clause: TRASHED_CLAUSE }],
);

console.log("\n── (h2) the ALLOWLIST key is usable from the message alone ──");
// The canonical key sorts operands, so it can differ from the source spelling; both are printed.
const SRC_CLAUSE = '(scope = "workspace" || owner = @request.auth.id)';
const KEY_CLAUSE = '(owner = @request.auth.id || scope = "workspace")';
const synth = fs.mkdtempSync(path.join(os.tmpdir(), "pbvwl_synth_"));
try {
  fs.writeFileSync(
    path.join(synth, "demo.rules.json"),
    JSON.stringify({ listRule: `${AUTH_CLAUSE} && ${SRC_CLAUSE}`, viewRule: AUTH_CLAUSE }),
  );

  const synth_report = vwl.run(synth);
  check(
    "the canonical key really differs from the source spelling here",
    [synth_report.violations[0].clause, synth_report.violations[0].as_written],
    [KEY_CLAUSE, SRC_CLAUSE],
  );
  proc = cli("--rules-dir", synth);
  check("the synthetic pair is RED", proc.returncode, 1);
  check(
    "stdout carries the source spelling",
    proc.stdout.includes(`as written in listRule: ${SRC_CLAUSE}`),
    true,
  );
  check(
    "stdout carries the canonical key",
    proc.stdout.includes(`ALLOWLIST key:          ${KEY_CLAUSE}`),
    true,
  );
  check(
    "the printed key is the one that actually suppresses",
    vwl.run(synth, new Map([[key("demo", KEY_CLAUSE), "ruling"]])).violations,
    [],
  );

  console.log("\n── (h3) a MISSPELLED stale key is told to be corrected, not dropped ──");
  const misspelled = vwl.run(synth, new Map([[key("demo", SRC_CLAUSE), "ruling"]]));
  check(
    "the misspelled key goes stale",
    misspelled.stale_allowlist.map((e: any) => [e.collection, e.clause]),
    [["demo", SRC_CLAUSE]],
  );
  check(
    "...and the stale entry names the key that would have matched",
    misspelled.stale_allowlist[0].did_you_mean,
    [KEY_CLAUSE],
  );
  // No CLI flag plants an allowlist, so the rendering is driven by mutating the shipped map
  // in place — run()'s default binds that object, and it is restored below.
  check(
    "misspelled: stdout says correct it, not drop it",
    rendered(synth, new Map([[key("demo", SRC_CLAUSE), "ruling"]])).includes("likely MISSPELLED") &&
      rendered(synth, new Map([[key("demo", SRC_CLAUSE), "ruling"]])).includes(KEY_CLAUSE),
    true,
  );
  check(
    "genuinely obsolete: stdout still says drop the entry",
    rendered(SCHEMA_DIR, new Map([[key("tasks", TRASHED_CLAUSE), "obsolete"]])).includes(
      "drop the entry",
    ),
    true,
  );
  check("the shipped ALLOWLIST is left as shipped", new Map(vwl.ALLOWLIST), SHIPPED_ALLOW);
} finally {
  fs.rmSync(synth, { recursive: true });
}

console.log("\n── (i) a bad --rules-dir refuses loudly instead of passing empty ──");
const empty_dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbvwl_empty_"));
try {
  proc = cli("--rules-dir", empty_dir);
  check("a directory with no rule files exits 2", proc.returncode, 2);
  check("...and says so", proc.stdout.includes("no *.rules.json or *.view.json found"), true);
} finally {
  fs.rmdirSync(empty_dir);
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

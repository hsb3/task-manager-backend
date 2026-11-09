#!/usr/bin/env bun
// TASK-061 — unit-pin scripts/check_rule_auth_guards.ts: witness enumeration, guard precedence, MODEL_CAP collapse, allowlist staleness, escaped-quote parsing, and frozen historical rule verdicts (no server, no DB).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, py_int, py_repr, read_text, py_strip } from "../scripts/_py.ts";
import * as guards from "../scripts/check_rule_auth_guards.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const CHECKER = path.join(REPO_ROOT, "scripts", "check_rule_auth_guards.ts");

// Frozen from git 1373bd0~1:schema/comments.rules.json (pre-TASK-046, anon-satisfiable).
const HIST_COMMENTS_UPDATE =
  'author = @request.auth.id || task.project.workspace.owner = @request.auth.id || (task.project.workspace.workspace_members_via_workspace.user ?= @request.auth.id && task.project.workspace.workspace_members_via_workspace.role ?= "admin") || document.workspace.owner = @request.auth.id || (document.workspace.workspace_members_via_workspace.user ?= @request.auth.id && document.workspace.workspace_members_via_workspace.role ?= "admin") || decision.workspace.owner = @request.auth.id || (decision.workspace.workspace_members_via_workspace.user ?= @request.auth.id && decision.workspace.workspace_members_via_workspace.role ?= "admin") || ((task.project.workspace.owner = @request.auth.id || (task.project.workspace.workspace_members_via_workspace.user ?= @request.auth.id && task.project.workspace.workspace_members_via_workspace.role ?!= "viewer") || task.assignee = @request.auth.id || document.workspace.owner = @request.auth.id || (document.workspace.workspace_members_via_workspace.user ?= @request.auth.id && document.workspace.workspace_members_via_workspace.role ?!= "viewer") || decision.workspace.owner = @request.auth.id || (decision.workspace.workspace_members_via_workspace.user ?= @request.auth.id && decision.workspace.workspace_members_via_workspace.role ?!= "viewer")) && @request.body.body:isset = false && @request.body.parent:isset = false && @request.body.task:isset = false && @request.body.document:isset = false && @request.body.decision:isset = false && @request.body.author:isset = false && @request.body.edited:isset = false && @request.body.reactions:isset = true)';
const HIST_COMMENTS_DELETE =
  'author = @request.auth.id || task.project.workspace.owner = @request.auth.id || (task.project.workspace.workspace_members_via_workspace.user ?= @request.auth.id && task.project.workspace.workspace_members_via_workspace.role ?= "admin") || document.workspace.owner = @request.auth.id || (document.workspace.workspace_members_via_workspace.user ?= @request.auth.id && document.workspace.workspace_members_via_workspace.role ?= "admin") || decision.workspace.owner = @request.auth.id || (decision.workspace.workspace_members_via_workspace.user ?= @request.auth.id && decision.workspace.workspace_members_via_workspace.role ?= "admin")';
// Frozen from git 06ed2b9~1:schema/tasks.rules.json (pre-TASK-049, anon-satisfiable).
const HIST_TASKS_UPDATE =
  'workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= "viewer") || assignee = @request.auth.id';

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

function run(...args: string[]): { returncode: number; stdout: string } {
  const proc = Bun.spawnSync([process.execPath, CHECKER, ...args]);
  return { returncode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

/** root.a? -> mid{b? -> leaf{owner!}, t!}: `a.b.owner` has exactly two empty-witnesses. */
function synthetic_graph(): guards.Graph {
  const fs_ = guards.FieldSpec;
  return new guards.Graph(
    new Map([
      ["root", new Map([["a", new fs_("a", "relation", false, "mid")]])],
      [
        "mid",
        new Map([
          ["b", new fs_("b", "relation", false, "leaf")],
          ["t", new fs_("t", "text", true, null)],
        ]),
      ],
      ["leaf", new Map([["owner", new fs_("owner", "relation", true, "u")]])],
      ["u", new Map()],
    ]),
  );
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort(by_code_point);

console.log("════════ test_rule_guard_checker.ts — TASK-061 anon-rule checker unit pins ════════");

const syn = synthetic_graph();
const real = guards.load_graph(guards.SCHEMA_DIR, guards.MODEL_DIR);

console.log("\n── (a) has_leading_auth_guard truth table ──");
for (const [rule, want] of [
  [null, false],
  ["", false],
  ['@request.auth.id != ""', true],
  ['@request.auth.id != "" && owner = @request.auth.id', true],
  ['(@request.auth.id != "" && owner = @request.auth.id)', true],
  ['@request.auth.id != "" && a = b || c = d', false],
  ['(@request.auth.id != "" && a = b) || c = d', false],
  ['owner = @request.auth.id && @request.auth.id != ""', false],
  ['@request.auth.id = ""', false],
  ['@request.auth.id  !=  ""', true],
  // GUARD is spelled with double quotes and normalization only re-spaces the operands,
  // so the single-quoted empty string is NOT recognized as the house guard.
  ["@request.auth.id != ''", false],
] as [string | null, boolean][]) {
  check(`has_leading_auth_guard(${py_repr(rule)})`, guards.has_leading_auth_guard(rule), want);
}

console.log("\n── (b) multi-witness pruning, synthetic graph ──");
let info = syn.resolve("root", "a.b.owner");
check("a.b.owner resolves", info.resolved, true);
check("a.b.owner yields exactly 2 empty-witnesses", info.witnesses.length, 2);
check(
  "witness #1: `a` empty, no prefix has to be populated",
  [info.witnesses[0]!.empty_prefix, sorted(info.witnesses[0]!.nonempty_prefixes)],
  ["a", []],
);
check(
  "witness #2: `a.b` empty, requires `a` populated",
  [info.witnesses[1]!.empty_prefix, sorted(info.witnesses[1]!.nonempty_prefixes)],
  ["a.b", ["a"]],
);
check("a.b.owner proper prefixes", info.proper_prefixes, ["a", "a.b"]);

let verdict = guards.anon_satisfiable(
  "root",
  'a.b.owner = @request.auth.id && a.t = "x"',
  syn,
  "updateRule",
);
check(
  "a benign sibling clause must not erase the whole atom — verdict stays SAT",
  verdict.sat,
  true,
);
check("surviving clause", verdict.clause, "a.b.owner = @request.auth.id");
check(
  "survivor is witness #2 (`mid.b` empty)",
  verdict.reason.includes("`mid.b` is not required"),
  true,
);
check(
  "witness #1 (`root.a` empty) is the one `a.t` killed",
  verdict.reason.includes("`root.a`"),
  false,
);

console.log("\n── (c) multi-witness pruning, real repo graph (comments) ──");
info = real.resolve("comments", "task.project.owner");
check("task.project.owner yields exactly 3 empty-witnesses", info.witnesses.length, 3);
check(
  "witness prefixes",
  info.witnesses.map((w) => [w.empty_prefix, sorted(w.nonempty_prefixes)]),
  [
    ["task", []],
    ["task.project", ["task"]],
    ["task.project.owner", ["task", "task.project"]],
  ],
);
verdict = guards.anon_satisfiable(
  "comments",
  'task.project.owner = @request.auth.id && task.title = "x"',
  real,
  "updateRule",
);
check("verdict stays SAT against the shipped schema", verdict.sat, true);
check("surviving clause", verdict.clause, "task.project.owner = @request.auth.id");
check(
  "survivor is the `tasks.project` witness",
  verdict.reason.includes("`tasks.project` is not required"),
  true,
);

console.log("\n── (d) MODEL_CAP overflow collapses toward SAT ──");
check("shipped MODEL_CAP", guards.MODEL_CAP, 256);
const CAP_RULE =
  '(a.b.owner = @request.auth.id || a.b.owner ?= @request.auth.id) && a.b.owner = "x"';
const shipped_cap = guards.MODEL_CAP;
try {
  guards.use_model_cap(3);
  check(
    "cap exceeded: the collapsed model carries no prefix needs, so nothing prunes it — SAT",
    guards.anon_satisfiable("root", CAP_RULE, syn, "updateRule").sat,
    true,
  );
  guards.use_model_cap(4);
  check(
    'cap at the model count: every model conflicts with `a.b.owner = "x"` — UNSAT',
    guards.anon_satisfiable("root", CAP_RULE, syn, "updateRule").sat,
    false,
  );
} finally {
  guards.use_model_cap(shipped_cap);
}
check("MODEL_CAP restored", guards.MODEL_CAP, 256);
check(
  "same rule under the shipped cap is UNSAT",
  guards.anon_satisfiable("root", CAP_RULE, syn, "updateRule").sat,
  false,
);

console.log("\n── (e) allowlist: shipped entries + CLI fails on a stale one ──");
check(
  "ALLOWLIST holds exactly the 3 shipped keys",
  sorted(guards.ALLOWLIST.keys()).map((k) => JSON.parse(k)),
  [
    ["app_docs", "listRule"],
    ["app_docs", "viewRule"],
    ["users", "createRule"],
  ],
);
check(
  "every allowlist value states a non-empty reason",
  [...guards.ALLOWLIST].filter(([, v]) => !(typeof v === "string" && py_strip(v))).map(([k]) => k),
  [],
);

const stale_dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbguard_stale_"));
const stale_path = path.join(stale_dir, "rules.json");
fs.writeFileSync(
  stale_path,
  JSON.stringify({ listRule: '@request.auth.id != ""', viewRule: '@request.auth.id != ""' }),
);
try {
  let proc = run("--rules", `app_docs=${stale_path}`);
  check("an allowlisted rule that is no longer anon-satisfiable fails the CLI", proc.returncode, 1);
  check(
    "stdout names the stale entry",
    proc.stdout.includes("stale allowlist entry app_docs.listRule"),
    true,
  );
  proc = run("--json", "--rules", `app_docs=${stale_path}`);
  const report = JSON.parse(proc.stdout);
  check("--json reports ok: false", report.ok, false);
  check(
    "--json stale_allowlist names both app_docs read rules",
    report.stale_allowlist
      .map((e: any) => [e.collection, e.rule])
      .sort((a: string[], b: string[]) => by_code_point(a.join("\0"), b.join("\0"))),
    [
      ["app_docs", "listRule"],
      ["app_docs", "viewRule"],
    ],
  );
} finally {
  fs.rmSync(stale_dir, { recursive: true, force: true });
}
check("temp rules file cleaned up", fs.existsSync(stale_path), false);

console.log("\n── (f) historical rules stay caught; shipped rules stay clean ──");
for (const [label, collection, rule_name, rule, want_clause] of [
  [
    "historical comments.updateRule",
    "comments",
    "updateRule",
    HIST_COMMENTS_UPDATE,
    "author = @request.auth.id",
  ],
  [
    "historical comments.deleteRule",
    "comments",
    "deleteRule",
    HIST_COMMENTS_DELETE,
    "author = @request.auth.id",
  ],
  [
    "historical tasks.updateRule",
    "tasks",
    "updateRule",
    HIST_TASKS_UPDATE,
    "assignee = @request.auth.id",
  ],
] as [string, string, string, string, string][]) {
  verdict = guards.anon_satisfiable(collection, rule, real, rule_name);
  check(`${label} is anon-satisfiable`, verdict.sat, true);
  check(`${label} clause`, verdict.clause, want_clause);
}

const shipped: Record<string, any> = {};
for (const name of ["comments", "tasks"]) {
  shipped[name] = JSON.parse(read_text(path.join(guards.SCHEMA_DIR, `${name}.rules.json`)));
}
for (const [collection, rule_name] of [
  ["comments", "updateRule"],
  ["comments", "deleteRule"],
  ["tasks", "updateRule"],
] as [string, string][]) {
  verdict = guards.anon_satisfiable(collection, shipped[collection][rule_name], real, rule_name);
  check(`shipped ${collection}.${rule_name} is NOT anon-satisfiable`, verdict.sat, false);
}

verdict = guards.anon_satisfiable("comments", HIST_COMMENTS_DELETE, real, "deleteRule");
check("`also:` clauses are reported", verdict.other_clauses.length > 0, true);
check(
  "`also:` clauses are deduplicated",
  verdict.other_clauses.length,
  new Set(verdict.other_clauses).size,
);
check(
  "`also:` never repeats the headline clause",
  verdict.other_clauses.includes(verdict.clause),
  false,
);

console.log("\n── (g) view columns are never required ──");
const columns = real.collections.get("project_stats")!;
check("project_stats exposes columns", columns.size > 0, true);
check(
  "no view column is required",
  [...columns.values()].filter((c) => c.required).map((c) => c.name),
  [],
);
check(
  "every view column is computed",
  [...columns.values()].filter((c) => !c.computed).map((c) => c.name),
  [],
);

console.log("\n── (h) the three imprecisions all bias toward flagging ──");
verdict = guards.anon_satisfiable("comments", "parent.task = task", real, "createRule");
check("an unparsable atom is classified SATISFIABLE", verdict.sat, true);
check("...and surfaces in Verdict.unparsed", verdict.unparsed, ["parent.task = task"]);
verdict = guards.anon_satisfiable("comments", null, real, "createRule");
check("a null rule is NOT anon-satisfiable", verdict.sat, false);
check("...and says superuser-only", verdict.reason.includes("superuser-only"), true);
verdict = guards.anon_satisfiable("comments", "", real, "listRule");
check("an empty-string rule IS anon-satisfiable", verdict.sat, true);
check("...and names itself as the clause", verdict.clause, '""');

console.log("\n── (i) strip_outer_parens strips only parens wrapping the WHOLE expression ──");
for (const [raw, want] of [
  ["(a) && (b)", "(a) && (b)"],
  ["((x))", "x"],
  ["(a && b)", "a && b"],
  ["  ( a )  ", "a"],
  ["a = b", "a = b"],
  // A paren inside a string literal must not move the depth counter, or the wrapper is
  // misread and the expression comes back corrupted rather than merely unstripped.
  ['(name = ")")', 'name = ")"'],
  ['(a = "(") && (b)', '(a = "(") && (b)'],
] as [string, string][]) {
  check(`strip_outer_parens(${py_repr(raw)})`, guards.strip_outer_parens(raw), want);
}

console.log("\n── (j) _classify_operand: every operand kind the lattice branches on ──");
for (const [text, want] of [
  ["@request.auth.id", ["auth_id", "@request.auth.id"]],
  ["@request.body.approved:isset", ["body", "@request.body.approved:isset"]],
  ["@request.headers.x_token", ["request", "@request.headers.x_token"]],
  ['""', ["empty", ""]],
  ["''", ["empty", ""]],
  ['"viewer"', ["literal", "viewer"]],
  ["42", ["literal", "42"]],
  ["-3.5", ["literal", "-3.5"]],
  ["true", ["literal", "true"]],
  ["false", ["literal", "false"]],
  ["task.project.owner", ["path", "task.project.owner"]],
  ["role:isset", ["unknown", "role:isset"]],
] as [string, [string, string]][]) {
  check(`_classify_operand(${py_repr(text)})`, guards._classify_operand(text), want);
}

console.log("\n── (k) end-to-end drift alarm against the shipped schema ──");
let proc = run("--json");
let report = JSON.parse(proc.stdout);
check("the shipped schema reports ok", report.ok, true);
// Pinning the unparsed COUNT would go red on every added rule; a @request.body atom reaching
// `unparsed` means operand classification regressed, which no rule addition can cause.
check(
  "no @request.body atom falls through to `unparsed`",
  report.unparsed.map((e: any) => e.atom).filter((a: string) => a.includes("@request.body")),
  [],
);

console.log("\n── (l) an escaped quote in a literal must not desynchronise the verdict path ──");
// `\"` is literal CONTENT. A scanner that reads it as the literal's end runs the rest of the
// rule with inverted quote state, and the corrupted decomposition reports UNSAT for a rule
// whose second disjunct is completely unguarded.
const ESC_RULE =
  '(@request.auth.id != "" && title = "a\\"b") || (project = "" && assignee = @request.auth.id)';
const CTL_RULE =
  '(@request.auth.id != "" && title = "ab") || (project = "" && assignee = @request.auth.id)';
check(
  "strip_outer_parens leaves `(a) || (b)` alone when a literal carries an escaped quote",
  guards.strip_outer_parens(ESC_RULE),
  ESC_RULE,
);
check(
  "strip_outer_parens: an escaped quote hiding a paren does not corrupt the expression",
  guards.strip_outer_parens('(a = "\\"(" ) && (b = c)'),
  '(a = "\\"(" ) && (b = c)',
);
check(
  "split_comparison ignores an operator inside a literal reached through an escaped quote",
  guards.split_comparison('"a\\"=b" = title'),
  ['"a\\"=b"', "=", "title"],
);
check(
  "split_top_level and split_comparison agree on the same literal",
  guards.split_top_level('title = "a\\"||b" || project = ""', "||"),
  ['title = "a\\"||b"', 'project = ""'],
);
check(
  "anon_satisfiable: the escaped spelling reaches the same verdict as its control",
  [
    guards.anon_satisfiable("tasks", ESC_RULE, real, "viewRule").sat,
    guards.anon_satisfiable("tasks", CTL_RULE, real, "viewRule").sat,
  ],
  [true, true],
);

const esc_scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pbguard_esc_"));
try {
  const esc_schema = path.join(esc_scratch, "schema");
  copy_tree(guards.SCHEMA_DIR, esc_schema);
  const esc_path = path.join(esc_schema, "tasks.rules.json");
  for (const [label, rule] of [
    ["escaped", ESC_RULE],
    ["control", CTL_RULE],
  ] as [string, string][]) {
    const esc_rules = JSON.parse(read_text(esc_path));
    esc_rules.viewRule = rule;
    fs.writeFileSync(esc_path, JSON.stringify(esc_rules, null, 2));
    proc = run("--schema-dir", esc_schema, "--json");
    const esc_report = JSON.parse(proc.stdout);
    check(`CLI, ${label} spelling: the unguarded disjunct fails the gate`, proc.returncode, 1);
    check(
      `CLI, ${label} spelling: the finding names tasks.viewRule`,
      esc_report.findings.map((f: any) => [f.collection, f.rule]),
      [["tasks", "viewRule"]],
    );
    check(
      `CLI, ${label} spelling: nothing is quietly counted un-analysed instead`,
      esc_report.unparsed.filter((e: any) => e.rule === "tasks.viewRule"),
      [],
    );
  }
} finally {
  fs.rmSync(esc_scratch, { recursive: true });
}
check("escape scratch schema cleaned up", fs.existsSync(esc_scratch), false);

console.log("\n── (m) fuzz: literal CONTENT never changes the verdict ──");
// Two renderings of ONE random expression tree — escaped payload vs an escape-free control —
// must agree; a disagreement where the control is SAT is a rule the gate would wrongly pass.
const FUZZ_PAIRS = py_int(process.env.GUARD_FUZZ_PAIRS ?? "2000");
const FUZZ_ESCAPES = [
  'a\\"b',
  '\\"',
  "\\\\",
  'x\\"=y',
  'p\\")q',
  's\\"&&t',
  'u\\"||v',
  "q\\'r",
  '\\"(',
];
const FUZZ_LEAVES = [
  '@request.auth.id != ""',
  '@request.auth.id = ""',
  'project = ""',
  "assignee = @request.auth.id",
  "workspace.owner = @request.auth.id",
  "LIT",
];

/** Seeded mulberry32 standing in for Python's random.Random(seed): same shape, other corpus. */
class Rng {
  constructor(public state: number) {}
  random(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  choice<T>(xs: T[]): T {
    return xs[Math.floor(this.random() * xs.length)]!;
  }
}

type Tree = string | [string, Tree, Tree];

function fuzz_tree(rng: Rng, depth: number): Tree {
  if (depth <= 0 || rng.random() < 0.35) return rng.choice(FUZZ_LEAVES);
  return [rng.choice(["&&", "||"]), fuzz_tree(rng, depth - 1), fuzz_tree(rng, depth - 1)];
}

function fuzz_render(node: Tree, rng: Rng, payload: string): string {
  if (typeof node === "string") {
    if (node === "LIT") {
      const q = rng.choice(['"', "'"]);
      return `title = ${q}${payload}${q}`;
    }
    return node;
  }
  const [op, left, right] = node;
  const out = `${fuzz_render(left, rng, payload)} ${op} ${fuzz_render(right, rng, payload)}`;
  return rng.random() < 0.6 ? `(${out})` : out;
}

const wrong_passes: string[] = [];
let mismatches = 0;
for (let seed = 0; seed < FUZZ_PAIRS; seed++) {
  const rng = new Rng(seed);
  const shape = fuzz_tree(rng, 3);
  const escaped = rng.choice(FUZZ_ESCAPES);
  // The control drops the backslash AND the character it bound, so a merely quote-aware
  // scanner reads it correctly — any divergence is escape handling, nothing else.
  const control = escaped.replace(/\\(.)/g, "z");
  const state = rng.state;
  const esc_rule = fuzz_render(shape, rng, escaped);
  rng.state = state;
  const ctl_rule = fuzz_render(shape, rng, control);
  const esc_sat = guards.anon_satisfiable("tasks", esc_rule, real, "viewRule").sat;
  const ctl_sat = guards.anon_satisfiable("tasks", ctl_rule, real, "viewRule").sat;
  if (esc_sat !== ctl_sat) {
    mismatches += 1;
    if (ctl_sat && !esc_sat) wrong_passes.push(esc_rule);
  }
}
check(
  `${FUZZ_PAIRS} pairs: 0 wrong passes (escaped UNSAT where the control is SAT)`,
  wrong_passes.slice(0, 3),
  [],
);
check(`${FUZZ_PAIRS} pairs: 0 verdict mismatches in either direction`, mismatches, 0);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

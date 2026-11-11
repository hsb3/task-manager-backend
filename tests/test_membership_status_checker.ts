#!/usr/bin/env bun
/**
 * Card 5ad2 — unit-pin scripts/check_membership_status_guards.ts: rule-disjunct and hook-filter
 * membership-grant detection, prefix/alias correlation, unresolved-site failure, and allowlist
 * staleness + citation (no server, no DB).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, py_repr, read_text, splitlines, truthy } from "../scripts/_py.ts";
import * as guard from "../scripts/check_membership_status_guards.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const CHECKER = path.join(REPO_ROOT, "scripts", "check_membership_status_guards.ts");

const AUTH = "@request.auth.id";
const MEM = "workspace.workspace_members_via_workspace";
const PROJ_MEM = "project.workspace.workspace_members_via_workspace";
const ALIAS = "@collection.workspace_members:mem";
const ALIAS2 = "@collection.workspace_members:adm";

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
const cmp_tuple = (a: string[], b: string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = by_code_point(a[i]!, b[i]!);
    if (c) return c;
  }
  return a.length - b.length;
};
const sorted_tuples = (xs: string[][]): string[][] => [...xs].sort(cmp_tuple);
const key = (...parts: string[]): string => JSON.stringify(parts);

function with_tmp<T>(prefix: string, fn: (tmp: string) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** -> [sorted [collection, rule, site] findings for synthetic rules, the scan], via the real scanner. */
function rule_sites(
  rules_by_collection: Record<string, Record<string, string | null>>,
  allowlist: guard.Allowlist | null = null,
): [string[][], guard.RuleScan] {
  return with_tmp("pbmem_rules_", (tmp) => {
    for (const [name, rules] of Object.entries(rules_by_collection)) {
      fs.writeFileSync(path.join(tmp, `${name}.rules.json`), JSON.stringify(rules));
    }
    const scan = guard.scan_rules(tmp, allowlist ?? new Map());
    return [sorted_tuples(scan.findings.map((f) => [f.collection, f.rule_name, f.site])), scan];
  });
}

/** -> the real hook scan over one synthetic pb_hooks file. */
function hook_scan(source: string, allowlist: guard.Allowlist | null = null): guard.HookScan {
  return with_tmp("pbmem_hooks_", (tmp) => {
    fs.writeFileSync(path.join(tmp, "synthetic.pb.js"), source);
    return guard.scan_hooks(tmp, allowlist ?? new Map());
  });
}

function cli(...args: string[]): { returncode: number; stdout: string } {
  const proc = Bun.spawnSync([process.execPath, CHECKER, ...args]);
  return { returncode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

console.log(
  "════════ test_membership_status_checker.ts — card 5ad2 membership-branch lint ════════",
);

console.log("\n── (a) rule disjuncts: the status pin must sit on the SAME prefix ──");
const RULE_CASES: Record<string, [string, string[]]> = {
  // label: [rule, expected finding sites]
  "same prefix, pinned": [
    `${AUTH} != "" && (owner = ${AUTH} || (${MEM}.user ?= ${AUTH} && ${MEM}.status ?= "active"))`,
    [],
  ],
  "status pin on a DIFFERENT prefix in the same disjunct": [
    `${AUTH} != "" && (owner = ${AUTH} || (${MEM}.user ?= ${AUTH} && ` +
      `${PROJ_MEM}.status ?= "active"))`,
    [MEM],
  ],
  "no status pin at all": [`${AUTH} != "" && (owner = ${AUTH} || ${MEM}.user ?= ${AUTH})`, [MEM]],
  "status pinned to a NON-active value": [
    `${AUTH} != "" && (${MEM}.user ?= ${AUTH} && ${MEM}.status ?= "invited")`,
    [MEM],
  ],
  "alias form, pinned": [
    `${AUTH} != "" && (${ALIAS}.workspace ?= workspace && ${ALIAS}.user ?= ${AUTH} && ` +
      `${ALIAS}.status ?= "active")`,
    [],
  ],
  "alias form, unpinned": [
    `${AUTH} != "" && (${ALIAS}.workspace ?= workspace && ${ALIAS}.user ?= ${AUTH})`,
    [ALIAS],
  ],
  "alias form, status pinned on a DIFFERENT alias": [
    `${AUTH} != "" && (${ALIAS}.user ?= ${AUTH} && ${ALIAS2}.status ?= "active")`,
    [ALIAS],
  ],
  "granting disjunct nested one level down, unpinned": [
    `${AUTH} != "" && (owner = ${AUTH} || (type = "task" && (assignee = ${AUTH} || ` +
      `${MEM}.user ?= ${AUTH})))`,
    [MEM],
  ],
  "granting disjunct nested one level down, pinned": [
    `${AUTH} != "" && (owner = ${AUTH} || (type = "task" && (assignee = ${AUTH} || ` +
      `(${MEM}.user ?= ${AUTH} && ${MEM}.status ?= "active"))))`,
    [],
  ],
  "status pin HOISTED above the disjunction still gates it": [
    `${MEM}.status ?= "active" && (owner = ${AUTH} || ${MEM}.user ?= ${AUTH})`,
    [],
  ],
  "inequality on user is not a grant": [
    `${AUTH} != "" && (owner = ${AUTH} || ${MEM}.user ?!= ${AUTH})`,
    [],
  ],
  "membership compared to something other than the caller is not a grant": [
    `${AUTH} != "" && (owner = ${AUTH} || ${MEM}.user ?= assignee)`,
    [],
  ],
  "two prefixes, only one pinned": [
    `${AUTH} != "" && ((${MEM}.user ?= ${AUTH} && ${MEM}.status ?= "active") || ` +
      `${PROJ_MEM}.user ?= ${AUTH})`,
    [PROJ_MEM],
  ],
};
for (const [label, [rule, want_sites]] of Object.entries(RULE_CASES)) {
  const [got] = rule_sites({ syn: { listRule: rule } });
  check(label, got, sorted_tuples(want_sites.map((s) => ["syn", "listRule", s])));
}

let [got, rscan] = rule_sites({ syn: { listRule: null, viewRule: null } });
check("a null rule is not scanned at all", [got, rscan.rules_scanned], [[], 0]);
[got, rscan] = rule_sites({ syn: { listRule: `${MEM}.user ?= ${AUTH}` } });
check("a bare grant with no disjunction is still walked", got, [["syn", "listRule", MEM]]);
check("...and counts as one membership disjunct", rscan.member_branches, 1);

console.log("\n── (b) view rules are read from *.view.json, not *.rules.json ──");
const vscan = with_tmp("pbmem_view_", (tmp) => {
  fs.writeFileSync(
    path.join(tmp, "v.view.json"),
    JSON.stringify({ name: "v", listRule: `${ALIAS}.user ?= ${AUTH}`, viewRule: null }),
  );
  return guard.scan_rules(tmp, new Map());
});
check(
  "an unpinned alias grant in a view rule is caught",
  vscan.findings.map((f) => [f.collection, f.rule_name, f.site]),
  [["v", "listRule", ALIAS]],
);
check("its null viewRule is not scanned", vscan.rules_scanned, 1);

console.log("\n── (b2) a view's pin lives in its viewQuery subselect, not in the rule ──");
const PINNED = " AND m.status = 'active'";

/** decision:project-items-membership-denormalised's shape: the roster denormalised onto the row by a correlated subselect. */
function member_query(pin: string, column = "members", alias = "m"): string {
  return (
    "SELECT u.id AS id, CAST(u.assignee AS TEXT) AS assignee, " +
    `CAST((',' || COALESCE((SELECT group_concat(${alias}.user) FROM workspace_members ` +
    `${alias} WHERE ${alias}.workspace = u.workspace${pin}), '') || ',') AS TEXT) ` +
    `AS ${column} FROM tasks u`
  );
}

/** -> the real rule scan over one synthetic schema/*.view.json. */
function view_scan(
  query: string,
  rules: Record<string, string>,
  allowlist: guard.Allowlist | null = null,
): guard.RuleScan {
  return with_tmp("pbmem_vq_", (tmp) => {
    fs.writeFileSync(
      path.join(tmp, "v.view.json"),
      JSON.stringify({ name: "v", viewQuery: query, ...rules }),
    );
    return guard.scan_rules(tmp, allowlist ?? new Map());
  });
}

const LIKE_GRANT = `${AUTH} != "" && members ~ ${AUTH}`;
const VIEW_CASES: Record<string, [string, string, string[]]> = {
  "a LIKE grant whose subselect pins active is accepted": [member_query(PINNED), LIKE_GRANT, []],
  "the same grant with NO status clause in the subselect is refused": [
    member_query(""),
    LIKE_GRANT,
    ["members"],
  ],
  "a subselect pinning a NON-active status is refused": [
    member_query(" AND m.status = 'invited'"),
    LIKE_GRANT,
    ["members"],
  ],
  "a status pin on a DIFFERENT alias in that subselect does not count": [
    member_query(" AND other.status = 'active'"),
    LIKE_GRANT,
    ["members"],
  ],
  "an equality grant against the denormalised column is a grant too": [
    member_query(""),
    `${AUTH} != "" && members = ${AUTH}`,
    ["members"],
  ],
  "...and is accepted when its subselect pins active": [
    member_query(PINNED),
    `${AUTH} != "" && members = ${AUTH}`,
    [],
  ],
  "matching the column against something other than the caller is not a grant": [
    member_query(""),
    `${AUTH} != "" && members ~ assignee`,
    [],
  ],
  "a column whose expression never reads workspace_members is not a membership column": [
    member_query(PINNED),
    `${AUTH} != "" && assignee ~ ${AUTH}`,
    [],
  ],
};
for (const [label, [query, rule, want_sites]] of Object.entries(VIEW_CASES)) {
  const scan = view_scan(query, { listRule: rule });
  check(label, sorted(scan.findings.map((f) => f.site)), sorted(want_sites));
}

rscan = view_scan(member_query(PINNED), { listRule: LIKE_GRANT });
check(
  "a pinned view column is counted, and counted as pinned",
  [rscan.view_queries, rscan.view_columns, rscan.view_columns_pinned],
  [1, 1, 1],
);
check("...and its granting branch counts as a membership grant", rscan.member_branches, 1);
rscan = view_scan(member_query(""), { listRule: LIKE_GRANT });
check(
  "an unpinned view column is counted but not counted as pinned",
  [rscan.view_columns, rscan.view_columns_pinned],
  [1, 0],
);
check("the refusal names the subselect and the pin it needs", rscan.findings[0]!.detail, [
  "subselect: FROM workspace_members m WHERE m.workspace = u.workspace",
  "needs:     m.status = 'active' inside that viewQuery subselect",
]);
check(
  "a column is only a grant for the rule that matches it",
  view_scan(member_query(""), { listRule: LIKE_GRANT }).findings.map((f) => f.rule_name),
  ["listRule"],
);
check(
  "both view rules are scanned for it",
  sorted(
    view_scan(member_query(""), { listRule: LIKE_GRANT, viewRule: LIKE_GRANT }).findings.map(
      (f) => f.rule_name,
    ),
  ),
  ["listRule", "viewRule"],
);

const JOIN_QUERY = (auth: string): string =>
  "SELECT t.id AS id FROM tasks t JOIN workspace_members m ON m.workspace = t.workspace " +
  `AND m.user = ${auth}`;
check(
  "a membership JOIN in the view query itself is judged like any other SQL predicate",
  view_scan(JOIN_QUERY("t.assignee"), { listRule: `${AUTH} != ""` }).sql_findings.map((s) => [
    s.callee,
    s.granting,
    s.guarded,
  ]),
  [["sql:m", true, false]],
);
check(
  "...and is accepted once that join pins active",
  view_scan(JOIN_QUERY("t.assignee") + " AND m.status = 'active'", {
    listRule: `${AUTH} != ""`,
  }).sql_findings,
  [],
);

check(
  "view_columns keeps an inner CAST(... AS TYPE) inside its item",
  guard.view_columns("SELECT CAST(x.a AS TEXT) AS a, b.c, d AS e FROM t"),
  new Map([
    ["a", "CAST(x.a AS TEXT)"],
    ["c", "b.c"],
    ["e", "d"],
  ]),
);
check(
  "view_columns refuses a query it cannot decompose",
  guard.view_columns("WITH q AS (SELECT 1) SELECT * FROM q"),
  null,
);
let setup_error: string | null;
try {
  guard.view_member_columns("v", "WITH q AS (SELECT 1 FROM workspace_members m) SELECT 1");
  setup_error = null;
} catch (exc) {
  if (!(exc instanceof guard.SetupError)) throw exc;
  setup_error = exc.message;
}
check(
  "an undecomposable query that READS workspace_members is a setup error, not a pass",
  truthy(setup_error && setup_error.includes("workspace_members")),
  true,
);
check(
  "sql=True reads one SQL statement instead of a JS file's string literals",
  guard
    .sql_sites(
      "v",
      "SELECT 1 FROM workspace_members z WHERE z.user = x AND z.status = 'active'",
      true,
    )
    .map((s) => [s.callee, s.granting, s.guarded]),
  [["sql:z", true, true]],
);
check(
  "...and its statement end bounds the window, so a bare predicate is not unterminated",
  guard
    .sql_sites("v", "SELECT 1 FROM workspace_members z WHERE z.user = x", true)
    .map((s) => s.resolved),
  [true],
);
check(
  "column_grant only fires for a column the view query actually backs",
  [
    guard.column_grant(`members ~ ${AUTH}`, new Map([["members", []]])),
    guard.column_grant(`members ~ ${AUTH}`, new Map()),
    guard.column_grant(`members != ${AUTH}`, new Map([["members", []]])),
  ],
  ["members", null, null],
);

console.log("\n── (c) hook filters: grant shape, bindings, and one-level local resolution ──");
const HOOK_SRC = `
var __base = "workspace = {:w} && user = {:u} && status = 'active'";
onX(function (e) {
  e.app.findFirstRecordByFilter("workspace_members", "workspace = {:c1} && user = {:u} && status = 'active'", { w: a, u: b });
  e.app.findFirstRecordByFilter("workspace_members", "workspace = {:c2} && user = {:u}", { w: a, u: b });
  e.app.findFirstRecordByFilter("workspace_members", "workspace = {:c3} && user != {:u}", { w: a, u: b });
  e.app.findFirstRecordByFilter("workspace_members", "workspace = {:c4} && user = {:u} && status = {:s}", { w: a, u: b, s: "active" });
  e.app.findFirstRecordByFilter("workspace_members", "workspace = {:c5} && user = {:u} && status = {:s}", { w: a, u: b, s: "suspended" });
  e.app.findFirstRecordByFilter("workspace_members", "workspace = {:c6} && user = {:u} && status = {:s}");
  e.app.findFirstRecordByFilter("workspace_members", __base + " && role = 'admin' && workspace = {:c7}", { w: a });
  e.app.findFirstRecordByFilter("workspace_members", cond ? __base + " && workspace = {:c8}" : "workspace = {:c8} && user = {:u}", { w: a });
  e.app.findFirstRecordByFilter("workspace_members", someFilter, { w: a });
  e.app.findRecordsByFilter("workspace_members", "workspace = {:c10} && [[user]] = {:u} && [[status]] = 'active'", { w: a });
  var NOT_A_SITE = ["workspaces", "workspace_members", "projects"];
  // e.app.findFirstRecordByFilter("workspace_members", "workspace = {:cX} && user = {:u}", {});
});
`;
let hscan = hook_scan(HOOK_SRC);
const by_case = new Map<string | null, guard.HookSite>();
for (const site of hscan.sites) {
  const tags = Array.from({ length: 10 }, (_, i) => `c${i + 1}`);
  const tag = tags.find((t) => site.filters.join(" ").includes(`{:${t}}`)) ?? null;
  by_case.set(tag, site);
}
check("every synthetic site is enumerated exactly once", hscan.sites.length, 10);
check(
  "an array-literal occurrence is not a call site",
  HOOK_SRC.includes("NOT_A_SITE") && hscan.sites.length,
  10,
);
check(
  "a commented-out call is not a call site",
  hscan.sites.filter((s) => s.filters.join(" ").includes("cX")),
  [],
);
check("finder names are DERIVED, both spellings seen", sorted(hscan.callees), [
  "e.app.findFirstRecordByFilter",
  "e.app.findRecordsByFilter",
]);

const HOOK_EXPECT: Record<string, [string, boolean, boolean, boolean]> = {
  c1: ["literal status = 'active'", true, true, true],
  c2: ["grant with no status clause", true, true, false],
  c3: ["user != is not a grant", true, false, true],
  c4: ["status = {:s} bound to 'active'", true, true, true],
  c5: ["status = {:s} bound to 'suspended'", true, true, false],
  c6: ["status = {:s} with NO bindings argument", true, true, false],
  c7: ["one-level var resolution through concatenation", true, true, true],
  c8: ["ternary whose SECOND arm drops the status clause", true, true, false],
  c10: ["[[user]] bracket form is recognized as a grant", true, true, true],
};
for (const [tag, [label, resolved, granting, guarded]] of Object.entries(HOOK_EXPECT)) {
  const site = by_case.get(tag);
  check(label, site ? [site.resolved, site.granting, site.guarded] : null, [
    resolved,
    granting,
    guarded,
  ]);
}

const unresolved = hscan.sites.filter((s) => !s.resolved);
check("an unresolvable filter expression is a FINDING, never a silent pass", unresolved.length, 1);
check("...and reports itself as unresolved", unresolved[0]!.filters, [
  "<unresolved filter: e.app.findFirstRecordByFilter(...)>",
]);
check(
  "the findings are exactly the unpinned grants plus the unresolvable site",
  sorted(hscan.findings.map((s) => s.filters.join(" "))),
  sorted([
    "workspace = {:c2} && user = {:u}",
    "workspace = {:c5} && user = {:u} && status = {:s}",
    "workspace = {:c6} && user = {:u} && status = {:s}",
    // The ternary's guarded arm carries __base's own {:w}; only its SECOND arm is unpinned.
    "workspace = {:w} && user = {:u} && status = 'active' && workspace = {:c8}" +
      " workspace = {:c8} && user = {:u}",
    "<unresolved filter: e.app.findFirstRecordByFilter(...)>",
  ]),
);
check(
  "a site is anchored on the line carrying the collection name",
  by_case.get("c1")!.line,
  splitlines(HOOK_SRC).indexOf(
    '  e.app.findFirstRecordByFilter("workspace_members", "workspace = {:c1} && user = {:u} && status = \'active\'", { w: a, u: b });',
  ) + 1,
);

console.log("\n── (c2) raw-SQL membership predicates, built by string concatenation ──");
const SQL_SRC = `
function search(coll) {
  var a = "EXISTS (SELECT 1 FROM workspace_members m WHERE m.tag = 'q1' AND m.workspace = " + coll + ".workspace AND m.[[user]] = {:uid} AND m.status = 'active')";
  var b = "EXISTS (SELECT 1 FROM workspace_members n WHERE n.tag = 'q2' AND n.workspace = " + coll + ".workspace AND n.[[user]] = {:uid})";
  var c = "EXISTS (SELECT 1 FROM workspace_members o WHERE o.tag = 'q3' AND o.[[user]] = {:uid} AND o.status = 'invited')";
  var d = "EXISTS (SELECT 1 FROM workspace_members p WHERE p.tag = 'q4' AND p.[[user]] != {:uid})";
  var e = "EXISTS (SELECT 1 FROM workspace_members q WHERE q.tag = 'q5' AND q.[[user]] = {:uid} AND m.status = 'active')";
  var f = "SELECT 1 FROM workspace_members r WHERE r.tag = 'q6' AND r." + column + " = {:uid}";
  var g = "SELECT 1 FROM workspace_members s JOIN x ON 1=1 WHERE s.tag = 'q7' AND s.user = {:uid} AND s.status = 'active'";
  var h = "SELECT 1 FROM workspace_members t WHERE t.tag = 'q8' AND t.[[user]] = {:uid}";
}
`;
const sql = new Map<string | null, guard.HookSite>();
for (const site of hook_scan(SQL_SRC).sites) {
  const tags = Array.from({ length: 8 }, (_, i) => `q${i + 1}`);
  sql.set(tags.find((t) => site.filters[0]!.includes(`'${t}'`)) ?? null, site);
}
check("every FROM workspace_members predicate is enumerated", sql.size, 8);
check("the alias becomes the site identity", sorted([...sql.values()].map((s) => s.callee)), [
  "sql:m",
  "sql:n",
  "sql:o",
  "sql:p",
  "sql:q",
  "sql:r",
  "sql:s",
  "sql:t",
]);
const SQL_EXPECT: Record<string, [string, boolean, boolean, boolean]> = {
  q1: ["concatenated predicate, user pinned to active", true, true, true],
  q2: ["concatenated predicate with NO status clause", true, true, false],
  q3: ["status pinned to a NON-active value", true, true, false],
  q4: ["[[user]] != is not a grant", true, false, true],
  q5: ["status pinned on a DIFFERENT alias does not count", true, true, false],
  // granting is UNKNOWN here, not true — but unresolved alone already denies `ok`.
  q6: [
    "the user column itself comes from a gap — unresolved, never a silent pass",
    false,
    false,
    false,
  ],
  q7: ["a JOIN-form predicate with a bare `user` column is covered", true, true, true],
  q8: ["an unpinned predicate with no gap at all", true, true, false],
};
for (const [tag, [label, resolved, granting, ok]] of Object.entries(SQL_EXPECT)) {
  const site = sql.get(tag);
  check(label, site ? [site.resolved, site.granting, site.ok] : null, [resolved, granting, ok]);
}
check(
  "the SQL findings are exactly the unpinned and unresolved predicates",
  sorted(hook_scan(SQL_SRC).findings.map((s) => s.callee)),
  ["sql:n", "sql:o", "sql:q", "sql:r", "sql:t"],
);
check(
  "a predicate whose text simply runs out is a FINDING, never a silent pass",
  hook_scan(
    "\"SELECT 1 FROM workspace_members z WHERE z.user = {:u} AND z.status = 'active'\"",
  ).findings.map((s) => [s.callee, s.resolved, s.filters[0]!.startsWith("<unterminated")]),
  [["sql:z", false, true]],
);
check(
  "a separator ends the predicate, so it never reads into the NEXT literal's status pin",
  hook_scan(
    'var a = "SELECT 1 FROM workspace_members z WHERE z.user = {:u}";\n' +
      "var b = \"AND z.status = 'active'\";",
  ).sites.map((s) => [s.callee, s.granting, s.guarded]),
  [["sql:z", true, false]],
);
check(
  "a SQL site reports the line its FROM clause sits on",
  sql.get("q1")!.line,
  splitlines(SQL_SRC).indexOf(splitlines(SQL_SRC).find((ln) => ln.includes("'q1'"))!) + 1,
);
const FLAT_SRC = 'var x = "a" + y + "b";';
const [flat, flat_offsets] = guard.flatten_strings(FLAT_SRC);
check(
  "flatten_strings joins literals; a joining gap is GAP, a separator is BREAK",
  flat,
  guard.GAP + "a" + guard.GAP + "b" + guard.BREAK,
);
check(
  "flatten_strings offsets map a flat index back to its source char",
  FLAT_SRC[flat_offsets[flat.indexOf("b")]!],
  "b",
);
check("sql_window stops at the paren closing the subquery", guard.sql_window("a) tail", 0), "a");
check("sql_window ignores a balanced inner paren", guard.sql_window("f(x)) tail", 0), "f(x)");
check(
  "sql_window stops at a statement separator",
  guard.sql_window("a" + guard.BREAK + "b", 0),
  "a",
);
check("sql_window reports a predicate that just runs out", guard.sql_window("a b c", 0), null);

console.log("\n── (d) allowlist: a stale or uncited entry FAILS ──");
const FINDER = "e.app.findFirstRecordByFilter";
const stale_key = ["synthetic.pb.js", FINDER, "workspace = {:nope} && user = {:u}"];
hscan = hook_scan(HOOK_SRC, new Map([[key(...stale_key), "no such site (PBTT-431)"]]));
check("an allowlist entry naming no live site is not hit", hscan.hit.has(key(...stale_key)), false);

const live_key = ["synthetic.pb.js", FINDER, "workspace = {:c2} && user = {:u}"];
hscan = hook_scan(HOOK_SRC, new Map([[key(...live_key), "deliberate exception (PBTT-431)"]]));
check(
  "an allowlisted finding stops being a finding",
  hscan.findings.some((s) => key(...s.key) === key(...live_key)),
  false,
);
check(
  "...and is reported as an exception",
  hscan.allowed.map(([s]) => s.key),
  [live_key],
);
check(
  "the key carries no line number, so it survives an edit above the site",
  live_key.filter((n) => typeof n === "number"),
  [],
);
const shifted = hook_scan(
  "// an edit that changes nothing relevant\n" + HOOK_SRC,
  new Map([[key(...live_key), "still exempt (PBTT-431)"]]),
);
check(
  "...proven: prepending a line moves every site down one",
  shifted.sites.map((s) => s.line),
  hscan.sites.map((s) => s.line + 1),
);
check(
  "...and the allowlist entry still matches, so the gate does not cry wolf",
  shifted.allowed.map(([s]) => s.key),
  [live_key],
);

for (const [text, want] of [
  ["cited PBTT-431", true],
  ["cited TASK-061", true],
  ["cited decision-39", true],
  ["cited decision:active-membership-grants-access", true],
  ["decision: with no slug", false],
  ["owner ruling pz18", true],
  ["card 5ad2 says so", true],
  ["kata ref c9mm", true],
  ["this reason cites nothing at all", false],
  ["dated 2026 with no card", false],
  ["PBTT- with no number", false],
] as [string, boolean][]) {
  check(`citation token in ${py_repr(text)}`, guard.CITATION_RE.test(text), want);
}

check(
  "every shipped allowlist reason carries a citation",
  [...guard._uncited(guard.ALLOWLIST_RULES), ...guard._uncited(guard.ALLOWLIST_HOOKS)],
  [],
);

console.log(
  "\n── (d2) decision:invitation-keyed-by-email: the invitee-view exemption is GONE — the shipped rule pins directly ──",
);
// `invited` retired from workspace_members.status (decision:invitation-keyed-by-email): workspaces.viewRule no longer
// carries the (active || invited) disjunct that needed its own allowlist entry — it now pins
// status = "active" in the SAME conjunct as the user grant, which the scanner already accepts
// with no exemption. ALLOWLIST_RULES is empty for exactly this reason.
const WS_MEM = "workspace_members_via_workspace";
const KW = "@request.headers.x_tm_key_workspace";
const SHIPPED_VIEW = `${AUTH} != "" && (${AUTH} != "" && (owner = ${AUTH} || (${WS_MEM}.user ?= ${AUTH} && ${WS_MEM}.status ?= "active")) && trashed = "") && (${KW} = "" || id = ${KW})`;
const EXEMPTION_CASES: Record<string, [string, string[]]> = {
  "the shipped active-only view rule needs NO allowlist entry": [SHIPPED_VIEW, []],
  "a view rule with NO status term is a finding": [
    `${AUTH} != "" && (owner = ${AUTH} || ${WS_MEM}.user ?= ${AUTH}) && trashed = ""`,
    [WS_MEM],
  ],
  "a term admitting suspended instead of active is a finding": [
    SHIPPED_VIEW.replaceAll('"active"', '"suspended"'),
    [WS_MEM],
  ],
  // A regression back to the retired (active || invited) shape: the OR sub-expression forms
  // its OWN branch (branches() walks the OR-tree), so the grant branch's scope no longer
  // carries a status pin at all — this is exactly the shape that used to need allowlisting.
  "a regression to the old (active || invited) OR-shape is a finding again": [
    `${AUTH} != "" && (owner = ${AUTH} || (${WS_MEM}.user ?= ${AUTH} && ` +
      `(${WS_MEM}.status ?= "active" || ${WS_MEM}.status ?= "invited"))) && trashed = ""`,
    [WS_MEM],
  ],
  "the term on a DIFFERENT prefix is a finding": [
    SHIPPED_VIEW.replaceAll(`${WS_MEM}.status ?= "active"`, `${PROJ_MEM}.status ?= "active"`),
    [WS_MEM],
  ],
};
for (const [label, [rule, want_sites]] of Object.entries(EXEMPTION_CASES)) {
  [got] = rule_sites({ workspaces: { viewRule: rule } }, guard.ALLOWLIST_RULES);
  check(label, got, sorted_tuples(want_sites.map((s) => ["workspaces", "viewRule", s])));
}

console.log(
  "\n── (d2b) the LIVE schema/workspaces.rules.json viewRule matches SHIPPED_VIEW above ──",
);
const live_view_rule = JSON.parse(
  read_text(path.join(REPO_ROOT, "schema", "workspaces.rules.json")),
).viewRule;
check(
  "the hand-typed SHIPPED_VIEW constant tracks the real generated schema",
  live_view_rule,
  SHIPPED_VIEW,
);
const live_scan = guard.scan_rules(path.join(REPO_ROOT, "schema"), guard.ALLOWLIST_RULES);
check(
  "the real checker run over the real schema finds nothing on workspaces.viewRule",
  live_scan.findings.filter((f) => f.collection === "workspaces" && f.rule_name === "viewRule"),
  [],
);

const MUTANT_VIEW =
  '@request.auth.id != "" && (owner = @request.auth.id || ' +
  'workspace_members_via_workspace.user ?= @request.auth.id) && trashed = ""';
with_tmp("pbmem_mutant_", (tmp) => {
  const mutant_dir = path.join(tmp, "schema");
  copy_tree(path.join(REPO_ROOT, "schema"), mutant_dir);
  const ws_path = path.join(mutant_dir, "workspaces.rules.json");
  const ws_rules = JSON.parse(read_text(ws_path));
  ws_rules.viewRule = MUTANT_VIEW;
  fs.writeFileSync(ws_path, JSON.stringify(ws_rules));
  const proc = cli("--schema-dir", mutant_dir);
  check("the reviewer's schema mutant FAILS the real checker", proc.returncode, 1);
  check("...naming the workspaces viewRule", proc.stdout.includes("workspaces"), true);
});

console.log("\n── (e) helpers the detection rests on ──");
const tree = guard.branches("a = 1 && (b = 2 || (c = 3 && (d = 4 || e = 5)))");
check(
  "branches() walks every OR-tree conjunction node",
  sorted_tuples(tree.map((b) => b.own)),
  sorted_tuples([["a = 1"], ["b = 2"], ["c = 3"], ["d = 4"], ["e = 5"]]),
);
check(
  "a nested branch inherits its ancestors' conjuncts",
  sorted(tree.find((b) => b.own.includes("e = 5"))!.scope),
  ["a = 1", "c = 3", "e = 5"],
);
check("member_ref reads the back-relation prefix", guard.member_ref(`${PROJ_MEM}.status`), [
  PROJ_MEM,
  "status",
]);
check("member_ref reads the alias", guard.member_ref(`${ALIAS}.user`), [ALIAS, "user"]);
check("member_ref ignores an unrelated path", guard.member_ref("workspace.owner"), null);
const commented = 'var a = 1; // "workspace_members",\nvar b = 2;';
const blanked = guard.blank_comments(commented);
check("blank_comments preserves every offset", blanked.length, commented.length);
check("...and every newline", blanked.split("\n").length - 1, 1);
check("...and erases the comment body", blanked.includes("workspace_members"), false);
check("...leaving the code untouched", blanked.split("\n")[0]!.trimEnd(), "var a = 1;");
const inside = guard.blank_comments('var u = "http://x"; // gone');
check("a // inside a string literal is not a comment", inside.includes('"http://x"'), true);
check("...but the real trailing comment still goes", inside.includes("gone"), false);
const src = 'f("a", { k: 1, j: 2 }, [1, 2], "b")';
check("split_args splits at top-level commas only", guard.split_args(src, src.indexOf("(")), [
  '"a"',
  "{ k: 1, j: 2 }",
  "[1, 2]",
  '"b"',
]);
check("split_args refuses an unclosed call", guard.split_args('f("a", ', 1), null);
check(
  "resolve_filter expands one level of local var",
  guard.resolve_filter('X + " && role = 1"', new Map([["X", '"user = {:u}"']])),
  ["user = {:u} && role = 1"],
);
check("resolve_filter yields BOTH ternary arms", guard.resolve_filter('c ? "a" : "b"', new Map()), [
  "a",
  "b",
]);
check(
  "resolve_filter refuses an unknown identifier",
  guard.resolve_filter("someFilter", new Map()),
  null,
);
check(
  "resolve_filter refuses a two-level var chain",
  guard.resolve_filter("X", new Map([["X", "Y"]])),
  null,
);
check(
  "parse_bindings keeps only string literals",
  guard.parse_bindings("{ s: \"active\", w: wsId, r: 'admin' }"),
  new Map([
    ["s", "active"],
    ["r", "admin"],
  ]),
);

console.log("\n── (f) end-to-end against the shipped tree ──");
let proc = cli("--json");
const report = JSON.parse(proc.stdout);
check("the shipped tree reports ok", report.ok, true);
check("...and exits 0", proc.returncode, 0);
check("no rule finding", report.rules.findings, []);
check("no hook finding", report.hooks.findings, []);
check("no stale allowlist entry", report.stale_allowlist, []);
// Pinning the COUNTS would go red on every added rule; what must never regress is that the
// walk still reaches membership disjuncts and hook sites at all.
check("membership disjuncts are actually reached", report.rules.membership_disjuncts > 0, true);
check("hook sites are actually reached", report.hooks.sites.length > 0, true);
check(
  "the shipped views' membership columns are reached",
  report.rules.view_membership_columns > 0,
  true,
);
check(
  "...and every one of them is pinned",
  report.rules.view_membership_columns_pinned,
  report.rules.view_membership_columns,
);
check("no view query predicate finding", report.rules.view_query_findings, []);
const site_spots = new Set(report.hooks.sites.map((s: any) => `${s.file}\0${s.line}`));
check(
  "every allowlisted hook site is a real site in the scan",
  report.hooks.allowlisted
    .filter((e: any) => !site_spots.has(`${e.file}\0${e.line}`))
    .map((e: any) => e.key),
  [],
);

proc = cli("--schema-dir", "/nonexistent");
check("a missing schema dir is a SETUP error, not a pass", proc.returncode, 2);
proc = cli("--hooks-dir", "/nonexistent");
check("a missing hooks dir is a SETUP error, not a pass", proc.returncode, 2);

const lib_scan = with_tmp("pbmem_lib_", (tmp) => {
  fs.mkdirSync(path.join(tmp, "lib"));
  fs.writeFileSync(path.join(tmp, "top.pb.js"), "// nothing\n");
  fs.writeFileSync(
    path.join(tmp, "lib", "bad.js"),
    'app.findRecordsByFilter("workspace_members", "user = {:u}", "", 10, 0, { u: 1 });\n',
  );
  return guard.scan_hooks(tmp, new Map());
});
check(
  "a pb_hooks/lib/ site is scanned and named by its lib/ path",
  lib_scan.findings.map((f) => `${f.file}:${f.line}`),
  ["lib/bad.js:1"],
);
check("both files are counted", lib_scan.files_scanned, 2);

const helper_scan = hook_scan(
  'const m = earliest(app, "workspace_members", "user = {:u}", { u: 1 });\n',
);
check(
  "a helper call with the collection in a later argument is a site",
  helper_scan.findings.map((f) => `${f.file}:${f.line}`),
  ["synthetic.pb.js:1"],
);
const helper_ok = hook_scan(
  'const m = earliest(app, "workspace_members", "user = {:u} && status = \'active\'", { u: 1 });\n',
);
check("...and a pinned helper filter passes", helper_ok.findings.length, 0);
check("...as one scanned site", helper_ok.sites.length, 1);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

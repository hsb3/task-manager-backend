#!/usr/bin/env bun
/**
 * CI / pre-commit check: fail any collection whose viewRule admits a row its listRule excludes.
 *
 * Reads the generated `schema/*.rules.json` + `schema/*.view.json` only — no server, no DB.
 * PocketBase evaluates listRule and viewRule independently, so a clause required to LIST a record
 * but absent from the viewRule leaves that record filtered out of every list yet still fetchable
 * by id; that is the bug class this gate closes. The clause model is syntactic and deliberately
 * CONSERVATIVE: it compares canonicalised top-level `&&` conjuncts (insensitive to operand order,
 * whitespace, redundant parens and `&&` nesting, with `&&` binding tighter than `||`) and never
 * reasons about semantic implication — so a clause counts as present only when the viewRule spells
 * it the same way, and BOTH a rewritten-but-equivalent viewRule and one tightened strictly BELOW
 * its listRule are reported rather than passed. ALLOWLIST is the escape hatch. Public API (the
 * detection test imports it): collapse_ws, operands, canon, conjunct_sources, conjuncts,
 * violations_for, run, ALLOWLIST.
 */

import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  glob_sorted,
  json_dumps,
  os_error_text,
  print,
  py_strip,
  PY_WS_RE,
  read_text,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import * as guards from "./check_rule_auth_guards.ts";

export const REPO = repo_root(import.meta.path);
export const SCHEMA_DIR = path.join(REPO, "schema");

export const RULES_SUFFIX = ".rules.json";
export const VIEW_SUFFIX = ".view.json";
export const SUPERUSER_ONLY = "<superuser-only>";

// Key JSON([collection, canonical clause]) -> the ruling that makes a reported case correct.
// decision:invitation-keyed-by-email dropped the invited-member viewRule branch this used to allowlist (workspaces'
// view and list rules are now identical). project_items' trash branch is the one case today.
const TRASH_BRANCH_RULING =
  "card q46b: project_items' viewRule ORs a trash branch so one GET resolves an item's type, live or trashed, admitting exactly whom GET /api/tracker/trash shows the row to";
export const ALLOWLIST = new Map<string, string>([
  [
    JSON.stringify([
      "project_items",
      '(((active_admins ~ @request.auth.id || author = @request.auth.id || draft = false || workspace_owner = @request.auth.id) && (active_members ~ @request.auth.id || workspace_owner = @request.auth.id) && type != "task") || ((active_members ~ @request.auth.id || workspace_owner = @request.auth.id) && type = "task"))',
    ]),
    TRASH_BRANCH_RULING,
  ],
  [JSON.stringify(["project_items", "project_trashed = 0"]), TRASH_BRANCH_RULING],
  [JSON.stringify(["project_items", 'trashed = ""']), TRASH_BRANCH_RULING],
  [JSON.stringify(["project_items", "workspace_trashed = 0"]), TRASH_BRANCH_RULING],
]);
// ALLOWLIST key -> the one canonical viewRule clause that may stand in for the missing one, so a
// viewRule wider than the ruled shape is still a violation.
export const VIEW_PINS = new Map<string, string>();

// --- canonical form ------------------------------------------------------------------

/** Collapse whitespace runs to one space OUTSIDE string literals; inside them it is content. */
export function collapse_ws(expr: string): string {
  const out: string[] = [];
  let quote = "";
  let i = 0;
  while (i < expr.length) {
    const [nxt, q, in_literal] = guards.scan_step(expr, i, quote);
    quote = q;
    if (in_literal) out.push(expr.slice(i, nxt));
    else if (PY_WS_RE.test(expr[i]!)) {
      if (out.length && out[out.length - 1] !== " ") out.push(" ");
    } else out.push(expr[i]!);
    i = nxt;
  }
  return py_strip(out.join(""));
}

/** Normalise one comparison (or an opaque atom) to `left op right` with single spaces. */
export function canon_atom(atom: string): string {
  const parts = guards.split_comparison(atom);
  if (parts === null) return collapse_ws(atom);
  const [left, op, right] = parts;
  return `${collapse_ws(left)} ${op} ${collapse_ws(right)}`;
}

/** Top-level `sep` operands, splicing in a nested same-operator group — both are associative. */
export function operands(expr: string, sep: string): string[] {
  const other = sep === "&&" ? "||" : "&&";
  const out: string[] = [];
  for (const part of guards.split_top_level(expr, sep)) {
    const inner = guards.strip_outer_parens(part);
    const nested = guards.split_top_level(inner, sep).length > 1;
    if (nested && guards.split_top_level(inner, other).length <= 1) {
      out.push(...operands(inner, sep));
    } else out.push(part);
  }
  return out;
}

/** Canonical form of a rule expression: `&&` binds tighter than `||`, operands sorted. */
export function canon(expr: string): string {
  expr = guards.strip_outer_parens(expr);
  const ors = operands(expr, "||");
  if (ors.length > 1) return "(" + ors.map(canon).sort(by_code_point).join(" || ") + ")";
  const ands = operands(expr, "&&");
  if (ands.length > 1) return "(" + ands.map(canon).sort(by_code_point).join(" && ") + ")";
  return canon_atom(expr);
}

/** Canonical clause -> that clause AS WRITTEN, for every clause a matching record must satisfy. */
export function conjunct_sources(rule: string): Map<string, string> {
  const expr = guards.strip_outer_parens(rule);
  // `||` binds looser than `&&`: PocketBase reads `A && B || C` as `(A && B) || C`, where the
  // C branch makes A optional — so a top-level disjunction has NO separable conjunct.
  if (guards.split_top_level(expr, "||").length > 1) return new Map([[canon(expr), expr]]);
  return new Map(operands(expr, "&&").map((p) => [canon(p), p]));
}

/** Canonical clauses every matching record MUST satisfy. */
export function conjuncts(rule: string): Set<string> {
  return new Set(conjunct_sources(rule).keys());
}

/**
 * Canonical listRule clauses absent from viewRule; see the epilog for the scope bounds.
 *
 * Syntactic, so a viewRule tightened BELOW its listRule is reported too — only a clause
 * spelled the same way (modulo order, whitespace and parens) counts as present.
 */
export function violations_for(list_rule: string | null, view_rule: string | null): string[] {
  if (view_rule === null) return [];
  if (list_rule === null) return [SUPERUSER_ONLY];
  const view = conjuncts(view_rule);
  return [...conjuncts(list_rule)].filter((c) => !view.has(c)).sort(by_code_point);
}

// --- report ---------------------------------------------------------------------------

const cmp_tuple = (a: string[], b: string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = by_code_point(a[i]!, b[i]!);
    if (c) return c;
  }
  return a.length - b.length;
};

/** -> [collection, path] for every base and view collection; views carry the same rule keys. */
export function rule_files(rules_dir: string): [string, string][] {
  const out: [string, string][] = [];
  for (const suffix of [RULES_SUFFIX, VIEW_SUFFIX]) {
    for (const file of glob_sorted(rules_dir, suffix)) {
      out.push([path.basename(file).slice(0, -suffix.length), file]);
    }
  }
  return out.sort(cmp_tuple);
}

/** Compare listRule against viewRule for every base and view collection under `rules_dir`. */
export function run(
  rules_dir: string = SCHEMA_DIR,
  allowlist: Map<string, string> = ALLOWLIST,
): Record<string, any> {
  const invalid = [...allowlist]
    .filter(([, reason]) => !(typeof reason === "string" && py_strip(reason)))
    .map(([key]) => JSON.parse(key) as string[])
    .sort(cmp_tuple);
  // An entry with no reason states no ruling, so it suppresses nothing and is not also
  // counted stale — it is reported once, as invalid.
  const invalid_keys = new Set(invalid.map((k) => JSON.stringify(k)));
  const usable = new Map([...allowlist].filter(([k]) => !invalid_keys.has(k)));

  const findings: Record<string, any>[] = [];
  const allowed: Record<string, any>[] = [];
  const matched = new Set<string>();
  const unmatched = new Map<string, string[]>();
  let collections = 0;

  for (const [name, file] of rule_files(rules_dir)) {
    const rules = JSON.parse(read_text(file));
    collections += 1;
    const list_rule = guards.get_or(rules, "listRule");
    const view_rule = guards.get_or(rules, "viewRule");
    const missing = violations_for(list_rule, view_rule);
    const written = list_rule ? conjunct_sources(list_rule) : new Map<string, string>();
    for (const clause of missing) {
      const key = JSON.stringify([name, clause]);
      const pin = VIEW_PINS.get(key);
      let extra = new Set<string>();
      if (pin && view_rule) {
        const listed = conjuncts(list_rule);
        extra = new Set([...conjuncts(view_rule)].filter((c) => !listed.has(c)));
      }
      if (usable.has(key) && (pin === undefined || (extra.size === 1 && extra.has(pin)))) {
        matched.add(key);
        allowed.push({ collection: name, clause, reason: usable.get(key) });
        continue;
      }
      if (!unmatched.has(name)) unmatched.set(name, []);
      unmatched.get(name)!.push(clause);
      findings.push({
        collection: name,
        clause,
        as_written: written.get(clause) ?? clause,
        listRule: list_rule,
        viewRule: view_rule,
        ...(usable.has(key) && pin ? { pinned_view_clause: pin } : {}),
      });
    }
  }

  const stale = [...usable]
    .map(([k, reason]) => [JSON.parse(k) as string[], reason] as const)
    .sort((a, b) => cmp_tuple([...a[0], a[1]], [...b[0], b[1]]))
    .filter(([k]) => !matched.has(JSON.stringify(k)))
    .map(([[c, cl], reason]) => ({
      collection: c,
      clause: cl,
      reason,
      did_you_mean: unmatched.get(c!) ?? [],
    }));

  return {
    ok: !findings.length && !stale.length && !invalid.length,
    rules_dir,
    collections,
    violations: findings,
    allowlisted: allowed,
    stale_allowlist: stale,
    invalid_allowlist: invalid.map(([c, cl]) => ({ collection: c, clause: cl })),
    allowlist_size: allowlist.size,
  };
}

// --- CLI ------------------------------------------------------------------------------

export function main(): number {
  const prog = path.basename(process.argv[1] ?? "");
  const usage = `usage: ${prog} [-h] [--rules-dir RULES_DIR] [--json]`;
  const args = parse_args(
    usage,
    `${usage}

Fail any collection whose viewRule is broader than its listRule (static, no
server).

options:
  -h, --help            show this help message and exit
  --rules-dir RULES_DIR
                        default: repo schema/
  --json                machine-readable report

SCOPE BOUNDS: schema/*.rules.json (base collections) and schema/*.view.json
(view collections, which expose no create/update/delete surface); only the
listRule/viewRule pair is compared (create/update/delete rules belong to other
gates). The clause model is SYNTACTIC and deliberately conservative: it
compares canonicalised top-level && conjuncts, insensitive to operand order,
whitespace, redundant parens and && nesting, with && binding tighter than ||.
It does NOT reason about semantic implication, so a clause counts as present
only when the viewRule spells it the same way. TWO consequences, both by
design: a viewRule rewritten into an equivalent-but-different shape is
reported, AND so is a viewRule tightened strictly BELOW its listRule
(narrowing \`A && (B || C)\` to \`A && B\` drops the clause \`(B || C)\` and is
reported, even though it admits fewer rows). Either needs an ALLOWLIST entry,
in this file, carrying the ruling. A rule with a top-level || contributes
exactly one clause, itself, because no branch of a disjunction is individually
required. A null listRule is superuser-only, so any non-null viewRule beside
it is a violation; a null viewRule never is.
`,
    [
      ["--rules-dir", "store", "rules_dir"],
      ["--json", "store_true", "json"],
    ],
    { rules_dir: SCHEMA_DIR, json: false },
  );

  let report: Record<string, any>;
  try {
    report = run(args.rules_dir);
  } catch (exc) {
    print(
      `❌ check_view_within_list: ${exc instanceof SyntaxError ? exc.message : os_error_text(exc)}`,
    );
    return 2;
  }

  if (!report.collections) {
    print(
      `❌ check_view_within_list: no *${RULES_SUFFIX} or *${VIEW_SUFFIX} found in ` +
        `${args.rules_dir}`,
    );
    return 2;
  }

  if (args.json) {
    print(json_dumps(report, { indent: 2 }));
    return report.ok ? 0 : 1;
  }

  for (const v of report.violations) {
    print(`❌ ${v.collection}: viewRule admits a row its listRule excludes`);
    if (v.clause === SUPERUSER_ONLY) {
      print(
        "     listRule is null (superuser-only) while viewRule is not — every caller " +
          "the viewRule admits can fetch by id a record nobody may list",
      );
    } else {
      print("     clause required by listRule, missing from viewRule");
      print(`       as written in listRule: ${v.as_written}`);
    }
    print(`       ALLOWLIST key:          ${v.clause}`);
    if ("pinned_view_clause" in v) {
      print(`     allowlisted only with this viewRule clause: ${v.pinned_view_clause}`);
    }
    print(`     listRule: ${v.listRule ?? "None"}`);
    print(`     viewRule: ${v.viewRule ?? "None"}`);
    print(
      `     fix: add that clause to ${v.collection}.viewRule in a NEW pb_migrations/ ` +
        "migration and re-run `bun scripts/gen_schema.ts` to regenerate schema/ " +
        "(never hand-edit schema/) — or add an ALLOWLIST entry in " +
        "scripts/check_view_within_list.ts carrying the ruling that makes it correct",
    );
  }

  for (const e of report.invalid_allowlist) {
    print(`❌ invalid allowlist entry (${e.collection}, ${e.clause}): empty reason`);
    print("     an allowlist entry must carry the ruling that makes the case correct");
  }

  for (const e of report.stale_allowlist) {
    print(`❌ stale allowlist entry (${e.collection}, ${e.clause}): ${e.reason}`);
    if (e.did_you_mean.length) {
      print(
        `     ${e.collection} still has an unmatched violation, so this key is most ` +
          "likely MISSPELLED — correct it rather than dropping it. Key(s) that would " +
          "have matched:",
      );
      for (const clause of e.did_you_mean) print(`       ${clause}`);
    } else {
      print(
        "     that clause is no longer missing from the viewRule (or the collection is " +
          "gone) — drop the entry",
      );
    }
  }

  if (report.allowlisted.length) {
    print(`allowlisted exceptions (${report.allowlisted.length}):`);
    for (const e of report.allowlisted) print(`  • ${e.collection} — ${e.clause} — ${e.reason}`);
  }

  if (!report.ok) {
    print(
      `❌ check_view_within_list: ${report.violations.length} viewRule clause(s) broader ` +
        `than listRule, ${report.stale_allowlist.length} stale and ` +
        `${report.invalid_allowlist.length} invalid allowlist entr(ies).`,
    );
    return 1;
  }

  print(
    `✅ check_view_within_list: ${report.collections} collection(s) from ` +
      `schema/*${RULES_SUFFIX} + schema/*${VIEW_SUFFIX} — 0 viewRule broader than its ` +
      `listRule; ALLOWLIST: ${report.allowlist_size} entry(ies). Out of scope: the ` +
      "create/update/delete rules.",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

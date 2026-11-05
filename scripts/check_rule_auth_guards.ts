#!/usr/bin/env bun
/**
 * CI / pre-commit check: fail any collection rule an ANONYMOUS caller can satisfy.
 *
 * Reads the generated `schema/` + `scripts/model/current/` only — no server, no DB. An anon
 * caller has `@request.auth.id` == `""` and PocketBase coalesces an absent relation-join
 * value to `""`, so `<optional-path> = @request.auth.id` is TRUE for anon; that is the bug
 * class this gate closes. Public API (other tooling imports it): has_leading_auth_guard,
 * scan_step, split_top_level, strip_outer_parens, split_comparison, anon_satisfiable, ALLOWLIST.
 */

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  glob_sorted,
  json_dumps,
  os_error_text,
  print,
  py_repr,
  py_strip,
  read_text,
  truthy,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";

export const REPO = repo_root(import.meta.path);
export const SCHEMA_DIR = path.join(REPO, "schema");
export const MODEL_DIR = path.join(REPO, "scripts", "model", "current");

export const CRUD_RULES = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];
export const VIEW_RULES = ["listRule", "viewRule"];
export const AUTH_ID = "@request.auth.id";
export const GUARD = `${AUTH_ID} != ""`;

// Longest-first: the scanner takes the first match at a position.
export const OPERATORS = [
  "?!=",
  "?!~",
  "?>=",
  "?<=",
  "!=",
  "!~",
  "?=",
  "?~",
  "?>",
  "?<",
  ">=",
  "<=",
  "=",
  "~",
  ">",
  "<",
];
export const EQ_OPS = ["=", "?="];
export const NEQ_OPS = ["!=", "?!="];

export const BACK_RELATION = /^(?<target>[A-Za-z0-9_]+)_via_(?<field>[A-Za-z0-9_]+)$/;
export const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const NUMBER_RE = /^-?\p{Nd}+(\.\p{Nd}+)?$/u;

// Cross-product guard for correlated-prefix witnesses; overflow collapses toward SAT.
export let MODEL_CAP = 256;
/** Replaces Python's `guards.MODEL_CAP = n` (an importer cannot assign an ESM binding). */
export function use_model_cap(n: number): void {
  MODEL_CAP = n;
}

/** A tuple-keyed dict's key: the JSON of the tuple (`JSON.parse` gives the tuple back). */
export const ALLOWLIST = new Map<string, string>([
  [
    JSON.stringify(["app_docs", "listRule"]),
    "public by design: app_docs is the self-documenting collection, readable without an account",
  ],
  [
    JSON.stringify(["app_docs", "viewRule"]),
    "public by design: app_docs is the self-documenting collection, readable without an account",
  ],
  [
    JSON.stringify(["users", "createRule"]),
    "open signup: anonymous account creation is the point; the " +
      "`@request.body.approved:isset = false` clause blocks privilege injection",
  ],
]);

/** schema/ and scripts/model/current/ disagree — the id->name map cannot be trusted. */
export class StaleModelError extends Error {}

// --- expression splitting (paren-aware AND quote-aware) ---------------------------

/**
 * One scan step from `i` given quote state `quote` -> [next index, quote after, in-literal].
 *
 * Every rule-expression scanner drives its loop with this one — the splitters below and
 * check_view_within_list.collapse_ws. A private copy that reads `\\"` as the literal's end
 * desynchronises against the others and silently corrupts the decomposition.
 */
export function scan_step(expr: string, i: number, quote: string): [number, string, boolean] {
  const ch = expr[i]!;
  if (quote) {
    if (ch === "\\" && i + 1 < expr.length) return [i + 2, quote, true];
    return [i + 1, ch === quote ? "" : quote, true];
  }
  if (ch === '"' || ch === "'") return [i + 1, ch, true];
  return [i + 1, "", false];
}

/** Split `expr` on `sep` at paren depth 0, ignoring separators inside string literals. */
export function split_top_level(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  let quote = "";
  let i = 0;
  while (i < expr.length) {
    const [nxt, q, in_literal] = scan_step(expr, i, quote);
    quote = q;
    if (in_literal) {
      buf += expr.slice(i, nxt);
      i = nxt;
      continue;
    }
    const ch = expr[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(buf);
      buf = "";
      i += sep.length;
      continue;
    }
    buf += ch;
    i = nxt;
  }
  parts.push(buf);
  return parts.map((p) => py_strip(p)).filter((p) => p);
}

/** Drop parens that wrap the WHOLE expression (quote-aware); leave `(a) && (b)` alone. */
export function strip_outer_parens(s: string): string {
  s = py_strip(s);
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let quote = "";
    let wraps = true;
    let i = 0;
    while (i < s.length) {
      const [nxt, q, in_literal] = scan_step(s, i, quote);
      quote = q;
      if (!in_literal) {
        if (s[i] === "(") depth += 1;
        else if (s[i] === ")") {
          depth -= 1;
          if (depth === 0 && i < s.length - 1) {
            wraps = false;
            break;
          }
        }
      }
      i = nxt;
    }
    if (!wraps) return s;
    s = py_strip(s.slice(1, -1));
  }
  return s;
}

/** Split an atom at its top-level comparison operator -> [left, op, right]. */
export function split_comparison(atom: string): [string, string, string] | null {
  let depth = 0;
  let quote = "";
  let i = 0;
  while (i < atom.length) {
    const [nxt, q, in_literal] = scan_step(atom, i, quote);
    quote = q;
    if (!in_literal) {
      const ch = atom[i]!;
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (depth === 0) {
        for (const op of OPERATORS) {
          if (atom.startsWith(op, i)) {
            return [py_strip(atom.slice(0, i)), op, py_strip(atom.slice(i + op.length))];
          }
        }
      }
    }
    i = nxt;
  }
  return null;
}

/** House idiom: the FIRST top-level `&&` conjunct is exactly `@request.auth.id != ""`. */
export function has_leading_auth_guard(rule: string | null): boolean {
  if (!rule) return false;
  const expr = strip_outer_parens(rule);
  // `||` binds looser than `&&`, so `guard && A || B` leaves B unguarded.
  if (split_top_level(expr, "||").length > 1) return false;
  const conjuncts = split_top_level(expr, "&&");
  if (!conjuncts.length) return false;
  const parts = split_comparison(strip_outer_parens(conjuncts[0]!));
  if (parts === null) return false;
  const [left, op, right] = parts;
  return `${left} ${op} ${right}` === GUARD;
}

// --- schema graph ------------------------------------------------------------------

export class FieldSpec {
  constructor(
    public name: string,
    public type: string,
    public required: boolean,
    public target: string | null,
    public computed: boolean = false,
  ) {}
}

/** One way a path reads as "": segment i absent, every hop before it resolving to a row. */
export class EmptyWitness {
  constructor(
    public empty_prefix: string,
    public nonempty_prefixes: Set<string>,
    public why: string,
  ) {}
}

export class PathInfo {
  constructor(
    public resolved: boolean,
    public witnesses: EmptyWitness[],
    public proper_prefixes: string[],
  ) {}
}

export class Graph {
  constructor(public collections: Map<string, Map<string, FieldSpec>>) {}

  /** Walk a dotted field chain; emit one empty-witness per segment that can be absent. */
  resolve(collection: string, path: string): PathInfo {
    const segments = path.split(".");
    const prefixes: string[] = [];
    for (let i = 1; i < segments.length; i++) prefixes.push(segments.slice(0, i).join("."));
    let cur: string | null = collection;
    const witnesses: EmptyWitness[] = [];
    for (const [i, seg] of segments.entries()) {
      if (cur === null || !this.collections.has(cur)) return new PathInfo(false, [], prefixes);
      const back = BACK_RELATION.exec(seg);
      let emptiable: boolean;
      let reason: string;
      let nxt: string | null;
      if (back && this.collections.has(back.groups!.target!)) {
        emptiable = true;
        reason = `\`${seg}\` is a back-relation whose joined set can be empty`;
        nxt = back.groups!.target!;
      } else {
        const spec = this.collections.get(cur)!.get(seg);
        if (spec === undefined) {
          if (seg === "id") [emptiable, reason, nxt] = [false, "", null];
          else return new PathInfo(false, [], prefixes);
        } else {
          emptiable = !spec.required;
          reason = spec.computed
            ? `\`${cur}.${seg}\` is a computed view column, so it can come back NULL`
            : `\`${cur}.${seg}\` is not required, so it is "" on some records`;
          nxt = spec.target;
        }
      }
      if (emptiable) {
        witnesses.push(
          new EmptyWitness(
            segments.slice(0, i + 1).join("."),
            new Set(prefixes.slice(0, i)),
            reason,
          ),
        );
      }
      cur = nxt;
    }
    return new PathInfo(true, witnesses, prefixes);
  }
}

export const get_or = (d: any, k: string, dflt: any = null): any => (d && k in d ? d[k] : dflt);

/** Build name-keyed field specs, pairing schema collectionIds with current/*.yml targets. */
export function load_graph(schema_dir: string, model_dir: string): Graph {
  const schemas = new Map<string, any>();
  const views = new Map<string, any>();
  for (const file of glob_sorted(schema_dir, ".json")) {
    const base = path.basename(file);
    if (base.endsWith(".rules.json")) continue;
    const data = JSON.parse(read_text(file));
    if (base.endsWith(".view.json")) {
      views.set(get_or(data, "name", base.slice(0, -".view.json".length)), data);
      continue;
    }
    schemas.set(get_or(data, "name", base.slice(0, -5)), data);
  }

  const models = new Map<string, any>();
  for (const file of glob_sorted(model_dir, ".yml")) {
    const data = Bun.YAML.parse(read_text(file)) || {};
    models.set(get_or(data, "entity", path.basename(file).slice(0, -4)), data);
  }

  const id_to_name = new Map<any, any>();
  const problems: string[] = [];
  for (const [name, data] of schemas) {
    const model_relations = new Map<any, any>(
      (get_or(models.get(name) ?? {}, "relations") || []).map((r: any) => [r.field, r]),
    );
    for (const fld of get_or(data, "fields", [])) {
      if (get_or(fld, "type") !== "relation") continue;
      if (!models.has(name)) {
        problems.push(`scripts/model/current/${name}.yml missing (schema/${name}.json exists)`);
        continue;
      }
      const rel = model_relations.get(fld.name);
      if (rel === undefined) {
        problems.push(
          `${name}.${fld.name}: relation absent from scripts/model/current/${name}.yml`,
        );
        continue;
      }
      if (truthy(get_or(rel, "required")) !== truthy(get_or(fld, "required"))) {
        problems.push(
          `${name}.${fld.name}: required=${py_repr(truthy(get_or(fld, "required")))} in schema/, ` +
            `required=${py_repr(truthy(get_or(rel, "required")))} in scripts/model/current/`,
        );
        continue;
      }
      const cid = get_or(fld, "collectionId");
      const target = get_or(rel, "target");
      if (id_to_name.has(cid) && id_to_name.get(cid) !== target) {
        problems.push(
          `collectionId ${cid ?? "None"} maps to both \`${id_to_name.get(cid) ?? "None"}\` ` +
            `and \`${target ?? "None"}\``,
        );
        continue;
      }
      id_to_name.set(cid, target);
    }
  }

  for (const name of views.keys()) {
    if (!models.has(name)) {
      problems.push(`scripts/model/current/${name}.yml missing (schema/${name}.view.json exists)`);
    }
  }

  if (problems.length) {
    throw new StaleModelError(
      "scripts/model/current/ is stale — run scripts/model/extract_current.ts:\n     • " +
        problems.join("\n     • "),
    );
  }

  const collections = new Map<string, Map<string, FieldSpec>>();
  for (const [name, data] of schemas) {
    const fields = new Map<string, FieldSpec>();
    for (const fld of get_or(data, "fields", [])) {
      const target =
        get_or(fld, "type") === "relation"
          ? (id_to_name.get(get_or(fld, "collectionId")) ?? null)
          : null;
      fields.set(
        fld.name,
        new FieldSpec(fld.name, get_or(fld, "type", ""), truthy(get_or(fld, "required")), target),
      );
    }
    collections.set(name, fields);
  }

  // schema/<v>.view.json carries no field list, so columns come from the model tree, and
  // every one is treated as nullable: they are SELECT expressions over LEFT JOINs.
  for (const name of views.keys()) {
    const model = models.get(name);
    const columns = new Map<string, FieldSpec>();
    for (const rel of get_or(model, "relations") || []) {
      columns.set(
        rel.field,
        new FieldSpec(rel.field, "relation", false, get_or(rel, "target"), true),
      );
    }
    for (const fld of get_or(model, "fields") || []) {
      columns.set(fld.name, new FieldSpec(fld.name, get_or(fld, "type", ""), false, null, true));
    }
    collections.set(name, columns);
  }
  return new Graph(collections);
}

// --- anon-satisfiability lattice ----------------------------------------------------

/** One way an anon caller could satisfy a clause, plus its correlated-prefix witnesses. */
export class Model {
  constructor(
    public needs_empty: Set<string>,
    public needs_nonempty: Set<string>,
    public clause: string,
    public reason: string,
    public rank: number,
  ) {}
}

export class Verdict {
  constructor(
    public collection: string,
    public rule_name: string,
    public rule: string | null,
    public sat: boolean,
    public clause: string = "",
    public reason: string = "",
    public unparsed: string[] = [],
    public other_clauses: string[] = [],
  ) {}
}

function _conflicts(empties: Set<string>, nonempties: Set<string>): boolean {
  for (const p of empties) {
    for (const q of nonempties) if (q === p || q.startsWith(p + ".")) return true;
  }
  return false;
}

/** Python `max(xs, key=rank)`: the FIRST of the highest rank. */
function _best(models: Model[]): Model {
  return models.reduce((best, m) => (m.rank > best.rank ? m : best));
}

function _cap(models: Model[]): Model[] {
  if (models.length <= MODEL_CAP) return models;
  const best = _best(models);
  return [new Model(new Set(), new Set(), best.clause, best.reason, best.rank)];
}

function _merge(a: Model, b: Model): Model | null {
  const empties = new Set([...a.needs_empty, ...b.needs_empty]);
  const nonempties = new Set([...a.needs_nonempty, ...b.needs_nonempty]);
  if (_conflicts(empties, nonempties)) return null;
  const keep = b.rank > a.rank ? b : a;
  return new Model(empties, nonempties, keep.clause, keep.reason, keep.rank);
}

function _witness_text(witness: EmptyWitness): string {
  if (!witness.nonempty_prefixes.size) return witness.why;
  const hops = [...witness.nonempty_prefixes]
    .sort(by_code_point)
    .map((p) => `\`${p}\``)
    .join(", ");
  const verb = witness.nonempty_prefixes.size === 1 ? "is" : "are";
  return `${witness.why} — reachable on a record whose ${hops} ${verb} populated`;
}

/** -> [kind, value]; kind in auth_id/body/request/empty/literal/path/unknown. */
export function _classify_operand(text: string): [string, string] {
  text = py_strip(text);
  if (text === AUTH_ID) return ["auth_id", text];
  if (text.startsWith("@request.body")) return ["body", text];
  if (text.startsWith("@")) return ["request", text];
  if (text === '""' || text === "''") return ["empty", ""];
  if (
    text.length >= 2 &&
    text[0] === text[text.length - 1] &&
    (text[0] === '"' || text[0] === "'")
  ) {
    return ["literal", text.slice(1, -1)];
  }
  if (text === "true" || text === "false" || NUMBER_RE.test(text)) return ["literal", text];
  if (PATH_RE.test(text)) return ["path", text];
  return ["unknown", text];
}

function _atom_models(atom: string, collection: string, graph: Graph, unparsed: string[]): Model[] {
  const unrecognized = (): Model[] => {
    unparsed.push(atom);
    return [
      new Model(
        new Set(),
        new Set(),
        atom,
        "unrecognized atom — classified satisfiable so it cannot hide a hole",
        0,
      ),
    ];
  };

  const parts = split_comparison(atom);
  if (parts === null) return unrecognized();
  const [left, op, right] = parts;
  const [lkind, lval] = _classify_operand(left);
  const [rkind, rval] = _classify_operand(right);

  const kinds = new Set([lkind, rkind]);
  const only = (a: string, b: string): boolean =>
    kinds.size === (a === b ? 1 : 2) && kinds.has(a) && kinds.has(b);
  if (only("auth_id", "empty")) {
    if (NEQ_OPS.includes(op)) return [];
    if (EQ_OPS.includes(op)) {
      return [
        new Model(
          new Set(),
          new Set(),
          atom,
          'matches an anonymous caller literally: @request.auth.id is ""',
          2,
        ),
      ];
    }
    return unrecognized();
  }

  if (kinds.has("body")) {
    const body = lkind === "body" ? left : right;
    return [
      new Model(
        new Set(),
        new Set(),
        atom,
        `\`${body}\` is caller-controlled request-body input`,
        1,
      ),
    ];
  }

  if (kinds.has("auth_id") && kinds.has("path")) {
    const p = lkind === "path" ? lval : rval;
    const info = graph.resolve(collection, p);
    if (!info.resolved) return unrecognized();
    if (EQ_OPS.includes(op)) {
      return info.witnesses.map(
        (w) =>
          new Model(
            new Set([w.empty_prefix]),
            w.nonempty_prefixes,
            atom,
            `\`${p}\` reads as "" when ${_witness_text(w)}, and PocketBase ` +
              'compares that to an anonymous caller\'s empty id ("" = "")',
            2,
          ),
      );
    }
    if (NEQ_OPS.includes(op)) {
      return [
        new Model(
          new Set(),
          new Set(),
          atom,
          `an anonymous caller's id is "", which differs from any populated \`${p}\``,
          2,
        ),
      ];
    }
    return unrecognized();
  }

  if (kinds.has("path") && kinds.has("empty")) {
    const p = lkind === "path" ? lval : rval;
    const info = graph.resolve(collection, p);
    if (!info.resolved) return unrecognized();
    if (EQ_OPS.includes(op)) {
      return info.witnesses.map(
        (w) =>
          new Model(
            new Set([w.empty_prefix]),
            w.nonempty_prefixes,
            atom,
            `\`${p}\` reads as "" when ${_witness_text(w)}`,
            0,
          ),
      );
    }
    if (NEQ_OPS.includes(op)) {
      return [new Model(new Set(), new Set(), atom, `some record has a populated \`${p}\``, 0)];
    }
    return unrecognized();
  }

  if (kinds.has("path") && kinds.has("literal")) {
    const p = lkind === "path" ? lval : rval;
    const info = graph.resolve(collection, p);
    if (!info.resolved) return unrecognized();
    return [
      new Model(
        new Set(),
        new Set(info.proper_prefixes),
        atom,
        `some record can satisfy \`${atom}\``,
        0,
      ),
    ];
  }

  return unrecognized();
}

function _eval(expr: string, collection: string, graph: Graph, unparsed: string[]): Model[] {
  expr = strip_outer_parens(expr);
  const disjuncts = split_top_level(expr, "||");
  if (disjuncts.length > 1) {
    const models: Model[] = [];
    for (const part of disjuncts) models.push(..._eval(part, collection, graph, unparsed));
    return _cap(models);
  }
  const conjuncts = split_top_level(expr, "&&");
  if (conjuncts.length > 1) {
    let combined = [new Model(new Set(), new Set(), expr, "", -1)];
    // `dead` instead of an early return: an UNSAT conjunct must not hide its siblings'
    // unparsed atoms from the report.
    let dead = false;
    for (const part of conjuncts) {
      const child = _eval(part, collection, graph, unparsed);
      if (dead) continue;
      if (!child.length) {
        dead = true;
        continue;
      }
      const merged: Model[] = [];
      for (const a of combined) {
        for (const b of child) {
          const m = _merge(a, b);
          if (m !== null) merged.push(m);
        }
      }
      if (!merged.length) {
        dead = true;
        continue;
      }
      combined = _cap(merged);
    }
    return dead ? [] : combined;
  }
  return _atom_models(expr, collection, graph, unparsed);
}

/** Decide whether an anonymous caller can satisfy `rule` against some record. */
export function anon_satisfiable(
  collection: string,
  rule: string | null,
  graph: Graph,
  rule_name: string = "",
): Verdict {
  if (rule === null) {
    return new Verdict(collection, rule_name, rule, false, "", "null rule — superuser-only");
  }
  if (py_strip(rule) === "") {
    return new Verdict(
      collection,
      rule_name,
      rule,
      true,
      '""',
      "empty rule string is PUBLIC in PocketBase — anyone, signed in or not",
    );
  }
  const unparsed: string[] = [];
  const models = _eval(rule, collection, graph, unparsed);
  if (!models.length) {
    return new Verdict(
      collection,
      rule_name,
      rule,
      false,
      "",
      "no anonymous assignment satisfies it",
      unparsed,
    );
  }
  const best = _best(models);
  const others: string[] = [];
  for (const model of [...models].sort((a, b) => b.rank - a.rank)) {
    if (model.clause !== best.clause && !others.includes(model.clause)) others.push(model.clause);
  }
  return new Verdict(collection, rule_name, rule, true, best.clause, best.reason, unparsed, others);
}

// --- CLI ----------------------------------------------------------------------------

/** -> [collection -> rules, collection -> "base"|"view"]; views keep their 2-rule surface. */
function _load_rules(
  schema_dir: string,
  overrides: Map<string, string>,
): [Map<string, any>, Map<string, string>] {
  const rules = new Map<string, any>();
  const kinds = new Map<string, string>();
  const pick = (data: any): any =>
    Object.fromEntries(VIEW_RULES.map((rn) => [rn, get_or(data, rn)]));
  for (const file of glob_sorted(schema_dir, ".rules.json")) {
    const name = path.basename(file).slice(0, -".rules.json".length);
    rules.set(name, JSON.parse(read_text(file)));
    kinds.set(name, "base");
  }
  for (const file of glob_sorted(schema_dir, ".view.json")) {
    const data = JSON.parse(read_text(file));
    const name = get_or(data, "name", path.basename(file).slice(0, -".view.json".length));
    rules.set(name, pick(data));
    kinds.set(name, "view");
  }
  for (const [name, file] of overrides) {
    const data = JSON.parse(read_text(file));
    rules.set(name, kinds.get(name) === "view" ? pick(data) : data);
  }
  return [rules, kinds];
}

function _uncovered(schema_dir: string, rules: Map<string, any>): [string, string][] {
  const out: [string, string][] = [];
  for (const file of glob_sorted(schema_dir, ".json")) {
    const base = path.basename(file);
    if (base.endsWith(".rules.json")) continue;
    const is_view = base.endsWith(".view.json");
    const name = is_view ? base.slice(0, -".view.json".length) : base.slice(0, -".json".length);
    if (rules.has(name)) continue;
    out.push([name, `no rules found in schema/${base}`]);
  }
  return out;
}

export function main(): number {
  const prog = path.basename(process.argv[1] ?? "");
  const pad = " ".repeat(`usage: ${prog} `.length);
  const usage = `usage: ${prog} [-h] [--rules NAME=PATH]\n${pad}[--schema-dir SCHEMA_DIR] [--json]`;
  const args = parse_args(
    usage,
    `${usage}

Fail any collection rule an anonymous caller can satisfy (static, no server).

options:
  -h, --help            show this help message and exit
  --rules NAME=PATH     replace collection NAME's rules with the JSON at PATH
                        (repeatable)
  --schema-dir SCHEMA_DIR
                        default: repo schema/
  --json                machine-readable report

SCOPE BOUNDS: base collections are analyzed on their five CRUD rules; view
collections on the only two they have, listRule/viewRule (read from
schema/<name>.view.json, whose columns are all treated as nullable).
authRule/manageRule are auth-time / superuser surfaces, not anon-write
vectors, and are out of scope. A null rule is superuser-only and is never
flagged. Custom routes bypass collection rules entirely — hooks own that
surface.
`,
    [
      ["--rules", "append", "rules"],
      ["--schema-dir", "store", "schema_dir"],
      ["--json", "store_true", "json"],
    ],
    { rules: [], schema_dir: SCHEMA_DIR, json: false },
  );

  const overrides = new Map<string, string>();
  for (const item of args.rules as string[]) {
    if (!item.includes("=")) {
      print(`❌ check_rule_auth_guards: --rules expects NAME=PATH, got ${py_repr(item)}`);
      return 2;
    }
    const name = item.slice(0, item.indexOf("="));
    const file = item.slice(item.indexOf("=") + 1);
    if (!fs.existsSync(file)) {
      print(`❌ check_rule_auth_guards: --rules ${name}: ${file} not found`);
      return 2;
    }
    overrides.set(name, file);
  }

  let graph: Graph;
  let rules: Map<string, any>;
  let kinds: Map<string, string>;
  try {
    graph = load_graph(args.schema_dir, MODEL_DIR);
    [rules, kinds] = _load_rules(args.schema_dir, overrides);
  } catch (exc) {
    print(
      `❌ check_rule_auth_guards: ${exc instanceof SyntaxError || exc instanceof StaleModelError ? exc.message : os_error_text(exc)}`,
    );
    return 2;
  }

  const unknown = [...overrides.keys()].filter((n) => !graph.collections.has(n));
  if (unknown.length) {
    print(`❌ check_rule_auth_guards: --rules names unknown collection(s): ${unknown.join(", ")}`);
    return 2;
  }

  const findings: Verdict[] = [];
  const allowed: [string, string, string][] = [];
  const unparsed: [string, string][] = [];
  let analyzed = 0;
  let null_rules = 0;
  let view_analyzed = 0;
  const hit_allowlist = new Set<string>();

  for (const collection of [...rules.keys()].sort(by_code_point)) {
    if (!graph.collections.has(collection)) {
      print(
        `❌ check_rule_auth_guards: schema/${collection}.rules.json has no ` +
          `schema/${collection}.json to resolve fields against`,
      );
      return 2;
    }
    const is_view = kinds.get(collection) === "view";
    for (const rule_name of is_view ? VIEW_RULES : CRUD_RULES) {
      const rule = get_or(rules.get(collection), rule_name);
      if (rule === null) {
        null_rules += 1;
        continue;
      }
      analyzed += 1;
      view_analyzed += Number(is_view);
      const verdict = anon_satisfiable(collection, rule, graph, rule_name);
      for (const atom of verdict.unparsed) unparsed.push([`${collection}.${rule_name}`, atom]);
      if (!verdict.sat) continue;
      const key = JSON.stringify([collection, rule_name]);
      if (ALLOWLIST.has(key)) {
        hit_allowlist.add(key);
        allowed.push([collection, rule_name, ALLOWLIST.get(key)!]);
        continue;
      }
      findings.push(verdict);
    }
  }

  const stale_allowlist: [string, string, string][] = [...ALLOWLIST]
    .filter(([k]) => !hit_allowlist.has(k))
    .map(([k, reason]) => [...(JSON.parse(k) as [string, string]), reason]);
  const not_analyzed = _uncovered(args.schema_dir, rules);

  if (args.json) {
    print(
      json_dumps(
        {
          ok: !findings.length && !stale_allowlist.length,
          analyzed_rules: analyzed,
          analyzed_view_rules: view_analyzed,
          null_rules: null_rules,
          findings: findings.map((v) => ({
            collection: v.collection,
            kind: kinds.get(v.collection) ?? "base",
            rule: v.rule_name,
            clause: v.clause,
            why: v.reason,
            also: v.other_clauses,
            verbatim: v.rule,
          })),
          allowlisted: allowed.map(([c, r, reason]) => ({ collection: c, rule: r, reason })),
          stale_allowlist: stale_allowlist.map(([c, r, reason]) => ({
            collection: c,
            rule: r,
            reason,
          })),
          unparsed: unparsed.map(([where, atom]) => ({ rule: where, atom })),
          not_analyzed: not_analyzed.map(([n, why]) => ({ name: n, why })),
        },
        { indent: 2 },
      ),
    );
    return findings.length || stale_allowlist.length ? 1 : 0;
  }

  for (const verdict of findings) {
    print(`❌ ${verdict.collection}.${verdict.rule_name} is satisfiable by an ANONYMOUS caller`);
    print(`     clause: ${verdict.clause}`);
    print(`     why:    ${verdict.reason}`);
    if (verdict.other_clauses.length) {
      const shown = verdict.other_clauses.slice(0, 3).join(", ");
      const extra = verdict.other_clauses.length - 3;
      print(`     also:   ${shown}${extra > 0 ? ` (+${extra} more)` : ""}`);
    }
    print(`     rule:   ${verdict.rule}`);
  }

  for (const [collection, rule_name, reason] of stale_allowlist) {
    print(`❌ stale allowlist entry ${collection}.${rule_name}: ${reason}`);
    print("     that rule is no longer anon-satisfiable (or no longer exists) — drop the entry");
  }

  print(`allowlisted exceptions (${allowed.length}):`);
  for (const [collection, rule_name, reason] of allowed) {
    print(`  • ${collection}.${rule_name} — ${reason}`);
  }

  if (unparsed.length) {
    print(`unparsed atoms (${unparsed.length}) — counted as SATISFIABLE, so none can hide a hole:`);
    for (const [where, atom] of unparsed) print(`  • ${where}: ${atom}`);
  }

  const view_names = [...rules.keys()].filter((c) => kinds.get(c) === "view").sort(by_code_point);
  const base_count = rules.size - view_names.length;
  print("coverage:");
  print(
    `  • analyzed: ${analyzed - view_analyzed} CRUD rules across ${base_count} base ` +
      `collections + ${view_analyzed} list/view rules across ${view_names.length} view ` +
      `collection${view_names.length === 1 ? "" : "s"} ` +
      `(${null_rules} null = superuser-only, never flagged)`,
  );
  if (view_names.length) {
    print(
      `  • views (${view_names.join(", ")}) expose listRule/viewRule only — no ` +
        "create/update/delete surface exists to analyze; every view column is treated " +
        "as nullable, since they are computed by the view query",
    );
  }
  for (const [name, why] of not_analyzed) print(`  • NOT analyzed: ${name} — ${why}`);
  print(
    "  • NOT analyzed: users.authRule / users.manageRule — auth-time and superuser " +
      "surfaces, not anon-write vectors",
  );
  print("  • out of scope: custom routes bypass collection rules entirely (hooks own that)");

  if (findings.length || stale_allowlist.length) {
    print(
      `❌ check_rule_auth_guards: ${findings.length} anon-satisfiable rule(s), ` +
        `${stale_allowlist.length} stale allowlist entr(ies).`,
    );
    return 1;
  }
  print(
    `✅ check_rule_auth_guards: ${analyzed} rules checked, none reachable by an ` +
      `anonymous caller (${allowed.length} allowlisted).`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

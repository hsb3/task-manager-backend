#!/usr/bin/env bun
/**
 * Extract the CURRENT entity metadata model from pb_migrations/ — generated, never hand-edited.
 *
 * Mechanic (same as scripts/check_app_docs.ts / gen_decisions.ts): replay the real
 * migrations into a throwaway dir with `pocketbase migrate up`, then read the
 * `_collections` table. Output: one YAML file per app collection under
 * scripts/model/current/, in the facet schema defined by scripts/model/SCHEMA.md.
 *
 * The point (owner directive 2026-07-26): current state is EXTRACTED so the
 * gap analysis diffs generated truth against the hand-authored target model —
 * no transcription errors, re-runnable after every migration.
 *
 * Usage:
 *   bun scripts/model/extract_current.ts          # writes current/<entity>.yml
 *   bun scripts/model/extract_current.ts --stdout # print combined YAML, write nothing
 *   bun scripts/model/extract_current.ts --check  # drift gate: write nothing, exit 1 on drift
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  py_strip,
  read_text,
  SystemExit,
  truthy,
  sqlite_connect,
  py_get,
} from "../_py.ts";
// One definition of "guarded" repo-wide.
import { has_leading_auth_guard } from "../check_rule_auth_guards.ts";
import { migrate_up, pb_bin_path } from "../pb_migrate.ts";

export const HERE = import.meta.dir;
export const REPO = path.resolve(HERE, "..", "..");

export const PB = pb_bin_path(REPO);
export const MIGRATIONS = path.join(REPO, "pb_migrations");
export const OUT_DIR = path.join(HERE, "current");

export const CRUD = ["list", "view", "create", "update", "delete"];

// Python's Unicode-aware \w.
const W = String.raw`[\p{L}\p{N}_]`;
const re = (source: string): RegExp => new RegExp(source, "u");

// Predicate -> actor tag table. Best-effort derivation; the verbatim rule is
// always preserved and is the truth. `custom` marks anything unrecognized.
export const ACTOR_PATTERNS: [RegExp, string][] = [
  [re(String.raw`^(?:${W}+\.)*workspace\.owner = @request\.auth\.id$`), "workspace-owner"],
  [re(String.raw`^owner = @request\.auth\.id$`), "record-owner"],
  // Longest run first: each of these is the next one plus a role conjunct, and the
  // \1 backreference refuses a divergent field-path prefix (that stays custom).
  [
    re(
      String.raw`^((?:${W}+\.)*)workspace_members_via_workspace\.user \?= @request\.auth\.id` +
        String.raw` && \1workspace_members_via_workspace\.role \?= "admin"` +
        String.raw` && \1workspace_members_via_workspace\.status \?= "active"$`,
    ),
    "active-workspace-admin",
  ],
  [
    re(
      String.raw`^((?:${W}+\.)*)workspace_members_via_workspace\.user \?= @request\.auth\.id` +
        String.raw` && \1workspace_members_via_workspace\.role \?!= "viewer"` +
        String.raw` && \1workspace_members_via_workspace\.status \?= "active"$`,
    ),
    "active-workspace-writer",
  ],
  [
    re(
      String.raw`^((?:${W}+\.)*)workspace_members_via_workspace\.user \?= @request\.auth\.id` +
        String.raw` && \1workspace_members_via_workspace\.status \?= "active"$`,
    ),
    "active-workspace-member",
  ],
  [
    re(String.raw`^(?:${W}+\.)*workspace_members_via_workspace\.user \?= @request\.auth\.id$`),
    "workspace-member",
  ],
  [re(String.raw`^(?:${W}+\.)*assignee = @request\.auth\.id$`), "assignee"],
  [re(String.raw`^author = @request\.auth\.id$`), "author"],
  [re(String.raw`^id = @request\.auth\.id$`), "self"],
  [re(String.raw`^project\.owner = @request\.auth\.id$`), "project-owner"],
];
// Only ever full-matched, so anchored here.
export const AUTH_GATE = /^@request\.auth\.id != ""$/;
export const ACTOR_TAGS = new Set([...ACTOR_PATTERNS.map(([, tag]) => tag), "any-authenticated"]);
export const BODY_GUARD = re(String.raw`@request\.body\.[\p{L}\p{N}_:]+`);
// the patterns spanning several && conjuncts, so a conjunct RUN inside a compound
// can be matched without the neighbouring conjuncts breaking the fullmatch
export const MULTI_CONJUNCT_PATTERNS = ACTOR_PATTERNS.filter(([p]) => p.source.includes(" && "));

export type Sink = { actors: string[]; pins: string[]; state: string[]; authed: boolean };
export type Derived = { actors: string[]; guards: string[]; pins: string[]; state: string[] };

/** Split on `sep` (`&&` or `||`) at paren depth 0. */
export function split_top_level(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    if (depth === 0 && expr.slice(i, i + sep.length) === sep) {
      parts.push(buf);
      buf = "";
      i += sep.length;
      continue;
    }
    buf += ch;
    i += 1;
  }
  parts.push(buf);
  return parts.filter((p) => py_strip(p)).map((p) => py_strip(p));
}

export function strip_outer_parens(s: string): string {
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0 && i < s.length - 1) {
          return s; // outer parens don't wrap the whole expr
        }
      }
    }
    s = py_strip(s.slice(1, -1));
  }
  return s;
}

/** A leaf renders as its actor tag when one names it, else verbatim. */
export function render_leaf(atom: string): string {
  if (AUTH_GATE.test(atom)) {
    return "any-authenticated";
  }
  for (const [pat, tag] of ACTOR_PATTERNS) {
    if (pat.test(atom)) {
      return tag;
    }
  }
  return atom;
}

export function _wrap(text: string, kind: string, other: string): string {
  return kind === other ? `(${text})` : text;
}

/** [rendered text, kind in or|and|leaf] — a node left with one child collapses to it. */
export function reduce_expr(expr: string): [string, string] {
  expr = strip_outer_parens(expr);
  const disjs = split_top_level(expr, "||");
  if (disjs.length > 1) {
    const children = disjs.map((d) => reduce_expr(d));
    return [children.map(([t, k]) => _wrap(t, k, "and")).join(" || "), "or"];
  }
  const conjs = split_top_level(expr, "&&").map((c) => strip_outer_parens(c));
  if (conjs.length > 1) {
    return reduce_and(conjs);
  }
  return [render_leaf(expr), "leaf"];
}

function multi_conjunct_tag(run: string): string | null {
  return MULTI_CONJUNCT_PATTERNS.find(([pat]) => pat.test(run))?.[1] ?? null;
}

/** Reduce an AND node, matching the longest conjunct RUN an actor pattern names. */
export function reduce_and(conjs: string[]): [string, string] {
  const children: [string, string][] = [];
  let i = 0;
  while (i < conjs.length) {
    let matched = false;
    for (let j = conjs.length; j > i; j--) {
      const tag = multi_conjunct_tag(conjs.slice(i, j).join(" && "));
      if (tag) {
        children.push([tag, "leaf"]);
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      children.push(reduce_expr(conjs[i]!));
      i += 1;
    }
  }
  if (children.length === 1) {
    return children[0]!;
  }
  return [children.map(([t, k]) => _wrap(t, k, "or")).join(" && "), "and"];
}

export function is_compound(expr: string): boolean {
  return split_top_level(expr, "||").length > 1 || split_top_level(expr, "&&").length > 1;
}

/**
 * A raw membership back-relation left in a reduction is a grant the vocabulary failed
 * to name, exactly like a surviving @request.auth — so both mark a modelling gap.
 */
export function unnamed_grant_survives(reduced: string): boolean {
  return reduced.includes("@request.auth") || reduced.includes("workspace_members_via_workspace");
}

/**
 * An expression that never names the caller grants nobody anything: it pins the
 * submitted payload, or it constrains the record's own state.
 */
export function _file_constraint(expr: string, sink: Sink): void {
  const disjs = split_top_level(expr, "||").map((d) => strip_outer_parens(d));
  if (disjs.every((d) => BODY_GUARD.test(d))) {
    sink.pins.push(...disjs);
  } else {
    sink.state.push(expr);
  }
}

/** An OR node in grant position: each branch is one actor atom. */
export function _file_grants(expr: string, sink: Sink): void {
  for (const disj of split_top_level(expr, "||").map((d) => strip_outer_parens(d))) {
    if (AUTH_GATE.test(disj)) {
      // in OR position the gate is not a gate: it admits every authenticated caller
      sink.actors.push("any-authenticated");
      continue;
    }
    const tag = ACTOR_PATTERNS.find(([pat]) => pat.test(disj))?.[1] ?? null;
    if (tag) {
      sink.actors.push(tag);
    } else if (is_compound(disj)) {
      // one compound disjunct is one atom: flattening a nested OR would collapse
      // sibling branches into indistinguishable duplicates
      const [reduced] = reduce_expr(disj);
      // cosmetic parens must not change the atom: a reduction that is exactly one
      // tag is that actor, not a compound wrapping it
      if (ACTOR_TAGS.has(reduced)) {
        sink.actors.push(reduced);
      } else if (unnamed_grant_survives(reduced)) {
        sink.actors.push(`custom(${disj})`);
      } else {
        sink.actors.push(`custom-compound(${reduced})`);
      }
    } else {
      // Unrecognized grants (incl. body-dependent ones like
      // "assignee of @request.body.parent") stay VISIBLE.
      sink.actors.push(`custom(${disj})`);
    }
  }
}

/**
 * Walk an expression in AND position, filing each conjunct as gate, constraint or grant.
 *
 * PB binds `&&` tighter than `||`, so a surviving top-level `||` is the OUTER node —
 * the same traversal order reduce_expr and scripts/check_rule_auth_guards.ts use.
 */
export function _walk(expr: string, sink: Sink): void {
  expr = strip_outer_parens(expr);
  if (AUTH_GATE.test(expr)) {
    sink.authed = true;
    return;
  }
  if (!expr.includes("@request.auth") && !expr.includes("workspace_members_via_workspace")) {
    _file_constraint(expr, sink);
    return;
  }
  if (split_top_level(expr, "||").length > 1) {
    _file_grants(expr, sink);
    return;
  }
  const conjs = split_top_level(expr, "&&").map((c) => strip_outer_parens(c));
  if (conjs.length === 1) {
    _file_grants(expr, sink);
    return;
  }
  let i = 0;
  while (i < conjs.length) {
    let matched = false;
    for (let j = conjs.length; j > i; j--) {
      const tag = multi_conjunct_tag(conjs.slice(i, j).join(" && "));
      if (tag) {
        sink.actors.push(tag);
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      _walk(conjs[i]!, sink);
      i += 1;
    }
  }
}

/** Turn a PB rule string into {actors, guards, pins, state} best-effort tags. */
export function derive_actors(rule: string | null): Derived {
  if (rule === null) {
    return { actors: ["superuser-only"], guards: [], pins: [], state: [] };
  }
  if (rule === "") {
    return { actors: ["public"], guards: [], pins: [], state: [] };
  }

  const sink: Sink = { actors: [], pins: [], state: [], authed: false };
  _walk(py_strip(rule), sink);
  let actors = sink.actors;
  if (!actors.length) {
    // No actor grant left: either an auth gate alone, or constraint-only
    // (e.g. open signup with a field-injection guard) which is public.
    actors = sink.authed ? ["any-authenticated"] : ["public"];
  }
  return {
    actors,
    guards: [...new Set(rule.match(new RegExp(BODY_GUARD, "gu")) ?? [])].sort(by_code_point),
    pins: sink.pins,
    state: sink.state,
  };
}

export function fetch_collections(): Record<string, any>[] {
  if (!fs.existsSync(PB)) {
    throw new SystemExit(`no pocketbase binary at ${PB} — set PB_BIN or run \`make pocketbase\``);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbmodel_"));
  let rows: unknown[][];
  try {
    const [ok, out] = migrate_up(PB, tmp, MIGRATIONS);
    if (!ok) {
      throw new SystemExit("migrate up failed:\n" + out);
    }
    const con = sqlite_connect(path.join(tmp, "data.db"));
    try {
      rows = con
        .query(
          "SELECT id, name, type, system, fields, indexes, options, " +
            "listRule, viewRule, createRule, updateRule, deleteRule " +
            "FROM _collections ORDER BY name",
        )
        .values();
    } finally {
      con.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const keys = [
    "id",
    "name",
    "type",
    "system",
    "fields",
    "indexes",
    "options",
    "listRule",
    "viewRule",
    "createRule",
    "updateRule",
    "deleteRule",
  ];
  return rows.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i]])));
}

export function cardinality(f: any): string {
  return (f.maxSelect || 1) > 1 ? "many" : "one";
}

export function build_entity(col: any, id_to_name: Map<string, string>): Record<string, any> {
  const fields: any[] = JSON.parse(col.fields);
  const indexes: string[] = JSON.parse(col.indexes || "[]");

  const relations: any[] = [];
  const field_rows: any[] = [];
  const field_policies: string[] = [];
  for (const f of fields) {
    if (
      f.system &&
      ["id", "email", "emailVisibility", "verified", "password", "tokenKey"].includes(f.name)
    ) {
      if (f.name === "email") {
        field_policies.push("email hidden unless emailVisibility=true (auth-collection built-in)");
      }
      continue;
    }
    if (f.type === "relation") {
      relations.push({
        field: f.name,
        target: id_to_name.get(f.collectionId) ?? f.collectionId,
        cardinality: cardinality(f),
        required: truthy(f.required),
        on_target_delete: f.cascadeDelete ? "cascade" : "clear",
      });
    } else if (f.type === "autodate") {
      continue;
    } else {
      const row: Record<string, any> = {
        name: f.name,
        type: f.type,
        required: truthy(f.required),
      };
      if (f.type === "select") {
        // the closed vocabulary a target file's `values:` is diffed against
        row.values = [...(f.values || [])];
      }
      if (f.type === "file") {
        row.protected = truthy(f.protected);
        row.max_files = py_get(f, "maxSelect", 1);
        if (f.protected) {
          field_policies.push(`${f.name}: protected file field (short-lived token required)`);
        }
      }
      if (f.hidden) {
        row.hidden = true;
        field_policies.push(`${f.name}: hidden field`);
      }
      field_rows.push(row);
    }
  }

  const caps: Record<string, any> = {};
  for (const op of CRUD) {
    const rule: string | null = col[`${op}Rule`];
    const d = derive_actors(rule);
    const auth_required =
      rule === null ? "superuser" : has_leading_auth_guard(rule) ? "guard" : "absent";
    caps[op] = { verbatim: rule, actors: d.actors, authRequired: auth_required };
    if (d.guards.length) {
      caps[op].body_guards = d.guards;
    }
    if (d.pins.length) {
      caps[op].body_pins = d.pins;
    }
    if (d.state.length) {
      caps[op].record_state = d.state;
    }
  }

  const uniques = indexes.filter((ix) => ix.toUpperCase().includes("UNIQUE"));
  const entity: Record<string, any> = {
    entity: col.name,
    kind: col.type,
    capabilities: caps,
    relations,
    fields: field_rows,
    field_policies,
    unique_indexes: uniques,
    other_indexes: indexes.filter((ix) => !uniques.includes(ix)),
  };
  if (col.type === "view") {
    const opts = JSON.parse(col.options || "{}");
    entity.view_query = py_get(opts, "viewQuery", "");
  }
  if (col.type === "auth") {
    const opts = JSON.parse(col.options || "{}");
    entity.auth_rule = opts.authRule ?? null;
  }
  return entity;
}

// PyYAML's safe_dump (YAML 1.1, allow_unicode off, indent 2) for the str/int/bool/None/list/dict
// trees build_entity makes; the committed current/ files are its byte-identity proof.

// PyYAML's implicit resolvers: a str matching one is quoted so it reads back as a str.
const Y11_RESOLVERS: [string, RegExp][] = [
  [
    "yYnNtTfFoO",
    /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  ],
  [
    "-+0123456789.",
    /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  ],
  [
    "-+0123456789",
    /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  ],
  ["<", /^(?:<<)$/],
  ["~nN", /^(?:~|null|Null|NULL|)$/],
  [
    "0123456789",
    /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  ],
  ["=", /^(?:=)$/],
  ["!&*", /^(?:!|&|\*)$/],
];

function resolves_to_str(value: string): boolean {
  if (value === "") return false; // the null resolver owns the empty scalar
  const first = String.fromCodePoint(value.codePointAt(0)!);
  return !Y11_RESOLVERS.some(([chars, rx]) => chars.includes(first) && rx.test(value));
}

const BREAKS = "\n\x85  ";
const SPACE_OR_BREAK = "\0 \t\r\n\x85  ";
const ESCAPE_REPLACEMENTS: Record<string, string> = {
  "\0": "0",
  "\x07": "a",
  "\x08": "b",
  "\x09": "t",
  "\x0A": "n",
  "\x0B": "v",
  "\x0C": "f",
  "\x0D": "r",
  "\x1B": "e",
  '"': '"',
  "\\": "\\",
  "\x85": "N",
  "\xA0": "_",
  " ": "L",
  " ": "P",
};

type Analysis = {
  empty: boolean;
  multiline: boolean;
  allow_flow_plain: boolean;
  allow_block_plain: boolean;
  allow_single_quoted: boolean;
};

function analyze_scalar(t: string[]): Analysis {
  if (!t.length) {
    return {
      empty: true,
      multiline: false,
      allow_flow_plain: false,
      allow_block_plain: true,
      allow_single_quoted: true,
    };
  }
  let block_indicators = false;
  let flow_indicators = false;
  let line_breaks = false;
  let special_characters = false;
  let leading_space = false;
  let leading_break = false;
  let trailing_space = false;
  let trailing_break = false;
  let break_space = false;
  let space_break = false;
  const s = t.join("");
  if (s.startsWith("---") || s.startsWith("...")) {
    block_indicators = true;
    flow_indicators = true;
  }
  let preceded_by_whitespace = true;
  let followed_by_whitespace = t.length === 1 || SPACE_OR_BREAK.includes(t[1]!);
  let previous_space = false;
  let previous_break = false;
  let index = 0;
  while (index < t.length) {
    const ch = t[index]!;
    if (index === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) {
        flow_indicators = true;
        block_indicators = true;
      }
      if ("?:".includes(ch)) {
        flow_indicators = true;
        if (followed_by_whitespace) block_indicators = true;
      }
      if (ch === "-" && followed_by_whitespace) {
        flow_indicators = true;
        block_indicators = true;
      }
    } else {
      if (",?[]{}".includes(ch)) flow_indicators = true;
      if (ch === ":") {
        flow_indicators = true;
        if (followed_by_whitespace) block_indicators = true;
      }
      if (ch === "#" && preceded_by_whitespace) {
        flow_indicators = true;
        block_indicators = true;
      }
    }
    if (BREAKS.includes(ch)) line_breaks = true;
    const c = ch.codePointAt(0)!;
    // allow_unicode is off, so every non-ASCII character is special
    if (!(ch === "\n" || (c >= 0x20 && c <= 0x7e))) special_characters = true;
    if (ch === " ") {
      if (index === 0) leading_space = true;
      if (index === t.length - 1) trailing_space = true;
      if (previous_break) break_space = true;
      previous_space = true;
      previous_break = false;
    } else if (BREAKS.includes(ch)) {
      if (index === 0) leading_break = true;
      if (index === t.length - 1) trailing_break = true;
      if (previous_space) space_break = true;
      previous_space = false;
      previous_break = true;
    } else {
      previous_space = false;
      previous_break = false;
    }
    index += 1;
    preceded_by_whitespace = SPACE_OR_BREAK.includes(ch);
    followed_by_whitespace = index + 1 >= t.length || SPACE_OR_BREAK.includes(t[index + 1]!);
  }
  let allow_flow_plain = true;
  let allow_block_plain = true;
  let allow_single_quoted = true;
  if (leading_space || leading_break || trailing_space || trailing_break) {
    allow_flow_plain = allow_block_plain = false;
  }
  if (break_space) allow_flow_plain = allow_block_plain = allow_single_quoted = false;
  if (space_break || special_characters) {
    allow_flow_plain = allow_block_plain = allow_single_quoted = false;
  }
  if (line_breaks) allow_flow_plain = allow_block_plain = false;
  if (flow_indicators) allow_flow_plain = false;
  if (block_indicators) allow_block_plain = false;
  return {
    empty: false,
    multiline: line_breaks,
    allow_flow_plain,
    allow_block_plain,
    allow_single_quoted,
  };
}

class Emitter {
  out = "";
  column = 0;
  whitespace = true;
  indention = true;
  open_ended = false;
  indent: number | null = null;
  indents: (number | null)[] = [];
  flow_level = 0;
  root_context = false;
  mapping_context = false;
  simple_key_context = false;

  constructor(readonly best_width: number) {}

  document(data: unknown, first: boolean): void {
    if (!first) {
      this.write_indent();
      this.write_indicator("---", true);
    }
    this.node(data, true, false, false);
    this.write_indent();
  }

  increase_indent(flow: boolean, indentless = false): void {
    this.indents.push(this.indent);
    if (this.indent === null) {
      this.indent = flow ? 2 : 0;
    } else if (!indentless) {
      this.indent += 2;
    }
  }

  node(data: unknown, root: boolean, mapping: boolean, simple_key: boolean): void {
    this.root_context = root;
    this.mapping_context = mapping;
    this.simple_key_context = simple_key;
    if (Array.isArray(data)) {
      if (this.flow_level || !data.length) {
        // shortcut: only the empty flow collection is emitted; a non-empty one needs flow items
        this.write_indicator("[", true, true);
        this.write_indicator("]", false);
        return;
      }
      this.increase_indent(false, this.mapping_context && !this.indention);
      for (const item of data) {
        this.write_indent();
        this.write_indicator("-", true, false, true);
        this.node(item, false, false, false);
      }
      this.indent = this.indents.pop()!;
    } else if (data !== null && typeof data === "object") {
      const entries = Object.entries(data);
      if (this.flow_level || !entries.length) {
        this.write_indicator("{", true, true);
        this.write_indicator("}", false);
        return;
      }
      this.increase_indent(false);
      for (const [key, value] of entries) {
        this.write_indent();
        const t = [...key];
        const a = analyze_scalar(t);
        // shortcut: keys are build_entity's fixed names; a complex `?` key is never needed
        if (t.length >= 128 || a.empty || a.multiline) throw new Error(`not a simple key: ${key}`);
        this.node(key, false, true, true);
        this.write_indicator(":", false);
        this.node(value, false, true, false);
      }
      this.indent = this.indents.pop()!;
    } else {
      this.increase_indent(true);
      this.scalar(data);
      this.indent = this.indents.pop()!;
    }
  }

  scalar(data: unknown): void {
    // shortcut: numbers are build_entity's ints (maxSelect); a float would need Python's repr
    const [value, implicit] =
      typeof data === "string"
        ? [data, resolves_to_str(data)]
        : [data === null ? "null" : String(data), true];
    const t = [...value];
    const a = analyze_scalar(t);
    const split = !this.simple_key_context;
    if (
      implicit &&
      !(this.simple_key_context && (a.empty || a.multiline)) &&
      ((this.flow_level && a.allow_flow_plain) || (!this.flow_level && a.allow_block_plain))
    ) {
      this.write_plain(t, split);
    } else if (a.allow_single_quoted && !(this.simple_key_context && a.multiline)) {
      this.write_single_quoted(t, split);
    } else {
      this.write_double_quoted(t, split);
    }
  }

  write(data: string, width: number): void {
    this.column += width;
    this.out += data;
  }

  write_indicator(
    indicator: string,
    need_whitespace: boolean,
    whitespace = false,
    indention = false,
  ) {
    const data = this.whitespace || !need_whitespace ? indicator : " " + indicator;
    this.whitespace = whitespace;
    this.indention = this.indention && indention;
    this.open_ended = false;
    this.write(data, data.length);
  }

  write_indent(): void {
    const indent = this.indent ?? 0;
    if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) {
      this.write_line_break();
    }
    if (this.column < indent) {
      this.whitespace = true;
      this.write(" ".repeat(indent - this.column), indent - this.column);
    }
  }

  write_line_break(data = "\n"): void {
    this.whitespace = true;
    this.indention = true;
    this.column = 0;
    this.out += data;
  }

  write_breaks(t: string[], start: number, end: number): void {
    if (t[start] === "\n") this.write_line_break();
    for (const br of t.slice(start, end)) {
      this.write_line_break(br);
    }
    this.write_indent();
  }

  write_single_quoted(t: string[], split: boolean): void {
    this.write_indicator("'", true);
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= t.length) {
      const ch = end < t.length ? t[end]! : null;
      if (spaces) {
        if (ch === null || ch !== " ") {
          if (
            start + 1 === end &&
            this.column > this.best_width &&
            split &&
            start !== 0 &&
            end !== t.length
          ) {
            this.write_indent();
          } else {
            this.write(t.slice(start, end).join(""), end - start);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          this.write_breaks(t, start, end);
          start = end;
        }
      } else if (ch === null || (" " + BREAKS).includes(ch) || ch === "'") {
        if (start < end) {
          this.write(t.slice(start, end).join(""), end - start);
          start = end;
        }
      }
      if (ch === "'") {
        this.write("''", 2);
        start = end + 1;
      }
      if (ch !== null) {
        spaces = ch === " ";
        breaks = BREAKS.includes(ch);
      }
      end += 1;
    }
    this.write_indicator("'", false);
  }

  write_double_quoted(t: string[], split: boolean): void {
    this.write_indicator('"', true);
    let start = 0;
    let end = 0;
    while (end <= t.length) {
      const ch = end < t.length ? t[end]! : null;
      const c = ch === null ? 0 : ch.codePointAt(0)!;
      if (ch === null || '"\\\x85  ﻿'.includes(ch) || !(c >= 0x20 && c <= 0x7e)) {
        if (start < end) {
          this.write(t.slice(start, end).join(""), end - start);
          start = end;
        }
        if (ch !== null) {
          const hex = c.toString(16).toUpperCase();
          const data =
            ch in ESCAPE_REPLACEMENTS
              ? "\\" + ESCAPE_REPLACEMENTS[ch]
              : c <= 0xff
                ? "\\x" + hex.padStart(2, "0")
                : c <= 0xffff
                  ? "\\u" + hex.padStart(4, "0")
                  : "\\U" + hex.padStart(8, "0");
          this.write(data, data.length);
          start = end + 1;
        }
      }
      if (
        end > 0 &&
        end < t.length - 1 &&
        (ch === " " || start >= end) &&
        this.column + (end - start) > this.best_width &&
        split
      ) {
        const seg = t.slice(start, end);
        if (start < end) start = end;
        this.write(seg.join("") + "\\", seg.length + 1);
        this.write_indent();
        this.whitespace = false;
        this.indention = false;
        if (t[start] === " ") this.write("\\", 1);
      }
      end += 1;
    }
    this.write_indicator('"', false);
  }

  write_plain(t: string[], split: boolean): void {
    if (this.root_context) this.open_ended = true;
    if (!t.length) return;
    if (!this.whitespace) this.write(" ", 1);
    this.whitespace = false;
    this.indention = false;
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= t.length) {
      const ch = end < t.length ? t[end]! : null;
      if (spaces) {
        if (ch !== " ") {
          if (start + 1 === end && this.column > this.best_width && split) {
            this.write_indent();
            this.whitespace = false;
            this.indention = false;
          } else {
            this.write(t.slice(start, end).join(""), end - start);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          this.write_breaks(t, start, end);
          this.whitespace = false;
          this.indention = false;
          start = end;
        }
      } else if (ch === null || (" " + BREAKS).includes(ch)) {
        this.write(t.slice(start, end).join(""), end - start);
        start = end;
      }
      if (ch !== null) {
        spaces = ch === " ";
        breaks = BREAKS.includes(ch);
      }
      end += 1;
    }
  }
}

function safe_dump_all(docs: unknown[], width = 80): string {
  const e = new Emitter(width);
  docs.forEach((d, i) => e.document(d, i === 0));
  if (e.open_ended) {
    e.write_indicator("...", true);
    e.write_indent();
  }
  return e.out;
}

export const BANNER =
  "# GENERATED by extract_current.ts from pb_migrations/ replay — DO NOT EDIT.\n" +
  "# Regenerate after any migration change. Verbatim rules are truth; actor\n" +
  "# tags are best-effort derivation (see SCHEMA.md).\n";

export function _on_disk(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(OUT_DIR) || !fs.statSync(OUT_DIR).isDirectory()) {
    return out;
  }
  for (const fn of fs.readdirSync(OUT_DIR).sort(by_code_point)) {
    if (fn.endsWith(".yml")) {
      out.set(fn, read_text(path.join(OUT_DIR, fn)));
    }
  }
  return out;
}

export function _check(files: Map<string, string>): number {
  const disk = _on_disk();
  const missing = [...files.keys()].filter((fn) => !disk.has(fn)).sort(by_code_point);
  const stray = [...disk.keys()].filter((fn) => !files.has(fn)).sort(by_code_point);
  const changed = [...files.keys()]
    .filter((fn) => disk.has(fn) && files.get(fn) !== disk.get(fn))
    .sort(by_code_point);

  if (!(missing.length || stray.length || changed.length)) {
    console.log(
      `✅ extract_current --check: model/current/ is up to date (${files.size} entities).`,
    );
    return 0;
  }

  for (const fn of missing) {
    console.log(`❌ extract_current --check: scripts/model/current/${fn} is missing.`);
  }
  for (const fn of stray) {
    console.log(`❌ extract_current --check: scripts/model/current/${fn} matches no collection.`);
  }
  for (const fn of changed) {
    console.log(
      `❌ extract_current --check: scripts/model/current/${fn} ` +
        "is out of date with the pb_migrations schema.",
    );
  }
  console.log("   Run `bun scripts/model/extract_current.ts` to regenerate.");
  return 1;
}

export function main(): number {
  const argv = process.argv.slice(1);
  const cols = fetch_collections();
  const id_to_name = new Map<string, string>(cols.map((c) => [c.id, c.name]));
  const app_cols = cols.filter((c) => !c.name.startsWith("_") && !c.system);

  const entities = app_cols.map((c) => build_entity(c, id_to_name));

  if (argv.includes("--stdout")) {
    console.log(BANNER + safe_dump_all(entities));
    return 0;
  }

  const files = new Map<string, string>(
    entities.map((e) => [`${e.entity}.yml`, BANNER + safe_dump_all([e], 100)]),
  );
  if (argv.includes("--check")) {
    return _check(files);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [fn, content] of files) {
    fs.writeFileSync(path.join(OUT_DIR, fn), content);
  }
  console.log(`wrote ${files.size} entities to ${path.relative(REPO, OUT_DIR)}/`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

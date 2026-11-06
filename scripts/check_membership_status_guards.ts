#!/usr/bin/env bun
/**
 * CI / pre-commit check: fail any permission branch granting through `workspace_members`
 * without pinning `status` to "active" in that same branch.
 *
 * A suspended membership must confer nothing (PBTT-431, decision:active-membership-grants-access); since decision:invitation-keyed-by-email a
 * membership row is only ever active or suspended. Derived, never a hand-copied site list: collection rules come from the
 * generated `schema/`; hooks contribute both their `workspace_members` filter strings and the
 * `FROM|JOIN workspace_members` predicates they build by concatenation; a view collection
 * contributes the membership subselects its `viewQuery` denormalises onto the row, which is
 * where decision:project-items-membership-denormalised moved the pin. Static — no server, no DB. Public API (tests import it):
 * branches, scan_rules, scan_hooks, flatten_strings, sql_window, sql_sites, view_columns,
 * view_member_columns, column_grant, ALLOWLIST_RULES, ALLOWLIST_HOOKS.
 */

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
  PY_WS_RE,
  read_text,
  truthy,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import {
  EQ_OPS,
  get_or,
  scan_step,
  split_comparison,
  split_top_level,
  strip_outer_parens,
} from "./check_rule_auth_guards.ts";

export const REPO = repo_root(import.meta.path);
export const SCHEMA_DIR = path.join(REPO, "schema");
export const HOOKS_DIR = path.join(REPO, "pb_hooks");

export const MEMBER_COLLECTION = "workspace_members";
export const BACK_RELATION = "workspace_members_via_workspace";
export const ACTIVE = "active";
export const AUTH_ID = "@request.auth.id";

export const CRUD_RULES = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];
export const VIEW_RULES = ["listRule", "viewRule"];

// A denormalised roster column is TEXT, so its grant is a LIKE, not only an equality.
export const MATCH_OPS = [...EQ_OPS, "~", "?~"];

// Python's Unicode \w, and \b next to a word character, spelled for JS.
const W = String.raw`[\p{L}\p{N}_]`;
const NOT_AFTER_W = `(?<!${W})`;
const NOT_BEFORE_W = `(?!${W})`;

export const ALIAS_RE = /^@collection\.workspace_members:([A-Za-z0-9_]+)\.([^\n]+)$/;
// A bare column, optionally in PocketBase's [[…]] reserved-word brackets.
export const COLUMN_RE = /^(?:\[\[)?([A-Za-z_][A-Za-z0-9_]*)(?:\]\])?$/;
export const PLACEHOLDER_RE = /^\{:([A-Za-z_][A-Za-z0-9_]*)\}$/;
export const WORD_RE = new RegExp(`[A-Za-z_]${W}*`, "gu");
// Any call passing "workspace_members" as its first argument, or after leading plain-identifier
// arguments (a helper's `earliest(app, "workspace_members", …)`) — derived, so a new finder name
// is covered without editing this file.
export const CALL_RE = new RegExp(
  `(?<callee>[A-Za-z_$][${W.slice(1, -1)}$]*(?:\\.[A-Za-z_$][${W.slice(1, -1)}$]*)*)\\s*\\(\\s*(?:[A-Za-z_$][${W.slice(1, -1)}$.]*\\s*,\\s*)*"workspace_members"\\s*,`,
  "gdu",
);
// A SQL membership predicate is assembled by concatenation, so it is matched against the
// file's string-literal content with every non-literal gap collapsed to one GAP char.
export const GAP = "\x00";
// A gap holding a separator ends the expression, so a predicate must not read past it into
// the next unrelated string literal.
export const BREAK = "\x01";
export const SEPARATORS = ";{}";
export const SQL_SITE_RE = new RegExp(
  `${NOT_AFTER_W}(?:FROM|JOIN)\\s+workspace_members\\s+(?<alias>[A-Za-z_]${W}*)`,
  "giu",
);
export const ASSIGN_RE = new RegExp(
  `${NOT_AFTER_W}(?:var|const|let)\\s+(?<name>[A-Za-z_$][${W.slice(1, -1)}$]*)\\s*=\\s*` +
    `(?<value>"(?:[^"\\\\]|\\\\[^\\n])*"|'(?:[^'\\\\]|\\\\[^\\n])*')`,
  "gu",
);
// PBTT-N / TASK-N / decision-N / decision:<slug>, or a 4-char kata ref (must mix a letter and
// a digit, so neither an English word nor a bare year passes as a citation).
export const CITATION_RE = new RegExp(
  `${NOT_AFTER_W}PBTT-\\p{Nd}+${NOT_BEFORE_W}|${NOT_AFTER_W}TASK-\\p{Nd}+${NOT_BEFORE_W}` +
    `|${NOT_AFTER_W}decision-\\p{Nd}+${NOT_BEFORE_W}` +
    `|${NOT_AFTER_W}decision:[a-z0-9]+(?:[-_][a-z0-9]+)*${NOT_BEFORE_W}` +
    `|${NOT_AFTER_W}(?=[a-z0-9]{4}${NOT_BEFORE_W})(?=[a-z]*\\p{Nd})(?=[0-9]*[a-z])[a-z0-9]{4}${NOT_BEFORE_W}`,
  "u",
);

/** A tuple-keyed dict's key: the JSON of the tuple (`JSON.parse` gives the tuple back). */
export type Allowlist = Map<string, string>;

// Empty since decision:invitation-keyed-by-email retired the invitee's view of the workspace record.
export const ALLOWLIST_RULES: Allowlist = new Map();
// Keyed on [file, callee, resolved filter] — a line number goes stale on any edit above the
// site, turning an unrelated change red and training readers to bump numbers reflexively.
export const ALLOWLIST_HOOKS: Allowlist = new Map([
  [
    JSON.stringify(["lib/landing.js", "earliest", "<unresolved filter: earliest(...)>"]),
    "pinned: the active-member lookup interpolates the file's ACTIVE constant (status 'active' or " +
      "empty), a template the resolver cannot expand (card 1y92)",
  ],
  [
    JSON.stringify(["lib/landing.js", "earliest", "user = {:u} && workspace.trashed = ''"]),
    "not a grant: the landing fallback looks up the caller's suspended rows on purpose, to report " +
      "reason 'suspended' instead of 'not found'; it returns no workspace access (card 1y92)",
  ],
  [
    JSON.stringify(["lib/landing.js", "earliest", "workspace = {:w} && user = {:u}"]),
    "not a grant: both reads fetch the caller's row in ANY status — the invitation walk must see a " +
      "suspended row, and switchCheck tests status in code before allowing (card 1y92)",
  ],
  [
    JSON.stringify([
      "me.pb.js",
      "sql:m",
      "JOIN workspace_members m ON m.workspace = w.id AND [[m.user]] = {:u} <?>  WHERE w.trashed = '' AND (w.owner = {:u} OR m.id IS NOT NULL) ORDER BY w.created, w.id",
    ]),
    "not a grant: GET /api/tracker/me lists the caller's own row in ANY status so a suspended " +
      "membership is reported as suspended; counts, name and capabilities are served only when " +
      "the owner or an active row reads the workspace (card 06sf)",
  ],
  [
    JSON.stringify([
      "owner.pb.js",
      "e.app.findFirstRecordByFilter",
      "workspace = {:w} && user = {:u}",
    ]),
    "not a grant: the workspaces after-create provision asks whether the new owner already holds " +
      "a roster row before minting their admin row, so a re-fire leaves exactly one row (card 06sf)",
  ],
  [
    JSON.stringify([
      "routes.pb.js",
      "txApp.findFirstRecordByFilter",
      "workspace = {:w} && user = {:u}",
    ]),
    "not a grant: POST /api/tracker/workspaces/{id}/transfer-ownership refuses every caller " +
      "who is not ws.owner (404) before this read, which fetches the OUTGOING owner's OWN roster " +
      "row to rewrite; an owner draws authority from workspaces.owner, not from a roster status, " +
      "and may hold no row at all (owner ruling pz18, wave K3)",
  ],
  [
    JSON.stringify([
      "invitations.pb.js",
      "txApp.findFirstRecordByFilter",
      "workspace = {:w} && user = {:u}",
    ]),
    "not a grant: POST /api/tracker/invitations/{id}/accept asks whether the invitee already " +
      "holds a membership row in ANY status, so it can leave that row unchanged instead of " +
      "creating a second; an active-only pin would miss a suspended row, and the create would then " +
      "fail on the (workspace, user) unique index instead of answering 200 (decision:invitation-keyed-by-email, card 729j)",
  ],
  [
    JSON.stringify(["routes.pb.js", "fetchScoped", "<unresolved filter: fetchScoped(...)>"]),
    "not a grant: POST /api/tracker/export re-checks ACTIVE membership by hand at " +
      "routes.pb.js:602 before any fetch, and this call lists the roster of that already " +
      "authorized workspace — fetchScoped builds `workspace = {:w}`, with no `user` leg at all " +
      "(PBTT-436, PBTT-431)",
  ],
  [
    JSON.stringify([
      "routes.pb.js",
      "e.app.countRecords",
      "<unresolved filter: e.app.countRecords(...)>",
    ]),
    "not a grant: GET /api/tracker/workspaces/{id}/deletion-impact answers only ws.owner (404 " +
      "for everyone else) before it counts, and this counts every roster row of that workspace " +
      "in ANY status, which is what deleting it removes (card pjpy, decision:soft-delete-trash)",
  ],
]);

/** The gate could not read what it must analyze — never a silent pass. */
export class SetupError extends Error {}

// --- shared: OR-tree walk -------------------------------------------------------------

/**
 * One conjunction node of an expression's OR-tree.
 *
 * `scope` adds every ancestor conjunct, so a status pin hoisted above the disjunction still
 * counts — only a pin on a DIFFERENT prefix/alias does not.
 */
export class Branch {
  constructor(
    public own: string[],
    public scope: string[],
    public text: string,
  ) {}
}

function _flatten(expr: string, own: string[], subs: string[]): void {
  expr = strip_outer_parens(expr);
  if (split_top_level(expr, "||").length > 1) {
    subs.push(expr);
    return;
  }
  const parts = split_top_level(expr, "&&");
  if (parts.length > 1) {
    for (const part of parts) _flatten(part, own, subs);
    return;
  }
  own.push(expr);
}

/** Every conjunction node of `expr`'s OR-tree, each carrying its ancestors' conjuncts. */
export function branches(expr: string, inherited: string[] = []): Branch[] {
  const out: Branch[] = [];
  expr = strip_outer_parens(expr);
  const disjuncts = split_top_level(expr, "||");
  if (disjuncts.length > 1) {
    for (const part of disjuncts) out.push(...branches(part, inherited));
    return out;
  }
  const own: string[] = [];
  const subs: string[] = [];
  _flatten(expr, own, subs);
  const scope = [...inherited, ...own];
  out.push(new Branch(own, scope, expr));
  for (const sub of subs) out.push(...branches(sub, scope));
  return out;
}

function _literal(text: string): string | null {
  text = py_strip(text);
  if (
    text.length >= 2 &&
    text[0] === text[text.length - 1] &&
    (text[0] === '"' || text[0] === "'")
  ) {
    return text.slice(1, -1);
  }
  return null;
}

// --- half A: collection rules ---------------------------------------------------------

/** -> [site key, column] for a workspace_members operand; the key is its prefix/alias. */
export function member_ref(operand: string): [string, string] | null {
  const text = py_strip(operand);
  const alias = ALIAS_RE.exec(text);
  if (alias) return [`@collection.${MEMBER_COLLECTION}:${alias[1]}`, alias[2]!];
  const marker = BACK_RELATION + ".";
  const at = text.indexOf(marker);
  if (at === -1) return null;
  return [text.slice(0, at + BACK_RELATION.length), text.slice(at + marker.length)];
}

function _is_column(column: string, name: string): boolean {
  return column === name || column.startsWith(name + ".");
}

/** -> [site key, other operand] when `atom` compares that site's `column` by equality. */
function _rule_atom(atom: string, column: string): [string, string] | null {
  const parts = split_comparison(strip_outer_parens(atom));
  if (parts === null || !EQ_OPS.includes(parts[1])) return null;
  const [left, , right] = parts;
  for (const [p, other] of [
    [left, right],
    [right, left],
  ] as [string, string][]) {
    const ref = member_ref(p);
    if (ref && _is_column(ref[1], column)) return [ref[0], other];
  }
  return null;
}

/** -> the membership site key this atom grants through, else null. */
export function rule_grant(atom: string): string | null {
  const got = _rule_atom(atom, "user");
  return got && py_strip(got[1]) === AUTH_ID ? got[0] : null;
}

/** -> the membership site key this atom pins to "active", else null. */
export function rule_status_pin(atom: string): string | null {
  const got = _rule_atom(atom, "status");
  return got && _literal(got[1]) === ACTIVE ? got[0] : null;
}

export class RuleFinding {
  constructor(
    public collection: string,
    public rule_name: string,
    public site: string,
    public disjunct: string,
    public rule: string,
    public detail: string[] = [],
  ) {}
}

export class RuleScan {
  findings: RuleFinding[] = [];
  sql_findings: HookSite[] = [];
  allowed: [string, string][] = [];
  hit = new Set<string>();
  rules_scanned = 0;
  branches_scanned = 0;
  member_branches = 0;
  collections: string[] = [];
  view_queries = 0;
  view_columns = 0;
  view_columns_pinned = 0;
}

function _load_rules(schema_dir: string): [Map<string, any>, Map<string, string>] {
  const rules = new Map<string, any>();
  const queries = new Map<string, string>();
  const pick = (data: any, names: string[]): any =>
    Object.fromEntries(names.map((rn) => [rn, get_or(data, rn)]));
  for (const file of glob_sorted(schema_dir, ".rules.json")) {
    const name = path.basename(file).slice(0, -".rules.json".length);
    rules.set(name, pick(JSON.parse(read_text(file)), CRUD_RULES));
  }
  for (const file of glob_sorted(schema_dir, ".view.json")) {
    const data = JSON.parse(read_text(file));
    const name = get_or(data, "name", path.basename(file).slice(0, -".view.json".length));
    rules.set(name, pick(data, VIEW_RULES));
    queries.set(name, get_or(data, "viewQuery") || "");
  }
  if (!rules.size) {
    throw new SetupError(`no schema/*.rules.json or schema/*.view.json under ${schema_dir}`);
  }
  return [rules, queries];
}

/** Flag every rule branch granting through a membership without a status="active" pin. */
export function scan_rules(schema_dir: string, allowlist: Allowlist): RuleScan {
  let rules: Map<string, any>;
  let queries: Map<string, string>;
  try {
    [rules, queries] = _load_rules(schema_dir);
  } catch (exc) {
    if (exc instanceof SetupError) throw exc;
    throw new SetupError(exc instanceof SyntaxError ? exc.message : os_error_text(exc));
  }

  const scan = new RuleScan();
  scan.collections = [...rules.keys()].sort(by_code_point);
  for (const collection of scan.collections) {
    const query = queries.get(collection) || "";
    const member_cols = query
      ? view_member_columns(collection, query)
      : new Map<string, HookSite[]>();
    const pinned = new Set(
      [...member_cols].filter(([, sites]) => sites.every((s) => s.guarded)).map(([c]) => c),
    );
    if (query) scan.view_queries += 1;
    scan.view_columns += member_cols.size;
    scan.view_columns_pinned += pinned.size;
    for (const site of query ? sql_sites(collection, query, true) : []) {
      if (!site.ok) scan.sql_findings.push(site);
    }
    for (const [rule_name, rule] of Object.entries(rules.get(collection)) as [string, any][]) {
      if (!rule) continue;
      scan.rules_scanned += 1;
      for (const branch of branches(rule)) {
        scan.branches_scanned += 1;
        const grants = new Set(branch.own.map(rule_grant).filter((g) => g) as string[]);
        const columns = new Set(
          branch.own.map((a) => column_grant(a, member_cols)).filter((c) => c) as string[],
        );
        if (!grants.size && !columns.size) continue;
        scan.member_branches += 1;
        const pins = new Set(branch.scope.map(rule_status_pin).filter((p) => p));
        for (const site of [...grants].filter((g) => !pins.has(g)).sort(by_code_point)) {
          const key = JSON.stringify([collection, rule_name, site]);
          if (allowlist.has(key)) {
            scan.hit.add(key);
            scan.allowed.push([key, allowlist.get(key)!]);
            continue;
          }
          scan.findings.push(new RuleFinding(collection, rule_name, site, branch.text, rule));
        }
        for (const column of [...columns].filter((c) => !pinned.has(c)).sort(by_code_point)) {
          scan.findings.push(
            new RuleFinding(
              collection,
              rule_name,
              column,
              branch.text,
              rule,
              _column_detail(member_cols.get(column)!),
            ),
          );
        }
      }
    }
  }
  return scan;
}

// --- half B: pb_hooks filter strings --------------------------------------------------

const QUOTES = "\"'`";

/** Replace comment bodies with spaces, preserving every offset and newline. */
export function blank_comments(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  let quote = "";
  while (i < n) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (QUOTES.includes(ch)) {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && i + 1 < n && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && i + 1 < n && src[i + 1] === "*") {
      while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i += 1;
      }
      for (let k = 0; k < 2; k++) {
        if (i < n) {
          out[i] = " ";
          i += 1;
        }
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Split a call's argument list at top-level commas; null if the parens never close. */
export function split_args(src: string, open_paren: number): string[] | null {
  const args: string[] = [];
  let buf = "";
  let depth = 0;
  let quote = "";
  let i = open_paren;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (quote) {
      buf += ch;
      if (ch === "\\" && i + 1 < n) {
        buf += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (QUOTES.includes(ch)) {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if ("([{".includes(ch)) {
      depth += 1;
      i += 1;
      if (depth > 1) buf += ch;
      continue;
    }
    if (")]}".includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        args.push(buf);
        return args.map((a) => py_strip(a)).filter((a) => a);
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (depth === 1 && ch === ",") {
      args.push(buf);
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  return null;
}

/**
 * Resolve a filter argument to its candidate strings; null when it cannot be resolved.
 *
 * Covers string literals, `a ? b : c` (BOTH arms become candidates) and `+` concatenation,
 * with ONE level of local var/const substitution. Anything else stays unresolved by design.
 */
export function resolve_filter(expr: string, scope: Map<string, string>): string[] | null {
  expr = py_strip(expr);
  if (!expr) return null;
  const ternary = split_top_level(expr, "?");
  if (ternary.length === 2) {
    const arms = split_top_level(ternary[1]!, ":");
    if (arms.length === 2) {
      const out: string[] = [];
      for (const arm of arms) {
        const got = resolve_filter(arm, scope);
        if (got === null) return null;
        out.push(...got);
      }
      return out;
    }
  }
  const parts: string[] = [];
  for (let piece of split_top_level(expr, "+")) {
    piece = strip_outer_parens(piece);
    let text = _literal(piece);
    if (text === null && scope.has(piece)) text = _literal(scope.get(piece)!);
    if (text === null) return null;
    parts.push(text);
  }
  return [parts.join("")];
}

/** -> the string-literal entries of a `{ k: "v" }` bindings object; others are dropped. */
export function parse_bindings(expr: string): Map<string, string> {
  const out = new Map<string, string>();
  const inner = py_strip(expr);
  if (!(inner.startsWith("{") && inner.endsWith("}"))) return out;
  const re = new RegExp(
    `([A-Za-z_$][${W.slice(1, -1)}$]*)\\s*:\\s*(?:"((?:[^"\\\\]|\\\\[^\\n])*)"|'((?:[^'\\\\]|\\\\[^\\n])*)')`,
    "gu",
  );
  for (const m of inner.matchAll(re)) out.set(m[1]!, m[2] || m[3] || "");
  return out;
}

/** -> the other operand when `atom` compares bare `column` by equality, else null. */
function _hook_atom(atom: string, column: string): string | null {
  const parts = split_comparison(strip_outer_parens(atom));
  if (parts === null || !EQ_OPS.includes(parts[1])) return null;
  const [left, , right] = parts;
  for (const [name, other] of [
    [left, right],
    [right, left],
  ] as [string, string][]) {
    const match = COLUMN_RE.exec(py_strip(name));
    if (match && match[1] === column && py_strip(other)) return py_strip(other);
  }
  return null;
}

/** A filter atom constraining `user` by EQUALITY — the grant shape (`user !=` is not). */
export function hook_grant(atom: string): boolean {
  return _hook_atom(atom, "user") !== null;
}

/** A filter atom pinning `status` to "active", literally or through its binding. */
export function hook_status_pin(atom: string, bindings: Map<string, string>): boolean {
  const other = _hook_atom(atom, "status");
  if (other === null) return false;
  if (_literal(other) === ACTIVE) return true;
  const placeholder = PLACEHOLDER_RE.exec(other);
  return truthy(placeholder && bindings.get(placeholder[1]!) === ACTIVE);
}

export class HookSite {
  constructor(
    public file: string,
    public line: number,
    public callee: string,
    public filters: string[],
    public resolved: boolean,
    public granting: boolean,
    public guarded: boolean,
  ) {}

  get key(): [string, string, string] {
    return [this.file, this.callee, this.filters.length ? this.filters[0]! : ""];
  }

  get ok(): boolean {
    return this.resolved && (!this.granting || this.guarded);
  }
}

export class HookScan {
  sites: HookSite[] = [];
  findings: HookSite[] = [];
  allowed: [HookSite, string][] = [];
  hit = new Set<string>();
  callees = new Set<string>();
  files_scanned = 0;
  sql_sites = 0;
}

function _site(
  name: string,
  line: number,
  callee: string,
  args: string[] | null,
  scope: Map<string, string>,
): HookSite {
  const unresolved = (): HookSite =>
    new HookSite(name, line, callee, [`<unresolved filter: ${callee}(...)>`], false, true, false);
  if (args === null || args.length < 2) return unresolved();
  const filters = resolve_filter(args[1]!, scope);
  if (filters === null) return unresolved();
  const bindings = args.length > 2 ? parse_bindings(args[2]!) : new Map<string, string>();
  let granting = false;
  let guarded = true;
  for (const text of filters) {
    for (const branch of branches(text)) {
      if (!branch.own.some(hook_grant)) continue;
      granting = true;
      if (!branch.scope.some((a) => hook_status_pin(a, bindings))) guarded = false;
    }
  }
  return new HookSite(name, line, callee, filters, true, granting, guarded);
}

/**
 * -> [every string literal's content concatenated, source offset per char].
 *
 * Each run of non-literal code between two literals collapses to ONE marker, so a SQL
 * predicate built by `+` reads as one string and an unresolved piece stays visible: GAP
 * when the run only joins the expression, BREAK when it holds a separator.
 */
export function flatten_strings(src: string): [string, number[]] {
  const out: string[] = [];
  const offsets: number[] = [];
  let i = 0;
  const n = src.length;
  let gap_start = -1;

  const flush_gap = (): void => {
    if (gap_start < 0) return;
    const run = src.slice(gap_start, i);
    out.push([...SEPARATORS].some((c) => run.includes(c)) ? BREAK : GAP);
    offsets.push(gap_start);
    gap_start = -1;
  };

  while (i < n) {
    const ch = src[i]!;
    if (QUOTES.includes(ch)) {
      flush_gap();
      const quote = ch;
      i += 1;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) {
          out.push(src[i + 1]!);
          offsets.push(i + 1);
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        out.push(src[i]!);
        offsets.push(i);
        i += 1;
      }
      continue;
    }
    if (!PY_WS_RE.test(ch) && gap_start < 0) gap_start = i;
    i += 1;
  }
  flush_gap();
  return [out.join(""), offsets];
}

/**
 * -> the predicate from `start` to its subquery's `)` or its statement's end; null if
 * the text runs out with neither, since an unbounded predicate cannot be judged.
 */
export function sql_window(text: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === BREAK) return text.slice(start, i);
    else if (ch === ")") {
      if (depth === 0) return text.slice(start, i);
      depth -= 1;
    }
  }
  return null;
}

/** `<alias>.<column> = …` by EQUALITY, tolerating PocketBase's [[…]] bracket quoting. */
function _sql_column_re(alias: string, column: string, value: string = ""): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(
    `${NOT_AFTER_W}${escaped}\\.(?:\\[\\[)?${column}(?:\\]\\])?\\s*(?<![!<>=])=(?!=)\\s*${value}`,
    "u",
  );
}

const count_newlines = (s: string, end: number): number => {
  let c = 0;
  for (let i = s.indexOf("\n"); i >= 0 && i < end; i = s.indexOf("\n", i + 1)) c += 1;
  return c;
};

/**
 * Every `FROM|JOIN workspace_members <alias>` predicate in a hook's SQL strings.
 *
 * `sql=true` reads `src` as one SQL statement instead of a JS file's string literals.
 */
export function sql_sites(name: string, src: string, sql: boolean = false): HookSite[] {
  let text: string;
  let offsets: number[];
  if (sql) {
    text = src + BREAK;
    offsets = Array.from({ length: src.length + 1 }, (_, i) => i);
  } else [text, offsets] = flatten_strings(src);
  const out: HookSite[] = [];
  for (const match of text.matchAll(SQL_SITE_RE)) {
    const alias = match.groups!.alias!;
    const line = count_newlines(src, offsets[match.index]!) + 1;
    const callee = `sql:${alias}`;
    const window = sql_window(text, match.index + match[0].length);
    if (window === null) {
      out.push(
        new HookSite(
          name,
          line,
          callee,
          [`<unterminated SQL predicate: ${match[0]}>`],
          false,
          true,
          false,
        ),
      );
      continue;
    }
    const predicate = (match[0] + window).replaceAll(GAP, " <?> ");
    const grant = _sql_column_re(alias, "user").test(window);
    const pin = _sql_column_re(alias, "status", "['\"]active['\"]").test(window);
    // No user constraint AND an unresolved fragment: that fragment could BE the grant.
    const resolved = grant || !window.includes(GAP);
    out.push(new HookSite(name, line, callee, [predicate], resolved, grant, pin));
  }
  return out;
}

// --- half C: view queries (half B's SQL machinery, aimed at schema/*.view.json) --------

/** -> every index of `sql` sitting at paren depth 0 outside a string literal. */
function _depth0(sql: string): Set<number> {
  const out = new Set<number>();
  let depth = 0;
  let quote = "";
  let i = 0;
  while (i < sql.length) {
    const [nxt, q, in_literal] = scan_step(sql, i, quote);
    quote = q;
    if (!in_literal) {
      const ch = sql[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (depth === 0) out.add(i);
    }
    i = nxt;
  }
  return out;
}

/** -> [offset, upper-cased word] for every word wholly at paren depth 0. */
function _words(sql: string): [number, string][] {
  const at = _depth0(sql);
  return [...sql.matchAll(WORD_RE)]
    .filter((m) => at.has(m.index) && at.has(m.index + m[0].length - 1))
    .map((m) => [m.index, m[0].toUpperCase()]);
}

/** -> {output column: its expression} for a view query's OUTER select list, else null. */
export function view_columns(query: string): Map<string, string> | null {
  const words = _words(query);
  if (!words.length || words[0]![1] !== "SELECT") return null;
  const start = words[0]![0] + "SELECT".length;
  const tail = words.filter(([off, word]) => word === "FROM" && off > start).map(([off]) => off);
  if (!tail.length) return null;
  const out = new Map<string, string>();
  for (const item of split_top_level(query.slice(start, tail[0]), ",")) {
    const marks = _words(item)
      .filter(([, word]) => word === "AS")
      .map(([off]) => off);
    const last = marks[marks.length - 1];
    const expr = last !== undefined ? py_strip(item.slice(0, last)) : py_strip(item);
    const name =
      last !== undefined
        ? py_strip(item.slice(last + "AS".length))
        : py_strip(item).split(".").pop()!;
    const match = COLUMN_RE.exec(name);
    if (!match || !expr) return null;
    out.set(match[1]!, expr);
  }
  return out;
}

/** -> {denormalised membership column: the workspace_members subselects feeding it}. */
export function view_member_columns(collection: string, query: string): Map<string, HookSite[]> {
  const columns = view_columns(query);
  if (columns === null) {
    if (query.search(SQL_SITE_RE) >= 0) {
      throw new SetupError(
        `${collection}: the viewQuery reads ${MEMBER_COLLECTION} and its select list ` +
          "could not be decomposed — an unreadable membership source is never a pass",
      );
    }
    return new Map();
  }
  const out = new Map<string, HookSite[]>();
  for (const [name, expr] of columns) {
    const sites = sql_sites(collection, expr, true);
    if (sites.length) out.set(name, sites);
  }
  return out;
}

/** -> the denormalised membership column this atom grants the caller through, else null. */
export function column_grant(atom: string, columns: Map<string, HookSite[]>): string | null {
  const parts = split_comparison(strip_outer_parens(atom));
  if (parts === null || !MATCH_OPS.includes(parts[1])) return null;
  const [left, , right] = parts;
  for (const [name, other] of [
    [left, right],
    [right, left],
  ] as [string, string][]) {
    const match = COLUMN_RE.exec(py_strip(name));
    if (match && columns.has(match[1]!) && py_strip(other) === AUTH_ID) return match[1]!;
  }
  return null;
}

/** -> the report lines pointing at the viewQuery subselect that must carry the pin. */
function _column_detail(sites: HookSite[]): string[] {
  const out: string[] = [];
  for (const site of sites) {
    if (site.guarded) continue;
    const alias = site.callee.slice(site.callee.indexOf(":") + 1);
    out.push(`subselect: ${site.filters[0]}`);
    out.push(`needs:     ${alias}.status = '${ACTIVE}' inside that viewQuery subselect`);
  }
  return out;
}

/** Flag every workspace_members hook filter granting on `user` without a status pin. */
export function scan_hooks(hooks_dir: string, allowlist: Allowlist): HookScan {
  const paths = [
    ...glob_sorted(hooks_dir, ".js"),
    ...glob_sorted(path.join(hooks_dir, "lib"), ".js"),
  ];
  if (!paths.length) throw new SetupError(`no *.js under ${hooks_dir}`);

  const scan = new HookScan();
  scan.files_scanned = paths.length;
  const found: HookSite[] = [];
  for (const file of paths) {
    const name = path.relative(hooks_dir, file);
    let raw: string;
    try {
      raw = read_text(file);
    } catch (exc) {
      throw new SetupError(os_error_text(exc));
    }
    const src = blank_comments(raw);
    const assigns = [...src.matchAll(ASSIGN_RE)].map(
      (m) => [m.index, m.groups!.name!, m.groups!.value!] as const,
    );

    for (const call of src.matchAll(CALL_RE)) {
      const line = count_newlines(src, call.index + call[0].length) + 1;
      const callee = call.groups!.callee!;
      scan.callees.add(callee);
      const scope = new Map(assigns.filter(([off]) => off < call.index).map(([, n, v]) => [n, v]));
      const all = split_args(src, src.indexOf("(", call.indices!.groups!.callee![1]));
      const at = all?.findIndex((a) => a.trim() === '"workspace_members"') ?? -1;
      const args = all && at >= 0 ? all.slice(at) : all;
      found.push(_site(name, line, callee, args, scope));
    }

    const sql = sql_sites(name, src);
    scan.sql_sites += sql.length;
    found.push(...sql);
  }

  found.sort((a, b) => by_code_point(a.file, b.file) || a.line - b.line);
  for (const site of found) {
    scan.sites.push(site);
    if (site.ok) continue;
    const key = JSON.stringify(site.key);
    if (allowlist.has(key)) {
      scan.hit.add(key);
      scan.allowed.push([site, allowlist.get(key)!]);
      continue;
    }
    scan.findings.push(site);
  }
  return scan;
}

// --- CLI --------------------------------------------------------------------------------

export function _uncited(allowlist: Allowlist): [string, string][] {
  return [...allowlist].filter(([, v]) => !CITATION_RE.test(v));
}

/** Python's repr of a tuple key. */
const key_repr = (key: string): string =>
  `(${(JSON.parse(key) as string[]).map((x) => py_repr(x)).join(", ")})`;

export function main(): number {
  const prog = path.basename(process.argv[1] ?? "");
  const pad = " ".repeat(`usage: ${prog} `.length);
  const usage =
    `usage: ${prog} [-h] [--schema-dir SCHEMA_DIR]\n` + `${pad}[--hooks-dir HOOKS_DIR] [--json]`;
  const args = parse_args(
    usage,
    `${usage}

Fail any permission branch granting through workspace_members without status =
"active" in that same branch (static, no server).

options:
  -h, --help            show this help message and exit
  --schema-dir SCHEMA_DIR
                        default: repo schema/
  --hooks-dir HOOKS_DIR
                        default: repo pb_hooks/
  --json                machine-readable report

SCOPE BOUNDS: half A reads the generated schema/ — five CRUD rules per base
collection, listRule/viewRule per view — and recognizes two membership
spellings, the <prefix>.workspace_members_via_workspace back-relation and the
@collection.workspace_members:<alias> join. Half B reads pb_hooks/*.js and pb_hooks/lib/*.js in two
passes: calls whose FIRST argument is the string literal "workspace_members",
and \`FROM|JOIN workspace_members <alias>\` predicates in the SQL those files
build by string concatenation. Half C reads each view's generated viewQuery: a
column of its OUTER select list whose expression reads workspace_members is a
denormalised membership column, and a rule matching one against the caller
grants through it, so that column's own subselect must carry the pin. A
membership source the inner query projects up under another name is NOT seen,
nor is a lookup by collection id. Every site half B cannot resolve is a
FINDING, never a silent pass. A stale or uncited allowlist entry fails the
gate.
`,
    [
      ["--schema-dir", "store", "schema_dir"],
      ["--hooks-dir", "store", "hooks_dir"],
      ["--json", "store_true", "json"],
    ],
    { schema_dir: SCHEMA_DIR, hooks_dir: HOOKS_DIR, json: false },
  );

  let rules: RuleScan;
  let hooks: HookScan;
  try {
    rules = scan_rules(args.schema_dir, ALLOWLIST_RULES);
    hooks = scan_hooks(args.hooks_dir, ALLOWLIST_HOOKS);
  } catch (exc) {
    if (!(exc instanceof SetupError)) throw exc;
    print(`❌ check_membership_status_guards: ${exc.message}`);
    return 2;
  }

  const stale = [
    ...[...ALLOWLIST_RULES].filter(([k]) => !rules.hit.has(k)),
    ...[...ALLOWLIST_HOOKS].filter(([k]) => !hooks.hit.has(k)),
  ];
  const uncited = [..._uncited(ALLOWLIST_RULES), ..._uncited(ALLOWLIST_HOOKS)];
  const bad = truthy(
    rules.findings.length ||
      rules.sql_findings.length ||
      hooks.findings.length ||
      stale.length ||
      uncited.length,
  );

  if (args.json) {
    print(
      json_dumps(
        {
          ok: !bad,
          rules: {
            collections: rules.collections,
            rules_scanned: rules.rules_scanned,
            disjuncts_scanned: rules.branches_scanned,
            membership_disjuncts: rules.member_branches,
            view_queries: rules.view_queries,
            view_membership_columns: rules.view_columns,
            view_membership_columns_pinned: rules.view_columns_pinned,
            view_query_findings: rules.sql_findings.map((s) => ({
              collection: s.file,
              site: s.callee,
              predicate: s.filters[0],
            })),
            findings: rules.findings.map((f) => ({
              collection: f.collection,
              rule: f.rule_name,
              site: f.site,
              disjunct: f.disjunct,
              detail: f.detail,
            })),
            allowlisted: rules.allowed.map(([k, v]) => ({ key: JSON.parse(k), reason: v })),
          },
          hooks: {
            files_scanned: hooks.files_scanned,
            callees: [...hooks.callees].sort(by_code_point),
            sites: hooks.sites.map((s) => ({
              file: s.file,
              line: s.line,
              callee: s.callee,
              filters: s.filters,
              resolved: s.resolved,
              granting: s.granting,
              guarded: s.guarded,
              ok: s.ok,
            })),
            findings: hooks.findings.map((s) => ({
              file: s.file,
              line: s.line,
              filters: s.filters,
            })),
            sql_sites: hooks.sql_sites,
            allowlisted: hooks.allowed.map(([s, v]) => ({
              key: s.key,
              file: s.file,
              line: s.line,
              reason: v,
            })),
          },
          stale_allowlist: stale.map(([k, v]) => ({ key: JSON.parse(k), reason: v })),
          uncited_allowlist: uncited.map(([k, v]) => ({ key: JSON.parse(k), reason: v })),
        },
        { indent: 2 },
      ),
    );
    return bad ? 1 : 0;
  }

  for (const finding of rules.findings) {
    print(
      `❌ ${finding.collection}.${finding.rule_name} grants through ` +
        `\`${finding.site}\` with no status pin in that disjunct`,
    );
    print(`     disjunct: ${finding.disjunct}`);
    const detail = finding.detail.length
      ? finding.detail
      : [`needs:    ${finding.site}.status ?= "${ACTIVE}" in the SAME disjunct`];
    for (const line of detail) print(`     ${line}`);
    print(`     rule:     ${finding.rule}`);
  }

  for (const site of rules.sql_findings) {
    const why = !site.resolved
      ? "predicate could not be fully resolved"
      : `constrains \`user =\` with no status = '${ACTIVE}' pin`;
    print(`❌ schema/${site.file}.view.json viewQuery — ${why}`);
    print(`     site:      ${site.callee}`);
    print(`     predicate: ${site.filters[0]}`);
  }

  for (const site of hooks.findings) {
    const sql = site.callee.startsWith("sql:");
    const kind = sql ? "predicate" : "filter";
    const why = !site.resolved
      ? `${kind} could not be fully resolved`
      : `constrains \`user =\` with no status = 'active' pin (${kind})`;
    print(`❌ pb_hooks/${site.file}:${site.line} — ${why}`);
    print(`     site:    ${site.callee}`);
    for (const text of site.filters) print(`     ${kind}: ${text}`);
  }

  for (const [key, reason] of stale) {
    print(`❌ stale allowlist entry ${key_repr(key)}: ${reason}`);
    print("     that site is gone or no longer a finding — drop the entry");
  }

  for (const [key, reason] of uncited) {
    print(`❌ uncited allowlist entry ${key_repr(key)}: ${reason}`);
    print(
      "     every exception must cite PBTT-N / TASK-N / decision-N / decision:<slug> / a kata ref",
    );
  }

  print(`allowlisted exceptions (${rules.allowed.length + hooks.allowed.length}):`);
  for (const [key, reason] of rules.allowed) {
    const [c, r] = JSON.parse(key) as string[];
    print(`  • ${c}.${r} — ${reason}`);
  }
  for (const [site, reason] of hooks.allowed) {
    print(`  • pb_hooks/${site.file}:${site.line} (${site.callee}) — ${reason}`);
  }

  print("coverage:");
  print(
    `  • rules: ${rules.rules_scanned} non-null rules across ${rules.collections.length} ` +
      `collections, ${rules.branches_scanned} disjuncts walked, ` +
      `${rules.member_branches} of them membership grants`,
  );
  print(
    `  • view queries: ${rules.view_columns} denormalised membership column(s) across ` +
      `${rules.view_queries} viewQuer(ies), ${rules.view_columns_pinned} of them pinned in ` +
      "their own subselect",
  );
  print(
    `  • hooks: ${hooks.sites.length} workspace_members call site(s) across ` +
      `${hooks.files_scanned} pb_hooks/{,lib/}*.js files, of which ${hooks.sql_sites} are raw-SQL ` +
      `predicates; call sites seen: ${[...hooks.callees].sort(by_code_point).join(", ")}`,
  );
  print(
    "  • NOT analyzed: a membership lookup by collection id — it neither passes " +
      '"workspace_members" as a call argument nor names the table in SQL',
  );
  print(
    "  • NOT analyzed: a view query whose INNER query reads workspace_members and projects " +
      "the roster up under another name — the outer select list is what half C decomposes, so " +
      "such a column stops being counted above rather than failing",
  );

  if (bad) {
    print(
      `❌ check_membership_status_guards: ${rules.findings.length} rule disjunct(s), ` +
        `${rules.sql_findings.length} view query predicate(s), ${hooks.findings.length} hook ` +
        `site(s), ${stale.length} stale + ${uncited.length} uncited allowlist entr(ies).`,
    );
    return 1;
  }
  print(
    `✅ check_membership_status_guards: ${rules.member_branches} membership rule ` +
      `disjunct(s), ${hooks.sites.length} hook site(s) and ${rules.view_columns} view ` +
      `membership column(s) all pin status "active" ` +
      `(${rules.allowed.length + hooks.allowed.length} allowlisted).`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

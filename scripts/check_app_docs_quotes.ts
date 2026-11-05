#!/usr/bin/env bun
/**
 * CI / pre-commit check: every filter expression quoted in an app_docs title/body is either
 * byte-identical to its live rule in schema/ or pinned as prose in the registry below.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  print,
  py_lstrip,
  py_rstrip,
  py_split,
  py_str,
  PY_WS,
  PY_WS_RE,
  read_text,
  sqlite_connect,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";

export const REPO = repo_root(import.meta.path);
export const PB = pb_bin_path(REPO);
export const MIGRATIONS = path.join(REPO, "pb_migrations");
export const FIELDS = ["title", "body"];

// --- registry -------------------------------------------------------------------------

/** A whole-rule quote that must stay byte-identical to `<collection>.<ruleField>`. */
export class Rule {
  constructor(readonly target: string) {}
}

/** A span pinned verbatim; `host` names the one live rule it must remain a fragment of. */
export class Prose {
  constructor(
    readonly span: string,
    readonly why: string,
    readonly host: string | null = null,
  ) {}
}

/** A body's claim that two live rules are byte-identical; consumes no span. */
export class Alias {
  constructor(
    readonly target: string,
    readonly same_as: string,
  ) {}
}

const _DRAFT_PLACEHOLDER =
  "draft = false || author = @request.auth.id || workspace.owner = @request.auth.id";
const _ADMIN_PREDICATE =
  "workspace_members_via_workspace.user ?= @request.auth.id " +
  '&& workspace_members_via_workspace.role ?= "admin"';
const _SELF_LEAVE = "user = @request.auth.id";
const _BODY_OWNER_GUARD = "@request.body.owner = @request.auth.id";
const _BOARD_DECISION_WHY =
  "verbatim board decision record (card p1qr): immutable once accepted, so it quotes the rule " +
  "as ruled and pins no live host";

export const REGISTRY = new Map<string, (Rule | Prose | Alias)[]>([
  [
    "decboard0000014",
    [
      new Prose(
        "id = @request.auth.id && @request.body.approved:isset = false",
        _BOARD_DECISION_WHY,
      ),
      new Prose("verified = true && approved = true", _BOARD_DECISION_WHY),
    ],
  ],
  ["decboard0000018", [new Prose('@request.auth.id != ""', _BOARD_DECISION_WHY)]],
  [
    "decboard0000023",
    [
      new Prose("owner = @request.auth.id", _BOARD_DECISION_WHY),
      new Prose("owner = @request.auth.id", _BOARD_DECISION_WHY),
    ],
  ],
  ["decboard0000040", [new Prose("@request.body.role:isset = false", _BOARD_DECISION_WHY)]],
  ["z6vik0zsp8v6sfa", [new Rule("app_settings.listRule")]],
  [
    "b2hi91tbm9h80tx",
    [
      new Prose(
        _DRAFT_PLACEHOLDER,
        "draft-privacy clause abbreviated with an <admin member> placeholder",
        "decisions.listRule",
      ),
    ],
  ],
  [
    "o6b9tapmrhfb482",
    [
      new Prose(
        _DRAFT_PLACEHOLDER,
        "draft-privacy clause abbreviated with an <admin member> placeholder",
        "documents.listRule",
      ),
    ],
  ],
  [
    "5fj7r3965k7obxi",
    [
      new Prose(
        _DRAFT_PLACEHOLDER,
        "draft-privacy clause abbreviated with an <admin member> placeholder",
        "milestones.listRule",
      ),
    ],
  ],
  [
    "g2ntf1col2docs3",
    [
      new Rule("notifications.listRule"),
      new Alias("notifications.viewRule", "notifications.listRule"),
    ],
  ],
  ["8g6448cc7r5ql8h", [new Rule("projects.createRule")]],
  [
    "g3svw1col2docs3",
    [
      new Prose(
        _BODY_OWNER_GUARD,
        "body-owner guard named alone; the live createRule also carries the membership clause",
        "saved_views.createRule",
      ),
    ],
  ],
  [
    "g2sub1col2docs3",
    [
      new Rule("task_subscribers.deleteRule"),
      new Prose(
        _SELF_LEAVE,
        "self-subscribe clause of createRule, textually identical to the whole deleteRule",
        "task_subscribers.createRule",
      ),
    ],
  ],
  ["ifm6mvrumn1ngvs", [new Rule("user_settings.listRule")]],
  [
    "y8sl3sb6uoxilzz",
    [
      new Rule("users.listRule"),
      new Rule("users.deleteRule"),
      new Rule("users.createRule"),
      new Rule("users.authRule"),
    ],
  ],
  [
    "9c1v6gwnu5scu17",
    [
      new Prose(
        _SELF_LEAVE,
        "self-leave branch of the live deleteRule, quoted alone",
        "workspace_members.deleteRule",
      ),
      new Prose(
        "workspace.owner != @request.auth.id",
        "owner-cannot-self-leave branch of the live deleteRule, quoted alone",
        "workspace_members.deleteRule",
      ),
    ],
  ],
  ["tx7ka2z2p2zc6gj", [new Rule("app_settings.listRule")]],
  [
    "ibitdtvttsl06g0",
    [new Rule("decisions.createRule"), new Alias("milestones.createRule", "decisions.createRule")],
  ],
  [
    "a72gm06kuii1s9w",
    [
      new Prose(
        "owner = @request.auth.id",
        "historical v001-v002 projects rule; superseded in m14",
      ),
    ],
  ],
  [
    "n8n6f4nc2bwnre6",
    [
      new Rule("projects.createRule"),
      new Prose(
        "owner = @request.auth.id",
        "historical pre-W1 projects.createRule the decision replaced",
      ),
    ],
  ],
  ["dec069o2bdenorm", [new Prose("active_members ~ @request.auth.id", _BOARD_DECISION_WHY)]],
  ["dec070invitwait", [new Prose('status ?= "active"', _BOARD_DECISION_WHY)]],
  ["8ya4xm7edxttyuz", [new Rule("project_stats.listRule")]],
  [
    "vjl4z5mc7b11ga2",
    [
      new Prose(
        _ADMIN_PREDICATE,
        "admin back-relation predicate quoted as a fragment, not a whole rule",
        "workspaces.updateRule",
      ),
    ],
  ],
  [
    "g3dec1views0001",
    [
      new Prose(
        _BODY_OWNER_GUARD,
        "body-owner guard named alone; the live createRule also carries the membership clause",
        "saved_views.createRule",
      ),
    ],
  ],
  ["ifnrzn0lt9qdi41", [new Rule("users.createRule"), new Rule("users.authRule")]],
  ["82khh111olkehro", [new Rule("user_settings.listRule")]],
]);

// --- span extraction ------------------------------------------------------------------

const SPACE = PY_WS;

// `*` is a whole path segment (@request.body.*), never glued to an identifier — otherwise
// markdown bold on a correct quote (`...@request.auth.id**`) is absorbed and reads as drift.
// A single-quoted string may hold no whitespace (card verh): every live rule contains some, so
// a prose apostrophe pair can no longer swallow one whole and hide it from this scan.
// shortcut: TOKEN_RE is swapped by a test through RegExp.prototype.compile (the module binding is read-only to importers).
export const TOKEN_RE = new RegExp(
  [
    `(?<WS>[${SPACE}]+)`,
    String.raw`(?<LP>\()`,
    String.raw`(?<RP>\))`,
    "(?<AND>&&)",
    String.raw`(?<OR>\|\|)`,
    String.raw`(?<CMP>\?!=|\?>=|\?<=|\?!~|\?=|\?>|\?<|\?~|!=|>=|<=|!~|=|>|<|~)`,
    String.raw`(?<STR>"[^"]*"|'[^'${SPACE}]*')`,
    String.raw`(?<NUM>-?\p{Nd}+(?:\.\p{Nd}+)?)`,
    String.raw`(?<PATH>@?[A-Za-z_][A-Za-z0-9_]*(?:\.(?:\*|[A-Za-z0-9_]+))*(?::[a-zA-Z]+)?)`,
    "(?<OTHER>.)",
  ].join("|"),
  "gu",
);

export const OPERANDS = new Set(["STR", "NUM", "PATH"]);
export const ANCHOR = /@request\.|@collection\.|\?=|\?!=|\?~|\?!~|\?>|\?<|_via_/;
export const GLUE_BEFORE = /[A-Za-z0-9_/\-.]/;
// `-` and `.` are excluded here on purpose: a hyphenated compound or a sentence-final
// period after a quote must not make the whole quote invisible.
export const GLUE_AFTER = /[A-Za-z0-9_/]/;
const _TRUNC = String.raw`&&|\|\||\?=|\?!=|\?~|\?!~|\?>|\?<|@request\.|@collection\.|_via_`;
export const TRUNC_BEFORE = new RegExp(`(?:${_TRUNC})$`);
export const TRUNC_AFTER = new RegExp(`^(?:${_TRUNC})`);

type Token = [string, string, number, number];

function _tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const kind = Object.keys(m.groups!).find((k) => m.groups![k] !== undefined)!;
    if (kind !== "WS") out.push([kind, m[0], m.index, m.index + m[0].length]);
  }
  return out;
}

/** Recursive descent over the PocketBase filter grammar: expr := term ((&&|||) term)*. */
class _Parser {
  t: Token[];
  i = 0;

  constructor(tokens: Token[]) {
    this.t = tokens;
  }

  peek(): string {
    return this.i < this.t.length ? this.t[this.i]![0] : "EOF";
  }

  expr(): boolean {
    if (!this.term()) return false;
    while (this.peek() === "AND" || this.peek() === "OR") {
      const save = this.i;
      this.i += 1;
      if (!this.term()) {
        this.i = save;
        break;
      }
    }
    return true;
  }

  term(): boolean {
    if (this.peek() === "LP") {
      const save = this.i;
      this.i += 1;
      if (this.expr() && this.peek() === "RP") {
        this.i += 1;
        return true;
      }
      this.i = save;
      return false;
    }
    return this.comparison();
  }

  comparison(): boolean {
    const save = this.i;
    if (OPERANDS.has(this.peek())) {
      this.i += 1;
      if (this.peek() === "CMP") {
        this.i += 1;
        if (OPERANDS.has(this.peek())) {
          this.i += 1;
          return true;
        }
      }
    }
    this.i = save;
    return false;
  }
}

function _glue_clean(text: string, start: number, end: number): boolean {
  return (
    (start === 0 || !GLUE_BEFORE.test(text[start - 1]!)) &&
    (end >= text.length || !GLUE_AFTER.test(text[end]!))
  );
}

/**
 * (clean spans, [(truncated span, region excerpt)]) — a maximal complete filter
 * expression is truncated when rule grammar runs straight into it without parsing.
 */
export function scan(
  text: string,
  live_values: Iterable<string> = [],
): [string[], [string, string][]] {
  const tokens = _tokenize(text);
  const found: [number, number][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const start = tokens[i]![2];
    if (start > 0 && GLUE_BEFORE.test(text[start - 1]!)) continue;
    const p = new _Parser(tokens.slice(i));
    if (!p.expr() || p.i === 0) continue;
    const end = tokens[i + p.i - 1]![3];
    if (!_glue_clean(text, start, end) || !ANCHOR.test(text.slice(start, end))) continue;
    // Every one of the 85 live rules contains whitespace, so a run-together candidate
    // (`expand=workspace_members_via_workspace`) can never be a real quote.
    if (PY_WS_RE.test(text.slice(start, end))) found.push([start, end]);
  }
  // live-rule-in-body, the SAFE direction: an exact live rule sitting in prose IS a quote.
  // (The forbidden direction is the inverse — blessing a body quote for being *inside* a rule.)
  for (const rule of live_values) {
    let i = text.indexOf(rule);
    while (i !== -1) {
      if (_glue_clean(text, i, i + rule.length)) found.push([i, i + rule.length]);
      i = text.indexOf(rule, i + 1);
    }
  }

  const uniq = new Map<string, [number, number]>();
  for (const s of found) {
    if (!found.some((o) => (o[0] !== s[0] || o[1] !== s[1]) && o[0] <= s[0] && s[1] <= o[1])) {
      uniq.set(`${s[0]},${s[1]}`, s);
    }
  }
  const maximal = [...uniq.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const clean: string[] = [];
  const truncated: [string, string][] = [];
  for (const [start, end] of maximal) {
    const span = strip_outer(text.slice(start, end));
    if (
      TRUNC_BEFORE.test(py_rstrip(text.slice(0, start))) ||
      TRUNC_AFTER.test(py_lstrip(text.slice(end)))
    ) {
      // the window counts code points, as Python indexes
      const points = Array.from(text);
      const lo = Math.max(0, Array.from(text.slice(0, start)).length - 30);
      const hi = Math.min(points.length, Array.from(text.slice(0, end)).length + 70);
      truncated.push([span, py_split(points.slice(lo, hi).join("")).join(" ")]);
    } else {
      clean.push(span);
    }
  }
  return [clean, truncated];
}

/** Drop one paren pair only when it genuinely wraps the whole expression. */
export function strip_outer(text: string): string {
  if (!(text.startsWith("(") && text.endsWith(")"))) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    depth += Number(text[i] === "(") - Number(text[i] === ")");
    if (depth === 0 && i < text.length - 1) return text;
  }
  return text.slice(1, -1);
}

// --- live rules -----------------------------------------------------------------------

const live_key = (collection: string, field: string): string => `${collection}\0${field}`;

/** Every non-empty `*Rule` in schema/ — view collections carry theirs in `.view.json`. */
export function load_live(repo: string): Map<string, string> {
  const live = new Map<string, string>();
  const schema_dir = path.join(repo, "schema");
  for (const name of fs.readdirSync(schema_dir).sort(by_code_point)) {
    const suffix = [".rules.json", ".view.json"].find((s) => name.endsWith(s));
    if (suffix === undefined) continue;
    const collection = name.slice(0, -suffix.length);
    for (const [field, value] of Object.entries(
      JSON.parse(read_text(path.join(schema_dir, name))),
    )) {
      if (field.endsWith("Rule") && value) live.set(live_key(collection, field), value as string);
    }
  }
  return live;
}

// --- gate -----------------------------------------------------------------------------

export const FIX_UNREGISTERED =
  "     → register it in REGISTRY of scripts/check_app_docs_quotes.ts:\n" +
  '       Rule("<collection>.<ruleField>") if the quote must track a whole live rule, or\n' +
  '       Prose(<span>, "<why>", host="<collection>.<ruleField>") if it is a fragment.';

function _text(rec: Record<string, any>, field: string): string {
  return rec[field] || "";
}

function _resolve(live: Map<string, string>, target: string): string | null {
  const dot = target.lastIndexOf(".");
  const collection = dot === -1 ? "" : target.slice(0, dot);
  const field = target.slice(dot + 1);
  return live.get(live_key(collection, field)) ?? null;
}

const counter = (xs: Iterable<string>): Map<string, number> => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return c;
};

/** 0/1 gate over app_docs rows (`id`, `slug`, `refName`, `title`, `body`). */
export function check(records: Iterable<Record<string, any>>, repo: string): number {
  const live = load_live(repo);
  const live_values = [...new Set(live.values())].sort(by_code_point);
  const problems: string[] = [];
  const seen = new Set<string>();
  let n_records = 0;
  let n_spans = 0;
  let n_rules = 0;
  let n_prose = 0;
  let n_alias = 0;

  for (const rec of records) {
    const rid = rec.id;
    const slug = rec.slug;
    seen.add(rid);
    const entries = REGISTRY.get(rid) ?? [];
    // A truncated region is only tolerable where the registry already pins the surviving
    // fragment as Prose — i.e. the record declares it is quoting a part, not a whole rule.
    const elisions = new Set(
      entries.filter((e): e is Prose => e instanceof Prose).map((e) => e.span),
    );
    const found: string[] = [];
    for (const field of FIELDS) {
      const [clean, truncated] = scan(_text(rec, field), live_values);
      found.push(...clean);
      for (const [span, region] of truncated) {
        if (elisions.has(span)) {
          found.push(span);
          continue;
        }
        problems.push(
          `❌ unparseable rule-grammar region\n` +
            `   • record ${py_str(rid)}  slug=${py_str(slug)}  field=${field}\n` +
            `     region: …${region}…\n` +
            `     parsed only: ${span}\n` +
            `     → rule grammar runs into this expression but does not parse as part\n` +
            `       of it (a placeholder like <field>, or a typo). Quote the rule\n` +
            `       verbatim, or pin the fragment with Prose(..., host=...).`,
        );
      }
    }
    if (!found.length && !entries.length) continue;
    n_records += 1;
    n_spans += found.length;
    const where = `record ${py_str(rid)}  slug=${py_str(slug)}  refName=${py_str(rec.refName)}`;

    const wanted: [string, Rule | Prose][] = [];
    for (const entry of entries) {
      if (entry instanceof Alias) {
        n_alias += 1;
        const mine = _resolve(live, entry.target);
        const theirs = _resolve(live, entry.same_as);
        if (mine === null || theirs === null) {
          problems.push(
            `❌ registry target does not exist in schema/\n` +
              `   • ${where}  Alias(${entry.target}, same_as=${entry.same_as})\n` +
              `     → fix the target, or drop the entry if the rule was removed.`,
          );
        } else if (mine !== theirs) {
          problems.push(
            `❌ byte-identity claim broken\n` +
              `   • ${where}\n` +
              `     the body says ${entry.target} is identical to ${entry.same_as}:\n` +
              `       ${entry.target}: ${mine}\n` +
              `       ${entry.same_as}: ${theirs}\n` +
              `     → they diverged; fix the body's claim via a data-seed migration\n` +
              `       and drop or re-target the Alias entry.`,
          );
        }
      } else if (entry instanceof Rule) {
        n_rules += 1;
        const rule_text = _resolve(live, entry.target);
        if (rule_text === null) {
          problems.push(
            `❌ registry target does not exist in schema/\n` +
              `   • ${where}  target=${entry.target}\n` +
              `     → fix the target, or drop the entry if the rule was removed.`,
          );
        } else {
          wanted.push([rule_text, entry]);
        }
      } else {
        n_prose += 1;
        wanted.push([entry.span, entry]);
        if (entry.host === null) continue;
        const host_text = _resolve(live, entry.host);
        // Containment is the right test for a DECLARED fragment; the TASK-062 hole was
        // containment used to bless a quote claiming to be a whole rule.
        if (host_text === null) {
          problems.push(
            `❌ registry host does not exist in schema/\n` +
              `   • ${where}  host=${entry.host}\n` +
              `     → fix the host, or drop the entry if the rule was removed.`,
          );
        } else if (!host_text.includes(entry.span)) {
          problems.push(
            `❌ pinned prose is no longer a fragment of its host rule\n` +
              `   • ${where}  host=${entry.host}\n` +
              `     pinned: ${entry.span}\n` +
              `     host rule: ${host_text}\n` +
              `     → the rule moved under the prose; resync the body via a data-seed\n` +
              `       migration and re-pin, or re-target the host.`,
          );
        }
      }
    }

    // Consumption is positional: one span occurrence satisfies at most one entry, so a
    // duplicate quote cannot stand in for a sibling sentence that was deleted.
    const occurrences = counter(found);
    const demand = counter(wanted.map(([text]) => text));
    for (const span of [...occurrences.keys()].sort(by_code_point)) {
      const count = occurrences.get(span)!;
      const extra = count - (demand.get(span) ?? 0);
      if (extra <= 0) continue;
      const times = count === 1 ? "" : `  (${extra} of ${count} occurrence(s) unregistered)`;
      problems.push(
        `❌ unregistered rule-grammar span\n` +
          `   • ${where}${times}\n` +
          `     span: ${span}\n${FIX_UNREGISTERED}`,
      );
    }

    for (const span of [...demand.keys()].sort(by_code_point)) {
      const count = demand.get(span)!;
      const missing = count - (occurrences.get(span) ?? 0);
      if (missing <= 0) continue;
      const owners = wanted.filter(([text]) => text === span).map(([, e]) => e);
      const body_spans =
        [...new Set(found)]
          .sort(by_code_point)
          .map((s) => `       ${s}`)
          .join("\n") || "       (none)";
      if (occurrences.get(span)) {
        problems.push(
          `❌ registry expects more occurrences than the body carries\n` +
            `   • ${where}\n` +
            `     text: ${span}\n` +
            `     entries expecting it: ${count} (${owners.map((o) => o.constructor.name).join(", ")})\n` +
            `     occurrences in the record: ${occurrences.get(span) ?? 0}\n` +
            `     → a quoted sentence was dropped; restore it, or drop the entry.`,
        );
      } else if (owners.some((o) => o instanceof Rule)) {
        const target = (owners.find((o) => o instanceof Rule) as Rule).target;
        problems.push(
          `❌ quoted rule drifted from schema/\n` +
            `   • ${where}  target=${target}\n` +
            `     live rule:\n       ${span}\n` +
            `     span(s) found in the record:\n${body_spans}\n` +
            `     → resync the quote to the live rule VERBATIM via a data-seed\n` +
            `       migration, or re-target/downgrade the registry entry to Prose().`,
        );
      } else {
        problems.push(
          `❌ pinned prose span no longer in the record\n` +
            `   • ${where}\n` +
            `     pinned: ${span}\n` +
            `     → drop the stale Prose() entry from REGISTRY, or restore the quote.`,
        );
      }
    }
  }

  for (const rid of REGISTRY.keys()) {
    if (!seen.has(rid)) {
      problems.push(
        `❌ registry entry for a record that no longer exists\n` +
          `   • record ${rid}\n` +
          `     → drop it from REGISTRY of scripts/check_app_docs_quotes.ts.`,
      );
    }
  }

  if (problems.length) {
    print("❌ check_app_docs_quotes: quoted rule grammar is not registry-clean.\n");
    for (const problem of problems) print(problem + "\n");
    print(
      "   Quotes are compared by EXACT equality — a substring match is not enough " +
        "(a stale quote is usually a prefix of the rule that replaced it).",
    );
    return 1;
  }

  print(
    `✅ check_app_docs_quotes: ${n_spans} rule-grammar span(s) across ${n_records} ` +
      `app_docs record(s) all registered (${n_rules} exact-equality rule quote(s), ` +
      `${n_prose} pinned prose, ${n_alias} byte-identity claim(s)).`,
  );
  return 0;
}

const HELP = `usage: check_app_docs_quotes.ts [-h] [--migrations-dir MIGRATIONS_DIR]

CI / pre-commit check: every filter expression quoted in an app_docs
title/body is either byte-identical to its live rule in schema/ or pinned as
prose in the registry below.

options:
  -h, --help            show this help message and exit
  --migrations-dir MIGRATIONS_DIR`;

export function main(argv: string[] | undefined = undefined): number {
  const usage = HELP.slice(0, HELP.indexOf("\n\n"));
  const args = parse_args(
    usage,
    HELP + "\n",
    [["--migrations-dir", "store", "migrations_dir"]],
    { migrations_dir: MIGRATIONS },
    argv,
  );

  if (!fs.existsSync(PB)) {
    print(
      `❌ check_app_docs_quotes: no ./pocketbase at ${PB} — run \`make pocketbase\`. ` +
        `A missing binary is a setup error, not a reason to pass.`,
    );
    return 1;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbquotes_"));
  try {
    const [ok, out] = migrate_up(PB, tmp, args.migrations_dir);
    if (!ok) {
      print("❌ check_app_docs_quotes: `migrate up` failed:\n" + out);
      return 1;
    }

    const con = sqlite_connect(path.join(tmp, "data.db"));
    let records: Record<string, any>[];
    try {
      records = con
        .query("SELECT id, slug, refName, title, body FROM app_docs ORDER BY slug")
        .all() as Record<string, any>[];
    } catch {
      print(
        "❌ check_app_docs_quotes: `app_docs` table not found — the convention " +
          "collection is missing.",
      );
      return 1;
    } finally {
      con.close();
    }

    return check(records, REPO);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(main());
}

#!/usr/bin/env bun
/**
 * Gate: a settings block a boot hook owns must never be re-asserted under pb_migrations/.
 *
 * AGENTS.md's law: secret-bearing settings ride env boot hooks, never migrations, because on a
 * FRESH database onBootstrap runs BEFORE the migrations — a migration carrying the block
 * overwrites what the hook just wrote, and the feature stays off until the second boot. The one
 * site that got this wrong left only a comment behind, and `migrate collections` re-emits the
 * block on every regeneration, so the convention needs a gate that can fail.
 *
 * The key set is DERIVED, never hand-typed (docs/design-patterns.md, "Invariants belong in the gate"):
 * a key is hook-owned when a pb_hooks/ file that registers onBootstrap WRITES it, either as the
 * head of a `settings.<key>` assignment or as a top-level key of an `unmarshal({...}, model)`
 * object. A read of the same key does not make that file an owner. A fifth family wired into a new boot hook is therefore gated the day it lands, with no
 * edit here. The families this derives today are a superset of the three AGENTS.md names, which
 * is the point: the failure mode is a hook's write being clobbered, and that does not depend on
 * the block holding a secret.
 *
 * Detection is over migration source with line and block comments removed, so the prose
 * explaining WHY a block is stripped does not trip the gate that keeps it stripped. Inside an
 * app_docs body the same words survive only as an escaped JS string literal, where a key reads
 * `\"oauth2\":` — the unescaped-quote lookbehind is what separates a real block from prose
 * quoting one.
 *
 * The settings-mutation shape requires a real `=`, because `settings.smtp.` also ends an
 * English sentence: prose naming a block is not a re-assertion of it, and the gate that keeps a
 * block stripped must not fire on the sentence explaining why it is stripped.
 *
 * Bound: a textual scan, not a JS parse, and the shapes it sees are exactly these — the JSON key
 * form `migrate collections` emits (`"oauth2": {`), and a direct mutation written on a local
 * literally named `settings` (`settings.oauth2.enabled = true`). Measured misses, each a real
 * shape a hand-written migration could use: the same idiom on a differently-named local
 * (`const s = app.settings(); s.oauth2... =`), a method-call head (`app.settings().oauth2... =`),
 * a bracket-indexed key (`settings["oauth2"]`), and a single-quoted key in the JSON form. Widening
 * to any identifier was rejected deliberately: the derived set includes broad names like `meta`
 * and `s3`, and `<anything>.meta =` in a migration is far more likely to be an unrelated write
 * than a settings one. Also invisible: a computed key, a spread, a helper this cannot name, or a
 * migration in a language this does not read.
 *
 * Derivation granularity is per FILE, not per callback: a file is consulted when it registers
 * onBootstrap anywhere, so a settings write in a request hook inside such a file still counts as
 * hook-owned. Only a write counts — a read like `if (!settings.smtp.enabled)` does not make its
 * file an owner, which is what keeps the blame list in the refusal honest.
 *
 * Usage:
 *     bun scripts/check_migration_settings_keys.ts [--hooks-dir DIR] [--migrations-dir DIR]
 */

import fs from "node:fs";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";
import { parse_args } from "./_argparse.ts";
import { by_code_point, py_repr, py_strip, PY_WS, read_text, splitlines } from "./_py.ts";

export const REPO = repo_root(import.meta.path);
export const HOOKS = path.join(REPO, "pb_hooks");
export const MIGRATIONS = path.join(REPO, "pb_migrations");

export const BOOT_MARKER = "onBootstrap";
// Python's re is Unicode-aware: \w is [\p{L}\p{N}_], \b a edge of that, \s PY_WS.
const W = String.raw`[\p{L}\p{N}_]`;
const NOT_W_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const S = `[${PY_WS}]`;
// Global regexes: use matchAll, never .test()/.exec() (stateful lastIndex).
export const SETTINGS_ASSIGN = new RegExp(
  String.raw`${NOT_W_BEFORE}settings\.([A-Za-z_]${W}*)(?:\.${W}+)*${S}*=(?!=)`,
  "gu",
);
export const UNMARSHAL_CALL = new RegExp(String.raw`${NOT_W_BEFORE}unmarshal${S}*\(${S}*\{`, "gu");
// Anchored at the start, as re.match.
export const OBJECT_KEY = new RegExp(String.raw`^["']?([A-Za-z_]${W}*)["']?${S}*:`, "u");

/** Blank out // and /* *\/ comments, preserving offsets and line count. */
export function strip_comments(text: string): string {
  // Walk code points, as Python indexes them, so a blanked astral char is one space.
  const cp = Array.from(text);
  const out: string[] = [];
  let i = 0;
  const n = cp.length;
  const find = (needle: string, from: number): number => {
    for (let j = from; j < n; j++)
      if (cp[j] === needle[0] && (needle.length === 1 || cp[j + 1] === needle[1])) return j;
    return -1;
  };
  while (i < n) {
    const two = cp.slice(i, i + 2).join("");
    if (two === "//") {
      let end = find("\n", i);
      end = end < 0 ? n : end;
      out.push(" ".repeat(end - i));
      i = end;
    } else if (two === "/*") {
      let end = find("*/", i + 2);
      end = end < 0 ? n : end + 2;
      out.push(
        cp
          .slice(i, end)
          .map((c) => (c === "\n" ? c : " "))
          .join(""),
      );
      i = end;
    } else {
      out.push(cp[i]!);
      i += 1;
    }
  }
  return out.join("");
}

/** Top-level keys of every `unmarshal({...}, model)` object literal in `text`. */
export function unmarshal_top_keys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const call of text.matchAll(UNMARSHAL_CALL)) {
    const start = text.indexOf("{", call.index);
    let depth = 0;
    let i = start;
    let body_start = 0;
    const n = text.length;
    while (i < n) {
      if (text[i] === "{") {
        depth += 1;
        if (depth === 1) body_start = i + 1;
      } else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    const body = text.slice(body_start, i);
    depth = 0;
    let segment: string[] = [];
    for (const ch of body) {
      // split the object body on depth-0 commas to reach each key
      if ("{[(".includes(ch)) depth += 1;
      else if ("}])".includes(ch)) depth -= 1;
      if (ch === "," && depth === 0) {
        const m = OBJECT_KEY.exec(py_strip(segment.join("")));
        if (m) keys.add(m[1]!);
        segment = [];
      } else {
        segment.push(ch);
      }
    }
    const m = OBJECT_KEY.exec(py_strip(segment.join("")));
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/** -> {settings key: the onBootstrap hook files that write it}. */
export function hook_owned_keys(hooks_dir: string): Map<string, Set<string>> {
  const owned = new Map<string, Set<string>>();
  for (const name of fs.readdirSync(hooks_dir).sort(by_code_point)) {
    if (!name.endsWith(".js")) continue;
    const raw = read_text(path.join(hooks_dir, name));
    if (!raw.includes(BOOT_MARKER)) continue;
    const text = strip_comments(raw);
    const found = new Set([...text.matchAll(SETTINGS_ASSIGN)].map((m) => m[1]!));
    for (const key of unmarshal_top_keys(text)) found.add(key);
    for (const key of found) {
      if (!owned.has(key)) owned.set(key, new Set());
      owned.get(key)!.add(name);
    }
  }
  return owned;
}

/** The shapes a migration re-asserting `key` actually takes. */
export function key_patterns(key: string): RegExp[] {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    // a JSON object key; an app_docs body escapes its quotes
    new RegExp(String.raw`(?<!\\)"${k}"${S}*:`, "gu"),
    // a bare key opening an object/array
    new RegExp(String.raw`(?<![\p{L}\p{N}_.$\\"'])${k}${S}*:${S}*[{\[]`, "gu"),
    // a direct settings mutation
    new RegExp(String.raw`${NOT_W_BEFORE}settings\.${k}(?:\.${W}+)*${S}*=(?!=)`, "gu"),
  ];
}

/** -> (migration file, line number, key, the offending line). */
export function offenders(
  migrations_dir: string,
  keys: Map<string, Set<string>>,
): [string, number, string, string][] {
  const found = new Map<string, [string, number, string, string]>();
  const patterns = new Map([...keys.keys()].map((key) => [key, key_patterns(key)]));
  for (const name of fs
    .readdirSync(migrations_dir)
    .filter((n) => n.endsWith(".js"))
    .sort(by_code_point)) {
    const text = strip_comments(read_text(path.join(migrations_dir, name)));
    const lines = splitlines(text);
    for (const [key, pats] of patterns) {
      for (const pat of pats) {
        for (const m of text.matchAll(pat)) {
          let line_no = 1;
          for (let j = text.indexOf("\n"); j >= 0 && j < m.index; j = text.indexOf("\n", j + 1)) {
            line_no += 1;
          }
          const line = Array.from(py_strip(lines[line_no - 1]!))
            .slice(0, 120)
            .join("");
          found.set(JSON.stringify([name, line_no, key, line]), [name, line_no, key, line]);
        }
      }
    }
  }
  // Tuple order: file, line number (numeric), key, line text.
  return [...found.values()].sort(
    (a, b) =>
      by_code_point(a[0], b[0]) ||
      a[1] - b[1] ||
      by_code_point(a[2], b[2]) ||
      by_code_point(a[3], b[3]),
  );
}

const HELP = `usage: check_migration_settings_keys.ts [-h] [--hooks-dir HOOKS_DIR]
                                        [--migrations-dir MIGRATIONS_DIR]

Gate: a settings block a boot hook owns must never be re-asserted under
pb_migrations/.

options:
  -h, --help            show this help message and exit
  --hooks-dir HOOKS_DIR
                        default: repo pb_hooks/
  --migrations-dir MIGRATIONS_DIR
                        default: repo pb_migrations/
`;

export function main(): number {
  const args = parse_args(
    HELP.slice(0, HELP.indexOf("\n\n")),
    HELP,
    [
      ["--hooks-dir", "store", "hooks_dir"],
      ["--migrations-dir", "store", "migrations_dir"],
    ],
    { hooks_dir: HOOKS, migrations_dir: MIGRATIONS },
  );

  for (const [label, dir] of [
    ["hooks", args.hooks_dir],
    ["migrations", args.migrations_dir],
  ] as const) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.log(`❌ check_migration_settings_keys: no ${label} dir at ${dir}`);
      return 2;
    }
  }

  const owned = hook_owned_keys(args.hooks_dir);
  if (!owned.size) {
    console.log(
      `❌ check_migration_settings_keys: derived NO hook-owned settings key from ` +
        `${args.hooks_dir} — the derivation has gone blind, which would report green ` +
        `about a tree it never checked.`,
    );
    return 2;
  }

  const hits = offenders(args.migrations_dir, owned);
  const inventory = [...owned]
    .sort((a, b) => by_code_point(a[0], b[0]))
    .map(([k, v]) => `${k} (${[...v].sort(by_code_point).join(", ")})`)
    .join(", ");
  if (hits.length) {
    console.log(
      "❌ check_migration_settings_keys: a boot-hook-owned settings block is re-asserted",
    );
    console.log("   under pb_migrations/. On a fresh database onBootstrap runs BEFORE the");
    console.log("   migrations, so this overwrites what the hook wrote and the feature stays off");
    console.log(
      "   until the second boot. Strip the block from the migration and let the hook own it.",
    );
    for (const [name, line_no, key, line] of hits) {
      console.log(`     • ${name}:${line_no}  key ${py_repr(key)}  →  ${line}`);
    }
    console.log(`\n   Derived hook-owned keys: ${inventory}`);
    return 1;
  }

  console.log(
    `✅ check_migration_settings_keys: no boot-hook-owned settings block under ` +
      `${args.migrations_dir} — ${owned.size} key(s) derived from ${args.hooks_dir}: ${inventory}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

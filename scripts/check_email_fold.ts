#!/usr/bin/env bun
/**
 * CI / pre-commit check: the email fold (owner ruling 2026-08-31 — trim + lowercase
 * always; gmail.com and googlemail.com ONLY lose the local part's dots and its first '+'
 * onwards) is INLINED at every site because the pooled JSVM cannot share a top-level
 * helper. No server, no DB, no network.
 *
 * The JS copies are pinned by IDENTITY, not by spelling. An earlier form of this gate
 * asserted that each copy contained a set of step regexes; eight behaviour-changing
 * mutations passed it, including folding every non-Gmail domain, merging the two Gmail
 * domains, and making one copy diverge from its siblings. So each copy's fold CORE is
 * extracted, normalised (comments stripped, whitespace collapsed) and required to be
 * textually IDENTICAL to the reference copy. The reference is the single copy in
 * pb_hooks/oauth.pb.js. It used to be the users.email_key backfill migration, chosen because a historical migration cannot drift — decision:project-items-membership-denormalised rebuilt pb_migrations/ as one
 * baseline set and a backfill has no place in it, since every database now boots fresh from the
 * current set. Which copy is named the reference decides only WHOSE spelling the others must
 * match, never whether they match: any copy drifting alone still fails, whichever one is pinned.
 *
 * A consequence worth knowing before you refactor: rewriting ONE copy — `.replaceAll(".", "")`
 * for `.split(".").join("")`, an `includes()` for the `||` chain — is drift by this gate's
 * definition and will fail it. Rewrite every JS copy together, or leave them alone.
 *
 * The TypeScript copy cannot be compared to JS text, so it is proven the other way: imported
 * and EXECUTED over the case table below, which encodes the owner ruling directly.
 *
 * Three further failures are drift: a copy whose domain set is not exactly the canonical
 * pair; a file holding the wrong number of anchored copies; and a fold implementation the
 * registry does not know about. The last is keyed on the fold OPERATIONS (dropping '+'
 * tags, dropping dots), never on the domain literal, so prose and fixtures that merely name
 * gmail.com are not implementations and never trip it.
 *
 * Declared bounded coverage: the sweep is idiom-keyed. An unregistered copy spelled
 * `.split("+").shift().replaceAll(".", "")` performs the fold and escapes it.
 */

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { repo_root } from "./_repo_root.ts";
import { by_code_point, os_walk, PY_WS, py_join, py_repr, py_strip, read_text } from "./_py.ts";

const REPO = repo_root(import.meta.path);
const SELF = path.relative(REPO, path.resolve(import.meta.path));

const HELP = `usage: check_email_fold.ts [-h]

Check that the email fold is inlined identically at every site.

options:
  -h, --help  show this help message and exit
`;

const CANONICAL_DOMAINS = ["gmail.com", "googlemail.com"];

// Any quoting style a JS/TS string list uses; overridden per site where the copy
// spells its domains some other way.
const EACH_DEFAULT = String.raw`["']([^"']*)["']`;

// The fold core starts here in every JS copy and runs to the close of the brace group
// that anchor opens. What precedes it (which field the address is read from) legitimately
// differs per site; what follows it (a scan, a lookup, a SQL write) does too.
const CORE_ANCHOR = "let key = canonical";

// The one step that lives OUTSIDE the core: each copy binds `canonical` from its own
// source expression, so only the tail of that expression is common.
const PROLOGUE_TAIL = ".trim().toLowerCase()";

// The operations no other code has a reason to perform on an email — these, not the
// domain names, are what identify an unregistered fold.
const WS = `[${PY_WS}]`;
const DISTINCTIVE: Record<string, Record<string, string>> = {
  js: {
    "drop-plus-tag": String.raw`\.split\("\+"\)\[0\]`,
    "drop-dots": String.raw`\.split\("\."\)\.join\(""\)`,
  },
};

type Site = {
  file: string;
  lang: string;
  block: string;
  copies: number;
  domains: string;
  reference?: boolean;
  unordered?: boolean;
  note?: string;
  each?: string;
};

// A block regex's optional `label` group distinguishes sibling copies in one file; its
// match span is the region the sweep treats as covered.
const SITES: Record<string, Site> = {
  "auth_identity hook": {
    file: "pb_hooks/auth_identity.pb.js",
    lang: "js",
    block:
      String.raw`INLINED CANONICALIZE \((?<label>[^)]*)\)[\s\S]*?` +
      String.raw`END INLINED CANONICALIZE \(\k<label>\)`,
    copies: 2,
    domains: String.raw`if \(([^)]*domain === [^)]*)\)`,
  },
  "oauth hook": {
    file: "pb_hooks/oauth.pb.js",
    lang: "js",
    block: "── INLINED FOLD[\\s\\S]*?── END INLINED FOLD",
    copies: 1,
    domains: String.raw`if \(([^)]*domain === [^)]*)\)`,
    reference: true,
  },
  "invitation hook": {
    file: "pb_hooks/invitations.pb.js",
    lang: "js",
    block:
      "── INLINED FOLD \\(invitation copy\\)[\\s\\S]*?── END INLINED FOLD \\(invitation copy\\)",
    copies: 1,
    domains: String.raw`if \(([^)]*domain === [^)]*)\)`,
  },
  "collision audit": {
    file: "scripts/utilities/email_collision_audit.ts",
    lang: "ts",
    block:
      `GMAIL_DOMAINS${WS}*=${WS}*new Set[\\s\\S]*?\\nexport function email_key\\([\\s\\S]*?` +
      "(?=\\n\\nexport function |$)",
    copies: 1,
    domains: `GMAIL_DOMAINS${WS}*=${WS}*new Set\\(\\[([^\\]]*)\\]\\)`,
    unordered: true,
    note: "GMAIL_DOMAINS is a set literal, so its domains are compared as a set",
  },
};

// The owner ruling as executable cases: (submitted address, folded key). Every line here
// discriminates against a mutation that a source-text check alone would wave through.
const FOLD_CASES: [string, string][] = [
  ["  Gmail.Dots+promo@GMAIL.com  ", "gmaildots@gmail.com"],
  ["Gmail.Dots+promo@googlemail.com", "gmaildots@googlemail.com"],
  ["Keep.Dots+promo@Example.com", "keep.dots+promo@example.com"],
  ["h.e@gmail.com", "he@gmail.com"],
  ["nofold@gmail.com", "nofold@gmail.com"],
  ["a+b@x@gmail.com", "a@gmail.com"],
  ["  NoAt.Sign+x  ", "noat.sign+x"],
];

const PY_FOLD = ["scripts/utilities/email_collision_audit.ts", "email_key"];

function _line_of(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** End offset of the brace group opened by the first `{` at or after `start`. */
function _brace_group(text: string, start: number): number | null {
  const opened = text.indexOf("{", start);
  if (opened === -1) return null;
  let depth = 0;
  for (let i = opened; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Comments and layout are not the fold; everything else is.
 *
 * Statement semicolons go too: the hooks carry them and the migration does not, and the
 * core holds no `for(;;)` where the separator would be load-bearing.
 */
function _normalize_js(source: string): string {
  const stripped = source.replace(/\/\/[^\n]*/g, "");
  return py_strip(stripped.replaceAll(";", " ").replace(new RegExp(`${WS}+`, "g"), " "));
}

/** The normalised fold core of one JS copy, or null when the anchor is gone. */
function _core(body: string): string | null {
  const start = body.indexOf(CORE_ANCHOR);
  if (start === -1) return null;
  const end = _brace_group(body, start);
  return end === null ? null : _normalize_js(body.slice(start, end));
}

/** (label, this copy's source, 1-based line, char span) for every copy in the file. */
function _copies(
  text: string,
  name: string,
  site: Site,
): [string, string, number, [number, number]][] {
  const found: [string, string, number, [number, number]][] = [];
  for (const match of text.matchAll(new RegExp(site.block, "g"))) {
    const label = match.groups?.label || name;
    found.push([
      label,
      match[0],
      _line_of(text, match.index),
      [match.index, match.index + match[0].length],
    ]);
  }
  return found;
}

function _diff(
  a_label: string,
  a_values: string[],
  b_label: string,
  b_values: string[],
): string | null {
  if (py_repr(a_values) === py_repr(b_values)) return null;
  const only_a = a_values.filter((v) => !b_values.includes(v));
  const only_b = b_values.filter((v) => !a_values.includes(v));
  if (!only_a.length && !only_b.length) {
    return (
      `${a_label} and ${b_label} list the same domains in a different order: ` +
      `${py_repr(a_values)} vs ${py_repr(b_values)}`
    );
  }
  const parts: string[] = [];
  if (only_a.length) parts.push(`only in ${a_label}: ${py_repr(only_a)}`);
  if (only_b.length) parts.push(`only in ${b_label}: ${py_repr(only_b)}`);
  return `${a_label} and ${b_label} disagree — ` + parts.join("; ");
}

/** Where two normalised cores part company, with a window either side. */
function _first_divergence(reference: string, other: string): string {
  const limit = Math.min(reference.length, other.length);
  let at = 0;
  while (at < limit && reference[at] === other[at]) at++;
  return (
    `they agree for ${at} characters, then\n` +
    `       reference: …${reference.slice(Math.max(0, at - 30), at + 50)}\n` +
    `       this copy: …${other.slice(Math.max(0, at - 30), at + 50)}`
  );
}

/** Run the TypeScript copy over the case table. (errors, the ✅ line when it passed.) */
async function _python_fold_behaviour(): Promise<[string[], string | null]> {
  const [relpath, func] = PY_FOLD as [string, string];
  const file = path.join(REPO, relpath);
  if (!fs.existsSync(file)) return [[`ts fold: ${relpath} not found on disk`], null];
  const module = await import(file);
  const fold = module[func];
  if (fold === undefined || fold === null) {
    return [[`ts fold: ${relpath} defines no ${func}()`], null];
  }

  const errors: string[] = [];
  for (const [submitted, expected] of FOLD_CASES) {
    const got = fold(submitted);
    if (got !== expected) {
      errors.push(
        `ts fold: ${func}(${py_repr(submitted)}) returned ${py_repr(got)}, the owner ruling ` +
          `says ${py_repr(expected)}`,
      );
    }
  }
  // The two Gmail domains are DISTINCT: an address at one never folds into the other.
  if (fold("a@gmail.com") === fold("a@googlemail.com")) {
    errors.push(
      `ts fold: ${func}() folds gmail.com and googlemail.com to the same key — ` +
        `the owner ruling holds them DISTINCT`,
    );
  }
  if (errors.length) return [errors, null];
  return [
    [],
    `✅ check_email_fold: ${relpath} executed over ${FOLD_CASES.length} ruling cases plus ` +
      `the gmail.com/googlemail.com distinctness case — every fold is as ruled.`,
  ];
}

export async function main(): Promise<number> {
  parse_args(HELP.slice(0, HELP.indexOf("\n\n")), HELP, [], {});

  const errors: string[] = [];
  const info: string[] = [];
  const ok_lines: string[] = [];
  const spans = new Map<string, [number, number][]>();
  const cores: [string, string][] = [];
  let reference: [string, string] | null = null;

  for (const [name, site] of Object.entries(SITES)) {
    const relpath = site.file;
    const file = path.join(REPO, relpath);
    if (!fs.existsSync(file)) {
      errors.push(`${name}: fold site ${relpath} not found on disk`);
      continue;
    }
    const text = read_text(file);

    const copies = _copies(text, name, site);
    if (copies.length !== site.copies) {
      errors.push(
        `${name}: ${relpath} holds ${copies.length} anchored fold copies, expected ` +
          `${site.copies} (anchor ${py_repr(site.block)})`,
      );
    }
    if (!copies.length) continue;
    if (!spans.has(relpath)) spans.set(relpath, []);
    spans.get(relpath)!.push(...copies.map((c) => c[3]));

    for (const [label, body, line] of copies) {
      const where = `${relpath}:${line} (${label})`;

      const block = new RegExp(site.domains).exec(body);
      if (block === null) {
        errors.push(
          `${name}: no domain set found at ${where} (looked for ${py_repr(site.domains)})`,
        );
      } else {
        const declared = [...block[1]!.matchAll(new RegExp(site.each ?? EACH_DEFAULT, "g"))].map(
          (m) => m[1]!,
        );
        let divergence: string | null;
        if (site.unordered) {
          divergence = _diff(
            where,
            [...new Set(declared)].sort(by_code_point),
            "the fold policy",
            [...CANONICAL_DOMAINS].sort(by_code_point),
          );
        } else {
          divergence = _diff(where, declared, "the fold policy", CANONICAL_DOMAINS);
        }
        if (divergence) errors.push(`${name}: ${divergence}`);
      }

      if (site.lang !== "js") {
        ok_lines.push(`✅ check_email_fold: ${where} → domain set as ruled`);
        continue;
      }

      if (!body.includes(PROLOGUE_TAIL)) {
        errors.push(
          `${name}: the copy at ${where} never binds its address with ` +
            `${py_repr(PROLOGUE_TAIL)} — trim + lowercase is not optional`,
        );
      }
      const core = _core(body);
      if (core === null) {
        errors.push(
          `${name}: no fold core found at ${where} — expected ${py_repr(CORE_ANCHOR)} ` +
            `followed by a brace group`,
        );
        continue;
      }
      cores.push([where, core]);
      if (site.reference) reference = [where, core];
      ok_lines.push(`✅ check_email_fold: ${where} → fold core parsed`);
    }

    if (site.note !== undefined) info.push(`ℹ️  ${name} @ ${relpath}: ${site.note}`);
  }

  if (reference === null) {
    errors.push(
      "no reference copy parsed — the copy in " +
        `${Object.values(SITES).find((s) => s.reference)!.file} is what every ` +
        "other copy is compared against",
    );
  } else {
    const [ref_where, ref_core] = reference as [string, string];
    for (const [where, core] of cores) {
      if (where !== ref_where && core !== ref_core) {
        errors.push(
          `the fold core at ${where} is not identical to the reference ` +
            `copy at ${ref_where} — ${_first_divergence(ref_core, core)}`,
        );
      }
    }
  }

  const [py_errors, py_ok] = await _python_fold_behaviour();
  errors.push(...py_errors);

  let swept = 0;
  // os.walk, not glob: glob skips dot-directories, and a rogue copy under .github/ must not hide.
  // A nested checkout (an agent worktree carries its own .git file) is another tree's copy.
  const prune = new Set(["node_modules", ".next", "pb_data", ".git", ".venv"]);
  const files_seen: string[] = [];
  for (const [d, dirs, files] of os_walk(REPO)) {
    const keep = dirs.filter((x) => !prune.has(x) && !fs.existsSync(py_join(d, x, ".git")));
    dirs.splice(0, dirs.length, ...keep);
    files_seen.push(
      ...files.filter((f) => f.includes(".")).map((f) => path.relative(REPO, py_join(d, f))),
    );
  }
  for (const relpath of files_seen.sort(by_code_point)) {
    if (relpath === SELF) continue;
    if (![".js", ".ts", ".tsx", ".mjs", ".cjs"].some((e) => relpath.endsWith(e))) continue;
    swept += 1;
    const text = read_text(py_join(REPO, relpath), "replace");
    const covered = spans.get(relpath) ?? [];
    for (const [step, pattern] of Object.entries(DISTINCTIVE.js!)) {
      for (const hit of text.matchAll(new RegExp(pattern, "g"))) {
        if (covered.some(([start, end]) => start <= hit.index && hit.index < end)) continue;
        errors.push(
          `a fold implementation at ${relpath}:${_line_of(text, hit.index)} ` +
            `is covered by no registered site (matched step '${step}')`,
        );
      }
    }
  }

  if (errors.length) {
    console.log("❌ check_email_fold: drift detected:");
    for (const e of errors) console.log(`     • ${e}`);
    return 1;
  }

  for (const line of info) console.log(line);
  for (const line of ok_lines) console.log(line);
  const ref_where = (reference as unknown as [string, string])[0];
  console.log(
    `✅ check_email_fold: ${Object.keys(SITES).length} sites / ` +
      `${Object.values(SITES).reduce((n, s) => n + s.copies, 0)} ` +
      `inlined copies — every copy declares ${py_repr(CANONICAL_DOMAINS)}, and every JS fold core is ` +
      `identical to the reference copy at ${ref_where}.`,
  );
  if (py_ok) console.log(py_ok);
  console.log(
    `✅ check_email_fold: swept ${swept} source files for the fold's distinctive ` +
      `operations — every implementation falls inside a registered copy.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

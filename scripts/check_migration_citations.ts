#!/usr/bin/env bun
/**
 * Gate: a migration filename cited anywhere in the repo carries the set it belongs to, and resolves.
 *
 * A migration filename is an implementation address, not a fact. The v1 set was collapsed into
 * the current one, so a bare `NNNNNNNNNN_settings.js` in prose or a comment now names nothing a
 * reader can open. A citation must therefore say WHICH set it means:
 *
 *     v1:FILE   resolves with `git show migrations-v1:pb_migrations/FILE`
 *     v2:FILE   resolves at pb_migrations/FILE in the current tree
 *
 * `migrations-v1:pb_migrations/FILE` — the literal git-show argument — reads as v1 too, so a
 * copy-pasteable command is a legal citation. Two assertions follow, and only these:
 *
 *   1. a match carrying no version prefix is a bare citation and fails;
 *   2. a versioned citation must resolve — v2 against pb_migrations/ on disk, v1 against the
 *      tagged tree, read once with `git ls-tree -r --name-only migrations-v1 pb_migrations/`.
 *      A checkout without the tag fails closed, so a shallow clone cannot report green.
 *
 * The filename SHAPE is derived, never hand-copied: every pb_migrations/*.js basename must match
 * \d{10}_[a-z0-9_]+\.js at startup, and the run refuses if one does not — a moved shape would
 * otherwise leave this gate silently blind.
 *
 * Scan set: `git ls-files` at the repo root. Skipped — pb_migrations/ itself (those files
 * legitimately carry their own and each other's names, and the historical-migration guard
 * forbids editing them), docs/generated/ (a generated tree copies its source's text, so the only
 * site a fix can land at is the source), every artifact .gitattributes marks generated (that
 * inventory is itself generated from each generator's own output constant, so a new generated
 * file is pruned without editing this script), and any file whose bytes are not UTF-8.
 *
 * Bounds, all in the run output: a filename that is the ENTIRE content of a single- or
 * double-quoted string is a functional value — an output path, a sentinel a guard keys on, a
 * fixture argument — and is exempted positionally, never by a hand-list of sites. That exemption
 * is blind to intent, so it also exempts the rare prose that quotes a bare filename and nothing
 * else. Untracked files are not scanned, and content is read from the WORKING TREE, so the
 * pre-commit job judges what is on disk rather than the staged blob. The trailing guard stops at
 * the first non-word character so a citation ending a sentence is still seen, which also reads
 * `FILE.js.map` as a citation of `FILE.js` (no such name exists here today). Whether a versioned
 * citation names the migration the sentence MEANS is not checkable here; only that it resolves.
 *
 * Usage:
 *     bun scripts/check_migration_citations.ts [--root DIR]
 */

import fs from "node:fs";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";
import { parse_args } from "./_argparse.ts";
import {
  SystemExit,
  UnicodeDecodeError,
  by_code_point,
  py_split,
  py_strip,
  read_text,
  splitlines,
} from "./_py.ts";

export const REPO = repo_root(import.meta.path);
export const TAG = "migrations-v1";
export const MIGRATIONS_DIR = "pb_migrations";

export const PRUNE_REL_PREFIXES = [
  // A generated tree copies its source's text; the source is the only site a fix can land at.
  "docs/generated/",
  // The migration set legitimately names itself, and the historical guard forbids editing it.
  "pb_migrations/",
];

// .gitattributes lists every GENERATED artifact (scripts/gen_gitattributes.ts writes it from
// each generator's own output constant), so reading it here prunes a new generated file without
// editing this script. Same reason as the prefixes above: a generated file copies its source.
export const GENERATED_INVENTORY = ".gitattributes";
export const INVENTORY_ATTRIBUTE = "merge=binary";

const SHAPE_PATTERN = String.raw`\d{10}_[a-z0-9_]+\.js`;
export const SHAPE = /^\p{Nd}{10}_[a-z0-9_]+\.js$/u;
// Trailing guard is `(?!\w)`, not `(?![\w.-])`: excluding `.` and `-` there would skip every
// citation that ends a sentence. `.jsx`/`.json` stay unmatched because `\w` follows their `.js`.
export const CITATION =
  /(?<![\p{L}\p{N}_.-])(?:(?:migrations-)?v(?<ver>[12]):)?(?:pb_migrations\/)?(?<file>\p{Nd}{10}_[a-z0-9_]+\.js)(?![\p{L}\p{N}_])/gu;

// Python's OSError family: a Node error carrying an errno code.
const is_os_error = (e: unknown): boolean =>
  typeof (e as { code?: unknown } | null)?.code === "string";

export function git(root: string, ...argv: string[]): [number, string] {
  const proc = Bun.spawnSync(["git", "-C", root, ...argv]);
  return [proc.exitCode ?? -1, new TextDecoder("utf-8").decode(proc.stdout)];
}

/** Basenames of the current set, or a hard exit when the directory this gate keys on is gone. */
export function on_disk_migrations(root: string): string[] {
  const dir = path.join(root, MIGRATIONS_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new SystemExit(
      `❌ check_migration_citations: ${MIGRATIONS_DIR}/ does not exist under ${root} — ` +
        `this gate cannot tell a resolvable v2 citation from an unresolvable one.`,
    );
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort(by_code_point);
}

/** The regex is only as good as the shape it was derived from; a moved shape blinds this gate. */
export function assert_shape(names: string[]): void {
  const odd = names.filter((n) => !SHAPE.test(n));
  if (odd.length) {
    throw new SystemExit(
      `❌ check_migration_citations: ${odd.length} migration filename(s) no longer match ` +
        `${SHAPE_PATTERN} — ${odd.join(", ")}. The naming shape moved and this gate is now ` +
        `blind to a citation of them; update SHAPE and CITATION together.`,
    );
  }
}

/** Basenames in the tagged v1 tree, read ONCE — never a git call per citation. */
export function tagged_migrations(root: string): Set<string> {
  const [status, out] = git(root, "ls-tree", "-r", "--name-only", TAG, `${MIGRATIONS_DIR}/`);
  if (status !== 0 || !py_strip(out)) {
    throw new SystemExit(
      `❌ check_migration_citations: ${TAG} tag not in this checkout — ` +
        `run: git fetch --tags origin`,
    );
  }
  return new Set(
    splitlines(out)
      .filter((line) => py_strip(line))
      .map((line) => path.basename(line)),
  );
}

export function tracked_files(root: string): string[] {
  const [status, out] = git(root, "ls-files", "-z");
  if (status !== 0) {
    throw new SystemExit(
      `❌ check_migration_citations: \`git ls-files\` failed under ${root} — ` +
        `this gate has no scan set and must not report green over one.`,
    );
  }
  return out
    .split("\0")
    .filter((p) => p)
    .sort(by_code_point);
}

/** A filename that IS a quoted string's whole content is a functional value, not a citation. */
export function is_quoted_whole(line: string, start: number, end: number): boolean {
  if (start === 0 || end >= line.length) return false;
  return (line[start - 1] === "'" || line[start - 1] === '"') && line[end] === line[start - 1];
}

/** True for a `<ref>:pb_migrations/FILE` path — what the author wrote is a git argument. */
export function ref_qualified(line: string, match: RegExpMatchArray): boolean {
  return match[0].startsWith(`${MIGRATIONS_DIR}/`) && line.slice(0, match.index).endsWith(":");
}

/** Offer only the spelling that would actually resolve; a wrong suggestion just re-fails. */
export function bare_message(
  where: string,
  name: string,
  ref_form: boolean,
  in_tag: boolean,
  on_disk: boolean,
): string {
  const options: string[] = [];
  if (in_tag) options.push(`write v1:${name} (git show ${TAG}:${MIGRATIONS_DIR}/${name})`);
  if (on_disk) {
    options.push(`write v2:${name} (${MIGRATIONS_DIR}/${name} in the current tree)`);
  }
  let fix: string;
  if (options.length) {
    fix = `${options.join(" or ")}, or cite the decision record or the collection and field.`;
  } else {
    fix =
      `it is in neither the ${TAG} tag nor ${MIGRATIONS_DIR}/ today, so no versioned ` +
      `spelling resolves — cite the decision record or the collection and field instead.`;
  }
  if (ref_form) {
    fix +=
      ` This is a <ref>:${MIGRATIONS_DIR}/… git argument, not prose: name the tagged set ` +
      `with ${TAG}:${MIGRATIONS_DIR}/${name}, never a commit sha.`;
  }
  return `${where}: bare migration citation '${name}' — ${fix}`;
}

export class Report {
  errors: string[] = [];
  scanned = 0;
  v1 = 0;
  v2 = 0;
  exempt = 0;
  pruned = 0;
  nontext = 0;
}

/** (directory prefixes, exact paths) of the artifacts .gitattributes marks as generated. */
export function generated_artifacts(root: string): [string[], Set<string>] {
  const prefixes: string[] = [];
  // Every token on a merge=binary line is a path, so the inventory itself holds no prose to
  // cite from — pruned whether or not it happens to list itself.
  const exact: string[] = [GENERATED_INVENTORY];
  let lines: string[];
  try {
    lines = read_text(path.join(root, GENERATED_INVENTORY)).match(/[^\n]*\n|[^\n]+/g) ?? [];
  } catch (e) {
    if (is_os_error(e)) return [[], new Set()];
    throw e;
  }
  for (let line of lines) {
    line = py_strip(line);
    if (!line || line.startsWith("#") || !line.includes(INVENTORY_ATTRIBUTE)) continue;
    const spec = py_split(line)[0]!;
    // `dir/**` is a directory; anything else names one file, matched whole so a sibling
    // path sharing its prefix is still scanned.
    if (spec.endsWith("/**")) prefixes.push(spec.slice(0, -2));
    else exact.push(spec);
  }
  return [prefixes, new Set(exact)];
}

export function audit(root: string): Report {
  const report = new Report();
  const current = new Set(on_disk_migrations(root));
  assert_shape([...current].sort(by_code_point));
  const tagged = tagged_migrations(root);

  const [gen_prefixes, gen_exact] = generated_artifacts(root);
  const prune = [...PRUNE_REL_PREFIXES, ...gen_prefixes];
  for (const rel of tracked_files(root)) {
    if (prune.some((p) => rel.startsWith(p)) || gen_exact.has(rel)) {
      report.pruned += 1;
      continue;
    }
    let text: string;
    try {
      text = read_text(path.join(root, rel));
    } catch (e) {
      // A tracked path that is not a readable regular file (a submodule gitlink,
      // a broken symlink) carries no text to cite from.
      if (e instanceof UnicodeDecodeError || is_os_error(e)) {
        report.nontext += 1;
        continue;
      }
      throw e;
    }
    report.scanned += 1;
    if (!text.includes("_") || !text.includes(".js")) continue;
    splitlines(text).forEach((line, idx) => {
      const lineno = idx + 1;
      for (const match of line.matchAll(CITATION)) {
        const name = match.groups!.file!;
        const ver = match.groups!.ver;
        const where = `${rel}:${lineno}`;
        if (ver === undefined) {
          if (is_quoted_whole(line, match.index, match.index + match[0].length)) {
            report.exempt += 1;
            continue;
          }
          report.errors.push(
            bare_message(
              where,
              name,
              ref_qualified(line, match),
              tagged.has(name),
              current.has(name),
            ),
          );
        } else if (ver === "2") {
          if (current.has(name)) {
            report.v2 += 1;
          } else {
            const instead = tagged.has(name)
              ? `it is in the ${TAG} tag: write v1:${name}.`
              : `it is not in the ${TAG} tag either, so the name is wrong.`;
            report.errors.push(
              `${where}: v2:${name} does not exist at ${MIGRATIONS_DIR}/${name} in ` +
                `this tree — ${instead}`,
            );
          }
        } else if (tagged.has(name)) {
          report.v1 += 1;
        } else {
          const instead = current.has(name)
            ? `it is in the current set: write v2:${name}.`
            : `it is not in ${MIGRATIONS_DIR}/ either, so the name is wrong.`;
          report.errors.push(
            `${where}: v1:${name} is not in the ${TAG} tag — git show ` +
              `${TAG}:${MIGRATIONS_DIR}/${name} resolves nothing; ${instead}`,
          );
        }
      }
    });
  }
  return report;
}

const HELP = `usage: check_migration_citations.ts [-h] [--root ROOT]

Gate: a migration filename cited anywhere in the repo carries the set it
belongs to, and resolves.

options:
  -h, --help   show this help message and exit
  --root ROOT  tree to audit (default: this checkout)
`;

export function main(): number {
  const args = parse_args(
    HELP.slice(0, HELP.indexOf("\n\n")),
    HELP,
    [["--root", "store", "root"]],
    { root: REPO },
  );

  const report = audit(path.resolve(args.root));
  if (report.errors.length) {
    console.log(
      `❌ check_migration_citations: ${report.errors.length} migration citation(s) do not ` +
        `resolve:`,
    );
    for (const err of report.errors) {
      console.log(`     • ${err}`);
    }
    return 1;
  }

  console.log(
    `✅ check_migration_citations: ${report.scanned} tracked file(s) scanned — ` +
      `${report.v1 + report.v2} versioned citation(s) resolve ` +
      `(${report.v1} v1 via the ${TAG} tag, ${report.v2} v2 on disk), ` +
      `${report.exempt} filename(s) exempted as the whole content of a quoted string ` +
      `(a functional value, not a citation), ` +
      `${report.pruned} file(s) skipped as generated or under ${MIGRATIONS_DIR}/, ` +
      `${report.nontext} skipped as non-UTF-8.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

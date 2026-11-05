#!/usr/bin/env bun
/**
 * CI / pre-commit check: flags the eew9 (PR #657) fixture class before it can regrow.
 *
 * Since decision:shadow-project, a superuser's unfiltered `projects/records` read returns the
 * workspace's invisible shadow container alongside its ordinary projects. A fixture that
 * picks "a project in this workspace" positionally (`filter=workspace='<ws>'&perPage=1`, or
 * indexing `items[0]` off an unfiltered read) can land on that container, and the
 * request-tier guard then refuses whatever the fixture tries to do with it. PR #657 hit this
 * on ten e2e specs at once; the fix was `&& shadow=false` on each filter. Same class: a
 * fixture literal named `Workspace items` collides with the container's own reserved display
 * name (`pb_hooks/shadow.pb.js`), breaking any resolve-by-name lookup for that string.
 *
 * Scope: `tests/**\/*.ts`. Two independent, purely textual checks —
 * no server, no parser:
 *
 *   (a) POSITIONAL RESOLVE: a `projects/records` read whose nearby text mentions `workspace`
 *       but never `shadow`, paired with a positional-pick signal (`perPage=1` close by, or
 *       `items[0]` / `getitem(x, "items")[0]` a little further down).
 *   (b) RESERVED FIXTURE NAME: a create/patch body literal `name: "Workspace items"` (or the
 *       quoted-key spelling) — `check(x, "Workspace items")`, an assertion rather than a
 *       fixture, never matches this shape.
 *
 * Bound: (a) reads the BLANK-LINE-DELIMITED block around a `projects/records?` mention (both
 * directions, capped at MAX_BLOCK lines) rather than the whole file, so it survives a filter
 * dict built a few lines above the fetch or an `items[0]` pick a few lines below it — but a
 * block with no blank line for MAX_BLOCK lines either way is read past its true statement,
 * and a `records()`-style test helper that hides the raw `projects/records?filter=` string
 * (tests/test_shadow_project.ts's own helper) is invisible to it by design, same as any
 * filter built through a shared helper it cannot trace into.
 *
 * Usage:
 *     bun scripts/check_fixture_project_resolve.ts [--root DIR] [--table]
 */

import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { by_code_point, print, py_strip, read_text, splitlines } from "./_py.ts";

export const SCAN_GLOBS = ["tests/**/*.ts"];
export const EXCLUDE_DIR_NAMES = new Set(["node_modules", "__pycache__"]);
// Its own unit-pin suite plants the trigger strings as scratch-file CONTENT inside string
// literals, to prove detection — scanning it would flag the checker's own test fixtures.
export const SELF_TEST = "test_fixture_project_resolve_checker.ts";

// A blank-line-delimited block matches how this codebase groups one fixture-arrangement
// statement (or a helper function's whole body) — that is what lets the workspace/shadow/key
// check see a `qs = urlencode({...})` dict built a couple of lines ABOVE the fetch
// (tests/test_item_keys.ts's find_project shape) and the positional-pick check see an
// `items[0]` a couple of lines BELOW it (the pre-#657 e2e shape), while not
// bleeding into the next unrelated function.
export const MAX_BLOCK = 20;

// `foo.items[0]` / `foo.items?.[0]`, or `getitem(foo, "items")[0]` / `foo["items"][0]` /
// `(foo.items || [...])[0]`, `foo.items?.at(0)`, or a destructured first pick `const [first] = foo.items`
// — NOT a bare `foo.items` (that alone is the ordinary "iterate every
// row" idiom, e.g. `for (const p of page.items ?? [])`, and is not a positional pick).
export const POSITIONAL_RE =
  /items\s*(?:\?\.)?\s*\[\s*0\s*\]|\bitems["']\s*\)?\s*\]?\s*\[\s*0\s*\]|\bitems\s*(?:\|\||\?\?)\s*\[[^\]]*\]\s*\)\s*\[\s*0\s*\]|\bitems\s*\??\.\s*at\s*\(\s*0\s*\)|\[\s*[\w$]+\s*(?:,[^\]]*)?\]\s*=\s*[\w$.?()]*\.items\b/;
export const PERPAGE1_RE = /perPage["']?\s*[:=]\s*1\b/;
// A filter clause, not a stray mention — `check(..., "the fresh workspace")` (a label
// string) or a `// shadow project` comment must not read as a filter constraint.
export const WORKSPACE_CLAUSE_RE = /workspace\s*=\s*['"]/;
export const SHADOW_CLAUSE_RE = /shadow\s*=/;
// An exact key match narrows to ONE record (tests/test_bulk_load_projects.ts's
// project_id_for) — not the "positional pick of any project" class this gate exists for.
export const KEY_CLAUSE_RE = /\bkey\s*=\s*['"]/;
// `"name": "Workspace items"` (quoted key) or `name: "Workspace items"` (bare key) — the
// key:value shape a create/patch BODY takes; `check(x, "Workspace items")` never matches it.
export const RESERVED_NAME_RE = /(?:"name"|\bname)\s*:\s*"Workspace items"/;

export const POSITIONAL_REASON =
  "resolves a project positionally with no shadow guard nearby — a superuser's " +
  "unfiltered read can land element 0 on the workspace's invisible container " +
  "(decision:shadow-project); add `&& shadow=false` (or `=true` if the container IS the fixture) " +
  "to the filter";
export const RESERVED_NAME_REASON =
  'fixture named "Workspace items" collides with the shadow project\'s own reserved ' +
  "display name (pb_hooks/shadow.pb.js) — a resolve-by-name lookup for that string " +
  "cannot tell the fixture from the real container";

const USAGE = "usage: check_fixture_project_resolve.ts [-h] [--root ROOT] [--table]";
const HELP = `${USAGE}

Flag a fixture that resolves a project positionally as superuser, or names
itself the shadow project's reserved display name (eew9 / PR #657).

options:
  -h, --help   show this help message and exit
  --root ROOT
  --table      print every scanned file, clean or not
`;

export function scan_paths(root: string): string[] {
  const paths: string[] = [];
  for (const pattern of SCAN_GLOBS) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      paths.push(path.join(root, rel));
    }
  }
  return paths
    .filter(
      (p) =>
        !p.split("/").some((part) => EXCLUDE_DIR_NAMES.has(part)) && path.basename(p) !== SELF_TEST,
    )
    .sort(by_code_point);
}

/** Contiguous non-blank lines around line i, both directions, capped at MAX_BLOCK. */
export function local_block(lines: string[], i: number): string {
  let start = i;
  while (start > 0 && start > i - MAX_BLOCK && py_strip(lines[start - 1]!) !== "") start -= 1;
  let end = i;
  while (end < lines.length - 1 && end < i + MAX_BLOCK && py_strip(lines[end + 1]!) !== "") {
    end += 1;
  }
  return lines.slice(start, end + 1).join("\n");
}

/** 1-based line numbers of a `projects/records` read resolved positionally, unguarded. */
export function find_positional_resolve(lines: string[]): number[] {
  const hits: number[] = [];
  lines.forEach((line, i) => {
    // The `?` anchors on a FILTERED list read — `projects/records/{id}` (a direct
    // fetch by id) has no `?` and is never a positional pick.
    if (!line.includes("projects/records?")) return;
    const block = local_block(lines, i);
    if (!WORKSPACE_CLAUSE_RE.test(block)) return;
    if (SHADOW_CLAUSE_RE.test(block) || KEY_CLAUSE_RE.test(block)) return;
    if (PERPAGE1_RE.test(block) || POSITIONAL_RE.test(block)) hits.push(i + 1);
  });
  return hits;
}

/** 1-based line numbers of a create/patch body naming the reserved container name. */
export function find_reserved_name(lines: string[]): number[] {
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (RESERVED_NAME_RE.test(line)) hits.push(i + 1);
  });
  return hits;
}

/** (line, kind, reason) findings for one file. */
export function audit(file: string): [number, string, string][] {
  const lines = splitlines(read_text(file));
  const findings: [number, string, string][] = [
    ...find_positional_resolve(lines).map((n): [number, string, string] => [
      n,
      "positional-resolve",
      POSITIONAL_REASON,
    ]),
    ...find_reserved_name(lines).map((n): [number, string, string] => [
      n,
      "reserved-fixture-name",
      RESERVED_NAME_REASON,
    ]),
  ];
  return findings.sort(
    (a, b) => a[0] - b[0] || by_code_point(a[1], b[1]) || by_code_point(a[2], b[2]),
  );
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parse_args(
    USAGE,
    HELP,
    [
      ["--root", "store", "root"],
      ["--table", "store_true", "table"],
    ],
    { root: path.dirname(path.dirname(path.resolve(import.meta.path))), table: false },
    argv,
  );
  const root = path.resolve(args.root);

  const paths = scan_paths(root);
  const errors: string[] = [];
  for (const file of paths) {
    const rel = path.relative(root, file);
    const findings = audit(file);
    if (!findings.length) {
      if (args.table) print(`  ✅  ${rel}`);
      continue;
    }
    for (const [line, kind, reason] of findings) errors.push(`${rel}:${line}: [${kind}] ${reason}`);
    if (args.table) print(`  ❌  ${rel} — ${findings.length} finding(s)`);
  }

  if (errors.length) {
    print("❌ check_fixture_project_resolve: fixture(s) in the eew9 (PR #657) bug class:");
    for (const e of errors) print(`     • ${e}`);
    return 1;
  }

  print(
    `✅ check_fixture_project_resolve: ${paths.length} file(s) scanned under ` +
      `${SCAN_GLOBS.join(", ")} — no unguarded positional project resolve, no fixture ` +
      `named the shadow project's reserved name.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

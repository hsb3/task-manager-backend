#!/usr/bin/env bun
/**
 * make check-static gate: every recursive scratch copy goes through scripts/_scratch_copy.ts
 * copy_tree, which refuses a symlink anywhere in its source.
 *
 * Bound (line scan, `//` and `#` comment lines skipped): `cpSync`, `fs.cp(`, `fs.promises.cp(`,
 * `fsp.cp(` or a bare `cp(` in scripts/, tests/, e2e/ .ts files, and `cp` or `/path/cp` with
 * -R/-r/-a/--recursive/--archive in scripts/ and e2e/ .sh, the Makefile and deploy/. Not seen: a
 * renamed import, a shell cp inside a TS string or template (Bun.$, sh -c), and a spawn argv.
 *
 * Usage:
 *     bun scripts/check_scratch_copies.ts
 */

import fs from "node:fs";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";

const HELPER = "scripts/_scratch_copy.ts";
const SELF = "scripts/check_scratch_copies.ts"; // its patterns spell the tokens it hunts
const TS_COPY = /\bcpSync\b|\b(?:fs|fsp|promises)\.cp\(|(?<![.\w$])cp\(/;
const SHELL_COPY =
  /(^|[\s;&|(@])(?:\S*\/)?cp(?:\s+-\S+)*?\s+(?:-[A-Za-z]*[Rra][A-Za-z]*|--recursive|--archive)(?:\s|$)/;

// The battery's own guarded copies (assert_copy_source on source or copy), each allowed ONCE by trimmed text.
export const ALLOWED: Record<string, Set<string>> = {
  "scripts/run_suite_battery.sh": new Set([
    'cp -R "$HOOKS_DIR" "$SCRATCH/pb_hooks" || fail "could not copy $HOOKS_DIR"',
    'cp -R "$REPO_ROOT/pb_migrations" "$LEGACY_MIGRATIONS" || fail "could not copy migrations"',
    'cp -R "$REPO_ROOT/pb_migrations" "$HARD_MIGRATIONS" || fail "could not copy migrations"',
  ]),
};

function walk(root: string, rel: string, keep: (f: string) => boolean): string[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) return keep(rel) ? [rel] : [];
  return fs
    .readdirSync(dir)
    .filter((n) => n !== "node_modules")
    .sort()
    .flatMap((n) => walk(root, path.join(rel, n), keep));
}

/** `file:line: text` for every raw recursive copy under `root`. */
export function audit(root: string): string[] {
  const ts_files = ["scripts", "tests", "e2e"].flatMap((d) =>
    walk(root, d, (f) => f.endsWith(".ts") && f !== HELPER && f !== SELF),
  );
  const shell_files = [
    ...["scripts", "e2e"].flatMap((d) => walk(root, d, (f) => f.endsWith(".sh"))),
    ...walk(root, "Makefile", () => true),
    ...walk(root, "deploy", () => true),
  ];
  const out: string[] = [];
  for (const [files, pattern, comment] of [
    [ts_files, TS_COPY, "//"],
    [shell_files, SHELL_COPY, "#"],
  ] as const) {
    for (const f of files) {
      const allowed = new Set(ALLOWED[f]);
      fs.readFileSync(path.join(root, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const text = line.trim();
          if (text.startsWith(comment) || text.startsWith("*") || !pattern.test(text)) return;
          if (allowed.delete(text)) return;
          out.push(`${f}:${i + 1}: ${text}`);
        });
    }
  }
  return out;
}

if (import.meta.main) {
  const bad = audit(repo_root(import.meta.path));
  for (const b of bad) console.log(`❌ ${b}`);
  if (bad.length) {
    console.log(
      `❌ check_scratch_copies: copy a tree with copy_tree from ${HELPER}, which refuses a symlink inside the source.`,
    );
    process.exit(1);
  }
  console.log("✅ check_scratch_copies: every recursive scratch copy goes through copy_tree.");
}

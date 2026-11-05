#!/usr/bin/env bun
/** Unit-pin scripts/check_fixture_project_resolve.ts: the blank-line-bounded block, the positional/shadow/key clause predicates, the reserved-name shape, and CLI RED/GREEN against scratch trees (no server, no DB). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr } from "../scripts/_py.ts";
import * as fpr from "../scripts/check_fixture_project_resolve.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const CHECKER = path.join(REPO_ROOT, "scripts", "check_fixture_project_resolve.ts");

let failures = 0;

function check(label: string, got: any, want: any): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${py_repr(got)}`);
    console.log(`        want: ${py_repr(want)}`);
  }
}

function scratch_tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-fixture-resolve-checker-"));
  fs.mkdirSync(path.join(root, "tests"));
  return root;
}

function write(root: string, rel: string, text: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function run_cli(...args: string[]): [number, string] {
  const proc = Bun.spawnSync([process.execPath, CHECKER, ...args], { env: process.env });
  return [proc.exitCode ?? -1, proc.stdout.toString() + proc.stderr.toString()];
}

console.log(
  "════════ test_fixture_project_resolve_checker.ts — fixture-resolve checker unit pins ════════",
);

console.log(
  "\n── (a) local_block: blank lines bound the block both directions, capped at MAX_BLOCK ──",
);
const lines = ["function f() {", "  const a = 1;", "", "  const b = 2;", "  const c = 3;"];
check(
  "block around line 3 (b = 2) stops at the blank line above",
  fpr.local_block(lines, 3),
  "  const b = 2;\n  const c = 3;",
);
check(
  "block around line 1 (a = 1) stops at the blank line below",
  fpr.local_block(lines, 1),
  "function f() {\n  const a = 1;",
);
const huge = Array<string>(50).fill("x");
check(
  "a block with no blank line is capped at MAX_BLOCK lines either way",
  fpr.local_block(huge, 25).split("\n").length,
  2 * fpr.MAX_BLOCK + 1,
);

console.log(
  "\n── (b) positional resolve: perPage=1 or items[0] near an unguarded workspace filter ──",
);
check(
  "workspace filter + perPage=1, no shadow → flagged",
  fpr.find_positional_resolve([
    "const [s, r] = await api(",
    "  \"GET\", `/api/collections/projects/records?filter=workspace='${ws}'&perPage=1`, su",
    ");",
  ]),
  [2],
);
check(
  "same shape but with `&& shadow=false` in the filter → covered",
  fpr.find_positional_resolve([
    "const [s, r] = await api(",
    "  \"GET\", `/api/collections/projects/records?filter=workspace='${ws}' && shadow=false&perPage=1`, su",
    ");",
  ]),
  [],
);
check(
  "an exact key= match is not a positional pick, even unguarded",
  fpr.find_positional_resolve([
    'const qs = `filter=workspace="${ws}" && key="${k}"`;',
    'const [x, r] = await api("GET", `/api/collections/projects/records?${qs}`, su);',
    "return r.items[0].id;",
  ]),
  [],
);
check(
  "a direct fetch by id (no `?`) is never a positional pick",
  fpr.find_positional_resolve([
    'await api("GET", `/api/collections/projects/records/${pid}`, su);',
  ]),
  [],
);
check(
  "workspace filter with no perPage=1 and no items[0]/getitem(x, 'items')[0] nearby → covered",
  fpr.find_positional_resolve([
    "const r = await api(\"GET\", `/api/collections/projects/records?filter=workspace='${ws}'`, su);",
    "return (r.items ?? []).map((p: any) => p.id);",
  ]),
  [],
);
check(
  "`.items` alone (iterate every row) is not a positional pick",
  fpr.POSITIONAL_RE.test(
    "return Object.fromEntries((page.items ?? []).map((p: any) => [p.k, p]));",
  ),
  false,
);
check(
  '`getitem(x, "items")[0]` IS a positional pick',
  fpr.POSITIONAL_RE.test('const item = getitem(page, "items")[0];'),
  true,
);
check(
  "`(x.items || [{}])[0]` IS a positional pick",
  fpr.POSITIONAL_RE.test('const S = (shadow.items || [{}])[0].id ?? "";'),
  true,
);
check(
  "`x.items.at(0)` / `x.items?.at(0)` IS a positional pick",
  ["const pid = page.items.at(0).id;", "const pid = page.items?.at(0)?.id;"].map((l) =>
    fpr.POSITIONAL_RE.test(l),
  ),
  [true, true],
);
check(
  "a destructuring first pick off `.items` IS a positional pick",
  [
    "const [first] = page.items;",
    "const [a, ...rest] = res.body.items;",
    "const [p] = page?.items ?? [];",
  ].map((l) => fpr.POSITIONAL_RE.test(l)),
  [true, true, true],
);
check(
  "`items.at(-1)`, `items.at(i)` and `const [st, page] = await api(...)` are not",
  [
    "const last = page.items.at(-1);",
    "const it = page.items.at(i);",
    "const [st, page] = await api(base, 'GET', u, tok);",
  ].map((l) => fpr.POSITIONAL_RE.test(l)),
  [false, false, false],
);
check(
  "workspace filter + a destructured first pick, no shadow → flagged",
  fpr.find_positional_resolve([
    "const [st, page] = await api(base, \"GET\", `/api/collections/projects/records?filter=workspace='${ws}'`, tok);",
    "const [first] = page.items;",
  ]),
  [1],
);
check(
  "a `workspace` mention inside PROSE (an assertion label) is not a filter clause",
  fpr.WORKSPACE_CLAUSE_RE.test('check("belongs to the fresh workspace", x, y)'),
  false,
);

console.log("\n── (c) reserved fixture name: the create/patch BODY shape only ──");
check(
  'quoted-key body `"name": "Workspace items"` is flagged',
  fpr.find_reserved_name(['{"name": "Workspace items", "workspace": ws}']),
  [1],
);
check(
  'TS object body `name: "Workspace items"` is flagged',
  fpr.find_reserved_name(['body: { name: "Workspace items", workspace: wsId }']),
  [1],
);
check(
  'an assertion `check(x, "Workspace items")` does not match the body shape',
  fpr.find_reserved_name(['check("shadow name", shadow["name"], "Workspace items")']),
  [],
);

console.log("\n── (d) CLI: shipped tree is green ──");
let [rc, out] = run_cli();
check("shipped configuration exits 0", rc, 0);
check("...and says so", out.includes("✅ check_fixture_project_resolve:"), true);

console.log("\n── (e) CLI: the fixture shape PR #657 fixed, replayed pre-fix, is RED ──");
let root = scratch_tree();
try {
  write(
    root,
    "tests/test_my_items_plant.ts",
    "const projects = await pb(\n" +
      "  base,\n" +
      "  `/api/collections/projects/records?filter=${esc" +
      "(`workspace='${workspaceId}'`)}&perPage=10`,\n" +
      "  { token },\n" +
      ");\n" +
      'firstProjectId = projects.items[0]?.id ?? "";\n',
  );
  [rc, out] = run_cli("--root", root);
  check("pre-fix shape (no shadow clause, items[0] two lines down) exits 1", rc, 1);
  check("...naming the positional-resolve finding", out.includes("[positional-resolve]"), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
check("scratch tree cleaned up", fs.existsSync(root), false);

console.log("\n── (f) CLI: the same shape WITH `&& shadow=false` is GREEN ──");
root = scratch_tree();
try {
  write(
    root,
    "tests/test_my_items_plant.ts",
    "const projects = await pb(\n" +
      "  base,\n" +
      "  `/api/collections/projects/records?filter=${esc" +
      "(`workspace='${workspaceId}' && shadow=false`)}&perPage=10`,\n" +
      "  { token },\n" +
      ");\n" +
      'firstProjectId = projects.items[0]?.id ?? "";\n',
  );
  [rc, out] = run_cli("--root", root);
  check("post-fix shape exits 0", rc, 0);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n── (g) CLI: a fixture literally named the reserved shadow-project name is RED ──");
root = scratch_tree();
try {
  write(root, "tests/test_plant.ts", 'const body = { name: "Workspace items", workspace: ws };\n');
  [rc, out] = run_cli("--root", root);
  check("a create body naming the reserved string exits 1", rc, 1);
  check(
    "...naming the reserved-fixture-name finding",
    out.includes("[reserved-fixture-name]"),
    true,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

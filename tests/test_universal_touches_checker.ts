#!/usr/bin/env bun
/** Unit-pin scripts/check_universal_touches.ts against mutants of a pb_hooks/ copy (no server, no port). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_universal_touches.ts");

let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok)
    console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

/** -> [exit code, stdout] of the checker over a fresh pb_hooks copy that `mutate` edits first. */
function run(mutate: (hooks: string) => void = () => {}): [number, string] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "touches_checker_"));
  try {
    const hooks = path.join(root, "pb_hooks");
    fs.cpSync(path.join(REPO_ROOT, "pb_hooks"), hooks, { recursive: true, dereference: true });
    mutate(hooks);
    const p = Bun.spawnSync([process.execPath, CHECKER, "--root", root], { cwd: root });
    return [p.exitCode ?? 1, p.stdout.toString()];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Replace the first `find` at or after `after` in pb_hooks/`file`; -> the 1-based line of `after`. */
function mutate_after(
  hooks: string,
  file: string,
  after: string,
  find: string,
  put: string,
): number {
  const p = path.join(hooks, file);
  const src = fs.readFileSync(p, "utf8");
  const start = src.indexOf(after);
  const at = start < 0 ? -1 : src.indexOf(find, start);
  check(`mutant applied: ${file} '${find}' after '${after.split("\n")[0]}'`, at >= 0, true);
  if (at >= 0) fs.writeFileSync(p, src.slice(0, at) + put + src.slice(at + find.length));
  return src.slice(0, start).split("\n").length;
}

const COUNT_LINE =
  /^✅ check_universal_touches: (\d+) model-tier update guard\(s\) that throw all read original\(\)$/m;

console.log("════════ test_universal_touches_checker.ts ════════");

console.log("\n── (a) the current pb_hooks/ tree is green ──");
const [rc, out] = run();
const count = Number(out.match(COUNT_LINE)?.[1] ?? 0);
check("exit 0", rc, 0);
check("the count line is printed and counts at least one guard", count > 0, true);

console.log("\n── (b) a throwing update guard with its original() stripped is flagged ──");
let line = 0;
const [rc_b, out_b] = run((hooks) => {
  line = mutate_after(
    hooks,
    "cycles.pb.js",
    'onRecordUpdate((e) => {\n  const cycle = e.record.get("cycle");',
    "e.record.original()",
    "e.record",
  );
});
check("exit 1", rc_b, 1);
check(
  "the offender is named by file:line, verb, collection and handler",
  out_b.includes(`pb_hooks/cycles.pb.js:${line}  onRecordUpdate  tasks  inline`),
  true,
);

console.log("\n── (c) the *Request tier, comments and strings are not model-tier guards ──");
const [rc_c, out_c] = run((hooks) =>
  fs.writeFileSync(
    path.join(hooks, "zz_synthetic.pb.js"),
    'onRecordUpdateRequest((e) => {\n  throw new BadRequestError("no");\n}, "tasks");\n' +
      '// onRecordUpdate((e) => { throw new BadRequestError("prose"); }, "tasks");\n' +
      'const prose = "onRecordUpdate((e) => { throw 1; })";\n',
  ),
);
check("exit 0", rc_c, 0);
check("the guard count is unchanged", Number(out_c.match(COUNT_LINE)?.[1] ?? -1), count);

console.log("\n── (d) a named-function handler is resolved to its declaration ──");
const [rc_d, out_d] = run((hooks) => {
  mutate_after(hooks, "keys.pb.js", "function lockItemKey(e) {", "e.record.original()", "e.record");
});
check("exit 1", rc_d, 1);
const flagged = [
  ...out_d.matchAll(
    /^ {2}pb_hooks\/keys\.pb\.js:(\d+) {2}onRecordUpdate {2}(\w+) {2}lockItemKey$/gm,
  ),
];
check(
  "every lockItemKey registration is flagged, each with its collection",
  flagged.map((m) => m[2]),
  ["tasks", "decisions", "documents", "milestones"],
);
check("...and nothing else is", out_d.trim().split("\n").length, 1 + flagged.length);

console.log("\n── (e) onRecordUpdateExecute is model-tier too ──");
const [rc_e, out_e] = run((hooks) =>
  fs.writeFileSync(
    path.join(hooks, "zz_synthetic.pb.js"),
    'onRecordUpdateExecute((e) => {\n  throw new BadRequestError("no");\n}, "tasks");\n',
  ),
);
check("exit 1", rc_e, 1);
check(
  "the Execute registration is flagged",
  out_e.includes("pb_hooks/zz_synthetic.pb.js:1  onRecordUpdateExecute  tasks  inline"),
  true,
);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

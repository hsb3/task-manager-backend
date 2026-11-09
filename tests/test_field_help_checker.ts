#!/usr/bin/env bun
/** Unit-pin scripts/check_field_help.ts against the real tree and planted migrations (no server, no port). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { offenders } from "../scripts/check_field_help.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const CHECKER = path.join(REPO_ROOT, "scripts", "check_field_help.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`,
  );
}

function cli(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, CHECKER, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() };
}

function planted(opts: string): string {
  return `migrate((app) => {
  const c = app.findCollectionByNameOrId("cycles");
  c.fields.add(new TextField({ id: "text9999999901", name: "planted", required: false${opts} }));
  app.save(c);
}, (app) => {
  const c = app.findCollectionByNameOrId("cycles");
  c.fields.removeById("text9999999901");
  app.save(c);
});
`;
}

/** Copy pb_migrations with a planted migration; return offenders beyond the real tree's, plus the CLI run. */
function with_planted(opts: string, base: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbhelp_"));
  try {
    const mig = path.join(dir, "mig");
    copy_tree(path.join(REPO_ROOT, "pb_migrations"), mig);
    fs.writeFileSync(path.join(mig, "1785199900_planted.js"), planted(opts));
    return {
      extra: offenders(mig).filter((o) => !base.includes(o)),
      run: cli(["--migrations-dir", mig]),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("════════ test_field_help_checker.ts — check_field_help.ts gate pins ════════");

console.log("\n── (a) the real tree is GREEN ──");
const BASE = offenders();
check("real tree: no offenders", BASE.length === 0, JSON.stringify(BASE.slice(0, 5)));
check("real tree: CLI exits 0", cli([]).code === 0);

console.log("\n── (b) a planted field without help ──");
const b = with_planted("", BASE);
check(
  "exactly cycles.planted is added",
  JSON.stringify(b.extra) === '["cycles.planted"]',
  JSON.stringify(b.extra),
);
check("CLI exits 1", b.run.code === 1);
check("CLI names cycles.planted", b.run.out.includes("cycles.planted"));

console.log("\n── (c) a planted field with help ──");
const c = with_planted(', help: "Planted field with help."', BASE);
check("nothing is added", c.extra.length === 0, JSON.stringify(c.extra));

console.log();
if (failures) {
  console.log(`❌ test_field_help_checker: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ test_field_help_checker: every check passed");

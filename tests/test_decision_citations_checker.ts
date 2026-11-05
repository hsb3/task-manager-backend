#!/usr/bin/env bun
/**
 * Proof of scripts/check_decision_citations.ts's accepted-frontier rule. No server, no ports.
 *
 * Fixture repos under /tmp/d1-citefix/ exercise --repo/--register against the highest
 * registered decision number (the frontier): a citation at or below it with no row is RED,
 * above it is GREEN with an informational line, a registered citation is GREEN, and an empty
 * register fails every citation. §5 runs the real checker against the shipped tree; §6 proves
 * --staged reads the index, not the tree copy.
 *
 * A demonstrated RED carries the checker's refusal glyph, and the battery reads a stray one as
 * this suite failing — so every echoed line is quoted with that glyph spelled out instead.
 */

import fs from "node:fs";
import path from "node:path";
import { py_repr, run_checked, splitlines, py_strip } from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_decision_citations.ts");
const SCRATCH = "/tmp/d1-citefix";
const REFUSAL = "❌";

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : REFUSAL}  ${label}`);
  if (!ok) FAILS.push(label);
}

function echo(out: string): void {
  for (const line of splitlines(py_strip(out))) {
    console.log(`    | ${line.replaceAll(REFUSAL, "[refusal glyph]")}`);
  }
}

interface Run {
  returncode: number;
  stdout: string;
  stderr: string;
}

function run(repo_dir: string, register_path: string, ...extra: string[]): Run {
  const r = Bun.spawnSync([
    process.execPath,
    CHECKER,
    "--repo",
    repo_dir,
    "--register",
    register_path,
    ...extra,
  ]);
  return { returncode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function git_init(cwd: string, ...args: string[]): void {
  run_checked(["git", ...args], { cwd });
}

/** A git repo (untracked files satisfy `git grep --untracked`) with a register + a citing file. */
function make_repo(name: string, register_body: string, cite_body: string): [string, string] {
  const repo_dir = path.join(SCRATCH, name);
  fs.rmSync(repo_dir, { recursive: true, force: true });
  fs.mkdirSync(repo_dir, { recursive: true });
  git_init(repo_dir, "init", "-q");
  const register_path = path.join(repo_dir, "register.md");
  fs.writeFileSync(register_path, register_body, "utf-8");
  fs.writeFileSync(path.join(repo_dir, "citing.js"), cite_body, "utf-8");
  return [repo_dir, register_path];
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

console.log("── 1. a citation at or below the frontier with no row → RED, naming file:line ──");
// frontier = 3 (highest registered row); decision-002 has no row of its own.
const [repo1, reg1] = make_repo(
  "below",
  "- **Title:** decision-001: one\n- **Title:** decision-003: three\n",
  "line one\ncites decision-002 here\n",
);
const r1 = run(repo1, reg1);
echo(r1.stdout);
check("exit code is 1", r1.returncode === 1);
check("names citing.js:2", r1.stdout.includes("citing.js:2: decision-002 has no register row"));
check("the refusal carries the refusal glyph", r1.stdout.includes(REFUSAL));

console.log("── 2. a citation above the frontier → GREEN, informational line names it ──");
const [repo2, reg2] = make_repo(
  "above",
  "- **Title:** decision-001: one\n",
  "line one\ncites decision-005 here\n",
);
const r2 = run(repo2, reg2);
echo(r2.stdout);
check("exit code is 0", r2.returncode === 0);
check("carries the pass glyph", r2.stdout.includes("✅"));
check(
  "informational line names citing.js:2 decision-005",
  r2.stdout.includes("citing.js:2: decision-005"),
);
check("informational line carries the ℹ️ glyph", r2.stdout.includes("ℹ️"));
check("a passing run prints no refusal glyph", !r2.stdout.includes(REFUSAL));

console.log("── 3. a citation of a registered decision → GREEN ──");
const [repo3, reg3] = make_repo(
  "registered",
  "- **Title:** decision-001: one\n",
  "cites decision-001 here\n",
);
const r3 = run(repo3, reg3);
echo(r3.stdout);
check("exit code is 0", r3.returncode === 0);
check("no informational line (nothing above the frontier)", !r3.stdout.includes("ℹ️"));
check("carries the pass glyph", r3.stdout.includes("✅"));

console.log("── 4. an empty register → RED, naming the register as empty ──");
const [repo4, reg4] = make_repo("empty", "", "cites decision-001 here\n");
const r4 = run(repo4, reg4);
echo(r4.stdout);
check("exit code is 1", r4.returncode === 1);
check("names the register as empty", r4.stdout.includes("register is empty"));
check("the refusal carries the refusal glyph", r4.stdout.includes(REFUSAL));

console.log("── 5. the shipped tree passes with no arguments ──");
const p5 = Bun.spawnSync([process.execPath, CHECKER], { cwd: REPO_ROOT });
const r5 = { returncode: p5.exitCode ?? -1, stdout: p5.stdout.toString() };
echo(r5.stdout);
check("exit code is 0", r5.returncode === 0);
check("carries the pass glyph", r5.stdout.includes("✅"));

console.log("── 6. --staged judges the index, not the tree copy ──");
const [repo6, reg6] = make_repo(
  "staged",
  "- **Title:** decision-001: one\n- **Title:** decision-003: three\n",
  "cites decision-001 here\n",
);
git_init(repo6, "add", "-A");
fs.writeFileSync(path.join(repo6, "citing.js"), "cites decision-002 here\n", "utf-8");
const r6 = run(repo6, reg6, "--staged");
echo(r6.stdout);
check("a clean staged citation passes though the tree copy cites a hole", r6.returncode === 0);
const r6t = run(repo6, reg6);
check("the same tree without --staged fails (the modes differ)", r6t.returncode === 1);
git_init(repo6, "add", "-A");
fs.writeFileSync(path.join(repo6, "citing.js"), "cites decision-001 here\n", "utf-8");
const r6m = run(repo6, reg6, "--staged");
echo(r6m.stdout);
check("a staged hole fails though the tree copy is clean", r6m.returncode === 1);
check(
  "names the staged line",
  r6m.stdout.includes("citing.js:1: decision-002 has no register row"),
);
fs.appendFileSync(reg6, "- **Title:** decision-002: two\n", "utf-8");
const r6r = run(repo6, reg6, "--staged");
check("--staged reads the register from the index too", r6r.returncode === 1);

console.log(
  "── 7. non-UTF-8, a newline in a path, and a lone CR neither crash nor hide a citation ──",
);
const [repo7, reg7] = make_repo(
  "odd",
  "- **Title:** decision-001: one\n- **Title:** decision-003: three\n",
  "cites decision-001\n",
);
fs.writeFileSync(path.join(repo7, "latin1.txt"), Buffer.from("café decision-001\n", "latin1"));
fs.writeFileSync(path.join(repo7, "new\nline.md"), "cites decision-001\n", "utf-8");
fs.writeFileSync(path.join(repo7, "zz.md"), Buffer.from("x\rdecision-002 behind a lone CR\n"));
const r7 = run(repo7, reg7);
echo(r7.stdout + r7.stderr);
check("the citation behind a lone CR is judged, not lost", r7.returncode === 1);
check("names it on its own line", r7.stdout.includes("zz.md:1: decision-002 has no register row"));

fs.rmSync(SCRATCH, { recursive: true, force: true });

console.log();
if (FAILS.length) {
  console.log(`${REFUSAL} ${FAILS.length} FAILED: ${py_repr(FAILS)}`);
  process.exit(1);
}
console.log("✅ all check_decision_citations frontier proofs passed");
process.exit(0);

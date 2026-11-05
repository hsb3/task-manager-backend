#!/usr/bin/env bun
/**
 * Proof of scripts/check_decision_citations.ts: every `decision:<slug>` citation names a
 * registered decision, and no numbered citation survives outside docs/generated/. No server,
 * no ports; fixture repos live under a fresh mktemp scratch.
 *
 * A demonstrated RED carries the checker's refusal glyph, and the battery reads a stray one as
 * this suite failing — so every echoed line is quoted with that glyph spelled out instead.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, splitlines, py_strip } from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_decision_citations.ts");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "decision-citations-"));
const REFUSAL = "❌";
// Built by concatenation: this file must not itself hold a literal numbered citation.
const NUMBERED = "decision-" + "0" + "42";

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

/** Register rows in the shape scripts/gen_decisions.ts renders them. */
function register(...names: string[]): string {
  return names.map((n) => `## ${n}\n\n- **Slug:** \`decision:${n}\`\n- **Title:** T\n`).join("\n");
}

/** A git repo (untracked files satisfy `git grep --untracked`) with a register + citing files. */
function make_repo(
  name: string,
  register_body: string,
  files: Record<string, string>,
): [string, string] {
  const repo_dir = path.join(SCRATCH, name);
  fs.mkdirSync(repo_dir, { recursive: true });
  git_init(repo_dir, "init", "-q");
  const register_path = path.join(repo_dir, "register.md");
  fs.writeFileSync(register_path, register_body, "utf-8");
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo_dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo_dir, rel), body, "utf-8");
  }
  return [repo_dir, register_path];
}

try {
  console.log("── 1. a citation of a registered slug → GREEN ──");
  const r1 = run(
    ...make_repo("registered", register("alpha", "beta_two"), {
      "citing.js": "cites decision:alpha here\nand (decision:beta_two).\n",
    }),
  );
  echo(r1.stdout);
  check("exit code is 0", r1.returncode === 0);
  // The register's own `Slug:` rows are scanned too: two rows plus two citations.
  check("counts both citations", r1.stdout.includes(" 4 citation(s)"));
  check("carries the pass glyph", r1.stdout.includes("✅"));

  console.log("── 2. a dangling slug → RED, naming path:line:slug ──");
  const r2 = run(
    ...make_repo("dangling", register("alpha"), {
      "citing.js": "line one\ncites decision:ghost here\n",
    }),
  );
  echo(r2.stdout);
  check("exit code is 1", r2.returncode === 1);
  check("names citing.js:2: decision:ghost", r2.stdout.includes("citing.js:2: decision:ghost"));
  check("the refusal carries the refusal glyph", r2.stdout.includes(REFUSAL));

  console.log("── 3. a numbered citation → RED, telling the author to cite the slug ──");
  const r3 = run(
    ...make_repo("numbered", register("alpha"), {
      "citing.js": `cites ${NUMBERED.toUpperCase()} here\n`,
    }),
  );
  echo(r3.stdout);
  check("exit code is 1", r3.returncode === 1);
  check(
    "names citing.js:1 and the number",
    r3.stdout.includes(`citing.js:1: ${NUMBERED.toUpperCase()}`),
  );
  check("says to cite decision:<slug>", r3.stdout.includes("cite decision:<slug>"));

  console.log("── 4. a numbered citation under docs/generated/ → GREEN ──");
  const r4 = run(
    ...make_repo("generated", register("alpha"), {
      "docs/generated/decisions.md": `- **Title:** ${NUMBERED}: old title\n`,
    }),
  );
  echo(r4.stdout);
  check("exit code is 0", r4.returncode === 0);

  console.log("── 5. rule text and bare namespaces are not citations → GREEN ──");
  const r5 = run(
    ...make_repo("not-citations", register("alpha"), {
      "rules.js":
        'rule = "@request.body.decision:isset = false && task.decision:x != 1"\n' +
        "a `decision:` namespace, decision:* rows, decision:<name>, decision: spaced\n" +
        "decision:\n" +
        "decision:ghostX runs into a name char\n",
    }),
  );
  echo(r5.stdout);
  check("exit code is 0", r5.returncode === 0);
  check("counts only the register row", r5.stdout.includes(" 1 citation(s)"));

  console.log("── 6. an empty register → RED for a slug citation, naming the register as empty ──");
  const r6 = run(...make_repo("empty", "", { "citing.js": "cites decision:alpha here\n" }));
  echo(r6.stdout);
  check("exit code is 1", r6.returncode === 1);
  check("names the register as empty", r6.stdout.includes("register is empty"));

  console.log("── 7. --staged judges the index, not the tree copy ──");
  const [repo7, reg7] = make_repo("staged", register("alpha", "gamma"), {
    "citing.js": "cites decision:alpha here\n",
  });
  git_init(repo7, "add", "-A");
  fs.writeFileSync(path.join(repo7, "citing.js"), "cites decision:ghost here\n", "utf-8");
  const r7 = run(repo7, reg7, "--staged");
  echo(r7.stdout);
  check("a clean staged citation passes though the tree copy dangles", r7.returncode === 0);
  check(
    "the same tree without --staged fails (the modes differ)",
    run(repo7, reg7).returncode === 1,
  );
  git_init(repo7, "add", "-A");
  fs.writeFileSync(path.join(repo7, "citing.js"), "cites decision:alpha here\n", "utf-8");
  const r7m = run(repo7, reg7, "--staged");
  echo(r7m.stdout);
  check("a staged dangling slug fails though the tree copy is clean", r7m.returncode === 1);
  check("names the staged line", r7m.stdout.includes("citing.js:1: decision:ghost"));
  fs.appendFileSync(reg7, register("ghost"), "utf-8");
  check(
    "--staged reads the register from the index too",
    run(repo7, reg7, "--staged").returncode === 1,
  );

  console.log("── 8. the exempt fixture files are not scanned; any other path is ──");
  const probe = `decision:probe-one and ${NUMBERED}\n`;
  const r8 = run(
    ...make_repo("exempt", register("alpha"), {
      "tests/test_gen_decisions.ts": probe,
      "tests/test_name_validation.ts": probe,
      "tests/test_decision_citations_checker.ts": probe,
    }),
  );
  echo(r8.stdout);
  check("exit code is 0", r8.returncode === 0);
  const r8n = run(...make_repo("not-exempt", register("alpha"), { "tests/test_other.ts": probe }));
  echo(r8n.stdout);
  check("the same probe in a non-exempt test fails", r8n.returncode === 1);

  console.log(
    "── 9. non-UTF-8, a newline in a path, and a lone CR neither crash nor hide a citation ──",
  );
  const [repo9, reg9] = make_repo("odd", register("alpha"), {
    "citing.js": "cites decision:alpha\n",
    "new\nline.md": "cites decision:alpha\n",
  });
  fs.writeFileSync(path.join(repo9, "latin1.txt"), Buffer.from("café decision:alpha\n", "latin1"));
  fs.writeFileSync(path.join(repo9, "zz.md"), Buffer.from("x\rdecision:ghost behind a lone CR\n"));
  const r9 = run(repo9, reg9);
  echo(r9.stdout + r9.stderr);
  check("the citation behind a lone CR is judged, not lost", r9.returncode === 1);
  check("names it on its own line", r9.stdout.includes("zz.md:1: decision:ghost"));

  console.log("── 10. the shipped tree passes with no arguments ──");
  const p10 = Bun.spawnSync([process.execPath, CHECKER], { cwd: REPO_ROOT });
  echo(p10.stdout.toString());
  check("exit code is 0", p10.exitCode === 0);
  check("carries the pass glyph", p10.stdout.toString().includes("✅"));
} finally {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log();
if (FAILS.length) {
  console.log(`${REFUSAL} ${FAILS.length} FAILED: ${py_repr(FAILS)}`);
  process.exit(1);
}
console.log("✅ all check_decision_citations proofs passed");
process.exit(0);

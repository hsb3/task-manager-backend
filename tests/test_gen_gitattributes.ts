#!/usr/bin/env bun
// Proof of scripts/gen_gitattributes.ts's derivation and its refusals. No server, no ports.
//
// A synthetic repo under /tmp/vfna-fixture/ carries one generator of each discovered shape, so
// the generated patterns can be asserted exactly. Sections 2-3 prove the refusals that ARE the
// completeness guarantee: a generator declaring no recognised output constant, and one whose
// constant cannot be statically resolved, each fail the run instead of being passed over.
// Section 5 runs the shipped tree, where every emitted pattern must match something real.
//
// A demonstrated RED carries the generator's refusal glyph, and the battery reads a stray one as
// this suite failing — so every echoed line is quoted with that glyph spelled out instead.

import fs from "node:fs";
import path from "node:path";
import {
  decode_text,
  print,
  py_repr,
  py_strip,
  read_text,
  splitlines,
  tup,
} from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const GENERATOR = path.join(REPO_ROOT, "scripts", "gen_gitattributes.ts");
// The generator imports these siblings and `typescript`, so the fixture copy needs them too.
const GENERATOR_DEPS = ["_py.ts", "_argparse.ts", "_ts_source.ts"];
const FIXTURE = "/tmp/vfna-fixture";
const REFUSAL = "❌";

const FAILS: string[] = [];

function check(label: string, got: unknown, want: unknown): void {
  const ok = Bun.deepEquals(got, want, true);
  print(`  ${ok ? "✅" : REFUSAL}  ${label}\n        got=${py_repr(got)} want=${py_repr(want)}`);
  if (!ok) {
    FAILS.push(label);
  }
}

function echo(out: string): void {
  for (const line of splitlines(py_strip(out))) {
    print(`    | ${line.replaceAll(REFUSAL, "[refusal glyph]")}`);
  }
}

function write(rel: string, text: string): string {
  const file = path.join(FIXTURE, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

type Run = { returncode: number; stdout: string; stderr: string };

function spawn(argv: string[], cwd?: string): Run {
  const r = Bun.spawnSync(argv, {
    cwd,
    // The fixture sits outside the repo, so `typescript` resolves through NODE_PATH.
    env: { ...process.env, NODE_PATH: path.join(REPO_ROOT, "node_modules") },
  });
  return { returncode: r.exitCode, stdout: decode_text(r.stdout), stderr: decode_text(r.stderr) };
}

function run(...extra: string[]): Run {
  return spawn([process.execPath, path.join(FIXTURE, "scripts", "gen_gitattributes.ts"), ...extra]);
}

function attributes(): string[] {
  return splitlines(read_text(path.join(FIXTURE, ".gitattributes"))).filter(
    (ln) => ln && !ln.startsWith("#"),
  );
}

function build_fixture(): void {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE, "scripts"), { recursive: true });
  fs.copyFileSync(GENERATOR, path.join(FIXTURE, "scripts", "gen_gitattributes.ts"));
  for (const dep of GENERATOR_DEPS) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", dep), path.join(FIXTURE, "scripts", dep));
  }
  write(
    "scripts/gen_alpha.ts",
    'import path from "node:path";\n' +
      "const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));\n" +
      'const OUTPUT = path.join(REPO, "docs", "alpha.md");\n',
  );
  write(
    "scripts/utilities/beta/build.ts",
    'import path from "node:path";\n' +
      "const REPO = path.dirname(path.dirname(path.dirname(path.dirname(path.resolve(import.meta.path)))));\n" +
      'const DEFAULT_OUT = path.join(REPO, "docs", "beta.html");\n' +
      'const SCHEMA_DIR = path.join(REPO, "betadir");\n',
  );
  // HERE-anchored, two hops to the repo root, and a DIRECTORY output.
  write(
    "scripts/model/extract_current.ts",
    'import path from "node:path";\n' +
      "export const HERE = import.meta.dir;\n" +
      'export const REPO = path.resolve(HERE, "..", "..");\n' +
      'export const OUT_DIR = path.join(HERE, "current");\n',
  );
  // A build*.ts sibling anchored on a HERE three hops below the repo root.
  write(
    "scripts/utilities/beta/build_artifact.ts",
    'import path from "node:path";\n' +
      "const HERE = path.dirname(path.resolve(import.meta.path));\n" +
      'const REPO = path.resolve(HERE, "..", "..", "..");\n' +
      'const DEFAULT_OUT = path.join(REPO, "docs", "closure.html");\n',
  );
  // An EXTENSIONLESS file output: the shape a filename-extension guess misreads as a directory.
  write(
    "scripts/gen_epsilon.ts",
    'import path from "node:path";\n' +
      "const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));\n" +
      'const OUTPUT = path.join(REPO, "docs", "CHANGELOG");\n',
  );
  // Anchored on repo_root(), the shape scripts/gen_coverage.ts declares.
  write(
    "scripts/gen_coverage.ts",
    'import path from "node:path";\n' +
      'import { repo_root } from "./_repo_root.ts";\n' +
      "const REPO = repo_root(import.meta.path);\n" +
      'const OUTPUT = path.join(REPO, "docs", "generated", "coverage.md");\n',
  );
}

print("── 1. every discovered generator shape contributes its own declared output ──");

build_fixture();
const r1 = run();
echo(r1.stdout + r1.stderr);
check("generating the fixture exits 0", r1.returncode, 0);
check("patterns derived from every generator shape, plus the self-entry", attributes(), [
  ".gitattributes merge=binary",
  "betadir/** merge=binary",
  "docs/CHANGELOG merge=binary",
  "docs/alpha.md merge=binary",
  "docs/beta.html merge=binary",
  "docs/closure.html merge=binary",
  "docs/generated/coverage.md merge=binary",
  "scripts/model/current/** merge=binary",
]);
check("--check is green right after a write", run("--check").returncode, 0);

print("\n── 2. a generator declaring no recognised output constant fails the run ──");

write(
  "scripts/gen_alpha.ts",
  'import path from "node:path";\n' +
    "const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));\n" +
    'const WHEREVER = path.join(REPO, "docs", "alpha.md");\n',
);
const r2 = run();
echo(r2.stdout + r2.stderr);
check("renaming the output constant exits 1", r2.returncode, 1);
check("the refusal names the generator", r2.stdout.includes("scripts/gen_alpha.ts"), true);
check("the refusal names the constants it looked for", r2.stdout.includes("DEFAULT_OUTPUT"), true);
check(
  "nothing was written over the previous file",
  attributes().includes("docs/alpha.md merge=binary"),
  true,
);

print("\n── 3. an output constant that cannot be statically resolved fails the run ──");

write(
  "scripts/gen_alpha.ts",
  'import path from "node:path";\n' +
    "const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));\n" +
    'const OUTPUT = process.env["SOMEWHERE"];\n',
);
const r3 = run();
echo(r3.stdout + r3.stderr);
check("an unresolvable expression exits 1", r3.returncode, 1);
check(
  "the refusal names the generator and the constant",
  r3.stdout.includes("gen_alpha.ts: OUTPUT"),
  true,
);

print("\n── 4. --check is the drift gate: a one-byte hand-edit is RED, a regen is GREEN ──");

build_fixture();
run();
const attrs_path = path.join(FIXTURE, ".gitattributes");
const original = read_text(attrs_path);
fs.writeFileSync(attrs_path, original.replace("docs/alpha.md", "docs/alphaXmd"));
const r4 = run("--check");
echo(r4.stdout + r4.stderr);
check("a one-byte hand-edit is RED", r4.returncode, 1);
check(
  "the drift line names the missing pattern",
  r4.stdout.includes("+ docs/alpha.md merge=binary"),
  true,
);
check("regenerating turns it GREEN", tup(run().returncode, run("--check").returncode), tup(0, 0));

print("\n── 5. the shipped tree: in sync, and every pattern matches something real ──");

const shipped = spawn([process.execPath, GENERATOR, "--check"]);
echo(shipped.stdout + shipped.stderr);
check("scripts/gen_gitattributes.ts --check on the repo", shipped.returncode, 0);

const lines = splitlines(read_text(path.join(REPO_ROOT, ".gitattributes"))).filter(
  (ln) => ln && !ln.startsWith("#"),
);
check("the shipped file carries patterns", lines.length > 0, true);
check(
  "the HERE-anchored generator is covered",
  lines.filter((ln) => ln.startsWith("scripts/model/current/")),
  ["scripts/model/current/** merge=binary"],
);

const unmatched: string[] = [];
for (const line of lines) {
  const pattern = line.split(" ")[0]!;
  const target = path.join(
    REPO_ROOT,
    pattern.endsWith("/**") ? pattern.slice(0, -"/**".length) : pattern,
  );
  if (!fs.existsSync(target)) {
    unmatched.push(pattern);
  }
}
check("every pattern names a path that exists", unmatched, []);

const attr = spawn(
  [
    "git",
    "check-attr",
    "merge",
    "--",
    "openapi.json",
    "schema/collections.json",
    "scripts/seed.ts",
  ],
  REPO_ROOT,
);
echo(attr.stdout + attr.stderr);
check(
  "git resolves the attribute for a generated file, a generated dir, and ordinary source",
  splitlines(py_strip(attr.stdout)),
  [
    "openapi.json: merge: binary",
    "schema/collections.json: merge: binary",
    "scripts/seed.ts: merge: unspecified",
  ],
);

print("── 8. an extensionless FILE output is a file, not a directory ──");

build_fixture();
const r8 = run();
echo(r8.stdout + r8.stderr);
check("generating the fixture exits 0", r8.returncode, 0);
// `docs/CHANGELOG/**` matches no path at all, so the artifact ships unprotected while --check
// stays green — the pattern and the generator agree with each other and both are wrong.
check(
  "an extensionless output is written as an exact path, never as dir/**",
  attributes().includes("docs/CHANGELOG merge=binary"),
  true,
);
check(
  "no directory pattern was invented for it",
  attributes().includes("docs/CHANGELOG/** merge=binary"),
  false,
);

fs.rmSync(FIXTURE, { recursive: true, force: true });

print();
if (FAILS.length) {
  print(`${REFUSAL} ${FAILS.length} FAILED: ${py_repr(FAILS)}`);
  process.exit(1);
}

print("✅ all gen_gitattributes derivation and refusal proofs passed");

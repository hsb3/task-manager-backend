#!/usr/bin/env bun
// Unit-pin scripts/check_openspec.ts and scripts/openspec_change.ts on scratch copies of the
// shipped openspec/ and docs/readiness/ (no server, no port); the tracked tree is never written.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr } from "../scripts/_py.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import { NO_DELTA, openspec } from "../scripts/check_openspec.ts";
import { change_dirs } from "../scripts/openspec_change.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_openspec.ts");

let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${py_repr(got)}`);
    console.log(`        want: ${py_repr(want)}`);
  }
}

const SCRATCH: string[] = [];

/** A scratch root holding copies of openspec/ (active changes dropped) and docs/readiness/. */
function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-openspec-"));
  SCRATCH.push(root);
  copy_tree(path.join(REPO_ROOT, "openspec"), path.join(root, "openspec"));
  for (const id of fs.readdirSync(path.join(root, "openspec/changes")))
    if (id !== "archive") fs.rmSync(path.join(root, "openspec/changes", id), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"));
  copy_tree(path.join(REPO_ROOT, "docs/readiness"), path.join(root, "docs/readiness"));
  return root;
}

const PROPOSAL =
  "# Proposal\n\n## Why\n\nClients need a stable surface they can rely on across releases.\n\n## What Changes\n\n- A policy.\n";
const SPEC =
  "## Purpose\n\nThe contract version a client reads from the server it calls.\n\n## ADDED Requirements\n\n### Requirement: Versioned contract\nThe server SHALL state its contract version.\n\n#### Scenario: read the version\n- **WHEN** a client calls any route\n- **THEN** the response names the contract version\n";

/** Write change `id` with the given files ({rel: text}); `.openspec.yaml` defaults to one criterion. */
function change(root: string, id: string, files: Record<string, string>): void {
  const dir = path.join(root, "openspec/changes", id);
  const all = {
    ".openspec.yaml": "schema: contract-first\ncreated: 2026-11-10\nx-criteria: [SH-4]\n",
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, "utf-8");
  }
}

function run(root: string): [number, string] {
  const p = Bun.spawnSync([process.execPath, CHECKER, "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return [p.exitCode ?? 1, p.stdout.toString() + p.stderr.toString()];
}

/** [exit, output] of the checker over a fresh scratch holding one change `id` built from `files`. */
function verdict(files: Record<string, string>): [number, string] {
  const root = scratch();
  change(root, "demo", files);
  return run(root);
}

const tracked_before = Bun.spawnSync([
  "git",
  "-C",
  REPO_ROOT,
  "status",
  "--porcelain",
  "openspec",
  "docs",
]).stdout.toString();

console.log("════════ test_openspec_checker.ts — OpenSpec gate unit pins ════════");

console.log("\n── (a) the shipped tree and an empty scratch copy are GREEN ──");
check("shipped tree exits 0", run(REPO_ROOT)[0], 0);
check("scratch with no active change exits 0", run(scratch())[0], 0);

console.log("\n── (b) a proposal alone is in progress, not invalid ──");
{
  const root = scratch();
  change(root, "demo", { "proposal.md": PROPOSAL });
  const [, out] = openspec(root, "validate", "--all", "--strict", "--json", "--no-interactive");
  check(
    "the CLI still refuses a zero-delta change with the message the checker excuses",
    out.includes(NO_DELTA),
    true,
  );
  check("...and the checker passes it (exit 0)", run(root)[0], 0);
}

console.log("\n── (c) artifacts present must follow the schema order ──");
let [code, out] = verdict({
  "proposal.md": PROPOSAL,
  "specs/api/spec.md": SPEC,
  "design.md": "# Design\n",
});
check("design without contract exits 1", code, 1);
check("...naming design.md and contract", /design\.md exists before contract/.test(out), true);
[code] = verdict({
  "proposal.md": PROPOSAL,
  "specs/api/spec.md": SPEC,
  "contract.md": "# Contract\n",
  "design.md": "# Design\n",
});
check("every artifact present exits 0", code, 0);
[code, out] = verdict({
  ".openspec.yaml": "schema: spec-driven\ncreated: 2026-11-10\nx-criteria: [SH-4]\n",
  "proposal.md": PROPOSAL,
});
check("a change on the built-in spec-driven schema exits 1", code, 1);
check("...naming the schema", out.includes("'spec-driven' is not a project schema"), true);

console.log("\n── (d) strict validation still bites once specs exist ──");
[code, out] = verdict({
  "proposal.md": PROPOSAL,
  "specs/api/spec.md":
    "## ADDED Requirements\n\n### Requirement: No scenario\nThe server SHALL do it.\n",
});
check("a requirement without a scenario exits 1", code, 1);
check("...reported as a validate issue on change demo", out.includes("change demo: [ERROR]"), true);

console.log("\n── (e) x-criteria: present, non-empty, defined in docs/readiness/ ──");
[code, out] = verdict({
  ".openspec.yaml": "schema: contract-first\ncreated: 2026-11-10\n",
  "proposal.md": PROPOSAL,
});
check("no x-criteria exits 1", code, 1);
check("...naming x-criteria", out.includes("needs x-criteria"), true);
[code] = verdict({
  ".openspec.yaml": "schema: contract-first\nx-criteria: []\n",
  "proposal.md": PROPOSAL,
});
check("an empty x-criteria exits 1", code, 1);
[code, out] = verdict({
  ".openspec.yaml": "schema: contract-first\nx-criteria: [SH-4, SH-9999]\n",
  "proposal.md": PROPOSAL,
});
check("an undefined id exits 1", code, 1);
check(
  "...naming SH-9999 only",
  [out.includes("SH-9999 is not"), out.includes("SH-4 is not")],
  [true, false],
);
[code] = verdict({
  ".openspec.yaml": "schema: contract-first\nx-criteria: [AC-1, WEB-1, MOB-1, SH-10]\n",
  "proposal.md": PROPOSAL,
});
check("one id from each readiness page exits 0", code, 0);

console.log("\n── (e2) malformed changes fail with a finding, not a crash ──");
{
  const root = scratch();
  change(root, "demo", { "proposal.md": PROPOSAL });
  fs.rmSync(path.join(root, "openspec/changes/demo/.openspec.yaml"));
  [code, out] = run(root);
  check("a change with no .openspec.yaml exits 1", code, 1);
  check("...naming .openspec.yaml", out.includes("change demo: .openspec.yaml unreadable"), true);
}
[code, out] = verdict({ ".openspec.yaml": "schema: [contract-first\n", "proposal.md": PROPOSAL });
check("an unparsable .openspec.yaml exits 1", code, 1);
check(
  "...as a finding, not a stack trace",
  [out.includes("change demo:"), out.includes("TypeError")],
  [true, false],
);
{
  const root = scratch();
  change(root, "Bad_Name", { "proposal.md": PROPOSAL });
  [code, out] = run(root);
  check("a directory name the resolver cannot find exits 1", code, 1);
  check("...naming it", out.includes("change Bad_Name: not a change id"), true);
}
[code] = verdict({
  ".openspec.yaml": "schema: contract-first\nskip_specs: true\nx-criteria: [SH-4]\n",
  "proposal.md": PROPOSAL,
  "contract.md": "# Contract\n",
  "design.md": "# Design\n",
});
check("skip_specs with contract and design exits 0 (specs skipped satisfies the order)", code, 0);

console.log("\n── (f) archive keeps x-criteria; the resolver finds active and archived changes ──");
{
  const root = scratch();
  change(root, "demo", {
    "proposal.md": PROPOSAL,
    "specs/api/spec.md": SPEC,
    "contract.md": "# Contract\n",
    "design.md": "# Design\n",
  });
  check("resolves the active change", change_dirs(root, "demo"), ["openspec/changes/demo"]);
  const [ac] = openspec(root, "archive", "demo", "-y");
  check("openspec archive exits 0 with no tasks artifact", ac, 0);
  const dirs = change_dirs(root, "demo");
  check(
    "resolves the archived change, date prefix stripped",
    dirs.length === 1 && /^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-demo$/.test(dirs[0]),
    true,
  );
  const meta = Bun.YAML.parse(
    fs.readFileSync(path.join(root, dirs[0], ".openspec.yaml"), "utf8"),
  ) as any;
  check("x-criteria survives archive", meta["x-criteria"], ["SH-4"]);
  check(
    "archive wrote the delta into openspec/specs/",
    fs.existsSync(path.join(root, "openspec/specs/api/spec.md")),
    true,
  );
  fs.mkdirSync(path.join(root, "openspec/changes/archive/demo"));
  check("an archive dir without a date prefix is not a match", change_dirs(root, "demo").length, 1);
  check("an unknown id resolves to nothing", change_dirs(root, "nope"), []);
  check("'archive' is not a change id", change_dirs(root, "archive"), []);
  check("a path is not a change id", change_dirs(root, "../demo"), []);
  check("the checker stays GREEN after archive", run(root)[0], 0);
}

for (const d of SCRATCH) fs.rmSync(d, { recursive: true, force: true });
check(
  "the tracked openspec/ and docs/ are untouched",
  Bun.spawnSync([
    "git",
    "-C",
    REPO_ROOT,
    "status",
    "--porcelain",
    "openspec",
    "docs",
  ]).stdout.toString(),
  tracked_before,
);

console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all checks passed");
process.exit(failures ? 1 : 0);

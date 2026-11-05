#!/usr/bin/env bun
/**
 * Self-check for scripts/check_historical_migrations.ts: the shared implementation behind
 * both the PreToolUse hook (protect_historical_migrations) and lefthook.yml's pre-commit staged
 * guard. No PocketBase server; every fixture is a throwaway git repo in fs.mkdtempSync().
 * There is no test_hook.ts beside the Claude hook - this file is that self-check, for both
 * modes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, py_strip, read_text, run_checked, splitlines } from "../scripts/_py.ts";
import * as shipped from "../scripts/check_historical_migrations.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const SCRIPTS = path.join(REPO_ROOT, "scripts");
const CHECKER = path.join(SCRIPTS, "check_historical_migrations.ts");

const HOOK = path.join(REPO_ROOT, ".claude", "hooks", "protect_historical_migrations", "hook.sh");
const MARKER = "1785150000_settings.js";
const VARIANTS = fs.mkdtempSync(path.join(os.tmpdir(), "histguard_variants_"));
let failures = 0;

/** Writes the checker source beside the helpers it imports, so it runs from any directory. */
function install_checker(dir: string, src: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const helper of ["_py.ts", "_argparse.ts"]) {
    fs.copyFileSync(path.join(SCRIPTS, helper), path.join(dir, helper));
  }
  const file = path.join(dir, "check_historical_migrations.ts");
  fs.writeFileSync(file, src);
  return file;
}

/**
 * A copy of the checker with BASELINE_REBUILD_SUSPENSION pinned: decision:project-items-membership-denormalised's suspension
 * is a source edit by design, so reaching a state under test means rewriting the constant.
 */
function checker_with_constant(value: string | null): string {
  const src = read_text(CHECKER);
  const decls = src
    .split("\n")
    .filter((ln) => ln.startsWith("export const BASELINE_REBUILD_SUSPENSION"));
  if (decls.length !== 1) {
    throw new Error(`expected one BASELINE_REBUILD_SUSPENSION declaration, got ${py_repr(decls)}`);
  }
  return install_checker(
    path.join(VARIANTS, value || "armed"),
    src.replace(
      decls[0]!,
      `export const BASELINE_REBUILD_SUSPENSION: string | null = ${JSON.stringify(value)};`,
    ),
  );
}

const ARMED = checker_with_constant(null);
const SUSPENDED = checker_with_constant(MARKER);

function check(label: string, got: any, want: any): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "MISMATCH"}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${py_repr(got)}`);
    console.log(`        want: ${py_repr(want)}`);
  }
}

type Run = { returncode: number; stdout: string; stderr: string };

function run_checker(
  args: string[],
  stdin: string | null = null,
  cwd: string | null = null,
  script: string | null = null,
): Run {
  const proc = Bun.spawnSync([process.execPath, script || ARMED, ...args], {
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    cwd: cwd ?? undefined,
  });
  return {
    returncode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function run_hook(payload: any, cwd: string | null = null): Run {
  const proc = Bun.spawnSync(["bash", HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    cwd: cwd ?? undefined,
  });
  return {
    returncode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function run_git_cmd(argv: string[], cwd: string | null): void {
  run_checked(argv, cwd === null ? { capture_output: true } : { capture_output: true, cwd });
}

const HIST_ORIGINAL =
  "// original migration body\n" +
  "migrate((app) => {\n" +
  '  const c = app.findCollectionByNameOrId("tasks")\n' +
  "  return app.save(c)\n" +
  "})\n";

/**
 * A one-commit repo whose branch is named main with pb_migrations/<hist>.js already
 * historical: resolve_ref() falls back to main when no origin/main exists, matching hook.sh.
 * `marker` seeds the suspension's expiry marker; `checker` is the variant hook.sh delegates to.
 * A `branch` other than main leaves resolve_ref() with nothing to resolve.
 */
function make_repo(
  checker: string | null = null,
  marker = false,
  branch = "main",
): [string, string] {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "histguard_"));
  run_git_cmd(["git", "init", "-q", "-b", branch, repo], null);
  run_git_cmd(["git", "config", "user.email", "probe@example.com"], repo);
  run_git_cmd(["git", "config", "user.name", "probe"], repo);
  fs.mkdirSync(path.join(repo, "pb_migrations"));
  const hist_path = path.join(repo, "pb_migrations", "1785099999_hist.js");
  fs.writeFileSync(hist_path, HIST_ORIGINAL);
  if (marker) {
    fs.writeFileSync(path.join(repo, "pb_migrations", MARKER), "migrate((app) => { return })\n");
  }
  // hook.sh resolves the checker as <its own repo's toplevel>/scripts/... — a repo-shaped
  // fixture needs that path to exist too, or delegation fails closed for the wrong reason.
  install_checker(path.join(repo, "scripts"), read_text(checker || ARMED));
  run_git_cmd(["git", "add", "-A"], repo);
  run_git_cmd(["git", "commit", "-q", "-m", "seed historical migration"], repo);
  return [repo, hist_path];
}

function stage_all(repo: string): void {
  run_git_cmd(["git", "add", "-A"], repo);
}

function hard_reset(repo: string): void {
  run_git_cmd(["git", "reset", "-q", "--hard"], repo);
  run_git_cmd(["git", "clean", "-q", "-fd", "pb_migrations"], repo);
}

console.log("==== test_historical_migration_guard.ts: shared script + hook.sh self-check ====");

console.log("\n-- (a) --tool-input: comment-only Edit is allowed --");
let proc = run_checker(
  ["--tool-input"],
  JSON.stringify({
    tool_name: "Edit",
    tool_input: { old_string: "// old comment", new_string: "// new comment, fixed" },
  }),
);
check("exit code", proc.returncode, 0);
// The allow is SILENT under ARMED, or a permitted comment correction prints a banner on every
// run forever; only SUSPENDED and EXPIRED have something to say.
check("an ARMED allow prints nothing", [proc.stdout, proc.stderr], ["", ""]);

console.log("\n-- (b) --tool-input: mixed comment+behaviour Edit is refused --");
proc = run_checker(
  ["--tool-input"],
  JSON.stringify({
    tool_name: "Edit",
    tool_input: {
      old_string: '  const c = app.findCollectionByNameOrId("tasks")',
      new_string:
        "  // now also touches behaviour\n" +
        '  const c = app.findCollectionByNameOrId("tasks_v2")',
    },
  }),
);
check("exit code", proc.returncode, 1);

console.log("\n-- (c) --tool-input: identical old/new (no-op) Edit is refused --");
proc = run_checker(
  ["--tool-input"],
  JSON.stringify({ tool_name: "Edit", tool_input: { old_string: "// x", new_string: "// x" } }),
);
check("exit code", proc.returncode, 1);

console.log("\n-- (d) --tool-input: a whole-file Write is refused outright --");
proc = run_checker(
  ["--tool-input"],
  JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: "x", content: "// only comments\n" },
  }),
);
check("exit code", proc.returncode, 1);
let [repo, hist_path] = make_repo();

console.log("\n-- (e) --staged: a comment-only staged change is allowed --");
fs.writeFileSync(
  hist_path,
  HIST_ORIGINAL.replace("// original migration body", "// corrected: was misleading"),
);
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 0);
hard_reset(repo);

console.log("\n-- (f) --staged: a behaviour change to a historical migration is refused --");
fs.writeFileSync(hist_path, HIST_ORIGINAL.replace('"tasks"', '"tasks_v2"'));
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 1);
check("names the offending file", proc.stdout.includes("1785099999_hist.js"), true);
hard_reset(repo);

console.log("\n-- (g) --staged: deleting a historical migration is refused --");
fs.rmSync(hist_path);
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 1);
check("names it deleted", proc.stdout.includes("deleted"), true);
hard_reset(repo);
console.log("\n-- (h) --staged: renaming a historical migration is refused --");
fs.renameSync(hist_path, path.join(repo, "pb_migrations", "1785099999_hist_renamed.js"));
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 1);
check("names it renamed", proc.stdout.includes("renamed"), true);
hard_reset(repo);

console.log("\n-- (i) --staged: a brand-new (non-historical) migration is untouched --");
const new_path = path.join(repo, "pb_migrations", "1785099998_new.js");
fs.writeFileSync(new_path, "migrate((app) => { return })\n");
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 0);
hard_reset(repo);

console.log(
  "\n-- (i2) --staged: a branch behind main reads none of main's newer migrations as deleted --",
);
run_git_cmd(["git", "branch", "behind"], repo);
const newer = path.join(repo, "pb_migrations", "1785099997_newer_on_main.js");
fs.writeFileSync(newer, "migrate((app) => { return })\n");
stage_all(repo);
run_git_cmd(["git", "commit", "-q", "-m", "main moves on"], repo);
run_git_cmd(["git", "checkout", "-q", "behind"], repo);
fs.writeFileSync(
  path.join(repo, "pb_migrations", "1785099996_lane.js"),
  "migrate((app) => { return app })\n",
);
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 0);
check(
  "no false delete or rename",
  proc.stdout.includes("deleted") || proc.stdout.includes("renamed"),
  false,
);
hard_reset(repo);
fs.rmSync(hist_path);
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("a real delete on the behind branch is still refused", proc.returncode, 1);
hard_reset(repo);

console.log("\n-- (i3) --staged: main's newer migration, merged in then edited, is refused --");
run_git_cmd(["git", "merge", "-q", "--no-edit", "main"], repo);
fs.writeFileSync(newer, "migrate((app) => { return 1 })\n");
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 1);
check("names the edited file", proc.stdout.includes("1785099997_newer_on_main.js"), true);
hard_reset(repo);

console.log("\n-- (i4) --staged: a delete that reached HEAD unchecked is still refused later --");
fs.rmSync(newer);
stage_all(repo);
run_git_cmd(["git", "commit", "-q", "--no-verify", "-m", "delete slipped in"], repo);
fs.writeFileSync(
  path.join(repo, "pb_migrations", "1785099995_later.js"),
  "migrate((app) => { return 2 })\n",
);
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 1);
check("names it deleted", proc.stdout.includes("deleted"), true);
hard_reset(repo);

console.log(
  "\n-- (i5) --staged: a lane migration squash-landed on main, then edited here, is refused --",
);
run_git_cmd(["git", "checkout", "-q", "-b", "squashed", "main"], repo);
run_git_cmd(["git", "reset", "-q", "--hard", "HEAD~1"], repo);
const lane = path.join(repo, "pb_migrations", "1785099994_lane_landed.js");
fs.writeFileSync(lane, "migrate((app) => { return 3 })\n");
stage_all(repo);
run_git_cmd(["git", "commit", "-q", "-m", "lane work"], repo);
run_git_cmd(["git", "checkout", "-q", "main"], repo);
fs.writeFileSync(lane, "migrate((app) => { return 3 })\n");
stage_all(repo);
run_git_cmd(["git", "commit", "-q", "-m", "squash of lane work"], repo);
run_git_cmd(["git", "checkout", "-q", "squashed"], repo);
fs.writeFileSync(lane, "migrate((app) => { return 4 })\n");
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("exit code", proc.returncode, 1);
check("names the edited file", proc.stdout.includes("1785099994_lane_landed.js"), true);
hard_reset(repo);
fs.rmSync(lane);
stage_all(repo);
proc = run_checker(["--staged"], null, repo);
check("deleting it after main landed it is refused", proc.returncode, 1);
hard_reset(repo);
run_git_cmd(["git", "checkout", "-q", "main"], repo);

console.log("\n-- (j) hook.sh: comment-only Edit on the historical file exits 0 --");
proc = run_hook({
  tool_name: "Edit",
  tool_input: {
    file_path: hist_path,
    old_string: "// original migration body",
    new_string: "// corrected wording",
  },
});
check("exit code", proc.returncode, 0);
console.log("\n-- (k) hook.sh: mixed comment+behaviour Edit exits 2 with the blocked message --");
proc = run_hook({
  tool_name: "Edit",
  tool_input: {
    file_path: hist_path,
    old_string: '  const c = app.findCollectionByNameOrId("tasks")',
    new_string: '  const c = app.findCollectionByNameOrId("tasks_v2")',
  },
});
check("exit code", proc.returncode, 2);
check(
  "blocked message on stderr",
  proc.stderr.includes("historical migrations are never edited"),
  true,
);
console.log("\n-- (l) hook.sh: a Write on the historical file exits 2 --");
proc = run_hook({
  tool_name: "Write",
  tool_input: { file_path: hist_path, content: "// only comments\n" },
});
check("exit code", proc.returncode, 2);
check(
  "blocked message on stderr",
  proc.stderr.includes("historical migrations are never edited"),
  true,
);

console.log(
  "\n-- (m) decision:project-items-membership-denormalised suspension: SUSPENDED / EXPIRED / ARMED across both modes --",
);
const [sus_repo, sus_hist] = make_repo(SUSPENDED, true);
const behaviour_edit = {
  tool_name: "Edit",
  tool_input: {
    file_path: sus_hist,
    old_string: '  const c = app.findCollectionByNameOrId("tasks")',
    new_string: '  const c = app.findCollectionByNameOrId("tasks_v2")',
  },
};
const comment_change = HIST_ORIGINAL.replace(
  "// original migration body",
  "// corrected: was misleading",
);

console.log("   SUSPENDED (marker still on the ref): both modes allow, hook.sh follows");
proc = run_hook(behaviour_edit, sus_repo);
check("hook.sh: behaviour Edit exits 0", proc.returncode, 0);
// stdout, not stderr: the harness may swallow stderr on a success, and this allow is not silent.
check(
  "hook.sh: announces the allow on stdout",
  proc.stdout.includes("decision:project-items-membership-denormalised"),
  true,
);
proc = run_checker(["--tool-input"], JSON.stringify(behaviour_edit), sus_repo, SUSPENDED);
check("--tool-input: behaviour Edit exits 0", proc.returncode, 0);
check(
  "banner names decision:project-items-membership-denormalised",
  proc.stdout.includes("decision:project-items-membership-denormalised"),
  true,
);
check("banner names card dzdh", proc.stdout.includes("dzdh"), true);
check("banner is one line", splitlines(py_strip(proc.stdout)).length, 1);
fs.rmSync(sus_hist);
stage_all(sus_repo);
proc = run_checker(["--staged"], null, sus_repo, SUSPENDED);
check("--staged: deleting a historical migration exits 0", proc.returncode, 0);
check(
  "banner names decision:project-items-membership-denormalised",
  proc.stdout.includes("decision:project-items-membership-denormalised"),
  true,
);
hard_reset(sus_repo);

console.log("   EXPIRED (the rebuild dropped the marker from the ref): both modes refuse");
fs.rmSync(path.join(sus_repo, "pb_migrations", MARKER));
stage_all(sus_repo);
run_git_cmd(["git", "commit", "-q", "-m", "one-baseline rebuild lands"], sus_repo);
proc = run_checker(["--tool-input"], JSON.stringify(behaviour_edit), sus_repo, SUSPENDED);
check("--tool-input exits 1", proc.returncode, 1);
check("says the rebuild landed", proc.stdout.includes("the baseline rebuild has landed"), true);
check("names the re-arm edit", proc.stdout.includes("BASELINE_REBUILD_SUSPENSION = null"), true);
proc = run_hook(behaviour_edit, sus_repo);
check("hook.sh: exits 2", proc.returncode, 2);
fs.writeFileSync(sus_hist, comment_change);
stage_all(sus_repo);
proc = run_checker(["--staged"], null, sus_repo, SUSPENDED);
check("--staged: even a comment-only change exits 1", proc.returncode, 1);
check("names the re-arm edit", proc.stdout.includes("BASELINE_REBUILD_SUSPENSION = null"), true);

console.log("   ARMED (constant back to null): today's behaviour, marker or no marker");
proc = run_checker(["--staged"], null, sus_repo, ARMED);
check("--staged: comment-only change exits 0", proc.returncode, 0);
check("--staged: that allow prints nothing", [proc.stdout, proc.stderr], ["", ""]);
hard_reset(sus_repo);
fs.rmSync(sus_hist);
stage_all(sus_repo);
proc = run_checker(["--staged"], null, sus_repo, ARMED);
check("--staged: delete exits 1", proc.returncode, 1);
check("names it deleted", proc.stdout.includes("deleted"), true);
hard_reset(sus_repo);
proc = run_checker(["--tool-input"], JSON.stringify(behaviour_edit), sus_repo, ARMED);
check("--tool-input: behaviour Edit exits 1", proc.returncode, 1);

console.log("\n-- (m2) an unresolvable comparison ref reads as still-SUSPENDED, never EXPIRED --");
// marker_on_ref()'s `ref === null ||` clause: no ref cannot PROVE the rebuild landed, so the
// suspension holds. Drop the clause and this repo reports EXPIRED and refuses.
const [noref_repo, noref_hist] = make_repo(SUSPENDED, true, "lane");
check("the fixture really has no origin/main or main", shipped.resolve_ref(noref_repo), null);
fs.writeFileSync(noref_hist, comment_change);
stage_all(noref_repo);
proc = run_checker(["--staged"], null, noref_repo, SUSPENDED);
check("--staged exits 0", proc.returncode, 0);
check(
  "banner is the SUSPENDED one",
  proc.stdout.includes("decision:project-items-membership-denormalised"),
  true,
);
check("not the EXPIRED one", proc.stdout.includes("the baseline rebuild has landed"), false);
hard_reset(noref_repo);

console.log("\n-- (n) the SHIPPED constant, read live against this repo --");
// decision:project-items-membership-denormalised: SUSPENDED is the long green window and EXPIRED is the alarm, red only between
// the rebuild landing on the comparison ref and the re-arm PR setting the constant to null.
const live_state = shipped.suspension_state(shipped.marker_on_ref(REPO_ROOT));
check(
  `live state of BASELINE_REBUILD_SUSPENSION=${py_repr(shipped.BASELINE_REBUILD_SUSPENSION)}`,
  live_state,
  shipped.BASELINE_REBUILD_SUSPENSION === null ? "ARMED" : "SUSPENDED",
);
const [no_marker_repo] = make_repo();
check(
  "the live predicate is not stuck on SUSPENDED: a ref without the marker never reads it",
  shipped.suspension_state(shipped.marker_on_ref(no_marker_repo)) !== "SUSPENDED",
  true,
);

/**
 * True when pb_migrations/<marker> in the worktree is NOT the ref's file.
 *
 * A rebuilt baseline that re-created the marker's FILENAME would keep marker_on_ref() true
 * forever: the state could never reach EXPIRED and the tripwire above would be vacuous.
 *
 * Bounds, both real. With no comparison ref there is nothing to impersonate, so that reads
 * False. And this fires PRE-MERGE only: it compares the worktree against the ref, so once a
 * namesake is merged the two are equal and a byte-identical one is never caught again. What
 * still holds the line is that either case needs a red merge to get there -- the live state
 * check below reads the shipped constant against this repo on every run.
 */
function marker_impersonated(repo: string, marker: string | null): boolean {
  if (marker === null) return false;
  const file = path.join(repo, "pb_migrations", marker);
  if (!fs.existsSync(file)) return false;
  const ref = shipped.resolve_ref(repo);
  if (ref === null) return false;
  const on_ref = Bun.spawnSync(["git", "-C", repo, "show", `${ref}:pb_migrations/${marker}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return on_ref.exitCode !== 0 || !Buffer.from(on_ref.stdout).equals(fs.readFileSync(file));
}

check(
  "the marker in this tree is the ref's own file, not a rebuilt namesake",
  marker_impersonated(REPO_ROOT, shipped.BASELINE_REBUILD_SUSPENSION),
  false,
);
const [collision_repo] = make_repo(null, true);
fs.writeFileSync(
  path.join(collision_repo, "pb_migrations", MARKER),
  "migrate((app) => { return 'a rebuilt baseline that reused the name' })\n",
);
check(
  "a namesake with different bytes IS caught",
  marker_impersonated(collision_repo, MARKER),
  true,
);

for (const dir of [repo, sus_repo, noref_repo, no_marker_repo, collision_repo, VARIANTS]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`FAIL - ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("PASS - all checks matched");
process.exit(0);

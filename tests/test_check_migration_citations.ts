#!/usr/bin/env bun
/**
 * Proof of scripts/check_migration_citations.ts's versioned-citation rule. No server, no ports.
 *
 * Fixture git repos under a mkdtemp scratch (never a fixed path — two lanes or two CI shards
 * share /tmp) carry their own pb_migrations/ set and their own migrations-v1 tag, so every
 * verdict is about the fixture and never about this checkout: a bare citation is RED wherever it
 * sits in a sentence, .jsx/.json are not migration names at all, the same site prefixed v1:/v2:
 * resolves or does not, the literal git-show form reads as v1 while a sha-ref form does not, a
 * filename that is a quoted string's whole content is exempt, and pb_migrations/ plus
 * docs/generated/ are skipped, an artifact .gitattributes marks generated is skipped while a
 * sibling sharing its path prefix is not. Each refusal is also read for the spelling it OFFERS: a suggestion
 * that would itself be refused is a defect. §12-§14 pin the fail-closed paths (absent tag, moved
 * filename shape) and read the SHIPPED tree's tag and migration set, so the fixtures cannot be
 * the only thing this suite ever proves.
 *
 * A demonstrated RED carries the checker's refusal glyph, and the battery reads a stray one as
 * this suite failing — so every echoed line is quoted with that glyph spelled out instead.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cmc from "../scripts/check_migration_citations.ts";
import { decode_text, py_repr, py_strip, splitlines } from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_migration_citations.ts");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "v10c-migcite-"));
const REFUSAL = "❌";

// Every name below is the WHOLE content of its quoted string, so the shipped checker exempts
// this file's own constants; each citation under test is built by interpolation instead.
const V1_ONLY = "1785150000_settings.js";
const V1_ALSO = "1785152200_tasks_vocab.js";
const V2_ONLY = "1785185200_collections.js";
const GHOST = "1785999999_not_a_real_migration.js";

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

function run(root: string): Run {
  const r = Bun.spawnSync([process.execPath, CHECKER, "--root", root]);
  return {
    returncode: r.exitCode ?? -1,
    stdout: decode_text(r.stdout),
    stderr: decode_text(r.stderr),
  };
}

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf-8");
}

function git(root: string, ...argv: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", root, ...argv]);
  if (proc.exitCode !== 0) {
    throw new Error(`git ${py_repr(argv)} failed in ${root}: ${decode_text(proc.stderr)}`);
  }
}

/** A repo whose v1 set is tagged and then replaced by `current`, plus the scanned `files`. */
function make_repo(
  name: string,
  files: Record<string, string> | null = null,
  current: string[] = [V2_ONLY],
  tag = true,
): string {
  const root = path.join(SCRATCH, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "probe@example.com");
  git(root, "config", "user.name", "probe");
  for (const old of [V1_ONLY, V1_ALSO]) {
    write(root, `pb_migrations/${old}`, "// v1 migration\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "v1 set");
  if (tag) git(root, "tag", "migrations-v1");
  fs.rmSync(path.join(root, "pb_migrations"), { recursive: true, force: true });
  for (const added of current) {
    write(root, `pb_migrations/${added}`, "// v2 migration\n");
  }
  for (const [rel, body] of Object.entries(files ?? {})) {
    write(root, rel, body);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "v2 set");
  return root;
}

function proofs(): void {
  console.log("── 1. a bare migration citation → RED, naming the file and the line ──");
  const r1 = run(
    make_repo("bare", { "cite.md": `Intro line.\nThe rule lands in ${V1_ONLY} today.\n` }),
  );
  echo(r1.stdout);
  check("exit code is 1", r1.returncode === 1);
  check("names cite.md:2", r1.stdout.includes(`cite.md:2: bare migration citation '${V1_ONLY}'`));
  check("the refusal carries the refusal glyph", r1.stdout.includes(REFUSAL));

  console.log("── 1b. a bare citation that ENDS a sentence is caught, not skipped by the guard ──");
  // The trailing guard used to exclude `.` and `-`, so the commonest shape in prose —
  // a citation with punctuation glued to it — was invisible to the whole gate.
  const punctuated =
    `The backfill lives in ${V1_ONLY}.\n` +
    `Dropped by ${V1_ONLY}...\n` +
    `See ${V1_ONLY}-ish for the shape.\n` +
    `Inside parentheses (${V1_ONLY}) too.\n` +
    `Quoted with trailing prose: "${V1_ONLY} and more".\n`;
  const r1b = run(make_repo("punctuated", { "prose.md": punctuated }));
  echo(r1b.stdout);
  check("exit code is 1", r1b.returncode === 1);
  for (const [lineno, shape] of [
    [1, "a full stop"],
    [2, "an ellipsis"],
    [3, "a hyphen"],
    [4, "a paren"],
  ] as const) {
    check(
      `prose.md:${lineno} — a citation followed by ${shape} is caught`,
      r1b.stdout.includes(`prose.md:${lineno}: bare migration citation '${V1_ONLY}'`),
    );
  }
  check(
    "all five lines are reported",
    r1b.stdout.split("bare migration citation").length - 1 === 5,
  );

  console.log("── 1c. .jsx and .json are not migration filenames and must not match at all ──");
  const siblings =
    `A component at ${V1_ONLY}x here.\n` +
    `A config at ${V1_ONLY}on here.\n` +
    `And ${V1_ONLY}onc for good measure.\n`;
  const r1c = run(make_repo("siblings", { "web.md": siblings }));
  echo(r1c.stdout);
  check("exit code is 0", r1c.returncode === 0);
  check(
    "nothing was counted as a citation",
    r1c.stdout.includes("0 versioned citation(s) resolve"),
  );
  check(
    "...and nothing was counted as an exemption",
    r1c.stdout.includes("0 filename(s) exempted"),
  );
  check("...over a file that really was scanned", r1c.stdout.includes("1 tracked file(s) scanned"));

  console.log("── 1d. a VERSIONED citation ending a sentence is counted, not skipped ──");
  const r1d = run(
    make_repo("versioned-punct", { "c.js": `// seeded by v2:pb_migrations/${V2_ONLY}.\n` }),
  );
  echo(r1d.stdout);
  check("exit code is 0", r1d.returncode === 0);
  check("it resolves as a v2 citation", r1d.stdout.includes("1 v2 on disk"));

  console.log("── 2. the same site prefixed v1: → GREEN ──");
  const r2 = run(
    make_repo("v1ok", { "cite.md": `Intro.\nThe rule lands in v1:${V1_ONLY} today.\n` }),
  );
  echo(r2.stdout);
  check("exit code is 0", r2.returncode === 0);
  check(
    "counted as one v1 citation resolved",
    r2.stdout.includes("1 v1 via the migrations-v1 tag"),
  );
  check("a passing run prints no refusal glyph", !r2.stdout.includes(REFUSAL));

  console.log("── 3. v2: naming a file in the CURRENT set → GREEN ──");
  const r3 = run(make_repo("v2ok", { "cite.md": `Seeded by v2:${V2_ONLY} on boot.\n` }));
  echo(r3.stdout);
  check("exit code is 0", r3.returncode === 0);
  check("counted as one v2 citation resolved", r3.stdout.includes("1 v2 on disk"));

  console.log(
    "── 4. v2: naming a file NOT on disk → RED, offering the spelling that DOES resolve ──",
  );
  const r4 = run(make_repo("v2miss", { "cite.md": `Seeded by v2:${V1_ONLY} on boot.\n` }));
  echo(r4.stdout);
  check("exit code is 1", r4.returncode === 1);
  check(
    "names the missing path, not a bare-citation error",
    r4.stdout.includes(`cite.md:1: v2:${V1_ONLY} does not exist at pb_migrations/${V1_ONLY}`),
  );
  check("it IS in the tag, so v1 is offered", r4.stdout.includes(`write v1:${V1_ONLY}`));

  console.log("── 4b. v2: naming a file in NEITHER set → RED, and offers no spelling at all ──");
  const r4b = run(make_repo("v2ghost", { "cite.md": `Seeded by v2:${GHOST} on boot.\n` }));
  echo(r4b.stdout);
  check("exit code is 1", r4b.returncode === 1);
  check(
    "says the tag does not hold it either",
    r4b.stdout.includes("is not in the migrations-v1 tag either"),
  );
  check(
    "...and suggests no v1 spelling that would re-fail",
    !r4b.stdout.includes(`write v1:${GHOST}`),
  );

  console.log("── 5. v1: naming a file absent from the tagged tree → RED ──");
  const r5 = run(make_repo("v1miss", { "cite.md": `Superseded by v1:${GHOST} back then.\n` }));
  echo(r5.stdout);
  check("exit code is 1", r5.returncode === 1);
  check(
    "names the tag it does not resolve against",
    r5.stdout.includes(`cite.md:1: v1:${GHOST} is not in the migrations-v1 tag`),
  );
  check(
    "...and suggests no v2 spelling that would re-fail",
    !r5.stdout.includes(`write v2:${GHOST}`),
  );
  const r5b = run(
    make_repo("v1wrongset", { "cite.md": `Superseded by v1:${V2_ONLY} back then.\n` }),
  );
  echo(r5b.stdout);
  check(
    "a v1: citation of a CURRENT file is told to write v2",
    r5b.stdout.includes(`write v2:${V2_ONLY}`),
  );

  console.log("── 6. the literal git-show form reads as a v1 citation → GREEN ──");
  const shown = `migrations-v1:pb_migrations/${V1_ALSO}`;
  const r6 = run(make_repo("gitshow", { "cite.md": `Read it with: git show ${shown}\n` }));
  echo(r6.stdout);
  check("exit code is 0", r6.returncode === 0);
  check(
    "counted as a v1 citation, not a bare one",
    r6.stdout.includes("1 v1 via the migrations-v1 tag"),
  );

  console.log("── 6b. a SHA-ref git argument is refused, and the refusal says what was written ──");
  const sha_form = `git show 3b5e1d84^:pb_migrations/${V1_ALSO}`;
  const r6b = run(make_repo("gitshowsha", { "cite.md": `Read it with: ${sha_form}\n` }));
  echo(r6b.stdout);
  check("exit code is 1", r6b.returncode === 1);
  check(
    "the refusal names the <ref> form, not just 'bare'",
    r6b.stdout.includes("git argument, not prose"),
  );
  check(
    "...and directs the author at the tag",
    r6b.stdout.includes(`name the tagged set with migrations-v1:pb_migrations/${V1_ALSO}`),
  );

  console.log(
    "── 7. a bare filename that is a quoted string's WHOLE content is a functional value ──",
  );
  const quoted = {
    "guard.ts": `MARKER = "${V1_ONLY}"\n`,
    "room.ts": `const PLANTED = '${V1_ONLY}';\n`,
    "seed.ts": `OUT = os.path.join(REPO, "pb_migrations", "${V2_ONLY}")\n`,
  };
  const r7 = run(make_repo("functional", quoted));
  echo(r7.stdout);
  check("exit code is 0", r7.returncode === 0);
  check("all three are counted as exemptions", r7.stdout.includes("3 filename(s) exempted"));

  console.log("── 7b. the same names with any text inside the quotes are citations again ──");
  const r7b = run(make_repo("notfunctional", { "guard.ts": `MARKER = "see ${V1_ONLY}"\n` }));
  echo(r7b.stdout);
  check("exit code is 1", r7b.returncode === 1);
  check(
    "named as a bare citation",
    r7b.stdout.includes(`guard.ts:1: bare migration citation '${V1_ONLY}'`),
  );

  console.log(
    "── 7c. a bare name in NEITHER set is told so, not handed a spelling that re-fails ──",
  );
  const r7c = run(make_repo("ghostbare", { "cite.md": `Written by ${GHOST} once.\n` }));
  echo(r7c.stdout);
  check("exit code is 1", r7c.returncode === 1);
  check(
    "says no versioned spelling resolves",
    r7c.stdout.includes("in neither the migrations-v1 tag nor pb_migrations/ today"),
  );
  check("offers neither v1 nor v2", !r7c.stdout.includes(`write v1:${GHOST}`));
  check(
    "...and points at the cite-the-fact alternative",
    r7c.stdout.includes("cite the decision record"),
  );

  console.log("── 8. pb_migrations/ and docs/generated/ are skipped, not judged ──");
  const pruned = {
    [`pb_migrations/${V2_ONLY}`]: `// supersedes ${V1_ONLY}\n`,
    "docs/generated/register.md": `Row cites ${V1_ONLY}.\n`,
  };
  const r8 = run(make_repo("pruned", pruned));
  echo(r8.stdout);
  check("exit code is 0", r8.returncode === 0);
  check("no refusal is raised against either path", !r8.stdout.includes(REFUSAL));
  check("...and both are counted as skipped", r8.stdout.includes("2 file(s) skipped as generated"));
  check(
    "...with nothing left scanned in that fixture",
    r8.stdout.includes("0 tracked file(s) scanned"),
  );

  console.log("── 9. .gitattributes' generated inventory prunes, and prunes only what it lists ──");
  // A generated artifact carries its source's text, and a path in a merge=binary line is a
  // path, not a citation — but a sibling sharing its prefix, and the rest of the tree, stay
  // judged, so the inventory cannot be a blanket amnesty.
  const inventory = {
    ".gitattributes":
      "# GENERATED FILE\n" +
      "built/one.md merge=binary\n" +
      "gen/** merge=binary\n" +
      `pb_migrations/${V2_ONLY} merge=binary\n`,
    "built/one.md": `Generated row cites ${V1_ONLY}.\n`,
    "gen/deep/two.md": `Generated tree cites ${V1_ONLY}.\n`,
    "built/one.md.bak": `A sibling sharing the prefix cites ${V1_ONLY}.\n`,
    "hand.md": `Hand-written prose cites ${V1_ONLY}.\n`,
  };
  const r9 = run(make_repo("inventory", inventory));
  echo(r9.stdout);
  check("exit code is 1", r9.returncode === 1);
  check("the listed file is not refused", !r9.stdout.includes("built/one.md:1"));
  check("...nor is the listed directory's file", !r9.stdout.includes("gen/deep/two.md"));
  check("...but the prefix-sharing sibling still is", r9.stdout.includes("built/one.md.bak:1"));
  check("...and hand-written prose still is", r9.stdout.includes("hand.md:1"));
  check(
    "the inventory itself is pruned though it does not list itself",
    !r9.stdout.includes(".gitattributes:"),
  );
  check(
    "exactly two citations are refused",
    r9.stdout.includes("2 migration citation(s) do not resolve"),
  );

  console.log("── 12. a checkout without the tag fails CLOSED, never a silent pass ──");
  const r12 = run(
    make_repo("notag", { "cite.md": "No citation here at all.\n" }, [V2_ONLY], false),
  );
  echo(r12.stdout + r12.stderr);
  check("exit code is 1", r12.returncode === 1);
  check(
    "names the tag and the fetch that repairs it",
    (r12.stdout + r12.stderr).includes(
      "migrations-v1 tag not in this checkout — run: git fetch --tags origin",
    ),
  );

  console.log(
    "── 13. a migration filename outside the derived shape refuses instead of going blind ──",
  );
  const odd = make_repo("oddshape", { "cite.md": "No citation here at all.\n" });
  write(odd, "pb_migrations/CamelCase.js", "// wrong shape\n");
  const r13 = run(odd);
  echo(r13.stdout + r13.stderr);
  check("exit code is 1", r13.returncode === 1);
  check("names the offending basename", (r13.stdout + r13.stderr).includes("CamelCase.js"));
  check("...and says the gate would be blind", (r13.stdout + r13.stderr).includes("blind"));

  console.log("── 14. the SHIPPED tree's own shape really does back this gate ──");
  const shipped = cmc.on_disk_migrations(REPO_ROOT);
  check("the shipped pb_migrations/ set is non-empty", shipped.length > 0);
  cmc.assert_shape(shipped);
  check("every shipped migration basename matches the derived shape", true);
  // This repository was imported without the migrations-v1 tag, so the checker is not in
  // make check and the shipped tag half of this section has nothing to read.
  check("the shipped scan set is non-empty", cmc.tracked_files(REPO_ROOT).length > 0);
}

try {
  proofs();
} finally {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

check("scratch cleaned up", !fs.existsSync(SCRATCH));

console.log();
if (FAILS.length) {
  console.log(`${REFUSAL} ${FAILS.length} FAILED: ${py_repr(FAILS)}`);
  process.exit(1);
}
console.log("✅ all check_migration_citations proofs passed");
process.exit(0);

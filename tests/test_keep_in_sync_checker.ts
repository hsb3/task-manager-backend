#!/usr/bin/env bun
// Unit-pin scripts/check_keep_in_sync.ts: the token-boundary match rule and the three
// dispositions a marker can take (enforced / unverified / free-form), on synthetic scratch trees
// only (no server, no DB, no marker counts asserted so marker conversion is free to move them),
// plus one pin over copies of the shipped error-predicate sites.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_join, py_repr, run_checked } from "../scripts/_py.ts";
import * as kis from "../scripts/check_keep_in_sync.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_keep_in_sync.ts");

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

function hit(literal: string, body: string): boolean {
  return kis.occurrence(literal).exec(body) !== null;
}

/**
 * A temp git repo of {relative path: text}, all staged but `untracked`; caller removes it.
 *
 * scan_files() reads the git index, so the fixture must itself be a repo.
 */
function scratch_tree(files: Record<string, string>, untracked: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-kis-checker-"));
  run_checked(["git", "init", "-q", root]);
  for (const [rel, text] of Object.entries(files)) {
    const file = py_join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf-8");
  }
  const tracked = Object.keys(files).filter((rel) => !untracked.includes(rel));
  if (tracked.length) run_checked(["git", "-C", root, "add", "-f", "--", ...tracked]);
  return root;
}

function run_cli(root: string, ...args: string[]): [number, string] {
  const proc = Bun.spawnSync([process.execPath, CHECKER, "--root", root, ...args]);
  return [proc.exitCode ?? 1, proc.stdout.toString() + proc.stderr.toString()];
}

/** (exit code, output) of the CLI over a throwaway tree built from `files`. */
function verdict(
  files: Record<string, string>,
  args: string[] = [],
  untracked: string[] = [],
): [number, string] {
  const root = scratch_tree(files, untracked);
  try {
    return run_cli(root, ...args);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("════════ test_keep_in_sync_checker.ts — KEEP IN SYNC checker unit pins ════════");

console.log("\n── (a) a word-char edge must land on a token boundary ──");
check("`5` does not match inside `15`", hit("5", "RETRY = 15"), false);
check("`5` matches the bare token", hit("5", "RETRY = 5"), true);
check("`8192` does not match inside `18192`", hit("8192", "PORT = 18192"), false);
check("`8192` matches at the end of a line", hit("8192", "const E2E_PB_PORT = 8192"), true);
check("`_actor` does not match `_actorId`", hit("_actor", "e._actorId = x"), false);
check("`_actor` matches after a dot", hit("_actor", "record.set('_actor', id)"), true);
check("`guarded` does not match inside `unguarded`", hit("guarded", "// unguarded path"), false);

console.log("\n── (b) a punctuation edge matches wherever those characters run ──");
check("`--http=` matches mid-command", hit("--http=", "serve --http=127.0.0.1:8090"), true);
check("`@` matches as one character", hit("@", "const TRIGGER = '@';"), true);
check(
  "a glob with regex metacharacters is matched literally, not as a pattern",
  hit("../pb_hooks/**/*.js", 'watch: "../pb_hooks/**/*.js"'),
  true,
);
check(
  "...and that glob does not match a string it merely resembles",
  hit("../pb_hooks/**/*.js", 'watch: "../pb_hooks/x/y.js"'),
  false,
);
check(
  "a prose span with spaces is still an exact match",
  hit("Reload the page and try again.", "throw new Error('Reload the page and try again.')"),
  true,
);

console.log("\n── (c) a marker naming a file must quote a literal that really mirrors ──");
const mirrored = {
  "a.py": "# KEEP IN SYNC: b.py uses the same budget `5`.\nRETRY_BUDGET = 5\n",
  "b.py": "RETRY_BUDGET = 5\n",
};
let [rc, out] = verdict(mirrored, ["--table"]);
check("a live mirror exits 0", rc, 0);
check("...and is reported enforced", out.includes("a.py:1  enforced"), true);
check("...counted as one enforced marker", out.includes("1 marker(s) scanned, 1 enforced"), true);

const moved = { ...mirrored, "b.py": "RETRY_BUDGET = 15\n" };
[rc, out] = verdict(moved);
check("one side moved (5 -> 15) exits 1", rc, 1);
check(
  "...naming the side that lost it",
  out.includes("'5' still appears in a.py but no longer in b.py"),
  true,
);

const no_literal = {
  "a.py": "# KEEP IN SYNC: b.py uses the same budget.\nRETRY_BUDGET = 5\n",
  "b.py": "RETRY_BUDGET = 5\n",
};
[rc, out] = verdict(no_literal, ["--table"]);
check("a marker that names a file and quotes nothing exits 1", rc, 1);
check("...reported unverified, never enforced", out.includes("a.py:1  unverified"), true);
check(
  "...saying only the path was checked",
  out.includes("quotes no literal, so only the path"),
  true,
);
check(
  "...and telling the author which file the literal must recur in",
  out.includes("must recur in b.py"),
  true,
);

const nowhere = {
  "a.py": "# KEEP IN SYNC: b.py uses the same `RETRY_LIMIT`.\nRETRY_BUDGET = 5\n",
  "b.py": "RETRY_BUDGET = 5\n",
};
[rc, out] = verdict(nowhere);
check("a literal present in neither file exits 1", rc, 1);
check("...as a mirror that is not there", out.includes("claims a mirror that is not there"), true);

const self_only = { "a.py": "# KEEP IN SYNC: a.py holds `RETRY_BUDGET`.\nRETRY_BUDGET = 5\n" };
[rc, out] = verdict(self_only);
check("a marker naming only its own file exits 1", rc, 1);
check(
  "...because a mirror needs a second file",
  out.includes("a mirror needs a second file"),
  true,
);

console.log("\n── (d) free-form prose is still unenforced, and a bad path is still an error ──");
const prose = { "a.py": "# KEEP IN SYNC: the dashboard copy says the same thing.\nX = 1\n" };
[rc, out] = verdict(prose, ["--table"]);
check("a marker naming no file exits 0", rc, 0);
check("...reported free-form", out.includes("a.py:1  free-form"), true);
check("...and counted as not enforced", out.includes("0 enforced"), true);

const missing = { "a.py": "# KEEP IN SYNC: gone.py holds the twin `X`.\nX = 1\n" };
[rc, out] = verdict(missing);
check("a named file that is not on disk exits 1", rc, 1);
check("...naming the token that resolves to nothing", out.includes("names gone.py"), true);

console.log("\n── (e) a marker's own prose cannot satisfy another marker's claim ──");
const prose_only = {
  "a.py": "# KEEP IN SYNC: b.py carries `SHARED_TOKEN`.\nSHARED_TOKEN = 1\n",
  "b.py": "# KEEP IN SYNC: the docs still call this SHARED_TOKEN.\nOTHER = 2\n",
};
[rc, out] = verdict(prose_only, ["--table"]);
check("the twin naming the literal only inside its own marker run exits 1", rc, 1);
check(
  "...because a masked marker run is not a site",
  out.includes("a.py:1: 'SHARED_TOKEN' still appears in a.py but no longer in b.py"),
  true,
);
check("...while b.py's own marker stays free-form", out.includes("b.py:1  free-form"), true);

console.log("\n── (f) an empty sweep never reports green ──");
[rc, out] = verdict({ "a.py": "X = 1\n" });
check("a tree with no marker at all exits 1", rc, 1);
check("...saying the scan assumption broke", out.includes("this gate's scan assumption"), true);

console.log("\n── (g) the scan reads tracked files only, never an untracked or ignored one ──");
const gitignored = {
  "a.py": "# KEEP IN SYNC: b.py uses the same budget `5`.\nRETRY_BUDGET = 5\n",
  "b.py": "RETRY_BUDGET = 5\n",
  ".gitignore": "scratch.log\n",
  "scratch.log": "# KEEP IN SYNC: gone.py mirrors `BOGUS`.\n",
};
[rc, out] = verdict(gitignored, ["--table"], ["scratch.log"]);
check("a marker inside a gitignored file is never scanned", rc, 0);
check("...its own file never named in the output", out.includes("scratch.log"), false);
check("...and its bogus referent never named either", out.includes("gone.py"), false);

const unignored_log = {
  ...mirrored,
  "dod.out": "# KEEP IN SYNC: nonexistent_phantom_target.py mirrors `BOGUS`.\n",
};
[rc, out] = verdict(unignored_log, ["--table"], ["dod.out"]);
check("an untracked log that .gitignore does not ignore exits 0", rc, 0);
check("...its own file never named in the output", out.includes("dod.out"), false);
check(
  "...and its bogus referent never named either",
  out.includes("nonexistent_phantom_target"),
  false,
);

[rc, out] = verdict(mirrored, ["--table"], ["a.py"]);
check("an untracked, unignored marker file is not scanned", out.includes("a.py:1"), false);

console.log("\n── (h) a `(below)` marker holds the code right under it, not the whole file ──");
const twin_sites = {
  "a.py": "# KEEP IN SYNC (below): b.py `BUDGET = 5`.\nBUDGET = 5\n\n\n\n\n\n\n\nBUDGET = 5\n",
  "b.py": "BUDGET = 5\n",
};
[rc, out] = verdict(twin_sites);
check("a `(below)` literal right under its marker exits 0", rc, 0);
[rc, out] = verdict({
  ...twin_sites,
  "a.py": twin_sites["a.py"].replace("\nBUDGET = 5\n\n", "\nBUDGET = 6\n\n"),
});
check("...moved under the marker while a far copy remains exits 1", rc, 1);
check(
  "...naming the window under the marker, not the whole file",
  out.includes("no longer in a.py:2-7 (the 6 code lines under the marker)"),
  true,
);

[rc, out] = verdict({
  ...twin_sites,
  "a.py":
    "# KEEP IN SYNC (below): b.py `BUDGET = 5`.\nx = 1\n# BUDGET = 5 lived here\nBUDGET = 6\n",
});
check("...a comment line under the marker is not a site, so a moved one exits 1", rc, 1);
[rc, out] = verdict({
  ...twin_sites,
  "a.py":
    "# KEEP IN SYNC (below): b.py `BUDGET = 5`.\nx = 1\n# a\n# b\n# c\n# d\n# e\nBUDGET = 5\n",
});
check("...and comment lines do not use up the window", rc, 0);

console.log("\n── (j) a plain marker whose literal recurs in its own file is refused ──");
const repeated = {
  "a.py": "# KEEP IN SYNC: b.py `BUDGET = 5`.\nBUDGET = 5\n\nBUDGET = 5\n",
  "b.py": "BUDGET = 5\n",
};
[rc, out] = verdict(repeated);
check("a plain-form literal at two sites of its own file exits 1", rc, 1);
check(
  "...pointing the author at the (below) form",
  out.includes("a.py:1: 'BUDGET = 5' occurs on 2 code lines of a.py") && out.includes("(below)"),
  true,
);
[rc, out] = verdict({ ...repeated, "a.py": "# KEEP IN SYNC: b.py `BUDGET = 5`.\nBUDGET = 5\n" });
check("...while one own-file site under the plain form exits 0", rc, 0);
[rc, out] = verdict({
  ...repeated,
  "a.py": "# KEEP IN SYNC: b.py `BUDGET = 5`.\nBUDGET = 5\n# BUDGET = 5 is the budget\n",
});
check("...and a mention in an ordinary comment is not a second site", rc, 0);

console.log("\n── (k) an ordinary comment is not presence, except in a Markdown mirror ──");
[rc, out] = verdict({
  ...mirrored,
  "b.py": "# RETRY_BUDGET = 5 was the budget\nRETRY_BUDGET = 15\n",
});
check("a twin surviving only in a comment exits 1", rc, 1);
check(
  "...naming the side that lost it",
  out.includes("'5' still appears in a.py but no longer in b.py"),
  true,
);
[rc, out] = verdict({
  "a.py": "# KEEP IN SYNC: b.md lists `RETRY_BUDGET`.\nRETRY_BUDGET = 5\n",
  "b.md": "# Constants\n\n* RETRY_BUDGET is the retry count\n",
});
check("...while a Markdown bullet is the mirror itself and exits 0", rc, 0);

console.log(
  "\n── (i) the shipped error-predicate sites: either half moved at any one site goes red ──",
);
// Shipped-tree pin: the refusal-vs-500 predicate is inlined per pooled-JSVM callback.
const PRED = 'v.status || typeof v.marshalJSON === "function"';
const HOOKS = ["routes.pb.js", "membership_status.pb.js", "oauth.pb.js"];
const shipped = Object.fromEntries(
  HOOKS.map((f) => [
    `pb_hooks/${f}`,
    fs.readFileSync(path.join(REPO_ROOT, "pb_hooks", f), "utf-8"),
  ]),
);
const pred_errors = (o: string): string[] => o.split("\n").filter((l) => l.includes("marshalJSON"));
[rc, out] = verdict(shipped);
check("the shipped sites raise no predicate error", pred_errors(out), []);
for (const [rel, text] of Object.entries(shipped)) {
  const lines = text.split("\n");
  const sites = lines.flatMap((l, i) =>
    l.includes("typeof v.marshalJSON") && !l.includes("KEEP IN SYNC") ? [i] : [],
  );
  check(`${rel} has at least one predicate site`, sites.length > 0, true);
  for (const i of sites) {
    for (const [half, from, to] of [
      ["status", "v.status ||", "v.code ||"],
      ["marshalJSON", "v.marshalJSON", "v.toJSON"],
    ] as const) {
      const moved = [...lines];
      moved[i] = moved[i]!.replace(from, to);
      [rc, out] = verdict({ ...shipped, [rel]: moved.join("\n") });
      check(
        `${rel}:${i + 1} ${half} half moved goes red`,
        pred_errors(out).some((l) => l.includes(PRED)),
        true,
      );
    }
  }
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_constants.ts: marker regions are bounded, emitter counts are compared, end-to-end RED/GREEN against a mirrored tree (no server, no DB).
 *
 * Every mutation lands in a scratch MIRROR of the source tree and the checker is pointed at it
 * with --root, so no tracked file is ever rewritten (asserted at the end).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, py_split, read_text, splitlines, truthy } from "../scripts/_py.ts";
import * as cc from "../scripts/check_constants.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));

const CHECKER = path.join(REPO_ROOT, "scripts", "check_constants.ts");
const MIRRORED_TREES = ["pb_migrations", "pb_hooks", "schema", "docs"];

const NOTIFY = "pb_hooks/notify.pb.js";
const CYCLES = "pb_hooks/cycles.pb.js";
const CRON_MARKER = "── INLINED SWEEP (cron copy, uses $app) — KEEP IN SYNC with the route copy ──";
const ROUTE_MARKER =
  "── INLINED SWEEP (route copy, uses e.app) — KEEP IN SYNC with the cron copy ──";
const ROUTE_END = "── END INLINED SWEEP (route copy) ──";
const STATUSES_FILTER = '"workspace = {:w} && (category';
const RENAMED_FILTER = '"wspace = {:w} && (category';
const MENTION_EMITTER = 'n.set("kind", "mentioned");';
const COMMENTED_EMITTER = 'n.set("kind", "commented");';
const count = (s: string, sub: string): number => s.split(sub).length - 1;
const EMITTER_SITE = cc.CONSTANTS.NOTIFICATION_KINDS!.sites.find((s) => s.emitters !== undefined)!;
// Derived from the shipped tree, never written down: a new fan-out site must not turn this suite red.
const M = count(read_text(path.join(REPO_ROOT, NOTIFY)), MENTION_EMITTER);
const D = EMITTER_SITE.emitters!.mentioned!.length;

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

/** A scratch copy of every tree the checker reads. */
function mirror(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbconst_"));
  for (const name of MIRRORED_TREES) {
    fs.cpSync(path.join(REPO_ROOT, name), path.join(root, name), {
      recursive: true,
      dereference: true,
    });
  }
  return root;
}

function read(root: string, rel: string): string {
  return read_text(path.join(root, rel));
}

function run(root: string): [number, string] {
  const proc = Bun.spawnSync([process.execPath, CHECKER, "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return [proc.exitCode ?? -1, proc.stdout.toString() + proc.stderr.toString()];
}

/** Rewrite one named occurrence of `old` in the mirror, pinning how many there were. */
function edit(
  root: string,
  rel: string,
  old: string,
  new_: string,
  total: number,
  occurrence = "first",
): void {
  const text = read(root, rel);
  check(`${rel} holds ${py_repr(old)} ${total}x before the mutation`, count(text, old), total);
  let mutated: string;
  if (occurrence === "all") {
    mutated = text.replaceAll(old, () => new_);
  } else {
    const at = occurrence === "first" ? text.indexOf(old) : text.lastIndexOf(old);
    mutated = text.slice(0, at) + new_ + text.slice(at + old.length);
  }
  check(
    `...the ${occurrence} one became ${py_repr(new_)}`,
    count(mutated, old),
    occurrence === "all" ? 0 : total - 1 + count(new_, old),
  );
  fs.writeFileSync(path.join(root, rel), mutated);
}

function tracked_bytes(): Record<string, Buffer> {
  const snapshot: Record<string, Buffer> = {};
  for (const rel of [NOTIFY, CYCLES]) {
    snapshot[rel] = fs.readFileSync(path.join(REPO_ROOT, rel));
  }
  return snapshot;
}

/** main()'s (exit code, stdout) in-process, so an in-memory CONSTANTS edit is visible. */
function rendered(root: string): [number, string] {
  const argv = process.argv;
  const orig = process.stdout.write;
  let buf = "";
  process.stdout.write = ((s: any) => {
    buf += String(s);
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    process.argv = ["bun", "check_constants.ts", "--root", root];
    code = cc.main();
  } finally {
    process.argv = argv;
    process.stdout.write = orig;
  }
  return [code, buf];
}

const BEFORE = tracked_bytes();

console.log("════════ test_constants_checker.ts — check_constants.ts gate pins ════════");

console.log("\n── (a) the shipped tree is GREEN, and a mirror of it is GREEN too ──");
let [code, out] = run(REPO_ROOT);
check("--root <repo> exits 0", code, 0);
check("...and reports every copy exact", out.includes("every copy exact"), true);
let ROOT = mirror();
check("the mirror is not the repo", fs.realpathSync(ROOT) !== fs.realpathSync(REPO_ROOT), true);
[code, out] = run(ROOT);
check("--root <mirror> exits 0", code, 0);

console.log("\n── (b) a marker-anchored site may not slide into a sibling copy ──");
// The two sweep copies are byte-identical apart from $app/e.app, so an unbounded anchor matches
// the ROUTE copy's block under the CRON copy's marker and reports the route copy's line.
edit(ROOT, CYCLES, STATUSES_FILTER, RENAMED_FILTER, 2);
[code, out] = run(ROOT);
check("renaming the cron copy's statuses filter exits 1", code, 1);
check("...the failure names the CRON marker", out.includes(CRON_MARKER), true);
check("...and not the route marker", out.includes(ROUTE_MARKER), false);
check(
  "...reported as a missing copy at that site, not as value drift",
  out.includes("no copy of the list found at mirror site pb_hooks/cycles.pb.js"),
  true,
);
check("...exactly one error is reported", count(out, "     • "), 1);

fs.rmSync(ROOT, { recursive: true, force: true });
ROOT = mirror();
edit(ROOT, CYCLES, STATUSES_FILTER, RENAMED_FILTER, 2, "all");
[code, out] = run(ROOT);
check("renaming BOTH copies' statuses filters exits 1", code, 1);
check("...the cron marker is named", out.includes(CRON_MARKER), true);
check("...the route marker is named too", out.includes(ROUTE_MARKER), true);

// The LAST marker in a file has no next marker to stop at, so both sweep sites also carry
// their own END terminator — the one the trash predicate sites already anchor on.
fs.rmSync(ROOT, { recursive: true, force: true });
ROOT = mirror();
edit(ROOT, CYCLES, ROUTE_END, "── the route copy ends here ──", 1);
[code, out] = run(ROOT);
check("deleting the route copy's END terminator exits 1", code, 1);
check(
  "...STATUS_CATEGORIES names the ROUTE site, so the terminator is load-bearing",
  out.includes(
    `STATUS_CATEGORIES: no copy of the list found at mirror site ${CYCLES} ` +
      `under marker '${ROUTE_MARKER}'`,
  ),
  true,
);
check("...and the cron site is untouched", out.includes(CRON_MARKER), false);

console.log("\n── (b2) generically: every marker site's copy lives inside its OWN region ──");
// Blank a site's region (its marker -> the next marker) and the site must then find NOTHING:
// an unbounded anchor resolves the same regex in a sibling copy further down the file.
for (const [name, spec] of Object.entries(cc.CONSTANTS)) {
  for (const site of spec.sites) {
    if (site.marker === undefined) continue;
    const rel = site.file;
    const text = read(REPO_ROOT, rel);
    const markers = cc._markers_of(rel);
    const start = text.indexOf(site.marker) + site.marker.length;
    const stops = markers.map((m) => text.indexOf(m, start)).filter((at) => at >= 0);
    const gutted_from = stops.length ? Math.min(...stops) : text.length;
    const gutted =
      text.slice(0, start) +
      text.slice(start, gutted_from).replace(/[^\n]/g, " ") +
      text.slice(gutted_from);
    const where = `${name} @ ${rel} under ${py_repr(site.marker.slice(0, 38))}`;
    check(`${where}: gutted region -> no copy`, cc._site_values(gutted, site, markers)[0], null);
    check(
      `${where}: intact tree still resolves it (the gutting is not vacuous)`,
      cc._site_values(text, site, markers)[0] !== null,
      true,
    );
  }
}

console.log("\n── (c) an emitted kind is counted, never set-collapsed ──");
for (const [label, kind, old, new_, total, occurrence, seen, declared] of [
  // The card's falsifier is the update-path one; the create-path twin must fail the same way.
  [
    "the update-path @mention fan-out is deleted",
    "mentioned",
    MENTION_EMITTER,
    "",
    M,
    "last",
    M - 1,
    D,
  ],
  [
    "the create-path @mention fan-out is deleted",
    "mentioned",
    MENTION_EMITTER,
    "",
    M,
    "first",
    M - 1,
    D,
  ],
  ["the commented fan-out is deleted", "commented", COMMENTED_EMITTER, "", 1, "first", 0, 1],
  [
    "a THIRD @mention emitter is added",
    "mentioned",
    MENTION_EMITTER,
    MENTION_EMITTER.repeat(2),
    M,
    "first",
    M + 1,
    D,
  ],
] as [string, string, string, string, number, string, number, number][]) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  ROOT = mirror();
  edit(ROOT, NOTIFY, old, new_, total, occurrence);
  [code, out] = run(ROOT);
  check(`${label} -> exit 1`, code, 1);
  check(
    `...the failure counts the emitters (${kind}: ${seen} in source, ${declared} declared)`,
    out.includes(`${kind}: ${seen} emitter(s) in source, ${declared} declared`),
    true,
  );
  check("...and it names the site", out.includes("pb_hooks/notify.pb.js:"), true);
}

fs.rmSync(ROOT, { recursive: true, force: true });
ROOT = mirror();
edit(ROOT, NOTIFY, MENTION_EMITTER, 'n.set("kind", "escalated");', M);
[code, out] = run(ROOT);
check("an emitter for a kind outside the vocabulary -> exit 1", code, 1);
check(
  "...the unknown kind is counted 1 in source vs 0 declared",
  out.includes("escalated: 1 emitter(s) in source, 0 declared"),
  true,
);
check(
  "...and the kind it replaced is short one emitter",
  out.includes(`mentioned: ${M - 1} emitter(s) in source, ${D} declared`),
  true,
);

console.log("\n── (d) the emitter declaration itself must cover the whole vocabulary ──");
fs.rmSync(ROOT, { recursive: true, force: true });
ROOT = mirror();
check("the shipped declaration covers the constant", rendered(ROOT)[0], 0);
const dropped = EMITTER_SITE.emitters!.mentioned!;
delete EMITTER_SITE.emitters!.mentioned;
try {
  [code, out] = rendered(ROOT);
  check("dropping a kind from the declaration -> exit 1", code, 1);
  check(
    "...the coverage error names both sides",
    out.includes("the emitter declaration for pb_hooks/notify.pb.js covers"),
    true,
  );
  check(
    "...and the now-undeclared emitters are counted",
    out.includes(`mentioned: ${M} emitter(s) in source, 0 declared`),
    true,
  );
} finally {
  EMITTER_SITE.emitters!.mentioned = dropped;
}
check("the declaration is restored", rendered(ROOT)[0], 0);

console.log("\n── (e) --print-sites (the pre-commit trigger list) still answers ──");
const proc = Bun.spawnSync([process.execPath, CHECKER, "--print-sites"], {
  stdout: "pipe",
  stderr: "pipe",
});
check("exit 0", proc.exitCode, 0);
const sites = py_split(proc.stdout.toString());
check("docs/constants.md is a trigger", sites.includes("docs/constants.md"), true);
check("the gate itself is a trigger", sites.includes("scripts/check_constants.ts"), true);
check("a mirror-site source file is a trigger", sites.includes(CYCLES), true);

console.log("\n── (f) LABEL_TONES reads TODAY's schema/, not a fixed historical migration ──");
// A migration landed after either historical labels/statuses file would never move the
// needle on the old hardcoded-file-path check; schema/ is regenerated from the CURRENT
// migration set regardless of which file last touched a palette, so it can't go stale
// the way a pinned migration path does.
fs.rmSync(ROOT, { recursive: true, force: true });
ROOT = mirror();
edit(ROOT, "schema/statuses.json", '"teal"', '"cyan"', 1);
[code, out] = run(ROOT);
check("statuses.color drifting from labels.color -> exit 1", code, 1);
// Read the REFUSAL line, never the whole report: a passing run's own note line also names
// LABEL_TONES and the site, so a whole-output match here could not fail.
const drift = splitlines(out).find((ln) => ln.includes("❌") && ln.includes("LABEL_TONES")) ?? "";
check("...a refusal line names LABEL_TONES", truthy(drift), true);
check(
  "...the site is schema/statuses.json, not a pb_migrations path",
  drift.includes("schema/statuses.json") && !drift.includes("pb_migrations"),
  true,
);
check(
  "...both palettes are named (the drifted and the canonical tone)",
  drift.includes("cyan") && drift.includes("teal"),
  true,
);

console.log("\n── (g) no tracked source was rewritten ──");
const AFTER = tracked_bytes();
for (const [rel, before] of Object.entries(BEFORE)) {
  check(`${rel} is byte-identical`, AFTER[rel], before);
}
fs.rmSync(ROOT, { recursive: true, force: true });
check("scratch mirror cleaned up", fs.existsSync(ROOT), false);

console.log();
if (failures) {
  console.log(`❌ test_constants_checker: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ test_constants_checker: every check passed");
process.exit(0);

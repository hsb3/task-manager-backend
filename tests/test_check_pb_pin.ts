#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_pb_pin.ts: house-style scratch-mirror RED/GREEN proof (no server, no port).
 *
 * Every mutation lands in a scratch MIRROR of the four real pin sites, and the checker is
 * pointed at it with --root, so no tracked file is ever rewritten (asserted at the end).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, read_text } from "../scripts/_py.ts";
import * as cpp from "../scripts/check_pb_pin.ts";
import { pinned_pb_version } from "../scripts/pb_migrate.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const CHECKER = path.join(REPO_ROOT, "scripts", "check_pb_pin.ts");
const PIN_RE = new RegExp(cpp.PIN_RE.source, "gd");
const CANONICAL = pinned_pb_version();
// Never CANONICAL: an off-by-one bump would coincidentally equal one of these otherwise.
const MISMATCH = CANONICAL !== "0.1.0" ? "0.1.0" : "0.2.0";
const BUMPED = CANONICAL !== "0.41.0" ? "0.41.0" : "0.42.0";

const MAKEFILE = "Makefile";
const CI = path.join(".github", "workflows", "ci.yml");
const BATTERY = path.join("scripts", "run_suite_battery.sh");
const DOCKERFILE = "Dockerfile";
const MIRROR_FILES = [DOCKERFILE, MAKEFILE, CI, BATTERY];

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

/** A scratch copy of the four real pin files — no `.git`, so the checker's own walk fallback scans it. */
function mirror(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbpin_"));
  for (const rel of MIRROR_FILES) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dst);
  }
  return root;
}

function read(root: string, rel: string): string {
  return read_text(path.join(root, rel));
}

function write(root: string, rel: string, text: string): void {
  fs.writeFileSync(path.join(root, rel), text, "utf-8");
}

function run(root: string): [number, string] {
  const proc = Bun.spawnSync([process.execPath, CHECKER, "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return [proc.exitCode ?? -1, proc.stdout.toString() + proc.stderr.toString()];
}

/** A PB_VERSION pin span in the shape the checker's own PIN_RE parses. */
function pin_line(version: string, sep = ":=", quote = false, q = '"'): string {
  const value = quote ? `${q}${version}${q}` : version;
  return `PB_VERSION ${sep} ${value}`;
}

/** Rewrite one PIN_RE match's WHOLE span (separator/quoting included), by index. */
function replace_match(text: string, occurrence: number, new_span: string): string {
  const matches = [...text.matchAll(PIN_RE)];
  const m = matches[occurrence];
  check(`...match #${occurrence} exists before the mutation`, m !== undefined, true);
  return text.slice(0, m.index) + new_span + text.slice(m.index + m[0].length);
}

/** Rewrite one match's version group only, preserving its separator/quoting. */
function mutate_version(
  text: string,
  old_version: string,
  new_version: string,
  occurrence = 0,
): string {
  const matches = [...text.matchAll(PIN_RE)];
  const m = matches[occurrence];
  check(`...match #${occurrence} holds '${old_version}' before the mutation`, m[1], old_version);
  const [start, end] = m.indices![1]!;
  return text.slice(0, start) + new_version + text.slice(end);
}

function tracked_bytes(): Record<string, Buffer> {
  const snapshot: Record<string, Buffer> = {};
  for (const rel of MIRROR_FILES) snapshot[rel] = fs.readFileSync(path.join(REPO_ROOT, rel));
  return snapshot;
}

function count(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

const BEFORE = tracked_bytes();
let code: number;
let out: string;
let ROOT: string;

console.log("════════ test_check_pb_pin.ts — check_pb_pin.ts gate pins ════════");

console.log("\n── (a) the shipped tree is GREEN, and a mirror of the four sites is GREEN too ──");
[code, out] = run(REPO_ROOT);
check("--root <repo> exits 0", code, 0);
check("...and reports the canonical version", out.includes(`PocketBase ${CANONICAL}`), true);
ROOT = mirror();
check("the mirror is not the repo", fs.realpathSync(ROOT) !== fs.realpathSync(REPO_ROOT), true);
[code, out] = run(ROOT);
check("--root <mirror> exits 0", code, 0);

console.log(
  "\n── (b) one site moved (each of Makefile / ci.yml / the battery) is named by file:line ──",
);
for (const [label, rel] of [
  ["Makefile", MAKEFILE],
  [".github/workflows/ci.yml (one of three)", CI],
  ["scripts/run_suite_battery.sh", BATTERY],
]) {
  fs.rmSync(ROOT, { recursive: true });
  ROOT = mirror();
  write(ROOT, rel, mutate_version(read(ROOT, rel), CANONICAL, MISMATCH));
  [code, out] = run(ROOT);
  check(`${label}: exit 1`, code, 1);
  check(`...names ${rel}`, out.includes(`${rel}:`), true);
  check(
    `...names the found version ${MISMATCH}`,
    out.includes(`pins PocketBase ${MISMATCH}`),
    true,
  );
  check("...and the canonical version is named", out.includes(`is ${CANONICAL}`), true);
  check("...exactly one finding", count(out, "     • "), 1);
}

console.log("\n── (c) the canonical moved alone — every OTHER site is named, none is silent ──");
fs.rmSync(ROOT, { recursive: true });
ROOT = mirror();
write(ROOT, DOCKERFILE, mutate_version(read(ROOT, DOCKERFILE), CANONICAL, BUMPED));
[code, out] = run(ROOT);
check("bumping only the Dockerfile's ARG exits 1", code, 1);
check("...the Makefile is named", out.includes(`${MAKEFILE}:`), true);
check("...the battery is named", out.includes(`${BATTERY}:`), true);
check("...ci.yml is named 3 times (all three sites)", count(out, `${CI}:`), 3);
check(
  "...5 findings total (1 + 3 + 1), the Dockerfile itself is not one",
  count(out, "     • "),
  5,
);

console.log("\n── (d) a required site with its pin line deleted is refused, not vanished ──");
fs.rmSync(ROOT, { recursive: true });
ROOT = mirror();
let text = read(ROOT, MAKEFILE);
const m0 = text.matchAll(PIN_RE).next().value!;
const line_start = text.lastIndexOf("\n", m0.index - 1) + 1;
const line_end = text.indexOf("\n", m0.index + m0[0].length);
write(ROOT, MAKEFILE, text.slice(0, line_start) + text.slice(line_end + 1));
[code, out] = run(ROOT);
check("deleting the Makefile's pin line exits 1", code, 1);
check("...names Makefile as missing its pin", out.includes("Makefile has no PB_VERSION pin"), true);

console.log("\n── (e) a new site in an unlisted tracked file is held too ──");
fs.rmSync(ROOT, { recursive: true });
ROOT = mirror();
const new_workflow = path.join(".github", "workflows", "other.yml");
fs.mkdirSync(path.dirname(path.join(ROOT, new_workflow)), { recursive: true });
write(ROOT, new_workflow, `jobs:\n  build:\n    env:\n      ${pin_line(MISMATCH, ":", true)}\n`);
[code, out] = run(ROOT);
check("a brand-new pin site at the wrong version exits 1", code, 1);
check("...names the new file", out.includes(`${new_workflow}:`), true);
check("...names its wrong version", out.includes(`pins PocketBase ${MISMATCH}`), true);

console.log("\n── (f) a quoted and an unquoted form both parse ──");
fs.rmSync(ROOT, { recursive: true });
ROOT = mirror();
write(ROOT, MAKEFILE, replace_match(read(ROOT, MAKEFILE), 0, pin_line(CANONICAL, ":=", true)));
write(ROOT, BATTERY, replace_match(read(ROOT, BATTERY), 0, pin_line(CANONICAL, "=", false)));
[code, out] = run(ROOT);
check("a quoted Makefile pin and an unquoted battery pin both exit 0", code, 0);

console.log("\n── (f2) a single-quoted YAML pin is held too ──");
fs.rmSync(ROOT, { recursive: true });
ROOT = mirror();
write(ROOT, CI, replace_match(read(ROOT, CI), 1, pin_line(MISMATCH, ":", true, "'")));
[code, out] = run(ROOT);
check("a single-quoted wrong ci.yml pin -> exit 1", code, 1);
check("...names ci.yml", out.includes(`${CI}:`), true);

console.log("\n── (g) no tracked source was rewritten ──");
const AFTER = tracked_bytes();
for (const [rel, before] of Object.entries(BEFORE)) {
  check(`${rel} is byte-identical`, AFTER[rel].equals(before), true);
}
fs.rmSync(ROOT, { recursive: true });
check("scratch mirror cleaned up", fs.existsSync(ROOT), false);

console.log();
if (failures) {
  console.log(`❌ test_check_pb_pin: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ test_check_pb_pin: every check passed");

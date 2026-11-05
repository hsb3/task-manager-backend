#!/usr/bin/env bun
// Unit-pin scripts/check_app_docs_down_up.ts: the derived round-trip depth, and the
// span-loss/growth predicates, on synthetic before/after maps (no server, no DB, no replay).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, tup } from "../scripts/_py.ts";
import * as adu from "../scripts/check_app_docs_down_up.ts";

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

function migrations_dir(names: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-docs-down-up-checker-"));
  for (const name of names) fs.writeFileSync(path.join(root, name), "");
  return root;
}

console.log(
  "════════ test_app_docs_down_up_checker.ts — down/up round-trip checker unit pins ════════",
);

console.log("\n── (a) round_trip_depth: derived from the LAST TWO seed_app_docs*.js migrations ──");
let d = migrations_dir([
  "0001_users.js",
  "0002_app_docs.js",
  "0003_seed_app_docs_a.js",
  "0004_widget.js",
  "0005_seed_app_docs_b.js",
  "0006_seed_app_docs_c.js",
]);
check(
  "reverts back through the OLDER of the last two seed migrations (0005), not just the last",
  adu.round_trip_depth(d),
  2,
);
d = migrations_dir(["0001_users.js", "0002_seed_app_docs_only.js"]);
check("exactly one seed migration → reverts back through it alone", adu.round_trip_depth(d), 1);
d = migrations_dir(["0001_users.js", "0002_widget.js"]);
check(
  "no seed_app_docs migration at all → nothing to round-trip (None)",
  adu.round_trip_depth(d),
  null,
);
d = migrations_dir(["0001_seed_app_docs_only.js", "0002_widget.js", "0003_widget2.js"]);
check(
  "the sole seed migration sits deep in the tail → depth counts every migration after it too",
  adu.round_trip_depth(d),
  3,
);

console.log("\n── (b) find_lost_spans: substring-present-before/absent-after, per (id, field) ──");
const before = new Map<string, [string, string]>([
  ["doc1", ["Title One", "A sentence long enough to count as a real tracked span here."]],
]);
const after_clean = new Map<string, [string, string]>([
  ["doc1", ["Title One", "A sentence long enough to count as a real tracked span here. More."]],
]);
check(
  "nothing lost when the span survives verbatim inside a longer body",
  adu.find_lost_spans(before, after_clean),
  [],
);

const DUPLICATED =
  "A sentence long enough to count as a real tracked span here. " +
  "A sentence long enough to count as a real tracked span here.";
const after_dup = new Map<string, [string, string]>([["doc1", ["Title One", DUPLICATED]]]);
check("DUPLICATION (the accepted no-op) is not a loss", adu.find_lost_spans(before, after_dup), []);

const after_lost = new Map<string, [string, string]>([
  ["doc1", ["Title One", "A totally different body that shares nothing with before."]],
]);
check(
  "a span present before and absent after is reported as (id, field, span)",
  adu.find_lost_spans(before, after_lost),
  [tup("doc1", "body", "A sentence long enough to count as a real tracked span here.")],
);

const after_missing_record = new Map<string, [string, string]>();
check(
  "a record present before and GONE after loses every one of its spans",
  adu.find_lost_spans(before, after_missing_record),
  [tup("doc1", "body", "A sentence long enough to count as a real tracked span here.")],
);

const short = new Map<string, [string, string]>([["doc2", ["", "too short"]]]);
check(
  "a span shorter than MIN_SPAN_CHARS is never tracked, so it cannot be reported lost",
  adu.find_lost_spans(short, new Map()),
  [],
);

console.log("\n── (c) growth: informational, keyed on BODY length only, never gates the run ──");
check(
  "a body that grew is reported (before_len, after_len)",
  adu.growth(
    new Map([["doc1", ["", "short"]]]),
    new Map([["doc1", ["", "a much longer body than before"]]]),
  ),
  [tup("doc1", 5, "a much longer body than before".length)],
);
check(
  "a body that did not grow is not reported",
  adu.growth(new Map([["doc1", ["", "same"]]]), new Map([["doc1", ["", "same"]]])),
  [],
);
check(
  "a body that SHRANK is not reported by growth() — find_lost_spans is what catches that",
  adu.growth(new Map([["doc1", ["", "a longer body here"]]]), new Map([["doc1", ["", "short"]]])),
  [],
);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

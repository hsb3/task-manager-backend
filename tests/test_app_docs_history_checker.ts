#!/usr/bin/env bun
// nw9w — unit-pin scripts/check_app_docs_history.ts: span cutting, drop attribution, restore, and allowlist matching/staleness (synthetic snapshots, no server, no DB).

import fs from "node:fs";
import path from "node:path";
import { by_code_point, py_repr, tup } from "../scripts/_py.ts";
import * as hist from "../scripts/check_app_docs_history.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const BODY_V1 =
  "A VIEW collection: one row per item across tasks, decisions, documents and milestones. " +
  "That exposes nothing new: GET /api/tracker/trash returns the same rows under the same " +
  "predicate, and since PBTT-543/544 the trash route applies the draft branch. " +
  "Read-only: create/update/delete are refused for everyone, superusers included.";
// The same record after a rewrite that keeps the opening and the closing but loses the middle.
const BODY_V2 =
  "A VIEW collection: one row per item across tasks, decisions, documents and milestones. " +
  "Read-only: create/update/delete are refused for everyone, superusers included.";
const DROPPED =
  "That exposes nothing new: GET /api/tracker/trash returns the same rows under the same " +
  "predicate, and since PBTT-543/544 the trash route applies the draft branch.";

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

// A (slug, field) record key and an ALLOWLIST key are JSON.stringify of the tuple.
const rec_key = (slug: string, field: string): string => JSON.stringify([slug, field]);

/** (migration, body) pairs -> the snapshot shape find_drops consumes, one record. */
function snaps(...pairs: [string, string][]): [string, Map<string, string>][] {
  return pairs.map(([name, body]) => [
    name,
    new Map([[rec_key("collection:project_items", "body"), body]]),
  ]);
}

console.log(
  "════════ test_app_docs_history_checker.ts — nw9w app_docs history gate unit pins ════════",
);

console.log(
  "\n── (a) span cutting: sentence + line breaks, whitespace-normalized, length-gated ──",
);
check("shipped MIN_SPAN_CHARS", hist.MIN_SPAN_CHARS, 40);
check(
  "normalize collapses newlines and runs of spaces",
  hist.normalize("a  b\n\n  c\t d "),
  "a b c d",
);
check("normalize(None) is empty", hist.normalize(null), "");
check("BODY_V1 cuts into 3 sentences", hist.spans(BODY_V1).length, 3);
check("the dropped sentence is one whole span", hist.spans(BODY_V1).includes(DROPPED), true);
check(
  "a chunk under the threshold is not tracked",
  hist.spans("Read-only. " + "x".repeat(hist.MIN_SPAN_CHARS - 1)),
  [],
);
check("a chunk at exactly the threshold IS tracked", hist.spans("y".repeat(hist.MIN_SPAN_CHARS)), [
  "y".repeat(hist.MIN_SPAN_CHARS),
]);
check(
  "re-wrapping alone is not a difference — the span survives a newline rewrite",
  hist.find_drops(snaps(["001_a.js", BODY_V1], ["002_b.js", BODY_V1.replaceAll(". ", ".\n  ")])),
  [],
);
check(
  "a line break cuts a span even without terminal punctuation",
  hist.spans("z".repeat(45) + "\n" + "w".repeat(45)),
  ["z".repeat(45), "w".repeat(45)],
);

console.log("\n── (b) a planted drop is RED, and names who dropped it ──");
const planted = hist.find_drops(
  snaps(["001_seed.js", BODY_V1], ["002_unrelated.js", BODY_V1], ["003_rewrite.js", BODY_V2]),
);
check("exactly one span went missing", planted.length, 1);
// A blank stand-in keeps a regression reporting every field it broke instead of a traceback.
const found = planted.length ? planted[0]! : new hist.Drop("", "", "", "", "", "");
check("the finding quotes the dropped span verbatim", found.span, DROPPED);
check(
  "...on the right record",
  tup(found.slug, found.field),
  tup("collection:project_items", "body"),
);
check("...attributed to the rewriting migration", found.dropped_by, "003_rewrite.js");
check("...with the migration that introduced it", found.introduced_by, "001_seed.js");
check("...and the last migration that still carried it", found.last_present_in, "002_unrelated.js");

console.log("\n── (c) a restore is GREEN ──");
const restored = BODY_V2 + " " + DROPPED;
check(
  "re-seeding the span in a LATER migration clears the finding",
  hist.find_drops(
    snaps(["001_seed.js", BODY_V1], ["003_rewrite.js", BODY_V2], ["004_restore.js", restored]),
  ),
  [],
);
check(
  "a partial restore that reworded the span is still RED",
  hist.find_drops(
    snaps(
      ["001_seed.js", BODY_V1],
      ["003_rewrite.js", BODY_V2],
      ["004_partial.js", BODY_V2 + " That exposes nothing new."],
    ),
  ).length,
  1,
);
check(
  "deleting the record outright reports every one of its spans",
  hist.find_drops([
    ["001_seed.js", new Map([[rec_key("s", "body"), BODY_V1]])],
    ["002_purge.js", new Map()],
  ]).length,
  3,
);

console.log("\n── (d) allowlist matching: prefix keyed on (migration, slug) ──");
const KEY = ["003_rewrite.js", "collection:project_items", "That exposes nothing new:"];
const allow = (key: string[], reason: string) => new Map([[JSON.stringify(key), reason]]);
let [findings, allowed, stale] = hist.apply_allowlist(
  planted,
  allow(KEY, "superseded by PBTT-543"),
);
check("an allowlisted drop is not a finding", findings, []);
check(
  "...and is reported as allowed with its reason",
  allowed.map(([, r]) => r),
  ["superseded by PBTT-543"],
);
check("...and does not count as stale", stale, []);
for (const [label, key] of [
  ["wrong migration", ["099_other.js", KEY[1]!, KEY[2]!]],
  ["wrong slug", [KEY[0]!, "collection:tasks", KEY[2]!]],
  ["prefix that does not open the span", [KEY[0]!, KEY[1]!, "Read-only:"]],
] as [string, string[]][]) {
  [findings, allowed, stale] = hist.apply_allowlist(planted, allow(key, "superseded by PBTT-543"));
  check(`an entry with the ${label} does not swallow the drop`, findings.length, 1);
  check(`...and is itself reported stale (${label})`, stale.length, 1);
}

console.log("\n── (e) a stale allowlist entry is RED even with nothing else wrong ──");
[findings, allowed, stale] = hist.apply_allowlist([], allow(KEY, "superseded by PBTT-543"));
check("no drops, but the entry matches nothing", tup(findings, allowed), tup([], []));
check(
  "...so it is reported stale",
  stale.map(([k]) => k),
  [KEY],
);

console.log("\n── (f) every allowlist reason must cite a card or decision ──");
check("the shipped ALLOWLIST is well-formed", hist.allowlist_problems(hist.ALLOWLIST), []);
check("an empty reason is rejected", hist.allowlist_problems(allow(KEY, "   ")).length, 1);
check(
  "a reason with no citation token is rejected",
  hist.allowlist_problems(allow(KEY, "we decided this was fine")).length,
  1,
);
for (const token of ["PBTT-543", "TASK-061", "decision-021", "card nw9w"]) {
  check(
    `a reason citing ${token} is accepted`,
    hist.allowlist_problems(allow(KEY, `deliberate rewrite, see ${token}`)),
    [],
  );
}

console.log("\n── (g) the ratchet: filter on the DROPPING migration, never on introduction ──");
// Since bj2j the bound sits just above the re-seed that retired the SUPERSEDED WORDING
// convention, so that one migration and its predecessors are the whole grandfathered set;
// pinning the newest pre-baseline file survives every later migration and fails if the
// baseline moves again.
const GRANDFATHERED = fs
  .readdirSync(path.join(REPO_ROOT, "pb_migrations"))
  .filter((name) => name.endsWith(".js") && hist.stamp(name) < hist.stamp(hist.BASELINE));
check(
  "the newest grandfathered migration is the wording-retirement re-seed",
  // A baseline moved below the whole tree empties this set; report that as the failed
  // check it is rather than dying on an empty max.
  GRANDFATHERED.sort(by_code_point).at(-1) ?? "<none: BASELINE sits below every migration>",
  "1785180500_seed_app_docs_superseded_wording_retired.js",
);
// The pin above fixes the newest grandfathered file, so it catches a baseline moved DOWN but
// not one moved UP past the whole tree — the only direction that widens the amnesty, and the
// direction this card is itself the precedent for.
const LAST = fs
  .readdirSync(path.join(REPO_ROOT, "pb_migrations"))
  .filter((n) => n.endsWith(".js"))
  .sort(by_code_point)
  .at(-1)!;
const NEXT_SLOT = (Math.floor(hist.stamp(LAST) / 100) + 1) * 100;
check(
  "BASELINE never exceeds the next free migration slot",
  hist.stamp(hist.BASELINE) <= NEXT_SLOT,
  true,
);
check(
  "stamp() reads a migration basename",
  hist.stamp("1785161400_project_items_priority_rank.js"),
  1785161400,
);
check("stamp() accepts a bare timestamp", hist.stamp("1785161400"), 1785161400);

// Every fixture stamp below is positioned RELATIVE to the shipped baseline: a literal would
// silently change side — policed into grandfathered — the next time the baseline moves.
const BASE = hist.stamp(hist.BASELINE);

// The span is seeded LONG before the baseline and deleted by a migration after it. If the
// filter ever keys off introduction, this drop vanishes and the gate is silently gutted.
const old_seed_new_drop = hist.find_drops(
  snaps([`${BASE - 10000}_ancient.js`, BODY_V1], [`${BASE}_recent.js`, BODY_V2]),
);
let [policed, grandfathered] = hist.partition_baseline(
  old_seed_new_drop,
  hist.stamp(hist.BASELINE),
);
check(
  "a pre-baseline span dropped AT the baseline is policed",
  policed.map((d) => d.span),
  [DROPPED],
);
check("...and nothing is grandfathered", grandfathered, []);

const old_seed_old_drop = hist.find_drops(
  snaps([`${BASE - 10000}_ancient.js`, BODY_V1], [`${BASE - 100}_earlier.js`, BODY_V2]),
);
[policed, grandfathered] = hist.partition_baseline(old_seed_old_drop, hist.stamp(hist.BASELINE));
check("a drop one migration BEFORE the baseline is grandfathered", policed, []);
check("...and is still reported as grandfathered, not discarded", grandfathered.length, 1);

const new_seed_new_drop = hist.find_drops(
  snaps([`${BASE + 100}_recent_seed.js`, BODY_V1], [`${BASE + 500}_recent_drop.js`, BODY_V2]),
);
[policed, grandfathered] = hist.partition_baseline(new_seed_new_drop, hist.stamp(hist.BASELINE));
check("a wholly post-baseline drop is policed", policed.length, 1);
check(
  "every drop lands in exactly one half",
  policed.length + grandfathered.length,
  new_seed_new_drop.length,
);

console.log("\n── (h) forward-only: a span that never reached a snapshot cannot be missed ──");
check(
  "text present only in the FINAL snapshot raises nothing",
  hist.find_drops(snaps(["001_seed.js", BODY_V2], ["002_grow.js", BODY_V1])),
  [],
);
check("an empty history is not a failure", hist.find_drops([]), []);

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

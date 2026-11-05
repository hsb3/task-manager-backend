#!/usr/bin/env bun
/**
 * CI / pre-commit check: no prose ever seeded into an app_docs record may silently vanish.
 *
 * Replays `pb_migrations/` INCREMENTALLY into one throwaway data dir (no server, no network),
 * snapshotting `app_docs` after every migration, and asserts that every span of every
 * historical title/body still appears in that record's FINAL text. A re-seed migration is
 * expected to ADD and REWORD; it is not expected to delete a paragraph nobody noticed, which
 * is how the project_items trash-route wording disappeared. Bodies are read only from the
 * replayed sqlite DB — never by grepping migration source, whose quoting cannot be trusted
 * (.agents/memory/app-docs-quotes-apostrophe-tokenizer.md).
 *
 * Span unit: each title/body is cut at line breaks and sentence boundaries, whitespace
 * normalized, and chunks of at least MIN_SPAN_CHARS are tracked. The cut is derived, not
 * picked: run `spans()` over a full replay with the length gate removed and the chunk
 * lengths this corpus produces run min 14 / p10 51 / median 149, so 40 sits below the tenth
 * percentile and excludes about a twentieth of them. What it excludes is one kind of line —
 * short cross-references and one-clause verdicts ("See collection:tasks.", "Auth required.",
 * "RULED (owner-ratified 2026-07-27).") that are retargeted as a matter of course and whose
 * disappearance names no lost content. Raising the cut hides real prose; lowering it reports
 * every retargeted cross-reference.
 *
 * RATCHET: only drops attributed to a migration at or after BASELINE are policed; earlier
 * ones are counted and reported as grandfathered, never as findings. BASELINE is the stamp of
 * the baseline seed (gen_app_docs_seed.ts DEFAULT_OUTPUT), the one migration that seeds the
 * corpus, so the only grandfathered files are the baseline migrations before it, which seed no
 * prose; every re-seed lands above it. One window is narrower than that: a NEW migration
 * hand-stamped between the newest grandfathered file and BASELINE would be grandfathered too,
 * and nothing in this checker refuses it — `make next-migration-slot` cannot produce such a
 * stamp, and tests/test_app_docs_history_checker.ts is what refuses one, by pinning the newest
 * grandfathered file and the next free slot. The filter is on the DROPPING migration,
 * not on when the span was introduced — a span seeded long before the baseline and deleted
 * by a migration after it is still caught.
 *
 * Deliberate historical rewrites live in ALLOWLIST, keyed (dropping migration, slug, span
 * prefix) with a reason that must cite a card or decision; an entry matching no live drop
 * fails the run.
 *
 * Public API (tests/test_app_docs_history_checker.ts imports it): normalize, spans,
 * find_drops, partition_baseline, apply_allowlist, allowlist_problems, Drop, ALLOWLIST.
 * A (slug, field) record key and an ALLOWLIST key are JSON.stringify of the tuple.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  json_dumps,
  print,
  py_int,
  py_repr,
  py_split,
  py_strip,
  PY_WS,
  read_text,
  splitlines,
  tup,
  sqlite_connect,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";

export const REPO = repo_root(import.meta.path);
export const PB = pb_bin_path(REPO);
export const MIGRATIONS = path.join(REPO, "pb_migrations");

// Below the tenth percentile of this corpus's chunk lengths — derivation in the docstring.
export const MIN_SPAN_CHARS = 40;

const SPACE = PY_WS;
const WORD = String.raw`[\p{L}\p{N}_]`;

export const SENTENCE_BREAK = new RegExp(`(?<=[.!?])[${SPACE}]+`, "u");
export const CITATION = new RegExp(
  `(?<!${WORD})(PBTT-\\p{Nd}+|TASK-\\p{Nd}+|decision-\\p{Nd}+|card [0-9a-z]{4})(?!${WORD})`,
  "u",
);

// Oldest DROPPING migration this gate polices — ratchet rationale in the docstring.
export const BASELINE = "1785185300";

// JSON([dropping migration basename, slug, span prefix]) -> reason citing the card/decision.
export const ALLOWLIST = new Map<string, string>([]);

export class Drop {
  constructor(
    readonly slug: string,
    readonly field: string,
    readonly span: string,
    readonly introduced_by: string,
    readonly last_present_in: string,
    readonly dropped_by: string,
  ) {}
}

type Snapshot = [string, Map<string, string>];
const rec_key = (slug: string, field: string): string => JSON.stringify([slug, field]);

/** Collapse every whitespace run to a single space so re-wrapping is not a difference. */
export function normalize(text: string | null): string {
  return py_strip((text || "").replace(new RegExp(`[${SPACE}]+`, "gu"), " "));
}

/** Cut `text` at line breaks and sentence boundaries -> normalized chunks worth tracking. */
export function spans(text: string | null): string[] {
  const out: string[] = [];
  for (const line of splitlines(text || "")) {
    for (let chunk of line.split(SENTENCE_BREAK)) {
      chunk = normalize(chunk);
      if ([...chunk].length >= MIN_SPAN_CHARS) out.push(chunk);
    }
  }
  return out;
}

/**
 * -> every span present in some snapshot and absent from the LAST one.
 *
 * `snapshots` is (migration basename, {(slug, field): text}) in application order; the
 * final entry is the state the repo actually ships.
 */
export function find_drops(snapshots: Snapshot[]): Drop[] {
  if (!snapshots.length) return [];
  const final = new Map<string, string>();
  for (const [key, text] of snapshots[snapshots.length - 1]![1]) final.set(key, normalize(text));

  const first_seen = new Map<string, number>();
  const last_seen = new Map<string, number>();
  for (const [index, [, records]] of snapshots.entries()) {
    for (const [rk, text] of records) {
      const [slug, field] = JSON.parse(rk) as [string, string];
      for (const span of spans(text)) {
        const key = JSON.stringify([slug, field, span]);
        if (!first_seen.has(key)) first_seen.set(key, index);
        last_seen.set(key, index);
      }
    }
  }

  const drops: Drop[] = [];
  for (const [key, last_index] of last_seen) {
    const [slug, field, span] = JSON.parse(key) as [string, string, string];
    const haystack = final.get(rec_key(slug, field));
    if (haystack !== undefined && haystack.includes(span)) continue;
    drops.push(
      new Drop(
        slug,
        field,
        span,
        snapshots[first_seen.get(key)!]![0],
        snapshots[last_index]![0],
        snapshots[last_index + 1]![0],
      ),
    );
  }
  return drops.sort(
    (a, b) =>
      by_code_point(a.dropped_by, b.dropped_by) ||
      by_code_point(a.slug, b.slug) ||
      by_code_point(a.field, b.field) ||
      by_code_point(a.span, b.span),
  );
}

/** -> the leading timestamp of a migration basename; accepts a bare timestamp too. */
export function stamp(migration: string): number {
  return py_int(py_split(migration, "_", 1)[0]!);
}

/**
 * -> (policed, grandfathered), split on the DROPPING migration's timestamp.
 *
 * When the span was introduced is deliberately irrelevant: a span seeded before `since`
 * and deleted by a migration at or after it is policed.
 */
export function partition_baseline(drops: Drop[], since: number): [Drop[], Drop[]] {
  const policed = drops.filter((d) => stamp(d.dropped_by) >= since);
  return tup(
    policed,
    drops.filter((d) => stamp(d.dropped_by) < since),
  );
}

/** -> one message per malformed entry; a reason with no card/decision token is not one. */
export function allowlist_problems(allowlist: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, reason] of allowlist) {
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      parts = null;
    }
    if (!(
      Array.isArray(parts) &&
      parts.length === 3 &&
      parts.every((p) => typeof p === "string")
    )) {
      problems.push(`${py_repr(key)}: key must be (migration, slug, span prefix)`);
      continue;
    }
    if (typeof reason !== "string" || !py_strip(reason)) {
      problems.push(`${parts[0]} / ${parts[1]}: reason is empty`);
    } else if (!CITATION.test(reason)) {
      problems.push(
        `${parts[0]} / ${parts[1]}: reason cites no card or decision ` +
          `(PBTT-n, TASK-n, decision-n, card <ref>): ${py_repr(reason)}`,
      );
    }
  }
  return problems;
}

/**
 * -> (findings, allowed, stale entries). Matching is by span PREFIX, so a reworded tail
 * still matches, but a rewritten opening deliberately does not.
 */
export function apply_allowlist(
  drops: Drop[],
  allowlist: Map<string, string>,
): [Drop[], [Drop, string][], [[string, string, string], string][]] {
  const findings: Drop[] = [];
  const allowed: [Drop, string][] = [];
  const hit = new Set<string>();
  const keys = [...allowlist.keys()].map(
    (k) => [k, JSON.parse(k) as [string, string, string]] as const,
  );
  for (const drop of drops) {
    const match = keys.find(
      ([, key]) =>
        key[0] === drop.dropped_by && key[1] === drop.slug && drop.span.startsWith(key[2]),
    );
    if (match === undefined) {
      findings.push(drop);
      continue;
    }
    hit.add(match[0]);
    allowed.push([drop, allowlist.get(match[0])!]);
  }
  const stale = keys
    .filter(([k]) => !hit.has(k))
    .map(([k, key]): [[string, string, string], string] => [key, allowlist.get(k)!]);
  return [findings, allowed, stale];
}

/** -> {(slug, "title"|"body"): text}; empty before the app_docs collection exists. */
function _read_app_docs(data_dir: string): Map<string, string> {
  const con = sqlite_connect(path.join(data_dir, "data.db"));
  let rows: { slug: string; title: string | null; body: string | null }[];
  try {
    rows = con.query("SELECT slug, title, body FROM app_docs").all() as typeof rows;
  } catch {
    return new Map();
  } finally {
    con.close();
  }
  const out = new Map<string, string>();
  for (const { slug, title, body } of rows) {
    out.set(rec_key(slug, "title"), title || "");
    out.set(rec_key(slug, "body"), body || "");
  }
  return out;
}

/** Apply each migration in order into one data dir, snapshotting app_docs after each. */
export function replay(
  pb: string,
  migrations_dir: string,
  scratch: string,
): [Snapshot[], string | null] {
  const names = fs
    .readdirSync(migrations_dir)
    .filter((n) => n.endsWith(".js"))
    .sort(by_code_point);
  if (!names.length) return [[], `no .js migrations under ${migrations_dir}`];
  const staged = path.join(scratch, "mig");
  const data = path.join(scratch, "pb_data");
  fs.mkdirSync(staged, { recursive: true });
  const snapshots: Snapshot[] = [];
  for (const name of names) {
    fs.copyFileSync(path.join(migrations_dir, name), path.join(staged, name));
    const [ok, out] = migrate_up(pb, data, staged);
    if (!ok) return [snapshots, `\`migrate up\` failed at ${name}:\n${out}`];
    snapshots.push([name, _read_app_docs(data)]);
  }
  return [snapshots, null];
}

const HELP = `usage: check_app_docs_history.ts [-h] [--migrations-dir MIGRATIONS_DIR]
                                 [--since MIGRATION] [--json]

Fail any app_docs prose that a later migration silently dropped (incremental
replay, no server).

options:
  -h, --help            show this help message and exit
  --migrations-dir MIGRATIONS_DIR
                        default: repo pb_migrations/
  --since MIGRATION     police drops at/after this migration or timestamp
                        (default: 1785185300)
  --json                machine-readable report

RATCHET BOUND: only drops attributed to a migration at or after 1785185300 are
policed. Earlier ones are grandfathered and counted in the coverage block of
every run. That is not suppression: a historical migration cannot be edited
(repo law, hook-enforced), so a pre-baseline drop can never change or recur,
and every future re-seed lands above the baseline. The filter is on the
DROPPING migration, so a span seeded before the baseline and deleted after it
is still caught. SCOPE BOUNDS: only app_docs \`title\` and \`body\` are tracked,
and only forward — a span that never reached a snapshot cannot be missed.
Chunks shorter than 40 characters are not tracked. Presence is substring on
the whitespace-normalized FINAL text, so a re-wrap is not a drop but any re-
wording inside a tracked span is. A record deleted outright reports every one
of its spans.`;

export function main(): number {
  const usage = HELP.slice(0, HELP.indexOf("\n\n"));
  const args = parse_args(
    usage,
    HELP + "\n",
    [
      ["--migrations-dir", "store", "migrations_dir"],
      ["--since", "store", "since"],
      ["--json", "store_true", "json"],
    ],
    { migrations_dir: MIGRATIONS, since: BASELINE, json: false },
  );

  let since: number;
  try {
    since = stamp(args.since);
  } catch {
    print(
      `❌ check_app_docs_history: --since needs a migration basename or timestamp, got ${py_repr(args.since)}`,
    );
    return 2;
  }

  const problems = allowlist_problems(ALLOWLIST);
  if (problems.length) {
    for (const problem of problems) {
      print(`❌ check_app_docs_history: malformed ALLOWLIST entry — ${problem}`);
    }
    return 2;
  }
  if (!fs.existsSync(PB)) {
    print(
      `❌ check_app_docs_history: no pocketbase at ${PB} — run \`make pocketbase\`. ` +
        `A missing binary is a setup error, not a reason to pass.`,
    );
    return 2;
  }
  if (!fs.statSync(args.migrations_dir, { throwIfNoEntry: false })?.isDirectory()) {
    print(`❌ check_app_docs_history: no migrations dir at ${args.migrations_dir}`);
    return 2;
  }

  const started = performance.now() / 1000;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pbdocshist_"));
  let snapshots: Snapshot[];
  let error: string | null;
  try {
    [snapshots, error] = replay(PB, args.migrations_dir, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const elapsed = performance.now() / 1000 - started;
  if (error) {
    print(`❌ check_app_docs_history: ${error}`);
    return 2;
  }

  const [policed, grandfathered] = partition_baseline(find_drops(snapshots), since);
  const [findings, allowed, stale] = apply_allowlist(policed, ALLOWLIST);
  const tracked_keys = new Set<string>();
  for (const [, recs] of snapshots) {
    for (const [rk, t] of recs) {
      const [slug, field] = JSON.parse(rk) as [string, string];
      for (const span of spans(t)) tracked_keys.add(JSON.stringify([slug, field, span]));
    }
  }
  const tracked = tracked_keys.size;
  const final_slugs = [
    ...new Set(
      [...snapshots[snapshots.length - 1]![1].keys()]
        .map((rk) => JSON.parse(rk) as [string, string])
        .filter(([, field]) => field === "body")
        .map(([slug]) => slug),
    ),
  ].sort(by_code_point);

  if (args.json) {
    print(
      json_dumps(
        {
          ok: !findings.length && !stale.length,
          migrations_replayed: snapshots.length,
          records: final_slugs.length,
          tracked_spans: tracked,
          seconds: Math.round(elapsed * 10) / 10,
          baseline: args.since,
          grandfathered: grandfathered.length,
          grandfathered_migrations: [...new Set(grandfathered.map((d) => d.dropped_by))].sort(
            by_code_point,
          ),
          findings: findings.map((d) => ({
            slug: d.slug,
            field: d.field,
            span: d.span,
            introduced_by: d.introduced_by,
            last_present_in: d.last_present_in,
            dropped_by: d.dropped_by,
          })),
          allowlisted: allowed.map(([d, reason]) => ({
            slug: d.slug,
            field: d.field,
            span: d.span,
            dropped_by: d.dropped_by,
            reason,
          })),
          stale_allowlist: stale.map(([k, reason]) => ({
            migration: k[0],
            slug: k[1],
            span_prefix: k[2],
            reason,
          })),
        },
        { indent: 2 },
      ),
    );
    return findings.length || stale.length ? 1 : 0;
  }

  for (const drop of findings) {
    print(`❌ ${drop.slug} lost prose from its ${drop.field} — dropped by ${drop.dropped_by}`);
    print(`     span:  ${drop.span}`);
    print(
      `     since: introduced by ${drop.introduced_by}, last present in ${drop.last_present_in}`,
    );
    print(
      "     fix:   re-seed the span in a NEW migration, or allowlist it with the " +
        "card that decided the rewrite",
    );
  }

  for (const [key, reason] of stale) {
    print(`❌ stale allowlist entry ${key[0]} / ${key[1]}: ${reason}`);
    print("     no live drop matches that span prefix any more — drop the entry");
  }

  if (allowed.length) {
    print(`allowlisted rewrites (${allowed.length}):`);
    for (const [drop, reason] of allowed) {
      print(`  • ${drop.slug}.${drop.field} @ ${drop.dropped_by} — ${reason}`);
    }
  }

  print("coverage:");
  print(
    `  • replayed ${snapshots.length} migrations, snapshotting app_docs after each; ` +
      `${tracked} spans of >= ${MIN_SPAN_CHARS} chars tracked across ` +
      `${final_slugs.length} records (${elapsed.toFixed(1)}s)`,
  );
  print(
    `  • NOT tracked: chunks under ${MIN_SPAN_CHARS} chars, and every app_docs column ` +
      "other than title/body",
  );
  print(
    `  • RATCHET: policing drops from ${args.since} onward; ` +
      `${grandfathered.length} earlier drop(s) across ` +
      `${new Set(grandfathered.map((d) => d.dropped_by)).size} migration(s) are grandfathered — those ` +
      "migrations are immutable, so those drops cannot change or recur, and every future " +
      "re-seed lands above the baseline",
  );

  if (findings.length || stale.length) {
    print(
      `❌ check_app_docs_history: ${findings.length} dropped span(s), ` +
        `${stale.length} stale allowlist entr(ies).`,
    );
    return 1;
  }
  print(
    `✅ check_app_docs_history: no unexplained prose loss at or after ${args.since} — ` +
      `${policed.length} drop(s) there, every one accounted for (${allowed.length} allowlisted); ` +
      `${tracked} spans tracked across ${final_slugs.length} records, ` +
      `${grandfathered.length} pre-baseline drop(s) grandfathered.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

#!/usr/bin/env bun
/**
 * Static check: `migrate up` -> `migrate down N` -> `migrate up` must LOSE no app_docs span.
 *
 * An app_docs seed migration's `down()` is a documented no-op ("app_docs prose is
 * re-established on any fresh boot") — reverting one does not undo its `extend()` calls, so
 * reapplying it after a partial revert re-runs `extend()` a second time and DUPLICATES the
 * appended text (measured: g2act1col2docs3 grows 3160 -> 4412 bytes, a fragment appearing
 * twice, when replaying `down 3` across the v1 seed that added the ownership-transfer record).
 * That duplication is the ACCEPTED cost of the no-op `down()` and is not what this gate
 * polices — it asserts only that no span present before the round trip goes MISSING after it,
 * the failure mode a real revert-then-reapply (an operator undoing a bad recent migration)
 * could actually produce.
 *
 * N is derived, not fixed: it reverts back through (and including) the older of the last TWO
 * `seed_app_docs*.js` migrations in the CURRENT `pb_migrations/`, so the round trip always
 * exercises real recent app_docs mutation as the migration set grows, rather than a stale
 * depth that eventually reverts too far or not far enough.
 *
 * Home: `make check-static`, which runs every scripts/check_*.ts and which the pre-commit hook
 * runs too (lefthook.yml), so every commit pays for the replay plus the down+up pass.
 *
 * Span definition, `normalize`/`spans`/`MIN_SPAN_CHARS`, are imported (read-only) from
 * scripts/check_app_docs_history.ts, whose own docstring declares them a public API.
 * A record id is a Map key and a (id, field, span) / (id, before_len, after_len) result is a tuple.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { by_code_point, decode_text, print, py_repr, tup, sqlite_connect } from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import { MIN_SPAN_CHARS, normalize, spans } from "./check_app_docs_history.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";
import { copy_tree } from "./_scratch_copy.ts";

const REPO = repo_root(import.meta.path);
const PB = pb_bin_path(REPO);
const MIGRATIONS = path.join(REPO, "pb_migrations");

const SEED_MARKER = "seed_app_docs";

const len = (s: string): number => [...s].length;

/** How many trailing migrations to revert, or None when there is nothing to round-trip. */
export function round_trip_depth(migrations_dir: string): number | null {
  const names = fs
    .readdirSync(migrations_dir)
    .filter((n) => n.endsWith(".js"))
    .sort(by_code_point);
  const seed_positions: number[] = [];
  names.forEach((n, i) => {
    if (n.includes(SEED_MARKER)) seed_positions.push(i);
  });
  if (!seed_positions.length) return null;
  const window = seed_positions.length >= 2 ? seed_positions.slice(-2) : seed_positions.slice(-1);
  return names.length - Math.min(...window);
}

/** Revert the last `n` applied migrations. `y\n` answers PB's revert confirmation prompt. */
export function migrate_down(
  pb: string,
  data_dir: string,
  migrations_dir: string,
  n: number,
): [boolean, string] {
  const r = Bun.spawnSync(
    [pb, "migrate", "down", String(n), "--dir", data_dir, "--migrationsDir", migrations_dir],
    { stdin: Buffer.from("y\n") },
  );
  const out = decode_text(r.stdout) + decode_text(r.stderr);
  const reverted = (out.match(/^Reverted /gm) ?? []).length;
  // No output-line scan: the exit status is the whole verdict (owner ruling on ej2j, 2026-09-19).
  const ok = r.exitCode === 0 && reverted === n;
  return [ok, out];
}

/** -> {id: (title, body)}; empty before the app_docs collection exists. */
export function read_app_docs(data_dir: string): Map<string, [string, string]> {
  const con = sqlite_connect(path.join(data_dir, "data.db"));
  try {
    const rows = con.query("SELECT id, title, body FROM app_docs").values() as [
      string,
      string | null,
      string | null,
    ][];
    return new Map(rows.map(([rid, title, body]) => [rid, [title || "", body || ""]]));
  } catch {
    return new Map();
  } finally {
    con.close();
  }
}

/** -> (id, field, span) for every span present before the round trip and absent after. */
export function find_lost_spans(
  before: Map<string, [string, string]>,
  after: Map<string, [string, string]>,
): [string, string, string][] {
  const lost: [string, string, string][] = [];
  for (const [rid, [before_title, before_body]] of before) {
    const [after_title, after_body] = after.get(rid) ?? ["", ""];
    const after_title_n = normalize(after_title);
    const after_body_n = normalize(after_body);
    for (const [field, text, haystack] of [
      ["title", before_title, after_title_n],
      ["body", before_body, after_body_n],
    ] as const) {
      for (const span of spans(text)) {
        if (!haystack.includes(span)) lost.push(tup(rid, field, span));
      }
    }
  }
  return lost;
}

/** -> (id, before_len, after_len) for every record whose body grew — the accepted no-op. */
export function growth(
  before: Map<string, [string, string]>,
  after: Map<string, [string, string]>,
): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const [rid, [, before_body]] of before) {
    const after_body = (after.get(rid) ?? ["", ""])[1];
    if (len(after_body) > len(before_body)) {
      out.push(tup(rid, len(before_body), len(after_body)));
    }
  }
  return out.sort((a, b) => by_code_point(a[0], b[0]));
}

const USAGE = "usage: check_app_docs_down_up.ts [-h] [--migrations-dir MIGRATIONS_DIR]";
const HELP = `${USAGE}

Assert a migrate-down-then-up round trip loses no app_docs span (a documented
body-growth no-op is accepted, a span going missing is not).

options:
  -h, --help            show this help message and exit
  --migrations-dir MIGRATIONS_DIR
                        default: repo pb_migrations/

Span unit is scripts/check_app_docs_history.ts's own (${MIN_SPAN_CHARS}+ char, sentence/line-
cut) definition. ACCEPTED NO-OP: an app_docs seed migration's down() does not
undo its extend() calls, so a reverted-and-reapplied seed duplicates its
appended text — this gate does not fail on that growth, only on a span going
missing, which a real operator revert-then-reapply could produce.
`;

export function main(): number {
  const args = parse_args(USAGE, HELP, [["--migrations-dir", "store", "migrations_dir"]], {
    migrations_dir: MIGRATIONS,
  });

  if (!fs.existsSync(PB)) {
    print(`❌ check_app_docs_down_up: no pocketbase at ${PB} — run \`make pocketbase\`.`);
    return 2;
  }
  if (!fs.statSync(args.migrations_dir, { throwIfNoEntry: false })?.isDirectory()) {
    print(`❌ check_app_docs_down_up: no migrations dir at ${args.migrations_dir}`);
    return 2;
  }

  const n = round_trip_depth(args.migrations_dir);
  if (n === null) {
    print(
      "✅ check_app_docs_down_up: no seed_app_docs*.js migration in " +
        `${args.migrations_dir} — nothing to round-trip.`,
    );
    return 0;
  }

  const started = performance.now() / 1000;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pbdocsdownup_"));
  let before: Map<string, [string, string]>;
  let after: Map<string, [string, string]>;
  try {
    const staged = path.join(scratch, "mig");
    const data = path.join(scratch, "pb_data");
    copy_tree(args.migrations_dir, staged);

    let [ok, out] = migrate_up(PB, data, staged);
    if (!ok) {
      print(`❌ check_app_docs_down_up: initial \`migrate up\` failed:\n${out}`);
      return 2;
    }
    before = read_app_docs(data);

    [ok, out] = migrate_down(PB, data, staged, n);
    if (!ok) {
      print(`❌ check_app_docs_down_up: \`migrate down ${n}\` did not cleanly revert:\n${out}`);
      return 2;
    }

    [ok, out] = migrate_up(PB, data, staged);
    if (!ok) {
      print(`❌ check_app_docs_down_up: re-\`migrate up\` after the revert failed:\n${out}`);
      return 2;
    }
    after = read_app_docs(data);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const elapsed = performance.now() / 1000 - started;

  const lost = find_lost_spans(before, after);
  if (lost.length) {
    print(
      `❌ check_app_docs_down_up: down(${n})+up dropped ${lost.length} span(s) present ` +
        "before the round trip:",
    );
    for (const [rid, field, span] of lost) {
      print(`     • ${rid}.${field}: ${py_repr([...span].slice(0, 100).join(""))}`);
    }
    return 1;
  }

  const grew = growth(before, after);
  print(
    `✅ check_app_docs_down_up: migrate up -> down(${n}) -> up lost no span across ` +
      `${before.size} app_docs record(s) (${elapsed.toFixed(1)}s).`,
  );
  if (grew.length) {
    print(
      "   accepted no-op — a seed migration's down() does not undo its extend() calls, " +
        "so a reverted-and-reapplied seed's body grows (its span is still present, just " +
        "duplicated):",
    );
    for (const [rid, before_len, after_len] of grew) {
      print(`     • ${rid}: ${before_len} -> ${after_len} bytes`);
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

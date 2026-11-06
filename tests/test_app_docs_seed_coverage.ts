#!/usr/bin/env bun
/**
 * A fresh boot's app_docs + app_settings rows equal the newest seed's own data arrays, column for column.
 *
 * Replays pb_migrations/ (no server, no port) and compares every FIELDS column of every app_docs
 * row and every app_settings (id, key, value) row against the rows parsed out of the seed source,
 * both directions. bounded: the replay APPLIES the seed, so a hand edit that changes the seed's data
 * consistently moves both sides together and is invisible here; this sees the replayed database
 * diverging from the seed (another migration writing these tables, a template edit, a dropped row).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { read_text, sqlite_connect } from "../scripts/_py.ts";
import { DEFAULT_OUTPUT, FIELDS } from "../scripts/gen_app_docs_seed.ts";
import { migrate_up, pb_bin_path } from "../scripts/pb_migrate.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB = pb_bin_path(REPO_ROOT);
const MIGRATIONS = path.join(REPO_ROOT, "pb_migrations");
const SEED_FILE = path.basename(DEFAULT_OUTPUT);
const BOUND =
  "a hand edit that changes the seed's data consistently is invisible (the replay applies the edited file); " +
  "a replayed database diverging from the seed is visible";

type Obj = Record<string, any>;
const FAILS: string[] = [];

function check(label: string, ok: boolean, detail: string = ""): void {
  console.log(`  ${ok ? "✅" : "❌"}  ${label}` + (detail ? ` → ${detail}` : ""));
  if (!ok) FAILS.push(label);
}

/** The JSON array literal between two generated-template anchors; each anchor must occur exactly once. */
function slice_array(text: string, open: string, close: string): Obj[] {
  const [a, b] = [text.split(open), text.split(close)];
  if (a.length !== 2 || b.length < 2)
    throw new Error(`seed anchors not found once: ${open.trim()}`);
  const body = a[1]!.slice(0, a[1]!.indexOf(close));
  return JSON.parse(`[${body.replace(/,\s*$/, "")}]`);
}

function seed_rows(migrations_dir: string): { settings: Obj[]; docs: Obj[] } {
  const text = read_text(path.join(migrations_dir, SEED_FILE));
  return {
    settings: slice_array(text, "for (const data of [\n", "\n  ]) {"),
    docs: slice_array(text, "const records = [\n", "\n  ]\n"),
  };
}

/** Rows present on one side only, and every differing column, keyed by id. */
function diff_rows(table: string, cols: string[], seed: Obj[], db: Obj[]): string[] {
  const out: string[] = [];
  const by_id = (rows: Obj[]) => new Map(rows.map((r) => [r.id, r]));
  const [s, d] = [by_id(seed), by_id(db)];
  for (const id of s.keys())
    if (!d.has(id)) out.push(`${table} ${id}: in the seed, missing from the database`);
  for (const id of d.keys())
    if (!s.has(id)) out.push(`${table} ${id}: in the database, missing from the seed`);
  for (const [id, row] of s) {
    for (const c of cols) {
      if (d.has(id) && !Bun.deepEquals(row[c], d.get(id)![c], true)) {
        out.push(
          `${table} ${id}.${c}: seed ${JSON.stringify(row[c])?.slice(0, 60)} ≠ database ${JSON.stringify(d.get(id)![c])?.slice(0, 60)}`,
        );
      }
    }
  }
  return out;
}

/** Replay `migrations_dir` and diff its database against its own seed file: [diffs, docs compared, settings compared]. */
function compare(migrations_dir: string): [string[], number, number] {
  const data_dir = fs.mkdtempSync(path.join(os.tmpdir(), "v65a-seedcov-"));
  try {
    const [ok, out] = migrate_up(PB, data_dir, migrations_dir);
    if (!ok) return [[`\`migrate up\` failed: ${out}`], 0, 0];
    const con = sqlite_connect(path.join(data_dir, "data.db"));
    try {
      const docs = con.query(`SELECT ${FIELDS.join(", ")} FROM app_docs`).all() as Obj[];
      const settings = (con.query("SELECT id, key, value FROM app_settings").all() as Obj[]).map(
        (r) => ({
          ...r,
          value: JSON.parse(r.value),
        }),
      );
      const seed = seed_rows(migrations_dir);
      return [
        [
          ...diff_rows("app_docs", FIELDS, seed.docs, docs),
          ...diff_rows("app_settings", ["id", "key", "value"], seed.settings, settings),
        ],
        docs.length,
        settings.length,
      ];
    } finally {
      con.close();
    }
  } finally {
    fs.rmSync(data_dir, { recursive: true, force: true });
  }
}

/** Run `compare` on a scratch copy of pb_migrations after `mutate` edits it. */
function mutated(mutate: (dir: string) => void): [string[], number, number] {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), "v65a-seedcov-mut-"));
  try {
    const dir = path.join(S, "pb_migrations");
    fs.cpSync(MIGRATIONS, dir, { recursive: true, dereference: true });
    mutate(dir);
    return compare(dir);
  } finally {
    fs.rmSync(S, { recursive: true, force: true });
  }
}

const edit_seed = (from: string, to: string) => (dir: string) => {
  const f = path.join(dir, SEED_FILE);
  const t = read_text(f);
  if (t.split(from).length - 1 !== 1) throw new Error(`mutation anchor not found once: ${from}`);
  fs.writeFileSync(
    f,
    t.replace(from, () => to),
  );
};

console.log(`\n── §1 a fresh boot holds exactly what ${SEED_FILE} says ──`);
const [diffs, n_docs, n_settings] = compare(MIGRATIONS);
for (const d of diffs) console.log(`    ❌ ${d}`);
check("the replay seeded app_docs and app_settings at all", n_docs > 0 && n_settings > 0);
check(
  `every app_docs row matches on ${FIELDS.join("/")}`,
  !diffs.some((d) => d.startsWith("app_docs")),
  `${n_docs} rows compared`,
);
check(
  "every app_settings row matches on id/key/value",
  !diffs.some((d) => d.startsWith("app_settings")),
  `${n_settings} rows compared`,
);

console.log("\n── §2 negative control: a template edit goes red ──");
const [t_diffs] = mutated(
  edit_seed(`rec.set("refName", data.refName)`, `rec.set("refName", data.refName + "x")`),
);
check(
  "the refName template edit is caught on the column comparison",
  t_diffs.some((d) => /^app_docs \S+\.refName:/.test(d)),
  `${t_diffs.length} diffs`,
);

console.log("\n── §3 measured bound: a consistent hand edit to the seed's data ──");
const [v_diffs] = mutated(
  edit_seed(`"slug": "collection:api_keys"`, `"slug": "collection:api_keyz"`),
);
check(
  `bound holds: the slug edit is ${v_diffs.length ? "VISIBLE" : "invisible"} to this comparison`,
  v_diffs.length === 0,
  v_diffs[0] ?? "both sides moved together",
);

console.log("\n── §4 positive control: a later migration rewriting a seeded row goes red ──");
const [p_diffs] = mutated((dir) => {
  const id = seed_rows(dir).docs[0]!.id;
  // Stamped after every migration in the copy, so the probe runs last whatever the newest seed is.
  const last = Math.max(...fs.readdirSync(dir).map((f) => parseInt(f, 10) || 0));
  fs.writeFileSync(
    path.join(dir, `${last + 100}_probe.js`),
    `migrate((app) => {\n  const r = app.findRecordById("app_docs", "${id}")\n  r.set("refName", "probe_drift")\n  app.save(r)\n}, () => {})\n`,
  );
});
for (const d of p_diffs) console.log(`    (expected) ${d}`);
check(
  "the probe migration's refName drift is caught",
  p_diffs.length === 1 && /\.refName:/.test(p_diffs[0]!),
);

console.log(`\nbounded: ${BOUND}`);
console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} app_docs seed coverage check(s) FAILED`);
  process.exit(1);
}
console.log(`✅ the replayed app_docs + app_settings equal ${SEED_FILE}`);
process.exit(0);

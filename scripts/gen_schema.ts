#!/usr/bin/env bun
/**
 * Generate schema/ — per-collection field/rule docs derived from pb_migrations/.
 *
 * Replays migrations into a throwaway data.db (same approach as gen_openapi.ts) and
 * writes, per app collection, <name>.json (fields + indexes) and <name>.rules.json;
 * view collections get a single <name>.view.json (rules + viewQuery only — their
 * field ids are per-boot clones and must never be diffed). Also writes
 * pb_hooks/field_patterns.json, which pb_hooks/schema_guards.pb.js reads at serve.
 * --check fails on any drift, including stray schema/*.json files no collection
 * produces, and a missing or stale pb_hooks/field_patterns.json.
 *
 * Usage: bun scripts/gen_schema.ts [--check]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { by_code_point, json_dumps, py_repr, read_text, sqlite_connect } from "./_py.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";
import { copy_tree } from "./_scratch_copy.ts";

const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));
const PB = pb_bin_path(REPO);
const MIGRATIONS = path.join(REPO, "pb_migrations");
const SCHEMA_DIR = path.join(REPO, "schema");
// pb_hooks/schema_guards.pb.js reads this at serve; schema/ is not shipped to the container.
const PATTERNS_FILE = path.join(REPO, "pb_hooks", "field_patterns.json");

const RULE_KEYS = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];

export function fetch_collections(migrations_dir: string = MIGRATIONS): any[] {
  /**
   * Replay migrations into a temp dir and return app (system=0) `_collections`
   * rows. Raises Error if ./pocketbase is absent or `migrate up` fails.
   * Copies pb_migrations/ into the temp dir first — never points the tool at the
   * tracked repo directory.
   */
  if (!fs.existsSync(PB)) {
    throw new Error(
      `no ./pocketbase at ${PB} — run \`make pocketbase\`. ` +
        `A missing binary is a setup error, not a reason to pass.`,
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbschema_"));
  let rows: any[];
  try {
    const mig = path.join(tmp, "pb_migrations");
    copy_tree(migrations_dir, mig);
    const data = path.join(tmp, "data");
    const [ok, out] = migrate_up(PB, data, mig);
    if (!ok) {
      throw new Error("`migrate up` failed:\n" + out);
    }

    const con = sqlite_connect(path.join(data, "data.db"));
    try {
      rows = con
        .query(
          "SELECT name, type, fields, indexes, " +
            "listRule, viewRule, createRule, updateRule, deleteRule, options " +
            "FROM _collections WHERE system = 0 ORDER BY name",
        )
        .all();
    } finally {
      con.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    fields: JSON.parse(r.fields),
    indexes: JSON.parse(r.indexes || "[]"),
    listRule: r.listRule,
    viewRule: r.viewRule,
    createRule: r.createRule,
    updateRule: r.updateRule,
    deleteRule: r.deleteRule,
    options: JSON.parse(r.options || "{}"),
  }));
}

function _dumps(doc: any): string {
  return json_dumps(doc, { indent: 2, ensure_ascii: false }) + "\n";
}

/** Return {filename: content} for every schema/ file the collections produce. */
function render(cols: any[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const c of cols) {
    const name = c.name;
    if (c.type === "view") {
      files.set(
        `${name}.view.json`,
        _dumps({
          name,
          type: "view",
          listRule: c.listRule,
          viewRule: c.viewRule,
          viewQuery: c.options.viewQuery ?? null,
        }),
      );
      continue;
    }

    files.set(
      `${name}.json`,
      _dumps({
        name,
        type: c.type,
        fields: c.fields,
        indexes: c.indexes,
      }),
    );
    const rules: Record<string, any> = {};
    for (const k of RULE_KEYS) rules[k] = c[k];
    if (c.type === "auth") {
      rules.authRule = c.options.authRule ?? null;
      rules.manageRule = c.options.manageRule ?? null;
    }
    files.set(`${name}.rules.json`, _dumps(rules));
  }
  return files;
}

/** {collection: {field: pattern}} for every non-empty pattern, sorted both levels. */
function render_patterns(cols: any[]): string {
  const doc: Record<string, any> = {};
  for (const c of [...cols].sort((a, b) => by_code_point(a.name, b.name))) {
    if (c.type === "view") continue;
    const fields: Record<string, any> = {};
    for (const f of c.fields) if (f.pattern) fields[f.name] = f.pattern;
    const names = Object.keys(fields).sort(by_code_point);
    if (names.length) {
      const sorted: Record<string, any> = {};
      for (const n of names) sorted[n] = fields[n];
      doc[c.name] = sorted;
    }
  }
  return _dumps(doc);
}

function _patterns_on_disk(): string | null {
  try {
    return read_text(PATTERNS_FILE);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function _on_disk(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(SCHEMA_DIR) || !fs.statSync(SCHEMA_DIR).isDirectory()) return out;
  for (const fn of fs.readdirSync(SCHEMA_DIR).sort(by_code_point)) {
    if (fn.endsWith(".json")) out.set(fn, read_text(path.join(SCHEMA_DIR, fn)));
  }
  return out;
}

function _check(files: Map<string, string>, patterns: string): number {
  const disk = _on_disk();
  const missing = [...files.keys()].filter((f) => !disk.has(f)).sort(by_code_point);
  const stray = [...disk.keys()].filter((f) => !files.has(f)).sort(by_code_point);
  const changed = [...files.keys()]
    .filter((f) => disk.has(f) && files.get(f) !== disk.get(f))
    .sort(by_code_point);
  const patterns_disk = _patterns_on_disk();

  if (!(missing.length || stray.length || changed.length) && patterns_disk === patterns) {
    console.log(
      `✅ gen_schema --check: schema/ is up to date (${files.size} files), ` +
        `and pb_hooks/field_patterns.json matches.`,
    );
    return 0;
  }

  if (patterns_disk === null) {
    console.log("❌ gen_schema --check: pb_hooks/field_patterns.json is missing.");
  } else if (patterns_disk !== patterns) {
    console.log(
      "❌ gen_schema --check: pb_hooks/field_patterns.json is out of date with the " +
        "pb_migrations schema.",
    );
  }

  for (const fn of missing) console.log(`❌ gen_schema --check: schema/${fn} is missing.`);
  for (const fn of stray) console.log(`❌ gen_schema --check: schema/${fn} matches no collection.`);
  for (const fn of changed) {
    console.log(
      `❌ gen_schema --check: schema/${fn} is out of date with the pb_migrations schema.`,
    );
  }
  console.log("   Run `bun scripts/gen_schema.ts` to regenerate schema/.");
  return 1;
}

function main(): number {
  const usage = "usage: gen_schema.ts [-h] [--check]";
  const help =
    `${usage}\n\nGenerate schema/ — per-collection field/rule docs derived from pb_migrations/.\n\n` +
    "options:\n  -h, --help  show this help message and exit\n" +
    "  --check     fail on drift instead of writing\n";
  const check_mode = parse_args(usage, help, [["--check", "store_true", "check"]], { check: false })
    .check as boolean;

  let cols: any[];
  try {
    cols = fetch_collections();
  } catch (exc: any) {
    console.log(`❌ gen_schema: ${exc.message}`);
    return 1;
  }

  const files = render(cols);
  const patterns = render_patterns(cols);

  if (check_mode) {
    return _check(files, patterns);
  }

  fs.writeFileSync(PATTERNS_FILE, patterns);
  fs.mkdirSync(SCHEMA_DIR, { recursive: true });
  for (const [fn, content] of files) fs.writeFileSync(path.join(SCHEMA_DIR, fn), content);
  const removed: string[] = [];
  for (const fn of [..._on_disk().keys()].filter((f) => !files.has(f)).sort(by_code_point)) {
    fs.rmSync(path.join(SCHEMA_DIR, fn));
    removed.push(fn);
  }
  const note = removed.length ? `, removed ${removed.length} stray` : "";
  console.log(
    `✅ gen_schema: wrote ${files.size} files to schema/ (${cols.length} collections${note}), ` +
      `and pb_hooks/field_patterns.json.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

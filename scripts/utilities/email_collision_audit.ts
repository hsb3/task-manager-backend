#!/usr/bin/env bun
/**
 * Offline audit of a data.db COPY: which users rows would collide under the email_key
 * folding policy (PBTT-528; precursor to PBTT-529's unique email_key index).
 *
 * Policy (owner ruling 2026-08-31): trim + lowercase the whole address, always; for
 * gmail.com and googlemail.com ONLY, additionally remove all '.' from the local part and
 * everything from the first '+' to the '@'. All other domains keep dots and +tags
 * significant. Boundary: gmail.com and googlemail.com are DISTINCT domains — an address
 * at one never folds into the other.
 *
 * Usage: bun scripts/utilities/email_collision_audit.ts <path-to-data.db> [--json]
 *
 * Opens the db strictly read-only (mode=ro URI) — zero mutations, ever. Exits 0 whether
 * or not collisions exist; findings are the report, not a failure. Exit 2 = usage/IO.
 */

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { parse_args } from "../_argparse.ts";
import {
  by_code_point,
  glob_sorted,
  json_dumps,
  py_repr,
  py_str,
  py_strip,
  read_text,
  SystemExit,
  truthy,
  sqlite_connect,
} from "../_py.ts";

const REPO_ROOT = path.dirname(path.dirname(import.meta.dir));

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

const POLICY_LINES = [
  "Policy: trim + lowercase always; for gmail.com/googlemail.com ONLY, dots removed " +
    "from the local part and the first '+' through '@' stripped.",
  "Boundary: gmail.com and googlemail.com are DISTINCT domains — never folded into each other.",
  "Classification: case-only = all members equal after trim+lowercase alone; " +
    "gmail-fold = equal only after the Gmail folding; both = a set (>=3) mixing " +
    "case-only and fold-needed pairs.",
  "Disposition is a SUGGESTION for the owner, not a decision: mergeable-duplicates = " +
    "at most one member has any involvement; needs-ruling otherwise.",
];

const HELP = `usage: email_collision_audit.ts [-h] [--json] [--schema-dir SCHEMA_DIR] db

Offline audit of a data.db COPY: which users rows would collide under the
email_key

positional arguments:
  db                    path to a COPY of data.db (opened read-only)

options:
  -h, --help            show this help message and exit
  --json                machine output
  --schema-dir SCHEMA_DIR
                        generated schema/ dir the user-reference columns are
                        derived from
`;

export function email_key(email: string): string {
  const e = py_strip(email).toLowerCase();
  const at = e.lastIndexOf("@");
  let local = at < 0 ? "" : e.slice(0, at);
  const domain = at < 0 ? e : e.slice(at + 1);
  if (at >= 0 && GMAIL_DOMAINS.has(domain)) {
    local = local.split("+")[0]!.replaceAll(".", "");
    return `${local}@${domain}`;
  }
  return e;
}

export function classify(emails: string[]): string {
  const lowered = new Set(emails.map((e) => py_strip(e).toLowerCase()));
  if (lowered.size === 1) return "case-only";
  if (lowered.size === emails.length) return "gmail-fold";
  return "both";
}

/**
 * (collection, field, maxSelect) for every schema/ relation field targeting users.
 *
 * Derived, never hand-listed: the report's bounds are exactly what the generated
 * schema declares. View collections are skipped (their rows mirror base tables).
 */
export function user_relation_columns(
  schema_dir: string,
  users_cid: string,
): [string, string, number][] {
  const cols: [string, string, number][] = [];
  for (const file of glob_sorted(schema_dir, ".json")) {
    if (file.endsWith(".rules.json")) continue;
    const data = JSON.parse(read_text(file));
    if (data.type === "view") continue;
    for (const field of data.fields ?? []) {
      if (field.type === "relation" && field.collectionId === users_cid) {
        cols.push([data.name, field.name, field.maxSelect || 1]);
      }
    }
  }
  return cols;
}

export function count_refs(
  con: Database,
  table: string,
  col: string,
  max_select: number,
  uid: string,
): number {
  let sql: string;
  if (max_select === 1) {
    sql = `SELECT COUNT(*) FROM "${table}" WHERE "${col}" = ?`;
  } else {
    // multi-relation columns store a JSON array of ids
    sql =
      `SELECT COUNT(*) FROM "${table}" WHERE EXISTS ` +
      `(SELECT 1 FROM json_each("${table}"."${col}") WHERE json_each.value = ?)`;
  }
  return (con.query(sql).values(uid)[0] as [number])[0];
}

export function audit(db_path: string, schema_dir: string): any {
  const con = sqlite_connect(db_path, { readonly: true });
  try {
    const users_row = con.query("SELECT id FROM _collections WHERE name = 'users'").values()[0];
    if (users_row === undefined) {
      throw new SystemExit(`no 'users' collection in ${db_path} — not a PocketBase data.db?`);
    }
    const users_cid = users_row[0] as string;

    const tables = new Set(
      con
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .values()
        .map((r) => r[0]),
    );
    const derived = user_relation_columns(schema_dir, users_cid);
    const counted = derived.filter(([t]) => tables.has(t));
    // DECLARED SKIP: a schema table absent from this db (older snapshot) is not counted; the report names each one so the bound is visible, never silent
    const skipped = derived.filter(([t]) => !tables.has(t)).map(([t, c]) => `${t}.${c}`);

    const rows = con.query("SELECT id, email, created, verified FROM users").values() as any[][];
    const empty_email = rows.filter(([, email]) => !py_strip(email ?? "")).length;

    const by_key = new Map<string, any[][]>();
    for (const [uid, email, created, verified] of rows) {
      if (!py_strip(email ?? "")) continue;
      const key = email_key(email);
      if (!by_key.has(key)) by_key.set(key, []);
      by_key.get(key)!.push([uid, email, created, verified]);
    }

    const sets = [];
    for (const [key, members] of [...by_key].sort((a, b) => by_code_point(a[0], b[0]))) {
      if (members.length < 2) continue;
      const detailed = [];
      let involved = 0;
      for (const [uid, email, created, verified] of members) {
        const per_col = new Map<string, number>(
          counted.map(([t, c, m]) => [`${t}.${c}`, count_refs(con, t, c, m, uid)]),
        );
        const memberships = per_col.get("workspace_members.user") ?? 0;
        const owned = per_col.get("workspaces.owner") ?? 0;
        let content = 0;
        for (const [name, n] of per_col) {
          if (name !== "workspace_members.user" && name !== "workspaces.owner") content += n;
        }
        const involvement = memberships + content + owned;
        involved += involvement ? 1 : 0;
        detailed.push({
          id: uid,
          email,
          created,
          verified: truthy(verified),
          memberships,
          owned_workspaces: owned,
          content,
          involvement,
          columns: Object.fromEntries([...per_col].filter(([, c]) => c)),
        });
      }
      sets.push({
        email_key: key,
        classification: classify(detailed.map((m) => m.email)),
        disposition: involved <= 1 ? "mergeable-duplicates" : "needs-ruling",
        members: detailed,
      });
    }
    return {
      db: db_path,
      policy: POLICY_LINES,
      counted_columns: counted.map(([t, c]) => `${t}.${c}`),
      // DECLARED SKIP: surfaced in both report formats, see the marker at the source above
      skipped_columns: skipped,
      rows_with_empty_email_excluded: empty_email,
      collision_sets: sets,
    };
  } finally {
    con.close();
  }
}

export function print_human(report: any): void {
  const out = (s: string) => process.stdout.write(s + "\n");
  out(`Email-identity collision audit — ${report.db}`);
  for (const line of report.policy) out(line);
  out(
    "Counted user-reference columns (derived from schema/*.json): " +
      report.counted_columns.join(", "),
  );
  // DECLARED SKIP: columns whose table is absent in this db are named, not silently dropped
  if (report.skipped_columns.length) {
    // DECLARED SKIP: same absent-table columns, printed by name
    out(`Skipped (table absent in this db): ${report.skipped_columns.join(", ")}`);
  }
  if (report.rows_with_empty_email_excluded) {
    out(`Rows with empty email excluded: ${report.rows_with_empty_email_excluded}`);
  }
  const sets = report.collision_sets;
  if (!sets.length) {
    out("\nNo collisions.");
    return;
  }
  out(`\n${sets.length} collision set(s):`);
  sets.forEach((s: any, idx: number) => {
    out(
      `\n[${idx + 1}] key=${s.email_key}  class=${s.classification}  ` +
        `suggested disposition=${s.disposition} (suggestion only — owner decides)`,
    );
    for (const m of s.members) {
      out(
        `    - id=${m.id}  email=${py_repr(m.email)}  created=${py_str(m.created)}  ` +
          `verified=${py_str(m.verified)}`,
      );
      const cols = Object.entries<number>(m.columns)
        .sort((a, b) => by_code_point(a[0], b[0]))
        .map(([n, c]) => `${n}=${c}`)
        .join(", ");
      out(
        `      memberships=${m.memberships}  owned_workspaces=` +
          `${m.owned_workspaces}  content=${m.content}` +
          (cols ? `  (${cols})` : ""),
      );
    }
  });
}

// CPython maps these SQLite result codes to sqlite3.OperationalError (the only class main() catches).
const OPERATIONAL = new Set([1, 3, 4, 5, 6, 8, 9, 10, 13, 14, 15, 16, 17]);

export function main(argv: string[]): number {
  const args = parse_args(
    HELP.slice(0, HELP.indexOf("\n\n")),
    HELP,
    [
      ["db", "store", "db"],
      ["--json", "store_true", "json"],
      ["--schema-dir", "store", "schema_dir"],
    ],
    { json: false, schema_dir: path.join(REPO_ROOT, "schema") },
    argv,
  );
  if (!fs.statSync(args.db, { throwIfNoEntry: false })?.isFile()) {
    process.stderr.write(`no such file: ${args.db}\n`);
    return 2;
  }
  let report;
  try {
    report = audit(args.db, args.schema_dir);
  } catch (e: any) {
    if (e?.name !== "SQLiteError" || !OPERATIONAL.has(e.errno & 0xff)) throw e;
    process.stderr.write(`cannot read ${args.db}: ${e.message}\n`);
    return 2;
  }
  if (args.json) {
    process.stdout.write(json_dumps(report, { indent: 2 }) + "\n");
  } else {
    print_human(report);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

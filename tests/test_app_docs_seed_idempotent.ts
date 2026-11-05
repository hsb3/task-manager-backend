#!/usr/bin/env bun
/**
 * Re-applying the generated app_docs seed is a no-op — the claim its own comment makes.
 *
 * pb_migrations/<gen_app_docs_seed.DEFAULT_OUTPUT> calls itself an "Idempotent upsert-by-id"
 * and nothing proved it. §1 replays the real migration set, drops that one file's row from
 * `_migrations` so PocketBase runs it a SECOND time against the database it already seeded,
 * and asserts the app_docs row set is unchanged — count, id set, and the shadowproject01
 * record field by field.
 *
 * Dropping the `_migrations` row is faithful to a real double-apply: PocketBase decides what
 * to run from that table alone, so the file executes exactly as it would on a database where
 * it is pending again (a partial revert, a restored backup, a re-baseline).
 *
 * §2 is the negative control: the same comparison against a scratch copy whose loop rewrites
 * the title it re-applies instead of restoring it. That mutant re-applies without erroring and
 * leaves the count and the id set intact, so §1's field-by-field row check is the only thing
 * that can catch it — which is what makes it a control on that check rather than on PocketBase.
 *
 * No server and no port — a `migrate up` into a throwaway directory, read back with sqlite3.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  py_repr,
  py_strip,
  read_text,
  splitlines,
  tup,
  by_code_point,
  sqlite_connect,
} from "../scripts/_py.ts";
import { DEFAULT_OUTPUT } from "../scripts/gen_app_docs_seed.ts";
import { migrate_up, pb_bin_path } from "../scripts/pb_migrate.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const PB = pb_bin_path(REPO_ROOT);
const MIGRATIONS = path.join(REPO_ROOT, "pb_migrations");
const SEED_FILE = path.basename(DEFAULT_OUTPUT);
const SHADOW_ID = "shadowproject01";

// The seed's own title write; §2 rewrites it so a second apply changes the row without erroring.
const SET_TITLE = `    rec.set("title", data.title)`;
const REWRITE_TITLE = `    rec.set("title", (rec.get("title") || data.title) + "!")`;

type Row = any[];
const FAILS: string[] = [];

function check(label: string, ok: boolean, detail: string = ""): void {
  console.log(`  ${ok ? "✅" : "❌"}  ${label}` + (detail ? ` → ${detail}` : ""));
  if (!ok) FAILS.push(label);
}

function snapshot(db: string): [Row[], number] {
  const con = sqlite_connect(db);
  try {
    const rows = (
      con.query("SELECT id, slug, refName, title, body FROM app_docs ORDER BY id").values() as Row[]
    ).map((r) => tup(...r));
    const applied = (
      con.query("SELECT count(*) FROM _migrations WHERE file = ?").get(SEED_FILE) as any
    )["count(*)"] as number;
    return [rows, applied];
  } finally {
    con.close();
  }
}

/** (before, after, reran, error) for one replay + a forced second run of the seed. */
function reapply(migrations_dir: string): [Row[] | null, Row[] | null, boolean, string] {
  const data_dir = fs.mkdtempSync(path.join(os.tmpdir(), "lv7-appdocs-"));
  try {
    let [ok, out] = migrate_up(PB, data_dir, migrations_dir);
    if (!ok) return [null, null, false, `first \`migrate up\` failed: ${out}`];
    const db = path.join(data_dir, "data.db");
    const [before, applied] = snapshot(db);
    if (applied !== 1) {
      return [before, null, false, `${SEED_FILE} is not recorded in _migrations (${applied} rows)`];
    }
    const con = sqlite_connect(db);
    try {
      con.run("DELETE FROM _migrations WHERE file = ?", [SEED_FILE]);
    } finally {
      con.close();
    }
    [ok, out] = migrate_up(PB, data_dir, migrations_dir);
    if (!ok) return [before, null, false, `the second \`migrate up\` failed: ${py_strip(out)}`];
    const [after, applied2] = snapshot(db);
    return [before, after, applied2 === 1, ""];
  } finally {
    fs.rmSync(data_dir, { recursive: true, force: true });
  }
}

function row_of(rows: Row[] | null, record_id: string): Row | null {
  return (rows ?? []).find((r) => r[0] === record_id) ?? null;
}

const ids = (rows: Row[]): string => JSON.stringify(rows.map((r) => r[0]).sort(by_code_point));

console.log(`\n── §1 the real ${SEED_FILE} re-applies as a no-op ──`);
const [before, after, reran, err] = reapply(MIGRATIONS);
check("the seed re-ran against the already-seeded database", reran && !err, err);
check("the first replay seeded app_docs at all", !!before?.length, `${before?.length ?? 0} rows`);
check(
  "the row COUNT is unchanged",
  after !== null && before!.length === after.length,
  `${before?.length ?? 0} → ${after !== null ? after.length : "n/a"}`,
);
check("the id SET is unchanged", after !== null && ids(before!) === ids(after));
check(
  `${SHADOW_ID}'s slug/refName/title/body are unchanged`,
  after !== null && Bun.deepEquals(row_of(before, SHADOW_ID), row_of(after, SHADOW_ID), true),
  py_repr(tup(...(row_of(after, SHADOW_ID) ?? ["absent"]).slice(0, 4))),
);
check(`${SHADOW_ID} is a seeded row at all`, row_of(before, SHADOW_ID) !== null);

console.log("\n── §2 negative control: the same comparison catches a seed that rewrites a row ──");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "lv7-appdocs-broken-"));
try {
  const broken_dir = path.join(S, "pb_migrations");
  fs.cpSync(MIGRATIONS, broken_dir, { recursive: true, dereference: true });
  const file = path.join(broken_dir, SEED_FILE);
  const text = read_text(file);
  check(
    "the title write this proof mutates is where it is read from",
    text.split(SET_TITLE).length - 1 === 1,
  );
  fs.writeFileSync(
    file,
    text.replaceAll(SET_TITLE, () => REWRITE_TITLE),
  );

  const [b_before, b_after, b_reran, b_err] = reapply(broken_dir);
  const was = row_of(b_before, SHADOW_ID);
  const now = row_of(b_after, SHADOW_ID);
  check(
    "the mutated seed re-applies WITHOUT erroring — non-idempotence PB never refuses",
    b_reran && !b_err,
    b_err ? splitlines(b_err).at(-1)! : "the second `migrate up` succeeded",
  );
  check(
    "its row COUNT and id SET survive, so only the field comparison can catch it",
    b_after !== null && b_before!.length === b_after.length && ids(b_before!) === ids(b_after),
    `${b_before?.length ?? 0} → ${b_after !== null ? b_after.length : 0} rows`,
  );
  check(
    `${SHADOW_ID}'s field-by-field comparison is what goes red`,
    !!was && !!now && !Bun.deepEquals(was, now, true),
    was && now ? `title ${py_repr(was[3])} → ${py_repr(now[3])}` : "the row is absent",
  );
} finally {
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} app_docs seed idempotence check(s) FAILED`);
  process.exit(1);
}
console.log(`✅ re-applying ${SEED_FILE} changes no app_docs row`);
process.exit(0);

#!/usr/bin/env bun
/**
 * CI / pre-commit check: every non-system collection must have an app_docs record
 * (slug `collection:<name>`) — enforces the self-documenting convention
 * (docs/self-documenting-app.md). Replays pb_migrations/ into a throwaway temp dir
 * (no running server, no network, no auth) and compares `_collections` vs `app_docs`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { print, sqlite_connect } from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import * as check_app_docs_quotes from "./check_app_docs_quotes.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";

const REPO = repo_root(import.meta.path);
const PB = pb_bin_path(REPO);
const MIGRATIONS = path.join(REPO, "pb_migrations");

const HELP = `usage: check_app_docs.ts [-h]

Check that every non-system collection has an app_docs record.

options:
  -h, --help  show this help message and exit`;

function main(): number {
  parse_args(HELP.slice(0, HELP.indexOf("\n\n")), HELP + "\n", [], {});

  if (!fs.existsSync(PB)) {
    print(
      `❌ check_app_docs: no ./pocketbase at ${PB} — run \`make pocketbase\`. ` +
        `A missing binary is a setup error, not a reason to pass.`,
    );
    return 1;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcheck_"));
  try {
    const [ok, out] = migrate_up(PB, tmp, MIGRATIONS);
    if (!ok) {
      print("❌ check_app_docs: `migrate up` failed:\n" + out);
      return 1;
    }

    const con = sqlite_connect(path.join(tmp, "data.db"));
    const collections = (
      con.query("SELECT name FROM _collections WHERE system = 0 ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    let slugs: Set<string>;
    let docs: Record<string, any>[];
    try {
      slugs = new Set(
        (con.query("SELECT slug FROM app_docs").all() as { slug: string }[]).map((r) => r.slug),
      );
      docs = con
        .query("SELECT id, slug, refName, title, body FROM app_docs ORDER BY slug")
        .all() as Record<string, any>[];
    } catch {
      print(
        "❌ check_app_docs: `app_docs` table not found — the convention " +
          "collection is missing.",
      );
      return 1;
    } finally {
      con.close();
    }

    const missing = collections.filter((c) => !slugs.has(`collection:${c}`));
    if (missing.length) {
      print("❌ check_app_docs: collection(s) missing an app_docs record:");
      for (const c of missing) {
        print(
          `     • ${c}  → add a record with slug 'collection:${c}' ` +
            `to the app_docs seed migration`,
        );
      }
      print("\n   Convention: docs travel as data. See docs/self-documenting-app.md");
      return 1;
    }

    print(
      `✅ check_app_docs: all ${collections.length} collections documented ` +
        `(${collections.join(", ")}).`,
    );
    // Shares this one `migrate up` — the quotes gate also stands alone as its own entrypoint.
    return check_app_docs_quotes.check(docs, REPO);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(main());
}

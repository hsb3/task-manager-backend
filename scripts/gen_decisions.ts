#!/usr/bin/env bun
/**
 * Generate docs/generated/decisions.md from the app_docs `decision:*` seed records.
 *
 * Same offline mechanic as check_app_docs.ts: replay pb_migrations/ into a throwaway
 * data.db and read `app_docs` directly (no running server, network, or auth), so the
 * generated index always matches what ships to prod.
 *
 * Usage: bun scripts/gen_decisions.ts [--check]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { py_repr, read_text, sqlite_connect } from "./_py.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";

const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));
const PB = pb_bin_path(REPO);
const MIGRATIONS = path.join(REPO, "pb_migrations");
const OUTPUT = path.join(REPO, "docs", "generated", "decisions.md");

const HEADER = `<!--
GENERATED FILE — DO NOT EDIT BY HAND.

Source of truth: the \`app_docs\` \`decision:*\` seed migrations under
pb_migrations/. Regenerate with:

    bun scripts/gen_decisions.ts

See docs/self-documenting-app.md for how the app_docs convention works.
-->

# Decisions

`;

/** Replay migrations into a temp dir and return decision app_docs rows. Throws
 * Error if ./pocketbase is absent or `migrate up` fails. */
export function fetch_decisions(): Record<string, string>[] {
  if (!fs.existsSync(PB)) {
    throw new Error(
      `no ./pocketbase at ${PB} — run \`make pocketbase\`. ` +
        `A missing binary is a setup error, not a reason to pass.`,
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbgen_"));
  try {
    const [ok, out] = migrate_up(PB, tmp, MIGRATIONS);
    if (!ok) {
      throw new Error("`migrate up` failed:\n" + out);
    }

    const con = sqlite_connect(path.join(tmp, "data.db"));
    try {
      const rows = con
        .query(
          "SELECT slug, refName, title, body FROM app_docs " +
            "WHERE slug LIKE 'decision:%' ORDER BY slug",
        )
        .values() as string[][];
      return rows.map(([slug, ref_name, title, body]) => ({
        slug: slug!,
        ref_name: ref_name!,
        title: title!,
        body: body!,
      }));
    } finally {
      con.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The whole slug, not just its prefix: matching only the namespace still let `decision:`,
// `decision: spaced` and a doubled namespace such as `a:b` after the prefix through as headings.
const DECISION_SLUG = /^decision:([a-z0-9]+([-_][a-z0-9]+)*)$/;
const ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Shift body headings so the shallowest sits at level 3, under the `## <name>` record
 * heading; lines inside fenced code blocks are left verbatim. */
export function demote_headings(body: string): string {
  const lines = body.split("\n");
  let fence: string | null = null;
  const heads: [number, RegExpExecArray][] = [];
  for (const [i, line] of lines.entries()) {
    let m: RegExpExecArray | null;
    let h: RegExpExecArray | null;
    if ((m = FENCE.exec(line))) {
      const mark = m[1]!;
      if (fence === null) {
        fence = mark;
      } else if (mark[0] === fence[0] && mark.length >= fence.length) {
        fence = null;
      }
    } else if (fence === null && (h = ATX_HEADING.exec(line))) {
      heads.push([i, h]);
    }
  }
  if (heads.length === 0) return body;
  const shift = Math.max(0, 3 - Math.min(...heads.map(([, h]) => h[2]!.length)));
  for (const [i, h] of heads) {
    lines[i] = h[1]! + "#".repeat(Math.min(h[2]!.length + shift, 6)) + lines[i]!.slice(h[0].length);
  }
  return lines.join("\n");
}

/** Render decision rows into deterministic Markdown (no timestamps).
 *
 * Throws Error on a row whose slug is not `decision:<name>` — the heading is the
 * name alone, so anything else would print punctuation or a namespace as the heading.
 */
export function render_decisions(decisions: Record<string, string>[]): string {
  const sections: string[] = [];
  for (const d of decisions) {
    const match = DECISION_SLUG.exec(d.slug!);
    if (match === null) {
      throw new Error(
        `app_docs slug ${py_repr(d.slug)} is not a decision record: a decision heading ` +
          `needs a \`decision:\` namespace followed by a plain name.`,
      );
    }
    const name = match[1];
    const ref = d.ref_name ? `- **Ref:** \`${d.ref_name}\`\n` : "";
    sections.push(
      `## ${name}\n\n` +
        `- **Slug:** \`${d.slug}\`\n` +
        `- **Title:** ${d.title}\n` +
        `${ref}\n` +
        `${demote_headings(d.body!)}\n`,
    );
  }
  return HEADER + sections.join("\n");
}

function main(): number {
  const usage = "usage: gen_decisions.ts [-h] [--check]";
  const help =
    `${usage}\n\nGenerate docs/generated/decisions.md from the app_docs decision:* records.\n\n` +
    "options:\n  -h, --help  show this help message and exit\n" +
    "  --check     fail on drift instead of writing\n";
  const check_mode = parse_args(usage, help, [["--check", "store_true", "check"]], { check: false })
    .check as boolean;

  let decisions: Record<string, string>[];
  let content: string;
  try {
    decisions = fetch_decisions();
    content = render_decisions(decisions);
  } catch (exc) {
    if (!(exc instanceof Error)) throw exc;
    console.log(`❌ gen_decisions: ${exc.message}`);
    return 1;
  }

  if (check_mode) {
    return _check(content);
  }

  fs.writeFileSync(OUTPUT, content, "utf-8");
  console.log(
    `✅ gen_decisions: wrote ${decisions.length} decision(s) to ${path.relative(REPO, OUTPUT)}.`,
  );
  return 0;
}

/** Compare freshly-rendered content against the on-disk file. */
function _check(content: string): number {
  let on_disk: string;
  try {
    on_disk = read_text(OUTPUT);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") throw exc;
    console.log(
      `❌ gen_decisions --check: ${OUTPUT} does not exist. ` +
        `Run \`bun scripts/gen_decisions.ts\` to generate it.`,
    );
    return 1;
  }

  if (on_disk === content) {
    console.log("✅ gen_decisions --check: docs/generated/decisions.md is up to date.");
    return 0;
  }

  console.log(
    "❌ gen_decisions --check: docs/generated/decisions.md is out of date " +
      "with app_docs decision records.\n" +
      "   Run `bun scripts/gen_decisions.ts` to regenerate it.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}

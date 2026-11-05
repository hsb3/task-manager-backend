#!/usr/bin/env bun
// Proof that scripts/gen_decisions.ts cannot emit a heading carrying a wrong slug namespace; binds no port, boots no server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, splitlines, by_code_point, sqlite_connect } from "../scripts/_py.ts";
import { fetch_decisions, render_decisions } from "../scripts/gen_decisions.ts";
import { migrate_up } from "../scripts/pb_migrate.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const PB_BIN = roomkit.pb_bin();
const MIGRATIONS = path.join(REPO_ROOT, "pb_migrations");
const BAD_SLUG = "decsion:probe";

const FAILS: string[] = [];

function check(label: string, got: any, want: any): void {
  const ok = Bun.deepEquals(got, want, true);
  console.log(`  ${ok ? "✅" : "❌"}  ${label}\n        got=${py_repr(got)} want=${py_repr(want)}`);
  if (!ok) FAILS.push(label);
}

// Every failure path emits a ❌ — a bare traceback reads as green to a glyph-scanning caller.
async function run(): Promise<void> {
  console.log("── 1. render refuses a row whose slug namespace is not `decision` ──");

  // The last five carry the right namespace and a malformed NAME. Matching only the prefix
  // let them through as headings `## `, `##  spaced` and `## a:b` when planted by raw SQL —
  // the field pattern refuses them over the API, a migration writing SQL directly does not.
  for (const slug of [
    BAD_SLUG,
    "totallybogus:probe",
    "collection:app_docs",
    "bare-probe",
    "decision",
    "decision:",
    "decision: spaced",
    "decision:a:b",
    "DECISION:upper",
  ]) {
    const row = { slug, ref_name: "probe", title: "T", body: "B" };
    let rendered: string;
    try {
      rendered = render_decisions([row]);
    } catch (exc) {
      if (!(exc instanceof Error)) throw exc;
      check(
        `render_decisions(${py_repr(slug)}) refuses`,
        exc.message.includes(slug)
          ? "ValueError"
          : `ValueError not naming the slug: ${exc.message}`,
        "ValueError",
      );
      continue;
    }
    const heading = splitlines(rendered).find((ln) => ln.startsWith("## ")) ?? "<no heading>";
    check(
      `render_decisions(${py_repr(slug)}) refuses`,
      `emitted ${py_repr(heading)}`,
      "ValueError",
    );
  }

  console.log("\n── 2. a real `decision:` row still renders, with the namespace stripped ──");

  const good = { slug: "decision:probe-one", ref_name: "probe", title: "T", body: "B" };
  const headings = splitlines(render_decisions([good])).filter((ln) => ln.startsWith("## "));
  check("heading of decision:probe-one", headings, ["## probe-one"]);

  console.log("\n── 3. end-to-end: a planted wrong-namespace row reaches no heading ──");

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gendec_"));
  try {
    const data = path.join(scratch, "pb_data");
    const [ok, out] = migrate_up(PB_BIN, data, MIGRATIONS);
    check("migrate up applied pb_migrations/", ok, true);
    if (!ok) {
      console.log(out);
      throw new roomkit.SystemExit(1);
    }

    const con = sqlite_connect(path.join(data, "data.db"));
    const cols = (con.query("PRAGMA table_info(app_docs)").values() as any[][]).map((r) => r[1]);
    check("app_docs has no second classification column", cols.includes("kind"), false);
    // A direct INSERT bypasses the field pattern that refuses this slug over the API.
    con
      .query(
        "INSERT INTO app_docs (id, slug, refName, title, body, created, updated) " +
          "VALUES ('probe0000000001', ?, 'probe', 'Probe title', 'Probe body', " +
          "'2026-09-06 00:00:00.000Z', '2026-09-06 00:00:00.000Z')",
      )
      .run(BAD_SLUG);
    const rows = con
      .query(
        "SELECT slug, refName, title, body FROM app_docs WHERE slug LIKE 'decision:%' ORDER BY slug",
      )
      .values() as string[][];
    con.close();

    const decisions = rows.map(([slug, ref_name, title, body]) => ({
      slug: slug!,
      ref_name: ref_name!,
      title: title!,
      body: body!,
    }));
    check(
      "the planted row is not selected as a decision",
      decisions.filter((d) => d.slug === BAD_SLUG),
      [],
    );
    const rendered = render_decisions(decisions);
    check(
      "no heading mentions the planted slug",
      splitlines(rendered).filter((ln) => ln.startsWith("## ") && ln.includes("probe")),
      [],
    );
    check(
      "no heading anywhere still carries a namespace colon",
      splitlines(rendered).filter((ln) => ln.startsWith("## ") && ln.includes(":")),
      [],
    );
    check("the real decisions still rendered", decisions.length > 0, true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log("\n── 4. the shipped fetch path selects on the slug namespace alone ──");

  const fetched = fetch_decisions();
  check(
    "every fetched row carries the decision namespace",
    [...new Set(fetched.map((d) => d.slug!.split(":")[0]))].sort(by_code_point),
    ["decision"],
  );
  check("fetch_decisions found rows", fetched.length > 0, true);

  console.log("\n── 5. body headings sit below the record heading; fenced lines stay verbatim ──");

  const board_body =
    "Status: Accepted\n\n## Context\nwhy\n\n### Detail\n\n```\n# fenced comment\n## fenced\n```\n" +
    "~~~md\n## tilde fenced\n~~~\n\n## Decision\ndone";
  const lines = splitlines(
    render_decisions([
      {
        slug: "decision:board-probe",
        ref_name: "",
        title: "board-probe: t",
        body: board_body,
      },
    ]),
  );
  const fenced = ["# fenced comment", "## fenced", "## tilde fenced"];
  check(
    "only the record heading is an unfenced level-2 heading",
    lines.filter((ln) => ln.startsWith("## ") && !fenced.includes(ln)),
    ["## board-probe"],
  );
  check(
    "body headings demoted, hierarchy kept",
    lines.filter((ln) => ln.startsWith("###")),
    ["### Context", "#### Detail", "### Decision"],
  );
  check(
    "fenced `#` lines untouched",
    lines.filter(
      (ln) =>
        fenced.includes(ln) ||
        [" fenced comment", " fenced", " tilde fenced"].includes(ln.replace(/^#+/, "")),
    ),
    fenced,
  );
  check(
    "a body with no headings renders verbatim",
    render_decisions([
      { slug: "decision:x", ref_name: "r", title: "T", body: "a\n#1 is not a heading" },
    ]).endsWith("a\n#1 is not a heading\n"),
    true,
  );

  console.log("\n── 6. an empty refName prints no Ref bullet; a set one still does ──");

  const empty = render_decisions([{ slug: "decision:x", ref_name: "", title: "T", body: "B" }]);
  check(
    "empty refName: no Ref bullet",
    splitlines(empty).filter((ln) => ln.includes("**Ref:**")),
    [],
  );
  check(
    "empty refName: body follows the Title bullet",
    empty.includes("- **Title:** T\n\nB\n"),
    true,
  );
  const filled = render_decisions([
    { slug: "decision:x", ref_name: "users", title: "T", body: "B" },
  ]);
  check(
    "set refName: Ref bullet kept",
    filled.includes("- **Title:** T\n- **Ref:** `users`\n\nB\n"),
    true,
  );

  console.log();
  if (FAILS.length) {
    console.log(`❌ ${FAILS.length} FAILED: ${py_repr(FAILS)}`);
    process.exit(1);
  }
  console.log("✅ all gen_decisions namespace proofs passed");
}

try {
  await run();
} catch (exc) {
  if (exc instanceof roomkit.SystemExit) throw exc;
  console.error(exc);
  console.log(
    `❌ test_gen_decisions: aborted by an unhandled ${(exc as Error).name}: ${(exc as Error).message}`,
  );
  process.exit(1);
}

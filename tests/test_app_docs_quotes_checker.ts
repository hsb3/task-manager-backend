#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_app_docs_quotes.ts's single-quoted-token narrowing (card verh): a pair
 * of prose apostrophes may no longer swallow a quoted filter expression and hide it from the scan.
 *
 * Synthetic bodies plus the live rules read out of schema/ — no server, no DB, nothing written.
 * The OLD character class is rebuilt from the shipped pattern and swapped in per assertion, so
 * every pin here is falsified by reverting the fix and no tracked file is ever touched.
 */

import path from "node:path";
import { py_repr, read_text, tup, by_code_point } from "../scripts/_py.ts";
import * as quotes from "../scripts/check_app_docs_quotes.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

// The narrowed class as it sits in the checker's pattern source (SPACE = Python's `\s` as an explicit set).
const SPACE = String.raw`\t-\r\x1c-\x20\x85\xa0  -     　`;
const SHIPPED_CLASS = `'[^'${SPACE}]*'`;
const OLD_CLASS = "'[^']*'";
const SHIPPED_RE = new RegExp(quotes.TOKEN_RE.source, quotes.TOKEN_RE.flags);
const OLD_RE = new RegExp(SHIPPED_RE.source.replace(SHIPPED_CLASS, OLD_CLASS), SHIPPED_RE.flags);

// The span the old tokenizer swallowed: a whole quoted rule fragment sitting between the
// apostrophes of "Alice's" and "Bob's".
const SANDWICHED = 'workspace.owner = @request.auth.id && trashed = ""';
const SANDWICH_BODY =
  "Alice's note: the rule is " + SANDWICHED + " today, and Bob's follow-up says the same.";
const QUOTED_VALUE = "status = 'active' && creator = @request.auth.id";
const VALUE_BODY = "The saved view filters " + QUOTED_VALUE + " before the workspace narrowing.";
const SPACED_VALUE_BODY =
  "A view filters name = 'my project' && workspace = @request.auth.id here.";

const SYNTHETIC_ID = "b3quotesynth001";

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

/** Run `fn` against one tokenizer; scan() reads the module global, so it is swapped here. */
function with_tokenizer<T>(rx: RegExp, fn: () => T): T {
  quotes.TOKEN_RE.compile(rx.source, rx.flags);
  try {
    return fn();
  } finally {
    quotes.TOKEN_RE.compile(SHIPPED_RE.source, SHIPPED_RE.flags);
  }
}

/** check() over one synthetic app_docs record — (exit code, printed report). */
function gate_output(body: string): [number, string] {
  const record = {
    id: SYNTHETIC_ID,
    slug: "b3-synthetic",
    refName: "SyntheticRecord",
    title: "",
    body,
  };
  const write = process.stdout.write;
  let buf = "";
  let code: number;
  try {
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      buf += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    code = quotes.check([record], REPO_ROOT);
  } finally {
    process.stdout.write = write;
  }
  return [code, buf];
}

console.log(
  "════════ test_app_docs_quotes_checker.ts — apostrophe-tokenizer pins (card verh) ════════",
);

console.log(
  "\n── (a) the shipped tokenizer carries the narrowed class, and the old one is derived ──",
);
check(
  `the shipped pattern holds ${SHIPPED_CLASS} exactly once`,
  quotes.TOKEN_RE.source.split(SHIPPED_CLASS).length - 1,
  1,
);
check(
  "the derived OLD pattern differs from the shipped one",
  OLD_RE.source !== SHIPPED_RE.source,
  true,
);
check(
  "...by exactly that one class",
  OLD_RE.source.replace(OLD_CLASS, SHIPPED_CLASS),
  SHIPPED_RE.source,
);

console.log("\n── (b) a quote BETWEEN two prose apostrophes is still found ──");
check(
  "shipped: the sandwiched span is scanned out of the body",
  with_tokenizer(SHIPPED_RE, () => quotes.scan(SANDWICH_BODY)),
  tup([SANDWICHED], []),
);
// The mutation proof: revert the one class and the same body yields nothing at all.
check(
  "OLD class: the apostrophe pair swallows it and the scan reports NOTHING",
  with_tokenizer(OLD_RE, () => quotes.scan(SANDWICH_BODY)),
  tup([], []),
);

console.log(
  "\n── (c) the gate itself reports the span, it is not only the scanner that sees it ──",
);
let [code, report] = with_tokenizer(SHIPPED_RE, () => gate_output(SANDWICH_BODY));
check("shipped: an unregistered span fails the gate", code, 1);
check(
  "...named as an unregistered rule-grammar span",
  report.includes("❌ unregistered rule-grammar span"),
  true,
);
check(`...quoting ${SANDWICHED}`, report.includes(SANDWICHED), true);
[code, report] = with_tokenizer(OLD_RE, () => gate_output(SANDWICH_BODY));
check(
  "OLD class: the same body's span never reaches the report",
  report.includes(SANDWICHED),
  false,
);
check(
  "...and no unregistered-span finding is raised for it at all",
  report.includes("❌ unregistered rule-grammar span"),
  false,
);

console.log("\n── (d) a legitimate single-quoted filter VALUE still parses ──");
check(
  "shipped: the whole expression is one clean span",
  with_tokenizer(SHIPPED_RE, () => quotes.scan(VALUE_BODY)),
  tup([QUOTED_VALUE], []),
);
check(
  "...identical to what the old class produced — the narrowing cost nothing here",
  Bun.deepEquals(
    with_tokenizer(SHIPPED_RE, () => quotes.scan(VALUE_BODY)),
    with_tokenizer(OLD_RE, () => quotes.scan(VALUE_BODY)),
    true,
  ),
  true,
);

console.log(
  "\n── (e) safety, derived from schema/: no LIVE rule scans differently under the two ──",
);
const live = [...new Set(quotes.load_live(REPO_ROOT).values())].sort(by_code_point);
check("schema/ yields live rules to test against", live.length > 0, true);
check(
  "every live rule scans identically under the shipped and the old class",
  live.filter(
    (rule) =>
      !Bun.deepEquals(
        with_tokenizer(SHIPPED_RE, () => quotes.scan(rule)),
        with_tokenizer(OLD_RE, () => quotes.scan(rule)),
        true,
      ),
  ),
  [],
);

console.log(
  "\n── (f) DECLARED CEILING: a quoted value containing whitespace fails LOUD, not silent ──",
);
const [clean, truncated] = with_tokenizer(SHIPPED_RE, () => quotes.scan(SPACED_VALUE_BODY));
check("it yields no clean span", clean, []);
check(
  "...but surfaces as an unparseable region, which the gate refuses",
  truncated.map(([span]) => span),
  ["workspace = @request.auth.id"],
);
[code, report] = with_tokenizer(SHIPPED_RE, () => gate_output(SPACED_VALUE_BODY));
check("...so the gate exits 1 on it", code, 1);
check(
  "...naming the region rather than passing over it",
  report.includes("❌ unparseable rule-grammar region"),
  true,
);

console.log("\n── (g) the module global is left as shipped ──");
check(
  "TOKEN_RE restored",
  tup(quotes.TOKEN_RE.source, quotes.TOKEN_RE.flags),
  tup(SHIPPED_RE.source, SHIPPED_RE.flags),
);
// The checker spells the class as `'[^'${SPACE}]*'` inside its template; SHIPPED_CLASS is that text expanded.
check(
  "the checker source still carries the narrowed class",
  read_text(path.join(REPO_ROOT, "scripts", "check_app_docs_quotes.ts")).includes(
    "'[^'${SPACE}]*'",
  ),
  true,
);

console.log();
if (failures) {
  console.log(`❌ test_app_docs_quotes_checker: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ test_app_docs_quotes_checker: every check passed");

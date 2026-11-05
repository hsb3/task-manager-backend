#!/usr/bin/env bun
/** Unit-pin scripts/_ts_source.ts: parse_ts throws SyntaxError(lineno) on syntax errors only. */

import { parse_ts } from "../scripts/_ts_source.ts";

let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok)
    console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

function outcome(src: string): [string, number | null] {
  try {
    parse_ts(src);
    return ["parsed", null];
  } catch (e) {
    return e instanceof SyntaxError ? ["SyntaxError", (e as any).lineno] : [String(e), null];
  }
}

check("valid TS parses", outcome("const a: number = 1;\nexport function f(x: string) {}\n"), [
  "parsed",
  null,
]);
check("unclosed brace → EOF line", outcome("function f() {\n  const a = 1;\n"), ["SyntaxError", 3]);
check("stray )", outcome("const a = 1;\n)\n"), ["SyntaxError", 2]);
check("unterminated string", outcome("const a = 1;\nconst s = 'abc;\n"), ["SyntaxError", 2]);
check("bad template", outcome("const a = 1;\nconst s = `abc\n"), ["SyntaxError", 3]);
check("type-only error does not throw", outcome('const x: number = "s";\n'), ["parsed", null]);

let message = "";
try {
  parse_ts("const a = 1;\n)\n", "f.ts");
} catch (e) {
  message = (e as Error).message;
}
check("message is the bare TS diagnostic", message, "Declaration or statement expected.");

if (failures) {
  console.log(`\n❌ FAIL — ${failures} mismatch(es)`);
  process.exit(1);
}
console.log("\n✅ PASS — all checks matched");

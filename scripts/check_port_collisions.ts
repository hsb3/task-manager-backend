#!/usr/bin/env bun
/**
 * Gate: no two suite defaults bind the same port, and every port claim tells the truth.
 *
 * A default is an integer literal ADDED to the offset — a name containing "offset" or a
 * process.env read — anywhere in the scanned files. Each file is read as a TypeScript AST, so the
 * expression may span lines, may sit in a template literal's span, the offset may be held under
 * any name or wrapped in a call, and a literal inside a string or a comment is prose rather than
 * a bind.
 * No file in the tree writes that shape, and the summary says so where a reader lands. Two files
 * sharing one port refuse, except the ports in SHARED. A file's leading comment block that NAMES
 * a shifted port its own file never declares refuses too: a comment is not a bind, but it is a
 * claim, and a claim contradicting the binds misroutes the next reader. Every `<port> = test_x`
 * named in ports.md must be one of that suite's shifted literals, and no port may be named for
 * two suites. No server, no ports.
 *
 * Usage:
 *     bun scripts/check_port_collisions.ts [--repo DIR] [--ports-doc FILE]
 *     bun scripts/check_port_collisions.ts --print-globs   # scanned path families, one per line
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse_args } from "./_argparse.ts";
import { by_code_point, print, py_join, py_repr, py_str, read_text, truthy } from "./_py.ts";
import { parse_ts } from "./_ts_source.ts";

const REPO = path.dirname(import.meta.dir);

// Relative to --repo. Gate runners derive their trigger paths from --print-globs, never by
// hand-copying this tuple, so a newly scanned family widens them for free.
export const SCAN_GLOBS = ["tests/*.ts", "scripts/*.ts"];

// A port literal is 4-5 digits: narrower admits no real bind, wider matches years and byte counts.
export const PORT_MIN = 1000;
export const PORT_MAX = 99999;

// The offset under any spelling: a name/attribute containing "offset", or a direct environ read.
export const OFFSET_TEXT = /offset|process\.env/i;
// A prose claim in a leading comment: the same shape, spelled in words rather than parsed.
// \w is spelled out: Python's is Unicode-aware, JS's is not.
export const CLAIM_RE =
  /([0-9]{4,5})\s*\+\s*([\p{L}\p{N}_]*offset[\p{L}\p{N}_]*)|([\p{L}\p{N}_]*offset[\p{L}\p{N}_]*)\s*\+\s*([0-9]{4,5})/giu;
export const DOC_ENTRY_RE =
  /(?<![\p{L}\p{N}_])([0-9]{4})(?:\/([0-9]{4}))?\s*=\s*(test_[\p{L}\p{N}_]+)(?![\p{L}\p{N}_])/gu;

// port -> (exact file set or None for any, reason). Printed on every green run.
export const SHARED = new Map<number, [Set<string> | null, string]>([
  [
    2527,
    [
      new Set(["scripts/smtp_sink.ts", "tests/test_hardening.ts"]),
      "one sink: smtp_sink.ts binds it, test_hardening.ts only dials it",
    ],
  ],
  [8090, [null, "the dev port; legacy suites only dial it as their PB_URL fallback"]],
  ...(
    [
      [8094, ["tests/test_oauth.ts", "tests/test_observability.ts", "tests/test_vocab_flow.ts"]],
      [8095, ["tests/test_backups.ts", "tests/test_observability.ts"]],
      [8098, ["scripts/load_smoketest.ts", "tests/test_backups.ts", "tests/test_observability.ts"]],
      [8099, ["tests/test_item_keys.ts", "tests/test_oauth.ts", "tests/test_observability.ts"]],
    ] as [number, string[]][]
  ).map(([port, files]): [number, [Set<string> | null, string]] => [
    port,
    [new Set(files), "the probe band: these suites run solo, never beside another"],
  ]),
]);

export function scanned_paths(repo: string): string[] {
  const paths: string[] = [];
  for (const pattern of SCAN_GLOBS) {
    try {
      for (const rel of new Bun.Glob(pattern).scanSync({ cwd: repo })) {
        paths.push(py_join(repo, rel));
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e; // a missing repo globs to nothing, as Python's glob
    }
  }
  return [...new Set(paths)].sort(by_code_point);
}

function unparen(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

export function _is_port_literal(node: ts.Expression): node is ts.NumericLiteral {
  node = unparen(node);
  // An integer spelling only: Python's `8090.0` and `1e4` are floats, not ints.
  if (!ts.isNumericLiteral(node) || !/^(0[xXoObB][0-9a-fA-F_]+|[0-9_]+)$/.test(node.getText())) {
    return false;
  }
  const value = Number(node.text);
  return value >= PORT_MIN && value <= PORT_MAX;
}

export function _is_offset(node: ts.Expression): boolean {
  return OFFSET_TEXT.test(node.getText());
}

/** (lineno, port) per `<literal> + <offset>` addition; a syntax error is never swallowed. */
export function typescript_declarations(
  source: string,
  filename: string = "suite.ts",
): [number, number][] {
  let sf: ts.SourceFile;
  try {
    sf = parse_ts(source, filename);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new Error(`${filename}:${(e as any).lineno}: SyntaxError: ${e.message}`);
  }
  const found: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      for (const [literal, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as [ts.Expression, ts.Expression][]) {
        if (_is_port_literal(literal) && _is_offset(other)) {
          const lineno = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          found.push([lineno, Number(unparen(literal).getText().replaceAll("_", ""))]);
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** (relpath, lineno, port) for every offset-shifted literal under SCAN_GLOBS. */
export function declarations(repo: string): [string, number, number][] {
  const found: [string, number, number][] = [];
  for (const file of scanned_paths(repo)) {
    const rel = path.relative(repo, file);
    for (const [lineno, port] of typescript_declarations(read_text(file), file)) {
      found.push([rel, lineno, port]);
    }
  }
  return found;
}

/** The file's leading comment block (JSDoc or `//` run) as plain prose, delimiters removed. */
export function leading_comment(source: string): string {
  return (ts.getLeadingCommentRanges(source, 0) ?? [])
    .map((range) => {
      const text = source.slice(range.pos, range.end);
      return range.kind === ts.SyntaxKind.MultiLineCommentTrivia
        ? text
            .replace(/^\/\*+|\*+\/$/g, "")
            .split("\n")
            .map((line) => line.replace(/^\s*\*+ ?/, ""))
            .join("\n")
        : text.replace(/^\/\/+ ?/, "");
    })
    .join("\n");
}

/** A leading comment naming a shifted port its own file never binds. */
export function claim_errors(repo: string, decls: [string, number, number][]): string[] {
  const errors: string[] = [];
  for (const file of scanned_paths(repo)) {
    const rel = path.relative(repo, file);
    if (!/^(tests|scripts)\/[^/]+\.ts$/.test(rel)) continue;
    const docstring = leading_comment(read_text(file));
    const bound = new Set(decls.filter(([other]) => other === rel).map(([, , port]) => port));
    for (const match of docstring.matchAll(CLAIM_RE)) {
      const claimed = Number(match[1] ?? match[4]);
      if (!bound.has(claimed)) {
        const declared = [...bound].sort((a, b) => a - b);
        errors.push(
          `${rel}'s docstring names port ${claimed} shifted by the offset, but the file ` +
            `declares ${py_str(truthy(declared) ? declared : "no shifted port")}`,
        );
      }
    }
  }
  return errors;
}

export function duplicate_errors(decls: [string, number, number][]): string[] {
  const by_port = new Map<number, [string, number][]>();
  for (const [rel, lineno, port] of decls) {
    if (!by_port.has(port)) by_port.set(port, []);
    by_port.get(port)!.push([rel, lineno]);
  }
  const errors: string[] = [];
  for (const [port, sites] of [...by_port].sort((a, b) => a[0] - b[0])) {
    const files = new Set(sites.map(([rel]) => rel));
    if (files.size < 2) continue;
    const shared = SHARED.get(port);
    if (
      shared !== undefined &&
      (shared[0] === null ||
        (shared[0].size === files.size && [...files].every((f) => shared[0]!.has(f))))
    ) {
      continue;
    }
    const named = [...new Set(sites.map(([rel, lineno]) => JSON.stringify([rel, lineno])))]
      .map((s): [string, number] => JSON.parse(s))
      .sort((a, b) => by_code_point(a[0], b[0]) || a[1] - b[1])
      .map(([rel, lineno]) => `${rel}:${lineno}`)
      .join(", ");
    errors.push(`port ${port} is declared by ${files.size} files: ${named}`);
  }
  return errors;
}

/** (match-start, ports named, suite) for each `<port>[/<port>] = test_x` in the doc's prose. */
export function doc_entries(ports_doc: string): [number, number[], string][] {
  const text = read_text(ports_doc);
  const entries: [number, number[], string][] = [];
  for (const match of text.matchAll(DOC_ENTRY_RE)) {
    const [, a, b, suite] = match;
    entries.push([match.index, [Number(a), ...(b ? [Number(b)] : [])], suite!]);
  }
  return entries;
}

export function doc_errors(
  repo: string,
  ports_doc: string,
  decls: [string, number, number][],
): string[] {
  if (!fs.existsSync(ports_doc)) return [`${path.relative(repo, ports_doc)} not found`];
  const errors: string[] = [];
  const owner = new Map<number, string>();
  for (const [, ports, suite] of doc_entries(ports_doc)) {
    const suite_path = path.join(repo, "tests", `${suite}.ts`);
    const rel_doc = path.relative(repo, ports_doc);
    if (!fs.existsSync(suite_path)) {
      errors.push(
        `${rel_doc} names ${suite} for port(s) ${py_repr(ports)} but tests/${suite}.ts does not exist`,
      );
      continue;
    }
    const bound = new Set(
      decls.filter(([rel]) => rel === `tests/${suite}.ts`).map(([, , port]) => port),
    );
    for (const port of ports) {
      if (!bound.has(port)) {
        errors.push(
          `${rel_doc} names port ${port} for ${suite}, but tests/${suite}.ts never declares it`,
        );
      }
      const existing = owner.get(port);
      if (existing !== undefined && existing !== suite) {
        errors.push(`${rel_doc} names port ${port} for both ${existing} and ${suite}`);
      } else {
        owner.set(port, suite);
      }
    }
  }
  return errors;
}

const HELP = `usage: check_port_collisions.ts [-h] [--repo REPO] [--ports-doc PORTS_DOC]
                                [--print-globs]

Gate: no two suite defaults bind the same port, and every port claim tells the
truth. A default is an integer literal ADDED to the offset — a name containing
"offset" or a process.env read — anywhere in the scanned files. Each file is
read as a TypeScript AST, so the expression may span lines, may sit in a
template literal's span, the offset may be held under any name or wrapped in a
call, and a literal inside a string or a comment is prose rather than a bind.
No file in the tree writes that shape, and the summary says so where a reader
lands. Two files sharing one port refuse, except the ports in SHARED. A file's
leading comment block that NAMES a shifted port its own file never declares
refuses too: a comment is not a bind, but it is a claim, and a claim
contradicting the binds misroutes the next reader. Every \`<port> = test_x\`
named in ports.md must be one of that suite's shifted literals, and no port
may be named for two suites. No server, no ports. Usage: bun
scripts/check_port_collisions.ts [--repo DIR] [--ports-doc FILE] bun
scripts/check_port_collisions.ts --print-globs # scanned path families, one
per line

options:
  -h, --help            show this help message and exit
  --repo REPO           repo root to scan (default: this checkout)
  --ports-doc PORTS_DOC
                        ports.md path (default: <repo>/.agents/rules/ports.md)
  --print-globs`;

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parse_args(
    HELP.slice(0, HELP.indexOf("\n\n")),
    HELP + "\n",
    [
      ["--repo", "store", "repo"],
      ["--ports-doc", "store", "ports_doc"],
      ["--print-globs", "store_true", "print_globs"],
    ],
    { repo: REPO, ports_doc: null, print_globs: false },
    argv,
  );
  if (args.print_globs) {
    print(SCAN_GLOBS.join("\n"));
    return 0;
  }
  const repo = path.resolve(args.repo);
  const ports_doc = truthy(args.ports_doc)
    ? path.resolve(args.ports_doc)
    : path.join(repo, ".agents", "rules", "ports.md");

  const decls = declarations(repo);
  const errors = [
    ...duplicate_errors(decls),
    ...claim_errors(repo, decls),
    ...doc_errors(repo, ports_doc, decls),
  ];

  if (errors.length) {
    print(`❌ check_port_collisions: ${errors.length} problem(s)`);
    for (const e of errors) print(`  - ${e}`);
    return 1;
  }
  print(
    `✅ check_port_collisions: ${new Set(decls.map(([, , p]) => p)).size} default port(s) in ` +
      `${SCAN_GLOBS.join(", ")}, each owned by one file; every docstring claim matches its ` +
      "file's binds; .agents/rules/ports.md's named ports all resolve",
  );
  for (const [port, [, reason]] of [...SHARED].sort((a, b) => a[0] - b[0])) {
    print(`     shared by design: ${port} — ${reason}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main());

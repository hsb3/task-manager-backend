#!/usr/bin/env bun
/**
 * CI / battery check: every self-booting suite creates its superuser before it serves.
 *
 * A `pocketbase serve` against a --dir with no superuser yet is PocketBase's "first
 * run" — it launches the installer link in the machine's default browser (see
 * CLAUDE.md's clean-room law: upsert BEFORE serve). Textual line order is not a
 * proxy for this — a helper function's body sits above its call site — so this
 * walks module (and locally-resolvable function/method) bodies in DOCUMENT-ORDER-OF-
 * EXECUTION, inlining a call to a same-module function/method at its call site,
 * and flags any `serve` boot with no `superuser upsert` earlier in that order.
 *
 * What counts as a boot is check_room_preflight's `boots_server`, plus `roomkit.serve()`;
 * sharing that one definition is what stops the two gates drifting apart, and a suite the
 * sibling classifies as booting while this one does not is a hard error, never a quiet
 * "no server".
 *
 * Bound: resolves a call by NAME only (no receiver-type inference), does not
 * descend into loops/if branches' dynamic truth, and does not match a `superuser
 * upsert` to a `serve` by --dir value — any earlier upsert anywhere in the
 * flattened order satisfies a later serve. A boot launched via a shell string (`exec`,
 * `` Bun.$`…` ``) counts by its text in both gates; an upsert spelled that way does not.
 *
 * Usage:
 *     bun scripts/check_superuser_before_serve.ts [--table]
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse_args } from "./_argparse.ts";
import { by_code_point, print, py_join, read_text } from "./_py.ts";
import * as check_room_preflight from "./check_room_preflight.ts";
import { repo_root } from "./_repo_root.ts";
import { is_launch_call, parse_ts, roomkit_alias } from "./_ts_source.ts";

const REPO = repo_root(import.meta.path);
const TESTS_DIR = py_join(REPO, "tests");

// roomkit.serve() owns the spawn, so a call to it is a boot with no `serve` literal in sight.
const ROOM_BOOTER = "serve";

type Body = readonly ts.Node[];

/** The statements a branch runs: a block's statements, or the one bare statement. */
function _branch(stmt: ts.Statement | undefined): Body {
  if (stmt === undefined) return [];
  return ts.isBlock(stmt) ? stmt.statements : [stmt];
}

/**
 * Statements in document order, descending into try/if bodies (the shapes
 * these suites use) but stopping at a nested function/class — that's a separate scope,
 * inlined only when its name is actually called.
 */
function* _flatten_stmts(body: Body): Generator<ts.Node> {
  for (const stmt of body) {
    if (ts.isBlock(stmt)) {
      yield* _flatten_stmts(stmt.statements);
      continue;
    }
    yield stmt;
    if (ts.isTryStatement(stmt)) {
      yield* _flatten_stmts(stmt.tryBlock.statements);
      yield* _flatten_stmts(stmt.catchClause?.block.statements ?? []);
      yield* _flatten_stmts(stmt.finallyBlock?.statements ?? []);
    } else if (ts.isIfStatement(stmt)) {
      yield* _flatten_stmts(_branch(stmt.thenStatement));
      yield* _flatten_stmts(_branch(stmt.elseStatement));
    }
  }
}

function _literal_strings(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.add(n.text);
    }
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

function _is_roomkit_serve(call: ts.Node, modules: Set<string>): boolean {
  if (!ts.isCallExpression(call)) return false;
  const func = call.expression;
  return (
    ts.isPropertyAccessExpression(func) &&
    func.name.text === ROOM_BOOTER &&
    ts.isIdentifier(func.expression) &&
    modules.has(func.expression.text)
  );
}

function _classify(call: ts.Node, modules: Set<string>, carriers: Set<string>): string | null {
  if (_is_roomkit_serve(call, modules)) return "SERVE";
  if (!is_launch_call(call)) return null;
  // The sibling gate owns the definition of "launches a room", so the two cannot drift
  // apart on what counts — including an argv built in another function.
  if (check_room_preflight.boots_server(call, carriers)) return "SERVE";
  const lits = _literal_strings(call);
  if (lits.has("superuser") && lits.has("upsert")) return "SUPERUSER";
  return null;
}

function _callee_name(call: ts.CallExpression): string | null {
  const func = call.expression;
  if (ts.isIdentifier(func)) return func.text;
  if (ts.isPropertyAccessExpression(func)) return func.name.text;
  return null;
}

/** The statements of a function body: a block's statements, or an arrow's one expression. */
function _def_body(node: ts.Node | undefined): Body | null {
  if (node === undefined) return null;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.body ? node.body.statements : null;
  }
  // A class field holding a function (`boot = async () => {…}`) is called like a method.
  if (ts.isPropertyDeclaration(node)) return _def_body(node.initializer);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return ts.isBlock(node.body) ? node.body.statements : [node.body];
  }
  return null;
}

/**
 * Top-level function declarations (and `const f = () => ...`), and methods of any
 * top-level class, keyed by name.
 */
function _index_functions(tree: ts.SourceFile): [Map<string, Body>, Map<string, Body>] {
  const functions = new Map<string, Body>();
  const methods = new Map<string, Body>();
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const body = _def_body(node);
      if (body) functions.set(node.name.text, body);
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        const body = _def_body(d.initializer);
        if (body && ts.isIdentifier(d.name)) functions.set(d.name.text, body);
      }
    } else if (ts.isClassDeclaration(node)) {
      for (const sub of node.members) {
        const body = _def_body(sub);
        if (body && sub.name && ts.isIdentifier(sub.name) && !methods.has(sub.name.text)) {
          methods.set(sub.name.text, body);
        }
      }
    }
  }
  return [functions, methods];
}

/**
 * [kind, lineno] events in call/execution order, inlining a resolvable
 * function/method call's body at its call site.
 */
function _collect_events(
  body: Body,
  functions: Map<string, Body>,
  methods: Map<string, Body>,
  visiting: Set<string>,
  modules: Set<string>,
  carriers: Set<string>,
): [string, number][] {
  const events: [string, number][] = [];
  for (const stmt of _flatten_stmts(body)) {
    for (const node of check_room_preflight._own_nodes(stmt)) {
      if (!ts.isCallExpression(node) && !ts.isTaggedTemplateExpression(node)) continue;
      const kind = _classify(node, modules, carriers);
      if (kind) {
        const sf = node.getSourceFile();
        events.push([kind, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1]);
        continue;
      }
      if (!ts.isCallExpression(node)) continue;
      const name = _callee_name(node);
      const target =
        name && !visiting.has(name) ? (functions.get(name) ?? methods.get(name)) : undefined;
      if (name && target !== undefined) {
        events.push(
          ..._collect_events(
            target,
            functions,
            methods,
            new Set([...visiting, name]),
            modules,
            carriers,
          ),
        );
      }
      // A callback passed inline runs where it is passed (the TS spelling of a `with` body).
      for (const arg of node.arguments) {
        const body =
          ts.isArrowFunction(arg) || ts.isFunctionExpression(arg) ? _def_body(arg) : null;
        if (body)
          events.push(..._collect_events(body, functions, methods, visiting, modules, carriers));
      }
    }
  }
  return events;
}

/**
 * Line numbers of `serve` boots with no `superuser upsert` earlier in the
 * flattened module-level execution order.
 */
export function audit(src: string): [number[], number[]] {
  let tree: ts.SourceFile;
  try {
    tree = parse_ts(src, "audit.ts");
  } catch (e) {
    if (e instanceof SyntaxError) e.message += ` (<unknown>, line ${(e as any).lineno})`;
    throw e;
  }
  const [functions, methods] = _index_functions(tree);
  const events = _collect_events(
    tree.statements,
    functions,
    methods,
    new Set(),
    roomkit_alias(tree, ROOM_BOOTER)[0],
    check_room_preflight.serve_carrying_names(tree),
  );

  const serve_lines = events.filter(([kind]) => kind === "SERVE").map(([, ln]) => ln);
  const violations: number[] = [];
  let seen_superuser = false;
  for (const [kind, ln] of events) {
    if (kind === "SUPERUSER") seen_superuser = true;
    else if (kind === "SERVE" && !seen_superuser) violations.push(ln);
  }
  return [serve_lines, violations];
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const prog = path.basename(process.argv[1] ?? "");
  const usage = `usage: ${prog} [-h] [--table]`;
  const show_table = parse_args(
    usage,
    `${usage}

Check that every self-booting suite creates its superuser before it serves.

options:
  -h, --help  show this help message and exit
  --table     print the per-suite audit
`,
    [["--table", "store_true", "table"]],
    { table: false },
    argv,
  ).table;
  const errors: string[] = [];
  const rows: [string, string][] = [];

  for (const fname of fs.readdirSync(TESTS_DIR).sort(by_code_point)) {
    if (!(fname.startsWith("test_") && fname.endsWith(".ts"))) continue;
    const stem = fname.slice(0, -".ts".length);
    const src = read_text(py_join(TESTS_DIR, fname));
    let serve_lines: number[], violations: number[];
    try {
      [serve_lines, violations] = audit(src);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      errors.push(`${stem}: could not be parsed (${e.message}) — this checker cannot vouch for it`);
      rows.push([stem, "❌ UNPARSEABLE"]);
      continue;
    }
    if (!serve_lines.length) {
      // Fail closed on the population itself: a gate that quietly stops classifying a
      // self-booting suite still prints ✅, so the sibling gate's boot detector is the
      // cross-check — whichever of the two learns a new boot spelling first drags the
      // other with it instead of shrinking its own coverage in silence.
      if (check_room_preflight.audit(src)[0].length) {
        errors.push(
          `${stem}: check_room_preflight sees a room boot here but this gate ` +
            `classified none, so its upsert-before-serve order goes unchecked — ` +
            `teach _classify() the boot spelling that file uses`,
        );
        rows.push([stem, "❌ UNCLASSIFIED BOOT"]);
        continue;
      }
      rows.push([stem, "no server"]);
      continue;
    }
    if (violations.length) {
      errors.push(
        `${stem}: serve at line(s) ${violations.join(", ")} ` +
          `runs with no superuser upsert earlier in execution order — ` +
          `move the upsert ahead of serve (see CLAUDE.md clean-room law)`,
      );
      rows.push([stem, "❌ SERVE-BEFORE-UPSERT"]);
    } else {
      rows.push([stem, "ordered"]);
    }
  }

  if (show_table && rows.length) {
    const width = Math.max(...rows.map(([s]) => s.length));
    print(`${"suite".padEnd(width)}  disposition`);
    for (const [stem, state] of rows) print(`${stem.padEnd(width)}  ${state}`);
    print();
  }

  if (errors.length) {
    print("❌ check_superuser_before_serve: ordering violation(s):");
    for (const e of errors) print(`     • ${e}`);
    return 1;
  }

  const booting = rows.filter(([, state]) => state === "ordered").length;
  print(
    `✅ check_superuser_before_serve: ${booting} self-booting suite(s) create ` +
      `their superuser before they serve.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

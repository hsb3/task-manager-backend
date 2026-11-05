#!/usr/bin/env bun
/**
 * CI / battery check: every self-booting suite must preflight its port before serving.
 *
 * Bound: a boot is a subprocess launch whose command carries `serve`/`--http=` directly or
 * via a variable this module can resolve statically, a shell string (`exec`, `` Bun.$`…` ``)
 * included — a command built elsewhere, or any other launch mechanism is invisible here. The
 * undrained-pipe half is
 * wider than a boot: any `spawn` piping a channel counts, room or not, because a
 * full pipe blocks any long-lived child; a handle the same module reads a channel off is
 * exempt, and a handle the module hands out under another name is not tracked.
 *
 * Usage:
 *     bun scripts/check_room_preflight.ts [--table]
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse_args } from "./_argparse.ts";
import { by_code_point, os_walk, print, PY_WS, py_join, read_text } from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import { is_launch_call, parse_ts, roomkit_alias } from "./_ts_source.ts";

const REPO = repo_root(import.meta.path);
const TESTS_DIR = py_join(REPO, "tests");
const SCRIPTS_DIR = py_join(REPO, "scripts");
const ROOMKIT = py_join(TESTS_DIR, "roomkit.ts");
const BATTERY = py_join(REPO, "scripts", "run_suite_battery.sh");

const PREFLIGHT = "require_free_port";
// roomkit.serve() owns the spawn, so a call to it is a boot AND its own preflight.
const ROOM_BOOTER = "serve";
// Every helper roomkit now owns; a private near-copy is silent divergence.
const BANNED_LOCAL_DEFS = new Set([
  "find_free_check",
  "port_is_free",
  "wait_for_health",
  "wait_for_port_free",
]);
// `serve` not followed by a letter or digit (`serve_argv` still counts): prose such as "no server" in a help string must not make a carrier
// (the Python token also matched "server"; root ruling after macro review 3).
const SERVE_TOKEN = new RegExp(`(^|[${PY_WS}=])(serve(?![\\p{L}\\p{N}])|--http=)`, "u");
const PIPE_CHANNELS = ["stdout", "stderr"];

// Files that still leave an undrained pipe on a long-lived child's stdout or stderr. A full
// pipe blocks the child forever and a BLOCKED child is alive, so the dead-child watch cannot
// rescue it. The list can only shrink, and the reverse-drift check below enforces that:
// send the child's output to a log file and delete its line. Empty: no launch leaves one,
// so a new entry here is a regression, not a carve-out.
const PIPE_DEADLOCK_ALLOWLIST: Set<string> = new Set();

function _parse(src: string): ts.SourceFile {
  try {
    return parse_ts(src, "audit.ts");
  } catch (e) {
    if (e instanceof SyntaxError) e.message += ` (<unknown>, line ${(e as any).lineno})`;
    throw e;
  }
}

function _lineno(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Every node under `node` (itself included), like `ast.walk`; type annotations are skipped. */
function _walk(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    n.forEachChild((c) => {
      if (!ts.isTypeNode(c)) visit(c);
    });
  };
  visit(node);
  return out;
}

/** An identifier read as a value (Python's `ast.Name`), not a property, key or parameter name. */
function _is_name(node: ts.Node): node is ts.Identifier {
  if (!ts.isIdentifier(node)) return false;
  const p = node.parent;
  return !(
    ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isParameter(p)) &&
      p.name === node) ||
    ts.isQualifiedName(p)
  );
}

/** Text of a string literal or of a template's literal parts (Python's `str` constant). */
function _string_text(node: ts.Node): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    return node.text;
  }
  return null;
}

function* _strings_and_names(node: ts.Node): Generator<string> {
  for (const sub of _walk(node)) {
    const text = _string_text(sub);
    if (text !== null) yield text;
    else if (_is_name(sub)) yield sub.text;
  }
}

function _serve_literal(text: string): boolean {
  return text === "serve" || text.startsWith("--http=") || SERVE_TOKEN.test(text);
}

/** `[target names, value]` of an assignment-like node, or null. */
function _assignment(node: ts.Node): [string[], ts.Node] | null {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    return [ts.isIdentifier(node.name) ? [node.name.text] : [], node.initializer];
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return [ts.isIdentifier(node.left) ? [node.left.text] : [], node.right];
  }
  return null;
}

/** Variable names the module ever loads a serve/--http= argument into. */
export function serve_carrying_names(tree: ts.Node): Set<string> {
  const carriers = new Set<string>();
  for (const node of _walk(tree)) {
    let names: string[];
    let value: ts.Node;
    const assigned = _assignment(node);
    if (assigned) {
      [names, value] = assigned;
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["push", "unshift", "splice"].includes(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      [names, value] = [[node.expression.expression.text], node];
    } else {
      continue;
    }
    for (const s of _strings_and_names(value)) {
      if (_serve_literal(s)) {
        for (const n of names) carriers.add(n);
        break;
      }
    }
  }
  return carriers;
}

/** The called name: `f(...)` -> f, `x.f(...)` -> f. */
function _func_name(call: ts.CallExpression): string | null {
  const func = call.expression;
  if (ts.isPropertyAccessExpression(func)) return func.name.text;
  return ts.isIdentifier(func) ? func.text : null;
}

/** execFileSync pipes stdout unconditionally, with no option to read. */
function _is_check_output(call: ts.CallExpression): boolean {
  return _func_name(call) === "execFileSync";
}

/** Public: check_superuser_before_serve shares this definition of "launches a room". */
export function boots_server(call: ts.Node, carriers: Set<string>): boolean {
  for (const text of _strings_and_names(call)) {
    if (_serve_literal(text) || carriers.has(text)) return true;
  }
  return false;
}

function _is_roomkit_serve(node: ts.CallExpression, modules: Set<string>): boolean {
  const func = node.expression;
  return (
    ts.isPropertyAccessExpression(func) &&
    func.name.text === ROOM_BOOTER &&
    ts.isIdentifier(func.expression) &&
    modules.has(func.expression.text)
  );
}

/** A pipe in any spelling resolvable statically: the "pipe" literal or a bound name. */
function _is_pipe_value(node: ts.Node, pipe_names: Set<string>): boolean {
  if (ts.isIdentifier(node)) return pipe_names.has(node.text);
  return _string_text(node) === "pipe";
}

/** Names bound to "pipe", directly or through one more name. */
function _pipe_names(tree: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < 2; i++) {
    for (const node of _walk(tree)) {
      const assigned = _assignment(node);
      if (assigned && _is_pipe_value(assigned[1], names)) {
        for (const n of assigned[0]) names.add(n);
      }
    }
  }
  return names;
}

/** A `stdout`/`stderr` option set to a pipe, or a `stdio` that is one or pipes index 1 or 2. */
function _pipes_option(key: string | null, val: ts.Node, pipe_names: Set<string>): boolean {
  if (key !== null && PIPE_CHANNELS.includes(key)) return _is_pipe_value(val, pipe_names);
  if (key !== "stdio") return false;
  if (!ts.isArrayLiteralExpression(val)) return _is_pipe_value(val, pipe_names);
  return val.elements.slice(1, 3).some((e) => _is_pipe_value(e, pipe_names));
}

/** `[key, value]` of each property of an object literal (a shorthand `{ k }` is `k: k`). */
function _properties(obj: ts.ObjectLiteralExpression): [string | null, ts.Node][] {
  const out: [string | null, ts.Node][] = [];
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      out.push([key, p.initializer]);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      out.push([p.name.text, p.name]);
    }
  }
  return out;
}

/** Names bound to an object literal that pipes a channel — the `...KW` spelling. */
function _pipe_dict_names(tree: ts.SourceFile, pipe_names: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const node of _walk(tree)) {
    const assigned = _assignment(node);
    if (!assigned || !ts.isObjectLiteralExpression(assigned[1])) continue;
    for (const [key, val] of _properties(assigned[1])) {
      if (_pipes_option(key, val, pipe_names)) {
        for (const n of assigned[0]) names.add(n);
      }
    }
  }
  return names;
}

/**
 * True when this launch leaves an OS pipe on stdout or stderr for nobody to drain.
 *
 * stderr counts as much as stdout: PocketBase writes its boot errors there, which is why
 * roomkit.serve() merges the two into one log file.
 */
function _pipes_output(call: ts.Node, pipe_names: Set<string>, pipe_dicts: Set<string>): boolean {
  // A `Bun.$` template buffers its output itself; it has no options to pipe.
  if (!ts.isCallExpression(call)) return false;
  if (_is_check_output(call)) return true;
  for (const arg of call.arguments) {
    if (ts.isIdentifier(arg) && pipe_dicts.has(arg.text)) return true;
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const [key, val] of _properties(arg)) {
      if (_pipes_option(key, val, pipe_names)) return true;
    }
    for (const p of arg.properties) {
      if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) {
        if (pipe_dicts.has(p.expression.text)) return true;
      }
    }
  }
  return false;
}

/** spawnSync/execFileSync/run_checked all drain before returning; only spawn outlives the call. */
function _is_popen(call: ts.CallExpression): boolean {
  return _func_name(call) === "spawn";
}

/** Dotted text of a handle expression — `proc`, `this.proc`; null for anything else. */
function _handle_expr(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(node)) {
    const base = _handle_expr(node.expression);
    return base ? `${base}.${node.name.text}` : null;
  }
  return null;
}

/** spawn call node -> the handle it is assigned to; unassigned calls are absent. */
function _popen_bindings(tree: ts.SourceFile): Map<ts.Node, string> {
  const out = new Map<ts.Node, string>();
  for (const node of _walk(tree)) {
    let target: ts.Node;
    let value: ts.Node;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      [target, value] = [node.name, node.initializer];
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      [target, value] = [node.left, node.right];
    } else {
      continue;
    }
    if (!ts.isCallExpression(value)) continue;
    const handle = _handle_expr(target);
    if (handle) out.set(value, handle);
  }
  return out;
}

/**
 * Handles this module reads a channel off — any touch of p.stdout/p.stderr, since
 * reading it as a stream or a Response all empty the pipe.
 */
function _drained_handles(tree: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const node of _walk(tree)) {
    if (!ts.isPropertyAccessExpression(node) || !PIPE_CHANNELS.includes(node.name.text)) {
      continue;
    }
    const handle = _handle_expr(node.expression);
    if (handle) out.add(handle);
  }
  return out;
}

function _is_preflight_call(node: ts.Node, modules: Set<string>, direct: Set<string>): boolean {
  if (!ts.isCallExpression(node)) return false;
  const func = node.expression;
  if (ts.isPropertyAccessExpression(func)) {
    return (
      func.name.text === PREFLIGHT &&
      ts.isIdentifier(func.expression) &&
      modules.has(func.expression.text)
    );
  }
  return ts.isIdentifier(func) && direct.has(func.text);
}

/** A function, method, arrow or class: its body is a separate scope. */
function _is_nested_scope(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassLike(node);
}

const STATEMENT_KINDS = new Set([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
]);

function _is_stmt(node: ts.Node): boolean {
  return (
    STATEMENT_KINDS.has(node.kind) ||
    (node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement)
  );
}

/**
 * Nodes belonging to this statement itself — never a nested statement's body, so a
 * guard buried in an `if` branch does not read as the enclosing statement's guard.
 */
export function _own_nodes(stmt: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const stack = [stmt];
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    node.forEachChild((c) => {
      if (!_is_stmt(c) && !_is_nested_scope(c) && !ts.isTypeNode(c)) stack.push(c);
    });
  }
  return out;
}

/** The statements directly inside a compound statement (branches, loop bodies, try parts). */
function _child_statements(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  node.forEachChild((c) => {
    if (_is_stmt(c)) out.push(c);
    else if (ts.isCatchClause(c) || ts.isCaseBlock(c) || ts.isCaseOrDefaultClause(c)) {
      out.push(..._child_statements(c));
    }
  });
  return out;
}

/** Every statement in this scope, branches included, stopping at a nested scope. */
function* _scope_statements(body: readonly ts.Node[]): Generator<ts.Node> {
  for (const stmt of body) {
    if (ts.isBlock(stmt)) {
      yield* _scope_statements(stmt.statements);
      continue;
    }
    yield stmt;
    if (_is_nested_scope(stmt)) continue;
    yield* _scope_statements(_child_statements(stmt));
  }
}

/**
 * Statements that run whenever the scope runs — descends through try bodies
 * only, so an `if (false)` (or any branch) never counts as executed.
 */
function _unconditional(body: readonly ts.Node[]): ts.Node[] {
  const out: ts.Node[] = [];
  for (const stmt of body) {
    if (ts.isBlock(stmt)) {
      out.push(..._unconditional(stmt.statements));
      continue;
    }
    if (_is_nested_scope(stmt)) continue;
    out.push(stmt);
    if (ts.isTryStatement(stmt)) out.push(..._unconditional(stmt.tryBlock.statements));
  }
  return out;
}

/** The statements of a function-like body: a block's statements, or an arrow's one expression. */
function _body_of(node: ts.Node): readonly ts.Node[] | null {
  if (!ts.isFunctionLike(node) || !("body" in node) || !node.body) return null;
  const body = node.body as ts.Node;
  return ts.isBlock(body) ? body.statements : [body];
}

/** Every executable scope: the module plus each function/method body. */
function* _scopes(tree: ts.SourceFile): Generator<readonly ts.Node[]> {
  yield tree.statements;
  for (const node of _walk(tree)) {
    const body = _body_of(node);
    if (body) yield body;
  }
}

const _sorted_unique = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

/** Line numbers of server-boot calls, and of those, the unguarded and the pipe-blocked. */
export function audit(src: string): [number[], number[], boolean, number[]] {
  const tree = _parse(src);
  const carriers = serve_carrying_names(tree);
  const [modules, direct] = roomkit_alias(tree, PREFLIGHT);
  const pipe_names = _pipe_names(tree);
  const pipe_dicts = _pipe_dict_names(tree, pipe_names);
  const [bindings, drained] = [_popen_bindings(tree), _drained_handles(tree)];

  const [boots, unguarded, piped]: number[][] = [[], [], []];
  for (const body of _scopes(tree)) {
    let guard_line: number | null = null;
    for (const stmt of _unconditional(body)) {
      if (_own_nodes(stmt).some((n) => _is_preflight_call(n, modules, direct))) {
        guard_line = _lineno(stmt);
        break;
      }
    }
    for (const stmt of _scope_statements(body)) {
      for (const node of _own_nodes(stmt)) {
        if (!ts.isCallExpression(node) && !ts.isTaggedTemplateExpression(node)) continue;
        const lineno = _lineno(node);
        if (ts.isCallExpression(node) && _is_roomkit_serve(node, modules)) {
          boots.push(lineno);
        } else if (is_launch_call(node) && boots_server(node, carriers)) {
          boots.push(lineno);
          if (guard_line === null || guard_line >= lineno) unguarded.push(lineno);
          if (_pipes_output(node, pipe_names, pipe_dicts)) piped.push(lineno);
        }
        if (
          ts.isCallExpression(node) &&
          _is_popen(node) &&
          _pipes_output(node, pipe_names, pipe_dicts) &&
          !drained.has(bindings.get(node) ?? "")
        ) {
          piped.push(lineno);
        }
      }
    }
  }
  return [
    _sorted_unique(boots),
    _sorted_unique(unguarded),
    modules.size > 0 || direct.size > 0,
    _sorted_unique(piped),
  ];
}

export function banned_local_defs(src: string): string[] {
  const names = new Set<string>();
  for (const n of _walk(_parse(src))) {
    const is_def =
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      (ts.isVariableDeclaration(n) &&
        n.initializer !== undefined &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)));
    if (is_def && n.name && ts.isIdentifier(n.name) && BANNED_LOCAL_DEFS.has(n.name.text)) {
      names.add(n.name.text);
    }
  }
  return [...names].sort(by_code_point);
}

/** pathlib's ordering: part by part, each in code-point order. */
function _by_path_parts(a: string, b: string): number {
  const [pa, pb] = [a.split("/"), b.split("/")];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = by_code_point(pa[i]!, pb[i]!);
    if (c) return c;
  }
  return pa.length - pb.length;
}

/**
 * Repo-relative paths of every file that may boot a room: the suites, and the
 * scripts/ tools that boot one too (scripts/load_smoketest.ts does).
 *
 * scripts/ is walked RECURSIVELY — a room booted from scripts/utilities/ is a room.
 */
function* _audited_files(): Generator<string> {
  for (const fname of fs.readdirSync(TESTS_DIR).sort(by_code_point)) {
    if (fname.startsWith("test_") && fname.endsWith(".ts")) yield `tests/${fname}`;
  }
  const found: string[] = [];
  for (const [dir, , files] of os_walk(SCRIPTS_DIR)) {
    for (const f of files) {
      if (f.endsWith(".ts")) found.push(path.relative(REPO, py_join(dir, f)));
    }
  }
  yield* found.sort(_by_path_parts);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const prog = path.basename(process.argv[1] ?? "");
  const usage = `usage: ${prog} [-h] [--table]`;
  const show_table = parse_args(
    usage,
    `${usage}

Check that every self-booting suite preflights its port before serving.

options:
  -h, --help  show this help message and exit
  --table     print the per-suite audit
`,
    [["--table", "store_true", "table"]],
    { table: false },
    argv,
  ).table;
  const errors: string[] = [];

  if (!fs.existsSync(ROOMKIT)) {
    print(`❌ check_room_preflight: ${ROOMKIT} not found — the shared preflight is gone.`);
    return 1;
  }

  const rows: [string, string][] = [];
  const still_piping = new Set<string>();
  for (const rel of _audited_files()) {
    const stem = path.basename(rel).slice(0, -".ts".length);
    const src = read_text(py_join(REPO, rel));
    let boots: number[], unguarded: number[], imports_roomkit: boolean, piped: number[];
    let dupes: string[];
    try {
      [boots, unguarded, imports_roomkit, piped] = audit(src);
      dupes = banned_local_defs(src);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      errors.push(`${rel}: could not be parsed (${e.message}) — this checker cannot vouch for it`);
      rows.push([stem, "❌ UNPARSEABLE"]);
      continue;
    }
    for (const name of dupes) {
      errors.push(
        `${rel}: defines its own ${name}() — call the tests/roomkit ` +
          `one instead of re-copying the check`,
      );
    }
    if (piped.length) still_piping.add(rel);
    if (piped.length && !PIPE_DEADLOCK_ALLOWLIST.has(rel)) {
      errors.push(
        `${rel}: launches a long-lived child leaving an undrained pipe on ` +
          `stdout/stderr at line(s) ${piped.join(", ")} — a full pipe blocks ` +
          `the child forever, and a blocked child is ALIVE, so the dead-child watch ` +
          `never fires. Send both channels to a log file or DEVNULL (a room boots that ` +
          `way through roomkit.serve()), or drain the handle`,
      );
      rows.push([stem, "❌ PIPE DEADLOCK"]);
      continue;
    }
    if (!boots.length) {
      rows.push([stem, "no server"]);
      continue;
    }
    if (unguarded.length && !imports_roomkit) {
      errors.push(
        `${rel}: starts a server (line(s) ` +
          `${unguarded.join(", ")}) but never imports roomkit — ` +
          `call roomkit.${PREFLIGHT}(PORT) immediately before the serve`,
      );
      rows.push([stem, "❌ NO IMPORT"]);
    } else if (unguarded.length) {
      errors.push(
        `${rel}: server start at line(s) ` +
          `${unguarded.join(", ")} is not preceded by an ` +
          `unconditional roomkit.${PREFLIGHT}() in the same scope`,
      );
      rows.push([stem, "❌ UNGUARDED"]);
    } else {
      rows.push([stem, "preflighted"]);
    }
  }

  // Reverse drift: an allowlist that only ever grows is a carve-out, not a punch list.
  for (const rel of [...PIPE_DEADLOCK_ALLOWLIST]
    .filter((r) => !still_piping.has(r))
    .sort(by_code_point)) {
    const why = !fs.existsSync(py_join(REPO, rel))
      ? "no longer exists"
      : "no longer leaves an undrained pipe on a room boot";
    errors.push(
      `${rel}: listed in PIPE_DEADLOCK_ALLOWLIST but ${why} — delete its line, ` +
        `so the list keeps naming exactly the files that still carry the hazard`,
    );
  }

  if (!fs.existsSync(BATTERY)) {
    errors.push(`${BATTERY} not found`);
  } else {
    const battery = read_text(BATTERY);
    const start_room = /^start_room\(\) \{(.*?)^\}/ms.exec(battery);
    if (start_room === null) {
      errors.push(
        "could not find start_room() in scripts/run_suite_battery.sh — " +
          "this checker's parse assumption broke",
      );
    } else if (!start_room[1]!.includes("tests/roomkit.ts")) {
      errors.push(
        "scripts/run_suite_battery.sh's start_room() boots a room without " +
          "invoking tests/roomkit.ts — the legacy/email/hardening rooms would " +
          "bind blind",
      );
    }
  }

  if (show_table && rows.length) {
    const width = Math.max(...rows.map(([s]) => s.length));
    print(`${"suite".padEnd(width)}  disposition`);
    for (const [stem, state] of rows) print(`${stem.padEnd(width)}  ${state}`);
    print();
  }

  if (errors.length) {
    print("❌ check_room_preflight: port-preflight drift:");
    for (const e of errors) print(`     • ${e}`);
    return 1;
  }

  const booting = rows.filter(([, state]) => state === "preflighted").length;
  print(
    `✅ check_room_preflight: ${booting} self-booting file(s) in tests/ and scripts/ ` +
      `preflight their port via tests/roomkit.ts, and so does the battery's start_room.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

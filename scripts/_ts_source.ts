// Shared TypeScript-source parser: Python `ast.parse` for the checkers that audit .ts suites.

import path from "node:path";
import ts from "typescript";

/** Parse once; the first syntactic error throws SyntaxError (with `lineno`), type errors never do. */
export function parse_ts(text: string, file: string = "<unknown>"): ts.SourceFile {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // The public API (transpileModule, createProgram) cannot report these without a second parse or
  // a host, and differs on non-.ts file names; parseDiagnostics is internal, so typed only here.
  const diags = (tree as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  if (diags.length) {
    const d = diags[0]!;
    const lineno = tree.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
    throw Object.assign(new SyntaxError(ts.flattenDiagnosticMessageText(d.messageText, "\n")), {
      lineno,
    });
  }
  return tree;
}

/** Callee names that launch a subprocess: Bun, node:child_process, run_checked, and Python's bare names. */
export const LAUNCH_NAMES = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
  "run_checked",
  "run",
  "call",
  "Popen",
];

/** A `f(...)` / `x.f(...)` call with `f` in LAUNCH_NAMES, or a `` Bun.$`…` `` shell template. */
export function is_launch_call(
  node: ts.Node,
): node is ts.CallExpression | ts.TaggedTemplateExpression {
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = node.tag;
    return (
      ts.isPropertyAccessExpression(tag) &&
      tag.name.text === "$" &&
      ts.isIdentifier(tag.expression) &&
      tag.expression.text === "Bun"
    );
  }
  if (!ts.isCallExpression(node)) return false;
  const func = node.expression;
  const name = ts.isPropertyAccessExpression(func)
    ? func.name.text
    : ts.isIdentifier(func)
      ? func.text
      : null;
  return name !== null && LAUNCH_NAMES.includes(name);
}

/** [namespace aliases of roomkit, names bound directly to `member`]; any import depth, specifier extension ignored. */
export function roomkit_alias(tree: ts.SourceFile, member: string): [Set<string>, Set<string>] {
  const modules = new Set<string>();
  const direct = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      path.posix.parse(node.moduleSpecifier.text).name === "roomkit"
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
      else if (bindings) {
        for (const a of bindings.elements) {
          if ((a.propertyName ?? a.name).text === member) direct.add(a.name.text);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(tree);
  return [modules, direct];
}

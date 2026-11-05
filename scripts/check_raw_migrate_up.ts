#!/usr/bin/env bun
// CI / battery check: the `pocketbase migrate up` argv is spawned in ONE place.
//
// A caller that writes the argv itself holds only whatever exit-status check its author
// remembered, so scripts/pb_migrate.ts holds the one definition (`migrate_up()`); this
// walks scripts/ and tests/ and flags any other subprocess launch handing a process both
// the literal `migrate` and the literal `up`.
//
// One narrow exemption, by path: tests/test_pb_migrate.ts spawns the raw argv deliberately,
// as the falsification proof of PB's own verdict — it asserts PB's exit status on a failed
// migration is non-zero, and routing it through the helper would destroy the only thing in
// the repo that would notice PB's behaviour moving again. The green run prints that
// exemption and the line it sits on. The exemption covers exactly ONE call: a second spawn
// in an exempt file is a failure like any other. There is no blanket carve-out for tests/.
//
// The container is the one sanctioned second copy: the root Dockerfile's CMD preflight must
// spawn `migrate up` itself, before `serve`, in a shell that cannot import TypeScript. Its
// `KEEP IN SYNC: scripts/pb_migrate.ts` marker is enforced by the second half here, which
// reconciles the two failure verdicts across the language boundary — both test the same
// captured exit status, and the branch actually aborts. An output-line scan on either side is
// refused: the exit status is the whole verdict (owner ruling on ej2j, 2026-09-19).
//
// Bound: the TypeScript half is an AST walk over LITERAL argv strings inside the launch call
// expression, so prose and comments cannot match — but neither can an argv assembled in a
// variable or from a computed string, a launch through shell text (`Bun.$`, `exec`'s command
// string), or a spawn from a non-TypeScript caller (a .sh gate is not scanned). Argument order
// and adjacency are not checked: any subprocess launch whose call expression carries both
// literals counts.
// The predicate it reconciles is read off what `migrate_up()` RETURNS — the returned
// expressions, the `if` tests guarding a return, and whatever a returned local name is
// assigned — so a predicate left behind as dead code satisfies nothing; a verdict assembled
// where that cannot follow (a helper call, a module-level constant) is refused, not trusted.
// The Dockerfile half parses the CMD INSTRUCTION only, so a Dockerfile comment or another
// instruction mentioning the predicate satisfies nothing. Within it the shape is matched
// literally: an unrecognised capture or branch is an error, never a pass, because a shape
// this gate cannot read is a shape it cannot vouch for. Statements are split on `;` with
// single-quoted spans blanked first, so an `exit 1` inside a message is prose — but a
// `;`-separated `&&`/`||` chain reads as one statement and would not. It runs nothing: that
// the parsed CMD behaves this way is scripts/check_container_preflight.ts's job.
//
// Usage:
//     bun scripts/check_raw_migrate_up.ts [--table]

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse_args } from "./_argparse.ts";
import { PY_WS, by_code_point, print, read_text } from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import { is_launch_call, parse_ts } from "./_ts_source.ts";

const REPO = repo_root(import.meta.path);
const SCAN_DIRS = ["scripts", "tests"];

const HELPER = "scripts/pb_migrate.ts";
const VERDICT = "migrate_up";
// This gate names the helper in its own prose; that is not a call site.
const SELF = path.relative(REPO, path.resolve(import.meta.path));
// Path -> why it may write the argv itself. Deliberately per-file, never a directory.
const EXEMPT: Record<string, string> = {
  "tests/test_pb_migrate.ts":
    "falsification proof — asserts PB's own exit status on a FAILED migration is " +
    "non-zero, which would notice PB going back to 0.39's exit-0 report",
};

const DOCKERFILE = "Dockerfile";
const W = String.raw`[\p{L}\p{N}_]`;
// The CMD instruction ALONE. Scanning the whole file would let a Dockerfile comment mentioning
// the predicate stand in for the predicate — the very "prose counts" failure the TypeScript half
// is built to avoid.
const CMD_RE = /(?:^|(?<=\n))CMD .*/su;
// The status var name is READ off the capture, never assumed, so a test on some other
// variable cannot pass as a check of the migrate run's own exit status.
const CAPTURE_RE = new RegExp(
  String.raw`${W}+=\$\([${PY_WS}]*[^)]*?(?<!${W})migrate up(?!${W})[^)]*\)[${PY_WS}]*;[${PY_WS}]*(${W}+)=\$\?`,
  "u",
);
const SERVE_RE = new RegExp(String.raw`(?<!${W})exec(?!${W})[^;]*(?<!${W})serve(?!${W})`, "u");
// `exit 1` as a STATEMENT, not a substring: an `echo 'we should exit 1 here'` is prose, and
// prose standing in for code is the failure this half exists to refuse.
const SQUOTED_RE = /'[^']*'/gu;
const EXIT_RE = new RegExp(String.raw`(?:^|;)[${PY_WS}]*exit 1[${PY_WS}]*(?=;|$)`, "u");
const BRANCH_RE = new RegExp(
  String.raw`if \[ "\$(?<status>${W}+)" -ne 0 \]; then (?<body>.+?); fi`,
  "u",
);
// An output-line scan is refused outright, whatever it is joined with.
const SCAN_RE = /grep -q '\^/u;

/** The CMD's shell script, de-continued and unescaped onto one line; null when absent. */
function _cmd_script(dockerfile: string): string | null {
  const m = CMD_RE.exec(dockerfile);
  if (m === null) {
    return null;
  }
  return m[0]
    .replaceAll("\\\n", " ")
    .replaceAll('\\"', '"')
    .replace(new RegExp(`[${PY_WS}]+`, "gu"), " ");
}

/** Python's `ast.walk`: breadth-first, the node itself first. */
function* _walk(node: ts.Node): Generator<ts.Node> {
  const queue = [node];
  for (let i = 0; i < queue.length; i++) {
    yield queue[i]!;
    queue[i]!.forEachChild((c) => {
      queue.push(c);
    });
  }
}

/** A name read or written, not the `.name` of a property access or an object key. */
function _is_ref(n: ts.Node): n is ts.Identifier {
  if (!ts.isIdentifier(n)) return false;
  const p = n.parent;
  return !((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) && p.name === n);
}

/** Every node under `fn` except those inside a nested function — a nested function's
 * own `return` is not this function's verdict. */
function* _own_nodes(fn: ts.Node): Generator<ts.Node> {
  const stack: ts.Node[] = [];
  fn.forEachChild((c) => {
    stack.push(c);
  });
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    if (ts.isFunctionLike(node)) {
      continue;
    }
    node.forEachChild((c) => {
      stack.push(c);
    });
  }
}

/**
 * Every node of the expressions that FORM what `fn` returns.
 *
 * Returned expressions and the `if` tests that guard a return, with a local name replaced
 * by whatever is assigned to it. Presence anywhere in the body is not enough: a predicate
 * assigned to a name the function never returns is dead code, and dead code satisfying
 * this gate is the whole failure it exists to refuse.
 */
function _verdict_nodes(fn: ts.Node): ts.Node[] {
  const own = [..._own_nodes(fn)];
  const assigns = new Map<string, ts.Node[]>();
  for (const node of own) {
    let target: ts.Node | undefined;
    let value: ts.Node | undefined;
    if (ts.isVariableDeclaration(node)) {
      [target, value] = [node.name, node.initializer];
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      [target, value] = [node.left, node.right];
    }
    if (target === undefined || value === undefined) {
      continue;
    }
    for (const n of _walk(target)) {
      if (_is_ref(n)) {
        assigns.set(n.text, [...(assigns.get(n.text) ?? []), value]);
      }
    }
  }

  const queue: ts.Node[] = own.flatMap((n) =>
    ts.isReturnStatement(n) && n.expression ? [n.expression] : [],
  );
  queue.push(
    ...own.flatMap((n) =>
      ts.isIfStatement(n) && [..._walk(n)].some((b) => ts.isReturnStatement(b))
        ? [n.expression]
        : [],
    ),
  );
  const nodes = new Set<ts.Node>();
  const resolved = new Set<string>();
  while (queue.length) {
    for (const node of _walk(queue.pop()!)) {
      nodes.add(node);
      if (_is_ref(node) && !resolved.has(node.text)) {
        resolved.add(node.text);
        queue.push(...(assigns.get(node.text) ?? []));
      }
    }
  }
  return [...nodes];
}

/** Parse TypeScript source; a syntax error throws SyntaxError (as Python's `ast.parse`). */
function _parse(src: string): ts.SourceFile {
  try {
    return parse_ts(src, "x.ts");
  } catch (e) {
    if (e instanceof SyntaxError) e.message += ` (<unknown>, line ${(e as any).lineno})`;
    throw e;
  }
}

/** (whether migrate_up's verdict reads the exit status, whether it also scans output lines). */
function _python_predicate(src: string): [boolean, boolean] {
  // migrate_up ALONE: pb_bin_path reads an exitCode of its own, and counting that would
  // keep this half green through a migrate_up that stopped looking at the exit status.
  const tree = [..._walk(_parse(src))].find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === VERDICT,
  );
  if (tree === undefined) {
    return [false, false];
  }
  const verdict = _verdict_nodes(tree);
  const reads_status = verdict.some(
    (n) => ts.isPropertyAccessExpression(n) && n.name.text === "exitCode",
  );
  const scans_output = verdict.some(
    (n) =>
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "startsWith",
  );
  return [reads_status, scans_output];
}

/** Errors when the Dockerfile CMD preflight and migrate_up() disagree on what a failure is. */
function audit_container_predicate(): string[] {
  const file = path.join(REPO, DOCKERFILE);
  if (!(fs.existsSync(file) && fs.statSync(file).isFile())) {
    return [`${DOCKERFILE}: not found — the container preflight cannot be reconciled`];
  }
  const [py_status, py_scan] = _python_predicate(read_text(path.join(REPO, HELPER)));
  const errors: string[] = [];
  if (!py_status) {
    errors.push(
      `${HELPER}: ${VERDICT}()'s returned verdict no longer reads the process exit status`,
    );
  }
  if (py_scan) {
    errors.push(
      `${HELPER}: ${VERDICT}()'s returned verdict scans output lines — the exit status ` +
        `is the whole verdict; drop the scan`,
    );
  }

  const script = _cmd_script(read_text(file));
  if (script === null) {
    return [...errors, `${DOCKERFILE}: no CMD instruction — there is no preflight to reconcile`];
  }
  if (SCAN_RE.test(script)) {
    errors.push(
      `${DOCKERFILE}: the CMD scans its captured output lines — the exit status is the ` +
        `whole verdict; keep only the exit-status test`,
    );
  }
  const capture = CAPTURE_RE.exec(script);
  if (capture === null) {
    return [
      ...errors,
      `${DOCKERFILE}: the CMD does not capture a \`migrate up\` run and its exit status ` +
        `(\`OUT=$(... migrate up ...); STATUS=$?\`) — the preflight this gate exists to ` +
        `reconcile is not there`,
    ];
  }
  const status_var = capture[1]!;
  const serve = SERVE_RE.exec(script);
  if (serve === null || serve.index < capture.index + capture[0].length) {
    errors.push(
      `${DOCKERFILE}: the CMD does not \`exec ... serve\` AFTER the preflight — a ` +
        `preflight that runs after the server is already bound guards nothing`,
    );
  }

  const branch = BRANCH_RE.exec(script);
  if (branch === null) {
    return [
      ...errors,
      `${DOCKERFILE}: the CMD's refusal branch is not the shape this gate reconciles ` +
        `(\`if [ "$STATUS" -ne 0 ]; then ...; fi\`) — it cannot vouch for what the ` +
        `container does with a refused migration`,
    ];
  }
  if (branch.groups!.status !== status_var) {
    errors.push(
      `${DOCKERFILE}: the refusal tests \`$${branch.groups!.status}\` but the migrate exit ` +
        `status was captured into \`$${status_var}\``,
    );
  }
  if (!EXIT_RE.test(branch.groups!.body!.replace(SQUOTED_RE, "''"))) {
    errors.push(
      `${DOCKERFILE}: the refusal branch does not \`exit 1\` — it would print the fatal ` +
        `and serve the half-migrated database anyway`,
    );
  }
  return errors;
}

function _literal_strings(node: ts.Node): Set<string> {
  const out = new Set<string>();
  for (const n of _walk(node)) {
    if (ts.isStringLiteralLike(n) || ts.isTemplateLiteralToken(n)) {
      out.add(n.text);
    }
  }
  return out;
}

/** Line numbers of subprocess launches carrying the literal `migrate` + `up` argv. */
export function audit(src: string): number[] {
  const sf = _parse(src);
  const lines: number[] = [];
  for (const node of _walk(sf)) {
    if (!is_launch_call(node)) {
      continue;
    }
    const lits = _literal_strings(node);
    if (lits.has("migrate") && lits.has("up")) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
  }
  return lines.sort((a, b) => a - b);
}

function _python_files(): string[] {
  const out: string[] = [];
  for (const d of SCAN_DIRS) {
    const glob = new Bun.Glob("**/*.ts").scanSync({ cwd: path.join(REPO, d), dot: true });
    for (const rel of glob) {
      out.push(path.join(d, rel));
    }
  }
  return out.sort(by_code_point);
}

const USAGE = "usage: check_raw_migrate_up.ts [-h] [--table]";
const HELP = `${USAGE}

Check that the \`pocketbase migrate up\` argv is spawned in one place.

options:
  -h, --help  show this help message and exit
  --table     print the per-file audit
`;

export function main(argv: string[] = process.argv.slice(2)): number {
  const show_table = parse_args(
    USAGE,
    HELP,
    [["--table", "store_true", "table"]],
    { table: false },
    argv,
  ).table as boolean;
  const errors: string[] = [];
  const rows: [string, string][] = [];
  const exempt_seen = new Map<string, number[]>();

  const files = _python_files();
  for (const rel of files) {
    const src = read_text(path.join(REPO, rel));
    let spawns: number[];
    try {
      spawns = audit(src);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      errors.push(`${rel}: could not be parsed (${e.message}) — this checker cannot vouch for it`);
      rows.push([rel, "❌ UNPARSEABLE"]);
      continue;
    }
    if (rel === HELPER) {
      rows.push([rel, "the one definition"]);
      continue;
    }
    if (Object.hasOwn(EXEMPT, rel)) {
      exempt_seen.set(rel, spawns);
      // The exemption justifies ONE call; a second would ride the allowlist unexamined.
      if (spawns.length > 1) {
        // Which one is the sanctioned proof is not decidable by position, so name
        // them all rather than blessing the lowest line number as the real one.
        errors.push(
          `${rel}: line(s) ${spawns.join(", ")} — the exemption covers ` +
            `exactly ONE \`migrate up\` (the falsification proof) and this file now has ` +
            `${spawns.length}; keep that one and route the rest through ${HELPER}`,
        );
        rows.push([rel, "❌ EXTRA SPAWN"]);
      } else {
        rows.push([rel, "exempt by path"]);
      }
      continue;
    }
    if (spawns.length) {
      errors.push(
        `${rel}: line(s) ${spawns.join(", ")} spawn the ` +
          `\`migrate up\` argv directly — PB 0.39.9 exited 0 on a FAILED migration and 0.40.4 ` +
          `exits 1, so one verdict refusing on either lives in one place; import migrate_up from ` +
          `${HELPER} instead`,
      );
      rows.push([rel, "❌ RAW SPAWN"]);
    } else if (rel === SELF) {
      rows.push([rel, "this gate"]);
    } else if (src.includes("migrate_up")) {
      rows.push([rel, `routes through ${HELPER}`]);
    } else {
      rows.push([rel, "no migration replay"]);
    }
  }

  if (show_table && rows.length) {
    const width = Math.max(...rows.map(([s]) => s.length));
    print(`${"file".padEnd(width)}  disposition`);
    for (const [rel, state] of rows) {
      print(`${rel.padEnd(width)}  ${state}`);
    }
    print();
  }

  errors.push(...audit_container_predicate());

  if (errors.length) {
    print("❌ check_raw_migrate_up: the `migrate up` argv is not spawned in one place:");
    for (const e of errors) {
      print(`     • ${e}`);
    }
    return 1;
  }

  print(
    `✅ check_raw_migrate_up: ${files.length} source file(s) under ` +
      `${SCAN_DIRS.join("/, ")}/ scanned; the \`migrate up\` argv is spawned only in ${HELPER}. ` +
      `${DOCKERFILE}'s CMD spawns its own before \`serve\` and exits 1 when that run's exit ` +
      `status is non-zero — the verdict ${VERDICT}() makes.`,
  );
  for (const [rel, reason] of Object.entries(EXEMPT)) {
    const where =
      (exempt_seen.get(rel) ?? []).map((ln) => `line ${ln}`).join(", ") || "no spawn present";
    print(`     exempt: ${rel} (${where}) — ${reason}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

#!/usr/bin/env bun
// Generate .gitattributes so every GENERATED artifact conflicts on a contended regen.
//
// Git text-merges a generated file exactly like hand-written source, so two branches that
// each regenerated the same artifact merge into a plausible, wrong file with no signal. Each
// generator's output path is read out of the generator's own source, never hand-copied here,
// so a new generator is covered without editing this script — or breaks it loudly.
//
// Usage: bun scripts/gen_gitattributes.ts [--check]

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse_args } from "./_argparse.ts";
import { PY_WS, by_code_point, print, py_join, read_text, splitlines } from "./_py.ts";
import { parse_ts } from "./_ts_source.ts";

const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));
const OUTPUT = path.join(REPO, ".gitattributes");

// `binary` is a git BUILT-IN merge driver ("declare a conflict"), so it needs no per-clone
// .git/config stanza and travels with the checkout; a named driver would not.
const ATTRIBUTE = "merge=binary";

const HEADER =
  "# GENERATED FILE — DO NOT EDIT BY HAND. " +
  "Regenerate with: bun scripts/gen_gitattributes.ts\n";

// scripts/model/ holds one generator and one checker, told apart only by which one WRITES —
// globbing the directory would refuse on the checker forever, so its generator is named.
const GENERATOR_GLOBS = [
  "scripts/gen_*.ts",
  "scripts/utilities/*/build*.ts",
  "scripts/model/extract_current.ts",
  "web/scripts/gen-*.mjs",
  "web/openapi-ts.config.ts",
];

// The output-constant names the repo's TypeScript generators declare. A name ending in _DIR
// declares a directory; every other one declares a single file.
const PY_OUTPUT_NAMES = [
  "OUTPUT",
  "DEFAULT_OUTPUT",
  "SCHEMA_DIR",
  "DEFAULT_OUT",
  "OUT",
  "OUT_DIR",
  "PATTERNS_FILE",
];

const JS_OUTPUT_NAMES = ["OUT_JSON", "OUT_HTML"];
const JS_CONST = new RegExp(
  String.raw`(?:^|(?<=\n))[${PY_WS}]*const[${PY_WS}]+(OUT_JSON|OUT_HTML)[${PY_WS}]*=[${PY_WS}]*["']([^"']+)["']`,
  "gu",
);

const TS_OUTPUT_NAMES = ["output.path"];
const TS_OUTPUT_PATH = new RegExp(
  String.raw`output[${PY_WS}]*:[${PY_WS}]*\{[^}]*?(?<![\p{L}\p{N}_])path[${PY_WS}]*:[${PY_WS}]*["']([^"']+)["']`,
  "gsu",
);

/** A discovered generator whose output path this script cannot derive. */
class Unrecognised extends Error {}

function _dotted(node: ts.Node): string {
  const parts: string[] = [];
  while (ts.isPropertyAccessExpression(node)) {
    parts.push(node.name.text);
    node = node.expression;
  }
  if (!ts.isIdentifier(node)) {
    return "";
  }
  parts.push(node.text);
  return parts.reverse().join(".");
}

/** Python's `os.path.normpath` for a relative path. */
function _normpath(p: string): string {
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** Repo-relative form of a path, or null once it walks out above the repo root. */
function _norm(p: string): string | null {
  p = _normpath(p);
  if (p === ".") {
    return "";
  }
  return p === ".." || p.startsWith("../") ? null : p;
}

function _up(p: string | null, levels: number): string | null {
  for (let i = 0; i < levels; i++) {
    if (p === null) {
      return null;
    }
    p = _norm(py_join(p, ".."));
  }
  return p;
}

/**
 * Statically evaluate a module-level path expression, following its anchor constant.
 *
 * A bare string literal resolves to null: without an anchor there is nothing to join it to.
 */
function _eval(node: ts.Node, env: Map<string, string | null>): string | null {
  // Python's AST has no parentheses node.
  while (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  if (ts.isIdentifier(node)) {
    return env.get(node.text) ?? null;
  }

  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  ) {
    const file = env.get("import.meta.path") ?? null;
    if (node.name.text === "path") {
      return file;
    }
    return node.name.text === "dir" ? _up(file, 1) : null;
  }

  if (ts.isCallExpression(node)) {
    const name = _dotted(node.expression);
    const args = node.arguments;
    if (name === "path.join") {
      return _join(args, env);
    }
    if (name === "path.resolve") {
      return args.length === 1 ? _eval(args[0]!, env) : _join(args, env);
    }
    if (name === "path.dirname") {
      return args.length === 1 ? _up(_eval(args[0]!, env), 1) : null;
    }
    if (name === "repo_root") {
      return "";
    }
  }

  return null;
}

function _join(args: readonly ts.Expression[], env: Map<string, string | null>): string | null {
  if (!args.length) {
    return null;
  }
  const base = _eval(args[0]!, env);
  if (base === null) {
    return null;
  }
  const parts: string[] = [];
  for (const arg of args.slice(1)) {
    if (!ts.isStringLiteralLike(arg)) {
      return null;
    }
    parts.push(arg.text);
  }
  return _norm(py_join(base, ...parts));
}

/** (repo-relative output path, is_dir) per output constant a TypeScript generator declares. */
function _python_outputs(rel_source: string, text: string): [string, boolean][] {
  const env = new Map<string, string | null>([["import.meta.path", rel_source]]);
  const out: [string, boolean][] = [];
  const sf = parse_ts(text, rel_source);
  for (const node of sf.statements) {
    if (!ts.isVariableStatement(node)) {
      continue;
    }
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) {
        continue;
      }
      const name = decl.name.text;
      const resolved = decl.initializer ? _eval(decl.initializer, env) : null;
      env.set(name, resolved);
      if (!PY_OUTPUT_NAMES.includes(name)) {
        continue;
      }
      if (resolved === null) {
        throw new Unrecognised(
          `${rel_source}: ${name} is not a statically resolvable path expression ` +
            `anchored on a module-level constant`,
        );
      }
      out.push([resolved, name.endsWith("_DIR")]);
    }
  }
  return out;
}

/** A leading ./ or ../ is relative to the generator's own directory, anything else to REPO. */
function _resolve(rel_source: string, value: string): string {
  const base = value.startsWith(".") ? path.posix.dirname(rel_source) : "";
  return _normpath(py_join(base, value));
}

/** (path, is_dir) per output a generator writes. Throws Unrecognised when it declares none. */
function outputs_of(rel_source: string): [string, boolean][] {
  const text = read_text(path.join(REPO, rel_source));

  let found: [string, boolean][];
  let names: string[];
  if (!rel_source.endsWith(".mjs") && !rel_source.endsWith(".config.ts")) {
    // Already repo-relative: a TypeScript generator builds its output path from REPO.
    [found, names] = [_python_outputs(rel_source, text), PY_OUTPUT_NAMES];
  } else {
    let raw: string[];
    let is_dir: boolean;
    if (rel_source.endsWith(".mjs")) {
      [raw, names, is_dir] = [
        [...text.matchAll(JS_CONST)].map((m) => m[2]!),
        JS_OUTPUT_NAMES,
        false,
      ];
    } else {
      // The codegen config's `output.path` is a directory by definition.
      [raw, names, is_dir] = [
        [...text.matchAll(TS_OUTPUT_PATH)].map((m) => m[1]!),
        TS_OUTPUT_NAMES,
        true,
      ];
    }
    found = raw.map((v): [string, boolean] => [_resolve(rel_source, v), is_dir]);
  }

  if (!found.length) {
    throw new Unrecognised(
      `${rel_source}: no output path found — looked for ${names.join(", ")}. ` +
        `Teach scripts/gen_gitattributes.ts this generator's output constant.`,
    );
  }
  return found;
}

/**
 * The attributes pattern for one output, from the generator's own declaration.
 *
 * Guessing from the path string instead read an extensionless FILE as a directory and wrote
 * `NAME/**`, which matches nothing — the artifact shipped unprotected while --check stayed
 * green, because the generator reproduced the same wrong pattern it was asked to check.
 */
function _pattern(rel: string, is_dir: boolean, rel_source: string): string {
  const on_disk = path.join(REPO, rel);
  if (fs.existsSync(on_disk) && fs.statSync(on_disk).isDirectory() !== is_dir) {
    throw new Unrecognised(
      `${rel_source}: declares ${rel} as a ${is_dir ? "directory" : "file"} but the tree ` +
        `has a ${!is_dir ? "directory" : "file"} there — rename the constant to match ` +
        `(a name ending _DIR declares a directory) or fix the generator.`,
    );
  }
  return is_dir ? `${rel}/**` : rel;
}

/** Render .gitattributes content. Throws Unrecognised on an underivable generator. */
function render(): string {
  const patterns = new Set<string>();
  for (const pattern of GENERATOR_GLOBS) {
    for (const rel_source of new Bun.Glob(pattern).scanSync({ cwd: REPO, onlyFiles: false })) {
      for (const [out, is_dir] of outputs_of(rel_source)) {
        patterns.add(_pattern(out, is_dir, rel_source));
      }
    }
  }
  return (
    HEADER +
    [...patterns]
      .sort(by_code_point)
      .map((p) => `${p} ${ATTRIBUTE}\n`)
      .join("")
  );
}

const USAGE = "usage: gen_gitattributes.ts [-h] [--check]";
const HELP = `${USAGE}

Generate .gitattributes from the output paths the repo's generators declare.

options:
  -h, --help  show this help message and exit
  --check     fail on drift instead of writing
`;

function main(argv: string[] = process.argv.slice(2)): number {
  const check_mode = parse_args(
    USAGE,
    HELP,
    [["--check", "store_true", "check"]],
    { check: false },
    argv,
  ).check as boolean;

  let content: string;
  try {
    content = render();
  } catch (exc) {
    if (!(exc instanceof Unrecognised || exc instanceof SyntaxError)) throw exc;
    print(`❌ gen_gitattributes: ${exc.message}`);
    return 1;
  }

  if (check_mode) {
    return _check(content);
  }

  fs.writeFileSync(OUTPUT, content);
  print(
    `✅ gen_gitattributes: wrote ${content.split(ATTRIBUTE).length - 1} pattern(s) to .gitattributes.`,
  );
  return 0;
}

function _check(content: string): number {
  let on_disk: string;
  try {
    on_disk = read_text(OUTPUT);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    print(
      "❌ gen_gitattributes --check: .gitattributes does not exist. " +
        "Run `bun scripts/gen_gitattributes.ts` to generate it.",
    );
    return 1;
  }

  if (on_disk === content) {
    print("✅ gen_gitattributes --check: .gitattributes is up to date.");
    return 0;
  }

  const want = new Set(splitlines(content));
  const got = new Set(splitlines(on_disk));
  for (const line of [...want].filter((l) => !got.has(l)).sort(by_code_point)) {
    print(`   + ${line}`);
  }
  for (const line of [...got].filter((l) => !want.has(l)).sort(by_code_point)) {
    print(`   - ${line}`);
  }
  print(
    "❌ gen_gitattributes --check: .gitattributes does not match the generators' " +
      "declared outputs.\n   Run `bun scripts/gen_gitattributes.ts` to regenerate it.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}

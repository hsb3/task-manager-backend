// Python argparse's parse_args for the ported CLIs (Python 3.14 semantics, allow_abbrev on).
// Exports: ArgSpec, parse_args

import path from "node:path";
import { py_int, py_repr } from "./_py.ts";

/**
 * `flags` is the "/"-joined option strings (`"-o/--out"`), or a positional's name (no
 * leading "-", one required value). `store` takes one value, `append` collects them.
 * `required` is argparse's: `true` on an option is `required=True`, `false` on a positional is
 * `nargs="?"` (zero or one value, `dest` keeps its default). `type` `"int"` is argparse's
 * `type=int`: each value is converted with `py_int` as it is consumed.
 */
export type ArgSpec = [
  flags: string,
  action: "store" | "store_true" | "append",
  dest: string,
  required?: boolean,
  type?: "int",
];

type Action = { name: string; nargs: 0 | 1; spec: ArgSpec };
// [action or null (unknown option), option string, sep, explicit argument]
type OptionTuple = [Action | null, string, string | null, string | null];

class ArgumentError extends Error {}

/**
 * argparse's `parse_args`: `usage` (no trailing newline) and `help` are argparse's own text
 * pre-rendered at 80 columns. Errors print usage + `<prog>: error: ...` to stderr and exit
 * 2; `-h`/`--help` prints `help` to stdout and exits 0. `prog` is the running script's
 * basename. shortcut: `--` is an ordinary argument (Bun consumes a bare `--` before the
 * script sees it), and an option spelled like a negative number is not supported.
 * `groups` are `add_mutually_exclusive_group(required=...)` over option `dest`s.
 */
export function parse_args(
  usage: string,
  help: string,
  specs: ArgSpec[],
  defaults: Record<string, any>,
  argv: string[] = process.argv.slice(2),
  groups: { required: boolean; dests: string[] }[] = [],
): Record<string, any> {
  const prog = path.basename(process.argv[1] ?? "");
  const fail = (msg: string): never => {
    process.stderr.write(`${usage}\n${prog}: error: ${msg}\n`);
    process.exit(2);
  };
  const help_action: Action = {
    name: "-h/--help",
    nargs: 0,
    spec: ["-h/--help", "store_true", ""],
  };
  const options = new Map<string, Action>([
    ["-h", help_action],
    ["--help", help_action],
  ]);
  const positionals: Action[] = [];
  // argparse lists missing required actions in declaration order, positionals and options mixed.
  const required: Action[] = [];
  for (const spec of specs) {
    const action: Action = { name: spec[0], nargs: spec[1] === "store_true" ? 0 : 1, spec };
    if (!spec[0].startsWith("-")) positionals.push(action);
    else for (const flag of spec[0].split("/")) options.set(flag, action);
    if (spec[3] ?? !spec[0].startsWith("-")) required.push(action);
  }

  // argparse `_parse_optional` + `_get_option_tuples`: null means a positional argument.
  const parse_optional = (arg: string): OptionTuple[] | null => {
    if (!arg || arg[0] !== "-") return null;
    if (options.has(arg)) return [[options.get(arg)!, arg, null, null]];
    if (arg.length === 1) return null;
    const eq = arg.indexOf("=");
    const [prefix, sep, explicit] =
      eq < 0 ? [arg, null, null] : [arg.slice(0, eq), "=", arg.slice(eq + 1)];
    if (sep && options.has(prefix)) return [[options.get(prefix)!, prefix, sep, explicit]];
    const out: OptionTuple[] = [];
    const short = arg[1] !== "-";
    for (const [flag, action] of options) {
      if (short && flag === arg.slice(0, 2)) out.push([action, flag, "", arg.slice(2)]);
      else if (flag.startsWith(prefix)) out.push([action, flag, sep, explicit]);
    }
    if (out.length) return out;
    if (/^-\.?\d/.test(arg) || arg.includes(" ")) return null;
    return [[null, arg, null, null]];
  };

  const ns: Record<string, any> = { ...defaults };
  const seen = new Set<Action>();
  const seen_dests = new Set<string>();
  const extras: string[] = [];
  const take = (action: Action, raw: string | null): void => {
    let value: string | number | null = raw;
    if (raw !== null && action.spec[4] === "int") {
      try {
        value = py_int(raw);
      } catch {
        throw new ArgumentError(`argument ${action.name}: invalid int value: ${py_repr(raw)}`);
      }
    }
    for (const g of groups) {
      if (!g.dests.includes(action.spec[2])) continue;
      const first = specs.find(
        (sp) => g.dests.includes(sp[2]) && sp[2] !== action.spec[2] && seen_dests.has(sp[2]),
      );
      if (first)
        throw new ArgumentError(`argument ${action.name}: not allowed with argument ${first[0]}`);
    }
    seen.add(action);
    seen_dests.add(action.spec[2]);
    if (action === help_action) {
      process.stdout.write(help);
      process.exit(0);
    }
    const [, kind, dest] = action.spec;
    if (kind === "store_true") ns[dest] = true;
    else if (kind === "append") ns[dest] = [...(ns[dest] ?? []), value];
    else ns[dest] = value;
  };

  // argparse `consume_optional`: returns the index after the option and its argument.
  const consume_optional = (i: number, tuples: OptionTuple[]): number => {
    if (tuples.length > 1) {
      const matches = tuples.map((t) => t[1]).join(", ");
      throw new ArgumentError(`ambiguous option: ${argv[i]} could match ${matches}`);
    }
    let [action, option, sep, explicit] = tuples[0]!;
    const taken: [Action, string | null][] = [];
    for (;;) {
      if (action === null) {
        extras.push(argv[i]!);
        return i + 1;
      }
      const err = (msg: string): ArgumentError =>
        new ArgumentError(`argument ${action!.name}: ${msg}`);
      if (explicit !== null) {
        if (action.nargs === 0 && option[1] !== "-" && explicit !== "") {
          if (sep || explicit[0] === "-")
            throw err(`ignored explicit argument ${py_repr(explicit)}`);
          taken.push([action, null]);
          option = "-" + explicit[0];
          if (!options.has(option)) {
            extras.push("-" + explicit);
            break;
          }
          action = options.get(option)!;
          explicit = explicit.slice(1);
          if (!explicit) sep = explicit = null;
          else if (explicit[0] === "=") [sep, explicit] = ["=", explicit.slice(1)];
          else sep = "";
        } else if (action.nargs === 1) {
          taken.push([action, explicit]);
          break;
        } else throw err(`ignored explicit argument ${py_repr(explicit)}`);
      } else {
        if (action.nargs === 1) {
          const next = argv[i + 1];
          if (next === undefined || parse_optional(next) !== null)
            throw err("expected one argument");
          taken.push([action, next]);
          i++;
        } else taken.push([action, null]);
        break;
      }
    }
    for (const [a, v] of taken) take(a, v);
    return i + 1;
  };

  try {
    let i = 0;
    while (i < argv.length) {
      const tuples = parse_optional(argv[i]!);
      if (tuples !== null) i = consume_optional(i, tuples);
      else {
        const positional = positionals.find((p) => !seen.has(p));
        if (positional) take(positional, argv[i]!);
        else extras.push(argv[i]!);
        i++;
      }
    }
    const missing = required.filter((p) => !seen.has(p)).map((p) => p.name);
    if (missing.length) {
      throw new ArgumentError(`the following arguments are required: ${missing.join(", ")}`);
    }
    for (const g of groups) {
      if (!g.required || g.dests.some((d) => seen_dests.has(d))) continue;
      const names = specs.filter((sp) => g.dests.includes(sp[2])).map((sp) => sp[0]);
      throw new ArgumentError(`one of the arguments ${names.join(" ")} is required`);
    }
  } catch (e) {
    if (e instanceof ArgumentError) fail(e.message);
    throw e;
  }
  if (extras.length) fail(`unrecognized arguments: ${extras.join(" ")}`);
  return ns;
}

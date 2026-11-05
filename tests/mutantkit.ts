#!/usr/bin/env bun
/**
 * Mutation-proof verdicts that refuse the kill a broken mutant manufactures.
 *
 * A pb_hooks mutant that does not PARSE is never loaded: PocketBase prints `failed to
 * execute <file>` and SERVES ANYWAY with that file's hooks absent, so the target assertion
 * fails for a reason that is not the guard under test — and a harness reading only an exit
 * status records that as a kill. A whole run then reports "every site killed, zero
 * survivors" having exercised nothing.
 *
 * verdict() reports killed/survived ONLY when the mutant parses AND a positive control the
 * mutation must not affect stayed green. Either failure raises ProvesNothing, which ends the
 * run instead of contributing a site to a survivor count.
 *
 * Bounds: there is no BASELINE run, so a target already red on the unmutated tree reads as a
 * kill; `node --check` is Node's parser, not goja, so a goja-only syntax would be refused as
 * unparseable; and for a run that boots through roomkit.serve() the parse gate is belt-and-braces,
 * since that boot scan refuses the room too — it is load-bearing only for a harness that does not.
 *
 * Usage (a suite or a by-hand mutation run, one call per site):
 *
 *     import * as mutantkit from "./mutantkit.ts";
 *     await mutantkit.verdict(`${hooks}/scope.pb.js`, run_the_suite, room_answers);
 */

import { basename } from "node:path";
import { py_strip } from "../scripts/_py.ts";

// Raised by verdict() when the run cannot support any killed/survived claim.
export class ProvesNothing extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "ProvesNothing";
  }
}

function _refuse(msg: string): never {
  process.stderr.write(msg + "\n");
  throw new ProvesNothing(msg);
}

// Node's message when `path` is not parseable JavaScript, else null.
//
// Refuses when node is absent rather than letting an unrunnable check read as a clean
// parse — that reading is the exact falsehood this module exists to stop.
export function parse_error(path: string): string | null {
  const node = Bun.which("node", { PATH: process.env.PATH ?? "" });
  if (node === null) {
    _refuse(
      `❌ MUTATION PROVES NOTHING (${basename(path)}): node is not on PATH, so ` +
        `nothing here can show the mutant parses — and an unparseable mutant is never ` +
        `loaded, which makes a failing target the absent hook rather than a kill.`,
    );
  }
  const done = Bun.spawnSync([node, "--check", path], { env: process.env });
  if (done.exitCode === 0) return null;
  return (
    py_strip(done.stderr.toString()) ||
    py_strip(done.stdout.toString()) ||
    `node --check exited ${done.exitCode}`
  );
}

// One mutation site's verdict — "killed" or "survived" — or ProvesNothing.
//
// `target` is the assertion the mutation must break and `control` one it must not; each
// is a zero-arg callable returning true for green, run against the mutated tree. Control
// runs first: a room the mutant broke outright cannot tell a killed site from a dead one,
// so the target is never even spent on it.
export async function verdict(
  mutant: string,
  target: () => boolean | Promise<boolean>,
  control: () => boolean | Promise<boolean>,
  label: string | null = null,
): Promise<"killed" | "survived"> {
  label = label || basename(mutant);
  const broken = parse_error(mutant);
  if (broken) {
    _refuse(
      `❌ MUTATION PROVES NOTHING (${label}): the mutant does not parse, so PocketBase ` +
        `refused the file and served on without its hooks — a failing target here is ` +
        `the absent hook, not the guard under test:\n  ${broken}`,
    );
  }
  if (!(await control())) {
    _refuse(
      `❌ MUTATION PROVES NOTHING (${label}): the positive control, which this mutation ` +
        `must not affect, went RED under it — so nothing here can tell a killed site ` +
        `from a room that stopped working, and this site contributes no verdict.`,
    );
  }
  return (await target()) ? "survived" : "killed";
}

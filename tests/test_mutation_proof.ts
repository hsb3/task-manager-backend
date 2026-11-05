#!/usr/bin/env bun
/**
 * A mutation run can no longer report a kill that the mutant's own breakage manufactured.
 *
 * An unparseable pb_hooks mutant is never loaded — PocketBase prints `failed to execute` and
 * serves on with that file's hooks absent — so the target assertion goes red for a reason
 * that is not the guard under test, and a run reading exit statuses reports "all sites
 * killed, zero survivors" having exercised nothing.
 *
 * §1 pins tests/mutantkit.ts's two refusals (mutant does not parse; positive control went
 * red under it) and the two verdicts it will report. §2 pins the backstop the refusals sit
 * in front of: PB 0.40.4 answers a SYNTAX error with the same `failed to execute` line
 * roomkit.HOOK_LOAD_FAILURE matches, so roomkit.serve() refuses the room — the string was
 * previously verified against a hook that THREW at load, never one that failed to parse.
 *
 * Port 8145 + PB_PORT_OFFSET — the 8100+ suite self-boot band (CLAUDE.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { read_text, run_checked } from "../scripts/_py.ts";
import * as mutantkit from "./mutantkit.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT = 8145 + roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

// Parses as JavaScript, so only node --check's verdict — never the file's shape — decides.
const GOOD_MUTANT = "const x = 1\n";
const BROKEN_MUTANT = "this is not ( valid javascript {{{\n";

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
  if (!ok) FAILS.push(label);
}

// Swallow a refusal's own ❌ line — the battery reads any ❌ in a suite's output as a
// failure, and every refusal this suite provokes on purpose carries one.
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = process.stderr.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

// mutantkit's refusal message, or null when it reported a verdict instead.
//
// A reported verdict must read as null here, never as some other truthy string: the
// whole suite is about a run that reports a verdict it did not earn.
async function refusal(
  mutant: string,
  target: () => boolean,
  control: () => boolean,
): Promise<string | null> {
  let got: string;
  try {
    got = await quiet(() => mutantkit.verdict(mutant, target, control));
  } catch (e) {
    if (e instanceof mutantkit.ProvesNothing) return e.message;
    throw e;
  }
  console.log(`      (no refusal — mutantkit reported '${got}')`);
  return null;
}

const green = () => true;
const red = () => false;

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-mutationproof-"));
try {
  console.log("\n── §1 mutantkit refuses a run that proves nothing ──");
  const good = path.join(S, "good.pb.js");
  const broken = path.join(S, "broken.pb.js");
  fs.writeFileSync(good, GOOD_MUTANT);
  fs.writeFileSync(broken, BROKEN_MUTANT);

  check("a parseable mutant has no parse error", mutantkit.parse_error(good) === null);
  check("an unparseable mutant reports one", (mutantkit.parse_error(broken) || "") !== "");

  let msg = await refusal(broken, red, green);
  check("an unparseable mutant is refused, never reported killed", msg !== null);
  check(
    "the refusal says the run proves nothing",
    msg !== null && msg.includes("PROVES NOTHING") && msg.includes("does not parse"),
  );
  check("the refusal carries node's own parse error", msg !== null && msg.includes("SyntaxError"));

  const spent: string[] = [];

  const counted_target = () => {
    spent.push("target");
    return false;
  };

  msg = await refusal(good, counted_target, red);
  check("a parseable mutant whose positive control went red is refused", msg !== null);
  check(
    "that refusal names the control, not the parse",
    msg !== null && msg.includes("PROVES NOTHING") && msg.includes("positive control"),
  );
  check("the target is never spent on a room the control shows is broken", spent.length === 0);

  check(
    "a parseable mutant whose target goes red is KILLED",
    (await mutantkit.verdict(good, red, green)) === "killed",
  );
  check(
    "a parseable mutant whose target stays green SURVIVED",
    (await mutantkit.verdict(good, green, green)) === "survived",
  );

  // An unrunnable parse check must not read as a clean parse: without node, "it parses"
  // is an assumption, and assuming it is how the false kill gets reported.
  const saved_path = process.env.PATH ?? "";
  try {
    process.env.PATH = path.join(S, "no-node");
    msg = await refusal(good, red, green);
  } finally {
    process.env.PATH = saved_path;
  }
  check("with node off PATH the run is refused, not assumed clean", msg !== null);
  check("that refusal names node", msg !== null && msg.includes("node is not on PATH"));

  console.log("\n── §2 PB 0.40.4 still answers a SYNTAX error with roomkit's detector string ──");
  const mig_dir = path.join(S, "pb_migrations");
  const data_dir = path.join(S, "pb_data");
  const hooks_dir = path.join(S, "pb_hooks");
  fs.mkdirSync(data_dir, { recursive: true });
  fs.cpSync(REAL_MIGRATIONS_DIR, mig_dir, { recursive: true, dereference: true });
  for (const name of fs.readdirSync(mig_dir)) {
    if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(mig_dir, name));
  }
  fs.cpSync(path.join(REPO_ROOT, "pb_hooks"), hooks_dir, { recursive: true, dereference: true });
  const planted = path.join(hooks_dir, "zz_planted_syntax_error.pb.js");
  fs.writeFileSync(planted, BROKEN_MUTANT);
  check("the planted hook really does not parse", mutantkit.parse_error(planted) !== null);

  run_checked([PB_BIN, "superuser", "upsert", SU_EMAIL, SU_PASSWORD, "--dir", data_dir], {
    cwd: REPO_ROOT,
    capture_output: true,
  });
  const log_path = path.join(S, "pb_serve.log");
  let boot: string | null = null;
  try {
    await quiet(async () => {
      const server = await roomkit.serve(PORT, data_dir, mig_dir, hooks_dir, log_path);
      await roomkit.stop(server);
    });
  } catch (e) {
    if (!(e instanceof roomkit.RoomNotHealthy)) throw e;
    boot = e.message;
  }
  check("roomkit.serve() refused the room", boot !== null);
  check(
    "it refused by naming the unloaded hooks",
    boot !== null && boot.includes("HOOKS NOT LOADED"),
  );
  check(
    "the refusal names the file that failed to parse",
    boot !== null && boot.includes(path.basename(planted)),
  );
  const log = read_text(log_path);
  check(
    "PB's own line for a parse failure is what HOOK_LOAD_FAILURE matches",
    log.includes(roomkit.HOOK_LOAD_FAILURE) && log.includes("SyntaxError"),
  );
  // The hazard itself: PB served on. A guard that only watched health would see nothing.
  check("PB served anyway, with the file's hooks absent", log.includes("Server started at"));
} finally {
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} mutation-proof check(s) FAILED`);
  process.exit(1);
}
console.log("✅ a mutation run cannot report a verdict it did not earn");

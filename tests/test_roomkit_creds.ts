#!/usr/bin/env bun
// Self-check of roomkit's own guards — env resolution, foreign-listener refusal, health wait.

import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { py_strip, read_text } from "../scripts/_py.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import { ALLOWED, audit } from "../scripts/check_scratch_copies.ts";
import { pb_bin_path } from "../scripts/pb_migrate.ts";
import * as roomkit from "./roomkit.ts";

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
  if (!ok) {
    FAILS.push(label);
  }
}

/**
 * Runs fn with `env` applied (value null = unset), restoring every key it touched.
 *
 * Every case must name its keys here: the battery EXPORTS PB_BIN/PB_SUPERUSER_* into the
 * suite (run_suite_battery.sh), so an assertion left reading ambient env passes for the
 * wrong reason.
 */
function with_env<T>(env: Record<string, string | null>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v !== null) {
        process.env[k] = v;
      }
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  }
}

function creds_env(email: string | null, password: string | null): Record<string, string | null> {
  return { PB_SUPERUSER_EMAIL: email, PB_SUPERUSER_PASSWORD: password };
}

function expect_exit(email: string | null, password: string | null): string | null {
  try {
    with_env(creds_env(email, password), roomkit.superuser_creds);
    return null;
  } catch (e) {
    if (e instanceof roomkit.SystemExit) {
      return e.message;
    }
    throw e;
  }
}

console.log("── superuser_creds() ──");

let msg = expect_exit(null, null);
check("missing both -> SystemExit", msg !== null);
check("names PB_SUPERUSER_EMAIL", msg !== null && msg.includes("PB_SUPERUSER_EMAIL"));
check("names PB_SUPERUSER_PASSWORD", msg !== null && msg.includes("PB_SUPERUSER_PASSWORD"));

msg = expect_exit("su@example.com", null);
check("missing password only -> SystemExit", msg !== null);
check("names PB_SUPERUSER_PASSWORD", msg !== null && msg.includes("PB_SUPERUSER_PASSWORD"));
check(
  "does not name PB_SUPERUSER_EMAIL as missing",
  msg !== null && !msg.includes("PB_SUPERUSER_EMAIL"),
);

msg = expect_exit("su@example.com", "");
check(
  "empty-string password counts as missing",
  msg !== null && msg.includes("PB_SUPERUSER_PASSWORD"),
);

const result = with_env(creds_env("su@example.com", "hunter2"), roomkit.superuser_creds);
check("both set -> returns exact tuple", Bun.deepEquals(result, ["su@example.com", "hunter2"]));

console.log("── pb_bin() ──");

// Derived here, not imported from roomkit or from scripts/pb_migrate.ts: reading the pin
// through the code under test would agree with it however it drifted.
const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));
const DOCKERFILE = path.join(REPO, "Dockerfile");
const PINNED = /^ARG PB_VERSION=(\S+)$/m.exec(read_text(DOCKERFILE))![1]!;
const ABSENT = "/nonexistent/pb-that-is-not-on-disk/pocketbase";

const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "roomkit-pb-bin-"));
const NO_PB_TREE = fs.mkdtempSync(path.join(os.tmpdir(), "roomkit-no-pb-"));

/**
 * An executable that answers `--version` with `version` and does nothing else — an
 * off-version binary without downloading one.
 */
function stated_version(version: string): string {
  const p = path.join(BIN_DIR, `pocketbase-${version}`);
  fs.writeFileSync(p, `#!/bin/sh\necho "pocketbase version ${version}"\n`, "utf-8");
  fs.chmodSync(p, 0o755);
  return p;
}

function version_of(pb: string): string {
  const r = Bun.spawnSync([pb, "--version"], { env: process.env });
  const m = /\d+\.\d+\.\d+/.exec(r.stdout.toString() + r.stderr.toString());
  return m ? m[0] : "unknown";
}

function is_executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * [refusal message, resolved path] from pb_bin() under `env` — exactly one is null.
 *
 * `repo_root` stands in for roomkit's own, so the no-binary-anywhere branch is reachable on
 * a machine that does have one.
 */
function resolve(
  env: Record<string, string | null>,
  repo_root: string | null = null,
): [string | null, string | null] {
  try {
    return [null, with_env(env, () => roomkit.pb_bin(repo_root ?? undefined))];
  } catch (e) {
    if (e instanceof roomkit.SystemExit) {
      return [e.message, null];
    }
    throw e;
  }
}

check(
  "sentinel path is genuinely absent (so its refusal is about resolution)",
  !fs.existsSync(ABSENT),
);

let got: string | null;
[msg, got] = resolve({ PB_BIN: ABSENT });
check("PB_BIN naming a path that is not there -> refused, never handed back", got === null);
check("…and the refusal names that path", !!msg && msg.includes(ABSENT));

const WRONG = stated_version("0.1.0");
[msg, got] = resolve({ PB_BIN: WRONG });
check("PB_BIN naming an off-version binary -> refused", got === null);
check("…and the refusal names the binary", !!msg && msg.includes(WRONG));
check("…and names the version it found", !!msg && msg.includes("0.1.0"));
check("…and names the version this repo pins", !!msg && msg.includes(PINNED));
check("…and names where that pin lives", !!msg && msg.includes(path.basename(DOCKERFILE)));

const AT_PIN = stated_version(PINNED);
[msg, got] = resolve({ PB_BIN: AT_PIN });
check("PB_BIN naming a binary AT the pin -> returned verbatim", got === AT_PIN);

[msg, got] = resolve({ PB_BIN: null }, NO_PB_TREE);
check("no PB_BIN and no ./pocketbase to fall back on -> refused, not a bare path", got === null);
check("…and the refusal names where it looked", !!msg && msg.includes(NO_PB_TREE));

// The worktree case card zp9x names: ./pocketbase is gitignored, so a linked worktree has none
// and the resolver reaches the main checkout's. Whatever it lands on must be usable.
[msg, got] = resolve({ PB_BIN: "" });
check("PB_BIN empty -> resolved from the tree, never a path that is not there", got !== null);
check("…and what it resolved is executable", !!got && is_executable(got));
check("…and is the pinned version", !!got && version_of(got) === PINNED);

fs.rmSync(BIN_DIR, { recursive: true, force: true });
fs.rmSync(NO_PB_TREE, { recursive: true, force: true });

console.log("── require_free_port() vs a foreign listener ──");

// Drains its accept queue, as every real server does: a holder that only listens has its
// backlog filled by the first probe and reads FREE from the second one on (measured), which
// would make this fixture agree with roomkit for the wrong reason.
const LISTENER =
  'const net = require("node:net");\n' +
  "const [fam, host, v6only] = process.argv.slice(-3);\n" +
  "const s = net.createServer((c) => c.destroy());\n" +
  "s.listen({ host, port: 0, backlog: 128, ipv6Only: fam === '6' && v6only === '1' }, () =>\n" +
  "  console.log(s.address().port),\n" +
  ");\n" +
  "setTimeout(() => process.exit(0), 120000);\n";

async function first_line(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.includes("\n")) break;
  }
  return buf.split("\n")[0]!;
}

/**
 * A LISTENing socket held by ANOTHER process, on an OS-assigned port.
 *
 * OS-assigned rather than a band default + PB_PORT_OFFSET: this suite needs a port a
 * stranger holds, which no band reservation can supply and no offset can relocate.
 */
async function foreign_listener<T>(
  family: string,
  host: string,
  v6only: string,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const proc = Bun.spawn([process.execPath, "-e", LISTENER, family, host, v6only], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const line = py_strip(await first_line(proc.stdout));
    if (!/^\d+$/.test(line)) {
      throw new Error(
        `listener on ${host} never bound: ${py_strip(await new Response(proc.stderr).text())}`,
      );
    }
    return await fn(Number(line));
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

/**
 * Swallows roomkit's operator-facing stderr.
 *
 * Every refusal below is provoked on purpose, and the battery reds a suite on a bare ❌
 * glyph in its output (run_suite_battery.sh suite_is_red) even when it exits 0.
 */
async function muted<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = write;
  }
}

/** The refusal message for `port`, or null when the preflight lets the boot through. */
async function refusal(port: number): Promise<string | null> {
  try {
    // Short window deliberately: the default is a settling budget, not part of the check.
    await muted(() => roomkit.require_free_port(port, 0.5));
    return null;
  } catch (e) {
    if (e instanceof roomkit.PortInUse) {
      return e.message;
    }
    throw e;
  }
}

for (const [label, family, host, v6only] of [
  ["IPv4 wildcard 0.0.0.0", "4", "0.0.0.0", "0"],
  ["IPv4 loopback 127.0.0.1", "4", "127.0.0.1", "0"],
  ["IPv6 dual-stack ::", "6", "::", "0"],
] as const) {
  const held = await foreign_listener(family, host, v6only, async (held) => {
    const msg = await refusal(held);
    check(`${label} holder -> PortInUse`, msg !== null);
    check(`${label} refusal names the port`, msg !== null && msg.includes(String(held)));
    check(
      `${label} refusal names the escape hatch`,
      msg !== null && msg.includes("PB_PORT_OFFSET"),
    );
    return held;
  });
  check(`${label} released -> the port reads free again`, (await refusal(held)) === null);
}

// The negative space of the comment at roomkit.port_is_free: an IPv6-only holder can neither
// answer a 127.0.0.1 health poll nor block our bind, so probing for it would refuse a usable
// port. This goes red the moment someone adds a two-host PROBE_HOSTS list.
for (const [label, host] of [
  ["::1", "::1"],
  [":: v6only", "::"],
] as const) {
  await foreign_listener("6", host, "1", async (held) => {
    check(
      `IPv6-only ${label} holder -> port still reads free (unadoptable)`,
      (await refusal(held)) === null,
    );
  });
}

console.log("── wait_for_health() vs a dead child ──");

async function health_failure(
  base_url: string,
  proc: roomkit.Proc,
  timeout: number,
): Promise<string | null> {
  try {
    await muted(() => roomkit.wait_for_health(base_url, proc, timeout));
    return null;
  } catch (e) {
    if (e instanceof roomkit.RoomNotHealthy) {
      return e.message;
    }
    throw e;
  }
}

// Port 1 is never a room: nothing this suite starts listens, so the poll can only fail.
const NO_ROOM = "http://127.0.0.1:1";

const dead = Bun.spawn([process.execPath, "-e", "process.exit(3)"], { env: process.env });
await dead.exited;
const t0 = performance.now();
msg = await health_failure(NO_ROOM, dead, 10);
const elapsed = (performance.now() - t0) / 1000;

check("dead child -> RoomNotHealthy", msg !== null);
check("names the death, not a timeout", msg !== null && msg.includes("ROOM DIED"));
check("names the child by pid", msg !== null && msg.includes(String(dead.pid)));
check("names its exit status", msg !== null && msg.includes("status 3"));
check(`fails at once, not after the whole window (${elapsed.toFixed(1)}s < 2s)`, elapsed < 2);

const SLEEPER = "setTimeout(() => {}, 120000)";

let alive: Subprocess = Bun.spawn([process.execPath, "-e", SLEEPER], { env: process.env });
try {
  msg = await health_failure(NO_ROOM, alive, 1);
  check("live child, no health answer -> RoomNotHealthy", msg !== null);
  check("names the timeout, not a death", msg !== null && msg.includes("ROOM NEVER HEALTHY"));
  check("names the url it polled", msg !== null && msg.includes(NO_ROOM));
  check("reports the last connection error", msg !== null && msg.includes("last:"));
} finally {
  alive.kill("SIGKILL");
  await alive.exited;
}

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    return new Response(null, { status: url.pathname + url.search === "/api/health" ? 200 : 404 });
  },
});
const STUB_URL = `http://127.0.0.1:${stub.port}`;

// Binds the port the stub already holds, so the EADDRINUSE kills it with status 1.
const BIND_LOSER =
  'const s = require("node:net").createServer();\n' +
  "s.on('error', () => process.exit(1));\n" +
  "s.listen(Number(process.argv.at(-1)), '127.0.0.1', () => process.exit(0));\n";

try {
  alive = Bun.spawn([process.execPath, "-e", SLEEPER], { env: process.env });
  try {
    check(
      "live child + /api/health 200 -> returns True",
      await roomkit.wait_for_health(STUB_URL, alive, 5),
    );
  } finally {
    alive.kill("SIGKILL");
    await alive.exited;
  }

  // The silent-green scenario end to end: a stranger holds the port AND answers 200 there,
  // so our room dies on the bind and only the liveness watch stops the run adopting it.
  const loser = Bun.spawn([process.execPath, "-e", BIND_LOSER, String(stub.port)], {
    env: process.env,
    stderr: "ignore",
  });
  await loser.exited;
  check("our room really lost the bind race", loser.exitCode === 1);
  msg = await health_failure(STUB_URL, loser, 10);
  check("a stranger's 200 does not rescue a dead child", msg !== null && msg.includes("ROOM DIED"));
  check("names that child's exit status", msg !== null && msg.includes("status 1"));
} finally {
  stub.stop(true);
}

console.log("── hooks_dir() refuses a symlinked entry ──");
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "rk-hooks-"));
  const src = path.join(fx, "src");
  fs.mkdirSync(path.join(src, "lib"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.pb.js"), "//a\n");
  fs.symlinkSync(path.join(fx, "elsewhere"), path.join(src, "lib", "link.js"));
  let msg = "";
  try {
    with_env({ PB_HOOKS_DIR: null }, () => roomkit.hooks_dir(path.join(fx, "room"), src));
  } catch (e) {
    msg = String(e);
  }
  check("a symlink under lib/ throws naming lib/link.js", msg.includes("lib/link.js"));
  check("nothing was copied", !fs.existsSync(path.join(fx, "room", "pb_hooks")));
  fs.rmSync(path.join(src, "lib", "link.js"));
  const dest = with_env({ PB_HOOKS_DIR: null }, () =>
    roomkit.hooks_dir(path.join(fx, "room"), src),
  );
  const root_link = path.join(fx, "rootlink");
  fs.symlinkSync(src, root_link);
  msg = "";
  try {
    with_env({ PB_HOOKS_DIR: null }, () => roomkit.hooks_dir(path.join(fx, "room2"), root_link));
  } catch (e) {
    msg = String(e);
  }
  check(
    "a symlinked SOURCE root is refused too",
    msg.includes("symlink") && msg.includes("rootlink"),
  );
  check("a symlink-free tree copies", fs.existsSync(path.join(dest, "a.pb.js")));
  fs.rmSync(fx, { recursive: true, force: true });
}

console.log("── every scratch copy of pb_migrations/ or pb_hooks/ refuses an inner symlink ──");
{
  // The sites read fixed repo paths, so each runs from a fixture root whose trees carry a planted link.
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "rk-copysites-"));
  const root = path.join(fx, "repo");
  const outside = path.join(fx, "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  for (const rel of [
    "Dockerfile",
    "scripts/_argparse.ts",
    "scripts/_py.ts",
    "scripts/_repo_root.ts",
    "scripts/_scratch_copy.ts",
    "scripts/check_app_docs_down_up.ts",
    "scripts/check_app_docs_history.ts",
    "scripts/gen_openapi.ts",
    "scripts/gen_schema.ts",
    "scripts/load_smoketest.ts",
    "scripts/pb_migrate.ts",
    "scripts/view_field_help.ts",
    "tests/roomkit.ts",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  const MIG_LINK = "zz_mig_link.txt";
  const HOOK_LINK = "zz_hook_link.txt";
  copy_tree(path.join(REPO, "pb_migrations"), path.join(root, "pb_migrations"));
  copy_tree(path.join(REPO, "pb_hooks"), path.join(root, "pb_hooks"));
  fs.symlinkSync(outside, path.join(root, "pb_migrations", MIG_LINK));
  fs.symlinkSync(outside, path.join(root, "pb_hooks", HOOK_LINK));
  fs.mkdirSync(path.join(fx, "empty_mig"));

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.PB_BIN = pb_bin_path(REPO);
  delete env.PB_HOOKS_DIR; // the battery exports it, and a set one skips the pb_hooks copy under test
  const lib = (rel: string): string => JSON.stringify(path.join(root, rel));
  const sites: [string, string[], string][] = [
    ["gen_openapi.ts", ["scripts/gen_openapi.ts", "--check"], MIG_LINK],
    ["gen_schema.ts", ["scripts/gen_schema.ts", "--check"], MIG_LINK],
    ["check_app_docs_down_up.ts", ["scripts/check_app_docs_down_up.ts"], MIG_LINK],
    ["load_smoketest.ts", ["scripts/load_smoketest.ts"], MIG_LINK],
    [
      "pb_migrate.ts migrate_up (its pb_hooks copy)",
      [
        "-e",
        `import { migrate_up } from ${lib("scripts/pb_migrate.ts")};\n` +
          `migrate_up(process.env.PB_BIN, ${JSON.stringify(path.join(fx, "data"))}, ` +
          `${JSON.stringify(path.join(fx, "empty_mig"))});`,
      ],
      HOOK_LINK,
    ],
    [
      "roomkit.ts hooks_dir",
      [
        "-e",
        `import { hooks_dir } from ${lib("tests/roomkit.ts")};\n` +
          `hooks_dir(${JSON.stringify(path.join(fx, "room"))});`,
      ],
      HOOK_LINK,
    ],
  ];
  for (const [label, argv, link] of sites) {
    // A site that does not refuse runs on (load_smoketest boots a room), so the clock is the verdict.
    const r = Bun.spawnSync([process.execPath, ...argv], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const out = r.stdout.toString() + r.stderr.toString();
    const refused = r.exitCode !== 0 && out.includes(link) && out.includes("symlink");
    check(`${label} refuses ${link} inside its source`, refused);
    if (!refused)
      console.log(`        exit ${r.exitCode}: ${out.trim().split("\n").slice(-3).join(" | ")}`);
  }
  let msg = "";
  try {
    copy_tree(path.join(root, "pb_migrations"), path.join(fx, "direct"));
  } catch (e) {
    msg = String(e);
  }
  check(
    "copy_tree itself refuses, naming the entry",
    msg.includes(MIG_LINK) && msg.includes("symlink"),
  );
  check("copy_tree copied nothing", !fs.existsSync(path.join(fx, "direct")));
  check("the link target was never written", read_text(outside) === "outside\n");
  fs.rmSync(fx, { recursive: true, force: true });
}

console.log("── check_scratch_copies refuses a raw tree copy outside copy_tree ──");
{
  check("the real tree is clean", audit(REPO).length === 0);
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "rk-copygate-"));
  const plant = (rel: string, text: string): string[] => {
    fs.mkdirSync(path.dirname(path.join(fx, rel)), { recursive: true });
    fs.writeFileSync(path.join(fx, rel), text);
    const found = audit(fx);
    fs.rmSync(path.join(fx, rel));
    return found;
  };
  const CP_SYNC = ["cp", "Sync"].join(""); // spelled apart so this file stays clean under the gate
  let found = plant("tests/test_x.ts", `fs.${CP_SYNC}(MIGS, dir, { recursive: true });\n`);
  check(
    "a raw recursive copy in tests/ is refused",
    found.length === 1 && found[0]!.startsWith("tests/test_x.ts:1:"),
  );
  found = plant(
    "scripts/x.ts",
    `\n${CP_SYNC}(HOOKS, dir, { recursive: true, dereference: true });\n`,
  );
  check(
    "a raw copy in scripts/ is refused at its line",
    found.length === 1 && found[0]!.startsWith("scripts/x.ts:2:"),
  );
  found = plant("scripts/x.sh", `cp -R pb_migrations "$S/mig"\n`);
  check("a shell `cp -R pb_migrations` is refused", found.length === 1);
  found = plant("Makefile", `x:\n\t@cp -a pb_hooks "$$S/hooks"\n`);
  check("a Makefile `cp -a` is refused", found.length === 1);
  found = plant("scripts/x.sh", `# cp -R in a comment\ncp a.txt b.txt\n`);
  check("a comment and a single-file cp pass", found.length === 0);
  const battery = [...ALLOWED["scripts/run_suite_battery.sh"]!].map((l) => `  ${l}\n`).join("");
  found = plant("scripts/run_suite_battery.sh", battery + `cp -R "$REPO_ROOT/pb_hooks" "$X"\n`);
  check(
    "the battery's guarded copies pass and a new one there is refused",
    found.length === 1 && found[0]!.includes("$X"),
  );
  found = plant("scripts/run_suite_battery.sh", battery + battery.split("\n")[0] + "\n");
  check("an allowlisted battery line passes once; its duplicate is refused", found.length === 1);
  const CALL = "cp" + "("; // spelled apart, as CP_SYNC is
  found = plant(
    "tests/x.ts",
    `await fs.promises.${CALL}a, b);\nfsp.${CALL}a, b);\n${CALL}a, b);\n`,
  );
  check("the promises, fsp and bare node:fs copy calls are refused", found.length === 3);
  found = plant("scripts/x.sh", `/bin/cp -R pb_hooks "$S"\ncp --recursive pb_hooks "$S"\n`);
  check("`/bin/cp -R` and `cp --recursive` are refused", found.length === 2);
  found = plant("scripts/_scratch_copy.ts", `fs.${CP_SYNC}(src, dest, { recursive: true });\n`);
  check("the helper itself is exempt", found.length === 0);
  fs.rmSync(fx, { recursive: true, force: true });
}

process.exit(FAILS.length ? 1 : 0);

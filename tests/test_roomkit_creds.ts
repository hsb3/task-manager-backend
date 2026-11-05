#!/usr/bin/env bun
// Self-check of roomkit's own guards — env resolution, foreign-listener refusal, health wait.

import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { py_strip, read_text } from "../scripts/_py.ts";
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
// port. This goes red the moment someone copies web/e2e's PROBE_HOSTS list in.
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

process.exit(FAILS.length ? 1 : 0);

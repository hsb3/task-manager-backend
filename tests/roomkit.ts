#!/usr/bin/env bun
/**
 * Shared clean-room guards: never boot onto a stranger's port, never adopt a stranger's server.
 *
 * Usage (bash callers, e.g. scripts/run_suite_battery.sh's start_room):
 *     bun tests/roomkit.ts <port>                      # pre-boot:  0 free, 1 occupied, 2 usage
 *     bun tests/roomkit.ts --verify-room <port> <pid>  # post-boot: 0 ours, 1 stranger, 2 usage
 */

import type { Subprocess } from "bun";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  by_code_point,
  install_system_exit_handler,
  os_error_text,
  py_int,
  py_repr,
  py_str,
  py_strip,
  read_text,
  splitlines,
  SystemExit,
  py_get,
} from "../scripts/_py.ts";
import { pb_bin_path } from "../scripts/pb_migrate.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

export { py_int, SystemExit };

// A room we just stopped can hold its port for a moment, so the check polls before it
// refuses; a stranger's server stays up for the whole window, so the guard still fires.
export const PREFLIGHT_TIMEOUT = 12;

// A hooksDir edit makes PocketBase re-exec in place (TASK-034) keeping its pid; the socket is
// gone for ~50ms, but the OS can fail to ATTRIBUTE the re-bound one for up to ~1.1s after —
// measured. So an unattributable port is retried far past that, never read as a hijack.
export const REBIND_GRACE = 5;

// 10x the slowest cold boot measured across the suites (1.79s, worst of 40 full migration
// replays, four of them rooms replaying concurrently), rounded up to the next 5s. Re-measure
// to re-derive; a boot on slower hardware is what this headroom is for.
export const HEALTH_TIMEOUT = 20;

export const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));

export type Proc = Subprocess | number | string;

export type Room = Subprocess & {
  roomkit_log: string;
  roomkit_hooks: string | null;
  roomkit_port: number;
  roomkit_logfile: number;
};

install_system_exit_handler();

const _now = (): number => Date.now() / 1000;
const _sleep = (seconds: number): Promise<void> => Bun.sleep(seconds * 1000);

class HTTPError extends Error {
  code: number;
  reason: string;
  constructor(code: number, reason: string) {
    super(`HTTP Error ${code}: ${reason}`);
    this.name = "HTTPError";
    this.code = code;
    this.reason = reason;
  }
}

function _py_int_or_null(s: string): number | null {
  try {
    return py_int(s);
  } catch {
    return null;
  }
}

function _py_float(s: string): number | null {
  const t = py_strip(s);
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (special) {
    if (special[2]!.toLowerCase() === "nan") return NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  const digits = String.raw`\d+(?:_\d+)*`;
  const num = new RegExp(
    String.raw`^[+-]?(?:${digits}(?:\.(?:${digits})?)?|\.${digits})(?:[eE][+-]?${digits})?$`,
  );
  return num.test(t) ? Number(t.replace(/_/g, "")) : null;
}

const _is_executable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The pocketbase binary a room boots with, resolved by the repo's ONE resolver:
 * $PB_BIN, else this tree's own, else the main checkout's — every branch refused unless
 * the binary IS the version the Dockerfile's ARG PB_VERSION pins.
 *
 * Raises where pb_bin_path returns its explain-why sentinel path: its script callers each
 * print their own refusal, but a room spawns this value, and a bogus path there dies with
 * a bare ENOENT that names neither the binary nor the pin.
 */
export function pb_bin(repo_root: string = REPO_ROOT): string {
  const pb = pb_bin_path(repo_root);
  if ((fs.statSync(pb, { throwIfNoEntry: false })?.isFile() ?? false) && _is_executable(pb)) {
    return pb;
  }
  throw new SystemExit(
    `❌ NO USABLE POCKETBASE BINARY: ${pb} — a room booted on it would replay this ` +
      `repo's migrations against a server this repo cannot vouch for.`,
  );
}

/**
 * The hooksDir a room should boot with: $PB_HOOKS_DIR when set (the battery's one
 * shared copy, or a baseline tree for a deliberate red run), else a fresh copy of the
 * repo's pb_hooks/ inside `scratch`.
 *
 * Never the repo dir itself: PB watches its hooksDir and macOS FSEvents can re-deliver
 * an unrelated edit to it as a restart mid-run (TASK-034/TASK-136).
 */
export function hooks_dir(scratch: string, src: string = path.join(REPO_ROOT, "pb_hooks")): string {
  const shared = process.env.PB_HOOKS_DIR;
  if (shared) {
    return shared;
  }
  return copy_tree(src, path.join(scratch, "pb_hooks"));
}

/** Raised by require_free_port() when the port stays occupied for the whole window. */
export class PortInUse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortInUse";
  }
}

/**
 * Raised by require_own_room() when the server answering on our port cannot be shown
 * to be the child process we launched.
 */
export class RoomNotOurs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomNotOurs";
  }
}

/** Raised by wait_for_health() when the room dies during boot, or never answers 200. */
export class RoomNotHealthy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomNotHealthy";
  }
}

function _relocate_hint(port: number): string {
  const offset = process.env.PB_PORT_OFFSET ?? "0";
  return (
    `Stop whatever holds port ${port}, or relocate this whole run with ` +
    `PB_PORT_OFFSET (plain decimal, 100 or more; currently ${offset}).`
  );
}

function _refuse(msg: string, error: new (msg: string) => Error = RoomNotOurs): never {
  process.stderr.write(msg + "\n");
  throw new error(msg);
}

// ── Pre-boot: is the port free at all? ────────────────────────────────────────

export function port_is_free(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  // connect-and-refuse, never bind-and-release: a bind check false-positives on TIME_WAIT.
  // One host is enough BECAUSE it is a connect: measured, every holder that can answer a
  // room's health poll on 127.0.0.1 (0.0.0.0, 127.0.0.1, dual-stack ::) accepts a connection
  // there, and an IPv6-only holder can neither answer it nor block our bind. a two-host
  // PROBE_HOSTS list is an artifact of BIND-probing; copied here it would refuse usable
  // ports — tests/test_roomkit_creds.ts pins both halves.
  // Only an explicit refusal proves nothing listens: a timeout means a stranger holding the
  // port with a saturated accept backlog is dropping our SYN, which must not read as free.
  return new Promise((resolve) => {
    const s = net.connect({ host, port, family: 4 });
    const done = (free: boolean, connected = false): void => {
      clearTimeout(timer);
      if (connected) s.end().unref();
      else s.destroy();
      resolve(free);
    };
    const timer = setTimeout(() => done(false), 500);
    s.once("connect", () => done(false, true));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED"));
  });
}

export async function wait_for_port_free(
  port: number,
  timeout: number = PREFLIGHT_TIMEOUT,
  host: string = "127.0.0.1",
): Promise<boolean> {
  const deadline = _now() + timeout;
  while (true) {
    if (await port_is_free(port, host)) {
      return true;
    }
    if (_now() >= deadline) {
      return false;
    }
    await _sleep(0.2);
  }
}

export async function require_free_port(
  port: number,
  timeout: number = PREFLIGHT_TIMEOUT,
  host: string = "127.0.0.1",
): Promise<void> {
  if (await wait_for_port_free(port, timeout, host)) {
    return;
  }
  _refuse(
    `❌ PORT COLLISION: ${host}:${port} is already served by another process after ` +
      `${timeout}s — refusing to boot, because a blind bind would seed and assert ` +
      `against that stranger's database and pass green. ` +
      _relocate_hint(port),
    PortInUse,
  );
}

// ── Post-boot: which process actually holds the listening socket? ─────────────

/** Socket inodes LISTENing on `port`, per Linux /proc/net/tcp{,6}. */
function _proc_listen_inodes(port: number): Set<string> {
  const inodes = new Set<string>();
  for (const family of ["tcp", "tcp6"]) {
    let rows: string[];
    try {
      rows = read_text(`/proc/net/${family}`).split("\n").slice(1);
    } catch {
      continue;
    }
    for (const row of rows) {
      const f = row.split(/\s+/).filter(Boolean);
      // Columns: … 1 local_address "HEXADDR:HEXPORT", 3 st (0A = LISTEN), 9 inode.
      if (
        f.length > 9 &&
        f[3] === "0A" &&
        parseInt(f[1]!.slice(f[1]!.lastIndexOf(":") + 1), 16) === port
      ) {
        inodes.add(f[9]!);
      }
    }
  }
  return inodes;
}

/** Pids with one of `inodes` open, per /proc/<pid>/fd. */
function _proc_pids_holding(inodes: Set<string>): Set<number> {
  const want = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  const pids = new Set<number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const fd_dir = `/proc/${entry}/fd`;
    let fds: string[];
    try {
      fds = fs.readdirSync(fd_dir);
    } catch {
      continue; // another user's process, or one that just exited — never ours either way
    }
    for (const fd of fds) {
      try {
        if (want.has(fs.readlinkSync(path.join(fd_dir, fd)))) {
          pids.add(Number(entry));
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return pids;
}

/** Pids LISTENing on `port` per lsof, or null when lsof is not on PATH. */
function _lsof_pids_listening(port: number): Set<number> | null {
  const lsof = Bun.which("lsof", { PATH: process.env.PATH ?? "" });
  if (lsof === null) {
    return null;
  }
  // lsof exits 1 on "nothing matched", so the pid list is read, never the status.
  const out = Bun.spawnSync([lsof, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    env: process.env,
  });
  return new Set(
    out.stdout
      .toString()
      .split(/\s+/)
      .filter((line) => /^\d+$/.test(line))
      .map(Number),
  );
}

/**
 * Pids holding the LISTEN socket on `port`, asked of the OS.
 *
 * Raises RoomNotOurs when neither mechanism exists here: an unverifiable room is
 * refused, never assumed ours.
 */
export function listening_pids(port: number): Set<number> {
  if (fs.existsSync("/proc/net/tcp")) {
    return _proc_pids_holding(_proc_listen_inodes(port));
  }
  const pids = _lsof_pids_listening(port);
  if (pids === null) {
    _refuse(
      `❌ ROOM UNVERIFIABLE: this OS cannot be asked which process holds port ` +
        `${port} — no /proc/net/tcp and no lsof on PATH — so refusing to continue ` +
        `rather than assume the server answering there is the room we launched. ` +
        `Put lsof on PATH (macOS ships it in /usr/sbin), or run where /proc is ` +
        `mounted.`,
    );
  }
  return pids;
}

/** True for the in-process child we launched, False for a bare pid handed over from bash. */
function _is_our_popen(proc: Proc): proc is Subprocess {
  return typeof proc === "object" && proc !== null && "exitCode" in proc;
}

const _alive = (proc: Subprocess): boolean => proc.exitCode === null && proc.signalCode === null;

const _returncode = (proc: Subprocess): number | null => {
  const sig = proc.signalCode;
  if (sig === null) return proc.exitCode;
  return -(typeof sig === "number" ? sig : os.constants.signals[sig]);
};

function _pid_and_liveness(proc: Proc): [number, boolean] {
  if (_is_our_popen(proc)) {
    return [proc.pid, _alive(proc)];
  }
  const pid =
    typeof proc === "number"
      ? Number.isFinite(proc)
        ? Math.trunc(proc)
        : null
      : typeof proc === "string"
        ? _py_int_or_null(proc)
        : null;
  if (pid === null) {
    _refuse(
      `❌ NO ROOM HANDED OVER: this guard was given ${py_repr(proc)} instead of the room's ` +
        `Popen or its pid, so it cannot tell a live room from a corpse — the caller ` +
        `has to pass the process it launched (roomkit.serve() returns it).`,
    );
  }
  try {
    // A bash-owned child can linger unreaped, so this is a hint; the socket owner decides.
    process.kill(pid, 0);
  } catch {
    return [pid, false];
  }
  return [pid, true];
}

/**
 * Stop the room we launched — never a bare pid: a verifier must not kill a process it
 * does not own, and the shell that spawned one runs its own cleanup.
 */
async function _stop_child(proc: Proc): Promise<void> {
  if (!_is_our_popen(proc) || !_alive(proc)) {
    return;
  }
  proc.kill("SIGTERM");
  let timer: Timer | undefined;
  const timed_out = await Promise.race([
    proc.exited.then(() => false),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), 10_000))),
  ]);
  clearTimeout(timer);
  if (timed_out) {
    proc.kill("SIGKILL");
  }
}

/** Holder pids, polled until non-empty: an unattributable port is a rebind, never a hijack. */
async function _settled_holders(port: number, grace: number = REBIND_GRACE): Promise<Set<number>> {
  const deadline = _now() + grace;
  while (true) {
    const holders = listening_pids(port);
    if (holders.size || _now() >= deadline) {
      return holders;
    }
    await _sleep(0.05);
  }
}

/** Post-boot guard: refuse `port` unless the process LISTENing on it is `proc` itself. */
export async function require_own_room(
  port: number,
  proc: Proc,
  host: string = "127.0.0.1",
): Promise<void> {
  const [pid, alive] = _pid_and_liveness(proc);
  if (!alive) {
    const died =
      `❌ ROOM DIED: the room we launched for ${host}:${port} (pid ${pid}) exited ` +
      `during boot, and `;
    if (await port_is_free(port, host)) {
      _refuse(
        died +
          "nothing accepts a connection there now either — refusing to " +
          "continue, because this run has no room to write to.",
      );
    }
    _refuse(
      died +
        "something else is accepting connections on that port — refusing to " +
        "continue, because seeding and asserting against that stranger's " +
        "database would pass green. " +
        _relocate_hint(port),
    );
  }
  try {
    const holders = await _settled_holders(port);
    if (holders.size === 1 && holders.has(pid)) {
      return;
    }
    if (!holders.size) {
      _refuse(
        `❌ ROOM UNCLAIMED: the room we launched (pid ${pid}) is still alive, but ` +
          `for ${REBIND_GRACE}s this OS would not attribute ${host}:${port} to any ` +
          `process we can see — refusing to continue, because we cannot show the ` +
          `server this run is about to write to is ours. Re-run; if it repeats, ` +
          `the room is not staying bound, or that port belongs to another user.`,
      );
    }
    const found = [...holders].sort((a, b) => a - b).join(", ");
    _refuse(
      `❌ ROOM HIJACKED: the listening socket on ${host}:${port} belongs to pid(s) ` +
        `${found} — not the room we launched (pid ${pid}) — refusing to continue, ` +
        `because seeding and asserting against that stranger's database would pass ` +
        `green. ` +
        _relocate_hint(port),
    );
  } catch (e) {
    if (e instanceof RoomNotOurs) {
      // A half-booted child left alive here becomes the stranger that poisons the NEXT run.
      await _stop_child(proc);
    }
    throw e;
  }
}

// ── Boot: wait for the room, and never for a corpse ──────────────────────────

function _exit_note(proc: Proc): string {
  if (!_is_our_popen(proc)) {
    return "(exit status unknown — a bare pid, not a child of this process)";
  }
  return `with status ${py_str(_returncode(proc))}`;
}

function _require_room_alive(base_url: string, proc: Proc): void {
  const [pid, alive] = _pid_and_liveness(proc);
  if (alive) {
    return;
  }
  _refuse(
    `❌ ROOM DIED: the room we launched for ${base_url} (pid ${pid}) exited ` +
      `${_exit_note(proc)} before /api/health ever answered — refusing to continue, ` +
      `because this run has no room to write to. The boot error is on that process's ` +
      `stdout/stderr.`,
    RoomNotHealthy,
  );
}

/**
 * Poll `base_url`/api/health until it answers 200, refusing the moment `proc` dies.
 *
 * `proc` (the room's Subprocess, or its pid) is required, not optional: to a poll a dead child
 * is indistinguishable from "not up yet", so a boot failure without it spends the whole
 * window and then reports a timeout instead of the exit status that explains it.
 */
export async function wait_for_health(
  base_url: string,
  proc: Proc,
  timeout: number = HEALTH_TIMEOUT,
): Promise<true> {
  const deadline = _now() + timeout;
  let last_err: unknown = null;
  while (true) {
    _require_room_alive(base_url, proc);
    try {
      const r = await fetch(base_url + "/api/health", { signal: AbortSignal.timeout(2000) });
      await r.body?.cancel();
      if (r.status === 200) {
        return true;
      }
      if (r.status < 200 || r.status >= 300) {
        last_err = new HTTPError(r.status, r.statusText);
      }
    } catch (e) {
      // until the deadline every failure is "not up yet"
      last_err = e;
    }
    if (_now() >= deadline) {
      break;
    }
    await _sleep(0.3);
  }
  _refuse(
    `❌ ROOM NEVER HEALTHY: the room we launched for ${base_url} is still alive, but ` +
      `/api/health did not answer 200 within ${timeout}s (last: ${py_str(last_err)}) — refusing ` +
      `to continue, because a suite asserting against a half-booted room reports schema ` +
      `failures instead of the boot it is actually missing.`,
    RoomNotHealthy,
  );
}

// ── Boot a room: one spawn site, so its output is read instead of deadlocking ─

// PocketBase prints this and SERVES ANYWAY, with that file's hooks silently absent.
export const HOOK_LOAD_FAILURE = "failed to execute";

export const BOOT_LOG_TAIL = 40;

function _os_str(e: unknown): string {
  try {
    return os_error_text(e);
  } catch {
    return py_str(e);
  }
}

function _boot_log_tail(log_path: string, lines: number = BOOT_LOG_TAIL): string {
  try {
    const text = read_text(log_path, "replace");
    return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).slice(-lines).join("");
  } catch (e) {
    return `(boot log ${log_path} unreadable: ${_os_str(e)})`;
  }
}

/**
 * Refuse a room that booted with a hook file missing from the JSVM.
 *
 * A hook file that throws at load leaves the server healthy and answering, so every
 * assertion the absent hook would have made passes green.
 */
export function require_hooks_loaded(log_path: string, hooks: string | null): void {
  let text: string;
  try {
    text = read_text(log_path, "replace");
  } catch (e) {
    // An unreadable log carries no evidence either way, so it must not read as clean.
    _refuse(
      `❌ HOOK LOAD UNVERIFIABLE: the room's boot log ${log_path} could not be read ` +
        `(${_os_str(e)}), so nothing here can show its hook files loaded — refusing rather than ` +
        `treating an absent log as a clean one.`,
      RoomNotHealthy,
    );
  }
  const bad = [
    ...new Set(
      splitlines(text)
        .filter((line) => line.includes(HOOK_LOAD_FAILURE))
        .map((line) => py_strip(line)),
    ),
  ].sort(by_code_point);
  if (!bad.length) {
    return;
  }
  const detail = bad.join("\n  ");
  _refuse(
    `❌ HOOKS NOT LOADED: PocketBase refused a hook file in ${hooks || "the default hooksDir"} and served ` +
      `anyway, so every rule that file enforces is silently absent and this run would ` +
      `pass green without it:\n  ${detail}`,
    RoomNotHealthy,
  );
}

function _py_dirname(p: string): string {
  const head = p.slice(0, p.lastIndexOf("/") + 1);
  return /^\/*$/.test(head) ? head : head.replace(/\/+$/, "");
}

/**
 * Boot a room on `port` and return its Subprocess once it is healthy, ours, and complete.
 *
 * `hooks=null` leaves --hooksDir off, for a caller that deliberately boots hookless.
 * Output goes to a FILE, never a pipe: an undrained pipe fills and blocks the child
 * forever, and a blocked child is ALIVE, so the dead-child watch cannot rescue it.
 */
export async function serve(
  port: number,
  data_dir: string,
  migrations_dir: string,
  hooks: string | null = null,
  log_path: string | null = null,
  extra: string[] = [],
  timeout: number = HEALTH_TIMEOUT,
): Promise<Room> {
  const log_file = log_path || path.join(_py_dirname(data_dir) || ".", "pb_serve.log");
  const base_url = `http://127.0.0.1:${port}`;
  await require_free_port(port);
  const log = fs.openSync(log_file, "w"); // stop() closes it; the room outlives this call
  let proc: Room;
  try {
    const child = Bun.spawn(
      [
        pb_bin(),
        "serve",
        `--http=127.0.0.1:${port}`,
        "--dir",
        data_dir,
        "--migrationsDir",
        migrations_dir,
        ...(hooks ? ["--hooksDir", hooks] : []),
        ...extra,
      ],
      {
        // appURL (mail.pb.js) defaults to :8090 otherwise, wrong for a shifted room.
        env: { ...process.env, PB_PUBLIC_URL: process.env.PB_PUBLIC_URL || base_url },
        cwd: REPO_ROOT,
        stdout: log,
        stderr: log,
      },
    );
    proc = Object.assign(child, {
      roomkit_log: log_file,
      roomkit_hooks: hooks,
      roomkit_port: port,
      roomkit_logfile: log,
    });
  } catch (e) {
    fs.closeSync(log);
    throw e;
  }
  try {
    await wait_for_health(base_url, proc, timeout);
    await require_own_room(port, proc);
    require_hooks_loaded(log_file, hooks);
  } catch (e) {
    process.stderr.write(`── boot log ${log_file} ──\n${_boot_log_tail(log_file)}\n`);
    await _stop_child(proc);
    fs.closeSync(log);
    throw e;
  }
  return proc;
}

/**
 * Stop a serve() room, refusing if a hook file failed to load WHILE it ran.
 *
 * PB re-execs on any hooksDir change and serves on with the broken file absent, so a room
 * that booted complete can lose a hook mid-run and keep answering 200 — the boot scan
 * alone cannot see that, and it is the ONLY cover the onBootstrap-only hooks have.
 */
export async function stop(proc: Room): Promise<void> {
  try {
    require_hooks_loaded(proc.roomkit_log, proc.roomkit_hooks);
  } finally {
    await _stop_child(proc);
    if (proc.roomkit_logfile >= 0) {
      fs.closeSync(proc.roomkit_logfile);
      proc.roomkit_logfile = -1;
    }
    if (!(await wait_for_port_free(proc.roomkit_port))) {
      process.stderr.write(
        `  ⚠️  port ${proc.roomkit_port} still occupied after stopping the room\n`,
      );
    }
  }
}

// ── Realtime: the one SSE reader every stream-watching suite subscribes with ──

// No read deadline: PB sends nothing at all on an idle stream (measured — a 60s read timeout
// fires at t+60 of quiet), and a read that expires kills the reader mid-suite. Nothing
// hangs on it: the room's exit closes the socket, which ends the read.
export const SSE_READ_TIMEOUT: number | null = null;
export const SSE_CONNECT_TIMEOUT = 10;

/**
 * Reads PB's SSE channel in the background; on PB_CONNECT authorizes `topic` with `token`
 * and collects every envelope delivered on that topic.
 *
 * `timeout` is how long one read may block; null never expires. Every absence assertion
 * must read `absent_count()` rather than `events` — a reader that died delivers nothing,
 * which is exactly what such an assertion expects. Bespoke views of `events` belong in the
 * suite that wants them, not here.
 */
const _STOPPED = Symbol("stopped");

export class SSEListener {
  base_url: string;
  token: string;
  topic: string;
  timeout: number | null;
  events: any[] = [];
  client_id: string | null = null;
  died: unknown = null;
  private _stop = false;
  private _abort = new AbortController();

  constructor(
    base_url: string,
    token: string,
    topic: string,
    timeout: number | null = SSE_READ_TIMEOUT,
  ) {
    this.base_url = base_url;
    this.token = token;
    this.topic = topic;
    this.timeout = timeout;
  }

  get stop(): boolean {
    return this._stop;
  }

  set stop(value: boolean) {
    this._stop = value;
    if (value) this._abort.abort(_STOPPED);
  }

  private async _subscribe(): Promise<number> {
    const r = await fetch(this.base_url + "/api/realtime", {
      method: "POST",
      body: JSON.stringify({ clientId: this.client_id, subscriptions: [this.topic] }),
      headers: { "Content-Type": "application/json", Authorization: this.token },
    });
    await r.body?.cancel();
    // A refused subscribe is an ASSERTION for some suites, so the reader survives it.
    return r.status;
  }

  async run(): Promise<void> {
    const abort = this._abort;
    let timer: Timer | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      if (this.timeout !== null) {
        timer = setTimeout(() => {
          const err = new Error("timed out");
          err.name = "TimeoutError";
          abort.abort(err);
        }, this.timeout * 1000);
      }
    };
    try {
      arm();
      const resp = await fetch(this.base_url + "/api/realtime", { signal: abort.signal });
      if (resp.status < 200 || resp.status >= 300) {
        await resp.body?.cancel();
        throw new HTTPError(resp.status, resp.statusText);
      }
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let ev: string | null = null;
      let data: string[] = [];
      let buf = "";
      let eof = false;
      while (true) {
        let nl = buf.indexOf("\n");
        if (nl < 0 && !eof) {
          arm();
          const chunk = await reader.read();
          clearTimeout(timer);
          if (chunk.done) {
            eof = true;
            buf += decoder.decode();
          } else {
            buf += decoder.decode(chunk.value, { stream: true });
          }
          continue;
        }
        if (nl < 0 && !buf) {
          break;
        }
        if (nl < 0) {
          nl = buf.length;
        }
        if (this.stop) {
          await reader.cancel().catch(() => {});
          break;
        }
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith("event:")) {
          ev = py_strip(line.slice(6));
        } else if (line.startsWith("data:")) {
          data.push(py_strip(line.slice(5)));
        } else if (line === "") {
          const payload = data.join("");
          data = [];
          if (ev === "PB_CONNECT") {
            const connect = JSON.parse(payload);
            if (!("clientId" in connect)) {
              const err = new Error("clientId");
              err.name = "KeyError";
              throw err;
            }
            this.client_id = connect.clientId;
            await this._subscribe();
          } else if (ev === this.topic) {
            this.events.push(JSON.parse(payload));
          }
          ev = null;
        }
      }
    } catch (e) {
      if (abort.signal.reason === _STOPPED) return;
      // recorded, not raised: a background reader has no caller
      this.died = e;
      return;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    if (!this.stop) {
      const err = new Error("the server closed the SSE stream");
      err.name = "EOFError";
      this.died = err;
    }
  }

  async start(): Promise<string | null> {
    void this.run();
    const deadline = _now() + SSE_CONNECT_TIMEOUT;
    while (_now() < deadline && !this.client_id) {
      await _sleep(0.1);
    }
    return this.client_id;
  }

  /** True while PB_CONNECT has arrived and the reader is still on the stream. */
  get connected(): boolean {
    return this.client_id !== null && this.died === null;
  }

  /**
   * `count` (default: every envelope seen) when the reader is still live, else a string
   * naming why the absence is unprovable — a dead reader delivers nothing, so an assertion
   * reading `events` directly passes vacuously on one.
   */
  absent_count(count?: unknown): unknown {
    if (this.died !== null) {
      return `UNPROVABLE — the reader thread died: ${py_repr(this.died)}`;
    }
    if (this.client_id === null) {
      return "UNPROVABLE — the reader never connected (no PB_CONNECT envelope)";
    }
    return count === undefined || count === null ? this.events.length : count;
  }

  of(collection: string, action: string): any[] {
    return this.events.filter((e) => e?.collection === collection && e?.action === action);
  }
}

// ── PB_URL-driven suites: name the cause instead of dying on the symptom ─────

/**
 * Turn a connection-level failure into a named cause. These suites do not boot their
 * own room; PB_URL must already point at a freshly-seeded one.
 */
export function die_no_server(pb_url: string, err: unknown): never {
  const reason =
    err !== null && typeof err === "object" && "reason" in err ? (err as any).reason : err;
  throw new SystemExit(
    `❌ NO SERVER AT ${pb_url} (${py_str(reason)}) — this suite does not ` +
      `boot its own room. Boot a clean room, seed it with scripts/seed.ts, and point ` +
      `PB_URL at it (AGENTS.md → 'Clean-room law').`,
  );
}

/**
 * [identity, password] for the room's superuser from env, or a named cause.
 *
 * These suites do not boot their own room, so nothing can supply the creds implicitly.
 */
export function superuser_creds(): [string, string] {
  const email = process.env.PB_SUPERUSER_EMAIL ?? "";
  const password = process.env.PB_SUPERUSER_PASSWORD ?? "";
  const missing = (
    [
      ["PB_SUPERUSER_EMAIL", email],
      ["PB_SUPERUSER_PASSWORD", password],
    ] as const
  )
    .filter(([, val]) => !val)
    .map(([name]) => name);
  if (missing.length) {
    throw new SystemExit(
      `❌ MISSING ${missing.join(", ")} — this suite does not boot its own room; ` +
        `it needs the superuser creds from env. Solo-run recipe: ` +
        `.agents/rules/ports.md → 'Two kinds of suite'.`,
    );
  }
  return [email, password];
}

/**
 * The auth token from an auth-with-password/auth-refresh body, or a named cause.
 *
 * PB's auth rate limiter lives in server memory and only a RESTART resets it, so a room
 * reused across suites 429s here — that is the order-coupling, not stale data.
 */
export function token_of(pb_url: string, identity: string, body: any): string {
  const token = body.token;
  if (token) {
    return token;
  }
  const status = body.status;
  const message = py_get(body, "message", "");
  let cause: string;
  if (status === 429) {
    cause =
      "PocketBase's in-memory auth rate limiter is exhausted. Each of these suites " +
      "needs its OWN freshly-booted room — only a server restart resets the limiter, " +
      "so running two of them against one room fails right here.";
  } else {
    cause =
      "The room is not seeded, or the credentials are wrong. Seed it with " +
      `PB_URL=${pb_url} bun scripts/seed.ts.`;
  }
  throw new SystemExit(
    `❌ AUTH FAILED at ${pb_url} for ${py_repr(identity)} (HTTP ${py_str(status)} ${py_str(message)}). ${cause}`,
  );
}

export const USAGE =
  "usage: bun tests/roomkit.ts <port>                             # pre-boot preflight\n" +
  "       bun tests/roomkit.ts --wait-health <port> <pid> [secs]  # boot wait + liveness\n" +
  "       bun tests/roomkit.ts --verify-room <port> <pid>         # post-boot owner check";

function _port_and_pid(args: string[]): [number, number] | null {
  const port = _py_int_or_null(args[1]!);
  const pid = _py_int_or_null(args[2]!);
  if (port === null || pid === null) {
    process.stderr.write(
      `${USAGE}\n\nport and pid must both be integers, got ${py_repr(args[1])} and ${py_repr(args[2])}\n`,
    );
    return null;
  }
  return [port, pid];
}

export async function _main(argv: string[]): Promise<number> {
  const args = argv.slice(1);
  if (args[0] === "--wait-health") {
    if (args.length !== 3 && args.length !== 4) {
      process.stderr.write(USAGE + "\n");
      return 2;
    }
    const parsed = _port_and_pid(args);
    if (parsed === null) {
      return 2;
    }
    const [port, pid] = parsed;
    const timeout = args.length === 4 ? _py_float(args[3]!) : HEALTH_TIMEOUT;
    if (timeout === null) {
      process.stderr.write(`${USAGE}\n\n${py_repr(args[3])} is not a number of seconds\n`);
      return 2;
    }
    try {
      await wait_for_health(`http://127.0.0.1:${port}`, pid, timeout);
    } catch (e) {
      if (e instanceof RoomNotHealthy || e instanceof RoomNotOurs) {
        return 1;
      }
      throw e;
    }
    return 0;
  }
  if (args[0] === "--verify-room") {
    if (args.length !== 3) {
      process.stderr.write(USAGE + "\n");
      return 2;
    }
    const parsed = _port_and_pid(args);
    if (parsed === null) {
      return 2;
    }
    try {
      await require_own_room(...parsed);
    } catch (e) {
      if (e instanceof RoomNotOurs) {
        return 1;
      }
      throw e;
    }
    return 0;
  }
  if (args.length !== 1) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  const port = _py_int_or_null(args[0]!);
  if (port === null) {
    process.stderr.write(`${USAGE}\n\n${py_repr(args[0])} is not an integer\n`);
    return 2;
  }
  try {
    await require_free_port(port);
  } catch (e) {
    if (e instanceof PortInUse) {
      return 1;
    }
    throw e;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await _main(process.argv.slice(1)));
}

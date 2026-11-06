#!/usr/bin/env bun
/**
 * `--help` sweep: every scripts/*.ts (plus replay_backup.sh) exits 0 under a closed PB_URL AND rewrites no tracked file.
 *
 * Scope: `scripts/*.ts` top level, with no exclusions (library modules such as `_py.ts` do nothing
 * when run and so exit 0). `scripts/model/`, `scripts/utilities/` and
 * other subdirs are OUT — not swept (declared bounded coverage, not silently skipped). Two
 * assertions per sweep: exit 0 under a closed `PB_URL` (a proxy for "didn't reach a live server"),
 * and that the sweep rewrote no git-tracked file — the arg parser must answer `--help` before any side
 * effect. The write detector is (mtime_ns, size) per tracked path, not a content diff: the gen_*
 * scripts rewrote BYTE-IDENTICAL artifacts, which `git status` cannot see, so a diff-based
 * assertion could never go red. `git status --porcelain` is compared before/after as a second,
 * weaker check that also catches a content change; before/after rather than "empty" so the
 * assertion holds in a worktree with unrelated edits in flight.
 *
 * Bounded: only git-tracked files are watched, so a write to an untracked or gitignored path
 * (scratch dirs, pb_data/) is out of scope by design.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { by_code_point, glob_sorted, py_int, py_join } from "../scripts/_py.ts";
import { pb_bin_path } from "../scripts/pb_migrate.ts";

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
  if (!ok) FAILS.push(label);
}

const REPO_ROOT = path.dirname(import.meta.dir);
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
const CLOSED_PORT = 9700 + py_int(process.env.PB_PORT_OFFSET ?? "0");

const ENV = { ...process.env, PB_URL: `http://127.0.0.1:${CLOSED_PORT}` };

function closed_port(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: CLOSED_PORT, timeout: 1000 });
    s.once("connect", () => (s.destroy(), resolve(false)));
    s.once("timeout", () => (s.destroy(), resolve(true)));
    s.once("error", () => (s.destroy(), resolve(true)));
  });
}

check(`port ${CLOSED_PORT} (9700 + PB_PORT_OFFSET) is closed`, await closed_port());

// Several swept scripts refuse loudly without the binary, which would read as a --help failure.
// The ONE resolver: a mismatched pin or missing binary shows up here as a named path, not a
// false "no scripts/*.ts failed" green.
const PB_BIN = pb_bin_path(REPO_ROOT);
let pb_ok = false;
try {
  fs.accessSync(PB_BIN, fs.constants.X_OK);
  pb_ok = fs.statSync(PB_BIN).isFile();
} catch {}
check(`PB_BIN resolves to an executable (${PB_BIN})`, pb_ok);

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { returncode: r.exitCode, stdout: r.stdout.toString() };
}

type Meta = [bigint, number];

/** {repo-relative path: (mtime_ns, size)} for every git-tracked file. */
function tracked_snapshot(): Map<string, Meta> | null {
  const listing = git("ls-files", "-z");
  if (listing.returncode !== 0) return null;
  const snap = new Map<string, Meta>();
  for (const rel of listing.stdout.split("\0")) {
    if (!rel) continue;
    try {
      const st = fs.statSync(py_join(REPO_ROOT, rel), { bigint: true });
      snap.set(rel, [st.mtimeNs, Number(st.size)]);
    } catch {
      continue;
    }
  }
  return snap;
}

const same = (a: Meta, b: Meta): boolean => a[0] === b[0] && a[1] === b[1];
const show = (m: Meta): string => `(${m[0]}, ${m[1]})`;

const scripts = glob_sorted(SCRIPTS_DIR, ".ts");
check("at least one scripts/*.ts found", scripts.length > 0);
// replay_backup.sh is the one shell script with a --help contract; other .sh files are out of the sweep.
const sh_scripts = [path.join(SCRIPTS_DIR, "replay_backup.sh")];

const before_stat = tracked_snapshot();
const before_status = git("status", "--porcelain").stdout;
check("git ls-files snapshot taken before the sweep", before_stat !== null);

for (const script of scripts) {
  const name = path.basename(script);
  const r = Bun.spawnSync(["bun", script, "--help"], {
    env: ENV,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  });
  check(`${name} --help exits 0`, r.exitCode === 0);
}

for (const script of sh_scripts) {
  const r = Bun.spawnSync(["bash", script, "--help"], {
    env: ENV,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  });
  check(`${path.basename(script)} --help exits 0`, r.exitCode === 0);
}

const after_stat = tracked_snapshot();
const rewritten = [...(after_stat ?? new Map<string, Meta>())]
  .filter(([rel, meta]) => before_stat?.has(rel) && !same(meta, before_stat.get(rel)!))
  .map(([rel]) => rel)
  .sort(by_code_point);
const appeared = [...(after_stat?.keys() ?? [])]
  .filter((k) => !before_stat?.has(k))
  .sort(by_code_point);
const vanished = [...(before_stat?.keys() ?? [])]
  .filter((k) => !after_stat?.has(k))
  .sort(by_code_point);
check(
  "the --help sweep rewrote no git-tracked file",
  !(rewritten.length || appeared.length || vanished.length),
);
for (const rel of rewritten) {
  console.log(
    `        rewritten: ${rel} ${show(before_stat!.get(rel)!)} -> ${show(after_stat!.get(rel)!)}`,
  );
}
for (const rel of appeared) console.log(`        appeared: ${rel}`);
for (const rel of vanished) console.log(`        vanished: ${rel}`);
check(
  "the --help sweep left `git status --porcelain` unchanged",
  git("status", "--porcelain").stdout === before_status,
);

// seed.ts's module body must run entirely inside main() — a dynamic import must reach no
// network call.
const import_probe =
  `await import(${JSON.stringify(path.join(SCRIPTS_DIR, "seed.ts"))});\n` +
  'console.log("imported, no network");\n';
const probe = Bun.spawnSync(["bun", "-e", import_probe], {
  cwd: REPO_ROOT,
  env: ENV,
  stdout: "pipe",
  stderr: "pipe",
  timeout: 15000,
});
check(
  "scripts/seed.ts dynamic import makes no network call",
  probe.exitCode === 0 && probe.stdout.toString().includes("imported, no network"),
);

// replay_backup.sh parse-only mode: newest-key pick and staleness gate on a fixture listing, no network.
const REPLAY_SH = path.join(SCRIPTS_DIR, "replay_backup.sh");
const item = (key: string, when: string) =>
  `<Contents><Key>${key}</Key><Size>2366653</Size><Owner><ID></ID></Owner><StorageClass>STANDARD</StorageClass><LastModified>${when}</LastModified></Contents>`;
// One line, as the real listing is; an older .zip comes first and the newest is not first, and a newer non-zip is ignored.
const LISTING =
  "<ListBucketResult>" +
  item("@auto_pb_backup_task_tracker_20261104180800.zip", "2026-11-04T18:08:00Z") +
  item("@auto_pb_backup_task_tracker_20261106180800.zip", "2026-11-06T18:08:00Z") +
  item("notes.txt", "2026-11-07T00:00:00Z") +
  "</ListBucketResult>";
const epoch = (iso: string) => String(Date.parse(iso) / 1000);

function run(stdin: string, ...args: string[]) {
  const r = Bun.spawnSync(["bash", REPLAY_SH, "--newest-key", ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PB_BACKUPS_S3_SECRET: "sekrit-value" },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const fresh = run(LISTING, "--now", epoch("2026-11-07T18:08:00Z"));
check("fresh: exits 0", fresh.code === 0);
check(
  "fresh: prints '<LastModified> <Key>' of the newest .zip",
  fresh.out.trim() === "2026-11-06T18:08:00Z @auto_pb_backup_task_tracker_20261106180800.zip",
);

const stale = run(LISTING, "--now", epoch("2026-11-10T18:08:00Z"));
check("stale (4 days, default max 2): exits non-zero", stale.code !== 0);
check(
  "stale: one-line message naming the key and the limit",
  stale.err.trim().split("\n").length === 1 &&
    stale.err.includes("@auto_pb_backup_task_tracker_20261106180800.zip") &&
    stale.err.includes("more than 2 days old"),
);
check("stale: no credential in the message", !stale.err.includes("sekrit-value"));

const wide = run(LISTING, "--now", epoch("2026-11-10T18:08:00Z"), "--max-age-days", "7");
check("--max-age-days 7 accepts a 4-day-old backup", wide.code === 0);

const max_s = 2 * 86400;
const t0 = Date.parse("2026-11-06T18:08:00Z") / 1000;
check("exact boundary (age == max) passes", run(LISTING, "--now", String(t0 + max_s)).code === 0);
check("boundary + 1s fails", run(LISTING, "--now", String(t0 + max_s + 1)).code === 1);

// A bad number must stop before any network call: shim curl to a marker file.
const shim = fs.mkdtempSync(path.join(os.tmpdir(), "replay-shim-"));
const marker = path.join(shim, "curl-called");
fs.writeFileSync(path.join(shim, "curl"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, {
  mode: 0o755,
});
for (const bad of [
  ["--max-age-days", "08"],
  ["--max-age-days", "010"],
  ["--now", "x1"],
]) {
  const r = Bun.spawnSync(["bash", REPLAY_SH, ...bad], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${shim}:${process.env.PATH}`,
      PB_BACKUPS_S3_BUCKET: "b",
      PB_BACKUPS_S3_ENDPOINT: "http://127.0.0.1:1",
      PB_BACKUPS_S3_REGION: "r",
      PB_BACKUPS_S3_ACCESS_KEY: "k",
      PB_BACKUPS_S3_SECRET: "sekrit-value",
    },
  });
  check(
    `${bad.join(" ")}: exits 1, one-line message, no curl`,
    r.exitCode === 1 &&
      r.stderr.toString().trim().split("\n").length === 1 &&
      !fs.existsSync(marker),
  );
}
fs.rmSync(shim, { recursive: true, force: true });

const none = run(
  `<ListBucketResult>${item("notes.txt", "2026-11-07T00:00:00Z")}</ListBucketResult>`,
);
check("no .zip key: exits non-zero", none.code !== 0 && none.err.includes("no .zip backup"));

if (FAILS.length) {
  console.log(`❌ test_script_help: ${FAILS.length} check(s) failed`);
  process.exit(1);
}
console.log(
  `✅ test_script_help: ${scripts.length + sh_scripts.length} script(s) + 1 import probe clean`,
);
process.exit(0);

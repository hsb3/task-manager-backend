#!/usr/bin/env bun
/** Proof of scripts/pb_migrate.ts's failure detection — real PB for the migration and hook-guard cases, stub binaries for the two output shapes; binds no port, boots no server. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_strip, run_checked, sqlite_connect } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import {
  HOOKS,
  VERSION_TIMEOUT_S,
  migrate_up,
  pb_bin_path,
  pinned_pb_version,
} from "../scripts/pb_migrate.ts";

const PB_BIN = roomkit.pb_bin();

// A minimal fixture, deliberately not a copy of pb_migrations/: this suite proves the
// helper's verdict on PB's output, and real schema would only make it slower.
const NOOP_FILE = "1700000000_probe_noop.js";
const NOOP_BODY = "migrate((app) => {}, (app) => {});\n";
const THROWING_FILE = "1700000100_probe_throws.js";
const THROWING_BODY = 'migrate((app) => { throw new Error("deliberate probe"); }, (app) => {});\n';

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
  if (!ok) FAILS.push(label);
}

function make_dir(parent: string, name: string): string {
  const p = path.join(parent, name);
  fs.mkdirSync(p, { recursive: false });
  return p;
}

function write_migrations(parent: string, name: string, files: Record<string, string>): string {
  const d = make_dir(parent, name);
  for (const [filename, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, filename), body, "utf-8");
  }
  return d;
}

/** A fake `pocketbase` — migrate_up takes the binary as an argument, so the two
 * output-shape cases need no PocketBase at all. */
function stub_pb(parent: string, name: string, body: string): string {
  const p = path.join(parent, name);
  fs.writeFileSync(p, body, "utf-8");
  fs.chmodSync(p, 0o755);
  return p;
}

function with_scratch(fn: (scratch: string) => void): void {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmp")));
  try {
    fn(scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("── real PocketBase: a migration that throws ──");

with_scratch((scratch) => {
  const mig = write_migrations(scratch, "mig", {
    [NOOP_FILE]: NOOP_BODY,
    [THROWING_FILE]: THROWING_BODY,
  });
  const [ok, out] = migrate_up(PB_BIN, make_dir(scratch, "data"), mig);
  check("throwing migration -> ok False", ok === false);
  check(`output names ${THROWING_FILE}`, out.includes(THROWING_FILE));

  // PB's own verdict, unrouted: 0.40.4 exits non-zero here. If this ever fails, PB's
  // behaviour moved again — migrate_up()'s exit-status-only verdict would stop refusing.
  const raw = Bun.spawnSync(
    [PB_BIN, "migrate", "up", "--dir", make_dir(scratch, "data_raw"), "--migrationsDir", mig],
    { env: process.env },
  );
  check("PB's own exit status on that failed migration is non-zero", raw.exitCode !== 0);
});

console.log("── real PocketBase: a clean set ──");

with_scratch((scratch) => {
  const mig = write_migrations(scratch, "mig", { [NOOP_FILE]: NOOP_BODY });
  const [ok, out] = migrate_up(PB_BIN, make_dir(scratch, "data"), mig);
  check("clean migration set -> ok True", ok === true);
  check(`output reports ${NOOP_FILE} applied`, out.includes(NOOP_FILE));
});

console.log("── real PocketBase: pb_hooks/ guards run during the replay ──");

/** Creates a bare project_items carrying `rule` — counts.pb.js guards that name at the model tier. */
function listrule_migration(rule: string): string {
  return (
    "migrate((app) => { app.save(new Collection(" +
    `{ type: "base", name: "project_items", listRule: '${rule}' })); }, (app) => {});\n`
  );
}

const BAD_RULE = '@request.headers.x_probe = "1"';
const GOOD_RULE = '@request.auth.id != ""';

function stored_rule(data: string): string | null {
  const db = sqlite_connect(path.join(data, "data.db"));
  try {
    const row = db.query("select listRule from _collections where name='project_items'").get() as {
      listRule: string | null;
    } | null;
    return row ? row.listRule : null;
  } finally {
    db.close();
  }
}

// The battery EXPORTS PB_HOOKS_DIR; unset it so the default case below takes the copy branch.
const _saved_hooks_env = process.env.PB_HOOKS_DIR;
delete process.env.PB_HOOKS_DIR;

with_scratch((scratch) => {
  const bad = write_migrations(scratch, "bad", {
    "1700000200_probe_bad_rule.js": listrule_migration(BAD_RULE),
  });
  let data = make_dir(scratch, "data_bad");
  let [ok, out] = migrate_up(PB_BIN, data, bad);
  check("a listRule the guard refuses -> ok False", ok === false);
  check("...output names the guard's refusal", out.includes("may reference @request.auth.id only"));
  check("...and the rule is not stored", stored_rule(data) === null);

  const good = write_migrations(scratch, "good", {
    "1700000200_probe_good_rule.js": listrule_migration(GOOD_RULE),
  });
  data = make_dir(scratch, "data_good");
  [ok, out] = migrate_up(PB_BIN, data, good);
  check("a listRule the guard accepts -> ok True", ok === true);
  check("...and it is stored", stored_rule(data) === GOOD_RULE);

  // An explicit hooks_dir wins: an empty one stores the same bad rule, so the default is what guards.
  data = make_dir(scratch, "data_hookless");
  [ok, out] = migrate_up(PB_BIN, data, bad, null, make_dir(scratch, "no_hooks"));
  check(
    "an explicit empty hooks_dir is honoured (bad rule stored, ok True)",
    ok === true && stored_rule(data) === BAD_RULE,
  );

  // $PB_HOOKS_DIR is the branch every battery run takes.
  process.env.PB_HOOKS_DIR = make_dir(scratch, "env_no_hooks");
  data = make_dir(scratch, "data_env_hookless");
  [ok, out] = migrate_up(PB_BIN, data, bad);
  check(
    "an empty $PB_HOOKS_DIR is honoured (bad rule stored, ok True)",
    ok === true && stored_rule(data) === BAD_RULE,
  );
  const env_hooks = path.join(scratch, "env_hooks");
  fs.cpSync(HOOKS, env_hooks, { recursive: true, dereference: true });
  process.env.PB_HOOKS_DIR = env_hooks;
  data = make_dir(scratch, "data_env_hooks");
  [ok, out] = migrate_up(PB_BIN, data, bad);
  check(
    "a $PB_HOOKS_DIR copy of pb_hooks/ refuses the bad rule (ok False, not stored)",
    ok === false && stored_rule(data) === null,
  );
  delete process.env.PB_HOOKS_DIR;
});

console.log("── the live pb_hooks/ is never a replay's hooksDir ──");

with_scratch((scratch) => {
  const pb = stub_pb(scratch, "pb-never-run", "#!/bin/sh\nexit 0\n");
  // Through a symlink, so only a realpath comparison catches it.
  const alias = path.join(scratch, "hooks_alias");
  fs.symlinkSync(HOOKS, alias);

  function live_refused(hooks_dir: string | null = null): boolean {
    try {
      migrate_up(pb, scratch, scratch, null, hooks_dir);
    } catch (e) {
      if (e instanceof Error && !(e instanceof roomkit.SystemExit)) {
        return e.message.includes("live") && e.message.includes("pb_hooks");
      }
      throw e;
    }
    return false;
  }

  check("hooks_dir = the live pb_hooks/ (via a symlink) -> raises", live_refused(alias));
  process.env.PB_HOOKS_DIR = HOOKS;
  check("$PB_HOOKS_DIR = the live pb_hooks/ -> raises", live_refused());
  delete process.env.PB_HOOKS_DIR;
});

if (_saved_hooks_env !== undefined) {
  process.env.PB_HOOKS_DIR = _saved_hooks_env;
}

console.log("── stub binary: non-zero exit ──");

with_scratch((scratch) => {
  const pb = stub_pb(scratch, "pb-exit3", "#!/bin/sh\necho boom\nexit 3\n");
  const [ok] = migrate_up(pb, scratch, scratch);
  check("exit 3 -> ok False", ok === false);
});

console.log("── stub binary: exit 0 with an Error:-prefixed line ──");

with_scratch((scratch) => {
  const pb = stub_pb(
    scratch,
    "pb-continuation",
    "#!/bin/sh\nprintf 'Applied %s\\nError: printed by the migration itself\\n' " +
      `'${NOOP_FILE}'\nexit 0\n`,
  );
  const [ok] = migrate_up(pb, scratch, scratch);
  // The exit status is the whole verdict; a migration's own `Error:` output is not a refusal.
  check("Error: on a line with exit 0 -> ok True (exit status is the whole verdict)", ok === true);
});

console.log("── pb_bin_path: which binary a caller resolves to ──");

// The battery EXPORTS PB_BIN, and it wins over every probe — unset it or each case below
// would resolve to whatever the parent run chose rather than to the branch it is testing.
const _saved_pb_bin = process.env.PB_BIN;
delete process.env.PB_BIN;

// Every resolved binary is version-checked, so a stub must answer --version like the pin.
const PB_STUB = `#!/bin/sh\necho "pocketbase version ${pinned_pb_version()}"\n`;
const WRONG_VERSION = "0.30.0";
const PB_STUB_WRONG = `#!/bin/sh\necho "pocketbase version ${WRONG_VERSION}"\n`;
const PB_STUB_MUTE = "#!/bin/sh\nexit 0\n";

/** (repo root, subdir). The SUBDIR stands in for a linked worktree: both make
 * `git rev-parse --git-common-dir` name a directory other than the one asked about. */
function scratch_repo(parent: string, name: string): [string, string] {
  const root = make_dir(parent, name);
  run_checked(["git", "init", "-q", root], { capture_output: true });
  return [root, make_dir(root, "lane")];
}

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "present");
  const own = stub_pb(lane, "pocketbase", PB_STUB);
  stub_pb(root, "pocketbase", PB_STUB);
  check(
    "a binary in the tree asked about wins over the main checkout's",
    pb_bin_path(lane) === own,
  );
});

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "fallback");
  const main = stub_pb(root, "pocketbase", PB_STUB);
  check(
    "no binary in the tree -> the main checkout's, via --git-common-dir",
    pb_bin_path(lane) === main,
  );
});

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "neither");
  const got = pb_bin_path(lane);
  // Both FULL binary paths: the repo root is a prefix of the lane dir, so naming the
  // directories would pass on a sentinel that only ever mentions one of them.
  check(
    "neither present -> both places named",
    got.includes(path.join(lane, "pocketbase")) && got.includes(path.join(root, "pocketbase")),
  );
  check("...and that path cannot be mistaken for a binary", !fs.existsSync(got));
});

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "directory");
  make_dir(lane, "pocketbase");
  const main = stub_pb(root, "pocketbase", PB_STUB);
  // X_OK on a directory is True, so only the is-file test keeps a directory out.
  check("a DIRECTORY named pocketbase is not adopted", pb_bin_path(lane) === main);
});

/**
 * What pb_bin_path refused with, or null when it resolved to a usable binary.
 *
 * A refusal is a path that CANNOT exist — never an exception. Four callers bind this at
 * module level (`PB = pb_bin_path(REPO)`), so a raise here becomes a traceback in place of
 * their own `no ./pocketbase at ...` line.
 */
function refusal(repo: string): string | null {
  const got = pb_bin_path(repo);
  return fs.existsSync(got) ? null : got;
}

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "no_raise");
  stub_pb(root, "pocketbase", PB_STUB_WRONG);
  let got: string | null;
  let raised: string | null;
  try {
    got = pb_bin_path(lane);
    raised = null;
  } catch (e) {
    got = null;
    raised = String(e);
  }
  check(py_strip(`a refusal RETURNS, it does not raise ${raised ?? ""}`), raised === null);
  check("...and what it returns cannot be mistaken for a binary", !fs.existsSync(got ?? ""));
});

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "wrong_version");
  stub_pb(root, "pocketbase", PB_STUB_WRONG);
  const msg = refusal(lane) ?? "";
  check("an off-version main-checkout binary is refused, not adopted", msg !== "");
  check(
    "...and the refusal names BOTH versions",
    msg.includes(WRONG_VERSION) && msg.includes(pinned_pb_version()),
  );
  const own = stub_pb(lane, "pocketbase", PB_STUB_WRONG);
  check("...same refusal for the tree's own binary", (refusal(lane) ?? "").includes(WRONG_VERSION));
  process.env.PB_BIN = own;
  check("...and for an explicit PB_BIN", (refusal(lane) ?? "").includes(WRONG_VERSION));
  delete process.env.PB_BIN;
});

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "mute");
  stub_pb(root, "pocketbase", PB_STUB_MUTE);
  check(
    "a binary that prints no version is refused too",
    (refusal(lane) ?? "").includes("unknown"),
  );
});

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "not_executable");
  const plain = path.join(root, "pocketbase");
  fs.writeFileSync(plain, "not a binary\n", "utf-8");
  fs.chmodSync(plain, 0o644);
  process.env.PB_BIN = plain;
  const msg = refusal(lane) ?? "";
  // A file with no execute bit is a setup mistake, not an off-version PocketBase.
  check("a non-executable PB_BIN is named as such", msg.includes("not an executable file"));
  check("...not misreported as an unknown version", !msg.includes("PocketBase unknown"));
  delete process.env.PB_BIN;
});

with_scratch((scratch) => {
  const [root, lane] = scratch_repo(scratch, "hangs");
  stub_pb(root, "pocketbase", "#!/bin/sh\nsleep 120\n");
  const started = performance.now();
  const msg = refusal(lane) ?? "";
  const elapsed = (performance.now() - started) / 1000;
  check("a binary that never answers --version is refused, not waited on", msg.includes("unknown"));
  check(`...within the timeout (took ${elapsed.toFixed(1)}s)`, elapsed < VERSION_TIMEOUT_S + 20);
});

// Reading the pin, not holding a copy of it: a Dockerfile whose pin moved must move this too.
// Assembled, not a literal ARG line: scripts/check_pb_pin.ts scans this file's own source
// text for that shape, and a static match here would be a fake pin site.
with_scratch((scratch) => {
  const stub_version = "9.9.9";
  fs.writeFileSync(
    path.join(scratch, "Dockerfile"),
    "FROM scratch\nARG PB_VERSION=" + stub_version + "\n",
    "utf-8",
  );
  check(
    "the pin is READ from the Dockerfile, not copied",
    pinned_pb_version(scratch) === stub_version,
  );
});

if (_saved_pb_bin !== undefined) {
  process.env.PB_BIN = _saved_pb_bin;
}

process.exit(FAILS.length ? 1 : 0);

#!/usr/bin/env bash
# run_suite_battery.sh — boots clean-room PocketBase servers and runs the full suite battery (CI + pre-push gate); exits non-zero on the first failure.
# Never touches the repo's real pb_migrations/, pb_data/, or the dev server on 8090 — every room boots from a scratch copy of the migrations.
# Usage:  bash scripts/run_suite_battery.sh
# Env:    KEEP_SCRATCH=1  keep the scratch tree for debugging (default: cleaned up)
#         PB_BIN=/path/to/pocketbase  run every room and suite on that binary as-is (default: ./pocketbase, downloaded when absent or the wrong version)
#         BATTERY_SHARD=i/N  run only the suites scripts/battery_shards.tsv assigns to shard i of N (default: every suite)
#         BATTERY_MANIFEST=/path  truncate it, then append each passed suite's label (CI's battery-verify job unions them)
set -uo pipefail

# ── Paths & constants ─────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
. "$REPO_ROOT/scripts/verification-env.sh" || exit 1

# Baselines for the cleanliness guards below: fail only on changes the battery run itself makes,
# so a legitimately-regenerated uncommitted tree (e.g. migration + model regen in flight) stays green.
# Content, not just porcelain: a status line reads the same whether an already-dirty file keeps its
# bytes or the battery rewrites them, and a clobbered working-tree edit is what these guards catch.
tree_state() {
  git -C "$REPO_ROOT" status --porcelain -- "$@"
  git -C "$REPO_ROOT" diff -- "$@"
  git -C "$REPO_ROOT" diff --cached -- "$@"
  # Untracked bytes have no diff to read, so hash them; -z, or a path with a space arrives quoted.
  git -C "$REPO_ROOT" ls-files --others --exclude-standard -z -- "$@" |
    while IFS= read -r -d '' p; do printf '%s  %s\n' "$(git -C "$REPO_ROOT" hash-object -- "$p")" "$p"; done
}
MIG_STATUS_BEFORE="$(tree_state pb_migrations/)"
MODEL_STATUS_BEFORE="$(tree_state scripts/model/current/)"

PB_VERSION="0.40.4"                      # must equal the Dockerfile's ARG PB_VERSION, the canonical pin (scripts/check_pb_pin.ts).
PB_BIN_DEFAULT="$REPO_ROOT/pocketbase"
PB_BIN="${PB_BIN:-$PB_BIN_DEFAULT}"
export PB_BIN                            # export: self-booting suites (roomkit.pb_bin) must inherit it
HOOKS_DIR="$REPO_ROOT/pb_hooks"
# The ONLY file that enables _superusers MFA. Matched by PATTERN, never by timestamp: a baseline
# rebuild renames it, and a stale literal strips nothing and silently leaves every room on MFA.
MFA_MIGRATION_GLOB="*superuser_mfa.js"
# Written, never read: its stamp sits past the committed band so a room applies it last.
SCRATCH_SMTP_MIGRATION="1785200000_scratch_smtp_sink.js"

PB_PORT_OFFSET="${PB_PORT_OFFSET:-0}"
# Normalize through the SAME py_int (Python int()) the suites use: bash arithmetic reads a leading zero as
# OCTAL, so a bare 010 would put these rooms 8 apart and the suites 10 apart — a split run.
# argv, not process.env: the assignment above is a shell variable and the export is below, so
# an unset offset would reach bun as undefined rather than as the default 0.
PB_PORT_OFFSET="$(bun -e 'const { py_int } = await import(process.argv[1]); process.stdout.write(String(py_int(process.argv[2])))' "$REPO_ROOT/scripts/_py.ts" "$PB_PORT_OFFSET")" \
  || { echo "❌ BATTERY FAILED: PB_PORT_OFFSET must be a decimal integer"; exit 1; }
export PB_PORT_OFFSET                          # export: self-booting suites must inherit it
LEGACY_PORT=$((8091 + PB_PORT_OFFSET))
EMAIL_PORT=$((8092 + PB_PORT_OFFSET))
HARD_PORT=$((8093 + PB_PORT_OFFSET))
EMAIL_SINK_PORT=$((2526 + PB_PORT_OFFSET))  # test_email's MAIL_SINK_PORT default; it PATCHes smtp here itself
HARD_SINK_PORT=$((2527 + PB_PORT_OFFSET))   # test_hardening's PB_SINK_PORT; the scratch migration points smtp here

# Dummy credentials only — the script upserts these into every room.
export PB_SUPERUSER_EMAIL="${PB_SUPERUSER_EMAIL:-ci@example.test}"
export PB_SUPERUSER_PASSWORD="${PB_SUPERUSER_PASSWORD:-ci-battery-dummy-pw-000}"
DUMMY_RESEND_KEY="dummy-ci-resend-key"   # non-empty so the boot hook runs; the sink ignores auth

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pb-battery.XXXXXX")"
ROOM_PIDS=()
SINK_PIDS=()

# ── Cleanup: kill every room/sink we started, drop the scratch tree ───────────
cleanup() {
  local pid
  for pid in "${ROOM_PIDS[@]:-}" "${SINK_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  if [ -n "${KEEP_SCRATCH:-}" ]; then
    echo "· scratch kept at $SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT INT TERM

fail() { echo "❌ BATTERY FAILED: $*"; exit 1; }

# ── Shard selection + manifest ────────────────────────────────────────────────
# Read into shell variables and unset: a suite that runs the battery itself must not inherit them.
SHARD_SPEC="${BATTERY_SHARD-}"; SHARD_SET="${BATTERY_SHARD+set}"
MANIFEST="${BATTERY_MANIFEST-}"
unset BATTERY_SHARD BATTERY_MANIFEST
SHARD_TSV="$REPO_ROOT/scripts/battery_shards.tsv"
SHARD_LABELS=""
SHARD_ALL=""
if [ -n "$MANIFEST" ]; then
  : > "$MANIFEST" || fail "could not truncate BATTERY_MANIFEST=$MANIFEST"
fi
if [ -n "$SHARD_SET" ]; then
  [[ "$SHARD_SPEC" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || fail "BATTERY_SHARD='$SHARD_SPEC' is not i/N (both positive integers)"
  shard_i="${BASH_REMATCH[1]}"; shard_n="${BASH_REMATCH[2]}"
  [ "$shard_i" -le "$shard_n" ] || fail "BATTERY_SHARD=$SHARD_SPEC names shard $shard_i of only $shard_n"
  [ -f "$SHARD_TSV" ] || fail "BATTERY_SHARD is set but $SHARD_TSV does not exist"
  # KEEP IN SYNC: shard_errors' `[1-9][0-9]*` row check in scripts/check_battery_suites.ts.
  SHARD_LABELS="$(awk -F'\t' -v i="$shard_i" -v n="$shard_n" '
    { sub(/\r$/, "") }
    /^#/ { next }
    NF != 3 || $1 !~ /^[1-9][0-9]*$/ || $2 !~ /^[0-9]+$/ || $3 == "" { print "malformed row " NR ": " $0 > "/dev/stderr"; bad = 1; next }
    { if ($1 + 0 > max) max = $1 + 0; if ($1 + 0 == i) print $3 }
    END {
      if (bad) exit 1
      if (max != n) { print "the tsv assigns shards 1.." max ", not 1.." n > "/dev/stderr"; exit 1 }
    }' "$SHARD_TSV")" || fail "BATTERY_SHARD=$SHARD_SPEC does not match $SHARD_TSV (see the lines above)"
  SHARD_ALL="$(awk -F'\t' '/^#/ { next } { sub(/\r$/, ""); print $3 }' "$SHARD_TSV")"
  echo "· battery shard $SHARD_SPEC: $(printf '%s\n' "$SHARD_LABELS" | grep -c .) suite(s) from $SHARD_TSV"
fi

# in_shard LABEL — true when no shard is selected, or the tsv assigns LABEL to this one.
in_shard() {
  [ -z "$SHARD_SET" ] && return 0
  # Refuse, don't skip, a label no shard owns: a call the static checker cannot parse would run nowhere.
  in_lines "$SHARD_ALL" "$1" || fail "suite '$1' has no row in $SHARD_TSV, so no CI shard runs it"
  in_lines "$SHARD_LABELS" "$1"
}

# Whole-line match without a pipe: under pipefail an early-exiting grep -q can fail the writer.
in_lines() {
  case $'\n'"$1"$'\n' in *$'\n'"$2"$'\n'*) return 0 ;; esac
  return 1
}

assert_copy_source() {
  bun -e "$(cat <<'TS'
import fs from "node:fs";
const { os_error_text, py_join } = await import(process.argv[1]);
const source = process.argv[2];
const die = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };
function refuse(path) {
  let link = false;
  try { link = fs.lstatSync(path).isSymbolicLink(); } catch {}
  if (link) die(`'${path}' is a symlink — refusing to copy it into the battery scratch tree`);
}
// os.walk(source, onerror=exit): refuse every entry of a directory before descending into it.
function walk(root) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (error) { die(os_error_text(error)); }
  const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
  const files = ents.filter((e) => !e.isDirectory()).map((e) => e.name);
  for (const entry of [...dirs, ...files]) refuse(py_join(root, entry));
  for (const dir of dirs) walk(py_join(root, dir));
}

refuse(source);
walk(source);
TS
)" "$REPO_ROOT/scripts/_py.ts" "$1"
}

# Rooms boot --hooksDir from a scratch COPY: PB watches its hooksDir, and macOS FSEvents
# re-delivers stale edits (made to the real pb_hooks by any other process) to each NEW
# watcher, restarting rooms mid-suite — the mid-battery connection-refused class.
assert_copy_source "$HOOKS_DIR" || exit 1
cp -R "$HOOKS_DIR" "$SCRATCH/pb_hooks" || fail "could not copy $HOOKS_DIR"
HOOKS_DIR="$SCRATCH/pb_hooks"
# Self-booting suites (tests/roomkit.ts hooks_dir) share this one copy instead of each
# making its own.
export PB_HOOKS_DIR="$HOOKS_DIR"

# ── Ensure the pinned binary is present (reuse repo copy, else download) ───────
pb_version_of() { "$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

ensure_binary() {
  local v
  # An inbound PB_BIN names a binary this script does not own: never download or chmod
  # over it, so a wrong version is a loud failure instead of a silent overwrite.
  if [ "$PB_BIN" != "$PB_BIN_DEFAULT" ]; then
    [ -x "$PB_BIN" ] || fail "PB_BIN=$PB_BIN is not an executable file"
    v="$(pb_version_of "$PB_BIN")"
    [ "$v" = "$PB_VERSION" ] || fail "PB_BIN=$PB_BIN is PocketBase '${v:-unknown}', want $PB_VERSION — point PB_BIN at a matching binary, or unset it to let this script manage $PB_BIN_DEFAULT"
    echo "· using PB_BIN=$PB_BIN ($v)"
    return
  fi
  if [ -x "$PB_BIN" ]; then
    v="$(pb_version_of "$PB_BIN")"
    if [ "$v" = "$PB_VERSION" ]; then echo "· using existing ./pocketbase ($v)"; return; fi
    echo "· existing ./pocketbase is $v, want $PB_VERSION — re-downloading"
  fi
  local os arch pkg
  case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) fail "unsupported OS $(uname -s)";; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64;; arm64|aarch64) arch=arm64;; *) fail "unsupported arch $(uname -m)";; esac
  pkg="pocketbase_${PB_VERSION}_${os}_${arch}.zip"
  echo "· downloading $pkg"
  curl -sL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/${pkg}" -o "$SCRATCH/pb.zip" \
    || fail "download failed"
  unzip -o "$SCRATCH/pb.zip" pocketbase -d "$REPO_ROOT" >/dev/null || fail "unzip failed"
  chmod +x "$PB_BIN"
}

# ── Migration COPIES — never point --migrationsDir at the tracked repo dir ────
LEGACY_MIGRATIONS="$SCRATCH/legacy_migrations"   # MFA excluded
HARD_MIGRATIONS="$SCRATCH/hard_migrations"       # full + scratch smtp->sink

# INODE compare, not path strings: `cp -R` copies a SYMLINK source AS a symlink (TASK-067
# incident), and realpath does not case-fold on APFS, so /Users/henry/Developer and
# /Users/henry/developer stringify differently while naming one directory. Exit 2 = refuse.
# Mode `copy` also rejects a symlinked ENTRY: `cat >` follows it back out of the scratch tree.
assert_scratch_migration_copy() {
  local target="$1" mode="${2:-copy}" rc
  bun -e "$(cat <<'TS'
import fs from "node:fs";
import path from "node:path";
const [target, tracked, mode] = process.argv.slice(1);
const stat = (p) => { try { return fs.statSync(p, { bigint: true }); } catch { return null; } };
const tracked_stat = stat(tracked);
if (tracked_stat === null) process.exit(0);
// os.path.realpath (non-strict): resolve the deepest existing ancestor, keep the missing tail.
let probe = path.resolve(target);
let tail = "";
while (stat(probe) === null && path.dirname(probe) !== probe) {
  tail = path.join(path.basename(probe), tail);
  probe = path.dirname(probe);
}
probe = path.join(fs.realpathSync(probe), tail);
while (true) {
  const s = stat(probe);
  if (s !== null && s.dev === tracked_stat.dev && s.ino === tracked_stat.ino) {
    process.stderr.write(`     resolved '${target}' -> ${probe} (same inode as ${tracked})\n`);
    process.exit(2);
  }
  const parent = path.dirname(probe);
  if (parent === probe) break;
  probe = parent;
}
process.exit(0);
TS
)" "$target" "$REPO_ROOT/pb_migrations" "$mode"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    [ "$mode" != copy ] || assert_copy_source "$target" || exit 1
    return 0
  fi
  [ "$rc" -eq 2 ] && fail "migration copy '$target' is the repo's own pb_migrations/ (or lives inside it) — refusing to write there"
  fail "could not resolve migration copy '$target' against $REPO_ROOT/pb_migrations"
}

build_migration_copies() {
  # $SCRATCH first: the cp below writes before any per-copy check could fire.
  assert_scratch_migration_copy "$SCRATCH" path || exit 1
  assert_copy_source "$REPO_ROOT/pb_migrations" || exit 1
  cp -R "$REPO_ROOT/pb_migrations" "$LEGACY_MIGRATIONS" || fail "could not copy migrations"
  # `|| exit 1` so an EXTRACTED fragment without the helper dies on 127 instead of falling
  # through to the destructive rm/cat — the script runs without `set -e`.
  assert_scratch_migration_copy "$LEGACY_MIGRATIONS" || exit 1
  local -a mfa
  mfa=("$LEGACY_MIGRATIONS"/$MFA_MIGRATION_GLOB)   # unquoted: this expansion IS the match
  [ -e "${mfa[0]}" ] || mfa=()                     # an unmatched glob expands to itself, not to nothing
  [ "${#mfa[@]}" -eq 1 ] \
    || fail "expected exactly one $MFA_MIGRATION_GLOB in the legacy copy, found ${#mfa[@]}: ${mfa[*]:-}"
  rm -f "${mfa[0]}"
  compgen -G "$LEGACY_MIGRATIONS/$MFA_MIGRATION_GLOB" >/dev/null \
    && fail "failed to drop MFA migration from legacy copy"

  cp -R "$REPO_ROOT/pb_migrations" "$HARD_MIGRATIONS" || fail "could not copy migrations"
  assert_scratch_migration_copy "$HARD_MIGRATIONS" || exit 1
  # Scratch migration (CI battery only, never committed).
  cat > "$HARD_MIGRATIONS/$SCRATCH_SMTP_MIGRATION" <<EOF
/// scratch (CI suite battery only) — point SMTP at the local sink so test_hardening
/// can read the _superusers OTP code back from PB_MAILDIR. Never committed to pb_migrations/.
migrate((app) => {
  const s = app.settings()
  s.smtp.enabled = true
  s.smtp.host = "127.0.0.1"
  s.smtp.port = ${HARD_SINK_PORT}
  s.smtp.tls = false
  s.smtp.username = ""
  s.smtp.password = ""
  app.save(s)
}, (app) => {})
EOF
}

# ── Room helpers ──────────────────────────────────────────────────────────────
# roomkit watches the room's liveness WHILE it polls: to a bare curl-poll a room that died
# on boot is indistinguishable from one still starting, so it burned the whole window and
# then reported a timeout instead of the exit status that explains it.
wait_health() {
  local port="$1" pid="$2" status
  bun "$REPO_ROOT/tests/roomkit.ts" --wait-health "$port" "$pid" 60 && return 0
  if kill -0 "$pid" 2>/dev/null; then
    fail "server on 127.0.0.1:${port} (pid ${pid}) is alive but never answered /api/health (log: $SCRATCH/pb-${port}.log)"
  fi
  # Only bash knows the exit status of its own background job; roomkit sees a bare pid.
  wait "$pid" 2>/dev/null; status=$?
  fail "server on 127.0.0.1:${port} (pid ${pid}) exited with status ${status} during boot (log: $SCRATCH/pb-${port}.log)"
}

# start_room PORT DATA_DIR MIG_DIR [env-args…] — env-args passed to `env` (KEY=VAL to set, -u KEY to strip); upserts dummy superuser then serves.
start_room() {
  local port="$1" dir="$2" migdir="$3"; shift 3
  # BEFORE the upsert: wait_health cannot tell our own room from a stranger's on this port.
  bun "$REPO_ROOT/tests/roomkit.ts" "$port" \
    || fail "port ${port} is held by another process — refusing to boot the room (see the roomkit message above; relocate with PB_PORT_OFFSET)"
  mkdir -p "$dir/storage"
  "$PB_BIN" superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" \
    --dir "$dir" --migrationsDir "$migdir" >/dev/null 2>&1 \
    || fail "superuser upsert failed for room $port"
  env "$@" "$PB_BIN" serve "--http=127.0.0.1:${port}" \
    --dir "$dir" --migrationsDir "$migdir" --hooksDir "$HOOKS_DIR" \
    >"$SCRATCH/pb-${port}.log" 2>&1 &
  ROOM_PIDS+=("$!")
  ROOM_PID="$!"
  wait_health "$port" "$ROOM_PID"
  # AFTER health: a stranger can still have taken the port between the preflight and our
  # bind, and a healthy answer alone never proves the responder is the pid we just started.
  bun "$REPO_ROOT/tests/roomkit.ts" --verify-room "$port" "$ROOM_PID" \
    || fail "room ${port} is not served by the process we launched (see the roomkit message above; log: $SCRATCH/pb-${port}.log)"
}

stop_room() {
  local pid="$1"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

start_sink() {   # start_sink SINK_PORT MAIL_DIR
  local port="$1" maildir="$2"
  mkdir -p "$maildir"
  SINK_PORT="$port" MAIL_DIR="$maildir" bun "$REPO_ROOT/scripts/smtp_sink.ts" \
    >"$SCRATCH/sink-${port}.log" 2>&1 &
  SINK_PIDS+=("$!")
  SINK_PID="$!"
  sleep 0.4
}

# Shared by seed_room + run_suite: the signatures a macOS hooksDir-watcher restart
# leaves on a client whose socket died under it (TASK-034; 'Invalid argument' =
# EINVAL from setsockopt on the dying socket).
FLAKE_PATTERN='ConnectionReset|Remote end closed|RemoteDisconnected|Connection refused|BadStatusLine|IncompleteRead|Invalid argument'

# seed_room PORT DIR MIGDIR — on a dropped-connection flake, REBUILD the room and
# re-seed once (TASK-034): seed.ts is not re-runnable against a half-seeded pb_data,
# so retrying the seed alone would trip over its own partial writes. Leaves ROOM_PID
# pointing at the room that actually serves the suite.
seed_room() {
  local port="$1" dir="$2" migdir="$3"
  PB_URL="http://127.0.0.1:$port" bun "$REPO_ROOT/scripts/seed.ts" >"$SCRATCH/seed-$port.log" 2>&1 && return 0
  if [ -z "${CI:-}" ] && grep -qiE "$FLAKE_PATTERN" "$SCRATCH/seed-$port.log"; then
    echo "⚠️  seed on room $port dropped its connection (macOS hooksDir flake, TASK-034) — rebuilding the room and retrying once…"
    stop_room "$ROOM_PID"
    rm -rf "$dir"
    start_room "$port" "$dir" "$migdir"
    # FSEvents replays the stale hook-edit to each NEW watcher too (proven by the
    # TASK-034 repro): give the replay 2s to restart the fresh room BEFORE seeding,
    # then re-confirm health so the retry seed runs against a settled server.
    sleep 2
    wait_health "$port" "$ROOM_PID"
    PB_URL="http://127.0.0.1:$port" bun "$REPO_ROOT/scripts/seed.ts" >"$SCRATCH/seed-$port.log" 2>&1 && return 0
  fi
  cat "$SCRATCH/seed-$port.log"; fail "seed failed against room $port"
}

# BELT-AND-BRACES: test_rules/test_task_rules/test_auth_rules/test_hooks each end in `if failures: … sys.exit(1)` and DO exit 1 on a failed check (mutation-measured) — the ❌ scan only catches a suite that prints a mismatch and still exits 0.
suite_is_red() {   # suite_is_red RC OUTPUT
  [ "$1" -ne 0 ] && return 0
  printf '%s' "$2" | grep -q '❌' && return 0
  return 1
}

# run_suite LABEL cmd… — fail-fast; retry ONCE locally on a dropped-connection flake.
run_suite() {
  local label="$1"; shift
  in_shard "$label" || return 0
  echo ""; echo "──────── SUITE: $label ────────"
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  printf '%s\n' "$out"
  if suite_is_red "$rc" "$out" && [ -z "${CI:-}" ] && \
     printf '%s' "$out" | grep -qiE "$FLAKE_PATTERN"; then
    echo "⚠️  $label dropped its connection mid-run (macOS hooksDir flake, plan R5) — retrying once…"
    out="$("$@" 2>&1)"; rc=$?
    printf '%s\n' "$out"
  fi
  suite_is_red "$rc" "$out" && fail "suite '$label' (rc=$rc; failed check(s) in output)"
  echo "✅ $label"
  if [ -n "$MANIFEST" ]; then
    printf '%s\n' "$label" >> "$MANIFEST" || fail "could not append '$label' to BATTERY_MANIFEST=$MANIFEST"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
echo "════════ suite battery: PocketBase v${PB_VERSION}, scratch=$SCRATCH ════════"
ensure_binary
[ -x "$PB_BIN" ] || fail "no PocketBase binary at $PB_BIN"
build_migration_copies

# ── legacy suites — each on its OWN freshly-booted, freshly-seeded MFA-excluded room ──
# NOT an optimization to collapse: PB's auth rate limiter lives in server memory and only a
# RESTART resets it, so a second suite sharing one room 429s on login (roomkit.token_of says so).
LEGACY_SUITES=(test_rules test_task_rules test_membership_rules test_hooks test_auth_rules test_files test_approval test_documents test_roles test_settings test_trash test_scope test_owner_transfer)
n=0
for suite in "${LEGACY_SUITES[@]}"; do
  n=$((n+1))
  # Before start_room: an out-of-shard suite must not cost a room boot and a seed.
  in_shard "$suite" || continue
  dir="$SCRATCH/legacy_${n}_${suite}"
  start_room "$LEGACY_PORT" "$dir" "$LEGACY_MIGRATIONS"
  seed_room "$LEGACY_PORT" "$dir" "$LEGACY_MIGRATIONS"
  # AFTER seed_room — its flake retry may have rebuilt the room under a new pid
  room_pid="$ROOM_PID"
  # PB_STORAGE_DIR is only read by test_files; harmless for the others.
  run_suite "$suite" env \
    "PB_URL=http://127.0.0.1:${LEGACY_PORT}" \
    "PB_STORAGE_DIR=${dir}/storage" \
    bun "tests/${suite}.ts"
  stop_room "$room_pid"
done

# ── email room — MFA-off copy + dummy RESEND so the boot hook wires Resend; test_email repoints smtp to the sink on 2526 ──
if in_shard test_email; then
echo ""; echo "──────── ROOM: email (${EMAIL_PORT}) ────────"
email_dir="$SCRATCH/email_room"
email_mail="$SCRATCH/email_mail"
start_sink "$EMAIL_SINK_PORT" "$email_mail"
start_room "$EMAIL_PORT" "$email_dir" "$LEGACY_MIGRATIONS" "RESEND_API_KEY=${DUMMY_RESEND_KEY}"
email_pid="$ROOM_PID"; email_sink_pid="$SINK_PID"
run_suite "test_email" env \
  "PB_URL=http://127.0.0.1:${EMAIL_PORT}" \
  "MAIL_DIR=${email_mail}" \
  "MAIL_SINK_PORT=${EMAIL_SINK_PORT}" \
  "RESEND_API_KEY=${DUMMY_RESEND_KEY}" \
  bun tests/test_email.ts
stop_room "$email_pid"; kill "$email_sink_pid" 2>/dev/null || true
fi

# ── hardening room — FULL (MFA-on) copy + scratch smtp->sink migration; boots WITHOUT RESEND_API_KEY so the boot hook no-ops ──
if in_shard test_hardening; then
echo ""; echo "──────── ROOM: hardening (${HARD_PORT}) ────────"
hard_dir="$SCRATCH/hard_room"
hard_mail="$SCRATCH/hard_mail"
start_sink "$HARD_SINK_PORT" "$hard_mail"
start_room "$HARD_PORT" "$hard_dir" "$HARD_MIGRATIONS" -u RESEND_API_KEY
hard_pid="$ROOM_PID"; hard_sink_pid="$SINK_PID"
run_suite "test_hardening" env \
  "PB_URL=http://127.0.0.1:${HARD_PORT}" \
  "PB_MAILDIR=${hard_mail}" \
  "PB_SINK_PORT=${HARD_SINK_PORT}" \
  bun tests/test_hardening.ts
stop_room "$hard_pid"; kill "$hard_sink_pid" 2>/dev/null || true
fi

# ── test_oauth — self-booting; strips GITHUB_CLIENT_ID/SECRET so its "UNSET" room genuinely sees them absent ──
run_suite "test_oauth" env -u GITHUB_CLIENT_ID -u GITHUB_CLIENT_SECRET bun tests/test_oauth.ts

# ── test_signup — self-booting; proves public signup + superuser approval gets the same
#    auto-provisioned workspace/project/user_settings shape a seeded user gets ──
run_suite "test_signup" bun tests/test_signup.ts

# ── test_app_admin_approval — self-booting; injects APP_ADMIN_EMAILS into its own server process ──
run_suite "test_app_admin_approval" bun tests/test_app_admin_approval.ts

# ── test_provision — self-booting since TASK-169 (own clean room; ignores PB_URL) ──
run_suite "test_provision" bun tests/test_provision.ts

# ── test_backups — self-booting; no S3 is dialled here (that's a separate standalone MinIO rehearsal) ──
run_suite "test_backups" bun tests/test_backups.ts

# ── test_file_storage — self-booting; wires settings.s3 (file storage) from env, no S3 dialled ──
run_suite "test_file_storage" bun tests/test_file_storage.ts

# ── test_observability — self-booting; asserts the alert self-test email and the perf indexes are present ──
run_suite "test_observability" bun tests/test_observability.ts

# ── test_inspire — self-booting; INSPIRE_UPSTREAM_URL aims the route at its own local stub, so this makes no outbound call ──
run_suite "test_inspire" bun tests/test_inspire.ts

# ── test_email_collision_audit — self-booting; proves the offline audit script against seeded legacy-shaped rows ──
run_suite "test_email_collision_audit" bun tests/test_email_collision_audit.ts

# ── vocabulary suites — self-booting (own clean room on a probe-band port, like test_oauth/test_backups above) ──
run_suite "test_labels"          bun tests/test_labels.ts
run_suite "test_statuses"        bun tests/test_statuses.ts
run_suite "test_item_keys"       bun tests/test_item_keys.ts
run_suite "test_vocab_flow"      bun tests/test_vocab_flow.ts
run_suite "test_vocab_upsert"    bun tests/test_vocab_upsert.ts
run_suite "test_workspace_save_tx"  bun tests/test_workspace_save_tx.ts
run_suite "test_priority_vocab"  bun tests/test_priority_vocab.ts
run_suite "test_fresh_workspace" bun tests/test_fresh_workspace.ts

# ── K5 cycles — self-booting (own clean room on an 8100+ port, not the probe band) ──
run_suite "test_cycles"          bun tests/test_cycles.ts

# ── relations — self-booting (own clean room) ──
run_suite "test_relations"       bun tests/test_relations.ts

# ── load smoke — self-booting (own clean room on 8098, the probe band); seeds a scaled dataset and measures the perf indexes ──
run_suite "load_smoketest"       bun scripts/load_smoketest.ts

# ── G2 collaboration suites — self-booting (own clean room on an 8100+ port) ──
run_suite "test_activity"                  bun tests/test_activity.ts
run_suite "test_comments"                  bun tests/test_comments.ts
run_suite "test_subscribers_notifications" bun tests/test_subscribers_notifications.ts
run_suite "test_notifications_trash_cascade" bun tests/test_notifications_trash_cascade.ts
run_suite "test_notifications_mentions"    bun tests/test_notifications_mentions.ts
run_suite "test_notifications_workspace"   bun tests/test_notifications_workspace.ts
run_suite "test_realtime"                  bun tests/test_realtime.ts
run_suite "test_collab_flow"               bun tests/test_collab_flow.ts

# ── G3 productivity suites — self-booting (own clean room on an 8100+ port) ──
run_suite "test_templates"          bun tests/test_templates.ts
run_suite "test_saved_views"        bun tests/test_saved_views.ts
run_suite "test_owner_defaults"     bun tests/test_owner_defaults.ts
run_suite "test_api_keys"           bun tests/test_api_keys.ts
run_suite "test_path_scope"         bun tests/test_path_scope.ts
run_suite "test_search"             bun tests/test_search.ts
run_suite "test_export"             bun tests/test_export.ts
run_suite "test_productivity_flow"  bun tests/test_productivity_flow.ts
run_suite "test_user_settings_font" bun tests/test_user_settings_font.ts
run_suite "test_user_settings_me"   bun tests/test_user_settings_me.ts
run_suite "test_write_hygiene"      bun tests/test_write_hygiene.ts
run_suite "test_signup_verification" bun tests/test_signup_verification.ts

# ── project_items view: rule equivalence with the four base collections, ordering, >200 paging.
run_suite "test_project_items_view" bun tests/test_project_items_view.ts

# ── 21e6: group counts computed inside PB in one query, rule-substitution visibility, filter safety.
run_suite "test_counts_route"       bun tests/test_counts_route.ts

# ── pb1e/dpn2: a member's project_items reads stay bounded as unrelated workspaces grow — self-booting.
run_suite "test_scale_membership"   bun tests/test_scale_membership.ts

# ── S-INVITE: the invite route is not an email oracle, and its createRule mirror is differential.
run_suite "test_invite_mirror"      bun tests/test_invite_mirror.ts

# ── I-INVITE: R1-R6 of decision:invitation-keyed-by-email's workspace_invitations flow, incl. every refusal path.
run_suite "test_invitations"        bun tests/test_invitations.ts
# ── I-INVITE: decision:invitation-send-limit-and-decline-block — the per-inviter daily invitation limit and decline suppression.
run_suite "test_invitation_limits"  bun tests/test_invitation_limits.ts

# ── security: tenant-anchor relations are immutable on update — self-booting (own clean room).
run_suite "test_rescope_guard"      bun tests/test_rescope_guard.ts

# ── security: trashed/draft records stay invisible on every read surface, cases derived from schema/.
run_suite "test_visibility_invariants" bun tests/test_visibility_invariants.ts

# ── decision:draft-private-publish-one-way: a draft reaches only its author, the owner and an active admin, and Publish is one-way.
run_suite "test_draft_publish"   bun tests/test_draft_publish.ts

# ── item writes: a project-only create takes its workspace from the project, and a draft write is a boolean that only ever publishes.
run_suite "test_item_write_refusals" bun tests/test_item_write_refusals.ts

# ── item list: the project_items list refuses a filter clause its field cannot answer and clamps its paging.
run_suite "test_item_list_filters"   bun tests/test_item_list_filters.ts

# ── security: a trashed workspace is unreadable but owner-enumerable and owner-restorable — self-booting.
run_suite "test_workspace_trash"    bun tests/test_workspace_trash.ts

# ── data integrity: a purged project leaves no child row pointing at it — self-booting.
run_suite "test_dangling_project"  bun tests/test_dangling_project.ts

# ── ux: a blocked sole owner is told a remedy that works, and the way out is walked end to end.
run_suite "test_account_deletion"   bun tests/test_account_deletion.ts

# ── validation: a whitespace-only name/title is refused on every create/update — self-booting.
run_suite "test_name_validation"    bun tests/test_name_validation.ts

# ── concurrency: a stale template/saved-view write is refused, never silently applied — self-booting.
run_suite "test_stale_write"        bun tests/test_stale_write.ts

# ── concurrency: parallel task creates get distinct ordinals, and a refused create claims none.
run_suite "test_ordinal"            bun tests/test_ordinal.ts

# ── platform: the HTTP status PocketBase itself answers each refusal shape with — self-booting.
run_suite "test_pb_refusal_statuses" bun tests/test_pb_refusal_statuses.ts

# ── agent probe: one normal member drives the API end to end, friction asserted as it behaves now — self-booting.
run_suite "test_agent_probe"        bun tests/test_agent_probe.ts

# ── operator tooling: the one-time project bulk loader (scripts/bulk_load_projects.ts) — self-booting.
run_suite "test_bulk_load_projects" bun tests/test_bulk_load_projects.ts

# ── ops: a refused boot names the cron VARIABLE, and a refusing migration exits non-zero and never binds — self-booting.
run_suite "test_boot_refusals"      bun tests/test_boot_refusals.ts

# ── decision:shadow-project: the per-workspace shadow project is invisible and holds every project-less item.
run_suite "test_shadow_project"     bun tests/test_shadow_project.ts

# ── ops: every pb_hooks file is LOADED in a booted room (PB serves on with one absent).
run_suite "test_hook_files_loaded"  bun tests/test_hook_files_loaded.ts

# ── ops: a mutation run cannot report a kill an unparseable mutant manufactured.
run_suite "test_mutation_proof"     bun tests/test_mutation_proof.ts

# ── integrity: serve re-asserts migration-defined field patterns; app_docs refuses unknown keys.
run_suite "test_app_docs_schema_guards" bun tests/test_app_docs_schema_guards.ts

# ── integrity: re-applying the generated app_docs seed changes no row (its comment's claim).
run_suite "test_app_docs_seed_idempotent" bun tests/test_app_docs_seed_idempotent.ts

# ── serverless proofs of the gate scripts and the shared libraries they lean on; make
#    check-static runs the gates themselves (generators --check, scripts/check_*.ts).
run_suite "test_app_docs_quotes_checker" bun tests/test_app_docs_quotes_checker.ts
run_suite "test_constants_checker" bun tests/test_constants_checker.ts
run_suite "test_check_pb_pin" bun tests/test_check_pb_pin.ts
run_suite "test_gate_reconciler_shapes" bun tests/test_gate_reconciler_shapes.ts
run_suite "test_room_preflight_checker" bun tests/test_room_preflight_checker.ts
run_suite "test_superuser_before_serve_checker" bun tests/test_superuser_before_serve_checker.ts
run_suite "test_rule_guard_checker" bun tests/test_rule_guard_checker.ts
run_suite "test_roomkit_creds" bun tests/test_roomkit_creds.ts
run_suite "test_make_targets" bun tests/test_make_targets.ts
run_suite "test_verification_environment" bun tests/test_verification_environment.ts
run_suite "test_battery_copy" bun tests/test_battery_copy.ts
run_suite "test_pb_migrate" bun tests/test_pb_migrate.ts
run_suite "test_tierkit" bun tests/test_tierkit.ts
run_suite "test_script_help" bun tests/test_script_help.ts
run_suite "test_gen_gitattributes" bun tests/test_gen_gitattributes.ts
run_suite "test_gen_decisions" bun tests/test_gen_decisions.ts
run_suite "test_decision_citations_checker" bun tests/test_decision_citations_checker.ts
run_suite "test_check_migration_citations" bun tests/test_check_migration_citations.ts
run_suite "test_migration_settings_keys" bun tests/test_migration_settings_keys.ts
run_suite "test_port_collisions_checker" bun tests/test_port_collisions_checker.ts
run_suite "test_app_docs_history_checker" bun tests/test_app_docs_history_checker.ts
run_suite "test_rescope_guard_checker"  bun tests/test_rescope_guard_checker.ts
run_suite "test_membership_status_checker" bun tests/test_membership_status_checker.ts
run_suite "test_view_within_list_checker" bun tests/test_view_within_list_checker.ts
run_suite "test_fixture_project_resolve_checker" bun tests/test_fixture_project_resolve_checker.ts
run_suite "test_app_docs_down_up_checker" bun tests/test_app_docs_down_up_checker.ts
run_suite "test_historical_migration_guard" bun tests/test_historical_migration_guard.ts
run_suite "test_keep_in_sync_checker" bun tests/test_keep_in_sync_checker.ts
run_suite "test_py_helpers" bun tests/test_py_helpers.ts
run_suite "test_argparse" bun tests/test_argparse.ts
run_suite "test_ts_source" bun tests/test_ts_source.ts
# ── guard: the repo's real pb_migrations/ and scripts/ must be untouched by the battery ──
echo ""; echo "──────── repo cleanliness guard ────────"
dirty_mig="$(tree_state pb_migrations/)"
if [ "$dirty_mig" != "$MIG_STATUS_BEFORE" ]; then
  diff <(printf '%s\n' "$MIG_STATUS_BEFORE") <(printf '%s\n' "$dirty_mig") | grep '^>' || true
  fail "a clean room wrote into pb_migrations/ during the battery"
fi
echo "✅ pb_migrations/ unchanged by the battery"
dirty_scripts="$(git -C "$REPO_ROOT" status --porcelain scripts/mail scripts/*.eml 2>/dev/null)"
[ -z "$dirty_scripts" ] || { echo "$dirty_scripts"; fail "captured mail leaked into scripts/"; }
echo "✅ no captured mail in scripts/"
dirty_model="$(tree_state scripts/model/current/)"
if [ "$dirty_model" != "$MODEL_STATUS_BEFORE" ]; then
  diff <(printf '%s\n' "$MODEL_STATUS_BEFORE") <(printf '%s\n' "$dirty_model") || true
  fail "the battery changed model/current/ — extract_current.ts's rewrite does not match the pre-run tree (stale committed files, or it clobbered a working-tree edit)"
fi
echo "✅ model/current/ unchanged by the battery"

echo ""
if [ -n "$SHARD_SET" ]; then
  echo "════════ ✅ SUITE BATTERY SHARD $SHARD_SPEC GREEN — every suite scripts/battery_shards.tsv assigns to it passed ════════"
else
  echo "════════ ✅ SUITE BATTERY GREEN — all suites passed ════════"
fi

#!/usr/bin/env bash
# Replays the current migration set, hooks on, over a production backup zip (newest in the bucket, or --zip).
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: replay_backup.sh [--zip PATH] [--migrations-dir DIR] [--max-age-days N]
       replay_backup.sh --newest-key [--max-age-days N] [--now EPOCH] < listing.xml

  --zip PATH           replay a local PocketBase backup zip (no network)
  --migrations-dir DIR migrations to replay (default: pb_migrations in the repo root)

  --max-age-days N     refuse a newest bucket backup older than N days (default PB_BACKUPS_MAX_AGE_DAYS, else 2)
  --newest-key         parse-only: read an S3 listing on stdin, print "<LastModified> <Key>" of the newest
                       .zip, exit 1 if it is stale or absent (--now EPOCH pins the clock)

Without --zip, downloads the newest zip from the backups bucket. Needs PB_BACKUPS_S3_BUCKET,
PB_BACKUPS_S3_ENDPOINT, PB_BACKUPS_S3_REGION, PB_BACKUPS_S3_ACCESS_KEY, PB_BACKUPS_S3_SECRET.
PB_BIN overrides the binary (default ./pocketbase). Exit 0 = the set applies to that data.
USAGE
}

ZIP=""
MIG=""
PARSE_ONLY=""
NOW=""
MAX_AGE="${PB_BACKUPS_MAX_AGE_DAYS:-2}"
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --zip) ZIP="${2:?--zip needs a path}"; shift 2 ;;
    --migrations-dir) MIG="${2:?--migrations-dir needs a path}"; shift 2 ;;
    --max-age-days) MAX_AGE="${2:?--max-age-days needs a number}"; shift 2 ;;
    --newest-key) PARSE_ONLY=1; shift ;;
    --now) NOW="${2:?--now needs epoch seconds}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# No leading zeros: bash arithmetic would read 08 as a bad octal and 010 as 8.
[[ "$MAX_AGE" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "max age must be whole days: $MAX_AGE" >&2; exit 1; }
[[ -z "$NOW" || "$NOW" =~ ^[0-9]+$ ]] || { echo "--now must be epoch seconds: $NOW" >&2; exit 1; }

# Newest = greatest LastModified among the .zip keys, whatever the key is named; reads a listing on stdin.
newest_line() {
  sed 's/<Contents>/\n/g' \
    | { sed -n 's/.*<Key>\([^<]*\.zip\)<\/Key>.*<LastModified>\([^<]*\)<\/LastModified>.*/\2 \1/p' || true; } \
    | sort | tail -n 1
}

# Liveness gate: a backup cron that silently stopped must turn this red. $1 = "<LastModified> <Key>".
check_fresh() {
  local when="${1%% *}" key="${1#* }" then_s now_s age_s
  then_s=$(date -u -d "$when" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$when" +%s)
  now_s="${NOW:-$(date -u +%s)}"
  age_s=$((now_s - then_s))
  if [[ "$age_s" -gt $((MAX_AGE * 86400)) ]]; then
    echo "newest backup $key is more than $MAX_AGE days old ($((age_s / 3600)) hours): backups have stopped" >&2
    exit 1
  fi
}

if [[ -n "$PARSE_ONLY" ]]; then
  LINE=$(newest_line)
  [[ -n "$LINE" ]] || { echo "no .zip backup found in listing" >&2; exit 1; }
  echo "$LINE"
  check_fresh "$LINE"
  exit 0
fi

[ -z "$ZIP" ] || ZIP="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"
cd "$(dirname "$0")/.."
PB_BIN="${PB_BIN:-./pocketbase}"
MIG="${MIG:-pb_migrations}"
[ -x "$PB_BIN" ] || { echo "PB_BIN is not an executable: $PB_BIN (run make pocketbase)" >&2; exit 1; }
[ -d "$MIG" ] || { echo "migrations dir not found: $MIG" >&2; exit 1; }

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

if [ -z "$ZIP" ]; then
  BUCKET="${PB_BACKUPS_S3_BUCKET:?}"
  ENDPOINT="${PB_BACKUPS_S3_ENDPOINT:?}"
  REGION="${PB_BACKUPS_S3_REGION:?}"
  CREDS="${PB_BACKUPS_S3_ACCESS_KEY:?}:${PB_BACKUPS_S3_SECRET:?}"
  SIGV4="aws:amz:${REGION}:s3"
  # shortcut: one list page (1000 keys), fine while the cron's cronMaxKeep keeps the bucket small.
  LINE=$(curl -fsS --user "$CREDS" --aws-sigv4 "$SIGV4" "$ENDPOINT/$BUCKET/?list-type=2" | newest_line)
  [[ -n "$LINE" ]] || { echo "no .zip backup found in bucket $BUCKET" >&2; exit 1; }
  check_fresh "$LINE"
  KEY="${LINE#* }"
  echo "newest backup: $KEY"
  ZIP="$SCRATCH/backup.zip"
  # A literal @ can 403 on signed requests; the encoded form is the safe one.
  curl -fsS --user "$CREDS" --aws-sigv4 "$SIGV4" -o "$ZIP" "$ENDPOINT/$BUCKET/${KEY//@/%40}"
fi

[ -f "$ZIP" ] || { echo "zip not found: $ZIP" >&2; exit 1; }
DATA="$SCRATCH/pb_data"
mkdir "$DATA"
unzip -q "$ZIP" -d "$DATA"
[ -f "$DATA/data.db" ] || { echo "no data.db at the root of $ZIP" >&2; exit 1; }

# KEEP IN SYNC: Dockerfile CMD preflight, same `migrate up` and `--hooksDir`; the env -u list differs, so no S3 secret reaches PB.
# The S3 hooks arm themselves from those vars. Log only migration names and a refusal's first line: PB's full output can carry production field values.
if OUT=$(env -u PB_BACKUPS_S3_BUCKET -u PB_BACKUPS_S3_ENDPOINT -u PB_BACKUPS_S3_REGION \
  -u PB_BACKUPS_S3_ACCESS_KEY -u PB_BACKUPS_S3_SECRET \
  -u PB_FILES_S3_BUCKET -u PB_FILES_S3_ENDPOINT -u PB_FILES_S3_REGION \
  -u PB_FILES_S3_ACCESS_KEY -u PB_FILES_S3_SECRET \
  "$PB_BIN" migrate up --dir "$DATA" --migrationsDir "$MIG" --hooksDir pb_hooks 2>&1); then
  { grep '^Applied ' <<<"$OUT" || true; }
  echo "replay OK: the migration set applies to this backup"
else
  head -n 1 <<<"$OUT" >&2
  echo "REPLAY REFUSED: the migration set does not apply to this backup" >&2
  exit 1
fi

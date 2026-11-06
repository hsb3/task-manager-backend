#!/usr/bin/env bash
# Replays the current migration set, hooks on, over a production backup zip (newest in the bucket, or --zip).
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: replay_backup.sh [--zip PATH] [--migrations-dir DIR]

  --zip PATH           replay a local PocketBase backup zip (no network)
  --migrations-dir DIR migrations to replay (default: pb_migrations in the repo root)

Without --zip, downloads the newest zip from the backups bucket. Needs PB_BACKUPS_S3_BUCKET,
PB_BACKUPS_S3_ENDPOINT, PB_BACKUPS_S3_REGION, PB_BACKUPS_S3_ACCESS_KEY, PB_BACKUPS_S3_SECRET.
PB_BIN overrides the binary (default ./pocketbase). Exit 0 = the set applies to that data.
USAGE
}

ZIP=""
MIG=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --zip) ZIP="${2:?--zip needs a path}"; shift 2 ;;
    --migrations-dir) MIG="${2:?--migrations-dir needs a path}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

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
  # Newest = greatest LastModified among the .zip keys, whatever the key is named.
  KEY=$(curl -fsS --user "$CREDS" --aws-sigv4 "$SIGV4" "$ENDPOINT/$BUCKET/?list-type=2" \
    | sed 's/<Contents>/\n/g' \
    | { sed -n 's/.*<Key>\([^<]*\.zip\)<\/Key><LastModified>\([^<]*\)<\/LastModified>.*/\2 \1/p' || true; } \
    | sort | tail -n 1 | cut -d' ' -f2-)
  [ -n "$KEY" ] || { echo "no .zip backup found in bucket $BUCKET" >&2; exit 1; }
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

# Same shape as the Dockerfile preflight; no S3 secret may reach PB (backups.pb.js and files.pb.js would arm S3).
if OUT=$(env -u PB_BACKUPS_S3_BUCKET -u PB_BACKUPS_S3_ENDPOINT -u PB_BACKUPS_S3_REGION \
  -u PB_BACKUPS_S3_ACCESS_KEY -u PB_BACKUPS_S3_SECRET \
  -u PB_FILES_S3_BUCKET -u PB_FILES_S3_ENDPOINT -u PB_FILES_S3_REGION \
  -u PB_FILES_S3_ACCESS_KEY -u PB_FILES_S3_SECRET \
  "$PB_BIN" migrate up --dir "$DATA" --migrationsDir "$MIG" --hooksDir pb_hooks 2>&1); then
  echo "$OUT"
  echo "replay OK: the migration set applies to this backup"
else
  echo "$OUT"
  echo "REPLAY REFUSED: the migration set does not apply to this backup" >&2
  exit 1
fi

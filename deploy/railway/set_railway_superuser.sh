#!/usr/bin/env bash
# set_railway_superuser.sh — reviewable wrapper for setting a Railway environment's PocketBase superuser; avoids a password hitting shell history.
# LOAD-BEARING: must use `railway ssh`, not `railway run` — `railway run` executes locally, and /pb/pocketbase only exists inside the container.
# KEEP IN SYNC: --dir /pb/pb_data must match the Dockerfile CMD.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: set_railway_superuser.sh {update|create} <email> <password> --env <environment> [--dry-run|-n]

  update    rotate/set the superuser's password (ROTATES tokenKey —
            logs out existing superuser sessions; MFA still applies at login)
  create    bootstrap the superuser only if it does not already exist

  --env <environment>   REQUIRED for a real run — exactly 'production', the only
            standing environment; never trust the CLI's linked environment
  --dry-run, -n   print the command shape (password masked) without running it
EOF
}

dry_run=0
environment=""
subcommand=""
email=""
password=""
positional=()

expect_env=0
for arg in "$@"; do
  if [[ "$expect_env" -eq 1 ]]; then
    environment="$arg"
    expect_env=0
    continue
  fi
  case "$arg" in
    --dry-run|-n)
      dry_run=1
      ;;
    --env)
      expect_env=1
      ;;
    --env=*)
      environment="${arg#--env=}"
      ;;
    *)
      positional+=("$arg")
      ;;
  esac
done

if [[ "${#positional[@]}" -ge 1 ]]; then
  subcommand="${positional[0]}"
fi
if [[ "${#positional[@]}" -ge 2 ]]; then
  email="${positional[1]}"
fi
if [[ "${#positional[@]}" -ge 3 ]]; then
  password="${positional[2]}"
fi

if [[ "$subcommand" != "update" && "$subcommand" != "create" ]]; then
  echo "error: subcommand must be exactly 'update' or 'create'" >&2
  usage
  exit 2
fi

if [[ -z "$email" || -z "$password" ]]; then
  echo "error: <email> and <password> are both required" >&2
  usage
  exit 2
fi

# Validated even in dry-run so a typo surfaces before the real invocation. There is
# no default: an unrecognised environment must never silently resolve to production.
if [[ -n "$environment" && "$environment" != "production" ]]; then
  echo "error: unrecognised environment '$environment' — must be 'production'" >&2
  usage
  exit 2
fi

env_label="${environment:-<--env required for real run>}"
masked_cmd=(railway ssh --service pocketbase --environment "$env_label" /pb/pocketbase superuser "$subcommand" "$email" '****' --dir /pb/pb_data)

if [[ "$subcommand" == "update" ]]; then
  echo "WARNING: 'update' INTENTIONALLY rotates the superuser tokenKey (wave-16" >&2
  echo "superuser semantics) — this LOGS OUT every existing superuser session." >&2
fi
echo "WARNING: MFA STILL APPLIES at dashboard login: after this, login is" >&2
echo "password -> emailed 8-digit OTP as a second factor." >&2

if [[ "$dry_run" -eq 1 ]]; then
  echo "[dry-run] would run: ${masked_cmd[*]}"
  exit 0
fi

if [[ -z "$environment" ]]; then
  echo "error: --env <environment> is required for a real run (production)" >&2
  usage
  exit 2
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "error: 'railway' CLI not found on PATH — cannot run for real" >&2
  exit 1
fi

echo "running: ${masked_cmd[*]}" >&2
railway ssh --service pocketbase --environment "$environment" /pb/pocketbase superuser "$subcommand" "$email" "$password" --dir /pb/pb_data

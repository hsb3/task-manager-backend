#!/usr/bin/env bash
# PreToolUse hook: repo law — never edit historical migrations (pb_migrations/ files already on origin/main).
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[[ -z "$file" ]] && exit 0

case "$file" in
  *pb_migrations/*) ;;
  *) exit 0 ;;
esac

# git computes the repo-relative prefix itself — string-comparing paths breaks on
# macOS case-insensitive spellings (/Users/henry/developer/… vs …/Developer/…).
dir=$(dirname "$file")
prefix=$(git -C "$dir" rev-parse --show-prefix 2>/dev/null) || exit 0
# Exactly the repo's own pb_migrations/ — scratch-copy rooms (outside the repo, or
# nested elsewhere inside it) fall through and stay editable.
[[ "$prefix" == "pb_migrations/" ]] || exit 0
rel="pb_migrations/$(basename "$file")"

ref=origin/main
git -C "$dir" rev-parse --verify --quiet "$ref" >/dev/null || ref=main
git -C "$dir" rev-parse --verify --quiet "$ref" >/dev/null || exit 0

git -C "$dir" cat-file -e "$ref:$rel" 2>/dev/null || exit 0

# KEEP IN SYNC: the comment-only predicate lives once, behind `--tool-input` in scripts/check_historical_migrations.ts
# (lefthook.yml's pre-commit --staged mode is the other caller) — never re-inline it here.
root=$(git -C "$dir" rev-parse --show-toplevel)
# The checker prints the WHOLE actionable message, because it alone knows which state
# (armed / decision:project-items-membership-denormalised suspension / expired) it is in — nothing is appended here.
# It runs in the edited file's repo, so the state is that repo's and not the agent's cwd.
if verdict=$(printf '%s' "$input" | (cd "$root" && bun scripts/check_historical_migrations.ts --tool-input) 2>/dev/null); then
  # stdout on exit 0: the harness may swallow stderr, and a suspended allow must be announced.
  if [[ -n "$verdict" ]]; then echo "$verdict"; fi
  exit 0
fi

echo "${verdict:-Blocked: $rel exists on $ref and scripts/check_historical_migrations.ts did not run — historical migrations are never edited (CLAUDE.md migration law).}" >&2
exit 2

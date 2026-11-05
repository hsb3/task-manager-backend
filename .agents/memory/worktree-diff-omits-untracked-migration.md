---
name: worktree-diff-omits-untracked-migration
description: "git diff main from a worktree builder omits its NEW untracked migration; patch it in and copy untracked files, or the migration ships missing and schema --check fails"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10b87fa2-190d-42db-b4a8-0a7ec96c16ce
  modified: 2026-08-18T23:05:47.996Z
---

Root integrates a worktree builder's work by `git -C <wt> diff main > patch` then `git apply`.
**`git diff` only shows TRACKED changes** — a builder's brand-new `pb_migrations/*.js` (and any
other new file) is UNTRACKED in its worktree, so the patch silently omits it. The schema/openapi
regens the builder committed to the diff then have no migration to derive from, and root's
`make dod` fails `gen_schema --check` ("schema/X.rules.json out of date with pb_migrations") — the
schema files describe a migration that isn't in the tree.

**On PBTT-427 (2026-08-18) this shipped the guard's schema changes without the migration itself.**
Caught only by running `make dod` on the assembled branch, not by the apply.

Fix when integrating a worktree lane: after `git apply`, `git -C <wt> status --porcelain
--untracked-files=all | grep '^??'` and `cp` every untracked file the change needs (migrations,
new tests, new scripts). Then re-run the regens and `make dod`. Related: the model-cleanliness
battery guard only passes once root COMMITS the regenerated `scripts/model/current/*.yml` (a
worker can't commit), so a pre-commit `make dod` shows one benign ❌ on that guard — commit, then
re-run for the authoritative green. That guard compares against COMMITTED state, so it fails
loudly as if the work were broken: read WHICH check failed before believing the work is red.

**The apply itself can run in the wrong tree.** The Bash tool's cwd persists, so a `git apply`
issued after a `cd` into the worktree runs INSIDE it, where the patch is already applied; it fails
with "patch does not apply" and reads like a conflict (bit three times on 2026-08-10). Harvest with
`git -C <worktree> diff > p.patch` and apply with `git -C <main-checkout> apply p.patch`. See [[dod-exit-sentinel-not-completion]],
[[worktree-locked-not-stale]], [[never-write-in-a-live-agents-worktree]].

---
name: never-symlink-into-a-worktree
description: A symlinked pb_migrations/pb_hooks inside a worktree gets copied AS a symlink by the e2e clean-room helper, whose rmSync then deletes real files through it; copy scratch dirs, never link them into a tree
metadata:
  type: project
---

An auditor symlinked its scratch `pb_migrations` at the audited worktree so the web unit suite could
resolve `REPO_ROOT` (2026-09-07, bxz9 audit). `web/e2e/support/clean-room.ts` copies the source
with `cpSync({recursive: true})`, which copies a symlink as a symlink, and its `rmSync` then deleted
the real `v1:1785151700_superuser_mfa.js` through it while a root `make dod` was live in that tree, so
every room that gate built afterwards lacked superuser MFA and the run had to be thrown away.

**Why:** the battery's shell copy guards its `rm -f` with `assert_scratch_migration_copy`; the TS
twin has no guard and no `dereference: true` (card 6b3m).

**How to apply:** scratch copies are COPIES (`cp -R`), never links, and nothing is linked into a
worktree or the main checkout; a worker that needs a repo-shaped tree copies the whole worktree.
The common lane brief now says so. Related: [[never-write-in-a-live-agents-worktree]].

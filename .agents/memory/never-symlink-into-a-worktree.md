---
name: never-symlink-into-a-worktree
description: A symlinked pb_migrations/pb_hooks inside a worktree gets copied AS a symlink by a TS clean-room copy, whose rmSync then deletes real files through it; copy scratch dirs, never link them into a tree
metadata:
  type: project
---

An auditor symlinked its scratch `pb_migrations` at the audited worktree (2026-09-07, bxz9 audit).
The e2e clean-room helper (not carried here) copied the source with `cpSync({recursive: true})`,
which copies a symlink as a symlink, and its `rmSync` then deleted the real superuser MFA
migration (now `v2:1785185400_superuser_mfa.js`) through it while a root gate was live in that tree, so
every room that gate built afterwards lacked superuser MFA and the run had to be thrown away.

**Why:** the battery's shell copy guards its `rm -f` with `assert_scratch_migration_copy`;
`tests/roomkit.ts`'s `hooks_dir` has no guard, and its `cpSync({dereference: true})` still copies a
symlinked entry as a symlink (`node-cpsync-dereference-skips-entries.md`).

**How to apply:** scratch copies are COPIES (`cp -R`), never links, and nothing is linked into a
worktree or the main checkout; a worker that needs a repo-shaped tree copies the whole worktree.

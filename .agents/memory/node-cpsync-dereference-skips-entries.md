---
name: node-cpsync-dereference-skips-entries
description: "Node's fs.cpSync({recursive, dereference:true}) still copies a symlinked ENTRY as a symlink (measured Node v26.4.0), so a \"self-contained\" scratch copy can write through to the real tree; refuse symlinks explicitly (web/e2e/support/clean-room.ts copyTree)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 599c7ed9-c0d3-4c9a-8e82-b3420574c32a
  modified: 2026-09-08T16:35:17.484Z
---

Measured 2026-09-08 (lane T3, card cbbx) on Node v26.4.0: `cpSync(src, dest, { recursive:
true, dereference: true })` dereferences a symlinked ROOT but copies a symlinked entry inside
the tree AS a symlink. A clean room that copies `pb_migrations/` that way and then lets
PocketBase write into its `--migrationsDir` follows the entry back out of the scratch tree
into the repo. Python's `shutil.copytree` does dereference entries, so `tests/roomkit.py`
has no such hole.

**Why:** the option's name promises what it does not do, and the copy looks complete until
a write lands in the wrong place.

**How to apply:** never rely on `dereference` for isolation. Walk the tree with
`readdirSync(recursive: true, withFileTypes: true)` and refuse any `isSymbolicLink()`
entry by name, as `copyTree` in `web/e2e/support/clean-room.ts` does (KEEP IN SYNC with the
battery's `assert_scratch_migration_copy`). Related: [[never-symlink-into-a-worktree]],
[[never-write-in-a-live-agents-worktree]].

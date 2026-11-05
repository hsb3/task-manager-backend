---
paths:
  - "pb_hooks/**"
  - "pb_migrations/**"
  - "tests/**"
  - "schema/**"
---

# PocketBase gotchas (these bite; pinned v0.40.4, each measured on the version it names)

- `@request.body`, NOT `@request.data` (silent failure).
- Rule status idiom: list-filtered→200 empty · view/update/delete denied→404 ·
  create denied→400 · null rule/authRule→403.
- createRule evaluates SUBMITTED data BEFORE create-hook mutations — a rule keyed on
  a hook-filled relation needs a dual path (see tasks createRule). `field = ""` IS
  valid empty-relation syntax in rules.
- Pooled JSVM: hooks cannot share top-level functions/constants across callbacks —
  INLINE per site with `// KEEP IN SYNC:` comments (check_constants gates drift).
- View collections: no realtime events (clients recompute on `tasks` events; never
  subscribe to `project_stats`); view column ids (`_clone_*`) regenerate per boot —
  never diff or reference them.
- Custom routes BYPASS collection rules — handlers must scope by `e.auth` themselves.
- `expand` silently omits unviewable records. DELETE success = 204 empty body.
  JSON-array filters need `?~`. `users.email` hidden on others' records — resolve
  fixtures by `name`.
- `migrate down`/`migrate collections` prompt y/N — pipe `printf 'y\n' |`.
- A migration CANNOT change a field's type in place — applies without error, changes
  NOTHING. Recipe: add new field → copy rows → detach any view referencing the old
  column → remove old + rename (worked example collapsed by decision-069's baseline
  rebuild — `git show migrations-v1:pb_migrations/1785152200_tasks_vocab.js`).
- A migration citation is written `v1:FILE` (resolves via
  `git show migrations-v1:pb_migrations/FILE`) or `v2:FILE` (the current tree).
- Hook read-then-write races under parallel requests (SQLite single-writer serializes
  the COMMIT, not your read) — use one atomic `UPDATE … RETURNING` via e.app.db() + a
  UNIQUE index (see tasks.seq / workspaces.seq_counter).
- `e.auth` is undefined in `After*Success` hooks — capture actor in the `*Request` hook
  BEFORE `e.next()` and use it there (see `activity.pb.js`, `trash.pb.js`, `realtime.pb.js`).
- `onRecord*Request` hooks are Request-scoped — they do NOT fire for programmatic
  `$app.delete()`/`e.app.save()` calls (cron jobs, custom route handlers calling the
  Go/JS API directly), only for HTTP-request-triggered writes. Anything that must fire
  for BOTH paths (e.g. a realtime broadcast on delete) belongs on the universal
  `onRecord*AfterSuccess` hook (see `pb_hooks/realtime.pb.js`, TASK-008.08 — a purge
  via the 30-day trash cron silently never fired the old *Request-hook broadcast).
- The converse trap: a UNIVERSAL `onRecord*` hook DOES fire for a migration's own
  `e.app.save()` on the `serve` boot path, and throwing there aborts the whole boot
  (`failed to apply migration …`). A strict validation/lock that must never refuse a
  backfill's writes belongs on the `*Request` tier (see `pb_hooks/keys.pb.js`
  `refuseSubmittedItemKey`, PBTT-487 — the universal placement cost a full build cycle).
- The handler-object registration FORM `$app.onRecordCreateRequest().bind({ id, priority, func })`
  panics PB 0.39.9 under concurrent creates (not re-measured on 0.40.4): the callback is invoked with NO event (`e` is
  undefined), the panic lands mid-create, and items commit unkeyed. Proven with a body that
  reads nothing (wave v7 lane B5, 2026-09-09: 3/3 attempts panicked within 2 rounds of 20
  barrier-released creates; the plain `onRecordCreateRequest(fn, ...)` form ran 1200 clean).
  The same holds on update and delete, so every hook registers in the plain form; the plain form
  has no priority, so an order that must hold across FILES is made inside the file that ends the
  chain (trash.pb.js registers its stale-write-key refusal above its noContent arms). Accepted
  cost: a write that is both stale and invalid gets the 409 or the validation 400 depending on
  the boot; either way nothing is written.
- The `$app`-prefixed registration form (`$app.onRecordCreateRequest(fn, "app_docs")`) also
  silently registers nothing on 0.40.4: clean boot, no `failed to execute` line, the refusal
  never fires, and a logger call as the handler's first statement never reaches `/api/logs` —
  the handler is never entered. Use the bare `onRecordCreateRequest(fn, ...)` form.
- `e.app = txApp` inside a `*Request` hook ESCAPES the request in the pooled JSVM: other
  in-flight requests see the transactional app before the `finally` restores it, so a
  "transactional cascade" produced 204s with no cascade, 400s with a full cascade, and
  `transaction has already been committed` on unrelated creates (8-way, lane B5). Never mutate
  a shared event property to pull `e.next()` into a transaction; consolidate on
  `onRecordAfterUpdateSuccess` and accept no atomicity, or wait for a PB-level mechanism (6f1x).
- Custom `subscriptionsBroker()` topics (a string that isn't a real collection name) are
  NOT rule-checked by PB — any authenticated client can subscribe to any topic string
  unless an `onRealtimeSubscribeRequest` hook explicitly authorizes it. A per-tenant
  topic NAME (`rt:project_items:{workspaceId}`) is not enforcement; the subscribe guard
  is (see `pb_hooks/realtime.pb.js`, TASK-008.08 — a real cross-tenant leak caught in
  review).

# Test-suite authoring pattern (house style)

One suite per collection/flow in `tests/test_<x>.ts`: boots its own clean room (copy,
correct port band), seeds fixtures by name, probes the FULL role matrix
(owner/admin/member/non-member/anon) using the status idiom above, prints ✅/❌ per
check, and self-gates (sys.exit non-zero on any failure). The battery flags ❌
glyphs as belt-and-braces. Prove claims against the running server — docs and app_docs
state only what a test or live call demonstrated.

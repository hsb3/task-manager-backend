---
paths:
  - "pb_hooks/**"
  - "pb_migrations/**"
  - "tests/**"
  - "schema/**"
---

# PocketBase gotchas specific to this repo's hooks (pinned v0.40.4, each measured on the version it names)

The generic PocketBase traps (status codes, custom routes bypassing rules, `expand`, view
collections, request-scoped hooks, read-then-write races, realtime topics) are in the
pocketbase plugin's field notes; what follows is what this repo's hooks add.

- `@request.body`, NOT `@request.data` (silent failure).
- Rule status idiom: list-filtered→200 empty · view/update/delete denied→404 ·
  create denied→400 · null rule/authRule→403.
- createRule evaluates SUBMITTED data BEFORE create-hook mutations — a rule keyed on
  a hook-filled relation needs a dual path (see tasks createRule). `field = ""` IS
  valid empty-relation syntax in rules.
- Pooled JSVM: hooks cannot share top-level functions/constants across callbacks —
  INLINE per site with `// KEEP IN SYNC:` comments (check_constants gates drift). A fact inlined
  at several sites of ONE file marks each site `// KEEP IN SYNC (below):`, so check_keep_in_sync
  reads that file's side from the lines under the marker, not from any other site; a plain
  marker whose literal recurs in its own file is refused.
- Repo pointers for the generic traps: never subscribe to `project_stats` (a view: no realtime
  events; clients recompute on `tasks` events); `users.email` is hidden on others' records, so
  fixtures resolve users by `name`; the atomic `UPDATE … RETURNING` counter is `projects.item_seq`
  in `pb_hooks/keys.pb.js`; `pb_hooks/activity.pb.js` captures the actor in the `*Request` hook
  for its universal writer.
- A migration CANNOT change a field's type in place — applies without error, changes NOTHING.
  Recipe: add new field → copy rows → detach any view referencing the old column → remove old +
  rename (worked example collapsed by decision:project-items-membership-denormalised's baseline rebuild —
  `v1:1785152200_tasks_vocab.js`, readable at the v1 tag in `hsb3/task-manager`).
- A migration citation is written `v1:FILE` (checked against the vendored
  v1 name list `scripts/migrations-v1.txt`, since the v1 tag lives only in `hsb3/task-manager`) or
  `v2:FILE` (the current tree).
- The newest app_docs seed (`gen_app_docs_seed.ts` `DEFAULT_OUTPUT`) is the corpus's only
  source, so replay gates compare it to itself; its prose is pinned by
  `scripts/app_docs_seed.sha256`, which `gen_app_docs_seed.ts --check` (check-static) verifies.
  After any intended seed change, including a new seed (move `DEFAULT_OUTPUT` to it first), run
  `bun scripts/gen_app_docs_seed.ts`: it rewrites the seed and its digest together.
- A UNIVERSAL `onRecord*` hook DOES fire for a migration's own
  `e.app.save()` on the `serve` boot path, and throwing there aborts the whole boot
  (`failed to apply migration …`). A strict validation/lock that must never refuse a
  backfill's writes belongs on the `*Request` tier (see `pb_hooks/keys.pb.js`
  `refuseSubmittedItemKey` — the universal placement cost a full build cycle).
- A universal-tier guard also fires for every programmatic save, so it must throw only when the
  save touches the fields it guards (`touchesScope`, `pb_hooks/scope.pb.js`, reading
  `.original()`). Without that predicate it throws on rows that were already incoherent, and
  main.pb.js's leaver-unassign sweep (one `try/catch` around the whole loop) strands every
  remaining assignee: a mixed batch stranded 0 with the predicate, 5 without (TASK-055). Prove a
  new universal guard against a batch mixing bad and good rows; `scripts/check_universal_touches.ts`
  refuses a model-tier update guard that throws without reading `.original()`.
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
- pb_hooks FILE load order is not stable per boot (3tvy: an untagged guard ran before another
  file's `noContent` chain-ender on only about half of fresh boots), so "my file loads first" is
  a per-boot race; prove any cross-file order across repeated boots. A hook file that throws at
  load does NOT fail the boot: PB prints `failed to execute <file>` and serves with that file's
  hooks absent. `roomkit.serve()` refuses a room whose log carries that line, the only cover for
  boot-only files; `tests/test_hook_files_loaded.ts` also probes each file that registers a
  request, route or realtime handler.
- A `DynamicModel` template infers Go types: `new DynamicModel({ ordinal: 0 })` scans as an int,
  so a fractional row value throws inside the hook after its UPDATE committed and the client
  gets 400 for a committed create (2bg7, `pb_hooks/ordinal.pb.js`). Write the template
  fractional (`{ ordinal: 0.5 }`) for any number that may hold a fraction, and use the array
  form `q.all(rows)` when zero rows is a legitimate answer.
- Each operation's rule stands alone: a peer correctly 404'd on GET got 200 plus the full body
  from a blind PATCH by id, and could DELETE, because update/delete carried a weaker predicate.
  A privacy predicate goes on list, view, update AND delete; probe the writes by id as the
  excluded role (`check_view_within_list.ts` compares view against list only).
- `hidden: true` on a VIEW collection's field silently reads back false on 0.40.4 (PATCH and
  migration alike; a base-collection field sticks), so a view column stays serialised,
  filterable, sortable and `?fields=`-selectable for anyone who sees the row: keep a
  confidential value out of the view rather than hiding it.
- `$app.canAccessRecord(record, requestInfo, rule)` re-queries the PERSISTED row by id: an
  unsaved record fails every rule, and a saved one mutated in memory answers for the DB value.
  A route that creates under its collection's live rule mirrors the rule in JS behind a
  differential gate (direct create vs route across the matrix, holding at least one permit and
  one refusal): `tests/test_invite_mirror.ts`.
- `e.app = txApp` inside a `*Request` hook ESCAPES the request in the pooled JSVM: other
  in-flight requests see the transactional app before the `finally` restores it, so a
  "transactional cascade" produced 204s with no cascade, 400s with a full cascade, and
  `transaction has already been committed` on unrelated creates (8-way, lane B5). Never mutate
  a shared event property to pull `e.next()` into a transaction; consolidate on
  `onRecordAfterUpdateSuccess` and accept no atomicity, or wait for a PB-level mechanism.

# Test-suite authoring pattern (house style)

One suite per collection/flow in `tests/test_<x>.ts`: boots its own clean room (copy,
correct port band), seeds fixtures by name, probes the FULL role matrix
(owner/admin/member/non-member/anon) using the status idiom above, prints ✅/❌ per
check, and self-gates (process.exit non-zero on any failure). The battery flags ❌
glyphs as belt-and-braces. Prove claims against the running server — docs and app_docs
state only what a test or live call demonstrated.

- **Local first** (owner ruling 2026-07-26): every verifiable criterion gets a local room or
  dev-server gate; a prod gate exists only for a claim about prod itself (deploy wiring, live
  delivery, live data).
- **A proof counts only once it has failed.** Break the behaviour, show the assertion RED with
  its message, restore, show it GREEN, and quote both. Assert the settled thing (a readout, a
  URL, a confirmed response) first and poll derived state against it; a scan gated on a
  readiness signal waits for the data it checks; never pin a revert-probe's baseline to the
  current tip; pin a known bug with an explicit assertion on the wrong behaviour, never an
  expected-failure marker (it goes green for ANY error); prove persistence from a fresh read,
  never an in-memory echo; a concurrency claim needs a barrier-released probe, not a sequential
  suite.
- **A clean-room copy refuses symlinks itself.** A recursive copy can carry a symlink inside the
  tree across as a symlink, so a write into the copy lands in the real tree. Copy a tree with
  `copy_tree` (`scripts/_scratch_copy.ts`), which refuses a symlink at or under its source;
  `scripts/check_scratch_copies.ts` line-scans for `cpSync`/`fs.cp` in `.ts` and `cp -R/-r/-a` in
  shell outside it (the battery's guarded copies allowlisted); a spawned argv or a shell string in
  a TS template is not seen.
- **A conflicted generated file shows NO conflict markers** (`merge=binary` in the generated
  `.gitattributes`) and looks clean: resolve it by rerunning its generator, never `git add`, and
  rebase just before the final gate run so the gate proves the rebased tree.
- **Scratch dirs are unique.** `PB_PORT_OFFSET` separates ports, not directories: make scratch
  with `mktemp -d` (or a PID-unique path), never a fixed name under a shared temp root, and
  delete only what you created — a fixed name once let one agent `rm -rf` another's live rooms.

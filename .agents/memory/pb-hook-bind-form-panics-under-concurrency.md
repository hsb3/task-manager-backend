---
name: pb-hook-bind-form-panics-under-concurrency
description: PB 0.39.9 invokes a `$app.onRecordCreateRequest().bind({...})` handler with NO event under concurrent creates and panics mid-create (items commit unkeyed); mutating `e.app = txApp` in a request hook leaks the transaction to other in-flight requests
metadata:
  type: project
---

Measured 2026-09-09 (wave v7 lane B5, `pb_hooks/precondition.pb.js`, PocketBase 0.39.9 JSVM):

- **Registration form, not body.** A create guard registered as
  `$app.onRecordCreateRequest().bind({ id, priority: -1000, func })` with a body of
  `return e.next()` and nothing else still panicked under 20 barrier-released concurrent creates
  (`TypeError: Value is not an object: undefined`, then `[PANIC RECOVER] nil pointer` in
  `apis/middlewares.go`), and the panic landed mid-create so items committed with no key
  (`[None, None, None, 'LEAK-3', ...]`). The plain `onRecordCreateRequest(fn, "coll", ...)` form
  ran 1200 concurrent creates clean. A single-threaded suite never sees it.
- **`e.app = txApp` escapes its request.** Pulling `e.next()` into a transaction by reassigning
  the event's app made 8 concurrent trashes return 204 with no cascade, 400 with a full
  cascade, and broke 3 of 20 unrelated creates with `transaction has already been committed`.
  The `finally` restore cannot help; the binding is visible to other requests in the window.

**Why:** both bugs are invisible to every producer-written proof in this repo (single-threaded
rooms), and both look like a green suite. Only an independent auditor running a concurrency
shape found them.
**How to apply:** register create hooks in the plain form; never reassign `e.app`; a
"transactional cascade" ruling needs a PB-level mechanism, not a JSVM idiom (6f1x ruling
question). Update/delete guards panicked the same way (F7 on 6f1x) and went plain in wave v8
lane Z1; no `.bind({...})` registration remains in pb_hooks. The rule now lives in
`.agents/rules/pocketbase.md`. Any new concurrency claim needs a barrier-released probe, not
a sequential suite: see [[proofs-must-be-falsifiable]].

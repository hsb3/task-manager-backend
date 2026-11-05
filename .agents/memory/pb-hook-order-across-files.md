---
name: pb-hook-order-across-files
description: PocketBase loads pb_hooks files in no stable order per boot, so a chain-ender (noContent) in one file can pre-empt a guard hook in another on some boots; give the guard an explicit priority via $app.onX().bind({priority}) and prove it across repeated boots
metadata:
  type: project
---

3tvy (2026-09-07) made the delete precondition in `pb_hooks/precondition.pb.js` untagged. On
trash-backed collections `pb_hooks/trash.pb.js` ends the delete chain with `e.noContent(204)`;
across 10 fresh boots the guard ran first only ~5 times, so a stale key was silently accepted and
the row trashed. The independent audit refuted "tagged-vs-untagged dispatch": three hook files
holding only a `console.log`, all untagged, load in a different order across boots. Hook FILE load
order is what varies.

**Why:** PocketBase registers handlers in file load order and that order is not stable; anything
that relies on "my file loads first" is a per-boot race.

**How to apply:** when two files handle the same event on the same collection, register the guard
with an explicit priority: `$app.onRecordDeleteRequest().bind({ id, priority: -1000, func })`
(plain object; `new Handler({...})` is a ReferenceError). Measured deterministic 8/8. Prove
across repeated boots, never once. Second trap: a hook file that throws at load does NOT fail the
boot; PocketBase prints `failed to execute <file>` and serves with that file's hooks silently
absent, so a guard can vanish with no gate noticing (carded). See [[pb-wire-message-normalization]].

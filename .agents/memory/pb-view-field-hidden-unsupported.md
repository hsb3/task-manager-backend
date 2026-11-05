---
name: pb-view-field-hidden-unsupported
description: PB 0.40.4 silently no-ops `hidden` on a VIEW collection's field (PATCH and migration both read back false, base-collection fields work), and `$app.canAccessRecord` re-queries the persisted row by id so an unsaved record fails every rule — two platform limits, each of which makes a design that relies on it fail open or fail closed with no error
metadata:
  type: project
---

Two PocketBase 0.40.4 limits, each measured against a running server. Both are platform
behaviour, not a defect in this repo: there is nothing here to repair, which is why this is a
reference memory rather than a task.

## A view field cannot be marked hidden

Measured in room `probe-o2b` (port 9894, PB 0.40.4), reported in
`~/.local/share/agent-artifacts/task-manager/pb1e-packet/reports/probe-o2b-guards.md` Q1.

- `PATCH /api/collections/project_items` sending `hidden: true` on three view fields returns
  HTTP 200, and every field in the response — and on re-read — carries `"hidden": false`.
- A JS migration doing `view.fields.getByName(n).hidden = true; app.save(view)` reads back
  `false` as well, confirmed from the server log after a room restart.
- The control proves it is view-specific rather than a general PATCH quirk: the identical PATCH
  against a base collection (`tasks.title`, `hidden: true`) sticks and reads back `true`.

Consequence: a "hide this column" design cannot lean on PocketBase's own `hidden` flag on a
view. The columns stay serialised on every list and view response, filterable, sortable and
`?fields=`-selectable by any principal who can see the row. Confidentiality has to be solved
another way — do not put the value in the view at all, or gate it at a different layer.

## `canAccessRecord` answers for the PERSISTED row, not the one in hand

`$app.canAccessRecord(record, requestInfo, accessRule)` is an access check for an existing row,
not a dry-run evaluator for a proposed one. It re-queries the database for the record's
persisted row by id. An unsaved `new Record(collection)` has id `""` until save, so the lookup
resolves against a row that does not exist and the call returns false for EVERY rule, including
trivially-true ones. The same calls against a persisted record answer correctly for every
fragment.

The decisive proof, and the shape to copy for any future probe of this: mutate a SAVED record's
field in memory and re-check — the result still matches the DB-persisted value, not the
in-memory one. That is what turns "it returned false" into "it re-queries by id", and it is the
step that separates this from an ordinary rule-syntax failure.

Consequence: a custom route that wants to create a record under its collection's own live rule
cannot delegate the decision to PocketBase. It has to mirror the rule in JS, and a hand-mirrored
rule needs a DIFFERENTIAL gate derived from the live rule at run time — run the direct
collection create and the route call across the relevant matrix, assert they agree cell for
cell, and assert the matrix holds at least one permit and one refusal so a refuse-everything
degeneration cannot pass green. `tests/test_invite_mirror.ts` (card `51a0`) is the worked
example.

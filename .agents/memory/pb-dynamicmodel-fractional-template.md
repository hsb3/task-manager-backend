---
name: pb-dynamicmodel-fractional-template
description: A PocketBase JS hook's DynamicModel template with an integer field scans a fractional DB value into an int and throws, turning a committed create into an HTTP 400; template numbers that may be fractional must be written fractional (0.5)
metadata:
  type: project
---

In a `pb_hooks` query, `arrayOf(new DynamicModel({ ordinal: 0 }))` scans `ordinal` as an integer.
When the row holds 0.5 or 8.5 (seed.py writes those), the scan throws inside the hook, and because
the UPDATE already ran, a committed create is reported to the client as HTTP 400 (2bg7,
2026-09-07, `pb_hooks/ordinal.pb.js`).

**Why:** DynamicModel infers Go types from the template literal; an int template cannot hold a
float and Go's scan fails loudly.

**How to apply:** write the template value fractional (`{ ordinal: 0.5 }`) for any number field
that may hold a fraction, and use `q.all(rows)` (array form) rather than `q.one()` when zero rows
is a legitimate answer. Related: [[pb-wire-message-normalization]].

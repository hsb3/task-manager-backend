---
name: feedback-owner-design-rulings
description: "Owner's standing design rulings — names are display-only never keys, and no vestigial fields"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8f7efc4a-97aa-4603-8b14-f8c4efb168c1
  modified: 2026-08-07T15:42:56.469Z
---

Two standing rulings Henry gave on 2026-08-07 that generalize well past the change that
prompted them:

1. **A text name is a display name only, never a key.** This covers a name-*derived* lookup
   string, not just a literal name column — a slug computed from a name is still a name being
   used as a key. Applies to URLs and any resolution path, not only to database columns.
2. **Don't leave unused fields.** When a field stops being read, delete the column, its index,
   its hooks and its tests in the same change. "Keep it, it's harmless" is not a reason —
   it still occupies `schema/`, `openapi.json` and the model tree, still needs maintaining,
   and still invites a future reader to assume it means something.

**Why:** both arrived as generalizations after a concrete bug, not as abstract preference.
Ruling 1 followed a live incident where the shell addressed a second account at the first
account's workspace; ruling 2 followed a question about whether to retain a column after
retiring its use.

**How to apply:** before adding any lookup keyed on something a user typed, check whether an
opaque id would do. Before leaving a field in place "for now", delete it. Recorded in-repo as
decision-017 with the full rationale and TASK-093 as the execution — but the rulings are
broader than that one task, so check them against any schema or addressing change.

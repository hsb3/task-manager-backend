---
title: Shared constants (mirror-site registry)
status: current
version: 19
updated: 2026-11-10
---

# Shared constants (mirror-site registry)

Pooled JSVM forbids shared modules (see `.agents/rules/pocketbase.md`), so every constant list below is
INLINED at each mirror site listed. `scripts/check_constants.ts` parses each site's own
literal (values, order, and declared subsets — not substring presence) and
fails on drift; it also parses THIS file's `Values:` lines and cross-checks them
against its own canonical map, so this doc can't drift from the enforced map either.

TEMPLATE_DATA_KEYS (section 7) and PRIORITY_UNSET_TOKEN (section 9) are gated the other
way round and hold no entry in that map: the check parses their values straight out of
the hook at the `KEEP IN SYNC:` marker and asserts every copy against each other and
against this file, so the hook is the single source of truth and neither value is
restated in the checker.

Format is machine-parsed: a `### NAME` heading followed by a `Values: a, b, c` line
(order matters — it is the canonical order). Do not reformat those two lines.

## 1. STATUS_CATEGORIES

### STATUS_CATEGORIES
Values: triage, backlog, unstarted, started, completed, canceled

Sites:
- `schema/statuses.json` — the `category` select field's `values` (full 6)
- `schema/project_stats.view.json` — `project_stats` view SQL, `s.category='<v>'` (full 6)
- `pb_hooks/main.pb.js` — workspace-provision default-statuses seed, **5 of 6 only**
  (no `triage` row — app_docs: "seeded with five statuses covering the
  non-triage categories"; `triage` is reachable but not a bootstrap default). This is
  an intentional partial mirror, not drift.
- `pb_hooks/cycles.pb.js` — cron cycle-rollover sweep, the resolved-half predicate deciding
  which work stays behind, **2 of 6 only** (`completed`, `canceled`). Anchored on that copy's
  own `INLINED SWEEP (cron copy…)` marker; an intentional partial mirror, not drift.
- `pb_hooks/cycles.pb.js` — route cycle-rollover sweep, the same resolved-half predicate,
  **2 of 6 only** (`completed`, `canceled`). The two sweep bodies differ only in `$app` versus
  `e.app`, so each site anchors on its own `INLINED SWEEP` marker and drift in either copy is
  reported against that copy's own line.
- `schema/project_items.view.json` — `project_items` view SQL (written by
  `v2:pb_migrations/1785185200_collections.js`), the resolved half, **2 of 6 only**
  (`completed`, `canceled`), repeated once per column: `status_terminal` and `open` read both, and
  `status_off_pipeline` reads `canceled` alone. Each copy is counted, so dropping one column's copy
  is drift.
- `pb_hooks/counts.pb.js` — `project_items` enrich hook, the `subtask_done` predicate over a row's
  child tasks, **2 of 6 only** (`completed`, `canceled`). Anchored on its own `subtask done` marker.
- `pb_hooks/counts.pb.js` — `statuses` enrich hook, the `terminal` (`completed`, `canceled`) and
  `off_pipeline` (`canceled`) flags every served status record carries, **2 of 6 only**. Anchored
  on its own `statuses enrich: terminal and off_pipeline` marker.

## 2. CORE_LABELS

### CORE_LABELS
Values: Bug, Feature, Improvement

Sites:
- `pb_hooks/main.pb.js` — workspace-provision core-labels seed (`_coreLabels`)

## 3. NOTIFICATION_KINDS

### NOTIFICATION_KINDS
Values: assigned, commented, status_done, mentioned, ownership_transferred

The canonical list is READ, not restated: the gate takes it from the `kind` select in the
generated `schema/notifications.json` (`values_from`).

Sites:
- `pb_hooks/notify.pb.js` — gated as TWO copies: the header comment's list (the file's
  only ordered copy, the full vocabulary) and the emitted `set("kind", …)` literals, compared
  as COUNTS per kind (order-insensitive, since the fan-out sites appear in trigger order): a
  kind with several emitters — `mentioned`, from the comment and item-prose fan-outs on create
  and edit — must still show every one, so losing any is drift. The emitter half is a declared
  SUBSET of four, since `ownership_transferred` is not emitted here.
- `pb_hooks/routes.pb.js` — the `ownership_transferred` emitter, one notice per party inside
  the workspace transfer-ownership transaction; the only kind emitted from a route rather than
  from a fan-out hook, declared as a one-value subset.

## 4. ACTIVITY_FIELDS

### ACTIVITY_FIELDS
Values: status, assignee, priority, due, milestone, project, title, labels, trashed, cycle

Sites:
- `pb_hooks/activity.pb.js` — the whitelisted-field array diffed per task update
  (marked `// KEEP IN SYNC: ACTIVITY_FIELDS`)

## 5. LABEL_TONES

### LABEL_TONES
Values: gray, red, orange, yellow, green, teal, blue, indigo, purple, pink

Sites:
- `schema/labels.json` — the `color` select field's `values` (generated from the migrations; the gate reads this, never a historical migration)
- `schema/statuses.json` — `statuses.color` offers the same palette

## 6. TEMPLATE_TYPES

### TEMPLATE_TYPES
Values: task, document

Sites:
- `schema/templates.json` — the `type` select field's `values`

## 7. TEMPLATE_DATA_KEYS

Two type-scoped whitelists, both inlined in `pb_hooks/scope.pb.js` (marked
`// KEEP IN SYNC: TEMPLATE_DATA_KEYS`, byte-parallel in the create + update handlers).
That marker is the checker's parse anchor — moving or deleting it fails the gate. The
`Values:` lines below are ASSERTED against those arrays, not the other way round: change
the hook first, then paste what it now says here.

### TEMPLATE_DATA_KEYS_TASK
Values: title, description, priority, type, labels, status, assignee, due, milestone, project

### TEMPLATE_DATA_KEYS_DOCUMENT
Values: title, body

Sites (both lists):
- `pb_hooks/scope.pb.js` — `TASK_KEYS` / `DOC_KEYS` arrays in the `templateData`
  shape-validation hooks

## 8. DEFAULT_PRIORITIES

### DEFAULT_PRIORITIES
Values: urgent, high, medium, low

Sites:
- `pb_hooks/main.pb.js` — workspace-provision priorities seed (marked
  `// KEEP IN SYNC (default priority vocab)`)

## 9. PRIORITY_UNSET_TOKEN

The wire token a client sends to clear a task's priority. It is reserved, so it can
never also be a workspace vocabulary entry (section 8) — `validateWorkspacePriorities`
rejects a `priorities` array containing it.

### PRIORITY_UNSET_TOKEN
Values: none

Sites:
- `pb_hooks/lib/workspace_rules.js` — the reserved-token comparison inside
  `validateWorkspacePriorities` (marked `// KEEP IN SYNC: PRIORITY_UNSET_TOKEN`). That
  marker is the checker's parse anchor and must stay directly above the comparison it
  governs; the `Values:` line is ASSERTED against that literal, not the other way round.

## 10. TRASH_VISIBILITY_PREDICATES

The three trash states `tasks.listRule` hides from a reader. The cycle-rollover sweep has
to hide exactly the same three: work a person cannot see must not be moved by a background
job, and a cycle inside a hidden workspace must not mint a successor.

### TRASH_VISIBILITY_PREDICATES
Values: trashed, project.trashed, workspace.trashed

Each sweep copy holds them across TWO queries, so each query is its own mirror site with
its own declared subset. A site's block is the QUOTED FILTER LITERAL, never the surrounding
code, so a predicate left behind in a comment satisfies nothing and a predicate moved to the
wrong query fails the site it left.

Sites:
- `schema/tasks.rules.json` — `listRule`, the generated copy of the live rule (never
  hand-edited; regenerated from `pb_migrations/` by `scripts/gen_schema.ts`). This is the
  reference every sweep site is asserted against. Full 3.
- `pb_hooks/cycles.pb.js` — cron `cycle-rollover` sweep, ended-cycle filter
  (`ends_on < {:today} …`), **1 of 3 only** (`workspace.trashed`): the predicate that keeps a
  frozen workspace out of the enumeration, and so also out of getting a cycle minted in it.
- `pb_hooks/cycles.pb.js` — cron sweep, held-work filter (`cycle = {:c} …`), **2 of 3 only**
  (`trashed`, `project.trashed`): the task half and the project half.
- `pb_hooks/cycles.pb.js` — route `POST /api/tracker/cycles/rollover` sweep, ended-cycle
  filter, the same **1 of 3**.
- `pb_hooks/cycles.pb.js` — route sweep, held-work filter, the same **2 of 3**.

The two sweep bodies differ only in `$app` versus `e.app`, so each of the four sites is
bounded by its own copy's `INLINED SWEEP` … `END INLINED SWEEP` markers — a site cannot be
satisfied by the sibling copy's text, and drift is reported against the line that drifted.
Each subset is intentional, not drift; together the four sites cover all three values.

---
name: universal-guard-needs-touches-predicate
description: "A universal-tier PB guard must fire only when the save touches the field pair it guards (touchesScope); otherwise it throws on already-bad rows and a sweep's single try/catch strands every remaining record"
metadata:
  type: project
---

The Request-vs-universal tier split is in `.agents/rules/pocketbase.md`; this is the trap on top
of it. A universal guard fires for every programmatic save too. Without a "does this save touch
the guarded fields" predicate (`touchesScope`, `pb_hooks/scope.pb.js`), it throws on rows that
were already incoherent, main.pb.js's leaver-unassign sweep swallows the throw in its one
`try/catch` around the whole loop, and every remaining assignee is stranded (TASK-055).

Proven both ways: a mixed batch strands 0 with the predicate; revert the predicate and it
strands 5.

**How to apply:** any new universal-tier guard predicates on the fields its save actually
changes, and is proven against a batch that mixes bad and good rows.

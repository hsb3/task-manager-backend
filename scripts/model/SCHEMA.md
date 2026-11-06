---
title: Entity metadata model, facet schema
status: current
version: 1
updated: 2026-11-06
generator: scripts/model/extract_current.ts # writes current/ in this schema; this file is hand-written
---

# Entity metadata model — facet schema

_The structured per-object model the owner asked for (2026-07-26): for each entity,
the scope, ownership, capabilities and relations the migrations define, extracted so they
can be analyzed programmatically._

## The layer

| Layer | Files | Authored by | Truth discipline |
| ----- | ----- | ----------- | ---------------- |
| CURRENT | `current/*.yml` | GENERATED — `bun extract_current.ts` replays `pb_migrations/` (same mechanic as `scripts/check_app_docs.ts`) and reads `_collections`; `--check` compares without writing and exits 1 on drift | never hand-edited; regenerate after any migration |

This is the stored half of the stored-vs-computed split from ReBAC practice: machine-extract
the stored facts (fields, relations, rules as written). Sources: OWASP authorization-matrix
testing (matrix = feature x role x data-filter), OWASP API3:2023 (field-level read exposure +
mass assignment), OpenFGA/SpiceDB modeling guides (typed parent relations, Check vs List
asymmetry), Oso ReBAC patterns.

## Actor vocabulary (closed set — add deliberately, not casually)

`public` (unauthenticated), `any-authenticated`, `self` (record IS the auth user),
`record-owner` (this record's `owner`), `workspace-owner`, `workspace-member`,
`active-workspace-member`, `active-workspace-admin`, `active-workspace-writer`,
`project-owner`, `assignee`, `author`, `superuser-only` (rule is `null`; PB superuser via
dashboard `/_/`), and two catch-alls the next section defines: `custom(<verbatim>)` for an
unnamed grant, `custom-compound(<reduced>)` for a composition of named ones.

`active-workspace-member` is the post-PBTT-431 (decision:active-membership-grants-access) membership grant: the
same-row pair `…workspace_members_via_workspace.user ?= @request.auth.id &&
…workspace_members_via_workspace.status ?= "active"`, both conjuncts on the same
field-path prefix, so a suspended/invited row confers nothing. The bare
`workspace-member` tag is the pre-revocation single-conjunct form and stays in the
vocabulary because the pattern still matches wherever a rule omits the status conjunct.

`active-workspace-admin` and `active-workspace-writer` are the role-qualified membership
grants (card vah6): the same-row TRIPLES that add `…role ?= "admin"` and `…role ?!=
"viewer"` respectively to that pair. Same-row is enforced by a backreference on the
field-path prefix, so a rule whose three conjuncts do NOT share one prefix is a different
grant and stays `custom(...)` — it is not silently promoted to the named actor. The match
is order-sensitive as well: the three conjuncts must appear in the order user, role,
status, and any other order falls back to `custom(...)` rather than to the tag.

### `custom(...)` vs `custom-compound(...)` — a gap or a composition (card vah6)

The extractor derives actors recursively, on PocketBase's own precedence — `&&` binds
tighter than `||`, so a surviving top-level `||` is the OUTER node and `A || B && C` reads
as `A || (B && C)`, never as `(A || B) && C`. A disjunct that is itself a compound
expression has its own children reduced, so a nested grant the tag table recognises is
named rather than swallowed whole, and a membership triple is recognised whether or not it
is parenthesised. Each actor pattern anchors its field-path prefix segment by segment, so
`xxxnotworkspace.owner` is a different relation from `workspace.owner` and stays `custom`. Which of the two catch-alls the atom then carries is the machine-
readable answer to "is this a modelling gap, or a composition somebody meant?" — owner
ruling R1 on card vah6 took branch (a), a category the tooling emits, over branch (b), a
hand-maintained prose list here that rots on the next rule edit.

The test is mechanical, and it is a residue test, not a proof about every leaf. After
reduction, the atom is `custom(<verbatim>)` if the reduced text still contains
`@request.auth` (an auth-keyed leaf no pattern matched) or the literal
`workspace_members_via_workspace` (the membership back-relation is precisely what this
vocabulary exists to name, so a raw one surviving means the extractor failed to name a
membership grant, whatever that leaf's auth content). Otherwise it is
`custom-compound(<reduced>)`, and the rendered text shows the composition — `task != "" &&
document = "" && decision = "" && (workspace-owner || active-workspace-writer ||
assignee)` — so the reader sees what it is made of.

Bounds — do not read more into a `custom-compound` than it says:

- Rendered tags are prefix-blind, exactly like the top-level ones (`task.workspace.owner`
  and `document.workspace.owner` both render `workspace-owner`), so two sibling branches
  of one rule can render to the IDENTICAL atom. Drift is still caught, because
  `extract_current.ts --check` compares each generated file byte-for-byte and every
  capability keeps its full `verbatim:` rule.
- **`custom-compound` does NOT mean "every grant inside is named."** The residue test sees
  only the two markers above, so a grant expressed without either — a bare record
  predicate acting as a grant, `visibility = "public" || <the admin triple>` — is invisible
  to it and the atom still reads `custom-compound`. Same for a compound of pure record
  predicates with no grant at all (`parent.parent = "" && parent.task = task && …`), which
  passes vacuously. In both cases the unnamed text is right there in the rendered atom;
  read it, do not trust the label alone.
- Reduction never rewrites the rule. `verbatim:` remains the truth; the actor atoms are
  best-effort derivation, here as everywhere else in this file.

### `body_pins:` — constraints on the record, not grants (card 1cvz)

A CURRENT capability may carry `body_pins:`, the verbatim `@request.body.*` atoms of a
conjunct — anywhere on a conjunct chain from the root of the rule — whose every disjunct
is body-only (references `@request.body.` and never `@request.auth`). A body pin
constrains the record being written — which values a field may take, or that a field may
not be sent at all — and grants nobody anything, so it is NOT an actor and never appears
in an `actors:` list. `workspace_members` create
pins `status` to `"active"` or `"invited"`; `users` create pins `approved:isset = false`.

An atom that mixes `@request.body.` with `@request.auth` is a grant, not a pin (it says
WHO may write, keyed off the payload) — `custom(@request.body.owner = @request.auth.id)`
stays an actor. It sits alongside `body_guards:` (the bare field names any part of the
rule touches).

Bound, and it matters when you read a claim: extraction flattens a pin conjunct's
disjuncts into a flat list, so the OR between them is LOST. `workspace_members` create
pins `(@request.body.status = "active" || @request.body.status = "invited")` and the list
reads as two atoms, which as a set would say both are pinned — unsatisfiable, and not what
the rule means. What the list does not carry is the shape of the constraint. `verbatim:` does.

### `record_state:` — what the record must already be (card 5jqz)

A CURRENT capability may also carry `record_state:`, the verbatim conjuncts that name
neither `@request.auth` nor the membership back-relation: the trash traversals
(`workspace.trashed = ""`, `task = "" || (task.trashed = "" && …)`), the XOR-leg
emptiness checks, and anything else the record itself must satisfy before the rule can
pass. Like a body pin it grants nobody anything, so it is not an actor.

**Position is what decides.** The same predicate means opposite things on the two sides of
the tree: in AND position it RESTRICTS (everyone must satisfy it) and lands in
`record_state:`; in OR position it WIDENS (satisfying it is itself a way in) and stays an
actor — `custom(draft = false)` on `documents` list is a real grant, the one that makes a
published document readable. Only conjuncts on a chain from the root of the rule are
collected, so every entry here is unconditional; a branch-local predicate stays inside its
`custom-compound(...)` atom, where the text shows which branch it belongs to.

PocketBase rules are allow-only; absence of an actor = deny. We deliberately do NOT
model negative permissions, group nesting, or arbitrary-depth hierarchies (small-app
guidance from the sources above).

## Known modeling gaps (deliberate v1 limits)
- `body_pins:` holds only UNCONDITIONAL pins — the ones on a conjunct chain from the root of
  the rule. A pin nested inside a compound disjunct (`comments` update carries eight) is
  branch-local: promoting it would claim a constraint the rule does not impose, since another
  branch may satisfy the rule without it. It rides along in that actor atom's rendered text.

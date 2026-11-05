# Entity metadata model — facet schema

_The structured per-object model the owner asked for (2026-07-26): for each entity,
enumerate scope, ownership, capabilities, relations, invariants — fill in what exists,
mark what is planned, analyze programmatically._

## The two layers and the diff

| Layer | Files | Authored by | Truth discipline |
| ----- | ----- | ----------- | ---------------- |
| CURRENT | `current/*.yml` | GENERATED — `bun extract_current.ts` replays `pb_migrations/` (same mechanic as `scripts/check_app_docs.ts`) and reads `_collections`; `--check` compares without writing and exits 1 on drift | never hand-edited; regenerate after any migration |
| TARGET | `target/*.yml` | hand-authored; owner rulings embed here | every `status: in-place` claim must match CURRENT; `planned`/`tbd` items carry a decision ref |

`bun diff_model.ts` compares them: `in-place` claims that do not match extraction are
DRIFT (non-zero exit — gateable); `planned`/`tbd` items are the gap backlog; entities or
capabilities the target does not mention are flagged UNSPECIFIED so silence is visible.
Beyond capabilities it also diffs each target `fields:` entry's `required` and closed
`values` vocabulary — an opt-in, partial claim whose exact bounds are stated below — and
each in-place capability's `body_pins:`, which is an exact set comparison, not opt-in.

This is the stored-vs-computed split from ReBAC practice: machine-extract the stored
facts (fields, relations, rules as written), hand-author only intent (capabilities,
invariants, decisions). Sources: OWASP authorization-matrix testing (matrix = feature x
role x data-filter), OWASP API3:2023 (field-level read exposure + mass assignment),
OpenFGA/SpiceDB modeling guides (typed parent relations, Check vs List asymmetry),
Oso ReBAC patterns. Research memo: in git history —
`git show 83c8eb9:_meta/_archive/backend-design-scope-settings-roles/research-prior-art.md`.

## Actor vocabulary (closed set — add deliberately, not casually)

`public` (unauthenticated), `any-authenticated`, `self` (record IS the auth user),
`record-owner` (this record's `owner`), `workspace-owner`, `workspace-member`,
`active-workspace-member`, `active-workspace-admin`, `active-workspace-writer`,
`project-owner`, `assignee`, `author`, `superuser-only` (rule is `null`; PB superuser via
dashboard `/_/`), and two catch-alls the next section defines: `custom(<verbatim>)` for an
unnamed grant, `custom-compound(<reduced>)` for a composition of named ones.

`active-workspace-member` is the post-PBTT-431 (decision-039) membership grant: the
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

`diff_model.ts` reports every atom of both kinds in an informational `CUSTOM_ACTORS`
section and puts the two counts on its summary line. It is a REPORT, never a gate: it
does not affect the exit code, because an unreduced atom is a prompt to model something,
not a failure.

Bounds — do not read more into a `custom-compound` than it says:

- Rendered tags are prefix-blind, exactly like the top-level ones (`task.workspace.owner`
  and `document.workspace.owner` both render `workspace-owner`), so two sibling branches
  of one rule can render to the IDENTICAL atom. Drift is still caught, because
  `extract_current.ts --check` compares each generated file byte-for-byte and every
  capability keeps its full `verbatim:` rule. What the collapse does cost is
  `diff_model.ts`'s target-side actor comparison, a sorted-list compare: swapping two
  such branches would not register there.
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
stays an actor. It sits alongside the pre-existing `body_guards:` (the bare field names
any part of the rule touches), which stays generated-side only.

`body_pins:` is GATED (card vah6). A target capability with `status: in-place` carries its
own `body_pins:` list, and `diff_model.ts` compares the two as SETS: order is not
compared, but a missing, extra or altered atom is DRIFT (exit 1). Omitting the key while
extraction found pins is DRIFT too — the empty set does not match a non-empty one — so
this ledger is COMPLETE rather than opt-in, unlike `fields:`. That is what closes the hole
the facet was filed for: widening `workspace_members` create to also accept
`status="suspended"` changes the pinned atom set, and the gate now says so.

Bound, and it matters when you read a claim: extraction flattens a pin conjunct's
disjuncts into a flat list, so the OR between them is LOST. `workspace_members` create
pins `(@request.body.status = "active" || @request.body.status = "invited")` and the list
reads as two atoms, which as a set would say both are pinned — unsatisfiable, and not what
the rule means. The set comparison is still exact against extraction, so the gate does its
job; what the list does not carry is the shape of the constraint. `verbatim:` does.

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

Unlike `body_pins:` this facet is generated-side only, like `body_guards:` — no target
claim, no gate. It is extracted from the same `verbatim:` the gated facets are, so a
hand-authored duplicate would only be a second place to get it wrong.

PocketBase rules are allow-only; absence of an actor = deny. We deliberately do NOT
model negative permissions, group nesting, or arbitrary-depth hierarchies (small-app
guidance from the research memo).

## Target file facets, per entity

```yaml
entity: tasks              # collection name
kind: base | auth | view
scope:                     # the tenancy position — Zanzibar-style typed parent
  parent: {type: project, cardinality: exactly-one, status: in-place}
  rescope:                 # who may change the scope pointer ITSELF (re-tenanting,
    who: []                # not a plain update) — commonly forgotten facet.
                           # `who` is NOT gated (see the un-enforced list below)
    status: tbd            # gated: no status at all is DRIFT
    decision: D4           # in-place also needs verify + verify_grep (test-proof rule)
ownership:                 # whose "owner" governs writes; transferable and by whom
  concept: project.workspace.owner
  transferable: {status: tbd, decision: D12}
capabilities:              # actor x verb matrix; list and view SEPARATE on purpose
  list:   {actors: [...], status: in-place}
  view:   {actors: [...], status: in-place}
  create: {actors: [...], status: in-place, authRequired: guard}
  update: {actors: [...], status: in-place, authRequired: guard,
           body_pins: ['@request.body.workspace:isset = false']}  # gated: exact set
  delete: {actors: [...], status: in-place, authRequired: implicit, authRequiredReason: "..."}
  # verbs beyond CRUD when they exist: scope-change, state-transition, member-add...
field_rules:
  server_forced: []        # NOT client-settable at create (anti mass-assignment)
  immutable:               # never updatable AT THE DECLARED TIER — one mapping per
                           # field, gated; `tier` is required (request | universal)
    - {field: workspace, status: in-place, tier: request,
       verify: tests/test_scope.ts, verify_grep: ["…(workspace-immutable)"]}
  sensitive_read: []       # hidden/limited even when the record is readable
fields:                    # OPT-IN, partial: only the fields whose shape carries meaning
  - {name: role, type: select, maxSelect: 1,   # gated: `required` + `values` (below)
     values: [admin, member, viewer], required: true}
lifecycle:
  states: ...              # enumerated states + where they are defined
  transitions: ...         # per-transition permission if any (distinct from update)
  soft_delete: no
invariants:                # what the rule language cannot express -> hooks
  - id: assignee-must-be-member
    mechanism: hook (pb_hooks/main.pb.js)
    status: in-place
    verify: tests/test_task_rules.ts   # manual/test evidence; diff cannot check hooks
on_delete_inbound:         # per inbound relation: cascade | clear | restrict + WHO
  - {from: projects, behavior: cascade, status: in-place, decision: D5}
non_crud_surfaces:         # realtime subs, file tokens, custom routes touching this
  - ...
open_decisions: [D1, D2]   # links into the v006 design record (git show 83c8eb9:_meta/_archive/backend-design-scope-settings-roles/design.md)
```

Every capability/facet entry carries `status`: `in-place` (diff-verified against
CURRENT), `planned` (ruled, not built), or `tbd` (awaiting ruling — `decision: D<n>`
required). `actors` lists use the exact tags the extractor emits (including
`custom(...)` and `custom-compound(...)` strings) so the comparison is mechanical.

Every `create`/`update`/`delete` capability also carries `authRequired`, a closed
set of four values: `guard` (the rule's first top-level `&&` conjunct is exactly
`@request.auth.id != ""` — the house fix idiom, and the SAME definition
`scripts/check_rule_auth_guards.ts` uses, imported from there rather than restated
here), `superuser` (rule is `null`), `implicit` (no leading guard, but the rule is
provably unsatisfiable for an anonymous caller — e.g. keyed on a required
relation/id that is never empty), and `none` (deliberately reachable by an
anonymous caller). A write capability missing `authRequired` is DRIFT. `implicit`
and `none` both require a sibling `authRequiredReason` explaining why; `guard` and
`superuser` need none. The key is camelCase deliberately, unlike the snake_case
structural facets above — it names an owner ruling, not a piece of the extracted
schema shape. In TARGET files `list`/`view` do not carry it; unauthenticated read
there is a separate, already-modeled decision per entity (see the actor vocabulary's
`public` tag).

The CURRENT side is narrower on purpose: `extract_current.ts` can only observe the
rule text, so it emits `authRequired` on all five capabilities using a three-value
set — `guard`, `superuser`, and `absent` (no leading guard, intent unknowable from
the text). `diff_model.ts` maps target to current as `guard`→`guard`,
`superuser`→`superuser`, and both `implicit` and `none`→`absent`, comparing only the
three write capabilities. The `implicit` vs `none` distinction is intent, which is
why it lives only in the hand-authored layer.

## The test-proof rule (owner ruling 2026-07-26)

Anything in the model whose status cannot be extracted programmatically MUST have a
test that checks the desired assertion — the test is both the inventory supplement and
the proof. Mechanically: every `status: in-place` invariant carries `verify:` (a test
path that must exist) and `verify_grep:` (a literal string that must appear in that
file — pin it to the test's own check description so a stale citation fails).
`diff_model.ts` flags violations as UNPROVEN and exits non-zero, same as drift. An
invariant we want but have no test for yet is `status: planned` with the test named —
it shows up in GAPS, never silently trusted.

`verify_grep:` takes a single literal or a LIST of them, all of which must appear; an
empty or whitespace-only literal is DRIFT, because it would match any file. A list is
how a two-sided claim pins both sides: `projects`' rescope cites the check that refuses
a workspace admin AND the one that shows the superuser exemption still working, so
losing either half fails the gate.

**Pin a literal that only a live assertion can satisfy.** Several suites keep a
`verify_grep` token registry in their module docstring (`tests/test_scope.ts`,
`tests/test_trash.ts`) so a rename is caught. A citation pinned ONLY to such a short
token is satisfied by the docstring itself, so it survives the deletion of every
assertion in the file — proof of nothing. Pin the check description instead, and where
it is an f-string pin the invariant substring that is literally in the source
(`": update workspace to ws B → 400 (workspace-immutable)"`). Those descriptions
contain the registry token as a substring, so the rename warning still works.

### Which facets the rule is enforced on (TASK-082)

`scope.rescope` and every `field_rules.immutable` entry are gated exactly like
invariants — neither is extractable, so both owe a proof:

- a `rescope` facet with **no `status:`** is DRIFT, not an implied `in-place`. The
  status is a closed set, the same values as everywhere else — `in-place` | `planned` |
  `tbd`; anything else is DRIFT.
- `status: in-place` on either facet requires `verify:` AND a non-empty `verify_grep:`.
  A citation with no grep is UNPROVEN: the file merely existing proves nothing. This
  now holds for invariants too.
- an `immutable` entry must be a mapping (`field:` + `status:` + `tier:` + the proof). A
  **bare string** — the pre-TASK-082 shape, `immutable: [workspace]` — is UNPROVEN, so
  an undeclared entry cannot ride along unnoticed.
- an `immutable` entry's `field:` must name a field extraction actually found on that
  entity (`current/<entity>.yml`, either a plain field or a relation) — else DRIFT.
- an `immutable` entry's `tier:` is a closed set. `request` means the guard is an
  `onRecordUpdateRequest` hook, so it is bypassed by a programmatic `e.app.save()` from
  a cron or a custom route (CLAUDE.md) — the field is immutable to an HTTP caller, NOT
  absolutely. `universal` means the guard rides the universal create/update tier, which
  fires for a programmatic save too. Missing or unknown is DRIFT: the enforcement
  ceiling must be stated, never implied.
- a capability's `body_pins:` is gated differently from the three above — no `status:`, no
  citation, because the pins ARE extractable: the target list is compared to extraction as
  an exact set on every `status: in-place` capability, and any difference is DRIFT (card
  vah6, detail in the `body_pins:` section above).
- an entity with at least one relation in `current/` but no `rescope` facet in its
  target is UNSPECIFIED — a relation IS a repointable pointer, so deleting the facet
  does not buy silence. The test reads extraction, not the target's own `parent` facet.
- `view_query` on a VIEW entity's target is gated exactly like the two above (card
  h8cn). Extraction copies the view's SQL into `current/` verbatim, so the two layers
  can never disagree and there is nothing to diff — but the SQL is the view's whole
  behaviour, and the columns it computes (a sink flag, a rank, a flattened correlated
  subquery) are precisely what a rename or a refactor breaks silently. So the citation
  IS the gate: `status:` from the closed set, and `in-place` requires `verify:` plus a
  non-empty `verify_grep:` that resolves. A view whose target names no `view_query`
  facet is UNSPECIFIED; a `view_query` facet on a target whose extracted `kind` is not
  `view` is DRIFT.

Bounds, stated so nobody reads more into a green run than it earns:

- a `verify_grep` proves the cited literal is present in the cited test, not that the
  test exercised THIS entity. Where a shared check description covers several
  collections (test_scope.ts's S3/S4 loops) the per-entity coverage comes from the
  test's own loop, and the facet's `note:` says which collection the positive path ran
  on.
- the gate proves the entries a list CONTAINS, never that the list is COMPLETE. No
  extraction can enumerate every field a hook happens to lock, so an
  `immutable: []` still means "nobody has claimed anything here", not "nothing is
  immutable".
- the gate reads a test's TEXT, never its result. A cited check that is present but
  skipped, or asserting the wrong thing, still counts as proven here — the battery is
  what proves the checks pass.

### Explicitly un-enforced — do NOT read these as verified (TASK-082)

Nothing gates the following; an `in-place` status nearby does not cover them, and a
value here is unverified prose:

- **`scope.rescope.who`** — the actor set. It is a hand paraphrase in this file's actor
  vocabulary (`workspace-member`) rather than the list extraction emits for the same rule
  (`active-workspace-writer`, plus whatever else the rule reaches), and the paraphrases
  deliberately omit branches (`decisions`' update rule reaches `author` and an admin
  disjunct that `who` does not list), so there is no mechanical comparison to make. Read
  it as orientation, never as a verified actor set. What IS gated on the facet:
  its `status`, that an `in-place` one carries a citation, and that the citation
  resolves to a literal only a live assertion can satisfy.
- **`field_rules.server_forced`** and **`field_rules.sensitive_read`** — ungated lists.
- **a `fields:` entry's `type`, `maxSelect` and `note`** — descriptive only. What IS
  gated on that facet: `name`, `required`, `values` — see the `fields:` section below.
- **`scope.parent`** — its `type`/`cardinality`/`status` are never compared to
  extraction.
- **`ownership.transferable`** — ungated, and it uses an extra status value, `n/a`.
- **`record_state:`** — generated-side only, with no target claim to diff against; what it
  IS good for is reading a capability's unconditional preconditions in one place.
- older invariants whose `verify_grep` is only a short docstring-registry token: the
  citation is live-file-independent in exactly the way described above. New and
  reworked claims pin live check descriptions; the older ones were not migrated by
  TASK-082 and are weaker than they look.

### The `fields:` claim — what it does and does NOT guarantee (PBTT-399)

A target `fields:` list is an **opt-in, partial** claim ledger, not an inventory. Most
target files carry no `fields:` key at all, and the ones that do name a field or two.
That is deliberate: the whole field list is already in `current/`, extracted; the target
layer exists to pin the shapes a migration must not change *silently*. Extraction can
never disagree with itself, so without a hand-authored claim there is nothing to diff —
which is why the hand-authored side is the right shape here even though it duplicates
data. Pin a field when its shape carries permission or lifecycle meaning; leave the rest
to `current/`.

`diff_model.ts` compares exactly three things per entry, all as DRIFT (exit 1):

- **`name`** must be a field extraction actually found on that entity — a plain field or
  a relation (same rule as a `field_rules.immutable` entry's `field:`).
- **`required`** (when the entry names it) must equal extraction's, and must be a real
  YAML boolean — a string there is DRIFT, not a truthy pass.
- **`values`** (when the entry names it) must equal extraction's closed vocabulary as a
  SET — order is not compared, but a missing, extra or renamed value is DRIFT. Extraction
  emits `values` only for `select` fields, so declaring `values` on anything else is DRIFT.

Bounds — do not read more into a green run:

- **A field the target does not NAME is not claimed and not checked.** An entity with no
  `fields:` key has every field unpinned; `workspaces.name` could become optional and
  nothing here would notice. The gate proves the entries the list CONTAINS, never that
  the list is complete — the same ceiling `field_rules.immutable` carries.
- **`type` is never compared.** Target entries carry prose types (`relation (→users)`)
  that do not match the extractor's strings; the key is reader context only.
- **`maxSelect` and `note` are never compared** either — descriptive, unverified prose.
- Nothing about a relation beyond `required` is compared here: its target collection,
  cardinality and `on_target_delete` are not (the last one is covered separately by
  `on_delete_inbound`).
- Field-level defaults, min/max, patterns, uniqueness and hidden/protected flags are
  extracted into `current/` but have no target-side claim at all.

The first of those bounds used to be invisible to anyone reading the green
`✅ model_diff` line, which is how twelve select vocabularies went unclaimed while the
gate looked complete (card rvef). It is now reported rather than merely documented:
`diff_model.ts` counts every `select` field in `current/`, lists the ones no target
`fields:` entry pins a `values:` list on under `UNCLAIMED_VOCABULARIES`, and puts the
ratio on the summary line, so the green run carries its own coverage. Coverage reached
14/14 when the twelve were claimed, and from there an unclaimed vocabulary is an exit-1
failure like DRIFT: a migration that adds a select field must claim its values in the
same change.

## Known modeling gaps (deliberate v1 limits)
- `body_pins:` holds only UNCONDITIONAL pins — the ones on a conjunct chain from the root of
  the rule. A pin nested inside a compound disjunct (`comments` update carries eight) is
  branch-local: promoting it would claim a constraint the rule does not impose, since another
  branch may satisfy the rule without it. It rides along in that actor atom's rendered text,
  and `diff_model.ts`'s `body_ref_coverage` is the machine check that it is still there —
  every `@request.body` reference a rule makes must appear in some `body_pins:`, `actors:` or
  `record_state:` entry, and one that does not is DRIFT (exit 1). So the gated ledger covers
  the pins the rule imposes on every caller, not every pin the rule contains, and nothing the
  rule says about the payload can go invisible.
- `authRule`, OTP/MFA, and file-token behavior are modeled as `non_crud_surfaces` on
  `users`, not as capabilities.
- Field-level read visibility is specced only for sensitive fields (email, protected
  files), not as a full field x role cube.

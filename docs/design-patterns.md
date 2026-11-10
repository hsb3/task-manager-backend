---
title: Design patterns
status: current
version: 5
updated: 2026-11-10
---

# Design patterns

This file states the framework-agnostic patterns this app instantiates, so a rule learned
here can be carried to a project sharing none of its technology. Use an entry by lifting
the opening paragraph and dropping the **Here:** line, which only proves the rule was
paid for once and points at the record that settled it. Only accepted decision records are
cited; a proposed record joins on acceptance.

## Data model and identity

### Key on an opaque identifier, minted once

A record needs an address that survives every edit a person can make to it. Text a user
typed is not that address: it changes, it collides, and anything derived from it (a slug,
a lookup string, a folder name) inherits both faults. Key on an identifier the system
mints, keep it immutable, and let names be display only. A human-readable label is minted
once at creation and follows the record even when it stops matching its surroundings.

**Here:** decision:item-display-keys mints a display key at
create, fixes it thereafter, and keeps it through a move; decision:cycle-rollover applies the same
rule to auto-generated cycle names, which are placeholders a person renames.

**Rules out:** rename-breaks-every-link, two records colliding on one derived key, and a
second reader assuming the label is a lookup.

### Delete a field when its last reader goes

A column, a flag or a vocabulary value with no live reader and no live writer is not
harmless. It still occupies the schema, the published contract and the generated model,
still has to be maintained, and still invites the next reader to assume it means
something. When the last consumer goes, remove the field, its index, its hooks, its tests
and its contract type in one change. A vocabulary value obeys the same rule: it ships with
a live producer, or it goes.

**Here:** decision:draft-private-publish-one-way drops an unused draft flag instead of building the privacy branch it would
have needed; decision:notification-kinds-ship-with-producer keeps a notification value only because a live producer writes
it, while the record it supersedes had removed a value that nothing could ever write.

**Rules out:** a field that reads as meaningful because it exists.

### Provisioning answers the empty case

A tenant that arrives without the vocabulary it needs is unusable in a way that looks like
a bug, so provision every required dimension at creation rather than leaving it empty for
a person to discover. Seed a dimension the product cannot work without on every creation path; withhold a
starter object the user could make themselves from any container they created deliberately. Where a
relation may legitimately be absent, prefer an invisible default container over a null:
the absent case then stops existing as a second shape every reader has to handle.

**Here:** decision:default-priority-vocabulary seeds the default priority vocabulary on every provisioning path
because an empty one made the field unwritable; decision:auto-provision-workspace withholds the default project from a
hand-created container, since the person who made it has already found the product;
decision:shadow-project routes every parentless item into one invisible per-tenant container, so
"item with no parent" stops being a state.

## Mutation and concurrency

### Capture identity on the request, not after the commit

The callback that runs after a write commits is the natural place to derive consequences,
and it is usually the place where the caller's identity is no longer available. Capture
the actor, and any before-value the consequence depends on, on the request path, then hand
them to the after-write work. Anything that must also fire for writes that never came from
a request (background jobs, migrations, internal saves) belongs on the universal hook
tier instead, with the identity treated as absent rather than assumed.

**Here:** `.agents/rules/pocketbase.md` records where this repo captures the actor (in the
`*Request` hook) and that a universal-tier hook also fires for every programmatic save;
the fan-out record (`decision:notification-fanout-semantics`) names that constraint as the
load-bearing one for actor attribution and exactly-once delivery.

### Allocate a sequence with one atomic statement

A counter read in one statement and written in another collides as soon as two requests
overlap, and the storage engine serializing the commit does not serialize the read. Take
the next value in a single atomic update that returns it, and back it with a uniqueness
constraint so a collision is a refused write rather than a duplicate. Treat the assigned
value as immutable once written.

**Here:** the vocabulary record (`decision:vocab-first-class-collections`) reports 9
collisions in 20 concurrent creates from read-max-plus-one, replaced by one
`UPDATE … RETURNING` behind a unique index; decision:item-display-keys moves that counter to the
container that owns the display key without changing the idiom.

**Rules out:** a duplicate key that only appears under load.

### Announce inside the transaction, sweep outside it

A notice about an event must be written or rolled back with the event, so it belongs in
the same transaction, even when that puts the producer somewhere other than the file its
siblings live in. Work that cannot be made transactional runs after the write,
idempotently, so a partial failure leaves a consistent state the next run completes. Such
a sweep states its leftover set negatively, as the complement of the resolved set, or a
state added later is silently stranded. Never reach transactional scope by mutating state
the runtime shares between concurrent requests: the transaction escapes its request and
other callers commit into it.

**Here:** decision:notification-kinds-ship-with-producer keeps the ownership notice inside the transfer's own transaction;
decision:cycle-rollover rules the rollover sweep idempotent rather than transactional, rolls work
forward unless its status category is completed or canceled, and normalizes both boundary
dates to midnight so the no-overlap rule it depends on is real;
`.agents/rules/pocketbase.md` records that reassigning the shared event's app handle
produced deletes with no cascade and errors on unrelated writes.

### No default that hides a valid state, no create that grants what update pins

A convenience default applied at creation can make a legitimate state unreachable, which
reads to a user as a missing feature rather than a choice. Leave the field absent and let
absence mean what it says. The same symmetry applies to privilege: if the update path pins
a field so it cannot be raised, the create path has to pin it too, or the restriction is
one request away from being bypassed.

**Here:** decision:tasks-have-no-default-assignee drops assignee defaulting so the unassigned bucket becomes a real
destination; decision:role-tiers pins the role a non-owner may set at create, matching the pin
the update rule already carried.

**Rules out:** privilege escalation through the create path, and a state that exists in
the schema but is unreachable from the product.

## Access and scoping

### One source of truth for scope, carried where a miss fails loudly

When a request's scope can come from two places, the two will disagree, and the
disagreement renders one tenant's frame around another tenant's data. Pick one carrier,
make every consumer read it, and demote the other to a hint with a single named job.
Choose the carrier by its failure mode: a scope in the address fails loudly, since a
request without it matches nothing, while a header, a parameter or an ambient session
value fails silently, because a consumer that forgot to read it keeps serving plausible
data.

**Rules out:** two windows that cannot hold two scopes, and a shared link that lands
somewhere else without saying so.

### A denial is a refusal, never a default

Code that resolves an entitlement has to treat a denied read as a denial. Swallowing it
and falling back to a default grants the very access that was refused, and the fallback is
invisible in every test that only checks the happy path. Refuse a dead or forbidden
address with the same answer an unknown one gets, so the response cannot be used to
enumerate what exists.

### Enforce at the storage tier, check at the boundary, explain at the app tier

An invariant enforced only in the application is enforced only on the paths that go
through it, and every new path is a hole. Put the refusal in the storage rules, where no
caller can go around it, keep the application check as defence in depth and as the thing
that produces the user-facing verdict, and place the entitlement check on the boundary
every request crosses rather than on a page that most requests skip.

**Here:** decision:active-membership-grants-access moves the suspended-member and hidden-container refusals into the
rule tier and keeps the app tier for the verdict panels.

**Rules out:** an invariant that holds until somebody adds a second client.

### Authority is granted at its own scope

A power that applies to the whole system must come from a grant that means the whole
system. Reusing a local role for a global action hands that action to everyone the local
role is cheap to obtain by. In the same spirit, a stamp recording who created a record is
not an authorization signal, and an inactive membership is not a membership: read the
explicit role, and require it to be active for reads as well as writes.

**Here:** decision:signup-approval puts account approval on an explicit app-administrator list because
every signup owns a container and would otherwise inherit the power; decision:active-membership-grants-access revokes
read as well as write for any non-active membership; decision:project-write-access widens edit rights to
every non-viewer role and states that the creator field carries no authority.

### Whatever bypasses the declarative rules restates them

A hand-written endpoint, a search query, a broadcast channel or a report view does not
inherit the declarative access rules, so it has to reproduce them, and the honest standard
is parity: a caller sees exactly what they could already list. A name that looks
tenant-specific is not enforcement either; a subscriber can ask for any name, so the
subscribe path needs its own authorization.

**Here:** the search record (`decision:search-scoping-standard`) self-scopes every query
by the caller's own membership and states list-rule parity as the standard.

### Admit inline content by a per-request token

A policy that admits inline content by hashing its text breaks on every edit to that text,
so it decays into being widened. A fresh token minted per request and handed to the
renderer does not. Where a category of inline content cannot carry the token at all,
admit that category explicitly and record what the exception costs rather than dropping
the policy.

## Deletion and recovery

### Soft delete is a state, and containment is answered by traversal

Recoverable deletion is a timestamp on the record, not a second copy of it. Hiding the
children of a hidden parent is then a traversal in the read rule rather than a marker
written onto every child, so restoring the parent restores them with no bookkeeping to
undo, and a child hidden in its own right stays hidden. Deleting for real is the second
delete, authorized separately, and the scheduled expiry is the same operation on a timer.

**Here:** the trash record (`decision:soft-delete-trash`) intercepts the first delete
into a trashed stamp, purges on the second, and hides a trashed parent's items through a
single-hop traversal in the list rules with no per-item marker.

### Hiding a container hides its contents and freezes its configuration

Hiding only the container row leaves everything under it readable and writable by anyone
who knows an address, which is worse than not hiding it at all. The contents go with the
container, and so do its configuration and its roster, frozen rather than cascaded,
because configuration is what a restore lands back into. Reads of that frozen material
narrow to exactly the tier that can restore, so the people who can bring it back can still
see it and nobody else is told anything.

**Here:** decision:workspace-trash-cascades rules the cascade over contents and extends enumeration and restore
to active administrators; decision:workspace-configuration-freeze freezes every configuration collection under it and
narrows their reads to the restoring tier, after measuring that a roster stayed writable
under a container the product said was gone.

### Restore in place, and refuse an impossible restore with a way forward

Recovery returns a record to where it was, including its position, so restoring is the
inverse of deleting rather than an append. When the original place no longer exists,
detect the conflict and refuse, say why, and offer the content pre-filled in a create form
so the work is not lost. Silently re-homing the record is the failure to avoid.

### Stores with different retention lifecycles stay apart

One store holding two kinds of object with different lifetimes couples them: a retention
sweep for one deletes into the other's namespace, and a restore treats the whole store as
one story. Give each lifecycle its own store and credentials, even when sharing is
cheaper, and wire the credential from the environment at boot so a rotated key applies on
the next deploy and never reaches the repository.

**Here:** decision:backups-recovery keeps the backup store backups-only and requires a second store if
uploads ever move off the local volume, which is what later happened; the backup record
(`decision:backups-recovery`) wires the destination from environment variables at boot.

## Notifications and presence

### One event, one notice per person

A person told about an event once has been told. A fan-out therefore excludes the actor
and also excludes anyone the same write already notified through a more specific channel,
so one update never produces two notices for one fact. Fire only when the watched value
genuinely changed, comparing against the value captured before the write, so a replay of
an identical payload notifies nobody.

**Here:** the fan-out record (`decision:notification-fanout-semantics`) subtracts the
actor and the people the same write mentioned, and guarantees exactly-once by capturing
original values before the write proceeds.

### A privileged override names the hand that ran it

An audit trail whose least-consented event is its least-attributed one is inverted. When
an operator acts outside the normal identity model, record that identity in its own field
rather than blanking the actor or borrowing a user's identity, and render the two cases
distinctly. Reserve the "system" reading for rows genuinely written by nobody.

**Here:** decision:superuser-actions-name-operator adds an operator field filled only on the privileged path, keeps
the actor relation empty there, and makes the two columns mutually exclusive by
construction so an unattributed row is a shape no writer produces.

## UI structure and copy

### One grammar, few shapes, one subject per destination

Screens that each invent their own layout cost a reader a fresh orientation per screen.
Define a small number of page shapes, state their bands, measures, type roles and spacing
once, and make every screen an instance of one shape. Give each destination one subject:
stacking unrelated tables on one page is the shape to rule out, and low-frequency
destinations are pinned somewhere stable rather than interleaved with the working set.

**Which box carries the inset.** On a document screen the container carries it: 24px at every
width. On an index screen it belongs to the rows, not the container, and steps down on a narrow
viewport: the toolbar, the table rows, the board's column scroller, the members header and the
item screen's header and body each write 24px themselves, 16px below 768px, so a hairline still
reaches the container edge instead of stopping short of it. The inset value itself did not
change: the screens that sat off it (a board at 12px, an item screen at 32px) were brought onto
it, and what moved is ownership (rh6z, 2026-09-19). The board additionally drops the container
cap.

### Adapt at the layout tier, and cap the measure rather than the container

Support for smaller viewports is usable, not redesigned: one breakpoint, a single-column
arrangement below it, wide content scrolling inside its own container rather than the
page. At the wide end the answer is column behaviour, not a page cap: dense views run the
full width, declared column widths are made binding, and the cap goes on the reading
measure of the text column, with surplus absorbed deliberately instead of falling into one
column.

### A feature enters scope by being designed, not by being invented in code

A design that is silent about an area is stating a boundary, not delegating it. Treat the
unnamed surface as out of scope, keep the named exclusions listed so they stay visible,
and let a feature enter scope by a deliberate, reviewed design change rather than by
appearing in an implementation. Reviews do not flag the absence of what was never designed.

### Two surfaces that differ only by a clamp share one definition

When two screens show the same set under different restrictions, define the set once and
express each screen as that definition plus a stated clamp. Two independent definitions of
"mine" or "open" drift, and the drift shows up as two screens disagreeing about one
record.

### No dead ends

Every state a person can reach offers a way out of it. A form that posts has something
that handles the post; a value the product cannot interpret renders a visible mark rather
than nothing; an empty section offers the entry point that fills it, to the people who may
edit and to nobody else; a sign-in with nowhere to land says why in product language. A
second entry point into an existing behaviour reuses it rather than reimplementing it, or
the two paths drift and one starts lying about why it refused.

### User-facing text names the benefit, never the mechanism

Rendered copy is read by people with no access to the source, so it describes what happens
and why it helps. Attribute names, template internals, endpoint names, job names and
markup terms belong in comments and change descriptions. When a specification states the
fact a label should convey, translate it into a user's words instead of pasting the
specification's own phrasing, which is written for implementers.

**Here:** `AGENTS.md` carries this as a conduct rule.

### Mount shared context over the subtree that uses it

Context mounted at the root is paid for by every page, including the pages that never read
it, and the cost is usually invisible until it changes how those pages are produced. Mount
a provider over the subtree that consumes it. When an area outside that subtree needs the
scoped data, move the area under the scope rather than lifting the provider back up.

## Contracts and generated artifacts

### Adapt at one declared seam, and declare every stub

A consumer should read one contract, and exactly one layer should translate between that
contract and whatever the store actually holds. The seam lets the consumer be built ahead
of the store, with typed stubs standing in for what is not backed yet, provided every stub
is registered: an untracked stub reads as a supported capability. Decide explicitly
whether the seam is permanent, because a series of small moves toward native storage
dismantles it one field at a time without anyone choosing that.

**Here:** decision:backend-owns-business-rules keeps the proxy as the only seam but confines
it to adaptation (session, path scoping, renames, formats, error envelopes) and moves every
business rule and derived value into the backend, so the seam stays thin by ruling.

### One source per artifact, and coupled artifacts move together

Every fact has exactly one place it is authored. A generated artifact is corrected by
fixing its source and regenerating; the generator's own drift check is what makes that
enforceable rather than a habit. When one change has coupled artifacts, they move in the
same change, gated. Where the runtime forbids sharing a constant, each copy is a registered
mirror site and the gate parses each site's own literal, so a copy that drifts is named.

**Here:** `AGENTS.md`'s migration and schema laws route every correction to its single
path and require the coupled regenerations in the same change; `scripts/check_app_docs_quotes.ts`
gates quoted rule text; `docs/constants.md` registers every mirror site of every duplicated
constant with the subsets each site legitimately holds. `scripts/gen_openapi.ts` writes
byte-stable output (sorted keys, no timestamps), so rerunning it before and after a schema
refactor must give byte-identical output, which proves the refactor changed nothing.

**Rules out:** two true-looking copies of one fact, and a hand edit to a generated file.

### Let the system document itself as data

Documentation about the system's own structure can live inside the system, seeded by the
same mechanism that creates the structure. It then travels with any deployment, rebuilds
on an empty store, is queryable at runtime and appears in backups, none of which a
separate wiki does. The convention holds because a check fails when a documented thing has
no record, not because everyone remembers.

**Here:** `docs/self-documenting-app.md` describes the record-per-thing convention, the
idempotent seeding, and the existence gate that runs in the commit hook and in continuous
integration.

## Testing and gates

### Done is a command that scopes itself to what changed

"Done" is a command result, not an assertion. One entry point derives the scope from the
paths a change actually touched and runs only the gates that scope requires, so the answer
does not depend on somebody remembering the right list. A criterion nobody can meet is
decoration, so the gate asserts what is enforceable today and the harder goal stays its own
work. Read that command's own exit status: chaining anything after a gate reports the last
command's status instead, which is how a red gate gets announced as green.

**Here:** the repo runs `make check` whole instead of a path-scoped subset: one entry point, every gate, so no scope list can be misremembered; `AGENTS.md`'s gate law forbids reading a gate's result through a pipe.

### A proof counts only after it has been seen fail

A passing assertion is not evidence until the behaviour it names has been broken and the
assertion has been watched to fail with its own message. Assertions that cannot fail are
common and they manufacture confidence: absence checks that assert nothing, polls that
match a transient, thresholds never reached at the sizes tested, criteria the harness
structurally cannot exercise. Where a capability genuinely cannot be reached by a
deterministic test, record a dated disposition naming how it is verified instead of an
open task that implies future coverage.

**Here:** the test-suite house style in `.agents/rules/pocketbase.md` carries this repo's
version.

### Invariants belong in the gate

A rule that lives only in a review comment is enforced only when that reviewer is present.
Put it in a check, derive the check from the generated artifact rather than a hand-copied
list (a hand copy agrees with itself while the real value changes underneath), and compare
exactly rather than by containment, because the dominant way a rule hardens is by adding a
clause, and a containment check blesses the stale text it was meant to catch. Fail closed
on anything the registry does not cover, and let a deliberate exception be an allowlist
entry carrying its reason rather than an unwritten habit.

**Here:** `scripts/check_app_docs_quotes.ts` holds every quoted rule to byte equality with the
generated schema unless its registry pins the quote as prose; decision:notification-kinds-ship-with-producer re-points a vocabulary check
at the generated schema.

### Every run owns its environment

A test that shares a live environment passes against somebody else's state, and the
collision is silent because a healthy service on the expected port looks like its own.
Each run boots its own instance with its own copy of the data and of the code the service
watches. Scale that by replicating the isolation across processes, never by adding parallel
workers inside one shared environment, where the failures that appear are state collisions
misread as flakes.

**Here:** `AGENTS.md`'s clean-room law requires a scratch copy of the migrations and hooks
and a port derived from a band rather than hand-picked.

### Ground a threshold in a standard, and make it recomputable

A number nobody can derive is a number nobody can defend, and asking a decision-maker to
pick between two constants ratifies whatever framing produced them. Anchor the value in an
external standard, ship the calculation that produces it from its inputs, and report it
across the range of real conditions rather than as one flat figure. When a cited source
cannot be found on inspection, replace it with one that can and record the correction.

**Here:** the owner refused to pick
between two caps and instructed that scenarios be computed instead.

## Process and records

### Prior art first, then rule explicitly

A product question that other tools have already answered is answered by looking at their
answers first and saying what was found. Prior art is evidence for the decision, never a
substitute for it: cite the observed behaviour, then make the call explicitly, including
when the call is a deliberate divergence. Measure the prior art where measuring is
possible rather than quoting from memory, and say which it was.

**Here:** `AGENTS.md` carries the standing rule; decision:cycle-rollover sets out the comparable
tools' rollover behaviour before ruling; decision:project-write-access cites both a comparable product and
a bug report in another tool before widening the rule.

### Intent lives in one system of record

One system holds intent, one artifact type holds each kind of intent, and the vocabulary
that classifies them is small, closed and mutually exclusive. Committed work, anticipated
work, choices and living reference are four different things, and the split test is
mechanical: why something was chosen is a decision, what is currently true is reference.
An accepted decision is immutable from then on, so changing course means a new record that
supersedes the old one by reference, never an edit and never a reopening, and the record
that was superseded stays readable as history.

**Here:** `AGENTS.md` keeps the board as the single authoritative task system and rules a
decision record immutable once accepted; decision:active-membership-grants-access and decision:notification-kinds-ship-with-producer supersede earlier records by new record
rather than by edit.

### Re-validate the premise, and record a deliberate gap as a ruling

A record written weeks ago quotes a tree that has moved. Before acting on it, run the
command that would falsify its premise against the current state and quote the output; if
the premise is false, the deviation is the work. Re-validation often finds that a recorded
gap is deliberate, in which case the outcome is a ruling that closes it, not a task that
rebuilds it. A limitation that is being accepted is recorded with its escalation path, and
the assertions around it are left honest rather than strengthened into flakes.

**Here:** `AGENTS.md` (Kata Workflow) carries the rule: re-validate a stale card's premise before starting.

### State the enforcement honestly

When what shipped is narrower than what a criterion claims, the criterion is the artifact
that gets corrected, not the code, and the honest statement of the boundary goes into the
record. A criterion that overstates enforcement is worse than none, because it reads as
proven. The same applies to a claim inside a record: a citation that does not survive
checking is corrected in place, with the replacement named, so the next reader does not
either re-derive it or trust it.

**Here:** decision:project-workspace-immutable keeps a deliberate exemption and names the remaining
bypass as a standing hazard.

### Fix the class, not the site

A finding is a defect shape, not one location. The change that fixes it fixes every site
of the same shape, and a sibling site is never its own separate item of work. A small
correction outside the current scope is handed to whoever integrates, as an exact patch,
rather than filed; a gap in a check is one line on the one hardening item; an unscoped idea
attaches to an open item. One item of work per outcome keeps the backlog readable as a
plan.

### Couple the record to the moment work lands

A register of what exists drifts unless something couples it to the event that changed
reality, and the event is work landing, not a scheduled re-audit. Choose the coupling by
measuring candidate signals on real history rather than by picking the one that sounds
right, take the one with usable precision, reject the one that fires falsely, and give it
an explicit per-row override so a legitimate non-delivery can be acknowledged rather than
worked around.

### Take the supported path, and pin what the toolchain cannot consume

Prefer the platform's own supported mechanism over bespoke automation that reimplements
it, especially when the bespoke version needs a long-lived credential nothing else needs.
Split deployable units along runtime boundaries rather than packaging two runtimes behind
a supervisor, so each deploys on its own. When a dependency's new major release is ready
but the tools that consume its interface are not, pin it explicitly rather than trusting
version ranges, put the pin everywhere it has to hold, and name the condition that lifts it.

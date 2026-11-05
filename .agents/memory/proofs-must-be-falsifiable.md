---
name: proofs-must-be-falsifiable
description: Four consecutive waves shipped green proofs that named something untrue; every new assertion must be mutation-proven RED before it counts
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3ffd3661-8616-4771-9911-c5bfe4d9300a
  modified: 2026-08-15T21:00:43.077Z
---

A passing test is not evidence until it has been shown to FAIL when the behavior it names is broken.
Four consecutive waves produced green proofs of things that were not true:

- **PBTT-278** — "typed content survives a type switch" passed *while the draft was being dropped*:
  react-hook-form's partial `reset()` leaves stale text in registered DOM inputs, so any
  `toHaveValue`-only proof of "content preserved" cannot fail.
- **PBTT-246** — "a pasted page URL renders that page" passed against a table stuck on page 1; the walk
  and the comparison were stale in the same direction.
- **PBTT-305** — "no horizontal page overflow" *could not fail*: the app shell's `overflow-hidden` makes
  page-level sideways scroll structurally impossible, and a forced 5000px table at 375px still passed.
- **PBTT-305 AC#3** — the gate asserts `table.width <= cap`, which passes at every viewport below 1872
  without testing anything, while its own comment claims the gap is solved. The gap is 612.95px at 1440.

**A poll that can match a transient is not a proof of a settled state** (wave 16, PBTT-375). A
board→list return test polled row identity and went GREEN under mutation against a stale frame served
from react-query's cache; only a later readout assertion caught it. Assert the thing that settles
(a readout, a URL, a confirmed response) FIRST, then poll the derived state against a settled fetch.

**A scan or wait gated on a readiness signal must wait for the thing it checks.** The members-table
axe scan waited for the metric tiles, which render before the table has rows, so it read an empty
`tbody` and passed, hiding three real contrast failures (3.04, 2.38, 4.28/3.53 against 4.5:1)
until TASK-160 made it wait for a row.

**Never pin a revert-probe's baseline to `HEAD`**: once the fix is committed, HEAD contains it
and the harness silently stops discriminating. Agents will argue a test *would* fail rather than
show it; make them show it. TASK-084: reverting one line turned 3 of 4 e2e tests red with the
literal production symptom, and showed the 4th read fixture records the fix never touches. The
probe also catches the already-fixed case: TASK-117 asked for a test failing against current
code after PR #132 had closed the hole, so the honest probe neutered the guard (`route.ts:47`)
and watched the test flip 404→200.

Also: **`test.fail()` is not a safe way to pin a known bug** — it goes green for ANY error in the body.
Pin the wrong behavior with an explicit assertion carrying a message that tells the fixer what to
replace.

**Why:** each of these was found only by deliberately trying to make the test fail. A proof that cannot
fail is worse than no proof, because it manufactures confidence and blocks the next agent from looking.

**How to apply:** for every new or changed assertion — break the behavior, show it RED with its message,
restore, show it GREEN, and quote both outputs. Derive the thing being asserted from the artifact
(e.g. build the meter-glyph list from `PRIORITY_METER` itself) rather than hand-writing it. Assert
absence in a way that can fail. Prove persistence across a reload, never from optimistic UI state.
Related: [[mock-call-assertion-undefined-keys]], [[feedback-independent-diff-review-before-commit]].

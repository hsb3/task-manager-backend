---
name: proofs-must-be-falsifiable
description: Consecutive waves shipped green proofs that named something untrue; every new assertion must be mutation-proven RED before it counts
metadata:
  node_type: memory
  type: feedback
---

A passing test is not evidence until it has been shown to FAIL when the behavior it names is broken.
Several waves produced green proofs of things that were not true: a "content preserved" check that
could not fail, a "pasted URL renders that page" check run against a stale page, a size assertion
that passed at every viewport without testing anything.

**A poll that can match a transient is not a proof of a settled state.** Assert the thing that
settles (a readout, a URL, a confirmed response) FIRST, then poll the derived state against it.

**A scan or wait gated on a readiness signal must wait for the thing it checks.** A scan that waits
for a signal that renders before the data reads an empty result and passes.

**Never pin a revert-probe's baseline to the current tip**: once the fix is committed, the tip
contains it and the harness silently stops discriminating. Agents will argue a test *would* fail
rather than show it; make them show it. The probe also catches the already-fixed case: a card asked
for a test failing against current code after a PR had closed the hole, so the honest probe
neutered the guard and watched the test flip 404 to 200.

Also: **pin a known bug with an explicit assertion on the wrong behaviour**, carrying a message that
tells the fixer what to replace — never an expected-failure marker, which goes green for ANY error in
the body.

**Why:** each of these was found only by deliberately trying to make the test fail. A proof that cannot
fail is worse than no proof, because it manufactures confidence and blocks the next agent from looking.

**How to apply:** for every new or changed assertion — break the behavior, show it RED with its message,
restore, show it GREEN, and quote both outputs. Derive the thing being asserted from the artifact
rather than hand-writing it. Assert absence in a way that can fail. Prove persistence across a
reload or a fresh read, never from an in-memory echo.

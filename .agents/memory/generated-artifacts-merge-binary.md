---
name: generated-artifacts-merge-binary
description: Generated artifacts carry `merge=binary` (since PR #775), so a conflicted one keeps OURS with NO conflict markers — resolve by regenerating, never by `git add`; every merge into main re-conflicts the next PR's artifacts, so expect one rebase per sibling landing
metadata:
  type: project
---

`.gitattributes` gives every generated artifact `merge=binary` (landed in PR #775). Git then
refuses to merge the file textually: on a conflict it leaves OURS on disk **with no conflict
markers at all**, and reports the path as conflicted. The file looks clean, opens clean, and
greps clean.

So the usual "open it and resolve the markers" reflex silently lands the pre-rebase version, and
`git add <path>` on it stages a stale artifact that the generator's own `--check` gate will
refuse — or worse, that matches by luck and ships drift.

**Resolve a conflicted generated artifact by running its generator, never by `git add`.** The
generators and their drift gates are listed in `AGENTS.md` (`gen_schema.ts`, `gen_openapi.ts`,
`gen_decisions.ts`, `gen_app_docs_seed.ts`, the model tree, the feature register).

Wave-scale consequence: every merge into `main` re-conflicts the next PR's generated artifacts,
so a lane landing behind a sibling should expect **one rebase per sibling landing**, each ending
in a regeneration rather than a resolution. Rebase immediately before the final gate run,
not earlier, so the gate proves the rebased tree.

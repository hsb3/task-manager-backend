---
name: railway-deploy-confirm-by-sha
description: "Confirm a Railway deploy by the commit sha reaching SUCCESS, never by a status word or CLI output: RUNNING means live, and railway redeploy prints nothing on success"
metadata:
  type: reference
---

Two Railway signals that read wrong:

- **`RUNNING` means LIVE, not building.** A healthy service's steady state is `RUNNING` on the
  active deployment beside `SUCCESS` on the previous one, so a loop waiting for `RUNNING` to clear
  never ends. Burned 10 minutes on 2026-08-08.
- **`railway redeploy` prints NOTHING on success**: exit 0, zero bytes, no deployment id, no URL.
  Not a failure and not a hang. (Whether to redeploy at all: `deploy/README.md`.)

`railway status --json` also exposes neither `source.checkSuites` nor the auto-deploy flag; those
need GraphQL ([[railway-env-duplication-traps]]).

**How to apply:** poll until the deployment's commit sha equals the one you expect with status
`SUCCESS` (`railway status --json`, `meta.commitHash` against `git rev-parse HEAD`).

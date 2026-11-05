---
name: feedback-local-first-testing
description: "Henry's ruling 2026-07-26 — test against local backend+frontend first; hit live prod only when it's the actual gate"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 77e59465-3d4f-4896-8a13-0ff076ce40bd
---

Henry (2026-07-26): "ideally we'd be testing as much as we can with local backend/frontend
running and reserve testing for live app only when necessary... e2e can/should certainly test
against a live version of the app, i believe we should test first locally so we can cycle
faster."

**Why:** local cycles are fast and free; every live-prod probe costs deploys, OTP relays, and
real user-facing risk. Most of this repo's suites already run on local clean rooms — the
ruling generalizes that: prod proofs are for the few claims only prod can prove.

**How to apply:** wave plans put every verifiable criterion on a LOCAL room/dev-server gate
first; a prod ("V-*-PROD") gate exists only when the claim is about prod itself (deploy
wiring, live delivery, live data). E2e may add a live-smoke variant but the primary suite
runs local. See [[project-pocketbase-course-state]].

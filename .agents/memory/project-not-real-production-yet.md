---
name: project-not-real-production-yet
description: The deployed app has no real users yet — lowers urgency on production-hardening items until that changes
metadata: 
  node_type: memory
  type: project
  originSessionId: 5a310b05-de6b-4c94-b9e4-e41a1b027ac9
---

Henry noted (2026-07-30, while deferring the Dependabot re-enable; reaffirmed 2026-08-06) that the
Railway-deployed app isn't a real "production" yet — there are no real users on it. Railway's
*environment* is literally named `production` (see CLAUDE.md's Deploy section, `.claude/operations/
railway.md`) — that's just Railway's env-naming convention, not a claim about the app's actual
status. Don't infer real-world urgency from the environment name.

**Why:** HANDOFF's owner's-court section carries a couple of items gated on "when it becomes a daily
driver" or "at a stable frontend" (external uptime paging via Railway webhooks + Cloudflare,
re-enabling `automated-security-fixes`/Dependabot). Those triggers haven't fired — this is still a
personal/dev deployment, not a live product with users depending on it.

**How to apply:** don't treat prod-hardening gaps (paging, Dependabot, aggressive security posture)
as urgent right now — they're legitimately deferred, not neglected. Re-evaluate once real users are
on it (a state change worth updating this memory for) or when TASK-020 lands the new frontend
service, whichever the owner calls first. See [[feedback-owner-authorized-deploy-clis]] for the
TASK-020 deploy-CLI authorization this same conversation covered.

**Release gate (owner ruling 2026-09-17):** before ANY public release, either institute a cap
(workspace/member count) or fix the data architecture. Card dpn2 (member item list fails after
30 s at ~500 workspaces; view rules scale with the whole workspaces table) is TABLED, not fixed:
the model grew organically and more fields/relationships are still coming, so the table/field
relationship redesign waits for the model to settle. Do not queue-jump dpn2; do not call a
release "public-ready" while it is open without the cap.

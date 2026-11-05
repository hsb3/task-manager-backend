# Deploy (context, session-owned)

This repo deploys one Railway service (decision-009/decision-011): `pocketbase` (API +
`/_/` dashboard, watch patterns `Dockerfile, pb_migrations/**, pb_hooks/**`, domain
`admin.tasks-pocketbase.functionform.ai`). Pushes to `main` are CI-gated; the service
deploys only when its watch patterns are touched. A refused boot migration makes `migrate up` and `serve` exit 1 and `serve` never binds
(measured 2026-09-16, PB 0.40.4; 0.39.9 exited 0 with only an `Error:` line), and the image
preflights migrations before `serve` and refuses on a non-zero exit: a refused migration or an
invalid cron variable shows as a FAILED deploy, named on a `failed to apply migration` line
(a refused migration) or an `Error:` line (an invalid cron variable) in its log, beside a `FATAL: PocketBase refused to start` line.
Every pocketbase deploy stops the old container before the new one starts, on a good and on a refused
deploy, with overlap/draining 30 set (measured, tqfb): the stop-to-start gap is ~2 s and service returns once
the new container is healthy, and a refused boot migration is an outage until a good build is deployed
(recovery: `deploy/README.md`, "When a pocketbase deploy fails"). Railway's docs give the cause: a
volume-backed service runs one deployment at a time, and pre-deploy commands get no volume.
Production is the only standing environment — it deploys from `main`
(Railway MCP `list-services` / `describe-environment`, 2026-09-21; the CLI equivalents,
`railway status --json` and `railway deployment list --service <svc> --environment production
--json`, need the `railway link` below first). The `staging` environment no longer exists and
the `legacy` branch is history only. PR environments are DISABLED (owner, 2026-09-21, sign-off record 6vpz). They were enabled
for one day and measured on PRs #773 to #775: each PR got an ephemeral copy of production's
CONFIGURATION: the PR pocketbase carried production's bucket names and S3 credentials (`railway variables` on
task-manager-pr-773; details on c25c). A PR service builds only when the PR touches its watch
patterns, so the runtime consequence never fired before the switch-off. Do not re-enable them
without a safe base environment (no S3, no Resend, no OAuth, no cron). c25c's refused-boot
rehearsal uses a throwaway environment created at rehearsal time, owner-run. Prod access needs no runbook:
`railway link --project task-manager --environment production --service pocketbase`, then
`railway ssh --service pocketbase --environment production <cmd>` runs inside the container.
`railway environment new … --duplicate production` re-links the current directory to the NEW
environment: run `railway environment production` right after, or later commands there hit the throwaway.
Recipes and the failures that bit are in `deploy/README.md`;
`deploy/railway/set_railway_superuser.sh` wraps that same ssh idiom to set the prod superuser
without the password hitting shell history.

The production topology is code: `deploy/railway/railway.ts` (services incl. watch patterns,
domains, healthchecks; the pb_data volume + mount; the `pb-backups` and `pb-files`
buckets; every variable NAME with its value held server-side as `preserve()` — secrets
never in git). `railway config plan` diffs it against live; it no longer declares the live web
services and names this repo as the source, so review the plan and do not apply it until those web
services are retired on purpose. `railway config apply` recreates the topology elsewhere. NOT captured: secret values (bucket creds
re-issuable via `railway bucket credentials`; the rest live only in the Railway dashboard —
`.claude/operations/` is untracked and machine-local, so nothing parked there travels
between the two Macs), the ephemeral PR
environments (the pull is production-scoped), DNS CNAMEs at the registrar, and the
GitHub OAuth app callback.
Setting all of that up on a new project, in order: `deploy/README.md`, "Bootstrapping a new Railway project".

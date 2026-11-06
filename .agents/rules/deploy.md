---
paths:
  - "deploy/**"
  - ".github/workflows/**"
  - "scripts/replay_backup.sh"
---

# Deploy: Railway topology and the traps the recipes do not cover

Recipes and most failures that bit live in `deploy/README.md`; this file is the topology plus
what that file does not say. Where a README section covers a point, it is named, not repeated.

## Topology

- One Railway service, `pocketbase` (API + `/_/` dashboard), in one standing environment,
  `production`, deploying from `main`. `staging` no longer exists; the `legacy` branch is history.
- The topology is code: `deploy/railway/railway.ts` (watch patterns, domain, healthcheck, the
  pb_data volume, the `pb-backups` and `pb-files` buckets, every variable NAME as `preserve()`,
  values never in git). `railway config plan` diffs it against live; it no longer declares the
  live web services and names this repo as the source, so review the plan and do not apply it
  until those web services are retired on purpose. NOT captured: secret values (bucket creds
  re-issuable via `railway bucket credentials`, the rest only in the Railway dashboard), DNS
  CNAMEs, and the GitHub/Google OAuth callbacks (the Google pair is in the IaC, not yet set in
  prod). New project, in order: `deploy/README.md`, "Bootstrapping a new Railway project".
- Pushes to `main` are CI-gated, and the service deploys only when a watch pattern is touched;
  how that gate fails open and closed: `deploy/README.md`, "Deploy gating".
- PR environments are DISABLED (owner, 2026-09-21, sign-off record 6vpz): each PR env copied
  production's CONFIGURATION, bucket names and S3 credentials included (c25c). Do not re-enable
  them without a safe base environment (no S3, no Resend, no OAuth, no cron). A refused-boot
  rehearsal uses a throwaway environment created at rehearsal time, owner-run (c25c).
- Prod access needs no runbook: `railway link --project task-manager --environment production
  --service pocketbase`, then `railway ssh --service pocketbase --environment production <cmd>`
  runs inside the container (binary `/pb/pocketbase`, data `/pb/pb_data`, not `/app`). The
  Railway CLI equivalents of an MCP read (`railway status --json`, `railway deployment list`)
  need that `railway link` first.
  `deploy/railway/set_railway_superuser.sh` wraps that idiom so the password skips shell history.
  `.claude/operations/` is machine-local: nothing parked there travels between the two Macs.

## Deploys

- **Teardown line.** Every pocketbase deploy stops the old container before the new one starts,
  on a good and on a refused deploy, even with overlap/draining 30 set (measured, tqfb): a good
  deploy has a ~2 s gap and serves again once the new container is healthy; a refused boot
  migration is an outage until a good build is deployed. Railway's docs give the cause: a
  volume-backed service runs one deployment at a time, and pre-deploy commands get no volume.
  Recovery: `deploy/README.md`, "When a pocketbase deploy fails";
  ruling: decision:refused-migration-fails-the-deploy.
- A refused boot migration makes `migrate up` and `serve` exit 1 and `serve` never binds
  (measured PB 0.40.4), and the image preflights migrations before `serve`: a refused migration
  or an invalid cron variable is a FAILED deploy, named on a `failed to apply migration` line
  (migration) or an `Error:` line (cron variable) beside `FATAL: PocketBase refused to start`.
- Confirm a deploy by its commit sha reaching `SUCCESS` (`railway status --json`,
  `meta.commitHash` against `git rev-parse HEAD`), never by a status word or CLI output:
  `RUNNING` is the LIVE steady state, so a loop waiting for it to clear never ends, and
  `railway redeploy` prints nothing on success (exit 0, zero bytes). `railway status --json`
  exposes neither `source.checkSuites` nor the auto-deploy flag; read those over GraphQL.

## Railway CLI and GraphQL, beyond `deploy/README.md` "Railway CLI and GraphQL"

- The deploy branch is not a service field: it lives on a deployment trigger, one per
  (environment, service), set with `deploymentTriggerUpdate(id, {branch, checkSuites})` and
  listed by `project(id){deploymentTriggers{edges{node{id branch environmentId serviceId}}}}`.
  Each other route fails quietly: `railway environment edit --service-config <name>
  source.branch` answers "No changes to apply" (keyed by service ID, and `source.branch` is not
  writable there either); the MCP `connect-service-source` applies to the service in ALL
  environments, so on a duplicated env it repoints production; the MCP `update-service` excludes
  source changes. Afterwards re-read production's triggers: `main`, `checkSuites: true`.
- `railway environment new … --duplicate production` re-links the directory to the NEW
  environment: run `railway environment production` right after.
- Raw GraphQL answers `403 error code: 1010` (Cloudflare) without a `User-Agent` header
  (`railway-cli/5.49.4` passed). Read the bearer with `jq -r '.user.accessToken // .user.token'`
  and never echo it; the `use-railway` skill's `railway-api.sh` reads `.user.token` only
  (hsb3/dotfiles-agents#291).
- `scripts/seed.ts`'s `load_env()` copies every key of the gitignored `.env` not already in
  `process.env` into its environment and so into every subprocess; that carries a
  `RAILWAY_API_TOKEN` scoped elsewhere, so a `railway` call it spawns fails `Unauthorized`: unset
  it in the shim. To seed a deployed environment past superuser MFA, point `PB_BIN` at a shim that
  forwards `superuser otp` to `railway ssh … "/pb/pocketbase superuser otp <email> --dir
  /pb/pb_data"`; seed.ts parses only `Id:` / `Pass:` from the output.
- Re-adding a custom domain to any service issues a NEW CNAME target: update the record at the
  DNS host (Cloudflare, for functionform.ai) every time, before testing the hostname.

## Buckets, beyond `deploy/README.md` "Backups and object storage"

- Bucket creds are never stored at rest locally (TASK-010): fetch on demand with
  `railway bucket credentials --bucket <name> --json`. The secret-free backup-landed proof is
  `railway bucket info`'s object count incrementing across a cron run.
- Uploads have their own bucket, `pb-files`, wired to `settings.s3` by `pb_hooks/files.pb.js`
  from `PB_FILES_S3_*`; `pb-backups` is backups only (decision:backups-recovery). The README's
  curl pitfalls and CLI recipes apply to both; the working `curl --aws-sigv4` list and download
  calls are in `scripts/replay_backup.sh`. Every PocketBase auto-backup key starts with `@`.
- Prod `PB_BACKUPS_CRON` is `08 18 * * *` (daily 18:08 UTC, read 2026-11-06), not the hook
  default of 03:00.

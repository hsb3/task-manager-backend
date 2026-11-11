---
title: Deployment recipes
status: current
version: 15
updated: 2026-11-10
---

# Deployment recipes

Hand-written deployment configuration and operational recipes. These recipes may not carry a
credential, a resource id, or a live URL; those stay in `.claude/operations/` (untracked).
Anything that cannot be stated without one belongs there, not here.

Run these commands from the repository root. Application images are defined by
`Dockerfile`. Railway configuration
and its preview/apply commands are in [railway/README.md](railway/README.md).

## Local

`make local-up` builds the `Dockerfile` and `services/mcp/Dockerfile` images and runs them at `http://127.0.0.1:8090` (API) and `http://127.0.0.1:8089` (MCP service), each `+ PB_PORT_OFFSET`, with `pb_data` in a named volume; `make local-logs` follows the log and `make local-down` removes the containers. Drop the data too with `docker compose -f deploy/local/compose.yaml down -v`. No superuser, mail, S3 or OAuth is configured. `make smoke` builds the same images under its own compose project on free ports, runs the live probes in `e2e/smoke.ts` against them, and removes the containers, volume and image tags whatever the result. Files: [local/compose.yaml](local/compose.yaml).

## Bootstrapping a new Railway project

On a new project, `railway config apply` creates the services, the volume and the buckets, but
every variable `deploy/railway/railway.ts` marks `preserve()` is a name with no value (inferred:
`preserve()` keeps an existing value, and a new project has none; not yet run against an empty
project), and the custom domains are not registered. The manual steps, in order (steps 2 to 4
are independent of each other):

1. **Apply without the custom domains, then add them.** `railway config plan` and `apply` refuse
   the WHOLE configuration while it declares a custom domain the project lacks ("Custom-domain
   registration is not supported by Railway configuration. Add <domain> in the dashboard, then
   run railway config pull.", measured from `config plan`). So: delete the `domains:` entry
   from `deploy/railway/railway.ts`, run `railway config apply`, add the
   pocketbase domain on its service in the dashboard, create at the registrar the CNAME record
   Railway shows for it, `git restore deploy/railway/railway.ts`, and confirm
   `railway config plan --detailed-exit-code` exits 0. This order is derived from the measured
   refusal, not run on an empty project. Every URL below depends on this domain.
2. **Bucket credentials.** `railway bucket credentials --bucket pb-backups --json` and the same
   for `pb-files` print each bucket's S3 name, endpoint, region, access key and secret (read-only;
   `--reset` rotates them, see Backups below). Use the S3 name it reports, not the resource name.
3. **Resend.** An API key from the Resend dashboard; a sender on a domain verified there if mail
   must reach anyone but the Resend account owner.
4. **OAuth apps (GitHub, Google; either, both or neither).** Create each with the authorization
   callback URL of the client app that runs the flow, which is the client's own route, not
   PocketBase's `/api/oauth2-redirect`. Each app issues its client id and secret.
5. **`pocketbase` variables, all before its first boot.**

   | variable                                                                 | what it does                                                                                                             | value comes from                                                                                                                                               |
   | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD`                            | the image creates this superuser on boot (`Dockerfile` CMD, `create` only)                                               | owner's choice; the address must receive mail (login is MFA by emailed code), and until a Resend domain is verified only the Resend account owner's inbox does |
   | `RESEND_API_KEY`                                                         | turns on real mail through Resend's SMTP bridge (`pb_hooks/mail.pb.js`)                                                  | Resend dashboard (step 3)                                                                                                                                      |
   | `MAIL_SENDER_ADDRESS`                                                    | the From address                                                                                                         | an address on the Resend-verified domain; unset, Resend's sandbox sender                                                                                       |
   | `PB_PUBLIC_URL`                                                          | the link base in verification and password-reset emails, which open PocketBase's own confirmation pages                  | `https://<pocketbase domain>` (step 1)                                                                                                                         |
   | `PB_CORS_ORIGINS`                                                        | the CORS allowlist `serve` gets as `--origins` (`Dockerfile`)                                                            | the client app's origin; unset, `*`                                                                                                                            |
   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                               | enable GitHub sign-in (`pb_hooks/oauth.pb.js`); both or neither                                                          | GitHub OAuth app (step 4)                                                                                                                                      |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                               | enable Google sign-in (`pb_hooks/oauth.pb.js`); both or neither; a missing pair leaves that provider off, logged at boot | Google OAuth client (step 4)                                                                                                                                   |
   | `APP_ADMIN_EMAILS`                                                       | comma-separated accounts, besides the superuser, allowed to approve new signups (`pb_hooks/routes.pb.js`)                | owner's choice                                                                                                                                                 |
   | `ALERT_EMAIL`                                                            | recipient of the error-rate alert mail (`pb_hooks/alerts.pb.js`); needs `RESEND_API_KEY`                                 | owner's choice                                                                                                                                                 |
   | `PB_BACKUPS_S3_BUCKET`, `_ENDPOINT`, `_REGION`, `_ACCESS_KEY`, `_SECRET` | send backups to S3 (`pb_hooks/backups.pb.js`); bucket and secret both, or local backups on the volume                    | `pb-backups` credentials (step 2)                                                                                                                              |
   | `PB_BACKUPS_CRON`, `PB_BACKUPS_CRON_MAX_KEEP`                            | backup schedule and how many to keep; an invalid schedule refuses boot                                                   | owner's choice; unset, daily 03:00 UTC and 30, but only while S3 backups are on (without them there is no backup cron)                                         |
   | `PB_FILES_S3_BUCKET`, `_ENDPOINT`, `_REGION`, `_ACCESS_KEY`, `_SECRET`   | store uploaded files in S3 (`pb_hooks/files.pb.js`); bucket and secret both, or files on the volume                      | `pb-files` credentials (step 2)                                                                                                                                |

   What a missing one costs on the first boot: no superuser means no dashboard login (PocketBase's
   one-time installer link is unchecked behind Railway) until the variables are set and `pocketbase` redeploys (or `deploy/railway/set_railway_superuser.sh create <email> <password> --env production`
   runs); no `RESEND_API_KEY` means no OTP mail, so the superuser still cannot log in; no
   `PB_FILES_S3_*` means uploads land on the volume and are not moved to S3 when it is switched on
   later (`pb_hooks/files.pb.js` only repoints the storage setting).
   Every other variable is re-read on each boot, so setting it later and redeploying is enough.

6. **Deploy-failure alert.** Re-create the notification rule in
   "When a pocketbase deploy fails" below; it is not in the IaC.
7. **Verify.** The healthcheck is green, the superuser logs into `/_/` with its emailed code, and
   `GET /api/collections/users/auth-methods` lists each configured provider (`github`, `google`)
   under `oauth2.providers`.

## When a pocketbase deploy fails

A refused boot migration takes pocketbase down until a good build is deployed; the old
container is already stopped (`.agents/rules/deploy.md`, the teardown line). The owner
accepts that outage; the response is an alert and this manual recovery. Measured in throwaway
environments unless marked. Why nothing catches it earlier (Railway mounts no volume at pre-deploy time,
and the start guard replays against the volume itself because a refused run records no migration and
changes no application data) and the
prior art weighed: decision:refused-migration-fails-the-deploy. The start command is proven as written in
`tests/test_boot_refusals.ts` §5: against a planted hook-refused migration it exits non-zero naming the
migration, writes no superuser, never binds, and records neither planted migration.

1. **Signal.** A project-level Railway notification rule sends email and in-app notifications on
   `Deployment.failed` and `Deployment.crashed`, for every non-ephemeral environment. It is not in
   `deploy/railway/railway.ts` (the IaC SDK has no notification field, only volume usage alerts)
   and the CLI has no command for it. Create it through the GraphQL API at
   `https://backboard.railway.com/graphql/v2`:

       notificationRuleCreate(input: {workspaceId: "<workspace id>", projectId: "<project id>",
         eventTypes: ["Deployment.failed", "Deployment.crashed"],
         channelConfigs: [{type: "email"}, {type: "inapp"}], ephemeralEnvironments: false})

   Read it back with `notificationRules(workspaceId: "<workspace id>", projectId: "<project id>")
{ eventTypes channels { config } ephemeralEnvironments }`. Auth is the CLI's OAuth token
   (`user.accessToken` in the Railway CLI's `config.json`; `user.token` is refused) plus a
   `User-Agent` header (see Railway CLI and GraphQL below). A fire test's failed deploy delivered
   the email.

2. **Confirm.** `railway deployment list --service pocketbase --environment production` shows the
   newest row FAILED; its log carries `failed to apply migration <file>` and
   `FATAL: PocketBase refused to start`.
3. **Restore.** Roll back to the newest SUCCESS deployment: with `deploymentRollback(id: "<deployment id>")`, or in the dashboard (pocketbase service,
   Deployments, that deployment's menu, Rollback; the dashboard path was not exercised).
   Measured: the rollback created a new SUCCESS deployment and `/api/health` answered 200 about
   13 s after the call.
4. **Never `railway redeploy` / `railway deployment redeploy` here.** It redeploys the LATEST
   deployment, which is the failed one; measured, it produced a second FAILED deployment.
5. **Fix main.** Revert the refused migration by PR. Until main is fixed, the next pocketbase
   deploy from main fails the same way (its watch patterns include `pb_migrations/**`).

## Deploy gating

- **A green prod deploy proves the service BOOTED, never that its code passed CI.** What gates
  promotion is the `/api/health` healthcheck, not the tests.
- **Railway's `source.checkSuites` toggle fails OPEN.** It waits only for a check suite that
  already EXISTS at deploy-decision time, and GitHub can create the run long after Railway
  shipped (measured: up to 27 minutes), so the fix is a bounded WAIT for the run to appear and
  then a hard fail.
- **The same toggle also fails CLOSED, the other way:** if the FIRST CI run on a main push
  fails, Railway marks that deploy SKIPPED permanently — a green rerun does NOT resurrect it.
  Recover with a trivial watch-path push or `environmentTriggersDeploy`. Always check
  `railway deployment list` after a rerun. (A SKIPPED deploy reading "No changes to watched
  files" is just the watch patterns working.)
- **A commit that failed CI and was re-run green will still deploy** under any gate that reads
  `filter=latest` jobs, and a run-level `conclusion` can be green over a skipped required job
  (both in GitHub Actions API gotchas below). Decide deliberately whether that is acceptable; it
  is invisible otherwise.
- **Verify branch protection by what APPLIES, not by reading the ruleset.** A ruleset that both
  INCLUDES `~DEFAULT_BRANCH` and EXCLUDES `refs/heads/main` protects NOTHING, because main is
  the default branch — yet the ruleset page still reads as active.

      gh api repos/<owner>/<repo>/branches/main --jq .protected   # false = unprotected
      gh api repos/<owner>/<repo>/rules/branches/main             # [] = nothing applies

  Any repo-side deploy gate is self-enforced while this is open: one push carrying both a
  payload and a rewritten CI workflow satisfies a gate that checks job names and conclusions.

## Shell gotchas that silently invert a CI verdict

- **`printf … | grep -q` under `set -o pipefail` reports NO MATCH when it matched.** `grep -q`
  exits the instant it matches, the writer takes `SIGPIPE` (exit 141), and `pipefail` makes the
  whole pipeline 141 — so `if` takes the FALSE branch. It only bites once the data exceeds the
  pipe buffer (~64KB), so it is **nondeterministic and passes every small test**. Measured on
  this repo's own path text: correct at 44KB, wrong at 67KB and above.

      if grep -qE '^pb_hooks/' <<< "$files"; then      # here-string: no pipe, no SIGPIPE

  Any `big | grep -q`, `big | head`, `big | first-match-and-exit` under `pipefail` is the same
  bug. Reach for a here-string, `case`, or `[[ =~ ]]`.

- **`git diff --name-only` QUOTES a path** containing non-ASCII, a double quote, a backslash or
  a tab — the leading `"` then defeats any `^` anchor. `core.quotePath=false` fixes only the
  non-ASCII third; the other three stay quoted. `--name-only -z` (plus `tr '\0' '\n'`) is the
  form that emits every path raw.
- **`git diff --name-only` prints only the DESTINATION of a rename.** Moving a file out of a
  watched directory reads as "that directory is unchanged". `--no-renames` emits both paths.
- **`git show --name-only` on a merge commit prints nothing** (combined diffs suppress
  non-conflicting files). Use the two-tree `git diff A B` form.

## GitHub Actions API gotchas

- **A run's `conclusion` and its per-job conclusions answer different questions.** A run can
  conclude `success` while a required job was `skipped`, so assert per job. But per-job
  assertion alone leaves any job not named completely un-gated — assert BOTH.
- **`/runs/{id}/jobs?filter=latest` hides earlier attempts**, so a commit that failed CI and was
  re-run green looks unblemished. `filter=all` shows the truth. `filter` also silently defaults
  to `latest`, and a typo'd value is ignored rather than rejected.
- **The `compare` endpoint caps `files` at 300 and `--paginate` cannot lift it** — pagination
  pages over _commits_; page 2 carries no `files` key at all and gh aborts with
  `cannot iterate over: null`. The array is path-ordered, so late-alphabet directories are the
  ones truncation drops.

## Railway CLI and GraphQL

- In-container commands are `railway ssh --service --environment`; **`railway run` executes
  LOCALLY**. Pass `-e production` explicitly — `railway environment new --duplicate` auto-LINKS
  the CLI to the NEW environment, so every later command silently targets it.
- **`railway variables --unset` does not exist** — it is `railway variable delete`, and a
  variable DELETE does NOT auto-deploy while a `--set` does. Start any "why didn't my config
  change take effect" hunt here.
- **`railway redeploy` reuses the ORIGINAL deployment's cached build settings** even after they
  change.
- GraphQL bearer is the `user.accessToken` field of the Railway CLI's `config.json`, NOT `user.token`.
  Railway returns GraphQL errors with **HTTP 200**, so a curl exit status proves nothing —
  check for an `errors` key explicitly.
- Deploy control is three mutations:
  - `serviceInstanceDeployV2(commitSha, environmentId, serviceId)` — deploys an EXACT commit;
    the only form that cannot race a moving `main`.
  - `environmentTriggersDeploy(input: {projectId, environmentId, serviceId})` — deploys the
    trigger branch's current TIP. Deploys _through_ the trigger, so deleting the deployment
    trigger destroys this escape hatch.
  - `serviceInstanceAutoDeployUpdate(input: {enabled, projectId, environmentId, serviceId})` —
    the switch that turns push auto-deploy off. Neither `deploymentTriggerUpdate` (only
    `branch`/`checkSuites`/`repository`/`rootDirectory`) nor `serviceInstanceUpdate` can do it.
    Scalar service config (`healthcheckPath`, `healthcheckTimeout`, `watchPatterns`,
    `rootDirectory`, `dockerfilePath`) is `serviceInstanceUpdate`.
- **A volume "id" is a GROUP id shared across environments**; the per-env `volumeInstances` are
  distinct. The CLI and variables views show the same id for both and look like staging is
  sitting on prod's data when it isn't — confirm via `project.volumes.volumeInstances`.

## Backups and object storage

- **`railway bucket credentials --json` is READ-ONLY; `--reset` is the rotation** — it
  invalidates the keys currently in the `PB_BACKUPS_S3_*` variables and silently breaks the
  backup cron until they are re-set. Check liveness without touching a secret:
  `railway bucket info --bucket <name> --json` (object count + bytes).
- **`curl --aws-sigv4` DELETE 403s `SignatureDoesNotMatch` on a key starting with `@`** unless
  the `@` is percent-encoded as `%40` in the request path. GET and list are unaffected.
- Bucket credentials may report `urlStyle: virtual-host` while PATH-style requests work (the
  backups hook hard-sets `forcePathStyle: true`). Believe the probe, not the field.
- **PB's `restoreBackup` is UNIX-only, experimental, and restarts PID 1 in place**, swapping
  `pb_data` under the mounted volume via `os.Rename` — a documented failure mode on network
  mounts (PB issue #4647). Rehearse against a THROWAWAY instance pointed at the same bucket,
  never as a live-prod click. Fallback: download the archive, unzip into a fresh `pb_data`, boot.
- **A restore's 204 is ASYNC** — the old process keeps answering `/api/health` for several more
  seconds. Poll past the restart (~10-15s) or the read sees pre-swap state.
- `createBackup` needs ≥2× `pb_data` free and a restore needs ≥2× the archive; `cronMaxKeep`
  bounds the BUCKET, not the volume. Let PB autogenerate backup names and space creates out — an
  explicit name, or a second create in the same second, can 400 on a collision.

## Replaying production data against the migration set

`.github/workflows/backup-replay.yml` (manual `workflow_dispatch` plus weekly, Monday 06:17 UTC) downloads
the newest zip from the `pb-backups` bucket and runs `scripts/replay_backup.sh`: unzip into a scratch
`pb_data`, then the Dockerfile's `migrate up` preflight with the repo's `pb_migrations` and `pb_hooks`.
A refusal fails the run and prints the migration. It is the earlier catch for a migration that replays on an
empty database but is refused by production data (accepted risk in
decision:refused-migration-fails-the-deploy); it does not gate a deploy.

- **Repository secrets the owner must set** (same names as the Railway variables; values from
  `railway bucket credentials --bucket pb-backups --json`): `PB_BACKUPS_S3_BUCKET`,
  `PB_BACKUPS_S3_ENDPOINT`, `PB_BACKUPS_S3_REGION`, `PB_BACKUPS_S3_ACCESS_KEY`, `PB_BACKUPS_S3_SECRET`.
  Without them the run fails before any download, naming the missing variable. The run also refuses a newest backup older than
  `PB_BACKUPS_MAX_AGE_DAYS` (default 2). Rotating the bucket keys
  (`--reset`) means updating these too.
- **Zip layout (measured):** `data.db`, `auxiliary.db` and `types.d.ts` at the zip root, no
  wrapping directory (measured on a room with no uploaded files).
- **Local run, no network:** `bash scripts/replay_backup.sh --zip PATH [--migrations-dir DIR]`.
- **Not exercised against the real bucket**; the download path was proven only up to key selection on a sample listing.

## PocketBase in production

- **Clients reach realtime directly on this service's public domain** (the direct-SSE realtime
  channel), so that domain MUST serve `/api/realtime` to clients outside Railway.

- **A prod deploy's stdout is banner-only** — hook and migration logger output goes to the
  `_logs` DB, so `Applied <migration>` lines never appear in the deploy log. Prove a migration
  ran by READBACK of a value only it writes; PB aborts boot on a failed migration, so one
  readback vouches for that whole boot's set.
- **Superuser login is MFA-gated and owner-assisted.** Password alone returns 401 `{mfaId}`; the
  flow is auth-with-password → request-otp (emailed code) → auth-with-otp, and the `/_/`
  dashboard walks the same step. An agent cannot finish it alone. **A superuser address that
  cannot RECEIVE its own OTP is a permanent lockout.**
- Impersonation is `POST /api/collections/users/impersonate/{id}` — NOT `.../records/{id}/...`.
- **`statuses.color` is a NAMED-PALETTE select** (`gray`/`red`/…/`pink`); a hex value 400s.
- **The rate limiter counts Railway's `X-Real-IP`, rightmost entry, never `X-Forwarded-For`**
  (decision:rate-limit-counts-x-real-ip). The rightmost `X-Forwarded-For` hop is a varying edge
  IP, which would split buckets per request, and Railway documents nothing about an inbound
  `X-Forwarded-For`, so its leftmost entry may be client-supplied.
- **Settings secrets are PLAINTEXT at rest in `pb_data/data.db`** — the S3 secret, the SMTP
  password and any OAuth secret, unless the boot CMD passes `--encryptionEnv`. It does not.
- **Proving transactional/alert mail was DELIVERED needs no inbox access** — Resend's
  `GET /emails` reports `last_event: delivered`. `ALERT_SELFTEST=1` arms a one-shot send on the
  first request after boot; unset it afterwards or every deploy emails.

## The MCP service

The `mcp` Railway service is the hosted MCP endpoint (`services/mcp/`), built from `services/mcp/Dockerfile`. It deploys when a watch pattern is touched: `services/mcp/**`, `clients/tm/src/**`, `clients/tm/package.json`, `package.json`, `bun.lock`. It is created by the runbook in `openspec/changes/hosted-mcp-endpoint/design.md`, Phase 10; the entry for `mcp` in `railway/railway.ts` records what that runbook creates by CLI, so `railway config plan` proposes no change to it. `make local-up` serves it on 8089 (`+ PB_PORT_OFFSET`).

| Service | Variable | Value on Railway | If missing |
| --- | --- | --- | --- |
| mcp | `PORT` | Railway-provided | 8080 |
| mcp | `MCP_HOST` | unset (listens on `::`) | `::` |
| mcp | `MCP_INTERNAL_PORT` | `8081` | 8081 |
| mcp | `PB_INTERNAL_URL` | `http://${{pocketbase.RAILWAY_PRIVATE_DOMAIN}}:<pocketbase PORT>` | exit 1 |
| mcp | `PB_PUBLIC_URL` | `${{pocketbase.PB_PUBLIC_URL}}` | exit 1 |
| mcp | `MCP_PUBLIC_URL` | `https://mcp.<API host>` | exit 1 |
| mcp | `MCP_INTERNAL_SECRET` | 64 hex characters, shared with pocketbase | exit 1 |
| mcp | `MCP_ALLOWED_ORIGINS` | unset | `https://claude.ai,https://www.cursor.com` |
| pocketbase | `MCP_INTERNAL_SECRET` | same value | exemption off; metadata-document clients refused |
| pocketbase | `MCP_INTERNAL_URL` | `http://${{mcp.RAILWAY_PRIVATE_DOMAIN}}:8081` | metadata-document clients refused |
| pocketbase | `MCP_PUBLIC_URL` | same as mcp's | any `resource` parameter answers `invalid_target` |

## Operator scripts

Run against an already-running server or an offline copy; each script's header is its manual.

- `scripts/transfer_workspace_ownership.ts`: break-glass hand-over of a workspace to an active
  member as superuser; dry run unless `--yes`.
- `scripts/bulk_load_projects.ts`: one-time bulk project load into one workspace; dry run unless
  `--yes`; re-running resumes.
- `scripts/utilities/email_collision_audit.ts`: offline audit of a `data.db` copy for users that
  would collide under the email fold.

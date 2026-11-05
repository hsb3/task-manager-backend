---
title: Deployment recipes
status: current
version: 11
updated: 2026-10-24
---

# Deployment recipes

Reusable deploy/infra recipes and gotchas, lifted out of the untracked ops log (TASK-016).

Hand-written deployment configuration and operational recipes. These recipes may not carry a
credential, a resource id, or a live URL; those stay in `.claude/operations/` (untracked).
Anything that cannot be stated without one belongs there, not here.

Run these commands from the repository root. Application images remain defined by
`Dockerfile` and `web/Dockerfile`; stack orchestration lives here. Railway configuration
and its preview/apply commands are in [railway/README.md](railway/README.md).

## Bootstrapping a new Railway project

On a new project, `railway config apply` creates the services, the volume and the buckets, but
every variable `deploy/railway/railway.ts` marks `preserve()` is a name with no value (inferred:
`preserve()` keeps an existing value, and a new project has none; not yet run against an empty
project), and the custom domains are not registered. The manual steps, in order (steps 2 to 4
are independent of each other):

1. **Apply without the custom domains, then add them.** `railway config plan` and `apply` refuse
   the WHOLE configuration while it declares a custom domain the project lacks ("Custom-domain
   registration is not supported by Railway configuration. Add <domain> in the dashboard, then
   run railway config pull.", measured from `config plan`). So: delete the `domains:` entries
   from `deploy/railway/railway.ts`, run `railway config apply`, add the web domain and the
   pocketbase domain on their services in the dashboard, create at the registrar the CNAME record
   Railway shows for each, `git restore deploy/railway/railway.ts`, and confirm
   `railway config plan --detailed-exit-code` exits 0. This order is derived from the measured
   refusal, not run on an empty project. Every URL below depends on these domains.
2. **Bucket credentials.** `railway bucket credentials --bucket pb-backups --json` and the same
   for `pb-files` print each bucket's S3 name, endpoint, region, access key and secret (read-only;
   `--reset` rotates them, see Backups below). Use the S3 name it reports, not the resource name.
3. **Resend.** An API key from the Resend dashboard; a sender on a domain verified there if mail
   must reach anyone but the Resend account owner.
4. **GitHub OAuth app.** Create it with the authorization callback URL
   `https://<web domain>/api/auth/oauth/github/callback`. The web app runs the flow itself (not
   PocketBase's `/api/oauth2-redirect`, decision-011's correction) and builds the callback from
   `RAILWAY_PUBLIC_DOMAIN` (`web/app/api/auth/oauth/github/start/route.ts`), which carries the
   custom domain once one is attached. Attach it (step 1) before trying GitHub sign-in: without
   it the callback is built on Railway's generated domain and does not match the OAuth app. The
   app issues the client id and secret.
5. **`pocketbase` variables, all before its first boot.**

   | variable | what it does | value comes from |
   | --- | --- | --- |
   | `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD` | the image creates this superuser on boot (`Dockerfile` CMD, `create` only) | owner's choice; the address must receive mail (login is MFA by emailed code), and until a Resend domain is verified only the Resend account owner's inbox does |
   | `RESEND_API_KEY` | turns on real mail through Resend's SMTP bridge (`pb_hooks/mail.pb.js`) | Resend dashboard (step 3) |
   | `MAIL_SENDER_ADDRESS` | the From address | an address on the Resend-verified domain; unset, Resend's sandbox sender |
   | `PB_PUBLIC_URL` | the link base in verification and password-reset emails, which open PocketBase's own confirmation pages | `https://<pocketbase domain>` (step 1) |
   | `PB_CORS_ORIGINS` | the CORS allowlist `serve` gets as `--origins` (`Dockerfile`) | the web origin, `https://<web domain>`; unset, `*` |
   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | enable GitHub sign-in (`pb_hooks/oauth.pb.js`); both or neither | GitHub OAuth app (step 4) |
   | `APP_ADMIN_EMAILS` | comma-separated accounts, besides the superuser, allowed to approve new signups (`pb_hooks/routes.pb.js`) | owner's choice |
   | `ALERT_EMAIL` | recipient of the error-rate alert mail (`pb_hooks/alerts.pb.js`); needs `RESEND_API_KEY` | owner's choice |
   | `PB_BACKUPS_S3_BUCKET`, `_ENDPOINT`, `_REGION`, `_ACCESS_KEY`, `_SECRET` | send backups to S3 (`pb_hooks/backups.pb.js`); bucket and secret both, or local backups on the volume | `pb-backups` credentials (step 2) |
   | `PB_BACKUPS_CRON`, `PB_BACKUPS_CRON_MAX_KEEP` | backup schedule and how many to keep; an invalid schedule refuses boot | owner's choice; unset, daily 03:00 UTC and 30, but only while S3 backups are on (without them there is no backup cron) |
   | `PB_FILES_S3_BUCKET`, `_ENDPOINT`, `_REGION`, `_ACCESS_KEY`, `_SECRET` | store uploaded files in S3 (`pb_hooks/files.pb.js`); bucket and secret both, or files on the volume | `pb-files` credentials (step 2) |

   What a missing one costs on the first boot: no superuser means no dashboard login (PocketBase's
   one-time installer link is unchecked behind Railway) until the variables are set and `pocketbase` redeploys (or `deploy/railway/set_railway_superuser.sh create`
   runs); no `RESEND_API_KEY` means no OTP mail, so the superuser still cannot log in; no
   `PB_FILES_S3_*` means uploads land on the volume and are not moved to S3 when it is switched on
   later (`pb_hooks/files.pb.js` only repoints the storage setting).
   Every other variable is re-read on each boot, so setting it later and redeploying is enough.
6. **`web` variables, before its first build.**

   | variable | what it does | value comes from |
   | --- | --- | --- |
   | `WEB_PUBLIC_HOSTS` | the proxy guard's host allowlist (`web/proxy.ts`) | `<web domain>` (step 1), no port |
   | `NEXT_PUBLIC_PB_URL` | the browser's direct realtime connection, and the CSP's `connect-src` (`web/lib/realtime.ts`, `web/proxy.ts`) | `https://<pocketbase domain>` (step 1) |
   | `PB_URL` | the server-side proxy's PocketBase address (`web/lib/proxy/pb.ts`) | the private-network address, `http://<pocketbase service name>.railway.internal:8080` |

   Unset `WEB_PUBLIC_HOSTS` makes every request 500, the healthcheck included, so the deploy
   fails. Unset `PB_URL` points the proxy at `127.0.0.1:8090`, so every sign-in and API call
   fails. `NEXT_PUBLIC_PB_URL` is baked in at BUILD time (`web/Dockerfile`): set after the first
   build, it changes nothing until `web` redeploys, and until then live updates silently point at
   `127.0.0.1:8090`.
7. **Deploy-failure alert.** Re-create the notification rule in
   "When a pocketbase deploy fails" below; it is not in the IaC.
8. **Verify.** Both healthchecks green, the superuser logs into `/_/` with its emailed code, and a
   GitHub sign-in on the web domain completes.

## When a pocketbase deploy fails

A refused boot migration takes pocketbase down until a good build is deployed; the old
container is already stopped (`.agents/context/deploy.md`, the teardown line). The owner
accepts that outage; the response is an alert and this manual recovery. Measured in throwaway
environments unless marked.

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
   (`user.accessToken` in `~/.railway/config.json`; `user.token` is refused) plus a `User-Agent`
   header. Email delivery confirmed by the owner: a fire test's failed deploy mailed the owner's inbox.
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

## Local Railway stand-in (docker compose)

`deploy/local/docker-compose.yml` reproduces the two Railway services (PocketBase + Next web) on one
host, for when the deployed instance is down or you need prod-image parity locally. It
builds the SAME `Dockerfile` and `web/Dockerfile` Railway builds — not the `make dev`
native-binary path.

It runs in one of two modes, and picking the wrong one wastes an afternoon:

| mode | command | superuser MFA | data |
| --- | --- | --- | --- |
| prod-parity (default) | `make compose-up` | on, exactly as deployed | empty |
| local-dev | `make compose-dev` | **off** | seeded |

**Prod-parity — use it to reproduce the deployed image.** Same migrations, same hooks, same
MFA posture. It is deliberately near-impossible to log into: the second factor is an emailed
one-time code, the stack has no mailer, so the dashboard is closed to you, and `scripts/seed.ts`
cannot authenticate either (its CLI OTP fallback mints against the HOST `pb_data`, never the
container's volume). Right mode for "does the image boot and serve?", wrong mode for clicking
around.

**Local-dev — use it to actually use the app locally.** One command builds both images, waits
for `/api/health`, and seeds:

    make compose-dev

Afterwards the dashboard at `/_/` takes the superuser password alone (no second factor) and
`alice@example.com` / `test123456` signs into the web app. Re-running is safe: `scripts/seed.ts`
is append-only, so a second run reports the volume as already seeded and leaves it alone.
The container log carries a one-line `LOCAL DEV MODE: superuser MFA is OFF` banner, written the
first time a request arrives after a boot.

**MFA-off is written into the data volume, so it outlives the mode.** Going back to
`make compose-up` on a volume that has been through local-dev leaves the superuser password-only
(measured: HTTP 200 with no `mfaId`) — the hook is gone, but nothing turns MFA back on. For a
genuinely prod-parity run, start from a wiped volume: `make compose-down ARGS=-v`.

**Why MFA-off cannot leak into a deploy.** The switch is not an env var or a setting — it is a
file, `deploy/local/mfa-off.pb.js`, that lives OUTSIDE every path `Dockerfile` copies
(`COPY pb_hooks /pb/pb_hooks` is the one that would carry it). `deploy/local/docker-compose.local.yml`
bind-mounts it into the container's hooks dir, and that mount is the only way it ever runs: the
prod image does not contain the file, so no variable and no misconfiguration can switch it on
there. `scripts/check_local_mode_isolation.ts` (battery) re-derives that from the Dockerfile and
`pb_hooks/` on every run. The hook is request middleware rather than a boot hook because pending
migrations apply after the bootstrap chain and would overwrite a boot-time flip on a first boot.

    make compose-up      # prod-parity images
    make compose-dev     # prod-parity + MFA off + seeded (local-dev)
    make compose-down    # stops containers; pb_data volume SURVIVES
    make compose-down ARGS=-v   # also wipes the pb_data named volume (destroys local data)

The Make targets pass `--project-directory` pointing at the repository root, preserving
root `.env` lookup, the Compose project name and existing named volumes. For other
Compose operations, use `docker compose --project-directory . -f deploy/local/docker-compose.yml`
from the repository root; add `-f deploy/local/docker-compose.local.yml` for local-dev.

Endpoints: PocketBase `http://127.0.0.1:8090` (dashboard `/_/`), web `http://127.0.0.1:3000`.
Superuser creds come from `.env` (`PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD`, same file
`make dev` uses); with no `.env` the compose file falls back to `admin@example.com` /
`changeme123456`. Data lives in the `pb_data` named volume, so a `compose down` (without `-v`)
then `compose up` keeps every record.

- **The two-URL gotcha — the one wiring detail that silently breaks login/SSE if collapsed.**
  The web service is handed TWO different PocketBase addresses:
  - `NEXT_PUBLIC_PB_URL` (a build ARG, baked into the browser bundle for the direct-SSE
    realtime channel, decision-004) MUST be the host-published address `http://127.0.0.1:8090`.
    The browser runs on the host and cannot resolve the compose DNS name.
  - `PB_URL` (a runtime env, the server-side proxy target) MUST be the compose-internal
    `http://pocketbase:8090`. It is a container-to-container hop.
  They are set at different layers (`build.args` vs `environment`) on purpose; making them
  equal breaks one seam or the other with no error at startup.
- **Host-port override:** if 8090/3000 are occupied, set `PB_HOST_PORT` / `WEB_HOST_PORT`
  before `compose up` or `make compose-dev` (both read them, and the seed follows
  `PB_HOST_PORT`). `NEXT_PUBLIC_PB_URL` is derived from `PB_HOST_PORT`, so changing the
  published PB port forces (and correctly re-bakes) a web rebuild.

### Testing against the container stack

Two test environments exist, and only one uses containers:

| environment | used by | PocketBase runs as | superuser | MFA bypass |
| --- | --- | --- | --- | --- |
| clean room | backend suites, the battery, `web/` e2e | host binary, scratch `pb_data` + scratch copies of `pb_migrations/` and `pb_hooks/` (`tests/roomkit.ts`) | `pocketbase superuser upsert` before `serve` (`scripts/run_suite_battery.sh`) | the `*superuser_mfa.js` migration is deleted from the scratch copy |
| compose stack | `web-carbon/` e2e (`make carbon-e2e`, CI job `carbon-e2e`) | the production `Dockerfile` image, `linux/amd64` | `PB_SUPERUSER_*` env; the image CMD runs `superuser create` after `migrate up` | `docker-compose.local.yml` mounts `deploy/local/mfa-off.pb.js` |

Neither path has a signup step: the superuser is written from the CLI before the first request.

`web-carbon/e2e/support/runtime.mjs` (Playwright global setup) boots the compose stack per run:

1. Copies the tracked tree into a temp directory, so the run never builds from uncommitted
   noise or writes into the checkout.
2. Writes an env file and an override with a throwaway superuser and isolated host ports
   (`CARBON_PB_PORT` 14390, `CARBON_NEXT_PORT` 9302, `CARBON_APP_PORT` 9702 by default) and a
   compose network subnet that no existing Docker network uses (`docker-subnet.ts`).
3. `docker compose up -d --build --wait` with `docker-compose.yml` + `docker-compose.local.yml`
   + that override, then seeds with `scripts/seed.ts`, turns PB rate limits off, and adds the
   e2e-only fixtures.
4. Builds `web-carbon/` and serves it with `vite preview` on the host, proxying to the Next
   container. Teardown (`global-teardown.ts`) stops it and runs `compose down -v`.

**Browsers run on the host, not in a container.** Playwright drives a locally installed
Chromium (`npx playwright install chromium` in CI) against the host-published ports. Running the
browser inside the compose network would need a glibc Playwright image as an extra service and
`NEXT_PUBLIC_PB_URL` pointing at an address that container can resolve; nothing does that today.

## Deploy gating

- **A green prod deploy proves the service BOOTED, never that its code passed CI.** What gates
  promotion is the `/api/health` healthcheck, not the tests.
- **Railway's `source.checkSuites` toggle fails OPEN.** It waits only for a check suite that
  already EXISTS at deploy-decision time. Measured 2026-08-06: `a4d1e27` deployed at 22:33:11Z
  while its workflow run was not created until 23:00:44Z — 27 minutes later. `0868ee1` deployed
  at 23:23:49Z; its run (`31131404762`) was created 23:31:49Z, 8 minutes after. The failure mode
  is not "GitHub creates no run", it is "GitHub can create the run long after Railway shipped",
  so the fix is a bounded WAIT for the run to appear and then a hard fail.
- **The same toggle also fails CLOSED, the other way:** if the FIRST CI run on a main push
  fails, Railway marks that deploy SKIPPED permanently — a green rerun does NOT resurrect it.
  Recover with a trivial watch-path push or `environmentTriggersDeploy`. Always check
  `railway deployment list` after a rerun. (A SKIPPED deploy reading "No changes to watched
  files" is just the two-service split working.)
- **A commit that failed CI and was re-run green will still deploy** under any gate that reads
  `/runs/{id}/jobs?filter=latest` — earlier attempts are hidden. Run `31136231688` on main shows
  four green jobs there while `filter=all` shows `suite-battery` attempt 1 `failure`. Decide
  deliberately whether that is acceptable; it is invisible otherwise.
- **Assert per-JOB conclusions, never the run's top-level `conclusion`.** A run whose required
  job was *skipped* can still present as green at run level.
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

      if grep -qE '^web/' <<< "$files"; then      # here-string: no pipe, no SIGPIPE

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
  assertion alone leaves any job you did not name completely un-gated — assert BOTH.
- **`/runs/{id}/jobs?filter=latest` hides earlier attempts**, so a commit that failed CI and was
  re-run green looks unblemished. `filter=all` shows the truth. `filter` also silently defaults
  to `latest`, and a typo'd value is ignored rather than rejected.
- **The `compare` endpoint caps `files` at 300 and `--paginate` cannot lift it** — pagination
  pages over *commits*; page 2 carries no `files` key at all and gh aborts with
  `cannot iterate over: null`. The array is path-ordered, so late-alphabet directories are the
  ones truncation drops.
- **A ruleset that INCLUDES `~DEFAULT_BRANCH` and EXCLUDES `refs/heads/main` protects nothing.**
  Check what applies, not what is configured: `gh api repos/<o>/<r>/rules/branches/main` returns
  `[]` when nothing does.

## Railway CLI and GraphQL

- In-container commands are `railway ssh --service --environment`; **`railway run` executes
  LOCALLY**. Pass `-e production` explicitly — `railway environment new --duplicate` auto-LINKS
  the CLI to the NEW environment, so every later command silently targets it.
- **`railway variables --unset` does not exist** — it is `railway variable delete`, and a
  variable DELETE does NOT auto-deploy while a `--set` does. Start any "why didn't my config
  change take effect" hunt here.
- **`railway redeploy` reuses the ORIGINAL deployment's cached build settings** even after you
  change them.
- GraphQL bearer is the `user.accessToken` field of `~/.railway/config.json`, NOT `user.token`.
  Railway returns GraphQL errors with **HTTP 200**, so a curl exit status proves nothing —
  check for an `errors` key explicitly.
- Deploy control is three mutations:
  - `serviceInstanceDeployV2(commitSha, environmentId, serviceId)` — deploys an EXACT commit;
    the only form that cannot race a moving `main`.
  - `environmentTriggersDeploy(input: {projectId, environmentId, serviceId})` — deploys the
    trigger branch's current TIP. Deploys *through* the trigger, so deleting the deployment
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
  seconds. Poll past the restart (~10-15s) or you read pre-swap state.
- `createBackup` needs ≥2× `pb_data` free and a restore needs ≥2× the archive; `cronMaxKeep`
  bounds the BUCKET, not the volume. Let PB autogenerate backup names and space creates out — an
  explicit name, or a second create in the same second, can 400 on a collision.

## PocketBase in production

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
- **Railway's `X-Forwarded-For` chain is `[real-client, edge-node]` and the RIGHTMOST hop is a
  VARYING edge IP** — trusting rightmost splits rate-limit buckets per request and silently
  disables the limiter. `trustedProxy` needs `useLeftmostIP: true`; Railway strips inbound XFF,
  so leftmost is the real client and is not spoofable (proven with a forged header).
- **Settings secrets are PLAINTEXT at rest in `pb_data/data.db`** — the S3 secret, the SMTP
  password and any OAuth secret, unless the boot CMD passes `--encryptionEnv`. It does not.
- **Proving transactional/alert mail was DELIVERED needs no inbox access** — Resend's
  `GET /emails` reports `last_event: delivered`. `ALERT_SELFTEST=1` arms a one-shot send on the
  first request after boot; unset it afterwards or every deploy emails.

## Frontend edge behaviour

- **A client-supplied `X-Forwarded-Host` never wins at Railway's edge** (TASK-064, probed live
  2026-08-07). The Next half of the bypass is real and confirmed in source, and the rule is
  stricter than an earlier version of this bullet claimed: `action-handler.js:431` calls
  `parseHostHeader(req.headers)` with ONE argument, so the function's `EITHER x-forwarded-host OR
  host` branch (reachable only when a second argument is passed) never runs. The live check is
  the one-argument fallthrough — `x-forwarded-host`'s first comma-separated entry if present,
  ELSE `host` — compared against `Origin`. Behind a pass-through proxy Next's check alone is
  exploitable through that single path: forward a foreign `Origin` with a matching injected
  `X-Forwarded-Host` and it passes on the header alone (the proxy guard's allowlist, next bullet,
  refuses that shape first). A four-case live differential shows Railway is not such a
  proxy: the same foreign-`Origin`-plus-injected-header case (single value or comma-list, either
  order) is rejected exactly as if no header were sent, while a same-origin request reaches
  action resolution. Against this corrected rule, `serverActions.allowedOrigins` is still left
  unpinned by choice — **re-probe before putting any new proxy in front of the web service.**
  Verified against Next 16.3.4 (its `action-handler.js` does not differ from 16.3.0);
  `web/lib/next-version.test.ts` pins that version and fails loudly on a bump so this bullet
  gets re-checked before it goes stale.
- **`WEB_PUBLIC_HOSTS` is the proxy guard's host allowlist** — a runtime variable on the `web`
  service, value held in Railway only: comma-separated lowercase `host[:port]`, one entry per
  environment (its own public domain; a new domain needs its entry or every write from it is
  refused). Never write a default port (`:443`, `:80`): Origin drops it, so that entry matches nothing.
  `web/proxy.ts` refuses a foreign-`Origin` write whose trusted forwarded host is not listed.
  Unset in a production build, the server still prints `Ready`, then every request, the
  `/api/health` healthcheck included, answers 500 with the variable named in the log. Development
  and tests default to `127.0.0.1:*` and `localhost:*`; the compose stack sets its own.
- **Probe idiom (read-only, mutates nothing):** POST a page route with a bogus `Next-Action` id.
  `x-nextjs-action-not-found: 1` means the CSRF check PASSED; `403 Forbidden` (the proxy guard)
  or, with the guard bypassed, a bare 500 from Next means it was rejected.
  The bogus id guarantees no action ever executes.

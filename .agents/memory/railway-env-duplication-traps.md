---
name: railway-env-duplication-traps
description: "The Railway deploy branch is a deployment trigger, not a service field; three silent no-ops measured standing up a duplicated review env, plus seed.ts and superuser-MFA traps"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93b0052b-ed3d-41c3-b96b-f9ee9ca9ecb0
  modified: 2026-09-09T00:02:36.157Z
---

Measured 2026-09-08 standing up a review environment (`railway environment create <name> --duplicate production`).

**The deploy branch is not a field on the service instance.** `ServiceSourceInput` has only `image` and `repo`; there is no `branch`. The branch lives on a **deployment trigger** — `deploymentTriggerUpdate(id, {branch, checkSuites})`, one per (environment, service). Find them with `project(id){deploymentTriggers{edges{node{id branch environmentId serviceId}}}}`.

**Three ways to set it that do NOT work, each failing quietly:**

- `railway environment edit --service-config <service-NAME> source.branch <b>` returns `{"committed":false,"message":"No changes to apply"}`. The config is keyed by service **ID**. Passing a name is a silent no-op, and passing the ID still fails because `source.branch` is not a writable path there.
- `mcp__railway__connect-service-source` accepts a `branch` and would work — but its own description says it "applies to the service in **all environments**". On a duplicated env that repoints PRODUCTION too.
- `mcp__railway__update-service` states outright that source changes are out of scope.

**Raw GraphQL needs a User-Agent.** `https://backboard.railway.com/graphql/v2` answers `403 error code: 1010` (Cloudflare) without one; `User-Agent: railway-cli/5.49.4` passes. Token is `~/.railway/config.json` → `user.accessToken` (not `.token`, not top-level). The
`use-railway` skill's `scripts/railway-api.sh` still reads `.user.token` (plugin 1.3.7, line 25,
checked 2026-10-24), so it answers "No Railway token found. Run: railway login" to an
authenticated user (filed as hsb3/dotfiles-agents#291); read `.user.accessToken // .user.token`
with `jq -r` and never echo the value.

**`scripts/seed.ts` breaks `railway` in any subprocess it spawns.** Its `load_env()` copies every key of the repo's gitignored `.env` that is not already in `process.env`, which carries a `RAILWAY_API_TOKEN` scoped elsewhere. Any `railway` call made from inside seed (e.g. a `PB_BIN` shim forwarding `superuser otp` to `railway ssh`) fails `Unauthorized`. Unset it inside the shim.

**Seeding a deployed environment past superuser MFA:** point `PB_BIN` at a shim that forwards `superuser otp` to `railway ssh --service pocketbase --environment <env> "/pb/pocketbase superuser otp <email> --dir /pb/pb_data"`. seed.ts only parses `Id:` / `Pass:` out of the command's output (`scripts/seed.ts:126`), so a shim satisfies it without touching seed.ts. Binary is `/pb/pocketbase`, data `/pb/pb_data` — not `/app`.

**Always re-read production's triggers after any of this** and confirm they still say `main` / `checkSuites: true`.

---
name: railway-env-duplication-traps
description: "Duplicating a Railway environment carries production's NEXT_PUBLIC_PB_URL into it, and the deploy branch is a deployment trigger, not a service field — three silent no-ops measured standing up the ui-overhaul env"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93b0052b-ed3d-41c3-b96b-f9ee9ca9ecb0
  modified: 2026-09-09T00:02:36.157Z
---

Measured 2026-09-08 standing up the `ui-overhaul` review environment (`railway environment create ui-overhaul --duplicate production`).

**The duplicate points the new environment's browser at PRODUCTION PocketBase.** `PB_URL` is fine — it is `http://pocketbase.railway.internal:8080`, which resolves inside whichever environment reads it. But `NEXT_PUBLIC_PB_URL` was copied literally as `https://admin.tasks-pocketbase.functionform.ai`, so the realtime SSE channel of the new environment's frontend would have talked to prod. It is inlined at BUILD time, so fixing the variable does nothing until the next push-triggered build — a redeploy replays the old snapshot and keeps the stale value.

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

A stale `NEXT_PUBLIC_PB_URL` fails silently in any build, not just a duplicated env: a build
pointed at the wrong PB breaks realtime SSE with no error.

**`scripts/seed.ts` breaks `railway` in any subprocess it spawns.** Its `load_env()` copies every key of the repo's gitignored `.env` that is not already in `process.env`, which carries a `RAILWAY_API_TOKEN` scoped elsewhere. Any `railway` call made from inside seed (e.g. a `PB_BIN` shim forwarding `superuser otp` to `railway ssh`) fails `Unauthorized`. Unset it inside the shim.

**Seeding a deployed environment past superuser MFA:** point `PB_BIN` at a shim that forwards `superuser otp` to `railway ssh --service pocketbase --environment <env> "/pb/pocketbase superuser otp <email> --dir /pb/pb_data"`. seed.ts only parses `Id:` / `Pass:` out of the command's output (`scripts/seed.ts:126`), so a shim satisfies it without touching seed.ts. Binary is `/pb/pocketbase`, data `/pb/pb_data` — not `/app`. Related: [[prod-superuser-mfa-otp]], [[reference-railway-cli-traps]].

**Always re-read production's triggers after any of this** and confirm they still say `main` / `checkSuites: true`.

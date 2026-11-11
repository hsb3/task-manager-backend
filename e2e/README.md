# e2e kit: a seeded world for agent clients

A fixed seed always produces the same world: the same users, workspaces, memberships,
projects, labels, tasks, documents and comments. `e2e/seed.ts` builds that world in a fresh
PocketBase room the way a client would, through the public API. The superuser only signs in
and creates the accounts, because `approved` can be set by a superuser alone. Each owner renames
their provisioned workspace and project, adds projects and labels, and invites members, who
accept through `/api/tracker/invitations/{id}/accept`. Authors write their own items and comments.

| File | What it does |
|---|---|
| `world.ts` | `generate(seed)` returns the world as plain data; `bun e2e/world.ts --seed N` prints it as JSON |
| `seed.ts` | `seed_world(url, world, [email, password])` builds it; `bun e2e/seed.ts --seed N --url URL` from the shell |
| `smoke.ts` | `make smoke`: live probes against the production Docker images (API and MCP service); independent of the seeded world |

## Smoke probes of the MCP service and the authorization server

`make smoke` also boots the MCP service image beside the API and probes what a client reaches
without a key:

- `probe_mcp_challenge`: `POST /mcp` with no credential answers 401 `application/json` (exactly)
  and a challenge naming the Protected Resource Metadata and the `read write` scope.
- `probe_mcp_metadata`: the metadata's authorization server equals the API's `issuer`, which
  lists `S256` and `none`.
- `probe_mcp_refusals`: `GET /mcp` 405, an unknown path 404, an unlisted `Origin` 403.
- `probe_oauth_refusals`: an unknown client's sign-in page 400, a password grant 400
  `unsupported_grant_type`, revocation 200 for a known client and 400 `invalid_client` otherwise,
  and a posted request without PKCE redirects with `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer` (the same redirect that carries an approval's code).
- `probe_oauth_code_stage_blind`: asking for an emailed code for an unknown email answers a code
  page whose flow token carries two 15-character ids, the shape a known email gets.
- `probe_mcp_anon_limit`: 30 unauthenticated requests from one address in a minute answer 401,
  the 31st 429 with `Retry-After`.
- `probe_read_key_me`: a read key's `GET /api/tracker/me` lists the provisioned workspace with
  every capability false.
- `probe_key_levels`: a write key trashes a task the fixture user made (204), but purging it and
  `POST /api/tracker/workspaces/{id}/transfer-ownership` answer 403 `api_key_scope`.
- `probe_key_reach`: a write key limited to the provisioned workspace lists no task of a second
  workspace "Smoke B", answers 404 for one by id, and 403 `api_key_reach` for a workspace create.

A smoke run copies `e2e/fixtures/smoke_key_user.js` into the image and restarts it, so the key
probes have one approved, verified user; keyed paths beyond those probes stay battery-only.

## Seed a room

Boot a clean room with the solo-run recipe in [`.agents/rules/ports.md`](../.agents/rules/ports.md)
(it follows the clean-room law in `AGENTS.md`), skipping its last line (the sample seed and
suite), then seed the world:

```bash
PB_SUPERUSER_EMAIL=probe@example.com PB_SUPERUSER_PASSWORD=probe123456 \
  bun e2e/seed.ts --seed 22 --url http://127.0.0.1:8091
```

Shift the port with `PB_PORT_OFFSET` when a battery is running. The seeder prints the ids it
created. In a room that already holds one of the world's accounts it stops at that account's
create, because a world is seeded into a fresh room only.

## Use the world

- Sign in as any world user with the `email` and `password` that `bun e2e/world.ts --seed N`
  prints, through `POST /api/collections/users/auth-with-password`.
- `persona(world)` is the normal member that `tests/test_agent_probe.ts` drives:
  `users[1]`, always a plain `member` of `workspaces[0]`.
- `writers(workspace)` lists who may write there: the owner, admins and members. Viewers only read.
- Every workspace also carries what the backend provisions: the statuses Backlog, Todo,
  In Progress, Done and Canceled, and the core labels Bug, Feature and Improvement.
- No title or body in a world contains `zephyr`, so a client can write and search for its own
  rows without hitting seeded ones.
- `bun tests/test_agent_probe.ts --world N` runs the agent probe against world N instead of
  `scripts/seed.ts`. Every world gives each probe filter a seeded row to match in the persona's
  workspace; the battery runs one world.

## Rate limits

PocketBase counts requests per client IP in fixed 60-second windows. The client IP is the
rightmost `X-Real-IP` entry, which Railway's edge sets; without that header it is the address
the request arrives from. `X-Forwarded-For` is ignored (decision:rate-limit-counts-x-real-ip).

- **Each collection route has its own bucket.** For example, the `workspaces` list and the
  `projects` list are counted separately. The general limit is 300 requests per window, so
  the 301st `workspaces` list in a window answers 429 while the `projects` list still answers 200.
- **Everything else under `/api/` shares one bucket.** That covers every custom route
  (`/api/tracker/me`, `/api/tracker/summary`, ...), `/api/health`, `/api/batch` and the
  realtime subscribe `POST /api/realtime`, for signed-in and anonymous callers alike.
- **Some routes are tighter**, per the settings migration's rate-limit rules: sign-in
  (`auth-with-password`, users and superusers) allows 10 per window, and signup
  (`POST /api/collections/users/records`, which takes no password: the signup mail links to
  choosing one) and `request-otp` allow 5. Sign in once and reuse the token.
- **A 429 carries no `Retry-After` or `X-RateLimit-*` header.** Its body is
  `{"data": {}, "message": "Too Many Requests.", "status": 429}`. Wait for the window to
  pass (up to 60 s) and retry. `seed.ts` does this itself.
- **A request carrying a superuser token is never limited.** A superuser's sign-in is.
- **Seeding spends the same buckets.** Right after `seed.ts`, the client's IP has already
  used one sign-in per world user and a few dozen calls from the shared `/api/` bucket.

`tests/test_agent_probe.ts` measures the per-collection buckets, the 429 body, the missing
headers and which client address is counted. `tests/test_e2e_world.ts` measures the shared
custom-route bucket and the superuser-token exemption. The rest is read from the settings
migration and PocketBase's limiter.

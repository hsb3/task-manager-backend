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

## Seed a room

Boot a clean room first (the repo's clean-room law, `AGENTS.md`): copies of `pb_migrations`
and `pb_hooks`, the `*superuser_mfa.js` migration removed from the copy, and a port of
`<default> + PB_PORT_OFFSET` (`.agents/rules/ports.md`).

```bash
S=$(mktemp -d); cp -R pb_migrations "$S/mig"; rm -f "$S/mig/"*superuser_mfa.js; cp -R pb_hooks "$S/hooks"
./pocketbase superuser upsert probe@example.com probe123456 --dir "$S/pb_data" --migrationsDir "$S/mig"
./pocketbase serve --http=127.0.0.1:8091 --dir "$S/pb_data" --migrationsDir "$S/mig" --hooksDir "$S/hooks" &
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
  workspace; the battery runs seed 22.

## Rate limits

PocketBase counts requests per client IP in fixed 60-second windows. Behind a proxy, the
client IP is the leftmost `X-Forwarded-For` entry.

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

`tests/test_agent_probe.ts` measures the per-collection buckets, the 429 body and the missing
headers. `tests/test_e2e_world.ts` measures the shared custom-route bucket and the
superuser-token exemption. The rest is read from the settings migration and PocketBase's limiter.

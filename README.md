# Task Tracker

A multi-workspace task tracker backend, built on
[PocketBase](https://pocketbase.io) — a complete REST API with almost no backend
code.

![The task-tracker data model and the git-to-Railway ship loop](docs/assets/overview.svg)

- **A real collaboration model, not a to-do list** — workspaces with
  owner/admin/member roles, projects, tasks with per-workspace sequence numbers,
  plus decisions, documents and milestones.
- **Built to collaborate on** — threaded comments with reactions, a field-level
  activity audit trail, task subscriptions, and fan-out notifications with an
  unread digest.
- **Customisable vocabulary** — labels and statuses are first-class per-workspace
  collections, seeded with sensible defaults, so teams rename and extend them
  without a schema change.
- **Safe by default** — access policy is API rules compiled into SQL rather than
  hand-written checks, and deletes go to a 30-day trash instead of vanishing.
- **Reproducible from git alone** — clone and the migrations rebuild everything;
  push and CI plus Railway deploy it. The database is the only thing not in git.

## Quick start

The `pocketbase` binary, `pb_data/` and `.env` are gitignored, so a fresh clone
builds the backend rather than inheriting one:

```bash
# Install mise first, then trust this checkout's reviewed runtime pins.
mise trust
make setup                 # runtimes (incl. Lefthook), bun install, PocketBase, local config, pre-commit hook
make dev                   # PocketBase on http://127.0.0.1:8090, seeds a fresh database
```

`make dev` needs no hand setup, in a clone or a worktree: it writes a local `.env`
with a fictitious dashboard superuser when none exists, creates that superuser before
PocketBase first starts, and runs the binary `PB_BIN` names, else this checkout's
`./pocketbase`, else the main checkout's, downloading the pinned version when none of the
last two is that version (a `PB_BIN` that is not is refused, never downloaded over).

Signing up provisions a workspace, a membership, a default project and the
starter label and status sets automatically.

## Building against it

[`openapi.json`](openapi.json) is the API contract, generated from the
migrations and the route registry (`pb_hooks/lib/routes.js`) and gated against drift on every commit — it is never hand-edited.
[`docs/generated/decisions.md`](docs/generated/decisions.md) records the product and schema rulings
behind it, generated the same way.

Against `make dev`, sign in as a seeded user and call the REST API with the token (PocketBase
takes it in `Authorization` with no `Bearer` prefix):

```bash
TOKEN=$(curl -s http://127.0.0.1:8090/api/collections/users/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"alice@example.com","password":"test123456"}' | jq -r .token)
curl -s -H "Authorization: $TOKEN" http://127.0.0.1:8090/api/collections/tasks/records
```

## Verify

The gate runners select the Bun version pinned in `mise.toml`.
For individual commands, activate the same environment first:

```bash
. scripts/verification-env.sh
make check                          # the gate: static checks, then the whole battery
make check-static                   # its server-free half
bun tests/test_rules.ts             # one suite (any tests/test_*.ts runs solo)
```

Each suite boots its own clean server, probes the full role matrix, and exits
non-zero on any failure. On macOS the battery retries a suite once if its
connection drops mid-run (a local file-watcher artifact); CI is unaffected.

CI splits the battery across four runners by `scripts/battery_shards.tsv`, and a verify job
fails when any suite ran in no shard. `make battery` and `make check` run it whole.

## Configuration

Two layers, each with a tracked `.example` sibling and a gitignored real file:

| File | Purpose | Read by |
| --- | --- | --- |
| `.env` | deployment config, mirrors the Railway service variables; locally, the dev superuser `make env` writes | the `pb_hooks/` env boot hooks, the Dockerfile, `make dev` |
| `.env.local` | local-testing overrides — ports, paths, mail sink | `scripts/`, `tests/` |

## Layout

- `pb_migrations/` — the schema source of truth. `schema/` — generated
  per-collection docs (`scripts/gen_schema.ts`). `pb_hooks/` — validation,
  lifecycle and custom routes.
- `scripts/` — dev tooling and the generators. `tests/` — end-to-end proofs.
- [`deploy/`](deploy/README.md) — Railway configuration and deployment recipes.
Tasks, decisions and planning docs live on the kata board, not in this repo.

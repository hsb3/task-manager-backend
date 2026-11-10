# Task Tracker backend

The backend for a multi-workspace task tracker built for AI agents. It is
[PocketBase](https://pocketbase.io) plus a schema and server hooks: an agent calls PocketBase's
own REST API, or uses `tm`, the command-line client and MCP server in [`clients/tm/`](clients/tm/README.md).
Functionally it follows Linear: workspaces, projects, and tasks with short keys like `MYP-7`.

It is not publicly released and has no real users yet.

## Run it locally

In a clone, with [mise](https://mise.jdx.dev), `curl`, `jq` and `sqlite3` installed:

```bash
mise trust   # allow this checkout's pinned tool versions
make setup   # install Bun, the dependencies and the pinned PocketBase binary
make dev     # PocketBase on http://127.0.0.1:8090, seeded with sample users and tasks
```

`make dev` stays in the foreground until Ctrl-C. Sign in as `alice@example.com` or
`bob@example.com`, password `test123456`. The PocketBase dashboard at `/_/` takes the superuser
`make setup` wrote to `.env`, then the one-time code `make otp` prints. `make` lists every target.

To run the production Docker image instead (empty database, no sample data), use `make local-up`:
see the how-to [Run the production image locally](deploy/README.md#local).

## What a client does

A client authenticates with an **API key**: a signed-in user creates an `api_keys` record with
scope `read` or `write` and gets back a `tmk_…` secret. A read key only reads; a write key
also creates, edits and comments.

With `make dev` running, open a second terminal at the repo root:

```bash
export TM_URL=http://127.0.0.1:8090
alias tm='bun clients/tm/tm.ts'
```

Alice signs in and lists her workspaces and projects through the REST API, creates a write key, then
creates and lists a task with `tm`. A real captured run (record ids differ every run):

```console
$ TOKEN=$(curl -s $TM_URL/api/collections/users/auth-with-password -H 'Content-Type: application/json' -d '{"identity":"alice@example.com","password":"test123456"}' | jq -r .token)
$ curl -s -H "Authorization: $TOKEN" "$TM_URL/api/collections/workspaces/records?fields=id,name" | jq -c '.items[]'
{"id":"6wdsct21yqtw9hk","name":"Alice's Workspace"}
$ curl -s -H "Authorization: $TOKEN" "$TM_URL/api/collections/projects/records?fields=id,name" | jq -c '.items[]'
{"id":"aeq9u2md2y1vlxv","name":"Website Redesign"}
$ export TM_API_KEY=$(curl -s -H "Authorization: $TOKEN" -H 'Content-Type: application/json' -d '{"name":"my agent","scope":"write"}' $TM_URL/api/collections/api_keys/records | jq -r .key)
$ tm create "Write the launch checklist" --project aeq9u2md2y1vlxv --json | jq -c '{id, key, title}'
{"id":"l08a4wxfgqiy8nu","key":"MYP-7","title":"Write the launch checklist"}
$ tm list --project aeq9u2md2y1vlxv
l08a4wxfgqiy8nu  task      MYP-7    Write the launch checklist
82ncacndhhgrq1j  task      MYP-6    Draft the hero section
nt1q3ir2shipa0x  task      MYP-5    Pick a color palette
tnl2vu76mmloqw3  task      MYP-4    Ship landing page
f9o07q8kvc2y55e  task      MYP-3    Wire up nav
0868bme3575afhz  task      MYP-2    Design homepage
g3orpeh5gap7efx  milestone MYP-1    v1 launch
```

`MYP-7` is the task's **key**: its project's prefix, fixed when the project was created, plus one
number shared by every item in the project. PocketBase takes the sign-in token in `Authorization`
with no `Bearer` prefix.

`tm` also shows, searches, edits and comments, and `tm mcp` offers the same verbs to an AI agent as
MCP tools: see the how-to [tm, the task tracker from the terminal](clients/tm/README.md).

## What's in it

![The task-tracker data model and the git-to-Railway ship loop](docs/assets/overview.svg)

- **Workspaces with roles.** Each has an owner plus admin, member and viewer members, invitations,
  and projects holding items: tasks, documents, decisions and milestones. Signing up
  creates the user's first workspace and project.
- **Collaboration.** Threaded comments with reactions, a field-by-field activity history on
  tasks, task subscriptions, and notifications with an email digest of unread ones.
- **Per-workspace vocabulary.** Labels and statuses are records in each workspace, created with
  defaults, so a team renames and extends them without a schema change.
- **One access policy.** Who can read and write what is PocketBase API rules, so it holds the same
  for every client. A delete moves an item to a trash, restorable for 30 days by default.

## Further reading

- Reference: [`openapi.json`](openapi.json), the API contract, generated from the schema and the
  custom routes.
- Explanation: [`docs/generated/decisions.md`](docs/generated/decisions.md), the product and schema
  decisions and why each was made.
- How-to: [`deploy/README.md`](deploy/README.md), deploying to Railway and running the image locally.
- Index: [`docs/README.md`](docs/README.md), every other doc and which are generated.
- Contributing: [`AGENTS.md`](AGENTS.md), the gate (`make check`), the migration and schema rules,
  and the test conventions.

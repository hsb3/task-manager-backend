# Contract

The surface is the `tm` CLI and the MCP tool catalog it serves (`tm mcp` over stdio, and the hosted
endpoint of change `hosted-mcp-endpoint`, which imports the same catalog). This change adds no
server route and changes none: every verb calls routes that exist on `main`, plus the `key` object
that `hosted-mcp-endpoint` adds to `GET /api/tracker/me`. The rulings cited are this change's Open
Questions (proposal) and the decision record "Hosted MCP endpoint auth model" (kata `hfrk`).

## Routes

The verbs, the tool each is served as, and the server calls each makes, in order. `{API}` is the
configured server URL; every call carries the key in `Authorization`, as today. A list call reads
every page (`perPage=500`, `skipTotal=1`, pages 1, 2, ... until a page returns fewer than 500
rows) where "all pages" is written.

| CLI | MCP tool | Scope | Server calls |
| --- | --- | --- | --- |
| `tm list` | `tm_list` | read | unchanged |
| `tm show <id>` | `tm_show` | read | `GET /api/collections/project_items/records/{id}`; `GET /api/collections/{kind}s/records/{id}`; for a task, document or decision, all pages of `GET /api/collections/comments/records?filter={kind}="{id}"&sort=created,id` |
| `tm search <text>` | `tm_search` | read | unchanged |
| `tm create <title>` | `tm_create` | write | unchanged |
| `tm edit <id>` | `tm_edit` | write | unchanged |
| `tm comment <id> <text>` | `tm_comment` | write | unchanged |
| `tm me` | `tm_me` | read | `GET /api/tracker/me` |
| `tm workspace <workspace>` | `tm_workspace` | read | `GET /api/collections/workspaces/records/{workspace}?expand=owner`; then, together, all pages of `projects` (`filter=workspace="{workspace}" && trashed=""`, `sort=name,id`), `statuses` (`filter=workspace="{workspace}"`, `sort=position,id`), `labels` (same filter, `sort=name,id`), `cycles` (same filter, `sort=starts_on,id`) and `workspace_members` (same filter, `sort=created,id`, `expand=user`) |
| `tm notifications` | `tm_notifications` | read | `GET /api/collections/notifications/records?filter=<below>&sort=read,-created,id&perPage={limit}&page={page}&skipTotal=1` |
| `tm trash <workspace>` | `tm_trash` | read | `GET /api/tracker/trash?workspace={workspace}&perPage={limit}&page={page}` |
| `tm delete <id>` | `tm_delete` | write | `GET /api/collections/project_items/records/{id}`; then, only for a live item, `DELETE /api/collections/{kind}s/records/{id}` |
| `tm restore <id>` | `tm_restore` | write | `GET /api/collections/project_items/records/{id}`; then, only for a trashed item, `PATCH /api/collections/{kind}s/records/{id}` with `{"trashed": "", "trashed_by": ""}` |
| `tm subscribe <id>` | `tm_subscribe` | write | `GET /api/collections/project_items/records/{id}`; `GET /api/tracker/me`; `GET /api/collections/task_subscribers/records?filter=task="{id}" && user="{me}"&perPage=1&skipTotal=1`; then at most one of `POST /api/collections/task_subscribers/records` `{"task": id, "user": me}` or `DELETE /api/collections/task_subscribers/records/{row}` |
| `tm mark-read` | `tm_mark_read` | write | `POST /api/tracker/notifications/read-all[?workspace={workspace}]` |

`{kind}` is the item's `type` column in `project_items` (`task`, `document`, `decision` or
`milestone`). The notifications filter is the clauses below joined with ` && `, empty when none
apply: `read = false` when `unread` is true; `(workspace = "{workspace}" || workspace = "")` when a
workspace is given, the same set `read-all` marks for that workspace. Every `{id}` and
`{workspace}` value enters a filter through `JSON.stringify`, as `tm list` does today.

"Scope" is what the hosted endpoint and `tm mcp` filter `tools/list` by (decision hfrk, ruling 7):
a read tool has `readOnlyHint` true and is listed for every credential; a write tool is listed
only when the credential's scope is not `read`.

## Requests and Responses

### MCP tools

Arguments are the tool's `inputSchema` (JSON Schema, `type: "object"`). `ID`, `WORKSPACE`,
`LIMIT` and `PAGE` are the shared definitions already in the catalog (`LIMIT` and `PAGE` are
lifted out of `tm_list` unchanged: integers, minimum 1, defaults 50 and 1).

| Tool | Properties | Required | Annotations |
| --- | --- | --- | --- |
| `tm_list` | unchanged | none | `readOnlyHint: true, openWorldHint: false` |
| `tm_show` | `id: ID` | `id` | `readOnlyHint: true, openWorldHint: false` |
| `tm_search` | unchanged | `query` | `readOnlyHint: true, openWorldHint: false` |
| `tm_create` | unchanged | `title` | `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false` |
| `tm_edit` | unchanged | `id` | `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false` |
| `tm_comment` | unchanged | `id`, `body` | `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false` |
| `tm_me` | none | none | `readOnlyHint: true, openWorldHint: false` |
| `tm_workspace` | `workspace: WORKSPACE` | `workspace` | `readOnlyHint: true, openWorldHint: false` |
| `tm_notifications` | `workspace: WORKSPACE`, `unread: boolean`, `limit: LIMIT`, `page: PAGE` | none | `readOnlyHint: true, openWorldHint: false` |
| `tm_trash` | `workspace: WORKSPACE`, `limit: LIMIT`, `page: PAGE` | `workspace` | `readOnlyHint: true, openWorldHint: false` |
| `tm_delete` | `id: ID` | `id` | `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false` |
| `tm_restore` | `id: ID` | `id` | `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false` |
| `tm_subscribe` | `id: ID`, `follow: boolean` (default true) | `id` | `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false` |
| `tm_mark_read` | `workspace: WORKSPACE` | none | `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false` |

A successful call returns, as today, one text block holding the verb's JSON (the `--json` output
below, `JSON.stringify(value, null, 2)`) with `isError: false`. Tools declare no `outputSchema`. A
failure returns the AC-13 shape of `hosted-mcp-endpoint`'s contract (`isError: true`,
`structuredContent.error` `{status, code, message, fields}`, the same object as the text block).

### Results (`--json` and the MCP text block)

Field names are the API's. A `Record` is the server's record verbatim.

- **`tm_me`**: `GET /api/tracker/me` verbatim:
  `{user: {id, name}, unread_notifications: integer, workspaces: [{id, name, role, status, counts, capabilities}], key: {id, scope, expires, client_id, reach, workspace, projects, manage_keys}}` (`reach`,
  `workspace` and `projects` from change `key-scoping`, `manage_keys` from change
  `key-minting-cli`). Fields a later server change adds are passed through.
- **`tm_workspace`**:
  ```json
  {
    "id": "...", "name": "...", "owner": "<user id>",
    "priorities": [{ "id": "...", "name": "urgent" }],
    "projects": [{ "id": "...", "key": "MYP", "name": "..." }],
    "statuses": [{ "id": "...", "name": "Backlog", "category": "backlog", "position": 0, "is_default": true }],
    "labels": [{ "id": "...", "name": "Bug", "project": "" }],
    "cycles": [{ "id": "...", "name": "...", "starts_on": "...", "ends_on": "..." }],
    "members": [{ "user": "<user id>", "name": "Alice", "role": "owner", "status": "active" }]
  }
  ```
  `priorities` is the workspace record's `priorities` verbatim (`[]` when empty). `members` holds
  every membership row in `created,id` order; a row's `role` is `owner` when its user is the
  workspace's `owner`, else the row's role; `name` is the expanded user's name (`""` when not
  expanded). When the owner holds no membership row, an entry
  `{user: owner, name: <expanded owner's name>, role: "owner", status: "active"}` comes first. No
  member carries an email address.
- **`tm_notifications`**: an array of `notifications` Records (unread first, then newest first).
- **`tm_trash`**: `{workspace, count, page, perPage, items}` with `count`, `page` and `perPage`
  from the route, and each `items` entry
  `{id, kind, key, title, project, trashed, trashed_by, purge_at, purge_days}`: `kind` is the
  entry's `collection` without its final `s`, `title` is the record's `title` (a milestone's
  `name`), and the rest are the record's fields and the entry's `purge_at` and `purge_days`.
- **`tm_delete`**: `{id, kind, title, trashed: true}`, `title` from the `project_items` row.
- **`tm_restore`**: the restored Record plus `kind`, as `tm_edit` returns an item.
- **`tm_subscribe`**: `{task: "<id>", following: boolean}`, the state after the call.
- **`tm_mark_read`**: `{updated: integer}`, the route's answer.
- **`tm_show`**: the item Record plus `kind`, as today, plus `comments`: an array of `comments`
  Records oldest first (`[]` for a milestone and for an item with none).

### CLI

New verbs and options, in the usage text in this order after `comment` and before `mcp`:

```
  me                                who the key acts for: workspaces, unread count, key scope
  workspace <workspace>             projects, statuses, labels, cycles and members, with ids
  notifications [--workspace ID] [--unread] [--limit N] [--page N]
  trash <workspace> [--limit N] [--page N]
  delete <id>                       move an item to the trash
  restore <id>                      bring an item back from the trash
  subscribe <id> [--off]            follow a task; --off stops following
  mark-read [--workspace ID]        mark notifications read
```

`--unread` and `--off` are booleans. `--json` prints the result above; without it:

| Verb | Human output (one line each, columns as `tm list` pads them) |
| --- | --- |
| `me` | `<name> (<user id>)`; `key       <scope>` when `key` is present; `unread    <n>`; then per workspace `<id>  <role, 7> <status, 9> <name>` |
| `workspace` | `<name> (<id>)`; then each section title (`projects`, `statuses`, `labels`, `cycles`, `members`, `priorities`) on its own line, followed by its rows indented two spaces, or `  none`: projects `<id>  <key, 8> <name>`; statuses `<id>  <category, 10> <name>`; labels `<id>  <name>`; cycles `<id>  <starts_on 10 chars>..<ends_on 10 chars> <name>`; members `<user>  <role, 7> <status, 9> <name>`; priorities `<id>  <name>` |
| `notifications` | per row `<id>  <unread or read, 6> <kind, 21> <`task || document || decision || workspace || ""`, 15> <comment_preview>`; `no notifications` when empty |
| `trash` | `<count> in the trash`; then per item `<id>  <kind, 9> <key, 8> <purge_days>d  <title>` |
| `delete` | `trashed <id>  <kind> <title>` |
| `restore` | the item's fields, as `show` prints a record |
| `subscribe` | `following <id>` or `not following <id>` |
| `mark-read` | `marked <n> read` |
| `show` | the record's fields as today (without `comments`), then per comment `comment <created> <author>: <body>` |

## Errors

Every refusal reaches an MCP client as the AC-13 shape and a CLI user as today's exit codes: a
server refusal exits 1 with `tm: <message>` on stderr; a usage refusal exits 2 with the message and
the usage text. A verb's own refusal raised after a server lookup (for example "already in the
trash") is a usage refusal: AC-13 `status: null`, `code: "invalid_arguments"`, CLI exit 2, as
`tm comment` on a milestone is today.

| Verb | Condition | AC-13 `status`, `code` | Message |
| --- | --- | --- | --- |
| every tool | arguments fail the input schema (wrong type, `limit` or `page` below 1, a required one missing) | null, `invalid_arguments` | the validator's message, naming the argument |
| `workspace`, `trash`, `delete`, `restore`, `subscribe`; and `notifications`, `mark-read` when a workspace is given as `""` | the id or workspace is empty (`""`) | null, `invalid_arguments` | `missing <id>` or `missing <workspace>` |
| `workspace`, `trash` | the workspace is unknown, in the trash, or not the caller's | 404, `not_found` | `no workspace <workspace> that you can read` |
| `trash` | the route refuses (time zone, server error) | the route's | the route's |
| `show`, `delete`, `restore`, `subscribe` | no `project_items` row the caller can read | 404, `not_found` | `no item <id> that you can read` (today's) |
| `delete` | the item is already in the trash | null, `invalid_arguments` | `item <id> is already in the trash; restore brings it back` |
| `restore` | the item is not in the trash | null, `invalid_arguments` | `item <id> is not in the trash` |
| `restore` | its project is in the trash or gone | 400, `invalid_request` | `Cannot restore: the parent project is in the trash or no longer exists.` (server) |
| `subscribe` | the item is not a task | null, `invalid_arguments` | `only tasks can be followed; <id> is a <kind>` |
| `subscribe` | the task is in the trash | null, `invalid_arguments` | `item <id> is in the trash; restore it first` |
| `subscribe` | the server refuses the subscription row (a viewer, for example) | 400, `invalid_request` | `Failed to create record.` (server) |
| `show` | the item is in the trash (its `project_items` row is readable, the record is not) | 404, `not_found` | `The requested resource wasn't found.` (server) |
| `delete` | a viewer (another's draft is the no-row case above) | 404, `not_found` | `The requested resource wasn't found.` (server) |
| every write verb | read key | 403, `api_key_scope` | `This API key is read-only.` (server) |
| every verb | invalid, revoked or expired key | 401, `api_key_invalid` | the server's |
| every verb | server unreachable | 0, `unreachable` | `cannot reach <url>: the server did not answer` (today's) |
| CLI `workspace`, `trash`, `delete`, `restore`, `subscribe` | positional missing | CLI exit 2 | `missing <workspace>` or `missing <id>` |

Not refusals: `tm_subscribe` asking for the state the caller is already in answers that state and
writes nothing; `tm_mark_read` with nothing unread, or with a workspace id that matches nothing,
answers `{updated: 0}`; `tm_notifications` past the last page answers `[]`.

## Auth

Every verb runs with the credential `tm` already uses (saved login, or `TM_URL` and `TM_API_KEY`;
over the hosted endpoint, the caller's key), and the server decides every read and write as it
does today. A read key is offered the seven read tools only; a write tool reached anyway (stdio,
an old client) is refused by the server with 403 `api_key_scope`. A key's other limits (change
`key-scoping`) apply server-side and reach every verb unchanged. No verb sends the second `DELETE`
that purges a trashed item; the check and the delete are two requests, so two concurrent
`tm_delete` calls on one live item can still purge it under a `manage` or `own` key of the
workspace owner or an admin (`key-scoping` refuses a `write` key's purge with 403
`api_key_scope`).

## Compatibility

- **New tools and CLI verbs** are additions. Names and required inputs follow the versioning
  policy's catalog rule (change `api-versioning-policy`): adding a tool is not breaking.
- **`tm_show` and `tm show --json`** gain a `comments` array; every existing field stays. A record
  field named `comments` does not exist on any item collection.
- **Annotations.** Every tool now states every hint. `tm_edit`'s `destructiveHint` changes from
  false to true and every tool gains `openWorldHint: false`, so a client that asked before
  destructive calls now asks before `tm_edit`. Annotations are not contract under the versioning
  policy.
- **`tools/list` under a read key** gains `tm_me`, `tm_workspace`, `tm_notifications` and
  `tm_trash` beside `tm_list`, `tm_show` and `tm_search`.
- **Unchanged:** `tm list`, `tm search`, `tm create`, `tm edit`, `tm comment`, `tm login`,
  `tm mcp`'s transport and configuration, every server route and record.

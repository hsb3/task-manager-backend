## Purpose

The verbs the `tm` CLI and its MCP tool catalog offer an agent: orient, find work, read it, act on
it, follow it and undo a mistake, what each reaches, its annotations, and which credentials see it.

## ADDED Requirements

### Requirement: The catalog covers an agent's work loop

The MCP tool catalog SHALL hold, in this order, `tm_list`, `tm_show`, `tm_search`, `tm_create`,
`tm_edit`, `tm_comment`, `tm_me`, `tm_workspace`, `tm_notifications`, `tm_trash`, `tm_delete`,
`tm_restore`, `tm_subscribe` and `tm_mark_read`, and no tool that creates or changes a project,
status, label, cycle, saved view, template, invitation, membership or workspace. The stdio server
and the hosted endpoint SHALL serve this one catalog.

#### Scenario: A write key lists the tools

- **WHEN** an agent holding a write key sends `tools/list` to `tm mcp`
- **THEN** it receives every tool of the catalog, in catalog order

### Requirement: Every tool states every annotation

Every tool SHALL set `readOnlyHint` and `openWorldHint` explicitly, and every tool whose
`readOnlyHint` is false SHALL also set `destructiveHint` and `idempotentHint` explicitly.
`openWorldHint` SHALL be false on every tool. `destructiveHint` SHALL be false only for a tool that
makes purely additive changes (`tm_create`, `tm_comment`) and true for every other write tool.

#### Scenario: A client reads the hints of tm_delete

- **WHEN** a client lists the tools
- **THEN** `tm_delete` carries `readOnlyHint` false, `destructiveHint` true, `idempotentHint` true and `openWorldHint` false

#### Scenario: tm_edit is no longer marked additive

- **WHEN** a client lists the tools
- **THEN** `tm_edit` carries `destructiveHint` true

### Requirement: A read credential is offered only the read tools

`tools/list` under a read-scoped credential SHALL return exactly the tools whose `readOnlyHint` is
true: `tm_list`, `tm_show`, `tm_search`, `tm_me`, `tm_workspace`, `tm_notifications` and
`tm_trash`. A write tool called under a read key SHALL still be refused by the server with 403
`api_key_scope`.

#### Scenario: A read key lists the tools

- **WHEN** an agent holding a read key sends `tools/list` to `tm mcp`
- **THEN** it receives the seven read tools and none of the write tools

### Requirement: An agent can learn who it is and what its credential may do

`tm_me` and `tm me` SHALL return the caller, every workspace the credential reaches with its role,
status, counts and capabilities, the unread notification count, and the credential's own scope,
exactly as the server's `GET /api/tracker/me` answers.

#### Scenario: A read key asks who it is

- **WHEN** an agent holding a read key calls `tm_me`
- **THEN** the result names the key's user, lists the user's workspaces and carries `key.scope` `read`

### Requirement: An agent can read a workspace's vocabulary with the ids edits take

`tm_workspace` and `tm workspace <workspace>` SHALL return one workspace's id, name, owner and
priorities, and its live projects, statuses, labels, cycles and members, each with the id an edit
takes, reading every page of each list. A member SHALL be reported with role `owner` when they own
the workspace, and SHALL carry no email address.

#### Scenario: An agent reads its workspace

- **WHEN** an agent calls `tm_workspace` with a workspace it belongs to
- **THEN** the result lists the workspace's statuses with their ids and categories, its labels, cycles, live projects and members, and the owner with role `owner`

#### Scenario: A workspace the caller cannot read

- **WHEN** an agent calls `tm_workspace` with an id that names no workspace it can read
- **THEN** the result is a tool failure with status 404 whose message names the id

### Requirement: An agent can read its inbox and clear it

`tm_notifications` and `tm notifications` SHALL return one page of the caller's notifications,
unread before read and newest first within each, optionally only the unread ones and optionally
only those of one workspace together with those tied to no workspace. `tm_mark_read` and
`tm mark-read` SHALL mark the caller's unread notifications read, optionally only those of one
workspace and those tied to no workspace, and report how many changed. Marking read SHALL need a
write key.

#### Scenario: A comment reaches the inbox

- **WHEN** another member comments on a task the caller follows and the caller calls `tm_notifications` with `unread` true
- **THEN** the first row is that `commented` notification with `read` false

#### Scenario: Clearing the inbox

- **WHEN** a write key calls `tm_mark_read` and then `tm_me`
- **THEN** `tm_mark_read` reports the number marked and `tm_me` reports `unread_notifications` 0

#### Scenario: A read key clears the inbox

- **WHEN** a read key calls `tm_mark_read`
- **THEN** the result is a tool failure with status 403 and code `api_key_scope`

### Requirement: An agent can follow and stop following a task

`tm_subscribe` and `tm subscribe` SHALL make the caller follow a task, or stop following it when
asked, and SHALL report whether the caller now follows it. A call that asks for the state the
caller is already in SHALL change nothing and succeed. Only a task can be followed; any other kind
SHALL be refused before anything is written.

#### Scenario: Following a task twice

- **WHEN** an agent calls `tm_subscribe` twice on the same task
- **THEN** both calls report `following` true and the caller holds one subscription to the task

#### Scenario: Following a document

- **WHEN** an agent calls `tm_subscribe` with a document's id
- **THEN** the result is a tool failure with code `invalid_arguments` and nothing is written

### Requirement: Showing an item returns its comments

`tm_show` and `tm show` SHALL return the item together with every comment on it, oldest first. A
milestone, which takes no comments, SHALL carry an empty comment list.

#### Scenario: Reading a discussed task

- **WHEN** an agent calls `tm_show` on a task with two comments
- **THEN** the result carries the task and both comments, the older first

### Requirement: An agent can list a workspace's trash

`tm_trash` and `tm trash <workspace>` SHALL list one page of a workspace's trashed tasks,
documents, decisions and milestones, each with its id, kind and the time it will be purged.

#### Scenario: A trashed task in the list

- **WHEN** an agent calls `tm_trash` on a workspace holding one trashed task
- **THEN** the items hold that task with kind `task`

### Requirement: An agent can trash an item and never purge it

`tm_delete` and `tm delete` SHALL move a live task, document, decision or milestone to the trash,
and SHALL refuse an item already in the trash without sending any delete, so no verb purges an
item. It SHALL need a write key. Projects stay out of the trash verbs.

#### Scenario: Trash a task

- **WHEN** an agent calls `tm_delete` on a live task
- **THEN** `tm_show` no longer finds the task and `tm_trash` lists it

#### Scenario: Deleting an item already in the trash

- **WHEN** the workspace owner's write key calls `tm_delete` on a task that is already in the trash
- **THEN** the result is a tool failure with code `invalid_arguments` saying the item is already in the trash
- **AND** the task is still in the trash list afterwards

### Requirement: An agent can restore a trashed item

`tm_restore` and `tm restore` SHALL bring a trashed item back, clearing who trashed it, and SHALL
refuse an item that is not in the trash. It SHALL need a write key.

#### Scenario: Restore a task

- **WHEN** an agent calls `tm_restore` on a trashed task
- **THEN** the task reads again with `trashed` and `trashed_by` empty

#### Scenario: Restoring a task whose project is in the trash

- **WHEN** an agent calls `tm_restore` on a trashed task whose project is also in the trash
- **THEN** the result is a tool failure with status 400 carrying the server's message

### Requirement: The CLI offers the same verbs with the same answers

The `tm` CLI SHALL offer `me`, `workspace`, `notifications`, `trash`, `delete`, `restore`,
`subscribe` and `mark-read`. With `--json` each SHALL print exactly the JSON the matching tool
returns; without it, a short human summary. A server refusal SHALL exit 1 and a usage refusal 2,
as the existing verbs do.

#### Scenario: Same answer from the CLI and the tool

- **WHEN** the same key runs `tm workspace <id> --json` and calls `tm_workspace` with that id
- **THEN** both print the same JSON

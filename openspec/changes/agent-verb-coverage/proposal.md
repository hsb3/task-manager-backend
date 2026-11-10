# Proposal

## Why

An agent working the tracker through `tm` or `tm mcp` can find, read, create and edit items and
comment on them, and nothing else (AC-10). The catalog in `clients/tm/src/mcp.ts` holds
`tm_list`, `tm_show`, `tm_search`, `tm_create`, `tm_edit` and `tm_comment`, each a function in
`clients/tm/src/verbs.ts` that the CLI also calls. An agent cannot learn which workspaces it is in,
what statuses, labels and cycles a workspace offers, what is in its inbox, or what is in the trash;
it cannot trash, restore, subscribe or clear notifications by any tool built for it. The hosted MCP
service reuses this catalog (decision hfrk, ruling 5), so its gaps become the hosted endpoint's
gaps, and its annotations become what a hosted client shows a person before a call.

What a key reaches today (room probe, 2026-11-10, current migrations and hooks, a user's write
key and read key; the key allowlist is `pb_hooks/api_keys.pb.js`, the routes `pb_hooks/lib/routes.js`
and `openapi.json`):

- **Reads, both scopes, 200:** the record lists of projects, labels, statuses, cycles,
  notifications, task_subscribers, saved_views, workspaces, workspace_members, milestones,
  templates, task_activity, comments, users and user_settings; and `GET /api/tracker/me`,
  `/summary`, `/trash?workspace=`, `/workspaces/trash`, `/invitations/mine`,
  `/project-items/counts` and `/users/{id}/settings`.
- **Refused to every key, 403 `api_key_path`:** the api_keys collection (list and create) and
  `/api/tracker/admin/*`.
- **Writes, write key:** a task's status, labels and cycle are set by id with a PATCH (200, and
  the record reads back with them set).
  Labels, statuses, cycles, projects, saved views and workspaces are created (200). A user
  unsubscribes from a task by deleting their own task_subscribers row (204) and subscribes again by
  creating it (200); creating a task subscribes its author already. `POST
  /api/tracker/notifications/read-all` answers 200. `DELETE` on a task moves it to the trash (204;
  the record then reads 404 and appears in `/api/tracker/trash`), and a PATCH setting `trashed`
  empty restores it (200). A project trashes and restores the same way, but the trash list holds
  only tasks, decisions, documents and milestones (`openapi.json`, `/api/tracker/trash`).
- **A second `DELETE` purges.** `DELETE` on an item already in the trash removes it for good when
  the caller is the workspace owner or an admin (`pb_hooks/trash.pb.js`); with the owner's write
  key the second `DELETE` answered 204, the restoring PATCH then answered 404 and the item left the
  trash list. `DELETE` on a label removes it outright (204, then 404).
- **Also reachable by a write key:** inviting by email (`/workspaces/{id}/resolve-member-email`),
  transferring ownership, and replacing a workspace's statuses and labels wholesale
  (`POST /api/tracker/workspaces/{id}/vocab`, owner or admin). Export (`POST /api/tracker/export`)
  counts as a read, so a read key reaches it too (`pb_hooks/api_keys.pb.js`).
- **Read key:** a write answers 403 `api_key_scope`.
- **No route tells a key its own scope.** api_keys is closed to keys, and `/api/tracker/me` returns
  the user, the unread count and each workspace's role and capabilities, not the credential's
  scope (`openapi.json`, `/api/tracker/me`).
- `tm_edit` passes its `fields` straight into the PATCH (`edit` in `clients/tm/src/verbs.ts`), so
  restore is reachable today as an undocumented `{"trashed": ""}` (inferred from the code; not
  probed through `tm`).
- The current tools set `readOnlyHint`, and the write tools set `destructiveHint: false`; none sets
  `openWorldHint` (`clients/tm/src/mcp.ts`), which the specification defaults to true.

## Prior art

Each source was fetched on 2026-11-10.

- **Linear** (https://linear.app/docs/mcp), the app this one converges on. Read-write access is
  `https://mcp.linear.app/mcp`; `https://mcp.linear.app/mcp/readonly` "only ever exposes read
  tools", or a client may "only request the `read` OAuth scope". The page names no tools: they are
  published at run time through `tools/list`. Two third-party catalogs, both undated, give
  snapshots that disagree, so the official tool list is unverified:
  https://docs.litellm.ai/docs/mcp_servers/linear lists `list_issues`, `get_issue`,
  `create_issue`, `update_issue`, `list_my_issues`, `list_issue_statuses`, `get_issue_status`,
  `list_issue_labels`, `list_projects`, `get_project`, `create_project`, `update_project`,
  `list_comments`, `create_comment`, `list_documents`, `get_document`, `list_cycles`,
  `list_teams`, and says "Writes are limited to issues, projects, and comments".
  https://www.speakeasy.com/product/mcp-gateway/catalog/linear ("the official Linear MCP server")
  lists upserts instead (`save_issue`, `save_project`, `save_comment`, `save_milestone`), plus
  `delete_comment`, `delete_attachment`, `list_users` and `search_documentation`. Common to both:
  snake_case `verb_noun` names, one tool per entity and verb, `get_` for one record and `list_`
  for many, a separate read tool per vocabulary (statuses, labels, cycles, teams), and no tool that
  deletes or archives an issue or a project.
- **GitHub's MCP server** (https://github.com/github/github-mcp-server). Tools are grouped into
  toolsets chosen with `--toolsets`: "Enabling only the toolsets that you need can help the LLM
  with tool choice and reduce the context size." Read-only mode "takes priority: write tools are
  skipped if `--read-only` is set, even if explicitly requested via `--tools`". A validator in the
  repository (`pkg/toolvalidation/readonlyhint.go`) refuses any tool that does not set
  `ReadOnlyHint` explicitly. Names are snake_case in mixed order (`issue_read`,
  `add_issue_comment`, `search_issues`).
- **MCP specification 2026-07-28**
  (https://modelcontextprotocol.io/specification/2026-07-28/server/tools and its `schema.ts`).
  `readOnlyHint` defaults to false; `destructiveHint` ("may perform destructive updates") defaults
  to true and `idempotentHint` to false, both meaningful only for a tool that is not read-only;
  `openWorldHint` defaults to true. Annotations are hints: clients "MUST consider tool annotations
  to be untrusted unless they come from trusted servers". The tool list "MAY vary by the
  authorization presented on the request" but "MUST NOT vary per-connection".
- **Tool count.** Anthropic (https://www.anthropic.com/engineering/writing-tools-for-agents):
  "More tools don't always lead to better outcomes" and "Namespacing (grouping related tools under
  common prefixes) can help delineate boundaries". A Cursor forum answer
  (https://forum.cursor.com/t/about-limitation-of-the-number-of-mcp-tools/107844, 2025-06-23)
  states "a hard limit of 40 tools total"; Cursor's own MCP page states no cap, so whether the limit
  still holds is unverified.

## What Changes

As ruled on 2026-11-10 (Open Questions below):

- The catalog covers an agent's work loop: orient, find work, read it, act on it, follow it, and
  undo a mistake. New read tools: `tm_me` (the caller, its workspaces with role and capabilities,
  the unread count, and the credential's scope), `tm_workspace` (one workspace's projects,
  statuses, labels, cycles and members, with the ids edits take), `tm_notifications` (the inbox,
  unread first) and `tm_trash` (a workspace's trashed items). New write tools: `tm_delete` (moves
  an item to the trash), `tm_restore` (brings it back), `tm_subscribe` (follow or stop following a
  task) and `tm_mark_read` (clear the inbox, optionally for one workspace). `tm_show` returns an
  item's comments with it. The trash tools cover the item kinds the trash list holds; projects
  stay out, since trashing one is a workspace-management act (`capabilities.manage` in
  `/api/tracker/me`). Status, labels, cycle, assignee and milestone stay fields of `tm_edit`.
- The CLI gains the same verbs (`tm me`, `tm workspace`, `tm notifications`, `tm trash`, `tm
  delete`, `tm restore`, `tm subscribe`, `tm mark-read`), each one function in
  `clients/tm/src/verbs.ts` that both front ends call.
- Permanent deletion is never a tool. `tm_delete` refuses an item that is already in the trash
  instead of sending the `DELETE` that would purge it, so a retried call has no further effect. The
  check and the `DELETE` are two requests, so two concurrent calls can still purge under a key
  allowed to purge; change `key-scoping` (AC-4, built before this change) refuses a `write` key's
  purge with 403 `api_key_scope`, leaving the race to `manage` and `own` keys.
- Every tool states every annotation explicitly: `readOnlyHint`; for a write, `destructiveHint`
  and `idempotentHint`; `openWorldHint: false` on all, since no tool reaches outside the tracker.
  `destructiveHint` keeps the specification's meaning, false only for a purely additive write:
  `tm_create` and `tm_comment` are false; `tm_edit` (it overwrites values, and is marked false
  today), `tm_delete`, `tm_subscribe` (unfollowing removes a row) and `tm_mark_read` are true.
- A read-scoped credential is offered only the read tools, under stdio and hosted alike (decision
  hfrk, ruling 7). `readOnlyHint` is the one marker the filter reads, so a tool cannot be read for
  one purpose and write for the other.
- `GET /api/tracker/me` called with a key also returns that key's scope, so `tm mcp`, which holds
  only a key, can filter its own list. The hosted service holds only the caller's key too
  (decision hfrk, ruling 5), so it asks the same route. A key read-only by scope still sees every write refused with
  403 `api_key_scope`, so the filter is a convenience and never the control.
- Names keep the `tm_` prefix and one verb each. The catalog stays small enough that no toolset
  switch is needed; that is revisited if it nears the tool caps clients report.

## How it bears on the hosted MCP endpoint (decision hfrk)

- **Ruling 5, one catalog.** The hosted service imports the same `TOOLS` array and calls each
  tool's `run` with a configuration built per request: PocketBase's private URL and the caller's
  own credential. Nothing in a tool knows which transport called it.
- **Ruling 7, read-only.** The hosted service and `tm mcp` both learn a credential's scope from
  `/api/tracker/me`, called with that credential. Both drop every tool whose `readOnlyHint` is not true. The
  list varies by the credential presented, which the specification allows, and never within one
  connection.
- **Ruling 6 and AC-4.** A grant's credential is a key, so the read or write choice at consent is
  the key's scope. A write grant includes `tm_delete`; `key-scoping` (AC-4) refuses that key's
  purge on the plain API, and `tm_delete` never sends the purging call anyway, while
  `destructiveHint: true` lets a client ask first.

## Capabilities

- `agent-verbs`: the verbs the CLI and the MCP catalog offer, what each reaches, its annotations,
  and which credentials see it.

## Open Questions

Each was ruled on 2026-11-10; the rejected options are kept in one line for the record.

1. **How far the verbs reach.** Ruled: the work loop only (orient, find, read, edit, comment,
   follow, trash and restore); workspace setup and every other route a key reaches stay on the
   plain API. Rejected: work loop plus workspace setup; every route a key reaches.
2. **Trash and restore as tools.** Ruled: delete-to-trash and restore, with `tm_delete` marked
   destructive and refusing an item already in the trash. The plain API still lets an owner's or
   admin's write key purge with a second `DELETE` until AC-4. Rejected: restore and trash list
   only; neither.
3. **Reading a workspace's vocabulary.** Ruled: one `tm_workspace` tool returning projects,
   statuses, labels, cycles and members together. Rejected: one list tool per kind, as Linear does.
4. **Tool names.** Ruled: keep `tm_` plus one verb. Rejected: Linear's `verb_noun` style.

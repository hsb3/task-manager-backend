# Contract

This contract is written against the tree as it stands once `hosted-mcp-endpoint` is built: its
`GET /api/tracker/me` `key` object, its OAuth routes, its minted keys and its MCP tool listing
are taken as given and extended here. Terms used throughout:

- **reach**: what part of the tracker a key touches. `all` (every workspace the user belongs
  to), `workspace` (one workspace), or `projects` (some projects of one workspace).
- **level**: the key's tier, `read` < `write` < `manage` < `own`, stored in the existing `scope`
  field. The tiers follow decision:role-tiers.
- **limited key**: a key whose reach is `workspace` or `projects`.
- **W**: a limited key's workspace. **P**: a `projects` key's project set.

## Routes

No route is added. Every route a key reaches today changes as the classification table below
states. The surfaces are: the `api_keys` collection (new fields), every collection record route,
every custom tracker route, `POST /api/realtime`, `POST /api/files/token`, protected file
downloads, and the OAuth authorization, token and metadata routes of `hosted-mcp-endpoint`.

### Classification

"Level" is the lowest key level that may make the request; the user's role must also allow it
(the request is then refused as the user's own session would be). "Workspace key" and "Project
key" say what a key limited to W (or to P in W) gets. "As rules" means the collection rules
apply the reach (Errors: out of reach). Routes absent from this table keep today's answer.

#### Custom tracker routes

| Route | Level | Workspace key | Project key |
| --- | --- | --- | --- |
| `GET /api/tracker/me` | read | lists only W | lists only W; `counts` count only P |
| `GET /api/tracker/me/landing` | read | 403 `api_key_reach` | 403 `api_key_reach` |
| `GET /api/tracker/workspaces/{id}/switch` | read | 403 `api_key_reach` | 403 `api_key_reach` |
| `GET /api/tracker/invitations/mine` | read | 403 `api_key_reach` | 403 `api_key_reach` |
| `POST /api/tracker/invitations/{id}/accept` | own | 403 `api_key_reach` | 403 `api_key_reach` |
| `POST /api/tracker/invitations/{id}/decline` | own | 403 `api_key_reach` | 403 `api_key_reach` |
| `GET /api/tracker/users/{id}/settings` | read | allowed | allowed |
| `PATCH /api/tracker/users/{id}/settings` | write | 403 `api_key_reach` | 403 `api_key_reach` |
| `POST /api/tracker/notifications/read-all` | write | marks only notifications whose `workspace` is W | marks only notifications whose task, document or decision is in P |
| `GET /api/tracker/project-items/counts` | read | counts only W's items | counts only P's items |
| `GET /api/tracker/search` | read | matches only in W | matches only items and projects in P |
| `GET /api/tracker/summary` | read | counts only W's tasks | counts only P's tasks |
| `GET /api/tracker/trash?workspace=` | read | 404 unless `workspace` is W | 404 unless W; lists only P's trashed items |
| `POST /api/tracker/export` | read | 404 unless `workspace` is W | 404 unless W; exports P's projects and their work, and W's workspace record, statuses, labels, cycles and members (below) |
| `GET /api/tracker/workspaces/trash` | read | lists only W | lists only W |
| `GET /api/tracker/workspaces/{id}/deletion-impact` | read | 404 unless `{id}` is W | 404 |
| `POST /api/tracker/workspaces/{id}/vocab` | manage | 404 unless `{id}` is W | 403 `api_key_scope` (level) |
| `POST /api/tracker/workspaces/{id}/resolve-member-email` | manage | 404 unless `{id}` is W | 403 `api_key_scope` (level) |
| `POST /api/tracker/workspaces/{id}/transfer-ownership` | own | 404 unless `{id}` is W | 403 `api_key_scope` (level) |
| `GET /api/tracker/inspire` | read | allowed | allowed |
| `GET /api/tracker/keys` (added by key-minting-cli) | read | lists only the calling key | lists only the calling key |
| `POST /api/tracker/keys/{id}/revoke` (added by key-minting-cli) | none checked (a `null` level entry key-minting-cli adds with the route) | revokes only the calling key, whatever its `manage_keys`; another key's id answers the 404 an unknown id answers | same |
| `POST /api/tracker/trash/purge`, `POST /api/tracker/cycles/rollover` | none checked | unchanged (superuser-only route) | unchanged |
| `/api/tracker/admin/*` | none | 403 `api_key_path` (unchanged) | 403 `api_key_path` (unchanged) |

Project-key export: `projects` in the body is intersected with P (an absent or empty list means
P); exported tasks, decisions, documents and milestones are those in the selected projects, and
work under no project is left out; comments, activity and subscriptions follow their task,
document or decision; task activity tied to no task is left out; saved views are those whose
`project` is in the selection; labels, statuses, members and the workspace record are
exported whole; notifications are those the key may list.

#### Collection records (`/api/collections/{collection}/records[/{id}]`)

Reads (`GET`, `HEAD`) need `read`. Writes:

| Collection | `POST` | `PATCH` | `DELETE` | Reach |
| --- | --- | --- | --- | --- |
| `tasks`, `decisions`, `documents`, `milestones` | write | write | write; on a record already trashed (a purge) manage | in reach when its `workspace` is W and, for a project key, its `project` is in P |
| `projects` | write | write | write; on a project already trashed (a purge) manage | in reach when its `workspace` is W and, for a project key, it is in P |
| `comments` | write | write | write | in reach when its task, document or decision is |
| `task_subscribers` | write | (no update) | write | in reach when its task is |
| `task_activity` | (no writes) | | | in reach when its task is; a row with no task when its `workspace` is W, never for a project key |
| `saved_views`, `templates` | saved views write, templates manage | same | same | in reach when its `workspace` is W and, for a project key, its `project` is in P |
| `labels`, `statuses`, `cycles` | manage | manage | manage | in reach when its `workspace` is W (a project key reads them all) |
| `workspace_members` | (no create) | manage, including suspending the key's own user (a status write, not leaving); a change of `role` own | manage; removing the key's own user (leaving) own | in reach when its `workspace` is W (a project key reads them all) |
| `workspace_invitations` | manage | (no update) | manage | in reach when its `workspace` is W, never for a project key |
| `workspaces` | write; a limited key 403 `api_key_reach` | manage, including restoring a trashed workspace | own | in reach when it is W (a project key reads it) |
| `notifications` | (no create) | write | (no delete) | in reach when its `workspace` is W and, for a project key, its task, document or decision is in P |
| `user_settings` | write; a limited key 403 `api_key_reach` | same | same | the user's own row, any reach |
| `users` | 403 `api_key_path` (unchanged) | same | same | readable under any reach (unchanged: any signed-in user lists users) |
| `project_items`, `project_stats` (views, read only) | | | | as `tasks` (by `workspace` and `project`); `project_stats` as `projects` |
| `api_keys`, system and `_`-prefixed collections | 403 `api_key_path` (unchanged) | same | same | |
| any collection not named here | own | own | own | |

A write the key's level allows but the user's role does not is refused as today (the
collection's 400 or 404). Expansion follows the same reach: an expanded relation out of reach is
left out, as PocketBase leaves out a relation the caller cannot view.

#### Other PocketBase routes

| Route | Level | Limited key |
| --- | --- | --- |
| `POST /api/realtime` (subscribe) | read | allowed; delivery follows reach (Realtime) |
| `POST /api/files/token` | read | 403 `api_key_reach` |
| `GET /api/files/{collection}/{recordId}/{filename}` | read | served when the record is in reach, else 404 (Files) |
| `/api/batch`, auth routes, settings, logs, backups, crons | 403 `api_key_path` (unchanged) | same |

## Requests and Responses

### `api_keys` record

Fields added beside `user`, `name`, `scope`, `key_hash`, `expires`, `revoked` (and
`client_id` and the refresh-token fields of `hosted-mcp-endpoint`):

| Field | Type | Create | Read back |
| --- | --- | --- | --- |
| `scope` | select: `read`, `write`, `manage`, `own` | required, as today | as today; the level |
| `reach` | select: `all`, `workspace`, `projects` | optional; absent or `""` means `all` | set on every key made after this change; `""` on an older key, read as `all` |
| `workspace` | relation to `workspaces`, one | required for reach `workspace` and `projects`, empty for `all` | the id, or `""` |
| `projects` | relation to `projects`, up to 100 (more answers PocketBase's own 400 on `projects`) | at least one for reach `projects`, empty otherwise | ids, or `[]` |

A create is refused with 400 and nothing stored when (each refusal names its field in `data`):

| Field | Code | Message | When |
| --- | --- | --- | --- |
| `workspace` | `validation_required` | `Choose the workspace this key is limited to.` | reach `workspace` or `projects` without a workspace |
| `workspace` | `key_reach_mismatch` | `A key that reaches every workspace names no workspace or projects.` | reach `all` with a workspace or projects |
| `projects` | `key_reach_mismatch` | `Only a key limited to projects names projects.` | reach `workspace` with projects |
| `projects` | `validation_required` | `Choose at least one project.` | reach `projects` with none |
| `workspace` | `key_workspace_unreachable` | `Choose a workspace you belong to.` | the key's user neither owns it nor holds an active membership in it, or it is in the trash, or it does not exist |
| `projects` | `key_project_unreachable` | `Each project must be a live project of the chosen workspace.` | a project not in the workspace, in the trash, the workspace's hidden container, or missing |
| `scope` | `key_level_above_write` | `A key limited to projects can only read or write.` | reach `projects` with level `manage` or `own` |

An update that sets `reach`, `workspace` or `projects` is refused with 404 and the key is
unchanged, as a change to `scope` is today. Deleting the workspace for good deletes the keys
limited to it. A project deleted for good leaves its key's other projects; a `projects` key left
with none reaches no project and still reads its workspace's settings.

### `GET /api/tracker/me` under a key

The `key` object of `hosted-mcp-endpoint` gains three fields:

```json
"key": {
  "id": "<record id>", "scope": "write", "expires": "", "client_id": "",
  "reach": "projects", "workspace": "<W>", "projects": ["<P1>", "<P2>"]
}
```

`workspace` is `""` and `projects` is `[]` when they do not apply. `workspaces` lists only W under
a limited key. Each workspace's `capabilities` become:

| Flag | True when |
| --- | --- |
| `write` | the workspace is active for the user, the role is not `viewer`, and the level is `write` or above |
| `manage` | active, the user is owner or admin, the level is `manage` or above, and the reach is not `projects` |
| `own` | the user is the owner, the level is `own`, and the reach is not `projects` |

Under a project key `counts.projects` counts the live projects of P and `counts.open_items` the
open tasks in P; `unread_notifications` counts only notifications in reach. Under a user session
nothing changes.

### Files

A key downloads a protected attachment with `GET /api/files/{collection}/{recordId}/{filename}`
and the key in `Authorization`, with no `token` parameter (a `token` it sends is ignored). The
file is served when the record is in the key's reach and its user may view it; otherwise the
answer is 404 with PocketBase's `{"data":{},"message":"The requested resource wasn't found.","status":404}`.
An unlimited key may still request a file token as today.

### Realtime

A key subscribes as today. Every event the stream would deliver, on a collection topic
(`<collection>/*`, `<collection>/<id>`) or on the item topic `rt:project_items:{workspaceId}`,
is delivered only when the record it carries is in the key's reach; an event about a record out
of reach is not sent. A subscription's `options.headers` cannot widen this. A limited key's
subscription that asks for `expand` in its options is refused with 403 `api_key_reach`.

### OAuth (amends `hosted-mcp-endpoint`)

- **Scopes.** `scopes_supported` in the authorization server metadata and the protected resource
  metadata becomes `["read", "write", "manage", "own"]`. A requested scope is read as the
  highest level it names, each level implying those below: `manage` alone is read as `read write
  manage`. A granted scope is reported as the ladder up to the chosen level (`read`, `read
  write`, `read write manage`, `read write manage own`). The 401 challenge still names
  `scope="read write"`. `invalid_scope` still answers a value outside these and `offline_access`.
- **Consent.** Below the client's identity the page shows:
  1. "Workspaces": a choice between "All workspaces" (preselected) and each live workspace the
     signed-in user owns or is an active member of, by name, oldest first.
  2. "Access": "Read" and "Read and write", plus "Manage" when the requested scope reaches
     `manage` and "Own" when it reaches `own`. The highest requested level is preselected; a
     lower one may be chosen.
  A submitted workspace the user does not belong to, or a level above the requested one,
  re-renders the consent stage with status 200 (as the consent page answers every re-rendered
  stage) and the message `Choose one of the options shown.`, and issues no code.
- **Minted key.** `scope` is the chosen level; `reach` is `all`, or `workspace` with `workspace`
  the chosen workspace. Consent never makes a `projects` key.
- **Refresh.** The grant's record keeps `scope`, `reach` and `workspace`; a refresh changes only
  the key value and expiry. A refresh `scope` must equal the granted ladder (else
  `invalid_scope`).

### MCP tool listing (amends `hosted-mcp-endpoint`)

`tools/list` on the hosted endpoint and in `tm mcp` lists the read tools for a `read` key and
every tool for any other level. A tool call the key's level or reach refuses is a tool failure
carrying the API's status and code (403 `api_key_scope`, 403 `api_key_reach`, 404 `not_found`).

## Errors

All key refusals keep the shape `{"data": {"api_key": {"code": "<code>", "message": "<text>"}},
"message": "<text>", "status": <status>}`.

| Status | Code | Message | When |
| --- | --- | --- | --- |
| 401 | `api_key_invalid` | unchanged | invalid, revoked, expired or deleted key (including one whose workspace was deleted for good) |
| 403 | `api_key_path` | unchanged | a route closed to every key |
| 403 | `api_key_reach` | `This API key is limited to part of the tracker, so it cannot be used for this endpoint.` | a limited key on an account-wide request (Classification) |
| 403 | `api_key_scope` | `This API key is read-only.` | a `read` key on any write (unchanged) |
| 403 | `api_key_scope` | `This action needs an API key at the manage level or above.` | a `write` key on a manage action |
| 403 | `api_key_scope` | `This action needs an API key at the own level.` | a `write` or `manage` key on an own action |
| 404 | none | the route's own not-found answer | a record or workspace out of reach (view, update, delete, a custom route naming W') |
| 400 | none | the collection's create refusal | a create naming a workspace or project out of reach |

Order of checks: `api_key_invalid`, then `api_key_path`, then `api_key_reach`, then
`api_key_scope` by route or collection and method, then `api_key_scope` for a purge or for
leaving (decided only when the key may otherwise delete the record, so a record out of reach
still answers 404), then the collection rules or the route's own checks. A role change refused
both by the key's level and by another rule of the server may answer either refusal.

## Auth

Unchanged: a key is presented as `Authorization: Bearer tmk_...` (or bare) and acts as its user,
now narrowed by its reach and level. A user session, OAuth sign-in and superusers are unaffected.
The reach is carried to the collection rules in request headers the server sets itself
(`X-Tm-Key-Workspace`, `X-Tm-Key-Projects`); the server removes any such header a client sends, in any spelling that differs
only by `-` or `_` or letter case,
on every request, so a client can never set them.

## Compatibility

- **Existing keys** reach every workspace (`reach` `all`). A stored `write` is the `write` tier,
  so existing write keys lose: purging from the trash, workspace settings and vocabulary,
  statuses, labels, cycles and templates, invitations, member status and removal, role changes,
  handing over ownership, deleting or restoring a workspace, leaving a workspace, and accepting or
  declining invitations. Each now answers 403 `api_key_scope`; a key that needs them is reissued
  at `manage` or `own`. This supersedes decision:api-keys' accepted limit "Write keys reach every
  non-admin tracker route".
- **`api_keys`** gains `reach`, `workspace` and `projects`, and `scope` gains `manage` and
  `own`. A client that treats `scope` as read-or-write must expect the two new values.
- **`GET /api/tracker/me`** under a key: a read key's capabilities are all false (they were the
  role's), a write key's `manage` and `own` are false, and `key` gains `reach`, `workspace` and
  `projects`. Under a user session nothing changes.
- **Files**: a key may now download a protected file without a token. File tokens are unchanged
  for unlimited keys.
- **OAuth and MCP**: scopes `manage` and `own` are new and offered only on request; existing
  grants are `reach` `all` with their scope unchanged.
- **`openapi.json`**: each tracker route's API-key sentence states the level it needs.
- Every route a user session calls answers as before.

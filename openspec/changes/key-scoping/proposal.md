# Proposal

## Why

An agent's key reaches everything its user reaches. A key cannot be limited to one workspace or
project (AC-3), and a write key cannot be kept away from deleting, purging and handing over
ownership while it goes on creating and editing work (AC-4). An agent given a key for one
project can therefore empty or give away every workspace its user owns. The hosted MCP endpoint
makes this pressing: the accepted decision record "hosted MCP endpoint auth model" (kata `hfrk`, owner rulings of 2026-11-10 on change `hosted-mcp-endpoint`) rules that an OAuth grant mints a
`tmk_`-style key and that AC-3 and AC-4 are built once in the key model, so every hosted client
inherits whatever limits a key can carry, and the consent page has to offer them.

What the server does today (a room probe run for this proposal on 2026-11-10, not yet a repo suite, current migrations and hooks, one user
owning three workspaces, one write key and one read key; tree paths as cited):

- A key has `scope` `read` or `write` and no workspace or project field
  (`schema/api_keys.json`). The key middleware sets the request's caller to the key's user
  (`e.auth = owner` in `pb_hooks/api_keys.pb.js`), so every collection rule and every custom
  route sees the user, never the key.
- One write key created tasks in two workspaces (200, 200), listed both, found both through
  `GET /api/tracker/search`, and exported a workspace through `POST /api/tracker/export` (200).
- `GET /api/tracker/me` under that key listed every workspace of the user. Under the read key
  it answered `capabilities.write: true` for each workspace: the answer describes the user's
  role and not the key, so a read-only agent is told it may write.
- The same write key, acting for the owner: deleted a task (204, to the trash) and deleted it
  again (204, purged; a superuser then reads 404); changed a member's role to admin
  (`PATCH /api/collections/workspace_members/records/{id}`, 200); invited a new address
  (`POST /api/collections/workspace_invitations/records`, 200); handed a workspace to another
  member (`POST /api/tracker/workspaces/{id}/transfer-ownership`, 200, owner changed); and
  deleted a workspace twice (204 to the trash, 204 purged, superuser reads 404).
- What a key cannot do today: a read key answers 403 `api_key_scope` to any write, including
  `transfer-ownership`; any key answers 403 `api_key_path` to deleting its own user or to
  minting a key (decision:api-keys, decision:api-key-reads-refused).
- A key may call `POST /api/files/token` (the read list in `pb_hooks/api_keys.pb.js`; probe 200)
  and receives a file token for its user, which is no narrower than the user.
- Custom tracker routes skip collection rules and scope their reads by membership by hand
  (the "routes BYPASS rules" comments in `pb_hooks/routes.pb.js`, which serves search, export
  and trash; `pb_hooks/counts.pb.js` and `pb_hooks/me.pb.js` query by membership too), so a
  limit that lives only in collection rules would not reach them.
- `GET /api/tracker/me` already reports three capability tiers per workspace from
  decision:role-tiers (`pb_hooks/me.pb.js`): `write` (items and projects, including the trash),
  `manage` (settings, vocabulary, invitations and purge, held by owner and admin) and `own`
  (roles, transfer and workspace deletion, held by the owner).
- Realtime: a stream keeps the caller it subscribed with (decision:api-keys, "Open realtime
  streams survive revocation"), and that caller is the user. The workspace topic
  `rt:project_items:{workspaceId}` re-checks membership at delivery by user id
  (`pb_hooks/realtime.pb.js`). Nothing on a stream knows which key opened it.

### What counts as destructive or ownership-changing

Inventory from `pb_hooks/lib/routes.js`, `pb_hooks/trash.pb.js` and `schema/*.rules.json`. All
of these are open to a write key today when the user's role allows them.

| Surface | What it does | Reversible |
| --- | --- | --- |
| `DELETE` on a task, decision, milestone or document, first time | moves it to the trash | yes, restored by an update |
| `DELETE` on a trashed item, project or workspace (second delete) | purges it (`trash.pb.js` header) | no |
| `DELETE` on a project | moves the project to the trash, which hides everything under it | yes, until purge |
| `DELETE` on a workspace (owner only) | moves the workspace to the trash, which hides its contents | yes, until purge |
| `PATCH` on a task, decision, milestone or document removing a file from `attachments` | deletes the file | no |
| `DELETE` on comments, labels, statuses, cycles, templates, saved views, invitations, subscriptions | removes the row; these collections have no trash | no |
| `POST /api/tracker/workspaces/{id}/transfer-ownership` | hands the workspace to another member | only by the new owner |
| `PATCH` or `DELETE` on `workspace_members` | changes a member's role or status, or removes the member | by another write |
| `POST` or `DELETE` on `workspace_invitations`, `POST /api/tracker/workspaces/{id}/resolve-member-email` | invites an address or withdraws an invitation | by another write |
| `POST /api/tracker/invitations/{id}/accept` and `/decline` | joins or refuses a workspace for the user | accept: by leaving |
| `PATCH` on `workspaces`, `POST /api/tracker/workspaces/{id}/vocab`, writes to statuses, labels, cycles and templates | workspace configuration (admin role) | by another write |

Already outside every key: `/api/tracker/admin/*`, every auth route, non-read methods on
`users`, and all of `api_keys` (`pb_hooks/api_keys.pb.js`). `POST /api/tracker/trash/purge` and
`POST /api/tracker/cycles/rollover` pass the key allowlist but are superuser-only routes
(`auth: "superuser"` in `pb_hooks/lib/routes.js`).

## Prior art

Each source was fetched on 2026-11-10. The fetch tool returned a page summary, so each quote is
as that tool reported it.

- **Linear, personal API keys** (https://linear.app/docs/api-and-webhooks), the app this one
  converges on. A key can be limited to "certain permissions (_Read, Write, Admin, Create
  issues, Create comments)._" and "You can also limit an API key's access to specific teams in
  your workspace."
- **Linear, OAuth scopes** (https://linear.app/developers/oauth-2-0-authentication). `read` is
  "(Default) Read access for the user's account. This scope will always be present."; `write`
  is "Write access for the user's account"; `admin` is "Full access to admin level endpoints.
  You should never ask for this permission unless it's absolutely needed". Narrower scopes
  include `issues:create` and `comments:create`. Admin is its own scope; deletion is not. The
  page does not show team selection on the consent screen: an app user's "team access can be
  modified through the" app details page after the token is issued.
- **Linear MCP** (https://linear.app/docs/mcp). "Clients that request `read` are granted
  read-only access, and the underlying token can't reach write APIs." The page says nothing
  about limiting MCP to teams.
- **GitHub fine-grained personal access tokens**
  (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
  "The token will only be able to access resources owned by the selected resource owner";
  "Under Repository access, select which repositories you want the token to access"; per
  permission, "Valid access levels are `read`, `write`, and `admin`". Administration is its
  own permission row.
- **GitHub Apps** (https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).
  At install: "If the app requires repository permissions, select All repositories or Only
  select repositories." This is resource selection on the consent screen.
- **GitHub OAuth app scopes**
  (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).
  `delete_repo` "Grants access to delete adminable repositories", separate from `repo`; scopes
  "do not grant any additional permission beyond that which the user already has".
- **GitHub REST troubleshooting**
  (https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api). "GitHub
  uses a `404 Not Found` response instead of a `403 Forbidden` response to avoid confirming the
  existence of private repositories."
- **Notion** (https://developers.notion.com/docs/authorization,
  https://developers.notion.com/reference/capabilities,
  https://developers.notion.com/reference/status-codes). At OAuth consent "Users can select which
  pages to give the connection access to"; capabilities (read, update, insert content) "enforce
  which API endpoints a connection or token can call". A page not shared answers 404
  `object_not_found`; a missing capability answers 403 `restricted_resource`.

Not verified: whether Linear scopes an OAuth grant to teams at consent (the page shows it only
after issue), and the exact labels of GitHub's other repository-access choices.

Taken together: Linear and GitHub separate admin from write, and GitHub also separates
deletion; Notion's capabilities stop at content.
Resource limits are a set chosen when the credential is made (Linear teams, GitHub repositories,
Notion pages), and the OAuth products that offer them choose at consent (GitHub Apps, Notion). A
resource outside the credential reads as absent (404), while a missing permission is a 403.

## What Changes

- A key carries two limits, both fixed when the key is made, like `scope` today, and both
  shown in the key list: which part of the tracker it reaches (every workspace, as today, or a
  narrower part) and what it may do there (read, write, or a level above write that alone
  reaches the destructive and ownership surfaces above).
- Under a key, the caller can do only what both the user's role and the key's limits allow; a
  key never adds to the role.
- A request under a limited key behaves as if the user could reach only the key's part of the
  tracker: a record outside it reads as absent (404 on view, left out of lists and counts), and
  a write naming it gets the answer a write to an unreachable workspace gets today. A request
  the key's level forbids answers 403 `api_key_scope`, as a read key's write does today.
- The limits hold on every surface a key reaches: collection records, custom tracker routes
  (search, export, trash, counts, summary, landing, notifications), file tokens, and realtime,
  including a stream that is already open and the workspace topic.
- `GET /api/tracker/me` under a key describes what the key may do: only the workspaces in its
  reach, and capabilities that are the user's role narrowed by the key's level, so a read key is
  no longer told it may write. It also names the key's limits, so an agent learns them without a
  second call.
- A key limited to part of the tracker cannot create a workspace, or accept or decline an
  invitation; those act outside any one workspace. A key limited to some projects cannot act
  above write, because settings, invitations, members and ownership are workspace-wide.
- A key with no new limits keeps today's reach, except that the meaning of an existing write
  key is an open question below. Narrowing what `write` reaches changes an accepted limit of
  decision:api-keys ("Write keys reach every non-admin tracker route"), so a new decision record
  supersedes that limit.
- The OAuth consent page of the hosted MCP auth decision (rulings 3, 6 and 7) lets the user pick
  the limits before approving, and the minted key carries them. A refresh issues a key with the
  same limits; only a new consent changes them. The hosted MCP endpoint lists only the tools the
  key's level allows, extending ruling 7's read-only rule.
- Key minting through a client command (AC-9, a separate change) lets the operator set the same
  limits.

## How it bears on the hosted MCP endpoint

The hosted MCP auth decision is settled and this change works inside it. Ruling 6 makes an OAuth
grant a key, so a grant has exactly the limits a key has, with no second set of rules to keep in
step. Ruling 7 already has consent choose read or write; this change adds reach and the levels
above write to the same choice. Ruling 3's consent page is minimal, which bounds how much choice
it can show (Open Question 6). Ruling 5's MCP service calls PocketBase with the caller's
credential, so the limits are enforced where the data is, whatever the service does.

AC-5 (revoking a key ends its open realtime stream) is a separate criterion; both need an open
stream to answer to the key that opened it, not only to its user.

## Capabilities

- `api-key-scoping`: the limits a key carries, how they are set at create and at OAuth consent,
  and how every surface a key reaches enforces them and reports them.

## Open Questions

1. **How narrow a key's reach can be.** Options:
   - (Recommended) One workspace, optionally narrowed to some of its projects, or every
     workspace as today. Mirrors GitHub's one resource owner plus selected repositories, and
     covers both halves of AC-3. An agent working in two workspaces needs two keys.
   - Any set of workspaces, with no project narrowing. Mirrors Linear's team list, but leaves
     the project half of AC-3 unmet.
   - Any set of workspaces, each optionally narrowed to projects. The most general, and the most
     to build, show on consent and test on every surface.
2. **What a project-limited key sees of its workspace outside those projects.** Depends on 1.
   Statuses, labels, cycles and member names are workspace-wide, and an agent cannot set a
   task's status without reading them; decisions, documents and saved views may have no project.
   Such a key never changes workspace settings (settled above). Options:
   - (Recommended) It reads the workspace's settings (statuses, labels, cycles, members) and
     nothing else outside its projects; work filed under no project is out of reach.
   - It also reads work filed under no project, but writes only inside its projects.
   - Nothing outside its projects; a client must learn status and label ids some other way.
3. **How AC-4's limit is expressed.** Options:
   - (Recommended) Key levels follow the existing role tiers of decision:role-tiers: `read`,
     `write` (items and projects, including the trash), `manage` (settings, vocabulary,
     invitations, purge) and `own` (roles, transfer, workspace deletion). A key acts at the lower
     of its level and the user's role, and `me` already reports these tiers. A `write` key then
     cannot purge, invite, change settings or roles, hand over ownership or delete a workspace.
   - One level above `write` (named, say, `full`) that reaches everything a write key reaches
     today. Simpler, as Linear's `admin`, but splits the role tiers: a key needing to edit
     statuses also gets transfer and workspace deletion.
   - Per-surface permissions, as GitHub fine-grained tokens have. The most precise and the most
     to build, show and test.
4. **Whether a write key keeps deletes that have no trash.** Depends on 3. Under the tiers, a
   `write` key can still delete a comment and remove a file attached to an item, both
   permanent, and can move a whole project to the trash. Options:
   - (Recommended) Keep them at `write`: deleting a comment and replacing an attachment are
     ordinary edits, and a trashed project can be restored.
   - Move permanent deletes (comments, attachment removal) to `manage`: no `write` key destroys
     anything for good, but an agent cannot delete its own comment or replace a file.
5. **What happens to write keys that exist when this ships.** Depends on 3. The deployed server
   is a test service, and the database rule is that a migration never rewrites rows, so the
   choice is what a stored `write` means from then on. Options:
   - (Recommended) A stored `write` means the new `write` tier and loses manage and own powers; a
     key that needs them is reissued at a higher level. Fails safe.
   - A stored `write` is treated as the highest level and keeps today's reach, while new keys
     choose a tier. Nothing breaks, and every existing key stays as powerful as today.
6. **What the OAuth consent page offers.** Depends on 1 and 3. Options:
   - (Recommended) A workspace picker (one workspace, or every workspace) and read or write,
     defaulting to what the client requested. A level above write is offered only when the
     client asks for it by name, and the user may lower it. Project narrowing is left to keys
     made in the account. Keeps the page minimal, as ruling 3 requires, while GitHub Apps and
     Notion show that resources belong on consent.
   - Everything a key can carry: workspace, projects and every level. Same power as a key made
     in the account, at the cost of a larger page.
   - The client names the limits in the OAuth `scope` parameter and the user only approves or
     denies. Smallest page, but the user cannot narrow what the client asks for.

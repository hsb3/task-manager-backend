## Purpose

The limits an API key carries beyond read or write: which part of the tracker it reaches (every
workspace, one workspace, or some projects of one workspace) and its level (read, write, manage,
own), how they are chosen when a key is made by hand or through OAuth consent, and how every
surface a key reaches enforces and reports them.

## ADDED Requirements

### Requirement: A key carries a reach and a level, fixed when it is made

An API key SHALL carry a reach, one of every workspace, one workspace, or some projects of one
workspace, and a level, one of `read`, `write`, `manage` or `own`. Both SHALL be chosen when the
key is made and SHALL NOT change afterwards. A key made without a reach SHALL reach every
workspace. A key limited to projects SHALL have level `read` or `write`. The workspace SHALL be
one the key's user owns or is an active member of, and each project SHALL be a live project of
that workspace.

#### Scenario: A key limited to one workspace

- **WHEN** a user creates a key with reach `workspace` naming a workspace they belong to
- **THEN** the key is created and its record shows that reach and workspace

#### Scenario: A project key above write

- **WHEN** a user creates a key with reach `projects` and level `manage`
- **THEN** the create is refused with 400 and no key is stored

#### Scenario: A workspace the user does not belong to

- **WHEN** a user creates a key limited to a workspace they are not an active member of
- **THEN** the create is refused with 400 and no key is stored

#### Scenario: Changing a key's reach

- **WHEN** the key's owner sends an update that sets the key's reach, workspace or projects
- **THEN** the update is refused and the key is unchanged

### Requirement: A key acts at the lower of its level and its user's role

A request under a key SHALL be allowed only when both the user's role in the workspace and the
key's level allow it. A request the key's level does not allow SHALL answer 403 with code
`api_key_scope`.

#### Scenario: A level above the role

- **WHEN** an `own` key of a plain member edits workspace settings
- **THEN** the request is refused exactly as the member's own session would be refused

### Requirement: What each level allows

`write` SHALL allow creating, editing and trashing items and projects, deleting comments,
removing attachments, and the user's own subscriptions, saved views and notifications. `manage`
SHALL add workspace settings, vocabulary, statuses, labels, cycles, templates, invitations,
suspending or removing members, and purging from the trash. `own` SHALL add changing a role,
handing over ownership, deleting a workspace, leaving one, and accepting or declining an
invitation.

#### Scenario: A write key purges

- **WHEN** a `write` key deletes a task already in the trash, in a workspace its user owns
- **THEN** the answer is 403 `api_key_scope` and the task stays in the trash

#### Scenario: A write key trashes

- **WHEN** a `write` key deletes a live task its user may delete
- **THEN** the task moves to the trash (204)

#### Scenario: A write key hands over ownership

- **WHEN** a `write` key calls transfer-ownership on a workspace its user owns
- **THEN** the answer is 403 `api_key_scope` and the owner is unchanged

#### Scenario: A manage key changes a role

- **WHEN** a `manage` key of a workspace owner changes a member's role
- **THEN** the answer is 403 `api_key_scope` and the role is unchanged

### Requirement: Outside its reach a key sees nothing

A record out of a key's reach SHALL answer 404 on view, update and delete, SHALL be left out of
every list, count, search, export, expansion and summary, and a create naming it SHALL be
refused as a create in an unreachable workspace is refused. A key limited to one workspace SHALL
reach only that workspace's records.

#### Scenario: Listing tasks under a workspace key

- **WHEN** a key limited to workspace A lists tasks, and its user also belongs to workspace B
- **THEN** only workspace A's tasks are listed and `totalItems` counts only them

#### Scenario: Viewing out of reach

- **WHEN** a key limited to workspace A views a task of workspace B by id
- **THEN** the answer is 404

#### Scenario: Creating out of reach

- **WHEN** a key limited to workspace A creates a task in workspace B
- **THEN** the create is refused with 400 and nothing is stored

#### Scenario: Search and export under a workspace key

- **WHEN** a key limited to workspace A searches, or exports workspace B
- **THEN** search returns only workspace A's matches, and the export answers 404

### Requirement: What a project key reaches

Under a key limited to projects, the workspace record and its statuses, labels, cycles and
members SHALL stay readable, and every other record SHALL be in reach only when it belongs to one
of the key's projects; work filed under no project SHALL be out of reach.

#### Scenario: Moving work out of a project key's reach

- **WHEN** a key limited to project P moves a task of P into project Q
- **THEN** the answer is 404 and the task stays in P

#### Scenario: Work filed under no project

- **WHEN** a key limited to project P lists tasks and the workspace has tasks under no project
- **THEN** those tasks are not listed

#### Scenario: Settings stay readable to a project key

- **WHEN** a key limited to project P lists its workspace's statuses
- **THEN** every status of the workspace is listed

### Requirement: A limited key cannot act outside any one workspace

A key limited to a workspace or to projects SHALL be refused with 403 `api_key_reach` on every
request that acts for the whole account: creating a workspace, the landing and switch routes,
listing, accepting or declining invitations, changing user settings, and requesting a file
token.

#### Scenario: Creating a workspace

- **WHEN** a key limited to workspace A creates a workspace
- **THEN** the answer is 403 `api_key_reach` and no workspace is created

### Requirement: Files under a key follow its reach

A key SHALL download a protected attachment by presenting itself on the file URL, without a file
token, and SHALL receive it only when the record holding it is in the key's reach; otherwise the
answer SHALL be 404.

#### Scenario: Downloading an attachment in reach

- **WHEN** a key limited to project P downloads an attachment of a task in P with the key in its Authorization header
- **THEN** the file is served

#### Scenario: Downloading an attachment out of reach

- **WHEN** the same key downloads an attachment of a task in project Q by its URL
- **THEN** the answer is 404

### Requirement: Realtime under a key follows its reach

A realtime stream subscribed under a key SHALL deliver only events about records in the key's
reach, on collection topics and on the workspace item topic, for as long as the stream is open.

#### Scenario: A collection subscription under a workspace key

- **WHEN** a key limited to workspace A subscribes to `tasks/*` and a task is created in workspace B
- **THEN** the stream receives no event for it

#### Scenario: The workspace item topic under a project key

- **WHEN** a key limited to project P is subscribed to its workspace's item topic and a task changes in project Q
- **THEN** the stream receives no event for it

### Requirement: The me route describes the key

`GET /api/tracker/me` under a key SHALL list only the workspaces in the key's reach, SHALL
report each workspace's capabilities as the user's role narrowed by the key's level and reach,
and SHALL name the key's level, reach, workspace and projects.

#### Scenario: A read key asks what it may do

- **WHEN** a `read` key of a workspace owner calls `GET /api/tracker/me`
- **THEN** every workspace reports `write`, `manage` and `own` as false

#### Scenario: A workspace key asks where it belongs

- **WHEN** a key limited to workspace A, whose user also belongs to workspace B, calls `GET /api/tracker/me`
- **THEN** only workspace A is listed and `key.reach` is `workspace` with `key.workspace` equal to A

### Requirement: OAuth consent sets the same limits

The OAuth consent page SHALL let the person choose every workspace or one workspace they belong
to, and read or read-and-write, preselecting the level the client asked for. It SHALL offer
`manage` or `own` only when the client asked for that scope by name, and the person MAY lower it.
The key the grant mints SHALL carry the chosen reach and level, and a refresh SHALL keep them.

#### Scenario: Consent limited to one workspace

- **WHEN** the person chooses workspace A and read-and-write on the consent page and approves
- **THEN** the minted key reaches only workspace A at level `write`

#### Scenario: A client asks for manage

- **WHEN** a client's authorization request names scope `manage`
- **THEN** the consent page offers Manage, preselected, beside Read and Read and write

#### Scenario: A client that did not ask for more

- **WHEN** a client's authorization request names `read write`
- **THEN** the consent page offers no level above Read and write

### Requirement: Existing keys keep their reach and become the write tier

A key made before this change SHALL reach every workspace, and a stored `write` level SHALL mean
the `write` tier, so such a key loses the `manage` and `own` powers it had.

#### Scenario: An old write key purges

- **WHEN** a key made as `write` before this change deletes a trashed task
- **THEN** the answer is 403 `api_key_scope`

<!--
GENERATED FILE — DO NOT EDIT BY HAND.

Source of truth: the `app_docs` `decision:*` seed migrations under
pb_migrations/. Regenerate with:

    bun scripts/gen_decisions.ts

See docs/self-documenting-app.md for how the app_docs convention works.
-->

# Decisions

## account-delete-sole-owner

- **Slug:** `decision:account-delete-sole-owner`
- **Title:** A user cannot delete their own account while they are the sole owner of a workspace that has other members.
- **Ref:** `users`

The `users` delete rule lets a user delete only their own record, and deleting a user cascades away every workspace they own. Without a guard, one self-delete would destroy a workspace, its projects and its items out from under every other member.

An `onRecordDeleteRequest` hook on `users` in `pb_hooks/main.pb.js` closes that gap. On a self-delete by a regular user it looks up every workspace the caller owns; if any of them has another member, it refuses the delete with 400 and names the way out: transfer ownership or remove the other members first. When every blocking workspace sits in the trash, the message says to restore it first, because both of those remedies are refused while a workspace is trashed (decision:workspace-configuration-freeze). A user whose owned workspaces have no other members deletes cleanly and the cascade removes those workspaces.

The guard lives in a hook, not the delete rule, because it needs a lookup across `workspaces` and `workspace_members` that a rule cannot express. Superusers are exempt so an operator can always remove a junk or test account. The daily unconfirmed-signup purge (decision:verified-login) applies the same test and skips such an account.

See collection:users and decision:last-workspace-reprovision.

## active-membership-grants-access

- **Slug:** `decision:active-membership-grants-access`
- **Title:** An active workspace membership grants access to the workspace and everything in it, and assigning a task grants nothing more.
- **Ref:** `workspace_members`

Every workspace-scoped collection rule grants access through the workspace owner or through the `workspace_members` back-relation, and each membership branch requires the same row to carry `status` `active`. `workspace_members.status` holds only `active` or `suspended`, and `pb_hooks/membership_status.pb.js` lets it move only between those two. A suspended member therefore loses access to the workspace, its projects, documents, decisions, milestones and configuration, and to every task, one still assigned to them included: they answer as if the caller were not a member.

Assigning a task grants nothing on its own. No rule or route admits a task assignee except through the owner or active-membership branches: not the `tasks`, `comments`, `task_activity`, `task_subscribers` or `notifications` rules, not the `project_items` view, and not `GET /api/tracker/search` in `pb_hooks/routes.pb.js`. A suspended assignee loses the task with everything else, and an active viewer assignee reads it but writes nothing through it (decision:role-tiers).

- **Reads follow membership.** An active member lists and views the workspace row itself and every project, task, decision, document and milestone in it, subject to draft privacy (decision:draft-private-publish-one-way) and trash visibility. Which roles may write is set by decision:role-tiers.
- **The collection rules are the enforcement point.** A caller hitting PocketBase directly gets the same refusal as any other client; a hidden record answers 404 on view and is absent from lists.
- **An absent expand is the hidden state.** PocketBase omits an expanded relation the caller cannot view, so a client reading `expand` must treat a missing key as a hidden record, never as an empty one.
- **Task assignees.** A member who leaves has their tasks unassigned (decision:leaver-tasks-unassigned); a suspended member stays the stored assignee but reads and writes nothing through it until reactivated. A subtask needs the same membership as any other task create.
- **Assignment is limited to members.** A validation hook in `pb_hooks/main.pb.js` refuses, with a 400, an assignee who is neither the workspace owner nor an active member of the task workspace, which a rule cannot express because an update rule denial answers 404. It checks only a changed assignee, so a task whose assignee is later suspended stays editable on other fields.
- **Accepting an invitation never reactivates a suspended member**: an existing membership row is left as it is.

## api-key-manages-keys

- **Slug:** `decision:api-key-manages-keys`
- **Title:** A key minted by tm login may carry a manage-keys permission that lists and revokes its user's keys and never mints.
- **Ref:** `api_keys`

This supersedes decision:api-key-reads-refused in part: a key with reach all whose manage_keys is true reads its user's key records, through GET /api/tracker/keys only, and revokes them through POST /api/tracker/keys/{id}/revoke. Prior art: GitHub and Linear manage tokens only in the signed-in web app; this server has no web app, and tm holds only a key after browser sign-in. A key limited to part of the tracker, whatever its manage_keys, lists and revokes only itself; another id answers 404 (root ruling 5).

- **Granted at consent.** Only the tm client may ask for it, as the scope value keys; the person can untick it. A create request from anyone but a superuser cannot set it.
- **Never mints.** Every api_keys collection route still answers 403 api_key_path to every key, and a query string or realtime subscription naming api_keys is still refused.

Accepted limits:

- **A leaked manage-keys key can revoke every key of its user**, the owner's agents included; it gains no other power.

`pb_hooks/api_key_manage.pb.js` implements it and `tests/test_key_management.ts` proves it. See route:tracker-keys and collection:api_keys.

## api-key-reach-and-levels

- **Slug:** `decision:api-key-reach-and-levels`
- **Title:** A key carries a reach, every workspace, one workspace or some of its projects, and a level that follows the role tiers, and acts at the lower of its level and its user's role.
- **Ref:** `api_keys`

Owner rulings of 2026-11-10:

- **How narrow a key's reach can be.** Ruled: every workspace, or one workspace optionally narrowed to some of its projects (not sets of workspaces).
- **What a project-limited key sees outside its projects.** Ruled: the workspace's settings (statuses, labels, cycles, members) only; work filed under no project is out of reach.
- **How AC-4's limit is expressed.** Ruled: key levels follow decision:role-tiers (`read`, `write`, `manage`, `own`), at the lower of level and role (not one level above write, not per-surface permissions).
- **Whether a write key keeps deletes that have no trash.** Ruled: kept at `write` (deleting a comment, removing an attachment, moving a project to the trash).
- **What happens to existing write keys.** Ruled: a stored `write` means the new `write` tier; a key needing more is reissued.
- **What the OAuth consent page offers.** Ruled: workspace picker plus read or write; a higher level only when the client requests it by name; no project narrowing on consent.

**How it is enforced.** The key middleware removes the reach headers from every request and sets them for a key limited to a workspace or projects. Every workspace-bound collection rule carries a clause on those headers, so lists, views, writes and expansions keep to the reach. Custom routes, realtime delivery and file downloads apply the same reach by hand, and a new workspace-bound collection or route must do the same.

**users stay listable.** Any signed-in user lists users today, and a limited key does too.

**A level above the role does nothing.** A key acts at the lower of the two.

Prior art: Linear lets a personal API key be limited to certain teams and permissions (https://linear.app/docs/api-and-webhooks); a GitHub fine-grained token reaches one resource owner and selected repositories, with administration as its own permission (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens); Notion lets a person choose pages at consent and answers 404 for a page not shared (https://developers.notion.com/docs/authorization).

## api-key-reads-refused

- **Slug:** `decision:api-key-reads-refused`
- **Title:** A key request that names the api_keys collection in its query string or realtime subscription is refused, so a key never reads key records.
- **Ref:** `api_keys`

This supersedes the first accepted limit of decision:api-keys, under which a key could read the name, scope, revoked and expires of its owner keys through `expand=api_keys_via_user` on users and through realtime. Prior art: a GitHub personal access token cannot list or inspect the tokens of its owner; token management stays in the signed-in account.

- **Why not a rule.** A key request runs as its owner, so no api_keys rule can tell the two apart. PocketBase reads only id, collectionId, collectionName, email, emailVisibility and verified of the caller from memory and every other auth field from the database; a realtime client gets a freshly loaded auth record whenever its owner is updated; relation, back-relation and @collection filters apply no rule of the collection they join; and realtime subscription headers come from the client.
- **The refusal.** A key request whose query string names api_keys, by name in any letter case or by collection id, answers 403 with code api_key_path, and so does a realtime subscription from a key whose topic or options name it. The text is checked raw, percent-decoded byte by byte as PocketBase decodes a query, and with JSON unicode escapes resolved. Every path into a key record from another collection is the back-relation api_keys_via_user or the api_keys topic, and each one names the collection; PocketBase already refuses an @collection filter from anyone but a superuser.
- **Owner sessions are unchanged.** A password or OAuth session still lists, expands, subscribes to and manages its own keys.

Accepted limits:

- **A value that merely spells api_keys is refused too**, for example a filter on a workspace name equal to api_keys. A key client has no reason to send that text.

`pb_hooks/api_keys.pb.js` and `pb_hooks/lib/api_keys.js` implement it and `tests/test_api_keys.ts` proves it. See collection:api_keys and concept:api-keys.

## api-keys

- **Slug:** `decision:api-keys`
- **Title:** An agent or script authenticates with a personal API key that acts as its owner, can be read-only, and can never reach an auth or admin route.
- **Ref:** `api_keys`

Agents need a long-lived credential that is not a password and not a session token. Prior art: GitHub fine-grained personal access tokens and Linear personal API keys both act as their owner, are shown once at creation, are stored hashed, can be revoked or expire, and carry a scope. This app takes the same shape, with two scopes, read and write, and the owner as the only principal.

- **Shown once, stored hashed.** The create response returns the key once; only its SHA-256 digest is stored, in the hidden key_hash field, so a database or backup leak yields no usable key. A lost key is replaced, never recovered.
- **Acts as the owner.** A key request runs with the owner as the caller, so every collection rule is the rule PocketBase already enforces for that user and no rule is restated for keys. An owner who stops passing the authRule of users loses every key at once.
- **Delete or revoke.** Revoking is one-way: revoked can be set to true and never back. Deleting a key also ends it. Either takes effect on the next request.
- **Never an auth or admin credential.** A key cannot refresh or mint a session token, impersonate, change the account, run a batch, or reach the collections, settings, logs, backups or crons routes, and it can never manage keys, so a leaked key cannot outlive its revocation by minting a successor. The routes a key may use are an allowlist read from the matched route, so an encoded, doubled or recased path and a collection id in place of its name all resolve to the same answer.
- **Read keys cannot write.** A read key may only read, subscribe to realtime, request a file token and export a workspace; every other method answers 403 api_key_scope.
- **Open realtime streams survive revocation.** A realtime stream keeps the auth it subscribed with, as for any session token, so revoking a key stops new requests but does not close a stream already open with it. A client re-subscribing with the revoked key is refused.

Accepted limits:

- **Superseded: a key reading the metadata of the keys of its owner.** decision:api-key-reads-refused closes it: a key request that names api_keys is refused.
- **An invalid tmk_ key answers 401 before the rate limiter counts it.** A key carries about 238 bits of randomness and each attempt is one unique-index read, so guessing is not a practical attack.
- **Write keys reach every non-admin tracker route**, including routes added later, and a new tracker route that only reads must be added to the read list by hand.
- **A key survives a password change of its owner.** A key ends only by revoke, expiry or delete.

`pb_hooks/api_keys.pb.js` implements it and `tests/test_api_keys.ts` proves it. See collection:api_keys and concept:api-keys.

**Superseded in part:** write keys no longer reach every non-admin tracker route; a key's level and reach decide (decision:api-key-reach-and-levels).

**Superseded in part:** open realtime streams no longer survive revocation; revoking, deleting or expiring a key ends them (decision:key-revocation-ends-open-streams).

## app-settings

- **Slug:** `decision:app-settings`
- **Title:** App-wide configuration lives in an app_settings key/value collection that any signed-in user can read and only a superuser can write.
- **Ref:** `app_settings`

Some configuration belongs to the whole app rather than to one user or one workspace. It lives in `app_settings`: one record per setting, with a unique text `key` and a json `value`.

Any authenticated user can list and view the settings, so a client can show copy that depends on them. The create, update and delete rules are null, so only a superuser can write a setting, from the PocketBase dashboard; a write by any other caller is refused.

Three keys are read today, each a number with a default that applies when its row is absent:

- `trash_retention_days` (default 30): the trash sweep in `pb_hooks/trash.pb.js` and `GET /api/tracker/trash` in `pb_hooks/routes.pb.js` both read it to decide when a trashed item is purged (decision:soft-delete-trash).
- `invitation_expiry_days` (default 7): `pb_hooks/invitations.pb.js` reads it to date invitation expiry and the decline cooldown, and the daily sweep in `pb_hooks/invitation_expiry.pb.js` expires pending invitations past it.
- `invitation_mint_limit_per_day` (default 50): `pb_hooks/invitations.pb.js` reads it as the number of invitations one inviter may send in any 24-hour window (decision:invitation-send-limit-and-decline-block).

See collection:app_settings.

## auto-provision-workspace

- **Slug:** `decision:auto-provision-workspace`
- **Title:** Every new account gets a default workspace with a default project, and a workspace a user creates by hand starts with no project.
- **Ref:** `workspaces`

A new account must never land on an empty app with nothing to open. An `onRecordAfterCreateSuccess` hook on `users` in `pb_hooks/main.pb.js` gives every new user, in order:

- a workspace named My Workspace that they own;
- an active `workspace_members` row for themselves;
- a project named My Project in that workspace, set as the workspace `default_project` (decision:workspace-default-project);
- their `user_settings` row (decision:user-settings).

The workspace vocabulary is not set here. The `workspaces` after-create seeder, which fires on this programmatic create as on every other, gives the workspace its default statuses, core labels and priorities (decision:vocab-first-class-collections, decision:default-priority-vocabulary), and the shadow-project hook gives it its hidden project (decision:shadow-project).

The after-create event fires once for every committed account create: password signup, first GitHub sign-in and a superuser create. Linking GitHub to an existing account creates no user, so it provisions nothing. The hook is idempotent (it does nothing when the user already owns a workspace) and defensive (a provisioning failure is logged and never fails the signup). It runs as the system and ignores the `approved` and `verified` flags, which is safe because the workspace stays unreachable until the account can sign in (decision:signup-approval).

Only this first workspace, and the one re-provisioned when an owner deletes their last workspace (decision:last-workspace-reprovision), gets a default project. A workspace the user creates through the `workspaces` collection starts with its vocabulary and no visible project: someone who chose to make a second workspace does not need a project they did not ask for.

**Superseded in part:** provider sign-in now means GitHub or Google (decision:oauth-providers-from-env); a first sign-in through either provisions, and linking either to an existing account creates no user.

## backend-owns-business-rules

- **Slug:** `decision:backend-owns-business-rules`
- **Title:** The server computes every business rule and derived value, so no caller keeps its own copy of a rule.

PocketBase holds every business rule and returns derived values ready to use. Each value and where it is computed:

- **Trash purge date:** `GET /api/tracker/trash` returns `purge_at` from `app_settings.trash_retention_days`, the same setting the purge cron in `pb_hooks/trash.pb.js` enforces.
- **Status semantics:** `pb_hooks/counts.pb.js` derives the `terminal` and `off_pipeline` flags of a status from its `category`.
- **Item counts:** `GET /api/tracker/project-items/counts` groups and counts items in one query, under the live `project_items` list rule.
- **Project progress:** the `project_stats` view buckets task totals by status category.
- **Per-user summary:** `GET /api/tracker/summary` counts the work of the caller.
- **Search, trash listing and export:** `GET /api/tracker/search`, `GET /api/tracker/trash` and `POST /api/tracker/export` filter, sort and cap on the server.

A user action that writes more than one record runs in one transaction inside its route, as `POST /api/tracker/workspaces/{id}/transfer-ownership` and `POST /api/tracker/workspaces/{id}/vocab` do.

## backups-recovery

- **Slug:** `decision:backups-recovery`
- **Title:** Scheduled S3 backups are configured from environment variables at boot, into a bucket that holds only backups.

`pb_hooks/backups.pb.js` writes the whole `settings.backups` block on boot from environment variables: the S3 destination from `PB_BACKUPS_S3_BUCKET`, `PB_BACKUPS_S3_SECRET`, `PB_BACKUPS_S3_ENDPOINT`, `PB_BACKUPS_S3_REGION` and `PB_BACKUPS_S3_ACCESS_KEY`, plus the schedule. The cron defaults to daily at 03:00 UTC and retention to the 30 most recent scheduled backups; `PB_BACKUPS_CRON` and `PB_BACKUPS_CRON_MAX_KEEP` override them. When the bucket or the secret is unset, the hook does nothing and local filesystem backups stay as PocketBase ships them.

A boot hook rather than a settings migration keeps the S3 secret out of git and re-applies a rotated key on the next deploy, which a one-shot migration cannot do.

With S3 enabled, every backup operation (list, create, restore) goes to the bucket and the local backups directory is ignored. Scheduled backups carry the `@auto_` name prefix. A restore is point-in-time and restarts the process in place, so it is a deliberate operator action run against a throwaway instance first and health-checked after the restart.

The backup bucket holds only backups. Retention deletes objects in it and a restore treats its archive set as the whole story, so permanent user files never share it; uploaded files use their own bucket (decision:file-storage-s3-from-env).

## batch-signup-refused

- **Slug:** `decision:batch-signup-refused`
- **Title:** A signup cannot ride /api/batch: creating a users record inside a batch is refused for everyone but a superuser, so signup has one rate-limit bucket.
- **Ref:** `users`

Supersedes the batch and signup-limit statements in decision:rate-limits-batch-and-superuser-mfa. Measured on PocketBase 0.40.4.

- **The gap.** The record-create rate limiter is keyed by route pattern, and a sub-request of `POST /api/batch` has a different pattern from `POST /api/collections/users/records`. A batch signup therefore had its own bucket: one client address could make 5 direct signups and 5 more in batches within a minute. No settings rule merges the two: a `users:create` tag rule was tried and the buckets stayed separate.
- **The rule.** A batch request that creates a `users` record, by create or by upsert, answers 400 unless the caller is a superuser. Superusers bypass the limiter anyway, so seeding and import through a batch keep working. Every other collection is unaffected, and batch stays enabled with its size and timeout limits.
- **The result.** Signup has one bucket: 5 a minute per client address on `POST /api/collections/users/records`, direct only.

`tests/test_signup_verification.ts` proves it.

## comment-threads-single-level

- **Slug:** `decision:comment-threads-single-level`
- **Title:** Comment threads are single-level: a reply must point at a top-level comment on the same target.
- **Ref:** `comments`

A comment either starts a thread (empty `parent`) or replies to one. The `comments` create rule enforces both halves with no hook: a reply is accepted only when its parent has no parent of its own and is attached to the same task, document or decision as the reply. A reply to a reply, or a reply whose parent sits on a different target, is refused with 400.

One level of threading, as in Linear, keeps reading order and notification fan-out simple.

See collection:comments.

## core-labels-undeletable

- **Slug:** `decision:core-labels-undeletable`
- **Title:** Core labels cannot be deleted, and deleting a custom label removes it from every task.
- **Ref:** `labels`

The seeded core labels (Bug, Feature, Improvement) carry the `core` flag and belong to the baseline vocabulary of every workspace. A delete-request hook on `labels` in `pb_hooks/main.pb.js` refuses deleting a core label with 400 for every caller, superusers included, because a rule cannot read the flag ahead of a delete.

Custom labels delete normally. `tasks.labels` does not cascade on delete, so PocketBase removes a deleted label id from every task that references it, and the tasks themselves survive.

## cycle-rollover

- **Slug:** `decision:cycle-rollover`
- **Title:** Unresolved tasks in an ended cycle roll into the next cycle automatically.
- **Ref:** `cycles`

A cycle is a workspace-scoped time box with a default two-week span; `tasks.cycle` points at it, and only tasks carry a cycle. `pb_hooks/cycles.pb.js` runs a rollover sweep on a daily cron (`CYCLE_ROLLOVER_CRON`, default 06:00 UTC), and a superuser can trigger the same sweep with `POST /api/tracker/cycles/rollover`. This follows Linear, where unfinished issues roll into the next cycle at cycle end.

- **What rolls.** Every task in an ended cycle moves unless its status category is `completed` or `canceled`; tasks in triage or with no status roll too. The negative form means a status category added later rolls by default instead of being stranded.
- **Cycles never overlap.** A cycle is a day object: both dates are normalised to midnight, the span is inclusive, and a cycle overlapping another in the same workspace is refused, so the next cycle always has one answer.
- **The next cycle is created when missing**, with the length of the ended one, on the first contiguous span that has not itself ended, so a long-dormant workspace lands its work in a running cycle. Its name is the start date, a placeholder a person may rename.
- **Cycles are configuration, not trash.** Deleting a cycle is a hard delete that clears `tasks.cycle` on its tasks and never deletes them.
- **The sweep is idempotent, not transactional.** One run catches up every ended cycle in date order, and a run that fails part-way leaves a consistent result the next run completes, so one bad row never blocks every workspace.

A rolled task reads as belonging to the cycle it moved to; the cycle it started in is not retained, and there is no per-task opt-out.

## default-priority-vocabulary

- **Slug:** `decision:default-priority-vocabulary`
- **Title:** Every new workspace starts with the priority vocabulary urgent, high, medium and low.
- **Ref:** `workspaces`

`workspaces.priorities` is a per-workspace JSON array of `{id, name}` entries. The universal `onRecordAfterCreateSuccess` seeder for `workspaces` in `pb_hooks/main.pb.js` fills it with four entries named `urgent`, `high`, `medium` and `low` whenever a workspace is created with an empty or missing vocabulary. The same seeder adds the five default statuses and the three core labels, and because it runs at the persistence tier it covers every creation path: signup provisioning, the reprovisioning that follows when an owner deletes their last workspace (`pb_hooks/main.pb.js`) or moves it to the trash (`pb_hooks/trash.pb.js`), and a direct API create.

- **No priority is the unset state, not an entry.** A task with an empty `priority` is always valid, and the vocabulary refuses the reserved word `none` in any letter case.
- **A task stores the entry id.** `validateTaskPriorityWs` refuses a submitted, changed priority that is not an id in its workspace vocabulary (`priority_not_in_vocabulary`), while a task holding a stale value stays writable on other fields.
- **The vocabulary is workspace data.** Owners and admins may rename, reorder or replace the entries; `validateWorkspacePriorities` refuses a duplicate entry or id, and refuses clearing the vocabulary on update.

The defaults follow the Linear priority scale, so a fresh workspace accepts a prioritised task with no setup.

## draft-private-publish-one-way

- **Slug:** `decision:draft-private-publish-one-way`
- **Title:** A draft decision, document or milestone is readable only by its author, the workspace owner and active admins, and Publish is one-way.

`draft` is a bool field on `decisions`, `documents` and `milestones`. Tasks carry no draft field and have no draft state; the `project_items` view reports every task as published. A draft stays a flag on the item, never a separate object.

### Who can read a draft

The author, the workspace owner, and an admin whose membership is active. The list, view, update and delete rules of all three collections carry that branch, and the `project_items` view rules carry it through `author`, `workspace_owner` and `active_admins`. Every server path that reads items applies the same set: the realtime broadcast filter in `pb_hooks/realtime.pb.js`, the trash listing `GET /api/tracker/trash`, search `GET /api/tracker/search` and export `POST /api/tracker/export`. The comment rules apply it to a comment on a draft document or decision. A draft is therefore private from the workspace at large; the two roles that can already read everything in the workspace read it too.

Who may publish is the same set, because the update rule carries the same branch.

### What Publish does

Publish sets `draft` to false. The item becomes readable by every active member on every read path. `pb_hooks/notify.pb.js` resolves the mentions in the item prose on each save that lands published and notifies each person named who has not been notified already. A draft notifies nobody, because the people it names cannot read it. Publishing notifies the people mentioned, not the whole workspace.

### Publish is one-way

`pb_hooks/author.pb.js` refuses an update that moves a published item back to draft with a 400, `A published item cannot be returned to draft. Move it to trash instead.`, for every caller except a superuser, whose writes are seeding and import. Publishing already sent notifications that nothing can retract, so a return to draft would leave a notified member holding a notification for an item they cannot open. Withdrawal is trash, which is visible and reversible (decision:soft-delete-trash). For the superuser case, the inbox count, list and mark-all-read exclude a notification whose item is a draft the reader cannot open.

### Known limit

A draft is hidden but its existence can be counted. Item keys come from one per-project sequence, `projects.item_seq`, shared by every item kind (decision:item-display-keys), so a member who sees fewer keys than the counter can tell that items exist which they cannot open. This reveals a count, never a field value.

## dual-scope-items

- **Slug:** `decision:dual-scope-items`
- **Title:** Tasks, decisions, documents and milestones each belong to one workspace and to a project inside it.

Every item carries a required `workspace` relation and a `project` relation, required on `milestones` and optional on `tasks`, `decisions` and `documents`. An item created without a project lands in the hidden project of its workspace (decision:shadow-project), so workspace-level items and project-scoped items share one shape.

`pb_hooks/scope.pb.js` keeps the two relations coherent:

- a task sent with only a project takes its `workspace` from that project;
- a project whose workspace differs from the item workspace is refused with 400, on create and on any update that touches either field, at the record tier so programmatic saves are checked too;
- `workspace` is immutable on update, while moving an item to another project in the same workspace is a plain update.

Both relations cascade on delete, so purging a project deletes its items rather than moving them to the workspace level. Trashing a project stamps nothing on its items: every item list and view rule requires the project to exist and not be trashed, so the items disappear while the project is in the trash and come back when it is restored. An item trashed on its own stays trashed after its project is restored.

## error-rate-alerting-and-relation-indexes

- **Slug:** `decision:error-rate-alerting-and-relation-indexes`
- **Title:** An error-rate cron emails the owner about server errors, and the relation columns that lists filter on are indexed.

`pb_hooks/alerts.pb.js` registers a cron that scans the recent request log for 5xx and error-level entries and, past a threshold, emails `ALERT_EMAIL` through the configured mail transport. With `ALERT_EMAIL` unset it registers nothing. It detects errors, not a dead process, which cannot send mail; the `GET /api/health` healthcheck lets the host restart a dead process.

The relation columns that list queries filter on carry indexes, among them `idx_tasks_project`, `idx_tasks_assignee`, `idx_projects_workspace`, `idx_workspaces_owner`, `idx_decisions_workspace`, `idx_milestones_workspace` and `idx_comments_task`. Each one exists because a query plan on a scaled dataset showed a full scan turn into an index search. An index pays off once a column holds many distinct values: PocketBase runs ANALYZE, so a column holding one value is still scanned.

Request logs keep five days by default and flush asynchronously, so a reader polls the log rather than reading it once.

## every-database-boots-from-the-migration-set

- **Slug:** `decision:every-database-boots-from-the-migration-set`
- **Title:** Every database boots from the current migration set, written for an empty database, so a backfill is historical and a migration never repairs rows.

Why. The development database, every test room, the continuous-integration replay and production all apply the same migration directory, from empty or from whatever they already hold, and nothing else writes schema or seed data. A migration that repairs rows for the production data of one day runs again on every fresh database, where the rows it means to repair never existed, so its only lasting effect is a read and a write pass paid once by every fresh database, with the universal hooks firing on each write, and a text that describes data no reader of the migration set can see.

Options weighed. (a) Backfills as first-class migrations that repair rows, the production-first habit: refused, because the set applies to many databases from empty, so a repair is a no-op everywhere but the one database it was written for while its cost is paid everywhere. (b) A gate that refuses any migration writing rows: refused, because two legitimate shapes write rows. The data seeds carry the app_docs and app_settings corpus, which every database must hold, and the field-type-change recipe (add the new field, copy the rows, detach any view that names the old column, remove the old field and rename) is the one way to change a field type, since a migration cannot change one in place. A gate that cannot tell a repair from those two shapes refuses the corpus and the recipe, or admits the repair. (c) Historical only: a backfill belongs to the history, a migration already applied everywhere it will ever apply; the current set is read as what an empty database becomes; a row repair for production data is an operation run against production, by hand or by script, never a migration. Chosen.

Decision. Every database, development, test rooms, the continuous-integration replay, staging when one exists, and production, boots from the current migration set, and the set is written for an empty database. A migration never repairs rows. The one exception is the field-type-change recipe, whose row copy is part of a schema change and runs correctly on an empty database, where it copies nothing. A migration that must touch rows for any other reason is a sign that the fix belongs elsewhere: in a hook that keeps the invariant on every write, or in a one-off operation against the one database that holds the rows. No gate enforces this, by this decision: the review of a migration that writes rows asks which of the two admitted shapes it is, the replay of every migration into an empty database with the hooks loaded, at commit time and on every pull request, catches a repair the hooks refuse, and the backup replay job catches one that production data refuses.

Prior art. Rails: the migrations guide states that migrations are not the authoritative source for the database schema, that a new database is created faster and with fewer errors by loading the schema file than by replaying the migration history, and that modifying data in a migration is to be approached with caution (Active Record Migrations guide: Schema Dumping and You; Migrations and Seed Data). Prisma: each migration records the state it starts from and the state it ends at, so the history is a chain of named versions and a database applies only the migrations it still lacks, and seeding is a separate command run only when invoked (Prisma Migrate: the migration graph; Seeding).

## field-goes-with-last-reader

- **Slug:** `decision:field-goes-with-last-reader`
- **Title:** A field goes when its last reader goes: the column, its index, its hooks and its tests are deleted in the same change.

Owner ruling 2026-08-07, after the question of whether to keep a column once its use was retired.

- **The rule.** When a field stops being read, delete the column, its index, its hooks and its tests together. "Keep it, it is harmless" is not a reason.
- **Why.** An unread field still occupies the schema, the published API contract and the generated model, still has to be maintained, and still invites the next reader to assume it means something.
- **Vocabulary.** A value in a fixed vocabulary obeys the same rule: it ships with a live producer, or it goes (decision:notification-kinds-ship-with-producer).
- **Before leaving a field in place** "for now", delete it. An unused flag is dropped rather than given a branch it would need (decision:draft-private-publish-one-way).

## file-storage-s3-from-env

- **Slug:** `decision:file-storage-s3-from-env`
- **Title:** Uploaded files go to an S3 bucket configured from the environment, or to local storage when it is not configured.

`pb_hooks/files.pb.js` writes the file-storage block of the settings (`settings.s3`, never `settings.backups.s3`) at boot from `PB_FILES_S3_BUCKET`, `PB_FILES_S3_SECRET`, `PB_FILES_S3_ENDPOINT`, `PB_FILES_S3_REGION` and `PB_FILES_S3_ACCESS_KEY`. Configuring at boot keeps the credential out of git and reapplies a rotated key on the next deploy, which a settings migration cannot do.

The hook does nothing unless both bucket and secret are set, so local runs and tests store files under `pb_data/storage`. The file bucket is separate from the backups bucket (decision:backups-recovery), and the SQLite database stays on the volume either way.

## github-oauth-verified-email-linking

- **Slug:** `decision:github-oauth-verified-email-linking`
- **Title:** A GitHub sign-in with a verified email marks the account verified and links to an existing account with that email.
- **Ref:** `users`

`pb_hooks/oauth.pb.js` hooks the `users` OAuth2 request (`POST /api/collections/users/auth-with-oauth2`) and enforces two behaviours whatever the engine defaults are:

- a first GitHub signup with a provider-verified email is saved as verified, because GitHub already proved the address and the `users` auth rule requires a verified account;
- a GitHub login whose verified email matches an existing account links to that account instead of creating a duplicate. This is safe because GitHub reports the email only when it has verified it, so an unverified claim never matches.

Both steps are idempotent and do nothing when already true. An OAuth signup still starts unapproved (decision:signup-approval).

The provider credentials come from `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, written onto the `users` collection by a boot hook in the same file, because a collection migration keeps only the enabled flag and drops the provider credentials. With them unset, OAuth stays disabled.

**Superseded:** decision:oauth-providers-from-env replaces this record: GitHub and Google are each enabled by their own environment pair, both link by verified email, and the provider list is rewritten on every boot, so OAuth is disabled only when every pair is unset.

## inaccessible-workspace-answers-404

- **Slug:** `decision:inaccessible-workspace-answers-404`
- **Title:** A route asked about a workspace the caller cannot read answers 404, whether the workspace is unknown, in the trash, or belongs to someone else.

GET /api/tracker/trash answered 403 for a workspace the caller was not a member of and for an id that matched nothing, while the other workspace routes answer 404 for both and its own documentation said a trashed workspace gets the same 404 an unknown one gets. Measured on 2026-11-06 (card 7cns): a member asking for an unknown id got 403, a non-member asking for a live workspace got 403, and only a trashed workspace got 404.

Prior art in this tree: POST /api/tracker/export, POST /api/tracker/workspaces/{id}/vocab and POST /api/tracker/workspaces/{id}/resolve-member-email answer 404 when the workspace does not exist, is in the trash, or the caller holds no admitting membership, and GET /api/tracker/workspaces/{id}/deletion-impact answers an admin and a superuser 404 like an unknown id: the same existence-hiding shape a denied view returns under the collection rules. Prior art outside it: the Linear API answers a request for an issue or team the caller cannot reach with an entity-not-found error, the same answer an id that never existed gets, so a stranger learns nothing from the answer.

Ruling: the status changes, and the prose follows it. The trash route answers a user 404 for an unknown id, for a workspace the user is not an active member of, and for a trashed workspace alike. 403 stays reserved for a caller whose kind of credential is refused outright: an API key, an unverified account, or a superuser on a route that answers for a member, which the me, landing, counts and trash routes all are. A workspace route that still answers a user 403 for a resource that user cannot read is a bug under this decision.

## invitation-keyed-by-email

- **Slug:** `decision:invitation-keyed-by-email`
- **Title:** A workspace invitation is a record keyed by the folded email address, so an address with no account can be invited.
- **Ref:** `workspace_invitations`

`workspace_invitations` holds one row per pending invitation: `workspace` (required, cascade delete), `email` (trimmed and lowercased), `email_key`, `role` (admin, member or viewer) and `invited_by` (optional, no cascade). A unique index on (`workspace`, `email_key`) allows one pending invitation per address per workspace. A `workspace_members` row exists only after acceptance, and its status is active or suspended, never pending.

### The key is the fold

The create hook in `pb_hooks/invitations.pb.js` always overwrites `email_key`, so a client cannot aim an invitation at someone else. The fold trims and lowercases the address and, for `gmail.com` and `googlemail.com` only, drops every dot in the local part and everything from the first plus sign. It is the same fold as `users.email_key`, so one address means one account. Outside those two domains dots and plus tags stay significant.

### Why a collection of its own

An invitation exists the same way whether or not the address has an account, so the roster cannot tell an inviter which addresses are registered. A separate collection also keeps two uniqueness rules apart (membership per workspace and user, invitation per workspace and address) and two lifecycles apart, because an invitation expires and a membership does not.

### Rules

- create: the workspace owner, or an active admin, who may mint only the member role;
- list, view and delete (delete is revocation): the workspace owner and active admins only, narrower than the roster, because a pending invitation is an administrative act in progress;
- update: nobody; an invitation is revoked and issued again, never edited.

Every rule requires the workspace to be untrashed, so an invitation into a trashed workspace cannot be listed, accepted or revoked until restore, and permanent deletion removes it by cascade. Sending limits are in decision:invitation-send-limit-and-decline-block.

### The invitee side

The invitee uses system routes, because `users.email_key` is hidden and PocketBase drops hidden fields from filter matching:

- `GET /api/tracker/invitations/mine` lists the invitations matching the caller `email_key`, with the workspace name and whether each has expired.
- `POST /api/tracker/invitations/{id}/accept` answers 404 when the invitation is not the caller or its workspace is trashed, so it is no existence oracle; 403 for an unverified account; 410 once expired. It then, in one transaction, creates an active membership with the invitation role and deletes the invitation. The owner already holds a membership row, so accepting writes nothing for them and answers with role owner and no membership; an existing row in any status is left as it is, so accepting never reactivates a suspended member.
- `POST /api/tracker/invitations/{id}/decline` deletes the invitation and creates nothing, expired or not.

### Expiry

The window is the `app_settings` row `invitation_expiry_days`, default 7. PocketBase rules do no date arithmetic, so a daily cron in `pb_hooks/invitation_expiry.pb.js` deletes rows past the window, and the accept route re-checks it so an expired invitation is never accepted before the sweep runs.

`invited_by` is an audit stamp, not a requirement: an invitation is a grant the workspace makes, so an admin leaving does not revoke it.

## invitation-mail-and-resend

- **Slug:** `decision:invitation-mail-and-resend`
- **Title:** An invitation sends the invitee one email with the sign-in address and the invitation id, inviting the same address again sends it again, and a server without mail says so in the response.
- **Ref:** `workspace_invitations`

Before this an invitation was silent: the row existed, but nothing told the invitee, who learned of it only by signing in with that address. Prior art: GitHub, Slack and Linear all email a link; Linear resends an invite from its member list and limits how often. This app has no web app of its own and its clients are API callers, so the mail names the app URL as the place to sign in and states the invitation id with the accept and decline calls in words.

- **Send.** Both ways of creating an invitation (the collection create and POST /api/tracker/workspaces/{id}/resolve-member-email) send the mail, from the sender address in settings, after the create has answered, so a create never waits on the mail server (the same arrangement as decision:signup-mail-off-request). A failed send logs invitation email failed against the invitation id with the address redacted; the server does not retry by itself.
- **No mail server.** The create succeeds and the response says mail_sent: false; the server logs invitation email skipped: SMTP disabled. Refusing the create would leave a server without mail unable to invite at all, and the invitation itself is the grant; the mail is only how the invitee hears of it.
- **Superuser rows send nothing** and answer mail_sent: false, as a superuser-created account gets no verification mail: seeding and import are not invitations by a person.
- **Resend is re-inviting.** Inviting a pending address again through the route was already an idempotent 200; it now mails the same invitation again, keeping its id and expiry and spending none of the daily limit of decision:invitation-send-limit-and-decline-block, because no invitation was created. An invitation that has already expired cannot be accepted, so re-inviting replaces it with a fresh one (new id, new expiry, one daily slot), as revoke and invite would. No separate resend route: the member list already has the address, and one call covers invite and resend alike, as it does in Linear.
- **Rate limit.** A second resend of the same invitation within a minute answers 429 and sends nothing; the count is per invitation and starts afresh when the server restarts. A first invitation is bounded by the daily limit per inviter, which bulk onboarding already relies on, so it carries no per-minute limit.

Accepted limits:

- **mail_sent reports a hand-off, not a delivery.** The create has answered before the transport is reached; a failure is only in the server log.
- **The mail link is the app URL, not a page.** There is no web page to land on; an invitee signs in (creating and confirming an account first when needed, then waiting for approval) and a client accepts with the id.
- **Replacing an expired invitation is not one step.** When the fresh invitation is refused at the daily limit, the expired one is already gone; it could not have been accepted anyway and the daily sweep would have removed it.

See collection:workspace_invitations. `tests/test_invitation_mail.ts` proves it.

## invitation-send-limit-and-decline-block

- **Slug:** `decision:invitation-send-limit-and-decline-block`
- **Title:** An account can send a limited number of invitations a day, and a decline blocks a repeat invitation from that workspace for the expiry window.
- **Ref:** `invitation_events`

Invitations are created through the `workspace_invitations` collection itself. Two limits guard it, both in the universal create hook in `pb_hooks/invitations.pb.js`, so no create path skips them. A superuser create is exempt from both.

**Daily send limit.** An account can send at most `app_settings.invitation_mint_limit_per_day` invitations (default 50) in any rolling 24 hours, counted across every workspace it owns or administers. The limit is per inviting account, not per workspace, because any account can create more workspaces. Every send counts, including invitations later accepted, declined, revoked or expired, so revoking and re-sending cannot reset it. The next invitation past the limit is refused with 429 and a message saying the daily limit is reached.

**Decline block.** Declining through `POST /api/tracker/invitations/{id}/decline` records a tombstone. Another invitation from the same workspace to the same `email_key` is refused with 409 until `invitation_expiry_days` have passed since the decline. Declining therefore never leaves the recipient worse off than ignoring, which holds the slot for the same window. Only a decline sets a tombstone; revoke, accept and expiry do not. A setting of 0 days disables the block. The 409 tells the inviting workspace that this address declined, which is accepted over silently sending nothing.

**Ledger.** Both checks read `invitation_events`, an append-only ledger with `kind` (`mint` or `decline`), `inviter`, `workspace`, `email_key` and `created`. All five API rules are null, so only a superuser reaches it. Deleting a workspace clears the relation and keeps the row, so it refunds no sends. The daily expiry sweep in `pb_hooks/invitation_expiry.pb.js` prunes events older than the larger of one day and `invitation_expiry_days`.

## item-display-keys

- **Slug:** `decision:item-display-keys`
- **Title:** An item display key is a project prefix plus a number from one per-project sequence, and it never changes once minted.
- **Ref:** `projects`

The record id is the only real key; `key` on tasks, decisions, documents and milestones is a display label such as `ENG-42`, assigned by `pb_hooks/keys.pb.js`. This follows Linear, where an identifier is minted once and follows its issue.

- **Project prefix.** `projects.key` is set at create. A submitted prefix is normalised to up to eight uppercase letters and digits with no leading digit, and a prefix already used in the workspace is refused with a 400 rather than silently altered. With no submitted prefix the hook suggests one from the first letters of the project name, adding a number on collision. After create the prefix is immutable.
- **One sequence per project.** `projects.item_seq` is a server-owned counter shared by all four item types, so a number names exactly one item in its project whatever its type. A caller cannot write or rewind it.
- **The key follows the item.** An item key is minted once after create and is immutable afterwards; moving the item to another project keeps its key even though the prefix then differs from the new project, so no link or spoken name ever breaks or gets reused.
- **Shadow project items stay keyless**, because the shadow project takes no prefix (decision:shadow-project).

**Superseded in part:** Linear does not keep an identifier with its issue: moving an issue to another team gives it a new identifier, and the old one keeps resolving to it (decision:item-key-kept-on-move). This app keeps the key through a move, as stated above; the rest of this record is unchanged.

## item-filter-by-name

- **Slug:** `decision:item-filter-by-name`
- **Title:** An item list can be filtered by status name and label name, and a name that matches more than one record is refused.
- **Ref:** `project_items`

A caller filtering collection:project_items by status or label used to need the id, so an agent looked up projects, statuses and labels before its first filter. The list now takes `status.name` with = and != and `labels.name` with ~ and !~, each with an exact name, and `pb_hooks/item_list.pb.js` replaces the name with the id before the query runs, so the rows are exactly those of the id filter.

- **Prior art.** The Linear issue filter takes a workflow state or a label by name (`state: { name: { eq } }`, `labels: { some: { name: { eq } } }`) and matches every state or label carrying that name, across teams. Here a status name is unique only inside a workspace and a label name only inside a workspace or a project, and every workspace starts with the same default statuses, so matching every record with the name would quietly mix workspaces. The call made here differs: the name must resolve to exactly one record.
- **What a name resolves to.** The candidates are the statuses or labels with that exact name that the caller can read. A top-level `workspace =` clause narrows them to that workspace, and a `project =` clause to the workspace of that project, which need not be readable itself, so the shadow project scopes too, with labels limited to the ones of that project and the ones of its workspace that belong to no project.
- **None or several is a 400.** No candidate answers 400 `value_not_found` and more than one answers 400 `value_ambiguous`, under `status` or `labels` in data, so a list never silently picks one. A record the caller cannot read is never a candidate, so neither answer reveals it.

## item-key-kept-on-move

- **Slug:** `decision:item-key-kept-on-move`
- **Title:** An item keeps its display key when it moves to another project, where Linear gives a moved issue a new identifier.
- **Ref:** `projects`

Supersedes the prior-art statements in decision:item-display-keys and decision:names-display-only, which said Linear mints an issue identifier once and the identifier follows its issue. It does not: when an issue moves to another team, Linear generates a new identifier and URL for it, and the old identifier and URL keep resolving to the issue by redirect and search.

- **What this app does.** A task, decision, document or milestone moves to another project of its own workspace by changing `project`; a project of another workspace is refused with a 400. The move leaves `key` unchanged: the item keeps its old prefix and number and takes no number from the new project, so the next item created there gets that project's next number. An item with no key arrives keyless and stays keyless. A client cannot change `key` at all. `tests/test_item_keys.ts` proves the move on a task and the key lock on all four types; `tests/test_scope.ts` proves the refusal of another workspace's project on all four types.
- **Why not re-key as Linear does.** A re-key leaves the old label in every link, comment and note that already used it, and Linear keeps those working by resolving the old identifier to the issue. This app stores no former key, so a re-keyed item's old label would find nothing. Keeping the key gives each item one label for life, at the cost of a prefix that may not match the project the item now sits in.

## key-revocation-ends-open-streams

- **Slug:** `decision:key-revocation-ends-open-streams`
- **Title:** Revoking, deleting or expiring an API key ends its open realtime streams
- **Ref:** `api_keys`

Revoking, deleting or expiring an API key ends every realtime stream opened with it, not only its next request. This supersedes in part decision:api-keys ("Open realtime streams survive revocation").

Why: the milestone 1 security audit (kata 62gm, finding q38p, confirmed by root in a clean room) showed a stream kept receiving records after its key was revoked, deleted or expired, while REST answered 401. A key is a long-lived credential handed to agents; incident response must be able to cut a stolen one off, and an OAuth-minted key must not outlive its 24-hour expiry on an open stream. A session token's stream may keep its auth because a session is short-lived and tied to a person; a key is neither.

Prior art: GitHub revokes a personal access token for every use at once and documents no grace period for open connections; Linear's API key revocation takes effect immediately for all access. Both treat revocation as ending access, not new requests only.

Rule: before each realtime message is sent to a client authenticated by an API key, the server re-checks that the key still exists, is not revoked, has not expired, and that its owner still passes the users authRule; a client failing the check receives nothing further: it is unsubscribed and its stream is closed. The check matches the token the stream subscribed with, so a stream opened with an access token that a refresh has since replaced ends too.

Accepted limit: the check runs per message, so a revoked key's stream is closed at the next message it would receive; an idle stream stays connected, receiving nothing, until then. A client that re-subscribes with its owner's session stays tied to the key it last subscribed with and ends with it.

## landing-and-switch-check

- **Slug:** `decision:landing-and-switch-check`
- **Title:** The server names the workspace a user lands in and answers whether a named workspace may be opened.
- **Ref:** `workspaces`

Which workspace a user opens after signing in, and whether they may switch to a named one, used to be decided by the web client. Clients are now agents calling the API, so both answers come from the server (decision:backend-owns-business-rules): GET /api/tracker/me/landing and GET /api/tracker/workspaces/{id}/switch, described under collection:workspaces.

**Landing order.** Owned first, then an active membership, then a pending invitation, then a suspended membership. A workspace the user owns is the one they are most likely to work in, and it can never be closed to them. An invitation comes after every workspace the user can already open, because it is an offer, not an entry: it decides the landing only for someone who has nowhere else to go. A suspended membership comes last, so a user whose only workspace has suspended them is told so rather than told they have none. A trashed workspace and an expired invitation are never a landing, and neither is an invitation to a workspace where the user is suspended: accepting leaves a membership row as it is, so it would show a join screen that changes nothing. For the same reason the switch check offers no invitation to a suspended member. Within each step the earliest created wins, so the answer is stable from one sign-in to the next. This follows Linear, which opens a workspace the user belongs to and offers pending invitations as a separate join step rather than an entry.

**Switch check.** The refusal names suspended only to the suspended member, who already knows the workspace exists; every other refusal is not_found, matching the 404 of a workspace read, so the route is no existence oracle. The check carries the caller's invitation to that workspace, expired or not, because a client must choose between showing it and sending the user to their landing.

## last-workspace-reprovision

- **Slug:** `decision:last-workspace-reprovision`
- **Title:** Deleting your last workspace provisions a fresh one, so no account is left without a workspace.
- **Ref:** `workspaces`

A user may delete their last workspace. An after-delete hook on `workspaces` in `pb_hooks/main.pb.js` then provisions a new one for the owner when they have no workspace left: the workspace, the owner membership, a default project, and the settings row if it is missing, the same steps signup runs (decision:auto-provision-workspace).

The hook first checks that the owner still exists, so deleting an account, which removes the user before its workspaces, provisions nothing. Trashing the last live workspace provisions in the same way (decision:workspace-trash-cleanup-not-atomic).

## leaver-tasks-unassigned

- **Slug:** `decision:leaver-tasks-unassigned`
- **Title:** When a member leaves or is removed from a workspace, their tasks in it are unassigned.
- **Ref:** `workspace_members`

Only members can be assignees: a request hook in `pb_hooks/main.pb.js` refuses, with 400, an assignee who is neither the workspace owner nor an active member. A stale assignment on someone who left would break that invariant, so an after-delete hook on `workspace_members` in the same file clears `tasks.assignee` on every task in that workspace assigned to the departed user.

The hook absorbs errors, so it is a harmless no-op when the membership goes because its workspace or user is being deleted.

## me-route

- **Slug:** `decision:me-route`
- **Title:** One call tells a caller who they are, where they belong and what they may do there.
- **Ref:** `workspaces`

A client opening a session needs the account, the workspaces it can enter, its role and standing in each, a few counts and the unread badge. The web proxy assembled that itself: it paged the membership list for the own row, counted projects and open tasks with one list call each, decided write and manage from the role in the browser, and read the badge as the total of a read=false notification list. Every client had to repeat that.

GET /api/tracker/me (route:tracker-me) now serves it from the server in one call. Prior art: the Linear API answers its viewer query with the signed-in user and the organization and teams they belong to in one request, and the GitHub REST API puts a permissions map of booleans, computed for the caller, on each repository it returns. The capability flags follow the GitHub shape and are derived from the role tiers (decision:role-tiers), so no client recomputes them; they are advisory, and every write is still decided by its collection rule.

Open means a live task whose status category is neither completed nor canceled, the same two categories project_items treats as resolved, so the name of a custom status never changes the count. A task with no status counts as open. The unread count is decided row by row by the live notifications list rule, so it cannot drift from what the inbox lists. A suspended membership stays in the list with its status, because a client must tell a closed workspace from a missing one, but the workspace name and counts are withheld: the workspace rules give a suspended member no read.

## names-display-only

- **Slug:** `decision:names-display-only`
- **Title:** A name a person typed is display only: nothing is keyed, addressed or resolved by it, or by anything derived from it.

Owner ruling 2026-08-07, after the shell addressed one account at another account's workspace.

- **The rule.** A text name never serves as a key. That covers a lookup string, slug or folder name computed from a name as much as a literal name column, because a slug derived from a name is still a name used as a key. It holds for URLs and for every resolution path, not only for database columns.
- **Why.** What a person typed changes and collides, and whatever is derived from it inherits both faults. The incident was a name-based resolution answering with the wrong account's workspace.
- **What to use.** The record id, or an identifier the system mints once and never changes (decision:item-display-keys). A human-readable label is minted at creation and then follows the record, even when it stops matching its surroundings, and a name a person can rename is a placeholder, never an address (decision:cycle-rollover).
- **Before adding a lookup** keyed on something a user typed, check whether the opaque id would do.

Prior art: Linear mints an issue identifier once and keeps the identifier through a rename of the title. It rules out a link that breaks on rename, two records colliding on one derived key, and a second reader assuming the label is a lookup.

**Superseded in part:** Linear does not mint an issue identifier once: moving an issue to another team gives it a new identifier (decision:item-key-kept-on-move); the rest of this record is unchanged.

## notification-fanout-semantics

- **Slug:** `decision:notification-fanout-semantics`
- **Title:** A task notification goes once to its subscribers, minus the actor and minus anyone the same write mentions.
- **Ref:** `notifications`

Subscriptions in `task_subscribers` grow on their own: creating a task subscribes its creator and any assignee, assigning subscribes the new assignee, and commenting subscribes the commenter. Deleting your own subscription row stops every later notification for that task.

Three task triggers fan out a `notifications` row to the current subscribers minus the actor:

- an assignee change (kind `assigned`);
- a status change into a status of the `completed` category (kind `status_done`);
- a task comment (kind `commented`).

A subscriber whom the same write names is told once, by the mention. On a comment, a subscriber the comment body mentions gets the `mentioned` row and no `commented` row. On an assign or a status change, whoever gained a new description mention in that same update gets only the mention. Someone mentioned by an earlier update is not subtracted, since this update told them nothing. Dismissing a notification marks it dismissed and keeps the row, so description text that did not change never mentions again. A mentioned workspace member who is not subscribed gets only the mention row. This follows Linear.

Fan-out is exactly once: `pb_hooks/notify.pb.js` captures the old values before the write and fires only on a real change, so a replayed PATCH with the same assignee or status sends nothing. Every step that needs the actor runs in a request hook around the write, because the actor is not available in after-success hooks. Comments on documents and decisions have no subscribers and fan out nothing. A daily digest cron emails each user one summary of their unread notifications. The `mentioned` and `ownership_transferred` kinds do not read the subscriber set (decision:notification-kinds-ship-with-producer).

## notification-kinds-ship-with-producer

- **Slug:** `decision:notification-kinds-ship-with-producer`
- **Title:** Every notification kind ships with a live producer, and the producer need not live in the fan-out file.
- **Ref:** `notifications`

`notifications.kind` is a closed select of five values: `assigned`, `commented`, `status_done`, `mentioned` and `ownership_transferred`. Each value has a live producer. A kind that nothing writes is a vestigial field, so it is removed rather than reserved for a future producer.

- `assigned`, `commented` and `status_done` come from the subscriber fan-out in `pb_hooks/notify.pb.js` (decision:notification-fanout-semantics).
- `mentioned` comes from the mention parser in `pb_hooks/notify.pb.js`. It resolves each handle in a comment body, or in the prose of a task, document or decision, against the active members of the workspace plus its owner, and writes one row per resolved member.
- `ownership_transferred` comes from `POST /api/tracker/workspaces/{id}/transfer-ownership` in `pb_hooks/routes.pb.js`: one notice per party, inside the same transaction as the owner change and the audit row. A notice must commit or roll back with the handover it announces; emitting it from the fan-out file would need a second transaction or a callback that hides the coupling.

A check that proves this vocabulary reads it from `schema/notifications.json` and finds a producer for each value wherever it lives, never from one emitter file or a fixed list.

## notifications-stamped-with-workspace

- **Slug:** `decision:notifications-stamped-with-workspace`
- **Title:** Each notification carries the workspace of the item it is about, so a caller can scope the inbox to one workspace.
- **Ref:** `notifications`

Every emitter in `pb_hooks/notify.pb.js`, and the ownership-transfer route, fills `notifications.workspace` at write time with the workspace of the item the notice is about; for a comment that is the workspace of its task. A caller that works in one workspace lists the rows whose workspace is that one, plus rows with no workspace, which belong everywhere like a notice about no item. Stamping at write time keeps a join through the item out of every list, count and mark-read query.

`POST /api/tracker/notifications/read-all` takes the same scope. With `?workspace=` it marks read only that workspace and the rows with no workspace, so clearing one workspace never marks unseen notices in another; without it, it marks the whole unread inbox. The daily digest email covers the whole account. This follows Linear, where an inbox belongs to one workspace.

## oauth-providers-from-env

- **Slug:** `decision:oauth-providers-from-env`
- **Title:** GitHub and Google sign-in are each enabled by an environment pair and both link by verified email.
- **Ref:** `users`

This supersedes decision:github-oauth-verified-email-linking, which covered GitHub alone and said that with the GitHub credentials unset OAuth stays disabled. Prior art: Linear offers Google sign-in beside email login, passkeys and SAML, and no GitHub sign-in; GitHub is the provider this app already had.

- **Providers from the environment.** Each provider has a client id and client secret pair in the environment. A provider is on only when both halves are set; a missing or half pair leaves that provider off, logged once at boot. The provider list is written on every boot, so removing a pair turns that provider off on the next deploy even though the earlier credentials were stored.
- **An existing link or session decides first.** A provider account already linked to an account signs into that account, and a signed-in account adding a provider gets the link itself, whatever account the provider's email folds onto.
- **Verified email, both providers.** A first sign-in through either provider with a provider-verified email is saved as verified, because the provider already proved the address and the users auth rule requires a verified account. When neither of those decides, a sign-in whose verified email folds onto an existing account (collection:users, email identity) links to that account instead of creating a duplicate. Both providers report an email only when they have verified it, so an unverified claim never matches. Both steps are idempotent and do nothing when already true. A provider signup still starts unapproved (decision:signup-approval).
- **An unverified account.** When the account a sign-in reaches is still unverified, as when someone else signed up at that address first, PocketBase's own pre-registration guard runs before it is verified: its password is reset to a random value and its links to other provider accounts are removed, so whoever created it keeps no way in. The reset, the verified flag and the new link are saved together or not at all, and a database failure answers 500 and leaves nothing half done, so the next sign-in starts clean. An account a sign-in creates is saved verified only when its email is the address the provider verified.
- **Accepted risk.** Google reports an address as verified for any domain whose mailbox it confirmed, Gmail or not, and that verdict outlives a custom domain changing hands, so a provider account on a lapsed domain could link to an existing password account holding the same address. GitHub carries the same class of risk; neither is mitigated here.

## password-signup-verify-first

- **Slug:** `decision:password-signup-verify-first`
- **Title:** A password signup takes no password: the signup mail links to choosing one, and choosing it verifies the account.
- **Ref:** `users`

Supersedes decision:verified-login and the verification-mail parts of decision:signup-mail-off-request. Owner verdict 2026-11-06 (kata zhdh), after a probe showed that a stranger could sign up at someone else's address with a password they knew, and that the password still signed in once the real owner confirmed the verification mail and an administrator approved the account (kata fr92).

- **No password at signup.** A public `POST /api/collections/users/records` takes the email and the display fields only. A body that carries `password` or `passwordConfirm` answers 400 with the error on `password` (code `validation_signup_password`) instead of dropping it, because a client whose password was silently dropped would believe it can sign in. The server gives the account a random password nobody knows, so no password exists on it before the mailbox owner acts. A superuser create keeps what it submits (seeding, import). A provider signup always gets a random password, whatever its createData carries, because createData can name a password and an address the provider never proved; the provider still decides whether the account is verified (decision:oauth-providers-from-env).
- **The signup mail sets the password.** The mail sent on signup (decision:signup-mail-off-request) is a welcome mail whose link opens the PocketBase set-password page (`/_/#/auth/confirm-password-reset/{TOKEN}`). `POST /api/collections/users/confirm-password-reset` sets the password and marks the account verified, because only the mailbox owner holds the token, and the token works once. The link works for the PocketBase password reset lifetime, 30 minutes, and the mail states the lifetime configured on the collection; `POST /api/collections/users/request-password-reset` sends a fresh one, and while the account is unverified that mail reads as finishing signup rather than as a reset.
- **Every way of verifying drops an earlier password.** confirm-password-reset verifies by setting the password the mailbox owner chooses. `POST /api/collections/users/confirm-verification` and a superuser setting `verified` through the records API also verify, and both replace a password the account held before it was verified with a random one, unless that superuser request sets a password itself; PocketBase does the same on confirm-verification when password sign-in is off, and one-time-password and provider sign-in already do so. This closes the hole for accounts that signed up with a password before this change: once verified, their owner chooses a password through request-password-reset, the forgot-password flow.
- **Unchanged.** The `users` auth rule still requires `verified` and `approved` (decision:signup-approval). An approved account that never verifies, which now means one whose owner never chose a password, is still deleted by the daily `unconfirmed-signup-purge` after 30 days, and signup keeps its rate limit (decision:rate-limits-batch-and-superuser-mfa).

Prior art: Linear and Slack sign up email-first, where a link or code proves the mailbox before any credential exists. `tests/test_signup_verification.ts` proves it.

## project-items-membership-denormalised

- **Slug:** `decision:project-items-membership-denormalised`
- **Title:** The project_items view carries workspace membership on each row, so its rules match the caller with no cross-collection join.
- **Ref:** `project_items`

The `project_items` view computes three text columns on every row by correlated subselect: `workspace_owner` holds the workspace owner id, and `active_members` and `active_admins` hold the ids of the active members and the active admins as a comma-delimited list of the form `,id1,id2,`. The list and view rules of `project_items` match the caller against these columns, for example `active_members ~ @request.auth.id`, and contain no `@collection.` join. The counts route `GET /api/tracker/project-items/counts` evaluates the same list rule, so it inherits the same cost.

The reason is cost. PocketBase evaluates an `@collection.` join against the whole joined table, so a rule that joins `workspaces` or `workspace_members` makes one caller list grow with every workspace and membership row in the database, including rows that caller can never see. Matching against columns on the row keeps a list read flat as the database grows.

The design accepts three costs:

- **The roster is readable.** Any caller who can see one item in a workspace can read the owner, active-member and active-admin ids of that workspace from the row. A view field cannot be marked hidden on PocketBase 0.40.4, and the view `workspace` column is text rather than a relation, so no traversal rule can stand in for the columns. Any signed-in account can already list user ids, so what the columns add is the association, not the ids.
- **The columns are API surface.** They are filterable and sortable, and every change to them is a contract change.
- **The caller id is the pattern side of a LIKE.** A `%` in an id would match every row. The `users.id` field closes this: its pattern is `^[a-z0-9]+$` with a length of exactly 15, enforced on create for every caller, and a record id never changes on update.

## project-stats-membership

- **Slug:** `decision:project-stats-membership`
- **Title:** Workspace members can read the task counts of the projects in their workspace.
- **Ref:** `project_stats`

`project_stats` is a read-only view of task totals per project, bucketed by status category, with trashed projects and tasks excluded in its query. The query selects the project workspace as `workspace`, which PocketBase types as a relation to `workspaces`, so the list and view rules can admit the owner of that workspace or any active member of it; the creator of the project, its `owner`, gains no read from that role (decision:active-membership-grants-access).

The view joins no membership itself, so those two rules are its only tenant control. They also require an authenticated caller, because an anonymous empty id would otherwise match an empty membership join. Create, update and delete are null.

## project-workspace-immutable

- **Slug:** `decision:project-workspace-immutable`
- **Title:** A project cannot move to another workspace over the API, and a superuser is exempt.
- **Ref:** `projects`

Moving a project between workspaces would strand every item still pointing at it in the old workspace. An `onRecordUpdateRequest` hook on `projects` in `pb_hooks/scope.pb.js` refuses any update that changes `workspace`, with 400 and the message workspace is immutable. This applies to every tenant caller, including a workspace owner or admin.

A superuser is exempt, and so is a programmatic save, because the hook runs only on API requests. The superuser exemption keeps a recovery path for a mis-scoped project without a migration, and keeps it possible to build the incoherent row that the guards tolerating such rows must handle. Any future code that moves a project with a programmatic save bypasses this guard and needs its own check.

Items hold the same rule for their own `workspace` field (decision:dual-scope-items). See collection:projects.

## project-write-access

- **Slug:** `decision:project-write-access`
- **Title:** Creating and editing a project takes the workspace owner or an active non-viewer member, and deleting one takes the owner or an admin.
- **Ref:** `projects`

On `projects`:

- **Create** requires the workspace owner or an active member whose role is not viewer, in a workspace that is not in the trash. The `owner` field may be empty or the caller, never someone else. A body that sets the `shadow` flag is refused, so nobody creates the hidden per-workspace project (decision:shadow-project).
- **Update** admits the same set, so a member who creates a project can rename and configure it, and so can any other active non-viewer member. This matches Linear, where project attributes are editable by workspace members and admin roles gate workspace settings rather than individual projects. A trashed project stays editable only by the workspace owner and active admins, the tier that can restore it, and the shadow project is not editable at all.
- **Delete**, which trashes and then purges, takes the workspace owner or an active admin. Trashing a project pulls shared work out from under every member and moves everything in it to the trash (decision:soft-delete-trash); Linear also reserves project deletion to admins.
- **Locks.** The update rule refuses any submitted `owner` or `shadow`, and both locks are top-level conjuncts of the rule, because a lock inside one OR branch would leave the other branches writable.

`owner` records who created the project and grants no write: no create, update or delete rule treats it as authority, so there is no project ownership transfer. It grants no read either: the task counts of the project follow workspace membership alone (decision:project-stats-membership). The workspace of a project is immutable (decision:project-workspace-immutable). Role tiers themselves are described in decision:role-tiers.

## rate-limit-counts-x-real-ip

- **Slug:** `decision:rate-limit-counts-x-real-ip`
- **Title:** The rate limiter counts the client address Railway's edge sets in X-Real-IP, never one a client sends in X-Forwarded-For.

Supersedes the client-address statement in decision:rate-limits-batch-and-superuser-mfa, which keyed the limiter on the leftmost `X-Forwarded-For` entry. That entry is whatever a client sends: a room proved it, a client-set `X-Forwarded-For` after a 429 got a fresh bucket. Railway documents no handling of an inbound `X-Forwarded-For`, so nothing rules out the same answer behind its edge, and PocketBase's own setting warns that a proxy may let a client prepend to that header.

- **The rule.** `trustedProxy` names `X-Real-IP` alone and reads its rightmost entry. Railway's public-networking reference lists `X-Real-IP` as the header "for identifying client's remote IP". PocketBase 0.40.4 reads only the last line of a repeated header and, with `useLeftmostIP` false, the last address in it, so a value a client sends does not count when the edge writes a bare address that replaces the header, is appended to it or sits on its own line after it. A request without the header is counted by the address it arrives from. Every rate limit (sign-in, signup, `request-otp`, the `/api/` pool) uses this address.
- **Proof.** `tests/test_agent_probe.ts` shows a client-set `X-Forwarded-For` after a 429 still answering 429, a client `X-Real-IP` entry left of the edge's still answering 429, and another `X-Real-IP` address getting its own bucket. `e2e/smoke.ts` shows the same for sign-in against the production image. Neither has Railway's edge in front, so both stand in for the address the edge sets.
- **Limit.** PocketBase trusts the header from any peer. A caller that reaches the server without passing Railway's edge, such as another service on the project's private network, chooses the address it is counted as. Railway documents neither whether its edge replaces a client-sent `X-Real-IP` nor the exact form of the value it writes; if it passes a client value through unchanged, that client chooses its address too.

## rate-limits-batch-and-superuser-mfa

- **Slug:** `decision:rate-limits-batch-and-superuser-mfa`
- **Title:** Auth endpoints are rate limited, batch writes are atomic, and superusers sign in with a second factor.

These settings are applied by migration.

- **Rate limits.** Per client address: 10 a minute on `POST /api/collections/users/auth-with-password` and its superuser twin, 5 a minute on `request-otp` for both, 5 a minute on `POST /api/collections/users/records` (signup), and 300 a minute across `/api/`. Rules name complete method-qualified paths, because a generated tag outranks a path prefix. Superusers bypass the limiter. The limiter reads the client address from `X-Forwarded-For`, so callers behind the hosting edge are not all keyed as one address.
- **Batch.** `/api/batch` is enabled with at most 50 requests and a 3 second timeout. A batch commits in one transaction and still applies the API rule of each operation, so one refused operation fails the whole batch.
- **Superuser MFA.** `_superusers` requires MFA with an emailed one-time password (8 digits, valid for 5 minutes), so a superuser login depends on working mail.

CORS is a server start flag rather than a setting, and its allow-list comes from the deployment environment.

**Superseded in part:** a batch cannot create a `users` record unless the caller is a superuser (decision:batch-signup-refused), so the signup limit is a single bucket of direct signups; the rest of this record is unchanged.

**Superseded in part:** the limiter reads the client address from `X-Real-IP`, not `X-Forwarded-For` (decision:rate-limit-counts-x-real-ip).

## reactions-own-id-toggle

- **Slug:** `decision:reactions-own-id-toggle`
- **Title:** Any member who can see a comment may react to it, toggling only their own id.
- **Ref:** `comments`

`comments.reactions` is a JSON map from emoji to an array of user ids. The `comments` update rule carries a branch for any member who can view the target that permits a PATCH setting only `reactions`; every other field is locked on that branch, so such a member still cannot edit the body of another author.

A request hook in `pb_hooks/notify.pb.js` then refuses with 400 any change whose added or removed ids, across all emoji, include an id other than the caller, so a user toggles only their own reaction. Superusers bypass the check. The hook parses the value with String and JSON.parse, because it arrives as a raw JSON wrapper rather than a native object.

## refused-migration-fails-the-deploy

- **Slug:** `decision:refused-migration-fails-the-deploy`
- **Title:** A migration the hooks refuse fails the deploy at container start, before anything is written, and recovery is a rollback to the previous successful deployment.

Why. Continuous integration replays every migration into an empty database with the hooks loaded, at commit time and on every pull request, so a migration the hooks refuse is caught at commit time and in the pull request whenever those gates run. They are process rather than enforcement: a change can reach main and deploy without them, and no gate before the deploy can see a refusal that depends on production data. The hosting platform runs a volume-backed service as one deployment at a time: the previous container is stopped before the new one starts, and a pre-deploy command runs in a separate container with no volume mounted. No step between the merge and the new container can read the production database.

Options weighed. (a) A pre-deploy command that replays the migrations against a copy of the production database: not available, because the volume is not mounted at pre-deploy time, so such a command could only replay against an empty database, which the gate already does. (b) The empty-database replay plus a documented rollback and an alert on a failed deploy: in place. (c) A start guard that replays the migrations before the server starts: in place as the first step of the container start command. It replays against the volume itself rather than a copy, because the whole pending set applies in one transaction and a refusal records no migration and changes no application data (the boot refusal suite plants a benign migration ahead of a refused one and neither is recorded), so a copy would cost a second full replay on every start and yield no new verdict.

Decision. Keep (b) and (c) and add nothing at pre-deploy time. The container start command replays the migrations with the hooks loaded as its first step. A refused migration ends the start with a non-zero status and a line naming the migration, before any superuser is written and before the server binds, so the platform marks the deployment failed and the database holds what it held before the deploy. The platform restarts a failed container up to ten times by default; each restart meets the same refusal and prints the same lines, which is noise rather than harm, and the restart policy stays as it is because a transient crash on a good build must still restart. A refused deploy is an outage until an operator rolls back to the previous successful deployment; that path, and the notification rule that announces a failed deploy, are the runbook in the deploy README.

Accepted risk. A migration that passes against an empty database and is refused only by production data, or one that reaches main without the gates running, is caught at container start, with that outage. The earlier catch, a replay against a copy of the production backup before the merge, needs that backup in the pipeline and is not built; the rollback is the response.

Prior art. Rails: the generated container entrypoint runs db:prepare before the server command, so migrating is the first thing a new container does, and on a database with transactional schema changes each migration is wrapped in a transaction and rolled back on failure (Active Record Migrations guide; docker-entrypoint template). Django: on SQLite and PostgreSQL all operations of a migration run inside a single transaction by default (Migrations topic guide). Prisma: the deploy step runs in the pipeline and is never planned by hand in production, and the shadow database that detects drift is a development-only mechanism not used by production commands (Applying a migration; Shadow database). Heroku: if a release phase task fails the new release is not deployed and the current release is unaffected, which is the behaviour a volume-backed service cannot have here. Railway: pre-deploy commands execute between building and deploying in a separate container, volumes are not mounted during pre-deploy time, and a failing command stops the deployment (Add a Pre-Deploy Command; Using Volumes); a deploy is marked failed when the healthcheck returns no 2xx within the timeout (Healthchecks); a redeploy of a service with a volume carries a small amount of downtime (Volumes); the default restart policy is On Failure with a maximum of ten restarts (Restart Policy).

## role-tiers

- **Slug:** `decision:role-tiers`
- **Title:** A workspace has one owner, and its members hold the admin, member or viewer role.
- **Ref:** `workspace_members`

The owner powers come from `workspaces.owner`, independent of any membership row. Everyone else holds a `workspace_members` row whose `role` is `admin`, `member` or `viewer` and whose `status` is `active` or `suspended`; only an active row grants anything (decision:active-membership-grants-access). Rules test admin as a same-row match on the membership back-relation, so a plain member of a workspace that has some other admin is not an admin.

| action | who |
|---|---|
| edit workspace settings and vocabulary | owner, admin |
| invite a member | owner, admin |
| change a role | owner |
| create, edit and trash items | owner, admin, member |
| purge from the trash | owner, admin |
| read | every active role, viewer included |

A viewer reads what a member reads and writes nothing in the workspace, a task assigned to them included: they cannot edit it, comment on it, react to its comments, subscribe to it or add subtasks under it. Items are tasks, decisions, documents and milestones. Their create, update and delete rules admit the owner and any active non-viewer member, with draft privacy on top (decision:draft-private-publish-one-way), so a delete by a member moves the item to the trash (decision:soft-delete-trash).

Raising a role is an owner action on every path. Membership rows come from accepted invitations, and `workspace_invitations.createRule` lets an admin invite only with the member role while the owner may invite with any role. `workspace_members.updateRule` lets an admin edit a row only without touching `role`.

## saved-views-visibility

- **Slug:** `decision:saved-views-visibility`
- **Title:** A personal saved view is visible only to its owner and a workspace view to every active member, by rule alone.
- **Ref:** `saved_views`

`saved_views` visibility comes from its API rules, with no hook. Every rule first requires the workspace owner or an active member. A view whose `scope` is `personal` lists only for its owner; a view whose `scope` is `workspace` lists for every active member. Another member gets a personal view left out of lists and a 404 by id.

Create admits the owner and active non-viewer members, and the `owner` in the body must be empty or the caller, so nobody creates a view owned by someone else. Update and delete admit the view owner, the workspace owner or an active admin, and an update cannot move a view to another workspace. The optional project filter of a view must belong to the view workspace (`pb_hooks/scope.pb.js`).

## search-scoping-standard

- **Slug:** `decision:search-scoping-standard`
- **Title:** The search route scopes itself to what the caller could already list.
- **Ref:** `tasks`

`GET /api/tracker/search?q=` is a custom route in `pb_hooks/routes.pb.js`, and custom routes skip collection rules, so the handler scopes itself. It requires authentication (401 otherwise) and runs one bound-parameter query per collection (tasks, decisions, documents, milestones, projects), each limited to workspaces the caller owns or holds an active membership in; a task assigned to the caller matches only under that same limit. The standard is parity with the list rules: search returns only rows the caller could list.

- Trashed rows and rows in a trashed project are excluded for everyone.
- Drafts follow the list rules per row: a draft reaches only its author, the workspace owner and active admins.
- Matching is case-insensitive through LOWER and LIKE, which folds ASCII only. LIKE metacharacters are escaped and every value is bound.
- A run of control characters in `q` becomes one space before escaping, so a null byte cannot cut the pattern short; a query of only control characters is treated as blank. A title that holds a control byte is reachable only through the fragments around it.
- An optional `workspace` parameter limits every query to that workspace before the cap. Sent present and empty, it is refused with 400.
- Title hits rank before body-only hits. Each collection fetches 21 rows, the results interleave by rank and then by fetch position, and the response keeps the top 20 with `truncated` true when more matched. Rank still comes first, so a collection with only body hits can be crowded out by another that fills the cap with title hits.

Each hit is `{collection, id, title, project, rank}`, where `project` is the project id of an item hit and empty for a project hit.

## server-owned-fields-locked

- **Slug:** `decision:server-owned-fields-locked`
- **Title:** A field the server owns is refused when a client sends it: the owner of a saved view and the core flag of a label are locked, and completedAt follows the status.

The server owns some fields outright: it fills them, derives them or seeds them, and a client has no legitimate write to them. Three were still writable over the API: the owner of a saved view could be reassigned on update, the core flag of a label could be set at create or cleared on update, and completedAt on a task could be changed by an update that left the status alone.

Prior art is Linear: a label marked as a workspace label cannot be deleted by members, and the completed timestamp of an issue is derived from its status and is never edited directly. The same ruling applies here: a server-owned field a client sends is refused, so the caller learns at once that the write did not happen, instead of reading back a value the server quietly replaced.

Rulings. saved_views.owner: an update that sends a different owner answers as an unknown id does; sending the stored owner back is accepted; a superuser is exempt. labels.core: a create or an update that sends core, true or false, is refused for every caller but a superuser, with 400 at create and the unknown-id answer at update; the core labels stay undeletable (decision:core-labels-undeletable). tasks.completedAt: a value sent at create is still replaced, because the status at create decides it; on update it is refused with 400 unless the same request moves the status into or out of a completed status, and then the server value wins; a superuser is exempt, as with the two rule locks. Each field says so in its help text.

## shadow-project

- **Slug:** `decision:shadow-project`
- **Title:** An item created without a project lands in its workspace shadow project, which no caller can see or change.
- **Ref:** `projects`

Every workspace owns exactly one shadow project, a `projects` row with `shadow` set to true. `pb_hooks/shadow.pb.js` creates it in the universal after-create tier for `workspaces`, so every provisioning path and a direct API create get one. A task, decision, document or milestone created or updated with no project is placed in it by the same file, and a caller who names the shadow project explicitly is refused: it is a placement, never a choice. This follows Linear, where an issue with no project still sits in its team backlog, a container the user never deletes.

- **Invisible.** The projects list and view rules exclude shadow projects for every role, so a shadow project never appears in a project list, a direct read, or an `expand=project`. Its items stay reachable: they list under the workspace, in assigned-to-me lists and in search.
- **Unchangeable.** The projects update and delete rules exclude shadow projects for every role, and no create or update may submit `shadow`, so the container cannot be renamed, deleted or forged.
- **Trash follows the workspace.** The shadow project is hidden and restored with its workspace (decision:workspace-trash-cascades) and is never trashed or purged on its own.
- **No key.** It takes no prefix, so its items stay keyless (decision:item-display-keys).

The shadow project is a different concept from `workspaces.default_project`, which is a visible pointer a user sets (decision:workspace-default-project); a workspace default project may not be the shadow project.

## signup-approval

- **Slug:** `decision:signup-approval`
- **Title:** A new account cannot sign in until an app administrator approves it.
- **Ref:** `users`

Signup stays open, but `users.approved` starts false and the `users` auth rule requires both `verified` (decision:verified-login) and `approved`, so a verified but unapproved account is refused its token with 403 until approved. Neither a signup nor a self-update may mention `approved`: the create answers 400 and the update 404. A GitHub signup is verified by the provider and still lands unapproved (decision:github-oauth-verified-email-linking). Signup is rate limited (decision:rate-limits-batch-and-superuser-mfa).

Approval is an app-level power held by superusers and by accounts whose email is listed in the `APP_ADMIN_EMAILS` deployment setting. `GET /api/tracker/admin/pending-users` lists waiting accounts and `POST /api/tracker/admin/pending-users/{id}/approve` approves one. Custom routes skip collection rules, so both scope on the caller themselves, and both answer any other caller with 404, which reveals nothing about who is waiting.

Owning or administering a workspace grants no approval power. Every signup provisions and owns its own workspace, so a workspace-tier power would let any stranger unlock any pending account. Approval is always a human act; nothing approves automatically.

**Superseded in part:** provider sign-in now means GitHub or Google (decision:oauth-providers-from-env); a signup through either is verified by the provider and still lands unapproved.

## signup-mail-off-request

- **Slug:** `decision:signup-mail-off-request`
- **Title:** A public signup answers without waiting for the mail server: a loopback request that answers before it sends delivers the verification email.
- **Ref:** `users`

Before this, the send in `pb_hooks/mail.pb.js` ran inside the users create request, so with the mail server unreachable a signup answered after about 75 seconds, and a client that timed out and retried was refused because the account already existed. Prior art: PocketBase sends its own request-verification email in the background and answers 204 at once.

- **How.** A JSVM hook cannot start background work, so after the account is saved the create hook sends a POST to `/internal/signup-verification/{id}` on the address serve listens on, read from its --http flag (0.0.0.0 becomes 127.0.0.1), with a one-second timeout. That route answers 204 with Connection: close before it sends, so the caller neither waits nor reuses the busy connection. It then waits up to five seconds for the account to commit, because a batch signup commits only after its hook returns, and sends the email unless the account is already verified.
- **Who can call it.** Only this server: the route answers 404 unless the request carries a secret drawn at every boot and held in memory. It sits outside /api/, so no rate limit rule counts it, and a client that spends the rate limit of the server address cannot stop the email; an API key gets 403 there, as on every route off its allowlist.
- **Bound.** A signup answers in about the time it takes without mail. The tests hold it under 2 seconds with the mail server unroutable, and a batch signup still gets exactly one email.
- **Failures.** A failed send, or a failed loopback call, keeps the account and logs signup verification email failed against the user id with the address redacted. POST /api/collections/users/request-verification sends again at once. The server does not retry by itself.

Accepted limits:

- **A loopback call that takes longer than one second is logged as failed** although the route may still send, so a client that then calls request-verification can receive two emails.
- **A server reachable only through --https, or not on its --http address,** cannot call itself; every signup then logs the failure and sends nothing until request-verification is called.

See collection:users and decision:verified-login. `tests/test_signup_verification.ts` proves it.

**Superseded in part:** the mail this route sends is the welcome mail that sets the password (decision:password-signup-verify-first), not a verification mail, so its resend is POST /api/collections/users/request-password-reset rather than request-verification. The loopback call, its secret, its bound and its failure handling are unchanged.

## soft-delete-trash

- **Slug:** `decision:soft-delete-trash`
- **Title:** Deleting a workspace, project or item moves it to the trash, a second delete purges it, and a daily cron purges expired trash.

Six collections carry a `trashed` date, empty on a live row: `workspaces`, `projects`, `tasks`, `decisions`, `milestones` and `documents`. Per-collection delete-request hooks in `pb_hooks/trash.pb.js` choose the verb from the current `trashed` state:

1. A superuser delete always deletes for real, an escape hatch for cleanup.
2. A first delete stamps `trashed` with the current time through a programmatic save and answers 204.
3. A second delete of a trashed row purges it. For items the hook rechecks inline that the caller is the workspace owner or an active admin, and refuses anyone else with 400. For projects and workspaces the delete rule already admits only the purge tier (owner or admin for projects, owner for workspaces), so the hook lets the delete through.

PocketBase evaluates the delete rule before the hook, so the item delete rules admit every active non-viewer member, who may trash, while purging stays with the owner and admins.

**Restore** is a plain PATCH clearing `trashed` under the existing update rule. Only a delete moves a row into the trash: an update that sets or re-dates `trashed`, or changes `trashed_by` while the row stays in the trash, is refused with 400, so an update can only restore; a superuser is exempt (card te4g). `GET /api/tracker/trash` lists the trash of a workspace for any active member, with a `purge_at` for each row.

**Reads.** A trashed item, or an item in a trashed or missing project, is hidden from list and view on its own collection, from `project_items`, from every expand that points at it and from `POST /api/tracker/export`. Comments, activity, subscriptions and notifications hanging off it are hidden with it. `project_stats` excludes trashed rows in its query. Trashing a project stamps nothing on its items; the item rules hide them while it is in the trash (decision:dual-scope-items). Trashing a workspace cascades to its contents (decision:workspace-trash-cascades).

**Expiry.** A daily cron (`0 4 * * *`, overridable through `TRASH_PURGE_CRON`) purges every row trashed for longer than `app_settings.trash_retention_days`, which reads as 30 when unset or unreadable, parents first. `POST /api/tracker/trash/purge`, superuser only, runs the same sweep on demand and returns `{purged: <count>}`. Purging a project or workspace removes its children through relation cascades. An item created while its project is being purged can outlive the cascade scan; the next sweep deletes it, and until then the item rules hide it because they require the project to exist.

## status-delete-referenced

- **Slug:** `decision:status-delete-referenced`
- **Title:** A status that any task references cannot be deleted.
- **Ref:** `statuses`

A delete-request hook on `statuses` in `pb_hooks/main.pb.js` refuses with 400 deleting a status that at least one task points at, and the row survives. An unreferenced status deletes normally, the default status included, because the workspace can mark another one as default.

A caller that wants to reassign and then delete repoints the tasks to another status first and deletes afterwards. The server keeps one hard invariant: a status never disappears from under a task. See decision:vocab-first-class-collections.

## superuser-actions-name-operator

- **Slug:** `decision:superuser-actions-name-operator`
- **Title:** An audit row written for a superuser names the operator by email, because a superuser is not a user record.
- **Ref:** `task_activity`

`task_activity.actor` is a relation to `users`, and a superuser lives in `_superusers`, so a superuser write cannot fill it. Such a row fills `task_activity.operator` instead: a text column holding the email of the superuser who acted. The two are exclusive: a user write fills `actor` and leaves `operator` empty, and a superuser write fills `operator` and leaves `actor` empty.

Two paths fill it: `POST /api/tracker/workspaces/{id}/transfer-ownership` when a superuser runs the transfer, and the activity hook in `pb_hooks/activity.pb.js` when a superuser edits a task. A row with neither identity is a server-side consequence, such as a cycle rollover, and reads as a system action.

A free-text `actor` would break every expand of the relation, and a separate collection for operator actions would split one history in two. Prior art: GitHub audit logs name the actor of an admin action rather than leaving it blank.

## task-labels-from-workspace-vocabulary

- **Slug:** `decision:task-labels-from-workspace-vocabulary`
- **Title:** A task attaches existing labels of its own workspace, and creating a label is an owner or admin action.
- **Ref:** `labels`

`tasks.labels` is a multi-relation to `labels`. A task attaches labels by id from the vocabulary of its own workspace: the seeded core labels plus any custom ones. `pb_hooks/scope.pb.js` refuses with 400 any attached label that belongs to another workspace.

Creating, editing and deleting labels is workspace configuration, open only to the workspace owner and active admins (`labels.createRule`, decision:role-tiers), so authoring a task never creates a label. See decision:vocab-first-class-collections.

## tasks-have-no-default-assignee

- **Slug:** `decision:tasks-have-no-default-assignee`
- **Title:** A task created without an assignee stays unassigned.
- **Ref:** `tasks`

Nothing fills `tasks.assignee` at create. A task created without one is stored with an empty assignee and belongs in the Unassigned group, whoever created it and whoever owns its project. This follows Linear, where an issue created without an assignee sits in Unassigned regardless of its creator.

The assignee hook in `pb_hooks/main.pb.js` only validates a submitted, changed assignee against the workspace membership, so an empty assignee is never validated and never defaulted. Bulk loaders and imports keep the same behaviour: an empty assignee in the input stays empty.

## user-settings

- **Slug:** `decision:user-settings`
- **Title:** Each user has exactly one settings row, which only that user can see or change.
- **Ref:** `user_settings`

`user_settings` holds personal preferences: `theme`, `font`, `font_size`, `default_view`, `default_project` and `time_zone`. A unique index on `user` allows one row per user, so a second create is refused with 400. All five rules admit only the user named on the row, and an update cannot change `user`.

The signup hook in `pb_hooks/main.pb.js` creates the row with `theme` and `font` set to `system`, and every provisioning path checks for an existing row first, so each user always has exactly one. The `user` relation cascades, so deleting an account deletes its settings.

## user-settings-write-checks

- **Slug:** `decision:user-settings-write-checks`
- **Title:** A settings save refuses a blank name, a default project or view the caller cannot read, and an unknown time zone.
- **Ref:** `user_settings`

`users.name` and the `default_project`, `default_view` and `time_zone` of `user_settings` are checked on every save through the records API and through route:tracker-user-settings, by one shared check in `pb_hooks/lib/workspace_rules.js` that judges each value as the record stores it, so an id sent inside an array is judged as that id, because an agent writing through the API gets no client to check them first.

- **A name cannot be blanked.** `users.name` is optional, so an account may have none and a signup may leave it empty. A name that changes, as `name` on users or as `display_name` on the settings route, must hold more than whitespace: a change to an empty or whitespace-only value answers 400 naming the field, and any other change is stored trimmed, like every required name (concept:write-normalisation). A resent unchanged name passes, so a form that saves every field still works on an account with no name, and a blank profile name from a sign-in provider is stored empty instead of refused, because the person did not type it.
- **A default pointer must be readable.** A changed `default_project` or `default_view` must exist and pass the view rule of its collection for the caller, so a personal default never points into a workspace the person cannot read or at the personal view of someone else. A missing and an unreadable id answer the same 400, with the PocketBase missing-relation code `validation_missing_rel_records`, so the refusal reveals no record. The shadow project keeps its own refusal (concept:shadow-project). A pointer that becomes unreadable later, for example after the person leaves the workspace, stays stored and does not block saving other fields.
- **A time zone must be real.** A changed `time_zone` must be an IANA name the server can load, such as Europe/Paris. Any other value, and Local (the server's own zone), answers 400 naming time_zone, because a stored typo would silently shift every day count by up to a day (decision:viewer-day-values). An empty value clears the setting.

## verified-login

- **Slug:** `decision:verified-login`
- **Title:** An account must verify its email address before it can sign in.
- **Ref:** `users`

Anyone can sign up, so the `users` auth rule requires `verified`, alongside `approved` (decision:signup-approval): an unverified account cannot sign in. The verification email carries a token valid for 24 hours, and `POST /api/collections/users/confirm-verification` sets the flag. An approved account that never verifies is deleted: the daily `unconfirmed-signup-purge` cron in `pb_hooks/signup_purge.pb.js` removes approved, unverified accounts created more than 30 days ago, except the sole owner of a workspace with other members, which is skipped and logged (decision:account-delete-sole-owner), while an unapproved account is never swept. Superusers are not subject to the `users` auth rule.

**Superseded:** decision:password-signup-verify-first replaces this record: a password signup verifies by choosing its password from the link in the signup mail, which works for 30 minutes, and confirm-verification still verifies but drops any password the account held before. The auth rule and the purge are unchanged.

## viewer-day-values

- **Slug:** `decision:viewer-day-values`
- **Title:** Due windows, purge countdowns and the next milestone are counted in the viewer's calendar day, on the server.
- **Ref:** `project_items`

Three values used to be worked out by each client from raw dates: how many days until an item is due and why it needs its assignee, how many days until a trashed item is purged, and which milestone of a project is next. The server now serves them: due_days and reason on every collection:project_items row, purge_days on every row of GET /api/tracker/trash (route:tracker-trash), and next_milestone on every collection:project_stats row. They are computed when a row is served, so they cannot be filtered or sorted on.

**Whose day.** A count of days depends on where the reader is: two readers on either side of the date line are on different calendar days at the same moment. Each value is therefore counted from today in the viewer's time zone: their user_settings.time_zone when it names a known zone, else a time_zone query parameter sent with the request, else UTC. The saved setting wins because it is what the person chose; the parameter serves a caller with no setting, such as a fresh account. An unknown name sent as time_zone, or Local (the server's own zone, which means nothing to a reader), answers 400 rather than being silently read as UTC. The server refuses to boot without the IANA zone database, because without it every zone would load as UTC.

**Dates and moments.** A due date and a milestone target are calendar days, as in Linear, whose due dates carry no time of day: the stored date is the day, never shifted into the reader's zone. purge_at is a moment, so the day it falls on is read in the viewer's zone, like today.

**Inbox reason.** reason is set only on a task assigned to the viewer whose status is not completed or canceled: overdue when due_days is below 0, due_soon from 0 to 3, assigned otherwise, including no due date. Every other row reads an empty reason, so resolved work never shows as overdue. The thresholds live only in pb_hooks/counts.pb.js. There is no in-review reason: no status marks review, and guessing one from the order of a custom vocabulary is wrong.

**Next milestone.** The earliest milestone of the project, neither trashed nor a draft, whose target is on or after the viewer's today; when all are past, the latest; when none has a target, empty. Same-day ties go to the lower id. Drafts are skipped because the stats row is read by members a draft is hidden from.

## vocab-first-class-collections

- **Slug:** `decision:vocab-first-class-collections`
- **Title:** Statuses and labels are per-workspace collections that tasks reference by relation.

`statuses` and `labels` are collections scoped to one workspace and seeded when a workspace is provisioned. `tasks.status` is a relation to `statuses` and `tasks.labels` a multi-relation to `labels`, so the vocabulary is queryable, joinable and carries metadata. A status has a `category` (the six Linear categories: triage, backlog, unstarted, started, completed, canceled), a `color`, a `position` and an `is_default` flag. A label has a `color`, an optional `project` and a `core` flag. `project_stats` buckets by status category.

The workspace owner and active admins write both collections and every active member reads them, because they are workspace configuration (decision:role-tiers). `POST /api/tracker/workspaces/{id}/vocab` saves a vocabulary edit in one transaction. Names are trimmed and unique within their scope. The status of a task must belong to the task workspace. A referenced status cannot be deleted (decision:status-delete-referenced), and neither can a core label (decision:core-labels-undeletable).

## workspace-configuration-freeze

- **Slug:** `decision:workspace-configuration-freeze`
- **Title:** A trashed workspace freezes its configuration and roster, and only the owner and active admins can still read them.
- **Ref:** `workspaces`

The freeze covers the configuration and roster collections of a workspace: `labels`, `statuses`, `cycles`, `templates`, `saved_views` and `workspace_members`. While the workspace is in the trash, their rules refuse every write for every role: a create is refused, and an update or delete answers as an unknown id does, for the owner and admins as much as for members. Leaving is a write on the roster, so nobody can leave a trashed workspace until it is restored.

Reads narrow to the people who can restore: the owner and active admins keep listing and reading the configuration and roster, which is what a restore lands back into, while members, viewers, suspended members and non-members get an empty list and the unknown-id answer. Nothing is stamped on these rows, so a restore brings them back unchanged.

The contents of a trashed workspace, its projects and items, stay hidden from everyone, the owner included (decision:workspace-trash-cascades). Priorities are a field of the workspace rather than a collection, so the freeze does not touch them. Prior art: Linear freezes a deleted workspace for its grace period and offers only restore.

## workspace-default-project

- **Slug:** `decision:workspace-default-project`
- **Title:** A workspace may name a default project, which must belong to that workspace.
- **Ref:** `workspaces`

`workspaces.default_project` is an optional single relation to `projects`. It does not cascade, so deleting the project clears the pointer and leaves the workspace. The workspace owner and active admins edit it through the `workspaces` update rule.

A hook in `pb_hooks/main.pb.js` refuses with 400 a project from another workspace or the hidden shadow project (decision:shadow-project). It is a hook rather than a rule because a rule refusal on update answers 404. Provisioning a workspace points it at the new default project.

## workspace-tenancy

- **Slug:** `decision:workspace-tenancy`
- **Title:** Every account works inside workspaces, each with exactly one owner and holding projects and their items.
- **Ref:** `workspaces`

The data model is user, workspace, project, item. A `workspaces` row has exactly one `owner`, a relation to `users`. Projects belong to one workspace through `projects.workspace`, and tasks, decisions, documents and milestones belong to a workspace and a project inside it (decision:dual-scope-items).

Configuration a single-user tool keeps in a file, such as statuses, labels, priorities and templates, lives per workspace. Access for anyone other than the owner comes from membership (decision:active-membership-grants-access, decision:role-tiers).

## workspace-trash-cascades

- **Slug:** `decision:workspace-trash-cascades`
- **Title:** Trashing a workspace hides everything in it, and the owner and active admins can list and restore it.
- **Ref:** `workspaces`

A trashed workspace has a non-empty `workspaces.trashed`. Every project and item collection rule (projects, tasks, decisions, documents, milestones) requires its workspace to be untrashed, as do the `project_items` and `project_stats` views and the search route, so the whole contents disappear from every reader and every create, update and delete under it is refused. Restoring the workspace brings all of it back, because nothing in it is changed by the trash. This follows Linear, where deleting a team removes its issues from every view until the team is restored.

- **Owner and active admins enumerate and restore.** `GET /api/tracker/workspaces/trash` lists the trashed workspaces the caller owns or administers as an active admin; the workspaces view rule hides a trashed row from everyone, so this route is how that tier finds it. Restore is a plain update clearing `trashed` under `workspaces.updateRule`, which admits the owner and active admins.
- **Configuration freezes rather than cascades**: labels, statuses, cycles, templates, saved views and the roster are covered by decision:workspace-configuration-freeze.
- The shadow project follows its workspace in and out of trash (decision:shadow-project).

## workspace-trash-cleanup-not-atomic

- **Slug:** `decision:workspace-trash-cleanup-not-atomic`
- **Title:** The cleanup after a workspace is trashed runs after the write and is not atomic with it.
- **Ref:** `workspaces`

When a workspace is trashed, an after-update-success hook on `workspaces` in `pb_hooks/trash.pb.js` runs the cleanup once, for every writer: a request, a programmatic save, a cron or a superuser. It drops the notifications about work in that workspace for good, and provisions a fresh workspace, membership and project when the owner has no other live workspace (decision:last-workspace-reprovision). A cleanup that fails part-way is logged and the trash stands, possibly with some notifications already dropped.

It is not a transaction because the pooled script runtime shares the app binding of an event across in-flight requests: pointing it at a transaction corrupts unrelated concurrent requests, and running the cleanup on the write path holds that path and turns concurrent trashes into failures. Both effects are measured. If a half-finished cleanup is ever seen, the remedy is a purge-time sweep that drops notifications pointing into a trashed workspace.

Only the owner moves a workspace into the trash through the API, with a DELETE; an update that sets `trashed` is refused for the owner and an active admin alike (card te4g). A superuser can still trash one with an update, and when that is the last live workspace of its owner, the owner gets the fresh workspace, because every user keeps a live workspace. Prior art: Linear lets admins as well as owners delete a workspace. Here deletion stays with the owner, through the owner-only delete rule (decision:soft-delete-trash).

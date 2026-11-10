# Design

How `contract.md` is met. All work is in the `tm` client (`clients/tm/`), its tests, and the
docs that describe it; no migration, hook, route or collection changes.

## Decisions

### D1. One catalog, verbs as plain functions

Each verb is one exported function in `clients/tm/src/verbs.ts`; the CLI (`clients/tm/tm.ts`)
and the catalog (`TOOLS` in `clients/tm/src/mcp.ts`) both call it, as the six existing verbs do.
The hosted service imports the same `TOOLS` (decision hfrk, ruling 5), so nothing in a verb
reads a transport, an environment variable or a file: every input arrives as `cfg` and
arguments. Alternative rejected: a separate hosted catalog, which ruling 5 forbids.

### D2. Dependencies: none added

Every verb uses `request` and `api` (`clients/tm/src/api.ts`), the generated types in
`clients/tm/src/api.generated.ts`, and the MCP SDK `clients/tm/package.json` already pins:
`@modelcontextprotocol/server` 2.4.0 after `hosted-mcp-endpoint` Phase 5 (it replaces
`@modelcontextprotocol/sdk` 1.32.2 there; the root `devDependencies` keep 1.32.2 for the
suites' client transports). No Bun-only API is used in `clients/tm/src/` (change
`tm-distribution` runs the client on Node): only `fetch` and `JSON`. Phases 1 to 3 add the new
verbs to `tests/test_tm_package.ts`'s per-runtime case `12e`, so a Bun-only call fails under Node.

### D3. Annotations

Every tool states every hint (proposal, What Changes). Defaults and meanings are those of the
MCP schema's `ToolAnnotations`, quoted from `@modelcontextprotocol/sdk` 1.32.2
(`dist/esm/spec.types.d.ts`, the SDK pinned on `main` when this was written):
`readOnlyHint` "If true, the tool does not modify its environment. Default: false";
`destructiveHint` "If true, the tool may perform destructive updates to its environment. If false,
the tool performs only additive updates ... Default: true"; `idempotentHint` "If true, calling the
tool repeatedly with the same arguments will have no additional effect on its environment ...
Default: false"; `openWorldHint` "Default: true". Values per tool are the contract's table. Two
calls the proposal did not name:

- `tm_restore` is `destructiveHint: true`: it overwrites `trashed` and `trashed_by`, which is not
  an additive update by the definition above. Alternative rejected: false, which would let a
  client skip confirmation on a write the definition does not call additive.
- `tm_delete`, `tm_restore`, `tm_subscribe` and `tm_mark_read` are `idempotentHint: true`: a
  repeat with the same arguments changes nothing further (a repeated delete or restore is refused
  before any write; subscribe and mark-read converge on one state).

`hosted-mcp-endpoint` (design D11, commit a631d7c) declares in `mcp.ts`
`type ToolDef = { ...; annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }; run: ... }`,
which has no `openWorldHint`. This change widens that member to
`annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean }`,
so the type itself refuses a tool without `openWorldHint` (destructive and idempotent stay
optional there, since a read tool omits them; the constants below set them for every write
tool). `tools_for` passes `annotations` through unchanged, so `tools/list` carries all four.
Two constants in `mcp.ts` carry them so a tool cannot omit one:
`READ = { readOnlyHint: true, openWorldHint: false }` and
`write(destructive: boolean, idempotent: boolean)` returning
`{ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false }`.

### D4. How the trash verbs find an item and its state

`project_items` is the one place an id resolves to its kind (today's `kind_of`). Its view rule
admits a trashed item to anyone who could read it live (`schema/project_items.view.json`
`viewRule`, second branch: `trashed != "" && workspace_trashed = 0 && ...`), and its row carries
`trashed` (room probe 2026-11-10: `GET /api/collections/project_items/records/{id}` answered 200
for a trashed task while `GET /api/collections/tasks/records/{id}` answered 404). So one GET gives
kind and trash state:

- `tm_delete`: row `trashed` non-empty → refuse, no `DELETE` sent. Otherwise `DELETE`. An item
  that is live but inside a trashed project is not visible in the view (first branch needs
  `project_trashed = 0`, second needs `trashed != ""`), so it answers today's 404 message.
- `tm_restore`: row `trashed` empty → refuse. Otherwise `PATCH` `{"trashed": "", "trashed_by": ""}`.
  Both fields are sent: `{"trashed": ""}` alone leaves `trashed_by` set (room probe: 200 with
  `trashed_by` still the trasher's id), and the hook in `pb_hooks/trash.pb.js`
  (`onRecordUpdateRequest`, "an update may touch `trashed`/`trashed_by` only to restore the row")
  admits clearing both.

Two further room-probe facts (2026-11-10, re-probed by the truth review): an active member's
write key may `DELETE` another user's live task (204) and `PATCH`-restore it (200), the tasks
`deleteRule` and `updateRule` admitting any active non-viewer member
(`schema/tasks.rules.json`); and restoring a trashed task whose project is also trashed reaches
the restore guard in `pb_hooks/trash.pb.js` and answers 400 `Cannot restore: the parent project
is in the trash or no longer exists.`, not 404.

Alternatives rejected: trying `PATCH` on each of the four collections in turn (up to four writes,
and a `PATCH` on a live item bumps `updated`, room probe); taking a `kind` argument (more input
for the agent to get wrong, when one read answers it).

Refusing a live item in `tm_restore` rather than answering it unchanged keeps the pair
symmetric and writes nothing; Linear restores a deleted issue from "Recently deleted issues"
(https://linear.app/docs/delete-archive-issues, fetched 2026-11-10: "open your team's archives,
select **Recently deleted issues**, select the issue, then press `#` to restore it").

### D5. The client's own refusals are usage refusals

"Already in the trash", "not in the trash", "only tasks can be followed" and "in the trash" for
subscribe are thrown as `UsageError` (`clients/tm/src/api.ts`), as `comment` throws "milestones do
not take comments" today. They reach MCP as AC-13 `invalid_arguments` with `status: null` and the
CLI as exit 2 with the usage text. Alternative rejected: a new error class with exit 1, which
would add a third CLI exit path and an AC-13 code the hosted contract does not define.

### D5a. Empty ids

A verb given an empty `id` or `workspace` (the schemas accept `""`, and so does `tm workspace ""`)
throws `UsageError("missing <id>")` or `UsageError("missing <workspace>")` as its first line,
before any request: `record_url(..., "")` would otherwise request a collection list. This applies
to `workspace`, `trash`, `delete_item`, `restore` and `subscribe`. `notifications` and
`mark_read` take the workspace as optional, so for them only an explicitly empty value is
refused (`if (workspace === "") throw new UsageError("missing <workspace>")`): `request` drops an
empty query value, so `""` would otherwise widen `mark_read` to every workspace.

### D6. `request` accepts an empty 204

In Phase 2, where unsubscribing first sends a `DELETE`. `DELETE` answers 204 with no body (room probe), which `request` refuses today ("did not answer as
the API does"). `request` returns `undefined` for a 204 before parsing; every other empty or
non-JSON 2xx stays refused. The `shortcut:` comment in `api` that names this gap is deleted.

### D7. Reading every page

`tm_workspace` and `tm_show`'s comments read whole lists. PocketBase's default page is 30 (room
probe: `projects` answered `perPage: 30`); `perPage=500` is honoured (room probe). A helper
`all_pages` asks for 500 at a time with `skipTotal=1` and stops at the first short page. Pages of
`tm_list`, `tm_notifications` and `tm_trash` stay one page per call, with the existing
`limit`/`page` inputs (default 50, page 1), as `tm_list` does.

### D8. `tm_workspace` shape

Compact rows with the ids an edit takes, not full records, because an agent's context is the
budget (Anthropic, "Writing effective tools for agents", cited in the proposal). Fields per
contract. Choices settled:

- Members come from `workspace_members` (`expand=user`). The owner holds a membership row with
  role `admin` (room probe), so `role` is rewritten to `owner` for the row whose user is the
  workspace's `owner`; if no row has that user, an owner entry is put first from the workspace's
  `expand.owner`. Suspended rows are kept with their `status`, as `/api/tracker/me` keeps them.
- No email: the API shows a user's email only to that user (room probe: under Alice's key only
  her own row's expanded user had `email`), so including it would make the answer differ by
  caller for no use.
- Projects are filtered `trashed = ""`: the `projects` list rule lets an owner or admin read
  trashed projects (`schema/projects.rules.json` `listRule`), which an edit cannot target.
- `priorities` is the workspace record's `priorities` (`[{id, name}]`, room probe), which
  `tasks.priority` takes.
- 404 on the workspace read becomes `no workspace <id> that you can read`, mirroring the item
  message; the five lists start only after it succeeds.

Linear keeps one read tool per vocabulary (proposal, Prior art); ruled out by Open Question 3.

### D9. Notifications

Rows are the server's `notifications` records verbatim, filter and sort per contract. Unread
first, newest first: Linear's inbox offers "**Show unread first**"
(https://linear.app/docs/inbox, fetched 2026-11-10). The workspace filter includes rows tied to no
workspace, because that is the set `POST /api/tracker/notifications/read-all?workspace=` marks
(`openapi.json`: "Marks only that workspace's notifications and those tied to no workspace"), so
listing and clearing one workspace cover the same rows. `dismissed` and `snoozed_until` are not
filtered: `unread_notifications` in `/api/tracker/me` counts every row the list rule shows
(`openapi.json` `/api/tracker/me`), and the list must agree with that count.

### D10. Subscribe

`task_subscribers` holds one row per task and user (unique index `idx_task_subscribers_pair`);
creating a task and commenting on one already subscribe the author (room probe), so a blind
`POST` usually answers 400 `validation_not_unique`. The verb reads first, writes at most once, and
treats a 400 whose `data.task.code` is `validation_not_unique` on the `POST` as already following
(a concurrent call won) and a 404 on the `DELETE` as already not following. The caller's user id
comes from `GET /api/tracker/me` (`user.id`); a key cannot read `api_keys` to learn it. A trashed
task is refused before the write, since the create rule needs `task.trashed = ""`
(`schema/task_subscribers.rules.json`) and would answer an opaque "Failed to create record.".
Linear subscribes and unsubscribes with one toggle per issue (https://linear.app/docs/notifications,
fetched 2026-11-10: "press `Shift` `S` to subscribe or `Cmd/Ctrl` `Shift` `S` to unsubscribe");
here one tool with `follow` (default true). CLI: `--off`.

### D11. `tm_show` comments

All comments, oldest first (`sort=created,id`), as raw `comments` records; a milestone gets `[]`
with no request. The comments read uses the `{kind}` relation field (`task`, `document`,
`decision`) of `comments` (`schema/comments.json`). If the item read itself fails, comments are
not read.

### D12. Names and module layout

Function names in `verbs.ts`: `me`, `workspace`, `notifications`, `trash`, `delete_item`
(`delete` is a reserved word), `restore`, `subscribe`, `mark_read`, plus exported `all_pages` (the suite imports it)
and internal `item_row` and `workspace_404`. CLI verb names per contract. New tests live in a new suite
`tests/test_tm_verbs.ts` (default port 8240, a default no suite uses today; `scripts/check_port_collisions.ts` gates it) so
the edits to `tests/test_tm_cli.ts` and `tests/test_tm_mcp.ts`, which `hosted-mcp-endpoint` and
`key-minting-cli` also edit, stay limited to the repairs named below.

### D13. Smoke

`e2e/smoke.ts` gains `probe_tm_verbs`, placed in `PROBES` immediately before
`probe_forged_client_address` (the first of the rate-limit probes). The production image
enables superuser MFA (`v2:1785185400_superuser_mfa.js`); a spike on 2026-11-10
(`docker compose ... exec -T pocketbase /pb/pocketbase superuser create ...`, then
`auth-with-password` → 401 `{mfaId}`, then `superuser otp` printing `Id:` and `Pass:`, then
`auth-with-otp` → 200) obtained a superuser token in the container, and `tm list --json` ran
against it with a minted key. Alice's token comes from superuser impersonation, not her own
password sign-in, so the probe spends none of the `users/auth-with-password` rule's 10 per minute
that `probe_forged_client_address` counts on, and the superuser's user create is exempt from the
5 per minute signup rule. Both were proven in a room (Risks R5); no document states the
exemption for that rule.

## Depends on

- `hosted-mcp-endpoint` (contract read at commit c89336a on its lane), contract sections "tools/list" (the scope filter in `tm mcp`, reading
  `GET /api/tracker/me`), "tools/call" (AC-13 failure shape, `invalid_arguments` for a thrown
  `UsageError`, `-32602` for an unknown tool) and "`GET /api/tracker/me` under a key" (`key`
  object). Its design is final at commit a631d7c (D11 the catalog module, D19 the fixed names,
  Phase 5 `tm mcp` on SDK v2, Phase 6 the MCP service). Check: on main,
  `grep -n "export function error_result\|export function tools_for\|export type Scope" clients/tm/src/mcp.ts`
  finds the AC-13 builder and the scope filter, `GET /api/tracker/me` under a key returns `key.scope`, and
  `grep -n client_id clients/tm/src/api.generated.ts` finds the `key` object in the
  `GET /api/tracker/me` response type (that change regenerated the client).
- `TOOLS: ToolDef[]` with `run(cfg, args)` stays exported from `clients/tm/src/mcp.ts` (D11:
  "`TOOLS` (unchanged content)"), with the local `ToolDef` and `ToolResult` types of D11 and the
  shared `ID`, `KIND`, `FIELDS`, `PROJECT` and `WORKSPACE` constants unchanged. Check:
  `grep -n "export const TOOLS\|^type ToolDef" clients/tm/src/mcp.ts`.
- Its tests: `tests/test_tm_mcp.ts` gains `list_read_key` and `list_write_key`, which derive the
  expected names from `TOOLS` (never a hard-coded list), and keeps its older exact checks ("the
  six verbs, each as tm_<verb>", "agent lists the tools", the "destructiveHint false" loop),
  which Phase 1 repairs. `tests/test_mcp_service.ts` (new there) derives its tool lists from
  `TOOLS` the same way, so it needs no repair, and joins this change's gates because it serves
  the catalog. Suites keep importing the MCP *client* from `@modelcontextprotocol/sdk` 1.32.2
  (root `devDependencies`), as `tests/test_tm_mcp.ts` does.
- Its smoke text: Phase 8 there makes `e2e/README.md` say a key cannot be minted against the
  production image, so keyed paths stay battery-only. This change's smoke spike minted one
  (superuser `otp` from the CLI, D13), so Phase 4 here corrects that sentence.
- `key-scoping` (read at `lane/d-scoping` 0d3232c): its narrower `/me` and server-side limits
  pass through. Its key levels `read` < `write` < `manage` < `own` (stored in `scope`) mean a
  `write` key's second `DELETE` answers 403 `api_key_scope`, so only a `manage` or `own` key
  can purge; Phase 3's purge check uses a `manage` key. Check:
  `grep -n '"manage"' schema/api_keys.json` finds the level.
- `key-minting-cli` (read at `lane/d-minting` b205abc): edits the same CLI files; nothing of
  its is required.
- `tm-distribution` (read at `lane/d-dist` c5c62d5): `tests/test_tm_package.ts` (runs the packed
  client under Node and Bun, per-runtime cases numbered 6 to 14 with 12a to 12d). Phases 1 to 3
  add per-runtime case `12e` to that suite. The package version is not changed here; root files
  a follow-up card to version and publish `@hsb3/tm` with these verbs after tm-distribution's
  first release. Check: `ls tests/test_tm_package.ts clients/tm/build.ts`.
- Shared files also edited by earlier changes in the build order: `clients/tm/tm.ts`
  (`key-minting-cli`: `login`, `logout`, `keys`; `tm-distribution`: `read_secret`, version),
  `clients/tm/src/mcp.ts` and `tests/test_tm_mcp.ts` (`hosted-mcp-endpoint`),
  `clients/tm/src/api.ts` (`tm-distribution`: `User-Agent`), `tests/test_tm_cli.ts`
  (`key-minting-cli`), `clients/tm/README.md` (all three), `e2e/smoke.ts`,
  `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md` and
  `docs/readiness/agent-clients.md` (any change adding a suite, probe or verdict). Edits below are
  stated by symbol and anchor text, not line number, so they apply over those changes.
- Build order (root ruling 1, 2026-11-10): hosted-mcp-endpoint (Phases 1-9, then its root-run
  runbook) -> key-scoping Phase 1, then Phases 2-6 as one PR, then Phase 7 as the next PR, all
  before key-minting-cli starts -> key-minting-cli -> tm-distribution -> agent-verb-coverage ->
  api-versioning-policy last (slot 6).
  Every change named above is on main before Phase 1 starts.
- `api-versioning-policy`: This change is built before api-versioning-policy, so it cuts no API
  release and edits no `api/` file or `mcp-tools.json`. If `scripts/release_api.ts` exists when
  a phase starts, the build order was changed: stop and report.

## Implementation Plan

Shared test fixture (all phases), at the top of `tests/test_tm_verbs.ts`, written in P1 and
extended later: clean room on `8240 + PB_PORT_OFFSET` exactly as `tests/test_tm_mcp.ts` boots
(scratch copies, `superuser_mfa.js` removed, `superuser upsert` before `roomkit.serve`, stop in
`finally`); the `check`, `api`, `connect`, `call` helpers copied from `tests/test_tm_mcp.ts` and
`tm` from `tests/test_tm_cli.ts` (both use `process.execPath`, never a `bun` on `PATH`). `call`
also returns `sc: r.structuredContent?.error ?? null` (the `Called` type gains `sc: any`); the
`Run` type is copied with `tm`. Right after superuser sign-in:
`check("rate limiter disabled for the run", (await api("PATCH", "/api/settings", su, { rateLimits: { enabled: false } }))[0], 200)`,
as `tests/test_scale_membership.ts` does: the suite sends more than the 300 requests per minute
the `/api/` rule allows (`v2:1785185100_settings.js`). Users are created and signed in exactly as
`tests/test_tm_mcp.ts` creates and signs in Alice (`alice@example.com`, `test123456`, name
`Alice`; `bob@example.com`, `test123456`, name `Bob`), their tokens `alice` and `bob`; `P` is the
first project with `name != ''` and `WS` its `workspace`, found as `tests/test_tm_mcp.ts` finds
them; keys are minted as it mints them (`{name, scope}` under the user's token). Users: Alice
(verified, approved;
provisioned workspace `WS` and project `P`), Bob (verified, approved; superuser creates a
`workspace_members` row `{workspace: WS, user: bob, role: "member", status: "active"}`).
Keys: `AW` Alice write, `AR` Alice read, `BW` Bob write; CLI env objects
`const AWE = {TM_URL: BASE_URL, TM_API_KEY: AW}` and likewise `ARE`, `BWE`, passed as the second
argument of every CLI test's `tm(...)`. MCP clients `aw`, `ar`, `bw` connected
with `{HOME: S, TM_URL, TM_API_KEY}`. `tm` is copied with its `TM` constant and an
`XDG = path.join(S, "xdg")` directory created beside `DATA_DIR`, as in `tests/test_tm_cli.ts`.
Header comment: "tm verbs beyond the six (clients/tm): catalog and hints, me, workspace, inbox,
follow, comments on show, trash, delete, restore, by CLI and MCP. Fully self-contained
clean-room server. Port 8240 + PB_PORT_OFFSET."

### Phase 1: plumbing, annotations, `me` and `workspace`

- **Goal**: an agent can orient itself, and every tool states every hint (AC-10, contract
  "MCP tools" for the existing six plus `tm_me`, `tm_workspace`).
- **Files**:
  - modify `clients/tm/src/verbs.ts`
  - modify `clients/tm/src/mcp.ts`
  - modify `clients/tm/tm.ts`
  - create `tests/test_tm_verbs.ts`
  - modify `tests/test_tm_mcp.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `.agents/rules/ports.md`
  - modify `tests/test_tm_package.ts`
- **Steps**:
  - `verbs.ts` (in every phase: each new function's `cfg` is `cfg: Config` and each id or
    workspace parameter `string`; each generated type is added as `type X` inside the existing
    `./api.generated.ts` import block, since `verbatimModuleSyntax` is on):
    - Add `const PAGE_SIZE = 500;` and
      `export async function all_pages<T>(cfg: Config, collection: string, query: Record<string, string>, per_page = PAGE_SIZE): Promise<T[]>`:
      loop `page = 1, 2, ...`; each `request<{ items: T[] }>(cfg, "GET", `/api/collections/${collection}/records`, { ...query, perPage: per_page, page, skipTotal: 1 })`;
      append `items`; return when `items.length < per_page`.
    - Add `async function item_row(cfg, id): Promise<ProjectItemsRecord>` holding today's body
      of `kind_of` (the GET and the 404 → `no item ${id} that you can read` rewrite);
      `kind_of` becomes `(await item_row(cfg, id)).type as Kind`.
    - Add `async function workspace_404<T>(id: string, p: Promise<T>): Promise<T>`: on an
      `ApiError` with `body.status === 404` rethrow `new ApiError({ ...e.body, message: `no workspace ${id} that you can read` })`; else rethrow.
    - Add `export type Me = Paths["GET /api/tracker/me"]["response"];` and
      `export async function me(cfg: Config): Promise<Me>` returning
      `api(cfg, "GET /api/tracker/me", {})`.
    - Add `export type WorkspaceView` (fields per contract) and
      `export async function workspace(cfg: Config, id: string): Promise<WorkspaceView>`:
      0. `if (!id) throw new UsageError("missing <workspace>");`
      1. `ws = await workspace_404(id, request<WorkspacesRecord & { expand?: { owner?: UsersRecord } }>(cfg, "GET", record_url("workspaces", id), { expand: "owner" }))`.
      2. `const f = `workspace = ${JSON.stringify(id)}``; then `Promise.all` of `all_pages`
         on `projects` `{ filter: `${f} && trashed = ""`, sort: "name,id" }`, `statuses`
         `{ filter: f, sort: "position,id" }`, `labels` `{ filter: f, sort: "name,id" }`,
         `cycles` `{ filter: f, sort: "starts_on,id" }`, `workspace_members`
         `{ filter: f, sort: "created,id", expand: "user" }`.
      3. Map: projects `{id, key, name}`; statuses `{id, name, category, position, is_default}`;
         labels `{id, name, project}`; cycles `{id, name, starts_on, ends_on}`; members
         `{user: m.user, name: m.expand?.user?.name ?? "", role: m.user === ws.owner ? "owner" : m.role, status: m.status}`;
         if no member has `user === ws.owner`, unshift
         `{user: ws.owner, name: ws.expand?.owner?.name ?? "", role: "owner", status: "active"}`.
      4. Return `{ id: ws.id, name: ws.name ?? "", owner: ws.owner ?? "", priorities, projects, statuses, labels, cycles, members }`.
      Types: `all_pages<ProjectsRecord>`, `<StatusesRecord>`, `<LabelsRecord>`, `<CyclesRecord>`
      and `<WorkspaceMembersRecord & { expand?: { user?: UsersRecord } }>`; the workspace read
      is typed `WorkspacesRecord & { expand?: { owner?: UsersRecord } }`; `priorities` is
      `Array.isArray(ws.priorities) ? (ws.priorities as { id: string; name: string }[]) : []`.
      `WorkspaceView` is `{ id: string; name: string; owner: string; priorities: { id: string; name: string }[]; projects: { id: string; key: string; name: string }[]; statuses: { id: string; name: string; category: string; position: number; is_default: boolean }[]; labels: { id: string; name: string; project: string }[]; cycles: { id: string; name: string; starts_on: string; ends_on: string }[]; members: { user: string; name: string; role: string; status: string }[] }`;
      a field the generated type marks optional is read with `?? ""` (strings), `?? 0`
      (`position`) or `?? false` (`is_default`). Import every type named here from
      `./api.generated.ts`.
  - `mcp.ts`:
    - In the local `type ToolDef`, add `openWorldHint: boolean` to `annotations` (D3).
    - Add `READ` and `write(destructive, idempotent)` (D3). Lift `tm_list`'s `limit` and
      `page` schemas into `const LIMIT` and `const PAGE` unchanged and use them in `tm_list`.
    - Set annotations: `tm_list`, `tm_show`, `tm_search` → `READ`; `tm_create` →
      `write(false, false)`; `tm_edit` → `write(true, true)`; `tm_comment` → `write(false, false)`.
    - Append, after `tm_comment`:
      - `tm_me`: description "Who the key acts for: the user, every workspace the key reaches
        with its role, status, counts and what the role may do there, the unread notification
        count, and the key's own scope (read or write). Call first to learn workspace ids.";
        `inputSchema: { type: "object", properties: {} }`; `READ`; `run: (cfg) => verbs.me(cfg)`.
      - `tm_workspace`: description "One workspace's vocabulary with the ids edits take: its
        priorities, live projects, statuses (with category), labels, cycles and members (with
        role). Use the ids in tm_create and tm_edit fields such as status, labels, cycle,
        priority and assignee. Needs the workspace id from tm_me."; properties
        `{ workspace: WORKSPACE }`, required `["workspace"]`; `READ`;
        `run: (cfg, a) => verbs.workspace(cfg, a.workspace)`.
    - Update the comment above `TOOLS` to "The catalog: one record per verb, every hint stated."
  - `tm.ts`:
    - `HELP`: insert after the `comment` line the `me` and `workspace` lines of the contract's
      CLI block, verbatim.
    - `NEEDS`: add `me: [0, ""]`, `workspace: [1, "<workspace>"]`.
    - `switch`: `case "me": data = await verbs.me(cfg); break;` and
      `case "workspace": data = await verbs.workspace(cfg, rest[0]); break;`.
    - `print_human`: branches for `me` and `workspace` printing exactly the contract's
      formats with the existing `pad`.
  - `tests/test_tm_mcp.ts` (repair; the exact catalog and hints move to `tests/test_tm_verbs.ts`):
    - `check("the six verbs, each as tm_<verb>", Object.keys(tools).sort(), [...six])` becomes
      `check("the original six verbs are listed", SIX.every((n) => Object.keys(tools).includes(n)), true)`
      with `const SIX = ["tm_list","tm_show","tm_search","tm_create","tm_edit","tm_comment"];`
      declared above it.
    - `check("agent lists the tools", names.length, 6)` becomes
      `check("agent lists the original six tools", SIX.every((n) => names.includes(n)), true)`.
    - The loop whose label is "`${name}` is a write tool, destructiveHint false" runs over
      `["tm_create", "tm_comment"]` only.
    - `list_read_key` and `list_write_key` (added by `hosted-mcp-endpoint`) derive their
      expected names from `TOOLS` and are left as they are.
    - Header comment "lists the six tools with their hints" becomes "lists the tools with their
      hints"; the section title "tools/list: six tools, read tools readOnlyHint, write tools not
      destructive" becomes "tools/list: the original six present, read tools readOnlyHint".
  - `scripts/run_suite_battery.sh`: add `run_suite "test_tm_verbs"           bun tests/test_tm_verbs.ts`
    as a new line directly after the last line of the file that begins `run_suite "`.
  - `scripts/battery_shards.tsv`: add `<shard>\t<seconds>\ttest_tm_verbs` where `<seconds>` is
    the suite's measured wall time (`time bun tests/test_tm_verbs.ts`, rounded up) and
    `<shard>` the shard whose seconds total is lowest at build time, the row placed in the
    file's seconds-descending order (the file's header rule).
  - `.agents/rules/ports.md`: in the Defaults paragraph's suite list, insert ` · 8240 =
    test_tm_verbs` immediately before ` · 9700 = test_script_help` (no earlier change edits that
    entry; `scripts/check_port_collisions.ts` does not check order).
  - `tests/test_tm_package.ts` (tm-distribution's suite; the bundle runs under Node, so a
    Bun-only call in the new code fails here): after per-runtime case `12d`, add
    `12e. <label>: me and workspace under the runtime` (write key, room URL): `me --json` →
    exit 0, JSON `key.scope` `write`; with `WSID` the `id` of its `workspaces` entry whose
    `role` is `owner`, `workspace WSID --json` → exit 0, JSON `id` `WSID` and `statuses` a
    non-empty array. Case 14 already derives its names from `tools_for("write")` and is left as
    it is. The bundle is rebuilt by the suite itself, as its earlier cases need.
- **Tests** (`tests/test_tm_verbs.ts`, each a `check` with this label; watched failing before
  `verbs.ts` and `mcp.ts` change: the catalog, annotation, `tm_me` and `tm_workspace` checks):
  - "catalog names in order": `aw.listTools()` names equal
    `["tm_list","tm_show","tm_search","tm_create","tm_edit","tm_comment","tm_me","tm_workspace"]`.
  - "every tool states every hint": for each listed tool, `annotations` deep-equals its row of
    an `EXPECTED_HINTS` table in the suite holding the contract's annotation column.
  - "read key lists only read tools": `ar.listTools()` names equal
    `["tm_list","tm_show","tm_search","tm_me","tm_workspace"]` (needs `hosted-mcp-endpoint`'s
    filter).
  - "tm_me under the write key": `call(aw,"tm_me",{})` → `isError` false, `json.user.id` Alice's
    id, `json.workspaces` has `{id: WS, role: "owner"}`, `json.key.scope` `"write"`.
  - "tm_me under the read key": `json.key.scope` `"read"`.
  - "tm_workspace lists the vocabulary": `call(aw,"tm_workspace",{workspace: WS})` →
    `json.id` WS; `json.projects` contains `{id: P, key, name}` with P's key and name from the
    API; `json.statuses` equals the API's statuses for WS read with `sort=position,id`, mapped to the five
    fields; `json.labels` equals the API's labels for WS sorted `name,id` mapped to
    `{id, name, project}`; `json.priorities` equals the workspace record's.
  - "tm_workspace members": Alice's entry has `role: "owner"`, Bob's `role: "member",
    status: "active"`; no entry has an `email` key; Alice appears once.
  - "tm_workspace leaves out trashed projects": create project P9 (`api("POST", "/api/collections/projects/records", alice, {name: "p9", workspace: WS})`), DELETE it (`alice`),
    then `tm_workspace` → no project with P9's id.
  - "tm_workspace reads past the default page": create 31 projects in WS with `alice` (`{name: "pg-00"` to `"pg-30", workspace: WS}`), then `tm_workspace` → all 31 ids present (PocketBase's default page
    is 30).
  - "all_pages pages": import `all_pages` from `../clients/tm/src/verbs.ts` and call it with
    `{url: BASE_URL, key: AW}`, `"statuses"`, `{filter: `workspace="${WS}"`, sort: "position,id"}`,
    `per_page` 2 → equal to the same list read with `perPage=500`.
  - "tm_workspace unknown id": `{workspace: "nope00000000000"}` → `isError` true, `sc.status`
    404, `sc.message` includes `nope00000000000`.
  - "tm_workspace for a workspace not mine": Bob's provisioned workspace id (from Bob's
    `tm_me` under `BW`, the entry with `role: "owner"`) called under `AW` → `sc.status` 404.
  - "tm_workspace without workspace": `{}` → `isError` true, `sc.code` `invalid_arguments`.
  - "tm_workspace with an empty workspace": `{workspace: ""}` → `sc.code` `invalid_arguments`,
    `sc.message` `missing <workspace>`.
  - CLI "tm me --json equals tm_me": `tm(["me","--json"], AWE)` → code 0,
    `json` deep-equals the `tm_me` result.
  - CLI "tm me human": code 0; stdout's first line is `Alice (<alice id>)`; a line starts with
    `key` and contains `write`; a line starts with `${WS}  owner`.
  - CLI "tm workspace --json equals tm_workspace": same comparison.
  - CLI "tm workspace human": stdout has lines `statuses` and `members` and a line starting
    `  ${P}  ` .
  - CLI "tm workspace missing arg": `tm(["workspace"], AWE)` → code 2, stderr includes
    `missing <workspace>`.
- **Gate**: with `OFFSET` the builder's assigned `PB_PORT_OFFSET` (200 or more, AGENTS.md
  clean-room law): `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_verbs.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_mcp.ts`, `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_cli.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_mcp_service.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_package.ts` (needs `node` 22.18 or later on `PATH`,
  as that suite does; it prints the Node version it ran) and `PB_PORT_OFFSET=$OFFSET make
  check-static`, each run alone, one after another, exit 0.

### Phase 2: inbox, follow, comments on show

- **Goal**: an agent can read and clear its inbox, follow a task, and read an item's discussion
  (AC-10; contract rows `tm_notifications`, `tm_mark_read`, `tm_subscribe`, `tm_show`).
- **Files**:
  - modify `clients/tm/src/api.ts`
  - modify `clients/tm/src/verbs.ts`
  - modify `clients/tm/src/mcp.ts`
  - modify `clients/tm/tm.ts`
  - modify `tests/test_tm_verbs.ts`
  - modify `tests/test_tm_package.ts`
- **Steps**:
  - `api.ts`: in `request`, immediately after `const text = await r.text();` add
    `if (r.status === 204) return undefined as T;`. In `api`, delete the line beginning
    `// shortcut: request() refuses an empty answer`.
  - `verbs.ts`:
    - Import `NotificationsRecord`, `NotificationsListResult`, `TaskSubscribersListResult` and
      `CommentsRecord` from `./api.generated.ts`.
    - `export type NotificationFilter = { workspace?: string; unread?: boolean; limit?: number; page?: number };`
      `export async function notifications(cfg, f: NotificationFilter = {}): Promise<NotificationsRecord[]>`:
      first `if (f.workspace === "") throw new UsageError("missing <workspace>")`; clauses `[f.unread && "read = false", f.workspace && `(workspace = ${JSON.stringify(f.workspace)} || workspace = "")`].filter(Boolean).join(" && ")`;
      `request<NotificationsListResult>(cfg, "GET", "/api/collections/notifications/records", { filter, sort: "read,-created,id", perPage: f.limit ?? 50, page: f.page ?? 1, skipTotal: 1 })`;
      return `items`.
    - `export async function mark_read(cfg, workspace?: string): Promise<{ updated: number }>`:
      first `if (workspace === "") throw new UsageError("missing <workspace>")`;
      `api(cfg, "POST /api/tracker/notifications/read-all", { query: { workspace } })`
      (`request` already drops an undefined or empty query value).
    - `export async function subscribe(cfg, id: string, follow = true): Promise<{ task: string; following: boolean }>`:
      0. `if (!id) throw new UsageError("missing <id>");`
      1. `row = await item_row(cfg, id)`; `row.type !== "task"` → `UsageError(`only tasks can be followed; ${id} is a ${row.type}`)`;
         `row.trashed` non-empty → `UsageError(`item ${id} is in the trash; restore it first`)`.
      2. `uid = (await me(cfg)).user.id`.
      3. `found = (await request<TaskSubscribersListResult>(cfg, "GET", "/api/collections/task_subscribers/records", { filter: `task = ${JSON.stringify(id)} && user = ${JSON.stringify(uid)}`, perPage: 1, skipTotal: 1 })).items[0]`.
      4. `follow && !found`: `POST /api/collections/task_subscribers/records` `{task: id, user: uid}`;
         catch `e` where `e instanceof ApiError && e.body.status === 400 && (e.body.data.task as { code?: string } | undefined)?.code === "validation_not_unique"` → fall through; else rethrow (`data` is typed `Record<string, unknown>`).
         `!follow && found`: `DELETE record_url("task_subscribers", found.id)`; catch `ApiError`
         with `body.status === 404` → fall through; else rethrow.
      5. Return `{ task: id, following: follow }`.
    - `show`: `const kind = await kind_of(cfg, id); const record = await request(cfg, "GET", record_url(collection_of(kind), id));` then `const comments = kind === "milestone" ? [] : await all_pages<CommentsRecord>(cfg, "comments", { filter: `${kind} = ${JSON.stringify(id)}`, sort: "created,id" })`;
      return `{ ...with_kind(kind, record), comments }`. Its return type becomes
      `Item & { comments: CommentsRecord[] }`.
  - `mcp.ts`, appended after `tm_workspace` in this order:
    - `tm_notifications`: description "The key's inbox, unread first then newest first, a page
      at a time. unread true returns only unread ones; workspace narrows to one workspace plus
      notifications tied to none. Each row names its kind (assigned, commented, status_done,
      mentioned, ownership_transferred) and the task, document or decision it is about.";
      properties `{ workspace: WORKSPACE, unread: { type: "boolean", description: "Only unread notifications (default false)." }, limit: LIMIT, page: PAGE }`;
      `READ`; `run: (cfg, a) => verbs.notifications(cfg, a)`.
    - `tm_subscribe`: description "Follow a task, so its comments and changes reach the
      inbox, or stop following it with follow false. Needs a task id and a write key. Asking
      for the state already held changes nothing. Returns the task and whether the key's user
      now follows it."; properties `{ id: ID, follow: { type: "boolean", description: "true (the default) to follow, false to stop following." } }`,
      required `["id"]`; `write(true, true)`; `run: (cfg, a) => verbs.subscribe(cfg, a.id, a.follow ?? true)`.
    - `tm_mark_read`: description "Mark the key's unread notifications read, optionally only
      one workspace's (plus those tied to none). Needs a write key. Returns how many were
      marked."; properties `{ workspace: WORKSPACE }`; `write(true, true)`;
      `run: (cfg, a) => verbs.mark_read(cfg, a.workspace)`.
    - `tm_show` description becomes "Show one item in full by its id, with the kind it is and
      every comment on it, oldest first (a milestone has none). Needs the id."
  - `tm.ts`:
    - `OPTIONS`: add `unread: { type: "boolean", default: false }`, `off: { type: "boolean", default: false }`.
    - `HELP`: insert the contract's `notifications`, `subscribe` and `mark-read` lines in
      contract order after `workspace` (so `trash`, `delete`, `restore` slot in later).
    - `NEEDS`: `notifications: [0, ""]`, `subscribe: [1, "<id>"]`, `"mark-read": [0, ""]`.
    - `switch`: `notifications` → `verbs.notifications(cfg, { workspace: v.workspace, unread: v.unread || undefined, limit, page })`;
      `subscribe` → `verbs.subscribe(cfg, rest[0], !v.off)`; `mark-read` →
      `verbs.mark_read(cfg, v.workspace)`.
    - `print_human`: `notifications`, `subscribe`, `mark-read` per contract; `show` prints the
      record without `comments` through the existing default branch, then one
      `comment <created> <author>: <body>` line per comment.
  - `tests/test_tm_package.ts`: per-runtime case `12e` gains, after its workspace call:
    `notifications --json` → exit 0, stdout parses to an array; `subscribe <a task id from
    create "pkg <label> follow" --project <PROJECT> --json> --off --json` → exit 0, JSON
    `following` `false` (the creator was subscribed, so this sends the `DELETE` whose empty 204
    must parse under Node).
- **Tests** (`tests/test_tm_verbs.ts`, run in the order listed, since later checks build on
  earlier state; watched failing before code: every check below):
  - Fixture: with `alice`, `api("POST", ...)` creates T1 `tasks {title: "t1", project: P}`, D1
    `documents {title: "d1", workspace: WS}` and M1 `milestones {name: "m1", project: P}`; with
    `bob`, comments `{task: T1, body: "first"}`, then `{task: T1, body: "second"}`, then
    `{document: D1, body: "on d1"}`.
  - "catalog names in order" extended to
    `[...six, "tm_me","tm_workspace","tm_notifications","tm_subscribe","tm_mark_read"]`;
    "every tool states every hint" covers the new three; "read key lists only read tools" adds
    `tm_notifications`.
  - "tm_show carries comments oldest first": `call(aw,"tm_show",{id: T1})` → `json.comments`
    bodies `["first","second"]`.
  - "tm_show on a document carries its comment": D1 → one comment, body as posted.
  - "tm_show on a milestone": M1 → `json.comments` `[]`.
  - "tm_notifications unread first": `call(aw,"tm_notifications",{unread: true})` → length 2,
    each `kind` `commented`, `task` T1, `read` false, newest first (`created` descending).
  - "tm_notifications workspace filter": `{workspace: WS}` → both rows; `{workspace: <Alice's
    second workspace>}` (created with `api("POST", "/api/collections/workspaces/records", alice, {name: "second"})`)
    → `[]`.
  - "tm_notifications paging": `{limit: 1, page: 2}` → one row, deep-equal to element 1 of
    `call(aw,"tm_notifications",{}).json`.
  - "tm_mark_read under the read key": `call(ar,"tm_mark_read",{})` → `sc.status` 403,
    `sc.code` `api_key_scope`.
  - "tm_mark_read clears": `call(aw,"tm_mark_read",{workspace: WS})` → `json` `{updated: 2}`;
    then `tm_me` → `unread_notifications` 0; then `tm_notifications {}` → both rows, `read`
    true.
  - "tm_mark_read again": `{}` → `{updated: 0}`.
  - "tm_notifications with an empty workspace": `{workspace: ""}` → `sc.code`
    `invalid_arguments`, `sc.message` `missing <workspace>`.
  - "tm_mark_read with an empty workspace": `{workspace: ""}` → `sc.code` `invalid_arguments`,
    `sc.message` `missing <workspace>`.
  - "unread before read": Bob comments `"third"` on T1; `tm_notifications {}` → first row's
    `comment_preview` `third` and `read` false, then the two read rows.
  - "tm_subscribe already following": `call(bw,"tm_subscribe",{id: T1})` → `{task: T1,
    following: true}`; superuser list of `task_subscribers` for T1 and Bob → 1 row.
  - "tm_subscribe off (an empty 204 is accepted)": `call(bw,"tm_subscribe",{id: T1, follow: false})`
    → `isError` false, `json` `{task: T1, following: false}`; rows → 0.
  - "tm_subscribe off again": same → `following: false`, no error.
  - "tm_subscribe on": `{id: T1}` → `following: true`; rows → 1.
  - "tm_subscribe a document": `{id: D1}` → `sc.code` `invalid_arguments`, message includes
    `only tasks`; task_subscribers rows for D1 → none written (superuser list
    `filter=task="${D1}"` → 0).
  - "tm_subscribe under the read key": `call(ar,"tm_subscribe",{id: T1, follow: false})` →
    `sc.status` 403, `sc.code` `api_key_scope`; Alice's row still there.
  - "tm_subscribe a trashed task": Alice creates T8 in P (`api("POST", "/api/collections/tasks/records", alice, {title: "t8", project: P})`)
    and deletes it (`api("DELETE", ...T8, alice)`); `call(aw,"tm_subscribe",{id: T8})` →
    `sc.code` `invalid_arguments`, message includes `in the trash`; then
    `api("PATCH", "/api/collections/tasks/records/${T8}", alice, {trashed: "", trashed_by: ""})`
    restores it, so Phase 3's trash counts hold.
  - CLI "tm notifications --unread --json": `tm(["notifications","--unread","--json"], AWE)`
    → `json` deep-equals `call(aw,"tm_notifications",{unread: true}).json`.
  - CLI "tm notifications human": `tm(["notifications"], AWE)` → a line contains `commented`
    and `${T1}`; `tm(["notifications"], BWE)` → stdout `no notifications` (nothing notifies
    Bob in this fixture: a comment never notifies its own author).
  - CLI "tm mark-read": `tm(["mark-read"], AWE)` → code 0, stdout `marked 1 read` (the third
    comment).
  - CLI "tm subscribe --off": `tm(["subscribe", T1, "--off"], BWE)` → stdout `not following ${T1}`;
    `tm(["subscribe", T1], BWE)` → `following ${T1}`.
  - CLI "tm subscribe missing id": `tm(["subscribe"], AWE)` → code 2, stderr includes `missing <id>`.
  - CLI "tm show human lists comments": `tm(["show", T1], AWE)` → lines starting `comment `
    ending `: first`, `: second`, `: third` in that order.
- **Gate**: with `OFFSET` the builder's assigned `PB_PORT_OFFSET` (200 or more, AGENTS.md
  clean-room law): `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_verbs.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_mcp.ts`, `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_cli.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_mcp_service.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_package.ts` (needs `node` 22.18 or later on `PATH`,
  as that suite does; it prints the Node version it ran) and `PB_PORT_OFFSET=$OFFSET make
  check-static`, each run alone, one after another, exit 0.

### Phase 3: trash, delete, restore

- **Goal**: an agent can list the trash, trash an item without ever purging it, and restore it
  (AC-10; contract rows `tm_trash`, `tm_delete`, `tm_restore`).
- **Files**:
  - modify `clients/tm/src/verbs.ts`
  - modify `clients/tm/src/mcp.ts`
  - modify `clients/tm/tm.ts`
  - modify `tests/test_tm_verbs.ts`
  - modify `tests/test_tm_package.ts`
- **Steps**:
  - `verbs.ts`:
    - `export type TrashRow = { id: string; kind: Kind; key: string; title: string; project: string; trashed: string; trashed_by: string; purge_at: string; purge_days: number };`
      `export type TrashPage = { workspace: string; count: number; page: number; perPage: number; items: TrashRow[] };`
    - `export async function trash(cfg, workspace: string, p: { limit?: number; page?: number } = {}): Promise<TrashPage>`:
      `r = await workspace_404(workspace, api(cfg, "GET /api/tracker/trash", { query: { workspace, perPage: p.limit ?? 50, page: p.page ?? 1 } }))`,
      (first `if (!workspace) throw new UsageError("missing <workspace>")`), cast with
      `as Extract<Paths["GET /api/tracker/trash"]["response"], { page: number }>` (no `group` is
      ever sent, so the grouped arm never answers); map each entry `e` to
      `{ id: e.record.id, kind: e.collection.replace(/s$/, "") as Kind, key: e.record.key ?? "", title: "title" in e.record ? e.record.title : (e.record as MilestonesRecord).name, project: e.record.project ?? "", trashed: e.record.trashed ?? "", trashed_by: e.record.trashed_by ?? "", purge_at: e.purge_at, purge_days: e.purge_days }`;
      return `{ workspace: r.workspace, count: r.count, page: r.page, perPage: r.perPage, items }`.
    - `export async function delete_item(cfg, id: string): Promise<{ id: string; kind: Kind; title: string; trashed: true }>`:
      `if (!id) throw new UsageError("missing <id>")`; `row = await item_row(cfg, id)`; `row.trashed` non-empty →
      `UsageError(`item ${id} is already in the trash; restore brings it back`)`; else
      `await request(cfg, "DELETE", record_url(collection_of(row.type as Kind), id))`; return
      `{ id, kind: row.type as Kind, title: row.title ?? "", trashed: true }`.
    - `export async function restore(cfg, id: string): Promise<Item>`: `if (!id) throw new UsageError("missing <id>")`; `row = await item_row(cfg, id)`; `const kind = row.type as Kind;`;
      `row.trashed` empty → `UsageError(`item ${id} is not in the trash`)`; else return
      `with_kind(kind, await request(cfg, "PATCH", record_url(collection_of(kind), id), {}, { trashed: "", trashed_by: "" }))`.
  - `mcp.ts`: insert `tm_trash` after `tm_notifications`, and `tm_delete`, `tm_restore` after
    it, giving the contract's order:
    - `tm_trash`: description "A workspace's trash: tasks, documents, decisions and
      milestones moved there, newest first, a page at a time, each with when it will be
      purged for good. Pass an id to tm_restore to bring one back. Needs the workspace id.";
      properties `{ workspace: WORKSPACE, limit: LIMIT, page: PAGE }`, required
      `["workspace"]`; `READ`; `run: (cfg, a) => verbs.trash(cfg, a.workspace, a)`.
    - `tm_delete`: description "Move a task, document, decision or milestone to its
      workspace's trash, where tm_restore can bring it back until it is purged. Refuses an
      item already in the trash, and never deletes anything for good. Needs the id and a write
      key."; `{ id: ID }` required `["id"]`; `write(true, true)`;
      `run: (cfg, a) => verbs.delete_item(cfg, a.id)`.
    - `tm_restore`: description "Bring an item back from the trash by its id. Refuses an
      item that is not in the trash, and one whose project is itself in the trash. Needs a
      write key. Returns the item as it now is."; `{ id: ID }` required `["id"]`;
      `write(true, true)`; `run: (cfg, a) => verbs.restore(cfg, a.id)`.
  - `tm.ts`: `HELP` gains the contract's `trash`, `delete`, `restore` lines in contract order;
    `NEEDS` gains `trash: [1, "<workspace>"]`, `delete: [1, "<id>"]`, `restore: [1, "<id>"]`;
    `switch`: `trash` → `verbs.trash(cfg, rest[0], { limit, page })`, `delete` →
    `verbs.delete_item(cfg, rest[0])`, `restore` → `verbs.restore(cfg, rest[0])`;
    `print_human`: `trash` and `delete` per contract; `restore` uses the default branch.
  - `tests/test_tm_package.ts`: per-runtime case `12e` gains, after Phase 2's calls: `create "pkg <label> trash" --project
    <PROJECT> --json` → exit 0, its `id` as `TID`; `delete TID --json` → exit 0, JSON `trashed`
    `true`; `restore TID --json` → exit 0, JSON `trashed` `""`.
- **Tests** (`tests/test_tm_verbs.ts`; watched failing before code: every check below; the
  "never purges" check is also watched failing once against a `delete_item` without the
  `trashed` guard, run with the `manage` key `am` so the unguarded call really purges and the
  superuser read answers 404, then the guard restored):
  - Fixture: `AM`, an Alice key `{name: "manage", scope: "manage"}` (key-scoping level),
    minted as `AW` is; MCP client `am` connected and closed as `aw` is.
  - Fixture, with `alice` through `api("POST", ...)`: T2 `tasks {title: "t2", project: P}`, D2
    `documents {title: "d2", workspace: WS}`, X2 `decisions {title: "x2", project: P}`, M2
    `milestones {name: "m2", project: P}`, P2 `projects {name: "p2", workspace: WS}`, T3
    `tasks {title: "t3", project: P2}`.
  - Catalog checks extended to the full contract list and hints; read-key list adds `tm_trash`.
  - "tm_delete trashes a task": `call(aw,"tm_delete",{id: T2})` → `json` `{id: T2, kind:
    "task", title: <T2's title>, trashed: true}`; then `tm_show T2` → `sc.status` 404.
  - "tm_trash lists it": `call(ar,"tm_trash",{workspace: WS})` → `json.items` has an entry with
    `id` T2, `kind` `task`, `trashed` non-empty, `purge_days` 30; `json.count` ≥ 1.
  - "tm_delete never purges": with the `manage` key (a `write` key's purge is refused by the
    server anyway): `call(am,"tm_delete",{id: T2})` again (a second
    `DELETE` under a `manage` key on Alice's workspace would purge) → `isError` true, `sc.code` `invalid_arguments`, `sc.message`
    includes `already in the trash`; superuser `GET /api/collections/tasks/records/${T2}` →
    200 with `trashed` non-empty.
  - "tm_restore brings it back": `call(aw,"tm_restore",{id: T2})` → `json.trashed` `""`,
    `json.trashed_by` `""`, `json.kind` `task`; `tm_show T2` → not an error.
  - "tm_restore a live item": again → `sc.code` `invalid_arguments`, message includes
    `not in the trash`.
  - "each kind round-trips": for D2, X2, M2: `tm_delete` → `json.kind` the kind; `tm_trash` lists
    it with that kind and (M2) `title` the milestone's name; `tm_restore` → `json.trashed`
    `""`.
  - "tm_restore under a trashed project": `tm_delete T3`; API `DELETE` P2 (AW);
    `tm_restore T3` → `sc.status` 400, `sc.message` includes `Cannot restore`.
  - "tm_delete under the read key": `call(ar,"tm_delete",{id: T2})` → `sc.status` 403,
    `sc.code` `api_key_scope`; T2 still live.
  - "tm_restore under the read key": trash T2 with `aw`, then `call(ar,"tm_restore",{id: T2})`
    → 403 `api_key_scope`; restore it with `aw`.
  - "tm_delete by a member": `call(bw,"tm_delete",{id: T2})` → `json.trashed` true; restore
    with `bw` → not an error.
  - "tm_delete with an empty id": `{id: ""}` → `sc.code` `invalid_arguments`, `sc.message`
    `missing <id>`.
  - "tm_delete unknown id": `{id: "nope00000000000"}` → `sc.status` 404, message includes the id.
  - "tm_trash paging": `tm_delete` T2 and D2 with `aw`; `{workspace: WS, limit: 1, page: 2}`
    → `json.items.length` 1, `json.page` 2, `json.perPage` 1, `json.count` 3 (T2, D2 and T3);
    then `tm_restore` T2 and D2 with `aw`.
  - "tm_trash unknown workspace": `{workspace: "nope00000000000"}` → `sc.status` 404, message
    `no workspace nope00000000000 that you can read`.
  - "tm_trash without workspace": `{}` → `sc.code` `invalid_arguments`.
  - CLI "tm delete": `tm(["delete", T2], AWE)` → code 0, stdout starts `trashed ${T2}`;
    again → code 2, stderr includes `already in the trash`.
  - CLI "tm trash human": first line ends `in the trash`; a line starts `${T2}  task`.
  - CLI "tm trash --json equals tm_trash": `tm(["trash", WS, "--json"], AWE).json` deep-equals
    `call(aw,"tm_trash",{workspace: WS}).json`.
  - CLI "tm restore --json" (T2 is in the trash from CLI "tm delete"): `tm(["restore", T2, "--json"], AWE)`
    → code 0, `json.trashed` `""`.
  - CLI "tm trash missing workspace": `tm(["trash"], AWE)` → code 2, `missing <workspace>`.
- **Gate**: with `OFFSET` the builder's assigned `PB_PORT_OFFSET` (200 or more, AGENTS.md
  clean-room law): `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_verbs.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_mcp.ts`, `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_cli.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_mcp_service.ts`,
  `PB_PORT_OFFSET=$OFFSET bun tests/test_tm_package.ts` (needs `node` 22.18 or later on `PATH`,
  as that suite does; it prints the Node version it ran) and `PB_PORT_OFFSET=$OFFSET make
  check-static`, each run alone, one after another, exit 0.

### Phase 4: smoke probe, docs and readiness

- **Goal**: the verbs are proven against the production image and documented, and AC-10 moves
  to met (readiness `docs/readiness/agent-clients.md` AC-10).
- **Files**:
  - modify `e2e/smoke.ts`
  - modify `e2e/README.md`
  - modify `clients/tm/README.md`
  - modify `clients/tm/package.json`
  - modify `docs/readiness/agent-clients.md`
- **Steps**:
  - `e2e/smoke.ts`: add `async function probe_tm_verbs(): Promise<void>` and put it in
    `PROBES` immediately before `probe_forged_client_address` (after every probe earlier changes
    placed ahead of the rate-limit probes). Steps (each a `check` with the label in quotes):
    1. `run([...COMPOSE, "exec", "-T", "pocketbase", "/pb/pocketbase", "superuser", "create", "smoke@example.com", "smoke-pass-123456", "--dir", "/pb/pb_data", "--migrationsDir", "/pb/pb_migrations"])`
       → "superuser created" code 0.
    2. `post("/api/collections/_superusers/auth-with-password", {identity, password})` →
       "superuser password step asks for MFA" status 401 with `json.mfaId` set.
    3. `run([...COMPOSE, "exec", "-T", "pocketbase", "/pb/pocketbase", "superuser", "otp", "smoke@example.com", "--dir", "/pb/pb_data", "--migrationsDir", "/pb/pb_migrations"])`;
       parse `Id:` and `Pass:` with `/Id:\s*(\S+)/` and `/Pass:\s*(\S+)/`;
       `post("/api/collections/_superusers/auth-with-otp", {otpId, password, mfaId})` →
       "superuser signed in" status 200.
    4. With `Authorization: <superuser token>`: `post("/api/collections/users/records", {email: "agent@example.com", password: "agent-pass-123456", passwordConfirm: "agent-pass-123456", name: "Agent", verified: true, approved: true})`
       → "agent user created" 200; `post(`/api/collections/users/impersonate/${id}`, {duration: 600})`
       → "agent token by impersonation" 200 with `json.token`.
    5. With the agent token: `post("/api/collections/api_keys/records", {name: "smoke", scope: "write"})`
       → "agent write key minted" 200, `json.key` starts `tmk_`.
    6. Every check below is `check(label, <boolean expression>, true)`, except the refusal,
       `check(label, code, 2)`. `ws = me.json.workspaces.find((w: any) => w.role === "owner").id`;
       `p = workspace.json.projects[0].id`. A helper `tm(args)` runs `Bun.spawnSync([process.execPath, path.join(ROOT, "clients/tm/tm.ts"), ...args, "--json"], { env: { ...process.env, TM_URL: BASE_URL, TM_API_KEY: key } })`
       and returns `{code, json}`. Then: `tm me` → "tm me names the agent" `json.user.name`
       `Agent`; take the owned workspace `ws` and, via `tm workspace ws`, the first project
       `p` ("tm workspace lists a project" `projects.length > 0`); `tm create "smoke item"
       --project p` → id; `tm delete id` → "tm delete trashes" `json.trashed` true;
       `tm trash ws` → "tm trash lists it" items contain id; `tm delete id` → "tm delete
       refuses a trashed item" code 2; `tm restore id` → "tm restore brings it back"
       `json.trashed` `""`; `tm subscribe id --off` → "tm subscribe stops following" `json.following` false (the creator
       was subscribed, so this sends the `DELETE` that answers 204); `tm subscribe id` →
       "tm subscribe follows" `json.following` true;
       `tm mark-read` → "tm mark-read answers" code 0.
  - `e2e/README.md`: the sentence `hosted-mcp-endpoint` Phase 8 added saying a key cannot be
    minted against the production image, so keyed paths stay battery-only, is replaced by:
    "`probe_tm_verbs` mints a key against the production image: it creates a superuser in the
    container, completes its MFA with a code from `pocketbase superuser otp`, creates an approved
    user and signs in as that user by impersonation, then runs the `tm` verbs with the user's
    write key." If that sentence is absent, the same text is appended at the end of the file
    under a new heading `## Smoke probe with a key`. In the probe list hosted-mcp-endpoint
    Phase 8 added, append `probe_tm_verbs` as its last entry.
  - `clients/tm/README.md`: first paragraph's verb list becomes "lists, shows, searches,
    creates, edits and comments on ..., trashes and restores them, follows tasks, reads and
    clears the inbox, and describes the key's workspaces"; "Use it" block gains, after the
    `tm comment` line, these lines verbatim (the `#` column aligned as the block's other lines):
    ```
    tm me                                    # who the key acts for, its workspaces and scope
    tm workspace <id>                        # statuses, labels, cycles, projects, members, with ids
    tm notifications --unread                # the inbox, unread only
    tm mark-read                             # mark every notification read
    tm subscribe <id>                        # follow a task
    tm subscribe <id> --off                  # stop following it
    tm delete <id>                           # move an item to the trash
    tm trash <workspace>                     # what is in a workspace's trash
    tm restore <id>                          # bring an item back from the trash
    ```
    "As an MCP server": its tool list in parentheses becomes "(`tm_list`, `tm_show`, `tm_search`,
    `tm_create`, `tm_edit`, `tm_comment`, `tm_me`, `tm_workspace`, `tm_notifications`,
    `tm_trash`, `tm_delete`, `tm_restore`, `tm_subscribe`, `tm_mark_read`)", and in its last
    paragraph only the first sentence (the one beginning "A read key lists only the read
    tools") is replaced, by "A read key lists only the read tools (`tm_list`, `tm_show`,
    `tm_search`, `tm_me`, `tm_workspace`, `tm_notifications`, `tm_trash`); every other key also
    lists `tm_create`, `tm_edit`, `tm_comment`, `tm_subscribe`, `tm_mark_read`, `tm_delete` and
    `tm_restore`. No tool deletes anything for good."; the paragraph's later sentences (the
    failed-call JSON shape) stay. If no sentence begins "A read key lists only the read tools",
    that new text is appended as the section's last paragraph. In "Set up once", the phrase "a
    write key can also create, edit and comment" becomes "a write key can also create, edit,
    comment, follow, mark read, trash and restore" if present; otherwise the sentence "A read key
    can only read; a write key can also create, edit, comment, follow, mark read, trash and
    restore." is appended at the end of that section; "that id is what `show`, `edit` and `comment` take" becomes "that id is
    what `show`, `edit`, `comment`, `subscribe`, `delete` and `restore` take"; and a paragraph
    directly after the closing fence of the "Use it" code block:
    "`delete` moves an item to the trash and refuses one already there, so it never removes
    anything for good; `restore` brings it back."
  - `clients/tm/package.json` `description` (the `version` stays as it is): "Command-line client and MCP server for the task
    tracker: find, read, create, edit, comment on, trash and restore items, follow tasks and
    clear the inbox, with an API key."
  - `docs/readiness/agent-clients.md` AC-10: `Verdict: met.`; Evidence: "`bun
    tests/test_tm_verbs.ts` (port 8240): the catalog, its hints, `tm_me`, `tm_workspace`,
    `tm_notifications`, `tm_mark_read`, `tm_subscribe`, `tm_show` comments, `tm_trash`,
    `tm_delete` (refusing a trashed item) and `tm_restore`, by CLI and MCP; `make smoke`
    `probe_tm_verbs`."; Gap: "none for the work loop; workspace setup (projects, labels,
    statuses, cycles, saved views, templates) stays on the plain API by ruling." (A `Gap` line
    stays because every criterion carries one.)
- **Tests**: `e2e/smoke.ts` `probe_tm_verbs`, its checks as listed in its step; no suite
  change. Watched failing once: run `make smoke` with the check "tm delete refuses a trashed
  item" expecting code 0; it must print MISMATCH (the verb answers 2); then set it to 2.
- **Gate**: `PB_PORT_OFFSET=$OFFSET make check-static`, `PB_PORT_OFFSET=$OFFSET make check` and
  `make smoke` (it binds a Docker-picked port), each run alone, exit 0.
  Readiness: AC-10 → met, evidence as in the step above.

## Risks

- **R1. Concurrent purge.** Two `tm_delete` calls on one live item can both pass the check and
  the second `DELETE` purges, under a `manage` or `own` key of the workspace owner or an admin
  (key-scoping refuses a `write` key's purge with 403). Caught by nothing in the client; stated
  in the contract's Auth section.
- **R2. The view rule changes.** D4 rests on `project_items` showing trashed rows with
  `trashed`. If a later change hides them, `tm_delete` on a trashed item would answer 404 (still
  never purging) and `tm_restore` would always 404. Caught by "tm_restore brings it back" and
  "tm_delete never purges".
- **R3. Shared files moved by earlier changes.** Steps name symbols and anchor text; a moved
  `TOOLS` is covered by the Depends-on check. Caught by check-static's typecheck and the suites.
- **R4. Large workspaces.** `tm_workspace` reads every page of five lists; a workspace with
  thousands of labels returns a large answer. Accepted: vocabulary is small in practice; the
  31-project check proves paging works.
- **R5. Smoke prerequisites proven in a room, not in the image.** A room spike on 2026-11-10
  with the MFA migration kept: seven superuser user creates in a row all answered 200 (exempt
  from the 5 per minute signup rule); `POST /api/collections/users/impersonate/{id}` with
  `{"duration": 600}` answered 200 with a token; that token minted a write key (200); ten wrong
  password sign-ins afterwards all answered 400, so none of that rule's budget was spent. The
  image runs the same PocketBase pin and migrations; only the MFA and OTP steps were run in
  the image itself. Caught by `make smoke`: the check "agent token by impersonation" goes red. The fix then is
  a design change (move the probe after `probe_forged_client_address` and sign in by password),
  not a build-time choice.
- **R6. Hints change client prompts.** `tm_edit` becomes destructive, so clients that confirm
  destructive calls start asking before edits. Intended (proposal); noted in Compatibility.

## Open Questions

None. Every question was ruled on 2026-11-10 (proposal), and the remaining choices are settled
above.

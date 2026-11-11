# Design

How the contract is met. Shorthand used throughout:

- `KW` is the rule token `@request.headers.x_tm_key_workspace`; `KP` is
  `@request.headers.x_tm_key_projects`.
- "the key" is the `api_keys` record the request authenticated with; "W" and "P" are its
  `workspace` and `projects`.
- `NEW_DECISION` stands for the slug of the decision record this change adds: the word
  `decision`, a colon, then `api-key-reach-and-levels`. Every code comment, record and test
  text below writes it out in full; the plan spells it this way only because the repository's
  citation gate refuses a slug before its record is seeded (Phase 2 seeds it).
- "level order" is `["read", "write", "manage", "own"]`; `a >= b` compares indexes in it.

## Decisions

### D1. Storage: three fields on `api_keys`, the level in `scope`

| Field | Type | Id | Settings | Help text (exact) |
| --- | --- | --- | --- | --- |
| `scope` | select | unchanged (`select4200600003`) | values `read`, `write`, `manage`, `own`; required as today | `The key's level, per workspace role tier: read only reads; write also creates, edits, trashes work; manage also changes settings, invitations and members and purges trash; own also changes roles, hands over and deletes workspaces and accepts invitations. Capped by the user's role; fixed at create.` (build correction: PocketBase caps help at 300 characters) |
| `reach` | select | `select4200610001` | values `all`, `workspace`, `projects`; `maxSelect` 1; not required | `Which part of the tracker the key reaches: all for every workspace its user belongs to, workspace for one workspace, projects for some projects of one workspace; empty on keys made before reach existed, which reach every workspace. Chosen at create and fixed afterwards.` |
| `workspace` | relation to `workspaces` (`pbc_300100001`) | `relation4200610002` | `maxSelect` 1, `minSelect` 0, `cascadeDelete` true, not required | `The one workspace a key limited to a workspace or to projects reaches, empty for a key that reaches every workspace; deleting the workspace for good deletes the key. Chosen at create and fixed afterwards.` |
| `projects` | relation to `projects` (`pbc_484305853`) | `relation4200610003` | `maxSelect` 100, `minSelect` 0, `cascadeDelete` false, not required | `The projects a key limited to projects reaches, all in its workspace; a project deleted for good drops out of the list. Chosen at create and fixed afterwards.` |

- **Level in `scope`, not a new field.** The hosted MCP contract, `GET /api/tracker/me` and every
  client already read `scope`; ruling 5 (a stored `write` is the new `write` tier) is then true
  with no data change. A separate `level` field would leave `scope` meaning two things.
- **`reach` as an explicit select, not derived from which relations are set.** A project
  deleted for good is unlinked from `projects` by PocketBase (spike: a two-project list shrank to
  one, then to `[]`); a key whose kind were derived from "projects non-empty" would then widen to
  the whole workspace. With `reach` stored, an emptied `projects` key reaches no project (fails
  closed). Prior art: GitHub fine-grained tokens store "All repositories" or "Only select
  repositories" as a choice, not as an inferred list.
- **Not required, no backfill.** decision:every-database-boots-from-the-migration-set forbids a
  migration that repairs rows, so keys made before the change keep `reach` `""`, read everywhere
  as `all`. The create hook always writes an explicit value.
- **`workspace` cascades, `projects` does not.** A key limited to a workspace deleted for good
  can do nothing; deleting it with the workspace makes its next request a plain 401
  `api_key_invalid` (spike: cascade removed the key). Projects unlink instead, as above.
- **Up to 100 projects.** Bounds the `X-Tm-Key-Projects` header at about 1.6 KB (15-character
  ids plus commas).
- **No new index.** `api_keys` holds a handful of rows per user; the key lookup is by the
  existing unique `key_hash` index.
- **Immutable after create** by appending to `api_keys.updateRule`, as `scope` is today, so a
  change answers 404.

### D2. How reach reaches every collection rule: server-set request headers

The key middleware (`tmkApiKeyAuth`, `pb_hooks/api_keys.pb.js`) removes the headers
`X-Tm-Key-Workspace` and `X-Tm-Key-Projects` from every request, in every spelling that reaches
the same rule token, then, for a limited key, sets
them: `X-Tm-Key-Workspace` to W; `X-Tm-Key-Projects` to P joined by commas for reach
`projects` (or `-` when P is empty, a value no id contains). Every workspace-bound collection
rule gains a clause on `KW` and `KP` (table in Phase 4), in which `KW = ""` means "no limit".

Alternatives weighed:

- **Hooks per request kind** (`onRecordViewRequest`, `onRecordsListRequest` and so on): a list
  hook runs after the query, so dropping rows there breaks `totalItems` and pagination, and
  expansion and filter-side relation joins would escape it.
- **Injecting a filter into the list query string**: the client's `filter` would have to be
  proven balanced (quotes, parentheses, `//` comments) before wrapping; spike: an unwrapped
  `1=1) || (1=1` widens any naive wrapper. Rules are combined by PocketBase itself and cannot be
  broken out of.
- **Every spelling is removed.** PocketBase turns a header name into a rule token by lower-casing
  it and replacing `-` with `_`, so `x_tm_key_workspace` or `X-Tm-Key_Projects` sent by a client
  reaches the same token, and when two spellings are present which one the rule sees varies
  between requests (truth review, room probe). Go stores each incoming name in its canonical
  form, and the JSVM exposes no way to list header names (spike: `Object.keys` and `for…in` on
  `e.request.header` yield its methods), so `stripReachHeaders` deletes, for each of the two
  names, all eight spellings that choose `-` or `_` at each of its three separators; `del`
  canonicalizes the name it is given. Spike: after this, a forged underscore spelling on a user
  session no longer narrows it, and an empty forged one on a limited request no longer widens
  it (eight requests per spelling, six spellings, one stable answer each).
- **Headers in rules** (chosen). Spike on PocketBase 0.40.4: a middleware-set header is visible
  to `@request.headers.*` in list (`totalItems` correct), view (404), create (400), update (404,
  and a body moving the record out is caught by a clause on `@request.body.*`), delete (404,
  and the delete request hook never runs), and expansion (an out-of-reach relation is left out);
  a client-sent header of the same name is removed before rules see it; a missing header reads
  as `""`; `"<id>,<id>" ~ field` matches exact ids only (ids are `[a-z0-9]{15}` and never
  contain the comma).

This supersedes the "Why not a rule" premise of decision:api-key-reads-refused only as far as
reach goes: rules still cannot tell a key from its user for `api_keys` reads, which stay
refused by the middleware.

### D3. Where the level is checked: a route and collection table, plus three record checks

`requiredLevel(method, route, collectionName)` in `pb_hooks/lib/api_keys.js` returns the level
the request needs (Phase 3 lists the tables). The middleware refuses when the key's level is
below it. Three checks need the record:

- A purge (DELETE on a `tasks`, `decisions`, `documents`, `milestones` or `projects` record
  whose `trashed` is set) needs `manage`, and a `workspace_members` DELETE of the key's own
  user (leaving) needs `own`. A DELETE carries no body, so the middleware decides both: it loads
  the record by `e.request.pathValue("id")` and refuses only when the record exists, the key
  may delete it (`$app.canAccessRecord(record, new RequestInfo({ auth: owner, headers:
  lib.reachHeaders(lib.keyInfo(key)) }), collection.deleteRule)`, so a record out of reach still answers the
  rule's 404, never a 403 that would confirm it), and the state calls for the higher level.
  Spike: `canAccessRecord` with a `RequestInfo` built with `headers` applies a header clause.
  Not in a record hook: hook files load in a different order on each boot (truth review: eight
  boots, eight orders; `pb_hooks/trash.pb.js` says so too), so a purge check there would race
  `trash.pb.js`'s own refusal.
- A `workspace_members` update that changes `role` needs `own`. This needs the body, which the
  middleware never reads (decision:api-keys: `e.requestInfo()` would read the whole body before
  PocketBase's body limit), so it is an `onRecordUpdateRequest` hook. Its order against
  `pb_hooks/membership_status.pb.js`'s refusals is not fixed: when both refuse, either answer
  may come back. The contract says so.

- **Level of a route not in the table, for a non-read method: `own`** (fail closed). This
  replaces decision:api-keys' "Write keys reach every non-admin tracker route, including routes
  added later". Phase 3's test fails when a new non-read route is missing from the table.
- **Accepting or declining an invitation and leaving a workspace need `own`.** They change
  which workspaces the account belongs to, which no tier below the owner's governs; the proposal
  inventory lists them among the ownership-changing surfaces. No prior art found for keys
  accepting invitations; GitHub keeps organization membership acceptance in the signed-in
  account.
- **Messages.** A read key keeps `This API key is read-only.`; otherwise `This action needs an
  API key at the manage level or above.` or `This action needs an API key at the own level.`
  The code stays `api_key_scope` so existing clients keep one branch.

### D4. Which requests a limited key may not make at all: `api_key_reach`

A limited key gets 403 `api_key_reach` on requests that act for the whole account (contract
Classification). A new code, not `api_key_scope`, because raising the level does not help: the
client needs a key with reach `all`. Not 404: the route exists and the key is the reason. The
message describes behaviour: `This API key is limited to part of the tracker, so it cannot be
used for this endpoint.`

### D5. Custom routes apply reach by hand

Custom routes bypass collection rules (header of `pb_hooks/routes.pb.js`), so each handler that
reads or writes workspace data narrows itself with the key (Phase 5). A route naming a workspace
other than W answers the route's existing not-found, so a limited key cannot tell another
workspace from a missing one (decision:inaccessible-workspace-answers-404). Handlers read the
key with `e.get("tmApiKey")`, the plain object the middleware sets (hosted-mcp-endpoint D12,
D19; this change adds `reach`, `workspace` and `projects` to it) (spike: a value set in a middleware with
`e.set` is read back with `e.get` in the route handler).

SQL routes test project membership with `instr({:kp}, ',' || <column> || ',') > 0` where `kp`
is `"," + P.join(",") + ","` (an empty P gives `",,"`, which contains no id). Filter-string
routes use `<column> != '' && {:kpf} ~ <column>` where `kpf` is `P.join(",")` or `-` (spike:
`{:kpf} ~ proj` in `findRecordsByFilter` matched exactly the listed ids).

`pb_hooks/counts.pb.js` already binds `project_items.listRule` into a filter; it now binds `KW`
and `KP` too, so counts follow the rule with no copy of it.

### D6. Realtime: one delivery filter

Rules on a realtime collection subscription are evaluated with the subscription's own
`options.headers`, which the client writes, so they cannot carry a key's reach. Instead:

- `onRealtimeSubscribeRequest` in `pb_hooks/api_keys.pb.js` stores the key's reach on the
  realtime client: `e.client.set("apiKeyReach", JSON.stringify({ workspace: W, projects: P or null }))`
  for a limited key, and `e.client.unset("apiKeyReach")` otherwise.
- `onRealtimeMessageSend` in the same file passes every message for a client without
  `apiKeyReach`, and for one with it delivers only messages whose record is in reach
  (`inReach`, Phase 6), returning without `e.next()` otherwise.

Spike: a value set with `e.client.set` in the subscribe hook is read in the message hook; the
message hook sees both PocketBase record events (`<topic>` name, data `{action, record}`,
including `delete`) and messages a hook sends with `client.send`; returning without `e.next()`
drops the message. Rewriting the client's subscription options instead was rejected: PocketBase
names each event after the subscription string, so a rewritten string breaks the client's
matching (spike).

### D7. Files: the key itself, never a file token

A file token is a user token; spike: such a token alone downloads an out-of-reach attachment.
So a limited key is refused `POST /api/files/token` (D4), and every key downloads a protected
file by presenting itself: for the route `/api/files/{collection}/{recordId}/{filename}` the
middleware replaces the query's `token` with `owner.newFileToken()`. PocketBase then checks the
record's `viewRule` with the request's headers, so reach applies (spike: in reach 200, out of
reach 404, and a client-supplied token is overridden). Doing it for every key, not only limited
ones, keeps one code path.

### D8. `GET /api/tracker/me`

Reads the key from `e.get("tmApiKey")`. Under a limited key the workspace query gains
`AND w.id = {:kw}`; capabilities follow contract; counts for a project key count only P. The
`key` object of `hosted-mcp-endpoint` is that same stored object (its `/me` returns `key: k`), so
the three properties Phase 2 adds to it appear in `key` with no `/me` change.
The read-key bug (kata xgtp) is Phase 1, before any schema change: a `read` key gets every
capability false.

### D9. OAuth consent

Workspace choice preselects "All workspaces": the same default a key made in the account gets
when `reach` is omitted, and the pre-change behaviour of every grant; the person sees the list
and can narrow it. The level choice offers every level up to the highest one requested and preselects that one
(ruling 6: a level above write appears only when the client names it; a lower one is always
choosable, so a request for `own` offers Read, Read and write, Manage and Own). The
authorization code record carries the chosen `scope`, `reach` and `workspace` to the token
exchange; the minted `api_keys` record is created with them. Refresh changes only `key_hash` and
`expires` (hosted contract), so limits persist with no new code.

### D10. Delivery

The fixed build order: `hosted-mcp-endpoint` (its Phases 1 to 9 and its root-run runbook), then
this change's Phase 1 (the read-key `me` bug) as its own pull request, then Phases 2 to 6 as one
pull request, then Phase 7 as the next pull request, all before `key-minting-cli` starts; then
`key-minting-cli`, `tm-distribution`, `agent-verb-coverage`, and `api-versioning-policy` last.
Phases 2 to 6 are commits on one build branch because between Phase 2 and Phase 6 a key can
carry a reach that is not yet enforced everywhere. Phase 7 needs the `api_keys` reach fields,
the registered decision record and `/me` filtered by reach from that pull request, and the
files and ids `hosted-mcp-endpoint` fixes (Depends on). Until Phase 7 lands, grants mint keys
with reach `all`, which is today's behaviour.

### D11. Dependencies, config, names

- No dependency added (PocketBase JSVM and Bun built-ins only).
- No environment variable added.
- New exports of `pb_hooks/lib/api_keys.js`: `LEVELS`, `ROUTE_LEVELS`, `COLLECTION_LEVELS`, `levelAtLeast`, `requiredLevel`,
  `levelMessage`, `ACCOUNT_WIDE`, `accountWide`, `keyInfo`, `keyReach`, `reachHeaders`,
  `stripReachHeaders`, `inReach`, `REACH_MESSAGE`.
- Request store key `tmApiKey` (hosted-mcp-endpoint D19's plain object, built here by
  `keyInfo(key)`: `{ id, scope, expires, client_id, reach, workspace, projects }`); realtime
  client key `apiKeyReach`.
- Header names `X-Tm-Key-Workspace`, `X-Tm-Key-Projects`.
- New decision record `NEW_DECISION` (the app_docs record, Phase 2; the
  matching kata card labelled `decision` is filed by root, which owns the board).
- New suites and ports: `tests/test_key_create.ts` 8214, `tests/test_key_levels.ts` 8210,
  `tests/test_key_reach.ts` 8211, `tests/test_key_reach_routes.ts` 8212,
  `tests/test_key_reach_live.ts` 8213, `tests/test_oauth_key_limits.ts` 8215.

## Depends on

- `hosted-mcp-endpoint` built (build order 1), by contract section:
  Read on lane `d-mcp` at `3fa24a9` (design and contract); none of the names below changed
  since `20568aa`.
  - D12 and D19: the key middleware stores `e.set("tmApiKey", { id, scope, expires, client_id
    })` and `/me` returns that object as `key`, read as `const k = e.get("tmApiKey")` in `pb_hooks/me.pb.js`. Present since
    hosted-mcp-endpoint Phase 1; if it is absent, the build order was changed: stop and report.
    Phase 2 replaces its object with `lib.keyInfo(key)`, a superset.
  - D13: `api_keys` gains `client_id` `text4200600009`, `refresh_hash` `text4200600010`,
    `refresh_expires` `date4200600011`, `refresh_prev_hash` `text4200600012`, and its update
    rule ends with ` && @request.body.client_id:isset = false`. This change's ids
    (`*4200610001` to `*4200610003`) do not collide, and Phase 2 appends after that tail.
  - D13 and D19: collection `oauth_codes`, id `oauthcodes00001`, every rule `null`, `scope`
    select `select4300100007` (`read`, `write`), app_docs record `oauthcodesdoc01`; files
    `pb_hooks/oauth_server.pb.js`, `pb_hooks/lib/oauth.js`, `pb_hooks/views/oauth_authorize.html`;
    `tests/oauthkit.ts` `sign_in_and_approve`. Phase 7 extends exactly these.
  - D7 and D11: the MCP service accepts only `key.scope` `read` or `write` (anything else
    answers 503) and `clients/tm/src/mcp.ts` declares `type Scope = "read" | "write"`; Phase 7
    widens both.
  - D14, D15: `parse_scope`, `scope_text` and `issue_code` in `pb_hooks/lib/oauth.js`; the
    consent stage of `pb_hooks/views/oauth_authorize.html`; the `approve` branch of `POST
    /oauth/authorize` and the code grant of `POST /oauth/token` in
    `pb_hooks/oauth_server.pb.js`. Phase 7 edits exactly these.
- Build order: D10.
- This change is built before api-versioning-policy, so it cuts no API release and edits no
  `api/` file or `mcp-tools.json`. If `scripts/release_api.ts` exists when a phase starts, the
  build order was changed: stop and report.
- Shared files another milestone change also edits: `pb_hooks/api_keys.pb.js`,
  `pb_hooks/me.pb.js`, `pb_hooks/lib/routes.js` (the me response schema), `schema/api_keys.json`,
  `openapi.json`, `scripts/model/`, the newest `pb_migrations/*_seed_app_docs.js` and
  `scripts/app_docs_seed.sha256`, `docs/generated/decisions.md`, `clients/tm/src/mcp.ts`,
  `e2e/smoke.ts`, `scripts/run_suite_battery.sh`, `.agents/rules/ports.md`,
  `docs/readiness/agent-clients.md` (`hosted-mcp-endpoint`, `key-minting-cli`,
  `agent-verb-coverage`).

## Implementation Plan

Common to every phase: a new suite boots its own room through `tests/roomkit.ts` exactly as
`tests/test_api_keys.ts` does (scratch copies of `pb_migrations` with `*superuser_mfa.js`
removed, `roomkit.hooks_dir(S)`, `superuser upsert probe@example.com probe123456` before
`roomkit.serve`, port = default + `PB_PORT_OFFSET`, `check(label, got, want)` and a non-zero
exit on any mismatch), creates users through the superuser with `verified: true, approved:
true`, and mints keys through `POST /api/collections/api_keys/records` under the user's password
session. Each new suite gets one line in `scripts/run_suite_battery.sh`, appended after the
last `run_suite` line, in the form `run_suite "<name>" bun tests/<name>.ts`, and one entry in
the `.agents/rules/ports.md` defaults list (`8210 = test_key_levels` and so on), in ascending
port order before `9700 = test_script_help`, and one row in `scripts/battery_shards.tsv` (`shard<TAB>seconds<TAB>label`): its
seconds as the whole-second wall time of one local run of the suite, on the shard whose
seconds sum is lowest (ties: the lower number), the
row placed so the file stays sorted by seconds descending (the file's own header rule;
`bun scripts/check_battery_suites.ts` verifies). "RED first" means: write the case, run the suite against the tree before the
phase's code change, quote the failing line in the pull request, then make it pass.

### Phase 1: a read key's `me` reports no write capability (kata xgtp)

- **Goal**: `GET /api/tracker/me` under a `read` key reports `write`, `manage` and `own` false
  for every workspace (contract, "`GET /api/tracker/me` under a key").
- **Files**:
  - modify `pb_hooks/me.pb.js`
  - modify `tests/test_me_route.ts`
  - create `e2e/fixtures/smoke_key_user.js`
  - modify `e2e/smoke.ts`
  - modify `e2e/README.md`
- **Steps**:
  - (`pb_hooks/api_keys.pb.js` already stores `e.set("tmApiKey", { id, scope, expires,
    client_id })`: hosted-mcp-endpoint Phase 1, built first.)
  - `pb_hooks/me.pb.js`, after `const uid = e.auth.id;`: add
    `const readOnly = !!k && k.scope === "read";`, reusing hosted's `const k =
    e.get("tmApiKey")` (move that declaration up to right after `const uid = e.auth.id;` if it
    sits lower)
    and in `capabilities` AND each of the three flags with `!readOnly`
    (`write: !readOnly && active && role !== "viewer"`, and likewise `manage`, `own`). Extend the
    existing `decision:role-tiers` comment line to end with `; a read key holds none`.
  - `e2e/fixtures/smoke_key_user.js`: a migration file used only by the smoke run (never in
    `pb_migrations/`). `migrate((app) => { const users = app.findCollectionByNameOrId("users");
    const u = new Record(users); u.set("email", "smoke-keys@example.com"); u.set("name", "Smoke Keys");
    u.setPassword("smoke-keys-123456"); u.set("verified", true); u.set("approved", true);
    app.save(u); }, (app) => {})`, with the one-line header
    `// Smoke-only fixture: one approved, verified user for the API-key probes; copied into the image at run time.`
  - `e2e/smoke.ts`:
    - Constants `KEY_USER = "smoke-keys@example.com"`, `KEY_PASSWORD = "smoke-keys-123456"`,
      `KEY_IP = "203.0.113.50"` (an `X-Real-IP` of its own, so the sign-in does not spend the
      budget `probe_forged_client_address` measures).
    - In `main()`, after every wait `hosted-mcp-endpoint` Phase 8 put there (the PocketBase
      `/api/health` loop and the PRM wait) and before the probes: `docker compose cp
      e2e/fixtures/smoke_key_user.js` to the container, written as `const SMOKE_MIGRATION =
      "1785199999_smoke_key_user.js";` and `run([...COMPOSE, "cp", path.join(ROOT,
      "e2e/fixtures/smoke_key_user.js"), "pocketbase:/pb/pb_migrations/" + SMOKE_MIGRATION])`
      (the file name is its own string, so `check_migration_citations` reads no path citation), then `run([...COMPOSE, "restart",
      "pocketbase"])`, then resolve the port again (a restart republishes port 0 on a new host
      port: extract the existing `compose port pocketbase 8080` lookup and its 8090 refusal
      into `function resolve_base_url(): boolean`, which sets `BASE_URL` and returns false on a
      non-zero exit, no port, or 8090, and call it in both places), then the PocketBase health
      wait again (the MCP service keeps
      running; its PRM wait is not repeated). Extract the inline PocketBase `/api/health` loop
      (not the PRM wait, which stays where it is) into `async function wait_healthy(): Promise<boolean>` (its deadline computed
      as `Date.now() + HEALTH_TIMEOUT_MS` on each call, same log dump, returning false on
      timeout) and call it in both places; a non-zero code from
      `cp` or `restart`, or a false from `wait_healthy`, prints the output and returns 1.
    - `async function key_session(): Promise<string>`: `POST
      /api/collections/users/auth-with-password` with the fixture identity and header
      `X-Real-IP: KEY_IP`, returns the token; memoized in a module variable.
    - `async function mint_key(fields: Record<string, unknown>): Promise<string>`: `POST
      /api/collections/api_keys/records` with the session and `{ name: "smoke", ...fields }`,
      returns `json.key`.
    - `async function probe_read_key_me()`: mint `{ scope: "read" }`; `GET /api/tracker/me`
      with `Authorization: Bearer <key>`; `check("read key me: every capability false",
      workspaces.every(w => !w.capabilities.write && !w.capabilities.manage &&
      !w.capabilities.own), true)` and `check("read key me lists the provisioned workspace",
      workspaces.length >= 1, true)`.
    - Add `probe_read_key_me` to `PROBES` immediately before `probe_forged_client_address`
      (`probe_signup_rate_limit` stays last; this change's four probes end up in phase
      order, each inserted at the same anchor).
  - `e2e/README.md`: replace the sentence `hosted-mcp-endpoint` Phase 8 wrote saying the keyed
    paths stay battery-only (the one containing "battery-only") with: "A smoke run copies
    `e2e/fixtures/smoke_key_user.js` into the image and restarts it, so the key probes have one
    approved, verified user; keyed paths beyond those probes stay battery-only."; if no sentence
    contains "battery-only", add that sentence after the list of probes hosted Phase 8 wrote.
    Add `probe_read_key_me` to that same list of probes.
- **Tests** (`tests/test_me_route.ts`, port 8177; add a section `── API keys ──` that mints, for
  the suite's workspace owner, a read key and a write key):
  - "read key me: owner workspace write/manage/own all false" → each `false` (RED first: today
    `write` and `manage` are `true`).
  - "read key me: lists the same workspaces as the owner session" → same ids in the same order.
  - "write key me: owner workspace capabilities equal the session's" → `{write: true, manage:
    true, own: true}` (Phase 3 changes this expectation).
  - "session me unchanged" → the session's capabilities as before.
- **Gate**: `PB_PORT_OFFSET=<n> bun tests/test_me_route.ts`; `make check-static`; `make smoke`.

### Phase 2: `api_keys` carries reach and level

- **Goal**: keys are created with `reach`, `workspace`, `projects` and levels `manage` and
  `own`, validated and immutable (contract, "`api_keys` record").
- **Files**:
  - create `pb_migrations/<slot>_api_keys_reach_and_levels.js`
  - modify `pb_hooks/api_keys.pb.js`
  - create `pb_migrations/<slot>_seed_app_docs.js` (the new newest seed)
  - modify `scripts/gen_app_docs_seed.ts` (`DEFAULT_OUTPUT`)
  - modify `scripts/app_docs_seed.sha256` (regenerated)
  - modify `scripts/check_app_docs_history.ts` (`ALLOWLIST`)
  - regen: `schema/` via `bun scripts/gen_schema.ts`, `openapi.json` via `bun
    scripts/gen_openapi.ts`, `scripts/model/` via `bun scripts/model/extract_current.ts`,
    `docs/generated/decisions.md` via `bun scripts/gen_decisions.ts`, and
    `clients/tm/src/api.generated.ts` via `bun scripts/gen_tm_client.ts`
  - create `tests/test_key_create.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
- **Steps**:
  - Migration (slot from `make next-migration-slot`; the seed takes the next one): up: find
    `api_keys`; set the `scope` field's `values` to `["read", "write", "manage", "own"]` and its
    help to D1's text; add the three fields of D1 (`new SelectField({...})`,
    `new RelationField({...})` with the ids, settings and help of D1); set `updateRule` to
    `"(" + old + ") && @request.body.reach:isset = false && @request.body.workspace:isset = false && @request.body.projects:isset = false"`;
    save. Down: remove the three fields, restore `values` `["read", "write"]` and the previous
    help, strip the appended suffix from `updateRule`; save. One-line header:
    `// api_keys: a key's reach (all, workspace, projects) and the manage and own levels (NEW_DECISION).`
  - `pb_hooks/api_keys.pb.js`, `onRecordCreateRequest(..., "api_keys")`, before `e.next()`,
    after the user is fixed: read `reach = e.record.getString("reach") || "all"` and set it
    back; `scope = e.record.getString("scope")`; `ws = e.record.getString("workspace")`;
    `ps = e.record.getStringSlice("projects")`; `uid = e.record.getString("user")`. Its first
    statement is `require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e);` (the house
    rule in `pb_hooks/lib/unknown_keys.js`: every create or update refusal calls it first). A `reach`
    outside the three values skips checks 1 to 7 and is refused by the select field's own
    validation (400 `validation_invalid_value` on `reach`) when `e.next()` runs. Collect
    refusals into an object and, if any, throw
    `new BadRequestError("The key's reach or level is not valid.", errors)` (one top-level
    message for every case below) where each entry is
    `new ValidationError(code, message)` keyed by field, with the codes and messages of the
    contract table, checked in this order (first failure per field wins). Checks 1 to 4 run
    first; if any of them refused, throw without running 5 to 7:
    1. `reach !== "all" && !ws` → `workspace` `validation_required`.
    2. `reach === "all" && (ws || ps.length)` → `workspace` `key_reach_mismatch`.
    3. `reach === "workspace" && ps.length` → `projects` `key_reach_mismatch`.
    4. `reach === "projects" && !ps.length` → `projects` `validation_required`.
    5. `ws`: load it (`$app.findRecordById("workspaces", ws)`, a miss is the refusal); refuse
       `workspace` `key_workspace_unreachable` unless `String(w.get("trashed")) === ""` and
       (`w.get("owner") === uid` or `findFirstRecordByFilter("workspace_members", "workspace = {:w} && user = {:u} && status = 'active'", ...)` succeeds).
    6. each id of `ps`: load it from `projects`; refuse `projects` `key_project_unreachable`
       unless `p.get("workspace") === ws`, `String(p.get("trashed")) === ""` and
       `p.get("shadow") !== true`.
    7. `reach === "projects" && (scope === "manage" || scope === "own")` → `scope`
       `key_level_above_write`.
  - Same file, middleware: change the scope test to
    `if (key.getString("scope") === "read" && !reads)` (Phase 3 replaces it), and replace the
    `e.set("tmApiKey", {...})` object with `require(`${__hooks}/lib/api_keys.js`).keyInfo(key)`.
  - `pb_hooks/lib/api_keys.js` adds and exports `function keyInfo(key)`: `{ id: key.id, scope:
    key.getString("scope"), expires: key.getString("expires"), client_id:
    key.getString("client_id"), reach: key.getString("reach") || "all", workspace:
    key.getString("workspace"), projects: JSON.parse(JSON.stringify(key.getStringSlice("projects"))) }`
    (the JSON round trip yields a plain array).
  - `pb_hooks/lib/routes.js`, `GET /api/tracker/me` response schema: the `key` property's
    `scope` enum becomes `read`, `write`, `manage`, `own`, and it gains `reach` (string, enum
    `all`, `workspace`, `projects`), `workspace` (string) and `projects` (array of string), all
    required; its description becomes "Present only under an API key: the key's id, level (scope), expiry ("" for never), client ("" for a key minted by hand), reach (all, workspace or projects), workspace ("" for reach all) and projects ([] unless reach is projects)." (root ruling: it states what the object holds).
  - New app_docs seed, per `.agents/rules/pocketbase.md` ("newest seed"): copy the current
    newest `pb_migrations/*_seed_app_docs.js` to the new slot, point `DEFAULT_OUTPUT` at it,
    edit records as below, run `bun scripts/gen_app_docs_seed.ts`:
    - `collection:api_keys` body: in the field list replace `scope (select, required: read or
      write)` with `scope (select, required: read, write, manage or own, the key's level)`,
      replace `expires (date, optional) and revoked (bool)` with `expires (date, optional),
      revoked (bool)` (root ruling: one "and" in the list), and add after `revoked (bool)`: `, reach (select: all, workspace or projects; empty on older
      keys, read as all), workspace (relation to workspaces, removed with the workspace) and
      projects (relation to projects, up to 100)`; append the paragraph `**Reach and level.**
      Both are chosen at create and fixed: a change to reach, workspace or projects is refused
      with 404, as for scope. A create is refused with 400 when the reach is incoherent, the
      workspace is not one the user belongs to, a project is not a live project of it, or a
      projects key asks for manage or own (NEW_DECISION).`
    - Every span of 40 or more characters the rewrite of `collection:api_keys` drops gets an
      `ALLOWLIST` entry in `scripts/check_app_docs_history.ts`, in the existing form
      `['["<new seed file name>", "collection:api_keys", "<first 60 characters of the dropped
      span>"]', "NEW_DECISION: scope gained manage and own; the field list
      now says so"]`, the key copied from the drop `bun scripts/check_app_docs_history.ts`
      prints when run without it.
    - `concept:api-keys` body: append `A key can be limited to one workspace or to some of its
      projects, and its level follows the workspace role tiers; see
      NEW_DECISION.`
    - `decision:api-keys` body: append the paragraph `**Superseded in part:** write keys no
      longer reach every non-admin tracker route; a key's level and reach decide
      (NEW_DECISION).`
    - New record `NEW_DECISION` (title `A key carries a reach, every
      workspace, one workspace or some of its projects, and a level that follows the role
      tiers, and acts at the lower of its level and its user's role.`, ref `api_keys`, id
      `apikeyreach0001`), body: the owner rulings of 2026-11-10 (proposal Open Questions 1-6,
      one bullet each, copied from the proposal's Open Questions with the word "Ruled:" kept),
      then the paragraph: `**How it is enforced.** The key middleware removes the reach headers
      from every request and sets them for a key limited to a workspace or projects. Every
      workspace-bound collection rule carries a clause on those headers, so lists, views,
      writes and expansions keep to the reach. Custom routes, realtime delivery and file
      downloads apply the same reach by hand, and a new workspace-bound collection or route
      must do the same.`, then the accepted limits: `**users stay listable.** Any signed-in
      user lists users today, and a limited key does too.` and `**A level above the role does
      nothing.** A key acts at the lower of the two.`, then `Prior art: Linear lets a personal
      API key be limited to certain teams and permissions
      (https://linear.app/docs/api-and-webhooks); a GitHub fine-grained token reaches one
      resource owner and selected repositories, with administration as its own permission
      (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens);
      Notion lets a person choose pages at consent and answers 404 for a page not shared
      (https://developers.notion.com/docs/authorization).`
- **Tests** (`tests/test_key_create.ts`, port 8214; Alice owns workspaces WA and WB, WA has
  projects PA1, PA2 and a trashed PA3; Bob owns WC; Bob is an active member of WA; Carol is a
  suspended member of WA):
  - "create without reach → 200, reach all, workspace '', projects []" (RED first: `reach`
    absent from the response).
  - "create reach workspace WA → 200, reach workspace, workspace WA".
  - "create reach projects WA [PA1, PA2] write → 200".
  - "create scope manage reach all → 200"; "create scope own reach all → 200".
  - "create reach workspace without workspace → 400 workspace validation_required, nothing
    stored".
  - "create reach all naming WA → 400 workspace key_reach_mismatch".
  - "create reach workspace with projects → 400 projects key_reach_mismatch".
  - "create reach projects with none → 400 projects validation_required".
  - "Alice creates reach workspace WC (Bob's) → 400 workspace key_workspace_unreachable".
  - "Bob creates reach workspace WA (member) → 200".
  - "Carol creates reach workspace WA (suspended) → 400 key_workspace_unreachable".
  - "create reach projects WA [PC1, a project Bob made in WC] → 400 projects
    key_project_unreachable".
  - "create reach projects WA [PA3 trashed] → 400 key_project_unreachable".
  - "create reach projects WA [WA's hidden container] → 400 key_project_unreachable" (the
    container id read by the superuser: `projects` filter `workspace = WA && shadow = true`).
  - "create reach projects scope manage → 400 scope key_level_above_write".
  - "owner PATCH reach / workspace / projects → 404, unchanged" (three cases).
  - "superuser DELETEs WA (a superuser's first DELETE deletes for good) → the WA keys answer
    401 api_key_invalid".
  - "superuser DELETEs PA2 → the projects key's record lists projects [PA1]".
- **Gate**: `bun tests/test_key_create.ts`; `bun tests/test_api_keys.ts`; `bun
  scripts/gen_app_docs_seed.ts --check`; `bun scripts/check_app_docs_history.ts`; `make
  check-static`.

### Phase 3: levels (AC-4)

- **Goal**: every key request is refused below its required level, and `me` reports
  capabilities narrowed by level (contract, Classification and Errors).
- **Files**:
  - modify `pb_hooks/lib/api_keys.js`
  - modify `pb_hooks/api_keys.pb.js`
  - modify `pb_hooks/me.pb.js`
  - modify `scripts/gen_openapi.ts`
  - regen `openapi.json` via `bun scripts/gen_openapi.ts`, `clients/tm/src/api.generated.ts` via `bun scripts/gen_tm_client.ts`
  - modify `tests/test_api_keys.ts`
  - modify `tests/test_me_route.ts`
  - create `tests/test_key_levels.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
  - modify `docs/readiness/agent-clients.md`
  - modify `e2e/smoke.ts`
  - modify `e2e/README.md`
- **Steps**:
  - `pb_hooks/lib/api_keys.js` adds (pure functions, no PocketBase global at load):
    - `const LEVELS = ["read", "write", "manage", "own"];`
      `function levelAtLeast(have, need) { return LEVELS.indexOf(have) >= LEVELS.indexOf(need); }`
    - `const ROUTE_LEVELS` (keys are `"METHOD /pattern"`; `null` = no level check):
      `POST /api/tracker/notifications/read-all` write; `PATCH /api/tracker/users/{id}/settings`
      write; `POST /api/tracker/workspaces/{id}/vocab` manage;
      `POST /api/tracker/workspaces/{id}/resolve-member-email` manage;
      `POST /api/tracker/workspaces/{id}/transfer-ownership` own;
      `POST /api/tracker/invitations/{id}/accept` own; `POST /api/tracker/invitations/{id}/decline`
      own; `POST /api/tracker/trash/purge` null; `POST /api/tracker/cycles/rollover` null.
      (`/api/tracker/admin/*` never reaches the level check: the allowlist refuses it first.)
    - `const COLLECTION_LEVELS = { tasks, decisions, documents, milestones, projects, comments,
      task_subscribers, saved_views, notifications, user_settings: "write"; labels, statuses,
      cycles, templates, workspace_invitations, workspace_members: "manage" }` and
      `workspaces: { POST: "write", PATCH: "manage", DELETE: "own" }` (a string applies to every
      write method).
    - `function requiredLevel(method, route, collection)`: `GET`/`HEAD` → `"read"`; `POST` on
      `/api/realtime`, `/api/files/token`, `/api/tracker/export` → `"read"`; `collection !== ""`
      (the middleware passes the target's name only for a records route) → the collection's
      entry for the method, else `"own"`; `"METHOD route"` in `ROUTE_LEVELS` →
      its value; anything else → `"own"`.
    - `function levelMessage(have, need)`: `have === "read"` → `"This API key is read-only."`;
      `need === "own"` → `"This action needs an API key at the own level."`; else
      `"This action needs an API key at the " + need + " level or above."`.
    - Export `LEVELS`, `ROUTE_LEVELS`, `COLLECTION_LEVELS`, `levelAtLeast`, `requiredLevel`,
      `levelMessage`, `keyReach`, `reachHeaders` with `namesApiKeys`.
  - `pb_hooks/api_keys.pb.js` middleware: replace the `reads` computation and the scope test
    with: `const lib = require(...)`; hoist `let target = null;` above the records-route `if` (it is
    declared inside it today) and set `const coll = target ? target.name : "";`; `const need = lib.requiredLevel(method,
    route, coll); const have = key.getString("scope");` (and `const info = lib.keyInfo(key)`,
    used below) and
    `if (need !== null && !lib.levelAtLeast(have, need)) throw new ApiError(403,
    lib.levelMessage(have, need), { api_key: new ValidationError("api_key_scope",
    lib.levelMessage(have, need)) });`. Replace the `KEEP IN SYNC` line above the allowlist with, verbatim:
    `// KEEP IN SYNC: scripts/gen_openapi.ts renders this allowlist (\`/api/tracker/admin/\`) into every route's description; levels come from requiredLevel.`
  - Same middleware, right after the level check, for `method === "DELETE"` on the
    records-by-id route: `let rec = null; try { rec = $app.findRecordById(target,
    e.request.pathValue("id")); } catch (_) {}`; when `rec` and
    `$app.canAccessRecord(rec, new RequestInfo({ auth: owner, headers: lib.reachHeaders(info) }),
    target.deleteRule)`:
    - `["tasks", "decisions", "documents", "milestones", "projects"]` includes `target.name`,
      `String(rec.get("trashed")) !== ""` and `!lib.levelAtLeast(have, "manage")` → 403
      `api_key_scope` with `lib.levelMessage(have, "manage")`;
    - `target.name === "workspace_members"`, `rec.getString("user") === owner.id` and
      `!lib.levelAtLeast(have, "own")` → 403 `api_key_scope` with `lib.levelMessage(have,
      "own")`.
    (A `deleteRule` of `null` means superuser-only; skip the check then.)
  - Same file, `onRecordUpdateRequest((e) => { ... }, "workspace_members")`: `const lib =
    require(`${__hooks}/lib/api_keys.js`); const k = e.get("tmApiKey");` and, first,
    `require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e);`; when `k`,
    `e.record.getString("role") !== e.record.original().getString("role")` and
    `!lib.levelAtLeast(k.scope, "own")`, throw `new ApiError(403,
    lib.levelMessage(k.scope, "own"), { api_key: new
    ValidationError("api_key_scope", lib.levelMessage(k.scope, "own")) })`;
    otherwise `return e.next()`.
  - `pb_hooks/lib/api_keys.js` (this phase) also adds `function keyReach(info)` (`info` a
    `keyInfo` object): `null` when `!info` or `info.reach === "all"`; else `{ workspace:
    info.workspace, projects: info.reach === "projects" ? info.projects : null }`; and `function
    reachHeaders(info)`: `{}` when `keyReach(info)` is null, else `{ x_tm_key_workspace: reach.workspace, x_tm_key_projects:
    reach.projects ? (reach.projects.join(",") || "-") : "" }`. Until Phase 4 no rule reads
    them.
  - `pb_hooks/me.pb.js`: replace `readOnly` with `const level = k ? k.scope : "own"` and capabilities `write: active && role !== "viewer" &&
    lib.levelAtLeast(level, "write")`, `manage: active && (role === "owner" || role ===
    "admin") && lib.levelAtLeast(level, "manage")`, `own: owner && level === "own"`
    (`lib` = `require(`${__hooks}/lib/api_keys.js`)` inside the handler).
  - `scripts/gen_openapi.ts`: below `ROUTES`, add `const KEY_LIB = createRequire(import.meta.url)(path.join(REPO, "pb_hooks/lib/api_keys.js"));`;
    `key_access` keeps its `"refused"` line and then returns `KEY_LIB.requiredLevel(method, p,
    "") ?? "read"` (a `null`, a superuser-only route, takes the `read` text, which the caller
    already blanks for `spec.auth === "superuser"`); its return type becomes `"refused" | "read"
    | "write" | "manage" | "own"`. `KEY_TEXT` becomes: refused (unchanged); `read`
    `"An API key acts as its user, so it may call this too."`; `write` `"An API key acts as its
    user and needs the write level here; a read-only key gets 403."`; `manage` `"An API key acts
    as its user and needs the manage level or above here; a lower level gets 403."`; `own` `"An
    API key acts as its user and needs the own level here; a lower level gets 403."`; Replace its `KEEP IN SYNC` line with, verbatim:
    `// KEEP IN SYNC: pb_hooks/api_keys.pb.js key path allowlist (\`/api/tracker/admin/\`).`
    Run `bun scripts/check_keep_in_sync.ts`; it must pass.
  - `tests/test_api_keys.ts`: mint a third key `MANAGE_KEY` (`{ scope: "manage" }`) beside the
    write key; the checks "write key PATCH that workspace → 200" and "write key PATCH with a body
    over the size limit → 413" use `MANAGE_KEY` and are renamed "manage key …" (incidental
    repair; revert by restoring the write key).
  - `tests/test_me_route.ts`: the Phase 1 case "write key me: …" now expects `{write: true,
    manage: false, own: false}` and is renamed "write key me: write only"; add "own key me:
    owner workspace all true" with a third key `{ scope: "own" }`.
  - `docs/readiness/agent-clients.md` AC-4: verdict `met`; evidence `tests/test_key_levels.ts`
    ("write key purge → 403 api_key_scope", "write key transfer-ownership → 403
    api_key_scope", "write key trash → 204"); gap removed. Keep the page's `updated` date
    current.
  - `e2e/smoke.ts`: `probe_key_levels()`: with the fixture session create a task in the user's
    provisioned workspace (`GET /api/tracker/me` with the session gives its id; body `{
    "title": "smoke level probe", "workspace": "<id>" }`, the server files it in the workspace's
    container project and default status), mint `{ scope: "write" }`; under the key DELETE the task (204), DELETE it again (403 `api_key_scope`), and
    `POST /api/tracker/workspaces/{ws}/transfer-ownership` with body `{ user: <own id> }` (403
    `api_key_scope`). Add immediately before `probe_forged_client_address`; list it in
    `e2e/README.md` (listed in Files).
- **Tests** (`tests/test_key_levels.ts`, port 8210, run in the order listed; Alice owns WA with
  project PA and a second workspace WT; Bob is an active admin of WA and an active member of WT;
  Mia and Sam active members of WA, Vic a viewer of WA; Bob owns WC and WD and invites
  alice@example.com to each as member (pending); keys for Alice at each level (`aRead`,
  `aWrite`, `aManage`, `aOwn`); Bob `bManage` and `bOwn`; Mia `mOwn`):
  - "aRead me: WA {write: false, manage: false, own: false}"; "aWrite me: WA {write: true,
    manage: false, own: false}"; "aManage me: WA {write: true, manage: true, own: false}";
    "aOwn me: WA {write: true, manage: true, own: true}"; "mOwn me: WA {write: true, manage:
    false, own: false}" (her role caps it).
  - "mOwn PATCHes WA's name → 404, name unchanged" (the spec's "A level above the role": the
    member's own session gets the same 404).
  - "aWrite creates, edits and trashes a task → 200, 200, 204" (a control).
  - "aWrite purges the trashed task → 403 api_key_scope, still trashed" (RED first: 204).
  - "aManage purges it → 204, superuser reads 404".
  - "aWrite trashes a live project → 204"; "aWrite purges it → 403"; "aManage → 204".
  - "aWrite deletes its own comment → 204".
  - "aWrite removes an attachment (`attachments-` PATCH) → 200".
  - "aWrite PATCH WA name → 403 api_key_scope, manage message"; "aManage → 200".
  - "aWrite POST vocab on WA → 403"; "aManage → 200".
  - "aWrite creates a label / status / cycle / template in WA → 403" (four cases); "aManage →
    200" (four cases).
  - "aWrite invites z@example.com to WA → 403"; "aManage → 200"; "aWrite resolve-member-email
    on WA → 403"; "aManage → 200".
  - "aManage suspends Sam (PATCH status suspended) → 200"; "aManage changes Mia's role to
    admin → 403 own message, role unchanged"; "aOwn changes Mia's role to admin → 200".
  - "aManage removes Vic → 204"; "bManage leaves WA (deletes his own row) → 403"; "bOwn leaves
    WA → 204".
  - "aWrite accepts the WC invitation → 403 own message"; "aOwn accepts it → 200"; "aWrite
    declines the WD invitation → 403"; "aOwn declines it → 200, invitation gone".
  - "aManage transfer-ownership of WT to Bob → 403"; "aOwn → 200, WT owner is Bob".
  - "aManage deletes WA → 403"; "aOwn deletes WA → 204 (trashed)" (last of the WA cases).
  - "every non-GET registry route is classified": load `pb_hooks/lib/routes.js` `ROUTES` with
    `createRequire`, and for each key whose method is not `GET`/`HEAD`, whose `auth` is not
    `"none"`, that is not `internal` and whose path does not start with `/api/tracker/admin/`,
    assert it is in `ROUTE_LEVELS` (loaded from `pb_hooks/lib/api_keys.js` the same way) or is
    `POST /api/tracker/export` → no unclassified route.
- **Gate**: `bun tests/test_key_levels.ts`; `bun tests/test_api_keys.ts`; `bun
  tests/test_me_route.ts`; `bun scripts/gen_openapi.ts --check`; `make check-static`.

### Phase 4: reach in collection rules

- **Goal**: collection record routes, counts and expansions apply a limited key's reach, and
  account-wide requests refuse it (contract, Classification: collection records; Errors).
- **Files**:
  - modify `pb_hooks/lib/api_keys.js`
  - modify `pb_hooks/api_keys.pb.js`
  - modify `pb_hooks/counts.pb.js`
  - create `pb_migrations/<slot>_key_reach_rules.js`
  - regen: `schema/` via `bun scripts/gen_schema.ts`, `openapi.json` via `bun scripts/gen_openapi.ts`, `scripts/model/` via `bun scripts/model/extract_current.ts`
  - create `pb_migrations/<slot>_seed_app_docs.js` (a new newest seed, slot after the rules
    migration), modify `scripts/gen_app_docs_seed.ts` (`DEFAULT_OUTPUT`), regen
    `scripts/app_docs_seed.sha256`
  - modify `scripts/check_app_docs_quotes.ts`
  - modify `scripts/check_app_docs_history.ts` (`ALLOWLIST`)
  - modify `tests/test_pb_migrate.ts`
  - regen `clients/tm/src/api.generated.ts` via `bun scripts/gen_tm_client.ts` (it quotes the
    notifications and projects rules)
  - create `tests/test_key_reach.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
- **Steps**:
  - `pb_hooks/lib/api_keys.js` adds:
    (`keyReach` and `reachHeaders` exist since Phase 3.) Add `ACCOUNT_WIDE`, `accountWide`,
    `REACH_MESSAGE` and `stripReachHeaders` to `module.exports`.
    - `const ACCOUNT_WIDE = ["GET /api/tracker/me/landing", "GET
      /api/tracker/workspaces/{id}/switch", "GET /api/tracker/invitations/mine", "POST
      /api/tracker/invitations/{id}/accept", "POST /api/tracker/invitations/{id}/decline", "PATCH
      /api/tracker/users/{id}/settings", "POST /api/files/token"]`;
      `function accountWide(method, route, collection)`: true when `method + " " + route` is in
      `ACCOUNT_WIDE`, or `collection === "workspaces" && method === "POST"`, or
      `collection === "user_settings" && method !== "GET" && method !== "HEAD"`.
    - `const REACH_MESSAGE = "This API key is limited to part of the tracker, so it cannot be used for this endpoint.";`
  - `pb_hooks/api_keys.pb.js` middleware:
    - `pb_hooks/lib/api_keys.js` also adds `function stripReachHeaders(header)`: for each of
      `["x", "tm", "key", "workspace"]` and `["x", "tm", "key", "projects"]`, for `m` from 0 to
      7, build the name joining the parts with `(m >> (i - 1)) & 1 ? "_" : "-"` before part `i`,
      and call `header.del(name)`.
    - First statement of the middleware, before `hosted-mcp-endpoint`'s `/oauth/` and
      `/.well-known/` skip and before the `tmk_` test (so the headers go on every request):
      `require(`${__hooks}/lib/api_keys.js`).stripReachHeaders(e.request.header);` with the
      comment `// Only this middleware sets the reach headers the collection rules read, in any
      spelling (NEW_DECISION).`
    - After the allowlist and before the level check: `const reach = lib.keyReach(info); if (reach
      && lib.accountWide(method, route, coll)) throw new ApiError(403, lib.REACH_MESSAGE,
      { api_key: new ValidationError("api_key_reach", lib.REACH_MESSAGE) });`
    - Just before `e.set("tmApiKey", ...)`: `if (reach) { e.request.header.set("X-Tm-Key-Workspace",
      reach.workspace); if (reach.projects) e.request.header.set("X-Tm-Key-Projects",
      reach.projects.length ? reach.projects.join(",") : "-"); }`.
  - Migration `<slot>_key_reach_rules.js`: up defines `const KW =
    "@request.headers.x_tm_key_workspace", KP = "@request.headers.x_tm_key_projects";` the
    clauses below, and `add(app, name, map)` which, for each `rule` key in `map`
    (`listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule`) whose current value is
    not null, sets `c[rule] = '@request.auth.id != "" && (' + c[rule] + ") && " + clause` (the
    leading guard keeps `scripts/model/extract_current.ts`'s leading-auth-guard reading true)
    and saves; down strips that exact prefix and the suffix `") && " + clause` when both are
    present. Header:
    `// Collection rules apply a limited API key's reach from the headers only the key middleware sets (NEW_DECISION).`
    Clauses (`KW`, `KP` substituted as written):
    - `C_WS = (KW = "" || workspace = KW)`
    - `C_ID = (KW = "" || id = KW)`
    - `C_INV = (KW = "" || (workspace = KW && KP = ""))`
    - `C_PROJ = (KW = "" || (workspace = KW && (KP = "" || KP ~ id)))`
    - `C_ITEM = (KW = "" || (workspace = KW && (KP = "" || (project != "" && KP ~ project))))`
    - `C_ITEM_CREATE = (KW = "" || ((workspace = KW || (workspace = "" && project.workspace = KW)) && (KP = "" || (project != "" && KP ~ project))))`
    - `C_ITEM_UPDATE = (KW = "" || (workspace = KW && (@request.body.workspace:isset = false || @request.body.workspace = KW) && (KP = "" || (project != "" && KP ~ project && (@request.body.project:isset = false || (@request.body.project != "" && KP ~ @request.body.project))))))`
    - `C_COMMENT = (KW = "" || (task != "" && task.workspace = KW && (KP = "" || (task.project != "" && KP ~ task.project))) || (document != "" && document.workspace = KW && (KP = "" || (document.project != "" && KP ~ document.project))) || (decision != "" && decision.workspace = KW && (KP = "" || (decision.project != "" && KP ~ decision.project))))`
    - `C_TASK = (KW = "" || (task.workspace = KW && (KP = "" || (task.project != "" && KP ~ task.project))))`
    - `C_ACTIVITY = (KW = "" || (task != "" && task.workspace = KW && (KP = "" || (task.project != "" && KP ~ task.project))) || (task = "" && workspace = KW && KP = ""))`
    - `C_NOTIF = (KW = "" || (workspace = KW && (KP = "" || (task != "" && task.project != "" && KP ~ task.project) || (document != "" && document.project != "" && KP ~ document.project) || (decision != "" && decision.project != "" && KP ~ decision.project))))`

    | Collection | list, view | create | update | delete |
    | --- | --- | --- | --- | --- |
    | `workspaces` | `C_ID` | unchanged | `C_ID` | `C_ID` |
    | `workspace_members` | `C_WS` | (null) | `C_WS` | `C_WS` |
    | `workspace_invitations` | `C_INV` | `C_INV` | (null) | `C_INV` |
    | `labels`, `statuses`, `cycles` | `C_WS` | `C_WS` | `C_WS` | `C_WS` |
    | `projects` | `C_PROJ` | `C_PROJ` | `C_PROJ` | `C_PROJ` |
    | `tasks`, `decisions`, `documents`, `milestones` | `C_ITEM` | `C_ITEM_CREATE` | `C_ITEM_UPDATE` | `C_ITEM` |
    | `templates`, `saved_views` | `C_ITEM` | `C_ITEM` | `C_ITEM_UPDATE` | `C_ITEM` |
    | `comments` | `C_COMMENT` | `C_COMMENT` | `C_COMMENT` | `C_COMMENT` |
    | `task_subscribers` | `C_TASK` | `C_TASK` | (null) | `C_TASK` |
    | `task_activity` | `C_ACTIVITY` | (null) | (null) | (null) |
    | `notifications` | `C_NOTIF` | (null) | `C_NOTIF` | (null) |
    | `project_items` | `C_ITEM` | | | |
    | `project_stats` | `C_PROJ` | | | |

    Unchanged: `users`, `user_settings`, `app_docs`, `app_settings`, `invitation_events`,
    `api_keys`.
  - App_docs quotes (`scripts/check_app_docs_quotes.ts` requires three records to quote whole
    rules byte for byte): in a new newest seed made as in Phase 2, replace in record
    `g2ntf1col2docs3` the quoted old `notifications.listRule`, in `8g6448cc7r5ql8h` the old
    `projects.createRule`, and in `g2sub1col2docs3` the old `task_subscribers.deleteRule`, each
    with the new rule's text exactly as `schema/<collection>.rules.json` holds it after the
    regen; then `bun scripts/gen_app_docs_seed.ts`. Each replaced quote drops a span of 40 or more
    characters, so `scripts/check_app_docs_history.ts` gets one `ALLOWLIST` entry per drop,
    in the existing form `['["<new seed file name>", "<slug>", "<first 60 characters of the
    dropped span>"]', "NEW_DECISION: the quoted rule now carries the key
    reach clause; the record quotes the rule as it stands"]`, the key copied from the drop the
    gate prints when run without it. In `scripts/check_app_docs_quotes.ts` the
    `Prose` description `"self-subscribe clause of createRule, textually identical to the whole
    deleteRule"` becomes `"self-subscribe clause of createRule, the first clause of the
    deleteRule"` (the quoted literal is unchanged). Gate: `bun scripts/check_app_docs_quotes.ts`.
  - `pb_hooks/counts.pb.js`, in the route and in `refuseUnbindableListRule` (the two sites the
    existing `KEEP IN SYNC` pairs): the allowed tokens become `@request.auth.id`,
    `@request.headers.x_tm_key_workspace` and `@request.headers.x_tm_key_projects`; the route
    substitutes them with `{:authId}`, `{:keyWorkspace}`, `{:keyProjects}` and binds
    `keyWorkspace: String(e.request.header.get("X-Tm-Key-Workspace") || "")`, `keyProjects:
    String(e.request.header.get("X-Tm-Key-Projects") || "")`; the 500 messages name the three
    tokens. The `{:` refusal stays. `refuseUnbindableListRule`'s message
    `"project_items listRule may reference @request.auth.id only: "` becomes
    `"project_items listRule may reference @request.auth.id and the API-key reach headers only: "`,
    and `tests/test_pb_migrate.ts` (listed in Files) expects
    `"may reference @request.auth.id and the API-key reach headers only"` in its check
    "...output names the guard's refusal".
- **Tests** (`tests/test_key_reach.ts`, port 8211; Alice owns WA (projects PA1, PA2; tasks T1 in
  PA1, T2 in PA2, T0 under no project, so in WA's container; a comment by Alice on T1 and one on
  T2, which also create task_activity rows; a pending invitation of x@example.com to WA) and WB
  (project PB1; task T3 in it; a pending invitation of y@example.com to WB); keys: `kAll` write
  all, `kWA` write workspace WA, `kP1` write projects [PA1]):
  - "kWA lists tasks → only WA's, totalItems = WA's count" (RED first: WB's tasks listed).
  - "kWA views a WB task → 404"; "kWA PATCH a WB task → 404"; "kWA DELETE a WB task → 404,
    still live".
  - "kWA creates a task in WB → 400, nothing stored"; "kWA creates a task in WA → 200".
  - "kWA creates a task naming only a WB project → 400".
  - "kWA lists workspaces → [WA]"; "kWA views WB → 404".
  - "kWA creates a workspace → 403 api_key_reach".
  - "kWA PATCH its user_settings → 403 api_key_reach"; "kWA GET user_settings → 200".
  - "kP1 lists tasks → [T1] (not T2, not T0 in WA's container)".
  - "kP1 lists statuses / labels / cycles / workspace_members of WA → all of them".
  - "kP1 views WA → 200"; "kP1 lists projects → [PA1]".
  - "kP1 moves its PA1 task to PA2 → 404, still in PA1"; "kP1 sets its project to '' → 404".
  - "kP1 creates a task in PA2 → 400"; "kP1 creates a task with no project → 400"; "in PA1 →
    200".
  - "kP1 creates a project → 400".
  - "kP1 lists workspace_invitations → 0 items"; "kWA lists them → only x@example.com's".
  - "kP1 lists comments → only the T1 comment"; "kP1 lists task_activity → only rows whose
    task is T1".
  - "kP1 expands `project` of a PA1 task → present"; "kWA expands a task's `workspace` → present".
  - "forged x_tm_key_workspace: WB, X-Tm-Key_Workspace: WB and X-Tm-Key-Workspace: WB on
    Alice's session each list WA's and WB's tasks, eight times running" (RED first for the
    underscore spellings with a naive `del`).
  - "kWA with forged x_tm_key_workspace: '' lists only WA's tasks, eight times running";
    "kP1 with forged x_tm_key_projects: '' lists only PA1's, eight times running".
  - "a forged X-Tm-Key-Workspace: WB on Alice's session lists WA's and WB's tasks" (the header
    is removed).
  - "a forged X-Tm-Key-Workspace on kAll → both workspaces" (removed).
  - "kWA GET /api/tracker/project-items/counts → only WA's items"; "kP1 → only PA1's".
  - "kAll lists tasks of both workspaces" (control).
  - "Alice's session behaves as before on every case above" (lists both workspaces).
- **Gate**: `bun tests/test_key_reach.ts`; `bun tests/test_counts_route.ts`; `bun
  tests/test_api_keys.ts`; `bun tests/test_access_rule_holes.ts`; `make check-static`.

### Phase 5: reach in custom routes

- **Goal**: every custom tracker route applies a limited key's reach (contract,
  Classification: custom tracker routes; "`GET /api/tracker/me` under a key").
- **Files**:
  - modify `pb_hooks/me.pb.js`
  - modify `pb_hooks/routes.pb.js`
  - modify `pb_hooks/main.pb.js`
  - modify `pb_hooks/notify.pb.js`
  - modify `pb_hooks/lib/routes.js`
  - regen `openapi.json` via `bun scripts/gen_openapi.ts`, `clients/tm/src/api.generated.ts` via `bun scripts/gen_tm_client.ts`
  - create `tests/test_key_reach_routes.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
- **Steps** (each handler: `const reach = require(`${__hooks}/lib/api_keys.js`).keyReach(e.get("tmApiKey"));`):
  - (Every SQL clause below is inserted into the query's `WHERE`, before any `ORDER BY` or
    `LIMIT`.) `pb_hooks/me.pb.js`: when `reach`, add `AND w.id = {:kw}` to the workspace query and
    bind `kw`. When `reach && reach.projects`: in the counts query, the projects subquery adds
    `AND instr({:kp}, ',' || p.id || ',') > 0` and the tasks subquery adds `AND k.project != ''
    AND instr({:kp}, ',' || k.project || ',') > 0`, binding `kp = "," +
    reach.projects.join(",") + ","`; `manage` and `own` are also ANDed with `!(reach &&
    reach.projects)`. (`key` already carries `reach`, `workspace`, `projects` since Phase 2.)
  - `pb_hooks/routes.pb.js`:
    - search (`GET /api/tracker/search`): in `search()`, when `reach`, append
      `" AND " + coll + ".workspace = {:kw}"`; when `reach.projects`, append for the item arms
      `" AND " + coll + ".project != '' AND instr({:kp}, ',' || " + coll + ".project || ',') > 0"`
      and for the projects arm `" AND instr({:kp}, ',' || projects.id || ',') > 0"`; bind `kw`,
      `kp` (as in me).
    - trash (`GET /api/tracker/trash`) lists trashed items only (`project_items` holds tasks,
      decisions, documents and milestones; a trashed project is never a row), so no project
      rule is needed. After the trashed-workspace 404: `if (reach && wsId !==
      reach.workspace) throw new NotFoundError("not found");`; when `reach.projects`, `where +=
      " && project != '' && {:kpf} ~ project"` with `params.kpf = reach.projects.join(",") ||
      "-"`.
    - export (`POST /api/tracker/export`), after the membership 404: `if (reach && wsId !==
      reach.workspace) throw new NotFoundError("not found");`. When `reach.projects`:
      `selectedProjectIds` = (the body's list when non-empty, else every readable id) filtered to
      `reach.projects`; `projNarrow` omits its `project = ''` and container arms and, for an
      empty selection, returns `" && project = '-'"`; `labelsOut` becomes `fetchScoped("labels", { project: !reach || !reach.projects })` (whole for
      a project key, as today otherwise);
      `activityOut` keeps a taskless row only when `!reach.projects`.
    - workspaces trash (`GET /api/tracker/workspaces/trash`): when `reach`, the filter gains
      `" && id = {:kw}"`.
    - deletion-impact: after the owner check, `if (reach && (wsId !== reach.workspace ||
      reach.projects)) throw new NotFoundError("workspace not found");`.
    - vocab, resolve-member-email, transfer-ownership: after the workspace is loaded, `if (reach
      && wsId !== reach.workspace) throw new NotFoundError("workspace not found");` (the
      message each route already uses for an unknown id).
  - `pb_hooks/main.pb.js`, summary: when `reach`, the filter gains `' && workspace = {:kw}'`;
    when `reach.projects`, `' && project != "" && {:kpf} ~ project'`; bind them.
  - `pb_hooks/notify.pb.js`, read-all: when `reach`, append `" AND notifications.workspace =
    {:kw}"`; when `reach.projects`, append `" AND ((notifications.task != '' AND EXISTS (SELECT
    1 FROM tasks kt WHERE kt.id = notifications.task AND instr({:kp}, ',' || kt.project || ',')
    > 0)) OR (notifications.document != '' AND EXISTS (SELECT 1 FROM documents kd WHERE kd.id =
    notifications.document AND instr({:kp}, ',' || kd.project || ',') > 0)) OR
    (notifications.decision != '' AND EXISTS (SELECT 1 FROM decisions kc WHERE kc.id =
    notifications.decision AND instr({:kp}, ',' || kc.project || ',') > 0)))"`; bind.
  - Each edited site carries one comment line, naming no file (free-form for
    `check_keep_in_sync`), verbatim: in search, trash, export and summary
    `// KEEP IN SYNC: the item reach clause of the key reach rules (NEW_DECISION).`;
    in read-all `// KEEP IN SYNC: the notifications reach clause of the key reach rules (NEW_DECISION).`
- **Tests** (`tests/test_key_reach_routes.ts`, port 8212; fixtures as Phase 4, plus keys
  `kWAmanage` (manage, workspace WA) and `kWAown` (own, workspace WA), plus a pending
  invitation for Alice to WC, notifications for Alice on a PA1 task, a PA2 task and a WB task,
  one trashed task in each of PA1, PA2 and WB, and, after every other case has run, Alice's session DELETEs WB
  (moving it to the trash) for the workspaces-trash cases; notifications are produced by Bob, an
  active member of both workspaces, commenting on each task; trashed tasks by Alice's session
  DELETE):
  - "kWA me lists [WA]" (RED first: [WA, WB]); "kP1 me counts.projects = 1, counts.open_items
    = PA1's open tasks"; "kP1 me manage false, own false"; "kWA me key.reach workspace,
    key.workspace WA"; "kAll me key.reach all"; "kP1 me unread_notifications = 1 (only the PA1 one)".
  - "kWA me/landing → 403 api_key_reach"; "switch → 403"; "invitations/mine → 403"; "accept →
    403 api_key_reach (before level)"; "PATCH users/{id}/settings → 403"; "GET
    users/{id}/settings → 200".
  - "kWA search for a word in WA and WB titles → WA hits only"; "kP1 → PA1 hits only, no
    project hit other than PA1".
  - "kWA summary counts WA's tasks only"; "kP1 → PA1's only".
  - "kWA trash?workspace=WB → 404"; "kP1 trash?workspace=WA → only the PA1 trashed task".
  - "kWA export WB → 404"; "kP1 export WA → tasks only from PA1, every status and label of
    WA, no taskless activity"; "kP1 export WA projects [PA2] → no tasks".
  - "kWA workspaces/trash → [] (WA is live; WB, trashed in the fixture's last step, is left
    out)"; a control "Alice's session workspaces/trash → [WB]".
  - "kWAown deletion-impact WB → 404"; "kP1 deletion-impact WA → 404".
  - "kWAmanage vocab WB → 404"; "kWAmanage resolve-member-email WB → 404"; "kWAown
    transfer-ownership of WB → 404".
  - "kWA read-all → only WA notifications marked read; the WB one stays unread"; "kP1 read-all
    → only the PA1 one".
- **Gate**: `bun tests/test_key_reach_routes.ts`; `bun tests/test_me_route.ts`; `bun
  tests/test_search.ts`; `bun tests/test_export.ts`; `bun tests/test_counts_route.ts`; `bun
  scripts/gen_openapi.ts --check`; `make check-static`.

### Phase 6: realtime and files

- **Goal**: realtime events and protected files follow reach (contract, Realtime, Files).
- **Files**:
  - modify `pb_hooks/lib/api_keys.js`
  - modify `pb_hooks/api_keys.pb.js`
  - create `tests/test_key_reach_live.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
  - modify `docs/readiness/agent-clients.md`
  - modify `e2e/smoke.ts`
  - modify `e2e/README.md`
- **Steps**:
  - `pb_hooks/lib/api_keys.js` adds, and exports, `function inReach(app, name, rec, reach)` (`rec` a plain
    object of field values): with `W = reach.workspace`, `P = reach.projects`,
    `inP = id => !!id && P.indexOf(id) !== -1`, `item = (ws, pr) => ws === W && (P === null ||
    inP(pr))`, `parent = (coll, id) => { try { const r = app.findRecordById(coll, id); return
    item(r.getString("workspace"), r.getString("project")); } catch (_) { return false; } }`:
    `workspaces` → `rec.id === W`; `workspace_members`, `labels`, `statuses`, `cycles` →
    `rec.workspace === W`; `workspace_invitations` → `rec.workspace === W && P === null`;
    `projects` → `rec.workspace === W && (P === null || inP(rec.id))`; `tasks`, `decisions`,
    `documents`, `milestones`, `templates`, `saved_views` → `item(rec.workspace, rec.project)`;
    `comments` → the first set of `task`, `document`, `decision` through `parent`, else false;
    `task_subscribers` → `parent("tasks", rec.task)`; `task_activity` → `rec.task ?
    parent("tasks", rec.task) : rec.workspace === W && P === null`; `notifications` →
    `rec.workspace === W && (P === null || (rec.task && parent("tasks", rec.task)) ||
    (rec.document && parent("documents", rec.document)) || (rec.decision &&
    parent("decisions", rec.decision)))`; `users`, `user_settings`, `app_docs`, `app_settings` →
    true; any other → false. Its comment: `// KEEP IN SYNC: the C_* clauses of the key reach
    rules migration.`
  - `pb_hooks/api_keys.pb.js`:
    - In the existing `onRealtimeSubscribeRequest`, after the api_keys check and before
      `e.next()`: look the key up as the middleware does (`$app.findFirstRecordByData("api_keys",
      "key_hash", $security.sha256(header))`, the hook already holds `header`; the middleware
      has already refused an invalid key), then `const reach = lib.keyReach(lib.keyInfo(key));` with `const lib = require(`${__hooks}/lib/api_keys.js`)`
      inside the handler. When `reach`, refuse every subscription whose string carries
      `?options=` with a `query.expand` (decode the value after `options=` with
      `decodeURIComponent` and `JSON.parse`; a value that does not parse is refused too) with
      403 `api_key_reach` and `lib.REACH_MESSAGE`: PocketBase checks a subscription's expansions
      with the subscription's own headers, which carry no reach. Then if (reach) e.client.set("apiKeyReach", JSON.stringify(reach)); else
      e.client.unset("apiKeyReach");`.
    - New `onRealtimeMessageSend((e) => { ... })`, whose body starts with `const lib =
      require(`${__hooks}/lib/api_keys.js`);` (hook handlers cannot call top-level functions):
      `const raw = e.client.get("apiKeyReach"); if
      (!raw) return e.next();` parse it; `const name = String(e.message.name);` if `name ===
      "PB_CONNECT"` → `e.next()`; parse `data = JSON.parse(typeof e.message.data === "string" ?
      e.message.data : toString(e.message.data))` inside `try`, a failure returns without
      `e.next()`; when `name` starts with `"rt:project_items:"` the verdict is
      `inReach($app, data.collection, data.rawRecord || {}, reach)`; otherwise the collection is
      `name.split("?")[0].split("/")[0]` resolved with
      `$app.findCachedCollectionByNameOrId(...)` (a miss drops) and the verdict is
      `inReach($app, coll.name, data.record || {}, reach)`. In reach → `return e.next()`;
      otherwise return without calling it.
    - Middleware, after the level check: `if (route === "/api/files/{collection}/{recordId}/{filename}")
      { const q = e.request.url.query(); q.set("token", owner.newFileToken());
      e.request.url.rawQuery = q.encode(); }` with the comment `// A key downloads as itself, so
      the record's viewRule sees its reach; a user file token would not carry it.`
  - `docs/readiness/agent-clients.md` AC-3: verdict `met`; evidence `tests/test_key_reach.ts`,
    `tests/test_key_reach_routes.ts`, `tests/test_key_reach_live.ts`, citing the checks "kWA
    lists tasks → only WA's, totalItems = WA's count", "kWA search for a word in WA and WB titles
    → WA hits only" and "kWA subscribed to tasks/* receives a WA create, not a WB create"; gap
    removed.
  - `e2e/smoke.ts` `probe_key_reach()`: with the fixture session create workspace "Smoke B"
    and a task in it, mint `{ scope: "write", reach: "workspace", workspace: <provisioned
    workspace id> }`; under the key: `GET /api/collections/tasks/records` lists no "Smoke B"
    task; `GET` that task by id → 404; `POST /api/collections/workspaces/records` → 403
    `api_key_reach`. Add immediately before `probe_forged_client_address`; list it in
    `e2e/README.md` (listed in Files).
- **Tests** (`tests/test_key_reach_live.ts`, port 8213; fixtures as Phase 4, tasks in PA1 and
  PA2 and WB each with one attachment, read through `roomkit.SSEListener`):
  - "kWA subscribed to tasks/* receives a WA create, not a WB create" (RED first: both).
  - "kWA subscribed to tasks/* with options.headers x_tm_key_workspace '' still receives no WB
    event".
  - "kP1 subscribing to tasks/* with options query expand=parent → 403 api_key_reach";
    "kAll with the same subscription → 204" (control).
  - "kP1 subscribed to rt:project_items:WA receives a PA1 task update, not a PA2 one".
  - "kWA subscribed to rt:project_items:WB receives nothing".
  - "kP1 subscribed to comments/* receives a comment on a PA1 task, not one on a PA2 task".
  - "kP1 receives the delete of a PA1 comment".
  - "kAll receives every event" (control); "Alice's session receives every event" (control).
  - "kP1 downloads the PA1 attachment with its key, no token → 200, content matches".
  - "kP1 downloads the PA2 attachment → 404"; "kWA downloads the WB attachment → 404".
  - "kP1 downloads the PA2 attachment with a file token Alice's session minted → 404" (the
    key's reach still applies; the token is replaced).
  - "kP1 POST /api/files/token → 403 api_key_reach"; "kAll POST /api/files/token → 200".
  - "Alice's session file token alone downloads the PA2 attachment → 200" (control: sessions
    unchanged).
- **Gate**: `bun tests/test_key_reach_live.ts`; `bun tests/test_realtime.ts`; `bun
  tests/test_api_keys.ts`; `bun tests/test_file_storage.ts`; `make check-static`; `make smoke`.

### Phase 7: OAuth consent and MCP tool listing

- **Goal**: consent offers a workspace and the levels the client asked for, the minted key
  carries them through refresh, and every level above `read` lists every tool (contract, OAuth
  and MCP tool listing; spec "OAuth consent sets the same limits"). Built on
  `hosted-mcp-endpoint` as designed at lane `d-mcp` `3fa24a9` (D7, D11, D13 to D15, D19).
- **Files**:
  - create `pb_migrations/<slot>_oauth_codes_reach.js`
  - create `pb_migrations/<slot2>_seed_app_docs.js` (`<slot2>` the next slot after `<slot>`)
  - modify `scripts/gen_app_docs_seed.ts` (`DEFAULT_OUTPUT`)
  - modify `scripts/check_app_docs_history.ts` (`ALLOWLIST`)
  - modify `pb_hooks/lib/oauth.js`
  - modify `pb_hooks/oauth_server.pb.js`
  - modify `pb_hooks/views/oauth_authorize.html`
  - modify `services/mcp/src/app.ts`
  - modify `clients/tm/src/mcp.ts`
  - modify `tests/oauthkit.ts`
  - create `tests/test_oauth_key_limits.ts`
  - modify `tests/test_mcp_service.ts`, `tests/test_tm_mcp.ts`, `tests/test_oauth_token.ts`
  - modify `e2e/smoke.ts`
  - modify `e2e/README.md`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
  - regen: `schema/` and `pb_hooks/field_patterns.json` via `bun scripts/gen_schema.ts`,
    `scripts/model/` via `bun scripts/model/extract_current.ts`, the new seed and
    `scripts/app_docs_seed.sha256` via `bun scripts/gen_app_docs_seed.ts`, `.gitattributes` via
    `bun scripts/gen_gitattributes.ts`, `openapi.json` via `bun scripts/gen_openapi.ts` and
    `clients/tm/src/api.generated.ts` via `bun scripts/gen_tm_client.ts` (whatever they produce
    for the changed `oauth_codes` collection).
- **Steps**:
  - `<slot>_oauth_codes_reach.js`, header `// oauth_codes: a sign-in's level may be manage or
    own, and its workspace choice rides to the minted key (NEW_DECISION).` Up, on
    `oauth_codes` (`oauthcodes00001`): the `scope` field's `values` become `["read", "write",
    "manage", "own"]`, its help `The level the person granted: read, write, manage or own.`;
    add `reach` (select, id `select4300100010`, values `all`, `workspace`, maxSelect 1, not
    required, help `Every workspace, or the one workspace the person chose; empty means every
    workspace.`) and `workspace` (relation to `workspaces` `pbc_300100001`, id
    `relation4300100011`, maxSelect 1, minSelect 0, cascadeDelete true, not required, help `The
    workspace the person chose, or empty for every workspace.`). Every rule stays `null`. Down:
    remove the two fields, restore `values` `["read", "write"]` and the help `The access the
    person granted.`.
  - Seed, as hosted-mcp-endpoint Phase 3 does: `cp` the newest `pb_migrations/*_seed_app_docs.js`
    to `<slot2>_seed_app_docs.js`, set `DEFAULT_OUTPUT` to it, and in record `oauthcodesdoc01`'s
    `body` replace `scope (read or write)` with `scope (read, write, manage or own), reach (all or
    workspace) and workspace, which carry the person's workspace choice to the minted key`, and
    append `" The minted key keeps its scope, reach and workspace through every refresh
    (NEW_DECISION)."`; then run the generator and `gen_gitattributes`. Every span of 40 or more
    characters the reword drops gets an `ALLOWLIST` entry in `scripts/check_app_docs_history.ts`
    in the form Phase 2 uses, keyed `["<slot2>_seed_app_docs.js", "collection:oauth_codes",
    "<first 60 characters of the dropped span>"]`, reason `"NEW_DECISION: oauth_codes gained the
    manage and own levels and the workspace choice; the field list now says so"` (written out in
    full), the key copied from the drop the gate prints.
  - `pb_hooks/lib/oauth.js` (add to `module.exports`: `LADDER`, `offered_levels`,
    `consent_workspaces`):
    - `const LADDER = require(`${__hooks}/lib/api_keys.js`).LEVELS;` inside each function that
      uses it (pooled JSVM: no top-level `require` result is shared), so the ladder has one copy.
    - `parse_scope(raw)`: absent or blank is `write` (unchanged); each space-separated value must
      be one of `LADDER` or `offline_access` (ignored), else invalid as today; the result is
      the value of `LADDER` with the highest index named, and `read` when only `offline_access`
      is named (as today) (so `write` alone is `write`, `manage` alone is `manage`, `read` alone
      is `read`).
    - `scope_text(scope)`: `LADDER.slice(0, LADDER.indexOf(scope) + 1).join(" ")` (`read`,
      `read write`, `read write manage`, `read write manage own`).
    - `offered_levels(requested)`: `LADDER.slice(0, Math.max(2, LADDER.indexOf(requested) + 1))`
      (read and write always; manage and own only when requested, per ruling 6).
    - `consent_workspaces(app, uid)` (one comment line above it, verbatim: `// KEEP IN SYNC: the
      workspace check of the api_keys create hook in pb_hooks/api_keys.pb.js, an owner or a
      \`status = 'active'\` member.`): the rows of `app.db().newQuery("SELECT w.id AS id, w.name AS
      name FROM workspaces w WHERE w.trashed = '' AND (w.owner = {:u} OR EXISTS (SELECT 1 FROM
      workspace_members m WHERE m.workspace = w.id AND [[m.user]] = {:u} AND m.status =
      'active')) ORDER BY w.created, w.id").bind({ u: uid }).all(rows)` with `rows =
      arrayOf(new DynamicModel({ id: "", name: "" }))`, returned as `[{ id, name }]`.
    - `issue_code(app, user, client, params, scope, reach, workspace)`: two new trailing
      parameters, stored on the `oauth_codes` row as `reach` and `workspace`.
  - `pb_hooks/oauth_server.pb.js`:
    - `GET /.well-known/oauth-authorization-server`: `scopes_supported` becomes `["read",
      "write", "manage", "own"]`.
    - Rendering the `consent` stage (every place D14 renders it): data gains `Levels`, the list
      `offered_levels(parse_scope(params.scope))` mapped to `{ Value, Label, Checked }` with
      `Checked: value === parse_scope(params.scope)` (the requested level; for `scope=read`,
      `read`), and `Workspaces`, `consent_workspaces($app, uid)`
      mapped to `{ Id, Name }`. Labels: `read` "Read: see your workspaces, projects and
      items."; `write` "Read and write: also create, edit and comment on items."; `manage`
      "Manage: also change workspace settings, invitations and members, and empty the trash.";
      `own` "Own: also change roles, hand over or delete workspaces, and accept invitations."
      The data field `Access` is removed.
    - `approve` branch, before `issue_code`: read `access` and `const workspace = form.workspace
      || ""` from the parsed form (absent means `""`, every workspace, as D14 treats an empty
      value as absent).
      `access` not in `offered_levels(parse_scope(params.scope))`, or a `workspace` other than
      `""` whose id is not in `consent_workspaces($app, uid)`, re-renders `consent` (status 200,
      hosted-mcp-endpoint D19) with `Message` "Choose one of the options shown." and no code.
      Otherwise `issue_code(..., access, workspace ? "workspace" : "all", workspace)`.
    - `POST /oauth/token`, authorization code grant, the minted `api_keys` record also sets
      `reach` to the code row's `reach` or `"all"` when empty, and `workspace` to the code row's
      `workspace`. Inside the same transaction, before minting, when the row's `workspace` is
      not `""` and is not among `consent_workspaces(tx, <row user>)` (Alice was suspended or the
      workspace trashed within the code's ten minutes), the exchange answers `invalid_grant`
      "The code is unknown, used or expired." (the code is consumed, as D15's other failures
      are). The answer's `scope` is `scope_text(<row scope>)`. (The record is saved with
      `tx.save`, so Phase 2's request-tier validation does not run; these two checks are its
      validation.)
    - Refresh: unchanged code; `parse_scope` now reads `read write manage` as `manage`, so a
      refresh naming the granted ladder matches the record and any other value answers
      `invalid_scope` as today.
  - `pb_hooks/views/oauth_authorize.html`, `consent` block, inside its `<form>`: replace the two
    fixed `access` radios with `<fieldset><legend>Access</legend>{{range .Levels}}<label><input
    type="radio" name="access" value="{{.Value}}"{{if .Checked}} checked{{end}}>
    {{.Label}}</label>{{end}}</fieldset>`, and before it add `<fieldset><legend>Workspaces</legend>
    <label><input type="radio" name="workspace" value="" checked> All workspaces</label>{{range
    .Workspaces}}<label><input type="radio" name="workspace" value="{{.Id}}">
    {{.Name}}</label>{{end}}</fieldset>`.
  - `services/mcp/src/app.ts`: D7's check accepts `key.scope` in `["read", "write", "manage",
    "own"]` (anything else stays 503 `unavailable`); the PRM document's `scopes_supported`
    becomes `["read", "write", "manage", "own"]`. Step 8 (`insufficient_scope` for a write tool
    under a `read` key) is unchanged.
  - `clients/tm/src/mcp.ts`: `type Scope = "read" | "write" | "manage" | "own"`; `tools_for` is
    unchanged (`read` keeps the read-only tools, every other scope keeps all).
  - `tests/oauthkit.ts` adds `sign_in_to_consent(base, params, who): Promise<{ status: number;
    html: string; flow: string }>` (GET the page, post `action=password`, return the consent
    page and its `flow` field) and `post_consent(base, params, flow, fields: Record<string,
    string>): Promise<Response>` (post `/oauth/authorize` with the eight parameters, `flow`,
    and `fields`, redirects not followed); and `sign_in_and_approve`'s last parameter becomes `opts: "read" | "write" |
    "manage" | "own" | { access?: "read" | "write" | "manage" | "own"; workspace?: string } =
    "write"` (a string is `{ access: <it> }`; `access` defaults to `"write"`); the approve post
    adds `workspace=<opts.workspace>` when it is given. Existing callers are unchanged.
  - `.agents/rules/ports.md`: `8215 = test_oauth_key_limits` in ascending port order before
    `9700 = test_script_help`.
  - `e2e/smoke.ts`: `probe_oauth_scopes()`: `GET /.well-known/oauth-authorization-server` →
    `scopes_supported` `["read", "write", "manage", "own"]`; inserted immediately before
    `probe_forged_client_address`; listed in `e2e/README.md` (listed in Files).
- **Tests** (`tests/test_oauth_key_limits.ts`, port 8215, booted as `tests/test_oauth_authorize.ts`
  is: env `MCP_PUBLIC_URL=http://mcp.test`, the superuser raising the `/oauth/` rule to 100000
  right after boot, helpers from `tests/oauthkit.ts`, base request `authorize_params()`; users:
  Alice (verified, approved), whose provisioned workspace (read from her session's `/me`) is WA;
  her session creates WB, then WT and DELETEs WT (moving it to the trash); Bob owns his
  provisioned workspace WC, and the superuser creates `workspace_members` `{ workspace: WC, user:
  Alice, role: "member", status: "suspended" }`; consent pages are read with
  `sign_in_to_consent` and forms posted with `post_consent`; write `consent_lists_workspaces`
  first and watch it fail):
  - `consent_lists_workspaces`: sign Alice in, read the consent page: radios `workspace` with
    values `""` (checked), WA, WB in that order; no WT, no WC.
  - `consent_levels_read`: request `scope=read`: `access` radios `read`, `write`, `read` checked.
  - `scope_offline_only`: request `scope=offline_access`: `read`, `write`, `read` checked.
  - `consent_levels_default`: request `scope=read write`: `access` radios `read`, `write`, `write`
    checked; no `manage`, no `own`.
  - `consent_levels_manage`: `scope=manage`: `read`, `write`, `manage`, `manage` checked.
  - `consent_levels_own`: `scope=own`: all four, `own` checked.
  - `approve_workspace_write`: `{ access: "write", workspace: WA }`, exchange: 200, `scope` `read
    write`; the key's `GET /api/tracker/me`: `key.reach` `workspace`, `key.workspace` WA,
    `workspaces` ids `[WA]`.
  - `approve_all_default`: `{ access: "write" }`: `key.reach` `all`; the ids of `workspaces`
    entries whose `status` is `active` are `[WA, WB]` (WC is listed `suspended`, as `/me`
    lists every membership).
  - `approve_manage`: `scope=manage`, `{ access: "manage" }`: token `scope` `read write manage`;
    `key.scope` `manage`.
  - `approve_lower_than_asked`: `scope=own`, `{ access: "read" }`: token `scope` `read`.
  - `forged_level`: `scope=read write`, post `access=own`: 200 consent page containing "Choose
    one of the options shown."; no `Location`; superuser lists no `oauth_codes` row for Alice.
  - `forged_workspace`: post `access=write`, `workspace=<WC id>`: same as `forged_level`; also
    with WT's id.
  - `suspended_before_exchange`: approve `{ access: "write", workspace: WB }`, then Alice's
    session DELETEs WB (to the trash; run after every case that expects WB live), then exchange: 400
    `invalid_grant`; no `api_keys` record named `Cursor` for WB.
  - `refresh_keeps_limits`: from `approve_workspace_write`'s grant, refresh with
    `scope=read write`: 200; superuser reads the record: `reach` `workspace`, `workspace` WA,
    `scope` `write`, same id; refresh with `scope=read write manage`: 400 `invalid_scope`.
  - `metadata_scopes`: `GET /.well-known/oauth-authorization-server`: `scopes_supported`
    `["read", "write", "manage", "own"]`.
  - `workspace_purged`: on a fresh workspace WP Alice's session creates, approve `{ access:
    "write", workspace: WP }` and exchange; the superuser DELETEs WP (a superuser deletes for
    good); the key answers 401 `api_key_invalid` on `/me` (the `api_keys.workspace` cascade,
    Phase 2).
- **Tests** (`tests/test_mcp_service.ts`, hosted-mcp-endpoint Phase 6's suite, which gains a
  manage key `M` for Alice):
  - `tools_list_manage_key`: `tools/list` under `M`: every `TOOLS` name in catalog order (RED
    first: 503 `unavailable`).
  - `prm_doc` and `prm_root_doc`: their expected document's `scopes_supported` becomes
    `["read", "write", "manage", "own"]`.
  - `tool_call_out_of_reach`: a key `{ scope: "write", reach: "workspace", workspace: <Alice's
    provisioned workspace> }` calls `tm_show` on an item of a second workspace Alice's session
    creates: `isError` true, `structuredContent.error.status` 404, `code` `not_found`.
- **Tests** (`tests/test_oauth_token.ts`): `as_metadata`'s expected document gets
  `scopes_supported` `["read", "write", "manage", "own"]`.
- **Tests** (`tests/test_tm_mcp.ts`): `list_manage_key`: a manage key's `tools/list`: every
  `TOOLS` name, in catalog order.
- **Gate**: `bun tests/test_oauth_key_limits.ts`; `bun tests/test_oauth_authorize.ts`; `bun
  tests/test_oauth_token.ts`; `bun tests/test_mcp_service.ts`; `bun tests/test_tm_mcp.ts`; `make
  check-static`; then, as the last phase of the change, `make check` and `make smoke`.

## Risks

- **A new collection or custom route skips reach.** Caught by: Phase 3's classification test
  for levels; for reach, `inReach` returns false for any collection not listed (fails closed on
  realtime), and the decision record states that a new workspace-bound collection's rules carry
  the `KW` clause. Not caught mechanically for a new custom route: recorded as a follow-up gate
  candidate in the lane report.
- **Rule text grows.** Every workspace-bound rule gains one clause; `project_items`' rule is
  bound by `counts.pb.js`, which Phase 4 teaches the two new tokens. Caught by
  `tests/test_counts_route.ts` and `check_view_within_list`.
- **Hook order.** Only the role-change check is a record hook; its precedence against other
  refusals is stated as unfixed. The purge and leave checks live in the middleware, so no hook
  order touches them.
- **Realtime cost.** One `inReach` per message per limited-key client, with at most one record
  read for comments, subscriptions, activity and notifications. Accepted at current scale;
  memoize per message if it shows in profiles.
- **Existing write keys lose powers** (ruling 5). Stated in the decision record and contract
  Compatibility; a key needing them is reissued.
- **Hosted MCP built differently from its design.** Phase 7 names that change's files and ids
  as its design (lane `d-mcp` `3fa24a9`) fixes them; a builder finding one renamed stops and
  reports rather than guessing.

## Open Questions

None. Every choice the contract left open is settled above.

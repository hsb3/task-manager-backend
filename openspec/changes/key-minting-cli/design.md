# Design

How the contract is met. Build order: this change follows `hosted-mcp-endpoint` and `key-scoping`
and precedes `tm-distribution`; Depends on lists what each earlier change must already have put on
main. Steps marked *(assumes Q n)* follow the recommended answer to Open Question n.

## Decisions

### Server

1. **Two fields on `api_keys`, no new collection.** `manage_keys` (bool, id `bool4200609001`) and
   `last_used` (date, id `date4200609002`), added by one migration. Alternative: a separate
   `api_key_permissions` collection; rejected because a key has exactly one such permission and
   the middleware already loads the key record (`pb_hooks/api_keys.pb.js`, `tmkApiKeyAuth`).
2. **Who sets `manage_keys`.** The create request hook (`onRecordCreateRequest` for `api_keys`,
   `pb_hooks/api_keys.pb.js`) sets it to `false` unless `e.hasSuperuserAuth()`, and always sets
   `last_used` to `""`. The token endpoint of the hosted-mcp-endpoint build mints records with
   `$app.save` outside that hook and sets `manage_keys` itself. The update rule gains
   `@request.body.manage_keys:isset = false && @request.body.last_used:isset = false` (top-level
   conjuncts, as the existing locks: header comment of `v2:1785186000_api_keys.js`). A room probe
   (2026-11-10) showed that without the hook a session create carrying `"manage_keys": true`
   stores it. A superuser may set it so that suites can make a manage-keys key without the
   browser flow, as a superuser may already mint for any user.
3. **Key routes are custom routes, not the collection API.** `GET /api/tracker/keys` and
   `POST /api/tracker/keys/{id}/revoke`, registered in `pb_hooks/lib/routes.js` with
   `auth: "users"` and handled in a new `pb_hooks/api_key_manage.pb.js`. Opening `api_keys`
   collection routes to some keys would reopen what decision:api-key-reads-refused closed
   (relation joins and realtime cannot tell a key from its owner); a route answers a fixed
   shape and nothing else. `/api/tracker/` routes already pass the key allowlist. Prior art:
   GitHub's and Linear's key lists live in the signed-in web app (proposal, Prior art); no
   surveyed product exposes key management to a key, which is why this needs a new decision
   record (Depends on).
4. **How a handler knows the key.** The hosted-mcp-endpoint build's `tmkApiKeyAuth` stores
   `e.set("tmApiKey", { id, scope, expires, client_id })`, a plain object that `GET
   /api/tracker/me` returns as `key` (its design D19: "a later change adds its own properties to
   that object in the same `e.set` call"). This change adds `manage_keys:
   key.getBool("manage_keys")` to that call, so `/me` reports it with no `me.pb.js` change, and
   handlers read `e.get("tmApiKey")`, which is `null` under a session (truth review's room
   probe), testing it for truthiness and reading `.id` and `.manage_keys`. The `e.set`/`e.get`
   pair was proven in a room on PocketBase 0.40.4 (2026-11-10), inside the real `tmkApiKeyAuth`
   (priority -1030).
5. **Revoke under a read-scoped key.** The middleware's read list gains
   `POST /api/tracker/keys/{id}/revoke` (route pattern), because the permission, not the scope,
   governs it (proposal, ruling 2: "lists and revokes"). The handler refuses a key without
   `manage_keys`. `scripts/gen_openapi.ts` `key_access` mirrors it (KEEP IN SYNC marker on both).
6. **Refusal code `api_key_manage`.** New, beside `api_key_path`, `api_key_scope` and
   `api_key_invalid`, so a client can tell "this key may not manage keys" from "keys never reach
   this route". Message: `This API key cannot list or revoke keys.`
7. **Revoking an id that is not the caller's** answers 404 `No key with that id among yours.`, the
   same as an id that does not exist, so ids of other users' keys are not confirmed (GitHub's
   404-for-private convention, cited in key-scoping's proposal).
8. **`last_used`, to the minute, by a raw update.** In `tmkApiKeyAuth`, after the key passes every
   check and before `e.next()`: when `last_used` is empty or more than 60 seconds old,
   `$app.db().newQuery("UPDATE api_keys SET last_used = {:t} WHERE id = {:id}").bind({ t: new
   DateTime().string(), id: key.id }).execute()`, inside `try`/`catch` that logs
   `$app.logger().warn("api key last_used write failed", "key", key.id, "error", String(err))` and
   never fails the request. A raw update fires no record hook, sends no realtime event and leaves
   `updated` alone: room probe 2026-11-10, `last_used` `22:13:56.390Z` after a request while
   `updated` stayed `22:13:56.379Z`. One write per key per minute at most. Alternative:
   `$app.saveNoValidate(key)`; rejected because it runs record hooks and moves `updated`. GitHub
   shows a token's last use (unverified: the page fetched 2026-11-10 does not say); the rulings
   and root's folding comment on card 1225 put the field in scope.
9. **List contents.** Every key of the user, revoked and expired included, newest first; the
   client filters to active ones by default (`--all` shows all). No pagination: a user's key
   count is small (one per login, agent and hosted connection). See Risks.

### Authorization server, client `tm`

10. **`tm` is pre-registered** with redirect `http://127.0.0.1/callback`, any port; `127.0.0.1`
    rather than `localhost` because RFC 8252 §8.3 says "the use of localhost is NOT
    RECOMMENDED" (fetched 2026-11-10).
11. **`keys` is a scope token** honoured only for `client_id=tm`, absent from
    `scopes_supported`. Alternative: a separate `manage_keys=1` parameter; rejected because the
    granted permission has to come back in the token response's `scope`, which is how a client
    learns what was granted (RFC 6749 §5.1).
12. **`key_name` and `key_expires` parameters** carry `tm keys create`'s name and expiry. Ignored
    for other clients (RFC 6749 §3.1, "The authorization server MUST ignore unrecognized request
    parameters").
13. **A `tm` grant has no refresh token and, without `key_expires`, no expiry** *(assumes Q1)*.
    Prior art: `gh auth login` stores a non-expiring token unless `--expiring` is asked for
    ("A host without support issues a non-expiring token instead", https://cli.github.com/manual/gh_auth_login,
    fetched 2026-11-10); a pasted key today has no expiry unless one was chosen. Q1 asks the owner
    because the hosted-mcp-endpoint ruling gives every other grant 24 hours plus refresh.

### Client `tm`

14. **No new dependency.** Loopback listener `node:http` `createServer`, PKCE `node:crypto`
    (`randomBytes(32).toString("base64url")` gives a 43-character verifier;
    `createHash("sha256").update(v).digest("base64url")` a 43-character challenge), browser
    `node:child_process` `spawn(..., { detached: true, stdio: "ignore" }).unref()`, HTTP `fetch`.
    Proven under Bun 1.4.3 and Node 26.10.0 (spike 2026-11-10: listener on port 0, callback
    fetched, both lengths 43). `node:` only, so `tm-distribution`'s Node build needs no change here.
15. **Credential store: `Bun.secrets`** (proposal ruling 3), service `tm`, name = the server URL.
    Spike on Bun 1.4.3 (2026-11-10): on macOS `get` of a missing entry returns `null`, `set`
    overwrites, `delete` returns `true` then `false`; on Linux without libsecret every call
    rejects with an `Error` whose `code` is `"ERR_SECRETS_PLATFORM_ERROR"` ("libsecret not
    available"), and with libsecret but no D-Bus the same code ("Cannot spawn a message bus
    without a machine-id ..."). Any rejection with that code means "no store": `tm` falls back to
    the file and says so. Bun's page calls the API "new and experimental"
    (https://bun.com/docs/runtime/secrets, fetched 2026-11-10); see Risks. Under Node
    (`globalThis.Bun` undefined) the file is used *(assumes Q2)*.
16. **`TM_CREDENTIAL_STORE`** (`os` default, `file`) lets suites and operators keep the key out
    of the store. Suites set `file`, so no suite writes a developer's keychain.
17. **Module layout.** `clients/tm/src/store.ts` (where the key lives), `clients/tm/src/keys.ts`
    (key route calls), `clients/tm/src/oauth.ts` (browser sign-in), all importable without the
    MCP SDK; `clients/tm/tm.ts` parses and prints. Keeps `clients/tm/src/mcp.ts` and
    `clients/tm/src/verbs.ts` untouched.
18. **Replacing and ending a login.** On a successful `tm login` or `tm login --with-key`, the
    previously saved key (if any, and not the same key) is revoked through itself when its
    `GET /api/tracker/me` answer has `key.manage_keys` true; a 401 or network failure is ignored
    (it is being replaced). `tm logout` revokes the saved key the same way, then deletes the store
    entry and the configuration file whatever the revoke answered, because the intent is to leave
    this machine; an unrevoked key is named on standard output with the reason, and exit is 0
    when the key was revoked or already invalid (401), 1 when the server refused otherwise or did
    not answer. Prior art: `gh auth logout` "does not revoke authentication tokens"; `stripe
    logout` revokes "the session and clear[s] its local credentials" (proposal); the ruling
    follows Stripe.
19. **Piped `tm login`.** No stdin sniffing: `tm login` always runs the browser flow, and the
    contract's Compatibility tells scripts to add `--with-key`. An agent's shell often has a
    non-terminal stdin and may rightly run `tm login` for a person at the browser.
20. **Key name default** `tm on <os.hostname()>` for `tm login` (proposal).
21. **Callback page copy** (HTML, `Content-Type: text/html; charset=utf-8`): success `<p>Signed in.
    You can close this tab and return to the terminal.</p>`; failure `<p>Sign-in did not finish:
    <escaped message>. Return to the terminal for details.</p>`, status 200 for success and 400
    for failure; the message is escaped by replacing `&`, `<`, `>`, `"` and `'` with their HTML
    entities.

## Depends on

- **hosted-mcp-endpoint, built** (read on `lane/d-mcp` at `a631d7c`: design from `20568aa`, contract follow-up `a631d7c` changes nothing used here). Names
  this design uses, from that design's D13, D14, D15 and D19: hook files
  `pb_hooks/oauth_server.pb.js` (routes: `GET`/`POST /oauth/authorize`, `POST /oauth/token`,
  `POST /oauth/revoke`, metadata), `pb_hooks/lib/oauth.js` (`CLIENTS`, `parse_scope`,
  `scope_text`, `validate_request`, `issue_code`, `token_error`, the flow token's `q`),
  `pb_hooks/views/oauth_authorize.html` (the one page; radio `access` on consent, `Params` of
  eight parameters); collection `oauth_codes` (id `oauthcodes00001`, field ids `43001000xx` up
  to `autodate4300100009`, app_docs record `oauthcodesdoc01`); `api_keys` fields `client_id`,
  `refresh_hash`, `refresh_expires`, `refresh_prev_hash` (ids `4200600009`-`4200600012`; this
  change's `4200609001`/`4200609002` do not collide); the matched key as the plain object
  `e.get("tmApiKey")` `{ id, scope, expires, client_id }`, returned by `pb_hooks/me.pb.js` as
  `key`; under a key an unmatched route answers 404 (its D12); suite helpers
  `tests/oauthkit.ts` `PKCE`, `authorize_params`, `sign_in_and_approve`, `exchange`; suites
  `tests/test_oauth_token.ts` and `tests/test_oauth_authorize.ts`; pre-registered client
  `cursor`; every authorization response carries `iss`. If its follow-up contract commit renames
  any of these, the new name is used.
- **The `tmApiKey` check, before Phase 1.** Run `grep -n 'e.set("tmApiKey"\|e.set("apiKey"'
  pb_hooks/api_keys.pb.js`. If `tmApiKey` is set to an object literal, build as written. If it is
  set to the key record itself (key-scoping's Depends on lets its Phase 1 reuse that name): Phase 1
  adds no property to the `e.set` call; `pb_hooks/me.pb.js` joins Phase 1's file list and adds
  `manage_keys: k.getBool("manage_keys")` to the `key` object it builds; Phase 2's handlers test
  `via && !via.getBool("manage_keys")` and `keyItem` compares `current.id` (a record has `.id`
  too). If neither name is set, stop: the hosted build is not on main.
- **key-scoping, built** (its contract read on `lane/d-scoping` at `f1cabe1` and its design at
  `a0c8349`, Phase 7: consent radio `level`, `oauth_codes` gains `reach` and `workspace`, suite
  `tests/test_oauth_key_limits.ts`): levels `read`, `write`, `manage`, `own` stored in `scope` and requested as
  scope tokens, a requested scope read as the highest level it names and granted as the ladder up
  to the chosen level; key fields `reach` (`all`, `workspace`, `projects`), `workspace` (id or
  `""`) and `projects` (ids or `[]`). The workspace is chosen on the consent page, with no
  authorize parameter, so `tm` offers no `--workspace` flag. If a later key-scoping commit renames these,
  its names are used in Phases 2, 3b, 5 and 6.
- **A decision record** (kata, root's to file before Phase 2): "a key minted by `tm login` may
  carry a manage-keys permission that lists and revokes its user's keys and never mints",
  superseding decision:api-key-reads-refused in part. Its `app_docs` twin is written in Phase 2.
- **Shared files** another milestone change also edits: `pb_hooks/api_keys.pb.js`
  (hosted-mcp-endpoint, key-scoping), `pb_hooks/me.pb.js` (both), `pb_hooks/lib/routes.js`
  (hosted-mcp-endpoint, key-scoping, agent-verb-coverage), `scripts/gen_openapi.ts`
  (key-scoping, api-versioning-policy), `clients/tm/tm.ts` and `clients/tm/src/api.ts`
  (tm-distribution, agent-verb-coverage), `clients/tm/README.md` and `README.md`
  (tm-distribution), the newest `pb_migrations/*_seed_app_docs.js` and
  `scripts/gen_app_docs_seed.ts` `DEFAULT_OUTPUT` (every change touching `app_docs`),
  `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`,
  `docs/readiness/agent-clients.md`, `e2e/smoke.ts`.

## Implementation Plan

Quoted copy (help texts, messages, `app_docs` bodies) that wraps across lines in this file is
one line in the code, its line breaks read as single spaces. `decision:{M}` below stands for the new decision slug `decision:` followed by
`api-key-manages-keys` (written apart here because `scripts/check_decision_citations.ts` refuses a
slug before its record is seeded; the built files write it whole once Phase 2 seeds it).


Every phase ends with `make check-static` green. Rooms follow the clean-room law in `AGENTS.md`.
"Regen" means, in this order, each run alone: `bun scripts/gen_schema.ts`, `bun
scripts/gen_openapi.ts`, `bun scripts/gen_decisions.ts`, `bun scripts/gen_tm_client.ts`, `bun
scripts/model/extract_current.ts`, `bun scripts/gen_gitattributes.ts`; their outputs (`schema/`,
`openapi.json`, `docs/generated/decisions.md`, `clients/tm/src/api.generated.ts`,
`scripts/model/current/`, `.gitattributes`) belong to the phase. "Re-seed" means: copy the newest
`pb_migrations/*_seed_app_docs.js` to `pb_migrations/<slot>_seed_app_docs.js` (slot from `make
next-migration-slot`, run again after each new migration file is created, so a phase with two
new files gets two slots), set `DEFAULT_OUTPUT` in `scripts/gen_app_docs_seed.ts` to the new file,
make the record edits the phase lists in the new file, then run `bun scripts/gen_app_docs_seed.ts`
(it rewrites the seed and `scripts/app_docs_seed.sha256`) and the regen (`.agents/rules/pocketbase.md`).
A new suite is registered in three places: `run_suite "<label>" bun tests/<file>` in
`scripts/run_suite_battery.sh` after the `test_tm_client_gen` line; a row
`<shard>\t<seconds>\t<label>` in `scripts/battery_shards.tsv` with its measured seconds on the
shard whose seconds column sums lowest, inserted where it keeps the file sorted by seconds
descending, after the last row with equal seconds; and its port in `.agents/rules/ports.md`'s default list
after `8195 = test_route_errors`, in ascending port order. The lines this change adds: `8220 = test_key_management`,
`8221 = test_tm_oauth_client`, `8222 = test_tm_keys`, `8223/8224 = test_tm_login_browser` (the
form `8112/8113 = test_file_storage` uses).

### Phase 1: `api_keys` gains `manage_keys` and `last_used`

- **Goal:** the two fields exist, only the server or a superuser sets them, `last_used` tracks
  use, and `GET /api/tracker/me` reports `key.manage_keys` (contract, `api_keys` fields added).
- **Files:**
  - create `pb_migrations/<slot>_api_keys_manage_and_last_used.js`
  - create `pb_migrations/<slot2>_seed_app_docs.js` (re-seed)
  - modify `scripts/gen_app_docs_seed.ts`, `scripts/app_docs_seed.sha256`
  - modify `pb_hooks/api_keys.pb.js`, `pb_hooks/me.pb.js`, `pb_hooks/lib/routes.js` (the `/api/tracker/me` schema only)
  - create `tests/test_key_management.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
  - regen outputs
- **Steps:**
  - Migration, header line `// api_keys gain manage_keys and last_used, both server-written (change key-minting-cli).`
    Up: `c = app.findCollectionByNameOrId("api_keys")`; `c.fields.add(new BoolField({ id:
    "bool4200609001", name: "manage_keys", required: false, help: "Whether this key may list and
    revoke its user's keys; it can never mint one. Set by sign-in through tm login or by a
    superuser at create; a create value from anyone else is replaced with false, and a later
    change is refused." }))`; `c.fields.add(new
    DateField({ id: "date4200609002", name: "last_used", required: false, help: "When the key
    last authenticated a request, to the minute, or empty if never; set by the server only." }))`;
    then replace, exactly once (throw if the count is not one, as
    `v2:1785187300_notifications_actor_read_at.js` `rules()` does), in `updateRule` the text
    `@request.body.expires:isset = false &&` with `@request.body.expires:isset = false &&
    @request.body.manage_keys:isset = false && @request.body.last_used:isset = false &&`;
    `app.save(c)`. Down: the reverse replacement, `c.fields.removeById` of both ids, `app.save(c)`.
  - `pb_hooks/api_keys.pb.js` create hook: after the `user` line add
    `if (!e.hasSuperuserAuth()) e.record.set("manage_keys", false);` and
    `e.record.set("last_used", "");`.
  - `pb_hooks/api_keys.pb.js` new hook `onRecordUpdateRequest((e) => { ... }, "api_keys")`: if
    `e.hasSuperuserAuth()` and the request body (`e.requestInfo().body`) has the key
    `manage_keys` or `last_used` with a value that differs from `e.record.original()`'s (so a
    dashboard save that resends unchanged values passes), throw `new BadRequestError("manage_keys and last_used are set
    only at create or by the server.")`; else `e.next()`. Sessions never reach it with those
    fields: the update rule answers 404 first.
  - `pb_hooks/api_keys.pb.js` `tmkApiKeyAuth`: in the hosted build's `e.set("tmApiKey", { id,
    scope, expires, client_id })` call add `manage_keys: key.getBool("manage_keys")`; after it,
    before `e.auth = owner;`, add the `last_used` write of Decision 8 (read the field only through `getDateTime`, because `new
    DateTime("")` is now, not zero: `const last = key.getDateTime("last_used"); if (last.isZero() || last.unix() < new DateTime().unix() - 60)
    { try { ... } catch (err) { ... } }`).
  - `pb_hooks/me.pb.js` is not edited: it returns the `tmApiKey` object as `key`. In
    `pb_hooks/lib/routes.js` `"GET /api/tracker/me"`, the `key` object's schema gains
    `manage_keys: { type: "boolean" }` in `properties` and in `required`, and its description
    gains " and whether it may list and revoke keys".
  - Re-seed edits, append-only so `scripts/check_app_docs_history.ts` needs no allowlist entry:
    `collection:api_keys` body: after the Fields sentence (ending `and revoked (bool).`) add ` Two
    more fields are server-written: manage_keys (bool: the key may list and revoke its user's
    keys, never mint; set by sign-in or a superuser at create, a create value from anyone else is
    replaced with false) and last_used (date: when the key last authenticated a request, to the
    minute).`; at the end of the Access paragraph add ` A change to manage_keys or last_used is
    refused too: with 404 for the owner, with 400 for a superuser.`. `concept:api-keys` body: append to Authentication ` A key that
    passes records its last use in last_used, at most once a minute, without changing updated.`
- **Tests** (`tests/test_key_management.ts`, port `8220 + PB_PORT_OFFSET`, self-booting as
  `tests/test_tm_cli.ts` does: scratch copies, superuser upsert, `roomkit.serve(PORT, DATA_DIR,
  MIG_DIR, roomkit.hooks_dir(S))`; fixtures Alice and Bob, created verified and approved by the
  superuser, signed in by password). Cases, watched failing before the migration and hook exist:
  - `session create ignores manage_keys`: Alice `POST /api/collections/api_keys/records`
    `{"name":"a","scope":"read","manage_keys":true}` → 200, `manage_keys` false, `last_used` "".
  - `superuser create keeps manage_keys`: superuser `{"user":<alice>,"name":"m","scope":"read","manage_keys":true}` → 200, `manage_keys` true.
  - `update refuses manage_keys`: Alice PATCH `{"manage_keys":true}` on her key → 404; record unchanged.
  - `update refuses last_used`: Alice PATCH `{"last_used":"2020-01-01 00:00:00.000Z"}` → 404.
  - `superuser update refused`: superuser PATCH `{"manage_keys":false}` on the superuser-made key
    → 400 with the hook's message; `{"name":"renamed"}` → 200.
  - `last_used set on use`: a key's `GET /api/tracker/me` → 200; Alice's view of it within 2 s
    has `last_used` non-empty and `updated` equal to its value before the request.
  - `last_used throttled`: two key requests 1 s apart → `last_used` equal after both.
  - `revoked key leaves last_used`: revoke, key request → 401 `api_key_invalid`, `last_used` unchanged.
  - `me reports manage_keys`: the superuser-made key's `GET /api/tracker/me` → `key.manage_keys` true; Alice's own key → false.
  Register the suite (label `test_key_management`, port line `8220 = test_key_management`).
- **Gate:** `PB_PORT_OFFSET=<n> bun tests/test_key_management.ts` exits 0; `make check-static` exits 0.

### Phase 2: the key routes

- **Goal:** `GET /api/tracker/keys` and `POST /api/tracker/keys/{id}/revoke` as the contract states (contract, both route sections and API errors).
- **Files:**
  - create `pb_hooks/api_key_manage.pb.js`
  - modify `pb_hooks/lib/routes.js`, `pb_hooks/lib/api_keys.js`, `pb_hooks/api_keys.pb.js`, `scripts/gen_openapi.ts`, `scripts/check_app_docs_history.ts`
  - create `pb_migrations/<slot>_seed_app_docs.js` (re-seed); modify `scripts/gen_app_docs_seed.ts`, `scripts/app_docs_seed.sha256`
  - modify `tests/test_key_management.ts`
  - regen outputs
- **Steps:**
  - `pb_hooks/lib/routes.js` entries (after `GET /api/tracker/invitations/mine`):
    `"GET /api/tracker/keys"`: summary `Lists the caller's API keys, newest first, without
    secrets; a key needs the manage-keys permission.`, `auth: "users"`, `docs:
    "route:tracker-keys"`, `responses: { 403: "An API key without the manage-keys permission." }`,
    `response: { status: 200, schema: { type: "object", properties: { items: { type: "array",
    items: <item> } }, required: ["items"] } }`. `"POST /api/tracker/keys/{id}/revoke"`: summary
    `Revokes one of the caller's API keys; revoking a revoked key changes nothing.`, `auth:
    "users"`, `docs: "route:tracker-keys"`, `responses: { 403: "An API key without the
    manage-keys permission.", 404: "No key with that id among the caller's." }`, `response: {
    status: 200, schema: <item> }`. `<item>` is written out in full in both entries (the registry
    holds literals only): `{ type: "object", properties: { id, name, scope, client_id, created,
    expires, last_used: each { type: "string" }; manage_keys, revoked, current: each { type:
    "boolean" } }, required: [those ten names] }`.
  - `pb_hooks/lib/api_keys.js`: its one-line header becomes `// API key helpers: namesApiKeys (decision:api-key-reads-refused) and keyItem, the key list's item shape.`; add and export `keyItem(r, current)` (beside `namesApiKeys`;
    handlers `require` it inside their body, as `pb_hooks/api_keys.pb.js` requires
    `namesApiKeys`) returning the ten fields below plus key-scoping's `reach` (string), `workspace` (string, `""`
    for every workspace) and `projects` (array of strings) (Depends on), which the
    `<item>` schema and its `required` list also carry: `id: r.id`, `name: r.getString("name")`, `scope:
    r.getString("scope")`, `client_id: r.getString("client_id")`, `manage_keys:
    r.getBool("manage_keys")`, `created`, `expires`, `last_used`: `r.getString(<field>)`,
    `revoked: r.getBool("revoked")`, `current: !!current && current.id === r.id`.
  - `pb_hooks/api_key_manage.pb.js`, header `// The caller's API keys: list and revoke (decision:{M}).`
    Two registrations through `pb_hooks/lib/routes.js` `add`, as `pb_hooks/me.pb.js` registers its route. Each handler
    first does `const via = e.get("tmApiKey"); if (via && !via.manage_keys) throw new
    ApiError(403, "This API key cannot list or revoke keys.", { api_key: new
    ValidationError("api_key_manage", "This API key cannot list or revoke keys.") });`.
    List: `$app.findRecordsByFilter("api_keys", "user = {:u}", "-created,id", 0, 0, { u:
    e.auth.id })` mapped through `keyItem(r, via)` (`keyItem` is `require`d from `pb_hooks/lib/api_keys.js` inside the handler), `e.json(200, { items })`. Revoke: `let r; try { r =
    $app.findRecordById("api_keys", e.request.pathValue("id")) } catch (_) { r = null }`; if `!r
    || r.getString("user") !== e.auth.id` throw `new ApiError(404, "No key with that id among
    yours.", {})`; if not revoked, `r.set("revoked", true); $app.save(r)`; `e.json(200, keyItem(r,
    via))`. `$app.save` (not a raw update) so the revocation runs record hooks and realtime as a
    session PATCH does, and the hosted-mcp-endpoint grant end applies.
  - `pb_hooks/api_keys.pb.js` `reads`: add `|| (method === "POST" && route ===
    "/api/tracker/keys/{id}/revoke")` with the comment `// the route checks manage_keys itself`;
    extend the KEEP IN SYNC comment to name `/api/tracker/keys/{id}/revoke`.
  - `scripts/gen_openapi.ts` `key_access`: its return type gains `"manage"`, returned for `GET
    /api/tracker/keys` and `POST /api/tracker/keys/{id}/revoke` before the other tests; `KEY_TEXT`
    gains `manage: "An API key needs the manage-keys permission here, whatever its scope; any
    other key gets 403."`; the KEEP IN SYNC comment names the revoke route.
  - `scripts/check_app_docs_history.ts` `ALLOWLIST`: one entry keyed `["<the new seed's file
    name>", "collection:api_keys", "<the first 60 characters of the replaced paragraph>"]` (the
    form of the existing entries) with reason `A key with manage_keys now lists and revokes
    keys (decision:{M}); the sentence saying no key can read or revoke keys became false.`
  - Re-seed edits: new record `{ "id": "routetrkeys0001", "slug": "route:tracker-keys",
    "refName": "api_keys", "title": "GET /api/tracker/keys and POST /api/tracker/keys/{id}/revoke
    — list and revoke the caller's keys", "body": "A signed-in user, or an API key whose
    manage_keys is true, lists every key of its user (revoked and expired included, newest first,
    never a secret) and revokes one by id. current marks the key making the request. A key
    without manage_keys answers 403 with code api_key_manage, whatever its scope; a read-scoped
    key with manage_keys may revoke. An id that is not one of the caller's keys answers 404.
    Revoking is one-way and revoking a revoked key changes nothing. No key can create a key. See
    collection:api_keys and decision:{M}." }` and record `{ "id":
    "deckeymanages01", "slug": "decision:{M}", "refName": "api_keys", "title":
    "A key minted by tm login may carry a manage-keys permission that lists and revokes its
    user's keys and never mints.", "body": "This supersedes decision:api-key-reads-refused in
    part: a key whose manage_keys is true reads its user's key records, through GET
    /api/tracker/keys only, and revokes them through POST /api/tracker/keys/{id}/revoke. Prior
    art: GitHub and Linear manage tokens only in the signed-in web app; this server has no web
    app, and tm holds only a key after browser sign-in.\n\n- **Granted at consent.** Only the tm
    client may ask for it, as the scope value keys; the person can untick it. A create request
    from anyone but a superuser cannot set it.\n- **Never mints.** Every api_keys collection
    route still answers 403 api_key_path to every key, and a query string or realtime
    subscription naming api_keys is still refused.\n\nAccepted limits:\n\n- **A leaked
    manage-keys key can revoke every key of its user**, the owner's agents included; it gains no
    other power.\n\n`pb_hooks/api_key_manage.pb.js` implements it and
    `tests/test_key_management.ts` proves it. See route:tracker-keys and collection:api_keys." }`.
    `concept:api-keys` body: append to the Scope paragraph ` A key with manage_keys may also POST
    /api/tracker/keys/{id}/revoke, whatever its scope (decision:{M}).` and to the Allowed routes
    paragraph ` The two key routes (route:tracker-keys) further refuse a key without manage_keys
    with 403 api_key_manage.` (both append-only).
    `decision:api-key-reads-refused` is not edited: a decision record is immutable, and when it
    superseded part of `decision:api-keys` nothing was appended there; the new record names it.
    `collection:api_keys` body: replace the paragraph starting `A key cannot reach this
    collection` with `A key cannot reach this collection: every api_keys route answers 403 to a
    key, so a key can never mint keys. A key whose manage_keys is true lists and revokes its
    user's keys through route:tracker-keys (decision:{M}). An expand, filter,
    sort or realtime subscription that names api_keys from another collection is refused to a
    key the same way (decision:api-key-reads-refused). See concept:api-keys and decision:api-keys.`
- **Tests** (`tests/test_key_management.ts`; manage keys made by the superuser as in Phase 1):
  watched failing first (before the routes exist both a session and a key get 404: the hosted build answers an unmatched route under a key with 404, its D12):
  - `session lists keys`: Alice session `GET /api/tracker/keys` → 200, her keys only, sorted
    `-created`, no `key`/`key_hash`, every `current` false.
  - `manage key lists keys`: Alice's manage key → 200, its own item `current` true.
  - `plain key refused list`: Alice's write key without the permission → 403, `data.api_key.code` `api_key_manage`.
  - `plain key refused revoke`: same key, revoke another → 403 `api_key_manage`; target unchanged.
  - `read manage key revokes`: a read-scoped manage key revokes Alice's write key → 200,
    `revoked` true; the write key's next request → 401 `api_key_invalid`.
  - `read key without permission revokes`: a read key without `manage_keys` revokes → 403
    `api_key_manage` (not `api_key_scope`).
  - `revoke idempotent`: revoke the same id again → 200, `revoked` true.
  - `revoke self`: the manage key revokes itself → 200; its next request → 401.
  - `revoke other user's key`: Alice's session revokes Bob's key id → 404; Bob's key still works.
  - `revoke unknown id`: `POST /api/tracker/keys/zzzzzzzzzzzzzzz/revoke` → 404.
  - `anonymous`: both routes with no credential → 401. `superuser`: both → 403.
  - `manage key still cannot mint`: manage key `POST /api/collections/api_keys/records` → 403 `api_key_path`.
  - `manage key still cannot name api_keys`: manage key `GET /api/collections/users/records?expand=api_keys_via_user` → 403 `api_key_path`.
- **Gate:** the suite exits 0; `bun scripts/gen_openapi.ts --check` and `make check-static` exit 0.

### Phase 3a: `tm` grants at the token endpoint

- **Goal:** a code issued to `client_id=tm` mints the key the contract's "Token response to a
  `tm` grant" states (name, expiry, `manage_keys`, no refresh token), and a `tm` refresh is
  refused. Codes are inserted by the suite as the superuser, as `tests/test_oauth_token.ts` does
  in the hosted build, so this phase needs no page change.
- **Files:**
  - modify `pb_hooks/lib/oauth.js`
  - modify `pb_hooks/oauth_server.pb.js`
  - create `pb_migrations/<slot>_oauth_codes_tm_fields.js`
  - create `pb_migrations/<slot2>_seed_app_docs.js` (re-seed); modify `scripts/gen_app_docs_seed.ts`, `scripts/app_docs_seed.sha256`
  - create `tests/test_tm_oauth_client.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
  - regen outputs
- **Steps:**
  - Migration, header `// oauth_codes gain the tm client's key name, expiry and manage-keys grant (change key-minting-cli).`
    Up: `c = app.findCollectionByNameOrId("oauth_codes")`; add, all `required: false`:
    `new TextField({ id: "text4300109001", name: "key_name", max: 200, help: "The key name tm
    asked for; empty for other clients." })`, `new DateField({ id: "date4300109002", name:
    "key_expires", help: "The key expiry tm asked for; empty for none or for other clients." })`,
    `new BoolField({ id: "bool4300109003", name: "manage_keys", help: "Whether the person let
    tm's key list and revoke keys." })`; `app.save(c)`. Ids are outside the hosted `43001000xx`
    series so no later field there can replace one (`fields.add` with an existing id replaces
    that field); before writing, `jq -r '.fields[].id' schema/oauth_codes.json` must not list
    them. Down: `removeById` of the three ids, `app.save(c)`.
  - `pb_hooks/lib/oauth.js`:
    - `CLIENTS` gains `tm: { client_name: "tm (command line)", redirect_uris:
      ["http://127.0.0.1/callback"] }` (D14 step 3's loopback rule matches any port).
    - New export `split_keys(raw)`: `raw` split on spaces with empty pieces dropped; returns `{
      scope: <the pieces other than "keys", joined by one space>, keys: <whether "keys" was a
      piece> }`. So `keys` alone gives `scope: ""`, which `parse_scope` reads as the hosted
      default.
    - New export `tm_params(params)`: `key_name` absent (`""`) → `"tm"`; else trimmed, and 0 or
      more than 200 characters (counted as `[...s].length`, characters as the field's `max`
      counts them) → `{ error: "key_name must be 1 to 200 characters" }`; `key_expires` `""` → `""`, else it
      must match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$` and `d = new DateTime(<value
      with T replaced by a space>)` must satisfy `d.after(new DateTime())`, else `{ error:
      "key_expires must be a future UTC date-time" }`; returns `{ ok: { key_name, key_expires:
      d ? d.string() : "" } }` (the truth review's room probe, 2026-11-10: the space form, with
      or without fractional seconds, and the `T` form parse; `.after(now)` is true for a future
      date and false for 2020).
  - `pb_hooks/oauth_server.pb.js`, `POST /oauth/token`:
    - `grant_type=refresh_token`: right after the known-client check, `client_id === "tm"` →
      `token_error(e, "invalid_grant", "tm grants are not refreshed.")`.
    - `grant_type=authorization_code`, inside the transaction, after the PKCE check and before
      the mint: when the code row's `client_id` is `tm` and its `key_expires` is set
      (`row.getDateTime("key_expires")`, not `isZero()`) and not after now, return `{ error:
      ["invalid_grant", "The requested key expiry has passed."] }` (the code is consumed, as
      every failed exchange). The mint for a `tm` row differs only in: `name` =
      `row.getString("key_name") || "tm"`, `expires` =
      `row.getString("key_expires")` (`""` for none, *(assumes Q1)*), `refresh_hash`,
      `refresh_expires` and `refresh_prev_hash` `""` (the unique index on `refresh_hash` skips
      `''`), `manage_keys` = `row.getBool("manage_keys")`. Answer 200 `{ access_token,
      token_type: "Bearer", scope }` with `scope` = the hosted build's granted-scope text plus
      `" keys"` when `manage_keys`, and `expires_in` = `exp.unix() - new DateTime().unix()`
      (`exp` the record's `expires` as a `DateTime`) only when `expires` is set; no
      `refresh_token`.
  - Re-seed: append to the `collection:oauth_codes` body (record `oauthcodesdoc01`) ` For the
    tm client it also holds key_name, key_expires and manage_keys, copied onto the key it
    mints.` (append-only, no history allowlist entry).
- **Tests** (`tests/test_tm_oauth_client.ts`, port `8221 + PB_PORT_OFFSET`, env
  `MCP_PUBLIC_URL=http://mcp.test` before boot; codes inserted by the superuser through `POST
  /api/collections/oauth_codes/records` with `code_hash` = sha256 hex of a known code,
  `code_challenge` = `PKCE.challenge` from `tests/oauthkit.ts`, `client_name` `tm (command
  line)`, `user` Alice (verified and approved), `client_id` per case, `redirect_uri` `http://127.0.0.1:53123/callback`, `scope` `write`, `expires` now + 5
  min; exchanged with `exchange()` from `tests/oauthkit.ts`; right after boot the superuser PATCHes
  `/api/settings` raising the `/oauth/` rate-limit rule's `maxRequests` to 100000, as
  `tests/test_oauth_token.ts` does; records, hidden fields included, are read by the superuser
  with `GET /api/collections/api_keys/records/<id from the key's GET /api/tracker/me>`), watched
  failing first (the fields do not exist):
  - `tm code with manage_keys`: `client_id` `tm`, `manage_keys` true, no `key_name` → 200,
    `scope` `read write keys`, no `refresh_token`, no `expires_in`; the record has `client_id`
    `tm`, `manage_keys` true, `name` `tm`, `expires` "", `refresh_hash` "".
  - `tm code without manage_keys` → `scope` `read write`, record `manage_keys` false.
  - `tm key_name and key_expires`: `key_name` `ci bot`, `key_expires` now + 2 days → record
    `name` `ci bot`, `expires` equal; `expires_in` between 172000 and 172800.
  - `tm expiry passed at exchange`: `key_expires` now + 1 s, exchange after 2 s → 400
    `invalid_grant` `The requested key expiry has passed.`; no record minted; a second exchange
    of the same code → 400 `invalid_grant` (consumed).
  - `tm refresh refused`: `grant_type=refresh_token&client_id=tm&refresh_token=tmr_x` → 400
    `invalid_grant` `tm grants are not refreshed.`.
  - `other client keeps its shape`: a `cursor` code carrying `key_name` `x` and `manage_keys`
    true (set by the superuser) → `name` `Cursor`, `manage_keys` false, `refresh_token` present.
  - `tm key revoked at /oauth/revoke`: the minted key with `client_id=tm` → 200; the key then
    answers 401 `api_key_invalid`.
  Register the suite (port line `8221 = test_tm_oauth_client`).
- **Gate:** `PB_PORT_OFFSET=<n> bun tests/test_tm_oauth_client.ts`, `bun tests/test_oauth_token.ts`
  and `make check-static` exit 0.

### Phase 3b: the `tm` client on the authorization page

- **Goal:** `GET /oauth/authorize` with `client_id=tm` validates `key_name`, `key_expires` and the
  `keys` scope token, the consent page shows the key name, expiry and manage-keys checkbox, and
  Approve stores them on the code (contract, "Authorization requests from the `tm` client").
- **Files:**
  - modify `pb_hooks/lib/oauth.js`
  - modify `pb_hooks/oauth_server.pb.js`
  - modify `pb_hooks/views/oauth_authorize.html`
  - modify `tests/oauthkit.ts`
  - modify `tests/test_tm_oauth_client.ts`
- **Steps:**
  - `pb_hooks/lib/oauth.js`:
    - Every `parse_scope` call on the request's `scope` in `pb_hooks/lib/oauth.js` and
      `pb_hooks/oauth_server.pb.js` (the D14 step 5 check in `validate_request`, the consent
      render's preselection, key-scoping's approve-branch level ceiling, and the scope passed to
      `issue_code`) reads `parse_scope(split_keys(params.scope).scope)`.
    - `validate_request(app, params)`: the scope check of D14 step 5 reads
      `split_keys(params.scope)`: `keys` with a client other than `tm` → `{ redirect:
      "invalid_scope" }`; `parse_scope` is applied to the returned `scope`. After step 5, for
      client `tm` only, `tm_params(params)`; an `error` → `{ redirect: "invalid_request" }`.
      `key_name` and `key_expires` from other clients are ignored (RFC 6749 §3.1).
    - The flow token's `q` array (D14): at every site in `pb_hooks/oauth_server.pb.js` (and
      `pb_hooks/lib/oauth.js`, if it builds one) that builds that array for `sign_flow` or checks
      it after `read_flow` (the GET render and the POST check), append `params.key_name || ""`
      and `params.key_expires || ""`, so the page cannot change them between stages.
    - `issue_code` gains a last parameter `tm`, appended after any parameter key-scoping added
      (`{ key_name, key_expires, manage_keys }`, or `null` for other clients); when not null it
      sets the three values on the row.
  - `pb_hooks/views/oauth_authorize.html`: `Params` holds ten parameters (the eight plus
    `key_name`, `key_expires`), each echoed as a hidden input in every form. Data gains `Tm`
    (bool), `KeyName`, `KeyExpires` (`ok.key_expires.slice(0, 16) + " UTC"` from `tm_params`, or
    `never` when it is `""`) and `AskKeys` (bool). In
    the `consent` block, when `Tm`: `<p>Key name: {{.KeyName}}</p>` and `<p>Expires:
    {{.KeyExpires}}</p>`; when `AskKeys`, inside the consent `<form>`: `<label><input
    type="checkbox" name="manage_keys" value="1" checked> Also let this key list and revoke your
    keys</label>`.
  - `pb_hooks/oauth_server.pb.js`, the `approve` branch: `manage_keys = client.client_id ===
    "tm" && split_keys(params.scope).keys && f.manage_keys === "1"`, where `f` is the object
    `parse_form` returned for the POST body (the one `level` is read from); for `tm`, pass `{
    key_name, key_expires, manage_keys }` from `tm_params(params).ok` to `issue_code`, else
    `null`. Rendering `consent` sets `Tm`, `KeyName`, `KeyExpires`, `AskKeys` from the same.
  - `tests/oauthkit.ts`: add and export `approve_with(base: string, params: Record<string,
    string>, who: { email: string; password: string }, form: Record<string, string>):
    Promise<{ code: string; location: string }>`: the steps of `sign_in_and_approve`, but the
    approve post carries `flow`, the ten parameters and `form`'s fields instead of `access`;
    also export `consent_html(base, params, who): Promise<string>` (the page after the
    password step). Callers pass the level radio key-scoping's consent uses (`level`, read at
    `lane/d-scoping` `a0c8349`) and `workspace: ""` (All workspaces), so key-scoping's
    "not in that list" check cannot fire.
- **Tests** (`tests/test_tm_oauth_client.ts`, Alice verified and approved with a password;
  base request `authorize_params({ client_id: "tm", redirect_uri:
  "http://127.0.0.1:53123/callback", scope: "write keys" })`; the same `/oauth/` rate-limit
  raise as 3a), watched failing first (the page lacks `Key name: tm`):
  - `tm page shown`: `GET /oauth/authorize` → 200 HTML containing `tm (command line)`,
    `registered with Task Tracker as tm`, the loopback warning, `Key name: tm`, `Expires:
    never`, and a checked `manage_keys` checkbox.
  - `tm approve with keys`: `approve_with(..., { level: "write", workspace: "", manage_keys: "1" })` → 302 with
    `code`, `state`, `iss`; `exchange` → `scope` `read write keys`; record `manage_keys` true.
  - `tm approve box unticked`: `{ level: "write", workspace: "" }` → `scope` `read write`, `manage_keys` false.
  - `tm key_name and key_expires on the page`: `key_name=ci bot`, `key_expires=<now + 2 days,
    UTC, seconds precision, Z>` → page shows `Key name: ci bot` and `Expires: <YYYY-MM-DD HH:MM> UTC` of that instant; exchanged record
    `name` `ci bot`, `expires` that instant.
  - `key_expires in the past` → 302 `error=invalid_request`; `key_name` of 201 characters →
    `invalid_request`; `key_name=%20%20` (only spaces) → `invalid_request`; `key_expires=tomorrow` → `invalid_request`.
  - `tm at manage`: `scope=manage keys`, `approve_with(..., { level: "manage", workspace: "",
    manage_keys: "1" })` → token `scope` `read write manage keys`; record `scope` `manage`.
  - `keys from another client`: `client_id=cursor`, `redirect_uri=http://localhost:5555/callback`,
    `scope=read keys` → 302 `error=invalid_scope`.
  - `key_name ignored for another client`: cursor with `key_name=x` → page has no `Key name`;
    the minted record's `name` is `Cursor`.
  - `flow binds key_name`: post the approve form with `key_name` changed from the page's value
    → page re-rendered with "This sign-in took too long or was changed. Start again.", no code.
- **Gate:** `bun tests/test_tm_oauth_client.ts`, `bun tests/test_oauth_authorize.ts`, `bun
  tests/test_oauth_key_limits.ts` and `make check-static` exit 0.

### Phase 4: where `tm` keeps its login; `login --with-key`; `logout`

- **Goal:** the contract's Configuration, `login --with-key` and `logout` rows; directory 0700.
- **Files:** create `clients/tm/src/store.ts`; modify `clients/tm/src/api.ts`, `clients/tm/tm.ts`,
  `tests/test_tm_cli.ts`; create `tests/test_tm_store.ts`; suite registration files.
- **Steps:**
  - No new code under `clients/tm/` names `Bun` except `store.ts`'s guarded
    `(globalThis as any).Bun?.secrets`; under Node that is `undefined` and the file is used
    *(assumes Q2)*. `oauth.ts` and `keys.ts` use only `node:` modules and `fetch`.
  - `clients/tm/src/store.ts` exports:
    - `type Store = "os" | "file"`.
    - `store_mode(): Store`: `TM_CREDENTIAL_STORE` unset or `os` → `os`, `file` → `file`, else
      throw `ConfigError("TM_CREDENTIAL_STORE must be os or file")`.
    - `async function os_get(url): Promise<string | null | undefined>`, `os_set(url, key):
      Promise<boolean>`, `os_delete(url): Promise<void>`: `undefined`/`false` when
      `globalThis.Bun?.secrets` is absent *(assumes Q2)* or a call rejects with `code ===
      "ERR_SECRETS_PLATFORM_ERROR"`; any other rejection: see below. Service `"tm"`, name `url` (the URL with trailing slashes removed). Every `os_*`
      call is made only when `store_mode() === "os"`; in `file` mode they are not called at all.
      A rejection with any other code is wrapped as `ConfigError("the credential store refused:
      <message>")` (exit 1).
      A test seam: `export const backend = { secrets: () => (globalThis as any).Bun?.secrets }`,
      replaced by `tests/test_tm_store.ts`.
  - `clients/tm/src/api.ts`:
    - `save_config(cfg: { url: string; key: string }): Promise<{ file: string; store: Store }>`:
      `mkdirSync(dir, { recursive: true, mode: 0o700 })` then `chmodSync(dir, 0o700)`; if
      `store_mode() === "os"` and `await os_set(url, key)` → write `{ url }`, return `os`; else
      write `{ url, key }`, print `tm: no credential store is available; the key is saved in
      <file>, readable only by this user` on stderr (only when the mode was `os`), return `file`.
      File written with `{ mode: 0o600 }` then `chmodSync(file, 0o600)` as today.
    - `load_config(): Promise<Config>` (now async): first `store_mode()` (so a bad
      `TM_CREDENTIAL_STORE` is refused on every run); `url` = `TM_URL` ‖ saved URL; key =
      `TM_API_KEY` ‖ (mode `os` and `url` non-empty ? `await os_get(url)` : null) ‖ `saved.key` ‖ "". Messages unchanged. `check_key`'s `from` is
      `TM_API_KEY`, `the credential store` or the file path.
    - `save_config` also calls `os_delete(<previous saved url>)` when a saved URL exists and
      differs from the new one, so no store entry outlives its login.
    - `forget_config(url: string): Promise<void>`: `os_delete(url)`, then `fs.rmSync(file, { force: true })`.
    - `saved_login(strict: boolean): Promise<Config | null>`: ignores `TM_URL`/`TM_API_KEY`;
      `{url, key}` when both are found (key from the store entry for that URL, else the file);
      `{url, key: ""}` when only the URL is; null when there is no file; a malformed file →
      null when `strict` is false (login); when true (logout) the file is removed and
      `ConfigError` is thrown with `load_config`'s wording (exit 1), so the login is removed in
      every case. `retire` skips a previous login whose key is `""`.
  - `clients/tm/tm.ts`:
    - OPTIONS add `"with-key": boolean`, `"no-browser": boolean`, `name: string`, `scope:
      string`, `expires: string`, `all: boolean`. A verb that does not read a flag ignores it, as
      verbs ignore `--url` today.
    - `main`: `logout` (and, from Phase 5, `keys`) is dispatched right after `login`, before the
      `NEEDS` check and the shared `load_config()` call, because `logout` and `keys create` must
      run with no usable credential; `keys list` and `keys revoke` call `await load_config()`
      themselves. The shared call becomes `await load_config()`.
    - `login`: with `--with-key`: refuse `--scope`, `--no-browser` (exit 2,
      contract message); paste as today; `previous = await saved_login(false)`; `await
      save_config(...)`; `await retire(previous, key)`; print `saved to <file>`, plus ` (key in the system credential store)` when the store is
      `os`, or `{"saved", "store"}`. Without `--with-key`, until Phase 6, `tm login` keeps today's paste through the
      same path.
    - `retire(previous, new_key)`: if `previous && previous.key !== new_key`: `GET
      /api/tracker/me` with `previous`; if `key.manage_keys`, `POST
      /api/tracker/keys/<key.id>/revoke` with `previous`; any `ApiError` is ignored.
    - `logout`: `saved = await saved_login(true)`; none → `ConfigError("no saved login to log out
      of")`. Try `me` then revoke as in `retire`, recording `{ key_id, revoked, reason }`:
      reason `this key cannot revoke keys` when `manage_keys` is false (exit 0); 401 from `me` or
      a saved key of `""` → `{ key_id: "", revoked: false }`, human `logged out of <url>; the
      saved key was already invalid` (exit 0); any other `ApiError` → reason = its
      message, exit 1 after cleanup. `/oauth/revoke` is not used: ruling 2 makes the manage-keys
      permission the way a key is revoked from `tm`, and a pasted hand-minted key would answer
      `unsupported_token_type` there anyway (hosted-mcp-endpoint contract, Revocation request). Then `await forget_config(saved.url)`; print
      per the contract.
  - `tests/test_tm_cli.ts`: every `tm(["login", ...], ..., <key>)` becomes `tm(["login",
    "--with-key", ...])`; `tm_pty` login calls the same; the env of `tm()` and `tm_pty()` gains
    `TM_CREDENTIAL_STORE: "file"`; the expected `--json` of login gains `store: "file"`.
- **Tests:**
  - `tests/test_tm_store.ts` (no server, no port), watched failing before `store.ts` exists:
    `fallback on platform error` (backend whose calls reject `{code:
    "ERR_SECRETS_PLATFORM_ERROR"}` → `save_config` returns `file`, file holds the key, stderr note);
    `os store used` (in-memory backend → returns `os`, file is `{url}` only, `load_config` returns
    the key); `other rejection` (`{code: "EACCES"}` → `save_config` rejects with `ConfigError` `the credential store refused: <message>`);
    `TM_CREDENTIAL_STORE=file` → backend never called by `save_config`, `load_config`,
    `saved_login` or `forget_config`; `TM_CREDENTIAL_STORE=bogus` → ConfigError
    with the contract text; `old file still read` (`{url, key}` file, empty backend → key from the
    file); `directory tightened` (dir pre-made 0755 → 0700 after save); `no Bun` (backend returns
    undefined → `file`); `under Node` (the suite runs `bun build --target=node
    clients/tm/src/api.ts --outfile <tmp>/api.mjs`, then `node -e` importing it with
    `TM_CREDENTIAL_STORE` unset and calling `save_config({url, key})` → prints store `file`,
    the file holds the key; `node` (22.18 or later) missing from `PATH` fails the case). Each case runs in its own `XDG_CONFIG_HOME` under a temp dir.
  - `tests/test_tm_cli.ts` additions (watched failing first): `login --with-key mixed flags` →
    exit 2; `logout pasted key` (key without `manage_keys`) → exit 0, stdout says `was not
    revoked`, config file gone, the key still answers 200; `logout manage key` (superuser-made
    manage key saved by `--with-key`) → exit 0, the key answers 401, file gone; `logout with
    nothing saved` → exit 1 `no saved login to log out of`; `login replaces manage key`: save
    manage key A, then `--with-key` key B → A answers 401, B saved; `login keeps pasted key`:
    save plain key C then B → C still answers 200; `logout --json` (manage key) → `{"url",
    "key_id", "revoked": true}`.
  Register `test_tm_store` (no port line).
- **Gate:** `bun tests/test_tm_store.ts`, `PB_PORT_OFFSET=<n> bun tests/test_tm_cli.ts`, `bun
  tests/test_tm_mcp.ts` (it imports `clients/tm/src/api.ts`) and `make check-static` exit 0.

### Phase 5: `tm keys list` and `tm keys revoke`

- **Goal:** the contract's `keys list` and `keys revoke` rows and refusals.
- **Files:** create `clients/tm/src/keys.ts`; modify `clients/tm/tm.ts`; create `tests/test_tm_keys.ts`; suite registration files.
- **Steps:**
  - `clients/tm/src/keys.ts`: `type KeyRow` = the generated response item type of `GET
    /api/tracker/keys` from `api.generated.ts`; `list_keys(cfg, all: boolean): Promise<KeyRow[]>`
    calls `api(cfg, "GET /api/tracker/keys", {})` and, unless `all`, keeps rows with `!revoked &&
    (expires === "" || Date.parse(expires.replace(" ", "T")) > Date.now())`;
    `revoke_key(cfg, id): Promise<KeyRow>` calls `api(cfg, "POST /api/tracker/keys/{id}/revoke",
    { path: { id } })`; `status_of(row)`: `revoked` → `revoked`, past `expires` → `expired`,
    else `active` plus `*` when `current`. Both map an `ApiError` whose `data.api_key.code` is
    `api_key_manage` to `ConfigError("this key cannot list or revoke keys; run tm login to get one that can")`.
  - `clients/tm/tm.ts`: `keys` is handled in its own branch of `main` (Decision on dispatch in
    Phase 4), which prints `missing <create|list|revoke>` (exit 2) when no sub-verb is given;
    `NEEDS` is not extended. Sub-verb `list` (0 more positionals), `revoke` (1, `missing <id>`),
    `create` (until Phase 6: exit 2 `unknown keys verb "create"; one of list, revoke`), anything else exit 2 `unknown
    keys verb "<x>"; one of create, list, revoke`. `keys revoke` of the key the command itself
    used (`current` true in the answer) also prints on stderr `tm: note: that was this login's
    key; run tm login again` and keeps exit 0. Human table: header row then one row per key,
    columns joined by two spaces (as `print_human` does), each padded with `pad()` to widths 15, 24, 6, 24, 16, 16, 16 and the status (NAME and CLIENT cut to their first 24
    characters, no ellipsis; CLIENT `-` when `client_id` is `""`); date `d ? d.slice(0, 16) : "never"`; `no keys` when empty. `--json`: the array or the item.
- **Tests** (`tests/test_tm_keys.ts`, port `8222 + PB_PORT_OFFSET`; `TM_CREDENTIAL_STORE=file`;
  manage key made by the superuser, saved with `tm login --with-key`), watched failing first:
  - `keys list human`: exit 0, header line starts `ID`, a hand-minted key's CLIENT column is `-`, the manage key's row ends `active*`, a revoked key absent.
  - `keys list --all`: the revoked key present with `revoked`; an expired key (superuser-made, `expires` 1 s ahead, after 2 s) shows `expired`.
  - `keys list --json`: array; every item has the ten fields, `reach`, `workspace` and `projects`, and no `key`.
  - `keys revoke`: exit 0, stdout `revoked <id> "<name>"`; that key then 401.
  - `keys revoke --json`: item with `revoked` true.
  - `keys revoke unknown` → exit 1, stderr `tm: No key with that id among yours.`.
  - `plain key` saved instead → `keys list` exit 1 with the `run tm login` message.
  - `keys` alone → exit 2 `missing <create|list|revoke>`; `keys frob` → exit 2; `keys revoke` → exit 2 `missing <id>`.
- **Gate:** the suite, `tests/test_tm_cli.ts` and `make check-static` exit 0.

### Phase 6: `tm login` through the browser and `tm keys create`

- **Goal:** the contract's `login`, `keys create`, browser and sign-in refusal rows.
- **Files:** create `clients/tm/src/oauth.ts`; modify `clients/tm/tm.ts`; create `tests/test_tm_login_browser.ts`; suite registration files.
- **Steps:**
  - `clients/tm/src/oauth.ts` exports `async function sign_in(url: string, o: { scope: string;
    key_name: string; key_expires?: string; keys: boolean; open_browser:
    boolean; timeout_ms?: number }): Promise<{ key: string; scope: string }>`:
    1. `GET <url>/.well-known/oauth-authorization-server`; 404 → `ConfigError("<url> does not offer
       browser sign-in; use tm login --with-key")`; other failure → `ApiError` as `request()` makes.
    2. `verifier = randomBytes(32).toString("base64url")`, `challenge` its S256, `state =
       randomBytes(16).toString("base64url")`.
    3. `createServer` from `node:http` (never `Bun.serve`, so the published Node build runs it)
       on `127.0.0.1`, port 0; `redirect = http://127.0.0.1:<port>/callback`.
    4. Authorization URL: `authorization_endpoint` with `response_type=code`, `client_id=tm`,
       `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`, `scope` (`read`,
       `write`, `manage` or `own`, the level token alone, which key-scoping reads as its ladder,
       plus ` keys` when `o.keys`), `key_name`, `key_expires` when set. Print `Open this page to sign in:\n<url>`
       on stderr; open it per the contract unless `!o.open_browser`; spawn errors ignored.
    5. Listener: a path other than `/callback` → 404 text `not found`. `/callback` with `state` ≠
       ours → 400 text `state mismatch`, keep waiting. Otherwise: `iss` absent or ≠ metadata `issuer` →
       fail `sign-in answered for another server; nothing was saved`; `error=access_denied` →
       fail `sign-in was denied in the browser`; other `error` → fail `sign-in failed:
       <error_description || error>`; `code` → success; neither `code` nor `error` → fail `sign-in failed: the callback carried no
       code`. Answer with the Decision 21 page, close
       the listener.
    6. Timer `timeout_ms` (default 300000) → fail `sign-in was not finished within 5 minutes`.
       SIGINT → close the listener, exit 130.
    7. `POST token_endpoint`, form `grant_type=authorization_code`, `code`, `redirect_uri`,
       `client_id=tm`, `code_verifier`; non-200 → fail `sign-in failed: <error_description ||
       error>`; 200 → `{ key: check_key(access_token, "the sign-in"), scope }`.
    Failures are `ConfigError` (exit 1).
  - `clients/tm/tm.ts` `login` without `--with-key`: URL as today (exit 2 `login needs --url the
    first time`); `--scope` default `write`, checked (exit 2); `sign_in(url, { scope,
    key_name: "tm on " + os.hostname(), keys: true, open_browser: !no_browser })`; `previous =
    await saved_login(false)`; `save_config`; `retire(previous, key)`; `GET /api/tracker/me` with the
    new key; print per the contract. `TM_API_KEY` set → stderr `tm: note: TM_API_KEY is set and
    overrides this login`.
  - `keys create`: all flag checks before any network (contract refusals, exit 2), in this
    order, the first failure reported: `--name`, `--scope`, `--expires`, then the URL; `--expires`
    `YYYY-MM-DD` → `<date>T00:00:00Z`, refused (exit 2, the unparseable message) unless
    `new Date(<that>).toISOString().slice(0, 10)` equals the input (so `2026-02-30` is refused), else `Date.parse` must succeed on a value carrying `Z` or
    `±hh:mm`, converted with `toISOString().replace(/\.\d{3}Z$/, "Z")`; not later than now → exit
    2. URL from `--url` ‖ `TM_URL` ‖ saved, else exit 2 `keys create needs --url or a saved
    login`. `sign_in(url, { scope, key_name: name, key_expires, keys: false, ... })`;
    then `GET /api/tracker/me` with the new key for `id`, `scope`, `expires`; print the secret
    alone on stdout and the note on stderr, or the JSON object. Nothing is saved.
- **Tests** (`tests/test_tm_login_browser.ts`, room port `8223 + PB_PORT_OFFSET`, fake
  authorization server `8224 + PB_PORT_OFFSET`; `TM_CREDENTIAL_STORE=file`; `tm` spawned with
  `--no-browser`, the test reads the URL from stderr and completes the page with `approve_with`
  from `tests/oauthkit.ts` (Phase 3b), or for fake cases fetches the callback itself), watched failing first:
  - `login real`: approve with box ticked → exit 0, stdout `logged in to <url> as Alice; key <id>
    saved in <config path>`, `tm list` exit 0, key list shows `tm on <hostname>` client `tm`
    `manage_keys` true, no `refresh_token` stored anywhere in the config dir.
  - `interrupted`: `tm login --no-browser` sent SIGINT once the URL is printed → exit 130, the
    listener port refuses connections afterwards.
  - `keys create --json`: object with `client_id` `tm`, `manage_keys` false, `key` starting `tmk_`.
  - `login --json`: object with `saved`, `store` `file`, `user.name` `Alice`, `key.manage_keys` true.
  - `login denied` → exit 1 `sign-in was denied in the browser`; earlier login still works.
  - `login replaces`: a second `tm login` → the first key answers 401.
  - `keys create real`: `--name "ci bot" --scope read` → stdout is one `tmk_` line; the saved
    login is unchanged; the key's `me` has scope `read`, `manage_keys` false.
  - `keys create --expires`: date two days ahead → record `expires` that day 00:00 UTC.
  - Fake server cases (metadata, authorize redirecting per case, token): `state mismatch` (fake
    sends wrong state first → 400 from the listener, then the right one → exit 0); `iss
    mismatch` → exit 1 with its message, config untouched; `token error` (`invalid_grant`) →
    exit 1 `sign-in failed: ...`; `no metadata` (404) → exit 1 `does not offer browser sign-in`;
    `timeout` (the case imports `sign_in` and calls it in-process with `timeout_ms: 500` and
    `open_browser: false`, so no environment knob is added) → `sign-in was not finished within 5 minutes`.
  - `under Node`: `bun build --target=node clients/tm/tm.ts --outfile <tmp>/tm.mjs`, then `node
    <tmp>/tm.mjs login --no-browser --url <fake server>` (the test fetches the printed URL; the fake authorize answers 302 to the callback with a
    good `state`, `iss` and `code`, its token route answers a `tmk_` key, and it also answers
    `GET /api/tracker/me` with a `key` object) →
    exit 0 and the config file holds the key (the loopback listener and `fetch` run under Node).
  - Usage before network: `keys create --scope read` (no name), `--name ""`, `--expires
    2020-01-01`, `--expires tomorrow`, `--scope admin` → exit 2, nothing listening (the fake
    server sees no request).
- **Gate:** the suite, `tests/test_tm_cli.ts`, `tests/test_tm_keys.ts` and `make check-static` exit 0.

### Phase 7: documentation, smoke probe, readiness

- **Goal:** AC-9 met with its evidence moved to `tm` (proposal, What Changes).
- **Files:** modify `README.md`, `clients/tm/README.md`, `clients/tm/tm.ts` (HELP and its line-2 header only), `e2e/smoke.ts`,
  `docs/readiness/agent-clients.md` (`docs/readiness/README.md` does not list AC-9's verdict and is not touched).
- **Steps:**
  - `README.md` "What a client does": keep `export TM_URL`, the `alias`, the `TOKEN=` line and the
    two `curl` lines listing workspaces and projects (they give the project id `tm create` uses);
    replace only the `export TM_API_KEY=$(curl ... api_keys/records ...)` line with `tm login
    --url $TM_URL` (a browser opens; Alice signs in and approves) followed by `tm keys create
    --name "my agent" --scope write` shown as the way to mint an agent's key; keep the `tm create`
    and `tm list` lines; the intro sentence says Alice signs in to `tm` through the browser; the captured-run
    sentence becomes "A captured run (record ids differ every run; the sign-in happens in the
    browser)". Recapture the output against `make dev`; the recapture needs a person at the browser.
  - `clients/tm/README.md` "Set up once": `tm login --url <url>` signs in through the browser;
    `tm login --with-key` for a machine with no browser; where the key is kept (credential store,
    else the 0600 file); `TM_CREDENTIAL_STORE`; `tm logout`. New section "Keys" after "Use it":
    `tm keys list [--all]`, `tm keys create --name NAME --scope read|write [--expires DATE]`, `tm
    keys revoke <id>`, each with one example line.
  - `clients/tm/tm.ts` HELP: lines for `login [--url URL] [--scope LEVEL] [--no-browser]`, `login
    --with-key [--url URL]`, `logout`, `keys list [--all]`, `keys create --name NAME --scope
    LEVEL [--expires DATE]`, `keys revoke <id>`, and `Exit 0 ok · 1 refused · 2 usage · 130 interrupted`.
  - `e2e/smoke.ts`: `async function probe_key_routes_need_sign_in()`: `GET /api/tracker/keys`
    and `POST /api/tracker/keys/x/revoke` without a credential → 401 each; `async function
    probe_tm_client_registered()`: `GET /oauth/authorize?response_type=code&client_id=tm&redirect_uri=http%3A%2F%2F127.0.0.1%3A53123%2Fcallback&code_challenge=<43 chars>&code_challenge_method=S256&state=s`
    → 200 `text/html`. Both added to `PROBES` before `probe_signup_rate_limit` (which stays last).
  - `docs/readiness/agent-clients.md` AC-9: verdict `met`; evidence `tm login`, `tm keys
    create|list|revoke` (`clients/tm/tm.ts`), `tests/test_tm_keys.ts`,
    `tests/test_tm_login_browser.ts`, `tests/test_key_management.ts`; gap removed.
- **Tests:** the smoke probes, watched failing against an image built before Phase 2.
- **Gate:** `make check` (alone) and `make smoke` exit 0.

## Risks

- **Siblings change under this design.** Phases 1, 3a, 3b and 6 rest on names from the
  hosted-mcp-endpoint design (`20568aa`) and Phases 2, 3b, 5 and 6 on key-scoping's (`a0c8349`).
  The two designs disagree on how the matched key reaches a handler: hosted-mcp-endpoint stores a
  plain object as `tmApiKey`, key-scoping stores the record as `apiKey`; this design reads
  `tmApiKey`. Caught by the `tmApiKey` check in Depends on, run before Phase 1, which also says
  how to build either way.
- **`Bun.secrets` is experimental.** Its shape could change in a Bun upgrade. Caught by
  `tests/test_tm_store.ts` only through the seam; the real store is exercised by hand on macOS in
  Phase 6's gate (`TM_CREDENTIAL_STORE` unset, `tm login`, then `security find-generic-password
  -s tm` shows the entry). Fallback: the file, which is today's behaviour.
- **A Linux desktop whose secret service hangs** rather than refuses would stall `tm`. Not seen in
  the spikes (both Linux cases refused at once). Accepted risk for this change: no timeout is built;
  `TM_CREDENTIAL_STORE=file` is the workaround a user can apply at once.
- **A leaked manage-keys key** can revoke every key of its user (accepted limit in the decision
  record); it cannot mint, and it lives in the credential store where one exists.
- **No pagination on the key list.** A user with thousands of keys gets one large answer. Caught
  only by use; the route can add `page`/`perPage` later without breaking the shape.
- **`last_used` writes under load.** One raw update per key per minute; the write is outside the
  request's success path and logs on failure.
- **Callback port probing.** Another local process could hit the listener; it gets 400 without
  our random `state`, and PKCE binds the code to this `tm` (RFC 8252 §8.1).

## Open Questions

1. **How long `tm login`'s key lives.** Recommended: no expiry and no refresh token, until `tm
   logout` or revocation (as `gh auth login`'s default token and today's pasted key). Other
   options: 24 hours with a refresh token kept in the credential store and used automatically
   (as `gh --expiring` and the Stripe CLI, and as every hosted grant); or 24 hours with `tm
   login` again each day.
2. **Where `tm` keeps the key when it runs under Node.** The published client runs on Node, where
   `Bun.secrets` does not exist. Recommended: the 0600 file, as on a machine with no store. Other
   option: add a native keyring package to the published client.

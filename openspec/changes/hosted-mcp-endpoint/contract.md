# Contract

The rulings this contract implements are the decision record "Hosted MCP endpoint auth model"
(kata `hfrk`), cited below as ruling 1 to 8. Two hosts appear throughout:

- `{API}`: the PocketBase server's public origin, as deployed today. It is also the OAuth
  authorization server (ruling 3) and its issuer identifier.
- `{MCP}`: the MCP service's public origin, a separate Bun service on its own domain (ruling 5).
  *(Q5)* An `mcp.` subdomain of the API's custom domain.

A value marked *(Q n)* is set by that ruling in Open Questions.

## Routes

### MCP service, `{MCP}`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/mcp` | The MCP endpoint (Streamable HTTP). Its URL `{MCP}/mcp` is the canonical resource identifier. |
| GET, DELETE, any other method but OPTIONS | `/mcp` | 405 Method Not Allowed, `Allow: POST`: no stream and no session to end. |
| OPTIONS | `/mcp` | 204, `Allow: POST`; CORS preflight headers only for an allowed `Origin` (see Origin). |
| GET, HEAD | `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata (RFC 9728 §3.1, path-inserted form). Other methods 405. |
| GET, HEAD | `/.well-known/oauth-protected-resource` | The same document, for clients that try the root form (see Protected Resource Metadata). Other methods 405. |
| any | any other path | 404, whatever the credential. |

### API, `{API}` (PocketBase)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | Authorization Server Metadata (RFC 8414). |
| GET | `/oauth/authorize` | Sign-in and consent page (HTML); the authorization endpoint. |
| POST | `/oauth/authorize` | The page's own form submissions (sign-in, emailed code, consent). |
| POST | `/oauth/token` | Token endpoint: authorization code and refresh token grants. |
| POST | `/oauth/revoke` | Token revocation (RFC 7009). |
| GET | `/api/tracker/me` | Existing route; under a key it gains a `key` object (below). |

`/.well-known/openid-configuration` stays 404: the server is not an OpenID provider, and the MCP
authorization page requires only one of the two discovery documents. There is no
`registration_endpoint`: Dynamic Client Registration is deprecated in MCP 2026-07-28 and out
of scope (ruling 4).

## Requests and Responses

### Protocol revisions and transport

The endpoint speaks Streamable HTTP without sessions: revision 2026-07-28, plus the stateless
2025-era form for clients that have not moved: 2025-11-25 and 2025-06-18, and the older
revisions the SDK still accepts on that form (2025-03-26, 2024-11-05, 2024-10-07). Version 2 of the MCP
TypeScript SDK (`@modelcontextprotocol/server`, `latest` 2.4.0 on 2026-11-10) implements
2026-07-28 and falls back to stateless 2025-era serving; `tm mcp` today pins
`@modelcontextprotocol/sdk` 1.32.2, whose newest revision is 2025-11-25.

| Item | 2025-era (2025-11-25 and older) | 2026-07-28 |
| --- | --- | --- |
| Handshake | `initialize` answered; no `Mcp-Session-Id` minted; `notifications/initialized` answers 202 | No `initialize`; `server/discover` answered |
| Version header | `MCP-Protocol-Version` read when present | `MCP-Protocol-Version` required and must equal `_meta` `io.modelcontextprotocol/protocolVersion`, else 400 `-32020` HeaderMismatch |
| Other headers | `Mcp-Session-Id` ignored | `Mcp-Method` (all) and `Mcp-Name` (`tools/call`) required, else 400 `-32020` |
| Unsupported version | 400 JSON-RPC error `-32000` naming the supported list | 400 `-32022` UnsupportedProtocolVersionError with the supported list |

Common to both:

- Request: `POST {MCP}/mcp`, `Content-Type: application/json`, `Accept` listing
  `application/json` and `text/event-stream`, one JSON-RPC message per body (no batches), and
  `Authorization: Bearer <key>`.
- Response to a request: `200`, `Content-Type: application/json`, one JSON-RPC response. The
  service sends no SSE stream: it has no progress notifications to send. A notification answers
  `202` with no body.
- Server identity: `serverInfo` `{ "name": "tm", "version": <tm package version> }`, capability
  `tools` only.
- An unknown method answers JSON-RPC `-32601`.

### tools/list

The `tm mcp` catalog (`TOOLS` in `clients/tm/src/mcp.ts`), in catalog order, filtered by the
credential's scope (ruling 7):

| Credential scope | Tools listed |
| --- | --- |
| `read` | every tool whose `annotations.readOnlyHint` is `true` (today `tm_list`, `tm_show`, `tm_search`) |
| `write` | every tool |

Under 2026-07-28 the result carries `resultType: "complete"`, `cacheScope: "private"` (the list
varies per credential) and `ttlMs: 300000`.

`tm mcp` filters its list the same way, reading the key's scope from `GET /api/tracker/me`. A
write tool called under a read key over stdio is a tool failure (403 `api_key_scope`); on the
hosted endpoint it is refused before the call (Errors, 403 `insufficient_scope`).

### tools/call

Success: unchanged from `tm mcp` today, the verb's JSON as one text block, `isError: false`.

Failure (AC-13), on the hosted endpoint and on `tm mcp` alike:

```json
{
  "content": [{ "type": "text", "text": "<the structuredContent object, serialized as JSON>" }],
  "isError": true,
  "structuredContent": {
    "error": {
      "status": 403,
      "code": "api_key_scope",
      "message": "This API key is read-only.",
      "fields": { "api_key": { "code": "api_key_scope", "message": "This API key is read-only." } }
    }
  }
}
```

| Field | Type | Value |
| --- | --- | --- |
| `status` | integer or null | The HTTP status the API answered; `0` when the API did not answer; `null` for a refusal made before any call (bad arguments). |
| `code` | string | The `code` of the single entry under the API's `data` when there is exactly one; `validation_failed` when there are several; otherwise from the status: 400 `invalid_request`, 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 429 `rate_limited`, any other 4xx `request_failed`, 5xx `server_error`, a 2xx whose body is not the API's JSON `bad_response`, 0 `unreachable`, null `invalid_arguments`. |
| `message` | string | The API's message, or the client's own for `unreachable` and `invalid_arguments`. |
| `fields` | object | The API's `data` verbatim (`{}` when empty). |

The text block carries the same object serialized as JSON, as the MCP tools page advises for
structured content. Tools declare no `outputSchema`.

Arguments that fail the tool's `inputSchema`, and the verbs' own usage refusals (for example
"edit needs a title or a field to set"), are tool failures with `code: "invalid_arguments"`. A
`tools/call` naming no tool in the catalog is a JSON-RPC error `-32602` ("Unknown tool"), as the
MCP tools page classes it.

### Protected Resource Metadata

`GET {MCP}/.well-known/oauth-protected-resource/mcp` (and the root form), `200`,
`application/json`. The 401 challenge names the path-inserted URL, which RFC 9728 §3.3 matches
to `{MCP}/mcp` exactly. The root form returns the same `resource`, which a client deriving the
root URL by RFC 9728 §3.3's first rule would expect to be `{MCP}`; it is served because the MCP
discovery page lists it and Claude Code tries it first.

```json
{
  "resource": "{MCP}/mcp",
  "authorization_servers": ["{API}"],
  "scopes_supported": ["read", "write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Task tracker"
}
```

### The 401 challenge

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="{MCP}/.well-known/oauth-protected-resource/mcp", scope="read write"
```

A request that carried a credential which failed adds `error="invalid_token"` (RFC 6750 §3.1);
one that carried none adds no `error` (RFC 6750 §3). `scope="read write"` lets the client ask
for both and the person choose at consent *(Q2)*.

### Authorization Server Metadata

`GET {API}/.well-known/oauth-authorization-server`, `200`, `application/json`:

```json
{
  "issuer": "{API}",
  "authorization_endpoint": "{API}/oauth/authorize",
  "token_endpoint": "{API}/oauth/token",
  "revocation_endpoint": "{API}/oauth/revoke",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "revocation_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["read", "write"],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true
}
```

`none` in `token_endpoint_auth_methods_supported` is what Claude requires before it uses its
metadata document. `offline_access` is not listed: a refresh token is issued with every
authorization code grant, and an `offline_access` in a request is accepted and ignored.
*(Q4)* Every client is public, so both auth-method lists hold `none` alone.

### Scopes

| Scope | Grants | Minted key's `scope` |
| --- | --- | --- |
| `read` | read tools; API reads | `read` |
| `write` | every tool; API reads and writes (implies `read`) | `write` |

A request's `scope` is space-delimited. `write` alone is read as `read write`. Unknown values
other than `offline_access` fail with `invalid_scope`. A granted scope is reported as `read` or
`read write`.

### Authorization request

`GET {API}/oauth/authorize?` with:

| Parameter | Required | Rule |
| --- | --- | --- |
| `response_type` | yes | `code` |
| `client_id` | yes | A pre-registered id, or an HTTPS URL with a path naming a Client ID Metadata Document |
| `redirect_uri` | yes | Exactly one of the client's registered URIs; a loopback URI (`http://localhost`, `http://127.0.0.1`) matches with any port |
| `code_challenge` | yes | `BASE64URL(SHA256(code_verifier))`, 43 characters |
| `code_challenge_method` | yes | `S256` |
| `scope` | no | As above; absent means `read write` |
| `state` | no | Returned unchanged |
| `resource` | no | If present, must equal `{MCP}/mcp` (scheme and host case-insensitive, no trailing slash); absent means `{MCP}/mcp` |

The page:

1. **Sign-in.** Email and password, or an emailed one-time code, against the `users` collection
   (ruling 3). The `users` auth rule (`verified = true && approved = true`) applies unchanged
   (decision:verified-login, decision:signup-approval): an account that fails it is told it
   cannot sign in yet and why, and no code is issued. GitHub and Google sign-in are not offered on
   this page; every account can use the emailed code. No sign-in is remembered between
   authorizations.
2. **Consent.** Shows the client's name, the `client_id` host (for a pre-registered client, its
   id), the redirect URI's host (with a
   warning when it is a loopback address, as the MCP security page asks), and a choice between
   "Read" and "Read and write". *(Q2)* The choice the client asked for is preselected. Buttons:
   Approve, Deny.
3. **Redirect.** Approve: `302` to
   `redirect_uri?code=<code>&state=<state>&iss=<{API}>`. The code is single use and expires 10
   minutes after issue (the OAuth 2.1 recommended maximum). Deny: `302` to
   `redirect_uri?error=access_denied&state=<state>&iss=<{API}>`.

The page answers with `Content-Security-Policy: frame-ancestors 'none'`, and its form posts are
refused without a token bound to the page that served them.

### Client registration

**Client ID Metadata Documents** (ruling 4). For a URL `client_id`, the server fetches the
document over HTTPS (no redirects followed, a 5 second timeout, at most 5 KiB, never to a
private, loopback or link-local address) and requires valid JSON with `client_id` equal to the
URL, a `client_name`, and `redirect_uris` holding the request's redirect URI.
`token_endpoint_auth_method`, if present, must be `none`. A document is cached as its HTTP cache
headers allow, for at most 24 hours. *(Q3)* Any HTTPS host may serve a document; the consent page
names it. The `client_id` and each redirect URI are written in printable ASCII (an
internationalised host as punycode, which the consent page shows as is).

Known documents for the milestone clients (ruling 1):

| Client | `client_id` | Redirect |
| --- | --- | --- |
| Claude Code | `https://claude.ai/oauth/claude-code-client-metadata` | `http://localhost/callback`, `http://127.0.0.1/callback`, any port |
| Claude (web, desktop, mobile) | `https://claude.ai/oauth/mcp-oauth-client-metadata` | `https://claude.ai/api/mcp/auth_callback` |

**Pre-registered clients.** Configured on the server; adding one is a configuration change, not
a contract change.

| `client_id` | Name | Redirect URIs | Auth |
| --- | --- | --- | --- |
| `cursor` | Cursor | `https://www.cursor.com/agents/mcp/oauth/callback`, `http://localhost:8787/callback` | `none` *(Q4)* |

### Token request

`POST {API}/oauth/token`, `Content-Type: application/x-www-form-urlencoded`.

Authorization code: `grant_type=authorization_code`, `code`, `redirect_uri` (identical to the
authorization request's), `client_id`, `code_verifier` (43 to 128 unreserved characters),
`resource` (optional, as above).

Refresh: `grant_type=refresh_token`, `refresh_token`, `client_id`, `scope` (optional; read as
above, so `write` is `read write`, and must equal the granted scope: RFC 6749 §6 allows a
narrower request, but a grant's key keeps the scope it was minted with).

Success, `200`, `Cache-Control: no-store`:

```json
{
  "access_token": "tmk_<40 characters>",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "tmr_<40 characters>",
  "scope": "read write"
}
```

*(Q1)* `expires_in` is 86400 (24 hours); a refresh token expires 30 days after it was issued.

### The minted key (ruling 6)

- **Format.** `tmk_` plus 40 random characters, as a hand-minted key; stored only as its hash.
  The refresh token is `tmr_` plus 40 random characters.
- **Storage.** The refresh token's hash, its expiry, and the hash of the refresh token it
  replaced are three new hidden fields on the grant's `api_keys` record, never returned to a
  client; the third is what recognises a replayed refresh token. Authorization codes live, as hashes with their
  client, redirect URI, code challenge, scope and user, in a new collection no client rule opens.
  Fetched metadata documents are cached in the server's memory only.
- **Record.** One `api_keys` record per grant: `user` the signed-in user, `name` the client's
  name (renamable as any key), `scope` the granted scope, `expires` now plus the key lifetime, and
  a new field `client_id` holding the OAuth client id. A hand-minted key has `client_id` `""`; a
  value sent at create is replaced with `""`, and a later change is refused as for `scope`.
- **Listing.** The grant's record appears in `GET /api/collections/api_keys/records` beside
  hand-minted keys, under a user session, as today. A key still cannot read `api_keys`
  (decision:api-key-reads-refused).
- **Refresh.** The record keeps its id; its key value is replaced and `expires` moves forward.
  Only the server moves `key_hash` and `expires`; a client request changing them is still
  refused.
  The previous key and refresh token stop working at once. A refresh token already used ends
  the grant: the record is marked `revoked`. Linear instead honours a lost refresh's repeat for
  30 minutes; this contract does not.
- **Revocation.** Setting `revoked` or deleting the record ends the grant; its refresh token then
  answers `invalid_grant`.
- **Audience (a deliberate deviation).** The MCP authorization page requires a server to
  "validate that access tokens were issued specifically for them as the intended audience" and
  not to pass a received token through. This contract treats the MCP service and the API as one
  protected resource on two hosts: the MCP service presents the caller's key to the API (ruling 5),
  and a grant's key, though requested for `{MCP}/mcp`, is also accepted directly by `{API}` as any
  key is (ruling 2). Consequence: a key obtained through an MCP client's sign-in works against
  the whole API its scope allows.

### Revocation request

`POST {API}/oauth/revoke`, form-encoded: `token`, `token_type_hint` (optional, ignored),
`client_id`. Revoking a grant's access key or refresh token marks its record `revoked`, and
answers `200` with an empty body; so does an unknown token (RFC 7009 §2.2). A grant's token
issued to another client answers 400 `invalid_client` and is left as it was (RFC 7009 §2.1). A
hand-minted key answers 400 `unsupported_token_type` (RFC 7009 §2.2.1) and is left as it was;
it is revoked in the key list. Linear answers 400 for a token already revoked; this endpoint
answers 200.

### `GET /api/tracker/me` under a key

Adds, beside `user`, `workspaces` and `unread_notifications`:

```json
"key": { "id": "<record id>", "scope": "read", "expires": "2026-11-11 12:00:00.000Z", "client_id": "" }
```

`expires` is `""` for a key that never expires. Under a user session `key` is absent.

## Errors

### MCP service

| Status | Body | When |
| --- | --- | --- |
| 400 | JSON-RPC error `-32600` | Body is not one JSON-RPC message, or `Content-Type` is not `application/json` |
| 406 | JSON-RPC error `-32600` | `Accept` does not list both `application/json` and `text/event-stream` |
| 400 | JSON-RPC error `-32020` HeaderMismatch | 2026-07-28 only: a required MCP header missing or disagreeing with `_meta` |
| 400 | JSON-RPC error, supported versions in `data` | Unsupported protocol version |
| 401 | error object, `code` `unauthorized` or `invalid_token` | No credential, or one that is not a valid, unrevoked, unexpired `tmk_` key; challenge as above |
| 403 | error object, `code` `origin_not_allowed` | `Origin` present and not allowed |
| 403 | error object, `code` `insufficient_scope`; `WWW-Authenticate: Bearer error="insufficient_scope", scope="read write", resource_metadata="..."` | `tools/call` of a write tool under a read credential |
| 404 | error object, `code` `not_found` | Any path other than `/mcp` and the metadata documents (AC-12) |
| 404 | JSON-RPC error `-32601` | 2026-07-28: unknown method |
| 405 | none | GET or DELETE on `/mcp` |
| 429 | error object, `code` `rate_limited`; `Retry-After: <seconds>` | Over a limit below |
| 500 | error object, `code` `server_error` | The service failed |
| 503 | error object, `code` `unavailable`; `Retry-After: 5` | The API did not confirm or refuse the credential (unreachable, or an answer other than 200 or 401) |

The error object is the tool-failure shape without `fields`:
`{"error": {"status": <HTTP status>, "code": "<code>", "message": "<text>"}}`, `application/json`.
It is not a JSON-RPC message: the MCP 2026-07-28 base protocol asks new implementations not to
use the `-32000` to `-32019` codes and to keep new codes out of the JSON-RPC reserved range, and
these refusals are decided before any JSON-RPC message is read. Tool failures are results, not
errors (Requests and Responses).

### API: authorization endpoint

Before the client and redirect URI are known good (unknown pre-registered id, document unfetchable
or invalid, redirect URI not registered, `response_type` other than `code`): an HTML error page
with status 400, and no redirect (OAuth 2.1 §4.1.2.1). After: a redirect carrying `error`,
`state` and `iss`:

| `error` | When |
| --- | --- |
| `invalid_request` | `code_challenge` missing, or `code_challenge_method` not `S256` (RFC 7636 §4.4.1) |
| `invalid_scope` | A scope value outside `read`, `write`, `offline_access` |
| `invalid_target` | `resource` names another resource (RFC 8707) |
| `access_denied` | The person chose Deny |
| `server_error` | The server failed |

### API: token and revocation endpoints

`400` with `{"error": "<code>", "error_description": "<text>"}`, `Cache-Control: no-store`:

| `error` | When |
| --- | --- |
| `invalid_request` | A required parameter missing or repeated, or a `code_verifier` outside 43-128 unreserved characters |
| `invalid_client` | Unknown `client_id`, or not the client the code or refresh token was issued to |
| `invalid_grant` | Code unknown, used, expired, or issued for another redirect URI; PKCE mismatch (RFC 7636 §4.6); refresh token unknown, expired, already used, or its grant revoked |
| `unsupported_grant_type` | A grant other than `authorization_code` or `refresh_token` |
| `invalid_scope` | A refresh `scope` other than the granted one |
| `invalid_target` | `resource` names another resource |

### API: keys

| Status | Code | When |
| --- | --- | --- |
| 404 | none (`data` `{}`) | Under a key, a path no route matches, or a collection route naming a collection that does not exist (AC-12); was 403 `api_key_path` |
| 403 | `api_key_path` | Under a key, a route that exists and is closed to keys (unchanged) |
| 403 | `api_key_scope` | A read key writing (unchanged) |
| 401 | `api_key_invalid` | Invalid, revoked or expired key (unchanged) |

## Auth

| Surface | Caller | Credential |
| --- | --- | --- |
| `POST {MCP}/mcp` | Any MCP client | `Authorization: Bearer tmk_...` (or the bare key, read as the API reads it), hand-minted or grant-minted (ruling 2). A PocketBase user token, a refresh token, or any other value answers 401. Never read from the query string. |
| `{MCP}` metadata documents | Anyone | None |
| `{API}/.well-known/oauth-authorization-server` | Anyone | None |
| `{API}/oauth/authorize` | A person in a browser | The page's own sign-in (users only, never superusers) |
| `{API}/oauth/token`, `/oauth/revoke` | An OAuth client | Public: `client_id` in the body *(Q4)* |
| `{API}/api/tracker/me` | As today | As today |

**One credential kind (ruling 2).** The MCP specification's "MUST NOT accept or transit any other
tokens" bans tokens issued for another resource. A `tmk_` key is issued by this tracker for this
tracker, whether by hand or by a grant, and is the only credential the endpoint accepts.

**Origin.** A request with no `Origin` header is served (server-side clients send none). A request
whose `Origin` is present must be on the service's allowed list, initially `https://claude.ai`
and `https://www.cursor.com`; anything else answers 403. The service sends no CORS headers for an
origin off the list.

**Rate limits (ruling 8).**

| Where | Key | Limit | Answer |
| --- | --- | --- | --- |
| MCP service, valid credential | the key | 300 requests per 60 s | 429, `Retry-After` |
| MCP service, no or refused credential | client address | 30 requests per 60 s | 429, `Retry-After` |
| API, `/oauth/*` | client address | 30 requests per 60 s | PocketBase's 429 (no `Retry-After`, SH-7) |
| API, the MCP service's calls carrying its private secret | none | exempt from every per-address rule | none |
| API, everyone else | client address | unchanged | unchanged |

The exemption is granted only to a request carrying a secret shared by the MCP service and the
API, which the service sends only over the private network; never by a forwarded-address header
or by the connection's address. The API trusts `X-Real-IP` from any peer
(decision:rate-limit-counts-x-real-ip), so a header naming an address would be one any caller
could claim, and Railway does not document the address its public edge connects from, so a
private-address test could also match public traffic. Limit values may be tuned without a
contract change; the answers may not.

## Compatibility

- **`tm mcp` (stdio).** Same transport, configuration (`TM_URL`, `TM_API_KEY`, saved login) and
  tools. Three changes: a read key's tool list holds only the read tools; a failed call's text block becomes the JSON error object above (it was the
  API's message, plus its body when `data` was not empty) and gains `structuredContent`; and an
  unknown tool name becomes JSON-RPC error `-32602` (it was a result with `isError: true`).
- **`tm` CLI.** No change.
- **Existing keys.** Work unchanged on the API and as bearer tokens on the MCP endpoint, with the
  tools their scope allows. Their records read `client_id: ""`.
- **API under a key.** An unknown path, or an unknown collection, answers 404 instead of 403
  `api_key_path` (AC-12); system, `_`-prefixed and `api_keys` collections stay 403. A client
  that treated that 403 as "not for keys" now sees not-found for paths that never existed;
  every existing route answers as before.
- **`GET /api/tracker/me`.** Gains `key` under a key; nothing removed.
- **`api_keys`.** Gains `client_id` and three hidden refresh-token fields, and grant-minted
  records appear in the list. The `expires` and `key_hash` help texts change from "set only at
  create" and "a later change is refused" to say the server moves them on a grant's refresh.
  A new collection holds authorization codes. Each carries its `app_docs` record and the schema,
  `openapi.json` and model regenerations in the same change.
- **API 401s.** Unchanged: the API adds no `WWW-Authenticate`; only the MCP service challenges.
- **CORS and rate limits on the API.** Unchanged for public callers, apart from the new `/oauth/*`
  rule.

## Open Questions

Each was ruled on 2026-11-10; the contract states the ruling where it applies (marked *(Q n)*).

1. **Key lifetime and refresh.** Ruled: the minted key lasts 24 hours and a refresh token 30 days, rotated on each use, as Linear does.
2. **What consent preselects.** Ruled: the scope the client asked for, with the other one choosable.
3. **Which metadata-document clients may sign in.** Ruled: any HTTPS document, with the consent page naming its host.
4. **Whether the pre-registered Cursor client has a secret.** Ruled: no secret; a public client protected by PKCE.
5. **The MCP service's domain.** Ruled: an `mcp.` subdomain of the API's custom domain, as Linear serves `mcp.linear.app`.

## Sources

Fetched 2026-11-10.

- MCP 2026-07-28: authorization
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), its
  authorization-server discovery, client-registration and security-considerations subpages,
  Streamable HTTP
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
  tools (https://modelcontextprotocol.io/specification/2026-07-28/server/tools) and the changelog.
  Quoted: "Invalid or expired tokens MUST receive a HTTP 401 response"; "If the Origin header is
  present and invalid, servers MUST respond with HTTP 403 Forbidden"; "If
  code_challenge_methods_supported is absent [...] MCP clients MUST refuse to proceed"; "A server
  that supports only this revision [...] HTTP GET or DELETE to the MCP endpoint: respond with 405";
  "For backwards compatibility, a tool that returns structured content SHOULD also return the
  serialized JSON in a TextContent block."
- RFC 9728 (https://www.rfc-editor.org/rfc/rfc9728) §2, §3, §5.1; RFC 8414
  (https://www.rfc-editor.org/rfc/rfc8414) §2, §3; RFC 7636 (https://www.rfc-editor.org/rfc/rfc7636)
  §4; RFC 6750 (https://www.rfc-editor.org/rfc/rfc6750) §3; RFC 7009
  (https://www.rfc-editor.org/rfc/rfc7009) §2.2; OAuth 2.1 draft 15
  (https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-15.txt) §2.3.1, §3.2.4, §4.1.2.1.
- Linear (https://linear.app/developers/oauth-2-0-authentication): an authorization-code access
  token lasts "24 hours by default"; "Each refresh token expires 30 days after issuance. A successful refresh returns a new
  access token and refresh token"; `read` "will always be present". Linear's MCP
  (https://linear.app/docs/mcp): "Clients that request read are granted read-only access".
- Claude (https://claude.com/docs/connectors/building/authentication): the hosted-app redirect
  `https://claude.ai/api/mcp/auth_callback`; Claude Code's loopback redirects "with the port
  component ignored"; CIMD only when metadata lists `"none"` in
  `token_endpoint_auth_methods_supported`.
- Cursor (https://cursor.com/docs/context/mcp): redirects
  `https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback`;
  `CLIENT_SECRET` optional.
- MCP TypeScript SDK v2 (`npm view @modelcontextprotocol/server`): "v2 of the MCP TypeScript SDK,
  the stable release line, implementing the 2026-07-28 MCP spec".
- Claude's hosted-app metadata document, fetched: `{"client_id":"https://claude.ai/oauth/mcp-oauth-client-metadata","client_name":"Claude",...,"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],...,"token_endpoint_auth_method":"none"}`;
  its URL is named in Claude's enterprise-managed-auth page as the base of
  "`https://claude.ai/oauth/mcp-oauth-client-metadata/confidential_client`".
- OAuth Client ID Metadata Document draft
  (https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/, -03): "MUST NOT
  automatically follow HTTP redirects"; "The recommended maximum size to read is 5 kilobytes";
  "MUST NOT fetch [...] URLs [...] that resolve to special-use IP addresses as defined in
  [RFC6890]". RFC 8707 (https://www.rfc-editor.org/rfc/rfc8707) §2; RFC 9207
  (https://www.rfc-editor.org/rfc/rfc9207) §2.
- Railway (https://docs.railway.com/networking/public-networking/specs-and-limits): the edge
  sets "`X-Real-IP` for identifying client's remote IP"; the source address of its connection
  to a service is not documented.
- Unverified: which protocol revision Claude on the web sends, and whether Claude on the web or
  Cursor sends `Origin` (Claude Code 2.1.322 sends none and speaks 2025-11-25 by `initialize`;
  Cursor states it "speaks the 2025-11-25 revision and earlier").

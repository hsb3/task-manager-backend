# Design

How the contract (`contract.md`) is met. `{API}` and `{MCP}` are the contract's two origins.
Every PocketBase claim below was proven in a room on PocketBase 0.40.4 or read from its v0.40.4
source; every library and platform claim was proven by a spike or is cited. Spike evidence is
summarised under each decision; what stays unproven is listed in Risks with its fallback.

## Decisions

### D1. Two processes, one catalog

- **MCP service.** A new Bun program under `services/mcp/`: `services/mcp/main.ts` (entry; reads
  the environment, starts two listeners), `services/mcp/src/app.ts` (the public request
  pipeline), `services/mcp/src/limits.ts` (the in-memory rate limiter) and
  `services/mcp/src/cimd.ts` (the metadata-document fetcher and the private listener's handler).
  It has no `package.json` of its own: it imports the catalog with a relative path,
  `../../../clients/tm/src/mcp.ts`, and imports every SDK symbol it needs from that module, which
  re-exports them (D11). The only manifest that declares the SDK is `clients/tm/package.json`, so
  the SDK resolves from `clients/tm` whatever Bun's workspace linker does, for Bun, `tsc` and the
  image alike. Alternatives: a workspace package (adds a manifest and a lockfile entry for no
  gain); a copy of the catalog (two catalogs drift, which the hosted-mcp spec forbids).
- **Authorization server.** Inside PocketBase as JSVM hooks (ruling 3): `pb_hooks/oauth_server.pb.js`
  (routes), `pb_hooks/lib/oauth.js` (pure helpers and the pre-registered client table),
  `pb_hooks/views/oauth_authorize.html` (the one page), `pb_hooks/internal_caller.pb.js` (the
  rate-limit exemption). The existing `pb_hooks/oauth.pb.js` stays the GitHub/Google *client*
  side; the new file name says "server" to keep the two apart.
- **Both MCP surfaces move to SDK v2.** `clients/tm` replaces `@modelcontextprotocol/sdk` 1.32.2
  with `@modelcontextprotocol/server` **2.4.0** (exact pin). Spike (scratch `spike-sdk`): v2 ships
  `serveStdio` (`@modelcontextprotocol/server/stdio`) and `createMcpHandler` (web-standard
  `Request` to `Response`, no adapter on Bun) over one server factory, and bundles the same
  `AjvJsonSchemaValidator` (`@modelcontextprotocol/server/validators/ajv`). It installs 3 packages
  against v1's 92. `serveStdio` returns at once with a handle holding only `close()`, so `serve`
  must itself wait for end of input before returning; `tm.ts` ends with `process.exit(await
  main())`, and without that wait `tm mcp` exits before answering anything (reproduced: zero
  replies under Bun; the first spike missed it because its script had no `process.exit`, so the
  open stdin kept Bun alive). The root `devDependencies` keep
  `@modelcontextprotocol/sdk` 1.32.2: the suites use its *client* transports, which also proves a
  2025-era client against the v2 server. Alternative kept out: v1 for stdio and v2 for HTTP (two
  SDKs, two error mappings).

### D2. The SDK's gaps, closed in our code (spike results)

| Behaviour of `@modelcontextprotocol/server` 2.4.0 | Contract needs | Our code |
| --- | --- | --- |
| The 2025-era stateless fallback inside `createMcpHandler` answers `text/event-stream` (its `responseMode: "json"` covers only the 2026 leg) | JSON only | Create the handler with `legacy: "reject"`; route a request for which `await isLegacyRequest(req, parsedBody)` resolves `true` to our own `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` connected to a fresh server from the same factory |
| A 2025 batch body is served | No batches | Refuse a JSON array before the SDK sees it: 400 JSON-RPC `-32600` |
| GET/DELETE answer 405 with a JSON-RPC body | 405, no body | Answered before the SDK: 405, `Allow: POST`, empty body |
| A thrown `Error` in `tools/call` becomes `-32603` | Unknown tool is `-32602` | Throw `new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool: <name>")` |
| The low-level `Server` does not validate `tools/call` arguments | `invalid_arguments` failure | Keep the Ajv validators built from each `inputSchema` |
| 2026 results get `resultType`, `ttlMs`, `cacheScope` from `cacheHints` | `ttlMs: 300000`, `cacheScope: "private"` on `tools/list` | `new Server(info, { capabilities: { tools: {} }, cacheHints: { "tools/list": { ttlMs: 300000, cacheScope: "private" }, "server/discover": { ttlMs: 300000, cacheScope: "private" } } })` |

Spike-proven unchanged behaviour: 2025-11-25 `initialize` answers with no `Mcp-Session-Id`;
`notifications/initialized` answers 202; 2026 `server/discover` works; a missing or mismatched
`MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` answers 400 `-32020`; an unsupported 2026
version answers 400 `-32022`; an unsupported 2025-era header version answers 400 `-32000`
listing 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 (the contract now says so);
an unknown method answers `-32601` (HTTP 404 under 2026, 200 under 2025).

### D3. Client facts that bound the design (research, fetched 2026-11-10)

- **Claude's hosted-app metadata document** is `https://claude.ai/oauth/mcp-oauth-client-metadata`
  (named in https://claude.com/docs/connectors/building/enterprise-managed-auth as the base of
  its `/confidential_client` variant; fetched: `client_name` "Claude", `redirect_uris`
  `["https://claude.ai/api/mcp/auth_callback"]`, `token_endpoint_auth_method` "none"). The
  `/confidential_client` variant uses `private_key_jwt`, which the contract does not offer, so
  Claude uses the public one ("Claude normally selects CIMD only when your authorization server
  metadata advertises both `"client_id_metadata_document_supported": true` and `"none"`").
- **Claude Code** (`https://claude.ai/oauth/claude-code-client-metadata`, fetched:
  `redirect_uris` `["http://localhost/callback","http://127.0.0.1/callback"]`). Its 2.1.322
  binary carries `"2025-11-25"` for `initialize` and `"2026-07-28"` for `server/discover`
  (confirmed twice). The research spike read its HTTP transport as setting only `Authorization`
  and `mcp-protocol-version`, so no `Origin`; the truth review did not reproduce that reading,
  and the design does not depend on it (a missing `Origin` is served).
- **Cursor** "currently speaks the 2025-11-25 revision and earlier, so it still opens with the
  initialize handshake" (Cursor staff, forum.cursor.com thread 172536). So the 2025-era leg is
  required, not optional.
- **Origin.** Claude on the web calls "from 160.79.104.0/21", server-side; whether it sends
  `Origin` is unverified, and Claude's testing page warns "an overly strict check rejects
  Anthropic's requests". Hence: a missing `Origin` is served; a present one must be listed.
- **CIMD draft -03** (datatracker, fetched): no redirects, 5 KB read cap, no fetch to RFC 6890
  special-use addresses, cache per RFC 9111 with a maximum, "MUST NOT cache error responses".

### D4. Where the metadata document is fetched: the MCP service, over the private network

The PocketBase JSVM cannot fetch safely (spike `spike-jsvm`, source
`plugins/jsvm/binds.go:931-1030`): `$http.send` uses `http.DefaultClient`, follows redirects
(proven: a 302 was followed), reads the whole body (a 10 MB body came back whole), and has no DNS
lookup or address pinning. So the fetch runs in Bun, which can (research, Bun 1.4.3 run):
`node:dns` `lookup(host, { all: true })`, `fetch` with `redirect: "manual"`,
`AbortSignal.timeout`, a streamed body read that stops at a byte cap, and a pinned address via a
URL naming the IP plus `Host` and `tls: { serverName }` (certificate still checked against the
name; without `serverName` the run failed with `EPROTO`).

The MCP service answers PocketBase on a **second listener**, port `MCP_INTERNAL_PORT` (8081), that
Railway exposes only on the private network (a Railway public domain routes to one port, the
service's `PORT`). The public listener keeps the contract's route table exactly. The private
listener serves one route, `POST /internal/client-metadata`, and requires the shared secret
(D6). PocketBase caches results in `$app.store()` (shared across pooled VMs: spike proved 30
concurrent reads saw one value; the store has no TTL, so entries hold their own expiry).
Alternative rejected: an operator allowlist of hosts (contradicts ruling Q3, any HTTPS host).

### D5. The internal client-metadata exchange (private, not contract)

Request: `POST {MCP_INTERNAL_URL}/internal/client-metadata`, headers
`X-TM-Internal: <MCP_INTERNAL_SECRET>`, `Content-Type: application/json`, body
`{"client_id": "<url>"}`.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{"client": {"client_id", "client_name", "redirect_uris": [...]}, "max_age": <seconds>}` | Fetched and valid |
| 422 | `{"error": "<reason>"}` | The URL or document breaks a rule below (not retried) |
| 503 | `{"error": "<reason>"}` | Timeout, DNS failure, connection failure, 5xx from the host |
| 404 | `{"error": "not_found"}` | Wrong path, wrong method, missing or wrong secret |
| 422 | `{"error": "request body must be {\"client_id\": string}"}` | Body not JSON, or `client_id` missing or not a string (checked after the secret) |

Rules, in order (each failure is 422 with the quoted reason unless marked 503):

1. URL (`check_client_id_url`), checked on the **raw string** before any parsing normalises it:
   starts with `https://`; contains no `#`, no `?`, and no `@` before the first `/` after the
   scheme; the raw path (from the first `/` after `https://`) is not empty or `/`; no raw path
   segment, compared case-insensitively, is `.`, `..`, `%2e` or `%2e%2e`; and `new URL(raw)`
   succeeds, and the raw string is at most 2000 characters. Any failure: "client_id is not a
   valid metadata URL". The raw string is what
   rule 6 compares; the parsed URL supplies host, port and path for rules 2-3.
2. Resolve the host (`lookup(host, { all: true })`; failure 503 "host did not resolve"); a literal
   IP host is used as is, an IPv6 literal with its brackets removed. Every address must be public by `is_public_address` (below), else
   "host resolves to a non-public address".
3. Fetch `https://<first address, IPv6 bracketed><":" + port, only when the URL names a
   port><path>` with `Host: <host, plus ":" + port only when the URL names one>`,
   `Accept: application/json`, `tls: { serverName: <host> }`, `redirect: "manual"`,
   `signal: AbortSignal.timeout(5000)`. Abort or network error: 503 "host did not answer".
4. Status: 200 only. 3xx "redirects are not followed"; 5xx 503 "host failed"; other "host
   answered <status>".
5. Body: `Content-Length` above 5120, or more than 5120 bytes read: "document is larger than 5 KB".
6. JSON object, else "document is not a JSON object". `client_id` must equal the URL string
   exactly ("client_id does not match the URL"). `client_name` a non-empty string, cut to 200
   characters ("client_name missing or invalid" when absent, empty or not a string).
   `redirect_uris` a non-empty array of strings, each parsing with `new URL()` to
   protocol `https:`, or to protocol `http:` with hostname exactly `localhost` or `127.0.0.1`,
   and each at most 2000 characters ("redirect_uris missing or invalid").
   `token_endpoint_auth_method` absent or `"none"`; `client_secret` absent ("client is not a
   public client"). `grant_types` absent or containing `authorization_code`; `response_types`
   absent or containing `code` ("client does not use the authorization code flow").
7. `max_age` from `Cache-Control`: `no-store` or `no-cache` gives 0; `max-age=N` gives
   `min(N, 86400)`; absent gives 300 (the draft: "The authorization server SHOULD also enforce a minimum effective
cache duration when none is otherwise indicated."). An error is never
   cached (the caller caches only a 200).

`is_public_address(ip)` refuses (RFC 6890 and successors): IPv4 `0.0.0.0/8`, `10.0.0.0/8`,
`100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`,
`192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
`203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`; IPv6 `::/128`, `::1/128`, `::ffff:0:0/96` (then
the embedded IPv4 is checked), `64:ff9b::/96`, `100::/64`, `2001::/23`, `2001:db8::/32`,
`2002::/16`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, and `::/96` (IPv4-compatible). The CIDR parser is the pure-JS one proven in
spike `spike-ratelimit` (`unit.js`, 21 cases), ported to TypeScript.

### D6. Rate-limit exemption by shared secret (contract amended)

PocketBase's limiter (`apis/middlewares_rate_limit.go:15-16`, id `pbRateLimit`, priority -1000)
skips a request when `isIPInList(ExcludedIPs, e.RealIP())` (`:191-195`), and `RealIP()` reads the
trusted-proxy header (`X-Real-IP`, decision:rate-limit-counts-x-real-ip) at call time
(`core/event_request.go:40-75`). Collection CRUD and auth handlers re-check the same rule inside
the handler (`apis/record_crud.go:42`), so unbinding the middleware is not enough. Proven
mechanism (room, port 8608, all six variants of forged headers counted): a middleware at
priority **-1040** sets `X-Real-IP` to the sentinel `192.0.2.254` (TEST-NET-1, never a real
client) only for an exempt request, and deletes any `X-Real-IP` naming the sentinel otherwise;
`rateLimits.excludedIPs` holds the sentinel.

What makes a request exempt: the header `X-TM-Internal` equal (`$security.equal`, constant time)
to env `MCP_INTERNAL_SECRET`, which must be non-empty. The connection address is not used:
Railway documents that its edge sets `X-Real-IP` but not the address its edge connects from
(https://docs.railway.com/networking/public-networking/specs-and-limits), so "the private
network" could not be shown to exclude public traffic. The contract's Rate limits section now
says this. The header is deleted after the check, so no hook downstream sees the secret.

### D7. Credential check at the MCP service: one `GET /api/tracker/me` per request

The service sends `GET {PB_INTERNAL_URL}/api/tracker/me` with the caller's key and
`X-TM-Internal` on every authenticated POST. 200 gives `key.scope` (contract: `/me` gains `key`);
401 is `invalid_token`; anything else, or no answer within 5 s, or a 200 whose body has no
`key` object or whose `key.scope` is neither `read` nor `write`, is 503 `unavailable` (logged as
"credential check failed: <status or reason>"). No positive
result is cached: the spec's "a key revoked since its last request answers 401" rules a cache
out. The exempt call costs one indexed lookup plus the `/me` queries; Risks R5 names the
fallback if that is too heavy.

### D8. Rate limits at the MCP service

`services/mcp/src/limits.ts` exports `class FixedWindow { constructor(limit: number, window_ms:
number); over(key: string, now: number): number; hit(key: string, now: number): number }`. A
bucket is `{ start, count }`; a bucket whose `start + window_ms <= now` is treated as absent.
Only `hit` is used by the pipeline (D9); `over` serves the suites' assertions. `hit` starts or
reuses the bucket, increments `count` (always, also past the limit), and returns
0 when `count <= limit`, else `Math.max(1, Math.ceil((start + window_ms - now) / 1000))`. `over`
never counts and returns that same wait when the bucket exists and `count >= limit`, else 0. So
with limit 30 the 31st `hit` in a window is the first refused, and after 30 hits `over` refuses.
A key's bucket is `sha256(key)` hex (never the key itself). Windows: 300 per
60 000 ms per key; 30 per 60 000 ms per address for a missing or refused credential. When the
map passes 10 000 entries, `hit` first deletes every expired entry. Client address: the
rightmost comma-separated token of `X-Real-IP` (Railway's edge sets it on the public listener,
the same reading the API uses), else Bun's `server.requestIP(req).address`. Single replica
(`deploy/railway/railway.ts` replicas 1), so in-memory counts are complete.

### D9. Pipeline order on the public listener (`services/mcp/src/app.ts`)

1. Path `/.well-known/oauth-protected-resource` or `/.well-known/oauth-protected-resource/mcp`:
   GET or HEAD answers 200 with the PRM document (D10), `Cache-Control: public, max-age=300`; any
   other method 405, `Allow: GET, HEAD`, empty body. No Origin check, no rate limit (it is
   public and static; it is also the healthcheck path).
2. Any path other than `/mcp`: 404 error object `not_found`, "Nothing is served at this path.".
3. `Origin` present and not in `MCP_ALLOWED_ORIGINS`: 403 `origin_not_allowed`, "Requests from
   this web origin are not accepted.".
4. Method `OPTIONS`: 204, `Allow: POST`, plus, for a listed `Origin`,
   `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: POST`,
   `Access-Control-Allow-Headers: Authorization, Content-Type, Accept, MCP-Protocol-Version,
   Mcp-Method, Mcp-Name`, `Access-Control-Max-Age: 600`, `Vary: Origin`. Any method other than
   POST: 405, `Allow: POST`, empty body.
5. Credential (D7). No `Authorization`, or blank after trimming: count the address (`hit`); over
   the limit 429; else 401 `unauthorized`, "This endpoint needs an API key or a sign-in.",
   challenge without `error`. A value that after trimming and dropping a leading
   case-insensitive `Bearer ` does not start with `tmk_`: count the address; 429 or 401
   `invalid_token`, "The credential is invalid, revoked or expired.", challenge with
   `error="invalid_token"`. A `tmk_` value: always call `/me` first, so a valid key is never
   refused for its address's count (the contract counts a valid credential by the key alone);
   200 goes on to step 6; 401 counts the address (`hit`) and answers 429 when that returns a
   wait, else 401 `invalid_token`; anything else answers 503 and counts nothing. A flood of
   refused keys therefore still reaches the API, each as one indexed `key_hash` lookup that the
   key middleware answers 401 before any route runs (Risks R11). The header is read exactly as the API reads
   it: `.trim()`, then `.replace(/^bearer\s+/i, "")`.
6. Key limit (`hit` on the key's hash): over answers 429 `rate_limited`, "Too many requests for
   this credential; retry after the time given.".
7. `Accept` not containing both `application/json` and `text/event-stream`
   (case-insensitive substring test): 406 JSON-RPC `{"jsonrpc":"2.0","id":null,"error":
   {"code":-32600,"message":"The Accept header must list application/json and
   text/event-stream."}}` (the contract's request rule; added to its error table). Then the body,
   read once with `const text = await req.clone().text()` so `req` keeps its body for the SDK:
   `Content-Type` whose media type is not `application/json` (parameters allowed), unparsable
   JSON, a JSON array, or a non-object: 400 JSON-RPC `{"jsonrpc":"2.0","id":null,"error":
   {"code":-32600,"message":"The body must be one JSON-RPC message."}}`.
8. `method` `tools/call` naming a catalog tool whose `annotations.readOnlyHint` is not `true`,
   under a `read` key: 403 `insufficient_scope`, "This credential is read-only; this tool needs
   write access.", header `WWW-Authenticate: Bearer error="insufficient_scope", scope="read
   write", resource_metadata="<PRM URL>"`.
9. The SDK (D2) with a server from `make_server` (D11) whose config is `{ url: PB_INTERNAL_URL,
   key` (the trimmed value with `Bearer ` removed)`, headers: { "X-TM-Internal": MCP_INTERNAL_SECRET } }` and whose `scope_of` returns the
   checked scope. No `authInfo` is passed: the scope travels in the factory's closure, so
   `createMcpHandler` is called per request with that request's factory. The exact sequence
   (spike-proven against `@modelcontextprotocol/server` 2.4.0):

   ```ts
   async function serve_mcp(req: Request, body: unknown, factory: () => Server): Promise<Response> {
     if (!(await isLegacyRequest(req, body))) {
       return createMcpHandler(factory, { legacy: "reject", responseMode: "json" }).fetch(req, {
         parsedBody: body,
       });
     }
     const server = factory();
     const transport = new WebStandardStreamableHTTPServerTransport({
       sessionIdGenerator: undefined,
       enableJsonResponse: true,
     });
     await server.connect(transport);
     try {
       return await transport.handleRequest(req, { parsedBody: body });
     } finally {
       void server.close();
     }
   }
   ```

   `isLegacyRequest` is async (awaited in the spike). All four SDK names come from the
   `@modelcontextprotocol/server` package root, re-exported by `clients/tm/src/mcp.ts`.

Every 401, 403 and 429 error object is `{"error": {"status", "code", "message"}}` with
`Content-Type: application/json`; every 401 carries `WWW-Authenticate: Bearer
resource_metadata="<MCP_PUBLIC_URL>/.well-known/oauth-protected-resource/mcp", scope="read
write"` (plus `, error="invalid_token"` when a credential was sent); every 429 and 503 carries
`Retry-After` (429: the seconds `hit`/`over` returned; 503: `5`). Any response to a request whose
`Origin` is listed also carries `Access-Control-Allow-Origin: <origin>`,
`Access-Control-Expose-Headers: WWW-Authenticate, Retry-After` and `Vary: Origin`
(api-versioning-policy later adds `Api-Version`, D18). A request
body has no size cap of its own beyond Bun's `Bun.serve` default. An exception
anywhere answers 500 `server_error`, "The service failed; try again.", and logs the error
without the `Authorization` value. The service never reads a credential from the query string.

### D10. Configuration (env), with no defaults for anything a deploy must set

| Service | Variable | Value on Railway | Missing |
| --- | --- | --- | --- |
| mcp | `PORT` | Railway-provided | 8080 |
| mcp | `MCP_HOST` | unset (listens on `::`) | `::`; suites set `127.0.0.1` |
| mcp | `MCP_INTERNAL_PORT` | `8081` | 8081 |
| mcp | `PB_INTERNAL_URL` | `http://${{pocketbase.RAILWAY_PRIVATE_DOMAIN}}:<pocketbase PORT>` | exit 1 |
| mcp | `PB_PUBLIC_URL` | `${{pocketbase.PB_PUBLIC_URL}}` ({API}) | exit 1 |
| mcp | `MCP_PUBLIC_URL` | `https://mcp.<API host>` ({MCP}) | exit 1 |
| mcp | `MCP_INTERNAL_SECRET` | 64 hex characters, shared with pocketbase | exit 1 |
| mcp | `MCP_ALLOWED_ORIGINS` | unset | `https://claude.ai,https://www.cursor.com` |
| pocketbase | `MCP_INTERNAL_SECRET` | same value | exemption off; metadata-document clients refused |
| pocketbase | `MCP_INTERNAL_URL` | `http://${{mcp.RAILWAY_PRIVATE_DOMAIN}}:8081` | metadata-document clients refused |
| pocketbase | `MCP_PUBLIC_URL` | same as mcp's | any `resource` parameter answers `invalid_target` |

`MCP_ALLOWED_ORIGINS` unset, or empty after splitting, means the default list; otherwise it is
split on `,`, each entry trimmed, empty entries dropped, and an `Origin`
header is allowed when it equals an entry exactly (browsers send the serialised, lowercase
form). `load_env()` reads the mcp rows above except `PORT`, `MCP_HOST` and `MCP_INTERNAL_PORT`,
which `main.ts` reads; `client_ip(req, server)` lives in `main.ts`. `load_env()` in
`services/mcp/src/app.ts` throws `missing environment variable <NAME>` for each
"exit 1" row, and `main.ts` prints it to stderr and exits 1, so a misconfigured deploy fails its
healthcheck loudly. Trailing slashes are stripped from every URL variable. The PRM document is:
`{"resource": "<MCP_PUBLIC_URL>/mcp", "authorization_servers": ["<PB_PUBLIC_URL>"],
"scopes_supported": ["read", "write"], "bearer_methods_supported": ["header"], "resource_name":
"Task tracker"}`. The authorization server's `issuer` is the API's existing `PB_PUBLIC_URL`
(the value `pb_hooks/mail.pb.js:24-25` already reads, same fallback `http://127.0.0.1:8090`),
trailing slash stripped, so PRM's `authorization_servers[0]` and the issuer come from one
Railway variable.

### D11. The catalog module (`clients/tm/src/mcp.ts`) after the change

Exports (names fixed): `TOOLS` (unchanged content), `type Scope = "read" | "write"`,
`tools_for(scope: Scope)` (catalog order, `run` stripped, `read` keeps only
`annotations.readOnlyHint === true`), `error_result(status: number | null, message: string,
data?: Record<string, unknown>): ToolResult` (AC-13 shape), `call(cfg, name, args):
Promise<ToolResult>`, `make_server(cfg: Config, scope_of: () => Promise<Scope>): Server`,
`serve(cfg)`, the re-exports `export { createMcpHandler, isLegacyRequest,
WebStandardStreamableHTTPServerTransport, Server } from "@modelcontextprotocol/server"` (for the
MCP service, D1), `VERSION` (read from `clients/tm/package.json` with `node:fs` `readFileSync` and
`new URL("../package.json", import.meta.url)`, so it runs under Node as well as Bun). Local types, declared in the file
(nothing is imported from SDK type paths): `type ToolDef = { name: string; description: string;
inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
run: (cfg: Config, a: any) => Promise<unknown> }` (so `annotations` is required) and `type
ToolResult = { content: { type: "text"; text: string }[]; isError: boolean;
structuredContent?: Record<string, unknown> }`. The only casts are `as any` on the return value
of each of the two `setRequestHandler` callbacks in `make_server`.

`error_result`'s `code`: `status === null` `invalid_arguments`; `0` `unreachable`; exactly one
entry under `data` whose `code` is a string, that code; more than one entry `validation_failed`;
2xx `bad_response`; 400 `invalid_request`; 401 `unauthorized`; 403 `forbidden`; 404 `not_found`;
409 `conflict`; 429 `rate_limited`; other 4xx `request_failed`; 5xx `server_error`. `fields` is
`data` (default `{}`). The result is `{ content: [{ type: "text", text:
JSON.stringify(structuredContent) }], isError: true, structuredContent: { error: { status, code,
message, fields } } }`.

`call`: unknown name throws `ProtocolError(InvalidParams, "Unknown tool: <name>")`; schema failure
returns `error_result(null, "<name>: <ajv message>")`; `UsageError` returns `error_result(null,
e.message)`; `ApiError` returns `error_result(e.body.status, e.body.message, e.body.data)`;
anything else is rethrown (the SDK answers `-32603`). Success is unchanged: one text block of
`JSON.stringify(result, null, 2)`, `isError: false`.

`tm mcp`'s `scope_of` calls `api(cfg, "GET /api/tracker/me", {})` on every `tools/list` and
returns `key.scope`; when the call throws or `key` is absent it returns `"write"` (the full list;
a call then fails with the API's own structured 401 or 403, which the agent can read).

`clients/tm/src/api.ts`: `Config` gains `headers?: Record<string, string>`, and `request()` sends
`{ ...cfg.headers, Authorization: cfg.key, "Content-Type": "application/json" }`. `tm` never sets
`headers`; the MCP service sets the secret there so every catalog call is exempt (D6).

### D12. AC-12 in the key middleware

Room probe (port 8608): an unmatched route reaches the middleware with `e.request.pattern`
`GET /{path...}` (GET/HEAD, PocketBase's static catch-all) or `/` (other methods); a collection
route naming a missing collection has the real pattern and no collection. `throw new
NotFoundError()` answers `404 {"data":{},"message":"The requested resource wasn't
found.","status":404}`. So `pb_hooks/api_keys.pb.js`, after the key is validated (a bad key still
answers 401 first), throws `NotFoundError()` when the stripped route is `/{path...}` or `/`, or
when the matched route has a `{collection}` path value (`e.request.pathValue("collection")`
non-empty) and `$app.findCollectionByNameOrId` finds no such collection, for every such route
(record routes, `GET /api/collections/{collection}`, auth routes and the rest). A system, `_`-prefixed or `api_keys`
collection keeps 403 `api_key_path`. Requests whose path starts with `/oauth/` or `/.well-known/`
skip the key middleware entirely (`return e.next()` before reading the header): those routes are
public and take no key, and a stray `Authorization` must not turn a token request into a 401
(proven: today `Bearer tmk_bogus` on `/oauth/authorize` answers 401).

The middleware also records the validated key for `/me`: `e.set("tmApiKey", { id, scope,
expires: key.getString("expires"), client_id: key.getString("client_id") })` (room probe:
`e.set` in a middleware is read by `e.get` in the route handler).

### D13. Storage

**`api_keys` gains four fields** (one migration, ids continuing the collection's `4200600xxx`
series, which currently ends at `autodate4200600008`):

| Field | Id | Type | Options | Help |
| --- | --- | --- | --- | --- |
| `client_id` | `text4200600009` | text | max 2000 | "The app a sign-in minted this key for, or empty for a key minted by hand; set by the server, and a later change is refused." |
| `refresh_hash` | `text4200600010` | text | hidden, max 64 | "A fingerprint of the sign-in's current refresh token, filled by the server and never shown to clients." |
| `refresh_expires` | `date4200600011` | date | hidden | "When the sign-in's current refresh token stops working; set by the server." |
| `refresh_prev_hash` | `text4200600012` | text | hidden, max 64 | "A fingerprint of the refresh token the current one replaced, kept so a replayed token ends the sign-in." |

Indexes added: ``CREATE UNIQUE INDEX `idx_api_keys_refresh_hash` ON `api_keys` (`refresh_hash`)
WHERE `refresh_hash` != ''`` and ``CREATE INDEX `idx_api_keys_refresh_prev_hash` ON `api_keys`
(`refresh_prev_hash`) WHERE `refresh_prev_hash` != ''``. Update rule: the current rule
(`schema/api_keys.rules.json`) plus ` && @request.body.client_id:isset = false`; the hidden
fields need no conjunct, because PocketBase drops a hidden field from a non-superuser's body
(`tests/test_api_keys.ts:263`, proven for `key_hash`); the migration follows the guard of
`v2:pb_migrations/1785188300_server_owned_fields_locked.js`: `up` splits the rule on that tail and
aborts if the tail is already present; `down` aborts unless the tail occurs exactly once, at
the end, and then removes it.
Help changes: `key_hash` becomes "A fingerprint of the key, filled by the server and never shown
to clients; a value sent at create is replaced, a client's later change is refused, and a
sign-in's refresh replaces it."; `expires` becomes "When the key stops working, or empty for a
key that never expires; a client sets it only at create, and a sign-in's refresh moves it
forward.". Why a third hidden field: a replay ("a refresh token already used ends the grant")
needs the previous token's hash; only the generation just replaced is kept (Risks R7).

**`oauth_codes`** (new base collection, every rule `null`, so only the server reads it):

| Field | Id | Type | Options |
| --- | --- | --- | --- |
| `code_hash` | `text4300100001` | text | required, max 64 |
| `user` | `relation4300100002` | relation to `_pb_users_auth_` | required, maxSelect 1, cascadeDelete |
| `client_id` | `text4300100003` | text | required, max 2000 |
| `client_name` | `text4300100004` | text | required, max 200 |
| `redirect_uri` | `text4300100005` | text | required, max 2000 |
| `code_challenge` | `text4300100006` | text | required, min 43, max 43 |
| `scope` | `select4300100007` | select | required, values `read`, `write`, maxSelect 1 |
| `expires` | `date4300100008` | date | required |
| `created` | `autodate4300100009` | autodate | onCreate |

Collection id `oauthcodes00001`. Indexes: unique `idx_oauth_codes_code_hash` on `code_hash`;
`idx_oauth_codes_expires` on `expires`. Help (one per field): `code_hash` "A fingerprint of the
one-time code, never the code itself."; `user` "The account that approved the sign-in."; `client_id`
"The app the code was issued to."; `client_name` "The app's name, which becomes the key's name.";
`redirect_uri` "Where the app asked to be sent back; the exchange must name the same address.";
`code_challenge` "The app's PKCE challenge (S256)."; `scope` "The access the person granted.";
`expires` "Ten minutes after issue; an expired code is refused and later purged."; `created`
"When the code was issued.". Expired rows are deleted each time a code is issued (`DELETE FROM
oauth_codes WHERE expires < {:now}` through `$app.db().newQuery(...).bind({ now }).execute()`), so
no cron is added.

Metadata documents are cached in `$app.store()` under `cimd:<client_id>` as `{ client, exp }`.
OTP wrong-guess counts live under `oauth_otp_tries:<otp id>`. The page-signing secret is
`oauthFlowSecret`, set once per boot with `$security.randomString(40)` in `onBootstrap`, the
pattern of `pb_hooks/mail.pb.js:19` (`signupMailSecret`).

### D14. Authorization endpoint behaviour

Parameters are read with `parse_form` (D15) from `e.request.url.rawQuery` on GET and from the
body on POST (the page echoes them as hidden inputs). An empty value counts as absent for every
parameter (so a page that echoes an absent `state` as `state=""` never adds `state=` to a
redirect). Any parameter given twice, or a query or body `parse_form` refuses, answers the error page "The sign-in request is malformed." (400).
Each request is then validated in this order:

1. `client_id` and `redirect_uri` present, else error page "The sign-in request is incomplete.".
2. Client: an own property of `CLIENTS` (`Object.prototype.hasOwnProperty.call(CLIENTS, id)`,
   so `constructor` or `__proto__` never match; `pb_hooks/lib/oauth.js`), else a URL starting `https://` resolved
   through D4/D5 (cache first), else error page "The app asking to sign in is not known to Task
   Tracker.". D5 422: "The app asking to sign in could not be verified.". D5 503, an empty
   `MCP_INTERNAL_URL`, or no answer within 8 s: "The app asking to sign in could not be verified
   right now. Try again in a minute.".
3. `redirect_uri` matches a registered URI: exact string equality, or both are loopback (`http://`
   plus `localhost` or `127.0.0.1`, any or no port) with equal host and equal path-and-query once
   the port is removed. Else error page "The app asked to return to an address it has not
   registered.".
4. `response_type` is `code`, else error page "The app sent a sign-in request Task Tracker does
   not support.".
5. From here a failure redirects to `redirect_uri` with `error`, `state` (when sent) and `iss`:
   `code_challenge` absent or not 43 characters of `[A-Za-z0-9_-]`, or `code_challenge_method` not
   `S256`: `invalid_request`. `scope` (D15 parse) invalid: `invalid_scope`. `resource` present
   and, after lowercasing scheme and host, not equal to `<MCP_PUBLIC_URL>/mcp`: `invalid_target`.

Error pages answer status 400. Every page response carries `Content-Security-Policy: default-src
'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'` (no `form-action`,
which some browsers apply to the post-approval redirect), `X-Frame-Options: DENY` (overrides
PocketBase's default `SAMEORIGIN`, proven), `Cache-Control: no-store`, `Referrer-Policy:
no-referrer`.

**The flow token** binds each form to the page that served it. Payload
`<stage>|<q>|<user id or "">|<otp id or "">|<expiry ms>`, where `q` is
`$security.sha256(JSON.stringify([client_id, redirect_uri, code_challenge, scope, state,
resource]))` of the raw parameter strings (`""` when absent) and expiry is now plus 600 000 ms;
token `<payload>|<$security.hs256(payload, oauthFlowSecret)>`. Every POST requires a token whose
signature matches (`$security.equal`), whose `q` matches the posted parameters and whose expiry
has not passed; a mismatch or expiry re-renders the sign-in stage with "This sign-in took too long
or was changed. Start again.". The token's characters need no escaping.

**Stages** (one template, `pb_hooks/views/oauth_authorize.html`, rendered with `$template`, whose
Go `html/template` escaping was proven on text and attribute contexts):

| POST `action` | Needs stage | Does | Next |
| --- | --- | --- | --- |
| (GET) | none | validate | `signin` |
| `password` | `signin` | `$app.findAuthRecordByEmail("users", email)` (throws when unknown), `validatePassword`, then the users `authRule` via `$app.canAccessRecord(u, new RequestInfo({ auth: u }), u.collection().authRule)` | `consent`, or `signin` with a message |
| `send_code` | `signin` | known email: create a `_otps` record (`collectionRef`, `recordRef`, `sentTo`, `setPassword(code)`) with an 8-digit code from `$security.randomStringWithAlphabet(8, "0123456789")`, then `$mails.sendRecordOTP($app, u, otp.id, code)`; unknown email: nothing | `code` (otp id in the token, `""` when unknown) |
| `verify_code` | `code` | inside `$app.runInTransaction`: `findOTPById`, `hasExpired(u.collection().otp.durationTime())`, `validatePassword(code)`, delete on success; a wrong guess increments `oauth_otp_tries:<id>` and at 5 deletes the OTP; then the `authRule` check | `consent`, or `code` with a message |
| `approve` | `consent` | issue a code (D15) | 302 to `redirect_uri?code=&state=&iss=` |
| `deny` | `consent` | nothing | 302 to `redirect_uri?error=access_denied&state=&iss=` |

Any other `action`, or an action posted with the wrong stage's token, re-renders `signin` with
the "Start again" message. Every re-rendered stage page (a message on `signin`, `code` or
`consent`) answers 200; only the `error` stage answers 400. When the `authRule` check fails: `!u.verified()` gives the unverified message, else
`!u.getBool("approved")` the unapproved one, else "This account cannot sign in yet.". Messages
(behaviour, never mechanism): wrong password or unknown email
"That email and password do not match an account."; unverified "This account cannot sign in
yet: confirm your email address first."; unapproved (verified, `approved` false) "This account
cannot sign in yet: it is waiting for approval."; wrong, expired or exhausted code "That code is
wrong or has expired. Request a new one."; mail failure "The code could not be sent. Try again in
a minute, or sign in with your password.". The `code` stage says "If that address belongs to an
account, a code is on its way." whether or not it does. The `consent` stage shows: "<client
name> wants to use your Task Tracker account."; for a document client "It identifies itself as
<client_id host>."; for a pre-registered client "It is registered with Task Tracker as <client_id>." (a
pre-registered id has no host, so the id itself stands where the contract says "the `client_id`
host"); "After
you answer, you return to <redirect host>."; for a loopback redirect "This app runs on your own
computer. Approve only if you started this sign-in yourself."; radio `access` with `read` "Read:
see your workspaces, projects and items." and `write` "Read and write: also create, edit and
comment on items.", preselected from the request's scope; buttons Approve and Deny. The person's
choice decides the granted scope either way (RFC 6749 §3.3 lets the server grant a different
scope). An `access` value other than `read` or `write` re-renders `consent` unchanged.
Superusers cannot sign in here: only the `users` collection is searched. Emailed codes are
limited only by the API's `/oauth/` rule (30 per minute per address), not by PocketBase's own
`request-otp` rule (5 per minute), which applies to its own route only; a code still expires
after the users collection's OTP duration (180 s) and allows five wrong guesses.

After step 4 passes, the GET and POST handlers run inside one `try`; any exception (a failed
`issue_code`, a failed OTP save, a template error) is logged and answered with a redirect
carrying `error=server_error`, `state` and `iss`. Before step 4 passes, an exception answers the
error page "The sign-in could not continue. Try again." (400).

Redirect URLs: the redirect URI plus `?` (or `&` when it already has a query), then
`encodeURIComponent`-encoded pairs in the order `code`/`error`, `state` (only when sent), `iss`.

### D15. Token and revocation endpoints

Bodies are read with `toString(e.request.body)` (room probe: returns the raw form, e.g.
`a=1&a=2&b=x+y%2Bz`) and parsed by `parse_form(raw)` in `pb_hooks/lib/oauth.js`: split on `&`,
then `=`, `+` to space, `decodeURIComponent`; a key seen twice goes into `repeated`; a body over
16 384 characters, or a `decodeURIComponent` failure, is `invalid_request` "The request body is
not a valid form.". Every answer carries
`Cache-Control: no-store` and `Pragma: no-cache`; errors are `400 {"error", "error_description"}`.

`parse_scope(raw)`: absent or blank is `write`; split on spaces; each value must be `read`,
`write` or `offline_access` (ignored), else invalid; `write` present gives `write`, else `read`.
A granted scope is reported as `read` or `read write`.

PKCE: `pkce_s256(verifier)` converts `$security.sha256(verifier)` (hex) to bytes, then to
unpadded base64url, in pure JS (the JSVM has no `btoa`, room probe). RFC 7636 Appendix B vector:
`dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` gives `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`
(hex `13d31e96...f9c3` proven from the room).

Known client: `client_id` is an own property of `CLIENTS` or starts with `https://`. At the token
endpoint (both grants) and the revocation endpoint, right after the missing/repeated check, an
unknown `client_id` answers `invalid_client` "The client is not known." (contract: token and
revocation errors, "Unknown `client_id`").

Transactions: each `$app.runInTransaction` callback returns a result object (`{ error: [code,
description] }` or `{ ok: ... }`) instead of throwing, so its writes commit, and the answer is
built after it returns. Consequences: a code that was found is consumed whatever check fails
after it (a failed exchange burns the code); a replayed refresh token's revocation is committed
before `invalid_grant` is answered. Only a database failure throws (answered 500 by PocketBase).

`grant_type=authorization_code`, checked in order: a required parameter (`code`, `redirect_uri`,
`client_id`, `code_verifier`) missing or any parameter repeated, `invalid_request` "A required
parameter is missing or repeated."; `code_verifier` not 43-128 of `[A-Za-z0-9-._~]`,
`invalid_request` "code_verifier is malformed."; `resource` present and not the MCP resource,
`invalid_target` "resource names another resource."; then in one `$app.runInTransaction`: find
`oauth_codes` by `code_hash = sha256(code)` and delete it (a second redemption finds nothing:
spike proved 20 concurrent redemptions yield one success only inside a transaction); not found
or expired, `invalid_grant` "The code is unknown, used or expired."; `client_id` differs,
`invalid_client` "The code was issued to another client."; `redirect_uri` differs,
`invalid_grant` "redirect_uri does not match the authorization request."; PKCE mismatch,
`invalid_grant` "code_verifier does not match the code challenge.". Then mint, in the same
transaction, an `api_keys` record: `user`, `name` = `client_name`, `scope`, `expires` = now + 24 h,
`client_id`, `key_hash` = sha256(`tmk_` + `$security.randomString(40)`), `refresh_hash` =
sha256(`tmr_` + `$security.randomString(40)`), `refresh_expires` = now + 30 days,
`refresh_prev_hash` "". The record is saved with `tx.save` (the `api_keys` request hook does not
run for a hook's own save). Answer 200 `{access_token, token_type: "Bearer", expires_in: 86400,
refresh_token, scope}`.

`grant_type=refresh_token`: `refresh_token` or `client_id` missing, or repeats, `invalid_request`
"A required parameter is missing or repeated.";
`resource` present and not the MCP resource, `invalid_target` "resource names another resource.";
`scope` present and its parse invalid, `invalid_scope` "scope is not one the server offers.";
then in one transaction: find `api_keys` by `refresh_hash`; if none, find by `refresh_prev_hash`
and, when found, set `revoked` true, save, and answer `invalid_grant` "The refresh token was
already used; the sign-in has ended."; if neither, `invalid_grant` "The refresh token is unknown
or expired."; record `client_id` differs, `invalid_client` "The refresh token was issued to another
client."; `revoked` true or `refresh_expires`
passed, `invalid_grant` "The refresh token is unknown or expired."; `scope` present and its
parse differs from the record's `scope`, `invalid_scope` "A refresh keeps the scope that was
granted."; else set `refresh_prev_hash` = the old `refresh_hash`, new `key_hash`, new
`refresh_hash`, `refresh_expires` = now + 30 days, `expires` = now + 24 h; answer as above.

Any other `grant_type` (present): `unsupported_grant_type` "Only authorization_code and
refresh_token are supported."; absent: `invalid_request` "grant_type is missing.".

`POST /oauth/revoke`: `token` or `client_id` missing, or any parameter repeated,
`invalid_request` "A required parameter is missing or repeated.". A `tmk_` token is looked
up by `key_hash`, a `tmr_` token by `refresh_hash`; nothing found (any other prefix included):
200 empty body. Found with `client_id` `""`: `unsupported_token_type` "Keys minted by hand are
revoked in the key list.". Found with another `client_id`: `invalid_client` "The token was
issued to another client.". Else set `revoked` true (already true is fine) and answer 200 with an
empty body (`e.noContent(200)`).

`GET /.well-known/oauth-authorization-server` answers the contract's JSON with every URL built
from the issuer (D10) and `Cache-Control: public, max-age=300`.

### D16. Route registration

Every new PocketBase route is registered through `require(`${__hooks}/lib/routes.js`).add(...)`
(the only `routerAdd` site, enforced by `scripts/check_route_registry.ts`) with a `ROUTES` entry
`auth: "none"`, `internal: true`: these routes are the OAuth surface described by the
authorization-server metadata, not by `openapi.json` (internal entries are left out of it,
`scripts/gen_openapi.ts:8`, and out of `scripts/check_route_statuses.ts:42`). Entries:
`GET /.well-known/oauth-authorization-server`, `GET /oauth/authorize`, `POST /oauth/authorize`,
`POST /oauth/token` and `POST /oauth/revoke`, each `response: { status: 200, schema: null }`, each with a one-line `summary`. The `internal:` comment line at
`pb_hooks/lib/routes.js:5` becomes "// internal: true = left out of openapi.json on purpose:
loopback-only routes the server calls itself, and the OAuth surface its own metadata describes.". The middlewares in
`pb_hooks/internal_caller.pb.js` go through `use(...)`, the only `routerUse` site.

### D17. The MCP host

`{MCP}` is `https://mcp.<API host>`, where `<API host>` is the pocketbase service's custom domain
as written in `deploy/railway/railway.ts` (`domains[0]`): the literal reading of the contract's
ruling Q5, "an `mcp.` subdomain of the API's custom domain". The same string is the `mcp`
service's `domains[0]`, its `MCP_PUBLIC_URL`, and pocketbase's `MCP_PUBLIC_URL`.

### D18. `Api-Version` on every MCP service response (api-versioning-policy)

The api-versioning-policy contract (`lane/d-versioning` `8e3ada5`, "`Api-Version` header")
requires the hosted endpoint to send `Api-Version: <API_VERSION>` on every response, any method
and path, 200, 202, 400, 401, 403, 404, 405, 406, 429, 500 and 503 included. `make_app`'s
`fetch` wraps its whole pipeline (the `catch` that answers 500 included) in one function, so a
header set on the `Response` it returns reaches every branch.

**Deferred to api-versioning-policy.** By the final build order that change is built last, after
this one, so this change builds no `Api-Version` header, imports no `API_VERSION`, and lists no
`Api-Version` in `Access-Control-Expose-Headers`. api-versioning-policy adds, in
`services/mcp/src/app.ts`, the header set in that one wrapping function from `API_VERSION` of
`clients/tm/src/api.generated.ts` plus `Api-Version` in D9's expose list, and in
`tests/test_mcp_service.ts` the cases `version_on_200`, `version_on_405`, `version_on_401`,
`version_on_404` (a W `tools/list` 200, a GET `/mcp` 405, a no-credential POST 401 and a `GET
/nope` 404, each header equal to `read_api_version(REPO_ROOT)` from `scripts/_api_contract.ts`)
and the same assertion in `api_down_503`.

### D19. Names later changes build on (extension points)

Fixed here so key-scoping, key-minting-cli and agent-verb-coverage can plan against them:

- Hook files: `pb_hooks/oauth_server.pb.js` (routes), `pb_hooks/lib/oauth.js` (helpers and
  `CLIENTS`, where key-minting-cli adds its `tm` client), `pb_hooks/views/oauth_authorize.html`
  (the one page), `pb_hooks/internal_caller.pb.js` (exemption).
- Authorization codes: collection `oauth_codes` (collection id `oauthcodes00001`), fields and ids as in D13, every rule (list, view, create, update, delete)
  `null`, app_docs record `oauthcodesdoc01` with the text in Phase 3.
- `api_keys` additions: `client_id` `text4200600009`, `refresh_hash` `text4200600010`,
  `refresh_expires` `date4200600011`, `refresh_prev_hash` `text4200600012`; the update rule gains
  ` && @request.body.client_id:isset = false` at its end.
- The matched key: the key middleware stores `e.set("tmApiKey", { id, scope, expires,
  client_id })`, a plain object read with `e.get("tmApiKey")` by any later hook or route
  (`pb_hooks/me.pb.js` returns it as `key`); key-scoping replaces the object with
  `keyInfo(key)`, and later fields are added there.
- Consent choices: the consent stage's form posts `action=approve` with the radio `access`;
  another choice (a workspace, a level) is one more named input inside the same `<form>` in the
  template's `consent` block, read from the parsed form in the `approve` branch of `POST
  /oauth/authorize`, validated there (an invalid value re-renders `consent`, status 200), and
  carried to the token exchange as a new field on `oauth_codes` and then on the minted
  `api_keys` record. The flow token binds the request parameters and the signed-in user, not
  the consent inputs, so a new input needs no change to `sign_flow`/`read_flow`.
- Suite helper: `tests/oauthkit.ts` `sign_in_and_approve` (Phase 4); a later choice is passed by
  extending its `access` argument into an options object in that change.

### D20. Prior art

Linear serves its MCP on its own host with OAuth plus direct API keys on one URL, access tokens
of "24 hours by default" and refresh tokens that expire "30 days after issuance"
(https://linear.app/developers/oauth-2-0-authentication, the contract's Sources); this design
keeps those numbers and that shape. Linear accepts a lost refresh's repeat for 30 minutes; the
contract does not, and D15 implements the stricter rule.

## Depends on

- Build order (root ruling, final): hosted-mcp-endpoint (Phases 1-9, then its root-run Phase
  10 runbook) -> key-scoping Phase 1, then Phases 2-6 as one PR, then Phase 7 as the next PR, all
  before key-minting-cli starts -> key-minting-cli -> tm-distribution -> agent-verb-coverage ->
  api-versioning-policy last, and in any case before the hosted MCP address is given to any
  outside user (release 1.0.0 is cut then). Phase 10's sign-in check (step 10) is the owner's
  own; the address goes to no outside user until api-versioning-policy is built. Nothing comes before this change: it
  builds on `origin/main` at `d1b5cf3` as read in this design.
- This change is built before api-versioning-policy, so it cuts no API release and edits no
  `api/` file or `mcp-tools.json`. If `scripts/release_api.ts` exists when a phase starts, the
  build order was changed: stop and report.
- Later changes edit files this plan touches (sibling commits read: `lane/d-minting` `9f99806`
  and `0128dfe`, `lane/d-verbs` `9433c0f`, `lane/d-versioning` `86b0dcb` and `8e3ada5`,
  `lane/d-dist` `202703b`, `lane/d-scoping` `f1cabe1`):
  - `pb_hooks/api_keys.pb.js`, the `api_keys` update rule and a later migration on the collection:
    key-scoping (AC-3, AC-4) and key-minting-cli (`manage_keys`, `last_used`), each appending to
    the rule this change extends.
  - `pb_hooks/me.pb.js`, the `GET /api/tracker/me` entry in `pb_hooks/lib/routes.js` and the
    `tmApiKey` value set by the middleware (a plain object `{ id, scope, expires, client_id }` here):
    key-scoping replaces the object with `keyInfo(key)`, and later fields are added there
    (key-minting-cli's `manage_keys` among them).
  - `pb_hooks/lib/oauth.js` (`CLIENTS`), `pb_hooks/oauth_server.pb.js` and
    `pb_hooks/views/oauth_authorize.html`: key-minting-cli adds the `tm` client and its consent.
  - `clients/tm/src/mcp.ts`: agent-verb-coverage adds tools to `TOOLS`.
  - `clients/tm/package.json`, `bun.lock`, `clients/tm/README.md`: tm-distribution renames and
    versions the package; `VERSION` (D11) follows whatever version it sets.
  - `services/mcp/src/app.ts` and `tests/test_mcp_service.ts`: api-versioning-policy, built
    last, adds the `Api-Version` header and its cases there (D18).
  - The newest `pb_migrations/*_seed_app_docs.js`, `scripts/gen_app_docs_seed.ts`
    `DEFAULT_OUTPUT`, `scripts/app_docs_seed.sha256`, `.gitattributes`: every collection change
    re-seeds.
  - `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`,
    `e2e/smoke.ts`, `docs/readiness/agent-clients.md`: shared registries.

## Implementation Plan

Common to every phase: run every command from the repository root; a gate is run alone and its
`$?` read; rooms use `PB_PORT_OFFSET` (the builder's own) and `PB_BIN=$PWD/pocketbase`. A new
migration's slot comes from `make next-migration-slot` at build time. "Regen" means, in this
order: `bun scripts/gen_schema.ts`, `bun scripts/model/extract_current.ts`,
`bun scripts/gen_openapi.ts`, `bun scripts/gen_tm_client.ts` (each without `--check`), which
rewrite `schema/`, `pb_hooks/field_patterns.json`, `scripts/model/current/`, `openapi.json` and
`clients/tm/src/api.generated.ts`. A new suite is registered by a `run_suite "<label>" bun
tests/<file>.ts` line appended after the last `run_suite` line of `scripts/run_suite_battery.sh`
and a row `<shard><TAB><seconds><TAB><label>` in `scripts/battery_shards.tsv`, where
`<seconds>` is the suite's own measured wall time (`time bun tests/<file>.ts`, rounded up to a
whole second) as the file's header asks, `<shard>` is the shard whose seconds sum lowest (ties:
the lower number), inserted after the last row with equal or greater seconds so the rows stay
sorted by seconds descending as `scripts/check_battery_suites.ts` requires (re-measured by the next CI
run). New suites follow `tests/test_tm_mcp.ts`'s skeleton: port `<default> +
PB_PORT_OFFSET`, scratch copies, `pocketbase superuser upsert` before `roomkit.serve`, a local
`check(label, got, expected)` counter, `finally` that stops every process it started by handle
and removes scratch, exit 1 on any failure.

### Phase 1. AC-12 and the key on `/me`, and the `api_keys` grant fields

- **Goal:** under a key an unknown path or collection answers 404, `/me` reports the key, and
  `api_keys` holds the grant fields (contract: API keys errors, `GET /api/tracker/me`, The minted
  key: Storage; criterion AC-12).
- **Files:**
  - create `pb_migrations/<slot>_api_keys_grant_fields.js`
  - create `pb_migrations/<slot2>_seed_app_docs.js` (`<slot2>` the slot after `<slot>`)
  - modify `scripts/gen_app_docs_seed.ts`
  - modify `pb_hooks/api_keys.pb.js`
  - modify `pb_hooks/me.pb.js`
  - modify `pb_hooks/lib/routes.js`
  - modify `tests/test_api_keys.ts`
  - modify `tests/test_me_route.ts`
  - modify `docs/readiness/agent-clients.md`
  - regen: `schema/`, `pb_hooks/field_patterns.json`, `scripts/model/current/`, `openapi.json`,
    `clients/tm/src/api.generated.ts`, plus `bun scripts/gen_app_docs_seed.ts` (rewrites the new
    seed and `scripts/app_docs_seed.sha256`) and `bun scripts/gen_gitattributes.ts` (rewrites
    `.gitattributes`)
- **Steps:**
  - Seed (the recipe in `.agents/rules/pocketbase.md`): `cp` the newest
    `pb_migrations/*_seed_app_docs.js` to `<slot2>_seed_app_docs.js`, set `DEFAULT_OUTPUT` in
    `scripts/gen_app_docs_seed.ts` to it, edit two records in the new file by **appending only**
    (`scripts/check_app_docs_history.ts` refuses a seeded sentence that vanishes, so no existing
    sentence is rewritten), then run the two generators. Append to `collection:api_keys`'s
    `body`, after its last sentence: "\n\n**Sign-in fields.** client_id (text, up to 2000
    characters) names the app a sign-in minted the key for and is \"\" for a key minted by hand;
    a value sent at create is replaced with \"\", and a later change to it is refused with 404
    like a change to scope. Three HIDDEN fields serve a sign-in's refresh: refresh_hash,
    refresh_expires and refresh_prev_hash." Append to `concept:api-keys`'s `body`, after its last
    sentence: "\n\n**Unknown paths.** A key request to a path that matches no route, or to a
    collection route naming a collection that does not exist, answers 404 as it does without a
    key; 403 api_key_path is kept for routes that exist. Requests under /oauth/ and /.well-known/
    skip the key check. GET /api/tracker/me reports a key's own id, scope, expiry and client under
    key."
  - Migration: D13's four fields, two indexes, rule append with drift guard, two help changes;
    `down` removes the fields and indexes and restores the rule and help texts.
  - `pb_hooks/api_keys.pb.js`:
    - In the create hook, after `e.record.set("key_hash", ...)`, `e.record.set("client_id", "")`
      (a value sent by any caller, a superuser included, is replaced).
    - The order inside the middleware: the `/oauth/`/`/.well-known/` skip first; key lookup and
      the 401 checks as today; then `const route = ...` as today; then the two `NotFoundError`
      checks; then the allowlist.
    - In the middleware, first line: `const p = e.request.url.path; if (p.startsWith("/oauth/") ||
      p.startsWith("/.well-known/")) return e.next();`.
    - After `route` is computed and before the allowlist: when `route ===
      "/{path...}" || route === "/"`, `throw new NotFoundError()`. Then, when `e.request.pathValue("collection")` is non-empty and
      `$app.findCollectionByNameOrId` of it throws, `throw new NotFoundError()` (any route with a
      `{collection}` segment; system, `_` and `api_keys` collections exist, so they stay
      refused by the allowlist).
    - Before `e.auth = owner`: `e.set("tmApiKey", { id: key.id, scope: key.getString("scope"),
      expires: key.getString("expires"), client_id: key.getString("client_id") })`.
  - `pb_hooks/me.pb.js`: read `const k = e.get("tmApiKey")`; when set, add `key: k` to the answer
    object after `workspaces`; when not set, omit the property.
  - `pb_hooks/lib/routes.js` `"GET /api/tracker/me"`: add property `key` (object; properties `id`,
    `scope` (enum `read`, `write`), `expires`, `client_id`, all strings, all required; description
    "Present only under an API key: the key's id, scope, expiry (\"\" for never) and client
    (\"\" for a key minted by hand)."); `required` unchanged.
  - Regen.
  - `docs/readiness/agent-clients.md` AC-12: verdict `met`; evidence "`pb_hooks/api_keys.pb.js`
    answers 404 for an unmatched route or a missing collection under a key; `tests/test_api_keys.ts`
    cases `key_unknown_path_404`, `key_unknown_collection_404`, `key_closed_route_403`"; gap
    "none"; front-matter `updated:` the build date.
- **Tests** (`tests/test_api_keys.ts`, port unchanged 8146; write the AC-12 cases first and watch
  them fail against the unchanged hook):
  - `key_unknown_path_404`: read key, `GET /api/tracker/nope`: 404, `data` `{}`.
  - `key_unknown_path_post_404`: write key, `POST /api/tracker/nope` body `{}`: 404.
  - `key_unknown_collection_404`: read key, `GET /api/collections/nope/records`: 404.
  - `key_unknown_collection_other_routes_404`: read key, `GET /api/collections/nope`: 404; write
    key, `POST /api/collections/nope/auth-with-password` body `{}`: 404.
  - `key_known_collection_meta_403`: read key, `GET /api/collections/tasks`: 403 `api_key_path`.
  - `key_closed_route_403`: read key, `GET /api/tracker/admin/pending-users`: 403 `api_key_path`.
  - `key_system_collection_403`: read key, `GET /api/collections/_superusers/records`: 403
    `api_key_path`.
  - `bad_key_unknown_path_401`: `tmk_` + 40 `x`, `GET /api/tracker/nope`: 401 `api_key_invalid`.
  - `oauth_path_skips_key`: `Authorization: Bearer tmk_bogus`, `GET /oauth/x`: 404 (not 401).
  - `create_client_id_blanked`: user session creates a key with `client_id: "evil"`: 200,
    record's `client_id` `""` (read back with the superuser).
  - The "update rule" table (`tests/test_api_keys.ts:258-264`) gains rows `["client_id → x",
    { client_id: "x" }, true]` and `["refresh_hash → x", { refresh_hash: "x" }, false]` (the
    second a no-op 200, as for `key_hash`); each asserts the stored row unchanged.
  - `hidden_refresh_fields`: user session lists its keys: no `refresh_hash`, `refresh_expires`,
    `refresh_prev_hash` in any item.
  - The existing `refused` table (`tests/test_api_keys.ts:388-433`, checked by the loop through line 445) keeps 403 for every row.
- **Tests** (`tests/test_me_route.ts`, port unchanged 8177):
  - `me_key_read`: read key: 200; `key.id`, `key.scope`, `key.expires`, `key.client_id` equal
    `<id>`, `"read"`, `""`, `""`; other properties of `key` are not checked (later changes add
    them).
  - `me_key_expiry`: key created with `expires` one day ahead: `key.expires` equals the record's.
  - `me_session_no_key`: user token: no `key` property.
- **Gate:** `bun tests/test_api_keys.ts`, `bun tests/test_me_route.ts`, `make check-static`.

### Phase 2. Rate-limit exemption and the `/oauth/` limit

- **Goal:** a request carrying the MCP service's secret is exempt from every per-address rule, no
  public caller can obtain it, and `/oauth/` is limited per address (contract: Rate limits;
  spec: Rate limits key on the credential at the MCP service).
- **Files:**
  - create `pb_migrations/<slot>_rate_limits_internal_and_oauth.js`
  - create `pb_hooks/internal_caller.pb.js`
  - create `tests/test_internal_caller.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `.agents/rules/ports.md`
  - regen: none expected (`scripts/gen_openapi.ts` renders only the `/api/` rule); `make
    check-static` confirms
- **Steps:**
  - Migration (pattern of `v2:pb_migrations/1785189500_trusted_proxy_real_ip.js`): `s =
    app.settings()`; append `"192.0.2.254"` to `s.rateLimits.excludedIPs` unless present; append
    rule `{ label: "/oauth/", maxRequests: 30, duration: 60, audience: "" }` unless a rule has that
    label; `app.save(s)`. Down: no-op with the same comment as that file's down.
  - `pb_hooks/internal_caller.pb.js`: header line "Exempts the MCP service's calls, recognised by
    a shared secret, from the per-address rate limits."; then `use(new Middleware(fn, -1040,
    "tmInternalCaller"))` where `fn`: `const SENTINEL = "192.0.2.254"` with the one-line comment
    "Must equal the rateLimits.excludedIPs entry; tests/test_internal_caller.ts goes red if not.";
    `const h = e.request.header; const sent = h.get("X-TM-Internal"); h.del("X-TM-Internal");
    const secret = $os.getenv("MCP_INTERNAL_SECRET");` exempt when `secret && sent &&
    $security.equal(sent, secret)`: `h.set("X-Real-IP", SENTINEL)`; else when any value of
    `h.values("X-Real-IP")`, split on `,` and trimmed, equals `SENTINEL`: `h.del("X-Real-IP")`;
    `return e.next()`. (The `Middleware` constructor order is `(fn, priority, id)`; the spike saw
    the priority silently become 0 with the arguments swapped.)
  - `.agents/rules/ports.md`: insert ` · 8200 = test_internal_caller` in ascending port order, immediately before ` · 9700 = test_script_help` in the defaults list.
- **Tests** (`tests/test_internal_caller.ts`, port 8200; boot with `MCP_INTERNAL_SECRET=s3cret`
  in `process.env` before `roomkit.serve`; as superuser PATCH `/api/settings` `rateLimits.rules`
  to the current `rateLimits.rules` (read back first) plus `{label: "/api/health", maxRequests: 3, duration: 60, audience:
  ""}` and `{label: "/api/collections/users/records", maxRequests: 3, duration: 60, audience:
  ""}` (PocketBase keeps one bucket per rule label and address, room-proven in the spike); each
  case sending a real `X-Real-IP` uses a fresh value so buckets do not mix; the two forged cases
  fall back to the connection address (127.0.0.1) once the header is deleted, so they use the two
  different rule paths; write `exempt_with_secret` first and watch it fail with the hook absent):
  - `settings_migrated`: superuser `GET /api/settings`: `rateLimits.excludedIPs` contains
    `192.0.2.254`; a rule labelled `/oauth/` with 30/60.
  - `exempt_with_secret`: 6× `GET /api/health`, `X-TM-Internal: s3cret`, `X-Real-IP: 203.0.113.10`:
    all 200.
  - `counted_without_secret`: 6×, `X-Real-IP: 203.0.113.11`: `200 200 200 429 429 429`.
  - `wrong_secret_counted`: 6×, `X-TM-Internal: nope`, `X-Real-IP: 203.0.113.12`: three 200 then
    429.
  - `forged_sentinel_counted`: 6× `GET /api/health`, `X-Real-IP: 192.0.2.254`: three 200 then
    three 429.
  - `forged_sentinel_list_counted`: 6× `GET /api/collections/users/records` (no auth), `X-Real-IP:
    1.1.1.1, 192.0.2.254`: three answers that are not 429, then three 429.
  - `oauth_rule_counts`: 31× `GET /oauth/nothing`, `X-Real-IP: 203.0.113.13`: first 30 are 404,
    the 31st 429.
  - A second boot (stop the room by its handle, boot again on the same port and data directory)
    with `MCP_INTERNAL_SECRET` deleted from `process.env`, after the same settings PATCH:
    `unset_secret_counted`: 6× `GET /api/health` with `X-TM-Internal: s3cret`, `X-Real-IP:
    203.0.113.20`: three 200 then three 429.
- **Gate:** `bun tests/test_internal_caller.ts`, `make check-static`.

### Phase 3. Authorization server: metadata, codes, token and revocation

- **Goal:** the server publishes RFC 8414 metadata and exchanges and refreshes codes into keys
  and revokes grants (contract: Authorization Server Metadata, Token request, The minted key,
  Revocation request, API token and revocation errors; spec mcp-auth: Discovery documents, A
  grant mints an API key, Refresh issues a new key).
- **Files:**
  - create `pb_migrations/<slot>_oauth_codes.js`
  - create `pb_migrations/<slot2>_seed_app_docs.js` (`<slot2>` the next slot after `<slot>`)
  - modify `scripts/gen_app_docs_seed.ts`
  - create `pb_hooks/lib/oauth.js`
  - create `pb_hooks/oauth_server.pb.js`
  - modify `pb_hooks/lib/routes.js`
  - create `tests/test_oauth_token.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `.agents/rules/ports.md`
  - regen: as Phase 1, plus `bun scripts/gen_app_docs_seed.ts` (rewrites the new seed and
    `scripts/app_docs_seed.sha256`) and `bun scripts/gen_gitattributes.ts` (rewrites
    `.gitattributes`)
- **Steps:**
  - `<slot>_oauth_codes.js`: D13's collection; down deletes it.
  - Seed: `cp` the newest `pb_migrations/*_seed_app_docs.js` (Phase 1's) to
    `<slot2>_seed_app_docs.js`; set
    `DEFAULT_OUTPUT` in `scripts/gen_app_docs_seed.ts` to it; in the new file add the record `{
    "id": "oauthcodesdoc01", "slug": "collection:oauth_codes", "refName": "oauth_codes", "title":
    "oauth_codes — one-time codes of the sign-in an MCP client starts", "body": "A row per
    approved sign-in, written by the server when a person approves an app on the sign-in page
    and deleted when the app exchanges it, within ten minutes. Fields: code_hash (a fingerprint
    of the code, never the code), user, client_id, client_name, redirect_uri, code_challenge
    (PKCE S256), scope (read or write), expires. No client rule opens it: only the server reads
    or writes it." }`, and append to the `collection:api_keys` record's `body`: " A key minted by
    an app's sign-in carries that app in client_id; a refresh replaces its key value and moves
    expires forward, keeping its id. Revoking or deleting it ends the sign-in. client_id is \"\"
    for a key minted by hand."; then run the generator and `gen_gitattributes`.
  - `pb_hooks/lib/oauth.js` (pure functions plus the client table; `module.exports = { CLIENTS,
    issuer, mcp_resource, parse_form, parse_scope, scope_text, pkce_s256, redirect_matches,
    is_loopback, resource_ok, sign_flow, read_flow, with_query, resolve_client, token_error }`;
    Phase 4 adds `validate_request`, `render` and `issue_code` to the same export):
    - `CLIENTS = { cursor: { client_name: "Cursor", redirect_uris:
      ["https://www.cursor.com/agents/mcp/oauth/callback", "http://localhost:8787/callback"] } }`.
    - `issuer()`: `($os.getenv("PB_PUBLIC_URL") || "http://127.0.0.1:8090").replace(/\/+$/, "")`.
    - `mcp_resource()`: `MCP_PUBLIC_URL` stripped plus `/mcp`, or `""` when unset.
    - `resource_ok(raw)`: absent or `""` true; else lowercase the `scheme://host[:port]` part of
      `raw` and compare to `mcp_resource()` likewise lowercased, `false` when `mcp_resource()` is
      `""`.
    - `parse_form`, `parse_scope`, `scope_text(scope)` (`read` or `read write`), `pkce_s256`: D15.
    - `is_loopback(uri)`: `/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^#]*)?$/`.
      `redirect_matches(registered, requested)`: D14 step 3.
    - `with_query(uri, pairs)`: D14's redirect URL rule.
    - `sign_flow(app, stage, q, uid, otp)` and `read_flow(app, token)` (returns `{stage, q, uid,
      otp}` or `null`): D14's flow token.
    - `resolve_client(app, client_id)`: returns `{ ok: true, client: { client_id, client_name,
      redirect_uris, registered: boolean } }` or `{ ok: false, message }` with D14 step 2's
      messages; the document branch is a stub answering "could not be verified right now" until
      Phase 7.
    - `token_error(e, code, description)`: `e.json(400, { error: code, error_description:
      description })` with the two no-store headers.
  - `pb_hooks/oauth_server.pb.js`: header line "The OAuth authorization server that MCP clients
    sign in through (contract: hosted-mcp-endpoint)."; `onBootstrap((e) => { e.next();
    e.app.store().set("oauthFlowSecret", $security.randomString(40)); })` following
    `pb_hooks/mail.pb.js:15-19`'s order; routes `GET /.well-known/oauth-authorization-server`,
    `POST /oauth/token`, `POST /oauth/revoke` per D15, each requiring `lib/oauth.js` inside the
    handler. Code issue (used from Phase 4): not in this phase.
  - `pb_hooks/lib/routes.js`: the three D16 entries for this phase, and D16's new wording of the
    `internal:` comment line.
  - `.agents/rules/ports.md`: insert ` · 8201 = test_oauth_token` in ascending port order, immediately before ` · 9700 = test_script_help` in the defaults list.
- **Tests** (`tests/test_oauth_token.ts`, port 8201; env `MCP_PUBLIC_URL=http://mcp.test` before
  boot; the suite inserts codes as the superuser via `POST /api/collections/oauth_codes/records`
  with `code_hash` = sha256 hex of a known code and `code_challenge` = the RFC 7636 Appendix B
  challenge, user Alice (verified, approved), `client_id` `cursor`, `client_name` `Cursor`,
  `redirect_uri` `http://localhost:9999/callback`, `scope` `write`, `expires` now + 10 min;
  verifier = the Appendix B verifier. Right after boot the suite PATCHes `/api/settings` as the
  superuser, setting the `/oauth/` rule's `maxRequests` to 100000 (the rule itself is Phase 2's
  test; this suite sends far more than 30 requests a minute from one address). Fixtures are per
  case: a helper `code_row(overrides)`
  inserts a fresh code (a new random 40-character code each call) and returns it, and a helper
  `grant(scope = "write")` inserts a code and exchanges it, returning `{access, refresh,
  record_id}`. Every exchange-failure case uses its own `code_row`; every refresh and revoke case
  starts from its own `grant()`. Write `exchange_mints_key` first and watch it fail with no
  hook):
  - `as_metadata`: GET metadata: 200, body deep-equals the contract's JSON with the room URL as
    issuer.
  - `exchange_mints_key`: valid exchange: 200, `token_type` `Bearer`, `expires_in` 86400, `scope`
    `read write`, `access_token` matches `^tmk_[A-Za-z0-9]{40}$`, `refresh_token` `^tmr_...{40}$`,
    `Cache-Control: no-store`.
  - `minted_key_works`: the access token on `GET /api/tracker/me`: 200, `key.client_id` `cursor`,
    `key.scope` `write`, `key.expires` about now + 24 h (within 2 min).
  - `minted_key_listed`: Alice's session lists `api_keys`: among them a record with the minted
    key's id, `client_id` `cursor`, `name` `Cursor`.
  - `code_reused`: same exchange again: 400 `invalid_grant`.
  - `code_expired`: code with `expires` in the past: 400 `invalid_grant`.
  - `pkce_mismatch`: verifier of 43 `a`: 400 `invalid_grant`; the same code with the right
    verifier afterwards: 400 `invalid_grant` (a failed exchange burns the code).
  - `verifier_malformed`: verifier `short`: 400 `invalid_request`.
  - `redirect_mismatch`: `redirect_uri` `http://localhost:9998/callback`: 400 `invalid_grant`.
  - `client_mismatch`: `client_id` `https://example.com/c`: 400 `invalid_client`.
  - `missing_param`: no `code`: 400 `invalid_request`; `repeated_param`: `code` twice: 400
    `invalid_request`.
  - `bad_grant_type`: `grant_type=password`: 400 `unsupported_grant_type`.
  - `resource_other`: `resource=http://other/mcp`: 400 `invalid_target`; `resource_ok`:
    `resource=HTTP://MCP.TEST/mcp`: 200.
  - `refresh_rotates`: refresh: 200, new access and refresh tokens; old access token on `/me`:
    401; new one: 200; record id unchanged.
  - `refresh_replay_ends_grant`: from a fresh `grant()`, refresh once, then present the first
    refresh token again: 400 `invalid_grant`; the newest
    access token on `/me`: 401; the newest refresh token: 400 `invalid_grant`.
  - `refresh_scope_narrowed`: refresh of a `write` grant with `scope=read`: 400 `invalid_scope`;
    with `scope=write`: 200.
  - `refresh_other_client`: `client_id=other`: 400 `invalid_client`.
  - `refresh_after_revoke`: Alice PATCHes the record `revoked: true`; refresh: 400
    `invalid_grant`.
  - `refresh_after_delete`: Alice deletes the record; refresh: 400 `invalid_grant`.
  - `refresh_expired`: superuser sets `refresh_expires` in the past; refresh: 400 `invalid_grant`.
  - `revoke_access_token`: revoke a grant's `tmk_` with its `client_id`: 200, empty body; the key
    on `/me`: 401.
  - `revoke_refresh_token`: revoke a grant's `tmr_`: 200; a refresh with it: 400 `invalid_grant`.
  - `revoke_unknown`: `token=tmk_` + 40 `z`, `client_id=cursor`: 200; `token=garbage`,
    `client_id=cursor`: 200.
  - `revoke_other_client`: a `cursor` grant's access token revoked with
    `client_id=https://example.com/c`: 400 `invalid_client`, record unchanged.
  - `revoke_hand_minted`: a hand-minted key: 400 `unsupported_token_type`, key still works.
  - `revoke_missing_token`: 400 `invalid_request`.
  - `unknown_client`: `/oauth/token` code grant with `client_id=nope` (other parameters valid):
    400 `invalid_client`; `/oauth/revoke` `token=x&client_id=nope`: 400 `invalid_client`.
  - `oauth_codes_closed`: Alice's session `GET /api/collections/oauth_codes/records`: 403 (a
    `null` list rule admits superusers only).
- **Gate:** `bun tests/test_oauth_token.ts`, `make check-static`.

### Phase 4. Authorization page: sign-in and consent (pre-registered clients)

- **Goal:** a person signs in by password or emailed code, unverified or unapproved accounts are
  refused, and consent issues a code or `access_denied` (contract: Authorization request, API
  authorization endpoint errors; spec mcp-auth: Sign-in uses the tracker's own accounts, Consent
  chooses read or write; criterion AC-7 moves to partly).
- **Files:**
  - create `pb_hooks/views/oauth_authorize.html`
  - modify `pb_hooks/oauth_server.pb.js`
  - modify `pb_hooks/lib/oauth.js`
  - modify `pb_hooks/lib/routes.js`
  - create `tests/oauthkit.ts`
  - create `tests/test_oauth_authorize.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `.agents/rules/ports.md`
  - modify `docs/readiness/agent-clients.md`
- **Steps:**
  - `tests/oauthkit.ts` (shared by this suite, Phase 7's additions and later changes' suites;
    binds no port): header line "Drives the OAuth sign-in and consent page the way a browser
    does, for suites."; exports `PKCE = { verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" }`; `field(html: string, name:
    string): string | null` (a hidden input's value, entities `&#34; &#39; &amp; &lt; &gt; &#43;`
    decoded); `authorize_params(over: Record<string, string> = {}): Record<string, string>`
    (the base request below, overridden by `over`); `sign_in_and_approve(base: string, params:
    Record<string, string>, who: { email: string; password: string }, access: "read" | "write" =
    "write"): Promise<{ code: string; location: string }>` (GET the page, post `action=password`,
    post `action=approve` with `access`, follow nothing; throws an `Error` naming the stage when a
    step does not answer as expected; returns the `code` from the 302 `Location`);
    `exchange(base: string, code: string, params: Record<string, string>, verifier =
    PKCE.verifier): Promise<{ status: number; body: any }>` (POST `/oauth/token`).
  - Template: a complete HTML5 page (`<!doctype html>`, `lang="en"`, viewport meta, an inline
    `<style>` of plain readable layout), title "Sign in to Task Tracker". Data: `Stage` (`error`,
    `signin`, `code`, `consent`), `Message`, `ClientName`, `ClientHost`, `Registered`,
    `RedirectHost`, `Loopback`, `Access` (`read`/`write`), `Flow`, and `Params` (map of the eight
    parameters). Every form is `method="post"` to `/oauth/authorize` and carries hidden inputs
    `flow` and each of the eight parameters. Stage `signin`: two forms: email + password +
    button "Sign in" (`action=password`); email + button "Email me a code" (`action=send_code`).
    Stage `code`: field `code` (`inputmode="numeric"`, `autocomplete="one-time-code"`) + button
    "Continue" (`action=verify_code`). Stage `consent`: D14's texts, the radios, buttons Approve
    (`action=approve`) and Deny (`action=deny`). Stage `error`: heading "This sign-in cannot
    continue" and `Message`. Labels on every input.
  - `pb_hooks/lib/oauth.js`: add `validate_request(app, params)` returning `{ page: message }`,
    `{ redirect: error }` or `{ ok: client }` per D14 steps 1-5; `render(e, status, data)`
    (loads the template with `$template.loadFiles(`${__hooks}/views/oauth_authorize.html`)`, sets
    D14's four headers, `e.html(status, html)`); `issue_code(app, user, client, params, scope)`
    (purge expired codes, insert the row with a fresh `$security.randomString(40)` code, return
    the code).
  - `pb_hooks/oauth_server.pb.js`: `GET /oauth/authorize` and `POST /oauth/authorize` per D14
    (POST parses with `parse_form`; parameters from the form).
  - `pb_hooks/lib/routes.js`: the two D16 entries.
  - `.agents/rules/ports.md`: insert ` · 8202/8203 = test_oauth_authorize` in ascending port order, immediately before ` · 9700 = test_script_help` in the defaults list (8203 is the suite's
    SMTP sink; it stays in the suite's reserved 82xx band rather than the 25xx sink band, which
    belongs to other suites).
  - `docs/readiness/agent-clients.md` AC-7: verdict `partly`; evidence "the API serves RFC 8414
    metadata, a sign-in and consent page, token and revocation endpoints
    (`pb_hooks/oauth_server.pb.js`; `tests/test_oauth_token.ts`, `tests/test_oauth_authorize.ts`)";
    gap "no deployed MCP endpoint presents the challenge yet (AC-6)".
- **Tests** (`tests/test_oauth_authorize.ts`; room 8202, SMTP sink 8203 started from
  `scripts/smtp_sink.ts` as `tests/test_invitation_mail.ts:111-118` does and the room's SMTP
  pointed at it the way that suite does; (Phase 7 adds a metadata stub on 8204); env
  `MCP_PUBLIC_URL=http://mcp.test`; users: Alice verified+approved with a password, Una verified
  not approved, Vic unverified; right after boot the superuser PATCH of Phase 3 raises the
  `/oauth/` rule to 100000; helpers from `tests/oauthkit.ts`; base request
  (`authorize_params()`): `client_id=cursor`,
  `redirect_uri=http://localhost:5555/callback`, `response_type=code`, `code_challenge` =
  Appendix B challenge, `code_challenge_method=S256`, `scope=read write`, `state=xyz`; write
  `password_consent_approve` first and watch it fail):
  - `page_headers`: GET base: 200, `text/html`, CSP contains `frame-ancestors 'none'`,
    `X-Frame-Options: DENY`, `Cache-Control: no-store`, body contains "Sign in".
  - `unknown_client_page`: `client_id=nope`: 400 HTML containing "not known", no `Location`.
  - `missing_redirect_page`: no `redirect_uri`: 400 "incomplete".
  - `unregistered_redirect_page`: `redirect_uri=https://evil.example/cb`: 400 "has not
    registered", no `Location`.
  - `loopback_any_port`: `redirect_uri=http://localhost:61234/callback`: 200;
    `http://127.0.0.1:5555/callback` (host not registered for cursor): 400.
  - `bad_response_type_page`: `response_type=token`: 400.
  - `repeated_param_page`: `redirect_uri` given twice: 400 page "malformed", no `Location`.
  - `no_pkce_redirect`: no `code_challenge`: 302, `Location` has `error=invalid_request`,
    `state=xyz`, `iss=<room URL>`; `method_plain_redirect`: `code_challenge_method=plain`: same.
  - `bad_scope_redirect`: `scope=admin`: 302 `error=invalid_scope`.
  - `bad_resource_redirect`: `resource=http://other/mcp`: 302 `error=invalid_target`.
  - `password_consent_approve`: sign in Alice by password; consent page names "Cursor" and
    "localhost" and the loopback warning, `write` preselected; approve with `access=write`: 302 to
    `http://localhost:5555/callback?code=...&state=xyz&iss=...`; exchanging the code at
    `/oauth/token` with the Appendix B verifier: 200, `scope` `read write`.
  - `consent_read_only`: approve with `access=read`: exchange gives `scope` `read`, minted key's
    `/me` `key.scope` `read`.
  - `scope_read_preselected`: request `scope=read`: consent's `read` radio is `checked`.
  - `deny`: approve form with `action=deny`: 302 `error=access_denied&state=xyz&iss=...`.
  - `wrong_password`: 200 sign-in page with "do not match"; no code issued (superuser lists
    `oauth_codes`: none for Alice).
  - `unknown_email_password`: same message.
  - `unapproved_refused`: Una by password: "waiting for approval", and no consent stage.
  - `unverified_refused`: Vic by password: "confirm your email address first".
  - `code_sign_in`: `send_code` for Alice: the sink receives one mail to Alice whose body has an
    8-digit code; `verify_code` with it: consent page.
  - `code_wrong_then_lockout`: five wrong codes: each "wrong or has expired"; the right code on a
    sixth try: still refused (the OTP was deleted).
  - `code_unknown_email`: `send_code` for `nobody@example.com`: code page with "If that address
    belongs"; no mail in the sink; any code: refused.
  - `code_unapproved`: Una by code: "waiting for approval" after a correct code.
  - `flow_tampered`: approve with the `flow` of another request's consent page, or with `state`
    changed: sign-in page with "Start again"; no redirect.
  - `flow_wrong_stage`: post `action=approve` with a `signin`-stage token: sign-in page "Start
    again".
  - `superuser_cannot_sign_in`: the superuser's email and password: "do not match".
  - `expired_codes_purged`: insert an expired code row as superuser; approve a new consent: the
    expired row is gone.
- **Gate:** `bun tests/test_oauth_authorize.ts`, `bun tests/test_oauth_token.ts`,
  `make check-static`.

### Phase 5. `tm mcp` on SDK v2: structured tool errors and scope-filtered tools

- **Goal:** both MCP surfaces share one v2 catalog module; a failure carries status and code;
  a read key lists read tools; an unknown tool is `-32602` (contract: tools/list, tools/call,
  Compatibility `tm mcp`; criterion AC-13 to met).
- **Files:**
  - modify `clients/tm/package.json`
  - modify `bun.lock`
  - modify `clients/tm/src/mcp.ts`
  - modify `clients/tm/src/api.ts`
  - modify `clients/tm/README.md`
  - modify `tests/test_tm_mcp.ts`
  - modify `docs/readiness/agent-clients.md`
- **Steps:**
  - `clients/tm/package.json` `dependencies`: replace `"@modelcontextprotocol/sdk": "1.32.2"`
    with `"@modelcontextprotocol/server": "2.4.0"`; run `bun install` (rewrites `bun.lock`).
  - `clients/tm/src/api.ts`: D11's `Config.headers` and `request()` header merge.
  - `clients/tm/src/mcp.ts`: D11. Imports: `Server`, `ProtocolError`, `ProtocolErrorCode` from
    `@modelcontextprotocol/server`; `serveStdio` from `@modelcontextprotocol/server/stdio`;
    `AjvJsonSchemaValidator` from `@modelcontextprotocol/server/validators/ajv`. `make_server`
    builds `new Server({ name: "tm", version: VERSION }, { capabilities: { tools: {} },
    cacheHints: <D2> })` with `setRequestHandler("tools/list", async () => ({ tools:
    tools_for(await scope_of()) }))` and `setRequestHandler("tools/call", (req) => call(cfg,
    req.params.name, req.params.arguments ?? {}))`, with the two `as any` casts of D11. `serve(cfg)` becomes exactly:

    ```ts
    export async function serve(cfg: Config): Promise<void> {
      const handle = serveStdio(() => make_server(cfg, scope_from_me(cfg)));
      await new Promise<void>((resolve) => process.stdin.once("end", resolve));
      await handle.close();
    }
    ```

    where `scope_from_me` is D11's stdio rule. `serveStdio` is not awaited for completion (it
    returns a handle at once); the promise on stdin's `end` is what keeps `serve` from returning
    before the host closes the pipe, since `tm.ts` calls `process.exit` when `main()` resolves.
    The hosted service has no such shape: `main.ts` starts `Bun.serve` listeners and never calls
    `process.exit` after them, so it must not gain one.
  - `clients/tm/README.md` "As an MCP server": state that a read key lists only the read tools
    (those marked read-only), and that a failed call's text is the JSON object `{"error": {"status",
    "code", "message", "fields"}}`, also in `structuredContent`.
  - `docs/readiness/agent-clients.md` AC-13: verdict `met`; evidence "`clients/tm/src/mcp.ts`
    `error_result`; `tests/test_tm_mcp.ts` cases `edit_read_key_structured`, `show_missing_404`";
    gap "none".
- **Tests** (`tests/test_tm_mcp.ts`, port 8194; the suite's client stays
  `@modelcontextprotocol/sdk` 1.32.2 `StdioClientTransport`; write `edit_read_key_structured`
  first and watch it fail against the unchanged module):
  - `list_read_key`: read key: tool names equal `TOOLS.filter((t) =>
    t.annotations.readOnlyHint === true).map((t) => t.name)` (imported from
    `clients/tm/src/mcp.ts`; never a hard-coded list, since later changes add read tools), and
    the list is not empty.
  - `list_write_key`: write key: names equal every `TOOLS` name, in catalog order.
  - `edit_read_key_structured`: read key `tm_edit` an existing item: `isError` true,
    `structuredContent.error` deep-equals `{status: 403, code: "api_key_scope", message: "This
    API key is read-only.", fields: {api_key: {code: "api_key_scope", message: "This API key is
    read-only."}}}`; the text block parses to the same object.
  - `show_missing_404`: `tm_show` id `nope0000000000x`: `status` 404, `code` `not_found`.
  - `bad_arguments`: `tm_show` with `{}`: `status` null, `code` `invalid_arguments`.
  - `usage_refusal`: `tm_edit` with only `id`: `code` `invalid_arguments`, message "edit needs a
    title or a field to set".
  - `code_mapping`: the suite imports `error_result` from `clients/tm/src/mcp.ts` and checks
    `structuredContent.error.code` for: `(null, "m")` `invalid_arguments`; `(0, "m")`
    `unreachable`; `(400, "m", {title: {code: "validation_required", message: "x"}})`
    `validation_required`; `(400, "m", {a: {code: "x", message: ""}, b: {code: "y", message:
    ""}})` `validation_failed`; `(200, "m")` `bad_response`; 400 `invalid_request`; 401
    `unauthorized`; 403 `forbidden`; 404 `not_found`; 409 `conflict`; 429 `rate_limited`; 418
    `request_failed`; 502 `server_error`; and `fields` `{}` when `data` is omitted.
  - `unknown_tool`: `tools/call` `nope`: the client raises a JSON-RPC error with code `-32602`.
  - `unreachable`: a second client with `TM_URL=http://127.0.0.1:1`: `tm_list` gives `status` 0,
    `code` `unreachable`.
  - `stdio_serves_until_eof`: spawn `bun clients/tm/tm.ts mcp` directly (not through the SDK
    client), write an `initialize` request and, after 1 s, a `tools/list` request to its stdin:
    both get a reply on stdout; then close stdin: the process exits 0 within 5 s. Watch it fail
    with `serve` written as `await serveStdio(...)` (no reply, exit 0 at once).
  - `server_info`: `initialize` result `serverInfo` `{name: "tm", version: <the "version" of
    clients/tm/package.json, read by the suite>}`.
  - The suite's existing cases keep passing (success shape unchanged).
- **Gate:** `bun tests/test_tm_mcp.ts`, `bun tests/test_tm_cli.ts`, `make check-static`.

### Phase 6. The MCP service

- **Goal:** the hosted endpoint serves the catalog over Streamable HTTP with challenge, Origin
  check, scope gate, rate limits and 404s (contract: MCP service routes, Protocol revisions,
  Protected Resource Metadata, The 401 challenge, MCP service errors, Rate limits; specs
  hosted-mcp; criterion AC-6 to partly).
- **Files:**
  - create `services/mcp/main.ts`
  - create `services/mcp/src/app.ts`
  - create `services/mcp/src/limits.ts`
  - modify `tsconfig.json`
  - modify `package.json`
  - create `tests/test_mcp_service.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `.agents/rules/ports.md`
  - modify `docs/readiness/agent-clients.md`
- **Steps:**
  - `services/mcp/src/limits.ts`: D8.
  - `services/mcp/src/app.ts`: `export type Env = { pb_internal_url: string; pb_public_url:
    string; mcp_public_url: string; internal_secret: string; allowed_origins: string[] }`, `export function load_env(env =
    process.env): Env` (D10), `export function make_app(env: Env): { fetch(req: Request, ip:
    string): Promise<Response> }` implementing D9 with the SDK wiring of the spike server
    (`createMcpHandler(factory, { legacy: "reject", responseMode: "json" })`, `isLegacyRequest`,
    the legacy transport), where `factory = () => make_server(cfg, async () => scope)` from
    `../../../clients/tm/src/mcp.ts`. One file-header line: "The hosted MCP endpoint's public
    request pipeline (contract: hosted-mcp-endpoint).".
  - `services/mcp/main.ts`: header "Entry point of the hosted MCP service: the public listener
    and the private one."; `load_env` in `try`, on error `console.error(err.message);
    process.exit(1)`; `Bun.serve({ hostname: process.env.MCP_HOST || "::", port:
    Number(process.env.PORT || 8080), fetch: (req, server) => app.fetch(req, client_ip(req,
    server)) })` with D8's address rule; the private listener (same `hostname`, port
    `Number(process.env.MCP_INTERNAL_PORT || 8081)`) answers 404 to everything in this phase (Phase 7 fills it); log one line per listener: "listening on <host>:<port>".
  - `tsconfig.json` `include`: add `"services/**/*.ts"`. `package.json` `format:check` and
    `format`: add `"services/**/*.ts"` after `"scripts/**/*.ts"`. Run `bun run format`.
  - `.agents/rules/ports.md`: insert ` · 8205 = test_mcp_service · 8206/8207 = test_mcp_service` (the port gate's entry
    pattern takes at most two ports per entry) in ascending port order, immediately before ` · 9700 = test_script_help` in the defaults list.
  - `docs/readiness/agent-clients.md` (front-matter `updated:` set to the build date) AC-6:
    verdict `partly`; the Evidence bullet keeps its text and gains as its last sentence "`services/mcp/` serves
    the catalog over Streamable HTTP (`tests/test_mcp_service.ts`)"; gap "not deployed"; AC-7's
    evidence gains the sentence "The MCP service answers 401 with a `WWW-Authenticate` challenge
    naming its Protected Resource Metadata (`services/mcp/src/app.ts`, case `no_credential_401`)." appended as its last sentence; no
    other AC-7 edit in this phase.
- **Tests** (`tests/test_mcp_service.ts`; room 8205 booted with `MCP_INTERNAL_SECRET=s3cret`;
  then `roomkit.require_free_port` on 8206 and 8207 and `Bun.spawn([process.execPath,
  "services/mcp/main.ts"], { cwd: REPO_ROOT, stdout: <log fd>, stderr: <log fd> })` writing to
  `mcp.log` in the suite's scratch (opened with `fs.openSync`, as `roomkit.serve` does; the
  `missing_env_exits` case reads that file) with env `MCP_HOST=127.0.0.1`, `PORT=8206 + PORT_OFFSET`,
  `MCP_INTERNAL_PORT=8207 + PORT_OFFSET`, `PB_INTERNAL_URL` and `PB_PUBLIC_URL` the room URL,
  `MCP_PUBLIC_URL=http://127.0.0.1:<8206 + PORT_OFFSET>`, `MCP_INTERNAL_SECRET=s3cret`, waiting until the
  PRM URL answers 200; Alice with a read key R and a write key W and a project; each 429 case
  uses its own `X-Real-IP`; write `tools_list_read_key` first and watch it fail with no service):
  - `missing_env_exits` (runs first, before the main spawn): a separate spawn with
    `PB_INTERNAL_URL` unset and stderr to its own file `mcp-missing-env.log` in scratch: exit code
    1, that file names `PB_INTERNAL_URL`.
  - `prm_doc` and `prm_root_doc`: both URLs: 200, body equals D10's document.
  - `no_credential_401`: POST `initialize`, no `Authorization`: 401, `WWW-Authenticate` equals
    `Bearer resource_metadata="<MCP>/.well-known/oauth-protected-resource/mcp", scope="read
    write"`, body `error.code` `unauthorized`.
  - `query_key_401`: `?api_key=<W>` and no header: same as above.
  - `bad_key_401`: `tmk_` + 40 `x`: 401 with `error="invalid_token"`.
  - `user_token_401`: Alice's PocketBase token as Bearer: 401 `invalid_token`.
  - `revoked_key_401`: one successful `tools/list` with a third key K; Alice's session PATCHes
    `/api/collections/api_keys/records/<K id>` `{revoked: true}`; the next call with K: 401.
  - `initialize_2025`: SDK 1.32.2 `StreamableHTTPClientTransport` with `requestInit.headers`
    `Authorization: Bearer W`: connects; no `Mcp-Session-Id` response header (raw fetch check);
    `serverInfo.name` `tm`.
  - `tools_list_read_key`: client with R: names equal the read-only filter of `TOOLS` (as in
    Phase 5's `list_read_key`).
  - `tools_list_write_key`: client with W: every `TOOLS` name, in catalog order.
  - `same_result_as_stdio`: `tm_show` of the item over this endpoint and over `tm mcp` (spawned
    as in `tests/test_tm_mcp.ts`) with W: identical `content`.
  - `create_as_key_user`: W calls `tm_create` with the project and title `via mcp`: success;
    the returned item's `author` equals Alice's user id (`pb_hooks/author.pb.js` stamps the
    caller).
  - "2026 headers and `_meta`" means: headers `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method:
    <method>`, `Mcp-Name: <tool>` on `tools/call`, plus `Accept` and `Content-Type` as always; body
    `params._meta` holding `"io.modelcontextprotocol/protocolVersion": "2026-07-28"`,
    `"io.modelcontextprotocol/clientInfo": {"name": "suite", "version": "0"}` and
    `"io.modelcontextprotocol/clientCapabilities": {}`.
  - `discover_2026`: raw POST `server/discover` with 2026 headers and `_meta`: 200 JSON,
    `result.supportedVersions` contains `2026-07-28`.
  - `tools_list_2026_cache`: raw 2026 `tools/list`: `ttlMs` 300000, `cacheScope` `private`.
  - `header_mismatch_2026`: 2026 `tools/list` without `Mcp-Method`: 400, error code `-32020`.
  - `read_key_write_tool_403`: R, 2025 `tools/call` `tm_create`: 403, `WWW-Authenticate` contains
    `error="insufficient_scope"` and `scope="read write"`.
  - `unknown_tool_32602`: W `tools/call` `nope`: JSON-RPC error `-32602`.
  - `tool_failure_structured`: W `tm_show` id `nope0000000000x`: `isError` true, `status` 404.
  - `get_delete_405`: GET and DELETE `/mcp`: 405, `Allow: POST`, empty body.
  - `batch_400`: W, body `[{...},{...}]`: 400, error code `-32600`.
  - `not_json_400`: W, `Content-Type: text/plain`: 400 `-32600`.
  - `stray_path_404`: W, `GET /api/tracker/me` on the service: 404 `not_found`.
  - `origin_refused`: W, `Origin: https://attacker.example`: 403 `origin_not_allowed`, no
    `Access-Control-Allow-Origin`.
  - `origin_allowed`: W, `Origin: https://claude.ai`: 200, `Access-Control-Allow-Origin:
    https://claude.ai`, `Access-Control-Expose-Headers: WWW-Authenticate, Retry-After`, `Vary:
    Origin`; and a no-credential POST with that `Origin`: 401 carrying the same three headers.
  - `no_origin_served`: W, no `Origin`: 200.
  - `anon_limit_429`: 31 POSTs without credential from `X-Real-IP: 198.51.100.1`: 30 × 401, then
    429 with `Retry-After` an integer 1-60.
  - `bad_key_limit_429`: 31 POSTs with `tmk_` + 40 `y` from `198.51.100.2`: 30 × 401, then 429.
  - `key_limit_per_key`: a fresh key L minted for this case only: 300 raw 2025-era `tools/list`
    POSTs with L from `198.51.100.3`: all 200; the 301st: 429 with `Retry-After`; then R from the
    same address: 200 (two agents, one address).
  - `flooded_address_valid_key`: 31 POSTs with `tmk_` + 40 `v` from `198.51.100.5` (the address
    is now over: the 31st answers 429); then a fresh valid key M from `198.51.100.5`: 200 (a
    valid key is counted by its key alone); a 32nd invented key from `198.51.100.5`: 429.
  - `pb_exempt_via_service`: superuser reads `GET /api/settings` `rateLimits.rules`, then PATCHes the room's `/api/` rule to 5 per 60; 10
    `tools/list` with a fresh key F over the service: all 200; 10 direct `GET
    /api/tracker/me` with F from `X-Real-IP: 198.51.100.4`: 429 by the 6th. Then PATCH `rateLimits.rules` back to the value read before
    the change.
  - `options_preflight`: OPTIONS `/mcp` with `Origin: https://claude.ai`: 204, `Allow: POST`,
    `Access-Control-Allow-Origin: https://claude.ai`, `Access-Control-Allow-Methods: POST`;
    without `Origin`: 204 and no `Access-Control-Allow-Origin`.
  - `accept_406`: W, `Accept: application/json` only: 406, error code `-32600`.
  - `prm_post_405`: POST the PRM URL: 405, `Allow: GET, HEAD`; `prm_head`: HEAD: 200, empty body.
  - `unsupported_2026_32022`: raw 2026 `tools/list` with `MCP-Protocol-Version: 2027-01-01` and
    the same `_meta` version: 400, error code `-32022`.
  - `initialized_202`: 2025 `notifications/initialized`: 202, no body.
  - `read_key_write_tool_403_2026`: R, 2026 `tools/call` `tm_create` with its headers: 403
    `insufficient_scope`.
  - The 500 path has no trigger without fault injection and is covered by reading the `catch`
    (bounded coverage, stated in the phase report).
  - `api_down_503` runs last (it stops the room): stop the room; W `tools/list`: 503 `unavailable`, `Retry-After: 5`.
- **Gate:** `bun tests/test_mcp_service.ts`, `bun tests/test_tm_mcp.ts`, `make check-static`.

### Phase 7. Metadata-document clients

- **Goal:** a `client_id` URL is fetched safely by the MCP service and cached by PocketBase, so
  Claude and Claude Code can sign in (contract: Client registration; spec mcp-auth: Client
  registration by metadata document).
- **Files:**
  - create `services/mcp/src/cimd.ts`
  - modify `services/mcp/main.ts`
  - modify `pb_hooks/lib/oauth.js`
  - create `tests/test_mcp_cimd.ts`
  - modify `tests/test_oauth_authorize.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `.agents/rules/ports.md`
- **Steps:**
  - `.agents/rules/ports.md`: insert ` · 8204 = test_oauth_authorize` immediately after
    ` · 8202/8203 = test_oauth_authorize` (two ports per entry at most, as in Phase 6).
  - `services/mcp/src/cimd.ts`: `export function check_client_id_url(s: string): string | null`,
    `export function is_public_address(ip: string): boolean`, `export function
    max_age(cache_control: string | null): number`, `export async function
    fetch_client_metadata(client_id: string, deps: { lookup: (host: string) =>
    Promise<string[]>; fetch: typeof fetch } = DEFAULT_DEPS): Promise<{ status: 200 | 422 | 503;
    body: object }>`, `export function internal_handler(env: Env): (req: Request) =>
    Promise<Response>` (D5 statuses; the secret compared with `crypto.timingSafeEqual` over equal-
    length buffers, unequal lengths refused). `DEFAULT_DEPS.lookup` is `node:dns/promises`
    `lookup(host, { all: true })` mapped to addresses.
  - `services/mcp/main.ts`: the private listener uses `internal_handler(env)` on
    `MCP_INTERNAL_PORT`.
  - `pb_hooks/lib/oauth.js` `resolve_client` document branch: cache read
    `$app.store().get("cimd:" + id)` and use it when `exp > Date.now()`; else when
    `MCP_INTERNAL_URL` or `MCP_INTERNAL_SECRET` is empty, "right now"; else `$http.send({ url:
    MCP_INTERNAL_URL stripped + "/internal/client-metadata", method: "POST", headers: {
    "X-TM-Internal": secret, "Content-Type": "application/json" }, body: JSON.stringify({
    client_id: id }), timeout: 8 })`; 200: store `{ client: res.json.client, exp: Date.now() +
    res.json.max_age * 1000 }` when `max_age > 0`, return it; 422: "could not be verified"; any
    other status or a thrown error: "right now".
- **Tests** (`tests/test_mcp_cimd.ts`, no port; fake `lookup` and `fetch`; write
  `refuses_private_address` first):
  - `url_rules`: `http://x/a`, `https://u@x/a`, `https://x`, `https://x/`, `https://x/a#f`,
    `https://x/a?q=1`, `https://x/a/../b`, `https://x/./a`, `https://x/a/%2E%2E/b`: each the
    reason; `https://x/a` and `https://x:8443/a`: null.
  - `internal_malformed`: correct secret, body `nope`: 422; body `{"client_id": 5}`: 422.
  - `refuses_private_address`: lookup gives `10.0.0.5`: 422, fetch never called; likewise
    `127.0.0.1`, `169.254.169.254`, `::1`, `fd12::1`, `::ffff:192.168.1.1`, `100.64.0.1`.
  - `mixed_addresses_refused`: lookup gives `93.184.215.14` and `10.0.0.1`: 422.
  - `pinned_fetch`: lookup `93.184.215.14`: fake fetch receives URL `https://93.184.215.14/a`,
    header `Host: x`, `tls.serverName` `x`, `redirect` `manual`.
  - `ipv6_bracketed`: lookup `2606:4700::1`: URL `https://[2606:4700::1]/a`.
  - `redirect_refused`: fake 302: 422 "redirects are not followed".
  - `server_error_transient`: fake 503: 503; fake throws: 503; lookup throws: 503.
  - `too_large`: `Content-Length: 6000`: 422; a 6000-byte streamed body with no length: 422.
  - `client_id_mismatch`, `no_redirect_uris`, `secret_client` (`client_secret` present),
    `jwt_auth_method` (`private_key_jwt`), `implicit_only` (`response_types: ["token"]`): 422 each.
  - `valid_document`: Claude's real document text (D3) as the body: 200, `client` equal to its
    three fields, `max_age` 300.
  - `max_age_rules`: `no-store` 0, `max-age=60` 60, `max-age=999999` 86400, none 300.
  - `internal_secret`: `internal_handler` without the header: 404; wrong secret: 404; GET: 404.
- **Tests** (`tests/test_oauth_authorize.ts` additions; a stub `Bun.serve` on 8204 stands in for
  the MCP service's private listener, answering by `client_id`, and the room boots with
  `MCP_INTERNAL_URL=http://127.0.0.1:<8204 + PORT_OFFSET>`, `MCP_INTERNAL_SECRET=s3cret`):
  - `cimd_claude_code`: `client_id=https://claude.ai/oauth/claude-code-client-metadata` (stub
    answers 200 with `{"client": {"client_id": <that URL>, "client_name": "Claude Code",
    "redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"]}, "max_age":
    300}`), `redirect_uri=http://localhost:7777/callback`:
    consent shows "Claude Code" and host "claude.ai"; approve; exchange: 200, minted key's
    `client_id` equals the URL.
  - `cimd_cached`: a second GET within the run: stub request count unchanged.
  - The stub answers by the posted `client_id`: `https://claude.ai/oauth/claude-code-client-metadata`
    200 (document below); `https://bad.example/meta` 422 `{"error": "client_id does not match the
    URL"}`; `https://flaky.example/meta` 503 `{"error": "host did not answer"}`; anything else 404.
    The suite calls `roomkit.require_free_port` on 8204 before starting it.
  - `cimd_invalid_page`: `client_id=https://bad.example/meta`: 400 page "could not be verified".
  - `cimd_unavailable_page`: `client_id=https://flaky.example/meta`: 400 page "right now"; then,
    with the stub stopped, `client_id=https://down.example/meta` (never fetched, so never
    cached): same page.
  - `cimd_redirect_not_listed`: `redirect_uri=https://claude.ai/other`: 400 page "has not
    registered".
  - `cimd_secret_sent`: the stub saw `X-TM-Internal: s3cret`.
- **Gate:** `bun tests/test_mcp_cimd.ts`, `bun tests/test_oauth_authorize.ts`,
  `bun tests/test_mcp_service.ts`, `make check-static`.

### Phase 8. Container, local stack and smoke probes

- **Goal:** the MCP service builds as an image beside PocketBase, runs with it in the local
  stack, and the production images pass smoke probes (contract: everything a client reaches
  without a key; AGENTS.md smoke law).
- **Files:**
  - create `services/mcp/Dockerfile`
  - modify `.dockerignore`
  - modify `Dockerfile`
  - modify `deploy/local/compose.yaml`
  - modify `tests/test_boot_refusals.ts`
  - modify `Makefile`
  - modify `e2e/smoke.ts`
  - modify `e2e/README.md`
- **Steps:**
  - `tests/test_boot_refusals.ts:376`: after `.replaceAll("0.0.0.0:", "127.0.0.1:")` add
    `.replaceAll("[::]:", "127.0.0.1:")`, so its §5 room still binds loopback only once the
    Dockerfile listens on `[::]`.
  - `Makefile` `local-up`: prefix the command with `MCP_PORT=$$(( 8089 + $${PB_PORT_OFFSET:-0}
    ))` beside the existing `PB_PORT=...`, and its `##` help text becomes "build and run the
    production images on 127.0.0.1:8090+PB_PORT_OFFSET (API) and 8089+PB_PORT_OFFSET (MCP)
    (deploy/local)".
  - `services/mcp/Dockerfile`: line 1 "# The hosted MCP service: Bun plus the tm catalog; build
    context is the repository root."; `FROM oven/bun:1.4.3-alpine`; `WORKDIR /app`; `COPY
    package.json bun.lock ./`; `COPY clients/tm/package.json clients/tm/package.json`; `RUN bun
    install --frozen-lockfile` (not `--production`: the tm-distribution change reads
    `clients/tm/package.json` at run time and its design assumes a full install); `COPY clients/tm/src clients/tm/src`; `COPY
    services/mcp services/mcp`; `EXPOSE 8080`; `HEALTHCHECK --interval=30s --timeout=3s
    --start-period=5s --retries=3 CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+
    '/.well-known/oauth-protected-resource').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`;
    `USER bun`; `CMD ["bun", "services/mcp/main.ts"]`.
  - `.dockerignore`: keep `*`, `!pb_migrations`, `!pb_hooks`; add `!package.json`, `!bun.lock`,
    `!clients/tm/package.json`, `!clients/tm/src`, `!services/mcp`; first comment line becomes
    "# One allowlist for both images built from the repository root (Dockerfile, services/mcp/Dockerfile).".
  - `Dockerfile`: `--http=0.0.0.0:${PORT:-8080}` becomes `--http=[::]:${PORT:-8080}` (a Railway
    environment created before 2025-10-16 resolves `*.railway.internal` to IPv6 only; Go listens
    dual-stack on `[::]`; `pb_hooks/mail.pb.js:101` already maps `[::]:` to `[::1]:`).
  - `deploy/local/compose.yaml`: `pocketbase` gains `environment`: `PB_PUBLIC_URL:
    http://127.0.0.1:${PB_PORT:-8090}`, `MCP_PUBLIC_URL: http://127.0.0.1:${MCP_PORT:-8089}`,
    `MCP_INTERNAL_URL: http://mcp:8081`, `MCP_INTERNAL_SECRET: local-only-not-a-secret`; new
    service `mcp`: `build: { context: ../.., dockerfile: services/mcp/Dockerfile }`, `platform:
    linux/amd64`, `ports: ["127.0.0.1:${MCP_PORT:-8089}:8080"]`, `environment`:
    `PB_INTERNAL_URL: http://pocketbase:8080`, the same `PB_PUBLIC_URL`, `MCP_PUBLIC_URL`,
    `MCP_INTERNAL_SECRET`; `depends_on: [pocketbase]`. Header comment: "The production images
    (Dockerfile, services/mcp/Dockerfile) on local ports; pb_data persists in a named volume.".
  - `e2e/smoke.ts`: run compose with `MCP_PORT=0` beside `PB_PORT=0`; resolve the MCP port with
    `compose port mcp 8080`; wait until the PRM URL answers 200; add probes, inserted in `PROBES`
    before `probe_signup_rate_limit` (which must stay last): `probe_mcp_challenge` (POST `/mcp`
    no credential: 401; `WWW-Authenticate` starts with `Bearer resource_metadata="` and ends with
    `/.well-known/oauth-protected-resource/mcp", scope="read write"`, since under `MCP_PORT=0`
    the configured public URL carries port 0, not the bound one), `probe_mcp_metadata` (PRM
    `authorization_servers[0]` equals the AS metadata `issuer`; AS metadata lists `S256` and
    `none`), `probe_mcp_refusals` (GET `/mcp` 405; `GET /nope` 404; `Origin:
    https://attacker.example` 403), `probe_oauth_refusals` (`/oauth/authorize?client_id=nope&
    redirect_uri=x` 400 HTML; `/oauth/token` `grant_type=password` 400 `unsupported_grant_type`;
    `/oauth/revoke` `token=x&client_id=cursor` 200; `token=x&client_id=y` 400 `invalid_client`), `probe_mcp_anon_limit` (31 unauthenticated POSTs with
    `X-Real-IP: 198.51.100.77`, an address no other probe uses: the 31st is 429 with
    `Retry-After`). A key cannot be minted against the production image
    (its superuser requires MFA), so the keyed paths stay battery-only; `e2e/README.md` lists the
    new probes and says so.
- **Tests:** the smoke probes above; watch `probe_mcp_challenge` fail before the compose service
  exists; `bun tests/test_boot_refusals.ts` passes.
- **Gate:** `bun tests/test_boot_refusals.ts`, `make check-static`, `make smoke`.

### Phase 9. Railway topology and deploy docs

- **Goal:** the repository describes the two-service topology the runbook creates (deploy law:
  the topology is code).
- **Files:**
  - modify `deploy/railway/railway.ts`
  - modify `deploy/README.md`
  - modify `.agents/rules/deploy.md`
- **Steps:**
  - `deploy/railway/railway.ts`: add `const mcp = service("mcp", { source:
    github("hsb3/task-manager-backend", { checkSuites: true }), build: { builder: "DOCKERFILE",
    dockerfilePath: "services/mcp/Dockerfile", watchPatterns: ["services/mcp/**",
    "clients/tm/src/**", "clients/tm/package.json", "package.json", "bun.lock"] }, healthcheck:
    "/.well-known/oauth-protected-resource", healthcheckTimeout: 60, replicas: {
    "us-east4-eqdc4a": 1 }, domains: [<"mcp." + the pocketbase service's `domains[0]` literal, written out as one string>], env: {
    MCP_INTERNAL_SECRET: preserve(), MCP_PUBLIC_URL: preserve(), PB_INTERNAL_URL: preserve(),
    PB_PUBLIC_URL: preserve() } })`; add `MCP_INTERNAL_SECRET`, `MCP_INTERNAL_URL`,
    `MCP_PUBLIC_URL` as `preserve()` to `pocketbase`'s `env`; add `mcp` to `resources`.
  - `deploy/README.md`: a section "The MCP service" (what it is, its variables from D10, that
    it deploys on the watch patterns above, that it is created by the runbook in
    `openspec/changes/hosted-mcp-endpoint/design.md` Phase 10). `.agents/rules/deploy.md`
    Topology: "Two Railway services: `pocketbase` (API + `/_/` dashboard) and `mcp` (the hosted
    MCP endpoint, `services/mcp/`), in one standing environment, ...". `deploy/README.md` also
    names `make local-up`'s MCP port, 8089 + `PB_PORT_OFFSET`, and says the IaC entry for `mcp`
    records what the runbook creates by CLI, so `railway config plan` proposes no change to it.
- **Tests:** none (configuration and prose); `bun run typecheck` covers `railway.ts`.
- **Gate:** `make check-static`, then `make check` (the last code phase runs the whole battery).

### Phase 10. Runbook: create the service and the domain (root-run, outward)

Run by root on a clean checkout of `main` with Phases 1-9 merged and CI green. Each step's
command is exact; a step that cannot run as written stops the runbook and is reported.

1. `railway link --project task-manager --environment production --service pocketbase`
2. `railway variables --service pocketbase --kv | grep -E '^(PORT|PB_PUBLIC_URL)='` and record
   both values; `<API host>` below is the pocketbase service's `domains[0]` in
   `deploy/railway/railway.ts`, and the host of `PB_PUBLIC_URL` must equal it (stop and report
   if not); if `PORT` is absent, run `railway variable set --service pocketbase PORT=8080
   --skip-deploys` (the image's own default, so the listener does not move).
3. `S=$(openssl rand -hex 32)` (never echoed or stored outside Railway).
4. `railway add --service mcp --repo hsb3/task-manager-backend --branch main --variables
   "MCP_INTERNAL_SECRET=$S" --variables 'PB_PUBLIC_URL=${{pocketbase.PB_PUBLIC_URL}}' --variables
   'PB_INTERNAL_URL=http://${{pocketbase.RAILWAY_PRIVATE_DOMAIN}}:${{pocketbase.PORT}}'
   --variables "MCP_PUBLIC_URL=https://mcp.<API host from step 2>"`
5. `railway environment edit --service-config mcp build.builder DOCKERFILE --service-config mcp
   build.dockerfilePath services/mcp/Dockerfile --service-config mcp deploy.healthcheckPath
   /.well-known/oauth-protected-resource` (no `--stage`, so the edit commits at once); set `build.watchPatterns` to Phase 9's list in the dashboard (Settings,
   Build, Watch Paths) if the CLI refuses an array value.
6. `railway variable set --service pocketbase "MCP_INTERNAL_SECRET=$S"
   'MCP_INTERNAL_URL=http://${{mcp.RAILWAY_PRIVATE_DOMAIN}}:8081'
   "MCP_PUBLIC_URL=https://mcp.<API host>"` (this redeploys pocketbase).
7. `railway domain "mcp.<API host>" --service mcp`; give the printed CNAME and TXT records to
   the owner to add at the DNS provider; repeat `railway domain status "mcp.<API host>" --service mcp` until the
   certificate is issued.
8. Verify (read-only, no key): `curl -s https://mcp.<API host>/.well-known/oauth-protected-resource/mcp`
   (200, `authorization_servers[0]` equals `PB_PUBLIC_URL`); `curl -s -o /dev/null -w
   '%{http_code}' -X POST https://mcp.<API host>/mcp` (401); `curl -s
   <PB_PUBLIC_URL>/.well-known/oauth-authorization-server` (200, `issuer` equals
   `PB_PUBLIC_URL`).
9. Verify the private network: `railway ssh --service mcp -- bun -e "fetch(process.env.PB_INTERNAL_URL+'/api/health').then(r=>console.log(r.status))"` prints 200.
10. Verify a sign-in end to end with Claude Code from the owner's machine: `claude mcp add
    --transport http tracker https://mcp.<API host>/mcp`, run `/mcp` in Claude Code, complete
    the browser sign-in, and list tools (expect the write set). Then revoke the minted key in
    the key list and confirm the next call asks to sign in again.
11. `railway config plan --source-tree "$(git rev-parse HEAD:)" --out /tmp/plan.json` and
    confirm the plan proposes no change to `mcp` (read only; never `apply`, per
    `deploy/railway/README.md`).
12. Edit `docs/readiness/agent-clients.md`: AC-6 and AC-7 `met`, evidence "steps 8-10 of the
    hosted-mcp-endpoint runbook on <date>"; commit through a PR.

## Risks

- **R1. Railway listens and the private network.** `[::]` on PocketBase and `::` on the MCP
  service are proven locally by `make smoke` (Docker) only. Caught by Phase 10 steps 8 and 9
  (healthcheck and private fetch). Fallback: set `MCP_HOST=0.0.0.0` on `mcp` and revert the
  `Dockerfile` `--http` change in a follow-up PR if a listener fails.
- **R2. The `oven/bun:1.4.3-alpine` base image.** The tag exists on Docker Hub (amd64 and arm64,
  checked 2026-11-10); a removed tag is caught by `make smoke`'s build, fallback `FROM
  oven/bun:1.4.3` (Debian), same remaining lines.
- **R3. CLI dot-paths and array values** in runbook step 5, and the combined `--repo`,
  `--branch` and repeated `--variables` flags of step 4, are unverified (the CLI's help shows
  only `variables.*`, `deploy.startCommand` and `source.image`); the dashboard path is written
  out as the fallback.
- **R4. Claude on the web: protocol revision and `Origin`** are unverified. A missing `Origin` is
  served and `https://claude.ai` is listed, and both protocol legs are served, so either answer
  works; caught by connecting from claude.ai after Phase 10.
- **R5. One `/me` call per MCP request** adds API load (D7). Measured by `key_limit_per_key`'s
  duration in Phase 6; fallback, if a request takes over 100 ms on average there: a slimmer
  credential route is a contract change for a later decision, not taken here.
- **R6. Shared Claude egress on `/oauth/`.** All Claude users' token exchanges arrive from
  160.79.104.0/21 and share PocketBase's 30-per-minute `/oauth/` bucket per address. At this
  deployment's scale that is ample; watched through PocketBase's logs of 429 on `/oauth/token`.
- **R7. Replay detection keeps one generation.** A refresh token two or more rotations old is
  "unknown" (`invalid_grant`) without ending the grant; the common theft case (the attacker and
  the client both use the token that was current) is caught.
- **R8. Unbounded metadata cache.** Each distinct valid metadata document adds one small
  `$app.store()` entry until restart; a document must be fetched and valid to be stored.
- **R9. The internal secret.** Its leak grants only exemption from per-address limits and the
  metadata fetcher, never authentication; rotate by setting a new value on both services.
- **R11. Refused-key floods reach the API.** Step 5 of D9 calls `/me` for every `tmk_` value so
  that no valid key is refused for its address; a flood of invented keys costs the API one
  indexed lookup each, exempt from its limits. The MCP service still answers such a flood 429
  after 30 per minute per address. Watched through the service's log of 401s; the alternative
  (refusing before the call) would breach the contract's per-key rule.
- **R10. Pooled JSVM state.** Helpers live in `pb_hooks/lib/*.js` and are required inside
  handlers; shared state lives only in `$app.store()`. A violation shows as a hook that works on
  one request and fails on the next; the suites issue many requests per case family.

## Open Questions

None. Every choice the rulings and the contract left open is settled above.

# Proposal

## Why

An agent that runs no local process cannot use the tracker over MCP (AC-6), and no
authentication scheme is stated for a remote MCP endpoint (AC-7). The only MCP server is `tm
mcp`: `clients/tm/src/mcp.ts` connects `StdioServerTransport` alone, so it runs only as a child
process of a local agent host. This change comes first among the milestone's changes because the
credential a hosted client presents decides what key minting (AC-9) has to mint and what an
installed client (AC-8) has to hold.

What the server offers today (room probe, 2026-11-10, current migrations and hooks; tree paths
as cited):

- No MCP route. `POST` and `GET` on `/mcp`, `/api/mcp` and `/api/tracker/mcp` answer 404 without
  a credential and 403 `api_key_path` with a key (the key allowlist in `pb_hooks/api_keys.pb.js`
  refuses any unmatched path, AC-12).
- No OAuth discovery. `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` answer the
  same 404 / 403. PocketBase acts as an OAuth client of GitHub and Google for sign-in
  (`pb_hooks/oauth.pb.js`, decision:oauth-providers-from-env), never as an authorization server.
- A key travels in `Authorization`, bare or after `Bearer ` (`pb_hooks/api_keys.pb.js`,
  `check_key` in `clients/tm/src/api.ts`). A bad key answers 401 `api_key_invalid`; the 401
  carries no `WWW-Authenticate` header. A request with no credential answers 401, also with no `WWW-Authenticate`.
- A preflight from any origin is allowed (`Access-Control-Allow-Origin: *`).
- The server is headless: no hook renders HTML and there is no `pb_public/`, so nothing can show
  a sign-in or consent page.
- The container runs one process, PocketBase (`Dockerfile` `CMD`).
- A key's `scope` is `read` or `write`, and it acts as its user across every workspace that user
  reaches (`schema/api_keys.json`).

## Prior art

Each source was fetched on 2026-11-10; none of the vendor pages carries a date.

- **MCP specification, current revision 2026-07-28**
  (https://modelcontextprotocol.io/specification/versioning). AC-7's evidence cites 2025-06-18.
  Authorization stays optional for HTTP transports. When it is present, the server "MUST
  implement OAuth 2.0 Protected Resource Metadata (RFC9728)", answers an invalid or expired token
  with 401, and "MUST NOT accept or transit any other tokens". Clients try client registration in
  this order: pre-registered, Client ID Metadata Documents (CIMD), then Dynamic Client
  Registration (DCR). The 2026-07-28 revision states that "Dynamic Client Registration is
  deprecated"
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration).
  The Streamable HTTP transport "MUST validate the `Origin` header" and answers an invalid one
  with 403
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
- **Linear** (https://linear.app/docs/mcp), the app this one converges on. It serves
  `https://mcp.linear.app/mcp` over Streamable HTTP, with a read-only variant at
  `/mcp/readonly` that "only ever exposes read tools" and a deprecated SSE fallback. Interactive
  setup "uses OAuth 2.1 with dynamic client registration". The same endpoint also accepts "OAuth
  token and API keys directly in the `Authorization: Bearer <yourtoken>` header".
- **GitHub's remote MCP server** (https://github.com/github/github-mcp-server) documents one URL
  two ways: by OAuth, or with a personal access token in an `Authorization: Bearer` header.
- **Claude, web custom connectors**
  (https://claude.com/docs/connectors/custom/add-unlisted). OAuth is supported through Anthropic's
  published CIMD (the recommended option), through DCR, or with a pre-registered client ID. An API
  key goes under "No sign-in" plus request headers. That header option "is in beta and available
  to a limited set of organizations", and an OAuth connection cannot also set `Authorization` as
  a header.
- **ChatGPT** (https://developers.openai.com/apps-sdk/build/auth). It needs OAuth, with protected
  resource metadata at `/.well-known/oauth-protected-resource` and CIMD as "the preferred client
  registration method" (DCR "is still supported"). It cannot "present custom API keys". A tool
  can also be declared `noauth`.
- **Cursor** (https://cursor.com/docs/context/mcp). A remote server takes `url` plus `headers`
  (for example `Bearer ${env:TOKEN}`), or OAuth: authorization code with PKCE, through DCR or
  static client credentials.
- **Claude Code** (https://code.claude.com/docs/en/mcp). It takes `--transport http` with
  `--header "Authorization: Bearer ..."`, or OAuth through CIMD, DCR or a pre-registered client.

Taken together: Cursor and Claude Code accept a bearer API key today, and so does Claude on the
web where the beta header option is enabled. ChatGPT, and Claude on the web without that beta,
accept only OAuth or no authentication. Linear and GitHub serve both on one endpoint.

## What Changes

- The deployed server exposes an MCP endpoint over Streamable HTTP at a public URL. It serves
  the same tool catalog as `tm mcp`, so one agent sees the same tools however it connects.
- A request to that endpoint authenticates on every call with a credential that is stored only
  as a hash, scoped, expirable and revocable. It is refused with 401 and a `WWW-Authenticate`
  challenge when the credential is missing, invalid, revoked or expired. A refusal reads the same
  way under every client.
- The endpoint validates `Origin` as the transport requires.
- If the ruling below includes OAuth: the server publishes Protected Resource Metadata and names
  an authorization server that hosted clients can complete a sign-in against.
- The `tm mcp` stdio server keeps working unchanged for local agent hosts.

## How key scoping bears on it (AC-3, AC-4)

AC-3 (limit a key to a workspace or project) and AC-4 (deny a write key the destructive and
ownership routes) are missing today. This change does not move them. Whatever credential the
endpoint accepts still has to carry those limits once they exist. If an OAuth grant produces its
own kind of token, the scoping has to be built twice and kept in step; if a grant produces a key
(or a record shaped like one), AC-3 and AC-4 land once and every path inherits them. The ruling
on the credential model therefore fixes where AC-3 and AC-4 are built. Linear's `/mcp/readonly`
shows a URL-level limit that needs no change to the credential, and it covers only the read/write
split that `scope` already gives.

## Capabilities

- `hosted-mcp`: the remote MCP endpoint, its transport, its tool catalog, and its refusals.
- `mcp-auth`: how a remote MCP client obtains and presents a credential, and how that credential
  is discovered, checked and revoked.

## Open Questions

1. **Which hosted clients the milestone must serve.** Claude Code and Cursor work with a bearer
   key. Claude on the web works with one only under the beta header option. ChatGPT needs OAuth.
   This list decides whether OAuth is in scope at all.
2. **Credential scheme on the endpoint.** Options: the existing `tmk_` key as a bearer only; OAuth
   2.1 only; or both on one endpoint, as Linear and GitHub do. A key alongside OAuth has to be
   squared with the specification's "MUST NOT accept or transit any other tokens", which reads as
   a ban on tokens issued for another resource rather than on a key this server issues for
   itself. A decision record has to state that reading.
3. **Where the authorization server lives, if OAuth is in.** PocketBase is not one, and the
   server renders no page for sign-in or consent. Options: build one into this server, including
   a minimal sign-in and consent page; run a separate service; or delegate to a hosted identity
   provider. Sign-in currently needs a verified, approved user (decision:signup-approval,
   decision:verified-login), and that has to survive whichever option is chosen.
4. **Client registration, if OAuth is in.** CIMD, which the specification prefers and Claude,
   ChatGPT and Claude Code support; DCR, which is deprecated but is the one Linear and Cursor use;
   or pre-registered clients only.
5. **Where the endpoint runs.** Options: a JSVM route inside PocketBase, which cannot load the MCP
   SDK, so the protocol would be hand-written; a second process or service in Bun that reuses
   `clients/tm/src/mcp.ts`'s catalog and calls the HTTP API with the caller's credential; or a
   second process in the same container. This decides whether one tool catalog serves stdio and
   HTTP, and whether deploys and rate limits (SH-6) see one service or two.
6. **What a credential obtained by OAuth is.** A minted `tmk_` key bound to the grant (it shows up
   in the key list, scoping lands once, and revoking it ends the grant), or a separate token kind.
   This also settles AC-3 and AC-4 above, and what AC-9's minting command lists and revokes.
7. **Read-only surface.** A separate read-only URL, as Linear does; the existing `read` scope
   alone; or both.
8. **Rate limiting under shared egress.** Hosted agents leaving through one provider's address
   share one budget (SH-6). The question is whether this endpoint is budgeted per credential
   instead of per address.

## Purpose

The remote MCP endpoint: a public URL over Streamable HTTP that serves the `tm` tool catalog to
an agent that runs no local process, with its refusals, rate limits and tool errors.

## ADDED Requirements

### Requirement: One public MCP endpoint over Streamable HTTP

The tracker SHALL serve an MCP endpoint at one public HTTPS URL, on its own service and domain
apart from the PocketBase API, over the Streamable HTTP transport without sessions, for the
protocol revisions the contract lists. It SHALL reach the tracker only through the PocketBase
API, presenting the caller's own credential.

#### Scenario: A hosted agent lists the tools

- **WHEN** a client POSTs a `tools/list` request to the endpoint with a valid credential
- **THEN** it receives the tool catalog as a single JSON response

#### Scenario: An older client starts with initialize

- **WHEN** a client of revision 2025-11-25 POSTs `initialize` with a valid credential
- **THEN** it receives an `initialize` result and no `Mcp-Session-Id` header
- **AND** its later requests are served without a session

#### Scenario: GET or DELETE on the endpoint

- **WHEN** a client sends GET or DELETE to the endpoint
- **THEN** the endpoint answers 405 Method Not Allowed

### Requirement: The hosted endpoint serves the same tools as tm mcp

The hosted endpoint and the `tm mcp` stdio server SHALL serve one tool catalog: the same tool
names, descriptions, input schemas and annotations, and the same result for a call the
credential's scope allows, made with the same credential.

#### Scenario: Same call, two transports

- **WHEN** an agent calls `tm_show` with the same id and key over stdio and over the hosted endpoint
- **THEN** both results carry the same content

### Requirement: Tools are listed by the credential's scope

`tools/list`, on the hosted endpoint and on `tm mcp`, SHALL return only the tools whose
`readOnlyHint` annotation is true when the credential is read-scoped, and every tool when it is
write-scoped. On the hosted endpoint, a `tools/call` naming a write tool under a read-scoped
credential SHALL be refused with 403 and an `insufficient_scope` challenge naming the scope that
would allow it.

#### Scenario: A read credential sees only read tools

- **WHEN** a read-scoped credential sends `tools/list`
- **THEN** the list holds `tm_list`, `tm_show` and `tm_search` and no tool that changes data

#### Scenario: A read credential calls a write tool

- **WHEN** a read-scoped credential calls `tm_create`
- **THEN** the endpoint answers 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` and the `write` scope named

### Requirement: Every request is authenticated

Every POST to the endpoint SHALL carry a credential in the `Authorization` header and be checked
before it is served. A missing, invalid, revoked or expired credential SHALL be refused with 401
and a `WWW-Authenticate: Bearer` challenge that names the Protected Resource Metadata URL in
`resource_metadata`. A credential in the query string SHALL never be read.

#### Scenario: No credential

- **WHEN** a client POSTs to the endpoint without an `Authorization` header
- **THEN** the endpoint answers 401 with a challenge carrying `resource_metadata` and `scope`

#### Scenario: A revoked key

- **WHEN** a client presents a key that was revoked since its last request
- **THEN** the endpoint answers 401 with `error="invalid_token"` in the challenge

#### Scenario: A key in the query string

- **WHEN** a client sends a valid key as a query parameter and no `Authorization` header
- **THEN** the endpoint answers 401 as for a missing credential

### Requirement: The endpoint validates Origin

The endpoint SHALL refuse with 403 any request whose `Origin` header is present and not on its
allowed list, and SHALL serve a request that carries no `Origin` header.

#### Scenario: A web page on another site calls the endpoint

- **WHEN** a request arrives with `Origin: https://attacker.example`
- **THEN** the endpoint answers 403 and serves nothing

#### Scenario: A server-side client sends no Origin

- **WHEN** a request with a valid credential arrives with no `Origin` header
- **THEN** it is served

### Requirement: A tool failure carries the server's status and code

A tool call that fails SHALL return a result with `isError: true` whose `structuredContent`
holds the HTTP status the tracker answered, a machine-readable code, the message, and the
per-field errors, and whose text content is the same object serialized as JSON. This SHALL hold
for the hosted endpoint and for `tm mcp`.

#### Scenario: A read key edits an item over stdio

- **WHEN** an agent holding a read key calls `tm_edit` through `tm mcp`
- **THEN** the result has `isError: true` and `structuredContent.error` with `status` 403 and `code` `api_key_scope`

#### Scenario: An item that does not exist

- **WHEN** an agent calls `tm_show` with an id no item has
- **THEN** the result has `isError: true` and `structuredContent.error.status` 404

### Requirement: An unknown path under a key is not found, not forbidden

Under an API key, a request to a path that matches no route, or to a collection route naming a
collection that does not exist, SHALL answer 404, as it does under a user token; 403 `api_key_path` SHALL remain the answer for a route that exists and is closed to
keys. The MCP service SHALL answer 404 for any path other than its endpoint and its metadata
documents, whatever credential the request carries.

#### Scenario: A key asks the API for a route that does not exist

- **WHEN** a key holder sends `GET /api/tracker/nope` to the API
- **THEN** the API answers 404

#### Scenario: A key names a collection that does not exist

- **WHEN** a key holder sends `GET /api/collections/nope/records` to the API
- **THEN** the API answers 404

#### Scenario: A key asks for a route closed to keys

- **WHEN** a key holder sends `GET /api/tracker/admin/pending-users`
- **THEN** the API answers 403 with code `api_key_path`

#### Scenario: A stray path on the MCP service

- **WHEN** a client with a valid key sends `GET /api/tracker/me` to the MCP service
- **THEN** the MCP service answers 404

### Requirement: Rate limits key on the credential at the MCP service

The MCP service SHALL count requests per credential, and SHALL count requests that carry no
credential or a refused one per client address under a lower limit. A request over its limit
SHALL answer 429 with a `Retry-After` header. The PocketBase API SHALL not count the MCP
service's private-network calls against its per-address limit, and no public caller SHALL be
able to obtain that exemption.

#### Scenario: Two agents behind one egress address

- **WHEN** two hosted agents with different keys call the endpoint from one address
- **THEN** each is counted against its own key's budget

#### Scenario: A burst without a credential

- **WHEN** one address sends unauthenticated requests past the unauthenticated limit
- **THEN** further requests from it answer 429 with `Retry-After`

#### Scenario: A public caller claims the private address

- **WHEN** a request from the public internet carries a forwarding header naming the MCP service's private address
- **THEN** the API counts it against its per-address limit as any public request

## Purpose

How the tracker's API contract is versioned, released and deprecated, and where a client reads
which contract version a server or a `tm` client speaks.

## ADDED Requirements

### Requirement: Every API response names the contract version

The PocketBase server SHALL send an `Api-Version` header whose value is the contract version, a
semantic version `MAJOR.MINOR.PATCH`, on every HTTP response it gives: success, error, not found,
rate-limited, CORS preflight, realtime stream and dashboard alike. Each response SHALL also list
`Api-Version` in `Access-Control-Expose-Headers`, so a script on another origin can read it.

#### Scenario: Health check

- **WHEN** a client sends `GET /api/health`
- **THEN** the answer is 200 and carries `Api-Version` equal to `info.version` of the `openapi.json` the server was built with

#### Scenario: A path no route serves

- **WHEN** a client sends `GET /api/no-such-route`
- **THEN** the answer is 404 and carries the same `Api-Version`

#### Scenario: A refused API key

- **WHEN** a client sends a request with an unknown `tmk_` key
- **THEN** the answer is 401 `api_key_invalid` and carries the same `Api-Version`

#### Scenario: A browser on another origin

- **WHEN** a script on another origin sends `GET /api/health` with an `Origin` header
- **THEN** the answer carries `Access-Control-Expose-Headers` listing `Api-Version`

#### Scenario: A request names a version

- **WHEN** a client sends any request version header, such as `Api-Version: 0.0.1`
- **THEN** the server ignores it and answers as it would without it

### Requirement: The published contract carries its version

`openapi.json` `info.version` SHALL equal the contract version the server sends, and the MCP tool
catalog SHALL be published beside it as `mcp-tools.json`, generated from the same catalog the
`tm mcp` server and the hosted MCP endpoint serve.

#### Scenario: Reading the contract

- **WHEN** a reader opens `openapi.json` at a released commit
- **THEN** its `info.version` is the version that commit's server sends in `Api-Version`

### Requirement: The hosted MCP endpoint and the tm client name the contract version

Every HTTP response of the hosted MCP endpoint SHALL carry `Api-Version` with the contract
version its tool catalog was released under. `tm --version` SHALL print the client's own version
alone on its first line and `api <contract version>`, the version it was built against, on its
second.

#### Scenario: tm --version

- **WHEN** a person runs `tm --version`
- **THEN** it prints the client version on line 1 and `api <contract version>` on line 2, and exits 0

#### Scenario: A hosted MCP request

- **WHEN** a client POSTs a `tools/list` request to the hosted MCP endpoint
- **THEN** the HTTP response carries `Api-Version`

### Requirement: Within a major version no breaking change ships

From release 1.0.0 on, a breaking change SHALL ship only in a release whose major part is higher
than the previous release's, and only after the changed item was deprecated for at least 90
days. When a PocketBase upgrade forces the break, it SHALL still ship only as a major release,
with a changelog entry naming the PocketBase version.

#### Scenario: A field is removed after 1.0.0 without deprecation

- **WHEN** a commit removes a response field of a released operation that was never deprecated
- **THEN** cutting the release is refused and names the field

### Requirement: What counts as breaking

A breaking change SHALL be any of: removing or renaming an operation, a parameter, a request or
response field, an MCP tool or a tool input; adding a required parameter, request field or tool
input; making an optional one required; changing a type; removing an enum value; adding a
validation rule to an existing input; changing authentication or authorization requirements;
changing a status code, an error `code`, or a default (page size, sort order).

#### Scenario: A documented default changes

- **WHEN** a commit changes the `default` the contract documents for an input, such as the `role` of a member resolved by email from `member` to `viewer`
- **THEN** the change is classed as breaking

### Requirement: What is not breaking

Adding an operation, an optional input, a response field, an enum value, an MCP tool or an
error status SHALL NOT be breaking, and SHALL ship in a minor release. Changing a description,
summary, tag, tool annotation or error message text SHALL NOT be a contract change. Clients
SHALL ignore unknown response fields and unknown enum values.

#### Scenario: A field is added

- **WHEN** a commit adds an optional response field
- **THEN** it is released as a minor version

### Requirement: Before 1.0.0 the contract changes freely, with a changelog entry

While the major version is 0, any change, breaking or not, SHALL ship in a minor release with a
changelog section, and no deprecation period SHALL apply. Release 1.0.0 SHALL be cut before the
hosted MCP endpoint is opened to outside users, and the compatibility promise binds from it.

#### Scenario: A breaking change before 1.0.0

- **WHEN** the contract version is `0.4.0` and a commit removes an operation
- **THEN** the release is cut as `0.5.0` with the removal listed under Removed

### Requirement: A deprecation is announced in a minor release

Deprecating an operation, parameter, field or MCP tool SHALL ship in a minor release whose
changelog section lists it under Deprecated. From that release the item SHALL carry
`deprecated: true` in `openapi.json`, or, for an MCP tool, a description starting `Deprecated:`.

#### Scenario: A field is deprecated

- **WHEN** a field is marked deprecated and the release is cut
- **THEN** the release is a minor version and its changelog section lists the field under Deprecated

### Requirement: A deprecated operation says so on the wire

Every response of a deprecated operation SHALL carry `Deprecation` (RFC 9745) with the
deprecation date, `Sunset` (RFC 8594) with a date at least 90 days later, and `Link` with
`rel="deprecation"` naming the API changelog.

#### Scenario: Calling a deprecated route

- **WHEN** a client calls an operation deprecated in the release dated 2027-01-10
- **THEN** the answer carries `Deprecation: @1799539200` and a `Sunset` no earlier than 2027-04-10

### Requirement: A deprecated item works for 90 days

A deprecated item SHALL keep working for at least 90 days after the release that deprecated it,
and its removal SHALL ship in a major release dated no earlier than that.

#### Scenario: Removal before the window ends

- **WHEN** an operation deprecated in a release dated 2027-01-10 is removed and a major release is cut on 2027-03-01
- **THEN** cutting the release is refused, naming the operation and the earliest allowed date 2027-04-10

### Requirement: Every contract change is a release with a changelog section

Each structural change to the contract (operations, parameters, fields, types, required flags,
enum values, defaults, status codes, auth requirements, deprecation flags, MCP tool names and
inputs) SHALL be released in the same commit that makes it: the contract version rises, a
section for the new version is added to the API changelog, and the released contract snapshot is
replaced. A change to descriptions alone SHALL need no release.

#### Scenario: A contract change without a release

- **WHEN** a commit adds an operation to `openapi.json` and does not cut a release
- **THEN** the repository's static gate fails, listing the added operation and the release command

#### Scenario: A description is reworded

- **WHEN** a commit changes only an operation's description
- **THEN** the static gate passes with no release

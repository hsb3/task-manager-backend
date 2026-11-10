# Contract

What a client can read and rely on about the contract version. The rulings this contract
implements are the seven in this change's proposal, cited below as ruling 1 to 7. "The contract"
is `openapi.json` plus the MCP tool catalog, `mcp-tools.json` (rulings 2 and 5).

## Routes

No route is added. The version rides on every existing response (ruling 1):

| Surface | Where the version is | Value |
| --- | --- | --- |
| Every PocketBase response (`{API}`), any method and path | `Api-Version` response header | The contract version |
| Every hosted MCP endpoint response (`{MCP}`), any method and path | `Api-Version` response header | The contract version of the catalog it serves |
| `openapi.json` | `info.version` | The contract version |
| `tm --version` | second output line | The contract version the client was built against |
| MCP `serverInfo` (`tm mcp` and hosted) | `version` | The `tm` client version, not the contract version (hosted-mcp-endpoint contract, "Protocol revisions and transport") |

`{API}` and `{MCP}` are the two origins of the hosted-mcp-endpoint contract.

## Requests and Responses

### The version

A semantic version, `MAJOR.MINOR.PATCH` (https://semver.org/spec/v2.0.0.html), digits only, no
pre-release or build part. PATCH is always `0`: the version names the contract, not the server
software, so a release exists only to record a structural contract change, which is MINOR or
MAJOR; a fix that keeps the contract ships with no release. This departs from semver rule 6
(PATCH for bug fixes) on purpose.

- `0.MINOR.0`: before release 1.0.0. "Major version zero (0.y.z) is for initial development.
  Anything MAY change at any time" (semver rule 4). The first recorded version is `0.1.0`.
- `1.0.0`: cut before the hosted MCP endpoint is opened to outside users (ruling 6). The
  compatibility promise below binds from it.

### `Api-Version` header

```
Api-Version: 0.1.0
Access-Control-Expose-Headers: Api-Version
```

- Sent on every response of the PocketBase server: 2xx, 3xx, 4xx (404 for an unmatched path,
  401 and 403 refusals, 429) and 5xx, a CORS preflight (`OPTIONS`), the realtime SSE stream
  (`GET /api/realtime`), and the dashboard (`/_/`).
- `Access-Control-Expose-Headers: Api-Version` rides on the same responses, because a browser
  exposes only the CORS-safelisted response headers to a cross-origin script by default ("Only
  the CORS-safelisted response headers are exposed by default", MDN,
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers).
- The name has no `X-` prefix (RFC 6648, proposal "Settled without a ruling").
- A request header naming a version (`Api-Version`, `X-Api-Version`, a vendor `Accept` type) is
  ignored: one contract is served (ruling 1).
- The hosted MCP endpoint sends the same header, with the same value, on every response,
  including 401, 403, 404, 405, 406, 429, 500 and 503.

### `openapi.json`

`info.version` is the contract version. Every operation, parameter and schema property that is
deprecated carries `deprecated: true` (OpenAPI 3.1). Nothing is deprecated at `0.1.0`.

### `mcp-tools.json`

A new file at the repository root, generated from the catalog `tm mcp` serves:

```json
{
  "tools": [
    {
      "annotations": { "readOnlyHint": true },
      "description": "...",
      "inputSchema": { "type": "object", "properties": { "...": {} }, "required": [] },
      "name": "tm_list"
    }
  ]
}
```

One entry per tool, in catalog order, each holding exactly the fields `tools/list` returns for
it. Contract: a tool's `name` and its `inputSchema` (property names, types, enum values, required
list). Not contract: `description`, `annotations`, `title` (ruling 5). A deprecated tool's
`description` starts with `Deprecated:`.

### `tm --version`

```
$ tm --version
0.1.0
api 0.1.0
```

Line 1 is exactly what the tm-distribution contract defines ("`tm --version`": the package
version alone). This change adds line 2: `api ` plus the contract version of the `openapi.json`
the client was generated from. Everything else tm-distribution states holds: stdout only, exit 0,
no network call, no saved login needed, `--version` wins over every other argument. A script
wanting only the client version reads the first line.

### The API changelog, `api/CHANGELOG.md`

Format after Keep a Changelog 1.1.0 (https://keepachangelog.com/en/1.1.0/): newest first ("The
latest version comes first"), one section per release:

```markdown
## 0.2.0 - 2026-11-20

### Added

- `op GET /api/tracker/version-example :: exists`

### Deprecated

- `op GET /api/tracker/old :: deprecated`
```

- Heading: `## <version> - <YYYY-MM-DD>`, the release date in UTC.
- Subsections, in this order and only when non-empty: `### Added`, `### Changed`,
  `### Deprecated`, `### Removed`. Each bullet is one contract fact (design, "Contract facts")
  in backticks; free prose may follow a fact on the same bullet after ` - `.
- A breaking release names its cause in a bullet under `### Changed` or `### Removed`; a break
  forced by a PocketBase upgrade starts `### Changed` with `- Forced by: PocketBase <version>`.
- Every API change is in it; the file is the place Linear's `[API]` changelog entries fill
  (proposal, Prior art).

### Released contract

`api/openapi.released.json` and `api/mcp-tools.released.json` hold the contract as of the latest
release (ruling 7). A reader comparing two releases diffs these files between the two commits.

## Compatibility promise

From 1.0.0 (rulings 1, 3, 6):

- **Breaking**, shipped only in a new MAJOR, and only after the item was deprecated for at least
  90 days (ruling 4): removing or renaming an operation, a parameter, a request or response field,
  an MCP tool or a tool input; adding a required parameter, request field or tool input; making
  an optional one required; changing a type; removing an enum value; adding a validation rule to
  an existing input; changing authentication or authorization requirements; changing a status
  code, an error `code`, or a default (page size, sort order) (ruling 3).
- **Not breaking**, shipped in a MINOR: adding an operation, an optional input, a response
  field, an enum value, an MCP tool, an error status; deprecating anything.
- **Not a contract change**, no release: descriptions, summaries, tags, tool annotations and
  titles, error `message` text, and behaviour the contract does not describe.
- **Client duty:** ignore unknown response fields and unknown enum values (proposal, "Settled
  without a ruling"); never parse `message`.
- **PocketBase's own routes** are contract (ruling 2). A PocketBase upgrade that changes them is
  a contract change like any other: held until its breaks pass the deprecation window, or, when
  PocketBase forces the break, shipped as a MAJOR whose changelog names the PocketBase version.
- **Before 1.0.0:** any change ships in a MINOR with its changelog section, with no deprecation
  window (ruling 6).

## Deprecation

From the first deprecation on (ruling 4); nothing is deprecated at 0.1.0:

1. A MINOR release lists the item under `### Deprecated`; its date is the deprecation date.
2. From that release, the item carries `deprecated: true` in `openapi.json` (a tool: a
   `Deprecated:` description), and every response of a deprecated operation carries:
   ```
   Deprecation: @<deprecation date 00:00:00 UTC as Unix seconds>
   Sunset: <HTTP-date, at least 90 days after the deprecation date>
   Link: <https://github.com/hsb3/task-manager-backend/blob/main/api/CHANGELOG.md>; rel="deprecation"
   ```
   `Deprecation` is an RFC 9745 Structured Field Date ("its value MUST be a Date", example
   `Deprecation: @1688169599`, https://www.rfc-editor.org/rfc/rfc9745.html); `Sunset` is RFC 8594
   and "MUST NOT be earlier than" the `Deprecation` date (RFC 9745). The three names are added to
   `Access-Control-Expose-Headers` on those responses.
3. The item keeps working until at least the `Sunset` date. Its removal ships in a MAJOR release
   dated on or after it.

## Errors

None added. Every existing error answer gains the `Api-Version` header; no status, code or body
changes.

## Auth

None. The header is sent whatever the credential, and to an anonymous caller. `tm --version`
needs no credential.

## Compatibility

- **The version value drops** from the constant `1.0.0` in `openapi.json` to `0.1.0`. The old
  value was never a release (proposal, Why); no client outside the repository reads it.
- **Responses gain** `Api-Version` and an `Access-Control-Expose-Headers` entry; nothing else in a
  response changes.
- **`tm`** gains `--version`; every verb is unchanged.
- **Contributors**: a commit that changes the contract structurally must cut a release in the
  same commit (`bun scripts/release_api.ts`), or `make check-static` fails. This binds every
  change built after this one, the other milestone changes included.

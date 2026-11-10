# Design

How the contract (`contract.md`) is met. Paths are repository-relative. Claims about the current
tree were checked against it on 2026-11-10; the room probes ran on PocketBase 0.40.4 (spike,
"Evidence" under Decisions).

## Decisions

### D1. One version source, in `pb_hooks/lib/api_version.js`

The contract version lives in one file, `pb_hooks/lib/api_version.js`:

```js
// The API contract version (docs/api-versioning.md); scripts/release_api.ts rewrites it.
module.exports = { API_VERSION: "0.1.0" };
```

- It sits under `pb_hooks/` because the `Dockerfile` copies only `pb_migrations` and `pb_hooks`
  into the image, and the running server must send the value.
- Scripts read it with `createRequire`, exactly as `scripts/gen_openapi.ts` already reads
  `pb_hooks/lib/routes.js` (its `ROUTES` constant). Every other carrier is derived from it:
  `openapi.json` `info.version` (by `scripts/gen_openapi.ts`), `API_VERSION` in
  `clients/tm/src/api.generated.ts` (by `scripts/gen_tm_client.ts` from `openapi.json`), and the
  `Api-Version` header (by the hook). Drift between them is caught by the generators' existing
  `--check` runs in `make check-static`, not by a new comparison.
- Alternatives: a root `VERSION` file (not in the image; the hook could not read it); the
  version in `openapi.json` read by the hook (not in the image either); `package.json` (that is the
  repo tooling manifest, and tm has its own).

### D2. The header is set by one router middleware at priority -99999

New file `pb_hooks/api_version.pb.js` registers, through the only allowed site
(`require(`${__hooks}/lib/routes.js`).use`, `scripts/check_route_registry.ts`), a
`new Middleware(fn, -99999)` that sets `Api-Version` and adds `Api-Version` to
`Access-Control-Expose-Headers`, then returns `e.next()`. The version is read inside the handler
with `require(`${__hooks}/lib/api_version.js`).API_VERSION`, because the pooled JSVM shares no
top-level value with a callback (`.agents/rules/pocketbase.md`).

- Priority -99999 runs before `pb_hooks/api_keys.pb.js`'s -1030 middleware and before
  PocketBase's rate limiter, so refusals and 429s carry the header.
- **Evidence (spike, room on port 10694, scratch copies, the exact handler above):** every probe
  answered with `Api-Version: 0.1.0` and `Access-Control-Expose-Headers: Api-Version`:
  `GET /api/health` 200; `GET /api/nope/nothing` 404; `GET /totally/unknown` 404; anonymous
  `GET /api/collections/workspaces/records` 200; `GET /api/collections/nosuch/records` 404;
  `Authorization: tmk_bogus` on `/api/tracker/me` 401; `/api/tracker/me` with no credential 401;
  `GET /api/health` with `Origin` 200 (beside `Access-Control-Allow-Origin: *`); `OPTIONS` preflight
  204; `GET /_/` 200; malformed JSON to `auth-with-password` 400; the 429 from 40 rapid
  `auth-with-password` posts; `HEAD /api/health` 200; `GET /api/realtime` (SSE) 200. The boot log
  held no `failed to execute` line.
- `add`, not `set`, for `Access-Control-Expose-Headers`: it is a list, and the deprecation
  headers (D12) join it as further entries on the responses that carry them.
- Alternatives: a header per route in `routes.js` `add` (misses PocketBase's own routes, 404s
  and 429s, which ruling 2 covers); `onServe` with a wrapping handler (more code, same effect).

### D3. No version route

The version rides on every response, `GET /api/health` included, so no route is added. Linear
has no version route (proposal, Prior art); a header on every answer lets a client check the
version it is actually being served by, not a separate call.

### D4. Versions: `0.MINOR.0` now, `1.0.0` at the hosted MCP launch, PATCH always 0

- The first recorded version is `0.1.0`, cut by this change's Phase 4. This change is built
  last in the milestone (root ruling 2026-11-10: hosted-mcp-endpoint, key-scoping,
  key-minting-cli, tm-distribution, agent-verb-coverage, then this one), so that first release
  snapshots the finished milestone: every route, field and tool the five earlier changes add is
  in `api/openapi.released.json` and `api/mcp-tools.released.json` from the start, and no
  earlier change cuts a release. Release `1.0.0` follows, before the hosted MCP address is
  given to any outside user (D13). The constant `1.0.0` in `openapi.json` was never a
  release; semver rule 4: "Major version zero (0.y.z) is for initial development. Anything MAY
  change at any time", which is ruling 6 for the time before the launch.
- A release exists only to record a structural contract change, so it is MINOR or MAJOR. This
  departs from semver rule 6 (PATCH for backward compatible bug fixes) on purpose: the version
  names the contract, not the server software, and a fix leaves the contract unchanged. A
  behaviour fix that keeps the contract ships with no release. Semver rule 7 ("MUST be
  incremented if any public API functionality is marked as deprecated") is why a deprecation is
  a MINOR release.
- Fetched 2026-11-10, https://semver.org/spec/v2.0.0.html: rule 5 "Version 1.0.0 defines the
  public API"; rule 8 "MUST be incremented if any backward incompatible changes are introduced to
  the public API".

### D5. Every structural contract change is released in the commit that makes it

Production deploys from `main` whenever a push touches a watch pattern (`.agents/rules/deploy.md`,
Topology; `deploy/railway/railway.ts` watches `Dockerfile`, `pb_migrations/**`, `pb_hooks/**`),
and every route or collection change touches one. If unreleased additions could reach `main`, a
deploy would send `Api-Version: 1.2.0` with operations
1.2.0 never had. So the gate (D9) fails whenever the tree's contract differs structurally from
the released snapshot, and the remedy is `bun scripts/release_api.ts` in the same change. The
release is the reviewed commit of ruling 7 (it is reviewed in its PR). Description-only edits
never differ structurally (D7), so they need no release.

- Alternative: an "Unreleased" changelog section and releases cut at will (as GitHub ships
  additive changes into a dated version). Rejected: with continuous deploys the header would
  not identify the contract served.
- Cost: concurrent contract PRs both bump the same version and conflict on
  `pb_hooks/lib/api_version.js` and `api/CHANGELOG.md`; the second rebases and re-runs the release
  (Risks).

### D6. The MCP tool catalog is published as `mcp-tools.json`

New generator `scripts/gen_mcp_tools.ts` writes `mcp-tools.json` at the repository root from
`TOOLS` in `clients/tm/src/mcp.ts` (each entry without its `run` function), the exact list
`tools/list` serves to a write credential. When this change is built, hosted-mcp-endpoint
(`lane/d-mcp` `9d4b060`, D11) has moved the module to MCP SDK v2 `@modelcontextprotocol/server`
2.4.0, keeping `TOOLS` an exported array typed `ToolDef` (`name`, `description`, `inputSchema`,
`annotations`, `run`); key-scoping and agent-verb-coverage have changed its content. The
generator reads `TOOLS.map(({ run, ...t }) => t)`, the same list `tools_for` returns for a key
that lists every tool, without depending on `tools_for`'s scope type. Importing the module has
no network effect: it defines constants and functions, compiles one Ajv validator per tool, and
imports `VERSION` from `clients/tm/src/version.ts` (tm-distribution), which imports
`clients/tm/package.json` (checked on the pre-milestone tree: a probe script imported it and
printed only what it asked for: each tool's keys, `name,description,inputSchema,annotations,run`,
which become `name,description,inputSchema,annotations` once `run` is dropped). The SDK
resolves from `clients/tm`, where the only manifest declaring it lives (hosted D1), which a
script importing `../clients/tm/src/mcp.ts` uses as any importer does. Being a
`scripts/gen_*.ts` with an `OUTPUT` constant, it joins `make check-static`'s `--check` loop and
`scripts/gen_gitattributes.ts` picks its output up for `.gitattributes` (the generator derives
paths from each generator's `OUTPUT`). The gate and the release script then read only JSON files,
so they run against a scratch mirror with `--root` (no `node_modules` needed there).

### D7. Contract facts: the structural fingerprint

`scripts/_api_contract.ts` turns `openapi.json` plus `mcp-tools.json` into a set of fact strings
`<item> :: <aspect>`. Two contracts are the same release iff their fact sets are equal. Facts are
also the changelog bullets.

**Items** (a node is a root plus zero or more segments):

| Root | Text |
| --- | --- |
| operation | `op <METHOD> <path>` (METHOD upper case) |
| parameter | `param <METHOD> <path> <in> <name>` |
| request body | `body <METHOD> <path> <content-type>` |
| response | `response <METHOD> <path> <status> <content-type>`; with no `content`, `response <METHOD> <path> <status>` |
| component schema | `schema <Name>` |
| security scheme | `securityScheme <Name>` |
| MCP tool | `tool <name>` |
| MCP tool input | `tool <name> input` |

Segments inside a schema: `.<property>`, `[]` (`items`), `{}` (`additionalProperties` when it is
a schema), `|<i>` (`anyOf` or `oneOf` branch i, 0-based). The item text is root plus segments
joined with no separator, e.g. `schema LabelsRecord.color`, `tool tm_create input.fields{}`.

**Aspects:**

| Where | Aspects emitted |
| --- | --- |
| operation | `exists`; `security <JSON.stringify of the operation's security array>`, or the literal text `security default` when the key is absent; `deprecated` when `deprecated: true` |
| parameter | `exists`; `required` when `required: true`; `deprecated`; then its `schema` as a node rooted at the parameter item |
| request body | `exists`; `required` when `requestBody.required` is true; its schema rooted at the body item |
| response | `exists`; its schema, when it has `content`, rooted at the response item |
| every schema node | `exists`; `type <t>` (an array of types sorted and joined with `|`); `format <f>`; `ref <Name>` (the last segment of `$ref`); `enum <JSON value>` (one fact per value); `default <JSON>`; `minimum <n>`; `maximum <n>`; `minProperties <n>`; and, for each of the JSON Schema validation keywords `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, `maxProperties`, `const`, `<keyword> <JSON value>`; `nullable` when true; `additionalProperties <true|false>` when boolean; `required` on a property node listed in its parent's `required`; `deprecated` when true |
| security scheme | `<key> <JSON value>` for each key except `description` |
| MCP tool | `exists`; `deprecated` when `description` starts with `Deprecated:`; `inputSchema` as a node rooted at `tool <name> input` |

**Structural keys** (read to emit the facts above, never facts themselves): path item: the HTTP
methods; operation: `parameters`, `requestBody`, `responses`, `security`, `deprecated`; parameter:
`in`, `name`, `required`, `schema`, `deprecated`; request body: `content`, `required`; response:
`content`; content entry: `schema`; schema node: `properties`, `items`, `additionalProperties`,
`anyOf`, `oneOf`, `required`, `$ref` and the aspect keys; `components`: `schemas`,
`securitySchemes`; tool: `name`, `inputSchema`.

**Top-level keys:** `openapi.json` may hold `openapi`, `info`, `tags` (ignored), `components` and
`paths`; `mcp-tools.json` may hold `tools`; a content entry may hold `schema` only. Any other key
at those levels throws as below (a global `security` would change every operation's
`security default`, so it must not pass silently).

**Ignored keys** (keys of the objects named above, never names under `properties`, so a property
called `description` is a property): `description`, `summary`, `title`, `tags`, `example`, `examples`, `operationId`,
`annotations`, `$schema`; top-level `info`, `tags`, `openapi`. **Any other key** in a schema
node, an operation, a parameter, a request body, a response, a path item (other than an HTTP
method), `components` (other than `schemas` and `securitySchemes`) or a tool throws
`Error("unhandled contract key \"<key>\" at <item>")`. A new keyword therefore fails the gate
until this list classifies it, instead of slipping by. The pre-milestone tree uses only a subset
of the listed keys (census); the validation keywords are listed now so that a route or tool an
earlier milestone change adds with, for example, `maxLength` is classified, not thrown. A key
outside every list when Phase 3 runs (Phase 3 test case 1 throws, naming it) means a sibling
used a keyword this design did not foresee: stop and report it, do not classify it ad hoc. A name in a schema's `required` with no
matching property throws `Error("required name \"<name>\" has no property at <item>")`. (The current files use exactly the keys
above: checked with a key census of `openapi.json` and of `TOOLS`.)

**Classification** of a diff between an old fact set O and a new set N:

1. A removed fact (in O, not in N) is **breaking**, unless its aspect is `deprecated`.
2. An added `required` fact is **breaking** when its item is request-side and the item's owner
   exists in O.
3. An added `minimum`, `maximum`, `minProperties`, `additionalProperties`, `format`, or any of
   the validation keywords listed in the schema-node row above, fact is
   **breaking** when its item is request-side and the item's own `exists` fact is in O.
4. An added `enum` fact is **breaking** when its item is request-side, its own `exists` fact is
   in O, and O holds no `enum` fact for that item (a new restriction); otherwise adding an enum
   value is not breaking.
5. Every other added fact, and a removed `deprecated`, is **not breaking**. An added `deprecated`
   is a **deprecation**.

- *Owner* of an item: `op <METHOD> <path>` for parameter, body and response items; `schema
  <Name>` for component nodes; `tool <name>` for tool items; the item itself for `op` and
  `securityScheme` items.
- *Request-side*: parameter items, body items, `tool <name> input` items, and component schemas
  reachable by `$ref` (transitively) from any parameter or request body schema in N.
- Removal of any other fact covers ruling 3's breaking list that is structural (operation,
  parameter, field, tool, input removed or renamed; type, status, auth, default changed; enum
  value removed). The rest of ruling 3 (a new validation rule in a hook, a changed error `code`)
  is invisible to the fingerprint, as are PocketBase's own defaults that `openapi.json` does
  not write (the page size and sort order of a collection list: `perPage` has no `default`), and is
  caught by the change's spec delta (proposal, "Settled
  without a ruling").
- This is conservative: removing `required` from a request-only field is classed breaking, and
  `--forced-by` (D8) is the escape after review.

**Ancestors** of an item: the item with segments dropped from the end one at a time down to its
root, then its owner, with duplicates removed (first occurrence kept; a component node's root
is its owner). Used by D8's deprecation cover. Parsing an item string: split on single spaces;
the root kind is token 0, and the root spans a fixed token count: `op` 3, `param` 5, `body` 4,
`response` 5 (4 when it has no `content`, and then it has no segments), `schema` 2,
`securityScheme` 2, `tool` 2, `tool <name> input` 3. An `op` item never has segments. The last
root token's base ends at its first `.`, `[`, `{` or `|`; the rest of that token is the segment
string, split by the regex `/\.[^.\[{|]+|\[\]|\{\}|\|\d+/g`. (Every content type in
`openapi.json` is `application/json`, which holds none of those characters.)

### D8. The release script, `scripts/release_api.ts`

```
bun scripts/release_api.ts [--major] [--forced-by TEXT] [--date YYYY-MM-DD] [--root DIR] [--no-regen]
```

1. Unless `--no-regen`: run `bun scripts/gen_openapi.ts --check` and `bun scripts/gen_mcp_tools.ts
   --check` (as in step 7); a non-zero exit prints `❌ release_api: <generator> --check failed;
   regenerate the contract first` and exits 1, so a release never snapshots a stale file. Then
   read the current version V (D1), the tree contract (`openapi.json`, `mcp-tools.json`), the
   released contract (`api/openapi.released.json`, `api/mcp-tools.released.json`) and
   `api/CHANGELOG.md`, all under `--root` (default: the repository). A missing or unparsable
   file: print `❌ release_api: <path>: <reason>`, exit 1, write nothing.
0. Usage errors come first, before any file is read. `parse_args` (`scripts/_argparse.ts`)
   handles unknown flags and `-h`; the two checks below run right after it in `main` and fail
   the way it does, written out in the script: `process.stderr.write(`${USAGE}\nrelease_api.ts:
   error: ${msg}\n`)`, exit 2: `--forced-by` without `--major` → `--forced-by needs --major`; a `--date` that is not
   a real `YYYY-MM-DD` date → `--date wants a real YYYY-MM-DD date`.
2. D = `--date` or today's UTC date. If D is earlier than the date of the changelog's newest
   section: `❌ release_api: --date <D> is before the newest release <version> (<date>)`, exit 1.
   A changelog with no `## ` section line, or whose first `## ` line is not a release heading:
   `❌ release_api: api/CHANGELOG.md has no release section on top`, exit 1.
3. O = facts(released), N = facts(tree); classify (D7).
4. New version:
   - no diff and no `--major`: print `❌ release_api: nothing to release: the contract matches
     <V>`, exit 1.
   - `--major`: `<major+1>.0.0`.
   - a breaking fact, major ≥ 1, no `--major`: print `❌ release_api: breaking change needs
     --major:` and one `  - <fact>` line per breaking fact, exit 1.
   - otherwise `<major>.<minor+1>.0`.
5. Only when V's major ≥ 1 and the diff holds breaking facts: each breaking fact needs a
   *cover*: an ancestor-or-self item A with `A :: deprecated` in O, whose earliest changelog
   section listing `` `A :: deprecated` `` under `### Deprecated` is dated at least 90 days before
   D. Without `--forced-by`, every uncovered fact is printed under `❌ release_api: breaking
   change before its deprecation window ends:` as one of: `  - <fact>: never deprecated` (no
   ancestor-or-self is deprecated in O); `  - <fact>: deprecated, but no changelog section lists
   it` (deprecated in O, never under `### Deprecated`); `  - <fact>: deprecated <date>, removable
   from <date + 90 days>` (dates `YYYY-MM-DD`; with several deprecated ancestors, the nearest
   one listed in the changelog). Then exit 1. With `--forced-by`, uncovered facts are allowed.
6. Write, in this order: `pb_hooks/lib/api_version.js` (the D1 template with the new version);
   the changelog section (D10) inserted above the first `## ` line; `api/openapi.released.json`
   (the tree's `openapi.json` parsed, `info.version` set to the new version, written with
   `json_dumps(spec, { indent: 2, sort_keys: true, ensure_ascii: false }) + "\n"` from
   `scripts/_py.ts`, the same rendering `gen_openapi.ts` uses); `api/mcp-tools.released.json`
   (a byte copy of `mcp-tools.json`). Each file is written whole with `fs.writeFileSync`; a
   write that throws prints `❌ release_api: writing <path>: <reason>; restore with git checkout
   -- pb_hooks/lib/api_version.js api/` and exits 1.
7. Unless `--no-regen`: run `bun scripts/gen_openapi.ts`, then `bun scripts/gen_tm_client.ts`
   (each as `[process.execPath, <root>/scripts/<name>]`, cwd root). A non-zero exit prints
   `❌ release_api: <generator> failed; the release files are written, rerun it` and exits 1.
8. Print `✅ release_api: <V> -> <new> (<a> added, <r> removed, <b> breaking, <d> deprecated)`
   (counts of added facts, removed facts, breaking facts among both, added `deprecated` facts),
   exit 0.

Every `✅`/`❌` line goes to stdout (`console.log`, as `gen_openapi.ts` does); only usage errors
go to stderr. Help text, as `parse_args` takes it:

```
USAGE = "usage: release_api.ts [-h] [--major] [--forced-by TEXT] [--date YYYY-MM-DD] [--root ROOT] [--no-regen]"
HELP  = USAGE + "\n\nCut an API contract release: bump pb_hooks/lib/api_version.js, add an\n" +
        "api/CHANGELOG.md section and replace the released contract under api/.\n\n" +
        "options:\n  -h, --help        show this help message and exit\n" +
        "  --major           release a new major version\n" +
        "  --forced-by TEXT  allow undeprecated breaks in a major release; TEXT names the cause\n" +
        "  --date YYYY-MM-DD release date (default: today, UTC)\n" +
        "  --root ROOT       tree to release (default: this repo)\n" +
        "  --no-regen        skip the generators (tests)\n"
```

`--no-regen` exists for the test suite, whose scratch mirror has no PocketBase replay.

### D9. The gate, `scripts/check_api_version.ts`

`bun scripts/check_api_version.ts [--root DIR]`, run by `make check-static` (it matches the
Makefile's `CHECKERS` wildcard). It collects every error, then prints `❌ check_api_version:` and one `     • <error>` line per
error (multi-line errors indented under their bullet), on stdout, and exits 1; or prints
`✅ check_api_version: contract <V> matches its release; changelog in order.` and exits 0:

1. `read_api_version(root)` succeeds; else its message as is (it already names
   `pb_hooks/lib/api_version.js`). When it fails, the comparisons with V in steps 2 and 3 are
   skipped; steps 2-4 still run their other checks.
2. `api/openapi.released.json` and `api/mcp-tools.released.json` exist and parse; else
   `<path>: <reason>`. The snapshot's `info.version` equals V; else `api/openapi.released.json is
   <x>, API_VERSION is <V>: cut releases only with scripts/release_api.ts`.
3. `api/CHANGELOG.md` (D10): every `## ` line matches `^## ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.0) - (\d{4}-\d{2}-\d{2})$`
   (else `line <n>: not a release heading`); the first heading's version is V (else
   `the newest changelog section is <x>, API_VERSION is <V>`); versions strictly descending by
   semver and dates non-increasing (else `line <n>: <version> is out of order`); each section
   holds at least one line starting `- ` (else `line <n>: section <version> lists no change`).
4. facts(tree) equals facts(released). Else: `the contract changed since <V>:` (`<V>` is
   `the last release` when step 1 failed), one line per
   fact, `  + <fact>` or `  - <fact>`, each breaking one suffixed ` (breaking)`, sorted by fact
   text, then `cut a release in this change: bun scripts/release_api.ts (docs/api-versioning.md)`.
5. A thrown `unhandled contract key` error is reported as is.

Output on stdout. Help text: `USAGE = "usage: check_api_version.ts [-h] [--root ROOT]"`, `HELP =
USAGE + "\n\nCI / pre-commit check: the API contract matches its latest release and the\n" +
"changelog is in order.\n\noptions:\n  -h, --help   show this help message and exit\n" +
"  --root ROOT  tree to check (default: this repo)\n"` (the shape of `scripts/check_pb_pin.ts`).

It writes nothing. `openapi.json` `info.version` and `api.generated.ts` `API_VERSION` are not
compared here: the generators' `--check` already holds them to D1.

### D10. Changelog format

`api/CHANGELOG.md`, after Keep a Changelog 1.1.0 (https://keepachangelog.com/en/1.1.0/, fetched
2026-11-10: "The latest version comes first"; its types include `Added`, `Changed`,
`Deprecated`, `Removed`):

```markdown
# API changelog

Every release of the API contract (`openapi.json` and `mcp-tools.json`), newest first. Policy:
`docs/api-versioning.md`.

## 0.1.0 - 2026-11-10

### Added

- The first recorded contract: `openapi.json` and `mcp-tools.json` as of this release.
```

The release script writes a section as: the heading, a blank line, then for each non-empty
subsection in the order `Added`, `Changed`, `Deprecated`, `Removed`: `### <name>`, a blank line,
its bullets sorted by code point, a blank line. Bullets: `` - `<fact>` ``. Placement: not-breaking
added facts under Added; breaking added facts under Changed; added `deprecated` facts under
Deprecated; a removed `deprecated` fact under Changed when its item's `exists` fact is still in
N (an un-deprecation), else under Removed with the item's other removed facts; every other
removed fact under Removed. With `--forced-by TEXT`, Changed
starts with `- Forced by: TEXT`. A section that would hold no bullet gets `### Changed` with
`- No structural change since <V>.` The author may append prose after a bullet (`` - `<fact>` -
<prose> ``) and add prose bullets; the gate only requires one bullet per section.

### D11. tm carriers: already present, this change sets only the value of line 2

tm-distribution (built before this change) adds every tm carrier: `export const API_VERSION =
<openapi.json info.version>` in `scripts/gen_tm_client.ts` `render`, `clients/tm/src/version.ts`
(`VERSION` from `clients/tm/package.json`), and `tm --version` printing `tm <VERSION>` and
`api <API_VERSION>` after `parseArgs` (tm-distribution design Phase 1, `lane/d-dist`
`c5c62d5`; root ruling 3: its definition wins). This change edits none of those files. It
changes only what line 2 says: `gen_openapi.ts` now writes `info.version` from D1, so
regenerating `openapi.json` and `clients/tm/src/api.generated.ts` moves `API_VERSION` from the
old constant `1.0.0` to `0.1.0`. tm-distribution's `tests/test_tm_cli.ts` cases read the
expected line 2 from `openapi.json` `info.version`, so they follow without an edit.

- MCP `serverInfo` is not touched: it carries `VERSION` (hosted-mcp-endpoint and tm-distribution).
- Not in this change: tm comparing the server's `Api-Version` with its own and warning on a
  major mismatch. tm-distribution leaves that comparison to this policy; it is client behaviour
  beyond the carriers and is reported as follow-up work.

### D12. The deprecation mechanism is built by the first deprecation

Nothing is deprecated at 0.1.0, and before 1.0.0 nothing needs to be (ruling 6). The contract
fixes the signal (`deprecated: true`, the `Deprecated:` tool prefix, the three headers, the
changelog). The code that emits `deprecated: true` from a route or field and the three headers is
written by the first change that deprecates something, under its own design; D7 and D8 already
read and enforce `deprecated` facts. Building it now would add a mechanism with no caller and no
real case to test.

### D13. Policy document

`docs/api-versioning.md` (frontmatter as `docs/openspec.md`: `title`, `status: current`,
`version: 1`, `updated`) states the contract's Compatibility promise and Deprecation sections in
client terms, where to read the version, the changelog location, and the release procedure:
run `bun scripts/release_api.ts` in the change that alters the contract; review the generated
section and add prose; `make check-static`. It also states the PocketBase-upgrade duty: a PR
that moves `ARG PB_VERSION` reads PocketBase's release notes for Web API changes and lists each
under the release it cuts, or under a `--forced-by "PocketBase <version>"` major release. And
release 1.0.0: `bun scripts/release_api.ts --major` in its own PR, merged before the hosted MCP
endpoint's URL is given to any outside user; its changelog section gains the prose bullet
`- The compatibility promise in docs/api-versioning.md binds from this release.`

## Depends on

- **Build order (root ruling 1, final):** hosted-mcp-endpoint, key-scoping, key-minting-cli,
  tm-distribution, agent-verb-coverage, then this change, last, and in any case before the
  hosted MCP address is given to any outside user. Every earlier change is on `main` when Phase 1
  starts. Sibling heads read for this alignment: `lane/d-mcp` `9d4b060`, `lane/d-dist`
  `c5c62d5`, `lane/d-scoping` `0d3232c`, `lane/d-minting` `b205abc`, `lane/d-verbs` `a3f72ee`
  (combined review state `lane/readiness-wave` `7fb2b27`).
- **Already present** (checked before Phase 1 starts, each by its command; any other answer
  means the build order was changed: stop and report, change nothing):
  1. `grep -c '^export const API_VERSION' clients/tm/src/api.generated.ts` prints `1`
     (tm-distribution: `scripts/gen_tm_client.ts` writes it).
  2. `test -f clients/tm/src/version.ts` succeeds and `grep -c 'api ${API_VERSION}'
     clients/tm/tm.ts` prints `1` (tm-distribution: `VERSION`, the `package.json` import, and
     both `--version` lines).
  3. `test -f services/mcp/src/app.ts` succeeds (hosted-mcp-endpoint's service).
  4. `test -f scripts/release_api.ts` fails, and `test -e api` fails (no earlier change cut a
     release; root ruling 2).
  5. `test -f mcp-tools.json` fails (this change's Phase 3 creates it).
- **hosted-mcp-endpoint's `Api-Version` header.** Its D18 defers the header to this change
  unconditionally (it is built first, before `API_VERSION` exists) and sends no report; its D9
  sends `Access-Control-Expose-Headers: WWW-Authenticate, Retry-After`. This plan's Phase 6
  builds the header and adds `Api-Version` to that value, exactly as hosted D18 states. Phase 6
  keeps its own already-present check in case the hosted builder set the header anyway.
- **No later milestone change.** After this change, every change that alters `openapi.json` or
  `TOOLS` structurally cuts a release in its own commit (D5); the earlier milestone changes each
  state that they cut none (root ruling 2).
- **Shared files** this change edits that another milestone change also edits: `openapi.json`
  and `clients/tm/src/api.generated.ts` (regenerated), `scripts/gen_openapi.ts`
  (key-scoping), `tests/test_tm_client_gen.ts` (tm-distribution), `tests/test_hook_files_loaded.ts`
  (this change only, among the designs read), `services/mcp/src/app.ts` and
  `tests/test_mcp_service.ts` (hosted), `scripts/run_suite_battery.sh`,
  `scripts/battery_shards.tsv`, `.agents/rules/ports.md`, `e2e/smoke.ts`, `.gitattributes`,
  `AGENTS.md`, `docs/README.md`, `docs/readiness/README.md`. Every insertion point below is an
  anchor no earlier change rewrites (root ruling 8).

## Implementation Plan

Each phase ends with `make check-static` green and its focused suites green. Run every gate alone
and read its own exit status (AGENTS.md, Gate law). Rooms use `PB_PORT_OFFSET` (200 or more) and
`PB_BIN=$PWD/pocketbase`. Battery rows: a new suite gets a `run_suite` line in
`scripts/run_suite_battery.sh` beside the suites named below, and a `scripts/battery_shards.tsv`
row `<shard>\t<seconds>\t<label>`: seconds = the wall time of one solo run, rounded up to a whole
second; shard = the one whose summed seconds are lowest (a tie goes to the lower shard number),
counting rows added earlier in the same phase; inserted in seconds-descending order (the file's
header rule).

### Phase 1: version source and `openapi.json`

- **Goal:** one version source drives `openapi.json` `info.version`, and through it tm's
  `API_VERSION` and line 2 of `tm --version`, which tm-distribution already prints (contract
  "The version", "`openapi.json`", "`tm --version`"; SH-5 in part). Start only after the five
  "Already present" checks (Depends on) pass.
- **Files:**
  - create `pb_hooks/lib/api_version.js`
  - create `scripts/_api_contract.ts`
  - modify `scripts/gen_openapi.ts`
  - modify `tests/test_tm_client_gen.ts`
  - regen: `openapi.json` via `bun scripts/gen_openapi.ts`; `clients/tm/src/api.generated.ts`
    via `bun scripts/gen_tm_client.ts` (its `API_VERSION` becomes `0.1.0`; no other line moves)
- **Steps:**
  - `pb_hooks/lib/api_version.js`: exactly the D1 template with `0.1.0`.
  - `scripts/_api_contract.ts`: header comment `// The API contract: its version source and its
    structural facts (docs/api-versioning.md).` Exports
    `API_VERSION_FILE = "pb_hooks/lib/api_version.js"`, `VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/` (semver forbids leading zeros), and
    `read_api_version(root: string): string`, which loads `path.join(root, API_VERSION_FILE)` with
    `createRequire(import.meta.url)` after deleting that path from `require.cache` (so a rewrite
    in the same process is seen; checked with a Bun probe that loaded `0.1.0`, rewrote the file
    and loaded `0.2.0`), and throws `Error("pb_hooks/lib/api_version.js: API_VERSION missing or not
    MAJOR.MINOR.0")` when the export is not a string matching `VERSION_RE`, or
    `Error("pb_hooks/lib/api_version.js: <the require error's message>")` when the file is
    missing or does not load (always the relative path).
  - `scripts/gen_openapi.ts`: import `read_api_version`; `info.version` becomes
    `read_api_version(REPO)` (replacing the literal at `build_spec`'s return). Append to
    `INFO_DESCRIPTION` the sentence: `" Every response carries an Api-Version header naming the
    contract version, equal to info.version; versioning and deprecation: docs/api-versioning.md
    in this repository."` A thrown version error is reported by `main`'s existing catch as
    `❌ gen_openapi: <message>`.
  - Regenerate `openapi.json`, then `clients/tm/src/api.generated.ts`.
- **Tests:**
  - `tests/test_tm_client_gen.ts`, new case `(f) the client's API_VERSION is the version
    source's`: `render(SPEC)` contains `` `export const API_VERSION = ${JSON.stringify(SPEC.info.version)};` ``
    and `SPEC.info.version === read_api_version(REPO_ROOT)` (both compared, never a literal).
    Watched failing: run it before the `gen_openapi.ts` change; `openapi.json` still says
    `1.0.0` and `read_api_version` says `0.1.0`.
  - `tests/test_tm_cli.ts` is not edited: tm-distribution's `--version` cases read line 2's
    expected value from `openapi.json`; run the suite to see them pass with `api 0.1.0`.
- **Gate:** `bun tests/test_tm_client_gen.ts`; `PB_PORT_OFFSET=<n> bun tests/test_tm_cli.ts`;
  `bun scripts/gen_tm_client.ts --check`;
  `bun scripts/gen_openapi.ts --check`; `make check-static`.

### Phase 2: the `Api-Version` header

- **Goal:** every PocketBase response names the contract version and exposes it to browsers
  (contract "`Api-Version` header"; spec "Every API response names the contract version"; SH-5).
- **Files:**
  - create `pb_hooks/api_version.pb.js`
  - create `tests/test_api_version_header.ts`
  - modify `tests/test_hook_files_loaded.ts`
  - modify `.agents/rules/ports.md`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `e2e/smoke.ts`
- **Steps:**
  - `pb_hooks/api_version.pb.js`:
    ```js
    /// <reference path="../pb_data/types.d.ts" />
    // Api-Version on every response (docs/api-versioning.md); -99999 runs before key auth and the rate limiter.
    require(`${__hooks}/lib/routes.js`).use(
      new Middleware((e) => {
        const version = require(`${__hooks}/lib/api_version.js`).API_VERSION;
        e.response.header().set("Api-Version", version);
        e.response.header().add("Access-Control-Expose-Headers", "Api-Version");
        return e.next();
      }, -99999),
    );
    ```
    (`bun run format` settles its layout.)
  - `tests/test_hook_files_loaded.ts`: add `"api_version.pb.js"` to `probed`, and a §2 probe
    as the last §2 probe, directly before the line `console.log("\n── §3 every hook file is
    dispositioned ──");`: `GET /api/health` anonymous; check
    `"api_version.pb.js: /api/health carries Api-Version"`, got the response's `Api-Version`
    header, expected `read_api_version(REPO_ROOT)`. The suite's `api()` helper returns status
    and body only, so this probe uses `fetch(BASE_URL + "/api/health")` directly.
  - `.agents/rules/ports.md`: in the Defaults list, insert `8250 = test_api_version_header ·`
    in ascending port order, directly before `9700 = test_script_help` (every earlier change's
    ports are below 8250: hosted 8200-8207, key-scoping 8210-8215, key-minting-cli 8220-8224,
    tm-distribution 8230-8231, agent-verb-coverage 8240, per the cross-change review). `bun
    scripts/check_port_collisions.ts` must stay green.
  - `scripts/run_suite_battery.sh`: `run_suite "test_api_version_header" bun
    tests/test_api_version_header.ts` directly before the comment line that starts `# ── guard:
    the repo's real pb_migrations/`; `battery_shards.tsv`
    row per the rule above.
  - `e2e/smoke.ts`: new `probe_api_version()`: `fetch(BASE_URL + "/api/health")`; check
    `"GET /api/health carries Api-Version"`, got `r.headers.get("api-version")`, expected
    `read_api_version(ROOT)` (import from `../scripts/_api_contract.ts`). Insert it in `PROBES`
    directly before `probe_signup_rate_limit` (which stays last; the rate-limit probes must run
    last, and every earlier change inserts before it too).
- **Tests:** `tests/test_api_version_header.ts`, a self-booting room suite. Header comment:
  `/** Api-Version on every response (change api-versioning-policy). Self-contained clean-room
  server. Port 8250 + PB_PORT_OFFSET. INSPIRE_UPSTREAM_URL aims at a closed port. */`. Boot as `tests/test_route_errors.ts` does (scratch dir, `copy_tree` of
  `pb_migrations`, `*superuser_mfa.js` removed, `./pocketbase superuser upsert probe@example.com
  probe123456`, `roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S))` with
  `INSPIRE_UPSTREAM_URL=http://127.0.0.1:1/api/random` set in `process.env` around the call and
  restored after, as `tests/test_route_errors.ts` does, `roomkit.stop` in `finally`; superuser
  token from `POST /api/collections/_superusers/auth-with-password`). Expected header value `V = read_api_version(REPO_ROOT)`, also asserted equal to
  `openapi.json` `info.version`. Cases (label: request → expected):
  1. `health`: `GET /api/health` → 200, `Api-Version` = V.
  2. `unmatched path`: `GET /api/no-such-route` → 404, V.
  3. `outside /api`: `GET /no-such-page` → 404, V.
  4. `collection list`: `GET /api/collections/workspaces/records`, anonymous → 200, V.
  5. `unknown collection`: `GET /api/collections/nosuch/records` → 404, V.
  6. `refused key`: `GET /api/tracker/me` with `Authorization: tmk_` + 40 `A` → 401, V, body
     `data.api_key.code` = `api_key_invalid`.
  7. `no credential`: `GET /api/tracker/me` → 401, V.
  8. `bad JSON`: `POST /api/collections/users/auth-with-password`, body `{bad`, JSON content
     type → 400, V.
  9. `cross-origin`: `GET /api/health` with `Origin: https://example.com` → 200, V, and
     `Access-Control-Expose-Headers` split on `,` and trimmed contains `Api-Version`.
  10. `preflight`: `OPTIONS /api/health` with `Origin: https://example.com` and
      `Access-Control-Request-Method: GET` → 204, V, expose list contains `Api-Version`.
  11. `HEAD`: `HEAD /api/health` → 200, V.
  12. `dashboard`: `GET /_/` → 200, V.
  13. `realtime`: `GET /api/realtime` with an `AbortController` aborted once headers arrive →
      200, `Content-Type` `text/event-stream`, V.
  14. `request version ignored`: `GET /api/health` with `Api-Version: 0.0.1` and
      `X-Api-Version: 2099-01-01` → 200, `Api-Version` = V.
  15. `redirect`: `GET /admin` with `redirect: "manual"` → 302, V.
  16. `forbidden`: `GET /api/tracker/me` with the superuser token → 403, V.
  17. `upstream failure`: `GET /api/tracker/inspire` with the superuser token → 502, V.
  18. `rate limited`, last: up to 60 `POST /api/collections/users/auth-with-password` with
      `{"identity":"nobody@example.com","password":"x"}` until one answers 429 → that 429 has V
      (fail if no 429 within 60).
  Watched failing: run once with `pb_hooks/api_version.pb.js` absent (before it is written) and
  quote the ❌ lines for cases 1-18.
- **Gate:** `PB_PORT_OFFSET=<n> bun tests/test_api_version_header.ts`;
  `PB_PORT_OFFSET=<n> bun tests/test_hook_files_loaded.ts`; `bun scripts/check_port_collisions.ts`;
  `make check-static`.

### Phase 3: the catalog file and the contract facts

- **Goal:** the MCP catalog is published as `mcp-tools.json`, and the fingerprint and
  classification of D7 exist with their unit proof (contract "`mcp-tools.json`", "Compatibility
  promise"; SH-4 in part).
- **Files:**
  - create `scripts/gen_mcp_tools.ts`
  - modify `scripts/_api_contract.ts`
  - create `tests/test_api_contract.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - regen: `mcp-tools.json` via `bun scripts/gen_mcp_tools.ts`; `.gitattributes` via
    `bun scripts/gen_gitattributes.ts`
- **Steps:**
  - `scripts/gen_mcp_tools.ts`: header `// Generate mcp-tools.json, the MCP tool catalog as
    tools/list serves it, from TOOLS in clients/tm/src/mcp.ts (--check gates drift).`
    `const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));`
    `const OUTPUT = path.join(REPO, "mcp-tools.json");`
    `render(): string` = `json_dumps({ tools: TOOLS.map(({ run, ...t }) => t) }, { indent: 2,
    sort_keys: true, ensure_ascii: false }) + "\n"`. CLI via `parse_args` with `--check`
    (usage `usage: gen_mcp_tools.ts [-h] [--check]`). Check mode: missing file →
    `❌ gen_mcp_tools --check: mcp-tools.json does not exist. Run \`bun
    scripts/gen_mcp_tools.ts\` to generate it.` exit 1; differs → `❌ gen_mcp_tools --check:
    mcp-tools.json is out of date with TOOLS in clients/tm/src/mcp.ts.\n   Run \`bun
    scripts/gen_mcp_tools.ts\` to regenerate it.` exit 1; equal → `✅ gen_mcp_tools --check:
    mcp-tools.json is up to date.` exit 0. All three on stdout, as `gen_openapi.ts`. Write mode prints `✅ gen_mcp_tools: wrote
    mcp-tools.json (<n> tools).`
  - `scripts/_api_contract.ts` adds:
    - `type Fact = string;`
    - `facts(openapi: any, tools: any): Set<Fact>`: D7's items and aspects. Methods are the keys
      `get put post delete patch head options trace`; status keys are kept as written; JSON
      values via `JSON.stringify`. Throws on an unhandled key (D7).
    - `request_side(openapi: any): Set<string>`: component schema names reachable from
      parameter and request-body schemas.
    - `classify(old_facts: Set<Fact>, new_facts: Set<Fact>, openapi_new: any): { added: Fact[];
      removed: Fact[]; breaking: Fact[]; deprecated: Fact[] }`, each sorted by code point, D7's
      rules 1-5. `deprecated` holds added `:: deprecated` facts.
    - `item_of(fact: Fact): string` (text before ` :: `), `owner_of(item: string): string`,
      `ancestors(item: string): string[]` (self first, then shorter, then the owner).
    - `read_json(root: string, rel: string): any` (throws `Error("<rel>: <reason>")`).
  - Regenerate `mcp-tools.json` and `.gitattributes` (expect a new line
    `mcp-tools.json merge=binary`).
- **Tests:** `tests/test_api_contract.ts`, serverless, house-style `check(label, got, want)`
  printing ✅/❌, exit 1 on any failure. Fixtures are deep copies of the real `openapi.json` and
  `mcp-tools.json`, mutated per case; `classify` runs old = real, new = mutated:
  1. `real files fingerprint`: `facts(real)` does not throw and contains `op GET /api/health ::
     exists` and `tool tm_list :: exists`.
  2. `description only`: change `/api/health` `get.description` and a tool description → no
     added, no removed.
  3. `response field added`: add property `zz` `{type: "string"}` to the inline 200 schema of
     `GET /api/tracker/admin/pending-users` → added non-empty, breaking empty.
  4. `field removed`: delete a property from `LabelsRecord` → breaking holds `schema
     LabelsRecord.description :: exists` (the property deleted is `description`).
  5. `type changed`: `LabelsRecord.name.type` to `integer` → breaking holds the removed
     `type string` fact.
  6. `required added on a request-side schema`: push `"color"` onto `LabelsRecord.required` →
     breaking holds `schema LabelsRecord.color :: required`.
  7. `required added response-only`: add `zz` to the inline 200 schema of case 3 and to its
     `required` → breaking empty.
  8. `required parameter on an old operation`: add `{in: "query", name: "zz", required: true,
     schema: {type: "string"}}` to `GET /api/tracker/me` → breaking holds `param GET
     /api/tracker/me query zz :: required`. Same parameter on the operation `test_api_version_checker` case 2 adds
     (`/api/tracker/zz`, added in the same mutation) → breaking empty.
  9. `enum value added / removed`: add `"zz"` to `LabelsRecord.color.enum` → breaking empty;
     remove `"pink"` → breaking holds `schema LabelsRecord.color :: enum "pink"`.
  10. `default changed`: the `role` default in `POST /api/tracker/workspaces/{id}/resolve-member-email`
      to `"viewer"` → breaking holds `body POST
      /api/tracker/workspaces/{id}/resolve-member-email application/json.role :: default "member"`.
  11. `minimum added to an old request field`: `minimum: 1` on `LabelsRecord.name` → breaking.
  12. `enum added to an old request field`: `enum: ["a"]` on `LabelsRecord.name` → breaking.
  13. `security changed`: `security: []` on `GET /api/tracker/me` → breaking.
  14. `deprecation`: `deprecated: true` on `GET /api/health` → deprecated `[op GET /api/health ::
      deprecated]`, breaking empty; reversed (old deprecated, new not) → breaking empty.
  15. `tools`: remove `tm_comment` → breaking holds `tool tm_comment :: exists`; add the tool
      `{name: "tm_zz", description: "x", inputSchema: {type: "object", properties: {}},
      annotations: {}}` → breaking empty; prefix `tm_show`'s description with `Deprecated: ` →
      deprecated holds `tool tm_show :: deprecated`; push `"project"` onto `tm_create`'s `inputSchema.required` → breaking holds
      `tool tm_create input.project :: required`.
  16. `unhandled key`: add `pattern: "x"` to `LabelsRecord.name` → `facts` throws a message
      containing `pattern` and `schema LabelsRecord.name`.
  17. `ancestors`: `ancestors("schema LabelsRecord.color")` → `["schema LabelsRecord.color",
      "schema LabelsRecord"]`; `ancestors("param GET /api/tracker/me query zz")` → `["param GET
      /api/tracker/me query zz", "op GET /api/tracker/me"]`; `ancestors("tool tm_create
      input.fields{}")` → `["tool tm_create input.fields{}", "tool tm_create input.fields",
      "tool tm_create input", "tool tm_create"]`; `ancestors("op GET /api/health")` →
      `["op GET /api/health"]`.
  Watched failing: the suite run before `_api_contract.ts` gains these exports fails at import.
  `run_suite "test_api_contract" bun tests/test_api_contract.ts` goes directly before the comment
  line that starts `# ── guard: the repo's real pb_migrations/`.
- **Gate:** `bun tests/test_api_contract.ts`; `bun scripts/gen_mcp_tools.ts --check`;
  `bun scripts/gen_gitattributes.ts --check`; `make check-static`.

### Phase 4: released contract, changelog, release script and gate

- **Goal:** the released contract 0.1.0 is recorded, a structural change without a release
  fails `make check-static`, and a release is one command (contract "The API changelog",
  "Released contract", "Compatibility"; spec "Every contract change is a release"; SH-4).
- **Files:**
  - create `api/CHANGELOG.md`
  - create `api/openapi.released.json`
  - create `api/mcp-tools.released.json`
  - modify `scripts/_api_contract.ts`
  - create `scripts/release_api.ts`
  - create `scripts/check_api_version.ts`
  - create `tests/test_release_api.ts`
  - create `tests/test_api_version_checker.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
- **Steps:**
  - `api/CHANGELOG.md`: exactly D10's example (date: the day the phase is built, UTC).
  - `api/openapi.released.json`: byte copy of `openapi.json`; `api/mcp-tools.released.json`:
    byte copy of `mcp-tools.json`.
  - `scripts/_api_contract.ts` adds `parse_changelog(text: string): { line: number; version:
    string; date: string; bullets: string[]; deprecated: string[] }[]`: sections in file order;
    `line` is the heading's 1-based line; `bullets` are the section's lines starting `- `;
    `deprecated` holds the backticked facts of the bullets under `### Deprecated`; a `## ` line
    that is not a release heading (D9's regex) is returned with `version: ""` and `date: ""`.
    D8 and D9 both use it.
  - `scripts/release_api.ts`: D8, CLI by `parse_args` (`-h` exits 0 with no side effect, as
    `tests/test_script_help.ts` requires of every `scripts/*.ts`). Changelog writing per D10.
    Date arithmetic in UTC (`Date.UTC`); `--date` must match `^\d{4}-\d{2}-\d{2}$` and be a real
    date, else usage error exit 2.
  - `scripts/check_api_version.ts`: D9, CLI by `parse_args` with `--root` (default the
    repository, from `repo_root(import.meta.path)` in `scripts/_repo_root.ts`).
- **Tests:**
  - **Fixture mirror** (both suites; every case starts from a fresh one): `fs.mkdtempSync` under
    `os.tmpdir()`, then, written with `fs.writeFileSync` / `fs.copyFileSync` only (never
    `cpSync`, which `scripts/check_scratch_copies.ts` refuses):
    - `pb_hooks/lib/api_version.js`: the D1 template with `0.1.0`, whatever the real version is;
    - `openapi.json` and `api/openapi.released.json`: the real `openapi.json` parsed, `info.version`
      set to `"0.1.0"`, rendered as D8 step 6 renders;
    - `mcp-tools.json` and `api/mcp-tools.released.json`: byte copies of the real `mcp-tools.json`;
    - `api/CHANGELOG.md`: D10's example with the heading `## 0.1.0 - 2026-11-10`.
    Every date the suites pass is on or after 2026-11-10, except case 12's deliberate
    `2026-11-09`. The fixture never depends on the
    repository's own version or changelog, so later releases do not change any expected value.
    "At 1.0.0" means: the fixture, then `release_api.ts --root <mirror> --no-regen --major --date
    2026-12-01` (exit 0, `1.0.0`).
  - `tests/test_api_version_checker.ts`, serverless. Each case mutates a fixture mirror and runs
    `[process.execPath, scripts/check_api_version.ts, "--root", mirror]`:
    1. `unmutated` → exit 0, output starts `✅ check_api_version`.
    2. `operation added`: add `paths["/api/tracker/zz"] = {get: {responses: {"200":
       {description: "x"}}, summary: "x", description: "x", tags: ["tracker"]}}` → exit 1,
       output contains `+ op GET /api/tracker/zz :: exists` and `bun scripts/release_api.ts`.
    3. `description only`: change `/api/health` description → exit 0.
    4. `version bumped by hand`: `api_version.js` to `0.2.0` → exit 1, names `0.2.0` and `0.1.0`.
    5. `version not MAJOR.MINOR.0`: `0.1.1` → exit 1 naming `pb_hooks/lib/api_version.js`.
    6. `snapshot missing`: delete `api/openapi.released.json` → exit 1 naming it.
    7. `changelog head mismatch`: insert `## 0.0.9 - 2026-01-01\n\n### Added\n\n- x\n` above the
       first section → exit 1 (`out of order` and `newest changelog section`).
    8. `changelog bad heading`: append `## next` → exit 1, `not a release heading`.
    9. `changelog empty section`: the fixture changelog with its bullet line deleted → exit 1,
       `lists no change`.
    10. `tool removed`: drop `tm_comment` from the mirror's `mcp-tools.json` → exit 1, contains
        `- tool tm_comment :: exists (breaking)`.
    11. `nothing written`: `git status --porcelain` of the repository is identical before and
        after the suite.
    Watched failing: case 2 run against a checker stub that always exits 0 shows ❌.
  - `tests/test_release_api.ts`, serverless, the fixture mirror, every run with `--root <mirror>
    --no-regen`; "the case-2 operation" is the operation `test_api_version_checker` case 2 adds:
    1. `nothing to release` (`--date 2026-12-01`) → exit 1, message `nothing to release`, mirror
       unchanged (every file's bytes equal before and after).
    2. `additive at 0.1.0`: add the case-2 operation → exit 0; `api_version.js` equals the D1
       template with `0.2.0` plus its trailing newline, byte for byte (it must stay
       prettier-clean: `format:check` covers `pb_hooks/**/*.js`);
       changelog's first heading `## 0.2.0 - 2026-12-01` with `### Added` listing
       `` `op GET /api/tracker/zz :: exists` ``; `api/openapi.released.json` `info.version`
       `0.2.0`; `check_api_version --root mirror` → exit 0.
    3. `breaking at 0.x`: remove `/api/health`, `--date 2026-12-01` → exit 0, `0.2.0`,
       `### Removed` lists `op GET /api/health :: exists`.
    4. `--major with no change at 0.1.0` (`--date 2026-12-01`) → `1.0.0`, `### Changed`
       `- No structural change since 0.1.0.`; checker exit 0.
    5. `breaking at 1.0.0 without --major`: at 1.0.0, remove `/api/health`, `--date 2026-12-02`
       → exit 1, lists `op GET /api/health :: exists`.
    6. `additive at 1.0.0`: at 1.0.0, add the case-2 operation, `--date 2026-12-02` → exit 0,
       `1.1.0`, `### Added` lists `op GET /api/tracker/zz :: exists`.
    7. `never deprecated`: at 1.0.0, remove `/api/health`, `--major --date 2027-06-01` → exit 1,
       `op GET /api/health :: exists: never deprecated`.
    8. `window`: at 1.0.0, set `deprecated: true` on `GET /api/health`, release `--date
       2027-01-10` → `1.1.0` with `### Deprecated` `` `op GET /api/health :: deprecated` ``;
       then remove `/api/health`: `--major --date 2027-03-01` → exit 1 naming `2027-04-10`;
       `--major --date 2027-04-10` → exit 0, `2.0.0`, `### Removed` lists exactly the facts of the
       fixture's `/api/health` path that `facts()` emits, `op GET /api/health :: deprecated`
       among them (the suite computes the expected list as facts(before) minus facts(after)),
       and there is no `### Changed`.
    9. `forced`: at 1.0.0, remove `/api/health`, `--major --forced-by "PocketBase 0.41.0" --date
       2026-12-02` →
       `2.0.0`, `### Changed` first bullet `- Forced by: PocketBase 0.41.0`.
    10. `--forced-by alone` → exit 2.
    11. `bad --date` (`2027-02-30`) → exit 2, stderr contains `--date wants a real YYYY-MM-DD
        date`; `--forced-by alone` (case 10) stderr contains `--forced-by needs --major`.
    12. `date before the newest release`: `--date 2026-11-09` with the case-2 operation added →
        exit 1, `is before the newest release 0.1.0 (2026-11-10)`.
    Watched failing: the suite run before `release_api.ts` exists fails on case 1.
  - `run_suite` lines directly before the comment line that starts `# ── guard: the repo's real
    pb_migrations/`: `test_api_version_checker`, then `test_release_api`.
- **Gate:** `bun tests/test_api_version_checker.ts`; `bun tests/test_release_api.ts`;
  `bun scripts/check_api_version.ts`; `make check-static`; then add a throwaway operation to a
  scratch copy only (never the tree) as case 2 does, and quote the red output in the PR body.

### Phase 5: policy document and readiness

- **Goal:** the policy is stated for clients and contributors, and SH-4 and SH-5 are met
  (readiness `docs/readiness/README.md` rows SH-4, SH-5).
- **Files:**
  - create `docs/api-versioning.md`
  - modify `docs/README.md`
  - modify `docs/readiness/README.md`
  - modify `AGENTS.md`
- **Steps:**
  - `docs/api-versioning.md` per D13; frontmatter `title: API versioning and deprecation`,
    `status: current`, `version: 1`, `updated: <build date>`. Sections and their content:
    `## Where to read the version` (the contract's Routes table and "`Api-Version` header",
    restated); `## What can change within a version` (the contract's "Compatibility promise",
    restated, the client duty included); `## Deprecation` (the contract's "Deprecation");
    `## The changelog` (`api/CHANGELOG.md`, the D10 format, and that each bullet is a contract
    fact); `## Cutting a release` (D8's command, its flags and refusals, and the duty of D5);
    `## Release 1.0.0` and `## PocketBase upgrades` (D13).
  - `docs/README.md`: a row appended as the last row of the table that holds the `openspec.md`
    row:
    `| [\`api-versioning.md\`](api-versioning.md) | How the API contract is versioned, released and deprecated, and where a client reads the version | Building a client against the API, or changing the contract |`.
  - `docs/readiness/README.md`: SH-4 verdict `met`, evidence ``docs/api-versioning.md`;
    `bun scripts/check_api_version.ts` (check-static) compares the tree's contract with
    `api/openapi.released.json` and `api/mcp-tools.released.json`; `tests/test_api_version_checker.ts`;
    `tests/test_release_api.ts`.``, gap `none`. SH-5 verdict `met`, evidence ``pb_hooks/api_version.pb.js`
    sets `Api-Version` on every response; `tests/test_api_version_header.ts`; `openapi.json`
    `info.version`; `tm --version`.``, gap `none`.
  - `AGENTS.md`, Commands block, as its last line (directly before the closing ```` ``` ````):
    `bun scripts/release_api.ts         # cut an API release; a contract change needs one (docs/api-versioning.md)`.
- **Tests:** none new; documentation only.
- **Gate:** `make check-static`; `make check`; `make smoke` (Docker; `probe_api_version` from
  Phase 2 must pass against the production image).

### Phase 6: the hosted MCP header, only if hosted-mcp-endpoint deferred it

- **Run this phase when** `grep -c API_VERSION services/mcp/src/app.ts` prints `0`, the expected
  case under the build order (hosted D18 defers the header to this change unconditionally and
  leaves the import out). The file exists (Already present 3). A
  non-zero count means the hosted builder added the header anyway: skip the phase and say so in
  the report.
- **Goal:** every hosted MCP response carries `Api-Version` (contract "`Api-Version` header",
  last bullet; spec "The hosted MCP endpoint and the tm client name the contract version").
- **Files:**
  - modify `services/mcp/src/app.ts`
  - modify `tests/test_mcp_service.ts`
  - modify `e2e/smoke.ts`
- **Steps:**
  - `services/mcp/src/app.ts`: add `import { API_VERSION } from
    "../../../clients/tm/src/api.generated.ts";`. In `make_app`, rename the existing `fetch`
    body to an inner `async function handle(req: Request, ip: string): Promise<Response>` (the
    whole D9 pipeline with its 500 `catch`), and make `fetch`:
    ```ts
    async fetch(req: Request, ip: string): Promise<Response> {
      const res = await handle(req, ip);
      const headers = new Headers(res.headers);
      headers.set("Api-Version", API_VERSION);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    ```
    (always a copy: one code path whatever the SDK's `Response` allows). Change the
    `Access-Control-Expose-Headers` value hosted D9 builds, `WWW-Authenticate, Retry-After`, to
    `WWW-Authenticate, Retry-After, Api-Version`.
  - `tests/test_mcp_service.ts`: in `origin_allowed`, the expected `Access-Control-Expose-Headers`
    becomes `WWW-Authenticate, Retry-After, Api-Version` (both responses). Then the hosted design's D18 cases, named as there, inserted
    directly before the `api_down_503` case (which stops the room and must stay last):
    `version_on_200` (write-key `tools/list` → 200, sent with `Origin: https://claude.ai`, and its
    `Access-Control-Expose-Headers` split on `,` and trimmed contains `Api-Version`),
    `version_on_405` (GET `/mcp` → 405), `version_on_401` (POST `/mcp` with no credential → 401),
    `version_on_404` (`GET /nope` → 404): each response's `Api-Version` equals
    `read_api_version(REPO_ROOT)` (import from `../scripts/_api_contract.ts`); and inside the
    existing `api_down_503` case, assert the same of its 503.
  - `e2e/smoke.ts`: new `probe_mcp_api_version()`: `GET /nope` on the MCP base URL the hosted
    probes use (the one `probe_mcp_refusals` fetches from); check `"MCP GET /nope carries
    Api-Version"`, got `[r.status, r.headers.get("api-version")]`, expected `[404,
    read_api_version(ROOT)]`. Insert it in `PROBES` directly before `probe_signup_rate_limit`.
- **Tests:** the five assertions above and the smoke probe, each watched failing before the
  `fetch` change.
- **Gate:** `PB_PORT_OFFSET=<n> bun tests/test_mcp_service.ts`; `make check-static`; `make check`;
  `make smoke`.

## Risks

- **Middleware order changes in a PocketBase upgrade.** -99999 was proven on 0.40.4 only. Caught by
  `tests/test_api_version_header.ts` cases 6 and 18 (key refusal, 429) in the battery and by
  `probe_api_version` in `make smoke`.
- **The fingerprint misses a contract keyword.** An unknown key throws (D7), so the gate goes red
  rather than silent. What the generator never writes (hook validation, error codes in
  prose) stays invisible: the change's spec delta must name it, and the reviewer of the release
  PR reads the changelog section.
- **Conservative classification blocks a safe change after 1.0.0** (for example dropping
  `required` from a request-only field). Escape: `--forced-by` with review; the cost is a major
  release.
- **Concurrent releases.** Two PRs both cut `0.N.0`. The second merge conflicts on
  `pb_hooks/lib/api_version.js` (same line) and `api/CHANGELOG.md` (same insertion point); after a
  rebase the author re-runs `bun scripts/release_api.ts`, and the gate's fact comparison catches a
  hand-merged snapshot that is wrong.
- **Sibling changes do not know the release duty.** Any change built after this one fails
  `make check-static` with the remedy printed; `AGENTS.md` and `docs/api-versioning.md` state it.
- **PocketBase changes a route's behaviour without the generator noticing** (its own routes are
  documented by `scripts/gen_openapi.ts`, not by PocketBase). Caught only by the upgrade duty in
  `docs/api-versioning.md` and the PR review. PocketBase's GitHub repository was reported
  archived with v0.40.6 by the previous wave (unverified here), so the release-notes source may
  move.
- **The spec's deprecation-header requirement has no code or test in this plan** (D12): it is
  met vacuously while nothing is deprecated. The first deprecating change must build and test it.
- **The deprecation `Link` names a GitHub URL** that answers only once the repository is public
  (tm-distribution's ruling). No deprecation exists before then (D12).
- **A `tm` published before this change prints `api 1.0.0`.** tm-distribution's release can
  publish `@hsb3/tm` before this change lands; its line 2 would name the old constant, which is
  no release and sorts above `0.1.0`. Reported to root: hold the first npm publish until this
  change is on `main`, or accept that one published version names `1.0.0`.

## Open Questions

None. Every choice above follows a ruling, prior art or repository convention.

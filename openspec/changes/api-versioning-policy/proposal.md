# Proposal

## Why

A client built outside this repository has no stated rule for what may change under it.
No policy governs API versioning or deprecation (SH-4), and no released contract exists that a
breaking change is measured against: the only contract gate, `bun scripts/gen_openapi.ts
--check`, compares `openapi.json` with the current tree. A client also cannot tell which
contract a server speaks: `openapi.json` carries a constant `version: "1.0.0"` and no response
carries a version header (SH-5). Agent, web and mobile clients all depend on both.

The first clients outside the server's own deploy are the hosted MCP endpoint's users (change
`hosted-mcp-endpoint`) and installed copies of the `tm` client. An installed `tm` is built
against one `openapi.json` (its request types are generated from it into
`clients/tm/src/api.generated.ts` by `scripts/gen_tm_client.ts`), so it keeps speaking that
contract after the server moves on.

What the server offers today (room probe, 2026-11-10, current migrations and hooks, PocketBase
0.40.4; tree paths as cited):

- `info.version` in `openapi.json` is the literal `"1.0.0"` written by `scripts/gen_openapi.ts`;
  it has never changed and no git tag marks a release.
- `openapi.json` documents PocketBase's own collection routes (`/api/collections/...`) beside
  the custom `/api/tracker/...` routes, so the generated contract already spans both.
- No response carries a version. `GET /api/health`, a collection list and a custom
  `/api/tracker/` route each answer with only `Content-Type`, `Content-Length`, `Date`, `Vary`
  and PocketBase's security headers; the health body is `{"message":"API is healthy.",...}`
  with no version field.
- A request version is ignored: `GET /api/health` with `X-Api-Version: 2099-01-01` and a
  vendor `Accept` media type answers 200.
- The server does not serve its contract: `/openapi.json`, `/api/openapi.json` and
  `/api/tracker/openapi.json` answer 404.
- Nothing is marked deprecated: no `deprecated` key in `openapi.json`, no `Deprecation` or
  `Sunset` header in `pb_hooks/`.
- PocketBase is pinned by `ARG PB_VERSION` in `Dockerfile`; a custom header on every response,
  PocketBase's routes included, is possible through the one `routerUse` site in
  `pb_hooks/lib/routes.js`.
- The `tm mcp` server reports a hard-coded `{ name: "tm", version: "0.1.0" }`
  (`clients/tm/src/mcp.ts`), independent of the HTTP contract.

## Prior art

Each source was fetched on 2026-11-10.

- **Linear** (https://linear.app/developers/deprecations.md), the app this one converges on. Its
  GraphQL API "doesn’t have versioning like many REST APIs". It uses "the `@deprecated`
  directive to annotate deprecation warnings in the schema", lists API changes on its
  changelog with an `[API]` prefix, promises "plenty of time to make changes" with no stated
  period, and will "proactively reach out to developers" for noticeable breaks. A removed field
  can stay as a non-functioning stub so existing queries keep parsing. Its MCP server
  (https://linear.app/docs/mcp) states no version policy; its only deprecation is the SSE
  transport, "a deprecated fallback". The changelog page itself was not fetched (unverified).
- **Stripe** (https://docs.stripe.com/api/versioning, https://docs.stripe.com/upgrades). Versions
  are dates plus a release name ("The current version is 2026-10-28.endive"). A request pins one
  with the `Stripe-Version` header, else the account default applies. Since 2024-09-30 "we
  release new API versions monthly with no breaking changes", and "twice a year" a named major
  release carries the breaking changes. A webhook endpoint can pin its own version when it is created.
  Stripe's list of backwards-compatible changes was not found on the live page (unverified).
- **GitHub REST** (https://docs.github.com/en/rest/about-the-rest-api/api-versions). A request
  pins a date version in `X-GitHub-Api-Version`; without it, 2022-11-28 applies. "API versions
  are supported for 24 months after a newer API version is released", and an unsupported
  version answers 410 Gone; a retired version is announced with a `Sunset` header per RFC 8594.
  Two versions are served now: 2026-03-10, and 2022-11-28 until March 10, 2028. Breaking
  changes ship only in a new version: "Removing an entire operation", "Removing or renaming a
  parameter", "Removing or renaming a response field", "Adding a new required parameter",
  "Making a previously optional parameter required", "Changing the type of a parameter or
  response field", "Removing enum values", "Adding a new validation rule to an existing
  parameter", "Changing authentication or authorization requirements". Additive changes reach
  every supported version. Each version's breaking changes are listed at
  https://docs.github.com/en/rest/about-the-rest-api/breaking-changes.
- **MCP**, current revision 2026-07-28 (https://modelcontextprotocol.io/specification/versioning,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning). Versions are dates,
  and the version "will *not* be incremented" while changes stay backwards compatible.
  Deprecated features stay "for at least twelve months, or at least ninety days" under an
  expedited exception. The 2026-07-28 revision has "no negotiation handshake. Every request
  carries its protocol version": over HTTP in the `MCP-Protocol-Version` header, and an
  unsupported version gets an error "listing the versions it does support". This governs the
  protocol, which the MCP SDK handles; it says nothing about a server's own tool catalog.
- **HTTP deprecation headers.** `Deprecation` (RFC 9745,
  https://www.rfc-editor.org/rfc/rfc9745.html) carries a structured date such as
  `Deprecation: @1688169599`, with a `Link` of `rel="deprecation"` to human-readable notes.
  `Sunset` (RFC 8594, https://www.rfc-editor.org/rfc/rfc8594.html) carries an HTTP-date; RFC
  9745 adds that its timestamp "MUST NOT be earlier than the one given in the Deprecation header
  field".
- **PocketBase** (https://github.com/pocketbase/pocketbase). "full backward compatibility is not
  guaranteed before reaching v1.0.0." Its v0.40.0 changelog entry flags "a slight breaking
  change" (a CLI exit status). That v0.23.0 changed Web API routes and the error body shape was
  read from a truncated fetch of the older changelog file and is unverified.

Taken together: Linear, the closest product, keeps one evolving contract and deprecates in
place; Stripe and GitHub let a client pin a dated version and keep old versions served; MCP
dates its protocol and keeps deprecated features a fixed minimum time. Only a pinned-version
scheme needs the server to keep answering in old shapes, and none of the pinned schemes can
reach routes the server does not own.

## What Changes

- A written policy states how the API contract is versioned, what counts as a breaking change,
  and how a route or field is deprecated and then removed.
- A released contract is recorded, and a change to the contract is checked against it, so a
  breaking change is caught before it ships rather than after.
- A server states on the wire which contract version it speaks.

## Capabilities

- `api-versioning`: the versioning and deprecation policy, and the version signal a client
  reads.

## Settled without a ruling

- The contract version is a semantic version in `openapi.json`'s `info.version`, starting from
  the first release; the major part moves only when a breaking change ships after its
  deprecation window. The `tm` package version stays separate.
- The version a response carries goes in a header without the `X-` prefix (RFC 6648), for
  example `Api-Version: 1.2.0`, set on every response, PocketBase's own routes included.
- Clients are told to ignore unknown response fields and unknown enum values; adding either is
  never breaking.
- The release gate compares structure (routes, parameters, fields, types, statuses, error codes
  as documented); a behaviour change it cannot see, such as tighter validation on an existing
  field, is caught by the change's spec delta, which names the class from Open Question 3.

## Open Questions

Ordered by consequence; each option list puts the recommended one first.

1. **Versioning model.** Options: (a, recommended) one evolving contract as Linear does: no
   client-pinned versions, additive changes freely, breaking changes only through
   deprecate-then-remove, and the server announces its contract version in a response header
   (SH-5); (b) client-pinned date versions in a request header, as Stripe and GitHub do: the
   strongest guarantee, but every breaking change needs a hook that still answers in the old
   shape, and PocketBase's own routes cannot be pinned at all; (c) a path prefix such as
   `/api/tracker/v2/`: reaches only the custom routes, and doubles the route table on each
   break. The first outside clients are the hosted MCP service and the `tm` client, both built
   from this repository and able to follow a change within one release, so (b)'s cost buys
   little.
2. **PocketBase's own routes.** Collection CRUD, auth, files and realtime change with the pinned
   PocketBase version, which is pre-1.0 and promises no backward compatibility. Options: (a,
   recommended) covered: the contract is `openapi.json`, which already documents them, and a
   PocketBase upgrade is a contract change gated like any other; a break PocketBase forces is
   either held (stay on the old version through the deprecation window) or ships as a major
   bump with notice; (b) excluded: the policy covers `/api/tracker/...` only and clients follow
   PocketBase's changelog, which leaves the routes agents use most without a guarantee; (c)
   wrapped: every client call moves behind `/api/tracker/...` routes the server owns, a large
   build that hides PocketBase entirely.
3. **What counts as breaking.** Options: (a, recommended) GitHub's list (which already covers
   removed or renamed routes, parameters and fields, new required or newly required parameters,
   type changes, removed enum values, new validation on an existing parameter, and changed
   authorization) plus changing a status code or an error `code` and changing a default (page
   size, sort order). Adding routes, optional parameters, response fields and enum values is
   not breaking; error message text never is (it is copy, not contract); (b) structure only:
   what the gate can diff (removed or renamed routes, fields, parameters, types), with
   validation, statuses and defaults left free;
   (c) any change to `openapi.json` other than an addition.
4. **Deprecation notice and window.** Signals in every option: `deprecated: true` on the route,
   parameter or field in `openapi.json`, a changelog entry, and on a deprecated route the
   `Deprecation`, `Sunset` and `Link rel="deprecation"` headers (a deprecated field has no
   per-field header; the contract and changelog carry it). Options for the minimum time a
   deprecated item stays served: (a, recommended) 90 days, MCP's expedited floor: the outside
   users are agents on the hosted endpoint, whose server-side catalog moves with the server, and
   installed `tm` copies, which a 90-day window gives a full upgrade cycle; (b) 12 months, MCP's default; (c) no fixed period, as Linear:
   notice plus direct contact, and judgment per change.
5. **The MCP tool catalog.** Agents call tools by name, and hosts save those names (a Claude
   Code permission rule names `mcp__<server>__<tool>`). Options: (a, recommended) covered by the
   same rules: a tool's name, its input schema's required parameters and their types are
   contract; descriptions and annotations are not; (b) excluded: `tools/list` is
   self-describing and a model re-reads it each session; saved permission rules and scripts
   break silently.
6. **When the policy binds.** The server is UAT only and no outside client exists yet. Options:
   (a, recommended) at the first deploy of the hosted MCP endpoint to outside users: that
   deploy is release 1.0.0, and until then the contract changes freely with a changelog entry;
   (b) now, so the milestone's own changes rehearse it, at the cost of windows on routes no one
   outside uses; (c) at a later public release.
7. **Where the released contract lives.** Options: (a, recommended) a committed snapshot of
   `openapi.json` beside a changelog in the repository: a release is a reviewed commit that
   copies the snapshot, bumps `info.version` and adds the changelog entry, and the gate diffs
   the tree's `openapi.json` against the snapshot offline; (b) a git tag on `main`, with the
   gate reading `openapi.json` at the latest release tag: no copy in the tree, but CI checkouts
   must fetch tags and the gate must fail loudly when it finds no tag; (c) a GitHub Release
   asset: outside the repository and needs the network in the gate.

# Proposal

## Why

A client built outside this repository has no stated rule for what may change under it.
No policy governs API versioning or deprecation (SH-4), and no released contract exists that a
breaking change is measured against: the only contract gate, `bun scripts/gen_openapi.ts
--check`, compares `openapi.json` with the current tree. A client also cannot tell which
contract a server speaks: `openapi.json` carries a constant `version: "1.0.0"` and no response
carries a version header (SH-5). Agent, web and mobile clients all depend on both.

## What Changes

- A written policy states how the API contract is versioned, what counts as a breaking change,
  and how a route or field is deprecated and then removed.
- A released contract is recorded, and a change to the contract is checked against it, so a
  breaking change is caught before it ships rather than after.
- A server states on the wire which contract version it speaks.

## Capabilities

- `api-versioning`: the versioning and deprecation policy, and the version signal a client
  reads.

## Open Questions

- Where the version lives: the path, a request header, a response header, or a date-based
  version a client pins. Linear's public API is the prior art to study before choosing.
- What counts as breaking: removing or renaming a field, tightening validation, changing an
  error status or code, changing a default page size.
- Deprecation: how a client learns a route or field is deprecated, and how long it stays served.
- PocketBase's own routes (`/api/collections/...`, auth, files, realtime) change with the pinned
  PocketBase version, not with this repository's code: whether the policy covers them, and how
  a PocketBase upgrade is versioned.
- Where the released contract is stored and what marks a release, given the server is not yet
  publicly released.

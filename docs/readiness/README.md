---
title: Readiness
status: current
version: 1
updated: 2026-11-10
---

# Readiness

What must be true for this backend to serve a given kind of client, and the measured gap
against each criterion. These pages choose no design: a later design or change cites the
criterion ids it moves.

## Targets

| file | target |
| --- | --- |
| [`agent-clients.md`](agent-clients.md) | The operator's own coding agents, including web-hosted agents with no local process, use the deployed server through an authenticated CLI or MCP. |
| [`web-frontend.md`](web-frontend.md) | An outside team designs and builds a web app against this backend without the backend authors in the room. |
| [`mobile-frontend.md`](mobile-frontend.md) | The same for a native iOS or Android app. Lists only what mobile needs beyond the web page. |

## Verdicts

- **met**: the statement holds in the current tree, with the evidence named.
- **partly**: some of the statement holds; the gap names what is absent.
- **missing**: the statement does not hold.

A fact not yet settled gets no verdict; it sits under the page's "Unverified" heading with
the reason. A gap states what is absent, never how to fill it.

## Criterion ids

Each criterion has a stable id: `AC-n` (agent clients), `WEB-n` (web), `MOB-n` (mobile) and
`SH-n` (shared, defined once in the table below and referenced by id from each target page).
An id is never renumbered or reused: a retired criterion keeps its id and is marked retired.
Room probes cited as evidence were observed in a clean room booted from the current migration
set (`AGENTS.md`, Clean-room law); repeating the request in such a room reproduces them.

## Shared criteria

| id | criterion | applies to | verdict | evidence | gap |
| --- | --- | --- | --- | --- | --- |
| SH-1 | The published API contract describes every route a client calls, including sign-in by one-time code, auth-method discovery, email change, file download and realtime. | AC, WEB, MOB | partly | `jq -r '.paths\|keys[]' openapi.json \| grep -E 'otp\|email-change\|auth-methods\|^/api/files\|realtime'` prints nothing (exit 1). | PocketBase's own OTP, auth-methods, email-change, file and realtime routes are absent from the contract. |
| SH-2 | Every error answer carries a stable machine-readable code. | AC, WEB, MOB | partly | The body shape `{data, message, status}` is uniform (`tests/test_route_errors.ts`). API-key refusals carry `data.api_key.code` (`pb_hooks/api_keys.pb.js` `api_key_path`, `api_key_scope`). Room probe: `GET /api/collections/workspaces/records?filter=nosuch=1` answers 400 `{"data":{},"message":"Something went wrong while processing your request.","status":400}`; a custom route called without its workspace answers 400 "Workspace query param required." with no code. | Query errors and custom-route errors carry no code; no document lists the codes that exist. |
| SH-3 | Every operation in the contract declares the error statuses it can return. | AC, WEB, MOB | partly | Custom routes declare theirs (`pb_hooks/lib/routes.js` `responses`, provoked live by `tests/test_route_errors.ts`). `jq '[.paths\|to_entries[]\|select(.key\|startswith("/api/collections"))\|.value[]\|select(type=="object")\|select(.responses//{}\|keys\|map(test("^4"))\|any)]\|length' openapi.json` prints 0. | No `/api/collections` operation declares an error status. |
| SH-4 | A stated policy governs API versioning and deprecation. | AC, WEB, MOB | missing | No such policy in `docs/` or `README.md`; the only contract gate is `bun scripts/gen_openapi.ts --check`, which compares against the current tree, not a released contract. | No policy; no released contract that a breaking change is measured against. |
| SH-5 | A client can read, on the wire, which contract version a server speaks. | AC, WEB, MOB | missing | `scripts/gen_openapi.ts` writes `version: "1.0.0"` as a constant; no response carries a version header. | No version signal on the wire. |
| SH-6 | Rate limiting is keyed to an identity a client cannot forge. | AC, WEB, MOB | partly | Every rule in `v2:1785185100_settings.js` `rateLimits.rules` has `audience: ""` and counts per client IP; `trustedProxy` reads the rightmost `X-Real-IP` (decision:rate-limit-counts-x-real-ip). `tests/test_agent_probe.ts` check "same token + route, client-set X-Forwarded-For after the 429" answers 429. `e2e/README.md` "Rate limits". | No limit keyed to a user or key. Whether the deployed proxy replaces a client-sent `X-Real-IP` is unverified. Clients behind one egress IP (hosted agents, carrier NAT) share one budget. |
| SH-7 | A 429 tells the client when to retry. | AC, WEB, MOB | missing | `tests/test_agent_probe.ts` check "429 rate headers (Retry-After / X-RateLimit-*)" finds none. | No retry timing in the 429 headers or body. |
| SH-8 | Every credential's lifetime and every event that ends it are stated in a client-facing document. | AC, WEB, MOB | partly | API keys: decision:api-keys states expiry, revocation and survival across a password change. User tokens: lifetime only in `v2:1785185200_collections.js` users `authToken.duration`. Room probe: `POST /api/collections/users/auth-logout` answers 404; after a password change the old token answers 401 on `GET /api/tracker/me` but 200 with empty `items` on `GET /api/collections/workspaces/records` (treated as a guest). | No client-facing statement of user-token lifetime, refresh, the absence of server-side sign-out, or the guest answer on collection lists. |
| SH-9 | An outside party can sign up and exercise every flow, mail and OAuth included, on a running server without a repo checkout. | WEB, MOB | missing | `e2e/README.md` "Seed a room" needs a clone and a hand-booted room; `pb_hooks/mail.pb.js` leaves SMTP off without `RESEND_API_KEY`; `pb_hooks/oauth.pb.js` enables a provider only when its env pair is set (decision:oauth-providers-from-env). | No running non-production server open to an outside party; no source of test accounts. |
| SH-10 | No known blocker stands between the server and a public release. | WEB, MOB | missing | `README.md`: "It is not publicly released and has no real users yet." | The scale cap or data-architecture fix required before any public release is open on the board. |

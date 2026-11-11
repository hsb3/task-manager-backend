---
title: Readiness for agent clients
status: current
version: 1
updated: 2026-11-10
---

# Readiness: agent clients

**Target.** A single operator's coding agents use the deployed server as their task tracker
through an authenticated CLI or MCP server. That includes web-hosted agents that run no local
process: such an agent can only make network calls to a URL, so whatever it uses must be
reachable over the public internet and authenticate on every request.

**Shared criteria.** SH-1 to SH-8 apply (see [`README.md`](README.md#shared-criteria)).
Under SH-6, hosted agents leaving through one provider's egress IP share one budget.

## Criteria

**AC-1** Each agent can hold its own credential that is stored only as a hash, scoped read or
write, expirable and revocable, and a revoked or expired one is refused on its next request.
- Verdict: met.
- Evidence: `schema/api_keys.json` fields `key_hash` (hidden), `scope`, `expires`, `revoked`;
  `pb_hooks/api_keys.pb.js` mints `"tmk_" + $security.randomString(40)` and refuses an invalid
  key with `api_key_invalid`; `tests/test_api_keys.ts`; decision:api-keys.
- Gap: none.

**AC-2** A key cannot reach operator-only surfaces or read other keys.
- Verdict: met.
- Evidence: `pb_hooks/api_keys.pb.js` allowlist (`/api/files/`, `/api/realtime`, `/api/tracker/`
  except `/api/tracker/admin/`; collections other than system ones and `api_keys`) answering 403
  `api_key_path`; decision:api-key-reads-refused.
- Gap: none.

**AC-3** A key can be limited to a workspace or project.
- Verdict: missing.
- Evidence: `schema/api_keys.json` has no workspace or project field.
- Gap: no key scope narrower than every workspace its user reaches.

**AC-4** A write key can be denied destructive and ownership routes while keeping its other
writes.
- Verdict: missing.
- Evidence: decision:api-keys accepts that write keys reach every non-admin tracker route, which
  includes `POST /api/tracker/workspaces/{id}/transfer-ownership` (`pb_hooks/lib/routes.js`).
- Gap: no key setting below full write.

**AC-5** Revoking a key ends that key's open realtime stream.
- Verdict: missing.
- Evidence: `tests/test_api_keys.ts` check "a stream opened before the revoke still delivers
  (accepted limit, pinned)"; decision:api-keys.
- Gap: an open stream outlives its key's revocation.

**AC-6** An agent with no local process can reach the tracker over MCP.
- Verdict: missing.
- Evidence: `clients/tm/src/mcp.ts` connects only `StdioServerTransport`. The MCP
  specification defines two standard transports, stdio and Streamable HTTP ("Transports",
  https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). A Claude custom
  connector "must be reachable over the public internet from Anthropic's IP ranges" ("Getting
  started with custom connectors using remote MCP",
  https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).
- Gap: no network-reachable MCP endpoint.

**AC-7** A remote MCP endpoint authenticates in a way hosted MCP clients support.
- Verdict: missing.
- Evidence: no remote endpoint exists (AC-6). The MCP "Authorization" page
  (https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) makes
  authorization optional for HTTP transports but, when present, requires OAuth 2.1 with
  Protected Resource Metadata (RFC 9728) and forbids tokens in the query string. The Claude
  connector page above lists OAuth, or "No sign in" with request headers carrying fixed
  credentials such as API keys.
- Gap: no stated authentication scheme for a remote endpoint.

**AC-8** The CLI runs on a machine that has no checkout of this repository.
- Verdict: partly.
- Evidence: `clients/tm/package.json` is `"private": true`; `clients/tm/tm.ts` starts
  `#!/usr/bin/env bun` and reads `Bun.stdin`. A copy of `clients/tm/` alone (`tm.ts`,
  `package.json`, `src/`) ran under bun and installed the MCP SDK on first use.
- Gap: no published package; no runtime but bun.

**AC-9** The operator can mint, list and revoke keys through a documented client command,
without hand-written HTTP.
- Verdict: partly.
- Evidence: `README.md` "What a client does" mints with `curl` against
  `/api/collections/api_keys/records` using a password session; `clients/tm/tm.ts` verbs are
  `login`, `list`, `show`, `search`, `create`, `edit`, `comment`, `mcp`. A key cannot mint a
  key (403 `api_key_path`, AC-2). Minting needs a verified, approved user
  (decision:signup-approval, decision:verified-login), so the first key needs a person at a
  mailbox.
- Gap: no client command for mint, list or revoke.

**AC-10** The CLI and MCP tools cover an agent's whole work loop, not only items and comments.
- Verdict: partly.
- Evidence: `clients/tm/src/mcp.ts` tools `tm_list`, `tm_show`, `tm_search`, `tm_create`,
  `tm_edit`, `tm_comment`; the CLI verbs match (AC-9).
- Gap: no client coverage of trash and restore, projects, labels, statuses, cycles,
  notifications, subscriptions, saved views or workspace listing.

**AC-11** An agent holding only the server URL and a key can retrieve a machine-readable
description of the API.
- Verdict: partly.
- Evidence: `schema/app_docs.rules.json` `listRule: ""` (collection prose readable
  anonymously); `GET /api/tracker/me` answers a key with its workspaces and role
  (decision:me-route). Room probe: `/openapi.json`, `/api/openapi.json`, `/api/docs` answer
  404 anonymously and 403 `api_key_path` with a key; `Dockerfile` copies only `pb_migrations`
  and `pb_hooks`.
- Gap: the deployed server does not serve the API contract.

**AC-12** Under a key, a request to a route that does not exist is distinguishable from a
forbidden one.
- Verdict: met.
- Evidence: `pb_hooks/api_keys.pb.js` answers 404 for an unmatched route or a missing collection
  under a key; `tests/test_api_keys.ts` cases `key_unknown_path_404`,
  `key_unknown_collection_404`, `key_closed_route_403`.
- Gap: none.

**AC-13** An MCP tool failure returns the server's status and error code in structured form.
- Verdict: missing.
- Evidence: `clients/tm/src/mcp.ts` `text(t, isError)` returns plain text with `isError`.
- Gap: no structured status or code.

**AC-14** A failure of the deployed server reaches the operator without anyone watching.
- Verdict: partly.
- Evidence: `pb_hooks/alerts.pb.js` mails an error-rate alert when `ALERT_EMAIL` is set (its
  header: "all optional except ALERT_EMAIL") and states that a dead process sends no mail,
  leaving process-down to the platform healthcheck's restart
  (decision:error-rate-alerting-and-relation-indexes). `deploy/README.md` "When a pocketbase
  deploy fails": the deploy-failure notification rule is created by hand and is not in
  `deploy/railway/railway.ts`.
- Gap: no alert for a process that stays down; both alerts exist only where set by hand.

**AC-15** Superuser access survives the loss of any single mailbox.
- Verdict: missing.
- Evidence: `deploy/README.md` "Superuser login is MFA-gated and owner-assisted": "A
  superuser address that cannot RECEIVE its own OTP is a permanent lockout."
- Gap: no second recovery path.

## Unverified

- Rate limiting as seen from a hosted agent's egress: not probed against the deployed server.
- A restore from backup on the deployed server: `deploy/README.md` documents the procedure; no
  rehearsal against the deployed instance is on record.
- What Claude custom connectors require of a server beyond reachability and authentication:
  "Building custom connectors via remote MCP servers"
  (https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)
  answers 404.
- MCP tool behaviour beyond what `tests/test_tm_mcp.ts` asserts.

## Out of scope

- Agents of anyone but the operator, and multi-tenant key management.
- Clients other than agents (web and mobile have their own pages).

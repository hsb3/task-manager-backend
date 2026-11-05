---
name: schema-derived-openapi-pattern
description: "When a backend lacks OpenAPI export, generate openapi.json from the schema source of truth — deterministic script + --check drift gate, proof-gated by consumer typegen"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 300bf302-5098-4bb5-b223-a125ad05a3d1
  modified: 2026-08-14T11:38:06.597Z
---

Henry endorsed this as a pattern to reuse in future projects (2026-07-27, learn-pocketbase (now task-manager)):
when a backend has a schema source of truth but no OpenAPI export (PocketBase, or any
schema-first system), build a repo-local deterministic generator (stdlib, no deps) that
derives a committed `openapi.json` from that source, instead of hand-writing the spec or
adopting an immature community converter.

**Why:** the spec can never silently drift from the schema (a `--check` mode exits
non-zero on staleness, wired like any other generated-artifact gate); consumers can generate
types from it; and the generator doubles as an equivalence proof — regenerating
before and after a schema refactor must be byte-identical if the model is unchanged.

**How to apply:**
- Generator derives from the real source of truth (migrations replay / live schema read),
  not from docs; byte-stable output (sorted keys, no timestamps) so `--check` is a diff.
- Reference implementation: `scripts/gen_openapi.ts` (`--check` is the drift gate;
  same convention as `gen_decisions.ts`).
- Same shape works for any derived artifact: generate from truth, commit, drift-gate.

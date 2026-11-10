---
title: Design changes (OpenSpec)
status: current
version: 1
updated: 2026-11-10
---

# Design changes (OpenSpec)

A change to what a client sees is designed in OpenSpec before it is built. The kata board stays
the only task system: OpenSpec holds the design, kata holds the work.

## Where things live

| what | where |
| --- | --- |
| Current requirements, per capability | `openspec/specs/<capability>/spec.md` |
| Changes in progress | `openspec/changes/<change-id>/` |
| Archived changes | `openspec/changes/archive/YYYY-MM-DD-<change-id>/` |
| The change schema, `contract-first` (the project default) | `openspec/schemas/contract-first/` |
| Readiness criteria a change moves | [`readiness/`](readiness/README.md), by id (`AC-n`, `WEB-n`, `MOB-n`, `SH-n`) |

A change's artifacts, each requiring the one before: `proposal.md` (why and what), spec deltas
under `specs/` (observable behaviour), `contract.md` (routes, request and response shapes,
error codes, auth, compatibility) and `design.md` (how the contract is met). There is no tasks
artifact. Its `.openspec.yaml` lists under `x-criteria:` the readiness criterion ids it moves.

## Lifecycle

1. **Propose.** `bunx --bun openspec new change <change-id>`, then write `proposal.md` and
   `x-criteria`. A change may be committed with only its earlier artifacts.
2. **Approve.** The proposal, deltas, contract and design are reviewed and accepted.
3. **Implement.** Each kata card doing the work carries the change id as metadata:
   `kata create ... --meta change=<change-id>`. Before closing such a card, `make change
   ID=<change-id>` confirms the change exists, active or archived.
4. **Archive** once every card carrying the id is closed: `bunx --bun openspec archive <change-id>`
   merges the deltas into `openspec/specs/` and moves the change under `archive/`.

The link is one way: a card names its change; a change never lists cards.

## Gates

`scripts/check_openspec.ts` runs in `make check-static`. It fails when:

- `openspec validate --all --strict` reports a problem; a change with no spec deltas yet is in
  progress, not invalid;
- a change holds an artifact before one it requires (a design with no contract;
  `skip_specs: true` counts specs as present);
- a change uses a schema not under `openspec/schemas/`, or its directory name is not a
  lowercase change id;
- an active change's `.openspec.yaml` is missing or unreadable, or its `x-criteria` is missing,
  empty, or names an id not defined in `docs/readiness/`.

The Makefile turns off the CLI's telemetry and update check (`OPENSPEC_TELEMETRY=0`,
`OPENSPEC_NO_UPDATE_CHECK=1`); set both when running `bunx --bun openspec` by hand.

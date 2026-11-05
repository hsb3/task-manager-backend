---
title: docs/
status: current
version: 12
updated: 2026-11-05
---

# docs/

What each file is, who it is for, and, critically, **which files are generated**. A
generated file is never edited by hand: change its source and regenerate, or a gate will
fail on the drift. The directory is split by provenance:

- `docs/` root: hand-written reference that outlives a task
- `docs/generated/`: **every machine-written doc, and nothing else**

## Hand-written

| file | what it is | read it when |
| --- | --- | --- |
| [`deploy/README.md`](../deploy/README.md) | Deploy and infra recipes | Touching Railway, backups, or mail |
| [`self-documenting-app.md`](self-documenting-app.md) | How the `app_docs` convention works: the app describes its own collections | Adding or changing a collection |
| [`constants.md`](constants.md) | Values duplicated across hooks, scripts and tests, and the guard that keeps them in step | Changing a shared vocabulary |
| [`design-patterns.md`](design-patterns.md) | The framework-agnostic patterns this app instantiates, each citing the decision record or repo law that settled it | Carrying a rule proved here into another project, or arguing a design choice |

## Generated: do not edit

Each carries a DO-NOT-EDIT header naming its regenerator. All are drift-gated, so editing
one by hand fails the build rather than silently diverging.

| file | generated from | regenerate with |
| --- | --- | --- |
| [`generated/decisions.md`](generated/decisions.md) | the `decision:*` `app_docs` seed records | `bun scripts/gen_decisions.ts` |

Generated artifacts outside this directory follow the same rule: `openapi.json` (`gen_openapi.ts`),
`schema/` (`gen_schema.ts`), and `scripts/model/current/` (the model tree).

`make openapi` regenerates decisions and openapi together.

## Frontmatter

Every hand-written `.md` in `docs/` opens with a YAML block with exactly the keys `title`,
`status` (`current`, `draft` or `superseded`), `version` (an integer, up by one on a content
edit) and `updated` (the ISO `YYYY-MM-DD` date of that edit). Nothing checks that
`status: current` is still true; that a page hasn't quietly gone stale is the author's claim.

## Assets

`assets/` holds the architecture diagram (`overview.dot` to `overview.svg`).

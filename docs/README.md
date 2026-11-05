---
title: docs/
status: current
version: 11
updated: 2026-10-24
---

# docs/

What each file is, who it is for, and — critically — **which files are generated**. A
generated file is never edited by hand: change its source and regenerate, or a gate will
fail on the drift. The directory is split by provenance:

- `docs/` root — hand-written reference that outlives a board card
- `docs/readouts/` — hand-authored status readouts and their sources (the feature
  register's `features.yml`, the dated release snapshot)
- `docs/generated/` — **every machine-written doc, and nothing else**; the split is a gate
  (`check_doc_frontmatter.ts`), not a convention: a marker file outside this directory or
  an unmarked file inside it fails the build

The board (kata project `task-manager`; historical `PBTT-NNN` refs resolve via `kata list --meta kaneo_task_number=NNN`) holds tasks, decisions and planning. This directory holds
reference material that outlives a card.

## Hand-written

| file | what it is | read it when |
| --- | --- | --- |
| [`deploy/README.md`](../deploy/README.md) | Deploy and infra recipes | Touching Railway, backups, or mail |
| [`self-documenting-app.md`](self-documenting-app.md) | How the `app_docs` convention works — the app describes its own collections | Adding or changing a collection |
| [`constants.md`](constants.md) | Values duplicated across the backend and frontend, and the guard that keeps them in step | Changing a shared vocabulary |
| [`design-patterns.md`](design-patterns.md) | The framework-agnostic patterns this app instantiates, each citing the decision record or repo law that settled it | Carrying a rule proved here into another project, or arguing a design choice |
| [`readouts/release-1.body.html`](readouts/release-1.body.html) | Dated narrative: what Release 1 delivers, how it compares to Linear and Plane, and where this app sits in the wider estate. **Hand-authored — no gate keeps the prose true**, so re-date it when you revise it (the counts it references are machine-owned) | Deciding what to build next, or explaining the app to someone |
| [`readouts/features.yml`](readouts/features.yml) | **Source of truth** for the feature register — one entry per feature: `id`, `status`, `evidence`, optional `depends_on` | Recording that a feature shipped, or filing against a gap |
| [`readouts/closure.yml`](readouts/closure.yml) | Closure disposition per unbuilt row, joined on `id` | Recording a plan for a gap, or a re-validation verdict |
| [`readouts/status.template.html`](readouts/status.template.html) | Page structure/CSS the status render slots into | Changing the status page's layout or styling |

No design packet lives here. The v1 packet, and the divergence record that tracked where the
build departed from it, are frozen at the git tag `design-v1-vendored` — read any of it with
`git show design-v1-vendored:design/<file>`. It is history, not a constraint: the app is the
constraint, and a rule worth enforcing lives in a decision record or a gate.

## Generated — do not edit

Each carries a DO-NOT-EDIT header naming its regenerator. All are drift-gated, so editing
one by hand fails the build rather than silently diverging.

| file | generated from | regenerate with |
| --- | --- | --- |
| [`generated/feature-register.md`](generated/feature-register.md) | `docs/readouts/features.yml` | `bun scripts/gen_feature_register.ts` |
| [`generated/status.html`](generated/status.html) | `docs/readouts/features.yml` + `docs/readouts/closure.yml` + the narrative source (`readouts/release-1.body.html`) + the page shell (`readouts/status.template.html`) — the status map, the row table joined to the closure plan, and the release narrative, one page | `bun scripts/gen_status.ts` |
| [`generated/decisions.md`](generated/decisions.md) | the `decision:*` `app_docs` seed migrations | `bun scripts/gen_decisions.ts` |
| [`generated/coverage.md`](generated/coverage.md) | the capability/test map | `bun scripts/gen_coverage.ts` |
| [`generated/component-map.json`](generated/component-map.json) · `component-map.html` | the `web/` tree, against `web/scripts/component-map.planned.json` | `cd web && npm run componentmap` |

Generated artifacts outside this directory follow the same rule: `openapi.json` (`gen_openapi.ts`),
`schema/` (`gen_schema.ts`), and `scripts/model/current/` (the model tree).

`make openapi` regenerates the register, decisions and openapi together.

## Frontmatter

Every hand-written `.md` in `docs/` opens with a YAML block.
`bun scripts/check_doc_frontmatter.ts` enforces its **shape**: exactly the keys `title`,
`status`, `version`, `updated` and no others; `status` one of `current`, `draft`,
`superseded`; `version` an integer ≥ 1; `updated` a real ISO `YYYY-MM-DD` date. A new `.md`
arriving in the directory without a block fails the gate.

The gate also checks two things beyond shape: the `title` must match the page's own visible
heading, and whenever a doc's content changes, `version` must go up and `updated` must move
too — the gate compares each doc against its own last saved version to catch a content edit
that forgot to touch either one. The one thing no gate can check is whether `status: current`
is still true — that a page hasn't quietly gone stale is the author's own claim, not a
verified fact; see the advisory notes the checker prints on every run for the reasoning.

A file whose opening HTML comment declares `GENERATED FILE` is detected and excluded, so a new
generated doc needs no edit to the checker. Carrying both that marker and a frontmatter block
fails: the next regen would delete the block.

No hand-written doc is `superseded` today; the status stays in the vocabulary for a page
whose subject has moved but whose readers have not yet followed it.

## Assets

`assets/` holds the architecture diagram (`overview.dot` → `overview.svg`) and screenshots
referenced from the docs above.

## The register's status vocabulary

`feature-register.md` is the map of what exists. Its statuses are a closed set, enforced by
the generator: `shipped`, `partial`, `planned`, `missing`, `rejected`. `shipped` and
`partial` never rest on intent — a design document promising a feature is not evidence it
exists.

Treat the register as a claim, not a proof: an evidence cell is true as of the commit it
names, and a grep-negative cell (nothing matches) proves only what that grep searched. Re-run
the cell before relying on it.

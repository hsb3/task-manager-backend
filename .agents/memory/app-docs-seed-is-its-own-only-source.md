---
name: app-docs-seed-is-its-own-only-source
description: "The generated app_docs seed migration is the only source of app_docs rows, so every replay-based gate compares the file against itself and cannot see a hand-edited value"
metadata:
  node_type: memory
  type: project
---

# The app_docs seed migration is the corpus's only source, so every replay gate is self-fulfilling

Measured 2026-09-21 on card `et4s`. Replaying `pb_migrations/` with the generated app_docs seed
migration removed yields **zero** `app_docs` rows: since the baseline collapse, that one file
creates the whole corpus. Every gate that reads app_docs from a replay therefore compares the
file against itself.

Consequence, verified by changing one character of a body sentence in a scratch tree and running
each gate: `check_app_docs.ts`, `check_app_docs_history.ts`, `check_app_docs_quotes.ts`,
`check_app_docs_down_up.ts`, `gen_schema --check` and `gen_openapi --check` **all stayed green**.
A one-byte hand-edit to seeded prose is invisible to the entire battery.

`check_app_docs_history.ts` is the gate that looks like it covers this and does not: it asserts
no prose SEEDED BY ONE MIGRATION vanishes in a LATER one. With a single seeding migration there
is no later migration, so it has nothing to compare and passes by construction.

**How to apply:** never claim a replay-based gate protects app_docs prose. `gen_app_docs_seed.ts
--check` is generator PARITY only — it catches a row some other migration seeds that was never
regenerated into the file, a hand-reordering (rows render in slug order), a changed field set,
and template or escaping drift. It cannot catch a value edit, and its docstring says so. Real
prose protection needs a source outside the file (a pinned span registry with its own committed
copy, or review of the diff), not another replay.

Related: [[app-docs-quotes-apostrophe-tokenizer]], [[proofs-must-be-falsifiable]].

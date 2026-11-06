# scripts/model — the extracted entity model

`current/*.yml` is one GENERATED file per app collection: scope, ownership, capabilities and
relations as the migrations define them, in the facet schema `SCHEMA.md` specifies. It is live
and gated, not a leftover: `extract_current.ts` replays `pb_migrations/` into a throwaway
PocketBase and reads `_collections`, the same mechanic as `scripts/check_app_docs.ts`.

**Gate.** `make check-static` runs `bun scripts/model/extract_current.ts --check`, which writes
nothing and exits 1 when `current/` drifts from the migrations; `make check` and CI run it.

**Regenerate** after any migration change, in the same commit:

```bash
bun scripts/model/extract_current.ts          # rewrites current/<entity>.yml
bun scripts/model/extract_current.ts --check  # proves it is current (what the gate runs)
```

Never hand-edit `current/`. Change the facet schema in `SCHEMA.md` and the extractor together;
`tags` in each file are best-effort derivation (see `SCHEMA.md`).

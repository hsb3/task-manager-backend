# Project memory index

- [The app_docs seed is its own only source](app-docs-seed-is-its-own-only-source.md) — replaying without the generated seed migration yields zero rows, so every replay-based app_docs gate compares the file to itself; a one-byte prose edit is invisible to the whole battery
- [Battery hang on a surviving room](battery-hang-surviving-room.md) — `stop_room` kills then waits, so a legacy server that survives stalls the battery; kill that pid by number
- [Owner design rulings](feedback-owner-design-rulings.md) — names are display-only never keys (incl. name-derived slugs); no vestigial fields, delete column+index+hooks+tests together
- [FSEvents hits each new watcher](fsevents-stale-edit-hits-new-watcher.md) — a room booted right after a `pb_hooks/` touch can restart just after going healthy; settle then re-check health; reproduce only from a separate OS process
- [Universal guards need a touches predicate](universal-guard-needs-touches-predicate.md) — without `touchesScope` a universal guard throws on already-bad rows and the leaver sweep strands every remaining assignee (0 vs 5)
- [Docker holds port 12434](docker-holds-port-12434.md) — PB_PORT_OFFSET=4300 lands test_stale_write on Docker Desktop's listener (ollama holds 11434); lsof the band before assigning a lane offset

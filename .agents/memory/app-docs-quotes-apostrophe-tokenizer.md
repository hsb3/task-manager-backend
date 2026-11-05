---
name: app-docs-quotes-apostrophe-tokenizer
description: "check_app_docs_quotes tokenizes an apostrophe as a string delimiter, so an odd apostrophe count in added app_docs prose re-pairs later quotes and hides registered spans — write apostrophe-free, and extract bodies from a replayed DB rather than by grepping migrations"
metadata:
  type: project
---

# check_app_docs_quotes tokenizes `'` as a string delimiter

`scripts/check_app_docs_quotes.ts` treats every apostrophe as a quote boundary. An app_docs
sentence containing an ODD number of apostrophes re-pairs every later quote in the record, so
the registered rule spans become invisible and the gate reports "pinned prose span no longer in
the record" for a sentence that is verbatim present.

**How to apply:** write app_docs prose apostrophe-free (or in balanced pairs), and when a quotes
failure names a span you can see in the record, count apostrophes in the sentences ADDED above it
before touching the span registry.

**Related trap (same build, PBTT-422):** extract app_docs bodies from a REPLAYED DB (boot a room,
read the record), never by grepping `pb_migrations/` — several records are re-seeded by later
migrations whose JSON key order defeats the obvious regex; a body rebuilt from a stale migration
source shipped a wrong baseline once before being caught.

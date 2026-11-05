---
name: pb-rules-are-per-operation
description: "A rule predicate on list/view alone is not privacy: a peer correctly 404'd on GET still got 200 and the full body from a blind PATCH by id, and could DELETE"
metadata:
  type: project
---

Each operation's rule stands alone. A peer that `GET` correctly answered 404 still received 200
plus the full record body from a blind `PATCH` by id, and could `DELETE` it, because update and
delete carried a weaker predicate than list/view.

**How to apply:** a privacy predicate goes on list, view, update AND delete; probe the write
operations by id as the excluded role, not only the reads. Related:
[[pb-update-rule-evaluates-old-record]], [[pb-ored-rule-admits-anonymous]].

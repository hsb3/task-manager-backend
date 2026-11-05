/// <reference path="../pb_data/types.d.ts" />
// Stale-write refusal: an update or a delete naming the `updated` value it was edited
// against is refused once the stored row has moved past it; a create naming one is refused
// outright, because it protects nothing.

// KEEP IN SYNC: the three blocks below carry one rule apart from the verb and the transport the
// key rides (pooled JSVM: no shared top-level helper is reachable inside a callback); the create
// one stops at the refusal, because there is no stored row to compare against.
// Plain registration only: the `$app.onX().bind({...})` handler object runs in the one loader
// runtime, so concurrent requests share it and PocketBase panics (measured on create, update, delete).
// ponytail: no priority, so another file's validator may refuse a stale-and-invalid write first (400, not 409); nothing is written either way.
onRecordCreateRequest((e) => {
  const expected = (e.requestInfo().body || {}).expected_updated_at;
  // Absent is the only way to opt out; a caller that SENDS the key believes it is guarded,
  // so a value that cannot be compared is refused rather than dropped to last-write-wins.
  if (expected === undefined) return e.next();
  // No collection is guarded on this verb, and no value can be: a create has no stored row
  // behind it, so every spelling is refused 400 rather than silently dropped.
  throw new ApiError(
    400,
    "This item is new, so there is nothing yet to overwrite. Create it without a safeguard against another person's changes.",
    null,
  );
});

onRecordUpdateRequest((e) => {
  const expected = (e.requestInfo().body || {}).expected_updated_at;
  // Absent is the only way to opt out; a caller that SENDS the key believes it is guarded,
  // so a value that cannot be compared is refused rather than dropped to last-write-wins.
  if (expected === undefined) return e.next();
  const guarded =
    e.collection.name === "templates" || e.collection.name === "saved_views";
  // A value that names no instant (an empty string, a number, an object, unparseable text)
  // is unusable, not a different version — it is refused 400, never 409, which would tell
  // the caller someone else had changed the record.
  // Naming the accepted separators here, instead of leaving them to the parser, keeps a
  // JSVM upgrade from widening what this accepts.
  const spelled =
    typeof expected === "string" && /^\d{4}-\d\d-\d\d[ T]\d/.test(expected)
      ? expected.replace(" ", "T")
      : "";
  // A value naming no zone is read as UTC, never as this process's own clock, or one request
  // answers differently on a developer's machine and in the deployed container.
  const expectedMs = spelled
    ? Date.parse(
        /(?:[Zz]|[+-]\d\d:?\d\d)$/.test(spelled) ? spelled : spelled + "Z",
      )
    : NaN;
  // Same reason on a collection that carries no guard: the caller believes this write is
  // protected, so it is refused rather than accepted as if the key had never been sent.
  if (!guarded || Number.isNaN(expectedMs)) {
    throw new ApiError(
      400,
      "This change could not be saved. Reload the page and try again.",
      null,
    );
  }
  const stored = String(
    e.app.findRecordById(e.collection.name, e.record.id).get("updated"),
  );
  const storedMs = Date.parse(stored.replace(" ", "T"));
  // ponytail: `updated` is a millisecond timestamp, not a version, so this sees only a write
  // that MOVED it — two writes landing in one millisecond are both accepted and the first edit
  // is lost (measured 18/20 fired together), and a caller holding a value a later write left
  // unchanged stays accepted with no time bound at all (measured: wrote, and deleted, 3s on).
  // Accepted, not closed, by 3tvy R2 (owner ruling comment, 2026-09-06); a version column if
  // it ever matters.
  // Same parsed instant only: a lossy (ms-stripped) respelling names a different instant.
  const same = stored === expected || storedMs === expectedMs;
  if (!same) {
    throw new ApiError(409, "Someone else changed this since you opened it.", {
      expected_updated_at: new ValidationError(
        "stale_write",
        "Someone else changed this since you opened it.",
      ),
    });
  }
  return e.next();
});

onRecordDeleteRequest((e) => {
  const expected = (e.requestInfo().query || {}).expected_updated_at;
  // Absent is the only way to opt out; a caller that SENDS the key believes it is guarded,
  // so a value that cannot be compared is refused rather than dropped to last-write-wins.
  if (expected === undefined) return e.next();
  const guarded =
    e.collection.name === "templates" || e.collection.name === "saved_views";
  // A value that names no instant (an empty string, a number, an object, unparseable text)
  // is unusable, not a different version — it is refused 400, never 409, which would tell
  // the caller someone else had changed the record.
  // Naming the accepted separators here, instead of leaving them to the parser, keeps a
  // JSVM upgrade from widening what this accepts.
  const spelled =
    typeof expected === "string" && /^\d{4}-\d\d-\d\d[ T]\d/.test(expected)
      ? expected.replace(" ", "T")
      : "";
  // A value naming no zone is read as UTC, never as this process's own clock, or one request
  // answers differently on a developer's machine and in the deployed container.
  const expectedMs = spelled
    ? Date.parse(
        /(?:[Zz]|[+-]\d\d:?\d\d)$/.test(spelled) ? spelled : spelled + "Z",
      )
    : NaN;
  // Same reason on a collection that carries no guard: the caller believes this write is
  // protected, so it is refused rather than accepted as if the key had never been sent.
  if (!guarded || Number.isNaN(expectedMs)) {
    throw new ApiError(
      400,
      "This change could not be saved. Reload the page and try again.",
      null,
    );
  }
  const stored = String(
    e.app.findRecordById(e.collection.name, e.record.id).get("updated"),
  );
  const storedMs = Date.parse(stored.replace(" ", "T"));
  // ponytail: `updated` is a millisecond timestamp, not a version, so this sees only a write
  // that MOVED it — two writes landing in one millisecond are both accepted and the first edit
  // is lost (measured 18/20 fired together), and a caller holding a value a later write left
  // unchanged stays accepted with no time bound at all (measured: wrote, and deleted, 3s on).
  // Accepted, not closed, by 3tvy R2 (owner ruling comment, 2026-09-06); a version column if
  // it ever matters.
  // Same parsed instant only: a lossy (ms-stripped) respelling names a different instant.
  const same = stored === expected || storedMs === expectedMs;
  if (!same) {
    throw new ApiError(409, "Someone else changed this since you opened it.", {
      expected_updated_at: new ValidationError(
        "stale_write",
        "Someone else changed this since you opened it.",
      ),
    });
  }
  return e.next();
});

/// <reference path="../pb_data/types.d.ts" />
// PBTT-422 / decision-043 — the two-layer identity assigners. The record id is the real key;
// these hooks own the DISPLAY label: a per-project prefix (projects.key) plus one shared number
// sequence across all four item types (projects.item_seq).
//
// Universal tier (onRecordCreate/onRecordUpdate), not *Request: the three workspace-provision
// blocks create "My Project" through a programmatic e.app.save(), which a Request hook never
// sees — an unkeyed project would then hand every item in it an id-tail label.
//
// Pooled JSVM: each handler below is a self-contained top-level function registered DIRECTLY,
// the house idiom (see main.pb.js's validateTaskStatusWs) — nothing is CALLED across callbacks.

// KEEP IN SYNC: the prefix suggestion here mirrors the backfill in
// v1:pb_migrations/1785158900_project_item_keys.js.
function assignProjectKey(e) {
  // A shadow project (decision-052) takes no prefix: it must never squat one a member may
  // later choose, and its items stay keyless the way project-less items were.
  if (e.record.get("shadow")) {
    e.record.set("key", "");
    e.record.set("item_seq", 0);
    return e.next();
  }
  const wsId = e.record.get("workspace");
  const submitted = String(e.record.get("key") || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 8);
  const taken = (candidate) => {
    try {
      e.app.findFirstRecordByFilter(
        "projects",
        "workspace = {:w} && key = {:k}",
        {
          w: wsId,
          k: candidate,
        },
      );
      return true;
    } catch (_) {
      return false;
    }
  };
  if (submitted) {
    // A prefix the creator chose is never silently altered (decision-043) — a collision is
    // refused so the message reaches them instead of a surprise suffix.
    if (taken(submitted)) {
      throw new BadRequestError(
        "that project prefix is already in use in this workspace",
      );
    }
    e.record.set("key", submitted);
    e.record.set("item_seq", 0);
    return e.next();
  }
  let base = String(e.record.get("name") || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 3);
  if (!base) base = "PRJ";
  let candidate = base;
  let n = 1;
  while (taken(candidate) && n < 1000) {
    n++;
    candidate = base + n;
  }
  e.record.set("key", candidate);
  e.record.set("item_seq", 0);
  return e.next();
}
onRecordCreate(assignProjectKey, "projects");

// Fixed after create (decision-043): every item already wearing the prefix would be orphaned
// from its project's label if it could change.
function lockProjectKey(e) {
  const original = e.record.original().get("key");
  if (original && e.record.get("key") !== original) {
    throw new BadRequestError("key is immutable");
  }
  return e.next();
}
onRecordUpdate(lockProjectKey, "projects");

// item_seq is the server's own counter: rewinding it hands the next create a number an item
// already wears, and that item is then committed with no label at all. Request tier because the
// 1785158900 backfill writes the counter through its own app.save().
// KEEP IN SYNC: this is refuseSubmittedItemKey's rule, for the counter behind the key.
function refuseSubmittedItemSeq(e) {
  if (e.record.get("item_seq") !== e.record.original().get("item_seq")) {
    throw new BadRequestError("item_seq is server-owned");
  }
  return e.next();
}
onRecordUpdateRequest(refuseSubmittedItemSeq, "projects");

// Server-owned label: a submitted key never survives, so a client cannot squat another item's
// label. Minting is deliberately NOT here — see assignItemKey below.
function blankSubmittedItemKey(e) {
  e.record.set("key", "");
  return e.next();
}
onRecordCreate(blankSubmittedItemKey, "tasks");
onRecordCreate(blankSubmittedItemKey, "decisions");
onRecordCreate(blankSubmittedItemKey, "documents");
onRecordCreate(blankSubmittedItemKey, "milestones");

// One shared sequence per project across all four item types.
//
// After-create tier, the tasks.ordinal pattern (pb_hooks/ordinal.pb.js): claiming the number
// before the insert let a create the validator went on to refuse burn one, so a rejected POST
// left a hole no item will ever wear. This tier runs only once the row is committed. It also
// removes a per-boot coin flip — shadow.pb.js places a project-less item at the same create
// tier, and only here is `project` settled.
//
// The whole body NEVER throws: past this tier the row is already committed, so a throw would
// report a create that DID happen to the client as a 400, and on the boot path it would abort a
// migration's own e.app.save() outright.
function assignItemKey(e) {
  try {
    const id = e.record.id;
    const projectId = e.record.get("project");
    if (id && projectId) {
      let prefix = "";
      try {
        prefix = String(
          e.app.findRecordById("projects", projectId).get("key") || "",
        );
      } catch (_) {
        prefix = "";
      }
      // Re-claim rather than abandon: the unique index on (workspace, key) refuses a number
      // another item already wears, and this tier cannot refuse the create any more — the row is
      // committed and PBTT-487 means it would stay unlabelled for life. Each turn advances the
      // counter past the worn number, so the loop absorbs a counter lagging the true high-water
      // mark by up to the cap; refuseSubmittedItemSeq is what stops it lagging at all, and the
      // cap only keeps a pathological counter from spinning the request.
      const MINT_ATTEMPTS = 5;
      for (
        let attempt = 0;
        prefix && attempt < MINT_ATTEMPTS && !e.record.get("key");
        attempt++
      ) {
        // Atomic UPDATE…RETURNING only — a read-then-write hands duplicate numbers to
        // parallel creates (SQLite serializes the commit, not the read).
        const claim = e.app
          .db()
          .newQuery(
            "UPDATE projects SET item_seq = COALESCE(item_seq, 0) + 1 WHERE id = {:p} RETURNING item_seq",
          );
        claim.bind({ p: projectId });
        // Array form, never q.one(): a project deleted in this instant returns zero rows and
        // q.one() throws on that.
        const claimed = arrayOf(new DynamicModel({ item_seq: 0 }));
        claim.all(claimed);
        if (claimed.length === 0) break; // the project is gone: nothing to key against
        const minted = prefix + "-" + claimed[0].item_seq;
        try {
          // The table name is this record's own collection, never client input.
          const write = e.app
            .db()
            .newQuery(
              "UPDATE " +
                e.record.collection().name +
                " SET [[key]] = {:k} WHERE id = {:id}",
            );
          write.bind({ k: minted, id: id });
          write.execute();
          // The row is already written; this only stops the in-flight record from reporting
          // no label.
          e.record.set("key", minted);
        } catch (_) {
          // That number is worn — the next turn claims the one after it.
        }
      }
      if (prefix && !e.record.get("key")) {
        e.app
          .logger()
          .error("item left unlabelled", "item", id, "project", projectId);
      }
    }
  } catch (err) {
    e.app
      .logger()
      .error("item key mint failed", "item", e.record.id, "err", String(err));
  }
  return e.next();
}
onRecordAfterCreateSuccess(assignItemKey, "tasks");
onRecordAfterCreateSuccess(assignItemKey, "decisions");
onRecordAfterCreateSuccess(assignItemKey, "documents");
onRecordAfterCreateSuccess(assignItemKey, "milestones");

// The key follows the item (decision-043): moving an item to another project leaves its label
// alone, so this guard is also what stops a move from re-keying it into the new project's range.
// Lenient on an EMPTY original by necessity: this universal tier fires for the 1785158900
// backfill's own app.save() too, and PB aborts the boot on a migration a hook refuses.
// KEEP IN SYNC: refuseSubmittedItemKey below is this rule without the empty-original escape.
function lockItemKey(e) {
  const original = e.record.original().get("key");
  if (original && e.record.get("key") !== original) {
    throw new BadRequestError("key is immutable");
  }
  return e.next();
}
onRecordUpdate(lockItemKey, "tasks");
onRecordUpdate(lockItemKey, "decisions");
onRecordUpdate(lockItemKey, "documents");
onRecordUpdate(lockItemKey, "milestones");

// assignItemKey is the only minter, so an item born without a project is keyless for
// life and no client may PATCH itself a label the server never issued. Request tier because it
// must NOT see the backfill: that write is exactly the empty-original case escaped above.
// KEEP IN SYNC: this is lockItemKey's rule, strict on the empty original.
function refuseSubmittedItemKey(e) {
  if (e.record.get("key") !== e.record.original().get("key")) {
    throw new BadRequestError("key is immutable");
  }
  return e.next();
}
onRecordUpdateRequest(refuseSubmittedItemKey, "tasks");
onRecordUpdateRequest(refuseSubmittedItemKey, "decisions");
onRecordUpdateRequest(refuseSubmittedItemKey, "documents");
onRecordUpdateRequest(refuseSubmittedItemKey, "milestones");

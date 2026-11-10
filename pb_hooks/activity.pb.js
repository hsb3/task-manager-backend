/// <reference path="../pb_data/types.d.ts" />
// task_activity: record one audit row per whitelisted task field change, on every save path.

// The universal writer below has no e.auth of its own, so the request actor rides on the
// record: a non-empty stamp means the save came through the API, "-" that it carries no
// attributable user (superuser or anon). Custom keys never serialize, so this reaches no
// response body, no stored row and no broadcast payload.
// KEEP IN SYNC (below): realtime.pb.js stamps the same "_actor" key under the same convention.
onRecordUpdateRequest((e) => {
  e.record.set("_actor", e.auth && !e.auth.isSuperuser() ? e.auth.id : "-");
  // A superuser id names no users row, so their edit is attributed via operator instead.
  e.record.set(
    "_operator",
    e.auth && e.auth.isSuperuser() ? String(e.auth.get("email") || "") : "",
  );
  e.next();
}, "tasks");

// The UNIVERSAL tier, not *Request: a DELETE-to-trash (trash.pb.js) and a cycle rollover
// (cycles.pb.js) both write through a programmatic e.app.save(), which fires no *Request hook.
onRecordUpdate((e) => {
  const stamped = String(e.record.get("_actor") || "");
  const orig = e.record.original();
  // KEEP IN SYNC: ACTIVITY_FIELDS (pooled JSVM — inline constant, no shared helper)
  const ACTIVITY_FIELDS = [
    "status",
    "assignee",
    "priority",
    "due",
    "milestone",
    "project",
    "title",
    "labels",
    "trashed",
    "cycle",
  ];
  const changes = [];
  for (let i = 0; i < ACTIVITY_FIELDS.length; i++) {
    const f = ACTIVITY_FIELDS[i];
    const ov = orig.get(f);
    const nv = e.record.get(f);
    // JSON.stringify normalizes every shape: a single-relation id -> quoted string,
    // a multi-relation (labels) -> a JSON id-array.
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      changes.push({
        field: f,
        from: JSON.stringify(ov),
        to: JSON.stringify(nv),
      });
    }
  }
  let actor = stamped === "-" ? "" : stamped;
  const operator = String(e.record.get("_operator") || "");
  // A trash-set reached programmatically records who did it nowhere but trashed_by.
  if (
    stamped === "" &&
    String(orig.get("trashed") || "") === "" &&
    String(e.record.get("trashed") || "") !== ""
  ) {
    actor = String(e.record.get("trashed_by") || "");
  }
  // Persist FIRST: a failed save THROWS out of e.next(), so the row writes below never
  // run => no phantom activity rows for a rejected write.
  e.next();
  const taskId = e.record.id;
  try {
    const col = e.app.findCollectionByNameOrId("task_activity");
    for (let j = 0; j < changes.length; j++) {
      const row = new Record(col);
      row.set("task", taskId);
      if (actor) row.set("actor", actor);
      else if (operator) row.set("operator", operator);
      row.set("field", changes[j].field);
      row.set("from", changes[j].from);
      row.set("to", changes[j].to);
      e.app.save(row);
    }
  } catch (err) {
    // A throw at the UNIVERSAL tier aborts a migration backfill's whole boot, and the write
    // this row describes has already committed by here.
    e.app
      .logger()
      .error("task_activity write failed", "task", taskId, "err", String(err));
  }
}, "tasks");

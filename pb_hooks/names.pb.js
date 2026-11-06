/// <reference path="../pb_data/types.d.ts" />

// ── Refuse a submitted required text value that is nothing but whitespace; store name/title/body trimmed ───

// PB's `required` only rejects "" — "   " passes it, on every collection.
// One shared body, never a per-collection copy: a self-contained top-level fn passed DIRECTLY
// as the handler is legal under the pooled-JSVM law (house idiom, main.pb.js:120).
function rejectBlankName(e) {
  require(`${__hooks}/lib/workspace_rules.js`).rejectBlankName(
    e.record.collection(),
    e.requestInfo().body || {},
    e.record,
  );
  return e.next();
}

onRecordCreateRequest(rejectBlankName, "api_keys");
onRecordUpdateRequest(rejectBlankName, "api_keys");
onRecordCreateRequest(rejectBlankName, "app_docs");
onRecordUpdateRequest(rejectBlankName, "app_docs");
onRecordCreateRequest(rejectBlankName, "app_settings");
onRecordUpdateRequest(rejectBlankName, "app_settings");
onRecordCreateRequest(rejectBlankName, "comments");
onRecordUpdateRequest(rejectBlankName, "comments");
onRecordCreateRequest(rejectBlankName, "cycles");
onRecordUpdateRequest(rejectBlankName, "cycles");
onRecordCreateRequest(rejectBlankName, "decisions");
onRecordUpdateRequest(rejectBlankName, "decisions");
onRecordCreateRequest(rejectBlankName, "documents");
onRecordUpdateRequest(rejectBlankName, "documents");
onRecordCreateRequest(rejectBlankName, "labels");
onRecordUpdateRequest(rejectBlankName, "labels");
onRecordCreateRequest(rejectBlankName, "milestones");
onRecordUpdateRequest(rejectBlankName, "milestones");
onRecordCreateRequest(rejectBlankName, "projects");
onRecordUpdateRequest(rejectBlankName, "projects");
onRecordCreateRequest(rejectBlankName, "saved_views");
onRecordUpdateRequest(rejectBlankName, "saved_views");
onRecordCreateRequest(rejectBlankName, "statuses");
onRecordUpdateRequest(rejectBlankName, "statuses");
onRecordCreateRequest(rejectBlankName, "tasks");
onRecordUpdateRequest(rejectBlankName, "tasks");
onRecordCreateRequest(rejectBlankName, "templates");
onRecordUpdateRequest(rejectBlankName, "templates");
onRecordCreateRequest(rejectBlankName, "workspaces");
onRecordUpdateRequest(rejectBlankName, "workspaces");

// ── Refuse an update whose body names no field of the collection ───

function refuseEmptyUpdate(e) {
  const fields = e.record.collection().fields;
  const body = e.requestInfo().body || {};
  for (const key of Object.keys(body)) {
    // KEEP IN SYNC: ordinal.pb.js — a tasks `move` reorders the task without naming a field.
    if (key === "move" && e.collection.name === "tasks") return e.next();
    // `labels+` / `labels-` modify the `labels` field.
    if (fields.getByName(key.replace(/[+-]$/, ""))) return e.next();
  }
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].type() !== "file") continue;
    try {
      if (e.findUploadedFiles(fields[i].name).length) return e.next();
    } catch (_) {} // throws when the request carries no file for the field
  }
  throw new BadRequestError("No changes were supplied.");
}

onRecordUpdateRequest(refuseEmptyUpdate, "workspaces");
onRecordUpdateRequest(refuseEmptyUpdate, "projects");
onRecordUpdateRequest(refuseEmptyUpdate, "cycles");
onRecordUpdateRequest(refuseEmptyUpdate, "user_settings");
onRecordUpdateRequest(refuseEmptyUpdate, "tasks");
onRecordUpdateRequest(refuseEmptyUpdate, "documents");
onRecordUpdateRequest(refuseEmptyUpdate, "decisions");
onRecordUpdateRequest(refuseEmptyUpdate, "milestones");

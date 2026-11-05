/// <reference path="../pb_data/types.d.ts" />

// ── Refuse a submitted required text value that is nothing but whitespace ───

// PB's `required` only rejects "" — "   " passes it, on every collection.
// One shared body, never a per-collection copy: a self-contained top-level fn passed DIRECTLY
// as the handler is legal under the pooled-JSVM law (house idiom, main.pb.js:120).
function rejectBlankName(e) {
  require(`${__hooks}/lib/workspace_rules.js`).rejectBlankName(
    e.record.collection(),
    e.requestInfo().body || {},
  );
  return e.next();
}

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

/// <reference path="../pb_data/types.d.ts" />
// Card q46b: project_items serves comment counts and the task status flags, and its viewRule also resolves a trashed row for whom the trash shows it.
const ANCHOR = " AS active_admins FROM (";
// KEEP IN SYNC: counts.pb.js statuses enrich, STATUS_CATEGORIES' resolved half: `completed` and `canceled` are terminal, `canceled` alone is off-pipeline (scripts/check_constants.ts).
const OWN_STATUS = "SELECT 1 FROM statuses s WHERE s.id = u.status AND s.workspace = u.workspace AND s.category";
// A trashed row's comments are listable by nobody, so its count reads 0; subtask counts are served by counts.pb.js, never a column.
const COLUMNS =
  " AS active_admins" +
  ", CAST(CASE WHEN u.trashed != '' THEN 0 ELSE CASE u.type WHEN 'task' THEN (SELECT COUNT(*) FROM comments c WHERE c.task = u.id) WHEN 'document' THEN (SELECT COUNT(*) FROM comments c WHERE c.document = u.id) WHEN 'decision' THEN (SELECT COUNT(*) FROM comments c WHERE c.decision = u.id) ELSE 0 END END AS NUMERIC) AS comment_count" +
  ", CAST(u.type = 'task' AND EXISTS (" + OWN_STATUS + " IN ('completed', 'canceled')) AS BOOLEAN) AS status_terminal" +
  ", CAST(u.type = 'task' AND EXISTS (" + OWN_STATUS + " = 'canceled') AS BOOLEAN) AS status_off_pipeline" +
  // An empty or unresolvable status is not open: only a status of the item's own workspace counts.
  ", CAST(u.type = 'task' AND EXISTS (" + OWN_STATUS + " NOT IN ('completed', 'canceled')) AS BOOLEAN) AS open" +
  " FROM (";
// KEEP IN SYNC: routes.pb.js GET /api/tracker/trash — an active member or the owner, never a trashed workspace, and for non-task items an owner/admin or `draft = false || author`.
const TRASH_BRANCH =
  '@request.auth.id != "" && trashed != "" && workspace_trashed = 0 && (workspace_owner = @request.auth.id || active_members ~ @request.auth.id) && (type = "task" || draft = false || author = @request.auth.id || workspace_owner = @request.auth.id || active_admins ~ @request.auth.id)';
const INDEXES = [
  ["tasks", "idx_tasks_parent", "`parent`"],
  ["tasks", "idx_tasks_milestone", "`milestone`"],
  ["comments", "idx_comments_document", "`document`"],
  ["comments", "idx_comments_decision", "`decision`"],
];

migrate(
  (app) => {
    for (const [name, index, column] of INDEXES) {
      const collection = app.findCollectionByNameOrId(name);
      collection.addIndex(index, false, column, "");
      app.save(collection);
    }

    const view = app.findCollectionByNameOrId("pbc_300300001");
    const q = String(view.viewQuery);
    if (q.split(ANCHOR).length !== 2) throw new Error("project_items: expected exactly one active_admins column");
    const list = String(view.listRule);
    if (String(view.viewRule) !== list) throw new Error("project_items: expected the viewRule to equal the listRule");
    view.viewQuery = q.replace(ANCHOR, COLUMNS);
    view.viewRule = "(" + list + ") || (" + TRASH_BRANCH + ")";
    app.save(view);
  },
  (app) => {
    const view = app.findCollectionByNameOrId("pbc_300300001");
    const q = String(view.viewQuery);
    if (q.split(COLUMNS).length !== 2) throw new Error("project_items: expected exactly one copy of the count columns");
    view.viewQuery = q.replace(COLUMNS, ANCHOR);
    view.viewRule = view.listRule;
    app.save(view);

    for (const [name, index] of INDEXES) {
      const collection = app.findCollectionByNameOrId(name);
      collection.removeIndex(index);
      app.save(collection);
    }
  },
);

/// <reference path="../pb_data/types.d.ts" />
// decision:active-membership-grants-access: assigning a task grants nothing an active, role-qualified membership does not, and project_stats admits the workspace owner, not the project creator.
// Each edit must match exactly once, so a rule that drifted from the shape this expects aborts the boot instead of half-applying.
const T = 'task.workspace.workspace_members_via_workspace.status ?= "active")';
const EDITS = {
  tasks: [
    [["listRule", "viewRule"], 'status ?= "active") || assignee = @request.auth.id) && trashed', 'status ?= "active")) && trashed'],
    [["updateRule"], 'status ?= "active") || assignee = @request.auth.id) && workspace.trashed', 'status ?= "active")) && workspace.trashed'],
    [
      ["createRule"],
      'status ?= "active") || (@request.body.parent != "" && @request.body.parent.assignee = @request.auth.id && @request.body.parent.workspace.workspace_members_via_workspace.user ?= @request.auth.id && @request.body.parent.workspace.workspace_members_via_workspace.status ?= "active")) && (workspace = ""',
      'status ?= "active")) && (workspace = ""',
    ],
  ],
  comments: [
    [["listRule", "viewRule", "updateRule", "deleteRule"], T + " || task.assignee = @request.auth.id) || (document", T + ") || (document"],
    [["createRule"], T + " || task.assignee = @request.auth.id)) || (document", T + ")) || (document"],
    [["updateRule"], '?!= "viewer" && ' + T + " || task.assignee = @request.auth.id || document", '?!= "viewer" && ' + T + " || document"],
  ],
  task_activity: [[["listRule", "viewRule"], T + " || task.assignee = @request.auth.id) && task.trashed", T + ") && task.trashed"]],
  task_subscribers: [
    [["listRule", "viewRule", "createRule"], T + " || task.assignee = @request.auth.id) && task.trashed", T + ") && task.trashed"],
  ],
  notifications: [
    [["listRule", "viewRule", "updateRule"], T + " || task.assignee = @request.auth.id) && task.trashed", T + ") && task.trashed"],
  ],
  project_items: [
    [
      ["listRule", "viewRule"],
      '(type = "task" && ((workspace_owner = @request.auth.id || active_members ~ @request.auth.id) || assignee = @request.auth.id))',
      '(type = "task" && (workspace_owner = @request.auth.id || active_members ~ @request.auth.id))',
    ],
  ],
  project_stats: [[["listRule", "viewRule"], "(owner = @request.auth.id ||", "(workspace.owner = @request.auth.id ||"]],
};

function apply(app, back) {
  for (const name of Object.keys(EDITS)) {
    const c = app.findCollectionByNameOrId(name);
    const edits = back ? EDITS[name].slice().reverse() : EDITS[name];
    for (const [keys, from, to] of edits) {
      const [f, t] = back ? [to, from] : [from, to];
      for (const key of keys) {
        const parts = String(c[key]).split(f);
        if (parts.length !== 2) throw new Error(name + "." + key + ": expected exactly one occurrence of " + f);
        c[key] = parts.join(t);
      }
    }
    app.save(c);
  }
}

migrate(
  (app) => apply(app, false),
  (app) => apply(app, true),
);

/// <reference path="../pb_data/types.d.ts" />
// tasks/documents/decisions/milestones createRule: a create naming a TRASHED project (or, for tasks, a parent inside one) is refused, beside the trashed-workspace tail (card 6nrc).
migrate(
  (app) => {
    for (const name of ["tasks", "documents", "decisions", "milestones"]) {
      const c = app.findCollectionByNameOrId(name);
      c.createRule =
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= "viewer" && workspace.workspace_members_via_workspace.status ?= "active") || project.workspace.owner = @request.auth.id || (project.workspace.workspace_members_via_workspace.user ?= @request.auth.id && project.workspace.workspace_members_via_workspace.role ?!= "viewer" && project.workspace.workspace_members_via_workspace.status ?= "active")) && (workspace = "" || workspace.trashed = "") && (project = "" || (project.workspace.trashed = "" && project.trashed = ""))' +
        // a subtask inherits its parent's project in a create hook, after the rule has read the body
        (name === "tasks" ? ' && (parent = "" || parent.project.trashed = "")' : "");
      app.save(c);
    }
  },
  (app) => {
    for (const name of ["tasks", "documents", "decisions", "milestones"]) {
      const c = app.findCollectionByNameOrId(name);
      c.createRule =
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= "viewer" && workspace.workspace_members_via_workspace.status ?= "active") || project.workspace.owner = @request.auth.id || (project.workspace.workspace_members_via_workspace.user ?= @request.auth.id && project.workspace.workspace_members_via_workspace.role ?!= "viewer" && project.workspace.workspace_members_via_workspace.status ?= "active")) && (workspace = "" || workspace.trashed = "") && (project = "" || project.workspace.trashed = "")';
      app.save(c);
    }
  },
);

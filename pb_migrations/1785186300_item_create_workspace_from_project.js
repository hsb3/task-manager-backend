/// <reference path="../pb_data/types.d.ts" />
// documents/decisions/milestones createRule: tasks' project-derived dual path, because the rule sees the submitted body before scope.pb.js fills workspace.
migrate(
  (app) => {
    for (const name of ["documents", "decisions", "milestones"]) {
      const c = app.findCollectionByNameOrId(name);
      c.createRule =
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= "viewer" && workspace.workspace_members_via_workspace.status ?= "active") || project.workspace.owner = @request.auth.id || (project.workspace.workspace_members_via_workspace.user ?= @request.auth.id && project.workspace.workspace_members_via_workspace.role ?!= "viewer" && project.workspace.workspace_members_via_workspace.status ?= "active")) && (workspace = "" || workspace.trashed = "") && (project = "" || project.workspace.trashed = "")';
      app.save(c);
    }
  },
  (app) => {
    for (const name of ["documents", "decisions", "milestones"]) {
      const c = app.findCollectionByNameOrId(name);
      c.createRule =
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= "viewer" && workspace.workspace_members_via_workspace.status ?= "active")) && (workspace = "" || workspace.trashed = "") && (project = "" || project.workspace.trashed = "")';
      app.save(c);
    }
  },
);

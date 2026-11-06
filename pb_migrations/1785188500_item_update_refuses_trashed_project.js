/// <reference path="../pb_data/types.d.ts" />
// tasks/documents/decisions/milestones updateRule: a body that moves the item INTO a trashed project is refused (card 2vpm).
// The rule reads the SUBMITTED project, so an item already inside a trashed project stays editable in place (test_activity 7g).
migrate(
  (app) => {
    const set = (app, name, rule) => {
      const c = app.findCollectionByNameOrId(name);
      c.updateRule = rule;
      app.save(c);
    };
    set(app, "tasks", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\" && (@request.body.project = \"\" || @request.body.project.trashed = \"\")");
    set(app, "documents", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && (draft = false || author = @request.auth.id || workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= \"admin\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\" && (@request.body.project = \"\" || @request.body.project.trashed = \"\")");
    set(app, "decisions", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && (draft = false || author = @request.auth.id || workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= \"admin\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\" && (@request.body.project = \"\" || @request.body.project.trashed = \"\")");
    set(app, "milestones", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && (draft = false || author = @request.auth.id || workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= \"admin\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\" && (@request.body.project = \"\" || @request.body.project.trashed = \"\")");
  },
  (app) => {
    const set = (app, name, rule) => {
      const c = app.findCollectionByNameOrId(name);
      c.updateRule = rule;
      app.save(c);
    };
    set(app, "tasks", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\"");
    set(app, "documents", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && (draft = false || author = @request.auth.id || workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= \"admin\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\"");
    set(app, "decisions", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && (draft = false || author = @request.auth.id || workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= \"admin\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\"");
    set(app, "milestones", "@request.auth.id != \"\" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= \"viewer\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && (draft = false || author = @request.auth.id || workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= \"admin\" && workspace.workspace_members_via_workspace.status ?= \"active\")) && workspace.trashed = \"\"");
  },
);

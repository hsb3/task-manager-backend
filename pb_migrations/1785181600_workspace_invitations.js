/// <reference path="../pb_data/types.d.ts" />
// decision-073: an invitation is a record keyed by the email address, in its own collection, whether
// or not an account exists for it yet. `invited` retires from workspace_members.status and every rule
// clause naming it. No backfill: every DB (dev, rooms, prod, staging) boots fresh from this set, and
// prod carries no `invited` rows to migrate.
migrate(
  (app) => {
    const invitations = new Collection({
      id: "pbc_300400001",
      name: "workspace_invitations",
      type: "base",
      system: false,
      listRule:
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= "admin" && workspace.workspace_members_via_workspace.status ?= "active")) && workspace.trashed = ""',
      viewRule:
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= "admin" && workspace.workspace_members_via_workspace.status ?= "active")) && workspace.trashed = ""',
      createRule:
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= "admin" && workspace.workspace_members_via_workspace.status ?= "active" && @request.body.role = "member")) && workspace.trashed = ""',
      updateRule: null,
      deleteRule:
        '@request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= "admin" && workspace.workspace_members_via_workspace.status ?= "active")) && workspace.trashed = ""',
      fields: [
        {
          autogeneratePattern: "[a-z0-9]{15}",
          hidden: false,
          id: "text3208210256",
          max: 15,
          min: 15,
          name: "id",
          pattern: "^[a-z0-9]+$",
          presentable: false,
          primaryKey: true,
          required: true,
          system: true,
          type: "text",
        },
        {
          cascadeDelete: true,
          collectionId: "pbc_300100001",
          hidden: false,
          id: "relation4100000001",
          maxSelect: 1,
          minSelect: 0,
          name: "workspace",
          presentable: false,
          required: true,
          system: false,
          type: "relation",
        },
        {
          autogeneratePattern: "",
          hidden: false,
          id: "text4100000002",
          max: 0,
          min: 0,
          name: "email",
          pattern: "",
          presentable: false,
          primaryKey: false,
          required: true,
          system: false,
          type: "text",
        },
        // The only column ever compared (decision-073 §3): trim+lowercase, Gmail-folded, set
        // server-side by a create hook (link 2) — a client-supplied value is ignored.
        {
          autogeneratePattern: "",
          hidden: true,
          id: "text4100000003",
          max: 0,
          min: 0,
          name: "email_key",
          pattern: "",
          presentable: false,
          primaryKey: false,
          required: true,
          system: false,
          type: "text",
        },
        {
          hidden: false,
          id: "select4100000004",
          maxSelect: 1,
          name: "role",
          presentable: false,
          required: true,
          system: false,
          type: "select",
          values: ["admin", "member", "viewer"],
        },
        {
          cascadeDelete: false,
          collectionId: "_pb_users_auth_",
          hidden: false,
          id: "relation4100000005",
          maxSelect: 1,
          minSelect: 0,
          name: "invited_by",
          presentable: false,
          required: false,
          system: false,
          type: "relation",
        },
        {
          hidden: false,
          id: "autodate4100000006",
          name: "created",
          onCreate: true,
          onUpdate: false,
          presentable: false,
          system: false,
          type: "autodate",
        },
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_workspace_invitations_ws_key` ON `workspace_invitations` (`workspace`, `email_key`)",
      ],
    });
    app.save(invitations);

    // `invited` retires from workspace_members: a membership row is now created only by the
    // accept route (link 2), never by a direct create.
    const members = app.findCollectionByNameOrId("pbc_300100002");
    members.fields.getById("select2000000101").values = ["active", "suspended"];
    members.createRule = null;
    members.updateRule =
      '(workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= "admin" && workspace.workspace_members_via_workspace.status ?= "active" && @request.body.role:isset = false)) && @request.body.workspace:isset = false && @request.body.user:isset = false && workspace.trashed = ""';
    app.save(members);

    // An invitee can no longer read the workspace record before accepting; R2 (link 2) carries
    // workspace_name for that reason instead.
    const workspaces = app.findCollectionByNameOrId("pbc_300100001");
    workspaces.viewRule =
      '@request.auth.id != "" && (owner = @request.auth.id || (workspace_members_via_workspace.user ?= @request.auth.id && workspace_members_via_workspace.status ?= "active")) && trashed = ""';
    app.save(workspaces);

    const settingsCollection = app.findCollectionByNameOrId("app_settings");
    let settingsRec;
    try {
      settingsRec = app.findRecordById("app_settings", "wsinvexpirydys7");
    } catch (_) {
      settingsRec = new Record(settingsCollection);
      settingsRec.set("id", "wsinvexpirydys7");
    }
    settingsRec.set("key", "invitation_expiry_days");
    settingsRec.set("value", 7);
    app.save(settingsRec);
  },
  (app) => {
    try {
      const settingsRec = app.findRecordById("app_settings", "wsinvexpirydys7");
      app.delete(settingsRec);
    } catch (_) {
      // already gone
    }

    const workspaces = app.findCollectionByNameOrId("pbc_300100001");
    workspaces.viewRule =
      '@request.auth.id != "" && (owner = @request.auth.id || (workspace_members_via_workspace.user ?= @request.auth.id && (workspace_members_via_workspace.status ?= "active" || workspace_members_via_workspace.status ?= "invited"))) && trashed = ""';
    app.save(workspaces);

    const members = app.findCollectionByNameOrId("pbc_300100002");
    members.fields.getById("select2000000101").values = ["active", "invited", "suspended"];
    members.createRule =
      '@request.auth.id != "" && @request.body.status = "invited" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= "admin" && workspace.workspace_members_via_workspace.status ?= "active" && @request.body.role = "member")) && workspace.trashed = ""';
    members.updateRule =
      '(workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?= "admin" && workspace.workspace_members_via_workspace.status ?= "active" && @request.body.role:isset = false) || (user = @request.auth.id && status = "invited" && @request.body.status = "active" && @request.body.role:isset = false)) && @request.body.workspace:isset = false && @request.body.user:isset = false && workspace.trashed = ""';
    app.save(members);

    const invitations = app.findCollectionByNameOrId("pbc_300400001");
    app.delete(invitations);
  },
);

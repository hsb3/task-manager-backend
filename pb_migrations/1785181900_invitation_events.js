/// <reference path="../pb_data/types.d.ts" />
// decision-075: an append-only invitation ledger (superuser-only) behind the per-inviter daily limit and decline suppression.
migrate(
  (app) => {
    const events = new Collection({
      id: "pbc_300500001",
      name: "invitation_events",
      type: "base",
      system: false,
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
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
          hidden: false,
          id: "select4200000001",
          maxSelect: 1,
          name: "kind",
          presentable: false,
          required: true,
          system: false,
          type: "select",
          values: ["mint", "decline"],
        },
        {
          cascadeDelete: false,
          collectionId: "_pb_users_auth_",
          hidden: false,
          id: "relation4200000002",
          maxSelect: 1,
          minSelect: 0,
          name: "inviter",
          presentable: false,
          required: false,
          system: false,
          type: "relation",
        },
        // Not cascading: deleting a workspace must not refund the sends minted in it.
        {
          cascadeDelete: false,
          collectionId: "pbc_300100001",
          hidden: false,
          id: "relation4200000003",
          maxSelect: 1,
          minSelect: 0,
          name: "workspace",
          presentable: false,
          required: false,
          system: false,
          type: "relation",
        },
        {
          autogeneratePattern: "",
          hidden: false,
          id: "text4200000004",
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
          id: "autodate4200000005",
          name: "created",
          onCreate: true,
          onUpdate: false,
          presentable: false,
          system: false,
          type: "autodate",
        },
      ],
      indexes: [
        "CREATE INDEX `idx_invitation_events_inviter_created` ON `invitation_events` (`inviter`, `created`)",
        "CREATE INDEX `idx_invitation_events_ws_key_kind_created` ON `invitation_events` (`workspace`, `email_key`, `kind`, `created`)",
      ],
    });
    app.save(events);

    const settingsCollection = app.findCollectionByNameOrId("app_settings");
    let settingsRec;
    try {
      settingsRec = app.findRecordById("app_settings", "wsinvmintlim050");
    } catch (_) {
      settingsRec = new Record(settingsCollection);
      settingsRec.set("id", "wsinvmintlim050");
    }
    settingsRec.set("key", "invitation_mint_limit_per_day");
    settingsRec.set("value", 50);
    app.save(settingsRec);
  },
  (app) => {
    try {
      app.delete(app.findRecordById("app_settings", "wsinvmintlim050"));
    } catch (_) {
      // already gone
    }
    app.delete(app.findCollectionByNameOrId("pbc_300500001"));
  },
);

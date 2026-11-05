/// <reference path="../pb_data/types.d.ts" />
// api_keys (decision:api-keys): the updateRule locks are top-level conjuncts because PB evaluates it against the OLD record.
migrate(
  (app) => {
    const collection = new Collection({
      id: "pbc_300600001",
      name: "api_keys",
      type: "base",
      listRule: '@request.auth.id != "" && user = @request.auth.id',
      viewRule: '@request.auth.id != "" && user = @request.auth.id',
      createRule: '@request.auth.id != "" && (user = "" || user = @request.auth.id)',
      updateRule:
        '@request.auth.id != "" && user = @request.auth.id && @request.body.user:isset = false && @request.body.scope:isset = false && @request.body.key_hash:isset = false && @request.body.expires:isset = false && (@request.body.revoked:isset = false || @request.body.revoked = true)',
      deleteRule: '@request.auth.id != "" && user = @request.auth.id',
      fields: [
        {
          id: "relation4200600001",
          name: "user",
          type: "relation",
          collectionId: "_pb_users_auth_",
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
        },
        { id: "text4200600002", name: "name", type: "text", required: true, max: 200 },
        {
          id: "select4200600003",
          name: "scope",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["read", "write"],
        },
        {
          id: "text4200600004",
          name: "key_hash",
          type: "text",
          required: true,
          hidden: true,
          max: 64,
        },
        { id: "date4200600005", name: "expires", type: "date" },
        { id: "bool4200600006", name: "revoked", type: "bool" },
        { id: "autodate4200600007", name: "created", type: "autodate", onCreate: true },
        {
          id: "autodate4200600008",
          name: "updated",
          type: "autodate",
          onCreate: true,
          onUpdate: true,
        },
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_api_keys_key_hash` ON `api_keys` (`key_hash`)",
        "CREATE INDEX `idx_api_keys_user` ON `api_keys` (`user`)",
      ],
    });
    app.save(collection);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("api_keys"));
  },
);

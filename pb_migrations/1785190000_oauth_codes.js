/// <reference path="../pb_data/types.d.ts" />
// oauth_codes (contract: hosted-mcp-endpoint): one-time authorization codes, read and written only by the server.
migrate(
  (app) => {
    const collection = new Collection({
      id: "oauthcodes00001",
      name: "oauth_codes",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          id: "text4300100001",
          name: "code_hash",
          type: "text",
          required: true,
          max: 64,
          help: "A fingerprint of the one-time code, never the code itself.",
        },
        {
          id: "relation4300100002",
          name: "user",
          type: "relation",
          collectionId: "_pb_users_auth_",
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
          help: "The account that approved the sign-in.",
        },
        {
          id: "text4300100003",
          name: "client_id",
          type: "text",
          required: true,
          max: 2000,
          help: "The app the code was issued to.",
        },
        {
          id: "text4300100004",
          name: "client_name",
          type: "text",
          required: true,
          max: 200,
          help: "The app's name, which becomes the key's name.",
        },
        {
          id: "text4300100005",
          name: "redirect_uri",
          type: "text",
          required: true,
          max: 2000,
          help: "Where the app asked to be sent back; the exchange must name the same address.",
        },
        {
          id: "text4300100006",
          name: "code_challenge",
          type: "text",
          required: true,
          min: 43,
          max: 43,
          help: "The app's PKCE challenge (S256).",
        },
        {
          id: "select4300100007",
          name: "scope",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["read", "write"],
          help: "The access the person granted.",
        },
        {
          id: "date4300100008",
          name: "expires",
          type: "date",
          required: true,
          help: "Ten minutes after issue; an expired code is refused and later purged.",
        },
        {
          id: "autodate4300100009",
          name: "created",
          type: "autodate",
          onCreate: true,
          help: "When the code was issued.",
        },
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_oauth_codes_code_hash` ON `oauth_codes` (`code_hash`)",
        "CREATE INDEX `idx_oauth_codes_expires` ON `oauth_codes` (`expires`)",
      ],
    });
    app.save(collection);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("oauth_codes"));
  },
);

/// <reference path="../pb_data/types.d.ts" />
// oauth_codes gain the tm client's key name, expiry and manage-keys grant (change key-minting-cli).
migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("oauth_codes");
    c.fields.add(
      new TextField({
        id: "text4300109001",
        name: "key_name",
        required: false,
        max: 200,
        help: "The key name tm asked for; empty for other clients.",
      }),
    );
    c.fields.add(
      new DateField({
        id: "date4300109002",
        name: "key_expires",
        required: false,
        help: "The key expiry tm asked for; empty for none or for other clients.",
      }),
    );
    c.fields.add(
      new BoolField({
        id: "bool4300109003",
        name: "manage_keys",
        required: false,
        help: "Whether the person let tm's key list and revoke keys.",
      }),
    );
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("oauth_codes");
    c.fields.removeById("text4300109001");
    c.fields.removeById("date4300109002");
    c.fields.removeById("bool4300109003");
    app.save(c);
  },
);

/// <reference path="../pb_data/types.d.ts" />
// oauth_codes: a sign-in's level may be manage or own, and its workspace choice rides to the minted key (decision:api-key-reach-and-levels).
migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("oauthcodes00001");
    const scope = c.fields.getByName("scope");
    scope.values = ["read", "write", "manage", "own"];
    scope.help = "The level the person granted: read, write, manage or own.";
    c.fields.add(
      new SelectField({
        id: "select4300100010",
        name: "reach",
        values: ["all", "workspace"],
        maxSelect: 1,
        required: false,
        help: "Every workspace, or the one workspace the person chose; empty means every workspace.",
      }),
    );
    c.fields.add(
      new RelationField({
        id: "relation4300100011",
        name: "workspace",
        collectionId: "pbc_300100001",
        maxSelect: 1,
        minSelect: 0,
        cascadeDelete: true,
        required: false,
        help: "The workspace the person chose, or empty for every workspace.",
      }),
    );
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("oauthcodes00001");
    c.fields.removeById("select4300100010");
    c.fields.removeById("relation4300100011");
    const scope = c.fields.getByName("scope");
    scope.values = ["read", "write"];
    scope.help = "The access the person granted.";
    app.save(c);
  },
);

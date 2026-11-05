/// <reference path="../pb_data/types.d.ts" />
// decision-077: an omitted owner passes the createRule and pb_hooks/owner.pb.js stamps the
// caller; a submitted owner naming anyone else is still refused. Only the owner clause moves.
// createRule sees SUBMITTED data, where an omitted relation reads "".
migrate(
  (app) => {
    // The leading auth clause pins the match to the record's own owner, never workspace.owner.
    const OWNER_FROM = '@request.auth.id != "" && owner = @request.auth.id';
    const OWNER_TO = '@request.auth.id != "" && (owner = "" || owner = @request.auth.id)';
    const EDITS = [
      ["pbc_484305853", "projects", OWNER_FROM, OWNER_TO],
      ["pbc_300100001", "workspaces", OWNER_FROM, OWNER_TO],
      [
        "pbc_300200007",
        "saved_views",
        "@request.body.owner = @request.auth.id",
        "(@request.body.owner:isset = false || @request.body.owner = @request.auth.id)",
      ],
    ];
    for (const [id, name, from, to] of EDITS) {
      const collection = app.findCollectionByNameOrId(id);
      const rule = String(collection.createRule ?? "");
      if (rule.split(from).length !== 2)
        throw new Error(
          `${name}.createRule does not carry exactly one '${from}'; refusing to edit`,
        );
      collection.createRule = rule.replace(from, to);
      app.save(collection);
    }
  },
  (app) => {
    // The leading auth clause pins the match to the record's own owner, never workspace.owner.
    const OWNER_FROM = '@request.auth.id != "" && owner = @request.auth.id';
    const OWNER_TO = '@request.auth.id != "" && (owner = "" || owner = @request.auth.id)';
    const EDITS = [
      ["pbc_484305853", "projects", OWNER_FROM, OWNER_TO],
      ["pbc_300100001", "workspaces", OWNER_FROM, OWNER_TO],
      [
        "pbc_300200007",
        "saved_views",
        "@request.body.owner = @request.auth.id",
        "(@request.body.owner:isset = false || @request.body.owner = @request.auth.id)",
      ],
    ];
    for (const [id, name, from, to] of EDITS) {
      const collection = app.findCollectionByNameOrId(id);
      const rule = String(collection.createRule ?? "");
      if (rule.split(to).length !== 2)
        throw new Error(
          `${name}.createRule does not carry exactly one '${to}'; refusing to revert`,
        );
      collection.createRule = rule.replace(to, from);
      app.save(collection);
    }
  },
);

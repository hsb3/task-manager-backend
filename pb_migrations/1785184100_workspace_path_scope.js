/// <reference path="../pb_data/types.d.ts" />
// decision-077: a request naming `?workspace=` reaches a record only inside that workspace, so a
// caller active in two workspaces gets a 404 for the other one's id; naming none keeps the old rule.
migrate(
  (app) => {
    // An absent param is unset (measured on 0.40.4); an empty one is set and matches nothing.
    const SUFFIX =
      " && (@request.query.workspace:isset = false || workspace = @request.query.workspace)";
    const RULES = {
      cycles: ["viewRule", "updateRule", "deleteRule"],
      templates: ["viewRule", "updateRule", "deleteRule"],
      saved_views: ["viewRule", "updateRule", "deleteRule"],
      workspace_members: ["viewRule", "updateRule", "deleteRule"],
      projects: ["viewRule", "updateRule", "deleteRule"],
      // updateRule is null (superuser only): nothing to narrow.
      workspace_invitations: ["viewRule", "deleteRule"],
    };
    for (const [name, fields] of Object.entries(RULES)) {
      const collection = app.findCollectionByNameOrId(name);
      for (const field of fields) {
        const rule = collection[field];
        if (!rule || rule.includes("@request.query.workspace"))
          throw new Error(`${name}.${field} is empty or already path-scoped; refusing to edit`);
        collection[field] = rule + SUFFIX;
      }
      app.save(collection);
    }
  },
  (app) => {
    const SUFFIX =
      " && (@request.query.workspace:isset = false || workspace = @request.query.workspace)";
    const RULES = {
      cycles: ["viewRule", "updateRule", "deleteRule"],
      templates: ["viewRule", "updateRule", "deleteRule"],
      saved_views: ["viewRule", "updateRule", "deleteRule"],
      workspace_members: ["viewRule", "updateRule", "deleteRule"],
      projects: ["viewRule", "updateRule", "deleteRule"],
      workspace_invitations: ["viewRule", "deleteRule"],
    };
    for (const [name, fields] of Object.entries(RULES)) {
      const collection = app.findCollectionByNameOrId(name);
      for (const field of fields) {
        const rule = String(collection[field]);
        if (rule.slice(-SUFFIX.length) !== SUFFIX)
          throw new Error(`${name}.${field} does not end with the clause this migration added`);
        collection[field] = rule.slice(0, -SUFFIX.length);
      }
      app.save(collection);
    }
  },
);

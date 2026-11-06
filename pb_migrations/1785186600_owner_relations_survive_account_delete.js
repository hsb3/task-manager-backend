/// <reference path="../pb_data/types.d.ts" />
// Deleting an account empties projects.owner and saved_views.owner instead of deleting the shared rows (kata bwpj).
migrate(
  (app) => {
    for (const name of ["projects", "saved_views"]) {
      const col = app.findCollectionByNameOrId(name);
      const owner = col.fields.getByName("owner");
      owner.cascadeDelete = false;
      // PB refuses to delete a record still named by a required non-cascading relation.
      owner.required = false;
      owner.minSelect = 0;
      app.save(col);
    }
  },
  (app) => {
    // projects.owner had minSelect 0 and saved_views.owner minSelect 1 (v2:1785185200_collections.js).
    for (const [name, minSelect] of [
      ["projects", 0],
      ["saved_views", 1],
    ]) {
      const col = app.findCollectionByNameOrId(name);
      const owner = col.fields.getByName("owner");
      owner.cascadeDelete = true;
      owner.required = true;
      owner.minSelect = minSelect;
      app.save(col);
    }
  },
);

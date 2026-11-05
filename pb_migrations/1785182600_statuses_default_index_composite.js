/// <reference path="../pb_data/types.d.ts" />
// PocketBase ignores a partial index's WHERE when deciding a back-relation is single, so a
// UNIQUE on (workspace) alone made workspaces' statuses_via_workspace expand one object.
// Adding is_default (constant TRUE under the WHERE) keeps one default status per workspace.
const OLD =
  "CREATE UNIQUE INDEX `idx_statuses_ws_default` ON `statuses` (`workspace`) WHERE `is_default` = TRUE";
const NEW =
  "CREATE UNIQUE INDEX `idx_statuses_ws_default` ON `statuses` (`workspace`, `is_default`) WHERE `is_default` = TRUE";

function swap(app, from, to) {
  const collection = app.findCollectionByNameOrId("statuses");
  const indexes = [];
  let found = false;
  for (const idx of collection.indexes) {
    if (idx === from) {
      indexes.push(to);
      found = true;
    } else indexes.push(idx);
  }
  if (!found) throw new Error("statuses: index not found: " + from);
  collection.indexes = indexes;
  app.save(collection);
}

migrate(
  (app) => swap(app, OLD, NEW),
  (app) => swap(app, NEW, OLD),
);

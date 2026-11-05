/// <reference path="../pb_data/types.d.ts" />
// Card erjp: tasks gain `author` (→users, optional) so every item kind records its creator, and project_items carries it.
migrate(
  (app) => {
    const tasks = app.findCollectionByNameOrId("pbc_2602490748");
    // NOT required: pre-existing rows and superuser/programmatic creates carry no author; author.pb.js stamps it.
    tasks.fields.add(
      new Field({
        cascadeDelete: false,
        collectionId: "_pb_users_auth_",
        hidden: false,
        id: "relation4000000204",
        maxSelect: 1,
        minSelect: 0,
        name: "author",
        presentable: false,
        required: false,
        system: false,
        type: "relation",
      }),
    );
    app.save(tasks);

    const OLD = "0 AS draft, '' AS author,";
    const NEW = "0 AS draft, t.author AS author,";
    const view = app.findCollectionByNameOrId("pbc_300300001");
    const q = String(view.viewQuery);
    if (q.split(OLD).length !== 2) throw new Error("project_items task arm: expected exactly one empty author placeholder");
    view.viewQuery = q.replace(OLD, NEW);
    app.save(view);
  },
  (app) => {
    const OLD = "0 AS draft, '' AS author,";
    const NEW = "0 AS draft, t.author AS author,";
    const view = app.findCollectionByNameOrId("pbc_300300001");
    const q = String(view.viewQuery);
    if (q.split(NEW).length !== 2) throw new Error("project_items task arm: expected exactly one t.author column");
    view.viewQuery = q.replace(NEW, OLD);
    app.save(view);

    const tasks = app.findCollectionByNameOrId("pbc_2602490748");
    tasks.fields.removeById("relation4000000204");
    app.save(tasks);
  },
);

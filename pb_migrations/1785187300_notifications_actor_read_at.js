/// <reference path="../pb_data/types.d.ts" />
// notifications gain actor and read_at, both server-written (kata 06sf), and a row naming a workspace needs the reader's live membership of it (kata s80p).
// Each edit must match exactly once, so a rule that drifted from the shape this expects aborts the boot instead of half-applying.
const LEG =
  '(workspace = "" || workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.status ?= "active")) && ';
const EDITS = [
  [["listRule", "viewRule", "updateRule"], 'user = @request.auth.id && (task = ""', 'user = @request.auth.id && ' + LEG + '(task = ""'],
  [
    ["updateRule"],
    "@request.body.workspace:isset = false &&",
    "@request.body.workspace:isset = false && @request.body.actor:isset = false && @request.body.read_at:isset = false &&",
  ],
];

function rules(c, back) {
  const edits = back ? EDITS.slice().reverse() : EDITS;
  for (const [keys, from, to] of edits) {
    const [f, t] = back ? [to, from] : [from, to];
    for (const key of keys) {
      const parts = String(c[key]).split(f);
      if (parts.length !== 2) throw new Error("notifications." + key + ": expected exactly one occurrence of " + f);
      c[key] = parts.join(t);
    }
  }
}

migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("notifications");
    // Not cascading: deleting the actor's account empties the field and keeps the recipient's row.
    c.fields.add(
      new RelationField({
        id: "relation3000030013",
        name: "actor",
        collectionId: "_pb_users_auth_",
        cascadeDelete: false,
        maxSelect: 1,
        minSelect: 0,
        required: false,
      }),
    );
    c.fields.add(new DateField({ id: "date3000030014", name: "read_at", required: false }));
    rules(c, false);
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("notifications");
    rules(c, true);
    c.fields.removeById("relation3000030013");
    c.fields.removeById("date3000030014");
    app.save(c);
  },
);

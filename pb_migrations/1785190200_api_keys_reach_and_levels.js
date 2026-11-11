/// <reference path="../pb_data/types.d.ts" />
// api_keys: a key's reach (all, workspace, projects) and the manage and own levels (decision:api-key-reach-and-levels).
const TAIL =
  " && @request.body.reach:isset = false && @request.body.workspace:isset = false && @request.body.projects:isset = false";
const SCOPE_HELP =
  "The key's level, per workspace role tier: read only reads; write also creates, edits, trashes work; manage also changes settings, invitations and members and purges trash; own also changes roles, hands over and deletes workspaces and accepts invitations. Capped by the user's role; fixed at create.";
const SCOPE_HELP_BEFORE =
  "What the key may do: read allows only reads, write also allows changes; chosen at create and fixed afterwards.";
const FIELD_IDS = ["select4200610001", "relation4200610002", "relation4200610003"];

migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("api_keys");
    const scope = c.fields.getByName("scope");
    scope.values = ["read", "write", "manage", "own"];
    scope.help = SCOPE_HELP;
    c.fields.add(
      new SelectField({
        id: "select4200610001",
        name: "reach",
        values: ["all", "workspace", "projects"],
        maxSelect: 1,
        required: false,
        help: "Which part of the tracker the key reaches: all for every workspace its user belongs to, workspace for one workspace, projects for some projects of one workspace; empty on keys made before reach existed, which reach every workspace. Chosen at create and fixed afterwards.",
      }),
    );
    c.fields.add(
      new RelationField({
        id: "relation4200610002",
        name: "workspace",
        collectionId: "pbc_300100001",
        maxSelect: 1,
        minSelect: 0,
        cascadeDelete: true,
        required: false,
        help: "The one workspace a key limited to a workspace or to projects reaches, empty for a key that reaches every workspace; deleting the workspace for good deletes the key. Chosen at create and fixed afterwards.",
      }),
    );
    c.fields.add(
      new RelationField({
        id: "relation4200610003",
        name: "projects",
        collectionId: "pbc_484305853",
        maxSelect: 100,
        minSelect: 0,
        cascadeDelete: false,
        required: false,
        help: "The projects a key limited to projects reaches, all in its workspace; a project deleted for good drops out of the list. Chosen at create and fixed afterwards.",
      }),
    );
    c.updateRule = "(" + c.updateRule + ")" + TAIL;
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("api_keys");
    const rule = String(c.updateRule);
    // A rule that drifted from the shape this expects aborts instead of half-reverting.
    if (!rule.startsWith("(") || !rule.endsWith(")" + TAIL)) {
      throw new Error("api_keys.updateRule: expected (<rule>)" + TAIL);
    }
    c.updateRule = rule.slice(1, rule.length - TAIL.length - 1);
    for (const id of FIELD_IDS) c.fields.removeById(id);
    const scope = c.fields.getByName("scope");
    scope.values = ["read", "write"];
    scope.help = SCOPE_HELP_BEFORE;
    app.save(c);
  },
);

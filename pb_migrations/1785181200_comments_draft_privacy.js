/// <reference path="../pb_data/types.d.ts" />
// decision-072 draft privacy never reached comments: workspace membership alone let any
// active member read or post onto a comment thread on a draft document/decision.
migrate(
  (app) => {
    // decision-072 §2's read set for a draft, expressed through the comment's relation: the
    // target unset, published, its own author, the workspace owner, or an active admin.
    const draftOpen = (rel) =>
      `(${rel} = "" || ${rel}.draft = false || ${rel}.author = @request.auth.id || ` +
      `${rel}.workspace.owner = @request.auth.id || (${rel}.workspace.workspace_members_via_workspace.user ?= @request.auth.id && ` +
      `${rel}.workspace.workspace_members_via_workspace.role ?= "admin" && ${rel}.workspace.workspace_members_via_workspace.status ?= "active"))`;
    const SUFFIX = ` && ${draftOpen("document")} && ${draftOpen("decision")}`;

    const collection = app.findCollectionByNameOrId("pbc_300100004");
    for (const field of ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"]) {
      if (!collection[field]) throw new Error("comments." + field + " is empty; nothing to narrow");
      collection[field] = collection[field] + SUFFIX;
    }
    app.save(collection);
  },
  (app) => {
    const draftOpen = (rel) =>
      `(${rel} = "" || ${rel}.draft = false || ${rel}.author = @request.auth.id || ` +
      `${rel}.workspace.owner = @request.auth.id || (${rel}.workspace.workspace_members_via_workspace.user ?= @request.auth.id && ` +
      `${rel}.workspace.workspace_members_via_workspace.role ?= "admin" && ${rel}.workspace.workspace_members_via_workspace.status ?= "active"))`;
    const SUFFIX = ` && ${draftOpen("document")} && ${draftOpen("decision")}`;

    const collection = app.findCollectionByNameOrId("pbc_300100004");
    for (const field of ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"]) {
      const rule = String(collection[field]);
      if (rule.slice(-SUFFIX.length) !== SUFFIX)
        throw new Error("comments." + field + " does not end with the clause this migration added");
      collection[field] = rule.slice(0, -SUFFIX.length);
    }
    app.save(collection);
  },
);

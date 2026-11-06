/// <reference path="../pb_data/types.d.ts" />
// decision:server-owned-fields-locked (kata 06k8): saved_views.owner and labels.core refuse a client write, and three server-owned fields say so in their help.
const RULES = {
  saved_views: [
    [["updateRule"], " && (@request.body.owner:isset = false || @request.body.owner = owner)"],
  ],
  labels: [[["createRule", "updateRule"], " && @request.body.core:isset = false"]],
};
// [field, help after this migration, help before it (the field-help baseline), restored on down]
const HELP = {
  saved_views: [
    "owner",
    "The user who owns the view; omit it and the server fills the caller, naming anyone else at create is refused, and an update that names a different owner is refused.",
    "The user who owns the view; leave it empty and the server fills the caller, and naming anyone else at create is refused.",
  ],
  labels: [
    "core",
    "True for the built-in labels every workspace starts with, which cannot be deleted; the server sets it, and a create or an update that sends it is refused.",
    "True for the built-in labels every workspace starts with, which cannot be deleted; leave it unset on a label you create.",
  ],
  tasks: [
    "completedAt",
    "When the task entered a completed status; the server sets and clears it as the status changes, a value sent at create is replaced, and a value sent on an update is refused unless the same request moves the status into or out of a completed status; a superuser may set it.",
    "When the task entered a completed status; the server sets and clears it as the status changes, so a client should not send it.",
  ],
};

function apply(app, back) {
  for (const name of Object.keys(HELP)) {
    const c = app.findCollectionByNameOrId(name);
    for (const [keys, tail] of RULES[name] || []) {
      for (const key of keys) {
        const parts = String(c[key]).split(tail);
        // A rule that drifted from the shape this expects aborts the boot instead of half-applying.
        if (back ? parts.length !== 2 || parts[1] !== "" : parts.length !== 1) {
          throw new Error(
            name + "." + key + ": expected " + (back ? "exactly one trailing " : "no ") + tail,
          );
        }
        c[key] = back ? parts[0] : c[key] + tail;
      }
    }
    c.fields.getByName(HELP[name][0]).help = HELP[name][back ? 2 : 1];
    app.save(c);
  }
}

migrate(
  (app) => apply(app, false),
  (app) => apply(app, true),
);

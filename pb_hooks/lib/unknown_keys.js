/// <reference path="../../pb_data/types.d.ts" />
// The unknown-body-key refusal; require() it inside a handler body.

// Hook files load in no fixed order, so every record create/update refusal in pb_hooks/ calls this first; a new refusal must too.
// PB has already folded `field+` / `field-` modifiers of a real field into the field name here.
function refuseUnknownKeys(e) {
  const body = e.requestInfo().body || {};
  const fields = e.record.collection().fields;
  const auth = e.record.collection().type === "auth";
  const errors = {};
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (fields.getByName(key)) continue;
    // Non-field keys a hook reads. KEEP IN SYNC: `expected_updated_at` in pb_hooks/precondition.pb.js.
    if (key === "expected_updated_at") continue;
    // KEEP IN SYNC: a tasks `move` in pb_hooks/ordinal.pb.js.
    if (key === "move" && e.collection.name === "tasks") continue;
    if (auth && (key === "passwordConfirm" || key === "oldPassword")) continue;
    unknown.push(key);
    errors[key] = new ValidationError("validation_failed", "Unknown field.");
  }
  // File parts never reach the body; PB drops an unknown one silently.
  const form = e.requestEvent.request.multipartForm;
  for (const key of form && form.file ? Object.keys(form.file) : []) {
    if (fields.getByName(key.replace(/^\+|[+-]$/g, ""))) continue;
    unknown.push(key);
    errors[key] = new ValidationError("validation_failed", "Unknown field.");
  }
  if (unknown.length) {
    throw new BadRequestError(
      "Unknown field: " + unknown.join(", ") + ".",
      errors,
    );
  }
}

module.exports = { refuseUnknownKeys };

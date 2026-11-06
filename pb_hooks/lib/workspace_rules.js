/// <reference path="../../pb_data/types.d.ts" />
// The write rules a collection hook and a tracker route both apply; require() it inside a handler body.

// A submitted name/title/body is also set trimmed on `record`; slug/key patterns already refuse whitespace.
function rejectBlankName(collection, body, record) {
  // Every required text field in schema/ is dispositioned: these five names carry a
  // value a reader or a lookup depends on, so whitespace-only is meaningless. `id` is
  // excluded by omission (its own `^[a-z0-9]+$` pattern already refuses whitespace) and so
  // is task_activity.field (null write rules — only activity.pb.js's programmatic saves
  // write it, which Request hooks never see).
  const guarded = ["name", "title", "slug", "body", "key"];
  // Derived from the collection, never a hand-copied field list; tests/test_name_validation.ts
  // applies the same predicate to schema/ and turns red on a new collection left unguarded.
  const fields = collection.fields;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f.required || f.type() !== "text") continue;
    if (guarded.indexOf(f.name) === -1) continue;
    const submitted = body[f.name];
    // Only a SUBMITTED value is judged, so a PATCH that never sends the field still passes.
    if (typeof submitted === "string" && submitted.trim() === "") {
      // KEEP IN SYNC: routes.pb.js phrases the same `must be a non-empty string` refusal for the vocab route.
      throw new BadRequestError(f.name + " must be a non-empty string");
    }
    if (
      typeof submitted === "string" &&
      ["name", "title", "body"].indexOf(f.name) !== -1
    )
      record.set(f.name, submitted.trim());
  }
}

// The body of main.pb.js validateDefaultProject, whose header states why it is a hook.
function validateDefaultProject(app, record) {
  const dp = record.get("default_project");
  if (dp) {
    let project;
    try {
      project = app.findRecordById("projects", dp);
    } catch (_) {
      throw new BadRequestError(
        "default_project does not reference an existing project",
      );
    }
    if (project.get("workspace") !== record.id) {
      throw new BadRequestError(
        "default_project must belong to this workspace",
      );
    }
    // KEEP IN SYNC: pb_hooks/scope.pb.js guards its project pointers with the same `pick one from the project list` refusal.
    if (project.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
}

// The body of main.pb.js validateWorkspacePriorities, whose header states the ruled edges; on success the record carries the normalised entries.
function validateWorkspacePriorities(record) {
  const raw = record.get("priorities");
  const rawS = raw === null || raw === undefined ? "" : String(raw);
  const s = rawS === "null" ? "" : rawS;
  const origRaw = record.original().get("priorities");
  const origRawS =
    origRaw === null || origRaw === undefined ? "" : String(origRaw);
  const origS = origRawS === "null" ? "" : origRawS;
  if (s === origS) return;
  if (s === "") {
    if (record.original().id === "") return;
    throw new BadRequestError(
      "priorities cannot be emptied — a workspace must keep at least one priority",
    );
  }
  const shape =
    "priorities must be an array of {id, name} entries with non-empty names";
  // .get() on a json field returns a JsonRaw wrapper (typeof "object", Array.isArray()
  // true even for a string) — parse the JSON text, never branch on the wrapper.
  let vocab;
  try {
    vocab = JSON.parse(s);
  } catch (_) {
    throw new BadRequestError(shape);
  }
  if (!Array.isArray(vocab)) throw new BadRequestError(shape);
  // An empty vocabulary is legal ONLY on create, where the afterCreate seeder
  // replaces it with the defaults; nothing re-seeds on update, so [] would persist and
  // leave the workspace unable to accept any task priority at all.
  // original() is a blank record on create, so its id is the create/update discriminator.
  if (vocab.length === 0 && record.original().id !== "") {
    throw new BadRequestError(
      "priorities cannot be emptied — a workspace must keep at least one priority",
    );
  }
  // A name-only entry matching a stored name keeps that id unless the payload sends the id itself,
  // so a client resending names alone cannot re-key the vocabulary and orphan every task.
  let stored = [];
  try {
    stored = JSON.parse(origS);
  } catch (_) {}
  const supplied = [];
  for (let i = 0; i < vocab.length; i++) {
    if (vocab[i] && typeof vocab[i] === "object") supplied.push(vocab[i].id);
  }
  const names = [];
  const ids = [];
  const entries = [];
  for (let i = 0; i < vocab.length; i++) {
    const entry = vocab[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new BadRequestError(shape);
    }
    let p = entry.name;
    if (typeof p !== "string" || p.trim() === "") {
      throw new BadRequestError(shape);
    }
    // Trimmed before every check below, so "high " never coexists with "high".
    p = p.trim();
    // Minted here, before the checks below, so a client adds an entry by sending a name alone.
    let id = entry.id;
    for (
      let j = 0;
      (id === undefined || id === null || id === "") &&
      Array.isArray(stored) &&
      j < stored.length;
      j++
    ) {
      const old = stored[j];
      if (
        old &&
        typeof old.name === "string" &&
        old.name.trim() === p &&
        supplied.indexOf(old.id) === -1
      )
        id = old.id;
    }
    if (id === undefined || id === null || id === "") {
      id = $security.randomStringWithAlphabet(
        15,
        "abcdefghijklmnopqrstuvwxyz0123456789",
      );
    }
    if (typeof id !== "string" || !/^[a-z0-9]{15}$/.test(id)) {
      throw new BadRequestError(
        "priorities entry id must be 15 lowercase letters or digits",
      );
    }
    // KEEP IN SYNC: PRIORITY_UNSET_TOKEN (docs/constants.md) — `none` is the wire token that
    // clears a priority, so it can never also be a vocabulary entry.
    if (p.toLowerCase() === "none") {
      throw new BadRequestError(
        'priorities cannot contain "none", which is reserved for clearing a task priority',
      );
    }
    // indexOf, not a seen-map: an object key like "constructor" is truthy by inheritance.
    if (names.indexOf(p) !== -1) {
      throw new BadRequestError("priorities cannot repeat an entry");
    }
    if (ids.indexOf(id) !== -1) {
      throw new BadRequestError("priorities cannot repeat an id");
    }
    names.push(p);
    ids.push(id);
    entries.push({ id: id, name: p });
  }
  record.set("priorities", entries);
}

// decision:user-settings-write-checks: a users.name changed to nothing but whitespace is refused; any other change is stored trimmed.
// A resent unchanged name passes as stored, so an account that has no name stays editable.
function refuseBlankUserName(field, value, stored) {
  if (typeof value !== "string" || value === stored) return value;
  const name = value.trim();
  if (name === "") {
    const data = {};
    data[field] = new ValidationError(
      "validation_required",
      "Cannot be blank.",
    );
    throw new BadRequestError("The name cannot be blank.", data);
  }
  return name;
}

// decision:user-settings-write-checks: judge each changed pointer and the time zone of a user_settings save.
// `next`/`prev` map default_project, default_view and time_zone to the value being saved and the stored one.
function validateUserSettings(app, info, next, prev) {
  const refuse = (field, code, message) => {
    const data = {};
    data[field] = new ValidationError(code, message);
    throw new BadRequestError("The settings cannot be saved.", data);
  };
  const pointers = { default_project: "projects", default_view: "saved_views" };
  for (const field in pointers) {
    const id = next[field];
    if (typeof id !== "string" || id === "" || id === prev[field]) continue;
    let rec = null;
    try {
      rec = app.findRecordById(pointers[field], id);
    } catch (_) {
      rec = null;
    }
    // KEEP IN SYNC: pb_hooks/scope.pb.js guards its project pointers with the same `pick one from the project list` refusal.
    if (rec && field === "default_project" && rec.get("shadow"))
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    // Missing and unreadable answer alike, with PocketBase's own missing-relation code, so the refusal reveals no record.
    if (!rec || !app.canAccessRecord(rec, info, rec.collection().viewRule))
      refuse(
        field,
        "validation_missing_rel_records",
        "Failed to find all relation records with the provided ids.",
      );
  }
  const sent = next.time_zone;
  // KEEP IN SYNC: pb_hooks/counts.pb.js reads a zone the same way, `String(new Timezone(sent).string()) !== sent`.
  if (
    typeof sent === "string" &&
    sent !== "" &&
    sent !== prev.time_zone &&
    (sent === "Local" || String(new Timezone(sent).string()) !== sent)
  )
    refuse(
      "time_zone",
      "validation_invalid_time_zone",
      "The time zone must be an IANA name, such as Europe/Paris.",
    );
}

module.exports = {
  rejectBlankName: rejectBlankName,
  validateDefaultProject: validateDefaultProject,
  validateWorkspacePriorities: validateWorkspacePriorities,
  refuseBlankUserName: refuseBlankUserName,
  validateUserSettings: validateUserSettings,
};

/// <reference path="../pb_data/types.d.ts" />
// W4 (#67) — dual-scope integrity + defaulting hooks. ALL logic INLINED
// per handler (pooled JSVM: no shared top-level helper reachable inside callbacks).
// Loads after main.pb.js (filename order s > m).

// ── DEFAULTING create hooks (register FIRST so the mismatch guard sees filled values) ──

// tasks: workspace := project.workspace when workspace absent but project set
// TASK-080: an unresolvable project leaves workspace unfilled instead of throwing, so the
// mismatch guard below answers 400 (a throw here answered 404).
onRecordCreateRequest((e) => {
  if (!e.record.get("workspace") && e.record.get("project")) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", e.record.get("project"));
    } catch (_) {
      proj = null;
    }
    if (proj) e.record.set("workspace", proj.get("workspace"));
  }
  return e.next();
}, "tasks");

// milestones used to default their project from workspace.default_project here; decision:shadow-project
// gave every item type one placement (pb_hooks/shadow.pb.js) and this one disagreed with it.

// ── MISMATCH guard (D1) — project.workspace must equal record.workspace ─────
// TASK-057/TASK-075: the UNIVERSAL tier, because *Request never fires for a programmatic
// e.app.save() (cron, route handler, hook) — that gap let an incoherent row persist.
// touchesScope: main.pb.js's leaver-unassign sweep wraps its WHOLE loop in one try/catch,
// so a throw on an already-incoherent row strands every remaining assignee (TASK-055).
// original() is stale-EMPTY (not stale-equal) right after a create in the same handler,
// biasing touchesScope TRUE — fail-safe: it fires more often, never less.
// TASK-072: an ENGAGED guard REJECTS an unresolvable project id — save()'s relation
// validation catches that id, saveNoValidate() skips exactly that check. Remaining hole,
// deliberate: a save touching neither scope field passes, so a row already made incoherent
// (project rescoped under it by a superuser) stays saveable.
// KEEP IN SYNC: the blocks below are byte-parallel apart from the collection tag
// and the error-message noun (item / label / template / view).
onRecordCreate((e) => {
  const p = e.record.get("project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "tasks");
onRecordUpdate((e) => {
  const p = e.record.get("project");
  const orig = e.record.original();
  const touchesScope =
    p !== orig.get("project") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (p && touchesScope) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "tasks");
onRecordCreate((e) => {
  const p = e.record.get("project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "decisions");
onRecordUpdate((e) => {
  const p = e.record.get("project");
  const orig = e.record.original();
  const touchesScope =
    p !== orig.get("project") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (p && touchesScope) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "decisions");
onRecordCreate((e) => {
  const p = e.record.get("project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "documents");
onRecordUpdate((e) => {
  const p = e.record.get("project");
  const orig = e.record.original();
  const touchesScope =
    p !== orig.get("project") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (p && touchesScope) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "documents");
onRecordCreate((e) => {
  const p = e.record.get("project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "milestones");
onRecordUpdate((e) => {
  const p = e.record.get("project");
  const orig = e.record.original();
  const touchesScope =
    p !== orig.get("project") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (p && touchesScope) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the item's workspace");
    }
  }
  return e.next();
}, "milestones");
// G1 (#74) — a label bound to a project must live in that project's workspace.
onRecordCreate((e) => {
  const p = e.record.get("project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the label's workspace");
    }
    if (proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "labels");
onRecordUpdate((e) => {
  const p = e.record.get("project");
  const orig = e.record.original();
  const touchesScope =
    p !== orig.get("project") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (p && touchesScope) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the label's workspace");
    }
    if (proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "labels");
// G3 (#74) — a template bound to a project must live in that project's workspace.
onRecordCreate((e) => {
  const p = e.record.get("project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError(
        "project must belong to the template's workspace",
      );
    }
    if (proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "templates");
onRecordUpdate((e) => {
  const p = e.record.get("project");
  const orig = e.record.original();
  const touchesScope =
    p !== orig.get("project") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (p && touchesScope) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError(
        "project must belong to the template's workspace",
      );
    }
    if (proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "templates");
// PBTT-429 — a saved view's optional project filter must live in the view's workspace.
onRecordCreate((e) => {
  const p = e.record.get("project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the view's workspace");
    }
    if (proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "saved_views");
onRecordUpdate((e) => {
  const p = e.record.get("project");
  const orig = e.record.original();
  const touchesScope =
    p !== orig.get("project") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (p && touchesScope) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("project must belong to the view's workspace");
    }
    if (proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "saved_views");

// decision:shadow-project — a personal default project may not be the workspace container; nothing else
// validates this relation, so the whole guard is the shadow refusal.
// KEEP IN SYNC: the same refusal in the labels/templates/saved_views guards above, in
// validateDefaultProject (pb_hooks/main.pb.js) and in the settings route (pb_hooks/user_settings.pb.js).
onRecordCreateRequest((e) => {
  const p = e.record.get("default_project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (proj && proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "user_settings");
onRecordUpdateRequest((e) => {
  const p = e.record.get("default_project");
  if (p) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (proj && proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}, "user_settings");

// ── WORKSPACE immutability (D4) on update — the four items + projects ──
// KEEP IN SYNC: the five blocks below are byte-parallel apart from the collection tag
// (and the projects superuser exemption).
onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("tasks", e.record.id);
  if (orig.get("workspace") !== e.record.get("workspace")) {
    throw new BadRequestError("workspace is immutable");
  }
  return e.next();
}, "tasks");
onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("decisions", e.record.id);
  if (orig.get("workspace") !== e.record.get("workspace")) {
    throw new BadRequestError("workspace is immutable");
  }
  return e.next();
}, "decisions");
onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("documents", e.record.id);
  if (orig.get("workspace") !== e.record.get("workspace")) {
    throw new BadRequestError("workspace is immutable");
  }
  return e.next();
}, "documents");
onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("milestones", e.record.id);
  if (orig.get("workspace") !== e.record.get("workspace")) {
    throw new BadRequestError("workspace is immutable");
  }
  return e.next();
}, "milestones");
// TASK-071 — a project moving between workspaces strands every item still pointing at it.
// Superuser-exempt (explicit-exemption precedent: main.pb.js's R7 account-delete guard):
// closing this for ALL callers would leave no in-room construction for the already-incoherent
// row the D1 predicate above must tolerate, which is the TASK-055/TASK-057 regression trap.
onRecordUpdateRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) return e.next();
  const orig = e.app.findRecordById("projects", e.record.id);
  if (orig.get("workspace") !== e.record.get("workspace")) {
    throw new BadRequestError("workspace is immutable");
  }
  return e.next();
}, "projects");

// ── G1 (#74) E5 — tasks.labels dual-scope: every label must belong to the ────
// task's workspace. labels is a multi-relation → the `labels` collection; a rule
// can't traverse "every submitted relation id's workspace == this task's
// workspace", so a hook does it. wsId resolved as in main.pb.js (own workspace first,
// project.workspace only as the create-time fallback). A cross-workspace or not-found
// label id → 400.
// KEEP IN SYNC: the create + update handlers below are byte-parallel (only the
// registration verb differs). INLINED per handler (pooled JSVM — no shared helper).
onRecordCreateRequest((e) => {
  const labels = e.record.get("labels");
  if (labels && labels.length) {
    const p = e.record.get("project");
    let wsId = e.record.get("workspace");
    if (!wsId && p) {
      try {
        wsId = e.app.findRecordById("projects", p).get("workspace");
      } catch (_) {
        wsId = "";
      }
    }
    if (!wsId) return e.next();
    for (let i = 0; i < labels.length; i++) {
      // bound to `labels`, the field the client submitted, so a form can point at it.
      const bad = {
        labels: new ValidationError(
          "label_not_in_workspace",
          "label must belong to the task's workspace",
        ),
      };
      let label;
      try {
        label = e.app.findRecordById("labels", labels[i]);
      } catch (_) {
        throw new BadRequestError(
          "label must belong to the task's workspace",
          bad,
        );
      }
      if (label.get("workspace") !== wsId) {
        throw new BadRequestError(
          "label must belong to the task's workspace",
          bad,
        );
      }
    }
  }
  return e.next();
}, "tasks");
onRecordUpdateRequest((e) => {
  const labels = e.record.get("labels");
  if (labels && labels.length) {
    const p = e.record.get("project");
    let wsId = e.record.get("workspace");
    if (!wsId && p) {
      try {
        wsId = e.app.findRecordById("projects", p).get("workspace");
      } catch (_) {
        wsId = "";
      }
    }
    if (!wsId) return e.next();
    for (let i = 0; i < labels.length; i++) {
      // bound to `labels`, the field the client submitted, so a form can point at it.
      const bad = {
        labels: new ValidationError(
          "label_not_in_workspace",
          "label must belong to the task's workspace",
        ),
      };
      let label;
      try {
        label = e.app.findRecordById("labels", labels[i]);
      } catch (_) {
        throw new BadRequestError(
          "label must belong to the task's workspace",
          bad,
        );
      }
      if (label.get("workspace") !== wsId) {
        throw new BadRequestError(
          "label must belong to the task's workspace",
          bad,
        );
      }
    }
  }
  return e.next();
}, "tasks");

// G3 (#74) — templateData shape: JSON object (or empty/null) whose top-level keys
// are whitelisted by the template's type. e.record.get() on a json field returns a
// JsonRaw wrapper (typeof "object", Array.isArray() true) even for strings/numbers —
// JSON.parse(String(raw)) FIRST, never branch on the raw wrapper.
// KEEP IN SYNC: the create + update handlers below are byte-parallel (only the
// registration verb differs). INLINED per handler (pooled JSVM — no shared helper).
onRecordCreateRequest((e) => {
  const raw = e.record.get("templateData");
  const s = raw == null ? "" : String(raw);
  if (s.trim() === "") return e.next();
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (_) {
    throw new BadRequestError("templateData must be a JSON object");
  }
  if (parsed === null) return e.next();
  if (Array.isArray(parsed) || typeof parsed !== "object") {
    throw new BadRequestError("templateData must be a JSON object");
  }
  const type = e.record.get("type");
  // KEEP IN SYNC: TEMPLATE_DATA_KEYS (docs/constants.md) — the `TASK_KEYS` / `DOC_KEYS` arrays below
  const TASK_KEYS = [
    "title",
    "description",
    "priority",
    "type",
    "labels",
    "status",
    "assignee",
    "due",
    "milestone",
    "project",
  ];
  const DOC_KEYS = ["title", "body"];
  const allowed = type === "document" ? DOC_KEYS : TASK_KEYS;
  for (const k in parsed) {
    if (allowed.indexOf(k) === -1)
      throw new BadRequestError("templateData has an unknown key: " + k);
  }
  // VALUES, not only keys: a template naming a priority, status, label, milestone,
  // project, assignee or due date the workspace cannot honour is refused HERE, so the refusal
  // reaches the admin who wrote it instead of the member instantiating it later. An EMPTY value
  // stays allowed — a template may deliberately leave a field for the user to fill.
  const wsId = e.record.get("workspace");
  if (!wsId) return e.next();
  const refuse = (field, message) => {
    const bound = {};
    bound["templateData." + field] = new ValidationError(
      "template_data_value",
      message,
    );
    throw new BadRequestError(message, bound);
  };
  const inWorkspace = (collection, id) => {
    try {
      return e.app.findRecordById(collection, id).get("workspace") === wsId;
    } catch (_) {
      return false;
    }
  };
  if (parsed.priority) {
    let ws = null;
    try {
      ws = e.app.findRecordById("workspaces", wsId);
    } catch (_) {
      ws = null;
    }
    // KEEP IN SYNC: validateTaskPriorityWs (pb_hooks/main.pb.js) — the same `"null"` guard: .get() yields a JsonRaw
    // wrapper whose String() is JSON text ("null" when empty), never a native array.
    const rawPriorities = ws === null ? null : ws.get("priorities");
    const priorityText =
      rawPriorities === null || rawPriorities === undefined
        ? ""
        : String(rawPriorities);
    let vocab = [];
    if (priorityText !== "" && priorityText !== "null") {
      try {
        vocab = JSON.parse(priorityText);
      } catch (_) {
        vocab = [];
      }
    }
    let known = false;
    for (let i = 0; Array.isArray(vocab) && i < vocab.length; i++) {
      if (vocab[i] && vocab[i].id === parsed.priority) known = true;
    }
    if (!known) {
      refuse(
        "priority",
        "templateData.priority must be one of the workspace's configured priorities",
      );
    }
  }
  if (parsed.status && !inWorkspace("statuses", parsed.status)) {
    refuse(
      "status",
      "templateData.status must belong to the template's workspace",
    );
  }
  if (parsed.milestone && !inWorkspace("milestones", parsed.milestone)) {
    refuse(
      "milestone",
      "templateData.milestone must belong to the template's workspace",
    );
  }
  if (parsed.project) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", parsed.project);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== wsId) {
      refuse(
        "project",
        "templateData.project must belong to the template's workspace",
      );
    }
    // KEEP IN SYNC: the same refusal in the labels/templates/saved_views/user_settings guards
    // — the container holds the items that belong to no project, so nobody may choose it.
    if (proj.get("shadow")) {
      refuse(
        "project",
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  if (parsed.labels) {
    const ids = Array.isArray(parsed.labels) ? parsed.labels : [parsed.labels];
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] && !inWorkspace("labels", ids[i])) {
        refuse(
          "labels",
          "templateData.labels must belong to the template's workspace",
        );
      }
    }
  }
  if (parsed.assignee) {
    let assignable = false;
    try {
      // KEEP IN SYNC: validateTaskAssignee (pb_hooks/main.pb.js), `user = {:u} && status = 'active'` — the workspace owner is
      // assignable without a roster row, and only an ACTIVE membership counts.
      assignable =
        e.app.findRecordById("workspaces", wsId).get("owner") ===
        parsed.assignee;
    } catch (_) {
      assignable = false;
    }
    if (!assignable) {
      try {
        e.app.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u} && status = 'active'",
          { w: wsId, u: parsed.assignee },
        );
        assignable = true;
      } catch (_) {
        assignable = false;
      }
    }
    if (!assignable) {
      refuse(
        "assignee",
        "templateData.assignee must be an active member of the template's workspace",
      );
    }
  }
  // PocketBase spells a stored date with a space; Date.parse only reads the ISO "T" form.
  if (
    parsed.due &&
    Number.isNaN(Date.parse(String(parsed.due).replace(" ", "T")))
  ) {
    refuse("due", "templateData.due must be a date");
  }
  return e.next();
}, "templates");
onRecordUpdateRequest((e) => {
  const raw = e.record.get("templateData");
  const s = raw == null ? "" : String(raw);
  if (s.trim() === "") return e.next();
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (_) {
    throw new BadRequestError("templateData must be a JSON object");
  }
  if (parsed === null) return e.next();
  if (Array.isArray(parsed) || typeof parsed !== "object") {
    throw new BadRequestError("templateData must be a JSON object");
  }
  const type = e.record.get("type");
  // KEEP IN SYNC: TEMPLATE_DATA_KEYS (docs/constants.md) — the `TASK_KEYS` / `DOC_KEYS` arrays below
  const TASK_KEYS = [
    "title",
    "description",
    "priority",
    "type",
    "labels",
    "status",
    "assignee",
    "due",
    "milestone",
    "project",
  ];
  const DOC_KEYS = ["title", "body"];
  const allowed = type === "document" ? DOC_KEYS : TASK_KEYS;
  for (const k in parsed) {
    if (allowed.indexOf(k) === -1)
      throw new BadRequestError("templateData has an unknown key: " + k);
  }
  // VALUES, not only keys: a template naming a priority, status, label, milestone,
  // project, assignee or due date the workspace cannot honour is refused HERE, so the refusal
  // reaches the admin who wrote it instead of the member instantiating it later. An EMPTY value
  // stays allowed — a template may deliberately leave a field for the user to fill.
  const wsId = e.record.get("workspace");
  if (!wsId) return e.next();
  const refuse = (field, message) => {
    const bound = {};
    bound["templateData." + field] = new ValidationError(
      "template_data_value",
      message,
    );
    throw new BadRequestError(message, bound);
  };
  const inWorkspace = (collection, id) => {
    try {
      return e.app.findRecordById(collection, id).get("workspace") === wsId;
    } catch (_) {
      return false;
    }
  };
  if (parsed.priority) {
    let ws = null;
    try {
      ws = e.app.findRecordById("workspaces", wsId);
    } catch (_) {
      ws = null;
    }
    // KEEP IN SYNC: validateTaskPriorityWs (pb_hooks/main.pb.js) — the same `"null"` guard: .get() yields a JsonRaw
    // wrapper whose String() is JSON text ("null" when empty), never a native array.
    const rawPriorities = ws === null ? null : ws.get("priorities");
    const priorityText =
      rawPriorities === null || rawPriorities === undefined
        ? ""
        : String(rawPriorities);
    let vocab = [];
    if (priorityText !== "" && priorityText !== "null") {
      try {
        vocab = JSON.parse(priorityText);
      } catch (_) {
        vocab = [];
      }
    }
    let known = false;
    for (let i = 0; Array.isArray(vocab) && i < vocab.length; i++) {
      if (vocab[i] && vocab[i].id === parsed.priority) known = true;
    }
    if (!known) {
      refuse(
        "priority",
        "templateData.priority must be one of the workspace's configured priorities",
      );
    }
  }
  if (parsed.status && !inWorkspace("statuses", parsed.status)) {
    refuse(
      "status",
      "templateData.status must belong to the template's workspace",
    );
  }
  if (parsed.milestone && !inWorkspace("milestones", parsed.milestone)) {
    refuse(
      "milestone",
      "templateData.milestone must belong to the template's workspace",
    );
  }
  if (parsed.project) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", parsed.project);
    } catch (_) {
      proj = null;
    }
    if (!proj || proj.get("workspace") !== wsId) {
      refuse(
        "project",
        "templateData.project must belong to the template's workspace",
      );
    }
    // KEEP IN SYNC: the same refusal in the labels/templates/saved_views/user_settings guards
    // — the container holds the items that belong to no project, so nobody may choose it.
    if (proj.get("shadow")) {
      refuse(
        "project",
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  if (parsed.labels) {
    const ids = Array.isArray(parsed.labels) ? parsed.labels : [parsed.labels];
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] && !inWorkspace("labels", ids[i])) {
        refuse(
          "labels",
          "templateData.labels must belong to the template's workspace",
        );
      }
    }
  }
  if (parsed.assignee) {
    let assignable = false;
    try {
      // KEEP IN SYNC: validateTaskAssignee (pb_hooks/main.pb.js), `user = {:u} && status = 'active'` — the workspace owner is
      // assignable without a roster row, and only an ACTIVE membership counts.
      assignable =
        e.app.findRecordById("workspaces", wsId).get("owner") ===
        parsed.assignee;
    } catch (_) {
      assignable = false;
    }
    if (!assignable) {
      try {
        e.app.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u} && status = 'active'",
          { w: wsId, u: parsed.assignee },
        );
        assignable = true;
      } catch (_) {
        assignable = false;
      }
    }
    if (!assignable) {
      refuse(
        "assignee",
        "templateData.assignee must be an active member of the template's workspace",
      );
    }
  }
  // PocketBase spells a stored date with a space; Date.parse only reads the ISO "T" form.
  if (
    parsed.due &&
    Number.isNaN(Date.parse(String(parsed.due).replace(" ", "T")))
  ) {
    refuse("due", "templateData.due must be a date");
  }
  return e.next();
}, "templates");

// ── TASK-079 — comments.parent is a tenant edge, and cascadeDelete gives it teeth ──
// Grafting a comment onto another tenant's thread lets that tenant destroy it by deleting
// the parent. 1785156100 locks parent in comments.updateRule; this is the other half —
// the UNIVERSAL tier, because a superuser bypasses collection rules and a programmatic
// e.app.save() fires no *Request hook. Re-asserts the createRule invariant (same target,
// parent itself top-level), which traverses no relation and so covers a comment on a
// project-less task identically. Predicated on parent CHANGING: a save that leaves it
// alone must not throw on an already-incoherent row (the TASK-055/TASK-057 strand trap).
// Clearing parent stays allowed — unthreading moves no tenant.
onRecordUpdate((e) => {
  const p = e.record.get("parent");
  if (p && p !== e.record.original().get("parent")) {
    let par = null;
    try {
      par = e.app.findRecordById("comments", p);
    } catch (_) {
      par = null;
    }
    if (
      !par ||
      par.get("parent") ||
      par.get("task") !== e.record.get("task") ||
      par.get("document") !== e.record.get("document") ||
      par.get("decision") !== e.record.get("decision")
    ) {
      throw new BadRequestError(
        "parent must be a top-level comment on the same target",
      );
    }
  }
  return e.next();
}, "comments");

// ── TASK-081 — a comment targets AT MOST ONE of task/document/decision, for its whole life ──
// Every comments view/update/delete rule is a disjunction over WHICH target is set, so a
// two-target row is readable and moderable by two tenants at once. comments.createRule
// enforced the XOR at the record's first instant only, and only for rule-bound callers —
// hence the UNIVERSAL tier, which no superuser bypasses and no programmatic e.app.save() skips.
// AT MOST one, not EXACTLY one: the zero-target row is a documented shape denied to every
// actor (TASK-046/TASK-056) whose only construction is a superuser create, and closing that
// would leave the rules proving it nothing to run against.
// Predicated on the target set CHANGING: a save that leaves all three alone must not throw on
// an already-two-target row (the TASK-055/TASK-057 strand trap) — the rule tier locks all
// three fields on update, so a frozen row would have no tenant-reachable repair while its
// moderators still need the body edit and reactions toggle.
// KEEP IN SYNC: the create + update handlers below are byte-parallel apart from the
// registration verb and that predicate. INLINED per handler (pooled JSVM — no shared helper).
onRecordCreate((e) => {
  let targets = 0;
  if (e.record.get("task")) targets++;
  if (e.record.get("document")) targets++;
  if (e.record.get("decision")) targets++;
  if (targets > 1) {
    throw new BadRequestError(
      "a comment must target only one of task, document or decision",
    );
  }
  return e.next();
}, "comments");
onRecordUpdate((e) => {
  let targets = 0;
  if (e.record.get("task")) targets++;
  if (e.record.get("document")) targets++;
  if (e.record.get("decision")) targets++;
  const orig = e.record.original();
  const touchesTarget =
    e.record.get("task") !== orig.get("task") ||
    e.record.get("document") !== orig.get("document") ||
    e.record.get("decision") !== orig.get("decision");
  if (targets > 1 && touchesTarget) {
    throw new BadRequestError(
      "a comment must target only one of task, document or decision",
    );
  }
  return e.next();
}, "comments");

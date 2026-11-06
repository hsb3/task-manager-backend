/// <reference path="../pb_data/types.d.ts" />

// ── G1 (#74) vocabulary hooks: status/labels are now RELATIONS, not JSON ─────
// The old free-text status lived in workspaces.statuses JSON; G1 turned it into a
// relation → the `statuses` collection (pbc_300200002) and added a `completedAt`
// timestamp. These hooks replace the old workspace-JSON status validator. The item
// display number moved to pb_hooks/keys.pb.js (PBTT-422, decision:item-display-keys) — one shared
// per-PROJECT sequence, so the per-workspace counter this file used to own is gone.
// Pooled-JSVM law: everything INLINED per
// site (no shared top-level helper called from inside a callback); a top-level fn
// passed DIRECTLY as the handler is self-contained and legal (house idiom, see
// validateTaskAssignee below). wsId is resolved the same way at every site in this file:
// TASK-071 — the record's OWN workspace wins when populated (on UPDATE it normally is; a
// client CAN submit ""); project.workspace is only a CREATE-time fallback, because scope.pb.js
// (which fills workspace from project) loads after this file and has not run yet.
// TASK-080 — nothing can persist behind an empty-wsId bail: on CREATE the universal coherence
// guard (scope.pb.js) refuses the record; on UPDATE a client CAN submit workspace:"", and the
// D4 immutability guard there refuses that request before this file's update hooks run (no
// superuser exemption; PB's required-field validation sits behind it).
// KEEP IN SYNC: the resolve-then-bail pair is inlined at the three sites below (E1a,
// validateTaskStatusWs, validateTaskAssignee) and at scope.pb.js's E5 label pair.

// INHERIT the parent's project on CREATE when none was submitted (Linear's sub-issue
// behaviour). Registered FIRST in this file so every hook below resolves the workspace from the
// filled project, and on the *Request tier so it lands before shadow.pb.js's universal-tier
// container placement, which would otherwise take a subtask away from its parent's project.
onRecordCreateRequest((e) => {
  const parent = e.record.get("parent");
  if (!e.record.get("project") && parent) {
    try {
      const parentProject = e.app
        .findRecordById("tasks", parent)
        .get("project");
      const proj = parentProject
        ? e.app.findRecordById("projects", parentProject)
        : null;
      const wsId = e.record.get("workspace");
      // A shadow container is never inherited: shadow.pb.js refuses a submitted one and places
      // a project-less child there anyway, so an empty project is the same landing. A parent in
      // another workspace is left empty too, so validateTaskItemRelations names the parent
      // rather than the scope guard naming the project.
      if (
        proj &&
        !proj.get("shadow") &&
        (!wsId || proj.get("workspace") === wsId)
      ) {
        e.record.set("project", proj.id);
      }
    } catch (_) {
      // unresolvable parent or project: leave it empty for validateTaskItemRelations to refuse
    }
  }
  return e.next();
}, "tasks");

// E1a — DEFAULT-FILL status on CREATE only. A bare create (no status submitted)
// inherits the workspace's is_default status (fallback: lowest-position status).
// Registered BEFORE the validate + completedAt hooks so they see the filled value.
onRecordCreateRequest((e) => {
  if (!e.record.get("status")) {
    const project = e.record.get("project");
    let wsId = e.record.get("workspace");
    if (!wsId && project) {
      try {
        wsId = e.app.findRecordById("projects", project).get("workspace");
      } catch (_) {
        wsId = "";
      }
    }
    if (!wsId) return e.next();
    let def;
    try {
      def = e.app.findFirstRecordByFilter(
        "statuses",
        "workspace = {:w} && is_default = true",
        { w: wsId },
      );
    } catch (_) {
      // no is_default row — fall back to the lowest-position status in the workspace
      const rows = e.app.findRecordsByFilter(
        "statuses",
        "workspace = {:w}",
        "position",
        1,
        0,
        { w: wsId },
      );
      if (rows.length) def = rows[0];
    }
    if (def) e.record.set("status", def.id);
  }
  return e.next();
}, "tasks");

// E1b — VALIDATE status belongs to the task's workspace, on CREATE and UPDATE.
// Cross-workspace status (or a bogus/not-found status id) → 400. Self-contained
// top-level fn registered directly for both events (legal — see note above).
function validateTaskStatusWs(e) {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  const statusId = e.record.get("status");
  if (statusId) {
    const project = e.record.get("project");
    let wsId = e.record.get("workspace");
    if (!wsId && project) {
      try {
        wsId = e.app.findRecordById("projects", project).get("workspace");
      } catch (_) {
        wsId = "";
      }
    }
    if (!wsId) return e.next();
    let status;
    try {
      status = e.app.findRecordById("statuses", statusId);
    } catch (_) {
      throw new BadRequestError("status must belong to the task's workspace", {
        status: new ValidationError(
          "status_not_in_workspace",
          "status must belong to the task's workspace",
        ),
      });
    }
    if (status.get("workspace") !== wsId) {
      throw new BadRequestError("status must belong to the task's workspace", {
        status: new ValidationError(
          "status_not_in_workspace",
          "status must belong to the task's workspace",
        ),
      });
    }
  }
  return e.next();
}
onRecordCreateRequest(validateTaskStatusWs, "tasks");
onRecordUpdateRequest(validateTaskStatusWs, "tasks");

// TASK-123 — VALIDATE priority against the task's workspace vocab (workspaces.priorities, a
// JSON array of {id, name}; a task stores the entry id), on CREATE and UPDATE, ONLY when
// priority is submitted-and-changing:
// a task carrying a stale value (vocab entry renamed/removed later) must stay writable on
// unrelated fields, so this checks the SUBMITTED value against original(), never the
// stored value alone. Empty/unset priority is always allowed. Self-contained top-level fn
// registered directly for both events (legal — see note above validateTaskStatusWs).
function validateTaskPriorityWs(e) {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  const priority = e.record.get("priority");
  const touchesPriority = priority !== e.record.original().get("priority");
  if (priority && touchesPriority) {
    const project = e.record.get("project");
    let wsId = e.record.get("workspace");
    if (!wsId && project) {
      try {
        wsId = e.app.findRecordById("projects", project).get("workspace");
      } catch (_) {
        wsId = "";
      }
    }
    if (!wsId) return e.next();
    let ws;
    try {
      ws = e.app.findRecordById("workspaces", wsId);
    } catch (_) {
      return e.next();
    }
    // .get("priorities") is a JsonRaw wrapper, not a native array — String(v) yields its
    // JSON text ("null" when empty); parse defensively (see notify.pb.js's reactions parse).
    const raw = ws.get("priorities");
    const s = raw === null || raw === undefined ? "" : String(raw);
    let vocab = [];
    if (s !== "" && s !== "null") {
      try {
        vocab = JSON.parse(s);
      } catch (_) {
        vocab = [];
      }
    }
    let known = false;
    for (let i = 0; Array.isArray(vocab) && i < vocab.length; i++) {
      if (vocab[i] && vocab[i].id === priority) known = true;
    }
    if (!known) {
      // bound to the offending field, so a client instantiating a template can point at
      // the input rather than showing a sentence with nothing attached to it.
      throw new BadRequestError(
        "priority must be one of the workspace's configured priorities",
        {
          priority: new ValidationError(
            "priority_not_in_vocabulary",
            "priority must be one of the workspace's configured priorities",
          ),
        },
      );
    }
  }
  return e.next();
}
onRecordCreateRequest(validateTaskPriorityWs, "tasks");
onRecordUpdateRequest(validateTaskPriorityWs, "tasks");

// E4 — completedAt lifecycle, driven by the NEW status's category.
// CREATE: completedAt is server-owned — resolve the (defaulted or submitted) status
// category; completed-category STAMPS now, anything else (non-completed / no status /
// unresolvable id) CLEARS a caller-submitted value. Registered AFTER E1a so the final
// status is known. Mirrors the UPDATE hook below.
onRecordCreateRequest((e) => {
  const statusId = e.record.get("status");
  let cat = "";
  if (statusId) {
    try {
      cat = e.app.findRecordById("statuses", statusId).get("category");
    } catch (_) {
      /* bogus status id already rejected by E1b */
    }
  }
  if (cat === "completed") {
    e.record.set("completedAt", new Date().toISOString().replace("T", " "));
  } else {
    e.record.set("completedAt", "");
  }
  return e.next();
}, "tasks");
// UPDATE: compare the ORIGINAL (persisted) status category to the new one. Crossing
// INTO completed stamps completedAt=now; crossing OUT clears it. original() returns
// persisted values (unsubmitted fields keep their stored value on the merged record).
onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  const newStatusId = e.record.get("status");
  const origStatusId = e.record.original().get("status");
  let newCat = "";
  let origCat = "";
  if (newStatusId) {
    try {
      newCat = e.app.findRecordById("statuses", newStatusId).get("category");
    } catch (_) {}
  }
  if (origStatusId) {
    try {
      origCat = e.app.findRecordById("statuses", origStatusId).get("category");
    } catch (_) {}
  }
  // decision:server-owned-fields-locked: only a request that crosses the completed boundary may carry completedAt, and the server's value wins.
  // A superuser is exempt so an operator can correct a stored timestamp.
  if (
    !e.hasSuperuserAuth() &&
    Object.prototype.hasOwnProperty.call(
      e.requestInfo().body || {},
      "completedAt",
    ) &&
    (origCat === "completed") === (newCat === "completed")
  ) {
    const msg =
      "completedAt cannot be sent; the server sets it when the status changes.";
    throw new BadRequestError(msg, {
      completedAt: new ValidationError("validation_failed", msg),
    });
  }
  if (origCat !== "completed" && newCat === "completed") {
    e.record.set("completedAt", new Date().toISOString().replace("T", " "));
  } else if (origCat === "completed" && newCat !== "completed") {
    e.record.set("completedAt", "");
  }
  return e.next();
}, "tasks");

// ── Event hook: a task's assignee must be a member of its workspace ──────────
// Module 14 opens tasks to workspace members but restricts ASSIGNMENT to members.
// A rule can't cleanly express "the submitted `assignee` is a member of the
// submitted `project`'s workspace", and — decisive — a rule denial on UPDATE gives
// a 404, not the 400 the AC demands. So a validation hook throws BadRequestError
// (→ 400 on both create and update): read `assignee`; if set, walk project →
// workspace and look up a workspace_members row for (workspace, assignee). If none
// exists, reject. decision:tasks-have-no-default-assignee: an item created without an assignee is Unassigned —
// nothing fills the field, so an empty assignee is simply never validated.
function validateTaskAssignee(e) {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  const assignee = e.record.get("assignee");
  // Only an assignee CHANGE is validated (original() is empty on create, so a create always
  // validates): re-checking an untouched assignee would 400 every unrelated edit to a task
  // whose assignee has since been suspended (PBTT-431).
  if (assignee && assignee !== e.record.original().get("assignee")) {
    const project = e.record.get("project");
    let workspaceId = e.record.get("workspace");
    if (!workspaceId && project) {
      try {
        workspaceId = e.app
          .findRecordById("projects", project)
          .get("workspace");
      } catch (_) {
        workspaceId = "";
      }
    }
    if (!workspaceId) return e.next();
    // The workspace OWNER is assignable on ownership alone, whatever their roster row says
    // (the API rules already treat the owner specially the same way).
    const workspace = e.app.findRecordById("workspaces", workspaceId);
    if (workspace.get("owner") === assignee) {
      return e.next();
    }
    let isMember = false;
    try {
      // KEEP IN SYNC: the workspace_members active-status law the collections snapshot's rules carry
      // — a suspended membership is not assignable (PBTT-431).
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && status = 'active'",
        { w: workspaceId, u: assignee },
      );
      isMember = true;
    } catch (_) {
      isMember = false;
    }
    if (!isMember) {
      throw new BadRequestError(
        "assignee must be a member of the task's workspace",
        {
          assignee: new ValidationError(
            "assignee_not_active_member",
            "assignee must be a member of the task's workspace",
          ),
        },
      );
    }
  }
  return e.next();
}
onRecordCreateRequest(validateTaskAssignee, "tasks");
onRecordUpdateRequest(validateTaskAssignee, "tasks");

// ── TASK-008.05 — item-relation invariants (parent / milestone / blocked_by) ──
// api-contract §1: the SERVER owns these. A rule can't traverse "the submitted
// relation's project == this task's project" on v0.39, and a rule denial on UPDATE
// gives 404 where the matrix wants 400 — so a validation hook throws message-only
// BadRequestError (400 on create AND update), mirroring validateTaskStatusWs.
//
// SAME-SCOPE semantics (documented + tested): a referenced record is in scope iff it
// shares this task's PROJECT and WORKSPACE. With a project present, project-equality
// alone implies the same workspace (a project belongs to one workspace); a project-less
// (workspace-scoped, D2) task may only reference project-less records in its OWN
// workspace. Ordering-critical: scope.pb.js (loads AFTER this file) defaults
// workspace := project.workspace, so at THIS hook the workspace field may be unfilled
// when a project was submitted — therefore key off the SUBMITTED project when present
// and only read the workspace field on the project-less branch, where the client
// submits it directly (workspace is required). tProject/tWs read from the merged record
// (persisted values on update, submitted on create).
// BOUND: full transitive A->B->A cycle detection is OUT; blocked_by is checked only
// against this task's DIRECT children (one findRecordsByFilter) per the contract's
// "never contains a child of this item".
function validateTaskItemRelations(e) {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  const selfId = e.record.id;
  let tProject = e.record.get("project");
  const tWs = e.record.get("workspace");
  // Compare against where the record will LAND, not what it submitted: a write carrying no
  // project is placed in its workspace's shadow project a moment later, so a bare `project`
  // read here reports "" for both a real project-less row and one about to be placed.
  // KEEP IN SYNC: pb_hooks/shadow.pb.js owns that placement and this `workspace = {:w} && shadow = true` filter.
  if (!tProject && tWs) {
    try {
      tProject = e.app.findFirstRecordByFilter(
        "projects",
        "workspace = {:w} && shadow = true",
        { w: tWs },
      ).id;
    } catch (_) {
      // no shadow project resolvable: leave tProject empty and take the pre-existing branch
    }
  }
  // every refusal below is bound to the relation field that broke, so a client can point
  // at the input instead of showing a sentence attached to nothing.
  const refuse = (field, message) => {
    const bound = {};
    bound[field] = new ValidationError("relation_out_of_scope", message);
    throw new BadRequestError(message, bound);
  };
  const parent = e.record.get("parent");
  if (parent) {
    if (parent === selfId) refuse("parent", "a task cannot be its own parent");
    let p;
    try {
      p = e.app.findRecordById("tasks", parent);
    } catch (_) {
      refuse("parent", "parent must be in the same project");
    }
    if (tProject) {
      if (p.get("project") !== tProject)
        refuse("parent", "parent must be in the same project");
    } else if (p.get("project") !== "" || p.get("workspace") !== tWs) {
      refuse("parent", "parent must be in the same project");
    }
  }
  const milestone = e.record.get("milestone");
  if (milestone) {
    let m;
    try {
      m = e.app.findRecordById("milestones", milestone);
    } catch (_) {
      refuse("milestone", "milestone must be in the same project");
    }
    if (tProject) {
      if (m.get("project") !== tProject)
        refuse("milestone", "milestone must be in the same project");
    } else if (m.get("project") !== "" || m.get("workspace") !== tWs) {
      refuse("milestone", "milestone must be in the same project");
    }
  }
  const deps = e.record.get("dependencies");
  if (deps && deps.length) {
    // direct children only (bound above). selfId guard: skip the query when the id is
    // absent — on create the task is unsaved (no children exist) and a "parent = ''"
    // filter would spuriously match every top-level task.
    const childIds = {};
    if (selfId) {
      try {
        const kids = e.app.findRecordsByFilter(
          "tasks",
          "parent = {:id}",
          "",
          0,
          0,
          { id: selfId },
        );
        for (const k of kids) childIds[k.id] = true;
      } catch (_) {
        /* no children */
      }
    }
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i];
      if (dep === selfId) refuse("dependencies", "a task cannot block itself");
      if (parent && dep === parent)
        refuse("dependencies", "parent cannot also be a blocker");
      if (childIds[dep])
        refuse("dependencies", "a blocker cannot be a subtask of this task");
      let d;
      try {
        d = e.app.findRecordById("tasks", dep);
      } catch (_) {
        refuse("dependencies", "blocked_by must be in the same project");
      }
      if (tProject) {
        if (d.get("project") !== tProject)
          refuse("dependencies", "blocked_by must be in the same project");
      } else if (d.get("project") !== "" || d.get("workspace") !== tWs) {
        refuse("dependencies", "blocked_by must be in the same project");
      }
    }
  }
  return e.next();
}
onRecordCreateRequest(validateTaskItemRelations, "tasks");
onRecordUpdateRequest(validateTaskItemRelations, "tasks");

// ── Event hook: auto-provision a default workspace + project on user creation ─
// Fresh accounts (open signup wave 4, approval gate wave 11) had no workspace —
// the m10 backfill only seeded workspaces for owners of projects existing at
// migration time (decision:auto-provision-workspace), so every account minted
// since dead-ended with no board (#36). This hook is that backfill's find-or-create
// loop for the RUNTIME cohort: when a users record is created, give it a default
// workspace (owner.pb.js gives it the owner's admin row) + a default project (#57 — without a project a fresh
// approved account still lands on an empty board until it finds Settings → project
// CRUD; the default project heals that).
//
// Event choice (R1, live-verified 2026-07-26 on v0.39.9): onRecordAfterCreateSuccess
// fires after ANY committed users create — API signup (auth.ts → users().create()),
// OAuth first-signup (minted inside the OAuth exchange, NOT the record-create request
// pipeline, so onRecordCreateRequest would miss it), and superuser seed — from a
// SINGLE registration. It runs after persistence, so e.record.id (needed for
// workspace.owner) is committed. An OAuth *link* reuses an existing user and creates
// no new record, so it never re-fires — correct (the linked account already owns a
// workspace from its original signup).
//
// Idempotent (find-or-create by owner: retries, double-fires, and re-fires all no-op)
// and defensive (the inner try/catch means a provisioning failure is logged, never
// fatal — the account still exists and the owner can approve it). Provisioning runs
// as system (bypasses rules) and never reads approved/verified, so it is safe before
// the approval gate flips: the workspace is owner-scoped and unreachable until the
// user is approved and can authenticate. Logger output lands in pb_data/auxiliary.db
// _logs (dashboard Logs view), NOT stdout. Collection ids: workspaces pbc_300100001,
// workspace_members pbc_300100002, projects pbc_484305853.
//
// #38 forward-compat: the user is both owner AND (owner.pb.js) a roster admin; the
// validateTaskAssignee short-circuit on workspace.owner keeps a self-assignment
// working with or without the membership row — do NOT remove that short-circuit.
//
// W1 (#64, deliverable D3): the last-workspace auto-provision hook (see D3
// further down) needs to run this EXACT same workspace+membership+project
// creation. A top-level helper function was tried first and PROVEN NOT to work:
// booting a clean room and calling a module-top-level `provisionDefaultWorkspace`
// from inside this callback threw `ReferenceError: provisionDefaultWorkspace is
// not defined` (caught by the outer try/catch, logged to auxiliary.db _logs) —
// confirming the isolation warning above (main.pb.js:21-25) DOES apply to
// top-level fns called from within a callback in the SAME file, not just across
// separate hook files. So this block stays INLINED per the file's established
// idiom (see validateTaskStatus's inlined JSON decode, main.pb.js:21-25), and
// D3 below carries a byte-identical copy. Keep the two blocks in sync by hand if
// either changes — cross-referenced by comment at both sites.
onRecordAfterCreateSuccess((e) => {
  try {
    const uid = e.record.id;
    // idempotent: skip if this user already owns a workspace
    e.app.findFirstRecordByFilter("workspaces", "owner = {:o}", { o: uid });
  } catch (_) {
    try {
      const wsCol = e.app.findCollectionByNameOrId("pbc_300100001"); // workspaces
      const projCol = e.app.findCollectionByNameOrId("pbc_484305853"); // projects
      const ws = new Record(wsCol);
      ws.set("name", "My Workspace");
      ws.set("owner", e.record.id);
      // decision:default-priority-vocabulary: left EMPTY on purpose — the seeder below fills the default vocab,
      // so the four values exist at exactly ONE site instead of four drifting copies.
      ws.set("priorities", []);
      e.app.save(ws);
      // G1 (#74) + decision:default-priority-vocabulary: default vocab (5 statuses + 3 core labels + priorities) is
      // seeded by the single onRecordAfterCreateSuccess("workspaces") seeder above — which
      // fires on THIS programmatic e.app.save(ws) too — so NO inline seeding here.
      // #57: seed a default project so the board is never empty on first login. We
      // only reach here when the user owned NO workspace (outer guard), so the
      // workspace above is brand-new and has zero projects — creating one here is
      // idempotent by construction (a re-fire hits the outer guard and skips the
      // whole block, leaving exactly one project). owner = the user (project rules
      // are owner-only, m14); workspace = the just-provisioned workspace.
      const proj = new Record(projCol);
      proj.set("name", "My Project");
      proj.set("owner", e.record.id);
      proj.set("workspace", ws.id);
      e.app.save(proj);
      // W2 (#65): point the fresh workspace at its default project. This
      // programmatic save does NOT fire the default_project guard hook below
      // (Request hooks only fire on the API pipeline, never on app.save()).
      ws.set("default_project", proj.id);
      e.app.save(ws);
      // W2 (#65): provision the user's 1:1 settings row. GUARDED find-first so it
      // stays idempotent across ALL THREE provision sites (a user re-provisioned via
      // the last-workspace hook must NOT get a second user_settings row). Keep this
      // block byte-identical to the copy in the last-workspace hook below AND the
      // W3 last-workspace-TRASH reprovision in pb_hooks/trash.pb.js.
      try {
        e.app.findFirstRecordByFilter("user_settings", "user = {:u}", {
          u: e.record.id,
        });
      } catch (_) {
        const usCol = e.app.findCollectionByNameOrId("pbc_300100008"); // user_settings
        const us = new Record(usCol);
        us.set("user", e.record.id);
        us.set("theme", "system");
        us.set("font", "system");
        e.app.save(us);
      }
    } catch (err) {
      e.app
        .logger()
        .error(
          "workspace auto-provision failed",
          "user",
          e.record.id,
          "err",
          String(err),
        );
    }
  }
  e.next();
}, "users");

// ── Event hook: unassign a leaver's tasks (D1, D10 invariant) ────────────────
// A member/admin who leaves a workspace (self-leave or removal by owner/admin —
// see workspace_members.deleteRule) may still be the assignee on tasks in that
// workspace's projects; leaving a stale assignment on someone with no more
// access is a correctness bug, so clear it. Fires
// AFTER the membership row is actually gone (onRecordAfterDeleteSuccess), and
// uses a programmatic save (e.app.save), which bypasses the validateTaskAssignee
// REQUEST hook above (main.pb.js:62-95, only fires on onRecord*Request) — so
// clearing assignee here is legal even though a member-submitted PATCH with an
// empty assignee is not otherwise special-cased.
//
// Also fires (harmlessly) on CASCADE-driven deletes: deleting a workspace
// cascades its workspace_members rows (1785100100:29) and its tasks in the same
// transaction, so the filter below may match nothing or race a task mid-delete;
// deleting a user cascades similarly. Both are no-ops by construction — the
// try/catch absorbs any error from a half-deleted graph. The hook is only
// materially meaningful on a genuine self-leave/removal where the workspace and
// its tasks survive.
onRecordAfterDeleteSuccess((e) => {
  try {
    const ws = e.record.get("workspace");
    const uid = e.record.get("user");
    // TASK-055: filter on the task's OWN required workspace, not project.workspace —
    // the latter collapses to empty for a project-less task, leaving a departed member assigned.
    const tasks = e.app.findRecordsByFilter(
      "tasks",
      "workspace = {:w} && assignee = {:u}",
      "",
      0,
      0,
      { w: ws, u: uid },
    );
    for (const t of tasks) {
      t.set("assignee", "");
      e.app.save(t);
    }
  } catch (_) {
    // defensive, like the auto-provision block above: absorb cascade races.
  }
  e.next();
}, "workspace_members");

// ── Event hook: R7 account-delete guard (D2) ──────────────────────────────────
// users.deleteRule is stock self-only (`id = @request.auth.id`,
// schema/users.rules.json), so a rule alone can't see "does this user own a
// workspace that has OTHER members" — that requires a cross-collection lookup,
// which is a hook's job. Block a regular user's self-delete if it would silently
// destroy a workspace that other people depend on (cascade would delete the
// workspace, its members, projects, tasks, etc. out from under them).
//
// Scope: ONLY genuine self-delete by a regular (non-superuser) user —
// `e.auth && e.auth.id === e.record.id`. Superusers bypass API rules entirely
// and must still be able to delete junk/test accounts regardless of what those
// accounts own, so also skip when the caller is a superuser (e.auth belongs to
// the `_superusers` collection in that case, not `users` — isSuperuser() is the
// authoritative check rather than comparing e.auth.id, since a superuser's own
// id never equals a `users` record id anyway, but this makes the intent explicit
// and future-proofs against a superuser somehow having a `users` shadow row).
//
// Live-verified (Risky Claim R-2, rehearsed 2026-07-27): throwing BadRequestError
// inside onRecordDeleteRequest("users") vetoes the delete with 400; the user and
// workspace survive. A solo self-delete (no other members in any owned
// workspace) returns e.next() and cascades clean.
onRecordDeleteRequest((e) => {
  if (e.auth && !e.auth.isSuperuser() && e.auth.id === e.record.id) {
    const uid = e.record.id;
    const ownedWorkspaces = e.app.findRecordsByFilter(
      "workspaces",
      "owner = {:o}",
      "",
      0,
      0,
      { o: uid },
    );
    const blocking = [];
    // KEEP IN SYNC: sole-owner test with pb_hooks/signup_purge.pb.js `workspace = {:w} && user != {:u}`
    for (const ws of ownedWorkspaces) {
      let hasOtherMember = true;
      try {
        e.app.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user != {:u}",
          { w: ws.id, u: uid },
        );
      } catch (_) {
        // findFirstRecordByFilter threw "not found" — no other member in this
        // owned workspace.
        hasOtherMember = false;
      }
      if (hasOtherMember) {
        blocking.push(ws);
      }
    }
    if (blocking.length) {
      // Both remedies the first message names are themselves refused while a workspace sits in
      // the trash (configuration freeze, 1785172900), so a caller told to take one of them has
      // nowhere to go — name the step that reopens them instead.
      let allInTrash = true;
      for (const ws of blocking) {
        if (String(ws.get("trashed")) === "") allInTrash = false;
      }
      throw new BadRequestError(
        allInTrash
          ? "cannot delete account: you are the sole owner of a workspace in the trash " +
              "that has other members — restore it first, then hand it to someone else or " +
              "remove the other members"
          : "cannot delete account: you are the sole owner of a workspace that " +
              "has other members — transfer ownership or remove the other members " +
              "first",
      );
    }
  }
  return e.next();
}, "users");

// ── Event hook: last-workspace auto-provision (D3, D12i final ruling) ────────
// Final ruling: no last-workspace protection — a user may delete their own last
// workspace via the ordinary owner-only workspaces.deleteRule. But an account
// with zero workspaces dead-ends on an empty board (same problem #57 solved for
// fresh signups), so re-run the exact same provisioning helper used above.
//
// GUARD: findRecordById("users", ownerId) in a try/catch, and RETURN if the
// owner is gone. This is what makes the hook safe under account-cascade deletes
// (Risky Claim R-3, rehearsed 2026-07-27): deleting a user's account cascades
// its owned workspaces (1785100000:44-54) in the SAME transaction, so this
// after-delete hook fires once per cascaded workspace too — WITHOUT the guard it
// would wrongly re-provision a fresh orphan workspace owned by a user who no
// longer exists. R-3 confirmed PB's cascade is PARENT-FIRST: the `users` record
// is already gone by the time this hook fires for a cascaded workspace, so
// findRecordById throws and the guard returns early — no orphan. On a genuine
// own-last-workspace delete (workspace deleted while the user is alive), the
// user is found, no other workspace exists for them, and exactly one fresh
// workspace is (re-)provisioned.
//
// The provisioning body is a byte-identical INLINED copy of the block in the
// users-create hook above (main.pb.js:129-175) — NOT a shared top-level helper
// call. A shared helper was tried and proven broken by boot-testing (see the
// comment above the users-create hook); PocketBase's pooled JSVM does not make
// a module-top-level function callable from inside a registered hook callback.
// Keep all THREE copies in sync by hand if any changes: this hook, the users-create
// hook above, and the W3 last-workspace-TRASH reprovision in pb_hooks/trash.pb.js.
onRecordAfterDeleteSuccess((e) => {
  const ownerId = e.record.get("owner");
  let owner;
  try {
    owner = e.app.findRecordById("users", ownerId);
  } catch (_) {
    // owner is gone (cascade-driven delete) — nothing to re-provision for.
    e.next();
    return;
  }
  try {
    // idempotent: skip if the owner already has another LIVE workspace. A trashed one does not
    // count — it is excluded from every list surface, so leaving the owner with only that is the
    // empty-app dead end this hook exists to prevent.
    e.app.findFirstRecordByFilter(
      "workspaces",
      "owner = {:o} && trashed = ''",
      {
        o: owner.id,
      },
    );
  } catch (_) {
    try {
      const wsCol = e.app.findCollectionByNameOrId("pbc_300100001"); // workspaces
      const projCol = e.app.findCollectionByNameOrId("pbc_484305853"); // projects
      const ws = new Record(wsCol);
      ws.set("name", "My Workspace");
      ws.set("owner", owner.id);
      // decision:default-priority-vocabulary: left EMPTY on purpose — the seeder below fills the default vocab,
      // so the four values exist at exactly ONE site instead of four drifting copies.
      ws.set("priorities", []);
      e.app.save(ws);
      // G1 (#74) + decision:default-priority-vocabulary: default vocab (5 statuses + 3 core labels + priorities) is
      // seeded by the single onRecordAfterCreateSuccess("workspaces") seeder above — which
      // fires on THIS programmatic e.app.save(ws) too — so NO inline seeding here.
      const proj = new Record(projCol);
      proj.set("name", "My Project");
      proj.set("owner", owner.id);
      proj.set("workspace", ws.id);
      e.app.save(proj);
      // W2 (#65): byte-identical copy of the users-create hook's block above
      // (main.pb.js — kept in sync by hand; same reasoning applies here).
      ws.set("default_project", proj.id);
      e.app.save(ws);
      try {
        e.app.findFirstRecordByFilter("user_settings", "user = {:u}", {
          u: owner.id,
        });
      } catch (_) {
        const usCol = e.app.findCollectionByNameOrId("pbc_300100008"); // user_settings
        const us = new Record(usCol);
        us.set("user", owner.id);
        us.set("theme", "system");
        us.set("font", "system");
        e.app.save(us);
      }
    } catch (err) {
      e.app
        .logger()
        .error(
          "last-workspace auto-provision failed",
          "user",
          owner.id,
          "err",
          String(err),
        );
    }
  }
  e.next();
}, "workspaces");

// ── Event hook: default_project must belong to THIS workspace (W2 #65, D2) ──
// The value guard is a HOOK, not a rule: a rule traversing @request.body's
// submitted relation id is unproven on v0.39.9, and a rule denial on update
// yields 404 where the matrix wants an explicit 400. WHO-may-edit stays the W1
// updateRule (owner/admin); this hook only validates the VALUE. A programmatic
// app.save (provision/backfill) never reaches here — Request hooks fire only on
// the API pipeline. Live-verified (RC-2): cross-workspace -> 400, own -> 200.
function validateDefaultProject(e) {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  require(`${__hooks}/lib/workspace_rules.js`).validateDefaultProject(
    e.app,
    e.record,
  );
  return e.next();
}
onRecordCreateRequest(validateDefaultProject, "workspaces");
onRecordUpdateRequest(validateDefaultProject, "workspaces");

// ── PBTT-384 — the priority vocabulary is validated element-by-element ───────
// Request-tier like validateDefaultProject above: only an HTTP write carries an
// arbitrary payload. The programmatic e.app.save() writers of this field (the two
// provision blocks, trash.pb.js's reprovision, the afterCreate seeder below,
// 1785156600's backfill) write repo-controlled literals and are NOT covered here.
// Checked only when the value is submitted-and-changing — a workspace holding a
// pre-guard vocabulary must stay writable on unrelated fields (mirrors
// validateTaskPriorityWs). Changing it to null/absent is legal only on CREATE, where
// the seeder below fills in the defaults; on UPDATE it is refused like `[]`.
// Three ruled edges: an exact duplicate entry is
// REFUSED (the sibling vocabularies, statuses/labels, already refuse a repeated name
// per workspace via a UNIQUE index); a case VARIANT of another entry is ACCEPTED, since
// those same indexes are binary-collated and admit "High" alongside "high"; and a case
// variant of the reserved unset token is REFUSED, because a reserved word is reserved as
// a word — "None" would otherwise become a real vocabulary entry rendered beside the
// built-in clear column.
function validateWorkspacePriorities(e) {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  require(`${__hooks}/lib/workspace_rules.js`).validateWorkspacePriorities(
    e.record,
  );
  return e.next();
}
onRecordCreateRequest(validateWorkspacePriorities, "workspaces");
onRecordUpdateRequest(validateWorkspacePriorities, "workspaces");

// ── G1 (#74) E7 — core labels cannot be deleted ─────────────────────────────
// The core labels (Bug/Feature/Improvement) are seeded per workspace and are
// permanent vocabulary. Block their delete with a 400 — intentionally including
// superusers (a rule can't see the `core` flag pre-delete; this is a hook's job).
// Custom (core=false) labels delete normally; PB natively strips a deleted label
// id from referencing tasks because tasks.labels has cascadeDelete=false (no strip
// hook needed).
onRecordDeleteRequest((e) => {
  if (e.record.get("core") === true) {
    throw new BadRequestError("core labels cannot be deleted");
  }
  return e.next();
}, "labels");

// ── G1 (#74) E8 — a status still referenced by a task cannot be deleted ──────
// findFirstRecordByFilter throws when nothing matches: a FOUND task means the
// status is in use → 400; a not-found throw means it is unreferenced → deletable
// (including an is_default status once no task points at it).
onRecordDeleteRequest((e) => {
  try {
    e.app.findFirstRecordByFilter("tasks", "status = {:s}", { s: e.record.id });
  } catch (_) {
    return e.next(); // unreferenced -> deletable
  }
  throw new BadRequestError(
    "cannot delete a status still referenced by a task",
  );
}, "statuses");

// ── 3k7z — label/status names are trimmed before the UNIQUE name index sees them ──
// Model tier so the vocab route's txApp.save is covered; an unchanged legacy padded name is left alone.
function trimVocabName(e) {
  const name = e.record.get("name");
  if (typeof name === "string" && name !== e.record.original().get("name")) {
    const trimmed = name.trim();
    if (trimmed !== name) e.record.set("name", trimmed);
  }
  return e.next();
}
onRecordCreate(trimVocabName, "labels");
onRecordUpdate(trimVocabName, "labels");
onRecordCreate(trimVocabName, "statuses");
onRecordUpdate(trimVocabName, "statuses");

// ── G1 (#74) — EVERY workspace gets its default board (5 statuses + 3 core labels + the priority vocab) ──
// Vocab seeding lives HERE (a single collection-level seeder), NOT only inside the
// user-lifecycle provision blocks, so a workspace created by ANY path is seeded:
// user-provision, last-workspace/trash reprovision, OR a DIRECT API POST (a user's
// 2nd workspace, which the provision blocks never touch).
//
// onRecordAfterCreateSuccess is a PERSISTENCE-level hook (unlike the *Request hooks,
// which are API-only), so it fires on BOTH API creates AND programmatic
// e.app.save(new Record) — including the workspace created via e.app.save() inside
// the users-create/last-workspace/trash provision blocks. EMPIRICALLY CONFIRMED in a
// clean room (2026-07-27): a user's provisioned workspace, created programmatically
// inside the users onRecordAfterCreateSuccess hook, reaches this hook and gets seeded
// exactly once — so the provision blocks carry NO inline vocab seeding anymore (they
// keep only the dead-JSON strip).
//
// IDEMPOTENT: skip if the workspace already has ANY status. The statuses/labels
// (workspace,name) unique index would make a double-seed throw, so the guard is
// load-bearing (a re-fire, or a path that already seeded, must no-op). Constants
// INLINED (pooled JSVM: no shared top-level helper). // KEEP IN SYNC (provision vocab seed)
onRecordAfterCreateSuccess((e) => {
  try {
    e.app.findFirstRecordByFilter("statuses", "workspace = {:w}", {
      w: e.record.id,
    });
    // already seeded -> idempotent no-op
  } catch (_) {
    try {
      const _defStatuses = [
        ["Backlog", "backlog", "gray", true],
        ["Todo", "unstarted", "blue", false],
        ["In Progress", "started", "yellow", false],
        ["Done", "completed", "green", false],
        ["Canceled", "canceled", "gray", false],
      ]; // [name,category,color,is_default], position = index
      const _coreLabels = [
        ["Bug", "red"],
        ["Feature", "purple"],
        ["Improvement", "green"],
      ]; // [name,color], core=true
      const _stCol = e.app.findCollectionByNameOrId("pbc_300200002"); // statuses
      for (let _i = 0; _i < _defStatuses.length; _i++) {
        const _s = new Record(_stCol);
        _s.set("workspace", e.record.id);
        _s.set("name", _defStatuses[_i][0]);
        _s.set("category", _defStatuses[_i][1]);
        _s.set("color", _defStatuses[_i][2]);
        _s.set("is_default", _defStatuses[_i][3]);
        _s.set("position", _i);
        e.app.save(_s);
      }
      const _lbCol = e.app.findCollectionByNameOrId("pbc_300200001"); // labels
      for (let _j = 0; _j < _coreLabels.length; _j++) {
        const _l = new Record(_lbCol);
        _l.set("workspace", e.record.id);
        _l.set("name", _coreLabels[_j][0]);
        _l.set("color", _coreLabels[_j][1]);
        _l.set("core", true);
        e.app.save(_l);
      }
    } catch (err) {
      e.app
        .logger()
        .error(
          "workspace vocab seed failed",
          "workspace",
          e.record.id,
          "err",
          String(err),
        );
    }
  }
  // TASK-153/decision:default-priority-vocabulary — priorities carry their OWN emptiness check: the statuses guard
  // above is not a proxy for them (a pre-decision:default-priority-vocabulary row can have statuses and no vocab).
  try {
    // .get("priorities") is a JsonRaw wrapper, not a native array (see main.pb.js:107-109).
    const _raw = e.record.get("priorities");
    const _s = _raw === null || _raw === undefined ? "" : String(_raw);
    let _vocab = [];
    if (_s !== "" && _s !== "null") {
      try {
        _vocab = JSON.parse(_s);
      } catch (_) {
        _vocab = [];
      }
    }
    if (!Array.isArray(_vocab) || _vocab.length === 0) {
      // KEEP IN SYNC (default priority vocab): the app_docs record decision:default-priority-vocabulary states these four names, listed in docs/constants.md where `urgent` heads them.
      const _defaultPriorityNames = ["urgent", "high", "medium", "low"];
      e.record.set(
        "priorities",
        _defaultPriorityNames.map((name) => ({
          id: $security.randomStringWithAlphabet(
            15,
            "abcdefghijklmnopqrstuvwxyz0123456789",
          ),
          name: name,
        })),
      );
      e.app.save(e.record);
    }
  } catch (err) {
    e.app
      .logger()
      .error(
        "workspace priorities seed failed",
        "workspace",
        e.record.id,
        "err",
        String(err),
      );
  }
  e.next();
}, "workspaces");

// ── Custom route: per-user summary, computed server-side ────────────────────
// One round-trip instead of the client fetching every task and counting.
// $apis.requireAuth() middleware -> e.auth is the logged-in user record.
require(`${__hooks}/lib/routes.js`).add("GET /api/tracker/summary", (e) => {
  const uid = e.auth.id;
  // KEEP IN SYNC: the membership and trash clauses of tasks.listRule; the personal scope (my projects or assigned to me) narrows them, never replaces them
  const tasks = e.app.findRecordsByFilter(
    "tasks",
    // project.shadow = false keeps this personal: the workspace container is owned by the
    // workspace owner, so without it their total absorbs every member's workspace-level item.
    '((project.owner = {:uid} && project.shadow = false) || assignee = {:uid}) && (workspace.owner = {:uid} || (workspace.workspace_members_via_workspace.user ?= {:uid} && workspace.workspace_members_via_workspace.status ?= "active")) && trashed = "" && (project = "" || (project.created != "" && project.trashed = "")) && workspace.trashed = ""',
    "",
    0,
    0,
    { uid },
  );
  // Statuses are now config-driven (G1 #74: a `statuses` RELATION), so accumulate
  // dynamically — byStatus is keyed by status RELATION ID (config-driven, no change
  // needed here); a hard-coded {todo,doing,done} would produce NaN on any custom status.
  const byStatus = {};
  let assignedToMe = 0;
  for (const t of tasks) {
    const s = t.get("status");
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (t.get("assignee") === uid) assignedToMe += 1;
  }
  return e.json(200, {
    user: e.auth.get("name"),
    total: tasks.length,
    byStatus,
    assignedToMe,
  });
});

// ── Friendly alias for the dashboard ────────────────────────────────────────
// The admin UI's /_/ path is compiled into the binary and can't be renamed;
// a redirect gives it a memorable address.
require(`${__hooks}/lib/routes.js`).add("GET /admin", (e) =>
  e.redirect(302, "/_/"),
);

// ── Custom route calling an EXTERNAL API ────────────────────────────────────
// $http.send is the JSVM's outbound HTTP client (fetch() does not exist here).
// Auth-required so the backend isn't an open relay to someone else's API.
require(`${__hooks}/lib/routes.js`).add("GET /api/tracker/inspire", (e) => {
  let res;
  try {
    res = $http.send({
      // Overridable so the blocking battery can aim this route at a local stub instead.
      url:
        $os.getenv("INSPIRE_UPSTREAM_URL") || "https://zenquotes.io/api/random",
      method: "GET",
      timeout: 10, // seconds
    });
  } catch (err) {
    // DNS/TLS/socket/timeout throws out of $http.send; uncaught, PB answers 400 and an
    // outage reads to the client as a bad request. Only the send is wrapped, so a bug
    // below still surfaces as a bug.
    e.app.logger().error("inspire upstream call failed", "err", String(err));
    return e.json(502, { error: "upstream unreachable" });
  }
  if (res.statusCode !== 200) {
    return e.json(502, { error: "upstream returned " + res.statusCode });
  }
  const q = (res.json || [])[0];
  if (!q || typeof q.q !== "string") {
    return e.json(502, { error: "upstream returned an unusable body" });
  }
  return e.json(200, { quote: q.q, author: q.a, source: "zenquotes.io" });
});

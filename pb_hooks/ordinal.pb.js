/// <reference path="../pb_data/types.d.ts" />
// tasks.ordinal producer — a task created without one lands at the end of its board column.

// Request tier: an API caller other than a superuser cannot choose its place (0 = unset below);
// programmatic saves never reach this hook and keep their value.
onRecordCreateRequest((e) => {
  // A move places an existing task; a new one has no place yet to move from.
  if ((e.requestInfo().body || {}).move !== undefined) {
    const msg = "A new task cannot be moved. Create it, then move it.";
    throw new BadRequestError(msg, {
      move: new ValidationError("invalid_move", msg),
    });
  }
  if (!(e.auth && e.auth.isSuperuser())) {
    e.record.set("ordinal", 0);
  }
  return e.next();
}, "tasks");

// After-create tier, not *Request: this must fire for programmatic creates (seed, migrations,
// route handlers) too, and e.record.id exists only once the row is committed. Claiming AFTER the
// insert is also what keeps a failed create from consuming a number.
onRecordAfterCreateSuccess((e) => {
  const id = e.record.id;
  const project = e.record.get("project");
  // A column is (project, status); an item outside a project has no column, so it keeps its 0
  // — same bound as the keyless projectless item in keys.pb.js.
  if (id && project) {
    // ONE atomic statement: a read-then-write hands duplicate ordinals to parallel creates
    // (SQLite serializes the COMMIT, not the read). PB fills an unspecified number field with
    // 0, so 0 IS the "unset" signal; a non-zero ordinal (superuser or programmatic writer only,
    // the guard above zeroes the rest) matches no row here and is returned untouched.
    const q = e.app
      .db()
      .newQuery(
        "UPDATE tasks SET ordinal = 1 + (SELECT COALESCE(MAX(t2.ordinal), 0) FROM tasks t2 " +
          "WHERE t2.project = {:p} AND t2.status = {:s} AND t2.id <> {:id}) " +
          "WHERE id = {:id} AND COALESCE(ordinal, 0) = 0 RETURNING ordinal",
      );
    q.bind({ p: project, s: e.record.get("status") || "", id: id });
    // Array form, never q.one(): an explicit ordinal returns zero rows and q.one() throws on that.
    // The template value must be FRACTIONAL: an integer one scans a fractional ordinal (seed.ts
    // writes 0.5/8.5) into an int and the throw turns a committed create into an HTTP 400.
    const rows = arrayOf(new DynamicModel({ ordinal: 0.5 }));
    q.all(rows);
    if (rows.length > 0) {
      // The row is already written; this only stops the in-flight record from reporting 0.
      e.record.set("ordinal", rows[0].ordinal);
    }
  }
  e.next();
}, "tasks");

// The move: a tasks update carrying a non-schema `move` key places the task after/before a named
// task, or at the start/end of a column, inside ONE order over the whole project (every board
// grouping and the list read a project in this order). Only through /api/batch: there the update
// runs in a transaction, so the renumber below commits or rolls back with the update and its
// validators, and concurrent moves are serialized by the single writer.
// Request tier: a programmatic save carries no request body to read a move from.
onRecordUpdateRequest((e) => {
  const move = (e.requestInfo().body || {}).move;
  if (move === undefined) return e.next();
  const refuse = (code, msg) =>
    new BadRequestError(msg, { move: new ValidationError(code, msg) });
  if (!e.app.isTransactional()) {
    throw refuse(
      "move_requires_batch",
      "A move must be sent as a batch request.",
    );
  }
  const shape = "A move names exactly one of after, before or at.";
  if (move === null || typeof move !== "object" || Array.isArray(move)) {
    throw refuse("invalid_move", shape);
  }
  const named = ["after", "before", "at"].filter((k) => move[k] !== undefined);
  if (named.length !== 1) throw refuse("invalid_move", shape);
  const group = move.group === undefined ? "status" : move.group;
  if (["status", "priority", "assignee"].indexOf(group) === -1) {
    throw refuse(
      "invalid_move",
      "A move groups by status, priority or assignee.",
    );
  }
  if (move.at !== undefined && move.at !== "start" && move.at !== "end") {
    throw refuse(
      "invalid_move",
      "A move goes to the start or the end of a column.",
    );
  }
  const anchor = move.after !== undefined ? move.after : move.before;
  if (
    move.at === undefined &&
    (typeof anchor !== "string" || anchor === e.record.id)
  ) {
    throw refuse("invalid_move", "A task moves next to another task.");
  }
  const project = e.record.get("project");
  if (!project)
    throw refuse("invalid_move", "Only a task in a project can be moved.");

  const db = e.app.db();
  // KEEP IN SYNC: project-order — ordinal ASC, created DESC, id ASC is also spelled in
  // tests/test_ordinal.ts (project_order), web/lib/proxy/handlers/project_items.ts (the list
  // default sort) and web/components/resource/use-board-drop.ts (the stored-order comparator).
  const ORDER = "ordinal, created DESC, id";
  // The project's other tasks in list order (ordinal, newest first, id); FRACTIONAL template.
  const others = () => {
    const rows = arrayOf(
      new DynamicModel({
        id: "",
        ordinal: 0.5,
        status: "",
        priority: "",
        assignee: "",
      }),
    );
    db.newQuery(
      "SELECT id, COALESCE(ordinal, 0) AS ordinal, COALESCE(status, '') AS status, " +
        "COALESCE(priority, '') AS priority, COALESCE(assignee, '') AS assignee FROM tasks " +
        "WHERE project = {:p} AND id <> {:id} ORDER BY " +
        ORDER,
    )
      .bind({ p: project, id: e.record.id })
      .all(rows);
    return rows;
  };
  // [ordinal, collapsed] for the chosen place, or null when an empty column keeps the ordinal.
  const place = (rows) => {
    let i;
    let after = move.after !== undefined;
    if (move.at !== undefined) {
      let key = (v) => v || "";
      if (group === "priority") {
        // The board shows a priority the workspace no longer offers under No priority.
        const ws = e.app.findRecordById(
          "workspaces",
          e.app.findRecordById("projects", project).get("workspace"),
        );
        const raw = ws.get("priorities");
        let vocab = [];
        try {
          vocab = JSON.parse(
            raw === null || raw === undefined ? "" : String(raw),
          );
        } catch (_) {
          vocab = [];
        }
        const offered = {};
        for (let k = 0; Array.isArray(vocab) && k < vocab.length; k++) {
          if (vocab[k] && vocab[k].id) offered[vocab[k].id] = true;
        }
        key = (v) => (v && offered[v] ? v : "");
      }
      const value = key(e.record.get(group));
      const col = [];
      for (let k = 0; k < rows.length; k++)
        if (key(rows[k][group]) === value) col.push(k);
      if (!col.length) return null;
      after = move.at === "end";
      i = after ? col[col.length - 1] : col[0];
    } else {
      i = -1;
      for (let k = 0; k < rows.length; k++) if (rows[k].id === anchor) i = k;
      if (i === -1)
        throw refuse(
          "invalid_move",
          "A task moves next to a task in its own project.",
        );
    }
    const at = rows[i].ordinal;
    const tie =
      (i > 0 && rows[i - 1].ordinal === at) ||
      (i + 1 < rows.length && rows[i + 1].ordinal === at);
    let lo = at;
    let hi = at;
    if (after) {
      hi = undefined;
      for (let k = i + 1; k < rows.length && hi === undefined; k++) {
        if (rows[k].ordinal > at) hi = rows[k].ordinal;
      }
    } else {
      lo = undefined;
      for (let k = i - 1; k >= 0 && lo === undefined; k--) {
        if (rows[k].ordinal < at) lo = rows[k].ordinal;
      }
    }
    const v =
      lo === undefined ? hi - 1 : hi === undefined ? lo + 1 : (lo + hi) / 2;
    // A float midpoint stops landing strictly between its neighbours once the gap is exhausted.
    const fits = (lo === undefined || lo < v) && (hi === undefined || v < hi);
    return [v, tie || !fits];
  };

  let spot = place(others());
  if (spot && spot[1]) {
    // ONE statement over the whole project: renumbering a single column would reshuffle
    // every other grouping of the same tasks.
    db.newQuery(
      "UPDATE tasks SET ordinal = r.n FROM (SELECT id, ROW_NUMBER() OVER " +
        "(ORDER BY " +
        ORDER +
        ") AS n FROM tasks WHERE project = {:p}) AS r " +
        "WHERE tasks.id = r.id",
    )
      .bind({ p: project })
      .execute();
    spot = place(others());
  }
  if (spot) e.record.set("ordinal", spot[0]);
  return e.next();
}, "tasks");

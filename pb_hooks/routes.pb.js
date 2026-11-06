// Custom API routes — every handler re-does its own authorization (routes BYPASS collection rules).

require(`${__hooks}/lib/routes.js`).add("GET /api/tracker/search", (e) => {
  const uid = e.auth.id;
  const query = e.request.url.query();
  // A control byte truncates the LIKE pattern at itself; a run becomes ONE space so the
  // fragments either side never fuse into a word the caller never typed.
  const raw = (query.get("q") || "").replace(/[\x00-\x1f]+/g, " ").trim();
  // An OMITTED workspace is the cross-workspace mode; an explicitly empty one is a client bug.
  if (query.has("workspace") && !(query.get("workspace") || "").trim())
    throw new BadRequestError("workspace query param must not be empty");
  const wsId = (query.get("workspace") || "").trim();
  const CAP = 20;
  if (!raw)
    return e.json(200, {
      query: raw,
      count: 0,
      truncated: false,
      results: [],
    });
  const escd = raw
    .replace(/[\\%_]/g, function (c) {
      return "\\" + c;
    })
    .toLowerCase();
  const pat = "%" + escd + "%";
  const search = function (coll, titleCol, bodyCols, opts) {
    opts = opts || {};
    const likeTitle =
      "LOWER(" + coll + "." + titleCol + ") LIKE {:q} ESCAPE '\\'";
    const likeAny = [titleCol]
      .concat(bodyCols)
      .map(function (c) {
        return "LOWER(" + coll + "." + c + ") LIKE {:q} ESCAPE '\\'";
      })
      .join(" OR ");
    let scope =
      "(EXISTS (SELECT 1 FROM workspaces w WHERE w.id = " +
      coll +
      ".workspace AND w.owner = {:uid})" +
      // KEEP IN SYNC: tasks.listRule (and its decisions/documents/milestones/projects
      // siblings) — only an ACTIVE membership confers read (PBTT-431).
      // [[user]] is a reserved word — bracket-quote it.
      " OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace = " +
      coll +
      ".workspace AND m.[[user]] = {:uid} AND m.status = 'active')";
    scope += ")";
    // KEEP IN SYNC: the `workspace.trashed = ""` clause every searched collection's listRule
    // carries — all five have a `workspace` column, so this leg is unconditional. `sw` because
    // `w`, `dw` and `p` are already bound in this statement.
    let trash =
      coll +
      ".trashed = '' AND EXISTS (SELECT 1 FROM workspaces sw WHERE sw.id = " +
      coll +
      ".workspace AND sw.trashed = '')";
    if (opts.projTrashReq)
      trash +=
        " AND EXISTS (SELECT 1 FROM projects p WHERE p.id = " +
        coll +
        ".project AND p.trashed = '')";
    else if (opts.projTrashOpt)
      trash +=
        " AND (" +
        coll +
        ".project = '' OR EXISTS (SELECT 1 FROM projects p WHERE p.id = " +
        coll +
        ".project AND p.trashed = ''))";
    // KEEP IN SYNC: the documents/decisions/milestones listRule draft branch and the
    // export route's canSeeDrafts — search is cross-workspace, so it resolves the
    // owner/admin test per ROW instead of once per workspace.
    // decision:shadow-project: the per-workspace container is unreadable through the collection
    // rules, so this reader must drop it too. Only the projects arm has the column.
    if (opts.notShadow) trash += " AND " + coll + ".shadow = 0";
    let draft = "";
    if (opts.draft)
      draft =
        " AND (" +
        coll +
        ".draft = false OR " +
        coll +
        ".author = {:uid}" +
        " OR EXISTS (SELECT 1 FROM workspaces dw WHERE dw.id = " +
        coll +
        ".workspace AND dw.owner = {:uid})" +
        " OR EXISTS (SELECT 1 FROM workspace_members dm WHERE dm.workspace = " +
        coll +
        ".workspace AND dm.[[user]] = {:uid} AND dm.role = 'admin' AND dm.status = 'active'))";
    const sql =
      "SELECT " +
      coll +
      ".id AS id, " +
      coll +
      "." +
      titleCol +
      " AS title, " +
      // The projects arm has no project column: a project hit has no parent project.
      (coll === "projects" ? "''" : coll + ".project") +
      " AS project, " +
      "CASE WHEN " +
      likeTitle +
      " THEN 0 ELSE 1 END AS rank " +
      "FROM " +
      coll +
      " WHERE (" +
      likeAny +
      ") AND " +
      scope +
      " AND " +
      trash +
      draft +
      // The membership `scope` above still governs: a workspace the caller cannot read
      // narrows to zero rows rather than opening.
      (wsId ? " AND " + coll + ".workspace = {:ws}" : "") +
      " ORDER BY rank, id LIMIT " +
      (CAP + 1);
    const q = e.app.db().newQuery(sql);
    const binds = { uid: uid, q: pat };
    if (wsId) binds.ws = wsId;
    q.bind(binds);
    const rows = arrayOf(
      new DynamicModel({ id: "", title: "", project: "", rank: 0 }),
    );
    q.all(rows);
    return rows.map(function (r, i) {
      return {
        collection: coll,
        id: r.id,
        title: r.title,
        project: r.project,
        rank: r.rank,
        pos: i,
      };
    });
  };
  let results = [];
  results = results.concat(
    search("tasks", "title", ["description"], {
      projTrashOpt: true,
    }),
  );
  results = results.concat(
    search("decisions", "title", ["context", "decision", "consequences"], {
      projTrashOpt: true,
      draft: true,
    }),
  );
  results = results.concat(
    search("documents", "title", ["body"], {
      projTrashOpt: true,
      draft: true,
    }),
  );
  results = results.concat(
    search("milestones", "name", ["description"], {
      projTrashReq: true,
      draft: true,
    }),
  );
  results = results.concat(
    search("projects", "name", ["description"], { notShadow: true }),
  );
  // Interleave by per-arm position inside each rank tier so one crowded collection
  // cannot bury another's hits; `ord` holds arm order without relying on sort stability.
  for (let i = 0; i < results.length; i++) results[i].ord = i;
  results.sort(function (a, b) {
    return a.rank - b.rank || a.pos - b.pos || a.ord - b.ord;
  });
  const truncated = results.length > CAP;
  results = results.slice(0, CAP).map(function (r) {
    return {
      collection: r.collection,
      id: r.id,
      title: r.title,
      project: r.project,
      rank: r.rank,
    };
  });
  return e.json(200, {
    query: raw,
    count: results.length,
    truncated: truncated,
    results: results,
  });
});

// GET /api/tracker/trash — enumerate a workspace's trashed items (self-scoped by membership; routes BYPASS rules).
require(`${__hooks}/lib/routes.js`).add("GET /api/tracker/trash", (e) => {
  const uid = e.auth.id;
  const wsId = (e.request.url.query().get("workspace") || "").trim();
  if (!wsId) throw new BadRequestError("workspace query param required");
  // KEEP IN SYNC: project_items viewRule trash branch in schema/project_items.view.json — the owner or an active member, never a trashed workspace, and for non-task items an owner/admin or `draft = false || author`.
  // MEMBERSHIP SCOPE BY HAND — a wrong scope leaks another tenant's trash. Caller must own
  // wsId OR have a workspace_members row (R7 find-first-or-throw idiom, trash.pb.js:59-67).
  let ws;
  try {
    ws = e.app.findRecordById("workspaces", wsId);
  } catch (_) {
    throw new ForbiddenError("not a member of this workspace");
  }
  let member = ws.get("owner") === uid;
  if (!member) {
    try {
      // KEEP IN SYNC: tasks.listRule — a suspended membership
      // confers no read, so status='active' is load-bearing (PBTT-431).
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && status = 'active'",
        { w: wsId, u: uid },
      );
      member = true;
    } catch (_) {
      member = false;
    }
  }
  if (!member) throw new ForbiddenError("not a member of this workspace");
  // A TRASHED workspace is refused outright, the owner included: this route bypasses
  // collection rules, so the cascade cannot reach it. It runs BELOW the membership check so a
  // stranger gets the same refusal for a trashed id as for one that never existed.
  if (String(ws.get("trashed")) !== "") throw new NotFoundError("not found");
  // KEEP IN SYNC: decisions/documents/milestones listRule draft branch (mirrors the export
  // route's canSeeDrafts below) — trashing a draft must not publish it to the members its
  // viewRule hides it from; an empty author matches nobody (PBTT-544). tasks have no branch.
  let canSeeDrafts = ws.get("owner") === uid;
  if (!canSeeDrafts) {
    try {
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && role = 'admin' && status = 'active'",
        { w: wsId, u: uid },
      );
      canSeeDrafts = true;
    } catch (_) {
      canSeeDrafts = false;
    }
  }
  const q = e.request.url.query();
  const filter = q.get("filter") || "";
  // KEEP IN SYNC: counts.pb.js filter trust check, `filter may only reference project_items' own flat columns`
  // — same ceiling and refusals (pooled JSVM: no shared helper); spliced into the selection unprotected.
  if (filter.length > 3500)
    throw new BadRequestError("filter must be at most 3500 characters");
  let quote = null;
  let escapeNext = false;
  let depth = 0;
  let unsafe = false;
  for (let i = 0; i < filter.length; i++) {
    const c = filter[i];
    if (quote) {
      if (escapeNext) escapeNext = false;
      else if (c === "\\") escapeNext = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth < 0) {
        unsafe = true;
        break;
      }
      continue;
    }
    if (
      c === "@" ||
      c === "." ||
      (c === "{" && filter[i + 1] === ":") ||
      (c === "/" && filter[i + 1] === "/")
    ) {
      unsafe = true;
      break;
    }
  }
  if (!unsafe && (quote !== null || depth !== 0)) unsafe = true;
  if (unsafe)
    throw new BadRequestError(
      "filter may only reference project_items' own flat columns",
    );
  const sortParam = q.get("sort") || "-trashed";
  if (!/^[-+]?[a-z_]+(,[-+]?[a-z_]+)*$/.test(sortParam))
    throw new BadRequestError(
      "sort must be a comma list of project_items columns, each optionally prefixed - or +",
    );
  const GROUPS = ["project", "status", "priority", "assignee", "label", "type"];
  const group = q.get("group") || "";
  if (group && GROUPS.indexOf(group) === -1)
    throw new BadRequestError(
      "group must be one of: project, status, priority, assignee, label, type",
    );
  // KEEP IN SYNC: viewer's day — counts.pb.js project_items and project_stats enrich resolve it the same way, `String(new Timezone(sent).string()) !== sent`.
  const sent = String(q.get("time_zone") || "");
  if (
    sent &&
    (sent === "Local" || String(new Timezone(sent).string()) !== sent)
  )
    throw new BadRequestError(
      "The time zone must be an IANA name, such as Europe/Paris.",
    );
  let zone = sent;
  try {
    const saved = e.app
      .findFirstRecordByFilter("user_settings", "user = {:u}", { u: uid })
      .getString("time_zone");
    if (
      saved &&
      saved !== "Local" &&
      String(new Timezone(saved).string()) === saved
    )
      zone = saved;
  } catch (_) {}
  const loc = new Timezone(zone);
  const dayNumber = (ymd) =>
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(5, 7)) - 1,
      Number(ymd.slice(8, 10)),
    ) / 86400000;
  const today = dayNumber(
    String(new DateTime().time().in(loc).format("2006-01-02")),
  );

  // project_items' view query selects trashed rows too (only its RULES hide them) and this
  // e.app read applies no rule, so the view columns are the one trash matcher. An item's OWN
  // trashed decides membership, as before; tasks read draft = 0 in the view.
  const params = { w: wsId };
  let where = "workspace = {:w} && trashed != ''";
  if (!canSeeDrafts) {
    where += " && (draft = false || author = {:uid})";
    params.uid = uid;
  }
  if (filter) where += " && (" + filter + ")";
  // The id tiebreak makes the order total, so pages are disjoint and complete.
  const sort = group ? "" : sortParam + ",id";
  let rows;
  try {
    // limit 0 = no LIMIT: one read yields both the true count and the page from one snapshot.
    rows = e.app.findRecordsByFilter(
      "project_items",
      where,
      sort,
      0,
      0,
      params,
    );
  } catch (err) {
    // Validated above, so what PB refuses here is an unknown column the caller named.
    if (filter || q.get("sort"))
      throw new BadRequestError(
        "filter or sort names something project_items does not have",
      );
    throw err;
  }

  if (group) {
    const idList = function (raw) {
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== "string" || raw === "") return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    };
    // KEEP IN SYNC: counts.pb.js keysOf + bucket tally, `Number(row.get("has_priority")) === 0` — same buckets.
    const keysOf = function (row) {
      switch (group) {
        case "project":
          return [row.get("project") || null];
        case "status":
          return [row.get("status") || null];
        case "priority":
          return [
            Number(row.get("has_priority")) === 0
              ? "none"
              : row.get("priority") || "none",
          ];
        case "assignee":
          return [row.get("assignee") || null];
        case "label": {
          const labels = idList(row.get("labels"));
          return labels.length ? labels : [null];
        }
        case "type":
          return [row.get("type") || null];
        default:
          return [null];
      }
    };
    const counts = {};
    const order = [];
    const NULL_KEY = "\u0000null";
    for (let i = 0; i < rows.length; i++) {
      const keys = keysOf(rows[i]);
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k] === null ? NULL_KEY : String(keys[k]);
        if (counts[key] === undefined) {
          counts[key] = 0;
          order.push(key);
        }
        counts[key] += 1;
      }
    }
    return e.json(200, {
      workspace: wsId,
      total: rows.length,
      items: order.map(function (key) {
        return { key: key === NULL_KEY ? null : key, count: counts[key] };
      }),
    });
  }

  let page = parseInt(q.get("page") || "1", 10);
  if (isNaN(page) || page < 1) page = 1;
  let perPage = parseInt(q.get("perPage") || "500", 10);
  if (isNaN(perPage)) perPage = 500;
  perPage = Math.min(500, Math.max(1, perPage));
  const pageRows = rows.slice((page - 1) * perPage, page * perPage);

  // KEEP IN SYNC: trash.pb.js sweep retention read (cron + purge-route copies) of `trash_retention_days`
  // — the window purge_at promises is the one the sweep enforces.
  let retentionDays = 30;
  try {
    const setRec = e.app.findFirstRecordByFilter("app_settings", "key = {:k}", {
      k: "trash_retention_days",
    });
    const raw = setRec.get("value");
    let parsed = NaN;
    if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
      let text = "";
      for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);
      parsed = parseInt(text, 10);
    } else {
      parsed = parseInt(String(raw), 10);
    }
    if (!isNaN(parsed)) retentionDays = parsed;
  } catch (_) {
    retentionDays = 30;
  }
  if (isNaN(retentionDays)) retentionDays = 30;

  const COLS = {
    task: "tasks",
    decision: "decisions",
    document: "documents",
    milestone: "milestones",
  };
  const taskExpand = [
    "assignee",
    "status",
    "parent",
    "milestone",
    "dependencies",
    "parent.status",
    "dependencies.status",
    "trashed_by",
    "author",
  ];
  const itemExpand = ["trashed_by", "author"];
  const byId = {};
  for (const type in COLS) {
    const col = COLS[type];
    const ids = [];
    for (let i = 0; i < pageRows.length; i++)
      if (pageRows[i].get("type") === type) ids.push(pageRows[i].id);
    if (!ids.length) continue;
    const recs = e.app.findRecordsByIds(col, ids);
    e.app.expandRecords(recs, col === "tasks" ? taskExpand : itemExpand, null);
    // KEEP IN SYNC: the "(draft = false || author = {:uid})" trash filter above.
    // expandRecords runs through the superuser-privileged e.app, so every expanded relation
    // (a task's milestone today) is re-tested against that same carve-out here; a dropped
    // entry is the shape the app tier already serves for a relation the caller cannot read.
    if (!canSeeDrafts)
      for (let r = 0; r < recs.length; r++) {
        const ex = recs[r].expand();
        const kept = {};
        let dropped = false;
        for (const key in ex) {
          const val = ex[key];
          // A single relation expands to a Record (which carries get); a multiple one to a list.
          if (typeof val.get === "function") {
            if (val.get("draft") === true && val.get("author") !== uid)
              dropped = true;
            else kept[key] = val;
            continue;
          }
          const keep = [];
          for (let k = 0; k < val.length; k++) {
            if (val[k].get("draft") === true && val[k].get("author") !== uid)
              dropped = true;
            else keep.push(val[k]);
          }
          if (keep.length) kept[key] = keep;
        }
        if (dropped) recs[r].setExpand(kept);
      }
    // Neither e.json nor expandRecords runs onRecordEnrich (measured), so the statuses hook's
    // terminal and off_pipeline are applied here to every expanded status, own and nested.
    const statuses = [];
    for (let r = 0; r < recs.length; r++) {
      const ex = recs[r].expand();
      const holders = [recs[r]];
      if (ex.parent) holders.push(ex.parent);
      const deps = ex.dependencies || [];
      for (let k = 0; k < deps.length; k++) holders.push(deps[k]);
      for (let h = 0; h < holders.length; h++) {
        const st = holders[h].expand().status;
        if (st) statuses.push(st);
      }
    }
    if (statuses.length) $apis.enrichRecords(e, statuses);
    for (let r = 0; r < recs.length; r++) byId[recs[r].id] = recs[r];
  }
  const items = [];
  for (let i = 0; i < pageRows.length; i++) {
    const rec = byId[pageRows[i].id];
    // A row purged between the two reads is skipped rather than served half-built.
    if (!rec) continue;
    const trashed = String(pageRows[i].get("trashed"));
    const purgeAt = new Date(
      Date.parse(trashed.replace(" ", "T")) + retentionDays * 86400000,
    )
      .toISOString()
      .replace("T", " ");
    items.push({
      collection: COLS[pageRows[i].get("type")],
      record: rec,
      purge_at: purgeAt,
      // purge_at is a moment, so its day is read in the viewer's zone, like today.
      purge_days:
        dayNumber(
          String(new DateTime(purgeAt).time().in(loc).format("2006-01-02")),
        ) - today,
      // A priority id missing from the workspace vocabulary reads as no priority, as on the list.
      has_priority: Number(pageRows[i].get("has_priority")) === 1,
    });
  }
  return e.json(200, {
    workspace: wsId,
    count: rows.length,
    page: page,
    perPage: perPage,
    items: items,
  });
});

// POST /api/tracker/workspaces/{id}/vocab — atomically save a workspace's name/priorities/default_project and replace its statuses + labels.
// Routes BYPASS collection rules AND the *DeleteRequest guard hooks (which fire only on API
// deletes, not on programmatic txApp.delete) — so auth + both delete guards are re-done BY HAND.
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/workspaces/{id}/vocab",
  (e) => {
    const uid = e.auth.id;
    const wsId = e.request.pathValue("id");
    let ws;
    try {
      ws = e.app.findRecordById("workspaces", wsId);
    } catch (_) {
      throw new NotFoundError("workspace not found");
    }
    // A trashed workspace is unwritable here by anyone, owner included; same 404 as unknown id.
    if (String(ws.get("trashed")) !== "")
      throw new NotFoundError("workspace not found");
    // KEEP IN SYNC: workspaces.updateRule — owner OR an ACTIVE admin member; a suspended
    // admin confers no authority (PBTT-431).
    let authorized = ws.get("owner") === uid;
    if (!authorized) {
      try {
        e.app.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u} && role = 'admin' && status = 'active'",
          { w: wsId, u: uid },
        );
        authorized = true;
      } catch (_) {
        authorized = false;
      }
    }
    // Deny → 404, SAME as not-found (no existence leak; reproduces PB update-denied→404 idiom).
    if (!authorized) throw new NotFoundError("workspace not found");

    const body = e.requestInfo().body || {};
    const hasStatuses = body.statuses !== undefined;
    const hasLabels = body.labels !== undefined;
    if (hasStatuses && !Array.isArray(body.statuses))
      throw new BadRequestError("statuses must be an array");
    if (hasLabels && !Array.isArray(body.labels))
      throw new BadRequestError("labels must be an array");

    // Only these record fields are read, so owner/trashed can never be written here.
    const fields = {};
    const fieldNames = ["name", "priorities", "default_project"];
    for (let i = 0; i < fieldNames.length; i++)
      if (body[fieldNames[i]] !== undefined)
        fields[fieldNames[i]] = body[fieldNames[i]];
    const hasFields = Object.keys(fields).length > 0;
    if (hasFields) {
      // The collection PATCH's own rules (names.pb.js, main.pb.js), one copy.
      const rules = require(`${__hooks}/lib/workspace_rules.js`);
      for (const k in fields) ws.set(k, fields[k]);
      // Judged on the value as set, so a non-string name (null, [], {}) gets the same refusal as "  ".
      if ("name" in fields)
        rules.rejectBlankName(
          ws.collection(),
          { name: ws.getString("name") },
          ws,
        );
      rules.validateWorkspacePriorities(ws);
      rules.validateDefaultProject(e.app, ws);
    }

    const deriveStatusCategory = function (existingCategory, terminal) {
      // KEEP IN SYNC: pb_hooks/counts.pb.js statuses enrich, terminal = {`completed`, `canceled`}
      const isTerminalCat = function (c) {
        return c === "completed" || c === "canceled";
      };
      if (
        existingCategory != null &&
        isTerminalCat(existingCategory) === !!terminal
      )
        return existingCategory;
      return terminal ? "completed" : "unstarted";
    };

    // Pre-tx validation (fail fast, before opening the tx).
    const statusSubmittedIds = {};
    const labelSubmittedIds = {};
    if (hasStatuses) {
      for (let i = 0; i < body.statuses.length; i++) {
        const s = body.statuses[i];
        // off_pipeline has no backend field (no schema change is in scope) — DECLARED BOUND.
        if (s && s.off_pipeline === true)
          throw new BadRequestError("off_pipeline statuses are not supported");
        if (!s || typeof s.name !== "string" || s.name.trim() === "")
          throw new BadRequestError("status name must be a non-empty string");
        if (s.id) {
          try {
            e.app.findFirstRecordByFilter(
              "statuses",
              "id = {:id} && workspace = {:w}",
              { id: s.id, w: wsId },
            );
          } catch (_) {
            throw new BadRequestError("unknown status id");
          }
          statusSubmittedIds[s.id] = true;
        }
      }
    }
    if (hasLabels) {
      for (let i = 0; i < body.labels.length; i++) {
        const l = body.labels[i];
        if (!l || typeof l.name !== "string" || l.name.trim() === "")
          throw new BadRequestError("label name must be a non-empty string");
        if (l.id) {
          try {
            e.app.findFirstRecordByFilter(
              "labels",
              "id = {:id} && workspace = {:w}",
              { id: l.id, w: wsId },
            );
          } catch (_) {
            throw new BadRequestError("unknown label id");
          }
          labelSubmittedIds[l.id] = true;
        }
      }
    }

    $app.runInTransaction(function (txApp) {
      if (hasStatuses) {
        const statusesCollection = txApp.findCollectionByNameOrId("statuses");
        const existing = txApp.findRecordsByFilter(
          "statuses",
          "workspace = {:w}",
          "+position",
          500,
          0,
          { w: wsId },
        );
        const byId = {};
        for (let k = 0; k < existing.length; k++)
          byId[existing[k].id] = existing[k];
        for (let k = 0; k < existing.length; k++) {
          const row = existing[k];
          if (statusSubmittedIds[row.id]) continue;
          // KEEP IN SYNC: main.pb.js — `cannot delete a status still referenced by a task`.
          let referenced = false;
          try {
            txApp.findFirstRecordByFilter("tasks", "status = {:s}", {
              s: row.id,
            });
            referenced = true;
          } catch (_) {
            referenced = false;
          }
          if (referenced)
            throw new BadRequestError(
              "cannot delete a status still referenced by a task",
            );
          txApp.delete(row);
        }
        for (let i = 0; i < body.statuses.length; i++) {
          const s = body.statuses[i];
          if (s.id) {
            const rec = byId[s.id];
            const category = deriveStatusCategory(
              rec.get("category"),
              s.terminal,
            );
            rec.set("name", s.name);
            rec.set("position", i);
            rec.set("category", category);
            txApp.save(rec);
          } else {
            const rec = new Record(statusesCollection);
            rec.set("workspace", wsId);
            rec.set("name", s.name);
            rec.set("position", i);
            rec.set("category", deriveStatusCategory(null, s.terminal));
            rec.set("is_default", false);
            txApp.save(rec);
          }
        }
      }
      if (hasLabels) {
        const labelsCollection = txApp.findCollectionByNameOrId("labels");
        const existing = txApp.findRecordsByFilter(
          "labels",
          "workspace = {:w}",
          "+created",
          500,
          0,
          { w: wsId },
        );
        const byId = {};
        for (let k = 0; k < existing.length; k++)
          byId[existing[k].id] = existing[k];
        for (let k = 0; k < existing.length; k++) {
          const row = existing[k];
          if (labelSubmittedIds[row.id]) continue;
          // KEEP IN SYNC: main.pb.js — `core labels cannot be deleted`.
          if (row.get("core") === true)
            throw new BadRequestError("core labels cannot be deleted");
          txApp.delete(row);
        }
        for (let i = 0; i < body.labels.length; i++) {
          const l = body.labels[i];
          if (l.id) {
            const rec = byId[l.id];
            rec.set("name", l.name);
            txApp.save(rec);
          } else {
            const rec = new Record(labelsCollection);
            rec.set("workspace", wsId);
            rec.set("name", l.name);
            rec.set("core", false);
            txApp.save(rec);
          }
        }
      }
      // Last, so a field-level refusal here also rolls back the vocab written above.
      if (hasFields) txApp.save(ws);
    });

    // The shape of a collection read with ?expand=statuses_via_workspace,labels_via_workspace.
    const saved = e.app.findRecordById("workspaces", wsId);
    const statuses = e.app.findRecordsByFilter(
      "statuses",
      "workspace = {:w}",
      "+position",
      0,
      0,
      { w: wsId },
    );
    // e.json runs no onRecordEnrich, so the statuses hook's terminal and off_pipeline are applied here.
    if (statuses.length) $apis.enrichRecords(e, statuses);
    saved.setExpand({
      statuses_via_workspace: statuses,
      labels_via_workspace: e.app.findRecordsByFilter(
        "labels",
        "workspace = {:w}",
        "+created",
        0,
        0,
        { w: wsId },
      ),
    });
    return e.json(200, saved);
  },
);

// GET /api/tracker/admin/pending-users — accounts that cannot sign in yet (decision:signup-approval).
// Approval is APP-level, never the per-workspace admin tier: every signup auto-provisions its
// own workspace and owns it, so a workspace-role gate would hand this to everyone who signs up.
require(`${__hooks}/lib/routes.js`).add(
  "GET /api/tracker/admin/pending-users",
  (e) => {
    // KEEP IN SYNC: byte-identical gate in POST /api/tracker/admin/pending-users/{id}/approve
    // below (pooled JSVM — callbacks cannot share a top-level helper).
    const isAppAdmin = function (auth) {
      if (!auth) return false;
      if (auth.isSuperuser()) return true;
      const email = String(auth.getString("email") || "")
        .trim()
        .toLowerCase();
      if (!email) return false;
      const allow = String($os.getenv("APP_ADMIN_EMAILS") || "").split(",");
      for (let i = 0; i < allow.length; i++) {
        const entry = allow[i].trim().toLowerCase();
        if (entry !== "" && entry === email) return true;
      }
      return false;
    };
    // Deny → 404, SAME as not-found (no existence leak; reproduces PB view-denied→404 idiom).
    if (!isAppAdmin(e.auth)) throw new NotFoundError("not found");

    // Two disjoint queries, each its OWN 200-row bound: an unbounded-accumulation population
    // (approved=true && verified=false — nothing purges an abandoned unconfirmed signup) sharing
    // one bound with a drainable one (approved=false) lets the sticky arm starve the drainable one
    // out of the page entirely (reviewer-demonstrated, TASK-083 follow-up).
    const awaitingApproval = e.app.findRecordsByFilter(
      "users",
      "approved = false",
      "+created",
      200,
      0,
    );
    const awaitingConfirmation = e.app.findRecordsByFilter(
      "users",
      "approved = true && verified = false",
      "+created",
      200,
      0,
    );
    const recs = awaitingApproval.concat(awaitingConfirmation);
    const users = [];
    for (let i = 0; i < recs.length; i++) {
      users.push({
        id: recs[i].id,
        name: recs[i].getString("name"),
        email: recs[i].getString("email"),
        verified: recs[i].getBool("verified"),
        approved: recs[i].getBool("approved"),
        created: recs[i].getString("created"),
      });
    }
    return e.json(200, { count: users.length, users: users });
  },
);

// POST /api/tracker/admin/pending-users/{id}/approve — flip users.approved, the second half of
// the authRule login gate. users.updateRule's `approved:isset` guard forbids this over the
// collection API by design; routes BYPASS collection rules, so the gate is re-done BY HAND.
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/admin/pending-users/{id}/approve",
  (e) => {
    // KEEP IN SYNC: byte-identical gate in GET /api/tracker/admin/pending-users above.
    const isAppAdmin = function (auth) {
      if (!auth) return false;
      if (auth.isSuperuser()) return true;
      const email = String(auth.getString("email") || "")
        .trim()
        .toLowerCase();
      if (!email) return false;
      const allow = String($os.getenv("APP_ADMIN_EMAILS") || "").split(",");
      for (let i = 0; i < allow.length; i++) {
        const entry = allow[i].trim().toLowerCase();
        if (entry !== "" && entry === email) return true;
      }
      return false;
    };
    if (!isAppAdmin(e.auth)) throw new NotFoundError("not found");

    const id = e.request.pathValue("id");
    let rec;
    try {
      rec = e.app.findRecordById("users", id);
    } catch (_) {
      throw new NotFoundError("account not found");
    }
    rec.set("approved", true);
    e.app.save(rec);
    return e.json(200, { id: rec.id, approved: rec.getBool("approved") });
  },
);

// POST /api/tracker/workspaces/{id}/resolve-member-email — invites an address to this workspace
// by minting a workspace_invitations row for ANY address; it never reads users, so the answer
// cannot vary with whether the address has an account (decision:invitation-keyed-by-email).
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/workspaces/{id}/resolve-member-email",
  (e) => {
    const uid = e.auth.id;
    const wsId = e.request.pathValue("id");
    let ws;
    try {
      ws = e.app.findRecordById("workspaces", wsId);
    } catch (_) {
      throw new NotFoundError("workspace not found");
    }
    // A trashed workspace resolves nobody for anyone, owner included; same 404 as unknown id.
    if (String(ws.get("trashed")) !== "")
      throw new NotFoundError("workspace not found");
    // KEEP IN SYNC: workspace_invitations.createRule:
    // owner OR an ACTIVE admin member. status='active' is load-bearing (PBTT-365) — a suspended
    // admin confers no authority and must not invite.
    let authorized = ws.get("owner") === uid;
    if (!authorized) {
      try {
        e.app.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u} && role = 'admin' && status = 'active'",
          { w: wsId, u: uid },
        );
        authorized = true;
      } catch (_) {
        authorized = false;
      }
    }
    // MUST precede any body read: an unauthorized caller's response may not vary with the
    // email, or it becomes an account-existence oracle. Deny → 404, SAME as not-found.
    if (!authorized) throw new NotFoundError("workspace not found");

    const body = e.requestInfo().body || {};
    // KEEP IN SYNC: pb_hooks/precondition.pb.js — "This item is new, so there is nothing yet to overwrite."
    // That hook refuses the key on every COLLECTION create; this route's create is programmatic and
    // out of its request-tier reach, so the refusal is mirrored rather than the key silently ignored.
    if (body.expected_updated_at !== undefined)
      throw new BadRequestError(
        "This item is new, so there is nothing yet to overwrite. Create it without a safeguard against another person's changes.",
      );
    if (typeof body.email !== "string")
      throw new BadRequestError("email must be a string");
    const email = body.email.trim().toLowerCase();
    if (!email) throw new BadRequestError("email must be a non-empty string");
    const role = body.role === undefined ? "member" : body.role;
    // KEEP IN SYNC: the invite-mirror suite asserts this list equals the role select
    // field values declared on workspace_invitations by the LIVE server. A value this list
    // still accepts after the field drops it reaches the save below and re-throws as a bare
    // validation error instead of this message.
    if (role !== "admin" && role !== "member" && role !== "viewer")
      throw new BadRequestError("role must be admin, member or viewer");
    // KEEP IN SYNC: workspace_invitations.createRule's admin branch carries
    // `@request.body.role = "member"` — an active admin mints only members, the owner any role.
    // Differential gate (route vs the live rule, cell for cell): tests/test_invite_mirror.ts.
    if (ws.get("owner") !== uid && role !== "member")
      throw new BadRequestError(
        "only the workspace owner can add an admin or a viewer",
      );

    const rec = new Record(
      e.app.findCollectionByNameOrId("workspace_invitations"),
    );
    rec.set("workspace", wsId);
    rec.set("email", email);
    rec.set("role", role);
    rec.set("invited_by", uid);
    try {
      e.app.save(rec);
    } catch (err) {
      // Re-inviting a pending address answers like the first invitation and changes nothing.
      // Detected by re-reading the pair (the create hook folded email_key onto rec), never by
      // matching PB's validation wording — every OTHER save failure re-throws untouched.
      const key = rec.getString("email_key");
      let collided = false;
      if (key) {
        try {
          e.app.findFirstRecordByFilter(
            "workspace_invitations",
            "workspace = {:w} && email_key = {:k}",
            { w: wsId, k: key },
          );
          collided = true;
        } catch (_) {
          collided = false;
        }
      }
      if (!collided) throw err;
    }
    // Identical in status, body and key set whether or not the address has an account or is
    // already invited — the one property that makes this route not an account-existence oracle.
    return e.json(200, { invited: true });
  },
);

// POST /api/tracker/export — self-service JSON export of ONE workspace's data (relation fields
// stay stored record ids, never names). Routes BYPASS collection rules and findRecordsByFilter
// runs in superuser context, so EVERY per-collection read boundary is re-enforced BY HAND below —
// a naive fetch would leak every tenant.
require(`${__hooks}/lib/routes.js`).add("POST /api/tracker/export", (e) => {
  const uid = e.auth.id;
  const body = e.requestInfo().body || {};
  const wsId = (
    typeof body.workspace === "string" ? body.workspace : ""
  ).trim();
  if (!wsId) throw new BadRequestError("workspace is required");
  // null/absent keeps meaning "everything"; any other non-list would silently export everything.
  const isIdList = function (v) {
    return (
      Array.isArray(v) &&
      v.every(function (x) {
        return typeof x === "string";
      })
    );
  };
  if (body.projects != null && !isIdList(body.projects))
    throw new BadRequestError("projects must be a list of project ids");
  if (body.collections != null && !isIdList(body.collections))
    throw new BadRequestError("collections must be a list of collection names");

  // MEMBERSHIP SCOPE BY HAND (mirror trash.pb.js R7 / routes.pb.js:113-134): caller must OWN
  // wsId or hold a workspace_members row. Deny → 404 (existence-hiding, no tenant-existence oracle).
  let ws;
  try {
    ws = e.app.findRecordById("workspaces", wsId);
  } catch (_) {
    throw new NotFoundError("not found");
  }
  // A TRASHED workspace is refused OUTRIGHT, the owner included, in the SAME 404 shape as an
  // unknown id: this route bypasses collection rules and reads in superuser context, so
  // workspaces.viewRule's `trashed = ""` never reaches it and the record (name + trashed
  // stamp) went to every active member. The owner restores first, then exports.
  if (String(ws.get("trashed")) !== "") throw new NotFoundError("not found");
  const isOwner = ws.get("owner") === uid;
  let isMember = isOwner;
  if (!isMember) {
    try {
      // KEEP IN SYNC: tasks.listRule — only an ACTIVE membership confers read, so a
      // suspended member exports nothing (PBTT-431).
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && status = 'active'",
        { w: wsId, u: uid },
      );
      isMember = true;
    } catch (_) {
      isMember = false;
    }
  }
  if (!isMember) throw new NotFoundError("not found");

  // KEEP IN SYNC: documents.listRule draft branch (same shape in decisions/milestones) —
  // owner OR an ACTIVE admin member sees drafts; a plain member never sees another user's
  // draft, and a suspended admin confers no authority (PBTT-431).
  let canSeeDrafts = isOwner;
  if (!canSeeDrafts) {
    try {
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && role = 'admin' && status = 'active'",
        { w: wsId, u: uid },
      );
      canSeeDrafts = true;
    } catch (_) {
      canSeeDrafts = false;
    }
  }

  // Pooled JSVM: these helpers are LOCAL to this callback (never shared across route sites).
  const fetchAll = function (coll, filter, params) {
    const out = [];
    const BATCH = 500;
    let offset = 0;
    // Page to completion — a fixed cap would silently truncate an export (data-loss footgun).
    for (;;) {
      const recs = e.app.findRecordsByFilter(
        coll,
        filter,
        "created",
        BATCH,
        offset,
        params,
      );
      for (let i = 0; i < recs.length; i++) out.push(recs[i]);
      if (recs.length < BATCH) break;
      offset += BATCH;
    }
    return out;
  };

  // ── project scope: null/empty ⇒ all readable; a list INTERSECTS with readable, never widens ──
  const readableProjects = fetchAll(
    "projects",
    "workspace = {:w} && trashed = '' && shadow = false",
    { w: wsId },
  );
  const readableProjectIds = readableProjects.map(function (p) {
    return p.id;
  });
  let selectedProjectIds = null; // null ⇒ no narrowing (export every readable project)
  if (Array.isArray(body.projects) && body.projects.length) {
    selectedProjectIds = body.projects.filter(function (pid) {
      return readableProjectIds.indexOf(pid) !== -1;
    });
  }
  // A narrowing selection filters project-bearing rows to `project ∈ selected OR project = ''` —
  // the empty-project (workspace-level) rows stay because they are always readable and the
  // exported tasks reference them; other projects' rows drop. Never widens beyond readable.
  // decision:shadow-project replaced the empty-project sentinel with the workspace container, so a
  // narrowing selection has to keep its rows the way `project = ''` used to.
  let containerId = "";
  try {
    containerId = e.app.findFirstRecordByFilter(
      "projects",
      "workspace = {:w} && shadow = true",
      { w: wsId },
    ).id;
  } catch (_) {
    containerId = "";
  }
  const projNarrow = function (params) {
    if (selectedProjectIds === null) return "";
    const ors = ["project = ''"];
    if (containerId) {
      ors.push("project = {:ppc}");
      params.ppc = containerId;
    }
    for (let i = 0; i < selectedProjectIds.length; i++) {
      const k = "pp" + i;
      ors.push("project = {:" + k + "}");
      params[k] = selectedProjectIds[i];
    }
    return " && (" + ors.join(" || ") + ")";
  };

  // fetchScoped: workspace-scoped rows with optional trashed/draft/project carve-outs.
  const fetchScoped = function (coll, opts) {
    opts = opts || {};
    let filter = "workspace = {:w}";
    const params = { w: wsId };
    if (opts.trashed) filter += " && trashed = ''"; // EXCLUDE trashed rows (v1)
    if (opts.draft && !canSeeDrafts) {
      filter += " && (draft = false || author = {:uid})";
      params.uid = uid;
    }
    // KEEP IN SYNC: tasks/documents/decisions listRule `(project = "" || (project.created != "" && project.trashed = ""))`; milestones listRule `project.created != "" && project.trashed = ""` (project required there).
    if (opts.projTrashOpt)
      filter +=
        " && (project = '' || (project.created != '' && project.trashed = ''))";
    if (opts.projTrashReq)
      filter += " && project.created != '' && project.trashed = ''";
    if (opts.project) filter += projNarrow(params);
    return fetchAll(coll, filter, params);
  };

  // ── tenant content ──
  const projectsOut =
    selectedProjectIds === null
      ? readableProjects
      : readableProjects.filter(function (p) {
          return selectedProjectIds.indexOf(p.id) !== -1;
        });
  const tasksOut = fetchScoped("tasks", {
    trashed: true,
    projTrashOpt: true,
    project: true,
  });
  const documentsOut = fetchScoped("documents", {
    trashed: true,
    draft: true,
    projTrashOpt: true,
    project: true,
  });
  const decisionsOut = fetchScoped("decisions", {
    trashed: true,
    draft: true,
    projTrashOpt: true,
    project: true,
  });
  const milestonesOut = fetchScoped("milestones", {
    trashed: true,
    draft: true,
    projTrashReq: true,
    project: true,
  });
  const labelsOut = fetchScoped("labels", { project: true }); // no trashed/draft columns
  const statusesOut = fetchScoped("statuses", {}); // workspace-only (no project column)
  const membersOut = fetchScoped("workspace_members", {}); // read rule: any member reads all rows

  // saved_views: include only workspace-scoped views OR the caller's own personal views.
  const svParams = { w: wsId, uid: uid };
  let svFilter = "workspace = {:w} && (scope = 'workspace' || owner = {:uid})";
  svFilter += projNarrow(svParams);
  const savedViewsOut = fetchAll("saved_views", svFilter, svParams);

  // Exported parent-id sets — dependents (comments/activity/subscribers) include only rows whose
  // parent survived the carve-outs above, matching "parent in the exported set" by construction.
  const taskIdSet = {};
  for (let i = 0; i < tasksOut.length; i++) taskIdSet[tasksOut[i].id] = true;
  const docIdSet = {};
  for (let i = 0; i < documentsOut.length; i++)
    docIdSet[documentsOut[i].id] = true;
  const decIdSet = {};
  for (let i = 0; i < decisionsOut.length; i++)
    decIdSet[decisionsOut[i].id] = true;

  // comments have NO workspace column — coarse-scope via each parent's workspace (relation
  // traversal), then intersect against the exported parent sets (drops comments on hidden drafts).
  const allComments = fetchAll(
    "comments",
    "task.workspace = {:w} || document.workspace = {:w} || decision.workspace = {:w}",
    { w: wsId },
  );
  const commentsOut = allComments.filter(function (c) {
    const t = c.get("task");
    const d = c.get("document");
    const dec = c.get("decision");
    return (t && taskIdSet[t]) || (d && docIdSet[d]) || (dec && decIdSet[dec]);
  });
  // Two-shape filter, `task.workspace` or `workspace` — the export promises
  // the WORKSPACE's audit trail, so a row addressing the workspace itself rides along taskless.
  const allActivity = fetchAll(
    "task_activity",
    "(task.workspace = {:w} || workspace = {:w})",
    { w: wsId },
  );
  const activityOut = allActivity.filter(function (a) {
    const t = a.get("task");
    // A task-bearing row still has to be intersected, or a narrowed export gains other tasks.
    return t ? !!taskIdSet[t] : true;
  });
  const allSubs = fetchAll("task_subscribers", "task.workspace = {:w}", {
    w: wsId,
  });
  const subsOut = allSubs.filter(function (s) {
    const t = s.get("task");
    return t && taskIdSet[t];
  });

  // Per-row canAccessRecord is kept: the live listRule is the single source of truth and a hand-rolled
  // membership filter would drift from it; the cost is bounded by one user's notifications per export.
  const notifRule = e.app.findCollectionByNameOrId("notifications").listRule;
  const info = e.requestInfo();
  const notificationsOut = fetchAll("notifications", "user = {:uid}", {
    uid: uid,
  }).filter(function (n) {
    return e.app.canAccessRecord(n, info, notifRule);
  });
  // user_settings.listRule is `user = @request.auth.id` alone.
  const userSettingsOut = fetchAll("user_settings", "user = {:uid}", {
    uid: uid,
  });

  // ── collection subset: null ⇒ all defaults; a list is intersected with them ──
  const DEFAULT_COLLECTIONS = [
    "workspaces",
    "workspace_members",
    "projects",
    "tasks",
    "comments",
    "documents",
    "decisions",
    "milestones",
    "labels",
    "statuses",
    "saved_views",
    "task_activity",
    "task_subscribers",
    "notifications",
    "user_settings",
    "users",
  ];
  const wantList =
    Array.isArray(body.collections) && body.collections.length
      ? DEFAULT_COLLECTIONS.filter(function (c) {
          return body.collections.indexOf(c) !== -1;
        })
      : DEFAULT_COLLECTIONS.slice();
  const want = function (name) {
    return wantList.indexOf(name) !== -1;
  };

  const data = {};
  if (want("workspaces")) data.workspaces = [ws];
  if (want("workspace_members")) data.workspace_members = membersOut;
  if (want("projects")) data.projects = projectsOut;
  if (want("tasks")) data.tasks = tasksOut;
  if (want("comments")) data.comments = commentsOut;
  if (want("documents")) data.documents = documentsOut;
  if (want("decisions")) data.decisions = decisionsOut;
  if (want("milestones")) data.milestones = milestonesOut;
  if (want("labels")) data.labels = labelsOut;
  if (want("statuses")) data.statuses = statusesOut;
  if (want("saved_views")) data.saved_views = savedViewsOut;
  if (want("task_activity")) data.task_activity = activityOut;
  if (want("task_subscribers")) data.task_subscribers = subsOut;
  if (want("notifications")) data.notifications = notificationsOut;
  if (want("user_settings")) data.user_settings = userSettingsOut;

  // ponytail: v1 exports the stored file field value (filenames/refs), NOT the file bytes or a
  // file token — add a signed-URL or bundled-blob path if round-trip re-import needs the bytes.

  // users: ONLY the set REFERENCED by exported rows, each reduced to a safe subset. email rides
  // ONLY the caller's own row (users.emailVisibility=false); password/tokenKey are NEVER emitted.
  if (want("users")) {
    const userIds = {};
    userIds[uid] = true;
    const addRef = function (rec, field) {
      const v = rec.get(field);
      if (!v) return;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (v[i]) userIds[v[i]] = true;
      } else {
        userIds[v] = true;
      }
    };
    if (data.workspaces) addRef(ws, "owner");
    if (data.workspace_members)
      for (let i = 0; i < membersOut.length; i++) addRef(membersOut[i], "user");
    if (data.projects)
      for (let i = 0; i < projectsOut.length; i++)
        addRef(projectsOut[i], "owner");
    if (data.tasks)
      for (let i = 0; i < tasksOut.length; i++) {
        addRef(tasksOut[i], "assignee");
        addRef(tasksOut[i], "trashed_by");
      }
    if (data.documents)
      for (let i = 0; i < documentsOut.length; i++) {
        addRef(documentsOut[i], "author");
        addRef(documentsOut[i], "trashed_by");
      }
    if (data.decisions)
      for (let i = 0; i < decisionsOut.length; i++) {
        addRef(decisionsOut[i], "author");
        addRef(decisionsOut[i], "trashed_by");
      }
    if (data.milestones)
      for (let i = 0; i < milestonesOut.length; i++) {
        addRef(milestonesOut[i], "author");
        addRef(milestonesOut[i], "trashed_by");
      }
    if (data.comments)
      for (let i = 0; i < commentsOut.length; i++)
        addRef(commentsOut[i], "author");
    if (data.task_activity)
      for (let i = 0; i < activityOut.length; i++)
        addRef(activityOut[i], "actor");
    if (data.task_subscribers)
      for (let i = 0; i < subsOut.length; i++) addRef(subsOut[i], "user");
    if (data.saved_views)
      for (let i = 0; i < savedViewsOut.length; i++)
        addRef(savedViewsOut[i], "owner");
    if (data.notifications)
      for (let i = 0; i < notificationsOut.length; i++)
        addRef(notificationsOut[i], "user");
    if (data.user_settings)
      for (let i = 0; i < userSettingsOut.length; i++)
        addRef(userSettingsOut[i], "user");

    const users = [];
    for (const id in userIds) {
      let u;
      try {
        u = e.app.findRecordById("users", id);
      } catch (_) {
        continue; // a referenced user that no longer exists is simply omitted
      }
      const row = {
        id: u.id,
        name: u.getString("name"),
        avatar: u.getString("avatar"),
        verified: u.getBool("verified"),
        approved: u.getBool("approved"),
        created: u.getString("created"),
        updated: u.getString("updated"),
      };
      if (u.id === uid) row.email = u.getString("email"); // self only
      users.push(row);
    }
    data.users = users;
  }

  return e.json(200, {
    format_version: 1,
    exported_at: new Date().toISOString(),
    workspace: wsId,
    scope: {
      projects:
        selectedProjectIds === null ? readableProjectIds : selectedProjectIds,
      collections: wantList,
    },
    data: data,
  });
});

// POST /api/tracker/workspaces/{id}/transfer-ownership — hand a workspace to an existing
// ACTIVE member. workspaces.updateRule ends `@request.body.owner:isset = false`, so PB denies
// an owner PATCH (404) before any update hook could run — the flip only exists here. Routes
// BYPASS collection rules, so auth is re-done by hand and the owner check, both roster reads
// and all three writes land in ONE transaction. A superuser transfers through this same route,
// so the roster is rewritten for that caller too.
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/workspaces/{id}/transfer-ownership",
  (e) => {
    const uid = e.auth.id;
    const wsId = e.request.pathValue("id");

    // Both refusals read no database, so a real and an unknown workspace id answer them
    // identically. An owner declares which workspace state it acted on by BEING the owner;
    // a superuser has no such standing, so it names the owner it believes is current.
    const body = e.requestInfo().body || {};
    const target = (typeof body.user === "string" ? body.user : "").trim();
    if (!target) throw new BadRequestError("user is required");
    const isSuperuser = e.auth.isSuperuser();
    let currentOwner = "";
    if (isSuperuser) {
      currentOwner = (
        typeof body.current_owner === "string" ? body.current_owner : ""
      ).trim();
      if (!currentOwner)
        throw new BadRequestError(
          "current_owner is required: name the person who owns this workspace now",
        );
    }

    // EVERY read is INSIDE the tx: with the owner check resolved outside it, two concurrent
    // transfers by one owner both pass, both answer 200, and the loser rewrites the winner's
    // roster.
    $app.runInTransaction(function (txApp) {
      let ws;
      try {
        ws = txApp.findRecordById("workspaces", wsId);
      } catch (_) {
        throw new NotFoundError("workspace not found");
      }
      // OWNER OR SUPERUSER — unlike the vocab route, an active admin confers no authority here.
      // Deny → 404, SAME as not-found (no existence leak).
      if (ws.get("owner") !== uid && !isSuperuser)
        throw new NotFoundError("workspace not found");
      // AFTER the authorization check: a non-owner must still get the no-leak 404 on a trashed
      // workspace, so only a caller already known to be authorized reads this cause.
      if (String(ws.get("trashed")) !== "")
        throw new BadRequestError(
          "this workspace is in the trash; restore it before transferring ownership",
        );
      // Read INSIDE the tx and AFTER the trash check, so a name that went stale mid-flight and
      // a name that was wrong when sent are the same refusal, and the trash cause still wins.
      if (isSuperuser && ws.get("owner") !== currentOwner)
        throw new BadRequestError(
          "this workspace is owned by someone other than the person named as its current owner; check who owns it and try again",
        );
      // The OUTGOING owner is the workspace's owner, never the caller: a superuser's e.auth.id
      // is a _superusers record id and would mint a roster row for it.
      const outgoingId = ws.get("owner");
      // Without this a no-op call rewrites one row twice, leaving one person owner AND admin.
      if (target === outgoingId)
        throw new BadRequestError("the new owner is already the owner");

      let incoming;
      try {
        incoming = txApp.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u} && status = 'active' && role != 'viewer'",
          { w: wsId, u: target },
        );
      } catch (_) {
        // A viewer IS an active member, so the membership refusal below would be a false
        // statement about one — name the real cause instead.
        let viewer = true;
        try {
          txApp.findFirstRecordByFilter(
            "workspace_members",
            "workspace = {:w} && user = {:u} && status = 'active' && role = 'viewer'",
            { w: wsId, u: target },
          );
        } catch (_) {
          viewer = false;
        }
        if (viewer)
          throw new BadRequestError(
            "a viewer cannot be made the owner of this workspace",
          );
        throw new BadRequestError(
          "the new owner must be an active member of this workspace",
        );
      }

      // Every workspace create gives its owner a roster row (owner.pb.js); it is minted here only if
      // that provision failed, so the handover never leaves the outgoing owner without standing.
      let outgoing;
      try {
        outgoing = txApp.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u}",
          { w: wsId, u: outgoingId },
        );
      } catch (_) {
        outgoing = new Record(
          txApp.findCollectionByNameOrId("workspace_members"),
        );
      }

      ws.set("owner", target);
      txApp.save(ws);

      // The shadow project is owned by the workspace owner (shadow.pb.js); it moves with the handover.
      try {
        const shadow = txApp.findFirstRecordByFilter(
          "projects",
          "workspace = {:w} && shadow = true",
          { w: wsId },
        );
        shadow.set("owner", target);
        txApp.save(shadow);
      } catch (err) {
        if (!String(err).includes("no rows")) throw err;
      }

      // `incoming` is read for eligibility ONLY and deliberately never written: ownership lives
      // on workspaces.owner, so the roster row is the standing held BENEATH it, and rewriting an
      // admin to "member" here destroyed that standing (mahh).

      outgoing.set("workspace", wsId);
      outgoing.set("user", outgoingId);
      outgoing.set("role", "admin");
      outgoing.set("status", "active");
      txApp.save(outgoing);

      // Same transaction as the flip: a handover nobody was told about is the defect 95s3 closes,
      // and a refused transfer must leave no trace, which only a shared rollback guarantees.
      const audit = new Record(txApp.findCollectionByNameOrId("task_activity"));
      audit.set("workspace", wsId);
      // One identity per row, and never both: a member's call fills actor (a users relation),
      // and a superuser's fills operator with the email that made it, because a _superusers id
      // resolves to no users row. An empty pair would be an unattributed handover.
      if (isSuperuser) audit.set("operator", String(e.auth.get("email") || ""));
      else audit.set("actor", uid);
      audit.set("field", "owner");
      // JSON.stringify: the same encoding activity.pb.js gives a relation change.
      audit.set("from", JSON.stringify(outgoingId));
      audit.set("to", JSON.stringify(target));
      txApp.save(audit);

      const notices = txApp.findCollectionByNameOrId("notifications");
      const parties = [outgoingId, target];
      for (let i = 0; i < parties.length; i++) {
        const notice = new Record(notices);
        notice.set("user", parties[i]);
        notice.set("workspace", wsId);
        notice.set("kind", "ownership_transferred");
        // A superuser's id names no users row, so an operator's handover carries no actor.
        if (!isSuperuser) notice.set("actor", uid);
        txApp.save(notice);
      }
    });

    return e.json(200, { ok: true });
  },
);

// GET /api/tracker/workspaces/trash — the trashed workspaces the caller OWNS or ADMINISTERS, the
// switcher's Trash entry. Routes BYPASS collection rules, so this reads what workspaces.viewRule's
// `trashed = ""` hides; restore is the same owner-or-active-admin set under the updateRule.
require(`${__hooks}/lib/routes.js`).add(
  "GET /api/tracker/workspaces/trash",
  (e) => {
    const uid = e.auth.id;
    // OWNER OR ACTIVE ADMIN (decision:workspace-trash-cascades R2), resolved in ONE query through the back-relation
    // rather than a membership lookup per row. A member, a viewer, a suspended admin and a
    // non-member all match zero rows and get the SAME empty 200, so the route confirms no
    // existence. 500 is a declared bound, far above any realistic count of trashed workspaces;
    // the 501st row is fetched only to detect the cut and never served.
    // KEEP IN SYNC: workspaces.updateRule — the set that may restore is the set that may enumerate.
    const recs = e.app.findRecordsByFilter(
      "workspaces",
      "trashed != '' && (owner = {:u} || (workspace_members_via_workspace.user ?= {:u} && " +
        "workspace_members_via_workspace.role ?= 'admin' && " +
        "workspace_members_via_workspace.status ?= 'active'))",
      "-trashed",
      501,
      0,
      { u: uid },
    );
    const items = [];
    for (let i = 0; i < recs.length && i < 500; i++) items.push(recs[i]);
    return e.json(200, {
      count: items.length,
      truncated: recs.length > 500,
      items: items,
    });
  },
);

// GET /api/tracker/workspaces/{id}/deletion-impact — what deleting a workspace takes with it, in
// one read. Routes BYPASS collection rules, so the owner check is by hand; every other caller
// (admin, superuser, unknown id) gets the same 404. Counts include rows the owner's lists hide.
require(`${__hooks}/lib/routes.js`).add(
  "GET /api/tracker/workspaces/{id}/deletion-impact",
  (e) => {
    const wsId = e.request.pathValue("id");
    let ws;
    try {
      ws = e.app.findRecordById("workspaces", wsId);
    } catch (_) {
      throw new NotFoundError("workspace not found");
    }
    if (ws.get("owner") !== e.auth.id)
      throw new NotFoundError("workspace not found");

    const inWs = $dbx.hashExp({ workspace: wsId });
    const live = $dbx.hashExp({ trashed: "" });
    const items = ["tasks", "documents", "decisions", "milestones"];
    let liveItems = 0;
    let trashedItems = 0;
    for (const c of items) {
      const all = e.app.countRecords(c, inWs);
      const l = e.app.countRecords(c, inWs, live);
      liveItems += l;
      trashedItems += all - l;
    }
    return e.json(200, {
      items: liveItems,
      trashed_items: trashedItems,
      projects: e.app.countRecords(
        "projects",
        inWs,
        $dbx.not($dbx.hashExp({ shadow: true })),
      ),
      // The owner's own roster row (signup provisions one) is not a member the delete removes.
      members: e.app.countRecords(
        "workspace_members",
        inWs,
        $dbx.not($dbx.hashExp({ user: ws.get("owner") })),
      ),
      saved_views: e.app.countRecords("saved_views", inWs),
    });
  },
);

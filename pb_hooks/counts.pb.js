/// <reference path="../pb_data/types.d.ts" />
// GET /api/tracker/project-items/counts: group counts in one PB query, visibility from project_items' own live listRule.
routerAdd(
  "GET",
  "/api/tracker/project-items/counts",
  (e) => {
    // A superuser matches no membership branch of the rule, so it would silently count nothing.
    if (e.auth.isSuperuser())
      throw new ForbiddenError(
        "this route answers per-workspace visibility; a superuser caller is refused rather than answered empty",
      );

    const GROUPS = ["project", "status", "priority", "assignee", "label"];
    const group = e.request.url.query().get("group") || "";
    if (GROUPS.indexOf(group) === -1)
      throw new BadRequestError(
        "group must be one of: project, status, priority, assignee, label",
      );

    const filter = e.request.url.query().get("filter") || "";
    // KEEP IN SYNC: routes.pb.js GET /api/tracker/trash inlines this trust check, `filter may only reference project_items' own flat columns`.
    // Parsing a filter costs roughly its length squared and runs before any query, so the
    // 30s query timeout cannot bound it; same ceiling the list API applies to its own filter.
    if (filter.length > 3500)
      throw new BadRequestError("filter must be at most 3500 characters");
    // Trust boundary: spliced into `(rule) && (filter)` unprotected, so only flat view columns and
    // balanced parens pass; literal/escape tracking is fexpr v0.6.0 scanText's (PB 0.40.4's lexer).
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
    // An unterminated quote or an unclosed group is refused too: either would let this route's
    // own wrapping parens/quotes merge with the filter's in a shape PB alone would have to parse.
    if (!unsafe && (quote !== null || depth !== 0)) unsafe = true;
    if (unsafe)
      throw new BadRequestError(
        "filter may only reference project_items' own flat columns",
      );

    // The view's live rule, never a copy.
    // A Go *string reaches the JSVM as a truthy wrapper even when empty, so both cases are named.
    const rule = e.app.findCollectionByNameOrId("project_items").listRule;
    if (rule === null || rule === undefined || String(rule) === "")
      throw new ApiError(
        500,
        "project_items has no listRule to enforce, so GET /api/tracker/project-items/counts cannot scope this request",
        null,
      );
    // KEEP IN SYNC: refuseUnbindableListRule below reaches its verdict with these same three
    // steps — the pooled JSVM forbids one shared helper for the two sites.
    const bare = String(rule).replace(
      /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
      '""',
    );
    const matched =
      bare.match(/@request(?:\.[A-Za-z0-9_]+)*(?::[A-Za-z0-9_]+)?/g) || [];
    const offending = [];
    for (let i = 0; i < matched.length; i++)
      if (
        matched[i] !== "@request.auth.id" &&
        offending.indexOf(matched[i]) === -1
      )
        offending.push(matched[i]);
    if (offending.length)
      throw new ApiError(
        500,
        "project_items listRule carries " +
          offending.join(", ") +
          ", which GET /api/tracker/project-items/counts cannot bind",
        null,
      );
    // Blanking the literals is what makes the count comparable: a mention only inside one is
    // worth nothing as a rule, and substituting into it yields a filter PB cannot parse.
    if (String(rule).split("@request").length !== bare.split("@request").length)
      throw new ApiError(
        500,
        "project_items listRule mentions @request inside a string literal, which GET /api/tracker/project-items/counts cannot bind",
        null,
      );
    // A bound parameter is this route's to declare: a `{:` already in the rule meets the
    // {:authId} bound below and PB answers 400 naming nothing.
    if (String(rule).indexOf("{:") !== -1)
      throw new ApiError(
        500,
        "project_items listRule carries a {: bound-parameter token, which GET /api/tracker/project-items/counts cannot bind",
        null,
      );
    // Safe only because the sole surviving token outside a literal is the one being replaced.
    const substituted = String(rule)
      .split("@request.auth.id")
      .join("{:authId}");

    const combined = filter
      ? "(" + substituted + ") && (" + filter + ")"
      : substituted;
    // limit=0 -> no LIMIT clause: one query fetches every matching row, so the request count
    // stays flat as row count grows (PB core: limit<=0 means unbounded, record_query.go).
    const rows = e.app.findRecordsByFilter(
      "project_items",
      combined,
      "",
      0,
      0,
      {
        authId: e.auth.id,
      },
    );

    const idList = function (raw) {
      // An already-decoded array is a legitimate input on the proxy side of this pair; accepted
      // here too so one rule covers both, never so this hook can receive one (the view casts TEXT).
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== "string" || raw === "") return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    };
    // KEEP IN SYNC: routes.pb.js GET /api/tracker/trash group buckets, `Number(row.get("has_priority")) === 0`.
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
    const items = order.map(function (key) {
      return { key: key === NULL_KEY ? null : key, count: counts[key] };
    });
    return e.json(200, { items: items, total: rows.length });
  },
  $apis.requireAuth(),
);

// Self-contained top-level fn passed DIRECTLY as the handler — legal under the pooled-JSVM law.
function refuseUnbindableListRule(e) {
  const raw = e.collection.listRule;
  const rule = raw === null || raw === undefined ? "" : String(raw);
  // KEEP IN SYNC: the counts route above reaches its verdict with these same three steps —
  // the pooled JSVM forbids one shared helper for the two sites.
  const bare = rule.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const matched =
    bare.match(/@request(?:\.[A-Za-z0-9_]+)*(?::[A-Za-z0-9_]+)?/g) || [];
  const offending = [];
  for (let i = 0; i < matched.length; i++)
    if (
      matched[i] !== "@request.auth.id" &&
      offending.indexOf(matched[i]) === -1
    )
      offending.push(matched[i]);
  if (offending.length)
    throw new BadRequestError(
      "project_items listRule may reference @request.auth.id only: " +
        offending.join(", ") +
        " cannot be bound by GET /api/tracker/project-items/counts, which reads this rule per request",
      null,
    );
  // A mention only inside a string literal is worth nothing as a rule, and the route would
  // splice a bound parameter into that literal, so it is refused rather than skipped.
  if (rule.split("@request").length !== bare.split("@request").length)
    throw new BadRequestError(
      "project_items listRule mentions @request inside a string literal, which GET /api/tracker/project-items/counts cannot bind; quote no @request token in this rule",
      null,
    );
  // A bound parameter is the route's to declare: a `{:` here meets the {:authId} it binds.
  if (rule.indexOf("{:") !== -1)
    throw new BadRequestError(
      "project_items listRule carries a {: bound-parameter token, which GET /api/tracker/project-items/counts cannot bind",
      null,
    );
  return e.next();
}

// Model tier, not *Request: the dashboard, the collections API, importCollections and a
// migration all reach a rule through it. Only a save made with this file loaded is checked, so
// any hookless invocation (a `migrate up` or boot without --hooksDir) stores a rule unchecked.
onCollectionCreate(refuseUnbindableListRule, "project_items");
onCollectionUpdate(refuseUnbindableListRule, "project_items");

// Subtask counts are served here, never as view columns: a column is filterable and sortable,
// which would let a non-member assignee read the true count past any body rewrite.
onRecordEnrich((e) => {
  const type = e.record.get("type");
  let total = 0;
  let done = 0;
  if ((type === "task" || type === "milestone") && !e.record.get("trashed")) {
    const auth = e.requestInfo ? e.requestInfo.auth : null;
    // A non-member reaches a task only as its assignee and lists only the children assigned to them.
    const narrow =
      auth &&
      !auth.isSuperuser() &&
      e.record.get("workspace_owner") !== auth.id &&
      String(e.record.get("active_members")).indexOf("," + auth.id + ",") ===
        -1;
    const res = new DynamicModel({ total: 0, done: 0 });
    e.app
      .db()
      .newQuery(
        // KEEP IN SYNC: subtask done: STATUS_CATEGORIES' resolved half, `completed` and `canceled`, as schema/project_items.view.json reads it (scripts/check_constants.ts).
        "SELECT COUNT(*) AS total, COALESCE(SUM(EXISTS (SELECT 1 FROM statuses ks WHERE ks.id = k.status AND ks.workspace = k.workspace AND ks.category IN ('completed', 'canceled'))), 0) AS done" +
          " FROM tasks k WHERE k." +
          (type === "task" ? "parent" : "milestone") +
          " = {:id} AND k.trashed = ''" +
          // Mirrors tasks.listRule's project leg: a child in a trashed or missing project is listable by nobody.
          " AND (k.project = '' OR EXISTS (SELECT 1 FROM projects p WHERE p.id = k.project AND p.trashed = ''))" +
          (narrow ? " AND k.assignee = {:uid}" : ""),
      )
      .bind({ id: e.record.id, uid: narrow ? auth.id : "" })
      .one(res);
    total = res.total;
    done = res.done;
  }
  e.record.withCustomData(true);
  e.record.set("subtask_total", total);
  e.record.set("subtask_done", done);
  return e.next();
}, "project_items");

// KEEP IN SYNC: statuses enrich: terminal and off_pipeline — STATUS_CATEGORIES' resolved half, `completed` and `canceled`, as schema/project_items.view.json reads it (scripts/check_constants.ts).
onRecordEnrich((e) => {
  const category = e.record.get("category");
  e.record.withCustomData(true);
  e.record.set("terminal", category === "completed" || category === "canceled");
  e.record.set("off_pipeline", category === "canceled");
  return e.next();
}, "statuses");

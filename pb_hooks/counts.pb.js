/// <reference path="../pb_data/types.d.ts" />
// GET /api/tracker/project-items/counts: group counts in one PB query, visibility from project_items' own live listRule.
require(`${__hooks}/lib/routes.js`).add(
  "GET /api/tracker/project-items/counts",
  (e) => {
    // A superuser matches no membership branch of the rule, so it would silently count nothing.
    if (e.auth.isSuperuser())
      throw new ForbiddenError(
        "this route answers per-workspace visibility; a superuser caller is refused rather than answered empty",
      );

    const GROUPS = [
      "project",
      "status",
      "priority",
      "assignee",
      "label",
      "type",
    ];
    const group = e.request.url.query().get("group") || "";
    if (GROUPS.indexOf(group) === -1)
      throw new BadRequestError(
        "group must be one of: project, status, priority, assignee, label, type",
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
        matched[i] !== "@request.headers.x_tm_key_workspace" &&
        matched[i] !== "@request.headers.x_tm_key_projects" &&
        offending.indexOf(matched[i]) === -1
      )
        offending.push(matched[i]);
    if (offending.length)
      throw new ApiError(
        500,
        "project_items listRule carries " +
          offending.join(", ") +
          ", which GET /api/tracker/project-items/counts cannot bind (it binds @request.auth.id, @request.headers.x_tm_key_workspace and @request.headers.x_tm_key_projects)",
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
    // Safe only because the surviving tokens outside a literal are exactly the ones being replaced.
    const substituted = String(rule)
      .split("@request.auth.id")
      .join("{:authId}")
      .split("@request.headers.x_tm_key_workspace")
      .join("{:keyWorkspace}")
      .split("@request.headers.x_tm_key_projects")
      .join("{:keyProjects}");

    const combined = filter
      ? "(" + substituted + ") && (" + filter + ")"
      : substituted;
    // limit=0 -> no LIMIT clause: one query fetches every matching row, so the request count
    // stays flat as row count grows (PB core: limit<=0 means unbounded, record_query.go).
    let rows;
    try {
      rows = e.app.findRecordsByFilter("project_items", combined, "", 0, 0, {
        authId: e.auth.id,
        keyWorkspace: String(e.request.header.get("X-Tm-Key-Workspace") || ""),
        keyProjects: String(e.request.header.get("X-Tm-Key-Projects") || ""),
      });
    } catch (err) {
      // PB prefixes every filter it cannot apply this way; a database failure stays a failure.
      if (filter && String(err).indexOf("invalid filter expression") !== -1)
        throw new BadRequestError(
          "filter names a field the items do not have, or is not a valid filter",
        );
      e.app
        .logger()
        .error(
          "GET /api/tracker/project-items/counts read failed",
          "error",
          String(err),
        );
      throw new InternalServerError("The counts could not be read.");
    }

    const idList = function (raw) {
      // Defensive only: the view casts these columns to TEXT, so a decoded array never arrives.
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
    const items = order.map(function (key) {
      return { key: key === NULL_KEY ? null : key, count: counts[key] };
    });
    return e.json(200, { items: items, total: rows.length });
  },
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
      matched[i] !== "@request.headers.x_tm_key_workspace" &&
      matched[i] !== "@request.headers.x_tm_key_projects" &&
      offending.indexOf(matched[i]) === -1
    )
      offending.push(matched[i]);
  if (offending.length)
    throw new BadRequestError(
      "project_items listRule may reference @request.auth.id and the API-key reach headers only: " +
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

// Refuse boot without the IANA zone database (`tzdata` in Dockerfile): every zone would silently load as UTC.
onBootstrap((e) => {
  if (
    String(new Timezone("Pacific/Kiritimati").string()) !== "Pacific/Kiritimati"
  )
    throw new Error(
      "the time zone database is missing, so no day can be counted in a viewer's time zone; install tzdata in the image",
    );
  e.next();
});

// Subtask counts are served here, never as view columns: a column is filterable and sortable.
onRecordEnrich((e) => {
  const type = e.record.get("type");
  let total = 0;
  let done = 0;
  if ((type === "task" || type === "milestone") && !e.record.get("trashed")) {
    const res = new DynamicModel({ total: 0, done: 0 });
    e.app
      .db()
      .newQuery(
        // KEEP IN SYNC (below): subtask done: STATUS_CATEGORIES' resolved half, `completed` and `canceled`, as schema/project_items.view.json reads it (scripts/check_constants.ts).
        "SELECT COUNT(*) AS total, COALESCE(SUM(EXISTS (SELECT 1 FROM statuses ks WHERE ks.id = k.status AND ks.workspace = k.workspace AND ks.category IN ('completed', 'canceled'))), 0) AS done" +
          " FROM tasks k WHERE k." +
          (type === "task" ? "parent" : "milestone") +
          " = {:id} AND k.trashed = ''" +
          // Mirrors tasks.listRule's project leg: a child in a trashed or missing project is listable by nobody.
          " AND (k.project = '' OR EXISTS (SELECT 1 FROM projects p WHERE p.id = k.project AND p.trashed = ''))",
      )
      .bind({ id: e.record.id })
      .one(res);
    total = res.total;
    done = res.done;
  }
  // KEEP IN SYNC (below): viewer's day — project_stats enrich below and routes.pb.js GET /api/tracker/trash resolve it the same way, `String(new Timezone(sent).string()) !== sent`.
  const info = e.requestInfo;
  const viewer = info && info.auth ? info.auth.id : "";
  const sent = info && info.query ? String(info.query["time_zone"] || "") : "";
  if (
    sent &&
    (sent === "Local" || String(new Timezone(sent).string()) !== sent)
  )
    throw new BadRequestError(
      "The time zone must be an IANA name, such as Europe/Paris.",
    );
  let zone = sent;
  if (viewer) {
    try {
      const saved = e.app
        .findFirstRecordByFilter("user_settings", "user = {:u}", { u: viewer })
        .getString("time_zone");
      if (
        saved &&
        saved !== "Local" &&
        String(new Timezone(saved).string()) === saved
      )
        zone = saved;
    } catch (_) {}
  }
  const today = String(
    new DateTime().time().in(new Timezone(zone)).format("2006-01-02"),
  );
  const dayNumber = (ymd) =>
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(5, 7)) - 1,
      Number(ymd.slice(8, 10)),
    ) / 86400000;
  // A due date is a calendar day: its stored date, never shifted into the viewer's zone.
  const due = String(e.record.get("due") || "");
  const dueDays = /^\d{4}-\d{2}-\d{2}/.test(due)
    ? dayNumber(due) - dayNumber(today)
    : null;
  let reason = "";
  if (
    type === "task" &&
    viewer &&
    e.record.get("assignee") === viewer &&
    !e.record.get("status_terminal")
  )
    // Inbox thresholds (decision:viewer-day-values): overdue below 0 days, due soon at 3 days or fewer.
    reason =
      dueDays === null
        ? "assigned"
        : dueDays < 0
          ? "overdue"
          : dueDays <= 3
            ? "due_soon"
            : "assigned";

  e.record.withCustomData(true);
  e.record.set("subtask_total", total);
  e.record.set("subtask_done", done);
  e.record.set("due_days", dueDays);
  e.record.set("reason", reason);
  return e.next();
}, "project_items");

// next_milestone: the earliest live published milestone dated on or after the viewer's today, else the latest dated one.
onRecordEnrich((e) => {
  // KEEP IN SYNC (below): viewer's day — the project_items enrich above and routes.pb.js GET /api/tracker/trash resolve it the same way, `String(new Timezone(sent).string()) !== sent`.
  const info = e.requestInfo;
  const viewer = info && info.auth ? info.auth.id : "";
  const sent = info && info.query ? String(info.query["time_zone"] || "") : "";
  if (
    sent &&
    (sent === "Local" || String(new Timezone(sent).string()) !== sent)
  )
    throw new BadRequestError(
      "The time zone must be an IANA name, such as Europe/Paris.",
    );
  let zone = sent;
  if (viewer) {
    try {
      const saved = e.app
        .findFirstRecordByFilter("user_settings", "user = {:u}", { u: viewer })
        .getString("time_zone");
      if (
        saved &&
        saved !== "Local" &&
        String(new Timezone(saved).string()) === saved
      )
        zone = saved;
    } catch (_) {}
  }
  const today = String(
    new DateTime().time().in(new Timezone(zone)).format("2006-01-02"),
  );
  const res = new DynamicModel({ id: "" });
  // Drafts are skipped: a member who cannot open one must not learn its id here.
  const live =
    " FROM milestones m WHERE m.project = {:p} AND m.trashed = '' AND m.draft = 0 AND COALESCE(m.target, '') != ''";
  e.app
    .db()
    .newQuery(
      "SELECT COALESCE((SELECT m.id" +
        live +
        " AND substr(m.target, 1, 10) >= {:today} ORDER BY substr(m.target, 1, 10), m.id LIMIT 1), (SELECT m.id" +
        live +
        " ORDER BY substr(m.target, 1, 10) DESC, m.id DESC LIMIT 1), '') AS id",
    )
    .bind({ p: e.record.id, today: today })
    .one(res);
  e.record.withCustomData(true);
  e.record.set("next_milestone", res.id);
  return e.next();
}, "project_stats");

// KEEP IN SYNC (below): statuses enrich: terminal and off_pipeline — STATUS_CATEGORIES' resolved half, `completed` and `canceled`, as schema/project_items.view.json reads it (scripts/check_constants.ts).
onRecordEnrich((e) => {
  const category = e.record.get("category");
  e.record.withCustomData(true);
  e.record.set("terminal", category === "completed" || category === "canceled");
  e.record.set("off_pipeline", category === "canceled");
  return e.next();
}, "statuses");

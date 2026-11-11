/// <reference path="../../pb_data/types.d.ts" />
// API key helpers: whether request text names api_keys (decision:api-key-reads-refused), a key's plain request-store object and the level each request needs; require() inside a handler body.

// The text lower-cased at each round of percent-decoding (byte by byte, "+" as space, as Go reads a
// query, never throwing) plus JSON \u escapes until stable; null when it never settles (fail closed).
function decodedForms(text) {
  const forms = [String(text).toLowerCase()];
  for (let i = 0; i < 8; i++) {
    const last = forms[forms.length - 1];
    const next = last
      .replace(/\+/g, " ")
      .replace(/%([0-9a-fA-F]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .toLowerCase();
    if (next === last) return forms;
    forms.push(next);
  }
  return null;
}

// So no spelling PocketBase decodes slips past.
function namesApiKeys(app, text) {
  const id = app.findCollectionByNameOrId("api_keys").id.toLowerCase();
  const forms = decodedForms(text);
  return (
    !forms ||
    forms.some((t) => t.indexOf("api_keys") !== -1 || t.indexOf(id) !== -1)
  );
}

function mentionsExpand(text) {
  const forms = decodedForms(text);
  return !forms || forms.some((t) => t.indexOf("expand") !== -1);
}

// The request-store and `me` view of a key; a key made before reach existed reads as reach all.
function keyInfo(key) {
  return {
    id: key.id,
    scope: key.getString("scope"),
    expires: key.getString("expires"),
    client_id: key.getString("client_id"),
    reach: key.getString("reach") || "all",
    workspace: key.getString("workspace"),
    // The JSON round trip yields a plain array.
    projects: JSON.parse(JSON.stringify(key.getStringSlice("projects"))),
  };
}

// decision:api-key-reach-and-levels: the level order and the level each write needs.
const LEVELS = ["read", "write", "manage", "own"];

// An unknown level on either side refuses, so a typo in a table fails closed.
function levelAtLeast(have, need) {
  const n = LEVELS.indexOf(need);
  return n !== -1 && LEVELS.indexOf(have) >= n;
}

// Keys are "METHOD /pattern"; null = no level check (a superuser-only route).
const ROUTE_LEVELS = {
  "POST /api/tracker/notifications/read-all": "write",
  "PATCH /api/tracker/users/{id}/settings": "write",
  "POST /api/tracker/workspaces/{id}/vocab": "manage",
  "POST /api/tracker/workspaces/{id}/resolve-member-email": "manage",
  "POST /api/tracker/workspaces/{id}/transfer-ownership": "own",
  "POST /api/tracker/invitations/{id}/accept": "own",
  "POST /api/tracker/invitations/{id}/decline": "own",
  "POST /api/tracker/trash/purge": null,
  "POST /api/tracker/cycles/rollover": null,
};

// A string applies to every write method.
const COLLECTION_LEVELS = {
  tasks: "write",
  decisions: "write",
  documents: "write",
  milestones: "write",
  projects: "write",
  comments: "write",
  task_subscribers: "write",
  saved_views: "write",
  notifications: "write",
  user_settings: "write",
  labels: "manage",
  statuses: "manage",
  cycles: "manage",
  templates: "manage",
  workspace_invitations: "manage",
  workspace_members: "manage",
  workspaces: { POST: "write", PATCH: "manage", DELETE: "own" },
};

// collection is the target's name for a records route, else "". Unlisted writes need own (fail closed).
function requiredLevel(method, route, collection) {
  if (method === "GET" || method === "HEAD") return "read";
  if (
    method === "POST" &&
    (route === "/api/realtime" ||
      route === "/api/files/token" ||
      route === "/api/tracker/export")
  )
    return "read";
  if (collection !== "") {
    const entry = COLLECTION_LEVELS[collection];
    if (typeof entry === "string") return entry;
    return (entry && entry[method]) || "own";
  }
  const key = method + " " + route;
  if (Object.prototype.hasOwnProperty.call(ROUTE_LEVELS, key))
    return ROUTE_LEVELS[key];
  return "own";
}

function levelMessage(have, need) {
  if (have === "read") return "This API key is read-only.";
  if (need === "own") return "This action needs an API key at the own level.";
  return "This action needs an API key at the " + need + " level or above.";
}

// null for a key that reaches every workspace.
function keyReach(info) {
  if (!info || info.reach === "all") return null;
  return {
    workspace: info.workspace,
    projects: info.reach === "projects" ? info.projects : null,
  };
}

// "-" stands for a projects key left with no project, so it matches none.
function reachHeaders(info) {
  const reach = keyReach(info);
  if (!reach) return {};
  return {
    x_tm_key_workspace: reach.workspace,
    x_tm_key_projects: reach.projects ? reach.projects.join(",") || "-" : "",
  };
}

// decision:api-key-reach-and-levels: requests that act for the whole account, refused to a limited key.
const ACCOUNT_WIDE = [
  "GET /api/tracker/me/landing",
  "GET /api/tracker/workspaces/{id}/switch",
  "GET /api/tracker/invitations/mine",
  "POST /api/tracker/invitations/{id}/accept",
  "POST /api/tracker/invitations/{id}/decline",
  "PATCH /api/tracker/users/{id}/settings",
  "POST /api/files/token",
];

function accountWide(method, route, collection) {
  return (
    ACCOUNT_WIDE.indexOf(method + " " + route) !== -1 ||
    (collection === "workspaces" && method === "POST") ||
    (collection === "user_settings" && method !== "GET" && method !== "HEAD")
  );
}

const REACH_MESSAGE =
  "This API key is limited to part of the tracker, so it cannot be used for this endpoint.";

// PB 0.40.4 names a header's rule token with inflector.Snakecase: split on runs of [^A-Za-z0-9], "_" before an upper after a non-upper, lower-cased.
function ruleToken(name) {
  const up = (c) => c >= "A" && c <= "Z";
  let out = "";
  for (const w of String(name).split(/[^A-Za-z0-9]+/)) {
    if (!w) continue;
    if (out) out += "_";
    for (let i = 0; i < w.length; i++)
      out += (i > 0 && up(w[i]) && !up(w[i - 1]) ? "_" : "") + w[i];
  }
  return out.toLowerCase();
}

const REACH_TOKENS = ["x_tm_key_workspace", "x_tm_key_projects"];

// toString JSON-encodes the Go header map, the one JSVM route to its raw names; a name left after del refuses the request.
function stripReachHeaders(header) {
  const reachNames = () =>
    Object.keys(JSON.parse(toString(header))).filter(
      (n) => REACH_TOKENS.indexOf(ruleToken(n)) !== -1,
    );
  const found = reachNames();
  if (!found.length) return;
  for (const n of found) header.del(n);
  if (reachNames().length)
    throw new BadRequestError(
      "The request carries a header the tracker does not accept.",
    );
}

// KEEP IN SYNC: the C_* clauses of the key reach rules migration.
function inReach(app, name, rec, reach) {
  const W = reach.workspace;
  const P = reach.projects;
  const inP = (id) => !!id && P.indexOf(id) !== -1;
  const item = (ws, pr) => ws === W && (P === null || inP(pr));
  const parent = (coll, id) => {
    try {
      const r = app.findRecordById(coll, id);
      return item(r.getString("workspace"), r.getString("project"));
    } catch (_) {
      return false;
    }
  };
  switch (name) {
    case "workspaces":
      return rec.id === W;
    case "workspace_members":
    case "labels":
    case "statuses":
    case "cycles":
      return rec.workspace === W;
    case "workspace_invitations":
      return rec.workspace === W && P === null;
    case "projects":
      return rec.workspace === W && (P === null || inP(rec.id));
    case "tasks":
    case "decisions":
    case "documents":
    case "milestones":
    case "templates":
    case "saved_views":
      return item(rec.workspace, rec.project);
    case "comments":
      if (rec.task) return parent("tasks", rec.task);
      if (rec.document) return parent("documents", rec.document);
      if (rec.decision) return parent("decisions", rec.decision);
      return false;
    case "task_subscribers":
      return parent("tasks", rec.task);
    case "task_activity":
      return rec.task
        ? parent("tasks", rec.task)
        : rec.workspace === W && P === null;
    case "notifications":
      return (
        rec.workspace === W &&
        (P === null ||
          (!!rec.task && parent("tasks", rec.task)) ||
          (!!rec.document && parent("documents", rec.document)) ||
          (!!rec.decision && parent("decisions", rec.decision)))
      );
    case "users":
    case "user_settings":
    case "app_docs":
    case "app_settings":
      return true;
    default:
      return false;
  }
}

module.exports = {
  namesApiKeys,
  mentionsExpand,
  keyInfo,
  LEVELS,
  ROUTE_LEVELS,
  COLLECTION_LEVELS,
  levelAtLeast,
  requiredLevel,
  levelMessage,
  keyReach,
  reachHeaders,
  ACCOUNT_WIDE,
  accountWide,
  REACH_MESSAGE,
  stripReachHeaders,
  inReach,
};

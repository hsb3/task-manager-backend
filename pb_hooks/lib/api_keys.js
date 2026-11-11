/// <reference path="../../pb_data/types.d.ts" />
// API key helpers: whether request text names api_keys (decision:api-key-reads-refused), a key's plain request-store object and the level each request needs; require() inside a handler body.

// Checks the raw text, its percent-decoding (byte by byte, as Go reads a query, never throwing)
// and that decoding with JSON \u escapes resolved, so no spelling PocketBase decodes slips past.
function namesApiKeys(app, text) {
  const id = app.findCollectionByNameOrId("api_keys").id.toLowerCase();
  const raw = String(text);
  const decoded = raw
    .replace(/\+/g, " ")
    .replace(/%([0-9a-fA-F]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
  const unescaped = decoded.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  return [raw, decoded, unescaped].some((t) => {
    const lower = t.toLowerCase();
    return lower.indexOf("api_keys") !== -1 || lower.indexOf(id) !== -1;
  });
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

function levelAtLeast(have, need) {
  return LEVELS.indexOf(have) >= LEVELS.indexOf(need);
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

module.exports = {
  namesApiKeys,
  keyInfo,
  LEVELS,
  ROUTE_LEVELS,
  COLLECTION_LEVELS,
  levelAtLeast,
  requiredLevel,
  levelMessage,
  keyReach,
  reachHeaders,
};

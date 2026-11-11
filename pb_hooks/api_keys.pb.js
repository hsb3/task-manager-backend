/// <reference path="../pb_data/types.d.ts" />
// API keys (decision:api-keys): mint a hashed tmk_ key, then authenticate key requests as their owner.

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  const key = "tmk_" + $security.randomString(40);
  e.record.set("key_hash", $security.sha256(key));
  e.record.set("client_id", "");
  // A superuser mints for the user it names; anyone else only for themself.
  if (!e.hasSuperuserAuth()) e.record.set("user", e.auth.id);

  // decision:api-key-reach-and-levels: reach, workspace, projects and level must agree and be reachable.
  const reach = e.record.getString("reach") || "all";
  e.record.set("reach", reach);
  const scope = e.record.getString("scope");
  const ws = e.record.getString("workspace");
  const ps = e.record.getStringSlice("projects");
  const uid = e.record.getString("user");
  // Any other reach is refused by the select field's own validation in e.next().
  if (reach === "all" || reach === "workspace" || reach === "projects") {
    const errors = {};
    const refuse = (field, code, message) => {
      if (!errors[field]) errors[field] = new ValidationError(code, message);
    };
    const refuseAll = () => {
      if (Object.keys(errors).length) {
        throw new BadRequestError(
          "The key's reach or level is not valid.",
          errors,
        );
      }
    };
    if (reach !== "all" && !ws)
      refuse(
        "workspace",
        "validation_required",
        "Choose the workspace this key is limited to.",
      );
    if (reach === "all" && (ws || ps.length))
      refuse(
        "workspace",
        "key_reach_mismatch",
        "A key that reaches every workspace names no workspace or projects.",
      );
    if (reach === "workspace" && ps.length)
      refuse(
        "projects",
        "key_reach_mismatch",
        "Only a key limited to projects names projects.",
      );
    if (reach === "projects" && !ps.length)
      refuse("projects", "validation_required", "Choose at least one project.");
    refuseAll();
    if (ws) {
      let reachable = false;
      try {
        const w = $app.findRecordById("workspaces", ws);
        if (w.getString("trashed") === "") {
          reachable = w.getString("owner") === uid;
          if (!reachable) {
            try {
              $app.findFirstRecordByFilter(
                "workspace_members",
                "workspace = {:w} && user = {:u} && status = 'active'",
                { w: ws, u: uid },
              );
              reachable = true;
            } catch (_) {}
          }
        }
      } catch (_) {}
      if (!reachable)
        refuse(
          "workspace",
          "key_workspace_unreachable",
          "Choose a workspace you belong to.",
        );
    }
    for (const pid of ps) {
      let live = false;
      try {
        const p = $app.findRecordById("projects", pid);
        live =
          p.getString("workspace") === ws &&
          p.getString("trashed") === "" &&
          !p.getBool("shadow");
      } catch (_) {}
      if (!live)
        refuse(
          "projects",
          "key_project_unreachable",
          "Each project must be a live project of the chosen workspace.",
        );
    }
    if (reach === "projects" && (scope === "manage" || scope === "own"))
      refuse(
        "scope",
        "key_level_above_write",
        "A key limited to projects can only read or write.",
      );
    refuseAll();
  }

  e.record.withCustomData(true);
  e.record.set("key", key);
  e.next();
}, "api_keys");

// Priority -1030 runs before PB's loadAuthToken (-1020), which skips once e.auth is set.
require(`${__hooks}/lib/routes.js`).use(
  new Middleware(
    (e) => {
      const p = e.request.url.path;
      if (p.startsWith("/oauth/") || p.startsWith("/.well-known/"))
        return e.next();
      const header = e.request.header
        .get("Authorization")
        .trim()
        .replace(/^bearer\s+/i, "");
      if (!header.startsWith("tmk_")) return e.next();

      const invalid = "The API key is invalid, revoked or expired.";
      let key;
      try {
        key = $app.findFirstRecordByData(
          "api_keys",
          "key_hash",
          $security.sha256(header),
        );
      } catch (_) {
        key = null;
      }
      const expires = key ? key.getDateTime("expires") : null;
      if (
        !key ||
        key.getBool("revoked") ||
        (!expires.isZero() && !expires.after(new DateTime()))
      ) {
        throw new ApiError(401, invalid, {
          api_key: new ValidationError("api_key_invalid", invalid),
        });
      }
      const owner = $app.findRecordById("users", key.get("user"));
      // A bare RequestInfo: e.requestInfo() would read the whole body before PB's body limit.
      const info = new RequestInfo({ auth: owner });
      if (!$app.canAccessRecord(owner, info, owner.collection().authRule)) {
        throw new ApiError(401, invalid, {
          api_key: new ValidationError("api_key_invalid", invalid),
        });
      }

      // Allowlist by the MATCHED route pattern, never the raw URL.
      const method = e.request.method;
      const route = String(e.request.pattern).replace(/^[A-Z]+ /, "");
      // An unmatched request reaches here under PB's catch-all pattern.
      if (route === "/{path...}" || route === "/") throw new NotFoundError();
      if (e.request.pathValue("collection")) {
        try {
          $app.findCollectionByNameOrId(e.request.pathValue("collection"));
        } catch (_) {
          throw new NotFoundError();
        }
      }
      let allowed = false;
      if (
        route === "/api/collections/{collection}/records" ||
        route === "/api/collections/{collection}/records/{id}"
      ) {
        let target = null;
        try {
          target = $app.findCollectionByNameOrId(
            e.request.pathValue("collection"),
          );
        } catch (_) {}
        allowed =
          !!target &&
          !target.system &&
          !target.name.startsWith("_") &&
          target.name !== "api_keys" &&
          (target.name !== "users" || method === "GET" || method === "HEAD");
      } else {
        // KEEP IN SYNC: scripts/gen_openapi.ts renders this allowlist (`/api/tracker/admin/`) and the read list (`/api/tracker/export`) into every route's description.
        allowed =
          route.startsWith("/api/files/") ||
          route === "/api/realtime" ||
          (route.startsWith("/api/tracker/") &&
            !route.startsWith("/api/tracker/admin/"));
      }
      if (!allowed) {
        const msg = "API keys cannot be used for this endpoint.";
        throw new ApiError(403, msg, {
          api_key: new ValidationError("api_key_path", msg),
        });
      }

      const reads =
        method === "GET" ||
        method === "HEAD" ||
        (method === "POST" &&
          (route === "/api/realtime" ||
            route === "/api/files/token" ||
            route === "/api/tracker/export"));
      if (key.getString("scope") === "read" && !reads) {
        const msg = "This API key is read-only.";
        throw new ApiError(403, msg, {
          api_key: new ValidationError("api_key_scope", msg),
        });
      }

      // decision:api-key-reads-refused: rules cannot tell a key from its owner, and relation joins skip api_keys rules.
      if (
        require(`${__hooks}/lib/api_keys.js`).namesApiKeys(
          $app,
          e.request.url.rawQuery,
        )
      ) {
        const msg = "API keys cannot read API keys.";
        throw new ApiError(403, msg, {
          api_key: new ValidationError("api_key_path", msg),
        });
      }

      e.set("tmApiKey", require(`${__hooks}/lib/api_keys.js`).keyInfo(key));
      e.auth = owner;
      return e.next();
    },
    -1030,
    "tmkApiKeyAuth",
  ),
);

// A key's realtime subscriptions arrive in the body, out of the middleware's reach.
onRealtimeSubscribeRequest((e) => {
  const header = e.requestEvent.request.header
    .get("Authorization")
    .trim()
    .replace(/^bearer\s+/i, "");
  if (!header.startsWith("tmk_")) return e.next();
  const lib = require(`${__hooks}/lib/api_keys.js`);
  for (let i = 0; i < e.subscriptions.length; i++) {
    if (lib.namesApiKeys($app, e.subscriptions[i])) {
      const msg = "API keys cannot read API keys.";
      throw new ApiError(403, msg, {
        api_key: new ValidationError("api_key_path", msg),
      });
    }
  }
  return e.next();
});

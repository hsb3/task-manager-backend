/// <reference path="../pb_data/types.d.ts" />
// API keys (decision:api-keys): mint a hashed tmk_ key, then authenticate key requests as their owner.

onRecordCreateRequest((e) => {
  const key = "tmk_" + $security.randomString(40);
  e.record.set("key_hash", $security.sha256(key));
  // A superuser mints for the user it names; anyone else only for themself.
  if (!e.hasSuperuserAuth()) e.record.set("user", e.auth.id);
  e.record.withCustomData(true);
  e.record.set("key", key);
  e.next();
}, "api_keys");

// Priority -1030 runs before PB's loadAuthToken (-1020), which skips once e.auth is set.
require(`${__hooks}/lib/routes.js`).use(
  new Middleware(
    (e) => {
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
      if (key.getString("scope") !== "write" && !reads) {
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

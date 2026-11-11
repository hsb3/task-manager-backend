/// <reference path="../pb_data/types.d.ts" />
// The caller's API keys: list and revoke (decision:api-key-manages-keys).
require(`${__hooks}/lib/routes.js`).add("GET /api/tracker/keys", (e) => {
  const via = e.get("tmApiKey");
  const self = !!via && via.reach !== "all";
  if (via && !self && !via.manage_keys)
    throw new ApiError(403, "This API key cannot list or revoke keys.", {
      api_key: new ValidationError(
        "api_key_manage",
        "This API key cannot list or revoke keys.",
      ),
    });
  const { keyItem } = require(`${__hooks}/lib/api_keys.js`);
  const rows = self
    ? [$app.findRecordById("api_keys", via.id)]
    : $app.findRecordsByFilter("api_keys", "user = {:u}", "-created,id", 0, 0, {
        u: e.auth.id,
      });
  return e.json(200, { items: rows.map((r) => keyItem(r, via)) });
});

require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/keys/{id}/revoke",
  (e) => {
    const via = e.get("tmApiKey");
    const self = !!via && via.reach !== "all";
    if (via && !self && !via.manage_keys)
      throw new ApiError(403, "This API key cannot list or revoke keys.", {
        api_key: new ValidationError(
          "api_key_manage",
          "This API key cannot list or revoke keys.",
        ),
      });
    const { keyItem } = require(`${__hooks}/lib/api_keys.js`);
    let r;
    try {
      r = $app.findRecordById("api_keys", e.request.pathValue("id"));
    } catch (_) {
      r = null;
    }
    if (!r || r.getString("user") !== e.auth.id || (self && r.id !== via.id))
      throw new ApiError(404, "No key with that id among yours.", {});
    if (!r.getBool("revoked")) {
      r.set("revoked", true);
      $app.save(r);
    }
    return e.json(200, keyItem(r, via));
  },
);

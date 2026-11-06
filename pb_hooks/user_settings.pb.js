/// <reference path="../pb_data/types.d.ts" />
// /api/tracker/users/{id}/settings: the caller's users.name and user_settings row, read together and written in one transaction.

routerAdd(
  "GET",
  "/api/tracker/users/{id}/settings",
  (e) => {
    // Another user's id answers like a denied record view, so the route reveals no account.
    if (e.request.pathValue("id") !== e.auth.id)
      throw new NotFoundError("The requested resource wasn't found.");
    let us = null;
    try {
      us = e.app.findFirstRecordByFilter("user_settings", "user = {:u}", {
        u: e.auth.id,
      });
    } catch (_) {
      us = null;
    }
    // KEEP IN SYNC: the response shape and defaults in the PATCH route below.
    return e.json(200, {
      display_name: e.auth.getString("name"),
      theme: us ? us.getString("theme") : "system",
      font: us ? us.getString("font") : "system",
      font_size: us ? us.getInt("font_size") : 0,
      default_view: us ? us.getString("default_view") : "",
      default_project: us ? us.getString("default_project") : "",
      time_zone: us ? us.getString("time_zone") : "",
    });
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "PATCH",
  "/api/tracker/users/{id}/settings",
  (e) => {
    if (e.request.pathValue("id") !== e.auth.id)
      throw new NotFoundError("The requested resource wasn't found.");
    const body = e.requestInfo().body || {};
    const allowed = [
      "display_name",
      "theme",
      "font",
      "font_size",
      "default_view",
      "default_project",
      "time_zone",
    ];
    const keys = Object.keys(body);
    const unknown = keys.filter((k) => allowed.indexOf(k) === -1);
    if (unknown.length)
      throw new BadRequestError(
        "These fields cannot be changed here: " + unknown.join(", ") + ".",
      );
    if (!keys.length) throw new BadRequestError("No changes were supplied.");
    // decision:api-keys: a key never changes the account, so it may save settings but not the name.
    // KEEP IN SYNC: pb_hooks/api_keys.pb.js `.replace(/^bearer\s+/i, "");` key-header parse.
    const authz = e.request.header
      .get("Authorization")
      .trim()
      .replace(/^bearer\s+/i, "");
    if ("display_name" in body && authz.startsWith("tmk_")) {
      const msg = "API keys cannot change the account name.";
      throw new ApiError(403, msg, {
        api_key: new ValidationError("api_key_path", msg),
      });
    }
    if ("display_name" in body && typeof body.display_name !== "string") {
      throw new BadRequestError("The display name must be text.", {
        display_name: new ValidationError(
          "validation_invalid_value",
          "Must be text.",
        ),
      });
    }
    const rules = require(`${__hooks}/lib/workspace_rules.js`);
    const name =
      "display_name" in body
        ? rules.refuseBlankUserName(
            "display_name",
            body.display_name,
            e.auth.getString("name"),
          )
        : null;
    let stored = null;
    try {
      stored = e.app.findFirstRecordByFilter("user_settings", "user = {:u}", {
        u: e.auth.id,
      });
    } catch (_) {
      stored = null;
    }
    // Route saves skip the *Request hooks, so this applies the user_settings write checks itself,
    // to the values as the record normalises them (an array id is stored as its one id).
    const probe = stored
      ? stored.clone()
      : new Record(e.app.findCollectionByNameOrId("pbc_300100008")); // user_settings
    for (const k of keys) if (k !== "display_name") probe.set(k, body[k]);
    const pick = (r) => ({
      default_project: r ? r.getString("default_project") : "",
      default_view: r ? r.getString("default_view") : "",
      time_zone: r ? r.getString("time_zone") : "",
    });
    rules.validateUserSettings(
      e.app,
      e.requestInfo(),
      pick(probe),
      pick(stored),
    );
    let user = null;
    let us = null;
    // A field error from txApp.save already answers 400 with PB's field data.
    e.app.runInTransaction((txApp) => {
      user = txApp.findRecordById("users", e.auth.id);
      if ("display_name" in body) {
        user.set("name", name);
        txApp.save(user);
      }
      try {
        us = txApp.findFirstRecordByFilter("user_settings", "user = {:u}", {
          u: user.id,
        });
      } catch (_) {
        // KEEP IN SYNC: pb_hooks/main.pb.js `us.set("theme", "system");` provisioning defaults.
        us = new Record(txApp.findCollectionByNameOrId("pbc_300100008")); // user_settings
        us.set("user", user.id);
        us.set("theme", "system");
        us.set("font", "system");
      }
      for (const k of keys) if (k !== "display_name") us.set(k, body[k]);
      txApp.save(us);
    });
    // KEEP IN SYNC: the response shape and defaults in the GET route above.
    return e.json(200, {
      display_name: user.getString("name"),
      theme: us.getString("theme"),
      font: us.getString("font"),
      font_size: us.getInt("font_size"),
      default_view: us.getString("default_view"),
      default_project: us.getString("default_project"),
      time_zone: us.getString("time_zone"),
    });
  },
  $apis.requireAuth("users"),
);

/// <reference path="../pb_data/types.d.ts" />
// The signed-in user's landing workspace and the workspace switch check; both read through lib/landing.js.

routerAdd(
  "GET",
  "/api/tracker/me/landing",
  (e) => {
    const lib = require(`${__hooks}/lib/landing.js`);
    return e.json(200, { landing: lib.landingFor(e.app, e.auth) });
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "GET",
  "/api/tracker/workspaces/{id}/switch",
  (e) => {
    const lib = require(`${__hooks}/lib/landing.js`);
    return e.json(
      200,
      lib.switchCheck(e.app, e.auth, e.request.pathValue("id")),
    );
  },
  $apis.requireAuth("users"),
);

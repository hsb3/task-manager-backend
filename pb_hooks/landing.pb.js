/// <reference path="../pb_data/types.d.ts" />
// The signed-in user's landing workspace and the workspace switch check; both read through lib/landing.js.

require(`${__hooks}/lib/routes.js`).add("GET /api/tracker/me/landing", (e) => {
  const lib = require(`${__hooks}/lib/landing.js`);
  return e.json(200, { landing: lib.landingFor(e.app, e.auth) });
});

require(`${__hooks}/lib/routes.js`).add(
  "GET /api/tracker/workspaces/{id}/switch",
  (e) => {
    const lib = require(`${__hooks}/lib/landing.js`);
    return e.json(
      200,
      lib.switchCheck(e.app, e.auth, e.request.pathValue("id")),
    );
  },
);

/// <reference path="../pb_data/types.d.ts" />
// GET /api/tracker/me: the caller's live workspaces with role, status, counts and capabilities, and their unread notification count, in one call.
require(`${__hooks}/lib/routes.js`).add("GET /api/tracker/me", (e) => {
  if (e.auth.isSuperuser())
    throw new ForbiddenError(
      "This route answers for a signed-in user's own workspaces, and a superuser has none.",
    );
  const uid = e.auth.id;
  const k = e.get("tmApiKey");
  const lib = require(`${__hooks}/lib/api_keys.js`);
  const level = k ? k.scope : "own";
  const reach = lib.keyReach(k);
  const kp =
    reach && reach.projects ? "," + reach.projects.join(",") + "," : "";
  const rows = arrayOf(
    new DynamicModel({ id: "", name: "", owner: "", role: "", status: "" }),
  );
  // One membership row per (workspace, user) by unique index, so the join yields one row per workspace.
  e.app
    .db()
    .newQuery(
      "SELECT w.id AS id, w.name AS name, w.owner AS owner, COALESCE(m.role, '') AS role, COALESCE(m.status, '') AS status" +
        " FROM workspaces w LEFT JOIN workspace_members m ON m.workspace = w.id AND [[m.user]] = {:u}" +
        " WHERE w.trashed = '' AND (w.owner = {:u} OR m.id IS NOT NULL)" +
        (reach ? " AND w.id = {:kw}" : "") +
        " ORDER BY w.created, w.id",
    )
    .bind({ u: uid, kw: reach ? reach.workspace : "" })
    .all(rows);

  const workspaces = [];
  for (let i = 0; i < rows.length; i++) {
    const w = rows[i];
    const owner = w.owner === uid;
    const role = owner ? "owner" : w.role;
    // workspaces.viewRule: the owner, or an active membership, reads the workspace.
    const active = owner || w.status === "active";
    let counts = null;
    if (active) {
      const res = new DynamicModel({ projects: 0, open_items: 0 });
      e.app
        .db()
        .newQuery(
          "SELECT (SELECT COUNT(*) FROM projects p WHERE p.workspace = {:w} AND p.trashed = '' AND p.shadow = 0" +
            (kp ? " AND instr({:kp}, ',' || p.id || ',') > 0" : "") +
            ") AS projects," +
            " (SELECT COUNT(*) FROM tasks k WHERE k.workspace = {:w} AND k.trashed = ''" +
            (kp
              ? " AND k.project != '' AND instr({:kp}, ',' || k.project || ',') > 0"
              : "") +
            // Mirrors tasks.listRule's project leg: a task in a trashed or missing project is listable by nobody.
            " AND (k.project = '' OR EXISTS (SELECT 1 FROM projects kp WHERE kp.id = k.project AND kp.trashed = ''))" +
            // KEEP IN SYNC: open items: STATUS_CATEGORIES' resolved half, `completed` and `canceled`, as schema/project_items.view.json reads it (scripts/check_constants.ts).
            " AND NOT EXISTS (SELECT 1 FROM statuses ks WHERE ks.id = k.status AND ks.workspace = k.workspace AND ks.category IN ('completed', 'canceled'))) AS open_items",
        )
        .bind({ w: w.id, kp: kp })
        .one(res);
      counts = { projects: res.projects, open_items: res.open_items };
    }
    // decision:role-tiers: write = items and projects, manage = settings, vocabulary, invites and purge, own = roles, transfer, workspace delete; a key holds at most its level.
    workspaces.push({
      id: w.id,
      // A suspended member cannot read the workspace, so its name is withheld here too.
      name: active ? w.name : null,
      role: role,
      status: owner ? "active" : w.status,
      counts: counts,
      capabilities: {
        write: active && role !== "viewer" && lib.levelAtLeast(level, "write"),
        manage:
          active &&
          (role === "owner" || role === "admin") &&
          lib.levelAtLeast(level, "manage") &&
          !(reach && reach.projects),
        own: owner && level === "own" && !(reach && reach.projects),
      },
    });
  }

  // The inbox's own rule decides each row, so this count and the read=false list total are one set.
  // shortcut: one rule query per unread row; bind the rule into one counting query if inboxes grow large.
  const rule = e.app.findCollectionByNameOrId("notifications").listRule;
  const info = e.requestInfo();
  const unread = e.app
    .findRecordsByFilter(
      "notifications",
      "user = {:u} && read = false && dismissed = false",
      "",
      0,
      0,
      { u: uid },
    )
    .filter((n) => e.app.canAccessRecord(n, info, rule)).length;

  const answer = {
    user: { id: uid, name: e.auth.getString("name") },
    unread_notifications: unread,
    workspaces: workspaces,
  };
  if (k) answer.key = k;
  return e.json(200, answer);
});

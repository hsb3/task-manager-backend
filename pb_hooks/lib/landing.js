/// <reference path="../../pb_data/types.d.ts" />
// Where a signed-in user lands and whether they may switch to a named workspace; require() it inside a handler body.

function earliest(app, collection, filter, params) {
  const rows = app.findRecordsByFilter(
    collection,
    filter,
    "created",
    1,
    0,
    params,
  );
  return rows.length ? rows[0] : null;
}

// An empty stored membership status reads as active.
const ACTIVE = "(status = 'active' || status = '')";

function landingFor(app, user) {
  const at = (workspace, reason, invitation) => ({
    workspace: workspace,
    reason: reason,
    invitation: invitation || null,
  });
  const u = { u: user.id };
  const owned = earliest(app, "workspaces", "owner = {:u} && trashed = ''", u);
  if (owned) return at(owned.id, "owned");
  const live = "user = {:u} && workspace.trashed = ''";
  const member = earliest(app, "workspace_members", `${live} && ${ACTIVE}`, u);
  if (member) return at(member.getString("workspace"), "member");
  const key = user.getString("email_key");
  if (key) {
    const invLib = require(`${__hooks}/lib/invitations.js`);
    const days = invLib.expiryDays(app);
    const invs = app.findRecordsByFilter(
      "workspace_invitations",
      "email_key = {:k} && workspace.trashed = ''",
      "created",
      0,
      0,
      { k: key },
    );
    for (let i = 0; i < invs.length; i++) {
      const ws = invs[i].getString("workspace");
      if (invLib.expiry(invs[i].getString("created"), days).expired) continue;
      // Accepting leaves an existing (here, suspended) row as it is, so it is no way in.
      const held = earliest(
        app,
        "workspace_members",
        "workspace = {:w} && user = {:u}",
        { w: ws, u: user.id },
      );
      if (!held) return at(ws, "invitation", invs[i].id);
    }
  }
  const suspended = earliest(app, "workspace_members", live, u);
  return suspended ? at(suspended.getString("workspace"), "suspended") : null;
}

function switchCheck(app, user, wsId) {
  const verdict = (allowed, reason, invitation) => ({
    workspace: wsId,
    allowed: allowed,
    reason: reason,
    invitation: invitation || null,
  });
  let ws;
  try {
    ws = app.findRecordById("workspaces", wsId);
  } catch (_) {
    return verdict(false, "not_found");
  }
  if (ws.getString("trashed") !== "") return verdict(false, "not_found");
  if (ws.getString("owner") === user.id) return verdict(true, null);
  const row = earliest(
    app,
    "workspace_members",
    "workspace = {:w} && user = {:u}",
    {
      w: wsId,
      u: user.id,
    },
  );
  const status = row ? row.getString("status") : "";
  if (row && (status === "active" || status === "")) return verdict(true, null);
  // A refused caller's invitation tells a client to offer the join screen; a suspended row
  // survives accepting, so a suspended member is never offered one.
  let invitation = null;
  const key = user.getString("email_key");
  const inv =
    key && !row
      ? earliest(
          app,
          "workspace_invitations",
          "workspace = {:w} && email_key = {:k}",
          {
            w: wsId,
            k: key,
          },
        )
      : null;
  if (inv) {
    const invLib = require(`${__hooks}/lib/invitations.js`);
    invitation = {
      id: inv.id,
      expired: invLib.expiry(inv.getString("created"), invLib.expiryDays(app))
        .expired,
    };
  }
  return verdict(false, row ? "suspended" : "not_found", invitation);
}

module.exports = { landingFor: landingFor, switchCheck: switchCheck };

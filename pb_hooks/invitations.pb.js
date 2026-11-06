/// <reference path="../pb_data/types.d.ts" />
// workspace_invitations: the server-side fold on create, and the invitee's list/accept/decline routes (decision:invitation-keyed-by-email).

// Universal, not *Request: the invite route's programmatic save and a direct collection create
// must reach the same key, and the (workspace, email_key) unique index is the backstop.
onRecordCreate((e) => {
  // Nested, not top-level: the pooled JSVM cannot share a helper across callbacks.
  // An app_settings.value reads back either a plain number or a JSVM byte-array.
  function readIntSetting(key, fallback) {
    try {
      const raw = e.app
        .findFirstRecordByFilter("app_settings", "key = {:k}", { k: key })
        .get("value");
      let parsed = NaN;
      if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
        let text = "";
        for (let i = 0; i < raw.length; i++)
          text += String.fromCharCode(raw[i]);
        parsed = parseInt(text, 10);
      } else {
        parsed = parseInt(String(raw), 10);
      }
      return !isNaN(parsed) && parsed >= 0 ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }
  // ── INLINED FOLD (invitation copy) — KEEP IN SYNC: pb_hooks/oauth.pb.js `googlemail.com`; the
  // pooled JSVM cannot share a top-level helper.
  const raw = String(e.record.getString("email") || "");
  const canonical = raw.trim().toLowerCase();
  let key = canonical;
  const at = canonical.lastIndexOf("@");
  if (at !== -1) {
    const domain = canonical.slice(at + 1);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      key =
        canonical.slice(0, at).split("+")[0].split(".").join("") + "@" + domain;
    }
  }
  // ── END INLINED FOLD (invitation copy) ──
  if (!canonical)
    throw new BadRequestError("Email must be a non-empty string.");
  e.record.set("email", canonical);
  // Always overwritten: a client-supplied key would let an invitation match someone else.
  e.record.set("email_key", key);
  // Set only by the request hook below: the universal tier carries no auth of its own.
  if (e.record.get("invitationLimitExempt") === true) return e.next();
  const inviter = e.record.getString("invited_by");
  const wsId = e.record.getString("workspace");
  // KEEP IN SYNC: pb_hooks/invitation_expiry.pb.js `invitation_expiry_days`
  const days = readIntSetting("invitation_expiry_days", 7);
  const declineCutoff = new Date(Date.now() - days * 86400000)
    .toISOString()
    .replace("T", " ");
  const tombstones = e.app.findRecordsByFilter(
    "invitation_events",
    "workspace = {:w} && email_key = {:k} && kind = 'decline' && created > {:c}",
    "",
    1,
    0,
    { w: wsId, k: key, c: declineCutoff },
  );
  if (tombstones.length) {
    const msg =
      "This person recently declined an invitation to this workspace. You can invite them again later.";
    throw new ApiError(409, msg, {
      email: new ValidationError("invitation_recently_declined", msg),
    });
  }
  // Fail closed: an unattributed send would escape the per-inviter limit.
  if (!inviter)
    throw new BadRequestError(
      "This invitation could not be sent. Please try again.",
    );
  const limit = readIntSetting("invitation_mint_limit_per_day", 50);
  const now = new Date();
  const eventId = $security.randomStringWithAlphabet(
    15,
    "abcdefghijklmnopqrstuvwxyz0123456789",
  );
  // One conditional INSERT claims a slot atomically: a count-then-save would let parallel invites overshoot.
  const claimed = e.app
    .db()
    .newQuery(
      "INSERT INTO invitation_events (id, kind, inviter, workspace, email_key, created) " +
        "SELECT {:id}, 'mint', {:u}, {:w}, {:k}, {:now} " +
        "WHERE (SELECT COUNT(*) FROM invitation_events WHERE kind = 'mint' AND inviter = {:u} AND created > {:since}) < {:limit}",
    )
    .bind({
      id: eventId,
      u: inviter,
      w: wsId,
      k: key,
      now: now.toISOString().replace("T", " "),
      since: new Date(now.getTime() - 86400000).toISOString().replace("T", " "),
      limit: limit,
    })
    .execute()
    .rowsAffected();
  if (claimed !== 1) {
    const msg =
      "You have reached the daily limit for sending invitations. Try again later.";
    throw new ApiError(429, msg, {
      email: new ValidationError("invitation_limit_reached", msg),
    });
  }
  try {
    return e.next();
  } catch (err) {
    // An invitation that did not land (a duplicate, a validation error) spends no slot.
    e.app
      .db()
      .newQuery("DELETE FROM invitation_events WHERE id = {:id}")
      .bind({ id: eventId })
      .execute();
    throw err;
  }
}, "workspace_invitations");

onRecordCreateRequest((e) => {
  // A superuser has no users id to stamp, so its submitted value stands.
  if (e.auth && !e.auth.isSuperuser()) e.record.set("invited_by", e.auth.id);
  // A custom key, never a field: a request body cannot set it (only collection fields load).
  if (e.auth && e.auth.isSuperuser())
    e.record.set("invitationLimitExempt", true);
  return e.next();
}, "workspace_invitations");

// PB's DELETE loads the row before it writes and succeeds on a row already gone, so a revoke
// racing an accept would answer 204 for a consumed invitation. One conditional DELETE claims the
// row atomically; PB's own delete that follows is then a no-op.
onRecordDeleteExecute((e) => {
  const claimed = e.app
    .db()
    .newQuery("DELETE FROM workspace_invitations WHERE id = {:id}")
    .bind({ id: e.record.id })
    .execute()
    .rowsAffected();
  if (claimed !== 1) throw new NotFoundError("Invitation not found.");
  return e.next();
}, "workspace_invitations");

// GET /api/tracker/invitations/mine — a client filter cannot name the hidden email_key, and the
// invitee cannot read the workspace record yet, so the match and workspace_name come from here.
routerAdd(
  "GET",
  "/api/tracker/invitations/mine",
  (e) => {
    const key = e.auth.getString("email_key");
    // ── INLINED EXPIRY DAYS (mine copy) — KEEP IN SYNC: pb_hooks/invitation_expiry.pb.js `invitation_expiry_days` ──
    let days = 7;
    try {
      const raw = e.app
        .findFirstRecordByFilter("app_settings", "key = {:k}", {
          k: "invitation_expiry_days",
        })
        .get("value");
      let parsed = NaN;
      if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
        let text = "";
        for (let i = 0; i < raw.length; i++)
          text += String.fromCharCode(raw[i]);
        parsed = parseInt(text, 10);
      } else {
        parsed = parseInt(String(raw), 10);
      }
      if (!isNaN(parsed) && parsed >= 0) days = parsed;
    } catch (_) {
      days = 7;
    }
    // ── END INLINED EXPIRY DAYS (mine copy) ──
    const items = [];
    if (!key) return e.json(200, { items: items });
    const rows = e.app.findRecordsByFilter(
      "workspace_invitations",
      "email_key = {:k}",
      "created",
      0,
      0,
      { k: key },
    );
    const now = Date.now();
    for (let i = 0; i < rows.length; i++) {
      let ws;
      try {
        ws = e.app.findRecordById("workspaces", rows[i].getString("workspace"));
      } catch (_) {
        continue;
      }
      if (String(ws.get("trashed")) !== "") continue;
      const created = rows[i].getString("created");
      const expiresMs = Date.parse(created.replace(" ", "T")) + days * 86400000;
      items.push({
        id: rows[i].id,
        workspace: ws.id,
        workspace_name: ws.getString("name"),
        role: rows[i].getString("role"),
        created: created,
        expires_at: new Date(expiresMs).toISOString().replace("T", " "),
        expired: now >= expiresMs,
      });
    }
    return e.json(200, { items: items });
  },
  $apis.requireAuth("users"),
);

// POST /api/tracker/invitations/{id}/accept — refusal order: not the caller's / trashed (404, so
// no existence oracle), unverified (403), expired (410); then one transaction.
routerAdd(
  "POST",
  "/api/tracker/invitations/{id}/accept",
  (e) => {
    const uid = e.auth.id;
    const key = e.auth.getString("email_key");
    let inv;
    try {
      inv = e.app.findRecordById(
        "workspace_invitations",
        e.request.pathValue("id"),
      );
    } catch (_) {
      throw new NotFoundError("Invitation not found.");
    }
    if (!key || inv.getString("email_key") !== key)
      throw new NotFoundError("Invitation not found.");
    const wsId = inv.getString("workspace");
    let ws;
    try {
      ws = e.app.findRecordById("workspaces", wsId);
    } catch (_) {
      throw new NotFoundError("Invitation not found.");
    }
    if (String(ws.get("trashed")) !== "")
      throw new NotFoundError("Invitation not found.");
    // users.authRule already refuses an unverified login; this catches an impersonation token.
    if (!e.auth.getBool("verified"))
      throw new ForbiddenError(
        "Confirm your email address before accepting an invitation.",
      );
    // ── INLINED EXPIRY DAYS (accept copy) — KEEP IN SYNC: pb_hooks/invitation_expiry.pb.js `invitation_expiry_days` ──
    let days = 7;
    try {
      const raw = e.app
        .findFirstRecordByFilter("app_settings", "key = {:k}", {
          k: "invitation_expiry_days",
        })
        .get("value");
      let parsed = NaN;
      if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
        let text = "";
        for (let i = 0; i < raw.length; i++)
          text += String.fromCharCode(raw[i]);
        parsed = parseInt(text, 10);
      } else {
        parsed = parseInt(String(raw), 10);
      }
      if (!isNaN(parsed) && parsed >= 0) days = parsed;
    } catch (_) {
      days = 7;
    }
    // ── END INLINED EXPIRY DAYS (accept copy) ──
    const expiresMs =
      Date.parse(inv.getString("created").replace(" ", "T")) + days * 86400000;
    if (Date.now() >= expiresMs) {
      // The row stays until the sweep takes it, so the invitee's list shows it as expired.
      const msg = "This invitation has expired.";
      throw new ApiError(410, msg, {
        invitation: new ValidationError("invitation_expired", msg),
      });
    }
    let out = null;
    e.app.runInTransaction((txApp) => {
      // Re-read under the write lock: a concurrent accept, decline or revoke may have consumed
      // the row since the checks above, and deleting a gone row does not fail.
      let cur, txWs;
      try {
        cur = txApp.findRecordById("workspace_invitations", inv.id);
        txWs = txApp.findRecordById("workspaces", wsId);
        if (
          cur.getString("email_key") !== key ||
          String(txWs.get("trashed")) !== ""
        )
          return;
      } catch (_) {
        return;
      }
      let m = null;
      try {
        // Status-blind on purpose: an existing row in any status is left exactly as it is,
        // so accepting never reactivates a suspended member.
        m = txApp.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u}",
          { w: wsId, u: uid },
        );
      } catch (_) {
        m = null;
      }
      // The owner already has full authority and a row; accepting their own invitation writes
      // nothing and answers as the owner, same as an existing member's row is left untouched.
      if (!m && txWs.get("owner") !== uid) {
        m = new Record(txApp.findCollectionByNameOrId("workspace_members"));
        m.set("workspace", wsId);
        m.set("user", uid);
        m.set("role", cur.getString("role"));
        m.set("status", "active");
        txApp.save(m);
      }
      txApp.delete(cur);
      out =
        m && txWs.get("owner") !== uid
          ? {
              workspace: wsId,
              membership: m.id,
              role: m.getString("role"),
              // An empty stored status is the backfill convention for active.
              status: m.getString("status") || "active",
            }
          : {
              workspace: wsId,
              membership: null,
              role: "owner",
              status: "active",
            };
    });
    // Thrown out here, not inside the callback, so it keeps its 404 status.
    if (!out) throw new NotFoundError("Invitation not found.");
    return e.json(200, out);
  },
  $apis.requireAuth("users"),
);

// POST /api/tracker/invitations/{id}/decline — same 404s as accept; an expired row may still be declined.
routerAdd(
  "POST",
  "/api/tracker/invitations/{id}/decline",
  (e) => {
    const key = e.auth.getString("email_key");
    let inv;
    try {
      inv = e.app.findRecordById(
        "workspace_invitations",
        e.request.pathValue("id"),
      );
    } catch (_) {
      throw new NotFoundError("Invitation not found.");
    }
    if (!key || inv.getString("email_key") !== key)
      throw new NotFoundError("Invitation not found.");
    let ws;
    try {
      ws = e.app.findRecordById("workspaces", inv.getString("workspace"));
    } catch (_) {
      throw new NotFoundError("Invitation not found.");
    }
    if (String(ws.get("trashed")) !== "")
      throw new NotFoundError("Invitation not found.");
    let declined = false;
    e.app.runInTransaction((txApp) => {
      // Re-read under the write lock, as accept does: a row already consumed answers 404.
      let cur;
      try {
        cur = txApp.findRecordById("workspace_invitations", inv.id);
      } catch (_) {
        return;
      }
      if (cur.getString("email_key") !== key) return;
      txApp.delete(cur);
      // The tombstone that refuses a repeat invitation from this workspace for the expiry window.
      const ev = new Record(
        txApp.findCollectionByNameOrId("invitation_events"),
      );
      ev.set("kind", "decline");
      ev.set("workspace", cur.getString("workspace"));
      ev.set("email_key", key);
      txApp.save(ev);
      declined = true;
    });
    if (!declined) throw new NotFoundError("Invitation not found.");
    return e.json(200, { declined: true });
  },
  $apis.requireAuth("users"),
);

// Every collection read of an invitation carries the backend-computed expiry (decision:backend-owns-business-rules); the collection rules stay the only authorization.
onRecordEnrich((e) => {
  // ── INLINED EXPIRY DAYS (enrich copy) — KEEP IN SYNC: pb_hooks/invitation_expiry.pb.js `invitation_expiry_days` ──
  let days = 7;
  try {
    const raw = e.app
      .findFirstRecordByFilter("app_settings", "key = {:k}", {
        k: "invitation_expiry_days",
      })
      .get("value");
    let parsed = NaN;
    if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
      let text = "";
      for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);
      parsed = parseInt(text, 10);
    } else {
      parsed = parseInt(String(raw), 10);
    }
    if (!isNaN(parsed) && parsed >= 0) days = parsed;
  } catch (_) {
    days = 7;
  }
  // ── END INLINED EXPIRY DAYS (enrich copy) ──
  const created = e.record.getString("created");
  const expiresMs = Date.parse(created.replace(" ", "T")) + days * 86400000;
  e.record.withCustomData(true);
  e.record.set(
    "expires_at",
    new Date(expiresMs).toISOString().replace("T", " "),
  );
  e.record.set("expired", Date.now() >= expiresMs);
  e.next();
}, "workspace_invitations");

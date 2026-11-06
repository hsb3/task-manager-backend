/// <reference path="../pb_data/types.d.ts" />
// workspace_invitations: the server-side fold on create, the invitation mail, and the invitee's list/accept/decline routes (decision:invitation-keyed-by-email).

// Universal, not *Request: the invite route's programmatic save and a direct collection create
// must reach the same key, and the (workspace, email_key) unique index is the backstop.
onRecordCreate((e) => {
  const invLib = require(`${__hooks}/lib/invitations.js`);
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
  const declineCutoff = invLib.daysAgo(invLib.expiryDays(e.app));
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
  const limit = invLib.readIntSetting(
    e.app,
    "invitation_mint_limit_per_day",
    50,
  );
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
  // Custom data set before e.next() reaches the create response and no later read.
  e.record.withCustomData(true);
  e.record.set(
    "mail_sent",
    !(e.auth && e.auth.isSuperuser()) && e.app.settings().smtp.enabled,
  );
  return e.next();
}, "workspace_invitations");

// Per-boot secret that lets only this server call the invitation mail route below.
onBootstrap((e) => {
  e.next();
  e.app.store().set("invitationMailSecret", $security.randomString(40));
});

// Universal, not *Request: the invite route's programmatic save must mail too (decision:invitation-mail-and-resend).
onRecordAfterCreateSuccess((e) => {
  e.next();
  if (e.record.get("invitationLimitExempt") === true) return;
  // With SMTP off PB falls back to the host's sendmail, which would deliver real mail.
  if (!e.app.settings().smtp.enabled) {
    e.app
      .logger()
      .warn(
        "invitation email skipped: SMTP disabled",
        "invitation",
        e.record.id,
      );
    return;
  }
  const failure = require(`${__hooks}/lib/invitations.js`).dispatchMail(
    e.app,
    e.record.id,
  );
  if (failure) {
    e.app
      .logger()
      .error(
        "invitation email failed",
        "invitation",
        e.record.id,
        "err",
        failure.split(e.record.getString("email")).join("[address]"),
      );
  }
}, "workspace_invitations");

// Answers 204 before sending, so the create that called it never waits on SMTP.
require(`${__hooks}/lib/routes.js`).add(
  "POST /internal/invitation-mail/{id}",
  (e) => {
    const secret = e.app.store().get("invitationMailSecret");
    if (
      !secret ||
      !$security.equal(e.request.header.get("X-Invitation-Mail"), secret)
    ) {
      throw new NotFoundError();
    }
    // Close: the caller would otherwise reuse this connection while the send still holds it.
    e.response.header().set("Connection", "close");
    e.response.writeHeader(204);
    e.flush();

    // A batch create commits only after its hook returns, so wait for the row.
    const id = e.request.pathValue("id");
    let inv = null;
    for (let i = 0; i < 50 && !inv; i++) {
      try {
        inv = e.app.findRecordById("workspace_invitations", id);
      } catch (_) {
        sleep(100);
      }
    }
    if (!inv) return;
    const email = inv.getString("email");
    try {
      const invLib = require(`${__hooks}/lib/invitations.js`);
      const settings = e.app.settings();
      const appURL = settings.meta.appURL;
      const wsName = e.app
        .findRecordById("workspaces", inv.getString("workspace"))
        .getString("name");
      let inviter = "";
      try {
        inviter = e.app
          .findRecordById("users", inv.getString("invited_by"))
          .getString("name");
      } catch (_) {
        inviter = "";
      }
      const ex = invLib.expiry(
        inv.getString("created"),
        invLib.expiryDays(e.app),
      );
      const text = [
        `${inviter || "Someone"} invited you to join the workspace ${wsName} on Task Tracker with the role ${inv.getString("role")}.`,
        "",
        `Sign in at ${appURL} with this email address: ${email}`,
        "If you do not have an account yet, create one with this address first; a new account is confirmed by email and then approved by an administrator before it can sign in.",
        "",
        `Invitation id: ${inv.id}`,
        `To accept it: POST ${appURL}/api/tracker/invitations/${inv.id}/accept`,
        `To decline it: POST ${appURL}/api/tracker/invitations/${inv.id}/decline`,
        "",
        `This invitation expires on ${ex.expires_at.slice(0, 16)} UTC.`,
      ].join("\n");
      e.app.newMailClient().send(
        new MailerMessage({
          from: {
            address: settings.meta.senderAddress,
            name: settings.meta.senderName || "Task Tracker",
          },
          to: [{ address: email }],
          subject: "[Task Tracker] You are invited to join " + wsName,
          text: text,
        }),
      );
    } catch (err) {
      e.app
        .logger()
        .error(
          "invitation email failed",
          "invitation",
          id,
          "err",
          String(err).split(email).join("[address]"),
        );
    }
  },
);

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
require(`${__hooks}/lib/routes.js`).add(
  "GET /api/tracker/invitations/mine",
  (e) => {
    const key = e.auth.getString("email_key");
    const invLib = require(`${__hooks}/lib/invitations.js`);
    const days = invLib.expiryDays(e.app);
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
    for (let i = 0; i < rows.length; i++) {
      let ws;
      try {
        ws = e.app.findRecordById("workspaces", rows[i].getString("workspace"));
      } catch (_) {
        continue;
      }
      if (String(ws.get("trashed")) !== "") continue;
      const created = rows[i].getString("created");
      const ex = invLib.expiry(created, days);
      items.push({
        id: rows[i].id,
        workspace: ws.id,
        workspace_name: ws.getString("name"),
        role: rows[i].getString("role"),
        created: created,
        expires_at: ex.expires_at,
        expired: ex.expired,
      });
    }
    return e.json(200, { items: items });
  },
);

// POST /api/tracker/invitations/{id}/accept — refusal order: not the caller's / trashed (404, so
// no existence oracle), unverified (403), expired (410); then one transaction.
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/invitations/{id}/accept",
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
    const invLib = require(`${__hooks}/lib/invitations.js`);
    const days = invLib.expiryDays(e.app);
    if (invLib.expiry(inv.getString("created"), days).expired) {
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
);

// POST /api/tracker/invitations/{id}/decline — same 404s as accept; an expired row may still be declined.
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/invitations/{id}/decline",
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
);

// Every collection read of an invitation carries the backend-computed expiry (decision:backend-owns-business-rules); the collection rules stay the only authorization.
onRecordEnrich((e) => {
  const invLib = require(`${__hooks}/lib/invitations.js`);
  const days = invLib.expiryDays(e.app);
  const ex = invLib.expiry(e.record.getString("created"), days);
  e.record.withCustomData(true);
  e.record.set("expires_at", ex.expires_at);
  e.record.set("expired", ex.expired);
  e.next();
}, "workspace_invitations");

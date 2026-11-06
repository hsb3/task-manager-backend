/// <reference path="../pb_data/types.d.ts" />
// workspace_members.status moves only active<->suspended; a stale write is refused 409; the owner's row is fixed.

// Ownership moves only through transfer-ownership, so the owner's own row cannot be demoted,
// suspended, reassigned or removed. A superuser is exempt: operator repair and the fixtures that prove the rest.
// KEEP IN SYNC: the owner-row refusal on update and on delete below.
onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  if (e.auth && e.auth.isSuperuser()) return e.next();
  const o = e.record.original();
  const owner = e.app
    .findRecordById("workspaces", o.getString("workspace"))
    .getString("owner");
  if (o.getString("user") !== owner) return e.next();
  const changed = ["role", "status", "user", "workspace"].filter(
    (f) => e.record.getString(f) !== o.getString(f),
  );
  // Raising the row to active admin is no demotion: an owner handed a member row may fix it.
  const toAdmin =
    e.record.getString("role") === "admin" &&
    e.record.getString("status") === "active" &&
    changed.indexOf("user") === -1 &&
    changed.indexOf("workspace") === -1;
  if (!changed.length || toAdmin) return e.next();
  const msg =
    "The owner's membership cannot be changed. To hand the workspace over, transfer ownership.";
  const data = {};
  for (const f of changed)
    data[f] = new ValidationError("last_active_owner", msg);
  throw new ApiError(409, msg, data);
}, "workspace_members");

onRecordDeleteRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) return e.next();
  const owner = e.app
    .findRecordById("workspaces", e.record.getString("workspace"))
    .getString("owner");
  if (e.record.getString("user") !== owner) return e.next();
  const msg =
    "The owner cannot be removed from the workspace. To hand the workspace over, transfer ownership.";
  throw new ApiError(409, msg, {
    user: new ValidationError("last_active_owner", msg),
  });
}, "workspace_members");

// A membership created without a role is a plain member; a blank role is still refused.
onRecordCreateRequest((e) => {
  if (!("role" in (e.requestInfo().body || {}))) e.record.set("role", "member");
  return e.next();
}, "workspace_members");

onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/unknown_keys.js`).refuseUnknownKeys(e); // unknown key answers first
  // An empty stored status is the backfill convention for active.
  const from = e.record.original().getString("status") || "active";
  const to = e.record.getString("status") || "active";
  if (from === to) return e.next();
  if (to !== "active" && to !== "suspended")
    throw new BadRequestError("That is not a valid membership status.");
  if (
    (from === "active" && to === "suspended") ||
    (from === "suspended" && to === "active")
  )
    return e.next();
  throw new BadRequestError(
    "This membership cannot be changed to that status.",
  );
}, "workspace_members");

// PB writes back the whole row it loaded, so the compare-and-set claim and the row write share one
// transaction; e.next() cannot join it (it writes through e.app and deadlocks on the one write connection).
onRecordUpdateExecute((e) => {
  const loaded = e.record.original();
  const claim = {
    s: e.record.getString("status"),
    r: e.record.getString("role"),
    id: e.record.id,
    os: loaded.getString("status"),
    or: loaded.getString("role"),
  };
  try {
    e.app.runInTransaction((txApp) => {
      const claimed = txApp
        .db()
        .newQuery(
          "UPDATE workspace_members SET status = {:s}, role = {:r} WHERE id = {:id} AND status = {:os} AND role = {:or}",
        )
        .bind(claim)
        .execute()
        .rowsAffected();
      if (claimed !== 1)
        throw new ApiError(
          409,
          "This membership changed while you were editing it. Reload and try again.",
          null,
        );
      // ponytail: the hookless save skips PB's field interceptors, so the two this collection
      // needs are restated here (updated autodate, unique-index 400); a new file/autodate field or a later
      // execute-stage hook on workspace_members would silently not run and must be restated too.
      e.record.setRaw("updated", new DateTime());
      try {
        txApp.unsafeWithoutHooks().save(e.record);
      } catch (err) {
        const msg = String(err).toLowerCase().replace(/,/g, " ") + " ";
        if (!msg.includes("unique constraint failed")) throw err;
        const data = {};
        for (const f of e.record.collection().fields.fieldNames())
          if (msg.includes(" workspace_members." + f.toLowerCase() + " "))
            data[f] = new ValidationError(
              "validation_not_unique",
              "Value must be unique",
            );
        throw new BadRequestError("Failed to update record.", data);
      }
      // Revoke pending invitations to the suspended member's address (security audit R-1); re-admission
      // is the status flip back to active, since accepting an invitation never reactivates a suspended row.
      if (claim.s === "suspended" && (claim.os || "active") !== "suspended") {
        let emailKey = "";
        try {
          emailKey = txApp
            .findRecordById("users", e.record.getString("user"))
            .getString("email_key");
        } catch (_) {
          emailKey = "";
        }
        if (emailKey) {
          txApp
            .db()
            .newQuery(
              "DELETE FROM workspace_invitations WHERE workspace = {:w} AND email_key = {:k}",
            )
            .bind({ w: e.record.getString("workspace"), k: emailKey })
            .execute();
        }
      }
    });
  } catch (err) {
    // KEEP IN SYNC: routes.pb.js `typeof v.marshalJSON === "function"` — a refusal (status) or field validation error keeps its own answer.
    const v = err.value || err;
    if (v && (v.status || typeof v.marshalJSON === "function")) throw err;
    e.app
      .logger()
      .error("workspace_members update failed", "error", String(err));
    throw new InternalServerError("The membership could not be saved.");
  }
}, "workspace_members");

/// <reference path="../pb_data/types.d.ts" />
// workspace_members.status moves only active<->suspended; a stale write is refused 409.

onRecordUpdateRequest((e) => {
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
    // A member who was just suspended must not self-reactivate via a pending invitation to
    // their own address (security audit R-1) — an invitation minted AFTER this point (a
    // deliberate re-admission) is untouched since it does not exist yet.
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
}, "workspace_members");

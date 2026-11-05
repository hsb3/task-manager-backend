/// <reference path="../pb_data/types.d.ts" />

// ── Pending invitations expire past app_settings.invitation_expiry_days; the invitation_events ledger is pruned alongside ──

onBootstrap((e) => {
  e.next();

  cronAdd("invitation-expiry", "30 5 * * *", () => {
    try {
      // ── INLINED EXPIRY DAYS (sweep copy) — KEEP IN SYNC: pb_hooks/invitations.pb.js `invitation_expiry_days`, parsed there by readIntSetting ──
      var days = 7;
      try {
        var raw = $app
          .findFirstRecordByFilter("app_settings", "key = {:k}", {
            k: "invitation_expiry_days",
          })
          .get("value");
        var parsed = NaN;
        if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
          var text = "";
          for (var i = 0; i < raw.length; i++)
            text += String.fromCharCode(raw[i]);
          parsed = parseInt(text, 10);
        } else {
          parsed = parseInt(String(raw), 10);
        }
        if (!isNaN(parsed) && parsed >= 0) days = parsed;
      } catch (_) {
        days = 7;
      }
      // ── END INLINED EXPIRY DAYS (sweep copy) ──

      // Same instant the accept route refuses at: expired = now >= created + days.
      var cutoff = new Date(Date.now() - days * 86400000)
        .toISOString()
        .replace("T", " ");
      var recs = $app.findRecordsByFilter(
        "workspace_invitations",
        "created <= {:cutoff}",
        "",
        0,
        0,
        { cutoff: cutoff },
      );
      var expired = 0;
      for (var r = 0; r < recs.length; r++) {
        try {
          $app.delete(recs[r]);
          expired++;
        } catch (_) {
          /* per-record: skip a row that won't delete */
        }
      }
      // Never under a day: the ledger's mint rows are the daily invitation limit's count.
      var eventCutoff = new Date(Date.now() - Math.max(1, days) * 86400000)
        .toISOString()
        .replace("T", " ");
      var pruned = $app
        .db()
        .newQuery("DELETE FROM invitation_events WHERE created <= {:cutoff}")
        .bind({ cutoff: eventCutoff })
        .execute()
        .rowsAffected();
      $app
        .logger()
        .info(
          "invitation-expiry swept",
          "expired",
          expired,
          "expiryDays",
          days,
          "eventsPruned",
          pruned,
        );
    } catch (err) {
      $app.logger().error("invitation-expiry failed", "error", String(err));
    }
  });
});

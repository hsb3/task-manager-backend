/// <reference path="../pb_data/types.d.ts" />

// ── Pending invitations expire past app_settings.invitation_expiry_days; the invitation_events ledger is pruned alongside ──

onBootstrap((e) => {
  e.next();

  cronAdd("invitation-expiry", "30 5 * * *", () => {
    try {
      var invLib = require(`${__hooks}/lib/invitations.js`);
      var days = invLib.expiryDays($app);

      // Same instant the accept route refuses at: expired = now >= created + days.
      var cutoff = invLib.daysAgo(days);
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
      var eventCutoff = invLib.daysAgo(Math.max(1, days));
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

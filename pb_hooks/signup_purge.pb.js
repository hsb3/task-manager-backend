/// <reference path="../pb_data/types.d.ts" />

// ── Abandoned signups expire: an approved account that never confirmed its email ──

onBootstrap((e) => {
  e.next();

  cronAdd("unconfirmed-signup-purge", "0 5 * * *", () => {
    // Owner ruling on PBTT-208 (2026-08-12): auto-purge unconfirmed accounts after 30
    // days. Deliberately a literal, not an app_settings row — a retention value someone
    // can edit down to 0 deletes every pending signup in the next sweep.
    var UNCONFIRMED_RETENTION_DAYS = 30;
    try {
      // `approved = false` accounts are waiting on an ADMIN, not on their own inbox, and
      // are never swept (PBTT-208's two arms).
      var cutoff = new Date(Date.now() - UNCONFIRMED_RETENTION_DAYS * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);

      var recs = $app.findRecordsByFilter(
        "users",
        "approved = true && verified = false && created < {:cutoff}",
        "",
        0,
        0,
        { cutoff: cutoff },
      );
      var purged = 0;
      for (var i = 0; i < recs.length; i++) {
        try {
          // Programmatic delete: the onRecordDeleteRequest("users") sole-owner veto in
          // main.pb.js does NOT fire here, so a purge cannot be blocked by it; the
          // cascade's consequences ride the universal onRecordAfterDeleteSuccess hooks.
          $app.delete(recs[i]);
          purged++;
        } catch (_) {
          /* per-record: skip a row that won't delete */
        }
      }
      $app
        .logger()
        .info(
          "unconfirmed-signup-purge swept",
          "purged",
          purged,
          "retentionDays",
          UNCONFIRMED_RETENTION_DAYS,
        );
    } catch (err) {
      $app
        .logger()
        .error("unconfirmed-signup-purge failed", "error", String(err));
    }
  });
});

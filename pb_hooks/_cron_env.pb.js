/// <reference path="../pb_data/types.d.ts" />

// Refuse boot naming the cron ENV VARIABLE PocketBase cannot parse, not just the job id.
onBootstrap((e) => {
  // Load-bearing placement, not the filename: every cron site registers AFTER its own
  // e.next(), so below this line the check reverts to a panic naming only the job.
  var names = [
    "ALERT_CRON",
    "CYCLE_ROLLOVER_CRON",
    "DIGEST_CRON",
    "PB_BACKUPS_CRON",
    "TRASH_PURGE_CRON",
  ];
  for (var i = 0; i < names.length; i++) {
    var expr = $os.getenv(names[i]);
    // Empty means each hook falls back to its own shipped default — nothing to validate.
    if (!expr) continue;
    try {
      // PB's own parser is the validator; cronAdd's failure is an uncatchable Go panic.
      $app.cron().add("__cron_env_probe", expr, () => {});
    } catch (err) {
      throw new Error(
        names[i] + ' is not a valid schedule: "' + expr + '" — ' + err,
      );
    }
    $app.cron().remove("__cron_env_probe");
  }
  e.next();
});

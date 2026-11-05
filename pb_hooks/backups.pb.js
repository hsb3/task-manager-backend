/// <reference path="../pb_data/types.d.ts" />

// ── Boot hook: configure scheduled S3 backups from the environment ────────────
// PocketBase has a built-in backup engine (createBackup / restoreBackup +
// settings.backups: cron, cronMaxKeep, s3). Nothing in the repo configured it
// until module 19. We wire the WHOLE settings.backups block — the S3 destination
// AND the cron schedule — from env at boot, mirroring pb_hooks/mail.pb.js exactly:
// the same env-boot-hook shape that already owns the SMTP secret.
//
// Why the hook and not a settings migration (which CAN persist backups.s3 — it is
// normal settings, not the provider-stripped class): a migration is git, and the
// S3 secret must never touch git (CLAUDE.md). The boot hook reads the secret from
// a Railway variable at every boot, so it also re-applies a ROTATED key on the next
// deploy — a one-shot migration would bake the first-apply value.
//
// Deliberately env-DRIVEN and NO-OP when unset: local dev + the CI battery boot with
// no PB_BACKUPS_S3_* env, so the guard below returns early and leaves PocketBase's
// default local-filesystem backups (pb_data/backups) in place, no cron. Only when a
// bucket AND a secret are present do we flip settings.backups.s3 on. onBootstrap
// requires e.next() to complete core initialisation (DB + settings loaded); we call
// it first, THEN mutate settings so app.save has a live app to persist to.
onBootstrap((e) => {
  e.next();

  const bucket = $os.getenv("PB_BACKUPS_S3_BUCKET");
  const secret = $os.getenv("PB_BACKUPS_S3_SECRET");
  if (!bucket || !secret) {
    // Dev / CI / no-S3 path: leave local-filesystem backups untouched, no cron.
    // Never abort boot. (Both bucket AND secret are required — a half-set env is a
    // misconfiguration, so we no-op rather than dial S3 with a missing credential.)
    return;
  }

  const endpoint = $os.getenv("PB_BACKUPS_S3_ENDPOINT");
  const region = $os.getenv("PB_BACKUPS_S3_REGION");
  const accessKey = $os.getenv("PB_BACKUPS_S3_ACCESS_KEY");
  // cron + retention are env-overridable so the owner can retune from a Railway
  // variable without a rebuild (the m16 MAIL_SENDER_ADDRESS precedent). Defaults
  // encode the owner ruling: daily at 03:00 UTC (a low-traffic hour — createBackup
  // briefly blocks writes), keep the 30 most-recent cron backups (~30 days).
  const cron = $os.getenv("PB_BACKUPS_CRON") || "0 3 * * *";
  const cronMaxKeep = parseInt(
    $os.getenv("PB_BACKUPS_CRON_MAX_KEEP") || "30",
    10,
  );

  const settings = e.app.settings();

  // enabled:true routes EVERY backup op (list/create/restore) to S3 — pb_data/backups
  // is then ignored (proven this pass). forcePathStyle:true is the safe default for
  // MinIO and most non-AWS S3 (path-style URLs); AWS itself also accepts it.
  settings.backups.s3.enabled = true;
  settings.backups.s3.bucket = bucket;
  settings.backups.s3.region = region;
  settings.backups.s3.endpoint = endpoint;
  settings.backups.s3.accessKey = accessKey;
  settings.backups.s3.secret = secret;
  settings.backups.s3.forcePathStyle = true;

  settings.backups.cron = cron;
  settings.backups.cronMaxKeep = cronMaxKeep;

  // A misconfigured setting would (correctly) abort boot — every field above is
  // valid, so this succeeds. Log the source WITHOUT the secret value; length only.
  e.app.save(settings);
  e.app
    .logger()
    .info(
      "Backups configured from PB_BACKUPS_S3_*",
      "endpoint",
      endpoint,
      "bucket",
      bucket,
      "cron",
      cron,
      "cronMaxKeep",
      cronMaxKeep,
      "secretLength",
      secret.length,
    );
});

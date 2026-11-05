/// <reference path="../pb_data/types.d.ts" />

// ── Boot hook: configure S3 FILE storage (settings.s3) from the environment ───
// Same env-boot-hook shape as pb_hooks/backups.pb.js (its header carries the full
// why-a-boot-hook-and-not-a-migration reasoning: the S3 secret must never touch
// git, and an every-boot env read re-applies a rotated key on the next deploy).
// This one wires settings.s3 — the FILE-storage block, NOT settings.backups.s3 —
// and file storage has no cron. Env-driven and NO-OP when unset: dev + the CI
// battery boot with no PB_FILES_S3_* env and keep local-filesystem file storage.
onBootstrap((e) => {
  e.next();

  const bucket = $os.getenv("PB_FILES_S3_BUCKET");
  const secret = $os.getenv("PB_FILES_S3_SECRET");
  if (!bucket || !secret) {
    // Both bucket AND secret required — a half-set env is a misconfiguration, so
    // we no-op rather than dial S3 with a missing credential. Never abort boot.
    return;
  }

  const endpoint = $os.getenv("PB_FILES_S3_ENDPOINT");
  const region = $os.getenv("PB_FILES_S3_REGION");
  const accessKey = $os.getenv("PB_FILES_S3_ACCESS_KEY");

  const settings = e.app.settings();

  // forcePathStyle:true — Railway's S3 works path-style despite advertising
  // virtual-host style; also the safe default for MinIO and most non-AWS S3.
  settings.s3.enabled = true;
  settings.s3.bucket = bucket;
  settings.s3.region = region;
  settings.s3.endpoint = endpoint;
  settings.s3.accessKey = accessKey;
  settings.s3.secret = secret;
  settings.s3.forcePathStyle = true;

  // A misconfigured setting would (correctly) abort boot. Log WITHOUT the secret.
  e.app.save(settings);
  e.app
    .logger()
    .info(
      "File storage configured from PB_FILES_S3_*",
      "endpoint",
      endpoint,
      "bucket",
      bucket,
      "region",
      region,
      "secretLength",
      secret.length,
    );
});

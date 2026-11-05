---
name: s3-backup-bucket-ops
description: "How to operate the Railway backups bucket from curl — @-key signing gotcha, path-style, where creds live"
metadata: 
  node_type: memory
  type: project
  originSessionId: 581a5931-06e2-4d03-94b6-5b91a866d1e5
  modified: 2026-08-17T19:02:37.853Z
---

Operating the Railway backups bucket (endpoint t3.storageapi.dev):

- **Creds are not stored at rest anywhere local** (settled TASK-010, 2026-08-06). The old
  `.claude/operations/.bucket-creds-tmp.json` was deleted: a second at-rest copy of a live
  secret that nothing read. Fetch on demand —
  `railway bucket credentials --bucket pb-backups --json`. They are re-issuable, so a local
  copy buys nothing and costs a leak surface.
- **No credentials needed just to check the bucket is alive:**
  `railway bucket info --bucket pb-backups --json` returns object count + byte size. That is
  the cheapest backup-landed proof (watch the count increment across a cron run) and it does
  not touch a secret.
- `curl --user "$AK:$SK" --aws-sigv4 "aws:amz:auto:s3"` works for ListObjectsV2 and
  DELETE, **path-style**, despite the creds claiming `urlStyle: virtual-host`.
- **Gotcha:** PocketBase auto-backup keys start with `@` (`@auto_pb_backup_...zip`).
  DELETE with a literal `@` in the URL path → 403 `SignatureDoesNotMatch` (looks like
  a permissions error, isn't). Percent-encode it (`%40auto_...`) → 204. GET/list are
  unaffected.
- Bucket policy is ruled in decision-010: backups-only, never operational file storage.
  Since 2026-08-17 (PBTT-390) file uploads have their OWN bucket, `pb-files` (real S3 name
  `pb-files-zvho2lorp9pzwabv`), wired to `settings.s3` by `pb_hooks/files.pb.js` from
  `PB_FILES_S3_*` — same curl/CLI recipes apply to it.
- Prod backup cron is `PB_BACKUPS_CRON = 08 18 * * *` (daily 18:08 UTC), NOT the hook
  default 03:00 the m19 runbook once claimed — corrected in the ops runbook 2026-07-28.

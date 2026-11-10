# Production image: stock PocketBase binary + this repo's migrations and hooks.
FROM alpine:3.24

# The canonical PocketBase pin: scripts/check_pb_pin.ts holds every other PB_VERSION site to it.
ARG PB_VERSION=0.40.4
# tzdata: hooks count days in a viewer's IANA time zone, and pb_hooks/counts.pb.js refuses boot without it.
RUN apk add --no-cache ca-certificates tzdata unzip
ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb/ && rm /tmp/pb.zip

COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks

# EXPOSE is a build-time directive — it cannot read $PORT, so this stays a literal.
EXPOSE 8080

# Belt, not the gate — Railway routes on its own service healthcheckPath setting.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://localhost:${PORT:-8080}/api/health" >/dev/null 2>&1 || exit 1

# `superuser create`, NEVER `upsert`: upsert re-sets the password every boot, which
# rotates tokenKey and 401s every live superuser token (proven 200->401, #34). create
# leaves tokenKey untouched and exits 0 on the benign re-run "must be unique", which
# the grep drops. Mount a volume at /pb/pb_data or every deploy starts empty.
# PB 0.40.4 exits 1 on a refused migration, so the preflight refuses on that and never
# serves a half-migrated database. KEEP IN SYNC (below): scripts/pb_migrate.ts, same `--migrationsDir`.

# KEEP IN SYNC (below): scripts/replay_backup.sh, same `migrate up` and `--hooksDir`; its env -u list strips the S3 vars this preflight must keep.
# Before `superuser create`, which otherwise writes a superuser into a database that can
# never be served. --hooksDir matches serve's, so migrations apply in the same environment and a bad cron variable is refused here too.
CMD ["/bin/sh", "-c", "\
  MIGRATE_OUT=$(/pb/pocketbase migrate up --dir /pb/pb_data --migrationsDir /pb/pb_migrations --hooksDir /pb/pb_hooks 2>&1); MIGRATE_STATUS=$?; \
  echo \"$MIGRATE_OUT\"; \
  if [ \"$MIGRATE_STATUS\" -ne 0 ]; then \
    echo 'FATAL: PocketBase refused to start — the output above names the cause (a refused migration names the migration, an invalid cron schedule names its variable). Fix it, or redeploy the previous image.' >&2; \
    exit 1; \
  fi; \
  if [ -n \"$PB_SUPERUSER_EMAIL\" ] && [ -n \"$PB_SUPERUSER_PASSWORD\" ]; then \
    /pb/pocketbase superuser create \"$PB_SUPERUSER_EMAIL\" \"$PB_SUPERUSER_PASSWORD\" --dir /pb/pb_data --migrationsDir /pb/pb_migrations 2>&1 | grep -v 'must be unique' || true; \
  fi; \
  exec /pb/pocketbase serve --http=0.0.0.0:${PORT:-8080} --dir /pb/pb_data --migrationsDir /pb/pb_migrations --hooksDir /pb/pb_hooks --origins=${PB_CORS_ORIGINS:-*}"]

import { bucket, defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const pocketbaseVolume = volume("pocketbase-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 50000 });
  const pbBackups = bucket("pb-backups", { region: "iad" });
  const pbFiles = bucket("pb-files", { region: "iad" });
  const pocketbase = service("pocketbase", {
    source: github("hsb3/task-manager-backend", { checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["Dockerfile", "pb_migrations/**", "pb_hooks/**"] },
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    replicas: { "us-east4-eqdc4a": 1 },
    domains: ["admin.tasks-pocketbase.functionform.ai"],
    volumeMounts: {
      "/pb/pb_data": pocketbaseVolume,
    },
    env: {
      ALERT_EMAIL: preserve(),
      APP_ADMIN_EMAILS: preserve(),
      GITHUB_CLIENT_ID: preserve(),
      GITHUB_CLIENT_SECRET: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      MAIL_SENDER_ADDRESS: preserve(),
      PB_BACKUPS_CRON: preserve(),
      PB_BACKUPS_CRON_MAX_KEEP: preserve(),
      PB_BACKUPS_S3_ACCESS_KEY: preserve(),
      PB_BACKUPS_S3_BUCKET: preserve(),
      PB_BACKUPS_S3_ENDPOINT: preserve(),
      PB_BACKUPS_S3_REGION: preserve(),
      PB_BACKUPS_S3_SECRET: preserve(),
      PB_CORS_ORIGINS: preserve(),
      PB_FILES_S3_ACCESS_KEY: preserve(),
      PB_FILES_S3_BUCKET: preserve(),
      PB_FILES_S3_ENDPOINT: preserve(),
      PB_FILES_S3_REGION: preserve(),
      PB_FILES_S3_SECRET: preserve(),
      PB_PUBLIC_URL: preserve(),
      PB_SUPERUSER_EMAIL: preserve(),
      PB_SUPERUSER_PASSWORD: preserve(),
      RESEND_API_KEY: preserve(),
    },
  });

  return project("task-manager", {
    resources: [pocketbase, pocketbaseVolume, pbBackups, pbFiles],
  });
});

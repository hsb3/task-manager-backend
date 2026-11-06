/// <reference path="../pb_data/types.d.ts" />

// ── Prod ERROR-RATE alerting to the owner's inbox (module 20) ─────────────────
// The owner ruling was "email the owner on downtime." An in-process cron CANNOT
// detect full process-DOWN (a dead process sends no mail) — so "downtime" is
// reconciled to what PB primitives + the module-16 SMTP transport can RELIABLY
// deliver: an alert on ERROR CONDITIONS (the issue's literal Problem, "no alerting
// for prod errors"). Genuine full-process-down recovery is already covered by
// Railway's /api/health healthcheck (restart-on-fail, module 16); external uptime
// PAGING would need a third-party monitor (out of scope — don't invent infra).
//
// This mirrors pb_hooks/mail.pb.js / backups.pb.js: config comes from the
// environment, and the whole thing is a deliberate NO-OP when ALERT_EMAIL is unset —
// so local dev + the CI battery boot inert (register no cron, send no mail). It
// sends through the transport mail.pb.js configures from RESEND_API_KEY (a prod
// Railway variable); the Resend sandbox sender reaches only the account owner's own
// inbox until a domain is verified — and the owner IS the alert target, so that
// constraint guarantees delivery to the right inbox.
//
// PB JSVM CONSTRAINT (learned the hard way, module 20): a cron/router handler runs
// in an ISOLATED context and CANNOT close over module-scope variables — referencing
// one throws `ReferenceError`. So every handler below reads its config FRESH from
// $os.getenv and keeps cross-tick state in $app.store() (the app runtime KV store),
// never in an outer `let`. And `routerUse` only fires when registered at the file's
// TOP LEVEL (inside onBootstrap it registers too late to match any route).
//
// Env (all optional except ALERT_EMAIL):
//   ALERT_EMAIL         recipient; UNSET ⇒ the whole hook is a NO-OP (dev/CI/battery)
//   ALERT_CRON          cron expression for the error scan  (default "*/5 * * * *")
//   ALERT_WINDOW_MIN    trailing window scanned each tick, minutes (default 5)
//   ALERT_THRESHOLD     email when the error count in the window EXCEEDS this (default 5)
//   ALERT_COOLDOWN_MIN  min minutes between two alert emails (default = window)
//   ALERT_SELFTEST      truthy ⇒ the first request after boot sends ONE "alerts armed"
//                       email through the real transport (deterministic delivery proof:
//                       the battery suite + the session's prod V-ALERT-PROD both use it).
//                       Leave UNSET in steady-state prod.

// ── Self-test transport proof (top-level middleware; fires on the first request) ──
// Registered unconditionally but a NO-OP unless ALERT_SELFTEST is armed. The store
// key makes it fire exactly once per process. It runs AFTER re.next() so it never
// affects the response, and proves the SAME newMailClient() transport the real alert
// uses reaches ALERT_EMAIL — without waiting for a wall-clock cron minute.
require(`${__hooks}/lib/routes.js`).use((re) => {
  re.next();
  try {
    if (!$os.getenv("ALERT_SELFTEST")) {
      return;
    }
    const email = $os.getenv("ALERT_EMAIL");
    if (!email) {
      return;
    }
    if ($app.store().has("m20_alert_selftest_sent")) {
      return;
    }
    const settings = $app.settings();
    if (!settings.smtp.enabled) {
      // Transport not wired yet (or dev sandbox): nothing to prove, try again next req.
      return;
    }
    const msg = new MailerMessage({
      from: {
        address: settings.meta.senderAddress,
        name: settings.meta.senderName || "Task Tracker",
      },
      to: [{ address: email }],
      subject: "[Task Tracker] alerts armed",
      text:
        "The module-20 error-rate alert hook is armed and its mail transport is " +
        "reachable. This is a self-test message (ALERT_SELFTEST). Unset ALERT_SELFTEST " +
        "once delivery is confirmed.",
    });
    $app.newMailClient().send(msg);
    $app.store().set("m20_alert_selftest_sent", true);
    $app.logger().info("alerts self-test mail sent");
  } catch (err) {
    $app.logger().error("alerts self-test mail FAILED", "error", String(err));
  }
});

// ── The real alert: an error-rate scan on a cron ──────────────────────────────
onBootstrap((e) => {
  e.next();

  const alertEmail = $os.getenv("ALERT_EMAIL");
  if (!alertEmail) {
    // Dev / CI / battery path: register nothing, send nothing. Never abort boot.
    return;
  }

  const cronExpr = $os.getenv("ALERT_CRON") || "*/5 * * * *";

  cronAdd("alerts-error-rate", cronExpr, () => {
    // Everything the tick needs is read FRESH here — the JSVM does not close over
    // onBootstrap's scope. Any failure is logged and swallowed so a scan hiccup
    // never crashes the cron registry (which also runs the module-19 backups cron).
    try {
      const email = $os.getenv("ALERT_EMAIL");
      if (!email) {
        return;
      }
      const windowMin = parseInt($os.getenv("ALERT_WINDOW_MIN") || "5", 10);
      const threshold = parseInt($os.getenv("ALERT_THRESHOLD") || "5", 10);
      const cooldownMin = parseInt(
        $os.getenv("ALERT_COOLDOWN_MIN") || String(windowMin),
        10,
      );

      // Trailing window as an SQLite datetime string; _logs.created sorts lexically.
      const since = new Date(Date.now() - windowMin * 60 * 1000)
        .toISOString()
        .replace("T", " ");
      const sinceExp = $dbx.exp("[[created]] >= {:since}", { since: since });
      // Request-log rows (data.type == "request", e.g. PB's own 404 NotFoundError
      // for unmatched routes — bot/scanner noise) only count on a real 5xx status;
      // non-request rows (app-code logger().error() calls) count on ERROR level (8)
      // alone, since they carry no HTTP status. Without this split, PB's ERROR-level
      // logging of ordinary 404s crosses ALERT_THRESHOLD on scanner traffic alone.
      const errExp = $dbx.exp(
        "((json_extract([[data]], '$.type') = 'request' " +
          "AND json_extract([[data]], '$.status') >= 500) " +
          "OR (COALESCE(json_extract([[data]], '$.type'), '') != 'request' " +
          "AND [[level]] >= 8))",
      );

      const counter = new DynamicModel({ c: 0 });
      $app
        .logQuery()
        .select("count(*) as c")
        .andWhere(sinceExp)
        .andWhere(errExp)
        .one(counter);
      const total = counter.c;

      if (total <= threshold) {
        return;
      }

      // De-dup: don't re-page the same ongoing incident every tick.
      const now = Date.now();
      const lastRaw = $app.store().get("m20_alert_last_ts");
      const last = lastRaw ? parseInt(String(lastRaw), 10) : 0;
      if (last && now - last < cooldownMin * 60 * 1000) {
        $app
          .logger()
          .warn(
            "alerts: threshold breached but within cooldown",
            "count",
            total,
            "threshold",
            threshold,
          );
        return;
      }

      // A few sample paths for context — query strings STRIPPED (never email a URL
      // with its params), capped to 5; the recipient address is never logged.
      const samples = arrayOf(
        new DynamicModel({ status: 0, url: "", level: 0 }),
      );
      $app
        .logQuery()
        .select(
          "json_extract([[data]], '$.status') as status",
          "json_extract([[data]], '$.url') as url",
          "[[level]] as level",
        )
        .andWhere(sinceExp)
        .andWhere(errExp)
        .orderBy("[[created]] DESC")
        .limit(5)
        .all(samples);

      const lines = samples.map((r) => {
        const path = String(r.url || "").split("?")[0];
        return "  status=" + r.status + " level=" + r.level + " " + path;
      });

      const settings = $app.settings();
      const msg = new MailerMessage({
        from: {
          address: settings.meta.senderAddress,
          name: settings.meta.senderName || "Task Tracker",
        },
        to: [{ address: email }],
        subject:
          "[Task Tracker] " +
          total +
          " server errors in the last " +
          windowMin +
          "m",
        text:
          "The error-rate alert threshold was exceeded on the Task Tracker backend.\n\n" +
          "Errors (HTTP 5xx or ERROR-level) in the last " +
          windowMin +
          " minutes: " +
          total +
          " (threshold: " +
          threshold +
          ").\n\n" +
          "Recent sample paths (query strings removed):\n" +
          lines.join("\n") +
          "\n\n" +
          "Check the dashboard Logs (/_/#/logs) for detail. Retention is 5 days.",
      });
      $app.newMailClient().send(msg);
      $app.store().set("m20_alert_last_ts", String(now));
      $app
        .logger()
        .error(
          "alerts: error-rate alert SENT",
          "count",
          total,
          "threshold",
          threshold,
          "windowMin",
          windowMin,
        );
    } catch (err) {
      $app.logger().error("alerts: scan tick failed", "error", String(err));
    }
  });

  e.app.logger().info("alerts error-rate cron registered", "cron", cronExpr);
});

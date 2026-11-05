/// <reference path="../pb_data/types.d.ts" />

// ── Boot hook: configure Resend SMTP from the environment ────────────────────
// Migration 1785102300 brands the email *templates*, but PocketBase still needs
// a real SMTP transport to actually SEND them — the built-in sandbox mailer only
// logs. We wire that transport up at boot instead of hand-editing settings in the
// dashboard, so the same code path configures dev, CI, and Railway purely from an
// env var. The API key never lives in git or in a migration.
//
// Deliberately env-DRIVEN and NO-OP when unset: local dev boots with no
// RESEND_API_KEY, so the guard below returns early and leaves the sandbox mailer
// in place. Only when a key is present do we flip settings.smtp on. onBootstrap
// requires e.next() to complete core initialisation (DB + settings loaded); we
// call it first, THEN mutate settings so app.save has a live app to persist to.
onBootstrap((e) => {
  e.next();

  // appURL drives {APP_URL} in the verification/reset-password email templates
  // (see v1:pb_migrations/1785154700_users_web_auth_links.js) — it must point at
  // web/'s own domain, not PB's default, REGARDLESS of whether SMTP is
  // configured, so this sits before (and independent of) the RESEND guard
  // below. Local dev falls back to the Next dev server's own origin.
  const settings0 = e.app.settings();
  settings0.meta.appURL = $os.getenv("WEB_APP_URL") || "http://127.0.0.1:3000";
  e.app.save(settings0);

  const key = $os.getenv("RESEND_API_KEY");
  if (!key) {
    // Dev / no-SMTP path: leave the sandbox mailer untouched. Never abort boot.
    return;
  }

  const settings = e.app.settings();

  // Resend's SMTP bridge: fixed host, username literally "resend", the API key as
  // the password. Port 587 uses STARTTLS, so tls:false is correct here — PB sends
  // the STARTTLS command and upgrades the connection (tls:true would force
  // implicit TLS, which belongs on 465).
  settings.smtp.enabled = true;
  settings.smtp.host = "smtp.resend.com";
  settings.smtp.port = 587;
  settings.smtp.username = "resend";
  settings.smtp.password = key;
  settings.smtp.tls = false;

  // Brand the sender + app name so mail (and the {APP_NAME} placeholders elsewhere)
  // read as "Task Tracker" rather than the stock "Acme". The sender ADDRESS is
  // env-driven: it defaults to Resend's sandbox identity (onboarding@resend.dev),
  // which delivers only to the Resend account owner's own inbox until a domain is
  // verified. Once a domain is set up, point MAIL_SENDER_ADDRESS at it in Railway —
  // a variable change, not a code change (owner ruling, m16 OQ1).
  settings.meta.senderName = "Task Tracker";
  settings.meta.senderAddress =
    $os.getenv("MAIL_SENDER_ADDRESS") || "onboarding@resend.dev";
  settings.meta.appName = "Task Tracker";

  // A misconfigured setting would (correctly) abort boot — every field above is
  // valid, so this succeeds. Log the source WITHOUT the key value; length only.
  e.app.save(settings);
  e.app
    .logger()
    .info(
      "SMTP configured from RESEND_API_KEY",
      "host",
      "smtp.resend.com",
      "keyLength",
      key.length,
    );
});

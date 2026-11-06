/// <reference path="../pb_data/types.d.ts" />

// ── Boot hook: configure Resend SMTP from the environment ────────────────────
// The users collection brands the email *templates*, but PocketBase still needs
// a real SMTP transport to SEND them — with SMTP off PB execs the host's sendmail
// instead. We wire that transport up at boot instead of hand-editing settings in the
// dashboard, so the same code path configures dev, CI, and Railway purely from an
// env var. The API key never lives in git or in a migration.
//
// Deliberately env-DRIVEN and NO-OP when unset: local dev boots with no
// RESEND_API_KEY, so the guard below returns early and leaves SMTP off (PB's
// sendmail fallback). Only when a key is present do we flip settings.smtp on.
// onBootstrap requires e.next() to complete core initialisation (DB + settings loaded); we
// call it first, THEN mutate settings so app.save has a live app to persist to.
onBootstrap((e) => {
  e.next();

  // appURL drives {APP_URL} in the auth email templates, which link to PocketBase's own
  // confirmation pages, so it is this server's public URL whether or not SMTP is configured.
  const settings0 = e.app.settings();
  settings0.meta.appURL =
    $os.getenv("PB_PUBLIC_URL") || "http://127.0.0.1:8090";
  e.app.save(settings0);

  const key = $os.getenv("RESEND_API_KEY");
  if (!key) {
    // Dev / no-SMTP path: leave SMTP off. Never abort boot.
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

// ── Request hook: a public signup sends its own verification email ───────────
// Seeding/import (superuser) sends nothing; the send blocks the signup until SMTP answers.
onRecordCreateRequest((e) => {
  const send = !e.hasSuperuserAuth();
  e.next();
  if (!send || e.record.verified()) return;

  // With SMTP off PB falls back to the host's sendmail, which would deliver real mail.
  if (!e.app.settings().smtp.enabled) {
    e.app
      .logger()
      .warn(
        "signup verification email skipped: SMTP disabled",
        "user",
        e.record.id,
      );
    return;
  }
  try {
    $mails.sendRecordVerification(e.app, e.record);
  } catch (err) {
    // The user is already committed; request-verification remains the retry path.
    e.app
      .logger()
      .error(
        "signup verification email failed",
        "user",
        e.record.id,
        "err",
        String(err).split(e.record.getString("email")).join("[address]"),
      );
  }
}, "users");

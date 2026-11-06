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

  // Per-boot secret that lets only this server call the signup-mail route below.
  e.app.store().set("signupMailSecret", $security.randomString(40));

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
// Seeding/import (superuser) sends nothing. decision:signup-mail-off-request: the send runs in a
// loopback request that answers at once, because a JSVM hook cannot send in the background.
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
  // KEEP IN SYNC: pb_hooks/lib/invitations.js `--http=` — this server's own listener, from serve's --http flag (PocketBase default 127.0.0.1:8090).
  let addr = "127.0.0.1:8090";
  const args = $os.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--http" && i + 1 < args.length) addr = args[i + 1];
    else if (args[i].indexOf("--http=") === 0) addr = args[i].slice(7);
  }
  addr = addr
    .replace(/^(0\.0\.0\.0)?:/, "127.0.0.1:")
    .replace(/^\[::\]:/, "[::1]:");
  let failure = "";
  try {
    const res = $http.send({
      url: `http://${addr}/internal/signup-verification/${e.record.id}`,
      method: "POST",
      headers: { "X-Signup-Mail": e.app.store().get("signupMailSecret") },
      timeout: 1,
    });
    if (res.statusCode !== 204) failure = `loopback answered ${res.statusCode}`;
  } catch (err) {
    failure = String(err);
  }
  if (failure) {
    // The user is already committed; request-verification remains the retry path.
    e.app
      .logger()
      .error(
        "signup verification email failed",
        "user",
        e.record.id,
        "err",
        failure.split(e.record.getString("email")).join("[address]"),
      );
  }
}, "users");

// Answers 204 before sending, so the signup that called it never waits on SMTP. Outside /api/,
// so no rate limit rule applies to it and a client forging the server address cannot spend it.
require(`${__hooks}/lib/routes.js`).add(
  "POST /internal/signup-verification/{id}",
  (e) => {
    const secret = e.app.store().get("signupMailSecret");
    if (
      !secret ||
      !$security.equal(e.request.header.get("X-Signup-Mail"), secret)
    ) {
      throw new NotFoundError();
    }
    // Close: the caller would otherwise reuse this connection while the send still holds it.
    e.response.header().set("Connection", "close");
    e.response.writeHeader(204);
    e.flush();

    // A batch signup commits only after its hook returns, so wait for the row.
    const id = e.request.pathValue("id");
    let user = null;
    for (let i = 0; i < 50 && !user; i++) {
      try {
        user = e.app.findRecordById("users", id);
      } catch (_) {
        sleep(100);
      }
    }
    if (!user || user.verified()) return;
    try {
      $mails.sendRecordVerification(e.app, user);
    } catch (err) {
      e.app
        .logger()
        .error(
          "signup verification email failed",
          "user",
          user.id,
          "err",
          String(err).split(user.getString("email")).join("[address]"),
        );
    }
  },
);

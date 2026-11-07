/// <reference path="../pb_data/types.d.ts" />

// Boot hook: the SOLE OWNER of the users collection's oauth2 config, built from
// `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET` env pairs (GitHub, Google) on every boot
// (decision:oauth-providers-from-env).
// A hook, not a migration: a collection migration drops clientId + clientSecret and keeps only
// `oauth2.enabled` (measured), and secrets never ride git or a migration file anyway.
// e.next() FIRST: core init (DB + settings) must be complete before the collection is saved.
onBootstrap((e) => {
  e.next();

  const providers = [];
  for (const name of ["github", "google"]) {
    const prefix = name.toUpperCase();
    const clientId = $os.getenv(prefix + "_CLIENT_ID");
    const clientSecret = $os.getenv(prefix + "_CLIENT_SECRET");
    // $os.getenv is "" when unset; a half pair could fail validation, so it counts as unset.
    if (!clientId || !clientSecret) {
      e.app
        .logger()
        .info(
          "no " + prefix + "_CLIENT_ID/SECRET; " + name + " sign-in stays off",
        );
      continue;
    }
    providers.push({
      name: name,
      clientId: clientId,
      clientSecret: clientSecret,
    });
  }
  const col = e.app.findCollectionByNameOrId("users");

  // Saved even when empty: pb_data persists across deploys, so a pair removed from the env must
  // turn its stored provider off, not merely log. unmarshal() merges in place (the migrations'
  // primitive); only oauth2 is touched, mappedFields keeps its stock name + avatar mapping.
  unmarshal(
    { oauth2: { enabled: providers.length > 0, providers: providers } },
    col,
  );

  // A genuinely invalid oauth2 config aborts boot here — the intended fail-fast for a
  // broken prod secret. Log the SOURCE without the secret: clientId length only.
  e.app.save(col);
  for (const p of providers) {
    e.app
      .logger()
      .info(
        p.name + " provider configured from env",
        "clientIdLength",
        p.clientId.length,
      );
  }
});

// Request hook: an existing provider link or the signed-in account decides the account; only when core matched
// nothing does a provider-verified email that folds onto an existing account reach THAT account. Core's own
// transaction verifies and links, first resetting an unverified account's password and other links (decision:oauth-providers-from-env).
onRecordAuthWithOAuth2Request((e) => {
  // decision:user-settings-write-checks: a provider name the person never typed is stored trimmed, a blank one empty, never refused.
  if (e.oAuth2User && typeof e.oAuth2User.name === "string")
    e.oAuth2User.name = e.oAuth2User.name.trim();
  // NO-OP guard: without a verified email we have no safe basis to link or to
  // mark verified. Hand off to the core engine untouched.
  if (!e.oAuth2User || !e.oAuth2User.email) {
    return e.next();
  }

  // Look for an existing users record with this verified email. A provider returns whatever
  // casing (and Gmail dots/+tag) the person typed, so an `email = {:email}` filter would miss
  // the account and the core would mint a duplicate — the provider address is folded to the
  // same email_key the account carries and matched on THAT. As on the password login path, a
  // MULTI-row match links to nobody: picking one there is account takeover.
  //
  // ── INLINED FOLD — KEEP IN SYNC with pb_hooks/auth_identity.pb.js's `.split("+")[0].split(".").join("")` (create + update
  // copies); the pooled JSVM cannot share a
  // top-level helper. Owner ruling 2026-08-31: trim + lowercase always; gmail.com and
  // googlemail.com ONLY lose the local part's dots and its first '+' onwards.
  const canonical = String(e.oAuth2User.email).trim().toLowerCase();
  let key = canonical;
  const at = canonical.lastIndexOf("@");
  if (at !== -1) {
    const domain = canonical.slice(at + 1);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      key =
        canonical.slice(0, at).split("+")[0].split(".").join("") + "@" + domain;
    }
  }
  // ── END INLINED FOLD ──

  let existing = null;
  const q = e.app.db().newQuery("SELECT id FROM users WHERE email_key = {:k}");
  q.bind({ k: key });
  const rows = arrayOf(new DynamicModel({ id: "" }));
  q.all(rows);
  if (rows.length === 1) {
    try {
      existing = e.app.findRecordById("users", rows[0].id);
    } catch (_) {
      existing = null;
    }
  }

  // Core's own match (a provider link, the signed-in account, the exact email) stands; the fold only fills its gap.
  if (existing && !e.record) e.record = existing;
  // Core verifies only on an exact email match (v0.40.4 apis/record_auth_with_oauth2.go:326,374); a fold match is the same mailbox.
  e.oAuth2User.email =
    e.record && e.record.getString("email_key") === key
      ? e.record.email()
      : canonical;

  try {
    return e.next();
  } catch (x) {
    const w = x.value || x;
    // Core wraps any non-API failure of its sign-in transaction as this 400 (v0.40.4 apis/record_auth_with_oauth2.go:156).
    const v =
      w &&
      w.message === "Failed to authenticate." &&
      typeof w.rawData === "function"
        ? w.rawData()
        : null;
    // KEEP IN SYNC: membership_status.pb.js `typeof v.marshalJSON === "function"` — a refusal (status) or field validation error keeps its own answer.
    if (v && !(v.status || typeof v.marshalJSON === "function")) {
      e.app
        .logger()
        .error(
          "oauth sign-in failed",
          "error",
          String(x),
          "cause",
          typeof v.error === "function" ? v.error() : String(v),
        );
      throw new InternalServerError("The sign-in could not be completed.");
    }
    throw x;
  }
}, "users");

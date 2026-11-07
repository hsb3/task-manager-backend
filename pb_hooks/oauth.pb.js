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

// ── Request hook: enforce verified + auto-link on OAuth login (Ruling 4) ─────
// Fires after the OAuth2 token exchange and BEFORE PocketBase links the external
// account to a users record. We use it to make two guarantees, both keyed on the
// fact that e.oAuth2User.email is documented as the VERIFIED email — a provider (GitHub, Google)
// fills it only when it has confirmed the user owns that address, and leaves it EMPTY
// otherwise. That single invariant is what makes both behaviours below safe.
//
//   (a) FIRST-TIME SIGNUP → verified=true. Our users authRule requires
//       verified=true, so a brand-new OAuth account created with verified=false
//       would be immediately bricked (403 on its own token). Because the provider has
//       already verified the email, we can safely mark the new record verified so
//       the account works on first login instead of being locked out.
//
//   (b) ACCOUNT LINKING = auto-link by verified email. If the verified email folds
//       (PBTT-529) onto an EXISTING users record, we point the auth at THAT record rather
//       than letting a second, duplicate account be created. This is safe ONLY
//       because the email is provider-verified: an attacker cannot claim someone
//       else's address without the provider confirming ownership, and if ownership
//       can't be confirmed the email is empty and we do nothing.
//
// DEFENSIVE + IDEMPOTENT BY DESIGN. PocketBase's own engine may already do some
// of this in a given version; this hook is written so that if the core already
// linked or already verified, we cause no harm (re-setting verified=true when it
// is already true is a no-op; re-pointing at the same record changes nothing).
// If the provider could not verify the email we bail out and let the core engine
// decide — we never invent a link or a verification on unverified input.
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

  if (existing) {
    // (b) LINK: an account with this verified email already exists. Assigning
    // e.record BEFORE e.next() makes the core linking attach the provider identity
    // to this record instead of minting a duplicate. Setting e.record to the same
    // record the engine already chose is harmless (idempotent).
    e.record = existing;
    // (a) also applies to the linked record: guarantee it satisfies the authRule.
    e.record.set("verified", true);
  }

  // (a) FIRST-TIME SIGNUP: the record does not exist before e.next(), and the create form drops
  // `verified` from createData (a system field), so the brand-new record is verified AFTER the
  // core saved it — including when the auth response itself was refused (the approval gate 403),
  // since the account persists and must not be locked out on its first approved login.
  let err = null;
  try {
    e.next();
  } catch (x) {
    err = x;
  }
  if (!existing && e.record && !e.record.getBool("verified")) {
    e.record.set("verified", true);
    try {
      e.app.save(e.record);
    } catch (x) {
      // KEEP IN SYNC: membership_status.pb.js `typeof v.marshalJSON === "function"` — a refusal (status) or field validation error keeps its own answer.
      const v = x.value || x;
      if (!(v && (v.status || typeof v.marshalJSON === "function"))) {
        // The save failure wins over whatever e.next() threw, because that error would hide it.
        e.app.logger().error("oauth verified save failed", "error", String(x));
        throw new InternalServerError("The sign-in could not be completed.");
      }
      throw x;
    }
  }
  if (err) throw err;
}, "users");

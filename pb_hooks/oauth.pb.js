/// <reference path="../pb_data/types.d.ts" />

// ── Boot hook: configure the GitHub OAuth2 provider from the environment ──────
// WHY A HOOK AND NOT A MIGRATION? We tried the migration route first and hit a
// hard PocketBase limitation worth remembering: a collection MIGRATION cannot
// carry an oauth2 provider's credentials — on that path PocketBase strips the
// per-provider secret material (clientId + clientSecret) and persists only
// `oauth2.enabled`, so a migration can flip oauth2 ON but can never say WHO the
// provider is. The superuser HTTP API is different: a PATCH of the users
// collection DOES persist clientId/clientSecret (measured — test_oauth's fake
// provider relies on it). The GitHub app identity still applies at runtime here.
//
// That makes this boot hook the SOLE OWNER of the whole oauth2 config: it reads
// the GitHub app credentials from the environment and writes the full provider
// entry onto the live users collection every boot. Credentials stay in env
// (Railway variables / local .env) and never touch git or a migration file —
// only the env-var NAMES appear below.
//
// DELIBERATELY ENV-DRIVEN AND NO-OP WHEN UNSET: local dev and CI boot with no
// GitHub credentials, so the guard below returns early and leaves oauth2 at its
// stock disabled default. GitHub login only lights up where both variables are
// present (prod). onBootstrap must call e.next() FIRST so core init (DB +
// settings loaded) is complete before we look the collection up and save it —
// and it must NEVER abort boot on the dev path.
onBootstrap((e) => {
  e.next();

  const clientId = $os.getenv("GITHUB_CLIENT_ID");
  const clientSecret = $os.getenv("GITHUB_CLIENT_SECRET");

  // Both halves required. $os.getenv returns "" when a variable is unset, so an
  // empty string on EITHER side means "not configured" — stay disabled, don't
  // abort. A half-configured provider (id without secret) would be useless and
  // could fail validation, so we treat it the same as fully unset.
  if (!clientId || !clientSecret) {
    e.app.logger().info("no GITHUB_CLIENT_ID/SECRET; oauth2 stays disabled");
    return;
  }

  const col = e.app.findCollectionByNameOrId("users");

  // unmarshal() merges this object onto the collection model in place — the same
  // primitive the migrations use. We only touch oauth2 here; mappedFields is left
  // at its stock default, which already maps GitHub's name + avatar onto the
  // users record, so there is nothing to add there. `name` picks the provider
  // implementation ("github"); clientId + clientSecret are the GitHub OAuth app's
  // credentials, supplied purely from env.
  unmarshal(
    {
      oauth2: {
        enabled: true,
        providers: [
          {
            name: "github",
            clientId: clientId,
            clientSecret: clientSecret,
          },
        ],
      },
    },
    col,
  );

  // A genuinely invalid oauth2 config would (correctly) abort boot here — that is
  // the intended fail-fast for a broken prod secret. Log the SOURCE without ever
  // emitting the secret: clientId length only, never its value, and never the
  // secret at all.
  e.app.save(col);
  e.app
    .logger()
    .info(
      "github provider configured from env",
      "clientIdLength",
      clientId.length,
    );
});

// ── Request hook: enforce verified + auto-link on GitHub login (Ruling 4) ─────
// Fires after the OAuth2 token exchange and BEFORE PocketBase links the external
// account to a users record. We use it to make two guarantees, both keyed on the
// fact that e.oAuth2User.email is documented as the VERIFIED email — GitHub only
// fills it when it has confirmed the user owns that address, and leaves it EMPTY
// otherwise. That single invariant is what makes both behaviours below safe.
//
//   (a) FIRST-TIME SIGNUP → verified=true. Our users authRule requires
//       verified=true, so a brand-new GitHub account created with verified=false
//       would be immediately bricked (403 on its own token). Because GitHub has
//       already verified the email, we can safely mark the new record verified so
//       the account works on first login instead of being locked out.
//
//   (b) ACCOUNT LINKING = auto-link by verified email. If the verified email folds
//       (PBTT-529) onto an EXISTING users record, we point the auth at THAT record rather
//       than letting a second, duplicate account be created. This is safe ONLY
//       because the email is provider-verified: an attacker cannot claim someone
//       else's address without GitHub confirming ownership, and if ownership
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
    // e.record BEFORE e.next() makes the core linking attach the GitHub identity
    // to this record instead of minting a duplicate. Setting e.record to the same
    // record the engine already chose is harmless (idempotent).
    e.record = existing;
    // (a) also applies to the linked record: guarantee it satisfies the authRule.
    e.record.set("verified", true);
  } else {
    // (a) FIRST-TIME SIGNUP: mark the brand-new record verified so the authRule
    // (verified=true) doesn't lock the account out on its very first token.
    if (e.record) {
      e.record.set("verified", true);
    }
    // Defensive mirror: on a new-record flow PocketBase builds the record from
    // e.createData. Setting it there too means verified survives regardless of
    // which object the core ultimately persists from.
    if (e.createData) {
      e.createData.verified = true;
    }
  }

  return e.next();
}, "users");

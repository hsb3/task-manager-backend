/// <reference path="../pb_data/types.d.ts" />

// ── Login identity is case-insensitive: PB resolves it with SQLite BINARY `email = ?` ──

onRecordAuthWithPasswordRequest((e) => {
  // PB's own exact-case match always wins; only a miss is retried here.
  if (e.record) return e.next();

  const identity = (typeof e.identity === "string" ? e.identity : "")
    .trim()
    .toLowerCase();
  if (!identity) return e.next();

  // `~` is a substring LIKE and would over-match, so both sides are lowered instead.
  // Deliberately no `LIMIT 1`: emails are unique only under BINARY collation, so
  // case-duplicate accounts exist and picking one on an auth path is account takeover —
  // an ambiguous identity must resolve to nobody and get PB's own 400.
  const q = e.app
    .db()
    .newQuery("SELECT id FROM users WHERE LOWER(email) = {:e}");
  q.bind({ e: identity });
  const rows = arrayOf(new DynamicModel({ id: "" }));
  q.all(rows);
  if (rows.length === 1) {
    try {
      e.record = e.app.findRecordById("users", rows[0].id);
    } catch (_) {
      // Deleted between the two reads — leave the miss rather than 500 a public endpoint.
    }
  }

  return e.next();
}, "users");

// ── One address is one account: `email` is stored lowercased, `email_key` is the fold ──

// The CANONICALIZE body below is INLINED IDENTICALLY in the create and update hooks — the
// pooled JSVM cannot call a top-level helper from a registered callback. KEEP THE TWO BLOCKS
// IN SYNC, and with the other copy of the same fold: pb_hooks/oauth.pb.js's linking lookup
// (mirrored offline in scripts/utilities/email_collision_audit.ts's email_key(), drift-checked
// by scripts/check_email_fold.ts against the oauth.pb.js copy).
//
// THE FOLD (owner ruling 2026-08-31, PBTT-529): trim + lowercase always; for gmail.com and
// googlemail.com ONLY, drop every '.' from the local part and everything from the first '+'
// up to the '@'. Every other domain keeps dots and +tags significant, and the two Gmail
// domains are DISTINCT — an address at one never folds into the other. `email` keeps the
// address as typed (minus case/padding) because that is what the person's provider shows and
// what mail is sent to; only `email_key` is folded, and only it is compared.
//
// Both hooks are universal (not *Request): public signup, a superuser write, scripts/seed.ts,
// the OAuth engine and the confirm-email-change flow all have to reach the same key, and they
// run BEFORE persistence so the unique index on email_key is the backstop under a race.

onRecordCreate((e) => {
  // ── INLINED CANONICALIZE (create copy) — KEEP IN SYNC with the update copy ──
  const raw = String(e.record.getString("email") || "");
  const canonical = raw.trim().toLowerCase();
  let key = canonical;
  const at = canonical.lastIndexOf("@");
  if (at !== -1) {
    const domain = canonical.slice(at + 1);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      key =
        canonical.slice(0, at).split("+")[0].split(".").join("") + "@" + domain;
    }
  }
  if (canonical !== raw) e.record.set("email", canonical);
  if (key !== String(e.record.getString("email_key") || "")) {
    e.record.set("email_key", key);
  }
  if (key) {
    // The unique index refuses this too, but as a bare validation error; the scan is what
    // turns a fold collision into the verbatim message below that a client can show.
    const q = e.app
      .db()
      .newQuery("SELECT id FROM users WHERE email_key = {:k} AND id != {:id}");
    q.bind({ k: key, id: e.record.id });
    const rows = arrayOf(new DynamicModel({ id: "" }));
    q.all(rows);
    if (rows.length) {
      throw new BadRequestError(
        "An account with this email address already exists.",
      );
    }
  }
  // ── END INLINED CANONICALIZE (create copy) ──
  return e.next();
}, "users");

onRecordUpdate((e) => {
  // request-email-change is what the scan below exists for; every other user save (a
  // verified/approved flip, provisioning, a rename) leaves identity untouched and skips it.
  // The stored key is what this reads, never the submitted one: PB drops a hidden field from
  // a normal caller's body but LOADS it for a superuser, and a key that no longer derives
  // from the email would make the unique index guard nothing. An EMPTY stored key is a row
  // the backfill never reached, so that one falls through and is repaired.
  const storedKey = String(e.record.original().getString("email_key") || "");
  if (
    String(e.record.getString("email") || "") ===
      String(e.record.original().getString("email") || "") &&
    String(e.record.getString("email_key") || "") === storedKey &&
    storedKey
  ) {
    return e.next();
  }
  // ── INLINED CANONICALIZE (update copy) — KEEP IN SYNC with the create copy ──
  const raw = String(e.record.getString("email") || "");
  const canonical = raw.trim().toLowerCase();
  let key = canonical;
  const at = canonical.lastIndexOf("@");
  if (at !== -1) {
    const domain = canonical.slice(at + 1);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      key =
        canonical.slice(0, at).split("+")[0].split(".").join("") + "@" + domain;
    }
  }
  if (canonical !== raw) e.record.set("email", canonical);
  if (key !== String(e.record.getString("email_key") || "")) {
    e.record.set("email_key", key);
  }
  if (key) {
    // The unique index refuses this too, but as a bare validation error; the scan is what
    // turns a fold collision into the verbatim message below that a client can show.
    const q = e.app
      .db()
      .newQuery("SELECT id FROM users WHERE email_key = {:k} AND id != {:id}");
    q.bind({ k: key, id: e.record.id });
    const rows = arrayOf(new DynamicModel({ id: "" }));
    q.all(rows);
    if (rows.length) {
      throw new BadRequestError(
        "An account with this email address already exists.",
      );
    }
  }
  // ── END INLINED CANONICALIZE (update copy) ──
  return e.next();
}, "users");

// ── Password signup is verify-first: no password exists before the mailbox owner sets one (decision:password-signup-verify-first) ──

onRecordCreateRequest((e) => {
  const info = e.requestInfo();
  // A provider signup's createData may carry a password and override the email, so it never keeps one.
  if (info.context === "oauth2") {
    e.record.setRandomPassword();
    return e.next();
  }
  // A superuser create keeps what it submitted (seed/import).
  if (!e.hasSuperuserAuth()) {
    const body = info.body || {};
    if (body.password !== undefined || body.passwordConfirm !== undefined) {
      const msg =
        "Signup takes no password: the signup mail links to setting one.";
      throw new BadRequestError(msg, {
        password: new ValidationError("validation_signup_password", msg),
      });
    }
    e.record.setRandomPassword();
  }
  return e.next();
}, "users");

// Core keeps the password on verify while password login is on; drop one set before the mailbox owner acted, as core does when it is off.
onRecordConfirmVerificationRequest((e) => {
  if (!e.record.verified()) e.record.setRandomPassword();
  return e.next();
}, "users");

// A superuser marking an account verified drops a password set before it, unless the same request sets one.
onRecordUpdateRequest((e) => {
  const body = e.requestInfo().body || {};
  if (
    e.record.verified() &&
    !e.record.original().verified() &&
    body.password === undefined
  ) {
    e.record.setRandomPassword();
  }
  return e.next();
}, "users");

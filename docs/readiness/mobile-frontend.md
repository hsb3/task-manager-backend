---
title: Readiness for a mobile frontend
status: current
version: 1
updated: 2026-11-10
---

# Readiness: mobile frontend

**Target.** An outside team can design, build and ship a native iOS or Android app for this
tracker without the backend authors in the room. This page lists only what a native app adds
to [`web-frontend.md`](web-frontend.md): installed versions that lag the server, intermittent
connectivity, push delivery, and the store rules each app must pass.

**Shared criteria.** SH-1 to SH-10 apply (see [`README.md`](README.md#shared-criteria)); SH-6
also covers phones sharing a carrier NAT address. **Web criteria.** WEB-1 to WEB-10 apply.

## Criteria

**MOB-1** A device can register for push delivery, and each notification event reaches the
devices of its recipient.
- Verdict: missing.
- Evidence: `grep -rniE 'apns|fcm|device_token' schema pb_hooks` prints nothing; notifications are
  rows (`schema/notifications.json`) plus a mail digest (`pb_hooks/notify.pb.js` `DIGEST_CRON`).
- Gap: no device registration; no push delivery path.

**MOB-2** A user can choose, per channel, which notifications reach them.
- Verdict: missing.
- Evidence: `schema/user_settings.json` fields are `theme`, `font`, `font_size`,
  `default_view`, `default_project`, `time_zone`; the digest has no opt-out.
- Gap: no per-user channel preference.

**MOB-3** Every third-party sign-in the server offers is accompanied by a sign-in meeting App
Store Review Guideline 4.8 (Login Services).
- Verdict: missing.
- Evidence: `pb_hooks/oauth.pb.js` loops over `["github", "google"]` only
  (decision:oauth-providers-from-env). Guideline 4.8 asks an app that uses a third-party login
  for the primary account to also offer an equivalent login that limits collection to name and
  email, lets the user keep their email private, and collects no interactions for advertising
  without consent; the guideline lists exceptions ("App Review Guidelines",
  https://developer.apple.com/app-store/review/guidelines/).
- Gap: no sign-in on the server meets those conditions.

**MOB-4** A signed-in user can delete their account and its associated data from inside the
app.
- Verdict: partly.
- Evidence: `schema/users.rules.json` `deleteRule: "id = @request.auth.id"`;
  `tests/test_account_deletion.ts`; decision:account-delete-sole-owner. Content written in
  other people's workspaces survives with its author emptied (optional `users` relations
  without cascade, e.g. `schema/comments.json` field `author`, `cascadeDelete: false`). Apple
  Guideline 5.1.1(v) (same page) requires in-app deletion; Google Play covers the account and
  associated data ("Understanding Google Play's app account deletion requirements",
  https://support.google.com/googleplay/android-developer/answer/13327111).
- Gap: no statement of what a deletion removes and what it retains.

**MOB-5** A person can request deletion of their account and its data from a web page without
the app installed, as Google Play requires.
- Verdict: missing.
- Evidence: deletion is only the API call of MOB-4; the server serves no web pages (`Dockerfile`
  copies only `pb_migrations` and `pb_hooks`).
- Gap: no web deletion resource.

**MOB-6** A link in an account mail can open the installed app.
- Verdict: missing.
- Evidence: mail links target the PocketBase dashboard (WEB-2); no app-link association file is
  served (`grep -rniE 'apple-app-site-association|assetlinks' pb_hooks pb_migrations Dockerfile`
  prints nothing).
- Gap: no mail link resolves to the app.

**MOB-7** A client built against a newer contract can tell which contract the server speaks
before it writes.
- Verdict: missing.
- Evidence: record writes refuse an unknown key with 400 "Unknown field: ..."
  (`pb_hooks/lib/unknown_keys.js`, `tests/test_unknown_keys.ts`), so a field sent early fails
  the whole write; custom routes ignore unknown keys (room probe:
  `POST /api/tracker/notifications/read-all` with `{"bogus":1}` answered 200).
- Gap: as SH-5.

**MOB-8** The server can tell an installed app that lags the contract that it must upgrade
before a breaking change reaches it.
- Verdict: missing.
- Evidence: `grep -rniE 'min.?(client|app).?version|upgrade required' pb_hooks pb_migrations`
  prints nothing; no version signal exists (SH-5).
- Gap: no upgrade signal to a lagging client.

**MOB-9** A client can fetch everything changed since a point in time, deletions included.
- Verdict: partly.
- Evidence: room probe: an `updated` filter and `sort=-updated` work on `tasks`, `project_items`,
  `comments`, `notifications`. A trashed item arrives on realtime as an update with `trashed`
  set (`tests/test_realtime.ts` "TRASH-SET"); after the purging second DELETE
  (decision:soft-delete-trash) the probe found no trash row, view or `task_activity` row.
  `grep -i 'CREATE.*INDEX.*updated' schema/*.json` prints nothing.
- Gap: no record of purged rows visible to sync; no index on `updated`.

**MOB-10** The realtime contract states how a client reconnects and catches up on what it
missed.
- Verdict: missing.
- Evidence: `grep -rlnE 'reconnect|PB_CONNECT' --exclude-dir=readiness docs README.md clients
  pb_hooks openapi.json` prints nothing.
- Gap: no reconnect or catch-up statement.

**MOB-11** A retried write after a lost response can neither duplicate the record nor be
mistaken for a failure.
- Verdict: partly.
- Evidence: room probe: a client-supplied 15-character `id` is accepted; repeating the create
  answers 400 `validation_not_unique`, not the existing record; an `Idempotency-Key` sent twice
  produced two records.
- Gap: no idempotent answer to a retried write, on records or custom routes.

**MOB-12** An edit made against stale data is refused rather than silently overwriting a
newer change, on every collection a user edits.
- Verdict: partly.
- Evidence: `pb_hooks/precondition.pb.js` checks a submitted `expected_updated_at` only when
  `e.collection.name === "templates" || e.collection.name === "saved_views"`, answering 409
  "Someone else changed this since you opened it."; timestamps compare to the millisecond;
  `If-Match` is ignored (room probe).
- Gap: no stale-write check on tasks, comments or the other edited collections.

**MOB-13** Every response a client can request is bounded in size.
- Verdict: partly.
- Evidence: `pb_hooks/item_list.pb.js` and stock lists cap a page (WEB-9); the trash route
  defaults its page to its cap (`pb_hooks/routes.pb.js` `q.get("perPage") || "500"`);
  `POST /api/tracker/export` narrows by optional `projects` and `collections` but returns its
  whole selection in one unpaged body (`pb_hooks/routes.pb.js`).
- Gap: no paging on export.

**MOB-14** Photo uploads accept the camera formats both platforms produce by default.
- Verdict: missing.
- Evidence: `schema/tasks.json` `attachments.mimeTypes` lists JPEG, PNG, GIF, WebP, SVG and
  PDF; room probe: a HEIC upload answered 400 `validation_invalid_mime_type`.
- Gap: HEIC is not accepted.

**MOB-15** Refusal messages shown to users name no browser-only remedy.
- Verdict: partly.
- Evidence: the refusal of an unusable `expected_updated_at`, or of one sent to an unguarded
  collection, reads "This change could not be saved. Reload the page and try again."
  (`pb_hooks/precondition.pb.js`, `pb_hooks/trash.pb.js`).
- Gap: those refusals name a browser-only remedy.

## Unverified

- Native OAuth redirect: `openapi.json` publishes `POST /api/collections/users/auth-with-oauth2`
  and `tests/test_oauth.ts` calls it with `code`, `codeVerifier` and `redirectURL` (a code
  exchange). Whether a custom-scheme `redirectURL` is accepted end to end, including by each
  provider's app registration, is not tested.
- Whether App Review would accept the server's own email sign-in as the 4.8-equivalent login
  for an iOS app: a review judgement, not testable here.
- How the deployed proxy sets `X-Real-IP` (SH-6 rests on a room).
- Realtime events for stock collections on soft-trash, and comment deletion semantics.

## Out of scope

- A cross-workspace export of one account's data (no store rule cited here requires it).
- Store listing, privacy labels and app-side storage.

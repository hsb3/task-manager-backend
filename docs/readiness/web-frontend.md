---
title: Readiness for a web frontend
status: current
version: 1
updated: 2026-11-10
---

# Readiness: web frontend

**Target.** An outside team, engaged to design and build a web app for this tracker, can do
the whole job from what the repository and a running server give them, without the backend
authors in the room: they learn what the product is, how every flow behaves, what each call
returns and how it fails, and they can run their app against a server that behaves like
production.

**Shared criteria.** SH-1 to SH-10 apply (see [`README.md`](README.md#shared-criteria)).

## Criteria

**WEB-1** A product definition written for designers states the user journeys, notification
behaviour and a glossary of the product's terms.
- Verdict: partly.
- Evidence: the role matrix is in decision:role-tiers and notification behaviour in
  decision:notification-fanout-semantics, both written for backend authors. The nearest
  glossary is the `concept:` records of the `app_docs` collection (`concept:api-keys`,
  `concept:api-rules`, `concept:shadow-project`, `concept:write-normalisation`).
  `README.md` "Workspaces with roles" is one bullet; `docs/README.md` indexes no journey page.
- Gap: no user journeys, no glossary of product terms, no designer-facing account of
  notifications.

**WEB-2** Every account mail (verification, password reset, email change, invitation) links
to a page of the client app.
- Verdict: missing.
- Evidence: users templates in `v2:1785185200_collections.js` link to
  `{APP_URL}/_/#/auth/confirm-verification/`, `confirm-password-reset/` and
  `confirm-email-change/` (the PocketBase dashboard); `pb_hooks/mail.pb.js` builds the signup
  link the same way; the invitation mail in `pb_hooks/invitations.pb.js` says "To accept it:
  POST" followed by an API URL.
- Gap: no account mail links to a client-app page.

**WEB-3** An approved account can sign in through the public API by password and by emailed
one-time code.
- Verdict: met.
- Evidence: users `otp.enabled: true` in `v2:1785185200_collections.js`; room probe:
  `request-otp` then `auth-with-otp` answered 200 for an approved account.
- Gap: none (the OTP routes are absent from the contract: SH-1).

**WEB-4** Requesting a one-time code does not reveal whether an address has an account.
- Verdict: met.
- Evidence: room probe: `request-otp` for an unknown address answered 200 with an `otpId`.
- Gap: none.

**WEB-5** A client can tell an account awaiting verification or approval apart from other
sign-in refusals.
- Verdict: missing.
- Evidence: every new account starts `approved: false` (decision:signup-approval) and the users
  auth rule is one expression, `verified = true && approved = true` (`schema/users.rules.json`
  `authRule`); a refused sign-in answers 403 "The request doesn't satisfy the collection
  requirements to authenticate." (`tests/test_oauth.ts` check "403 body matches the documented
  authRule-rejection message").
- Gap: the refusal names neither verification nor approval.

**WEB-6** The sign-up journey (first password chosen through a mailed link, then approval by an
app administrator through the pending-users routes) is described in a client-facing document.
- Verdict: partly.
- Evidence: decision:password-signup-verify-first (a signup carrying a password answers 400
  `validation_signup_password`, `pb_hooks/auth_identity.pb.js`) and decision:signup-approval
  (who may approve, `GET /api/tracker/admin/pending-users`,
  `POST /api/tracker/admin/pending-users/{id}/approve`) are backend decision records; both
  routes are in `openapi.json`.
- Gap: no client-facing description of the journey end to end.

**WEB-7** The realtime contract (topic, event envelope, which changes arrive, what is
filtered out) is stated in the published contract.
- Verdict: partly.
- Evidence: the topic `rt:project_items:{workspaceId}` is in the `project_items` description in
  `openapi.json`; the envelope and draft filtering are stated only in the header of
  `pb_hooks/realtime.pb.js` and in `tests/test_realtime.ts`.
- Gap: envelope fields and filtering are absent from the contract.

**WEB-8** The file contract states upload limits, the download URL shape and the token step a
protected file needs.
- Verdict: partly.
- Evidence: limits and `protected: true` in `schema/tasks.json` and `schema/documents.json`
  field `attachments`, whose `help` says a download needs a short-lived file token;
  `openapi.json` descriptions point to `POST /api/files/token`.
- Gap: the download URL shape and the `token` query parameter are absent from the contract.

**WEB-9** Every list route documents its page-size default and cap, its filterable and
sortable fields, and its expand depth.
- Verdict: partly.
- Evidence: the `project_items` description in `openapi.json` lists filter columns, operators,
  error codes and sort pairs, and `pb_hooks/item_list.pb.js` clamps
  `whole(q.get("perPage"), 25, 200)`; other collections carry generic one-line filter and sort
  parameters. Room probe: a stock list with `perPage=5000` returned 1000; an expand chain
  deeper than six levels returned six without error.
- Gap: no per-collection list documentation outside `project_items`; no documented expand cap.

**WEB-10** A filter naming an invalid value is refused rather than answered as empty.
- Verdict: missing.
- Evidence: room probe: `project_items` with `filter=type="bogus"` answered 200 with no items.
- Gap: no refusal for an invalid filter value.

## Unverified

- Allowed browser origins on the deployed server: `Dockerfile` serves
  `--origins=${PB_CORS_ORIGINS:-*}` and `.env.example` sets `*` (room preflight from an
  arbitrary origin: 204 with `Access-Control-Allow-Origin: *`); the deployed value is kept by
  `deploy/railway/railway.ts` `preserve()` and is not in the repository.
- Which OAuth providers the deployed server enables: `pb_hooks/oauth.pb.js` reads env pairs
  for GitHub and Google; the deployed variables are outside the repository.
- The realtime envelope fields and the email-change mail flow were not probed live.

## Out of scope

- Localisation: server messages and mail are English only; whether another language is
  required is a product decision, not a backend fact. Time zones are handled: a stored
  `user_settings.time_zone` is checked in `pb_hooks/lib/workspace_rules.js`
  (`validation_invalid_time_zone`) and the `time_zone` query parameter in
  `pb_hooks/routes.pb.js`.
- Visual design, hosting of the web app, and anything mobile-specific (see
  [`mobile-frontend.md`](mobile-frontend.md)).

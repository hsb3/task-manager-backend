# Proposal

## Why

A person cannot get an account and an API key without the PocketBase superuser dashboard or
hand-written HTTP. The sign-in test of the hosted MCP endpoint showed it: no account existed, and
the signup flow had no page anyone could see. What the server offers today (room probe,
2026-11-11, current migrations and hooks):

- Signup is `POST /api/collections/users/records` with the email and display fields only; a body
  carrying `password` answers 400 `validation_signup_password` (`pb_hooks/auth_identity.pb.js`,
  decision:password-signup-verify-first). The signup mail's link sets the password and verifies
  the account, and it points at the PocketBase dashboard page
  `{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}` (`pb_hooks/mail.pb.js`
  `onMailerRecordPasswordResetSend`). The stock reset and verification templates on the `users`
  collection link to the same dashboard (`v2:1785185200_collections.js`), so every account mail
  lands on a page built for superusers (WEB-2, missing).
- A verified account cannot sign in until an app administrator approves it; the refusal is 403
  "The request doesn't satisfy the collection requirements to authenticate."
  (decision:signup-approval). Approval is `GET /api/tracker/admin/pending-users` and
  `POST /api/tracker/admin/pending-users/{id}/approve`, open to superusers and to accounts listed
  in `APP_ADMIN_EMAILS`, and nothing but `curl` calls them.
- Keys are minted with a session through `POST /api/collections/api_keys/records` (the secret is
  in that response only), listed through `GET /api/tracker/keys` and revoked through
  `POST /api/tracker/keys/{id}/revoke` (key-minting-cli, on main).
- The sign-up journey (a password chosen through the mailed link, then approval) is described
  only in backend decision records; no client walks it (WEB-6, partly).
- The server serves no static files: the image has no `pb_public`, and the only page it renders
  is the OAuth sign-in and consent page (`pb_hooks/views/oauth_authorize.html`).

## Prior art

Fetched on 2026-11-11.

- **Linear** (the app this one converges on). Personal API keys live in the account settings:
  "Admins and permitted Members can create personal API keys from Settings > Account > Security &
  Access", and "For each key you create, you can choose to give it full access to the data your
  user can access" or "restrict it to certain permissions (Read, Write, Admin, Create issues,
  Create comments)"; "You can also limit an API key's access to specific teams in your workspace"
  (https://linear.app/docs/api-and-webhooks). The profile page is "where you personalize how other
  team members will see you" (https://linear.app/docs/profile). Sign-in is Google, an emailed link
  or code, passkeys or SAML; the login-methods page names no password
  (https://linear.app/docs/login-methods). Linear has no administrator approval of a new account:
  "anyone with the matching email domain can join the workspace without an invitation or
  approval" (https://linear.app/docs/invite-members). The pages fetched say nothing on whether a
  key is shown once or on a key's last use.
- **The PocketBase dashboard** this app replaces for account mail already routes by URL hash
  (`/_/#/auth/confirm-password-reset/{TOKEN}`), the form a static host with no rewrites needs;
  TanStack Router documents the same use: "Hash routing can be helpful if your server doesn't
  support rewrites to index.html for HTTP requests"
  (https://tanstack.com/router/latest/docs/framework/react/guide/history-types).

Taken together: keys belong on an account settings page with a permission level and a narrower
reach, which this server already models as `scope` and `reach`. Approval has no Linear
counterpart; it stays this app's own rule (decision:signup-approval), and the app only gives it a
screen.

## Owner rulings

Ruled 2026-11-11 (root as the owner's proxy, card "account-spa"), unchanged except where the
direction below overrides them:

- Flows in scope: signup (email only, and GitHub), the signup mail's set-password-and-verify
  landing, sign in, password reset, profile (name), API keys (list; create with level and reach,
  the secret shown once; revoke), app-administrator approval of pending accounts (holders of
  `APP_ADMIN_EMAILS`), sign out.
- Out of scope: account deletion, email change, any workspace or task screen.

Owner direction, 2026-11-11, relayed by root; it overrides the card's "no UI framework, no CSS
framework" ruling:

- The app is a fork of the `pocketbase-notes-app` repository as a whole app: Vite, React 19,
  TanStack Router, Tailwind 4, shadcn components on Radix, and the PocketBase JS SDK. Its
  structure is kept: the `src/routes/auth/*` screens (register, login, email-verification,
  email-verification-confirm, password-reset, password-reset-confirm, logout), `src/features/auth`,
  the `_authenticated` layout, `src/services/pocketbase.ts` and `src/components/ui`.
- The notes feature is dropped: `src/features/entries`, its routes, and every dependency only it
  uses (ProseKit, KaTeX, Mermaid, the day picker).
- Added: profile, API keys, and approval of pending accounts.
- Every flow follows this server's behaviour (password-less signup whose mail sets the password,
  approval, the key routes), not the notes app's.
- The design decides where the source lives, its package and dependency pins, how its build
  reaches `pb_public` in the image, and how CI builds and tests it; the notes app's Playwright
  tests run only in a container.

## What Changes

- An account app is served by the PocketBase image at `{API}/account/`: sign in, sign up, set a
  password from the signup mail, reset a password, edit the display name, link a sign-in
  provider, list, create and revoke API keys, approve pending accounts (app administrators only),
  sign out.
- The signup, password-reset and verification mails link to the account app instead of the
  PocketBase dashboard. The email-change mail keeps its dashboard link (email change is out of
  scope).
- The account app's documents carry security headers (a content security policy that refuses
  framing, scripts from elsewhere and inline scripts).
- The app adds no server authority: every screen calls a route or collection API that exists
  today, under its existing rules and rate limits. The server changes are the mail links, the
  static files and their headers.
- An app build and test gate joins `make check`, and a browser test suite runs in containers.

## Capabilities

- `account-app`: what the account app shows and does for each flow, which server call backs each
  screen, the mail links, and how the app is served.

## Open Questions

None open. The rulings above settle scope and stack; the design settles the rest under Decisions.

# Contract

This change serves a web app, the account app, from the PocketBase image at `{API}/account/`,
and points three account mails at it. `{API}` is the server's public origin, the value of
`PB_PUBLIC_URL` that `pb_hooks/mail.pb.js` writes into `meta.appURL` (`{APP_URL}` in the mail
templates). The app calls only routes and collection APIs that exist on main; none changes.

## Routes

### Served paths, `{API}`

| Method | Path | Answer |
| --- | --- | --- |
| GET, HEAD | `/account` | 301 to `/account/` (PocketBase's static handler) |
| GET, HEAD | `/account/` | 200 `text/html`, the app's `index.html` |
| GET, HEAD | `/account/index.html` | 301 to `/account/` (PocketBase's static handler) |
| GET, HEAD | `/account/assets/<file>` | 200, the built script, style and font files |
| GET, HEAD | any other path under `/account/` | 404 `{"data":{},"message":"File not found.","status":404}` |
| any | every path outside `/account` | Unchanged: a path that matches no route or file answers 404 as today; nothing falls back to the app's page |

### Screens

The app routes by URL hash, so every screen is `{API}/account/#<screen path>`.

| Screen path | Who | Purpose |
| --- | --- | --- |
| `/` | anyone | Goes to `/profile` when signed in, else `/auth/login` |
| `/auth/login` (`?redirect=<screen path>`) | signed out | Sign in by password or provider |
| `/auth/register` | signed out | Sign up with email and name |
| `/auth/email-verification?email=<address>` | signed out | Check-your-email screen after signup; sends a new link |
| `/auth/password-reset` | signed out | Asks for a reset link |
| `/auth/password-reset-confirm?token=<token>` | signed out | Chooses a password from a mailed link (signup and reset) |
| `/auth/email-verification-confirm?token=<token>` | signed out | Confirms an address from a verification mail |
| `/auth/logout` | anyone | Signs out |
| `/profile` | signed in | Email, display name, sign-in providers |
| `/keys` | signed in | API keys |
| `/approvals` | signed in app administrator | Pending accounts |

A signed-in visitor opening a signed-out screen goes to `/profile`; a signed-out visitor opening a
signed-in screen goes to `/auth/login?redirect=<that screen path>`, and after signing in returns
there. A `redirect` that does not start with `/`, or starts with `//`, is ignored.

## Requests and Responses

### Mail links

| Mail | Link, after this change | Before |
| --- | --- | --- |
| Signup (welcome, sent while the account is unverified) | `{APP_URL}/account/#/auth/password-reset-confirm?token={TOKEN}` | `{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}` |
| Password reset (verified account) | `{APP_URL}/account/#/auth/password-reset-confirm?token={TOKEN}` | `{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}` |
| Verification (`request-verification`) | `{APP_URL}/account/#/auth/email-verification-confirm?token={TOKEN}` | `{APP_URL}/_/#/auth/confirm-verification/{TOKEN}` |
| Email change | unchanged, `{APP_URL}/_/#/auth/confirm-email-change/{TOKEN}` | same |

Subjects, bodies, button texts and token lifetimes are unchanged.

### Response headers on `/account` and every path under it

Set on every GET and HEAD answer, whatever its status, except one: a path whose decoded form holds
a `.` or `..` segment (raw or percent-encoded, under `/account` or any other prefix) and that no
route matches answers as a server without the app does, 404 `{"data":{},"message":"File not
found.","status":404}` without these headers, and never serves the app's files.

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cache-Control` | `public, max-age=31536000, immutable` on a file served under `/account/assets/`; `no-cache` on every other answer, a 404 under `/account/assets/` included |

### Server calls behind each screen

Every call is same-origin, through the PocketBase JS SDK; the session is the SDK's default auth
store (the browser's `localStorage`, key `pocketbase_auth`).

| Screen | Action | Call |
| --- | --- | --- |
| `/auth/login` | Load | `GET /api/collections/users/auth-methods` (providers to offer) |
| `/auth/login` | Password | `POST /api/collections/users/auth-with-password` `{identity, password}` |
| `/auth/login`, `/profile` | Provider | `POST /api/collections/users/auth-with-oauth2` through the SDK's popup flow (`/api/oauth2-redirect`, `/api/realtime`); signed in, it links the provider to the account (decision:oauth-providers-from-env) |
| `/auth/register` | Submit | `POST /api/collections/users/records` `{email, name}` |
| `/auth/email-verification`, `/auth/password-reset` | Send link | `POST /api/collections/users/request-password-reset` `{email}` |
| `/auth/password-reset-confirm` | Submit | `POST /api/collections/users/confirm-password-reset` `{token, password, passwordConfirm}` |
| `/auth/email-verification-confirm` | Load | `POST /api/collections/users/confirm-verification` `{token}` |
| any signed-in screen | First load in a page | `POST /api/collections/users/auth-refresh` |
| `/profile` | Load | `GET /api/collections/_externalAuths/records` (the caller's linked providers), `GET /api/collections/users/auth-methods` |
| `/profile` | Save name | `PATCH /api/collections/users/records/{id}` `{name}` |
| `/keys` | Load | `GET /api/tracker/keys`, `GET /api/tracker/me` (workspace names) |
| `/keys` | Choose a workspace for a projects reach | `GET /api/collections/projects/records` with `filter` `workspace = "<id>" && trashed = ""` (bound through the SDK's `pb.filter`), `sort=name`, `fields=id,name`, every page at 500 a page (the SDK's `getFullList`) |
| `/keys` | Create | `POST /api/collections/api_keys/records` `{name, scope, reach, workspace?, projects?, expires?}`; the answer's `key` is the secret |
| `/keys` | Revoke | `POST /api/tracker/keys/{id}/revoke` |
| signed-in layout | Load | `GET /api/tracker/admin/pending-users`: 200 shows the Approvals entry, 404 hides it |
| `/approvals` | Load | `GET /api/tracker/admin/pending-users` |
| `/approvals` | Approve | `POST /api/tracker/admin/pending-users/{id}/approve` |
| `/auth/logout` | Load | none: the session is removed from the browser's storage |

A key's create body: `name` trimmed; `scope` one of `read`, `write`, `manage`, `own`; `reach` one
of `all`, `workspace`, `projects`; `workspace` only for `workspace` and `projects`; `projects`
only for `projects`; `expires` only when a date is chosen, as `YYYY-MM-DD 00:00:00.000Z` (UTC
midnight that day).

### What each screen shows

Dates are shown in UTC as `YYYY-MM-DD HH:MM UTC`; an empty `expires` or `last_used` shows
`Never`.

| Screen | Content |
| --- | --- |
| `/auth/email-verification` | "Check your email", then "We sent a link to {email}. Open it to choose your password; choosing it confirms your address. An administrator then approves new accounts before they can sign in." and a "Send a new link" button, disabled for 60 seconds when the screen opens (signup has just sent a link) and after each send, reading "Send a new link in {n}s" meanwhile. With no `email` in the URL: "We sent a link to your email address." in place of the first sentence, and no button |
| `/auth/password-reset`, after sending | "If an account uses {email}, a link to choose a new password is on its way." |
| `/auth/password-reset-confirm`, after saving | "Password saved. You can sign in now; a new account can sign in once an administrator approves it." and a "Go to sign in" button |
| `/auth/email-verification-confirm`, confirmed | "Email address confirmed. Choose a password to sign in." and a "Choose a password" button to `/auth/password-reset` |
| `/profile` | Email (read-only), Name (editable, Save; "Saved." after a save), "Sign-in methods": "Password", then per enabled provider "{displayName}: linked" or a "Link {displayName}" button |
| `/keys` | Table columns Name, Level, Reach, Client, Created, Expires, Last used, Status; a "New key" button; a "Revoke" button on each Active key. Level shows `Read`, `Write`, `Manage`, `Own`. Reach shows `All workspaces`, the workspace's name (its id when the caller's `/me` does not list it), or `{n} projects in {workspace name}` (`1 project in {workspace name}` for one; the workspace's id in place of its name when `/me` does not list it). Client shows `client_id`, or `—` when empty. Status is `Revoked` when `revoked`, else `Expired` when `expires` is not empty and not later than now, else `Active`. With no keys: "No keys yet." |
| `/keys`, New key dialog | Name; Level (radio: the four levels, labelled as on the OAuth consent page); Reach (radio "Every workspace", "One workspace", "Some projects of one workspace"); Workspace (select of the caller's `/me` workspaces whose `status` is `active`, shown for the two narrower reaches); Projects (checkboxes, shown for the projects reach); Expires (optional date, at least tomorrow in UTC). After creating: "Copy this key now. It is not shown again.", the secret, a "Copy" button, a "Done" button |
| `/keys`, Revoke dialog | "Revoke key "{name}"?", "Anything using this key stops working at once. This cannot be undone.", "Cancel", "Revoke" |
| `/approvals` | Table columns Name, Email, Signed up, Status, and an "Approve" button where `approved` is false. Status: `Waiting for approval` (verified, not approved), `Email not confirmed; waiting for approval` (neither), `Waiting for email confirmation` (approved, not verified). With none: "No accounts are waiting." |

## Errors

Messages the app shows. "Field" means under that input; "form" means above the submit button.

| Screen | Server answer | Message | Where |
| --- | --- | --- | --- |
| `/auth/login` | 400 | `Wrong email or password.` | form |
| `/auth/login` | 403 | `This account cannot sign in yet. A new account can sign in once its password is chosen from the signup mail and an administrator has approved it.` | form |
| any | 429 | `Too many attempts. Wait a minute and try again.` | form |
| any | no answer (network) | `The server could not be reached. Try again.` | form |
| `/auth/login` | provider window closed before finishing | none | — |
| `/auth/register` | 400 with `data.<field>` | that field's `message` | field (`email`, `name`); any other field's message in the form |
| `/auth/register` | 400 without field data | the answer's `message` (for example `An account with this email address already exists.`) | form |
| `/auth/password-reset-confirm` | 400 with `data.token` | `This link is invalid or has expired.` and a "Request a new link" button to `/auth/password-reset` | form |
| `/auth/password-reset-confirm` | 400 with `data.password` or `data.passwordConfirm` | that field's `message` | field |
| `/auth/password-reset-confirm`, `/auth/email-verification-confirm` | no `token` in the URL | `This link is invalid or has expired.` | form |
| `/auth/email-verification-confirm` | 400 | `This link is invalid or has expired.` | form |
| `/profile` | 400 with `data.name` | that field's `message` (`Cannot be blank.` for a blank name) | field |
| `/keys` create | 400 with `data.<field>` | that field's `message` (`name`, `scope`, `workspace`, `projects`, `expires`) | field |
| `/keys` create | 400 without field data | the answer's `message` | form |
| `/keys` revoke | 404 | `No key with that id among yours.` | dialog |
| `/approvals` | 404 on load | `This page is for app administrators.` | page |
| `/approvals` approve | 404 | `That account no longer exists.` | row |
| any signed-in screen | 401 | none: the session is removed and the app shows `/auth/login` | — |
| any other | any other status | the answer's `message` | form |

Checked in the browser before any request, each blocking the submit:

| Screen | Input | Message |
| --- | --- | --- |
| login, register, password-reset | email blank, or without `@` | `Enter an email address.` |
| login | password blank | `Enter your password.` |
| register, profile | name blank after trimming | `Cannot be blank.` |
| register, profile | name longer than 255 characters | `Use at most 255 characters.` |
| password-reset-confirm | password under 8 characters | `Use at least 8 characters.` |
| password-reset-confirm | confirmation differs | `The passwords do not match.` |
| keys | name blank after trimming, or over 200 characters | `Use 1 to 200 characters.` |
| keys | narrower reach, no workspace | `Choose the workspace this key is limited to.` |
| keys | projects reach, no project | `Choose at least one project.` |
| keys | expiry not after today (UTC) | `Choose a date after today.` |

## Auth

| Surface | Caller | Credential |
| --- | --- | --- |
| `/account` and its files | anyone | none |
| Every server call above | as that route or collection already requires | the PocketBase user session the app holds; the app never sends an API key and never a superuser token |
| `/approvals` | a user the pending-users route answers 200 | the same session; the server decides (superusers and `APP_ADMIN_EMAILS` holders, decision:signup-approval) |

Rate limits are the existing ones (decision:rate-limits-batch-and-superuser-mfa,
decision:rate-limit-counts-x-real-ip): the app adds no limit and no bypass.

## Compatibility

- **Mail links.** A signup, reset or verification mail sent after the deploy opens the account
  app. A mail sent before it keeps its dashboard link, and that page keeps working: the
  dashboard and its routes are unchanged.
- **Served paths.** `/account` and the paths under it change from 404 to the app; every other
  path answers as before, including 404 for an unknown path.
- **CORS** is unchanged: the app is same-origin.
- **API, collections, rules, rate limits, `openapi.json`**: unchanged. The `users` collection's
  reset-password and verification mail templates change text only; the signup mail's link comes from a hook.

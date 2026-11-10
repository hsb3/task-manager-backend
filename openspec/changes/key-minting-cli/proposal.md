# Proposal

## Why

An operator cannot mint, list or revoke an API key without writing HTTP by hand (AC-9). The
documented path is `README.md` "What a client does": sign in with `curl` against
`/api/collections/users/auth-with-password`, then `POST /api/collections/api_keys/records` with
the session token, then export the returned `tmk_` secret. `tm` has no key verbs: its `login`
only asks for an already-minted key to be pasted and saves it (`clients/tm/tm.ts` `login`), and
nothing in `clients/tm/src/` lists or revokes one.

The hosted MCP endpoint (decision hfrk) makes this more pressing. An OAuth grant there produces a
minted `tmk_`-style key that is listed with the user's keys and revoked like one (ruling 6), so
the key list stops being a handful of keys typed in by hand and becomes the record of every
connected agent. AC-9 is the operator's view of that list.

What the server offers today (room probe, 2026-11-10, current migrations and hooks; tree paths as
cited):

- Minting needs a user session. The `api_keys` rules admit only a signed-in owner
  (`schema/api_keys.rules.json`). With a password session, `POST
  /api/collections/api_keys/records` answers 200 with the `tmk_` secret in `key`; that secret is
  returned on create only (`pb_hooks/api_keys.pb.js` sets it as custom data), and a later list
  returns neither `key` nor `key_hash`.
- A key cannot manage keys. With a `tmk_` key, creating a key, listing keys and
  `POST /api/collections/users/auth-refresh` each answer 403 `api_key_path`
  (`pb_hooks/api_keys.pb.js` allowlist, decision:api-key-reads-refused). So a client that holds
  only a key can neither mint another nor see its siblings.
- Revocation is one-way. A signed-in user's session can set `revoked` to true or delete the key; setting it back to false
  answers 404 (`schema/api_keys.rules.json` `updateRule`). A revoked key answers 401
  `api_key_invalid`. `expires` can be set on create and never changed.
- Sign-in needs an account that is both verified and approved (`schema/users.rules.json`
  `authRule`; decision:signup-approval, decision:password-signup-verify-first). A verified but
  unapproved account's password sign-in answers 403.
- The users collection offers password and emailed one-time-code sign-in, MFA off
  (`GET /api/collections/users/auth-methods`; the code is 8 digits and lives 180 seconds,
  the `users` collection's `otp` settings, v2:1785185200_collections.js). GitHub and Google sign-in turn on only when their
  environment pairs are set (decision:oauth-providers-from-env); the room had neither. A user
  session token lives five days (`authToken.duration` on `users`, same migration).
- `tm` saves its login as `{url, key}` in `tm/config.json` under the user's config directory,
  file mode 0600 (the directory is created 0700 but not tightened if it exists), and `TM_URL` / `TM_API_KEY`
  override it (`clients/tm/src/api.ts` `save_config`, `load_config`). It refuses any credential
  not starting `tmk_`, so it never holds a session token (`check_key`).

## Prior art

Each source was fetched on 2026-11-10.

- **Linear** (the app this one converges on). Personal API keys are made in the web app:
  "Admins and permitted Members can create personal API keys from Settings > Account > Security &
  Access", and "Existing API keys for your workspace can be viewed from the same menu and revoked
  if needed" (https://linear.app/docs/api-and-webhooks). Its OAuth "supports the PKCE flow"; an
  access token lasts "24 hours by default" and "Each refresh token expires 30 days after issuance"
  (https://linear.app/developers/oauth-2-0-authentication). That page names no device flow. No
  official Linear CLI was found (https://linear.app/developers lists OAuth only). Unverified:
  whether Linear shows a key once, and whether a key can create a key; the pages fetched do not
  say.
- **GitHub CLI.** "The default authentication mode is a web-based browser flow", a one-time code
  the user confirms in the browser; `--with-token` passes "a personal access token (classic) on
  standard input". The token "will be stored securely in the system credential store", with
  `--insecure-storage` to "Save authentication credentials in plain text instead"
  (https://cli.github.com/manual/gh_auth_login). `gh auth status` displays the "authentication
  state on each known GitHub host" (https://cli.github.com/manual/gh_auth_status) and `gh auth
  logout` "removes the stored authentication configuration"
  (https://cli.github.com/manual/gh_auth_logout). Listing and revoking tokens stays in the web
  app.
- **Stripe CLI** (https://docs.stripe.com/cli/login). "The CLI displays a pairing code and opens
  the Stripe Dashboard, where you confirm the code"; it "stores your credentials in your
  operating system's secure credential store (when available)"; "stripe logout" revokes "the
  session and clear[s] its local credentials"; `--interactive` exists "if you cannot open a
  browser and would like to manually provide an API key". Unverified: the lifetime of what it
  stores.
- **Railway CLI** (https://docs.railway.com/cli/login). `--browserless` will "Login without
  opening a browser (uses pairing code)". Unverified: where it stores the token.
- **Vercel CLI** (https://vercel.com/changelog/new-vercel-cli-login-flow). "The `vercel login`
  command now uses the industry-standard OAuth 2.0 Device Flow".
- **RFC 8252, OAuth for native apps** (https://www.rfc-editor.org/rfc/rfc8252). "The
  authorization server MUST allow any port to be specified at the time of the request for
  loopback IP redirect URIs" (section 7.3); "native apps are classified as public clients" and
  "MUST be registered with the authorization server as such" (section 8.4).
- **RFC 8628, device authorization grant** (https://www.rfc-editor.org/rfc/rfc8628). It is
  "designed for Internet-connected devices that either lack a browser to perform a
  user-agent-based authorization or are input constrained"; its security considerations warn "It
  is possible for the device flow to be initiated on a device in an attacker's possession".
- **MCP authorization, revision 2026-07-28**
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). Pre-registration
  is one of the three ways a client gets a client id, and "Implementations using an STDIO
  transport SHOULD NOT follow this specification, and instead retrieve credentials from the
  environment", which is what `tm mcp` does with the saved key.

Taken together: every CLI surveyed finishes sign-in in a browser, and none asks for a password in
the terminal. The mechanism the pages document is a code shown in the terminal and confirmed in
the browser (GitHub's one-time device code, Stripe's pairing code, Vercel's device flow,
Railway's pairing code); none of the pages fetched documents a loopback redirect. So the prior art
backs the device flow at least as well as the loopback flow, and GitHub, Vercel and Railway
accept the phishing risk RFC 8628 names. GitHub (`--with-token`) and Stripe (`--interactive`) also
take a pasted credential; Railway takes tokens from the environment. Listing and revoking credentials happens in a web
dashboard in every case, which this headless server does not have, so the client command has to
carry it.

## The three ways to sign in

- **Browser, against the built-in authorization server.** `tm login` opens the sign-in and
  consent page that decision hfrk ruling 3 already requires, as a pre-registered public client
  (`tm`) with a loopback redirect on any port and PKCE (RFC 8252). The token response is the
  minted key (ruling 6), saved as today. No password or code is typed into the terminal; GitHub
  and Google sign-in work whenever the server has them; the key appears in the key list tied to
  the `tm` client and revoking it ends the grant, the same as every hosted connection. It needs a
  browser on the same machine, and it cannot ship before the authorization server does.
- **Password or emailed code in the terminal.** `tm` signs in with PocketBase's own
  `auth-with-password` or `request-otp` plus `auth-with-otp`, keeps the five-day session token in
  memory for one command, mints with it, and discards it. It needs no server change and works
  over SSH. It types a password into a CLI, or waits on mail for every sign-in (the code lives
  180 seconds), and the keys it mints are not tied to any OAuth client, so the key list holds two
  kinds of key.
- **Device flow (RFC 8628).** The terminal shows a code to enter in any browser. It works on a
  machine without a browser, but it adds a device-authorization route and a code-entry page to
  the authorization server, beyond the authorize and token routes and single page ruling 3
  settled, and it carries the phishing risk RFC 8628 names, which the GitHub, Vercel and Railway
  CLIs accept.

Ruled 2026-11-10 (Open Question 1): the loopback browser flow for `tm login` and for minting,
with today's paste kept as the fallback for a machine with no browser (`tm login --with-key`, as
`gh auth login --with-token` and `stripe login --interactive` do). It is the one option that adds
no route to the authorization server the hosted endpoint already needs; the device flow, the
closer match to the surveyed CLIs and the better fit for SSH, is not adopted.

## What Changes

- `tm login` signs in through the browser and saves a newly minted key; `tm login --with-key`
  keeps today's paste. `tm logout` deletes the saved login and revokes its key through that
  key's manage-keys permission (today a key cannot revoke even itself).
- `tm keys create --name <name> --scope read|write [--expires <date>]` mints a key for another
  agent or script through the same browser consent, prints the secret once and does not save it.
  Minting needs a person at the browser, and a key can never mint a key.
- The key `tm login` saves carries a manage-keys permission, granted on the consent page: it
  lists and revokes the user's keys and never mints. A key minted by `tm keys create` or by a
  hosted connection does not carry it.
- `tm keys list` shows each of the user's keys: name, scope, the OAuth client it was granted to,
  created, expires, revoked. It never shows a secret; the server keeps only a hash.
- `tm keys revoke <id>` revokes one key. Revocation stays one-way.
- `tm` keeps the saved key in the operating system's credential store through `Bun.secrets`
  (built into the pinned Bun, `mise.toml`); the 0600 file keeps the server URL, and the key too
  only where no credential store is available.
- Every verb takes `--json`, as the existing verbs do.
- `README.md` "What a client does" and `clients/tm/README.md` "Set up once" show `tm login` and
  `tm keys` in place of `curl`, and AC-9's evidence moves to them.
- Conventions settled here, not asked: `tm` stores no refresh token, because a refresh token
  mints a new key with no person present (ruling 6) and would be a stronger credential than the
  key it renews; when the saved key expires, `tm` asks for `tm login` again. The key's default
  name is `tm on <hostname>`; `TM_URL` and `TM_API_KEY` keep overriding the saved login.
- Depends on the hosted-mcp-endpoint contract, not yet written: the lifetime of a grant's key.
  If it is short (Linear's access tokens last 24 hours), `tm login` becomes a frequent prompt, and
  the trade-off between re-signing in and storing a refresh token returns as a question. A `tm
  keys create` key is a grant with no refresh token whose expiry the caller chooses (none unless
  `--expires` is given, as today); the contract has to admit that second kind of grant output.

## How it bears on the hosted-mcp-endpoint rulings (decision hfrk)

- **Ruling 3, authorization server built into PocketBase, one sign-in and consent page.** The
  browser flow reuses that page and its routes, so decision:signup-approval and
  decision:password-signup-verify-first (which superseded the decision:verified-login the ruling
  names) apply to `tm` exactly as to a hosted client. It extends the page in three ways that the
  contract has to carry: `--scope` pre-selects read or write through the standard `scope`
  parameter; `tm keys create` passes a key name and an optional expiry on the authorize request;
  and consent offers the manage-keys permission (Open Question 2).
- **Ruling 4, CIMD plus pre-registered client ids.** `tm` becomes one more pre-registered client:
  public (no secret, RFC 8252 section 8.4) with a loopback redirect whose port is chosen at
  request time (RFC 8252 section 7.3). The hosted-mcp-endpoint contract has to admit a loopback
  redirect for that client.
- **Ruling 6, a grant produces a minted key.** `tm login` and `tm keys create` are grants, so
  their keys are the same records hosted connections produce, listed and revoked by the same
  verbs. Scoping (AC-3, AC-4) is chosen on the same consent page and needs nothing from this
  change.
- **Ruling 7, consent chooses read or write.** `--scope` pre-selects that choice; the page still
  shows it.
- **Ruling 8, rate limits.** If the consent page signs in through PocketBase's existing password
  and code routes, `tm` sign-ins count against their existing per-address limits and add no new
  budget.
- **Listing and revoking from a key needs a new decision.** After the browser flow the CLI
  holds only a key, and a key cannot read or change key records (decision:api-key-reads-refused).
  Ruled 2026-11-10 (Open Question 2): the key `tm login` mints carries a manage-keys permission
  that lists and revokes, never mints. That partly supersedes decision:api-key-reads-refused, so a
  new decision record states it before the contract is written. Ruling 6 stands: the grant still
  produces a key and nothing else.

## What the first key needs

Today the first key needs a person at a mailbox and an administrator. A password signup takes no
password; the signup mail's link sets one and verifies the account
(decision:password-signup-verify-first), and an app administrator then approves it
(decision:signup-approval). A GitHub or Google first sign-in replaces the mailbox with a provider
account whose email the provider has verified, and still waits for approval. A superuser can skip
the approval wait: it can create an account already verified and approved, and mint a key for the
user it names (`pb_hooks/api_keys.pb.js`). But superuser sign-in itself needs an emailed code
(decision:rate-limits-batch-and-superuser-mfa), so a mailbox is still required.

This change does not alter that. The browser flow signs in through PocketBase's own sign-in, so
each later key needs only a signed-in, approved user, and no key, the manage-keys one included,
can mint a key.

## Capabilities

- `key-management`: how a client signs in, mints, lists and revokes keys, and what each command
  shows and refuses.

## Open Questions

Each was ruled on 2026-11-10 with the option shown; the rejected options are kept for the record.

1. **How `tm` signs in to mint a key.** Ruled: the browser against the built-in authorization
   server through a loopback redirect, with key paste kept for a machine with no browser.
   Rejected: a password or emailed code in the terminal; the device flow.
2. **How `tm keys list` and `tm keys revoke` are authorized.** Ruled: the key `tm login` mints
   carries a manage-keys permission, granted on the consent page, that lists and revokes the
   user's keys and never mints; a new decision supersedes decision:api-key-reads-refused in part.
   Rejected: a terminal sign-in per command; a browser sign-in per command.
3. **Where `tm` stores the saved key.** Ruled: the operating system's credential store through
   `Bun.secrets`, falling back to the 0600 file where no store is available. Rejected: the 0600
   file only.

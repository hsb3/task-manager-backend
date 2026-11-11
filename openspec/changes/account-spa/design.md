# Design

The account app is a fork of the `pocketbase-notes-app` repository at commit `3842398` (its
`main` as of 2026-11-11), called "the fork source" below; a path written `fork:src/...` is a path
in that repository. Every fact about the current tree below was read or probed on 2026-11-11
(room probes against `v2:` migrations and hooks at `ca8669a`; spikes in a scratch directory,
listed under Risks with what each proved).

## Decisions

### D1. Where the source lives: `web/account/`, its own package

The app lives in `web/account/` with its own `package.json` and `bun.lock`, not a member of the
root `workspaces` (today `["clients/tm"]`).

- Alternatives: a root workspace member; `clients/account/`.
- Why: the root `bun.lock` feeds the MCP image (`services/mcp/Dockerfile` runs `bun install
  --frozen-lockfile` on the root lock), so a workspace member would put React and Vite in that
  install. The fork source builds with TypeScript 7.0.2 while the root pins 6.0.3. Under
  `clients/` the root `tsconfig.json` (`clients/**/*.ts`, `lib: ["ESNext"]`, no DOM) and the root
  Prettier globs would take in the app's `.ts` files and fail them. `web/` is outside every root
  include and glob, so the root gates stay as they are.
- The root `tsconfig.json` includes `tests/**/*.ts`, so the room suite that drives the flow
  module (Phase 3) imports it through a non-literal specifier and types it with a local
  interface: `tsc` never follows it into `web/account/`, whose `pocketbase` import resolves only
  after `web/account`'s own install, which the CI `static` job does not run.
- Tooling inside `web/account/` is the fork source's: `tsc` 7.0.2 for types, Biome 2.5.9 for lint
  and format (its `biome.json`), Vite 8.2.2 for the build, `bun test` for unit tests, Playwright
  1.64.0 for browser tests. The root's Prettier never formats `web/`.

### D2. Dependencies, pinned exactly

Versions are the fork source's resolved `bun.lock` entries, written without a range. Kept:

| Package | Version | Kind |
| --- | --- | --- |
| `@radix-ui/react-label` | 2.1.15 | dependency |
| `@radix-ui/react-separator` | 1.1.15 | dependency |
| `@radix-ui/react-slot` | 1.3.3 | dependency |
| `@tabler/icons-react` | 3.46.0 | dependency |
| `@tanstack/react-router` | 1.170.31 | dependency |
| `class-variance-authority` | 0.7.1 | dependency |
| `clsx` | 2.1.1 | dependency |
| `lucide-react` | 1.55.0 | dependency |
| `pocketbase` | 0.28.0 | dependency |
| `radix-ui` | 1.8.0 | dependency |
| `react` | 19.2.8 | dependency |
| `react-dom` | 19.2.8 | dependency |
| `tailwind-merge` | 3.6.0 | dependency |
| `@biomejs/biome` | 2.5.9 | devDependency |
| `@playwright/test` | 1.64.0 | devDependency |
| `@tailwindcss/vite` | 4.3.3 | devDependency |
| `@tanstack/router-plugin` | 1.168.34 | devDependency |
| `@types/bun` | 1.4.3 | devDependency |
| `@types/node` | 26.2.0 | devDependency |
| `@types/react` | 19.2.18 | devDependency |
| `@types/react-dom` | 19.2.4 | devDependency |
| `@vitejs/plugin-react` | 6.1.0 | devDependency |
| `tailwindcss` | 4.3.3 | devDependency |
| `tw-animate-css` | 1.4.0 | devDependency |
| `typescript` | 7.0.2 | devDependency |
| `vite` | 8.2.2 | devDependency |

Dropped, with the reason:

- `prosekit`, `katex`, `beautiful-mermaid`: imported only by `fork:src/features/entries` and
  `fork:src/components/editor`.
- `react-day-picker`: imported only by `fork:src/components/ui/calendar.tsx`, used only by the
  entries date picker.
- `@egoist/tailwindcss-icons`, `@iconify-json/lucide`: the only `i-lucide-*` classes are in
  `fork:src/components/editor/ui/*`; the `@plugin` line that loads them is removed from
  `globals.css`.
- `@tanstack/router-devtools`: imported nowhere in the fork source.
- `pocketbase-typegen`: its generated `pocketbase-types.ts` describes the notes collections; the
  app declares the few shapes it reads in `src/lib/account.ts` (D11).
- `@types/bun` moves from the fork's 1.4.0 to 1.4.3, the repository's Bun (`mise.toml`).

Indirect dependencies are pinned by starting from the fork source's lock: Phase 2 copies
`fork:bun.lock` to `web/account/bun.lock` before `bun install`, which prunes the dropped packages
and keeps every remaining resolution as the fork resolved it.

`trustedDependencies` is `["@biomejs/biome"]` (the fork's list minus `esbuild`, which Vite 8 no
longer installs). The fork's `bunfig.toml` is not copied.

### D3. Serving: `pb_public/account/`, hash routes, no index fallback

The image copies the build to `/pb/pb_public/account/` and serves with `--publicDir
/pb/pb_public --indexFallback=false`. Vite builds with `base: "/account/"`; the router uses
`createHashHistory()`.

- Alternatives: the app at `/` with PocketBase's index fallback; path routes under `/account/`
  answered by a hook route returning `index.html`.
- Why: a spike with the app at the root and the default fallback answered `GET /api/nope` and
  `GET /oauth/nope` with 200 and the app's HTML, where today they answer 404 JSON; clients that
  tell a missing route from a refusal (AC-12) would break. With `--indexFallback=false` the spike
  answered every path outside `/account` exactly as a server without `--publicDir` does (404
  `{"data":{},"message":"File not found.","status":404}`, compared on the same room). PocketBase
  falls back only to the public root's `index.html`, so path routes under `/account/` would need
  a hook route that serves files, more server code for prettier URLs. Hash routes are what the
  PocketBase dashboard already uses for the same links (`/_/#/auth/...`) and what TanStack
  documents for "a server [that] doesn't support rewrites to index.html".
- `/account/` keeps the root path free for a later product web app (WEB criteria).

### D4. Security headers: one middleware, `pb_hooks/account_app.pb.js`

A middleware registered through `require(`${__hooks}/lib/routes.js`).use(...)` (the one door
`scripts/check_route_registry.ts` allows) sets the contract's headers on GET and HEAD for
`/account` and every path starting `/account/`, before `e.next()`. A spike proved headers set
there reach the static handler's 200, 301 and 404 answers, that the static handler does not
overwrite `Cache-Control`, and that `POST /account/` answers 404 JSON with no policy header (the
static route is GET and HEAD only).

- Alternatives: a `<meta http-equiv>` policy in `index.html` (MDN: `frame-ancestors` "is not
  supported in the `<meta>` element"); no policy.
- Policy choice: `script-src 'self'` holds because Vite's build emits only external module
  scripts (spike: the built `index.html` has no inline script, and the entry chunk contains no
  `eval(` or `new Function`). `style-src` keeps `'unsafe-inline'` because Radix's scroll lock
  injects a `<style>` element; `img-src` allows `data:` for Tailwind's inline SVG masks;
  `connect-src 'self'` covers the API and the realtime stream the SDK's provider sign-in uses.
  The provider sign-in opens a window to the provider, a navigation no policy here governs.
- The OAuth consent page keeps its own stricter policy (`pb_hooks/lib/oauth.js` `render`); the
  middleware matches only `/account`.

### D5. Mail links: one migration, one hook line, one decision record

- The `users` collection's `resetPasswordTemplate` and `verificationTemplate` bodies get their
  links rewritten by a new migration, `<slot>_account_app_mail_links.js` (spike: applied on a
  copy of the current set, both templates read back with the new link, the email-change template
  untouched). The migration replaces the exact old link substring and throws if it is absent,
  so a template that has drifted fails loudly at migrate time instead of keeping an old link.
- `pb_hooks/mail.pb.js` `onMailerRecordPasswordResetSend` builds the welcome mail's link from
  `meta.appURL` + `/account/#/auth/password-reset-confirm?token=` + the token.
- The email-change mail keeps `/_/#/auth/confirm-email-change/{TOKEN}`: email change is out of
  scope (ruling), so WEB-2 moves from missing to partly, not to met.
- decision:password-signup-verify-first says the signup mail "opens the PocketBase set-password
  page"; a decision record is immutable, so a new record, `decision:` + `account-app-mail-links`
  (written `decision:{A}` below, because `scripts/check_decision_citations.ts` refuses a slug
  before its record is seeded), supersedes that sentence in part. Its kata card is root's to file
  before Phase 1; its `app_docs` twin is seeded in Phase 1.

### D6. Session

The SDK's default `LocalAuthStore` (browser `localStorage`, key `pocketbase_auth`, read in the
installed SDK 0.28.0) holds the five-day session token.

- Alternatives: a cookie set by a hook (a new server surface); an in-memory store (sign-in lost
  on every reload).
- The signed-in layout calls `authRefresh()` once per page load; a failure (the account was
  unapproved or deleted, the token expired) clears the store and shows the sign-in screen.
- Any call answered 401 while signed in clears the store and shows the sign-in screen
  (`pb.afterSend` in `src/services/pocketbase.ts`).
- Sign out clears the store only. The server keeps no session to end (a PocketBase session is a
  signed token it does not store), so a copied token stays valid until it expires; Linear's
  "Revoke all" sessions has no counterpart here (Risks).

### D7. Who sees Approvals

The signed-in layout asks `GET /api/tracker/admin/pending-users` once per page load: 200 shows
the Approvals entry, any other answer hides it. The server stays the only judge
(decision:signup-approval); the app holds no administrator list.

### D8. Sign-in methods offered

Email and password, plus a "Continue with {displayName}" button for each provider
`GET /api/collections/users/auth-methods` lists (GitHub and Google when their environment pairs
are set, decision:oauth-providers-from-env). The emailed one-time code is not offered: the ruled
flows name sign-in, password reset and GitHub, and the code adds a second sign-in screen; the
server keeps the route (WEB-3) and a later change can add it.

### D9. What the fork's signup control and admin link become

- `VITE_SIGNUP_ENABLED` and its `signup.pb.js` hook are not taken: signup here is open and
  approval is the control (decision:signup-approval). The Register link always shows.
- The account menu's "PocketBase admin" link to `/_/` is dropped: the app's administrators are
  `APP_ADMIN_EMAILS` holders, whose one power, approval, the app shows.
- `VITE_AUTH_BYPASS` (a dev-only escape in `fork:src/routes/__root.tsx`) is dropped.
- `VITE_PB_URL` is kept for development only (`make dev` on `http://127.0.0.1:8090`); a
  production build leaves it unset and the SDK calls the same origin.

### D10. One framework-free flow module

Every server call and every message lives in `web/account/src/lib/account.ts`, which imports
only `pocketbase`. Screens call it; `tests/test_account_flows.ts` drives the same functions
against a room. Each function takes the client as its first argument; `client(url, store?)`
builds one (the room suite passes a `BaseAuthStore`, an in-memory store, per user).

### D11. Types

`src/lib/account.ts` declares the shapes it reads (`KeyItem`, `NewKey`, `PendingUser`,
`Workspace`, `ProjectRef`, `Result`), field for field from the contract and `openapi.json`
(`GET /api/tracker/keys` item, `GET /api/tracker/admin/pending-users` user,
`GET /api/tracker/me` workspace). `fork:src/services/pocketbase-types.ts` and `fork:src/types.ts`
are not taken.

### D12. Tests and gates

- **Unit** (`bun test src` in `web/account`): the pure functions of `src/lib/account.ts`.
- **Room suites** (battery): `tests/test_account_app.ts` serves a stub `pb_public` and proves the
  headers and that nothing else changed; `tests/test_account_flows.ts` drives the flow module
  against a room with a mail sink. `tests/test_email.ts` (an existing suite) asserts the new
  mail links.
- **`make web-check`** (joins `make check`, and a CI job `web`): frozen install, Biome, build,
  `tsc`, unit tests.
- **Smoke** (`e2e/smoke.ts`): `probe_account_app` fetches the served page and its script from the
  production image and drives sign-in and a key's create, list and revoke over HTTP the way the
  app does.
- **Browser** (`make account-e2e`, CI job `account-e2e`, not a required check, like `smoke`):
  Playwright in a container on a Compose network beside the production image, with limits on
  each container, no host port and no mount; Chromium only. The fork's WebKit project and
  performance config are not taken, to bound the run.
- The route tree (`src/route-tree.gen.ts`) is generated by the router plugin on every `vite dev`
  and `vite build` and is not committed (`.gitignore`), so it cannot drift; the build runs before
  `tsc` in every gate.

### D13. Image and deploy

- Root `Dockerfile`: a first stage `FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-alpine AS
  account` (the repository's Bun, as `services/mcp/Dockerfile` uses) builds the app; the
  PocketBase stage copies `dist` to `/pb/pb_public/account`. `--platform=$BUILDPLATFORM` runs the
  build natively; the output is static files, the same on every platform.
- `.dockerignore` (an allowlist shared by both images) admits the app's sources only, never
  `node_modules` or `dist`.
- Railway: the `pocketbase` service's `watchPatterns` gain `web/account/**`
  (`deploy/railway/railway.ts`; `.railway/railway.ts` re-exports it and is not edited). Railway
  documents watch paths as "gitignore-style patterns" where "any changes that don't match the
  patterns will skip creating a new deployment"
  (https://docs.railway.com/builds/build-configuration).
- `PB_PUBLIC_URL` must be the public origin that serves `/account/` (it already is: the image
  serves both); no new variable. CORS is unchanged (same origin).
- The `mcp` service's watch list holds unanchored `package.json` and `bun.lock`, which as
  gitignore-style patterns also match `web/account/package.json` and `web/account/bun.lock`;
  Phase 6 anchors them (`/package.json`, `/bun.lock`) so a change to the app's dependencies does
  not redeploy `mcp`. Its `/.dockerignore` entry still redeploys it once for the Phase 6 edit to
  that file, with no change to its image.
- The `pocketbase` service declares `builder: "RAILPACK"` while the image in production is the
  root `Dockerfile`'s (its CMD's preflight and flags are what run today); this change relies on
  Railway building that `Dockerfile`, and checks it on the first deploy (Risks).

### D14. Screen and component layout

- Kept from `fork:src/components/ui/` verbatim: `alert-dialog`, `avatar`, `badge`, `button`,
  `dialog`, `dropdown-menu`, `form`, `input`, `label`, `separator`, `sheet`, `sidebar`,
  `skeleton`, `tooltip` (`.tsx`). Not taken: `attachment`, `breadcrumb`, `calendar`,
  `collapsible`, `empty`, `field`, `popover`, `switch`, `toggle`, `toggle-group` (no kept or new
  screen uses them). Tables and selects are plain `<table>` and `<select>` with Tailwind classes.
- Kept verbatim: `fork:src/hooks/{use-countdown.tsx,use-form-state.tsx,use-mobile.ts}`,
  `fork:src/utils/{classnames.ts,form.ts}`, `fork:src/vite-env.d.ts`.
- New screens live in `src/features/account/{layout,profile,keys,approvals}.tsx`; the auth
  screens stay in `src/features/auth/` as in the fork.
- Copy and messages are the contract's, held in `MESSAGES` in `src/lib/account.ts`.
- Level labels are the consent page's (`pb_hooks/lib/oauth.js` `LEVEL_LABELS`), copied as text.

## Depends on

- On main: key-minting-cli's key routes (`GET /api/tracker/keys`, `POST
  /api/tracker/keys/{id}/revoke`, `pb_hooks/api_key_manage.pb.js`) and key-scoping's `reach`,
  `workspace`, `projects` on `api_keys` (both probed on `ca8669a`); the pending-users routes
  (`pb_hooks/routes.pb.js`); `GET /api/tracker/me`.
- Not on any other change: the `tm` CLI slice of key-minting-cli touches no file this change
  edits except the shared lists below.
- A decision record (kata, root's to file before Phase 1): "the signup, password-reset and
  verification mails link to the account app at `/account/`", superseding
  decision:password-signup-verify-first in part.
- Shared files another change may also edit: `Dockerfile`, `.dockerignore`,
  `deploy/railway/railway.ts`, `deploy/local/compose.yaml` (read, not edited), `Makefile`,
  `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `pb_hooks/mail.pb.js`, `e2e/smoke.ts`,
  the newest `pb_migrations/*_seed_app_docs.js` and `scripts/gen_app_docs_seed.ts`
  `DEFAULT_OUTPUT` (every change touching `app_docs`), `scripts/app_docs_seed.sha256`,
  `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`,
  `docs/readiness/web-frontend.md`, `tests/test_email.ts`.

## Implementation Plan

Conventions for every phase:

- Every phase ends with `make check-static` green, run alone. Rooms follow the clean-room law in
  `AGENTS.md`; ports are the defaults below plus `PB_PORT_OFFSET`.
- "Regen" means, in this order, each run alone: `bun scripts/gen_schema.ts`, `bun
  scripts/gen_openapi.ts`, `bun scripts/gen_decisions.ts`, `bun scripts/model/extract_current.ts`,
  `bun scripts/gen_gitattributes.ts`; their outputs belong to the phase.
- "Re-seed" means: copy the newest `pb_migrations/*_seed_app_docs.js` to
  `pb_migrations/<slot>_seed_app_docs.js` (slot from `make next-migration-slot`, run again after
  each new migration file is created), set `DEFAULT_OUTPUT` in `scripts/gen_app_docs_seed.ts` to
  the new file, make the record edits the phase lists, run `bun scripts/gen_app_docs_seed.ts`
  (it rewrites the seed and `scripts/app_docs_seed.sha256`), then the regen
  (`.agents/rules/pocketbase.md`).
- A new suite is registered in three places: `run_suite "<label>" bun tests/<file>` in
  `scripts/run_suite_battery.sh` after the last `run_suite "` line; a row
  `<shard>\t<seconds>\t<label>` in `scripts/battery_shards.tsv` with its measured seconds, on the
  shard whose seconds column sums lowest, inserted where it keeps the file sorted by seconds
  descending, after the last row with equal seconds; and its ports in `.agents/rules/ports.md`'s
  default list in ascending order before `9700 = test_script_help` (suite ports) or after
  `2535 test_invitation_mail` (sink ports). This change adds `8225 = test_account_app`,
  `8226 = test_account_flows` and the sink `2536 test_account_flows`.
- Code taken from the fork source keeps its formatting; Biome (`web/account/biome.json`) formats
  every file under `web/account/`.
- Comments follow `AGENTS.md`: a one-line file header, a constraint comment only where the code
  cannot show it.

### Phase 1: the server serves `/account` with headers, and mail links point there

- **Goal:** the middleware and the mail links exist and are proven in rooms (contract "Response
  headers", "Mail links"; WEB-2 to partly).
- **Files:**
  - create `pb_hooks/account_app.pb.js`
  - create `pb_migrations/<slot>_account_app_mail_links.js`
  - modify `pb_hooks/mail.pb.js`
  - create `pb_migrations/<slot2>_seed_app_docs.js` (re-seed); modify
    `scripts/gen_app_docs_seed.ts`, `scripts/app_docs_seed.sha256`
  - regen: `docs/generated/decisions.md` (the re-seed's records) and `.gitattributes` (its
    `merge=binary` line follows `DEFAULT_OUTPUT` to the new seed); `schema/` holds no mail
    templates, and a review applied the migration and found every other `--check` green
  - modify `deploy/README.md`
  - create `tests/test_account_app.ts`; modify `tests/test_email.ts`,
    `tests/test_signup_verification.ts`
  - modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`
  - modify `docs/readiness/web-frontend.md`
- **Steps:**
  - `pb_hooks/account_app.pb.js`: header line `/// <reference path="../pb_data/types.d.ts" />`,
    then `// Security headers for the account app's static files under /account
    (openspec account-spa contract).`, then one top-level call (a middleware registered inside
    `onBootstrap` never fires, `pb_hooks/alerts.pb.js`):
    `require(`${__hooks}/lib/routes.js`).use((e) => { ... return e.next(); })`. Body: read
    `const m = e.request.method; const p = e.request.url.path;`; when `(m === "GET" || m ===
    "HEAD") && (p === "/account" || p.startsWith("/account/"))`, set on `e.response.header()`:
    `Content-Security-Policy` to the contract's value exactly, `X-Frame-Options` `DENY`,
    `X-Content-Type-Options` `nosniff`, `Referrer-Policy` `no-referrer`, and `Cache-Control`
    `public, max-age=31536000, immutable` when `p.startsWith("/account/assets/")`, else
    `no-cache`. All constants are inlined in the handler (pooled JSVM, `.agents/rules/pocketbase.md`).
  - `pb_migrations/<slot>_account_app_mail_links.js` (slot from `make next-migration-slot`):
    header `// v2: the users reset-password and verification mails link to the account app
    (decision:{A}).` Up: `const users = app.findCollectionByNameOrId("users")`; a local
    `swap(tpl, from, to)` that throws `new Error("account_app_mail_links: template lacks " +
    from)` when `tpl.body.indexOf(from) < 0`, else sets `tpl.body =
    tpl.body.split(from).join(to)`; call it for `users.resetPasswordTemplate` with
    `{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}` →
    `{APP_URL}/account/#/auth/password-reset-confirm?token={TOKEN}`, and for
    `users.verificationTemplate` with `{APP_URL}/_/#/auth/confirm-verification/{TOKEN}` →
    `{APP_URL}/account/#/auth/email-verification-confirm?token={TOKEN}`; `app.save(users)`. Down:
    the same two replacements reversed, without the presence check, then `app.save(users)`.
  - `pb_hooks/mail.pb.js` line building `link` in `onMailerRecordPasswordResetSend`: becomes
    `` `${e.app.settings().meta.appURL}/account/#/auth/password-reset-confirm?token=${e.meta.token}` ``.
    The comment above `settings0.meta.appURL` ("which link to PocketBase's own confirmation
    pages") becomes `// appURL drives {APP_URL} in the auth email templates, which link to the
    account app (decision:{A}), so it is this server's public URL whether or not SMTP is
    configured.`
  - Re-seed: add one record, sorted by slug as the generator renders: `{ "id": "decaccountapp01",
    "slug": "decision:{A}", "refName": "users", "title": "The signup, password-reset and
    verification mails link to the account app the server serves at /account/.", "body": "This
    supersedes decision:password-signup-verify-first in part: its signup mail no longer opens the
    PocketBase dashboard's set-password page.\n\n- **The links.** The signup mail and the
    password-reset mail link to {APP_URL}/account/#/auth/password-reset-confirm?token={TOKEN};
    the verification mail links to
    {APP_URL}/account/#/auth/email-verification-confirm?token={TOKEN}. {APP_URL} is the server's
    public URL (PB_PUBLIC_URL), which serves the account app.\n- **Unchanged.** Choosing the
    password from the link still verifies the account, its lifetime is still the collection's
    password-reset lifetime, and every other statement of
    decision:password-signup-verify-first stands. The email-change mail keeps its dashboard link,
    because the account app does not change an email address.\n\nPrior art: Linear sends sign-in
    links to its own app; the PocketBase dashboard is a superuser tool. `pb_hooks/mail.pb.js`
    builds the signup link and the users collection's templates carry the other two;
    `tests/test_email.ts` proves them. See collection:users." }`. And
    `decision:password-signup-verify-first`'s body gains a final paragraph, as other partly
    superseded records carry (`docs/generated/decisions.md`): `\n\n**Superseded in part:** the
    signup mail links to the account app at
    {APP_URL}/account/#/auth/password-reset-confirm?token={TOKEN}, not the PocketBase dashboard
    (decision:{A}); the rest of this record is unchanged.` No other record changes.
  - `deploy/README.md` line 54, the `PB_PUBLIC_URL` row's middle cell becomes `the link base in
    signup, verification and password-reset emails, which open the account app at /account/; the
    email-change mail still opens PocketBase's page` (the table's column padding re-aligned).
  - `docs/readiness/web-frontend.md` WEB-2: verdict `partly`; evidence: the signup, reset and
    verification links are `{APP_URL}/account/#/auth/...` (decision:{A}, `tests/test_email.ts`);
    gap: the email-change mail links to the dashboard and the invitation mail to an API URL.
- **Tests:**
  - `tests/test_email.ts` (existing battery suite), watched failing first on the old links:
    - in the header, the text from `the verification and` (line 17) to `(pb_hooks/mail.pb.js);`
      (line 19) becomes `the verification and password-reset emails link to the account app's
      /account/#/auth/... screens under the server's public URL (pb_hooks/mail.pb.js,
      decision:{A});`, rewrapped at the file's width; the rest of line 19 (`request-password-reset
      round-trips ...`) is unchanged.
    - check "its link points at the account app's set-password screen":
      `signup_content.includes(`${APP_URL}/account/#/auth/password-reset-confirm?token=`)` → true.
    - check "verification link points at the account app's confirm screen":
      `verify_content.includes(`${APP_URL}/account/#/auth/email-verification-confirm?token=`)` →
      true; token regex becomes `/email-verification-confirm\?token=([A-Za-z0-9._-]+)/`.
    - check "reset link points at the account app's set-password screen":
      `reset_content.includes(`${APP_URL}/account/#/auth/password-reset-confirm?token=`)` → true;
      token regex `/password-reset-confirm\?token=([A-Za-z0-9._-]+)/`.
    - new check after each of the three: "... no longer points at the dashboard":
      `<content>.includes("/_/#/auth/")` → false.
  - `tests/test_account_app.ts` (new, port 8225, self-booting, house style as
    `tests/test_landing.ts`): scratch copies of migrations and hooks via `copy_tree`, superuser
    upsert, a scratch public dir holding `account/index.html` (`<!doctype html><title>stub</title>`)
    and `account/assets/app.js` (`console.log(1)`), `roomkit.serve(PORT, data, mig, hooks,
    log, ["--publicDir", pub, "--indexFallback=false"])`. `CSP` below is the contract value.
    Watched failing first: before `account_app.pb.js` exists, case 1's CSP check fails.
    1. `GET /account/` → 200, `content-type` starts `text/html`, `content-security-policy` ===
       CSP, `x-frame-options` `DENY`, `x-content-type-options` `nosniff`, `referrer-policy`
       `no-referrer`, `cache-control` `no-cache`.
    2. `HEAD /account/` → 200, CSP header === CSP.
    3. `GET /account` (redirect: manual) → 301, `location` `/account/`, CSP header === CSP.
    4. `GET /account/assets/app.js` → 200, `cache-control` `public, max-age=31536000,
       immutable`, CSP header === CSP.
    5. `GET /account/keys` → 404, body `message` `File not found.`, CSP header === CSP.
    6. `GET /api/nope` → 404 JSON, no `content-security-policy` header.
    7. `GET /api/health` → 200, no `content-security-policy` header.
    8. `GET /accounts` → 404, no `content-security-policy` header.
    9. `POST /account/` → 404, no `content-security-policy` header.
    10. `GET /oauth/authorize` (no query) → 400 and its own policy, header starts `default-src
        'none'`.
    11. `GET /account/index.html` (redirect: manual) → 301, `location` `/account/`, CSP header ===
        CSP.
  - `tests/test_signup_verification.ts` (existing, self-booting): `reset_token` (line 131) matches
    `/password-reset-confirm\?token=([A-Za-z0-9._-]+)/` in place of
    `/confirm-password-reset\/([A-Za-z0-9._-]+)/`; the `vtok` match (line 543) uses
    `/email-verification-confirm\?token=([A-Za-z0-9._-]+)/` in place of
    `/confirm-verification\/([A-Za-z0-9._-]+)/`. Its existing checks then prove the new links
    carry working tokens (watched failing first: before the migration and hook edit, both
    extractions return `""`).
  - Register the suite (8225).
- **Gate:** `bun tests/test_email.ts` in its battery room (the legacy recipe,
  `.agents/rules/ports.md`), `bun tests/test_signup_verification.ts`, `bun
  tests/test_account_app.ts`, `make check-static`, `make smoke` (the image does not serve the
  app until Phase 6, so smoke here proves only that nothing else moved; mail is not reachable
  from smoke, and the link change's proof is the two mail suites).

### Phase 2: the fork, trimmed, builds at `web/account/`

- **Goal:** `web/account/` builds, lints, typechecks and unit-tests on its own; `make web-check`
  and the CI job `web` run it (D1, D2, D3, D12).
- **Files** (copied means copied byte for byte from the fork source path named):
  - create `web/account/package.json`, `web/account/bun.lock` (copied from `fork:bun.lock`, then
    rewritten by `bun install`),
    `web/account/biome.json`, `web/account/components.json`, `web/account/tsconfig.json`,
    `web/account/tsconfig.node.json`, `web/account/vite.config.ts`, `web/account/index.html`,
    `web/account/.dockerignore`, `web/account/README.md`
  - create (copied) `web/account/src/vite-env.d.ts`, `web/account/src/utils/classnames.ts`,
    `web/account/src/utils/form.ts`, `web/account/src/hooks/use-countdown.tsx`,
    `web/account/src/hooks/use-form-state.tsx`, `web/account/src/hooks/use-mobile.ts`, and
    `web/account/src/components/ui/{alert-dialog,avatar,badge,button,dialog,dropdown-menu,form,input,label,separator,sheet,sidebar,skeleton,tooltip}.tsx`
  - create `web/account/src/styles/globals.css` (copied, one line removed)
  - create `web/account/src/main.tsx`, `web/account/src/services/pocketbase.ts`,
    `web/account/src/routes/__root.tsx`, `web/account/src/routes/index.tsx`,
    `web/account/src/routes/_authenticated.tsx`, `web/account/src/routes/_authenticated/profile.tsx`
  - create (copied, edits below) `web/account/src/routes/auth/{login,logout,register,email-verification,email-verification-confirm,password-reset,password-reset-confirm}.tsx`
    and `web/account/src/features/auth/{auth,password-reset,email-verifications}.tsx`
  - create `web/account/src/lib/account.ts` (the pure part: `MESSAGES`, types, validators,
    formatters) and `web/account/src/lib/account.test.ts`
  - modify `Makefile`, `.github/workflows/ci.yml`, `.gitignore`, `tests/test_make_targets.ts`,
    `AGENTS.md`
- **Steps:**
  - `package.json`: `{"name": "account-app", "private": true, "version": "0.0.0", "type":
    "module", "scripts": {"dev": "vite", "build": "vite build", "typecheck": "tsc -p
    tsconfig.json && tsc -p tsconfig.node.json", "lint": "biome check .", "lint:fix": "biome
    check --write .", "test": "bun test src", "e2e": "playwright test"}, "trustedDependencies":
    ["@biomejs/biome"], "dependencies": {...D2 dependencies...}, "devDependencies": {...D2
    devDependencies...}}`, versions exact. Then copy `fork:bun.lock` to `web/account/bun.lock` and run `cd web/account
    && bun install`, which prunes it to this package's dependencies.
  - `biome.json`: copy `fork:biome.json`; in `files.includes` delete the four entries
    `"!**/build/**"`, `"!**/coverage/**"`, `"!**/pb/**"`, `"!src/services/pocketbase-types.ts"`
    and `"!**/.agents/skills/**"`, keeping `"**"`, `"!**/dist/**"`, `"!src/route-tree.gen.ts"`,
    `"!src/styles/globals.css"`, `"!**/test-results/**"`, `"!**/playwright-report/**"`; add
    nothing (Biome skips `node_modules` by itself); nothing else changes.
  - `components.json`: copy `fork:components.json` without its `registries` key.
  - `tsconfig.json`: copy `fork:tsconfig.json`; add `"types": ["bun"]` to `compilerOptions`
    (unit tests import `bun:test`); `include` stays `["src"]`. (Spike: the whole fork source with
    this option and its `DOM` lib typechecks under `tsc` 7.0.2 with exit 0; without it a test
    file's `bun:test` import fails TS2307.)
  - `tsconfig.node.json`: copy `fork:tsconfig.node.json`; `include` becomes
    `["vite.config.ts", "playwright.config.ts", "e2e/**/*.ts"]`; add `"types": ["node"]`.
    (`playwright.config.ts` and `e2e/` arrive in Phase 7; an include matching no file is not an
    error.)
  - `vite.config.ts`: copy `fork:vite.config.ts` and add `base: "/account/",` as the first key
    of `defineConfig`'s object.
  - `index.html`: copy `fork:index.html`; delete the `<link rel="icon" ...>` line (the fork has no
    `public/`, so it was a 404); `<title>Task Tracker account</title>`; description
    `Sign in to Task Tracker, manage the account and its API keys.`
  - `.dockerignore` (for Phase 7's image, build context `web/account`): lines `node_modules`,
    `dist`, `test-results`, `playwright-report`.
  - `README.md`: one-line purpose, then: what it is (the account app served at `/account/`,
    decision:{A} links), how to run it in development (`make dev` in the repository root, then
    `cd web/account && bun install && VITE_PB_URL=http://127.0.0.1:8090 bun run dev`, open
    `http://127.0.0.1:5173/account/`), the gate (`make web-check`), the browser tests (`make
    account-e2e`), and that it is a fork of the pocketbase-notes-app repository at `3842398`.
  - `globals.css`: copy `fork:src/styles/globals.css` and delete the line
    `@plugin "@egoist/tailwindcss-icons";` and the blank line after it.
  - `src/services/pocketbase.ts`: `import { client } from "@/lib/account";` then `export const
    pb = client(import.meta.env.VITE_PB_URL || "/");` then
    `pb.afterSend = (response, data) => { if (response.status === 401 && pb.authStore.isValid)
    { pb.authStore.clear(); window.location.hash = "#/auth/login"; } return data; };`.
  - `src/main.tsx`: copy `fork:src/main.tsx`; import `createHashHistory` from
    `@tanstack/react-router` and pass `history: createHashHistory()` to `createRouter`; delete the
    three comment lines ("Import the generated route tree", "Create a new router instance",
    "Register the router instance for type safety").
  - `src/routes/__root.tsx`: copy; `beforeLoad` returns `{ isAuthenticated: pb.authStore.isValid
    }` (the `VITE_AUTH_BYPASS` branch and its comment removed).
  - `src/routes/index.tsx`: copy; redirect target `/profile` instead of `/entries`.
  - `src/routes/_authenticated.tsx`: copy unchanged (the layout arrives in Phase 5).
  - `src/routes/_authenticated/profile.tsx`: `createFileRoute("/_authenticated/profile")` with a
    component rendering `<main className="p-6"><h1 className="text-xl font-semibold">Profile</h1>
    <p>{pb.authStore.record?.email}</p></main>` (Phase 5 replaces the component).
  - The seven `src/routes/auth/*.tsx` files: copied unchanged, except that `login.tsx`'s
    `validateSearch` passes `redirect` through `safeRedirect` (below). The three
    `src/features/auth/*.tsx` files: copied unchanged, except in `auth.tsx` the `signupEnabled`
    constant and both branches it guards are removed (the Register link always shows,
    `RegisterForm` always renders) and the `SocialAuth` profile-sync `try` block is removed (the
    server maps a provider's name, and fetching a provider's avatar would break `connect-src
    'self'`). They keep the fork's behaviour until Phase 4 rewrites them; the typed `Link`
    targets they name must exist for `tsc`, which is why all seven routes arrive here. The image
    does not serve the app before Phase 6.
  - `src/lib/account.ts`, pure part (no network): exports
    - `MESSAGES`: every string of the contract's "Errors" and "What each screen shows" tables,
      keyed `wrongCredentials`, `notReady`, `tooMany`, `unreachable`, `linkInvalid`,
      `notAdmin`, `accountGone`, `noKeys`, `noPending`, `emailRequired`, `passwordRequired`,
      `nameBlank`, `nameTooLong`, `passwordShort`, `passwordMismatch`, `keyName`,
      `workspaceRequired`, `projectsRequired`, `expiryPast`, `keyShownOnce`, `checkEmail`
      (a function of the address), `resetSent` (a function of the address), `passwordSaved`,
      `emailConfirmed`, `revokeTitle` (a function of the name), `revokeBody`, `saved` (`Saved.`),
      and the screen labels `checkEmailTitle` (`Check your email`), `sendNewLink` (`Send a new
      link`), `sendNewLinkIn` (a function of seconds: `Send a new link in {n}s`),
      `requestNewLink` (`Request a new link`), `goToSignIn` (`Go to sign in`), `choosePassword`
      (`Choose a password`). `checkEmail(undefined)` gives the contract's no-address text. The
      pending-status labels live in `pendingStatus`, the level names in `levelName`. Button and
      field labels the contract names inline (Email, Password, Sign in, New key, Revoke, Approve,
      Done, Copy, Cancel) are written in the screens.
    - `LEVELS`: `[{value: "read", label: "Read: see your workspaces, projects and items."},
      {value: "write", ...}, {value: "manage", ...}, {value: "own", ...}]` (the consent page's
      text) and `levelName(scope)` → `Read`, `Write`, `Manage`, `Own`.
    - types `Scope = "read" | "write" | "manage" | "own"`, `Reach = "all" | "workspace" |
      "projects"`, `KeyItem` (`id, name, scope, client_id, manage_keys, created, expires,
      last_used, revoked, current, reach, workspace, projects`), `NewKey` (`name, scope, reach,
      workspace?, projects?, expires?`), `PendingUser` (`id, name, email, verified, approved,
      created`), `Workspace` (`id, name, role, status`), `ProjectRef` (`id, name`),
      `Result<T> = { ok: true; value: T } | { ok: false; message: string; fields: Record<string,
      string>; status: number }`.
    - `validateEmail(v)`, `validatePassword(v)`, `validatePasswordConfirm(pw, confirm)`,
      `validateName(v)`, `validateKeyName(v)`, each returning the contract's message or
      `undefined` (email: blank after trimming or no `@`; name: blank after trimming, or over 255
      characters; password: under 8 characters; key name: trimmed length outside 1 to 200).
    - `expiresFromDate(day: string, now: Date)`: `""` → `{ok: true, value: null}`; a `YYYY-MM-DD`
      that is a real calendar date later than `now`'s UTC date → `{ok: true, value:
      "YYYY-MM-DD 00:00:00.000Z"}`; otherwise `{ok: false, message: MESSAGES.expiryPast, fields:
      {expires: MESSAGES.expiryPast}, status: 0}`.
    - `keyStatus(item: Pick<KeyItem, "revoked" | "expires">, now: Date)` → `"Revoked"` when `revoked`, else `"Expired"` when `expires !== ""`
      and `Date.parse(expires.replace(" ", "T")) <= now.getTime()`, else `"Active"`.
    - `formatDate(value)` → `""` gives `"Never"`; otherwise `YYYY-MM-DD HH:MM UTC` from the
      stored `YYYY-MM-DD HH:MM:SS.sssZ`.
    - `reachLabel(item: Pick<KeyItem, "reach" | "workspace" | "projects">, workspaces:
      Workspace[])` → `All workspaces` for `all`; the workspace's `name` (or its
      id when absent from `workspaces`) for `workspace`; `${n} projects in ${name}` for
      `projects` (`1 projects` is written `1 project`; `name` is the workspace id when absent).
    - `pendingStatus(user: Pick<PendingUser, "verified" | "approved">)` → the three contract
      labels.
    - `safeRedirect(v)` → `v` when it is a string starting `/` and not `//`, else `undefined`.
    - `errorResult(err: unknown)` → a failed `Result`: a `ClientResponseError` with status 0 →
      `MESSAGES.unreachable`; 429 → `MESSAGES.tooMany`; otherwise `message` is
      `err.response.message` and `fields` maps each key of `err.response.data` to its `message`;
      a non-`ClientResponseError` → `MESSAGES.unreachable` with status 0.
    - `client(url: string, store?: BaseAuthStore)` → `new PocketBase(url, store)`, and a
      re-export `export { BaseAuthStore } from "pocketbase"` so a caller outside the package needs
      no second import path.
  - `Makefile`: add `web-check` to `.PHONY`; add the target (after `check-static`)
    ```
    web-check: ## the account app's gate: frozen install, lint, build, typecheck, unit tests (web/account)
    	cd web/account && bun install --frozen-lockfile
    	cd web/account && bun run lint
    	cd web/account && bun run build
    	cd web/account && bun run typecheck
    	cd web/account && bun run test
    ```
    and change `check: check-static battery` to `check: check-static web-check battery`, its
    help text to `## the gate: check-static, the account app's gate, then the whole suite battery
    (BATTERY_SHARD=i/N runs one shard)`.
  - `tests/test_make_targets.ts`: the scratch root also gets an empty `web/account/` directory;
    the check "check runs check-static, then the whole battery" becomes "check runs check-static,
    the account app's gate, then the whole battery" and expects `[...STATIC, ["bun", "install
    --frozen-lockfile"], ["bun", "run lint"], ["bun", "run build"], ["bun", "run typecheck"],
    ["bun", "run test"], ["battery", ""]]`; "a red static part never reaches the battery" is
    unchanged (watched failing first: the old expectation fails once the Makefile changes).
  - `AGENTS.md` Commands block, the `make check` line's comment becomes `# THE gate:
    check-static, web-check (the account app), then the battery (every suite; CI runs it
    sharded)`, and a line `make web-check                     # the account app's gate
    (web/account): install, lint, build, typecheck, unit tests` follows it.
  - `.github/workflows/ci.yml`: the header comment's first sentence becomes `The repo's one gate
    is \`make check\`: its static part runs here as \`static\`, the account app's gate as \`web\`,
    its battery as the four \`battery\` shards, and \`battery-verify\` proves the shards together
    ran every suite once.`; a job `web` after `static`, `runs-on: ubuntu-latest`,
    `timeout-minutes: 15`, steps `actions/checkout@v7`, `oven-sh/setup-bun@v2` with
    `bun-version: "1.4.3"`, `run: make web-check`.
  - `.gitignore`: under the "Installed and downloaded artifacts" block add `web/account/dist/`,
    `web/account/src/route-tree.gen.ts`, `web/account/test-results/`,
    `web/account/playwright-report/`, and extend that block's comment with ", the account app's
    build output, generated route tree and browser-test reports".
- **Tests** (`web/account/src/lib/account.test.ts`, `bun:test`; watched failing first by running
  it against an `account.ts` that exports the names with empty bodies):
  - `keyStatus` (now `new Date("2026-11-11T10:00:00Z")` throughout): revoked with expires
    `2099-01-01 00:00:00.000Z` → `Revoked`; expires `2020-01-01 00:00:00.000Z` → `Expired`;
    expires `2026-11-11 10:00:00.000Z` → `Expired`;
    expires `2099-01-01 00:00:00.000Z` → `Active`; expires `""` → `Active`.
  - `formatDate`: `2026-11-10 22:13:28.369Z` → `2026-11-10 22:13 UTC`; `""` → `Never`.
  - `expiresFromDate` at now `2026-11-11T10:00:00Z`: `""` → ok null; `2026-11-12` → ok
    `2026-11-12 00:00:00.000Z`; `2026-11-11` → `Choose a date after today.`; `2026-02-30` →
    `Choose a date after today.`; `12/01/2026` → `Choose a date after today.`.
  - `safeRedirect`: `/keys` → `/keys`; `//evil.example` → undefined; `https://evil.example` →
    undefined; undefined → undefined.
  - validators: `validateEmail("")`, `validateEmail("  ")`, `validateEmail("nope")` → `Enter an
    email address.`; `validateEmail("a@b")` → undefined; `validateName("   ")` → `Cannot be
    blank.`; 256 `x` → `Use at most 255 characters.`; `validatePassword("1234567")` → `Use at
    least 8 characters.`; `validatePasswordConfirm("abcdefgh", "abcdefgi")` → `The passwords do
    not match.`; `validateKeyName("")` and 201 `x` → `Use 1 to 200 characters.`; `" k "` →
    undefined.
  - `reachLabel` with `workspaces = [{id: "ws1", name: "Home", role: "owner", status: "active"}]`:
    `{reach: "all"}` → `All workspaces`; `{reach: "workspace", workspace: "ws1"}` → `Home`;
    `{reach: "workspace", workspace: "ws9"}` → `ws9`; `{reach: "projects", workspace: "ws1",
    projects: ["p1", "p2"]}` → `2 projects in Home`; `projects: ["p1"]` → `1 project in Home`; `{reach: "projects", workspace: "ws9", projects:
    ["p1"]}` → `1 project in ws9`.
  - `pendingStatus`: `{verified: true, approved: false}` → `Waiting for approval`; `{false,
    false}` → `Email not confirmed; waiting for approval`; `{false, true}` → `Waiting for email
    confirmation`.
  - `errorResult`: `new ClientResponseError({status: 429, response: {message: "x", data: {}}})`
    → message `Too many attempts. Wait a minute and try again.`; `new ClientResponseError({status:
    0, response: {}})` → `The server could not be reached. Try again.`; `{status: 400, response:
    {message: "m", data: {name: {code: "validation_required", message: "Cannot be blank."}}}}` →
    message `m`, `fields.name` `Cannot be blank.`; `{status: 400, response: {message: "m"}}` →
    message `m`, `fields` `{}`; `new Error("x")` → unreachable, status 0.
- **Gate:** `make web-check`, `bun tests/test_make_targets.ts`, `make check-static`.

### Phase 3: the flow module talks to the server, proven against a room

- **Goal:** every server call in the contract's table is a function of `src/lib/account.ts`,
  proven against a room with mail captured (D10).
- **Files:** modify `web/account/src/lib/account.ts`; create `tests/test_account_flows.ts`;
  modify `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`.
- **Steps** (`src/lib/account.ts`, network part; every function catches and returns
  `errorResult(err)` unless stated, so none throws):
  - `signUp(pb, email, name): Promise<Result<null>>`: `pb.collection("users").create({email:
    email.trim(), name: name.trim()})`. Never sends a password, never calls
    `requestVerification`.
  - `sendPasswordLink(pb, email): Promise<Result<null>>`:
    `pb.collection("users").requestPasswordReset(email.trim())`.
  - `signIn(pb, email, password): Promise<Result<null>>`: `authWithPassword(email.trim(),
    password)`; a 400 → message `MESSAGES.wrongCredentials` with no fields; a 403 →
    `MESSAGES.notReady`; anything else `errorResult`.
  - `signInWithProvider(pb, provider: string, popup: { location: { href: string } } | null):
    Promise<Result<null>>` (a structural type, not `Window`, so the module needs no DOM lib):
    `authWithOAuth2({provider, urlCallback: (url) => { if (popup) popup.location.href = url; }})`;
    a `ClientResponseError` with `isAbort` true → `{ok: false, message: "", fields: {}, status:
    0}` (the caller shows nothing); 403 → `MESSAGES.notReady`. The caller opens `popup` with
    `window.open()` synchronously in the click handler, as `fork:src/features/auth/auth.tsx` does,
    so the browser does not block it.
  - `setPassword(pb, token, password, passwordConfirm): Promise<Result<null>>`:
    `confirmPasswordReset(token, password, passwordConfirm)`; a 400 whose `data` has `token` →
    message `MESSAGES.linkInvalid`, fields without `token`.
  - `confirmEmail(pb, token): Promise<Result<null>>`: `confirmVerification(token)`; any 400 →
    `MESSAGES.linkInvalid`.
  - `refreshSession(pb): Promise<boolean>`: `authRefresh()`; on any error `pb.authStore.clear()`
    and `false`.
  - `signOut(pb): void`: `pb.authStore.clear()`.
  - `saveName(pb, name): Promise<Result<null>>`: `pb.collection("users").update(pb.authStore.record!.id,
    {name: name.trim()})`.
  - `authProviders(pb): Promise<{name: string; displayName: string}[]>`: `listAuthMethods()` →
    `oauth2.enabled ? oauth2.providers : []`; on error `[]`.
  - `linkedProviders(pb): Promise<string[]>`: `pb.collection("_externalAuths").getFullList({fields:
    "provider"})` → the `provider` values; on error `[]`.
  - `listKeys(pb): Promise<Result<KeyItem[]>>`: `pb.send("/api/tracker/keys", {method: "GET"})`
    → `items`.
  - `myWorkspaces(pb): Promise<Result<Workspace[]>>`: `pb.send("/api/tracker/me", {method:
    "GET"})` → `workspaces`, unfiltered (`reachLabel` names any listed workspace; the New key
    dialog's select keeps only `status === "active"`).
  - `projectsOf(pb, workspaceId): Promise<Result<ProjectRef[]>>`:
    `pb.collection("projects").getFullList({filter: pb.filter("workspace = {:w} && trashed =
    ''", {w: workspaceId}), sort: "name", fields: "id,name", batch: 500})`.
  - `createKey(pb, input: NewKey): Promise<Result<{item: KeyItem; secret: string}>>`: the body
    `{name: input.name.trim(), scope, reach}` plus `workspace` only for `workspace`/`projects`,
    `projects` only for `projects`, `expires` only when set; `pb.collection("api_keys").create(body)`;
    `secret` is the answer's `key`; `item` is the answer without `key`, `user`, `collectionId`,
    `collectionName`, `updated`, with `current: false`.
  - `revokeKey(pb, id): Promise<Result<KeyItem>>`: `pb.send(`/api/tracker/keys/${encodeURIComponent(id)}/revoke`,
    {method: "POST"})`.
  - `isAppAdmin(pb): Promise<boolean>`: `pb.send("/api/tracker/admin/pending-users", {method:
    "GET"})` resolves → `true`; any error → `false`.
  - `pendingUsers(pb): Promise<Result<PendingUser[]>>`: same route → `users`; a 404 → message
    `MESSAGES.notAdmin`.
  - `approveUser(pb, id): Promise<Result<null>>`:
    `pb.send(`/api/tracker/admin/pending-users/${encodeURIComponent(id)}/approve`, {method:
    "POST"})`; a 404 → `MESSAGES.accountGone`.
  - Every `pb.send` and collection call passes `requestKey: null` (the SDK otherwise cancels a
    repeated request to the same path, which a double render would trigger).
- **Tests** (`tests/test_account_flows.ts`, port 8226, sink port 2536, self-booting; mail sink,
  SMTP settings `PATCH` and `.eml` reading as in `tests/test_signup_verification.ts`
  `start_sink`, `stop_sink`; before importing, it runs `bun install --frozen-lockfile` in
  `web/account` (cwd) with `stdout` and `stderr` piped and both read in full (`await new
  Response(p.stdout).text()`, likewise `stderr`) before awaiting its exit code, and fails the
  suite with that output if the exit code is non-zero; then
  `const spec = "../web/account/src/lib/account.ts"; const acct = (await import(spec)) as
  AcctApi;` where `AcctApi` is an interface declared in the suite with one member per function the
  suite calls (`client`, `BaseAuthStore`, `signUp`, `setPassword`, `signIn`, `isAppAdmin`,
  `pendingUsers`, `pendingStatus`, `approveUser`, `saveName`, `createKey`, `listKeys`,
  `keyStatus`, `myWorkspaces`, `projectsOf`, `revokeKey`, `sendPasswordLink`, `confirmEmail`,
  `linkedProviders`, `authProviders`, `refreshSession`, `signOut`, `MESSAGES`), each with the
  parameters and return type Phase 3's steps give it, the client typed `{ authStore: { isValid:
  boolean } }`, the store `unknown`, `BaseAuthStore` as `new () => unknown`, `MESSAGES` as
  `Record<string, string>` (the suite reads only its string members), and
  local copies of `Result`, `KeyItem`, `PendingUser`, `Workspace`, `ProjectRef` (a non-literal specifier, so the root `tsc` does not follow it into
  `web/account/`, D1); stores are `new acct.BaseAuthStore()`). `src/lib/account.ts` writes every
  type-only import as `import type`. The room is
  served with `process.env.APP_ADMIN_EMAILS = "flow-admin@example.com"` set before `serve`.
  Fixtures by superuser: `flow-admin@example.com`, `flow-user@example.com` and
  `flow-other@example.com`, each verified, approved, password `flow-pass-123456`. The clients
  `admin`, `user` and `other` each sign in with `acct.signIn(client, email, "flow-pass-123456")`
  (checked ok); `other`'s key comes from `acct.createKey(other, {name: "other", scope: "read",
  reach: "all"})`. The suite's password sign-ins (these three plus cases 6, 7 and 10) stay under
  the 10-a-minute limit on `auth-with-password`; its two anonymous signups under the 5-a-minute
  signup limit. Each actor gets `acct.client(BASE, new acct.BaseAuthStore())`. Watched failing
  first: run against Phase 2's `account.ts` (no network functions): the import fails.
  1. `signUp(anon, "flow-new@example.com", "Flow New")` → ok; the superuser reads the account:
     `verified` false, `approved` false; exactly one new mail, subject `Finish creating your Task
     Tracker account`, containing `${PUBLIC}/account/#/auth/password-reset-confirm?token=`
     (`PUBLIC` = the room's base URL); token taken with `/password-reset-confirm\?token=([A-Za-z0-9._-]+)/`.
  2. `signUp(anon, "flow-new@example.com", "Again")` → not ok, `message` `An account with this
     email address already exists.`
  3. `setPassword(anon, token, "flow-new-123456", "flow-new-123456")` → ok; the account reads
     `verified` true.
  4. `setPassword(anon, token, "flow-new-123456", "flow-new-123456")` again → not ok,
     `message` `This link is invalid or has expired.` (setting the password rotates the account's
     token key, so the used token fails as `data.token`, the same answer a room probe gave for
     token `bad`), `fields` has no `token` key.
  5. `setPassword(anon, "bad", "short", "other")` → not ok, `fields.password` `The length must be
     between 8 and 255.` (room probe 2026-11-11, twice: the answer's `data` holds `password`,
     `passwordConfirm` and `token`)
  6. `signIn(newClient, "flow-new@example.com", "flow-new-123456")` → not ok, message
     `MESSAGES.notReady`; `newClient.authStore.isValid` false.
  7. `signIn(newClient, "flow-new@example.com", "wrong-password")` → message `Wrong email or
     password.`
  8. `isAppAdmin(admin)` → true; `isAppAdmin(user)` → false.
  9. `pendingUsers(admin)` → contains `flow-new@example.com` with `pendingStatus` `Waiting for
     approval`; `pendingUsers(user)` → not ok, message `This page is for app administrators.`
  10. `approveUser(admin, <flow-new id>)` → ok; `pendingUsers(admin)` no longer contains it;
      `signIn(newClient, ...)` → ok and `newClient.authStore.isValid` true.
  11. `approveUser(admin, "zzzzzzzzzzzzzzz")` → message `That account no longer exists.`
  12. `saveName(user, "  Renamed Flow  ")` → ok; the superuser reads `name` `Renamed Flow`.
      `saveName(user, "   ")` → not ok, `fields.name` `Cannot be blank.`
  13. `createKey(user, {name: "flow key", scope: "read", reach: "all"})` → ok, `secret` matches
      `/^tmk_[A-Za-z0-9]{40}$/`; `listKeys(user)` contains its id with `scope` `read`, `reach`
      `all`, and no item has a `key` property; `keyStatus` of it is `Active`.
  14. `createKey(user, {name: "ws", scope: "read", reach: "workspace"})` → not ok,
      `fields.workspace` `Choose the workspace this key is limited to.`
  15. `myWorkspaces(user)` → one workspace; `createKey(user, {name: "ws", scope: "write", reach:
      "workspace", workspace: <id>})` → ok, item `reach` `workspace`.
  16. `projectsOf(user, <id>)` → at least one project (every account is provisioned a workspace
      holding one project; a review saw `My Project` for a superuser-created user); `createKey(user, {name:
      "pr", scope: "read", reach: "projects", workspace: <id>, projects: [<first project id>]})`
      → ok, item `projects` equals that one id.
  17. `createKey(user, {name: "exp", scope: "read", reach: "all", expires: "2099-01-01
      00:00:00.000Z"})` → ok, item `expires` `2099-01-01 00:00:00.000Z`.
  18. `revokeKey(user, <case 13 id>)` → ok, item `revoked` true; `GET /api/tracker/me` with
      header `Authorization: <case-13 secret>` (raw, as `tests/test_key_create.ts` sends a key)
      → 401.
  19. `revokeKey(user, <flow-other's key id>)` → not ok, message `No key with that id among
      yours.`
  20. `sendPasswordLink(anon, "nobody@example.com")` → ok, and no new mail within 2 s;
      `sendPasswordLink(anon, "flow-user@example.com")` → ok; one new mail, subject `Reset your
      Task Tracker password`, containing `${PUBLIC}/account/#/auth/password-reset-confirm?token=`.
  21. `confirmEmail(anon, "bad")` → message `This link is invalid or has expired.`
  22. `linkedProviders(user)` → `[]`; `authProviders(anon)` → `[]` (no provider pair set).
  23. `refreshSession(user)` → true; the superuser sets `flow-user` `approved` false;
      `refreshSession(user)` → false and `user.authStore.isValid` false.
  24. `signOut(admin)` → `admin.authStore.isValid` false.
  - Register the suite (8226, sink 2536).
- **Gate:** `bun tests/test_account_flows.ts`, `make web-check`, `make check-static`.

### Phase 4: the auth screens follow this server

- **Goal:** sign in, sign up, check-your-email, password reset, set password, confirm email and
  sign out behave as the contract's Screens, Errors and "What each screen shows" state.
- **Files:** modify `web/account/src/features/auth/auth.tsx`,
  `web/account/src/features/auth/password-reset.tsx`,
  `web/account/src/features/auth/email-verifications.tsx`. The route files stay as Phase 2 left
  them.
- **Steps** (components are rewritten on the flow module; every form keeps the fork's
  `useFormState` and `formHandler`, its loading spinner and its field markup):
  - `auth.tsx` `LoginForm`: validations `validateEmail`, password blank → `MESSAGES.passwordRequired`;
    submit calls `signIn`; ok → `router.navigate({href: safeRedirect(redirect) ?? "/profile"})`;
    not ok → a form-level message (a `<p role="alert">` above the submit button) with
    `result.message`. The 403 branch's `requestVerification` call is removed. The password
    fields always show: the fork's `authMethods.password.enabled` condition is removed (password
    sign-in is on for `users`, and the app has no other way in without a provider). Providers from
    `authProviders`; each button opens `const popup = window.open()` in the click handler, then
    awaits `signInWithProvider(pb, name, popup)`; an empty message shows nothing. Labels: Email,
    Password, "Forgot password?", "Sign in", "No account yet? Sign up", "Continue with
    {displayName}".
  - `auth.tsx` `RegisterForm`: fields `email` and `name` only (the fork's password fields
    removed); validations `validateEmail`, `validateName`; submit calls `signUp`; ok →
    `router.navigate({to: "/auth/email-verification", search: {email}})`; not ok → each
    `fields` entry under its input (`email`, `name`), any other field and the message at form
    level. Button "Sign up"; "Back to sign in" link.
  - `email-verifications.tsx` `VerificationOnboarding({email})`: title "Check your email", the
    `MESSAGES.checkEmail(email)` text; when `email` is absent, that text alone and no button;
    otherwise a "Send a new link" button calling `sendPasswordLink`,
    disabled for 60 s when the screen mounts (the fork's `start()` on mount: signup has just sent
    a link) and for 60 s after each send with the label `Send a new link in {n}s` (the fork's
    `useCountDown(60, ...)`); a failed send shows `result.message`. `VerificationAttempt({token})`:
    with no token shows `MESSAGES.linkInvalid`; else calls `confirmEmail` once on mount (a
    `useRef` guard, so React's StrictMode double effect does not post twice) and shows
    `MESSAGES.emailConfirmed` with a "Choose a password" button to `/auth/password-reset`, or
    `MESSAGES.linkInvalid`.
  - `password-reset.tsx` `PasswordResetRequest`: email field, `validateEmail`, calls
    `sendPasswordLink`; ok shows `MESSAGES.resetSent(email)`. `PasswordResetAttempt({token})`:
    with no token shows `MESSAGES.linkInvalid` and a "Request a new link" button; else password
    and confirmation fields with `validatePassword` and `validatePasswordConfirm`; submit calls
    `setPassword`; ok shows `MESSAGES.passwordSaved` and a "Go to sign in" button; a
    `linkInvalid` message shows with the "Request a new link" button; field errors under
    `password` and `passwordConfirm`.
- **Tests:** the flows these screens call are proven in Phase 3; the screens are proven in a
  browser in Phase 7 (cases E1 to E4, E9). This phase adds no unit test: the screens hold no
  logic outside the flow module.
- **Gate:** `make web-check`, `make check-static`.

### Phase 5: profile, keys and approvals

- **Goal:** the signed-in screens and their layout (contract: `/profile`, `/keys`, `/approvals`).
- **Files:** create `web/account/src/features/account/layout.tsx`,
  `web/account/src/features/account/profile.tsx`, `web/account/src/features/account/keys.tsx`,
  `web/account/src/features/account/approvals.tsx`, `web/account/src/components/nav-user.tsx`
  (copied from the fork source, edited), `web/account/src/routes/_authenticated/keys.tsx`,
  `web/account/src/routes/_authenticated/approvals.tsx`; modify
  `web/account/src/routes/_authenticated.tsx`, `web/account/src/routes/_authenticated/profile.tsx`.
- **Steps:**
  - `_authenticated.tsx`: `component: AccountLayout`; `beforeLoad` as the fork's, then, when a
    module-level `let refreshed = false` is false, `refreshed = true` and `if (!(await
    refreshSession(pb))) throw redirect({to: "/auth/login", search: {redirect: location.href}})`.
  - `layout.tsx` `AccountLayout`: `SidebarProvider` → `Sidebar` with a header "Task Tracker
    account", a `SidebarMenu` of `Link`s "Profile" (`/profile`), "API keys" (`/keys`) and, when
    `isAppAdmin` resolved true (state, asked once on mount), "Approvals" (`/approvals`); footer
    `<NavUser user={{name, email, avatar: ""}} />` from `pb.authStore.record`; `SidebarInset`
    holding a `SidebarTrigger` and `<Outlet />`.
  - `nav-user.tsx`: copy `fork:src/components/nav-user.tsx`; remove the "PocketBase admin" item
    and the `ExternalLink` import; the remaining item reads "Sign out" and links `/auth/logout`;
    the menu's `SidebarMenuButton` trigger gains `aria-label="Account menu"`.
  - `profile.tsx` `Profile`: Email (read-only text), a Name form (`useFormState`,
    `validateName`, `saveName`; ok calls `refreshSession` so `pb.authStore.record` holds the new name, then
    shows `MESSAGES.saved`), and "Sign-in methods": "Password", then per `authProviders` entry either
    `{displayName}: linked` (its `name` in `linkedProviders`) or a "Link {displayName}" button
    calling `signInWithProvider` exactly as the login screen does, then re-reading
    `linkedProviders`. `routes/_authenticated/profile.tsx` renders it.
  - `keys.tsx` `Keys`: loads `listKeys` and `myWorkspaces` in parallel; shows the contract's
    table (Level `levelName`, Reach `reachLabel`, dates `formatDate`, Status `keyStatus(item, new
    Date())`, Client `client_id || "—"`), "No keys yet." when empty, a load failure's message
    otherwise. "New key" opens a `Dialog` with the form: Name (`validateKeyName`), Level (four
    radio inputs from `LEVELS`, default `read`), Reach (three radios, default `all`), Workspace
    (`<select>` of the workspaces whose `status` is `active`, shown for `workspace` and `projects`; required →
    `MESSAGES.workspaceRequired`), Projects (checkboxes from `projectsOf` of the chosen
    workspace, shown for `projects`; at least one → `MESSAGES.projectsRequired`), Expires
    (`<input type="date">`, `min` tomorrow in UTC, through `expiresFromDate`). Submit calls
    `createKey`; field errors under their inputs, others above the button. On success the dialog
    body is replaced by `MESSAGES.keyShownOnce`, the secret in `<code data-testid="new-key-secret">`,
    a "Copy" button (`navigator.clipboard.writeText`, when `navigator.clipboard` exists; it is
    absent outside a secure context, and the button is then hidden), and "Done", which closes the
    dialog, drops the secret from state and reloads the list. Closing the dialog any other way
    also drops it. Each Active row has "Revoke", opening an `AlertDialog` with
    `MESSAGES.revokeTitle(name)`, `MESSAGES.revokeBody`, "Cancel", "Revoke"; confirming calls
    `revokeKey`, then reloads; a failure shows its message in the dialog.
  - `approvals.tsx` `Approvals`: loads `pendingUsers`; not ok → its message as the page body;
    else the contract's table (`pendingStatus`, `formatDate(created)`) with "Approve" where
    `approved` is false, calling `approveUser`, then reloading; a row's failure shows beside it;
    "No accounts are waiting." when empty. `routes/_authenticated/approvals.tsx` renders it.
  - `routes/_authenticated/keys.tsx` renders `Keys`.
- **Tests:** proven in Phase 7 (E5 to E9); their server calls in Phase 3.
- **Gate:** `make web-check`, `make check-static`.

### Phase 6: the image serves the app; smoke proves it

- **Goal:** the production image builds the app into `/pb/pb_public/account` and serves it with
  the headers, proven by `make smoke` (D13).
- **Files:** modify `Dockerfile`, `.dockerignore`, `deploy/railway/railway.ts`, `e2e/smoke.ts`,
  `e2e/README.md`, `tests/test_boot_refusals.ts`, `.github/workflows/ci.yml`, `README.md`,
  `docs/readiness/web-frontend.md`.
- **Steps:**
  - `Dockerfile`: line 1 becomes `# Production image: the account app's build plus stock
    PocketBase and this repo's migrations and hooks.`; before `FROM alpine:3.24` insert
    ```
    FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-alpine AS account
    WORKDIR /src
    COPY web/account/package.json web/account/bun.lock ./
    RUN bun install --frozen-lockfile
    COPY web/account/index.html web/account/vite.config.ts web/account/tsconfig.json web/account/tsconfig.node.json ./
    COPY web/account/src ./src
    RUN bun run build

    ```
    after `COPY pb_hooks /pb/pb_hooks` insert `COPY --from=account /src/dist
    /pb/pb_public/account`; in the CMD's `exec /pb/pocketbase serve` line insert `--publicDir
    /pb/pb_public --indexFallback=false` after `--hooksDir /pb/pb_hooks`. Nothing else in the CMD
    changes (`scripts/check_raw_migrate_up.ts` parses it).
  - `.dockerignore`: append `!web/account/package.json`, `!web/account/bun.lock`,
    `!web/account/index.html`, `!web/account/vite.config.ts`, `!web/account/tsconfig.json`,
    `!web/account/tsconfig.node.json`, `!web/account/src`.
  - `deploy/railway/railway.ts`: the `pocketbase` service's `watchPatterns` becomes
    `["/Dockerfile", "/.dockerignore", "pb_migrations/**", "pb_hooks/**", "web/account/**"]`;
    the `mcp` service's becomes `["services/mcp/**", "clients/tm/src/**",
    "clients/tm/package.json", "/package.json", "/bun.lock", "/.dockerignore"]` (D13).
  - `tests/test_boot_refusals.ts` `container_cmd()`: add `.replaceAll("/pb/pb_public",
    path.join(path.dirname(data_dir), "pb_public"))` before the `/pb/pb_data` replacement (§5
    refuses any `/pb/` path it does not substitute; PocketBase serves a missing public dir as
    404s, so the directory need not exist).
  - `.github/workflows/ci.yml` job `smoke`: `timeout-minutes: 10` becomes `20` (the image now
    installs and builds the app).
  - `e2e/smoke.ts`: a new `async function probe_account_app(): Promise<void>`, added to `PROBES`
    after `probe_read_key_me` (before the rate-limit probe, which stays last). It:
    1. `GET /account/` → 200; `content-security-policy` equals the contract value;
       `x-frame-options` `DENY`; body contains `<div id="root"></div>`.
    2. takes the `src` of `<script type="module" crossorigin src="(/account/assets/[^"]+\.js)">`
       from the body; `GET` it → 200, `content-type` starts `text/javascript`, `cache-control`
       `public, max-age=31536000, immutable`.
    3. `GET /account/keys` → 404; `GET /api/nope` → 404 with JSON `message` `File not found.`
    4. signs in as the smoke key user (`key_session()`), then, as the app does:
       `POST /api/collections/api_keys/records` `{name: "smoke account app", scope: "read",
       reach: "all"}` → 200 with a `key` starting `tmk_`; `GET /api/tracker/keys` → 200, an item
       with that id and no `key` field; `POST /api/tracker/keys/{id}/revoke` → 200, `revoked`
       true.
    The header comment's "Not covered" paragraph gains: "The account app's screens are covered
    by `make account-e2e` (a browser in a container), not here."
  - `e2e/README.md`: after the `probe_oauth_scopes` bullet add `- \`probe_account_app\`: the
    image serves the account app at \`/account/\` with its security headers and its script, an
    unknown path under it and under \`/api/\` still answers 404, and a key is created, listed and
    revoked the way the app calls the API.`
  - `README.md` "What a client does": after its first paragraph add "A person signs up, chooses a
    password from the signup mail, signs in, and creates or revokes keys in the account app the
    server serves at `/account/` (source `web/account/`). An app administrator approves new
    accounts there too."
  - `docs/readiness/web-frontend.md` WEB-6: evidence gains "the account app walks the journey
    (`/account/`, `tests/test_account_flows.ts`)"; verdict stays partly (no client-facing
    document).
- **Tests:** `probe_account_app` (watched failing first: before the Dockerfile edit, step 1
  answers 404).
- **Gate:** `bun tests/test_boot_refusals.ts`, `make smoke`, `make check-static`.

### Phase 7: browser tests in containers

- **Goal:** the screens are proven in Chromium against the production image, in containers with
  limits, by `make account-e2e` and the CI job `account-e2e` (D12).
- **Files:** create `web/account/playwright.config.ts`, `web/account/e2e/account.spec.ts`,
  `web/account/e2e/Dockerfile`, `deploy/local/compose.account-e2e.yaml`, `e2e/account_e2e.ts`,
  `e2e/fixtures/account_e2e_users.js`; modify `Makefile`, `.github/workflows/ci.yml`,
  `e2e/README.md`.
- **Steps:**
  - `e2e/fixtures/account_e2e_users.js`: a migration in the shape of
    `e2e/fixtures/smoke_key_user.js` creating three verified users with names: `account-e2e@example.com`
    ("Account E2E", approved), `account-admin@example.com` ("Account Admin", approved),
    `account-pending@example.com` ("Account Pending", not approved), passwords
    `account-e2e-123456` for all; down is empty.
  - `deploy/local/compose.account-e2e.yaml` (an override of `deploy/local/compose.yaml`):
    ```
    # The account app's browser tests: the production image and a Playwright container, no host port.
    services:
      pocketbase:
        ports: !reset []
        environment:
          PB_PUBLIC_URL: http://pocketbase:8080
          APP_ADMIN_EMAILS: account-admin@example.com
        cpus: 2
        mem_limit: 4g
        pids_limit: 512
      playwright:
        build:
          context: ../../web/account
          dockerfile: e2e/Dockerfile
        environment:
          ACCOUNT_BASE_URL: http://pocketbase:8080
        cpus: 2
        mem_limit: 4g
        pids_limit: 512
        depends_on:
          pocketbase:
            condition: service_healthy
    ```
  - `web/account/e2e/Dockerfile`:
    ```
    FROM mcr.microsoft.com/playwright:v1.64.0-noble
    COPY --from=oven/bun:1.4.3 /usr/local/bin/bun /usr/local/bin/bun
    WORKDIR /work
    COPY package.json bun.lock ./
    RUN bun install --frozen-lockfile
    COPY playwright.config.ts ./
    COPY e2e ./e2e
    CMD ["bunx", "playwright", "test"]
    ```
    (The image holds browsers, not the test package: "The Playwright package/dependency is not
    included in the image", https://playwright.dev/docs/docker.)
  - `web/account/playwright.config.ts`: `defineConfig({testDir: "./e2e", testMatch:
    "**/*.spec.ts", projects: [{name: "chromium", use: {browserName: "chromium"}}], workers: 1,
    retries: 0, forbidOnly: true, timeout: 60_000, expect: {timeout: 10_000}, reporter: "list",
    use: {baseURL: process.env.ACCOUNT_BASE_URL ?? "http://pocketbase:8080", trace: "off"}})`.
  - `e2e/account_e2e.ts` (root, Bun; structure of `e2e/smoke.ts` `main`): refuses with exit 2 and
    smoke's Docker message when `docker info` fails; compose project `account-e2e-<pid>` with
    `-f deploy/local/compose.yaml -f deploy/local/compose.account-e2e.yaml`; a 30-minute
    wall-clock timer that runs the cleanup and exits 1; steps, each checked by exit status:
    `up -d --build --wait pocketbase`; `cp e2e/fixtures/account_e2e_users.js` to the container
    path `"pocketbase:/pb/pb_migrations/" + E2E_MIGRATION`, where the file declares `const
    E2E_MIGRATION =` the slot `1785199998` joined to `_account_e2e_users.js` in one string literal
    (as `e2e/smoke.ts` holds `SMOKE_MIGRATION`; a migration name written into a path elsewhere is
    refused by `scripts/check_migration_citations.ts`); `restart pocketbase`; `up -d
    --wait pocketbase`; `run --rm --build playwright` (its exit status is the verdict, its output
    streamed); always `down -v --rmi local --remove-orphans`, then `docker ps -a --filter
    label=com.docker.compose.project=account-e2e-<pid> -q` must print nothing, else exit 1 naming
    the leftovers.
  - `web/account/e2e/account.spec.ts`: one `test.describe.serial` block; a `page` created once in
    `test.beforeAll` with `browser.newPage()` and shared by E1 to E9 in order (each test is a
    step of one session; Playwright otherwise gives every test a fresh context); a
    `page.on("console")` listener attached there pushes every message text to an array, and an
    `afterEach` fails the test when one contains `Content Security Policy`; `test.afterAll`
    closes the page. "Sign in as X" means: `goto("/account/#/auth/login")`, fill Email and
    Password, click "Sign in". At E1 nobody is signed in.
    - E1 `the app loads under its policy`: `goto("/account/")` → URL ends `#/auth/login`; the
      Email and Password inputs are visible; no policy message.
    - E2 `sign-up asks only for email and name`: from login, "Sign up"; the form has no
      password input; submit `account-new-<Date.now()>@example.com`, "New Person" → URL contains
      `#/auth/email-verification`; text "Check your email" visible.
    - E3 `a wrong password is named`: sign in `account-e2e@example.com` / `wrong-password` →
      `Wrong email or password.`
    - E4 `a pending account is told it is not ready`: `account-pending@example.com` with its
      password → the `notReady` message; URL still `#/auth/login`.
    - E5 `the profile renames`: sign in as `account-e2e@example.com` (password
      `account-e2e-123456`) → URL ends `#/profile`; the
      email shows; Name `Renamed E2E` → Save → "Saved."; reload → the Name input holds `Renamed
      E2E`.
    - E6 `a key is shown once and revoked` (still signed in from E5): "API keys" → "New key"; Name `e2e key`, Level Read,
      Reach Every workspace → create; `[data-testid=new-key-secret]` text matches
      `/^tmk_[A-Za-z0-9]{40}$/`; "Done"; the row `e2e key` shows `Active`; the page text does not
      contain the secret; `page.getByRole("row", {name: /e2e key/}).getByRole("button", {name: "Revoke"})` → `page.getByRole("alertdialog").getByRole("button", {name: "Revoke"})` → the row shows
      `Revoked`.
    - E7 `approvals are hidden from a member` (still signed in from E5): no "Approvals" link; `goto("/account/#/approvals")`
      → `This page is for app administrators.`
    - E8 `an administrator approves`: `getByRole("button", {name: "Account menu"})` → "Sign out"; sign in as
      `account-admin@example.com`;
      "Approvals"; the row `account-pending@example.com` shows `Waiting for approval`; `page.getByRole("row", {name: /account-pending@example\.com/}).getByRole("button",
      {name: "Approve"})` → that row is gone; `page.getByRole("button", {name: "Account menu"})` → "Sign out"; sign in as `account-pending@example.com` → URL ends
      `#/profile`.
    - E9 `sign out returns to sign in and guards screens` (signed in as the pending account from
      E8): `getByRole("button", {name: "Account menu"})` → "Sign out" → URL ends
      `#/auth/login`; `goto("/account/#/keys")` → URL contains `#/auth/login?redirect=`.
  - `e2e/README.md` file table: a row after `smoke.ts`: `| \`account_e2e.ts\` | \`make
    account-e2e\`: the account app's browser tests (\`web/account/e2e/\`) in a Playwright
    container beside the production image; no host port |`.
  - `Makefile`: add `account-e2e` to `.PHONY`; target `account-e2e: ## the account app's browser
    tests in containers (e2e/account_e2e.ts); needs Docker` with recipe `bun e2e/account_e2e.ts`.
  - `.github/workflows/ci.yml`: job `account-e2e`, `runs-on: ubuntu-latest`, `timeout-minutes:
    30`, steps checkout, setup-bun 1.4.3, `run: make account-e2e`; its comment line: `# Not a
    required check, like smoke: it builds two images and runs a browser.`
- **Tests:** E1 to E9 (watched failing first: E6 run against a build whose `keys.tsx` omits
  the `data-testid` fails on the secret locator).
- **Gate:** `make account-e2e` (then `docker ps -a` shows none of its containers), `make
  check-static`, and for the change as a whole `make check` and `make smoke`.

## Risks

- **A policy violation the spikes could not see.** The spike proved the build emits no inline
  script and no `eval`, but no browser ran under the policy outside a container. Caught by E1
  and the console check in every Phase 7 test; the fallback is to widen only the named directive
  in `pb_hooks/account_app.pb.js` and the contract together.
- **Railway's builder.** `deploy/railway/railway.ts` declares `builder: "RAILPACK"` for
  `pocketbase`, yet the running image is the root `Dockerfile`'s; not verified how Railway
  reconciles the two. Caught by the first deploy's build log naming the `account` stage, or a
  live `GET /account/` answering 404; the fallback is to set that service's `builder` to
  `"DOCKERFILE"` with `dockerfilePath: "Dockerfile"`, as the `mcp` service does.
- **`--platform=$BUILDPLATFORM` on Railway.** It needs BuildKit, which compose uses locally;
  Railway's builder is not verified to pass it. Caught by the first Railway deploy failing at
  the `account` stage; the fallback is to drop `--platform=$BUILDPLATFORM` (the stage then runs
  as amd64, as the rest of the image does).
- **The bun binary path in `oven/bun:1.4.3`.** Phase 7 copies `/usr/local/bin/bun`; unverified.
  Caught by the e2e image build failing on the `COPY`; the fallback is `RUN npm install -g
  bun@1.4.3` in place of the `COPY`.
- **A stolen browser session.** The token sits in `localStorage` for five days and sign-out does
  not end it server-side (D6). The policy (no foreign or inline script) is the mitigation; a
  server-side sign-out is a separate change.
- **The 403 message covers two causes.** An unverified account with a known password and an
  unapproved one both answer 403 (WEB-5 stays missing). Since decision:password-signup-verify-first
  an unverified account has no password its owner knows, so the message names approval first.
- **Provider sign-in and linking are untested here.** No suite has a live provider (as in
  `e2e/smoke.ts`). The SDK call is the fork source's, unchanged.
- **The battery needs the package registry.** `tests/test_account_flows.ts` runs `bun install
  --frozen-lockfile` in `web/account`, so an offline battery or a registry outage fails that
  suite for a reason outside the code; its failure message is the install output, which names
  the cause.
- **Mail sent before the deploy.** It keeps the dashboard link, which keeps working (contract,
  Compatibility).

## Open Questions

None. The owner's direction settled the stack; D1 to D14 settle the rest.

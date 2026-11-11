# Account app

The account app served at `/account/`: sign in, sign up, password reset, email verification,
profile, API keys and account approvals. The signup, password-reset and verification mails link
here (decision:account-app-mail-links).

## Development

Run `make dev` in the repository root, then:

```bash
cd web/account && bun install && VITE_PB_URL=http://127.0.0.1:8090 bun run dev
```

and open `http://127.0.0.1:5173/account/`.

## Gates

- `make web-check` (repository root): frozen install, lint, build, typecheck, unit tests.
- `make account-e2e` (repository root): the browser tests.

## Origin

A fork of the pocketbase-notes-app repository at commit `3842398`.

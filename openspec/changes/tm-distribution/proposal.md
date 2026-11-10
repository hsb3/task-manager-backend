# Proposal

## Why

The `tm` CLI and its `tm mcp` stdio server run only from a checkout of this repository (AC-8).
The milestone needs an installable client: an operator's agent host (Claude Code, Cursor) has
to launch `tm mcp` on a machine that has never cloned the repository.

What the client is today (tree paths as cited; probes run 2026-11-10 with Bun 1.4.3 and Node
26.10.0):

- `clients/tm/package.json` is `"private": true`, version `0.1.0`, with `bin: { "tm":
  "./tm.ts" }` and one dependency, `@modelcontextprotocol/sdk` pinned to `1.32.2`. Nothing is
  published; the unscoped name `tm` is already taken on the npm registry (`npm view tm`).
- `clients/tm/tm.ts` starts `#!/usr/bin/env bun`, so its bin runs only where Bun is installed.
  The one Bun-only call in the client is `Bun.stdin.text()` in `read_secret` (`clients/tm/tm.ts`),
  used when `tm login` reads a key from a pipe; `clients/tm/src/` uses only `node:` modules and
  `fetch`.
- Node cannot run the source: `node tm.ts --help` stops at `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
  ("TypeScript parameter property is not supported in strip-only mode", the `ApiError`
  constructor in `clients/tm/src/api.ts`).
- A copy of `clients/tm/` alone (`tm.ts`, `package.json`, `src/`, no `node_modules`) runs under
  Bun: `bun tm.ts --help` exits 0 and `bun tm.ts mcp` answers `initialize` and `tools/list`,
  Bun installing the SDK on first use. The README's setup still starts from the repository
  (`clients/tm/README.md`, "Set up once": `bun install` at the repo root, then link
  `clients/tm/tm.ts` onto `PATH`), and its MCP entry runs `bun /absolute/path/to/clients/tm/tm.ts
  mcp`.
- `bun build --target=node clients/tm/tm.ts` gives one self-contained file of about 590 KB with
  the SDK inside. It still starts `#!/usr/bin/env bun` and `// @bun`, so a Node launcher needs its
  first line rewritten after the build. Under Node it prints help, and `tm mcp` lists all six tools. Piping a key into
  `tm login` fails at `Bun.stdin`.
- `bun build --compile` gives a standalone executable: about 71 MB for darwin-arm64, 91 MB
  for linux-x64 and 97 MB for windows-x64 (`stat` byte counts). The darwin-arm64 binary passed every check of
  `tests/test_tm_cli.ts` run against it in a room (offset 800). The exception was the suite's
  self-check that rebuilds the CLI from patched source, which tests the harness rather than the
  binary.
- The MCP server reports its version as a literal, `{ name: "tm", version: "0.1.0" }` in
  `serve` (`clients/tm/src/mcp.ts`), separately from `package.json`. Requests carry no client
  version: `request` in `clients/tm/src/api.ts` sends only `Authorization` and `Content-Type`.
- The server states no contract version either: `openapi.json` has a constant `info.version` of
  `1.0.0`, and no response carries a version (SH-5).
- A saved login lives in `$XDG_CONFIG_HOME/tm/config.json`, falling back to
  `~/.config/tm/config.json` (`config_path` in `clients/tm/src/api.ts`). `TM_URL` and
  `TM_API_KEY` override it.
- The repository was private when this proposal was written and is public since the ruling on
  question 1 below (`gh repo view hsb3/task-manager-backend --json visibility`: `"PUBLIC"` on
  2026-11-10), so its source and release assets need no GitHub credential to read.

### Two consumers

1. **Operators installing tm.** A person or an agent host on a machine with no checkout. It runs
   `tm` as a command, or launches `tm mcp` as a stdio child process from an MCP host config.
   This consumer needs a published artifact.
2. **The hosted Bun MCP service** (decision hfrk, ruling 5: a separate Bun service that reuses
   the tm tool catalog and calls PocketBase with the caller's credential). It is built from this
   repository, so it imports the catalog as a workspace module (`TOOLS` and `call` in
   `clients/tm/src/mcp.ts`; `call(cfg, name, args)` already takes the credential per call). It
   needs no published package, and its catalog version is the commit it was built from. What it
   does need from this change: the catalog stays importable without starting stdio (`serve` is
   the only code that connects a transport), and Bun-only code stays out of the catalog's
   import graph. Changing that module boundary belongs to hosted-mcp-endpoint's design.

## Prior art

Each source was fetched on 2026-11-10.

- **Linear** (https://linear.app/docs/mcp, https://github.com/linear). Linear distributes no
  local MCP server. It serves the remote endpoint only, and for older hosts points to a
  third-party bridge: "use the mcp-remote module for backwards compatibility with clients that do
  not support remote MCP", configured as `npx -y mcp-remote https://mcp.linear.app/mcp`. Its
  GitHub organisation lists one CLI, `linear-release` ("CLI to automatically track releases in
  Linear"). No task CLI turned up (unverified beyond the repositories the organisation page
  showed).
- **GitHub MCP server** (https://github.com/github/github-mcp-server): "The Docker image is
  available at `ghcr.io/github/github-mcp-server`". The host config runs `docker run -i --rm`
  with the token in `env`, or runs a locally built binary with `args: ["stdio"]`. Whether release
  binaries ship as well is unverified: the releases page did not load.
- **Railway CLI** (https://docs.railway.com/guides/cli). It ships through an install script,
  Homebrew, `npm i -g @railway/cli`, Scoop and GitHub release binaries, and "Requires Node.js
  version 16 or higher" on the npm route. The npm package's manifest
  (https://registry.npmjs.org/@railway/cli/latest) has `bin: railway.js` and a `postinstall`
  script, which suggests the native binary is downloaded at install time (not read, so
  unverified).
- **Stripe CLI**. The install page (https://docs.stripe.com/stripe-cli/install) offers an install
  script, npm, Homebrew, apt and Scoop, and "The CLI is also available as a Docker image". The
  CLI's readme (https://github.com/stripe/stripe-cli#installation) adds "Download the latest
  release for your platform from the GitHub Releases page".
- **MCP servers on npm.** The reference filesystem server
  (https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) is launched as
  `"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", ...]`. Cursor's
  documented stdio shape is the same, `"command":"npx","args":["-y","mcp-server"],"env":{...}`
  (https://cursor.com/docs/context/mcp).
- **Claude Code** (https://code.claude.com/docs/en/mcp) adds a stdio server with `claude mcp
  add [options] <name> -- <command> [args...]`, for example `claude mcp add --env
  AIRTABLE_API_KEY=YOUR_KEY --transport stdio airtable -- npx -y airtable-mcp-server`.
- **Bun** (https://bun.com/docs/compiler/executables) cross-compiles to `bun-darwin-arm64`,
  `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64` (with `-musl` variants),
  `bun-windows-x64` and `bun-windows-arm64`. Under `bunx` (https://bun.com/docs/pm/bunx), "By
  default, Bun respects shebangs": a `#!/usr/bin/env node` bin runs under Node unless `bunx
  --bun` is passed. The page documents no counterpart for `npx`, which hands a
  `#!/usr/bin/env bun` bin to the operating system, so Bun has to be on `PATH` (inferred from the
  shebang, not from a Bun or npm page). `bun publish` (https://bun.com/docs/pm/cli/publish) "cannot generate
  provenance statements yet".
- **npm** (https://docs.npmjs.com/creating-and-publishing-scoped-public-packages): "By default,
  scoped packages are published with private visibility", so a public scoped package needs
  `--access public`. Provenance needs GitHub Actions' `id-token: write` and `npm publish
  --provenance` (https://docs.npmjs.com/generating-provenance-statements). npm also documents
  trusted publishing through OIDC, which the release workflow's design can weigh against a
  stored token.

Taken together: Linear has no prior art for a local client. The tools that do ship one
(Railway, Stripe, GitHub) publish a native binary through several channels and often also an
npm package. MCP hosts' own examples launch npm-published servers with `npx -y`.

## What Changes

- `tm` becomes installable with no checkout as the public npm package `@hsb3/tm`, one versioned
  artifact that runs the CLI and `tm mcp` unchanged. The install and the MCP host config fit in
  one command each (`npx -y @hsb3/tm mcp`).
- The published client runs on Node, with Bun optional (`bunx --bun`). The one Bun-only call
  (`Bun.stdin` in `tm login`) gives way to a `node:` equivalent, and the artifact is a single
  bundled file with the MCP SDK inside and a `node` shebang, so nothing installs on first use.
- No standalone binaries ship in this milestone.
- A client has one version, read by `tm --version`, reported as the MCP `serverInfo.version`, and
  sent on every request as `User-Agent: tm/<version>`. The server can then log which clients
  call it.
- Releases are cut by CI from a tag on this repository. The tag sets the version, and the
  published artifact carries npm provenance (`npm publish --provenance`, because `bun publish`
  cannot produce it).
- `clients/tm/README.md` documents installation and MCP host configs (Claude Code `claude mcp
  add`, Cursor `mcp.json`) without repository paths. It keeps the caveat that a desktop app
  does not search the shell's `PATH`, so `command` takes an absolute path to the launcher.
- The hosted MCP service keeps importing the catalog from the workspace. This change adds no
  package boundary between them.

### Client and server versions

The client's version is its own (semver, starting from `0.1.0`). It is not tied to the server's.
Until the server states a contract version on the wire (SH-5, owned by the api-versioning-policy
work), the client checks nothing at start-up. An older client meeting a newer server sees the
server's own refusals, which `tm` already passes through as exit 1 and the MCP tool error text.
Once SH-5 lands, the client can compare the server's version with the range it supports and
name the mismatch. That comparison belongs to the versioning policy, not to this change.

## Capabilities

- `tm-distribution`: how the `tm` client is published, installed, versioned and launched by an
  MCP host on a machine with no checkout.

## Open Questions

All four were ruled on 2026-11-10; the options are kept as the record of what was weighed.

1. **Where the client is published.** The channel decides who can install without a GitHub
   credential.
   - Public npm under a scope: `npx -y <scope>/tm mcp` works anywhere, as MCP hosts' own
     examples do.
   - GitHub Packages (private npm): installing needs a GitHub token in the machine's npm config,
     which breaks the one-line install and every MCP host config.
   - Release binaries on this repository only.
   - Ruled 2026-11-10: the repository goes public and the client is published to public npm.
2. **Which runtime the published client requires.**
   - Node, Bun optional: a single bundled JavaScript file with its first line rewritten to a
     `node` shebang. `npx -y` runs it wherever Node is installed, as MCP hosts' own examples
     assume; a machine with only Bun runs it with `bunx --bun`. It costs replacing the one
     `Bun.stdin` call and a post-build shebang rewrite.
   - Bun only: the package ships as it is today. Every operator has to install Bun first, and
     `npx` fails without it.
   - Ruled 2026-11-10: Node, Bun optional.
3. **Whether standalone binaries ship too.**
   - Not in this milestone: npm covers Claude Code and Cursor. Binaries are about 71 to 97 MB per
     platform. macOS signing and notarisation of a downloaded binary were not tried.
   - Yes, on a release: per-platform `bun build --compile` executables attached to the public
     repository's releases, for machines with no Node or Bun.
   - Yes, plus a Homebrew tap: `brew install` on macOS, at the cost of a tap repository to keep
     in step with each release.
   - Ruled 2026-11-10: no standalone binaries in this milestone.
4. **The package name.** Unscoped `tm` is taken on npm.
   - `@hsb3/tm`: the command stays `tm`, matching the GitHub account that owns the repository. It
     needs an npm user or organisation named `hsb3`; whether one exists or is free on npmjs.com
     is unverified.
   - A product-named scope or package (for example an organisation scope): it reads better to
     outside operators, but needs a name chosen and an npm organisation created first.
   - Ruled 2026-11-10: `@hsb3/tm`.

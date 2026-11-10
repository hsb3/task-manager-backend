# Contract

The surface here is a published package and a command line, not HTTP routes. The rulings it
implements are this change's proposal, Open Questions 1 to 4 (ruled 2026-11-10): public npm,
Node with Bun optional, no standalone binaries this milestone, the name `@hsb3/tm`. A value
marked *(Q n)* rests on this change's own open question n (design.md, Open Questions).

## Routes

### The package

| Item | Value |
| --- | --- |
| Registry | the public npm registry, `https://registry.npmjs.org` |
| Name | `@hsb3/tm` (scope `@hsb3`, owned by the npm account `hsb3`) |
| Access | public: installing needs no credential |
| Command | `tm` (the package's one `bin` entry) |
| Contents | `package.json`, `README.md`, `LICENSE` *(Q1)*, `dist/tm.js`, and nothing else |
| Runtime dependencies | none: `dist/tm.js` is self-contained, the MCP SDK inside it |
| Runtime | Node `>=22.18.0` (`engines.node`); Bun through `bunx --bun` |
| License | `MIT` *(Q1)* |
| Provenance | every version published with an npm provenance attestation |
| Version | semver, from `0.1.0`; the manifest's `version` is the only source |

### Install and launch commands (as documented in the package README)

| Purpose | Command |
| --- | --- |
| Run once, no install | `npx -y @hsb3/tm <verb> ...` |
| Install the command | `npm install -g @hsb3/tm` |
| Bun-only machine | `bunx --bun @hsb3/tm <verb> ...` |
| Save a key | `tm login --url https://tm.example.com` (browser sign-in), or `tm login --with-key --url https://tm.example.com` to paste one (key-minting-cli) |
| Claude Code, add the MCP server | `claude mcp add --transport stdio --env TM_URL=https://tm.example.com --env TM_API_KEY=tmk_... tm -- npx -y @hsb3/tm mcp` |

MCP host server entry (Cursor `mcp.json`, Claude Desktop `claude_desktop_config.json`, Claude
Code `.mcp.json`), under `mcpServers`:

```json
{
  "tm": {
    "command": "npx",
    "args": ["-y", "@hsb3/tm", "mcp"],
    "env": { "TM_URL": "https://tm.example.com", "TM_API_KEY": "tmk_..." }
  }
}
```

A desktop app does not search the shell's `PATH`: there `command` is the absolute path `which
npx` prints. On a Bun-only machine `command` is `bunx` and `args` is `["--bun", "@hsb3/tm",
"mcp"]`.

### `tm --version`

The format is api-versioning-policy's (its contract, "`tm --version`"); this change owns line 1.

```
$ tm --version
tm 0.1.0
api 0.1.0
```

- Line 1 is `tm ` plus the package version. Line 2 is `api ` plus the contract version of the
  `openapi.json` the client was generated from (`info.version`). Stdout only, nothing on
  stderr, exit 0, no network call.
- Wins over every other valid argument: `tm --version list` and `tm --help --version` print the
  same two lines. A command line `parseArgs` rejects (an unknown option, a missing option value)
  still exits 2 with the usage text, `--version` or not. It needs no saved login and no `TM_URL`
  or `TM_API_KEY`.
- No short form: `-v` stays an unknown option (exit 2, usage text).
- The usage text gains the line `  --version prints the versions of tm and of the API it was
  built for.` after the `--json` line.

## Requests and Responses

### Every HTTP request tm makes

Adds one header beside `Authorization` and `Content-Type`:

```
User-Agent: tm/<version>
```

`<version>` is the package version, line 1 of `tm --version` without `tm `. It is sent by every verb and by `tm mcp`'s
tool calls, under Node and under Bun alike.

### `tm mcp` initialize result

`serverInfo` is `{ "name": "tm", "version": "<version>" }`, the same string; it is no longer a
literal separate from the manifest. This is the `serverInfo` the hosted-mcp-endpoint contract
already names ("`version`: <tm package version>").

### A release

| Item | Value |
| --- | --- |
| Trigger | a pushed git tag `tm-v<version>` on this repository, for example `tm-v0.1.0` |
| Workflow | `.github/workflows/release-tm.yml`, job `publish`, on `ubuntu-latest` |
| Preconditions | the tagged commit is on `main`; `<version>` equals `clients/tm/package.json` `version` at that commit |
| Publish | `npm publish --provenance --access public` from `clients/tm/` |
| Credential | repository secret `NPM_TOKEN` (an npm granular access token), or npm trusted publishing once configured for the package (the workflow carries `id-token: write` for both) |

The client's version moves only in a reviewed commit that edits `clients/tm/package.json`
`version`. Semver applies to tm's own surface: verbs, flags, output fields under `--json`, exit
codes, environment variables, the config file, MCP tool names and their required inputs. A
removal or rename there is a major bump; an addition is a minor bump; a fix is a patch. While
the major is `0`, a breaking change is a minor bump. The server contract's version
(api-versioning-policy) is separate and does not move with it.

## Errors

The exit codes are unchanged: 0 ok, 1 the server refused or no usable key, 2 usage. What this
change fixes or adds:

| Case | Result |
| --- | --- |
| Server refusal under Node (the published file) | stderr `tm: <server message>`, then the error body as JSON when its `data` is not empty; exit 1; no stack trace |
| Usage error raised inside a verb under Node (for example an unknown `--kind`) | stderr `tm: <message>` and the usage text; exit 2 |
| `tm login --with-key` with a piped key under Node (key-minting-cli renames today's `tm login` to this) | as under Bun: the first line of stdin, trimmed, is the key |
| `tm login --with-key` with empty piped input | `tm: no key was pasted` and the usage text; exit 2 (unchanged) |
| Node below `engines.node` | npm prints its `EBADENGINE` warning at install; tm is not supported there and nothing in tm checks the version |
| Release tag naming another version | the release workflow fails before building; stderr `tm release: tag tm-v<x> does not name clients/tm/package.json version <y>`; nothing published |
| Release tag on a commit not on `main` | the release workflow fails before building; stderr `tm release: tm-v<x> is not on main`; nothing published |
| Version already on the registry | `npm publish` fails (npm refuses to overwrite a version); the workflow fails; nothing changes |

## Auth

| Action | Who | Credential |
| --- | --- | --- |
| Install or run `@hsb3/tm` | anyone | none |
| Read the source behind a version | anyone | none (the repository is public) |
| Publish a version | the release workflow only | `NPM_TOKEN`, or the trusted-publishing OIDC token |
| Push a `tm-v*` tag | a repository writer | GitHub write access |
| Call the tracker from tm | as today | `TM_API_KEY` or the saved login (unchanged) |

## Compatibility

- **Running from a checkout.** `bun clients/tm/tm.ts ...` keeps working, and the root
  `README.md` alias `alias tm='bun clients/tm/tm.ts'` with it. `clients/tm/tm.ts` loses its
  `#!/usr/bin/env bun` first line, so executing the file directly (`./tm.ts`) no longer works;
  the package README's "link `tm.ts` onto `PATH`" instruction is replaced in the same change. The workspace package's name changes from `tm` to
  `@hsb3/tm` and its `bin` points at `dist/tm.js`, which exists only after a build.
- **Existing configs.** The saved login (`$XDG_CONFIG_HOME/tm/config.json`), `TM_URL` and
  `TM_API_KEY` are unchanged.
- **MCP host entries that run `bun /absolute/path/to/clients/tm/tm.ts mcp`** keep working from a
  checkout; the README now documents the `npx` form.
- **The server.** Sees a `User-Agent` of `tm/<version>` where it saw the runtime's default
  (`Bun/<version>`); nothing else changes. The hosted MCP service, which imports the catalog
  from `clients/tm/src/`, sends the same header.
- **Where the key is kept.** key-minting-cli keeps the saved key in the system credential store
  under Bun and in the configuration file under Node; `TM_CREDENTIAL_STORE=file` makes both use
  the file. This change does not alter that.
- **Verbs, flags, output, exit codes, MCP tools.** Unchanged, apart from the new `--version`
  flag and the fixes under Errors.

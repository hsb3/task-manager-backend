## Purpose

How the `tm` client is published, installed, versioned and launched by an MCP host on a machine
with no checkout of this repository.

## ADDED Requirements

### Requirement: tm installs from the public npm registry with no checkout

The `tm` client SHALL be published to the public npm registry as `@hsb3/tm`, installable and
runnable by anyone without a GitHub or npm credential, on a machine that has never cloned this
repository. Installing it SHALL fetch no package other than `@hsb3/tm` itself.

#### Scenario: One-off run with npx

- **WHEN** an operator on a machine with a supported Node runs `npx -y @hsb3/tm --version` in an empty directory
- **THEN** its first output line is `tm ` and the package's version, and it exits 0

#### Scenario: Global install

- **WHEN** an operator runs `npm install -g @hsb3/tm`
- **THEN** a `tm` command is on `PATH` and `tm --help` prints the usage text and exits 0
- **AND** npm installed one package and no dependencies

### Requirement: The published client runs on Node, with Bun optional

The published client SHALL run every verb, `tm mcp` and `tm login --with-key` (typed at a
terminal or piped) under Node at or above the version its package declares in `engines.node`, and under Bun
when launched with `bunx --bun`. It SHALL behave the same under both: the same output and exit
codes, and the same files when the saved login is kept in the configuration file.

#### Scenario: A key piped into login under Node

- **WHEN** an operator runs `echo tmk_... | tm login --with-key --url https://tm.example.com` under Node
- **THEN** the key is saved to the config file with mode 600 and the command exits 0

#### Scenario: A machine with only Bun

- **WHEN** an operator with Bun and no Node runs `bunx --bun @hsb3/tm --version`
- **THEN** its first output line is `tm ` and the package's version, and it exits 0

#### Scenario: A server refusal under Node

- **WHEN** the server refuses a request from the published client running under Node
- **THEN** stderr starts with `tm: ` and the server's message, no stack trace is printed, and the command exits 1

### Requirement: An MCP host launches tm mcp from the package

An MCP host SHALL be able to launch the `tm mcp` stdio server from the published package with a
single command and no repository path, configured by `TM_URL` and `TM_API_KEY` in the host's
server entry.

#### Scenario: Claude Code adds the server

- **WHEN** an operator runs `claude mcp add --transport stdio --env TM_URL=https://tm.example.com --env TM_API_KEY=tmk_... tm -- npx -y @hsb3/tm mcp`
- **THEN** the host starts `tm mcp` and lists its tools

### Requirement: A client has one version, reported everywhere

The client SHALL have one version, the `version` of its package manifest. `tm --version` SHALL
print it on its first line, as `tm <version>`; `tm mcp` SHALL report it as `serverInfo.version`; every HTTP request the client makes
SHALL carry `User-Agent: tm/<version>`.

#### Scenario: Version from the command line

- **WHEN** an operator runs `tm --version`, with or without a saved login
- **THEN** stdout's first line is `tm <version>` and the command exits 0

#### Scenario: Version on the wire

- **WHEN** `tm` sends any request to the server
- **THEN** the request carries `User-Agent: tm/<version>` with the same version `tm --version` prints on its first line

### Requirement: Releases are cut from a tag and carry provenance

A release SHALL be published only by this repository's release workflow, from a pushed tag
`tm-v<version>` naming exactly the version in the package manifest at a commit on `main`. The
published version SHALL carry npm provenance linking it to that commit and workflow run. A tag
that names another version, or points at a commit not on `main`, SHALL publish nothing.

#### Scenario: A matching tag on main

- **WHEN** the tag `tm-v0.1.0` is pushed on a `main` commit whose package manifest says `0.1.0`
- **THEN** `@hsb3/tm@0.1.0` is published with a provenance attestation

#### Scenario: A tag naming another version

- **WHEN** the tag `tm-v0.2.0` is pushed on a commit whose package manifest says `0.1.0`
- **THEN** the release workflow fails and nothing is published

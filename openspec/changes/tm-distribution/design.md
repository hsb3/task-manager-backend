# Design

Probes behind every claim below ran on 2026-11-10 with Bun 1.4.3, npm 12.2.1 and Node 22.18.0,
24.21.0 and 26.10.0, on a scratch copy of `clients/tm/` with the changes this design names.

## Decisions

1. **The bundle is built by `Bun.build`, from a `tm.ts` with no shebang, with a `node` banner.**
   `clients/tm/build.ts` calls `Bun.build({ entrypoints: [<clients/tm/tm.ts>], target: "node",
   banner: "#!/usr/bin/env node" })` and writes the one output to `clients/tm/dist/tm.js`, mode
   755. No minify, no sourcemap, no splitting: one readable file, so a stack trace in a bug report
   names real functions.
   - Why no shebang in `tm.ts`: when the entry file starts `#!/usr/bin/env bun`, Bun 1.4.3 emits
     `// @bun` and bundles `src/api.ts` twice (two `class ApiError` definitions). Every server
     refusal then escapes `main`'s `instanceof ApiError` check as an uncaught exception with a
     stack trace, and a verb's `UsageError` exits 1 instead of 2. Probe: an entry importing
     `src/api.ts`, `src/verbs.ts` and `src/mcp.ts` gives one `ApiError` class without the bun
     shebang and two with it; the shipped `tm.ts` behaves the same. The previous wave's
     "rewrite the first line after the build" would have shipped that defect.
   - Why `Bun.build` and not `bun build` on the command line: one script owns the build, the
     banner and the file mode, and the test calls the same script.
   - Alternatives: esbuild or tsup (a new dependency for what Bun already does); a `#!/usr/bin/env
     node` shebang kept in `tm.ts` (lies: Node cannot run the TypeScript source, which fails at
     `ApiError`'s parameter property under strip-only mode).
   - The dynamic `import("./src/mcp.ts")` in `main` stays: with the bun shebang gone the bundle
     holds each module once whether the import is static or dynamic (probe), and outside a bundle
     the dynamic import still spares the other verbs the SDK's load.
2. **Pasted-key login reads piped input with `for await` over `process.stdin`.** In
   `read_secret` (`clients/tm/tm.ts`; key-minting-cli's `tm login --with-key` keeps calling it,
   its contract calling that verb "today's `tm login`"), it replaces `Bun.stdin.text()`, the one
   Bun-only call on 2026-11-10 (`git grep -n "Bun\." clients/tm` finds only it).
   It reads the whole input to its end, then keeps the first line trimmed, exactly as before.
   Probe: piped login under Node 22.18.0, 24.21.0, 26.10.0 and `bun --bun` saved the key with
   mode 600; empty input exited 2 with "no key was pasted". `fs.readFileSync(0)` was rejected: a
   test harness's stdin is a socket, where a synchronous read can fail with `EAGAIN`.
3. **The version lives in `clients/tm/package.json` `version` alone**, read through
   `clients/tm/src/version.ts` (`import pkg from "../package.json" with { type: "json" }`). Bun
   inlines the manifest into the bundle (probe: `package_default` in `dist/tm.js`), and `tsc`
   with the repository's `tsconfig.json` (`module: Preserve`, `moduleResolution: bundler`)
   accepts the import (probe: `tsc --noEmit` exit 0). `tm --version` line 1,
   `serverInfo.version` and `User-Agent` all read `VERSION` from it.
   - `tm --version` prints two lines, `tm <VERSION>` and `api <API_VERSION>`. This change
     defines the flag (root ruling 3, 2026-11-10); api-versioning-policy, built last, adopts it
     and owns only the value of line 2. `API_VERSION` is a constant `scripts/gen_tm_client.ts` writes into
     `clients/tm/src/api.generated.ts` from `openapi.json` `info.version`, so it is the version of
     the contract the client's types were generated from, and `gen_tm_client.ts --check` (already
     in `make check-static`) keeps it in step.
   - Alternative: `--define` a constant at build time. Rejected: a run from the checkout would
     need a second source.
   - The release tag must equal this version (Decision 7), so a tag cannot publish a version the
     tree does not state. The proposal's "the tag sets the version" is met as "the tag selects
     the version the tree already states": a checkout's `tm --version` then never disagrees with
     what was published from it.
   - First published version: `0.1.0` (nothing has been published; the manifest already says
     `0.1.0`).
4. **`User-Agent: tm/<version>`** is set in `request` (`clients/tm/src/api.ts`), the one function
   every verb goes through. Node's `fetch` and Bun's `fetch` both send the header as set (probe:
   an echo server saw `tm/0.1.0` under all three Node versions and Bun; Bun's default is
   `Bun/1.4.3`). Prior art: npm sends `npm/<version> node/<version> ...`, GitHub asks for a
   product name in `User-Agent`. The product token alone is enough for the server to tell
   clients apart; runtime and platform are left out because they are not needed.
5. **Package manifest** (`clients/tm/package.json`), exactly:

   ```json
   {
     "name": "@hsb3/tm",
     "version": "0.1.0",
     "description": "Command-line client and MCP server for the task tracker: list, show, search, create, edit and comment on items with an API key.",
     "license": "MIT",
     "type": "module",
     "bin": {
       "tm": "dist/tm.js"
     },
     "files": [
       "dist/tm.js"
     ],
     "engines": {
       "node": ">=22.18.0"
     },
     "repository": {
       "type": "git",
       "url": "git+https://github.com/hsb3/task-manager-backend.git",
       "directory": "clients/tm"
     },
     "scripts": {
       "generate": "bun ../../scripts/gen_tm_client.ts",
       "build": "bun build.ts"
     },
     "devDependencies": {
       "@modelcontextprotocol/server": "2.4.0"
     }
   }
   ```

   - `"private": true` is removed: npm refuses to publish a private package.
   - The SDK (`@modelcontextprotocol/server` 2.4.0, which hosted-mcp-endpoint Phase 5 put under
     `dependencies`) moves to `devDependencies`: Bun still installs a workspace member's
     `devDependencies` (probe: `bun install` put it in `clients/tm/node_modules`), the hosted
     service's image runs a full `bun install --frozen-lockfile` (hosted design, Phase 8), and
     the bundle carries the SDK, so an install fetches nothing
     else (probe: `npm install --offline <tarball>` into an empty directory, "added 1 package").
   - `files` lists only the bundle; npm adds `package.json`, `README.md` and `LICENSE` itself
     (probe: `npm pack` gave exactly `README.md`, `dist/tm.js`, `package.json` before the
     `LICENSE` existed, with `clients/tm/dist/` in the root `.gitignore`).
   - `repository.url` must match the publishing repository for provenance
     (https://docs.npmjs.com/generating-provenance-statements: "Ensure your package.json is
     configured with a public repository that matches (case-sensitive) where you are publishing
     with provenance from"). The repository is public (`gh repo view hsb3/task-manager-backend
     --json visibility`: `"PUBLIC"`).
   - `engines.node` `>=22.18.0`: Node 22 is the oldest Node line still maintained, and 22.18.0 is
     the oldest Node the bundle was proven on. CI runs the package suite on exactly that version
     (Phase 2), so the floor stays proven. The SDK itself asks `>=20` (`engines` of
     `@modelcontextprotocol/server` 2.4.0).
   - `license` `MIT` and a `clients/tm/LICENSE` file.
   - No `publishConfig`: the release workflow passes `--provenance --access public`, and a
     scoped package without `--access public` is published restricted
     (https://docs.npmjs.com/creating-and-publishing-scoped-public-packages: "By default, scoped
     packages are published with private visibility").
6. **The scope is the owner's.** `https://registry.npmjs.org/-/user/hsb3/package` answers 200
   with five `@hsb3/...` packages (`@hsb3/keel-ui` and others), and
   `https://registry.npmjs.org/-/org/hsb3/user` answers `{"hsb3":"owner"}`; an unknown scope
   answers 404 `{"error":"Scope not found"}`. `@hsb3/keel-ui`'s maintainer is `hsb3` and its
   repository is under `github.com/hsb3`. `https://registry.npmjs.org/@hsb3%2ftm` answers 404: the
   name is free. On the owner's machine `~/.npmrc` maps `@hsb3:registry` to GitHub Packages, so a
   bare `npm view @hsb3/tm` there asks GitHub, not npmjs; every runbook command below passes
   `--registry https://registry.npmjs.org`. No
   scope has to be created; publishing needs only a token from the `hsb3` npm account (runbook).
7. **Release workflow `.github/workflows/release-tm.yml`**, triggered by a pushed tag matching
   `tm-v*`. The `tm-v` prefix keeps client tags apart from any contract release
   (api-versioning-policy keeps the contract version in `openapi.json`; the two versions are
   separate). Full file in Phase 3. It refuses a tag off `main` or naming another version, builds
   with Bun 1.4.3, and publishes with `npm publish --provenance --access public`.
   - npm, not `bun publish`: "`bun publish` cannot generate provenance statements yet"
     (https://bun.com/docs/pm/cli/publish, quoted in the proposal).
   - Credential: repository secret `NPM_TOKEN`, a granular access token of the `hsb3` npm account
     with "Read and write (publish and stage)" on the `@hsb3` scope and "Bypass two-factor
     authentication" checked (https://docs.npmjs.com/creating-and-viewing-access-tokens).
     Trusted publishing (OIDC) needs no stored secret but cannot be set up first: "Package must
     exist: The package you're configuring must already exist on the npm registry"
     (https://docs.npmjs.com/cli/v11/commands/npm-trust). The workflow therefore grants
     `id-token: write` and runs npm 11.19.0 (Node 24.21.0), so that after the first publish
     trusted publishing can replace the token with no workflow edit: "The npm CLI automatically
     detects OIDC environments and uses them for authentication before falling back to
     traditional tokens", which needs "npm CLI version 11.5.1 or later and Node version 22.14.0
     or higher" (https://docs.npmjs.com/trusted-publishers). The switch is a runbook step.
   - The workflow runs no tests: a tag is pushed only on a `main` commit whose CI was green
     (runbook), and that CI ran the package suite on the same tree.
8. **The package test installs the packed tarball into an empty directory and runs it under the
   `node` on `PATH` and under Bun** (`tests/test_tm_package.ts`, Phase 2). It boots a room for
   real calls and a local echo server to read the `User-Agent`. CI pins that `node` to 22.18.0
   with `actions/setup-node@v6` in the `battery` and `smoke` jobs
   (https://docs.npmjs.com/trusted-publishers shows `actions/setup-node@v6`). Locally the suite
   runs with whatever `node` is on `PATH` and fails, naming the version it found, if that does
   not satisfy `engines.node`. `mise.toml` deliberately gains no `node` pin: the repository's own
   tools run on Bun, and a pin would move every checkout's Node for one suite.
9. **README** (`clients/tm/README.md`) is rewritten around the published package: install,
   login, the MCP host entries from the contract, and the Bun-only form. It is the package's
   page on npmjs.com, so its one relative link (`../../e2e/README.md#rate-limits`) becomes
   `https://github.com/hsb3/task-manager-backend/blob/main/e2e/README.md#rate-limits`. A
   "From a checkout" section keeps `bun clients/tm/tm.ts` for development.
10. **Prior art.** Linear ships no local client (proposal, Prior art); the MCP hosts' own
    examples launch npm-published servers with `npx -y <package>`
    (https://code.claude.com/docs/en/mcp, https://cursor.com/docs/context/mcp), which is the
    form the contract documents. `npx -y @hsb3/tm` runs the `tm` bin because "If the package has
    a single entry in its bin field in package.json ... then that command will be used"
    (https://docs.npmjs.com/cli/v11/commands/npx); probe: `npx -y file:<tarball> --version`
    printed `0.1.0` under Node 22.18.0. Railway's npm route requires Node 16 or higher
    (proposal); this package asks 22.18.0, the oldest maintained line it was proven on.
11. **Dependencies added: none.** `actions/setup-node@v6` is a CI action, not a package.

## Depends on

- Build order (root ruling 1, 2026-11-10): hosted-mcp-endpoint (Phases 1-9 and its runbook),
  then key-scoping (every phase), then key-minting-cli, then **this change**, then
  agent-verb-coverage, then api-versioning-policy. Every change before this one is on `main`
  when Phase 1 starts.

- Changes earlier in the build order, on `main` before this one is built:
  - `hosted-mcp-endpoint` (contract `c89336a`, design read at lane/d-mcp `9d4b060`). What this design
    builds on, by its decision and phase:
    - D1 and D11, Phase 5: `clients/tm` is on `@modelcontextprotocol/server` 2.4.0 (exact pin);
      `clients/tm/src/mcp.ts` exports `TOOLS`, `tools_for`, `error_result`, `call`,
      `make_server`, `serve`, `VERSION` and SDK re-exports; `make_server` already builds
      `new Server({ name: "tm", version: VERSION }, ...)`; `tm mcp`'s `tools/list` reads the key's
      scope from `GET /api/tracker/me`; `Config` gains `headers` and `request()` sends
      `{ ...cfg.headers, Authorization: cfg.key, "Content-Type": "application/json" }`. Its
      `VERSION` is read with `readFileSync(new URL("../package.json", import.meta.url))`; Phase 1
      below replaces that definition with a re-export of `version.ts`'s, keeping the export name.
    - D1 and Phase 8: the service imports the catalog by relative path
      (`../../../clients/tm/src/mcp.ts`), has no manifest of its own, and its image copies
      `clients/tm/package.json` and runs a full `bun install --frozen-lockfile` (not
      `--production`). So `version.ts`'s import of `../package.json` resolves in the image, and
      moving the SDK to `devDependencies` (Phase 2) keeps it installed there.
    - Phase 5's `tests/test_tm_mcp.ts` case `server_info` already checks `serverInfo` against
      the manifest's version; this design adds no `test_tm_mcp.ts` case.
    - Bundling with SDK 2.4.0 was probed (re-check, 2026-11-10): a scratch copy with D11's
      module (imports, re-exports, `make_server`, `tools_for`, the `ProtocolError` unknown-tool
      throw) built through Phase 2's `build.ts` into one 877 KB file holding one `ApiError` class;
      `npm pack` held the same three files; the offline install added one package; under Node
      22.18.0, Node 26.10.0 and `bun --bun`, `tm mcp` answered `initialize` with
      `{"name":"tm","version":"0.1.0"}`, listed the six tools, ran `tm_list` (`isError` false)
      and `tm_show` of a missing id (`isError` true), and exited 0 at end of input.
    - `serve` waits for end of input before it returns (hosted design D1 and Phase 5 at lane/d-mcp
      `9d4b060`, test `stdio_serves_until_eof`), so `tm mcp` stays up under `tm.ts`'s
      `process.exit`.
    - Check before Phase 2 changes `clients/tm/package.json`: `git grep -n -e 'from "tm/' -e
      "from 'tm/" -e '--production' -e '--omit=dev' -- ':!clients/tm/' ':!openspec/'`; any hit
      (an import by the old workspace name `tm`, or an install that drops `devDependencies`)
      stops the phase and is reported to root.
  - `key-minting-cli` (contract and design read at lane/d-minting `b205abc`): today's `tm login`
    becomes `tm login --with-key`, still reading a pasted key; `tm login` opens a browser. This
    design's tests use `login --with-key`. Under Node the key is kept in the private file, with
    no native keyring package (owner ruling, key-minting-cli Q2). Its design reaches the
    credential store as `(globalThis as any).Bun?.secrets`, which is `undefined` under Node; its
    sign-in callback must be served with `node:http`, not `Bun.serve`. Phase 1's gate lists every
    `Bun.` and `Bun?.` hit. An unguarded hit, or a
    `Bun.serve` callback server, is not fixed in this change: the phase stops and the builder
    reports the file and line to root (a Node replacement there is key-minting-cli's design,
    not this one's). Phase 2's cases 12b to 12d run that change's verbs under Node.
  - `key-scoping` (contract read at lane/d-scoping `0d3232c`): `tools/list` lists only read
    tools for a `read` key and every tool for any other key; the package suite's MCP case uses a
    `write` key and compares with `tools_for("write")`. A hand-minted key's reach is `all`.
  - `api-versioning-policy` (lane/d-versioning `47c6452`) is built after this change, last of the
    milestone (root ruling 1). It finds `API_VERSION`, the two `--version` lines, `VERSION` and
    the `package.json` import already present and keeps them.
  - `agent-verb-coverage` (lane/d-verbs `a3f72ee`) is built after this change; it adds verbs and
    inherits the Node rule and the package suite.
- This change is built before api-versioning-policy, so it cuts no API release and edits no
  `api/` file or `mcp-tools.json`. If `scripts/release_api.ts` exists when a phase starts, the
  build order was changed: stop and report.
- Shared files this change edits that another milestone change also edits: `clients/tm/tm.ts`,
  `clients/tm/src/api.ts`, `clients/tm/src/mcp.ts`, `clients/tm/package.json`,
  `clients/tm/README.md`, `bun.lock`, `tests/test_tm_cli.ts`,
  `scripts/run_suite_battery.sh`, `scripts/battery_shards.tsv`, `.agents/rules/ports.md`,
  `.github/workflows/ci.yml`, `e2e/smoke.ts`, `docs/readiness/agent-clients.md`. Every step
  below names its edit by function or anchor text, not by line number.

## Implementation Plan

### Phase 1: the source runs under Node and reports one version

- **Goal:** `tm` has one version, printed by `--version`, sent as `User-Agent` and reported as
  `serverInfo.version`, and its source has no Bun-only call (contract: `tm --version`, Requests
  and Responses; AC-8 groundwork).
- **Files:**
  - create `clients/tm/src/version.ts`
  - modify `clients/tm/tm.ts`
  - modify `clients/tm/src/api.ts`
  - modify `clients/tm/src/mcp.ts`
  - modify `scripts/gen_tm_client.ts`
  - modify `clients/tm/src/api.generated.ts` (regenerated: `bun scripts/gen_tm_client.ts`)
  - modify `clients/tm/README.md`
  - modify `tests/test_tm_cli.ts`
  - modify `tests/test_tm_client_gen.ts`
- **Steps:**
  - `clients/tm/src/version.ts`, whole file:

    ```ts
    // The client's one version: package.json's, inlined into dist/tm.js by the build.
    import pkg from "../package.json" with { type: "json" };

    export const VERSION: string = pkg.version;
    ```
  - `clients/tm/tm.ts`:
    - Delete the first line, `#!/usr/bin/env bun` (Decision 1). The file then starts with its
      `// tm — the task tracker ...` comment.
    - Add `import { VERSION } from "./src/version.ts";` after the `./src/api.ts` import block.
    - In `OPTIONS`, after `help`, add `version: { type: "boolean", default: false },` (no
      `short`).
    - Add `import { API_VERSION } from "./src/api.generated.ts";` after the `VERSION` import.
    - In `HELP`, after the line `  --json prints the server's answer as JSON; errors go to stderr
      and exit 1.`, add the line `  --version prints the versions of tm and of the API it was
      built for.` (one line in the file; wrapped here). If that `--json` line is no longer in
      `HELP` (key-minting-cli rewrote it), add the new line as the last line of `HELP`.
    - In `main`, directly after the `parseArgs` try/catch and the `const { values: v,
      positionals } = parsed;` line, before the help check, add:

      ```ts
      if (v.version) {
        console.log(`tm ${VERSION}\napi ${API_VERSION}`);
        return 0;
      }
      ```

    - In `read_secret`, replace the line
      `if (!process.stdin.isTTY) return (await Bun.stdin.text()).split("\n")[0].trim();` with:

      ```ts
      if (!process.stdin.isTTY) {
        let piped = "";
        for await (const chunk of process.stdin) piped += chunk.toString();
        return piped.split("\n")[0].trim();
      }
      ```
  - `clients/tm/src/api.ts`: add `import { VERSION } from "./version.ts";` after the
    `api.generated.ts` type import. In `request`, the `fetch` call's `headers` (hosted-mcp-endpoint
    D11's merge) becomes `{ "User-Agent": `tm/${VERSION}`, ...cfg.headers, Authorization:
    cfg.key, "Content-Type": "application/json" }`: `User-Agent` first, so a caller that sets
    `cfg.headers` (only the MCP service does, for its exemption secret) could replace it.
  - Every other request site gets the same header: `git grep -n "fetch(" -- clients/tm` lists
    them (on 2026-11-10 only `request`; key-minting-cli adds sign-in calls). Each hit outside
    `request` adds `"User-Agent": \`tm/${VERSION}\`` to its `headers` object (creating `headers`
    when the call has none), importing `VERSION` from `version.ts` by the file's relative path; its
    file joins Phase 1's allowlist. A request made by any means other than `fetch` stops the phase
    and is reported to root.
  - `clients/tm/README.md`, "Set up once": replace the sentence "To call it as plain `tm`, link
    `clients/tm/tm.ts` into a directory on `PATH` once." with "To call it as plain `tm`, add
    `alias tm='bun /absolute/path/to/clients/tm/tm.ts'` to the shell's startup file." (the file
    loses its shebang, so a link to it no longer runs). If the sentence is absent, no edit:
    Phase 3 rewrites the section.
  - `clients/tm/src/mcp.ts`: delete hosted-mcp-endpoint's `VERSION` definition (the
    `readFileSync(new URL("../package.json", import.meta.url))` read, and its `node:fs` import if
    nothing else uses it) and add `export { VERSION } from "./version.ts";` plus `import {
    VERSION } from "./version.ts";` after the `./verbs.ts` import. `make_server`'s
    `new Server({ name: "tm", version: VERSION }, ...)` is unchanged.
  - `scripts/gen_tm_client.ts`, in `render(spec)`: after the two header entries of `out` (the
    `// GENERATED ...` line and `""`), push
    `` `export const API_VERSION = ${JSON.stringify(String(spec.info?.version ?? ""))};` `` and
    `""`. Then run `bun scripts/gen_tm_client.ts` to regenerate `clients/tm/src/api.generated.ts`.
  - Run `bunx prettier --write clients/tm/tm.ts clients/tm/src/version.ts clients/tm/src/api.ts
    clients/tm/src/mcp.ts scripts/gen_tm_client.ts tests/test_tm_cli.ts
    tests/test_tm_client_gen.ts` (`api.generated.ts` is already formatted by its generator).
- **Tests:**
  - `tests/test_tm_cli.ts`, a new section `── tm --version: the package version, no login
    needed ──` placed before the "login at a terminal" section, reading the expected value with
    `JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "clients", "tm", "package.json"),
    "utf8")).version` as `PKG_VERSION`, and `JSON.parse(fs.readFileSync(path.join(REPO_ROOT,
    "openapi.json"), "utf8")).info.version` as `API_VERSION`; `WANT` is
    `` `tm ${PKG_VERSION}\napi ${API_VERSION}\n` ``. Every run uses the existing `tm()` helper
    with `NOWHERE` (the suite's env with no key and no URL):
    - `tm(["--version"], NOWHERE)` → `code` 0, `stdout` `WANT`, `stderr` `""`. Watch it fail
      before the code exists: it exits 2 with `Unknown option '--version'`.
    - `tm(["--version", "list"], NOWHERE)` → 0, `WANT`.
    - `tm(["--help", "--version"], NOWHERE)` → 0, `WANT`.
    - `tm(["-v"], NOWHERE)` → 2, `stderr` includes `usage: tm`.
    - `tm(["--version", "--bogus"], NOWHERE)` → 2, `stderr` includes `usage: tm` (a rejected
      command line wins over `--version`).
    - `tm(["--help"], NOWHERE)` → 0, `stdout` includes `--version prints the versions of tm and
      of the API it was built for.`
  - `tests/test_tm_mcp.ts` is not edited: hosted-mcp-endpoint's `server_info` case already
    compares `serverInfo.version` with the manifest. With the manifest's `version` set to `0.1.1`
    locally, `server_info` and the `--version` cases still pass (both read the one source);
    restore `0.1.0`.
  - The `User-Agent` and the piped login under Node are proven in Phase 2's suite (they need a
    Node runtime and an echo server). The existing piped-login checks in `tests/test_tm_cli.ts`
    (after key-minting-cli they run `login --with-key`) must stay green under Bun with the new
    `read_secret`.
  - `tests/test_tm_client_gen.ts` keeps proving `api.generated.ts` equals `generate()`, now
    including `API_VERSION`. Its `tsc_verbs(dir, generated)` copies `api.ts` and `verbs.ts` into
    a scratch dir and type-checks `verbs.ts`; `api.ts` now imports `./version.ts`, which imports
    `../package.json`. Change its copy loop to `["api.ts", "verbs.ts", "version.ts"]` and add
    `fs.copyFileSync(path.join(SRC, "..", "package.json"), path.join(dir, "..",
    "package.json"));` after it. Without this edit its check `tsc --noEmit verbs.ts against the
    committed client exits 0` fails with `TS2307: Cannot find module './version.ts'` (truth
    review probe).
  - `tests/test_tm_cli.ts`, the "login at a terminal" self-check: it copies `src/` and a patched
    `tm.ts` into `NO_RAW`; `src/version.ts` then cannot find `../package.json` and the self-check
    fails (`Cannot find module '../package.json'`, truth review probe). After its
    `copy_tree(path.join(path.dirname(TM), "src"), path.join(NO_RAW, "src"));` line add
    `fs.copyFileSync(path.join(path.dirname(TM), "package.json"), path.join(NO_RAW,
    "package.json"));`.
- **Gate:**
  - `git grep -n -e "Bun\." -e "Bun?\." -e "import.meta.dir" -e "import.meta.path" -e '"bun:' --
    clients/tm ':!clients/tm/build.ts'` prints no `Bun.stdin` line, and every line it prints is
    either an optional-chain read `Bun?.` whose `undefined` result the code handles (as
    key-minting-cli's `Bun?.secrets`) or inside a `typeof Bun !== "undefined"` branch (after key-minting-cli it
    prints only that change's `Bun?.secrets` reads).
  - `bun scripts/gen_tm_client.ts --check` exit 0.
  - `PB_PORT_OFFSET=<offset> bun tests/test_tm_cli.ts` exit 0.
  - `PB_PORT_OFFSET=<offset> bun tests/test_tm_mcp.ts` exit 0.
  - `make check-static` exit 0.

### Phase 2: the package, its build, and the clean-directory test

- **Goal:** `clients/tm` builds into one Node-runnable file and packs into `@hsb3/tm` with
  exactly the contract's contents; a suite installs the tarball in an empty directory and runs
  it under Node and Bun (contract: The package; Errors rows 1 to 4; AC-8).
- **Files:**
  - create `clients/tm/build.ts`
  - create `clients/tm/LICENSE`
  - modify `clients/tm/package.json`
  - modify `bun.lock` (regenerated by `bun install`)
  - modify `.gitignore`
  - create `tests/test_tm_package.ts`
  - modify `scripts/run_suite_battery.sh`
  - modify `scripts/battery_shards.tsv`
  - modify `.agents/rules/ports.md`
  - modify `.github/workflows/ci.yml`
- **Steps:**
  - `clients/tm/build.ts`, whole file:

    ```ts
    // Builds dist/tm.js (or --outfile PATH): tm.ts and the MCP SDK in one file Node runs.
    import fs from "node:fs";
    import path from "node:path";

    const i = process.argv.indexOf("--outfile");
    if (i > 0 && !process.argv[i + 1]) {
      console.error("usage: build.ts [--outfile PATH]");
      process.exit(2);
    }
    const out = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(import.meta.dir, "dist", "tm.js");
    const built = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "tm.ts")],
      target: "node",
      banner: "#!/usr/bin/env node",
    });
    if (!built.success) {
      for (const log of built.logs) console.error(log);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await built.outputs[0].text(), { mode: 0o755 });
    fs.chmodSync(out, 0o755); // `mode` above applies only when the file is created
    console.log(out);
    ```

    `tm.ts` must not start with a `#!` line (Decision 1); the suite's refusal case catches a
    regression.
  - `clients/tm/LICENSE`: the MIT License text from https://opensource.org/license/mit, with
    the line `Copyright (c) 2026 hsb3`.
  - `clients/tm/package.json`: replace the whole file with Decision 5's manifest.
  - `bun.lock`: run `bun install` at the repository root; the lockfile's workspace entry
    becomes `@hsb3/tm` with `devDependencies` and `bin` `dist/tm.js`, and the `packages` entry
    `"tm": ["tm@workspace:clients/tm"]` becomes `"@hsb3/tm": ["@hsb3/tm@workspace:clients/tm"]`
    (probe). CI's `bun install --frozen-lockfile` then passes.
  - `.gitignore`: in the "Installed and downloaded artifacts" block, add the line
    `clients/tm/dist/` after `battery-manifests/`, and extend that block's comment to end
    "..., CI's battery shard manifests, the tm bundle."
  - `scripts/run_suite_battery.sh`: add `run_suite "test_tm_package" bun
    tests/test_tm_package.ts` as a new line directly after the file's last `run_suite` line.
  - `scripts/battery_shards.tsv`: one row `<shard>\t<seconds>\ttest_tm_package`, with the
    seconds measured locally by `time bun tests/test_tm_package.ts` rounded up (the CI medians
    the file's header names replace it at the next shard rebalance), on the lightest shard by
    the file's own rule (sum of the seconds column per shard; on 2026-11-10 shard 3, 266 s),
    placed in the file's seconds-descending order.
  - `.agents/rules/ports.md` (8230-8239 is the band root reserved for this change's suites in
    the 2026-11-10 design wave, so sibling changes take other numbers): insert `· 8230/8231 = test_tm_package` (8230 its room, 8231 its
    echo server) in ascending port order among the suite defaults: after the last entry whose
    port is below 8230, before the next entry (at the latest before `9700 = test_script_help`).
  - Run `bunx prettier --write clients/tm/build.ts tests/test_tm_package.ts` before the gate.
  - `.github/workflows/ci.yml`: in the `battery` job and in the `smoke` job, if the job has no
    `actions/setup-node` step yet (key-minting-cli may have added one to `battery`), add directly
    after its `oven-sh/setup-bun@v2` step; if it has one, set its `node-version` to `"22.18.0"`:

    ```yaml
          # The oldest Node the tm package supports (clients/tm/package.json engines.node).
          - uses: actions/setup-node@v6
            with:
              node-version: "22.18.0"
    ```

    and in the `smoke` job only, after that new step, add (Phase 3's probe builds the bundle,
    which needs the MCP SDK installed; the job installs nothing today):

    ```yaml
          - name: Install dependencies
            run: bun install --frozen-lockfile
    ```
- **Tests:** `tests/test_tm_package.ts`, a self-booting suite in the style of
  `tests/test_tm_cli.ts` (its `check`, `api` and `tm` helpers, `roomkit.serve`/`roomkit.stop`,
  `roomkit.hooks_dir`, `copy_tree` from `scripts/_scratch_copy.ts`, `run_checked`/`py_repr`/
  `tup` from `scripts/_py.ts`; the `*superuser_mfa.js` migration removed from the scratch copy;
  `superuser upsert` before `serve`). Ports: `ROOM = 8230 + PORT_OFFSET`, `ECHO = 8231 +
  PORT_OFFSET`, `PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0")`. Header
  comment: one line of purpose plus `Ports 8230 (room) and 8231 (echo) + PB_PORT_OFFSET.`
  Scratch `S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tm-package-test-"))`, removed in
  `finally`. `PKG = JSON.parse(<clients/tm/package.json>)`; `API_VERSION` from `openapi.json`
  `info.version`. `NODE` is the real Node binary, the trimmed stdout of `node -p
  process.execPath` (never `Bun.which("node")`, which can be a version-manager shim); `NODE_DIR =
  path.dirname(NODE)`. If `Bun.which("node")` is null, the `node -p` spawn throws or exits non-zero,
  or `<NODE_DIR>/npm` does not exist, the suite prints `node and npm must be on PATH` and exits
  1, never skips. Every `npm`, `npx` and build subprocess runs with env `{ PATH:
  \`${NODE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin\`, HOME: S, npm_config_cache:
  \`${S}/npm-cache\`, npm_config_update_notifier: "false" }`, so the `npm` used is the one that
  ships with `NODE` (npm 10.9.3 with Node 22.18.0; the offline install and the `file:` npx run
  were probed with it). `npm`, `npx`, `node -p` and the build run through `Bun.spawnSync` with
  `stdout: "pipe", stderr: "pipe"` (output read from the result). Runtime cases use an async
  `run(R, args, env, stdin?)` written as `tests/test_tm_cli.ts`'s `tm()` (`Bun.spawn`, both
  pipes read with `new Response(...).text()`, a 15 s kill timer). Every comparison of objects is
  `Bun.deepEquals(got, want, true)` through `check`.
  - Fixtures as `tests/test_tm_cli.ts` builds them: Alice (verified, approved), her provisioned
    project, a write key `WRITE_KEY` minted through `POST /api/collections/api_keys/records`.
  - Runtime and pack (each a `check`):
    1. `node satisfies engines.node`: `Bun.semver.satisfies(<"node --version" without the v>,
       PKG.engines.node)` → `true`; print the version.
    2. `build exits 0`: `[process.execPath, <REPO_ROOT>/clients/tm/build.ts, "--outfile",
       <S>/pkg/dist/tm.js]` → exit 0, after `fs.copyFileSync` of `clients/tm/package.json`,
       `clients/tm/README.md` and `clients/tm/LICENSE` into `<S>/pkg/`.
    3. `the bundle is executable and starts with the node shebang`: mode `& 0o111` non-zero, first
       line `#!/usr/bin/env node`.
    4. `npm pack lists exactly the contract's files`: `npm pack --pack-destination <S>` in
       `<S>/pkg` → exit 0; `tar -tzf <S>/<the .tgz>` sorted equals `["package/LICENSE",
       "package/README.md", "package/dist/tm.js", "package/package.json"]`. The tarball is
       `<S>/hsb3-tm-${PKG.version}.tgz` (npm's name for a scoped package).
    5. `the tarball installs offline into an empty directory`: `<S>/clean/package.json` is
       `{"private":true}`; `npm install --offline --no-audit --no-fund <tgz>` there → exit 0;
       `<S>/clean/node_modules` holds only `.bin`, `@hsb3` and npm's `.package-lock.json`;
       `<S>/clean/node_modules/.bin/tm` exists.
  - Per runtime (every case below runs with `TM_CREDENTIAL_STORE=file` in its env, so neither
    runtime touches a system credential store), with `BIN = <S>/clean/node_modules/.bin/tm` and `R` each of
    `[NODE, BIN]` (label `node`) and `[process.execPath, "--bun", BIN]` (label `bun`); each run
    has `cwd` `<S>/clean`, `HOME` `<S>`, `XDG_CONFIG_HOME` `<S>/xdg-<label>`, `TM_URL` and
    `TM_API_KEY` removed from the inherited env unless the case sets them, stdin `"ignore"`
    unless given, a 15 s kill timer:
    6. `<label>: --version` → exit 0, stdout `tm ${PKG.version}\napi ${API_VERSION}\n`
       (`API_VERSION` read from `openapi.json` `info.version` as in Phase 1).
    7. `<label>: --help` → exit 0, stdout starts `usage: tm`.
    8. `<label>: piped login saves the key` → env `TM_CREDENTIAL_STORE=file` (both runtimes
       then keep the key in the file; it also keeps the test off the system keychain), `login
       --with-key --url <room URL>` with stdin
       `${WRITE_KEY}\n` → exit 0; `<xdg>/tm/config.json` deep-equals `{url: <room URL>,
       key: WRITE_KEY}`, mode `600`. Under node this is the case to watch fail before Phase 1's
       `read_secret` change (it fails at `Bun.stdin`).
    9. `<label>: empty piped login` → `login --with-key` with stdin `""` → exit 2, stderr
       includes `no key was pasted`.
    10. `<label>: list --json against the room` → `list --json` with `TM_URL` the room and
        `TM_API_KEY` `WRITE_KEY` → exit 0, stdout parses to an array.
    11. `<label>: a refusal prints tm: and the message, no stack` → `show zzzzzzzzzzzzzzz` with
        the write key → exit 1; stderr's first line `tm: no item zzzzzzzzzzzzzzz that you can
        read`; stderr does not match `/\n\s+at /`. Watch it fail first: put `#!/usr/bin/env bun` back as `tm.ts`'s first
        line and delete the `banner` line from `build.ts`, build, then replace the bundle's first
        line `#!/usr/bin/env bun` with `#!/usr/bin/env node` by hand (keeping the build's own
        banner would give two `#!` lines and a `SyntaxError` instead); this case then fails with
        an uncaught `ApiError2` stack. Restore both files.
    12. `<label>: a usage error inside a verb exits 2` → `list --kind bogus` with the write key
        → exit 2; stderr's first line `tm: unknown kind "bogus"; one of task, document,
        decision, milestone`.
    12a. `<label>: create, edit, comment and search under the runtime` (write key, room URL):
        `create "pkg <label> task" --project <PROJECT> --json` → exit 0, JSON `kind` `task`,
        `title` `pkg <label> task`; with its `id` as `ID`, `edit ID --title "pkg <label> edited"
        --json` → exit 0, `title` `pkg <label> edited`; `comment ID "pkg <label> note" --json` →
        exit 0, `body` `pkg <label> note`; `search "pkg <label> edited" --json` → exit 0,
        `results` holds an entry with `id` `ID`.
    12b. `<label>: browser login reaches the server under the runtime` → `login --no-browser
        --url http://127.0.0.1:<ECHO>` (the echo server below answers 404 to its metadata
        request) → exit 1, stderr's first line `tm: http://127.0.0.1:<ECHO> does not offer
        browser sign-in; use tm login --with-key` (key-minting-cli contract, `tm` refusals);
        every `user-agent` the echo server recorded during 12b (at least one) equals
        `tm/${PKG.version}`.
    12c. `<label>: keys list with a key that cannot manage keys` → `keys list` with the write key
        and room URL → exit 1, stderr's first line `tm: this key cannot list or revoke keys;
        run tm login to get one that can` (key-minting-cli contract, `tm` refusals, for 403
        `api_key_manage`). This pins key-minting-cli's design as read at `b205abc` (its key
        routes refuse a key whose reach is `all` and whose `manage_keys` is false; root ruling
        5 changes only limited keys, which may list themselves).
    12d. `<label>: logout removes the saved login` → mint a fresh key for this case only,
        `LOGOUT_KEY` (Alice, `POST /api/collections/api_keys/records` with `name` `logout
        <label>`, `scope` `write`), so `WRITE_KEY` survives whatever logout does; with
        `TM_CREDENTIAL_STORE=file` and `XDG_CONFIG_HOME` `<S>/xdg-logout-<label>`, run `login
        --with-key --url <room URL>` with stdin `${LOGOUT_KEY}\n` (exit 0), then `logout --json`
        → exit 0; stdout JSON has `url` `<room URL>`, `key_id` `LOGOUT_KEY`'s record id and a boolean
        `revoked` equal to that record's `revoked` field read afterwards by Alice through
        `GET /api/collections/api_keys/records/<id>` (whether a key without `manage_keys` may
        revoke itself is key-minting-cli's rule; this case checks only that `tm` reports what the
        server did); `<xdg>/tm/config.json` is absent or its JSON has no `key`.
    13. `<label>: User-Agent is tm/<version>` → `show abc` with `TM_URL`
        `http://127.0.0.1:<ECHO>` and `TM_API_KEY` `WRITE_KEY`, where the echo server
        (`Bun.serve` on `127.0.0.1:<ECHO>` after `await roomkit.require_free_port(ECHO)`,
        stopped in `finally`) records `user-agent` and answers `404` with
        `{"status":404,"message":"nope","data":{}}` → every `user-agent` the echo server
        recorded during this run (at least one) equals `tm/${PKG.version}`; exit 1. The echo
        server is started before case 6 so 12b can use it; its record is cleared before 12b and
        again before this case.
    14. `<label>: tm mcp serves the catalog at the package version` → an MCP `Client` over
        `StdioClientTransport` built as `tests/test_tm_mcp.ts`'s `connect` builds it: `command`
        `R[0]`, `args` `[...R.slice(1), "mcp"]`, `cwd` `<S>/clean`, `env` `{ PATH: <the PATH
        above>, HOME: S, TM_URL: <room URL>, TM_API_KEY: WRITE_KEY }`, `stderr` `"pipe"` → `getServerVersion()`
        equals `{ name: "tm", version: PKG.version }`; `listTools()` names equal
        `tools_for("write").map((t) => t.name)` imported from `clients/tm/src/mcp.ts`
        (hosted-mcp-endpoint D11).
  - Launch forms (node only):
    15. `the bin runs through its shebang` → spawn `[BIN, "--version"]` with `PATH`
        `<NODE_DIR>:/usr/bin:/bin` → exit 0, stdout's first line `tm ${PKG.version}`.
    15a. `bunx --bun runs the installed bin` → `[process.execPath, "x", "--bun", "tm",
        "--version"]` (`bun x` is `bunx`) with `cwd` `<S>/clean` and `PATH`
        `<dirname(process.execPath)>:/usr/bin:/bin` → exit 0, stdout's first line
        `tm ${PKG.version}` (probe: `bun x --bun tm --version` in the clean directory printed the
        version).
    16. `npx runs the single bin from the tarball` → `npx -y --offline file:<tgz> --version` in
        a second empty directory `<S>/empty` with the same `PATH`, `npm_config_cache`
        `<S>/npm-cache` and `npm_config_update_notifier` `false` → exit 0, stdout
        first line `tm ${PKG.version}` (npm's notices go to stderr and are not checked).
- **Gate:**
  - `PB_PORT_OFFSET=<offset> bun tests/test_tm_package.ts` exit 0 (it must print the Node
    version it ran).
  - `bun scripts/check_port_collisions.ts` exit 0; `bun scripts/check_battery_suites.ts` exit
    0.
  - `make check-static` exit 0.

### Phase 3: the release workflow, the README and the smoke probe

- **Goal:** a tag publishes the package with provenance; the README documents the install and
  MCP host lines; the production image is probed by the bundled client under Node (contract: A
  release, Install and launch commands; AC-8).
- **Files:**
  - create `.github/workflows/release-tm.yml`
  - modify `clients/tm/README.md`
  - modify `e2e/smoke.ts`
  - modify `docs/readiness/agent-clients.md`
  - modify `AGENTS.md`
- **Steps:**
  - `.github/workflows/release-tm.yml`, whole file:

    ```yaml
    name: Release tm

    # Publishes clients/tm as @hsb3/tm when a tm-v<version> tag is pushed on main.
    on:
      push:
        tags: ["tm-v*"]

    concurrency:
      group: release-tm
      cancel-in-progress: false

    jobs:
      publish:
        runs-on: ubuntu-latest
        permissions:
          contents: read
          id-token: write # provenance, and trusted publishing once it is configured
        steps:
          - uses: actions/checkout@v7
            with:
              fetch-depth: 0

          - name: Refuse a tag off main or naming another version
            run: |
              git merge-base --is-ancestor "$GITHUB_SHA" origin/main \
                || { echo "tm release: $GITHUB_REF_NAME is not on main" >&2; exit 1; }
              want="$(jq -r .version clients/tm/package.json)"
              [ "$GITHUB_REF_NAME" = "tm-v$want" ] \
                || { echo "tm release: tag $GITHUB_REF_NAME does not name clients/tm/package.json version $want" >&2; exit 1; }

          - uses: oven-sh/setup-bun@v2
            with:
              bun-version: "1.4.3"

          - name: Install dependencies
            run: bun install --frozen-lockfile

          - name: Build the bundle
            run: bun clients/tm/build.ts

          # npm 11.19.0 ships with this Node; trusted publishing needs npm 11.5.1 or later.
          - uses: actions/setup-node@v6
            with:
              node-version: "24.21.0"
              registry-url: "https://registry.npmjs.org"
              package-manager-cache: false

          - name: Publish
            working-directory: clients/tm
            run: npm publish --provenance --access public
            env:
              NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
    ```
  - `clients/tm/README.md` (key-minting-cli will have rewritten its login text; keep that):
    - Insert before "## Set up once" a section, verbatim:

      ```markdown
      ## Install

      `npm install -g @hsb3/tm` puts `tm` on `PATH`; it needs Node 22.18 or later. To run it
      without installing, write `npx -y @hsb3/tm` where this page writes `tm`; on a machine with
      Bun and no Node, `bunx --bun @hsb3/tm`. `tm --version` prints the installed version and the
      API version it was built for.
      ```
    - In "## Set up once": delete the sentence starting "Run `bun install` from the repo root" and
      the alias sentence Phase 1 wrote, each only if present; replace every occurrence of
      `bun clients/tm/tm.ts` in the section with `tm` (none present: no edit). Every other
      sentence there stays.
    - Replace the whole "## As an MCP server" section (heading to the next `##`) with, verbatim:

      ````markdown
      ## As an MCP server

      `tm mcp` offers the verbs to an AI agent as tools (`tm_list`, `tm_show`, `tm_search`,
      `tm_create`, `tm_edit`, `tm_comment`) over the agent's standard input and output, with the
      key `tm login` saved, or `TM_URL` and `TM_API_KEY` when set. In Claude Code:

      ```bash
      claude mcp add --transport stdio --env TM_URL=https://tm.example.com --env TM_API_KEY=tmk_... tm -- npx -y @hsb3/tm mcp
      ```

      In Cursor's `mcp.json`, Claude Desktop's `claude_desktop_config.json` or a project's
      `.mcp.json`, under `mcpServers`:

      ```json
      {
        "tm": {
          "command": "npx",
          "args": ["-y", "@hsb3/tm", "mcp"],
          "env": { "TM_URL": "https://tm.example.com", "TM_API_KEY": "tmk_..." }
        }
      }
      ```

      A desktop app does not search the shell's `PATH`: write `command` as the full path `which
      npx` prints. With Bun and no Node, `command` is `bunx` and `args` is
      `["--bun", "@hsb3/tm", "mcp"]`. `npx -y @hsb3/tm` runs the newest release; write
      `@hsb3/tm@<version>` to keep one version.

      A read key lists only the read tools (those marked read-only); every other key lists every
      tool. A failed call's text is the JSON object `{"error": {"status", "code", "message",
      "fields"}}`, also returned as `structuredContent`.
      ````
    - Append a section, verbatim:

      ```markdown
      ## From a checkout

      Run `bun install` at the repository root, then `bun clients/tm/tm.ts <verb>`.
      `bun clients/tm/build.ts` writes the published file, `clients/tm/dist/tm.js`.
      ```
    - In "## Rate limits", the link `../../e2e/README.md#rate-limits` becomes
      `https://github.com/hsb3/task-manager-backend/blob/main/e2e/README.md#rate-limits`.
    - "## Use it" and "## When something goes wrong" stay as they are (key-minting-cli's
      changes to them included).
  - `e2e/smoke.ts`:
    - Add as a new function directly before the `const PROBES = [` line:

      ```ts
      // The published bundle under Node reaches the image and passes its refusal through.
      async function probe_tm_bundle(): Promise<void> {
        const out = path.join(os.tmpdir(), `tm-smoke-${process.pid}.js`);
        const build = run(["bun", path.join(ROOT, "clients/tm/build.ts"), "--outfile", out]);
        check("tm bundle builds", build.code, 0);
        const r = run(["node", out, "list", "--json"], {
          TM_URL: BASE_URL,
          TM_API_KEY: `tmk_${"0".repeat(40)}`,
        });
        fs.rmSync(out, { force: true });
        check(
          "tm under node, an unknown key: exit 1, tm: and the message, no stack",
          [
            r.code,
            r.out.startsWith("tm: The API key is invalid, revoked or expired."),
            /\n\s+at /.test(r.out),
          ],
          [1, true, false],
        );
      }
      ```

      Add `import fs from "node:fs";` and `import os from "node:os";` beside the existing
      `node:path` import. The probe needs `ROOT`'s dependencies installed (`bun install` there),
      as building the image does not; the default `ROOT` is this checkout. Run `bunx prettier
      --write e2e/smoke.ts` before the gate.
    - In `PROBES`, insert `probe_tm_bundle` directly before `probe_forged_client_address` (the
      rate-limit probes stay last).
    - The module comment's "Not covered" paragraph is unchanged.
  - `AGENTS.md`, "Commands": the `make check` line's comment becomes `# THE gate: check-static,
    then the battery (every suite; CI runs it sharded); needs node 22.18+ and npm on PATH`.
  - `docs/readiness/agent-clients.md`, AC-8: the verdict stays **partly**; Evidence becomes
    "`bun tests/test_tm_package.ts` installs the packed `@hsb3/tm` tarball into an empty
    directory and runs `--version`, `login`, `list`, `show` and `mcp` under Node 22.18.0 and Bun;
    `.github/workflows/release-tm.yml` publishes it from a `tm-v<version>` tag."; Gap becomes
    "the package is not yet on the public registry."
- **Tests:**
  - `make smoke` runs `probe_tm_bundle`. Watch it fail first with the same temporary edits as
    Phase 2 case 11 (bun shebang back in `tm.ts`, `banner` removed from `build.ts`, and the
    probe's built file's first line rewritten to `#!/usr/bin/env node` by a temporary line in
    the probe): the uncaught stack makes the third element `true`. Restore all three.
  - The release workflow is exercised by the runbook's first release (it cannot run in CI
    without publishing). Its guard is checked by hand first, in a throwaway clone, never the
    working repository: `git clone --quiet <repository root> <scratch>/rc && cd <scratch>/rc`
    (the clone's `origin/main` is the repository's `main`); save the "Refuse a tag off main or
    naming another version" step's `run:` body verbatim as `<scratch>/guard.sh`; then, in the
    clone:
    - `GITHUB_SHA=$(git commit-tree 'HEAD^{tree}' -m probe) GITHUB_REF_NAME=tm-v0.1.0 sh
      <scratch>/guard.sh` → exit 1, stderr `tm release: tm-v0.1.0 is not on main` (`commit-tree`
      makes an unreferenced commit, so it is on no branch).
    - `GITHUB_SHA=$(git rev-parse origin/main) GITHUB_REF_NAME=tm-v9.9.9 sh <scratch>/guard.sh`
      → exit 1, stderr `tm release: tag tm-v9.9.9 does not name clients/tm/package.json version
      0.1.0`.
    - `GITHUB_SHA=$(git rev-parse origin/main) GITHUB_REF_NAME=tm-v0.1.0 sh <scratch>/guard.sh`
      → exit 0, no output.
    Quote the three outputs in the phase report. (These three were probed on 2026-11-10 with
    the guard text above: exit 1 with each message, then exit 0.)
  - `bun scripts/check_yaml.ts` parses the new workflow.
- **Gate:**
  - `make check-static` exit 0; `make check` exit 0; `make smoke` exit 0.
  - Readiness: AC-8 evidence edited as above, verdict unchanged (it moves to met at the first
    release, runbook step 6).

### Release runbook (root-run, after Phase 3 is merged)

1. Confirm `gh repo view hsb3/task-manager-backend --json visibility` prints `"PUBLIC"`
   (provenance needs a public repository), `npm view @hsb3/tm --registry
   https://registry.npmjs.org` answers 404, and
   `curl -s https://registry.npmjs.org/-/user/hsb3/package` still lists `@hsb3/...` packages.
2. The `hsb3` npm account creates a granular access token: name `task-manager-backend release`,
   Packages and scopes "Read and write (publish and stage)" on the `@hsb3` scope, "Bypass
   two-factor authentication" checked, expiration 7 days. Root stores it with `gh secret set
   NPM_TOKEN --repo hsb3/task-manager-backend`.
3. On a `main` commit whose CI is green and whose `clients/tm/package.json` says `0.1.0`:
   `git tag tm-v0.1.0 <sha> && git push origin tm-v0.1.0`; `gh run watch` the `Release tm` run
   to success.
4. Verify: `npm view @hsb3/tm@0.1.0 dist.attestations --json --registry
   https://registry.npmjs.org` shows a `provenance` entry with
   `"predicateType": "https://slsa.dev/provenance/v1"` (the shape `npm view
   @modelcontextprotocol/sdk@1.32.2 dist.attestations --json` prints); in an empty directory `npx -y --registry https://registry.npmjs.org @hsb3/tm@0.1.0
   --version`
   prints `tm 0.1.0` on its first line.
5. Before the next release (a new trusted publisher must publish within 2 days of being
   created, https://docs.npmjs.com/trusted-publishers): `npm trust github @hsb3/tm --file
   release-tm.yml --repo hsb3/task-manager-backend --allow-publish --registry
   https://registry.npmjs.org` (npm 11.15.0 or later, 2FA
   on the account), then `gh secret delete NPM_TOKEN --repo hsb3/task-manager-backend` and revoke
   the token. The workflow needs no edit.
6. `docs/readiness/agent-clients.md` AC-8 becomes **met**, Evidence "`npx -y @hsb3/tm --version`
   on a machine with no checkout prints the published version; `npm view @hsb3/tm
   dist.attestations` shows provenance.", Gap removed; landed by PR.

## Risks

- **A later change adds an unguarded Bun-only call to the client.** Caught by the package suite,
  which runs in every `make check` and CI battery and drives the verbs under Node (Phase 2,
  cases 6 to 14; the browser sign-in itself is driven only to its metadata request); Phase 1's `git grep` is a one-time check at build time, not a standing gate.
- **The bundler duplicates a module again** (a `#!` line returns to `tm.ts`, or a Bun upgrade
  changes bundling). Caught by package suite cases 11 and 12 and `probe_tm_bundle`, which fail on
  an uncaught stack or a wrong exit code.
- **A later SDK upgrade stops bundling for Node.** SDK 2.4.0 bundles and runs under Node (Depends
  on, probe); a later version is caught by package suite case 14. Fallback if it fails: the
  failing import goes to `Bun.build`'s `external` list and to the manifest's `dependencies` at
  the exact version, and the "installs offline" case changes to an online install; that is a
  contract change ("Runtime dependencies: none") and goes back to root.
- **The Node pin drifts.** If `engines.node` is raised above the CI pin, case 1 fails in CI; if
  the CI pin is raised, the floor is no longer proven, which a reviewer sees in the `ci.yml`
  diff next to the comment naming `engines.node`.
- **Release with an empty `NPM_TOKEN` after the switch to trusted publishing.** Unverified that
  `setup-node`'s `.npmrc` with an empty `NODE_AUTH_TOKEN` lets npm's OIDC path run; the npm docs'
  own trusted-publishing example uses `setup-node` with `registry-url` and no token, which is
  this workflow minus the env line. Caught at the next release (the run fails, nothing
  publishes); fallback: delete the `env` block in `release-tm.yml`.
- **A tag pushed on a commit whose CI was red.** The workflow checks only that the commit is on
  `main`; `main` is merged only on green CI (repository rule), so a red commit on `main` is a
  direct push. Caught by the runbook's step 3 precondition.
- **A version published by mistake** cannot be overwritten or reused (npm). Recovery is a new
  patch version and `npm deprecate @hsb3/tm@<bad> "<reason>"`.
- **`npx -y @hsb3/tm` runs a cached older version.** npx resolves an unversioned spec against the
  registry on each run unless offline; an operator who wants a fixed version writes
  `@hsb3/tm@<version>`. Documented in the README's MCP section as one sentence.

## Open Questions

None open. Ruled by the owner on 2026-11-10:

1. **The published package's license.** MIT for the package only: `clients/tm/LICENSE` and
   `"license": "MIT"`; the server keeps no stated license.

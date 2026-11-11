# tm — the task tracker from the terminal

`tm` lists, shows, searches, creates, edits and comments on the tasks, documents, decisions and
milestones the key's user can see, using an API key. Every verb takes `--json` for machine-readable output,
so it works as well inside a script or an agent as it does by hand.

## Set up once

Run `bun install` from the repo root before first use; it installs the MCP SDK the `mcp` verb
needs. Then mint an API key: sign in and create an `api_keys` record, whose response shows the
key once ([What a client does](../../README.md#what-a-client-does) has the call, the levels and
the reach). A `read` key only reads; `write` or above can also create, edit and comment. Paste it:

```bash
bun clients/tm/tm.ts login --url https://tm.example.com
```

To call it as plain `tm`, link `clients/tm/tm.ts` into a directory on `PATH` once.

The key is saved to a file only its owner can read, and the command prints where. To skip the file,
set `TM_URL` and `TM_API_KEY` in the environment instead; they win over the saved login. `TM_API_KEY` holds an API key (`tmk_...`), not a login token; any other value is refused.

## Use it

```bash
tm list                                  # newest items visible to the key
tm list --project <id> --kind task       # one project, one kind
tm list --limit 20 --page 2              # the second page of 20
tm show <id>
tm search "launch checklist"
tm create "Write the launch checklist" --project <id>
tm create "Launch" --kind milestone --project <id>
tm create "Notes" --kind document --workspace <id> --set body="First draft"
tm edit <id> --title "Write the launch checklist v2" --set description="..."
tm comment <id> "Done, see the attached draft"
```

Kinds are `task` (the default), `document`, `decision` and `milestone`. `--set field=value` sets
any other field the server accepts for that kind: a yes/no field takes `true` or `false` (for
example `--set draft=true`), a number field takes a number, and anything else is free text. The server's own validation applies.

Add `--json` to any verb to get the server's answer as JSON with the field names the API uses,
plus a `kind` naming the kind (a `search` hit on a project is kind `project`). `list` and
`search` print each item's id first; that id is what `show`, `edit` and `comment` take.

## As an MCP server

`tm mcp` offers the same verbs to an AI agent as tools (`tm_list`, `tm_show`, `tm_search`,
`tm_create`, `tm_edit`, `tm_comment`), over the agent's standard input and output. It uses the key
`tm login` saved, or `TM_URL` and `TM_API_KEY` when set. Add this server entry, with absolute paths
and key, to Claude Code's `.mcp.json` (or pass the same to `claude mcp add-json tm '...'`) or to
Claude Desktop's `claude_desktop_config.json` under `mcpServers`. Write `bun` as the full path
`which bun` prints: a desktop app does not search the shell's PATH.

```json
{
  "tm": {
    "command": "/opt/homebrew/bin/bun",
    "args": ["/absolute/path/to/clients/tm/tm.ts", "mcp"],
    "env": { "TM_URL": "https://tm.example.com", "TM_API_KEY": "tmk_..." }
  }
}
```

A `read` key lists only the read tools (those marked read-only: list, show and search); a key at
any other level lists every tool, so the agent can also create, edit and comment. A failed call comes back to the
agent as a tool result whose text is the JSON object `{"error": {"status", "code", "message",
"fields"}}`, the same object also given as `structuredContent`: `status` is the server's HTTP
status (`0` when it did not answer, `null` for arguments refused before any call), `code` names
the failure (for example `api_key_scope` or `not_found`), and `fields` holds the server's
per-field details.

## When something goes wrong

- Exit code 0: it worked.
- Exit code 1: the server refused, or no usable key is configured (none saved or set, or one not
  starting with `tmk_`). The message is on stderr, with details when the server named the
  offending fields. A read-only key that tries to write exits this way.
- Exit code 2: the command line was wrong; the usage text follows the message.

Nothing is printed on stdout when a command fails, so `--json` output is either complete or absent.

## Rate limits

The server limits requests per client address; past a limit it answers "Too Many Requests". Wait a
minute and retry. The limits: [`e2e/README.md`](../../e2e/README.md#rate-limits).

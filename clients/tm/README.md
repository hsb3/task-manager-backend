# tm — the task tracker from your terminal

`tm` lists, shows, searches, creates, edits and comments on the tasks, documents, decisions and
milestones you can see, using an API key. Every verb takes `--json` for machine-readable output,
so it works as well inside a script or an agent as it does by hand.

## Set up once

Run `bun install` from the repo root before first use; it installs the MCP SDK the `mcp` verb
needs. Then create an API key in the app (a read key can only read; a write key can also create,
edit and comment) and paste it:

```bash
bun clients/tm/tm.ts login --url https://your-server.example
```

To call it as plain `tm`, link it onto your PATH once, for example
`ln -s "$PWD/clients/tm/tm.ts" ~/.local/bin/tm`.

The key is saved to a file only you can read, and the command prints where. To skip the file,
set `TM_URL` and `TM_API_KEY` in the environment instead; they win over the saved login.

## Use it

```bash
tm list                                  # newest items you can see
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
example `--set draft=true`), a number field takes a number, and anything else is any text you
like. The server's own validation applies.

Add `--json` to any verb to get the server's answer as JSON with the field names the API uses,
plus a `kind` naming the kind (a `search` hit on a project is kind `project`). `list` and
`search` print each item's id first; that id is what `show`, `edit` and `comment` take.

## As an MCP server

`tm mcp` offers the same verbs to an AI agent as tools (`tm_list`, `tm_show`, `tm_search`,
`tm_create`, `tm_edit`, `tm_comment`), over the agent's standard input and output. It uses the key
`tm login` saved, or `TM_URL` and `TM_API_KEY` when set. Add this server entry, with your own paths
and key, to Claude Code's `.mcp.json` (or pass the same to `claude mcp add-json tm '...'`) or to
Claude Desktop's `claude_desktop_config.json` under `mcpServers`. Write `bun` as the full path
`which bun` prints: a desktop app does not search your shell's PATH.

```json
{
  "tm": {
    "command": "/opt/homebrew/bin/bun",
    "args": ["/absolute/path/to/clients/tm/tm.ts", "mcp"],
    "env": { "TM_URL": "https://your-server.example", "TM_API_KEY": "tmk_..." }
  }
}
```

A read key lets the agent list, show and search; a write key also lets it create, edit and
comment. A refused action comes back to the agent as the server's own message.

## When something goes wrong

- Exit code 0: it worked.
- Exit code 1: the server refused. Its message is on stderr, and with details when it named the
  offending fields. A read-only key that tries to write exits this way.
- Exit code 2: the command line was wrong; the usage text follows the message.

Nothing is printed on stdout when a command fails, so `--json` output is either complete or absent.

## Rate limits

The server allows about 300 requests per minute per client address; past that it answers with a
"Too Many Requests" error. Wait a minute and retry.

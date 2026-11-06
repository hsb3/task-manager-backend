#!/usr/bin/env bun
// tm — the task tracker from the command line. Exit 0 ok · 1 the server refused · 2 usage.

import { parseArgs } from "node:util";
import { ApiError, ConfigError, load_config, save_config, UsageError } from "./src/api.ts";
import * as verbs from "./src/verbs.ts";

const HELP = `usage: tm <verb> [options]

  login [--url URL]                 paste an API key; saves it for the next runs
  list [--project ID] [--workspace ID] [--kind KIND] [--limit N] [--page N]
  show <id>
  search <text>
  create <title> (--project ID | --workspace ID) [--kind KIND] [--set field=value]...
  edit <id> [--title TEXT] [--set field=value]...
  comment <id> <text>
  mcp                               serve the verbs as tools to an AI agent over stdio

  KIND is task (default), document, decision or milestone.
  --limit is the page size (default 50); --page picks the page (default 1).
  --json prints the server's answer as JSON; errors go to stderr and exit 1.
  TM_URL and TM_API_KEY override what login saved.`;

const OPTIONS = {
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  url: { type: "string" },
  project: { type: "string" },
  workspace: { type: "string" },
  kind: { type: "string" },
  limit: { type: "string" },
  page: { type: "string" },
  title: { type: "string" },
  set: { type: "string", multiple: true, default: [] as string[] },
} as const;

/** `--set` pairs, typed by the kind's schema. */
function fields_of(kind: verbs.Kind | undefined, sets: string[]): verbs.Fields {
  const out: Record<string, string> = {};
  for (const s of sets) {
    const i = s.indexOf("=");
    if (i < 1) throw new UsageError(`--set wants field=value, got "${s}"`);
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return verbs.typed_fields(kind, out);
}

/** Each verb's positionals: how many it needs, and how the usage error names them. */
const NEEDS: Record<string, [number, string]> = {
  mcp: [0, ""],
  list: [0, ""],
  show: [1, "<id>"],
  search: [1, "<text>"],
  create: [1, "<title>"],
  edit: [1, "<id>"],
  comment: [2, "<id> <text>"],
};

function whole_of(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new UsageError(`${flag} wants a whole number above 0`);
  return Number(raw);
}

const pad = (s: unknown, n: number) =>
  String(s ?? "")
    .padEnd(n)
    .slice(0, n);

/** A short table for people; --json gets the raw answer. */
function print_human(verb: string, data: unknown): void {
  if (verb === "list") {
    const rows = data as verbs.ListRow[];
    for (const i of rows) console.log(`${i.id}  ${pad(i.kind, 9)} ${pad(i.key, 8)} ${i.title}`);
    if (!rows.length) console.log("no items");
  } else if (verb === "search") {
    const found = data as verbs.Found;
    for (const r of found.results) console.log(`${r.id}  ${pad(r.kind, 9)} ${r.title}`);
    if (!found.results.length) console.log("no matches");
  } else {
    for (const [k, v] of Object.entries(data as object)) {
      if (v === "" || v === null || (Array.isArray(v) && !v.length)) continue;
      console.log(`${pad(k, 18)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  }
}

/** One line from stdin: the whole input when piped; keystrokes without echo at a terminal. */
async function read_secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).split("\n")[0].trim();
  process.stdin.setRawMode(true); // before the prompt: a paste that races it must not echo
  process.stderr.write(prompt);
  let line = "";
  try {
    for await (const chunk of process.stdin) {
      for (const ch of chunk.toString()) {
        if (ch === "\u0003") process.exit(130); // ctrl-c
        if (ch === "\r" || ch === "\n") {
          process.stderr.write("\n");
          return line.trim();
        }
        if (ch === "\u007f" || ch === "\b") line = line.slice(0, -1);
        else line += ch;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
  }
  return line.trim();
}

async function login(url: string | undefined): Promise<string> {
  const key = await read_secret("Paste your API key: ");
  if (!key) throw new UsageError("no key was pasted");
  const previous = (() => {
    try {
      return load_config().url;
    } catch {
      return "";
    }
  })();
  const server = url || process.env.TM_URL || previous;
  if (!server) throw new UsageError("login needs --url the first time");
  return save_config({ url: server.replace(/\/+$/, ""), key });
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e: any) {
    throw new UsageError(e.message);
  }
  const { values: v, positionals } = parsed;
  const [verb, ...rest] = positionals;
  if (v.help || !verb) {
    console.log(HELP);
    return v.help ? 0 : 2;
  }
  if (verb === "login") {
    const file = await login(v.url);
    console.log(v.json ? JSON.stringify({ saved: file }) : `saved to ${file}`);
    return 0;
  }
  if (!Object.hasOwn(NEEDS, verb)) throw new UsageError(`unknown verb "${verb}"`);
  const [n, what] = NEEDS[verb];
  if (rest.length < n) throw new UsageError(`missing ${what}`);
  const kind = v.kind === undefined ? undefined : verbs.item_kind(v.kind);
  const limit = whole_of("--limit", v.limit);
  const page = whole_of("--page", v.page);
  const fields = fields_of(verb === "create" ? (kind ?? "task") : kind, v.set);
  if (verb === "create" && !v.project && !v.workspace)
    throw new UsageError("create needs a project or a workspace");
  if (verb === "edit" && v.title === undefined && !Object.keys(fields).length)
    throw new UsageError("edit needs a title or a field to set");
  const cfg = load_config(); // after the command line is checked: a usage error needs no login
  if (verb === "mcp") {
    await (await import("./src/mcp.ts")).serve(cfg); // loaded here only: the other verbs need no SDK
    return 0;
  }
  let data: unknown;
  switch (verb) {
    case "list":
      data = await verbs.list(cfg, {
        project: v.project,
        workspace: v.workspace,
        kind,
        limit,
        page,
      });
      break;
    case "show":
      data = await verbs.show(cfg, rest[0]);
      break;
    case "search":
      data = await verbs.search(cfg, rest.join(" "));
      break;
    case "create":
      data = await verbs.create(cfg, {
        kind,
        title: rest.join(" "),
        project: v.project,
        workspace: v.workspace,
        fields,
      });
      break;
    case "edit":
      data = await verbs.edit(cfg, rest[0], { title: v.title, fields });
      break;
    case "comment":
      data = await verbs.comment(cfg, rest[0], rest.slice(1).join(" "));
      break;
  }
  if (v.json) console.log(JSON.stringify(data, null, 2));
  else print_human(verb, data);
  return 0;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  if (e instanceof ApiError) {
    console.error(`tm: ${e.body.message}`);
    if (Object.keys(e.body.data).length) console.error(JSON.stringify(e.body, null, 2));
    process.exit(1);
  }
  if (e instanceof ConfigError) {
    console.error(`tm: ${e.message}`);
    process.exit(1);
  }
  if (e instanceof UsageError) {
    console.error(`tm: ${e.message}\n${HELP}`);
    process.exit(2);
  }
  throw e;
}

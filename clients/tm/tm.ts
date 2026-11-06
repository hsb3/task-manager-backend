#!/usr/bin/env bun
// tm — the task tracker from the command line. Exit 0 ok · 1 the server refused · 2 usage.

import { parseArgs } from "node:util";
import { ApiError, ConfigError, load_config, save_config, UsageError } from "./src/api.ts";
import * as verbs from "./src/verbs.ts";

const HELP = `usage: tm <verb> [options]

  login [--url URL]                 paste an API key; saves it for the next runs
  list [--project ID] [--workspace ID] [--kind KIND] [--limit N]
  show <id>
  search <text>
  create <title> (--project ID | --workspace ID) [--kind KIND] [--set field=value]...
  edit <id> [--title TEXT] [--set field=value]...
  comment <id> <text>
  mcp                               serve the verbs as tools to an AI agent over stdio

  KIND is task (default), document, decision or milestone.
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
  title: { type: "string" },
  set: { type: "string", multiple: true, default: [] as string[] },
} as const;

function fields_of(sets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sets) {
    const i = s.indexOf("=");
    if (i < 1) throw new UsageError(`--set wants field=value, got "${s}"`);
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

function need(positionals: string[], n: number, what: string): void {
  if (positionals.length < n) throw new UsageError(`missing ${what}`);
}

function limit_of(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new UsageError("--limit wants a whole number above 0");
  return Number(raw);
}

const pad = (s: unknown, n: number) =>
  String(s ?? "")
    .padEnd(n)
    .slice(0, n);

/** A short table for people; --json gets the raw answer. */
function print_human(verb: string, data: any): void {
  if (verb === "list") {
    for (const i of data) console.log(`${i.id}  ${pad(i.kind, 9)} ${pad(i.key, 8)} ${i.title}`);
    if (!data.length) console.log("no items");
  } else if (verb === "search") {
    for (const r of data.results) console.log(`${r.id}  ${pad(r.collection, 10)} ${r.title}`);
    if (!data.results.length) console.log("no matches");
  } else {
    for (const [k, v] of Object.entries(data)) {
      if (v === "" || v === null || (Array.isArray(v) && !v.length)) continue;
      console.log(`${pad(k, 18)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  }
}

/** One line from stdin: the whole input when piped; keystrokes without echo at a terminal. */
async function read_secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).split("\n")[0].trim();
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
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
  const cfg = load_config();
  if (verb === "mcp") {
    await (await import("./src/mcp.ts")).serve(cfg); // loaded here only: the other verbs need no SDK
    return 0;
  }
  const kind = v.kind === undefined ? undefined : verbs.item_kind(v.kind);
  let data: unknown;
  switch (verb) {
    case "list":
      data = await verbs.list(cfg, {
        project: v.project,
        workspace: v.workspace,
        kind,
        limit: limit_of(v.limit),
      });
      break;
    case "show":
      need(rest, 1, "<id>");
      data = await verbs.show(cfg, rest[0]);
      break;
    case "search":
      need(rest, 1, "<text>");
      data = await verbs.search(cfg, rest.join(" "));
      break;
    case "create":
      need(rest, 1, "<title>");
      data = await verbs.create(cfg, {
        kind,
        title: rest.join(" "),
        project: v.project,
        workspace: v.workspace,
        fields: fields_of(v.set),
      });
      break;
    case "edit":
      need(rest, 1, "<id>");
      data = await verbs.edit(cfg, rest[0], { title: v.title, fields: fields_of(v.set) });
      break;
    case "comment":
      need(rest, 2, "<id> <text>");
      data = await verbs.comment(cfg, rest[0], rest.slice(1).join(" "));
      break;
    default:
      throw new UsageError(`unknown verb "${verb}"`);
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

#!/usr/bin/env bun
// tm — the task tracker from the command line. Exit 0 ok · 1 the server refused · 2 usage.

import { parseArgs } from "node:util";
import {
  api,
  ApiError,
  check_key,
  type Config,
  ConfigError,
  forget_config,
  load_config,
  save_config,
  saved_login,
  UsageError,
} from "./src/api.ts";
import * as keys from "./src/keys.ts";
import * as verbs from "./src/verbs.ts";

const HELP = `usage: tm <verb> [options]

  login --with-key [--url URL]      paste an API key; saves it for the next runs
  keys list [--all]                 your API keys; active ones unless --all
  keys revoke <id>                  revokes one of your API keys
  logout                            revokes the saved key where it may; removes the saved login
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
  "with-key": { type: "boolean", default: false },
  "no-browser": { type: "boolean", default: false },
  name: { type: "string" },
  scope: { type: "string" },
  expires: { type: "string" },
  all: { type: "boolean", default: false },
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

async function login(url: string | undefined): Promise<{ file: string; store: string }> {
  const pasted = await read_secret("Paste your API key: ");
  if (!pasted) throw new UsageError("no key was pasted");
  const key = check_key(pasted, "the paste");
  const previous = await saved_login(false);
  const server = url || process.env.TM_URL || previous?.url;
  if (!server) throw new UsageError("login needs --url the first time");
  const saved = await save_config({ url: server, key });
  await retire(previous, key);
  return saved;
}

/** Revokes the replaced login's key through itself when it may manage keys; it is being replaced, so failures are ignored. */
async function retire(previous: Config | null, new_key: string): Promise<void> {
  if (!previous || !previous.key || previous.key === new_key) return;
  try {
    const { key } = await api(previous, "GET /api/tracker/me", {});
    if (key?.manage_keys)
      await api(previous, "POST /api/tracker/keys/{id}/revoke", { path: { id: key.id } });
  } catch {}
}

/** Revokes the saved key where it may, then removes the saved login whatever the server said. */
async function logout(json: boolean): Promise<number> {
  const saved = await saved_login(true);
  if (!saved) throw new ConfigError("no saved login to log out of");
  let key_id = "";
  let revoked = false;
  let reason: string | undefined;
  let code = 0;
  try {
    const { key } = saved.key ? await api(saved, "GET /api/tracker/me", {}) : { key: undefined };
    key_id = key?.id ?? "";
    // root ruling 5: a key limited to part of the tracker may always revoke itself
    if (key && (key.manage_keys || key.reach !== "all")) {
      await api(saved, "POST /api/tracker/keys/{id}/revoke", { path: { id: key.id } });
      revoked = true;
    } else if (key) reason = "this key cannot revoke keys (reach all, no manage-keys permission)";
  } catch (e) {
    // anything, not only ApiError: the saved login is removed whatever went wrong
    if (e instanceof ApiError && e.body.status === 401) key_id = "";
    else
      [reason, code] = [
        e instanceof ApiError ? e.body.message : String((e as Error)?.message ?? e),
        1,
      ];
  }
  await forget_config(saved.url);
  const where = `logged out of ${saved.url}`;
  if (json) console.log(JSON.stringify({ url: saved.url, key_id, revoked }));
  else if (revoked) console.log(`${where}; key ${key_id} revoked`);
  else if (!key_id)
    console.log(
      `${where}; the saved key ${reason ? `was not revoked: ${reason}` : "was already invalid"}`,
    );
  else console.log(`${where}; key ${key_id} was not revoked: ${reason}`);
  return code;
}

/** `keys list` and `keys revoke`; the sub-verb is checked before any login is read. */
async function keys_verb(rest: string[], all: boolean, json: boolean): Promise<number> {
  const [sub, id] = rest;
  if (!sub) throw new UsageError("missing <create|list|revoke>");
  if (sub === "revoke" && !id) throw new UsageError("missing <id>");
  if (sub !== "list" && sub !== "revoke")
    throw new UsageError(
      `unknown keys verb "${sub}"; one of ${sub === "create" ? "list, revoke" : "create, list, revoke"}`,
    );
  const cfg = await load_config();
  if (sub === "list") {
    const rows = await keys.list_keys(cfg, all);
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const l of keys.key_lines(rows)) console.log(l);
    return 0;
  }
  const row = await keys.revoke_key(cfg, id);
  if (json) console.log(JSON.stringify(row, null, 2));
  else console.log(`revoked ${row.id} "${keys.escaped(row.name)}"`);
  if (row.current) console.error("tm: note: that was this login's key; run tm login again");
  return 0;
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
    if (v["with-key"] && (v.scope !== undefined || v["no-browser"]))
      throw new UsageError("--with-key cannot be combined with --scope or --no-browser");
    const { file, store } = await login(v.url);
    const where = store === "os" ? " (key in the system credential store)" : "";
    console.log(v.json ? JSON.stringify({ saved: file, store }) : `saved to ${file}${where}`);
    return 0;
  }
  // before the shared load_config: logout must run with no usable credential
  if (verb === "logout") return logout(v.json);
  // before the shared load_config: keys create needs no usable credential
  if (verb === "keys") return keys_verb(rest, v.all, v.json);
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
  const cfg = await load_config(); // after the command line is checked: a usage error needs no login
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

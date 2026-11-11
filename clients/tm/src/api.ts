// Where tm finds its server and key, and the one request function every verb goes through.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Error as ApiErrorBody, Paths } from "./api.generated.ts";

export type Config = { url: string; key: string; headers?: Record<string, string> };

export function config_path(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "tm", "config.json");
}

export function save_config(cfg: Config): string {
  const file = config_path();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600); // `mode` above applies only when the file is created
  return file;
}

/** Same reading the server gives the header (trim, optional "Bearer "); tm takes API keys only, so a JWT is refused. */
export function check_key(raw: string, from: string): string {
  const key = raw.trim().replace(/^bearer\s+/i, "");
  if (!key.startsWith("tmk_"))
    throw new ConfigError(
      `the API key from ${from} does not start with tmk_: check it was copied whole` +
        (from === "TM_API_KEY" ? "" : "; run `tm login` to replace it"),
    );
  return key;
}

function read_saved(file: string): Partial<Config> {
  if (!fs.existsSync(file)) return {};
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // the parser's detail can quote the key
    throw new ConfigError(`${file} is not valid JSON; run \`tm login\` again`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ConfigError(`${file} is not a saved login; run \`tm login\` again`);
  return parsed;
}

/** The server URL of the saved login, whatever state its key is in. */
export function saved_url(): string {
  return String(read_saved(config_path()).url ?? "");
}

/** Env wins over the file: TM_URL and TM_API_KEY, each on its own. */
export function load_config(): Config {
  const file = config_path();
  const saved = read_saved(file);
  const url = process.env.TM_URL || saved.url || "";
  const raw = process.env.TM_API_KEY || saved.key || "";
  if (typeof url !== "string" || typeof raw !== "string" || !url || !raw) {
    throw new ConfigError(
      "no server or key configured: run `tm login` or set TM_URL and TM_API_KEY",
    );
  }
  const key = check_key(raw, process.env.TM_API_KEY ? "TM_API_KEY" : file);
  try {
    new URL(url);
  } catch {
    throw new ConfigError(`the server URL "${url}" is not a URL`);
  }
  return { url: url.replace(/\/+$/, ""), key };
}

export class UsageError extends Error {}

/** Nothing usable to talk to yet: no saved login and no env, or a broken one. */
export class ConfigError extends Error {}

/** The server said no: its status and message, and the offending fields under data. */
export class ApiError extends Error {
  constructor(public body: ApiErrorBody) {
    super(body.message);
  }
}

export async function request<T = any>(
  cfg: Config,
  method: string,
  route: string,
  query: Record<string, string | number | undefined> = {},
  body?: unknown,
): Promise<T> {
  const url = new URL(cfg.url + route);
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  // The hosted service's config carries headers, and its URL is private.
  const server = cfg.headers ? "the server" : cfg.url;
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: { ...cfg.headers, Authorization: cfg.key, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError({
      status: 0,
      message: `cannot reach ${server}: the server did not answer`,
      data: {},
    });
  }
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!r.ok) {
    throw new ApiError({
      status: parsed?.status ?? r.status,
      message: parsed?.message ?? (text || r.statusText),
      data: parsed?.data ?? {},
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ApiError({
      status: r.status,
      message: `${server} did not answer as the API does (${method} ${route})`,
      data: {},
    });
  }
  return parsed as T;
}

/** One custom-route call, typed by openapi.json: `op` is "METHOD /path" with `{id}` filled from args.path. */
export async function api<K extends keyof Paths>(
  cfg: Config,
  op: K,
  args: Omit<Paths[K], "response">,
): Promise<Paths[K]["response"]> {
  const a = args as {
    path?: Record<string, string>;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  };
  const sp = op.indexOf(" ");
  const route = op
    .slice(sp + 1)
    .replace(/\{(\w+)\}/gu, (_, k: string) => encodeURIComponent(a.path?.[k] ?? ""));
  // shortcut: request() refuses an empty answer, so an op whose response is null needs a 204 arm there before it is called.
  return request(cfg, op.slice(0, sp), route, a.query, a.body);
}

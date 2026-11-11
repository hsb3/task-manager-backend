// Where tm finds its server and key, and the one request function every verb goes through.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Error as ApiErrorBody, Paths } from "./api.generated.ts";
import { os_clear, os_delete, os_get, os_set, type Store, store_mode } from "./store.ts";

export type Config = { url: string; key: string; headers?: Record<string, string> };

export function config_path(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "tm", "config.json");
}

/** The key goes to the credential store when one answers, else into the file beside the URL. */
export async function save_config(cfg: {
  url: string;
  key: string;
}): Promise<{ file: string; store: Store }> {
  const mode = store_mode();
  const file = config_path();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // `mode` above applies only when the directory is created
  const url = cfg.url.replace(/\/+$/, "");
  let previous = "";
  try {
    previous = String(read_saved(file).url ?? "").replace(/\/+$/, "");
  } catch {} // a broken file is being replaced
  const store: Store = mode === "os" && (await os_set(url, cfg.key)) ? "os" : "file";
  const body = store === "os" ? { url } : { url, key: cfg.key };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    // rename replaces a symlink at `file` rather than writing through it, and never leaves half a file
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // it may hold the key
    throw e;
  }
  if (mode === "os" && previous && previous !== url) await os_delete(previous);
  if (store === "file" && mode === "os") {
    console.error(
      `tm: no credential store is available; the key is saved in ${file}, readable only by this user`,
    );
    // an older key left in the store would win over this file on the next run
    if (!(await os_clear(url)))
      console.error(
        `tm: warning: the credential store could not be reached to remove an older key for ${url}; it would be used instead of this login, so run tm login again once the store is available`,
      );
  }
  return { file, store };
}

/** Ends the saved login on this machine: its store entry and the file. */
export async function forget_config(url: string): Promise<void> {
  fs.rmSync(config_path(), { force: true }); // first: a store refusal must not keep the login
  if (store_mode() === "os") await os_delete(url);
}

/** The saved login alone (TM_URL and TM_API_KEY ignored); strict removes a broken file and refuses. */
export async function saved_login(strict: boolean): Promise<Config | null> {
  const mode = store_mode();
  const file = config_path();
  if (!fs.existsSync(file)) return null;
  let saved: Partial<Config>;
  try {
    saved = read_saved(file);
    if (typeof saved.url !== "string" || !saved.url)
      throw new ConfigError(`${file} is not a saved login; run \`tm login\` again`);
  } catch (e) {
    if (!strict) return null;
    fs.rmSync(file, { force: true });
    throw e;
  }
  const url = saved.url.replace(/\/+$/, "");
  const stored = mode === "os" ? await os_get(url) : null;
  return { url, key: stored || (typeof saved.key === "string" ? saved.key : "") };
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

/** Env wins over the saved login: TM_URL and TM_API_KEY, each on its own; the store over the file. */
export async function load_config(): Promise<Config> {
  const mode = store_mode();
  const file = config_path();
  const saved = read_saved(file);
  const url = process.env.TM_URL || saved.url || "";
  let raw: unknown = process.env.TM_API_KEY;
  let from = "TM_API_KEY";
  if (!raw && mode === "os" && typeof url === "string" && url) {
    raw = await os_get(url);
    from = "the credential store";
  }
  if (!raw) {
    raw = saved.key || "";
    from = file;
  }
  if (typeof url !== "string" || typeof raw !== "string" || !url || !raw) {
    throw new ConfigError(
      "no server or key configured: run `tm login` or set TM_URL and TM_API_KEY",
    );
  }
  const key = check_key(raw, from);
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

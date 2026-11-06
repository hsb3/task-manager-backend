// Where tm finds its server and key, and the one request function every verb goes through.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Error as ApiErrorBody } from "./api.generated.ts";

export type Config = { url: string; key: string };

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

/** Env wins over the file: TM_URL and TM_API_KEY, each on its own. */
export function load_config(): Config {
  const file = config_path();
  let saved: Partial<Config> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      saved = parsed;
    } catch (e: any) {
      throw new ConfigError(
        `${file} is not readable as a saved login (${e?.message ?? e}); run \`tm login\` again`,
      );
    }
  }
  const url = process.env.TM_URL || saved.url || "";
  const key = process.env.TM_API_KEY || saved.key || "";
  if (typeof url !== "string" || typeof key !== "string" || !url || !key) {
    throw new ConfigError(
      "no server or key configured: run `tm login` or set TM_URL and TM_API_KEY",
    );
  }
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
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: { Authorization: cfg.key, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: any) {
    throw new ApiError({
      status: 0,
      message: `cannot reach ${cfg.url}: ${e?.message ?? e}`,
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
      message: `${cfg.url} did not answer as the API does (${method} ${route})`,
      data: {},
    });
  }
  return parsed as T;
}

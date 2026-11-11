// tm keys list and keys revoke: the user's API keys through the key routes, and their human table.

import { api, ApiError, type Config, ConfigError } from "./api.ts";
import type { Paths } from "./api.generated.ts";

export type KeyRow = Paths["GET /api/tracker/keys"]["response"]["items"][number];

const expired = (row: { expires: string }) =>
  row.expires !== "" && Date.parse(row.expires.replace(" ", "T")) <= Date.now();

/** The route answers 403 api_key_manage to a key that may not manage keys. */
function refused<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof ApiError && (e.body.data as any)?.api_key?.code === "api_key_manage")
      throw new ConfigError(
        "this key cannot list or revoke keys; run tm login to get one that can",
      );
    throw e;
  });
}

export async function list_keys(cfg: Config, all: boolean): Promise<KeyRow[]> {
  const { items } = await refused(api(cfg, "GET /api/tracker/keys", {}));
  return all ? items : items.filter((k) => !k.revoked && !expired(k));
}

export function revoke_key(cfg: Config, id: string): Promise<KeyRow> {
  // a dot segment (".", "..") would be normalised into another route
  if (!/^[a-z0-9]+$/.test(id))
    return Promise.reject(new ConfigError("No key with that id among yours."));
  return refused(api(cfg, "POST /api/tracker/keys/{id}/revoke", { path: { id } }));
}

export function status_of(row: KeyRow): string {
  return row.revoked ? "revoked" : expired(row) ? "expired" : row.current ? "active*" : "active";
}

/** Controls, format characters (bidi, zero-width, tags), lone surrogates, line separators and Hangul fillers as \uXXXX or \u{XXXXX} (lower-case hex), a backslash doubled: a stored name cannot forge rows, escapes or colours, and what it hides is shown. */
export const escaped = (s: string): string =>
  s.replace(/[\\\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/gu, (c) => {
    if (c === "\\") return "\\\\";
    const n = c.codePointAt(0)!;
    return n > 0xffff ? `\\u{${n.toString(16)}}` : "\\u" + n.toString(16).padStart(4, "0");
  });

// by code point, so a cut never splits a surrogate pair
const pad = (s: string, n: number) => {
  const cps = [...s].slice(0, n);
  return cps.join("") + " ".repeat(n - cps.length);
};

export function key_lines(rows: KeyRow[]): string[] {
  if (!rows.length) return ["no keys"];
  const w = [15, 24, 6, 24, 16, 16, 16];
  const when = (d: string, none: string) => (d ? d.slice(0, 16) : none);
  const line = (cols: string[]) => cols.map((c, i) => (i < w.length ? pad(c, w[i]) : c)).join("  ");
  return [
    line(["ID", "NAME", "SCOPE", "CLIENT", "CREATED", "EXPIRES", "LAST USED", "STATUS"]),
    ...rows.map((k) =>
      line([
        k.id,
        escaped(k.name),
        k.scope,
        escaped(k.client_id) || "-",
        when(k.created, ""),
        when(k.expires, "never"),
        when(k.last_used, "never"),
        status_of(k),
      ]),
    ),
  ];
}

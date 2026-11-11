// The metadata-document fetcher and the private listener's handler (contract: Client registration).

import { timingSafeEqual } from "node:crypto";
import { lookup as dns_lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Env } from "./app.ts";

type Deps = { lookup: (host: string) => Promise<string[]>; fetch: typeof fetch };
type Result = { status: 200 | 422 | 503; body: object };

const DEFAULT_DEPS: Deps = {
  lookup: async (host) => (await dns_lookup(host, { all: true })).map((a) => a.address),
  fetch,
};
const MAX_BYTES = 5120;
const BAD_URL = "client_id is not a valid metadata URL";
const DOT_SEGMENTS = new Set([".", "..", "%2e", "%2e%2e", ".%2e", "%2e."]);
// Printable ASCII only: a Unicode host would be fetched as punycode but shown as a lookalike.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** The rule-1 reason for a raw client_id string, or null when it may be fetched. */
export function check_client_id_url(s: string): string | null {
  if (
    s.length > 2000 ||
    !PRINTABLE_ASCII.test(s) ||
    !s.startsWith("https://") ||
    s.includes("#") ||
    s.includes("?")
  )
    return BAD_URL;
  const rest = s.slice("https://".length);
  const slash = rest.indexOf("/");
  if (slash < 0 || rest.slice(0, slash).includes("@")) return BAD_URL;
  const path = rest.slice(slash);
  if (path === "/") return BAD_URL;
  if (path.split("/").some((seg) => DOT_SEGMENTS.has(seg.toLowerCase()))) return BAD_URL;
  try {
    new URL(s);
  } catch {
    return BAD_URL;
  }
  return null;
}

/** 16 bytes (IPv4 as ::ffff:a.b.c.d), or null when `s` is not a plain IP address. */
function parse_ip(s: string): number[] | null {
  s = s.trim();
  if (s.includes("%")) return null;
  const v4 = (t: string): number[] | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    return o.some((x) => x > 255) ? null : o;
  };
  const four = v4(s);
  if (four) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...four];
  let tail: number[] = [];
  const last_colon = s.lastIndexOf(":");
  if (last_colon >= 0 && s.indexOf(".", last_colon) > 0) {
    const q = v4(s.slice(last_colon + 1));
    if (!q) return null;
    tail = [q[0]! * 256 + q[1]!, q[2]! * 256 + q[3]!];
    s = s.slice(0, last_colon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const a = groups(halves[0]!);
  const b = halves.length === 2 ? groups(halves[1]!) : [];
  if (![...a, ...b].every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  let words: string[];
  if (halves.length === 2) {
    if (a.length + b.length > 7) return null;
    words = [...a, ...new Array<string>(8 - a.length - b.length).fill("0"), ...b];
  } else {
    if (a.length !== 8) return null;
    words = a;
  }
  const w = words.map((g) => parseInt(g, 16));
  if (tail.length) [w[6], w[7]] = tail;
  return w.flatMap((x) => [x >> 8, x & 255]);
}

function in_cidr(ip: number[], cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const b = parse_ip(base!)!;
  const is_v4 = !base!.includes(":");
  let n = Number(bits) + (is_v4 ? 96 : 0); // IPv4 prefixes live in ::ffff:0:0/96
  for (let i = 0; i < 16 && n > 0; i++, n -= 8) {
    const mask = n >= 8 ? 255 : (255 << (8 - n)) & 255;
    if ((ip[i]! & mask) !== (b[i]! & mask)) return false;
  }
  return true;
}

// RFC 6890 and successors; ::ffff:0:0/96 is judged by its embedded IPv4 address.
const V4_REFUSED = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
const V6_REFUSED = [
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
  "::/96",
];

export function is_public_address(ip: string): boolean {
  const b = parse_ip(ip);
  if (!b) return false;
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255;
  return !(mapped ? V4_REFUSED : V6_REFUSED).some((c) => in_cidr(b, c));
}

export function max_age(cache_control: string | null): number {
  const cc = (cache_control ?? "").toLowerCase();
  if (/(^|,)\s*(no-store|no-cache)\b/.test(cc)) return 0;
  const m = /(^|,)\s*max-age\s*=\s*"?(\d+)/.exec(cc);
  return m ? Math.min(Number(m[2]), 86400) : 300;
}

const refuse = (error: string): Result => ({ status: 422, body: { error } });
const transient = (error: string): Result => ({ status: 503, body: { error } });

function redirect_uri_ok(u: unknown): boolean {
  if (typeof u !== "string" || u.length > 2000 || !PRINTABLE_ASCII.test(u) || u.includes("#"))
    return false;
  try {
    const p = new URL(u);
    return (
      p.protocol === "https:" ||
      (p.protocol === "http:" && (p.hostname === "localhost" || p.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

/** The body read up to MAX_BYTES, or null when it is larger. */
async function read_capped(res: Response): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function fetch_client_metadata(
  client_id: string,
  deps: Deps = DEFAULT_DEPS,
): Promise<Result> {
  const bad = check_client_id_url(client_id);
  if (bad) return refuse(bad);
  const url = new URL(client_id);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await deps.lookup(host);
  } catch {
    return transient("host did not resolve");
  }
  if (!addresses.length) return transient("host did not resolve");
  if (!addresses.every(is_public_address)) return refuse("host resolves to a non-public address");

  const first = addresses[0]!;
  const port = url.port ? ":" + url.port : "";
  const target = `https://${isIP(first) === 6 ? `[${first}]` : first}${port}${url.pathname}`;
  let res: Response;
  try {
    res = await deps.fetch(target, {
      headers: { Host: url.hostname + port, Accept: "application/json" },
      tls: { serverName: host },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return transient("host did not answer");
  }
  if (res.status >= 300 && res.status < 400) return refuse("redirects are not followed");
  if (res.status >= 500) return transient("host failed");
  if (res.status !== 200) return refuse(`host answered ${res.status}`);

  const too_large = refuse("document is larger than 5 KB");
  if (Number(res.headers.get("Content-Length") ?? 0) > MAX_BYTES) return too_large;
  let bytes: Uint8Array | null;
  try {
    bytes = await read_capped(res);
  } catch {
    return transient("host did not answer");
  }
  if (bytes === null) return too_large;

  let doc: any;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    doc = null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return refuse("document is not a JSON object");
  if (doc.client_id !== client_id) return refuse("client_id does not match the URL");
  if (typeof doc.client_name !== "string" || doc.client_name === "")
    return refuse("client_name missing or invalid");
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every(redirect_uri_ok))
    return refuse("redirect_uris missing or invalid");
  if (
    ("token_endpoint_auth_method" in doc && doc.token_endpoint_auth_method !== "none") ||
    "client_secret" in doc
  )
    return refuse("client is not a public client");
  const lists = (field: string, value: string) =>
    !(field in doc) || (Array.isArray(doc[field]) && doc[field].includes(value));
  if (!lists("grant_types", "authorization_code") || !lists("response_types", "code"))
    return refuse("client does not use the authorization code flow");

  return {
    status: 200,
    body: {
      client: { client_id, client_name: doc.client_name.slice(0, 200), redirect_uris: uris },
      max_age: max_age(res.headers.get("Cache-Control")),
    },
  };
}

function secret_ok(sent: string | null, secret: string): boolean {
  const a = Buffer.from(sent ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function internal_handler(env: Env): (req: Request) => Promise<Response> {
  return async (req) => {
    if (
      req.method !== "POST" ||
      new URL(req.url).pathname !== "/internal/client-metadata" ||
      !secret_ok(req.headers.get("X-TM-Internal"), env.internal_secret)
    )
      return Response.json({ error: "not_found" }, { status: 404 });
    let body: any;
    try {
      body = JSON.parse(await req.text());
    } catch {
      body = null;
    }
    if (body === null || typeof body !== "object" || typeof body.client_id !== "string")
      return Response.json(
        { error: 'request body must be {"client_id": string}' },
        { status: 422 },
      );
    const r = await fetch_client_metadata(body.client_id);
    return Response.json(r.body, { status: r.status });
  };
}

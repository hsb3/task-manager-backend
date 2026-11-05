// Shared Python-semantics helpers for the Python -> Bun/TypeScript port.
// Exports: py_int, py_repr, py_str, tup, by_code_point, json_dumps, splitlines, py_split,
// py_strip, py_lstrip, py_rstrip, quote_plus, urlencode, html_escape, py_join, os_walk,
// glob_sorted, decode_text, UnicodeDecodeError, read_text, os_error_text, run_checked,
// CalledProcessError, SystemExit, install_system_exit_handler, PY_WS, PY_WS_RE, PyFloat,
// py_float, truthy, shlex_split, print, quote, url_error_reason, getitem, py_get, sqlite_connect

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";

// str.isspace() set (differs from JS \s: adds \x1c-\x1f \x85, drops U+FEFF), as a class body.
// Spelled as the checkers' former class text (a test pins RegExp source text).
export const PY_WS =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
export const PY_WS_RE = new RegExp("[" + PY_WS + "]", "u");
// int() trims only ASCII \t-\r and space plus non-ASCII spaces (not \x1c-\x1f).
const PY_SPACE = `[\\t-\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]`;
const INT_RE = new RegExp(`^${PY_SPACE}*[+-]?\\p{Nd}+(_\\p{Nd}+)*${PY_SPACE}*$`, "u");
const ND = /^\p{Nd}$/u;

// Decimal value of a Unicode Nd char: Nd runs are 10-aligned from the run start.
function nd_value(ch: string): number {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/** Python `int(str)`, base 10. Large values lose precision (JS number). */
export function py_int(s: string): number {
  if (!INT_RE.test(s)) {
    throw new Error(`invalid literal for int() with base 10: ${py_repr(s)}`);
  }
  const t = s.replace(new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "gu"), "").replace(/_/g, "");
  const neg = t.startsWith("-");
  const digits = t.replace(/^[+-]/, "");
  let v = 0n;
  for (const ch of digits) v = v * 10n + BigInt(nd_value(ch));
  return Number(neg ? -v : v);
}

/** A Python float: JS cannot tell 1.0 from 1, so a value that must print as a float is wrapped. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** Marks `n` as a Python float for `py_repr` / `py_str` / `json_dumps` (`1.0`, `1e+16`, `inf`). */
export const py_float = (n: number): PyFloat => new PyFloat(n);

function float_repr(v: number, is_float = false): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (is_float && Number.isInteger(v) && Math.abs(v) < 1e16) {
    return (Object.is(v, -0) ? "-0" : String(v)) + ".0";
  }
  // shortcut: JS cannot tell 1 from 1.0, so unmarked integral values below 1e16 print as ints.
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
  const [m, e] = v.toExponential().split("e");
  const exp = Number(e);
  if (exp >= -4 && exp < 16) return String(v);
  const sign = exp < 0 ? "-" : "+";
  return `${m}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** Python `repr` of str, bytes (Uint8Array), number, bool, None, list, tuple, set, dict (object or Map), exception. */
export function py_repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return float_repr(v);
  if (v instanceof PyFloat) return float_repr(v.value, true);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = "";
    for (const ch of v) {
      const c = ch.codePointAt(0)!;
      if (ch === q || ch === "\\") out += `\\${ch}`;
      else if (ch === "\t") out += "\\t";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
      else if (ch !== " " && /[\p{C}\p{Z}]/u.test(ch)) {
        out +=
          c <= 0xff
            ? `\\x${c.toString(16).padStart(2, "0")}`
            : c <= 0xffff
              ? `\\u${c.toString(16).padStart(4, "0")}`
              : `\\U${c.toString(16).padStart(8, "0")}`;
      } else out += ch;
    }
    return q + out + q;
  }
  if (v instanceof Uint8Array) {
    const q = v.includes(0x27) && !v.includes(0x22) ? '"' : "'";
    let out = "";
    for (const c of v) {
      const ch = String.fromCharCode(c);
      if (ch === q || ch === "\\") out += `\\${ch}`;
      else if (ch === "\t") out += "\\t";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (c < 0x20 || c >= 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
      else out += ch;
    }
    return "b" + q + out + q;
  }
  if (Array.isArray(v)) {
    if (!(v as { tuple?: boolean }).tuple) return `[${v.map(py_repr).join(", ")}]`;
    return `(${v.map(py_repr).join(", ")}${v.length === 1 ? "," : ""})`;
  }
  if (v instanceof Set) return v.size ? `{${[...v].map(py_repr).join(", ")}}` : "set()";
  if (v instanceof CalledProcessError) {
    return `CalledProcessError(${v.returncode}, ${py_repr(v.cmd)})`;
  }
  if (v instanceof SystemExit) return `SystemExit(${v.code === null ? "" : py_repr(v.code)})`;
  if (v instanceof Error) {
    const e = v as Error & { code?: unknown; reason?: unknown };
    // urllib's HTTPError repr (tests/roomkit.ts keeps that class private).
    if (e.name === "HTTPError" && typeof e.code === "number") {
      return `<HTTPError ${e.code}: ${py_repr(e.reason)}>`;
    }
    return `${e.name}(${e.message === "" ? "" : py_repr(e.message)})`;
  }
  const entries = v instanceof Map ? [...v] : Object.entries(v as object);
  return `{${entries.map(([k, x]) => `${py_repr(k)}: ${py_repr(x)}`).join(", ")}}`;
}

/** Marks an array as a Python tuple for `py_repr`; `Bun.deepEquals` ignores the tag. */
export const tup = <T extends unknown[]>(...a: T): T & { tuple: true } =>
  Object.assign(a, { tuple: true as const });

/** Python `str()`: a str unchanged, an exception its message, everything else its repr. */
export function py_str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  return py_repr(v);
}

/** Python `print(*args)`: `str()` of each, space-joined, newline-terminated, to stdout. */
export function print(...args: unknown[]): void {
  process.stdout.write(args.map(py_str).join(" ") + "\n");
}

// UTF-8 byte order is code-point order (JS's default sort is UTF-16 order).
export const by_code_point = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

const JSON_ESC: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

function json_str(s: string, ensure_ascii: boolean): string {
  const re = ensure_ascii ? /["\\\u0000-\u001f\u007f-￿]/g : /["\\\u0000-\u001f]/g;
  return `"${s.replace(re, (c) => {
    if (c in JSON_ESC) return JSON_ESC[c]!;
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  })}"`;
}

/**
 * Python `json.dumps`. JS cannot distinguish `1` from `1.0`, so integral numbers
 * render as ints unless marked with `py_float`; non-integral numbers use Python float repr.
 */
export function json_dumps(
  v: unknown,
  opts: {
    indent?: number;
    sort_keys?: boolean;
    ensure_ascii?: boolean;
    separators?: [string, string];
  } = {},
): string {
  const { indent, sort_keys = false, ensure_ascii = true } = opts;
  const [item_sep, key_sep] =
    opts.separators ?? (indent === undefined ? [", ", ": "] : [",", ": "]);
  const enc = (x: unknown, level: number): string => {
    if (x === null || x === undefined) return "null";
    if (x === true) return "true";
    if (x === false) return "false";
    if (typeof x === "bigint") return x.toString();
    if (x instanceof PyFloat) {
      return Number.isFinite(x.value) ? float_repr(x.value, true) : enc(x.value, level);
    }
    if (typeof x === "number") {
      return Number.isNaN(x)
        ? "NaN"
        : !Number.isFinite(x)
          ? x > 0
            ? "Infinity"
            : "-Infinity"
          : float_repr(x);
    }
    if (typeof x === "string") return json_str(x, ensure_ascii);
    const items: string[] = [];
    const arr = Array.isArray(x);
    if (arr) for (const e of x) items.push(enc(e, level + 1));
    else {
      let keys = Object.keys(x as object);
      if (sort_keys) keys = keys.sort(by_code_point);
      for (const k of keys) {
        items.push(
          json_str(k, ensure_ascii) + key_sep + enc((x as Record<string, unknown>)[k], level + 1),
        );
      }
    }
    const [open, close] = arr ? ["[", "]"] : ["{", "}"];
    if (items.length === 0) return open + close;
    if (indent === undefined) return open + items.join(item_sep) + close;
    const pad = "\n" + " ".repeat(indent * (level + 1));
    return open + pad + items.join(item_sep + pad) + "\n" + " ".repeat(indent * level) + close;
  };
  return enc(v, 0);
}

/** Python `str.splitlines()` (no keepends). */
export function splitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Python `str.split(sep=None, maxsplit=-1)`. */
export function py_split(s: string, sep?: string, maxsplit = -1): string[] {
  if (sep === undefined) {
    const out: string[] = [];
    const re = new RegExp(`[^${PY_WS}]+`, "gu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (maxsplit >= 0 && out.length === maxsplit) {
        // remainder keeps its trailing whitespace, loses leading
        out.push(s.slice(m.index));
        return out;
      }
      out.push(m[0]);
    }
    return out;
  }
  if (sep === "") throw new Error("empty separator");
  const out: string[] = [];
  let i = 0;
  while (maxsplit < 0 || out.length < maxsplit) {
    const j = s.indexOf(sep, i);
    if (j < 0) break;
    out.push(s.slice(i, j));
    i = j + sep.length;
  }
  out.push(s.slice(i));
  return out;
}

function strip_set(chars: string | null | undefined): (ch: string) => boolean {
  if (chars === null || chars === undefined) {
    const ws = new RegExp(`^[${PY_WS}]$`, "u");
    return (ch) => ws.test(ch);
  }
  const set = new Set(chars);
  return (ch) => set.has(ch);
}

/** Python `str.strip(chars=None)`: `str.isspace()` characters when `chars` is omitted. */
export function py_strip(s: string, chars?: string | null): string {
  return py_rstrip(py_lstrip(s, chars), chars);
}

/** Python `str.lstrip(chars=None)`. */
export function py_lstrip(s: string, chars?: string | null): string {
  const strip = strip_set(chars);
  const cps = [...s];
  let i = 0;
  while (i < cps.length && strip(cps[i]!)) i++;
  return cps.slice(i).join("");
}

/** Python `str.rstrip(chars=None)`. */
export function py_rstrip(s: string, chars?: string | null): string {
  const strip = strip_set(chars);
  const cps = [...s];
  let j = cps.length;
  while (j > 0 && strip(cps[j - 1]!)) j--;
  return cps.slice(0, j).join("");
}

const ALWAYS_SAFE = /^[A-Za-z0-9_.~-]$/;

/** Python `urllib.parse.quote(s, safe="/")` (UTF-8, strict: a lone surrogate raises). */
export function quote(s: string, safe: string = "/"): string {
  const bad = /\p{Cs}/u.exec(s);
  if (bad) {
    const pos = [...s.slice(0, bad.index)].length;
    throw new Error(
      `'utf-8' codec can't encode character ${py_repr(bad[0])} ` +
        `in position ${pos}: surrogates not allowed`,
    );
  }
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (b < 0x80 && (ALWAYS_SAFE.test(c) || safe.includes(c))) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Python `urllib.parse.quote_plus(s, safe="")`: `quote` with a space as "+". */
export function quote_plus(s: string, safe: string = ""): string {
  return quote(s, safe + " ").replaceAll(" ", "+");
}

/** Python `urllib.parse.urlencode(query)` (doseq=False): values go through `str()`. */
export function urlencode(
  params: Record<string, unknown> | Map<unknown, unknown> | [unknown, unknown][],
): string {
  const pairs =
    params instanceof Map ? [...params] : Array.isArray(params) ? params : Object.entries(params);
  return pairs.map(([k, v]) => `${quote_plus(py_str(k))}=${quote_plus(py_str(v))}`).join("&");
}

/** Python `html.escape(s, quote=True)`. */
export function html_escape(s: string, quote: boolean = true): string {
  s = s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return quote ? s.replaceAll('"', "&quot;").replaceAll("'", "&#x27;") : s;
}

/** Python `os.path.join` (posix): no normalisation; an absolute later part resets. */
export function py_join(a: string, ...parts: string[]): string {
  let out = a;
  for (const b of parts) {
    if (b.startsWith("/")) out = b;
    else if (!out || out.endsWith("/")) out += b;
    else out += "/" + b;
  }
  return out;
}

/**
 * Python `os.walk(top)` (topdown, onerror=None, followlinks=False): yields
 * `[dirpath, dirnames, filenames]` in directory-read order. Prune `dirnames` in place to
 * skip a subtree; a symlinked directory is listed in dirnames but never descended into.
 */
export function* os_walk(top: string): Generator<[string, string[], string[]]> {
  const stack = [top];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs: string[] = [];
    const nondirs: string[] = [];
    for (const e of ents) {
      let is_dir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          is_dir = fs.statSync(py_join(dir, e.name)).isDirectory();
        } catch {
          is_dir = false;
        }
      }
      (is_dir ? dirs : nondirs).push(e.name);
    }
    yield [dir, dirs, nondirs];
    for (const name of [...dirs].reverse()) {
      const sub = py_join(dir, name);
      let link = false;
      try {
        link = fs.lstatSync(sub).isSymbolicLink();
      } catch {}
      if (!link) stack.push(sub);
    }
  }
}

/** Python `sorted(glob.glob(os.path.join(dir, "*" + suffix)))`: hidden names never match. */
export function glob_sorted(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith(".") && n.endsWith(suffix))
    .map((n) => (dir === "" || dir.endsWith("/") ? dir + n : `${dir}/${n}`))
    .sort(by_code_point);
}

/** Python `d[k]`: a missing (or only inherited) key raises `KeyError: <repr(k)>` instead of reading as undefined. */
export function getitem(o: any, k: string): any {
  if (!Object.hasOwn(o, k)) throw new Error(`KeyError: ${py_repr(k)}`);
  return o[k];
}

/** Python `d.get(k, dflt)` for a plain object (own keys only) or a Map: a present `null` stays `null`. */
export function py_get(d: any, k: unknown, dflt: any = null): any {
  if (d instanceof Map) return d.has(k) ? d.get(k) : dflt;
  return Object.hasOwn(d, k as PropertyKey) ? d[k as PropertyKey] : dflt;
}

/** Python `sqlite3.connect(path, timeout=5.0)` (`readonly` = a `file:...?mode=ro` URI); bun:sqlite's own busy timeout is 0. */
export function sqlite_connect(
  path: string,
  opts: { readonly?: boolean; timeout?: number } = {},
): Database {
  const { readonly = false, timeout = 5.0 } = opts;
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path);
  db.run(`PRAGMA busy_timeout = ${Math.trunc(timeout * 1000)}`);
  return db;
}

/** Python `bool(v)`: empty str/array/Map/Set/plain object, 0, None and False are false; NaN is true. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "number") return v !== 0;
  if (v instanceof PyFloat) return v.value !== 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return Object.keys(v).length > 0;
    return true;
  }
  // left: boolean, bigint, symbol, function, whose JS truthiness is Python's
  return Boolean(v);
}

const value_error = (msg: string): Error => Object.assign(new Error(msg), { name: "ValueError" });

/** Python `shlex.split(s, comments, posix)`: CPython's `shlex.read_token` with whitespace_split. */
export function shlex_split(s: string, comments = false, posix = true): string[] {
  const WHITESPACE = " \t\r\n";
  const QUOTES = `'"`;
  const out: string[] = [];
  let i = 0;
  let state: string | null = " ";
  const consume_comment = (): void => {
    const nl = s.indexOf("\n", i);
    i = nl < 0 ? s.length : nl + 1;
  };
  while (state !== null) {
    let token = "";
    let quoted = false;
    let escapedstate = " ";
    for (;;) {
      const c = i < s.length ? s[i++]! : "";
      if (state === " ") {
        if (!c) {
          state = null;
          break;
        } else if (WHITESPACE.includes(c)) {
          if (token || (posix && quoted)) break;
        } else if (comments && c === "#") consume_comment();
        else if (posix && c === "\\") {
          escapedstate = "a";
          state = c;
        } else if (QUOTES.includes(c)) {
          if (!posix) token = c;
          state = c;
        } else {
          token = c;
          state = "a";
        }
      } else if (QUOTES.includes(state)) {
        quoted = true;
        if (!c) throw value_error("No closing quotation");
        if (c === state) {
          if (posix) state = "a";
          else {
            token += c;
            state = " ";
            break;
          }
        } else if (posix && c === "\\" && state === '"') {
          escapedstate = state;
          state = c;
        } else token += c;
      } else if (state === "\\") {
        if (!c) throw value_error("No escaped character");
        // In posix shells, only the quote itself or the escape may be escaped within quotes.
        if (QUOTES.includes(escapedstate) && c !== state && c !== escapedstate) token += state;
        token += c;
        state = escapedstate;
      } else {
        if (!c) {
          state = null;
          break;
        } else if (WHITESPACE.includes(c)) {
          state = " ";
          if (token || (posix && quoted)) break;
        } else if (comments && c === "#") {
          consume_comment();
          if (posix) {
            state = " ";
            if (token || (posix && quoted)) break;
          }
        } else if (posix && QUOTES.includes(c)) state = c;
        else if (posix && c === "\\") {
          escapedstate = "a";
          state = c;
        } else token += c;
      }
    }
    if (posix ? token || quoted : token) out.push(token);
  }
  return out;
}

/** Python's `UnicodeDecodeError` (its `str()` text is the message). */
export class UnicodeDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnicodeDecodeError";
  }
}

// CPython's utf-8 decoder verdict on the first bad sequence at or after `i`.
function utf8_error(b: Uint8Array): UnicodeDecodeError {
  for (let i = 0; i < b.length; i++) {
    const b0 = b[i]!;
    if (b0 < 0x80) continue;
    let end = i + 1;
    let reason = "";
    if (b0 < 0xc2 || b0 > 0xf4) reason = "invalid start byte";
    else {
      const n = b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
      const [lo, hi] =
        b0 === 0xe0
          ? [0xa0, 0xbf]
          : b0 === 0xed
            ? [0x80, 0x9f]
            : b0 === 0xf0
              ? [0x90, 0xbf]
              : b0 === 0xf4
                ? [0x80, 0x8f]
                : [0x80, 0xbf];
      for (let k = 1; k < n; k++) {
        if (i + k >= b.length) {
          [end, reason] = [b.length, "unexpected end of data"];
          break;
        }
        const c = b[i + k]!;
        if (k === 1 ? c < lo || c > hi : c < 0x80 || c > 0xbf) {
          [end, reason] = [i + k, "invalid continuation byte"];
          break;
        }
      }
      if (!reason) {
        i += n - 1;
        continue;
      }
    }
    const what =
      end - i === 1
        ? `byte 0x${b0.toString(16).padStart(2, "0")} in position ${i}`
        : `bytes in position ${i}-${end - 1}`;
    return new UnicodeDecodeError(`'utf-8' codec can't decode ${what}: ${reason}`);
  }
  return new UnicodeDecodeError("'utf-8' codec can't decode bytes");
}

/**
 * UTF-8 plus universal newlines, like Python's text mode / `text=True`. `errors="replace"`
 * puts U+FFFD per maximal invalid subpart, as CPython; a BOM is kept either way.
 */
export function decode_text(b: Uint8Array, errors: "strict" | "replace" = "strict"): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: errors === "strict", ignoreBOM: true }).decode(b);
  } catch {
    throw utf8_error(b);
  }
  return text.replace(/\r\n?/g, "\n");
}

/** Python `open(path, encoding="utf-8", errors=errors).read()`; a failed read carries `path` for os_error_text. */
export function read_text(file: string, errors: "strict" | "replace" = "strict"): string {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (exc) {
    (exc as { path?: string }).path ??= file;
    throw exc;
  }
  return decode_text(raw, errors);
}

// The number comes from the error itself; the table's is a fallback. Text is macOS's strerror
// (Linux differs only for EBUSY and ETIMEDOUT).
const DARWIN = os.platform() === "darwin";
const STRERROR: Record<string, [number, string]> = {
  EPERM: [1, "Operation not permitted"],
  ENOENT: [2, "No such file or directory"],
  EACCES: [13, "Permission denied"],
  EEXIST: [17, "File exists"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  ENOTEMPTY: [DARWIN ? 66 : 39, "Directory not empty"],
  ENOEXEC: [8, "Exec format error"],
  EBUSY: [16, DARWIN ? "Resource busy" : "Device or resource busy"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
  EADDRINUSE: [DARWIN ? 48 : 98, "Address already in use"],
  ETIMEDOUT: [DARWIN ? 60 : 110, DARWIN ? "Operation timed out" : "Connection timed out"],
  ECONNREFUSED: [DARWIN ? 61 : 111, "Connection refused"],
  ELOOP: [DARWIN ? 62 : 40, "Too many levels of symbolic links"],
  ENAMETOOLONG: [DARWIN ? 63 : 36, "File name too long"],
};

// A fetch failure's errno and text as urllib reports it; `true` = urlopen wraps it in URLError
// (a reset surfaces later, from getresponse, as a bare ConnectionResetError).
const GAI_NONAME: [number, string, boolean] = DARWIN
  ? [8, "nodename nor servname provided, or not known", true]
  : [-2, "Name or service not known", true];
const URL_REASON: Record<string, [number, string, boolean]> = {
  ECONNREFUSED: [...STRERROR.ECONNREFUSED!, true],
  ETIMEDOUT: [...STRERROR.ETIMEDOUT!, true],
  ENOTFOUND: GAI_NONAME,
  EAI_NONAME: GAI_NONAME,
  ECONNRESET: [DARWIN ? 54 : 104, "Connection reset by peer", false],
};

/**
 * Python urllib's text for a failed fetch: `str(e.reason)` of the URLError (`[Errno 61]
 * Connection refused`), or with `as_str` the `str(e)` an `except OSError` prints
 * (`<urlopen error [Errno 61] Connection refused>`). An abort by `AbortSignal.timeout` is
 * urlopen's socket timeout (`timed out`). shortcut: Bun reports a peer that closes without a
 * response as ECONNRESET too (Python: RemoteDisconnected); anything unmapped is `py_str(e)`.
 */
export function url_error_reason(e: unknown, as_str = false): string {
  const x = e as { code?: unknown; name?: unknown } | null;
  const hit = typeof x?.code === "string" ? URL_REASON[x.code] : undefined;
  let reason: string;
  if (x?.name === "TimeoutError") reason = "timed out";
  else if (hit) reason = `[Errno ${hit[0]}] ${hit[1]}`;
  else return py_str(e);
  return as_str && (hit?.[2] ?? true) ? `<urlopen error ${reason}>` : reason;
}

/** Python `str(OSError)`: `[Errno N] <strerror>: '<filename>'`; an unmapped error rethrows. */
export function os_error_text(exc: unknown, filename?: string | null): string {
  const e = exc as { code?: unknown; errno?: unknown; path?: unknown; dest?: unknown } | null;
  const hit = e && typeof e.code === "string" ? STRERROR[e.code] : undefined;
  if (!hit) throw exc;
  const errno = typeof e!.errno === "number" ? Math.abs(e!.errno) : hit[0];
  const name = filename === undefined ? e!.path : filename;
  let out = `[Errno ${errno}] ${hit[1]}`;
  if (typeof name === "string") out += `: ${py_repr(name)}`;
  if (typeof name === "string" && typeof e!.dest === "string") out += ` -> ${py_repr(e!.dest)}`;
  return out;
}

/** Python's `subprocess.CalledProcessError`; the message is Python's `str()` text. */
export class CalledProcessError extends Error {
  returncode: number;
  cmd: string[];
  stdout: string | Uint8Array | null;
  stderr: string | Uint8Array | null;
  constructor(
    returncode: number,
    cmd: string[],
    output: string | Uint8Array | null = null,
    stderr: string | Uint8Array | null = null,
  ) {
    let message = `Command '${py_repr(cmd)}' returned non-zero exit status ${returncode}.`;
    if (returncode < 0) {
      const sig = Object.entries(os.constants.signals).find(([, n]) => n === -returncode);
      message = sig
        ? `Command '${py_repr(cmd)}' died with <Signals.${sig[0]}: ${-returncode}>.`
        : `Command '${py_repr(cmd)}' died with unknown signal ${-returncode}.`;
    }
    super(message);
    this.name = "CalledProcessError";
    this.returncode = returncode;
    this.cmd = cmd;
    this.stdout = output;
    this.stderr = stderr;
  }
}

export type RunOpts = {
  capture_output?: boolean;
  text?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | Uint8Array;
};
export type CompletedProcess<T> = { returncode: number; stdout: T | null; stderr: T | null };

/**
 * Python `subprocess.run(cmd, check=True, ...)`, synchronous. Uncaptured streams are
 * inherited (`stdout`/`stderr` null). A killed child's returncode is `-signal`, as Python.
 */
export function run_checked(
  cmd: string[],
  opts: RunOpts & { text: true },
): CompletedProcess<string>;
export function run_checked(cmd: string[], opts?: RunOpts): CompletedProcess<Uint8Array>;
export function run_checked(
  cmd: string[],
  opts: RunOpts = {},
): CompletedProcess<string> | CompletedProcess<Uint8Array> {
  const pipe = opts.capture_output ? "pipe" : "inherit";
  const r = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin:
      opts.input === undefined
        ? "inherit"
        : typeof opts.input === "string"
          ? new TextEncoder().encode(opts.input)
          : opts.input,
    stdout: pipe,
    stderr: pipe,
  });
  const sig = typeof r.signalCode === "string" ? os.constants.signals[r.signalCode] : r.signalCode;
  const returncode = r.exitCode ?? -(sig ?? 0);
  const conv = (b: Uint8Array | undefined): string | Uint8Array | null =>
    !opts.capture_output || !b ? null : opts.text ? decode_text(b) : new Uint8Array(b);
  const [stdout, stderr] = [conv(r.stdout), conv(r.stderr)];
  if (returncode !== 0) throw new CalledProcessError(returncode, cmd, stdout, stderr);
  return { returncode, stdout, stderr } as CompletedProcess<string>;
}

/** Python's `SystemExit`: `.code` is the argument, `.message` its `str()`. */
export class SystemExit extends Error {
  code: string | number | boolean | null;
  constructor(code: string | number | boolean | null = null) {
    super(code === null ? "" : String(code));
    this.name = "SystemExit";
    this.code = code;
    install_system_exit_handler();
  }
}

let exit_handler_installed = false;

/**
 * One process-wide handler giving an uncaught SystemExit Python's exit: a str code goes to
 * stderr and exits 1, null/false 0, true 1, a number itself; any other error exits 1.
 * Installed by tests/roomkit.ts on import and by the first SystemExit constructed.
 */
export function install_system_exit_handler(): void {
  if (exit_handler_installed) return;
  exit_handler_installed = true;
  const on_fatal = (e: unknown): void => {
    if (e instanceof SystemExit) {
      if (typeof e.code === "string") process.stderr.write(e.message + "\n");
      process.exit(
        e.code === null || e.code === false ? 0 : typeof e.code === "number" ? e.code : 1,
      );
    }
    console.error(e);
    process.exit(1);
  };
  process.on("uncaughtException", on_fatal);
  process.on("unhandledRejection", on_fatal);
}

const is_hex = (c: number | undefined): boolean =>
  c !== undefined && ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102));

/** Python `quopri.decodestring(data)` (`binascii.a2b_qp`, header=False). */
export function quopri_decodestring(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] !== 0x3d) {
      out.push(data[i]!);
      i++;
      continue;
    }
    i++;
    if (i >= data.length) break;
    if (data[i] === 0x0a || data[i] === 0x0d) {
      // soft line break: drop through the next "\n" (or to the end)
      if (data[i] !== 0x0a) while (i < data.length && data[i] !== 0x0a) i++;
      if (i < data.length) i++;
    } else if (data[i] === 0x3d) {
      out.push(0x3d);
      i++;
    } else if (is_hex(data[i]) && is_hex(data[i + 1])) {
      out.push(parseInt(String.fromCharCode(data[i]!, data[i + 1]!), 16));
      i += 2;
    } else out.push(0x3d);
  }
  return new Uint8Array(out);
}

#!/usr/bin/env bun
/**
 * One-time operator loader: bulk-create projects in ONE workspace via /api/batch.
 *
 * Runs against an ALREADY-RUNNING server (it boots nothing). Dry run is the default —
 * `--yes` is what writes. Re-running the same command resumes: the unique
 * (workspace,key) index is the resume key, so no state file exists to go stale.
 *
 *     PB_SUPERUSER_EMAIL=… PB_SUPERUSER_PASSWORD=… bun scripts/bulk_load_projects.ts \
 *         --input projects.json --workspace "Acme" --owner ops@example.com [--yes]
 *
 * Input: a JSON array of {"name": str, "key": str, "description"?: str}.
 */

import { parse_args } from "./_argparse.ts";
import {
  json_dumps,
  os_error_text,
  py_repr,
  py_rstrip,
  py_str,
  py_strip,
  quote,
  read_text,
  url_error_reason,
  urlencode,
  py_get,
} from "./_py.ts";

// projects.key, verbatim from schema/projects.json — matched AS GIVEN, never normalized to
// it, because decision-043 forbids silently altering a prefix the operator chose.
const KEY_PATTERN = "^[A-Z][A-Z0-9]{0,7}$";
// Python's `$` also matches before one trailing newline.
const KEY_RE = new RegExp(KEY_PATTERN.slice(0, -1) + "\\n?$");
const PER_PAGE = 500;

const EXIT_REFUSED = 1;
const EXIT_CONFIG = 2;

const HELP = `usage: bulk_load_projects.ts [-h] --input INPUT --workspace WORKSPACE
                             --owner OWNER [--chunk CHUNK] [--yes]
                             [--pb-url PB_URL]

One-time operator loader: bulk-create projects in ONE workspace via
/api/batch. Runs against an ALREADY-RUNNING server (it boots nothing). Dry run
is the default — \`--yes\` is what writes. Re-running the same command resumes:
the unique (workspace,key) index is the resume key, so no state file exists to
go stale. PB_SUPERUSER_EMAIL=… PB_SUPERUSER_PASSWORD=… bun
scripts/bulk_load_projects.ts --input projects.json --workspace "Acme" --owner
ops@example.com [--yes] Input: a JSON array of {"name": str, "key": str,
"description"?: str}.

options:
  -h, --help            show this help message and exit
  --input INPUT         JSON array of {name, key, description?}
  --workspace WORKSPACE
                        workspace record id or exact name
  --owner OWNER         users record id or exact email
  --chunk CHUNK         default: the server's batch maxRequests
  --yes                 actually write (default: dry run)
  --pb-url PB_URL       overrides PB_URL
`;

const is_dict = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Python slices by code point.
const head = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

function die(message: string, code: number = EXIT_REFUSED): never {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(code);
}

async function api(
  base: string,
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  let raw: string;
  try {
    r = await fetch(base + path, {
      method,
      headers,
      body: body !== null ? json_dumps(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    raw = await r.text();
  } catch (e) {
    return die(
      `no server answered at ${base} (${url_error_reason(e, true)}) — this loader boots nothing`,
      EXIT_CONFIG,
    );
  }
  if (r.ok) return [r.status, raw ? JSON.parse(raw) : {}];
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, {}];
  }
}

/** A PocketBase filter string literal (double-quoted, escaped). */
function literal(value: unknown): string {
  return '"' + py_str(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

async function superuser_token(base: string, email: string, password: string): Promise<string> {
  const [status, r] = await api(
    base,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    null,
    { identity: email, password },
  );
  const token = is_dict(r) ? r.token : null;
  if (!token) {
    die(`superuser auth failed at ${base} (HTTP ${status}): ${head(py_str(r), 300)}`, EXIT_CONFIG);
  }
  return token;
}

/** The server's OWN batch.maxRequests, read live — a cap restated here would drift. */
async function batch_cap(base: string, token: string): Promise<number> {
  const [status, settings] = await api(base, "GET", "/api/settings", token);
  const batch = is_dict(settings) ? settings.batch : null;
  if (status !== 200 || !is_dict(batch)) {
    die(
      `could not read the server settings (HTTP ${status}): ${head(py_str(settings), 300)}`,
      EXIT_CONFIG,
    );
  }
  if (!batch.enabled) {
    die("the server has the batch API disabled — this loader writes only through it", EXIT_CONFIG);
  }
  const cap = batch.maxRequests;
  if (!Number.isInteger(cap) || cap < 1) {
    die(`the server reports batch maxRequests ${py_repr(cap)} — no usable chunk size`, EXIT_CONFIG);
  }
  return cap;
}

/** A record id taken as-is, else the single record whose `field` equals it exactly. */
async function resolve(
  base: string,
  token: string,
  collection: string,
  field: string,
  value: string,
  flag: string,
): Promise<string> {
  const quoted = quote(py_str(value), "");
  let [status, rec] = await api(
    base,
    "GET",
    `/api/collections/${collection}/records/${quoted}`,
    token,
  );
  if (status === 200 && is_dict(rec) && rec.id) return rec.id;
  const qs = urlencode({ filter: `${field}=${literal(value)}`, perPage: 2 });
  let page: any;
  [status, page] = await api(base, "GET", `/api/collections/${collection}/records?${qs}`, token);
  if (status !== 200) {
    die(`could not list ${collection} (HTTP ${status}): ${head(py_str(page), 300)}`, EXIT_CONFIG);
  }
  const items = page.items || [];
  if (!items.length) {
    die(`${flag} ${py_repr(value)} is neither a ${collection} record id nor an exact ${field}`);
  }
  if (items.length > 1) {
    die(
      `${flag} ${py_repr(value)} matches ${items.length} ${collection} records by ${field} — use the id`,
    );
  }
  return items[0].id;
}

/** {key: name} for every keyed project in the workspace, all pages. */
async function workspace_projects(
  base: string,
  token: string,
  workspace_id: string,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  let page_no = 1;
  while (true) {
    const qs = urlencode({
      filter: `workspace=${literal(workspace_id)}`,
      perPage: PER_PAGE,
      page: page_no,
      fields: "id,key,name",
    });
    const [status, page] = await api(base, "GET", `/api/collections/projects/records?${qs}`, token);
    if (status !== 200) {
      die(`could not list projects (HTTP ${status}): ${head(py_str(page), 300)}`, EXIT_CONFIG);
    }
    for (const item of page.items || []) {
      if (item.key) out.set(item.key, item.name ?? null);
    }
    if (page_no >= (page.totalPages || 1)) return out;
    page_no += 1;
  }
}

function load_input(path: string): any[] {
  let rows: any;
  try {
    rows = JSON.parse(read_text(path));
  } catch (e) {
    if (e instanceof SyntaxError)
      die(`--input ${path} is not valid JSON: ${e.message}`, EXIT_CONFIG);
    if (e instanceof Error && e.name === "UnicodeDecodeError") throw e;
    die(`could not read --input ${path}: ${os_error_text(e)}`, EXIT_CONFIG);
  }
  if (!Array.isArray(rows)) {
    die(`--input ${path} must hold a JSON ARRAY of project objects`, EXIT_CONFIG);
  }
  return rows;
}

/** Every complaint about every row, before a single write is attempted. */
function validate(rows: any[]): string[] {
  const errors: string[] = [];
  const first_seen = new Map<string, number>();
  rows.forEach((row, idx) => {
    const i = idx + 1;
    if (!is_dict(row)) {
      errors.push(`row ${i}: not a JSON object`);
      return;
    }
    const name = row.name;
    if (typeof name !== "string" || !py_strip(name)) {
      errors.push(`row ${i}: missing or empty 'name'`);
    }
    const key = row.key;
    if (typeof key !== "string" || !key) {
      errors.push(`row ${i}: missing or empty 'key' — a project prefix is explicit`);
    } else if (!KEY_RE.test(key)) {
      errors.push(
        `row ${i}: key ${py_repr(key)} does not match ${KEY_PATTERN} as given ` +
          `(a chosen prefix is never altered for you)`,
      );
    } else if (first_seen.has(key)) {
      errors.push(`row ${i}: key ${py_repr(key)} duplicates row ${first_seen.get(key)}`);
    } else {
      first_seen.set(key, i);
    }
    if (Object.hasOwn(row, "description") && typeof row.description !== "string") {
      errors.push(`row ${i}: 'description' must be a string`);
    }
  });
  return errors;
}

/** (rows still to create, already-loaded row numbers, ambiguity refusals). */
function partition(rows: any[], existing: Map<string, any>): [[number, any][], number[], string[]] {
  const pending: [number, any][] = [];
  const loaded: number[] = [];
  const conflicts: string[] = [];
  rows.forEach((row, idx) => {
    const i = idx + 1;
    const key = row.key;
    if (!existing.has(key)) {
      pending.push([i, row]);
    } else if (existing.get(key) === row.name) {
      loaded.push(i);
    } else {
      conflicts.push(
        `row ${i}: key ${py_repr(key)} already exists in this workspace under the name ` +
          `${py_repr(existing.get(key))}, not ${py_repr(row.name)}`,
      );
    }
  });
  return [pending, loaded, conflicts];
}

/** The first server complaint in a batch response, or null when every op returned 200. */
function first_error(status: number, resp: any): string | null {
  if (status !== 200) {
    const requests = is_dict(resp) ? (resp.data || {}).requests : null;
    if (is_dict(requests) && Object.keys(requests).length) {
      const as_int = (k: string) => (/^\d+$/.test(k) ? Number(k) : 0);
      const idx = Object.keys(requests).reduce((a, b) => (as_int(b) < as_int(a) ? b : a));
      return `op #${idx}: ${head(json_dumps(requests[idx]), 400)}`;
    }
    return `HTTP ${status}: ${head(json_dumps(resp), 400)}`;
  }
  if (!Array.isArray(resp)) {
    return `unexpected batch response shape: ${head(py_str(resp), 400)}`;
  }
  for (const [i, item] of resp.entries()) {
    if (!is_dict(item) || item.status !== 200) {
      return `op #${i}: ${head(json_dumps(item), 400)}`;
    }
  }
  return null;
}

function parse_cli(argv: string[]) {
  const usage = HELP.slice(0, HELP.indexOf("\n\n"));
  const args = parse_args(
    usage,
    HELP,
    [
      ["--input", "store", "input", true],
      ["--workspace", "store", "workspace", true],
      ["--owner", "store", "owner", true],
      ["--chunk", "store", "chunk", false, "int"],
      ["--yes", "store_true", "yes"],
      ["--pb-url", "store", "pb_url"],
    ],
    { input: null, workspace: null, owner: null, chunk: null, yes: false, pb_url: null },
    argv,
  );
  return args;
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parse_cli(argv);
  const base = py_rstrip(args.pb_url || process.env.PB_URL || "http://127.0.0.1:8090", "/");

  if (args.chunk !== null && args.chunk < 1) {
    die(`--chunk ${args.chunk} is not a positive number of requests`);
  }

  const email = process.env.PB_SUPERUSER_EMAIL ?? "";
  const password = process.env.PB_SUPERUSER_PASSWORD ?? "";
  const missing = [
    ["PB_SUPERUSER_EMAIL", email],
    ["PB_SUPERUSER_PASSWORD", password],
  ]
    .filter(([, v]) => !v)
    .map(([n]) => n);
  if (missing.length) {
    die(
      `missing ${missing.join(", ")} — this loader authenticates as a superuser ` +
        `(the key-minting hooks still run; only the rate limiter is bypassed)`,
      EXIT_CONFIG,
    );
  }

  const rows = load_input(args.input);
  const errors = validate(rows);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`  · ${e}\n`);
    die(`${errors.length} invalid row(s) in ${args.input} — nothing was written`);
  }

  const token = await superuser_token(base, email, password);
  const cap = await batch_cap(base, token);
  const chunk_size: number = args.chunk === null ? cap : args.chunk;
  if (chunk_size > cap) {
    die(
      `--chunk ${chunk_size} exceeds the server's batch maxRequests ` +
        `(${cap}) — a larger chunk is rejected whole`,
    );
  }
  const workspace_id = await resolve(
    base,
    token,
    "workspaces",
    "name",
    args.workspace,
    "--workspace",
  );
  const owner_id = await resolve(base, token, "users", "email", args.owner, "--owner");
  const existing = await workspace_projects(base, token, workspace_id);
  const [pending, loaded, conflicts] = partition(rows, existing);
  if (conflicts.length) {
    for (const c of conflicts) process.stderr.write(`  · ${c}\n`);
    die(`${conflicts.length} ambiguous key(s) — nothing was written`);
  }

  const chunks: [number, any][][] = [];
  for (let i = 0; i < pending.length; i += chunk_size)
    chunks.push(pending.slice(i, i + chunk_size));
  console.log(`server:    ${base}   batch maxRequests: ${cap} (read from the server)`);
  console.log(`workspace: ${workspace_id}   owner: ${owner_id}`);
  console.log(
    `plan:      ${rows.length} input row(s) — ${pending.length} to create, ` +
      `${loaded.length} already loaded, ${chunks.length} chunk(s) of at most ${chunk_size}`,
  );
  for (const [n0, chunk] of chunks.entries()) {
    const keys = chunk.map(([, row]) => row.key).join(", ");
    console.log(
      `  chunk ${n0 + 1}/${chunks.length}  input rows ${chunk[0][0]}-${chunk[chunk.length - 1][0]}  ${keys}`,
    );
  }
  if (!args.yes) {
    console.log("dry run — nothing written. Re-run with --yes to load.");
    return 0;
  }

  const url = "/api/collections/projects/records";
  for (const [n0, chunk] of chunks.entries()) {
    const n = n0 + 1;
    const [lo, hi] = [chunk[0][0], chunk[chunk.length - 1][0]];
    const requests = chunk.map(([, row]) => ({
      method: "POST",
      url,
      body: {
        name: row.name,
        key: row.key,
        description: py_get(row, "description", ""),
        owner: owner_id,
        workspace: workspace_id,
      },
    }));
    const started = performance.now();
    const [status, resp] = await api(base, "POST", "/api/batch", token, { requests });
    const elapsed = performance.now() - started;
    const failure = first_error(status, resp);
    if (failure) {
      die(
        `chunk ${n}/${chunks.length} (input rows ${lo}-${hi}) failed after ` +
          `${elapsed.toFixed(0)} ms and rolled back WHOLE — earlier chunks are committed. ` +
          `First server error: ${failure}. Fix the input and re-run the same command.`,
      );
    }
    console.log(
      `  chunk ${n}/${chunks.length}  input rows ${lo}-${hi}  ` +
        `${chunk.length} created  ${elapsed.toFixed(0)} ms`,
    );
  }

  const after = await workspace_projects(base, token, workspace_id);
  const mismatches = rows.flatMap((row, idx) =>
    (after.get(row.key) ?? null) !== row.name
      ? [
          `row ${idx + 1}: key ${py_repr(row.key)} reads back as ${py_repr(after.get(row.key))}, ` +
            `expected ${py_repr(row.name)}`,
        ]
      : [],
  );
  if (mismatches.length) {
    for (const m of mismatches) process.stderr.write(`  · ${m}\n`);
    die(`${mismatches.length} input row(s) are not in the workspace as written`);
  }
  console.log(
    `verified:  all ${rows.length} input key(s) present with their names; ` +
      `${after.size} keyed project(s) now in the workspace`,
  );
  return 0;
}

process.exit(await main());

#!/usr/bin/env bun
// Operator break-glass: hand a workspace to an active member as SUPERUSER (kca7).
//
// Runs against an ALREADY-RUNNING server (it boots nothing). The transfer route requires a
// superuser caller to name the owner it believes is current, so this READS that owner and
// sends it as `current_owner` — the operator never types it. If the owner changed between
// the read and the send, the server refuses and this reports the refusal rather than
// retrying: the point of the check is that a caller who cannot say who owns the workspace
// is not in a position to hand it to anyone (prior art: GitHub Contents API `sha`, HTTP
// If-Match).
//
//     PB_URL=… PB_SUPERUSER_EMAIL=… PB_SUPERUSER_PASSWORD=… \
//         bun scripts/transfer_workspace_ownership.ts --workspace <id> --to <id-or-email>
//
// Dry run is the default; `--yes` is what writes. Bun built-ins only.

import { parse_args } from "./_argparse.ts";
import { py_repr, url_error_reason, urlencode } from "./_py.ts";

const EXIT_REFUSED = 1;
const EXIT_CONFIG = 2;

const USAGE = `usage: transfer_workspace_ownership.ts [-h] --workspace WORKSPACE --to TO
                                       [--yes]`;
const HELP = `${USAGE}

Operator break-glass: hand a workspace to an active member as SUPERUSER
(kca7).

options:
  -h, --help            show this help message and exit
  --workspace WORKSPACE
                        workspaces record id
  --to TO               incoming owner: users record id or email
  --yes                 actually transfer (default: dry run)
`;

function die(message: string, code = EXIT_REFUSED): never {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(code);
}

export async function api(
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
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    raw = await r.text();
  } catch (e) {
    return die(`cannot reach ${base}: ${url_error_reason(e, true)}`, EXIT_CONFIG);
  }
  if (!r.ok) {
    try {
      return [r.status, raw ? JSON.parse(raw) : {}];
    } catch {
      return [r.status, {}];
    }
  }
  return [r.status, raw ? JSON.parse(raw) : {}];
}

export async function superuser_token(
  base: string,
  email: string,
  password: string,
): Promise<string> {
  const [status, body] = await api(
    base,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    null,
    { identity: email, password },
  );
  if (status !== 200 || !("token" in body)) {
    die(`superuser auth failed at ${base}: ${status} ${body.message ?? ""}`, EXIT_CONFIG);
  }
  return body.token;
}

/** The workspace owner AS IT STANDS NOW — the value sent back as `current_owner`. */
export async function read_owner(base: string, token: string, workspace: string): Promise<string> {
  const [status, body] = await api(
    base,
    "GET",
    `/api/collections/workspaces/records/${workspace}`,
    token,
  );
  if (status !== 200) die(`workspace ${workspace}: ${status} ${body.message ?? ""}`);
  return body.owner || "";
}

/** A users record id, given an id or an email. Superuser reads make email filterable. */
export async function resolve_user(base: string, token: string, who: string): Promise<string> {
  let [status, body] = await api(base, "GET", `/api/collections/users/records/${who}`, token);
  if (status === 200) return body.id;
  // PB filter string literals escape an embedded quote with a backslash.
  const escaped = who.replaceAll("'", "\\'");
  const qs = urlencode({ filter: `email='${escaped}'`, perPage: 2 });
  [status, body] = await api(base, "GET", `/api/collections/users/records?${qs}`, token);
  const items = body.items || [];
  if (items.length !== 1) {
    die(`--to ${py_repr(who)} matched ${items.length} users; give a record id or an exact email`);
  }
  return items[0].id;
}

/** POST the handover. Split from read_owner so the stale-owner path is drivable. */
export function send_transfer(
  base: string,
  token: string,
  workspace: string,
  user: string,
  current_owner: string,
): Promise<[number, any]> {
  return api(base, "POST", `/api/tracker/workspaces/${workspace}/transfer-ownership`, token, {
    user,
    current_owner,
  });
}

export async function main(): Promise<number> {
  const args = parse_args(
    USAGE,
    HELP,
    [
      ["--workspace", "store", "workspace", true],
      ["--to", "store", "to", true],
      ["--yes", "store_true", "yes"],
    ],
    { yes: false },
  );

  const base = (process.env.PB_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
  const email = process.env.PB_SUPERUSER_EMAIL;
  const password = process.env.PB_SUPERUSER_PASSWORD;
  if (!email || !password) {
    die("PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD must be set", EXIT_CONFIG);
  }

  const token = await superuser_token(base, email, password);
  const target = await resolve_user(base, token, args.to);
  const current_owner = await read_owner(base, token, args.workspace);
  console.log(`workspace ${args.workspace}: owner is ${current_owner}, handing to ${target}`);
  if (!args.yes) {
    console.log("dry run — re-run with --yes to transfer");
    return 0;
  }

  const [status, body] = await send_transfer(base, token, args.workspace, target, current_owner);
  if (status !== 200) die(`${status} ${body.message ?? ""}`);
  console.log(`transferred: workspace ${args.workspace} is now owned by ${target}`);
  return 0;
}

if (import.meta.main) process.exit(await main());

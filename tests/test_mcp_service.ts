#!/usr/bin/env bun
/**
 * hosted-mcp-endpoint MCP service (services/mcp): Protected Resource Metadata, the 401 challenge,
 * both protocol legs (2025-era stateless and 2026-07-28), tools filtered by the key's scope, the
 * write-tool scope gate, Origin and method refusals, per-key and per-address limits, the API
 * exemption of the service's own calls, and 503 when the API is down.
 *
 * Fully self-contained clean-room server plus the service. Ports 8205, 8206, 8207 + PB_PORT_OFFSET.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import { TOOLS } from "../clients/tm/src/mcp.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const TM = path.join(REPO_ROOT, "clients", "tm", "tm.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8205 + PORT_OFFSET;
const MCP_PORT = 8206 + PORT_OFFSET;
const MCP_INTERNAL_PORT = 8207 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MCP = `http://127.0.0.1:${MCP_PORT}`;
const PRM_URL = `${MCP}/.well-known/oauth-protected-resource/mcp`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const SECRET = "s3cret";
const CHALLENGE = `Bearer resource_metadata="${PRM_URL}", scope="read write"`;
const PRM_DOC = {
  resource: `${MCP}/mcp`,
  authorization_servers: [BASE_URL],
  scopes_supported: ["read", "write"],
  bearer_methods_supported: ["header"],
  resource_name: "Task tracker",
};

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

async function api(
  method: string,
  url: string,
  token: string | null = null,
  body: any = null,
  extra: Record<string, string> = {},
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : {}];
}

type Raw = { status: number; headers: Headers; text: string; json: any };

const ACCEPT = "application/json, text/event-stream";

/** One raw request to the service; `key` goes out as `Bearer <key>`. */
async function raw(
  url: string,
  opts: { method?: string; key?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Raw> {
  const headers: Record<string, string> = {
    Accept: ACCEPT,
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  const r = await fetch(MCP + url, {
    method: opts.method ?? "POST",
    headers,
    body:
      opts.body === undefined
        ? undefined
        : typeof opts.body === "string"
          ? opts.body
          : JSON.stringify(opts.body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, text, json };
}

const H2025 = { "MCP-Protocol-Version": "2025-11-25" };
let next_id = 1;

function msg(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: "2.0", id: next_id++, method, params };
}

function list_2025(key: string, headers: Record<string, string> = {}): Promise<Raw> {
  return raw("/mcp", { key, headers: { ...H2025, ...headers }, body: msg("tools/list") });
}

function call_2025(key: string, name: string, args: Record<string, unknown>): Promise<Raw> {
  return raw("/mcp", {
    key,
    headers: H2025,
    body: msg("tools/call", { name, arguments: args }),
  });
}

const META_2026 = (version = "2026-07-28") => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "suite", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

/** A 2026-07-28 request: its headers and `_meta`; `drop` omits one header. */
function req_2026(
  key: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { version?: string; drop?: string } = {},
): Promise<Raw> {
  const version = opts.version ?? "2026-07-28";
  const headers: Record<string, string> = { "MCP-Protocol-Version": version, "Mcp-Method": method };
  if (method === "tools/call") headers["Mcp-Name"] = String(params.name);
  if (opts.drop) delete headers[opts.drop];
  return raw("/mcp", {
    key,
    headers,
    body: msg(method, { ...params, _meta: META_2026(version) }),
  });
}

async function connect_http(key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "test_mcp_service", version: "0" });
  await client.connect(transport);
  return client;
}

async function statuses(n: number, send: () => Promise<Raw>): Promise<Raw[]> {
  const out: Raw[] = [];
  for (let i = 0; i < n; i++) out.push(await send());
  return out;
}

function retry_after_ok(r: Raw | undefined): boolean {
  const v = r?.headers.get("Retry-After") ?? "";
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 60;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-mcp-service-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

const SERVICE_ENV: Record<string, string | undefined> = {
  ...process.env,
  MCP_HOST: "127.0.0.1",
  PORT: String(MCP_PORT),
  MCP_INTERNAL_PORT: String(MCP_INTERNAL_PORT),
  PB_INTERNAL_URL: BASE_URL,
  PB_PUBLIC_URL: BASE_URL,
  MCP_PUBLIC_URL: MCP,
  MCP_INTERNAL_SECRET: SECRET,
  MCP_ALLOWED_ORIGINS: "",
};

let server: roomkit.Room | null = null;
let service: ReturnType<typeof Bun.spawn> | null = null;
let service_log = -1;
const clients: Client[] = [];
try {
  console.log("\n── a missing required variable stops the service before it listens ──");
  const missing_log_path = path.join(S, "mcp-missing-env.log");
  const missing_log = fs.openSync(missing_log_path, "w");
  const { PB_INTERNAL_URL: _, ...no_pb_url } = SERVICE_ENV;
  const missing = Bun.spawn([process.execPath, "services/mcp/main.ts"], {
    cwd: REPO_ROOT,
    env: no_pb_url,
    stdout: "ignore",
    stderr: missing_log,
  });
  const missing_exit = await Promise.race([
    missing.exited,
    Bun.sleep(10_000).then(() => "still running"),
  ]);
  if (missing_exit !== 1) missing.kill();
  fs.closeSync(missing_log);
  check(
    "missing_env_exits: exit 1, stderr names PB_INTERNAL_URL",
    [missing_exit, fs.readFileSync(missing_log_path, "utf8").includes("PB_INTERNAL_URL")],
    [1, true],
  );

  run_checked(
    [
      PB_BIN,
      "superuser",
      "upsert",
      SU_EMAIL,
      SU_PASSWORD,
      "--dir",
      DATA_DIR,
      "--migrationsDir",
      MIG_DIR,
    ],
    { cwd: REPO_ROOT, capture_output: true },
  );
  process.env.MCP_INTERNAL_SECRET = SECRET;
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  console.log("\n── fixtures: Alice, her project, a read key R and a write key W ──");
  let [s, r] = await api("POST", "/api/collections/users/records", su, {
    email: "alice@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Alice",
    verified: true,
    approved: true,
  });
  check("fixture Alice created", s, 200);
  [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "alice@example.com",
    password: "test123456",
  });
  check("Alice signs in", s, 200);
  const alice: string = r.token;
  const ALICE_ID: string = r.record?.id;
  [, r] = await api("GET", "/api/collections/projects/records?perPage=5", alice);
  const PROJECT: string = r.items?.find((p: any) => p.name)?.id ?? "";
  check("Alice has a provisioned project", Boolean(PROJECT), true);

  async function mint(scope: "read" | "write", name: string): Promise<{ key: string; id: string }> {
    const [ms, mr] = await api("POST", "/api/collections/api_keys/records", alice, {
      name,
      scope,
    });
    check(`fixture: key ${name} (${scope}) minted`, [ms, /^tmk_/.test(mr.key ?? "")], [200, true]);
    return { key: mr.key, id: mr.id };
  }
  const W = (await mint("write", "W")).key;
  const R = (await mint("read", "R")).key;
  const K = await mint("write", "K");
  const L = (await mint("read", "L")).key;
  const M = (await mint("read", "M")).key;
  const F = (await mint("read", "F")).key;

  console.log("\n── the service starts ──");
  await roomkit.require_free_port(MCP_PORT);
  await roomkit.require_free_port(MCP_INTERNAL_PORT);
  service_log = fs.openSync(path.join(S, "mcp.log"), "w");
  service = Bun.spawn([process.execPath, "services/mcp/main.ts"], {
    cwd: REPO_ROOT,
    env: SERVICE_ENV,
    stdout: service_log,
    stderr: service_log,
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(PRM_URL)
      .then((x) => x.status === 200)
      .catch(() => false);
    if (!up) await Bun.sleep(100);
  }
  if (!up) {
    throw new roomkit.SystemExit(
      `service never served ${PRM_URL}:\n${fs.readFileSync(path.join(S, "mcp.log"), "utf8")}`,
    );
  }

  console.log("\n── Protected Resource Metadata ──");
  let x = await raw("/.well-known/oauth-protected-resource/mcp", { method: "GET" });
  check("prm_doc: 200, D10's document", [x.status, x.json], [200, PRM_DOC]);
  x = await raw("/.well-known/oauth-protected-resource", { method: "GET" });
  check("prm_root_doc: 200, the same document", [x.status, x.json], [200, PRM_DOC]);
  x = await raw("/.well-known/oauth-protected-resource/mcp", { method: "POST", body: {} });
  check(
    "prm_post_405: 405, Allow GET, HEAD",
    [x.status, x.headers.get("Allow")],
    [405, "GET, HEAD"],
  );
  x = await raw("/.well-known/oauth-protected-resource/mcp", { method: "HEAD" });
  check("prm_head: 200, empty body", [x.status, x.text], [200, ""]);

  console.log("\n── the 401 challenge ──");
  const init = msg("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "suite", version: "0" },
  });
  x = await raw("/mcp", { body: init });
  check(
    "no_credential_401: 401, challenge without error, code unauthorized",
    [x.status, x.headers.get("WWW-Authenticate"), x.json?.error?.code],
    [401, CHALLENGE, "unauthorized"],
  );
  x = await raw(`/mcp?api_key=${W}`, { body: init });
  check(
    "query_key_401: a key in the query string is not read",
    [x.status, x.headers.get("WWW-Authenticate"), x.json?.error?.code],
    [401, CHALLENGE, "unauthorized"],
  );
  const INVALID = `${CHALLENGE}, error="invalid_token"`;
  x = await raw("/mcp", { key: `tmk_${"x".repeat(40)}`, body: init });
  check(
    "bad_key_401: 401 invalid_token, challenge with error",
    [x.status, x.headers.get("WWW-Authenticate"), x.json?.error?.code],
    [401, INVALID, "invalid_token"],
  );
  x = await raw("/mcp", { key: alice, body: init });
  check(
    "user_token_401: a PocketBase user token is refused",
    [x.status, x.json?.error?.code],
    [401, "invalid_token"],
  );
  x = await list_2025(K.key);
  const k_before = x.status;
  [s] = await api("PATCH", `/api/collections/api_keys/records/${K.id}`, alice, { revoked: true });
  x = await list_2025(K.key);
  check(
    "revoked_key_401: 200 before, revoke 200, then 401 invalid_token",
    [k_before, s, x.status, x.json?.error?.code],
    [200, 200, 401, "invalid_token"],
  );

  console.log("\n── 2025-era leg (SDK 1.32.2 client) ──");
  const w = await connect_http(W);
  clients.push(w);
  x = await raw("/mcp", { key: W, body: init });
  check(
    "initialize_2025: connects; serverInfo tm; no Mcp-Session-Id",
    [w.getServerVersion()?.name, x.status, x.headers.get("Mcp-Session-Id")],
    ["tm", 200, null],
  );
  const read_names = TOOLS.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name);
  const rc = await connect_http(R);
  clients.push(rc);
  check(
    "tools_list_read_key: names are the read-only filter of TOOLS",
    (await rc.listTools()).tools.map((t) => t.name),
    read_names,
  );
  check(
    "tools_list_write_key: every TOOLS name, in catalog order",
    (await w.listTools()).tools.map((t) => t.name),
    TOOLS.map((t) => t.name),
  );
  const created: any = await w.callTool({
    name: "tm_create",
    arguments: { project: PROJECT, title: "via mcp" },
  });
  const item = JSON.parse(created.content?.[0]?.text ?? "null");
  check(
    "create_as_key_user: success, author is Alice",
    [created.isError ?? false, item?.title, item?.author],
    [false, "via mcp", ALICE_ID],
  );
  const stdio = new Client({ name: "test_mcp_service", version: "0" });
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [TM, "mcp"],
      cwd: S,
      env: { PATH: process.env.PATH ?? "", HOME: S, TM_URL: BASE_URL, TM_API_KEY: W },
      stderr: "pipe",
    }),
  );
  clients.push(stdio);
  const over_http: any = await w.callTool({ name: "tm_show", arguments: { id: item?.id } });
  const over_stdio: any = await stdio.callTool({ name: "tm_show", arguments: { id: item?.id } });
  check(
    "same_result_as_stdio: tm_show content identical over HTTP and stdio",
    [over_http.isError ?? false, Bun.deepEquals(over_http.content, over_stdio.content, true)],
    [false, true],
  );
  x = await raw("/mcp", {
    key: W,
    headers: H2025,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  check("initialized_202: 202, no body", [x.status, x.text], [202, ""]);

  console.log("\n── 2026-07-28 leg ──");
  x = await req_2026(W, "server/discover");
  check(
    "discover_2026: 200 JSON, supportedVersions has 2026-07-28",
    [
      x.status,
      x.headers.get("Content-Type")?.startsWith("application/json"),
      (x.json?.result?.supportedVersions ?? []).includes("2026-07-28"),
    ],
    [200, true, true],
  );
  x = await req_2026(W, "tools/list");
  check(
    "tools_list_2026_cache: ttlMs 300000, cacheScope private",
    [x.status, x.json?.result?.ttlMs, x.json?.result?.cacheScope],
    [200, 300000, "private"],
  );
  x = await req_2026(W, "tools/list", {}, { drop: "Mcp-Method" });
  check(
    "header_mismatch_2026: no Mcp-Method → 400 -32020",
    [x.status, x.json?.error?.code],
    [400, -32020],
  );
  x = await req_2026(W, "tools/list", {}, { version: "2027-01-01" });
  check(
    "unsupported_2026_32022: 2027-01-01 → 400 -32022",
    [x.status, x.json?.error?.code],
    [400, -32022],
  );
  x = await req_2026(R, "tools/call", { name: "tm_create", arguments: { title: "t" } });
  check(
    "read_key_write_tool_403_2026: 403 insufficient_scope",
    [x.status, x.json?.error?.code],
    [403, "insufficient_scope"],
  );

  console.log("\n── scope gate and tool results ──");
  x = await call_2025(R, "tm_create", { title: "t", project: PROJECT });
  const www = x.headers.get("WWW-Authenticate") ?? "";
  check(
    "read_key_write_tool_403: 403, insufficient_scope challenge with scope",
    [
      x.status,
      x.json?.error?.code,
      www.includes('error="insufficient_scope"'),
      www.includes('scope="read write"'),
    ],
    [403, "insufficient_scope", true, true],
  );
  x = await call_2025(W, "nope", {});
  check("unknown_tool_32602: JSON-RPC -32602", x.json?.error?.code, -32602);
  x = await call_2025(W, "tm_show", { id: "nope0000000000x" });
  check(
    "tool_failure_structured: isError, status 404",
    [x.json?.result?.isError, x.json?.result?.structuredContent?.error?.status],
    [true, 404],
  );

  console.log("\n── refusals before the SDK ──");
  const g = await raw("/mcp", { method: "GET", key: W });
  const d = await raw("/mcp", { method: "DELETE", key: W });
  check(
    "get_delete_405: 405, Allow POST, empty body (GET, DELETE)",
    [g.status, g.headers.get("Allow"), g.text, d.status, d.headers.get("Allow"), d.text],
    [405, "POST", "", 405, "POST", ""],
  );
  x = await raw("/mcp", { key: W, headers: H2025, body: [msg("tools/list"), msg("tools/list")] });
  check("batch_400: 400 -32600", [x.status, x.json?.error?.code], [400, -32600]);
  x = await raw("/mcp", {
    key: W,
    headers: { ...H2025, "Content-Type": "text/plain" },
    body: msg("tools/list"),
  });
  check("not_json_400: text/plain → 400 -32600", [x.status, x.json?.error?.code], [400, -32600]);
  x = await raw("/mcp", {
    key: W,
    headers: { ...H2025, Accept: "application/json" },
    body: msg("tools/list"),
  });
  check(
    "accept_406: Accept json only → 406 -32600",
    [x.status, x.json?.error?.code],
    [406, -32600],
  );
  x = await raw("/api/tracker/me", { method: "GET", key: W });
  check("stray_path_404: 404 not_found", [x.status, x.json?.error?.code], [404, "not_found"]);

  console.log("\n── Origin ──");
  x = await list_2025(W, { Origin: "https://attacker.example" });
  check(
    "origin_refused: 403 origin_not_allowed, no Access-Control-Allow-Origin",
    [x.status, x.json?.error?.code, x.headers.get("Access-Control-Allow-Origin")],
    [403, "origin_not_allowed", null],
  );
  const cors = (y: Raw) => [
    y.headers.get("Access-Control-Allow-Origin"),
    y.headers.get("Access-Control-Expose-Headers"),
    y.headers.get("Vary"),
  ];
  const CORS = ["https://claude.ai", "WWW-Authenticate, Retry-After", "Origin"];
  x = await list_2025(W, { Origin: "https://claude.ai" });
  check("origin_allowed: 200 with the three CORS headers", [x.status, ...cors(x)], [200, ...CORS]);
  x = await raw("/mcp", { headers: { Origin: "https://claude.ai" }, body: init });
  check(
    "origin_allowed: no credential → 401 with the same headers",
    [x.status, ...cors(x)],
    [401, ...CORS],
  );
  x = await list_2025(W);
  check("no_origin_served: 200", x.status, 200);
  x = await raw("/mcp", { method: "OPTIONS", headers: { Origin: "https://claude.ai" } });
  const plain = await raw("/mcp", { method: "OPTIONS" });
  check(
    "options_preflight: 204 Allow POST with CORS; without Origin no CORS",
    [
      x.status,
      x.headers.get("Allow"),
      x.headers.get("Access-Control-Allow-Origin"),
      x.headers.get("Access-Control-Allow-Methods"),
      plain.status,
      plain.headers.get("Access-Control-Allow-Origin"),
    ],
    [204, "POST", "https://claude.ai", "POST", 204, null],
  );

  console.log("\n── rate limits ──");
  let run = await statuses(31, () =>
    raw("/mcp", { headers: { "X-Real-IP": "198.51.100.1" }, body: init }),
  );
  check(
    "anon_limit_429: 30 × 401, then 429 with Retry-After 1-60",
    [run.slice(0, 30).every((y) => y.status === 401), run[30]?.status, retry_after_ok(run[30])],
    [true, 429, true],
  );
  run = await statuses(31, () =>
    raw("/mcp", {
      key: `tmk_${"y".repeat(40)}`,
      headers: { "X-Real-IP": "198.51.100.2" },
      body: init,
    }),
  );
  check(
    "bad_key_limit_429: 30 × 401, then 429",
    [run.slice(0, 30).every((y) => y.status === 401), run[30]?.status],
    [true, 429],
  );
  const t0 = performance.now();
  run = await statuses(300, () => list_2025(L, { "X-Real-IP": "198.51.100.3" }));
  const ms = performance.now() - t0;
  console.log(
    `  ⏱  key_limit_per_key: 300 requests in ${(ms / 1000).toFixed(2)} s, ${(ms / 300).toFixed(1)} ms each`,
  );
  x = await list_2025(L, { "X-Real-IP": "198.51.100.3" });
  const other = await list_2025(R, { "X-Real-IP": "198.51.100.3" });
  check(
    "key_limit_per_key: 300 × 200, 301st 429 with Retry-After, R same address 200",
    [run.every((y) => y.status === 200), x.status, retry_after_ok(x), other.status],
    [true, 429, true, 200],
  );
  run = await statuses(31, () =>
    raw("/mcp", {
      key: `tmk_${"v".repeat(40)}`,
      headers: { "X-Real-IP": "198.51.100.5" },
      body: init,
    }),
  );
  const valid = await list_2025(M, { "X-Real-IP": "198.51.100.5" });
  const invented = await raw("/mcp", {
    key: `tmk_${"u".repeat(40)}`,
    headers: { "X-Real-IP": "198.51.100.5" },
    body: init,
  });
  check(
    "flooded_address_valid_key: 31st 429; valid key 200; another invented key 429",
    [run[30]?.status, valid.status, invented.status],
    [429, 200, 429],
  );

  console.log("\n── the service's own API calls are exempt from the API's per-address limits ──");
  const [, settings] = await api("GET", "/api/settings", su);
  const original_rules = settings.rateLimits.rules;
  [s] = await api("PATCH", "/api/settings", su, {
    rateLimits: {
      ...settings.rateLimits,
      rules: original_rules.map((rule: any) =>
        rule.label === "/api/" ? { ...rule, maxRequests: 5, duration: 60 } : rule,
      ),
    },
  });
  check("fixture: the /api/ rule is 5 per 60 s", s, 200);
  const via_service = await statuses(10, () => list_2025(F));
  const direct: number[] = [];
  for (let i = 0; i < 10; i++) {
    const [ds] = await api("GET", "/api/tracker/me", F, null, { "X-Real-IP": "198.51.100.4" });
    direct.push(ds);
  }
  check(
    "pb_exempt_via_service: 10 × 200 over the service; direct 429 by the 6th",
    [via_service.map((y) => y.status), direct.indexOf(429) >= 0 && direct.indexOf(429) <= 5],
    [Array(10).fill(200), true],
  );
  [s] = await api(
    "PATCH",
    "/api/settings",
    su,
    { rateLimits: { ...settings.rateLimits, rules: original_rules } },
    { "X-Real-IP": "198.51.100.6" },
  );
  check("fixture: the rules are restored", s, 200);

  console.log("\n── the API is down ──");
  await roomkit.stop(server);
  server = null;
  x = await list_2025(W);
  check(
    "api_down_503: 503 unavailable, Retry-After 5",
    [x.status, x.json?.error?.code, x.headers.get("Retry-After")],
    [503, "unavailable", "5"],
  );
} finally {
  for (const c of clients) await c.close().catch(() => {});
  if (service !== null) {
    service.kill();
    await service.exited;
  }
  if (service_log >= 0) fs.closeSync(service_log);
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ all checks passed");

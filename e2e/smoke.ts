#!/usr/bin/env bun
/**Smoke suite: live probes against the production images (Dockerfile, services/mcp/Dockerfile) booted by deploy/local/compose.yaml.

Usage: `make smoke`, or `bun e2e/smoke.ts [--root DIR]` (DIR: the tree to build, default this repo).
Each run builds the images, publishes them on Docker-picked 127.0.0.1 ports under its own compose
project `pb-smoke-<pid>` with a fresh volume, runs the probes in order, and always ends with
`down -v --rmi local`. It never touches the developer's `pb-local` project or port 8090.
A later behaviour probe is one async function in PROBES; a 429 masks signup for 60s, so the
rate-limit probe stays last.

Not covered: OAuth sign-in (needs a live provider). A smoke run copies e2e/fixtures/smoke_key_user.js
into the image and restarts it, so the key probes have one approved, verified user; keyed paths
beyond those probes stay battery-only. Mail (signup verification, OTP): it would
take an SMTP host/port env override in pb_hooks/mail.pb.js (today it hardcodes smtp.resend.com
behind RESEND_API_KEY), scripts/smtp_sink.ts listening on a host-gateway address instead of
127.0.0.1, and `extra_hosts: host-gateway` in the compose file.
*/

import path from "node:path";
import { authorize_params, field } from "../tests/oauthkit.ts";

const args = process.argv.slice(2);
const ROOT = path.resolve(
  args[0] === "--root" && args[1] ? args[1] : path.join(import.meta.dir, ".."),
);
const PROJECT = `pb-smoke-${process.pid}`;
const COMPOSE = [
  "docker",
  "compose",
  "-p",
  PROJECT,
  "-f",
  path.join(ROOT, "deploy/local/compose.yaml"),
];
const HEALTH_TIMEOUT_MS = 120_000;
const SIGNUP_LIMIT = 5; // settings rateLimits rule "POST /api/collections/users/records"
const SIGNIN_LIMIT = 10; // settings rateLimits rule "POST /api/collections/users/auth-with-password"

// The host ports compose publishes (0: Docker picks); compose builds the public URLs from them.
const PUBLISH = { PB_PORT: "0", MCP_PORT: "0" };
const MCP_RESOURCE = `http://127.0.0.1:${PUBLISH.MCP_PORT}/mcp`;
let BASE_URL = "";
let MCP_URL = "";
let failures = 0;

function check(label: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✅" : "❌ MISMATCH"} ${label}: got ${JSON.stringify(got)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`,
  );
}

function run(cmd: string[], env: Record<string, string> = {}): { code: number; out: string } {
  if (!Bun.which(cmd[0])) return { code: 127, out: `${cmd[0]}: not found on PATH` };
  const p = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const r = await fetch(BASE_URL + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ── Probes, run in this order ──

async function probe_health(): Promise<void> {
  const r = await fetch(BASE_URL + "/api/health");
  check("GET /api/health", r.status, 200);
  const m = await fetch(MCP_URL + "/health");
  check(
    'MCP GET /health: 200 application/json {"status":"ok"}',
    [m.status, m.headers.get("Content-Type"), await m.text()],
    [200, "application/json", '{"status":"ok"}'],
  );
}

async function batch_signup(method: string): Promise<void> {
  const r = await post("/api/batch", {
    requests: [
      {
        method,
        url: "/api/collections/users/records",
        body: { email: `batch-${method}@example.com` },
      },
    ],
  });
  check(`anonymous batch ${method} signup status`, r.status, 400);
  check(
    `anonymous batch ${method} signup inner message`,
    r.json?.data?.requests?.["0"]?.response?.message,
    "Sign up with a single request, not inside a batch.",
  );
}

async function probe_batch_create(): Promise<void> {
  await batch_signup("POST");
}

async function probe_batch_upsert(): Promise<void> {
  await batch_signup("PUT");
}

async function probe_password_signup(): Promise<void> {
  const r = await post("/api/collections/users/records", {
    email: "with-password@example.com",
    password: "probe123456",
    passwordConfirm: "probe123456",
  });
  check("signup carrying a password status", r.status, 400);
  check(
    "signup carrying a password code",
    r.json?.data?.password?.code,
    "validation_signup_password",
  );
}

const KEY_USER = "smoke-keys@example.com";
const KEY_PASSWORD = "smoke-keys-123456";
const KEY_IP = "203.0.113.50"; // its own X-Real-IP, so this sign-in spends none of the forged-address probe's budget
let KEY_SESSION = "";

async function key_session(): Promise<string> {
  if (!KEY_SESSION) {
    const r = await post(
      "/api/collections/users/auth-with-password",
      { identity: KEY_USER, password: KEY_PASSWORD },
      { "X-Real-IP": KEY_IP },
    );
    KEY_SESSION = r.json?.token ?? "";
  }
  return KEY_SESSION;
}

async function mint_key(fields: Record<string, unknown>): Promise<string> {
  const r = await post(
    "/api/collections/api_keys/records",
    { name: "smoke", ...fields },
    { Authorization: await key_session() },
  );
  return r.json?.key ?? "";
}

async function probe_read_key_me(): Promise<void> {
  const key = await mint_key({ scope: "read" });
  const r = await fetch(BASE_URL + "/api/tracker/me", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const workspaces: any[] = ((await r.json().catch(() => null)) as any)?.workspaces ?? [];
  check(
    "read key me: every capability false",
    workspaces.every((w) => !w.capabilities.write && !w.capabilities.manage && !w.capabilities.own),
    true,
  );
  check("read key me lists the provisioned workspace", workspaces.length >= 1, true);
}

async function probe_key_levels(): Promise<void> {
  const session = await key_session();
  const call = async (method: string, url: string, auth: string, body?: unknown) => {
    const r = await fetch(BASE_URL + url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const me = await call("GET", "/api/tracker/me", session);
  const ws: string = me.json?.workspaces?.[0]?.id ?? "";
  const task = await call("POST", "/api/collections/tasks/records", session, {
    title: "smoke level probe",
    workspace: ws,
  });
  const key = `Bearer ${await mint_key({ scope: "write" })}`;
  const url = `/api/collections/tasks/records/${task.json?.id}`;
  const refusal = (r: { status: number; json: any }) => [r.status, r.json?.data?.api_key?.code];
  check("write key trashes a task", (await call("DELETE", url, key)).status, 204);
  check("write key purge refused", refusal(await call("DELETE", url, key)), [403, "api_key_scope"]);
  const uid = JSON.parse(Buffer.from(session.split(".")[1], "base64url").toString()).id;
  check(
    "write key transfer-ownership refused",
    refusal(
      await call("POST", `/api/tracker/workspaces/${ws}/transfer-ownership`, key, { user: uid }),
    ),
    [403, "api_key_scope"],
  );
}

async function probe_key_reach(): Promise<void> {
  const session = await key_session();
  const call = async (method: string, url: string, auth: string, body?: unknown) => {
    const r = await fetch(BASE_URL + url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const me = await call("GET", "/api/tracker/me", session);
  const ws: string = me.json?.workspaces?.[0]?.id ?? "";
  const wsB = await call("POST", "/api/collections/workspaces/records", session, {
    name: "Smoke B",
  });
  const task = await call("POST", "/api/collections/tasks/records", session, {
    title: "smoke reach probe",
    workspace: wsB.json?.id,
  });
  check("reach probe: Smoke B and its task created", [wsB.status, task.status], [200, 200]);
  const key = `Bearer ${await mint_key({ scope: "write", reach: "workspace", workspace: ws })}`;
  const listed = await call("GET", "/api/collections/tasks/records?perPage=500", key);
  check(
    "workspace key lists no Smoke B task",
    [listed.status, (listed.json?.items ?? []).some((t: any) => t.workspace === wsB.json?.id)],
    [200, false],
  );
  check(
    "workspace key views the Smoke B task: 404",
    (await call("GET", `/api/collections/tasks/records/${task.json?.id}`, key)).status,
    404,
  );
  const create = await call("POST", "/api/collections/workspaces/records", key, { name: "no" });
  check(
    "workspace key creates a workspace: 403 api_key_reach",
    [create.status, create.json?.data?.api_key?.code],
    [403, "api_key_reach"],
  );
}

async function probe_oauth_scopes(): Promise<void> {
  const as: any = await fetch(BASE_URL + "/.well-known/oauth-authorization-server").then((r) =>
    r.json(),
  );
  check("authorization server scopes_supported: read, write, manage, own", as.scopes_supported, [
    "read",
    "write",
    "manage",
    "own",
  ]);
}

// Without the edge, the counted address is the Docker gateway that publishes the port.
async function probe_forged_client_address(): Promise<void> {
  const signin = (headers: Record<string, string> = {}) =>
    post(
      "/api/collections/users/auth-with-password",
      { identity: "nobody@example.com", password: "wrong-password" },
      headers,
    ).then((r) => r.status);
  const statuses: number[] = [];
  for (let i = 0; i < SIGNIN_LIMIT + 1; i++) statuses.push(await signin());
  check(`failed sign-ins x${SIGNIN_LIMIT + 1}`, statuses, [...Array(SIGNIN_LIMIT).fill(400), 429]);
  check(
    "sign-in with a forged X-Forwarded-For after the 429",
    await signin({ "X-Forwarded-For": "203.0.113.7" }),
    429,
  );
  check(
    "sign-in from another X-Real-IP after the 429",
    await signin({ "X-Real-IP": "203.0.113.8" }),
    400,
  );
}

async function probe_signup_rate_limit(): Promise<void> {
  const statuses: number[] = [];
  for (let i = 0; i < SIGNUP_LIMIT + 1; i++) {
    statuses.push(
      (await post("/api/collections/users/records", { email: `direct-${i}@example.com` })).status,
    );
  }
  // The password probe already spent one slot of this IP's minute.
  const expected = [...Array(SIGNUP_LIMIT - 1).fill(200), 429, 429];
  check(`direct signups x${SIGNUP_LIMIT + 1}`, statuses, expected);
}

const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";

async function probe_mcp_challenge(): Promise<void> {
  const r = await fetch(MCP_URL + "/mcp", { method: "POST" });
  const challenge = r.headers.get("WWW-Authenticate") ?? "";
  // The configured public URL carries port 0 under MCP_PORT=0, so only the ends are fixed.
  check(
    "MCP POST /mcp without a credential: 401 application/json, challenge names the PRM and both scopes",
    [
      r.status,
      r.headers.get("Content-Type"),
      challenge.startsWith('Bearer resource_metadata="'),
      challenge.endsWith(`${PRM_PATH}", scope="read write"`),
    ],
    [401, "application/json", true, true],
  );
}

async function probe_mcp_metadata(): Promise<void> {
  const prm: any = await fetch(MCP_URL + PRM_PATH).then((r) => r.json());
  const as: any = await fetch(BASE_URL + "/.well-known/oauth-authorization-server").then((r) =>
    r.json(),
  );
  check(
    "PRM authorization_servers[0] equals the authorization server's issuer",
    prm.authorization_servers?.[0],
    as.issuer,
  );
  check(
    "authorization server metadata lists S256 and none, and metadata-document clients",
    [
      as.code_challenge_methods_supported?.includes("S256"),
      as.token_endpoint_auth_methods_supported?.includes("none"),
      as.client_id_metadata_document_supported,
    ],
    [true, true, true],
  );
  check("PRM resource is the compose file's MCP public URL plus /mcp", prm.resource, MCP_RESOURCE);
}

// PocketBase -> the mcp private listener: a refused document is "could not be verified." only when the secret, URL and listener all work.
async function probe_pb_to_mcp_wiring(): Promise<void> {
  const q = new URLSearchParams(
    authorize_params({
      client_id: "https://localhost/meta",
      redirect_uri: "https://localhost/cb",
    }),
  );
  const r = await fetch(`${BASE_URL}/oauth/authorize?${q}`);
  const text = await r.text();
  check(
    "PocketBase -> mcp: a localhost metadata URL gets 'could not be verified.', not 'right now'",
    [r.status, text.includes("could not be verified."), text.includes("right now")],
    [400, true, false],
  );
}

// mcp -> PocketBase: an unknown key is 401 only when the service reaches PocketBase's /me (503 otherwise).
async function probe_mcp_to_pb_wiring(): Promise<void> {
  const r = await fetch(MCP_URL + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer tmk_bogus",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Real-IP": "198.51.100.78",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  check(
    "mcp -> PocketBase: Bearer tmk_bogus is 401 invalid_token",
    [r.status, ((await r.json().catch(() => null)) as any)?.error?.code],
    [401, "invalid_token"],
  );
}

async function probe_mcp_refusals(): Promise<void> {
  const get = await fetch(MCP_URL + "/mcp");
  const nope = await fetch(MCP_URL + "/nope");
  const origin = await fetch(MCP_URL + "/mcp", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  check(
    "MCP GET /mcp 405, GET /nope 404, unlisted Origin 403",
    [get.status, nope.status, origin.status],
    [405, 404, 403],
  );
}

async function probe_oauth_refusals(): Promise<void> {
  const form = (path: string, body: string) =>
    fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  const page = await fetch(BASE_URL + "/oauth/authorize?client_id=nope&redirect_uri=x");
  check(
    "GET /oauth/authorize for an unknown client: 400 HTML page",
    [page.status, (page.headers.get("Content-Type") ?? "").startsWith("text/html")],
    [400, true],
  );
  const token = await form("/oauth/token", "grant_type=password");
  check(
    "POST /oauth/token grant_type=password: 400 unsupported_grant_type",
    [token.status, ((await token.json()) as any).error],
    [400, "unsupported_grant_type"],
  );
  const revoke = await form("/oauth/revoke", "token=x&client_id=cursor");
  const unknown = await form("/oauth/revoke", "token=x&client_id=y");
  check(
    "POST /oauth/revoke: known client 200, unknown client 400 invalid_client",
    [revoke.status, unknown.status, ((await unknown.json()) as any).error],
    [200, 400, "invalid_client"],
  );
  const { code_challenge: _, ...no_pkce } = authorize_params();
  const back = await fetch(BASE_URL + "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(no_pkce).toString(),
    redirect: "manual",
  });
  check(
    "POST /oauth/authorize without PKCE: 302 error redirect, no-store, no-referrer",
    [back.status, back.headers.get("Cache-Control"), back.headers.get("Referrer-Policy")],
    [302, "no-store", "no-referrer"],
  );
}

async function probe_oauth_code_stage_blind(): Promise<void> {
  const params = authorize_params();
  const page = await (
    await fetch(`${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`)
  ).text();
  const body = new URLSearchParams({
    ...params,
    flow: field(page, "flow") ?? "",
    action: "send_code",
    email: "nobody@example.com",
  });
  const code = await fetch(BASE_URL + "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const ids = (field(await code.text(), "flow") ?? "").split("|").slice(2, 4);
  check(
    "send_code for an unknown email: the code page's flow carries two 15-character ids",
    [code.status, ids.map((id) => /^[a-z0-9]{15}$/.test(id))],
    [200, [true, true]],
  );
}

async function probe_mcp_anon_limit(): Promise<void> {
  const statuses: number[] = [];
  let last: Response | null = null;
  for (let i = 0; i < 31; i++) {
    last = await fetch(MCP_URL + "/mcp", {
      method: "POST",
      headers: { "X-Real-IP": "198.51.100.77" },
    });
    statuses.push(last.status);
  }
  check(
    "MCP: 30 unauthenticated POSTs from one address are 401, the 31st 429 with Retry-After",
    [statuses, Number(last?.headers.get("Retry-After")) > 0],
    [[...Array(30).fill(401), 429], true],
  );
}

const PROBES = [
  probe_health,
  probe_batch_create,
  probe_batch_upsert,
  probe_password_signup,
  probe_read_key_me,
  probe_key_levels,
  probe_key_reach,
  probe_oauth_scopes,
  probe_forged_client_address,
  probe_mcp_challenge,
  probe_mcp_metadata,
  probe_mcp_refusals,
  probe_pb_to_mcp_wiring,
  probe_mcp_to_pb_wiring,
  probe_oauth_refusals,
  probe_oauth_code_stage_blind,
  probe_mcp_anon_limit,
  probe_signup_rate_limit,
];

// ── Lifecycle ──

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  const r = run([...COMPOSE, "down", "-v", "--rmi", "local"]);
  if (r.code !== 0) failures += 1; // a leaked volume or image must fail the run
  console.log(
    r.code === 0 ? `cleanup: ${PROJECT} removed` : `cleanup FAILED for ${PROJECT}:\n${r.out}`,
  );
}

for (const [sig, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(code);
  });
}

// A restart republishes port 0 on a new host port, so the lookup runs after each boot.
function resolve_base_url(): boolean {
  const r = run([...COMPOSE, "port", "pocketbase", "8080"]);
  const port = Number(r.out.trim().split(":").pop());
  if (r.code !== 0 || !port || port === 8090 || port === 8089) {
    console.error(
      `❌ refusing published port ${port}: expected a Docker-picked port other than 8090 and 8089\n${r.out}`,
    );
    return false;
  }
  BASE_URL = `http://127.0.0.1:${port}`;
  return true;
}

async function wait_healthy(): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const url = BASE_URL + "/api/health";
  while (
    (await fetch(url).then(
      (r) => r.status,
      () => 0,
    )) !== 200
  ) {
    if (Date.now() > deadline) {
      console.error(`❌ no 200 from ${url} within ${HEALTH_TIMEOUT_MS / 1000}s; container log:`);
      console.error(run([...COMPOSE, "logs", "--no-color"]).out);
      return false;
    }
    await Bun.sleep(500);
  }
  return true;
}

async function main(): Promise<number> {
  if (run(["docker", "info"]).code !== 0) {
    console.error(
      "Docker is not installed or not running: start Docker Desktop / the daemon, then rerun `make smoke`.",
    );
    return 2;
  }
  try {
    console.log(`building and booting ${ROOT} as compose project ${PROJECT}`);
    const up = run([...COMPOSE, "up", "-d", "--build"], PUBLISH);
    if (up.code !== 0) {
      console.error(`❌ compose up failed:\n${up.out}`);
      return 1;
    }
    if (!resolve_base_url()) return 1;
    const mcp_port = Number(
      run([...COMPOSE, "port", "mcp", "8080"])
        .out.trim()
        .split(":")
        .pop(),
    );
    if (!mcp_port || mcp_port === 8090 || mcp_port === 8089) {
      console.error(
        `❌ refusing published port ${mcp_port}: expected a Docker-picked port other than 8090 and 8089`,
      );
      return 1;
    }
    MCP_URL = `http://127.0.0.1:${mcp_port}`;
    if (!(await wait_healthy())) return 1;
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    const mcpHealth = MCP_URL + "/health";
    while (
      (await fetch(mcpHealth).then(
        (r) => r.status,
        () => 0,
      )) !== 200
    ) {
      if (Date.now() > deadline) {
        console.error(
          `❌ no 200 from ${mcpHealth} within ${HEALTH_TIMEOUT_MS / 1000}s; container log:`,
        );
        console.error(run([...COMPOSE, "logs", "--no-color"]).out);
        return 1;
      }
      await Bun.sleep(500);
    }
    const SMOKE_MIGRATION = "1785199999_smoke_key_user.js";
    for (const cmd of [
      [
        ...COMPOSE,
        "cp",
        path.join(ROOT, "e2e/fixtures/smoke_key_user.js"),
        "pocketbase:/pb/pb_migrations/" + SMOKE_MIGRATION,
      ],
      [...COMPOSE, "restart", "pocketbase"],
    ]) {
      const r = run(cmd);
      if (r.code !== 0) {
        console.error(`❌ ${cmd.slice(COMPOSE.length).join(" ")} failed:\n${r.out}`);
        return 1;
      }
    }
    if (!resolve_base_url() || !(await wait_healthy())) return 1;
    console.log(`healthy at ${BASE_URL} and ${MCP_URL}`);
    for (const probe of PROBES) await probe();
  } finally {
    cleanup();
  }
  console.log(failures === 0 ? "\nALL SMOKE PROBES PASSED" : `\n${failures} SMOKE CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());

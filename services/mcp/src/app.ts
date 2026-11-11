// The hosted MCP endpoint's public request pipeline (contract: hosted-mcp-endpoint).

import { createHash } from "node:crypto";
import {
  createMcpHandler,
  isLegacyRequest,
  make_server,
  Server,
  TOOLS,
  WebStandardStreamableHTTPServerTransport,
  type Scope,
} from "../../../clients/tm/src/mcp.ts";
import { FixedWindow } from "./limits.ts";

export type Env = {
  pb_internal_url: string;
  pb_public_url: string;
  mcp_public_url: string;
  internal_secret: string;
  allowed_origins: string[];
};

const DEFAULT_ORIGINS = ["https://claude.ai", "https://www.cursor.com"];

export function load_env(env: Record<string, string | undefined> = process.env): Env {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`missing environment variable ${name}`);
    return v;
  };
  const url = (name: string): string => need(name).replace(/\/+$/, "");
  const origins = (env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    pb_internal_url: url("PB_INTERNAL_URL"),
    pb_public_url: url("PB_PUBLIC_URL"),
    mcp_public_url: url("MCP_PUBLIC_URL"),
    internal_secret: need("MCP_INTERNAL_SECRET"),
    allowed_origins: origins.length ? origins : DEFAULT_ORIGINS,
  };
}

const PRM_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);
const WINDOW_MS = 60_000;

// Response.json would add ";charset=utf-8"; D9 names the type exactly.
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function error(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { status, code, message } }, status, headers);
}

function rpc_error(status: number, message: string, code = -32600, id: unknown = null): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

async function serve_mcp(req: Request, body: unknown, factory: () => Server): Promise<Response> {
  if (!(await isLegacyRequest(req, body))) {
    return createMcpHandler(factory, { legacy: "reject", responseMode: "json" }).fetch(req, {
      parsedBody: body,
    });
  }
  const server = factory();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, { parsedBody: body });
  } finally {
    void server.close();
  }
}

type Checked = { scope: Scope } | { status: 401 } | { failed: string };

async function check_key(env: Env, key: string): Promise<Checked> {
  let r: Response;
  try {
    r = await fetch(`${env.pb_internal_url}/api/tracker/me`, {
      headers: { Authorization: key, "X-TM-Internal": env.internal_secret },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    return { failed: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message };
  }
  if (r.status === 401) return { status: 401 };
  if (r.status !== 200) return { failed: String(r.status) };
  const scope = ((await r.json().catch(() => null)) as any)?.key?.scope;
  return scope === "read" || scope === "write" ? { scope } : { failed: "200 without a key scope" };
}

export function make_app(env: Env): { fetch(req: Request, ip: string): Promise<Response> } {
  const by_key = new FixedWindow(300, WINDOW_MS);
  const by_address = new FixedWindow(30, WINDOW_MS);
  const prm_url = `${env.mcp_public_url}/.well-known/oauth-protected-resource/mcp`;
  const prm = {
    resource: `${env.mcp_public_url}/mcp`,
    authorization_servers: [env.pb_public_url],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
    resource_name: "Task tracker",
  };
  const challenge = (invalid: boolean): Record<string, string> => ({
    "WWW-Authenticate": `Bearer resource_metadata="${prm_url}", scope="read write"${invalid ? ', error="invalid_token"' : ""}`,
  });
  const refused = (ip: string, invalid: boolean): Response => {
    const wait = by_address.hit(ip, Date.now());
    if (wait)
      return error(
        429,
        "rate_limited",
        "Too many requests from this address; retry after the time given.",
        { "Retry-After": String(wait) },
      );
    return invalid
      ? error(
          401,
          "invalid_token",
          "The credential is invalid, revoked or expired.",
          challenge(true),
        )
      : error(
          401,
          "unauthorized",
          "This endpoint needs an API key or a sign-in.",
          challenge(false),
        );
  };

  async function pipeline(req: Request, ip: string, origin: string | null): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (PRM_PATHS.has(path)) {
      if (req.method !== "GET" && req.method !== "HEAD")
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      };
      return new Response(req.method === "HEAD" ? null : JSON.stringify(prm), { headers });
    }
    if (path !== "/mcp") return error(404, "not_found", "Nothing is served at this path.");
    if (origin !== null && !env.allowed_origins.includes(origin))
      return error(403, "origin_not_allowed", "Requests from this web origin are not accepted.");
    if (req.method === "OPTIONS") {
      const headers: Record<string, string> = { Allow: "POST" };
      if (origin !== null) {
        headers["Access-Control-Allow-Methods"] = "POST";
        headers["Access-Control-Allow-Headers"] =
          "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name";
        headers["Access-Control-Max-Age"] = "600";
      }
      return new Response(null, { status: 204, headers });
    }
    if (req.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });

    const key = (req.headers.get("Authorization") ?? "").trim().replace(/^bearer\s+/i, "");
    if (!key) return refused(ip, false);
    if (!key.startsWith("tmk_")) return refused(ip, true);
    const checked = await check_key(env, key);
    if ("status" in checked) return refused(ip, true);
    if ("failed" in checked) {
      console.error(`credential check failed: ${checked.failed}`);
      return error(503, "unavailable", "The credential could not be checked; try again.", {
        "Retry-After": "5",
      });
    }
    const scope = checked.scope;
    const wait = by_key.hit(createHash("sha256").update(key).digest("hex"), Date.now());
    if (wait)
      return error(
        429,
        "rate_limited",
        "Too many requests for this credential; retry after the time given.",
        { "Retry-After": String(wait) },
      );

    const accept = (req.headers.get("Accept") ?? "").toLowerCase();
    if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
      return rpc_error(406, "The Accept header must list application/json and text/event-stream.");
    const media = (req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    let body: any = null;
    try {
      body = JSON.parse(await req.clone().text());
    } catch {}
    if (
      media !== "application/json" ||
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body)
    )
      return rpc_error(400, "The body must be one JSON-RPC message.");

    // The SDK would hold an SSE stream open for this; the service sends none.
    if (body.method === "subscriptions/listen" && !("id" in body))
      return new Response(null, { status: 202 });
    if (body.method === "subscriptions/listen")
      return rpc_error(
        (await isLegacyRequest(req, body)) ? 200 : 404,
        "Method not found",
        -32601,
        body.id ?? null,
      );

    if (body.method === "tools/call" && scope === "read") {
      const tool = TOOLS.find((t) => t.name === body.params?.name);
      if (tool && tool.annotations.readOnlyHint !== true)
        return error(
          403,
          "insufficient_scope",
          "This credential is read-only; this tool needs write access.",
          {
            "WWW-Authenticate": `Bearer error="insufficient_scope", scope="read write", resource_metadata="${prm_url}"`,
          },
        );
    }

    const cfg = {
      url: env.pb_internal_url,
      key,
      headers: { "X-TM-Internal": env.internal_secret },
    };
    return serve_mcp(req, body, () => make_server(cfg, async () => scope));
  }

  return {
    async fetch(req, ip) {
      const origin = req.headers.get("Origin");
      let res: Response;
      try {
        res = await pipeline(req, ip, origin);
      } catch (e) {
        console.error("request failed:", e);
        res = error(500, "server_error", "The service failed; try again.");
      }
      if (origin !== null && env.allowed_origins.includes(origin)) {
        res.headers.set("Access-Control-Allow-Origin", origin);
        res.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Retry-After");
        res.headers.append("Vary", "Origin");
      }
      return res;
    },
  };
}

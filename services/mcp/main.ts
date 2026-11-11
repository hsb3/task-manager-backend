// Entry point of the hosted MCP service: the public listener and the private one.

import type { Server } from "bun";
import { load_env, make_app, type Env } from "./src/app.ts";
import { internal_handler } from "./src/cimd.ts";

/** Railway's edge sets X-Real-IP; its rightmost token is the one the API reads too. */
function client_ip(req: Request, server: Server<undefined>): string {
  const real = (req.headers.get("X-Real-IP") ?? "").split(",").at(-1)!.trim();
  return real || server.requestIP(req)?.address || "";
}

let env: Env;
try {
  env = load_env();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const app = make_app(env);
const hostname = process.env.MCP_HOST || "::";

const pub = Bun.serve({
  hostname,
  port: Number(process.env.PORT || 8080),
  fetch: (req, server) => app.fetch(req, client_ip(req, server)),
});
console.log(`listening on ${hostname}:${pub.port}`);

const internal = Bun.serve({
  hostname,
  port: Number(process.env.MCP_INTERNAL_PORT || 8081),
  fetch: internal_handler(env),
});
console.log(`listening on ${hostname}:${internal.port}`);

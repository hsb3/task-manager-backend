#!/usr/bin/env bun
/**
 * The account app's static files under /account carry the contract's security headers, and every other path answers as before.
 *
 * Port 8225 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8225 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(78)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
  );
}

async function req(method: string, p: string): Promise<Response> {
  try {
    return await fetch(BASE_URL + p, { method, redirect: "manual" });
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
}

const NOT_FOUND = '{"data":{},"message":"File not found.","status":404}';

// fetch() normalises %2e%2e segments away (WHATWG URL), so these requests go over a raw socket.
function raw(
  method: string,
  p: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: PORT });
    const chunks: Buffer[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("error", reject);
    sock.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const [line = "", ...lines] = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const l of lines) {
        const i = l.indexOf(":");
        headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      let body = rest.join("\r\n\r\n");
      if (headers["transfer-encoding"] === "chunked") {
        let out = "";
        while (body) {
          const nl = body.indexOf("\r\n");
          const size = Number.parseInt(body.slice(0, nl), 16);
          if (!size) break;
          out += body.slice(nl + 2, nl + 2 + size);
          body = body.slice(nl + 2 + size + 2);
        }
        body = out;
      }
      resolve({ status: Number(line.split(" ")[1]), headers, body: body.trim() });
    });
    sock.write(`${method} ${p} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
  });
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-account-app-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const PUB = path.join(S, "pb_public");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(path.join(REPO_ROOT, "pb_migrations"), MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}
fs.mkdirSync(path.join(PUB, "account", "assets"), { recursive: true });
fs.writeFileSync(path.join(PUB, "account", "index.html"), "<!doctype html><title>stub</title>");
fs.writeFileSync(path.join(PUB, "account", "assets", "app.js"), "console.log(1)");

let server: roomkit.Room | null = null;
try {
  run_checked(
    [
      PB_BIN,
      "superuser",
      "upsert",
      "probe@example.com",
      "probe123456",
      "--dir",
      DATA_DIR,
      "--migrationsDir",
      MIG_DIR,
    ],
    { cwd: REPO_ROOT, capture_output: true },
  );
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S), null, [
    "--publicDir",
    PUB,
    "--indexFallback=false",
  ]);
  const csp = (r: Response) => r.headers.get("content-security-policy");

  let r = await req("GET", "/account/");
  check("1 GET /account/ → 200", r.status, 200);
  check(
    "1 content-type is text/html",
    (r.headers.get("content-type") ?? "").startsWith("text/html"),
    true,
  );
  check("1 content-security-policy is the contract's", csp(r), CSP);
  check("1 x-frame-options DENY", r.headers.get("x-frame-options"), "DENY");
  check("1 x-content-type-options nosniff", r.headers.get("x-content-type-options"), "nosniff");
  check("1 referrer-policy no-referrer", r.headers.get("referrer-policy"), "no-referrer");
  check("1 cache-control no-cache", r.headers.get("cache-control"), "no-cache");

  r = await req("HEAD", "/account/");
  check("2 HEAD /account/ → 200", r.status, 200);
  check("2 HEAD carries the policy", csp(r), CSP);

  r = await req("GET", "/account");
  check("3 GET /account → 301", r.status, 301);
  check("3 location /account/", r.headers.get("location"), "/account/");
  check("3 the redirect carries the policy", csp(r), CSP);

  r = await req("GET", "/account/assets/app.js");
  check("4 GET /account/assets/app.js → 200", r.status, 200);
  check(
    "4 cache-control immutable",
    r.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  check("4 the asset carries the policy", csp(r), CSP);

  r = await req("GET", "/account/keys");
  check("5 GET /account/keys → 404", r.status, 404);
  check(
    "5 message File not found.",
    ((await r.json()) as { message?: unknown }).message,
    "File not found.",
  );
  check("5 the 404 carries the policy", csp(r), CSP);

  r = await req("GET", "/api/nope");
  check("6 GET /api/nope → 404", r.status, 404);
  check("6 its body is JSON", typeof ((await r.json()) as { message?: unknown }).message, "string");
  check("6 no policy outside /account", csp(r), null);

  r = await req("GET", "/api/health");
  check("7 GET /api/health → 200", r.status, 200);
  check("7 no policy outside /account", csp(r), null);

  r = await req("GET", "/accounts");
  check("8 GET /accounts → 404", r.status, 404);
  check("8 a sibling prefix gets no policy", csp(r), null);

  r = await req("POST", "/account/");
  check("9 POST /account/ → 404", r.status, 404);
  check("9 a POST gets no policy", csp(r), null);

  r = await req("GET", "/oauth/authorize");
  check("10 GET /oauth/authorize (no query) → 400", r.status, 400);
  check(
    "10 the consent page keeps its own policy",
    (csp(r) ?? "").startsWith("default-src 'none'"),
    true,
  );

  r = await req("GET", "/account/index.html");
  check("11 GET /account/index.html → 301", r.status, 301);
  check("11 location /account/", r.headers.get("location"), "/account/");
  check("11 the redirect carries the policy", csp(r), CSP);

  // A dot segment the static handler would resolve answers as a server without the app does.
  const DOT_PATHS = [
    "/api/..%2faccount/",
    "/oauth/..%2faccount/",
    "/api/%2e%2e/account/",
    "/api/%2E%2E/account/",
    "/api/health/%2e%2e/%2e%2e/account/",
    "/api/%2e%2e/account/assets/app.js",
    "/x/..%2Faccount/assets/app.js",
    "/account/%2e/",
    "/account/assets/%2e%2e/",
    "/account/%2e%2e/account/",
  ];
  for (const p of DOT_PATHS) {
    const g = await raw("GET", p);
    check(
      `12 GET ${p} → main's 404`,
      [g.status, g.body, g.headers["content-security-policy"] ?? null],
      [404, NOT_FOUND, null],
    );
    const h = await raw("HEAD", p);
    check(
      `12 HEAD ${p} → 404, no policy`,
      [h.status, h.headers["content-security-policy"] ?? null],
      [404, null],
    );
  }

  const route = await raw("GET", "/api/collections/%2e%2e/records");
  check(
    "13 a dot segment a route matches is still the route's answer",
    [route.status, route.body.includes("File not found.")],
    [404, false],
  );

  r = await req("GET", "/account/assets/missing.js");
  check("14 GET /account/assets/missing.js → 404", r.status, 404);
  check(
    "14 a missing asset is not cached as immutable",
    r.headers.get("cache-control"),
    "no-cache",
  );
  check("14 it carries the policy", csp(r), CSP);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all account app serving proofs passed");
  process.exit(0);
}

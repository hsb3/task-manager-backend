#!/usr/bin/env bun
/**
 * hosted-mcp-endpoint metadata-document fetcher (services/mcp/src/cimd.ts): URL rules, address
 * refusals, the pinned fetch, redirects, size and document rules, cache lifetimes, and the
 * private handler's secret. No port: lookup and fetch are fakes.
 */

import { py_repr } from "../scripts/_py.ts";
import {
  check_client_id_url,
  fetch_client_metadata,
  internal_handler,
  max_age,
} from "../services/mcp/src/cimd.ts";
import type { Env } from "../services/mcp/src/app.ts";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

const URL_A = "https://x/a";
// Claude's hosted-app metadata document, as fetched (D3).
const CLAUDE_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_DOC =
  '{"client_id":"https://claude.ai/oauth/mcp-oauth-client-metadata","client_name":"Claude","client_uri":"https://claude.ai","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"response_types":["code"],"token_endpoint_auth_method":"none"}';

type Seen = { url: string; init: any };

/** Fakes answering `addrs` for every lookup and `respond()` for every fetch, recording each fetch. */
function fakes(addrs: string[] | (() => never), respond: () => Response = () => doc_response({})) {
  const seen: Seen[] = [];
  return {
    seen,
    deps: {
      lookup: async () => (typeof addrs === "function" ? addrs() : addrs),
      fetch: (async (url: string, init: any) => {
        seen.push({ url, init });
        return respond();
      }) as unknown as typeof fetch,
    },
  };
}

function doc_response(over: Record<string, unknown>, url = URL_A) {
  const doc = {
    client_id: url,
    client_name: "X",
    redirect_uris: ["https://x/cb"],
    ...over,
  };
  return new Response(JSON.stringify(doc), { status: 200 });
}

const PUBLIC = ["93.184.215.14"];
const run = (url: string, f: ReturnType<typeof fakes>) => fetch_client_metadata(url, f.deps);

console.log("\n── address refusals ──");
for (const addr of [
  "10.0.0.5",
  "127.0.0.1",
  "169.254.169.254",
  "::1",
  "fd12::1",
  "::ffff:192.168.1.1",
  "100.64.0.1",
]) {
  const f = fakes([addr]);
  const r = await run(URL_A, f);
  check(
    `refuses_private_address: ${addr} → 422, fetch never called`,
    [r.status, r.body, f.seen.length],
    [422, { error: "host resolves to a non-public address" }, 0],
  );
}
{
  const f = fakes(["93.184.215.14", "10.0.0.1"]);
  const r = await run(URL_A, f);
  check("mixed_addresses_refused: public plus 10.0.0.1 → 422", [r.status, f.seen.length], [422, 0]);
}

console.log("\n── URL rules ──");
for (const u of [
  "http://x/a",
  "https://u@x/a",
  "https://x",
  "https://x/",
  "https://x/a#f",
  "https://x/a?q=1",
  "https://x/a/../b",
  "https://x/./a",
  "https://x/a/%2E%2E/b",
  "https://x/a/.%2e/b",
  "https://x/a/%2E./b",
  "https://\u0441laude.ai/oauth/meta",
  "https://x.exa\tmple/a",
  "https://x/a b",
  "https://x/a\u00a0",
])
  check(
    `url_rules: ${u} → reason`,
    check_client_id_url(u),
    "client_id is not a valid metadata URL",
  );
for (const u of ["https://x/a", "https://x:8443/a", "https://xn--laude-0ye.ai/a"])
  check(`url_rules: ${u} → null`, check_client_id_url(u), null);

{
  const f = fakes(PUBLIC);
  const r = await run("https://\u0441laude.ai/oauth/meta", f);
  check(
    "non_ascii_host: Cyrillic client id → 422, fetch never called",
    [r.status, r.body, f.seen.length],
    [422, { error: "client_id is not a valid metadata URL" }, 0],
  );
}
{
  const u = "https://xn--laude-0ye.ai/a";
  const r = await run(
    u,
    fakes(PUBLIC, () => doc_response({}, u)),
  );
  check(
    "punycode_host: accepted, returned as punycode → 200",
    [r.status, (r.body as any).client?.client_id],
    [200, u],
  );
}

console.log("\n── the pinned fetch ──");
{
  const f = fakes(PUBLIC);
  const r = await run(URL_A, f);
  const s = f.seen[0];
  check(
    "pinned_fetch: URL by address, Host x, tls.serverName x, redirect manual → 200",
    [r.status, s?.url, s?.init.headers.Host, s?.init.tls?.serverName, s?.init.redirect],
    [200, "https://93.184.215.14/a", "x", "x", "manual"],
  );
}
{
  const f = fakes(PUBLIC, () => doc_response({}, "https://x:8443/a"));
  await run("https://x:8443/a", f);
  check(
    "pinned_fetch: a named port is kept in the URL and Host",
    [f.seen[0]?.url, f.seen[0]?.init.headers.Host],
    ["https://93.184.215.14:8443/a", "x:8443"],
  );
}
{
  const f = fakes(["2606:4700::1"]);
  await run(URL_A, f);
  check("ipv6_bracketed: 2606:4700::1 → bracketed URL", f.seen[0]?.url, "https://[2606:4700::1]/a");
}
{
  const f = fakes(PUBLIC, () => new Response(null, { status: 302, headers: { Location: "/b" } }));
  const r = await run(URL_A, f);
  check(
    "redirect_refused: 302 → 422",
    [r.status, r.body],
    [422, { error: "redirects are not followed" }],
  );
}
{
  let r = await run(
    URL_A,
    fakes(PUBLIC, () => new Response("x", { status: 503 })),
  );
  check("server_error_transient: host 503 → 503", r.status, 503);
  r = await run(
    URL_A,
    fakes(PUBLIC, () => {
      throw new Error("ECONNREFUSED");
    }),
  );
  check(
    "server_error_transient: fetch throws → 503 host did not answer",
    [r.status, r.body],
    [503, { error: "host did not answer" }],
  );
  r = await run(
    URL_A,
    fakes(() => {
      throw new Error("ENOTFOUND");
    }),
  );
  check(
    "server_error_transient: lookup throws → 503 host did not resolve",
    [r.status, r.body],
    [503, { error: "host did not resolve" }],
  );
}
{
  const big = "x".repeat(6000);
  let r = await run(
    URL_A,
    fakes(PUBLIC, () => new Response(big, { status: 200, headers: { "Content-Length": "6000" } })),
  );
  check(
    "too_large: Content-Length 6000 → 422",
    [r.status, r.body],
    [422, { error: "document is larger than 5 KB" }],
  );
  const stream = () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < 6; i++)
            c.enqueue(new TextEncoder().encode(big.slice(i * 1000, (i + 1) * 1000)));
          c.close();
        },
      }),
      { status: 200 },
    );
  r = await run(URL_A, fakes(PUBLIC, stream));
  check(
    "too_large: 6000 streamed bytes, no length → 422",
    [r.status, r.body],
    [422, { error: "document is larger than 5 KB" }],
  );
}

console.log("\n── document rules ──");
for (const [label, over, reason] of [
  ["client_id_mismatch", { client_id: "https://x/b" }, "client_id does not match the URL"],
  ["no_redirect_uris", { redirect_uris: [] }, "redirect_uris missing or invalid"],
  [
    "redirect_non_ascii",
    { redirect_uris: ["https://\u0441laude.ai/cb"] },
    "redirect_uris missing or invalid",
  ],
  ["redirect_control", { redirect_uris: ["https://x/cb\n"] }, "redirect_uris missing or invalid"],
  [
    "redirect_tab_host",
    { redirect_uris: ["https://x.exa\tmple/cb"] },
    "redirect_uris missing or invalid",
  ],
  ["redirect_fragment", { redirect_uris: ["https://x/cb#f"] }, "redirect_uris missing or invalid"],
  ["secret_client", { client_secret: "s" }, "client is not a public client"],
  [
    "jwt_auth_method",
    { token_endpoint_auth_method: "private_key_jwt" },
    "client is not a public client",
  ],
  [
    "implicit_only",
    { response_types: ["token"] },
    "client does not use the authorization code flow",
  ],
] as [string, Record<string, unknown>, string][]) {
  const r = await run(
    URL_A,
    fakes(PUBLIC, () => doc_response(over)),
  );
  check(`${label}: → 422 ${reason}`, [r.status, r.body], [422, { error: reason }]);
}
{
  const r = await run(
    CLAUDE_URL,
    fakes(
      PUBLIC,
      () =>
        new Response(CLAUDE_DOC, { status: 200, headers: { "Content-Type": "application/json" } }),
    ),
  );
  check(
    "valid_document: Claude's document → 200, three fields, max_age 300",
    [r.status, r.body],
    [
      200,
      {
        client: {
          client_id: CLAUDE_URL,
          client_name: "Claude",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        },
        max_age: 300,
      },
    ],
  );
}

console.log("\n── cache lifetimes ──");
check(
  "max_age_rules: no-store 0, max-age=60 60, max-age=999999 86400, none 300",
  [max_age("no-store"), max_age("max-age=60"), max_age("max-age=999999"), max_age(null)],
  [0, 60, 86400, 300],
);

console.log("\n── the private handler ──");
const handler = internal_handler({ internal_secret: "s3cret" } as Env);
const ENDPOINT = "http://127.0.0.1/internal/client-metadata";
const post = (body: string, headers: Record<string, string>) =>
  handler(new Request(ENDPOINT, { method: "POST", body, headers }));
{
  const ok = { "X-TM-Internal": "s3cret", "Content-Type": "application/json" };
  const r1 = await post("nope", ok);
  const r2 = await post('{"client_id": 5}', ok);
  check(
    "internal_malformed: body nope → 422; client_id 5 → 422",
    [r1.status, r2.status, await r2.json()],
    [422, 422, { error: 'request body must be {"client_id": string}' }],
  );
  const body = JSON.stringify({ client_id: URL_A });
  const none = await post(body, { "Content-Type": "application/json" });
  const wrong = await post(body, { "X-TM-Internal": "s3creT", "Content-Type": "application/json" });
  const short = await post(body, { "X-TM-Internal": "s3c", "Content-Type": "application/json" });
  const get = await handler(new Request(ENDPOINT, { headers: { "X-TM-Internal": "s3cret" } }));
  check(
    "internal_secret: no header 404, wrong 404, shorter 404, GET 404",
    [none.status, wrong.status, short.status, get.status, await none.json()],
    [404, 404, 404, 404, { error: "not_found" }],
  );
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all mcp-cimd proofs passed");
  process.exit(0);
}

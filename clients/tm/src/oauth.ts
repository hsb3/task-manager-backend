// tm's browser sign-in: an authorization code with PKCE, caught by a loopback listener (RFC 8252).

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, check_key, ConfigError, request } from "./api.ts";
import { escaped } from "./keys.ts";

const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** Opens the page in the default browser; a missing opener is ignored, as the URL is printed too. */
function open_page(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** An http(s) URL from the metadata, else null: only such a URL is opened or posted to. */
function web_url(v: unknown): string | null {
  try {
    const u = new URL(String(v));
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function sign_in(
  url: string,
  o: {
    scope: string;
    key_name: string;
    key_expires?: string;
    keys: boolean;
    open_browser: boolean;
    timeout_ms?: number;
  },
): Promise<{ key: string; scope: string }> {
  const base = url.replace(/\/+$/, "");
  let meta: any;
  try {
    meta = await request({ url: base, key: "" }, "GET", "/.well-known/oauth-authorization-server");
  } catch (e) {
    if (e instanceof ApiError && e.body.status === 404)
      throw new ConfigError(`${base} does not offer browser sign-in; use tm login --with-key`);
    throw e;
  }
  const authorize = web_url(meta.authorization_endpoint);
  const token = web_url(meta.token_endpoint);
  if (!authorize || !token)
    throw new ConfigError("sign-in failed: the server's sign-in metadata is incomplete");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const close = () => {
    server.close();
    server.closeAllConnections?.();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = () => {
    close();
    process.exit(130);
  };
  let code: string;
  try {
    code = await new Promise<string>((ok, fail) => {
      let done = false;
      server.on("request", (req, res) => {
        const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
        const text = (status: number, body: string) =>
          res
            .writeHead(status, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" })
            .end(body);
        if (done || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/callback")
          return text(404, "not found");
        if (q.get("state") !== state) return text(400, "state mismatch");
        done = true;
        const error = q.get("error");
        const why =
          q.get("iss") !== meta.issuer
            ? "sign-in answered for another server; nothing was saved"
            : error === "access_denied"
              ? "sign-in was denied in the browser"
              : error
                ? `sign-in failed: ${escaped(q.get("error_description") || error)}`
                : q.get("code")
                  ? null
                  : "sign-in failed: the callback carried no code";
        res.writeHead(why ? 400 : 200, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        });
        res.end(
          why
            ? `<p>Sign-in did not finish: ${html(why)}. Return to the terminal for details.</p>`
            : "<p>Signed in. You can close this tab and return to the terminal.</p>",
          close,
        );
        if (why) fail(new ConfigError(why));
        else ok(q.get("code")!);
      });
      timer = setTimeout(
        () => fail(new ConfigError("sign-in was not finished within 5 minutes")),
        o.timeout_ms ?? 300_000,
      );
      process.once("SIGINT", interrupted);

      const page = new URL(authorize);
      const p = page.searchParams;
      p.set("response_type", "code");
      p.set("client_id", "tm");
      p.set("redirect_uri", redirect);
      p.set("code_challenge", challenge);
      p.set("code_challenge_method", "S256");
      p.set("state", state);
      p.set("scope", o.keys ? `${o.scope} keys` : o.scope);
      p.set("key_name", o.key_name);
      if (o.key_expires) p.set("key_expires", o.key_expires);
      process.stderr.write(`Open this page to sign in:\n${page}\n`);
      if (o.open_browser) open_page(page.toString());
    });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupted);
    close();
  }

  let r: Response;
  try {
    r = await fetch(token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: "tm",
        code_verifier: verifier,
      }),
    });
  } catch {
    throw new ConfigError("sign-in failed: the server did not answer");
  }
  const body: any = await r.json().catch(() => ({}));
  if (r.status !== 200)
    throw new ConfigError(
      `sign-in failed: ${escaped(String(body?.error_description || body?.error || `HTTP ${r.status}`))}`,
    );
  return {
    key: check_key(String(body?.access_token ?? ""), "the sign-in"),
    scope: String(body?.scope ?? ""),
  };
}

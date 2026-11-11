// Drives the OAuth sign-in and consent page the way a browser does, for suites.

// RFC 7636 Appendix B.
export const PKCE = {
  verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
};

/** The eight request parameters every form on the page echoes as hidden inputs. */
export const PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
];

const ENTITIES: Record<string, string> = {
  "&#34;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&#43;": "+",
};

/** A hidden input's value, or null when the page has no hidden input of that name. */
export function field(html: string, name: string): string | null {
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\btype="hidden"/.test(tag)) continue;
    if (/\bname="([^"]*)"/.exec(tag)?.[1] !== name) continue;
    const raw = /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? "";
    // &amp; last, so "&amp;lt;" decodes to "&lt;" rather than "<".
    return raw.replace(/&#34;|&#39;|&lt;|&gt;|&#43;/g, (e) => ENTITIES[e]).replace(/&amp;/g, "&");
  }
  return null;
}

export function authorize_params(over: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: "cursor",
    redirect_uri: "http://localhost:5555/callback",
    response_type: "code",
    code_challenge: PKCE.challenge,
    code_challenge_method: "S256",
    scope: "read write",
    state: "xyz",
    ...over,
  };
}

const encode = (pairs: [string, string][]) =>
  pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

/** The page's form posted back: its flow and eight hidden parameters, `extra` added or overriding. */
export async function post_page(
  base: string,
  html: string,
  extra: Record<string, string>,
): Promise<Response> {
  const form: Record<string, string> = { flow: field(html, "flow") ?? "" };
  for (const n of PARAMS) form[n] = field(html, n) ?? "";
  return fetch(base + "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encode(Object.entries({ ...form, ...extra })),
    redirect: "manual",
  });
}

type Level = "read" | "write" | "manage" | "own";

/** GET the page, sign in by password, and return the page that answers it with its flow token. */
export async function sign_in_to_consent(
  base: string,
  params: Record<string, string>,
  who: { email: string; password: string },
): Promise<{ status: number; html: string; flow: string }> {
  const page = await fetch(`${base}/oauth/authorize?${encode(Object.entries(params))}`, {
    redirect: "manual",
  });
  const signin = await page.text();
  if (page.status !== 200 || field(signin, "flow") === null)
    throw new Error(`authorize page: ${page.status} ${signin.slice(0, 200)}`);
  const pw = await post_page(base, signin, { action: "password", ...who });
  const html = await pw.text();
  return { status: pw.status, html, flow: field(html, "flow") ?? "" };
}

/** POST /oauth/authorize with the eight parameters, `flow` and `fields`; redirects not followed. */
export async function post_consent(
  base: string,
  params: Record<string, string>,
  flow: string,
  fields: Record<string, string>,
): Promise<Response> {
  const form: Record<string, string> = { flow };
  for (const n of PARAMS) form[n] = params[n] ?? "";
  return fetch(base + "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encode(Object.entries({ ...form, ...fields })),
    redirect: "manual",
  });
}

export async function sign_in_and_approve(
  base: string,
  params: Record<string, string>,
  who: { email: string; password: string },
  opts: Level | { access?: Level; workspace?: string } = "write",
): Promise<{ code: string; location: string }> {
  const o = typeof opts === "string" ? { access: opts } : opts;
  const { status, html: consent } = await sign_in_to_consent(base, params, who);
  if (status !== 200 || !consent.includes('value="approve"'))
    throw new Error(`password stage: ${status} ${consent.slice(0, 400)}`);
  const extra: Record<string, string> = { action: "approve", access: o.access ?? "write" };
  if (o.workspace !== undefined) extra.workspace = o.workspace;
  const ap = await post_page(base, consent, extra);
  const location = ap.headers.get("Location") ?? "";
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (ap.status !== 302 || !code) throw new Error(`consent stage: ${ap.status} ${location}`);
  return { code, location };
}

export async function exchange(
  base: string,
  code: string,
  params: Record<string, string>,
  verifier = PKCE.verifier,
): Promise<{ status: number; body: any }> {
  const r = await fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encode([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", params.redirect_uri],
      ["client_id", params.client_id],
      ["code_verifier", verifier],
    ]),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text };
  }
  return { status: r.status, body };
}

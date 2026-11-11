/// <reference path="../../pb_data/types.d.ts" />
// Pure helpers and the pre-registered client table of the OAuth authorization server (contract: hosted-mcp-endpoint).

const CLIENTS = {
  cursor: {
    client_name: "Cursor",
    redirect_uris: [
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "http://localhost:8787/callback",
    ],
  },
};

function issuer() {
  return ($os.getenv("PB_PUBLIC_URL") || "http://127.0.0.1:8090").replace(
    /\/+$/,
    "",
  );
}

function mcp_resource() {
  const base = $os.getenv("MCP_PUBLIC_URL").replace(/\/+$/, "");
  return base ? base + "/mcp" : "";
}

// Lowercases the scheme://host[:port] part, leaving the path as sent.
function lower_origin(uri) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)(.*)$/.exec(uri);
  return m ? m[1].toLowerCase() + m[2] : uri;
}

function resource_ok(raw) {
  if (!raw) return true;
  const want = mcp_resource();
  return want !== "" && lower_origin(raw) === lower_origin(want);
}

// null when the body is too long or a pair does not decode; else the first value of each key, plus every key seen twice.
function parse_form(raw) {
  if (raw.length > 16384) return null;
  const params = {};
  const repeated = [];
  const pairs = raw.split("&");
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i] === "") continue;
    const eq = pairs[i].indexOf("=");
    const k = eq < 0 ? pairs[i] : pairs[i].slice(0, eq);
    const v = eq < 0 ? "" : pairs[i].slice(eq + 1);
    let key, value;
    try {
      key = decodeURIComponent(k.replace(/\+/g, " "));
      value = decodeURIComponent(v.replace(/\+/g, " "));
    } catch (_) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      if (repeated.indexOf(key) < 0) repeated.push(key);
    } else {
      Object.defineProperty(params, key, {
        value: value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return { params: params, repeated: repeated };
}

// "read", "write", or null for a scope the server does not offer.
function parse_scope(raw) {
  if (!raw || !raw.trim()) return "write";
  const values = raw.split(" ").filter((v) => v !== "");
  let write = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === "write") write = true;
    else if (values[i] !== "read" && values[i] !== "offline_access")
      return null;
  }
  return write ? "write" : "read";
}

function scope_text(scope) {
  return scope === "write" ? "read write" : "read";
}

// The JSVM has no btoa, so the base64url step is done by hand.
function pkce_s256(verifier) {
  const hex = $security.sha256(verifier);
  const abc =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2)
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) |
      ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) |
      (i + 2 < bytes.length ? bytes[i + 2] : 0);
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += abc[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += abc[n & 63];
  }
  return out;
}

function is_loopback(uri) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^#]*)?$/.test(uri);
}

// Exact match, or two loopback URIs equal once the port is removed.
function redirect_matches(registered, requested) {
  if (registered === requested) return true;
  if (!is_loopback(registered) || !is_loopback(requested)) return false;
  const strip = (u) => u.replace(/^(http:\/\/[^/:]+)(:\d+)?/, "$1");
  return strip(registered) === strip(requested);
}

// pairs: [[name, value], ...]; a pair with an empty value is left out.
function with_query(uri, pairs) {
  const q = pairs
    .filter((p) => p[1] !== undefined && p[1] !== null && p[1] !== "")
    .map((p) => encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]))
    .join("&");
  return uri + (uri.indexOf("?") >= 0 ? "&" : "?") + q;
}

function sign_flow(app, stage, q, uid, otp) {
  const payload = [stage, q, uid || "", otp || "", Date.now() + 600000].join(
    "|",
  );
  return (
    payload + "|" + $security.hs256(payload, app.store().get("oauthFlowSecret"))
  );
}

// {stage, q, uid, otp}, or null for a token that is forged, changed or expired.
function read_flow(app, token) {
  const parts = String(token || "").split("|");
  if (parts.length !== 6) return null;
  const payload = parts.slice(0, 5).join("|");
  const sig = $security.hs256(payload, app.store().get("oauthFlowSecret"));
  if (!$security.equal(sig, parts[5])) return null;
  if (!(Number(parts[4]) > Date.now())) return null;
  return { stage: parts[0], q: parts[1], uid: parts[2], otp: parts[3] };
}

function resolve_client(app, client_id) {
  if (Object.prototype.hasOwnProperty.call(CLIENTS, client_id)) {
    const c = CLIENTS[client_id];
    return {
      ok: true,
      client: {
        client_id: client_id,
        client_name: c.client_name,
        redirect_uris: c.redirect_uris,
        registered: true,
      },
    };
  }
  if (String(client_id).startsWith("https://")) {
    return {
      ok: false,
      message:
        "The app asking to sign in could not be verified right now. Try again in a minute.",
    };
  }
  return {
    ok: false,
    message: "The app asking to sign in is not known to Task Tracker.",
  };
}

function token_error(e, code, description) {
  e.response.header().set("Cache-Control", "no-store");
  e.response.header().set("Pragma", "no-cache");
  return e.json(400, { error: code, error_description: description });
}

module.exports = {
  CLIENTS,
  issuer,
  mcp_resource,
  parse_form,
  parse_scope,
  scope_text,
  pkce_s256,
  redirect_matches,
  is_loopback,
  resource_ok,
  sign_flow,
  read_flow,
  with_query,
  resolve_client,
  token_error,
};

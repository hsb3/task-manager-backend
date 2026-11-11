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

// The consent page shows the host, so it is a name ending in a letter label: no IP literal (a
// numeric host like 0x7f.1 parses to an address), Unicode, %, \ or userinfo.
// KEEP IN SYNC: services/mcp/src/cimd.ts "(?:[A-Za-z0-9-]+\.)*[A-Za-z][A-Za-z0-9-]*\.?(?::\d{1,5})?" "[\x21\x22\x24-\x5b\x5d-\x7e]*"
const AUTHORITY = String.raw`(?:[A-Za-z0-9-]+\.)*[A-Za-z][A-Za-z0-9-]*\.?(?::\d{1,5})?`;
const REST = String.raw`[\x21\x22\x24-\x5b\x5d-\x7e]*`;
const CLIENT_ID_SHAPE = new RegExp(`^https://${AUTHORITY}/${REST}$`);
const REDIRECT_SHAPE = new RegExp(
  `^(?:https://${AUTHORITY}|http://(?:localhost|127\\.0\\.0\\.1)(?::\\d{1,5})?)(?:/${REST})?$`,
);

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

// The highest level named, "read" for offline_access alone, "write" when blank, or null for a scope the server does not offer.
function parse_scope(raw) {
  const LADDER = require(`${__hooks}/lib/api_keys.js`).LEVELS;
  if (!raw || !raw.trim()) return "write";
  const values = raw.split(" ").filter((v) => v !== "");
  let top = 0;
  for (let i = 0; i < values.length; i++) {
    const n = LADDER.indexOf(values[i]);
    if (n > top) top = n;
    else if (n < 0 && values[i] !== "offline_access") return null;
  }
  return LADDER[top];
}

function scope_text(scope) {
  const LADDER = require(`${__hooks}/lib/api_keys.js`).LEVELS;
  return LADDER.slice(0, LADDER.indexOf(scope) + 1).join(" ");
}

// Read and write always; manage and own only when the client asked for them.
function offered_levels(requested) {
  const LADDER = require(`${__hooks}/lib/api_keys.js`).LEVELS;
  return LADDER.slice(0, Math.max(2, LADDER.indexOf(requested) + 1));
}

// KEEP IN SYNC: the workspace check of the api_keys create hook in pb_hooks/api_keys.pb.js, an owner or a `status = 'active'` member.
function consent_workspaces(app, uid) {
  const rows = arrayOf(new DynamicModel({ id: "", name: "" }));
  app
    .db()
    .newQuery(
      "SELECT w.id AS id, w.name AS name FROM workspaces w WHERE w.trashed = '' AND (w.owner = {:u} OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace = w.id AND [[m.user]] = {:u} AND m.status = 'active')) ORDER BY w.created, w.id",
    )
    .bind({ u: uid })
    .all(rows);
  return rows.map((r) => ({ id: r.id, name: r.name }));
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
    const unavailable = {
      ok: false,
      message:
        "The app asking to sign in could not be verified right now. Try again in a minute.",
    };
    const invalid = {
      ok: false,
      message: "The app asking to sign in could not be verified.",
    };
    if (client_id.length > 2000 || !CLIENT_ID_SHAPE.test(client_id))
      return invalid;
    const as_client = (c) =>
      c.redirect_uris.every((u) => u.length <= 2000 && REDIRECT_SHAPE.test(u))
        ? {
            ok: true,
            client: {
              client_id: client_id,
              client_name: c.client_name.slice(0, 200),
              redirect_uris: c.redirect_uris,
              registered: false,
            },
          }
        : invalid;
    const key = "cimd:" + client_id;
    const hit = app.store().get(key);
    if (hit && hit.exp > Date.now()) return as_client(hit.client);
    const url = $os.getenv("MCP_INTERNAL_URL").replace(/\/+$/, "");
    const secret = $os.getenv("MCP_INTERNAL_SECRET");
    if (!url || !secret) return unavailable;
    let res;
    try {
      res = $http.send({
        url: url + "/internal/client-metadata",
        method: "POST",
        headers: {
          "X-TM-Internal": secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: client_id }),
        timeout: 8,
      });
    } catch (_) {
      return unavailable;
    }
    if (res.statusCode === 200) {
      const client = res.json && res.json.client;
      if (
        !client ||
        typeof client.client_name !== "string" ||
        client.client_name === "" ||
        !Array.isArray(client.redirect_uris) ||
        !client.redirect_uris.length ||
        !client.redirect_uris.every((u) => typeof u === "string")
      )
        return unavailable;
      if (res.json.max_age > 0)
        app.store().set(key, {
          client: client,
          exp: Date.now() + res.json.max_age * 1000,
        });
      return as_client(client);
    }
    if (res.statusCode === 422) return invalid;
    return unavailable;
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

// The parameters every page form echoes as hidden inputs.
const PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
];

// The request parameters a flow token binds (D14).
function flow_q(p) {
  const v = (k) => p[k] || "";
  return $security.sha256(
    JSON.stringify([
      v("client_id"),
      v("redirect_uri"),
      v("code_challenge"),
      v("scope"),
      v("state"),
      v("resource"),
    ]),
  );
}

// {page: message} before step 4 passes, {redirect: error} after, else {ok: client}.
function validate_request(app, p) {
  if (!p.client_id || !p.redirect_uri)
    return { page: "The sign-in request is incomplete." };
  const r = resolve_client(app, p.client_id);
  if (!r.ok) return { page: r.message };
  if (!r.client.redirect_uris.some((u) => redirect_matches(u, p.redirect_uri)))
    return {
      page: "The app asked to return to an address it has not registered.",
    };
  if (p.response_type !== "code")
    return {
      page: "The app sent a sign-in request Task Tracker does not support.",
    };
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || "") ||
    p.code_challenge_method !== "S256"
  )
    return { redirect: "invalid_request" };
  if (parse_scope(p.scope) === null) return { redirect: "invalid_scope" };
  if (!resource_ok(p.resource)) return { redirect: "invalid_target" };
  return { ok: r.client };
}

function render(e, status, data) {
  const html = $template
    .loadFiles(`${__hooks}/views/oauth_authorize.html`)
    .render(data);
  const h = e.response.header();
  h.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  h.set("X-Frame-Options", "DENY");
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", "no-referrer");
  return e.html(status, html);
}

const LEVEL_LABELS = {
  read: "Read: see your workspaces, projects and items.",
  write: "Read and write: also create, edit and comment on items.",
  manage:
    "Manage: also change workspace settings, invitations and members, and empty the trash.",
  own: "Own: also change roles, hand over or delete workspaces, and accept invitations.",
};

// One stage of the page for a validated request; a fresh flow token binds it.
function render_stage(e, app, client, p, stage, message, uid, otp) {
  const params = {};
  PARAMS.forEach((k) => (params[k] = p[k] || ""));
  const host = (uri) => {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]*)/.exec(uri);
    return m ? m[1].toLowerCase() : uri;
  };
  return render(e, 200, {
    Stage: stage,
    Message: message || "",
    ClientName: client.client_name,
    ClientHost: client.registered ? "" : host(client.client_id),
    Registered: client.registered,
    RedirectHost: host(p.redirect_uri),
    Loopback: is_loopback(p.redirect_uri),
    Levels: offered_levels(parse_scope(p.scope)).map((v) => ({
      Value: v,
      Label: LEVEL_LABELS[v],
      Checked: v === parse_scope(p.scope),
    })),
    Workspaces: uid
      ? consent_workspaces(app, uid).map((w) => ({ Id: w.id, Name: w.name }))
      : [],
    Flow: sign_flow(app, stage, flow_q(p), uid, otp),
    Params: params,
  });
}

// "" when the users authRule lets the account sign in, else the refusal shown on the page.
function sign_in_refusal(app, u) {
  if (
    app.canAccessRecord(
      u,
      new RequestInfo({ auth: u }),
      u.collection().authRule,
    )
  )
    return "";
  if (!u.verified())
    return "This account cannot sign in yet: confirm your email address first.";
  if (!u.getBool("approved"))
    return "This account cannot sign in yet: it is waiting for approval.";
  return "This account cannot sign in yet.";
}

// Purges expired codes, stores a new one's fingerprint, and returns the code.
function issue_code(app, user, client, p, scope, reach, workspace) {
  app
    .db()
    .newQuery("DELETE FROM oauth_codes WHERE expires < {:now}")
    .bind({ now: new DateTime().string() })
    .execute();
  const code = $security.randomString(40);
  const rec = new Record(app.findCollectionByNameOrId("oauth_codes"));
  rec.set("code_hash", $security.sha256(code));
  rec.set("user", user.id);
  rec.set("client_id", client.client_id);
  rec.set("client_name", client.client_name);
  rec.set("redirect_uri", p.redirect_uri);
  rec.set("code_challenge", p.code_challenge);
  rec.set("scope", scope);
  rec.set("reach", reach);
  rec.set("workspace", workspace);
  rec.set(
    "expires",
    new Date(Date.now() + 600000).toISOString().replace("T", " "),
  );
  app.save(rec);
  return code;
}

module.exports = {
  CLIENTS,
  issuer,
  mcp_resource,
  parse_form,
  LADDER: require(`${__hooks}/lib/api_keys.js`).LEVELS,
  parse_scope,
  scope_text,
  offered_levels,
  consent_workspaces,
  pkce_s256,
  redirect_matches,
  is_loopback,
  resource_ok,
  sign_flow,
  read_flow,
  with_query,
  resolve_client,
  token_error,
  flow_q,
  validate_request,
  render,
  render_stage,
  sign_in_refusal,
  issue_code,
};

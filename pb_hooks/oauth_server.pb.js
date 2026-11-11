/// <reference path="../pb_data/types.d.ts" />
// The OAuth authorization server that MCP clients sign in through (contract: hosted-mcp-endpoint).

onBootstrap((e) => {
  e.next();
  // Per-boot secret that signs the sign-in page's flow tokens.
  e.app.store().set("oauthFlowSecret", $security.randomString(40));
});

require(`${__hooks}/lib/routes.js`).add(
  "GET /.well-known/oauth-authorization-server",
  (e) => {
    const iss = require(`${__hooks}/lib/oauth.js`).issuer();
    e.response.header().set("Cache-Control", "public, max-age=300");
    return e.json(200, {
      issuer: iss,
      authorization_endpoint: iss + "/oauth/authorize",
      token_endpoint: iss + "/oauth/token",
      revocation_endpoint: iss + "/oauth/revoke",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "write"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  },
);

require(`${__hooks}/lib/routes.js`).add("POST /oauth/token", (e) => {
  const lib = require(`${__hooks}/lib/oauth.js`);
  const form = lib.parse_form(toString(e.request.body));
  if (!form)
    return lib.token_error(
      e,
      "invalid_request",
      "The request body is not a valid form.",
    );
  const p = form.params;
  const incomplete = (names) =>
    form.repeated.length > 0 || names.some((n) => !p[n]);
  const known = (id) =>
    Object.prototype.hasOwnProperty.call(lib.CLIENTS, id) ||
    id.startsWith("https://");
  const DAY = 86400000;
  const at = (ms) => new Date(Date.now() + ms).toISOString().replace("T", " ");
  const fresh = (prefix) => prefix + $security.randomString(40);
  let out = null;

  if (!p.grant_type)
    return lib.token_error(e, "invalid_request", "grant_type is missing.");

  if (p.grant_type === "authorization_code") {
    if (incomplete(["code", "redirect_uri", "client_id", "code_verifier"]))
      return lib.token_error(
        e,
        "invalid_request",
        "A required parameter is missing or repeated.",
      );
    if (!known(p.client_id))
      return lib.token_error(e, "invalid_client", "The client is not known.");
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(p.code_verifier))
      return lib.token_error(
        e,
        "invalid_request",
        "code_verifier is malformed.",
      );
    if (!lib.resource_ok(p.resource))
      return lib.token_error(
        e,
        "invalid_target",
        "resource names another resource.",
      );
    // Writes commit because the callback returns instead of throwing; a found code is consumed whatever fails after.
    $app.runInTransaction((tx) => {
      let code;
      try {
        code = tx.findFirstRecordByData(
          "oauth_codes",
          "code_hash",
          $security.sha256(p.code),
        );
      } catch (_) {
        out = {
          error: ["invalid_grant", "The code is unknown, used or expired."],
        };
        return;
      }
      tx.delete(code);
      if (!code.getDateTime("expires").after(new DateTime())) {
        out = {
          error: ["invalid_grant", "The code is unknown, used or expired."],
        };
      } else if (code.getString("client_id") !== p.client_id) {
        out = {
          error: ["invalid_client", "The code was issued to another client."],
        };
      } else if (code.getString("redirect_uri") !== p.redirect_uri) {
        out = {
          error: [
            "invalid_grant",
            "redirect_uri does not match the authorization request.",
          ],
        };
      } else if (
        lib.pkce_s256(p.code_verifier) !== code.getString("code_challenge")
      ) {
        out = {
          error: [
            "invalid_grant",
            "code_verifier does not match the code challenge.",
          ],
        };
      } else {
        const access = fresh("tmk_");
        const refresh = fresh("tmr_");
        const key = new Record(tx.findCollectionByNameOrId("api_keys"));
        key.set("user", code.getString("user"));
        key.set("name", code.getString("client_name"));
        key.set("scope", code.getString("scope"));
        key.set("expires", at(DAY));
        key.set("client_id", p.client_id);
        key.set("key_hash", $security.sha256(access));
        key.set("refresh_hash", $security.sha256(refresh));
        key.set("refresh_expires", at(30 * DAY));
        key.set("refresh_prev_hash", "");
        tx.save(key);
        out = { ok: { access, refresh, scope: code.getString("scope") } };
      }
    });
  } else if (p.grant_type === "refresh_token") {
    if (incomplete(["refresh_token", "client_id"]))
      return lib.token_error(
        e,
        "invalid_request",
        "A required parameter is missing or repeated.",
      );
    if (!known(p.client_id))
      return lib.token_error(e, "invalid_client", "The client is not known.");
    if (!lib.resource_ok(p.resource))
      return lib.token_error(
        e,
        "invalid_target",
        "resource names another resource.",
      );
    const asked = p.scope ? lib.parse_scope(p.scope) : "";
    if (asked === null)
      return lib.token_error(
        e,
        "invalid_scope",
        "scope is not one the server offers.",
      );
    // The replay's revocation commits before invalid_grant is answered.
    $app.runInTransaction((tx) => {
      const hash = $security.sha256(p.refresh_token);
      const find = (field) => {
        try {
          return tx.findFirstRecordByData("api_keys", field, hash);
        } catch (_) {
          return null;
        }
      };
      const key = find("refresh_hash");
      if (!key) {
        const used = find("refresh_prev_hash");
        if (used) {
          used.set("revoked", true);
          tx.save(used);
          out = {
            error: [
              "invalid_grant",
              "The refresh token was already used; the sign-in has ended.",
            ],
          };
        } else {
          out = {
            error: [
              "invalid_grant",
              "The refresh token is unknown or expired.",
            ],
          };
        }
        return;
      }
      if (key.getString("client_id") !== p.client_id) {
        out = {
          error: [
            "invalid_client",
            "The refresh token was issued to another client.",
          ],
        };
      } else if (
        key.getBool("revoked") ||
        !key.getDateTime("refresh_expires").after(new DateTime())
      ) {
        out = {
          error: ["invalid_grant", "The refresh token is unknown or expired."],
        };
      } else if (asked && asked !== key.getString("scope")) {
        out = {
          error: [
            "invalid_scope",
            "A refresh keeps the scope that was granted.",
          ],
        };
      } else {
        const access = fresh("tmk_");
        const refresh = fresh("tmr_");
        key.set("refresh_prev_hash", key.getString("refresh_hash"));
        key.set("key_hash", $security.sha256(access));
        key.set("refresh_hash", $security.sha256(refresh));
        key.set("refresh_expires", at(30 * DAY));
        key.set("expires", at(DAY));
        tx.save(key);
        out = { ok: { access, refresh, scope: key.getString("scope") } };
      }
    });
  } else {
    return lib.token_error(
      e,
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported.",
    );
  }

  if (out.error) return lib.token_error(e, out.error[0], out.error[1]);
  e.response.header().set("Cache-Control", "no-store");
  e.response.header().set("Pragma", "no-cache");
  return e.json(200, {
    access_token: out.ok.access,
    token_type: "Bearer",
    expires_in: 86400,
    refresh_token: out.ok.refresh,
    scope: lib.scope_text(out.ok.scope),
  });
});

require(`${__hooks}/lib/routes.js`).add("POST /oauth/revoke", (e) => {
  const lib = require(`${__hooks}/lib/oauth.js`);
  const form = lib.parse_form(toString(e.request.body));
  if (!form)
    return lib.token_error(
      e,
      "invalid_request",
      "The request body is not a valid form.",
    );
  const p = form.params;
  if (form.repeated.length > 0 || !p.token || !p.client_id)
    return lib.token_error(
      e,
      "invalid_request",
      "A required parameter is missing or repeated.",
    );
  if (
    !Object.prototype.hasOwnProperty.call(lib.CLIENTS, p.client_id) &&
    !p.client_id.startsWith("https://")
  )
    return lib.token_error(e, "invalid_client", "The client is not known.");
  const field = p.token.startsWith("tmk_")
    ? "key_hash"
    : p.token.startsWith("tmr_")
      ? "refresh_hash"
      : "";
  let key = null;
  if (field) {
    try {
      key = $app.findFirstRecordByData(
        "api_keys",
        field,
        $security.sha256(p.token),
      );
    } catch (_) {}
  }
  if (key && key.getString("client_id") === "")
    return lib.token_error(
      e,
      "unsupported_token_type",
      "Keys minted by hand are revoked in the key list.",
    );
  if (key && key.getString("client_id") !== p.client_id)
    return lib.token_error(
      e,
      "invalid_client",
      "The token was issued to another client.",
    );
  if (key) {
    key.set("revoked", true);
    $app.save(key);
  }
  e.response.header().set("Cache-Control", "no-store");
  e.response.header().set("Pragma", "no-cache");
  return e.noContent(200);
});

require(`${__hooks}/lib/routes.js`).add("GET /oauth/authorize", (e) => {
  const lib = require(`${__hooks}/lib/oauth.js`);
  const form = lib.parse_form(e.request.url.rawQuery);
  if (!form || form.repeated.length > 0)
    return lib.render(e, 400, {
      Stage: "error",
      Message: "The sign-in request is malformed.",
    });
  const p = form.params;
  let v;
  try {
    v = lib.validate_request($app, p);
  } catch (err) {
    $app.logger().error("oauth authorize failed", "error", String(err));
    return lib.render(e, 400, {
      Stage: "error",
      Message: "The sign-in could not continue. Try again.",
    });
  }
  if (v.page) return lib.render(e, 400, { Stage: "error", Message: v.page });
  const back = (pair) =>
    e.redirect(
      302,
      lib.with_query(p.redirect_uri, [
        pair,
        ["state", p.state],
        ["iss", lib.issuer()],
      ]),
    );
  if (v.redirect) return back(["error", v.redirect]);
  try {
    return lib.render_stage(e, $app, v.ok, p, "signin", "", "", "");
  } catch (err) {
    $app.logger().error("oauth authorize failed", "error", String(err));
    return back(["error", "server_error"]);
  }
});

require(`${__hooks}/lib/routes.js`).add("POST /oauth/authorize", (e) => {
  const lib = require(`${__hooks}/lib/oauth.js`);
  const form = lib.parse_form(toString(e.request.body));
  if (!form || form.repeated.length > 0)
    return lib.render(e, 400, {
      Stage: "error",
      Message: "The sign-in request is malformed.",
    });
  const p = form.params;
  let v;
  try {
    v = lib.validate_request($app, p);
  } catch (err) {
    $app.logger().error("oauth authorize failed", "error", String(err));
    return lib.render(e, 400, {
      Stage: "error",
      Message: "The sign-in could not continue. Try again.",
    });
  }
  if (v.page) return lib.render(e, 400, { Stage: "error", Message: v.page });
  const back = (pair) =>
    e.redirect(
      302,
      lib.with_query(p.redirect_uri, [
        pair,
        ["state", p.state],
        ["iss", lib.issuer()],
      ]),
    );
  if (v.redirect) return back(["error", v.redirect]);
  const client = v.ok;
  const show = (stage, message, uid, otp) =>
    lib.render_stage(e, $app, client, p, stage, message, uid, otp);
  const find_user = (email) => {
    try {
      return $app.findAuthRecordByEmail("users", email || "");
    } catch (_) {
      return null;
    }
  };
  const WRONG_CODE = "That code is wrong or has expired. Request a new one.";
  try {
    const flow = lib.read_flow($app, p.flow);
    const needs = {
      password: "signin",
      send_code: "signin",
      verify_code: "code",
      approve: "consent",
      deny: "consent",
    };
    if (
      !flow ||
      flow.q !== lib.flow_q(p) ||
      !Object.prototype.hasOwnProperty.call(needs, p.action) ||
      needs[p.action] !== flow.stage
    )
      return show(
        "signin",
        "This sign-in took too long or was changed. Start again.",
      );

    if (p.action === "password") {
      const u = find_user(p.email);
      if (!u || !u.validatePassword(p.password || ""))
        return show(
          "signin",
          "That email and password do not match an account.",
        );
      const refusal = lib.sign_in_refusal($app, u);
      return refusal ? show("signin", refusal) : show("consent", "", u.id);
    }

    if (p.action === "send_code") {
      const u = find_user(p.email);
      if (!u) return show("code", "", "", "");
      const code = $security.randomStringWithAlphabet(8, "0123456789");
      const otp = new Record($app.findCollectionByNameOrId("_otps"));
      otp.set("collectionRef", u.collection().id);
      otp.set("recordRef", u.id);
      otp.set("sentTo", u.email());
      otp.setPassword(code);
      $app.save(otp);
      try {
        $mails.sendRecordOTP($app, u, otp.id, code);
      } catch (err) {
        $app
          .logger()
          .error("oauth sign-in code not sent", "error", String(err));
        return show(
          "signin",
          "The code could not be sent. Try again in a minute, or sign in with your password.",
        );
      }
      return show("code", "", "", otp.id);
    }

    if (p.action === "verify_code") {
      // The callback returns instead of throwing, so a wrong guess's count and deletion commit.
      let uid = "";
      $app.runInTransaction((tx) => {
        let otp;
        try {
          otp = tx.findOTPById(flow.otp);
        } catch (_) {
          return;
        }
        const u = tx.findRecordById(
          otp.getString("collectionRef"),
          otp.getString("recordRef"),
        );
        if (otp.hasExpired(u.collection().otp.durationTime())) {
          tx.delete(otp);
          return;
        }
        if (!otp.validatePassword(p.code || "")) {
          const key = "oauth_otp_tries:" + otp.id;
          const tries = ($app.store().get(key) || 0) + 1;
          if (tries >= 5) {
            tx.delete(otp);
            $app.store().remove(key);
          } else {
            $app.store().set(key, tries);
          }
          return;
        }
        tx.delete(otp);
        $app.store().remove("oauth_otp_tries:" + otp.id);
        uid = u.id;
      });
      if (!uid) return show("code", WRONG_CODE, "", flow.otp);
      const refusal = lib.sign_in_refusal(
        $app,
        $app.findRecordById("users", uid),
      );
      return refusal ? show("code", refusal, "", "") : show("consent", "", uid);
    }

    if (p.action === "deny") return back(["error", "access_denied"]);

    if (p.access !== "read" && p.access !== "write")
      return show("consent", "", flow.uid);
    const code = lib.issue_code(
      $app,
      $app.findRecordById("users", flow.uid),
      client,
      p,
      p.access,
    );
    return back(["code", code]);
  } catch (err) {
    $app.logger().error("oauth authorize failed", "error", String(err));
    return back(["error", "server_error"]);
  }
});

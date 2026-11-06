/// <reference path="../../pb_data/types.d.ts" />
// The one reading of the invitation settings and the one expiry instant every invitation read, the accept refusal and the sweep share, and the hand-off to the invitation mail route; require() it inside a handler body.

// An app_settings.value reads back either a plain number or a JSVM byte-array.
function readIntSetting(app, key, fallback) {
  try {
    const raw = app
      .findFirstRecordByFilter("app_settings", "key = {:k}", { k: key })
      .get("value");
    let parsed = NaN;
    if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
      let text = "";
      for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);
      parsed = parseInt(text, 10);
    } else {
      parsed = parseInt(String(raw), 10);
    }
    return !isNaN(parsed) && parsed >= 0 ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function expiryDays(app) {
  return readIntSetting(app, "invitation_expiry_days", 7);
}

// A stored-datetime string `days` before now, the form a created filter compares against.
function daysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().replace("T", " ");
}

// expired = now >= created + days: the accept route refuses at the same instant.
function expiry(created, days) {
  const ms = Date.parse(String(created).replace(" ", "T")) + days * 86400000;
  return {
    expires_at: new Date(ms).toISOString().replace("T", " "),
    expired: Date.now() >= ms,
  };
}

// Posts the invitation to this server's own mail route; "" once it has answered 204, else why not.
function dispatchMail(app, id) {
  // KEEP IN SYNC: pb_hooks/mail.pb.js `--http=` — this server's own listener, from serve's --http flag (PocketBase default 127.0.0.1:8090).
  let addr = "127.0.0.1:8090";
  const args = $os.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--http" && i + 1 < args.length) addr = args[i + 1];
    else if (args[i].indexOf("--http=") === 0) addr = args[i].slice(7);
  }
  addr = addr
    .replace(/^(0\.0\.0\.0)?:/, "127.0.0.1:")
    .replace(/^\[::\]:/, "[::1]:");
  try {
    const res = $http.send({
      url: `http://${addr}/internal/invitation-mail/${id}`,
      method: "POST",
      headers: { "X-Invitation-Mail": app.store().get("invitationMailSecret") },
      timeout: 1,
    });
    return res.statusCode === 204 ? "" : `loopback answered ${res.statusCode}`;
  } catch (err) {
    return String(err);
  }
}

module.exports = { readIntSetting, expiryDays, daysAgo, expiry, dispatchMail };

/// <reference path="../../pb_data/types.d.ts" />
// The one reading of the invitation settings and the one expiry instant every invitation read, the accept refusal and the sweep share; require() it inside a handler body.

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

module.exports = { readIntSetting, expiryDays, daysAgo, expiry };

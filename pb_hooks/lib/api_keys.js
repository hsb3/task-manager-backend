/// <reference path="../../pb_data/types.d.ts" />
// API key helpers: whether request text names api_keys (decision:api-key-reads-refused) and a key's plain request-store object; require() inside a handler body.

// Checks the raw text, its percent-decoding (byte by byte, as Go reads a query, never throwing)
// and that decoding with JSON \u escapes resolved, so no spelling PocketBase decodes slips past.
function namesApiKeys(app, text) {
  const id = app.findCollectionByNameOrId("api_keys").id.toLowerCase();
  const raw = String(text);
  const decoded = raw
    .replace(/\+/g, " ")
    .replace(/%([0-9a-fA-F]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
  const unescaped = decoded.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  return [raw, decoded, unescaped].some((t) => {
    const lower = t.toLowerCase();
    return lower.indexOf("api_keys") !== -1 || lower.indexOf(id) !== -1;
  });
}

// The request-store and `me` view of a key; a key made before reach existed reads as reach all.
function keyInfo(key) {
  return {
    id: key.id,
    scope: key.getString("scope"),
    expires: key.getString("expires"),
    client_id: key.getString("client_id"),
    reach: key.getString("reach") || "all",
    workspace: key.getString("workspace"),
    // The JSON round trip yields a plain array.
    projects: JSON.parse(JSON.stringify(key.getStringSlice("projects"))),
  };
}

module.exports = { namesApiKeys, keyInfo };

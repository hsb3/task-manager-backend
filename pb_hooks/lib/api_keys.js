/// <reference path="../../pb_data/types.d.ts" />
// Whether request text names the api_keys collection (decision:api-key-reads-refused); require() it inside a handler body.

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

module.exports = { namesApiKeys };

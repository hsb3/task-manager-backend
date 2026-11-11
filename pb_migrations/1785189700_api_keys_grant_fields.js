/// <reference path="../pb_data/types.d.ts" />
// api_keys grant fields (contract: hosted-mcp-endpoint): the app a sign-in minted a key for, and its refresh-token state.
const TAIL = " && @request.body.client_id:isset = false";
const FIELDS = [
  {
    id: "text4200600009",
    name: "client_id",
    type: "text",
    max: 2000,
    help: "The app a sign-in minted this key for, or empty for a key minted by hand; set by the server, and a later change is refused.",
  },
  {
    id: "text4200600010",
    name: "refresh_hash",
    type: "text",
    hidden: true,
    max: 64,
    help: "A fingerprint of the sign-in's current refresh token, filled by the server and never shown to clients.",
  },
  {
    id: "date4200600011",
    name: "refresh_expires",
    type: "date",
    hidden: true,
    help: "When the sign-in's current refresh token stops working; set by the server.",
  },
  {
    id: "text4200600012",
    name: "refresh_prev_hash",
    type: "text",
    hidden: true,
    max: 64,
    help: "A fingerprint of the refresh token the current one replaced, kept so a replayed token ends the sign-in.",
  },
];
// [name, unique, column]; each index skips the empty value a hand-minted key holds.
const INDEXES = [
  ["idx_api_keys_refresh_hash", true, "refresh_hash"],
  ["idx_api_keys_refresh_prev_hash", false, "refresh_prev_hash"],
];
// [field, help after this migration, help before it, restored on down]
const HELP = [
  [
    "key_hash",
    "A fingerprint of the key, filled by the server and never shown to clients; a value sent at create is replaced, a client's later change is refused, and a sign-in's refresh replaces it.",
    "A fingerprint of the key, filled by the server and never shown to clients; a value sent at create is replaced and a later change is refused.",
  ],
  [
    "expires",
    "When the key stops working, or empty for a key that never expires; a client sets it only at create, and a sign-in's refresh moves it forward.",
    "When the key stops working, or empty for a key that never expires; it can be set only at create.",
  ],
];

function apply(app, back) {
  const c = app.findCollectionByNameOrId("api_keys");
  const parts = String(c.updateRule).split(TAIL);
  // A rule that drifted from the shape this expects aborts the boot instead of half-applying.
  if (back ? parts.length !== 2 || parts[1] !== "" : parts.length !== 1) {
    throw new Error("api_keys.updateRule: expected " + (back ? "exactly one trailing " : "no ") + TAIL);
  }
  c.updateRule = back ? parts[0] : c.updateRule + TAIL;
  for (const f of FIELDS) {
    if (back) c.fields.removeById(f.id);
    else c.fields.add(new Field(f));
  }
  for (const [name, unique, col] of INDEXES) {
    if (back) c.removeIndex(name);
    else c.addIndex(name, unique, "`" + col + "`", "`" + col + "` != ''");
  }
  for (const [name, after, before] of HELP) c.fields.getByName(name).help = back ? before : after;
  app.save(c);
}

migrate(
  (app) => apply(app, false),
  (app) => apply(app, true),
);

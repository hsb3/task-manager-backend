/// <reference path="../pb_data/types.d.ts" />
// api_keys gain manage_keys and last_used, both server-written (change key-minting-cli).
const FROM = "@request.body.expires:isset = false &&";
const TO =
  "@request.body.expires:isset = false && @request.body.manage_keys:isset = false && @request.body.last_used:isset = false &&";

// Must match exactly once, so a rule that drifted aborts the boot instead of half-applying.
function rules(c, back) {
  const [f, t] = back ? [TO, FROM] : [FROM, TO];
  const parts = String(c.updateRule).split(f);
  if (parts.length !== 2) throw new Error("api_keys.updateRule: expected exactly one occurrence of " + f);
  c.updateRule = parts.join(t);
}

migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("api_keys");
    c.fields.add(
      new BoolField({
        id: "bool4200609001",
        name: "manage_keys",
        required: false,
        help: "Whether this key may list and revoke its user's keys; it can never mint one. Set by sign-in through tm login or by a superuser at create; a create value from anyone else is replaced with false, and a later change is refused.",
      }),
    );
    c.fields.add(
      new DateField({
        id: "date4200609002",
        name: "last_used",
        required: false,
        help: "When the key last authenticated a request, to the minute, or empty if never; set by the server only.",
      }),
    );
    rules(c, false);
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("api_keys");
    rules(c, true);
    c.fields.removeById("bool4200609001");
    c.fields.removeById("date4200609002");
    app.save(c);
  },
);

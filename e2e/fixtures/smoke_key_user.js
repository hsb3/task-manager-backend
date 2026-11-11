// Smoke-only fixture: one approved, verified user for the API-key probes; copied into the image at run time.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const u = new Record(users);
    u.set("email", "smoke-keys@example.com");
    u.set("name", "Smoke Keys");
    u.setPassword("smoke-keys-123456");
    u.set("verified", true);
    u.set("approved", true);
    app.save(u);
  },
  (app) => {},
);

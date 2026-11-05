/// <reference path="../pb_data/types.d.ts" />
// Seed the global app_settings key/value store. Idempotent upsert-by-id.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("app_settings")

  let rec
  try { rec = app.findRecordById("app_settings", "3bqdrlcbojcexzg") }
  catch (_) { rec = new Record(collection); rec.set("id", "3bqdrlcbojcexzg") }
  rec.set("key", "trash_retention_days")
  rec.set("value", 30)
  app.save(rec)
}, (app) => {
  // No-op down: seed data is re-established on any fresh boot.
})

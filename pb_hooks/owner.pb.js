/// <reference path="../pb_data/types.d.ts" />
// projects/workspaces/saved_views: owner is stamped from the caller at create (decision:backend-owns-business-rules), so
// no client has to resolve and send it. The createRule refuses a submitted owner naming anyone
// else (v2:1785185200_collections.js); this hook fills the omitted one.

// Pooled JSVM: each callback runs in an isolated runtime and CANNOT reach a shared
// top-level helper — each block below is inlined byte-identically per collection on purpose.
// KEEP IN SYNC: owner-capture block (projects / workspaces / saved_views).

onRecordCreateRequest((e) => {
  // A superuser create keeps what it submitted (seed/import fidelity).
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("owner", actor);
  e.next();
}, "projects");

onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("owner", actor);
  e.next();
}, "workspaces");

onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("owner", actor);
  e.next();
}, "saved_views");

// A new workspace gives its owner an active admin roster row beneath workspaces.owner. Universal
// after-create tier, so a signup provision, a reprovision and a direct API create all reach it; it
// never throws, because this tier also fires for a migration's own save and a throw there aborts the boot.
onRecordAfterCreateSuccess((e) => {
  const ownerId = e.record.getString("owner");
  try {
    if (ownerId) {
      try {
        e.app.findFirstRecordByFilter(
          "workspace_members",
          "workspace = {:w} && user = {:u}",
          { w: e.record.id, u: ownerId },
        );
      } catch (_) {
        const mem = new Record(
          e.app.findCollectionByNameOrId("workspace_members"),
        );
        mem.set("workspace", e.record.id);
        mem.set("user", ownerId);
        mem.set("role", "admin");
        mem.set("status", "active");
        e.app.save(mem);
      }
    }
  } catch (err) {
    e.app
      .logger()
      .error(
        "owner membership provision failed",
        "workspace",
        e.record.id,
        "err",
        String(err),
      );
  }
  e.next();
}, "workspaces");

// An account delete empties saved_views.owner (kata bwpj); a personal view is readable only by its
// owner, so an emptied one is unreachable. Universal tier: the purge cron deletes programmatically.
onRecordAfterDeleteSuccess((e) => {
  try {
    const orphans = e.app.findRecordsByFilter(
      "saved_views",
      "owner = '' && scope = 'personal'",
      "",
      0,
      0,
    );
    for (const v of orphans) e.app.delete(v);
  } catch (err) {
    e.app
      .logger()
      .error(
        "personal view cleanup failed",
        "user",
        e.record.id,
        "err",
        String(err),
      );
  }
  e.next();
}, "users");

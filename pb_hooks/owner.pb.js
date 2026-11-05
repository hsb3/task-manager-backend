/// <reference path="../pb_data/types.d.ts" />
// projects/workspaces/saved_views: owner is stamped from the caller at create (decision-077), so
// no client has to resolve and send it. The createRule refuses a submitted owner naming anyone
// else (v2:1785184000_owner_defaults.js); this hook fills the omitted one.

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

/// <reference path="../pb_data/types.d.ts" />

// ═══════════════════════════════════════════════════════════════════════════
// W3 (#66) — soft-delete trash: DELETE interception + second-delete-purges +
// superuser hard-purge, plus a daily expiry-purge cron and a superuser-only
// manual-trigger route.
//
// PB JSVM CONSTRAINT (learned the hard way, main.pb.js:130-141 / alerts.pb.js:20-25,
// re-proven for THIS file in the W3 rehearsal): a hook/cron/route handler runs in
// an ISOLATED pooled runtime and CANNOT call a module-top-level function — doing so
// throws `ReferenceError` AT REQUEST TIME (every non-superuser DELETE silently became
// a generic 400, visible only in _logs). So EVERY block below inlines its full
// trash/purge/auth logic; the expiry sweep is inlined byte-identically in BOTH the
// cron closure and the route handler. There are deliberately NO shared top-level
// helpers here. Keep the duplicated blocks in sync BY HAND (keep-in-sync comments
// mark each pair).
//
// Trash mechanism (M2, rehearsed RC-1/RC-2):
//   - superuser DELETE  -> e.next() (HARD PURGE escape hatch; delete-request hooks DO
//                          fire for superusers, per the R7 guard main.pb.js:242).
//   - first DELETE (row not trashed) -> set trashed = now, programmatic save (bypasses
//                          request hooks, same rationale as main.pb.js:179), then
//                          return e.noContent(204). A BARE return yields HTTP 200 and
//                          breaks the 10 status-only cleanup suites — the 204 is
//                          load-bearing (RC-1).
//   - second DELETE (row already trashed) -> PURGE:
//       * items (tasks/decisions/milestones/documents): the item deleteRule was opened
//         to the member tier for delete-to-trash, but purge = owner/admin, so re-check
//         authorization INLINE (walk to the owning workspace; allow if caller ==
//         workspace.owner OR a workspace_members (workspace, caller, role="admin") row
//         exists — the R7 query idiom main.pb.js:244-257). Unauthorized -> 400 veto;
//         authorized -> e.next() (real delete).
//       * projects/workspaces: the deleteRule already gates to the purge actor set
//         (owner/admin for projects, owner for workspaces), so e.next() directly.
// ═══════════════════════════════════════════════════════════════════════════

// Hook files load in no stable order per boot: this must register above the noContent(204) arms below.
// KEEP IN SYNC: precondition.pb.js unguarded-collection refusal, "This change could not be saved. Reload the page and try again."
onRecordDeleteRequest(
  (e) => {
    if ((e.requestInfo().query || {}).expected_updated_at === undefined)
      return e.next();
    throw new ApiError(
      400,
      "This change could not be saved. Reload the page and try again.",
      null,
    );
  },
  "tasks",
  "decisions",
  "milestones",
  "documents",
  "projects",
  "workspaces",
);

// Only DELETE trashes (card te4g): an update may touch `trashed`/`trashed_by` only to restore the row.
// Superusers stay exempt: their writes are the documented way to backdate or repair trash.
onRecordUpdateRequest(
  (e) => {
    if (e.auth && e.auth.isSuperuser()) return e.next();
    var orig = e.record.original();
    var stillTrashed = String(e.record.get("trashed") || "") !== "";
    var fields = ["trashed", "trashed_by"];
    for (var i = 0; i < fields.length; i++) {
      var was = String(orig.get(fields[i]) || "");
      var now = String(e.record.get(fields[i]) || "");
      if (now !== was && (now !== "" || stillTrashed))
        throw new BadRequestError(
          "This update would move the record into the trash or change its trash record. Delete the record to move it to the trash; an update can only restore it.",
        );
    }
    return e.next();
  },
  "tasks",
  "decisions",
  "milestones",
  "documents",
  "projects",
  "workspaces",
);

// ── tasks: delete-to-trash / second-delete-purges (item, workspace via project) ──
// KEEP IN SYNC with the decisions/milestones/documents item hooks below (same
// shape; only the workspace traversal differs — tasks reach the workspace via
// project.workspace). Superuser/first-DELETE branches identical across all six.
onRecordDeleteRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) {
    return e.next(); // HARD PURGE — superuser bypasses trash
  }
  var t = e.record.get("trashed");
  var isTrashed = String(t) !== "";
  if (!isTrashed) {
    // first DELETE -> trash (programmatic save bypasses request hooks)
    e.record.set("trashed", new Date().toISOString().replace("T", " "));
    e.record.set("trashed_by", e.auth ? e.auth.id : "");
    e.app.save(e.record);
    // KEEP IN SYNC: realtime.pb.js hides on the same `findRecordById("projects", __pid)` read — a row parked in a trashed
    // project was ALREADY hidden before this set, so hidden -> hidden is no transition and
    // owes no envelope; the live -> trashed hide still broadcasts, below.
    var __hiddenBefore = false;
    var __pid = e.record.get("project");
    if (__pid) {
      try {
        __hiddenBefore =
          String(
            e.app.findRecordById("projects", __pid).get("trashed") || "",
          ) !== "";
      } catch (__e) {
        __hiddenBefore = true; // an unreadable project can never satisfy project.trashed = ""
      }
    }
    if (__hiddenBefore) return e.noContent(204);
    // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
    // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
    var __wsRec = null;
    try {
      __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
    } catch (__e) {}
    if (!__wsRec || String(__wsRec.get("trashed") || "") !== "")
      return e.noContent(204);
    // the programmatic save above bypasses the request-hook broadcast tier, so the
    // trash-SET event is emitted inline — its `rawChangedFields` envelope + delivery guard KEEP IN SYNC with realtime.pb.js
    try {
      var __ws = e.record.get("workspace");
      var __env = {
        collection: "tasks",
        id: e.record.id,
        action: "update",
        actorId: e.auth ? e.auth.id : "",
        rawChangedFields: ["trashed", "trashed_by"],
        rawRecord: JSON.parse(JSON.stringify(e.record)),
      };
      var __msg = new SubscriptionMessage({
        name: "rt:project_items:" + __ws,
        data: JSON.stringify(__env),
      });
      var __owner = __wsRec.get("owner");
      // tasks carry no draft concept at all, so this broadcast stays unrestricted where
      // the prose collections' are draft-scoped (base-rules contract).
      var __clients = e.app.subscriptionsBroker().clients();
      var __allow = Object.create(null); // prototype-less: a subscriber id must never inherit a verdict
      for (var __cid in __clients) {
        var __client = __clients[__cid];
        if (!__client.hasSubscription("rt:project_items:" + __ws)) continue;
        var __auth = __client.get("auth");
        var __uid = __auth ? String(__auth.id) : "";
        if (__allow[__uid] === undefined) {
          // KEEP IN SYNC: realtime.pb.js's delivery guard — same owner-or-member predicate, `user = {:u} && status = 'active'`,
          // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-484).
          var __ok =
            !!(__auth && __auth.isSuperuser()) ||
            (!!__uid && __uid === __owner);
          if (!__ok && __uid) {
            try {
              e.app.findFirstRecordByFilter(
                "workspace_members",
                "workspace = {:w} && user = {:u} && status = 'active'",
                { w: __ws, u: __uid },
              );
              __ok = true;
            } catch (__e) {}
          }
          __allow[__uid] = __ok;
        }
        if (__allow[__uid]) __client.send(__msg);
      }
    } catch (__err) {
      e.app
        .logger()
        .error("rt:project_items broadcast failed", "err", String(__err));
    }
    return e.noContent(204);
  }
  // already trashed -> PURGE: re-check owner/admin authorization inline
  var project = e.app.findRecordById("projects", e.record.get("project"));
  var workspace = e.app.findRecordById("workspaces", project.get("workspace"));
  var authorized = e.auth && e.auth.id === workspace.get("owner");
  if (!authorized && e.auth) {
    try {
      // KEEP IN SYNC: the purged collection's own deleteRule — only an ACTIVE membership
      // confers admin authority, so a suspended admin cannot purge (PBTT-431).
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && role = {:r} && status = {:s}",
        { w: workspace.id, u: e.auth.id, r: "admin", s: "active" },
      );
      authorized = true;
    } catch (_) {
      authorized = false;
    }
  }
  if (!authorized) {
    throw new BadRequestError(
      "cannot purge: only the workspace owner or an admin may permanently delete a trashed item",
    );
  }
  return e.next();
}, "tasks");

// ── decisions: delete-to-trash / second-delete-purges (item, direct workspace) ──
// KEEP IN SYNC with tasks/milestones/documents. Workspace reached directly via
// e.record.get("workspace") (decisions/milestones/documents all share this).
onRecordDeleteRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) {
    return e.next(); // HARD PURGE — superuser bypasses trash
  }
  var t = e.record.get("trashed");
  var isTrashed = String(t) !== "";
  if (!isTrashed) {
    // first DELETE -> trash (programmatic save bypasses request hooks)
    e.record.set("trashed", new Date().toISOString().replace("T", " "));
    e.record.set("trashed_by", e.auth ? e.auth.id : "");
    e.app.save(e.record);
    // KEEP IN SYNC: realtime.pb.js hides on the same `findRecordById("projects", __pid)` read — a row parked in a trashed
    // project was ALREADY hidden before this set, so hidden -> hidden is no transition and
    // owes no envelope; the live -> trashed hide still broadcasts, below.
    var __hiddenBefore = false;
    var __pid = e.record.get("project");
    if (__pid) {
      try {
        __hiddenBefore =
          String(
            e.app.findRecordById("projects", __pid).get("trashed") || "",
          ) !== "";
      } catch (__e) {
        __hiddenBefore = true; // an unreadable project can never satisfy project.trashed = ""
      }
    }
    if (__hiddenBefore) return e.noContent(204);
    // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
    // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
    var __wsRec = null;
    try {
      __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
    } catch (__e) {}
    if (!__wsRec || String(__wsRec.get("trashed") || "") !== "")
      return e.noContent(204);
    // the programmatic save above bypasses the request-hook broadcast tier, so the
    // trash-SET event is emitted inline — its `rawChangedFields` envelope + delivery guard KEEP IN SYNC with realtime.pb.js
    try {
      var __ws = e.record.get("workspace");
      var __env = {
        collection: "decisions",
        id: e.record.id,
        action: "update",
        actorId: e.auth ? e.auth.id : "",
        rawChangedFields: ["trashed", "trashed_by"],
        rawRecord: JSON.parse(JSON.stringify(e.record)),
      };
      var __msg = new SubscriptionMessage({
        name: "rt:project_items:" + __ws,
        data: JSON.stringify(__env),
      });
      var __owner = __wsRec.get("owner");
      // Draft privacy — KEEP IN SYNC: realtime.pb.js's `&& role = 'admin'` draft branch and this collection's
      // viewRule (an ACTIVE-member author OR the workspace owner OR an ACTIVE admin); an empty author
      // matches nobody, so a legacy/superuser-created draft stays owner+admin-only (PBTT-543).
      var __draft = e.record.get("draft") === true;
      var __author = String(e.record.get("author") || "");
      var __memberBase = "workspace = {:w} && user = {:u} && status = 'active'";
      var __clients = e.app.subscriptionsBroker().clients();
      var __allow = Object.create(null); // prototype-less: a subscriber id must never inherit a verdict
      for (var __cid in __clients) {
        var __client = __clients[__cid];
        if (!__client.hasSubscription("rt:project_items:" + __ws)) continue;
        var __auth = __client.get("auth");
        var __uid = __auth ? String(__auth.id) : "";
        if (__allow[__uid] === undefined) {
          // KEEP IN SYNC: realtime.pb.js's delivery guard — same owner-or-member predicate, `user = {:u} && status = 'active'`,
          // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-484).
          var __ok =
            !!(__auth && __auth.isSuperuser()) ||
            (!!__uid && __uid === __owner);
          if (!__ok && __uid) {
            try {
              // The author leg rides this SAME lookup, so a suspended author is cut off
              // like everyone else (PBTT-462); the owner short-circuits above and has no row.
              e.app.findFirstRecordByFilter(
                "workspace_members",
                __draft && __uid !== __author
                  ? __memberBase + " && role = 'admin'"
                  : __memberBase,
                { w: __ws, u: __uid },
              );
              __ok = true;
            } catch (__e) {}
          }
          __allow[__uid] = __ok;
        }
        if (__allow[__uid]) __client.send(__msg);
      }
    } catch (__err) {
      e.app
        .logger()
        .error("rt:project_items broadcast failed", "err", String(__err));
    }
    return e.noContent(204);
  }
  // already trashed -> PURGE: re-check owner/admin authorization inline
  var workspace = e.app.findRecordById("workspaces", e.record.get("workspace"));
  var authorized = e.auth && e.auth.id === workspace.get("owner");
  if (!authorized && e.auth) {
    try {
      // KEEP IN SYNC: the purged collection's own deleteRule — only an ACTIVE membership
      // confers admin authority, so a suspended admin cannot purge (PBTT-431).
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && role = {:r} && status = {:s}",
        { w: workspace.id, u: e.auth.id, r: "admin", s: "active" },
      );
      authorized = true;
    } catch (_) {
      authorized = false;
    }
  }
  if (!authorized) {
    throw new BadRequestError(
      "cannot purge: only the workspace owner or an admin may permanently delete a trashed item",
    );
  }
  return e.next();
}, "decisions");

// ── milestones: delete-to-trash / second-delete-purges (item, direct workspace) ──
// KEEP IN SYNC with tasks/decisions/documents.
onRecordDeleteRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) {
    return e.next(); // HARD PURGE — superuser bypasses trash
  }
  var t = e.record.get("trashed");
  var isTrashed = String(t) !== "";
  if (!isTrashed) {
    // first DELETE -> trash (programmatic save bypasses request hooks)
    e.record.set("trashed", new Date().toISOString().replace("T", " "));
    e.record.set("trashed_by", e.auth ? e.auth.id : "");
    e.app.save(e.record);
    // KEEP IN SYNC: realtime.pb.js hides on the same `findRecordById("projects", __pid)` read — a row parked in a trashed
    // project was ALREADY hidden before this set, so hidden -> hidden is no transition and
    // owes no envelope; the live -> trashed hide still broadcasts, below.
    var __hiddenBefore = false;
    var __pid = e.record.get("project");
    if (__pid) {
      try {
        __hiddenBefore =
          String(
            e.app.findRecordById("projects", __pid).get("trashed") || "",
          ) !== "";
      } catch (__e) {
        __hiddenBefore = true; // an unreadable project can never satisfy project.trashed = ""
      }
    }
    if (__hiddenBefore) return e.noContent(204);
    // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
    // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
    var __wsRec = null;
    try {
      __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
    } catch (__e) {}
    if (!__wsRec || String(__wsRec.get("trashed") || "") !== "")
      return e.noContent(204);
    // the programmatic save above bypasses the request-hook broadcast tier, so the
    // trash-SET event is emitted inline — its `rawChangedFields` envelope + delivery guard KEEP IN SYNC with realtime.pb.js
    try {
      var __ws = e.record.get("workspace");
      var __env = {
        collection: "milestones",
        id: e.record.id,
        action: "update",
        actorId: e.auth ? e.auth.id : "",
        rawChangedFields: ["trashed", "trashed_by"],
        rawRecord: JSON.parse(JSON.stringify(e.record)),
      };
      var __msg = new SubscriptionMessage({
        name: "rt:project_items:" + __ws,
        data: JSON.stringify(__env),
      });
      var __owner = __wsRec.get("owner");
      // Draft privacy — KEEP IN SYNC: realtime.pb.js's `&& role = 'admin'` draft branch and this collection's
      // viewRule (an ACTIVE-member author OR the workspace owner OR an ACTIVE admin); an empty author
      // matches nobody, so a legacy/superuser-created draft stays owner+admin-only (PBTT-543).
      var __draft = e.record.get("draft") === true;
      var __author = String(e.record.get("author") || "");
      var __memberBase = "workspace = {:w} && user = {:u} && status = 'active'";
      var __clients = e.app.subscriptionsBroker().clients();
      var __allow = Object.create(null); // prototype-less: a subscriber id must never inherit a verdict
      for (var __cid in __clients) {
        var __client = __clients[__cid];
        if (!__client.hasSubscription("rt:project_items:" + __ws)) continue;
        var __auth = __client.get("auth");
        var __uid = __auth ? String(__auth.id) : "";
        if (__allow[__uid] === undefined) {
          // KEEP IN SYNC: realtime.pb.js's delivery guard — same owner-or-member predicate, `user = {:u} && status = 'active'`,
          // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-484).
          var __ok =
            !!(__auth && __auth.isSuperuser()) ||
            (!!__uid && __uid === __owner);
          if (!__ok && __uid) {
            try {
              // The author leg rides this SAME lookup, so a suspended author is cut off
              // like everyone else (PBTT-462); the owner short-circuits above and has no row.
              e.app.findFirstRecordByFilter(
                "workspace_members",
                __draft && __uid !== __author
                  ? __memberBase + " && role = 'admin'"
                  : __memberBase,
                { w: __ws, u: __uid },
              );
              __ok = true;
            } catch (__e) {}
          }
          __allow[__uid] = __ok;
        }
        if (__allow[__uid]) __client.send(__msg);
      }
    } catch (__err) {
      e.app
        .logger()
        .error("rt:project_items broadcast failed", "err", String(__err));
    }
    return e.noContent(204);
  }
  // already trashed -> PURGE: re-check owner/admin authorization inline
  var workspace = e.app.findRecordById("workspaces", e.record.get("workspace"));
  var authorized = e.auth && e.auth.id === workspace.get("owner");
  if (!authorized && e.auth) {
    try {
      // KEEP IN SYNC: the purged collection's own deleteRule — only an ACTIVE membership
      // confers admin authority, so a suspended admin cannot purge (PBTT-431).
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && role = {:r} && status = {:s}",
        { w: workspace.id, u: e.auth.id, r: "admin", s: "active" },
      );
      authorized = true;
    } catch (_) {
      authorized = false;
    }
  }
  if (!authorized) {
    throw new BadRequestError(
      "cannot purge: only the workspace owner or an admin may permanently delete a trashed item",
    );
  }
  return e.next();
}, "milestones");

// ── documents: delete-to-trash / second-delete-purges (item, direct workspace) ──
// KEEP IN SYNC with tasks/decisions/milestones.
onRecordDeleteRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) {
    return e.next(); // HARD PURGE — superuser bypasses trash
  }
  var t = e.record.get("trashed");
  var isTrashed = String(t) !== "";
  if (!isTrashed) {
    // first DELETE -> trash (programmatic save bypasses request hooks)
    e.record.set("trashed", new Date().toISOString().replace("T", " "));
    e.record.set("trashed_by", e.auth ? e.auth.id : "");
    e.app.save(e.record);
    // KEEP IN SYNC: realtime.pb.js hides on the same `findRecordById("projects", __pid)` read — a row parked in a trashed
    // project was ALREADY hidden before this set, so hidden -> hidden is no transition and
    // owes no envelope; the live -> trashed hide still broadcasts, below.
    var __hiddenBefore = false;
    var __pid = e.record.get("project");
    if (__pid) {
      try {
        __hiddenBefore =
          String(
            e.app.findRecordById("projects", __pid).get("trashed") || "",
          ) !== "";
      } catch (__e) {
        __hiddenBefore = true; // an unreadable project can never satisfy project.trashed = ""
      }
    }
    if (__hiddenBefore) return e.noContent(204);
    // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
    // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
    var __wsRec = null;
    try {
      __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
    } catch (__e) {}
    if (!__wsRec || String(__wsRec.get("trashed") || "") !== "")
      return e.noContent(204);
    // the programmatic save above bypasses the request-hook broadcast tier, so the
    // trash-SET event is emitted inline — its `rawChangedFields` envelope + delivery guard KEEP IN SYNC with realtime.pb.js
    try {
      var __ws = e.record.get("workspace");
      var __env = {
        collection: "documents",
        id: e.record.id,
        action: "update",
        actorId: e.auth ? e.auth.id : "",
        rawChangedFields: ["trashed", "trashed_by"],
        rawRecord: JSON.parse(JSON.stringify(e.record)),
      };
      var __msg = new SubscriptionMessage({
        name: "rt:project_items:" + __ws,
        data: JSON.stringify(__env),
      });
      var __owner = __wsRec.get("owner");
      // Draft privacy — KEEP IN SYNC: realtime.pb.js's `&& role = 'admin'` draft branch and this collection's
      // viewRule (an ACTIVE-member author OR the workspace owner OR an ACTIVE admin); an empty author
      // matches nobody, so a legacy/superuser-created draft stays owner+admin-only (PBTT-543).
      var __draft = e.record.get("draft") === true;
      var __author = String(e.record.get("author") || "");
      var __memberBase = "workspace = {:w} && user = {:u} && status = 'active'";
      var __clients = e.app.subscriptionsBroker().clients();
      var __allow = Object.create(null); // prototype-less: a subscriber id must never inherit a verdict
      for (var __cid in __clients) {
        var __client = __clients[__cid];
        if (!__client.hasSubscription("rt:project_items:" + __ws)) continue;
        var __auth = __client.get("auth");
        var __uid = __auth ? String(__auth.id) : "";
        if (__allow[__uid] === undefined) {
          // KEEP IN SYNC: realtime.pb.js's delivery guard — same owner-or-member predicate, `user = {:u} && status = 'active'`,
          // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-484).
          var __ok =
            !!(__auth && __auth.isSuperuser()) ||
            (!!__uid && __uid === __owner);
          if (!__ok && __uid) {
            try {
              // The author leg rides this SAME lookup, so a suspended author is cut off
              // like everyone else (PBTT-462); the owner short-circuits above and has no row.
              e.app.findFirstRecordByFilter(
                "workspace_members",
                __draft && __uid !== __author
                  ? __memberBase + " && role = 'admin'"
                  : __memberBase,
                { w: __ws, u: __uid },
              );
              __ok = true;
            } catch (__e) {}
          }
          __allow[__uid] = __ok;
        }
        if (__allow[__uid]) __client.send(__msg);
      }
    } catch (__err) {
      e.app
        .logger()
        .error("rt:project_items broadcast failed", "err", String(__err));
    }
    return e.noContent(204);
  }
  // already trashed -> PURGE: re-check owner/admin authorization inline
  var workspace = e.app.findRecordById("workspaces", e.record.get("workspace"));
  var authorized = e.auth && e.auth.id === workspace.get("owner");
  if (!authorized && e.auth) {
    try {
      // KEEP IN SYNC: the purged collection's own deleteRule — only an ACTIVE membership
      // confers admin authority, so a suspended admin cannot purge (PBTT-431).
      e.app.findFirstRecordByFilter(
        "workspace_members",
        "workspace = {:w} && user = {:u} && role = {:r} && status = {:s}",
        { w: workspace.id, u: e.auth.id, r: "admin", s: "active" },
      );
      authorized = true;
    } catch (_) {
      authorized = false;
    }
  }
  if (!authorized) {
    throw new BadRequestError(
      "cannot purge: only the workspace owner or an admin may permanently delete a trashed item",
    );
  }
  return e.next();
}, "documents");

// ── projects: delete-to-trash / second-delete-purges (rule already gates purge) ──
// KEEP IN SYNC (superuser + first-DELETE branches) with the item hooks above. The
// projects.deleteRule is owner/admin (W1, UNCHANGED by W3), which is EXACTLY the
// project purge actor set, so the already-trashed branch is a bare e.next() — no
// inline re-check needed.
onRecordDeleteRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) {
    return e.next(); // HARD PURGE — superuser bypasses trash
  }
  var t = e.record.get("trashed");
  var isTrashed = String(t) !== "";
  if (!isTrashed) {
    // first DELETE -> trash (programmatic save bypasses request hooks)
    e.record.set("trashed", new Date().toISOString().replace("T", " "));
    e.app.save(e.record);
    return e.noContent(204);
  }
  // already trashed -> PURGE: deleteRule already gated to owner/admin -> real delete
  return e.next();
}, "projects");

// ── workspaces: delete-to-trash / second-delete-purges (rule already gates purge) ──
// KEEP IN SYNC (superuser + first-DELETE branches) with the item hooks above. The
// workspaces.deleteRule is owner-only (W1, UNCHANGED by W3), which is EXACTLY the
// workspace purge actor set, so the already-trashed branch is a bare e.next().
onRecordDeleteRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) {
    return e.next(); // HARD PURGE — superuser bypasses trash
  }
  var t = e.record.get("trashed");
  var isTrashed = String(t) !== "";
  if (!isTrashed) {
    // first DELETE -> trash (programmatic save bypasses request hooks)
    e.record.set("trashed", new Date().toISOString().replace("T", " "));
    // This save is itself a writer of `trashed`, so the cleanup that follows a trash
    // (notification cascade + last-workspace reprovision) rides the record-level
    // workspaces-update hook below rather than being repeated here.
    e.app.save(e.record);
    return e.noContent(204);
  }
  // already trashed -> PURGE: deleteRule already gated to owner -> real delete
  return e.next();
}, "workspaces");

// ── workspaces: the trash cleanup, once, for every writer ────────────────────
// Record level, not request level: the DELETE arm above trashes with a programmatic save, and a
// cron, a custom route or a superuser write reaches the same state, so the trigger is the write
// itself rather than either request path.
//
// AFTER the write, not around it: this cleanup is not atomic with the trash (nothing here rolls a
// committed write back, and the construct that would — reassigning the event's app to a
// transaction handle — corrupts unrelated in-flight requests in the pooled JSVM), and running it
// on the write path holds that path for the whole cascade, which turns concurrent trashes into
// failures. Both measured. A cleanup that fails part-way therefore leaves the workspace trashed
// with some rows already dropped.
onRecordAfterUpdateSuccess((e) => {
  var wasTrashed = String(e.record.original().get("trashed")) !== "";
  var nowTrashed = String(e.record.get("trashed")) !== "";
  if (wasTrashed || !nowTrashed) return e.next();
  e.next();
  // Owner ruling 2026-09-07 (rdmq, prior art Linear): a notification about work in this
  // workspace is DROPPED for good rather than hidden, so restore brings none of them back.
  // The ownership-transfer notice carries only `workspace`, so the three item legs miss it.
  // Guarded: with no rollback available, a failed cleanup must not also refuse the trash.
  try {
    var doomed = e.app.findRecordsByFilter(
      "notifications",
      "task.workspace = {:w} || document.workspace = {:w2} || decision.workspace = {:w3} || workspace = {:w4}",
      "",
      0,
      0,
      { w: e.record.id, w2: e.record.id, w3: e.record.id, w4: e.record.id },
    );
    for (var di = 0; di < doomed.length; di++) e.app.delete(doomed[di]);
  } catch (notifErr) {
    e.app
      .logger()
      .error(
        "workspace trash notification cascade failed",
        "workspace",
        e.record.id,
        "err",
        String(notifErr),
      );
  }
  // W3 (#66, OQ-2 — foreman ruling 2026-07-27, design.md §1d "Last-workspace
  // APPROVED"): trashing your LAST live workspace must NOT dead-end you on an
  // empty, LIST-excluded app. D3's real-delete reprovision (main.pb.js) does NOT
  // fire on a trash, so reprovision HERE when the owner has no OTHER non-trashed
  // owned workspace. Non-duplicating: at purge time D3's after-delete hook finds
  // THIS provisioned workspace (owner-has-a-workspace guard) and skips.
  //
  // INLINED provision block — the THIRD byte-aligned copy of the pattern in
  // main.pb.js (users-create hook + last-workspace after-delete hook). The pooled
  // JSVM forbids a shared top-level helper; keep ALL THREE in sync by hand.
  //
  // Guarded, unlike the cascade above: the trash the owner asked for stands even when
  // the replacement workspace cannot be built.
  try {
    var ownerId = e.record.get("owner");
    try {
      // idempotent: skip if the owner still has ANOTHER live (non-trashed)
      // workspace (the just-trashed one is excluded via id != and trashed = '').
      e.app.findFirstRecordByFilter(
        "workspaces",
        "owner = {:o} && id != {:w} && trashed = ''",
        { o: ownerId, w: e.record.id },
      );
    } catch (_) {
      var wsCol = e.app.findCollectionByNameOrId("pbc_300100001"); // workspaces
      var projCol = e.app.findCollectionByNameOrId("pbc_484305853"); // projects
      var ws = new Record(wsCol);
      ws.set("name", "My Workspace");
      ws.set("owner", ownerId);
      // decision:default-priority-vocabulary: left EMPTY on purpose — the main.pb.js seeder fills the default vocab,
      // so the four values exist at exactly ONE site instead of four drifting copies.
      ws.set("priorities", []);
      e.app.save(ws);
      // G1 (#74) + decision:default-priority-vocabulary: default vocab (5 statuses + 3 core labels + priorities) is
      // seeded by the single onRecordAfterCreateSuccess("workspaces") seeder in main.pb.js —
      // which fires on THIS programmatic save too — so NO inline seeding here.
      var proj = new Record(projCol);
      proj.set("name", "My Project");
      proj.set("owner", ownerId);
      proj.set("workspace", ws.id);
      e.app.save(proj);
      ws.set("default_project", proj.id);
      e.app.save(ws);
      try {
        e.app.findFirstRecordByFilter("user_settings", "user = {:u}", {
          u: ownerId,
        });
      } catch (_) {
        var usCol = e.app.findCollectionByNameOrId("pbc_300100008"); // user_settings
        var us = new Record(usCol);
        us.set("user", ownerId);
        us.set("theme", "system");
        us.set("font", "system");
        e.app.save(us);
      }
    }
  } catch (err) {
    e.app
      .logger()
      .error(
        "last-workspace trash reprovision failed",
        "owner",
        e.record.get("owner"),
        "err",
        String(err),
      );
  }
}, "workspaces");

// ═══════════════════════════════════════════════════════════════════════════
// Create-side trash guard (PBTT-339) — `trashed`/`trashed_by` are set ONLY by the
// DELETE path above. Force-CLEAR them on every create so a low-priv member cannot
// create a born-trashed record (bypassing the delete-to-trash flow) or stamp a
// FOREIGN user as trashed_by. Clearing an already-empty value is a no-op, so a
// legitimate create that echoes `trashed:""` is unaffected — only a malicious value
// is neutralized. tasks/decisions/milestones/documents carry both fields; projects/
// workspaces have only `trashed`. Pooled JSVM forbids a shared helper — each guard is
// inlined; KEEP IN SYNC across the six (same shape, only the field set / collection
// name differ).
// ═══════════════════════════════════════════════════════════════════════════

// ── tasks: create-side trash guard — KEEP IN SYNC with decisions/milestones/documents ──
onRecordCreateRequest((e) => {
  e.record.set("trashed", "");
  e.record.set("trashed_by", "");
  return e.next();
}, "tasks");

// ── decisions: create-side trash guard — KEEP IN SYNC with tasks/milestones/documents ──
onRecordCreateRequest((e) => {
  e.record.set("trashed", "");
  e.record.set("trashed_by", "");
  return e.next();
}, "decisions");

// ── milestones: create-side trash guard — KEEP IN SYNC with tasks/decisions/documents ──
onRecordCreateRequest((e) => {
  e.record.set("trashed", "");
  e.record.set("trashed_by", "");
  return e.next();
}, "milestones");

// ── documents: create-side trash guard — KEEP IN SYNC with tasks/decisions/milestones ──
onRecordCreateRequest((e) => {
  e.record.set("trashed", "");
  e.record.set("trashed_by", "");
  return e.next();
}, "documents");

// ── projects: create-side trash guard (no trashed_by field) — KEEP IN SYNC with workspaces ──
onRecordCreateRequest((e) => {
  e.record.set("trashed", "");
  return e.next();
}, "projects");

// ── workspaces: create-side trash guard (no trashed_by field) — KEEP IN SYNC with projects ──
onRecordCreateRequest((e) => {
  e.record.set("trashed", "");
  return e.next();
}, "workspaces");

// ═══════════════════════════════════════════════════════════════════════════
// Restore-conflict guard — refuse untrash when the item's `project` relation
// points to a trashed OR non-existent project (lead ruling: the one conflict
// class). project == "" ⇒ no conflict. Fires ONLY on the trashed->live PATCH
// transition (wasTrashed && !nowTrashed); a normal edit has wasTrashed==nowTrashed
// and passes through untouched. Trash-SET rides onRecordDeleteRequest + a
// programmatic save (bypasses request hooks), so it never reaches here.
// e.record.original() captured BEFORE e.next() (proven notify.pb.js:30).
//
// The four hooks below are byte-identical apart from the collection name —
// KEEP IN SYNC. The reason string is byte-identical across all four (KEEP IN SYNC).
// ═══════════════════════════════════════════════════════════════════════════

// ── tasks: restore-conflict guard — KEEP IN SYNC with decisions/documents/milestones ──
onRecordUpdateRequest((e) => {
  var wasTrashed = String(e.record.original().get("trashed")) !== "";
  var nowTrashed = String(e.record.get("trashed")) !== "";
  if (!(wasTrashed && !nowTrashed)) return e.next();
  var projId = e.record.get("project");
  if (!projId) return e.next();
  var proj;
  try {
    proj = e.app.findRecordById("projects", projId);
  } catch (_) {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  if (String(proj.get("trashed")) !== "") {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  return e.next();
}, "tasks");

// ── decisions: restore-conflict guard — KEEP IN SYNC with tasks/documents/milestones ──
onRecordUpdateRequest((e) => {
  var wasTrashed = String(e.record.original().get("trashed")) !== "";
  var nowTrashed = String(e.record.get("trashed")) !== "";
  if (!(wasTrashed && !nowTrashed)) return e.next();
  var projId = e.record.get("project");
  if (!projId) return e.next();
  var proj;
  try {
    proj = e.app.findRecordById("projects", projId);
  } catch (_) {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  if (String(proj.get("trashed")) !== "") {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  return e.next();
}, "decisions");

// ── documents: restore-conflict guard — KEEP IN SYNC with tasks/decisions/milestones ──
onRecordUpdateRequest((e) => {
  var wasTrashed = String(e.record.original().get("trashed")) !== "";
  var nowTrashed = String(e.record.get("trashed")) !== "";
  if (!(wasTrashed && !nowTrashed)) return e.next();
  var projId = e.record.get("project");
  if (!projId) return e.next();
  var proj;
  try {
    proj = e.app.findRecordById("projects", projId);
  } catch (_) {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  if (String(proj.get("trashed")) !== "") {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  return e.next();
}, "documents");

// ── milestones: restore-conflict guard — KEEP IN SYNC with tasks/decisions/documents ──
onRecordUpdateRequest((e) => {
  var wasTrashed = String(e.record.original().get("trashed")) !== "";
  var nowTrashed = String(e.record.get("trashed")) !== "";
  if (!(wasTrashed && !nowTrashed)) return e.next();
  var projId = e.record.get("project");
  if (!projId) return e.next();
  var proj;
  try {
    proj = e.app.findRecordById("projects", projId);
  } catch (_) {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  if (String(proj.get("trashed")) !== "") {
    throw new BadRequestError(
      "cannot restore: the parent project is in the trash or no longer exists",
    );
  }
  return e.next();
}, "milestones");

// ═══════════════════════════════════════════════════════════════════════════
// M6 — expiry-purge cron + superuser-only manual-trigger route.
//
// The SWEEP body below is INLINED IDENTICALLY in TWO places: the cronAdd closure
// (uses $app — the JSVM cannot close over onBootstrap's `e`, alerts.pb.js:20-25)
// and the POST /api/tracker/trash/purge route handler (uses e.app). They MUST stay
// byte-identical apart from that app-handle name. KEEP THE TWO BLOCKS IN SYNC.
//
// Sweep logic:
//   1. Read app_settings.trash_retention_days. record.get("value") on a json field
//      returns JsonRaw as a byte array (NOT the number) — decode with the inline
//      byte-loop (idiom main.pb.js:32-40); parseInt. On ANY error/miss/NaN -> 30.
//   2. cutoff = now - retentionDays, as a PB datetime string "YYYY-MM-DD HH:MM:SS".
//   3. For each collection in [workspaces, projects, tasks, decisions, milestones,
//      documents] (parents first so their cascade shrinks later leaf queries), find
//      rows with trashed set AND older than cutoff and delete() each in a per-record
//      try/catch, tallying a purged count. app.delete is programmatic -> the trash
//      request hooks above do NOT fire (real delete).
// ═══════════════════════════════════════════════════════════════════════════

// KEEP IN SYNC: routes.pb.js GET /api/tracker/trash reads `trash_retention_days` this same way to date purge_at.
onBootstrap((e) => {
  e.next();

  var cronExpr = $os.getenv("TRASH_PURGE_CRON") || "0 4 * * *";

  cronAdd("trash-purge", cronExpr, () => {
    // ── INLINED SWEEP (cron copy, uses $app) — KEEP IN SYNC with the route copy ──
    try {
      var retentionDays = 30;
      try {
        var setRec = $app.findFirstRecordByFilter(
          "app_settings",
          "key = {:k}",
          { k: "trash_retention_days" },
        );
        var raw = setRec.get("value");
        var parsed = NaN;
        if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
          var text = "";
          for (var i = 0; i < raw.length; i++)
            text += String.fromCharCode(raw[i]);
          parsed = parseInt(text, 10);
        } else {
          parsed = parseInt(String(raw), 10);
        }
        if (!isNaN(parsed)) retentionDays = parsed;
      } catch (_) {
        retentionDays = 30;
      }
      if (isNaN(retentionDays)) retentionDays = 30;

      var cutoff = new Date(Date.now() - retentionDays * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);

      var cols = [
        "workspaces",
        "projects",
        "tasks",
        "decisions",
        "milestones",
        "documents",
      ];
      var purged = 0;
      for (var c = 0; c < cols.length; c++) {
        try {
          var recs = $app.findRecordsByFilter(
            cols[c],
            "trashed != '' && trashed < {:cutoff}",
            "",
            0,
            0,
            { cutoff: cutoff },
          );
          for (var r = 0; r < recs.length; r++) {
            try {
              $app.delete(recs[r]);
              purged++;
            } catch (_) {
              /* per-record: skip a row that won't delete */
            }
          }
        } catch (_) {
          /* per-collection: skip on query error */
        }
      }
      // A purge cascade scans for children once, so a row that commits between that scan and the
      // commit outlives its own project. Swept here rather than on the delete itself: doing it
      // inline costs concurrent creates 400s and 500s while a project is being purged (measured).
      var orphaned = 0;
      var kids = ["tasks", "decisions", "milestones", "documents"];
      for (var k = 0; k < kids.length; k++) {
        try {
          var kidRows = $app.findRecordsByFilter(
            kids[k],
            "project != ''",
            "",
            0,
            0,
            {},
          );
          for (var kr = 0; kr < kidRows.length; kr++) {
            try {
              $app.findRecordById("projects", kidRows[kr].get("project"));
            } catch (_) {
              try {
                $app.delete(kidRows[kr]);
                orphaned++;
              } catch (_) {
                /* per-record: skip a row that won't delete */
              }
            }
          }
        } catch (_) {
          /* per-collection: skip on query error */
        }
      }
      $app
        .logger()
        .info("trash-purge swept orphaned items", "orphaned", orphaned);
      $app
        .logger()
        .info(
          "trash-purge cron swept",
          "purged",
          purged,
          "retentionDays",
          retentionDays,
        );
    } catch (err) {
      $app.logger().error("trash-purge cron failed", "error", String(err));
    }
    // ── END INLINED SWEEP (cron copy) ──
  });

  e.app.logger().info("trash-purge cron registered", "cron", cronExpr);
});

// ── Manual trigger: POST /api/tracker/trash/purge (superuser only) ────────────
// A daily cron cannot be waited on in the battery, so this route runs the SAME
// inlined sweep on demand and returns {purged: <count>}. Mirrors the alerts.pb.js
// self-test-route philosophy. requireSuperuserAuth gates it to a superuser token.
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/trash/purge",
  (e) => {
    // ── INLINED SWEEP (route copy, uses e.app) — KEEP IN SYNC with the cron copy ──
    var retentionDays = 30;
    try {
      var setRec = e.app.findFirstRecordByFilter("app_settings", "key = {:k}", {
        k: "trash_retention_days",
      });
      var raw = setRec.get("value");
      var parsed = NaN;
      if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
        var text = "";
        for (var i = 0; i < raw.length; i++)
          text += String.fromCharCode(raw[i]);
        parsed = parseInt(text, 10);
      } else {
        parsed = parseInt(String(raw), 10);
      }
      if (!isNaN(parsed)) retentionDays = parsed;
    } catch (_) {
      retentionDays = 30;
    }
    if (isNaN(retentionDays)) retentionDays = 30;

    var cutoff = new Date(Date.now() - retentionDays * 86400000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    var cols = [
      "workspaces",
      "projects",
      "tasks",
      "decisions",
      "milestones",
      "documents",
    ];
    var purged = 0;
    for (var c = 0; c < cols.length; c++) {
      try {
        var recs = e.app.findRecordsByFilter(
          cols[c],
          "trashed != '' && trashed < {:cutoff}",
          "",
          0,
          0,
          { cutoff: cutoff },
        );
        for (var r = 0; r < recs.length; r++) {
          try {
            e.app.delete(recs[r]);
            purged++;
          } catch (_) {
            /* per-record: skip a row that won't delete */
          }
        }
      } catch (_) {
        /* per-collection: skip on query error */
      }
    }
    // A purge cascade scans for children once, so a row that commits between that scan and the
    // commit outlives its own project. Swept here rather than on the delete itself: doing it
    // inline costs concurrent creates 400s and 500s while a project is being purged (measured).
    var orphaned = 0;
    var kids = ["tasks", "decisions", "milestones", "documents"];
    for (var k = 0; k < kids.length; k++) {
      try {
        var kidRows = e.app.findRecordsByFilter(
          kids[k],
          "project != ''",
          "",
          0,
          0,
          {},
        );
        for (var kr = 0; kr < kidRows.length; kr++) {
          try {
            e.app.findRecordById("projects", kidRows[kr].get("project"));
          } catch (_) {
            try {
              e.app.delete(kidRows[kr]);
              orphaned++;
            } catch (_) {
              /* per-record: skip a row that won't delete */
            }
          }
        }
      } catch (_) {
        /* per-collection: skip on query error */
      }
    }
    e.app
      .logger()
      .info("trash-purge swept orphaned items", "orphaned", orphaned);
    // ── END INLINED SWEEP (route copy) ──
    return e.json(200, { purged: purged });
  },
);

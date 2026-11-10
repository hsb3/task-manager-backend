/// <reference path="../pb_data/types.d.ts" />
// rt:project_items:{workspaceId} — emit-only: broadcast a raw envelope to a workspace's
// subscribers on every create/update/purge of tasks/decisions/documents/milestones.
// Per-workspace topic + a subscribe-authorization guard keep one tenant's rows off every
// other tenant's channel. Never alters a write. Membership is re-checked at DELIVERY, not just
// at subscribe, so revoking a membership cuts the live feed immediately (PBTT-462).
// A DRAFT decision/document/milestone is delivered only to the roles its viewRule admits, so
// every field of rawRecord is REST-readable by every recipient — no payload scoping (PBTT-543).
// ponytail: one membership query per distinct subscriber per event — memoize across events if hot.

// Pooled JSVM forbids a shared top-level helper (ReferenceError at request time —
// trash.pb.js:10-16), so the hooks below INLINE their logic; only the collection tag, the
// envelope's collection literal and the draft branch (absent on tasks) differ.
// KEEP IN SYNC across all four groups — except the tasks UPDATE broadcast, which sits at the
// universal tier because tasks are the one collection saved programmatically off the trash path.

// ── subscribe guard: a client may only subscribe to rt:project_items:{ws} for a workspace
// it belongs to. Custom topics are NOT rule-checked by PB, so without this any authed user
// could name another workspace's topic and receive its rows. Superuser exempt; unauthorized
// item topics are silently dropped (other topics pass through untouched).
onRealtimeSubscribeRequest((e) => {
  const PREFIX = "rt:project_items:";
  const kept = [];
  const isSuper = !!(e.auth && e.auth.isSuperuser());
  const uid = e.auth && !isSuper ? e.auth.id : "";
  for (let i = 0; i < e.subscriptions.length; i++) {
    const sub = e.subscriptions[i];
    const topic = String(sub).split("?")[0]; // strip PB's optional ?options= suffix
    if (topic.indexOf(PREFIX) !== 0) {
      kept.push(sub);
      continue;
    } // not ours — leave intact
    const wsId = topic.slice(PREFIX.length);
    // KEEP IN SYNC: the broadcast arms' workspace guard — a workspace whose rows every read
    // surface 404s has no live feed to join, so the topic is dropped for every tier.
    let wsRec = null;
    try {
      wsRec = e.app.findRecordById("workspaces", wsId);
    } catch (_) {}
    if (!wsRec || String(wsRec.get("trashed") || "") !== "") continue;
    let ok = isSuper;
    if (!ok && uid && wsId) {
      if (wsRec.get("owner") === uid) ok = true;
      if (!ok) {
        try {
          // KEEP IN SYNC: tasks.listRule — only an ACTIVE membership may receive a
          // workspace's rows, so a suspended member's subscription is dropped (PBTT-431).
          e.app.findFirstRecordByFilter(
            "workspace_members",
            "workspace = {:w} && user = {:u} && status = 'active'",
            { w: wsId, u: uid },
          );
          ok = true;
        } catch (_) {}
      }
    }
    if (ok) kept.push(sub); // authorized -> keep; unauthorized -> drop
  }
  e.subscriptions = kept;
  e.next();
});

// ── tasks: create ── KEEP IN SYNC with decisions/documents/milestones create ──
// tasks carry no draft concept at all, so every task is readable by every member
// and its broadcast stays unrestricted (base-rules contract).
onRecordCreateRequest((e) => {
  // actor MUST be captured before e.next() — e.auth is UNDEFINED in After*Success hooks.
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  e.next();
  // KEEP IN SYNC: the tasks UPDATE arm's hiddenState — a row created ALREADY hidden (trashed,
  // or parked in a trashed project) is 404 on every recipient's read surfaces, and on a create
  // the state it was born in IS both sides of the save, so no envelope goes out.
  var __hidden = String(e.record.get("trashed") || "") !== "";
  var __pid = e.record.get("project");
  if (!__hidden && __pid) {
    try {
      __hidden =
        String(e.app.findRecordById("projects", __pid).get("trashed") || "") !==
        "";
    } catch (__e) {
      __hidden = true; // an unreadable project can never satisfy project.trashed = ""
    }
  }
  if (__hidden) return;
  // workspace is backfilled by scope.pb.js during e.next() — read it after.
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "tasks",
      id: e.record.id,
      action: "create",
      actorId: actor,
      rawChangedFields: Object.keys(rawRecord),
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    var __clients = e.app.subscriptionsBroker().clients();
    var __allow = Object.create(null); // prototype-less: a subscriber id must never inherit a verdict
    for (var __cid in __clients) {
      var __client = __clients[__cid];
      if (!__client.hasSubscription("rt:project_items:" + __ws)) continue;
      var __auth = __client.get("auth");
      var __uid = __auth ? String(__auth.id) : "";
      if (__allow[__uid] === undefined) {
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
}, "tasks");

// ── tasks: update actor stamp ──
// The universal broadcast below has no e.auth of its own, so the request actor rides on the
// record: a non-empty stamp means the save came through the API, "-" that it carries no
// attributable user (superuser or anon). Custom keys never serialize, so this reaches no
// response body, no stored row and no rawRecord payload.
// KEEP IN SYNC (below): activity.pb.js stamps the same "_actor" key under the same convention.
onRecordUpdateRequest((e) => {
  e.record.set("_actor", e.auth && !e.auth.isSuperuser() ? e.auth.id : "-");
  e.next();
}, "tasks");

// ── tasks: update ── the UNIVERSAL tier, unlike the decisions/documents/milestones update
// hooks below: a cycle rollover (cycles.pb.js) and the leaver-unassign sweep (main.pb.js)
// save a task through a programmatic e.app.save(), which fires no *Request hook.
// tasks carry no draft concept at all, so every task is readable by every member
// and its broadcast stays unrestricted (base-rules contract).
onRecordUpdate((e) => {
  const stamped = String(e.record.get("_actor") || "");
  const actor = stamped === "-" ? "" : stamped;
  const orig = e.record.original();
  const changed = [];
  const snap = JSON.parse(JSON.stringify(e.record));
  const keys = Object.keys(snap);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (
      k === "id" ||
      k === "collectionId" ||
      k === "collectionName" ||
      k === "created" ||
      k === "updated"
    )
      continue;
    // JSON.stringify normalizes relation shapes (activity.pb.js:37-38).
    if (JSON.stringify(orig.get(k)) !== JSON.stringify(e.record.get(k)))
      changed.push(k);
  }
  e.next();
  // trash.pb.js emits this envelope itself from its DELETE interception, so re-emitting the
  // programmatic trash-set here would deliver the same event twice.
  let softTrashOnly = changed.length > 0;
  for (let t = 0; t < changed.length; t++) {
    if (changed[t] !== "trashed" && changed[t] !== "trashed_by")
      softTrashOnly = false;
  }
  if (
    stamped === "" &&
    softTrashOnly &&
    String(orig.get("trashed") || "") === "" &&
    String(e.record.get("trashed") || "") !== ""
  ) {
    return;
  }
  // KEEP IN SYNC: tasks.viewRule's state clause, `trashed = "" && (project = "" ||
  // project.trashed = "")`. The envelope carries the whole record, so a row hidden on BOTH
  // sides of the save must not go out — every recipient 404s it over HTTP, and a programmatic
  // save (rollover, leaver-unassign) reaches rows an API caller could never have touched.
  // A TRANSITION still broadcasts, either way: the client has to learn the row left its list,
  // or rejoined it.
  // ponytail: one project read per update of a projected task — memoize if it ever gets hot.
  const hiddenState = function (trashed, projectId) {
    if (String(trashed || "") !== "") return true;
    if (!projectId) return false;
    try {
      return (
        String(
          e.app.findRecordById("projects", projectId).get("trashed") || "",
        ) !== ""
      );
    } catch (_) {
      return true; // an unreadable project can never satisfy project.trashed = ""
    }
  };
  if (
    hiddenState(e.record.get("trashed"), e.record.get("project")) &&
    hiddenState(orig.get("trashed"), orig.get("project"))
  ) {
    return;
  }
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "tasks",
      id: e.record.id,
      action: "update",
      actorId: actor,
      rawChangedFields: changed,
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    var __clients = e.app.subscriptionsBroker().clients();
    var __allow = Object.create(null); // prototype-less: a subscriber id must never inherit a verdict
    for (var __cid in __clients) {
      var __client = __clients[__cid];
      if (!__client.hasSubscription("rt:project_items:" + __ws)) continue;
      var __auth = __client.get("auth");
      var __uid = __auth ? String(__auth.id) : "";
      if (__allow[__uid] === undefined) {
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
}, "tasks");

// ── tasks: delete ── KEEP IN SYNC with decisions/documents/milestones delete ──
// tasks carry no draft concept at all, so every task is readable by every member
// and its broadcast stays unrestricted (base-rules contract).
// AfterDeleteSuccess (NOT DeleteRequest): fires for BOTH HTTP purges AND programmatic
// $app.delete (the trash-purge cron + /api/tracker/trash/purge route — trash.pb.js) and
// only ever on a real delete, so no soft-trash false positive. actor is unresolvable here
// (e.auth undefined in After*Success) -> "" (cron/route purges are systemic / superuser).
onRecordAfterDeleteSuccess((e) => {
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return e.next();
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "tasks",
      id: e.record.id,
      action: "delete",
      actorId: "",
      rawChangedFields: [],
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    var __clients = e.app.subscriptionsBroker().clients();
    var __allow = Object.create(null); // prototype-less: a subscriber id must never inherit a verdict
    for (var __cid in __clients) {
      var __client = __clients[__cid];
      if (!__client.hasSubscription("rt:project_items:" + __ws)) continue;
      var __auth = __client.get("auth");
      var __uid = __auth ? String(__auth.id) : "";
      if (__allow[__uid] === undefined) {
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
  e.next();
}, "tasks");

// ── decisions: create ── KEEP IN SYNC with tasks/documents/milestones create ──
onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  e.next();
  // KEEP IN SYNC: the tasks UPDATE arm's hiddenState — a row created ALREADY hidden (trashed,
  // or parked in a trashed project) is 404 on every recipient's read surfaces, and on a create
  // the state it was born in IS both sides of the save, so no envelope goes out.
  var __hidden = String(e.record.get("trashed") || "") !== "";
  var __pid = e.record.get("project");
  if (!__hidden && __pid) {
    try {
      __hidden =
        String(e.app.findRecordById("projects", __pid).get("trashed") || "") !==
        "";
    } catch (__e) {
      __hidden = true; // an unreadable project can never satisfy project.trashed = ""
    }
  }
  if (__hidden) return;
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "decisions",
      id: e.record.id,
      action: "create",
      actorId: actor,
      rawChangedFields: Object.keys(rawRecord),
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
}, "decisions");

// ── decisions: update ── KEEP IN SYNC with tasks/documents/milestones update ──
onRecordUpdateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  const orig = e.record.original();
  const changed = [];
  const snap = JSON.parse(JSON.stringify(e.record));
  const keys = Object.keys(snap);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (
      k === "id" ||
      k === "collectionId" ||
      k === "collectionName" ||
      k === "created" ||
      k === "updated"
    )
      continue;
    if (JSON.stringify(orig.get(k)) !== JSON.stringify(e.record.get(k)))
      changed.push(k);
  }
  e.next();
  // KEEP IN SYNC: the tasks UPDATE arm's hiddenState — the envelope carries the whole record, so
  // a row hidden on BOTH sides of the save must not go out; a TRANSITION still has to broadcast.
  const hiddenState = function (trashed, projectId) {
    if (String(trashed || "") !== "") return true;
    if (!projectId) return false;
    try {
      return (
        String(
          e.app.findRecordById("projects", projectId).get("trashed") || "",
        ) !== ""
      );
    } catch (_) {
      return true; // an unreadable project can never satisfy project.trashed = ""
    }
  };
  if (
    hiddenState(e.record.get("trashed"), e.record.get("project")) &&
    hiddenState(orig.get("trashed"), orig.get("project"))
  ) {
    return;
  }
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "decisions",
      id: e.record.id,
      action: "update",
      actorId: actor,
      rawChangedFields: changed,
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
        if (!__ok && __uid) {
          try {
            // The author leg rides this SAME lookup, so a suspended author is cut off
            // like everyone else (PBTT-462); the owner short-circuits above and has no row.
            // KEEP IN SYNC (below): trash.pb.js's inlined soft-trash envelope carries the same `&& role = 'admin'` draft branch.
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
}, "decisions");

// ── decisions: delete ── KEEP IN SYNC with tasks/documents/milestones delete ──
onRecordAfterDeleteSuccess((e) => {
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return e.next();
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "decisions",
      id: e.record.id,
      action: "delete",
      actorId: "",
      rawChangedFields: [],
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
  e.next();
}, "decisions");

// ── documents: create ── KEEP IN SYNC with tasks/decisions/milestones create ──
onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  e.next();
  // KEEP IN SYNC: the tasks UPDATE arm's hiddenState — a row created ALREADY hidden (trashed,
  // or parked in a trashed project) is 404 on every recipient's read surfaces, and on a create
  // the state it was born in IS both sides of the save, so no envelope goes out.
  var __hidden = String(e.record.get("trashed") || "") !== "";
  var __pid = e.record.get("project");
  if (!__hidden && __pid) {
    try {
      __hidden =
        String(e.app.findRecordById("projects", __pid).get("trashed") || "") !==
        "";
    } catch (__e) {
      __hidden = true; // an unreadable project can never satisfy project.trashed = ""
    }
  }
  if (__hidden) return;
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "documents",
      id: e.record.id,
      action: "create",
      actorId: actor,
      rawChangedFields: Object.keys(rawRecord),
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
}, "documents");

// ── documents: update ── KEEP IN SYNC with tasks/decisions/milestones update ──
onRecordUpdateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  const orig = e.record.original();
  const changed = [];
  const snap = JSON.parse(JSON.stringify(e.record));
  const keys = Object.keys(snap);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (
      k === "id" ||
      k === "collectionId" ||
      k === "collectionName" ||
      k === "created" ||
      k === "updated"
    )
      continue;
    if (JSON.stringify(orig.get(k)) !== JSON.stringify(e.record.get(k)))
      changed.push(k);
  }
  e.next();
  // KEEP IN SYNC: the tasks UPDATE arm's hiddenState — the envelope carries the whole record, so
  // a row hidden on BOTH sides of the save must not go out; a TRANSITION still has to broadcast.
  const hiddenState = function (trashed, projectId) {
    if (String(trashed || "") !== "") return true;
    if (!projectId) return false;
    try {
      return (
        String(
          e.app.findRecordById("projects", projectId).get("trashed") || "",
        ) !== ""
      );
    } catch (_) {
      return true; // an unreadable project can never satisfy project.trashed = ""
    }
  };
  if (
    hiddenState(e.record.get("trashed"), e.record.get("project")) &&
    hiddenState(orig.get("trashed"), orig.get("project"))
  ) {
    return;
  }
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "documents",
      id: e.record.id,
      action: "update",
      actorId: actor,
      rawChangedFields: changed,
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
}, "documents");

// ── documents: delete ── KEEP IN SYNC with tasks/decisions/milestones delete ──
onRecordAfterDeleteSuccess((e) => {
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return e.next();
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "documents",
      id: e.record.id,
      action: "delete",
      actorId: "",
      rawChangedFields: [],
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
  e.next();
}, "documents");

// ── milestones: create ── KEEP IN SYNC with tasks/decisions/documents create ──
onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  e.next();
  // KEEP IN SYNC: the tasks UPDATE arm's hiddenState — a row created ALREADY hidden (trashed,
  // or parked in a trashed project) is 404 on every recipient's read surfaces, and on a create
  // the state it was born in IS both sides of the save, so no envelope goes out.
  var __hidden = String(e.record.get("trashed") || "") !== "";
  var __pid = e.record.get("project");
  if (!__hidden && __pid) {
    try {
      __hidden =
        String(e.app.findRecordById("projects", __pid).get("trashed") || "") !==
        "";
    } catch (__e) {
      __hidden = true; // an unreadable project can never satisfy project.trashed = ""
    }
  }
  if (__hidden) return;
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "milestones",
      id: e.record.id,
      action: "create",
      actorId: actor,
      rawChangedFields: Object.keys(rawRecord),
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
}, "milestones");

// ── milestones: update ── KEEP IN SYNC with tasks/decisions/documents update ──
onRecordUpdateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  const orig = e.record.original();
  const changed = [];
  const snap = JSON.parse(JSON.stringify(e.record));
  const keys = Object.keys(snap);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (
      k === "id" ||
      k === "collectionId" ||
      k === "collectionName" ||
      k === "created" ||
      k === "updated"
    )
      continue;
    if (JSON.stringify(orig.get(k)) !== JSON.stringify(e.record.get(k)))
      changed.push(k);
  }
  e.next();
  // KEEP IN SYNC: the tasks UPDATE arm's hiddenState — the envelope carries the whole record, so
  // a row hidden on BOTH sides of the save must not go out; a TRANSITION still has to broadcast.
  const hiddenState = function (trashed, projectId) {
    if (String(trashed || "") !== "") return true;
    if (!projectId) return false;
    try {
      return (
        String(
          e.app.findRecordById("projects", projectId).get("trashed") || "",
        ) !== ""
      );
    } catch (_) {
      return true; // an unreadable project can never satisfy project.trashed = ""
    }
  };
  if (
    hiddenState(e.record.get("trashed"), e.record.get("project")) &&
    hiddenState(orig.get("trashed"), orig.get("project"))
  ) {
    return;
  }
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return;
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "milestones",
      id: e.record.id,
      action: "update",
      actorId: actor,
      rawChangedFields: changed,
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
}, "milestones");

// ── milestones: delete ── KEEP IN SYNC with tasks/decisions/documents delete ──
onRecordAfterDeleteSuccess((e) => {
  // KEEP IN SYNC: every item collection's `workspace.trashed = ""` read clause — a row under a
  // trashed workspace 404s everywhere, and a workspace gone in a purge cascade is the same state.
  var __wsRec = null;
  try {
    __wsRec = e.app.findRecordById("workspaces", e.record.get("workspace"));
  } catch (__e) {}
  if (!__wsRec || String(__wsRec.get("trashed") || "") !== "") return e.next();
  const rawRecord = JSON.parse(JSON.stringify(e.record));
  try {
    var __ws = e.record.get("workspace");
    var __env = {
      collection: "milestones",
      id: e.record.id,
      action: "delete",
      actorId: "",
      rawChangedFields: [],
      rawRecord: rawRecord,
    };
    var __msg = new SubscriptionMessage({
      name: "rt:project_items:" + __ws,
      data: JSON.stringify(__env),
    });
    var __owner = __wsRec.get("owner");
    // Draft privacy — KEEP IN SYNC: this collection's viewRule draft branch (the ACTIVE-member
    // author OR the workspace owner OR an ACTIVE admin); an empty author matches nobody, so a
    // legacy/superuser-created draft stays owner+admin-only (PBTT-543).
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
        // KEEP IN SYNC: the subscribe guard above — same owner-or-ACTIVE-member predicate,
        // re-checked at DELIVERY so a revoked membership stops the stream now (PBTT-462).
        var __ok =
          !!(__auth && __auth.isSuperuser()) || (!!__uid && __uid === __owner);
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
  e.next();
}, "milestones");

/// <reference path="../pb_data/types.d.ts" />
// G2 (#74) collaboration: auto-subscribe + notification fan-out + comment integrity.

// e.auth is UNDEFINED in onRecordAfter*Success (proven), so ALL actor-dependent work
// runs in onRecord*Request via the e.next() bridge: capture the actor + original()
// values BEFORE e.next(), persist with e.next() (record id exists after; a failed save
// throws → phantom-safe), then write. The tasks fan-out replay guard = compare the new
// value to the pre-e.next() original() value, so a no-op PATCH fans out nothing.
// NOTIFICATION_KINDS = assigned|commented|status_done|mentioned|ownership_transferred — the closed
// select vocabulary; every value but the last fans out below, and ownership_transferred is emitted
// by the workspace transfer-ownership route in routes.pb.js.
// Pooled JSVM: no top-level helper may be CALLED from inside a callback (ReferenceError),
// so the subscribe-upsert and fan-out blocks are INLINED per site behind KEEP IN SYNC
// markers and must be kept byte-identical by hand.

// (1) tasks create — auto-subscribe creator + assignee (no fan-out on create).
onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  e.next();
  const taskId = e.record.id;
  const assignee = e.record.get("assignee");
  // KEEP IN SYNC (subscribe-upsert): idempotent find-first-or-create, backed by the (task,user) unique index
  {
    const uid = actor;
    if (uid) {
      try {
        e.app.findFirstRecordByFilter(
          "task_subscribers",
          "task = {:t} && user = {:u}",
          { t: taskId, u: uid },
        );
      } catch (_) {
        const c = e.app.findCollectionByNameOrId("task_subscribers");
        const r = new Record(c);
        r.set("task", taskId);
        r.set("user", uid);
        // The record this subscribe hangs off is already committed, so a failed row is dropped
        // and named in the log — never thrown, which would lose the fan-out that follows it.
        try {
          e.app.save(r);
        } catch (saveErr) {
          e.app
            .logger()
            .error(
              "auto-subscribe save failed",
              "task",
              taskId,
              "user",
              uid,
              "error",
              String(saveErr),
            );
        }
      }
    }
  }
  // KEEP IN SYNC (subscribe-upsert): idempotent find-first-or-create, backed by the (task,user) unique index
  {
    const uid = assignee !== actor ? assignee : "";
    if (uid) {
      try {
        e.app.findFirstRecordByFilter(
          "task_subscribers",
          "task = {:t} && user = {:u}",
          { t: taskId, u: uid },
        );
      } catch (_) {
        const c = e.app.findCollectionByNameOrId("task_subscribers");
        const r = new Record(c);
        r.set("task", taskId);
        r.set("user", uid);
        // The record this subscribe hangs off is already committed, so a failed row is dropped
        // and named in the log — never thrown, which would lose the fan-out that follows it.
        try {
          e.app.save(r);
        } catch (saveErr) {
          e.app
            .logger()
            .error(
              "auto-subscribe save failed",
              "task",
              taskId,
              "user",
              uid,
              "error",
              String(saveErr),
            );
        }
      }
    }
  }
}, "tasks");

// (2) tasks update — assign fan-out + status_done fan-out (replay-guarded).
onRecordUpdateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  const origAssignee = e.record.original().get("assignee");
  const origStatus = e.record.original().get("status");
  // Whoever ALREADY held a prose-mention row for this task before the write, so the rows the
  // mention hook nested inside this e.next() adds are exactly the difference.
  const _mentionedBefore = [];
  try {
    const _pre = e.app.findRecordsByFilter(
      "notifications",
      "task = {:t} && kind = 'mentioned' && comment = ''",
      "",
      0,
      0,
      { t: e.record.id },
    );
    for (let i = 0; i < _pre.length; i++)
      _mentionedBefore.push(_pre[i].get("user"));
  } catch (_) {}
  e.next();
  const taskId = e.record.id;
  const _ws = e.record.get("workspace");
  // A member this same write named in the description is told once, by the mention.
  const _mentionedNow = [];
  try {
    const _post = e.app.findRecordsByFilter(
      "notifications",
      "task = {:t} && kind = 'mentioned' && comment = ''",
      "",
      0,
      0,
      { t: taskId },
    );
    for (let i = 0; i < _post.length; i++) {
      const _u = _post[i].get("user");
      if (_mentionedBefore.indexOf(_u) === -1) _mentionedNow.push(_u);
    }
  } catch (_) {}
  const newAssignee = e.record.get("assignee");
  if (newAssignee && newAssignee !== origAssignee) {
    // KEEP IN SYNC (subscribe-upsert): idempotent find-first-or-create, backed by the (task,user) unique index
    {
      const uid = newAssignee;
      if (uid) {
        try {
          e.app.findFirstRecordByFilter(
            "task_subscribers",
            "task = {:t} && user = {:u}",
            { t: taskId, u: uid },
          );
        } catch (_) {
          const c = e.app.findCollectionByNameOrId("task_subscribers");
          const r = new Record(c);
          r.set("task", taskId);
          r.set("user", uid);
          // The record this subscribe hangs off is already committed, so a failed row is dropped
          // and named in the log — never thrown, which would lose the fan-out that follows it.
          try {
            e.app.save(r);
          } catch (saveErr) {
            e.app
              .logger()
              .error(
                "auto-subscribe save failed",
                "task",
                taskId,
                "user",
                uid,
                "error",
                String(saveErr),
              );
          }
        }
      }
    }
    const _skip = _mentionedNow;
    // KEEP IN SYNC (fan-out): notify every subscriber EXCEPT the actor and anyone in _skip; kind is the trigger's kind
    {
      const _subs = e.app.findRecordsByFilter(
        "task_subscribers",
        "task = {:t}",
        "",
        0,
        0,
        { t: taskId },
      );
      const _ncol = e.app.findCollectionByNameOrId("notifications");
      for (let i = 0; i < _subs.length; i++) {
        const uid = _subs[i].get("user");
        if (uid === actor || _skip.indexOf(uid) !== -1) continue;
        const n = new Record(_ncol);
        n.set("user", uid);
        n.set("task", taskId);
        n.set("workspace", _ws);
        n.set("kind", "assigned");
        n.set("read", false);
        // The record this fan-out is about is already committed, so a failed row is dropped
        // and named in the log — never thrown, which would lose every recipient after it.
        try {
          e.app.save(n);
        } catch (saveErr) {
          e.app
            .logger()
            .error(
              "notification fan-out save failed",
              "kind",
              n.get("kind"),
              "user",
              uid,
              "error",
              String(saveErr),
            );
        }
      }
    }
  }
  const newStatus = e.record.get("status");
  let origCat = "";
  let newCat = "";
  let newStatusName = "";
  if (origStatus) {
    try {
      origCat = e.app.findRecordById("statuses", origStatus).get("category");
    } catch (_) {}
  }
  if (newStatus) {
    try {
      const _st = e.app.findRecordById("statuses", newStatus);
      newCat = _st.get("category");
      newStatusName = _st.get("name");
    } catch (_) {}
  }
  if (origCat !== "completed" && newCat === "completed") {
    const _skip = _mentionedNow;
    // KEEP IN SYNC (fan-out): notify every subscriber EXCEPT the actor and anyone in _skip; kind is the trigger's kind
    {
      const _subs = e.app.findRecordsByFilter(
        "task_subscribers",
        "task = {:t}",
        "",
        0,
        0,
        { t: taskId },
      );
      const _ncol = e.app.findCollectionByNameOrId("notifications");
      for (let i = 0; i < _subs.length; i++) {
        const uid = _subs[i].get("user");
        if (uid === actor || _skip.indexOf(uid) !== -1) continue;
        const n = new Record(_ncol);
        n.set("user", uid);
        n.set("task", taskId);
        n.set("workspace", _ws);
        n.set("kind", "status_done");
        n.set("read", false);
        n.set("status_label", newStatusName);
        // The record this fan-out is about is already committed, so a failed row is dropped
        // and named in the log — never thrown, which would lose every recipient after it.
        try {
          e.app.save(n);
        } catch (saveErr) {
          e.app
            .logger()
            .error(
              "notification fan-out save failed",
              "kind",
              n.get("kind"),
              "user",
              uid,
              "error",
              String(saveErr),
            );
        }
      }
    }
  }
}, "tasks");

// (3) comments create — subscribe commenter + fan-out "commented" + @mention fan-out
// (task-target only).
onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  e.next();
  const taskId = e.record.get("task");
  if (taskId) {
    const preview = String(e.record.get("body") || "").slice(0, 140);
    // A comment has no workspace of its own; its notifications carry the task one.
    let _ws = "";
    try {
      _ws = e.app.findRecordById("tasks", taskId).get("workspace");
    } catch (_) {}
    // KEEP IN SYNC (subscribe-upsert): idempotent find-first-or-create, backed by the (task,user) unique index
    {
      const uid = actor;
      if (uid) {
        try {
          e.app.findFirstRecordByFilter(
            "task_subscribers",
            "task = {:t} && user = {:u}",
            { t: taskId, u: uid },
          );
        } catch (_) {
          const c = e.app.findCollectionByNameOrId("task_subscribers");
          const r = new Record(c);
          r.set("task", taskId);
          r.set("user", uid);
          // The record this subscribe hangs off is already committed, so a failed row is dropped
          // and named in the log — never thrown, which would lose the fan-out that follows it.
          try {
            e.app.save(r);
          } catch (saveErr) {
            e.app
              .logger()
              .error(
                "auto-subscribe save failed",
                "task",
                taskId,
                "user",
                uid,
                "error",
                String(saveErr),
              );
          }
        }
      }
    }
    // KEEP IN SYNC (mention resolve): "@[Display](userId)" — the id alone resolves — or a hand-typed "@" + email local part (case-insensitive), both kept only if they name an ACTIVE member of the task's workspace or that workspace's owner; a local part with zero or 2+ matches resolves to nobody; the hand-typed pass reads the body with the reference spans cut out, so bracket text names nobody
    const resolveMentions = (body, task) => {
      let raw = String(body || "");
      for (let i = 0; i < raw.length; i++) {
        if (i === 0 || raw[i - 1] === "\n") {
          let open = i;
          while (open - i < 3 && raw[open] === " ") open++;
          const mark = raw[open];
          let after = open;
          while (after < raw.length && raw[after] === mark) after++;
          const width = after - open;
          if (
            mark === "`" &&
            width >= 3 &&
            raw
              .slice(
                after,
                raw.indexOf("\n", after) === -1
                  ? raw.length
                  : raw.indexOf("\n", after),
              )
              .indexOf("`") !== -1
          ) {
            i = after - 1;
            continue;
          }
          if ((mark === "`" || mark === "~") && width >= 3) {
            let line = raw.indexOf("\n", after);
            line = line === -1 ? raw.length : line + 1;
            let end = raw.length;
            while (line < raw.length) {
              let close = line;
              while (close - line < 3 && raw[close] === " ") close++;
              let closeEnd = close;
              while (raw[closeEnd] === mark) closeEnd++;
              let tail = closeEnd;
              while (
                raw[tail] === " " ||
                raw[tail] === "\t" ||
                raw[tail] === "\r"
              )
                tail++;
              if (
                closeEnd - close >= width &&
                (raw[tail] === "\n" || tail === raw.length)
              ) {
                end = raw[tail] === "\n" ? tail + 1 : tail;
                break;
              }
              line = raw.indexOf("\n", line);
              line = line === -1 ? raw.length : line + 1;
            }
            raw =
              raw.slice(0, i) +
              raw.slice(i, end).replace(/[^\n]/g, " ") +
              raw.slice(end);
            i = end - 1;
            continue;
          }
        }
        if (raw[i] !== "`") continue;
        let escaped = 0;
        while (i - escaped > 0 && raw[i - escaped - 1] === "\\") escaped++;
        if (escaped % 2) continue;
        let width = 0;
        while (raw[i + width] === "`") width++;
        let end = -1;
        for (let scan = i + width; scan < raw.length; scan++) {
          if (raw[scan] === "\n" && /^[ \t]*\n/.test(raw.slice(scan + 1)))
            break;
          if (raw[scan] !== "`") continue;
          let closeEnd = scan;
          while (raw[closeEnd] === "`") closeEnd++;
          if (closeEnd - scan === width) {
            end = closeEnd;
            break;
          }
          scan = closeEnd - 1;
        }
        if (end === -1) {
          i += width - 1;
          continue;
        }
        raw =
          raw.slice(0, i) +
          raw.slice(i, end).replace(/[^\n]/g, " ") +
          raw.slice(end);
        i = end - 1;
      }
      const ids = [];
      const idRe = /@\[[^\]\n]*\]\(([A-Za-z0-9]+)\)/g;
      let idm;
      while ((idm = idRe.exec(raw)) !== null) {
        if (ids.indexOf(idm[1]) === -1) ids.push(idm[1]);
      }
      // Reference spans are cut out before the hand-typed pass: a display name can itself
      // contain "@handle", and the fallback must still read everything outside a span.
      // Its own literal, never idRe: a /g regex carries lastIndex between calls.
      const stripped = raw.replace(/@\[[^\]\n]*\]\([A-Za-z0-9]+\)/g, " ");
      const tokens = [];
      const re = /(^|[^A-Za-z0-9])@([A-Za-z0-9._%+-]+)/g;
      let m;
      while ((m = re.exec(stripped)) !== null) {
        // Sentence punctuation is inside the local-part class, so trim it off the tail;
        // an interior dot is legal in an address and must survive.
        const t = m[2].replace(/[._%+-]+$/, "").toLowerCase();
        if (t && tokens.indexOf(t) === -1) tokens.push(t);
      }
      if ((!tokens.length && !ids.length) || !task) return [];
      let wsId = "";
      try {
        wsId = e.app.findRecordById("tasks", task).get("workspace");
      } catch (_) {
        return [];
      }
      if (!wsId) return [];
      // ONE query, and not a record filter: PB's filter parser caps how many expressions it
      // parses, so an id-per-member OR chain silently resolves nobody in a big workspace.
      const cand = [];
      const locals = [];
      const rows = arrayOf(new DynamicModel({ id: "", email: "" }));
      e.app
        .db()
        .newQuery(
          "SELECT u.id AS id, u.email AS email FROM users u WHERE u.id IN " +
            "(SELECT [[m.user]] FROM workspace_members m WHERE m.workspace = {:w} AND m.status = 'active')" +
            " OR u.id = (SELECT w.owner FROM workspaces w WHERE w.id = {:w2})",
        )
        .bind({ w: wsId, w2: wsId })
        .all(rows);
      for (let i = 0; i < rows.length; i++) {
        cand.push(rows[i].id);
        locals.push(
          String(rows[i].email || "")
            .split("@")[0]
            .toLowerCase(),
        );
      }
      const hits = [];
      // An id resolves only through that same candidate set, so a reference can never
      // name a non-member and no new read of anyone's address is needed.
      for (let i = 0; i < ids.length; i++) {
        if (cand.indexOf(ids[i]) !== -1 && hits.indexOf(ids[i]) === -1)
          hits.push(ids[i]);
      }
      for (let i = 0; i < tokens.length; i++) {
        let hit = "";
        let n = 0;
        for (let j = 0; j < cand.length; j++) {
          if (locals[j] && locals[j] === tokens[i]) {
            hit = cand[j];
            n++;
          }
        }
        if (n === 1 && hits.indexOf(hit) === -1) hits.push(hit);
      }
      return hits;
    };
    const mentioned = resolveMentions(e.record.get("body"), taskId);
    // A named subscriber gets the mention row only: one notification per comment (Linear).
    const _skip = mentioned;
    // KEEP IN SYNC (fan-out): notify every subscriber EXCEPT the actor and anyone in _skip; kind is the trigger's kind
    {
      const _subs = e.app.findRecordsByFilter(
        "task_subscribers",
        "task = {:t}",
        "",
        0,
        0,
        { t: taskId },
      );
      const _ncol = e.app.findCollectionByNameOrId("notifications");
      for (let i = 0; i < _subs.length; i++) {
        const uid = _subs[i].get("user");
        if (uid === actor || _skip.indexOf(uid) !== -1) continue;
        const n = new Record(_ncol);
        n.set("user", uid);
        n.set("task", taskId);
        n.set("workspace", _ws);
        n.set("kind", "commented");
        n.set("read", false);
        n.set("comment", e.record.id);
        n.set("comment_preview", preview);
        // The record this fan-out is about is already committed, so a failed row is dropped
        // and named in the log — never thrown, which would lose every recipient after it.
        try {
          e.app.save(n);
        } catch (saveErr) {
          e.app
            .logger()
            .error(
              "notification fan-out save failed",
              "kind",
              n.get("kind"),
              "user",
              uid,
              "error",
              String(saveErr),
            );
        }
      }
    }
    // KEEP IN SYNC (mention fan-out): one row per resolved member, never the actor; the preview is a snapshot of the body as of this event
    {
      const _ncol = e.app.findCollectionByNameOrId("notifications");
      for (let i = 0; i < mentioned.length; i++) {
        const uid = mentioned[i];
        if (!uid || uid === actor) continue;
        const n = new Record(_ncol);
        n.set("user", uid);
        n.set("task", taskId);
        n.set("workspace", _ws);
        n.set("kind", "mentioned");
        n.set("read", false);
        n.set("comment", e.record.id);
        n.set("comment_preview", preview);
        // The record this fan-out is about is already committed, so a failed row is dropped
        // and named in the log — never thrown, which would lose every recipient after it.
        try {
          e.app.save(n);
        } catch (saveErr) {
          e.app
            .logger()
            .error(
              "notification fan-out save failed",
              "kind",
              n.get("kind"),
              "user",
              uid,
              "error",
              String(saveErr),
            );
        }
      }
    }
  }
  // A document/decision comment has no subscriber model → no fan-out.
}, "comments");

// (4) comments update — tamper-proof edited flag (a client cannot set OR clear it).
onRecordUpdateRequest((e) => {
  const orig = e.record.original();
  if (e.record.get("body") !== orig.get("body")) {
    e.record.set("edited", true);
  } else {
    e.record.set("edited", orig.get("edited"));
  }
  return e.next();
}, "comments");

// (5) comments update — reactions toggle: a user may only add/remove THEIR OWN id.
// reactions is a JSON object emoji → [user ids]; the value may arrive as an object or a
// JSON string (defensive parse), null/absent = {}. Runs before persist (validation).
onRecordUpdateRequest((e) => {
  if (e.auth && e.auth.isSuperuser()) {
    return e.next();
  }
  const actor = e.auth ? e.auth.id : "";
  // .get("reactions") is a JsonRaw wrapper (typeof "object" but NOT native JS — won't
  // enumerate, Array.isArray fails); String(v) yields its JSON text ("null" when empty).
  const parse = (v) => {
    if (v === null || v === undefined) return {};
    const s = typeof v === "string" ? v : String(v);
    if (s === "" || s === "null") return {};
    try {
      return JSON.parse(s);
    } catch (_) {
      return {};
    }
  };
  const before = parse(e.record.original().get("reactions"));
  const after = parse(e.record.get("reactions"));
  const keys = {};
  for (const k in before) keys[k] = true;
  for (const k in after) keys[k] = true;
  for (const k in keys) {
    const b = Array.isArray(before[k]) ? before[k] : [];
    const a = Array.isArray(after[k]) ? after[k] : [];
    for (let i = 0; i < a.length; i++) {
      if (b.indexOf(a[i]) === -1 && a[i] !== actor) {
        throw new BadRequestError("may only toggle your own reaction");
      }
    }
    for (let i = 0; i < b.length; i++) {
      if (a.indexOf(b[i]) === -1 && b[i] !== actor) {
        throw new BadRequestError("may only toggle your own reaction");
      }
    }
  }
  return e.next();
}, "comments");

// (6) comments update — @mention fan-out on edit. Replay guard: anyone already holding a
// mention row for THIS comment is skipped, so re-saving the same body notifies nobody.
onRecordUpdateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  e.next();
  const taskId = e.record.get("task");
  if (taskId) {
    const preview = String(e.record.get("body") || "").slice(0, 140);
    // A comment has no workspace of its own; its notifications carry the task one.
    let _ws = "";
    try {
      _ws = e.app.findRecordById("tasks", taskId).get("workspace");
    } catch (_) {}
    // KEEP IN SYNC (mention resolve): "@[Display](userId)" — the id alone resolves — or a hand-typed "@" + email local part (case-insensitive), both kept only if they name an ACTIVE member of the task's workspace or that workspace's owner; a local part with zero or 2+ matches resolves to nobody; the hand-typed pass reads the body with the reference spans cut out, so bracket text names nobody
    const resolveMentions = (body, task) => {
      let raw = String(body || "");
      for (let i = 0; i < raw.length; i++) {
        if (i === 0 || raw[i - 1] === "\n") {
          let open = i;
          while (open - i < 3 && raw[open] === " ") open++;
          const mark = raw[open];
          let after = open;
          while (after < raw.length && raw[after] === mark) after++;
          const width = after - open;
          if (
            mark === "`" &&
            width >= 3 &&
            raw
              .slice(
                after,
                raw.indexOf("\n", after) === -1
                  ? raw.length
                  : raw.indexOf("\n", after),
              )
              .indexOf("`") !== -1
          ) {
            i = after - 1;
            continue;
          }
          if ((mark === "`" || mark === "~") && width >= 3) {
            let line = raw.indexOf("\n", after);
            line = line === -1 ? raw.length : line + 1;
            let end = raw.length;
            while (line < raw.length) {
              let close = line;
              while (close - line < 3 && raw[close] === " ") close++;
              let closeEnd = close;
              while (raw[closeEnd] === mark) closeEnd++;
              let tail = closeEnd;
              while (
                raw[tail] === " " ||
                raw[tail] === "\t" ||
                raw[tail] === "\r"
              )
                tail++;
              if (
                closeEnd - close >= width &&
                (raw[tail] === "\n" || tail === raw.length)
              ) {
                end = raw[tail] === "\n" ? tail + 1 : tail;
                break;
              }
              line = raw.indexOf("\n", line);
              line = line === -1 ? raw.length : line + 1;
            }
            raw =
              raw.slice(0, i) +
              raw.slice(i, end).replace(/[^\n]/g, " ") +
              raw.slice(end);
            i = end - 1;
            continue;
          }
        }
        if (raw[i] !== "`") continue;
        let escaped = 0;
        while (i - escaped > 0 && raw[i - escaped - 1] === "\\") escaped++;
        if (escaped % 2) continue;
        let width = 0;
        while (raw[i + width] === "`") width++;
        let end = -1;
        for (let scan = i + width; scan < raw.length; scan++) {
          if (raw[scan] === "\n" && /^[ \t]*\n/.test(raw.slice(scan + 1)))
            break;
          if (raw[scan] !== "`") continue;
          let closeEnd = scan;
          while (raw[closeEnd] === "`") closeEnd++;
          if (closeEnd - scan === width) {
            end = closeEnd;
            break;
          }
          scan = closeEnd - 1;
        }
        if (end === -1) {
          i += width - 1;
          continue;
        }
        raw =
          raw.slice(0, i) +
          raw.slice(i, end).replace(/[^\n]/g, " ") +
          raw.slice(end);
        i = end - 1;
      }
      const ids = [];
      const idRe = /@\[[^\]\n]*\]\(([A-Za-z0-9]+)\)/g;
      let idm;
      while ((idm = idRe.exec(raw)) !== null) {
        if (ids.indexOf(idm[1]) === -1) ids.push(idm[1]);
      }
      // Reference spans are cut out before the hand-typed pass: a display name can itself
      // contain "@handle", and the fallback must still read everything outside a span.
      // Its own literal, never idRe: a /g regex carries lastIndex between calls.
      const stripped = raw.replace(/@\[[^\]\n]*\]\([A-Za-z0-9]+\)/g, " ");
      const tokens = [];
      const re = /(^|[^A-Za-z0-9])@([A-Za-z0-9._%+-]+)/g;
      let m;
      while ((m = re.exec(stripped)) !== null) {
        // Sentence punctuation is inside the local-part class, so trim it off the tail;
        // an interior dot is legal in an address and must survive.
        const t = m[2].replace(/[._%+-]+$/, "").toLowerCase();
        if (t && tokens.indexOf(t) === -1) tokens.push(t);
      }
      if ((!tokens.length && !ids.length) || !task) return [];
      let wsId = "";
      try {
        wsId = e.app.findRecordById("tasks", task).get("workspace");
      } catch (_) {
        return [];
      }
      if (!wsId) return [];
      // ONE query, and not a record filter: PB's filter parser caps how many expressions it
      // parses, so an id-per-member OR chain silently resolves nobody in a big workspace.
      const cand = [];
      const locals = [];
      const rows = arrayOf(new DynamicModel({ id: "", email: "" }));
      e.app
        .db()
        .newQuery(
          "SELECT u.id AS id, u.email AS email FROM users u WHERE u.id IN " +
            "(SELECT [[m.user]] FROM workspace_members m WHERE m.workspace = {:w} AND m.status = 'active')" +
            " OR u.id = (SELECT w.owner FROM workspaces w WHERE w.id = {:w2})",
        )
        .bind({ w: wsId, w2: wsId })
        .all(rows);
      for (let i = 0; i < rows.length; i++) {
        cand.push(rows[i].id);
        locals.push(
          String(rows[i].email || "")
            .split("@")[0]
            .toLowerCase(),
        );
      }
      const hits = [];
      // An id resolves only through that same candidate set, so a reference can never
      // name a non-member and no new read of anyone's address is needed.
      for (let i = 0; i < ids.length; i++) {
        if (cand.indexOf(ids[i]) !== -1 && hits.indexOf(ids[i]) === -1)
          hits.push(ids[i]);
      }
      for (let i = 0; i < tokens.length; i++) {
        let hit = "";
        let n = 0;
        for (let j = 0; j < cand.length; j++) {
          if (locals[j] && locals[j] === tokens[i]) {
            hit = cand[j];
            n++;
          }
        }
        if (n === 1 && hits.indexOf(hit) === -1) hits.push(hit);
      }
      return hits;
    };
    // Membership moves under a comment, so the guard asks what was already SENT for it —
    // a re-resolved before-set subtracts members who were never notified.
    const mentioned = resolveMentions(e.record.get("body"), taskId).filter(
      (uid) => {
        try {
          e.app.findFirstRecordByFilter(
            "notifications",
            "user = {:u} && comment = {:c} && kind = 'mentioned'",
            { u: uid, c: e.record.id },
          );
          return false;
        } catch (_) {
          return true;
        }
      },
    );
    // KEEP IN SYNC (mention fan-out): one row per resolved member, never the actor; the preview is a snapshot of the body as of this event
    {
      const _ncol = e.app.findCollectionByNameOrId("notifications");
      for (let i = 0; i < mentioned.length; i++) {
        const uid = mentioned[i];
        if (!uid || uid === actor) continue;
        const n = new Record(_ncol);
        n.set("user", uid);
        n.set("task", taskId);
        n.set("workspace", _ws);
        n.set("kind", "mentioned");
        n.set("read", false);
        n.set("comment", e.record.id);
        n.set("comment_preview", preview);
        // The record this fan-out is about is already committed, so a failed row is dropped
        // and named in the log — never thrown, which would lose every recipient after it.
        try {
          e.app.save(n);
        } catch (saveErr) {
          e.app
            .logger()
            .error(
              "notification fan-out save failed",
              "kind",
              n.get("kind"),
              "user",
              uid,
              "error",
              String(saveErr),
            );
        }
      }
    }
  }
}, "comments");

// (7) tasks/documents/decisions create — @mention fan-out over the item's own prose.
onRecordCreateRequest(
  (e) => {
    const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
    e.next();
    // KEEP IN SYNC (item mention site): create and update read the same prose and write the same row
    {
      const colName = e.record.collection().name;
      const rel =
        colName === "tasks"
          ? "task"
          : colName === "documents"
            ? "document"
            : "decision";
      // The item's OWN prose, whatever it is called there: no collection has a `description`
      // but tasks, and a decision carries three prose fields rather than one.
      const prose =
        colName === "tasks"
          ? [String(e.record.get("description") || "")]
          : colName === "documents"
            ? [String(e.record.get("body") || "")]
            : [
                String(e.record.get("context") || ""),
                String(e.record.get("decision") || ""),
                String(e.record.get("consequences") || ""),
              ];
      const itemId = e.record.id;
      const wsId = e.record.get("workspace");
      // A draft names nobody: the members it would name cannot read it, so publishing sends them.
      const isDraft = e.record.get("draft") === true;
      // KEEP IN SYNC (item mention resolve): "@[Display](userId)" — the id alone resolves — or a hand-typed "@" + email local part (case-insensitive), both kept only if they name an ACTIVE member of the item's workspace or that workspace's owner; a local part with zero or 2+ matches resolves to nobody; the hand-typed pass reads the body with the reference spans cut out, so bracket text names nobody
      const resolveMentions = (body, ws) => {
        let raw = String(body || "");
        for (let i = 0; i < raw.length; i++) {
          if (i === 0 || raw[i - 1] === "\n") {
            let open = i;
            while (open - i < 3 && raw[open] === " ") open++;
            const mark = raw[open];
            let after = open;
            while (after < raw.length && raw[after] === mark) after++;
            const width = after - open;
            if (
              mark === "`" &&
              width >= 3 &&
              raw
                .slice(
                  after,
                  raw.indexOf("\n", after) === -1
                    ? raw.length
                    : raw.indexOf("\n", after),
                )
                .indexOf("`") !== -1
            ) {
              i = after - 1;
              continue;
            }
            if ((mark === "`" || mark === "~") && width >= 3) {
              let line = raw.indexOf("\n", after);
              line = line === -1 ? raw.length : line + 1;
              let end = raw.length;
              while (line < raw.length) {
                let close = line;
                while (close - line < 3 && raw[close] === " ") close++;
                let closeEnd = close;
                while (raw[closeEnd] === mark) closeEnd++;
                let tail = closeEnd;
                while (
                  raw[tail] === " " ||
                  raw[tail] === "\t" ||
                  raw[tail] === "\r"
                )
                  tail++;
                if (
                  closeEnd - close >= width &&
                  (raw[tail] === "\n" || tail === raw.length)
                ) {
                  end = raw[tail] === "\n" ? tail + 1 : tail;
                  break;
                }
                line = raw.indexOf("\n", line);
                line = line === -1 ? raw.length : line + 1;
              }
              raw =
                raw.slice(0, i) +
                raw.slice(i, end).replace(/[^\n]/g, " ") +
                raw.slice(end);
              i = end - 1;
              continue;
            }
          }
          if (raw[i] !== "`") continue;
          let escaped = 0;
          while (i - escaped > 0 && raw[i - escaped - 1] === "\\") escaped++;
          if (escaped % 2) continue;
          let width = 0;
          while (raw[i + width] === "`") width++;
          let end = -1;
          for (let scan = i + width; scan < raw.length; scan++) {
            if (raw[scan] === "\n" && /^[ \t]*\n/.test(raw.slice(scan + 1)))
              break;
            if (raw[scan] !== "`") continue;
            let closeEnd = scan;
            while (raw[closeEnd] === "`") closeEnd++;
            if (closeEnd - scan === width) {
              end = closeEnd;
              break;
            }
            scan = closeEnd - 1;
          }
          if (end === -1) {
            i += width - 1;
            continue;
          }
          raw =
            raw.slice(0, i) +
            raw.slice(i, end).replace(/[^\n]/g, " ") +
            raw.slice(end);
          i = end - 1;
        }
        const ids = [];
        const idRe = /@\[[^\]\n]*\]\(([A-Za-z0-9]+)\)/g;
        let idm;
        while ((idm = idRe.exec(raw)) !== null) {
          if (ids.indexOf(idm[1]) === -1) ids.push(idm[1]);
        }
        // Reference spans are cut out before the hand-typed pass: a display name can itself
        // contain "@handle", and the fallback must still read everything outside a span.
        // Its own literal, never idRe: a /g regex carries lastIndex between calls.
        const stripped = raw.replace(/@\[[^\]\n]*\]\([A-Za-z0-9]+\)/g, " ");
        const tokens = [];
        const re = /(^|[^A-Za-z0-9])@([A-Za-z0-9._%+-]+)/g;
        let m;
        while ((m = re.exec(stripped)) !== null) {
          // Sentence punctuation is inside the local-part class, so trim it off the tail;
          // an interior dot is legal in an address and must survive.
          const t = m[2].replace(/[._%+-]+$/, "").toLowerCase();
          if (t && tokens.indexOf(t) === -1) tokens.push(t);
        }
        if ((!tokens.length && !ids.length) || !ws) return [];
        // ONE query, and not a record filter: PB's filter parser caps how many expressions it
        // parses, so an id-per-member OR chain silently resolves nobody in a big workspace.
        const cand = [];
        const locals = [];
        const rows = arrayOf(new DynamicModel({ id: "", email: "" }));
        e.app
          .db()
          .newQuery(
            "SELECT u.id AS id, u.email AS email FROM users u WHERE u.id IN " +
              "(SELECT [[m.user]] FROM workspace_members m WHERE m.workspace = {:w} AND m.status = 'active')" +
              " OR u.id = (SELECT w.owner FROM workspaces w WHERE w.id = {:w2})",
          )
          .bind({ w: ws, w2: ws })
          .all(rows);
        for (let i = 0; i < rows.length; i++) {
          cand.push(rows[i].id);
          locals.push(
            String(rows[i].email || "")
              .split("@")[0]
              .toLowerCase(),
          );
        }
        const hits = [];
        // An id resolves only through that same candidate set, so a reference can never
        // name a non-member and no new read of anyone's address is needed.
        for (let i = 0; i < ids.length; i++) {
          if (cand.indexOf(ids[i]) !== -1 && hits.indexOf(ids[i]) === -1)
            hits.push(ids[i]);
        }
        for (let i = 0; i < tokens.length; i++) {
          let hit = "";
          let n = 0;
          for (let j = 0; j < cand.length; j++) {
            if (locals[j] && locals[j] === tokens[i]) {
              hit = cand[j];
              n++;
            }
          }
          if (n === 1 && hits.indexOf(hit) === -1) hits.push(hit);
        }
        return hits;
      };
      // The guard asks what was already SENT for this item, and `comment = ''` keeps it apart
      // from a comment mention on the same item, which must still notify in its own right.
      const mentioned = isDraft
        ? []
        : prose
            .reduce((hits, body) => {
              const resolved = resolveMentions(body, wsId);
              for (let i = 0; i < resolved.length; i++) {
                if (hits.indexOf(resolved[i]) === -1) hits.push(resolved[i]);
              }
              return hits;
            }, [])
            .filter((uid) => {
              try {
                e.app.findFirstRecordByFilter(
                  "notifications",
                  "user = {:u} && " +
                    rel +
                    " = {:i} && kind = 'mentioned' && comment = ''",
                  { u: uid, i: itemId },
                );
                return false;
              } catch (_) {
                return true;
              }
            });
      // KEEP IN SYNC (item mention fan-out): one row per resolved member, never the actor; the row names the item, never a comment
      {
        const _ncol = e.app.findCollectionByNameOrId("notifications");
        for (let i = 0; i < mentioned.length; i++) {
          const uid = mentioned[i];
          if (!uid || uid === actor) continue;
          const n = new Record(_ncol);
          n.set("user", uid);
          n.set(rel, itemId);
          n.set("workspace", wsId);
          n.set("kind", "mentioned");
          n.set("read", false);
          // The record this fan-out is about is already committed, so a failed row is dropped
          // and named in the log — never thrown, which would lose every recipient after it.
          try {
            e.app.save(n);
          } catch (saveErr) {
            e.app
              .logger()
              .error(
                "notification fan-out save failed",
                "kind",
                n.get("kind"),
                "user",
                uid,
                "error",
                String(saveErr),
              );
          }
        }
      }
    }
  },
  "tasks",
  "documents",
  "decisions",
);

// (8) tasks/documents/decisions update — the same fan-out, replay-guarded per item.
onRecordUpdateRequest(
  (e) => {
    const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
    e.next();
    // KEEP IN SYNC (item mention site): create and update read the same prose and write the same row
    {
      const colName = e.record.collection().name;
      const rel =
        colName === "tasks"
          ? "task"
          : colName === "documents"
            ? "document"
            : "decision";
      // The item's OWN prose, whatever it is called there: no collection has a `description`
      // but tasks, and a decision carries three prose fields rather than one.
      const prose =
        colName === "tasks"
          ? [String(e.record.get("description") || "")]
          : colName === "documents"
            ? [String(e.record.get("body") || "")]
            : [
                String(e.record.get("context") || ""),
                String(e.record.get("decision") || ""),
                String(e.record.get("consequences") || ""),
              ];
      const itemId = e.record.id;
      const wsId = e.record.get("workspace");
      // A draft names nobody: the members it would name cannot read it, so publishing sends them.
      const isDraft = e.record.get("draft") === true;
      // KEEP IN SYNC (item mention resolve): "@[Display](userId)" — the id alone resolves — or a hand-typed "@" + email local part (case-insensitive), both kept only if they name an ACTIVE member of the item's workspace or that workspace's owner; a local part with zero or 2+ matches resolves to nobody; the hand-typed pass reads the body with the reference spans cut out, so bracket text names nobody
      const resolveMentions = (body, ws) => {
        let raw = String(body || "");
        for (let i = 0; i < raw.length; i++) {
          if (i === 0 || raw[i - 1] === "\n") {
            let open = i;
            while (open - i < 3 && raw[open] === " ") open++;
            const mark = raw[open];
            let after = open;
            while (after < raw.length && raw[after] === mark) after++;
            const width = after - open;
            if (
              mark === "`" &&
              width >= 3 &&
              raw
                .slice(
                  after,
                  raw.indexOf("\n", after) === -1
                    ? raw.length
                    : raw.indexOf("\n", after),
                )
                .indexOf("`") !== -1
            ) {
              i = after - 1;
              continue;
            }
            if ((mark === "`" || mark === "~") && width >= 3) {
              let line = raw.indexOf("\n", after);
              line = line === -1 ? raw.length : line + 1;
              let end = raw.length;
              while (line < raw.length) {
                let close = line;
                while (close - line < 3 && raw[close] === " ") close++;
                let closeEnd = close;
                while (raw[closeEnd] === mark) closeEnd++;
                let tail = closeEnd;
                while (
                  raw[tail] === " " ||
                  raw[tail] === "\t" ||
                  raw[tail] === "\r"
                )
                  tail++;
                if (
                  closeEnd - close >= width &&
                  (raw[tail] === "\n" || tail === raw.length)
                ) {
                  end = raw[tail] === "\n" ? tail + 1 : tail;
                  break;
                }
                line = raw.indexOf("\n", line);
                line = line === -1 ? raw.length : line + 1;
              }
              raw =
                raw.slice(0, i) +
                raw.slice(i, end).replace(/[^\n]/g, " ") +
                raw.slice(end);
              i = end - 1;
              continue;
            }
          }
          if (raw[i] !== "`") continue;
          let escaped = 0;
          while (i - escaped > 0 && raw[i - escaped - 1] === "\\") escaped++;
          if (escaped % 2) continue;
          let width = 0;
          while (raw[i + width] === "`") width++;
          let end = -1;
          for (let scan = i + width; scan < raw.length; scan++) {
            if (raw[scan] === "\n" && /^[ \t]*\n/.test(raw.slice(scan + 1)))
              break;
            if (raw[scan] !== "`") continue;
            let closeEnd = scan;
            while (raw[closeEnd] === "`") closeEnd++;
            if (closeEnd - scan === width) {
              end = closeEnd;
              break;
            }
            scan = closeEnd - 1;
          }
          if (end === -1) {
            i += width - 1;
            continue;
          }
          raw =
            raw.slice(0, i) +
            raw.slice(i, end).replace(/[^\n]/g, " ") +
            raw.slice(end);
          i = end - 1;
        }
        const ids = [];
        const idRe = /@\[[^\]\n]*\]\(([A-Za-z0-9]+)\)/g;
        let idm;
        while ((idm = idRe.exec(raw)) !== null) {
          if (ids.indexOf(idm[1]) === -1) ids.push(idm[1]);
        }
        // Reference spans are cut out before the hand-typed pass: a display name can itself
        // contain "@handle", and the fallback must still read everything outside a span.
        // Its own literal, never idRe: a /g regex carries lastIndex between calls.
        const stripped = raw.replace(/@\[[^\]\n]*\]\([A-Za-z0-9]+\)/g, " ");
        const tokens = [];
        const re = /(^|[^A-Za-z0-9])@([A-Za-z0-9._%+-]+)/g;
        let m;
        while ((m = re.exec(stripped)) !== null) {
          // Sentence punctuation is inside the local-part class, so trim it off the tail;
          // an interior dot is legal in an address and must survive.
          const t = m[2].replace(/[._%+-]+$/, "").toLowerCase();
          if (t && tokens.indexOf(t) === -1) tokens.push(t);
        }
        if ((!tokens.length && !ids.length) || !ws) return [];
        // ONE query, and not a record filter: PB's filter parser caps how many expressions it
        // parses, so an id-per-member OR chain silently resolves nobody in a big workspace.
        const cand = [];
        const locals = [];
        const rows = arrayOf(new DynamicModel({ id: "", email: "" }));
        e.app
          .db()
          .newQuery(
            "SELECT u.id AS id, u.email AS email FROM users u WHERE u.id IN " +
              "(SELECT [[m.user]] FROM workspace_members m WHERE m.workspace = {:w} AND m.status = 'active')" +
              " OR u.id = (SELECT w.owner FROM workspaces w WHERE w.id = {:w2})",
          )
          .bind({ w: ws, w2: ws })
          .all(rows);
        for (let i = 0; i < rows.length; i++) {
          cand.push(rows[i].id);
          locals.push(
            String(rows[i].email || "")
              .split("@")[0]
              .toLowerCase(),
          );
        }
        const hits = [];
        // An id resolves only through that same candidate set, so a reference can never
        // name a non-member and no new read of anyone's address is needed.
        for (let i = 0; i < ids.length; i++) {
          if (cand.indexOf(ids[i]) !== -1 && hits.indexOf(ids[i]) === -1)
            hits.push(ids[i]);
        }
        for (let i = 0; i < tokens.length; i++) {
          let hit = "";
          let n = 0;
          for (let j = 0; j < cand.length; j++) {
            if (locals[j] && locals[j] === tokens[i]) {
              hit = cand[j];
              n++;
            }
          }
          if (n === 1 && hits.indexOf(hit) === -1) hits.push(hit);
        }
        return hits;
      };
      // The guard asks what was already SENT for this item, and `comment = ''` keeps it apart
      // from a comment mention on the same item, which must still notify in its own right.
      const mentioned = isDraft
        ? []
        : prose
            .reduce((hits, body) => {
              const resolved = resolveMentions(body, wsId);
              for (let i = 0; i < resolved.length; i++) {
                if (hits.indexOf(resolved[i]) === -1) hits.push(resolved[i]);
              }
              return hits;
            }, [])
            .filter((uid) => {
              try {
                e.app.findFirstRecordByFilter(
                  "notifications",
                  "user = {:u} && " +
                    rel +
                    " = {:i} && kind = 'mentioned' && comment = ''",
                  { u: uid, i: itemId },
                );
                return false;
              } catch (_) {
                return true;
              }
            });
      // KEEP IN SYNC (item mention fan-out): one row per resolved member, never the actor; the row names the item, never a comment
      {
        const _ncol = e.app.findCollectionByNameOrId("notifications");
        for (let i = 0; i < mentioned.length; i++) {
          const uid = mentioned[i];
          if (!uid || uid === actor) continue;
          const n = new Record(_ncol);
          n.set("user", uid);
          n.set(rel, itemId);
          n.set("workspace", wsId);
          n.set("kind", "mentioned");
          n.set("read", false);
          // The record this fan-out is about is already committed, so a failed row is dropped
          // and named in the log — never thrown, which would lose every recipient after it.
          try {
            e.app.save(n);
          } catch (saveErr) {
            e.app
              .logger()
              .error(
                "notification fan-out save failed",
                "kind",
                n.get("kind"),
                "user",
                uid,
                "error",
                String(saveErr),
              );
          }
        }
      }
    }
  },
  "tasks",
  "documents",
  "decisions",
);

// (9) POST /api/tracker/notifications/read-all — the caller's whole unread inbox (or one
// ?workspace= plus rows with no workspace), marked read in ONE statement. A per-row PATCH loop
// trips the app's own /api/ rate limit on a big inbox.
routerAdd(
  "POST",
  "/api/tracker/notifications/read-all",
  (e) => {
    // [[read]] bracket-quoted (reserved-ish); NULL-safe so an unset flag still counts.
    // KEEP IN SYNC (unread predicate): notifications.listRule (1785171300, 1785172400,
    // 1785174200, 1785176700), the
    // digest cron below, and this route — what is marked read, what is counted and what the
    // inbox lists must be one set, so trashed work, work the recipient lost access to AND a
    // draft item the recipient cannot open are excluded on all three by the same
    // predicate, through each of the three item links.
    const ws = String(e.request.url.query().get("workspace") || "");
    const res = e.app
      .db()
      .newQuery(
        "UPDATE notifications SET [[read]] = true, " +
          "[[updated]] = strftime('%Y-%m-%d %H:%M:%fZ', 'now') " +
          "WHERE ([[read]] IS NULL OR [[read]] = false) AND " +
          "([[dismissed]] IS NULL OR [[dismissed]] = false) AND " +
          "(notifications.task = '' OR EXISTS (SELECT 1 FROM tasks t " +
          "WHERE t.id = notifications.task AND t.trashed = '' AND " +
          "(t.project = '' OR EXISTS (SELECT 1 FROM projects p " +
          "WHERE p.id = t.project AND p.trashed = '')) AND " +
          "EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace AND w.trashed = '' AND " +
          "(w.owner = [[notifications.user]] OR t.assignee = [[notifications.user]] OR " +
          "EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace = w.id AND " +
          "[[m.user]] = [[notifications.user]] AND m.status = 'active'))))) AND " +
          "(notifications.document = '' OR EXISTS (SELECT 1 FROM documents d " +
          "WHERE d.id = notifications.document AND d.trashed = '' AND " +
          "(d.draft = 0 OR d.author = [[notifications.user]] OR " +
          "EXISTS (SELECT 1 FROM workspaces dwo WHERE dwo.id = d.workspace AND " +
          "dwo.owner = [[notifications.user]]) OR " +
          "EXISTS (SELECT 1 FROM workspace_members dad WHERE dad.workspace = d.workspace AND " +
          "[[dad.user]] = [[notifications.user]] AND dad.role = 'admin' AND " +
          "dad.status = 'active')) AND " +
          "(d.project = '' OR EXISTS (SELECT 1 FROM projects dp " +
          "WHERE dp.id = d.project AND dp.trashed = '')) AND " +
          "EXISTS (SELECT 1 FROM workspaces dw WHERE dw.id = d.workspace AND dw.trashed = '' AND " +
          "(dw.owner = [[notifications.user]] OR " +
          "EXISTS (SELECT 1 FROM workspace_members dm WHERE dm.workspace = dw.id AND " +
          "[[dm.user]] = [[notifications.user]] AND dm.status = 'active'))))) AND " +
          "(notifications.decision = '' OR EXISTS (SELECT 1 FROM decisions dd " +
          "WHERE dd.id = notifications.decision AND dd.trashed = '' AND " +
          "(dd.draft = 0 OR dd.author = [[notifications.user]] OR " +
          "EXISTS (SELECT 1 FROM workspaces cwo WHERE cwo.id = dd.workspace AND " +
          "cwo.owner = [[notifications.user]]) OR " +
          "EXISTS (SELECT 1 FROM workspace_members cad WHERE cad.workspace = dd.workspace AND " +
          "[[cad.user]] = [[notifications.user]] AND cad.role = 'admin' AND " +
          "cad.status = 'active')) AND " +
          "(dd.project = '' OR EXISTS (SELECT 1 FROM projects cp " +
          "WHERE cp.id = dd.project AND cp.trashed = '')) AND " +
          "EXISTS (SELECT 1 FROM workspaces cw WHERE cw.id = dd.workspace AND cw.trashed = '' AND " +
          "(cw.owner = [[notifications.user]] OR " +
          "EXISTS (SELECT 1 FROM workspace_members cm WHERE cm.workspace = cw.id AND " +
          "[[cm.user]] = [[notifications.user]] AND cm.status = 'active'))))) " +
          "AND [[user]] = {:me}" +
          (ws
            ? " AND (notifications.workspace = {:ws} OR notifications.workspace = '')"
            : ""),
      )
      .bind({ me: e.auth.id, ws: ws })
      .execute();
    return e.json(200, { updated: res.rowsAffected() });
  },
  $apis.requireAuth(),
);

// (10) digest cron (lead-owned): one email per user summarizing their unread notifications.
// Registered inside onBootstrap so $app is live; the tick reads everything fresh (the JSVM
// does not close over onBootstrap scope). No-op when SMTP is unwired (dev sandbox) so dev/CI
// never send. GROUP BY user => exactly one message per user with unread rows.
onBootstrap((e) => {
  e.next();
  const cronExpr = $os.getenv("DIGEST_CRON") || "0 8 * * *";
  cronAdd("g2-notification-digest", cronExpr, () => {
    try {
      const settings = $app.settings();
      if (!settings.smtp.enabled) return;
      // [[read]] bracket-quoted (reserved-ish); NULL-safe so an unset flag still counts.
      // KEEP IN SYNC (unread predicate): notifications.listRule (1785171300, 1785172400,
      // 1785174200, 1785176700), the
      // read-all route above, and this cron — what is marked read, what is counted and what the
      // inbox lists must be one set, so trashed work, work the recipient lost access to AND a
      // draft item the recipient cannot open are excluded on all three by the same
      // predicate, through each of the three item links.
      const rows = arrayOf(new DynamicModel({ userId: "", c: 0 }));
      $app
        .db()
        .newQuery(
          "SELECT [[user]] AS userId, COUNT(*) AS c FROM notifications " +
            "WHERE ([[read]] IS NULL OR [[read]] = false) AND " +
            "([[dismissed]] IS NULL OR [[dismissed]] = false) AND " +
            "(notifications.task = '' OR EXISTS (SELECT 1 FROM tasks t " +
            "WHERE t.id = notifications.task AND t.trashed = '' AND " +
            "(t.project = '' OR EXISTS (SELECT 1 FROM projects p " +
            "WHERE p.id = t.project AND p.trashed = '')) AND " +
            "EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace AND w.trashed = '' AND " +
            "(w.owner = [[notifications.user]] OR t.assignee = [[notifications.user]] OR " +
            "EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace = w.id AND " +
            "[[m.user]] = [[notifications.user]] AND m.status = 'active'))))) AND " +
            "(notifications.document = '' OR EXISTS (SELECT 1 FROM documents d " +
            "WHERE d.id = notifications.document AND d.trashed = '' AND " +
            "(d.draft = 0 OR d.author = [[notifications.user]] OR " +
            "EXISTS (SELECT 1 FROM workspaces dwo WHERE dwo.id = d.workspace AND " +
            "dwo.owner = [[notifications.user]]) OR " +
            "EXISTS (SELECT 1 FROM workspace_members dad WHERE dad.workspace = d.workspace AND " +
            "[[dad.user]] = [[notifications.user]] AND dad.role = 'admin' AND " +
            "dad.status = 'active')) AND " +
            "(d.project = '' OR EXISTS (SELECT 1 FROM projects dp " +
            "WHERE dp.id = d.project AND dp.trashed = '')) AND " +
            "EXISTS (SELECT 1 FROM workspaces dw WHERE dw.id = d.workspace AND dw.trashed = '' AND " +
            "(dw.owner = [[notifications.user]] OR " +
            "EXISTS (SELECT 1 FROM workspace_members dm WHERE dm.workspace = dw.id AND " +
            "[[dm.user]] = [[notifications.user]] AND dm.status = 'active'))))) AND " +
            "(notifications.decision = '' OR EXISTS (SELECT 1 FROM decisions dd " +
            "WHERE dd.id = notifications.decision AND dd.trashed = '' AND " +
            "(dd.draft = 0 OR dd.author = [[notifications.user]] OR " +
            "EXISTS (SELECT 1 FROM workspaces cwo WHERE cwo.id = dd.workspace AND " +
            "cwo.owner = [[notifications.user]]) OR " +
            "EXISTS (SELECT 1 FROM workspace_members cad WHERE cad.workspace = dd.workspace AND " +
            "[[cad.user]] = [[notifications.user]] AND cad.role = 'admin' AND " +
            "cad.status = 'active')) AND " +
            "(dd.project = '' OR EXISTS (SELECT 1 FROM projects cp " +
            "WHERE cp.id = dd.project AND cp.trashed = '')) AND " +
            "EXISTS (SELECT 1 FROM workspaces cw WHERE cw.id = dd.workspace AND cw.trashed = '' AND " +
            "(cw.owner = [[notifications.user]] OR " +
            "EXISTS (SELECT 1 FROM workspace_members cm WHERE cm.workspace = cw.id AND " +
            "[[cm.user]] = [[notifications.user]] AND cm.status = 'active'))))) " +
            "GROUP BY [[user]]",
        )
        .all(rows);
      for (let i = 0; i < rows.length; i++) {
        const uid = rows[i].userId;
        const count = rows[i].c;
        if (!uid || count <= 0) continue;
        let user;
        try {
          user = $app.findRecordById("users", uid);
        } catch (_) {
          continue;
        }
        const email = user.get("email");
        if (!email) continue;
        const msg = new MailerMessage({
          from: {
            address: settings.meta.senderAddress,
            name: settings.meta.senderName || "Task Tracker",
          },
          to: [{ address: email }],
          subject: "[Task Tracker] " + count + " unread notification(s)",
          text:
            "You have " + count + " unread notification(s) on Task Tracker.",
        });
        $app.newMailClient().send(msg);
      }
    } catch (err) {
      $app
        .logger()
        .error("notification digest cron failed", "error", String(err));
    }
  });
});

/// <reference path="../pb_data/types.d.ts" />
// K5 — cycles: default span, range, overlap and task-tenancy guards. ALL logic INLINED per handler
// (pooled JSVM: no shared top-level helper reachable inside a callback).

// ── DAY NORMALIZATION (registered FIRST: the defaulting and both guards below read
// the normalized values) ─────────────────────────────────────────────────────
// A cycle is a DAY object, not an instant: the date picker emits a bare day and one
// workspace runs one cycle per calendar day, so a submitted time component is dropped
// rather than making two same-day cycles representable.
// KEEP IN SYNC: the create + update handlers below are byte-parallel apart from the
// registration verb.
onRecordCreate((e) => {
  const starts = String(e.record.get("starts_on") || "");
  if (starts) {
    e.record.set("starts_on", starts.slice(0, 10) + " 00:00:00.000Z");
  }
  const ends = String(e.record.get("ends_on") || "");
  if (ends) {
    e.record.set("ends_on", ends.slice(0, 10) + " 00:00:00.000Z");
  }
  return e.next();
}, "cycles");
onRecordUpdate((e) => {
  const starts = String(e.record.get("starts_on") || "");
  if (starts) {
    e.record.set("starts_on", starts.slice(0, 10) + " 00:00:00.000Z");
  }
  const ends = String(e.record.get("ends_on") || "");
  if (ends) {
    e.record.set("ends_on", ends.slice(0, 10) + " 00:00:00.000Z");
  }
  return e.next();
}, "cycles");

// ── DEFAULT SPAN (registered after normalization so a filled span lands on midnight) ──
// Two weeks is the default duration; a caller sending ends_on keeps its own span.
onRecordCreate((e) => {
  const starts = String(e.record.get("starts_on") || "");
  if (starts && String(e.record.get("ends_on") || "") === "") {
    const from = new Date(starts.replace(" ", "T"));
    e.record.set(
      "ends_on",
      new Date(from.getTime() + 14 * 86400000).toISOString().replace("T", " "),
    );
  }
  return e.next();
}, "cycles");

// ── RANGE guard — a cycle ends strictly after it starts ──────────────────────
// The UNIVERSAL tier, not *Request: a programmatic e.app.save() from a cron or route
// fires no *Request hook and would otherwise store an impossible span.
// Only a save that changes a guarded field is judged (a new record's original() is blank).
// An empty ends_on under a set starts_on is refused here too — on create the defaulting
// hook above has already filled it, so this is the update that clears it.
// KEEP IN SYNC: the create + update handlers below are byte-parallel apart from the
// registration verb.
onRecordCreate((e) => {
  const starts = String(e.record.get("starts_on") || "");
  const ends = String(e.record.get("ends_on") || "");
  const orig = e.record.original();
  const touchesSpan =
    starts !== String(orig.get("starts_on") || "") ||
    ends !== String(orig.get("ends_on") || "");
  if (starts && touchesSpan) {
    const from = new Date(starts.replace(" ", "T")).getTime();
    const to = ends ? new Date(ends.replace(" ", "T")).getTime() : NaN;
    if (!(to > from)) {
      throw new BadRequestError("a cycle must end after the day it starts");
    }
  }
  return e.next();
}, "cycles");
onRecordUpdate((e) => {
  const starts = String(e.record.get("starts_on") || "");
  const ends = String(e.record.get("ends_on") || "");
  const orig = e.record.original();
  const touchesSpan =
    starts !== String(orig.get("starts_on") || "") ||
    ends !== String(orig.get("ends_on") || "");
  if (starts && touchesSpan) {
    const from = new Date(starts.replace(" ", "T")).getTime();
    const to = ends ? new Date(ends.replace(" ", "T")).getTime() : NaN;
    if (!(to > from)) {
      throw new BadRequestError("a cycle must end after the day it starts");
    }
  }
  return e.next();
}, "cycles");

// ── OVERLAP guard — one workspace runs one cycle at a time ───────────────────
// Automatic rollover needs an unambiguous next cycle, which overlapping spans make
// undefined (Linear allows none within a team). Boundaries are inclusive: a span may
// start the day after the previous one ends, not on it.
// Only a save that changes a guarded field is judged (a new record's original() is blank).
// KEEP IN SYNC: the create + update handlers below are byte-parallel apart from the
// registration verb.
onRecordCreate((e) => {
  const ws = e.record.get("workspace");
  const starts = String(e.record.get("starts_on") || "");
  const ends = String(e.record.get("ends_on") || "");
  const orig = e.record.original();
  const touchesOverlap =
    ws !== orig.get("workspace") ||
    starts !== String(orig.get("starts_on") || "") ||
    ends !== String(orig.get("ends_on") || "");
  if (ws && starts && ends && touchesOverlap) {
    const clash = e.app.findRecordsByFilter(
      "cycles",
      "workspace = {:w} && id != {:id} && starts_on <= {:ends} && ends_on >= {:starts}",
      "",
      1,
      0,
      { w: ws, id: e.record.id, ends: ends, starts: starts },
    );
    if (clash.length) {
      throw new BadRequestError(
        "these dates run into another cycle in this workspace: " +
          clash[0].get("name"),
      );
    }
  }
  return e.next();
}, "cycles");
onRecordUpdate((e) => {
  const ws = e.record.get("workspace");
  const starts = String(e.record.get("starts_on") || "");
  const ends = String(e.record.get("ends_on") || "");
  const orig = e.record.original();
  const touchesOverlap =
    ws !== orig.get("workspace") ||
    starts !== String(orig.get("starts_on") || "") ||
    ends !== String(orig.get("ends_on") || "");
  if (ws && starts && ends && touchesOverlap) {
    const clash = e.app.findRecordsByFilter(
      "cycles",
      "workspace = {:w} && id != {:id} && starts_on <= {:ends} && ends_on >= {:starts}",
      "",
      1,
      0,
      { w: ws, id: e.record.id, ends: ends, starts: starts },
    );
    if (clash.length) {
      throw new BadRequestError(
        "these dates run into another cycle in this workspace: " +
          clash[0].get("name"),
      );
    }
  }
  return e.next();
}, "cycles");

// ── TENANCY guard — a task may only point at a cycle of its OWN workspace ────
// The UNIVERSAL tier, not *Request: a programmatic e.app.save() fires no *Request hook
// and would otherwise store a cross-tenant pointer. A cycle has no project of its own,
// so the workspace match is the whole check.
// Only a save that changes a guarded field is judged (a new record's original() is blank).
// KEEP IN SYNC: the create + update handlers below are byte-parallel apart from the
// registration verb.
onRecordCreate((e) => {
  const cycle = e.record.get("cycle");
  const orig = e.record.original();
  const touchesTenancy =
    cycle !== orig.get("cycle") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (cycle && touchesTenancy) {
    let c = null;
    try {
      c = e.app.findRecordById("cycles", cycle);
    } catch (_) {
      c = null;
    }
    if (c === null || c.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("cycle must belong to the same workspace");
    }
  }
  return e.next();
}, "tasks");
onRecordUpdate((e) => {
  const cycle = e.record.get("cycle");
  const orig = e.record.original();
  const touchesTenancy =
    cycle !== orig.get("cycle") ||
    e.record.get("workspace") !== orig.get("workspace");
  if (cycle && touchesTenancy) {
    let c = null;
    try {
      c = e.app.findRecordById("cycles", cycle);
    } catch (_) {
      c = null;
    }
    if (c === null || c.get("workspace") !== e.record.get("workspace")) {
      throw new BadRequestError("cycle must belong to the same workspace");
    }
  }
  return e.next();
}, "tasks");

// ── ROLLOVER — unfinished work follows the workspace into the next cycle ─────
// Owner ruling 2026-09-02 (Linear's default): at cycle end, incomplete items auto-roll
// into the next cycle. A per-workspace opt-out is later work.
//
// The SWEEP below is INLINED TWICE: in the cronAdd closure (uses $app — the JSVM cannot
// close over onBootstrap's `e`) and in the POST /api/tracker/cycles/rollover handler
// (uses e.app). KEEP THE TWO BLOCKS IN SYNC — between the INLINED SWEEP markers they are
// byte-identical apart from that handle; only what follows the marker differs (a log line
// against the count, a JSON response carrying it).
onBootstrap((e) => {
  e.next();

  var cronExpr = $os.getenv("CYCLE_ROLLOVER_CRON") || "0 6 * * *";

  cronAdd("cycle-rollover", cronExpr, () => {
    // ── INLINED SWEEP (cron copy, uses $app) — KEEP IN SYNC with the route copy ──
    var rolled = 0;
    try {
      var today = new Date().toISOString().slice(0, 10) + " 00:00:00.000Z";
      var todayMs = new Date(today.replace(" ", "T")).getTime();
      // Date order is what lets ONE run catch up every ended cycle: work handed forward by
      // an earlier cycle is re-read when its destination is swept in turn.
      // Skipping the cycle also keeps a destination cycle out of a trashed workspace.
      var ended = $app.findRecordsByFilter(
        "cycles",
        "ends_on < {:today} && workspace.trashed = ''",
        "+ends_on",
        0,
        0,
        { today: today },
      );
      for (var i = 0; i < ended.length; i++) {
        // Per cycle, never one transaction: a run that fails part-way leaves a consistent
        // partial result the next run completes, and one bad row blocks no other workspace.
        try {
          var ws = ended[i].get("workspace");
          var startsMs = new Date(
            String(ended[i].get("starts_on")).replace(" ", "T"),
          ).getTime();
          var endsOn = String(ended[i].get("ends_on"));
          var endsMs = new Date(endsOn.replace(" ", "T")).getTime();
          // Trash is not a cycle state: a task that is trashed, or that sits in a trashed
          // project, stays on the cycle that ended and rolls only once it is visible again.
          var held = $app.findRecordsByFilter(
            "tasks",
            "cycle = {:c} && trashed = '' && (project = '' || (project.created != '' && project.trashed = ''))",
            "",
            0,
            0,
            {
              c: ended[i].id,
            },
          );
          // Resolved work stays behind: canceled is as resolved as completed, and carrying
          // it forward would make every later cycle accumulate abandoned work.
          // KEEP IN SYNC: the resolved half of STATUS_CATEGORIES — `completed` and `canceled` (scripts/check_constants.ts).
          var resolved = $app.findRecordsByFilter(
            "statuses",
            "workspace = {:w} && (category = 'completed' || category = 'canceled')",
            "",
            0,
            0,
            { w: ws },
          );
          var isResolved = {};
          for (var s = 0; s < resolved.length; s++)
            isResolved[resolved[s].id] = true;
          var moving = [];
          for (var h = 0; h < held.length; h++) {
            if (!isResolved[String(held[h].get("status") || "")])
              moving.push(held[h]);
          }
          // Nothing unfinished needs no destination, so an ended cycle creates none.
          if (!moving.length) continue;
          var found = $app.findRecordsByFilter(
            "cycles",
            "workspace = {:w} && starts_on > {:ends}",
            "+starts_on",
            1,
            0,
            { w: ws, ends: endsOn },
          );
          var target = found.length ? found[0] : null;
          if (target === null) {
            var spanMs = endsMs - startsMs;
            var startMs = endsMs + 86400000;
            // A destination that has itself already ended would be swept again next run, so
            // contiguous same-length spans are skipped forward until one is still running.
            while (startMs + spanMs < todayMs) startMs += spanMs + 86400000;
            var startIso = new Date(startMs).toISOString().replace("T", " ");
            var made = new Record($app.findCollectionByNameOrId("cycles"));
            made.set("workspace", ws);
            // Named for the day it starts: a placeholder a person renames, and collision-free
            // without a counter, because two cycles cannot share a calendar day.
            made.set("name", "Cycle " + startIso.slice(0, 10));
            made.set("starts_on", startIso);
            made.set(
              "ends_on",
              new Date(startMs + spanMs).toISOString().replace("T", " "),
            );
            $app.save(made);
            target = made;
          }
          for (var m = 0; m < moving.length; m++) {
            try {
              moving[m].set("cycle", target.id);
              $app.save(moving[m]);
              rolled++;
            } catch (taskErr) {
              // A swallowed failure that logged nothing would never roll and never be
              // greppable: this task sits out the sweep, no other row waits on it.
              $app
                .logger()
                .warn(
                  "cycle-rollover skipped a task",
                  "task",
                  moving[m].id,
                  "error",
                  String(taskErr),
                );
            }
          }
        } catch (cycleErr) {
          // Same, one level up: this workspace sits out the sweep, no other one waits on it.
          $app
            .logger()
            .warn(
              "cycle-rollover skipped a cycle",
              "cycle",
              ended[i].id,
              "error",
              String(cycleErr),
            );
        }
      }
    } catch (err) {
      $app.logger().error("cycle-rollover sweep failed", "error", String(err));
    }
    // ── END INLINED SWEEP (cron copy) ──
    $app.logger().info("cycle-rollover cron swept", "rolled", rolled);
  });

  e.app.logger().info("cycle-rollover cron registered", "cron", cronExpr);
});

// ── Manual trigger: POST /api/tracker/cycles/rollover (superuser only) ───────
// A daily cron cannot be waited on in the battery, so this route runs the SAME inlined
// sweep on demand and returns {rolled: <count>}. Custom routes bypass collection rules,
// so requireSuperuserAuth is the whole gate.
require(`${__hooks}/lib/routes.js`).add(
  "POST /api/tracker/cycles/rollover",
  (e) => {
    // ── INLINED SWEEP (route copy, uses e.app) — KEEP IN SYNC with the cron copy ──
    var rolled = 0;
    try {
      var today = new Date().toISOString().slice(0, 10) + " 00:00:00.000Z";
      var todayMs = new Date(today.replace(" ", "T")).getTime();
      // Date order is what lets ONE run catch up every ended cycle: work handed forward by
      // an earlier cycle is re-read when its destination is swept in turn.
      // Skipping the cycle also keeps a destination cycle out of a trashed workspace.
      var ended = e.app.findRecordsByFilter(
        "cycles",
        "ends_on < {:today} && workspace.trashed = ''",
        "+ends_on",
        0,
        0,
        { today: today },
      );
      for (var i = 0; i < ended.length; i++) {
        // Per cycle, never one transaction: a run that fails part-way leaves a consistent
        // partial result the next run completes, and one bad row blocks no other workspace.
        try {
          var ws = ended[i].get("workspace");
          var startsMs = new Date(
            String(ended[i].get("starts_on")).replace(" ", "T"),
          ).getTime();
          var endsOn = String(ended[i].get("ends_on"));
          var endsMs = new Date(endsOn.replace(" ", "T")).getTime();
          // Trash is not a cycle state: a task that is trashed, or that sits in a trashed
          // project, stays on the cycle that ended and rolls only once it is visible again.
          var held = e.app.findRecordsByFilter(
            "tasks",
            "cycle = {:c} && trashed = '' && (project = '' || (project.created != '' && project.trashed = ''))",
            "",
            0,
            0,
            {
              c: ended[i].id,
            },
          );
          // Resolved work stays behind: canceled is as resolved as completed, and carrying
          // it forward would make every later cycle accumulate abandoned work.
          // KEEP IN SYNC: the resolved half of STATUS_CATEGORIES — `completed` and `canceled` (scripts/check_constants.ts).
          var resolved = e.app.findRecordsByFilter(
            "statuses",
            "workspace = {:w} && (category = 'completed' || category = 'canceled')",
            "",
            0,
            0,
            { w: ws },
          );
          var isResolved = {};
          for (var s = 0; s < resolved.length; s++)
            isResolved[resolved[s].id] = true;
          var moving = [];
          for (var h = 0; h < held.length; h++) {
            if (!isResolved[String(held[h].get("status") || "")])
              moving.push(held[h]);
          }
          // Nothing unfinished needs no destination, so an ended cycle creates none.
          if (!moving.length) continue;
          var found = e.app.findRecordsByFilter(
            "cycles",
            "workspace = {:w} && starts_on > {:ends}",
            "+starts_on",
            1,
            0,
            { w: ws, ends: endsOn },
          );
          var target = found.length ? found[0] : null;
          if (target === null) {
            var spanMs = endsMs - startsMs;
            var startMs = endsMs + 86400000;
            // A destination that has itself already ended would be swept again next run, so
            // contiguous same-length spans are skipped forward until one is still running.
            while (startMs + spanMs < todayMs) startMs += spanMs + 86400000;
            var startIso = new Date(startMs).toISOString().replace("T", " ");
            var made = new Record(e.app.findCollectionByNameOrId("cycles"));
            made.set("workspace", ws);
            // Named for the day it starts: a placeholder a person renames, and collision-free
            // without a counter, because two cycles cannot share a calendar day.
            made.set("name", "Cycle " + startIso.slice(0, 10));
            made.set("starts_on", startIso);
            made.set(
              "ends_on",
              new Date(startMs + spanMs).toISOString().replace("T", " "),
            );
            e.app.save(made);
            target = made;
          }
          for (var m = 0; m < moving.length; m++) {
            try {
              moving[m].set("cycle", target.id);
              e.app.save(moving[m]);
              rolled++;
            } catch (taskErr) {
              // A swallowed failure that logged nothing would never roll and never be
              // greppable: this task sits out the sweep, no other row waits on it.
              e.app
                .logger()
                .warn(
                  "cycle-rollover skipped a task",
                  "task",
                  moving[m].id,
                  "error",
                  String(taskErr),
                );
            }
          }
        } catch (cycleErr) {
          // Same, one level up: this workspace sits out the sweep, no other one waits on it.
          e.app
            .logger()
            .warn(
              "cycle-rollover skipped a cycle",
              "cycle",
              ended[i].id,
              "error",
              String(cycleErr),
            );
        }
      }
    } catch (err) {
      e.app.logger().error("cycle-rollover sweep failed", "error", String(err));
    }
    // ── END INLINED SWEEP (route copy) ──
    return e.json(200, { rolled: rolled });
  },
);

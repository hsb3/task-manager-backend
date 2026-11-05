/// <reference path="../pb_data/types.d.ts" />
// decision:shadow-project — every workspace owns one invisible shadow project, and an item with no project lands in it.

// Universal after-create tier, so the workspace created by ANY path is covered: the three
// programmatic provision blocks (main.pb.js users-create, main.pb.js last-workspace,
// trash.pb.js last-workspace-trash) all reach here through their own e.app.save(ws), the same
// way the vocab seeder in main.pb.js does; a direct API POST reaches it too.
//
// The whole body NEVER throws: this tier also fires for a migration's own e.app.save(), and a
// throw there aborts the boot with `failed to apply migration`.
onRecordAfterCreateSuccess((e) => {
  try {
    try {
      // Guarded find-first: a re-fire must leave exactly one shadow project per workspace.
      e.app.findFirstRecordByFilter(
        "projects",
        "workspace = {:w} && shadow = true",
        {
          w: e.record.id,
        },
      );
    } catch (_) {
      const projCol = e.app.findCollectionByNameOrId("pbc_484305853"); // projects
      const proj = new Record(projCol);
      proj.set("name", "Workspace items");
      proj.set("owner", e.record.get("owner"));
      proj.set("workspace", e.record.id);
      proj.set("shadow", true);
      e.app.save(proj);
    }
  } catch (err) {
    e.app
      .logger()
      .error(
        "shadow project provision failed",
        "workspace",
        e.record.id,
        "err",
        String(err),
      );
  }
  e.next();
}, "workspaces");

// Never throws — an unresolvable shadow project leaves the item where it is rather than
// refusing a write the rules already admitted. A create that carries neither project nor
// workspace is one of those: nothing to resolve against, so it passes through untouched.
// Find-or-CREATE, not find-or-give-up: a workspace whose container was deleted would
// otherwise regress to holding project-less items forever.
function landInShadowProject(e) {
  const wsId = e.record.get("workspace");
  if (!e.record.get("project") && wsId) {
    try {
      let shadow = null;
      try {
        shadow = e.app.findFirstRecordByFilter(
          "projects",
          "workspace = {:w} && shadow = true",
          { w: wsId },
        );
      } catch (_) {
        const projCol = e.app.findCollectionByNameOrId("pbc_484305853"); // projects
        shadow = new Record(projCol);
        shadow.set("name", "Workspace items");
        shadow.set(
          "owner",
          e.app.findRecordById("workspaces", wsId).get("owner"),
        );
        shadow.set("workspace", wsId);
        shadow.set("shadow", true);
        e.app.save(shadow);
      }
      e.record.set("project", shadow.id);
    } catch (err) {
      // Logged, not refused (mwf4): a programmatic create whose container save failed must
      // still be written, and the empty project self-heals on the item's next save.
      e.app
        .logger()
        .error(
          "shadow project placement failed",
          "collection",
          e.record.collection().name,
          "record",
          e.record.id,
          "workspace",
          wsId,
          "err",
          String(err),
        );
    }
  }
  return e.next();
}
// Universal tier: a programmatic create (seed, cron, route handler) never reaches the request
// tier, and a request-tier copy would be a coin flip — PocketBase does not order two files'
// request handlers deterministically (measured: 6 identical boots, 5 one way, 1 the other).
onRecordCreate(landInShadowProject, "tasks");
onRecordCreate(landInShadowProject, "decisions");
onRecordCreate(landInShadowProject, "documents");
onRecordCreate(landInShadowProject, "milestones");
onRecordUpdate(landInShadowProject, "tasks");
onRecordUpdate(landInShadowProject, "decisions");
onRecordUpdate(landInShadowProject, "documents");
onRecordUpdate(landInShadowProject, "milestones");

// Request tier, so it sees ONLY what the client submitted: the placement above runs on the
// universal tier afterwards and must stay free to write the same id.
function refuseSubmittedShadowProject(e) {
  const p = e.record.get("project");
  // Only a CHANGE is a choice: an item already living there is edited like any other, and on
  // create the original is empty so any container id here came from the client.
  if (p && p !== e.record.original().get("project")) {
    let proj = null;
    try {
      proj = e.app.findRecordById("projects", p);
    } catch (_) {
      proj = null;
    }
    if (proj && proj.get("shadow")) {
      throw new BadRequestError(
        "that project cannot be chosen here; pick one from the project list",
      );
    }
  }
  return e.next();
}
onRecordCreateRequest(refuseSubmittedShadowProject, "tasks");
onRecordCreateRequest(refuseSubmittedShadowProject, "decisions");
onRecordCreateRequest(refuseSubmittedShadowProject, "documents");
onRecordCreateRequest(refuseSubmittedShadowProject, "milestones");
onRecordUpdateRequest(refuseSubmittedShadowProject, "tasks");
onRecordUpdateRequest(refuseSubmittedShadowProject, "decisions");
onRecordUpdateRequest(refuseSubmittedShadowProject, "documents");
onRecordUpdateRequest(refuseSubmittedShadowProject, "milestones");

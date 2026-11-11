/// <reference path="../pb_data/types.d.ts" />
// Collection rules apply a limited API key's reach from the headers only the key middleware sets (decision:api-key-reach-and-levels).
const KW = "@request.headers.x_tm_key_workspace";
const KP = "@request.headers.x_tm_key_projects";
const HEAD = '@request.auth.id != "" && (';
const C_WS = `(${KW} = "" || workspace = ${KW})`;
const C_ID = `(${KW} = "" || id = ${KW})`;
const C_INV = `(${KW} = "" || (workspace = ${KW} && ${KP} = ""))`;
const C_PROJ = `(${KW} = "" || (workspace = ${KW} && (${KP} = "" || ${KP} ~ id)))`;
const C_ITEM = `(${KW} = "" || (workspace = ${KW} && (${KP} = "" || (project != "" && ${KP} ~ project))))`;
const C_ITEM_CREATE = `(${KW} = "" || ((workspace = ${KW} || (workspace = "" && project.workspace = ${KW})) && (${KP} = "" || (project != "" && ${KP} ~ project))))`;
const C_ITEM_UPDATE = `(${KW} = "" || (workspace = ${KW} && (@request.body.workspace:isset = false || @request.body.workspace = ${KW}) && (${KP} = "" || (project != "" && ${KP} ~ project && (@request.body.project:isset = false || (@request.body.project != "" && ${KP} ~ @request.body.project))))))`;
const C_COMMENT = `(${KW} = "" || (task != "" && task.workspace = ${KW} && (${KP} = "" || (task.project != "" && ${KP} ~ task.project))) || (document != "" && document.workspace = ${KW} && (${KP} = "" || (document.project != "" && ${KP} ~ document.project))) || (decision != "" && decision.workspace = ${KW} && (${KP} = "" || (decision.project != "" && ${KP} ~ decision.project))))`;
const C_TASK = `(${KW} = "" || (task.workspace = ${KW} && (${KP} = "" || (task.project != "" && ${KP} ~ task.project))))`;
const C_ACTIVITY = `(${KW} = "" || (task != "" && task.workspace = ${KW} && (${KP} = "" || (task.project != "" && ${KP} ~ task.project))) || (task = "" && workspace = ${KW} && ${KP} = ""))`;
const C_NOTIF = `(${KW} = "" || (workspace = ${KW} && (${KP} = "" || (task != "" && task.project != "" && ${KP} ~ task.project) || (document != "" && document.project != "" && ${KP} ~ document.project) || (decision != "" && decision.project != "" && ${KP} ~ decision.project))))`;

const all4 = (read, create, update, del) => ({
  listRule: read,
  viewRule: read,
  createRule: create,
  updateRule: update,
  deleteRule: del,
});
const ITEM = all4(C_ITEM, C_ITEM_CREATE, C_ITEM_UPDATE, C_ITEM);
const PLAN = {
  workspaces: { listRule: C_ID, viewRule: C_ID, updateRule: C_ID, deleteRule: C_ID },
  workspace_members: all4(C_WS, null, C_WS, C_WS),
  workspace_invitations: all4(C_INV, C_INV, null, C_INV),
  labels: all4(C_WS, C_WS, C_WS, C_WS),
  statuses: all4(C_WS, C_WS, C_WS, C_WS),
  cycles: all4(C_WS, C_WS, C_WS, C_WS),
  projects: all4(C_PROJ, C_PROJ, C_PROJ, C_PROJ),
  tasks: ITEM,
  decisions: ITEM,
  documents: ITEM,
  milestones: ITEM,
  templates: all4(C_ITEM, C_ITEM, C_ITEM_UPDATE, C_ITEM),
  saved_views: all4(C_ITEM, C_ITEM, C_ITEM_UPDATE, C_ITEM),
  comments: all4(C_COMMENT, C_COMMENT, C_COMMENT, C_COMMENT),
  task_subscribers: all4(C_TASK, C_TASK, null, C_TASK),
  task_activity: all4(C_ACTIVITY, null, null, null),
  notifications: all4(C_NOTIF, null, C_NOTIF, null),
  project_items: { listRule: C_ITEM, viewRule: C_ITEM },
  project_stats: { listRule: C_PROJ, viewRule: C_PROJ },
};

migrate(
  (app) => {
    for (const name of Object.keys(PLAN)) {
      const c = app.findCollectionByNameOrId(name);
      for (const rule of Object.keys(PLAN[name])) {
        const clause = PLAN[name][rule];
        if (clause === null || c[rule] === null) continue;
        c[rule] = HEAD + c[rule] + ") && " + clause;
      }
      app.save(c);
    }
  },
  (app) => {
    for (const name of Object.keys(PLAN)) {
      const c = app.findCollectionByNameOrId(name);
      for (const rule of Object.keys(PLAN[name])) {
        const clause = PLAN[name][rule];
        if (clause === null || c[rule] === null) continue;
        const r = String(c[rule]);
        const tail = ") && " + clause;
        if (r.startsWith(HEAD) && r.endsWith(tail))
          c[rule] = r.slice(HEAD.length, r.length - tail.length);
      }
      app.save(c);
    }
  },
);

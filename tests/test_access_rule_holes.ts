#!/usr/bin/env bun
/**
 * decision:active-membership-grants-access holes (kata vc8g): being a task's assignee confers nothing
 * an ACTIVE, role-qualified membership does not. A SUSPENDED assignee (H1) reads, writes, comments,
 * reacts, subscribes, sees activity, notifications, project_items and search hits for their task
 * no more than a stranger; an ACTIVE VIEWER assignee (H2) reads their task but writes nothing
 * through it; project_stats (H4) admits the workspace owner and active members, never a suspended or
 * removed project creator. Regression pins: a suspended author keeps no write on their document,
 * decision or milestone, and two `?=` conditions over one back-relation bind the SAME row (a plain
 * member beside some admin gains no admin write; a suspended member beside some active member
 * gains no read).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures made by the
 * superuser. Port 8156 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8156 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  return [r.status, raw.length ? JSON.parse(text) : {}]; // 204 -> empty body
}

const rec = (coll: string, id = "") => `/api/collections/${coll}/records${id ? `/${id}` : ""}`;

// (status, ids) of a filtered list — a denied list is 200 with no items.
async function list_ids(coll: string, filt: string, token: string): Promise<[number, string[]]> {
  const [s, r] = await api(
    "GET",
    `${rec(coll)}?${urlencode({ filter: filt, perPage: 200 })}`,
    token,
  );
  return [s, (r.items || []).map((i: any) => i.id)];
}

async function su_make(su: string, coll: string, body: any, what: string): Promise<any> {
  const [s, r] = await api("POST", rec(coll), su, body);
  if (s !== 200) throw new roomkit.SystemExit(`fixture ${what}: HTTP ${s} ${py_str(r)}`);
  return r;
}

async function as_make(tok: string, coll: string, body: any, what: string): Promise<any> {
  const [s, r] = await api("POST", rec(coll), tok, body);
  check(`(fixture) ${what} → 200`, s, 200);
  if (s !== 200) throw new roomkit.SystemExit(`fixture ${what}: HTTP ${s} ${py_str(r)}`);
  return r;
}

async function login(email: string): Promise<string> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: PASSWORD,
  });
  return getitem(r, "token");
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-access-rule-holes-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  run_checked(
    [
      PB_BIN,
      "superuser",
      "upsert",
      SU_EMAIL,
      SU_PASSWORD,
      "--dir",
      DATA_DIR,
      "--migrationsDir",
      MIG_DIR,
    ],
    { cwd: REPO_ROOT, capture_output: true },
  );
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const su = await superuser_token();
  tierkit.use(api);

  console.log("\n── fixtures: one workspace, owner + six members ──");
  const ids: Record<string, string> = {};
  const tok: Record<string, string> = {};
  for (const name of ["Olive", "Sam", "Vic", "Mia", "Ada", "Pete", "Rex"]) {
    const email = `${name.toLowerCase()}@example.com`;
    const u = await su_make(
      su,
      "users",
      {
        email,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        name,
        verified: true,
        approved: true,
      },
      `user ${name}`,
    );
    ids[name] = u.id;
    tok[name] = await login(email);
  }
  const [, wsl] = await api(
    "GET",
    `${rec("workspaces")}?${urlencode({ filter: `owner='${ids.Olive}'` })}`,
    su,
  );
  const W: string = getitem(wsl.items[0], "id");
  const [, pl] = await api(
    "GET",
    `${rec("projects")}?${urlencode({ filter: `workspace='${W}' && shadow=false` })}`,
    su,
  );
  const PRJ: string = getitem(pl.items[0], "id");
  const [, stl] = await api(
    "GET",
    `${rec("statuses")}?${urlencode({ filter: `workspace='${W}' && name='Todo'` })}`,
    su,
  );
  const TODO: string = getitem(stl.items[0], "id");
  const ROW: Record<string, string> = {};
  for (const [name, role] of [
    ["Sam", "member"],
    ["Vic", "viewer"],
    ["Mia", "member"],
    ["Ada", "admin"],
    ["Pete", "member"],
    ["Rex", "member"],
  ] as const) {
    ROW[name] = (
      await su_make(
        su,
        "workspace_members",
        { workspace: W, user: ids[name], role, status: "active" },
        `${name} membership`,
      )
    ).id;
  }
  const olive = tok.Olive!;
  const sam = tok.Sam!;
  const vic = tok.Vic!;
  const mia = tok.Mia!;
  const ada = tok.Ada!;
  const pete = tok.Pete!;
  const rex = tok.Rex!;

  const TAG = "zqholetag";
  const T_S = (
    await as_make(
      olive,
      "tasks",
      { title: `sam task ${TAG}`, status: TODO, project: PRJ, assignee: ids.Sam },
      "Olive creates a task assigned to Sam",
    )
  ).id;
  const T_V = (
    await as_make(
      olive,
      "tasks",
      { title: "vic task", status: TODO, project: PRJ, assignee: ids.Vic },
      "Olive creates a task assigned to Vic (an ACTIVE VIEWER; the assignee hook admits any active member)",
    )
  ).id;
  await as_make(
    olive,
    "tasks",
    { title: "unrelated task", status: TODO, project: PRJ },
    "Olive creates an unassigned task",
  );
  let s: number;
  let r: any;
  [s] = await api("PATCH", rec("tasks", T_S), olive, { title: `sam task renamed ${TAG}` });
  check("(fixture) Olive renames Sam's task (writes a task_activity row)", s, 200);
  const C_O = (
    await as_make(
      olive,
      "comments",
      { task: T_S, body: "olive on sam task" },
      "Olive comments on Sam's task",
    )
  ).id;
  const C_OV = (
    await as_make(
      olive,
      "comments",
      { task: T_V, body: "olive on vic task" },
      "Olive comments on Vic's task",
    )
  ).id;
  const C_S = (
    await as_make(
      sam,
      "comments",
      { task: T_S, body: "sam on own task" },
      "Sam (active) comments on his task",
    )
  ).id;
  const DOC = (
    await as_make(
      sam,
      "documents",
      { workspace: W, project: PRJ, title: "sam doc" },
      "Sam (active) authors a document",
    )
  ).id;
  const DEC = (
    await as_make(
      sam,
      "decisions",
      { workspace: W, project: PRJ, title: "sam decision" },
      "Sam (active) authors a decision",
    )
  ).id;
  const MIL = (
    await as_make(
      sam,
      "milestones",
      { workspace: W, project: PRJ, name: "sam milestone" },
      "Sam (active) authors a milestone",
    )
  ).id;
  const N = (
    await su_make(
      su,
      "notifications",
      { user: ids.Sam, task: T_S, workspace: W, kind: "commented" },
      "notification for Sam on his task",
    )
  ).id;
  const N_V = (
    await su_make(
      su,
      "notifications",
      { user: ids.Vic, task: T_V, workspace: W, kind: "commented" },
      "notification for Vic on his task",
    )
  ).id;
  const N_VD = (
    await su_make(
      su,
      "notifications",
      { user: ids.Vic, task: T_V, workspace: W, kind: "commented", dismissed: true },
      "dismissed notification for Vic on his task",
    )
  ).id;
  const own_ws = async (who: string): Promise<string> => {
    const [, l] = await api(
      "GET",
      `${rec("workspaces")}?${urlencode({ filter: `owner='${ids[who]}'` })}`,
      su,
    );
    return getitem(l.items[0], "id");
  };
  const W_SAM = await own_ws("Sam");
  const W_VIC = await own_ws("Vic");
  // The notification ids an export carries, plus its status.
  const exported_notifs = async (tk: string, ws: string): Promise<[number, string[]]> => {
    const [st, body] = await api("POST", "/api/tracker/export", tk, {
      workspace: ws,
      collections: ["notifications"],
    });
    return [st, ((body.data || {}).notifications || []).map((n: any) => n.id)];
  };
  const PP = (
    await as_make(
      pete,
      "projects",
      { workspace: W, name: "pete project" },
      "Pete (member) creates a project",
    )
  ).id;
  const PR = (
    await as_make(
      rex,
      "projects",
      { workspace: W, name: "rex project" },
      "Rex (member) creates a project",
    )
  ).id;
  for (const [proj, who] of [
    [PP, "Pete"],
    [PR, "Rex"],
  ] as const) {
    await as_make(
      olive,
      "tasks",
      { title: `task in ${who} project`, status: TODO, project: proj },
      `Olive adds a task to ${who}'s project`,
    );
  }

  // Assignees are auto-subscribed; drop those rows so a subscribe attempt cannot 400 on the unique index.
  for (const [who, task] of [
    ["Sam", T_S],
    ["Vic", T_V],
  ] as const) {
    const [, subs] = await list_ids("task_subscribers", `task='${task}' && user='${ids[who]}'`, su);
    for (const id of subs) await api("DELETE", rec("task_subscribers", id), su);
    check(
      `(fixture) ${who} holds no subscription row on his task`,
      (await list_ids("task_subscribers", `task='${task}' && user='${ids[who]}'`, su))[1].length,
      0,
    );
  }
  check(
    "(fixture) superuser sees task_activity on Sam's task",
    (await list_ids("task_activity", `task='${T_S}'`, su))[1].length > 0,
    true,
  );
  check(
    "(fixture) superuser sees a subscriber row on Sam's task",
    (await list_ids("task_subscribers", `task='${T_S}'`, su))[1].length > 0,
    true,
  );

  // COVERS: rule:tasks.view, rule:notifications.view, rule:project_items.view, rule:project_stats.view
  console.log(
    "\n── controls while every member is ACTIVE (the denials below are suspension, not fixture) ──",
  );
  const sam_active = await tierkit.actor_at_tier(W, ids.Sam!, "member", su, "Sam");
  [s] = await api("GET", rec("tasks", T_S), sam);
  check(
    "control: Sam (active) views his task → 200",
    tup(await sam_active.now(), s),
    tup("member", 200),
  );
  [s] = await api("GET", rec("notifications", N), sam);
  check("control: Sam (active) views his notification → 200", s, 200);
  [s] = await api("GET", rec("project_items", T_S), sam);
  check("control: Sam (active) views his task through project_items → 200", s, 200);
  [s, r] = await api("GET", `/api/tracker/search?${urlencode({ q: TAG })}`, sam);
  check(
    "control: Sam (active) finds his task in search",
    tup(
      s,
      (r.results || []).some((x: any) => x.id === T_S),
    ),
    tup(200, true),
  );
  [s] = await api("GET", rec("documents", DOC), sam);
  check("control: Sam (active) views his document → 200", s, 200);
  check(
    "control: Sam (active) exporting HIS OWN workspace carries his notification from W",
    tup(await sam_active.now(), (await exported_notifs(sam, W_SAM))[1].includes(N)),
    tup("member", true),
  );
  [s] = await api("GET", rec("project_stats", PP), pete);
  check("control: Pete (active) views his project's stats → 200", s, 200);
  [s] = await api("GET", rec("project_stats", PR), rex);
  check("control: Rex (active) views his project's stats → 200", s, 200);
  await sam_active.done();

  [s] = await api("PATCH", rec("workspace_members", ROW.Sam), su, { status: "suspended" });
  check("(fixture) superuser suspends Sam", s, 200);
  [s] = await api("PATCH", rec("workspace_members", ROW.Pete), su, { status: "suspended" });
  check("(fixture) superuser suspends Pete", s, 200);
  [s] = await api("DELETE", rec("workspace_members", ROW.Rex), su);
  check("(fixture) superuser removes Rex", s, 204);
  [s, r] = await api("GET", rec("tasks", T_S), su);
  check("(fixture) Sam is still the stored assignee after his suspension", r.assignee, ids.Sam);

  const sam_t = await tierkit.actor_at_tier(W, ids.Sam!, "member", su, "Sam", "suspended");
  const SUS = tup("member", "suspended");
  const sam_says = async (st: number) => tup(tup(...(await sam_t.standing())), st);

  // COVERS: rule:tasks.update, rule:tasks.view, rule:tasks.list
  console.log("\n── H1: a SUSPENDED assignee and his task ──");
  [s] = await api("PATCH", rec("tasks", T_S), sam, { description: "suspended write" });
  check(
    "H1 tasks.update: suspended assignee PATCHes his task → 404",
    await sam_says(s),
    tup(SUS, 404),
  );
  [s] = await api("GET", rec("tasks", T_S), sam);
  check("H1 tasks.view: suspended assignee views his task → 404", await sam_says(s), tup(SUS, 404));
  check(
    "H1 tasks.list: suspended assignee lists his task → 200 empty",
    await list_ids("tasks", `id='${T_S}'`, sam),
    tup(200, []),
  );

  [s] = await api("POST", rec("task_subscribers"), sam, { task: T_S, user: ids.Sam });
  check(
    "H1 task_subscribers.create: suspended assignee subscribes → 400",
    await sam_says(s),
    tup(SUS, 400),
  );
  // A comment auto-subscribes its author, so the subscribe attempt runs BEFORE any comment create.
  // COVERS: rule:comments.create, rule:comments.update, rule:comments.delete
  [s] = await api("POST", rec("comments"), sam, { task: T_S, body: "suspended comment" });
  check(
    "H1 comments.create: suspended assignee comments on his task → 400",
    await sam_says(s),
    tup(SUS, 400),
  );
  [s] = await api("PATCH", rec("comments", C_S), sam, { body: "suspended edit" });
  check(
    "H1 comments.update: suspended assignee edits HIS OWN comment → 404",
    await sam_says(s),
    tup(SUS, 404),
  );
  [s] = await api("PATCH", rec("comments", C_O), sam, { reactions: { "👍": [ids.Sam] } });
  check(
    "H1 comments.update (reactions): suspended assignee reacts → 404",
    await sam_says(s),
    tup(SUS, 404),
  );
  [s] = await api("DELETE", rec("comments", C_S), sam);
  check(
    "H1 comments.delete: suspended assignee deletes HIS OWN comment → 404",
    await sam_says(s),
    tup(SUS, 404),
  );
  check(
    "H1 comments.list: suspended assignee lists his task's comments → 200 empty",
    await list_ids("comments", `task='${T_S}'`, sam),
    tup(200, []),
  );

  // COVERS: rule:task_subscribers.create, rule:task_subscribers.list, rule:task_activity.list
  check(
    "H1 task_subscribers.list: suspended assignee lists his task's subscribers → 200 empty",
    await list_ids("task_subscribers", `task='${T_S}'`, sam),
    tup(200, []),
  );
  check(
    "H1 task_activity.list: suspended assignee lists his task's activity → 200 empty",
    await list_ids("task_activity", `task='${T_S}'`, sam),
    tup(200, []),
  );

  // COVERS: rule:notifications.list, rule:notifications.view, rule:notifications.update
  check(
    "H1 notifications.list: suspended assignee lists his task notification → 200 empty",
    await list_ids("notifications", `id='${N}'`, sam),
    tup(200, []),
  );
  [s] = await api("GET", rec("notifications", N), sam);
  check(
    "H1 notifications.view: suspended assignee views it → 404",
    await sam_says(s),
    tup(SUS, 404),
  );
  [s] = await api("PATCH", rec("notifications", N), sam, { read: true });
  check(
    "H1 notifications.update: suspended assignee marks it read → 404",
    await sam_says(s),
    tup(SUS, 404),
  );

  // COVERS: route:tracker-export
  for (const [where, ws, st] of [
    ["HIS OWN workspace", W_SAM, 200],
    ["W", W, 404],
  ] as const) {
    const [es, got] = await exported_notifs(sam, ws);
    check(
      `H1 export of ${where}: suspended assignee's export carries no notification from W`,
      tup(await sam_says(es), got.includes(N)),
      tup(tup(SUS, st), false),
    );
  }

  // COVERS: rule:project_items.view, rule:project_items.list, route:tracker-search
  [s] = await api("GET", rec("project_items", T_S), sam);
  check(
    "H1 project_items.view: suspended assignee views his task item → 404",
    await sam_says(s),
    tup(SUS, 404),
  );
  check(
    "H1 project_items.list: suspended assignee lists his task item → 200 empty",
    await list_ids("project_items", `id='${T_S}'`, sam),
    tup(200, []),
  );
  [s, r] = await api("GET", `/api/tracker/search?${urlencode({ q: TAG })}`, sam);
  check(
    "H1 search: suspended assignee no longer finds his task",
    tup(
      s,
      (r.results || []).some((x: any) => x.id === T_S),
    ),
    tup(200, false),
  );

  // COVERS: rule:documents.update, rule:documents.delete, rule:decisions.update, rule:decisions.delete, rule:milestones.update, rule:milestones.delete
  console.log("\n── sibling pins: a SUSPENDED author and his document / decision / milestone ──");
  for (const [coll, id, field] of [
    ["documents", DOC, "title"],
    ["decisions", DEC, "title"],
    ["milestones", MIL, "name"],
  ] as const) {
    [s] = await api("PATCH", rec(coll, id), sam, { [field]: "suspended edit" });
    check(
      `pin ${coll}.update: suspended author edits his ${coll} row → 404`,
      await sam_says(s),
      tup(SUS, 404),
    );
    [s] = await api("DELETE", rec(coll, id), sam);
    check(
      `pin ${coll}.delete: suspended author deletes his ${coll} row → 404`,
      await sam_says(s),
      tup(SUS, 404),
    );
  }

  // COVERS: rule:projects.list, rule:workspaces.view
  console.log("\n── co-binding: a SUSPENDED member beside ACTIVE members reads nothing ──");
  const mia_t = await tierkit.actor_at_tier(W, ids.Mia!, "member", su, "Mia");
  check(
    "control: Mia (active member) lists the workspace's projects (non-empty)",
    (await list_ids("projects", `workspace='${W}'`, mia))[1].length > 0,
    true,
  );
  [s] = await api("GET", rec("workspaces", W), mia);
  check(
    "control: Mia (active member) views the workspace → 200",
    tup(await mia_t.now(), s),
    tup("member", 200),
  );
  check(
    "co-bind projects.list: suspended Sam lists the workspace's projects → 200 empty",
    await list_ids("projects", `workspace='${W}'`, sam),
    tup(200, []),
  );
  [s] = await api("GET", rec("workspaces", W), sam);
  check(
    "co-bind workspaces.view: suspended Sam views the workspace → 404",
    await sam_says(s),
    tup(SUS, 404),
  );
  await sam_t.done();

  // COVERS: rule:labels.create, rule:workspace_invitations.create, rule:cycles.create
  console.log("\n── co-binding: a plain MEMBER beside an ADMIN gains no admin write ──");
  const ada_t = await tierkit.actor_at_tier(W, ids.Ada!, "admin", su, "Ada");
  const ADMIN_WRITES: [string, (who: string) => any][] = [
    ["labels", (who) => ({ workspace: W, name: `label by ${who}` })],
    [
      "workspace_invitations",
      (who) => ({ workspace: W, email: `invitee-${who}@example.com`, role: "member" }),
    ],
    [
      "cycles",
      (who) => ({ workspace: W, name: `cycle by ${who}`, starts_on: "2026-04-01 00:00:00.000Z" }),
    ],
  ];
  for (const [coll, body] of ADMIN_WRITES) {
    [s] = await api("POST", rec(coll), ada, body("ada"));
    check(
      `control: Ada (admin) creates ${coll} → 200`,
      tup(await ada_t.now(), s),
      tup("admin", 200),
    );
    [s] = await api("POST", rec(coll), mia, body("mia"));
    check(
      `co-bind ${coll}.create: Mia (member, workspace has an admin) → 400`,
      tup(await mia_t.now(), s),
      tup("member", 400),
    );
  }
  await ada_t.done();
  await mia_t.done();

  // COVERS: rule:tasks.update, rule:comments.create, rule:comments.update, rule:task_subscribers.create, rule:tasks.create
  console.log("\n── H2: an ACTIVE VIEWER assignee reads but never writes through his task ──");
  const vic_t = await tierkit.actor_at_tier(W, ids.Vic!, "viewer", su, "Vic");
  [s] = await api("GET", rec("tasks", T_V), vic);
  check(
    "H2 tasks.view: viewer assignee still views his task → 200",
    tup(await vic_t.now(), s),
    tup("viewer", 200),
  );
  [s] = await api("PATCH", rec("tasks", T_V), vic, { description: "viewer write" });
  check(
    "H2 tasks.update: viewer assignee PATCHes his task → 404",
    tup(await vic_t.now(), s),
    tup("viewer", 404),
  );
  [s] = await api("POST", rec("task_subscribers"), vic, { task: T_V, user: ids.Vic });
  check(
    "H2 task_subscribers.create: viewer assignee subscribes → 400",
    tup(await vic_t.now(), s),
    tup("viewer", 400),
  );
  [s] = await api("POST", rec("comments"), vic, { task: T_V, body: "viewer comment" });
  check(
    "H2 comments.create: viewer assignee comments on his task → 400",
    tup(await vic_t.now(), s),
    tup("viewer", 400),
  );
  [s] = await api("PATCH", rec("comments", C_OV), vic, { reactions: { "👍": [ids.Vic] } });
  check(
    "H2 comments.update (reactions): viewer assignee reacts → 404",
    tup(await vic_t.now(), s),
    tup("viewer", 404),
  );
  [s] = await api("POST", rec("tasks"), vic, {
    title: "viewer subtask",
    status: TODO,
    project: PRJ,
    parent: T_V,
  });
  check(
    "H2 tasks.create (parent): viewer assignee creates a subtask under his task → 400",
    tup(await vic_t.now(), s),
    tup("viewer", 400),
  );
  // COVERS: route:tracker-export
  for (const [where, ws] of [
    ["W", W],
    ["HIS OWN workspace", W_VIC],
  ] as const) {
    const [es, got] = await exported_notifs(vic, ws);
    check(
      `control: Vic (active) export of ${where} carries his notification, not the dismissed one`,
      tup(await vic_t.now(), es, got.includes(N_V), got.includes(N_VD)),
      tup("viewer", 200, true, false),
    );
  }
  await vic_t.done();

  // COVERS: rule:project_stats.view, rule:project_stats.list
  console.log(
    "\n── H4: project_stats admits the workspace owner and active members, never a lapsed creator ──",
  );
  const PETE_SUS = tup("member", "suspended");
  const pete_t = await tierkit.actor_at_tier(W, ids.Pete!, "member", su, "Pete", "suspended");
  [s] = await api("GET", rec("project_stats", PP), pete);
  check(
    "H4 project_stats.view: suspended creator views his project's stats → 404",
    tup(tup(...(await pete_t.standing())), s),
    tup(PETE_SUS, 404),
  );
  check(
    "H4 project_stats.list: suspended creator lists them → 200 empty",
    await list_ids("project_stats", `id='${PP}'`, pete),
    tup(200, []),
  );
  await pete_t.done();
  check(
    "(fixture) Rex holds no membership row",
    (await list_ids("workspace_members", `workspace='${W}' && user='${ids.Rex}'`, su))[1].length,
    0,
  );
  [s] = await api("GET", rec("project_stats", PR), rex);
  check("H4 project_stats.view: removed creator views his project's stats → 404", s, 404);
  check(
    "H4 project_stats.list: removed creator lists them → 200 empty",
    await list_ids("project_stats", `id='${PR}'`, rex),
    tup(200, []),
  );
  const olive_owns = await tierkit.owner_of_workspace(W, ids.Olive!, su, "Olive");
  [s] = await api("GET", rec("project_stats", PP), olive);
  check(
    "H4 project_stats.view: workspace owner (not the creator) views the stats → 200",
    tup(await olive_owns.now(), s),
    tup(ids.Olive, 200),
  );
  check(
    "H4 project_stats.list: workspace owner lists them",
    await list_ids("project_stats", `id='${PP}'`, olive),
    tup(200, [PP]),
  );
  await olive_owns.done();

  // COVERS: route:tracker-summary
  console.log("\n── summary route: counts nothing an active membership does not admit ──");
  const summary = async (tk: string) => {
    const [st, body] = await api("GET", "/api/tracker/summary", tk);
    return tup(st, body.total ?? null, body.assignedToMe ?? null);
  };
  check(
    "control: Vic (active viewer assignee) counts his one assigned task",
    await summary(vic),
    tup(200, 1, 1),
  );
  check("summary: suspended assignee Sam counts nothing", await summary(sam), tup(200, 0, 0));
  check(
    "summary: suspended creator Pete counts nothing from his project",
    await summary(pete),
    tup(200, 0, 0),
  );
  check(
    "summary: removed creator Rex counts nothing from his project",
    await summary(rex),
    tup(200, 0, 0),
  );

  // COVERS: rule:saved_views.create, rule:saved_views.update
  console.log("\n── saved_views.owner is locked on update ──");
  const VIEW = (
    await as_make(
      mia,
      "saved_views",
      { workspace: W, name: "mia personal view", filterData: [], scope: "personal" },
      "Mia creates a personal view with no owner sent",
    )
  ).id;
  const view_owner = async () => (await api("GET", rec("saved_views", VIEW), su))[1].owner;
  check("(fixture) the server fills Mia as the view's owner", await view_owner(), ids.Mia);
  // Hand a reassigned view back so each actor below is measured against Mia's view.
  const restore_view = async () => {
    if ((await view_owner()) !== ids.Mia)
      await api("PATCH", rec("saved_views", VIEW), su, { owner: ids.Mia });
  };
  const mia_v = await tierkit.actor_at_tier(W, ids.Mia!, "member", su, "Mia");
  [s] = await api("PATCH", rec("saved_views", VIEW), mia, { owner: ids.Sam });
  check(
    "saved_views.update: Mia (view owner) hands her view to Sam → 404",
    tup(await mia_v.now(), s, await view_owner()),
    tup("member", 404, ids.Mia),
  );
  await restore_view();
  [s] = await api("PATCH", rec("saved_views", VIEW), mia, { owner: ids.Mia });
  check(
    "control: Mia sends her own id as owner → 200",
    tup(await mia_v.now(), s),
    tup("member", 200),
  );
  await mia_v.done();
  const olive_v = await tierkit.owner_of_workspace(W, ids.Olive!, su, "Olive");
  [s] = await api("PATCH", rec("saved_views", VIEW), olive, { owner: ids.Olive });
  check(
    "saved_views.update: Olive (workspace owner) claims Mia's view → 404",
    tup(await olive_v.now(), s, await view_owner()),
    tup(ids.Olive, 404, ids.Mia),
  );
  await restore_view();
  [s] = await api("PATCH", rec("saved_views", VIEW), olive, { name: "renamed by olive" });
  check(
    "control: Olive (workspace owner) renames Mia's view → 200",
    tup(await olive_v.now(), s),
    tup(ids.Olive, 200),
  );
  await olive_v.done();
  const ada_v = await tierkit.actor_at_tier(W, ids.Ada!, "admin", su, "Ada");
  [s] = await api("PATCH", rec("saved_views", VIEW), ada, { owner: ids.Ada });
  check(
    "saved_views.update: Ada (admin) claims Mia's view → 404",
    tup(await ada_v.now(), s, await view_owner()),
    tup("admin", 404, ids.Mia),
  );
  await restore_view();
  await ada_v.done();
  [s] = await api("PATCH", rec("saved_views", VIEW), null, { owner: ids.Sam });
  check(
    "saved_views.update: anon reassigns the view → 404",
    tup(s, await view_owner()),
    tup(404, ids.Mia),
  );
  await restore_view();
  [s] = await api("PATCH", rec("saved_views", VIEW), su, { owner: ids.Sam });
  check(
    "control: superuser reassigns the view → 200 (rules do not bind it)",
    tup(s, await view_owner()),
    tup(200, ids.Sam),
  );
  [s] = await api("PATCH", rec("saved_views", VIEW), su, { owner: ids.Mia });
  check(
    "(fixture) superuser hands the view back to Mia",
    tup(s, await view_owner()),
    tup(200, ids.Mia),
  );

  // COVERS: rule:labels.create, rule:labels.update, rule:labels.delete
  console.log("\n── labels.core is server-owned ──");
  const olive_l = await tierkit.owner_of_workspace(W, ids.Olive!, su, "Olive");
  const ada_l = await tierkit.actor_at_tier(W, ids.Ada!, "admin", su, "Ada");
  const mia_l = await tierkit.actor_at_tier(W, ids.Mia!, "member", su, "Mia");
  const vic_l = await tierkit.actor_at_tier(W, ids.Vic!, "viewer", su, "Vic");
  for (const [who, tk, standing, want] of [
    ["Olive (owner)", olive, () => olive_l.now(), ids.Olive],
    ["Ada (admin)", ada, () => ada_l.now(), "admin"],
  ] as const) {
    for (const core of [true, false]) {
      [s] = await api("POST", rec("labels"), tk, {
        workspace: W,
        name: `core ${core} by ${who}`,
        core,
      });
      check(
        `labels.create: ${who} sends core=${core} → 400`,
        tup(await standing(), s),
        tup(want, 400),
      );
    }
    [s, r] = await api("POST", rec("labels"), tk, { workspace: W, name: `plain by ${who}` });
    check(
      `control: ${who} creates a label without core → 200, core=false`,
      tup(await standing(), s, r.core),
      tup(want, 200, false),
    );
  }
  const [, bugs] = await api(
    "GET",
    `${rec("labels")}?${urlencode({ filter: `workspace='${W}' && core=true && name='Bug'` })}`,
    su,
  );
  const BUG: string = getitem(bugs.items[0], "id");
  const bug = async () => (await api("GET", rec("labels", BUG), su))[1];
  for (const [who, tk, standing, want] of [
    ["Olive (owner)", olive, () => olive_l.now(), ids.Olive],
    ["Ada (admin)", ada, () => ada_l.now(), "admin"],
    ["Mia (member)", mia, () => mia_l.now(), "member"],
    ["Vic (viewer)", vic, () => vic_l.now(), "viewer"],
    ["anon", null, async () => "anon", "anon"],
  ] as const) {
    [s] = await api("PATCH", rec("labels", BUG), tk, { core: false });
    const after = (await bug()).core;
    check(
      `labels.update: ${who} clears core on the Bug label → 404, still core`,
      tup(await standing(), s, after),
      tup(want, 404, true),
    );
    // Restore so the next actor is measured against a core label.
    if (after !== true) await api("PATCH", rec("labels", BUG), su, { core: true });
  }
  [s] = await api("PATCH", rec("labels", BUG), olive, { name: "Bug renamed" });
  check(
    "control: Olive (owner) renames the core label → 200",
    tup(await olive_l.now(), s, (await bug()).name),
    tup(ids.Olive, 200, "Bug renamed"),
  );
  [s] = await api("PATCH", rec("labels", BUG), olive, { name: "Bug" });
  check("(fixture) Olive restores the name", tup(s, (await bug()).name), tup(200, "Bug"));
  [s] = await api("DELETE", rec("labels", BUG), olive);
  check(
    "pin: Olive (owner) deletes the core label → 400",
    tup(await olive_l.now(), s, (await bug()).core),
    tup(ids.Olive, 400, true),
  );
  await olive_l.done();
  await ada_l.done();
  await mia_l.done();
  await vic_l.done();
  [s, r] = await api("POST", rec("labels"), su, {
    workspace: W,
    name: "su core label",
    core: true,
  });
  check("control: superuser creates a core label → 200", tup(s, r.core), tup(200, true));
  const SU_CORE = r.id;
  [s, r] = await api("PATCH", rec("labels", SU_CORE), su, { core: false });
  check("control: superuser clears core → 200", tup(s, r.core), tup(200, false));
  [s] = await api("DELETE", rec("labels", SU_CORE), su);
  check("(fixture) superuser deletes the no-longer-core label → 204", s, 204);

  await tierkit.verify_tiers();
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all access-rule-hole proofs passed");
  process.exit(0);
}

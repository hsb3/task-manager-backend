#!/usr/bin/env bun
/**
 * decision:api-key-reach-and-levels: a key limited to a workspace or to projects sees and writes
 * only records in its reach through the collection rules, counts and expansions; account-wide
 * requests answer 403 api_key_reach; a client-sent reach header, in any spelling, changes nothing.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8211 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8211 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const USERS = "/api/collections/users/records";
const recs = (c: string) => `/api/collections/${c}/records`;
const REACH_MSG =
  "This API key is limited to part of the tracker, so it cannot be used for this endpoint.";
const RUNS = 8;

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(76)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

async function api(
  method: string,
  url: string,
  auth: string | null = null,
  body: any = null,
  extra: Record<string, string> = {},
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (auth) headers.Authorization = auth;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await r.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { _raw: text };
  }
  return [r.status, parsed];
}

const answer = ([s, r]: [number, any]) =>
  tup(s, r?.message ?? null, r?.data?.api_key?.code ?? null, r?.data?.api_key?.message ?? null);
const reach403 = tup(403, REACH_MSG, "api_key_reach", REACH_MSG);

async function login(email: string): Promise<[string, string]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  if (s !== 200) throw new roomkit.SystemExit(`login ${email} failed: ${s} ${py_repr(r)}`);
  return [r.token, r.record.id];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-key-reach-test-"));
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
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  console.log("\n── fixtures: Alice owns WA (PA1: T1, PA2: T2, T0 no project) and WB (PB1: T3) ──");
  const uid: Record<string, string> = {};
  const tok: Record<string, string> = {};
  for (const name of ["Alice", "Bob"]) {
    const email = `${name.toLowerCase()}@example.com`;
    const [s] = await api("POST", USERS, su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`(fixture) ${name} created`, s, 200);
    [tok[name], uid[name]] = await login(email);
  }
  const alice = tok.Alice;
  const [, wl] = await api(
    "GET",
    `${recs("workspaces")}?${urlencode({ filter: `owner='${uid.Alice}'` })}`,
    su,
  );
  const WA: string = wl.items?.[0]?.id ?? "";
  const make = async (c: string, body: any, label: string): Promise<string> => {
    const [st, r] = await api("POST", recs(c), alice, body);
    check(`(fixture) ${label}`, st, 200);
    return r.id ?? "";
  };
  const WB = await make("workspaces", { name: "WB" }, "workspace WB");
  const PA1 = await make("projects", { name: "PA1", workspace: WA }, "project PA1 in WA");
  const PA2 = await make("projects", { name: "PA2", workspace: WA }, "project PA2 in WA");
  const PB1 = await make("projects", { name: "PB1", workspace: WB }, "project PB1 in WB");
  const T1 = await make("tasks", { title: "T1", workspace: WA, project: PA1 }, "task T1 in PA1");
  const T2 = await make("tasks", { title: "T2", workspace: WA, project: PA2 }, "task T2 in PA2");
  const T0 = await make("tasks", { title: "T0", workspace: WA }, "task T0 in WA, no project");
  const T3 = await make("tasks", { title: "T3", workspace: WB, project: PB1 }, "task T3 in PB1");
  const C1 = await make("comments", { task: T1, body: "on T1" }, "comment on T1");
  await make("comments", { task: T2, body: "on T2" }, "comment on T2");
  // A comment writes no task_activity row; an edit does.
  for (const [t, title] of [
    [T1, "T1"],
    [T2, "T2"],
  ]) {
    const [st] = await api("PATCH", `${recs("tasks")}/${t}`, alice, { title: `${title} edited` });
    check(`(fixture) Alice edits ${title}, writing task_activity`, st, 200);
  }
  const INV_X = await make(
    "workspace_invitations",
    { workspace: WA, email: "x@example.com", role: "member" },
    "invitation of x@example.com to WA",
  );
  await make(
    "workspace_invitations",
    { workspace: WB, email: "y@example.com", role: "member" },
    "invitation of y@example.com to WB",
  );
  await make("labels", { name: "LA", workspace: WA }, "label LA in WA");
  await make("labels", { name: "LB", workspace: WB }, "label LB in WB");
  await make("cycles", { name: "CA", workspace: WA, starts_on: "2026-11-01" }, "cycle CA in WA");
  await make("cycles", { name: "CB", workspace: WB, starts_on: "2026-11-01" }, "cycle CB in WB");
  const [sm] = await api("POST", recs("workspace_members"), su, {
    workspace: WA,
    user: uid.Bob,
    role: "member",
    status: "active",
  });
  check("(fixture) Bob is an active member of WA", sm, 200);
  const mint = async (name: string, body: any): Promise<string> => {
    const [st, k] = await api("POST", KEYS, alice, { name, scope: "write", ...body });
    check(`(fixture) key ${name} minted`, st, 200);
    return k.key ?? "tmk_none";
  };
  const kAll = await mint("kAll", {});
  const kWA = await mint("kWA", { reach: "workspace", workspace: WA });
  const kP1 = await mint("kP1", { reach: "projects", workspace: WA, projects: [PA1] });

  /** [status, sorted ids, totalItems] of a list. */
  const list = async (
    token: string,
    c: string,
    filter = "",
    extra: Record<string, string> = {},
  ): Promise<[number, string[], number]> => {
    const q: Record<string, string> = { perPage: "500" };
    if (filter) q.filter = filter;
    const [s, r] = await api("GET", `${recs(c)}?${urlencode(q)}`, token, null, extra);
    return [s, (r.items ?? []).map((x: any) => x.id).sort(), r.totalItems ?? -1];
  };
  /** Alice's own session as the oracle: every id matching filter, with its count. */
  const truth = async (c: string, filter: string): Promise<[number, string[], number]> =>
    list(alice, c, filter);
  const live = async (c: string, id: string) => (await api("GET", `${recs(c)}/${id}`, su))[0];
  const field = async (c: string, id: string, f: string) =>
    (await api("GET", `${recs(c)}/${id}`, su))[1][f];

  console.log("\n── a workspace key ──");
  check(
    "kWA lists tasks → only WA's, totalItems = WA's count",
    await list(kWA, "tasks"),
    await truth("tasks", `workspace='${WA}'`),
  );
  check("kWA views a WB task → 404", (await api("GET", `${recs("tasks")}/${T3}`, kWA))[0], 404);
  let [s] = await api("PATCH", `${recs("tasks")}/${T3}`, kWA, { title: "moved" });
  check("kWA PATCH a WB task → 404", tup(s, await field("tasks", T3, "title")), tup(404, "T3"));
  [s] = await api("DELETE", `${recs("tasks")}/${T3}`, kWA);
  check(
    "kWA DELETE a WB task → 404, still live",
    tup(s, await field("tasks", T3, "trashed")),
    tup(404, ""),
  );
  [s] = await api("POST", recs("tasks"), kWA, { title: "kWA in WB", workspace: WB, project: PB1 });
  check(
    "kWA creates a task in WB → 400, nothing stored",
    tup(s, (await truth("tasks", `title='kWA in WB'`))[2]),
    tup(400, 0),
  );
  [s] = await api("POST", recs("tasks"), kWA, { title: "kWA in WA", workspace: WA });
  check("kWA creates a task in WA → 200", s, 200);
  [s] = await api("POST", recs("tasks"), kWA, { title: "kWA PB1 only", project: PB1 });
  check(
    "kWA creates a task naming only a WB project → 400",
    tup(s, (await truth("tasks", `title='kWA PB1 only'`))[2]),
    tup(400, 0),
  );
  check("kWA lists workspaces → [WA]", (await list(kWA, "workspaces"))[1], [WA]);
  check("kWA views WB → 404", (await api("GET", `${recs("workspaces")}/${WB}`, kWA))[0], 404);
  check(
    "kWA creates a workspace → 403 api_key_reach",
    answer(await api("POST", recs("workspaces"), kWA, { name: "kWA's" })),
    reach403,
  );
  const [, us] = await api("GET", recs("user_settings"), alice);
  const US: string = us.items?.[0]?.id ?? "";
  check(
    "kWA PATCH its user_settings → 403 api_key_reach",
    answer(await api("PATCH", `${recs("user_settings")}/${US}`, kWA, { theme: "dark" })),
    reach403,
  );
  check("kWA GET user_settings → 200", (await list(kWA, "user_settings"))[0], 200);
  check(
    "kWA lists workspace_invitations → only x@example.com's",
    (await list(kWA, "workspace_invitations"))[1],
    [INV_X],
  );
  const [, ex] = await api("GET", `${recs("tasks")}/${T0}?expand=workspace`, kWA);
  check("kWA expands a task's `workspace` → present", ex?.expand?.workspace?.id ?? null, WA);

  console.log("\n── a projects key ──");
  check(
    "kP1 lists tasks → [T1] (not T2, not T0 in WA's container)",
    (await list(kP1, "tasks"))[1],
    [T1],
  );
  for (const c of ["statuses", "labels", "cycles", "workspace_members"]) {
    const want = await truth(c, `workspace='${WA}'`);
    check(`kP1 lists ${c} of WA → all of them (${want[2]})`, await list(kP1, c), want);
  }
  check("kP1 views WA → 200", (await api("GET", `${recs("workspaces")}/${WA}`, kP1))[0], 200);
  check("kP1 lists projects → [PA1]", (await list(kP1, "projects"))[1], [PA1]);
  [s] = await api("PATCH", `${recs("tasks")}/${T1}`, kP1, { project: PA2 });
  check(
    "kP1 moves its PA1 task to PA2 → 404, still in PA1",
    tup(s, await field("tasks", T1, "project")),
    tup(404, PA1),
  );
  [s] = await api("PATCH", `${recs("tasks")}/${T1}`, kP1, { project: "" });
  check(
    "kP1 sets its project to '' → 404",
    tup(s, await field("tasks", T1, "project")),
    tup(404, PA1),
  );
  [s] = await api("POST", recs("tasks"), kP1, { title: "kP1 PA2", workspace: WA, project: PA2 });
  check("kP1 creates a task in PA2 → 400", s, 400);
  [s] = await api("POST", recs("tasks"), kP1, { title: "kP1 none", workspace: WA });
  check("kP1 creates a task with no project → 400", s, 400);
  [s] = await api("POST", recs("tasks"), kP1, { title: "kP1 PA1", workspace: WA, project: PA1 });
  check("kP1 creates a task in PA1 → 200", s, 200);
  [s] = await api("POST", recs("projects"), kP1, { name: "kP1's", workspace: WA });
  check("kP1 creates a project → 400", s, 400);
  check(
    "kP1 lists workspace_invitations → 0 items",
    (await list(kP1, "workspace_invitations"))[2],
    0,
  );
  check("kP1 lists comments → only the T1 comment", (await list(kP1, "comments"))[1], [C1]);
  const [, act] = await api("GET", `${recs("task_activity")}?perPage=500`, kP1);
  const actTasks = [...new Set((act.items ?? []).map((x: any) => x.task))];
  const actT1 = (await truth("task_activity", `task='${T1}'`))[2];
  check(
    "(oracle) T1 and T2 have task_activity rows",
    tup(actT1 > 0, (await truth("task_activity", `task='${T2}'`))[2] > 0),
    tup(true, true),
  );
  check(
    "kP1 lists task_activity → only rows whose task is T1",
    tup(actTasks, act.totalItems),
    tup([T1], actT1),
  );
  const [, ep] = await api("GET", `${recs("tasks")}/${T1}?expand=project`, kP1);
  check("kP1 expands `project` of a PA1 task → present", ep?.expand?.project?.id ?? null, PA1);

  console.log(`\n── forged reach headers (each ${RUNS} times running) ──`);
  const both = await truth("tasks", "");
  check(
    "(oracle) Alice's tasks span WA and WB",
    both[1].includes(T1) && both[1].includes(T3),
    true,
  );
  const repeat = async (token: string, extra: Record<string, string>) => {
    const seen = new Set<string>();
    for (let i = 0; i < RUNS; i++) seen.add(JSON.stringify(await list(token, "tasks", "", extra)));
    return [...seen].map((x) => JSON.parse(x));
  };
  for (const name of ["x_tm_key_workspace", "X-Tm-Key_Workspace", "X-Tm-Key-Workspace"]) {
    check(
      `forged ${name}: WB on Alice's session → WA's and WB's tasks`,
      await repeat(alice, { [name]: WB }),
      [both],
    );
  }
  check(
    "kWA with forged x_tm_key_workspace: '' → only WA's tasks",
    await repeat(kWA, { x_tm_key_workspace: "" }),
    [await truth("tasks", `workspace='${WA}'`)],
  );
  check(
    "kP1 with forged x_tm_key_projects: '' → only PA1's tasks",
    await repeat(kP1, { x_tm_key_projects: "" }),
    [await truth("tasks", `project='${PA1}'`)],
  );
  check(
    "a forged X-Tm-Key-Workspace: WB on kAll → both workspaces",
    await repeat(kAll, { "X-Tm-Key-Workspace": WB }),
    [both],
  );

  console.log("\n── counts ──");
  const counts = async (token: string) =>
    (await api("GET", "/api/tracker/project-items/counts?group=project", token))[1].total ?? null;
  check(
    "kWA GET project-items/counts → only WA's items",
    await counts(kWA),
    (await truth("project_items", `workspace='${WA}'`))[2],
  );
  check(
    "kP1 GET project-items/counts → only PA1's",
    await counts(kP1),
    (await truth("project_items", `project='${PA1}'`))[2],
  );
  check(
    "kAll GET project-items/counts → every item",
    await counts(kAll),
    (await truth("project_items", ""))[2],
  );

  console.log("\n── controls: kAll and Alice's own session ──");
  check("kAll lists tasks of both workspaces", await list(kAll, "tasks"), both);
  check(
    "Alice lists workspaces → WA and WB",
    (await list(alice, "workspaces"))[1],
    [WA, WB].sort(),
  );
  check("Alice views a WB task → 200", (await api("GET", `${recs("tasks")}/${T3}`, alice))[0], 200);
  const aProjects = (await list(alice, "projects"))[1];
  check(
    "Alice lists projects → PA1, PA2 and PB1 among them",
    [PA1, PA2, PB1].every((p) => aProjects.includes(p)),
    true,
  );
  check("Alice lists comments → both", (await list(alice, "comments"))[2], 2);
  check(
    "Alice lists workspace_invitations → both",
    (await list(alice, "workspace_invitations"))[2],
    2,
  );
  check(
    "Alice GET project-items/counts → every item",
    await counts(alice),
    (await truth("project_items", ""))[2],
  );
  [s] = await api("POST", recs("tasks"), alice, {
    title: "Alice PB1",
    workspace: WB,
    project: PB1,
  });
  check("Alice creates a task in WB → 200", s, 200);
  [s] = await api("PATCH", `${recs("tasks")}/${T3}`, alice, { title: "T3b" });
  check("Alice PATCH a WB task → 200", s, 200);
  [s] = await api("POST", recs("workspaces"), alice, { name: "WC" });
  check("Alice creates a workspace → 200", s, 200);
  check(
    "Alice PATCH her user_settings → 200",
    (await api("PATCH", `${recs("user_settings")}/${US}`, alice, { theme: "dark" }))[0],
    200,
  );
  check("(fixture) T3 is still live", await live("tasks", T3), 200);

  console.log(
    `\n── reach headers in every spelling PocketBase folds onto the rule token (each ${RUNS} times running) ──`,
  );
  // PB 0.40.4 reads a header name as inflector.Snakecase: runs of characters outside [A-Za-z0-9] split it.
  const forgedNames = (last: string): string[] => {
    const words = ["x", "tm", "key", last];
    const out = new Set([
      `X.Tm.Key.${last[0].toUpperCase()}${last.slice(1)}`,
      `X-Tm-Key-${last[0].toUpperCase()}${last.slice(1)}_`,
      `X-Tm_Key.${last}`,
    ]);
    for (const c of "!#$%&'*+-.^_`|~") {
      const j = words.join(c);
      for (const n of [j, words.join(c + c), c + j, j + c]) out.add(n);
    }
    return [...out];
  };
  // Left off for the rest of the run: the room is this suite's own and is deleted with it.
  check(
    "(fixture) superuser lifts the room's request rate limit for the sweep",
    (await api("PATCH", "/api/settings", su, { rateLimits: { enabled: false } }))[0],
    200,
  );
  const wsNames = forgedNames("workspace");
  const pjNames = forgedNames("projects");
  const CB = await make("comments", { task: T3, body: "on T3" }, "comment on T3 in WB");
  const CP2 = await make("comments", { task: T2, body: "on T2 again" }, "second comment on T2");
  const titles = tup(await field("tasks", T2, "title"), await field("tasks", T3, "title"));
  const sweep = [
    {
      name: "kWA",
      token: kWA,
      wide: tup(WB, ""),
      out: T3,
      comment: CB,
      ws: WB,
      pr: PB1,
      own: `workspace='${WA}'`,
    },
    {
      name: "kP1",
      token: kP1,
      wide: tup(WA, PA2),
      out: T2,
      comment: CP2,
      ws: WA,
      pr: PA2,
      own: `project='${PA1}'`,
    },
  ];
  for (const k of sweep) {
    const own = await truth("tasks", k.own);
    const bad: Record<string, string[]> = {
      list: [],
      view: [],
      update: [],
      create: [],
      delete: [],
    };
    for (let i = 0; i < wsNames.length; i++) {
      for (let r = 0; r < RUNS; r++) {
        // Even runs forge an empty value ("no limit"), odd runs an out-of-reach one.
        const f = { [wsNames[i]]: r % 2 ? k.wide[0] : "", [pjNames[i]]: r % 2 ? k.wide[1] : "" };
        const tag = `${wsNames[i]} / ${pjNames[i]}`;
        if (!Bun.deepEquals(await list(k.token, "tasks", "", f), own)) bad.list.push(tag);
        if ((await api("GET", `${recs("tasks")}/${k.out}`, k.token, null, f))[0] !== 404)
          bad.view.push(tag);
        if (
          (await api("PATCH", `${recs("tasks")}/${k.out}`, k.token, { title: "forged" }, f))[0] !==
          404
        )
          bad.update.push(tag);
        if (
          (
            await api(
              "POST",
              recs("tasks"),
              k.token,
              { title: "forged", workspace: k.ws, project: k.pr },
              f,
            )
          )[0] !== 400
        )
          bad.create.push(tag);
        if ((await api("DELETE", `${recs("comments")}/${k.comment}`, k.token, null, f))[0] !== 404)
          bad.delete.push(tag);
      }
    }
    for (const [op, tags] of Object.entries(bad))
      check(
        `${k.name}, ${wsNames.length} forged spelling pairs: ${op} out of reach → refused every run`,
        [...new Set(tags)],
        [],
      );
  }
  check(
    "(after the sweep) T2 and T3 keep their titles, both comments live, no forged task exists",
    tup(
      tup(await field("tasks", T2, "title"), await field("tasks", T3, "title")),
      await live("comments", CB),
      await live("comments", CP2),
      (await api("GET", `${recs("tasks")}?filter=${encodeURIComponent("title='forged'")}`, su))[1]
        .totalItems,
    ),
    tup(titles, 200, 200, 0),
  );
  const every = await truth("tasks", "");
  const stripped: string[] = [];
  for (const n of wsNames)
    for (let r = 0; r < RUNS; r++)
      if (!Bun.deepEquals(await list(alice, "tasks", "", { [n]: WB }), every)) stripped.push(n);
  check(
    "each forged workspace spelling: WB on Alice's session → every task (removed)",
    [...new Set(stripped)],
    [],
  );
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all key-reach proofs passed");
  process.exit(0);
}

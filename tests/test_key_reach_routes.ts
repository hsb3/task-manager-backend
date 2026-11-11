#!/usr/bin/env bun
/**
 * decision:api-key-reach-and-levels: every custom tracker route applies a limited key's reach,
 * answering the route's own not-found for a workspace outside it.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8212 + PB_PORT_OFFSET.
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
const PORT = 8212 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const USERS = "/api/collections/users/records";
const recs = (c: string) => `/api/collections/${c}/records`;
const REACH_MSG =
  "This API key is limited to part of the tracker, so it cannot be used for this endpoint.";

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
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
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

const reachAnswer = ([s, r]: [number, any]) => tup(s, r?.data?.api_key?.code ?? null);
const reach403 = tup(403, "api_key_reach");

async function login(email: string): Promise<[string, string]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  if (s !== 200) throw new roomkit.SystemExit(`login ${email} failed: ${s} ${py_repr(r)}`);
  return [r.token, r.record.id];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-key-reach-routes-test-"));
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

  console.log(
    "\n── fixtures: Alice owns WA (PA1, PA2) and WB (PB1); Bob, active in both, owns WC ──",
  );
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
  const bob = tok.Bob;
  const [, wl] = await api(
    "GET",
    `${recs("workspaces")}?${urlencode({ filter: `owner='${uid.Alice}'` })}`,
    su,
  );
  const WA: string = wl.items?.[0]?.id ?? "";
  const make = async (c: string, body: any, label: string, who = alice): Promise<string> => {
    const [st, r] = await api("POST", recs(c), who, body);
    check(`(fixture) ${label}`, st, 200);
    return r.id ?? "";
  };
  const WB = await make("workspaces", { name: "WB" }, "workspace WB");
  const WC = await make("workspaces", { name: "WC" }, "Bob's workspace WC", bob);
  for (const w of [WA, WB]) {
    const [sm] = await api("POST", recs("workspace_members"), su, {
      workspace: w,
      user: uid.Bob,
      role: "member",
      status: "active",
    });
    check(`(fixture) Bob is an active member of ${w === WA ? "WA" : "WB"}`, sm, 200);
  }
  const PA1 = await make("projects", { name: "PA1 zephyr", workspace: WA }, "project PA1 in WA");
  const PA2 = await make("projects", { name: "PA2 zephyr", workspace: WA }, "project PA2 in WA");
  const PB1 = await make("projects", { name: "PB1 zephyr", workspace: WB }, "project PB1 in WB");
  const task = (title: string, w: string, p: string) =>
    make("tasks", { title, workspace: w, project: p }, `task ${title}`);
  const T1 = await task("zephyr T1", WA, PA1);
  const T2 = await task("zephyr T2", WA, PA2);
  const T3 = await task("zephyr T3", WB, PB1);
  await make("tasks", { title: "T0", workspace: WA }, "task T0 in WA, no project");
  const TX: Record<string, string> = {};
  for (const [name, w, p] of [
    ["TX1", WA, PA1],
    ["TX2", WA, PA2],
    ["TX3", WB, PB1],
  ]) {
    TX[name] = await task(name, w, p);
    const [st] = await api("DELETE", `${recs("tasks")}/${TX[name]}`, alice);
    check(`(fixture) Alice trashes ${name}`, st, 204);
  }
  await make("labels", { name: "LA", workspace: WA }, "label LA in WA");
  await make("labels", { name: "LP2", workspace: WA, project: PA2 }, "label LP2 in WA's PA2");
  // Stands in for the row transfer-ownership writes: the one taskless task_activity row.
  const [sa] = await api("POST", recs("task_activity"), su, {
    workspace: WA,
    field: "owner",
    operator: SU_EMAIL,
  });
  check("(fixture) a taskless task_activity row in WA", sa, 200);
  const N: Record<string, string> = {};
  for (const [t, name] of [
    [T1, "N1"],
    [T2, "N2"],
    [T3, "N3"],
  ]) {
    await make("comments", { task: t, body: "a word from Bob" }, `Bob comments on ${name}`, bob);
    const [, nl] = await api(
      "GET",
      `${recs("notifications")}?${urlencode({ filter: `user='${uid.Alice}' && task='${t}'` })}`,
      su,
    );
    N[name] = nl.items?.[0]?.id ?? "";
    check(`(fixture) Alice holds notification ${name}`, nl.totalItems, 1);
  }
  const [si] = await api("POST", recs("workspace_invitations"), bob, {
    workspace: WC,
    email: "alice@example.com",
    role: "member",
  });
  check("(fixture) Bob invites alice@example.com to WC", si, 200);
  const [, il] = await api("GET", recs("workspace_invitations"), su);
  const INV: string = (il.items ?? []).find((i: any) => i.workspace === WC)?.id ?? "";
  const mint = async (name: string, body: any): Promise<string> => {
    const [st, k] = await api("POST", KEYS, alice, { name, scope: "write", ...body });
    check(`(fixture) key ${name} minted`, st, 200);
    return k.key ?? "tmk_none";
  };
  const kAll = await mint("kAll", {});
  const kWA = await mint("kWA", { reach: "workspace", workspace: WA });
  const kP1 = await mint("kP1", { reach: "projects", workspace: WA, projects: [PA1] });
  const kWAmanage = await mint("kWAmanage", {
    scope: "manage",
    reach: "workspace",
    workspace: WA,
  });
  const kWAown = await mint("kWAown", { scope: "own", reach: "workspace", workspace: WA });

  /** sorted ids of a collection list under Alice's session (the oracle). */
  const truth = async (c: string, filter: string, who = alice): Promise<string[]> => {
    const [, r] = await api("GET", `${recs(c)}?${urlencode({ perPage: "500", filter })}`, who);
    return (r.items ?? []).map((x: any) => x.id).sort();
  };
  const ids = (xs: any[] | undefined) => (xs ?? []).map((x: any) => x.id).sort();
  const field = async (c: string, id: string, f: string) =>
    (await api("GET", `${recs(c)}/${id}`, su))[1][f];

  console.log("\n── GET /api/tracker/me ──");
  const me = async (k: string) => (await api("GET", "/api/tracker/me", k))[1];
  const meWA = await me(kWA);
  check(
    "kWA me lists [WA]",
    (meWA.workspaces ?? []).map((w: any) => w.id),
    [WA],
  );
  check(
    "kWA me key.reach workspace, key.workspace WA",
    tup(meWA.key?.reach, meWA.key?.workspace),
    tup("workspace", WA),
  );
  const meP1 = await me(kP1);
  const wP1 = (meP1.workspaces ?? []).find((w: any) => w.id === WA) ?? {};
  const openPA1 = (
    await truth(
      "tasks",
      `project='${PA1}' && status.category != 'completed' && status.category != 'canceled'`,
    )
  ).length;
  check(
    "kP1 me counts.projects = 1, counts.open_items = PA1's open tasks",
    tup(wP1.counts?.projects, wP1.counts?.open_items),
    tup(1, openPA1),
  );
  check(
    "kP1 me manage false, own false",
    tup(wP1.capabilities?.manage, wP1.capabilities?.own),
    tup(false, false),
  );
  check("kP1 me unread_notifications = 1 (only the PA1 one)", meP1.unread_notifications, 1);
  const meAll = await me(kAll);
  check(
    "kAll me key.reach all, lists WA and WB",
    tup(meAll.key?.reach, (meAll.workspaces ?? []).map((w: any) => w.id).sort()),
    tup("all", [WA, WB].sort()),
  );
  check("Alice's session me unread_notifications = 3", (await me(alice)).unread_notifications, 3);

  console.log("\n── account-wide routes ──");
  check(
    "kWA me/landing → 403 api_key_reach",
    reachAnswer(await api("GET", "/api/tracker/me/landing", kWA)),
    reach403,
  );
  check(
    "kWA switch → 403 api_key_reach",
    reachAnswer(await api("GET", `/api/tracker/workspaces/${WA}/switch`, kWA)),
    reach403,
  );
  check(
    "kWA invitations/mine → 403 api_key_reach",
    reachAnswer(await api("GET", "/api/tracker/invitations/mine", kWA)),
    reach403,
  );
  check(
    "kWA accept → 403 api_key_reach (before level)",
    reachAnswer(await api("POST", `/api/tracker/invitations/${INV}/accept`, kWA)),
    reach403,
  );
  check(
    "kWA PATCH users/{id}/settings → 403 api_key_reach",
    reachAnswer(
      await api("PATCH", `/api/tracker/users/${uid.Alice}/settings`, kWA, { theme: "dark" }),
    ),
    reach403,
  );
  check(
    "kWA GET users/{id}/settings → 200",
    (await api("GET", `/api/tracker/users/${uid.Alice}/settings`, kWA))[0],
    200,
  );

  console.log("\n── search ──");
  const search = async (k: string) =>
    ((await api("GET", "/api/tracker/search?q=zephyr", k))[1].results ?? [])
      .map((r: any) => r.id)
      .sort();
  check(
    "Alice's session search → hits in WA and WB",
    await search(alice),
    [T1, T2, T3, PA1, PA2, PB1].sort(),
  );
  check(
    "kWA search for a word in WA and WB titles → WA hits only",
    await search(kWA),
    [T1, T2, PA1, PA2].sort(),
  );
  check("kP1 → PA1 hits only, no project hit other than PA1", await search(kP1), [T1, PA1].sort());

  console.log("\n── summary ──");
  const total = async (k: string) => (await api("GET", "/api/tracker/summary", k))[1].total;
  check(
    "Alice's session summary counts WA's and WB's project tasks",
    await total(alice),
    (await truth("tasks", "project.shadow = false")).length,
  );
  check(
    "kWA summary counts WA's tasks only",
    await total(kWA),
    (await truth("tasks", `workspace='${WA}' && project.shadow = false`)).length,
  );
  check("kP1 → PA1's only", await total(kP1), (await truth("tasks", `project='${PA1}'`)).length);

  console.log("\n── trash ──");
  const trash = (k: string, w: string) =>
    api("GET", `/api/tracker/trash?${urlencode({ workspace: w })}`, k);
  const trashIds = (r: any) => (r.items ?? []).map((i: any) => i.record?.id).sort();
  check("Alice's session trash?workspace=WB → 200", (await trash(alice, WB))[0], 200);
  check("kWA trash?workspace=WB → 404", (await trash(kWA, WB))[0], 404);
  let [s, r] = await trash(kP1, WA);
  check(
    "kP1 trash?workspace=WA → only the PA1 trashed task",
    tup(s, trashIds(r)),
    tup(200, [TX.TX1]),
  );
  [s, r] = await trash(alice, WA);
  check(
    "Alice's session trash?workspace=WA → TX1 and TX2",
    tup(s, trashIds(r)),
    tup(200, [TX.TX1, TX.TX2].sort()),
  );

  console.log("\n── export ──");
  const exp = (k: string, body: any) => api("POST", "/api/tracker/export", k, body);
  const taskless = (d: any) => (d?.task_activity ?? []).filter((a: any) => !a.task).length;
  check("kWA export WB → 404", (await exp(kWA, { workspace: WB }))[0], 404);
  [s, r] = await exp(alice, { workspace: WA });
  check(
    "Alice's session export WA → PA1 and PA2 tasks, one taskless activity row",
    tup(s, ids(r.data?.tasks).includes(T2), taskless(r.data)),
    tup(200, true, 1),
  );
  [s, r] = await exp(kP1, { workspace: WA });
  check(
    "kP1 export WA → tasks only from PA1, every status and label of WA, no taskless activity",
    tup(s, ids(r.data?.tasks), ids(r.data?.statuses), ids(r.data?.labels), taskless(r.data)),
    tup(
      200,
      await truth("tasks", `project='${PA1}'`),
      await truth("statuses", `workspace='${WA}'`, su),
      await truth("labels", `workspace='${WA}'`, su),
      0,
    ),
  );
  check("kP1 export WA → projects [PA1]", ids(r.data?.projects), [PA1]);
  [s, r] = await exp(kP1, { workspace: WA, projects: [PA2] });
  check(
    "kP1 export WA projects [PA2] → no tasks",
    tup(s, ids(r.data?.tasks), ids(r.data?.projects)),
    tup(200, [], []),
  );

  console.log("\n── workspace-scoped routes naming WB ──");
  check(
    "kWAown deletion-impact WB → 404",
    (await api("GET", `/api/tracker/workspaces/${WB}/deletion-impact`, kWAown))[0],
    404,
  );
  check(
    "kWAown deletion-impact WA → 200 (control)",
    (await api("GET", `/api/tracker/workspaces/${WA}/deletion-impact`, kWAown))[0],
    200,
  );
  check(
    "kP1 deletion-impact WA → 404",
    (await api("GET", `/api/tracker/workspaces/${WA}/deletion-impact`, kP1))[0],
    404,
  );
  [s] = await api("POST", `/api/tracker/workspaces/${WB}/vocab`, kWAmanage, { name: "taken" });
  check(
    "kWAmanage vocab WB → 404, name unchanged",
    tup(s, await field("workspaces", WB, "name")),
    tup(404, "WB"),
  );
  check(
    "kWAmanage vocab WA → 200 (control)",
    (await api("POST", `/api/tracker/workspaces/${WA}/vocab`, kWAmanage, {}))[0],
    200,
  );
  const invitesTo = async (w: string, email: string) =>
    (await truth("workspace_invitations", `workspace='${w}' && email='${email}'`, su)).length;
  [s] = await api("POST", `/api/tracker/workspaces/${WB}/resolve-member-email`, kWAmanage, {
    email: "z@example.com",
  });
  check(
    "kWAmanage resolve-member-email WB → 404, no invitation",
    tup(s, await invitesTo(WB, "z@example.com")),
    tup(404, 0),
  );
  [s] = await api("POST", `/api/tracker/workspaces/${WA}/resolve-member-email`, kWAmanage, {
    email: "z@example.com",
  });
  check(
    "kWAmanage resolve-member-email WA → 200 (control)",
    tup(s, await invitesTo(WA, "z@example.com")),
    tup(200, 1),
  );
  [s] = await api("POST", `/api/tracker/workspaces/${WB}/transfer-ownership`, kWAown, {
    user: uid.Bob,
  });
  check(
    "kWAown transfer-ownership of WB → 404, Alice still owns WB",
    tup(s, await field("workspaces", WB, "owner")),
    tup(404, uid.Alice),
  );
  // A project key is capped at write, so the level answers before reach.
  for (const [route, need] of [
    ["vocab", "manage level or above"],
    ["resolve-member-email", "manage level or above"],
    ["transfer-ownership", "own level"],
  ]) {
    const [st, body] = await api("POST", `/api/tracker/workspaces/${WA}/${route}`, kP1, {});
    check(
      `kP1 ${route} WA → 403 api_key_scope (level)`,
      tup(st, body?.data?.api_key?.code ?? null, body?.message ?? null),
      tup(403, "api_key_scope", `This action needs an API key at the ${need}.`),
    );
  }

  console.log("\n── notifications/read-all ──");
  const isRead = async () =>
    tup(
      await field("notifications", N.N1, "read"),
      await field("notifications", N.N2, "read"),
      await field("notifications", N.N3, "read"),
    );
  [s, r] = await api("POST", "/api/tracker/notifications/read-all", kP1);
  check(
    "kP1 read-all → only the PA1 one",
    tup(s, r.updated, await isRead()),
    tup(200, 1, tup(true, false, false)),
  );
  [s, r] = await api("POST", "/api/tracker/notifications/read-all", kWA);
  check(
    "kWA read-all → only WA notifications marked read; the WB one stays unread",
    tup(s, r.updated, await isRead()),
    tup(200, 1, tup(true, true, false)),
  );

  console.log("\n── workspaces/trash (Alice trashes WB last) ──");
  [s] = await api("DELETE", `${recs("workspaces")}/${WB}`, alice);
  check("(fixture) Alice's session trashes WB", s, 204);
  const wsTrash = async (k: string) =>
    ids((await api("GET", "/api/tracker/workspaces/trash", k))[1].items);
  check("kWA workspaces/trash → [] (WB is out of reach)", await wsTrash(kWA), []);
  check("Alice's session workspaces/trash → [WB]", await wsTrash(alice), [WB]);
  check("kAll workspaces/trash → [WB]", await wsTrash(kAll), [WB]);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all key-reach route proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * E2E proof of GET /api/tracker/workspaces/{id}/deletion-impact: one owner-only read that counts
 * what deleting a workspace takes with it (items, trashed items, projects, members, saved views),
 * and answers every other caller as an unknown id.
 *
 * Clean-room server, --hooksDir from a pb_hooks copy. Port 8176 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as roomkit from "./roomkit.ts";
import { run_checked } from "../scripts/_py.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PORT = 8176 + roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "test123456";
let failures = 0;
let passes = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (ok) passes += 1;
  else failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌"} ${label}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(expected)}`}`,
  );
}

async function api(
  method: string,
  p: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any, string]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  let j: any = {};
  try {
    j = raw ? JSON.parse(raw) : {};
  } catch (_) {}
  return [r.status, j, raw];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-delete-impact-test-"));
const MIG = path.join(S, "pb_migrations");
const DATA = path.join(S, "pb_data");
fs.mkdirSync(DATA, { recursive: true });
copy_tree(path.join(REPO_ROOT, "pb_migrations"), MIG);
for (const n of fs.readdirSync(MIG))
  if (n.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG, n));

let server: roomkit.Room | null = null;
try {
  console.log("════════ test_delete_impact.ts — workspace deletion impact in one read ════════");
  run_checked(
    [
      roomkit.pb_bin(),
      "superuser",
      "upsert",
      "probe@example.com",
      "probe123456",
      "--dir",
      DATA,
      "--migrationsDir",
      MIG,
    ],
    { cwd: REPO_ROOT, capture_output: true },
  );
  server = await roomkit.serve(PORT, DATA, MIG, roomkit.hooks_dir(S));
  const su = (
    await api("POST", "/api/collections/_superusers/auth-with-password", null, {
      identity: "probe@example.com",
      password: "probe123456",
    })
  )[1].token;

  // Seeding must not silently fail: a missing fixture would make the counts meaningless.
  async function mk(token: string, coll: string, body: any): Promise<string> {
    const [s, j] = await api("POST", `/api/collections/${coll}/records`, token, body);
    if (s !== 200)
      throw new Error(`seed ${coll} ${JSON.stringify(body)} -> ${s} ${JSON.stringify(j)}`);
    return j.id;
  }
  async function user(name: string): Promise<[string, string]> {
    const email = `${name.toLowerCase()}@example.com`;
    const id = await mk(su, "users", {
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name,
      verified: true,
    });
    await api("PATCH", `/api/collections/users/records/${id}`, su, { approved: true });
    const [, a] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    return [a.token, id];
  }
  const [olive, oliveId] = await user("Olive");
  const [adam, adamId] = await user("Adam");
  const [mia, miaId] = await user("Mia");
  const [vic, vicId] = await user("Vic");
  const [sam, samId] = await user("Sam");
  const [nate] = await user("Nate");
  const [pat, patId] = await user("Pat");

  const WS = await mk(olive, "workspaces", { name: "Impact", owner: oliveId });
  for (const [uid, role, status] of [
    [adamId, "admin", "active"],
    [miaId, "member", "active"],
    [vicId, "viewer", "active"],
    [samId, "member", "suspended"],
  ])
    await mk(su, "workspace_members", { workspace: WS, user: uid, role, status });

  // Every workspace gives its owner a roster row; the owner is not a member the delete removes.
  const [, ownRow] = await api(
    "GET",
    `/api/collections/workspace_members/records?filter=${encodeURIComponent(`workspace='${WS}' && user='${oliveId}'`)}`,
    su,
  );
  check("(fixture) the owner holds a roster row of her own", ownRow.totalItems, 1);
  const P1 = await mk(olive, "projects", { name: "P1", workspace: WS });
  const P2 = await mk(olive, "projects", { name: "P2 trashed", workspace: WS });
  await mk(olive, "projects", { name: "P3", workspace: WS });
  // Live items across all four collections; one task sits in the soon-trashed project.
  await mk(olive, "tasks", { title: "t1", workspace: WS, project: P1 });
  await mk(olive, "tasks", { title: "t2", workspace: WS });
  await mk(olive, "tasks", { title: "t-in-p2", workspace: WS, project: P2 });
  await mk(olive, "documents", { title: "d1", workspace: WS, project: P1 });
  await mk(mia, "documents", { title: "d-draft-mia", workspace: WS, project: P1, draft: true });
  await mk(olive, "decisions", { title: "dec1", workspace: WS, project: P1 });
  await mk(olive, "milestones", { name: "m1", workspace: WS, project: P1 });
  // Trashed items: DELETE as owner soft-deletes.
  const tt = await mk(olive, "tasks", { title: "t-trashed", workspace: WS, project: P1 });
  const dt = await mk(olive, "documents", { title: "d-trashed", workspace: WS, project: P1 });
  const mt = await mk(olive, "milestones", { name: "m-trashed", workspace: WS, project: P1 });
  for (const [c, id] of [
    ["tasks", tt],
    ["documents", dt],
    ["milestones", mt],
  ])
    check(
      `trash ${c} row`,
      (await api("DELETE", `/api/collections/${c}/records/${id}`, olive))[0],
      204,
    );
  check(
    "trash project P2",
    (await api("DELETE", `/api/collections/projects/records/${P2}`, olive))[0],
    204,
  );
  // Saved views: shared + the owner's personal + Mia's personal.
  const sv = (token: string, owner: string, name: string, scope: string) =>
    mk(token, "saved_views", { workspace: WS, owner, name, scope, filterData: {} });
  await sv(olive, oliveId, "shared", "workspace");
  await sv(olive, oliveId, "olive personal", "personal");
  await sv(mia, miaId, "mia personal", "personal");

  // A second workspace whose rows must never be counted.
  const WS2 = await mk(pat, "workspaces", { name: "Other", owner: patId });
  const Q = await mk(pat, "projects", { name: "Q", workspace: WS2 });
  await mk(pat, "tasks", { title: "other", workspace: WS2, project: Q });
  await mk(pat, "documents", { title: "other doc", workspace: WS2 });
  const ot = await mk(pat, "tasks", { title: "other trashed", workspace: WS2, project: Q });
  await api("DELETE", `/api/collections/tasks/records/${ot}`, pat);
  await mk(su, "workspace_members", {
    workspace: WS2,
    user: vicId,
    role: "member",
    status: "active",
  });
  await mk(pat, "saved_views", {
    workspace: WS2,
    owner: patId,
    name: "other view",
    scope: "workspace",
    filterData: {},
  });

  const route = (id: string, token: string | null) =>
    api("GET", `/api/tracker/workspaces/${id}/deletion-impact`, token);

  console.log("\n── owner: exact counts ──");
  const EXPECT = { items: 7, trashed_items: 3, projects: 3, members: 4, saved_views: 3 };
  let [s, j] = await route(WS, olive);
  console.log(`  owner response: ${s} ${JSON.stringify(j)}`);
  check("owner → 200", s, 200);
  check("exact counts", j, EXPECT);
  check(
    "every field is an integer",
    Object.values(j).every((v) => Number.isInteger(v)),
    true,
  );

  const [, live] = await api(
    "GET",
    `/api/collections/tasks/records?filter=${encodeURIComponent(`workspace='${WS}'`)}&perPage=200`,
    olive,
  );
  const listed = (live.items ?? []).map((t: any) => t.title).sort();
  console.log(`  owner's own task list: ${JSON.stringify(listed)}`);
  check(
    "owner's task list hides the trashed task the route counts",
    listed.includes("t-trashed"),
    false,
  );

  console.log("\n── everyone else: identical 404 ──");
  const [, , unknownRaw] = await route("zzzzzzzzzzzzzzz", olive);
  for (const [who, tok] of [
    ["admin", adam],
    ["member", mia],
    ["viewer", vic],
    ["non-member", nate],
    ["superuser", su],
  ] as const) {
    const [st, , raw] = await route(WS, tok);
    console.log(`  ${who}: ${st}`);
    check(`${who} → 404, body identical to unknown id`, [st, raw], [404, unknownRaw]);
  }
  const [us] = await route("zzzzzzzzzzzzzzz", olive);
  check("unknown id → 404", us, 404);
  const [as] = await route(WS, null);
  console.log(`  anonymous: ${as}`);
  check("anonymous → 401", as, 401);

  console.log("\n── trashed workspace stays readable by its owner ──");
  check(
    "trash the workspace",
    (await api("DELETE", `/api/collections/workspaces/records/${WS}`, olive))[0],
    204,
  );
  [s, j] = await route(WS, olive);
  console.log(`  owner after trash: ${s} ${JSON.stringify(j)}`);
  check("owner → 200 on trashed workspace", s, 200);
  check("counts unchanged by the trash", j, EXPECT);
  check("admin still 404 on trashed workspace", (await route(WS, adam))[0], 404);
} catch (e) {
  failures += 1;
  console.log(`  ❌ suite aborted: ${e}`);
} finally {
  if (server) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}
console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED (${passes} passed)`);
  process.exit(1);
}
console.log(`✅ all ${passes} deletion-impact proofs passed`);
process.exit(0);

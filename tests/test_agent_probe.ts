#!/usr/bin/env bun
/** Agent probe: drives the API as one normal member would, logging every call and asserting today's behaviour, friction included. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8152 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const RATE_LIMIT = 300; // the `/api/` rule in the settings migration
const BURST_CAP = 700; // hard stop if no 429 ever arrives

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(64)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
  );
}

async function api(
  method: string,
  p: string,
  token: string | null = null,
  body: any = null,
  headers: Record<string, string> = {},
): Promise<[number, any, Headers]> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (token) h.Authorization = token;
  const r = await fetch(BASE_URL + p, {
    method,
    headers: h,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  console.log(`    ${method} ${decodeURIComponent(p.replaceAll("+", " "))} -> ${r.status}`);
  return [r.status, raw ? JSON.parse(raw) : {}, r.headers];
}

const list = (coll: string, params: Record<string, any>): string =>
  `/api/collections/${coll}/records?${urlencode(params)}`;
const titles = (items: any[]): string[] => items.map((i) => i.title ?? i.name).sort();

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-agent-probe-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(path.join(REPO_ROOT, "pb_migrations"), MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
let sse: roomkit.SSEListener | null = null;
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

  // Superuser seeding: Alice owns her workspace, Bob is its second (plain) member, Carol is outside.
  const seed = Bun.spawn([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: BASE_URL,
      PB_SUPERUSER_EMAIL: SU_EMAIL,
      PB_SUPERUSER_PASSWORD: SU_PASSWORD,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [seed_out, seed_err, seed_rc] = await Promise.all([
    new Response(seed.stdout).text(),
    new Response(seed.stderr).text(),
    seed.exited,
  ]);
  check("seed.ts exit code", seed_rc, 0);
  if (seed_rc !== 0) {
    console.log(seed_out, seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  let s: number, r: any, hdr: Headers;

  console.log("\n── sign in as Bob, a normal member ──");
  [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "bob@example.com",
    password: "test123456",
  });
  check("auth-with-password → 200", s, 200);
  const bob: string = r.token;
  const BOB: string = r.record.id;

  console.log("\n── workspaces and Bob's role in each ──");
  const ws_window_start = Date.now();
  [s, r] = await api("GET", list("workspaces", { sort: "name" }), bob);
  check("workspaces list → 200", s, 200);
  check("workspaces Bob can see", titles(r.items), ["Alice's Workspace", "Bob's Workspace"]);
  check(
    "a workspace record carries no role field",
    r.items.some((w: any) => "role" in w),
    false,
  );
  const WS: string = r.items.find((w: any) => w.name === "Alice's Workspace").id;
  const OWN_WS: string = r.items.find((w: any) => w.name === "Bob's Workspace").id;
  check(
    "Bob's Workspace names Bob as its owner",
    r.items.find((w: any) => w.id === OWN_WS).owner,
    BOB,
  );
  [s, r] = await api("GET", list("workspace_members", { filter: `user='${BOB}'` }), bob);
  check("workspace_members for Bob → 200", s, 200);
  check(
    "membership rows: (workspace, role) per row",
    r.items
      .map((m: any) => [
        m.workspace === WS ? "Alice's" : m.workspace === OWN_WS ? "Bob's" : m.workspace,
        m.role,
      ])
      .sort(),
    [
      ["Alice's", "member"],
      ["Bob's", "admin"],
    ],
  );

  console.log("\n── resolve the ids a filter needs ──");
  [s, r] = await api("GET", list("projects", { filter: `workspace='${WS}'` }), bob);
  check("projects in Alice's workspace", titles(r.items), ["Website Redesign"]);
  const PROJ: string = r.items.find((p: any) => p.name === "Website Redesign").id;
  [s, r] = await api("GET", list("statuses", { filter: `workspace='${WS}'`, perPage: 50 }), bob);
  check("statuses list → 200", s, 200);
  const ST: Record<string, string> = Object.fromEntries(r.items.map((x: any) => [x.name, x.id]));
  [s, r] = await api("GET", list("labels", { filter: `workspace='${WS}'`, perPage: 50 }), bob);
  check("labels list → 200", s, 200);
  check("the workspace has two labels to filter by", r.items.length >= 2, true);
  const [LABEL, OTHER_LABEL]: string[] = r.items.map((x: any) => x.id);

  console.log("\n── realtime: subscribe to tasks before changing one ──");
  sse = new roomkit.SSEListener(BASE_URL, bob, "tasks");
  check("SSE stream connected (PB_CONNECT clientId)", (await sse.start()) !== null, true);
  console.log(`    GET /api/realtime -> stream (clientId ${sse.client_id})`);
  console.log(
    `    POST /api/realtime {subscriptions: ["tasks"]} -> (status not surfaced by the listener)`,
  );
  await Bun.sleep(1000); // let the subscribe POST land before the first write

  console.log("\n── create a task and a document ──");
  [s, r] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "Probe zephyr task",
    project: PROJ,
    status: ST.Todo,
    assignee: BOB,
    due: "2026-12-01 00:00:00.000Z",
    labels: [LABEL],
  });
  check("task create → 200", s, 200);
  check("task workspace filled from its project", r.workspace, WS);
  const TASK: string = r.id;
  [s, r] = await api("POST", "/api/collections/documents/records", bob, {
    title: "Probe zephyr doc",
    body: "notes",
    workspace: WS,
    project: PROJ,
  });
  check("document create → 200", s, 200);
  const DOC: string = r.id;

  console.log("\n── patch the task, then once with an unknown key ──");
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${TASK}`, bob, {
    title: "Probe zephyr task v2",
    status: ST["In Progress"],
  });
  check("task patch → 200, title saved", [s, r.title], [200, "Probe zephyr task v2"]);
  for (let i = 0; i < 50 && sse.events.length < 2; i++) await Bun.sleep(100);
  const evs = sse.events.filter((e: any) => e.record?.id === TASK);
  check(
    "realtime events for the task",
    evs.map((e: any) => [e.action, e.record.title]),
    [
      ["create", "Probe zephyr task"],
      ["update", "Probe zephyr task v2"],
    ],
  );
  sse.stop = true;
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${TASK}`, bob, {
    title: "Probe zephyr task v3",
    estimate: 3,
  });
  check(
    "patch with unknown key `estimate` → 400 naming it",
    [s, String(r.message ?? "").includes("estimate")],
    [400, true],
  );
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${TASK}`, bob, {
    title: "Probe zephyr task v3",
  });
  check("patch without it → 200, title saved", [s, r.title], [200, "Probe zephyr task v3"]);

  console.log("\n── list through project_items, one filter at a time ──");
  // A decoy the due bound and the label id must each exclude.
  [s] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "Probe later task",
    project: PROJ,
    status: ST.Todo,
    due: "2027-03-01 00:00:00.000Z",
    labels: [OTHER_LABEL],
  });
  check("decoy task create → 200", s, 200);
  const items = async (filter: string): Promise<[number, any]> => {
    const [st, body] = await api(
      "GET",
      list("project_items", { filter: `workspace='${WS}' && (${filter})`, perPage: 200 }),
      bob,
    );
    return [st, st === 200 ? titles(body.items) : body];
  };
  check("type='document'", await items("type='document'"), [200, ["Probe zephyr doc"]]);
  check("status=In Progress id", await items(`status='${ST["In Progress"]}'`), [
    200,
    ["Design homepage", "Probe zephyr task v3"],
  ]);
  check("assignee=Bob", await items(`assignee='${BOB}'`), [
    200,
    ["Probe zephyr task v3", "Wire up nav"],
  ]);
  check("due on or before 2026-12-31", await items("due != '' && due <= '2026-12-31'"), [
    200,
    ["Probe zephyr task v3"],
  ]);
  check("labels ~ label id", await items(`labels ~ '${LABEL}'`), [200, ["Probe zephyr task v3"]]);
  const [ns, nb] = await items("status.name = 'In Progress'");
  check(
    "filter by status NAME through the view names the field",
    [ns, nb?.data?.status?.code],
    [400, "not_expressible"],
  );

  console.log("\n── comment, search ──");
  [s, r] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK,
    body: "looks good",
  });
  check("comment create (no author in body)", [s, r.author ?? null], [200, BOB]);
  [s, r] = await api("GET", `/api/tracker/search?${urlencode({ q: "zephyr" })}`, bob);
  check("search → 200", s, 200);
  check(
    "search hits",
    (r.results ?? []).map((h: any) => [h.collection, h.id]).sort(),
    [
      ["documents", DOC],
      ["tasks", TASK],
    ].sort(),
  );

  console.log("\n── trash the task and read it back ──");
  [s] = await api("DELETE", `/api/collections/tasks/records/${TASK}`, bob);
  check("task DELETE → 204", s, 204);
  [s] = await api("GET", `/api/collections/tasks/records/${TASK}`, bob);
  check("trashed task by id", s, 404);
  [s, r] = await api("GET", `/api/tracker/trash?${urlencode({ workspace: WS })}`, bob);
  check("trash list → 200", s, 200);
  check(
    "trash rows",
    (r.items ?? []).map((i: any) => [i.collection, i.record.id, i.record.trashed_by]),
    [["tasks", TASK, BOB]],
  );

  console.log("\n── rate limit: more than 300 requests inside 60s ──");
  const statuses: number[] = [];
  let first429: any = null;
  let first429_hdr: Headers | null = null;
  const t0 = Date.now();
  while (first429 === null && statuses.length < BURST_CAP) {
    [s, r, hdr] = await api("GET", list("workspaces", { perPage: 1 }), bob);
    statuses.push(s);
    if (s === 429) [first429, first429_hdr] = [r, hdr];
  }
  console.log(`    (burst: ${statuses.length} requests in ${Date.now() - t0} ms)`);
  check("the burst met a 429 under the hard cap", first429 !== null, true);
  check(
    "the bucket's fixed 60s window has not rolled over",
    Date.now() - ws_window_start < 60_000,
    true,
  );
  // PB's limiter is a fixed window per (collection, route, IP), not a shared /api/ pool or a
  // refilling bucket: only Bob's one earlier workspaces list shares this bucket, so 300 - 1.
  check(
    "200s before the first 429 (workspaces list bucket)",
    statuses.filter((x) => x === 200).length,
    RATE_LIMIT - 1,
  );
  check("429 body", first429, { data: {}, message: "Too Many Requests.", status: 429 });
  check(
    "429 rate headers (Retry-After / X-RateLimit-*)",
    [...(first429_hdr?.keys() ?? [])].filter((k) => /retry-after|ratelimit/i.test(k)),
    [],
  );
  [s] = await api("GET", list("projects", { perPage: 1 }), bob);
  check("same token, another collection's list after the 429", s, 200);
  [s] = await api("GET", list("workspaces", { perPage: 1 }), bob);
  check("same token + route again, no header (control)", s, 429);
  [s] = await api("GET", list("workspaces", { perPage: 1 }), bob, null, {
    "X-Forwarded-For": "203.0.113.7",
  });
  check("same token + route, client-set X-Forwarded-For after the 429", s, 200);
} finally {
  if (sse !== null) sse.stop = true;
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ agent probe: every step behaved as recorded");
process.exit(0);

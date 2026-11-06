#!/usr/bin/env bun
/**
 * The counts route groups by item type, the trash route counts trash per type, and trash rows flag a retired priority.
 *
 * Port 8171 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8171 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(78)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
  );
}

async function api(
  method: string,
  p: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  try {
    r = await fetch(BASE_URL + p, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-counts-type-trash-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

/** {key: count} from a grouped answer, so bucket order does not matter. */
function buckets(r: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of r?.items ?? []) out[String(b.key)] = b.count;
  return out;
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

  const [, sur] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  if (!truthy(sur.token)) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(sur)}`);

  const seed = Bun.spawnSync([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: BASE_URL,
      PB_SUPERUSER_EMAIL: SU_EMAIL,
      PB_SUPERUSER_PASSWORD: SU_PASSWORD,
    },
  });
  if (seed.exitCode !== 0) {
    console.log(seed.stdout.toString(), seed.stderr.toString());
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const [alice] = await login("alice@example.com");
  const [bob] = await login("bob@example.com");
  const [, wss] = await api(
    "GET",
    `/api/collections/workspaces/records?${urlencode({ filter: "name='Alice\\'s Workspace'" })}`,
    alice,
  );
  const WS = getitem(wss.items[0], "id");
  const VOCAB = wss.items[0].priorities as { id: string; name: string }[];
  const [ps, proj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Type count fixture",
    workspace: WS,
  });
  if (ps !== 200) throw new roomkit.SystemExit(`project create failed: ${py_str(proj)}`);
  const P = proj.id;
  const make = async (collection: string, fields: Record<string, any>) => {
    const [s, r] = await api("POST", `/api/collections/${collection}/records`, alice, {
      workspace: WS,
      project: P,
      ...fields,
    });
    if (s !== 200) throw new roomkit.SystemExit(`${collection} create failed: ${py_str(r)}`);
    return r.id as string;
  };
  const KEPT = VOCAB[0].id;
  const RETIRED = VOCAB[1].id;
  const tKept = await make("tasks", { title: "kept priority", priority: KEPT });
  const tRetired = await make("tasks", { title: "retired priority", priority: RETIRED });
  await make("tasks", { title: "plain task" });
  const doc1 = await make("documents", { title: "doc one" });
  await make("documents", { title: "doc two" });
  await make("decisions", { title: "a decision" });
  const ms = await make("milestones", { name: "a milestone" });

  console.log("\n── GET /api/tracker/project-items/counts?group=type: one bucket per item type ──");
  const inP = `project = "${P}"`;
  for (const [who, tok] of [
    ["owner", alice],
    ["member", bob],
  ] as const) {
    const [s, r] = await api(
      "GET",
      `/api/tracker/project-items/counts?${urlencode({ group: "type", filter: inP })}`,
      tok,
    );
    check(`${who}: group=type status`, s, 200);
    check(`${who}: buckets`, buckets(r), { task: 3, document: 2, decision: 1, milestone: 1 });
    check(`${who}: total`, r.total ?? null, 7);
  }

  console.log("\n── trash counted per type, matching the rows GET /api/tracker/trash returns ──");
  for (const [col, id] of [
    ["tasks", tKept],
    ["tasks", tRetired],
    ["documents", doc1],
    ["milestones", ms],
  ] as const) {
    const [s] = await api("DELETE", `/api/collections/${col}/records/${id}`, alice);
    check(`trash ${col} ${id}`, s, 204);
  }
  for (const [label, filter] of [
    ["this project", inP],
    ["whole workspace", ""],
  ] as const) {
    const q: Record<string, string> = { workspace: WS };
    if (filter) q.filter = filter;
    const [gs, gr] = await api(
      "GET",
      `/api/tracker/trash?${urlencode({ ...q, group: "type" })}`,
      alice,
    );
    const [rs, rr] = await api(
      "GET",
      `/api/tracker/trash?${urlencode({ ...q, perPage: "500" })}`,
      alice,
    );
    const tally: Record<string, number> = {};
    const TYPE: Record<string, string> = {
      tasks: "task",
      documents: "document",
      decisions: "decision",
      milestones: "milestone",
    };
    for (const it of rr.items ?? [])
      tally[TYPE[it.collection]] = (tally[TYPE[it.collection]] ?? 0) + 1;
    check(`${label}: group=type status / rows status`, [gs, rs], [200, 200]);
    check(`${label}: per-type trash counts equal the trash rows' tally`, buckets(gr), tally);
    check(`${label}: grouped total equals the rows' count`, gr.total ?? null, rr.count ?? null);
    if (filter)
      check(`${label}: seeded trash per type`, buckets(gr), { task: 2, document: 1, milestone: 1 });
  }
  const [ls, lr] = await api(
    "GET",
    `/api/tracker/project-items/counts?${urlencode({ group: "type", filter: inP })}`,
    alice,
  );
  check(
    "live counts no longer include the trashed items",
    [ls, buckets(lr)],
    [200, { task: 1, document: 1, decision: 1 }],
  );

  console.log("\n── a trashed task whose priority was retired reads has_priority false ──");
  const [vs, vr] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, alice, {
    priorities: VOCAB.filter((p) => p.id !== RETIRED),
  });
  check(
    "(fixture) retire one priority from the vocabulary",
    [vs, (vr.priorities ?? []).some((p: any) => p.id === RETIRED)],
    [200, false],
  );
  const [ts, tr] = await api(
    "GET",
    `/api/tracker/trash?${urlencode({ workspace: WS, filter: inP })}`,
    alice,
  );
  const flag = (id: string) =>
    (tr.items ?? []).find((it: any) => it.record?.id === id)?.has_priority ?? null;
  check("trash status", ts, 200);
  check("trashed task with a retired priority id → has_priority false", flag(tRetired), false);
  check("trashed task with a live priority id → has_priority true", flag(tKept), true);
  check("trashed document (no priority) → has_priority false", flag(doc1), false);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all type-count and trash-count proofs passed");
  process.exit(0);
}

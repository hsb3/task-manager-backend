#!/usr/bin/env bun
/**
 * project_stats names each project's next milestone: the earliest live one due on or after the viewer's today, else the latest.
 *
 * Port 8172 + PB_PORT_OFFSET.
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
const PORT = 8172 + PORT_OFFSET;
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-next-milestone-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

/** A stored target date `days` calendar days from today in UTC. */
function targetFromToday(days: number): string {
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  return `${new Date(today + days * 86400000).toISOString().slice(0, 10)} 12:00:00.000Z`;
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
  const [carol] = await login("carol@example.com");
  const [, wss] = await api(
    "GET",
    `/api/collections/workspaces/records?${urlencode({ filter: "name='Alice\\'s Workspace'" })}`,
    alice,
  );
  const WS = getitem(wss.items[0], "id");
  const project = async (name: string) => {
    const [s, r] = await api("POST", "/api/collections/projects/records", alice, {
      name,
      workspace: WS,
    });
    if (s !== 200) throw new roomkit.SystemExit(`project create failed: ${py_str(r)}`);
    return r.id as string;
  };
  const milestone = async (
    P: string,
    name: string,
    days: number | null,
    extra: Record<string, any> = {},
  ) => {
    const [s, r] = await api("POST", "/api/collections/milestones/records", alice, {
      name,
      workspace: WS,
      project: P,
      ...(days === null ? {} : { target: targetFromToday(days) }),
      ...extra,
    });
    if (s !== 200) throw new roomkit.SystemExit(`milestone create failed: ${py_str(r)}`);
    return r.id as string;
  };
  const nextOf = async (token: string, P: string): Promise<[number, any]> => {
    const [s, r] = await api("GET", `/api/collections/project_stats/records/${P}`, token);
    return [s, s === 200 ? (r.next_milestone ?? "field absent") : null];
  };

  const future = await project("two future milestones");
  await milestone(future, "in ten days", 10);
  const soon = await milestone(future, "in five days", 5);
  const trashedSoon = await milestone(future, "in one day, trashed", 1);
  await milestone(future, "in two days, draft", 2, { draft: true });
  const [ts] = await api("DELETE", `/api/collections/milestones/records/${trashedSoon}`, alice);
  if (ts !== 204) throw new roomkit.SystemExit(`milestone trash failed: ${ts}`);
  const past = await project("only past milestones");
  await milestone(past, "ten days ago", -10);
  const lastPast = await milestone(past, "three days ago", -3);
  const today = await project("one due today");
  const dueToday = await milestone(today, "today", 0);
  await milestone(today, "next week", 7);
  const none = await project("no dated milestones");
  await milestone(none, "no target", null);
  const empty = await project("no milestones");

  const CASES: [string, string, string][] = [
    [
      "two future milestones, a trashed sooner one and a draft sooner one → earliest live published",
      future,
      soon,
    ],
    ["only past milestones → the latest", past, lastPast],
    ["a milestone due today counts as upcoming", today, dueToday],
    ["only an undated milestone → empty", none, ""],
    ["no milestones → empty", empty, ""],
  ];
  for (const [who, tok] of [
    ["owner", alice],
    ["member", bob],
  ] as const) {
    console.log(`\n── ${who} reads project_stats.next_milestone ──`);
    for (const [label, P, want] of CASES)
      check(`${who}: ${label}`, await nextOf(tok, P), [200, want]);
  }
  console.log("\n── reading rules unchanged ──");
  check("non-member reading a project's stats → 404", (await nextOf(carol, future))[0], 404);
  const [ls, lr] = await api(
    "GET",
    `/api/collections/project_stats/records?${urlencode({ filter: `id = "${past}"` })}`,
    alice,
  );
  check(
    "the list carries it too",
    [ls, lr.items?.[0]?.next_milestone ?? "field absent"],
    [200, lastPast],
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
  console.log("✅ all next-milestone proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * project_items rows carry due_days and the inbox reason, and trash rows purge_days, counted in the viewer's day.
 *
 * Port 8170 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8170 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const LIST = "/api/collections/project_items/records";
const EAST = "Pacific/Kiritimati"; // UTC+14
const WEST = "Pacific/Pago_Pago"; // UTC-11

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

/** A calendar day as a whole-day number, so two of them subtract to a day count. */
function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** The calendar day an instant falls on in a zone, as YYYY-MM-DD. */
function dayIn(zone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
}

/** A stored due date `days` calendar days from today in `zone`. */
function dueFromToday(zone: string, days: number): string {
  const d = new Date((dayNumber(dayIn(zone)) + days) * 86400000);
  return `${d.toISOString().slice(0, 10)} 12:00:00.000Z`;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-due-window-test-"));
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

  const [, sur] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  if (!truthy(sur.token)) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(sur)}`);
  const su: string = sur.token;

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

  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const [, wss] = await api(
    "GET",
    `/api/collections/workspaces/records?${urlencode({ filter: "name='Alice\\'s Workspace'" })}`,
    alice,
  );
  const WS = getitem(wss.items[0], "id");
  const [ps, proj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Due window fixture",
    workspace: WS,
  });
  if (ps !== 200) throw new roomkit.SystemExit(`project create failed: ${py_str(proj)}`);
  const P = proj.id;
  const statusOf = async (category: string) => {
    const [, r] = await api(
      "GET",
      `/api/collections/statuses/records?${urlencode({ filter: `workspace='${WS}' && category='${category}'` })}`,
      alice,
    );
    return getitem(r.items[0], "id");
  };
  const OPEN = await statusOf("unstarted");
  const DONE = await statusOf("completed");
  const task = async (title: string, fields: Record<string, any>) => {
    const [s, r] = await api("POST", "/api/collections/tasks/records", su, {
      title,
      workspace: WS,
      project: P,
      status: OPEN,
      ...fields,
    });
    if (s !== 200) throw new roomkit.SystemExit(`task create failed: ${py_str(r)}`);
    return r.id as string;
  };

  // Alice reads in her saved zone; Bob has none saved, so he sends one with the request.
  const [ss, sr] = await api("PATCH", `/api/tracker/users/${alice_id}/settings`, alice, {
    time_zone: EAST,
  });
  if (ss !== 200) throw new roomkit.SystemExit(`settings save failed: ${py_str(sr)}`);

  const ids: Record<string, string> = {};
  for (const days of [-1, 0, 3, 4]) {
    ids[`d${days}`] = await task(`due ${days}`, {
      assignee: bob_id,
      due: dueFromToday(WEST, days),
    });
  }
  ids.nodue = await task("no due", { assignee: bob_id });
  ids.done = await task("done overdue", {
    assignee: bob_id,
    due: dueFromToday(WEST, -1),
    status: DONE,
  });
  ids.others = await task("alice's overdue", { assignee: alice_id, due: dueFromToday(WEST, -1) });
  const [ms, mr] = await api("POST", "/api/collections/milestones/records", alice, {
    name: "past milestone",
    workspace: WS,
    project: P,
    target: dueFromToday(WEST, -2),
  });
  if (ms !== 200) throw new roomkit.SystemExit(`milestone create failed: ${py_str(mr)}`);
  ids.milestone = mr.id;

  const rows = async (token: string, zone: string | null) => {
    const q: Record<string, string | number> = { filter: `project = "${P}"`, perPage: 200 };
    if (zone !== null) q.time_zone = zone;
    const [s, r] = await api("GET", `${LIST}?${urlencode(q)}`, token);
    if (s !== 200) return { status: s, body: r };
    const byId: Record<string, any> = {};
    for (const it of r.items) byId[it.id] = it;
    return { status: s, byId, items: r.items as any[] };
  };

  console.log(
    `\n── an assignee's list carries due_days and reason on every row (viewer zone ${WEST}) ──`,
  );
  const bobRows = await rows(bob, WEST);
  check("list status", bobRows.status, 200);
  const items = bobRows.items ?? [];
  check(
    "every row has a due_days key",
    items.every((it) => "due_days" in it),
    true,
  );
  check(
    "every row has a reason key",
    items.every((it) => "reason" in it),
    true,
  );
  const pick = (id: string) => {
    const it = bobRows.byId?.[id] ?? {};
    return [it.due_days ?? null, it.reason ?? null];
  };
  check("due -1 day → overdue", pick(ids["d-1"]), [-1, "overdue"]);
  check("due today (0) → due_soon", pick(ids.d0), [0, "due_soon"]);
  check("due in 3 days → due_soon", pick(ids.d3), [3, "due_soon"]);
  check("due in 4 days → assigned", pick(ids.d4), [4, "assigned"]);
  check("no due date → due_days null, assigned", pick(ids.nodue), [null, "assigned"]);
  check("a done task due yesterday carries no overdue reason", pick(ids.done), [-1, ""]);
  check("someone else's overdue task carries no reason for this viewer", pick(ids.others), [
    -1,
    "",
  ]);
  const msDays = bobRows.byId?.[ids.milestone]?.due_days ?? null;
  check(
    "a milestone past its target date has due_days < 0",
    typeof msDays === "number" && msDays < 0,
    true,
  );
  check("  (milestone due_days, target two days back)", msDays, -2);
  const [vs, vr] = await api("GET", `${LIST}/${ids["d-1"]}?${urlencode({ time_zone: WEST })}`, bob);
  check(
    "view of one row carries the same values",
    [vs, vr.due_days ?? null, vr.reason ?? null],
    [200, -1, "overdue"],
  );

  console.log("\n── the same due read from either side of the date line ──");
  // The two zones are 25 hours apart, so their calendar days always differ.
  const D = "2026-06-15 10:30:00.000Z";
  ids.edge = await task("date line", { assignee: bob_id, due: D });
  const eastRows = await rows(alice, null);
  const westRows = await rows(bob, WEST);
  const eastDays = eastRows.byId?.[ids.edge]?.due_days ?? null;
  const westDays = westRows.byId?.[ids.edge]?.due_days ?? null;
  const wantEast = dayNumber(D) - dayNumber(dayIn(EAST));
  const wantWest = dayNumber(D) - dayNumber(dayIn(WEST));
  console.log(`  (today: ${EAST} ${dayIn(EAST)}, ${WEST} ${dayIn(WEST)})`);
  check(`${EAST} viewer (saved zone) → due_days for their calendar day`, eastDays, wantEast);
  check(`${WEST} viewer (zone sent with the request) → due_days for theirs`, westDays, wantWest);
  check("the two viewers get different due_days", eastDays !== westDays, true);
  const pref = await rows(alice, WEST);
  check(
    "a saved zone wins over one sent with the request",
    pref.byId?.[ids.edge]?.due_days ?? null,
    wantEast,
  );
  const utc = await rows(bob, null);
  check(
    "no saved zone and none sent → UTC",
    utc.byId?.[ids.edge]?.due_days ?? null,
    dayNumber(D) - dayNumber(dayIn("UTC")),
  );
  const bad = await rows(bob, "Mars/Olympus_Mons");
  check("an unknown zone sent with the request → 400", bad.status, 400);
  const local = await rows(bob, "Local");
  check("the server's own zone (Local) is not a viewer zone → 400", local.status, 400);

  console.log("\n── trash rows carry purge_days, counted in the viewer's day ──");
  const [ds] = await api("DELETE", `/api/collections/tasks/records/${ids.d4}`, alice);
  check("trash a task", ds, 204);
  // Backdate the trash so purge_at's day differs between the two zones by a different amount than
  // today's does (2 days apart from 10:00 to 11:00 UTC, 1 otherwise): only a zone-aware count passes.
  const todayGap = dayNumber(dayIn(EAST)) - dayNumber(dayIn(WEST));
  const at = new Date(
    (dayNumber(dayIn("UTC")) - 5) * 86400000 + (todayGap === 2 ? 15.5 : 10.5) * 3600000,
  );
  const trashedAt = at.toISOString().replace("T", " ");
  const [bk, br] = await api("PATCH", `/api/collections/tasks/records/${ids.d4}`, su, {
    trashed: trashedAt,
  });
  check("(fixture) superuser backdates the trash time", [bk, br.trashed ?? null], [200, trashedAt]);
  const purgeDays: Record<string, any> = {};
  const trashRow = async (token: string, zone: string | null) => {
    const q: Record<string, string> = { workspace: WS };
    if (zone !== null) q.time_zone = zone;
    const [s, r] = await api("GET", `/api/tracker/trash?${urlencode(q)}`, token);
    return [s, (r.items ?? []).find((it: any) => it.record?.id === ids.d4) ?? null] as const;
  };
  for (const [who, tok, zone, shown] of [
    ["Alice", alice, null, EAST],
    ["Bob", bob, WEST, WEST],
  ] as const) {
    const [s, row] = await trashRow(tok, zone);
    const purgeAt = row?.purge_at ?? null;
    const want = purgeAt
      ? dayNumber(dayIn(shown, new Date(purgeAt.replace(" ", "T")))) - dayNumber(dayIn(shown))
      : "purge_at missing";
    console.log(`  (${who}: purge_at ${purgeAt})`);
    purgeDays[who] = row?.purge_days ?? null;
    check(
      `${who} (${shown}): purge_days = purge_at's day − today, both in ${shown}`,
      [s, row?.purge_days ?? null],
      [200, want],
    );
  }
  check("the two viewers get different purge_days", purgeDays.Alice !== purgeDays.Bob, true);
  const [bs] = await trashRow(bob, "Mars/Olympus_Mons");
  check("trash with an unknown zone → 400", bs, 400);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all due-window proofs passed");
  process.exit(0);
}

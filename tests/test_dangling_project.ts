#!/usr/bin/env bun
/**
 * Proof that a purged project takes every child with it, and that a child its cascade missed is never readable.
 *
 * PocketBase's cascade scans for children once, so an item committed between that scan and the
 * commit survives its own parent. The purge sweep in pb_hooks/trash.pb.js collects it on its next
 * pass; until then every member read surface must exclude it. Section (2) constructs the missed row
 * deterministically with a probe hook and proves cycle rollover leaves it behind, section (3) runs the
 * real race and asserts the invariants on whatever it produced (live realtime feeds included), and
 * section (4) is the invariant a sweep leaves behind.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures built by name.
 * Port 8121 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_repr,
  py_str,
  truthy,
  tup,
  url_error_reason,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8121 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";
const CHILDREN = ["tasks", "documents", "decisions", "milestones"];

// Written into a hooks COPY at run time, never into pb_hooks/. The priority is what makes this
// deterministic: it runs before the sweep, so it plants exactly the row a cascade scan missed.
const PROBE_HOOK = `/// <reference path="../pb_data/types.d.ts" />
// PROBE ONLY (tests/test_dangling_project.ts) — never shipped.
// Raw SQL on purpose: a create whose project is already gone is refused by the coherence guard,
// so the only way to construct the row a cascade scan missed is to write it under the hooks.
// The priority puts this before the sweep, which is what makes the section deterministic.
$app.onRecordAfterDeleteSuccess("projects").bind({
  id: "plantMissedChild",
  priority: -2000,
  func: (e) => {
    var wsId = String(e.record.get("workspace"));
    var plan = [
      ["tasks", "title"],
      ["documents", "title"],
      ["decisions", "title"],
      ["milestones", "name"],
    ];
    for (var i = 0; i < plan.length; i++) {
      try {
        e.app
          .db()
          .newQuery(
            "INSERT INTO " + plan[i][0] +
            " (id, " + plan[i][1] + ", workspace, project, created, updated) VALUES " +
            "({:id}, 'plantedafterpurge', {:ws}, {:pr}, datetime('now'), datetime('now'))",
          )
          .bind({
            id: "plant" + plan[i][0].substring(0, 5) + e.record.id.substring(0, 5),
            ws: wsId,
            pr: e.record.id,
          })
          .execute();
      } catch (err) {
        e.app.logger().error("probe plant failed", "c", plan[i][0], "err", String(err));
      }
    }
    // The planted task is assigned to the member, sits on the ended probe cycle once one exists,
    // and carries a comment and an activity row.
    var suffix = e.record.id.substring(0, 5);
    var extras = [
      "UPDATE tasks SET assignee = (SELECT id FROM users WHERE email = 'max@example.com') WHERE id = {:t}",
      "UPDATE tasks SET cycle = COALESCE((SELECT id FROM cycles WHERE workspace = {:ws} " +
        "AND name = 'probeendedcycle'), '') WHERE id = {:t}",
      "INSERT INTO comments (id, task, body, created, updated) VALUES " +
        "({:c}, {:t}, 'plantedcomment', datetime('now'), datetime('now'))",
      "INSERT INTO task_activity (id, task, workspace, field, created, updated) VALUES " +
        "({:a}, {:t}, {:ws}, 'title', datetime('now'), datetime('now'))",
    ];
    for (var x = 0; x < extras.length; x++) {
      try {
        e.app
          .db()
          .newQuery(extras[x])
          .bind({ t: "planttasks" + suffix, c: "plantcomme" + suffix, a: "plantactiv" + suffix, ws: wsId })
          .execute();
      } catch (err) {
        e.app.logger().error("probe plant failed", "sql", extras[x], "err", String(err));
      }
    }
    e.next();
  },
});
`;

const CRON_POLL_DEADLINE_S = 20.0;
const SSE_DRAIN_DEADLINE_S = 15.0;

let failures = 0;
let raced_checks_skipped = false; // DECLARED SKIP: section (3)'s raced-row checks do not run for a collection the race never reached; (2) plants that row every run

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  for (let _ = 0; _ < 90; _++) {
    let r: Response;
    let raw: string;
    try {
      r = await fetch(BASE_URL + path, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
      });
      raw = await r.text();
    } catch (e) {
      return roomkit.die_no_server(BASE_URL, { reason: url_error_reason(e) });
    }
    // The room's /api/ rate limit: an answered 429 would otherwise read as "sees none".
    if (r.status === 429) {
      await Bun.sleep(1000);
      continue;
    }
    return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
  }
  throw new roomkit.SystemExit(`❌ ${method} ${path} still rate limited after 90 attempts`);
}

function start_server(
  data_dir: string,
  migrations_dir: string,
  hooks: string,
): Promise<roomkit.Room> {
  return roomkit.serve(
    PORT,
    data_dir,
    migrations_dir,
    hooks,
    path.join(S, "pb_serve.log"),
    undefined,
    30,
  );
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-dangling-project-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}
const HOOKS_DIR = path.join(S, "pb_hooks_probe");
copy_tree(roomkit.hooks_dir(S), HOOKS_DIR);
fs.writeFileSync(path.join(HOOKS_DIR, "zz_dangling_probe.pb.js"), PROBE_HOOK);

let server: roomkit.Room | null = null;
try {
  console.log("═══════ test_dangling_project.ts — a purged project leaves no children ═══════");
  const up = Bun.spawnSync(
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
    { cwd: REPO_ROOT },
  );
  if (up.exitCode !== 0) {
    throw new Error(`Command failed with exit status ${up.exitCode}: ${up.stderr.toString()}`);
  }
  server = await start_server(DATA_DIR, MIG_DIR, HOOKS_DIR);
  let s: number;
  let r: any;
  let rec: any;
  let auth: any;
  [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = roomkit.token_of(BASE_URL, SU_EMAIL, r);

  console.log("\n── fixtures ──");
  [s, rec] = await api("POST", "/api/collections/users/records", su, {
    email: "pia@example.com",
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    name: "Pia",
    verified: true,
    approved: true,
  });
  if (![200, 201].includes(s)) {
    throw new roomkit.SystemExit(`❌ fixture user not created: HTTP ${s} ${py_str(rec)}`);
  }
  const pia_id = getitem(rec, "id");
  [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "pia@example.com",
    password: PASSWORD,
  });
  const pia = roomkit.token_of(BASE_URL, "pia@example.com", auth);
  let qs = urlencode({ filter: `owner='${pia_id}'`, perPage: 50 });
  [, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, su);
  const WS = ((r.items || [{}])[0] ?? {}).id ?? null;
  check("Pia owns her auto-provisioned workspace", truthy(WS), true);
  [s, rec] = await api("POST", "/api/collections/users/records", su, {
    email: "max@example.com",
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    name: "Max",
    verified: true,
    approved: true,
  });
  if (![200, 201].includes(s)) {
    throw new roomkit.SystemExit(`❌ fixture user not created: HTTP ${s} ${py_str(rec)}`);
  }
  const max_id = getitem(rec, "id");
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: WS,
    user: max_id,
    role: "member",
    status: "active",
  });
  check("Pia adds Max as an active member", s, 200);
  [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "max@example.com",
    password: PASSWORD,
  });
  const mx = roomkit.token_of(BASE_URL, "max@example.com", auth);
  const READERS: [string, string][] = [
    ["Pia (owner)", pia],
    ["Max (member)", mx],
  ];

  const new_project = async (name: string): Promise<string> => {
    const [s, p] = await api("POST", "/api/collections/projects/records", pia, {
      name: name,
      owner: pia_id,
      workspace: WS,
    });
    check(`Pia creates project ${name}`, s, 200);
    return getitem(p, "id");
  };

  const rows_pointing_at = async (collection: string, project_id: string): Promise<string[]> => {
    const qs = urlencode({ filter: `project='${project_id}'`, perPage: 200 });
    const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, su);
    return (r.items || []).map((row: any) => getitem(row, "id"));
  };

  const child_body = (collection: string, title: string, project_id: string): any => {
    const body: Record<string, any> = { project: project_id, workspace: WS };
    body[collection === "milestones" ? "name" : "title"] = title;
    return body;
  };

  const listed = async (
    token: string | null,
    collection: string,
    project_id: string,
  ): Promise<Set<string>> => {
    const qs = urlencode({ filter: `project='${project_id}'`, perPage: 500 });
    const [s, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
    if (s !== 200) {
      throw new roomkit.SystemExit(`❌ ${collection} list answered HTTP ${s}: ${py_str(r)}`);
    }
    return new Set((r.items || []).map((row: any) => getitem(row, "id")));
  };

  const exported_ids = async (token: string | null): Promise<[number, Set<string>]> => {
    const [s, r] = await api("POST", "/api/tracker/export", token, { workspace: WS });
    const data = r.data || {};
    const ids = new Set<string>();
    for (const c of CHILDREN) {
      for (const row of data[c] || []) ids.add(getitem(row, "id"));
    }
    return [s, ids];
  };

  /** Every member read surface, for rows given as (collection, id, project). */
  const member_reads = async (
    token: string | null,
    rows: [string, string, string][],
  ): Promise<Record<string, string[]>> => {
    const [s, exported] = await exported_ids(token);
    if (s !== 200) {
      throw new roomkit.SystemExit(`❌ export answered HTTP ${s}`);
    }
    const seen: Record<string, string[]> = { list: [], view: [], project_items: [], export: [] };
    for (const [collection, rid, pid] of rows) {
      if ((await listed(token, collection, pid)).has(rid)) seen.list!.push(rid);
      if ((await api("GET", `/api/collections/${collection}/records/${rid}`, token))[0] !== 404) {
        seen.view!.push(rid);
      }
      if ((await listed(token, "project_items", pid)).has(rid)) seen.project_items!.push(rid);
      if (exported.has(rid)) seen.export!.push(rid);
    }
    return seen;
  };

  // ══════════ (1) the ordinary purge takes the children it can see ═══════════
  console.log("\n── (1) a purged project takes the children its cascade can see ──");
  const PLAIN = await new_project("plainproject");
  const made: Record<string, any> = {};
  for (const collection of CHILDREN) {
    let row: any;
    [s, row] = await api(
      "POST",
      `/api/collections/${collection}/records`,
      pia,
      child_body(collection, `plain${collection}`, PLAIN),
    );
    check(`(1) a ${collection} row exists under it`, s, 200);
    made[collection] = row.id ?? null;
  }
  check(
    "(1) DELETE puts the project in the trash",
    (await api("DELETE", `/api/collections/projects/records/${PLAIN}`, pia))[0],
    204,
  );
  check(
    "(1) a second DELETE purges it",
    (await api("DELETE", `/api/collections/projects/records/${PLAIN}`, pia))[0],
    204,
  );
  check(
    "(1) the project is gone",
    (await api("GET", `/api/collections/projects/records/${PLAIN}`, su))[0],
    404,
  );
  for (const collection of CHILDREN) {
    check(
      `(1) the ${collection} row went with it`,
      (await rows_pointing_at(collection, PLAIN)).includes(made[collection]),
      false,
    );
  }

  // ══════════ (2) the row the cascade could NOT see ══════════════════════════
  // COVERS: cron:trash-purge, route:POST /api/tracker/trash/purge
  // The probe planted one per collection during each purge above, which is the row a cascade
  // scan misses in the real race. Nothing removes it at delete time on purpose (doing that
  // inline costs concurrent creates 400s and 500s), so the purge sweep is what collects it.
  console.log("\n── (2) the rows the cascade missed are still there until the purge sweep runs ──");
  const now = new Date();
  const TODAY = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days_ago = (n: number): string =>
    new Date(TODAY - n * 86400 * 1000).toISOString().slice(0, 10) + " 00:00:00.000Z";
  let ended: any;
  [s, ended] = await api("POST", "/api/collections/cycles/records", pia, {
    workspace: WS,
    name: "probeendedcycle",
    starts_on: days_ago(15),
    ends_on: days_ago(1),
  });
  check("(2) Pia's workspace ran a cycle that ended yesterday", s, 200);
  const ENDED = ended.id ?? null;
  const RACED = await new_project("racedproject");
  await api("DELETE", `/api/collections/projects/records/${RACED}`, pia);
  check(
    "(2) the project purges",
    (await api("DELETE", `/api/collections/projects/records/${RACED}`, pia))[0],
    204,
  );
  const planted: Record<string, string[]> = {};
  for (const c of CHILDREN) planted[c] = await rows_pointing_at(c, RACED);
  check(
    "(2) each collection is left holding a row whose project is gone",
    CHILDREN.filter((c) => planted[c]!.length).sort(by_code_point),
    [...CHILDREN].sort(by_code_point),
  );
  const planted_rows: [string, string, string][] = CHILDREN.flatMap((c) =>
    planted[c]!.map((rid): [string, string, string] => [c, rid, RACED]),
  );
  const planted_in_view: string[] = [];
  for (const [, rid] of planted_rows) {
    if ((await listed(su, "project_items", RACED)).has(rid)) planted_in_view.push(rid);
  }
  check(
    "(2) superuser lists them in project_items (the view carries them)",
    planted_in_view.sort(by_code_point),
    planted_rows.map(([, rid]) => rid).sort(by_code_point),
  );
  const planted_task = planted.tasks!.length ? planted.tasks![0]! : "";
  const hangers: [string, string][] = [];
  for (const collection of ["comments", "task_activity"]) {
    qs = urlencode({ filter: `task='${planted_task}'` });
    [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, su);
    for (const row of r.items || []) hangers.push([collection, getitem(row, "id")]);
  }
  check(
    "(2) superuser sees a comment and an activity row on the planted task",
    hangers.map(([c]) => c).sort(by_code_point),
    ["comments", "task_activity"],
  );
  const summary_project = await new_project("summaryproject");
  [s] = await api("POST", "/api/collections/tasks/records", pia, {
    title: "livesummary",
    project: summary_project,
    workspace: WS,
    assignee: max_id,
  });
  check("(2) a live task assigned to Max, the summary control", s, 200);
  for (const [reader, token] of READERS) {
    check(`(2) ${reader} can export the workspace`, (await exported_ids(token))[0], 200);
    const seen = await member_reads(token, planted_rows);
    for (const surface of ["list", "view", "project_items", "export"]) {
      check(`(2) before the sweep, ${reader} reads none of them via ${surface}`, seen[surface], []);
    }
    for (const [collection, rid] of hangers) {
      qs = urlencode({ filter: `task='${planted_task}'` });
      [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
      check(
        `(2) ${reader} lists no ${collection} row of the planted task`,
        (r.items || []).map((row: any) => getitem(row, "id")),
        [],
      );
      check(
        `(2) ${reader} reads the ${collection} row by id → 404`,
        (await api("GET", `/api/collections/${collection}/records/${rid}`, token))[0],
        404,
      );
    }
  }
  [s, r] = await api("GET", "/api/tracker/summary", mx);
  check(
    "(2) Max's summary counts only his live assigned task, not the planted ones",
    tup(s, r.total, r.assignedToMe),
    tup(200, 1, 1),
  );

  // Runs before the purge sweep below, which would otherwise have collected the planted task.
  const cycle_of = async (task_id: string): Promise<any> =>
    (await api("GET", `/api/collections/tasks/records/${task_id}`, su))[1].cycle ?? null;

  const unfinished_on_ended_cycle = async (title: string): Promise<string | null> => {
    const [s, t] = await api("POST", "/api/collections/tasks/records", pia, {
      title: title,
      project: summary_project,
      workspace: WS,
      cycle: ENDED,
    });
    check(`(2) control: a live unfinished task '${title}' sits on the ended cycle`, s, 200);
    return t.id ?? null;
  };

  const logged = async (flt: string): Promise<number> => {
    const [s, r] = await api("GET", "/api/logs?" + urlencode({ filter: flt }), su);
    if (s !== 200) {
      throw new roomkit.SystemExit(`❌ log query answered HTTP ${s}: ${py_str(r)}`);
    }
    return getitem(r, "totalItems");
  };

  const wait_logged = async (flt: string, above: number): Promise<boolean> => {
    const deadline = Date.now() / 1000 + CRON_POLL_DEADLINE_S;
    while (Date.now() / 1000 < deadline) {
      if ((await logged(flt)) > above) {
        return true;
      }
      await Bun.sleep(200);
    }
    return false;
  };

  const cycle_ids = async (): Promise<string[]> => {
    const qs = urlencode({ filter: `workspace='${WS}'`, perPage: 200 });
    return (await api("GET", `/api/collections/cycles/records?${qs}`, su))[1].items
      .map((c: any) => getitem(c, "id"))
      .sort(by_code_point);
  };

  const cron_swept = "message = 'cycle-rollover cron swept'";
  const route_logged = "message = 'POST /api/tracker/cycles/rollover'";
  // A refused save logs this per task, so it shows a sweep that selected the task even though the
  // missing project stops the move itself.
  const tried_planted = `message = 'cycle-rollover skipped a task' && data.task = '${planted_task}'`;

  const run_cron = async (label: string): Promise<number> => {
    const runs = await logged(cron_swept);
    const tried = await logged(tried_planted);
    check(
      `(2) ${label}: superuser runs the registered cycle-rollover job → 204`,
      (await api("POST", "/api/crons/cycle-rollover", su))[0],
      204,
    );
    // The job answers 204 before its sweep runs; a warning it logged flushes no later than this line.
    check(
      `(2) ${label}: the cron sweep finished within the poll deadline`,
      await wait_logged(cron_swept, runs),
      true,
    );
    return (await logged(tried_planted)) - tried;
  };

  const run_route = async (label: string): Promise<number> => {
    const runs = await logged(route_logged);
    const tried = await logged(tried_planted);
    check(
      `(2) ${label}: superuser runs the rollover route → 200`,
      (await api("POST", "/api/tracker/cycles/rollover", su))[0],
      200,
    );
    check(
      `(2) ${label}: the route's request log landed within the poll deadline`,
      // PB flushes its log buffer in write order, so the request line lands after the handler's warnings.
      await wait_logged(route_logged, runs),
      true,
    );
    return (await logged(tried_planted)) - tried;
  };

  const RUNS: [string, (label: string) => Promise<number>][] = [
    ["cron", run_cron],
    ["route", run_route],
  ];
  check("(2) the planted task sits on the ended cycle", await cycle_of(planted_task), ENDED);
  check("(2) the ended cycle is the workspace's only cycle", await cycle_ids(), [ENDED]);
  for (const [label, run] of RUNS) {
    const before = await cycle_ids();
    const tried = await run(`${label}, only the planted task unfinished`);
    check(
      `(2) the ${label} run mints no cycle for an ended cycle whose only unfinished task's project is gone`,
      await cycle_ids(),
      before,
    );
    check(`(2) the ${label} run never selects that task (no skipped-task warning)`, tried, 0);
  }
  for (const [label, run] of RUNS) {
    const control = await unfinished_on_ended_cycle(`liveroll${label}`);
    await run(`${label}, a live task unfinished`);
    const destinations = (await cycle_ids()).filter((c) => c !== ENDED);
    check(
      `(2) control: the ${label} run moves the live task onto the workspace's one destination cycle`,
      tup(await cycle_of(control!), destinations.length),
      tup(destinations.length ? destinations[0] : "no destination", 1),
    );
  }
  check("(2) the planted task is still on the ended cycle", await cycle_of(planted_task), ENDED);

  check(
    "(2) the purge sweep runs on demand",
    (await api("POST", "/api/tracker/trash/purge", su))[0],
    200,
  );
  for (const collection of CHILDREN) {
    check(`(2) the swept ${collection} row is gone`, await rows_pointing_at(collection, RACED), []);
    check(
      `(2) so is the one from the earlier purge (${collection})`,
      await rows_pointing_at(collection, PLAIN),
      [],
    );
  }

  // ══════════ (3) the real race ══════════════════════════════════════════════
  // COVERS: route:POST /api/tracker/export
  // Timing dependent: the invariants hold on whatever raced, and (2) is the guaranteed row.
  console.log("\n── (3) member creates racing a superuser purge: a raced row is never readable ──");
  // api() retries a 429 a second later, which drops that create out of the barrier-released race.
  // Left off for the rest of the run: the room is this suite's own and is deleted with it.
  check(
    "(3) superuser lifts the room's request rate limit for the race",
    (await api("PATCH", "/api/settings", su, { rateLimits: { enabled: false } }))[0],
    200,
  );
  const listeners = new Map<string, roomkit.SSEListener>();
  for (const [reader, token] of READERS) {
    listeners.set(reader, new roomkit.SSEListener(BASE_URL, token, `rt:project_items:${WS}`));
  }
  for (const [reader, listener] of listeners) {
    if (!(await listener.start())) {
      throw new roomkit.SystemExit(`❌ ${reader}'s realtime reader never connected`);
    }
  }

  const creates_seen = (listener: roomkit.SSEListener, collection: string): Set<any> =>
    new Set(listener.of(collection, "create").map((ev) => ev.id));

  /** Create a sentinel task and wait for it on every feed: what a feed holds past it is settled. */
  const drain = async (title: string): Promise<Map<string, boolean>> => {
    const [s, t] = await api("POST", "/api/collections/tasks/records", pia, {
      title: title,
      project: summary_project,
      workspace: WS,
    });
    if (s !== 200) {
      throw new roomkit.SystemExit(`❌ sentinel task not created: HTTP ${s} ${py_str(t)}`);
    }
    const deadline = Date.now() / 1000 + SSE_DRAIN_DEADLINE_S;
    while (Date.now() / 1000 < deadline) {
      if (
        [...listeners.values()].every((lst) => creates_seen(lst, "tasks").has(getitem(t, "id")))
      ) {
        break;
      }
      await Bun.sleep(100);
    }
    return new Map(
      [...listeners].map(([reader, lst]) => [reader, creates_seen(lst, "tasks").has(t.id)]),
    );
  };

  // The subscribe POST lands after PB_CONNECT, so a sentinel sent too early is simply never delivered.
  let subscribed = new Map<string, boolean>();
  for (let attempt = 0; attempt < 5; attempt++) {
    subscribed = await drain(`sentinelsubscribed${attempt}`);
    if ([...subscribed.values()].every(Boolean)) {
      break;
    }
  }
  for (const reader of listeners.keys()) {
    check(
      `(3) ${reader}'s live feed delivers a create before the race`,
      subscribed.get(reader),
      true,
    );
  }

  const [MIN_TRIALS, MAX_TRIALS] = [6, 60];
  const raced_rows: [string, string, string][] = [];
  const live_created: [string, string, string][] = [];
  const live_ids: string[] = [];
  const doomed_ids: string[] = [];
  const doomed_statuses = new Map<number, number>();
  const doomed_ok_ids = new Set<string>();
  let trials = 0;
  let fired = 0;

  const unraced = (): string[] => {
    const hit = new Set(raced_rows.map(([rc]) => rc));
    return CHILDREN.filter((c) => !hit.has(c));
  };

  while (trials < MIN_TRIALS || (unraced().length && trials < MAX_TRIALS)) {
    trials += 1;
    const doomed = await new_project(`doomed${trials}`);
    const live = await new_project(`live${trials}`);
    doomed_ids.push(doomed);
    live_ids.push(live);
    // The doomed creates per collection set how often the race fires; tasks, the slowest create,
    // races least, and fewer made a run that never reaches every collection common.
    const plan: [string, string][] = [];
    for (const c of CHILDREN) {
      for (let _ = 0; _ < (c === "tasks" ? 24 : 12); _++) plan.push([c, doomed]);
    }
    for (const c of CHILDREN) plan.push([c, live]);
    // Python released every create and the purge together from a threading.Barrier. Here each
    // api() call runs synchronously up to its fetch, so starting every request before awaiting
    // any puts them all in flight together; the purge starts last, after the creates are out.
    const title = `race${trials}`;
    const pending = plan.map(([collection, pid]) =>
      api(
        "POST",
        `/api/collections/${collection}/records`,
        pia,
        child_body(collection, title, pid),
      ),
    );
    const purging = api("DELETE", `/api/collections/projects/records/${doomed}`, su);
    const results = await Promise.all(pending);
    await purging;
    for (let i = 0; i < plan.length; i++) {
      const [collection, pid] = plan[i]!;
      const [s, row] = results[i]!;
      if (pid === live && s === 200) {
        live_created.push([collection, getitem(row, "id"), pid]);
      }
      if (pid === doomed) {
        doomed_statuses.set(s, (doomed_statuses.get(s) ?? 0) + 1);
        if (s === 200) {
          doomed_ok_ids.add(getitem(row, "id"));
        }
      }
    }
    const raced_before = raced_rows.length;
    for (const collection of CHILDREN) {
      for (const rid of await rows_pointing_at(collection, doomed)) {
        const [, row] = await api("GET", `/api/collections/${collection}/records/${rid}`, su);
        if ((row.name || row.title || "").startsWith("race")) {
          raced_rows.push([collection, rid, doomed]);
        }
      }
    }
    fired += +(raced_rows.length > raced_before);
  }
  console.log(
    `  ℹ️  ${trials} trial(s), ${fired} fired: ${raced_rows.length} raced row(s) outlived their purged project`,
  );
  const still_there: string[] = [];
  for (const p of doomed_ids) {
    if ((await api("GET", `/api/collections/projects/records/${p}`, su))[0] !== 404) {
      still_there.push(p);
    }
  }
  check("(3) every doomed project is gone", still_there, []);
  console.log(
    `  ℹ️  doomed-project creates answered ${py_repr(doomed_statuses)}; raced rows whose create answered 200: ` +
      `${raced_rows.filter(([, rid]) => doomed_ok_ids.has(rid)).length} of ${raced_rows.length}`,
  );
  // A sentinel seen on a feed means every earlier broadcast to that connection arrived: PB sends one client's messages in order.
  const caught_up = await drain("sentinelafterrace");
  for (const [reader, listener] of listeners) {
    check(`(3) ${reader}'s live feed caught up past the race`, caught_up.get(reader), true);
    for (const collection of CHILDREN) {
      check(
        `(3) ${reader} received the create of every live-project ${collection} row`,
        live_created
          .filter(([c, rid]) => c === collection && !creates_seen(listener, c).has(rid))
          .map(([, rid]) => rid)
          .sort(by_code_point),
        [],
      );
    }
  }
  console.log(
    "  ℹ️  raced rows per collection: " +
      CHILDREN.map((c) => `${c}=${raced_rows.filter(([rc]) => rc === c).length}`).join(", "),
  );
  // The race fires on too few trials for more trials to guarantee a row, so no row = not proven.
  if (unraced().length) {
    raced_checks_skipped = true; // DECLARED SKIP: see the flag's declaration
    console.log(
      `  ⚠️  RACE DID NOT FIRE for ${py_repr(unraced())} in ${trials} trials — raced-row invariant checks ` +
        "(reads-none-of-the-raced-rows, no-raced-create-on-the-live-feed, " +
        "sweep-collected-every-raced-row) SKIPPED for those collections, not proven this run",
    );
  }
  if (raced_rows.length) {
    for (const [reader, listener] of listeners) {
      for (const collection of CHILDREN) {
        check(
          `(3) ${reader}'s live feed carried no create for a raced ${collection} row`,
          listener.absent_count(
            raced_rows
              .filter(([c, rid]) => c === collection && creates_seen(listener, c).has(rid))
              .map(([, rid]) => rid),
          ),
          [],
        );
      }
    }
    for (const [reader, token] of READERS) {
      const seen = await member_reads(token, raced_rows);
      for (const surface of ["list", "view", "project_items", "export"]) {
        check(`(3) ${reader} reads none of the raced rows via ${surface}`, seen[surface], []);
      }
    }
  }
  check(
    "(3) the creates into the live projects all succeeded",
    live_created.length,
    CHILDREN.length * trials,
  );
  for (const [reader, token] of READERS) {
    const seen = await member_reads(token, live_created);
    for (const surface of ["list", "view", "project_items", "export"]) {
      check(
        `(3) ${reader} reads every row created in a live project via ${surface}`,
        seen[surface]!.length,
        live_created.length,
      );
    }
  }
  check(
    "(3) the purge sweep runs on demand",
    (await api("POST", "/api/tracker/trash/purge", su))[0],
    200,
  );
  if (raced_rows.length) {
    const survivors: string[] = [];
    for (const [c, rid, p] of raced_rows) {
      if ((await rows_pointing_at(c, p)).includes(rid)) survivors.push(rid);
    }
    check("(3) the sweep collected every raced row", survivors, []);
    await drain("sentinelaftersweep");
    for (const [reader, listener] of listeners) {
      const carried = new Map<string, number>();
      for (const [c, rid] of raced_rows) {
        const actions = listener.events
          .filter((ev) => ev.id === rid)
          .map((ev) => ev.action)
          .join("+");
        const key = `${c}:${actions || "nothing"}`;
        carried.set(key, (carried.get(key) ?? 0) + 1);
      }
      console.log(
        `  ℹ️  after the sweep, ${reader}'s feed carried, per raced row: ${py_repr(carried)}`,
      );
    }
  }
  for (const listener of listeners.values()) {
    listener.stop = true;
  }

  // ══════════ (4) the invariant a new one would trip ═════════════════════════
  console.log("\n── (4) nothing anywhere points at a project that does not exist ──");
  const live_projects = new Set<string>();
  [, r] = await api("GET", "/api/collections/projects/records?perPage=500", su);
  for (const proj of r.items || []) {
    live_projects.add(getitem(proj, "id"));
  }
  const dangling: any[] = [];
  for (const collection of CHILDREN) {
    [, r] = await api("GET", `/api/collections/${collection}/records?perPage=500`, su);
    for (const row of r.items || []) {
      const pid = row.project;
      if (truthy(pid) && !live_projects.has(pid)) {
        dangling.push(tup(collection, getitem(row, "id"), pid));
      }
    }
  }
  check("(4) every child row resolves to a live project", dangling, []);

  console.log("\n" + "═".repeat(90));
} finally {
  if (server !== null) {
    await roomkit.stop(server);
  }
  fs.rmSync(S, { recursive: true, force: true });
}

if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
// DECLARED SKIP: reports the unrun raced-row checks
if (raced_checks_skipped) {
  console.log(
    "✅ dangling-project proofs passed — ⚠️ except the raced-row checks in (3) for a collection the race never reached",
  );
} else {
  console.log("✅ all dangling-project proofs passed");
}
process.exit(0);

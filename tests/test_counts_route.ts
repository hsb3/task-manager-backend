#!/usr/bin/env bun
/**
 * E2E proof of GET /api/tracker/project-items/counts (pb_hooks/counts.pb.js, wave v8d/21e6 phase 1):
 * group counts computed inside PocketBase in ONE query, instead of the proxy paging
 * project_items 500 rows at a time and bucketing in JS.
 *
 * Proven against a live server:
 *
 * (1) BUCKET CORRECTNESS, every group (project/status/priority/assignee/label) — the route's
 *     buckets are cross-checked against the SAME rows read back through the rule-scoped list API
 *     (`GET /api/collections/project_items/records`), computed independently in this suite. This also
 *     doubles as (2) VISIBILITY: the list API is scoped by the actor's own token, so a route/list
 *     mismatch for any actor is either a bucket bug or a leak.
 * (2) VISIBILITY, named scenarios: non-member sees nothing; a task-assignee who holds no active
 *     membership counts only the task assigned to them; a non-task draft counts for its
 *     author/an active admin only; a suspended member or a pending invitee (no membership row
 *     at all) counts nothing; unauthenticated is refused outright (401, before any rule is even
 *     read).
 * (3) FILTER SAFETY: a filter naming a relation walk, `@collection`, or a bound-param token is
 *     refused 400; the same characters inside a quoted string literal are not.
 * (4) RULE BINDABILITY: this route can bind only `@request.auth.id`, so a listRule carrying any
 *     other `@request` token — or mentioning one inside a string literal, where substituting
 *     would splice a bound param into a string PB cannot parse — is refused 400 where it is
 *     WRITTEN (a tagged collection hook), naming the offence and this route. The route's own 500
 *     backstop is then proven by re-serving the same data dir off a hooks copy with that guard
 *     stripped out. ONE `UNBINDABLE` table drives both, so the two inlined matchers in
 *     pb_hooks/counts.pb.js cannot diverge without a check going red.
 * (5) SCALE: >=5,000 (then >=10,000) rows in one project, seeded by a direct SQLite insert into
 *     `tasks` (never through the API — 5k/10k individual creates through every write hook would
 *     dominate the wall time this test is trying to measure), read back through ONE route call with
 *     correct totals and buckets, wall time reported for both sizes.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8143 + PB_PORT_OFFSET (suite self-boot band, .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  print,
  py_repr,
  py_str,
  read_text,
  run_checked,
  tup,
  truthy,
  url_error_reason,
  urlencode,
  sqlite_connect,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const PORT = 8143 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const ROUTE = "/api/tracker/project-items/counts";
const GROUPS = ["project", "status", "priority", "assignee", "label"];

// The ONE table of unbindable-listRule cases, appended to the live rule. Sections (3e) and (5)
// both iterate it, so each case is driven through BOTH inlined matchers in pb_hooks/counts.pb.js
// (the author-time guard and the route's own backstop) and a divergence between them is red.
// Third element: every substring the refusal must name, besides ROUTE.
const UNBINDABLE: [string, string, string[]][] = [
  [
    "an auth token this route cannot bind",
    " && @request.auth.verified = true",
    ["@request.auth.verified"],
  ],
  // `split("@request.auth.id")` is not token-aware: this became `{:authId}x`, which the old
  // `indexOf("@request")` check could not see at all.
  ["a token-boundary near-miss of auth.id", ' && @request.auth.idx = ""', ["@request.auth.idx"]],
  // Same shape one character over: a PB filter modifier. The token match stopped at the `:`,
  // so this read as the one allowed token and the route spliced `{:authId}` in front of `:lower`.
  [
    "a modifier on the one bindable token",
    ' && @request.auth.id:lower != ""',
    ["@request.auth.id:lower"],
  ],
  [
    "two unbindable tokens at once",
    " && @request.auth.verified = true && @request.auth.member_workspaces ?~ workspace",
    ["@request.auth.verified", "@request.auth.member_workspaces"],
  ],
  // Substituting inside a quoted literal splices a bound param into a string and PB then
  // cannot parse the filter at all: HTTP 400 "Something went wrong", naming nothing.
  [
    "an @request mention inside a string literal",
    ' && title != "@request.auth.id"',
    ["string literal"],
  ],
  [
    "the same mention inside a single-quoted literal",
    " && title != '@request.auth.id'",
    ["string literal"],
  ],
  // Blanking hides a `{:` written inside a literal, and the route binds a parameter of its
  // own: the two meet as one filter PB reads as a stray number, 400 naming nothing.
  ["a bound-parameter token written into the rule", ' && title != "{:authId}"', ["{:"]],
];

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(78)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  let r: Response;
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, url_error_reason(e));
  }
  const raw = new Uint8Array(await r.arrayBuffer());
  const decode = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  if (r.ok) return tup(r.status, raw.length ? JSON.parse(decode()) : {});
  try {
    return tup(r.status, raw.length ? JSON.parse(decode()) : {});
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return tup(r.status, { raw: Array.from(decode()).slice(0, 300).join("") });
  }
}

function counts(token: string | null, group: string, filt: string): Promise<[number, any]> {
  const qs = urlencode({ group, filter: filt });
  return api("GET", `${ROUTE}?${qs}`, token);
}

async function list_all(
  collection: string,
  token: string | null = null,
  per_page = 200,
  params: Record<string, any> = {},
): Promise<[number, any[], any]> {
  const items: any[] = [];
  let page_no = 1;
  while (true) {
    const qs = urlencode({
      page: page_no,
      perPage: per_page,
      ...Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== null && v !== undefined),
      ),
    });
    const [status, body] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
    if (status !== 200) return tup(status, items, body);
    items.push(...(body.items || []));
    if (page_no >= (body.totalPages || 1)) return tup(status, items, body);
    page_no += 1;
  }
}

function count_up<K>(m: Map<K, number>, k: K): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/**
 * What the proxy did before this route: page the view 500 rows at a time and bucket in JS.
 * Kept as the SAME-ROOM baseline for section (4) — a route timing alone reads as the route's
 * own cost, when most of it is the view rule's membership joins (dpn2), paid per row by both.
 */
async function paged_walk(
  token: string | null,
  filt: string,
  column: string,
): Promise<[number, Map<string, number>, number]> {
  const buckets = new Map<string, number>();
  let requests = 0;
  let page = 1;
  const total_of = () => [...buckets.values()].reduce((a, b) => a + b, 0);
  while (true) {
    const qs = urlencode({
      filter: filt,
      sort: "id",
      page,
      perPage: 500,
      fields: column,
    });
    const [st, body] = await api("GET", `/api/collections/project_items/records?${qs}`, token);
    requests += 1;
    if (st !== 200) return tup(requests, buckets, st);
    const items = body.items || [];
    for (const row of items) {
      count_up(buckets, truthy(row[column]) ? row[column] : "none");
    }
    if (!items.length || total_of() >= (body.totalItems ?? 0)) return tup(requests, buckets, st);
    page += 1;
  }
}

function q(v: unknown): string {
  return '"' + py_str(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

/** Mirrors pb_hooks/counts.pb.js keysOf / the trash route's group buckets in pb_hooks/routes.pb.js. */
function py_group_keys(group: string, row: any): any[] {
  if (group === "project") return [truthy(row.project) ? row.project : null];
  if (group === "status") return [truthy(row.status) ? row.status : null];
  if (group === "priority") {
    // Python's `== 0` also holds for False.
    const none = row.has_priority === 0 || row.has_priority === false;
    return [none ? "none" : truthy(row.priority) ? row.priority : "none"];
  }
  if (group === "assignee") return [truthy(row.assignee) ? row.assignee : null];
  if (group === "label") {
    const raw = row.labels;
    let arr: any;
    try {
      if (!truthy(raw)) arr = [];
      else if (typeof raw !== "string")
        throw new TypeError("the JSON object must be str, bytes or bytearray");
      else arr = JSON.parse(raw);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      arr = [];
    }
    return truthy(arr) ? arr : [null];
  }
  return [null];
}

function expected_buckets(rows: any[], group: string): [Map<any, number>, number] {
  const c = new Map<any, number>();
  for (const r of rows) {
    for (const k of py_group_keys(group, r)) count_up(c, k);
  }
  return tup(c, rows.length);
}

function route_buckets(body: any): [Map<any, number>, any] {
  const m = new Map<any, number>();
  for (const i of body.items || []) m.set(getitem(i, "key"), getitem(i, "count"));
  return tup(m, body.total ?? null);
}

/**
 * The route's answer for every group == counting the SAME rule-scoped list read, computed
 * independently in this suite. A route/list mismatch is either a bucket bug or a leak — this is
 * the one check every visibility scenario below reduces to.
 */
async function assert_matches_ground_truth(
  who: string,
  token: string | null,
  filt: string,
  groups: string[] = GROUPS,
): Promise<number> {
  const [status, rows] = await list_all("project_items", token, 200, { filter: filt });
  check(`${who.padEnd(32)} | ground-truth list read → 200`, status, 200);
  for (const group of groups) {
    const [want_items, want_total] = expected_buckets(rows, group);
    const [s, body] = await counts(token, group, filt);
    const [got_items, got_total] = route_buckets(body);
    check(`${who.padEnd(32)} | group=${group.padEnd(8)} status`, s, 200);
    check(`${who.padEnd(32)} | group=${group.padEnd(8)} total`, got_total, want_total);
    check(`${who.padEnd(32)} | group=${group.padEnd(8)} buckets`, got_items, want_items);
  }
  return rows.length;
}

async function login(email: string, password = "test123456"): Promise<[string, string]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password,
  });
  if (!Object.hasOwn(r, "token")) {
    throw new roomkit.SystemExit(`❌ login ${email} failed: HTTP ${s} ${py_str(r)}`);
  }
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-counts-route-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
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
  const HOOKS = roomkit.hooks_dir(S);
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, HOOKS);
  let su = await superuser_token();

  let s: number;
  let r: any;
  let body: any;

  console.log("\n── seed: alice/bob fixtures (scripts/seed.ts) ──");
  const seed_proc = Bun.spawn([process.execPath, "scripts/seed.ts"], {
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
    new Response(seed_proc.stdout).text(),
    new Response(seed_proc.stderr).text(),
    seed_proc.exited,
  ]);
  check("seed.ts exit code", seed_rc, 0);
  if (seed_rc !== 0) {
    print(seed_out, seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  let [alice, alice_id] = await login("alice@example.com");

  // ══════════════════ 0. a workspace with one actor per rule branch ═══════════
  console.log("\n── (0) fixtures: a workspace, its roster, its items ──");
  let ws: any;
  [s, ws] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "CR Workspace",
    owner: alice_id,
  });
  check("workspace created", s, 200);
  const WS: string = getitem(ws, "id");
  let prj: any;
  [s, prj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "CR Project",
    workspace: WS,
    owner: alice_id,
  });
  check("project created", s, 200);
  const PRJ: string = getitem(prj, "id");

  async function mkuser(email: string, name: string): Promise<string> {
    const [s, r] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`user created: ${name}`, s, 200);
    return getitem(r, "id");
  }

  async function add_member(user_id: string, role: string, status = "active"): Promise<string> {
    let [s, r] = await api(
      "POST",
      // Superuser: an owner may only mint an invitation, and only the invitee accepts it.
      "/api/collections/workspace_members/records",
      su,
      { workspace: WS, user: user_id, role: "member", status },
    );
    check(`membership row created (${role}/${status})`, s, 200);
    const row: string = getitem(r, "id");
    if (role !== "member") {
      [s, r] = await api("PATCH", `/api/collections/workspace_members/records/${row}`, alice, {
        role,
      });
      check(`  promoted to ${role}`, tup(s, r.role ?? null), tup(200, role));
    }
    return row;
  }

  const admin_id = await mkuser("cr-admin@example.com", "CR Admin");
  const member1_id = await mkuser("cr-member1@example.com", "CR Member 1");
  const member2_id = await mkuser("cr-member2@example.com", "CR Member 2");
  const invited_id = await mkuser("cr-invited@example.com", "CR Invited");
  const suspended_id = await mkuser("cr-suspended@example.com", "CR Suspended");
  const assignee_id = await mkuser("cr-assignee@example.com", "CR Assignee");
  const outsider_id = await mkuser("cr-outsider@example.com", "CR Outsider");

  await add_member(admin_id, "admin");
  await add_member(member1_id, "member");
  await add_member(member2_id, "member");
  // decision-073: `invited` retires from workspace_members — a pending invite is its own
  // workspace_invitations row, and the invitee holds NO membership row until accepted.
  [s] = await api("POST", "/api/collections/workspace_invitations/records", su, {
    workspace: WS,
    email: "cr-invited@example.com",
    role: "member",
  });
  check("pending invitation created for CR Invited (no membership row)", s, 200);
  const susp_row = await add_member(suspended_id, "member");
  const asg_row = await add_member(assignee_id, "member");

  const [admin] = await login("cr-admin@example.com");
  const [member1] = await login("cr-member1@example.com");
  const [member2] = await login("cr-member2@example.com");
  const [outsider] = await login("cr-outsider@example.com");

  const [, ws_statuses] = await list_all("statuses", alice, 200, { filter: `workspace='${WS}'` });
  check("workspace provisioned >=2 statuses", ws_statuses.length >= 2, true);
  const S1: string = getitem(ws_statuses[0], "id");
  const S2: string = getitem(ws_statuses[1], "id");
  let ws_row: any;
  [s, ws_row] = await api("GET", `/api/collections/workspaces/records/${WS}`, alice);
  const PRIO = new Map<string, string>();
  for (const p of ws_row.priorities || []) PRIO.set(getitem(p, "name"), getitem(p, "id"));
  check("workspace provisioned a priority vocabulary", PRIO.size > 0, true);
  const P1: string = PRIO.get(PRIO.keys().next().value!)!;

  let l1: any, l2: any;
  [s, l1] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: WS,
    name: "cr-label-1",
  });
  check("label 1 created", s, 200);
  [s, l2] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: WS,
    name: "cr-label-2",
  });
  check("label 2 created", s, 200);

  let t1: any, t2: any, t3: any, t4: any, t_asg: any;
  [s, t1] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "CR t1",
    status: S1,
    priority: P1,
    assignee: alice_id,
    labels: [getitem(l1, "id")],
  });
  check("t1 created", s, 200);
  [s, t2] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "CR t2",
    status: S1,
    assignee: member1_id,
    labels: [getitem(l1, "id"), getitem(l2, "id")],
  });
  check("t2 created", s, 200);
  [s, t3] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "CR t3",
    status: S2,
  });
  check("t3 created", s, 200);
  [s, t4] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "CR t4",
  }); // no status, no priority, no assignee, no labels
  check("t4 created", s, 200);

  // The assignee-only branch: assigned while an ACTIVE member, then suspended — a membership
  // DELETE unassigns, so this is the only way to reach tasks' `assignee = @request.auth.id` leg.
  [s, t_asg] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "CR t-assignee",
    status: S2,
    assignee: assignee_id,
  });
  check("assignee's task created", s, 200);
  [s, r] = await api("PATCH", `/api/collections/workspace_members/records/${asg_row}`, alice, {
    status: "suspended",
  });
  check("assignee's membership suspended", tup(s, r.status ?? null), tup(200, "suspended"));
  [s, r] = await api("PATCH", `/api/collections/workspace_members/records/${susp_row}`, alice, {
    status: "suspended",
  });
  check(
    "plain suspended member's membership suspended",
    tup(s, r.status ?? null),
    tup(200, "suspended"),
  );
  const [assignee] = await login("cr-assignee@example.com");
  const [suspended] = await login("cr-suspended@example.com");
  const [invited] = await login("cr-invited@example.com");

  let dec_live: any, dec_draft: any, ms: any;
  [s, dec_live] = await api("POST", "/api/collections/decisions/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "CR live decision",
  });
  check("live decision created", s, 200);
  [s, dec_draft] = await api("POST", "/api/collections/decisions/records", member1, {
    workspace: WS,
    project: PRJ,
    title: "CR draft decision",
    draft: true,
  });
  check("draft decision authored by member1", s, 200);
  [s, ms] = await api("POST", "/api/collections/milestones/records", alice, {
    workspace: WS,
    project: PRJ,
    name: "CR milestone",
  });
  check("milestone created", s, 200);

  const ALL_FILTER = `workspace = ${q(WS)} && trashed = "" && project_trashed = 0`;

  // ══════════════════ 1+2. bucket correctness == visibility, every actor ══════
  // COVERS: route:GET /api/tracker/project-items/counts
  console.log(
    "\n── (1)+(2) bucket correctness (== visibility): route matches the rule-scoped list ──",
  );
  const n_alice = await assert_matches_ground_truth("owner (alice)", alice, ALL_FILTER);
  check("owner sees every fixture item (5 tasks + 2 decisions + 1 milestone)", n_alice, 8);
  await assert_matches_ground_truth("workspace admin", admin, ALL_FILTER);
  await assert_matches_ground_truth("plain member (author of the draft)", member1, ALL_FILTER);
  const n_member2 = await assert_matches_ground_truth(
    "plain member (not the author)",
    member2,
    ALL_FILTER,
  );
  const n_outsider = await assert_matches_ground_truth("non-member", outsider, ALL_FILTER);
  check("non-member sees nothing", n_outsider, 0);
  const n_susp = await assert_matches_ground_truth("suspended member", suspended, ALL_FILTER);
  check("suspended member counts nothing", n_susp, 0);
  const n_inv = await assert_matches_ground_truth(
    "pending invitee (no membership row)",
    invited,
    ALL_FILTER,
  );
  check("pending invitee counts nothing (an invitation confers no read)", n_inv, 0);
  const n_asg = await assert_matches_ground_truth(
    "assignee (no active membership)",
    assignee,
    ALL_FILTER,
  );
  check("assignee-only counts exactly the ONE task assigned to them", n_asg, 1);
  let asg_body: any;
  [s, asg_body] = await counts(assignee, "assignee", ALL_FILTER);
  check(
    "  …and that bucket is keyed on the assignee's own id",
    route_buckets(asg_body)[0],
    new Map([[assignee_id, 1]]),
  );

  // Named draft-privacy spot check: member1 (author) sees it, member2 (plain peer) does not,
  // admin (active admin) does — mirrors decisions.listRule's draft branch exactly.
  const [, m1_rows] = await list_all("project_items", member1, 200, { filter: ALL_FILTER });
  const [, m2_rows] = await list_all("project_items", member2, 200, { filter: ALL_FILTER });
  const [, adm_rows] = await list_all("project_items", admin, 200, { filter: ALL_FILTER });
  const [m1_ids, m2_ids, adm_ids] = [m1_rows, m2_rows, adm_rows].map(
    (rs) => new Set(rs.map((r) => getitem(r, "id"))),
  );
  const draft_id = getitem(dec_draft, "id");
  check("draft author (member1) sees their own draft decision", m1_ids.has(draft_id), true);
  check("a peer member (member2) does NOT see it", m2_ids.has(draft_id), false);
  check("an active admin DOES see it", adm_ids.has(draft_id), true);

  console.log("\n── unauthenticated ──");
  [s] = await counts(null, "status", ALL_FILTER);
  check("no token → 401 (before any rule is even read)", s, 401);

  [s, body] = await counts(alice, "bogus-group", ALL_FILTER);
  check("unsupported group → 400", s, 400);

  // ══════════════════ 3. filter safety ═════════════════════════════════════════
  console.log(
    "\n── (3) filter safety: only the view's own flat columns, quoted literals excepted ──",
  );
  const UNSAFE = [
    ["dotted field (relation walk)", 'workspace.owner = "x"'],
    ["@collection back-relation", "@collection.workspaces:ws.id ?= workspace"],
    ["{:authId} bound-param injection", '{:authId} = "x"'],
    ["@request token", '@request.auth.id != ""'],
  ];
  for (const [label, filt] of UNSAFE) {
    [s, body] = await counts(alice, "status", filt);
    check(`refused: ${label}`, s, 400);
  }
  const SAFE = [
    ["a literal '.' inside a quoted string", `workspace = ${q(WS)} && title ~ "a.b"`],
    ["a literal '@' inside a quoted string", `workspace = ${q(WS)} && title ~ "a@b.com"`],
  ];
  for (const [label, filt] of SAFE) {
    [s, body] = await counts(alice, "status", filt);
    check(`accepted: ${label}`, s, 200);
  }

  // A crafted `") || ("` closes the rule's own group early and re-opens a fresh one, turning
  // `&&` into `||` — `(rule) && (id != "") || (id != "")` counts every row in the DB regardless
  // of the rule. No `@`/`.`/`{:` appears, so only paren-depth tracking catches it.
  [s, body] = await counts(alice, "status", 'id != "") || (id != ""');
  check("refused: paren-depth escape (rule-drop oracle)", s, 400);
  [s, body] = await counts(alice, "status", '(id != "" && (id != "")');
  check("refused: unbalanced open paren (never returns to depth 0)", s, 400);

  console.log("\n── (3b) quote/escape parity with PocketBase's own lexer (fexpr scanner.go) ──");
  // title ~ "a\"b" — a quote EMBEDDED mid-string (buildViewFilter's q() shape for a title
  // search containing a literal `"`). fexpr's scanText closes only on an unescaped matching
  // quote, so this is a genuine, well-formed literal — must be ACCEPTED and scoped to WS.
  let filt = `workspace = ${q(WS)} && title ~ "a\\"b"`;
  [s, body] = await counts(alice, "status", filt);
  check('escape-parity accepted: title ~ "a\\"b" (embedded quote)', s, 200);
  if (s === 200) {
    check(
      "  …and total stays within the workspace's own count",
      getitem(body, "total") <= n_alice,
      true,
    );
  }
  // fexpr v0.6.0 (PB 0.40.4) reads `\\` as one escaped backslash, so a search ending in a
  // backslash (q() doubles it) is a closed literal: accepted and still scoped to the caller.
  for (const [label, filt] of [
    [
      'title ~ "a\\\\"  (one trailing backslash, q()-doubled to two)',
      `workspace = ${q(WS)} && title ~ "a\\\\"`,
    ],
    [
      'title ~ "a\\\\\\\\"  (two trailing backslashes, q()-doubled to four)',
      `workspace = ${q(WS)} && title ~ "a\\\\\\\\"`,
    ],
  ]) {
    [s, body] = await counts(alice, "status", filt);
    check(`escape-parity accepted: ${label}`, s, 200);
    if (s === 200) {
      check(
        "  …and total stays within the workspace's own count",
        getitem(body, "total") <= n_alice,
        true,
      );
    }
  }
  // An odd backslash run escapes the closing quote, leaving the literal open: refused.
  [s, body] = await counts(alice, "status", `workspace = ${q(WS)} && title ~ "a\\\\\\"`);
  check('refused: title ~ "a\\\\\\" (odd backslash run escapes the closing quote)', s, 400);
  // An unterminated quote with no trailing backslash at all is refused the same way.
  [s, body] = await counts(alice, "status", `workspace = ${q(WS)} && title ~ "unterminated`);
  check("refused: unterminated quoted literal", s, 400);

  console.log("\n── (3c) superuser divergence: refused, never answered empty ──");
  [s, body] = await counts(su, "status", ALL_FILTER);
  check("superuser caller → 403 (not an empty 200)", s, 403);

  console.log("\n── (3d) group name and filter size are bounded, not merely shaped ──");
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    [s] = await counts(alice, name, ALL_FILTER);
    check(`refused: group=${name} is not a grouping (inherited object key)`, s, 400);
  }
  // PB's own list API caps a filter at 3500 chars. Parsing costs about length squared and runs
  // before any query, so the query timeout never bounds it: 100k chars burned 45s of CPU.
  const long_ok = ALL_FILTER + " ".repeat(3500 - ALL_FILTER.length);
  [s] = await counts(alice, "status", long_ok);
  check("accepted: a 3500-character filter", tup(s, long_ok.length), tup(200, 3500));
  [s] = await counts(alice, "status", long_ok + " ");
  check("refused: a 3501-character filter", s, 400);
  // An empty (public) listRule reaches the JSVM as a truthy Go wrapper, so a bare falsy check
  // would run the route with NO rule at all — every row in the database.
  const [, col] = await api("GET", "/api/collections/project_items", su);
  const original_rule = col.listRule ?? null;
  [s] = await api("PATCH", "/api/collections/project_items", su, { listRule: "" });
  check("listRule emptied for the fail-closed probe", s, 200);
  try {
    [s, body] = await counts(alice, "status", ALL_FILTER);
    check("an empty listRule fails closed (never counts unscoped)", s, 500);
    check(
      "  …and the refusal names the route it disables",
      (body.message || "").includes(ROUTE),
      true,
    );
  } finally {
    const [s2] = await api("PATCH", "/api/collections/project_items", su, {
      listRule: original_rule,
    });
    check("listRule restored", s2, 200);
  }
  [s, body] = await counts(alice, "status", ALL_FILTER);
  check("scoped answers resume after the restore", tup(s, body.total ?? null), tup(200, n_alice));

  // ══════════════════ 3e. an unbindable listRule is refused where it is WRITTEN ═
  // COVERS: route:GET /api/tracker/project-items/counts
  // COVERS: hook:counts.pb.js#onCollectionCreate:project_items
  // COVERS: hook:counts.pb.js#onCollectionUpdate:project_items
  console.log("\n── (3e) author-time refusal: a rule this route cannot bind never saves ──");

  async function rule_of(collection: string): Promise<any> {
    const [, c] = await api("GET", `/api/collections/${collection}`, su);
    return c.listRule ?? null;
  }

  const live_rule: string = await rule_of("project_items");
  check(
    "live listRule is the original (the fail-closed probe restored it)",
    live_rule,
    original_rule,
  );
  for (const [label, clause, must_name] of UNBINDABLE) {
    [s, body] = await api("PATCH", "/api/collections/project_items", su, {
      listRule: live_rule + clause,
    });
    // The refusal MESSAGE, never the whole body: a successful save echoes the rule back, so
    // searching the body would find the token in exactly the case the check must fail.
    const msg: string = body.message || "";
    try {
      check(`refused 400 at author time: ${label}`, s, 400);
      for (const named of must_name) {
        check(`  …the refusal names ${named}`, msg.includes(named), true);
      }
      check("  …the refusal names the route it would break", msg.includes(ROUTE), true);
      check(
        "  …the live rule is byte-identical (no half-apply)",
        await rule_of("project_items"),
        live_rule,
      );
      let cbody: any;
      [s, cbody] = await counts(alice, "status", ALL_FILTER);
      check(
        "  …and the route still answers the same total",
        tup(s, cbody.total ?? null),
        tup(200, n_alice),
      );
    } finally {
      if ((await rule_of("project_items")) !== live_rule) {
        await api("PATCH", "/api/collections/project_items", su, { listRule: live_rule });
      }
    }
  }

  // The guard is tagged to project_items; an untagged collection must be unaffected, or it is
  // a global interceptor that refuses rules no route of ours ever reads.
  const labels_rule: string = await rule_of("labels");
  try {
    [s] = await api("PATCH", "/api/collections/labels", su, {
      listRule: labels_rule + " && @request.auth.verified = true",
    });
    check("the same token still saves on ANOTHER collection (labels)", s, 200);
  } finally {
    const [s2] = await api("PATCH", "/api/collections/labels", su, { listRule: labels_rule });
    check("labels listRule restored", s2, 200);
    check("  …byte-identical", await rule_of("labels"), labels_rule);
  }

  // ══════════════════ 4. scale ═════════════════════════════════════════════════
  console.log("\n── (4) scale: 5,000 then 10,000 rows in one project, one route call each ──");
  let bulk_prj: any;
  [s, bulk_prj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "CR Bulk",
    workspace: WS,
    owner: alice_id,
  });
  check("bulk project created", s, 200);
  const BULK_PRJ: string = getitem(bulk_prj, "id");

  /**
   * A direct SQLite insert — 5k/10k creates through the API's write hooks (ordinal, keys,
   * shadow, notify, activity…) would dominate the wall time this test is trying to measure.
   */
  function bulk_insert(n: number, offset: number, id_prefix: string): void {
    const conn = sqlite_connect(path.join(DATA_DIR, "data.db"), { timeout: 30 });
    try {
      const now = "2026-01-01 00:00:00.000Z";
      const rows: any[][] = [];
      for (let i = 0; i < n; i++) {
        const idx = offset + i;
        const status = idx % 2 === 0 ? S1 : S2;
        const priority = idx % 4 === 0 ? P1 : "";
        const rid = (id_prefix + String(idx).padStart(15 - id_prefix.length, "0")).slice(0, 15);
        rows.push([
          rid,
          now,
          now,
          `BULK ${idx}`,
          BULK_PRJ,
          WS,
          status,
          idx,
          "",
          priority,
          "",
          "[]",
          "[]",
          "",
          "",
          "",
          "",
          "",
          `BLK-${idx}`,
          "",
          "",
        ]);
      }
      const stmt = conn.prepare(
        `INSERT INTO tasks
                   (id, created, updated, title, project, workspace, status, ordinal,
                    assignee, priority, due, labels, dependencies, parent, milestone,
                    cycle, description, completedAt, key, trashed, trashed_by)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      conn.transaction(() => {
        for (const row of rows) stmt.run(...row);
      })();
    } finally {
      conn.close();
    }
  }

  const BULK_FILTER = `project = ${q(BULK_PRJ)}`;
  const [, roster_body] = await api(
    "GET",
    "/api/collections/workspace_members/records?" +
      urlencode({ filter: `workspace = ${q(WS)}`, perPage: 1 }),
    su,
  );
  const roster = roster_body.totalItems ?? 0;
  let seeded = 0;
  for (const [total, id_prefix] of [
    [5000, "blka"],
    [10000, "blkb"],
  ] as const) {
    bulk_insert(total - seeded, seeded, id_prefix);
    seeded = total;
    let t0 = Date.now() / 1000;
    [s, body] = await counts(alice, "status", BULK_FILTER);
    const elapsed_status = Date.now() / 1000 - t0;
    check(`total=${total}: group=status → 200`, s, 200);
    check(`total=${total}: total matches the row count`, body.total ?? null, total);
    const want_status = new Map<string, number>();
    for (let idx = 0; idx < total; idx++) count_up(want_status, idx % 2 === 0 ? S1 : S2);
    check(
      `total=${total}: status buckets are exactly the seeded split`,
      route_buckets(body)[0],
      want_status,
    );

    t0 = Date.now() / 1000;
    [s, body] = await counts(alice, "priority", BULK_FILTER);
    const elapsed_priority = Date.now() / 1000 - t0;
    const want_priority = new Map<string, number>();
    for (let idx = 0; idx < total; idx++) count_up(want_priority, idx % 4 === 0 ? P1 : "none");
    check(
      `total=${total}: priority buckets are exactly the seeded split`,
      route_buckets(body)[0],
      want_priority,
    );
    console.log(
      `      total=${total} rows, ${roster} membership row(s) in the workspace:` +
        ` route group=status ${elapsed_status.toFixed(3)}s / group=priority ${elapsed_priority.toFixed(3)}s,` +
        ` 1 PocketBase request each.`,
    );
    // The baseline runs at the first size only: it costs ~4x the route per call, and one
    // comparable pair is enough to keep the route's number from reading as its own overhead.
    if (total === 5000) {
      t0 = Date.now() / 1000;
      const [walk_requests, , walk_status] = await paged_walk(alice, BULK_FILTER, "status");
      const elapsed_walk = Date.now() / 1000 - t0;
      check(`total=${total}: the baseline walk still answers 200`, walk_status, 200);
      console.log(
        `      same room, same rows, the paged walk this route replaces:` +
          ` ${elapsed_walk.toFixed(3)}s in ${walk_requests} requests.` +
          " Both pay the project_items view rule's membership joins per row, so the" +
          " absolute numbers track this room's roster, not the route (card dpn2);" +
          " what this section pins is the request count and the buckets.",
      );
    }
  }

  [s, body] = await counts(outsider, "status", BULK_FILTER);
  check(
    "scale must not weaken visibility: non-member's bulk total is 0",
    tup(s, body.total ?? null),
    tup(200, 0),
  );

  // ══════════════════ 5. the route's own backstop, proven by removing the guard ═
  // With the author-time guard in place no bad rule can reach the route, so the only way to
  // exercise the backstop is to re-serve the SAME data dir off a hooks copy without the guard.
  console.log("\n── (5) route backstop: re-serve without the author-time guard ──");
  await roomkit.stop(server);
  server = null;
  const NO_GUARD = path.join(S, "pb_hooks_no_guard");
  fs.cpSync(HOOKS, NO_GUARD, { recursive: true, dereference: true });
  const guard_file = path.join(NO_GUARD, "counts.pb.js");
  const guard_lines = read_text(guard_file).split(/(?<=\n)/);
  const kept = guard_lines.filter(
    (ln) =>
      !ln.includes("onCollectionCreate(refuseUnbindableListRule") &&
      !ln.includes("onCollectionUpdate(refuseUnbindableListRule"),
  );
  check(
    "both guard registrations stripped from the hooks copy",
    guard_lines.length - kept.length,
    2,
  );
  fs.writeFileSync(guard_file, kept.join(""));
  server = await roomkit.serve(
    PORT,
    DATA_DIR,
    MIG_DIR,
    NO_GUARD,
    path.join(S, "pb_serve_no_guard.log"),
  );
  su = await superuser_token();
  [alice, alice_id] = await login("alice@example.com");
  // Every case of the SAME table, now through the route's matcher instead of the guard's.
  for (const [label, clause, must_name] of UNBINDABLE) {
    [s] = await api("PATCH", "/api/collections/project_items", su, {
      listRule: live_rule + clause,
    });
    try {
      check(`the guard was the refusal — with it gone this SAVES: ${label}`, s, 200);
      [s, body] = await counts(alice, "status", ALL_FILTER);
      const msg: string = body.message || "";
      check("  …and the route's own backstop refuses the request 500", s, 500);
      for (const named of must_name) {
        check(`  …naming ${named}`, msg.includes(named), true);
      }
      check("  …and naming the route it breaks", msg.includes(ROUTE), true);
    } finally {
      await api("PATCH", "/api/collections/project_items", su, { listRule: live_rule });
    }
  }
  check("listRule restored in the guardless room", await rule_of("project_items"), live_rule);
  [s, body] = await counts(alice, "status", ALL_FILTER);
  check("scoped answers resume in the guardless room", s, 200);
} finally {
  if (server !== null) {
    await roomkit.stop(server);
  }
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ all counts-route proofs passed");
process.exit(0);

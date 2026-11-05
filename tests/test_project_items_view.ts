#!/usr/bin/env bun
/**
 * E2E proof of PBTT-526: the `project_items` view collection (pb_migrations/
 * v1:1785159700_project_items_view.js) — one read-only row per item across tasks, decisions,
 * documents and milestones, ordered and paginated by the server.
 *
 * Three things are proven against a live server:
 *
 * (1) RULE EQUIVALENCE — the security surface. The view's rules now carry the SAME state
 *     exclusion the four base collections carry (`trashed = "" && project_trashed = 0`,
 *     v1:pb_migrations/1785164900_project_items_trashed_clause.js, superseding PBTT-526's
 *     caller-filters-it ruling). So the view is set-for-set the ids the BASE collections LIST,
 *     filtered or not, and a trashed row is absent from every listing at EVERY tier — owner
 *     included. By id, the viewRule's trash branch serves a trashed row to exactly whom GET
 *     /api/tracker/trash shows it (members, draft carve-out, never a trashed workspace). A
 *     draft decision visible to a peer who cannot read it from `decisions` is a failure here. A
 *     SECOND workspace carries the cross-membership trap: tenancy resolves through aliased
 *     @collection joins, so an actor who owns/administers workspace B while being a plain member
 *     or viewer of workspace A must gain nothing in A — that pair is what turns red if a future
 *     edit drops an alias qualifier and the joins stop correlating per row.
 * (2) ORDERING — the empty-sinking contract: `-has_due,due` and `-has_due,-due` both leave
 *     dateless rows last, `-has_priority,priority_rank` ranks each task by the position of its
 *     priority inside its own workspace's `priorities` vocabulary (owner ruling 2026-09-02) and
 *     sinks every value that vocabulary does not hold, and created/updated/title sorts interleave
 *     all four types.
 * (3) TRUE TOTAL + FULL REACHABILITY at >200 items in one project: PocketBase reports the real
 *     totalItems, and a page-walk under two different sorts reaches the true first AND last row.
 *
 * (4) SERVED COUNTS + FLAGS (card q46b): comment_count, subtask_total/subtask_done past 500
 *     children, a non-member assignee's counts narrowed to their own children, the
 *     open/terminal/off_pipeline flags per status category, and statuses' terminal/off_pipeline.
 *
 * Plus view hygiene: no create/update/delete surface exists, and openapi.json documents the
 * collection read-only.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8116 + PB_PORT_OFFSET — the 8100+ suite self-boot band (CLAUDE.md); 8100-8115
 * and 8121 are already claimed by other suites.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  json_dumps,
  py_repr,
  py_rstrip,
  py_str,
  read_text,
  run_checked,
  truthy,
  tup,
  urlencode,
  sqlite_connect,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8116 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

// The four base collections the view unions, keyed by the `type` value each row carries.
const TYPES: Record<string, string> = {
  task: "tasks",
  decision: "decisions",
  document: "documents",
  milestone: "milestones",
};
// The vocabulary a workspace is provisioned with (pb_hooks/main.pb.js) — priority_rank is the
// index of the stored value inside the OWNING workspace's own `priorities` array, so this list
// only predicts the ranks of a workspace that never edited it.
const DEFAULT_VOCAB = ["urgent", "high", "medium", "low"];
// What the view reports for a value its workspace vocabulary does not hold. It orders nothing:
// has_priority splits ranked from unranked first, so this is a placeholder, not a threshold.
const SINK_RANK = 9999;
const BULK_TOTAL = 210; // > 200: the page-size horizon the card is about

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
  const raw = await r.text();
  if (r.ok) return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, { raw: raw.slice(0, 300) }];
  }
}

function page(
  collection: string,
  token: string | null = null,
  params: Record<string, any> = {},
): Promise<[number, any]> {
  const qs = urlencode(Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)));
  return api("GET", `/api/collections/${collection}/records?${qs}`, token);
}

/** Every record the caller may list, walked page by page (never one blind big page). */
async function list_all(
  collection: string,
  token: string | null = null,
  params: Record<string, any> = {},
  per_page = 200,
): Promise<[number, any[], any]> {
  const items: any[] = [];
  let page_no = 1;
  while (true) {
    const [status, body] = await page(collection, token, {
      page: page_no,
      perPage: per_page,
      ...params,
    });
    if (status !== 200) {
      return [status, items, body];
    }
    items.push(...(body.items || []));
    if (page_no >= (body.totalPages || 1)) {
      return [status, items, body];
    }
    page_no += 1;
  }
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort(by_code_point);
const set_diff = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x));
const sym_diff = (a: Set<string>, b: Set<string>): string[] => [
  ...set_diff(a, b),
  ...set_diff(b, a),
];
const same_set = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && set_diff(a, b).length === 0;

function ids_of(records: any[]): Set<string> {
  return new Set(records.map((r) => r.id));
}

async function login(email: string, password = "test123456"): Promise<[string, string]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password,
  });
  if (!("token" in r)) {
    throw new roomkit.SystemExit(`❌ login ${email} failed: HTTP ${s} ${py_repr(r)}`);
  }
  return [r.token, r.record.id];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!tok) {
    throw new Error(`superuser auth failed: ${py_repr(r)}`);
  }
  return tok;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-project-items-view-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) {
    fs.rmSync(path.join(MIG_DIR, name));
  }
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
  server = await start_server(DATA_DIR, MIG_DIR);
  const su = await superuser_token();

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
    console.log(seed_out);
    console.log(seed_err);
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const [alice, alice_id] = await login("alice@example.com");
  const [, all_ws] = await list_all("workspaces", alice);
  const WS: string = all_ws.find((w) => w.owner === alice_id).id;
  const [, all_projects] = await list_all("projects", alice, { filter: `workspace='${WS}'` });
  const PRJ: string = all_projects[0].id;
  check("resolved Alice's workspace", truthy(WS), true);
  check("resolved a project in it", truthy(PRJ), true);

  // ══════════════════ 0. cast of actors ═══════════════════════════════════════
  console.log("\n── (0) fixtures: one actor per branch of the base rules ──");

  const mkuser = async (email: string, name: string): Promise<string> => {
    const [s, r] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`superuser creates ${name}`, s, 200);
    return r.id;
  };

  const add_member = async (user_id: string, role: string): Promise<string> => {
    let [s, r] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS,
      user: user_id,
      role: "member",
      status: "active",
    });
    check(`membership row created for ${user_id.slice(0, 6)}`, s, 200);
    const row = r.id;
    if (role !== "member") {
      [s, r] = await api("PATCH", `/api/collections/workspace_members/records/${row}`, alice, {
        role,
      });
      check(`  promoted ${user_id.slice(0, 6)} to ${role}`, tup(s, r.role ?? null), tup(200, role));
    }
    return row;
  };

  const admin_id = await mkuser("piv-admin@example.com", "PIV Admin");
  const member_id = await mkuser("piv-member@example.com", "PIV Member");
  const viewer_id = await mkuser("piv-viewer@example.com", "PIV Viewer");
  const susp_id = await mkuser("piv-susp@example.com", "PIV Suspended");
  const asg_id = await mkuser("piv-assignee@example.com", "PIV Assignee");
  const outsider_id = await mkuser("piv-outsider@example.com", "PIV Outsider");

  await add_member(admin_id, "admin");
  await add_member(member_id, "member");
  await add_member(viewer_id, "viewer");
  const susp_row = await add_member(susp_id, "member");
  const asg_row = await add_member(asg_id, "member");

  tierkit.use(api);
  const admin_tier = await tierkit.actor_at_tier(WS, admin_id, "admin", alice, "PIV Admin");
  const member_tier = await tierkit.actor_at_tier(WS, member_id, "member", alice, "PIV Member");
  const viewer_tier = await tierkit.actor_at_tier(WS, viewer_id, "viewer", alice, "PIV Viewer");

  const [admin] = await login("piv-admin@example.com");
  const [member] = await login("piv-member@example.com");
  const [viewer] = await login("piv-viewer@example.com");
  const [outsider] = await login("piv-outsider@example.com");

  // ══════════════════ 1. per-type fixtures: live / draft x2 / trashed / trashed project ══
  console.log(
    "\n── (1) fixtures: live, two authors' drafts, trashed, and a trashed-project item ──",
  );
  let [s, p2] = await api("POST", "/api/collections/projects/records", alice, {
    name: "PIV Doomed Project",
    workspace: WS,
    owner: alice_id,
  });
  check("second project created (to be trashed)", s, 200);
  const PRJ2: string = p2.id;

  const fixtures: Record<string, Record<string, string>> = {};
  for (const [ty, coll] of Object.entries(TYPES)) {
    const title_field = coll === "milestones" ? "name" : "title";
    const base = { workspace: WS, project: PRJ };
    let live: any, d_owner: any, d_member: any, trashed: any, doomed: any, td: any;
    [s, live] = await api("POST", `/api/collections/${coll}/records`, alice, {
      ...base,
      [title_field]: `PIV ${ty} live`,
    });
    check(`${coll}: live row created by the owner`, s, 200);
    [s, d_owner] = await api("POST", `/api/collections/${coll}/records`, alice, {
      ...base,
      [title_field]: `PIV ${ty} draft-by-owner`,
      draft: true,
    });
    check(`${coll}: draft authored by the OWNER`, s, 200);
    [s, d_member] = await api("POST", `/api/collections/${coll}/records`, member, {
      ...base,
      [title_field]: `PIV ${ty} draft-by-member`,
      draft: true,
    });
    check(`${coll}: draft authored by a plain MEMBER`, s, 200);
    [s, trashed] = await api("POST", `/api/collections/${coll}/records`, alice, {
      ...base,
      [title_field]: `PIV ${ty} trashed`,
    });
    check(`${coll}: row that will be trashed`, s, 200);
    [s] = await api("DELETE", `/api/collections/${coll}/records/${trashed.id}`, alice);
    check(`${coll}: first DELETE trashes it`, s, 204);
    [s, doomed] = await api("POST", `/api/collections/${coll}/records`, alice, {
      workspace: WS,
      project: PRJ2,
      [title_field]: `PIV ${ty} in-doomed-project`,
    });
    check(`${coll}: row inside the project about to be trashed`, s, 200);
    // Both states at once: trashing must not become an escape hatch around draft privacy.
    [s, td] = await api("POST", `/api/collections/${coll}/records`, alice, {
      ...base,
      [title_field]: `PIV ${ty} trashed-draft-by-owner`,
      draft: true,
    });
    check(`${coll}: draft authored by the owner, about to be trashed`, s, 200);
    [s] = await api("DELETE", `/api/collections/${coll}/records/${td.id}`, alice);
    check(`${coll}: that draft is trashed`, s, 204);
    fixtures[ty] = {
      live: live.id,
      draft_owner: d_owner.id,
      draft_member: d_member.id,
      trashed: trashed.id,
      trashed_draft: td.id,
      doomed: doomed.id,
    };
    check(
      `${coll}: the member's create records that member as author`,
      d_member.author ?? null,
      member_id,
    );
  }

  // Project-less items (milestones require a project, so the three others carry this case).
  for (const ty of ["task", "decision", "document"]) {
    let r: any;
    [s, r] = await api("POST", `/api/collections/${TYPES[ty]}/records`, alice, {
      workspace: WS,
      title: `PIV ${ty} project-less`,
    });
    check(`${TYPES[ty]}: project-less row created`, s, 200);
    fixtures[ty].projectless = r.id;
  }

  // The disclosure case the project_trashed FLAG exists for: this row stays visible through the
  // assignee escape while its project does not, so the column must not carry the project's date.
  let doomed_asg: any;
  [s, doomed_asg] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ2,
    title: "PIV task assigned inside the doomed project",
    assignee: asg_id,
  });
  check("task in the doomed project assigned to the soon-suspended member", s, 200);

  [s] = await api("DELETE", `/api/collections/projects/records/${PRJ2}`, alice);
  check("first DELETE trashes the doomed project", s, 204);

  // The assignee-only actor: assigned while an active member, then SUSPENDED — the only way
  // to reach tasks' `assignee = @request.auth.id` branch (a membership DELETE unassigns).
  let asg_task: any, r: any;
  [s, asg_task] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "PIV task for the suspended assignee",
    assignee: asg_id,
  });
  check("task assigned to the soon-to-be-suspended member", s, 200);
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
  const [assignee] = await login("piv-assignee@example.com");
  const [suspended] = await login("piv-susp@example.com");
  [s, r] = await api("GET", `/api/collections/tasks/records/${asg_task.id}`, assignee);
  check("suspension left the assignment in place", tup(s, r.assignee ?? null), tup(200, asg_id));

  // ── A SECOND WORKSPACE, cross-membership. The view resolves tenancy through aliased
  // @collection joins, so a dropped alias qualifier would let a privilege held in workspace B
  // satisfy workspace A's owner/admin branch. These two actors are the trap: A's plain member
  // OWNS B, and A's viewer is an ACTIVE ADMIN of B. Both must stay exactly what they are in A.
  console.log("\n── (1b) cross-workspace fixtures: privilege in B must not travel into A ──");
  let wsb: any;
  [s, wsb] = await api("POST", "/api/collections/workspaces/records", member, {
    name: "PIV Workspace B",
    owner: member_id,
  });
  check("A's plain member creates workspace B and owns it", s, 200);
  const WS_B: string = wsb.id;
  [s, r] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: WS_B,
    user: viewer_id,
    role: "admin",
    status: "active",
  });
  check("A's viewer is an ACTIVE ADMIN of workspace B", tup(s, r.role ?? null), tup(200, "admin"));
  const viewer_b_tier = await tierkit.actor_at_tier(
    WS_B,
    viewer_id,
    "admin",
    member,
    "PIV Viewer in B",
  );
  let pb_: any;
  [s, pb_] = await api("POST", "/api/collections/projects/records", member, {
    name: "PIV B Project",
    workspace: WS_B,
    owner: member_id,
  });
  check("project created inside workspace B", s, 200);
  const PRJ_B: string = pb_.id;
  const b_items: Record<string, string> = {};
  [s, r] = await api("POST", "/api/collections/tasks/records", member, {
    workspace: WS_B,
    project: PRJ_B,
    title: "PIV B live task",
  });
  check("live task in workspace B", s, 200);
  b_items["task"] = r.id;
  [s, r] = await api("POST", "/api/collections/decisions/records", member, {
    workspace: WS_B,
    project: PRJ_B,
    title: "PIV B draft decision",
    draft: true,
  });
  check("draft decision in workspace B, authored by B's owner", s, 200);
  b_items["draft"] = r.id;

  // ══════════════════ 2. RULE EQUIVALENCE — the leak gate ═════════════════════
  // COVERS: rule:project_items.list, rule:project_items.view
  console.log(
    "\n── (2) rule equivalence: the view lists EXACTLY what the base collections list ──",
  );
  // The filter the web proxy still sends. The rules now carry the same exclusion, so passing it
  // must change nothing — §2c pins that redundancy rather than assuming it.
  const DEFAULT_FILTER = 'trashed = "" && project_trashed = 0';
  const ROLES: [string, string | null][] = [
    ["owner (alice)", alice],
    ["workspace admin", admin],
    ["plain member", member],
    ["viewer", viewer],
    ["suspended member", suspended],
    ["assignee-only (suspended)", assignee],
    ["non-member", outsider],
    ["anonymous", null],
  ];
  let nonempty_pairs = 0;
  for (const [who, tok] of ROLES) {
    for (const [ty, coll] of Object.entries(TYPES)) {
      const [bs, brecs] = await list_all(coll, tok, { filter: `workspace='${WS}'` });
      const [vs, vrecs] = await list_all("project_items", tok, {
        filter: `workspace='${WS}' && type='${ty}' && ${DEFAULT_FILTER}`,
      });
      const [base_ids, view_ids] = [ids_of(brecs), ids_of(vrecs)];
      if (base_ids.size) {
        nonempty_pairs += 1;
      }
      let extra = "";
      if (!same_set(base_ids, view_ids)) {
        extra =
          `  base-only=${py_repr(sorted(set_diff(base_ids, view_ids)))} ` +
          `view-only=${py_repr(sorted(set_diff(view_ids, base_ids)))}`;
      }
      check(
        `${who.padEnd(26)} | ${coll.padEnd(11)} | base=${String(base_ids.size).padStart(2)} view=${String(view_ids.size).padStart(2)}${extra}`,
        tup(bs, vs, same_set(view_ids, base_ids)),
        tup(200, 200, true),
      );
    }
  }
  check(
    "the sweep compared non-empty result sets (not four empty lists)",
    nonempty_pairs >= 8,
    true,
  );

  // ── the UNFILTERED listing: nothing at all beyond the default one. Both state classes — a
  // TRASHED row, and a LIVE row under a trashed project — are now excluded by the rule itself,
  // so no caller filter is load-bearing for privacy any more. The superuser listing is the
  // authority for what those classes CONTAIN (rules do not apply to it), which is what makes
  // the four-tier emptiness below falsifiable rather than vacuous.
  const [, su_rows] = await list_all("project_items", su, { filter: `workspace='${WS}'` });
  const su_by_id = new Map<string, any>(su_rows.map((r) => [r.id, r]));
  const stateful = new Map<string, string>(
    su_rows
      .filter((r) => truthy(r.trashed) || truthy(r.project_trashed))
      .map((r) => [r.id, r.type]),
  );
  const live_under_trashed_project = new Set(
    [...stateful.keys()].filter(
      (rid) => !truthy(su_by_id.get(rid).trashed) && truthy(su_by_id.get(rid).project_trashed),
    ),
  );
  check(
    "the workspace really holds trashed / trashed-project rows to differ over",
    stateful.size >= 12,
    true,
  );
  check(
    "both state classes are populated (trashed rows AND live rows under a trashed project)",
    tup(stateful.size - live_under_trashed_project.size > 0, live_under_trashed_project.size > 0),
    tup(true, true),
  );
  for (const [who, tok] of ROLES) {
    const [, urecs] = await list_all("project_items", tok, { filter: `workspace='${WS}'` });
    const [, frecs] = await list_all("project_items", tok, {
      filter: `workspace='${WS}' && ${DEFAULT_FILTER}`,
    });
    const [unfiltered, filtered] = [ids_of(urecs), ids_of(frecs)];
    const admitted = new Set<string>();
    for (const [rid, ty] of stateful) {
      const [st] = await api("GET", `/api/collections/${TYPES[ty]}/records/${rid}`, tok);
      if (st === 200) {
        admitted.add(rid);
      }
    }
    check(
      `${who.padEnd(26)} | no state row is retrievable from its base collection any more (htsr/jwwp)`,
      sorted(admitted),
      [],
    );
    check(
      `${who.padEnd(26)} | the UNFILTERED view listing holds no state row either`,
      sorted([...unfiltered].filter((x) => stateful.has(x))),
      [],
    );
    check(
      `${who.padEnd(26)} | so the caller's state filter now changes nothing`,
      sorted(sym_diff(unfiltered, filtered)),
      [],
    );
  }

  // ── the surface that replaces the read: /api/tracker/trash still serves every trashed row
  // to the same actors, bypassing rules, so nothing became unreachable — only unreachable HERE.
  for (const [who, tok] of [
    ["owner (alice)", alice],
    ["workspace admin", admin],
    ["plain member", member],
    ["viewer", viewer],
  ] as [string, string | null][]) {
    let tr: any;
    [s, tr] = await api("GET", `/api/tracker/trash?workspace=${WS}`, tok);
    const trash_ids = new Set<string>((tr.items || []).map((i: any) => i.record.id));
    const [, vrecs] = await list_all("project_items", tok, {
      filter: `workspace='${WS}' && trashed != ""`,
    });
    check(
      `${who.padEnd(26)} | GET /api/tracker/trash still serves trashed rows`,
      tup(s, trash_ids.size > 0),
      tup(200, true),
    );
    check(
      `${who.padEnd(26)} | …while the view's own trash filter returns NONE of them`,
      tup(vrecs.length, sorted([...ids_of(vrecs)].filter((x) => trash_ids.has(x)))),
      tup(0, []),
    );
  }
  [s] = await api("GET", `/api/tracker/trash?workspace=${WS}`, outsider);
  check("non-member on /api/tracker/trash → 403", s, 403);
  [s] = await api("GET", `/api/tracker/trash?workspace=${WS}`, suspended);
  check("suspended member on /api/tracker/trash → 403", s, 403);

  // Named spot-checks, so a sweep that went uniformly empty could not pass it silently.
  const [, mrecs] = await list_all("project_items", member, { filter: `workspace='${WS}'` });
  const member_view = ids_of(mrecs);
  check(
    "member sees their OWN draft decision in the view",
    member_view.has(fixtures["decision"]["draft_member"]),
    true,
  );
  check(
    "member does NOT see the owner's draft decision in the view",
    member_view.has(fixtures["decision"]["draft_owner"]),
    false,
  );
  const [, arecs] = await list_all("project_items", admin, { filter: `workspace='${WS}'` });
  check(
    "admin DOES see the owner's draft document in the view",
    ids_of(arecs).has(fixtures["document"]["draft_owner"]),
    true,
  );
  let vrecs: any[];
  [, vrecs] = await list_all("project_items", viewer, { filter: `workspace='${WS}'` });
  const viewer_view = ids_of(vrecs);
  check(
    "viewer sees neither draft milestone",
    tup(
      viewer_view.has(fixtures["milestone"]["draft_owner"]),
      viewer_view.has(fixtures["milestone"]["draft_member"]),
    ),
    tup(false, false),
  );
  check("viewer DOES see the live milestone", viewer_view.has(fixtures["milestone"]["live"]), true);
  const [, orecs] = await list_all("project_items", alice, { filter: `workspace='${WS}'` });
  const owner_view = ids_of(orecs);
  const [, ofrecs] = await list_all("project_items", alice, {
    filter: `workspace='${WS}' && ${DEFAULT_FILTER}`,
  });
  const owner_default = ids_of(ofrecs);
  check(
    "a project-less task IS listed (the empty-relation escape holds)",
    owner_default.has(fixtures["task"]["projectless"]),
    true,
  );

  // ── (2b) the state exclusion, four tiers x four types ───────────────────────
  console.log(
    "\n── (2b) a trashed row is unlistable at EVERY tier, and by id only for whom the trash shows it ──",
  );
  // The OWNER is in the matrix deliberately: the list narrowing has no owner/admin carve-out, so a
  // rule that kept one would show up here and nowhere else.
  const STATE_TIERS: [string, string | null][] = [
    ["owner (alice)", alice],
    ["workspace admin", admin],
    ["plain member", member],
    ["viewer", viewer],
  ];
  for (const [who, tok] of STATE_TIERS) {
    for (const ty of Object.keys(TYPES)) {
      const rid = fixtures[ty]["trashed"];
      let body: any;
      [s, body] = await api("GET", `/api/collections/project_items/records/${rid}`, tok);
      check(
        `${who.padEnd(15)} | trashed ${ty.padEnd(9)} GET by id → 200 (trash branch), typed`,
        tup(s, body.type ?? null),
        tup(200, ty),
      );
      let recs: any[];
      [, recs] = await list_all("project_items", tok, { filter: `id='${rid}'` });
      check(
        `${who.padEnd(15)} | trashed ${ty.padEnd(9)} view list filter=id → n=0`,
        recs.length,
        0,
      );
      // The regression pin: the narrowing must not cost a LIVE row its 200.
      const lid = fixtures[ty]["live"];
      [s, body] = await api("GET", `/api/collections/project_items/records/${lid}`, tok);
      check(
        `${who.padEnd(15)} | live    ${ty.padEnd(9)} GET by id → 200 with its title`,
        tup(s, body.title ?? null),
        tup(200, `PIV ${ty} live`),
      );
      [, recs] = await list_all("project_items", tok, { filter: `id='${lid}'` });
      check(
        `${who.padEnd(15)} | live    ${ty.padEnd(9)} view list filter=id → n=1`,
        recs.length,
        1,
      );
    }
  }
  // A live row in a trashed project is in no trash listing, so no branch serves it; the owner's
  // trashed DRAFT keeps its privacy: only the owner and an admin pass the trash route's draft check.
  for (const [who, tok] of STATE_TIERS) {
    const drafts_visible = who === "owner (alice)" || who === "workspace admin";
    for (const [label, rid] of [
      ["row in a trashed project", fixtures["task"]["doomed"]],
      ["trashed draft decision   ", fixtures["decision"]["trashed_draft"]],
    ]) {
      const want = rid === fixtures["decision"]["trashed_draft"] && drafts_visible ? 200 : 404;
      [s] = await api("GET", `/api/collections/project_items/records/${rid}`, tok);
      check(`${who.padEnd(15)} | ${label} GET by id → ${want}`, s, want);
    }
    for (const [label, filt] of [
      ["trashed        ", 'trashed != ""'],
      ["trashed-project", "project_trashed != 0"],
    ]) {
      let recs: any[];
      [s, recs] = await list_all("project_items", tok, { filter: `workspace='${WS}' && ${filt}` });
      check(
        `${who.padEnd(15)} | \`${label}\` filter → 200 and EMPTY`,
        tup(s, recs.length),
        tup(200, 0),
      );
    }
  }
  for (const [who, tok] of [
    ["non-member", outsider],
    ["suspended member", suspended],
    ["anon", null],
  ] as [string, string | null][]) {
    for (const [label, filt] of [
      ["trashed", 'trashed != ""'],
      ["trashed-project", "project_trashed != 0"],
    ]) {
      let recs: any[];
      [s, recs] = await list_all("project_items", tok, { filter: `workspace='${WS}' && ${filt}` });
      check(
        `${who.padEnd(17)} | \`${label}\` filter → 200 and EMPTY`,
        tup(s, recs.length),
        tup(200, 0),
      );
    }
  }
  // The assignee escape does not survive the state clause either — the one actor whose access
  // to that row came from the record itself rather than from membership.
  [s] = await api("GET", `/api/collections/project_items/records/${doomed_asg.id}`, assignee);
  check("assignee-only caller: their row in the trashed project → 404 too", s, 404);
  [s] = await api("GET", `/api/collections/projects/records/${PRJ2}`, assignee);
  check("  …and that project itself stays 404 for them", s, 404);

  // project_trashed is what the rule's second leg reads, so its values still have to be pinned;
  // a superuser bypasses the rule and is the only caller that can still observe a 1.
  let doomed_row: any, live_row: any, pl_row: any;
  [s, doomed_row] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["task"]["doomed"]}`,
    su,
  );
  check(
    "project_trashed is the FLAG 1, never the project's trash timestamp",
    tup(s, doomed_row.project_trashed ?? null),
    tup(200, 1),
  );
  [s, live_row] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["task"]["live"]}`,
    su,
  );
  check("a live project reads 0", tup(s, live_row.project_trashed ?? null), tup(200, 0));
  [s, pl_row] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["task"]["projectless"]}`,
    su,
  );
  check(
    "a project-less row reads 0 too — which is why the rule still admits it",
    tup(s, pl_row.project_trashed ?? null),
    tup(200, 0),
  );
  const [, ptrecs] = await list_all("project_items", su, {
    filter: `workspace='${WS}' && project_trashed=1`,
  });
  const doomed_view = ids_of(ptrecs);
  check(
    "superuser: `project_trashed = 1` still lists every item inside the trashed project",
    sorted(Object.keys(TYPES).filter((t) => doomed_view.has(fixtures[t]["doomed"]))),
    ["decision", "document", "milestone", "task"],
  );
  check(
    "  …and excludes the project-less task (no project folds to 0, not 1)",
    doomed_view.has(fixtures["task"]["projectless"]),
    false,
  );

  // ── (2c) the rule's own exclusion == the listing the caller filter used to give ─
  console.log(
    "\n── (2c) the rule's state clause == what the caller's default filter used to do ──",
  );
  const base_union = new Set<string>();
  for (const coll of Object.values(TYPES)) {
    const [, brecs] = await list_all(coll, alice, { filter: `workspace='${WS}'` });
    for (const id of ids_of(brecs)) base_union.add(id);
  }
  console.log(
    `      owner over workspace ${WS}: base collections list ${base_union.size} rows · ` +
      `view unfiltered ${owner_view.size} · view with the default filter ${owner_default.size}`,
  );
  check(
    "the default-filtered view is exactly the four base listings unioned",
    tup(sorted(set_diff(owner_default, base_union)), sorted(set_diff(base_union, owner_default))),
    tup([], []),
  );
  check(
    "the UNFILTERED view is that same set — the rule now carries the exclusion",
    tup(sorted(set_diff(owner_view, base_union)), sorted(set_diff(base_union, owner_view))),
    tup([], []),
  );
  // The base rules spell the second term as a disjunction because `project.trashed` cannot be
  // read through an empty relation; the 0/1 flag folds that arm in, so the two must agree.
  const [, drecs] = await list_all("project_items", alice, {
    filter: `workspace='${WS}' && trashed = "" && (project = "" || project_trashed = 0)`,
  });
  check(
    'the base rules\' `(project = "" || project_trashed = 0)` disjunction adds nothing',
    sorted(ids_of(drecs)),
    sorted(owner_default),
  );
  const [, asgrecs] = await list_all("project_items", assignee);
  const asg_view = ids_of(asgrecs);
  check(
    "suspended assignee sees the ONE assigned task that is live in a live project",
    tup(same_set(asg_view, new Set([asg_task.id])), asg_view.size),
    tup(true, 1),
  );

  // Single-record viewRule: same answer as the list for the same actor.
  [s] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["decision"]["draft_owner"]}`,
    member,
  );
  check("member fetching the owner's draft by id → 404 (viewRule denies)", s, 404);
  [s] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["decision"]["draft_owner"]}`,
    admin,
  );
  check("admin fetching the same row by id → 200", s, 200);
  [s] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["task"]["live"]}`,
    outsider,
  );
  check("non-member fetching a live task by id → 404", s, 404);
  [s] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["task"]["live"]}`,
    null,
  );
  check("anonymous fetching a live task by id → 404", s, 404);

  // ── (2d) cross-workspace spoof: a privilege held in B must not satisfy A's branch ─
  console.log("\n── (2d) cross-workspace: the aliased joins correlate per row, not across rows ──");
  // Positive control first — the B-side tiers are real, so an A-side 404 is a genuine denial.
  let brecs: any[];
  [, brecs] = await list_all("project_items", viewer, { filter: `workspace='${WS_B}'` });
  const viewer_b = ids_of(brecs);
  check(
    "B's admin (A's viewer) DOES see B's draft decision — the admin branch works in B",
    tup(viewer_b.has(b_items["task"]), viewer_b.has(b_items["draft"])),
    tup(true, true),
  );
  [, brecs] = await list_all("project_items", member, { filter: `workspace='${WS_B}'` });
  const member_b = ids_of(brecs);
  check(
    "B's owner (A's plain member) sees both B rows",
    py_repr(sorted(member_b)) === py_repr(sorted([b_items["task"], b_items["draft"]])),
    true,
  );
  // …and now the trap: neither privilege reaches into A.
  const a_owner_drafts: Record<string, string> = Object.fromEntries(
    ["decision", "document", "milestone"].map((ty) => [ty, fixtures[ty]["draft_owner"]]),
  );
  for (const [who, tok] of [
    ["B's owner = A's plain member", member],
    ["B's admin = A's viewer", viewer],
  ] as [string, string | null][]) {
    const [, arecs2] = await list_all("project_items", tok, { filter: `workspace='${WS}'` });
    const a_view = ids_of(arecs2);
    check(
      `${who.padEnd(28)} | none of A's owner-authored drafts are listed`,
      sorted(
        Object.entries(a_owner_drafts)
          .filter(([, rid]) => a_view.has(rid))
          .map(([ty]) => ty),
      ),
      [],
    );
    for (const [ty, rid] of Object.entries(a_owner_drafts)) {
      [s] = await api("GET", `/api/collections/project_items/records/${rid}`, tok);
      check(`${who.padEnd(28)} | A's owner draft ${ty.padEnd(9)} by id → 404`, s, 404);
    }
    check(
      `${who.padEnd(28)} | no workspace-B row leaked into their A listing`,
      sorted([...a_view].filter((x) => Object.values(b_items).includes(x))),
      [],
    );
  }
  // And A's own owner reaches nothing in B.
  let arecs2: any[];
  [s, arecs2] = await list_all("project_items", alice, { filter: `workspace='${WS_B}'` });
  check("A's owner listing workspace B → 200 and EMPTY", tup(s, arecs2.length), tup(200, 0));
  for (const [label, rid] of Object.entries(b_items)) {
    [s] = await api("GET", `/api/collections/project_items/records/${rid}`, alice);
    check(`A's owner fetching B's ${label} row by id → 404`, s, 404);
  }

  check(
    "no workspace-B row appears in A's owner's own listing",
    sorted([...owner_view].filter((x) => Object.values(b_items).includes(x))),
    [],
  );
  await viewer_b_tier.done();

  // ══════════════════ 3. column parity: the CASTs do not mangle values ════════
  console.log("\n── (3) column parity: view columns carry the base record's values ──");
  let s2: number;
  let base_task: any, view_task: any, base_ms: any, view_ms: any;
  [s, base_task] = await api("GET", `/api/collections/tasks/records/${asg_task.id}`, alice);
  [s2, view_task] = await api(
    "GET",
    `/api/collections/project_items/records/${asg_task.id}`,
    alice,
  );
  check("view row fetched", tup(s, s2), tup(200, 200));
  check("type", view_task.type ?? null, "task");
  check("title", view_task.title ?? null, base_task.title ?? null);
  check("key", view_task.key ?? null, base_task.key ?? null);
  check("project", view_task.project ?? null, base_task.project ?? null);
  check("workspace", view_task.workspace ?? null, base_task.workspace ?? null);
  check("created", view_task.created ?? null, base_task.created ?? null);
  check("updated", view_task.updated ?? null, base_task.updated ?? null);
  check("assignee", view_task.assignee ?? null, base_task.assignee ?? null);
  check(
    "author on a task row is the base author",
    view_task.author ?? null,
    base_task.author ?? null,
  );
  check("that base author is the owner who created it", base_task.author ?? null, alice_id);
  check("draft is a real boolean", view_task.draft ?? null, false);
  [s, base_ms] = await api(
    "GET",
    `/api/collections/milestones/records/${fixtures["milestone"]["live"]}`,
    alice,
  );
  [s2, view_ms] = await api(
    "GET",
    `/api/collections/project_items/records/${fixtures["milestone"]["live"]}`,
    alice,
  );
  check("milestone row fetched", tup(s, s2), tup(200, 200));
  check(
    "a milestone's `name` is unified into `title`",
    view_ms.title ?? null,
    base_ms.name ?? null,
  );
  check(
    "author on a milestone row is the base author",
    view_ms.author ?? null,
    base_ms.author ?? null,
  );
  check("assignee is empty on a non-task row", view_ms.assignee ?? null, "");
  check("ordinal is 0 for a non-task row", view_ms.ordinal ?? null, 0);

  // COVERS: hook:author.pb.js#onRecordCreateRequest:tasks, hook:author.pb.js#onRecordUpdateRequest:tasks
  console.log("\n── (3b) task author: stamped from the caller at create, immutable after ──");
  const task_base = { workspace: WS, project: PRJ };
  let spoof: any, su_task: any;
  [s, spoof] = await api("POST", "/api/collections/tasks/records", member, {
    ...task_base,
    title: "PIV task, member submits the owner as author",
    author: alice_id,
  });
  check("member creates a task submitting author = owner", s, 200);
  check("  submitted author overwritten with the member", spoof.author ?? null, member_id);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${spoof.id}`, member, {
    author: alice_id,
  });
  check(
    "member (its author) repoints the task author → 400 author is immutable",
    tup(s, py_rstrip(py_str(r.message ?? "").toLowerCase(), ".")),
    tup(400, "author is immutable"),
  );
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${spoof.id}`, alice, {
    author: alice_id,
  });
  check("owner repoints the task author → 400 too", s, 400);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${spoof.id}`, su, {
    author: alice_id,
  });
  check("superuser repoints the task author → 400 too", s, 400);
  [s, r] = await api("GET", `/api/collections/tasks/records/${spoof.id}`, alice);
  check("  read-back: task author still the member", r.author ?? null, member_id);
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${spoof.id}`, member, {
    title: "PIV task, retitled",
  });
  check(
    "member PATCH that leaves author alone → 200",
    tup(s, r.author ?? null),
    tup(200, member_id),
  );
  [s, r] = await api("GET", `/api/collections/project_items/records/${spoof.id}`, alice);
  check("  view row carries the task author", tup(s, r.author ?? null), tup(200, member_id));
  [s, su_task] = await api("POST", "/api/collections/tasks/records", su, {
    ...task_base,
    title: "PIV task by superuser",
  });
  check(
    "superuser creates a task with no author submitted",
    tup(s, su_task.author ?? null),
    tup(200, ""),
  );
  [s, r] = await api("GET", `/api/collections/project_items/records/${su_task.id}`, alice);
  check("  its view row carries an empty author", tup(s, r.author ?? null), tup(200, ""));

  // ══════════════════ 4. ORDERING ═════════════════════════════════════════════
  console.log(
    "\n── (4) ordering: severity, the two-key empty-sinking sorts, cross-type interleave ──",
  );
  // 'none' is reserved (it CLEARS a priority and can never be a vocabulary entry), so the
  // writable valueless cases are: unset, and a value the workspace vocabulary no longer holds.
  [s, r] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, alice, {
    priorities: [
      ...(await api("GET", `/api/collections/workspaces/records/${WS}`, alice))[1]["priorities"],
      { name: "p0" },
    ],
  });
  check("workspace vocabulary widened to the four default levels + one custom value", s, 200);
  const PRIO: Record<string, string> = Object.fromEntries(
    (r.priorities || []).map((p: any) => [p.name, p.id]),
  );
  [s] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "PIV prio none",
    priority: "none",
  });
  check("a task can never store the reserved 'none' token → 400", s, 400);

  const order_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Ordering",
      workspace: WS,
      owner: alice_id,
    })
  )[1]["id"];
  const prio_ids: Record<string, string> = {};
  for (const [label, value] of [
    ["urgent", "urgent"],
    ["high", "high"],
    ["medium", "medium"],
    ["low", "low"],
    ["custom-p0", "p0"],
    ["unset", null],
  ] as [string, string | null][]) {
    const body: Record<string, any> = {
      workspace: WS,
      project: order_prj,
      title: `PIV prio ${label}`,
    };
    if (value !== null) {
      body["priority"] = PRIO[value];
    }
    [s, r] = await api("POST", "/api/collections/tasks/records", alice, body);
    check(`priority fixture ${py_repr(label)} created`, s, 200);
    prio_ids[label] = r.id;
  }

  let prio_rows: any[];
  [s, prio_rows] = await list_all("project_items", alice, {
    filter: `project='${order_prj}'`,
    sort: "-has_priority,priority_rank",
  });
  const ranked = prio_rows.map((r) =>
    tup(r.title.replace("PIV prio ", ""), r.priority_rank, r.has_priority),
  );
  check(
    "severity order is the declared vocabulary order, then every valueless row",
    ranked.map(([t]) => t),
    ["urgent", "high", "medium", "low", "custom-p0", "unset"],
  );
  check(
    "their ranks are their positions in this workspace's vocabulary",
    ranked.map(([, rk]) => rk),
    [0, 1, 2, 3, 4, SINK_RANK],
  );
  check(
    "the custom entry is RANKED like any other — only the unset row is valueless",
    ranked.map(([, , h]) => h),
    [1, 1, 1, 1, 1, 0],
  );

  // ── 4a. a workspace that never edited its vocabulary ranks exactly as it always has ──
  let ws_default: any;
  [s, ws_default] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PIV Default Vocab",
    owner: alice_id,
  });
  check("second workspace created, vocabulary untouched", s, 200);
  const WSD: string = ws_default.id;
  [s, ws_default] = await api("GET", `/api/collections/workspaces/records/${WSD}`, alice);
  check(
    "  …and it holds the provisioned default vocabulary",
    (ws_default.priorities || []).map((p: any) => p.name),
    DEFAULT_VOCAB,
  );
  const WSD_PRIO: Record<string, string> = Object.fromEntries(
    (ws_default.priorities || []).map((p: any) => [p.name, p.id]),
  );
  const wsd_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Default Vocab Project",
      workspace: WSD,
      owner: alice_id,
    })
  )[1]["id"];
  for (const level of DEFAULT_VOCAB) {
    [s] = await api("POST", "/api/collections/tasks/records", alice, {
      workspace: WSD,
      project: wsd_prj,
      title: `PIV def ${level}`,
      priority: WSD_PRIO[level],
    });
    check(`default-vocab task ${py_repr(level)} created`, s, 200);
  }
  let wsd_rows: any[];
  [, wsd_rows] = await list_all("project_items", alice, {
    filter: `project='${wsd_prj}'`,
    sort: "-has_priority,priority_rank",
  });
  check(
    "urgent/high/medium/low still rank 0/1/2/3 under the default vocabulary",
    wsd_rows.map((r) => tup(r.title.replace("PIV def ", ""), r.priority_rank)),
    DEFAULT_VOCAB.map((level, i) => tup(level, i)),
  );

  // ── 4b-vocab. a fully custom vocabulary ranks by DECLARATION, not alphabetically ──
  // Declared blocker/annoying/whenever; alphabetical is annoying/blocker/whenever, and none of
  // the three is a value the old fixed enum knew — so an index-by-declaration is the only
  // ordering that can produce the asserted result.
  const CUSTOM_VOCAB = ["blocker", "annoying", "whenever"];
  check(
    "the custom vocabulary is declared in a NON-alphabetical order",
    py_repr(CUSTOM_VOCAB) === py_repr(sorted(CUSTOM_VOCAB)),
    false,
  );
  check(
    "…and shares no entry with the old fixed enum",
    sorted(CUSTOM_VOCAB.filter((x) => ["urgent", "high", "medium", "low", "none"].includes(x))),
    [],
  );
  let ws_custom: any, wsc_vocab: any;
  [s, ws_custom] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PIV Custom Vocab",
    owner: alice_id,
  });
  check("third workspace created", s, 200);
  const WSC: string = ws_custom.id;
  [s, wsc_vocab] = await api("PATCH", `/api/collections/workspaces/records/${WSC}`, alice, {
    priorities: CUSTOM_VOCAB.map((n) => ({ name: n })),
  });
  const WSC_PRIO: Record<string, string> = Object.fromEntries(
    (wsc_vocab.priorities || []).map((p: any) => [p.name, p.id]),
  );
  check("custom three-name vocabulary accepted", s, 200);
  const wsc_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Custom Vocab Project",
      workspace: WSC,
      owner: alice_id,
    })
  )[1]["id"];
  for (const name of CUSTOM_VOCAB) {
    [s] = await api("POST", "/api/collections/tasks/records", alice, {
      workspace: WSC,
      project: wsc_prj,
      title: `PIV cv ${name}`,
      priority: WSC_PRIO[name],
    });
    check(`custom-vocab task ${py_repr(name)} created`, s, 200);
  }

  const cv_rows = async (sort: string) => {
    const [, rows] = await list_all("project_items", alice, {
      filter: `project='${wsc_prj}'`,
      sort,
    });
    return rows.map((r) => tup(r.title.replace("PIV cv ", ""), r.priority_rank, r.has_priority));
  };

  const asc = await cv_rows("-has_priority,priority_rank");
  check(
    "a custom vocabulary ranks 0/1/2 in DECLARED order",
    asc,
    CUSTOM_VOCAB.map((name, i) => tup(name, i, 1)),
  );
  check(
    "  …and the descending sort is the declared order reversed",
    (await cv_rows("-has_priority,-priority_rank")).map(([t]) => t),
    [...CUSTOM_VOCAB].reverse(),
  );
  check(
    "  …which is NOT what an alphabetical ranking would have produced",
    py_repr(asc.map(([t]) => t)) === py_repr(sorted(CUSTOM_VOCAB)),
    false,
  );

  // ── 4c. retiring an entry sinks the rows still holding it, both directions ──
  // The FIRST-declared entry is the one retired, deliberately: these fixtures were created in
  // declared order, so retiring the LAST one would put it last under insertion order alone and
  // the two sink checks below would pass against a view that does no sinking at all.
  const retired_name = CUSTOM_VOCAB[0];
  const survivors = CUSTOM_VOCAB.slice(1);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WSC}`, alice, {
    priorities: wsc_vocab["priorities"].filter((p: any) => survivors.includes(p.name)),
  });
  check("the first-declared vocabulary entry is retired", s, 200);
  const retired = await cv_rows("-has_priority,priority_rank");
  check(
    "a task holding the retired value keeps it stored",
    sorted(retired.map(([t]) => t)),
    sorted(CUSTOM_VOCAB),
  );
  check(
    "  …but it is now valueless: has_priority 0 at the sink rank",
    retired.filter(([t]) => t === retired_name).map(([, rk, h]) => tup(rk, h)),
    [tup(SINK_RANK, 0)],
  );
  check(
    "  …while the two surviving entries keep ranking by declaration",
    retired.filter(([t]) => t !== retired_name).map(([t, rk, h]) => tup(t, rk, h)),
    survivors.map((name, i) => tup(name, i, 1)),
  );
  check("  …so it is LAST ascending", retired.map(([t]) => t).at(-1), retired_name);
  check(
    "  …and LAST descending too",
    (await cv_rows("-has_priority,-priority_rank")).map(([t]) => t).at(-1),
    retired_name,
  );

  // ── 4d. a malformed `priorities` value must not fail the whole listing ──
  // json_each RAISES on malformed JSON, so an unguarded lookup would 400 EVERY list query in
  // the deployment, not just this workspace's rows. No API path can store it (the vocabulary
  // guard rejects non-array JSON), so the fixture is written straight into SQLite.
  const write_vocab_raw = (ws_id: string, raw: string): void => {
    const conn = sqlite_connect(path.join(DATA_DIR, "data.db"), { timeout: 15 });
    try {
      conn.run("UPDATE workspaces SET priorities = ? WHERE id = ?", [raw, ws_id]);
    } finally {
      conn.close();
    }
  };

  write_vocab_raw(WSC, "{not json at all");
  let malformed_ws: any, body: any;
  [s, malformed_ws] = await api("GET", `/api/collections/workspaces/records/${WSC}`, alice);
  check(
    "malformed vocabulary is really stored",
    tup(s, malformed_ws.priorities ?? null),
    tup(200, "{not json at all"),
  );
  [s, body] = await page("project_items", alice, { filter: `project='${wsc_prj}'`, perPage: 50 });
  check("the view still ANSWERS over a workspace with a malformed vocabulary", s, 200);
  check(
    "  …and every one of its rows is simply unranked",
    (body.items || [])
      .map((r: any) => tup(r.priority_rank, r.has_priority))
      .sort((a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1]),
    Array(3).fill(tup(SINK_RANK, 0)),
  );
  [s, body] = await page("project_items", alice, { filter: `project='${order_prj}'`, perPage: 50 });
  check("  …and a healthy workspace listed afterwards is unaffected", s, 200);
  write_vocab_raw(WSC, json_dumps(CUSTOM_VOCAB.slice(0, 2)));

  const due_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Dates",
      workspace: WS,
      owner: alice_id,
    })
  )[1]["id"];
  for (const [title, due] of [
    ["early", "2026-01-05 09:00:00.000Z"],
    ["late", "2026-12-24 09:00:00.000Z"],
    ["mid", "2026-06-15 09:00:00.000Z"],
    ["dateless", null],
  ] as [string, string | null][]) {
    const body: Record<string, any> = {
      workspace: WS,
      project: due_prj,
      title: `PIV due ${title}`,
    };
    if (due !== null) {
      body["due"] = due;
    }
    [s] = await api("POST", "/api/collections/tasks/records", alice, body);
    check(`due fixture ${py_repr(title)} created`, s, 200);
  }
  [s] = await api("POST", "/api/collections/milestones/records", alice, {
    workspace: WS,
    project: due_prj,
    name: "PIV due milestone-target",
    target: "2026-03-01 09:00:00.000Z",
  });
  check("a milestone's `target` is the same date axis", s, 200);

  const due_titles = async (sort: string): Promise<string[]> => {
    const [, rows] = await list_all("project_items", alice, {
      filter: `project='${due_prj}'`,
      sort,
    });
    return rows.map((r) => r.title.replace("PIV due ", ""));
  };

  check(
    "ascending  (-has_due,due):  earliest first, dateless LAST",
    await due_titles("-has_due,due"),
    ["early", "milestone-target", "mid", "late", "dateless"],
  );
  check(
    "descending (-has_due,-due): latest first, dateless STILL last",
    await due_titles("-has_due,-due"),
    ["late", "mid", "milestone-target", "early", "dateless"],
  );

  const mixed_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Interleave",
      workspace: WS,
      owner: alice_id,
    })
  )[1]["id"];
  const interleaved: [string, string][] = [];
  for (const [n, [ty, coll]] of Object.entries(TYPES).entries()) {
    const title_field = coll === "milestones" ? "name" : "title";
    [s, r] = await api("POST", `/api/collections/${coll}/records`, alice, {
      workspace: WS,
      project: mixed_prj,
      [title_field]: `PIV mix ${n} ${ty}`,
    });
    check(`interleave fixture ${ty} created`, s, 200);
    interleaved.push([ty, r.id]);
    await Bun.sleep(10); // distinct `created` stamps, so the chronological assertion is decidable
  }

  let rows: any[];
  [, rows] = await list_all("project_items", alice, {
    filter: `project='${mixed_prj}'`,
    sort: "created",
  });
  check(
    "sort=created interleaves all four types in creation order",
    rows.map((r) => r.type),
    interleaved.map(([ty]) => ty),
  );
  [, rows] = await list_all("project_items", alice, {
    filter: `project='${mixed_prj}'`,
    sort: "-updated",
  });
  check(
    "sort=-updated returns the same four rows, newest first",
    rows.map((r) => r.id),
    [...interleaved].reverse().map(([, i]) => i),
  );
  [, rows] = await list_all("project_items", alice, {
    filter: `project='${mixed_prj}'`,
    sort: "title",
  });
  check(
    "sort=title is alphabetical ACROSS types, not grouped by type",
    rows.map((r) => r.title),
    sorted(rows.map((r) => r.title)),
  );
  check("  …and that ordering really mixes the types", sorted(new Set(rows.map((r) => r.type))), [
    "decision",
    "document",
    "milestone",
    "task",
  ]);

  // ══════════════════ 4b. THE SIX FILTER COLUMNS ══════════════════════════════
  console.log("\n── (4b) status/priority/parent/milestone/labels/dependencies filter per type ──");
  // Reuses §4's widened workspace vocabulary for the custom (non-contract) priority value.
  const col_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Columns",
      workspace: WS,
      owner: alice_id,
    })
  )[1]["id"];
  const [, ws_statuses] = await list_all("statuses", alice, { filter: `workspace='${WS}'` });
  check(
    "workspace has at least two statuses to discriminate between",
    ws_statuses.length >= 2,
    true,
  );
  const [S1, S2] = [ws_statuses[0].id, ws_statuses[1].id];
  let lab: any, lab_other: any, parent_t: any, dep_t: any, col_ms: any, child_t: any;
  let col_dec: any, col_doc: any;
  [s, lab] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: WS,
    name: "piv-column-label",
  });
  check("label fixture created", s, 200);
  [s, lab_other] = await api("POST", "/api/collections/labels/records", alice, {
    workspace: WS,
    name: "piv-column-label-other",
  });
  check("second, never-attached label created", s, 200);
  [s, parent_t] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: col_prj,
    title: "PIV col parent",
    status: S2,
  });
  check("parent task created", s, 200);
  [s, dep_t] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: col_prj,
    title: "PIV col dependency",
    status: S2,
  });
  check("dependency task created", s, 200);
  [s, col_ms] = await api("POST", "/api/collections/milestones/records", alice, {
    workspace: WS,
    project: col_prj,
    name: "PIV col milestone",
  });
  check("milestone created", s, 200);
  [s, child_t] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: col_prj,
    title: "PIV col child",
    status: S1,
    priority: PRIO["p0"],
    parent: parent_t["id"],
    milestone: col_ms["id"],
    labels: [lab["id"]],
    dependencies: [dep_t["id"]],
  });
  check("task carrying all six column values created", s, 200);
  [s, col_dec] = await api("POST", "/api/collections/decisions/records", alice, {
    workspace: WS,
    project: col_prj,
    title: "PIV col decision",
    status: "accepted",
  });
  check("decision with a free-text status created", s, 200);
  [s, col_doc] = await api("POST", "/api/collections/documents/records", alice, {
    workspace: WS,
    project: col_prj,
    title: "PIV col document",
  });
  check("document created", s, 200);

  const col_ids = async (filt: string): Promise<Set<string>> => {
    const [, rows] = await list_all("project_items", alice, {
      filter: `project='${col_prj}' && ${filt}`,
    });
    return ids_of(rows);
  };

  for (const [label, filt, want] of [
    ["status = a task's status RELATION id", `status='${S1}'`, new Set([child_t["id"]])],
    ["status = the other status id", `status='${S2}'`, new Set([parent_t["id"], dep_t["id"]])],
    ["status = a decision's FREE-TEXT value", "status='accepted'", new Set([col_dec["id"]])],
    ["priority = a custom-vocabulary id", `priority='${PRIO["p0"]}'`, new Set([child_t["id"]])],
    ["parent = the parent task's id", `parent='${parent_t["id"]}'`, new Set([child_t["id"]])],
    ["milestone = the milestone's id", `milestone='${col_ms["id"]}'`, new Set([child_t["id"]])],
    ["labels ~ the attached label id", `labels~'${lab["id"]}'`, new Set([child_t["id"]])],
    ["labels ~ a label attached to nothing", `labels~'${lab_other["id"]}'`, new Set<string>()],
    [
      "dependencies ~ the depended-on task id",
      `dependencies~'${dep_t["id"]}'`,
      new Set([child_t["id"]]),
    ],
    [
      "dependencies ~ an id that is not a dependency",
      `dependencies~'${parent_t["id"]}'`,
      new Set<string>(),
    ],
  ] as [string, string, Set<string>][]) {
    check(`filter ${label}`, sorted(await col_ids(filt)), sorted(want));
  }

  // The types that carry no such field must read '' — an empty string, never null or json.
  for (const [who, rid] of [
    ["document", col_doc["id"]],
    ["milestone", col_ms["id"]],
  ]) {
    let row: any;
    [s, row] = await api("GET", `/api/collections/project_items/records/${rid}`, alice);
    check(
      `${who} row: all six columns are ''`,
      tup(s, [
        row.status ?? null,
        row.priority ?? null,
        row.parent ?? null,
        row.milestone ?? null,
        row.labels ?? null,
        row.dependencies ?? null,
      ]),
      tup(200, ["", "", "", "", "", ""]),
    );
  }
  let drow: any, crow: any;
  [s, drow] = await api("GET", `/api/collections/project_items/records/${col_dec["id"]}`, alice);
  check(
    "decision row: status carries, the other five are ''",
    tup(s, drow.status ?? null, [
      drow.priority ?? null,
      drow.parent ?? null,
      drow.milestone ?? null,
      drow.labels ?? null,
      drow.dependencies ?? null,
    ]),
    tup(200, "accepted", ["", "", "", "", ""]),
  );
  [s, crow] = await api("GET", `/api/collections/project_items/records/${child_t["id"]}`, alice);
  check(
    "task row: the six columns carry the base record's values",
    tup(s, crow.status ?? null, crow.priority ?? null, crow.parent ?? null, crow.milestone ?? null),
    tup(200, S1, PRIO["p0"], parent_t["id"], col_ms["id"]),
  );
  check(
    "  …and the two array columns arrive as their flattened JSON text",
    tup(JSON.parse(crow.labels), JSON.parse(crow.dependencies)),
    tup([lab["id"]], [dep_t["id"]]),
  );
  // A non-member must not reach these rows through a column filter either.
  const [, orows] = await list_all("project_items", outsider, {
    filter: `project='${col_prj}' && labels~'${lab["id"]}'`,
  });
  check("non-member filtering on labels gets nothing", orows.length, 0);

  // ══════════════════ 5. TRUE TOTAL + FULL REACHABILITY (>200 items) ══════════
  console.log(
    `\n── (5) ${BULK_TOTAL} items in one project: true totalItems and both ends reachable ──`,
  );
  const bulk_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Bulk",
      workspace: WS,
      owner: alice_id,
    })
  )[1]["id"];
  const order = Object.entries(TYPES);
  const expected = new Map<string, [string, number]>(); // id -> (title, priority_rank)
  const t0 = Date.now() / 1000;
  let created_ok = 0;
  for (let i = 0; i < BULK_TOTAL; i++) {
    const [ty, coll] = order[i % 4];
    const title = `BULK-${String(i).padStart(4, "0")}-${ty}`;
    const title_field = coll === "milestones" ? "name" : "title";
    const body: Record<string, any> = { workspace: WS, project: bulk_prj, [title_field]: title };
    let rank = SINK_RANK;
    if (ty === "task") {
      const level = DEFAULT_VOCAB[Math.floor(i / 4) % 4];
      body["priority"] = PRIO[level];
      // This project lives in WS, whose vocabulary §4 widened to DEFAULT_VOCAB + "p0".
      rank = DEFAULT_VOCAB.indexOf(level);
    }
    [s, r] = await api("POST", `/api/collections/${coll}/records`, alice, body);
    if (s === 200) {
      created_ok += 1;
      expected.set(r["id"], [title, rank]);
    }
  }
  check(`all ${BULK_TOTAL} bulk items created`, created_ok, BULK_TOTAL);
  console.log(`      seeded in ${(Date.now() / 1000 - t0).toFixed(1)}s`);

  let pg: any;
  [s, pg] = await page("project_items", alice, { filter: `project='${bulk_prj}'`, perPage: 1 });
  check(
    "PocketBase reports the TRUE total, not a page-capped one",
    pg.totalItems ?? null,
    BULK_TOTAL,
  );
  check("  …and that total is above the 200-row page horizon", BULK_TOTAL > 200, true);
  let base_total = 0;
  for (const coll of Object.values(TYPES)) {
    const [, brecs] = await list_all(coll, alice, { filter: `project='${bulk_prj}'` });
    base_total += brecs.length;
  }
  check(
    "the view's total equals the four base collections' totals summed",
    pg.totalItems ?? null,
    base_total,
  );

  for (const [sort, key] of [
    ["title", (kv: [string, [string, number]]) => kv[1][0]],
    [
      "-has_priority,priority_rank,id",
      (kv: [string, [string, number]]) =>
        [kv[1][1] !== SINK_RANK ? -1 : 0, kv[1][1], kv[0]] as [number, number, string],
    ],
  ] as [string, (kv: [string, [string, number]]) => string | [number, number, string]][]) {
    const want = [...expected.entries()]
      .sort((a, b) => {
        const [ka, kb] = [key(a), key(b)];
        if (typeof ka === "string" || typeof kb === "string") {
          return by_code_point(ka as string, kb as string);
        }
        return ka[0] - kb[0] || ka[1] - kb[1] || by_code_point(ka[2], kb[2]);
      })
      .map(([i]) => i);
    const t1 = Date.now() / 1000;
    const walked: string[] = [];
    let page_no = 1;
    while (true) {
      [s, body] = await page("project_items", alice, {
        filter: `project='${bulk_prj}'`,
        sort,
        page: page_no,
        perPage: 50,
      });
      check(`sort=${sort} page ${page_no} → 200`, s, 200);
      walked.push(...(body.items || []).map((r: any) => r.id));
      if (page_no >= (body.totalPages || 1)) {
        break;
      }
      page_no += 1;
    }
    check(`sort=${sort}: pages walked`, page_no, 5);
    check(`sort=${sort}: every item reached exactly once`, walked.length, BULK_TOTAL);
    check(`sort=${sort}: the walk reaches the TRUE FIRST item`, walked[0], want[0]);
    check(`sort=${sort}: the walk reaches the TRUE LAST item`, walked.at(-1), want.at(-1));
    // Reported as a position, not two 210-id lists — a printed haystack hides the needle.
    let drift: number | null = null;
    for (let n = 0; n < Math.min(walked.length, want.length); n++) {
      if (walked[n] !== want[n]) {
        drift = n;
        break;
      }
    }
    check(`sort=${sort}: the whole ordering matches (first divergence, None = clean)`, drift, null);
    console.log(`      walked ${walked.length} rows in ${(Date.now() / 1000 - t1).toFixed(1)}s`);
  }

  // Scale must not weaken the rules: the outsider still sees none of it.
  [s, body] = await page("project_items", outsider, {
    filter: `project='${bulk_prj}'`,
    perPage: 1,
  });
  check(
    "non-member's total over the bulk project is 0",
    tup(s, body.totalItems ?? null),
    tup(200, 0),
  );

  // ══════════════════ 5b. COUNTS, STATUS FLAGS, TRASH BRANCH, STATUS ENRICH ════
  // COVERS: hook:counts.pb.js#onRecordEnrich:project_items, hook:counts.pb.js#onRecordEnrich:statuses
  console.log("\n── (5b) per-row counts, open/terminal flags, the trash branch, status flags ──");
  const sql_write = (sql: string, params: any[]): void => {
    const conn = sqlite_connect(path.join(DATA_DIR, "data.db"), { timeout: 15 });
    try {
      conn.run(sql, params);
    } finally {
      conn.close();
    }
  };
  const view_row = async (rid: string, tok: string | null = alice): Promise<[number, any]> =>
    api("GET", `/api/collections/project_items/records/${rid}`, tok);
  const cnt_prj: string = (
    await api("POST", "/api/collections/projects/records", alice, {
      name: "PIV Counts",
      workspace: WS,
      owner: alice_id,
    })
  )[1]["id"];
  const cat_status: Record<string, string> = {};
  for (const st of ws_statuses) if (!(st.category in cat_status)) cat_status[st.category] = st.id;
  [s, r] = await api("POST", "/api/collections/statuses/records", alice, {
    workspace: WS,
    name: "PIV Triage",
    category: "triage",
  });
  check("a triage-category status added to the workspace", s, 200);
  cat_status["triage"] = r.id;
  check(
    "the workspace now holds one status per category",
    sorted(Object.keys(cat_status)),
    sorted(["triage", "backlog", "unstarted", "started", "completed", "canceled"]),
  );

  // ── 501+ children: one parent task and one milestone over the same 501 terminal children ──
  const CHILDREN = 501;
  const DONE_CHILDREN = 300; // a mix, so done copying total cannot pass
  let cnt_parent: any, cnt_ms: any;
  [s, cnt_parent] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: cnt_prj,
    title: "PIV counts parent",
  });
  check("counts parent task created", s, 200);
  [s, cnt_ms] = await api("POST", "/api/collections/milestones/records", alice, {
    workspace: WS,
    project: cnt_prj,
    name: "PIV counts milestone",
  });
  check("counts milestone created", s, 200);
  const t_seed = Date.now() / 1000;
  const child_bodies = Array.from({ length: CHILDREN + 1 }, (_, i) => ({
    workspace: WS,
    project: cnt_prj,
    title: `PIV child ${String(i).padStart(3, "0")}`,
    parent: cnt_parent.id,
    milestone: cnt_ms.id,
    status:
      i >= DONE_CHILDREN
        ? cat_status["started"]
        : i % 2
          ? cat_status["completed"]
          : cat_status["canceled"],
  }));
  const child_ids: string[] = [];
  let batch_ok = true;
  for (let i = 0; i < child_bodies.length; i += 50) {
    const reqs = child_bodies
      .slice(i, i + 50)
      .map((b) => ({ method: "POST", url: "/api/collections/tasks/records", body: b }));
    let resp: any;
    [s, resp] = await api("POST", "/api/batch", su, { requests: reqs });
    if (s !== 200) batch_ok = false;
    for (const item of Array.isArray(resp) ? resp : []) {
      if (item.status !== 200) batch_ok = false;
      child_ids.push((item.body || {}).id);
    }
  }
  check(
    `all ${CHILDREN + 1} children created through /api/batch`,
    tup(batch_ok, child_ids.length),
    tup(true, CHILDREN + 1),
  );
  [s] = await api("DELETE", `/api/collections/tasks/records/${child_ids.at(-1)}`, alice);
  check("one child trashed (it must not count)", s, 204);
  console.log(
    `      seeded ${child_ids.length} children in ${(Date.now() / 1000 - t_seed).toFixed(1)}s`,
  );
  for (const [label, rid] of [
    ["parent task", cnt_parent.id],
    ["milestone  ", cnt_ms.id],
  ]) {
    const [vs, row] = await view_row(rid);
    check(
      `${label}: subtask_total and subtask_done past 500, the trashed child excluded`,
      tup(vs, row.subtask_total ?? null, row.subtask_done ?? null),
      tup(200, CHILDREN, DONE_CHILDREN),
    );
  }

  // ── comment_count per type ──
  let cm_task: any, cm_doc: any, cm_dec: any;
  [, cm_task] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: cnt_prj,
    title: "PIV commented task",
  });
  [, cm_doc] = await api("POST", "/api/collections/documents/records", alice, {
    workspace: WS,
    project: cnt_prj,
    title: "PIV commented document",
  });
  [, cm_dec] = await api("POST", "/api/collections/decisions/records", alice, {
    workspace: WS,
    project: cnt_prj,
    title: "PIV commented decision",
  });
  let first_comment: any;
  [s, first_comment] = await api("POST", "/api/collections/comments/records", alice, {
    task: cm_task.id,
    body: "first",
  });
  check("comment on the task created", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", member, {
    task: cm_task.id,
    body: "a reply counts too",
    parent: first_comment.id,
  });
  check("a reply on the task created", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    document: cm_doc.id,
    body: "doc note",
  });
  check("comment on the document created", s, 200);
  for (const n of [1, 2, 3]) {
    [s] = await api("POST", "/api/collections/comments/records", alice, {
      decision: cm_dec.id,
      body: `decision note ${n}`,
    });
    check(`comment ${n} on the decision created`, s, 200);
  }
  for (const [label, rid, want] of [
    ["task", cm_task.id, 2],
    ["document", cm_doc.id, 1],
    ["decision", cm_dec.id, 3],
    ["milestone", cnt_ms.id, 0],
  ] as [string, string, number][]) {
    const [vs, row] = await view_row(rid);
    check(`comment_count on the ${label} row`, tup(vs, row.comment_count ?? null), tup(200, want));
  }

  // ── privacy: a non-member assignee counts only the children assigned to them ──
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${asg_row}`, alice, {
    status: "active",
  });
  check("assignee re-activated to receive fixtures", s, 200);
  const asg_children: string[] = [];
  for (const [title, assignee_id, status] of [
    ["mine, done", asg_id, cat_status["completed"]],
    ["mine, open", asg_id, cat_status["started"]],
    ["not mine, done", "", cat_status["completed"]],
  ] as [string, string, string][]) {
    [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
      workspace: WS,
      project: PRJ,
      title: `PIV asg child ${title}`,
      parent: asg_task.id,
      assignee: assignee_id,
      status,
    });
    check(`child of the assignee's task: ${title}`, s, 200);
    asg_children.push(r.id);
  }
  let asg_trash: any;
  [s, asg_trash] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: PRJ,
    title: "PIV assigned task about to be trashed",
    assignee: asg_id,
  });
  check("a second task assigned to them (to be trashed)", s, 200);
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${asg_row}`, alice, {
    status: "suspended",
  });
  check("assignee suspended again", s, 200);
  let row: any;
  [s, row] = await view_row(asg_task.id, assignee);
  check(
    "non-member assignee: subtask counts cover only their own children",
    tup(s, row.subtask_total ?? null, row.subtask_done ?? null),
    tup(200, 2, 1),
  );
  const [, asg_list] = await list_all("project_items", assignee, { filter: `id='${asg_task.id}'` });
  check(
    "  …in the list response too",
    asg_list.map((x) => tup(x.subtask_total ?? null, x.subtask_done ?? null)),
    [tup(2, 1)],
  );
  [s, row] = await view_row(asg_task.id, member);
  check(
    "a member sees the full count",
    tup(s, row.subtask_total ?? null, row.subtask_done ?? null),
    tup(200, 3, 2),
  );
  // Filter and sort are the oracle a body rewrite cannot reach: the counts must not be view columns.
  for (const [label, params] of [
    ["filter subtask_total=3", { filter: `id='${asg_task.id}' && subtask_total=3` }],
    ["filter subtask_done=2", { filter: `id='${asg_task.id}' && subtask_done=2` }],
    ["sort subtask_total", { filter: `id='${asg_task.id}'`, sort: "subtask_total" }],
  ] as [string, Record<string, string>][]) {
    let body: any;
    [s, body] = await page("project_items", assignee, params);
    console.log(`      non-member assignee ${label}: HTTP ${s}, rows=${(body.items || []).length}`);
    check(
      `non-member assignee: ${label} → 400, no row to read`,
      tup(s, body.items ?? null),
      tup(400, null),
    );
  }
  [s, row] = await view_row(cm_doc.id);
  check(
    "a document row is served subtask counts of 0",
    tup(s, row.subtask_total ?? null, row.subtask_done ?? null),
    tup(200, 0, 0),
  );

  // ── a child left in a trashed project is listable by nobody, so it is not counted ──
  let old_prj: any, moved: any;
  [s, old_prj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "PIV Left Behind",
    workspace: WS,
    owner: alice_id,
  });
  check("a project the parent will leave", s, 200);
  [s, moved] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: old_prj.id,
    title: "PIV parent that moves",
  });
  check("  parent created in it", s, 200);
  for (const status of [cat_status["completed"], cat_status["started"]]) {
    [s] = await api("POST", "/api/collections/tasks/records", alice, {
      workspace: WS,
      project: old_prj.id,
      title: "PIV child left behind",
      parent: moved.id,
      status,
    });
    check("  child created beside it", s, 200);
  }
  [s, r] = await api("PATCH", `/api/collections/tasks/records/${moved.id}`, alice, {
    project: cnt_prj,
  });
  check("  the parent moves to another project", tup(s, r.project ?? null), tup(200, cnt_prj));
  [s] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: cnt_prj,
    title: "PIV child in the new project",
    parent: moved.id,
    status: cat_status["completed"],
  });
  check("  a child created in the new project", s, 200);
  [s, row] = await view_row(moved.id, member);
  check(
    "  before the old project is trashed: (3, 2)",
    tup(s, row.subtask_total ?? null, row.subtask_done ?? null),
    tup(200, 3, 2),
  );
  [s] = await api("DELETE", `/api/collections/projects/records/${old_prj.id}`, alice);
  check("  the old project is trashed", s, 204);
  const [, listable] = await list_all("tasks", member, { filter: `parent='${moved.id}'` });
  [s, row] = await view_row(moved.id, member);
  check(
    "a member's count drops to the children they can list",
    tup(s, row.subtask_total ?? null, row.subtask_done ?? null, listable.length),
    tup(200, 1, 1, 1),
  );

  // ── open / status_terminal / status_off_pipeline ──
  const flag_task: Record<string, string> = {};
  for (const [cat, sid] of Object.entries(cat_status)) {
    [s, r] = await api("POST", "/api/collections/tasks/records", alice, {
      workspace: WS,
      project: cnt_prj,
      title: `PIV flag ${cat}`,
      status: sid,
    });
    check(`flag task in a ${cat} status created`, s, 200);
    flag_task[cat] = r.id;
  }
  const [, b_statuses] = await list_all("statuses", member, { filter: `workspace='${WS_B}'` });
  const foreign_open = b_statuses.find((x) => x.category === "started")?.id;
  check("workspace B has a started status to borrow", truthy(foreign_open), true);
  for (const [label, value] of [
    ["empty status", ""],
    ["unresolvable status", "legacy-grandfathered"],
    ["another workspace's started status", foreign_open],
  ] as [string, string][]) {
    [, r] = await api("POST", "/api/collections/tasks/records", alice, {
      workspace: WS,
      project: cnt_prj,
      title: `PIV flag ${label}`,
    });
    // No API path stores these values, so they are written as the legacy rows that hold them.
    sql_write("UPDATE tasks SET status = ? WHERE id = ?", [value, r.id]);
    flag_task[label] = r.id;
  }
  const flag_want: Record<string, [boolean, boolean, boolean]> = {
    triage: [true, false, false],
    backlog: [true, false, false],
    unstarted: [true, false, false],
    started: [true, false, false],
    completed: [false, true, false],
    canceled: [false, true, true],
    "empty status": [false, false, false],
    "unresolvable status": [false, false, false],
    "another workspace's started status": [false, false, false],
  };
  for (const [label, rid] of Object.entries(flag_task)) {
    [s, row] = await view_row(rid);
    check(
      `${label.padEnd(36)} → (open, terminal, off_pipeline)`,
      tup(s, [row.open ?? null, row.status_terminal ?? null, row.status_off_pipeline ?? null]),
      tup(200, flag_want[label]),
    );
  }
  for (const [label, rid] of [
    ["decision (free-text status)", col_dec.id],
    ["document", col_doc.id],
    ["milestone", col_ms.id],
  ]) {
    [s, row] = await view_row(rid);
    check(
      `${label.padEnd(36)} → all three flags false`,
      tup(s, [row.open ?? null, row.status_terminal ?? null, row.status_off_pipeline ?? null]),
      tup(200, [false, false, false]),
    );
  }
  const open_vocab = new Set(
    ws_statuses
      .concat([{ id: cat_status["triage"], category: "triage" }])
      .filter((x: any) => x.category !== "completed" && x.category !== "canceled")
      .map((x: any) => x.id),
  );
  const [, ws_tasks] = await list_all("project_items", alice, {
    filter: `workspace='${WS}' && type='task'`,
  });
  const want_open = new Set(ws_tasks.filter((x) => open_vocab.has(x.status)).map((x) => x.id));
  let open_status: number;
  let open_rows: any[];
  [open_status, open_rows] = await list_all("project_items", alice, {
    filter: `workspace='${WS}' && open=true`,
  });
  check(
    `filter open=true == the tasks whose status is open vocabulary (${want_open.size} rows)`,
    tup(open_status, sorted(sym_diff(ids_of(open_rows), want_open))),
    tup(200, []),
  );
  check("  …and that comparison is not vacuous", want_open.size > 5, true);

  // ── the viewRule's trash branch ──
  [s, row] = await view_row(fixtures["task"]["trashed"], member);
  check(
    "member GETs a trashed task by id → 200 with its type",
    tup(s, row.type ?? null),
    tup(200, "task"),
  );
  // Nobody can list a trashed row's comments or children, so its counts must not reveal them.
  let tc_task: any;
  [s, tc_task] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: cnt_prj,
    title: "PIV trashed task with comments and children",
  });
  check("a task to fill and trash", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: tc_task.id,
    body: "a comment before the trash",
  });
  check("  it has a comment", s, 200);
  [s] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: WS,
    project: cnt_prj,
    title: "PIV child of the trashed task",
    parent: tc_task.id,
    status: cat_status["completed"],
  });
  check("  …and a done child", s, 200);
  [s] = await api("DELETE", `/api/collections/tasks/records/${tc_task.id}`, alice);
  check("  …then it is trashed", s, 204);
  [s, row] = await view_row(tc_task.id, member);
  check(
    "member GETs that trashed task: (comment_count, subtask_total, subtask_done) all 0",
    tup(s, row.comment_count ?? null, row.subtask_total ?? null, row.subtask_done ?? null),
    tup(200, 0, 0, 0),
  );
  [s] = await view_row(asg_trash.id, assignee);
  check("  positive control: the assignee reads their live task", s, 200);
  [s] = await api("DELETE", `/api/collections/tasks/records/${asg_trash.id}`, alice);
  check("  …which the owner then trashes", s, 204);
  [s] = await view_row(asg_trash.id, assignee);
  check("non-member assignee of a trashed task → 404", s, 404);
  [s] = await view_row(fixtures["document"]["trashed_draft"], member);
  check("non-admin member, another author's trashed draft document → 404", s, 404);
  [s] = await view_row(fixtures["document"]["trashed_draft"], admin);
  check("  …while an admin gets it → 200", s, 200);
  let dws: any, dws_live: any, dws_gone: any;
  [s, dws] = await api("POST", "/api/collections/workspaces/records", alice, {
    name: "PIV Doomed Workspace",
    owner: alice_id,
  });
  check("a workspace to trash", s, 200);
  [, dws_live] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: dws.id,
    title: "PIV live task in a doomed workspace",
  });
  [, dws_gone] = await api("POST", "/api/collections/tasks/records", alice, {
    workspace: dws.id,
    title: "PIV trashed task in a doomed workspace",
  });
  [s] = await api("DELETE", `/api/collections/tasks/records/${dws_gone.id}`, alice);
  check("  one of its tasks trashed", s, 204);
  [s] = await api("DELETE", `/api/collections/workspaces/records/${dws.id}`, alice);
  check("  the workspace trashed", s, 204);
  for (const [label, rid] of [
    ["live", dws_live.id],
    ["trashed", dws_gone.id],
  ]) {
    [s] = await view_row(rid, alice);
    check(`trashed workspace: its owner GETs its ${label} task → 404`, s, 404);
  }
  const [, trash_listed] = await list_all("project_items", member, {
    filter: `workspace='${WS}' && trashed != ""`,
  });
  check("the list still hides every trashed row", trash_listed.length, 0);

  // ── statuses carry terminal + off_pipeline ──
  const [, flagged] = await list_all("statuses", alice, { filter: `workspace='${WS}'` });
  check(
    "status list: (category, terminal, off_pipeline) for every category",
    sorted(
      new Set(
        flagged.map(
          (x) => `${x.category}:${x.terminal ?? "missing"}:${x.off_pipeline ?? "missing"}`,
        ),
      ),
    ),
    sorted([
      "triage:false:false",
      "backlog:false:false",
      "unstarted:false:false",
      "started:false:false",
      "completed:true:false",
      "canceled:true:true",
    ]),
  );
  // Measured on PB 0.40.4: the enrich hook also reaches an EXPANDED status, nested ones included.
  const terminal_of = (sid: string): boolean =>
    ["completed", "canceled"].includes(ws_statuses.find((x: any) => x.id === sid)?.category);
  [s, r] = await api(
    "GET",
    `/api/collections/tasks/records/${child_t.id}?expand=status,parent.status,dependencies.status`,
    alice,
  );
  const expanded = tup(
    s,
    r.expand?.status?.terminal ?? "missing",
    r.expand?.parent?.expand?.status?.terminal ?? "missing",
    r.expand?.dependencies?.[0]?.expand?.status?.terminal ?? "missing",
  );
  console.log(`      nested expand measurement: ${py_repr(expanded)}`);
  check(
    "expand.status, expand.parent.expand.status and a blocker's expand.status carry terminal",
    expanded,
    tup(200, terminal_of(S1), terminal_of(S2), terminal_of(S2)),
  );

  // ══════════════════ 6. VIEW HYGIENE ═════════════════════════════════════════
  // COVERS: rule:project_items.create, rule:project_items.update, rule:project_items.delete
  console.log("\n── (6) hygiene: no write surface, and openapi.json says so ──");
  for (const [who, tok] of [
    ["owner", alice],
    ["superuser", su],
  ]) {
    [s, r] = await api("POST", "/api/collections/project_items/records", tok, {
      title: "nope",
      type: "task",
      workspace: WS,
    });
    check(`${who} CREATE on the view → 4xx`, 400 <= s && s < 500, true);
    [s] = await api(
      "PATCH",
      `/api/collections/project_items/records/${fixtures["task"]["live"]}`,
      tok,
      { title: "nope" },
    );
    check(`${who} UPDATE on the view → 4xx`, 400 <= s && s < 500, true);
    [s] = await api(
      "DELETE",
      `/api/collections/project_items/records/${fixtures["task"]["live"]}`,
      tok,
    );
    check(`${who} DELETE on the view → 4xx`, 400 <= s && s < 500, true);
  }
  [s] = await api("GET", `/api/collections/tasks/records/${fixtures["task"]["live"]}`, alice);
  check("the underlying task is untouched by those refusals", s, 200);

  let col: any;
  [s, col] = await api("GET", "/api/collections/project_items", su);
  check("the collection is a view", tup(s, col.type ?? null), tup(200, "view"));
  check(
    "its write rules are all null (no non-superuser write surface either)",
    [col.createRule ?? null, col.updateRule ?? null, col.deleteRule ?? null],
    [null, null, null],
  );

  const spec = JSON.parse(read_text(path.join(REPO_ROOT, "openapi.json")));
  const listing = spec["paths"]["/api/collections/project_items/records"] ?? {};
  const single = spec["paths"]["/api/collections/project_items/records/{id}"] ?? {};
  check("openapi documents the list endpoint, GET only", sorted(Object.keys(listing)), ["get"]);
  check("openapi documents the single-record endpoint, GET only", sorted(Object.keys(single)), [
    "get",
  ]);

  await admin_tier.done();
  await member_tier.done();
  await viewer_tier.done();
  await tierkit.verify_tiers();
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all project_items view proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * E2E proof that POST /api/tracker/workspaces/{id}/vocab saves a workspace's own fields (name,
 * priorities, default_project) and its statuses/labels in ONE transaction: a refusal of either
 * half leaves the record AND the vocabulary exactly as they were, read back from PocketBase.
 * Also: the combined success shape (record + ordered vocab), the collection-PATCH validation
 * rules firing on the route, and the route's authority matrix with nothing written on a refusal.
 *
 * Self-contained clean-room server (roomkit.hooks_dir copy), scripts/seed.ts fixtures.
 * Port 8151 + PB_PORT_OFFSET — 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, json_dumps, py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8151 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  const r = await fetch(BASE_URL + p, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

async function find_by_filter(collection: string, filt: string, token: string, sort = "") {
  const qs = urlencode({ filter: filt, perPage: 500, ...(sort ? { sort } : {}) });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return (r.items || []) as any[];
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [r.token, r.record.id];
}

async function su_create_user(su: string, name: string): Promise<[string, string]> {
  const email = `wsave-${name.toLowerCase()}-${randomBytes(4).toString("hex")}@example.com`;
  const [s] = await api("POST", "/api/collections/users/records", su, {
    email,
    password: "test123456",
    passwordConfirm: "test123456",
    name,
    verified: true,
    approved: true,
  });
  check(`(fixture) throwaway user ${name} created`, s, 200);
  const [token, id] = await login(email);
  return [token, id];
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-workspace-save-tx-"));
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
  const [, su_auth] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_auth.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_auth)}`);

  console.log("\n── seed: alice/bob/carol fixtures (scripts/seed.ts) ──");
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

  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const [carol, carol_id] = await login("carol@example.com");

  const WS = (await find_by_filter("workspaces", "name='Alice\\'s Workspace'", su))[0].id as string;
  const URL = `/api/tracker/workspaces/${WS}/vocab`;
  const OWN_PROJECT = (await find_by_filter("projects", "name='Website Redesign'", su))[0].id;
  const FOREIGN_PROJECT = (await find_by_filter("projects", "name='Mobile App'", su))[0];
  check(
    "(fixture) 'Mobile App' belongs to ANOTHER workspace",
    FOREIGN_PROJECT.workspace !== WS,
    true,
  );

  // Everything a refused save must leave untouched, read back as the superuser.
  async function snapshot(ws_id: string): Promise<string> {
    const [, ws] = await api("GET", `/api/collections/workspaces/records/${ws_id}`, su);
    const statuses = (await find_by_filter("statuses", `workspace='${ws_id}'`, su))
      .map((r) => ({ id: r.id, name: r.name, position: r.position, category: r.category }))
      .sort((a, b) => by_code_point(a.id, b.id));
    const labels = (await find_by_filter("labels", `workspace='${ws_id}'`, su))
      .map((r) => ({ id: r.id, name: r.name, core: r.core }))
      .sort((a, b) => by_code_point(a.id, b.id));
    return json_dumps(
      {
        ws: {
          name: ws.name,
          owner: ws.owner,
          priorities: ws.priorities,
          default_project: ws.default_project,
          trashed: ws.trashed,
          updated: ws.updated,
        },
        statuses,
        labels,
      },
      { sort_keys: true },
    );
  }
  const statuses_of = (ws_id: string) =>
    find_by_filter("statuses", `workspace='${ws_id}'`, su, "+position");
  const labels_of = (ws_id: string) =>
    find_by_filter("labels", `workspace='${ws_id}'`, su, "+created");

  const statuses0 = await statuses_of(WS);
  const sid: Record<string, string> = Object.fromEntries(statuses0.map((r) => [r.name, r.id]));
  const labels0 = await labels_of(WS);
  const lid: Record<string, string> = Object.fromEntries(labels0.map((r) => [r.name, r.id]));
  const [, ws0] = await api("GET", `/api/collections/workspaces/records/${WS}`, su);
  const urgent_id = ws0.priorities.find((p: any) => p.name === "urgent").id;
  const full_statuses = (rename: string) => [
    { id: sid["Backlog"], name: "Backlog" },
    { id: sid["Todo"], name: rename },
    { id: sid["In Progress"], name: "In Progress" },
    { id: sid["Done"], name: "Done", terminal: true },
    { id: sid["Canceled"], name: "Canceled", terminal: true },
  ];

  // ══════ (1) combined success ═════════════════════════════════════════════════
  // COVERS: route:POST /api/tracker/workspaces/{id}/vocab
  console.log("\n── (1) one call saves name + priorities + default_project + statuses + labels ──");
  let [s, body] = await api("POST", URL, alice, {
    name: "Alice Renamed",
    priorities: [{ name: " urgent " }, { name: "Critical" }, { name: "low" }],
    default_project: OWN_PROJECT,
    statuses: [
      { id: sid["Done"], name: "Done", terminal: true },
      { id: sid["Todo"], name: "To Do" },
      { id: sid["In Progress"], name: "In Progress" },
      { id: sid["Backlog"], name: "Backlog" },
      { id: sid["Canceled"], name: "Canceled", terminal: true },
      { name: "Review" },
    ],
    labels: [...labels0.map((l) => ({ id: l.id, name: l.name })), { name: "Docs" }],
  });
  check("(1) combined save -> 200", s, 200);
  const [, ws1] = await api("GET", `/api/collections/workspaces/records/${WS}`, su);
  check("(1) read-back: name changed", ws1.name, "Alice Renamed");
  check(
    "(1) read-back: priorities trimmed, in submitted order",
    ws1.priorities.map((p: any) => p.name),
    ["urgent", "Critical", "low"],
  );
  check("(1) read-back: name-only 'urgent' kept its stored id", ws1.priorities[0].id, urgent_id);
  check(
    "(1) read-back: new 'Critical' minted a 15-char id",
    /^[a-z0-9]{15}$/.test(ws1.priorities[1].id ?? ""),
    true,
  );
  check("(1) read-back: default_project set", ws1.default_project, OWN_PROJECT);
  const statuses1 = await statuses_of(WS);
  check(
    "(1) read-back: statuses renamed, reordered, added",
    statuses1.map((r) => r.name),
    ["Done", "To Do", "In Progress", "Backlog", "Canceled", "Review"],
  );
  const labels1 = await labels_of(WS);
  check("(1) read-back: label added", labels1.map((r) => r.name).includes("Docs"), true);
  check("(1) response: the workspace record id", body.id ?? null, WS);
  check("(1) response: the saved name", body.name ?? null, "Alice Renamed");
  check("(1) response: the saved priorities", body.priorities ?? null, ws1.priorities);
  check("(1) response: the stored updated stamp", body.updated ?? null, ws1.updated);
  check(
    "(1) response: expand.statuses_via_workspace in position order",
    (body.expand?.statuses_via_workspace ?? []).map((r: any) => r.id),
    statuses1.map((r) => r.id),
  );
  check(
    "(1) response: expand.labels_via_workspace in created order",
    (body.expand?.labels_via_workspace ?? []).map((r: any) => r.id),
    labels1.map((r) => r.id),
  );
  const cur_statuses = statuses1.map((r) => ({
    id: r.id,
    name: r.name,
    terminal: r.category === "completed" || r.category === "canceled",
  }));
  const cur_labels = labels1.map((r) => ({ id: r.id, name: r.name }));

  // A refused call: 400, and the record + vocabulary are byte-identical afterwards.
  async function refused(label: string, token: string | null, payload: any, want: number) {
    const before = await snapshot(WS);
    const [st, b] = await api("POST", URL, token, payload);
    check(`${label} -> ${want}`, st, want);
    check(`${label}: record + vocab unchanged`, (await snapshot(WS)) === before, true);
    return b;
  }

  // ══════ (2) refused vocab rolls back the record fields ═══════════════════════
  console.log("\n── (2) a refused vocab half leaves name/priorities unchanged ──");
  const fields = { name: "Should Not Stick", priorities: [{ name: "urgent" }, { name: "Later" }] };
  let b = await refused(
    "(2a) name+priorities + omit a REFERENCED status",
    alice,
    { ...fields, statuses: cur_statuses.filter((r) => r.name !== "In Progress") },
    400,
  );
  check("(2a) message names the referenced status", /referenced/i.test(b.message ?? ""), true);
  b = await refused(
    "(2b) name+priorities + omit a CORE label",
    alice,
    { ...fields, labels: cur_labels.filter((l) => l.name === "Docs") },
    400,
  );
  check("(2b) message names core labels", /core labels/i.test(b.message ?? ""), true);

  // ══════ (3) refused record fields roll back the vocab ════════════════════════
  console.log("\n── (3) a refused record half leaves the vocabulary unchanged ──");
  const vocab_change = { statuses: [...cur_statuses, { name: "Never Lands" }] };
  b = await refused(
    "(3a) priorities containing 'none' + vocab change",
    alice,
    { ...vocab_change, priorities: [{ name: "high" }, { name: "None" }] },
    400,
  );
  check("(3a) message is the reserved-token refusal", /reserved/i.test(b.message ?? ""), true);
  b = await refused(
    "(3b) duplicate priority name + vocab change",
    alice,
    { ...vocab_change, priorities: [{ name: "high" }, { name: "high " }] },
    400,
  );
  check("(3b) message is the repeat refusal", /repeat/i.test(b.message ?? ""), true);
  await refused(
    "(3c) emptied priorities + vocab change",
    alice,
    { ...vocab_change, priorities: [] },
    400,
  );
  b = await refused(
    "(3d) blank name '   ' + vocab change",
    alice,
    { ...vocab_change, name: "   " },
    400,
  );
  check("(3d) message is the blank-name refusal", /non-empty string/i.test(b.message ?? ""), true);
  b = await refused("(3d) null name + vocab change", alice, { ...vocab_change, name: null }, 400);
  check(
    "(3d) null name gets the blank-name refusal",
    /non-empty string/i.test(b.message ?? ""),
    true,
  );
  b = await refused(
    "(3e) cross-workspace default_project + vocab change",
    alice,
    { ...vocab_change, default_project: FOREIGN_PROJECT.id },
    400,
  );
  check(
    "(3e) message names this workspace",
    /belong to this workspace/i.test(b.message ?? ""),
    true,
  );
  await refused(
    "(3f) over-long name (field validation, inside the tx) + vocab change",
    alice,
    { ...vocab_change, name: "x".repeat(201) },
    400,
  );

  // ══════ (4) authority: every refusal writes nothing ══════════════════════════
  console.log("\n── (4) authority matrix: a refused caller changes nothing ──");
  tierkit.use(api);
  const attempt = {
    name: "Hijacked",
    priorities: [{ name: "urgent" }, { name: "Hijack" }],
    statuses: [...cur_statuses, { name: "Hijack" }],
    labels: [...cur_labels, { name: "Hijack" }],
  };
  const bob_admin = await tierkit.actor_at_tier(WS, bob_id, "admin", su, "Bob");
  [s] = await api("POST", tierkit.MEMBERS, su, {
    workspace: WS,
    user: carol_id,
    role: "member",
    status: "active",
  });
  check("(fixture) su creates Carol's membership row", s, 200);
  const carol_member = await tierkit.actor_at_tier(WS, carol_id, "member", su, "Carol");
  const [vic, vic_id] = await su_create_user(su, "Vic");
  [s] = await api("POST", tierkit.MEMBERS, su, {
    workspace: WS,
    user: vic_id,
    role: "viewer",
    status: "active",
  });
  check("(fixture) su creates Vic's viewer row", s, 200);
  const vic_viewer = await tierkit.actor_at_tier(WS, vic_id, "viewer", su, "Vic");
  const [sam, sam_id] = await su_create_user(su, "Sam");
  [s] = await api("POST", tierkit.MEMBERS, su, {
    workspace: WS,
    user: sam_id,
    role: "admin",
    status: "suspended",
  });
  check("(fixture) su creates Sam's SUSPENDED admin row", s, 200);
  const sam_suspended = await tierkit.actor_at_tier(WS, sam_id, "admin", su, "Sam", "suspended");
  const [erin, erin_id] = await su_create_user(su, "Erin");
  check(
    "(fixture) Erin has NO membership row (non-member)",
    await find_by_filter("workspace_members", `workspace='${WS}' && user='${erin_id}'`, su),
    [],
  );

  const before_auth = await snapshot(WS);
  [s] = await api("POST", URL, carol, attempt);
  check("(4) plain member (Carol) -> 404", tup(await carol_member.now(), s), tup("member", 404));
  [s] = await api("POST", URL, vic, attempt);
  check("(4) viewer (Vic) -> 404", tup(await vic_viewer.now(), s), tup("viewer", 404));
  [s] = await api("POST", URL, sam, attempt);
  check(
    "(4) SUSPENDED admin (Sam) -> 404",
    tup(await sam_suspended.standing(), s),
    tup(tup("admin", "suspended"), 404),
  );
  [s] = await api("POST", URL, erin, attempt);
  check("(4) non-member (Erin) -> 404", s, 404);
  [s] = await api("POST", URL, null, attempt);
  check("(4) anonymous -> 401", s, 401);
  check(
    "(4) after every refusal: record + vocab unchanged",
    (await snapshot(WS)) === before_auth,
    true,
  );

  console.log("\n── (4b) owner in the body is ignored; an active admin saves ──");
  [s, body] = await api("POST", URL, bob, { name: "Saved By Admin", owner: bob_id });
  check(
    "(4b) active admin (Bob) combined save -> 200",
    tup(await bob_admin.now(), s),
    tup("admin", 200),
  );
  const [, ws4] = await api("GET", `/api/collections/workspaces/records/${WS}`, su);
  check("(4b) read-back: the admin's name landed", ws4.name, "Saved By Admin");
  check("(4b) read-back: owner still Alice (owner key ignored)", ws4.owner, alice_id);

  console.log("\n── (4c) the owner of a TRASHED workspace -> 404, nothing written ──");
  const [cs, spare] = await api("POST", tierkit.WORKSPACES, alice, {
    name: "Spare WS",
    owner: alice_id,
  });
  check("(fixture) Alice creates a spare workspace", cs, 200);
  [s] = await api("DELETE", `${tierkit.WORKSPACES}/${spare.id}`, alice);
  check("(fixture) Alice trashes it", s, 204);
  const before_trash = await snapshot(spare.id);
  [s] = await api("POST", `/api/tracker/workspaces/${spare.id}/vocab`, alice, {
    name: "Back From Trash",
    statuses: [{ name: "Ghost" }],
  });
  check("(4c) owner on a TRASHED workspace -> 404", s, 404);
  check("(4c) trashed record + vocab unchanged", (await snapshot(spare.id)) === before_trash, true);

  // ══════ (5) the collection's back-relation expand is a list ═════════════════
  console.log(
    "\n── (5) ?expand=statuses_via_workspace is every status; one default per workspace ──",
  );
  const [es, ews] = await api(
    "GET",
    `${tierkit.WORKSPACES}/${WS}?expand=statuses_via_workspace,labels_via_workspace`,
    alice,
  );
  check("(5) collection read with expand -> 200", es, 200);
  const exp = ews.expand?.statuses_via_workspace;
  const all_statuses = await statuses_of(WS);
  check("(5) expand.statuses_via_workspace is an array", Array.isArray(exp), true);
  check(
    "(5) ... holding every status of the workspace",
    (Array.isArray(exp) ? exp.map((r: any) => r.id) : []).sort(by_code_point),
    all_statuses.map((r) => r.id).sort(by_code_point),
  );
  const dflt = { workspace: WS, position: 99, category: "unstarted" };
  let [ds, drow] = await api("POST", "/api/collections/statuses/records", su, {
    ...dflt,
    name: "Plain Probe",
    is_default: false,
  });
  check("(5) control: the same payload with is_default=false -> 200", ds, 200);
  [ds] = await api("DELETE", `/api/collections/statuses/records/${drow.id}`, su);
  check("(5) control row removed", ds, 204);
  [ds] = await api("POST", "/api/collections/statuses/records", su, {
    ...dflt,
    name: "Second Default",
    is_default: true,
  });
  check("(5) a second is_default=true status in the workspace -> 400", ds, 400);
  check(
    "(5) ... and nothing was written",
    (await statuses_of(WS)).filter((r) => r.is_default).length,
    1,
  );

  await tierkit.verify_tiers();
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all workspace-save-tx proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * E2E test of the owner-only rules on `projects` and (module 10, then W1/#64)
 * `milestones` — member create/edit, owner/admin destructive delete. Proves the
 * policy from the outside. Fixtures are resolved by query-by-name against the
 * running server (no hard-coded record ids — a re-seed regenerates every id).
 *
 * Every ROLE-tier denial here rides tierkit: a 404 for a viewer and a 404 for a stranger are
 * the same bytes, so the expected value carries the role read live off the membership row and
 * a missing or re-roled fixture turns the check red instead of satisfying it (PBTT-454).
 */

import fs from "node:fs";
import { py_str, py_strip, read_text, tup, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

// .env is gitignored — no secrets hard-coded here.
function load_env(path = ".env"): void {
  if (fs.existsSync(path)) {
    for (let line of read_text(path).split(/\r\n|\r|\n/)) {
      line = py_strip(line);
      if (line && !line.startsWith("#") && line.includes("=")) {
        const i = line.indexOf("=");
        const k = line.slice(0, i);
        const v = line.slice(i + 1);
        if (!(k in process.env)) process.env[k] = v;
      }
    }
  }
}

load_env();

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;

let failures = 0;

async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  let raw: string;
  try {
    r = await fetch(PB + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(PB, e);
  }
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 → empty body
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(PB, email, r), r.record.id];
}

// PocketBase filter string literals escape an embedded quote with a backslash.
function esc(value: string): string {
  return value.replaceAll("'", "\\'");
}

/** Resolve a record id by query instead of a hard-coded id (re-seed regenerates ids). */
async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<any> {
  const filt = `${field}='${esc(value)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  const tag = ok ? "✅" : "❌ MISMATCH";
  console.log(`  ${tag}  ${label.padEnd(52)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");
const [carol, carol_id] = await login("carol@example.com"); // NON-MEMBER of Alice's workspace (seed)
tierkit.use(api);

const [SU_EMAIL, SU_PASSWORD] = roomkit.superuser_creds();
let s: number;
let r: any;
[, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
  identity: SU_EMAIL,
  password: SU_PASSWORD,
});
const su = roomkit.token_of(PB, SU_EMAIL, r);

/** How many membership rows the OWNER can see for (user, workspace) — 0 proves a stranger. */
async function membership_rows(user_id: string, workspace_id: string): Promise<number> {
  const qs = urlencode({ filter: `(workspace='${workspace_id}' && user='${user_id}')` });
  const [, r] = await api("GET", `/api/collections/workspace_members/records?${qs}`, alice);
  return (r.items || []).length;
}

// owner-only rule: each user resolves their OWN row id via their own token.
const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
const BOB_PROJECT = await find_id("projects", "name", "Mobile App", bob);
const ALICE_WORKSPACE = await find_id("workspaces", "name", "Alice's Workspace", alice);
const BOB_WORKSPACE = await find_id("workspaces", "name", "Bob's Workspace", bob);

console.log("\n── LIST is auto-filtered by the rule (each sees only their own) ──");
[, r] = await api("GET", "/api/collections/projects/records", alice);
console.log(`  Alice sees: ${py_str(r.items.map((i: any) => i.name))}`);
[, r] = await api("GET", "/api/collections/projects/records", bob);
console.log(`  Bob   sees: ${py_str(r.items.map((i: any) => i.name))}`);
[s, r] = await api("GET", "/api/collections/projects/records", null); // anonymous
console.log(`  Anon  sees: ${py_str(r.items.map((i: any) => i.name))}  (status ${s})`);

// COVERS: rule:projects.view
// These 404s claim TENANCY, not a role tier, and the 200 on her own record next to each one
// is what discriminates them — no tier reading applies.
console.log("\n── VIEW someone else's record → 404 (can't confirm it exists) ──");
[s] = await api("GET", `/api/collections/projects/records/${BOB_PROJECT}`, alice);
check("Alice views Bob's project", s, 404);
[s] = await api("GET", `/api/collections/projects/records/${ALICE_PROJECT}`, alice);
check("Alice views her OWN project", s, 200);

// COVERS: rule:projects.create
// Alice owns this workspace outright, so no membership row backs the guard — the identical
// body minus the spoofed owner returning 200 is what makes the 400 mean spoofing.
console.log("\n── CREATE: owner-spoofing guard ──");
[s] = await api("POST", "/api/collections/projects/records", alice, {
  name: "Forged",
  owner: bob_id,
  workspace: ALICE_WORKSPACE,
}); // Alice tries to own-as-Bob
check("Alice creates project owned by BOB (spoof)", s, 400);
[s, r] = await api("POST", "/api/collections/projects/records", alice, {
  name: "Alice's real new project",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check("Alice creates project owned by HERSELF", s, 200);

// COVERS: rule:projects.update, rule:projects.delete
console.log("\n── UPDATE / DELETE someone else's record → 404 ──");
[s] = await api("PATCH", `/api/collections/projects/records/${BOB_PROJECT}`, alice, {
  name: "hijacked",
});
check("Alice updates Bob's project", s, 404);
[s] = await api("DELETE", `/api/collections/projects/records/${BOB_PROJECT}`, alice);
check("Alice deletes Bob's project", s, 404);

// decision-023 (safety wave): UPDATE widens to any NON-VIEWER member (a member-created
// project was un-editable by its creator); DELETE stays owner/admin; `owner` is now
// purely informational. (rule:projects.update / rule:projects.delete already COVERED above.)
console.log(
  "\n── UPDATE widened to non-viewer members; DELETE stays owner/admin (decision-023) ──",
);
const PROJ = "/api/collections/projects/records";
const bob_member = await tierkit.actor_at_tier(ALICE_WORKSPACE, bob_id, "member", alice, "Bob");

[s, r] = await api("POST", PROJ, bob, {
  name: "Bob's project in Alice's ws",
  owner: bob_id,
  workspace: ALICE_WORKSPACE,
});
check("Bob (member) creates a project in Alice's workspace", s, 200);
const BOB_CREATED = r.id ?? null;

// The new capability (was 404 under owner/admin-only): mutation-proven RED against the
// pre-migration rule, GREEN after.
[s] = await api("PATCH", `${PROJ}/${BOB_CREATED}`, bob, {
  name: "Bob edits the project he created",
});
check("Bob (member/creator) updates his project (200, decision-023)", s, 200);
[s] = await api("PATCH", `${PROJ}/${ALICE_PROJECT}`, bob, { description: "member edit" });
check("Bob (member) updates Alice's project (200, decision-023)", s, 200);

// Non-member: denied (run BEFORE Carol joins the workspace). The row COUNT rides the
// expectation — a stray membership would make this same 404 prove the viewer tier instead.
[s] = await api("PATCH", `${PROJ}/${ALICE_PROJECT}`, carol, { name: "carol hijack" });
check(
  "Carol (non-member, 0 membership rows) updates Alice's project (404)",
  tup(await membership_rows(carol_id, ALICE_WORKSPACE), s),
  tup(0, 404),
);

// workspace_members.createRule is null (decision-073): only superuser/system (the accept
// route) creates a membership row — an owner direct-create is refused outright.
[s] = await api("POST", "/api/collections/workspace_members/records", alice, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "viewer",
  status: "active",
});
check("Alice (owner) direct-creates Carol's membership — refused (null createRule)", s, 403);
[s, r] = await api("POST", "/api/collections/workspace_members/records", su, {
  workspace: ALICE_WORKSPACE,
  user: carol_id,
  role: "viewer",
  status: "active",
});
check("setup: superuser adds Carol as a viewer member", s, 200);
const carol_viewer = await tierkit.actor_at_tier(
  ALICE_WORKSPACE,
  carol_id,
  "viewer",
  alice,
  "Carol",
);

// Viewer: still denied — the ?!= "viewer" clause excludes the read-only tier.
[s] = await api("PATCH", `${PROJ}/${ALICE_PROJECT}`, carol, { name: "carol viewer edit" });
check(
  "Carol (viewer) updates Alice's project (404, viewer denied)",
  tup(await carol_viewer.now(), s),
  tup("viewer", 404),
);

// AC#4 regression: workspace stays immutable (hook-enforced, not the rule) — the 400 is
// discriminated by the name PATCH two checks up, which Bob's same token got a 200 for.
[s] = await api("PATCH", `${PROJ}/${BOB_CREATED}`, bob, { workspace: BOB_WORKSPACE });
check("Bob (member) repoints project workspace (400, immutable AC#4)", s, 400);

// DELETE stays owner/admin: a member cannot delete even a project they created.
[s] = await api("DELETE", `${PROJ}/${BOB_CREATED}`, bob);
check(
  "Bob (member) deletes the project he created (404, delete owner/admin)",
  tup(await bob_member.now(), s),
  tup("member", 404),
);
// Owner delete: first DELETE traps to trash (204, W3).
[s] = await api("DELETE", `${PROJ}/${BOB_CREATED}`, alice);
check("Alice (owner) deletes a project → traps to trash (204)", s, 204);
// Card jwwp (R2) put the trashed carve-out on updateRule too, so restoring a project is the
// actor set that could delete it — and a no-op PATCH can no longer read back a name the
// viewRule refuses, since PB returns the whole record on a successful update either way.
let body: any;
[s, body] = await api("PATCH", `${PROJ}/${BOB_CREATED}`, bob, {});
check("Bob (member) no-op PATCH on the trashed project (404, card jwwp)", s, 404);
check("...so it hands him no project name either", "name" in body, false);
[s] = await api("PATCH", `${PROJ}/${BOB_CREATED}`, bob, { trashed: "" });
check("Bob (member) cannot restore the trashed project (404, card jwwp)", s, 404);
[s] = await api("PATCH", `${PROJ}/${BOB_CREATED}`, alice, { trashed: "" });
check("Alice (owner) restores it — the trash actor set is the restore actor set", s, 200);
[s] = await api("PATCH", `${PROJ}/${BOB_CREATED}`, bob, { description: "member edit" });
check("Bob (member) still edits it once LIVE (update stays widened)", s, 200);
// Admin delete: promote Carol, then a fresh project deletes for her (204 trap).
await carol_viewer.done();
const carol_admin = await tierkit.actor_at_tier(ALICE_WORKSPACE, carol_id, "admin", alice, "Carol");
[s, r] = await api("POST", PROJ, alice, {
  name: "admin-delete target",
  owner: alice_id,
  workspace: ALICE_WORKSPACE,
});
check("Alice creates an admin-delete target project", s, 200);
[s] = await api("DELETE", `${PROJ}/${r.id ?? null}`, carol);
check(
  "Carol (admin) deletes a project → traps to trash (204, delete allowed)",
  tup(await carol_admin.now(), s),
  tup("admin", 204),
);

// Bob is a SEEDED member of Alice's workspace (scripts/seed.ts).
console.log(
  "\n── MILESTONES: member-read (wave 14), member create/edit (W1), owner/admin delete ──",
);
const ALICE_MILESTONE = await find_id("milestones", "name", "v1 launch", alice);

// COVERS: rule:milestones.list
[s, r] = await api("GET", "/api/collections/milestones/records", bob);
const bob_milestones = r.items.map((i: any) => i.name);
check(
  "Bob (member) lists milestones — includes Alice's 'v1 launch'",
  tup(bob_milestones.includes("v1 launch"), s),
  tup(true, 200),
);

// COVERS: rule:milestones.view
[s] = await api("GET", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob);
check("Bob (member) views Alice's milestone", s, 200);

// COVERS: rule:milestones.update
[s] = await api("PATCH", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob, {
  name: "hijacked",
});
check("Bob (member) updates Alice's milestone (allowed, W1)", s, 200);

// W3 (#66): member delete = trash (204); purge (real removal) stays owner/admin.
// COVERS: rule:milestones.delete
[s] = await api("DELETE", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob);
check("Bob (member) deletes Alice's milestone → traps to trash (204, W3 #66)", s, 204);
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:milestones
[s, r] = await api("GET", `/api/collections/milestones/records/${ALICE_MILESTONE}`, bob);
check("trashed milestone is 404 by id too (card htsr: viewRule mirrors listRule)", s, 404);
[s, r] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, bob);
const row = (r.items ?? []).find((i: any) => (i.record || {}).id === ALICE_MILESTONE) ?? {};
check(
  "the row survived the trap and reaches the member through GET /api/tracker/trash",
  tup(s, truthy((row.record || {}).trashed)),
  tup(200, true),
);
[s, r] = await api("GET", "/api/collections/milestones/records", bob);
check(
  "trashed milestone absent from member's list",
  (r.items ?? []).map((i: any) => i.id).includes(ALICE_MILESTONE),
  false,
);

// COVERS: rule:milestones.create
[s, r] = await api("POST", "/api/collections/milestones/records", bob, {
  name: "Intruder milestone",
  workspace: ALICE_WORKSPACE,
});
check("Bob (member) creates a milestone in ALICE's workspace (allowed, W1)", s, 200);
if (s === 200) {
  [s] = await api("DELETE", `/api/collections/milestones/records/${r.id}`, alice);
  check("cleanup: Bob's milestone deleted", s, 204);
}

[s, r] = await api("POST", "/api/collections/milestones/records", alice, {
  name: "RULE-TEST milestone",
  workspace: ALICE_WORKSPACE,
});
check("Alice creates a milestone in HER OWN workspace", s, 200);
if (s === 200) {
  [s] = await api("DELETE", `/api/collections/milestones/records/${r.id}`, alice);
  check("cleanup: RULE-TEST milestone deleted", s, 204);
}

console.log();
await tierkit.verify_tiers();

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
} else {
  console.log("✅ PASS — all checks matched");
}

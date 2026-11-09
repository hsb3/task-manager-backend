#!/usr/bin/env bun
/**
 * E2E proof of the evolved `comments` surface (migrations 1785152700/1785155000/1785155400/
 * 1785155600/1785156100 + comment hooks in pb_hooks/notify.pb.js, pb_hooks/author.pb.js and
 * pb_hooks/scope.pb.js): task/document/decision XOR target, single-level thread parent,
 * member-scoped own-id-only reactions, the tamper-proof `edited` flag, caller-stamped immutable
 * `author`, the anonymous-write guard, view/update/delete parity — an author's write must not
 * outreach their own read (TASK-056) — the target/identity field lock that blocks a re-scope
 * into a foreign tenant (TASK-070), and the two-tier parent lock that blocks a graft onto a
 * foreign tenant's thread and the cascade delete it would arm (TASK-079).
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures.
 * Port 8102 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  by_code_point,
  py_repr,
  run_checked,
  truthy,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8102 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(64)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

tierkit.use(api);

async function find_by_filter(
  collection: string,
  filt: string,
  token: string | null = null,
  per_page = 200,
): Promise<any[]> {
  const qs = urlencode({ filter: filt, perPage: per_page });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return r.items || [];
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<string | null> {
  const items = await find_by_filter(collection, `${field}='${esc(value)}'`, token);
  return items.length ? getitem(items[0], "id") : null;
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token;
  if (!tok) throw new Error(`superuser auth failed: ${py_repr(r)}`);
  return tok;
}

async function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  const proc = await roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
  // A silent collision is the failure mode this log line exists for: the holder pid is what the
  // OS attributes to the socket, so the log names the room this run actually asserted against.
  console.log(
    `── clean room on 127.0.0.1:${PORT} (8102 + PB_PORT_OFFSET ${PORT_OFFSET}), ` +
      `socket held by pid(s) ${py_repr([...roomkit.listening_pids(PORT)].sort((a, b) => a - b))} ──`,
  );
  return proc;
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-comments-test-"));
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
  server = await start_server(DATA_DIR, MIG_DIR);
  const su = await superuser_token();

  console.log("\n── seed: alice/bob/carol fixtures (scripts/seed.ts) ──");
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
  const [bob, bob_id] = await login("bob@example.com");
  const [carol, carol_id] = await login("carol@example.com");

  let s: number;
  let r: any;

  const ALICE_WS = (await find_id("workspaces", "name", "Alice's Workspace", alice))!;
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("resolved Alice's workspace", truthy(ALICE_WS), true);
  check("resolved Alice's project", truthy(ALICE_PROJECT), true);
  // The seeded premise of every "Bob (member) … → 404" below: without the row those denials
  // are the tenancy guard answering, not the rule they name.
  const bob_tier = await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");

  let t1: any;
  [s, t1] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-comments-fixture-task1",
    project: ALICE_PROJECT,
  });
  check("(fixture) Alice creates TASK1", s, 200);
  const TASK1 = t1.id ?? null;
  let t2: any;
  [s, t2] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "G2-comments-fixture-task2",
    project: ALICE_PROJECT,
  });
  check("(fixture) Alice creates TASK2", s, 200);
  const TASK2 = t2.id ?? null;
  let doc: any;
  [s, doc] = await api("POST", "/api/collections/documents/records", alice, {
    title: "G2-comments-fixture-doc",
    workspace: ALICE_WS,
  });
  check("(fixture) Alice creates DOCUMENT", s, 200);
  const DOCUMENT = doc.id ?? null;
  let dec: any;
  [s, dec] = await api("POST", "/api/collections/decisions/records", alice, {
    title: "G2-comments-fixture-decision",
    workspace: ALICE_WS,
  });
  check("(fixture) Alice creates DECISION", s, 200);
  const DECISION = dec.id ?? null;

  // COVERS: rule:comments.create
  // ══════════════════ A. target matrix (XOR) ══════════════════════════════════
  console.log("\n── (A) target matrix: exactly one of task/document/decision ──");
  let c_task: any;
  [s, c_task] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    author: alice_id,
    body: "task-only",
  });
  check("task-only comment → 200", s, 200);
  const TOP = c_task.id ?? null;

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    document: DOCUMENT,
    author: alice_id,
    body: "document-only",
  });
  check("document-only comment → 200", s, 200);

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    decision: DECISION,
    author: alice_id,
    body: "decision-only",
  });
  check("decision-only comment → 200", s, 200);

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    author: alice_id,
    body: "zero-target",
  });
  check("zero-target comment → 400", s, 400);

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    document: DOCUMENT,
    author: alice_id,
    body: "two-target",
  });
  check("two-target (task+document) comment → 400", s, 400);

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    document: DOCUMENT,
    decision: DECISION,
    author: alice_id,
    body: "three-target",
  });
  check("three-target comment → 400", s, 400);

  // COVERS: rule:comments.create
  // ══════════════════ B. membership scoping on non-task targets ══════════════
  console.log("\n── (B) membership scoping on document/decision targets ──");
  [s] = await api("POST", "/api/collections/comments/records", bob, {
    document: DOCUMENT,
    author: bob_id,
    body: "bob doc comment",
  });
  check("Bob (member) comments on Alice's document → 200", s, 200);
  [s] = await api("POST", "/api/collections/comments/records", carol, {
    document: DOCUMENT,
    author: carol_id,
    body: "carol doc comment",
  });
  check("Carol (non-member) comments on Alice's document → 400", s, 400);

  // COVERS: rule:comments.create
  // ══════════════════ C. single-level thread ══════════════════════════════════
  console.log("\n── (C) thread: reply to top-level ok, reply-to-reply / cross-task denied ──");
  let reply1: any;
  [s, reply1] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    parent: TOP,
    author: alice_id,
    body: "reply1",
  });
  check("reply to a top-level comment on the SAME task → 200", s, 200);
  const REPLY1 = reply1.id ?? null;

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    parent: REPLY1,
    author: alice_id,
    body: "reply-to-reply",
  });
  check("reply-to-reply (parent not top-level) → 400", s, 400);

  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK2,
    parent: TOP,
    author: alice_id,
    body: "cross-task reply",
  });
  check("reply whose parent is on a DIFFERENT task → 400", s, 400);

  // COVERS: rule:comments.update, rule:comments.view, hook:notify.pb.js#onRecordUpdateRequest:comments
  // ══════════════════ D. reactions (member, own-id-only) ══════════════════════
  console.log("\n── (D) reactions: member own-id-only toggle, field-locked ──");
  let react_c: any;
  [s, react_c] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    author: alice_id,
    body: "react target",
  });
  check("(fixture) Alice creates REACT_C", s, 200);
  const REACT_C = react_c.id ?? null;
  const edited_before = react_c.edited;

  [s] = await api("PATCH", `/api/collections/comments/records/${REACT_C}`, bob, {
    reactions: { "👍": [bob_id] },
  });
  check("Bob (member) reacts with HIS OWN id → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${REACT_C}`, alice);
  check("edited unchanged after a reactions-only PATCH", r.edited, edited_before);

  [s] = await api("PATCH", `/api/collections/comments/records/${REACT_C}`, bob, {
    reactions: { "👍": [alice_id] },
  });
  check("Bob PATCH reactions with SOMEONE ELSE's id → 400", s, 400);

  [s] = await api("PATCH", `/api/collections/comments/records/${REACT_C}`, carol, {
    reactions: { "👍": [carol_id] },
  });
  check("Carol (non-member) PATCH reactions → 404", s, 404);

  [s] = await api("PATCH", `/api/collections/comments/records/${REACT_C}`, bob, { body: "hijack" });
  check(
    "Bob (member) PATCH body (field-lock) → 404",
    tup(await bob_tier.now(), s),
    tup("member", 404),
  );

  // COVERS: rule:comments.update, rule:comments.view, hook:notify.pb.js#onRecordUpdateRequest:comments
  // ══════════════════ E. edited flag (hook-set, tamper-proof) ═════════════════
  console.log("\n── (E) edited flag: hook-set on real body change, not client-settable ──");
  let edit_c: any;
  [s, edit_c] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    author: alice_id,
    body: "v1",
  });
  check("(fixture) Alice creates EDIT_C", s, 200);
  const EDIT_C = edit_c.id ?? null;
  check("EDIT_C starts un-edited", truthy(edit_c.edited), false);

  [s] = await api("PATCH", `/api/collections/comments/records/${EDIT_C}`, alice, { body: "v2" });
  check("Alice (author) edits body → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${EDIT_C}`, alice);
  check("edited flips to true after a real body change", r.edited, true);

  [s] = await api("PATCH", `/api/collections/comments/records/${EDIT_C}`, alice, {
    body: "v3",
    edited: false,
  });
  check("Alice edits body again, sending edited:false → 200 (accepted, not honored)", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${EDIT_C}`, alice);
  check("edited stays true — client cannot force it false while changing body", r.edited, true);
  check(
    "body change DID take effect (edited is hook-set, not tamper-proof-by-rejection)",
    r.body,
    "v3",
  );

  // COVERS: rule:comments.list
  // ══════════════════ F. list (no explicit filter, rule-scoped) ═══════════════
  console.log("\n── (F) list: GET without a filter scopes to the caller's own workspaces ──");
  [s, r] = await api("GET", "/api/collections/comments/records"); // anonymous
  check(
    "anon list comments → 200 (authRequired listRule filters to empty)",
    tup(s, r.totalItems),
    tup(200, 0),
  );
  [s, r] = await api("GET", "/api/collections/comments/records", alice);
  check("alice (member) lists comments → 200", s, 200);
  check("alice sees at least her own comments", (r.totalItems ?? 0) >= 1, true);
  [s, r] = await api("GET", "/api/collections/comments/records", carol);
  let carol_ids = new Set<string>((r.items ?? []).map((it: any) => getitem(it, "id")));
  check(
    "carol (non-member of Alice's ws) list is 200 and excludes Alice's comment",
    tup(s, carol_ids.has(TOP)),
    tup(200, false),
  );

  // COVERS: hook:author.pb.js#onRecordCreateRequest:comments
  // ══════════════════ G. author stamped from the caller at create ═════════════
  console.log("\n── (G) author: a submitted author is overwritten with the caller ──");
  let spoof: any;
  [s, spoof] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK1,
    author: alice_id,
    body: "spoof at create",
  });
  check("Bob creates a comment claiming author=Alice → 200", s, 200);
  const SPOOF_C = spoof.id ?? null;
  check("submitted author is overwritten with the caller (Bob)", spoof.author, bob_id);
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back confirms the stored author is Bob", r.author, bob_id);

  let own: any;
  [s, own] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    body: "no author submitted",
  });
  check("Alice creates a comment with NO author → 200", s, 200);
  const OWN_C = own.id ?? null;
  check("author is stamped from the caller when omitted", own.author, alice_id);

  let su_c: any;
  [s, su_c] = await api("POST", "/api/collections/comments/records", su, {
    task: TASK1,
    author: carol_id,
    body: "superuser import",
  });
  check(
    "superuser create keeps the submitted author (seed/import fidelity)",
    tup(s, su_c.author),
    tup(200, carol_id),
  );

  // COVERS: hook:author.pb.js#onRecordUpdateRequest:comments
  // ══════════════════ H. author immutable after create ════════════════════════
  console.log("\n── (H) author: immutable after create; legitimate updates unaffected ──");
  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, bob, {
    author: alice_id,
  });
  check("Bob (its author) repoints author → 404 (rule field-lock)", s, 404);
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back: author still Bob", r.author, bob_id);

  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, alice, {
    author: alice_id,
  });
  check("Alice (workspace owner) repoints Bob's comment author → 404 (rule field-lock)", s, 404);
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back after the owner attempt: author still Bob", r.author, bob_id);

  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, carol, {
    author: carol_id,
  });
  check("Carol (non-member) repoints author → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, null, {
    author: carol_id,
  });
  check("anon repoints author → 404 (updateRule denies before the hook)", s, 404);
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back after the anon attempt: author still Bob", r.author, bob_id);

  [s] = await api("PATCH", `/api/collections/comments/records/${OWN_C}`, alice, {
    body: "author edits her own body",
  });
  check("author's own body edit still → 200 (guard passes an untouched author)", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${OWN_C}`, alice);
  check("that body edit took effect", r.body, "author edits her own body");
  check("edited flipped true on that body edit", r.edited, true);

  [s] = await api("PATCH", `/api/collections/comments/records/${OWN_C}`, bob, {
    reactions: { "🎉": [bob_id] },
  });
  check("member reactions-only PATCH on someone else's comment still → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${OWN_C}`, alice);
  check(
    "reactions landed and author is untouched",
    tup(r.reactions, r.author),
    tup({ "🎉": [bob_id] }, alice_id),
  );

  // scripts/seed.ts ships only alice/bob/carol — the admin/member/viewer arms are built here.
  console.log("\n── (H) …the rest of the role matrix: admin, member, viewer, superuser ──");

  async function su_create_user(name: string, email: string): Promise<string> {
    const [s, r] = await api("POST", "/api/collections/users/records", su, {
      email: email,
      password: "test123456",
      passwordConfirm: "test123456",
      name: name,
      verified: true,
      approved: true,
    });
    check(`(fixture) superuser creates ${name}`, s, 200);
    return r.id ?? null;
  }

  const dave_id = await su_create_user("Dave", "dave@example.com");
  const erin_id = await su_create_user("Erin", "erin@example.com");
  const frank_id = await su_create_user("Frank", "frank@example.com");
  const TIER: tierkit.Tier[] = [];
  for (const [uid, role, who] of [
    [dave_id, "admin", "Dave"],
    [erin_id, "member", "Erin"],
    [frank_id, "viewer", "Frank"],
  ]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: ALICE_WS,
      user: uid,
      role: role,
      status: "active",
    });
    check(`(fixture) ${who} joins Alice's workspace as ${role}`, s, 200);
    TIER.push(await tierkit.actor_at_tier(ALICE_WS, uid, role, su, who));
  }
  const [dave] = await login("dave@example.com");
  const [erin] = await login("erin@example.com");
  const [frank] = await login("frank@example.com");

  async function tiers_now() {
    // A rule denial and a lost-tenancy denial are the same 404 on the wire, so the tiers are
    // re-read from the server and asserted beside the denials rather than assumed.
    const out: string[] = [];
    for (const t of TIER) out.push(await t.now());
    return tup(...out);
  }

  const TIERS = tup("admin", "member", "viewer");

  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, dave, {
    author: alice_id,
  });
  check(
    "Dave (workspace admin) repoints author → 404 (rule field-lock)",
    tup((await tiers_now())[0], s),
    tup("admin", 404),
  );
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back after the admin attempt: author still Bob", r.author, bob_id);

  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, erin, {
    author: erin_id,
  });
  check(
    "Erin (plain member, not the author) repoints author → 404",
    tup((await tiers_now())[1], s),
    tup("member", 404),
  );
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back after the member attempt: author still Bob", r.author, bob_id);

  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, frank, {
    author: frank_id,
  });
  check("Frank (viewer) repoints author → 404", tup((await tiers_now())[2], s), tup("viewer", 404));
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back after the viewer attempt: author still Bob", r.author, bob_id);

  [s] = await api("PATCH", `/api/collections/comments/records/${SPOOF_C}`, su, {
    author: alice_id,
  });
  check("superuser repoints author → 400 (the author HOOK has no superuser bypass)", s, 400);
  [s, r] = await api("GET", `/api/collections/comments/records/${SPOOF_C}`, bob);
  check("read-back after the superuser attempt: author still Bob", r.author, bob_id);

  // COVERS: rule:comments.update, rule:comments.delete
  // ══════════════════ I. anonymous callers cannot write ═══════════════════════
  console.log("\n── (I) anon: update/delete denied on every target flavor ──");

  async function anon_write_denied(label: string, cid: string): Promise<void> {
    let s: number;
    let r: any;
    const [, before] = await api("GET", `/api/collections/comments/records/${cid}`, alice);
    const was = tup(before.body, before.edited);
    [s] = await api("PATCH", `/api/collections/comments/records/${cid}`, null, {
      body: "anon hijack",
    });
    check(`anon PATCH body on ${label} comment → 404`, s, 404);
    [s, r] = await api("GET", `/api/collections/comments/records/${cid}`, alice);
    check(`${label} comment body/edited unchanged after anon PATCH`, tup(r.body, r.edited), was);
    [s] = await api("DELETE", `/api/collections/comments/records/${cid}`, null);
    check(`anon DELETE on ${label} comment → 404`, s, 404);
    [s] = await api("GET", `/api/collections/comments/records/${cid}`, alice);
    check(`${label} comment still exists after the anon DELETE`, s, 200);
  }

  let anon_task_c: any;
  [s, anon_task_c] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    body: "anon-guard task",
  });
  check("(fixture) task-targeted comment for the anon probes", s, 200);
  await anon_write_denied("task-targeted", anon_task_c.id);

  let anon_doc_c: any;
  [s, anon_doc_c] = await api("POST", "/api/collections/comments/records", alice, {
    document: DOCUMENT,
    body: "anon-guard document",
  });
  check("(fixture) document-targeted comment for the anon probes", s, 200);
  await anon_write_denied("document-targeted", anon_doc_c.id);

  let anon_dec_c: any;
  [s, anon_dec_c] = await api("POST", "/api/collections/comments/records", alice, {
    decision: DECISION,
    body: "anon-guard decision",
  });
  check("(fixture) decision-targeted comment for the anon probes", s, 200);
  await anon_write_denied("decision-targeted", anon_dec_c.id);

  // author.pb.js stamps the caller only for non-superusers, so a superuser create is the reachable author="" construction.
  let anon_noauthor_c: any;
  [s, anon_noauthor_c] = await api("POST", "/api/collections/comments/records", su, {
    task: TASK1,
    body: "anon-guard empty author",
  });
  check(
    "(fixture) superuser create with NO author stores an empty author",
    tup(s, anon_noauthor_c.author),
    tup(200, ""),
  );
  await anon_write_denied("empty-author", anon_noauthor_c.id);

  [s] = await api("PATCH", `/api/collections/comments/records/${anon_task_c.id}`, carol, {
    body: "carol hijack",
  });
  check("control: authenticated non-member PATCH body → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/comments/records/${anon_task_c.id}`, carol);
  check("control: authenticated non-member DELETE → 404", s, 404);
  [s, r] = await api("GET", `/api/collections/comments/records/${anon_task_c.id}`, alice);
  check(
    "control: that comment survived the non-member attempts",
    tup(s, r.body),
    tup(200, "anon-guard task"),
  );

  // COVERS: rule:comments.delete
  // ══════════════════ J. authorized deletes ═══════════════════════════════════
  console.log("\n── (J) delete: author / owner / admin allowed, viewer and plain member not ──");

  async function bob_comment(label: string): Promise<string> {
    const [s, c] = await api("POST", "/api/collections/comments/records", bob, {
      task: TASK1,
      body: label,
    });
    check(`(fixture) Bob creates a comment for the ${label} probe`, s, 200);
    return c.id ?? null;
  }

  [s] = await api(
    "DELETE",
    `/api/collections/comments/records/${await bob_comment("author-delete")}`,
    bob,
  );
  check("Bob (author) deletes his own comment → 204", s, 204);

  [s] = await api(
    "DELETE",
    `/api/collections/comments/records/${await bob_comment("owner-delete")}`,
    alice,
  );
  check("Alice (workspace owner) deletes Bob's comment → 204", s, 204);

  [s] = await api(
    "DELETE",
    `/api/collections/comments/records/${await bob_comment("admin-delete")}`,
    dave,
  );
  check("Dave (workspace admin) deletes Bob's comment → 204", s, 204);

  const survivor = await bob_comment("denied-delete");
  [s] = await api("DELETE", `/api/collections/comments/records/${survivor}`, frank);
  check(
    "Frank (viewer) deletes Bob's comment → 404",
    tup((await tiers_now())[2], s),
    tup("viewer", 404),
  );
  [s] = await api("DELETE", `/api/collections/comments/records/${survivor}`, erin);
  check(
    "Erin (plain member, not the author) deletes it → 404",
    tup((await tiers_now())[1], s),
    tup("member", 404),
  );
  [s] = await api("GET", `/api/collections/comments/records/${survivor}`, alice);
  check("that comment survived both denied deletes", s, 200);

  // COVERS: rule:comments.list, rule:comments.view, rule:comments.create, rule:comments.update, rule:comments.delete
  // ══════════ K. project-less task: comments.* re-scope to task.workspace (TASK-050) ══
  console.log("\n── (K) project-less task: comments visible/moderable via task.workspace ──");

  let pltask: any;
  [s, pltask] = await api("POST", "/api/collections/tasks/records", alice, {
    title: "K-projectless-task",
    workspace: ALICE_WS,
  });
  check("(fixture) Alice creates a project-less task", s, 200);
  const PL_TASK = pltask.id ?? null;
  [s, r] = await api("GET", `/api/collections/tasks/records/${PL_TASK}`, alice);
  // decision:shadow-project: a create with no project lands in the workspace shadow project, which only
  // a superuser can resolve — the projects rules hide it from every tenant role.
  const [, _shadow] = await api(
    "GET",
    "/api/collections/projects/records?" +
      urlencode({ filter: `workspace='${ALICE_WS}' && shadow=true` }),
    su,
  );
  const ALICE_SHADOW = (_shadow.items?.length ? _shadow.items : [{}])[0].id ?? null;
  check(
    "project-less task fixture: stored project is the workspace shadow project",
    r.project,
    ALICE_SHADOW,
  );
  check("project-less task fixture: stored workspace is Alice's", r.workspace, ALICE_WS);
  console.log(`  (info) auto-filled assignee at create: ${py_repr(r.assignee)}`);

  const gina_id = await su_create_user("Gina", "gina@example.com");
  let m: any;
  [s, m] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: gina_id,
    role: "member",
    status: "active",
  });
  check("(fixture) Gina joins Alice's workspace as member", tup(s, m.role), tup(200, "member"));
  // auto-fill would make Alice the assignee, colliding with her owner-branch checks below
  [s] = await api("PATCH", `/api/collections/tasks/records/${PL_TASK}`, alice, {
    assignee: gina_id,
  });
  check("(fixture) repoint the task's assignee to Gina (disjoint from every actor below)", s, 200);
  [s, r] = await api("GET", `/api/collections/tasks/records/${PL_TASK}`, alice);
  check("read-back confirms assignee is Gina", r.assignee, gina_id);

  // proven separately, create-and-forget: the checks below need a comment NOT authored
  // by Alice, or her view/update checks would pass via `author =` regardless of this fix
  [s] = await api("POST", "/api/collections/comments/records", alice, {
    task: PL_TASK,
    body: "K-alice-owner-create",
  });
  check("Alice (workspace OWNER) creates a comment on it → 200 (createRule owner branch)", s, 200);

  let pl_c: any;
  [s, pl_c] = await api("POST", "/api/collections/comments/records", bob, {
    task: PL_TASK,
    body: "K-bob-comment",
  });
  check(
    "Bob (plain non-viewer member) creates a comment on it → 200 (createRule re-scope)",
    s,
    200,
  );
  let PL_C: string = pl_c.id ?? null;

  [s] = await api("GET", `/api/collections/comments/records/${PL_C}`, alice);
  check("Alice (OWNER, neither author nor assignee) views it → 200", s, 200);

  [s] = await api("PATCH", `/api/collections/comments/records/${PL_C}`, alice, {
    body: "K-alice-edit",
  });
  check("Alice (OWNER, neither author nor assignee) edits its body → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${PL_C}`, alice);
  check("read-back: the edit landed", r.body, "K-alice-edit");

  [s, r] = await api("GET", "/api/collections/comments/records", bob);
  const bob_ids = new Set<string>((r.items ?? []).map((it: any) => getitem(it, "id")));
  check(
    "Bob's unfiltered list is 200 and includes his own comment (listRule re-scope)",
    tup(s, bob_ids.has(PL_C)),
    tup(200, true),
  );

  let bob_c2: any;
  [s, bob_c2] = await api("POST", "/api/collections/comments/records", bob, {
    task: PL_TASK,
    body: "K-bob-comment-2",
  });
  check("(fixture) Bob creates a second comment for Dave's admin PATCH", s, 200);
  const BOB_C2 = bob_c2.id ?? null;
  [s] = await api("PATCH", `/api/collections/comments/records/${BOB_C2}`, dave, {
    body: "K-dave-moderates-bob",
  });
  check("Dave (ADMIN, neither author nor assignee) edits Bob's comment → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${BOB_C2}`, alice);
  check("read-back: Dave's edit landed", r.body, "K-dave-moderates-bob");

  let throw1: any;
  [s, throw1] = await api("POST", "/api/collections/comments/records", bob, {
    task: PL_TASK,
    body: "K-throwaway-1",
  });
  check("(fixture) Bob creates a throwaway comment for Alice's delete", s, 200);
  const THROW1 = throw1.id ?? null;
  [s] = await api("DELETE", `/api/collections/comments/records/${THROW1}`, alice);
  check("Alice (OWNER, not its author) deletes it → 204", s, 204);
  [s] = await api("GET", `/api/collections/comments/records/${THROW1}`, alice);
  check("read-back: it is really gone → 404", s, 404);

  let throw2: any;
  [s, throw2] = await api("POST", "/api/collections/comments/records", bob, {
    task: PL_TASK,
    body: "K-throwaway-2",
  });
  check("(fixture) Bob creates a second throwaway comment for Dave's delete", s, 200);
  const THROW2 = throw2.id ?? null;
  [s] = await api("DELETE", `/api/collections/comments/records/${THROW2}`, dave);
  check("Dave (ADMIN, not its author) deletes it → 204", s, 204);
  [s] = await api("GET", `/api/collections/comments/records/${THROW2}`, alice);
  check("read-back: it is really gone → 404", s, 404);

  // DENY arm below: author=Bob, assignee=Gina — carol/frank/erin/anon are neither
  const SURVIVOR = BOB_C2;
  [s] = await api("GET", `/api/collections/comments/records/${SURVIVOR}`, carol);
  check("Carol (non-member) views it → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/comments/records/${SURVIVOR}`, carol, {
    body: "carol hijack",
  });
  check("Carol (non-member) PATCHes it → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/comments/records/${SURVIVOR}`, carol);
  check("Carol (non-member) DELETEs it → 404", s, 404);

  [s] = await api("POST", "/api/collections/comments/records", carol, {
    task: PL_TASK,
    body: "carol comment",
  });
  check("Carol (non-member) creates a comment on it → 400", s, 400);

  [s, r] = await api("GET", "/api/collections/comments/records", carol);
  carol_ids = new Set<string>((r.items ?? []).map((it: any) => getitem(it, "id")));
  check(
    "Carol's unfiltered list is 200 and excludes it",
    tup(s, carol_ids.has(SURVIVOR)),
    tup(200, false),
  );

  [s] = await api("GET", `/api/collections/comments/records/${SURVIVOR}`, null);
  check("anon views it → 404", s, 404);
  await anon_write_denied("project-less task", SURVIVOR);

  [s] = await api("POST", "/api/collections/comments/records", frank, {
    task: PL_TASK,
    body: "frank comment",
  });
  check(
    "Frank (viewer) creates a comment on it → 400",
    tup((await tiers_now())[2], s),
    tup("viewer", 400),
  );
  [s] = await api("DELETE", `/api/collections/comments/records/${SURVIVOR}`, frank);
  check(
    "Frank (viewer) deletes the surviving comment → 404",
    tup((await tiers_now())[2], s),
    tup("viewer", 404),
  );

  [s] = await api("DELETE", `/api/collections/comments/records/${SURVIVOR}`, erin);
  check(
    "Erin (plain member, not the author) deletes it → 404",
    tup((await tiers_now())[1], s),
    tup("member", 404),
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${SURVIVOR}`, erin, {
    body: "erin hijack",
  });
  check(
    "Erin (plain member, not the author) PATCHes it → 404",
    tup((await tiers_now())[1], s),
    tup("member", 404),
  );

  [s] = await api("GET", `/api/collections/comments/records/${SURVIVOR}`, alice);
  check("it survived the entire deny arm → 200", s, 200);

  // COVERS: rule:comments.view, rule:comments.update
  // ══════════ L. non-orphan comment: view+update, full role matrix (TASK-056) ══
  console.log("\n── (L) non-orphan comment: view+update across the full role matrix ──");

  let l_c: any;
  [s, l_c] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK1,
    body: "L-tier-comment",
  });
  check("(fixture) Bob creates L_C on TASK1", s, 200);
  const L_C = l_c.id ?? null;

  [s] = await api("GET", `/api/collections/comments/records/${L_C}`, bob);
  check("Bob (author) views L_C → 200", s, 200);
  [s] = await api("GET", `/api/collections/comments/records/${L_C}`, alice);
  check("Alice (owner) views L_C → 200", s, 200);
  [s] = await api("GET", `/api/collections/comments/records/${L_C}`, dave);
  check("Dave (admin) views L_C → 200", s, 200);
  [s] = await api("GET", `/api/collections/comments/records/${L_C}`, erin);
  check("Erin (plain member, not author) views L_C → 200", s, 200);
  [s] = await api("GET", `/api/collections/comments/records/${L_C}`, frank);
  check("Frank (viewer) views L_C → 200", s, 200);
  [s] = await api("GET", `/api/collections/comments/records/${L_C}`, carol);
  check("Carol (outsider) views L_C → 404", s, 404);
  [s] = await api("GET", `/api/collections/comments/records/${L_C}`, null);
  check("anon views L_C → 404", s, 404);

  [s] = await api("PATCH", `/api/collections/comments/records/${L_C}`, frank, {
    body: "frank hijack",
  });
  check(
    "Frank (viewer) updates L_C body → 404",
    tup((await tiers_now())[2], s),
    tup("viewer", 404),
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${L_C}`, erin, {
    body: "erin hijack",
  });
  check(
    "Erin (plain member, not author) updates L_C body → 404",
    tup((await tiers_now())[1], s),
    tup("member", 404),
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${L_C}`, carol, {
    body: "carol hijack",
  });
  check("Carol (outsider) updates L_C body → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/comments/records/${L_C}`, null, {
    body: "anon hijack",
  });
  check("anon updates L_C body → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/comments/records/${L_C}`, dave, {
    body: "L-dave-edit",
  });
  check("Dave (admin) updates L_C body → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${L_C}`, alice);
  check("read-back: Dave's edit landed", r.body, "L-dave-edit");
  [s] = await api("PATCH", `/api/collections/comments/records/${L_C}`, alice, {
    body: "L-alice-edit",
  });
  check("Alice (owner) updates L_C body → 200", s, 200);
  [s] = await api("PATCH", `/api/collections/comments/records/${L_C}`, bob, {
    body: "L-bob-edit",
  });
  check("Bob (author) updates L_C body → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${L_C}`, alice);
  check("read-back: Bob's edit landed", r.body, "L-bob-edit");

  // COVERS: rule:comments.view, rule:comments.update, rule:comments.delete
  // ══════════ M. orphan comment: author write must not exceed author read (TASK-056) ══
  console.log("\n── (M) orphan comment (no target): author view/update/delete all denied ──");

  let orphan_c: any;
  [s, orphan_c] = await api("POST", "/api/collections/comments/records", su, {
    author: bob_id,
    body: "orphan comment",
  });
  check('(fixture) superuser creates an orphan comment (task=document=decision="")', s, 200);
  const ORPHAN_C = orphan_c.id ?? null;
  check(
    "orphan fixture: task/document/decision all empty",
    tup(orphan_c.task, orphan_c.document, orphan_c.decision),
    tup("", "", ""),
  );

  [s] = await api("GET", `/api/collections/comments/records/${ORPHAN_C}`, bob);
  check("Bob (its author) views the orphan → 404 (control: already true pre-fix)", s, 404);
  [s] = await api("PATCH", `/api/collections/comments/records/${ORPHAN_C}`, bob, {
    body: "orphan hijack",
  });
  check("Bob (its author) updates the orphan → 404 (no write without view)", s, 404);
  [s] = await api("DELETE", `/api/collections/comments/records/${ORPHAN_C}`, bob);
  check("Bob (its author) deletes the orphan → 404 (no write without view)", s, 404);

  [s] = await api("GET", `/api/collections/comments/records/${ORPHAN_C}`, alice);
  check("Alice (workspace owner, unrelated to the orphan) views it → 404", s, 404);
  [s] = await api("PATCH", `/api/collections/comments/records/${ORPHAN_C}`, alice, {
    body: "alice hijack",
  });
  check("Alice (unrelated owner) updates the orphan → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/comments/records/${ORPHAN_C}`, alice);
  check("Alice (unrelated owner) deletes the orphan → 404", s, 404);

  [s] = await api("GET", `/api/collections/comments/records/${ORPHAN_C}`, dave);
  check(
    "Dave (workspace admin, unrelated to the orphan) views it → 404",
    tup((await tiers_now())[0], s),
    tup("admin", 404),
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${ORPHAN_C}`, dave, {
    body: "dave hijack",
  });
  check("Dave (unrelated admin) updates the orphan → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/comments/records/${ORPHAN_C}`, dave);
  check("Dave (unrelated admin) deletes the orphan → 404", s, 404);

  [s, r] = await api("GET", `/api/collections/comments/records/${ORPHAN_C}`, su);
  check(
    "superuser views the orphan → 200 (rules bypassed)",
    tup(s, r.body),
    tup(200, "orphan comment"),
  );

  // COVERS: rule:comments.update
  // ══════════ N. re-scope: target/identity fields locked on EVERY branch (TASK-070) ══
  console.log("\n── (N) re-scope: no branch may move a comment into a tenant it cannot read ──");

  const CAROL_WS = (await find_id("workspaces", "name", "Carol's Workspace", carol))!;
  check("resolved Carol's workspace (the foreign tenant)", truthy(CAROL_WS), true);
  let f_task: any;
  [s, f_task] = await api("POST", "/api/collections/tasks/records", carol, {
    title: "N-foreign-task",
    workspace: CAROL_WS,
  });
  check("(fixture) Carol creates a task in HER workspace", s, 200);
  const FOREIGN_TASK = f_task.id ?? null;
  let f_doc: any;
  [s, f_doc] = await api("POST", "/api/collections/documents/records", carol, {
    title: "N-foreign-document",
    workspace: CAROL_WS,
  });
  check("(fixture) Carol creates a document in HER workspace", s, 200);
  const FOREIGN_DOC = f_doc.id ?? null;
  let f_dec: any;
  [s, f_dec] = await api("POST", "/api/collections/decisions/records", carol, {
    title: "N-foreign-decision",
    workspace: CAROL_WS,
  });
  check("(fixture) Carol creates a decision in HER workspace", s, 200);
  const FOREIGN_DEC = f_dec.id ?? null;

  let n_c: any;
  [s, n_c] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK1,
    body: "N-bob-comment",
  });
  check("(fixture) Bob creates N_C on TASK1 (inside Alice's workspace)", s, 200);
  const N_C = n_c.id ?? null;

  [s] = await api("GET", `/api/collections/tasks/records/${FOREIGN_TASK}`, bob);
  check("control: Bob (author of N_C) views the foreign task → 404", s, 404);
  [s] = await api("GET", `/api/collections/documents/records/${FOREIGN_DOC}`, bob);
  check("control: Bob views the foreign document → 404", s, 404);
  [s] = await api("GET", `/api/collections/decisions/records/${FOREIGN_DEC}`, bob);
  check("control: Bob views the foreign decision → 404", s, 404);

  async function readback_unchanged(after_what: string): Promise<void> {
    const [, rec] = await api("GET", `/api/collections/comments/records/${N_C}`, su);
    const got = tup(rec.task, rec.document, rec.decision, rec.author);
    check(
      `read-back (superuser): N_C target/author unchanged after ${after_what}`,
      got,
      tup(TASK1, "", "", bob_id),
    );
    // restore on drift so one leaked arm cannot mask the arms after it
    if (!Bun.deepEquals(got, tup(TASK1, "", "", bob_id), true)) {
      await api("PATCH", `/api/collections/comments/records/${N_C}`, su, {
        task: TASK1,
        document: "",
        decision: "",
        author: bob_id,
      });
    }
  }

  [s] = await api("PATCH", `/api/collections/comments/records/${N_C}`, bob, {
    task: FOREIGN_TASK,
  });
  check("Bob (author) rescopes comment.task into a workspace he cannot view → 404", s, 404);
  await readback_unchanged("Bob's .task attempt");

  for (const [field, value] of [
    ["document", FOREIGN_DOC],
    ["decision", FOREIGN_DEC],
    ["author", carol_id],
  ]) {
    [s] = await api("PATCH", `/api/collections/comments/records/${N_C}`, bob, { [field]: value });
    check(`Bob (author) rescopes comment.${field} toward the foreign tenant → 404`, s, 404);
    await readback_unchanged(`Bob's .${field} attempt`);
  }

  // The loop below leans on admin/member/viewer callers: re-read the tiers here, or a
  // caller who lost membership would answer with the same 404 and prove nothing.
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);
  for (const [who, token] of [
    ["Alice (workspace owner)", alice],
    ["Dave (workspace admin)", dave],
    ["Erin (plain member)", erin],
    ["Frank (viewer)", frank],
    ["Carol (outsider, owns the foreign tenant)", carol],
    ["anon", null],
  ] as [string, string | null][]) {
    [s] = await api("PATCH", `/api/collections/comments/records/${N_C}`, token, {
      task: FOREIGN_TASK,
    });
    check(`${who} rescopes comment.task into Carol's workspace → 404`, s, 404);
    await readback_unchanged(`the ${who} attempt`);
  }

  [s] = await api("PATCH", `/api/collections/comments/records/${N_C}`, bob, { task: TASK2 });
  check("Bob (author) re-targets comment.task to a task he CAN view → 404 (blanket lock)", s, 404);
  await readback_unchanged("the same-workspace re-target attempt");

  [s] = await api("PATCH", `/api/collections/comments/records/${N_C}`, bob, {
    body: "N-bob-edit",
  });
  check("Bob (author) edits body only (no target/identity key) → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${N_C}`, alice);
  check("read-back: the body edit landed", r.body, "N-bob-edit");
  [s] = await api("PATCH", `/api/collections/comments/records/${N_C}`, erin, {
    reactions: { "👍": [erin_id] },
  });
  check("Erin (plain member) reactions-only PATCH still → 200", s, 200);

  let throw_n: any;
  [s, throw_n] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK1,
    body: "N-superuser-boundary",
  });
  check("(fixture) Bob creates a throwaway for the superuser boundary probe", s, 200);
  const THROW_N = throw_n.id ?? null;
  [s] = await api("PATCH", `/api/collections/comments/records/${THROW_N}`, su, {
    task: FOREIGN_TASK,
  });
  check(
    "superuser rescopes it → 200 (bounded: the lock is a RULE, so rules-bypass beats it)",
    s,
    200,
  );
  [s] = await api("DELETE", `/api/collections/comments/records/${THROW_N}`, su);
  check("(cleanup) superuser deletes the rescoped throwaway → 204", s, 204);

  // COVERS: rule:comments.update
  // ══════════ O. parent re-point: cross-tenant thread graft + its cascade (TASK-079) ══
  console.log("\n── (O) parent: no branch may graft a comment onto a foreign tenant's thread ──");

  // comments.parent is cascadeDelete — prove that INSIDE the tenant first, so the
  // cross-tenant denials below are not a vacuous claim about an inert relation.
  let casc_p: any;
  [s, casc_p] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    body: "O-cascade-parent",
  });
  check("(fixture) Alice creates a top-level comment to be a cascade parent", s, 200);
  const CASC_P = casc_p.id ?? null;
  let casc_c: any;
  [s, casc_c] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    parent: CASC_P,
    body: "O-cascade-child",
  });
  check("(fixture) Alice replies to it", s, 200);
  const CASC_C = casc_c.id ?? null;
  [s] = await api("DELETE", `/api/collections/comments/records/${CASC_P}`, alice);
  check("Alice deletes the parent → 204", s, 204);
  [s] = await api("GET", `/api/collections/comments/records/${CASC_C}`, su);
  check("the reply died with it → 404 (cascadeDelete on comments.parent is LIVE)", s, 404);

  let f_com: any;
  [s, f_com] = await api("POST", "/api/collections/comments/records", carol, {
    task: FOREIGN_TASK,
    body: "O-foreign-comment",
  });
  check("(fixture) Carol comments on her own task, in her own workspace", s, 200);
  const FOREIGN_COMMENT = f_com.id ?? null;

  let o_c: any;
  [s, o_c] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK1,
    body: "O-victim",
  });
  check("(fixture) Bob creates O_C on TASK1 (inside Alice's workspace)", s, 200);
  const O_C = o_c.id ?? null;
  check("victim fixture: stored parent is EMPTY", o_c.parent, "");

  [s, pl_c] = await api("POST", "/api/collections/comments/records", bob, {
    task: PL_TASK,
    body: "O-projectless-victim",
  });
  check("(fixture) Bob creates PL_C on the PROJECT-LESS task", s, 200);
  PL_C = pl_c.id ?? null;

  // The loop below leans on admin/member/viewer callers: re-read the tiers here, or a
  // caller who lost membership would answer with the same 404 and prove nothing.
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);
  for (const [who, token] of [
    ["Bob (author)", bob],
    ["Alice (workspace owner)", alice],
    ["Dave (workspace admin)", dave],
  ]) {
    [s] = await api("GET", `/api/collections/comments/records/${FOREIGN_COMMENT}`, token);
    check(`control: ${who} views the foreign comment → 404`, s, 404);
  }

  async function parent_unchanged(
    cid: string,
    label: string,
    after_what: string,
    want = "",
  ): Promise<void> {
    const [, rec] = await api("GET", `/api/collections/comments/records/${cid}`, su);
    const got = rec.parent;
    check(
      `read-back (superuser): ${label}.parent still ${py_repr(want)} after ${after_what}`,
      got,
      want,
    );
    // restore on drift so one leaked arm cannot mask the arms after it
    if (got !== want) {
      await api("PATCH", `/api/collections/comments/records/${cid}`, su, { parent: want });
    }
  }

  // The loop below leans on admin/member/viewer callers: re-read the tiers here, or a
  // caller who lost membership would answer with the same 404 and prove nothing.
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);
  for (const [who, token] of [
    ["Bob (author)", bob],
    ["Alice (workspace owner)", alice],
    ["Dave (workspace admin)", dave],
    ["Erin (plain member)", erin],
    ["Frank (viewer)", frank],
    ["Carol (outsider, owns the foreign tenant)", carol],
    ["anon", null],
  ] as [string, string | null][]) {
    [s] = await api("PATCH", `/api/collections/comments/records/${O_C}`, token, {
      parent: FOREIGN_COMMENT,
    });
    check(`${who} repoints comment.parent onto Carol's thread → 404`, s, 404);
    await parent_unchanged(O_C, "O_C", `the ${who} attempt`);
  }

  // The fix traverses NO relation, so a comment whose task has no project — the shape
  // TASK-050 left without a task.project.workspace path — is covered identically.
  // The loop below leans on admin/member/viewer callers: re-read the tiers here, or a
  // caller who lost membership would answer with the same 404 and prove nothing.
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);
  for (const [who, token] of [
    ["Bob (author)", bob],
    ["Alice (workspace owner)", alice],
    ["Dave (workspace admin)", dave],
  ]) {
    [s] = await api("PATCH", `/api/collections/comments/records/${PL_C}`, token, {
      parent: FOREIGN_COMMENT,
    });
    check(`${who} repoints PROJECT-LESS comment.parent onto Carol's thread → 404`, s, 404);
    await parent_unchanged(PL_C, "PL_C", `the ${who} attempt`);
  }

  let sib: any;
  [s, sib] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    body: "O-sibling-top-level",
  });
  check("(fixture) Alice creates a same-task top-level sibling", s, 200);
  const SIB = sib.id ?? null;
  [s] = await api("PATCH", `/api/collections/comments/records/${O_C}`, bob, { parent: SIB });
  check("Bob (author) re-points parent to a SAME-task comment → 404 (blanket lock)", s, 404);
  await parent_unchanged(O_C, "O_C", "the same-workspace re-point attempt");

  // A superuser bypasses collection rules, so the rule tier alone would let the graft
  // through — the universal-tier hook is what refuses it, and it is the same guard that
  // covers a programmatic e.app.save() (no *Request hook fires for those).
  // COVERS: hook:scope.pb.js#onRecordUpdate:comments
  [s] = await api("PATCH", `/api/collections/comments/records/${O_C}`, su, {
    parent: FOREIGN_COMMENT,
  });
  check("superuser repoints parent onto Carol's thread → 400 (HOOK tier, no bypass)", s, 400);
  await parent_unchanged(O_C, "O_C", "the superuser attempt");
  [s] = await api("PATCH", `/api/collections/comments/records/${PL_C}`, su, {
    parent: FOREIGN_COMMENT,
  });
  check("superuser repoints the PROJECT-LESS comment's parent → 400 (HOOK tier)", s, 400);
  await parent_unchanged(PL_C, "PL_C", "the superuser attempt");

  // The hook must refuse only what breaks the invariant: a coherent superuser re-parent
  // still lands, or the guard would be indistinguishable from a blanket failure.
  let hook_c: any;
  [s, hook_c] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    body: "O-hook-probe",
  });
  check("(fixture) Alice creates a comment for the hook-tier boundary probes", s, 200);
  const HOOK_C = hook_c.id ?? null;
  [s] = await api("PATCH", `/api/collections/comments/records/${HOOK_C}`, su, { parent: SIB });
  check("superuser parents it to a SAME-task top-level comment → 200", s, 200);
  await parent_unchanged(HOOK_C, "HOOK_C", "the coherent superuser re-parent", SIB);
  let reply_sib: any;
  [s, reply_sib] = await api("POST", "/api/collections/comments/records", alice, {
    task: TASK1,
    parent: SIB,
    body: "O-second-level",
  });
  check("(fixture) Alice replies to the sibling", s, 200);
  [s] = await api("PATCH", `/api/collections/comments/records/${HOOK_C}`, su, {
    parent: reply_sib.id ?? null,
  });
  check("superuser parents it to a REPLY → 400 (single-level invariant held on update)", s, 400);
  await parent_unchanged(HOOK_C, "HOOK_C", "the second-level attempt", SIB);
  [s] = await api("PATCH", `/api/collections/comments/records/${HOOK_C}`, su, {
    parent: "nonexistent0000",
  });
  check("superuser parents it to an unresolvable id → 400", s, 400);
  await parent_unchanged(HOOK_C, "HOOK_C", "the unresolvable-id attempt", SIB);
  [s] = await api("PATCH", `/api/collections/comments/records/${HOOK_C}`, su, { parent: "" });
  check("superuser CLEARS parent → 200 (unthreading is not a tenancy move)", s, 200);
  await parent_unchanged(HOOK_C, "HOOK_C", "the clear");

  // AC3 end to end. This victim is deliberately NOT restored after the graft attempt:
  // with the graft refused there is no edge for the cascade to travel, and pre-fix the
  // graft lands and Carol's delete destroys a comment she could never even read.
  let casc_v: any;
  [s, casc_v] = await api("POST", "/api/collections/comments/records", bob, {
    task: TASK1,
    body: "O-cascade-victim",
  });
  check("(fixture) Bob creates the cascade victim on TASK1", s, 200);
  const CASC_V = casc_v.id ?? null;
  [s] = await api("PATCH", `/api/collections/comments/records/${CASC_V}`, bob, {
    parent: FOREIGN_COMMENT,
  });
  check("Bob (author) grafts the cascade victim onto Carol's thread → 404", s, 404);
  [s] = await api("DELETE", `/api/collections/comments/records/${FOREIGN_COMMENT}`, carol);
  check("Carol deletes her own comment → 204", s, 204);
  [s, r] = await api("GET", `/api/collections/comments/records/${CASC_V}`, su);
  check(
    "the victim in Alice's workspace SURVIVED Carol's delete → 200",
    tup(s, r.body),
    tup(200, "O-cascade-victim"),
  );

  [s] = await api("PATCH", `/api/collections/comments/records/${O_C}`, bob, { body: "O-bob-edit" });
  check("Bob (author) edits body only (no parent key) → 200", s, 200);
  [s, r] = await api("GET", `/api/collections/comments/records/${O_C}`, alice);
  check("read-back: the body edit landed", r.body, "O-bob-edit");
  [s] = await api("PATCH", `/api/collections/comments/records/${O_C}`, erin, {
    reactions: { "🎯": [erin_id] },
  });
  check("Erin (plain member) reactions-only PATCH still → 200", s, 200);

  // COVERS: rule:comments.create, rule:comments.update
  // ══════════ P. at-most-one target, for the record's whole life (TASK-081) ══════════
  console.log("\n── (P) target count: no path may give a comment a second target ──");

  async function targets_of(cid: string, token: string | null = null) {
    const [s, rec] = await api("GET", `/api/collections/comments/records/${cid}`, token || su);
    return tup(s, tup(rec.task || "", rec.document || "", rec.decision || ""));
  }

  async function one_target(cid: string, label: string, after_what: string, want: any) {
    const [s, got] = await targets_of(cid);
    check(
      `read-back (superuser): ${label} still has exactly the one target after ${after_what}`,
      tup(s, got),
      tup(200, want),
    );
  }

  // COVERS: hook:scope.pb.js#onRecordCreate:comments
  // The rule tier already refuses a two-target CREATE (section A); the hook tier is what
  // answers a caller who bypasses rules entirely.
  [s] = await api("POST", "/api/collections/comments/records", su, {
    task: TASK1,
    document: DOCUMENT,
    author: bob_id,
    body: "P-su-two-create",
  });
  check("superuser creates a task+document comment → 400 (HOOK tier, no bypass)", s, 400);
  [s] = await api("POST", "/api/collections/comments/records", su, {
    task: TASK1,
    decision: DECISION,
    author: bob_id,
    body: "P-su-two-create-2",
  });
  check("superuser creates a task+decision comment → 400", s, 400);
  [s] = await api("POST", "/api/collections/comments/records", su, {
    document: DOCUMENT,
    decision: DECISION,
    author: bob_id,
    body: "P-su-two-create-3",
  });
  check("superuser creates a document+decision comment → 400", s, 400);
  [s] = await api("POST", "/api/collections/comments/records", su, {
    task: TASK1,
    document: DOCUMENT,
    decision: DECISION,
    author: bob_id,
    body: "P-su-three-create",
  });
  check("superuser creates a three-target comment → 400", s, 400);

  // AT MOST one, not EXACTLY one: the zero-target orphan (section M) keeps its only
  // construction, so the rules that deny every actor on it stay provable.
  let p_zero: any;
  [s, p_zero] = await api("POST", "/api/collections/comments/records", su, {
    author: bob_id,
    body: "P-su-zero-create",
  });
  check(
    "superuser creates a ZERO-target comment → 200 (deliberate: the guard is at-most-one)",
    s,
    200,
  );
  check(
    "that zero-target fixture really has no target",
    tup(p_zero.task, p_zero.document, p_zero.decision),
    tup("", "", ""),
  );

  let p_c: any;
  [s, p_c] = await api("POST", "/api/collections/comments/records", su, {
    task: TASK1,
    author: bob_id,
    body: "P-victim",
  });
  check("(fixture) superuser creates a single-target comment on TASK1", s, 200);
  const P_C = p_c.id ?? null;
  await one_target(P_C, "P_C", "its create", tup(TASK1, "", ""));

  // The production symptom: pre-fix this PATCH answered 200 and the row kept BOTH.
  [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, su, { document: DOCUMENT });
  check("superuser PATCHes a SECOND target (document) onto it → 400", s, 400);
  await one_target(P_C, "P_C", "the superuser .document injection", tup(TASK1, "", ""));
  [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, su, { decision: DECISION });
  check("superuser PATCHes a SECOND target (decision) onto it → 400", s, 400);
  await one_target(P_C, "P_C", "the superuser .decision injection", tup(TASK1, "", ""));
  [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, su, {
    document: DOCUMENT,
    decision: DECISION,
  });
  check("superuser PATCHes TWO more targets onto it at once → 400", s, 400);
  await one_target(P_C, "P_C", "the superuser two-at-once injection", tup(TASK1, "", ""));

  // A document-targeted comment is the mirror arm — the guard counts fields, it does not
  // privilege the task path.
  let p_doc: any;
  [s, p_doc] = await api("POST", "/api/collections/comments/records", su, {
    document: DOCUMENT,
    author: bob_id,
    body: "P-doc-victim",
  });
  check("(fixture) superuser creates a document-targeted comment", s, 200);
  const P_DOC = p_doc.id ?? null;
  [s] = await api("PATCH", `/api/collections/comments/records/${P_DOC}`, su, { task: TASK1 });
  check("superuser PATCHes .task onto a document comment → 400", s, 400);
  await one_target(P_DOC, "P_DOC", "the superuser .task injection", tup("", DOCUMENT, ""));

  // Traverses no relation, so the project-less task (TASK-050's shape) is covered identically.
  let p_pl: any;
  [s, p_pl] = await api("POST", "/api/collections/comments/records", su, {
    task: PL_TASK,
    author: bob_id,
    body: "P-projectless-victim",
  });
  check("(fixture) superuser creates a comment on the PROJECT-LESS task", s, 200);
  const P_PL = p_pl.id ?? null;
  [s] = await api("PATCH", `/api/collections/comments/records/${P_PL}`, su, { document: DOCUMENT });
  check("superuser PATCHes a second target onto the PROJECT-LESS comment → 400", s, 400);
  await one_target(P_PL, "P_PL", "the superuser injection", tup(PL_TASK, "", ""));

  // The tenant half of "no path": the rule tier refuses the request outright, on every role.
  // The loop below leans on admin/member/viewer callers: re-read the tiers here, or a
  // caller who lost membership would answer with the same 404 and prove nothing.
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);
  for (const [who, token] of [
    ["Bob (author)", bob],
    ["Alice (workspace owner)", alice],
    ["Dave (workspace admin)", dave],
    ["Erin (plain member)", erin],
    ["Frank (viewer)", frank],
    ["Carol (outsider)", carol],
    ["anon", null],
  ] as [string, string | null][]) {
    [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, token, {
      document: DOCUMENT,
    });
    check(`${who} PATCHes a second target onto it → 404 (rule field-lock)`, s, 404);
    await one_target(P_C, "P_C", `the ${who} attempt`, tup(TASK1, "", ""));
  }

  // The guard must refuse only what breaks the invariant, or it would be indistinguishable
  // from a blanket failure on every comments write.
  [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, su, { task: TASK2 });
  check("superuser MOVES the single target task→TASK2 → 200 (count never exceeds one)", s, 200);
  await one_target(P_C, "P_C", "the single-target move", tup(TASK2, "", ""));
  [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, su, {
    task: "",
    document: DOCUMENT,
  });
  check("superuser SWAPS the target task→document in one PATCH → 200", s, 200);
  await one_target(P_C, "P_C", "the target swap", tup("", DOCUMENT, ""));
  [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, su, { body: "P-su-body" });
  check("superuser edits body only → 200 (no target key, guard idle)", s, 200);
  [s] = await api("PATCH", `/api/collections/comments/records/${P_C}`, su, { document: "" });
  check("superuser CLEARS the last target → 200 (at-most-one permits zero)", s, 200);
  await one_target(P_C, "P_C", "the clear", tup("", "", ""));

  [s] = await api("PATCH", `/api/collections/comments/records/${P_PL}`, bob, {
    body: "P-bob-edit",
  });
  check("Bob (author) edits body on a single-target comment → 200 (guard idle)", s, 200);
  [s] = await api("PATCH", `/api/collections/comments/records/${P_PL}`, erin, {
    reactions: { "🚀": [erin_id] },
  });
  check("Erin (plain member) reactions-only PATCH → 200 (guard idle)", s, 200);

  // COVERS: rule:comments.list, rule:comments.view
  // ══════════════════ R. a trashed parent takes its comments with it ══════════
  console.log(
    "\n── (R) trashed parent / parent's project / parent's workspace: the comment ROW goes ──",
  );
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);
  const R_OWNS = await tierkit.owner_of_workspace(ALICE_WS, alice_id, su, "Alice");

  const R_TS = "2026-01-01 00:00:00.000Z";
  // (comment relation field, parent collection, the extra body keys that collection needs)
  const R_PARENTS: [string, string, Record<string, any>][] = [
    ["task", "tasks", {}],
    ["document", "documents", { author: alice_id, draft: false }],
    ["decision", "decisions", { author: alice_id, draft: false }],
  ];
  const R_READERS: [string, string][] = [
    ["Alice (workspace owner)", alice],
    ["Dave (admin)", dave],
    ["Erin (member)", erin],
    ["Frank (viewer)", frank],
  ];

  async function r_project(workspace: string, marker: string): Promise<string> {
    const [s, rec] = await api("POST", "/api/collections/projects/records", su, {
      name: marker,
      owner: alice_id,
      workspace: workspace,
    });
    check(`(fixture) project ${marker}`, s, 200);
    return rec.id ?? null;
  }

  async function r_parent(
    coll: string,
    extra: Record<string, any>,
    workspace: string,
    project: string,
    marker: string,
  ): Promise<string> {
    const body = { title: marker, workspace: workspace, project: project, ...extra };
    const [s, rec] = await api("POST", `/api/collections/${coll}/records`, su, body);
    check(`(fixture) ${coll} ${marker}`, s, 200);
    return rec.id ?? null;
  }

  async function r_comment(rel: string, parent_id: string, marker: string): Promise<string> {
    const [s, rec] = await api("POST", "/api/collections/comments/records", su, {
      [rel]: parent_id,
      author: alice_id,
      body: marker,
    });
    check(`(fixture) comment ${marker}`, s, 200);
    return rec.id ?? null;
  }

  async function r_trash(coll: string, rid: string, marker: string, value: string): Promise<void> {
    const [s] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, su, {
      trashed: value,
    });
    check(`(fixture) ${coll} ${marker} trashed=${py_repr(value)}`, s, 200);
  }

  async function r_leg(
    label: string,
    cid: string,
    rel: string,
    parent_id: string,
    hidden: boolean,
  ): Promise<void> {
    // Each parent carries exactly one comment, so the filtered list length IS that comment.
    const want = hidden ? tup(0, 404) : tup(1, 200);
    for (const [who, tok] of R_READERS) {
      const items = await find_by_filter("comments", `${rel}='${parent_id}'`, tok);
      const [s] = await api("GET", `/api/collections/comments/records/${cid}`, tok);
      check(`${label} — ${who}`, tup(items.length, s), want);
    }
  }

  console.log("\n── (R1) the parent task / document / decision itself is trashed ──");
  const R_PROJECT = await r_project(ALICE_WS, "R-live-project");
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, ALICE_WS, R_PROJECT, `R-${rel}-parent`);
    const cid = await r_comment(rel, pid, `R-${rel}-parent-comment`);
    await r_leg(`live ${coll}: comment readable`, cid, rel, pid, false);
    await r_trash(coll, pid, `R-${rel}-parent`, R_TS);
    await r_leg(`TRASHED ${coll}: comment gone`, cid, rel, pid, true);
    await r_trash(coll, pid, `R-${rel}-parent`, "");
    await r_leg(`untrashed ${coll}: comment back`, cid, rel, pid, false);
  }

  console.log("\n── (R2) the parent's PROJECT is trashed ──");
  const P_PROJECT = await r_project(ALICE_WS, "R-trashable-project");
  const P_ROWS: [string, string, string, string][] = [];
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, ALICE_WS, P_PROJECT, `R-${rel}-in-project`);
    P_ROWS.push([rel, coll, pid, await r_comment(rel, pid, `R-${rel}-in-project-comment`)]);
  }
  for (const [rel, coll, pid, cid] of P_ROWS) {
    await r_leg(`live project + live ${coll}: comment readable`, cid, rel, pid, false);
  }
  await r_trash("projects", P_PROJECT, "R-trashable-project", R_TS);
  for (const [rel, coll, pid, cid] of P_ROWS) {
    await r_leg(`TRASHED project of the ${coll}: comment gone`, cid, rel, pid, true);
  }
  await r_trash("projects", P_PROJECT, "R-trashable-project", "");
  for (const [rel, coll, pid, cid] of P_ROWS) {
    await r_leg(`untrashed project of the ${coll}: comment back`, cid, rel, pid, false);
  }

  console.log("\n── (R3) the parent's WORKSPACE is trashed ──");
  let ws_t: any;
  [s, ws_t] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "R-trashable-workspace",
    owner: alice_id,
  });
  check("(fixture) superuser creates the trashable workspace", s, 200);
  const WS_T = ws_t.id ?? null;
  const W_TIER: tierkit.Tier[] = [];
  for (const [uid, role, who] of [
    [dave_id, "admin", "Dave"],
    [erin_id, "member", "Erin"],
    [frank_id, "viewer", "Frank"],
  ]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS_T,
      user: uid,
      role: role,
      status: "active",
    });
    check(`(fixture) ${who} joins the trashable workspace as ${role}`, s, 200);
    W_TIER.push(await tierkit.actor_at_tier(WS_T, uid, role, su, who));
  }
  const W_OWNS = await tierkit.owner_of_workspace(WS_T, alice_id, su, "Alice");
  const W_PROJECT = await r_project(WS_T, "R-workspace-project");
  const W_ROWS: [string, string, string, string][] = [];
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, WS_T, W_PROJECT, `R-${rel}-in-workspace`);
    W_ROWS.push([rel, coll, pid, await r_comment(rel, pid, `R-${rel}-in-workspace-comment`)]);
  }
  for (const [rel, coll, pid, cid] of W_ROWS) {
    await r_leg(`live workspace + live ${coll}: comment readable`, cid, rel, pid, false);
  }
  await r_trash("workspaces", WS_T, "R-trashable-workspace", R_TS);
  for (const [rel, coll, pid, cid] of W_ROWS) {
    await r_leg(`TRASHED workspace of the ${coll}: comment gone`, cid, rel, pid, true);
  }
  // Read while the workspace is still trashed: a membership that dissolved would answer these
  // denials with the same 404 the trash narrowing owes.
  const w_now: string[] = [];
  for (const t of W_TIER) w_now.push(await t.now());
  check(
    "  ↳ Dave/Erin/Frank still hold admin/member/viewer IN the trashed workspace",
    tup(...w_now),
    TIERS,
  );
  check("  ↳ Alice still owns the trashed workspace", await W_OWNS.now(), alice_id);
  await r_trash("workspaces", WS_T, "R-trashable-workspace", "");
  for (const [rel, coll, pid, cid] of W_ROWS) {
    await r_leg(`untrashed workspace of the ${coll}: comment back`, cid, rel, pid, false);
  }

  for (const t of W_TIER) {
    await t.done();
  }
  await W_OWNS.done();
  await R_OWNS.done();

  // COVERS: rule:comments.create, rule:comments.update, rule:comments.delete
  // ══════════════════ S. a hidden parent FREEZES its thread for writes ════════
  console.log(
    "\n── (S) trashed parent / parent's project / parent's workspace: the thread FREEZES ──",
  );
  const S_TS = "2026-02-02 00:00:00.000Z";
  const S_OWNS = await tierkit.owner_of_workspace(ALICE_WS, alice_id, su, "Alice");
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);

  // Erin authors every update target, so "the author" is a tier apart from owner and admin.
  const S_WRITERS: [string, string][] = [
    ["Alice (workspace owner)", alice],
    ["Dave (admin)", dave],
    ["Erin (plain member)", erin],
  ];
  const S_UPDATERS: [string, string][] = [
    ["Erin (the author)", erin],
    ["Alice (workspace owner)", alice],
    ["Dave (admin)", dave],
  ];
  const S_DELETERS = S_UPDATERS;
  // Already refused before this change by `role ?!= "viewer"` / no membership at all: these
  // rows are CONTROLS, not proofs of the trash traversal.
  const S_REFUSED: [string, string][] = [
    ["Frank (viewer)", frank],
    ["Carol (non-member)", carol],
  ];
  // The `untrashed …: allowed` rows below are controls: removing the migration leaves them green
  // (everything is allowed without it), so they catch a clause that never lets the write back
  // rather than proving the narrowing itself.
  const S_SEQ = [0];

  function s_body(kind: string): string {
    S_SEQ[0] += 1;
    return `S-${kind}-${S_SEQ[0]}`;
  }

  async function s_target(rel: string, parent_id: string, marker: string): Promise<string> {
    const [s, rec] = await api("POST", "/api/collections/comments/records", su, {
      [rel]: parent_id,
      author: erin_id,
      body: marker,
    });
    check(`(fixture) comment ${marker} authored by Erin`, s, 200);
    return rec.id ?? null;
  }

  async function s_create(
    label: string,
    rel: string,
    parent_id: string,
    hidden: boolean,
    writers = S_WRITERS,
  ): Promise<void> {
    const want = hidden ? 400 : 200;
    for (const [who, tok] of writers) {
      const [s] = await api("POST", "/api/collections/comments/records", tok, {
        [rel]: parent_id,
        body: s_body("create"),
      });
      check(`${label} — ${who} POSTs a comment`, s, want);
    }
  }

  async function s_update(
    label: string,
    cid: string,
    hidden: boolean,
    updaters = S_UPDATERS,
  ): Promise<void> {
    const want = hidden ? 404 : 200;
    for (const [who, tok] of updaters) {
      const [s] = await api("PATCH", `/api/collections/comments/records/${cid}`, tok, {
        body: s_body("edit"),
      });
      check(`${label} — ${who} PATCHes body`, s, want);
    }
  }

  async function s_delete(
    label: string,
    rel: string,
    parent_id: string,
    hidden: boolean,
    deleters = S_DELETERS,
  ): Promise<void> {
    // A DELETE that lands purges the row, so every deleter gets a freshly minted target; the
    // read-back is the assertion that matters — a 404 the row did not survive is a purge.
    const want = hidden ? tup(404, 200) : tup(204, 404);
    for (const [who, tok] of deleters) {
      const cid = await s_target(rel, parent_id, s_body("del"));
      const [s] = await api("DELETE", `/api/collections/comments/records/${cid}`, tok);
      const [back] = await api("GET", `/api/collections/comments/records/${cid}`, su);
      check(`${label} — ${who} DELETEs, then the row is read back`, tup(s, back), want);
    }
  }

  async function s_already_refused(
    label: string,
    rel: string,
    parent_id: string,
    cid: string,
  ): Promise<void> {
    for (const [who, tok] of S_REFUSED) {
      let [s] = await api("POST", "/api/collections/comments/records", tok, {
        [rel]: parent_id,
        body: s_body("refused"),
      });
      check(`${label} — ${who} POSTs → 400 (control, refused before this change)`, s, 400);
      [s] = await api("PATCH", `/api/collections/comments/records/${cid}`, tok, {
        body: s_body("refused"),
      });
      check(`${label} — ${who} PATCHes → 404 (control, refused before this change)`, s, 404);
      const dcid = await s_target(rel, parent_id, s_body("refused-del"));
      [s] = await api("DELETE", `/api/collections/comments/records/${dcid}`, tok);
      const [back] = await api("GET", `/api/collections/comments/records/${dcid}`, su);
      check(
        `${label} — ${who} DELETEs → 404, row survives (control, refused before this change)`,
        tup(s, back),
        tup(404, 200),
      );
    }
  }

  // ── (S0) the controls a too-wide clause would break, re-run inside every hide ──
  console.log("\n── (S0) controls: live parent, project-less parent, suspended assignee ──");
  const S_PROJECT = await r_project(ALICE_WS, "S-live-project");
  const S_CTRL: [string, string, string, string][] = [];
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, ALICE_WS, S_PROJECT, `S-${rel}-live`);
    S_CTRL.push([
      rel,
      `live ${coll} in a live project`,
      pid,
      await s_target(rel, pid, `S-${rel}-live-c`),
    ]);
  }
  // Since decision:shadow-project a parent submitted with no project lands in the workspace's invisible
  // container, a live project no tenant can read: this parent proves the traversal still
  // reaches a thread whose project the writer cannot see.
  const [, shadow] = await api(
    "GET",
    "/api/collections/projects/records?" +
      urlencode({ perPage: 1, filter: `workspace='${ALICE_WS}' && shadow=true` }),
    su,
  );
  const S_SHADOW: string = (shadow.items?.length ? shadow.items : [{}])[0].id ?? "";
  check("(fixture) the workspace owns one invisible container", truthy(S_SHADOW), true);
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, ALICE_WS, "", `S-${rel}-projectless`);
    const [, back] = await api("GET", `/api/collections/${coll}/records/${pid}`, su);
    check(`(fixture) ${coll} S-${rel}-projectless lands in the container`, back.project, S_SHADOW);
    S_CTRL.push([
      rel,
      `PROJECT-LESS ${coll}`,
      pid,
      await s_target(rel, pid, `S-${rel}-projectless-c`),
    ]);
  }

  const hana_id = await su_create_user("Hana", "hana@example.com");
  let hana_row: any;
  [s, hana_row] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: ALICE_WS,
    user: hana_id,
    role: "member",
    status: "active",
  });
  check("(fixture) Hana joins Alice's workspace as an active member", s, 200);
  const HANA_ROW = hana_row.id ?? null;
  const S_ASSIGNED = await r_parent("tasks", {}, ALICE_WS, S_PROJECT, "S-assignee-only-task");
  [s] = await api("PATCH", `/api/collections/tasks/records/${S_ASSIGNED}`, su, {
    assignee: hana_id,
  });
  check("(fixture) superuser assigns that task to Hana", s, 200);
  [, r] = await api("GET", `/api/collections/tasks/records/${S_ASSIGNED}`, su);
  check("(fixture) read-back: the stored assignee is Hana", r.assignee, hana_id);
  // pb_hooks/main.pb.js refuses assigning a task to anyone who is not an ACTIVE member, so the
  // suspended-assignee standing is reached by suspending the membership AFTER the assignment.
  [s] = await api("PATCH", `/api/collections/workspace_members/records/${HANA_ROW}`, su, {
    status: "suspended",
  });
  check("(fixture) superuser suspends Hana's membership", s, 200);
  const HANA_TIER = await tierkit.actor_at_tier(
    ALICE_WS,
    hana_id,
    "member",
    su,
    "Hana",
    "suspended",
  );
  const [hana] = await login("hana@example.com");

  async function s_controls(phase: string): Promise<void> {
    for (const [rel, shape, pid, cid] of S_CTRL) {
      await s_create(`CONTROL during ${phase}: ${shape}`, rel, pid, false);
      await s_update(`CONTROL during ${phase}: ${shape}`, cid, false);
      await s_delete(`CONTROL during ${phase}: ${shape}`, rel, pid, false);
    }
    // decision:active-membership-grants-access: an assignment alone grants no write in any phase.
    const [s] = await api("POST", "/api/collections/comments/records", hana, {
      task: S_ASSIGNED,
      body: s_body("hana"),
    });
    check(
      `CONTROL during ${phase}: suspended assignee Hana POSTs on her live task (refused)`,
      tup(tup(...(await HANA_TIER.standing())), s),
      tup(tup("member", "suspended"), 400),
    );
  }

  console.log("\n── (S1) the parent task / document / decision itself is trashed ──");
  const S1_PROJECT = await r_project(ALICE_WS, "S1-live-project");
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, ALICE_WS, S1_PROJECT, `S1-${rel}-parent`);
    const cid = await s_target(rel, pid, `S1-${rel}-parent-c`);
    await r_trash(coll, pid, `S1-${rel}-parent`, S_TS);
    await s_create(`TRASHED ${coll}: create refused`, rel, pid, true);
    await s_update(`TRASHED ${coll}: edit not found`, cid, true);
    await s_delete(`TRASHED ${coll}: delete not found`, rel, pid, true);
    await s_already_refused(`TRASHED ${coll}`, rel, pid, cid);
    await s_controls(`a trashed ${coll}`);
    await r_trash(coll, pid, `S1-${rel}-parent`, "");
    await s_create(
      `untrashed ${coll}: create allowed (control, green before this change too)`,
      rel,
      pid,
      false,
    );
    await s_update(
      `untrashed ${coll}: edit allowed (control, green before this change too)`,
      cid,
      false,
    );
    await s_delete(
      `untrashed ${coll}: delete allowed (control, green before this change too)`,
      rel,
      pid,
      false,
    );
  }

  console.log("\n── (S2) the parent's PROJECT is trashed ──");
  const S2_PROJECT = await r_project(ALICE_WS, "S2-trashable-project");
  const S2_ROWS: [string, string, string, string][] = [];
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, ALICE_WS, S2_PROJECT, `S2-${rel}-in-project`);
    S2_ROWS.push([rel, coll, pid, await s_target(rel, pid, `S2-${rel}-in-project-c`)]);
  }
  await r_trash("projects", S2_PROJECT, "S2-trashable-project", S_TS);
  for (const [rel, coll, pid, cid] of S2_ROWS) {
    await s_create(`TRASHED project of the ${coll}: create refused`, rel, pid, true);
    await s_update(`TRASHED project of the ${coll}: edit not found`, cid, true);
    await s_delete(`TRASHED project of the ${coll}: delete not found`, rel, pid, true);
    await s_already_refused(`TRASHED project of the ${coll}`, rel, pid, cid);
  }
  await s_controls("a trashed project");
  await r_trash("projects", S2_PROJECT, "S2-trashable-project", "");
  for (const [rel, coll, pid, cid] of S2_ROWS) {
    await s_create(
      `untrashed project of the ${coll}: create allowed (control, green before this change too)`,
      rel,
      pid,
      false,
    );
    await s_update(
      `untrashed project of the ${coll}: edit allowed (control, green before this change too)`,
      cid,
      false,
    );
    await s_delete(
      `untrashed project of the ${coll}: delete allowed (control, green before this change too)`,
      rel,
      pid,
      false,
    );
  }

  console.log("\n── (S3) the parent's WORKSPACE is trashed ──");
  // WS_T came back untrashed at the end of (R3); its tiers are re-established because a
  // dissolved membership would answer these refusals with the same status the rule owes.
  const S3_TIER: tierkit.Tier[] = [];
  for (const [uid, role, who] of [
    [dave_id, "admin", "Dave"],
    [erin_id, "member", "Erin"],
    [frank_id, "viewer", "Frank"],
  ]) {
    S3_TIER.push(await tierkit.actor_at_tier(WS_T, uid, role, su, who));
  }
  const S3_OWNS = await tierkit.owner_of_workspace(WS_T, alice_id, su, "Alice");
  const S3_PROJECT = await r_project(WS_T, "S3-workspace-project");
  const S3_ROWS: [string, string, string, string][] = [];
  for (const [rel, coll, extra] of R_PARENTS) {
    const pid = await r_parent(coll, extra, WS_T, S3_PROJECT, `S3-${rel}-in-workspace`);
    S3_ROWS.push([rel, coll, pid, await s_target(rel, pid, `S3-${rel}-in-workspace-c`)]);
  }
  await r_trash("workspaces", WS_T, "S3-trashable-workspace", S_TS);
  for (const [rel, coll, pid, cid] of S3_ROWS) {
    await s_create(`TRASHED workspace of the ${coll}: create refused`, rel, pid, true);
    await s_update(`TRASHED workspace of the ${coll}: edit not found`, cid, true);
    await s_delete(`TRASHED workspace of the ${coll}: delete not found`, rel, pid, true);
    await s_already_refused(`TRASHED workspace of the ${coll}`, rel, pid, cid);
  }
  const s3_now: string[] = [];
  for (const t of S3_TIER) s3_now.push(await t.now());
  check(
    "  ↳ Dave/Erin/Frank still hold admin/member/viewer IN the trashed workspace",
    tup(...s3_now),
    TIERS,
  );
  check("  ↳ Alice still owns the trashed workspace", await S3_OWNS.now(), alice_id);
  await s_controls("a trashed workspace");
  await r_trash("workspaces", WS_T, "S3-trashable-workspace", "");
  for (const [rel, coll, pid, cid] of S3_ROWS) {
    await s_create(
      `untrashed workspace of the ${coll}: create allowed (control, green before this change too)`,
      rel,
      pid,
      false,
    );
    await s_update(
      `untrashed workspace of the ${coll}: edit allowed (control, green before this change too)`,
      cid,
      false,
    );
    await s_delete(
      `untrashed workspace of the ${coll}: delete allowed (control, green before this change too)`,
      rel,
      pid,
      false,
    );
  }

  for (const t of S3_TIER) {
    await t.done();
  }
  await S3_OWNS.done();

  // ── (S4) the write shapes S1-S3 do not exercise, under a TWO-LEVEL hide ──
  console.log(
    "\n── (S4) threaded reply, reactions-only PATCH and /api/batch under a two-level hide ──",
  );
  check("  ↳ Dave/Erin/Frank still hold admin/member/viewer", await tiers_now(), TIERS);
  const S4_REACTORS: [string, string, string][] = [
    ["Erin (the author)", erin, erin_id],
    ["Alice (workspace owner)", alice, alice_id],
    ["Dave (admin)", dave, dave_id],
  ];
  const S4_PROJECT = await r_project(ALICE_WS, "S4-two-level-project");
  const S4_TASK = await r_parent("tasks", {}, ALICE_WS, S4_PROJECT, "S4-two-level-task");
  const S4_ROOT = await s_target("task", S4_TASK, "S4-thread-root-c");

  async function s_reply(label: string, hidden: boolean, writers = S_WRITERS): Promise<void> {
    const want = hidden ? 400 : 200;
    for (const [who, tok] of writers) {
      const [s] = await api("POST", "/api/collections/comments/records", tok, {
        task: S4_TASK,
        parent: S4_ROOT,
        body: s_body("reply"),
      });
      check(`${label} — ${who} replies under the thread root`, s, want);
    }
  }

  async function s_react(label: string, hidden: boolean): Promise<void> {
    // Each reactor gets its own target: reactions is a whole-object replace and the own-id-only
    // guard refuses a payload that drops another user's id.
    const want = hidden ? 404 : 200;
    for (const [who, tok, uid] of S4_REACTORS) {
      const cid = await s_target("task", S4_TASK, s_body("react"));
      const [s] = await api("PATCH", `/api/collections/comments/records/${cid}`, tok, {
        reactions: { "👍": [uid] },
      });
      check(`${label} — ${who} PATCHes reactions ONLY`, s, want);
    }
  }

  async function s_batch(
    label: string,
    build: (tok: string) => Promise<any[]> | any[],
    expected: any,
    actors = S_UPDATERS,
  ): Promise<void> {
    // /api/batch is one transaction: a refused op rolls the whole call back with an outer 400
    // and reports the status its own rule answered nested under data.requests.
    for (const [who, tok] of actors) {
      const [s, r] = await api("POST", "/api/batch", tok, { requests: await build(tok) });
      let inner: any;
      if (Array.isArray(r)) {
        inner = tup(...r.map((item: any) => item.status));
      } else {
        const reqs = r.data?.requests || {};
        inner = tup(
          ...Object.keys(reqs)
            .sort(by_code_point)
            .map((k) => (reqs[k].response ?? {}).status),
        );
      }
      check(`${label} — ${who}`, tup(s, inner), expected);
    }
  }

  function s_batch_write(_tok: string): any[] {
    return [
      {
        method: "POST",
        url: "/api/collections/comments/records",
        body: { task: S4_TASK, body: s_body("batch-create") },
      },
      {
        method: "PATCH",
        url: `/api/collections/comments/records/${S4_ROOT}`,
        body: { body: s_body("batch-edit") },
      },
    ];
  }

  function s_batch_create(_tok: string): any[] {
    return [
      {
        method: "POST",
        url: "/api/collections/comments/records",
        body: { task: S4_TASK, body: s_body("batch-create") },
      },
    ];
  }

  function s_batch_update(_tok: string): any[] {
    return [
      {
        method: "PATCH",
        url: `/api/collections/comments/records/${S4_ROOT}`,
        body: { body: s_body("batch-edit") },
      },
    ];
  }

  async function s_batch_delete(_tok: string): Promise<any[]> {
    return [
      {
        method: "DELETE",
        url:
          "/api/collections/comments/records/" +
          (await s_target("task", S4_TASK, s_body("batch-del"))),
      },
    ];
  }

  await s_reply("live task in a live project: reply allowed (control)", false);
  await s_react("live task in a live project: reactions allowed (control)", false);
  await s_batch("live task: batch create+update (control)", s_batch_write, tup(200, tup(200, 200)));
  await s_batch("live task: batch delete (control)", s_batch_delete, tup(200, tup(204)));

  await r_trash("projects", S4_PROJECT, "S4-two-level-project", S_TS);
  await r_trash("tasks", S4_TASK, "S4-two-level-task", S_TS);
  const [, s4_back] = await api("GET", `/api/collections/tasks/records/${S4_TASK}`, su);
  const [, s4_proj] = await api("GET", `/api/collections/projects/records/${S4_PROJECT}`, su);
  check(
    "(fixture) both levels are hidden at once: task AND its project trashed",
    tup(truthy(s4_back.trashed), truthy(s4_proj.trashed)),
    tup(true, true),
  );

  await s_reply("TWO-LEVEL hide: reply refused", true);
  await s_reply("TWO-LEVEL hide: reply refused", true, S_REFUSED);
  await s_react("TWO-LEVEL hide: reactions-only PATCH not found", true);
  await s_batch("TWO-LEVEL hide: batch create refused", s_batch_create, tup(400, tup(400)));
  await s_batch("TWO-LEVEL hide: batch update not found", s_batch_update, tup(400, tup(404)));
  await s_batch("TWO-LEVEL hide: batch delete not found", s_batch_delete, tup(400, tup(404)));
  await s_create("TWO-LEVEL hide: create refused", "task", S4_TASK, true);
  await s_update("TWO-LEVEL hide: edit not found", S4_ROOT, true);
  await s_delete("TWO-LEVEL hide: delete not found", "task", S4_TASK, true);
  await s_controls("a two-level hide");

  // Project first: pb_hooks/trash.pb.js refuses restoring an item whose project is still trashed.
  await r_trash("projects", S4_PROJECT, "S4-two-level-project", "");
  await r_trash("tasks", S4_TASK, "S4-two-level-task", "");
  await s_reply("both levels restored: reply allowed again", false);
  await s_react("both levels restored: reactions allowed again", false);
  await s_batch(
    "both levels restored: batch create+update",
    s_batch_write,
    tup(200, tup(200, 200)),
  );
  await s_batch("both levels restored: batch delete", s_batch_delete, tup(200, tup(204)));

  await HANA_TIER.done();
  await S_OWNS.done();

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
  console.log("✅ all comments proofs passed");
  process.exit(0);
}

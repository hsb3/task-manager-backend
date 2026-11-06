#!/usr/bin/env bun
/**E2E proof of the wave-23 rules matrix for `documents` (#60):
list/view/create/update owner-or-member, delete owner-only.
`tasks.draft` (#59) was dropped (decision:cycle-rollover tent) — tasks carry no
draft concept.

Seed contract (scripts/seed.ts): Alice owns "Alice's Workspace" + project
"Website Redesign"; Bob is a non-owner member; Carol is a non-member.
 */

import * as roomkit from "./roomkit.ts";
import { esc } from "./suitekit.ts";
import { py_str, tup, urlencode, truthy } from "../scripts/_py.ts";

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;

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

async function login(email: string, retries = 5, delay = 0.4): Promise<[string, string]> {
  // The auth rate-limiter can trip on repeated logins across suites sharing
  // a room; retry a few times with a short sleep rather than fail outright.
  let r: any = {};
  for (let _ = 0; _ < retries; _++) {
    [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: "test123456",
    });
    if ("token" in r) return [r.token, r.record.id];
    await Bun.sleep(delay * 1000);
  }
  // token_of never returns here: every retry came back without a token.
  return [roomkit.token_of(PB, email, r), r.record.id];
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<string | null> {
  const filt = `${field}='${esc(value)}'`;
  const qs = urlencode({ filter: filt });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

const FAILS: string[] = [];

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`,
  );
}

function check_in(label: string, got: any, allowed: any[]): void {
  const ok = allowed.some((a) => Bun.deepEquals(got, a, true));
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(56)} → ${py_str(got)} (expected one of ${py_str(tup(...allowed))})`,
  );
}

const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");
const [carol, carol_id] = await login("carol@example.com");

const ALICE_WORKSPACE = await find_id("workspaces", "name", "Alice's Workspace", alice);
const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);

let s: number;
let r: any;

// ── documents: OWNER (Alice) full access ──
// COVERS: rule:documents.create, rule:documents.list, rule:documents.view, rule:documents.update
console.log("\n── DOCUMENTS: owner (Alice) create/list/view/update/delete ──");
let alice_doc: any;
[s, alice_doc] = await api("POST", "/api/collections/documents/records", alice, {
  title: "Alice's doc",
  body: "owner-authored",
  workspace: ALICE_WORKSPACE,
});
check_in("Alice (owner) creates a document", s, [200, 201]);
const alice_doc_id = alice_doc.id;
[s] = await api("GET", "/api/collections/documents/records", alice);
check("Alice (owner) lists documents", s, 200);
[s] = await api("GET", `/api/collections/documents/records/${alice_doc_id}`, alice);
check("Alice (owner) views her document", s, 200);
[s] = await api("PATCH", `/api/collections/documents/records/${alice_doc_id}`, alice, {
  body: "owner-authored, edited",
});
check("Alice (owner) updates her document", s, 200);

// ── documents: MEMBER (Bob) create/list/view(owner's doc)/update(own doc)/delete(denied) ──
// COVERS: rule:documents.create, rule:documents.list, rule:documents.view, rule:documents.update, rule:documents.delete
console.log("\n── DOCUMENTS: member (Bob) create/list/view/update; delete blocked ──");
let bob_doc: any;
[s, bob_doc] = await api("POST", "/api/collections/documents/records", bob, {
  title: "Bob's doc",
  body: "member-authored",
  workspace: ALICE_WORKSPACE,
});
check_in("Bob (member) creates a document", s, [200, 201]);
const bob_doc_id = bob_doc.id;
[s] = await api("GET", "/api/collections/documents/records", bob);
check("Bob (member) lists documents", s, 200);
[s] = await api("GET", `/api/collections/documents/records/${alice_doc_id}`, bob);
check("Bob (member) views Alice's (owner's) document", s, 200);
[s] = await api("PATCH", `/api/collections/documents/records/${bob_doc_id}`, bob, {
  body: "member-authored, edited",
});
check("Bob (member) updates his own document", s, 200);
// W3 (#66): member delete = trash (204), not owner-only-denied; purge stays owner/admin.
[s] = await api("DELETE", `/api/collections/documents/records/${bob_doc_id}`, bob);
check("Bob (member) deletes his own document → traps to trash (204, W3 #66)", s, 204);
// COVERS: hook:trash.pb.js#onRecordDeleteRequest:documents
[s, r] = await api("GET", `/api/collections/documents/records/${bob_doc_id}`, bob);
check("Bob's trashed document is 404 by id too (card htsr: viewRule mirrors listRule)", s, 404);
[s, r] = await api("GET", `/api/tracker/trash?workspace=${ALICE_WORKSPACE}`, bob);
const row = (r.items ?? []).find((i: any) => ((i.record ?? null) || {}).id === bob_doc_id) ?? {};
check(
  "the document survived the trap and reaches Bob through GET /api/tracker/trash",
  tup(s, truthy(((row.record ?? null) || {}).trashed)),
  tup(200, true),
);
[s, r] = await api("GET", "/api/collections/documents/records", bob);
check(
  "Bob's trashed document absent from his list",
  (r.items ?? []).map((i: any) => i.id).includes(bob_doc_id),
  false,
);

// ── documents: NON-MEMBER (Carol) list empty / view 404 / create 400 ──
// COVERS: rule:documents.list, rule:documents.view, rule:documents.create
console.log("\n── DOCUMENTS: non-member (Carol) filtered list / 404 view / 400 create ──");
[, r] = await api("GET", "/api/collections/documents/records", carol);
check("Carol (non-member) lists documents — filtered empty", r.items ?? null, []);
[s] = await api("GET", `/api/collections/documents/records/${alice_doc_id}`, carol);
check("Carol (non-member) views Alice's document by id", s, 404);
[s] = await api("POST", "/api/collections/documents/records", carol, {
  title: "Carol's doc",
  body: "should be blocked",
  workspace: ALICE_WORKSPACE,
});
check("Carol (non-member) creates a document (blocked)", s, 400);

// ── documents: owner deletes a member-created doc ──
console.log("\n── DOCUMENTS: owner (Alice) deletes Bob's (member-created) document ──");
[s] = await api("DELETE", `/api/collections/documents/records/${bob_doc_id}`, alice);
check("Alice (owner) deletes Bob's document", s, 204);

// ── author immutability (TASK-031): author cannot be repointed after create ──
// COVERS: hook:author.pb.js#onRecordUpdateRequest:decisions, hook:author.pb.js#onRecordUpdateRequest:documents, hook:author.pb.js#onRecordUpdateRequest:milestones
console.log("\n── AUTHOR IMMUTABILITY: decisions/documents/milestones reject a PATCH to author ──");

let bob_doc3: any;
[s, bob_doc3] = await api("POST", "/api/collections/documents/records", bob, {
  title: "Bob's third doc",
  body: "author-immutability probe",
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Bob creates a document (author-immutability probe)", s, [200, 201]);
const bob_doc3_id = bob_doc3.id;
check("setup: document author stamped to Bob at create", bob_doc3.author, bob_id);
[s] = await api("PATCH", `/api/collections/documents/records/${bob_doc3_id}`, bob, {
  author: alice_id,
});
check("Bob (author) cannot repoint document author to Alice", s, 400);
[s, r] = await api("GET", `/api/collections/documents/records/${bob_doc3_id}`, bob);
check("document author unchanged after rejected update", r.author, bob_id);
[s] = await api("PATCH", `/api/collections/documents/records/${bob_doc3_id}`, alice, {
  author: alice_id,
});
check("Alice (owner, non-author) cannot repoint document author either", s, 400);

let bob_dec: any;
[s, bob_dec] = await api("POST", "/api/collections/decisions/records", bob, {
  title: "Bob's decision (author-immutability probe)",
  workspace: ALICE_WORKSPACE,
});
check_in("setup: Bob creates a decision (author-immutability probe)", s, [200, 201]);
const bob_dec_id = bob_dec.id;
check("setup: decision author stamped to Bob at create", bob_dec.author, bob_id);
[s] = await api("PATCH", `/api/collections/decisions/records/${bob_dec_id}`, bob, {
  author: alice_id,
});
check("Bob (author) cannot repoint decision author to Alice", s, 400);
[s, r] = await api("GET", `/api/collections/decisions/records/${bob_dec_id}`, bob);
check("decision author unchanged after rejected update", r.author, bob_id);

let bob_mile: any;
[s, bob_mile] = await api("POST", "/api/collections/milestones/records", bob, {
  name: "Bob's milestone (author-immutability probe)",
  workspace: ALICE_WORKSPACE,
  project: ALICE_PROJECT,
});
check_in("setup: Bob creates a milestone (author-immutability probe)", s, [200, 201]);
const bob_mile_id = bob_mile.id;
check("setup: milestone author stamped to Bob at create", bob_mile.author, bob_id);
[s] = await api("PATCH", `/api/collections/milestones/records/${bob_mile_id}`, bob, {
  author: alice_id,
});
check("Bob (author) cannot repoint milestone author to Alice", s, 400);
[s, r] = await api("GET", `/api/collections/milestones/records/${bob_mile_id}`, bob);
check("milestone author unchanged after rejected update", r.author, bob_id);

// a same-collection PATCH that doesn't touch author still succeeds (guard is scoped to author only)
[s] = await api("PATCH", `/api/collections/documents/records/${bob_doc3_id}`, bob, {
  body: "author-immutability probe, edited",
});
check("document PATCH that doesn't touch author still succeeds", s, 200);

// ── cleanup: remove the records this test created ──
console.log("\n── cleanup ──");
if (alice_doc_id) {
  [s] = await api("DELETE", `/api/collections/documents/records/${alice_doc_id}`, alice);
  check("cleanup: Alice's document deleted", s, 204);
}
for (const [col, rid] of [
  ["documents", bob_doc3_id],
  ["decisions", bob_dec_id],
  ["milestones", bob_mile_id],
] as const) {
  if (rid) {
    [s] = await api("DELETE", `/api/collections/${col}/records/${rid}`, alice);
    check(`cleanup: ${col} author-immutability probe record deleted`, s, 204);
  }
}

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} FAILED: ${py_str(FAILS)}`);
  process.exit(1);
}
console.log("✅ all documents proofs passed");
process.exit(0);

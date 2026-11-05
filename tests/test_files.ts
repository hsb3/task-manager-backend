#!/usr/bin/env bun
/**
 * E2E proof of the file surface: public avatars with thumbnails and
 * protected item attachments served through short-lived file tokens.
 *
 * What it demonstrates:
 *   2a  avatar upload on own record         -> 200 + stored filename
 *   2b  update ANOTHER user's avatar        -> 404 (self-only users updateRule)
 *   3   PUBLIC avatar thumb, NO token       -> 200 image/png, exact requested dims
 *   4a  PROTECTED attachment, NO token      -> 404 (not 400 — view-denied semantics)
 *   4b  PROTECTED attachment, valid token   -> 200 image bytes
 *   5   non-member + VALID token            -> 404 (protected serving applies the
 *                                                   owning task's viewRule)
 *   6a  documents/decisions/milestones      -> upload + read-back, then anon / owner /
 *       attachments (PBTT-355)                 member / non-member tokens as 4a/4b/5
 *   6b  documents field limits              -> bad mime, oversize and one file past
 *                                              maxSelect all 400 with their PB codes;
 *                                              the declared 200x200 thumb renders
 *   6c  draft document attachment           -> a real member with a valid token still
 *                                              gets 404 (the draft/author predicate
 *                                              rides file serving), its author 200
 *   7   files cascade on task delete        -> on-disk storage dir removed
 *
 * Multipart uploads are hand-assembled (urllib won't build multipart/form-data).
 * File tokens are REUSABLE within their validity window, not single-use.
 *
 * Row 7 inspects the on-disk storage dir at PB_STORAGE_DIR (default:
 * pb_data/storage); an absent dir FAILS the suite. A plain owner DELETE only traps
 * to trash (no on-disk removal) — Row 7 uses the SUPERUSER token to hard-purge in
 * one call.
 */

import fs from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { py_join, py_str, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + PORT_OFFSET}`;
const STORAGE_DIR = process.env.PB_STORAGE_DIR ?? "pb_data/storage";
const TASKS_COLLECTION_ID = "pbc_2602490748"; // tasks (stable id since m10)

function is_dir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── PNG generator (real, decodable — content sniffs as image/png) ─────────────
function png_bytes(w: number, h: number, rgb: number[] = [40, 120, 200]): Buffer {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  function chunk(typ: Buffer, data: Buffer): Buffer {
    const c = Buffer.concat([typ, data]);
    return Buffer.concat([u32(data.length), c, u32(crc32(c))]);
  }

  const sig = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])]); // 8-bit RGB
  const px = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: w }, () => Buffer.from(rgb)),
  ]);
  const raw = Buffer.concat(Array.from({ length: h }, () => px));
  return Buffer.concat([
    sig,
    chunk(Buffer.from("IHDR"), ihdr),
    chunk(Buffer.from("IDAT"), deflateSync(raw)),
    chunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
}

function png_dims(data: Uint8Array): [number, number] {
  // IHDR width/height live at bytes 16..24 of a PNG.
  const b = Buffer.from(data.subarray(16, 24));
  return tup(b.readUInt32BE(0), b.readUInt32BE(4));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = {};
  if (body !== null) headers["Content-Type"] = "application/json";
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
  return [r.status, raw ? JSON.parse(raw) : {}];
}

async function get_raw(
  path: string,
  token: string | null = null,
): Promise<[number, string | null, Buffer]> {
  const url = PB + path + (token ? (!path.includes("?") ? "?" : "&") + `token=${token}` : "");
  try {
    const r = await fetch(url, { method: "GET" });
    return [r.status, r.headers.get("Content-Type"), Buffer.from(await r.arrayBuffer())];
  } catch (e) {
    return roomkit.die_no_server(PB, e);
  }
}

async function multipart(
  method: string,
  coll: string,
  rid: string,
  token: string | null,
  field: string,
  filename: string,
  content: Uint8Array,
  ctype = "image/png",
): Promise<[number, any]> {
  const b = "----pb15boundary";
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${ctype}\r\n\r\n`),
    content,
    Buffer.from("\r\n"),
    Buffer.from(`--${b}--\r\n`),
  ]);
  const headers: Record<string, string> = {
    "Content-Type": `multipart/form-data; boundary=${b}`,
  };
  if (token) headers.Authorization = token;
  const r = await fetch(`${PB}/api/collections/${coll}/records/${rid}`, { method, headers, body });
  return [r.status, JSON.parse((await r.text()) || "{}")];
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(PB, email, r), r.record.id];
}

async function superuser_token(): Promise<string> {
  const [su_email, su_password] = roomkit.superuser_creds();
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: su_email,
    password: su_password,
  });
  return roomkit.token_of(PB, su_email, r);
}

async function find_id(
  coll: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<any> {
  const qs = urlencode({ filter: `${field}='${value}'` });
  const [, r] = await api("GET", `/api/collections/${coll}/records?${qs}`, token);
  const items = r.items || [];
  return items.length ? items[0].id : null;
}

async function status_id(ws_id: string, word: string, tok: string | null): Promise<string> {
  const name =
    ({ todo: "Todo", doing: "In Progress", done: "Done" } as Record<string, string>)[word] ?? word;
  const items = (
    await api(
      "GET",
      `/api/collections/statuses/records?filter=(workspace='${ws_id}')&perPage=50`,
      tok,
    )
  )[1].items;
  const hit = items.find((i: any) => i.name === name);
  if (hit === undefined) throw new Error("StopIteration");
  return hit.id;
}

async function file_token(token: string | null): Promise<any> {
  const [, r] = await api("POST", "/api/files/token", token);
  return r.token ?? null;
}

const FAILS: string[] = [];

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) FAILS.push(label);
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} -> ${py_str(got)} (expected ${py_str(expected)})`,
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const [alice, alice_id] = await login("alice@example.com");
const [bob, bob_id] = await login("bob@example.com");
const [carol] = await login("carol@example.com");
const su = await superuser_token();
const TASK = await find_id("tasks", "title", "Design homepage", alice); // Alice's task
// owner id, not name — find_id here doesn't escape quotes and the seeded
// name has an apostrophe.
const ALICE_WORKSPACE = await find_id("workspaces", "owner", alice_id, alice);

let s: number;
let rec: any;
let ct: string | null;
let body: Buffer;

// COVERS: rule:users.update
console.log("\n-- AVATAR: upload on own record; update another user's is denied --");
[s, rec] = await multipart(
  "PATCH",
  "users",
  alice_id,
  alice,
  "avatar",
  "me.png",
  png_bytes(400, 400),
);
check("Alice uploads her own avatar (200)", s, 200);
const avatar_name = rec.avatar ?? "";
check("stored avatar filename is non-empty", avatar_name.length > 0, true);

[s] = await multipart("PATCH", "users", bob_id, alice, "avatar", "hack.png", png_bytes(400, 400));
check("Alice updates Bob's avatar (self-only rule -> 404)", s, 404);

console.log("\n-- AVATAR THUMB: public, no token, exact requested dimensions --");
const url = `/api/files/users/${alice_id}/${avatar_name}?thumb=100x100`;
[s, ct, body] = await get_raw(url); // deliberately NO token — avatar is public
check("public avatar thumb 100x100 without a token (200)", s, 200);
check("thumb content-type image/png", ct, "image/png");
check("thumb PNG header dims == 100x100", s === 200 ? png_dims(body) : null, tup(100, 100));

// COVERS: rule:tasks.update
console.log("\n-- ATTACHMENT: protected; denied without a token, served with one --");
[s, rec] = await multipart(
  "PATCH",
  "tasks",
  TASK,
  alice,
  "attachments+",
  "spec.png",
  png_bytes(300, 300),
);
check("Alice attaches a file to her task (200)", s, 200);
const att = rec.attachments[0];
const aurl = `/api/files/tasks/${TASK}/${att}`;
[s, ct] = await get_raw(aurl); // no token
check("protected attachment WITHOUT token (404, not 400)", s, 404);
[s, ct, body] = await get_raw(aurl, await file_token(alice));
check("protected attachment WITH Alice's valid token (200)", s, 200);
check("attachment content-type image/png", ct, "image/png");

// member (Bob) can also view via his own token — reuse it across the two asserts
let bob_ft = await file_token(bob);
[s] = await get_raw(aurl, bob_ft);
check("Bob (member) attachment WITH token (200)", s, 200);

// COVERS: rule:tasks.view
console.log("\n-- R2: non-member with a VALID token is still denied (404) --");
[s, ct, body] = await get_raw(aurl, await file_token(carol));
check("Carol (non-member) attachment WITH valid token (404)", s, 404);

// COVERS: rule:documents.view, rule:decisions.view, rule:milestones.view
console.log("\n-- ITEM ATTACHMENTS: the other item collections carry the same protected field --");
let alice_ft = await file_token(alice);
bob_ft = await file_token(bob);
const carol_ft = await file_token(carol);
let DOC: { id: string; file: string } = { id: "", file: "" }; // documents fixture, reused by the limits + draft-privacy blocks below
// seed.ts seeds no document and no decision — every fixture is created here so the
// three collections run one identical path. milestones.project is filled by the hook.
for (const [coll, fixture] of [
  ["documents", { title: "m15 attachment doc", body: "x", workspace: ALICE_WORKSPACE }],
  ["decisions", { title: "m15 attachment decision", workspace: ALICE_WORKSPACE }],
  ["milestones", { name: "m15 attachment milestone", workspace: ALICE_WORKSPACE }],
] as [string, any][]) {
  [s, rec] = await api("POST", `/api/collections/${coll}/records`, alice, fixture);
  check(`create ${coll} fixture`, [200, 201].includes(s), true);
  const rid = rec.id ?? null;
  [s, rec] = await multipart(
    "PATCH",
    coll,
    rid,
    alice,
    "attachments+",
    "spec.png",
    png_bytes(300, 300),
  );
  check(`Alice attaches a file to her ${coll} record (200)`, s, 200);
  const names = rec.attachments || [];
  check(`${coll}.attachments reads back a stored filename`, names.length, 1);
  if (!names.length) continue;
  if (coll === "documents") DOC = { id: rid, file: names[0] };
  const furl = `/api/files/${coll}/${rid}/${names[0]}`;
  [s] = await get_raw(furl);
  check(`${coll} attachment WITHOUT token (404)`, s, 404);
  [s, ct] = await get_raw(furl, alice_ft);
  check(`${coll} attachment WITH Alice's valid token (200)`, s, 200);
  check(`${coll} attachment content-type image/png`, ct, "image/png");
  // Alice is uploader AND workspace owner — Bob separates the member tier from hers.
  [s] = await get_raw(furl, bob_ft);
  check(`Bob (member) ${coll} attachment WITH valid token (200)`, s, 200);
  [s] = await get_raw(furl, carol_ft);
  check(`Carol (non-member) ${coll} attachment WITH valid token (404)`, s, 404);
}

function field_error(resp: any): any {
  return ((resp.data || {}).attachments ?? {}).code ?? null;
}

// The field config is byte-identical across the three, so the limits are probed once.
console.log("\n-- ITEM ATTACHMENT LIMITS (documents): mime, size, count, thumb --");
[s, rec] = await multipart(
  "PATCH",
  "documents",
  DOC.id,
  alice,
  "attachments+",
  "notes.txt",
  Buffer.from("hi"),
  "text/plain",
);
check("documents rejects a non-allowed mime (400)", s, 400);
check("... code validation_invalid_mime_type", field_error(rec), "validation_invalid_mime_type");

// Header first so the content still sniffs as PNG; the padding is what breaks maxSize.
const oversize = Buffer.concat([png_bytes(1, 1), Buffer.alloc(10485760)]);
[s, rec] = await multipart(
  "PATCH",
  "documents",
  DOC.id,
  alice,
  "attachments+",
  "big.png",
  oversize,
);
check("documents rejects a file over maxSize (400)", s, 400);
check("... code validation_file_size_limit", field_error(rec), "validation_file_size_limit");

for (let i = 0; i < 9; i++) {
  // takes the record to the maxSelect ceiling
  [s, rec] = await multipart(
    "PATCH",
    "documents",
    DOC.id,
    alice,
    "attachments+",
    `fill${i}.png`,
    png_bytes(10, 10),
  );
}
check("documents fills up to maxSelect", (rec.attachments || []).length, 10);
[s, rec] = await multipart(
  "PATCH",
  "documents",
  DOC.id,
  alice,
  "attachments+",
  "extra.png",
  png_bytes(10, 10),
);
check("documents rejects one file past maxSelect (400)", s, 400);
check("... code validation_too_many_files", field_error(rec), "validation_too_many_files");

const turl = `/api/files/documents/${DOC.id}/${DOC.file}?thumb=200x200`;
[s, ct, body] = await get_raw(turl, alice_ft);
check("documents attachment thumb 200x200 WITH token (200)", s, 200);
check("thumb content-type image/png", ct, "image/png");
check("thumb PNG header dims == 200x200", s === 200 ? png_dims(body) : null, tup(200, 200));

console.log("\n-- DRAFT PRIVACY: file serving applies the whole viewRule, not just membership --");
alice_ft = await file_token(alice);
bob_ft = await file_token(bob); // file tokens are short-lived
let draft: any;
[s, draft] = await api("POST", "/api/collections/documents/records", alice, {
  title: "m15 draft doc",
  body: "x",
  workspace: ALICE_WORKSPACE,
  draft: true,
});
check("create draft documents fixture", [200, 201].includes(s), true);
[s, rec] = await multipart(
  "PATCH",
  "documents",
  draft.id ?? null,
  alice,
  "attachments+",
  "secret.png",
  png_bytes(120, 120),
);
check("Alice attaches a file to her draft document (200)", s, 200);
const dnames = rec.attachments || [];
check("draft document attachment stored", dnames.length, 1);
if (dnames.length) {
  const durl = `/api/files/documents/${draft.id}/${dnames[0]}`;
  [s] = await api("GET", `/api/collections/documents/records/${draft.id}`, bob);
  check("Bob (member) GETs Alice's draft record (404)", s, 404);
  [s] = await get_raw(durl, bob_ft);
  check("Bob (member) draft attachment WITH valid token (404)", s, 404);
  [s] = await get_raw(durl, alice_ft);
  check("Alice (author) draft attachment WITH valid token (200)", s, 200);
}

// COVERS: rule:tasks.create
console.log("\n-- CASCADE: deleting a task removes its on-disk storage dir --");
let throwaway: any;
[s, throwaway] = await api("POST", "/api/collections/tasks/records", alice, {
  title: "m15 cascade fixture",
  status: await status_id(ALICE_WORKSPACE, "todo", alice),
  project: await find_id("projects", "name", "Website Redesign", alice),
});
check("create throwaway task", [200, 201].includes(s), true);
const tid = throwaway.id;
[s, rec] = await multipart(
  "PATCH",
  "tasks",
  tid,
  alice,
  "attachments+",
  "doomed.png",
  png_bytes(120, 120),
);
check("attach a file to the throwaway task", s, 200);
const rec_dir = py_join(STORAGE_DIR, TASKS_COLLECTION_ID, tid);
// The upload above wrote into it, so an absent dir means PB_STORAGE_DIR is wrong, not that
// the host lacks one — asserting the API delete alone would prove the cascade vacuously.
check(`PB_STORAGE_DIR exists: ${STORAGE_DIR}`, is_dir(STORAGE_DIR), true);
check("storage dir exists before delete", is_dir(rec_dir), true);
// owner DELETE only traps to trash; use the superuser token to hard-purge.
[s] = await api("DELETE", `/api/collections/tasks/records/${tid}`, su);
check("delete the task (204)", s, 204);
// on-disk removal happens just after the delete response returns — poll briefly.
let gone = false;
for (let _ = 0; _ < 25; _++) {
  // up to ~5s
  if (!is_dir(rec_dir)) {
    gone = true;
    break;
  }
  await Bun.sleep(200);
}
check("storage dir removed after delete (cascade)", gone, true);

console.log();
if (FAILS.length) {
  console.log(`FAILED (${FAILS.length}): ${py_str(FAILS)}`);
  process.exit(1);
}
console.log("all module-15 file proofs passed");

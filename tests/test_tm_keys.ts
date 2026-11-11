#!/usr/bin/env bun
/**
 * tm keys list / keys revoke (clients/tm): the human table and --json, the active/expired/revoked
 * filter, revoking one's own key, the usage and manage-key refusals, and control characters in a
 * stored key name escaped in the human output (decision:api-keys).
 *
 * Fully self-contained clean-room server; runs the CLI as a subprocess. Port 8222 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const TM = path.join(REPO_ROOT, "clients", "tm", "tm.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8222 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const HOSTILE = "A\u202eB\nC\u001b[31mD\\u0041";
const HOSTILE_SHOWN = "A\\u202eB\\u000aC\\u001b[31mD\\\\u0041";
// every C0/C1 control, line separator, bidi and zero-width character, other than the newline that ends a line
const RAW =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

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
  url: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : {}];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tm-keys-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const XDG = path.join(S, "xdg");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(XDG, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

type Run = { code: number; stdout: string; stderr: string; json: any };

/** Run the CLI as a user would: XDG config dir in scratch, the saved login unless env overrides. */
async function tm(args: string[], stdin?: string): Promise<Run> {
  const { TM_API_KEY, TM_URL, ...clean } = process.env;
  const proc = Bun.spawn([process.execPath, TM, ...args], {
    cwd: S,
    env: { ...clean, HOME: S, XDG_CONFIG_HOME: XDG, TM_CREDENTIAL_STORE: "file" },
    stdin: stdin === undefined ? "ignore" : new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {}
  return { code, stdout, stderr, json };
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
  const [, su_r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);

  console.log("\n── fixtures: Alice with a manage key and five other keys ──");
  let [s, r] = await api("POST", "/api/collections/users/records", su, {
    email: "alice@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Alice",
    verified: true,
    approved: true,
  });
  check("fixture Alice created", s, 200);
  const ALICE_ID: string = r.id;
  [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "alice@example.com",
    password: "test123456",
  });
  const alice: string = r.token;
  const su_key = async (body: Record<string, any>): Promise<{ id: string; key: string }> => {
    const [st, rec] = await api("POST", KEYS, su, { user: ALICE_ID, scope: "write", ...body });
    check(
      `fixture key "${body.name === HOSTILE ? "hostile" : body.name.slice(0, 12)}" made`,
      st,
      200,
    );
    return rec;
  };
  const manage = await su_key({ name: "manage key", manage_keys: true });
  const hostile = await su_key({ name: HOSTILE });
  const target = await su_key({ name: "to revoke" });
  const revoked = await su_key({ name: "already revoked" });
  [s] = await api("PATCH", `${KEYS}/${revoked.id}`, alice, { revoked: true });
  check("fixture key revoked", s, 200);
  [s, r] = await api("POST", KEYS, alice, { name: "hand minted", scope: "read" });
  check("fixture plain key minted by Alice", s, 200);
  const plain = r;
  const expiring = await su_key({
    name: "expiring",
    expires: new Date(Date.now() + 1000).toISOString().replace("T", " "),
  });
  await sleep(2000);

  console.log("\n── no sub-verb, a bad one, a missing id: usage errors before any login ──");
  let o = await tm(["keys"]);
  check(
    "keys alone → exit 2 missing <create|list|revoke>",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(2, "tm: missing <create|list|revoke>"),
  );
  o = await tm(["keys", "frob"]);
  check(
    "keys frob → exit 2",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(2, 'tm: unknown keys verb "frob"; one of create, list, revoke'),
  );
  o = await tm(["keys", "create"]);
  check(
    "keys create → exit 2 until it exists",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(2, 'tm: unknown keys verb "create"; one of list, revoke'),
  );
  o = await tm(["keys", "revoke"]);
  check(
    "keys revoke → exit 2 missing <id>",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(2, "tm: missing <id>"),
  );

  console.log("\n── a plain key saved: keys list says so ──");
  o = await tm(["login", "--with-key", "--url", BASE_URL], `${plain.key}\n`);
  check("login with the plain key", o.code, 0);
  o = await tm(["keys", "list"]);
  check(
    "keys list with a plain key → exit 1, run tm login",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(1, "tm: this key cannot list or revoke keys; run tm login to get one that can"),
  );

  console.log("\n── keys list with the manage key ──");
  o = await tm(["login", "--with-key", "--url", BASE_URL], `${manage.key}\n`);
  check("login with the manage key", o.code, 0);
  o = await tm(["keys", "list"]);
  const lines = o.stdout.split("\n").filter(Boolean);
  const row = (id: string) => lines.find((l) => l.startsWith(id)) ?? "";
  check(
    "keys list exits 0, header starts ID",
    tup(o.code, lines[0]?.startsWith("ID")),
    tup(0, true),
  );
  check("active keys only: header plus four rows", lines.length, 5);
  check("the manage key's row ends active*", row(manage.id).endsWith("active*"), true);
  check("a hand-minted key's CLIENT column is -", row(plain.id).slice(51, 75).trim(), "-");
  check("the revoked key is absent", o.stdout.includes(revoked.id), false);
  check("the expired key is absent", o.stdout.includes(expiring.id), false);
  check("the hand-minted key's EXPIRES reads never", row(plain.id).includes("  never  "), true);

  console.log("\n── keys list --all ──");
  o = await tm(["keys", "list", "--all"]);
  const all = o.stdout.split("\n").filter(Boolean);
  const arow = (id: string) => all.find((l) => l.startsWith(id)) ?? "";
  check("--all lists header plus six rows", tup(o.code, all.length), tup(0, 7));
  check("the revoked key shows revoked", arow(revoked.id).endsWith("revoked"), true);
  check("the expired key shows expired", arow(expiring.id).endsWith("expired"), true);

  console.log("\n── keys list --json ──");
  o = await tm(["keys", "list", "--json"]);
  const FIELDS = [
    "client_id",
    "created",
    "current",
    "expires",
    "id",
    "last_used",
    "manage_keys",
    "name",
    "projects",
    "reach",
    "revoked",
    "scope",
    "workspace",
  ];
  check(
    "--json is an array of the active keys",
    tup(o.code, Array.isArray(o.json), o.json?.length),
    tup(0, true, 4),
  );
  check(
    "every item has the route's fields and no key",
    (o.json ?? []).every((i: any) => FIELDS.every((f) => f in i) && !("key" in i)),
    true,
  );
  o = await tm(["keys", "list", "--all", "--json"]);
  check("--all --json holds six", o.json?.length, 6);

  console.log("\n── control characters in a name never reach the terminal ──");
  o = await tm(["keys", "list"]);
  const hl = o.stdout.split("\n");
  check("no raw control character in the table", RAW.test(o.stdout), false);
  check("header plus four rows, nothing forged by the newline", hl.filter(Boolean).length, 5);
  check("the hostile row shows the escape", o.stdout.includes("A\\u202eB\\u000aC"), true);

  console.log("\n── keys revoke ──");
  o = await tm(["keys", "revoke", target.id]);
  check(
    'revoke → exit 0, revoked <id> "<name>"',
    tup(o.code, o.stdout, o.stderr),
    tup(0, `revoked ${target.id} "to revoke"\n`, ""),
  );
  [s] = await api("GET", "/api/tracker/me", target.key);
  check("the revoked key then answers 401", s, 401);
  o = await tm(["keys", "revoke", hostile.id, "--json"]);
  check(
    "revoke --json → the item, revoked true",
    tup(o.code, o.json?.id, o.json?.revoked),
    tup(0, hostile.id, true),
  );
  o = await tm(["keys", "revoke", "nosuchid0000000"]);
  check(
    "revoke unknown → exit 1, the API's message",
    tup(o.code, o.stderr.split("\n")[0]),
    tup(1, "tm: No key with that id among yours."),
  );

  console.log("\n── the revoke line escapes a name too ──");
  const hostile2 = await su_key({ name: HOSTILE });
  o = await tm(["keys", "revoke", hostile2.id]);
  check(
    "revoke line holds the escaped name, no raw control",
    tup(o.stdout, RAW.test(o.stdout)),
    tup(`revoked ${hostile2.id} "${HOSTILE_SHOWN}"\n`, false),
  );

  console.log("\n── line separators, zero-width text and a cut through an emoji ──");
  const sneaky = await su_key({ name: `${"x".repeat(23)}😀 FAKE ad​min` });
  o = await tm(["keys", "list"]);
  const sneaky_row = o.stdout.split("\n").find((l) => l.startsWith(sneaky.id)) ?? "";
  check(
    "the row holds no raw separator or zero-width character and no broken character",
    tup(RAW.test(o.stdout), o.stdout.includes("�"), sneaky_row.includes("x😀  ")),
    tup(false, false, true),
  );
  o = await tm(["keys", "revoke", sneaky.id]);
  check(
    "the revoke line escapes them",
    o.stdout,
    `revoked ${sneaky.id} "${"x".repeat(23)}😀\\u2028FAKE ad\\u200bmin"\n`,
  );
  for (const id of [".", ".."]) {
    o = await tm(["keys", "revoke", id]);
    check(
      `keys revoke ${id} → exit 1, the unknown-id message, no other route reached`,
      tup(o.code, o.stderr.split("\n")[0]),
      tup(1, "tm: No key with that id among yours."),
    );
  }

  console.log("\n── revoking the key the command used ──");
  o = await tm(["keys", "revoke", manage.id]);
  check(
    "exit 0, the note on stderr",
    tup(o.code, o.stdout, o.stderr),
    tup(
      0,
      `revoked ${manage.id} "manage key"\n`,
      "tm: note: that was this login's key; run tm login again\n",
    ),
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
  console.log("✅ all tm keys proofs passed");
  process.exit(0);
}

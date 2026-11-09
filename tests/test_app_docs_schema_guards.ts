#!/usr/bin/env bun
/**Proof that pb_hooks/schema_guards.pb.js holds the migration-defined schema against runtime edits.

§1 app_docs refuses an unknown body key: a superuser POST/PATCH naming a key that is no field
of the collection answers 400 with `validation_failed` on that key, and a write carrying only
real fields still lands; non-superusers keep the null-rule 403.
§2 the shipped pb_hooks/field_patterns.json equals the pattern set schema/*.json carries, in
both directions — an extra entry would restore a pattern no migration defines, a missing one
would leave a widened pattern in place.
§3 serve re-asserts every field pattern: every pattern is widened through the collections
import endpoint, the room restarts, and every pattern reads back equal to schema/.
§4 a pattern-bearing collection deleted at runtime does not stop the room serving, and the
absence is logged.
§5 an unreadable or missing field_patterns.json restores NOTHING (a half-known map could
revert a migration) and still serves; a restart on the good file restores again.

Self-booting clean room (scratch copies of pb_migrations + pb_hooks). Port 8128 + PB_PORT_OFFSET.*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  glob_sorted,
  py_get,
  py_repr,
  py_str,
  read_text,
  run_checked,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

// COVERS: hook:schema_guards.pb.js#onRecordCreateRequest:app_docs, hook:schema_guards.pb.js#onRecordUpdateRequest:app_docs
// COVERS: boot:schema_guards.pb.js

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const SCHEMA_DIR = path.join(REPO_ROOT, "schema");
const PATTERNS_FILE = path.join(REPO_ROOT, "pb_hooks", "field_patterns.json");

const PORT = 8128 + roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0");
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const WIDE = "^.*$";
const BAD_SLUG = "decsion:probe";
const UNREADABLE_LOG = "schema_guards: field_patterns.json unreadable";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
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
  return [r.status, raw ? JSON.parse(raw) : {}];
}

// A Python dict keyed by (collection, field) is a Map keyed by JSON.stringify of the tuple.
type Patterns = Map<string, any>;
const pkey = (c: string, f: string): string => JSON.stringify([c, f]);
const tuple_keys = (m: Patterns): [string, string][] => [...m.keys()].map((k) => JSON.parse(k));
const by_tuple = (a: [string, string], b: [string, string]): number =>
  by_code_point(a[0], b[0]) || by_code_point(a[1], b[1]);

/** {(collection, field): pattern} for every schema/ field whose pattern is non-empty. */
function expected_patterns(): Patterns {
  const out: Patterns = new Map();
  for (const file of glob_sorted(SCHEMA_DIR, ".json")) {
    const doc = JSON.parse(read_text(file));
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      continue;
    }
    const fields = py_get(doc, "fields");
    for (const field of truthy(fields) ? fields : []) {
      if (truthy(py_get(field, "pattern"))) {
        out.set(pkey(getitem(doc, "name"), getitem(field, "name")), getitem(field, "pattern"));
      }
    }
  }
  return out;
}

/** The same shape, read from the file the hook actually loads at serve. */
function shipped_patterns(): Patterns {
  const doc = JSON.parse(read_text(PATTERNS_FILE));
  const out: Patterns = new Map();
  for (const [c, fields] of Object.entries<any>(doc)) {
    for (const [f, p] of Object.entries(fields)) out.set(pkey(c, f), p);
  }
  return out;
}

async function live_collections(su: string): Promise<Record<string, any>> {
  const [, r] = await api("GET", "/api/collections?perPage=500", su);
  return Object.fromEntries((r.items ?? []).map((c: any) => [getitem(c, "name"), c]));
}

async function live_patterns(su: string, keys: [string, string][]): Promise<Patterns> {
  const cols = await live_collections(su);
  const got: Patterns = new Map();
  for (const [name, field] of keys) {
    const col = py_get(cols, name);
    const f = (py_get(truthy(col) ? col : {}, "fields", []) as any[]).find(
      (x) => getitem(x, "name") === field,
    );
    got.set(pkey(name, field), f === undefined ? null : py_get(f, "pattern"));
  }
  return got;
}

function mismatches(got: Patterns, want: Patterns): string[] {
  return tuple_keys(want)
    .filter(([c, f]) => !Bun.deepEquals(py_get(got, pkey(c, f)), want.get(pkey(c, f)), true))
    .map(([c, f]) => `${c}.${f}: ${py_repr(py_get(got, pkey(c, f)))}`)
    .sort(by_code_point);
}

/** Widen every pattern-bearing field of `names` through the import endpoint. */
async function widen(su: string, names: Set<string>): Promise<[number, any]> {
  const cols = await live_collections(su);
  const keys = new Map([...expected_patterns()].filter(([k]) => names.has(JSON.parse(k)[0])));
  const payload: any[] = [];
  for (const name of [...names].sort(by_code_point)) {
    const col = getitem(cols, name);
    for (const f of getitem(col, "fields")) {
      if (keys.has(pkey(name, getitem(f, "name")))) {
        f.pattern = WIDE;
      }
    }
    payload.push(col);
  }
  return api("PUT", "/api/collections/import", su, { collections: payload, deleteMissing: false });
}

/** PocketBase holds log entries for a few seconds, so this polls rather than sleeps. */
async function wait_for_log(
  su: string,
  needle: string,
  match: (entry: any) => boolean = (_entry) => true,
  timeout = 15,
): Promise<any[]> {
  const qs = urlencode({ filter: `message ~ '${needle}'`, perPage: 50 });
  const deadline = Date.now() / 1000 + timeout;
  while (Date.now() / 1000 < deadline) {
    const [, r] = await api("GET", `/api/logs?${qs}`, su);
    const hits = (r.items ?? []).filter(match);
    if (hits.length) {
      return hits;
    }
    await Bun.sleep(500);
  }
  return [];
}

async function su_login(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  return roomkit.token_of(BASE_URL, SU_EMAIL, r);
}

async function doc_count(slug: string, su: string): Promise<any> {
  const qs = urlencode({ filter: `slug='${slug}'` });
  const [, r] = await api("GET", `/api/collections/app_docs/records?${qs}`, su);
  return r.totalItems ?? null;
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-schema-guards-test-"));
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
  const hooks = roomkit.hooks_dir(S);
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, hooks, path.join(S, "boot1.log"));
  let su = await su_login();
  let status: number;
  let r: any;

  console.log("\n── §1 app_docs refuses an unknown body key ──");
  [status, r] = await api("POST", "/api/collections/users/records", su, {
    email: "guard-user@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Guard User",
    verified: true,
    approved: true,
  });
  check("fixture: a regular user is created", status, 200);
  [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "guard-user@example.com",
    password: "test123456",
  });
  const user: string | null = r.token ?? null;
  check("fixture: the regular user authenticates", truthy(user), true);

  let doc: any;
  [status, doc] = await api("POST", "/api/collections/app_docs/records", su, {
    slug: "concept:guard-real",
    title: "Guard",
    body: "real fields only",
  });
  check("superuser POST with only real fields → 200", status, 200);
  const doc_id = py_str(doc.id ?? null);

  [status, r] = await api("POST", "/api/collections/app_docs/records", su, {
    slug: "concept:guard-kind",
    title: "Guard",
    body: "b",
    kind: "concept",
  });
  console.log(
    `     response keys: ${py_str(Object.keys(r).sort(by_code_point))}  data: ${py_str(r.data ?? null)}`,
  );
  check("superuser POST with unknown key `kind` → 400", status, 400);
  check(
    "  data.kind.code == validation_failed",
    py_get(py_get(truthy(r.data) ? r.data : {}, "kind", {}), "code"),
    "validation_failed",
  );
  check(
    "  data names only the offending key",
    Object.keys(truthy(r.data) ? r.data : {}).sort(by_code_point),
    ["kind"],
  );
  check("  the refused POST created no record", await doc_count("concept:guard-kind", su), 0);

  [status, r] = await api("POST", "/api/collections/app_docs/records", su, {
    slug: "concept:guard-two",
    title: "G",
    body: "b",
    kind: "x",
    bogus: 1,
  });
  check("superuser POST with two unknown keys → 400", status, 400);
  check(
    "  data names both offending keys",
    Object.keys(truthy(r.data) ? r.data : {}).sort(by_code_point),
    ["bogus", "kind"],
  );

  [status, r] = await api("PATCH", `/api/collections/app_docs/records/${doc_id}`, su, {
    title: "Changed",
    kind: "concept",
  });
  console.log(
    `     response keys: ${py_str(Object.keys(r).sort(by_code_point))}  data: ${py_str(r.data ?? null)}`,
  );
  check("superuser PATCH with unknown key `kind` → 400", status, 400);
  check(
    "  data.kind.code == validation_failed",
    py_get(py_get(truthy(r.data) ? r.data : {}, "kind", {}), "code"),
    "validation_failed",
  );
  let row: any;
  [, row] = await api("GET", `/api/collections/app_docs/records/${doc_id}`, su);
  check("  the refused PATCH changed nothing", row.title ?? null, "Guard");

  [status, row] = await api("PATCH", `/api/collections/app_docs/records/${doc_id}`, su, {
    title: "Changed",
  });
  check("superuser PATCH with only real fields → 200", status, 200);
  check("  the PATCH landed", row.title ?? null, "Changed");

  for (const [who, token] of [
    ["regular user", user],
    ["anon", null],
  ] as [string, string | null][]) {
    [status] = await api("POST", "/api/collections/app_docs/records", token, {
      slug: "concept:guard-anon",
      title: "G",
      body: "b",
    });
    check(`${who} POST (null createRule) → 403`, status, 403);
    [status] = await api("PATCH", `/api/collections/app_docs/records/${doc_id}`, token, {
      title: "x",
    });
    check(`${who} PATCH (null updateRule) → 403`, status, 403);
    [status] = await api("GET", `/api/collections/app_docs/records/${doc_id}`, token);
    check(`${who} GET (public viewRule) → 200`, status, 200);
  }

  console.log("\n── §2 the shipped field_patterns.json equals schema/, both directions ──");
  const expected = expected_patterns();
  const shipped = shipped_patterns();
  console.log(
    `  pattern-bearing fields: schema/ ${expected.size}, field_patterns.json ${shipped.size}`,
  );
  check("schema/ yields pattern-bearing fields", expected.size > 0, true);
  check(
    "entries schema/ has that field_patterns.json lacks",
    tuple_keys(expected)
      .filter(([c, f]) => !shipped.has(pkey(c, f)))
      .map(([c, f]) => `${c}.${f}`)
      .sort(by_code_point),
    [],
  );
  check(
    "entries field_patterns.json has that schema/ lacks",
    tuple_keys(shipped)
      .filter(([c, f]) => !expected.has(pkey(c, f)))
      .map(([c, f]) => `${c}.${f}`)
      .sort(by_code_point),
    [],
  );
  check(
    "entries whose pattern differs between the two",
    tuple_keys(expected)
      .filter(
        ([c, f]) =>
          shipped.has(pkey(c, f)) &&
          !Bun.deepEquals(shipped.get(pkey(c, f)), expected.get(pkey(c, f)), true),
      )
      .map(([c, f]) => `${c}.${f}`)
      .sort(by_code_point),
    [],
  );

  console.log("\n── §3 serve re-asserts every migration-defined field pattern ──");
  check(
    "boot: live patterns differing from schema/",
    mismatches(await live_patterns(su, tuple_keys(expected)), expected),
    [],
  );

  [status, r] = await widen(su, new Set(tuple_keys(expected).map(([c]) => c)));
  check("superuser import widening every pattern → 204", status, 204);
  if (status !== 204) {
    console.log(`     import response: ${py_str(r)}`);
  }
  check(
    "import took: patterns NOT reading back widened",
    mismatches(
      await live_patterns(su, tuple_keys(expected)),
      new Map(tuple_keys(expected).map(([c, f]) => [pkey(c, f), WIDE])),
    ),
    [],
  );

  [status, r] = await api("POST", "/api/collections/app_docs/records", su, {
    slug: BAD_SLUG,
    title: "P",
    body: "p",
  });
  check(`before restart: POST slug ${BAD_SLUG} → 200 (widened)`, status, 200);
  const widened_row = r.id ?? null;

  await roomkit.stop(server);
  server = null;
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, hooks, path.join(S, "boot2.log"));
  su = await su_login();

  const got = await live_patterns(su, tuple_keys(expected));
  for (const key of tuple_keys(expected).sort(by_tuple)) {
    check(
      `after restart: ${key[0]}.${key[1]} pattern equals schema/`,
      got.get(pkey(key[0], key[1])),
      expected.get(pkey(key[0], key[1])),
    );
  }
  [status, r] = await api("POST", "/api/collections/app_docs/records", su, {
    slug: BAD_SLUG,
    title: "P",
    body: "p",
  });
  check(`after restart: POST slug ${BAD_SLUG} → 400`, status, 400);
  // Forward-only by design: the restore refuses new bad rows, it does not clean up old ones.
  [status] = await api("GET", `/api/collections/app_docs/records/${py_str(widened_row)}`, su);
  check("the row written while the pattern was widened survives the restore", status, 200);
  await api("DELETE", `/api/collections/app_docs/records/${py_str(widened_row)}`, su);

  console.log("\n── §4 a missing collection is logged and the room still serves ──");
  [status] = await api("DELETE", "/api/collections/app_settings", su);
  check("fixture: superuser deletes the app_settings collection → 204", status, 204);
  await roomkit.stop(server);
  server = null;
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, hooks, path.join(S, "boot3.log"));
  su = await su_login();
  [status] = await api("GET", "/api/health");
  check("restart with a pattern-bearing collection missing still serves", status, 200);
  const logged = await wait_for_log(
    su,
    "schema_guards: collection missing",
    (x) => py_get(truthy(x.data) ? x.data : {}, "collection") === "app_settings",
  );
  check("the missing app_settings collection is logged", logged.length > 0, true);
  const rest: Patterns = new Map(
    [...expected].filter(([k]) => JSON.parse(k)[0] !== "app_settings"),
  );
  check(
    "the other collections' patterns differing from schema/",
    mismatches(await live_patterns(su, tuple_keys(rest)), rest),
    [],
  );

  console.log("\n── §5 an unusable field_patterns.json restores nothing and still serves ──");
  [status] = await widen(su, new Set(["app_docs"]));
  check("fixture: app_docs patterns widened again → 204", status, 204);
  await roomkit.stop(server);
  server = null;

  const corrupt = (p: string): void => fs.writeFileSync(p, "not json at all", "utf-8");

  for (const [label, sabotage] of [
    ["corrupt", corrupt],
    ["missing", (p: string): void => fs.unlinkSync(p)],
  ] as [string, (p: string) => void][]) {
    const broken = path.join(S, `hooks_${label}`);
    copy_tree(hooks, broken);
    sabotage(path.join(broken, "field_patterns.json"));
    server = await roomkit.serve(
      PORT,
      DATA_DIR,
      MIG_DIR,
      broken,
      path.join(S, `boot_${label}.log`),
    );
    su = await su_login();
    [status] = await api("GET", "/api/health");
    check(`${label} field_patterns.json: the room still serves`, status, 200);
    check(
      `${label} field_patterns.json: app_docs.slug is left as it was found`,
      (await live_patterns(su, [["app_docs", "slug"]])).get(pkey("app_docs", "slug")),
      WIDE,
    );
    check(
      `${label} field_patterns.json: the refusal is logged`,
      (await wait_for_log(su, UNREADABLE_LOG)).length > 0,
      true,
    );
    await roomkit.stop(server);
    server = null;
  }

  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, hooks, path.join(S, "boot6.log"));
  su = await su_login();
  check(
    "a restart on the good file restores app_docs.slug",
    (await live_patterns(su, [["app_docs", "slug"]])).get(pkey("app_docs", "slug")),
    expected.get(pkey("app_docs", "slug")),
  );
} finally {
  if (server !== null) {
    await roomkit.stop(server);
  }
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} schema-guard check(s) FAILED`);
  process.exit(1);
}
console.log(
  "✅ app_docs refuses unknown keys, and serve holds every migration-defined field pattern",
);

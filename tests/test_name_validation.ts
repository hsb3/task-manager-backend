#!/usr/bin/env bun
/**
 * E2E proof of PBTT-346 + PBTT-449: a whitespace-only value in a guarded required text
 * field is refused (400) on every HTTP create and update path that carries one, by the
 * single shared guard in pb_hooks/names.pb.js.
 *
 * The collection list is DERIVED from schema/*.json at runtime (every required text field,
 * partitioned into names.pb.js's guarded set and PBTT-449's dispositioned-accept set) — a
 * new required text field turns this suite red until it is either guarded with a payload
 * recipe here or dispositioned below. Also re-proves the two custom vocab-route guards
 * (routes.pb.js) still answer 400 with their own wording, and that rule denial
 * still wins over the guard (no existence leak through a 400).
 *
 * Section 5 proves the second, narrower contract the two lookup keys carry: app_settings.key
 * and app_docs.slug are addressed, not read, so a field `pattern` (PocketBase itself, no hook)
 * holds them to lowercase alphanumeric segments joined by a single `-` or `_`, with one
 * optional `<namespace>:` prefix on a slug.
 *
 * verify_grep tokens for MODEL_DIR/target/*.yml — do not rename without updating the model
 * target facets in lockstep:
 *     app_settings key shape
 *     app_docs slug shape
 *
 * Bound: HTTP writes only. onRecord*Request hooks do not fire for programmatic saves
 * (cron, custom-route handlers, migrations), so those paths are NOT covered here.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8106 + PB_PORT_OFFSET (suite self-boot band per .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  glob_sorted,
  json_dumps,
  py_get,
  py_repr,
  py_str,
  read_text,
  run_checked,
  truthy,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { esc, stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const SCHEMA_DIR = path.join(REPO_ROOT, "schema");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8106 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

// Every whitespace run PB's `required` lets through; "" is already rejected by PB itself.
const BLANKS = [" ", "   ", "\t", "\n", " \t \n "];

// KEEP IN SYNC (below): pb_hooks/lib/workspace_rules.js's guarded array `["name", "title", "slug", "body", "key"]` — the field names the shared hook judges.
const GUARDED_FIELDS = new Set(["name", "title", "slug", "body", "key"]);

// Dispositioned-accept: a required text field deliberately left unguarded, and why.
// Keyed by field name where the reason holds for every collection carrying it.
const ACCEPTED_FIELDS: Record<string, string> = {
  id: "PB generates it and its own `^[a-z0-9]+$` pattern already refuses whitespace",
};
// (collection, field) pairs are Map keys as JSON.stringify([collection, field]).
const pair_key = (coll: string, field: string): string => JSON.stringify([coll, field]);
const ACCEPTED_PAIRS = new Map<string, string>([
  [
    pair_key("task_activity", "field"),
    "null create/update rules — only activity.pb.js's programmatic saves write it, " +
      "and Request hooks never fire for those",
  ],
  [
    pair_key("workspace_invitations", "email"),
    "refused when blank by invitations.pb.js's OWN create hook (400 'Email must be a " +
      "non-empty string.'), not by names.pb.js's shared guard (decision:invitation-keyed-by-email)",
  ],
  [
    pair_key("workspace_invitations", "email_key"),
    "server-derived: the same create hook always overwrites it from `email`, so a " +
      "submitted value never reaches storage (decision:invitation-keyed-by-email)",
  ],
  [
    pair_key("api_keys", "key_hash"),
    "server-derived: api_keys.pb.js's create hook always overwrites it with the key's hash, " +
      "and it is hidden, so PB drops it from a non-superuser body (decision:api-keys)",
  ],
  [
    pair_key("invitation_events", "email_key"),
    "null rules on every operation — only invitations.pb.js writes it, copied from the " +
      "invitation's already-folded key (decision:invitation-send-limit-and-decline-block)",
  ],
]);

// PB normalizes a thrown BadRequestError message — first letter upper, trailing period.
function refusal(field: string): string {
  return `${field.slice(0, 1).toUpperCase()}${field.slice(1)} must be a non-empty string.`;
}

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
  const raw = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  return [r.status, raw.length ? JSON.parse(text) : {}]; // 204 -> empty body
}

// Same request as api(), sent multipart/form-data — the shape a file-carrying write
// takes, where the guard reads its values out of a form part instead of a JSON body.
async function form(
  method: string,
  path: string,
  token: string,
  fields: Record<string, string>,
): Promise<[number, any]> {
  const boundary = "----pbtt346formboundary";
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  const r = await fetch(BASE_URL + path, {
    method,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Authorization: token,
    },
    body: parts.join(""),
  });
  const raw = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  return [r.status, raw.length ? JSON.parse(text) : {}];
}

async function find_id(
  collection: string,
  field: string,
  value: string,
  token: string | null = null,
): Promise<any> {
  const qs = urlencode({ filter: `${field}='${esc(value)}'`, perPage: 200 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
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
  const tok = r.token ?? null;
  if (!truthy(tok)) throw new Error(`superuser auth failed: ${py_str(r)}`);
  return tok;
}

// (collection, field) for EVERY required text field, read from the GENERATED schema/
// tree — the population PBTT-449 had to disposition.
function derive_required_text_fields(): [string, string][] {
  const found: [string, string][] = [];
  for (const file of glob_sorted(SCHEMA_DIR, ".json")) {
    if (file.endsWith(".rules.json")) continue;
    const coll = JSON.parse(read_text(file));
    if (coll.type !== "base") continue;
    for (const f of py_get(coll, "fields", [])) {
      if (f.type === "text" && truthy(f.required)) {
        found.push(tup(getitem(coll, "name"), getitem(f, "name")));
      }
    }
  }
  return found;
}

// (collection, field) → its `pattern`, for every PATTERNED required text field in
// schema/ — read, never typed, so a new pattern cannot land here unproven.
function derive_patterns(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of glob_sorted(SCHEMA_DIR, ".json")) {
    if (file.endsWith(".rules.json")) continue;
    const coll = JSON.parse(read_text(file));
    if (coll.type !== "base") continue;
    for (const f of py_get(coll, "fields", [])) {
      if (f.type === "text" && truthy(f.required) && truthy(f.pattern)) {
        found.set(pair_key(getitem(coll, "name"), getitem(f, "name")), f.pattern);
      }
    }
  }
  return found;
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

// Python sorts (collection, field) tuples element by element.
const by_pair = (a: [string, string], b: [string, string]): number =>
  by_code_point(a[0], b[0]) || by_code_point(a[1], b[1]);

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-name-validation-test-"));
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
  const [carol] = await login("carol@example.com");

  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);
  const ALICE_PROJECT = await find_id("projects", "name", "Website Redesign", alice);
  check("(fixture) resolved Alice's workspace", truthy(ALICE_WS), true);
  check("(fixture) resolved Alice's project", truthy(ALICE_PROJECT), true);

  const ALICE_TASK = await find_id("tasks", "title", "Ship landing page", alice);
  check("(fixture) resolved a task to comment on", truthy(ALICE_TASK), true);

  // Per-collection minimal-valid payload, WITHOUT the guarded field the loop supplies.
  // `actor` names the token; app_docs/app_settings have null create/update rules
  // (superuser only). `{field}` in a base value is substituted with the field under test,
  // so a collection with two guarded fields cannot collide on its own UNIQUE index.
  // `valid` overrides the happy-path value for a field whose schema/ pattern refuses free text.
  const RECIPES: Record<string, any> = {
    api_keys: {
      actor: "alice",
      base: { scope: "read" },
      patch: { revoked: true },
    },
    app_docs: {
      actor: "su",
      base: {
        slug: "pbtt346-probe-{field}",
        title: "base title",
        body: "base body",
      },
      patch: { refName: "pbtt346" },
      valid: { slug: "pbtt346-probe-valid-slug" },
    },
    app_settings: {
      actor: "su",
      base: { key: "pbtt449-probe-{field}", value: { probe: true } },
      patch: { value: { probe: false } },
      valid: { key: "pbtt449_probe_valid_key" },
    },
    comments: {
      actor: "alice",
      base: { task: ALICE_TASK, body: "probe body" },
      patch: { reactions: { eyes: [alice_id] } },
    },
    cycles: {
      actor: "alice",
      base: { workspace: ALICE_WS, starts_on: "2026-01-05 00:00:00.000Z" },
      patch: { ends_on: "2026-01-25 00:00:00.000Z" },
    },
    decisions: {
      actor: "alice",
      base: { workspace: ALICE_WS },
      patch: { context: "probe context" },
    },
    documents: {
      actor: "alice",
      base: { workspace: ALICE_WS },
      patch: { body: "probe body" },
    },
    labels: {
      actor: "alice",
      base: { workspace: ALICE_WS },
      patch: { description: "probe description" },
    },
    milestones: {
      actor: "alice",
      base: { workspace: ALICE_WS, project: ALICE_PROJECT },
      patch: { description: "probe description" },
    },
    projects: {
      actor: "alice",
      base: { workspace: ALICE_WS, owner: alice_id },
      patch: { description: "probe description" },
    },
    saved_views: {
      actor: "alice",
      base: { workspace: ALICE_WS, owner: alice_id, scope: "personal" },
      patch: { description: "probe description" },
    },
    statuses: {
      actor: "alice",
      base: { workspace: ALICE_WS, category: "backlog" },
      patch: { color: "teal" },
    },
    tasks: {
      actor: "alice",
      base: { project: ALICE_PROJECT },
      patch: { description: "probe description" },
    },
    templates: {
      actor: "alice",
      base: { workspace: ALICE_WS, type: "task" },
      patch: { type: "task" },
    },
    workspaces: {
      actor: "alice",
      base: { owner: alice_id },
      patch: { priorities: ["urgent", "high", "medium", "low"].map((n) => ({ name: n })) },
    },
  };
  const TOKENS: Record<string, string> = { alice: alice, su: su };

  // ══════════════════ 0. The list under test is derived, not typed ═════════════
  console.log("\n── (0) every required text field in schema/, partitioned by PBTT-449 ruling ──");
  const all_required = derive_required_text_fields();
  const derived = all_required.filter(([, f]) => GUARDED_FIELDS.has(f));
  const accepted = all_required.filter(
    ([c, f]) => Object.hasOwn(ACCEPTED_FIELDS, f) || ACCEPTED_PAIRS.has(pair_key(c, f)),
  );
  const seen_keys = new Set([...derived, ...accepted].map(([c, f]) => pair_key(c, f)));
  const undispositioned = [
    ...new Map(
      all_required
        .filter(([c, f]) => !seen_keys.has(pair_key(c, f)))
        .map((p) => [pair_key(...p), p]),
    ).values(),
  ].sort(by_pair);
  console.log(`  · guarded:  ${py_str(derived)}`);
  for (const [coll, field] of accepted) {
    const reason =
      py_get(ACCEPTED_FIELDS, field, null) || ACCEPTED_PAIRS.get(pair_key(coll, field));
    console.log(`  · accepted: ${coll}.${field} — ${reason}`);
  }
  check("at least one guarded required text field exists in schema/", derived.length > 0, true);
  check(
    "every required text field is guarded or dispositioned (a new one needs a ruling)",
    undispositioned,
    [],
  );
  check(
    "every guarded collection has a payload recipe here (a new one must be guarded too)",
    [...new Set(derived.map(([c]) => c))]
      .filter((c) => !Object.hasOwn(RECIPES, c))
      .sort(by_code_point),
    [],
  );
  check(
    "no stale recipe for a collection schema/ no longer carries",
    Object.keys(RECIPES)
      .filter((c) => !derived.some(([dc]) => dc === c))
      .sort(by_code_point),
    [],
  );
  const PATTERNS = derive_patterns();
  const derived_keys = new Set(derived.map(([c, f]) => pair_key(c, f)));
  const guarded_patterns = [...PATTERNS.entries()]
    .filter(([k]) => derived_keys.has(k))
    .map(([k, pat]) => [JSON.parse(k) as [string, string], pat] as const)
    .sort((a, b) => by_pair(a[0], b[0]));
  for (const [[coll, field], pattern] of guarded_patterns) {
    console.log(`  · patterned: ${coll}.${field} — ${pattern}`);
  }
  check(
    "every patterned guarded field names a valid probe value here (a new pattern needs one)",
    guarded_patterns
      .filter(([[c, f]]) => !Object.hasOwn(RECIPES[c]?.valid || {}, f))
      .map(([[c, f]]) => `${c}.${f}`)
      .sort(by_code_point),
    [],
  );

  // ══════════════════ 1. CREATE + UPDATE, every derived path ═══════════════════
  // COVERS: hook:names.pb.js#onRecordCreateRequest:api_keys, hook:names.pb.js#onRecordUpdateRequest:api_keys
  // COVERS: hook:names.pb.js#onRecordCreateRequest:app_docs, hook:names.pb.js#onRecordUpdateRequest:app_docs
  // COVERS: hook:names.pb.js#onRecordCreateRequest:app_settings, hook:names.pb.js#onRecordUpdateRequest:app_settings
  // COVERS: hook:names.pb.js#onRecordCreateRequest:comments, hook:names.pb.js#onRecordUpdateRequest:comments
  // COVERS: hook:names.pb.js#onRecordCreateRequest:cycles, hook:names.pb.js#onRecordUpdateRequest:cycles
  // COVERS: hook:names.pb.js#onRecordCreateRequest:decisions, hook:names.pb.js#onRecordUpdateRequest:decisions
  // COVERS: hook:names.pb.js#onRecordCreateRequest:documents, hook:names.pb.js#onRecordUpdateRequest:documents
  // COVERS: hook:names.pb.js#onRecordCreateRequest:labels, hook:names.pb.js#onRecordUpdateRequest:labels
  // COVERS: hook:names.pb.js#onRecordCreateRequest:milestones, hook:names.pb.js#onRecordUpdateRequest:milestones
  // COVERS: hook:names.pb.js#onRecordCreateRequest:projects, hook:names.pb.js#onRecordUpdateRequest:projects
  // COVERS: hook:names.pb.js#onRecordCreateRequest:saved_views, hook:names.pb.js#onRecordUpdateRequest:saved_views
  // COVERS: hook:names.pb.js#onRecordCreateRequest:statuses, hook:names.pb.js#onRecordUpdateRequest:statuses
  // COVERS: hook:names.pb.js#onRecordCreateRequest:tasks, hook:names.pb.js#onRecordUpdateRequest:tasks
  // COVERS: hook:names.pb.js#onRecordCreateRequest:templates, hook:names.pb.js#onRecordUpdateRequest:templates
  // COVERS: hook:names.pb.js#onRecordCreateRequest:workspaces, hook:names.pb.js#onRecordUpdateRequest:workspaces
  let s: number;
  let r: any;
  let made: any;
  for (const [coll, field] of derived) {
    const recipe = getitem(RECIPES, coll);
    const token = getitem(TOKENS, getitem(recipe, "actor"));
    // A collection with two guarded fields is visited twice, so any UNIQUE-indexed base
    // value has to differ per visit.
    const base = Object.fromEntries(
      Object.entries(getitem(recipe, "base")).map(([k, v]) => [
        k,
        typeof v === "string" ? v.replaceAll("{field}", field) : v,
      ]),
    );
    const good = py_get(recipe.valid || {}, field, `PBTT346 ${coll}`);
    console.log(`\n── (1) ${coll}.${field} (as ${getitem(recipe, "actor")}) ──`);

    [s, r] = await api("POST", `/api/collections/${coll}/records`, token, {
      ...base,
      [field]: "   ",
    });
    check(`CREATE ${coll} with a whitespace-only ${field} → 400`, s, 400);
    check(`CREATE ${coll} refusal names the field`, r.message ?? null, refusal(field));

    [s, made] = await api("POST", `/api/collections/${coll}/records`, token, {
      ...base,
      [field]: good,
    });
    check(`CREATE ${coll} with a real ${field} → 200 (guard lets valid input through)`, s, 200);
    const rec_id = made.id ?? null;
    if (!truthy(rec_id)) {
      console.log(`     create body: ${json_dumps(made).slice(0, 400)}`);
      continue;
    }

    [s, r] = await api("PATCH", `/api/collections/${coll}/records/${rec_id}`, token, {
      [field]: "   ",
    });
    check(`UPDATE ${coll} to a whitespace-only ${field} → 400`, s, 400);
    check(`UPDATE ${coll} refusal names the field`, r.message ?? null, refusal(field));

    [s, r] = await api(
      "PATCH",
      `/api/collections/${coll}/records/${rec_id}`,
      token,
      getitem(recipe, "patch"),
    );
    check(`UPDATE ${coll} WITHOUT sending ${field} → 200 (partial update untouched)`, s, 200);
    check(`UPDATE ${coll} left ${field} intact`, r[field] ?? null, good);

    for (const [label, value, want] of [
      ["holds exactly one record with the valid", good, 1],
      ["persisted NO whitespace-only", "   ", 0],
    ] as [string, string, number][]) {
      const qs = urlencode({ filter: `${field}='${esc(value)}'` });
      [s, r] = await api("GET", `/api/collections/${coll}/records?${qs}`, token);
      check(`${coll} ${label} ${field}`, tup(s, r.totalItems ?? null), tup(200, want));
    }
  }

  // ══════════════════ 2. Every whitespace shape, not just spaces ═══════════════
  console.log("\n── (2) each whitespace run is refused (tasks.title as the representative) ──");
  for (const blank of BLANKS) {
    [s] = await api("POST", "/api/collections/tasks/records", alice, {
      project: ALICE_PROJECT,
      title: blank,
    });
    check(`CREATE task with title=${py_repr(blank)} → 400`, s, 400);
  }
  [s] = await api("POST", "/api/collections/tasks/records", alice, {
    project: ALICE_PROJECT,
    title: "",
  });
  check("CREATE task with title='' → 400 (PB's own required check, unchanged)", s, 400);

  // ══════════════════ 2b. multipart/form-data, not just JSON ═══════════════════
  console.log("\n── (2b) a form-encoded write is judged the same as a JSON one ──");
  [s, r] = await form("POST", "/api/collections/tasks/records", alice, {
    project: ALICE_PROJECT,
    title: "   ",
  });
  check("multipart CREATE task with a blank title → 400", s, 400);
  check("multipart CREATE refusal names the field", r.message ?? null, refusal("title"));
  [s, made] = await form("POST", "/api/collections/tasks/records", alice, {
    project: ALICE_PROJECT,
    title: "PBTT346 multipart",
  });
  check("multipart CREATE task with a real title → 200", s, 200);
  const mp_id = made.id ?? null;
  if (truthy(mp_id)) {
    [s, r] = await form("PATCH", `/api/collections/tasks/records/${mp_id}`, alice, {
      title: "   ",
    });
    check("multipart UPDATE task to a blank title → 400", s, 400);
    check("multipart UPDATE refusal names the field", r.message ?? null, refusal("title"));
    [s, r] = await form("PATCH", `/api/collections/tasks/records/${mp_id}`, alice, {
      description: "probe",
    });
    check("multipart UPDATE WITHOUT sending title → 200", s, 200);
    check("multipart UPDATE left title intact", r.title ?? null, "PBTT346 multipart");
  }

  // ══════════════════ 3. The guard is not a rules bypass ═══════════════════════
  console.log("\n── (3) rule denial still wins — a blank name leaks nothing ──");
  let victim: any;
  [s, victim] = await api("POST", "/api/collections/tasks/records", alice, {
    project: ALICE_PROJECT,
    title: "PBTT346 rule-precedence victim",
  });
  check("(fixture) Alice creates a task for Carol to probe", s, 200);
  const victim_id = victim.id ?? null;
  [s] = await api("PATCH", `/api/collections/tasks/records/${py_str(victim_id)}`, carol, {
    title: "   ",
  });
  check("Carol (non-member) PATCHes a blank title → 404, not 400", s, 404);
  [s] = await api("PATCH", `/api/collections/tasks/records/${py_str(victim_id)}`, null, {
    title: "   ",
  });
  check("Anon PATCHes a blank title → 404, not 400", s, 404);
  [s] = await api("POST", "/api/collections/tasks/records", null, {
    project: ALICE_PROJECT,
    title: "   ",
  });
  check("Anon CREATE with a blank title → 400 (create-denied idiom)", s, 400);

  // ══════════════════ 4. The vocab route's own guards are untouched ════════════
  // COVERS: route:POST /api/tracker/workspaces/{id}/vocab
  console.log("\n── (4) the vocab route still answers 400 in its own wording ──");
  const VOCAB_URL = `/api/tracker/workspaces/${py_str(ALICE_WS)}/vocab`;
  [s, r] = await api("POST", VOCAB_URL, alice, { statuses: [{ name: "   " }] });
  check("POST vocab with a blank status name → 400", s, 400);
  check(
    "vocab status refusal keeps the vocab route's own wording",
    r.message ?? null,
    "Status name must be a non-empty string.",
  );
  [s, r] = await api("POST", VOCAB_URL, alice, { labels: [{ name: "   " }] });
  check("POST vocab with a blank label name → 400", s, 400);
  check(
    "vocab label refusal keeps the vocab route's own wording",
    r.message ?? null,
    "Label name must be a non-empty string.",
  );
  const [, existing] = await api(
    "GET",
    `/api/collections/labels/records?filter=(workspace='${py_str(ALICE_WS)}')`,
    alice,
  );
  const keep = py_get(existing, "items", []).map((lbl: any) => ({
    id: getitem(lbl, "id"),
    name: getitem(lbl, "name"),
  }));
  check("(fixture) Alice's workspace has labels to re-submit", keep.length > 0, true);
  [s, r] = await api("POST", VOCAB_URL, alice, { labels: keep });
  check("POST vocab with real names still → 200 (guard does not double-fire)", s, 200);
  check("vocab response is the saved workspace", r.id ?? null, ALICE_WS);

  // ══════════════════ 5. The two lookup keys carry a shape, not just a guard ═══
  console.log("\n── (5) app_settings.key / app_docs.slug are held to a shape by PocketBase ──");
  // Both patterns are plain RE2 (character classes and groups only), so JS RegExp reads
  // them identically and the survey below judges stored rows by the live pattern itself.
  const SHAPE_BAD = ["a b", "A/B", "-lead", "trail_", "a--b", "a__b", "UPPER"];
  const SHAPE_CASES: [string, string, string, (v: string) => any, string[], string[]][] = [
    [
      "app_settings key shape",
      "app_settings",
      "key",
      (v) => ({ key: v, value: { probe: true } }),
      ["pbtt449-shape-probe", "pbtt449_shape_probe2", "probe3"],
      ["ns:name"], // a colon namespace is a slug affordance, not a key one
    ],
    [
      "app_docs slug shape",
      "app_docs",
      "slug",
      (v) => ({ slug: v, title: "shape", body: "shape" }),
      [
        "pbtt346-probe-slug",
        "concept:pbtt346-shape",
        "collection:pbtt346_shape",
        "decision:pbtt346-shape",
        "hook:pbtt346-shape",
        "route:pbtt346-shape",
      ],
      // the namespace is a CLOSED vocabulary: a misspelling, an invented word and
      // `field` (a value of the removed `kind` select that was never a namespace)
      // are all refused, so no second column can disagree with the slug.
      ["decsion:probe", "totallybogus:probe", "field:probe", "decision:a:b"],
    ],
  ];
  // The namespace vocabulary lives ONLY in the slug pattern — no other column records it.
  check(
    "app_docs slug shape: the live pattern names exactly the namespace vocabulary",
    [
      ...(PATTERNS.get(pair_key("app_docs", "slug")) || "").matchAll(/\(([a-z]+(?:\|[a-z]+)+)\)/g),
    ].map((m) => m[1]),
    ["collection|concept|decision|hook|route"],
  );
  check(
    "app_docs carries no second classification column beside the slug namespace",
    getitem(JSON.parse(read_text(path.join(SCHEMA_DIR, "app_docs.json"))), "fields")
      .map((f: any) => getitem(f, "name"))
      .sort(by_code_point),
    ["body", "created", "id", "refName", "slug", "title", "updated"],
  );

  for (const [label, coll, field, make_body, goods, extra_bad] of SHAPE_CASES) {
    console.log(`\n── (5) ${label} ──`);
    check(
      `${label}: schema/ carries a pattern on ${field}`,
      truthy(PATTERNS.get(pair_key(coll, field))),
      true,
    );
    for (const bad of [...SHAPE_BAD, ...extra_bad]) {
      [s, r] = await api("POST", `/api/collections/${coll}/records`, su, make_body(bad));
      check(
        `${label}: CREATE ${field}=${py_repr(bad)} → 400 invalid format`,
        tup(s, ((r.data || {})[field] || {}).code ?? null),
        tup(400, "validation_invalid_format"),
      );
    }
    for (const good of goods) {
      [s] = await api("POST", `/api/collections/${coll}/records`, su, make_body(good));
      check(`${label}: CREATE ${field}=${py_repr(good)} → 200`, s, 200);
    }
    [s, r] = await api("POST", `/api/collections/${coll}/records`, su, make_body("   "));
    check(
      `${label}: whitespace-only keeps the guard wording, not the format error`,
      tup(s, r.message ?? null),
      tup(400, refusal(field)),
    );
  }

  console.log("\n── (5b) every stored key and slug is legal under the live pattern ──");
  for (const [label, coll, field, seeded] of [
    ["app_settings key shape", "app_settings", "key", ["trash_retention_days"]],
    [
      "app_docs slug shape",
      "app_docs",
      "slug",
      ["collection:app_docs", "decision:soft-delete-trash"],
    ],
  ] as [string, string, string, string[]][]) {
    // `(?!)` never matches, so a missing pattern fails the survey loudly instead of
    // crashing the suite out of its own ✅/❌ report.
    // Python's re.match anchors at the start only: sticky flag, lastIndex reset per value.
    const rx = new RegExp(PATTERNS.get(pair_key(coll, field)) || "(?!)", "y");
    const [, rows] = await api("GET", `/api/collections/${coll}/records?perPage=500`, su);
    const stored = py_get(rows, "items", [])
      .map((row: any) => getitem(row, field))
      .sort(by_code_point);
    check(`${label}: the survey found stored rows to judge`, stored.length > 0, true);
    check(
      `${label}: every stored ${field} matches the live pattern`,
      stored.filter((v: string) => {
        rx.lastIndex = 0;
        return !rx.test(v);
      }),
      [],
    );
    for (const value of seeded) {
      check(`${label}: seeded ${py_repr(value)} is present`, stored.includes(value), true);
      const rid = await find_id(coll, field, value, su);
      [s, r] = await api("PATCH", `/api/collections/${coll}/records/${py_str(rid)}`, su, {
        [field]: value,
      });
      check(
        `${label}: re-saving seeded ${py_repr(value)} → 200 (no row needed migrating)`,
        tup(s, r[field] ?? null),
        tup(200, value),
      );
    }
  }
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all name-validation proofs passed");
  process.exit(0);
}

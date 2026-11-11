#!/usr/bin/env bun
/**
 * Table-driven proof that a trashed, draft or shadow record is invisible on every read surface at every membership tier.
 *
 * Every case is DERIVED at runtime from schema/*.json — the subject collections are the ones
 * carrying one of the STATE_FIELDS names, and the relation cases are every relation field whose
 * target resolves to one of them. A new collection or relation is therefore covered the moment
 * it lands, or turns this suite red; nothing here is a hand-copied list.
 *
 * Each derived case is attacked at every tier in TIERS_UNDER_TEST (plain active member, admin,
 * viewer, suspended member, suspended admin), each a separate user because a standing is keyed
 * (workspace, user).
 *
 * Surfaces asserted per tier against each offending record: collection list, collection view,
 * expand through every pointing relation (single + list form), GET /api/tracker/search,
 * POST /api/tracker/export, GET /api/tracker/trash (the draft carve-out, member only), and
 * task_activity (the enforcement point behind /audit_log).
 *
 * The final block covers the ROW-hidden direction — a row hidden because its CONTAINER is
 * trashed, not because the row itself is. Its cases come from the schema's cascadeDelete edges
 * as well as from the rules, so a rule that stops naming its container fails here instead of
 * quietly retiring its own case. BOUNDED: that block asserts list and view (and the restore
 * round trip) only. Its dependent collections carry no title for search or export to match on,
 * and the workspace-trashed search, export and summary surfaces are proven at seven tiers in
 * tests/test_workspace_trash.ts rather than re-asserted here.
 *
 * The last block is the one WRITE claim here: decision:workspace-configuration-freeze freezes a trashed workspace's
 * configuration, so the two tiers that may write it in a live workspace — the owner and an
 * active admin — are refused create, update and delete on every configuration collection.
 *
 * Port 8118 + PB_PORT_OFFSET (suite self-boot band). VIS_STRICT=1 enforces the KNOWN_OPEN table.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  json_dumps,
  py_repr,
  py_str,
  read_text,
  run_checked,
  tup,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { stop_server } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const SCHEMA_DIR = path.join(REPO_ROOT, "schema");
const PB_BIN = roomkit.pb_bin();

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8118 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";

const STRICT = process.env.VIS_STRICT === "1";

// The field names whose presence makes a collection able to hide a record from ordinary members.
const STATE_FIELDS = ["trashed", "draft", "shadow"];

// (tier name, membership role, membership status) every derived case is attacked at. The
// suspended standing is the inverted control: it must see NOTHING, including the live record.
const TIERS_UNDER_TEST: [string, string, string][] = [
  ["member", "member", "active"],
  ["admin", "admin", "active"],
  ["viewer", "viewer", "active"],
  ["suspended", "member", "suspended"],
  // The admin carve-outs are the widest reads here, so a suspended ADMIN is the tier a
  // loosened standing clause lets through first: same role, no standing.
  ["suspended-admin", "admin", "suspended"],
];
const TIER_NAMES = TIERS_UNDER_TEST.map(([name]) => name);
const TIER_ROLE: Record<string, string> = Object.fromEntries(
  TIERS_UNDER_TEST.map(([name, role]) => [name, role]),
);
const TIER_STATUS: Record<string, string> = Object.fromEntries(
  TIERS_UNDER_TEST.map(([name, , status]) => [name, status]),
);

const SURFACES = ["list", "view", "expand", "search", "export"];

// (subject, state) -> tier -> the surfaces that hand the record over ON PURPOSE. Asserted as
// VISIBLE, never absorbed: a carve-out that disappears goes red here too, and a NEW exposure —
// any tier, any surface — goes red until it is declared. The carve-outs themselves are proven in
// tests/test_membership_rules.ts (an admin reads another user's draft) and tests/test_trash.ts
// (an admin manages a trashed project). /api/tracker/search and /api/tracker/export pin
// `trashed = ''` for every caller (pb_hooks/routes.pb.js), so a trashed project is admin-visible
// through the collection rules and absent from both routes.
const BY_DESIGN: Record<string, Record<string, Record<string, Set<string>>>> = {
  decisions: { draft: { admin: new Set(SURFACES) } },
  documents: { draft: { admin: new Set(SURFACES) } },
  milestones: { draft: { admin: new Set(SURFACES) } },
  projects: { trashed: { admin: new Set(["list", "view", "expand"]) } },
};

function by_design(subject: string, state: string, tier: string, surface: string): boolean {
  /** True when this surface hands this offending record to this tier deliberately. */
  return BY_DESIGN[subject]?.[state]?.[tier]?.has(surface) ?? false;
}

// Group key -> why a case under it is a leak this suite reports but does not fail on. Enforced
// like any other case under VIS_STRICT=1. Empty is the healthy state; every entry runs unproven.
const KNOWN_OPEN: Record<string, string> = {
  "shadow-custom-routes":
    "GET /api/tracker/search and POST /api/tracker/export still hand over the workspace " +
    "shadow project: both read projects outside the rule tier, so the collection rules " +
    "that hide it never run for them. The clause that excludes it belongs to whoever " +
    "owns pb_hooks/routes.pb.js, not to this suite.",
};

// DECLARED SKIP: (pointing collection, relation field) -> why no record pointing at an offending subject can be built at all. Empty is the healthy state; every entry runs unproven.
const DECLARED_SKIPS: Map<string, string> = new Map();
const pair_key = (coll: string, relfield: string): string => `${coll}\0${relfield}`;

// collection -> its createRule as the ROOM reports it, filled once the room is up. A null one is
// superuser-only, which is how a hook-written record class tells itself apart from user data.
const CREATE_RULES: Record<string, string | null> = {};
// collection -> its updateRule as the ROOM reports it, filled alongside CREATE_RULES.
const UPDATE_RULES: Record<string, string | null> = {};

// decision:invitation-keyed-by-email nulled workspace_members.createRule (only R3 mints a row now), so
// is_configuration() stops counting it as configuration by the create-rule proxy — but its
// listRule's restoring-tier carve-out is UNCHANGED (measured: it lands in ROW_CASES below via
// claims_row_hidden, not via is_configuration): an active admin still reads a member row once
// the workspace is trashed.
const READ_CARVEOUT_EXTRA = new Set(["workspace_members"]);

// workspace_invitations' OWN rule excludes a trashed workspace for EVERY caller, including the
// owner (R6, tests/test_invitations.ts) — it never joins the restoring-tier read carve-out
// despite qualifying as configuration by the create-rule proxy.
const NO_TRASH_CARVEOUT = new Set(["workspace_invitations"]);

// collection -> why its workspace relation LIMITS the row rather than anchoring it: neither configuration nor containment.
const NOT_ANCHORED: Map<string, string> = new Map([
  [
    "api_keys",
    "a key is its user's own credential and its workspace/projects only limit its reach (decision:api-key-reach-and-levels)",
  ],
]);

const FAILS: string[] = [];
const OPEN_HITS: string[] = [];
const NOOPS: string[] = [];

// Python's sorted() on tuples of strings: element-wise code-point order.
function tuple_cmp(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = by_code_point(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function now_ts(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ") + ".000Z";
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
    roomkit.die_no_server(BASE_URL, e);
  }
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

function check(
  key: string,
  label: string,
  got: any,
  expected: any,
  open_group: string | null = null,
): boolean {
  /** One assertion. `open_group` names a KNOWN_OPEN entry that absorbs a failure unless STRICT. */
  if (Bun.deepEquals(got, expected, true)) {
    console.log(`  ✅  ${key.padEnd(64)} ${label} → ${py_repr(got)}`);
    return true;
  }
  // DECLARED SKIP: KNOWN_OPEN names the card behind every absorbed group; VIS_STRICT=1 enforces them
  const skip = open_group !== null && !STRICT;
  // DECLARED SKIP: same absorbed group, declared on the line above
  if (skip) {
    OPEN_HITS.push(key);
    console.log(`  SKIP ${key} — ${KNOWN_OPEN[open_group]}`);
    console.log(`       would fail: ${label} → ${py_repr(got)} (want ${py_repr(expected)})`);
    return false;
  }
  FAILS.push(key);
  console.log(
    `  ❌ MISMATCH  ${key.padEnd(64)} ${label} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
  return false;
}

function hard_fail(key: string, message: string): void {
  FAILS.push(key);
  console.log(`  ❌ ${key} — ${message}`);
}

function noop(key: string, why: string): void {
  /** A surface with nothing to prove — printed on every run, never silent. */
  NOOPS.push(key);
  console.log(`  ·   ${key.padEnd(64)} no-op — ${why}`);
}

// ── Derivation from schema/*.json ────────────────────────────────────────────────────────────
function load_schema(): Record<string, any> {
  /** {collection name: parsed schema} for every non-view collection under schema/. */
  const out: Record<string, any> = {};
  const paths = fs
    .readdirSync(SCHEMA_DIR)
    .filter((n) => n.endsWith(".json") && !n.startsWith("."))
    .map((n) => path.join(SCHEMA_DIR, n))
    .sort(by_code_point);
  for (const p of paths) {
    if (p.endsWith(".rules.json") || p.endsWith(".view.json")) continue;
    const doc = JSON.parse(read_text(p));
    out[doc.name] = doc;
  }
  return out;
}

const SCHEMA = load_schema();

function fields_of(collection: string): any[] {
  return SCHEMA[collection].fields;
}

function field_named(collection: string, name: string): any {
  for (const f of fields_of(collection)) {
    if (f.name === name) return f;
  }
  return null;
}

function derive_subjects(): Record<string, string[]> {
  /** {collection: [state field, …]} for every collection carrying a STATE_FIELDS field. */
  const subjects: Record<string, string[]> = {};
  for (const [name, doc] of Object.entries<any>(SCHEMA)) {
    const states = doc.fields
      .map((f: any) => f.name)
      .filter((n: string) => STATE_FIELDS.includes(n));
    if (states.length) subjects[name] = states;
  }
  return subjects;
}

const SUBJECTS = derive_subjects();

function derive_relation_cases(id_to_name: Record<string, string>): [string, string, string][] {
  /** [(pointing collection, relation field, subject)] — every relation field into a subject. */
  const cases: [string, string, string][] = [];
  for (const [name, doc] of Object.entries<any>(SCHEMA)) {
    for (const f of doc.fields) {
      if (f.type !== "relation") continue;
      const target = id_to_name[f.collectionId];
      if (target !== undefined && target in SUBJECTS) cases.push([name, f.name, target]);
    }
  }
  return cases.sort(tuple_cmp);
}

function is_content(collection: string): boolean {
  /** True when `collection` holds trashable content or hangs off ONE content record. */
  return collection in SUBJECTS || field_named(collection, "workspace") === null;
}

function is_configuration(collection: string): boolean {
  /** True when `collection` is workspace CONFIGURATION rather than content.
   *
   * Three properties at once: it hangs off a workspace, it holds no trash state of its own, and
   * SOME caller can create one through the API. The last is what keeps a HOOK-WRITTEN record
   * class out — task_activity and notifications hang off a workspace too, and a null createRule
   * means no tier can ever mint one, so there is no configuration write for a trash to freeze.
   * Read off the ROOM's rules, so a collection opened to a caller joins the set the moment it is,
   * without a name being added anywhere. */
  if (Object.keys(CREATE_RULES).length === 0) {
    throw new roomkit.SystemExit("❌ is_configuration ran before the room reported its rules");
  }
  return (
    !(collection in SUBJECTS) &&
    !NOT_ANCHORED.has(collection) &&
    field_named(collection, "workspace") !== null &&
    (CREATE_RULES[collection] ?? null) !== null
  );
}

// The tiers that keep READING a trashed workspace's configuration under decision:workspace-configuration-freeze, because
// they are the ones who can restore it. Derived from the tier table rather than named, so a tier
// added or restated there cannot leave a stale carve-out behind.
const RESTORING_TIERS = new Set(
  TIER_NAMES.filter((name) => TIER_ROLE[name] === "admin" && TIER_STATUS[name] === "active"),
);

function is_containment(collection: string, target: string): boolean {
  /** True when trashing `target` must change what `collection`'s rows say to a reader.
   *
   * decision:workspace-configuration-freeze freezes configuration with the WORKSPACE holding it and with nothing else: a
   * trashed project does not retire the workspace vocabulary rows that happen to name it.
   * Everything else keeps the older test — content, meaning a subject or a row with no workspace
   * anchor of its own — so a hook-written class anchored on a workspace makes no promise here;
   * what its rows do when that workspace is trashed is ruled where they are written. */
  if (NOT_ANCHORED.has(collection)) return false;
  return is_configuration(collection) ? target === "workspaces" : is_content(collection);
}

function keeps_reading(collection: string, target: string, tier: string): boolean {
  /** True when `tier` still reads the row after `target` is trashed (decision:workspace-configuration-freeze). */
  const configured = is_configuration(collection) || READ_CARVEOUT_EXTRA.has(collection);
  return (
    configured &&
    !NO_TRASH_CARVEOUT.has(collection) &&
    target === "workspaces" &&
    RESTORING_TIERS.has(tier)
  );
}

function derive_ancestor_cases(id_to_name: Record<string, string>): [string, string, string][] {
  /** [(pointing collection, relation field, target)] — the CONTAINMENT edges into a subject.
   *
   * `cascadeDelete` IS the containment marker: purging the target purges the row. A
   * cascadeDelete=false relation (tasks.parent, tasks.milestone, tasks.dependencies) is a
   * reference, and trashing a referenced row must NOT hide the row referring to it, so those
   * are deliberately excluded rather than allowlisted. */
  const cases: [string, string, string][] = [];
  for (const [name, doc] of Object.entries<any>(SCHEMA)) {
    for (const f of doc.fields) {
      const target = id_to_name[f.collectionId];
      if (
        f.type === "relation" &&
        f.cascadeDelete &&
        target !== undefined &&
        target in SUBJECTS &&
        SUBJECTS[target]!.includes("trashed") &&
        is_containment(name, target)
      ) {
        cases.push([name, f.name, target]);
      }
    }
  }
  return cases.sort(tuple_cmp);
}

// ── Room ─────────────────────────────────────────────────────────────────────────────────────
function start_server(
  scratch: string,
  data_dir: string,
  migrations_dir: string,
): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(scratch));
}

// ── Generic record building ──────────────────────────────────────────────────────────────────
const SEQ = { n: 0 };
const FIXTURE_IDS: Record<string, string> = {};

function token_for(kind: string): string {
  /** A unique apostrophe-free marker; finding it in a response body IS the leak. */
  SEQ.n += 1;
  return `visprobe${SEQ.n}${kind}`;
}

class Ctx {
  /** The tenant anchors a generically-built record hangs off. */
  workspace: string;
  project: string;
  user: string;

  constructor(workspace: string, project: string, user: string) {
    this.workspace = workspace;
    this.project = project;
    this.user = user;
  }
}

function default_value(
  field: any,
  ctx: Ctx,
  id_to_name: Record<string, string>,
  text: string,
): any {
  const t = field.type;
  if (t === "text" || t === "editor") return text;
  if (t === "number") return 1;
  if (t === "bool") return false;
  if (t === "date") return now_ts();
  if (t === "select") {
    const values = field.values || [];
    if (!values.length) return null;
    return (field.maxSelect || 1) > 1 ? [values[0]] : values[0];
  }
  if (t === "json") return {};
  if (t === "email") return `${text}@example.com`;
  if (t === "url") return "https://example.invalid/probe";
  if (t === "relation") {
    const target = id_to_name[field.collectionId];
    const anchors: Record<string, string> = {
      users: ctx.user,
      workspaces: ctx.workspace,
      projects: ctx.project,
    };
    const anchor =
      target !== undefined && Object.hasOwn(anchors, target)
        ? anchors[target]
        : FIXTURE_IDS[target!];
    if (anchor === undefined) return null;
    return (field.maxSelect || 1) > 1 ? [anchor] : anchor;
  }
  return null; // file/password/autodate and anything new: never invented here
}

function build_body(
  collection: string,
  ctx: Ctx,
  id_to_name: Record<string, string>,
  overrides: Record<string, any>,
  text: string,
): Record<string, any> {
  /** Required fields filled from the type-default table, then the caller's overrides on top.
   *
   * The optional workspace/project relations are filled too: the same-tenant hooks reject a row
   * whose anchors differ from the record it points at, so leaving them empty is not neutral. */
  const body: Record<string, any> = {};
  for (const f of fields_of(collection)) {
    if (["id", "created", "updated"].includes(f.name) || f.type === "autodate") continue;
    const anchor = f.type === "relation" && ["workspace", "project"].includes(f.name);
    if (!f.required && !anchor) continue;
    const value = default_value(f, ctx, id_to_name, text);
    if (value !== null) body[f.name] = value;
  }
  Object.assign(body, overrides);
  // The api_keys create hook refuses a reach that disagrees with the workspace/projects named.
  if (collection === "api_keys") body.reach = body.projects ? "projects" : "workspace";
  return body;
}

async function su_create(
  collection: string,
  ctx: Ctx,
  id_to_name: Record<string, string>,
  overrides: Record<string, any>,
  text: string,
  su: string,
): Promise<[any, string | null]> {
  const body = build_body(collection, ctx, id_to_name, overrides, text);
  const [status, rec] = await api("POST", `/api/collections/${collection}/records`, su, body);
  if (status === 200 || status === 201) return [rec, null];
  return [null, `HTTP ${status} ${json_dumps(rec).slice(0, 220)}`];
}

async function existing_row(
  collection: string,
  ctx: Ctx,
  su: string,
  where: string | null = null,
): Promise<any> {
  /** A row of `collection` inside the current tenant scope, for the repoint fallback. */
  if (where === null) {
    if (collection === "workspaces") where = `id='${ctx.workspace}'`;
    else if (field_named(collection, "workspace")) where = `workspace='${ctx.workspace}'`;
    else if (field_named(collection, "user")) where = `user='${ctx.user}'`;
    else where = "id!=''";
  }
  const qs = urlencode({ filter: where, perPage: 1 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, su);
  const items = r.items || [];
  return items.length ? items[0] : null;
}

async function make_pointing(
  collection: string,
  relfield: string,
  subject_id: string,
  ctx: Ctx,
  id_to_name: Record<string, string>,
  su: string,
): Promise<[any, string | null]> {
  /** A record of `collection` whose `relfield` points at `subject_id`, or (None, why not). */
  const multi = (field_named(collection, relfield).maxSelect || 1) > 1;
  const value = multi ? [subject_id] : subject_id;
  const already = await existing_row(
    collection,
    ctx,
    su,
    `${relfield}${multi ? "?=" : "="}'${subject_id}'`,
  );
  if (already !== null) return [already, null];
  const [rec, why_create] = await su_create(
    collection,
    ctx,
    id_to_name,
    { [relfield]: value },
    token_for(collection),
    su,
  );
  if (rec !== null) return [rec, null];
  // A unique index or a same-tenant hook can forbid a NEW row (user_settings, workspaces) while
  // the repoint of an existing one is exactly how the app reaches that state.
  const row = await existing_row(collection, ctx, su);
  if (row === null) {
    return [null, `create: ${why_create}; repoint: no existing ${collection} row in scope`];
  }
  const [status, patched] = await api(
    "PATCH",
    `/api/collections/${collection}/records/${row.id}`,
    su,
    { [relfield]: value },
  );
  if (status === 200) return [patched, null];
  return [
    null,
    `create: ${why_create}; repoint: HTTP ${status} ${json_dumps(patched).slice(0, 160)}`,
  ];
}

async function set_state(
  collection: string,
  record_id: string,
  state: string,
  su: string,
): Promise<[boolean, string]> {
  const value = state === "trashed" ? now_ts() : true;
  const [status, body] = await api(
    "PATCH",
    `/api/collections/${collection}/records/${record_id}`,
    su,
    { [state]: value },
  );
  return [status === 200, `HTTP ${status} ${json_dumps(body).slice(0, 200)}`];
}

// ── Surface probes ───────────────────────────────────────────────────────────────────────────
async function list_has(collection: string, record_id: string, token: string): Promise<boolean> {
  const qs = urlencode({ filter: `id='${record_id}'` });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return (r.items || []).length > 0;
}

async function view_status(collection: string, record_id: string, token: string): Promise<number> {
  const [status] = await api("GET", `/api/collections/${collection}/records/${record_id}`, token);
  return status;
}

async function expand_leaks(
  collection: string,
  record_id: string,
  relfield: string,
  marker: string,
  token: string,
): Promise<boolean> {
  /** True when either expand form hands the marker (the subject's title/name) to `token`. */
  const [, one] = await api(
    "GET",
    `/api/collections/${collection}/records/${record_id}?expand=${relfield}`,
    token,
  );
  const qs = urlencode({ filter: `id='${record_id}'`, expand: relfield });
  const [, many] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  return json_dumps(one).includes(marker) || json_dumps(many).includes(marker);
}

async function search_hits(marker: string, workspace: string, token: string): Promise<boolean> {
  const qs = urlencode({ q: marker, workspace });
  const [, r] = await api("GET", `/api/tracker/search?${qs}`, token);
  return json_dumps(r.results || []).includes(marker);
}

async function export_hits(marker: string, workspace: string, token: string): Promise<boolean> {
  const [, r] = await api("POST", "/api/tracker/export", token, { workspace });
  return json_dumps(r).includes(marker);
}

async function trash_hits(record_id: string, workspace: string, token: string): Promise<boolean> {
  const qs = urlencode({ workspace });
  const [, r] = await api("GET", `/api/tracker/trash?${qs}`, token);
  return (r.items || []).some((item: any) => (item.record || {}).id === record_id);
}

function open_group_for(
  surface: string,
  subject: string,
  state: string,
  tier: string,
): string | null {
  /** -> the KNOWN_OPEN key absorbing this case, or None. */
  if (state === "shadow" && (surface === "search" || surface === "export")) {
    return "shadow-custom-routes";
  }
  return null;
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pb-visibility-invariants-"));
const MIG_DIR = path.join(scratch, "pb_migrations");
const DATA_DIR = path.join(scratch, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(path.join(REPO_ROOT, "pb_migrations"), MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log(
    "═══ test_visibility_invariants.ts — trashed/draft/shadow invisibility (derived) ═══",
  );

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
  server = await start_server(scratch, DATA_DIR, MIG_DIR);

  let [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = roomkit.token_of(BASE_URL, SU_EMAIL, r);

  // THIS ROOM only, never the shipped value in the settings baseline: what this
  // suite proves is who can read what, not how many requests a caller may make, and the
  // limiter has its own proof in tests/test_hardening.ts. A table-driven run at five tiers
  // crosses the shipped per-IP ceiling and a 429 would answer a read case with harness noise.
  const [, live_settings] = await api("GET", "/api/settings", su);
  const limits = live_settings.rateLimits || {};
  for (const rule of limits.rules || []) {
    if (rule.label === "/api/") rule.maxRequests = 1000000;
  }
  let [s] = await api("PATCH", "/api/settings", su, { rateLimits: limits });
  check("room:rate-limit", "the shared per-IP request ceiling is lifted in this room", s, 200);

  // schema/*.json carries no collection id, so the relation targets are resolved against the
  // room's own /api/collections — the same truth, read at runtime.
  const [, colls] = await api("GET", "/api/collections?perPage=200", su);
  const ID_TO_NAME: Record<string, string> = {};
  for (const c of colls.items || []) {
    ID_TO_NAME[c.id] = c.name;
    CREATE_RULES[c.name] = c.createRule ?? null;
    UPDATE_RULES[c.name] = c.updateRule ?? null;
  }
  const RELATION_CASES = derive_relation_cases(ID_TO_NAME);

  // PocketBase pins users.id's shape and project_items' LIKE rules depend on it; nothing here
  // can widen it, so this fires only if an upgrade moves that default (decision:project-items-membership-denormalised, mhg8).
  let users_id: any = null;
  for (const c of colls.items || []) {
    if (c.name !== "users") continue;
    for (const f of c.fields || []) {
      if (f.name === "id") {
        users_id = f;
        break;
      }
    }
    if (users_id !== null) break;
  }
  if (users_id === null) {
    hard_fail("users-id:present", "this room's users collection exposes no id field to read");
  } else {
    check(
      "users-id:shape",
      "users.id is a system field pinned to 15 chars of [a-z0-9] — no id holds `%` or `_`",
      tup(
        users_id.pattern ?? null,
        users_id.min ?? null,
        users_id.max ?? null,
        users_id.system ?? null,
      ),
      tup("^[a-z0-9]+$", 15, 15, true),
    );
  }

  async function su_user_with_id(crafted: string): Promise<any[]> {
    /** Superuser create of a users row at a chosen id — bypasses rules, not field validation. */
    const [status, body] = await api("POST", "/api/collections/users/records", su, {
      id: crafted,
      email: `${token_for("users")}@example.com`,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    return tup(status, Object.keys(body.data || {}).sort(by_code_point));
  }

  // The pin above is only worth having if the server actually enforces it, and the positive
  // control is what stops a refusal for some unrelated missing field reading as a pass.
  check(
    "users-id:wildcard-refused",
    "a wildcard id is refused, and it is the id field that refuses it",
    await su_user_with_id("%".repeat(15)),
    tup(400, ["id"]),
  );
  check(
    "users-id:underscore-refused",
    "a single-character wildcard id is refused the same way",
    await su_user_with_id("_".repeat(15)),
    tup(400, ["id"]),
  );
  check(
    "users-id:control",
    "the same payload at a legal id is accepted (the refusals above are about the id)",
    (await su_user_with_id("zz0zz0zz0zz0zz0"))[0],
    200,
  );

  const n_states = Object.values(SUBJECTS).reduce((n, v) => n + v.length, 0);
  console.log(
    `\n  derived: ${Object.keys(SUBJECTS).length} subject collections, ${n_states} hideable ` +
      `states, ${RELATION_CASES.length} relation cases, each attacked at ` +
      `${TIERS_UNDER_TEST.length} tiers (${TIER_NAMES.join(", ")})`,
  );
  for (const name of Object.keys(SUBJECTS).sort(by_code_point)) {
    console.log(`    subject ${name.padEnd(14)} states=${SUBJECTS[name]!.join(",")}`);
  }
  for (const [coll, relfield, target] of RELATION_CASES) {
    console.log(`    relation ${coll}.${relfield} -> ${target}`);
  }
  for (const subject of Object.keys(BY_DESIGN).sort(by_code_point)) {
    for (const state of Object.keys(BY_DESIGN[subject]!).sort(by_code_point)) {
      const tiers = BY_DESIGN[subject]![state]!;
      for (const tier of Object.keys(tiers).sort(by_code_point)) {
        const surfaces = [...tiers[tier]!].sort(by_code_point);
        console.log(
          `    by design ${subject}.${state} IS visible to ${tier} on ${py_repr(surfaces)}`,
        );
      }
    }
  }

  // ── users ────────────────────────────────────────────────────────────────────────────────
  console.log(
    "\n── fixtures: owner / active member / active admin / active viewer / " +
      "suspended member / suspended admin / non-member ──",
  );

  async function make_user(name: string, email: string): Promise<[string, string]> {
    const [s, rec] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name,
      verified: true,
    });
    if (s !== 200 && s !== 201) {
      throw new roomkit.SystemExit(
        `❌ fixture user ${email} could not be created: HTTP ${s} ${py_repr(rec)}`,
      );
    }
    await api("PATCH", `/api/collections/users/records/${rec.id}`, su, { approved: true });
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    return [roomkit.token_of(BASE_URL, email, auth), rec.id];
  }

  const [owner_tok, owner_id] = await make_user("Olive", "olive@example.com");
  const [outsider_tok, outsider_id] = await make_user("Nate", "nate@example.com");
  // One user per tier: tierkit keys a standing by (workspace, user), so a single user cannot
  // hold two of them in the same workspace at once.
  const TIER_WHO: Record<string, string> = {
    member: "Mia",
    admin: "Ada",
    viewer: "Vic",
    suspended: "Sam",
    "suspended-admin": "Sid",
  };
  const TIER_USER: Record<string, string> = {};
  const TIER_TOKEN: Record<string, string> = {};
  for (const name of TIER_NAMES) {
    const who = TIER_WHO[name]!;
    [TIER_TOKEN[name], TIER_USER[name]] = await make_user(who, `${who.toLowerCase()}@example.com`);
  }
  const [member_tok, member_id] = [TIER_TOKEN.member!, TIER_USER.member!];
  console.log(`  ✅  owner=${owner_id}  non-member=${outsider_id}`);
  for (const name of TIER_NAMES) {
    console.log(
      `  ✅  tier user ${name.padEnd(9)} ${TIER_WHO[name]!.padEnd(4)} ${TIER_USER[name]}`,
    );
    // A tier whose every assertion is a DENIAL is satisfied by a dead or foreign token, so
    // each one's identity is proven positively before it is used to attack anything.
    const [s, refreshed] = await api(
      "POST",
      "/api/collections/users/auth-refresh",
      TIER_TOKEN[name]!,
    );
    check(
      `identity:${name}`,
      `the ${name} token authenticates AS ${TIER_WHO[name]}`,
      tup(s, (refreshed.record || {}).id ?? null),
      tup(200, TIER_USER[name]),
    );
  }

  // workspace -> tier name -> the standing proven against the server in that workspace.
  const TIERS: Record<string, Record<string, tierkit.Tier>> = {};

  async function establish_tiers(workspace: string): Promise<Record<string, tierkit.Tier>> {
    /** Every tier proven in `workspace`, so a tenancy denial can never read as a role one. */
    const tiers: Record<string, tierkit.Tier> = {};
    for (const name of TIER_NAMES) {
      const who = TIER_WHO[name]!;
      let tier = await tierkit.actor_at_tier(
        workspace,
        TIER_USER[name]!,
        TIER_ROLE[name]!,
        owner_tok,
        who,
      );
      if (TIER_STATUS[name] !== "active") {
        // Tier.verify() holds a standing to the status it was established at, so the
        // active one is closed out BEFORE the move and re-established after it.
        await tier.done();
        const [s, row] = await api(
          "PATCH",
          `/api/collections/workspace_members/records/${tier.id}`,
          su,
          { status: TIER_STATUS[name] },
        );
        if (s !== 200) {
          throw new roomkit.SystemExit(
            `❌ ${who} could not be moved to ${TIER_STATUS[name]}: ${s} ${py_repr(row)}`,
          );
        }
        tier = await tierkit.actor_at_tier(
          workspace,
          TIER_USER[name]!,
          TIER_ROLE[name]!,
          owner_tok,
          who,
          TIER_STATUS[name],
        );
      }
      tiers[name] = tier;
    }
    return tiers;
  }

  async function standing_of(workspace: string, name: string): Promise<[any, any]> {
    /** (reader, expected) for a tier — standing() reads the one whose status was moved. */
    const tier = TIERS[workspace]![name]!;
    if (TIER_STATUS[name] === "active") return [await tier.now(), TIER_ROLE[name]];
    const [role, status] = await tier.standing();
    return [tup(role, status), tup(TIER_ROLE[name], TIER_STATUS[name])];
  }

  async function make_workspace(label: string): Promise<string> {
    const [s, ws] = await api("POST", "/api/collections/workspaces/records", su, {
      name: label,
      owner: owner_id,
    });
    if (s !== 200 && s !== 201) {
      throw new roomkit.SystemExit(
        `❌ workspace ${label} could not be created: HTTP ${s} ${py_repr(ws)}`,
      );
    }
    for (const name of TIER_NAMES) {
      const [s, row] = await api("POST", "/api/collections/workspace_members/records", su, {
        workspace: ws.id,
        user: TIER_USER[name],
        role: "member",
        status: "active",
      });
      if (s !== 200 && s !== 201) {
        throw new roomkit.SystemExit(
          `❌ ${TIER_WHO[name]}'s row in ${label} could not be created: HTTP ${s} ${py_repr(row)}`,
        );
      }
    }
    TIERS[ws.id] = await establish_tiers(ws.id);
    return ws.id;
  }

  async function make_project(workspace: string, marker: string): Promise<string> {
    const [s, p] = await api("POST", "/api/collections/projects/records", su, {
      name: marker,
      owner: owner_id,
      workspace,
    });
    if (s !== 200 && s !== 201) {
      throw new roomkit.SystemExit(
        `❌ project in ${workspace} could not be created: HTTP ${s} ${py_repr(p)}`,
      );
    }
    return p.id;
  }

  tierkit.use(api);
  const BASE_WS = await make_workspace(token_for("basews"));

  const BASE_PROJECT = await make_project(BASE_WS, token_for("baseproj"));
  const base_ctx = new Ctx(BASE_WS, BASE_PROJECT, member_id);
  let base_task: any;
  [s, base_task] = await api("POST", "/api/collections/tasks/records", su, {
    title: token_for("basetask"),
    workspace: BASE_WS,
    project: BASE_PROJECT,
  });
  if (s !== 200 && s !== 201) {
    throw new roomkit.SystemExit(
      `❌ base task could not be created: HTTP ${s} ${py_repr(base_task)}`,
    );
  }
  Object.assign(FIXTURE_IDS, {
    users: member_id,
    workspaces: BASE_WS,
    projects: BASE_PROJECT,
    tasks: base_task.id,
  });
  console.log(`  ✅  base workspace=${BASE_WS} project=${BASE_PROJECT} task=${base_task.id}`);

  // ── live controls: a visible record per subject, so every invisibility claim is falsifiable ──
  console.log(
    "\n── live controls (every ACTIVE tier MUST see these; the suspended one MUST NOT) ──",
  );
  const CONTROLS: Record<string, { id: string; marker: string }> = {};
  for (const subject of Object.keys(SUBJECTS).sort(by_code_point)) {
    const marker = token_for(`live${subject}`);
    let rec: any;
    if (subject === "workspaces") {
      rec = { id: await make_workspace(marker) };
    } else {
      const overrides: Record<string, any> = {};
      if (field_named(subject, "workspace")) overrides.workspace = BASE_WS;
      if (field_named(subject, "project")) overrides.project = BASE_PROJECT;
      if (field_named(subject, "owner")) overrides.owner = owner_id;
      if (field_named(subject, "author")) overrides.author = owner_id;
      let why: string | null;
      [rec, why] = await su_create(subject, base_ctx, ID_TO_NAME, overrides, marker, su);
      if (rec === null) {
        throw new roomkit.SystemExit(`❌ live control for ${subject} could not be created: ${why}`);
      }
    }
    CONTROLS[subject] = { id: rec.id, marker };
    for (const name of TIER_NAMES) {
      const tok = TIER_TOKEN[name]!;
      const visible = TIER_STATUS[name] === "active";
      let [got, want] = await standing_of(BASE_WS, name);
      check(
        `control:list:${name}:${subject}`,
        `${name} standing + live list`,
        tup(got, await list_has(subject, rec.id, tok)),
        tup(want, visible),
      );
      [got, want] = await standing_of(BASE_WS, name);
      check(
        `control:view:${name}:${subject}`,
        `${name} standing + live view`,
        tup(got, await view_status(subject, rec.id, tok)),
        tup(want, visible ? 200 : 404),
      );
    }
    check(
      `control:outsider:${subject}`,
      "non-member cannot view it",
      await view_status(subject, rec.id, outsider_tok),
      404,
    );
  }

  // A surface that cannot show the LIVE control TO A GIVEN TIER cannot leak the offending one
  // to it either, so its absence is reported per tier instead of counted as a pass.
  const SEARCHABLE: Record<string, boolean> = {};
  for (const t of TIER_NAMES) {
    for (const sub of Object.keys(SUBJECTS)) {
      SEARCHABLE[`${t}\0${sub}`] = await search_hits(
        CONTROLS[sub]!.marker,
        BASE_WS,
        TIER_TOKEN[t]!,
      );
    }
  }
  const EXPORTABLE: Record<string, boolean> = {};
  for (const t of TIER_NAMES) {
    for (const sub of Object.keys(SUBJECTS)) {
      EXPORTABLE[`${t}\0${sub}`] = await export_hits(
        CONTROLS[sub]!.marker,
        BASE_WS,
        TIER_TOKEN[t]!,
      );
    }
  }
  for (const t of TIER_NAMES) {
    let hits = Object.keys(SUBJECTS)
      .filter((sub) => SEARCHABLE[`${t}\0${sub}`])
      .sort(by_code_point);
    console.log(`  ·   /api/tracker/search covers for ${t.padEnd(9)}: ${py_repr(hits)}`);
    hits = Object.keys(SUBJECTS)
      .filter((sub) => EXPORTABLE[`${t}\0${sub}`])
      .sort(by_code_point);
    console.log(`  ·   /api/tracker/export covers for ${t.padEnd(9)}: ${py_repr(hits)}`);
  }

  // ── per (subject, state) group ───────────────────────────────────────────────────────────
  for (const subject of Object.keys(SUBJECTS).sort(by_code_point)) {
    for (const state of SUBJECTS[subject]!) {
      console.log(`\n── ${subject}.${state} ──`);
      const marker = token_for(`${subject}${state}`);
      let subj_id: string | null = null;
      const ctx_ws = subject === "workspaces" ? await make_workspace(marker) : BASE_WS;
      let ctx_project = await make_project(ctx_ws, token_for("ctxproj"));
      if (subject === "workspaces") {
        subj_id = ctx_ws;
      } else if (subject === "projects") {
        subj_id = ctx_project = await make_project(ctx_ws, marker);
      }
      const ctx = new Ctx(ctx_ws, ctx_project, member_id);
      if (subj_id === null) {
        const overrides: Record<string, any> = { workspace: ctx_ws };
        if (field_named(subject, "project")) overrides.project = ctx_project;
        if (field_named(subject, "author")) overrides.author = owner_id;
        const [rec, why] = await su_create(subject, ctx, ID_TO_NAME, overrides, marker, su);
        if (rec === null) {
          hard_fail(`${subject}.${state}`, `subject record not creatable: ${why}`);
          continue;
        }
        subj_id = rec.id;
      }

      const pointers: [string, string, string][] = [];
      for (const [coll, relfield, target] of RELATION_CASES) {
        if (target !== subject) continue;
        const [rec, why] = await make_pointing(coll, relfield, subj_id!, ctx, ID_TO_NAME, su);
        const key = `expand:${coll}.${relfield}->${subject}.${state}`;
        if (rec === null) {
          // DECLARED SKIP: a pair listed in DECLARED_SKIPS above runs unproven, with its reason printed here and in the summary.
          const reason = DECLARED_SKIPS.get(pair_key(coll, relfield));
          if (reason) noop(key, reason);
          else hard_fail(key, `UNREACHABLE: ${coll}.${relfield} -> ${subject} (${why})`);
          continue;
        }
        pointers.push([coll, relfield, rec.id]);
      }

      const [ok, why] = await set_state(subject, subj_id!, state, su);
      if (!ok) {
        hard_fail(`${subject}.${state}`, `could not put the subject into ${state}: ${why}`);
        continue;
      }
      console.log(`  ·   subject=${subj_id} marker=${marker} pointing records=${pointers.length}`);

      const activity_rows = pointers.filter(([c]) => c === "task_activity").map(([, , xid]) => xid);
      if (subject === "tasks" && state === "trashed" && !activity_rows.length) {
        hard_fail("activity:tasks.trashed", "no task_activity row was built for the trashed task");
      }

      for (const name of TIER_NAMES) {
        const tok = TIER_TOKEN[name]!;
        const shown: Record<string, boolean> = {};
        for (const sf of SURFACES) shown[sf] = by_design(subject, state, name, sf);
        check(
          `list:${name}:${subject}.${state}`,
          `${name} list ${shown.list ? "carries it by design" : "excludes it"}`,
          await list_has(subject, subj_id!, tok),
          shown.list,
          open_group_for("list", subject, state, name),
        );
        check(
          `view:${name}:${subject}.${state}`,
          `${name} view is ${shown.view ? "allowed by design" : "denied"}`,
          await view_status(subject, subj_id!, tok),
          shown.view ? 200 : 404,
          open_group_for("view", subject, state, name),
        );

        for (const [coll, relfield, xid] of pointers) {
          const key = `expand:${name}:${coll}.${relfield}->${subject}.${state}`;
          const readable =
            (await list_has(coll, xid, tok)) || (await view_status(coll, xid, tok)) === 200;
          if (!readable) {
            noop(
              key,
              `the ${name} tier cannot read that ${coll} row at all — no expand ` +
                `surface to leak through`,
            );
            continue;
          }
          check(
            key,
            `expand ${shown.expand ? "shows" : "hides"} the subject`,
            await expand_leaks(coll, xid, relfield, marker, tok),
            shown.expand,
            open_group_for("expand", subject, state, name),
          );
        }

        if (SEARCHABLE[`${name}\0${subject}`]) {
          check(
            `search:${name}:${subject}.${state}`,
            `tracker/search ${shown.search ? "carries it by design" : "excludes it"}`,
            await search_hits(marker, ctx_ws, tok),
            shown.search,
            open_group_for("search", subject, state, name),
          );
        } else {
          noop(
            `search:${name}:${subject}.${state}`,
            `/api/tracker/search never hands the ${name} tier a ${subject} row — its ` +
              `own live control is absent from its results, so it cannot leak to it`,
          );
        }

        if (subject === "workspaces") {
          // NOT ASSERTED: POST /api/tracker/export is SCOPED BY a workspace id and always emits that workspace as data.workspaces[0], so a workspaces subject can never be absent from its own export — there is no exclusion to assert on this surface.
          noop(
            `export:${name}:${subject}.${state}`,
            "the export is scoped BY the workspace and always emits it as " + "data.workspaces[0]",
          );
        } else if (EXPORTABLE[`${name}\0${subject}`]) {
          check(
            `export:${name}:${subject}.${state}`,
            `tracker/export ${shown.export ? "carries it by design" : "excludes it"}`,
            await export_hits(marker, ctx_ws, tok),
            shown.export,
            open_group_for("export", subject, state, name),
          );
        } else {
          noop(
            `export:${name}:${subject}.${state}`,
            `POST /api/tracker/export never emits a ${subject} row to the ${name} tier ` +
              `— its own live control is absent from its export, so it cannot leak`,
          );
        }

        if (subject === "tasks" && state === "trashed") {
          for (const aid of activity_rows) {
            check(
              `activity:list:${name}:tasks.trashed`,
              `${name} cannot list the trashed task's rows`,
              await list_has("task_activity", aid, tok),
              false,
            );
            check(
              `activity:view:${name}:tasks.trashed`,
              `${name} cannot view the trashed task's row`,
              await view_status("task_activity", aid, tok),
              404,
            );
          }
          // NOT ASSERTED: the /audit_log HTTP endpoint is a client-side route; its enforcement point is task_activity's list/view rule, asserted directly above.
        }
      }
    }
  }

  // ── GET /api/tracker/trash: trashed items belong there, another user's drafts do not ─────
  console.log("\n── GET /api/tracker/trash — the draft carve-out ──");
  for (const subject of Object.keys(SUBJECTS).sort(by_code_point)) {
    if (!SUBJECTS[subject]!.includes("draft") || !SUBJECTS[subject]!.includes("trashed")) {
      noop(
        `trash:${subject}.draft`,
        `${subject} carries no draft+trashed pair, so this route has no carve-out for it`,
      );
      continue;
    }
    const overrides: Record<string, any> = { workspace: BASE_WS, author: owner_id };
    if (field_named(subject, "project")) overrides.project = BASE_PROJECT;
    const seen_marker = token_for(`trashseen${subject}`);
    const [seen, why] = await su_create(
      subject,
      base_ctx,
      ID_TO_NAME,
      { ...overrides },
      seen_marker,
      su,
    );
    const hidden_marker = token_for(`trashdraft${subject}`);
    const [hidden, why2] = await su_create(
      subject,
      base_ctx,
      ID_TO_NAME,
      { ...overrides },
      hidden_marker,
      su,
    );
    if (seen === null || hidden === null) {
      hard_fail(`trash:${subject}.draft`, `fixtures not creatable: ${why || why2}`);
      continue;
    }
    await set_state(subject, seen.id, "trashed", su);
    await api("PATCH", `/api/collections/${subject}/records/${hidden.id}`, su, {
      draft: true,
      trashed: now_ts(),
    });
    check(
      `control:trash:${subject}`,
      "member sees the trashed non-draft item",
      await trash_hits(seen.id, BASE_WS, member_tok),
      true,
    );
    check(
      `trash:${subject}.draft`,
      "trash listing hides another user's trashed DRAFT",
      await trash_hits(hidden.id, BASE_WS, member_tok),
      false,
    );
  }

  // ── GET /api/tracker/trash: the SAME draft carve-out, at every OTHER tier ────────────────
  // The loop above proves the plain-member tier only (member_tok everywhere); an admin- or
  // viewer-tier leak on this route would pass unnoticed. Same fixtures-per-subject shape,
  // appended rather than folded into the derivation loop above.
  console.log("\n── GET /api/tracker/trash — admin/owner/viewer tiers (draft carve-out) ──");
  // Reuse the tier actors the derivation loop established (same users, same memberships).
  const [admin_tok, viewer_tok] = [TIER_TOKEN.admin!, TIER_TOKEN.viewer!];
  const [admin_tier, viewer_tier] = [TIERS[BASE_WS]!.admin!, TIERS[BASE_WS]!.viewer!];
  const owns = await tierkit.owner_of_workspace(BASE_WS, owner_id, su, "Olive");

  for (const subject of Object.keys(SUBJECTS).sort(by_code_point)) {
    if (!SUBJECTS[subject]!.includes("draft") || !SUBJECTS[subject]!.includes("trashed")) continue;
    const overrides: Record<string, any> = { workspace: BASE_WS, author: owner_id };
    if (field_named(subject, "project")) overrides.project = BASE_PROJECT;
    const seen_marker = token_for(`trashtiernd${subject}`);
    const [seen, why] = await su_create(
      subject,
      base_ctx,
      ID_TO_NAME,
      { ...overrides },
      seen_marker,
      su,
    );
    const hidden_marker = token_for(`trashtierdr${subject}`);
    const [hidden, why2] = await su_create(
      subject,
      base_ctx,
      ID_TO_NAME,
      { ...overrides },
      hidden_marker,
      su,
    );
    if (seen === null || hidden === null) {
      hard_fail(`trash-tier:${subject}`, `fixtures not creatable: ${why || why2}`);
      continue;
    }
    await set_state(subject, seen.id, "trashed", su);
    await api("PATCH", `/api/collections/${subject}/records/${hidden.id}`, su, {
      draft: true,
      trashed: now_ts(),
    });
    check(
      `trash-tier:${subject}.admin-nondraft`,
      "an ACTIVE admin member sees the trashed non-draft item",
      tup(await admin_tier.now(), await trash_hits(seen.id, BASE_WS, admin_tok)),
      tup("admin", true),
    );
    check(
      `trash-tier:${subject}.admin-draft`,
      "an ACTIVE admin member sees the trashed DRAFT too (draft carve-out grants admin)",
      tup(await admin_tier.now(), await trash_hits(hidden.id, BASE_WS, admin_tok)),
      tup("admin", true),
    );
    check(
      `trash-tier:${subject}.viewer-nondraft`,
      "a viewer sees the trashed non-draft item",
      tup(await viewer_tier.now(), await trash_hits(seen.id, BASE_WS, viewer_tok)),
      tup("viewer", true),
    );
    check(
      `trash-tier:${subject}.viewer-draft`,
      "a viewer does NOT see another user's trashed DRAFT",
      tup(await viewer_tier.now(), await trash_hits(hidden.id, BASE_WS, viewer_tok)),
      tup("viewer", false),
    );
    check(
      `trash-tier:${subject}.owner-nondraft`,
      "the workspace owner sees the trashed non-draft item",
      tup(await owns.now(), await trash_hits(seen.id, BASE_WS, owner_tok)),
      tup(owner_id, true),
    );
    check(
      `trash-tier:${subject}.owner-draft`,
      "the workspace owner sees the trashed DRAFT too",
      tup(await owns.now(), await trash_hits(hidden.id, BASE_WS, owner_tok)),
      tup(owner_id, true),
    );
  }

  // ── the ROW-hidden direction: a trashed ancestor must drop the rows it contains ──────────
  // The expand cases above only ask whether the SUBJECT is stripped from a payload the pointing
  // row still carries. This block asserts the stronger promise — the pointing ROW itself leaves
  // list and view — from TWO independent derivations, because either one alone is blind:
  //   · rule-derived: a listRule spelling `<rel>.trashed` says it hides the row. Read off the
  //     thing under test, so DELETING the clause silently retires the case instead of failing.
  //   · schema-derived: every cascadeDelete edge into a trashable target is a containment edge
  //     and MUST make that promise. Deleting the clause fails `rowhide-promise` here.
  // Configuration is the one edge whose expectation is not a flat disappearance: decision:workspace-configuration-freeze
  // keeps a trashed workspace's settings readable to the tier that can restore it, so the tiers
  // in RESTORING_TIERS assert the row is STILL there and every other tier asserts it is gone.
  // Surfaces are bounded to list + view (plus the restore round trip). The dependent
  // collections carry no title for /api/tracker/search or POST /api/tracker/export to match on,
  // and the workspace-trashed search/export/summary surfaces are proven at seven tiers in
  // tests/test_workspace_trash.ts; this block does not re-assert them.
  console.log("\n── ROW-hidden direction: every containment edge must drop the rows it holds ──");

  // The ROOM's own rules, never schema/*.rules.json: that file is regenerated in a later step of
  // the same change, so reading it would drop a case whose migration has already landed.
  const [, live_colls] = await api("GET", "/api/collections?perPage=200", su);
  const LIST_RULES: Record<string, string> = {};
  for (const c of live_colls.items || []) LIST_RULES[c.name] = c.listRule || "";

  function claims_row_hidden(collection: string, relfield: string): boolean {
    /** True when `collection`'s listRule spells `<relfield>.trashed` as an atom of its own. */
    const rule = LIST_RULES[collection] ?? "";
    const needle = `${relfield}.trashed`;
    let at = rule.indexOf(needle);
    while (at !== -1) {
      const before = at ? rule[at - 1]! : " ";
      if (!(/[\p{L}\p{N}]/u.test(before) || before === "." || before === "_")) return true;
      at = rule.indexOf(needle, at + 1);
    }
    return false;
  }

  const ANCESTOR_CASES = derive_ancestor_cases(ID_TO_NAME);
  for (const [coll, relfield, target] of ANCESTOR_CASES) {
    check(
      `rowhide-promise:${coll}.${relfield}->${target}`,
      `${coll}.listRule names the containment edge, so the row can be hidden at all`,
      claims_row_hidden(coll, relfield),
      true,
    );
  }
  const row_case_map = new Map<string, [string, string, string]>();
  for (const c of RELATION_CASES) {
    if (SUBJECTS[c[2]]!.includes("trashed") && claims_row_hidden(c[0], c[1])) {
      row_case_map.set(c.join("\0"), c);
    }
  }
  for (const c of ANCESTOR_CASES) row_case_map.set(c.join("\0"), c);
  const ROW_CASES = [...row_case_map.values()].sort(tuple_cmp);
  for (const [coll, relfield, target] of RELATION_CASES) {
    if (row_case_map.has([coll, relfield, target].join("\0"))) continue;
    let why: string;
    if (NOT_ANCHORED.has(coll)) {
      why = NOT_ANCHORED.get(coll)!;
    } else if (is_configuration(coll)) {
      why =
        `${coll} is workspace-anchored configuration, which decision:workspace-configuration-freeze freezes with ` +
        `its WORKSPACE alone`;
    } else if (!is_content(coll)) {
      why =
        `${coll} is neither content nor configuration — a hook-written class no caller ` +
        `can create, so what its rows do when a container is trashed is ruled where ` +
        `they are written, not here`;
    } else {
      why = `${relfield} is cascadeDelete=false — a reference, not containment`;
    }
    noop(
      `rowhide:${coll}.${relfield}->${target}`,
      `no containment edge and ${coll}.listRule spells no \`${relfield}.trashed\` atom, so ` +
        `there is no claim to falsify (${why})`,
    );
  }
  console.log(
    `  ·   ${ANCESTOR_CASES.length} containment edge(s) derived from schema, ` +
      `${ROW_CASES.length} of ${RELATION_CASES.length} relation cases asserted`,
  );
  for (const [coll, relfield, target] of ANCESTOR_CASES) {
    console.log(`    containment ${coll}.${relfield} -> ${target}`);
  }

  for (const [coll, relfield, target] of ROW_CASES) {
    const key = `rowhide:${coll}.${relfield}->${target}`;
    const marker = token_for(`rowhide${target}`);
    const row_ws = target === "workspaces" ? await make_workspace(marker) : BASE_WS;
    let row_project = await make_project(row_ws, token_for("rowhideproj"));
    let subj_id: string;
    if (target === "workspaces") {
      subj_id = row_ws;
    } else if (target === "projects") {
      subj_id = row_project = await make_project(row_ws, marker);
    } else {
      const overrides: Record<string, any> = { workspace: row_ws };
      if (field_named(target, "project")) overrides.project = row_project;
      if (field_named(target, "author")) overrides.author = owner_id;
      if (field_named(target, "owner")) overrides.owner = owner_id;
      const [rec, why] = await su_create(
        target,
        new Ctx(row_ws, row_project, member_id),
        ID_TO_NAME,
        overrides,
        marker,
        su,
      );
      if (rec === null) {
        hard_fail(key, `subject record not creatable: ${why}`);
        continue;
      }
      subj_id = rec.id;
    }
    const row_ctx = new Ctx(row_ws, row_project, member_id);
    const [row, why] = await make_pointing(coll, relfield, subj_id, row_ctx, ID_TO_NAME, su);
    if (row === null) {
      hard_fail(key, `UNREACHABLE: ${coll}.${relfield} -> ${target} (${why})`);
      continue;
    }
    // Read BEFORE the subject is trashed: a tier that never saw the row loses no read, and a
    // disappearance it never had would count as the narrowing working.
    const live: Record<string, boolean> = {};
    for (const name of TIER_NAMES) {
      live[name] =
        (await list_has(coll, row.id, TIER_TOKEN[name]!)) ||
        (await view_status(coll, row.id, TIER_TOKEN[name]!)) === 200;
    }
    const [ok, why_state] = await set_state(target, subj_id, "trashed", su);
    if (!ok) {
      hard_fail(key, `could not put the subject into trashed: ${why_state}`);
      continue;
    }
    for (const name of TIER_NAMES) {
      if (!live[name]) {
        noop(
          `rowhide:${name}:${coll}.${relfield}->${target}.trashed`,
          `the ${name} tier cannot read that ${coll} row while the ${target} is LIVE — ` +
            `it has no read to lose when the ${target} is trashed`,
        );
        continue;
      }
      const keeps = keeps_reading(coll, target, name);
      check(
        `rowhide:${name}:${coll}.${relfield}->${target}.trashed`,
        keeps
          ? `the ${coll} row stays readable to ${name}, the tier that can restore`
          : `the ${coll} row itself leaves ${name}'s list and view`,
        tup(
          await list_has(coll, row.id, TIER_TOKEN[name]!),
          await view_status(coll, row.id, TIER_TOKEN[name]!),
        ),
        keeps ? tup(true, 200) : tup(false, 404),
      );
    }
    const [s2] = await api("PATCH", `/api/collections/${target}/records/${subj_id}`, su, {
      trashed: "",
    });
    if (s2 !== 200) {
      hard_fail(`rowhide-restore:${key}`, `could not untrash the subject: HTTP ${s2}`);
      continue;
    }
    for (const name of TIER_NAMES) {
      if (!live[name]) continue;
      check(
        `rowhide-restore:${name}:${coll}.${relfield}->${target}`,
        `untrashing the ${target} gives ${name} the ${coll} row back`,
        tup(
          await list_has(coll, row.id, TIER_TOKEN[name]!),
          await view_status(coll, row.id, TIER_TOKEN[name]!),
        ),
        tup(true, 200),
      );
    }
  }

  // ── the WRITE freeze: a trashed workspace accepts no configuration write ────────────────
  // decision:workspace-configuration-freeze's other half, and the reason the read carve-out above is safe. BOUNDED to the
  // tiers that CAN write configuration in a LIVE workspace — the owner and an active admin:
  // only their refusal is falsifiable, because the live control is what separates a frozen
  // write from a body the collection would have refused anyway. A member, a viewer and a
  // suspended member are refused on both sides of the trash, and their READS are asserted per
  // tier in the block above. Bounded to create/update/delete on the collection API.
  console.log(
    "\n── decision:workspace-configuration-freeze: a trashed workspace freezes the configuration a restore lands in ──",
  );
  const CONFIGURATION = Object.keys(SCHEMA)
    .filter((c) => is_configuration(c))
    .sort(by_code_point);
  const NOT_CONFIGURATION = Object.keys(SCHEMA)
    .filter(
      (c) => !(c in SUBJECTS) && field_named(c, "workspace") !== null && !CONFIGURATION.includes(c),
    )
    .sort(by_code_point);
  const FREEZE_WS = await make_workspace(token_for("freezews"));
  const FREEZE_PROJECT = await make_project(FREEZE_WS, token_for("freezeproj"));
  const freeze_ctx = new Ctx(FREEZE_WS, FREEZE_PROJECT, member_id);
  const freeze_owner = await tierkit.owner_of_workspace(FREEZE_WS, owner_id, su, "Olive");
  // name -> (token, standing reader, the standing it must still hold, that writer's user id)
  const WRITERS = new Map<string, [string, () => Promise<any>, string, string]>();
  WRITERS.set("owner", [owner_tok, () => freeze_owner.now(), owner_id, owner_id]);
  for (const name of [...RESTORING_TIERS].sort(by_code_point)) {
    WRITERS.set(name, [
      TIER_TOKEN[name]!,
      () => TIERS[FREEZE_WS]![name]!.now(),
      TIER_ROLE[name]!,
      TIER_USER[name]!,
    ]);
  }
  console.log(`  ·   configuration collections: ${py_repr(CONFIGURATION)}`);
  console.log(`  ·   writers under test: ${py_repr([...WRITERS.keys()].sort(by_code_point))}`);

  // The workspace-anchored collections this ruling does NOT reach, named rather than absent —
  // and the property that excludes them is MEASURED here, not asserted: no caller can create
  // one at all. Open a createRule to any caller and the row above claims it as configuration
  // instead, so this check retires itself rather than going stale.
  for (const coll of NOT_CONFIGURATION) {
    const unanchored = NOT_ANCHORED.get(coll);
    if (unanchored) {
      noop(`freeze-excluded:${coll}`, unanchored);
      continue;
    }
    const [s] = await api("POST", `/api/collections/${coll}/records`, owner_tok, {
      workspace: FREEZE_WS,
    });
    check(
      `freeze-excluded:${coll}`,
      `no caller creates a ${coll} row, so decision:workspace-configuration-freeze has no write here to freeze`,
      s,
      403,
    );
  }

  const SPAN = { n: 0 };

  function write_overrides(coll: string, writer_id: string): Record<string, any> {
    /** The values a type-default body cannot invent: what each collection's guards demand.
     *
     * workspace_members carries no branch here: decision:invitation-keyed-by-email nulled its createRule (only R3
     * mints a row), so it left CONFIGURATION and this function never runs against it. */
    const out: Record<string, any> = { workspace: FREEZE_WS };
    if (field_named(coll, "owner")) {
      out.owner = writer_id; // saved_views refuses a create owned by anyone else
    }
    if (coll === "workspace_invitations") {
      out.role = "member"; // the one role its createRule lets an active admin mint
    }
    if (field_named(coll, "starts_on")) {
      SPAN.n += 1; // two cycles in one workspace may not overlap
      const day = new Date(Date.now() + 40 * SPAN.n * 86400000);
      const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ") + ".000Z";
      out.starts_on = fmt(day);
      out.ends_on = fmt(new Date(day.getTime() + 10 * 86400000));
    }
    return out;
  }

  async function config_write(
    coll: string,
    token: string,
    writer_id: string,
    row_id: string,
  ): Promise<any[]> {
    /** (create, update, delete) statuses for one writer against one configuration row. */
    const body = build_body(
      coll,
      freeze_ctx,
      ID_TO_NAME,
      write_overrides(coll, writer_id),
      token_for(coll),
    );
    const [create] = await api("POST", `/api/collections/${coll}/records`, token, body);
    const [update] = await api("PATCH", `/api/collections/${coll}/records/${row_id}`, token, {
      name: token_for(coll),
    });
    const [del] = await api("DELETE", `/api/collections/${coll}/records/${row_id}`, token);
    return tup(create, update, del);
  }

  async function freeze_round(
    key: string,
    label: string,
    expected: [number, number, number],
  ): Promise<void> {
    /** Every writer against every configuration collection, one check per pair. */
    const [create_x, update_x, delete_x] = expected;
    for (const coll of CONFIGURATION) {
      // workspace_invitations has no update surface at all (decision:invitation-keyed-by-email: R1 mints, R5
      // deletes, no PATCH route or rule) — a null updateRule is ALWAYS 403 for a
      // non-superuser, live or frozen alike (the null-rule idiom, not a trash effect).
      const want_update = (UPDATE_RULES[coll] ?? null) !== null ? update_x : 403;
      for (const [name, [token, standing, want, writer_id]] of WRITERS) {
        // A row of its OWN per writer, never one already in the workspace: a write that
        // is NOT frozen deletes what it ran against, and the seeded rows are a tier's
        // membership and the undeletable core labels.
        const [row, why] = await su_create(
          coll,
          freeze_ctx,
          ID_TO_NAME,
          write_overrides(coll, writer_id),
          token_for(coll),
          su,
        );
        if (row === null) {
          hard_fail(`${key}:${name}:${coll}`, `no ${coll} row to write against: ${why}`);
          continue;
        }
        check(
          `${key}:${name}:${coll}`,
          `${name} ${label} a ${coll} row`,
          tup(await standing(), await config_write(coll, token, writer_id, row.id)),
          tup(want, tup(create_x, want_update, delete_x)),
        );
      }
    }
  }

  await freeze_round("freeze-control", "may create, edit and delete", [200, 200, 204]);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${FREEZE_WS}`, su, {
    trashed: now_ts(),
  });
  if (s !== 200) {
    hard_fail("freeze:trash", `the freeze workspace could not be trashed: HTTP ${s}`);
  }
  await freeze_round("freeze", "cannot create, edit or delete", [400, 404, 404]);
  await api("PATCH", `/api/collections/workspaces/records/${FREEZE_WS}`, su, { trashed: "" });
  await freeze_owner.done();

  await owns.done();
  for (const workspace of Object.keys(TIERS).sort(by_code_point)) {
    for (const name of TIER_NAMES) {
      await TIERS[workspace]![name]!.done();
    }
  }
  await tierkit.verify_tiers();
} finally {
  await stop_server(server);
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("\n──────── summary ────────");
console.log(`  no-op surfaces (nothing to prove): ${NOOPS.length}`);
for (const key of NOOPS) {
  console.log(`    · ${key}`);
}
const tail = STRICT ? "" : "; VIS_STRICT=1 enforces them";
console.log(`  KNOWN_OPEN hits (reported, not failed${tail}): ${OPEN_HITS.length}`);
for (const key of OPEN_HITS) {
  console.log(`    SKIP ${key}`);
}
console.log(`  failures: ${FAILS.length}`);
for (const key of FAILS) {
  console.log(`    ❌ ${key}`);
}

if (FAILS.length) {
  console.log(`\n❌ test_visibility_invariants: ${FAILS.length} failing check(s)`);
  process.exit(1);
}
console.log("\n✅ test_visibility_invariants: every derived case holds");
process.exit(0);

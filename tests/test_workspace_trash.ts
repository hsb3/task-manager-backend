#!/usr/bin/env bun
/**
 * E2E proof that a trashed workspace is unreadable, frozen, and restorable by owner or admin.
 *
 * workspaces.viewRule carries the `trashed = ""` clause its listRule already had, so a trashed
 * workspace is invisible on every collection read surface. GET /api/tracker/workspaces/trash (a
 * custom route, so it BYPASSES collection rules) enumerates it for the owner AND for an ACTIVE
 * ADMIN (decision:workspace-trash-cascades R2), and restore is a plain owner-or-active-admin PATCH under the untouched
 * updateRule. Section 9 proves decision:workspace-trash-cascades R1: the trash CASCADES — every item, view, derived row
 * and custom route under the workspace answers as an unknown id until the workspace is restored,
 * which the rules DERIVE from `workspace.trashed` rather than stamping anything per item.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures built by name.
 * Port 8119 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as roomkit from "./roomkit.ts";
import { stop_server } from "./suitekit.ts";
import * as tierkit from "./tierkit.ts";
import {
  getitem,
  by_code_point,
  json_dumps,
  run_checked,
  py_repr,
  py_str,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8119 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";
const TRASH_ROUTE = "/api/tracker/workspaces/trash";

// Section (10) only, written into a hooks COPY at run time — never into pb_hooks/. The route is a
// writer no record-request hook fires for; the delete guard is the mid-cleanup failure section
// (10b) needs, keyed on a task title no other section uses.
const PROBE_HOOK = `/// <reference path="../pb_data/types.d.ts" />
// PROBE ONLY (tests/test_workspace_trash.ts section 10) — never shipped.
routerAdd(
  "POST",
  "/api/probe/programmatic-trash/{id}",
  (e) => {
    var rec = e.app.findRecordById("workspaces", e.request.pathValue("id"));
    rec.set("trashed", new Date().toISOString().replace("T", " "));
    e.app.save(rec);
    return e.json(200, { ok: true });
  },
  $apis.requireSuperuserAuth(),
);
onRecordDelete((e) => {
  var tid = e.record.get("task");
  if (tid) {
    var t = e.app.findRecordById("tasks", tid);
    if (String(t.get("title")).indexOf("boomtask") === 0) {
      throw new Error("probe: injected cleanup failure");
    }
  }
  e.next();
}, "notifications");
`;

let failures = 0;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s); // Python b'...' literal

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(66)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  let r: Response;
  let raw: string;
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  return [r.status, raw ? JSON.parse(raw) : {}];
}

function start_server(
  data_dir: string,
  migrations_dir: string,
  hooks: string | null = null,
): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, hooks || roomkit.hooks_dir(S));
}

function now_ts(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ") + ".000Z";
}

function from_keys(keys: readonly string[], value: any): Record<string, any> {
  return Object.fromEntries(keys.map((k) => [k, value]));
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-workspace-trash-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log("════════ test_workspace_trash.ts — workspace trash: cascade + restore ════════");
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
  let [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = roomkit.token_of(BASE_URL, SU_EMAIL, r);

  // ── fixtures: owner / active member / suspended member / non-member ─────────
  console.log("\n── fixtures ──");

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
        `❌ fixture user ${email} not created: HTTP ${s} ${py_str(rec)}`,
      );
    }
    await api("PATCH", `/api/collections/users/records/${getitem(rec, "id")}`, su, {
      approved: true,
    });
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    return [roomkit.token_of(BASE_URL, email, auth), getitem(rec, "id")];
  }

  const [olive, olive_id] = await make_user("Olive", "olive@example.com");
  const [adam, adam_id] = await make_user("Adam", "adam@example.com");
  const [mia, mia_id] = await make_user("Mia", "mia@example.com");
  const [vic, vic_id] = await make_user("Vic", "vic@example.com");
  const [sam, sam_id] = await make_user("Sam", "sam@example.com");
  const [nate, nate_id] = await make_user("Nate", "nate@example.com");
  check(
    "six fixture users exist",
    [olive_id, adam_id, mia_id, vic_id, sam_id, nate_id].every((x) => truthy(x)),
    true,
  );

  // A unique apostrophe-free marker: finding it in ANY response body IS the leak.
  const WS_NAME = "edc3wsnamesecret";
  let s: number;
  let ws: any;
  [s, ws] = await api("POST", "/api/collections/workspaces/records", olive, {
    name: WS_NAME,
    owner: olive_id,
  });
  check("Olive creates the workspace under test", s, 200);
  const WS = getitem(ws, "id");

  for (const [uid, role, status] of [
    [adam_id, "admin", "active"],
    [mia_id, "member", "active"],
    [vic_id, "viewer", "active"],
    [sam_id, "member", "suspended"],
  ]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS,
      user: uid,
      role,
      status,
    });
    check(`membership row (${role}/${status}) created`, s, 200);
  }

  tierkit.use(api);
  const owns = await tierkit.owner_of_workspace(WS, olive_id, su, "Olive");
  const adam_tier = await tierkit.actor_at_tier(WS, adam_id, "admin", su, "Adam");
  const mia_tier = await tierkit.actor_at_tier(WS, mia_id, "member", su, "Mia");
  const vic_tier = await tierkit.actor_at_tier(WS, vic_id, "viewer", su, "Vic");
  const sam_tier = await tierkit.actor_at_tier(WS, sam_id, "member", su, "Sam", "suspended");

  // Olive's own auto-provisioned workspace stays LIVE — the control that keeps every
  // "absent from the trash route" assertion falsifiable.
  const live: string[] = (
    (await api("GET", "/api/collections/workspaces/records?perPage=200", olive))[1].items ?? []
  )
    .filter((w: any) => getitem(w, "id") !== WS)
    .map((w: any) => getitem(w, "id"));
  check("Olive also owns a LIVE control workspace", live.length > 0, true);
  const LIVE_WS = live[0]!;

  async function view(ws_id: string, token: string | null): Promise<number> {
    return (await api("GET", `/api/collections/workspaces/records/${ws_id}`, token))[0];
  }

  async function lists(ws_id: string, token: string | null): Promise<boolean> {
    const qs = urlencode({ filter: `id='${ws_id}'` });
    const [, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, token);
    return truthy(r.items);
  }

  function trash_route(token: string | null): Promise<[number, any]> {
    return api("GET", TRASH_ROUTE, token);
  }

  async function trash_ids(token: string | null): Promise<string[]> {
    const [, r] = await trash_route(token);
    return (r.items ?? []).map((w: any) => getitem(w, "id")).sort(by_code_point);
  }

  /**
   * (status, the (id, name, trashed) triple the export emits for that workspace, or None).
   *
   * POST /api/tracker/export BYPASSES collection rules and its own reads run in superuser
   * context, so what it emits is not gated by the narrowed viewRule (F2).
   */
  async function export_ws(ws_id: string, token: string | null): Promise<[number, any]> {
    const [s, r] = await api("POST", "/api/tracker/export", token, { workspace: ws_id });
    const rows: any[] = (r.data ?? {}).workspaces ?? [];
    const row = rows.find((w) => w.id === ws_id);
    return tup(
      s,
      row === undefined ? null : tup(getitem(row, "id"), row.name ?? null, row.trashed ?? null),
    );
  }

  /**
   * (status, body) for an empty-body POST .../vocab — no statuses/labels means
   * no write is attempted, so this probes only the trashed guard, never the mutation.
   */
  function vocab_ws(ws_id: string, token: string | null): Promise<[number, any]> {
    return api("POST", `/api/tracker/workspaces/${ws_id}/vocab`, token, {});
  }

  /**
   * The response BODY AS BYTES for any POST — a 404 that only matches after parsing
   * can still differ in message, key order or whitespace from the one it must match.
   */
  async function post_raw(path: string, token: string, payload: any): Promise<Uint8Array> {
    const resp = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: json_dumps(payload),
    });
    return new Uint8Array(await resp.arrayBuffer());
  }

  /**
   * The response BODY AS BYTES. Parsing first would compare two dicts, which cannot
   * fail on key order, whitespace or a trailing newline — the AC is about the bytes.
   */
  async function vocab_ws_raw(ws_id: string, token: string): Promise<Uint8Array> {
    const resp = await fetch(`${BASE_URL}/api/tracker/workspaces/${ws_id}/vocab`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: "{}",
    });
    return new Uint8Array(await resp.arrayBuffer());
  }

  // ══════════ (1) BEFORE the trash — the reads that must later stop ═══════════
  console.log("\n── (1) live workspace: the controls that make every exclusion falsifiable ──");
  check(
    "Olive (owner) views it → 200",
    tup(await owns.now(), await view(WS, olive)),
    tup(olive_id, 200),
  );
  check(
    "Mia (active member) views it → 200",
    tup(await mia_tier.now(), await view(WS, mia)),
    tup("member", 200),
  );
  check("Olive lists it", await lists(WS, olive), true);
  check("Mia lists it", await lists(WS, mia), true);
  check("Nate (non-member) views it → 404", await view(WS, nate), 404);
  check("trash route is empty while nothing is trashed", await trash_ids(olive), []);

  // THE regression control for the export refusal added in section (5): the SAME workspace,
  // the SAME roster, exported while LIVE. Each of these must still hold after the fix.
  const LIVE_EXPECTED = tup(WS, WS_NAME, "");
  check(
    "LIVE export — Olive (owner) → 200 with the record",
    await export_ws(WS, olive),
    tup(200, LIVE_EXPECTED),
  );
  check(
    "LIVE export — Adam (active admin) → 200 with the record",
    tup(await adam_tier.now(), ...(await export_ws(WS, adam))),
    tup("admin", 200, LIVE_EXPECTED),
  );
  check(
    "LIVE export — Mia (active member) → 200 with the record",
    tup(await mia_tier.now(), ...(await export_ws(WS, mia))),
    tup("member", 200, LIVE_EXPECTED),
  );
  check(
    "LIVE export — Vic (viewer) → 200 with the record",
    tup(await vic_tier.now(), ...(await export_ws(WS, vic))),
    tup("viewer", 200, LIVE_EXPECTED),
  );
  check(
    "LIVE export — Sam (suspended) → 404",
    tup(tup(...(await sam_tier.standing())), (await export_ws(WS, sam))[0]),
    tup(tup("member", "suspended"), 404),
  );
  check("LIVE export — Nate (non-member) → 404", (await export_ws(WS, nate))[0], 404);
  check("LIVE export — anonymous → 401", (await export_ws(WS, null))[0], 401);

  // ══════════ (2) trash it through the app path (owner DELETE) ════════════════
  console.log("\n── (2) owner DELETE → soft trash ──");
  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, olive);
  check("Olive DELETEs the workspace → 204 (delete-to-trash)", s, 204);
  const [, stored] = await api("GET", `/api/collections/workspaces/records/${WS}`, su);
  check("the record still exists and carries a trashed stamp", truthy(stored.trashed), true);

  // ══════════ (3) the viewRule narrowing (this wave's migration) ══════════════
  console.log("\n── (3) a trashed workspace is unreadable on the collection surface ──");
  check(
    "Olive (owner) views it → 404",
    tup(await owns.now(), await view(WS, olive)),
    tup(olive_id, 404),
  );
  check(
    "Mia (active member) views it → 404",
    tup(await mia_tier.now(), await view(WS, mia)),
    tup("member", 404),
  );
  check("Nate (non-member) views it → 404", await view(WS, nate), 404);
  check("Olive's list excludes it", await lists(WS, olive), false);
  check("Mia's list excludes it", await lists(WS, mia), false);
  check("Olive still views her LIVE control workspace → 200", await view(LIVE_WS, olive), 200);

  // ══════════ (4) the new route: owner OR active admin, no existence leak ═════
  // COVERS: route:GET /api/tracker/workspaces/trash
  console.log("\n── (4) GET /api/tracker/workspaces/trash — role matrix ──");
  check("anonymous → 401", (await trash_route(null))[0], 401);
  let owner_body: any;
  [s, owner_body] = await trash_route(olive);
  check("Olive (owner) → 200", s, 200);
  check("Olive's trash lists exactly the trashed workspace", await trash_ids(olive), [WS]);
  check(
    "…and the LIVE control workspace is absent from it",
    (await trash_ids(olive)).includes(LIVE_WS),
    false,
  );
  check("the route reports its own count", owner_body.count ?? null, 1);

  const [s_adam] = await trash_route(adam);
  check(
    "Adam (active ADMIN) → 200 WITH it (decision:workspace-trash-cascades R2)",
    tup(await adam_tier.now(), s_adam, await trash_ids(adam)),
    tup("admin", 200, [WS]),
  );
  const [s_vic, body_vic] = await trash_route(vic);
  check(
    "Vic (viewer) → 200 empty",
    tup(await vic_tier.now(), s_vic, body_vic.items ?? null),
    tup("viewer", 200, []),
  );
  const [s_mia, body_mia] = await trash_route(mia);
  check(
    "Mia (active member) → 200 empty",
    tup(await mia_tier.now(), s_mia, body_mia.items ?? null),
    tup("member", 200, []),
  );
  const [s_sam, body_sam] = await trash_route(sam);
  check(
    "Sam (SUSPENDED member) → 200 empty",
    tup(tup(...(await sam_tier.standing())), s_sam, body_sam.items ?? null),
    tup(tup("member", "suspended"), 200, []),
  );
  const [s_nate, body_nate] = await trash_route(nate);
  check("Nate (non-member) → 200 empty", tup(s_nate, body_nate.items ?? null), tup(200, []));
  check(
    "member and non-member answers are BYTE-IDENTICAL (no existence leak)",
    s_mia === s_nate &&
      json_dumps(body_mia, { sort_keys: true }) === json_dumps(body_nate, { sort_keys: true }),
    true,
  );
  const [s_su, body_su] = await trash_route(su);
  check(
    "superuser → 200 empty (owner-scoped, never a global view)",
    tup(s_su, body_su.items ?? null),
    tup(200, []),
  );

  // Cross-tenant: another owner's trash never bleeds into Olive's.
  let nws: any;
  [s, nws] = await api("POST", "/api/collections/workspaces/records", nate, {
    name: "edc3 Nates Workspace",
    owner: nate_id,
  });
  check("Nate creates his own workspace", s, 200);
  await api("DELETE", `/api/collections/workspaces/records/${getitem(nws, "id")}`, nate);
  check("Nate's trash holds his workspace only", await trash_ids(nate), [getitem(nws, "id")]);
  check("Olive's trash is unchanged by it", await trash_ids(olive), [WS]);

  // ══════════ (5) F2 — the export route must not hand out a trashed workspace ═
  // POST /api/tracker/export bypasses collection rules and reads in superuser context, so
  // the narrowed viewRule does NOT reach it: before the guard it emitted the full record,
  // name and trashed stamp included, to every active member.
  console.log("\n── (5) POST /api/tracker/export refuses a TRASHED workspace ──");
  check(
    "Olive (owner) → 404",
    tup(await owns.now(), await export_ws(WS, olive)),
    tup(olive_id, tup(404, null)),
  );
  check(
    "Adam (active admin) → 404",
    tup(await adam_tier.now(), await export_ws(WS, adam)),
    tup("admin", tup(404, null)),
  );
  check(
    "Mia (active member) → 404",
    tup(await mia_tier.now(), await export_ws(WS, mia)),
    tup("member", tup(404, null)),
  );
  check(
    "Vic (viewer) → 404",
    tup(await vic_tier.now(), await export_ws(WS, vic)),
    tup("viewer", tup(404, null)),
  );
  check(
    "Sam (suspended member) → 404",
    tup(tup(...(await sam_tier.standing())), await export_ws(WS, sam)),
    tup(tup("member", "suspended"), tup(404, null)),
  );
  check("Nate (non-member) → 404", await export_ws(WS, nate), tup(404, null));
  check("anonymous → 401", (await export_ws(WS, null))[0], 401);
  // The refusal must be indistinguishable from an id that never existed.
  const [, unknown] = await api("POST", "/api/tracker/export", olive, {
    workspace: "doesnotexist000",
  });
  const [, refused] = await api("POST", "/api/tracker/export", olive, { workspace: WS });
  check(
    "the refusal is BYTE-IDENTICAL to an unknown workspace id (no existence leak)",
    json_dumps(unknown, { sort_keys: true }) === json_dumps(refused, { sort_keys: true }),
    true,
  );
  check(
    "a blank workspace is still 400, not 404",
    (await api("POST", "/api/tracker/export", olive, { workspace: "" }))[0],
    400,
  );
  // REGRESSION CONTROL: a LIVE workspace still exports for the same actors.
  check(
    "regression: Olive still exports her LIVE workspace",
    (await export_ws(LIVE_WS, olive))[0],
    200,
  );

  // ══════════ (6) restore — the narrowed viewRule does not gate the update ════
  console.log("\n── (6) restore: PATCH trashed='' under the untouched updateRule ──");
  const [s_mia_restore] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, mia, {
    trashed: "",
  });
  check(
    "Mia (plain member) cannot restore → 404",
    tup(await mia_tier.now(), s_mia_restore),
    tup("member", 404),
  );
  check(
    "Vic (viewer) cannot restore → 404",
    tup(
      await vic_tier.now(),
      (await api("PATCH", `/api/collections/workspaces/records/${WS}`, vic, { trashed: "" }))[0],
    ),
    tup("viewer", 404),
  );
  check("…and it is still trashed for Olive's route", await trash_ids(olive), [WS]);

  // An ACTIVE ADMIN enumerates and restores a workspace he cannot VIEW: decision:workspace-trash-cascades R2
  // widened the route to owner-or-active-admin, matching the updateRule restore already used,
  // while workspaces.viewRule still hides the record itself at every tier.
  check(
    "Adam (active admin) CAN enumerate it through the route",
    tup(await adam_tier.now(), await trash_ids(adam)),
    tup("admin", [WS]),
  );
  check("Adam (active admin) still cannot VIEW it → 404", await view(WS, adam), 404);
  const [s_adam_restore, adam_restored] = await api(
    "PATCH",
    `/api/collections/workspaces/records/${WS}`,
    adam,
    { trashed: "" },
  );
  check(
    "Adam (active admin) CAN restore it → 200 (owner-or-admin updateRule)",
    tup(await adam_tier.now(), s_adam_restore, adam_restored.trashed ?? null),
    tup("admin", 200, ""),
  );
  // Put it back in the trash so the OWNER round trip below runs on a trashed record.
  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, olive);
  check("Olive re-trashes it → 204", s, 204);
  check("…and Olive's route names it again", await trash_ids(olive), [WS]);

  let restored: any;
  [s, restored] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, olive, {
    trashed: "",
  });
  check("Olive (owner) PATCHes trashed='' → 200", tup(await owns.now(), s), tup(olive_id, 200));
  check("the PATCH hands back the record body", restored.id ?? null, WS);
  check("the stored trashed stamp is cleared", restored.trashed ?? null, "");

  // ══════════ (7) after restore — every read is back ══════════════════════════
  console.log("\n── (7) after restore ──");
  check("Olive views it again → 200", await view(WS, olive), 200);
  check(
    "Mia views it again → 200",
    tup(await mia_tier.now(), await view(WS, mia)),
    tup("member", 200),
  );
  check("Olive lists it again", await lists(WS, olive), true);
  check("Mia lists it again", await lists(WS, mia), true);
  check("Nate still cannot view it → 404", await view(WS, nate), 404);
  check("Olive's trash route no longer names it", await trash_ids(olive), []);
  check(
    "Mia exports it again → 200 with the record",
    tup(await mia_tier.now(), ...(await export_ws(WS, mia))),
    tup("member", 200, LIVE_EXPECTED),
  );

  // ══════════ (7b) POST vocab refuses a TRASHED workspace ═════════════════════
  // COVERS: route:POST /api/tracker/workspaces/{id}/vocab
  console.log(
    "\n── (7b) POST .../vocab refuses a TRASHED workspace, SAME 404 as its own unknown-id ──",
  );
  // Regression control: vocab still works LIVE for the owner AND an active admin.
  check(
    "LIVE vocab — Olive (owner) → 200",
    tup(await owns.now(), (await vocab_ws(WS, olive))[0]),
    tup(olive_id, 200),
  );
  check(
    "LIVE vocab — Adam (active admin) → 200",
    tup(await adam_tier.now(), (await vocab_ws(WS, adam))[0]),
    tup("admin", 200),
  );

  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, olive);
  check("Olive re-trashes it for the vocab probe → 204", s, 204);

  const [s_owner, body_owner] = await vocab_ws(WS, olive);
  check(
    "TRASHED vocab — Olive (owner) → 404 (not writable by anyone, owner included)",
    tup(await owns.now(), s_owner),
    tup(olive_id, 404),
  );
  check(
    "TRASHED vocab — message is vocab's OWN 'Workspace not found.' string",
    body_owner.message ?? null,
    "Workspace not found.",
  );
  const raw_trashed = await vocab_ws_raw(WS, olive);
  const raw_unknown = await vocab_ws_raw("doesnotexist000", olive);
  check(
    "TRASHED vocab body is BYTE-IDENTICAL to vocab's own unknown-id body",
    tup(Bun.deepEquals(raw_trashed, raw_unknown, true), raw_trashed),
    tup(true, utf8('{"data":{},"message":"Workspace not found.","status":404}')),
  );
  check(
    "TRASHED vocab body is NOT export's 'Not found.' shape",
    body_owner.message !== "Not found.",
    true,
  );
  check(
    "TRASHED vocab — Adam (active admin) → 404 too, no authority survives the trash",
    tup(await adam_tier.now(), (await vocab_ws(WS, adam))[0]),
    tup("admin", 404),
  );

  [s, restored] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, olive, {
    trashed: "",
  });
  check("Olive restores it after the vocab probe → 200", s, 200);
  check(
    "vocab works again after restore — Olive (owner) → 200",
    tup(await owns.now(), (await vocab_ws(WS, olive))[0]),
    tup(olive_id, 200),
  );
  // ══════════ (7c) the vocab route's siblings refuse a TRASHED workspace too ══
  // COVERS: route:POST /api/tracker/workspaces/{id}/transfer-ownership
  // COVERS: route:POST /api/tracker/workspaces/{id}/resolve-member-email
  console.log("\n── (7c) transfer-ownership and the invite route refuse a TRASHED workspace ──");
  // An address with no account: the invite route answers it exactly as it answers a registered
  // one, so the LIVE control below reaches past the workspace guard while moving nobody.
  const MIA_EMAIL = "nobody-trash-7c@example.test";
  // transfer-ownership authorizes the caller BEFORE it reads the trash, so the owner and a
  // superuser are told the real cause and everyone else still cannot tell a trashed workspace
  // from one that never existed. The invite route answers every denied caller with the 404.
  const TRASH_400 = "This workspace is in the trash; restore it before transferring ownership.";

  function transfer(
    ws_id: string,
    token: string,
    target: string = mia_id,
    current_owner: string | null = null,
  ): Promise<[number, any]> {
    const body: Record<string, string> = { user: target };
    // A superuser owns nothing here, so it must name the owner it believes is current; that
    // body check runs before the workspace is read, and skipping it never reaches the trash.
    if (current_owner) body.current_owner = current_owner;
    return api("POST", `/api/tracker/workspaces/${ws_id}/transfer-ownership`, token, body);
  }

  function resolve(
    ws_id: string,
    token: string,
    email: string = MIA_EMAIL,
  ): Promise<[number, any]> {
    return api("POST", `/api/tracker/workspaces/${ws_id}/resolve-member-email`, token, { email });
  }

  async function owner_now(): Promise<any> {
    return (await api("GET", `/api/collections/workspaces/records/${WS}`, su))[1].owner ?? null;
  }

  async function roster_size(): Promise<any> {
    const qs = urlencode({ filter: `workspace='${WS}'`, perPage: 1 });
    return getitem(
      (await api("GET", `/api/collections/workspace_members/records?${qs}`, su))[1],
      "totalItems",
    );
  }

  const roster_before_7c = await roster_size();

  // LIVE controls: both routes reach past the workspace guard while the workspace lives.
  // transfer's control uses a NON-MEMBER target, so it is refused by business logic and
  // moves nobody — a successful transfer would rewrite every later fixture in this file.
  check(
    "LIVE transfer-ownership — Olive (owner), non-member target → 400 (past the guard)",
    tup(await owns.now(), (await transfer(WS, olive, nate_id))[0]),
    tup(olive_id, 400),
  );
  check(
    "LIVE invite route — Olive (owner) → the uniform acknowledgement",
    tup(await owns.now(), ...(await resolve(WS, olive))),
    tup(olive_id, 200, { invited: true, mail_sent: false }),
  );
  check("LIVE control moved nobody — Olive still owns it", await owner_now(), olive_id);
  check(
    "…and the unregistered address joined nobody to the roster",
    await roster_size(),
    roster_before_7c,
  );

  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, olive);
  check("Olive re-trashes it for the sibling-route probe → 204", s, 204);

  const unknown_transfer = await post_raw(
    "/api/tracker/workspaces/doesnotexist000/transfer-ownership",
    olive,
    { user: mia_id },
  );
  const unknown_resolve = await post_raw(
    "/api/tracker/workspaces/doesnotexist000/resolve-member-email",
    olive,
    { email: MIA_EMAIL },
  );
  for (const [who, token, tier, standing, target] of [
    // the target is never the caller: an owner naming themself now reads the trash cause and
    // every other tier the deny-404, which is what the arms below already prove with a
    // third-party target, so it would add no tier this loop does not already separate.
    ["Olive (owner)", olive, owns, olive_id, mia_id],
    ["Adam (active admin)", adam, adam_tier, "admin", mia_id],
    ["Mia (active member)", mia, mia_tier, "member", adam_id],
    ["Vic (active viewer)", vic, vic_tier, "viewer", mia_id],
  ] as [string, string, tierkit.Tier | tierkit.Ownership, string, string][]) {
    if (token === olive) {
      const [status_x, body_x] = await transfer(WS, token, target);
      check(
        `TRASHED transfer-ownership — ${who} → 400 naming the trash, not the deny-404`,
        tup(await tier.now(), status_x, body_x.message ?? null),
        tup(standing, 400, TRASH_400),
      );
    } else {
      check(
        `TRASHED transfer-ownership — ${who} → 404 (denied before the trash is read)`,
        tup(await tier.now(), (await transfer(WS, token, target))[0]),
        tup(standing, 404),
      );
      check(
        `…and its body is BYTE-IDENTICAL to the route's own unknown-id body (${who})`,
        await post_raw(`/api/tracker/workspaces/${WS}/transfer-ownership`, token, {
          user: target,
        }),
        unknown_transfer,
      );
    }
    check(
      `TRASHED invite route — ${who} → 404, the trash closes it to every tier`,
      tup(await tier.now(), (await resolve(WS, token))[0]),
      tup(standing, 404),
    );
    check(
      `…and its body is BYTE-IDENTICAL to the route's own unknown-id body (${who})`,
      await post_raw(`/api/tracker/workspaces/${WS}/resolve-member-email`, token, {
        email: MIA_EMAIL,
      }),
      unknown_resolve,
    );
  }
  const [status_su, body_su7] = await transfer(WS, su, undefined, olive_id);
  check(
    "TRASHED transfer-ownership — superuser → the same 400: authorized, then refused",
    tup(status_su, body_su7.message ?? null),
    tup(400, TRASH_400),
  );
  check("TRASHED invite route — superuser → 404 too", (await resolve(WS, su))[0], 404);
  check(
    "the unknown-id body is the same 'Workspace not found.' bytes vocab answers with",
    tup(unknown_transfer, unknown_resolve),
    tup(
      utf8('{"data":{},"message":"Workspace not found.","status":404}'),
      utf8('{"data":{},"message":"Workspace not found.","status":404}'),
    ),
  );
  check(
    "the owner did NOT move — Olive still owns the trashed workspace",
    await owner_now(),
    olive_id,
  );
  check(
    "…and Mia is still a plain member, not the new owner",
    getitem(
      getitem(
        (
          await api(
            "GET",
            "/api/collections/workspace_members/records?" +
              urlencode({ filter: `workspace='${WS}' && user='${mia_id}'` }),
            su,
          )
        )[1],
        "items",
      )[0],
      "role",
    ),
    "member",
  );

  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, olive, { trashed: "" });
  check("Olive restores it after the sibling-route probe → 200", s, 200);
  check(
    "the invite route works again after restore — Olive (owner) → 200",
    tup(await owns.now(), (await resolve(WS, olive))[0]),
    tup(olive_id, 200),
  );

  check(
    "Olive's trash route no longer names it (clean handoff to section 8)",
    await trash_ids(olive),
    [],
  );

  // ══════════ (8) truncation: 501 trashed workspaces cap at 500 ═══════════════
  // COVERS: route:GET /api/tracker/workspaces/trash
  console.log("\n── (8) 501 trashed workspaces owned by one user cap the route at 500 ──");

  /**
   * `token` must be the superuser: 501+501 sub-requests blow past the general
   * 300/60s API rate limit a regular authenticated user is gated by (superusers are
   * exempt, per the app_settings rate limits). Returns the created ids in request order.
   */
  async function batch_create(
    coll: string,
    bodies: any[],
    token: string,
    chunk: number = 50,
  ): Promise<any[]> {
    const url = `/api/collections/${coll}/records`;
    const ids: any[] = [];
    for (let i = 0; i < bodies.length; i += chunk) {
      const part = bodies.slice(i, i + chunk);
      const reqs = part.map((b) => ({ method: "POST", url, body: b }));
      const [, resp] = await api("POST", "/api/batch", token, { requests: reqs });
      const ok = Array.isArray(resp) && resp.every((item: any) => [200, 201].includes(item.status));
      check(`(8) batch create ${coll} [${i}:${i + part.length}] all 200/201`, ok, true);
      if (Array.isArray(resp)) ids.push(...resp.map((item: any) => (item.body ?? {}).id ?? null));
    }
    return ids;
  }

  async function batch_patch(
    coll: string,
    ids: string[],
    body: any,
    token: string,
    chunk: number = 50,
  ): Promise<void> {
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const reqs = part.map((rid) => ({
        method: "PATCH",
        url: `/api/collections/${coll}/records/${rid}`,
        body,
      }));
      const [, resp] = await api("POST", "/api/batch", token, { requests: reqs });
      const ok = Array.isArray(resp) && resp.every((item: any) => item.status === 200);
      check(`(8) batch patch ${coll} [${i}:${i + part.length}] all 200`, ok, true);
    }
  }

  const [wendy, wendy_id] = await make_user("Wendy", "wendy@example.com");
  // PB aborts a whole batch as a bare 400 once it runs past batch.timeout
  // (the settings batch config), which a loaded host crosses; the bulk fixture is not what (8) proves.
  const [, settings] = await api("GET", "/api/settings", su);
  const batch_timeout = getitem(getitem(settings, "batch"), "timeout");
  [s] = await api("PATCH", "/api/settings", su, { batch: { timeout: 60 } });
  check("(8) setup: fixture batch timeout raised → 200", s, 200);
  const wendy_ws_ids = await batch_create(
    "workspaces",
    Array.from({ length: 501 }, (_, i) => ({
      name: `trash501 wendy ${String(i).padStart(4, "0")}`,
      owner: wendy_id,
    })),
    su,
  );
  check("(8) setup: 501 wendy workspaces created", wendy_ws_ids.length, 501);

  // Trash 3 first (under the 500 bound) to prove `truncated: false` is not a
  // tautology, then the remaining 498 to cross it — same fixtures, two proofs.
  await batch_patch("workspaces", wendy_ws_ids.slice(0, 3), { trashed: now_ts() }, su);
  let body: any;
  [s, body] = await api("GET", TRASH_ROUTE, wendy);
  check("(8) Wendy's trash route (3 planted, under the bound) → 200", s, 200);
  check("(8) count == 3 under the bound", body.count ?? null, 3);
  check("(8) truncated is False under the bound", body.truncated ?? null, false);

  await batch_patch("workspaces", wendy_ws_ids.slice(3), { trashed: now_ts() }, su);
  [s] = await api("PATCH", "/api/settings", su, { batch: { timeout: batch_timeout } });
  check("(8) cleanup: batch timeout restored → 200", s, 200);
  let qs = urlencode({ filter: `owner='${wendy_id}' && trashed != ''`, perPage: 1 });
  let count_body: any;
  [s, count_body] = await api("GET", `/api/collections/workspaces/records?${qs}`, su);
  check(
    "(8) superuser totalItems confirms all 501 wendy workspaces landed trashed",
    count_body.totalItems ?? null,
    501,
  );

  [s, body] = await api("GET", TRASH_ROUTE, wendy);
  check("(8) Wendy's trash route (501 planted) → 200", s, 200);
  check("(8) count capped at 500, not 501", body.count ?? null, 500);
  check("(8) len(items) capped at 500", (body.items ?? []).length, 500);
  check(
    "(8) truncated is True (501 trashed workspaces > the 500 cap)",
    body.truncated ?? null,
    true,
  );

  await adam_tier.done();
  await mia_tier.done();
  await vic_tier.done();
  await sam_tier.done();
  await owns.done();

  // ══════════ (9) decision:workspace-trash-cascades R1 — the trash CASCADES to everything inside ═══
  // COVERS: route:GET /api/tracker/search
  // COVERS: route:GET /api/tracker/summary
  // The suite's existing cast is REUSED here: PocketBase caps password logins at 10/60s per
  // guest IP, so every extra fixture user costs one of those slots for the whole file.
  console.log("\n── (9) cascade fixtures: Alpha stays LIVE, Bravo gets trashed ──");
  const [sid, sid_id] = await make_user("Sid", "sid@example.com");

  const ALPHA_MARK = "g7kgalphamark";
  const BRAVO_MARK = "g7kgbravomark";

  async function make_ws(label: string, name: string): Promise<string> {
    const [s, r] = await api("POST", "/api/collections/workspaces/records", olive, {
      name,
      owner: olive_id,
    });
    check(`(9) Olive creates ${label}`, s, 200);
    return getitem(r, "id");
  }

  const ALPHA = await make_ws("Alpha (the live control)", ALPHA_MARK + "ws");
  const BRAVO = await make_ws("Bravo (the one that gets trashed)", BRAVO_MARK + "ws");

  for (const [label, ws_id] of [
    ["Alpha", ALPHA],
    ["Bravo", BRAVO],
  ] as [string, string][]) {
    for (const [uid, who, role, status] of [
      [adam_id, "Adam", "admin", "active"],
      [sid_id, "Sid", "admin", "suspended"],
      [mia_id, "Mia", "member", "active"],
      [vic_id, "Vic", "viewer", "active"],
      [sam_id, "Sam", "member", "active"],
    ]) {
      [s] = await api("POST", "/api/collections/workspace_members/records", su, {
        workspace: ws_id,
        user: uid,
        role,
        status,
      });
      check(`(9) ${who} joins ${label} as ${role}/${status}`, s, 200);
    }
  }

  /** One project plus one row of every item type, and a project-less task. */
  async function seed_workspace(
    label: string,
    ws_id: string,
    mark: string,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let s: number;
    let prj: any;
    [s, prj] = await api("POST", "/api/collections/projects/records", olive, {
      name: `${mark} project`,
      workspace: ws_id,
      owner: olive_id,
    });
    check(`(9) ${label}: project created`, s, 200);
    out.projects = getitem(prj, "id");
    let t1: any;
    [s, t1] = await api("POST", "/api/collections/tasks/records", olive, {
      title: `${mark} task one`,
      workspace: ws_id,
      project: getitem(prj, "id"),
    });
    check(`(9) ${label}: task in the project created`, s, 200);
    out.tasks = getitem(t1, "id");
    let t2: any;
    [s, t2] = await api("POST", "/api/collections/tasks/records", olive, {
      title: `${mark} task two`,
      workspace: ws_id,
    });
    check(`(9) ${label}: project-LESS task created`, s, 200);
    out.task2 = getitem(t2, "id");
    let doc: any;
    [s, doc] = await api("POST", "/api/collections/documents/records", olive, {
      title: `${mark} doc`,
      workspace: ws_id,
      project: getitem(prj, "id"),
    });
    check(`(9) ${label}: document created`, s, 200);
    out.documents = getitem(doc, "id");
    let dec: any;
    [s, dec] = await api("POST", "/api/collections/decisions/records", olive, {
      title: `${mark} decision`,
      workspace: ws_id,
      project: getitem(prj, "id"),
    });
    check(`(9) ${label}: decision created`, s, 200);
    out.decisions = getitem(dec, "id");
    let mst: any;
    [s, mst] = await api("POST", "/api/collections/milestones/records", olive, {
      name: `${mark} milestone`,
      workspace: ws_id,
      project: getitem(prj, "id"),
    });
    check(`(9) ${label}: milestone created`, s, 200);
    out.milestones = getitem(mst, "id");
    // Assigning is what writes the derived rows: a task_activity row, the auto-subscription
    // and the assignee's notification all come from this one PATCH.
    for (const [tid, uid, who] of [
      [out.tasks, sam_id, "Sam"],
      [out.task2, mia_id, "Mia"],
    ]) {
      [s] = await api("PATCH", `/api/collections/tasks/records/${tid}`, olive, { assignee: uid });
      check(`(9) ${label}: task assigned to ${who}`, s, 200);
    }
    return out;
  }

  const A = await seed_workspace("Alpha", ALPHA, ALPHA_MARK);
  const B = await seed_workspace("Bravo", BRAVO, BRAVO_MARK);

  [s] = await api("POST", "/api/collections/task_subscribers/records", mia, {
    task: B.tasks,
    user: mia_id,
  });
  check("(9) Mia subscribes herself to the Bravo task", s, 200);

  // Sam is suspended AFTER the assignment (an assignee must be an active member at assign
  // time): an assignment grants nothing beyond active membership, so he reads nothing.
  for (const [label, ws_id] of [
    ["Alpha", ALPHA],
    ["Bravo", BRAVO],
  ]) {
    const qs = urlencode({ filter: `workspace='${ws_id}' && user='${sam_id}'` });
    const [, sam_rows] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
    [s] = await api(
      "PATCH",
      `/api/collections/workspace_members/records/${getitem(getitem(sam_rows, "items")[0], "id")}`,
      su,
      { status: "suspended" },
    );
    check(`(9) Sam's ${label} membership is suspended`, s, 200);
  }

  const olive_owns = await tierkit.owner_of_workspace(BRAVO, olive_id, su, "Olive");
  const adam_b = await tierkit.actor_at_tier(BRAVO, adam_id, "admin", su, "Adam");
  const sid_b = await tierkit.actor_at_tier(BRAVO, sid_id, "admin", su, "Sid", "suspended");
  const mia_b = await tierkit.actor_at_tier(BRAVO, mia_id, "member", su, "Mia");
  const vic_b = await tierkit.actor_at_tier(BRAVO, vic_id, "viewer", su, "Vic");
  const sam_b = await tierkit.actor_at_tier(BRAVO, sam_id, "member", su, "Sam", "suspended");

  const COLLS = ["tasks", "documents", "decisions", "milestones", "projects"] as const;
  const [OWNER, ADMIN, MEMBER] = ["Olive (owner)", "Adam (active admin)", "Mia (member)"];
  const [VIEWER, ASSIGNEE] = ["Vic (viewer)", "Sam (suspended assignee)"];
  const [OUTSIDER, ROOT] = ["Nate (non-member)", "superuser"];
  const READERS: [string, string][] = [
    [OWNER, olive],
    [ADMIN, adam],
    [MEMBER, mia],
    [VIEWER, vic],
    [ASSIGNEE, sam],
    [OUTSIDER, nate],
    [ROOT, su],
  ];
  const SEES_ALL = from_keys(COLLS, 200);
  const SEES_NONE = from_keys(COLLS, 404);
  const LIVE_VIEW: Record<string, Record<string, number>> = {
    [OWNER]: SEES_ALL,
    [ADMIN]: SEES_ALL,
    [MEMBER]: SEES_ALL,
    [VIEWER]: SEES_ALL,
    [ASSIGNEE]: SEES_NONE,
    [OUTSIDER]: SEES_NONE,
    [ROOT]: SEES_ALL,
  };
  const COUNTS_ALL = { tasks: 2, documents: 1, decisions: 1, milestones: 1, projects: 1 };
  const COUNTS_NONE = from_keys(COLLS, 0);
  const LIVE_LIST: Record<string, Record<string, number>> = {
    [OWNER]: COUNTS_ALL,
    [ADMIN]: COUNTS_ALL,
    [MEMBER]: COUNTS_ALL,
    [VIEWER]: COUNTS_ALL,
    [ASSIGNEE]: COUNTS_NONE,
    [OUTSIDER]: COUNTS_NONE,
    [ROOT]: COUNTS_ALL,
  };
  // project_items unions the four item types.
  const LIVE_ITEMS: Record<string, number> = {
    [OWNER]: 5,
    [ADMIN]: 5,
    [MEMBER]: 5,
    [VIEWER]: 5,
    [ASSIGNEE]: 0,
    [OUTSIDER]: 0,
    [ROOT]: 5,
  };
  const LIVE_STATS: Record<string, number> = {
    [OWNER]: 1,
    [ADMIN]: 1,
    [MEMBER]: 1,
    [VIEWER]: 1,
    [ASSIGNEE]: 0,
    [OUTSIDER]: 0,
    [ROOT]: 1,
  };
  // search is cross-workspace and self-scopes per row: six marked rows, and nothing for a
  // superuser (who owns no workspace and holds no membership).
  const LIVE_SEARCH: Record<string, number> = {
    [OWNER]: 6,
    [ADMIN]: 6,
    [MEMBER]: 6,
    [VIEWER]: 6,
    [ASSIGNEE]: 0,
    [OUTSIDER]: 0,
    [ROOT]: 0,
  };
  const LIVE_EXPORT: Record<string, number> = {
    [OWNER]: 200,
    [ADMIN]: 200,
    [MEMBER]: 200,
    [VIEWER]: 200,
    [ASSIGNEE]: 404,
    [OUTSIDER]: 404,
    [ROOT]: 404,
  };
  const LIVE_TRASH_ROUTE: Record<string, number> = {
    [OWNER]: 200,
    [ADMIN]: 200,
    [MEMBER]: 200,
    [VIEWER]: 200,
    [ASSIGNEE]: 404,
    [OUTSIDER]: 404,
    [ROOT]: 403,
  };

  /** totalItems for a filtered list, or the (status, body) pair when it is not a 200. */
  async function total(
    coll: string,
    token: string,
    filt: string,
    extra: Record<string, string> | null = null,
  ): Promise<any> {
    const q: Record<string, any> = { filter: filt, perPage: 1 };
    if (extra) Object.assign(q, extra);
    const [s, r] = await api("GET", `/api/collections/${coll}/records?${urlencode(q)}`, token);
    return s === 200 ? (r.totalItems ?? null) : tup(s, r);
  }

  async function search_count(mark: string, token: string): Promise<[number, any]> {
    const [s, r] = await api("GET", "/api/tracker/search?" + urlencode({ q: mark }), token);
    return tup(s, r.count ?? null);
  }

  async function notif_task_ids(token: string): Promise<[number, Set<any>]> {
    const [s, r] = await api(
      "GET",
      "/api/collections/notifications/records?" + urlencode({ expand: "task", perPage: 200 }),
      token,
    );
    return tup(s, new Set((r.items ?? []).filter((n: any) => n.task).map((n: any) => n.task)));
  }

  async function summary_total(token: string): Promise<[number, any]> {
    const [s, r] = await api("GET", "/api/tracker/summary", token);
    return tup(s, r.total ?? null);
  }

  /**
   * Every read surface of one workspace at every tier; `live` picks the expectations.
   *
   * `notified` is False once the workspace has been trashed at least once: the trash
   * cascade DELETES the notifications about its work (owner ruling 2026-09-07, rdmq),
   * so a restore brings the item back but never the inbox row.
   */
  async function probe_reads(
    phase: string,
    label: string,
    ws_id: string,
    ids: Record<string, string>,
    mark: string,
    live: boolean,
    notified: boolean = true,
  ): Promise<void> {
    const views = live
      ? LIVE_VIEW
      : Object.fromEntries(READERS.map(([who]) => [who, who === ROOT ? SEES_ALL : SEES_NONE]));
    const lists = live
      ? LIVE_LIST
      : Object.fromEntries(READERS.map(([who]) => [who, who === ROOT ? COUNTS_ALL : COUNTS_NONE]));
    const items = live
      ? LIVE_ITEMS
      : Object.fromEntries(READERS.map(([who]) => [who, who === ROOT ? 5 : 0]));
    // project_stats drops the row in the view QUERY, so the superuser loses it too — the one
    // surface where the cut is not a rule and therefore has no bypass.
    const stats = live ? LIVE_STATS : from_keys(Object.keys(LIVE_STATS), 0);
    const search = live ? LIVE_SEARCH : from_keys(Object.keys(LIVE_SEARCH), 0);
    const exp = live ? LIVE_EXPORT : from_keys(Object.keys(LIVE_EXPORT), 404);
    // Trashing changes the answer only for someone who could read the route at all; a caller
    // the membership check already refuses keeps the SAME 404, so the route never confirms a
    // workspace exists to a stranger holding its id (decision:inaccessible-workspace-answers-404);
    // a superuser is refused 403 before any lookup, as on the other users-only workspace routes.
    const troute = live
      ? LIVE_TRASH_ROUTE
      : Object.fromEntries(
          Object.entries(LIVE_TRASH_ROUTE).map(([who, code]) => [who, code === 200 ? 404 : code]),
        );
    // The derived-row counts are read back from the superuser rather than hard-coded: the
    // write probes below add activity rows, and a stale literal would report their absence.
    const act_n = await total("task_activity", su, `task='${ids.tasks}'`);
    const sub_n = await total("task_subscribers", su, `task='${ids.tasks}'`);
    check(
      `${phase} ${label}: the derived rows exist at all`,
      tup(act_n > 0, sub_n > 0),
      tup(true, true),
    );
    for (const [who, tok] of READERS) {
      for (const coll of COLLS) {
        check(
          `${phase} ${label} ${coll} by id — ${who}`,
          (await api("GET", `/api/collections/${coll}/records/${ids[coll]}`, tok))[0],
          views[who]![coll],
        );
        check(
          `${phase} ${label} ${coll} list by workspace — ${who}`,
          // shadow=false on the SUPERUSER leg only: the container is a real row a
          // superuser count sees, but the tenant legs must stay able to catch it
          // leaking into a project list the rules should have filtered.
          await total(
            coll,
            tok,
            `workspace='${ws_id}'` +
              (coll === "projects" && who === ROOT ? " && shadow=false" : ""),
          ),
          lists[who]![coll],
        );
      }
      check(
        `${phase} ${label} project_items by id — ${who}`,
        (await api("GET", `/api/collections/project_items/records/${ids.tasks}`, tok))[0],
        (live || who === ROOT) && views[who]!.tasks === 200 ? 200 : 404,
      );
      check(
        `${phase} ${label} project_items list by workspace — ${who}`,
        await total("project_items", tok, `workspace='${ws_id}'`),
        items[who],
      );
      check(
        `${phase} ${label} project_stats by workspace — ${who}`,
        await total("project_stats", tok, `workspace='${ws_id}'`),
        stats[who],
      );
      const derived = who === ROOT || (live && who !== OUTSIDER && who !== ASSIGNEE);
      check(
        `${phase} ${label} task_activity by task — ${who}`,
        await total("task_activity", tok, `task='${ids.tasks}'`),
        derived ? act_n : 0,
      );
      check(
        `${phase} ${label} task_subscribers by task — ${who}`,
        await total("task_subscribers", tok, `task='${ids.tasks}'`, { expand: "task" }),
        derived ? sub_n : 0,
      );
      check(
        `${phase} ${label} search for the marker — ${who}`,
        await search_count(mark, tok),
        tup(200, search[who]),
      );
      check(
        `${phase} ${label} export — ${who}`,
        (await api("POST", "/api/tracker/export", tok, { workspace: ws_id }))[0],
        exp[who],
      );
      check(
        `${phase} ${label} trash route — ${who}`,
        (await api("GET", `/api/tracker/trash?workspace=${ws_id}`, tok))[0],
        troute[who],
      );
    }
    const [s, seen] = await notif_task_ids(sam);
    check(
      `${phase} ${label}: Sam's inbox hides the task notification`,
      tup(s, seen.has(ids.tasks)),
      tup(200, false),
    );
    check(
      `${phase} ${label}: Sam's task notification row exists (superuser read)`,
      (await total("notifications", su, `user='${sam_id}' && task='${ids.tasks}'`)) > 0,
      live && notified,
    );
  }

  /** Create / update / delete under one workspace, for the three tiers that may write. */
  async function probe_writes(
    phase: string,
    label: string,
    ws_id: string,
    ids: Record<string, string>,
    live: boolean,
  ): Promise<void> {
    const edits: Record<string, any> = {
      tasks: { description: `${phase} edit` },
      documents: { body: `${phase} edit` },
      decisions: { context: `${phase} edit` },
      milestones: { description: `${phase} edit` },
      projects: { description: `${phase} edit` },
    };
    const writers: [string, string, string][] = [
      [OWNER, olive, olive_id],
      [ADMIN, adam, adam_id],
      [MEMBER, mia, mia_id],
    ];
    let s: number;
    for (const [who, tok, uid] of writers) {
      for (const coll of COLLS) {
        check(
          `${phase} ${label} PATCH ${coll} — ${who}`,
          (
            await api("PATCH", `/api/collections/${coll}/records/${ids[coll]}`, tok, edits[coll])
          )[0],
          live ? 200 : 404,
        );
      }
      const bodies: [string, any][] = [
        ["tasks", { title: `${phase} new task`, workspace: ws_id }],
        // workspace OMITTED: scope.pb.js fills it from `project` AFTER the createRule has
        // already read the submitted body, so only the project leg of the rule can refuse.
        ["tasks", { title: `${phase} new task via project`, project: ids.projects }],
        ["documents", { title: `${phase} new doc`, workspace: ws_id, project: ids.projects }],
        ["decisions", { title: `${phase} new decision`, workspace: ws_id, project: ids.projects }],
        ["milestones", { name: `${phase} new milestone`, workspace: ws_id, project: ids.projects }],
        ["projects", { name: `${phase} new project`, workspace: ws_id, owner: uid }],
      ];
      for (const [coll, body] of bodies) {
        const [s, rec] = await api("POST", `/api/collections/${coll}/records`, tok, body);
        const how = Object.hasOwn(body, "workspace") ? "with workspace" : "via project only";
        check(`${phase} ${label} POST ${coll} (${how}) — ${who}`, s, live ? 200 : 400);
        if (s === 200) {
          // A superuser DELETE hard-purges, so the probe leaves the fixture counts intact.
          await api("DELETE", `/api/collections/${coll}/records/${getitem(rec, "id")}`, su);
        }
      }
    }
    const was = (await api("GET", `/api/collections/tasks/records/${ids.tasks}`, su))[1].title;
    [s] = await api("PATCH", `/api/collections/tasks/records/${ids.tasks}`, mia, {
      title: "edited under a trashed workspace",
    });
    check(`${phase} ${label} PATCH a task title — ${MEMBER}`, s, live ? 200 : 404);
    // Undone unconditionally: on a tree missing the refusal the edit LANDS, and a restore
    // conditional on `live` would leave the next phase measuring that damage, not the rule.
    await api("PATCH", `/api/collections/tasks/records/${ids.tasks}`, su, { title: was });
    [s] = await api("DELETE", `/api/collections/tasks/records/${ids.task2}`, mia);
    check(`${phase} ${label} DELETE the project-less task — ${MEMBER}`, s, live ? 204 : 404);
    await api("PATCH", `/api/collections/tasks/records/${ids.task2}`, su, { trashed: "" });
    check(
      `${phase} ${label}: the project-less task is still live`,
      (await api("GET", `/api/collections/tasks/records/${ids.task2}`, su))[1].trashed ?? null,
      "",
    );
    // projects.deleteRule is the one rule here whose top level is a bare `||`, so an
    // unparenthesised conjunct would guard the admin disjunct and leave the OWNER leg open —
    // and the SECOND delete is a hard purge that cascades to the tasks in the project.
    for (const [who, tok] of [
      [OWNER, olive],
      [ADMIN, adam],
    ]) {
      [s] = await api("DELETE", `/api/collections/projects/records/${ids.projects}`, tok);
      check(`${phase} ${label} DELETE the project — ${who}`, s, live ? 204 : 404);
      await api("PATCH", `/api/collections/projects/records/${ids.projects}`, su, { trashed: "" });
    }
    if (!live) {
      [s] = await api("DELETE", `/api/collections/projects/records/${ids.projects}`, olive);
      check(`${phase} ${label} second DELETE, the purge — ${OWNER}`, s, 404);
    }
    check(
      `${phase} ${label}: the project and its task survived every delete probe`,
      tup(
        (await api("GET", `/api/collections/projects/records/${ids.projects}`, su))[0],
        (await api("GET", `/api/collections/tasks/records/${ids.tasks}`, su))[0],
      ),
      tup(200, 200),
    );
  }

  console.log("\n── (9a) BEFORE the trash — the answers the cascade must preserve for Alpha ──");
  await probe_reads("(9a)", "Alpha", ALPHA, A, ALPHA_MARK, true);
  await probe_reads("(9a)", "Bravo", BRAVO, B, BRAVO_MARK, true);
  console.log("\n── (9b) BEFORE the trash — the writes that must become refusals ──");
  await probe_writes("(9b)", "Bravo", BRAVO, B, true);
  await probe_writes("(9b)", "Alpha", ALPHA, A, true);
  const olive_before = await summary_total(olive);
  const mia_before = await summary_total(mia);
  check("(9b) Olive's summary counts his project tasks", olive_before[0], 200);
  check("(9b) Mia's summary counts her two assignments", mia_before, tup(200, 2));
  check(
    "(9b) Sam's summary counts nothing (suspended everywhere)",
    await summary_total(sam),
    tup(200, 0),
  );

  console.log("\n── (9c) trash Bravo — one write to workspaces.trashed, nothing stamped inside ──");
  [s] = await api("DELETE", `/api/collections/workspaces/records/${BRAVO}`, olive);
  check("(9c) Olive DELETEs Bravo → 204 (delete-to-trash)", s, 204);
  check(
    "(9c) the Bravo task itself carries NO trash stamp — the cascade is derived",
    (await api("GET", `/api/collections/tasks/records/${B.tasks}`, su))[1].trashed ?? null,
    "",
  );
  check(
    "(9c) the Bravo project carries no trash stamp either",
    (await api("GET", `/api/collections/projects/records/${B.projects}`, su))[1].trashed ?? null,
    "",
  );

  console.log("\n── (9d) AFTER the trash — Bravo is dark, Alpha is untouched ──");

  /**
   * The status and RESPONSE BODY AS BYTES — two refusals that differ only in message
   * still tell a stranger which workspace ids are real.
   */
  async function trash_route_raw(ws_id: string, token: string): Promise<[number, Uint8Array]> {
    const resp = await fetch(`${BASE_URL}/api/tracker/trash?${urlencode({ workspace: ws_id })}`, {
      headers: { Authorization: token },
    });
    return tup(resp.status, new Uint8Array(await resp.arrayBuffer()));
  }

  check(
    "(9d) trash route: a non-member gets the SAME bytes for a trashed id and an unknown one",
    await trash_route_raw(BRAVO, nate),
    await trash_route_raw("doesnotexist000", nate),
  );
  check(
    "(9d) trash route: a MEMBER of the trashed workspace gets its own 404",
    (await trash_route_raw(BRAVO, mia))[0],
    404,
  );
  await probe_reads("(9d)", "Bravo", BRAVO, B, BRAVO_MARK, false);
  await probe_reads("(9d)", "Alpha", ALPHA, A, ALPHA_MARK, true);
  console.log("\n── (9e) AFTER the trash — Bravo is frozen, Alpha still writable ──");
  await probe_writes("(9e)", "Bravo", BRAVO, B, false);
  await probe_writes("(9e)", "Alpha", ALPHA, A, true);
  check(
    "(9e) Olive's summary drops exactly the Bravo task in his project",
    tup((await summary_total(olive))[0], olive_before[1] - (await summary_total(olive))[1]),
    tup(200, 1),
  );
  check(
    "(9e) Mia's summary drops exactly her Bravo assignment",
    tup((await summary_total(mia))[0], mia_before[1] - (await summary_total(mia))[1]),
    tup(200, 1),
  );
  check("(9e) Sam's summary still counts nothing", await summary_total(sam), tup(200, 0));

  console.log("\n── (9f) R2 — who may enumerate and restore a trashed workspace ──");
  for (const [who, tok, tier, standing] of [
    [MEMBER, mia, mia_b, "member"],
    [VIEWER, vic, vic_b, "viewer"],
    ["Sid (SUSPENDED admin)", sid, sid_b, tup("admin", "suspended")],
  ] as [string, string, tierkit.Tier, any][]) {
    const reader = async (): Promise<any> =>
      Array.isArray(standing) ? tup(...(await tier.standing())) : tier.now();
    check(
      `(9f) ${who} cannot enumerate Bravo`,
      tup(await reader(), await trash_ids(tok)),
      tup(standing, []),
    );
    check(
      `(9f) ${who} cannot restore Bravo → 404`,
      tup(
        await reader(),
        (
          await api("PATCH", `/api/collections/workspaces/records/${BRAVO}`, tok, { trashed: "" })
        )[0],
      ),
      tup(standing, 404),
    );
  }
  // Nate still owns the workspace he trashed in section 4, so his listing is asserted by
  // EXCLUSION — an emptiness check here would be a claim about his own trash, not about Bravo.
  check(
    "(9f) Nate (non-member) cannot enumerate Bravo",
    (await trash_ids(nate)).includes(BRAVO),
    false,
  );
  check(
    "(9f) Nate (non-member) cannot restore Bravo → 404",
    (await api("PATCH", `/api/collections/workspaces/records/${BRAVO}`, nate, { trashed: "" }))[0],
    404,
  );
  check(
    "(9f) Olive (owner) enumerates Bravo",
    tup(await olive_owns.now(), await trash_ids(olive)),
    tup(olive_id, [BRAVO]),
  );
  check(
    "(9f) Adam (active admin) enumerates Bravo",
    tup(await adam_b.now(), await trash_ids(adam)),
    tup("admin", [BRAVO]),
  );
  check(
    "(9f) Alpha is absent from both trash listings",
    tup((await trash_ids(olive)).includes(ALPHA), (await trash_ids(adam)).includes(ALPHA)),
    tup(false, false),
  );
  [s, restored] = await api("PATCH", `/api/collections/workspaces/records/${BRAVO}`, adam, {
    trashed: "",
  });
  check(
    "(9f) Adam (active admin) restores Bravo → 200",
    tup(await adam_b.now(), s, restored.trashed ?? null),
    tup("admin", 200, ""),
  );

  console.log("\n── (9g) AFTER the restore — every surface is back where it started ──");
  await probe_reads("(9g)", "Bravo", BRAVO, B, BRAVO_MARK, true, false);
  await probe_reads("(9g)", "Alpha", ALPHA, A, ALPHA_MARK, true);
  await probe_writes("(9g)", "Bravo", BRAVO, B, true);
  check(
    "(9g) Olive's summary is back to its pre-trash total",
    await summary_total(olive),
    olive_before,
  );
  check("(9g) Mia's summary is back to its pre-trash total", await summary_total(mia), mia_before);
  check("(9g) Sam's summary still counts nothing", await summary_total(sam), tup(200, 0));
  check("(9g) neither workspace is listed as trashed any more", await trash_ids(olive), []);

  await olive_owns.done();
  await adam_b.done();
  await sid_b.done();
  await mia_b.done();
  await vic_b.done();
  await sam_b.done();
  await tierkit.verify_tiers();

  // ══════ (10) the trash cleanup: every writer, all-or-nothing ═══════════════
  // COVERS: hook:trash.pb.js#onRecordAfterUpdateSuccess:workspaces
  // The cleanup that follows a trash (drop the notifications, replace a last workspace) hangs
  // off the record write, not off either request path, and shares that write's transaction.
  // Neither property is observable through DELETE or PATCH alone, so this section re-boots the
  // room on the SAME database and port with a probe hook file: a route that trashes a workspace
  // programmatically, and a notifications delete that throws part-way through the cascade.
  console.log("\n── (10) the trash cleanup runs for any writer, or not at all ──");
  await stop_server(server);
  server = null;
  const PROBE_HOOKS = path.join(S, "pb_hooks_probe");
  fs.cpSync(roomkit.hooks_dir(S), PROBE_HOOKS, { recursive: true, dereference: true });
  fs.writeFileSync(path.join(PROBE_HOOKS, "zz_writepath_probe.pb.js"), PROBE_HOOK);
  server = await start_server(DATA_DIR, MIG_DIR, PROBE_HOOKS);

  async function notif_kinds(task_id: string): Promise<string[]> {
    const qs = urlencode({ filter: `task='${task_id}'`, perPage: 200 });
    const [, r] = await api("GET", `/api/collections/notifications/records?${qs}`, su);
    return (r.items ?? []).map((n: any) => getitem(n, "kind")).sort(by_code_point);
  }

  async function live_workspaces(owner_id: string): Promise<any[]> {
    const qs = urlencode({ filter: `owner='${owner_id}' && trashed=''`, perPage: 200 });
    const [, r] = await api("GET", `/api/collections/workspaces/records?${qs}`, su);
    return r.items ?? [];
  }

  async function trashed_value(ws_id: string): Promise<any> {
    const [, r] = await api("GET", `/api/collections/workspaces/records/${ws_id}`, su);
    return r.trashed ?? null;
  }

  /** A workspace whose one task carries a notification for Mia (and Olive, with a comment). */
  async function notified_workspace(
    name: string,
    task_title: string,
    comment: boolean = false,
  ): Promise<[string, string]> {
    const [s, ws] = await api("POST", "/api/collections/workspaces/records", olive, {
      name,
      owner: olive_id,
    });
    check(`(10) Olive creates ${name}`, s, 200);
    await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: getitem(ws, "id"),
      user: mia_id,
      role: "member",
      status: "active",
    });
    const [, proj] = await api("POST", "/api/collections/projects/records", olive, {
      name: `${name}project`,
      owner: olive_id,
      workspace: getitem(ws, "id"),
    });
    const [, task] = await api("POST", "/api/collections/tasks/records", olive, {
      title: task_title,
      project: getitem(proj, "id"),
    });
    await api("PATCH", `/api/collections/tasks/records/${getitem(task, "id")}`, olive, {
      assignee: mia_id,
    });
    if (comment) {
      await api("POST", "/api/collections/comments/records", mia, {
        task: getitem(task, "id"),
        author: mia_id,
        body: "a comment that notifies Olive",
      });
    }
    return [getitem(ws, "id"), getitem(task, "id")];
  }

  console.log("\n── (10a) a writer that is not a request gets the same cleanup ──");
  const [PROG_WS, PROG_TASK] = await notified_workspace("progwritepathws", "progwritepathtask");
  check("(10a) the workspace's notification exists to begin with", await notif_kinds(PROG_TASK), [
    "assigned",
  ]);
  check(
    "(10a) a programmatic write of the trash flag succeeds",
    (await api("POST", `/api/probe/programmatic-trash/${PROG_WS}`, su))[0],
    200,
  );
  check("(10a) the workspace really is trashed", truthy(await trashed_value(PROG_WS)), true);
  check(
    "(10a) its notifications are dropped by that write alone",
    await notif_kinds(PROG_TASK),
    [],
  );

  console.log("\n── (10b) a cleanup that fails part-way still leaves the workspace trashed ──");
  // The cleanup is NOT atomic with the trash write, deliberately: the only construct that would
  // roll one back reassigns the event's app, which the pooled JSVM shares with other in-flight
  // requests and corrupts them (measured, wave v7 lane B5). So this pins what actually happens —
  // the trash the owner asked for stands, and a failed cleanup is incomplete, not reverted.
  const [BOOM_WS, BOOM_TASK] = await notified_workspace(
    "boomwritepathws",
    "boomtaskwritepath",
    true,
  );
  check("(10b) the doomed workspace carries both notifications", await notif_kinds(BOOM_TASK), [
    "assigned",
    "commented",
  ]);
  check(
    "(10b) the DELETE still succeeds when the cleanup cannot finish",
    (await api("DELETE", `/api/collections/workspaces/records/${BOOM_WS}`, olive))[0],
    204,
  );
  check("(10b) the workspace IS trashed", truthy(await trashed_value(BOOM_WS)), true);
  check(
    "(10b) the notification whose removal fails is still there — the cleanup is incomplete, " +
      "not reverted",
    (await notif_kinds(BOOM_TASK)).includes("commented"),
    true,
  );

  console.log("\n── (10c) trashing a last workspace replaces it, exactly once ──");
  const [dan, dan_id] = await make_user("Dan", "dan@example.com");
  const dan_first = await live_workspaces(dan_id);
  check("(10c) a fresh account starts with one live workspace", dan_first.length, 1);
  const DAN_WS = getitem(dan_first[0], "id");
  check(
    "(10c) Dan trashes his only workspace (DELETE)",
    (await api("DELETE", `/api/collections/workspaces/records/${DAN_WS}`, dan))[0],
    204,
  );
  const dan_after = await live_workspaces(dan_id);
  check("(10c) he is left with exactly one live workspace", dan_after.length, 1);
  // A miss here means no replacement at all, which must read as a failed check rather than an
  // IndexError that hides the rest of the section.
  const replacement: string = dan_after.length ? getitem(dan_after[0], "id") : "";
  check(
    "(10c) and it is a NEW one, not the trashed one",
    !["", DAN_WS].includes(replacement),
    true,
  );
  qs = urlencode({ filter: `workspace='${replacement}'`, perPage: 200 });
  const [, seeded] = await api("GET", `/api/collections/statuses/records?${qs}`, su);
  check(
    "(10c) the replacement carries the seeded status vocabulary",
    getitem(seeded, "items").length,
    5,
  );
  check(
    "(10c) purging the trashed workspace succeeds",
    (await api("DELETE", `/api/collections/workspaces/records/${DAN_WS}`, dan))[0],
    204,
  );
  const dan_final = await live_workspaces(dan_id);
  check("(10c) still exactly one live workspace — no second replacement", dan_final.length, 1);
  check(
    "(10c) and it is the same replacement as before the purge",
    dan_final.length ? getitem(dan_final[0], "id") : "",
    replacement,
  );

  console.log("\n── (10d) a workspace in the trash does not count as somewhere to work ──");
  // A superuser hard-purge skips the trash step, so the after-delete replacement is the only
  // thing between the owner and an account whose one remaining workspace is in the trash.
  const [dee, dee_id] = await make_user("Dee", "dee@example.com");
  const DEE_FIRST = getitem((await live_workspaces(dee_id))[0], "id");
  let extra: any;
  [s, extra] = await api("POST", "/api/collections/workspaces/records", dee, {
    name: "deeextra",
    owner: dee_id,
  });
  check("(10d) Dee creates a second workspace", s, 200);
  check(
    "(10d) Dee puts her first one in the trash (DELETE)",
    (await api("DELETE", `/api/collections/workspaces/records/${DEE_FIRST}`, dee))[0],
    204,
  );
  check("(10d) one live workspace is left", (await live_workspaces(dee_id)).length, 1);
  check(
    "(10d) a superuser purges that live one outright",
    (await api("DELETE", `/api/collections/workspaces/records/${getitem(extra, "id")}`, su))[0],
    204,
  );
  const dee_after = await live_workspaces(dee_id);
  check("(10d) Dee is not left with only a trashed workspace", dee_after.length, 1);
  check(
    "(10d) and the one she has is neither of the two she had",
    dee_after.length
      ? !["", DEE_FIRST, getitem(extra, "id")].includes(getitem(dee_after[0], "id"))
      : false,
    true,
  );
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ all workspace-trash proofs passed");
process.exit(0);

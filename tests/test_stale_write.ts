#!/usr/bin/env bun
/**
 * E2E proof of the stale-write refusal on `templates` and `saved_views`
 * (pb_hooks/precondition.pb.js): two concurrent sessions edit the same record, and the one
 * that saves against a value the row has already moved past is refused with 409 instead of
 * silently overwriting. Also proves the precondition is opt-in (no expected_updated_at →
 * still 200), that a CURRENT expected_updated_at is accepted, and that the refusal status is
 * 409 specifically so a client can tell it apart from a validation failure (400). Also proves
 * a respelling of the SAME instant (`T`-separated, offset) is accepted while a respelling of a
 * DIFFERENT instant (ms-stripped) or unparseable garbage stays refused.
 *
 * DELETE takes the same precondition (query-string transport, owner ruling 2026-09-06) with
 * the same three outcomes, the 409 names its reason in a `data.expected_updated_at.code` a
 * client can key on without parsing the message, and a collection that carries no guard
 * refuses the key with 400 rather than ignoring it, on a trash-backed collection too (§7b
 * boots the room repeatedly, because hook FILE load order is not stable per boot).
 *
 * §10 proves a CREATE carrying the key is refused 400 rather than accepted as if it had never
 * been sent — a create has no stored row, so the key can guard nothing — and that the three
 * guards register over the same collection set.
 *
 * §9 boots the room in two zones (TZ on the server process) and proves the precondition reads
 * one instant in both: a value naming no zone is UTC, never the server's own clock, and the
 * separator set is a space or an uppercase `T` — a lowercase `t` takes the 400 path by rule.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures, real member/admin auth (never superuser — the proof is about the hook as an
 * ordinary caller meets it). Port 8133 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  json_dumps,
  py_repr,
  py_rstrip,
  py_strip,
  read_text,
  run_checked,
  splitlines,
  truthy,
  url_error_reason,
  urlencode,
  py_get,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8133 + PORT_OFFSET;
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

function check_no_mechanism(origin: string, message: string): void {
  // Every refusal a user can see states what happened, never how it was detected.
  check(`${origin}: message is non-empty`, truthy(message), true);
  for (const word of [
    "409",
    "400",
    "version",
    "revision",
    "conflict",
    "precondition",
    "updated_at",
  ]) {
    check(
      `${origin}: message does not contain ${py_repr(word)}`,
      message.toLowerCase().includes(word.toLowerCase()),
      false,
    );
  }
}

function stale_code(body: any): any {
  // -> the machine-readable reason a client keys on, or None when the body carries none.
  return ((body.data || {}).expected_updated_at || {}).code ?? null;
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

async function api_form(
  method: string,
  path: string,
  token: string,
  fields: Record<string, any>,
): Promise<[number, any]> {
  // The same call as a browser form post: multipart/form-data, not JSON.
  const boundary = "staleWriteProbeBoundary";
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  const data = parts.join("") + `--${boundary}--\r\n`;
  const r = await fetch(BASE_URL + path, {
    method,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Authorization: token },
    body: data,
  });
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}

tierkit.use(api);

function esc(value: string): string {
  return value.replaceAll("'", "\\'");
}

function respell(value: string): [string, string, string] {
  // T-separated, offset-spelled, and ms-stripped variants of a `stored` timestamp.
  const t_form = value.replaceAll(" ", "T");
  const offset_form = t_form.endsWith("Z") ? t_form.slice(0, -1) + "+00:00" : t_form;
  const ms_stripped = t_form.split(".")[0] + "Z";
  return [t_form, offset_form, ms_stripped];
}

function has_nonzero_ms(value: string): boolean {
  // a `.000Z`/no-fraction `updated` round-trips through ms-stripping unchanged — that
  // false-same-instant would silently pass the ms-stripped-stays-409 case for free.
  const frac = value.includes(".") ? py_rstrip(value.slice(value.indexOf(".") + 1), "Z") : "";
  return py_strip(frac, "0") !== "";
}

console.log("\n── (0) pure guard: has_nonzero_ms() catches a `.000Z`/no-fraction round-trip ──");
check(
  "has_nonzero_ms: '.000Z' reads as a zero fraction",
  has_nonzero_ms("2026-09-06 23:31:39.000Z"),
  false,
);
check(
  "has_nonzero_ms: no fractional part reads as a zero fraction",
  has_nonzero_ms("2026-09-06 23:31:39Z"),
  false,
);
check(
  "has_nonzero_ms: '.123Z' reads as a non-zero fraction",
  has_nonzero_ms("2026-09-06 23:31:39.123Z"),
  true,
);

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

async function start_server(
  data_dir: string,
  migrations_dir: string,
  tz: string | null = null,
): Promise<roomkit.Room> {
  // `tz` sets the SERVER process's zone — Go reads TZ into time.Local, which is the zone a
  // JSVM date parser resolves a value that names none against. roomkit.serve() inherits
  // process.env (no env= param), so the zone rides a scoped mutation instead.
  const prev_tz = process.env.TZ;
  if (tz) process.env.TZ = tz;
  try {
    return await roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
  } finally {
    if (tz) {
      if (prev_tz === undefined) delete process.env.TZ;
      else process.env.TZ = prev_tz;
    }
  }
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

async function read_record(collection: string, rec_id: any, token: string | null): Promise<any> {
  const [, r] = await api("GET", `/api/collections/${collection}/records/${rec_id}`, token);
  return r;
}

async function ensure_nonzero_ms(
  collection: string,
  rec_id: any,
  token: string | null,
  keep_name: any,
): Promise<string> {
  // Bump `updated` (the proven opt-out PATCH) until its ms fraction is non-zero.
  //
  // Bounded retry against a real ~1-in-1000 clock alignment (see has_nonzero_ms); fails
  // loudly with every value it saw rather than proceeding with a meaningless assertion.
  const seen: any[] = [];
  for (let i = 0; i < 5; i++) {
    const current = (await read_record(collection, rec_id, token)).updated;
    seen.push(current ?? null);
    if (has_nonzero_ms(current)) return current;
    const [s] = await api("PATCH", `/api/collections/${collection}/records/${rec_id}`, token, {
      name: keep_name,
    });
    check(`${collection}: bump write for a non-zero-ms probe → 200`, s, 200);
  }
  throw new roomkit.SystemExit(
    `${collection}: never saw a non-zero-ms \`updated\` in 5 attempts: ${py_repr(seen)}`,
  );
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-stale-write-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
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

  let [alice, alice_id] = await login("alice@example.com");
  let [bob, bob_id] = await login("bob@example.com");
  const ALICE_WS = await find_id("workspaces", "name", "Alice's Workspace", alice);

  let s: number;
  let r: any;

  // ══════════════════ 1. templates ════════════════════════════════════════════
  // Two real sessions on the same record: A = Alice (workspace owner), B = Bob at the
  // admin tier. No superuser anywhere — a superuser bypasses the collection rules and
  // would prove the hook only against a bypass path.
  // COVERS: hook:precondition.pb.js#onRecordUpdateRequest:*
  console.log("\n── (1) templates: A loads, B saves, A saves stale ──");
  const bob_tier = await tierkit.actor_at_tier(ALICE_WS, bob_id, "admin", alice, "Bob");
  check("Bob is at the admin tier for the templates probes", await bob_tier.now(), "admin");

  let tpl: any;
  [s, tpl] = await api("POST", "/api/collections/templates/records", alice, {
    workspace: ALICE_WS,
    type: "task",
    name: "Shared Template",
  });
  check("(fixture) Alice creates a template → 200", s, 200);
  const tpl_id = tpl.id;

  let a_loaded = await read_record("templates", tpl_id, alice);
  let a_seen_updated = a_loaded.updated ?? null;
  console.log(
    `  [A] loads the template: updated=${py_repr(a_seen_updated)} name=${py_repr(a_loaded.name ?? null)}`,
  );

  // The guard's token has millisecond granularity (kata wr9v: same-ms writes pass, >=2 ms never).
  // Bun can land B's write in the create's millisecond; wait so B's write provably moves `updated`.
  await Bun.sleep(2);

  let b_wrote: any;
  [s, b_wrote] = await api("PATCH", `/api/collections/templates/records/${tpl_id}`, bob, {
    name: "B wrote this",
    expected_updated_at: a_seen_updated,
  });
  check("B saves with a CURRENT expected_updated_at → 200", s, 200);
  check("B's write took effect", b_wrote.name, "B wrote this");
  console.log(
    `  [B] wrote: updated=${py_repr(b_wrote.updated ?? null)} name=${py_repr(b_wrote.name ?? null)}`,
  );
  check("B's write moved `updated` past what A holds", b_wrote.updated !== a_seen_updated, true);

  let refused: any;
  [s, refused] = await api("PATCH", `/api/collections/templates/records/${tpl_id}`, alice, {
    name: "A wrote this",
    expected_updated_at: a_seen_updated,
  });
  console.log(`  [A] saves stale → status=${s} body=${json_dumps(refused)}`);
  const tpl_stale_message = refused.message || "";
  check("A saves with a STALE expected_updated_at → 409", s, 409);
  check("the refusal is NOT a validation failure (400)", s !== 400, true);
  check(
    "the refusal message says what happened in plain language",
    tpl_stale_message,
    "Someone else changed this since you opened it.",
  );
  // A client cannot key on the status (409 is the generic state refusal) nor on the message
  // (PB capitalizes and period-terminates a hook message on the wire), so the reason travels
  // as a data code.
  check(
    "the refusal names its reason in a data code, not in the status or the message",
    stale_code(refused),
    "stale_write",
  );

  let after = await read_record("templates", tpl_id, alice);
  check("the record still holds B's value (A's write was refused)", after.name, "B wrote this");
  check("the record's `updated` is still B's", after.updated, b_wrote.updated);

  let reloaded: any;
  [s, reloaded] = await api("PATCH", `/api/collections/templates/records/${tpl_id}`, alice, {
    name: "A wrote this after reloading",
    expected_updated_at: after.updated ?? null,
  });
  check("A reloads and re-saves with the CURRENT value → 200", s, 200);
  check("A's re-save took effect", reloaded.name, "A wrote this after reloading");

  let no_precondition: any;
  [s, no_precondition] = await api("PATCH", `/api/collections/templates/records/${tpl_id}`, alice, {
    name: "No precondition sent",
  });
  check("a PATCH sending NO expected_updated_at → 200 (opt-in)", s, 200);
  check(
    "that write took effect (no existing caller breaks)",
    no_precondition.name,
    "No precondition sent",
  );

  await tierkit.actor_at_tier(ALICE_WS, bob_id, "member", alice, "Bob");

  // ══════════════════ 2. saved_views ══════════════════════════════════════════
  // A = Bob (a plain member, editing his OWN workspace-scoped view); B = Alice (the
  // workspace owner, whom the updateRule also admits). Both are ordinary user sessions.
  console.log("\n── (2) saved_views: A loads, B saves, A saves stale ──");
  let view: any;
  [s, view] = await api("POST", "/api/collections/saved_views/records", bob, {
    workspace: ALICE_WS,
    owner: bob_id,
    name: "Shared View",
    filterData: {},
    scope: "workspace",
  });
  check("(fixture) Bob (member) creates a workspace-scoped view → 200", s, 200);
  const view_id = view.id;

  a_loaded = await read_record("saved_views", view_id, bob);
  a_seen_updated = a_loaded.updated ?? null;
  console.log(
    `  [A] loads the view: updated=${py_repr(a_seen_updated)} name=${py_repr(a_loaded.name ?? null)}`,
  );

  // The guard's token has millisecond granularity (kata wr9v: same-ms writes pass, >=2 ms never).
  // Bun can land B's write in the create's millisecond; wait so B's write provably moves `updated`.
  await Bun.sleep(2);

  [s, b_wrote] = await api("PATCH", `/api/collections/saved_views/records/${view_id}`, alice, {
    name: "B wrote the view",
    expected_updated_at: a_seen_updated,
  });
  check("B saves with a CURRENT expected_updated_at → 200", s, 200);
  check("B's write took effect", b_wrote.name, "B wrote the view");
  console.log(
    `  [B] wrote: updated=${py_repr(b_wrote.updated ?? null)} name=${py_repr(b_wrote.name ?? null)}`,
  );

  [s, refused] = await api("PATCH", `/api/collections/saved_views/records/${view_id}`, bob, {
    name: "A wrote the view",
    expected_updated_at: a_seen_updated,
  });
  console.log(`  [A] saves stale → status=${s} body=${json_dumps(refused)}`);
  const view_stale_message = refused.message || "";
  check("A saves with a STALE expected_updated_at → 409", s, 409);
  check("the refusal is NOT a validation failure (400)", s !== 400, true);
  check(
    "the refusal message says what happened in plain language",
    view_stale_message,
    "Someone else changed this since you opened it.",
  );
  check(
    "the refusal names its reason in a data code, not in the status or the message",
    stale_code(refused),
    "stale_write",
  );

  after = await read_record("saved_views", view_id, bob);
  check("the record still holds B's value (A's write was refused)", after.name, "B wrote the view");
  check("the record's `updated` is still B's", after.updated, b_wrote.updated);

  [s, reloaded] = await api("PATCH", `/api/collections/saved_views/records/${view_id}`, bob, {
    name: "A wrote the view after reloading",
    expected_updated_at: after.updated ?? null,
  });
  check("A reloads and re-saves with the CURRENT value → 200", s, 200);
  check("A's re-save took effect", reloaded.name, "A wrote the view after reloading");

  [s, no_precondition] = await api(
    "PATCH",
    `/api/collections/saved_views/records/${view_id}`,
    bob,
    {
      name: "No precondition sent",
    },
  );
  check("a PATCH sending NO expected_updated_at → 200 (opt-in)", s, 200);
  check(
    "that write took effect (no existing caller breaks)",
    no_precondition.name,
    "No precondition sent",
  );

  // ══════════════════ 3. a PRESENT but unusable precondition ══════════════════
  // A caller that sends the key believes it is protected, so a value the guard cannot
  // compare must be refused (400), never quietly ignored back into last-write-wins.
  console.log("\n── (3) a present-but-unusable expected_updated_at is refused, not ignored ──");
  let bad_precondition_message = "";
  for (const [collection, rec_id, token, keep] of [
    ["templates", tpl_id, alice, "No precondition sent"],
    ["saved_views", view_id, bob, "No precondition sent"],
  ] as const) {
    const stored_now = (await read_record(collection, rec_id, token)).updated ?? null;
    for (const [label, value] of [
      ["empty string", ""],
      ["number", 0],
      ["null", null],
      ["boolean", true],
      ["array holding the stored value", [stored_now]],
      ["object holding the stored value", { value: stored_now }],
    ] as const) {
      [s, r] = await api("PATCH", `/api/collections/${collection}/records/${rec_id}`, token, {
        name: `overwrote via ${label}`,
        expected_updated_at: value,
      });
      check(`${collection}: expected_updated_at as ${label} → 400`, s, 400);
      bad_precondition_message = bad_precondition_message || r.message || "";
      check(
        `${collection}: the record was NOT overwritten via ${label}`,
        (await read_record(collection, rec_id, token)).name,
        keep,
      );
    }
  }
  console.log(`  the 400 message on the wire: ${py_repr(bad_precondition_message)}`);

  // ══════════════════ 4. every refusal message carries no mechanism ═══════════
  // (§8 extends this to the delete and unguarded-collection paths, once they have run.)
  console.log("\n── (4) no refusal message leaks mechanism into user-facing copy ──");
  for (const [origin, message] of [
    ["templates 409", tpl_stale_message],
    ["saved_views 409", view_stale_message],
    ["unusable-precondition 400", bad_precondition_message],
  ] as const) {
    check_no_mechanism(origin, message);
  }

  // ══════════════════ 5. respelling: same instant accepted, different instant refused ═══
  // A caller honouring the OpenAPI contract's declared date-time format sends `T`-separated
  // or offset-spelled timestamps for the SAME instant `updated` holds; those must be
  // accepted. Every spelling below is derived from the room's own served value, never a
  // hardcoded literal.
  console.log(
    "\n── (5) expected_updated_at: same-instant respellings accepted, others stay refused ──",
  );

  for (const [collection, create_path, create_body, token] of [
    [
      "templates",
      "/api/collections/templates/records",
      { workspace: ALICE_WS, type: "task", name: "Respelling Probe" },
      alice,
    ],
    [
      "saved_views",
      "/api/collections/saved_views/records",
      {
        workspace: ALICE_WS,
        owner: bob_id,
        name: "Respelling Probe",
        filterData: {},
        scope: "workspace",
      },
      bob,
    ],
  ] as const) {
    let rec: any;
    [s, rec] = await api("POST", create_path, token, create_body);
    check(`(fixture) ${collection}: create respelling-probe record → 200`, s, 200);
    const rec_id = rec.id;
    // each spelling is re-derived from a fresh GET (not chained from the previous PATCH's
    // response) so this section's own assertions hold whether or not that PATCH landed
    let last_good_name: any = create_body.name;

    let stored: any = (await read_record(collection, rec_id, token)).updated;
    const [t_form] = respell(stored);
    console.log(
      `  ${collection}: stored updated=${py_repr(stored)} → T-separated=${py_repr(t_form)}`,
    );
    [s, r] = await api("PATCH", `/api/collections/${collection}/records/${rec_id}`, token, {
      name: "same instant, T-separated",
      expected_updated_at: t_form,
    });
    check(`${collection}: T-separated respelling of the SAME instant → 200`, s, 200);
    if (s === 200) last_good_name = getitem(r, "name");

    stored = (await read_record(collection, rec_id, token)).updated;
    const [, offset_form] = respell(stored);
    console.log(
      `  ${collection}: stored updated=${py_repr(stored)} → offset-spelled=${py_repr(offset_form)}`,
    );
    [s, r] = await api("PATCH", `/api/collections/${collection}/records/${rec_id}`, token, {
      name: "same instant, offset-spelled",
      expected_updated_at: offset_form,
    });
    check(`${collection}: offset-spelled respelling of the SAME instant → 200`, s, 200);
    if (s === 200) last_good_name = getitem(r, "name");

    stored = await ensure_nonzero_ms(collection, rec_id, token, last_good_name);
    const [, , ms_stripped] = respell(stored);
    console.log(
      `  ${collection}: stored updated=${py_repr(stored)} → ms-stripped=${py_repr(ms_stripped)}`,
    );
    [s, r] = await api("PATCH", `/api/collections/${collection}/records/${rec_id}`, token, {
      name: "ms-stripped overwrite attempt",
      expected_updated_at: ms_stripped,
    });
    check(`${collection}: ms-stripped (a DIFFERENT instant) respelling → 409`, s, 409);
    check(
      `${collection}: the ms-stripped attempt did NOT overwrite the record`,
      (await read_record(collection, rec_id, token)).name,
      last_good_name,
    );

    [s, r] = await api("PATCH", `/api/collections/${collection}/records/${rec_id}`, token, {
      name: "garbage overwrite attempt",
      expected_updated_at: "not-a-timestamp",
    });
    // A value that names no instant is unusable, like the empty string and the wrong types
    // in §3 — telling this caller that someone else changed the record would be a lie.
    check(`${collection}: unparseable garbage → 400 (not 409, not 200)`, s, 400);
    check(`${collection}: the garbage refusal names no stale reason`, stale_code(r), null);
    check(
      `${collection}: the garbage attempt did NOT overwrite the record`,
      (await read_record(collection, rec_id, token)).name,
      last_good_name,
    );

    [s] = await api("DELETE", `/api/collections/${collection}/records/${rec_id}`, token);
    check(`cleanup: ${collection} respelling-probe record removed`, s, 204);
  }

  // ══════════════════ 6. DELETE takes the same precondition ═══════════════════
  // Removing the record another session just edited destroys that edit exactly as an
  // overwrite would, so the delete carries the same key — on the query string, the only
  // transport a DELETE has. Same three outcomes as the update: absent → allowed, present
  // and stale → 409, present and unusable → 400.
  // COVERS: hook:precondition.pb.js#onRecordDeleteRequest:*
  console.log("\n── (6) DELETE: stale → refused, current → removed, absent → removed ──");
  const PROBE_BODIES: Record<string, any> = {
    templates: { workspace: ALICE_WS, type: "task", name: "Delete Probe" },
    saved_views: {
      workspace: ALICE_WS,
      owner: bob_id,
      name: "Delete Probe",
      filterData: {},
      scope: "workspace",
    },
  };
  const refusal_messages: Record<string, string> = {};
  for (const [collection, rec_id, token] of [
    ["templates", tpl_id, alice],
    ["saved_views", view_id, bob],
  ] as const) {
    const path = `/api/collections/${collection}/records/${rec_id}`;
    const held = (await read_record(collection, rec_id, token)).updated;
    let moved: any;
    [s, moved] = await api("PATCH", path, token, { name: "moved on after the deleter loaded" });
    check(`${collection}: (fixture) another session edits the row → 200`, s, 200);
    check(
      `${collection}: that edit moved \`updated\` past what the deleter holds`,
      moved.updated !== held,
      true,
    );

    const stale_qs = urlencode({ expected_updated_at: held });
    [s, refused] = await api("DELETE", `${path}?${stale_qs}`, token);
    console.log(
      `  ${collection}: DELETE with a STALE precondition → status=${s} body=${json_dumps(refused)}`,
    );
    check(`${collection}: DELETE with a STALE precondition → 409`, s, 409);
    check(
      `${collection}: the delete refusal names its reason in a data code`,
      stale_code(refused),
      "stale_write",
    );
    refusal_messages[`${collection} delete 409`] = refused.message || "";
    check(
      `${collection}: the record survived the refused delete`,
      (await read_record(collection, rec_id, token)).name,
      "moved on after the deleter loaded",
    );

    let bad: any;
    [s, bad] = await api("DELETE", `${path}?expected_updated_at=`, token);
    check(`${collection}: DELETE with an EMPTY precondition → 400`, s, 400);
    refusal_messages[`${collection} delete unusable-precondition 400`] = bad.message || "";
    check(
      `${collection}: the record survived the empty-precondition delete`,
      (await read_record(collection, rec_id, token)).name,
      "moved on after the deleter loaded",
    );

    [s, bad] = await api("DELETE", `${path}?expected_updated_at=not-a-timestamp`, token);
    check(`${collection}: DELETE with an UNPARSABLE precondition → 400`, s, 400);
    check(`${collection}: that refusal names no stale reason`, stale_code(bad), null);
    check(
      `${collection}: the record survived the unparsable-precondition delete`,
      (await read_record(collection, rec_id, token)).name,
      "moved on after the deleter loaded",
    );

    let spare: any;
    [s, spare] = await api(
      "POST",
      `/api/collections/${collection}/records`,
      token,
      PROBE_BODIES[collection],
    );
    check(`${collection}: (fixture) create a record for the opt-out delete → 200`, s, 200);
    [s] = await api("DELETE", `/api/collections/${collection}/records/${spare.id}`, token);
    check(`${collection}: DELETE sending NO precondition → 204 (opt-in preserved)`, s, 204);

    const current_qs = urlencode({
      expected_updated_at: (await read_record(collection, rec_id, token)).updated,
    });
    [s] = await api("DELETE", `${path}?${current_qs}`, token);
    check(`${collection}: DELETE with the CURRENT precondition → 204`, s, 204);
    [s] = await api("GET", path, token);
    check(`${collection}: the record is gone after the accepted delete → 404`, s, 404);
  }

  // ══════════════════ 7. a collection with no guard refuses the key ═══════════
  // A caller sending the key believes that write is protected. Neither `tasks` nor
  // `comments` carries a precondition, so accepting the write would answer a guarantee
  // that was never given.
  console.log("\n── (7) the key sent to an UNGUARDED collection is refused, not ignored ──");
  const task_id = await find_id("tasks", "title", "Design homepage", alice);
  check("(fixture) a seeded task resolved by title", truthy(task_id), true);
  const task_path = `/api/collections/tasks/records/${task_id}`;
  const task_before = await read_record("tasks", task_id, alice);

  [s, r] = await api("PATCH", task_path, alice, {
    title: "renamed by stale caller",
    expected_updated_at: task_before.updated ?? null,
  });
  const title_now = (await read_record("tasks", task_id, alice)).title;
  console.log(`  tasks PATCH carrying the key → status=${s} title now: ${title_now}`);
  check("tasks: a PATCH carrying the key → 400", s, 400);
  refusal_messages["tasks unguarded 400"] = r.message || "";
  check("tasks: the task was NOT renamed", title_now, task_before.title);

  // Going untagged puts these hooks in front of EVERY write, so the transparency of the
  // key-absent path is what that costs if it is wrong: a non-JSON body must still reach
  // e.next() untouched — and must still be read when it does carry the key.
  [s] = await api_form("PATCH", task_path, alice, { title: "renamed by an ordinary caller" });
  check("tasks: a multipart PATCH sending NO key → 200 (hook is transparent)", s, 200);
  check(
    "tasks: that ordinary write took effect",
    (await read_record("tasks", task_id, alice)).title,
    "renamed by an ordinary caller",
  );
  [s, r] = await api_form("PATCH", task_path, alice, {
    title: "renamed by a form-encoded stale caller",
    expected_updated_at: (await read_record("tasks", task_id, alice)).updated,
  });
  console.log(`  tasks multipart PATCH carrying the key → status=${s} body=${json_dumps(r)}`);
  check("tasks: the same multipart PATCH CARRYING the key → 400", s, 400);
  refusal_messages["tasks unguarded multipart 400"] = r.message || "";
  check(
    "tasks: the form-encoded write did NOT land",
    (await read_record("tasks", task_id, alice)).title,
    "renamed by an ordinary caller",
  );

  let comment: any;
  [s, comment] = await api("POST", "/api/collections/comments/records", alice, {
    task: task_id,
    author: alice_id,
    body: "precondition scope probe",
  });
  check("(fixture) Alice comments on that task → 200", s, 200);
  const comment_path = `/api/collections/comments/records/${comment.id}`;
  const fresh_qs = urlencode({
    expected_updated_at: (await read_record("comments", comment.id, alice)).updated,
  });
  [s, r] = await api("DELETE", `${comment_path}?${fresh_qs}`, alice);
  console.log(`  comments DELETE carrying the key → status=${s} body=${json_dumps(r)}`);
  check("comments: a DELETE carrying the key → 400", s, 400);
  refusal_messages["comments unguarded delete 400"] = r.message || "";
  check(
    "comments: the comment survived the refused delete",
    (await read_record("comments", comment.id, alice)).body,
    "precondition scope probe",
  );
  [s] = await api("DELETE", comment_path, alice);
  check("comments: the same DELETE without the key → 204 (opt-out unchanged)", s, 204);

  // ══════════════════ 7b. a trash-backed collection refuses it on EVERY boot ══
  // A first DELETE of a live document is answered by trash.pb.js with noContent(204), which
  // ENDS the handler chain. Hook FILES load in no stable order from one boot to the next, so
  // while this guard trusted registration order the refusal landed on only some boots
  // (measured before the fix: 8 fresh boots, 5 refused the key and 3 TRASHED the row while
  // carrying it). One boot cannot tell a fixed order from a lucky one, so this repeats over
  // REPEATED FRESH BOOTS of the same seeded room — each `serve` re-registers every hook file
  // from scratch. Bounded: a build without trash.pb.js's own ordered refusal answered 204 on 5 of
  // 10 measured boots, so 10 boots leave under a 1% chance of that regression passing.
  console.log("\n── (7b) a trash-backed DELETE carrying the key is refused on every boot ──");
  const TRASH_BOOTS = 10;
  const trash_backed_statuses: number[] = [];
  for (let boot_no = 0; boot_no < TRASH_BOOTS; boot_no++) {
    if (boot_no) {
      await stop_server(server);
      server = await start_server(DATA_DIR, MIG_DIR);
      [alice, alice_id] = await login("alice@example.com");
    }
    const label = `documents (boot ${boot_no + 1}/${TRASH_BOOTS})`;
    let doc: any;
    [s, doc] = await api("POST", "/api/collections/documents/records", alice, {
      workspace: ALICE_WS,
      title: `trash-backed delete probe ${boot_no}`,
    });
    check(`(fixture) ${label}: a live document to delete → 200`, s, 200);
    const doc_path = `/api/collections/documents/records/${doc.id}`;
    const qs = urlencode({ expected_updated_at: doc.updated });
    [s, r] = await api("DELETE", `${doc_path}?${qs}`, alice);
    trash_backed_statuses.push(s);
    check(`${label}: a DELETE carrying the key → 400`, s, 400);
    refusal_messages["documents unguarded delete 400"] = r.message || "";
    const [after_status, after_doc] = await api("GET", doc_path, alice);
    check(`${label}: the document is still readable (not trashed away)`, after_status, 200);
    // "GONE" when the row is not readable at all, so this cannot pass on a 404 body.
    check(`${label}: the document was not trashed`, py_get(after_doc, "trashed", "GONE"), "");
  }
  console.log(`  statuses across ${TRASH_BOOTS} fresh boots: ${py_repr(trash_backed_statuses)}`);

  // ══════════════════ 8. the new refusal paths carry no mechanism either ══════
  // Every message §6-§7b saw, one entry per path — not one sample standing in for all.
  console.log("\n── (8) no mechanism in the delete / unguarded-collection messages ──");
  check("every refusal path §6-§7b opened was captured", Object.keys(refusal_messages).length, 8);
  for (const origin of Object.keys(refusal_messages).sort(by_code_point)) {
    check_no_mechanism(origin, refusal_messages[origin]!);
  }

  // ══════════════════ 9. one instant, whatever zone the server runs in ════════
  // A caller's value that names no zone must mean the same instant everywhere, or a
  // developer's machine and the deployed container answer the same request differently.
  // The separator set is a space or an uppercase `T` and nothing else, by rule rather than
  // by whatever the JSVM's parser happens to do — a lowercase `t` is unusable, so it takes
  // the 400 path, never the 409 one. Both spellings run against a server booted in TWO
  // zones: one boot cannot tell a zone-independent reading from a lucky one.
  // COVERS: hook:precondition.pb.js#onRecordUpdateRequest:*
  // COVERS: hook:precondition.pb.js#onRecordDeleteRequest:*
  console.log("\n── (9) offsetless reads as UTC in any server zone; a lowercase `t` is refused ──");
  const ZONES = ["UTC", "Asia/Tokyo"];
  const by_zone: Record<string, Record<string, number>> = {};
  for (const zone of ZONES) {
    await stop_server(server);
    server = await start_server(DATA_DIR, MIG_DIR, zone);
    [alice, alice_id] = await login("alice@example.com");
    [bob, bob_id] = await login("bob@example.com");
    const answers: Record<string, number> = {};

    [s, tpl] = await api("POST", "/api/collections/templates/records", alice, {
      workspace: ALICE_WS,
      type: "task",
      name: "Zone Probe",
    });
    check(`(fixture) TZ=${zone}: create a zone-probe template → 200`, s, 200);
    const zone_tpl = `/api/collections/templates/records/${tpl.id}`;

    for (const [label, sep] of [
      ["space-separated", " "],
      ["T-separated", "T"],
    ] as const) {
      const stored = (await read_record("templates", tpl.id, alice)).updated;
      const offsetless = py_rstrip(stored, "Z").replaceAll(" ", sep);
      console.log(
        `  TZ=${zone}: stored=${py_repr(stored)} → offsetless ${label}=${py_repr(offsetless)}`,
      );
      [s] = await api("PATCH", zone_tpl, alice, {
        name: `offsetless ${label}`,
        expected_updated_at: offsetless,
      });
      answers[`update, offsetless ${label}`] = s;
      check(`TZ=${zone}: templates PATCH, offsetless ${label} → 200`, s, 200);
      check(
        `TZ=${zone}: that offsetless ${label} write took effect`,
        (await read_record("templates", tpl.id, alice)).name,
        `offsetless ${label}`,
      );
    }

    let stored = (await read_record("templates", tpl.id, alice)).updated;
    const lower_t = stored.replaceAll(" ", "t");
    console.log(`  TZ=${zone}: stored=${py_repr(stored)} → lowercase-t=${py_repr(lower_t)}`);
    [s, r] = await api("PATCH", zone_tpl, alice, {
      name: "lowercase t",
      expected_updated_at: lower_t,
    });
    answers["update, lowercase t"] = s;
    check(`TZ=${zone}: templates PATCH, lowercase-\`t\` separator → 400`, s, 400);
    check(`TZ=${zone}: that refusal names no stale reason`, stale_code(r), null);
    check(
      `TZ=${zone}: the lowercase-\`t\` write did NOT land`,
      (await read_record("templates", tpl.id, alice)).name,
      "offsetless T-separated",
    );
    // The same instant spelled with the uppercase separator is still accepted, so the 400
    // above is the separator being refused and not the whole section going deaf.
    stored = (await read_record("templates", tpl.id, alice)).updated;
    [s] = await api("PATCH", zone_tpl, alice, {
      name: "uppercase T",
      expected_updated_at: stored.replaceAll(" ", "T"),
    });
    answers["update, uppercase T (control)"] = s;
    check(`TZ=${zone}: templates PATCH, uppercase-\`T\` separator → 200 (control)`, s, 200);
    [s] = await api("DELETE", zone_tpl, alice);
    check(`cleanup: TZ=${zone}: zone-probe template removed`, s, 204);

    // The delete block is byte-parallel with the update one, so it takes the same two
    // spellings over its own transport.
    [s, view] = await api("POST", "/api/collections/saved_views/records", bob, {
      workspace: ALICE_WS,
      owner: bob_id,
      name: "Zone Probe View",
      filterData: {},
      scope: "workspace",
    });
    check(`(fixture) TZ=${zone}: create a zone-probe view → 200`, s, 200);
    const zone_view = `/api/collections/saved_views/records/${view.id}`;

    stored = (await read_record("saved_views", view.id, bob)).updated;
    let qs = urlencode({ expected_updated_at: stored.replaceAll(" ", "t") });
    [s, r] = await api("DELETE", `${zone_view}?${qs}`, bob);
    answers["delete, lowercase t"] = s;
    check(`TZ=${zone}: saved_views DELETE, lowercase-\`t\` separator → 400`, s, 400);
    check(`TZ=${zone}: that delete refusal names no stale reason`, stale_code(r), null);
    [s] = await api("GET", zone_view, bob);
    check(`TZ=${zone}: the view survived the lowercase-\`t\` delete → 200`, s, 200);

    // `or ""` so a build that wrongly honoured the refused delete above fails this check
    // instead of dying on the gone record.
    stored = (await read_record("saved_views", view.id, bob)).updated || "";
    const offsetless = py_rstrip(stored, "Z");
    qs = urlencode({ expected_updated_at: offsetless });
    console.log(
      `  TZ=${zone}: stored=${py_repr(stored)} → offsetless delete precondition=${py_repr(offsetless)}`,
    );
    [s] = await api("DELETE", `${zone_view}?${qs}`, bob);
    answers["delete, offsetless space-separated"] = s;
    check(`TZ=${zone}: saved_views DELETE, offsetless precondition → 204`, s, 204);

    by_zone[zone] = answers;
  }

  for (const label of Object.keys(by_zone[ZONES[0]!]!).sort(by_code_point)) {
    console.log(
      `  ${label.padEnd(38)} ` + ZONES.map((z) => `TZ=${z} → ${by_zone[z]![label]}`).join("  "),
    );
    check(
      `every zone answered the same on: ${label}`,
      new Set(ZONES.map((z) => by_zone[z]![label])).size,
      1,
    );
  }

  // ══════════════════ 10. a CREATE carrying the key is refused, never dropped ═
  // A create has no stored row behind it, so the key can protect nothing — and a caller that
  // sends it believes it holds a guard. Silently accepting the create is the worse failure of
  // the two, so it is refused 400 (owner ruling 2026-09-08, tz7c). The three guards register
  // over the same collection set — every collection, with no filter — so the create refusal
  // reaches exactly where the update and delete ones do: both a guarded collection and one
  // that carries no guard.
  // COVERS: hook:precondition.pb.js#onRecordCreateRequest:*
  console.log("\n── (10) create: the key is refused wherever update and delete see it ──");
  const hook_source = read_text(path.join(REPO_ROOT, "pb_hooks", "precondition.pb.js"));
  const registrations = splitlines(hook_source)
    .filter(
      (line) =>
        line.includes("onRecordCreateRequest") ||
        line.includes("onRecordUpdateRequest") ||
        line.includes("onRecordDeleteRequest"),
    )
    .map((line) => py_strip(line));
  console.log("  registrations: " + registrations.join(" | "));
  check("the three guards register in the forms this file states", registrations, [
    "onRecordCreateRequest((e) => {",
    "onRecordUpdateRequest((e) => {",
    "onRecordDeleteRequest((e) => {",
  ]);
  // A per-collection registration names its collection as a trailing argument (`}, "tasks");`),
  // so its absence is what proves all three guards see the same set: every collection.
  check("no guard here narrows itself to a collection", hook_source.includes('}, "'), false);

  const qs10 = urlencode({ filter: `workspace='${esc(ALICE_WS)}' && shadow=false` });
  const [, projects] = await api("GET", `/api/collections/projects/records?${qs10}`, alice);
  const ALICE_PROJECT = (projects.items || [{}])[0].id ?? null;
  check("(fixture) a real project to create a task in", truthy(ALICE_PROJECT), true);

  const STAMP = "2026-09-08 12:00:00.123Z";
  const create_bodies: Record<string, any> = {
    templates: { workspace: ALICE_WS, type: "task", name: "create-key probe" },
    saved_views: {
      workspace: ALICE_WS,
      owner: alice_id,
      name: "create-key probe",
      filterData: {},
      scope: "personal",
    },
    tasks: { project: ALICE_PROJECT, title: "create-key probe" },
    documents: { workspace: ALICE_WS, title: "create-key probe" },
  };
  for (const [collection, body] of Object.entries(create_bodies)) {
    const before_qs = urlencode({ perPage: 1 });
    const [, before] = await api(
      "GET",
      `/api/collections/${collection}/records?${before_qs}`,
      alice,
    );
    [s, r] = await api("POST", `/api/collections/${collection}/records`, alice, {
      ...body,
      expected_updated_at: STAMP,
    });
    check(`${collection}: a create carrying the key → 400`, s, 400);
    // 400 on its own could be an ordinary validation failure, so the refusal must also
    // name no stale reason and leave nothing behind.
    check(`${collection}: that refusal names no stale reason`, stale_code(r), null);
    check_no_mechanism(`${collection} create 400`, r.message || "");
    const [, after_list] = await api(
      "GET",
      `/api/collections/${collection}/records?${before_qs}`,
      alice,
    );
    check(
      `${collection}: the refused create wrote no row`,
      after_list.totalItems,
      before.totalItems,
    );
    // The control proves the 400 above is the key being refused, not the body being invalid.
    [s] = await api("POST", `/api/collections/${collection}/records`, alice, body);
    check(`${collection}: the same body WITHOUT the key → 200 (control)`, s, 200);
  }

  // ══════════════════ 11. concurrent writes: no panic, no 500 ═════════════════
  // The handler-object registration (`$app.onX().bind({...})`) runs every request in the one
  // loader runtime, so concurrent requests collide inside it: measured against that form, 5
  // rounds of 25 barrier-released requests per shape gave 30 HTTP 500s, each a [PANIC RECOVER].
  // A single-threaded section never sees it, and the panic reaches only the request log, never
  // a response body, so this reads the room's own log as well as the statuses.
  // COVERS: hook:precondition.pb.js#onRecordUpdateRequest:*
  // COVERS: hook:precondition.pb.js#onRecordDeleteRequest:*
  console.log("\n── (11) concurrent PATCH / DELETE: zero 500s and zero panics in the room log ──");
  const CONCURRENT_ROUNDS = 3;
  const BURST = 25;

  type Req = [string, string, string | null, any?];
  const burst = (requests: Req[]): Promise<(number | string)[]> =>
    // The Python released every thread from a threading.Barrier together; here every request
    // is started (fetch issued, un-awaited) before any is awaited, which gives the same
    // all-in-flight-at-once burst.
    Promise.all(
      requests.map(async (req) => {
        try {
          return (await api(...req))[0];
        } catch (exc) {
          // a torn response is counted, not raised
          return exc instanceof SyntaxError ? "JSONDecodeError" : url_error_reason(exc);
        }
      }),
    );

  [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su_token = r.token;
  check("(fixture) superuser token to read the room log", truthy(su_token), true);
  [alice, alice_id] = await login("alice@example.com");
  const ws_path = `/api/collections/workspaces/records/${ALICE_WS}`;
  const ws_name = (await read_record("workspaces", ALICE_WS, alice)).name ?? null;
  const seen = new Map<string, (number | string)[]>();
  const extend = (shape: string, more: (number | string)[]) => {
    if (!seen.has(shape)) seen.set(shape, []);
    seen.get(shape)!.push(...more);
  };
  const rep = (req: Req): Req[] => Array.from({ length: BURST }, () => req);
  for (let rnd = 0; rnd < CONCURRENT_ROUNDS; rnd++) {
    extend("workspace PATCH", await burst(rep(["PATCH", ws_path, alice, { name: ws_name }])));
    [s, view] = await api("POST", "/api/collections/saved_views/records", alice, {
      workspace: ALICE_WS,
      owner: alice_id,
      name: `concurrency ${rnd}`,
      filterData: {},
      scope: "personal",
    });
    check(`(fixture) round ${rnd + 1}: a saved view to write concurrently → 200`, s, 200);
    const vpath = `/api/collections/saved_views/records/${view.id}`;
    extend(
      "saved_views guarded PATCH",
      await burst(
        rep([
          "PATCH",
          vpath,
          alice,
          { name: view.name ?? null, expected_updated_at: view.updated ?? null },
        ]),
      ),
    );
    const vqs = urlencode({
      expected_updated_at: (await read_record("saved_views", view.id, alice)).updated,
    });
    extend("saved_views guarded DELETE", await burst(rep(["DELETE", `${vpath}?${vqs}`, alice])));
    let task: any;
    [s, task] = await api("POST", "/api/collections/tasks/records", alice, {
      project: ALICE_PROJECT,
      title: `concurrency ${rnd}`,
    });
    check(`(fixture) round ${rnd + 1}: a task to write concurrently → 200`, s, 200);
    const tpath = `/api/collections/tasks/records/${task.id}`;
    extend("tasks PATCH", await burst(rep(["PATCH", tpath, alice, { title: task.title ?? null }])));
    extend("tasks DELETE", await burst(rep(["DELETE", tpath, alice])));
  }

  const allowed: Record<string, Set<number>> = {
    "workspace PATCH": new Set([200]),
    "saved_views guarded PATCH": new Set([200, 409]),
    "saved_views guarded DELETE": new Set([204, 404]),
    "tasks PATCH": new Set([200]),
    "tasks DELETE": new Set([204, 404]),
  };
  for (const [shape, statuses] of seen) {
    const tally = new Map<string, number>();
    for (const k of [...new Set(statuses)].sort((a, b) => by_code_point(String(a), String(b)))) {
      tally.set(String(k), statuses.filter((x) => x === k).length);
    }
    console.log(`  ${shape.padEnd(28)} ${statuses.length} requests → ${py_repr(tally)}`);
    check(
      `${shape}: no HTTP 500 across ${statuses.length} concurrent requests`,
      statuses.filter((x) => x === 500).length,
      0,
    );
    check(
      `${shape}: every status is one this write can legitimately get`,
      statuses.every((x) => allowed[shape]!.has(x as number)),
      true,
    );
  }

  // PB writes request logs in batches; a sentinel request fired after the bursts shows the
  // log has caught up before absence of a panic is read as proof.
  const sentinel = `zzconcurrencysentinel${process.pid}`;
  await api("GET", `/api/collections/tasks/records/${sentinel}`, alice);
  let log_caught_up = false;
  let logs: any;
  for (let i = 0; i < 60; i++) {
    [, logs] = await api(
      "GET",
      "/api/logs?" + urlencode({ filter: `data.url ~ '${sentinel}'`, perPage: 1 }),
      su_token,
    );
    if (truthy(logs.totalItems)) {
      log_caught_up = true;
      break;
    }
    await Bun.sleep(500);
  }
  check("the room log caught up past the concurrent bursts", log_caught_up, true);
  for (const [label, flt] of [
    ["[PANIC RECOVER] entries", "data.details ~ 'PANIC'"],
    ["HTTP 500 entries", "data.status = 500"],
  ] as const) {
    [, logs] = await api("GET", "/api/logs?" + urlencode({ filter: flt, perPage: 1 }), su_token);
    check(`room log: ${label} during the concurrent bursts`, logs.totalItems, 0);
    if (truthy(logs.totalItems)) {
      const first = getitem(logs, "items")[0];
      console.log("  first entry: " + json_dumps(py_get(first, "data", {})).slice(0, 600));
    }
  }
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);

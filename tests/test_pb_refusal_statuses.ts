#!/usr/bin/env bun
/**
 * E2E pin of the HTTP status PocketBase itself answers each refusal shape with, so a platform
 * upgrade that moves one turns this RED instead of silently invalidating whatever is built on it.
 *
 * Clients see PocketBase's status straight through, so for a large share of the API's
 * non-2xx responses PocketBase is the only producer. Every status in PB_REFUSAL_STATUSES below
 * is measured here against this repo's own collections and hooks, never assumed.
 *
 * Two route families answer differently and both are pinned: a COLLECTION RECORD route has no auth
 * middleware, so a missing or malformed token makes the caller a guest and the rule decides the
 * status (404 on a view, 200-empty on a list); a route behind `$apis.requireAuth()` — PocketBase's
 * own auth-refresh, and this repo's /api/tracker/* — refuses with 401 before any rule runs. 403 has
 * two producers, not one: a NULL rule, and a non-null authRule the account fails (the live login
 * path), which is why `auth_denied` is its own row.
 *
 * A denied answer is byte-identical to the one a guest gets, so §0b is a positive control: the same
 * token that is denied everywhere below is shown buying a 200 first, or the whole table would pass
 * green on a token that never authenticated.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts fixtures
 * resolved by name, real member/non-member auth (never superuser — the proof is about the statuses
 * an ordinary caller meets). Port 8147 + PB_PORT_OFFSET — the 8100+ suite self-boot band
 * (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_strip, read_text, run_checked, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

// The platform's refusal statuses, measured by this suite. A sibling gate imports this dict as
// the single source of which non-2xx codes PocketBase itself can produce — its name and flat
// shape are load-bearing, so importing this module must stay free of side effects (the room boots
// under the import.meta.main guard below).
export const PB_REFUSAL_STATUSES: Record<string, number> = {
  list_denied: 200,
  view_denied: 404,
  view_missing: 404,
  create_denied: 400,
  update_denied: 404,
  delete_denied: 404,
  field_invalid: 400,
  hook_refused: 400,
  stale_write: 409,
  unauthenticated: 404,
  bad_token: 401,
  auth_denied: 403,
};

const REPO_ROOT = path.dirname(import.meta.dir);
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8147 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const USER_PASSWORD = "test123456";
const BAD_TOKEN = "not-a-token";

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
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

async function first_by_filter(collection: string, filt: string, token: string | null) {
  const qs = urlencode({ filter: filt, perPage: 1 });
  const [, r] = await api("GET", `/api/collections/${collection}/records?${qs}`, token);
  const items = r.items || [];
  if (!items.length) {
    throw new roomkit.SystemExit(`❌ fixture missing: no ${collection} matching ${py_repr(filt)}`);
  }
  return items[0];
}

async function auth(email: string): Promise<[string, string | null]> {
  const [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: USER_PASSWORD,
  });
  return [roomkit.token_of(BASE_URL, email, { ...r, status: s }), (r.record || {}).id ?? null];
}

function field_code(body: any, field: string): any {
  return ((body.data || {})[field] || {}).code ?? null;
}

async function superuser_token(): Promise<string> {
  const [s, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  return roomkit.token_of(BASE_URL, SU_EMAIL, { ...r, status: s });
}

function pinned_pb_version(): string {
  /** The one pin the battery refuses a mismatched binary against, read from its own source. */
  const battery = path.join(REPO_ROOT, "scripts", "run_suite_battery.sh");
  const found = /^PB_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"/m.exec(read_text(battery));
  if (!found) throw new roomkit.SystemExit(`❌ no PB_VERSION pin found in ${battery}`);
  return found[1];
}

function running_pb_version(pb_bin: string): string {
  const stdout = run_checked([pb_bin, "--version"], { capture_output: true, text: true }).stdout!;
  const found = /[0-9]+\.[0-9]+\.[0-9]+/.exec(stdout);
  return found ? found[0] : py_strip(stdout);
}

async function main(): Promise<number> {
  // A table measured on another build is a table about another platform, and a solo run gets
  // none of run_suite_battery.sh's PB_BIN version refusal.
  console.log("\n── (0) the room runs the pinned PocketBase ──");
  check(
    "server binary version == scripts/run_suite_battery.sh's PB_VERSION",
    running_pb_version(roomkit.pb_bin()),
    pinned_pb_version(),
  );
  if (failures) {
    console.log("\n❌ refusing to measure refusal statuses on an unpinned PocketBase");
    return 1;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pb-refusal-statuses-test-"));
  const mig_dir = path.join(scratch, "pb_migrations");
  const data_dir = path.join(scratch, "pb_data");
  fs.mkdirSync(data_dir, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "pb_migrations"), mig_dir, { recursive: true, dereference: true });
  for (const name of fs.readdirSync(mig_dir)) {
    if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(mig_dir, name));
  }

  let server: roomkit.Room | null = null;
  try {
    run_checked(
      [
        roomkit.pb_bin(),
        "superuser",
        "upsert",
        SU_EMAIL,
        SU_PASSWORD,
        "--dir",
        data_dir,
        "--migrationsDir",
        mig_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    server = await roomkit.serve(PORT, data_dir, mig_dir, roomkit.hooks_dir(scratch));
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
    if (seed_rc) {
      throw new roomkit.SystemExit(`❌ seed failed:\n${seed_out}\n${seed_err}`);
    }

    // Alice owns the seeded workspace; Carol is the non-member the rules exclude.
    const [alice, alice_id] = await auth("alice@example.com");
    const [carol, carol_id] = await auth("carol@example.com");
    const task = await first_by_filter("tasks", "trashed = ''", alice);
    const task_id = getitem(task, "id");
    const ws_id = getitem(
      await first_by_filter("workspaces", `owner = '${alice_id}'`, alice),
      "id",
    );
    // shadow = false is asked for, never left to the listRule: as a superuser the same
    // filter returns the invisible per-workspace container and the creates below would be
    // refused by the shadow hook instead of by the rule under test.
    const carol_ws_id = getitem(
      await first_by_filter("workspaces", `owner = '${carol_id}'`, carol),
      "id",
    );
    const project_id = getitem(
      await first_by_filter("projects", `workspace = '${ws_id}' && shadow = false`, alice),
      "id",
    );

    let s: number;

    // ══════════ 0b. the denied tokens are real, authenticated tokens ═════
    // Every denial below is byte-identical to the answer a guest gets, so without this
    // control the whole suite would pass green on a token-minting bug.
    console.log("\n── (0b) positive control: each denied actor's token buys a 200 ──");
    let own: any, mine: any, listed: any;
    [s, own] = await api("GET", `/api/collections/workspaces/records/${carol_ws_id}`, carol);
    check("Carol's token reads Carol's own workspace", s, 200);
    check("...and it is the record asked for", own.id ?? null, carol_ws_id);
    [s] = await api("GET", `/api/collections/workspaces/records/${carol_ws_id}`);
    check("...the same GET with no token", s, 404);
    [s] = await api("GET", `/api/collections/workspaces/records/${carol_ws_id}`, BAD_TOKEN);
    check("...the same GET with a token PB cannot read", s, 404);
    [s, mine] = await api("GET", `/api/collections/tasks/records/${task_id}`, alice);
    check("Alice's token reads the task Carol is denied", s, 200);
    check("...and it is the record asked for", mine.id ?? null, task_id);

    // ══════════ 1. the rule statuses, on tasks, as a non-member ══════════
    console.log("\n── (1) collection rules refuse a non-member ──");
    [s, listed] = await api("GET", "/api/collections/tasks/records?perPage=50", carol);
    check("list a non-member may see no row of → filtered", s, PB_REFUSAL_STATUSES["list_denied"]);
    check("...and the filtered list is empty, not an error", listed.totalItems ?? null, 0);

    [s] = await api("GET", `/api/collections/tasks/records/${task_id}`, carol);
    check("view a row the viewRule denies", s, PB_REFUSAL_STATUSES["view_denied"]);

    [s] = await api("GET", "/api/collections/tasks/records/zzzzzzzzzzzzzzz", alice);
    check("view an id that does not exist", s, PB_REFUSAL_STATUSES["view_missing"]);

    [s] = await api("POST", "/api/collections/tasks/records", carol, {
      title: "refused",
      project: project_id,
    });
    check("create a non-member's createRule denies", s, PB_REFUSAL_STATUSES["create_denied"]);

    // Carol's OWN workspace, so nothing in the body is a record she cannot see: only the
    // createRule's `@request.body.shadow:isset = false` clause can refuse this one.
    [s] = await api("POST", "/api/collections/projects/records", carol, {
      name: "own ws",
      owner: carol_id,
      workspace: carol_ws_id,
      shadow: true,
    });
    check(
      "create refused by a rule clause alone, no hidden relation",
      s,
      PB_REFUSAL_STATUSES["create_denied"],
    );

    [s] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, carol, { title: "no" });
    check("update the updateRule denies", s, PB_REFUSAL_STATUSES["update_denied"]);

    [s] = await api("DELETE", `/api/collections/tasks/records/${task_id}`, carol);
    check("delete the deleteRule denies", s, PB_REFUSAL_STATUSES["delete_denied"]);

    // ══════════ 2. field validation, and a hook's own refusal ═══════════
    console.log("\n── (2) field validation and pb_hooks refusals ──");
    let missing: any, bad_select: any, hook: any, view: any, stale: any;
    [s, missing] = await api("POST", "/api/collections/tasks/records", alice, {
      project: project_id,
    });
    check("create missing a required field", s, PB_REFUSAL_STATUSES["field_invalid"]);
    check("...names the field and its rule", field_code(missing, "title"), "validation_required");

    [s, bad_select] = await api("POST", "/api/collections/saved_views/records", alice, {
      workspace: ws_id,
      owner: alice_id,
      name: "pin",
      scope: "not-a-scope",
    });
    check("create with a value outside a select", s, PB_REFUSAL_STATUSES["field_invalid"]);
    check(
      "...names the field and its rule",
      field_code(bad_select, "scope"),
      "validation_invalid_value",
    );

    [s, hook] = await api("PATCH", `/api/collections/tasks/records/${task_id}`, alice, {
      key: "ZZZ-9",
    });
    check("update a pb_hooks BadRequestError refuses", s, PB_REFUSAL_STATUSES["hook_refused"]);
    check(
      "...the message is the hook's own",
      (hook.message || "").toLowerCase().startsWith("key is immutable"),
      true,
    );

    [s, view] = await api("POST", "/api/collections/saved_views/records", alice, {
      workspace: ws_id,
      owner: alice_id,
      name: "pin stale",
      scope: "personal",
    });
    check("saved_view fixture for the stale-write guard", s, 200);
    [s, stale] = await api(
      "PATCH",
      `/api/collections/saved_views/records/${view.id ?? null}`,
      alice,
      { name: "stale", expected_updated_at: "2020-01-01 00:00:00.000Z" },
    );
    check("update against a stale `updated`", s, PB_REFUSAL_STATUSES["stale_write"]);
    check(
      "...names the rule a client keys on",
      field_code(stale, "expected_updated_at"),
      "stale_write",
    );

    // ══════════ 3. no token, and a token PB cannot read ═════════════════
    console.log("\n── (3) a record route has no auth middleware: the rule decides ──");
    let anon_list: any, bad_list: any, refused: any, null_rule: any, unapproved: any, wrong: any;
    [s] = await api("GET", `/api/collections/tasks/records/${task_id}`);
    check("view with no Authorization header", s, PB_REFUSAL_STATUSES["unauthenticated"]);
    [s, anon_list] = await api("GET", "/api/collections/tasks/records?perPage=50");
    check("list with no Authorization header → filtered, not refused", s, 200);
    check("...and it is empty", anon_list.totalItems ?? null, 0);
    [s] = await api("POST", "/api/collections/tasks/records", null, { title: "anon" });
    check("create with no Authorization header", s, 400);

    [s] = await api("GET", `/api/collections/tasks/records/${task_id}`, BAD_TOKEN);
    check("view with a token PB cannot read → guest, so the rule decides", s, 404);
    [s, bad_list] = await api("GET", "/api/collections/tasks/records?perPage=50", BAD_TOKEN);
    check("list with a token PB cannot read → filtered", s, 200);
    check("...and it is empty", bad_list.totalItems ?? null, 0);

    console.log("\n── (4) a route behind requireAuth refuses before any rule runs ──");
    [s, refused] = await api("GET", "/api/tracker/search?q=x", BAD_TOKEN);
    check("custom route, token PB cannot read", s, PB_REFUSAL_STATUSES["bad_token"]);
    check(
      "...names the token, not the resource",
      (refused.message || "").toLowerCase().includes("token"),
      true,
    );
    [s] = await api("GET", "/api/tracker/search?q=x");
    check("custom route, no Authorization header", s, PB_REFUSAL_STATUSES["bad_token"]);
    [s] = await api("POST", "/api/collections/users/auth-refresh", BAD_TOKEN);
    check("PocketBase's own auth-refresh, token PB cannot read", s, 401);

    // ══════════ 5. a null rule is the one 403 ═══════════════════════════
    console.log("\n── (5) a null rule refuses everyone but a superuser ──");
    [s, null_rule] = await api("POST", "/api/collections/notifications/records", alice, {
      user: alice_id,
      kind: "assigned",
    });
    check("create on a collection whose createRule is null", s, 403);
    check(
      "...says superusers only",
      (null_rule.message || "").toLowerCase().includes("superuser"),
      true,
    );

    // ══════════ 6. a NON-null authRule is the other 403 ═════════════════
    // users.authRule = "verified = true && approved = true": 403 does NOT imply a null
    // rule, and the login path that produces it is live code, not dead.
    console.log("\n── (6) the login authRule refuses 403, a wrong password 400 ──");
    const su = await superuser_token();
    const bob_id = getitem(await first_by_filter("users", "name = 'Bob'", su), "id");
    [s] = await api("PATCH", `/api/collections/users/records/${bob_id}`, su, { approved: false });
    check("superuser un-approves an account", s, 200);
    [s, unapproved] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: "bob@example.com",
      password: USER_PASSWORD,
    });
    check("verified but unapproved login", s, PB_REFUSAL_STATUSES["auth_denied"]);
    check(
      "...names the collection's requirements, not the credentials",
      (unapproved.message || "").toLowerCase().includes("requirements"),
      true,
    );

    [s] = await api("PATCH", `/api/collections/users/records/${bob_id}`, su, {
      approved: true,
      verified: false,
    });
    check("superuser re-approves but un-verifies", s, 200);
    [s] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: "bob@example.com",
      password: USER_PASSWORD,
    });
    check("approved but unverified login", s, PB_REFUSAL_STATUSES["auth_denied"]);

    [s, wrong] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: "alice@example.com",
      password: "wrongpassword",
    });
    check("an account that PASSES the authRule, wrong password", s, 400);
    check(
      "...so the two are distinguishable on the wire",
      (wrong.message || "").toLowerCase().includes("requirements"),
      false,
    );
  } finally {
    if (server !== null) await roomkit.stop(server);
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log();
  if (failures) {
    console.log(`❌ ${failures} check(s) FAILED`);
    return 1;
  }
  console.log("✅ every PocketBase refusal status is the one PB_REFUSAL_STATUSES declares");
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

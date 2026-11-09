#!/usr/bin/env bun
/**
 * Proof of scripts/utilities/email_collision_audit.ts (PBTT-528): legacy rows that
 * would collide under the email_key policy are detected, classified, and given a
 * suggested disposition — and the policy's boundaries hold (non-Gmail dots stay
 * significant; gmail.com and googlemail.com never fold into each other).
 *
 * The live create hook (pb_hooks/auth_identity.pb.js) canonicalizes emails, so a
 * mixed-case or padded address cannot be seeded over the API — users are created via
 * API, then rewritten into legacy shape with direct sqlite UPDATEs after the room shuts
 * down, which is exactly the population the audit targets. Clean room on port 8115 +
 * PB_PORT_OFFSET, self-boot band (8100+).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, decode_text, py_str, run_checked, sqlite_connect } from "../scripts/_py.ts";
import * as audit_mod from "../scripts/utilities/email_collision_audit.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const AUDIT_SCRIPT = path.join(REPO_ROOT, "scripts", "utilities", "email_collision_audit.ts");
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
// Suffix, never a timestamp: a baseline rebuild renames it and a stale literal leaves MFA on.
const MFA_SUFFIX = "superuser_mfa.js";

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8115 + PORT_OFFSET;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  const mark = ok ? "✅" : "❌ MISMATCH";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label.padEnd(64)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

async function api(
  base_url: string,
  method: string,
  path: string,
  body: any = null,
  token: string | null = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(base_url + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return [204, {}];
  if (r.ok) return [r.status, await r.json()];
  const raw = await r.text();
  try {
    return [r.status, JSON.parse(raw || "{}")];
  } catch {
    return [r.status, {}];
  }
}

/**
 * One self-contained clean room: fresh --dir, a COPY of pb_migrations (MFA
 * migration dropped for plain superuser auth), hooksDir via roomkit.hooks_dir.
 */
class Room {
  port: number;
  base_url: string;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  proc: roomkit.Room | null = null;

  constructor(port: number) {
    this.port = port;
    this.base_url = `http://127.0.0.1:${port}`;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-email-audit-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    fs.mkdirSync(this.data_dir, { recursive: true });
    copy_tree(REAL_MIGRATIONS_DIR, this.migrations_dir);
    for (const name of fs.readdirSync(this.migrations_dir)) {
      if (name.endsWith(MFA_SUFFIX)) fs.rmSync(path.join(this.migrations_dir, name));
    }
  }

  async start(): Promise<void> {
    await roomkit.require_free_port(this.port);
    run_checked(
      [
        POCKETBASE_BIN,
        "superuser",
        "upsert",
        SU_EMAIL,
        SU_PASSWORD,
        "--dir",
        this.data_dir,
        "--migrationsDir",
        this.migrations_dir,
      ],
      { cwd: REPO_ROOT, capture_output: true },
    );
    this.proc = await roomkit.serve(
      this.port,
      this.data_dir,
      this.migrations_dir,
      roomkit.hooks_dir(this.tmp),
    );
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    const proc = this.proc;
    this.proc = null;
    await roomkit.stop(proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

function db_hash(db_path: string): string {
  return createHash("sha256").update(fs.readFileSync(db_path)).digest("hex");
}

function checkpoint(db_path: string): void {
  // A mode=ro connection cannot recover a pending WAL — fold it into the main file
  // after every write phase so the audit reads settled bytes.
  const con = sqlite_connect(db_path, { timeout: 15 });
  con.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  con.close();
}

function run_audit_raw(db_path: string, ...extra: string[]) {
  const r = Bun.spawnSync([process.execPath, AUDIT_SCRIPT, db_path, ...extra]);
  return { returncode: r.exitCode, stdout: decode_text(r.stdout) };
}

/** [exit_code, parsed_json] of a --json run; the script must never mutate the db. */
function run_audit(db_path: string): [number, any] {
  const r = run_audit_raw(db_path, "--json");
  const body = r.returncode === 0 ? JSON.parse(r.stdout) : {};
  return [r.returncode, body];
}

function set_by_key(report: any, key: string): any {
  for (const s of report.collision_sets ?? []) {
    if (s.email_key === key) return s;
  }
  return null;
}

const sorted = (xs: string[]): string[] => [...xs].sort(by_code_point);

console.log("\n── (0) email_key unit checks — the policy itself ──");
const ek = audit_mod.email_key;
check("trim + lowercase, non-Gmail", ek("  Foo@Example.COM  "), "foo@example.com");
check("gmail dots removed", ek("h.enry@gmail.com"), "henry@gmail.com");
check("gmail +tag stripped", ek("henry+news@gmail.com"), "henry@gmail.com");
check("googlemail gets the same folding", ek("h.enry+x@googlemail.com"), "henry@googlemail.com");
check(
  "gmail.com and googlemail.com NOT merged",
  ek("a@gmail.com") === ek("a@googlemail.com"),
  false,
);
check("non-Gmail dots stay significant", ek("h.enry@fastmail.com"), "h.enry@fastmail.com");
check("non-Gmail +tag stays significant", ek("henry+x@fastmail.com"), "henry+x@fastmail.com");

const room = new Room(PORT);
try {
  await room.start();

  const [s, su_auth] = await api(
    room.base_url,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    { identity: SU_EMAIL, password: SU_PASSWORD },
  );
  check("superuser auth", s, 200);
  const su_token = su_auth.token;

  // Legacy emails are written AFTER shutdown; the API sees only unique placeholders,
  // so the create hook's duplicate guard never fires during seeding.
  const fixtures: Record<string, string> = {
    // set A: case-only pair at a non-Gmail domain (one padded — trim proof)
    a1: "  Foo@example.com",
    a2: "foo@example.com",
    // set B: gmail dot pair
    b1: "h.enry@gmail.com",
    b2: "henry@gmail.com",
    // set C: gmail +tag pair
    c1: "kata+board@gmail.com",
    c2: "kata@gmail.com",
    // D: policy boundary — must NOT collide
    d1: "a@gmail.com",
    d2: "a@googlemail.com",
    // E: non-Gmail dots — must NOT collide
    e1: "h.enry@fastmail.com",
    e2: "henry@fastmail.com",
    // set F: 'both' — a case-only pair plus a fold-needed third
    f1: "Both@gmail.com",
    f2: "both@gmail.com",
    f3: "b.oth@gmail.com",
    // set G: disposition — g2 gets stripped of all involvement, then re-involved
    g1: "Merge@example.com",
    g2: "merge@example.com",
  };
  const ids: Record<string, any> = {};
  for (const name of Object.keys(fixtures)) {
    const [s, body] = await api(
      room.base_url,
      "POST",
      "/api/collections/users/records",
      {
        email: `seed-${name}@seed.example`,
        password: "seed12345678",
        passwordConfirm: "seed12345678",
        name: `Seed ${name}`,
      },
      su_token,
    );
    if (s !== 200) check(`(fixture) user ${name} created`, s, 200);
    ids[name] = body.id;
  }
  check("(fixture) all users created", Object.values(ids).every(Boolean), true);

  // The audit runs OFFLINE against the db file — shut the room down first so the
  // sqlite writes below and the script's reads see settled state (no live WAL writer).
  await room.stop();
  const db_path = path.join(room.data_dir, "data.db");
  checkpoint(db_path);

  console.log("\n── (1) pristine db (unique emails everywhere) → no collisions, exit 0 ──");
  let [code, report] = run_audit(db_path);
  check("exit 0 on a collision-free db", code, 0);
  check("no collision sets reported", report.collision_sets ?? null, []);
  const human = run_audit_raw(db_path);
  check("human report says 'No collisions.'", human.stdout.includes("No collisions."), true);
  check(
    "header states the gmail/googlemail boundary",
    human.stdout.includes("gmail.com and googlemail.com are DISTINCT"),
    true,
  );
  check("header states the classification rule", human.stdout.includes("Classification:"), true);
  check(
    "header declares the counted columns",
    human.stdout.includes("Counted user-reference columns"),
    true,
  );

  console.log("\n── (2) legacy rows written straight into the column ──");
  let con = sqlite_connect(db_path, { timeout: 15 });
  for (const [name, legacy_email] of Object.entries(fixtures)) {
    con.query("UPDATE users SET email = ? WHERE id = ?").run(legacy_email, ids[name]);
  }
  // g2 loses every auto-provisioned reference (workspace, membership, settings, …) so
  // its involvement is 0; the strip walks the SAME derived column list the audit uses.
  const users_cid = con.query("SELECT id FROM _collections WHERE name = 'users'").values()[0]![0];
  const derived = audit_mod.user_relation_columns(
    path.join(REPO_ROOT, "schema"),
    users_cid as string,
  );
  for (const [table, col] of derived) {
    con.query(`DELETE FROM "${table}" WHERE "${col}" = ?`).run(ids.g2);
  }
  con.close();
  checkpoint(db_path);

  const before_hash = db_hash(db_path);
  [code, report] = run_audit(db_path);
  check("exit 0 with collisions present (audit, not gate)", code, 0);
  check("db file byte-identical after the audit (zero mutations)", db_hash(db_path), before_hash);
  check(
    "counted columns are derived, not hand-listed (workspace_members.user present)",
    (report.counted_columns ?? []).includes("workspace_members.user"),
    true,
  );
  check(
    "…and tasks.assignee present",
    (report.counted_columns ?? []).includes("tasks.assignee"),
    true,
  );

  console.log("\n── (3) detection + classification ──");
  const a = set_by_key(report, "foo@example.com");
  check("case-only pair detected", a !== null, true);
  check("…class case-only", a && a.classification, "case-only");
  check(
    "…padded stored email preserved verbatim",
    a && sorted(a.members.map((m: any) => m.email)),
    ["  Foo@example.com", "foo@example.com"],
  );
  check(
    "…members carry created + verified",
    a && a.members.every((m: any) => "created" in m && m.verified === false),
    true,
  );

  const b = set_by_key(report, "henry@gmail.com");
  check("gmail dot pair detected", b !== null, true);
  check("…class gmail-fold", b && b.classification, "gmail-fold");

  const c = set_by_key(report, "kata@gmail.com");
  check("gmail +tag pair detected", c !== null, true);
  check("…class gmail-fold", c && c.classification, "gmail-fold");

  const f = set_by_key(report, "both@gmail.com");
  check("'both' set of 3 detected", f && f.members.length, 3);
  check("…class both", f && f.classification, "both");

  console.log("\n── (4) policy boundaries — NOT collisions ──");
  const all_keys: string[] = report.collision_sets.map((s: any) => s.email_key);
  check(
    "a@gmail.com vs a@googlemail.com do NOT collide",
    all_keys.filter((k) => k === "a@gmail.com" || k === "a@googlemail.com"),
    [],
  );
  check(
    "non-Gmail dot pair (fastmail) does NOT collide",
    all_keys.filter((k) => k.includes("fastmail.com")),
    [],
  );

  console.log("\n── (5) involvement + suggested disposition ──");
  let g = set_by_key(report, "merge@example.com");
  check("disposition set detected", g !== null, true);
  const by_id = new Map<string, any>((g ? g.members : []).map((m: any) => [m.id, m]));
  const g1 = by_id.get(ids.g1) ?? {};
  let g2 = by_id.get(ids.g2) ?? {};
  check("g1 keeps auto-provisioned involvement (memberships ≥1)", (g1.memberships ?? 0) >= 1, true);
  check("g1 owns its auto-provisioned workspace", g1.owned_workspaces, 1);
  check("g2 stripped to zero involvement", g2.involvement, 0);
  check("one involved member → mergeable-duplicates", g && g.disposition, "mergeable-duplicates");
  check("set A (both members involved) → needs-ruling", a && a.disposition, "needs-ruling");

  console.log("\n── (6) a second involved member flips the suggestion ──");
  // A direct membership row for g2 in g1's workspace — the server is down, so the
  // insert goes straight into the table like any legacy artifact would.
  con = sqlite_connect(db_path, { timeout: 15 });
  const ws_id = con.query("SELECT id FROM workspaces WHERE owner = ?").values(ids.g1)[0]![0];
  const now = new Date().toISOString().slice(0, 19).replace("T", " ") + ".000Z";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const row_id = Array.from(
    { length: 15 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
  con
    .query(
      "INSERT INTO workspace_members (id, workspace, user, role, status, created, updated) " +
        "VALUES (?, ?, ?, 'member', 'active', ?, ?)",
    )
    .run(row_id, ws_id as string, ids.g2, now, now);
  con.close();
  checkpoint(db_path);
  let report2;
  [code, report2] = run_audit(db_path);
  check("re-audit exit 0", code, 0);
  g = set_by_key(report2, "merge@example.com");
  g2 = new Map<string, any>((g ? g.members : []).map((m: any) => [m.id, m])).get(ids.g2) ?? {};
  check("g2's membership is now counted", g2.memberships, 1);
  check("two involved members → needs-ruling", g && g.disposition, "needs-ruling");
} finally {
  await room.stop();
  room.cleanup_tmp();
}

console.log(`\n${"=".repeat(70)}`);
if (failures) {
  console.log(`❌ ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("✅ all checks passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * E2E test of the module-20 observability & performance work: the alert boot hook
 * (`pb_hooks/alerts.pb.js`) and the performance indexes shipped inline in each
 * collection's create migration. Fully self-contained clean-room server(s) — never
 * touches the repo's real pb_migrations, pb_hooks, or pb_data.
 *
 * Proves: ARMED room (ALERT_EMAIL + ALERT_SELFTEST set) sends a self-test email
 * through the same transport the real error alert uses; NO-OP room (ALERT_EMAIL
 * unset) leaves the sink empty; every shipped index is present via GET
 * /api/collections. Not provable here (needs prod + Railway's ALERT_EMAIL): the
 * alert reaching the owner's real inbox, live /api/logs, indexes on prod.
 *
 * Ports: 8095 (ARMED) then 8098 (NO-OP) then 8094 (ALERT-CRON) then 8099
 * (BOT-404-NOISE), all + PB_PORT_OFFSET, sequentially; SMTP sinks 2528/2529/2530/2531
 * (same offset).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as roomkit from "./roomkit.ts";
import {
  by_code_point,
  json_dumps,
  py_str,
  read_text,
  run_checked,
  splitlines,
  sqlite_connect,
} from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const POCKETBASE_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const ALERTS_HOOK_SRC = path.join(REPO_ROOT, "pb_hooks", "alerts.pb.js");
const SINK_SCRIPT = path.join(REPO_ROOT, "scripts", "smtp_sink.ts");
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds

const SU_EMAIL = process.env.PB_SUPERUSER_EMAIL ?? "obs-ci@example.test";
const SU_PASSWORD = process.env.PB_SUPERUSER_PASSWORD ?? "obs-ci-dummy-pw-000";
const DUMMY_ALERT_EMAIL = "m20-alert@example.test";

// Every performance index the migration ships, keyed by the collection it lives on.
const EXPECTED_INDEXES: Record<string, string[]> = {
  tasks: ["idx_tasks_project", "idx_tasks_assignee"],
  projects: ["idx_projects_workspace"],
  workspaces: ["idx_workspaces_owner"],
  decisions: ["idx_decisions_workspace"],
  milestones: ["idx_milestones_workspace"],
  comments: ["idx_comments_task"],
};

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  const mark = ok ? "✅" : "❌ MISMATCH";
  if (!ok) failures += 1;
  console.log(`  ${mark}  ${label.padEnd(56)} → ${py_str(got)} (expected ${py_str(expected)})`);
}

async function api(
  base_url: string,
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(base_url + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  if (r.ok) {
    if (r.status === 204) return [204, {}];
    return [r.status, JSON.parse(raw)];
  }
  try {
    return [r.status, JSON.parse(raw || "{}")];
  } catch {
    return [r.status, {}];
  }
}

async function superuser_token(base_url: string): Promise<any> {
  const [, r] = await api(
    base_url,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    null,
    {
      identity: SU_EMAIL,
      password: SU_PASSWORD,
    },
  );
  return r.token ?? null;
}

function count_eml(maildir: string): number {
  if (!fs.existsSync(maildir) || !fs.statSync(maildir).isDirectory()) return 0;
  return fs.readdirSync(maildir).filter((f) => f.endsWith(".eml")).length;
}

function read_all_eml(maildir: string): string {
  if (!fs.existsSync(maildir) || !fs.statSync(maildir).isDirectory()) return "";
  const out: string[] = [];
  for (const f of fs.readdirSync(maildir).sort(by_code_point)) {
    if (f.endsWith(".eml")) out.push(read_text(path.join(maildir, f)));
  }
  return out.join("\n");
}

function insert_logs(data_dir: string, rows: [number, string, string][]): void {
  const aux = path.join(data_dir, "auxiliary.db");
  const conn = sqlite_connect(aux, { timeout: 10 });
  try {
    conn.run("PRAGMA busy_timeout=5000");
    const now = new Date().toISOString().slice(0, 19).replace("T", " ") + ".000Z";
    const ins = conn.prepare(
      "INSERT INTO _logs (level, message, data, created) VALUES (?, ?, ?, ?)",
    );
    conn.transaction(() => {
      for (const [level, message, data] of rows) ins.run(level, message, data, now);
    })();
  } finally {
    conn.close();
  }
}

/**
 * Deterministically seed the alert scan's input by INSERTing rows straight into
 * the running room's `_logs` table (pb_data/auxiliary.db, WAL mode). PB batches its
 * own log writer asynchronously, so inducing real 5xx traffic can't prove a
 * threshold cross on a fixed tick; a direct write to the same table logQuery() reads
 * is synchronous and exact. `created` uses PB's own `%Y-%m-%d %H:%M:%f` shape at
 * UTC-now so it falls inside the trailing ALERT_WINDOW_MIN window; each row carries
 * BOTH a 5xx `data.status` and slog ERROR level (8) — either alone satisfies the
 * scan's `status>=500 OR level>=8`. The url keeps a query string to prove the alert
 * body strips it. Requires the server up (WAL lets an external writer commit rows
 * the server's reader then sees).
 */
function seed_error_logs(
  data_dir: string,
  count: number,
  status = 500,
  level = 8,
  url = "/api/x?token=secret",
): void {
  const rows: [number, string, string][] = [];
  for (let i = 0; i < count; i++) {
    rows.push([level, "obs-test induced error", json_dumps({ status, url })]);
  }
  insert_logs(data_dir, rows);
}

/**
 * Seed rows shaped like PB's OWN request logger (data.type == "request"), the
 * same shape a real 404 for an unmatched route produces — level is ALWAYS 8 (ERROR)
 * regardless of status, per PB's request-logging middleware. Proves the scan does
 * NOT alert on bot/scanner 404 noise (TASK-025).
 */
function seed_request_logs(
  data_dir: string,
  count: number,
  status = 404,
  url = "/bot-connect.js",
): void {
  const rows: [number, string, string][] = [];
  for (let i = 0; i < count; i++) {
    rows.push([
      8,
      "GET " + url,
      json_dumps({ type: "request", status, url, error: "File not found." }),
    ]);
  }
  insert_logs(data_dir, rows);
}

/** A local SMTP sink (scripts/smtp_sink.ts) capturing mail to a temp maildir. */
class Sink {
  port: number;
  maildir: string;
  proc: Bun.Subprocess;

  constructor(port: number) {
    this.port = port;
    this.maildir = fs.mkdtempSync(path.join(os.tmpdir(), `obs-sink-${port}-`));
    this.proc = Bun.spawn([process.execPath, SINK_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, SINK_PORT: String(port), MAIL_DIR: this.maildir },
      stdout: "ignore",
      stderr: "inherit",
    });
  }

  async ready(): Promise<void> {
    await Bun.sleep(500);
  }

  async stop(): Promise<void> {
    this.proc.kill("SIGTERM");
    const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
    await this.proc.exited;
    clearTimeout(timer);
    fs.rmSync(this.maildir, { recursive: true, force: true });
  }
}

/**
 * A self-contained `pocketbase serve` clean-room: fresh --dir, a COPY of
 * pb_migrations (MFA migration dropped so plain superuser auth works) with a scratch
 * SMTP->sink migration appended, and a temp --hooksDir holding only alerts.pb.js and the
 * lib/routes.js it requires (the registry registers nothing by itself).
 */
class Room {
  port: number;
  extra_env: Record<string, string>;
  base_url: string;
  tmp: string;
  data_dir: string;
  migrations_dir: string;
  hooks_dir: string;
  proc: roomkit.Room | null;

  constructor(port: number, sink_port: number, extra_env: Record<string, string> | null = null) {
    this.port = port;
    this.extra_env = extra_env ?? {};
    this.base_url = `http://127.0.0.1:${port}`;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-obs-test-${port}-`));
    this.data_dir = path.join(this.tmp, "pb_data");
    this.migrations_dir = path.join(this.tmp, "pb_migrations");
    this.hooks_dir = path.join(this.tmp, "pb_hooks");
    fs.mkdirSync(this.data_dir, { recursive: true });
    fs.cpSync(REAL_MIGRATIONS_DIR, this.migrations_dir, { recursive: true, dereference: true });
    for (const f of fs.readdirSync(this.migrations_dir)) {
      if (f.endsWith("superuser_mfa.js")) {
        // drop the superuser-MFA migration
        fs.rmSync(path.join(this.migrations_dir, f));
      }
    }
    // Scratch SMTP->sink migration (this test only; never in the repo). Timestamp
    // past the course band so it applies last and wins on smtp settings.
    const scratch = path.join(this.migrations_dir, "1785900000_scratch_smtp_sink.js");
    fs.writeFileSync(
      scratch,
      "migrate((app) => {\n" +
        "  const s = app.settings()\n" +
        "  s.smtp.enabled = true\n" +
        '  s.smtp.host = "127.0.0.1"\n' +
        `  s.smtp.port = ${sink_port}\n` +
        "  s.smtp.tls = false\n" +
        '  s.smtp.username = ""\n' +
        '  s.smtp.password = ""\n' +
        "  app.save(s)\n" +
        "}, (app) => {})\n",
    );
    fs.mkdirSync(this.hooks_dir, { recursive: true });
    fs.copyFileSync(ALERTS_HOOK_SRC, path.join(this.hooks_dir, "alerts.pb.js"));
    fs.mkdirSync(path.join(this.hooks_dir, "lib"));
    fs.copyFileSync(
      path.join(REPO_ROOT, "pb_hooks", "lib", "routes.js"),
      path.join(this.hooks_dir, "lib", "routes.js"),
    );
    this.proc = null;
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
    // roomkit.serve() has no env param; the alerts hook reads env vars, so they ride
    // process.env for the spawn it makes (inherited by default) and are restored after.
    const saved = Object.keys(this.extra_env).map((k) => [k, process.env[k]] as const);
    Object.assign(process.env, this.extra_env);
    try {
      this.proc = await roomkit.serve(
        this.port,
        this.data_dir,
        this.migrations_dir,
        this.hooks_dir,
      );
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.proc === null) return;
    await roomkit.stop(this.proc);
  }

  cleanup_tmp(): void {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

function clear_alert_env(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("ALERT_")) delete process.env[k];
  }
}

// ── Room 1: ARMED (ALERT_EMAIL + ALERT_SELFTEST) — the transport reaches ALERT_EMAIL ─
// COVERS: middleware:alerts.pb.js
console.log(
  "\n── ARMED room (ALERT_EMAIL + ALERT_SELFTEST): alert transport reaches the address ──",
);
const armed_sink = new Sink(2528 + PORT_OFFSET);
await armed_sink.ready();
const armed_room = new Room(8095 + PORT_OFFSET, 2528 + PORT_OFFSET, {
  ALERT_EMAIL: DUMMY_ALERT_EMAIL,
  ALERT_SELFTEST: "1",
});
try {
  await armed_room.start();
  // Self-test email fires on the FIRST request after boot (onBootstrap is too
  // early — SMTP settings aren't live yet); drive a request, then poll the sink.
  await api(armed_room.base_url, "GET", "/api/health");
  let captured = "";
  for (let i = 0; i < 40; i++) {
    if (count_eml(armed_sink.maildir) >= 1) {
      captured = read_all_eml(armed_sink.maildir);
      break;
    }
    await api(armed_room.base_url, "GET", "/api/health"); // re-trigger while polling
    await Bun.sleep(250);
  }
  check("armed room captured exactly one self-test email", count_eml(armed_sink.maildir), 1);
  check("self-test email addressed to ALERT_EMAIL", captured.includes(DUMMY_ALERT_EMAIL), true);
  check(
    "self-test email carries the 'alerts armed' subject",
    captured.includes("alerts armed"),
    true,
  );

  // Index presence (V-INDEX presence half): every shipped index is on its collection.
  const tok = await superuser_token(armed_room.base_url);
  const [status, page] = await api(armed_room.base_url, "GET", "/api/collections?perPage=200", tok);
  check("GET /api/collections", status, 200);
  const by_name = new Map<any, any>((page.items ?? []).map((c: any) => [c.name ?? null, c]));
  for (const [coll_name, idx_names] of Object.entries(EXPECTED_INDEXES)) {
    const coll = by_name.get(coll_name) ?? {};
    const idx_blob = (coll.indexes ?? []).join(" ");
    for (const idx of idx_names) {
      check(`index ${idx} present on ${coll_name}`, idx_blob.includes(idx), true);
    }
  }
} finally {
  await armed_room.stop();
  armed_room.cleanup_tmp();
  await armed_sink.stop();
}

// ── Room 2: NO-OP (ALERT_EMAIL UNSET, ALERT_SELFTEST still set) — sink stays empty ──
// COVERS: middleware:alerts.pb.js
console.log("\n── NO-OP room (ALERT_EMAIL unset): the hook no-ops — no arming, no mail ──");
clear_alert_env();
const noop_sink = new Sink(2529 + PORT_OFFSET);
await noop_sink.ready();
const noop_room = new Room(8098 + PORT_OFFSET, 2529 + PORT_OFFSET, { ALERT_SELFTEST: "1" }); // armed flag set, but no ALERT_EMAIL
try {
  await noop_room.start();
  // Middleware runs every request but must short-circuit (ALERT_EMAIL unset).
  for (let i = 0; i < 8; i++) {
    await api(noop_room.base_url, "GET", "/api/health");
    await Bun.sleep(250);
  }
  let still_healthy: any;
  try {
    await roomkit.wait_for_health(noop_room.base_url, noop_room.proc!);
    still_healthy = true;
  } catch (e) {
    if (!(e instanceof roomkit.RoomNotHealthy)) throw e;
    still_healthy = e.message;
  }
  check("no-op room server healthy", still_healthy, true);
  check("no-op room sink captured NO mail", count_eml(noop_sink.maildir), 0);
} finally {
  await noop_room.stop();
  noop_room.cleanup_tmp();
  await noop_sink.stop();
}

// ── Room 3: ALERT-CRON (ALERT_EMAIL set, ALERT_SELFTEST unset) — the onBootstrap ──
// cron registers, and a threshold-crossing _logs scan emails the owner. A dedicated
// room (no ALERT_SELFTEST) so the sink holds ONLY the alert email, never a self-test.
// COVERS: boot:alerts.pb.js, cron:alerts-error-rate
console.log("\n── ALERT-CRON room: alerts-error-rate registers + a threshold cross emails ──");
clear_alert_env();
const alert_sink = new Sink(2530 + PORT_OFFSET);
await alert_sink.ready();
// THRESHOLD 5 (default): the scan fires only when the window count EXCEEDS it, so 8
// rows cross and a 5-row control below stays silent. Window 5m so UTC-now rows match.
const alert_room = new Room(8094 + PORT_OFFSET, 2530 + PORT_OFFSET, {
  ALERT_EMAIL: DUMMY_ALERT_EMAIL,
  ALERT_THRESHOLD: "5",
  ALERT_WINDOW_MIN: "5",
});
try {
  await alert_room.start();
  const tok = await superuser_token(alert_room.base_url);

  // (a) onBootstrap registered the cron under its exact id.
  let [status, crons] = await api(alert_room.base_url, "GET", "/api/crons", tok);
  check("GET /api/crons → 200", status, 200);
  const cron_ids = Array.isArray(crons) ? crons.map((c: any) => c.id ?? null) : [];
  check(
    "alerts-error-rate registered by onBootstrap",
    cron_ids.includes("alerts-error-rate"),
    true,
  );

  // (b) Below-threshold control: exactly THRESHOLD rows must NOT fire (scan uses
  // total > threshold), proving the email in (c) is the threshold cross, not noise.
  seed_error_logs(alert_room.data_dir, 5);
  [status] = await api(alert_room.base_url, "POST", "/api/crons/alerts-error-rate", tok);
  check("POST /api/crons/alerts-error-rate (at threshold) → 204", status, 204);
  await Bun.sleep(2000); // sink writes async relative to the cron POST
  check("at-threshold count sends NO alert", count_eml(alert_sink.maildir), 0);

  // (c) Threshold cross: 3 more rows (8 total > 5) fire exactly one alert email.
  seed_error_logs(alert_room.data_dir, 3);
  [status] = await api(alert_room.base_url, "POST", "/api/crons/alerts-error-rate", tok);
  check("POST /api/crons/alerts-error-rate (over threshold) → 204", status, 204);
  let captured = "";
  for (let i = 0; i < 20; i++) {
    if (count_eml(alert_sink.maildir) >= 1) {
      captured = read_all_eml(alert_sink.maildir);
      break;
    }
    await Bun.sleep(250);
  }
  check("threshold cross emits exactly one alert email", count_eml(alert_sink.maildir), 1);
  check("alert addressed to ALERT_EMAIL", captured.includes(DUMMY_ALERT_EMAIL), true);
  check("alert subject reports 8 errors", captured.includes("8 server errors"), true);
  check("alert body names the trailing 5m window", captured.includes("last 5 minutes"), true);
  check(
    "alert body strips the query string from sample paths",
    !captured.includes("token=secret"),
    true,
  );
  check("alert body keeps the bare sample path", captured.includes("/api/x"), true);
} finally {
  await alert_room.stop();
  alert_room.cleanup_tmp();
  await alert_sink.stop();
}

// ── Room 4: BOT-404-NOISE room — bare scanner 404s never page; real 5xx still does ──
// COVERS: cron:alerts-error-rate
console.log("\n── BOT-404-NOISE room: scanner 404 burst stays silent, real 5xx still pages ──");
clear_alert_env();
const bot_sink = new Sink(2531 + PORT_OFFSET);
await bot_sink.ready();
const bot_room = new Room(8099 + PORT_OFFSET, 2531 + PORT_OFFSET, {
  ALERT_EMAIL: DUMMY_ALERT_EMAIL,
  ALERT_THRESHOLD: "5",
  ALERT_WINDOW_MIN: "5",
});
try {
  await bot_room.start();
  const tok = await superuser_token(bot_room.base_url);

  // (a) A well-over-threshold burst of PB-shaped 404 request logs (bot/scanner
  // noise) must NOT page — this is the exact shape a live 404 produces (level=8,
  // data.type="request", data.status=404), proven live against a running server.
  seed_request_logs(bot_room.data_dir, 13, 404, "/bot-connect.js");
  let [status] = await api(bot_room.base_url, "POST", "/api/crons/alerts-error-rate", tok);
  check("POST /api/crons/alerts-error-rate (13 bot 404s) → 204", status, 204);
  await Bun.sleep(2000);
  check("bot-404 burst sends NO alert", count_eml(bot_sink.maildir), 0);

  // (b) Regression check: real 5xx / app-logged errors still cross the threshold
  // and page, even with the bot noise from (a) still sitting in the same window.
  seed_error_logs(bot_room.data_dir, 8, 500);
  [status] = await api(bot_room.base_url, "POST", "/api/crons/alerts-error-rate", tok);
  check("POST /api/crons/alerts-error-rate (8 real 5xx) → 204", status, 204);
  let captured = "";
  for (let i = 0; i < 20; i++) {
    if (count_eml(bot_sink.maildir) >= 1) {
      captured = read_all_eml(bot_sink.maildir);
      break;
    }
    await Bun.sleep(250);
  }
  check("real 5xx burst still emits exactly one alert email", count_eml(bot_sink.maildir), 1);
  check("real-5xx alert addressed to ALERT_EMAIL", captured.includes(DUMMY_ALERT_EMAIL), true);
} finally {
  await bot_room.stop();
  bot_room.cleanup_tmp();
  await bot_sink.stop();
}

// ── Repo-level guard: the real pb_migrations/ must stay git-clean ──────────────
console.log("\n── real pb_migrations/ untouched by either clean-room ──");
const git_status: string =
  run_checked(["git", "status", "--porcelain", "pb_migrations/"], {
    cwd: REPO_ROOT,
    capture_output: true,
    text: true,
  }).stdout ?? "";
const bad_lines = splitlines(git_status).filter(
  (line) => line.includes("_updated_") && !line.slice(0, 2).includes("D"),
);
check("no auto-written *_updated_*.js migration in real pb_migrations/", bad_lines, []);
console.log(`      git status --porcelain pb_migrations/ :\n${git_status || "      (clean)"}`);

console.log(`\n${"=".repeat(70)}`);
if (failures) {
  console.log(`❌ ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("✅ all checks passed");
  process.exit(0);
}

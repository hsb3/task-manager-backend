#!/usr/bin/env bun
/**
 * The account app's flow module (web/account/src/lib/account.ts) against a room: signup, the mailed set-password link, sign-in refusals, approval, name, keys and sign-out.
 *
 * Port 8226 + PB_PORT_OFFSET; SMTP sink on 2536 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { py_repr, read_text, run_checked, splitlines, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const SMTP_SINK = path.join(REPO_ROOT, "scripts", "smtp_sink.ts");
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8226 + PORT_OFFSET;
const SINK_PORT = 2536 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PUBLIC = BASE_URL; // roomkit.serve sets PB_PUBLIC_URL to the room's own URL
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASS = "flow-pass-123456";

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; fields: Record<string, string>; status: number };
type KeyItem = {
  id: string;
  name: string;
  scope: string;
  client_id: string;
  manage_keys: boolean;
  created: string;
  expires: string;
  last_used: string;
  revoked: boolean;
  current: boolean;
  reach: string;
  workspace: string;
  projects: string[];
};
type NewKey = {
  name: string;
  scope: string;
  reach: string;
  workspace?: string;
  projects?: string[];
  expires?: string;
};
type PendingUser = {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  approved: boolean;
  created: string;
};
type Workspace = { id: string; name: string; role: string; status: string };
type ProjectRef = { id: string; name: string };
type Client = { authStore: { isValid: boolean } };

interface AcctApi {
  client(url: string, store?: unknown): Client;
  BaseAuthStore: new () => unknown;
  MESSAGES: Record<string, string>;
  signUp(pb: Client, email: string, name: string): Promise<Result<null>>;
  setPassword(
    pb: Client,
    token: string,
    password: string,
    passwordConfirm: string,
  ): Promise<Result<null>>;
  signIn(pb: Client, email: string, password: string): Promise<Result<null>>;
  isAppAdmin(pb: Client): Promise<boolean>;
  pendingUsers(pb: Client): Promise<Result<PendingUser[]>>;
  pendingStatus(user: Pick<PendingUser, "verified" | "approved">): string;
  approveUser(pb: Client, id: string): Promise<Result<null>>;
  saveName(pb: Client, name: string): Promise<Result<null>>;
  createKey(pb: Client, input: NewKey): Promise<Result<{ item: KeyItem; secret: string }>>;
  listKeys(pb: Client): Promise<Result<KeyItem[]>>;
  keyStatus(item: Pick<KeyItem, "revoked" | "expires">, now: Date): string;
  myWorkspaces(pb: Client): Promise<Result<Workspace[]>>;
  projectsOf(pb: Client, workspaceId: string): Promise<Result<ProjectRef[]>>;
  revokeKey(pb: Client, id: string): Promise<Result<KeyItem>>;
  sendPasswordLink(pb: Client, email: string): Promise<Result<null>>;
  confirmEmail(pb: Client, token: string): Promise<Result<null>>;
  linkedProviders(pb: Client): Promise<string[]>;
  authProviders(pb: Client): Promise<{ name: string; displayName: string }[]>;
  refreshSession(pb: Client): Promise<boolean>;
  signOut(pb: Client): void;
}

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(78)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
  );
}

async function api(
  method: string,
  p: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  try {
    r = await fetch(BASE_URL + p, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  const raw = await r.text();
  try {
    return [r.status, raw ? JSON.parse(raw) : {}];
  } catch {
    return [r.status, { _raw: raw }];
  }
}

function connect_ok(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.setTimeout(500);
    sock.once("connect", () => {
      sock.end();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
}

async function start_sink(mail_dir: string): Promise<Bun.Subprocess> {
  fs.mkdirSync(mail_dir, { recursive: true });
  const proc = Bun.spawn([process.execPath, SMTP_SINK], {
    env: { ...process.env, SINK_PORT: String(SINK_PORT), MAIL_DIR: mail_dir },
    stdout: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await connect_ok(SINK_PORT))) await Bun.sleep(200);
  return proc;
}

async function stop_sink(proc: Bun.Subprocess | null): Promise<void> {
  if (proc === null) return;
  proc.kill();
  if ((await Promise.race([proc.exited, Bun.sleep(10000).then(() => null)])) === null) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  if (!(await roomkit.wait_for_port_free(SINK_PORT))) {
    console.log(`  ⚠️  sink port ${SINK_PORT} still occupied after stopping`);
  }
}

// Captured messages addressed to `addr` (soft line breaks unfolded so a QP-wrapped link matches).
function mails_to(mail_dir: string, addr: string): string[] {
  if (!fs.existsSync(mail_dir)) return [];
  return fs
    .readdirSync(mail_dir)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => read_text(path.join(mail_dir, f)))
    .filter((c) => splitlines(c).some((ln) => /^To:/i.test(ln) && ln.toLowerCase().includes(addr)))
    .map((c) => c.replace(/=\r?\n/g, "").replace(/=3D/g, "="));
}

const eml_count = (mail_dir: string): number =>
  fs.existsSync(mail_dir) ? fs.readdirSync(mail_dir).filter((f) => f.endsWith(".eml")).length : 0;

async function wait_for_count(mail_dir: string, addr: string, n: number): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && mails_to(mail_dir, addr).length < n) await Bun.sleep(200);
  await Bun.sleep(500); // settle: a duplicate send would land right behind the first
  return mails_to(mail_dir, addr);
}

const subject_of = (mail: string | undefined): string =>
  (mail?.match(/^Subject: (.*)$/m) || [])[1]?.trim() ?? "";
const reset_token = (mail: string | undefined): string =>
  (mail?.match(/password-reset-confirm\?token=([A-Za-z0-9._-]+)/) || [])[1] ?? "";

// Install the app package so the flow module's `pocketbase` import resolves; its output names a registry failure.
const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
  cwd: path.join(REPO_ROOT, "web", "account"),
  stdout: "pipe",
  stderr: "pipe",
});
const install_out = await new Response(install.stdout).text();
const install_err = await new Response(install.stderr).text();
if ((await install.exited) !== 0) {
  console.log(
    `❌ bun install --frozen-lockfile in web/account failed:\n${install_out}\n${install_err}`,
  );
  process.exit(1);
}

const spec = "../web/account/src/lib/account.ts";
const acct = (await import(spec)) as AcctApi;

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-account-flows-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
const MAIL_DIR = path.join(S, "mail");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(path.join(REPO_ROOT, "pb_migrations"), MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
let sink: Bun.Subprocess | null = null;
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
  process.env.APP_ADMIN_EMAILS = "flow-admin@example.com";
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  sink = await start_sink(MAIL_DIR);
  const [, auth] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = auth.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(auth)}`);
  const [ss] = await api("PATCH", "/api/settings", su, {
    smtp: { enabled: true, host: "127.0.0.1", port: SINK_PORT, tls: false },
    meta: { senderName: "Task Tracker", senderAddress: "verify@example.com" },
  });
  if (ss !== 200) throw new roomkit.SystemExit(`smtp settings → ${ss}`);

  const user_by_email = async (email: string): Promise<any> => {
    const [, r] = await api(
      "GET",
      `/api/collections/users/records?${urlencode({ filter: `email='${email}'` })}`,
      su,
    );
    return r.items?.[0] ?? null;
  };
  for (const email of [
    "flow-admin@example.com",
    "flow-user@example.com",
    "flow-other@example.com",
  ]) {
    const [s, r] = await api("POST", "/api/collections/users/records", su, {
      email,
      password: PASS,
      passwordConfirm: PASS,
      name: email.split("@")[0],
      verified: true,
      approved: true,
    });
    if (s !== 200) throw new roomkit.SystemExit(`fixture ${email} → ${s} ${py_repr(r)}`);
  }
  const fresh = () => acct.client(BASE_URL, new acct.BaseAuthStore());
  const anon = fresh();
  const admin = fresh();
  const user = fresh();
  const other = fresh();
  check(
    "(fixture) admin signs in",
    (await acct.signIn(admin, "flow-admin@example.com", PASS)).ok,
    true,
  );
  check(
    "(fixture) user signs in",
    (await acct.signIn(user, "flow-user@example.com", PASS)).ok,
    true,
  );
  check(
    "(fixture) other signs in",
    (await acct.signIn(other, "flow-other@example.com", PASS)).ok,
    true,
  );
  const other_key = await acct.createKey(other, { name: "other", scope: "read", reach: "all" });
  if (!other_key.ok) throw new roomkit.SystemExit(`other's key: ${py_repr(other_key)}`);

  console.log("\n── signup and the set-password link ──");
  const NEW = "flow-new@example.com";
  let r: Result<any> = await acct.signUp(anon, NEW, "Flow New");
  check("1 signUp → ok", r.ok, true);
  const created = await user_by_email(NEW);
  check(
    "1 the account is unverified and unapproved",
    [created?.verified, created?.approved],
    [false, false],
  );
  const welcome = await wait_for_count(MAIL_DIR, NEW, 1);
  check("1 exactly one new mail", welcome.length, 1);
  check("1 its subject", subject_of(welcome[0]), "Finish creating your Task Tracker account");
  check(
    "1 it links to the account app's set-password screen",
    (welcome[0] ?? "").includes(`${PUBLIC}/account/#/auth/password-reset-confirm?token=`),
    true,
  );
  const token = reset_token(welcome[0]);
  check("1 its token is extracted", token !== "", true);

  r = await acct.signUp(anon, NEW, "Again");
  check("2 a second signUp → refused", r.ok, false);
  check("2 its message", !r.ok && r.message, "An account with this email address already exists.");

  r = await acct.setPassword(anon, token, "flow-new-123456", "flow-new-123456");
  check("3 setPassword → ok", r.ok, true);
  check("3 the account reads verified", (await user_by_email(NEW))?.verified, true);

  r = await acct.setPassword(anon, token, "flow-new-123456", "flow-new-123456");
  check("4 the used link → refused", r.ok, false);
  check("4 message linkInvalid", !r.ok && r.message, "This link is invalid or has expired.");
  check("4 fields carry no token key", !r.ok && "token" in r.fields, false);

  r = await acct.setPassword(anon, "bad", "short", "other");
  check("5 a short password → refused", r.ok, false);
  check("5 fields.password", !r.ok && r.fields.password, "The length must be between 8 and 255.");

  console.log("\n── sign-in refusals and approval ──");
  const newClient = fresh();
  r = await acct.signIn(newClient, NEW, "flow-new-123456");
  check("6 an unapproved account → notReady", !r.ok && r.message, acct.MESSAGES.notReady);
  check("6 no session is held", newClient.authStore.isValid, false);
  r = await acct.signIn(newClient, NEW, "wrong-password");
  check("7 a wrong password → named", !r.ok && r.message, "Wrong email or password.");

  check("8 isAppAdmin(admin)", await acct.isAppAdmin(admin), true);
  check("8 isAppAdmin(user)", await acct.isAppAdmin(user), false);

  let pending = await acct.pendingUsers(admin);
  const row = pending.ok ? pending.value.find((u) => u.email === NEW) : undefined;
  check("9 pendingUsers(admin) lists the new account", row !== undefined, true);
  check("9 its status", row && acct.pendingStatus(row), "Waiting for approval");
  pending = await acct.pendingUsers(user);
  check(
    "9 pendingUsers(user) → notAdmin",
    !pending.ok && pending.message,
    "This page is for app administrators.",
  );

  r = await acct.approveUser(admin, created.id);
  check("10 approveUser → ok", r.ok, true);
  pending = await acct.pendingUsers(admin);
  check(
    "10 the account left the list",
    pending.ok && pending.value.some((u) => u.email === NEW),
    false,
  );
  r = await acct.signIn(newClient, NEW, "flow-new-123456");
  check("10 the approved account signs in", r.ok, true);
  check("10 a session is held", newClient.authStore.isValid, true);

  r = await acct.approveUser(admin, "zzzzzzzzzzzzzzz");
  check(
    "11 approving a missing account → accountGone",
    !r.ok && r.message,
    "That account no longer exists.",
  );

  console.log("\n── name ──");
  r = await acct.saveName(user, "  Renamed Flow  ");
  check("12 saveName → ok", r.ok, true);
  check(
    "12 the name is stored trimmed",
    (await user_by_email("flow-user@example.com"))?.name,
    "Renamed Flow",
  );
  r = await acct.saveName(user, "   ");
  check("12 a blank name → fields.name", !r.ok && r.fields.name, "Cannot be blank.");

  console.log("\n── keys ──");
  const k13 = await acct.createKey(user, { name: "flow key", scope: "read", reach: "all" });
  check("13 createKey → ok", k13.ok, true);
  const secret = k13.ok ? k13.value.secret : "";
  const k13id = k13.ok ? k13.value.item.id : "";
  check("13 the secret's shape", /^tmk_[A-Za-z0-9]{40}$/.test(secret), true);
  const listed = await acct.listKeys(user);
  const item = listed.ok ? listed.value.find((k) => k.id === k13id) : undefined;
  check("13 listKeys holds it with read / all", item && [item.scope, item.reach], ["read", "all"]);
  check(
    "13 no listed item carries a key",
    listed.ok && listed.value.some((k) => "key" in k),
    false,
  );
  check("13 its status", item && acct.keyStatus(item, new Date()), "Active");

  let k: Result<{ item: KeyItem; secret: string }> = await acct.createKey(user, {
    name: "ws",
    scope: "read",
    reach: "workspace",
  });
  check(
    "14 a workspace reach without a workspace → fields.workspace",
    !k.ok && k.fields.workspace,
    "Choose the workspace this key is limited to.",
  );

  const ws = await acct.myWorkspaces(user);
  check("15 myWorkspaces → one workspace", ws.ok && ws.value.length, 1);
  const wsId = ws.ok ? ws.value[0]!.id : "";
  k = await acct.createKey(user, {
    name: "ws",
    scope: "write",
    reach: "workspace",
    workspace: wsId,
  });
  check("15 a workspace-reach key → ok, reach workspace", k.ok && k.value.item.reach, "workspace");

  const projects = await acct.projectsOf(user, wsId);
  check("16 projectsOf → at least one project", projects.ok && projects.value.length >= 1, true);
  const p0 = projects.ok ? projects.value[0]!.id : "";
  k = await acct.createKey(user, {
    name: "pr",
    scope: "read",
    reach: "projects",
    workspace: wsId,
    projects: [p0],
  });
  check("16 a projects-reach key → ok, those projects", k.ok && k.value.item.projects, [p0]);

  k = await acct.createKey(user, {
    name: "exp",
    scope: "read",
    reach: "all",
    expires: "2099-01-01 00:00:00.000Z",
  });
  check(
    "17 an expiring key keeps its expiry",
    k.ok && k.value.item.expires,
    "2099-01-01 00:00:00.000Z",
  );

  const rv = await acct.revokeKey(user, k13id);
  check("18 revokeKey → ok, revoked", rv.ok && rv.value.revoked, true);
  const [ms] = await api("GET", "/api/tracker/me", secret);
  check("18 the revoked secret → 401", ms, 401);

  const rvo = await acct.revokeKey(user, other_key.value.item.id);
  check(
    "19 revoking another's key → named",
    !rvo.ok && rvo.message,
    "No key with that id among yours.",
  );

  console.log("\n── reset link, confirm, providers ──");
  const before = eml_count(MAIL_DIR);
  r = await acct.sendPasswordLink(anon, "nobody@example.com");
  check("20 a link for an unknown address → ok", r.ok, true);
  await Bun.sleep(2000);
  check("20 and no mail is sent", eml_count(MAIL_DIR), before);
  r = await acct.sendPasswordLink(anon, "flow-user@example.com");
  check("20 a link for a known address → ok", r.ok, true);
  const reset = await wait_for_count(MAIL_DIR, "flow-user@example.com", 1);
  check("20 one new mail", reset.length, 1);
  check("20 its subject", subject_of(reset[0]), "Reset your Task Tracker password");
  check(
    "20 it links to the account app's set-password screen",
    (reset[0] ?? "").includes(`${PUBLIC}/account/#/auth/password-reset-confirm?token=`),
    true,
  );

  r = await acct.confirmEmail(anon, "bad");
  check(
    "21 a bad confirm token → linkInvalid",
    !r.ok && r.message,
    "This link is invalid or has expired.",
  );

  check("22 linkedProviders(user)", await acct.linkedProviders(user), []);
  check("22 authProviders(anon) with no provider pair set", await acct.authProviders(anon), []);

  console.log("\n── session ──");
  check("23 refreshSession(user)", await acct.refreshSession(user), true);
  const flowUser = await user_by_email("flow-user@example.com");
  const [us] = await api("PATCH", `/api/collections/users/records/${flowUser.id}`, su, {
    approved: false,
  });
  check("(fixture) superuser unapproves flow-user", us, 200);
  check("23 refreshSession after unapproval", await acct.refreshSession(user), false);
  check("23 the session is cleared", user.authStore.isValid, false);

  acct.signOut(admin);
  check("24 signOut clears the session", admin.authStore.isValid, false);
} finally {
  await stop_sink(sink);
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all account flow proofs passed");
  process.exit(0);
}

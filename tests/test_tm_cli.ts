#!/usr/bin/env bun
/**
 * tm CLI (clients/tm): login stores the key (and never echoes it at a terminal), every verb answers
 * --json, create/show round-trip, search rows carry kind, list pages, --set is typed by the schema,
 * usage is checked before config, a read key's write exits 1 naming api_key_scope
 * (decision:api-keys).
 *
 * Fully self-contained clean-room server; runs the CLI as a subprocess. Port 8193 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const TM = path.join(REPO_ROOT, "clients", "tm", "tm.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8193 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tm-cli-test-"));
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

/** Run the CLI as a user would: env for the key and URL, XDG config dir in scratch. */
async function tm(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<Run> {
  const { TM_API_KEY, TM_URL, ...clean } = process.env;
  const proc = Bun.spawn([process.execPath, TM, ...args], {
    cwd: S, // never the repo: a CLI must not depend on where it is run from
    env: { ...clean, HOME: S, XDG_CONFIG_HOME: XDG, ...env },
    stdin: stdin === undefined ? "ignore" : new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000); // a hang (e.g. waiting on stdin) is a failure
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

// `tm` under a pseudo-terminal via script(1) (BSD on macOS, util-linux on linux); it refuses a socket stdin (Bun's pipes are sockets), so `cat |` hands it a real pipe.
async function tm_pty(
  tm_path: string,
  args: string[],
  env: Record<string, string>,
  input: string,
): Promise<{ code: number; out: string }> {
  const { TM_API_KEY, TM_URL, ...clean } = process.env;
  const argv = [process.execPath, tm_path, ...args];
  const sh_quote = (a: string): string => `'${a.replaceAll("'", `'\\''`)}'`;
  const proc = Bun.spawn(
    process.platform === "linux"
      ? ["sh", "-c", 'cat | script -q -c "$1" /dev/null', "sh", argv.map(sh_quote).join(" ")]
      : ["sh", "-c", 'cat | script -q /dev/null "$@"', "sh", ...argv],
    { cwd: S, env: { ...clean, HOME: S, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => {
    Bun.spawnSync(["pkill", "-P", String(proc.pid)]); // sh's children: cat and script
    proc.kill();
  }, 15_000);
  const err = new Response(proc.stderr).text();
  const dec = new TextDecoder();
  let out = "";
  let typed = false;
  for await (const chunk of proc.stdout) {
    out += dec.decode(chunk);
    if (!typed && out.includes("Paste your API key")) {
      proc.stdin.write(input);
      proc.stdin.end();
      typed = true;
    }
  }
  if (!typed) proc.stdin.end();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: out + (await err) };
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

  console.log(
    "\n── fixtures: Alice, her provisioned workspace and project, a write key and a read key ──",
  );
  let [s, r] = await api("POST", "/api/collections/users/records", su, {
    email: "alice@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Alice",
    verified: true,
    approved: true,
  });
  check("fixture Alice created", s, 200);
  [s, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "alice@example.com",
    password: "test123456",
  });
  check("Alice signs in", s, 200);
  const alice: string = r.token;
  [, r] = await api(
    "GET",
    `/api/collections/projects/records?${urlencode({ filter: "name != ''", perPage: 5 })}`,
    alice,
  );
  const project = r.items?.find((p: any) => p.name) ?? null;
  check("Alice has a provisioned project", Boolean(project?.id && project?.workspace), true);
  const PROJECT: string = project.id;
  const WS: string = project.workspace;
  [s, r] = await api("POST", "/api/collections/api_keys/records", alice, {
    name: "cli write",
    scope: "write",
  });
  check("write key minted", tup(s, /^tmk_/.test(r.key ?? "")), tup(200, true));
  const WRITE_KEY: string = r.key;
  [s, r] = await api("POST", "/api/collections/api_keys/records", alice, {
    name: "cli read",
    scope: "read",
  });
  check("read key minted", tup(s, /^tmk_/.test(r.key ?? "")), tup(200, true));
  const READ_KEY: string = r.key;
  const W = { TM_URL: BASE_URL, TM_API_KEY: WRITE_KEY };
  const R = { TM_URL: BASE_URL, TM_API_KEY: READ_KEY };

  console.log("\n── tm login: stores the pasted key, prints where, never echoes it ──");
  let o = await tm(["login", "--url", BASE_URL], {}, `${WRITE_KEY}\n`);
  const cfg = path.join(XDG, "tm", "config.json");
  check("login exits 0", tup(o.code, o.stderr), tup(0, ""));
  check("login names the config file it wrote", o.stdout.includes(cfg), true);
  check("login does not echo the key", (o.stdout + o.stderr).includes(WRITE_KEY), false);
  const saved = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, "utf8")) : {};
  check(
    "config file holds the url and the key",
    tup(saved.url ?? null, saved.key === WRITE_KEY),
    tup(BASE_URL, true),
  );
  check(
    "config file is private to the user",
    fs.existsSync(cfg) ? (fs.statSync(cfg).mode & 0o777).toString(8) : null,
    "600",
  );
  o = await tm(["login"], {}, WRITE_KEY);
  check(
    "login again, piped without a trailing newline, keeps the saved url",
    tup(o.code, o.stdout.includes(cfg)),
    tup(0, true),
  );
  o = await tm(["login"], {}, "");
  check("login with empty input → exit 2", tup(o.code, o.stderr.includes("no key")), tup(2, true));
  o = await tm(["list", "--json"]);
  check(
    "list --json from the stored config alone → exit 0, a JSON array",
    tup(o.code, Array.isArray(o.json)),
    tup(0, true),
  );

  console.log("\n── create → show round-trip, then edit, comment, search, list ──");
  o = await tm(["create", "zephyr quiet task", "--project", PROJECT, "--json"], W);
  check("create --json exits 0", tup(o.code, o.stderr), tup(0, ""));
  const ID: string = o.json?.id ?? "";
  check(
    "create --json returns id, kind, title, project, workspace",
    tup(Boolean(ID), o.json?.kind, o.json?.title, o.json?.project, o.json?.workspace),
    tup(true, "task", "zephyr quiet task", PROJECT, WS),
  );
  o = await tm(["show", ID, "--json"], W);
  check(
    "show --json round-trips the created task",
    tup(o.code, o.json?.id, o.json?.kind, o.json?.title),
    tup(0, ID, "task", "zephyr quiet task"),
  );
  check(
    "show --json carries the server key",
    typeof o.json?.key === "string" && o.json.key.length > 0,
    true,
  );
  o = await tm(["show", ID], W);
  check(
    "show (human) exits 0 and names the title",
    tup(o.code, o.stdout.includes("zephyr quiet task")),
    tup(0, true),
  );

  o = await tm(
    ["edit", ID, "--title", "zephyr loud task", "--set", "description=now described", "--json"],
    W,
  );
  check(
    "edit --json exits 0 with the new title",
    tup(o.code, o.json?.title, o.json?.description),
    tup(0, "zephyr loud task", "now described"),
  );
  o = await tm(["show", ID, "--json"], W);
  check("show after edit", o.json?.title, "zephyr loud task");

  o = await tm(["comment", ID, "zephyr says hello", "--json"], W);
  check(
    "comment --json exits 0 with body and task",
    tup(o.code, o.json?.body, o.json?.task),
    tup(0, "zephyr says hello", ID),
  );
  [s, r] = await api(
    "GET",
    `/api/collections/comments/records?${urlencode({ filter: `task='${ID}'` })}`,
    alice,
  );
  check(
    "the comment is on the server",
    tup(s, r.items?.length, r.items?.[0]?.body),
    tup(200, 1, "zephyr says hello"),
  );

  o = await tm(["search", "zephyr", "--json"], W);
  check(
    "search --json finds the task",
    tup(
      o.code,
      o.json?.results?.some((x: any) => x.id === ID),
    ),
    tup(0, true),
  );
  o = await tm(["search", "zephyr"], W);
  check(
    "search (human) names the task",
    tup(o.code, o.stdout.includes("zephyr loud task")),
    tup(0, true),
  );

  o = await tm(["list", "--project", PROJECT, "--json"], W);
  check(
    "list --project --json includes the task",
    tup(
      o.code,
      o.json?.some((x: any) => x.id === ID && x.kind === "task"),
    ),
    tup(0, true),
  );
  o = await tm(["list", "--kind", "document", "--json"], W);
  check(
    "list --kind document --json excludes it",
    tup(
      o.code,
      o.json?.some((x: any) => x.id === ID),
    ),
    tup(0, false),
  );
  o = await tm(["list"], W);
  check(
    "list (human) exits 0, names the task and prints its id",
    tup(o.code, o.stdout.includes("zephyr loud task"), o.stdout.includes(ID)),
    tup(0, true, true),
  );

  console.log(
    "\n── one kind vocabulary: search rows carry kind next to the server's collection ──",
  );
  o = await tm(["search", "zephyr", "--json"], W);
  const hit = o.json?.results?.find((x: any) => x.id === ID);
  check(
    "search --json row for the task carries kind task and collection tasks",
    tup(hit?.kind ?? null, hit?.collection ?? null),
    tup("task", "tasks"),
  );
  o = await tm(["search", "zephyr"], W);
  const hit_line = o.stdout.split("\n").find((l) => l.startsWith(ID)) ?? "";
  check(
    "search (human) prints the kind task, not the collection tasks",
    tup(hit_line.slice(ID.length).trimStart().startsWith("task "), hit_line.includes("tasks")),
    tup(true, false),
  );
  o = await tm(["search", project.name, "--json"], W);
  check(
    "a project hit carries kind project",
    o.json?.results?.find((x: any) => x.id === PROJECT)?.kind ?? null,
    "project",
  );

  console.log("\n── paging: --page N walks pages of --limit items ──");
  for (const t of ["one", "two", "three"]) {
    o = await tm(["create", `zephyr page ${t}`, "--project", PROJECT, "--json"], W);
    check(`create paging fixture ${t}`, o.code, 0);
  }
  const ids = (r: Run): string[] => (Array.isArray(r.json) ? r.json.map((x: any) => x.id) : []);
  const scope = ["list", "--project", PROJECT, "--kind", "task", "--json"];
  const all = ids(await tm(scope, W));
  const p1 = ids(await tm([...scope, "--limit", "2", "--page", "1"], W));
  const p2 = ids(await tm([...scope, "--limit", "2", "--page", "2"], W));
  check(
    "--limit 2 pages 1 and 2 are disjoint and together the first four items",
    tup(
      p1.length,
      p2.length,
      p1.some((id) => p2.includes(id)),
      [...p1, ...p2],
    ),
    tup(2, 2, false, all.slice(0, 4)),
  );
  o = await tm(["list", "--page", "0", "--json"], W);
  check("--page 0 → exit 2", tup(o.code, o.stdout), tup(2, ""));

  console.log("\n── the other item kinds create and show through the same verbs ──");
  o = await tm(["create", "zephyr memo", "--kind", "document", "--workspace", WS, "--json"], W);
  check(
    "create --kind document",
    tup(o.code, o.json?.kind, o.json?.title),
    tup(0, "document", "zephyr memo"),
  );
  const DOC: string = o.json?.id ?? "";
  o = await tm(["show", DOC, "--json"], W);
  check("show a document", tup(o.code, o.json?.kind), tup(0, "document"));
  o = await tm(["list", "--kind", "document", "--json"], W);
  check(
    "list --kind document includes the document and not the task",
    tup(
      o.code,
      o.json?.some((x: any) => x.id === DOC),
      o.json?.some((x: any) => x.id === ID),
    ),
    tup(0, true, false),
  );
  o = await tm(["create", "zephyr typed", "--project", PROJECT, "--set", "type=bug", "--json"], W);
  check(
    "a task's own type field is reported as the server holds it",
    tup(o.code, o.json?.kind, o.json?.type),
    tup(0, "task", "bug"),
  );
  o = await tm(["create", "zephyr m1", "--kind", "milestone", "--project", PROJECT, "--json"], W);
  check(
    "create --kind milestone",
    tup(o.code, o.json?.kind, o.json?.name),
    tup(0, "milestone", "zephyr m1"),
  );

  console.log("\n── --set is typed by the schema: yes/no and number fields ──");
  o = await tm(
    [
      "create",
      "zephyr drafted",
      "--kind",
      "decision",
      "--project",
      PROJECT,
      "--set",
      "draft=true",
      "--json",
    ],
    W,
  );
  check(
    "create a decision with --set draft=true → draft is true",
    tup(o.code, o.json?.draft),
    tup(0, true),
  );
  o = await tm(["edit", ID, "--set", "ordinal=7", "--json"], W);
  check(
    "edit a task with --set ordinal=7 → ordinal is the number 7",
    tup(o.code, o.json?.ordinal),
    tup(0, 7),
  );
  o = await tm(
    [
      "create",
      "zephyr maybe",
      "--kind",
      "decision",
      "--project",
      PROJECT,
      "--set",
      "draft=yes",
      "--json",
    ],
    W,
  );
  check(
    "--set draft=yes → exit 2 naming draft and true or false, nothing on stdout",
    tup(o.code, o.stderr.includes("draft takes true or false"), o.stdout),
    tup(2, true, ""),
  );
  o = await tm(["edit", ID, "--set", "ordinal=seven", "--json"], W);
  check(
    "--set ordinal=seven → exit 2 naming ordinal",
    tup(o.code, o.stderr.includes("ordinal takes a number")),
    tup(2, true),
  );

  console.log("\n── errors: exit 1, the server's message on stderr ──");
  o = await tm(["create", "zephyr denied", "--project", PROJECT, "--json"], R);
  check("read key create → exit 1, nothing on stdout", tup(o.code, o.stdout), tup(1, ""));
  check(
    "stderr names api_key_scope and the server's message",
    tup(o.stderr.includes("api_key_scope"), o.stderr.includes("read-only")),
    tup(true, true),
  );
  o = await tm(["show", ID, "--json"], R);
  check("read key show → exit 0 (reads are allowed)", tup(o.code, o.json?.id), tup(0, ID));
  o = await tm(["show", "nope00000000000", "--json"], W);
  check("unknown id → exit 1", tup(o.code, o.stdout), tup(1, ""));
  o = await tm(["list", "--json"], { TM_URL: BASE_URL, TM_API_KEY: `tmk_${"A".repeat(40)}` });
  check(
    "forged key → exit 1 with the server's 401 message",
    tup(o.code, o.stderr.includes("invalid")),
    tup(1, true),
  );
  o = await tm(["list", "--json"], {
    TM_URL: BASE_URL,
    HOME: path.join(S, "nohome"),
    XDG_CONFIG_HOME: path.join(S, "noxdg"),
  });
  check(
    "no key anywhere → exit 1, stderr says to run tm login",
    tup(o.code, o.stderr.includes("tm login")),
    tup(1, true),
  );
  o = await tm(["list", "--json"], { TM_URL: BASE_URL, TM_API_KEY: "x" });
  check(
    "env key without tmk_ → exit 1, names TM_API_KEY, never echoes it",
    tup(o.code, o.stdout, o.stderr.includes("TM_API_KEY"), o.stderr.includes("tmk_")),
    tup(1, "", true, true),
  );
  o = await tm(["list", "--json"], { TM_URL: BASE_URL, TM_API_KEY: "sekretvalue" });
  check("the bad key's value is not echoed", o.stderr.includes("sekretvalue"), false);
  fs.writeFileSync(cfg, JSON.stringify({ url: BASE_URL, key: "sekretfile" }));
  o = await tm(["list", "--json"], {});
  check(
    "saved key without tmk_ → exit 1, names the config file, no echo",
    tup(o.code, o.stderr.includes(cfg), o.stderr.includes("sekretfile")),
    tup(1, true, false),
  );
  o = await tm(["login", "--url", BASE_URL], {}, "sekretpaste\n");
  check(
    "login refuses a key without tmk_ → exit 1, no echo",
    tup(o.code, o.stderr.includes("tmk_"), (o.stdout + o.stderr).includes("sekretpaste")),
    tup(1, true, false),
  );
  // repair: a bad saved key is replaced by login; a bad env key never blocks login
  fs.writeFileSync(cfg, JSON.stringify({ url: BASE_URL, key: "sekretfile" }));
  o = await tm(["login"], {}, `${WRITE_KEY}\n`);
  check(
    "login replaces a bad saved key (url kept) → exit 0, file holds the good key",
    tup(o.code, JSON.parse(fs.readFileSync(cfg, "utf8"))),
    tup(0, { url: BASE_URL, key: WRITE_KEY }),
  );
  o = await tm(["login"], { TM_API_KEY: "x" }, `${WRITE_KEY}\n`);
  check("a bad env key does not block login → exit 0", o.code, 0);
  o = await tm(["list", "--json"], { TM_API_KEY: ` Bearer  ${WRITE_KEY} ` });
  check("env key with Bearer and spaces is normalised and accepted", o.code, 0);
  o = await tm(["list", "--json"], { TM_API_KEY: `  ${WRITE_KEY}` });
  check("env key with leading spaces is accepted", o.code, 0);
  o = await tm(["list", "--json"], { TM_API_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.sig" });
  check("a JWT-looking value is refused → exit 1", o.code, 1);
  o = await tm(["login"], {}, "eyJhbGciOiJIUzI1NiJ9.e30.sig\n");
  check("login refuses a JWT-looking paste → exit 1", o.code, 1);
  fs.writeFileSync(cfg, `{"url":"${BASE_URL}","key":ZQXsecret}`);
  o = await tm(["list", "--json"], {});
  check(
    "corrupt config → exit 1, names the file, never quotes the parser",
    tup(o.code, o.stderr.includes(cfg), o.stderr.includes("ZQXsecret")),
    tup(1, true, false),
  );
  fs.rmSync(cfg);
  o = await tm(["frobnicate"], W);
  check("unknown verb → exit 2 (usage)", o.code, 2);
  o = await tm(["--help"]);
  check("--help → exit 0", o.code, 0);
  o = await tm(["list", "--limit", "0", "--json"], W);
  check("--limit 0 → exit 2", o.code, 2);
  o = await tm(["list", "--json"], { TM_URL: "not-a-url", TM_API_KEY: WRITE_KEY });
  check(
    "a non-URL server → exit 1, a message, no stack trace",
    tup(o.code, o.stderr.includes("not a URL"), o.stderr.includes("    at ")),
    tup(1, true, false),
  );
  o = await tm(["list", "--json"], { TM_URL: "http://127.0.0.1:1", TM_API_KEY: WRITE_KEY });
  check(
    "an unreachable server → exit 1, says it cannot reach it, no raw error mechanism",
    tup(o.code, o.stderr.includes("cannot reach"), /ECONNREFUSED|fetch/i.test(o.stderr)),
    tup(1, true, false),
  );
  o = await tm(["create", "zephyr nowhere", "--json"], W);
  check(
    "create with neither project nor workspace → exit 2 naming both as inputs",
    tup(o.code, o.stderr.includes("create needs a project or a workspace")),
    tup(2, true),
  );
  const BROKEN = path.join(S, "broken-xdg");
  fs.mkdirSync(path.join(BROKEN, "tm"), { recursive: true });
  fs.writeFileSync(path.join(BROKEN, "tm", "config.json"), "null\n");
  o = await tm(["list", "--json"], { XDG_CONFIG_HOME: BROKEN });
  check(
    "a broken config file → exit 1 naming the file, no stack trace",
    tup(
      o.code,
      o.stderr.includes(path.join(BROKEN, "tm", "config.json")),
      o.stderr.includes("    at "),
    ),
    tup(1, true, false),
  );

  console.log("\n── the command line is checked before any saved login is needed ──");
  const NOWHERE = { HOME: path.join(S, "nohome"), XDG_CONFIG_HOME: path.join(S, "noxdg") };
  for (const args of [
    ["list", "--limit", "0", "--json"],
    ["list", "--page", "x", "--json"],
    ["list", "--kind", "sprint", "--json"],
    ["create", "x", "--kind", "decision", "--project", "p", "--set", "draft=yes"],
    ["show", "--json"],
    ["create", "foo"],
    ["edit", "abc"],
    ["frobnicate"],
  ]) {
    o = await tm(args, NOWHERE);
    check(
      `${args.join(" ")} with no login anywhere → exit 2 with the usage text`,
      tup(o.code, o.stderr.includes("usage: tm"), o.stderr.includes("no server or key")),
      tup(2, true, false),
    );
  }

  console.log("\n── login at a terminal: the pasted key is never echoed ──");
  if (!["darwin", "linux"].includes(process.platform) || !Bun.which("script")) {
    console.log("  ⏭  skipped: needs script(1) on macOS or linux to drive a pseudo-terminal");
  } else {
    const PTY_XDG = path.join(S, "pty-xdg");
    const pty = await tm_pty(
      TM,
      ["login", "--url", BASE_URL],
      { XDG_CONFIG_HOME: PTY_XDG },
      `${WRITE_KEY}\n`,
    );
    const pty_cfg = path.join(PTY_XDG, "tm", "config.json");
    const pty_saved = fs.existsSync(pty_cfg) ? JSON.parse(fs.readFileSync(pty_cfg, "utf8")) : {};
    check(
      "login at a terminal exits 0 and saves the key",
      tup(pty.code, pty_saved.key === WRITE_KEY),
      tup(0, true),
    );
    check("the key never appears on the terminal", pty.out.includes(WRITE_KEY), false);
    // Self-check: the same run without raw mode echoes the key, so the terminal really echoes.
    const NO_RAW = path.join(S, "no-raw");
    copy_tree(path.join(path.dirname(TM), "src"), path.join(NO_RAW, "src"));
    const real = fs.readFileSync(TM, "utf8");
    const src = real.replace("process.stdin.setRawMode(true);", "");
    fs.writeFileSync(path.join(NO_RAW, "tm.ts"), src);
    const echo = await tm_pty(
      path.join(NO_RAW, "tm.ts"),
      ["login", "--url", BASE_URL],
      { XDG_CONFIG_HOME: path.join(S, "no-raw-xdg") },
      `${WRITE_KEY}\n`,
    );
    check(
      "self-check: without raw mode the terminal echoes the key",
      tup(src !== real, echo.out.includes(WRITE_KEY)),
      tup(true, true),
    );
  }
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all tm CLI proofs passed");
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * tm mcp (clients/tm): a real MCP client over stdio lists the six tools with their hints, create/show
 * round-trip, search rows carry kind, tm_list pages, fields take typed values, a refusal names
 * inputs not flags, a read key's write is an isError result naming api_key_scope
 * (decision:api-keys), and
 * an agent holding only an API key lists, creates, edits, comments and searches.
 *
 * Fully self-contained clean-room server; runs `tm mcp` as a subprocess. Port 8194 + PB_PORT_OFFSET.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const TM = path.join(REPO_ROOT, "clients", "tm", "tm.ts");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8194 + PORT_OFFSET;
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tm-mcp-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

type Called = { isError: boolean; text: string; json: any };

/** A real MCP client: spawns `tm mcp` exactly as an agent host would, with only the env given. */
async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TM, "mcp"],
    cwd: S, // never the repo: the server must not depend on where it is run from
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test_tm_mcp", version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Called> {
  const r: any = await client.callTool({ name, arguments: args });
  const text = (r.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { isError: r.isError === true, text, json };
}

let server: roomkit.Room | null = null;
const clients: Client[] = [];
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
    name: "mcp write",
    scope: "write",
  });
  check("write key minted", tup(s, /^tmk_/.test(r.key ?? "")), tup(200, true));
  const WRITE_KEY: string = r.key;
  [s, r] = await api("POST", "/api/collections/api_keys/records", alice, {
    name: "mcp read",
    scope: "read",
  });
  check("read key minted", tup(s, /^tmk_/.test(r.key ?? "")), tup(200, true));
  const READ_KEY: string = r.key;
  const W = { HOME: S, TM_URL: BASE_URL, TM_API_KEY: WRITE_KEY };
  const R = { HOME: S, TM_URL: BASE_URL, TM_API_KEY: READ_KEY };

  console.log(
    "\n── tools/list: six tools, read tools readOnlyHint, write tools not destructive ──",
  );
  const w = await connect(W);
  clients.push(w);
  const listed = await w.listTools();
  const tools = Object.fromEntries(listed.tools.map((t) => [t.name, t]));
  check("the six verbs, each as tm_<verb>", Object.keys(tools).sort(), [
    "tm_comment",
    "tm_create",
    "tm_edit",
    "tm_list",
    "tm_search",
    "tm_show",
  ]);
  for (const name of ["tm_list", "tm_show", "tm_search"]) {
    check(`${name} is readOnlyHint`, tools[name]?.annotations?.readOnlyHint, true);
  }
  for (const name of ["tm_create", "tm_edit", "tm_comment"]) {
    check(
      `${name} is a write tool, destructiveHint false`,
      tup(
        tools[name]?.annotations?.readOnlyHint ?? false,
        tools[name]?.annotations?.destructiveHint,
      ),
      tup(false, false),
    );
  }
  check(
    "every tool has a description and an object input schema",
    listed.tools.every(
      (t) =>
        typeof t.description === "string" &&
        t.description.length > 20 &&
        t.inputSchema?.type === "object",
    ),
    true,
  );
  check(
    "tm_show requires id; tm_create requires title",
    tup(tools.tm_show?.inputSchema?.required, tools.tm_create?.inputSchema?.required),
    tup(["id"], ["title"]),
  );
  check(
    "tm_list's kind is an enum of the four kinds",
    (tools.tm_list?.inputSchema?.properties as any)?.kind?.enum,
    ["task", "document", "decision", "milestone"],
  );

  console.log("\n── create → show round-trip, then edit, comment, search, list (write key) ──");
  let o = await call(w, "tm_create", { title: "zephyr quiet task", project: PROJECT });
  check("tm_create is not an error", o.isError, false);
  const ID: string = o.json?.id ?? "";
  check(
    "tm_create returns the CLI's --json shape: id, kind, title, project, workspace",
    tup(Boolean(ID), o.json?.kind, o.json?.title, o.json?.project, o.json?.workspace),
    tup(true, "task", "zephyr quiet task", PROJECT, WS),
  );
  o = await call(w, "tm_show", { id: ID });
  check(
    "tm_show round-trips the created task",
    tup(o.isError, o.json?.id, o.json?.kind, o.json?.title),
    tup(false, ID, "task", "zephyr quiet task"),
  );
  o = await call(w, "tm_edit", {
    id: ID,
    title: "zephyr loud task",
    fields: { description: "now described" },
  });
  check(
    "tm_edit changes title and a --set field",
    tup(o.isError, o.json?.title, o.json?.description),
    tup(false, "zephyr loud task", "now described"),
  );
  o = await call(w, "tm_comment", { id: ID, body: "zephyr says hello" });
  check(
    "tm_comment returns the comment with its task",
    tup(o.isError, o.json?.body, o.json?.task),
    tup(false, "zephyr says hello", ID),
  );
  [s, r] = await api(
    "GET",
    `/api/collections/comments/records?${urlencode({ filter: `task='${ID}'` })}`,
    alice,
  );
  check("the comment is on the server", tup(s, r.items?.length), tup(200, 1));
  o = await call(w, "tm_search", { query: "zephyr" });
  check(
    "tm_search finds the task",
    tup(
      o.isError,
      o.json?.results?.some((x: any) => x.id === ID),
    ),
    tup(false, true),
  );
  o = await call(w, "tm_list", { project: PROJECT, kind: "task" });
  check(
    "tm_list by project and kind includes it",
    tup(
      o.isError,
      Array.isArray(o.json) && o.json.some((x: any) => x.id === ID && x.kind === "task"),
    ),
    tup(false, true),
  );
  o = await call(w, "tm_create", { title: "zephyr m1", kind: "milestone", project: PROJECT });
  check(
    "tm_create a milestone",
    tup(o.isError, o.json?.kind, o.json?.name),
    tup(false, "milestone", "zephyr m1"),
  );

  console.log("\n── search rows carry kind; tm_list pages with page and limit ──");
  o = await call(w, "tm_search", { query: "zephyr" });
  check(
    "tm_search row for the task carries kind task and collection tasks",
    tup(
      o.json?.results?.find((x: any) => x.id === ID)?.kind ?? null,
      o.json?.results?.find((x: any) => x.id === ID)?.collection ?? null,
    ),
    tup("task", "tasks"),
  );
  for (const t of ["one", "two", "three"]) {
    o = await call(w, "tm_create", { title: `zephyr page ${t}`, project: PROJECT });
    check(`tm_create paging fixture ${t}`, o.isError, false);
  }
  const ids = (c: Called): string[] => (Array.isArray(c.json) ? c.json.map((x: any) => x.id) : []);
  const scope = { project: PROJECT, kind: "task" };
  const all = ids(await call(w, "tm_list", scope));
  const p1 = ids(await call(w, "tm_list", { ...scope, limit: 2, page: 1 }));
  const p2 = ids(await call(w, "tm_list", { ...scope, limit: 2, page: 2 }));
  check(
    "tm_list limit 2 pages 1 and 2 are disjoint and together the first four items",
    tup(
      p1.length,
      p2.length,
      p1.some((id) => p2.includes(id)),
      [...p1, ...p2],
    ),
    tup(2, 2, false, all.slice(0, 4)),
  );
  check(
    "tm_list declares page as an integer of at least 1",
    tup(
      (tools.tm_list?.inputSchema?.properties as any)?.page?.type,
      (tools.tm_list?.inputSchema?.properties as any)?.page?.minimum,
    ),
    tup("integer", 1),
  );
  o = await call(w, "tm_list", { page: 0 });
  check(
    "tm_list with page 0 → isError naming page",
    tup(o.isError, o.text.includes("page")),
    tup(true, true),
  );

  console.log("\n── fields take strings, numbers and yes/no values ──");
  check(
    "tm_create's fields accept string, number and boolean values",
    (tools.tm_create?.inputSchema?.properties as any)?.fields?.additionalProperties?.type,
    ["string", "number", "boolean"],
  );
  o = await call(w, "tm_create", {
    title: "zephyr drafted",
    kind: "decision",
    project: PROJECT,
    fields: { draft: true },
  });
  check(
    "tm_create a decision with draft true → draft is true",
    tup(o.isError, o.json?.draft),
    tup(false, true),
  );
  o = await call(w, "tm_edit", { id: ID, fields: { ordinal: 7 } });
  check("tm_edit with ordinal 7 → ordinal is 7", tup(o.isError, o.json?.ordinal), tup(false, 7));
  o = await call(w, "tm_edit", { id: ID, fields: { ordinal: "8" } });
  check(
    'tm_edit with ordinal "8" (text) → ordinal is the number 8',
    tup(o.isError, o.json?.ordinal),
    tup(false, 8),
  );
  o = await call(w, "tm_create", {
    title: "zephyr maybe",
    kind: "decision",
    project: PROJECT,
    fields: { draft: "yes" },
  });
  check(
    'tm_create with draft "yes" → isError naming draft and true or false',
    tup(o.isError, o.text.includes("draft takes true or false")),
    tup(true, true),
  );

  console.log("\n── refusals are tool results with isError, never protocol errors ──");
  const rd = await connect(R);
  clients.push(rd);
  o = await call(rd, "tm_create", { title: "zephyr denied", project: PROJECT });
  check(
    "read key on tm_create → isError naming api_key_scope and the server's message",
    tup(o.isError, o.text.includes("api_key_scope"), o.text.includes("read-only")),
    tup(true, true, true),
  );
  o = await call(rd, "tm_show", { id: ID });
  check("read key on tm_show → reads are allowed", tup(o.isError, o.json?.id), tup(false, ID));
  o = await call(w, "tm_show", { id: "nope00000000000" });
  check(
    "unknown id → isError with a message naming the id",
    tup(o.isError, o.text.includes("nope00000000000")),
    tup(true, true),
  );
  o = await call(w, "tm_edit", { id: ID });
  check(
    "tm_edit with nothing to change → isError naming the inputs, no flags",
    tup(o.isError, o.text.includes("a title or a field"), o.text.includes("--")),
    tup(true, true, false),
  );
  o = await call(w, "tm_show", {});
  check(
    "tm_show without id → isError naming id",
    tup(o.isError, o.text.includes("id")),
    tup(true, true),
  );
  o = await call(w, "tm_create", { title: "zephyr nowhere" });
  check(
    "tm_create without project or workspace → isError naming the inputs, no flags",
    tup(o.isError, o.text.includes("a project or a workspace"), o.text.includes("--")),
    tup(true, true, false),
  );
  o = await call(w, "tm_list", { kind: "sprint" });
  check(
    "tm_list with an unknown kind → isError naming kind",
    tup(o.isError, o.text.includes("kind")),
    tup(true, true),
  );

  console.log("\n── wrong-typed input is refused before anything is sent ──");
  o = await call(w, "tm_list", { limit: "abc" });
  check(
    "tm_list with a non-integer limit → isError naming limit",
    tup(o.isError, o.text.includes("limit")),
    tup(true, true),
  );
  o = await call(w, "tm_edit", { id: ID, fields: "x" });
  check(
    "tm_edit with fields as a string → isError naming fields",
    tup(o.isError, o.text.includes("fields")),
    tup(true, true),
  );
  o = await call(w, "tm_show", { id: ID });
  check("the server still answers afterwards", tup(o.isError, o.json?.id), tup(false, ID));

  console.log("\n── the server exits when the host closes its input ──");
  const lone = Bun.spawn([process.execPath, TM, "mcp"], {
    cwd: S,
    env: { PATH: process.env.PATH ?? "", ...W },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  lone.stdin.end();
  const exited = await Promise.race([lone.exited, Bun.sleep(5_000).then(() => "still running")]);
  check("tm mcp exits 0 within 5s of end of input", exited, 0);
  if (exited !== 0) lone.kill();

  console.log("\n── stage check: only PocketBase running, only an API key in the env ──");
  // The transport passes the parent's HOME through, so point it at an empty place: no saved
  // login can leak in, and the key and URL in the environment are all there is.
  const agent = await connect({
    TM_URL: BASE_URL,
    TM_API_KEY: WRITE_KEY,
    HOME: path.join(S, "nohome"),
    XDG_CONFIG_HOME: path.join(S, "noxdg"),
  });
  clients.push(agent);
  const names = (await agent.listTools()).tools.map((t) => t.name).sort();
  check("agent lists the tools", names.length, 6);
  o = await call(agent, "tm_create", { title: "stage check item", project: PROJECT });
  const SID: string = o.json?.id ?? "";
  check("agent creates", tup(o.isError, Boolean(SID)), tup(false, true));
  o = await call(agent, "tm_edit", { id: SID, title: "stage check item, edited" });
  check("agent edits", tup(o.isError, o.json?.title), tup(false, "stage check item, edited"));
  o = await call(agent, "tm_comment", { id: SID, body: "stage check comment" });
  check("agent comments", tup(o.isError, o.json?.task), tup(false, SID));
  o = await call(agent, "tm_search", { query: "stage check" });
  check(
    "agent searches and finds what it made",
    tup(
      o.isError,
      o.json?.results?.some((x: any) => x.id === SID),
    ),
    tup(false, true),
  );
  o = await call(agent, "tm_list", {});
  check(
    "agent lists items and sees it",
    tup(o.isError, Array.isArray(o.json) && o.json.some((x: any) => x.id === SID)),
    tup(false, true),
  );
} finally {
  for (const c of clients) await c.close().catch(() => {});
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all tm mcp proofs passed");
  process.exit(0);
}

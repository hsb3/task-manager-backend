#!/usr/bin/env bun
/** e2e world kit: a fixed seed generates the same world, and e2e/seed.ts builds it in a fresh room through the public API only. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { seed_world } from "../e2e/seed.ts";
import { CORE_LABELS, STATUSES, generate, persona, writers, type World } from "../e2e/world.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8160 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const SEED = 1;
// Re-pin only on purpose: a changed generator changes every world an agent has seeded before.
const WORLD_1_SHA256 = "5e29f543fbf0bbd68f22aae81f224c732c939ca22316da509ee8094779808f15";
const BURST_CAP = 700;

let failures = 0;
function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(64)} → ${py_repr(got)}` +
      (ok ? "" : ` (want ${py_repr(expected)})`),
  );
}

async function get(p: string, token: string): Promise<[number, any]> {
  const r = await fetch(BASE_URL + p, { headers: { Authorization: token } });
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}];
}
const list = (coll: string, params: Record<string, any>): string =>
  `/api/collections/${coll}/records?${urlencode({ perPage: 500, ...params })}`;
const sorted = <T>(xs: T[]): T[] => [...xs].sort((a, b) => (py_repr(a) < py_repr(b) ? -1 : 1));

function violations(w: World): string[] {
  const out: string[] = [];
  const ws = Object.fromEntries(w.workspaces.map((x) => [x.key, x]));
  const p = persona(w);
  const role = p.workspace.members.find((m) => m.user === p.user.key)?.role;
  if (role !== "member") out.push(`persona role ${role}`);
  if (w.users.length > 5) out.push(`${w.users.length} users overrun the login budget`);
  const mine = w.items.filter((i) => i.workspace === p.workspace.key);
  const probe_filters: [string, (i: (typeof mine)[number]) => boolean][] = [
    ["document", (i) => i.type === "document"],
    ["In Progress", (i) => i.status === "In Progress"],
    ["persona assignee", (i) => i.assignee === p.user.key],
    ["due by 2026-12-31", (i) => i.due !== null && i.due <= "2026-12-31"],
    ["Bug label", (i) => i.labels.includes("Bug")],
  ];
  for (const [name, pred] of probe_filters)
    if (!mine.some(pred)) out.push(`no ${name} row for the probe to match`);
  if (JSON.stringify(w).toLowerCase().includes("zephyr")) out.push("zephyr appears");
  for (const i of w.items) {
    const wr = writers(ws[i.workspace]!);
    if (!wr.includes(i.author)) out.push(`${i.key} author ${i.author}`);
    if (i.assignee !== null && !wr.includes(i.assignee)) out.push(`${i.key} assignee`);
    if (i.status !== null && !STATUSES.includes(i.status)) out.push(`${i.key} status`);
    const names = [...CORE_LABELS, ...ws[i.workspace]!.labels.map((l) => l.name)];
    for (const l of i.labels) if (!names.includes(l)) out.push(`${i.key} label ${l}`);
  }
  const items = Object.fromEntries(w.items.map((i) => [i.key, i]));
  for (const c of w.comments) {
    const i = items[c.item];
    if (i?.type !== "task" || !writers(ws[i.workspace]!).includes(c.author))
      out.push(`comment on ${c.item} by ${c.author}`);
  }
  return out;
}

console.log("\n── the generator: same seed, same world ──");
const world = generate(SEED);
check("generate(1) twice → identical JSON", JSON.stringify(generate(SEED)), JSON.stringify(world));
check(
  "generate(2) differs from generate(1)",
  JSON.stringify(generate(2)) === JSON.stringify(world),
  false,
);
check(
  "generate(1) sha256 is pinned",
  crypto.createHash("sha256").update(JSON.stringify(world)).digest("hex"),
  WORLD_1_SHA256,
);
const bad: string[] = [];
for (let s = 1; s <= 50; s++) bad.push(...violations(generate(s)).map((v) => `seed ${s}: ${v}`));
check("seeds 1-50: every invariant holds", bad, []);
check(
  "world 1 has items and comments",
  [world.items.length > 0, world.comments.length > 0],
  [true, true],
);

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-e2e-world-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(path.join(REPO_ROOT, "pb_migrations"), MIG_DIR);
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
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));

  console.log("\n── seed world 1 into a fresh room ──");
  const seeded = await seed_world(BASE_URL, world, [SU_EMAIL, SU_PASSWORD]);
  const su: any = await (
    await fetch(BASE_URL + "/api/collections/_superusers/auth-with-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: SU_EMAIL, password: SU_PASSWORD }),
    })
  ).json();
  // The server's own request log, not the seeder's (minus roomkit's health polls): PocketBase writes it asynchronously.
  let reqs: any[] = [];
  for (let n = 0; n < 80 && reqs.length <= seeded.log.length; n++) {
    if (n) await Bun.sleep(250);
    const q = {
      filter: "data.type = 'request' && data.url !~ '/api/logs' && data.url !~ '/api/health'",
      perPage: 1000,
    };
    reqs = (await get(`/api/logs?${urlencode(q)}`, su.token))[1].items ?? [];
  }
  const calls = (pred: (d: any) => boolean): string[] =>
    reqs.filter((l) => pred(l.data)).map((l) => `${l.data.method} ${l.data.url.split("?")[0]}`);
  check(
    "server log: every request the seeder sent is in its own log (plus this suite's sign-in)",
    reqs.length,
    seeded.log.length + 1,
  );
  check(
    "server log: superuser-authenticated requests are the account creates only",
    calls((d) => d.auth === "_superusers"),
    world.users.map(() => "POST /api/collections/users/records"),
  );
  check(
    "server log: every unauthenticated request is a sign-in",
    [...new Set(calls((d) => d.auth === ""))].sort(),
    [
      "POST /api/collections/_superusers/auth-with-password",
      "POST /api/collections/users/auth-with-password",
    ],
  );
  check(
    "server log: every other request carries a users token",
    [...new Set(reqs.map((l) => l.data.auth))].sort(),
    ["", "_superusers", "users"],
  );

  console.log("\n── read the world back through each user's eyes ──");
  const tok = (k: string): string => seeded.users[k]!.token;
  const key_of = Object.fromEntries(Object.entries(seeded.users).map(([k, u]) => [u.id, k]));
  for (const u of world.users) {
    const [s, r] = await get("/api/tracker/me", tok(u.key));
    const want = world.workspaces
      .flatMap((w) =>
        w.owner === u.key
          ? [[w.name, "owner"]]
          : w.members.filter((m) => m.user === u.key).map((m) => [w.name, m.role]),
      )
      .sort();
    check(
      `${u.name}: /api/tracker/me workspaces and roles`,
      [s, sorted((r.workspaces ?? []).map((w: any) => [w.name, w.role]))],
      [200, want],
    );
  }
  for (const w of world.workspaces) {
    const t = tok(w.owner);
    const id = seeded.workspaces[w.key]!;
    let [, r] = await get(list("projects", { filter: `workspace='${id}'` }), t);
    const project_of = Object.fromEntries((r.items ?? []).map((p: any) => [p.id, p.name]));
    check(
      `${w.name}: projects (name, description)`,
      sorted((r.items ?? []).map((p: any) => [p.name, p.description])),
      sorted(w.projects.map((p) => [p.name, p.description])),
    );
    [, r] = await get(list("labels", { filter: `workspace='${id}'` }), t);
    const label_of = Object.fromEntries((r.items ?? []).map((l: any) => [l.id, l.name]));
    check(
      `${w.name}: labels`,
      Object.values(label_of).sort(),
      [...CORE_LABELS, ...w.labels.map((l) => l.name)].sort(),
    );
    check(
      `${w.name}: custom labels (name, color)`,
      sorted((r.items ?? []).filter((l: any) => !l.core).map((l: any) => [l.name, l.color])),
      sorted(w.labels.map((l) => [l.name, l.color])),
    );
    [, r] = await get(list("statuses", { filter: `workspace='${id}'` }), t);
    const status_of = Object.fromEntries((r.items ?? []).map((x: any) => [x.id, x.name]));
    [, r] = await get(list("project_items", { filter: `workspace='${id}'` }), t);
    const got = (r.items ?? []).map((i: any) => [
      i.type,
      i.title,
      project_of[i.project] ?? i.project,
      status_of[i.status] ?? null,
      key_of[i.assignee] ?? null,
      i.due || null,
      (JSON.parse(i.labels || "[]") as string[]).map((l) => label_of[l] ?? l).sort(),
      key_of[i.author] ?? i.author,
      i.comment_count,
    ]);
    const want = world.items
      .filter((i) => i.workspace === w.key)
      .map((i) => [
        i.type,
        i.title,
        w.projects.find((p) => p.key === i.project)!.name,
        i.status,
        i.assignee,
        i.due,
        [...i.labels].sort(),
        i.author,
        world.comments.filter((c) => c.item === i.key).length,
      ]);
    check(
      `${w.name}: items (type, title, project, status, assignee, due, labels, author, comments)`,
      sorted(got),
      sorted(want),
    );
    [, r] = await get(list("documents", { filter: `workspace='${id}'` }), t);
    check(
      `${w.name}: documents (title, body)`,
      sorted((r.items ?? []).map((d: any) => [d.title, d.body])),
      sorted(
        world.items
          .filter((i) => i.workspace === w.key && i.type === "document")
          .map((i) => [i.title, i.body]),
      ),
    );
    [, r] = await get(list("comments", { filter: `task.workspace='${id}'`, expand: "task" }), t);
    const title_of = Object.fromEntries(world.items.map((i) => [i.key, i.title]));
    check(
      `${w.name}: comments (item, author, body)`,
      sorted(
        (r.items ?? []).map((c: any) => [
          c.expand?.task?.title,
          key_of[c.author] ?? c.author,
          c.body,
        ]),
      ),
      sorted(
        world.comments
          .filter((c) => world.items.find((i) => i.key === c.item)!.workspace === w.key)
          .map((c) => [title_of[c.item], c.author, c.body]),
      ),
    );
  }

  console.log("\n── the limiter claims e2e/README.md makes ──");
  const me = tok(persona(world).user.key);
  let first429 = -1;
  for (let n = 0; n < BURST_CAP && first429 < 0; n++) {
    const [s] = await get("/api/tracker/me", me);
    if (s === 429) first429 = n;
  }
  check("a custom-route burst meets a 429", first429 >= 0, true);
  check(
    "another custom route shares the /api/ bucket",
    (await get("/api/tracker/summary", me))[0],
    429,
  );
  check(
    "a collection route keeps its own bucket",
    (await get(list("projects", { perPage: 1 }), me))[0],
    200,
  );
  const su_statuses = new Set<number>();
  for (let n = 0; n < 20; n++) su_statuses.add((await get("/api/tracker/summary", su.token))[0]);
  check(
    "a superuser skips the exhausted /api/ bucket (20 calls)",
    [...su_statuses].includes(429),
    false,
  );
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ e2e world: generated and seeded as specified");
process.exit(0);

#!/usr/bin/env bun
/**
 * E2E proof of the path-scoped rules (decision:backend-owns-business-rules): a request naming `?workspace=` reaches a
 * cycles / templates / saved_views / workspace_members / workspace_invitations / projects record only when
 * the record lives in that workspace, so a caller active in BOTH workspaces gets PB's own 404
 * for a foreign id and nothing is changed; naming the record's own workspace, or none at all,
 * behaves as before. Realtime and expand (which never name one) are pinned unchanged.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, scripts/seed.ts
 * fixtures. Port 8165 + PB_PORT_OFFSET (suite self-boot band per .agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8165 + PORT_OFFSET;
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
  p: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + p, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

async function first(collection: string, filt: string, token: string): Promise<any> {
  const [, r] = await api(
    "GET",
    `/api/collections/${collection}/records?${urlencode({ filter: filt })}`,
    token,
  );
  return (r.items ?? [])[0] ?? null;
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [roomkit.token_of(BASE_URL, email, r), r.record.id];
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-path-scope-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(path.join(REPO_ROOT, "pb_migrations"), MIG_DIR, { recursive: true, dereference: true });
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
  const [, sur] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = roomkit.token_of(BASE_URL, SU_EMAIL, sur);

  console.log("\n── seed: alice/bob/carol fixtures (scripts/seed.ts) ──");
  const seed = Bun.spawnSync([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: BASE_URL,
      PB_SUPERUSER_EMAIL: SU_EMAIL,
      PB_SUPERUSER_PASSWORD: SU_PASSWORD,
    },
  });
  check("seed.ts exit code", seed.exitCode, 0);
  if (seed.exitCode !== 0) {
    console.log(seed.stdout.toString(), seed.stderr.toString());
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const [alice, alice_id] = await login("alice@example.com");
  const [bob, bob_id] = await login("bob@example.com");
  const [carol, carol_id] = await login("carol@example.com");
  const WA = (await first("workspaces", `name="Alice's Workspace"`, alice))?.id;
  const WB = (await first("workspaces", `name="Bob's Workspace"`, bob))?.id;
  check("(fixture) resolved both workspaces", truthy(WA) && truthy(WB), true);

  // Carol is an ACTIVE ADMIN in both workspaces: every record-own-workspace rule lets her in,
  // so only the address can tell the two tenants apart.
  for (const ws of [WA, WB]) {
    const [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: ws,
      user: carol_id,
      role: "admin",
      status: "active",
    });
    check(`(fixture) Carol joins ${ws === WA ? "A" : "B"} as an active admin`, s, 200);
  }

  // Each collection: how to make a fresh record in B, and two patches that each change it.
  let seq = 0;
  type Target = {
    make: () => Promise<[number, any]>;
    patches: [any, any, any];
    field: string;
    noUpdate?: true;
  };
  const TARGETS: Record<string, Target> = {
    cycles: {
      make: () =>
        api("POST", "/api/collections/cycles/records", bob, {
          workspace: WB,
          name: `B cycle ${++seq}`,
          starts_on: `${2027 + seq}-01-01 00:00:00.000Z`,
        }),
      patches: [{ name: "hijacked" }, { name: "renamed in B" }, { name: "renamed unaddressed" }],
      field: "name",
    },
    templates: {
      make: () =>
        api("POST", "/api/collections/templates/records", bob, {
          workspace: WB,
          type: "task",
          name: `B template ${++seq}`,
        }),
      patches: [{ name: "hijacked" }, { name: "renamed in B" }, { name: "renamed unaddressed" }],
      field: "name",
    },
    saved_views: {
      make: () =>
        api("POST", "/api/collections/saved_views/records", bob, {
          workspace: WB,
          owner: bob_id,
          scope: "workspace",
          name: `B view ${++seq}`,
        }),
      patches: [{ name: "hijacked" }, { name: "renamed in B" }, { name: "renamed unaddressed" }],
      field: "name",
    },
    // A first DELETE moves a project to the trash (204, the row stays); that is what "deleted" means here.
    projects: {
      make: () =>
        api("POST", "/api/collections/projects/records", bob, {
          workspace: WB,
          owner: bob_id,
          name: `B project ${++seq}`,
          key: `PS${seq}`,
        }),
      patches: [{ name: "hijacked" }, { name: "renamed in B" }, { name: "renamed unaddressed" }],
      field: "name",
    },
    // An admin may change a member's status, never their role.
    workspace_members: {
      make: () =>
        api("POST", "/api/collections/workspace_members/records", su, {
          workspace: WB,
          user: alice_id,
          role: "member",
          status: "active",
        }),
      patches: [{ status: "suspended" }, { status: "suspended" }, { status: "active" }],
      field: "status",
    },
    // updateRule is null: an invitation is never edited, so update stays 403 however addressed.
    workspace_invitations: {
      make: () =>
        api("POST", "/api/collections/workspace_invitations/records", bob, {
          workspace: WB,
          email: `invitee${++seq}@example.com`,
          role: "member",
        }),
      patches: [{ role: "viewer" }, { role: "viewer" }, { role: "viewer" }],
      field: "role",
      noUpdate: true,
    },
  };

  // COVERS: rule:cycles.view, rule:cycles.update, rule:cycles.delete
  // COVERS: rule:templates.view, rule:templates.update, rule:templates.delete
  // COVERS: rule:saved_views.view, rule:saved_views.update, rule:saved_views.delete
  // COVERS: rule:workspace_members.view, rule:workspace_members.update, rule:workspace_members.delete
  // COVERS: rule:workspace_invitations.view, rule:workspace_invitations.delete
  // COVERS: rule:projects.view, rule:projects.update, rule:projects.delete
  for (const [coll, t] of Object.entries(TARGETS)) {
    console.log(`\n── ${coll}: a record in B, Carol (admin in A and B) addressing it ──`);
    const url = (id: string, ws?: string) =>
      `/api/collections/${coll}/records/${id}${ws === undefined ? "" : `?workspace=${ws}`}`;
    const [ms, rec] = await t.make();
    check(`(fixture) ${coll}: record created in B`, ms, 200);
    const id = rec.id;
    const stored = async () => (await api("GET", url(id), su))[1][t.field];
    const before = await stored();

    check(`${coll}: view addressed to A → 404`, (await api("GET", url(id, WA), carol))[0], 404);
    check(`${coll}: view addressed to B → 200`, (await api("GET", url(id, WB), carol))[0], 200);
    check(`${coll}: view unaddressed → 200`, (await api("GET", url(id), carol))[0], 200);

    const denied = t.noUpdate ? 403 : 404;
    const ok = t.noUpdate ? 403 : 200;
    check(
      `${coll}: update addressed to A → ${denied}`,
      (await api("PATCH", url(id, WA), carol, t.patches[0]))[0],
      denied,
    );
    check(`${coll}: …and the record is unchanged`, await stored(), before);
    check(
      `${coll}: update addressed to B → ${ok}`,
      (await api("PATCH", url(id, WB), carol, t.patches[1]))[0],
      ok,
    );
    check(
      `${coll}: update unaddressed → ${ok}`,
      (await api("PATCH", url(id), carol, t.patches[2]))[0],
      ok,
    );
    if (!t.noUpdate)
      check(`${coll}: …and the unaddressed update landed`, await stored(), t.patches[2][t.field]);

    check(
      `${coll}: delete addressed to A → 404`,
      (await api("DELETE", url(id, WA), carol))[0],
      404,
    );
    check(`${coll}: …and the record still exists`, (await api("GET", url(id), su))[0], 200);
    check(
      `${coll}: delete addressed to B → 204`,
      (await api("DELETE", url(id, WB), carol))[0],
      204,
    );
    const [rs, again] = await t.make();
    check(`(fixture) ${coll}: a second record created in B`, rs, 200);
    check(`${coll}: delete unaddressed → 204`, (await api("DELETE", url(again.id), carol))[0], 204);
  }

  // The clause only narrows: naming the record's own workspace grants nothing the rule withheld.
  console.log("\n── authority never widens ──");
  const [, plain] = await TARGETS.cycles.make();
  await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: WB,
    user: alice_id,
    role: "member",
    status: "active",
  });
  check(
    "Alice (plain member of B) updates a B cycle addressed to B → 404",
    (
      await api("PATCH", `/api/collections/cycles/records/${plain.id}?workspace=${WB}`, alice, {
        name: "x",
      })
    )[0],
    404,
  );
  check(
    "an EMPTY workspace param fails closed: Carol views a B cycle → 404",
    (await api("GET", `/api/collections/cycles/records/${plain.id}?workspace=`, carol))[0],
    404,
  );

  // Neither carries a `workspace` query, so both read the param as unset.
  console.log("\n── realtime and expand are unaffected ──");
  const one = new roomkit.SSEListener(BASE_URL, carol, `cycles/${plain.id}`);
  check("Carol's realtime reader connects", truthy(await one.start()), true);
  await Bun.sleep(800);
  await api("PATCH", `/api/collections/cycles/records/${plain.id}`, bob, { name: "rt rename" });
  await Bun.sleep(1200);
  check("a record-topic subscriber still receives the update", one.absent_count(), 1);
  one.stop = true;
  const proj = await first("projects", `workspace="${WB}" && shadow=false`, bob);
  const st = await first("statuses", `workspace="${WB}"`, bob);
  const [ts, task] = await api("POST", "/api/collections/tasks/records", bob, {
    title: "cycle holder",
    project: proj?.id,
    status: st?.id,
    cycle: plain.id,
  });
  check("(fixture) Bob creates a task on the B cycle", ts, 200);
  const [, got] = await api("GET", `/api/collections/tasks/records/${task.id}?expand=cycle`, carol);
  check("expanding the task's cycle still resolves it", got.expand?.cycle?.id ?? null, plain.id);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n❌ ${failures} path-scope check(s) failed`);
  process.exit(1);
}
console.log("\n✅ every path-scope proof passed");

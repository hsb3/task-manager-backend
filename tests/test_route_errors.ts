#!/usr/bin/env bun
/**
 * Every error status the route registry documents (pb_hooks/lib/routes.js `responses`) is provoked live, and its body
 * is the shared Error body {status, message, data}; a documented status with no recipe, or a recipe for an undocumented one, fails.
 * Also provokes the malformed-JSON-body answer openapi.json's info states.
 *
 * Fully self-contained clean-room server. Port 8195 + PB_PORT_OFFSET. INSPIRE_UPSTREAM_URL aims at a closed port.
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const ROUTES: Record<string, any> = createRequire(import.meta.url)(
  path.join(REPO_ROOT, "pb_hooks/lib/routes.js"),
).ROUTES;

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8195 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}${ok || !detail ? "" : ` → ${detail}`}`);
}

async function call(
  method: string,
  url: string,
  token: string | null = null,
  body: any = null,
  raw: string | null = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: raw ?? (body !== null ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {}
  return [r.status, json];
}

const is_error = (code: number, b: any): boolean =>
  !!b &&
  b.status === code &&
  typeof b.message === "string" &&
  !!b.data &&
  typeof b.data === "object" &&
  !Array.isArray(b.data);

type Ctx = Record<string, string>;
type Recipe = ((c: Ctx) => Promise<[number, any]>) | { skip: string };

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-route-errors-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(path.join(REPO_ROOT, "pb_migrations"), MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR))
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));

let server: roomkit.Room | null = null;
const t0 = Date.now();
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
  // roomkit.serve() inherits process.env; restored so the var reaches only the child.
  const saved = process.env.INSPIRE_UPSTREAM_URL;
  process.env.INSPIRE_UPSTREAM_URL = "http://127.0.0.1:1/api/random";
  try {
    server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  } finally {
    if (saved === undefined) delete process.env.INSPIRE_UPSTREAM_URL;
    else process.env.INSPIRE_UPSTREAM_URL = saved;
  }

  console.log(
    "bounded: one cause provoked per documented status; a body is checked on its top-level keys",
  );
  console.log("\n── fixtures: Alice (owner of her workspace and of a trashed one), Bob, Dave ──");
  const [, su_r] = await call("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su: string = su_r.token;
  if (!su) throw new roomkit.SystemExit(`superuser auth failed: ${py_repr(su_r)}`);
  const ctx: Ctx = { su };
  for (const name of ["Alice", "Bob", "Dave"]) {
    const email = `${name.toLowerCase()}@example.com`;
    const [s, u] = await call("POST", "/api/collections/users/records", su, {
      email,
      password: "test123456",
      passwordConfirm: "test123456",
      name,
      verified: true,
      approved: true,
    });
    check(`fixture ${name} created`, s === 200, py_repr(u));
    const [, a] = await call("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: "test123456",
    });
    ctx[name] = a.token;
    ctx[`${name}_id`] = u.id;
  }
  let [s, r] = await call("GET", "/api/collections/workspaces/records", ctx.Alice);
  ctx.ws = r.items?.[0]?.id;
  check("Alice has a provisioned workspace", !!ctx.ws, py_repr(r));
  [s, r] = await call("POST", "/api/collections/workspaces/records", ctx.Alice, {
    name: "Doomed",
    owner: ctx.Alice_id,
  });
  ctx.trashed_ws = r.id;
  [s] = await call("DELETE", `/api/collections/workspaces/records/${ctx.trashed_ws}`, ctx.Alice);
  check("Alice's second workspace is in the trash", s === 204, String(s));

  /** Set an app_settings value by key, creating the row when absent. */
  async function setting(key: string, value: number): Promise<void> {
    const [, l] = await call(
      "GET",
      `/api/collections/app_settings/records?filter=${encodeURIComponent(`key = "${key}"`)}`,
      su,
    );
    const id = l.items?.[0]?.id;
    const [st] = id
      ? await call("PATCH", `/api/collections/app_settings/records/${id}`, su, { value })
      : await call("POST", "/api/collections/app_settings/records", su, { key, value });
    check(`(fixture) ${key} set to ${value}`, st === 200, String(st));
  }
  const invite = (c: Ctx, email: string) =>
    call("POST", `/api/tracker/workspaces/${c.ws}/resolve-member-email`, c.Alice, { email });
  const mine = async (tok: string): Promise<string> =>
    (await call("GET", "/api/tracker/invitations/mine", tok))[1].items?.[0]?.id ?? "none";

  /** Make every listed write on `table` fail at the database, run fn, drop the triggers; the schema must read the same afterwards. */
  async function withDbFailure(
    coll: string,
    table: string,
    ops: string[],
    fn: () => Promise<[number, any]>,
  ) {
    const strip = (c: any) => JSON.stringify({ ...c, updated: undefined });
    const before = strip((await call("GET", `/api/collections/${coll}`, ctx.su))[1]);
    const db = new Database(path.join(DATA_DIR, "data.db"));
    try {
      for (const op of ops)
        db.run(
          `CREATE TRIGGER zz_probe_${op} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'probe db failure'); END`,
        );
      return await fn();
    } finally {
      for (const op of ops) db.run(`DROP TRIGGER IF EXISTS zz_probe_${op}`);
      const left = db.query("SELECT name FROM sqlite_master WHERE name LIKE 'zz_probe_%'").all();
      db.close();
      const after = strip((await call("GET", `/api/collections/${coll}`, ctx.su))[1]);
      check(
        `(fixture) ${table} triggers dropped, ${coll} schema identical`,
        !left.length && before === after,
      );
    }
  }
  // PB writes logs in a batch, so the line is polled for.
  const logged = async (needle: string, times = 1): Promise<boolean> => {
    for (let i = 0; i < 20; i++) {
      const [, l] = await call("GET", "/api/logs?perPage=200&filter=level%20%3E%3D%208", ctx.su);
      const n = (l.items ?? []).filter((x: any) => String(x.message).includes(needle)).length;
      if (n >= times) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
  const RECIPES: Record<string, Record<string, Recipe>> = {
    "GET /api/tracker/admin/pending-users": {
      404: (c) => call("GET", "/api/tracker/admin/pending-users", c.Alice),
    },
    "POST /api/tracker/admin/pending-users/{id}/approve": {
      404: (c) => call("POST", `/api/tracker/admin/pending-users/${c.Bob_id}/approve`, c.Alice),
    },
    "POST /api/tracker/export": {
      400: (c) => call("POST", "/api/tracker/export", c.Alice, {}),
      404: (c) => call("POST", "/api/tracker/export", c.Alice, { workspace: "nope" }),
    },
    "GET /api/tracker/keys": {
      403: async (c) => {
        const [, k] = await call("POST", "/api/collections/api_keys/records", c.Alice, {
          name: "plain",
          scope: "read",
        });
        return call("GET", "/api/tracker/keys", k.key);
      },
    },
    "POST /api/tracker/keys/{id}/revoke": {
      403: async (c) => {
        const [, k] = await call("POST", "/api/collections/api_keys/records", c.Alice, {
          name: "plain",
          scope: "read",
        });
        return call("POST", `/api/tracker/keys/${k.id}/revoke`, k.key);
      },
      404: (c) => call("POST", "/api/tracker/keys/nope/revoke", c.Alice),
    },
    "GET /api/tracker/inspire": {
      502: (c) => call("GET", "/api/tracker/inspire", c.Alice),
    },
    "POST /api/tracker/invitations/{id}/accept": {
      403: (c) => call("POST", "/api/tracker/invitations/nope/accept", c.su),
      404: (c) => call("POST", "/api/tracker/invitations/nope/accept", c.Alice),
      410: async (c) => {
        await invite(c, "dave@example.com");
        await setting("invitation_expiry_days", 0);
        try {
          return await call(
            "POST",
            `/api/tracker/invitations/${await mine(c.Dave)}/accept`,
            c.Dave,
          );
        } finally {
          await setting("invitation_expiry_days", 7);
        }
      },
    },
    "POST /api/tracker/invitations/{id}/decline": {
      404: (c) => call("POST", "/api/tracker/invitations/nope/decline", c.Alice),
    },
    "GET /api/tracker/project-items/counts": {
      400: (c) => call("GET", "/api/tracker/project-items/counts?group=nope", c.Alice),
      500: async (c) => {
        const [, col] = await call("GET", "/api/collections/project_items", c.su);
        const [st] = await call("PATCH", "/api/collections/project_items", c.su, { listRule: "" });
        check("(fixture) project_items listRule emptied", st === 200, String(st));
        try {
          return await call("GET", "/api/tracker/project-items/counts?group=status", c.Alice);
        } finally {
          const [back] = await call("PATCH", "/api/collections/project_items", c.su, {
            listRule: col.listRule,
          });
          check("(fixture) project_items listRule restored", back === 200, String(back));
        }
      },
    },
    "GET /api/tracker/search": {
      400: (c) => call("GET", "/api/tracker/search?q=x&workspace=", c.Alice),
    },
    "GET /api/tracker/trash": {
      400: (c) => call("GET", "/api/tracker/trash", c.Alice),
      403: (c) => call("GET", `/api/tracker/trash?workspace=${c.ws}`, c.su),
      404: async (c) => {
        // a trashed workspace and an unknown id share the one 404; the first to differ is reported
        const trashed = await call("GET", `/api/tracker/trash?workspace=${c.trashed_ws}`, c.Alice);
        if (trashed[0] !== 404) return trashed;
        return call("GET", "/api/tracker/trash?workspace=nope", c.Alice);
      },
      500: async (c) => {
        const q = (coll: string) =>
          call(
            "GET",
            `/api/collections/${coll}/records?filter=${encodeURIComponent(`workspace = "${c.ws}"`)}`,
            c.Alice,
          );
        const [, projects] = await q("projects");
        const [, statuses] = await q("statuses");
        const [mk, task] = await call("POST", "/api/collections/tasks/records", c.Alice, {
          title: "trash 500 fixture",
          project: projects.items?.[0]?.id,
          status: statuses.items?.[0]?.id,
        });
        check("(fixture) task created", mk === 200, py_repr(task));
        const [, col] = await call("GET", "/api/collections/project_items", c.su);
        // PB validates a view by running it, so it is rigged while no row is trashed
        const boom =
          "abs(CASE WHEN u.trashed != '' THEN -9223372036854775808 ELSE 0 END) AS boom, ";
        const viewQuery = col.viewQuery.replace(/^(\s*SELECT\s+)/i, `$1${boom}`);
        const [st, pr] = await call("PATCH", "/api/collections/project_items", c.su, { viewQuery });
        check("(fixture) project_items viewQuery rigged", st === 200, py_repr(pr));
        try {
          const [del] = await call("DELETE", `/api/collections/tasks/records/${task.id}`, c.Alice);
          check("(fixture) task trashed", del === 204, String(del));
          return await call(
            "GET",
            `/api/tracker/trash?workspace=${c.ws}&filter=${encodeURIComponent('title != ""')}`,
            c.Alice,
          );
        } finally {
          const [back] = await call("PATCH", "/api/collections/project_items", c.su, {
            viewQuery: col.viewQuery,
          });
          check("(fixture) project_items viewQuery restored", back === 200, String(back));
        }
      },
    },
    "GET /api/tracker/users/{id}/settings": {
      404: (c) => call("GET", `/api/tracker/users/${c.Bob_id}/settings`, c.Alice),
    },
    "PATCH /api/tracker/users/{id}/settings": {
      400: (c) => call("PATCH", `/api/tracker/users/${c.Alice_id}/settings`, c.Alice, {}),
      403: (c) =>
        call("PATCH", `/api/tracker/users/${c.Alice_id}/settings`, c.su, { theme: "dark" }),
      404: (c) =>
        call("PATCH", `/api/tracker/users/${c.Bob_id}/settings`, c.Alice, { theme: "dark" }),
    },
    "GET /api/tracker/workspaces/{id}/deletion-impact": {
      404: (c) => call("GET", `/api/tracker/workspaces/${c.ws}/deletion-impact`, c.Bob),
    },
    "POST /api/tracker/workspaces/{id}/resolve-member-email": {
      400: async (c) => {
        // a field validation failure keeps its 400 and names the field
        const [ls, lb] = await invite(c, `${"a".repeat(6000)}@example.com`);
        check(
          "an over-long email → 400 naming the email field",
          ls === 400 && lb.data?.email?.code === "validation_max_text_constraint",
          `${ls} ${py_repr(lb)}`,
        );
        return invite(c, "");
      },
      404: (c) =>
        call("POST", "/api/tracker/workspaces/nope/resolve-member-email", c.Alice, {
          email: "x@y",
        }),
      409: async (c) => {
        await invite(c, "bob@example.com");
        await call("POST", `/api/tracker/invitations/${await mine(c.Bob)}/decline`, c.Bob);
        return invite(c, "bob@example.com");
      },
      429: async (c) => {
        await setting("invitation_mint_limit_per_day", 0);
        try {
          return await invite(c, "zed@example.com");
        } finally {
          await setting("invitation_mint_limit_per_day", 50);
        }
      },
      500: async (c) => {
        const r = await withDbFailure(
          "workspace_invitations",
          "workspace_invitations",
          ["INSERT"],
          () => invite(c, "erin-new@example.com"),
        );
        check(
          "  … and the cause is logged",
          await logged("resolve-member-email invitation save failed"),
        );
        return r;
      },
    },
    "POST /api/tracker/workspaces/{id}/transfer-ownership": {
      400: (c) => call("POST", `/api/tracker/workspaces/${c.ws}/transfer-ownership`, c.Alice, {}),
      404: (c) =>
        call("POST", "/api/tracker/workspaces/nope/transfer-ownership", c.Alice, {
          user: c.Bob_id,
        }),
      500: async (c) => {
        const email = "erin@example.com";
        const [, u] = await call("POST", "/api/collections/users/records", c.su, {
          email,
          password: "test123456",
          passwordConfirm: "test123456",
          name: "Erin",
          verified: true,
          approved: true,
        });
        const [, a] = await call("POST", "/api/collections/users/auth-with-password", null, {
          identity: email,
          password: "test123456",
        });
        await invite(c, email);
        const [acc] = await call(
          "POST",
          `/api/tracker/invitations/${await mine(a.token)}/accept`,
          a.token,
        );
        check("(fixture) Erin is an active member", acc === 200, String(acc));
        const go = () =>
          call("POST", `/api/tracker/workspaces/${c.ws}/transfer-ownership`, c.Alice, {
            user: u.id,
          });
        const r = await withDbFailure("projects", "projects", ["UPDATE"], go);
        check("  … and the cause is logged", await logged("POST transfer-ownership failed"));
        // a roster write failing inside the transaction is the route's own failure: its message, its log line
        const [ms, mb] = await withDbFailure(
          "workspace_members",
          "workspace_members",
          ["INSERT", "UPDATE"],
          go,
        );
        check(
          "  … a failing membership save → 500 with the route's own message",
          ms === 500 &&
            is_error(500, mb) &&
            mb.message === "The ownership could not be transferred.",
          `${ms} ${py_repr(mb)}`,
        );
        check(
          "  … and the route logs it as its own failure",
          await logged("POST transfer-ownership failed", 2),
        );
        // a collection write failing at the database answers 500 too
        const [, mem] = await call(
          "GET",
          `/api/collections/workspace_members/records?filter=${encodeURIComponent(`user = "${u.id}"`)}`,
          c.Alice,
        );
        const [ps, pb] = await withDbFailure(
          "workspace_members",
          "workspace_members",
          ["UPDATE"],
          () =>
            call(
              "PATCH",
              `/api/collections/workspace_members/records/${mem.items?.[0]?.id}`,
              c.Alice,
              { status: "suspended" },
            ),
        );
        check(
          "PATCH workspace_members on a database failure → 500 Error body",
          ps === 500 && is_error(500, pb),
          `${ps} ${py_repr(pb)}`,
        );
        return r;
      },
    },
    "POST /api/tracker/workspaces/{id}/vocab": {
      400: (c) =>
        call("POST", `/api/tracker/workspaces/${c.ws}/vocab`, c.Alice, {
          statuses: [{ name: "x", off_pipeline: true }],
        }),
      404: (c) => call("POST", "/api/tracker/workspaces/nope/vocab", c.Alice, {}),
    },
  };

  console.log("\n── every documented status is provoked live; its body is the Error body ──");
  const bounds: string[] = [];
  for (const [key, spec] of Object.entries(ROUTES).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (spec.internal === true) continue;
    const documented = (spec.responses ?? {}) as Record<string, string>;
    const recipes = RECIPES[key] ?? {};
    for (const status of Object.keys(recipes))
      if (!(status in documented))
        check(
          `${key} ${status}: a recipe exists, so the registry documents it`,
          false,
          "undocumented",
        );
    for (const status of Object.keys(documented)) {
      const recipe = recipes[status];
      if (!recipe) {
        check(`${key} ${status}: has a live recipe`, false, "no recipe");
        continue;
      }
      if ("skip" in recipe) {
        bounds.push(`${key} ${status}: ${recipe.skip}`);
        console.log(`  --  BOUND  ${key} ${status}: not provoked — ${recipe.skip}`);
        continue;
      }
      const [got, body] = await recipe(ctx);
      const code = Number(status);
      check(
        `${key} ${status} → ${got} Error body`,
        got === code && is_error(code, body),
        `${got} ${py_repr(body)}`,
      );
    }
  }

  console.log("\n── a body that is not valid JSON (as openapi.json's info states it) ──");
  const GENERIC = "Something went wrong while processing your request.";
  for (const [method, url, tok] of [
    ["POST", "/api/tracker/export", ctx.Alice],
    ["PATCH", `/api/tracker/users/${ctx.Alice_id}/settings`, ctx.Alice],
    ["POST", "/api/collections/tasks/records", ctx.Alice],
  ] as const) {
    const [got, body] = await call(method, url, tok, null, "{");
    check(
      `${method} ${url} with body { → 400 "${GENERIC}", empty data`,
      got === 400 &&
        is_error(400, body) &&
        body.message === GENERIC &&
        !Object.keys(body.data).length,
      `${got} ${py_repr(body)}`,
    );
  }
  const [got, body] = await call(
    "POST",
    "/api/collections/users/auth-with-password",
    null,
    null,
    "{",
  );
  check(
    'users password sign-in with body { → 400 "An error occurred while loading the submitted data."',
    got === 400 &&
      is_error(400, body) &&
      body.message === "An error occurred while loading the submitted data.",
    `${got} ${py_repr(body)}`,
  );
  if (bounds.length) console.log(`\n  declared bounds (not proven live): ${bounds.length}`);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log(`\n  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ every documented route error was provoked live");
  process.exit(0);
}

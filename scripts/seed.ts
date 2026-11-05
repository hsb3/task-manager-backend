#!/usr/bin/env bun
/**
 * Seed the task-tracker: user -> workspace -> project -> task, plus a milestone,
 * subtasks, and a comment. Runs as superuser (collections are owner-only).
 */

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  os_error_text,
  py_int,
  py_repr,
  py_strip,
  read_text,
  splitlines,
  url_error_reason,
} from "./_py.ts";
import { pb_bin_path } from "./pb_migrate.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));

let PB: string | null = null; // set inside main(), after load_env() — importing this file makes no network call

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function environ(k: string): string {
  const v = process.env[k];
  if (v === undefined) throw new Error(`KeyError: '${k}'`);
  return v;
}

// Load PB_* vars from the gitignored .env so no secret is hard-coded here.
function load_env(file = ".env"): void {
  if (fs.existsSync(file)) {
    for (let line of splitlines(read_text(file))) {
      line = py_strip(line);
      if (line && !line.startsWith("#") && line.includes("=")) {
        const i = line.indexOf("=");
        const k = line.slice(0, i);
        if (!(k in process.env)) process.env[k] = line.slice(i + 1);
      }
    }
  }
}

// Non-2xx exits here unless allow_error: an error dict returned as data flows on into the
// next request's URL and dies 80 lines later inside fetch.
async function api(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
  allow_error = false,
): Promise<any> {
  const data = body !== null ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  let r: Response;
  try {
    r = await fetch(PB + path, { method, body: data, headers });
  } catch (e: any) {
    if (e?.code === "ERR_INVALID_URL") throw e;
    const reason = url_error_reason(e);
    die(`seed failed: no server at ${PB} (${reason})`);
  }
  if (!r.ok) {
    const detail = py_strip(await r.text());
    if (allow_error) return { _error: r.status, _body: detail };
    die(`seed failed: ${method} ${path} -> ${r.status} ${detail}`);
  }
  return await r.json();
}

// _superusers has MFA on: password auth alone 401s with {mfaId}; fallback mints an
// OTP via the CLI (local pb_data only — battery rooms drop the MFA migration and skip this).
async function superuser_token(): Promise<string> {
  let r = await api(
    "POST",
    "/api/collections/_superusers/auth-with-password",
    null,
    {
      identity: environ("PB_SUPERUSER_EMAIL"),
      password: environ("PB_SUPERUSER_PASSWORD"),
    },
    true, // a 401 here carries the mfaId the OTP fallback needs
  );
  if (Object.hasOwn(r, "token")) return r.token;
  let mfa_id: any = null;
  if (r._error === 401) {
    try {
      mfa_id = JSON.parse(r._body).mfaId;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  if (!mfa_id) die(`superuser auth failed: ${py_repr(r)}`);
  // PB_BINARY is the retired spelling of PB_BIN, still read (only when PB_BIN is unset) so an
  // existing .env keeps working; feeding it into PB_BIN routes it through the one resolver.
  if (!process.env.PB_BIN && process.env.PB_BINARY) {
    process.env.PB_BIN = process.env.PB_BINARY;
  }
  const pb_bin = pb_bin_path(REPO_ROOT);
  const pb_dir = process.env.PB_DATA_DIR ?? "pb_data";
  let out;
  try {
    out = Bun.spawnSync(
      [pb_bin, "superuser", "otp", environ("PB_SUPERUSER_EMAIL"), "--dir", pb_dir],
      { env: process.env },
    );
  } catch (e: any) {
    const strerror = os_error_text(e, null).replace(/^\[Errno \d+\] /, "");
    die(
      `seed: superuser MFA is on and the OTP fallback needs the PocketBase CLI, but ` +
        `${py_repr(pb_bin)} is not runnable (${strerror}) — set PB_BIN to a pocketbase binary ` +
        `(the OTP is minted against the HOST data dir ${py_repr(pb_dir)}, never a container ` +
        `volume), or seed a containerised server with \`make compose-dev\`, which runs ` +
        `with MFA off.`,
    );
  }
  const stdout = out.stdout.toString();
  const stderr = out.stderr.toString();
  const m = /Id:\s+(\S+).*?Pass:\s+(\S+)/s.exec(stdout + stderr);
  if (!m) die(`MFA is on but no local OTP could be minted via the CLI: ${stderr || stdout}`);
  r = await api("POST", "/api/collections/_superusers/auth-with-otp", null, {
    otpId: m[1],
    mfaId: mfa_id,
    password: m[2],
  });
  if (!Object.hasOwn(r, "token")) die(`auth-with-otp failed: ${py_repr(r)}`);
  return r.token;
}

async function main(): Promise<void> {
  load_env();
  const port_offset = py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
  PB = process.env.PB_URL ?? `http://127.0.0.1:${8090 + port_offset}`;

  const tok = await superuser_token();

  // Wrong-PB_URL guard: refuse before the first write if the target already holds users.
  const existing =
    (await api("GET", "/api/collections/users/records?perPage=1", tok)).totalItems ?? 0;
  if (existing) {
    die(
      `seed: refusing — ${PB} already has ${existing} users and this script is append-only` +
        " (wrong PB_URL? `make reset` wipes local pb_data for a fresh boot + seed).",
    );
  }

  // App users — Carol is the NON-MEMBER of Alice's workspace, used to prove that
  // membership (not just auth) gates access.
  const users: Record<string, string> = {};
  for (const [name, email] of [
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
    ["Carol", "carol@example.com"],
  ] as const) {
    const r = await api(
      "POST",
      "/api/collections/users/records",
      tok,
      {
        email: email,
        password: "test123456",
        passwordConfirm: "test123456",
        name: name,
        verified: true,
        // approved: superuser-only gate — seeds must self-approve (they postdate the backfill)
        approved: true,
      },
      true,
    );
    if (Object.hasOwn(r, "_error")) {
      if (r._body.includes("validation_not_unique")) {
        die(
          `seed: ${email} already exists — this DB is already seeded and this script` +
            " is append-only. `make reset` wipes pb_data for a fresh boot + seed.",
        );
      }
      die(`seed: creating ${email} failed: ${r._error} ${r._body}`);
    }
    users[name] = r.id;
    console.log(`user ${name}: ${users[name]}`);
  }

  // Workspaces are auto-provisioned by the users create-hook; read back and RENAME
  // rather than create, to avoid a duplicate workspace+membership per user.
  const workspaces: Record<string, string> = {};
  for (const name of ["Alice", "Bob", "Carol"]) {
    const found = await api(
      "GET",
      `/api/collections/workspaces/records?filter=(owner='${users[name]}')&perPage=1`,
      tok,
    );
    const items = found.items;
    if (!items?.length) {
      die(
        `expected an auto-provisioned workspace for ${name} (${users[name]}) but found none: ${py_repr(found)}`,
      );
    }
    const ws_id = items[0].id;
    // the provision hook seeds statuses, labels and the priority vocabulary; only the name
    // is patched here.
    const r = await api("PATCH", `/api/collections/workspaces/records/${ws_id}`, tok, {
      name: `${name}'s Workspace`,
    });
    workspaces[name] = r.id;
    console.log(`workspace ${name}: ${workspaces[name]} (auto-provisioned, renamed)`);
  }

  // Cross-membership: Bob is a NON-OWNER member of Alice's workspace (a task's
  // assignee must be a member).
  const m = await api("POST", "/api/collections/workspace_members/records", tok, {
    workspace: workspaces.Alice,
    user: users.Bob,
    // Both are required. "invited-then-accepted" ends at active; `member` because
    // `viewer` is read-only (flips every write-path fixture) and `admin` would hand a
    // plain cross-member admin authority.
    role: "member",
    status: "active",
  });
  console.log(`  cross-member Bob@Alice's: ${m.id}`);

  // Projects, scoped to a workspace — like workspaces above, auto-provisioned by the
  // users create-hook; read back and RENAME rather than create, to avoid a duplicate
  // project per owner.
  const projects: Record<string, string> = {};
  const proj_ws: Record<string, string> = {}; // project name -> owning workspace id (needed to resolve a task's status id)
  for (const [pname, owner] of [
    ["Website Redesign", "Alice"],
    ["Mobile App", "Bob"],
  ] as const) {
    // shadow=false (%26%26 is && in a raw query string): the invisible per-workspace
    // container is provisioned first, so an unfiltered find-first renames THAT.
    const found = await api(
      "GET",
      `/api/collections/projects/records` +
        `?filter=(workspace='${workspaces[owner]}'%26%26shadow=false)&perPage=1`,
      tok,
    );
    const items = found.items;
    if (!items?.length) {
      die(
        `expected an auto-provisioned project for ${owner} (ws ${workspaces[owner]}) but found none: ${py_repr(found)}`,
      );
    }
    const proj_id = items[0].id;
    const r = await api("PATCH", `/api/collections/projects/records/${proj_id}`, tok, {
      name: pname,
      description: `${pname} project`,
    });
    projects[pname] = r.id;
    proj_ws[pname] = workspaces[owner]!;
    console.log(`project ${py_repr(pname)}: ${projects[pname]} (auto-provisioned, renamed)`);
  }

  // tasks.status is a relation to the statuses collection (seeded per workspace); build
  // a {lowercased name -> id} map to translate the fixture words (todo/doing/done).
  const STATUS_ALIAS: Record<string, string> = { todo: "Todo", doing: "In Progress", done: "Done" };
  const status_by_ws: Record<string, Record<string, string>> = {};
  for (const _wsid of Object.values(workspaces)) {
    const _items: any[] =
      (
        await api(
          "GET",
          `/api/collections/statuses/records?filter=(workspace='${_wsid}')&perPage=50`,
          tok,
        )
      ).items ?? [];
    status_by_ws[_wsid] = Object.fromEntries(_items.map((it) => [it.name.toLowerCase(), it.id]));
  }

  /**
   * Resolve a fixture status word (todo/doing/done) to the status relation id in the
   * workspace owning `proj_name`.
   */
  const status_id = (proj_name: string, text: string): string => {
    const wsid = proj_ws[proj_name]!;
    const key = (STATUS_ALIAS[text] ?? text).toLowerCase();
    const id = status_by_ws[wsid]![key];
    if (id === undefined) throw new Error(`KeyError: ${py_repr(key)}`);
    return id;
  };

  // A milestone in Alice's workspace
  const milestone = await api("POST", "/api/collections/milestones/records", tok, {
    name: "v1 launch",
    description: "Ship the first public version",
    workspace: workspaces.Alice,
    // Named, not defaulted: an omitted project now lands in the invisible workspace
    // container, and the tasks below name this project.
    project: projects["Website Redesign"],
  });
  const milestone_id = milestone.id;
  console.log(`milestone: ${milestone_id}`);

  // Tasks (status validated against the workspace statuses by the hook)
  const tasks: Record<string, string> = {};
  const task_defs: [string, string, string, string | null][] = [
    ["Design homepage", "doing", "Website Redesign", "Alice"],
    ["Wire up nav", "todo", "Website Redesign", "Bob"],
    ["Ship landing page", "done", "Website Redesign", "Alice"],
    ["Set up CI", "todo", "Mobile App", "Bob"],
    ["Draft onboarding", "doing", "Mobile App", null], // unassigned
  ];
  for (const [i, [title, status, proj, assignee]] of task_defs.entries()) {
    const body: Record<string, any> = {
      title: title,
      status: status_id(proj, status),
      project: projects[proj],
      ordinal: i,
    };
    if (proj === "Website Redesign") body.milestone = milestone_id;
    if (assignee) body.assignee = users[assignee];
    const r = await api("POST", "/api/collections/tasks/records", tok, body);
    tasks[title] = r.id;
    console.log(`task ${py_repr(title)}: ${tasks[title]}`);
  }

  // Two subtasks under "Design homepage" (parent self-relation, fractional order)
  for (const [i, sub] of ["Pick a color palette", "Draft the hero section"].entries()) {
    const r = await api("POST", "/api/collections/tasks/records", tok, {
      title: sub,
      status: status_id("Website Redesign", "todo"),
      project: projects["Website Redesign"],
      parent: tasks["Design homepage"],
      // Explicitly Alice's: decision:tasks-have-no-default-assignee removed create-time defaulting.
      assignee: users.Alice,
      ordinal: 0.5 + i * 0.1,
      acceptanceCriteria: [{ text: "reviewed", done: false }],
    });
    console.log(`  subtask ${py_repr(sub)}: ${r.id}`);
  }

  // A comment on a task
  const c = await api("POST", "/api/collections/comments/records", tok, {
    task: tasks["Design homepage"],
    author: users.Alice,
    body: "Starting with the mobile layout first.",
  });
  console.log(`comment: ${c.id}`);

  console.log("\nSeed complete.");
}

if (import.meta.main) {
  const prog = path.basename(import.meta.path);
  const usage = `usage: ${prog} [-h]`;
  parse_args(
    usage,
    `${usage}\n\nSeed the task-tracker: user -> workspace -> project -> task, plus a milestone,\n` +
      `subtasks, and a comment. Runs as superuser (collections are owner-only).\n\n` +
      `options:\n  -h, --help  show this help message and exit\n`,
    [],
    {},
  );
  await main();
}

#!/usr/bin/env bun
/**Proof that trashing a workspace DROPS the notifications about its work, for good.

Owner ruling 2026-09-07 (card rdmq, prior art Linear): a notification about work in a trashed
workspace does not sit hidden-but-undismissable behind the notifications read rule — the
workspace-trash arm in pb_hooks/trash.pb.js deletes those rows, and restoring the workspace
brings none of them back. A notification in another, still-live workspace is the control that
makes every "gone" assertion falsifiable.

Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures built by name.
Port 8142 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  by_code_point,
  getitem,
  py_repr,
  run_checked,
  tup,
  truthy,
  urlencode,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { stop_server } from "./suitekit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8142 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";
const TRASH_TS = "2026-09-07 00:00:00.000Z"; // PocketBase date wire format, not ISO with a T

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(66)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  let r: Response;
  let raw: string;
  try {
    r = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    raw = await r.text();
  } catch (e) {
    return roomkit.die_no_server(BASE_URL, e);
  }
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

function start_server(data_dir: string, migrations_dir: string): Promise<roomkit.Room> {
  return roomkit.serve(PORT, data_dir, migrations_dir, roomkit.hooks_dir(S));
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-notif-trash-cascade-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log(
    "═══════ test_notifications_trash_cascade.ts — workspace trash drops notifications ═══════",
  );
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
  server = await start_server(DATA_DIR, MIG_DIR);
  let s: number;
  let r: any;
  [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const su = roomkit.token_of(BASE_URL, SU_EMAIL, r);

  // ── fixtures: owner, active member, and a SECOND live workspace as the control ──
  console.log("\n── fixtures ──");

  async function make_user(name: string, email: string): Promise<[string, string]> {
    // `approved` as well as `verified`: without it auth-with-password answers 403.
    const [s, rec] = await api("POST", "/api/collections/users/records", su, {
      email: email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name: name,
      verified: true,
      approved: true,
    });
    if (s !== 200 && s !== 201) {
      throw new roomkit.SystemExit(
        `❌ fixture user ${email} not created: HTTP ${s} ${py_repr(rec)}`,
      );
    }
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    return [roomkit.token_of(BASE_URL, email, auth), getitem(rec, "id")];
  }

  const [olive, olive_id] = await make_user("Olive", "olive@example.com");
  const [mia, mia_id] = await make_user("Mia", "mia@example.com");
  check("two fixture users exist", truthy(olive_id) && truthy(mia_id), true);

  async function make_workspace(name: string): Promise<[string, string]> {
    let [s, ws] = await api("POST", "/api/collections/workspaces/records", olive, {
      name: name,
      owner: olive_id,
    });
    check(`Olive creates workspace ${name}`, s, 200);
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: getitem(ws, "id"),
      user: mia_id,
      role: "member",
      status: "active",
    });
    check(`Mia joins ${name} as an ACTIVE member`, s, 200);
    let proj: any;
    [s, proj] = await api("POST", "/api/collections/projects/records", olive, {
      name: `${name}-project`,
      owner: olive_id,
      workspace: getitem(ws, "id"),
    });
    check(`Olive creates a project in ${name}`, s, 200);
    return [getitem(ws, "id"), getitem(proj, "id")];
  }

  // Two workspaces, same roster, same shape: one gets trashed, one stays live.
  const [WS, PROJECT] = await make_workspace("doomedws");
  const [CONTROL_WS, CONTROL_PROJECT] = await make_workspace("controlws");

  /** A task Olive creates and assigns to Mia -> one {Mia, assigned} notification. */
  async function notified_task(project_id: string, title: string): Promise<string> {
    let [s, task] = await api("POST", "/api/collections/tasks/records", olive, {
      title: title,
      project: project_id,
    });
    check(`Olive creates task ${title}`, s, 200);
    [s] = await api("PATCH", `/api/collections/tasks/records/${getitem(task, "id")}`, olive, {
      assignee: mia_id,
    });
    check(`Olive assigns ${title} to Mia`, s, 200);
    return getitem(task, "id");
  }

  const TASK = await notified_task(PROJECT, "doomedtask");
  const CONTROL_TASK = await notified_task(CONTROL_PROJECT, "controltask");

  // Olive is subscribed as the task creator, so Mia commenting notifies HER too: the drop
  // must not be recipient-specific.
  [s] = await api("POST", "/api/collections/comments/records", mia, {
    task: TASK,
    author: mia_id,
    body: "a comment that notifies Olive",
  });
  check("Mia comments on the doomed task (notifies Olive)", s, 200);

  /** Every notifications row about a task, read as SUPERUSER (rules cannot hide it). */
  async function rows_for_task(task_id: string) {
    const qs = urlencode({ filter: `task='${task_id}'`, perPage: 200 });
    const [, r] = await api("GET", `/api/collections/notifications/records?${qs}`, su);
    return (r.items ?? [])
      .map((n: any) => tup(getitem(n, "user"), getitem(n, "kind")))
      .sort((a: any, b: any) => by_code_point(a[0], b[0]) || by_code_point(a[1], b[1]));
  }

  async function inbox(token: string): Promise<string[]> {
    const [, r] = await api("GET", "/api/collections/notifications/records?perPage=200", token);
    return (r.items ?? []).map((n: any) => getitem(n, "id"));
  }

  async function row_id(task_id: string, user_id: string): Promise<string | null> {
    const qs = urlencode({ filter: `task='${task_id}' && user='${user_id}'` });
    const [, r] = await api("GET", `/api/collections/notifications/records?${qs}`, su);
    const items = r.items ?? [];
    return items.length ? getitem(items[0], "id") : null;
  }

  // ══════════ (1) BEFORE the trash — the rows that must later be gone ═════════
  console.log("\n── (1) live workspaces: the notifications that exist to begin with ──");
  check(
    "doomed task carries {Mia,assigned} + {Olive,commented}",
    await rows_for_task(TASK),
    [tup(mia_id, "assigned"), tup(olive_id, "commented")].sort(
      (a, b) => by_code_point(a[0], b[0]) || by_code_point(a[1], b[1]),
    ),
  );
  check("control task carries {Mia,assigned}", await rows_for_task(CONTROL_TASK), [
    tup(mia_id, "assigned"),
  ]);
  const MIA_ROW = await row_id(TASK, mia_id);
  const CONTROL_ROW = await row_id(CONTROL_TASK, mia_id);
  check(
    "Mia's inbox lists both of her notifications",
    (await inbox(mia)).sort(by_code_point),
    [MIA_ROW, CONTROL_ROW].sort(by_code_point as (a: any, b: any) => number),
  );
  check("Olive's inbox lists hers", await inbox(olive), [await row_id(TASK, olive_id)]);

  // ══════════ (2) trash the workspace — the rows are DELETED, not hidden ══════
  console.log("\n── (2) owner trashes the workspace: its notifications are dropped ──");
  [s] = await api("DELETE", `/api/collections/workspaces/records/${WS}`, olive);
  check("Olive (owner) DELETEs the workspace → trashed", s, 204);
  check(
    "workspace is trashed, not purged",
    (await api("GET", `/api/collections/workspaces/records/${WS}`, su))[0],
    200,
  );
  check("NO notifications row about the trashed workspace survives", await rows_for_task(TASK), []);
  check(
    "the dropped row answers 404 by id even to a SUPERUSER",
    (await api("GET", `/api/collections/notifications/records/${MIA_ROW}`, su))[0],
    404,
  );
  check(
    "Mia PATCHing the dropped row read=true → 404 (the card falsifier, now on an absent row)",
    (
      await api("PATCH", `/api/collections/notifications/records/${MIA_ROW}`, mia, { read: true })
    )[0],
    404,
  );
  check("Mia's inbox now lists ONLY her control-workspace row", await inbox(mia), [CONTROL_ROW]);
  check("Olive's inbox is empty", await inbox(olive), []);
  check(
    "CONTROL: the live workspace's notification is untouched",
    await rows_for_task(CONTROL_TASK),
    [tup(mia_id, "assigned")],
  );
  check(
    "CONTROL: Mia can still mark that one read",
    (
      await api("PATCH", `/api/collections/notifications/records/${CONTROL_ROW}`, mia, {
        read: true,
      })
    )[0],
    200,
  );
  check(
    "the task itself is untouched by the notification drop",
    (await api("GET", `/api/collections/tasks/records/${TASK}`, su))[0],
    200,
  );

  // ══════════ (3) restore the workspace — nothing comes back ═════════════════
  console.log("\n── (3) restore: the work returns, the notifications do not ──");
  [s] = await api("PATCH", `/api/collections/workspaces/records/${WS}`, olive, { trashed: "" });
  check("Olive restores the workspace → 200", s, 200);
  check(
    "the task is readable by Mia again (the restore really happened)",
    (await api("GET", `/api/collections/tasks/records/${TASK}`, mia))[0],
    200,
  );
  check("STILL no notifications row about it", await rows_for_task(TASK), []);
  check("Mia's inbox after restore is only the control row", await inbox(mia), [CONTROL_ROW]);
  check("Olive's inbox after restore is still empty", await inbox(olive), []);

  // ══════════ (4) the OTHER trash path: a direct PATCH of `trashed` ══════════
  // COVERS: hook:trash.pb.js#onRecordAfterUpdateSuccess:workspaces
  // The DELETE hook trashes with a programmatic save, so a superuser PATCHing
  // `trashed` (the only writer an update may trash for) reaches the same state without it.
  console.log("\n── (4) superuser PATCH-trashes a workspace: the same rows are dropped ──");
  const [PATCH_WS, PATCH_PROJECT] = await make_workspace("patchws");
  const PATCH_TASK = await notified_task(PATCH_PROJECT, "patchtask");
  const PATCH_ROW = await row_id(PATCH_TASK, mia_id);
  check("the PATCH-path task carries {Mia,assigned}", await rows_for_task(PATCH_TASK), [
    tup(mia_id, "assigned"),
  ]);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${PATCH_WS}`, su, {
    trashed: TRASH_TS,
  });
  check("a superuser PATCHes trashed=<timestamp> → 200", s, 200);
  check(
    "the workspace really is trashed",
    (await api("GET", `/api/collections/workspaces/records/${PATCH_WS}`, su))[1].trashed ?? null,
    TRASH_TS,
  );
  check(
    "NO notifications row about the PATCH-trashed workspace survives",
    await rows_for_task(PATCH_TASK),
    [],
  );
  check(
    "the dropped row answers 404 by id even to a SUPERUSER",
    (await api("GET", `/api/collections/notifications/records/${PATCH_ROW}`, su))[0],
    404,
  );
  check("Mia's inbox is back to the control row alone", await inbox(mia), [CONTROL_ROW]);
  [s] = await api("PATCH", `/api/collections/workspaces/records/${PATCH_WS}`, olive, {
    trashed: "",
  });
  check("Olive restores the PATCH-trashed workspace → 200", s, 200);
  check("STILL no notifications row about it", await rows_for_task(PATCH_TASK), []);
  check(
    "the task itself came back",
    (await api("GET", `/api/collections/tasks/records/${PATCH_TASK}`, mia))[0],
    200,
  );
  check(
    "CONTROL: the live workspace's notification survived both trash paths",
    await rows_for_task(CONTROL_TASK),
    [tup(mia_id, "assigned")],
  );

  // ══════════ (5) the WORKSPACE-anchored notice: ownership transfer, DELETE ══
  // COVERS: route:POST /api/tracker/workspaces/{id}/transfer-ownership
  // A transfer notice carries no task, document or decision — only `workspace` — so a
  // cascade filtered on the three item legs alone leaves it behind, readable and
  // dismissable, about a workspace nobody can reach.
  console.log("\n── (5) DELETE-trash drops the ownership-transfer notices too ──");

  /** Every ownership_transferred row anchored on a workspace, as SUPERUSER. */
  async function notices(ws_id: string): Promise<string[]> {
    const qs = urlencode({
      filter: `workspace='${ws_id}' && kind='ownership_transferred'`,
      perPage: 200,
    });
    const [, r] = await api("GET", `/api/collections/notifications/records?${qs}`, su);
    return (r.items ?? []).map((n: any) => getitem(n, "user")).sort(by_code_point);
  }

  async function notice_id(ws_id: string, user_id: string): Promise<string | null> {
    const qs = urlencode({
      filter: `workspace='${ws_id}' && user='${user_id}' && kind='ownership_transferred'`,
    });
    const [, r] = await api("GET", `/api/collections/notifications/records?${qs}`, su);
    const items = r.items ?? [];
    return items.length ? getitem(items[0], "id") : null;
  }

  async function transfer(ws_id: string, token: string, user_id: string): Promise<number> {
    return (
      await api("POST", `/api/tracker/workspaces/${ws_id}/transfer-ownership`, token, {
        user: user_id,
      })
    )[0];
  }

  // The control pair rides the workspace that is never trashed — every "gone" assertion
  // below is falsifiable only because these two stay.
  check(
    "Olive hands the CONTROL workspace to Mia → 200",
    await transfer(CONTROL_WS, olive, mia_id),
    200,
  );
  check(
    "CONTROL: the live workspace carries a notice for each party",
    await notices(CONTROL_WS),
    [olive_id, mia_id].sort(by_code_point),
  );

  const [XFER_WS] = await make_workspace("xferws");
  check("Olive hands xferws to Mia → 200", await transfer(XFER_WS, olive, mia_id), 200);
  check(
    "xferws carries a notice for each party",
    await notices(XFER_WS),
    [olive_id, mia_id].sort(by_code_point),
  );
  const XFER_NOTICE = await notice_id(XFER_WS, olive_id);
  check(
    "the outgoing owner really has it in her inbox",
    (await inbox(olive)).includes(XFER_NOTICE!),
    true,
  );
  [s] = await api("DELETE", `/api/collections/workspaces/records/${XFER_WS}`, mia);
  check("Mia (the NEW owner) DELETEs xferws → trashed", s, 204);
  check(
    "the workspace is trashed, not purged",
    (await api("GET", `/api/collections/workspaces/records/${XFER_WS}`, su))[0],
    200,
  );
  check(
    "NO ownership-transfer notice about the trashed workspace survives",
    await notices(XFER_WS),
    [],
  );
  check(
    "the dropped notice answers 404 by id even to a SUPERUSER",
    (await api("GET", `/api/collections/notifications/records/${XFER_NOTICE}`, su))[0],
    404,
  );
  check(
    "it is gone from the outgoing owner's inbox",
    (await inbox(olive)).includes(XFER_NOTICE!),
    false,
  );
  check(
    "CONTROL: the live workspace's transfer notices are untouched",
    await notices(CONTROL_WS),
    [olive_id, mia_id].sort(by_code_point),
  );

  // ══════════ (6) the same notice on the PATCH trash path ═══════════════════
  // COVERS: hook:trash.pb.js#onRecordAfterUpdateSuccess:workspaces
  console.log("\n── (6) PATCH-trash drops the ownership-transfer notices too ──");
  const [XPATCH_WS] = await make_workspace("xferpatchws");
  check("Olive hands xferpatchws to Mia → 200", await transfer(XPATCH_WS, olive, mia_id), 200);
  check(
    "xferpatchws carries a notice for each party",
    await notices(XPATCH_WS),
    [olive_id, mia_id].sort(by_code_point),
  );
  const XPATCH_NOTICE = await notice_id(XPATCH_WS, mia_id);
  check(
    "the incoming owner really has it in her inbox",
    (await inbox(mia)).includes(XPATCH_NOTICE!),
    true,
  );
  [s] = await api("PATCH", `/api/collections/workspaces/records/${XPATCH_WS}`, su, {
    trashed: TRASH_TS,
  });
  check("a superuser PATCHes trashed=<timestamp> → 200", s, 200);
  check(
    "the workspace really is trashed",
    (await api("GET", `/api/collections/workspaces/records/${XPATCH_WS}`, su))[1].trashed ?? null,
    TRASH_TS,
  );
  check(
    "NO ownership-transfer notice about the PATCH-trashed workspace survives",
    await notices(XPATCH_WS),
    [],
  );
  check(
    "the dropped notice answers 404 by id even to a SUPERUSER",
    (await api("GET", `/api/collections/notifications/records/${XPATCH_NOTICE}`, su))[0],
    404,
  );
  check(
    "it is gone from the incoming owner's inbox",
    (await inbox(mia)).includes(XPATCH_NOTICE!),
    false,
  );
  check(
    "CONTROL: the live workspace's transfer notices survived both trash paths",
    await notices(CONTROL_WS),
    [olive_id, mia_id].sort(by_code_point),
  );

  console.log("\n" + "═".repeat(90));
  console.log(failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`);
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);

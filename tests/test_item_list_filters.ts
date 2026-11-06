#!/usr/bin/env bun
/**
 * The project_items list validates its filter and clamps its paging on the server (pb_hooks/item_list.pb.js).
 *
 * Port 8159 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getitem, py_repr, py_str, run_checked, truthy, urlencode } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8159 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const LIST = "/api/collections/project_items/records";

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
  return [r.status, raw ? JSON.parse(raw) : {}];
}

async function list(
  token: string,
  params: Record<string, string | number>,
): Promise<[number, any]> {
  return api("GET", `${LIST}?${urlencode(params)}`, token);
}

/** (status, the refused field's code) — the shape an agent branches on. */
async function refusal(token: string, filter: string, field: string): Promise<[number, any]> {
  const [s, r] = await list(token, { filter });
  return [s, r?.data?.[field]?.code ?? null];
}

async function login(email: string): Promise<[string, string]> {
  const [, r] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: email,
    password: "test123456",
  });
  return [getitem(r, "token"), getitem(getitem(r, "record"), "id")];
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-item-list-filters-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
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
  if (!truthy(sur.token)) throw new roomkit.SystemExit(`superuser auth failed: ${py_str(sur)}`);
  const su: string = sur.token;

  const seed = Bun.spawnSync([process.execPath, "scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PB_URL: BASE_URL,
      PB_SUPERUSER_EMAIL: SU_EMAIL,
      PB_SUPERUSER_PASSWORD: SU_PASSWORD,
    },
  });
  if (seed.exitCode !== 0) {
    console.log(seed.stdout.toString(), seed.stderr.toString());
    throw new roomkit.SystemExit("seed failed — cannot proceed");
  }

  const [alice, alice_id] = await login("alice@example.com");
  const [bob] = await login("bob@example.com");
  const [, wss] = await api(
    "GET",
    `/api/collections/workspaces/records?${urlencode({ filter: "name='Alice\\'s Workspace'" })}`,
    alice,
  );
  const WS = getitem(wss.items[0], "id");
  // A project of this suite's own, so every count below is exact.
  const [ps, proj] = await api("POST", "/api/collections/projects/records", alice, {
    name: "Filter fixture",
    workspace: WS,
  });
  if (ps !== 200) throw new roomkit.SystemExit(`project create failed: ${py_str(proj)}`);
  const P = proj.id;
  const [, sts] = await api(
    "GET",
    `/api/collections/statuses/records?${urlencode({ filter: `workspace='${WS}'`, sort: "position" })}`,
    alice,
  );
  const [ST_A, ST_B, ST_C] = sts.items.map((x: any) => x.id);
  const DUES = ["2026-01-10 12:00:00.000Z", "2026-02-10 12:00:00.000Z", "2026-03-10 12:00:00.000Z"];
  // 30 tasks: 10 per status, due cycling through DUES; one unassigned, the rest Alice's.
  for (let i = 0; i < 30; i++) {
    const [s, r] = await api("POST", "/api/collections/tasks/records", su, {
      title: `filter task ${i}`,
      workspace: WS,
      project: P,
      status: [ST_A, ST_B, ST_C][i % 3],
      due: DUES[i % 3],
      assignee: i === 0 ? "" : alice_id,
    });
    if (s !== 200) throw new roomkit.SystemExit(`task create failed: ${py_str(r)}`);
  }
  const inP = (f: string) => `project = "${P}" && ${f}`;
  const total = async (token: string, filter: string) => {
    const [s, r] = await list(token, { filter, perPage: 200 });
    return [s, r.totalItems ?? null];
  };

  console.log("\n── an operator its field does not support answers 400 naming the field ──");
  for (const [who, tok] of [
    ["owner", alice],
    ["member", bob],
  ] as const) {
    check(
      `${who}: status ~ "x" → 400 status:operator_not_supported`,
      await refusal(tok, `status ~ "x"`, "status"),
      [400, "operator_not_supported"],
    );
  }
  check(
    `type > "task" → 400 type:operator_not_supported`,
    await refusal(alice, `type > "task"`, "type"),
    [400, "operator_not_supported"],
  );
  check(
    `labels > "x" → 400 labels:operator_not_supported`,
    await refusal(alice, `labels > "x"`, "labels"),
    [400, "operator_not_supported"],
  );
  check(
    `assignee ~ "x" → 400 assignee:operator_not_supported`,
    await refusal(alice, `assignee ~ "x"`, "assignee"),
    [400, "operator_not_supported"],
  );
  check(
    `field on the right: "x" ~ priority → 400 priority:operator_not_supported`,
    await refusal(alice, `"x" ~ priority`, "priority"),
    [400, "operator_not_supported"],
  );
  check(
    `inside a group: (type = "task" || status ~ "x") → 400 status`,
    await refusal(alice, `(type = "task" || status ~ "x")`, "status"),
    [400, "operator_not_supported"],
  );

  console.log("\n── a blank value answers 400 naming the field ──");
  check(`due ~ "" → 400 due:value_required`, await refusal(alice, `due ~ ""`, "due"), [
    400,
    "value_required",
  ]);
  check(`type != '' → 400 type:value_required`, await refusal(alice, `type != ''`, "type"), [
    400,
    "value_required",
  ]);
  check(`labels ~ "" → 400 labels:value_required`, await refusal(alice, `labels ~ ""`, "labels"), [
    400,
    "value_required",
  ]);
  check(`due <= "" → 400 due:value_required`, await refusal(alice, `due <= ""`, "due"), [
    400,
    "value_required",
  ]);

  console.log("\n── a relation path names the field and the id it takes ──");
  const [rs, rr] = await list(alice, { filter: `status.name = "Todo"` });
  check(
    `status.name = "Todo" → 400 status:not_expressible`,
    [rs, rr?.data?.status?.code ?? null],
    [400, "not_expressible"],
  );
  check(
    `… and the message names the statuses collection`,
    /statuses/.test(rr?.data?.status?.message ?? ""),
    true,
  );

  console.log("\n── two clauses whose intersection is empty answer 400 values_conflict ──");
  check(
    `type = "task" && type = "document" → 400 type:values_conflict`,
    await refusal(alice, `type = "task" && type = "document"`, "type"),
    [400, "values_conflict"],
  );
  check(
    `(status = A || status = B) && status = C → 400 status:values_conflict`,
    await refusal(
      alice,
      `(status = "${ST_A}" || status = "${ST_B}") && status = "${ST_C}"`,
      "status",
    ),
    [400, "values_conflict"],
  );
  check(
    `assignee = me && assignee = "" → 400 assignee:values_conflict`,
    await refusal(alice, `assignee = "${alice_id}" && assignee = ""`, "assignee"),
    [400, "values_conflict"],
  );
  check(
    `priority = "p1" && priority = "p2" → 400 priority:values_conflict`,
    await refusal(alice, `priority = "p1" && priority = "p2"`, "priority"),
    [400, "values_conflict"],
  );

  console.log("\n── controls: valid filters still answer, with exact counts ──");
  check(
    `(status = A || status = B) && status = A → 200, 10 rows`,
    await total(alice, inP(`(status = "${ST_A}" || status = "${ST_B}") && status = "${ST_A}"`)),
    [200, 10],
  );
  check(
    `type = "task" || type = "document" (an OR, not a conflict) → 200, 30`,
    await total(alice, inP(`(type = "task" || type = "document")`)),
    [200, 30],
  );
  check(`status != A → 200, 20`, await total(alice, inP(`status != "${ST_A}"`)), [200, 20]);
  check(`assignee = "" (unassigned) → 200, 1`, await total(alice, inP(`assignee = ""`)), [200, 1]);
  check(`assignee = me → 200, 29`, await total(alice, inP(`assignee = "${alice_id}"`)), [200, 29]);
  check(`a macro value: due <= @now → 200, 30`, await total(alice, inP(`due <= @now`)), [200, 30]);
  check(`due != "" (has a due date) → 200, 30`, await total(alice, inP(`due != ""`)), [200, 30]);
  check(`labels !~ "nolabel" → 200, 30`, await total(alice, inP(`labels !~ "nolabel"`)), [200, 30]);
  check(`labels = "[]" (no labels) → 200, 30`, await total(alice, inP(`labels = "[]"`)), [200, 30]);
  check(
    `priority = "" (no priority) → 200, 30`,
    await total(alice, inP(`priority = ""`)),
    [200, 30],
  );
  check(`status != "" → 200, 30`, await total(alice, inP(`status != ""`)), [200, 30]);
  check(
    `type ?= "task" (any-of on a flat column) → 200, 30`,
    await total(alice, inP(`type ?= "task"`)),
    [200, 30],
  );
  check(
    `due ~ "2026-01" (a month) → 200, 10`,
    await total(alice, inP(`due ~ "2026-01"`)),
    [200, 10],
  );
  check(
    `a function call does not hide a bad clause: status ~ "x" && strftime(...) → 400 status`,
    await refusal(alice, `status ~ "x" && strftime('%Y', created) = "2026"`, "status"),
    [400, "operator_not_supported"],
  );
  check(
    `a function call alone still answers: strftime('%Y', due) = "2026" → 200, 30`,
    await total(alice, inP(`strftime('%Y', due) = "2026"`)),
    [200, 30],
  );
  {
    // A macro is not text, so it never meets a literal in a conflict (superuser: PocketBase lets only it use @request).
    const [s] = await list(su, {
      filter: `assignee = @request.auth.id && assignee = "${alice_id}"`,
    });
    check(
      `superuser: assignee = @request.auth.id && assignee = "<id>" → 200, not a conflict`,
      s,
      200,
    );
  }
  check(
    `a column outside the table: title ~ "filter task" → 200, 30`,
    await total(alice, inP(`title ~ "filter task"`)),
    [200, 30],
  );

  console.log("\n── two due bounds hold as the narrower one ──");
  check(
    `due <= Mar && due <= Jan → the Jan rows only (10)`,
    await total(alice, inP(`due <= "${DUES[2]}" && due <= "${DUES[0]}"`)),
    [200, 10],
  );
  check(
    `due >= Jan && due >= Mar → the Mar rows only (10)`,
    await total(alice, inP(`due >= "${DUES[0]}" && due >= "${DUES[2]}"`)),
    [200, 10],
  );

  console.log(
    "\n── paging: perPage defaults to 25, caps at 200; page is at least 1; a non-number falls back ──",
  );
  const page = async (params: Record<string, string>) => {
    const [s, r] = await list(alice, { filter: `project = "${P}"`, ...params });
    return [s, r.page ?? null, r.perPage ?? null, r.items?.length ?? null];
  };
  check(`no perPage → perPage 25, 25 rows`, await page({}), [200, 1, 25, 25]);
  check(`perPage=500 → capped at 200, 30 rows`, await page({ perPage: "500" }), [200, 1, 200, 30]);
  check(`perPage=abc → default 25`, await page({ perPage: "abc" }), [200, 1, 25, 25]);
  check(`page=0 → page 1`, await page({ page: "0" }), [200, 1, 25, 25]);
  check(`page=abc → page 1`, await page({ page: "abc" }), [200, 1, 25, 25]);
  check(`page=2 → page 2, the last 5 rows`, await page({ page: "2" }), [200, 2, 25, 5]);
} finally {
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all item-list filter and paging proofs passed");
  process.exit(0);
}

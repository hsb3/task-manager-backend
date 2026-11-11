#!/usr/bin/env bun
/**
 * decision:api-key-reach-and-levels: a limited key's realtime events and protected-file downloads
 * follow its reach; subscription options cannot widen it; sessions and unlimited keys unchanged.
 * A key's open stream ends when the key is revoked, deleted or expires.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures by name.
 * Port 8213 + PB_PORT_OFFSET.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, run_checked, tup } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";
import { authorize_params, exchange, PKCE } from "./oauthkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8213 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const KEYS = "/api/collections/api_keys/records";
const USERS = "/api/collections/users/records";
const recs = (c: string) => `/api/collections/${c}/records`;
const REACH_MSG =
  "This API key is limited to part of the tracker, so it cannot be used for this endpoint.";
const WAIT_MS = 8000; // bound on an in-reach event's arrival
const RUNS = 8; // a forged header and the real one tie at random (Go map order)
const GRACE_MS = 1500; // bound on a late out-of-reach event after the in-reach one arrived

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(76)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

async function api(
  method: string,
  url: string,
  auth: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  const r = await fetch(BASE_URL + url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await r.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { _raw: text };
  }
  return [r.status, parsed];
}

async function download(
  url: string,
  auth: string | null = null,
  extra: Record<string, string> = {},
): Promise<[number, Uint8Array]> {
  const r = await fetch(BASE_URL + url, {
    headers: auth ? { Authorization: auth, ...extra } : extra,
  });
  return [r.status, new Uint8Array(await r.arrayBuffer())];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `pred` until true or WAIT_MS passes, then waits GRACE_MS for anything late. */
async function settle(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!pred() && Date.now() < deadline) await sleep(100);
  await sleep(GRACE_MS);
}

const answer = ([s, r]: [number, any]) =>
  tup(s, r?.data?.api_key?.code ?? null, r?.data?.api_key?.message ?? null);
const reach403 = tup(403, "api_key_reach", REACH_MSG);

const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-key-reach-live-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
copy_tree(REAL_MIGRATIONS_DIR, MIG_DIR);
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
const listeners: roomkit.SSEListener[] = [];
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
    "\n── fixtures: Alice owns WA (PA1: F1, PA2: F2) and WB (PB1: F3), each task with a file ──",
  );
  const [sc] = await api("POST", USERS, su, {
    email: "alice@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Alice",
    verified: true,
    approved: true,
  });
  check("(fixture) Alice created", sc, 200);
  const [, lr] = await api("POST", "/api/collections/users/auth-with-password", null, {
    identity: "alice@example.com",
    password: "test123456",
  });
  const alice: string = lr.token ?? "";
  const [, wl] = await api(
    "GET",
    `${recs("workspaces")}?filter=${encodeURIComponent(`owner='${lr.record?.id}'`)}`,
    su,
  );
  const WA: string = wl.items?.[0]?.id ?? "";
  const make = async (c: string, body: any, label: string): Promise<string> => {
    const [st, r] = await api("POST", recs(c), alice, body);
    check(`(fixture) ${label}`, st, 200);
    return r.id ?? "";
  };
  const WB = await make("workspaces", { name: "WB" }, "workspace WB");
  const PA1 = await make("projects", { name: "PA1", workspace: WA }, "project PA1 in WA");
  const PA2 = await make("projects", { name: "PA2", workspace: WA }, "project PA2 in WA");
  const PB1 = await make("projects", { name: "PB1", workspace: WB }, "project PB1 in WB");
  const content: Record<string, Uint8Array> = {};
  const fileTask = async (
    title: string,
    ws: string,
    project: string,
  ): Promise<[string, string]> => {
    // A PNG signature is what PocketBase sniffs; the tail makes each file's bytes unique.
    const bytes = new Uint8Array(
      Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from(`file of ${title}`)]),
    );
    const fd = new FormData();
    fd.set("title", title);
    fd.set("workspace", ws);
    fd.set("project", project);
    fd.set("attachments", new Blob([bytes], { type: "image/png" }), `${title}.png`);
    const r = await fetch(BASE_URL + recs("tasks"), {
      method: "POST",
      headers: { Authorization: alice },
      body: fd,
    });
    const j: any = await r.json().catch(() => ({}));
    check(
      `(fixture) task ${title} with an attachment`,
      tup(r.status, j.attachments?.length),
      tup(200, 1),
    );
    content[j.id] = bytes;
    return [j.id ?? "", j.attachments?.[0] ?? ""];
  };
  const [F1, F1n] = await fileTask("F1", WA, PA1);
  const [F2, F2n] = await fileTask("F2", WA, PA2);
  const [F3, F3n] = await fileTask("F3", WB, PB1);
  const mint = async (name: string, body: any): Promise<string> => {
    const [st, k] = await api("POST", KEYS, alice, { name, scope: "write", ...body });
    check(`(fixture) key ${name} minted`, st, 200);
    return k.key ?? "tmk_none";
  };
  const kAll = await mint("kAll", {});
  const kWA = await mint("kWA", { reach: "workspace", workspace: WA });
  const kP1 = await mint("kP1", { reach: "projects", workspace: WA, projects: [PA1] });

  console.log("\n── realtime ──");
  const opts = (o: any) => `?options=${encodeURIComponent(JSON.stringify(o))}`;
  const listen = (token: string, topic: string): roomkit.SSEListener => {
    const l = new roomkit.SSEListener(BASE_URL, token, topic);
    listeners.push(l);
    return l;
  };
  const kWA_tasks = listen(kWA, "tasks/*");
  const kWA_hdr = listen(kWA, `tasks/*${opts({ headers: { x_tm_key_workspace: "" } })}`);
  const kWA_dot = listen(kWA, `tasks/*${opts({ headers: { "X.Tm.Key.Workspace": "" } })}`);
  const kP1_items = listen(kP1, `rt:project_items:${WA}`);
  const kWA_itemsB = listen(kWA, `rt:project_items:${WB}`);
  const kP1_comments = listen(kP1, "comments/*");
  const kAll_tasks = listen(kAll, "tasks/*");
  const alice_tasks = listen(alice, "tasks/*");
  for (const l of listeners) await l.start();
  await sleep(500); // each reader subscribes right after PB_CONNECT
  check(
    "(fixture) every listener connected",
    listeners.map((l) => l.connected),
    listeners.map(() => true),
  );

  const TA = await make(
    "tasks",
    { title: "live WA", workspace: WA, project: PA1 },
    "task created in PA1",
  );
  const TB = await make(
    "tasks",
    { title: "live WB", workspace: WB, project: PB1 },
    "task created in PB1",
  );
  for (const [t, title] of [
    [F1, "F1 edited"],
    [F2, "F2 edited"],
  ]) {
    const [st] = await api("PATCH", `${recs("tasks")}/${t}`, alice, { title });
    check(`(fixture) Alice updates ${title.split(" ")[0]}`, st, 200);
  }
  const C1 = await make("comments", { task: F1, body: "on F1" }, "comment on the PA1 task");
  const C2 = await make("comments", { task: F2, body: "on F2" }, "comment on the PA2 task");
  const [sd] = await api("DELETE", `${recs("comments")}/${C1}`, alice);
  check("(fixture) Alice deletes the PA1 comment", sd, 204);

  const ids = (l: roomkit.SSEListener, action: string) =>
    l.events.filter((e) => e?.action === action).map((e) => e?.record?.id ?? e?.id);
  const has = (l: roomkit.SSEListener, action: string, id: string) => ids(l, action).includes(id);
  await settle(
    () =>
      has(kWA_tasks, "create", TA) &&
      has(kWA_hdr, "create", TA) &&
      has(kWA_dot, "create", TA) &&
      has(kP1_items, "update", F1) &&
      has(kP1_comments, "delete", C1) &&
      has(kAll_tasks, "create", TB) &&
      has(alice_tasks, "create", TB),
  );

  check(
    "kWA subscribed to tasks/* receives a WA create, not a WB create",
    tup(has(kWA_tasks, "create", TA), has(kWA_tasks, "create", TB), kWA_tasks.absent_count(0)),
    tup(true, false, 0),
  );
  check(
    "kWA subscribed to tasks/* with options.headers x_tm_key_workspace '' still receives no WB event",
    tup(
      has(kWA_hdr, "create", TA),
      kWA_hdr.absent_count(kWA_hdr.events.filter((e) => e?.record?.workspace !== WA).length),
    ),
    tup(true, 0),
  );
  check(
    "kWA subscribed to tasks/* with options.headers X.Tm.Key.Workspace '' still receives no WB event",
    tup(
      has(kWA_dot, "create", TA),
      kWA_dot.absent_count(kWA_dot.events.filter((e) => e?.record?.workspace !== WA).length),
    ),
    tup(true, 0),
  );
  check(
    "kP1 subscribed to rt:project_items:WA receives a PA1 task update, not a PA2 one",
    tup(has(kP1_items, "update", F1), has(kP1_items, "update", F2)),
    tup(true, false),
  );
  check("kWA subscribed to rt:project_items:WB receives nothing", kWA_itemsB.absent_count(), 0);
  check(
    "kP1 subscribed to comments/* receives a comment on a PA1 task, not one on a PA2 task",
    tup(has(kP1_comments, "create", C1), has(kP1_comments, "create", C2)),
    tup(true, false),
  );
  check("kP1 receives the delete of a PA1 comment", has(kP1_comments, "delete", C1), true);
  for (const [who, l] of [
    ["kAll", kAll_tasks],
    ["Alice's session", alice_tasks],
  ] as const) {
    check(
      `${who} receives every event (control)`,
      [TA, TB, F1, F2].map((id) => has(l, "create", id) || has(l, "update", id)),
      [true, true, true, true],
    );
  }

  // Last: a subscribe POST replaces the client's subscriptions.
  const expandSub = `tasks/*${opts({ query: { expand: "parent" } })}`;
  const subscribe = (token: string, l: roomkit.SSEListener, sub = expandSub) =>
    api("POST", "/api/realtime", token, { clientId: l.client_id, subscriptions: [sub] });
  check(
    "kP1 subscribing to tasks/* with options query expand=parent → 403 api_key_reach",
    answer(await subscribe(kP1, kP1_comments)),
    reach403,
  );
  check(
    "kAll with the same subscription → 204 (control)",
    (await subscribe(kAll, kAll_tasks))[0],
    204,
  );
  const expandJson = JSON.stringify({ query: { expand: "parent" } });
  const bypasses: [string, string][] = [
    ["?a=1&options=", `tasks/*?a=1&options=${encodeURIComponent(expandJson)}`],
    ["?%6Fptions=", `tasks/*?%6Fptions=${encodeURIComponent(expandJson)}`],
    [
      "duplicate query keys",
      `tasks/*?options=${encodeURIComponent('{"query":{"expand":"parent"},"query":{}}')}`,
    ],
    ["double-encoded", `tasks/*?options=${encodeURIComponent(encodeURIComponent(expandJson))}`],
    [
      "\\u-escaped expand",
      `tasks/*?options=${encodeURIComponent('{"query":{"\\u0065xpand":"parent"}}')}`,
    ],
  ];
  for (const [form, sub] of bypasses) {
    check(
      `kP1 subscribing with expand spelled ${form} → 403 api_key_reach`,
      answer(await subscribe(kP1, kP1_comments, sub)),
      reach403,
    );
  }
  check(
    "kAll subscribing with expand spelled ?a=1&options= → 204 (control)",
    (await subscribe(kAll, kAll_tasks, bypasses[0][1]))[0],
    204,
  );

  console.log("\n── files ──");
  const file = (id: string, name: string) => `/api/files/tasks/${id}/${name}`;
  const [s1, b1] = await download(file(F1, F1n), kP1);
  check(
    "kP1 downloads the PA1 attachment with its key, no token → 200, content matches",
    tup(s1, Bun.deepEquals(b1, content[F1])),
    tup(200, true),
  );
  const [sg, bg] = await download(`${file(F1, F1n)}?token=garbage`, kAll);
  check(
    "kAll downloads the PA1 attachment with ?token=garbage → 200",
    tup(sg, Bun.deepEquals(bg, content[F1])),
    tup(200, true),
  );
  check("kP1 downloads the PA2 attachment → 404", (await download(file(F2, F2n), kP1))[0], 404);
  check("kWA downloads the WB attachment → 404", (await download(file(F3, F3n), kWA))[0], 404);
  const [, ft] = await api("POST", "/api/files/token", alice);
  const aliceFileToken: string = ft.token ?? "";
  check(
    "kP1 downloads the PA2 attachment with a file token Alice's session minted → 404",
    (await download(`${file(F2, F2n)}?token=${aliceFileToken}`, kP1))[0],
    404,
  );
  check(
    "kP1 POST /api/files/token → 403 api_key_reach",
    answer(await api("POST", "/api/files/token", kP1)),
    reach403,
  );
  check("kAll POST /api/files/token → 200", (await api("POST", "/api/files/token", kAll))[0], 200);
  check(
    "Alice's session file token alone downloads the PA2 attachment → 200 (control)",
    (await download(`${file(F2, F2n)}?token=${aliceFileToken}`))[0],
    200,
  );

  console.log(`\n── files under forged reach headers (each ${RUNS} times running) ──`);
  // PB 0.40.4 reads a header name as inflector.Snakecase: runs of characters outside [A-Za-z0-9] split it.
  const forgedNames = (last: string): string[] => {
    const words = ["x", "tm", "key", last];
    const out = new Set([`X.Tm.Key.${last[0].toUpperCase()}${last.slice(1)}`, `X-Tm_Key.${last}`]);
    for (const c of "!#$%&'*+-.^_`|~") {
      const j = words.join(c);
      for (const n of [j, words.join(c + c), c + j, j + c]) out.add(n);
    }
    return [...out];
  };
  // Left off for the rest of the run: the room is this suite's own and is deleted with it.
  check(
    "(fixture) superuser lifts the room's request rate limit for the sweep",
    (await api("PATCH", "/api/settings", su, { rateLimits: { enabled: false } }))[0],
    200,
  );
  const wsNames = forgedNames("workspace");
  const pjNames = forgedNames("projects");
  for (const [name, token, url, wide] of [
    ["kWA", kWA, file(F3, F3n), tup(WB, "")],
    ["kP1", kP1, file(F2, F2n), tup(WA, PA2)],
  ] as [string, string, string, [string, string]][]) {
    const leaked = new Set<string>();
    for (let i = 0; i < wsNames.length; i++)
      for (let r = 0; r < RUNS; r++) {
        const f = { [wsNames[i]]: r % 2 ? wide[0] : "", [pjNames[i]]: r % 2 ? wide[1] : "" };
        if ((await download(url, token, f))[0] !== 404) leaked.add(`${wsNames[i]} / ${pjNames[i]}`);
      }
    check(
      `${name} downloads an out-of-reach attachment under ${wsNames.length} forged spelling pairs → 404 every run`,
      [...leaked],
      [],
    );
  }

  console.log(
    "\n── realtime after a key ends: revoked, deleted, expired, revoked at /oauth/revoke, replaced by a refresh, owner unapproved ──",
  );
  const kRev = await mint("kRev", {});
  const kDel = await mint("kDel", {});
  const kLive = await mint("kLive", {});
  const oauthParams = authorize_params();
  const grant = async (label: string): Promise<{ access: string; refresh: string }> => {
    const code = crypto.randomUUID();
    const [sCode] = await api("POST", recs("oauth_codes"), su, {
      code_hash: new Bun.CryptoHasher("sha256").update(code).digest("hex"),
      user: lr.record?.id,
      client_id: oauthParams.client_id,
      client_name: "Cursor",
      redirect_uri: oauthParams.redirect_uri,
      code_challenge: PKCE.challenge,
      scope: "write",
      expires: new Date(Date.now() + 600_000).toISOString(),
    });
    const granted = await exchange(BASE_URL, code, oauthParams);
    check(
      `(fixture) ${label}: a code inserted and exchanged`,
      tup(sCode, granted.status),
      tup(200, 200),
    );
    return {
      access: granted.body?.access_token ?? "tmk_none",
      refresh: granted.body?.refresh_token ?? "tmr_none",
    };
  };
  const oauthPost = async (path: string, form: Record<string, string>): Promise<[number, any]> => {
    const r = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    return [r.status, await r.json().catch(() => ({}))];
  };
  const kOauth = (await grant("OAuth key to revoke")).access;
  const rotated = await grant("OAuth key to refresh");
  const [sc2, carolRec] = await api("POST", USERS, su, {
    email: "carol@example.com",
    password: "test123456",
    passwordConfirm: "test123456",
    name: "Carol",
    verified: true,
    approved: true,
  });
  check("(fixture) Carol created", sc2, 200);
  check(
    "(fixture) Carol joins WA as a member",
    (
      await api("POST", recs("workspace_members"), su, {
        workspace: WA,
        user: carolRec.id,
        role: "member",
        status: "active",
      })
    )[0],
    200,
  );
  const [sck, kCarol] = await api("POST", KEYS, su, {
    user: carolRec.id,
    name: "kCarol",
    scope: "read",
  });
  check("(fixture) superuser mints Carol a key", sck, 200);
  const EXPIRY_MS = 6000; // long enough for every listener to subscribe first
  const [sExp, kExpRec] = await api("POST", KEYS, alice, {
    name: "kExp",
    scope: "write",
    expires: new Date(Date.now() + EXPIRY_MS).toISOString(),
  });
  check("(fixture) key kExp minted, expiring shortly", sExp, 200);
  const expiresAt = Date.now() + EXPIRY_MS;
  const ended: [string, roomkit.SSEListener][] = [
    ["revoked key", listen(kRev, "tasks/*")],
    ["revoked key, second client", listen(kRev, "tasks/*")],
    ["deleted key", listen(kDel, "tasks/*")],
    ["expired key", listen(kExpRec.key ?? "tmk_none", "tasks/*")],
    ["key revoked at /oauth/revoke", listen(kOauth, "tasks/*")],
    ["access token replaced by a refresh", listen(rotated.access, "tasks/*")],
    ["key of an owner no longer approved", listen(kCarol.key ?? "tmk_none", "tasks/*")],
  ];
  const live: [string, roomkit.SSEListener][] = [
    ["live key", listen(kLive, "tasks/*")],
    ["Alice's session", listen(alice, "tasks/*")],
  ];
  for (const [, l] of [...ended, ...live]) await l.start();
  await sleep(500);
  const before = await make(
    "tasks",
    { title: "before end", workspace: WA, project: PA1 },
    "task created before the keys end",
  );
  await settle(() => [...ended, ...live].every(([, l]) => has(l, "create", before)));
  check(
    "(fixture) every listener receives a create before its key ends",
    [...ended, ...live].map(([, l]) => has(l, "create", before)),
    [...ended, ...live].map(() => true),
  );
  const keyId = async (token: string) => (await api("GET", "/api/tracker/me", token))[1]?.key?.id;
  const revId = await keyId(kRev);
  const delId = await keyId(kDel);
  check(
    "(fixture) Alice revokes kRev",
    (await api("PATCH", `${KEYS}/${revId}`, alice, { revoked: true }))[0],
    200,
  );
  check("(fixture) Alice deletes kDel", (await api("DELETE", `${KEYS}/${delId}`, alice))[0], 204);
  check(
    "(fixture) the OAuth key revoked at /oauth/revoke",
    (await oauthPost("/oauth/revoke", { token: kOauth, client_id: oauthParams.client_id }))[0],
    200,
  );
  const [sRef, refreshed] = await oauthPost("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: rotated.refresh,
    client_id: oauthParams.client_id,
  });
  check("(fixture) the second OAuth key refreshed", sRef, 200);
  const renewed = listen(refreshed.access_token ?? "tmk_none", "tasks/*");
  await renewed.start();
  live.push(["the refreshed access token, subscribed after the refresh", renewed]);
  check(
    "(fixture) superuser withdraws Carol's approval",
    (await api("PATCH", `${USERS}/${carolRec.id}`, su, { approved: false }))[0],
    200,
  );
  await sleep(Math.max(0, expiresAt - Date.now()) + 1000);
  check(
    "(fixture) the expired key answers 401",
    (await api("GET", "/api/tracker/me", kExpRec.key))[0],
    401,
  );
  const after = await make(
    "tasks",
    { title: "after end", workspace: WA, project: PA1 },
    "task created after the keys end",
  );
  await settle(() => live.every(([, l]) => has(l, "create", after)));
  for (const [who, l] of ended) {
    // A client still registered accepts a same-user subscribe (204); a dropped one is unknown (404).
    const [sSub] = await api("POST", "/api/realtime", alice, {
      clientId: l.client_id,
      subscriptions: ["tasks/*"],
    });
    check(
      `${who}: no event after it ends, and its realtime client is dropped`,
      tup(has(l, "create", after), sSub),
      tup(false, 404),
    );
  }
  for (const [who, l] of live)
    check(`${who} still receives the later create (control)`, has(l, "create", after), true);
} finally {
  for (const l of listeners) l.stop = true;
  if (server !== null) await roomkit.stop(server);
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all live key-reach proofs passed");
  process.exit(0);
}

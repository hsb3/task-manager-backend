#!/usr/bin/env bun
/**
 * Proof that a mention resolves by STABLE REFERENCE — an id — across all four resolve sites.
 *
 * Owner ruling 2026-09-08 (card ef0r): the stored grammar is `@[Display Name](userId)`. The
 * bracket text is display only and is never consulted, so renaming a member cannot break an
 * existing mention, and no peer ever reads another member's email local part to write one.
 * Hand-typed `@localpart` stays as the fallback, so nothing that notifies today stops notifying.
 *
 * The four resolve sites in pb_hooks/notify.pb.js are exercised separately on purpose: comment
 * create, comment update, item-prose create (documents) and item-prose update (decisions). A
 * member who is NOT in the resolving workspace, a SUSPENDED member and a PENDING invitee, and an
 * id-shaped token matching no member, are the controls that make every "resolves to exactly one"
 * assertion falsifiable — as is a member whose own display name spells another member's handle.
 *
 * Fully self-contained clean-room server, --hooksDir from a pb_hooks copy, fixtures built by name.
 * Port 8126 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getitem,
  py_repr,
  py_str,
  read_text,
  run_checked,
  truthy,
  tup,
  urlencode,
  sqlite_connect,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

const REPO_ROOT = roomkit.REPO_ROOT;
const PB_BIN = roomkit.pb_bin();
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8126 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(70)} → ${py_repr(got)} (want ${py_repr(expected)})`,
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
  return roomkit.serve(PORT, data_dir, migrations_dir, HOOKS);
}

async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc !== null) await roomkit.stop(proc);
}

// ── Scratch tree + boot ─────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-notif-mentions-test-"));
// Resolved ONCE: hooks_dir() re-copies on every call, and PB restarts on any write to the
// hooksDir it is watching.
const HOOKS = roomkit.hooks_dir(S);
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  console.log("═════════ test_notifications_mentions.ts — mentions resolve by stable id ═════════");
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

  // ── fixtures: owner, two active members, one outsider ───────────────────────
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

  const [ada, ada_id] = await make_user("Ada", "ada@example.com");
  const [bram, bram_id] = await make_user("Bram Vale", "bram@example.com");
  const [jones, jones_id] = await make_user("Bob Jones", "bob.jones@example.com");
  const [dana, dana_id] = await make_user("Dana Admin", "dana@example.com");
  const [, cyd_id] = await make_user("Cyd Outside", "cyd@example.com");
  check(
    "five fixture users exist",
    [ada_id, bram_id, jones_id, dana_id, cyd_id].every((x) => truthy(x)),
    true,
  );

  let ws: any;
  [s, ws] = await api("POST", "/api/collections/workspaces/records", ada, {
    name: "mentionws",
    owner: ada_id,
  });
  check("Ada creates the workspace she owns", s, 200);
  const WS = getitem(ws, "id");
  for (const [uid, role, label] of [
    [bram_id, "member", "Bram Vale"],
    [jones_id, "member", "Bob Jones"],
    [dana_id, "admin", "Dana Admin"],
  ]) {
    [s] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS,
      user: uid,
      role: role,
      status: "active",
    });
    check(`${label} joins the workspace as an ACTIVE ${role}`, s, 200);
  }
  let proj: any;
  [s, proj] = await api("POST", "/api/collections/projects/records", ada, {
    name: "mention-project",
    owner: ada_id,
    workspace: WS,
  });
  check("Ada creates a project in it", s, 200);
  const PROJECT = getitem(proj, "id");
  check(
    "Cyd is in NO workspace_members row for it (the outsider control)",
    (
      (
        await api(
          "GET",
          "/api/collections/workspace_members/records?" +
            urlencode({ filter: `workspace='${WS}' && user='${cyd_id}'` }),
          su,
        )
      )[1].items || []
    ).length,
    0,
  );

  // ── helpers: mention rows read as SUPERUSER, so no read rule can hide one ────
  async function mention_rows(rel: string, rel_id: any, user_id: any = null): Promise<any[]> {
    const clauses = [`${rel}='${py_str(rel_id)}'`, "kind='mentioned'"];
    if (truthy(user_id)) clauses.push(`user='${user_id}'`);
    const qs = urlencode({ filter: clauses.join(" && "), perPage: 200 });
    const [, r] = await api("GET", `/api/collections/notifications/records?${qs}`, su);
    return r.items || [];
  }

  async function n_mentions(rel: string, rel_id: any, user_id: any = null): Promise<number> {
    return (await mention_rows(rel, rel_id, user_id)).length;
  }

  async function row_is_read(rel: string, rel_id: any, user_id: any): Promise<any> {
    const qs = urlencode({
      filter: `${rel}='${py_str(rel_id)}' && user='${py_str(user_id)}' && kind='mentioned'`,
    });
    const items =
      (await api("GET", `/api/collections/notifications/records?${qs}`, su))[1].items || [];
    return items.length ? (items[0].read ?? null) : null;
  }

  function digest_unread(user_id: string): number {
    // The digest cron's OWN count query, lifted from the hooks copy this room boots.
    //
    // The cron only ever sends mail, so quoting its predicate here is the only way a suite
    // can show the third KEEP IN SYNC site moved with the other two.
    const js = read_text(path.join(HOOKS, "notify.pb.js"));
    const start = js.indexOf('"SELECT [[user]] AS userId');
    if (start < 0) throw new Error("ValueError: substring not found");
    const end_token = '"GROUP BY [[user]]"';
    const end_at = js.indexOf(end_token, start);
    if (end_at < 0) throw new Error("ValueError: substring not found");
    const end = end_at + end_token.length;
    const sql = [...js.slice(start, end).matchAll(/"([^"]*)"/g)]
      .map((m) => m[1])
      .join("")
      .replaceAll("[[", "")
      .replaceAll("]]", "");
    const con = sqlite_connect(path.join(DATA_DIR, "data.db"), { readonly: true });
    try {
      return new Map(con.query(sql).values() as [string, number][]).get(user_id) ?? 0;
    } finally {
      con.close();
    }
  }

  async function new_task(title: string): Promise<any> {
    const [s, t] = await api("POST", "/api/collections/tasks/records", ada, {
      title: title,
      project: PROJECT,
    });
    if (s !== 200) {
      throw new roomkit.SystemExit(`❌ fixture task ${title} not created: HTTP ${s} ${py_repr(t)}`);
    }
    return getitem(t, "id");
  }

  async function comment_on(task_id: any, body: string): Promise<[number, any]> {
    const [s, c] = await api("POST", "/api/collections/comments/records", ada, {
      task: task_id,
      author: ada_id,
      body: body,
    });
    return [s, c.id ?? null];
  }

  async function probe_comment(title: string, body: string): Promise<[any, number]> {
    // A fresh task per body, so each probe counts only its own fan-out.
    const t = await new_task(title);
    const [s] = await comment_on(t, body);
    return [t, s];
  }

  function ref(display: string, user_id: any): string {
    return `@[${display}](${py_str(user_id)})`;
  }

  // ═══════════ (1) COMMENT CREATE — a stable reference names one member ════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  console.log("\n── (1) comment create: `@[Display](userId)` notifies exactly that member ──");
  const T1 = await new_task("stable-ref-create");
  // The bracket text is deliberately NOT this member's name: only the id may resolve.
  let C1: any;
  [s, C1] = await comment_on(T1, `hi ${ref("Zeta Display Two", bram_id)} please look`);
  check("Ada comments naming Bram by stable reference → 200", s, 200);
  check("exactly ONE {Bram,mentioned} row", await n_mentions("task", T1, bram_id), 1);
  check("…and it is the only mention row on the task", await n_mentions("task", T1), 1);
  check(
    "the row points at the comment that carried the reference",
    ((await mention_rows("task", T1, bram_id)).length
      ? await mention_rows("task", T1, bram_id)
      : [{}])[0].comment ?? null,
    C1,
  );
  check("the author mentions nobody by writing it", await n_mentions("task", T1, ada_id), 0);

  // ═══════════ (2) COMMENT UPDATE — adding a reference notifies once ═══════════
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:comments
  console.log(
    "\n── (2) comment update: a newly-added reference notifies, the old one is not replayed ──",
  );
  [s] = await api("PATCH", `/api/collections/comments/records/${py_str(C1)}`, ada, {
    body: `hi ${ref("Zeta Display Two", bram_id)} and ${ref("Any Text", jones_id)} too`,
  });
  check("Ada edits the comment to add a second stable reference → 200", s, 200);
  check(
    "exactly ONE {Bob Jones,mentioned} row for the newly-named member",
    await n_mentions("task", T1, jones_id),
    1,
  );
  check(
    "the already-mentioned member gets nothing new (replay guard)",
    await n_mentions("task", T1, bram_id),
    1,
  );
  check("two mention rows on the task in total", await n_mentions("task", T1), 2);

  // ═══════════ (3) DOCUMENT CREATE — the same grammar in item prose ═══════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:documents
  console.log("\n── (3) document create: a stable reference in the item's own prose ──");
  let doc: any;
  [s, doc] = await api("POST", "/api/collections/documents/records", ada, {
    title: "stable-ref-doc",
    workspace: WS,
    body: `see ${ref("Whoever", bram_id)}`,
  });
  check("Ada creates a document whose body carries a stable reference → 200", s, 200);
  const DOC = doc.id ?? null;
  check(
    "exactly ONE {Bram,mentioned} row on the document",
    await n_mentions("document", DOC, bram_id),
    1,
  );
  check("…and it is the only mention row on it", await n_mentions("document", DOC), 1);
  check(
    "the row names the item, never a comment",
    ((await mention_rows("document", DOC, bram_id)).length
      ? await mention_rows("document", DOC, bram_id)
      : [{}])[0].comment ?? null,
    "",
  );

  // ═══════════ (4) DECISION UPDATE — the same grammar on an edit ══════════════
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:decisions
  console.log("\n── (4) decision update: prose edited to carry a stable reference ──");
  let dec: any;
  [s, dec] = await api("POST", "/api/collections/decisions/records", ada, {
    title: "stable-ref-decision",
    workspace: WS,
  });
  check("Ada creates a decision with no prose → 200", s, 200);
  const DEC = dec.id ?? null;
  check("it names nobody yet", await n_mentions("decision", DEC), 0);
  [s] = await api("PATCH", `/api/collections/decisions/records/${py_str(DEC)}`, ada, {
    context: `raised by ${ref("Some Name", jones_id)}`,
  });
  check("Ada edits its context to carry a stable reference → 200", s, 200);
  check(
    "exactly ONE {Bob Jones,mentioned} row on the decision",
    await n_mentions("decision", DEC, jones_id),
    1,
  );
  check("…and it is the only mention row on it", await n_mentions("decision", DEC), 1);

  // ═══════════ (5) RENAME-PROOF — the bracket text is never consulted ═════════
  console.log("\n── (5) renaming the mentioned member does not break a reference ──");
  [s] = await api("PATCH", `/api/collections/users/records/${bram_id}`, su, {
    name: "Renamed Entirely",
  });
  check("superuser renames Bram Vale → 'Renamed Entirely'", s, 200);
  check(
    "the rename really landed",
    (await api("GET", `/api/collections/users/records/${bram_id}`, su))[1].name ?? null,
    "Renamed Entirely",
  );
  // The STALE display name, the same id: an old mention must still resolve.
  const [T5, s5] = await probe_comment("rename-proof", `ping ${ref("Bram Vale", bram_id)} again`);
  check("a comment carrying the OLD display name and the same id → 200", s5, 200);
  check("still exactly ONE {Bram,mentioned} row", await n_mentions("task", T5, bram_id), 1);
  check("…and nobody else was named", await n_mentions("task", T5), 1);

  // ═══════════ (6) FALLBACK — hand-typed `@localpart` still notifies ══════════
  console.log("\n── (6) the hand-typed email-local-part fallback is intact ──");
  const [T6, s6] = await probe_comment("fallback-comment", "hi @bram please look");
  check("`@bram` on a comment → 200", s6, 200);
  check(
    "exactly ONE {Bram,mentioned} row from the fallback",
    await n_mentions("task", T6, bram_id),
    1,
  );
  const [T6B, s6b] = await probe_comment("fallback-dotted", "cc @bob.jones on this");
  check("a DOTTED local part `@bob.jones` → 200", s6b, 200);
  check("exactly ONE {Bob Jones,mentioned} row", await n_mentions("task", T6B, jones_id), 1);
  check("…and nobody else", await n_mentions("task", T6B), 1);
  let doc6: any;
  [s, doc6] = await api("POST", "/api/collections/documents/records", ada, {
    title: "fallback-doc",
    workspace: WS,
    body: "drafted with @bram",
  });
  check("`@bram` in DOCUMENT prose → 200", s, 200);
  check(
    "exactly ONE {Bram,mentioned} row on it",
    await n_mentions("document", doc6.id ?? null, bram_id),
    1,
  );

  // ═══════════ (7) AC#2 — no ambiguity, and no reach outside the workspace ════
  console.log("\n── (7) an id outside the candidate set, and a malformed one, name nobody ──");
  const [T7, s7] = await probe_comment("outsider-ref", `hi ${ref("Anyone", cyd_id)} take a look`);
  check("a reference to a NON-MEMBER, non-owner user → 200 (the write still succeeds)", s7, 200);
  check("ZERO {Cyd,mentioned} rows", await n_mentions("task", T7, cyd_id), 0);
  check("ZERO mention rows on the task at all", await n_mentions("task", T7), 0);
  const [T7B, s7b] = await probe_comment("malformed-ref", "hi @[Name](notanid) take a look");
  check("a malformed reference does not throw — the write answers 200", s7b, 200);
  check("ZERO mention rows from it", await n_mentions("task", T7B), 0);
  let doc7: any;
  [s, doc7] = await api("POST", "/api/collections/documents/records", ada, {
    title: "outsider-doc",
    workspace: WS,
    body: `cc ${ref("Anyone", cyd_id)}`,
  });
  check("the same outsider reference in ITEM prose → 200", s, 200);
  check("ZERO mention rows on the document", await n_mentions("document", doc7.id ?? null), 0);

  // ═══════════ (8) THE `@` IS LOAD-BEARING — a plain link names nobody ════════
  console.log("\n── (8) a plain markdown link with no leading `@` is not a mention ──");
  const [T8, s8] = await probe_comment("plain-link", `see [the profile](${bram_id}) for context`);
  check("a bare `[text](userId)` link → 200", s8, 200);
  check("ZERO mention rows: the grammar needs the `@`", await n_mentions("task", T8), 0);

  // ═══════════ (9) DEDUPE + the bracket text is not tokenized ═════════════════
  console.log(
    "\n── (9) named by both grammars at once, and bracket text that looks like a handle ──",
  );
  const [T9, s9] = await probe_comment(
    "dedupe",
    `${ref("Renamed Entirely", bram_id)} — also @bram`,
  );
  check("a member named by BOTH id and local part → 200", s9, 200);
  check("exactly ONE row, not two", await n_mentions("task", T9, bram_id), 1);
  check("…and it is the only mention row on the task", await n_mentions("task", T9), 1);
  const [T9B, s9b] = await probe_comment("bracket-text-inert", `hi ${ref("bram", jones_id)} only`);
  check("bracket text spelling ANOTHER member's local part → 200", s9b, 200);
  check(
    "the id wins: exactly ONE {Bob Jones,mentioned} row",
    await n_mentions("task", T9B, jones_id),
    1,
  );
  check(
    "the member whose local part the bracket text spells gets NOTHING",
    await n_mentions("task", T9B, bram_id),
    0,
  );

  // ═══════════ (10) j5hp — a document flipped back to draft hides its rows ════
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:documents
  console.log(
    "\n── (10) document unpublished: the row follows the item, for each role separately ──",
  );
  let vdoc: any;
  [s, vdoc] = await api("POST", "/api/collections/documents/records", bram, {
    title: "visibility-doc",
    workspace: WS,
    draft: false,
    body: `${ref("Ada", ada_id)} ${ref("Dana Admin", dana_id)} ${ref("Bob Jones", jones_id)}`,
  });
  check("Bram publishes a document naming the owner, an admin and a plain member", s, 200);
  const VDOC = vdoc.id ?? null;
  check("three mention rows on it", await n_mentions("document", VDOC), 3);
  for (const [tok, who] of [
    [ada, "owner Ada"],
    [dana, "admin Dana"],
    [jones, "member Bob Jones"],
  ]) {
    check(
      `published: ${who} lists their own row`,
      (
        (
          await api(
            "GET",
            "/api/collections/notifications/records?" +
              urlencode({ filter: `document='${py_str(VDOC)}'` }),
            tok,
          )
        )[1].items || []
      ).length,
      1,
    );
  }
  const before = digest_unread(jones_id);
  // decision:draft-private-publish-one-way exempts only a superuser from the one-way guard, so that is the only way left
  // to reach the redrafted state this block proves the inbox exclusion against.
  [s] = await api("PATCH", `/api/collections/documents/records/${py_str(VDOC)}`, bram, {
    draft: true,
  });
  check("its author cannot put it back to draft → 400", s, 400);
  [s] = await api("PATCH", `/api/collections/documents/records/${py_str(VDOC)}`, su, {
    draft: true,
  });
  check("a superuser still can → 200", s, 200);
  check(
    "the plain member can no longer open the item",
    (await api("GET", `/api/collections/documents/records/${py_str(VDOC)}`, jones))[0],
    404,
  );
  check(
    "…so their mention row vanishes from their inbox",
    (
      (
        await api(
          "GET",
          "/api/collections/notifications/records?" +
            urlencode({ filter: `document='${py_str(VDOC)}'` }),
          jones,
        )
      )[1].items || []
    ).length,
    0,
  );
  check(
    "the row was HIDDEN, not deleted — a superuser still sees all three",
    await n_mentions("document", VDOC),
    3,
  );
  for (const [tok, who] of [
    [ada, "owner Ada"],
    [dana, "admin Dana"],
  ]) {
    check(
      `draft: ${who} can still OPEN the item`,
      (await api("GET", `/api/collections/documents/records/${py_str(VDOC)}`, tok))[0],
      200,
    );
    check(
      `draft: …so ${who} KEEPS their row (this is what a blanket hide would break)`,
      (
        (
          await api(
            "GET",
            "/api/collections/notifications/records?" +
              urlencode({ filter: `document='${py_str(VDOC)}'` }),
            tok,
          )
        )[1].items || []
      ).length,
      1,
    );
  }
  check(
    "the digest count for the plain member drops by exactly one",
    digest_unread(jones_id),
    before - 1,
  );
  check("…and the owner's row is still counted", digest_unread(ada_id) > 0, true);
  [s, r] = await api("POST", "/api/tracker/notifications/read-all", jones);
  check("the plain member marks their whole inbox read → 200", s, 200);
  check("the hidden row is NOT marked read", await row_is_read("document", VDOC, jones_id), false);
  check(
    "CONTROL: a row on a PUBLISHED item was marked read by the same call",
    await row_is_read("task", T1, jones_id),
    true,
  );
  [s] = await api("PATCH", `/api/collections/documents/records/${py_str(VDOC)}`, bram, {
    draft: false,
  });
  check("Bram publishes it again → 200", s, 200);
  check(
    "the plain member's row comes back",
    (
      (
        await api(
          "GET",
          "/api/collections/notifications/records?" +
            urlencode({ filter: `document='${py_str(VDOC)}'` }),
          jones,
        )
      )[1].items || []
    ).length,
    1,
  );
  check("…and the round trip made no duplicate", await n_mentions("document", VDOC), 3);

  // ═══════════ (11) j5hp — the AUTHOR leg, on a decision ══════════════════════
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:decisions
  console.log(
    "\n── (11) decision unpublished: its own author keeps the row, a plain member loses it ──",
  );
  let vdec: any;
  [s, vdec] = await api("POST", "/api/collections/decisions/records", jones, {
    title: "visibility-decision",
    workspace: WS,
    draft: false,
  });
  check("Bob Jones — a plain member — authors a published decision", s, 200);
  const VDEC = vdec.id ?? null;
  [s] = await api("PATCH", `/api/collections/decisions/records/${py_str(VDEC)}`, ada, {
    context: `raised by ${ref("Bob Jones", jones_id)} with ${ref("Bram", bram_id)}`,
  });
  check("Ada edits it to name the AUTHOR and one other plain member → 200", s, 200);
  check("two mention rows on it", await n_mentions("decision", VDEC), 2);
  // Same as block (10): the app tier's redraft is refused, a superuser write still reaches it.
  [s] = await api("PATCH", `/api/collections/decisions/records/${py_str(VDEC)}`, ada, {
    draft: true,
  });
  check("the workspace owner cannot put it back to draft → 400", s, 400);
  [s] = await api("PATCH", `/api/collections/decisions/records/${py_str(VDEC)}`, su, {
    draft: true,
  });
  check("a superuser still can → 200", s, 200);
  check(
    "its AUTHOR can still open it",
    (await api("GET", `/api/collections/decisions/records/${py_str(VDEC)}`, jones))[0],
    200,
  );
  check(
    "…so the author keeps their row",
    (
      (
        await api(
          "GET",
          "/api/collections/notifications/records?" +
            urlencode({ filter: `decision='${py_str(VDEC)}'` }),
          jones,
        )
      )[1].items || []
    ).length,
    1,
  );
  check(
    "the other plain member cannot open it",
    (await api("GET", `/api/collections/decisions/records/${py_str(VDEC)}`, bram))[0],
    404,
  );
  check(
    "…so their row is gone from their inbox",
    (
      (
        await api(
          "GET",
          "/api/collections/notifications/records?" +
            urlencode({ filter: `decision='${py_str(VDEC)}'` }),
          bram,
        )
      )[1].items || []
    ).length,
    0,
  );
  check("both rows still exist for a superuser", await n_mentions("decision", VDEC), 2);

  // ═══════════ (12) A DISPLAY NAME CANNOT AMPLIFY A MENTION ══════════════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:documents
  console.log("\n── (12) display text inside a reference is not scanned for hand-typed handles ──");
  [s] = await api("PATCH", `/api/collections/users/records/${jones_id}`, jones, {
    name: "Bob @bram",
  });
  check("a member sets his OWN display name to 'Bob @bram' → 200", s, 200);
  check(
    "the self-rename really landed",
    (await api("GET", `/api/collections/users/records/${jones_id}`, su))[1].name ?? null,
    "Bob @bram",
  );
  const [T12, s12] = await probe_comment(
    "display-name-amplify",
    `hi ${ref("Bob @bram", jones_id)} please look`,
  );
  check("the picker inserts that name as the bracket text → 200", s12, 200);
  check("exactly ONE {Bob Jones,mentioned} row", await n_mentions("task", T12, jones_id), 1);
  check(
    "the member his display name spells is NOT notified",
    await n_mentions("task", T12, bram_id),
    0,
  );
  check("…so the comment carries exactly one mention row", await n_mentions("task", T12), 1);
  let doc12: any;
  [s, doc12] = await api("POST", "/api/collections/documents/records", ada, {
    title: "amplify-doc",
    workspace: WS,
    body: `see ${ref("Bob @bram", jones_id)}`,
  });
  check("the same name in ITEM prose → 200", s, 200);
  const DOC12 = doc12.id ?? null;
  check(
    "exactly ONE {Bob Jones,mentioned} row on the document",
    await n_mentions("document", DOC12, jones_id),
    1,
  );
  check(
    "the member his display name spells is NOT notified",
    await n_mentions("document", DOC12, bram_id),
    0,
  );
  check("…so the document carries exactly one mention row", await n_mentions("document", DOC12), 1);
  // The owner ruling is that the fallback keeps working on everything OUTSIDE a reference.
  const [T12B, s12b] = await probe_comment(
    "amplify-plus-fallback",
    `${ref("Bob @bram", jones_id)} and cc @bram directly`,
  );
  check("a body with a reference AND a hand-typed handle outside it → 200", s12b, 200);
  check("the referenced member is notified", await n_mentions("task", T12B, jones_id), 1);
  check(
    "the hand-typed handle OUTSIDE the reference still notifies",
    await n_mentions("task", T12B, bram_id),
    1,
  );
  check("…exactly two rows, no more", await n_mentions("task", T12B), 2);

  // ═══════════ (13) THE ID PATH HONOURS MEMBERSHIP STATUS ════════════════════
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:comments
  // COVERS: hook:notify.pb.js#onRecordCreateRequest:documents
  console.log(
    "\n── (13) a suspended member or a pending invitee does not resolve through the id grammar ──",
  );
  const [, eve_id] = await make_user("Eve Suspended", "eve@example.com");
  const [, finn_id] = await make_user("Finn Invited", "finn@example.com");
  [s] = await api("POST", "/api/collections/workspace_members/records", su, {
    workspace: WS,
    user: eve_id,
    role: "member",
    status: "suspended",
  });
  check("Eve holds a suspended membership row in the workspace", s, 200);
  // decision:invitation-keyed-by-email: a pending invitee holds NO membership row — a pending workspace_invitations
  // row for Finn's address instead (workspace_members.createRule is null; only R3 mints one).
  [s] = await api("POST", "/api/collections/workspace_invitations/records", su, {
    workspace: WS,
    email: "finn@example.com",
    role: "member",
  });
  check("Finn holds a pending invitation, no membership row", s, 200);
  const [T13, s13] = await probe_comment(
    "status-gated-ids",
    `${ref("Eve", eve_id)} ${ref("Finn", finn_id)} ${ref("Bram", bram_id)}`,
  );
  check("a comment naming a suspended, an invited and an ACTIVE member by id → 200", s13, 200);
  check("the SUSPENDED member gets nothing", await n_mentions("task", T13, eve_id), 0);
  check("the PENDING invitee gets nothing", await n_mentions("task", T13, finn_id), 0);
  check(
    "the active member in the same body IS notified (the control)",
    await n_mentions("task", T13, bram_id),
    1,
  );
  check("…so exactly one mention row on the task", await n_mentions("task", T13), 1);
  let doc13: any;
  [s, doc13] = await api("POST", "/api/collections/documents/records", ada, {
    title: "status-gated-doc",
    workspace: WS,
    body: `${ref("Eve", eve_id)} ${ref("Finn", finn_id)} ${ref("Bram", bram_id)}`,
  });
  check("the same three references in ITEM prose → 200", s, 200);
  const DOC13 = doc13.id ?? null;
  check("the SUSPENDED member gets nothing", await n_mentions("document", DOC13, eve_id), 0);
  check("the PENDING invitee gets nothing", await n_mentions("document", DOC13, finn_id), 0);
  check("the active member IS notified", await n_mentions("document", DOC13, bram_id), 1);
  check("…so exactly one mention row on the document", await n_mentions("document", DOC13), 1);

  // ═══════════ (14) CODE — code spans and fences do not name members ═════════
  console.log("\n── (14) code syntax is inert; the same mention in prose still notifies ──");
  const stable = ref("Bram", bram_id);
  const tick = String.fromCodePoint(96);
  const cases: [string, string, string, string, string][] = [
    ["task create", "task", "create", tick + stable + tick, stable],
    ["task update", "task", "update", tick.repeat(3) + "\n@bram\n" + tick.repeat(3), "@bram"],
    ["document create", "document", "create", tick + "@bram" + tick, "@bram"],
    ["document update", "document", "update", "~~~\n" + stable + "\n~~~", stable],
    ["decision create", "decision", "create", tick.repeat(2) + stable + tick.repeat(2), stable],
    [
      "decision update",
      "decision",
      "update",
      tick.repeat(3) + "\n@bram\n" + tick.repeat(3),
      "@bram",
    ],
  ];
  let rid: any;
  for (const [label, kind, mode, coded, prose] of cases) {
    let rec: any;
    let rel: string;
    let made: any;
    if (kind === "task") {
      if (mode === "create") {
        [s, rec] = await api("POST", "/api/collections/tasks/records", ada, {
          title: label,
          project: PROJECT,
          description: coded,
        });
      } else {
        rid = await new_task(label);
        [s, rec] = await api("PATCH", `/api/collections/tasks/records/${py_str(rid)}`, ada, {
          description: coded,
        });
      }
      rel = "task";
    } else if (kind === "document") {
      if (mode === "create") {
        [s, rec] = await api("POST", "/api/collections/documents/records", ada, {
          title: label,
          workspace: WS,
          body: coded,
        });
      } else {
        [, made] = await api("POST", "/api/collections/documents/records", ada, {
          title: label,
          workspace: WS,
        });
        rid = getitem(made, "id");
        [s, rec] = await api("PATCH", `/api/collections/documents/records/${rid}`, ada, {
          body: coded,
        });
      }
      rel = "document";
    } else {
      if (mode === "create") {
        [s, rec] = await api("POST", "/api/collections/decisions/records", ada, {
          title: label,
          workspace: WS,
          context: coded,
        });
      } else {
        [, made] = await api("POST", "/api/collections/decisions/records", ada, {
          title: label,
          workspace: WS,
        });
        rid = getitem(made, "id");
        [s, rec] = await api("PATCH", `/api/collections/decisions/records/${rid}`, ada, {
          context: coded,
        });
      }
      rel = "decision";
    }
    rid = truthy(rec.id ?? null) ? rec.id : rid;
    check(`${label}: code body writes → 200`, s, 200);
    check(`${label}: code body resolves nobody`, await n_mentions(rel, rid), 0);
    const field = rel === "task" ? "description" : rel === "document" ? "body" : "context";
    [s] = await api("PATCH", `/api/collections/${rel}s/records/${py_str(rid)}`, ada, {
      [field]: prose,
    });
    check(`${label}: same text outside code → 200`, s, 200);
    check(`${label}: same text outside code notifies Bram`, await n_mentions(rel, rid, bram_id), 1);
  }

  for (const [label, mode, coded, prose] of [
    ["comment create", "create", tick + stable + tick, stable],
    ["comment update", "update", "~~~\n@bram\n~~~", "@bram"],
  ]) {
    const task = await new_task(label);
    let comment: any;
    [s, comment] = await comment_on(task, mode === "create" ? coded : "plain");
    if (mode === "update") {
      [s] = await api("PATCH", `/api/collections/comments/records/${py_str(comment)}`, ada, {
        body: coded,
      });
    }
    check(`${label}: code body writes → 200`, s, 200);
    check(`${label}: code body resolves nobody`, await n_mentions("task", task), 0);
    [s] = await api("PATCH", `/api/collections/comments/records/${py_str(comment)}`, ada, {
      body: prose,
    });
    check(`${label}: same text outside code → 200`, s, 200);
    check(
      `${label}: same text outside code notifies Bram`,
      await n_mentions("task", task, bram_id),
      1,
    );
  }

  for (const [label, fields, expected] of [
    [
      "decision fences do not cross fields",
      { context: "ordinary context", decision: "~~~\n@bram\n~~~" },
      0,
    ],
    [
      "decision inline delimiters do not cross fields",
      { context: tick, decision: "@bram" + tick },
      1,
    ],
  ] as [string, Record<string, string>, number][]) {
    let decision: any;
    [s, decision] = await api("POST", "/api/collections/decisions/records", ada, {
      title: label,
      workspace: WS,
      ...fields,
    });
    check(`${label}: decision writes → 200`, s, 200);
    check(
      `${label}: exact field boundary handling`,
      await n_mentions("decision", getitem(decision, "id"), bram_id),
      expected,
    );
  }

  for (const [label, body, expected] of [
    ["indented tilde fence", "  ~~~\n@bram\n  ~~~", 0],
    ["unclosed fence", tick.repeat(3) + "\n@bram", 0],
    ["longer fence closer", "~~~\n@bram\n~~~~", 0],
    ["multiline inline", tick + "before\n@bram\nafter" + tick, 0],
    [
      "double inline embeds single",
      tick.repeat(2) + "one " + tick + " mark @bram" + tick.repeat(2),
      0,
    ],
    ["unequal delimiters leave prose", tick + " @bram " + tick.repeat(2), 1],
    ["four-space pseudo-fence leaves prose", "    ~~~\n@bram\n    ~~~", 1],
    [
      "backtick in fence info leaves prose",
      tick.repeat(3) + " info " + tick + "\n@bram\n" + tick.repeat(3),
      1,
    ],
    ["inline delimiters do not cross paragraphs", tick + "\n\n@bram\n\n" + tick, 1],
    ["escaped opening backtick leaves prose", "\\" + tick + "@bram" + tick, 1],
  ] as [string, string, number][]) {
    const [task, s14] = await probe_comment(label, body);
    check(`${label}: comment writes → 200`, s14, 200);
    check(`${label}: exact delimiter handling`, await n_mentions("task", task, bram_id), expected);
  }

  // ═══════════ (D) DISMISSAL — a dismissed mention is still a sent mention (card vx7y) ═══
  // COVERS: rule:notifications.delete, rule:notifications.update, rule:notifications.list
  // COVERS: hook:notify.pb.js#onRecordUpdateRequest:tasks
  // COVERS: route:POST /api/tracker/notifications/read-all
  console.log("\n── (D) dismissal marks the row; the fan-out still counts it as sent ──");

  async function kind_rows(kind: string, task_id: any, user_id: any): Promise<any[]> {
    const qs = urlencode({
      filter: `task='${py_str(task_id)}' && user='${py_str(user_id)}' && kind='${kind}'`,
      perPage: 200,
    });
    return (await api("GET", `/api/collections/notifications/records?${qs}`, su))[1].items || [];
  }

  async function su_row(row_id: any): Promise<any> {
    return (await api("GET", `/api/collections/notifications/records/${py_str(row_id)}`, su))[1];
  }

  async function inbox_ids(tok: string): Promise<any[]> {
    const [, r] = await api("GET", "/api/collections/notifications/records?perPage=500", tok);
    return (r.items || []).map((x: any) => getitem(x, "id"));
  }

  async function dismiss_own_mention(label: string, task_id: any): Promise<any> {
    // Bram tries DELETE (refused), then dismisses; returns the mention row id.
    const rows = await mention_rows("task", task_id, bram_id);
    const row = rows.length ? rows[0].id : null;
    check(`${label}: Bram holds ONE item-prose mention row`, rows.length, 1);
    let s: number;
    let body: any;
    [s] = await api("DELETE", `/api/collections/notifications/records/${py_str(row)}`, bram);
    check(`${label}: Bram DELETE his own mention → 403 (no client may delete)`, s, 403);
    check(
      `${label}: …and the row still exists (superuser count)`,
      await n_mentions("task", task_id, bram_id),
      1,
    );
    [s, body] = await api("PATCH", `/api/collections/notifications/records/${py_str(row)}`, bram, {
      dismissed: true,
    });
    check(`${label}: Bram PATCH {dismissed:true} → 200`, s, 200);
    check(`${label}: …and the PATCH answers with the dismissed row`, body.dismissed ?? null, true);
    check(`${label}: Bram inbox no longer lists it`, (await inbox_ids(bram)).includes(row), false);
    check(
      `${label}: …the dismiss PATCH answers the whole row`,
      ["id", "kind", "task", "user", "workspace", "read"].every((k) => Object.hasOwn(body, k)),
      true,
    );
    [s] = await api("GET", `/api/collections/notifications/records/${py_str(row)}`, bram);
    check(`${label}: Bram GET the dismissed row by id → 404`, s, 404);
    [s, body] = await api("PATCH", `/api/collections/notifications/records/${py_str(row)}`, bram, {
      dismissed: false,
    });
    check(
      `${label}: Bram PATCH {dismissed:false} → 200`,
      tup(s, body.dismissed ?? null),
      tup(200, false),
    );
    check(
      `${label}: …and the undismissed row is listed again`,
      (await inbox_ids(bram)).includes(row),
      true,
    );
    [s, body] = await api("PATCH", `/api/collections/notifications/records/${py_str(row)}`, bram, {
      dismissed: true,
    });
    check(
      `${label}: Bram dismisses it again → 200`,
      tup(s, body.dismissed ?? null),
      tup(200, true),
    );
    check(`${label}: …and it leaves the list again`, (await inbox_ids(bram)).includes(row), false);
    check(
      `${label}: superuser still sees it, dismissed`,
      (await su_row(row)).dismissed ?? null,
      true,
    );
    return row;
  }

  const TD = await new_task("dismiss-then-reassign");
  [s] = await api("PATCH", `/api/collections/tasks/records/${py_str(TD)}`, ada, {
    description: `see ${ref("Bram Vale", bram_id)}`,
  });
  check("Ada names Bram in the description → 200", s, 200);
  const TD_ROW = await dismiss_own_mention("reassign", TD);

  // A row Bram does not own: Ada's mention, raised by Bram's comment.
  [s] = await api("POST", "/api/collections/comments/records", bram, {
    task: TD,
    author: bram_id,
    body: `cc ${ref("Ada", ada_id)}`,
  });
  check("Bram comments naming Ada → 200", s, 200);
  const ada_rows = await mention_rows("task", TD, ada_id);
  const ADA_ROW = ada_rows.length ? ada_rows[0].id : null;
  check("Ada holds ONE mention row from that comment", ada_rows.length, 1);
  [s] = await api("PATCH", `/api/collections/notifications/records/${py_str(ADA_ROW)}`, bram, {
    dismissed: true,
  });
  check("Bram PATCH {dismissed:true} on Ada's row → 404", s, 404);
  check("…and Ada's row is not dismissed", (await su_row(ADA_ROW)).dismissed ?? null, false);
  [s] = await api("DELETE", `/api/collections/notifications/records/${py_str(ADA_ROW)}`, ada);
  check("Ada DELETE her own mention → 403", s, 403);
  [s] = await api("PATCH", `/api/collections/notifications/records/${py_str(TD_ROW)}`, bram, {
    kind: "assigned",
  });
  check("Bram PATCH {kind} on his dismissed row → still refused 404", s, 404);
  check("…and its kind is unchanged", (await su_row(TD_ROW)).kind ?? null, "mentioned");

  [s] = await api("PATCH", `/api/collections/tasks/records/${py_str(TD)}`, ada, {
    assignee: bram_id,
  });
  check("Ada reassigns the task to Bram, prose untouched → 200", s, 200);
  check(
    "superuser: exactly ONE item-prose {Bram,mentioned} row (no resurrection)",
    (await mention_rows("task", TD, bram_id)).filter((x) => !truthy(x.comment ?? null)).length,
    1,
  );
  check(
    "superuser: exactly ONE {Bram,assigned} row",
    (await kind_rows("assigned", TD, bram_id)).length,
    1,
  );

  let sts: any;
  [s, sts] = await api(
    "GET",
    "/api/collections/statuses/records?" +
      urlencode({ filter: `workspace='${WS}' && category='completed'` }),
    su,
  );
  const DONE = ((sts.items || []).length ? sts.items : [{}])[0].id ?? null;
  check("resolved a completed-category status", truthy(DONE), true);
  let t: any;
  [s, t] = await api("POST", "/api/collections/tasks/records", ada, {
    title: "dismiss-then-complete",
    project: PROJECT,
    assignee: bram_id,
  });
  check("Ada creates a task assigned to Bram (subscribes him, no fan-out) → 200", s, 200);
  const TS = t.id ?? null;
  [s] = await api("PATCH", `/api/collections/tasks/records/${py_str(TS)}`, ada, {
    description: `see ${ref("Bram Vale", bram_id)}`,
  });
  check("Ada names Bram in its description → 200", s, 200);
  const TS_ROW = await dismiss_own_mention("complete", TS);
  [s] = await api("PATCH", `/api/collections/tasks/records/${py_str(TS)}`, ada, {
    status: DONE,
  });
  check("Ada moves it to completed, prose untouched → 200", s, 200);
  check("superuser: exactly ONE {Bram,mentioned} row", await n_mentions("task", TS, bram_id), 1);
  check(
    "superuser: exactly ONE {Bram,status_done} row",
    (await kind_rows("status_done", TS, bram_id)).length,
    1,
  );

  const assigned = await kind_rows("assigned", TD, bram_id);
  const ASSIGNED_ROW = assigned.length ? assigned[0].id : null;
  check("the listed assigned row starts unread", (await su_row(ASSIGNED_ROW)).read ?? null, false);
  let listed: any;
  [, listed] = await api("GET", "/api/collections/notifications/records?perPage=500", bram);
  check(
    "the digest counts exactly the LISTED unread rows (two dismissed ones left out)",
    digest_unread(bram_id),
    (listed.items || []).filter((x: any) => !truthy(x.read ?? null)).length,
  );
  [s] = await api("POST", "/api/tracker/notifications/read-all", bram);
  check("Bram read-all → 200", s, 200);
  check(
    "read-all marks the LISTED assigned row read",
    (await su_row(ASSIGNED_ROW)).read ?? null,
    true,
  );
  check(
    "read-all leaves the dismissed reassign mention unread",
    (await su_row(TD_ROW)).read ?? null,
    false,
  );
  check(
    "read-all leaves the dismissed complete mention unread",
    (await su_row(TS_ROW)).read ?? null,
    false,
  );

  console.log("\n" + "═".repeat(90));
  console.log(failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`);
} finally {
  await stop_server(server);
  fs.rmSync(S, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);

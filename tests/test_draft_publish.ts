#!/usr/bin/env bun
/**
 * decision:draft-private-publish-one-way: a draft is private to its author, the workspace owner and active admins, and Publish is one-way.
 *
 * Two claims, one room.
 *
 * §1-§3 the READ matrix, for decisions, documents and milestones alike, on the three surfaces
 * a draft can leak through: the `project_items` view (list and single view), the base
 * collection (list and single view), and GET /api/tracker/trash — which is also the one
 * surface that EXPANDS a relation, so §3 reads the milestone hanging off a trashed task
 * through the same matrix. Seven callers: the item's
 * author, the workspace owner and an ACTIVE admin read a draft; a plain active member, an
 * active viewer, a member whose invitation is still pending and a stranger with no membership
 * do not.
 *
 * Every negative caller carries a positive control in the same run, because a run against a
 * server answering 404 to everything would otherwise pass: each one's token is proven to
 * authenticate as that person, the active members read the PUBLISHED sibling of the very item
 * they were refused, the invited member accepts her invitation and then reads that sibling
 * while the draft stays shut (§4), and the stranger reads a published item in a workspace he
 * owns (§5). tests/test_visibility_invariants.ts owns the plain-member, viewer and suspended
 * tiers on the view and collection surfaces; this suite is the author and owner positives, the
 * invited and stranger negatives, the base-collection and trash surfaces, and §6.
 *
 * §6 the one-way guard (pb_hooks/author.pb.js): create-as-draft and draft->published are
 * allowed; draft->draft and published->draft are refused 400 for the author, the owner and
 * an admin alike, with the refusal read off the WIRE rather than the hook source.
 *
 * Port 8148 + PB_PORT_OFFSET — the 8100+ suite self-boot band (.agents/rules/ports.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  json_dumps,
  py_repr,
  py_str,
  read_text,
  truthy,
  tup,
  url_error_reason,
  urlencode,
  getitem,
} from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const SCHEMA_DIR = path.join(REPO_ROOT, "schema");
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "pb_migrations");
const PB_BIN = roomkit.pb_bin();

const PORT_OFFSET = roomkit.py_int(process.env.PB_PORT_OFFSET ?? "0"); // shifts every port this file binds
const PORT = 8148 + PORT_OFFSET;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SU_EMAIL = "probe@example.com";
const SU_PASSWORD = "probe123456";
const PASSWORD = "test123456";

const SUBJECTS = ["decisions", "documents", "milestones"];

// The exact string decision:draft-private-publish-one-way §4 refuses with, as PocketBase puts it on the wire.
const REFUSAL = "A published item cannot be returned to draft. Move it to trash instead.";

// caller -> (membership role, membership status) in the subject workspace; None is no row at
// all. The owner holds the workspace, which is a standing of its own, not a membership role.
const CALLERS: Record<string, [string | null, string | null]> = {
  author: tup("member", "active"),
  owner: tup(null, null),
  admin: tup("admin", "active"),
  member: tup("member", "active"),
  viewer: tup("viewer", "active"),
  invited: tup(null, null), // no membership row — a pending workspace_invitations row instead
  stranger: tup(null, null),
};
const WHO: Record<string, string> = {
  author: "Ana",
  owner: "Olive",
  admin: "Ada",
  member: "Mia",
  viewer: "Vic",
  invited: "Ivy",
  stranger: "Nate",
};
// decision:draft-private-publish-one-way §2 — the whole read set for a draft, and nobody else.
const CAN_READ_DRAFT = new Set(["author", "owner", "admin"]);
// Everyone the workspace lets read a PUBLISHED item: the draft negatives' positive control.
const CAN_READ_PUBLISHED = new Set(["author", "owner", "admin", "member", "viewer"]);

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
    return roomkit.die_no_server(BASE_URL, { reason: url_error_reason(e) });
  }
  return [r.status, raw ? JSON.parse(raw) : {}]; // 204 -> empty body
}

/** The collection's own headline field, read off schema/ rather than hand-listed. */
function title_field(collection: string): string {
  const names = new Set<string>(
    getitem(JSON.parse(read_text(path.join(SCHEMA_DIR, `${collection}.json`))), "fields").map(
      (f: any) => getitem(f, "name"),
    ),
  );
  for (const candidate of ["title", "name"]) {
    if (names.has(candidate)) return candidate;
  }
  throw new roomkit.SystemExit(
    `❌ FIXTURE: ${collection} carries neither a title nor a name field`,
  );
}

async function superuser_token(): Promise<string> {
  const [, r] = await api("POST", "/api/collections/_superusers/auth-with-password", null, {
    identity: SU_EMAIL,
    password: SU_PASSWORD,
  });
  const tok = r.token ?? null;
  if (!tok) {
    throw new roomkit.SystemExit(`❌ superuser auth failed: ${py_str(r)}`);
  }
  return tok;
}

// ── Scratch tree + boot ──────────────────────────────────────────────────────────────────
const S = fs.mkdtempSync(path.join(os.tmpdir(), "pb-draft-publish-test-"));
const MIG_DIR = path.join(S, "pb_migrations");
const DATA_DIR = path.join(S, "pb_data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.cpSync(REAL_MIGRATIONS_DIR, MIG_DIR, { recursive: true, dereference: true });
for (const name of fs.readdirSync(MIG_DIR)) {
  if (name.endsWith("superuser_mfa.js")) fs.rmSync(path.join(MIG_DIR, name));
}

let server: roomkit.Room | null = null;
try {
  const up = Bun.spawnSync(
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
    { cwd: REPO_ROOT },
  );
  if (up.exitCode !== 0) {
    throw new Error(`Command failed with exit status ${up.exitCode}: ${up.stderr.toString()}`);
  }
  server = await roomkit.serve(PORT, DATA_DIR, MIG_DIR, roomkit.hooks_dir(S));
  const su = await superuser_token();
  tierkit.use(api);

  let s: number;
  let body: any;

  // ══════════════ fixtures ═════════════════════════════════════════════════════════════
  console.log(
    "\n── fixtures: author / owner / active admin / member / viewer / invited / stranger ──",
  );

  const make_user = async (who: string): Promise<[string, string]> => {
    const email = `${who.toLowerCase()}@example.com`;
    const [s, rec] = await api("POST", "/api/collections/users/records", su, {
      email: email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name: who,
      verified: true,
    });
    if (![200, 201].includes(s)) {
      throw new roomkit.SystemExit(
        `❌ FIXTURE: user ${email} could not be created: HTTP ${s} ${py_str(rec)}`,
      );
    }
    await api("PATCH", `/api/collections/users/records/${getitem(rec, "id")}`, su, {
      approved: true,
    });
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    return [roomkit.token_of(BASE_URL, email, auth), getitem(rec, "id")];
  };

  const TOKEN: Record<string, string> = {};
  const USER: Record<string, string> = {};
  for (const caller of Object.keys(CALLERS)) {
    [TOKEN[caller], USER[caller]] = await make_user(WHO[caller]!);
  }

  let ws: any;
  [s, ws] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "Publish WS",
    owner: USER.owner,
  });
  if (![200, 201].includes(s)) {
    throw new roomkit.SystemExit(
      `❌ FIXTURE: workspace could not be created: HTTP ${s} ${py_str(ws)}`,
    );
  }
  const WS: string = getitem(ws, "id");
  let prj: any;
  [s, prj] = await api("POST", "/api/collections/projects/records", su, {
    name: "Publish Project",
    owner: USER.owner,
    workspace: WS,
  });
  if (![200, 201].includes(s)) {
    throw new roomkit.SystemExit(
      `❌ FIXTURE: project could not be created: HTTP ${s} ${py_str(prj)}`,
    );
  }
  const PRJ: string = getitem(prj, "id");

  for (const [caller, [role, status]] of Object.entries(CALLERS)) {
    if (role === null) continue;
    // workspace_members.status is active|suspended only (decision:invitation-keyed-by-email); created directly at
    // the target status — pb_hooks/membership_status.pb.js only moves active<->suspended.
    let row: any;
    [s, row] = await api("POST", "/api/collections/workspace_members/records", su, {
      workspace: WS,
      user: USER[caller],
      role: role,
      status: status,
    });
    if (![200, 201].includes(s)) {
      throw new roomkit.SystemExit(
        `❌ FIXTURE: ${WHO[caller]}'s membership: HTTP ${s} ${py_str(row)}`,
      );
    }
  }

  // Ivy holds a PENDING invitation for the whole read matrix below, not a membership row —
  // decision:invitation-keyed-by-email retired self-accept; R3 (§4) is the only path from invitation to membership.
  let ivy_inv: any;
  [s, ivy_inv] = await api("POST", "/api/collections/workspace_invitations/records", su, {
    workspace: WS,
    email: `${WHO.invited!.toLowerCase()}@example.com`,
    role: "member",
  });
  if (![200, 201].includes(s)) {
    throw new roomkit.SystemExit(`❌ FIXTURE: Ivy's invitation: HTTP ${s} ${py_str(ivy_inv)}`);
  }
  const IVY_INVITATION = getitem(ivy_inv, "id");

  // A denial by TENANCY and a denial by ROLE are the same status, so every caller's standing
  // is read back off the server before anything is attacked under it.
  const TIERS: Record<string, tierkit.Tier> = {};
  for (const [caller, [role, status]] of Object.entries(CALLERS)) {
    if (role === null) continue;
    TIERS[caller] = await tierkit.actor_at_tier(WS, USER[caller]!, role, su, WHO[caller]!, status!);
  }
  const OWNS = await tierkit.owner_of_workspace(WS, USER.owner!, su, WHO.owner!);

  console.log("\n── identity: each token authenticates AS the person it is used for ──");
  for (const caller of Object.keys(CALLERS)) {
    let refreshed: any;
    [s, refreshed] = await api("POST", "/api/collections/users/auth-refresh", TOKEN[caller]);
    check(
      `the ${caller} token is ${WHO[caller]}`,
      tup(s, (refreshed.record || {}).id),
      tup(200, USER[caller]),
    );
  }
  check("Olive owns the subject workspace", await OWNS.now(), USER.owner);
  for (const [caller, tier] of Object.entries(TIERS)) {
    check(
      `${WHO[caller]} stands at ${CALLERS[caller]![0]}/${CALLERS[caller]![1]}`,
      tup(...(await tier.standing())),
      CALLERS[caller],
    );
  }
  let qs = urlencode({ filter: `workspace='${WS}' && user='${USER.invited}'` });
  const [, ivy_rows] = await api("GET", `/api/collections/workspace_members/records?${qs}`, su);
  check("Ivy holds no membership row while her invitation is pending", ivy_rows.items, []);

  // ══════════════ items: a live pair and a trashed pair per collection ════════════════
  console.log("\n── fixtures: Ana authors a draft and a published sibling, live and trashed ──");
  // (collection, kind) -> record id;  kind in draft/published/draft-trashed/published-trashed
  const ITEMS = new Map<string, string>();
  const item = (coll: string, kind: string): string => {
    const v = ITEMS.get(JSON.stringify([coll, kind]));
    if (v === undefined) throw new Error("KeyError: " + py_repr(tup(coll, kind)));
    return v;
  };
  for (const coll of SUBJECTS) {
    const tf = title_field(coll);
    for (const [kind, draft] of [
      ["draft", true],
      ["published", false],
      ["draft-trashed", true],
      ["published-trashed", false],
    ] as [string, boolean][]) {
      let rec: any;
      [s, rec] = await api("POST", `/api/collections/${coll}/records`, TOKEN.author!, {
        [tf]: `DP ${coll} ${kind}`,
        workspace: WS,
        project: PRJ,
        draft: draft,
      });
      if (![200, 201].includes(s)) {
        throw new roomkit.SystemExit(`❌ FIXTURE: ${coll} ${kind}: HTTP ${s} ${py_str(rec)}`);
      }
      check(
        `${coll.padEnd(11)} ${kind.padEnd(18)} created by Ana, draft=${py_str(draft)}`,
        tup(rec.draft, rec.author),
        tup(draft, USER.author),
      );
      ITEMS.set(JSON.stringify([coll, kind]), getitem(rec, "id"));
    }
    for (const kind of ["draft-trashed", "published-trashed"]) {
      [s] = await api(
        "DELETE",
        `/api/collections/${coll}/records/${item(coll, kind)}`,
        TOKEN.author!,
      );
      check(`${coll.padEnd(11)} ${kind.padEnd(18)} trashed by its author → 204`, s, 204);
      let row: any;
      [s, row] = await api("GET", `/api/collections/${coll}/records/${item(coll, kind)}`, su);
      check(
        `${coll.padEnd(11)} ${kind.padEnd(18)} row survives, carrying a trashed stamp`,
        tup(s, truthy(row.trashed)),
        tup(200, true),
      );
    }
  }

  // ══════════════ §1 the project_items view ═══════════════════════════════════════════
  console.log(
    "\n── §1 project_items: a draft reaches only its author, the owner and an active admin ──",
  );
  for (const coll of SUBJECTS) {
    for (const [kind, readers] of [
      ["draft", CAN_READ_DRAFT],
      ["published", CAN_READ_PUBLISHED],
    ] as [string, Set<string>][]) {
      const rid = item(coll, kind);
      for (const caller of Object.keys(CALLERS)) {
        const want = readers.has(caller);
        qs = urlencode({ filter: `id='${rid}'`, perPage: 5 });
        let listed: any;
        [s, listed] = await api(
          "GET",
          `/api/collections/project_items/records?${qs}`,
          TOKEN[caller],
        );
        check(
          `§1 list  ${coll.padEnd(11)} ${kind.padEnd(10)} → ${caller}`,
          tup(
            s,
            (listed.items || []).some((i: any) => i.id === rid),
          ),
          tup(200, want),
        );
        [s] = await api("GET", `/api/collections/project_items/records/${rid}`, TOKEN[caller]);
        check(`§1 view  ${coll.padEnd(11)} ${kind.padEnd(10)} → ${caller}`, s, want ? 200 : 404);
      }
    }
  }

  // ══════════════ §2 the base collections ═════════════════════════════════════════════
  console.log(
    "\n── §2 the base collections: the same verdict, straight at the records endpoint ──",
  );
  for (const coll of SUBJECTS) {
    for (const [kind, readers] of [
      ["draft", CAN_READ_DRAFT],
      ["published", CAN_READ_PUBLISHED],
    ] as [string, Set<string>][]) {
      const rid = item(coll, kind);
      for (const caller of Object.keys(CALLERS)) {
        const want = readers.has(caller);
        qs = urlencode({ filter: `id='${rid}'`, perPage: 5 });
        let listed: any;
        [s, listed] = await api("GET", `/api/collections/${coll}/records?${qs}`, TOKEN[caller]);
        check(
          `§2 list  ${coll.padEnd(11)} ${kind.padEnd(10)} → ${caller}`,
          tup(
            s,
            (listed.items || []).some((i: any) => i.id === rid),
          ),
          tup(200, want),
        );
        [s] = await api("GET", `/api/collections/${coll}/records/${rid}`, TOKEN[caller]);
        check(`§2 view  ${coll.padEnd(11)} ${kind.padEnd(10)} → ${caller}`, s, want ? 200 : 404);
      }
    }
  }

  // ══════════════ §3 the trash route ══════════════════════════════════════════════════
  console.log("\n── §3 GET /api/tracker/trash: trashing a draft must not publish it ──");
  const TRASH_QS = urlencode({ workspace: WS });
  // A trashed TASK is the one row the route EXPANDS, and the expand runs through the
  // superuser-privileged app — so Mia attaches HER OWN task to Ana's live draft milestone
  // and trashes it, which needs no cooperation from the draft's author.
  const TASKS: Record<string, string> = {};
  for (const kind of ["draft", "published"]) {
    const ms = item("milestones", kind);
    let t: any;
    [s, t] = await api("POST", "/api/collections/tasks/records", TOKEN.member!, {
      title: `DP task on the ${kind} milestone`,
      workspace: WS,
      project: PRJ,
      milestone: ms,
    });
    check(
      `§3 Mia attaches her own task to the ${kind.padEnd(9)} milestone → 200`,
      tup(s, t.milestone),
      tup(200, ms),
    );
    TASKS[kind] = getitem(t, "id");
    [s] = await api("DELETE", `/api/collections/tasks/records/${getitem(t, "id")}`, TOKEN.member!);
    check("§3 …and trashes that task → 204", s, 204);
  }

  for (const caller of Object.keys(CALLERS)) {
    [s, body] = await api("GET", `/api/tracker/trash?${TRASH_QS}`, TOKEN[caller]);
    // The route scopes by hand and answers a non-active caller 403, never a filtered 200.
    if (CAN_READ_PUBLISHED.has(caller)) {
      const served = new Map<any, any>();
      for (const i of body.items || []) {
        const record = i.record ?? {};
        served.set(record.id, record);
      }
      const ids = new Set(served.keys());
      check(`§3 route  → ${caller} is served the workspace trash`, s, 200);
      for (const kind of ["draft", "published"]) {
        check(
          `§3 trash task on the ${kind.padEnd(9)} milestone → ${caller}`,
          ids.has(TASKS[kind]),
          true,
        );
        const got = ((served.get(TASKS[kind]) ?? {}).expand ?? {}).milestone ?? {};
        // An ABSENT expand entry is the hidden state, the shape the app tier already
        // serves for a relation its caller cannot read.
        const want =
          kind === "published" || CAN_READ_DRAFT.has(caller)
            ? tup(item("milestones", kind), `DP milestones ${kind}`)
            : tup(null, null);
        check(
          `§3 expand ${kind.padEnd(9)} milestone of that task → ${caller}`,
          tup(got.id ?? null, got.name ?? null),
          want,
        );
      }
      for (const coll of SUBJECTS) {
        check(
          `§3 trash ${coll.padEnd(11)} draft      → ${caller}`,
          ids.has(item(coll, "draft-trashed")),
          CAN_READ_DRAFT.has(caller),
        );
        check(
          `§3 trash ${coll.padEnd(11)} published  → ${caller}`,
          ids.has(item(coll, "published-trashed")),
          true,
        );
      }
    } else {
      check(`§3 route  → ${caller} holds no active membership → 403`, s, 403);
    }
  }

  // ══════════════ §4 the invited member's control ═════════════════════════════════════
  console.log(
    "\n── §4 control: Ivy accepts her invitation via R3 — the published sibling opens, the draft does not ──",
  );
  let acc: any;
  [s, acc] = await api("POST", `/api/tracker/invitations/${IVY_INVITATION}/accept`, TOKEN.invited!);
  check(
    "Ivy accepts her invitation (R3) → 200, new active member row, role from the invitation",
    tup(s, acc.workspace, acc.role, acc.status),
    tup(200, WS, "member", "active"),
  );
  const ivy = await tierkit.actor_at_tier(WS, USER.invited!, "member", su, "Ivy", "active");
  check("Ivy now stands at member/active", tup(...(await ivy.standing())), tup("member", "active"));
  for (const coll of SUBJECTS) {
    [s] = await api(
      "GET",
      `/api/collections/${coll}/records/${item(coll, "published")}`,
      TOKEN.invited!,
    );
    check(`§4 ${coll.padEnd(11)} published → the now-active Ivy`, s, 200);
    [s] = await api(
      "GET",
      `/api/collections/${coll}/records/${item(coll, "draft")}`,
      TOKEN.invited!,
    );
    check(`§4 ${coll.padEnd(11)} draft     → the now-active Ivy`, s, 404);
    [s] = await api(
      "GET",
      `/api/collections/project_items/records/${item(coll, "draft")}`,
      TOKEN.invited!,
    );
    check(`§4 ${coll.padEnd(11)} draft     → the now-active Ivy, through the view`, s, 404);
  }
  [s, body] = await api("GET", `/api/tracker/trash?${TRASH_QS}`, TOKEN.invited!);
  let ids = new Set((body.items || []).map((i: any) => (i.record ?? {}).id));
  check("§4 the now-active Ivy is served the workspace trash", s, 200);
  for (const coll of SUBJECTS) {
    check(
      `§4 trash ${coll.padEnd(11)} published → the now-active Ivy`,
      ids.has(item(coll, "published-trashed")),
      true,
    );
    check(
      `§4 trash ${coll.padEnd(11)} draft     → the now-active Ivy`,
      ids.has(item(coll, "draft-trashed")),
      false,
    );
  }

  // ══════════════ §5 the stranger's control ═══════════════════════════════════════════
  console.log(
    "\n── §5 control: the stranger's token performs real reads in a workspace he owns ──",
  );
  let nws: any;
  [s, nws] = await api("POST", "/api/collections/workspaces/records", su, {
    name: "Nate WS",
    owner: USER.stranger,
  });
  check("a workspace owned by Nate → 200", s, 200);
  let ndec: any;
  [s, ndec] = await api("POST", "/api/collections/decisions/records", TOKEN.stranger!, {
    title: "DP stranger control",
    workspace: getitem(nws, "id"),
    draft: false,
  });
  check("Nate publishes a decision in his own workspace → 200", s, 200);
  [s] = await api("GET", `/api/collections/decisions/records/${ndec.id ?? null}`, TOKEN.stranger!);
  check("…and reads it back → 200, so his 404s above were the rule, not a dead token", s, 200);

  // ══════════════ §6 Publish is one-way ═══════════════════════════════════════════════
  // COVERS: hook:author.pb.js#onRecordUpdateRequest:decisions, hook:author.pb.js#onRecordUpdateRequest:documents, hook:author.pb.js#onRecordUpdateRequest:milestones
  console.log(
    "\n── §6 decision:draft-private-publish-one-way §4: the published-to-draft direction is refused ──",
  );
  for (const coll of SUBJECTS) {
    const tf = title_field(coll);
    let made: any;
    [s, made] = await api("POST", `/api/collections/${coll}/records`, TOKEN.author!, {
      [tf]: `DP ${coll} oneway`,
      workspace: WS,
      project: PRJ,
      draft: true,
    });
    check(
      `§6 ${coll.padEnd(11)} create with draft=true → allowed`,
      tup(s, made.draft),
      tup(200, true),
    );
    const rid = getitem(made, "id");
    let born: any;
    [s, born] = await api("POST", `/api/collections/${coll}/records`, TOKEN.author!, {
      [tf]: `DP ${coll} born-published`,
      workspace: WS,
      project: PRJ,
      draft: false,
    });
    check(
      `§6 ${coll.padEnd(11)} create with draft=false → allowed`,
      tup(s, born.draft),
      tup(200, false),
    );

    let kept: any;
    [s, kept] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, TOKEN.author!, {
      draft: true,
    });
    check(
      `§6 ${coll.padEnd(11)} draft → draft → refused (one-way)`,
      tup(s, kept.message),
      tup(400, "A published item cannot be returned to draft. Move it to trash instead."),
    );
    let pub: any;
    [s, pub] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, TOKEN.author!, {
      draft: false,
    });
    check(
      `§6 ${coll.padEnd(11)} draft → published (Publish) → allowed`,
      tup(s, pub.draft),
      tup(200, false),
    );

    // Every caller the update rule admits, so the refusal is the guard's and not the rule's.
    for (const caller of ["author", "owner", "admin"]) {
      let err: any;
      [s, err] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, TOKEN[caller], {
        draft: true,
      });
      check(`§6 ${coll.padEnd(11)} published → draft by ${caller} → 400`, s, 400);
      check(
        `§6 ${coll.padEnd(11)} …refused on the wire with the product wording, to ${caller}`,
        err.message,
        REFUSAL,
      );
    }
    let still: any;
    [s, still] = await api("GET", `/api/collections/${coll}/records/${rid}`, TOKEN.author!);
    check(
      `§6 ${coll.padEnd(11)} …and the item is still published`,
      tup(s, still.draft),
      tup(200, false),
    );

    // decision:draft-private-publish-one-way §4 refuses the whole write, so an edit bundled into it rolls back too.
    [s] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, TOKEN.author!, {
      [tf]: `DP ${coll} smuggled`,
      draft: true,
    });
    check(`§6 ${coll.padEnd(11)} a title bundled with draft=true → 400`, s, 400);
    let intact: any;
    [s, intact] = await api("GET", `/api/collections/${coll}/records/${rid}`, TOKEN.author!);
    check(
      `§6 ${coll.padEnd(11)} …and the bundled title never landed`,
      tup(s, intact[tf], intact.draft),
      tup(200, still[tf], false),
    );

    // An ordinary edit that carries no draft key is untouched by the guard.
    let edited: any;
    [s, edited] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, TOKEN.author!, {
      [tf]: `DP ${coll} oneway renamed`,
    });
    check(
      `§6 ${coll.padEnd(11)} an edit carrying no draft key → allowed`,
      tup(s, edited.draft),
      tup(200, false),
    );

    // decision:draft-private-publish-one-way §4 exempts only a superuser, because seeding and import are superuser
    // writes; every other caller is refused, direct collection writes included.
    [s] = await api("PATCH", `/api/collections/${coll}/records/${rid}`, su, { draft: true });
    check(
      `§6 ${coll.padEnd(11)} published → draft by a SUPERUSER → allowed (declared exemption)`,
      s,
      200,
    );
  }

  // ══════════════ §7 comments on a draft: the comments rules close the leak ════════
  // COVERS: rule:comments.list, rule:comments.view, rule:comments.create, rule:comments.update, rule:comments.delete
  console.log(
    "\n── §7 comments on a draft decision/document are scoped to the item's own read set ──",
  );

  // The draft clause is what refuses member, viewer and invited-now-active (the "invited"
  // caller accepted in §4, so she is an active plain member here). pending, suspended-admin
  // and stranger are controls: the base membership gate refuses them with or without it.
  const make_seven_fixture = async (
    who: string,
    email: string,
    role: string,
    status: string,
  ): Promise<[string, string]> => {
    const [s, u] = await api("POST", "/api/collections/users/records", su, {
      email: email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      name: who,
      verified: true,
    });
    check(`§7 fixture: ${who} (${role}/${status}) created → 200`, s, 200);
    await api("PATCH", `/api/collections/users/records/${getitem(u, "id")}`, su, {
      approved: true,
    });
    const [, auth] = await api("POST", "/api/collections/users/auth-with-password", null, {
      identity: email,
      password: PASSWORD,
    });
    if (status === "pending") {
      // decision:invitation-keyed-by-email: a pending invitee holds NO membership row at all.
      const [s] = await api("POST", "/api/collections/workspace_invitations/records", su, {
        workspace: WS,
        email: email,
        role: role,
      });
      check(`§7 fixture: ${who}'s pending invitation seeded → 200`, s, 200);
    } else {
      const [s] = await api("POST", "/api/collections/workspace_members/records", su, {
        workspace: WS,
        user: getitem(u, "id"),
        role: role,
        status: status,
      });
      check(`§7 fixture: ${who}'s ${status} membership seeded → 200`, s, 200);
    }
    return [roomkit.token_of(BASE_URL, email, auth), getitem(u, "id")];
  };

  const [PENDING_TOKEN] = await make_seven_fixture("Pia", "pia@example.com", "member", "pending");
  const [SUSPENDED_TOKEN] = await make_seven_fixture(
    "Sasha",
    "sasha@example.com",
    "admin",
    "suspended",
  );

  // Truthful roster for the §7 read matrix: "invited" is relabeled to say what she now is.
  const SEVEN_READERS: Record<string, string> = {
    author: TOKEN.author!,
    owner: TOKEN.owner!,
    admin: TOKEN.admin!,
    member: TOKEN.member!,
    viewer: TOKEN.viewer!,
    "invited-now-active": TOKEN.invited!,
    pending: PENDING_TOKEN,
    "suspended-admin": SUSPENDED_TOKEN,
    stranger: TOKEN.stranger!,
  };
  const SEVEN_CAN_READ_DRAFT = new Set(["author", "owner", "admin"]);

  const COMMENT_FIELD: Record<string, string> = { decisions: "decision", documents: "document" };
  for (const coll of ["decisions", "documents"]) {
    const field = COMMENT_FIELD[coll]!;
    const tf = title_field(coll);
    let it: any;
    [s, it] = await api("POST", `/api/collections/${coll}/records`, TOKEN.author!, {
      [tf]: `DP ${coll} comment-privacy`,
      workspace: WS,
      project: PRJ,
      draft: true,
    });
    check(
      `§7 ${coll.padEnd(11)} a fresh draft for the comment-privacy checks → 200`,
      tup(s, it.draft),
      tup(200, true),
    );
    const item_id = getitem(it, "id");

    const leak = `LEAK-${coll}-COMMENT-${item_id}`;
    let com: any;
    [s, com] = await api("POST", "/api/collections/comments/records", TOKEN.author!, {
      body: leak,
      [field]: item_id,
    });
    check(
      `§7 ${coll.padEnd(11)} author comments on own draft (positive control) → 200`,
      tup(s, com.body),
      tup(200, leak),
    );
    const comment_id = getitem(com, "id");

    // AC1: single view, a filtered list, and an UNFILTERED list, for every caller.
    for (const [caller, token] of Object.entries(SEVEN_READERS)) {
      const want = SEVEN_CAN_READ_DRAFT.has(caller);
      [s, body] = await api("GET", `/api/collections/comments/records/${comment_id}`, token);
      check(`§7 ${coll.padEnd(11)} view comment on draft → ${caller}`, s, want ? 200 : 404);
      if (want) {
        check(`§7 ${coll.padEnd(11)} …leak present on view → ${caller}`, body.body, leak);
      }

      qs = urlencode({ filter: `${field}="${item_id}"`, perPage: 50 });
      let listed: any;
      [s, listed] = await api("GET", `/api/collections/comments/records?${qs}`, token);
      const lids = new Set((listed.items || []).map((i: any) => i.id));
      check(
        `§7 ${coll.padEnd(11)} filtered list → ${caller}`,
        tup(s, lids.has(comment_id)),
        tup(200, want),
      );

      let page: any;
      [s, page] = await api("GET", "/api/collections/comments/records?perPage=200", token);
      check(
        `§7 ${coll.padEnd(11)} UNFILTERED list leak ${want ? "present" : "absent"} → ${caller}`,
        json_dumps(page).includes(leak),
        want,
      );
    }

    // AC2: a non-read-set, non-viewer active member is refused, on the wire.
    let err: any;
    [s, err] = await api("POST", "/api/collections/comments/records", TOKEN.member!, {
      body: `${leak}-BLOCKED`,
      [field]: item_id,
    });
    check(
      `§7 ${coll.padEnd(11)} member (active, non-read-set) POST comment on draft → 400`,
      s,
      400,
    );
    check(
      `§7 ${coll.padEnd(11)} …refused with PB's create message`,
      (err.message || "").toLowerCase(),
      "failed to create record.",
    );

    // Positive control: an admin (read-set, non-author) may still comment on the draft. Its
    // comment is a second row on the thread; later checks look only for the author's leak.
    [s] = await api("POST", "/api/collections/comments/records", TOKEN.admin!, {
      body: `${leak}-ADMIN`,
      [field]: item_id,
    });
    check(
      `§7 ${coll.padEnd(11)} admin (read-set, non-author) POST comment on draft → 200 (positive control)`,
      s,
      200,
    );

    // Only the reactions PATCH is refused by the draft clause (a plain member's reactions
    // branch); body PATCH and DELETE are controls, already 404 under the base author/admin gate.
    [s] = await api("PATCH", `/api/collections/comments/records/${comment_id}`, TOKEN.member!, {
      reactions: { "👍": [USER.member] },
    });
    check(`§7 ${coll.padEnd(11)} member PATCH reactions on draft's comment → 404`, s, 404);
    [s] = await api("PATCH", `/api/collections/comments/records/${comment_id}`, TOKEN.member!, {
      body: `${leak}-EDIT-ATTEMPT`,
    });
    check(`§7 ${coll.padEnd(11)} member PATCH body on draft's comment → 404`, s, 404);
    [s] = await api("DELETE", `/api/collections/comments/records/${comment_id}`, TOKEN.member!);
    check(`§7 ${coll.padEnd(11)} member DELETE draft's comment → 404`, s, 404);

    // AC3: publish, then the same previously-refused member reads the pre-publication comment.
    let pub: any;
    [s, pub] = await api("PATCH", `/api/collections/${coll}/records/${item_id}`, TOKEN.author!, {
      draft: false,
    });
    check(
      `§7 ${coll.padEnd(11)} author publishes the item → 200`,
      tup(s, pub.draft),
      tup(200, false),
    );

    [s, body] = await api("GET", `/api/collections/comments/records/${comment_id}`, TOKEN.member!);
    check(
      `§7 ${coll.padEnd(11)} …now-published: member reads the pre-publication comment → 200`,
      s,
      200,
    );
    check(`§7 ${coll.padEnd(11)} …leak present on view → member`, body.body, leak);

    let page: any;
    [s, page] = await api("GET", "/api/collections/comments/records?perPage=200", TOKEN.member!);
    check(
      `§7 ${coll.padEnd(11)} …leak present in UNFILTERED list, no other action → member`,
      json_dumps(page).includes(leak),
      true,
    );

    // Publish widens READ only — the viewer ROLE stays write-excluded regardless of draft.
    [s] = await api("POST", "/api/collections/comments/records", TOKEN.viewer!, {
      body: `${leak}-VIEWER-AFTER-PUBLISH`,
      [field]: item_id,
    });
    check(
      `§7 ${coll.padEnd(11)} …viewer still cannot create after publish (role exclusion) → 400`,
      s,
      400,
    );
  }

  await tierkit.verify_tiers();
} finally {
  if (server !== null) {
    await roomkit.stop(server);
  }
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ all draft-privacy and one-way-publish proofs passed");
process.exit(0);

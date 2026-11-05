#!/usr/bin/env bun
/**
 * Self-check of tierkit's own abort paths — no server, no network.
 *
 * tierkit is what stops a role-tier check being answered by the tenancy guard, so its
 * failure paths carry the same weight as the rules they guard: if one stopped aborting,
 * every suite riding it would still print green. Each path below is driven through a fake
 * transport bound with tierkit.use(), and asserted on the ABORT MESSAGE — a SystemExit
 * with the wrong diagnosis sends the next reader to the wrong fixture.
 */

import { SystemExit } from "./roomkit.ts";
import * as tierkit from "./tierkit.ts";

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
  if (!ok) FAILS.push(label);
}

const WS = "ws000000000000";
const USER = "usr00000000000";
const TOKEN = "fake-owner-token";

type Row = { id: string; role: string; status: string };

function row(role = "admin", status = "active", rid = "mem00000000000"): Row {
  return { id: rid, role, status };
}

// Stands in for a suite's api(method, path, token, body): membership GETs answer from
// `rows`, a workspace record GET answers `owner`/`ws_status`, PATCH reports `patch_status`
// and applies `on_patch`.
class Fake {
  rows: Row[];
  get_status: number;
  patch_status: number;
  on_patch: ((fake: Fake, body: any) => void) | null;
  owner: string;
  ws_status: number;
  calls: [string, string, any][] = [];

  constructor(
    rows: Row[],
    get_status = 200,
    patch_status = 200,
    on_patch: ((fake: Fake, body: any) => void) | null = null,
    owner = USER,
    ws_status = 200,
  ) {
    this.rows = rows;
    this.get_status = get_status;
    this.patch_status = patch_status;
    this.on_patch = on_patch;
    this.owner = owner;
    this.ws_status = ws_status;
  }

  call(method: string, path: string, _token?: string | null, body?: any): [number, any] {
    this.calls.push([method, path, body]);
    if (method === "GET") {
      if (path.includes("/workspaces/records/")) {
        return [this.ws_status, this.ws_status === 200 ? { id: WS, owner: this.owner } : {}];
      }
      return [this.get_status, { items: [...this.rows] }];
    }
    if (method === "PATCH") {
      if (this.on_patch !== null) this.on_patch(this, body);
      return [this.patch_status, {}];
    }
    throw new Error(`tierkit made an unexpected ${method} ${path}`);
  }
}

// Fresh transport AND a cleared registry — _registry is module-global, so a tier left
// behind by one case is re-read by the next one's verify_tiers().
function bind(fake: Fake): Fake {
  tierkit._registry.clear();
  tierkit.use((m, p, t, b) => fake.call(m, p, t, b));
  return fake;
}

// The abort message, or null if the call returned instead of aborting.
async function expect_exit(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof SystemExit) return e.message;
    // a removed abort lets the call run on into a crash
    const err = e as Error;
    check(`aborted, rather than crashing with ${err.name}: ${err.message}`, false);
    return null;
  }
}

function establish(_fake: Fake, role = "admin", status = "active") {
  return tierkit.actor_at_tier(WS, USER, role, TOKEN, "Bob", status);
}

const has = (msg: string | null, s: string): boolean => msg !== null && msg.includes(s);

console.log("── transport not bound ──");
tierkit._registry.clear();
tierkit.use(null);
let msg = await expect_exit(() => tierkit.actor_at_tier(WS, USER, "admin", TOKEN, "Bob"));
check("_call before use() -> SystemExit", msg !== null);
check("names tierkit.use()", has(msg, "tierkit.use("));

console.log("\n── the membership read itself failed ──");
let f = bind(new Fake([], 403));
msg = await expect_exit(() => establish(f));
check("non-200 membership read -> SystemExit", msg !== null);
check("names the HTTP status", has(msg, "HTTP 403"));
check("names the actor", has(msg, "Bob"));

console.log("\n── no membership row at all ──");
f = bind(new Fake([]));
msg = await expect_exit(() => establish(f));
check("no membership row -> SystemExit", msg !== null);
check("says NO membership row", has(msg, "NO membership row"));
check("names the workspace", has(msg, WS));
check("explains the tenancy/role ambiguity", has(msg, "TENANCY guard") && has(msg, "ROLE guard"));

console.log("\n── more than one row for the pair ──");
f = bind(new Fake([row("admin", "active", "mem1"), row("admin", "active", "mem2")]));
msg = await expect_exit(() => establish(f));
check("duplicate membership rows -> SystemExit", msg !== null);
check("says how many were found", has(msg, "has 2 membership rows"));
check("says one was expected", has(msg, "expected one"));

console.log("\n── the role change was refused ──");
f = bind(new Fake([row("member")], 200, 403));
msg = await expect_exit(() => establish(f, "admin"));
check("PATCH refused -> SystemExit", msg !== null);
check("names both roles and the status", has(msg, "refused with HTTP 403"));

console.log("\n── the role change returned 200 and changed nothing ──");
f = bind(new Fake([row("member")])); // on_patch=null: the server accepts and no-ops
msg = await expect_exit(() => establish(f, "admin"));
check("silent no-op after HTTP 200 -> SystemExit", msg !== null);
check("says the change silently no-opped", has(msg, "silently no-opped"));
check("names the role still stored", has(msg, "'member'"));

function apply_role(fake: Fake, body: any): void {
  fake.rows = [{ ...fake.rows[0], role: body.role }];
}

console.log("\n── the role change landed ──");
f = bind(new Fake([row("member")], 200, 200, apply_role));
let tier = await establish(f, "admin");
check("PATCH that really lands -> tier returned", tier.role === "admin");
check("the tier re-reads the stored role", (await tier.now()) === "admin");
check(
  "standing() carries role and status",
  Bun.deepEquals(await tier.standing(), ["admin", "active"]),
);
check(
  "PATCH was actually issued",
  f.calls.some((c) => c[0] === "PATCH"),
);

console.log("\n── the membership is not active ──");
f = bind(new Fake([row("admin", "suspended")]));
msg = await expect_exit(() => establish(f, "admin"));
check("non-active status -> SystemExit", msg !== null);
check("names the status found", has(msg, "status='suspended'"));
check("says a non-active membership is a tenancy denial", has(msg, "denied by TENANCY"));

console.log("\n── the row disappears while the tier is still claimed ──");
f = bind(new Fake([row("admin")]));
tier = await establish(f, "admin");
f.rows = [];
msg = await expect_exit(() => tier.now());
check("row gone mid-run -> SystemExit on the next read", msg !== null);
check("says the membership is GONE", has(msg, "is GONE while the tier was still"));
check("says the later checks were answered by tenancy", has(msg, "answered by the tenancy guard"));

console.log("\n── the role changes under a claimed tier ──");
f = bind(new Fake([row("admin")]));
tier = await establish(f, "admin");
f.rows = [row("viewer")];
msg = await expect_exit(() => tier.verify());
check("role changed under the tier -> SystemExit", msg !== null);
check("names established and current role", has(msg, "was established as"));
check("says the block proved something else", has(msg, "proved something else"));

console.log("\n── a claimed tier dissolved before the next tier is established ──");
f = bind(new Fake([row("admin")]));
await establish(f, "admin");
f.rows = [row("viewer")];
msg = await expect_exit(() => establish(f, "member"));
check("prior tier dissolved -> SystemExit", msg !== null);
check("says it dissolved during the block", has(msg, "dissolved during the block"));
check("names the role the block ran under", has(msg, "'admin'"));

console.log("\n── verify_tiers() at end of suite ──");
f = bind(new Fake([row("admin")]));
await establish(f, "admin");
f.rows = [];
msg = await expect_exit(tierkit.verify_tiers);
check("end-of-suite dissolution -> SystemExit", msg !== null);
check("names the tier that dissolved", has(msg, "is GONE while the tier was still"));

f = bind(new Fake([row("admin")]));
await establish(f, "admin");
check(
  "verify_tiers() with every tier standing -> returns",
  (await expect_exit(tierkit.verify_tiers)) === null,
);

console.log("\n── done() closes a block out ──");
f = bind(new Fake([row("admin")]));
tier = await establish(f, "admin");
await tier.done();
check(
  "done() drops the tier from the registry",
  !tierkit._registry.has(tierkit.tier_key(WS, USER)),
);
f.rows = []; // the deliberate cleanup delete a closed-out block permits
check(
  "verify_tiers() after done() ignores the deleted row",
  (await expect_exit(tierkit.verify_tiers)) === null,
);

f = bind(new Fake([row("admin")]));
tier = await establish(f, "admin");
f.rows = [row("viewer")];
check(
  "done() on a tier that already moved -> SystemExit",
  (await expect_exit(() => tier.done())) !== null,
);

console.log("\n── now() when the STATUS moved under a claimed tier ──");
f = bind(new Fake([row("admin")]));
tier = await establish(f, "admin");
f.rows = [row("admin", "suspended")];
msg = await expect_exit(() => tier.now());
check("status changed under the tier -> now() SystemExit", msg !== null);
check("names the established and current status", has(msg, "status='suspended'"));
check("says the denial under it is tenancy, not role", has(msg, "denied by TENANCY"));
check("points the reader at standing()", has(msg, "standing()"));

console.log("\n── standing() is the deliberate reader for a status change ──");
f = bind(new Fake([row("admin")]));
tier = await establish(f, "admin");
f.rows = [row("admin", "suspended")];
let pair: [any, any] | null = null;

check(
  "standing() after a status change -> no abort",
  (await expect_exit(async () => {
    pair = await tier.standing();
  })) === null,
);
check("standing() reports the CHANGED pair", Bun.deepEquals(pair, ["admin", "suspended"]));

const OTHER = "usr99999999999";

function own(_fake: Fake, user = USER) {
  return tierkit.owner_of_workspace(WS, user, TOKEN, "Bob");
}

console.log("\n── the claimed owner does not own the workspace ──");
f = bind(new Fake([row()], 200, 200, null, OTHER));
msg = await expect_exit(() => own(f));
check("non-owner claimed as owner -> SystemExit", msg !== null);
check("says the actor is NOT the owner", has(msg, "is NOT the owner"));
check("names the owner actually stored", has(msg, OTHER));
check("explains the tenancy ambiguity", has(msg, "TENANCY guard"));

console.log("\n── the workspace record cannot be read ──");
f = bind(new Fake([row()], 200, 200, null, USER, 404));
msg = await expect_exit(() => own(f));
check("unreadable workspace -> SystemExit", msg !== null);
check("names the HTTP status", has(msg, "HTTP 404"));

console.log("\n── ownership moves while it is still claimed ──");
f = bind(new Fake([row()]));
let owner = await own(f);
check("owner established -> now() reads the stored owner", (await owner.now()) === USER);
f.owner = OTHER;
check("now() reports the NEW owner rather than aborting", (await owner.now()) === OTHER);
msg = await expect_exit(() => owner.verify());
check("verify() on moved ownership -> SystemExit", msg !== null);
check("names the established owner", has(msg, "established as the owner"));
check("says the block proved something else", has(msg, "proved something else"));

console.log("\n── verify_tiers() re-reads ownership too ──");
f = bind(new Fake([row()]));
await own(f);
f.owner = OTHER;
msg = await expect_exit(tierkit.verify_tiers);
check("end-of-suite ownership dissolution -> SystemExit", msg !== null);
check("names the ownership that dissolved", has(msg, "established as the owner"));

f = bind(new Fake([row()]));
owner = await own(f);
check(
  "verify_tiers() with the ownership standing -> returns",
  (await expect_exit(tierkit.verify_tiers)) === null,
);
await owner.done();
f.owner = OTHER; // after done() the block is closed; a transfer is no longer the suite's claim
check(
  "verify_tiers() after done() ignores the moved ownership",
  (await expect_exit(tierkit.verify_tiers)) === null,
);

f = bind(new Fake([row()]));
owner = await own(f);
f.owner = OTHER;
check(
  "done() on ownership that already moved -> SystemExit",
  (await expect_exit(() => owner.done())) !== null,
);

console.log("\n── an ownership and a role tier coexist for the same (workspace, user) ──");
f = bind(new Fake([row("admin")]));
tier = await establish(f, "admin");
owner = await own(f);
check("both standings are registered", tierkit._registry.size === 2);
check("the role tier still re-reads its role", (await tier.now()) === "admin");
check("the ownership still re-reads its owner", (await owner.now()) === USER);

console.log(`\n${FAILS.length ? "❌" : "✅"}  tierkit self-check: ${FAILS.length} failure(s)`);
process.exit(FAILS.length ? 1 : 0);

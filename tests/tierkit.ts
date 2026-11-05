#!/usr/bin/env bun
/**
 * Shared role-tier registry: a role-tier check can never be satisfied by an actor who holds
 * no membership row at all.
 *
 * A denial by TENANCY and a denial by ROLE are the same status on the wire (404 view/update/
 * delete, 400 create), so a check written to prove "an admin may not X" is silently satisfied
 * by an actor whose membership create failed, whose demotion silently no-opped, or whose row
 * was deleted mid-run. Establishing a tier here resolves the row by (workspace, user) — never
 * from a create response id — reads the stored role back, and ABORTS the suite naming the
 * fixture when it is absent or carries another role. verify_tiers() re-reads every live
 * registration at the end of the run, so a tier that dissolved mid-suite cannot pass unnoticed.
 *
 * now() vs standing(): now() ABORTS when the membership STATUS has moved off the value the
 * tier was established at, because from that moment every denial under it is TENANCY and a
 * role read would misdiagnose it. standing() never aborts and returns the (role, status) pair
 * — it is the reader for a block that moves the status ON PURPOSE, and the pair must ride in
 * the assertion so a suspension cannot read as a role denial.
 *
 * Ownership is a separate standing: workspaces.owner and workspace_members.role are
 * independent (the self-membership row is provisioned at "member", pb_hooks/main.pb.js), so no
 * Tier can carry "this caller is the OWNER" — owner_of_workspace() does, in the same register.
 *
 * Usage (any tests/test_*.ts that probes the admin/member/viewer tiers):
 *
 *     import * as tierkit from "./tierkit.ts";
 *     tierkit.use(api);                                 // the suite's own api(...) function
 *     const bob = await tierkit.actor_at_tier(ALICE_WS, bob_id, "admin", alice, "Bob");
 *     check("Bob (admin) …", [await bob.now(), s], ["admin", 404]);
 *     await bob.done();                                 // block over — BEFORE the row is deleted
 *     const owns = await tierkit.owner_of_workspace(BOB_WS, bob_id, su, "Bob");
 *     check("Bob (owner) …", [await owns.now(), s], [bob_id, 404]);
 *     ...
 *     await tierkit.verify_tiers();                     // end of suite
 */

import { py_repr, urlencode } from "../scripts/_py.ts";
import { SystemExit } from "./roomkit.ts";

export const MEMBERS = "/api/collections/workspace_members/records";
export const WORKSPACES = "/api/collections/workspaces/records";

export type Api = (
  method: string,
  path: string,
  token?: string | null,
  body?: any,
) => Promise<[number, any]> | [number, any];

let _api: Api | null = null;
// (workspace, user) -> Tier and (workspace, user, "owner") -> Ownership: the standings the
// running suite currently claims. The "owner" key keeps both claimable for the same pair.
export const _registry: Map<string, Tier | Ownership> = new Map();

export function tier_key(workspace: string, user: string, owner?: "owner"): string {
  return [workspace, user, ...(owner ? [owner] : [])].join("\0");
}

// Bind the suite's own `api(method, path, token=None, body=None)` -> (status, body).
export function use(api: Api | null): void {
  _api = api;
}

export function _die(msg: string): never {
  throw new SystemExit(
    `❌ TIER FIXTURE: ${msg}\n   A role-tier check whose actor has no membership is ` +
      `answered by the TENANCY guard with the same status the ROLE guard would use, so the ` +
      `run is aborted here rather than reported green (tests/tierkit.ts).`,
  );
}

export async function _call(
  method: string,
  path: string,
  token: string | null = null,
  body: any = null,
): Promise<[number, any]> {
  if (_api === null) _die("tierkit.use(<the suite's api function>) was never called");
  return await _api(method, path, token, body);
}

// The membership row for (workspace, user) as seen by `token`, or a named abort.
export async function _fetch(
  workspace: string,
  user: string,
  token: string | null,
  who: string,
  gone: string | null = null,
): Promise<any> {
  const qs = urlencode({
    filter: `(workspace='${workspace}' && user='${user}')`,
    perPage: 2,
  });
  const [status, body] = await _call("GET", `${MEMBERS}?${qs}`, token);
  const items = body.items || [];
  if (status !== 200) {
    _die(
      `reading ${who}'s membership in workspace ${workspace} returned HTTP ${status} ${py_repr(body)}`,
    );
  }
  if (items.length === 0) {
    _die(
      gone ||
        `${who} has NO membership row in workspace ${workspace} — the fixture create that ` +
          `should have made it never landed (or the reader token cannot see it)`,
    );
  }
  if (items.length > 1) {
    _die(`${who} has ${items.length} membership rows in workspace ${workspace} — expected one`);
  }
  return items[0];
}

// One claimed (actor, workspace, role) standing, re-readable from the server.
export class Tier {
  workspace: string;
  user: string;
  role: string;
  status: string;
  token: string | null;
  who: string;
  id: string;

  constructor(
    workspace: string,
    user: string,
    role: string,
    status: string,
    token: string | null,
    who: string,
    row_id: string,
  ) {
    this.workspace = workspace;
    this.user = user;
    this.role = role;
    this.status = status;
    this.token = token;
    this.who = who;
    this.id = row_id;
  }

  async _row(): Promise<any> {
    return await _fetch(
      this.workspace,
      this.user,
      this.token,
      this.who,
      `${this.who}'s ${this.role} membership in workspace ${this.workspace} (row ` +
        `${this.id}) is GONE while the tier was still claimed — every check made under ` +
        `it after that point was answered by the tenancy guard, not the role guard`,
    );
  }

  // The role stored RIGHT NOW — ride it in an assertion whose denial is ambiguous.
  //
  // ABORTS when the STATUS has moved off the value the tier was established at: from that
  // moment the denial under it is TENANCY, so the role is the wrong thing to assert. A
  // block that changes status on purpose reads standing() instead.
  async now(): Promise<string> {
    const row = await this._row();
    if (row.status !== this.status) {
      _die(
        `${this.who}'s membership in workspace ${this.workspace} was established as ` +
          `status=${py_repr(this.status)} and now reads status=${py_repr(row.status)} — from that ` +
          `change on it is denied by TENANCY, not by role, so now() cannot describe it; ` +
          `a block that moves the status on purpose asserts standing() instead`,
      );
    }
    return row.role ?? null;
  }

  // (role, status) stored right now, NEVER aborting on a change — the deliberate reader
  // for a block that moves the status on purpose; assert the pair, since a suspended
  // membership is denied like a stranger.
  async standing(): Promise<[any, any]> {
    const row = await this._row();
    return [row.role ?? null, row.status ?? null];
  }

  // Abort unless this tier still stands exactly as it was established.
  async verify(): Promise<Tier> {
    const row = await this._row();
    const got = [row.role ?? null, row.status ?? null];
    if (got[0] !== this.role || got[1] !== this.status) {
      _die(
        `${this.who}'s membership in workspace ${this.workspace} was established as ` +
          `role=${py_repr(this.role)}/status=${py_repr(this.status)} and now reads role=${py_repr(got[0])}/` +
          `status=${py_repr(got[1])} — every check made under that tier proved something else`,
      );
    }
    return this;
  }

  // End this tier's block: verify it held, then stop tracking it (the row may now go).
  async done(): Promise<Tier> {
    await this.verify();
    _registry.delete(tier_key(this.workspace, this.user));
    process.stdout.write(
      `  ✅  tier held: ${this.who} was ${this.role}/${this.status} for the whole block\n`,
    );
    return this;
  }
}

// Establish `user` at `role` in `workspace`, proven against the server. Fatal otherwise.
//
// `token` must be able to read (and, where the role has to be changed, update) the row —
// the workspace owner or a superuser. Returns a Tier; call .done() when its block ends.
export async function actor_at_tier(
  workspace: string,
  user: string,
  role: string,
  token: string | null,
  who: string | null = null,
  status = "active",
): Promise<Tier> {
  who = who || `user ${user}`;
  let row = await _fetch(workspace, user, token, who);
  const prev = _registry.get(tier_key(workspace, user)) as Tier | undefined;
  if (prev !== undefined && row.role !== prev.role && row.role !== role) {
    _die(
      `${who}'s role in workspace ${workspace} was established as ${py_repr(prev.role)} and reads ` +
        `${py_repr(row.role ?? null)} now, before any change made here — it dissolved during the ` +
        `block that ran under the ${py_repr(prev.role)} tier`,
    );
  }
  if (row.role !== role) {
    const was = row.role ?? null;
    const [s] = await _call("PATCH", `${MEMBERS}/${row.id}`, token, { role });
    if (s !== 200) {
      _die(`setting ${who}'s role ${py_repr(was)} → ${py_repr(role)} was refused with HTTP ${s}`);
    }
    row = await _fetch(workspace, user, token, who);
    // A 200 is acceptance, not a role change: a silently no-op'd demotion would leave the
    // whole block below asserting the tier it just left.
    if (row.role !== role) {
      _die(
        `setting ${who}'s role ${py_repr(was)} → ${py_repr(role)} was accepted (HTTP 200) but the row ` +
          `still reads ${py_repr(row.role ?? null)} — the change silently no-opped`,
      );
    }
    process.stdout.write(
      `  ✅  tier set: ${who} ${py_repr(was)} → ${py_repr(role)} in workspace ${workspace}\n`,
    );
  }
  if (row.status !== status) {
    _die(
      `${who}'s membership in workspace ${workspace} is status=${py_repr(row.status ?? null)}, not ` +
        `${py_repr(status)} — a non-active membership is denied by TENANCY, so a ${py_repr(role)}-tier ` +
        `check on it proves nothing about the role`,
    );
  }
  const tier = new Tier(workspace, user, role, status, token, who, row.id);
  _registry.set(tier_key(workspace, user), tier);
  process.stdout.write(
    `  ✅  tier: ${who} is ${role}/${status} in workspace ${workspace} (row ${row.id})\n`,
  );
  return tier;
}

// The workspace record as seen by `token`, or a named abort.
async function _workspace(workspace: string, token: string | null, who: string): Promise<any> {
  const [status, body] = await _call("GET", `${WORKSPACES}/${workspace}`, token);
  if (status !== 200) {
    _die(
      `reading workspace ${workspace}, claimed to be owned by ${who}, returned HTTP ` +
        `${status} ${py_repr(body)}`,
    );
  }
  return body;
}

// One claimed (actor, workspace) OWNERSHIP standing, re-readable from the server.
export class Ownership {
  workspace: string;
  user: string;
  token: string | null;
  who: string;

  constructor(workspace: string, user: string, token: string | null, who: string) {
    this.workspace = workspace;
    this.user = user;
    this.token = token;
    this.who = who;
  }

  // The owner id stored RIGHT NOW — ride it in an assertion whose denial is ambiguous.
  async now(): Promise<any> {
    return (await _workspace(this.workspace, this.token, this.who)).owner ?? null;
  }

  // Abort unless this ownership still stands exactly as it was established.
  async verify(): Promise<Ownership> {
    const got = await this.now();
    if (got !== this.user) {
      _die(
        `${this.who} was established as the owner of workspace ${this.workspace} and it ` +
          `now reads owner=${py_repr(got)} — every check made under that ownership proved ` +
          `something else`,
      );
    }
    return this;
  }

  // End this block: verify the ownership held, then stop tracking it.
  async done(): Promise<Ownership> {
    await this.verify();
    _registry.delete(tier_key(this.workspace, this.user, "owner"));
    process.stdout.write(
      `  ✅  tier held: ${this.who} owned workspace ${this.workspace} for the whole block\n`,
    );
    return this;
  }
}

// Establish `user` as the OWNER of `workspace`, proven against the server. Fatal otherwise.
//
// workspaces.owner is independent of workspace_members.role, so an owner standing cannot be
// read off a Tier. Returns an Ownership; call .done() when its block ends.
export async function owner_of_workspace(
  workspace: string,
  user: string,
  token: string | null,
  who: string | null = null,
): Promise<Ownership> {
  who = who || `user ${user}`;
  const owner = (await _workspace(workspace, token, who)).owner ?? null;
  if (owner !== user) {
    _die(
      `${who} is NOT the owner of workspace ${workspace} — it reads owner=${py_repr(owner)}, not ` +
        `${py_repr(user)}; an owner-tier check on a non-owner is answered by the TENANCY guard ` +
        `with the status the owner-only guard would use`,
    );
  }
  const own = new Ownership(workspace, user, token, who);
  _registry.set(tier_key(workspace, user, "owner"), own);
  process.stdout.write(`  ✅  tier: ${who} owns workspace ${workspace}\n`);
  return own;
}

// Re-read every tier still claimed by this suite. Fatal on the first one that dissolved.
export async function verify_tiers(): Promise<void> {
  const tiers = [..._registry.values()];
  for (const tier of tiers) {
    await tier.verify();
  }
  process.stdout.write(
    `  ✅  ${tiers.length} registered tier(s) re-read at end of suite, all still standing\n`,
  );
}

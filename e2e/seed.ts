#!/usr/bin/env bun
/** Builds a generated world in a fresh room through the public API: the superuser only creates the accounts (e2e/README.md). */

import { generate, type World } from "./world.ts";

export type LogEntry = { as: string; method: string; path: string; status: number };
export type Seeded = {
  users: Record<string, { id: string; token: string }>;
  workspaces: Record<string, string>;
  projects: Record<string, string>;
  items: Record<string, string>;
  log: LogEntry[];
};

const WINDOW_MS = 61_000; // a little over one window of the settings migration's rate-limit rules

export async function seed_world(url: string, world: World, su: [string, string]): Promise<Seeded> {
  const log: LogEntry[] = [];
  const tokens: Record<string, string> = {};

  async function api(as: string, method: string, path: string, body: any = null): Promise<any> {
    const deadline = Date.now() + WINDOW_MS;
    for (;;) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tokens[as]) headers.Authorization = tokens[as];
      const r = await fetch(url + path, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
      });
      log.push({ as, method, path: path.split("?")[0]!, status: r.status });
      // A 429 carries no Retry-After: wait out the window rather than give up.
      if (r.status === 429 && Date.now() < deadline) {
        await Bun.sleep(2000);
        continue;
      }
      const text = await r.text();
      if (!r.ok) throw new Error(`seed_world: ${as} ${method} ${path} -> ${r.status} ${text}`);
      return text ? JSON.parse(text) : {};
    }
  }
  const q = (filter: string): string => `?${new URLSearchParams({ filter, perPage: "500" })}`;

  const auth = await api("superuser", "POST", "/api/collections/_superusers/auth-with-password", {
    identity: su[0],
    password: su[1],
  }).catch((e) => {
    throw new Error(
      `${e.message}\n(an MFA-on superuser cannot seed: boot the room without *superuser_mfa.js)`,
    );
  });
  tokens.superuser = auth.token;

  const users: Seeded["users"] = {};
  for (const u of world.users) {
    // approved is a superuser-only field, and an unverified account cannot sign in.
    const r = await api("superuser", "POST", "/api/collections/users/records", {
      email: u.email,
      password: u.password,
      passwordConfirm: u.password,
      name: u.name,
      verified: true,
      approved: true,
    }).catch((e) => {
      throw new Error(`${e.message}\n(a world seeds only into a fresh room)`);
    });
    users[u.key] = { id: r.id, token: "" };
  }
  for (const u of world.users) {
    const r = await api(u.key, "POST", "/api/collections/users/auth-with-password", {
      identity: u.email,
      password: u.password,
    });
    tokens[u.key] = users[u.key]!.token = r.token;
  }

  const workspaces: Seeded["workspaces"] = {};
  const projects: Seeded["projects"] = {};
  const status_ids: Record<string, Record<string, string>> = {};
  const label_ids: Record<string, Record<string, string>> = {};
  for (const w of world.workspaces) {
    // /api/tracker/me, not a workspaces list: the probe counts that list's rate-limit bucket exactly.
    const me = await api(w.owner, "GET", "/api/tracker/me");
    const id = me.workspaces.find((x: any) => x.role === "owner").id;
    workspaces[w.key] = id;
    await api(w.owner, "PATCH", `/api/collections/workspaces/records/${id}`, { name: w.name });
    // Signup provisioned this account one project too: the world renames it rather than adding one.
    const found = await api(
      w.owner,
      "GET",
      `/api/collections/projects/records${q(`workspace='${id}'`)}`,
    );
    for (const [j, p] of w.projects.entries()) {
      const body = { name: p.name, description: p.description };
      projects[p.key] =
        j === 0
          ? (
              await api(
                w.owner,
                "PATCH",
                `/api/collections/projects/records/${found.items[0].id}`,
                body,
              )
            ).id
          : (
              await api(w.owner, "POST", "/api/collections/projects/records", {
                ...body,
                workspace: id,
              })
            ).id;
    }
    for (const l of w.labels)
      await api(w.owner, "POST", "/api/collections/labels/records", { workspace: id, ...l });
    const st = await api(
      w.owner,
      "GET",
      `/api/collections/statuses/records${q(`workspace='${id}'`)}`,
    );
    status_ids[w.key] = Object.fromEntries(st.items.map((s: any) => [s.name, s.id]));
    const lb = await api(
      w.owner,
      "GET",
      `/api/collections/labels/records${q(`workspace='${id}'`)}`,
    );
    label_ids[w.key] = Object.fromEntries(lb.items.map((l: any) => [l.name, l.id]));
    for (const m of w.members) {
      const email = world.users.find((u) => u.key === m.user)!.email;
      await api(w.owner, "POST", "/api/collections/workspace_invitations/records", {
        workspace: id,
        email,
        role: m.role,
      });
      const mine = await api(m.user, "GET", "/api/tracker/invitations/mine");
      const inv = mine.items.find((x: any) => x.workspace === id);
      await api(m.user, "POST", `/api/tracker/invitations/${inv.id}/accept`);
    }
  }

  const items: Seeded["items"] = {};
  for (const i of world.items) {
    const resolve = (table: Record<string, string>, name: string): string => {
      const id = table[name];
      if (id === undefined) throw new Error(`seed_world: workspace ${i.workspace} has no ${name}`);
      return id;
    };
    const r =
      i.type === "task"
        ? await api(i.author, "POST", "/api/collections/tasks/records", {
            title: i.title,
            project: projects[i.project],
            status: i.status === null ? undefined : resolve(status_ids[i.workspace]!, i.status),
            assignee: i.assignee === null ? undefined : users[i.assignee]!.id,
            due: i.due ?? undefined,
            labels: i.labels.map((l) => resolve(label_ids[i.workspace]!, l)),
          })
        : await api(i.author, "POST", "/api/collections/documents/records", {
            title: i.title,
            body: i.body,
            workspace: workspaces[i.workspace],
            project: projects[i.project],
          });
    items[i.key] = r.id;
  }
  for (const c of world.comments)
    await api(c.author, "POST", "/api/collections/comments/records", {
      task: items[c.item],
      body: c.body,
    });

  return { users, workspaces, projects, items, log };
}

if (import.meta.main) {
  const arg = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const seed = /^\d+$/.test(arg("--seed") ?? "") ? Number(arg("--seed")) : NaN;
  const url = arg("--url");
  const su = [process.env.PB_SUPERUSER_EMAIL, process.env.PB_SUPERUSER_PASSWORD];
  if (!Number.isInteger(seed) || !url || !su[0] || !su[1]) {
    process.stderr.write(
      "usage: PB_SUPERUSER_EMAIL=… PB_SUPERUSER_PASSWORD=… bun e2e/seed.ts --seed N --url http://127.0.0.1:PORT\n",
    );
    process.exit(2);
  }
  const out = await seed_world(url, generate(seed), su as [string, string]);
  const { log, ...ids } = out;
  for (const u of Object.values(ids.users)) u.token = "";
  console.log(JSON.stringify({ seed, requests: log.length, ...ids }, null, 2));
}

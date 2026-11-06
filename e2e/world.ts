#!/usr/bin/env bun
/** Deterministic e2e world: a seed in, the same users, workspaces, projects, labels, items and comments out (e2e/README.md). */

export type Role = "admin" | "member" | "viewer";
export type User = { key: string; name: string; email: string; password: string };
export type Workspace = {
  key: string;
  name: string;
  owner: string;
  members: { user: string; role: Role }[];
  labels: { name: string; color: string }[];
  projects: { key: string; name: string; description: string }[];
};
export type Item = {
  key: string;
  workspace: string;
  project: string;
  type: "task" | "document";
  title: string;
  body: string;
  author: string;
  status: string | null;
  assignee: string | null;
  due: string | null;
  labels: string[];
};
export type Comment = { item: string; author: string; body: string };
export type World = {
  seed: number;
  users: User[];
  workspaces: Workspace[];
  items: Item[];
  comments: Comment[];
};

// What the backend provisions in every workspace; the seeder resolves items' names against it.
export const CORE_LABELS = ["Bug", "Feature", "Improvement"];
export const STATUSES = ["Backlog", "Todo", "In Progress", "Done", "Canceled"];

const NAMES = ["Ada", "Basil", "Cleo", "Dara", "Emeka", "Freya", "Goran", "Hana", "Ines", "Jonas"];
const PLACES = ["Studio", "Workshop", "Lab", "Collective", "Guild", "Office"];
const PROJECTS = [
  "Billing Revamp",
  "Onboarding Flow",
  "Search Index",
  "Data Export",
  "Mobile Sync",
  "Release Train",
  "Help Center",
  "Audit Log",
];
const CUSTOM_LABELS = ["Backend", "Frontend", "Docs", "Ops", "Security", "Design"];
const COLORS = ["orange", "yellow", "teal", "blue", "indigo", "pink"];
const VERBS = ["Fix", "Write", "Review", "Plan", "Ship", "Refactor", "Measure", "Test"];
const OBJECTS = [
  "login timeout",
  "invoice totals",
  "sync conflicts",
  "empty states",
  "search ranking",
  "release notes",
  "import mapping",
  "cache warmup",
  "access audit",
  "retry policy",
  "onboarding email",
  "rate limits",
];
const DOC_KINDS = ["Spec", "Notes", "Runbook"];
const REMARKS = [
  "Picking this up today.",
  "Blocked on review.",
  "Can we split this in two?",
  "Done on my side, please check.",
  "Moving this to next week.",
  "Added a repro case.",
];
const ROLES: Role[] = ["admin", "member", "member", "viewer"];

/** mulberry32: a small PRNG whose sequence depends on the seed alone. */
function prng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Members who may write items and comments: viewers read only. */
export const writers = (w: Workspace): string[] => [
  w.owner,
  ...w.members.filter((m) => m.role !== "viewer").map((m) => m.user),
];

/** The probe's normal member: users[1] is always a plain `member` of workspaces[0]. */
export const persona = (w: World): { user: User; workspace: Workspace } => ({
  user: w.users[1]!,
  workspace: w.workspaces[0]!,
});

export function generate(seed: number): World {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError(`seed must be an integer from 0 to 2^32-1, got ${seed}`);
  const rnd = prng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const shuffle = <T>(xs: T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  // Kept small: the seeder signs every user in, and sign-in shares one rate-limit window with the client.
  const users: User[] = shuffle(NAMES)
    .slice(0, int(4, 5))
    .map((name, i) => ({
      key: `u${i}`,
      name,
      email: `${name.toLowerCase()}@example.com`,
      password: `world-${seed}-${name.toLowerCase()}`,
    }));

  const workspaces: Workspace[] = users.map((owner, i) => {
    const members = users
      .filter((u) => u !== owner)
      .flatMap((u): Workspace["members"] => {
        if (i === 0 && u.key === "u1") return [{ user: u.key, role: "member" }];
        return rnd() < 0.4 ? [{ user: u.key, role: pick(ROLES) }] : [];
      });
    return {
      key: `w${i}`,
      name: `${owner.name}'s ${pick(PLACES)}`,
      owner: owner.key,
      members,
      labels: shuffle(CUSTOM_LABELS)
        .slice(0, int(1, 2))
        .map((name) => ({ name, color: pick(COLORS) })),
      projects: shuffle(PROJECTS)
        .slice(0, int(1, 2))
        .map((name, j) => ({ key: `w${i}p${j}`, name, description: `${name} for ${owner.name}` })),
    };
  });

  const items: Item[] = [];
  const comments: Comment[] = [];
  for (const w of workspaces) {
    const wr = writers(w);
    const labels = [...CORE_LABELS, ...w.labels.map((l) => l.name)];
    const titles = shuffle(VERBS.flatMap((v) => OBJECTS.map((o) => `${v} ${o}`)));
    for (const p of w.projects) {
      for (let t = int(2, 5); t > 0; t--) {
        const due = rnd() < 0.5 ? null : new Date(Date.UTC(2026, 10, 1) + int(0, 180) * 864e5);
        // The anchor gives each of the probe's filters a seeded row to match in persona's workspace.
        const anchor = items.length === 0;
        const item: Item = {
          key: `${p.key}t${items.length}`,
          workspace: w.key,
          project: p.key,
          type: "task",
          title: titles.pop()!,
          body: "",
          author: pick(wr),
          status: anchor ? "In Progress" : pick(STATUSES),
          assignee: anchor ? "u1" : rnd() < 0.25 ? null : pick(wr),
          due: anchor
            ? "2026-11-16 00:00:00.000Z"
            : due === null
              ? null
              : due.toISOString().replace("T", " "),
          labels: anchor ? ["Bug"] : shuffle(labels).slice(0, int(0, 2)),
        };
        items.push(item);
        for (let c = int(0, 2); c > 0; c--)
          comments.push({ item: item.key, author: pick(wr), body: pick(REMARKS) });
      }
      for (let d = int(p.key === "w0p0" ? 1 : 0, 2); d > 0; d--) {
        const topic = titles.pop()!.replace(/^\S+ /, "");
        items.push({
          key: `${p.key}d${items.length}`,
          workspace: w.key,
          project: p.key,
          type: "document",
          title: `${pick(DOC_KINDS)}: ${topic}`,
          body: `Working notes on ${topic}.`,
          author: pick(wr),
          status: null,
          assignee: null,
          due: null,
          labels: [],
        });
      }
    }
  }
  return { seed, users, workspaces, items, comments };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--seed");
  const arg = i < 0 ? "" : (process.argv[i + 1] ?? "");
  const seed = Number(arg);
  if (!/^\d+$/.test(arg) || seed > 0xffffffff) {
    process.stderr.write("usage: bun e2e/world.ts --seed N   (prints the world as JSON)\n");
    process.exit(2);
  }
  console.log(JSON.stringify(generate(seed), null, 2));
}

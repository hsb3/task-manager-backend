// The verbs as plain functions: the CLI prints their results, and `tm mcp` can expose them as tools.

import type {
  CommentsRecord,
  DecisionsRecord,
  DocumentsRecord,
  MilestonesRecord,
  ProjectItemsListResult,
  ProjectItemsRecord,
  TasksRecord,
} from "./api.generated.ts";
import { ApiError, request, UsageError, type Config } from "./api.ts";

export const KINDS = ["task", "document", "decision", "milestone"] as const;
export type Kind = (typeof KINDS)[number];
// `kind`, not `type`: tasks carry their own `type` text field, which stays the server's.
export type Item = { kind: Kind } & (
  TasksRecord | DocumentsRecord | DecisionsRecord | MilestonesRecord
);
export type ListRow = ProjectItemsRecord & { kind: Kind };

const collection_of = (kind: Kind) => `${kind}s`;
const with_kind = <T>(kind: Kind, rec: T): T & { kind: Kind } => ({ ...rec, kind });
// Milestones carry `name` where every other kind carries `title`.
const title_field = (kind: Kind) => (kind === "milestone" ? "name" : "title");
const record_url = (collection: string, id: string) =>
  `/api/collections/${collection}/records/${encodeURIComponent(id)}`;

export function item_kind(value: string): Kind {
  if ((KINDS as readonly string[]).includes(value)) return value as Kind;
  throw new UsageError(`unknown kind "${value}"; one of ${KINDS.join(", ")}`);
}

export type ListFilter = { project?: string; workspace?: string; kind?: Kind; limit?: number };

/** Items the key's owner can read, newest change first. */
export async function list(cfg: Config, f: ListFilter = {}): Promise<ListRow[]> {
  const clauses = [
    f.project && `project = ${JSON.stringify(f.project)}`,
    f.workspace && `workspace = ${JSON.stringify(f.workspace)}`,
    f.kind && `type = ${JSON.stringify(f.kind)}`,
  ].filter(Boolean);
  const r = await request<ProjectItemsListResult>(
    cfg,
    "GET",
    "/api/collections/project_items/records",
    {
      filter: clauses.join(" && "),
      sort: "-updated",
      perPage: f.limit ?? 50,
      skipTotal: 1,
    },
  );
  return r.items.map((row) => with_kind(row.type as Kind, row));
}

/** The item's kind, resolved through the unified view so an id alone is enough. */
async function kind_of(cfg: Config, id: string): Promise<Kind> {
  try {
    const row = await request<ProjectItemsRecord>(cfg, "GET", record_url("project_items", id));
    return row.type as Kind;
  } catch (e) {
    if (e instanceof ApiError && e.body.status === 404) {
      throw new ApiError({ ...e.body, message: `no item ${id} that you can read` });
    }
    throw e;
  }
}

export async function show(cfg: Config, id: string): Promise<Item> {
  const kind = await kind_of(cfg, id);
  return with_kind(kind, await request(cfg, "GET", record_url(collection_of(kind), id)));
}

export type CreateArgs = {
  kind?: Kind;
  title: string;
  project?: string;
  workspace?: string;
  fields?: Record<string, string>;
};

export async function create(cfg: Config, a: CreateArgs): Promise<Item> {
  const kind = a.kind ?? "task";
  if (!a.project && !a.workspace) throw new UsageError("create needs --project or --workspace");
  const body: Record<string, unknown> = { ...(a.fields ?? {}), [title_field(kind)]: a.title };
  if (a.project) body.project = a.project;
  if (a.workspace) body.workspace = a.workspace;
  const rec = await request(
    cfg,
    "POST",
    `/api/collections/${collection_of(kind)}/records`,
    {},
    body,
  );
  return with_kind(kind, rec);
}

export async function edit(
  cfg: Config,
  id: string,
  changes: { title?: string; fields?: Record<string, string> },
): Promise<Item> {
  const kind = await kind_of(cfg, id);
  const body: Record<string, unknown> = { ...(changes.fields ?? {}) };
  if (changes.title !== undefined) body[title_field(kind)] = changes.title;
  if (!Object.keys(body).length) throw new UsageError("edit needs --title or --set field=value");
  return with_kind(
    kind,
    await request(cfg, "PATCH", record_url(collection_of(kind), id), {}, body),
  );
}

export async function comment(cfg: Config, id: string, body: string): Promise<CommentsRecord> {
  const kind = await kind_of(cfg, id);
  if (kind === "milestone") throw new UsageError("milestones do not take comments");
  return request<CommentsRecord>(
    cfg,
    "POST",
    "/api/collections/comments/records",
    {},
    { [kind]: id, body },
  );
}

export type SearchResult = {
  query: string;
  count: number;
  truncated: boolean;
  results: { collection: string; id: string; title: string; project: string; rank: number }[];
};

export function search(cfg: Config, q: string): Promise<SearchResult> {
  return request<SearchResult>(cfg, "GET", "/api/tracker/search", { q });
}

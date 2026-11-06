// The verbs as plain functions: the CLI prints their results, and `tm mcp` can expose them as tools.

import {
  FIELD_TYPES,
  type CommentsRecord,
  type DecisionsRecord,
  type DocumentsRecord,
  type MilestonesRecord,
  type ProjectItemsListResult,
  type ProjectItemsRecord,
  type Paths,
  type TasksRecord,
} from "./api.generated.ts";
import { api, ApiError, request, UsageError, type Config } from "./api.ts";

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

export type ListFilter = {
  project?: string;
  workspace?: string;
  kind?: Kind;
  limit?: number;
  page?: number;
};

/** Items the key's owner can read, newest change first, one page of `limit` at a time. */
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
      sort: "-updated,id", // id breaks ties so pages never overlap or skip
      perPage: f.limit ?? 50,
      page: f.page ?? 1,
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

export type Fields = Record<string, string | number | boolean>;

/** A field's JSON type for the kind, or (no kind yet, as in edit) for the first item kind carrying it. */
function field_type(kind: Kind | undefined, field: string): string {
  for (const k of kind ? [kind] : KINDS) {
    const types: Record<string, string> = FIELD_TYPES[`${k}s`];
    if (Object.hasOwn(types, field)) return types[field]!;
  }
  return "string";
}

/** Text values typed by the schema: true/false for a yes/no field, a decimal for a number field. */
export function typed_fields(kind: Kind | undefined, fields: Fields = {}): Fields {
  const out: Fields = {};
  for (const [name, v] of Object.entries(fields)) {
    const type = typeof v === "string" ? field_type(kind, name) : "";
    if (type === "boolean") {
      if (v !== "true" && v !== "false") throw new UsageError(`${name} takes true or false`);
      out[name] = v === "true";
    } else if (type === "number") {
      if (!/^-?[0-9]+(\.[0-9]+)?$/u.test(v as string))
        throw new UsageError(`${name} takes a number`);
      out[name] = Number(v);
    } else out[name] = v;
  }
  return out;
}

export type CreateArgs = {
  kind?: Kind;
  title: string;
  project?: string;
  workspace?: string;
  fields?: Fields;
};

export async function create(cfg: Config, a: CreateArgs): Promise<Item> {
  const kind = a.kind ?? "task";
  if (!a.project && !a.workspace) throw new UsageError("create needs a project or a workspace");
  const body: Record<string, unknown> = {
    ...typed_fields(kind, a.fields),
    [title_field(kind)]: a.title,
  };
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
  changes: { title?: string; fields?: Fields },
): Promise<Item> {
  const kind = await kind_of(cfg, id);
  const body: Record<string, unknown> = { ...typed_fields(kind, changes.fields) };
  if (changes.title !== undefined) body[title_field(kind)] = changes.title;
  if (!Object.keys(body).length) throw new UsageError("edit needs a title or a field to set");
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

type SearchAnswer = Paths["GET /api/tracker/search"]["response"];
export type Found = SearchAnswer & {
  results: (SearchAnswer["results"][number] & { kind: Kind | "project" })[];
};

/** The server's hits, each with the `kind` list and show use; a project hit is kind "project". */
export async function search(cfg: Config, q: string): Promise<Found> {
  const r = await api(cfg, "GET /api/tracker/search", { query: { q } });
  return {
    ...r,
    results: r.results.map((x) => ({
      ...x,
      kind: x.collection.replace(/s$/, "") as Kind | "project",
    })),
  };
}

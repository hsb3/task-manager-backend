// The tm tool catalog as an MCP server: `tm mcp` over stdio, and the hosted MCP service's factory.

import { readFileSync } from "node:fs";
import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { api, ApiError, UsageError, type Config } from "./api.ts";
import * as verbs from "./verbs.ts";

export {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  Server,
} from "@modelcontextprotocol/server";

export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export type Scope = "read" | "write" | "manage" | "own";

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (cfg: Config, a: any) => Promise<unknown>;
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
};

const ID = { type: "string", description: "The item's id, as `tm_list` or `tm_search` return it." };
const KIND = {
  type: "string",
  enum: verbs.KINDS,
  description: "task (the default), document, decision or milestone.",
};
const FIELDS = {
  type: "object",
  additionalProperties: { type: ["string", "number", "boolean"] },
  description:
    'Other fields of the item by their API names, e.g. {"description": "...", "draft": true}. A yes/no field takes true or false and a number field a number; the text "true" or "7" is read the same way. The server validates them.',
};
// Compile-checked against the search answer's type, so the description cannot name a renamed field.
const HIT_FIELDS = [
  "id",
  "kind",
  "title",
  "project",
] as const satisfies readonly (keyof verbs.Found["results"][number])[];
const PROJECT = { type: "string", description: "A project id." };
const WORKSPACE = { type: "string", description: "A workspace id." };

/** The catalog: one record per verb, read tools marked read-only, write tools non-destructive. */
export const TOOLS: ToolDef[] = [
  {
    name: "tm_list",
    description:
      "List the items the key can see, newest change first, a page at a time. Optionally narrow to one project, one workspace or one kind. Returns an array of items, each the full record (id, kind, key, title, status and the rest); pass an id to tm_show, tm_edit or tm_comment.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        workspace: WORKSPACE,
        kind: KIND,
        limit: {
          type: "integer",
          minimum: 1,
          description: "How many to return per page (default 50).",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "Which page of `limit` items to return (default 1).",
        },
      },
    },
    annotations: { readOnlyHint: true },
    run: (cfg, a) => verbs.list(cfg, { ...a, kind: a.kind && verbs.item_kind(a.kind) }),
  },
  {
    name: "tm_show",
    description: "Show one item in full by its id, with the kind it is. Needs the id.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
    annotations: { readOnlyHint: true },
    run: (cfg, a) => verbs.show(cfg, a.id),
  },
  {
    name: "tm_search",
    description: `Full-text search across the items the key can see. Returns matches with ${HIT_FIELDS.join(", ")} (kind is task, document, decision, milestone or project); the count and whether the list was cut short.`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to search for." } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    run: (cfg, a: { query: string }) => verbs.search(cfg, a.query),
  },
  {
    name: "tm_create",
    description:
      "Create an item. Needs a title and either a project (tasks, decisions, milestones) or a workspace (documents). Needs a write key. Returns the item as created, with its id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title (a milestone's name)." },
        project: PROJECT,
        workspace: WORKSPACE,
        kind: KIND,
        fields: FIELDS,
      },
      required: ["title"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (cfg, a) => verbs.create(cfg, { ...a, kind: a.kind && verbs.item_kind(a.kind) }),
  },
  {
    name: "tm_edit",
    description:
      "Change an item's title and/or other fields by its id. Needs the id and at least one change, and a write key. Returns the item as it now is.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        title: { type: "string", description: "The new title." },
        fields: FIELDS,
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (cfg, a) => verbs.edit(cfg, a.id, { title: a.title, fields: a.fields }),
  },
  {
    name: "tm_comment",
    description:
      "Add a comment to a task, document or decision by its id (milestones take none). Needs the id, the comment text and a write key. Returns the comment.",
    inputSchema: {
      type: "object",
      properties: { id: ID, body: { type: "string", description: "The comment text." } },
      required: ["id", "body"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (cfg, a) => verbs.comment(cfg, a.id, a.body),
  },
];

/** The catalog in order, without `run`; a read scope keeps only the read-only tools. */
export function tools_for(scope: Scope): Omit<ToolDef, "run">[] {
  return TOOLS.filter((t) => scope !== "read" || t.annotations.readOnlyHint === true).map(
    ({ run, ...tool }) => tool,
  );
}

const STATUS_CODES: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

function error_code(status: number | null, data: Record<string, unknown>): string {
  if (status === null) return "invalid_arguments";
  if (status === 0) return "unreachable";
  const entries = Object.values(data);
  const only = entries.length === 1 ? (entries[0] as { code?: unknown } | null) : null;
  if (typeof only?.code === "string") return only.code;
  if (entries.length > 1) return "validation_failed";
  if (status >= 200 && status < 300) return "bad_response";
  if (STATUS_CODES[status]) return STATUS_CODES[status];
  if (status >= 400 && status < 500) return "request_failed";
  return "server_error";
}

/** A failed call: the error object as structuredContent, and serialized as the one text block. */
export function error_result(
  status: number | null,
  message: string,
  data: Record<string, unknown> = {},
): ToolResult {
  const structuredContent = {
    error: { status, code: error_code(status, data), message, fields: data },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    isError: true,
    structuredContent,
  };
}

const validators = new Map(
  TOOLS.map((t) => [t.name, new AjvJsonSchemaValidator().getValidator(t.inputSchema as any)]),
);

/** The same JSON `tm --json` prints; a refusal is a result the agent reads, not a protocol error. */
export async function call(
  cfg: Config,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
  const checked = validators.get(name)!(args);
  if (!checked.valid) return error_result(null, `${name}: ${checked.errorMessage}`);
  try {
    const result = await tool.run(cfg, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (e) {
    if (e instanceof UsageError) return error_result(null, e.message);
    if (e instanceof ApiError) return error_result(e.body.status, e.body.message, e.body.data);
    throw e;
  }
}

const LIST_CACHE = { ttlMs: 300000, cacheScope: "private" } as const;

/** One server over the catalog; `scope_of` decides which tools `tools/list` shows. */
export function make_server(cfg: Config, scope_of: () => Promise<Scope>): Server {
  const server = new Server(
    { name: "tm", version: VERSION },
    {
      capabilities: { tools: {} },
      cacheHints: { "tools/list": LIST_CACHE, "server/discover": LIST_CACHE },
    },
  );
  server.setRequestHandler(
    "tools/list",
    async () => ({ tools: tools_for(await scope_of()) }) as any,
  );
  server.setRequestHandler(
    "tools/call",
    (req) => call(cfg, req.params.name, req.params.arguments ?? {}) as any,
  );
  return server;
}

/** The key's scope from `/me`; the full list when that cannot be read, so a call fails with the API's own refusal. */
function scope_from_me(cfg: Config): () => Promise<Scope> {
  return async () => {
    try {
      return ((await api(cfg, "GET /api/tracker/me", {})).key?.scope ?? "write") as Scope;
    } catch {
      return "write";
    }
  };
}

/** Serve on stdin/stdout until the host closes the pipe. */
export async function serve(cfg: Config): Promise<void> {
  const handle = serveStdio(() => make_server(cfg, scope_from_me(cfg)));
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  await handle.close();
}

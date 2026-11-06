// `tm mcp`: the verbs as MCP tools over stdio, for an agent host that holds an API key.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ApiError, UsageError, type Config } from "./api.ts";
import * as verbs from "./verbs.ts";

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

type ToolDef = Tool & { run: (cfg: Config, a: any) => Promise<unknown> };

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

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: t }],
  isError,
});

const validators = new Map(
  TOOLS.map((t) => [t.name, new AjvJsonSchemaValidator().getValidator(t.inputSchema)]),
);

/** The same JSON `tm --json` prints; a refusal is a result the agent reads, not a protocol error. */
export async function call(
  cfg: Config,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return text(`no tool ${name}`, true);
  const checked = validators.get(name)!(args);
  if (!checked.valid) return text(`${name}: ${checked.errorMessage}`, true);
  try {
    return text(JSON.stringify(await tool.run(cfg, args), null, 2));
  } catch (e) {
    if (e instanceof ApiError) {
      const details = Object.keys(e.body.data).length ? `\n${JSON.stringify(e.body, null, 2)}` : "";
      return text(e.body.message + details, true);
    }
    if (e instanceof UsageError) return text(e.message, true);
    throw e;
  }
}

/** Serve on stdin/stdout until the host closes the pipe. */
export async function serve(cfg: Config): Promise<void> {
  const server = new Server({ name: "tm", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ run, ...tool }) => tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    call(cfg, req.params.name, req.params.arguments ?? {}),
  );
  const closed = new Promise<void>((resolve) => (server.onclose = resolve));
  await server.connect(new StdioServerTransport());
  process.stdin.once("end", () => void server.close()); // the transport itself never notices end of input
  await closed;
}

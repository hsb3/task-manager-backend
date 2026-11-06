#!/usr/bin/env bun
/**
 * Generate openapi.json — an OpenAPI 3.1 spec for this app's PocketBase API.
 *
 * PocketBase ships no OpenAPI export, so this derives the spec deterministically by
 * replaying pb_migrations/ into a throwaway data.db (collections from `_collections`, their
 * prose from `app_docs`, the /api/ rate limit from the settings) and reading the custom-route
 * registry (pb_hooks/lib/routes.js; `internal: true` routes are left out). The spec is what a
 * client generates typed bindings from. Per-record access is governed by per-collection API
 * rules at runtime, not encoded here.
 *
 * Usage: bun scripts/gen_openapi.ts [--check]
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import { by_code_point, json_dumps, read_text, sqlite_connect, py_get } from "./_py.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";

const REPO = path.dirname(path.dirname(path.resolve(import.meta.path)));
const PB = pb_bin_path(REPO);
const MIGRATIONS = path.join(REPO, "pb_migrations");
const OUTPUT = path.join(REPO, "openapi.json");
const ROUTES: Record<string, any> = createRequire(import.meta.url)(
  path.join(REPO, "pb_hooks/lib/routes.js"),
).ROUTES;

const OPENAPI_VERSION = "3.1.0";

// hidden:true credential fields stay in the Record schema but are flagged in their
// description so generated types don't mislead callers.
const HIDDEN_NOTE = "Hidden system field — not returned in API responses.";
const EMAIL_NOTE = "Only returned when the record's emailVisibility flag is true.";

// ----------------------------------------------------------------------------
// Schema extraction (migration replay)
// ----------------------------------------------------------------------------

type RateRule = { maxRequests: number; duration: number };
type Replay = { cols: any[]; docs: Map<string, { title: string; body: string }>; rate: RateRule };

/** Replay migrations into a temp dir and return `_collections` rows (parsed
 * fields/options plus CRUD rules under `_rules`), the `app_docs` rows by slug and the
 * settings' "/api/" rate-limit rule. Throws Error if ./pocketbase is absent, `migrate up`
 * fails or the rule is missing. Copies pb_migrations/ into the temp dir first —
 * never points the tool at the tracked repo directory. */
export function fetch_replay(): Replay {
  if (!fs.existsSync(PB)) {
    throw new Error(
      `no ./pocketbase at ${PB} — run \`make pocketbase\`. ` +
        `A missing binary is a setup error, not a reason to pass.`,
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbopenapi_"));
  let rows: any[][];
  let doc_rows: any[][];
  let settings: any;
  try {
    const mig = path.join(tmp, "pb_migrations");
    fs.cpSync(MIGRATIONS, mig, { recursive: true, dereference: true });
    const data = path.join(tmp, "data");
    const [ok, out] = migrate_up(PB, data, mig);
    if (!ok) {
      throw new Error("`migrate up` failed:\n" + out);
    }

    const con = sqlite_connect(path.join(data, "data.db"));
    try {
      rows = con
        .query(
          "SELECT id, name, type, system, fields, options, " +
            "createRule, updateRule, deleteRule " +
            "FROM _collections ORDER BY name",
        )
        .values() as any[][];
      doc_rows = con.query("SELECT slug, title, body FROM app_docs").values() as any[][];
      const prm = con
        .query("SELECT CAST(value AS TEXT) FROM _params WHERE id = 'settings'")
        .values();
      settings = JSON.parse((prm[0]?.[0] as string) || "{}");
    } finally {
      con.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const rate = (settings?.rateLimits?.rules ?? []).find((r: any) => r.label === "/api/");
  if (!rate || !(rate.maxRequests > 0) || !(rate.duration > 0)) {
    throw new Error('the settings carry no "/api/" rate-limit rule with maxRequests and duration');
  }
  const docs = new Map(doc_rows.map(([slug, title, body]) => [slug, { title, body }]));
  const cols = rows.map(
    ([cid, name, typ, system, fields, options, create_rule, update_rule, delete_rule]) => ({
      id: cid,
      name,
      type: typ,
      system,
      fields: JSON.parse(fields),
      options: JSON.parse(options || "{}"),
      _rules: { create: create_rule, update: update_rule, delete: delete_rule },
    }),
  );
  return { cols, docs, rate: { maxRequests: rate.maxRequests, duration: rate.duration } };
}

// ----------------------------------------------------------------------------
// Naming helpers
// ----------------------------------------------------------------------------

/** snake_case collection name -> PascalCase (tasks->Tasks,
 * workspace_members->WorkspaceMembers). */
function pascal(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function record_schema_name(name: string): string {
  return `${pascal(name)}Record`;
}

function list_schema_name(name: string): string {
  return `${pascal(name)}ListResult`;
}

// ----------------------------------------------------------------------------
// Field -> JSON Schema mapping
// ----------------------------------------------------------------------------

function _multi(f: any): boolean {
  return (f.maxSelect || 1) > 1;
}

/** Map one PocketBase field to a JSON Schema fragment (honest per type). */
function field_schema(f: any, id_to_name: Map<string, string>): any {
  const t = f.type;
  const notes: string[] = [];
  let schema: any;
  let item: any;

  if (["text", "editor", "password"].includes(t)) {
    schema = { type: "string" };
  } else if (t === "email") {
    schema = { type: "string", format: "email" };
    if (f.system) notes.push(EMAIL_NOTE);
  } else if (t === "url") {
    schema = { type: "string", format: "uri" };
  } else if (t === "number") {
    schema = { type: "number" };
  } else if (t === "bool") {
    schema = { type: "boolean" };
  } else if (t === "date" || t === "autodate") {
    schema = { type: "string", format: "date-time" };
  } else if (t === "select") {
    item = { type: "string", enum: [...(f.values || [])] };
    schema = _multi(f) ? { type: "array", items: item } : item;
  } else if (t === "relation") {
    const cid = py_get(f, "collectionId", "");
    const target = py_get(id_to_name, cid, cid);
    notes.push(`Relation record id (target collection: ${target}).`);
    item = { type: "string" };
    schema = _multi(f) ? { type: "array", items: item } : item;
  } else if (t === "file") {
    notes.push("Stored filename (fetch via the files API).");
    item = { type: "string" };
    schema = _multi(f) ? { type: "array", items: item } : item;
  } else if (t === "json") {
    // Empty schema == any JSON value (openapi-typescript -> unknown).
    schema = {};
    notes.push("Arbitrary JSON value.");
  } else if (t === "geoPoint") {
    schema = {
      type: "object",
      properties: { lon: { type: "number" }, lat: { type: "number" } },
    };
  } else {
    // unknown/future field type — fall back to any, but stay visible.
    schema = {};
    notes.push(`Unmapped PocketBase field type: ${t}.`);
  }

  if (f.hidden) notes.push(HIDDEN_NOTE);
  if (notes.length) schema.description = notes.join(" ");
  return schema;
}

/** Build the Record component schema for one collection; `body` is its app_docs body. */
function record_schema(col: any, id_to_name: Map<string, string>, body: string): any {
  const props: any = {};
  const required: string[] = [];
  for (const f of col.fields) {
    props[f.name] = field_schema(f, id_to_name);
    // never mark a hidden credential field required — it's absent from responses.
    if (f.required && !f.hidden) required.push(f.name);
  }

  const schema: any = {
    type: "object",
    description: body,
    properties: props,
  };
  if (required.length) schema.required = required.sort(by_code_point);
  return schema;
}

/** Concrete per-collection paginated list envelope. */
function list_result_schema(col: any): any {
  const ref = `#/components/schemas/${record_schema_name(col.name)}`;
  return {
    type: "object",
    description: `Paginated list of \`${col.name}\` records.`,
    properties: {
      page: { type: "integer" },
      perPage: { type: "integer" },
      totalItems: { type: "integer" },
      totalPages: { type: "integer" },
      items: { type: "array", items: { $ref: ref } },
    },
    required: ["page", "perPage", "totalItems", "totalPages", "items"],
  };
}

// ----------------------------------------------------------------------------
// Path building
// ----------------------------------------------------------------------------

const LIST_QUERY_PARAMS: [string, string, string][] = [
  ["page", "integer", "Page number (1-based)."],
  ["perPage", "integer", "Records per page."],
  ["sort", "string", "Comma-separated sort fields, e.g. `-created,title`."],
  ["filter", "string", "PocketBase filter expression."],
  ["expand", "string", "Comma-separated relations to expand (dynamic)."],
  ["fields", "string", "Comma-separated fields to return."],
  ["skipTotal", "boolean", "Skip the totalItems/totalPages count for speed."],
];
const SINGLE_QUERY_PARAMS: [string, string, string][] = [
  ["expand", "string", "Comma-separated relations to expand (dynamic)."],
  ["fields", "string", "Comma-separated fields to return."],
];

const SECURITY = [{ bearerAuth: [] }];

function _param(name: string, ptype: string, desc: string): any {
  return {
    name,
    in: "query",
    required: false,
    description: desc,
    schema: { type: ptype },
  };
}

function _id_param(): any {
  return {
    name: "id",
    in: "path",
    required: true,
    description: "Record id.",
    schema: { type: "string" },
  };
}

function _json_body(ref: string): any {
  return {
    required: true,
    content: { "application/json": { schema: { $ref: ref } } },
  };
}

function _json_resp(desc: string, ref: string): any {
  return {
    description: desc,
    content: { "application/json": { schema: { $ref: ref } } },
  };
}

/** CRUD paths for one collection. View collections get read-only paths. `title` is the
 * collection's app_docs title, put in front of every operation description. */
function collection_paths(col: any, su_write: boolean, title: string): any {
  const name = col.name;
  const is_view = col.type === "view";
  const rec_ref = `#/components/schemas/${record_schema_name(name)}`;
  const list_ref = `#/components/schemas/${list_schema_name(name)}`;
  const tag = name;
  const su_note = su_write
    ? " Create/update/delete are superuser-only (governed by API rules at runtime)."
    : "";

  const base = `/api/collections/${name}/records`;
  const one = base + "/{id}";
  const paths: any = {};

  paths[base] = {
    get: {
      tags: [tag],
      summary: `List/search ${name} records.`,
      description: `${title}. Access governed by the collection's list API rule.`,
      security: SECURITY,
      parameters: LIST_QUERY_PARAMS.map((p) => _param(...p)),
      responses: { "200": _json_resp("Paginated list.", list_ref) },
    },
  };
  paths[one] = {
    get: {
      tags: [tag],
      summary: `Fetch one ${name} record.`,
      description: `${title}. Access governed by the collection's view API rule.`,
      security: SECURITY,
      parameters: [_id_param(), ...SINGLE_QUERY_PARAMS.map((p) => _param(...p))],
      responses: { "200": _json_resp("The record.", rec_ref) },
    },
  };

  if (is_view) return paths; // views are read-only.

  paths[base].post = {
    tags: [tag],
    summary: `Create a ${name} record.`,
    description: `${title}. Access governed by the collection's create API rule.` + su_note,
    security: SECURITY,
    requestBody: _json_body(rec_ref),
    responses: { "200": _json_resp("The created record.", rec_ref) },
  };
  paths[one].patch = {
    tags: [tag],
    summary: `Update a ${name} record.`,
    description: `${title}. Access governed by the collection's update API rule.` + su_note,
    security: SECURITY,
    parameters: [_id_param()],
    requestBody: _json_body(rec_ref),
    responses: { "200": _json_resp("The updated record.", rec_ref) },
  };
  paths[one].delete = {
    tags: [tag],
    summary: `Delete a ${name} record.`,
    description: `${title}. Access governed by the collection's delete API rule.` + su_note,
    security: SECURITY,
    parameters: [_id_param()],
    responses: { "204": { description: "Deleted (no content)." } },
  };
  return paths;
}

/** users auth endpoints the SPA uses. Base = /api/collections/users. */
function auth_paths(): any {
  const base = "/api/collections/users";
  const auth_ref = "#/components/schemas/AuthResponse";
  const tag = "users-auth";

  function post(
    summary: string,
    body_props: any,
    required: string[],
    resp: any,
    secured = false,
  ): any {
    const op: any = {
      tags: [tag],
      summary,
      description: `${summary} ${ERROR_SHAPE}`,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: body_props,
              required,
            },
          },
        },
      },
      responses: resp,
    };
    if (secured) op.security = SECURITY;
    return op;
  }

  const no_content = { "204": { description: "Accepted (no content)." } };
  const auth_ok = { "200": _json_resp("Auth token and user record.", auth_ref) };

  return {
    [`${base}/auth-with-password`]: {
      post: post(
        "Authenticate with identity (email) + password.",
        {
          identity: {
            type: "string",
            description: "Email (or username) of the user.",
          },
          password: { type: "string" },
        },
        ["identity", "password"],
        auth_ok,
      ),
    },
    [`${base}/auth-refresh`]: {
      post: post("Refresh the current auth token.", {}, [], auth_ok, true),
    },
    [`${base}/auth-with-oauth2`]: {
      post: post(
        "Authenticate with an OAuth2 provider (basic).",
        {
          provider: { type: "string" },
          code: { type: "string" },
          codeVerifier: { type: "string" },
          redirectURL: { type: "string", format: "uri" },
        },
        ["provider", "code", "codeVerifier", "redirectURL"],
        auth_ok,
      ),
    },
    [`${base}/request-verification`]: {
      post: post(
        "Request an email-verification message.",
        { email: { type: "string", format: "email" } },
        ["email"],
        no_content,
      ),
    },
    [`${base}/confirm-verification`]: {
      post: post(
        "Confirm email verification with a token.",
        { token: { type: "string" } },
        ["token"],
        no_content,
      ),
    },
    [`${base}/request-password-reset`]: {
      post: post(
        "Request a password-reset email.",
        { email: { type: "string", format: "email" } },
        ["email"],
        no_content,
      ),
    },
    [`${base}/confirm-password-reset`]: {
      post: post(
        "Confirm a password reset with a token + new password.",
        {
          token: { type: "string" },
          password: { type: "string" },
          passwordConfirm: { type: "string" },
        },
        ["token", "password", "passwordConfirm"],
        no_content,
      ),
    },
  };
}

function health_path(): any {
  return {
    "/api/health": {
      get: {
        tags: ["system"],
        summary: "API health check.",
        description: "Answers 200 while the server is up.",
        responses: {
          "200": {
            description: "Health status.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    code: { type: "integer" },
                    message: { type: "string" },
                    data: {},
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

// ----------------------------------------------------------------------------
// Custom routes (the registry)
// ----------------------------------------------------------------------------

// Wording below is measured in a clean room (anon / user / API key / superuser per auth kind).
const AUTH: Record<string, string> = {
  any:
    "Who may call: anyone signed in, a user or a superuser. " +
    "A missing or invalid token gets 401; a signed-in caller who may not do this gets 403, " +
    "or 404 where a refusal would reveal something hidden from them.",
  users:
    "Who may call: a signed-in user. A missing or invalid token gets 401; " +
    "a superuser gets 403, as does a caller who may not do this.",
  superuser:
    "Who may call: superusers only. A missing or invalid token gets 401; " +
    "a user or an API key gets 403.",
  none: "Who may call: anyone; no sign-in is needed.",
};

const ERROR_SHAPE =
  'Unless an answer documents another body, every error body is {"status": <code>, "message": "<reason>", "data": {}}; ' +
  "a validation error lists the offending fields under data.";

function rate_limit_text(rate: RateRule): string {
  return (
    `Rate limit: the /api/tracker/ routes and /api/health together allow ${rate.maxRequests} requests per ` +
    `${rate.duration} seconds per client address (collection endpoints are counted separately); ` +
    "past that the answer is 429 with no retry header, so wait out the window. " +
    "Superusers are not limited."
  );
}

// KEEP IN SYNC: pb_hooks/api_keys.pb.js key path allowlist (`/api/tracker/admin/`) and key read list (`/api/tracker/export`).
/** What an API key gets on this route: "refused", "read" (any key) or "write" (write scope only). */
function key_access(method: string, p: string): "refused" | "read" | "write" {
  if (!p.startsWith("/api/tracker/") || p.startsWith("/api/tracker/admin/")) return "refused";
  return method === "GET" || method === "HEAD" || (method === "POST" && p === "/api/tracker/export")
    ? "read"
    : "write";
}

const KEY_TEXT = {
  refused: "API keys are refused here with 403.",
  read: "An API key acts as its user, so it may call this too.",
  write: "An API key acts as its user and needs write scope here; a read-only key gets 403.",
};

function _error_resp(desc: string): any {
  return {
    description: desc,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

/** One operation per non-internal registry key; returns [paths, internal count]. */
function route_paths(rate: RateRule, docs: Replay["docs"]): [any, number] {
  const paths: any = {};
  let internal = 0;
  for (const key of Object.keys(ROUTES).sort(by_code_point)) {
    const spec = ROUTES[key];
    if (spec.internal === true) {
      internal += 1;
      continue;
    }
    const sp = key.indexOf(" ");
    const method = key.slice(0, sp);
    const p = key.slice(sp + 1);
    if (!(spec.auth in AUTH)) throw new Error(`route ${key} has unknown auth ${spec.auth}`);
    const api = p.startsWith("/api/");
    const keys = spec.auth === "superuser" ? "" : KEY_TEXT[key_access(method, p)];
    const refusals = Object.entries((spec.responses ?? {}) as Record<string, any>).map(
      ([s, v]): [string, string, any] =>
        typeof v === "string" ? [s, v, null] : [s, v.text, v.schema],
    );
    const lead = spec.docs ? docs.get(spec.docs)?.body : spec.summary;
    if (!lead) throw new Error(`route ${key} names ${spec.docs}, which has no app_docs record`);
    const rest = [
      AUTH[spec.denies ? "users" : spec.auth],
      keys,
      ...refusals.map(([s, text]) => `${s}: ${text}`),
      api ? rate_limit_text(rate) : "",
      ERROR_SHAPE,
    ]
      .filter(Boolean)
      .join(" ");
    const description = lead + (spec.docs ? "\n\n" : " ") + rest;

    const status = String(spec.response.status);
    const ok: any = {
      description: status === "302" ? "Redirects to the dashboard." : "Success.",
    };
    if (spec.response.schema !== null) {
      ok.content = { "application/json": { schema: spec.response.schema } };
    }
    const responses: any = { [status]: ok };
    if (spec.auth !== "none") {
      responses["401"] = _error_resp("The token is missing or invalid.");
    }
    if (spec.auth !== "none") {
      responses["403"] = _error_resp("The caller is signed in but may not do this.");
    } else if (keys === KEY_TEXT.refused) {
      responses["403"] = _error_resp("An API key was sent; API keys are refused here.");
    }
    if (api) responses["429"] = _error_resp("Too many requests; wait out the rate-limit window.");
    for (const [s, text, schema] of refusals)
      responses[s] = schema
        ? { description: text, content: { "application/json": { schema } } }
        : _error_resp(text);

    const op: any = {
      tags: [p.startsWith("/api/tracker/") ? "tracker" : "system"],
      summary: spec.summary,
      description,
      responses,
    };
    if (spec.auth !== "none") op.security = SECURITY;
    if (spec.request)
      op.requestBody = {
        required: !!(spec.request.required?.length || spec.request.minProperties),
        content: { "application/json": { schema: spec.request } },
      };
    const params: any[] = [...p.matchAll(/\{([^}]+)\}/gu)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      description: m[1] === "id" ? "Record id." : `The ${m[1]} path segment.`,
      schema: { type: "string" },
    }));
    for (const [name, q] of Object.entries((spec.query ?? {}) as Record<string, any>))
      params.push({
        name,
        in: "query",
        required: !!q.required,
        description: q.description,
        schema: q.enum ? { type: q.type, enum: q.enum } : { type: q.type },
      });
    if (params.length) op.parameters = params;
    (paths[p] ??= {})[method.toLowerCase()] = op;
  }
  return [paths, internal];
}

// ----------------------------------------------------------------------------
// Assembly
// ----------------------------------------------------------------------------

const INFO_DESCRIPTION =
  "OpenAPI description of this app's PocketBase REST API, generated from the app's own " +
  "collection definitions, their documentation records and its table of custom routes. " +
  "Routes the server calls on itself are left out on purpose. Per-record access is " +
  "governed by each collection's API rules at runtime (not encoded here), " +
  "and relation `expand` is dynamic — the expanded shape depends on the " +
  "`expand` query parameter and the caller's read access. " +
  // Measured on PB 0.40.4 with the body `{`.
  'A route that reads its request body refuses one that is not valid JSON with 400, the message "Something went wrong while processing your request." and empty data; the sign-in, one-time-code and password-reset endpoints word it "An error occurred while loading the submitted data."';

/** Assemble the full OpenAPI document from the replayed DB and the route registry. */
function build_spec({ cols, docs, rate }: Replay): any {
  const id_to_name = new Map<string, string>(cols.map((c) => [c.id, c.name]));
  const app_cols = cols.filter((c) => !c.name.startsWith("_") && !c.system);
  app_cols.sort((a, b) => by_code_point(a.name, b.name));

  // superuser-only-write collections: create/update/delete rules are all null.
  const su_write_names = new Set(app_cols.filter(_su_write).map((c) => c.name));

  const schemas: any = {};
  const paths: any = {};
  const tags: { name: string; description: string }[] = [];

  for (const col of app_cols) {
    const doc = docs.get(`collection:${col.name}`);
    if (!doc)
      throw new Error(`collection ${col.name} has no \`collection:${col.name}\` app_docs record`);
    schemas[record_schema_name(col.name)] = record_schema(col, id_to_name, doc.body);
    schemas[list_schema_name(col.name)] = list_result_schema(col);
    Object.assign(paths, collection_paths(col, su_write_names.has(col.name), doc.title));
    tags.push({ name: col.name, description: doc.title });
  }

  // AuthResponse schema references the users Record schema.
  schemas.AuthResponse = {
    type: "object",
    description: "Response from the users auth endpoints.",
    properties: {
      token: { type: "string" },
      record: { $ref: "#/components/schemas/UsersRecord" },
    },
    required: ["token", "record"],
  };

  schemas.Error = {
    type: "object",
    description: "The body of every error answer.",
    properties: {
      status: { type: "integer" },
      message: { type: "string" },
      data: { type: "object", description: "Offending fields of a validation error; else empty." },
    },
    required: ["status", "message", "data"],
  };

  Object.assign(paths, auth_paths());
  Object.assign(paths, health_path());
  const [routes] = route_paths(rate, docs);
  for (const [p, ops] of Object.entries(routes)) paths[p] = { ...paths[p], ...(ops as any) };
  tags.push({ name: "users-auth", description: "users auth endpoints." });
  tags.push({ name: "system", description: "System endpoints." });
  tags.push({
    name: "tracker",
    description: "Task-tracker actions that span collections or need the server to do the work.",
  });

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "task-manager API",
      version: "1.0.0",
      description: INFO_DESCRIPTION,
    },
    tags,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "PocketBase auth token sent in the Authorization header.",
        },
      },
      schemas,
    },
    paths,
  };
}

/** Superuser-only-write: all of create/update/delete rules are null (False if
 * `_rules` is absent). */
function _su_write(col: any): boolean {
  const rules = col._rules;
  if (!rules) return false;
  return ["create", "update", "delete"].every((k) => rules[k] === null);
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

/** Deterministic JSON text (sorted keys, no timestamps, trailing NL). */
function render(replay: Replay): string {
  const spec = build_spec(replay);
  return json_dumps(spec, { indent: 2, sort_keys: true, ensure_ascii: false }) + "\n";
}

function main(): number {
  const usage = "usage: gen_openapi.ts [-h] [--check]";
  const help =
    `${usage}\n\nGenerate openapi.json — an OpenAPI 3.1 spec derived from pb_migrations/.\n\n` +
    "options:\n  -h, --help  show this help message and exit\n" +
    "  --check     fail on drift instead of writing\n";
  const check_mode = parse_args(usage, help, [["--check", "store_true", "check"]], { check: false })
    .check as boolean;

  let replay: Replay;
  let content: string;
  try {
    replay = fetch_replay();
    content = render(replay);
  } catch (exc) {
    if (!(exc instanceof Error)) throw exc;
    console.log(`❌ gen_openapi: ${exc.message}`);
    return 1;
  }

  if (check_mode) {
    return _check(content);
  }

  fs.writeFileSync(OUTPUT, content, "utf-8");
  const n = replay.cols.filter((c) => !c.name.startsWith("_") && !c.system).length;
  const [routes, internal] = route_paths(replay.rate, replay.docs);
  const r = Object.values(routes).reduce(
    (sum: number, ops: any) => sum + Object.keys(ops).length,
    0,
  );
  console.log(
    `✅ gen_openapi: wrote ${path.relative(REPO, OUTPUT)} (${n} collections, ${r} routes, ` +
      `${internal} internal route${internal === 1 ? "" : "s"} left out).`,
  );
  return 0;
}

function _check(content: string): number {
  let on_disk: string;
  try {
    on_disk = read_text(OUTPUT);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") throw exc;
    console.log(
      `❌ gen_openapi --check: ${OUTPUT} does not exist. ` +
        `Run \`bun scripts/gen_openapi.ts\` to generate it.`,
    );
    return 1;
  }

  if (on_disk === content) {
    console.log("✅ gen_openapi --check: openapi.json is up to date.");
    return 0;
  }

  console.log(
    "❌ gen_openapi --check: openapi.json is out of date with the " +
      "pb_migrations schema or the route registry.\n" +
      "   Run `bun scripts/gen_openapi.ts` to regenerate it.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}

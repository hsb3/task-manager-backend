#!/usr/bin/env bun
/**
 * Pin openapi.json to the route registry and app_docs: every non-internal route documented, every internal one absent, every operation described. No server (app_docs is replayed).
 *
 * `--spec PATH` checks another openapi.json (e.g. the one on HEAD, for a RED run); `--client PATH` checks another api.generated.ts.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fetch_replay } from "../scripts/gen_openapi.ts";
import { read_text } from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const ROUTES: Record<string, any> = createRequire(import.meta.url)(
  path.join(REPO_ROOT, "pb_hooks/lib/routes.js"),
).ROUTES;
const at = process.argv.indexOf("--spec");
const SPEC_PATH =
  at > 0 ? path.resolve(process.argv[at + 1]!) : path.join(REPO_ROOT, "openapi.json");
const SPEC = JSON.parse(read_text(SPEC_PATH));
const PATHS: Record<string, any> = SPEC.paths ?? {};
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
}

console.log(`── ${SPEC_PATH} against the route registry ──`);
for (const [key, spec] of Object.entries(ROUTES)) {
  const sp = key.indexOf(" ");
  const method = key.slice(0, sp).toLowerCase();
  const p = key.slice(sp + 1);
  const op = PATHS[p]?.[method];
  if (spec.internal === true) {
    check(`${key}: internal route is absent`, op === undefined);
    continue;
  }
  if (!op) {
    check(`${key}: documented`, false);
    continue;
  }
  const authed = spec.auth !== "none";
  const desc: string = op.description ?? "";
  check(
    `${key}: summary, description, 429 iff /api/, security iff signed-in, ` +
      `${spec.response.status} and 401 iff signed-in in responses`,
    !!op.summary &&
      !!desc &&
      desc.includes("429") === p.startsWith("/api/") &&
      "security" in op === authed &&
      String(spec.response.status) in (op.responses ?? {}) &&
      "401" in (op.responses ?? {}) === authed,
  );
}

const ERROR_REF = "#/components/schemas/Error";
const op_of = (key: string): any => {
  const sp = key.indexOf(" ");
  return PATHS[key.slice(sp + 1)]?.[key.slice(0, sp).toLowerCase()];
};
const live = Object.entries(ROUTES).filter(([, s]) => s.internal !== true);

// Handler text per registry key: from its `.add("KEY"` site to the call's closing `)` at column 0 (prettier's layout).
const SITE = /\.add\(\s*"([A-Z]+ \/[^"]+)"/gu;
const HANDLER: Record<string, string> = {};
const HOOKS = path.join(REPO_ROOT, "pb_hooks");
for (const f of fs.readdirSync(HOOKS).filter((f) => f.endsWith(".pb.js"))) {
  const text = read_text(path.join(HOOKS, f));
  for (const m of text.matchAll(SITE)) {
    const end = text.slice(m.index).search(/\n\}?\)/u);
    HANDLER[m[1]!] = text.slice(m.index, end < 0 ? undefined : m.index + end);
  }
}

console.log("── POST/PATCH: request body and the statuses the handler returns ──");
for (const [key, spec] of live) {
  if (!/^(POST|PATCH) /u.test(key)) continue;
  const op = op_of(key);
  const reads = /requestInfo\(\)\.body/u.test(HANDLER[key] ?? "");
  check(`${key}: request declared iff the handler reads a body`, !!spec.request === reads);
  check(
    `${key}: requestBody iff request, and its schema is the registry's`,
    !!op?.requestBody === !!spec.request &&
      (!spec.request ||
        Bun.deepEquals(op.requestBody.content?.["application/json"]?.schema, spec.request)),
  );
}
for (const [key, spec] of live) {
  const op = op_of(key);
  for (const [status, text] of Object.entries((spec.responses ?? {}) as Record<string, string>)) {
    check(
      `${key}: ${status} answer with the Error schema and its text in the description`,
      op?.responses?.[status]?.content?.["application/json"]?.schema?.$ref === ERROR_REF &&
        op.responses[status].description === text &&
        (op.description ?? "").includes(text),
    );
  }
}

console.log("── query parameters: declared iff the handler reads them, rendered as declared ──");
const ALIAS = /\b(?:const|let|var)\s+(\w+)\s*=\s*e\.request\.url\.query\(\)/gu;
function query_reads(text: string): string[] {
  const aliases = ["query", ...[...text.matchAll(ALIAS)].map((m) => m[1]!)];
  const READ = new RegExp(
    `(?:\\.query\\(\\)|\\b(?:${aliases.join("|")}))(?:\\.(?:get|has)\\(\\s*"(\\w+)"\\s*\\)|\\[\\s*"(\\w+)"\\s*\\])`,
    "gu",
  );
  return [...new Set([...text.matchAll(READ)].map((m) => (m[1] ?? m[2])!))].sort();
}
for (const [key, spec] of live) {
  const op = op_of(key);
  const declared = Object.keys(spec.query ?? {});
  const reads = query_reads(HANDLER[key] ?? "");
  check(
    `${key}: query declared = query the handler reads (${reads.join(", ") || "none"})`,
    Bun.deepEquals([...declared].sort(), reads),
  );
  const rendered = (op?.parameters ?? []).filter((p: any) => p.in === "query");
  check(
    `${key}: openapi query parameters are the declared ones, in order, with their types`,
    Bun.deepEquals(
      rendered.map((p: any) => [p.name, p.schema?.type, p.schema?.enum, p.required]),
      Object.entries((spec.query ?? {}) as Record<string, any>).map(([n, q]) => [
        n,
        q.type,
        q.enum,
        !!q.required,
      ]),
    ),
  );
}

console.log("── info: the malformed-body answer, as measured ──");
// Measured on PB 0.40.4 (and provoked live by tests/test_route_errors.ts): body `{`, Content-Type application/json.
const MALFORMED_BODY =
  'A route that reads its request body refuses one that is not valid JSON with 400, the message "Something went wrong while processing your request." and empty data; the sign-in, one-time-code and password-reset endpoints word it "An error occurred while loading the submitted data."';
check(
  "info.description states the malformed-body answer",
  (SPEC.info?.description ?? "").includes(MALFORMED_BODY),
);

console.log("── in-handler refusals match measured behaviour ──");
const SUPERUSER_403 = "a superuser gets 403";
for (const key of [
  "GET /api/tracker/me",
  "GET /api/tracker/me/landing",
  "GET /api/tracker/project-items/counts",
])
  check(
    `${key}: says a superuser gets 403`,
    (op_of(key)?.description ?? "").includes(SUPERUSER_403),
  );
for (const [key, spec] of live)
  if (spec.denies || spec.auth === "users")
    check(
      `${key}: refuses superusers, so says so`,
      (op_of(key)?.description ?? "").includes(SUPERUSER_403),
    );
for (const key of [
  "GET /api/tracker/admin/pending-users",
  "POST /api/tracker/admin/pending-users/{id}/approve",
])
  check(
    `${key}: documents the 404 a non-administrator gets`,
    op_of(key)?.responses?.["404"]?.content?.["application/json"]?.schema?.$ref === ERROR_REF,
  );

console.log("── route:* app_docs lead their route's description ──");
const { docs } = fetch_replay();
const claimed = new Set(live.map(([, s]) => s.docs).filter(Boolean));
for (const slug of [...docs.keys()].filter((s) => s.startsWith("route:")).sort())
  check(`${slug}: rendered on a route`, claimed.has(slug));
for (const [key, spec] of live) {
  if (!spec.docs) continue;
  const op = op_of(key);
  const desc: string = op?.description ?? "";
  const body = docs.get(spec.docs)?.body;
  check(
    `${key}: description starts with ${spec.docs}; summary is not repeated`,
    !!body && desc.startsWith(body) && desc.split(op.summary).length <= 2,
  );
}

console.log("── collection endpoints carry their app_docs title ──");
const TAGS = new Map<string, string>((SPEC.tags ?? []).map((t: any) => [t.name, t.description]));
for (const [p, ops] of Object.entries(PATHS)) {
  const m = /^\/api\/collections\/([^/]+)\/records$/u.exec(p);
  if (!m) continue;
  const name = m[1]!;
  const descs = [p, `${p}/{id}`].flatMap((q) =>
    Object.values(PATHS[q] ?? {}).map((op: any) => op.description ?? ""),
  );
  check(
    `${name}: no operation description starts with the generic access sentence; tag is not the generic one`,
    descs.length > 0 &&
      descs.every((d) => d && !d.startsWith("Access governed")) &&
      !!TAGS.get(name) &&
      TAGS.get(name) !== `\`${name}\` collection endpoints.`,
  );
}

console.log("── tm client: Paths carries every request body and query parameter ──");
const client_at = process.argv.indexOf("--client");
const CLIENT = read_text(
  client_at > 0
    ? path.resolve(process.argv[client_at + 1]!)
    : path.join(REPO_ROOT, "clients", "tm", "src", "api.generated.ts"),
);
/** The TS type text a schema fragment must render as; an object with properties is `{…}` (checked one level deep). */
function expected_type(s: any): string {
  if (!s || typeof s !== "object") return "unknown";
  const prim: Record<string, string> = {
    string: "string",
    integer: "number",
    number: "number",
    boolean: "boolean",
    null: "null",
  };
  let t: string;
  if (s.$ref) t = String(s.$ref).split("/").pop()!;
  else if (s.enum) t = s.enum.map((v: unknown) => JSON.stringify(v)).join("|");
  else if (s.anyOf || s.oneOf) t = (s.anyOf ?? s.oneOf).map(expected_type).join("|");
  else if (Array.isArray(s.type))
    t = s.type.map((x: string) => expected_type({ ...s, type: x })).join("|");
  else if (prim[s.type]) t = prim[s.type]!;
  else if (s.type === "array") {
    const item = expected_type(s.items);
    t = item.includes("|") ? `(${item})[]` : `${item}[]`;
  } else if (s.type === "object")
    t = Object.keys(s.properties ?? {}).length ? "{…}" : "Record<string,unknown>";
  else t = "unknown";
  return s.nullable && t !== "unknown" ? `${t}|null` : t;
}
/** Rendered type text with whitespace dropped and every `{ … }` block collapsed to `{…}`. */
function collapsed(text: string): string {
  let out = "";
  let depth = 0;
  for (const c of text.replace(/\s+/gu, "")) {
    if (c === "{") {
      if (depth++ === 0) out += "{…}";
    } else if (c === "}") depth--;
    else if (depth === 0) out += c;
  }
  return out.replace(/^\|/u, "").replace(/;$/u, "");
}
/** Top-level members of the `{ ... }` starting at `at`: name → its type text. */
function members(text: string, at: number): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let start = at + 1;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    if ((depth === 1 && c === ";") || depth === 0) {
      const m = /^\s*"?([\w$]+)"?\??:\s*([\s\S]*)$/u.exec(text.slice(start, i));
      if (m) out.set(m[1]!, m[2]!);
      start = i + 1;
      if (depth === 0) break;
    }
  }
  return out;
}
const PATHS_AT = CLIENT.indexOf("export interface Paths {");
for (const [p, ops] of Object.entries(PATHS)) {
  if (!p.startsWith("/api/tracker/") && p !== "/api/health") continue;
  for (const [m, op] of Object.entries(ops as Record<string, any>)) {
    const key = `${m.toUpperCase()} ${p}`;
    const at = PATHS_AT < 0 ? -1 : CLIENT.indexOf(`"${key}": {`, PATHS_AT);
    const entry = at < 0 ? new Map() : members(CLIENT, CLIENT.indexOf("{", at + key.length + 2));
    if (op.requestBody) check(`${key}: Paths entry has a body`, entry.has("body"));
    // Typed pins: each rendered property's type against the spec, one level deep.
    const pin = (what: string, schema: any, text: string | undefined): void => {
      if (text === undefined) return;
      const props = schema?.type === "object" && !schema.anyOf ? schema.properties : undefined;
      if (props && text.trimStart().startsWith("{")) {
        const got = members(text, text.indexOf("{"));
        for (const [n, ps] of Object.entries(props))
          check(
            `${key}: ${what}.${n} renders as ${expected_type(ps)}`,
            collapsed(got.get(n) ?? "") === expected_type(ps),
          );
      } else
        check(
          `${key}: ${what} renders as ${expected_type(schema)}`,
          collapsed(text) === expected_type(schema),
        );
    };
    for (const where of ["path", "query"]) {
      const params = (op.parameters ?? []).filter((x: any) => x.in === where);
      if (params.length)
        pin(
          where,
          {
            type: "object",
            properties: Object.fromEntries(params.map((x: any) => [x.name, x.schema])),
          },
          entry.get(where),
        );
    }
    if (op.requestBody)
      pin("body", op.requestBody.content?.["application/json"]?.schema, entry.get("body"));
    const ok = Object.keys(op.responses ?? {})
      .sort()
      .find((c) => c.startsWith("2"));
    const answer = ok ? op.responses[ok].content?.["application/json"]?.schema : undefined;
    if (answer) pin("response", answer, entry.get("response"));
    const names = (op.parameters ?? [])
      .filter((x: any) => x.in === "query")
      .map((x: any) => x.name);
    if (names.length) {
      const query = entry.get("query") ?? "";
      const declared = query.startsWith("{") ? [...members(query, 0).keys()] : [];
      check(
        `${key}: Paths entry's query names ${names.join(", ")}`,
        Bun.deepEquals([...declared].sort(), [...names].sort()),
      );
    }
  }
}

console.log(
  "  bounded: typed pins cover path/query params, body and the first 2xx JSON response one level deep (a nested object is checked only as `{…}`)",
);

console.log("── whole document ──");
const bare: string[] = [];
for (const [p, ops] of Object.entries(PATHS)) {
  for (const [m, op] of Object.entries(ops as Record<string, any>)) {
    if (METHODS.includes(m) && !op?.description) bare.push(`${m.toUpperCase()} ${p}`);
  }
}
check(
  `every operation has a description${bare.length ? ` (missing: ${bare.join(", ")})` : ""}`,
  !bare.length,
);
check("components.schemas.Error exists", !!SPEC.components?.schemas?.Error);
const undescribed: string[] = [];
for (const [name, schema] of Object.entries(SPEC.components?.schemas ?? {}) as [string, any][])
  for (const [prop, ps] of Object.entries(schema.properties ?? {}) as [string, any][])
    if (!ps?.description) undescribed.push(`${name}.${prop}`);
check(
  `every schema property has a description${undescribed.length ? ` (${undescribed.length} missing: ${undescribed.slice(0, 5).join(", ")}…)` : ""}`,
  !undescribed.length,
);
// Prose describes behaviour: no file, script or server-mechanism names; a `hook:` slug is an address, not a mechanism.
const MECHANISM =
  /pb_hooks\/|pb_migrations\/|scripts\/|\.pb\.js|\.(js|ts)\b|\bhooks?\b(?!:)|migration|\bcron\b|JSVM|\$http|\$app|\$apis|middleware|routerAdd|universal[- ]tier|\bSQL\b/iu;
const leaks: string[] = [];
const walk = (v: any, at: string): void => {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "description" && typeof x === "string" && MECHANISM.test(x))
        leaks.push(`${at} (${MECHANISM.exec(x)![0]})`);
      walk(x, `${at}.${k}`);
    }
};
walk(SPEC, "$");
check(
  `no description names a file, script or mechanism${leaks.length ? ` (${leaks.length}: ${leaks.join("; ")})` : ""}`,
  !leaks.length,
);

console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all openapi route checks passed");
process.exit(failures ? 1 : 0);

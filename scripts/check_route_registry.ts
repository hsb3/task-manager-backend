#!/usr/bin/env bun
/** Every custom route is declared once in pb_hooks/lib/routes.js and registered by exactly one site; no router token elsewhere. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";

const REGISTRY = "pb_hooks/lib/routes.js";
const BARE = /\brouterAdd\s*\(/u;
const USE = /\brouterUse\s*\(/u;
// Routes and middleware reach the router only by these names; the gate funnels middleware through one door but does not analyse a middleware body.
const TOKEN = /\b(routerAdd|routerUse|router)\b/u;
const SITE = /\.add\(\s*"([A-Z]+ \/[^"]+)"/gu;
const KEY = /^(GET|POST|PUT|PATCH|DELETE) \//u;
const AUTH = ["any", "users", "superuser", "none"];
const FIELDS = [
  "summary",
  "auth",
  "response",
  "internal",
  "request",
  "responses",
  "denies",
  "docs",
  "query",
];
const QUERY_TYPES = ["string", "integer", "boolean"];
const QUERY_KEYS = ["type", "description", "required", "enum"];

// shortcut: deeper `${}` nesting, a regex after a token the lookbehind does not list (`)`, `]`, a name), a computed or destructured add()/routerUse and a computed require path are not understood, upgrade if a hook needs one.
// Comments are blanked (newlines kept so reported line numbers stay right); strings too unless `keep_strings`.
const SCAN =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\[\s\S]|\$(?!\{)|\$\{(?:[^{}`]|`(?:[^`\\]|\\[\s\S])*`|\{[^{}]*\})*\})*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<=(?:^|[(,=:[!&|?{};+\-*%<>~^]|(?<!\.)\b(?:return|typeof|case|throw|in|of|new|delete|void|instanceof|yield|await|else|do))\s*)(?<!\+\+\s*|--\s*)\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/gu;
export const lines_of = (text: string, keep_strings: boolean): string[] =>
  text
    .replace(SCAN, (m) => (keep_strings && /^["'`]/u.test(m) ? m : m.replace(/[^\n]/gu, "")))
    .split("\n");

const one_line = (s: unknown): boolean =>
  typeof s === "string" && s.trim() !== "" && !/[\r\n]/u.test(s);
const is_obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const query_ok = (v: unknown): boolean =>
  is_obj(v) &&
  Object.keys(v).every((k) => QUERY_KEYS.includes(k)) &&
  QUERY_TYPES.includes(v.type as string) &&
  one_line(v.description) &&
  (!("required" in v) || v.required === true) &&
  (!("enum" in v) || (Array.isArray(v.enum) && v.enum.length > 0));

function malformed(key: string, e: any): string[] {
  const bad: string[] = [];
  if (!KEY.test(key)) bad.push("key must be METHOD /path");
  if (!e || typeof e !== "object") return [...bad, "entry is not an object"];
  const extra = Object.keys(e).filter((k) => !FIELDS.includes(k));
  if (extra.length) bad.push(`unknown field(s) ${extra.join(", ")}`);
  if (!one_line(e.summary)) bad.push("summary must be one non-empty line");
  if (!AUTH.includes(e.auth)) bad.push(`auth must be one of ${AUTH.join("|")}`);
  const r = e.response;
  if (!r || typeof r !== "object" || !Number.isInteger(r.status) || !("schema" in r))
    bad.push("response must be { status: integer, schema }");
  if ("internal" in e && e.internal !== true) bad.push("internal, if present, must be true");
  if ("request" in e && !(is_obj(e.request) && e.request.type === "object"))
    bad.push('request, if present, must be a JSON schema with type "object"');
  if (
    "responses" in e &&
    !(
      is_obj(e.responses) &&
      Object.entries(e.responses).every(([k, v]) => /^[1-5]\d\d$/u.test(k) && one_line(v))
    )
  )
    bad.push("responses, if present, must map 3-digit status strings to one non-empty line each");
  if ("query" in e && !(is_obj(e.query) && Object.values(e.query).every(query_ok)))
    bad.push(
      "query, if present, must map each name to { type: string|integer|boolean, description: <one line>, required?: true, enum?: [...] }",
    );
  if ("denies" in e && !(JSON.stringify(e.denies) === '["superuser"]' && e.auth === "any"))
    bad.push('denies, if present, must be ["superuser"] on an auth "any" entry');
  if ("docs" in e && !(typeof e.docs === "string" && /^route:[a-z0-9-]+$/u.test(e.docs)))
    bad.push("docs, if present, must be route:<slug> (lowercase letters, digits, hyphens)");
  return bad.map((b) => `${key} is malformed: ${b}`);
}

export function offenders(root: string): string[] {
  const hooks = path.join(root, "pb_hooks");
  const out: string[] = [];
  const sites: Record<string, string[]> = {};
  const files = fs
    .readdirSync(hooks, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".js"))
    .sort();
  let registryAdds = 0;
  let registryUses = 0;
  for (const rel of files) {
    const file = `pb_hooks/${rel}`;
    const isRegistry = file === REGISTRY;
    const text = fs.readFileSync(path.join(hooks, rel), "utf8");
    const lines = lines_of(text, false);
    lines.forEach((ln, i) => {
      if (isRegistry && USE.test(ln)) registryUses += 1;
      if (BARE.test(ln)) {
        if (isRegistry) registryAdds += 1;
        else out.push(`bare routerAdd at ${file}:${i + 1} — register through ${REGISTRY}`);
      } else if (!isRegistry) {
        const t = TOKEN.exec(ln);
        if (t) out.push(`${t[1]} token at ${file}:${i + 1} — register through ${REGISTRY}`);
      }
    });
    // prettier wraps a long site so the key lands on the line after `.add(`: match the whole text.
    const stripped = lines_of(text, true).join("\n");
    if (!isRegistry && /lib\/routes\.js/u.test(stripped))
      for (const m of stripped.matchAll(/\.add\(\s*[^"\s]/gu))
        out.push(
          `${file}:${stripped.slice(0, m.index).split("\n").length} add() key must be a string literal`,
        );
    for (const m of stripped.matchAll(SITE)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      (sites[m[1]] ??= []).push(`${file}:${line}`);
    }
  }
  if (!files.includes("lib/routes.js"))
    return [
      ...out,
      `${REGISTRY} is missing — it must hold the only routerAdd( and the ROUTES table`,
    ];
  if (registryAdds !== 1) out.push(`${REGISTRY} has ${registryAdds} routerAdd( calls (want 1)`);
  if (registryUses !== 1) out.push(`${REGISTRY} has ${registryUses} routerUse( calls (want 1)`);
  let routes: Record<string, any>;
  try {
    routes = createRequire(import.meta.url)(path.join(root, REGISTRY)).ROUTES;
    if (!routes || typeof routes !== "object") throw new Error("no ROUTES export");
  } catch (err) {
    return [...out, `${REGISTRY} cannot be loaded: ${(err as Error).message}`];
  }
  for (const [key, where] of Object.entries(sites))
    if (!(key in routes))
      for (const w of where) out.push(`${w} registers ${key}, not in the registry`);
  for (const key of Object.keys(routes)) {
    out.push(...malformed(key, routes[key]));
    const n = sites[key]?.length ?? 0;
    if (n !== 1)
      out.push(`${key} has ${n} sites (want 1)${n ? ` — ${sites[key].join(", ")}` : ""}`);
  }
  return out;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "usage: check_route_registry.ts [--root DIR]\n\nRefuse routes outside the pb_hooks/lib/routes.js registry.",
    );
    process.exit(0);
  }
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : repo_root(import.meta.path);
  const bad = offenders(root);
  if (bad.length) {
    for (const b of bad) console.log(`❌ check_route_registry: ${b}`);
    process.exit(1);
  }
  const n = Object.keys(createRequire(import.meta.url)(path.join(root, REGISTRY)).ROUTES).length;
  console.log(`✅ check_route_registry: ${n} routes, each registered once through ${REGISTRY}`);
}

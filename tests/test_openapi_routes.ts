#!/usr/bin/env bun
/**
 * Pin openapi.json to the route registry and app_docs: every non-internal route documented, every internal one absent, every operation described. No server.
 *
 * `--spec PATH` checks another openapi.json (e.g. the one on HEAD, for a RED run).
 */

import { createRequire } from "node:module";
import path from "node:path";
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

console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all openapi route checks passed");
process.exit(failures ? 1 : 0);

#!/usr/bin/env bun
/** Every error status a route handler's own text returns is documented in its pb_hooks/lib/routes.js entry; a status from a variable, a helper, PocketBase itself or the e.error/e.notFoundError/e.badRequestError/e.blob methods is unseen. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { lines_of } from "./check_route_registry.ts";
import { repo_root } from "./_repo_root.ts";

const REGISTRY = "pb_hooks/lib/routes.js";
const BOUND =
  "a status held in a variable, a helper throwing on the handler's behalf, PocketBase's own answers (auth middleware, malformed JSON, rate limit), and the e.error(...), e.notFoundError(...), e.badRequestError(...) and e.blob(...) methods are unseen";
const SITE = /\.add\(\s*"([A-Z]+ \/[^"]+)"/gu;
const CLASS: Record<string, number> = {
  BadRequestError: 400,
  ValidationError: 400,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  NotFoundError: 404,
  TooManyRequestsError: 429,
  InternalServerError: 500,
};
// A ValidationError is a field error carried in another error's data; only a thrown one answers on its own.
const THROWN =
  /(\bthrow\s+)?\bnew\s+(?:ApiError\s*\(\s*(\d{3})\b|(\w+Error)\s*\()|\be\.(?:json|string)\s*\(\s*([45]\d\d)\b/gu;

export function offenders(root: string): string[] {
  const routes: Record<string, any> = createRequire(import.meta.url)(
    path.join(root, REGISTRY),
  ).ROUTES;
  const hooks = path.join(root, "pb_hooks");
  const out: string[] = [];
  for (const rel of fs
    .readdirSync(hooks, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".js"))
    .sort()) {
    const raw = fs.readFileSync(path.join(hooks, rel), "utf8");
    // Sites are found with strings kept (the key is one); statuses with strings blanked too.
    const text = lines_of(raw, true).join("\n");
    const bare = lines_of(raw, false);
    for (const m of text.matchAll(SITE)) {
      const spec = routes[m[1]!];
      if (!spec || spec.internal === true) continue;
      const documented = new Set(Object.keys(spec.responses ?? {}).map(Number));
      if (spec.denies) documented.add(403);
      // The handler runs to the call's closing paren at column 0 (prettier's layout).
      const end = text.slice(m.index).search(/\n\}?\)/u);
      const first = text.slice(0, m.index).split("\n").length;
      const last = end < 0 ? bare.length : text.slice(0, m.index + end).split("\n").length;
      const body = bare.slice(first - 1, last).join("\n");
      for (const t of body.matchAll(THROWN)) {
        const status = Number(t[2] ?? t[4] ?? CLASS[t[3]!]);
        if (!status || (t[3] === "ValidationError" && !t[1]) || documented.has(status)) continue;
        const line = first - 1 + body.slice(0, t.index).split("\n").length;
        out.push(
          `${m[1]} throws ${status} at pb_hooks/${rel}:${line} — document it in ${REGISTRY} responses`,
        );
      }
    }
  }
  return out;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "usage: check_route_statuses.ts [--root DIR]\n\nRefuse a route handler that returns an error status its pb_hooks/lib/routes.js entry does not document.",
    );
    process.exit(0);
  }
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? path.resolve(process.argv[i + 1]!) : repo_root(import.meta.path);
  console.log(`bounded: ${BOUND}`);
  const bad = offenders(root);
  if (bad.length) {
    for (const b of bad) console.log(`❌ check_route_statuses: ${b}`);
    process.exit(1);
  }
  const n = Object.values(createRequire(import.meta.url)(path.join(root, REGISTRY)).ROUTES).filter(
    (s: any) => s.internal !== true,
  ).length;
  console.log(
    `✅ check_route_statuses: ${n} public routes, every literal error status their handler text returns is documented`,
  );
}

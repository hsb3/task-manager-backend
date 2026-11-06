#!/usr/bin/env bun
/** Unit-pin scripts/check_route_registry.ts against mirrored pb_hooks/ trees (no server, no DB). */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { offenders } from "../scripts/check_route_registry.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const CHECKER = path.join(REPO_ROOT, "scripts", "check_route_registry.ts");
const REGISTRY = "pb_hooks/lib/routes.js";
const HOST = "pb_hooks/me.pb.js";
const OTHER = "pb_hooks/names.pb.js";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`,
  );
}

function tree_hash(): string {
  const h = createHash("sha256");
  const dir = path.join(REPO_ROOT, "pb_hooks");
  for (const rel of fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()) {
    const p = path.join(dir, rel);
    if (fs.statSync(p).isFile()) h.update(rel).update(fs.readFileSync(p));
  }
  return h.digest("hex");
}

function mirror(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbroutes_"));
  fs.cpSync(path.join(REPO_ROOT, "pb_hooks"), path.join(root, "pb_hooks"), { recursive: true });
  return root;
}

const append = (root: string, rel: string, text: string) =>
  fs.appendFileSync(path.join(root, rel), `\n${text}\n`);

function cli(root: string): number {
  return (
    Bun.spawnSync([process.execPath, CHECKER, "--root", root], {
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode ?? -1
  );
}

/** Mirror, mutate, and expect exactly the offences matching `want` (one each), CLI exit 1. */
function expect_red(label: string, mutate: (root: string) => void, want: RegExp[]): void {
  const root = mirror();
  try {
    mutate(root);
    const got = offenders(root);
    check(`${label}: ${want.length} offence(s)`, got.length === want.length, JSON.stringify(got));
    for (const w of want)
      check(
        `...one matches ${w}`,
        got.some((g) => w.test(g)),
        JSON.stringify(got),
      );
    check(`${label}: CLI exits 1`, cli(root) === 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const BEFORE = tree_hash();
console.log("════════ test_route_registry_checker.ts — check_route_registry.ts gate pins ════════");

console.log("\n── (a) the live tree is GREEN ──");
let root = mirror();
check(
  "live tree: no offences",
  offenders(REPO_ROOT).length === 0,
  JSON.stringify(offenders(REPO_ROOT)),
);
check("live tree: CLI exits 0", cli(REPO_ROOT) === 0);
check("mirror: no offences", offenders(root).length === 0);
const ROUTES = createRequire(import.meta.url)(path.join(REPO_ROOT, REGISTRY)).ROUTES;
const KEY = Object.keys(ROUTES)[0];
fs.rmSync(root, { recursive: true, force: true });

console.log("\n── (b) a bare routerAdd outside the registry ──");
expect_red(
  "planted routerAdd",
  (r) => append(r, HOST, 'routerAdd("GET", "/api/probe/x", (e) => e.json(200, {}));'),
  [/^bare routerAdd at pb_hooks\/me\.pb\.js:\d+/u],
);

console.log("\n── (c) a site whose key is not in the registry ──");
expect_red(
  "unregistered key",
  (r) =>
    append(
      r,
      HOST,
      'require(`${__hooks}/lib/routes.js`).add("GET /api/probe/nope", (e) => e.json(200, {}));',
    ),
  [/me\.pb\.js:\d+ registers GET \/api\/probe\/nope, not in the registry/u],
);

console.log("\n── (d) a registry entry no site serves ──");
expect_red(
  "documented but unserved",
  (r) => {
    const p = path.join(r, REGISTRY);
    const text = fs.readFileSync(p, "utf8");
    const at = text.indexOf("\n};", text.indexOf("ROUTES"));
    const entry = `\n  "GET /api/probe/unserved": { summary: "x", auth: "none", response: { status: 200, schema: null } },`;
    fs.writeFileSync(p, text.slice(0, at) + entry + text.slice(at));
  },
  [/GET \/api\/probe\/unserved has 0 sites/u],
);

console.log("\n── (e) one route registered twice ──");
expect_red(
  "duplicate site",
  (r) =>
    append(
      r,
      OTHER,
      `require(\`\${__hooks}/lib/routes.js\`).add("${KEY}", (e) => e.json(200, {}));`,
    ),
  [new RegExp(`${KEY.replace(/[/]/gu, "\\/")} has 2 sites`, "u")],
);

console.log("\n── (f) a malformed entry ──");
expect_red(
  "auth: admin",
  (r) => {
    const p = path.join(r, REGISTRY);
    const text = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, text.replace(/^(\s+)auth: "[a-z]+",$/mu, '$1auth: "admin",'));
  },
  [/is malformed: auth must be one of/u],
);

console.log("\n── (g2) a site inside a block comment registers nothing ──");
expect_red(
  "block-commented site",
  (r) => {
    const p = path.join(r, HOST);
    const text = fs.readFileSync(p, "utf8");
    fs.writeFileSync(
      p,
      text.replace(
        "require(`${__hooks}/lib/routes.js`).add(",
        "/* require(`${__hooks}/lib/routes.js`).add(",
      ),
    );
    fs.appendFileSync(p, "\n*/\n");
  },
  [/has 0 sites \(want 1\)/u],
);

console.log("\n── (g) a commented routerAdd is not a route ──");
root = mirror();
append(root, HOST, "// routerAdd(`mentioned in a comment`)");
check("comment only: no offences", offenders(root).length === 0, JSON.stringify(offenders(root)));
fs.rmSync(root, { recursive: true, force: true });

console.log("\n── (h) no tracked source was rewritten ──");
check("pb_hooks/ is byte-identical", tree_hash() === BEFORE);

console.log();
if (failures) {
  console.log(`❌ test_route_registry_checker: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ test_route_registry_checker: every check passed");

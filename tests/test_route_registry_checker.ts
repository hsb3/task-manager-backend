#!/usr/bin/env bun
/** Unit-pin scripts/check_route_registry.ts against mirrored pb_hooks/ trees (no server, no DB). */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { offenders } from "../scripts/check_route_registry.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

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
  copy_tree(path.join(REPO_ROOT, "pb_hooks"), path.join(root, "pb_hooks"));
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

/** Insert `entry` (an object literal) under `key` in the mirrored ROUTES and serve it from HOST. */
function plant_entry(r: string, key: string, entry: string): void {
  const p = path.join(r, REGISTRY);
  const text = fs.readFileSync(p, "utf8");
  const at = text.indexOf("\n};", text.indexOf("ROUTES"));
  fs.writeFileSync(p, `${text.slice(0, at)}\n  "${key}": ${entry},${text.slice(at)}`);
  append(r, HOST, `require(\`\${__hooks}/lib/routes.js\`).add("${key}", (e) => e.json(200, {}));`);
}

/** Append `text` to `rel` in a mirror and return the 1-based line it lands on. */
function plant_line(r: string, rel: string, text: string): number {
  const n = fs.readFileSync(path.join(r, rel), "utf8").split("\n").length + 1;
  append(r, rel, text);
  return n;
}

const BASE = 'summary: "x", auth: "any", response: { status: 200, schema: null }';
const PROBE = "POST /api/probe/f";
const MAL = (field: string) =>
  new RegExp(`^POST /api/probe/f is malformed: ${field}, if present`, "u");

console.log("\n── (i) a route bound through the onServe router outside the registry ──");
expect_red(
  "se.router in onServe",
  (r) =>
    append(
      r,
      HOST,
      '$app.onServe().bindFunc((se) => { se.router.GET("/x", (e) => e.string(200, "x")) })',
    ),
  [/^router token at pb_hooks\/me\.pb\.js:\d+ — register through pb_hooks\/lib\/routes\.js$/u],
);
root = mirror();
const AT = plant_line(root, OTHER, "e.router.GET('/z', (e) => e.string(200, 'z'))");
const GOT = offenders(root);
check(
  "e.router: names the exact file:line",
  GOT.length === 1 && GOT[0].startsWith(`router token at ${OTHER}:${AT} `),
  JSON.stringify(GOT),
);
fs.rmSync(root, { recursive: true, force: true });

console.log("\n── (j) routerAdd reached without a direct call ──");
expect_red(
  "const ra = routerAdd alias",
  (r) => append(r, HOST, 'const ra = routerAdd; ra("GET", "/y", (e) => e.string(200, "y"));'),
  [/^routerAdd token at pb_hooks\/me\.pb\.js:\d+ — register through pb_hooks\/lib\/routes\.js$/u],
);
expect_red(
  "routerAdd.call",
  (r) => append(r, OTHER, 'routerAdd.call(null, "GET", "/z", (e) => e.string(200, "z"));'),
  [/^routerAdd token at pb_hooks\/names\.pb\.js:\d+ /u],
);

console.log("\n── (k) router in comments, and the real onServe, stay GREEN ──");
root = mirror();
append(root, HOST, "// se.router.GET is only mentioned here");
append(root, OTHER, "/* router\n   e.router.GET(...) */");
check(
  "commented router: no offences",
  offenders(root).length === 0,
  JSON.stringify(offenders(root)),
);
fs.rmSync(root, { recursive: true, force: true });
const GUARDS = fs.readFileSync(path.join(REPO_ROOT, "pb_hooks/schema_guards.pb.js"), "utf8");
check("schema_guards.pb.js still uses onServe", /\$app\.onServe\(\)\.bindFunc/u.test(GUARDS));
check(
  "schema_guards.pb.js: no offence",
  !offenders(REPO_ROOT).some((o) => o.includes("schema_guards")),
  JSON.stringify(offenders(REPO_ROOT)),
);

console.log("\n── (l) the v2 fields are validated ──");
expect_red(
  "request not type object",
  (r) => plant_entry(r, PROBE, `{ ${BASE}, request: { type: "array" } }`),
  [MAL("request")],
);
expect_red(
  "responses key not a 3-digit status",
  (r) => plant_entry(r, PROBE, `{ ${BASE}, responses: { "4xx": "Refused." } }`),
  [MAL("responses")],
);
expect_red(
  "responses value not one line",
  (r) => plant_entry(r, PROBE, `{ ${BASE}, responses: { "409": "a\\nb" } }`),
  [MAL("responses")],
);
expect_red(
  "denies other than superuser",
  (r) => plant_entry(r, PROBE, `{ ${BASE}, denies: ["users"] }`),
  [MAL("denies")],
);
expect_red(
  "denies without auth any",
  (r) =>
    plant_entry(
      r,
      PROBE,
      `{ summary: "x", auth: "users", response: { status: 200, schema: null }, denies: ["superuser"] }`,
    ),
  [MAL("denies")],
);
expect_red("docs not route:<slug>", (r) => plant_entry(r, PROBE, `{ ${BASE}, docs: "hook:x" }`), [
  MAL("docs"),
]);
expect_red("field outside the list", (r) => plant_entry(r, PROBE, `{ ${BASE}, bodies: {} }`), [
  /^POST \/api\/probe\/f is malformed: unknown field\(s\) bodies$/u,
]);
root = mirror();
plant_entry(
  root,
  PROBE,
  `{ ${BASE}, request: { type: "object", properties: { name: { type: "string" } } }, responses: { "400": "Bad body.", "404": "Not found." }, denies: ["superuser"], docs: "route:probe-f" }`,
);
check(
  "every v2 field well-formed: no offences",
  offenders(root).length === 0,
  JSON.stringify(offenders(root)),
);
check("every v2 field well-formed: CLI exits 0", cli(root) === 0);
fs.rmSync(root, { recursive: true, force: true });

console.log("\n── (m) query parameters; a response is one line, never an object ──");
expect_red(
  "query value with a type outside string|integer|boolean",
  (r) => plant_entry(r, PROBE, `{ ${BASE}, query: { q: { type: "number", description: "x" } } }`),
  [MAL("query")],
);
expect_red(
  "object-form response { text, schema }",
  (r) =>
    plant_entry(
      r,
      PROBE,
      `{ ${BASE}, responses: { "502": { text: "Upstream failed.", schema: { type: "object" } } } }`,
    ),
  [MAL("responses")],
);
root = mirror();
plant_entry(
  root,
  PROBE,
  `{ ${BASE}, query: { q: { type: "string", description: "Text.", required: true }, n: { type: "integer", description: "Count.", enum: [1, 2] } }, responses: { "400": "Bad." } }`,
);
check(
  "query and one-line response well-formed: no offences",
  offenders(root).length === 0,
  JSON.stringify(offenders(root)),
);
fs.rmSync(root, { recursive: true, force: true });

console.log("\n── (n) string literals are blanked before comments are stripped ──");
const RT = 'se.router.GET("/x", (e) => e.string(200, "x"))';
const lit_line = (label: string, body: string, first_line = 1) => {
  const r = mirror();
  const at = plant_line(r, OTHER, body);
  const got = offenders(r);
  check(
    `${label}: router token at the planted line`,
    got.length === 1 && got[0].startsWith(`router token at ${OTHER}:${at + first_line - 1} `),
    JSON.stringify(got),
  );
  fs.rmSync(r, { recursive: true, force: true });
};
lit_line("/* and */ inside two strings", `const a = "x/*y";\n${RT}\nconst b = "*/5 * * * *";`, 2);
lit_line("// inside a double-quoted string", `const u = "a//b"; ${RT}`);
lit_line("// inside a template literal", `const u = \`a//\${1}b\`; ${RT}`);
lit_line("// inside a single-quoted string", `const u = 'a//b'; ${RT}`);
lit_line("regex holding a double quote", `const re = /"/; ${RT}`);
lit_line("regex holding a single quote", `const re = /'/g; ${RT} 'x'`);
lit_line("regex holding // in a class", `const re = /[//]/; ${RT}`);
lit_line("regex holding /* in a class", `const re = /[/*]/; ${RT}\n/* c */`);
lit_line("regex after return", `return /x"y/.test(s); ${RT}`);
lit_line("nested template in a hole", `const u = \`a\${\`\${1}\`}b\`; ${RT} \`x\``);
lit_line("object literal in a hole", `const u = \`x\${ {a:1}.a }y\`; ${RT} \`x\``);
lit_line("division is not a regex", `const x = a / b / c; ${RT}`);
lit_line("parenthesised division is not a regex", `const y = (a + b) / 2; ${RT}`);
lit_line(
  "division after a postfix increment is not a regex",
  `const r = i++ / 2; ${RT}; const s = j / 3;`,
);
lit_line(
  "division after a keyword-named property is not a regex",
  `const r = box.in / 2; ${RT}; const s = j / 3;`,
);
root = mirror();
append(root, OTHER, `const u = "a"; // it's "quoted\n/* an apostrophe ' in a comment */`);
check(
  "quotes inside comments: no offences",
  offenders(root).length === 0,
  JSON.stringify(offenders(root)),
);
fs.rmSync(root, { recursive: true, force: true });

console.log("\n── (o) middleware goes through the registry's use() ──");
expect_red(
  "routerUse outside the registry",
  (r) => append(r, HOST, "routerUse((e) => e.next());"),
  [/^routerUse token at pb_hooks\/me\.pb\.js:\d+ — register through pb_hooks\/lib\/routes\.js$/u],
);
expect_red(
  "second routerUse in the registry",
  (r) => append(r, REGISTRY, "function extra() { routerUse((e) => e.next()); }"),
  [/^pb_hooks\/lib\/routes\.js has 2 routerUse\( calls \(want 1\)$/u],
);

console.log("\n── (p) a registry key must be a string literal ──");
root = mirror();
const AT2 = plant_line(
  root,
  OTHER,
  `const K = "GET /api/tracker/me"; require(\`\${__hooks}/lib/routes.js\`).add(K, (e) => e.json(200, {}));`,
);
const GOT2 = offenders(root);
check(
  "variable key: refused, naming file:line",
  GOT2.some((g) => g === `${OTHER}:${AT2} add() key must be a string literal`),
  JSON.stringify(GOT2),
);
fs.rmSync(root, { recursive: true, force: true });

console.log("\n── (h) no tracked source was rewritten ──");
check("pb_hooks/ is byte-identical", tree_hash() === BEFORE);

console.log();
if (failures) {
  console.log(`❌ test_route_registry_checker: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ test_route_registry_checker: every check passed");

#!/usr/bin/env bun
/** Unit-pin scripts/check_route_statuses.ts against mirrored pb_hooks/ trees (no server, no DB). */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { offenders } from "../scripts/check_route_statuses.ts";
import { copy_tree } from "../scripts/_scratch_copy.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const CHECKER = path.join(REPO_ROOT, "scripts", "check_route_statuses.ts");
const REGISTRY = "pb_hooks/lib/routes.js";
const HOST = "pb_hooks/me.pb.js";
const ROLLOVER = "POST /api/tracker/cycles/rollover";
const PROBE = "POST /api/probe/s";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbstatuses_"));
  copy_tree(path.join(REPO_ROOT, "pb_hooks"), path.join(root, "pb_hooks"));
  return root;
}

function cli(root: string): number {
  return (
    Bun.spawnSync([process.execPath, CHECKER, "--root", root], { stdout: "pipe", stderr: "pipe" })
      .exitCode ?? -1
  );
}

/** Add a ROUTES entry for PROBE and serve it from HOST with `body` as the handler's statements; returns the body's first line. */
function plant_probe(r: string, entry: string, body: string): number {
  const p = path.join(r, REGISTRY);
  const text = fs.readFileSync(p, "utf8");
  const at = text.indexOf("\n};", text.indexOf("ROUTES"));
  fs.writeFileSync(p, `${text.slice(0, at)}\n  "${PROBE}": { ${entry} },${text.slice(at)}`);
  const host = path.join(r, HOST);
  const first = fs.readFileSync(host, "utf8").split("\n").length + 2;
  fs.appendFileSync(
    host,
    `\nrequire(\`\${__hooks}/lib/routes.js\`).add("${PROBE}", (e) => {\n${body}\n});\n`,
  );
  return first;
}

const BASE = 'summary: "x", auth: "users", response: { status: 200, schema: null }';

/** Mirror, mutate, and expect exactly the offences matching `want`, CLI exit 1 (or 0 when `want` is empty). */
function expect(label: string, mutate: (root: string) => RegExp[]): void {
  const root = mirror();
  try {
    const want = mutate(root);
    const got = offenders(root);
    check(`${label}: ${want.length} offence(s)`, got.length === want.length, JSON.stringify(got));
    for (const w of want)
      check(
        `...one matches ${w}`,
        got.some((g) => w.test(g)),
        JSON.stringify(got),
      );
    check(`${label}: CLI exits ${want.length ? 1 : 0}`, cli(root) === (want.length ? 1 : 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const esc = (s: string) => s.replace(/[/{}.]/gu, "\\$&");
const BEFORE = tree_hash();
console.log("════════ test_route_statuses_checker.ts — check_route_statuses.ts gate pins ════════");

console.log("\n── (a) the live tree is GREEN ──");
check(
  "live tree: no offences",
  offenders(REPO_ROOT).length === 0,
  JSON.stringify(offenders(REPO_ROOT)),
);
check("live tree: CLI exits 0", cli(REPO_ROOT) === 0);

console.log("\n── (b) a NotFoundError planted in a real handler whose entry lacks 404 ──");
expect("planted 404 in rollover", (r) => {
  const p = path.join(r, "pb_hooks/cycles.pb.js");
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const site = lines.findIndex((l) => l.includes(`"${ROLLOVER}"`));
  const open = lines.findIndex((l, i) => i > site && l.trimEnd().endsWith("=> {"));
  lines.splice(open + 1, 0, '    throw new NotFoundError("probe");');
  fs.writeFileSync(p, lines.join("\n"));
  return [
    new RegExp(`^${esc(ROLLOVER)} throws 404 at pb_hooks/cycles\\.pb\\.js:${open + 2} `, "u"),
  ];
});

console.log("\n── (c) a literal ApiError status and a literal e.json error status ──");
expect("planted ApiError(418", (r) => {
  const at = plant_probe(r, BASE, '  throw new ApiError(418, "teapot", null);');
  return [new RegExp(`^${esc(PROBE)} throws 418 at ${esc(HOST)}:${at} `, "u")];
});
expect("planted e.json(503", (r) => {
  const at = plant_probe(r, BASE, '  return e.json(503, { error: "down" });');
  return [new RegExp(`^${esc(PROBE)} throws 503 at ${esc(HOST)}:${at} `, "u")];
});
expect("planted e.string(502", (r) => {
  plant_probe(r, BASE, '  return e.string(502, "down");');
  return [new RegExp(`^${esc(PROBE)} throws 502 `, "u")];
});

console.log("\n── (d) documenting the planted status turns it GREEN ──");
expect("418 and 503 documented", (r) => {
  plant_probe(
    r,
    `${BASE}, responses: { 418: "Teapot.", 503: "Down." }`,
    '  if (e) throw new ApiError(418, "teapot", null);\n  return e.json(503, {});',
  );
  return [];
});
expect("403 covered by denies", (r) => {
  plant_probe(
    r,
    'summary: "x", auth: "any", denies: ["superuser"], response: { status: 200, schema: null }',
    '  throw new ForbiddenError("no");',
  );
  return [];
});
expect("403 without denies or a 403 response", (r) => {
  plant_probe(r, BASE, '  throw new ForbiddenError("no");');
  return [new RegExp(`^${esc(PROBE)} throws 403 `, "u")];
});

console.log("\n── (e) what is not a thrown status ──");
expect("a ValidationError carried inside another error's data", (r) => {
  plant_probe(
    r,
    `${BASE}, responses: { 410: "Gone." }`,
    '  throw new ApiError(410, "gone", { x: new ValidationError("gone", "gone") });',
  );
  return [];
});
expect("a ValidationError thrown on its own", (r) => {
  plant_probe(r, BASE, '  throw new ValidationError("bad", "bad");');
  return [new RegExp(`^${esc(PROBE)} throws 400 `, "u")];
});
expect("a status mentioned only in a comment", (r) => {
  plant_probe(
    r,
    BASE,
    "  // throw new NotFoundError(\n  /* e.json(500, {}) */\n  return e.json(200, {});",
  );
  return [];
});
expect("a throw after a `//` inside a string on the same line", (r) => {
  const at = plant_probe(r, BASE, '  const u = "a//b"; throw new ApiError(418, "x", {});');
  return [new RegExp(`^${esc(PROBE)} throws 418 at ${esc(HOST)}:${at} `, "u")];
});
expect("a throw after a regex literal holding a quote", (r) => {
  const at = plant_probe(r, BASE, '  const re = /"/; throw new ApiError(418, "x", {});');
  return [new RegExp(`^${esc(PROBE)} throws 418 at ${esc(HOST)}:${at} `, "u")];
});
expect("a status inside a string literal", (r) => {
  plant_probe(r, BASE, '  const m = "new NotFoundError( and e.json(500, ...)";');
  return [];
});
expect("a 2xx e.json and a non-literal ApiError status (bounded)", (r) => {
  plant_probe(
    r,
    BASE,
    '  const s = 409;\n  if (e) throw new ApiError(s, "x", null);\n  return e.json(201, {});',
  );
  return [];
});
expect("an internal route is skipped", (r) => {
  plant_probe(r, `${BASE}, internal: true`, '  throw new NotFoundError("x");');
  return [];
});

console.log("\n── (f) no tracked source was rewritten ──");
check("pb_hooks/ is byte-identical", tree_hash() === BEFORE);

console.log();
if (failures) {
  console.log(`❌ test_route_statuses_checker: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ test_route_statuses_checker: every check passed");

#!/usr/bin/env bun
/**
 * Pin scripts/gen_tm_client.ts: the committed client is the render of openapi.json, and a renamed
 * response field both stales `--check` and breaks the tm verbs' typecheck. No server.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate, render, ts_type } from "../scripts/gen_tm_client.ts";
import { read_text } from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(path.dirname(path.resolve(import.meta.path)));
const SRC = path.join(REPO_ROOT, "clients", "tm", "src");
const TSC = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
const SPEC = JSON.parse(read_text(path.join(REPO_ROOT, "openapi.json")));

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`,
  );
}

/** The spec with the search hits' `collection` field renamed to `coll`. */
function renamed(spec: any): any {
  const mut = structuredClone(spec);
  const hit =
    mut.paths["/api/tracker/search"].get.responses["200"].content["application/json"].schema
      .properties.results.items;
  hit.properties.coll = hit.properties.collection;
  delete hit.properties.collection;
  hit.required = hit.required.map((n: string) => (n === "collection" ? "coll" : n));
  return mut;
}

/** tsc on verbs.ts in a scratch copy of api.ts, store.ts and verbs.ts beside the given api.generated.ts. */
function tsc_verbs(dir: string, generated: string): { code: number; out: string } {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["api.ts", "store.ts", "verbs.ts"])
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "api.generated.ts"), generated);
  const p = Bun.spawnSync(
    [
      TSC,
      "--noEmit",
      "--ignoreConfig",
      "--strict",
      "--target",
      "ESNext",
      "--module",
      "Preserve",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ESNext",
      "--allowImportingTsExtensions",
      "--verbatimModuleSyntax",
      "--skipLibCheck",
      "--typeRoots",
      path.join(REPO_ROOT, "node_modules", "@types"),
      "--types",
      "bun",
      path.join(dir, "verbs.ts"),
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "tm-client-gen-test-"));
try {
  console.log("── (a) the committed client is the render of openapi.json ──");
  check(
    "clients/tm/src/api.generated.ts equals generate()",
    read_text(path.join(SRC, "api.generated.ts")) === (await generate()),
  );

  console.log("── (b) renaming a search response field changes the render ──");
  const text = render(SPEC);
  const mut_text = render(renamed(SPEC));
  check(
    "render differs and names coll (so --check would be red)",
    mut_text !== text && /\bcoll\b/u.test(mut_text) && !/\bcoll\b/u.test(text),
  );

  console.log("── (c) the renamed field breaks the verbs' typecheck ──");
  const red = tsc_verbs(path.join(S, "mutated"), mut_text);
  check(
    "tsc --noEmit verbs.ts against the mutated client exits non-zero naming collection",
    red.code !== 0 && red.out.includes("collection"),
    `exit ${red.code}: ${red.out.trim().split("\n").slice(0, 3).join(" | ")}`,
  );

  console.log("── (d) the unmutated client typechecks ──");
  const green = tsc_verbs(path.join(S, "unmutated"), read_text(path.join(SRC, "api.generated.ts")));
  check(
    "tsc --noEmit verbs.ts against the committed client exits 0",
    green.code === 0,
    `exit ${green.code}: ${green.out.trim().split("\n").slice(0, 3).join(" | ")}`,
  );

  console.log("── (e) union and nullable schemas render as unions ──");
  check(
    "type array, anyOf and nullable render string | null, string[] | null, number | boolean",
    ts_type({ type: ["string", "null"] }) === "string | null" &&
      ts_type({ type: ["array", "null"], items: { type: "string" } }) === "string[] | null" &&
      ts_type({ anyOf: [{ type: "integer" }, { type: "boolean" }] }) === "number | boolean" &&
      ts_type({ type: "string", nullable: true }) === "string | null",
    ts_type({ type: ["string", "null"] }),
  );
} finally {
  fs.rmSync(S, { recursive: true, force: true });
}

console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ tm client generator pins hold");
process.exit(failures ? 1 : 0);

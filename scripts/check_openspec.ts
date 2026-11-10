#!/usr/bin/env bun
/** Gate: openspec/ validates strictly, each active change's artifacts follow schema order, and its x-criteria name real readiness criteria. */
import fs from "node:fs";
import path from "node:path";
import { CHANGE_ID } from "./openspec_change.ts";
import { repo_root } from "./_repo_root.ts";

export const OPENSPEC_CLI = path.join(
  path.dirname(import.meta.dir),
  "node_modules/@fission-ai/openspec/bin/openspec.js",
);
export const OPENSPEC_ENV = { OPENSPEC_TELEMETRY: "0", OPENSPEC_NO_UPDATE_CHECK: "1" };
// The CLI's zero-delta refusal; excused only while a change has no specs yet (tests/test_openspec_checker.ts pins it).
export const NO_DELTA = "Change must have at least one delta";
// A criterion is defined where its id opens a line: `**AC-1** ...` or a `| SH-1 |` table row.
const CRITERION_DEF = /^(?:\*\*((?:AC|WEB|MOB|SH)-\d+)\*\*|\|\s*((?:AC|WEB|MOB|SH)-\d+)\s*\|)/gm;

/** (exit, stdout, stderr) of the pinned OpenSpec CLI run in `root`. */
export function openspec(root: string, ...args: string[]): [number, string, string] {
  const r = Bun.spawnSync([process.execPath, OPENSPEC_CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...OPENSPEC_ENV, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return [r.exitCode ?? 1, r.stdout.toString(), r.stderr.toString()];
}

function parse_json(label: string, out: string, err: string, bad: string[]): any {
  try {
    return JSON.parse(out);
  } catch {
    bad.push(`${label}: no JSON from the openspec CLI: ${(err || out).trim().slice(0, 400)}`);
    return null;
  }
}

/** Active change ids: directories under openspec/changes/ other than archive/. */
export function active_changes(root: string): string[] {
  const dir = path.join(root, "openspec/changes");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "archive")
    .map((e) => e.name)
    .sort();
}

export function criterion_ids(root: string): Set<string> {
  const ids = new Set<string>();
  const dir = path.join(root, "docs/readiness");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".md")) continue;
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(CRITERION_DEF))
      ids.add(m[1] ?? m[2]);
  }
  return ids;
}

export function audit(root: string): string[] {
  const bad: string[] = [];
  if (!fs.existsSync(path.join(root, "openspec/config.yaml")))
    return ["openspec/config.yaml: missing (openspec init --tools none)"];
  const changes = active_changes(root);
  const has_specs = new Map<string, boolean>();

  // (b) artifacts present follow the schema's order: in-progress changes may lack LATER artifacts.
  for (const id of changes) {
    if (!CHANGE_ID.test(id))
      bad.push(`change ${id}: not a change id (lowercase letters, digits and hyphens)`);
    const [code, out, err] = openspec(root, "status", "--change", id, "--json");
    const st = code === 0 ? parse_json(`change ${id}`, out, err, bad) : null;
    if (code !== 0)
      bad.push(`change ${id}: openspec status refused it: ${(out + err).trim().slice(0, 400)}`);
    if (!st) continue;
    if (!fs.existsSync(path.join(root, "openspec/schemas", st.schemaName, "schema.yaml")))
      bad.push(
        `change ${id}: schema '${st.schemaName}' is not a project schema in openspec/schemas/`,
      );
    // skip_specs reports specs as "skipped", which satisfies the order like "done".
    const done = new Set(
      st.artifacts.filter((a: any) => ["done", "skipped"].includes(a.status)).map((a: any) => a.id),
    );
    has_specs.set(id, done.has("specs"));
    for (const a of st.artifacts)
      for (const dep of done.has(a.id) ? a.requires : [])
        if (!done.has(dep))
          bad.push(`change ${id}: ${a.outputPath} exists before ${dep}, which it requires`);
  }

  // (a) strict validation; a change with no spec deltas YET is in progress, not invalid.
  const [, out, err] = openspec(
    root,
    "validate",
    "--all",
    "--strict",
    "--json",
    "--no-interactive",
  );
  for (const item of parse_json("openspec validate", out, err, bad)?.items ?? []) {
    if (item.valid) continue;
    const pending = item.type === "change" && has_specs.get(item.id) === false;
    for (const i of item.issues ?? [])
      if (!(pending && i.message.startsWith(NO_DELTA)))
        bad.push(`${item.type} ${item.id}: [${i.level}] ${i.path}: ${i.message}`);
  }

  // (c) every active change names at least one readiness criterion it moves, each defined.
  const ids = criterion_ids(root);
  for (const id of changes) {
    const meta_file = path.join(root, "openspec/changes", id, ".openspec.yaml");
    let crit: unknown;
    try {
      crit = (Bun.YAML.parse(fs.readFileSync(meta_file, "utf8")) as any)?.["x-criteria"];
    } catch (e) {
      bad.push(`change ${id}: .openspec.yaml unreadable: ${(e as Error).message}`);
      continue;
    }
    if (!Array.isArray(crit) || crit.length === 0) {
      bad.push(
        `change ${id}: .openspec.yaml needs x-criteria: a list of readiness criterion ids (docs/readiness/)`,
      );
      continue;
    }
    for (const c of crit)
      if (!ids.has(String(c)))
        bad.push(`change ${id}: x-criteria ${c} is not a criterion in docs/readiness/`);
  }
  return bad;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "usage: check_openspec.ts [--root DIR]\n\nopenspec validate --all --strict; each active change's artifacts follow its schema's order;\nits x-criteria name criteria defined in docs/readiness/.",
    );
    process.exit(0);
  }
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : repo_root(import.meta.path);
  const bad = audit(root);
  if (bad.length) {
    console.log(`❌ check_openspec: ${bad.length} problem(s):\n     • ${bad.join("\n     • ")}`);
    process.exit(1);
  }
  console.log(`✅ check_openspec: ${active_changes(root).length} active change(s) valid`);
}

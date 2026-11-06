#!/usr/bin/env bun
/** Refuses any collection field without help text; system fields and autodate stamps are the
 * server's and are described generically by gen_openapi, every other field needs its own sentence. */
import path from "node:path";
import { repo_root } from "./_repo_root.ts";
import { fetch_collections } from "./gen_schema.ts";

function scan(migrations_dir?: string): { bad: string[]; total: number } {
  const bad: string[] = [];
  let total = 0;
  for (const c of fetch_collections(migrations_dir)) {
    if (c.type === "view") continue;
    for (const f of c.fields ?? []) {
      if (f.system || f.type === "autodate") continue;
      total += 1;
      if (!(f.help ?? "").trim()) bad.push(`${c.name}.${f.name}`);
    }
  }
  return { bad: bad.sort(), total };
}

export function offenders(migrations_dir?: string): string[] {
  return scan(migrations_dir).bad;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "usage: check_field_help.ts [--migrations-dir DIR]\n\nRefuse collection fields that carry no help text.",
    );
    process.exit(0);
  }
  const i = process.argv.indexOf("--migrations-dir");
  const dir =
    i > 0
      ? path.resolve(process.argv[i + 1])
      : path.join(repo_root(import.meta.path), "pb_migrations");
  const { bad, total } = scan(dir);
  for (const b of bad) console.log(`❌ check_field_help: ${b} has no help text`);
  if (bad.length) process.exit(1);
  console.log(`✅ check_field_help: every field carries help text (${total} fields)`);
}

#!/usr/bin/env bun
/** Refuses any pb_hooks/ file that names both the superuser collection and MFA: superuser
 * second-factor settings belong in a migration, never in a hook an env var could switch. */
import fs from "node:fs";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";

const SUPERUSERS = /_superusers/u;
const MFA = /(?<![\p{L}\p{N}_])mfa(?![\p{L}\p{N}_])/iu;

export function offenders(hooksDir: string): string[] {
  return fs
    .readdirSync(hooksDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".js"))
    .filter((rel) => {
      const text = fs.readFileSync(path.join(hooksDir, rel), "utf8");
      return SUPERUSERS.test(text) && MFA.test(text);
    })
    .sort();
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "usage: check_hooks_no_mfa.ts [--root DIR]\n\nRefuse pb_hooks/ files that touch superuser MFA.",
    );
    process.exit(0);
  }
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : repo_root(import.meta.path);
  const bad = offenders(path.join(root, "pb_hooks"));
  if (bad.length) {
    console.log(`❌ check_hooks_no_mfa: superuser MFA is touched in pb_hooks/: ${bad.join(", ")}`);
    process.exit(1);
  }
  console.log("✅ check_hooks_no_mfa: no pb_hooks/ file touches superuser MFA");
}

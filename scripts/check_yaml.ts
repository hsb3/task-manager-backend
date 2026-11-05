#!/usr/bin/env bun
/** Gate: every GitHub workflow and the Dependabot config parse as YAML. */
import fs from "node:fs";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(
    "usage: check_yaml.ts [--root DIR]\n\nParse .github/workflows/*.yml and .github/dependabot.yml.",
  );
  process.exit(0);
}
const i = process.argv.indexOf("--root");
const root = i > 0 ? path.resolve(process.argv[i + 1]) : repo_root(import.meta.path);
const wf = path.join(root, ".github/workflows");
const files = [
  ...(fs.existsSync(wf)
    ? fs
        .readdirSync(wf)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => `.github/workflows/${f}`)
    : []),
  ...(fs.existsSync(path.join(root, ".github/dependabot.yml")) ? [".github/dependabot.yml"] : []),
].sort();
const bad: string[] = [];
if (files.length === 0) bad.push(".github: no workflow or dependabot file found");
for (const rel of files) {
  try {
    Bun.YAML.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  } catch (e) {
    bad.push(`${rel}: ${(e as Error).message}`);
  }
}
if (bad.length) {
  console.log(`❌ check_yaml: ${bad.length} problem(s):\n     • ${bad.join("\n     • ")}`);
  process.exit(1);
}
console.log(`✅ check_yaml: ${files.length} file(s) parse`);

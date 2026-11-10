#!/usr/bin/env bun
/** Print the directory of an OpenSpec change id, active or archived (date prefix stripped); exit 1 when unknown. */
import fs from "node:fs";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";

export const CHANGE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Repo-relative directories holding change `id`: the active one, then any archived ones. */
export function change_dirs(root: string, id: string): string[] {
  if (!CHANGE_ID.test(id) || id === "archive") return [];
  const active = path.join("openspec/changes", id);
  const archive = path.join(root, "openspec/changes/archive");
  return [
    ...(fs.existsSync(path.join(root, active, ".openspec.yaml")) ? [active] : []),
    ...(fs.existsSync(archive) ? fs.readdirSync(archive) : [])
      .filter((d) => d.replace(/^\d{4}-\d{2}-\d{2}-/, "") === id && /^\d{4}-\d{2}-\d{2}-/.test(d))
      .sort()
      .map((d) => path.join("openspec/changes/archive", d)),
  ];
}

if (import.meta.main) {
  const id = process.argv[2];
  if (!id || id === "-h" || id === "--help") {
    console.log(
      "usage: openspec_change.ts <change-id>\n\nPrint the change's directory, active or archived; exit 1 when unknown.",
    );
    process.exit(id ? 0 : 2);
  }
  const dirs = change_dirs(repo_root(import.meta.path), id);
  if (!dirs.length) {
    console.error(`no OpenSpec change '${id}', active or archived (openspec/changes/)`);
    process.exit(1);
  }
  console.log(dirs.join("\n"));
}

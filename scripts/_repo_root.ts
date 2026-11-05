// The checkout a gate script audits: the cwd's git work tree, not the script's own location.

import path from "node:path";
import { py_strip } from "./_py.ts";

/**
 * Toplevel of the git work tree containing the CURRENT WORKING DIRECTORY.
 *
 * A checker invoked by absolute path from another checkout must audit THAT checkout, or it
 * reports green about a tree the caller never named. `script_file` (pass `import.meta.path`) is
 * the fallback for a cwd outside any work tree, or a machine with no usable git.
 */
export function repo_root(script_file: string): string {
  let proc: { exitCode: number | null; stdout: string } | null;
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = { exitCode: r.exitCode, stdout: r.stdout.toString() };
  } catch {
    proc = null;
  }
  if (proc !== null && proc.exitCode === 0 && py_strip(proc.stdout)) {
    return py_strip(proc.stdout);
  }
  return path.dirname(path.dirname(path.resolve(script_file)));
}

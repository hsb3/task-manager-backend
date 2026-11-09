// The one recursive scratch copy: it refuses a symlink anywhere in the source, so a copy never aliases the real tree.

import fs from "node:fs";
import path from "node:path";

/** Relative path of the first symlink under `dir` (depth-first, name order), else null. */
function first_symlink(dir: string, rel: string = ""): string | null {
  for (const ent of fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = path.join(rel, ent.name);
    if (ent.isSymbolicLink()) return r;
    if (ent.isDirectory()) {
      const found = first_symlink(dir, r);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Copy `src` to `dest` recursively and return `dest`; throws, copying nothing, on a symlink at or under `src`. */
export function copy_tree(src: string, dest: string): string {
  const st = fs.lstatSync(src);
  const link = st.isSymbolicLink() ? "." : st.isDirectory() ? first_symlink(src) : null;
  if (link !== null) {
    throw new Error(
      `${link === "." ? src : `${src} entry ${link}`} is a symlink — a scratch copy must not alias the real tree`,
    );
  }
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

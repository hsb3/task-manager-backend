// Suite helpers shared verbatim across tests/test_*.ts.
// Bound: only helpers closing over nothing in the suite file; one reading its PORT, BASE_URL, failures or api() stays local.

import fs from "node:fs";
import { py_strip, read_text } from "../scripts/_py.ts";
import * as roomkit from "./roomkit.ts";

export function esc(value: string): string {
  // PocketBase filter string literals escape an embedded quote with a backslash.
  return value.replaceAll("'", "\\'");
}

export function load_env(path = ".env"): void {
  if (fs.existsSync(path)) {
    for (let line of read_text(path).split(/\r\n|\r|\n/)) {
      line = py_strip(line);
      if (line && !line.startsWith("#") && line.includes("=")) {
        const i = line.indexOf("=");
        const k = line.slice(0, i);
        const v = line.slice(i + 1);
        if (!(k in process.env)) process.env[k] = v;
      }
    }
  }
}

export async function stop_server(proc: roomkit.Room | null): Promise<void> {
  if (proc === null) return;
  await roomkit.stop(proc);
}

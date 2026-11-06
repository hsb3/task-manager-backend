#!/usr/bin/env bun
/** Refuses a model-tier update guard (`onRecordUpdate`/`onRecordUpdateExecute`) whose handler
 * throws without reading `.original()` — the touches predicate memory
 * universal-guard-needs-touches-predicate demands. Bound: textual presence of `.original()` in the
 * handler body, not dataflow; only pb_hooks/*.pb.js registrations whose handler is inline or a
 * function declared in the same file (an undeclared name fails closed); a registration made via a
 * variable verb or a helper is not seen. */
import fs from "node:fs";
import path from "node:path";
import { repo_root } from "./_repo_root.ts";

/** -> src with every comment and string body blanked to spaces (newlines kept, offsets intact). */
export function mask(src: string): string {
  const out = src.split("");
  let inStr: string | null = null,
    inLine = false,
    inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i],
      n = src[i + 1];
    const blank = (j: number) => {
      if (out[j] !== "\n") out[j] = " ";
    };
    if (inLine) {
      if (c === "\n") inLine = false;
      else blank(i);
    } else if (inBlock) {
      blank(i);
      if (c === "*" && n === "/") {
        inBlock = false;
        blank(++i);
      }
    } else if (inStr) {
      if (c === "\\") {
        blank(i);
        blank(++i);
      } else if (c === inStr) inStr = null;
      else blank(i);
    } else if (c === "/" && n === "/") {
      inLine = true;
      blank(i);
    } else if (c === "/" && n === "*") {
      inBlock = true;
      blank(i);
      blank(++i);
    } else if (c === '"' || c === "'" || c === "`") inStr = c;
  }
  return out.join("");
}

/** -> index of the bracket closing the one at `open`, in already-masked text. */
function close_of(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") if (--depth === 0) return i;
  }
  return -1;
}

export type Guard = { file: string; line: number; verb: string; tags: string; handler: string };

/** -> [throwing model-tier update guards, those of them that never read .original()]. */
export function scan(hooksDir: string): { guards: Guard[]; offenders: Guard[] } {
  const guards: Guard[] = [];
  const offenders: Guard[] = [];
  for (const f of fs
    .readdirSync(hooksDir)
    .filter((x) => x.endsWith(".pb.js"))
    .sort()) {
    const src = fs.readFileSync(path.join(hooksDir, f), "utf8");
    const masked = mask(src);
    const re = /(?<![\w$])(onRecordUpdate(?:Execute)?)\(/g;
    for (const m of masked.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = close_of(masked, open);
      const cuts = [open];
      for (let d = 0, j = open + 1; j < close; j++) {
        const c = masked[j];
        if ("({[".includes(c!)) d++;
        else if (")}]".includes(c!)) d--;
        else if (c === "," && d === 0) cuts.push(j);
      }
      cuts.push(close);
      const tags = cuts
        .slice(1, -1)
        .map((at, k) =>
          src
            .slice(at + 1, cuts[k + 2])
            .trim()
            .replace(/^["'`]|["'`]$/g, ""),
        )
        .join(",");
      const named = masked.slice(open + 1, close).match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      let body: string | null = masked.slice(open + 1, cuts[1]);
      let handler = "inline";
      if (named) {
        handler = named[1]!;
        const decl = new RegExp(`(?<![\\w$])function\\s+${handler.replace(/\$/g, "\\$")}\\s*\\(`);
        const fm = decl.exec(masked);
        const bo = fm ? masked.indexOf("{", fm.index + fm[0].length) : -1;
        body = bo < 0 ? null : masked.slice(bo, close_of(masked, bo) + 1);
      }
      const g: Guard = {
        file: f,
        line: src.slice(0, m.index).split("\n").length,
        verb: m[1]!,
        tags: tags || "(every collection)",
        handler: body === null ? `${handler} (unresolved)` : handler,
      };
      if (body === null) {
        offenders.push(g);
        continue;
      }
      if (!/(?<![\w$])throw(?![\w$])/.test(body)) continue;
      guards.push(g);
      if (!/\.original\(\)/.test(body)) offenders.push(g);
    }
  }
  return { guards, offenders };
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "usage: check_universal_touches.ts [--root DIR]\n\n" +
        "Refuse a model-tier onRecordUpdate/onRecordUpdateExecute handler in pb_hooks/ that\n" +
        "throws without reading e.record.original() (a touches predicate).",
    );
    process.exit(0);
  }
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? path.resolve(process.argv[i + 1]!) : repo_root(import.meta.path);
  const { guards, offenders } = scan(path.join(root, "pb_hooks"));
  if (offenders.length) {
    console.log(
      `❌ check_universal_touches: ${offenders.length} model-tier update guard(s) throw without ` +
        "reading original() — guard only a save that changes the fields it checks " +
        "(.agents/memory/universal-guard-needs-touches-predicate.md):",
    );
    for (const o of offenders) {
      console.log(`  pb_hooks/${o.file}:${o.line}  ${o.verb}  ${o.tags}  ${o.handler}`);
    }
    process.exit(1);
  }
  console.log(
    `✅ check_universal_touches: ${guards.length} model-tier update guard(s) that throw all read original()`,
  );
}

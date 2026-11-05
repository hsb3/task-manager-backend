#!/usr/bin/env bun
/**
 * CI / battery check: the local-dev MFA-off hook must never reach the prod image.
 *
 * `make compose-dev` weakens superuser auth by bind-mounting deploy/local/mfa-off.pb.js
 * into the container's hooks dir. That is safe only while the file lives OUTSIDE every path the
 * prod Dockerfile copies — then no env var, variable or misconfiguration can switch it on in a
 * deploy. This reconciles that claim against the real artifacts: the Dockerfile's COPY sources,
 * the on-disk pb_hooks/ contents, and the overlay's mount target.
 *
 * Usage: bun scripts/check_local_mode_isolation.ts
 */

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  print,
  py_join,
  py_lstrip,
  py_rstrip,
  py_split,
  py_strip,
  PY_WS,
  read_text,
  shlex_split,
  splitlines,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";

export const REPO = repo_root(import.meta.path);
export const DOCKERFILE = "Dockerfile";
export const OVERLAY = "deploy/local/docker-compose.local.yml";
export const LOCAL_MODE_DIR = "deploy/local";
export const LOCAL_MODE_HOOK = `${LOCAL_MODE_DIR}/mfa-off.pb.js`;
export const HOOKS_DIR = "pb_hooks";

// A hook that names the superuser collection and MFA in the same file is turning the second
// factor on or off; either way it belongs in a migration or in local mode, never in pb_hooks/.
export const SUPERUSERS = /_superusers/u;
export const MFA = /(?<![\p{L}\p{N}_])mfa(?![\p{L}\p{N}_])/iu;

const S = `[${PY_WS}]`;
const COPY_OR_ADD = new RegExp(`^(?:COPY|ADD)${S}`, "iu");

/** Build-context sources of every COPY/ADD in the Dockerfile (last token is the target). */
export function copy_sources(dockerfile_text: string): string[] {
  const sources: string[] = [];
  // Join backslash continuations so a wrapped COPY is read as one instruction.
  const text = dockerfile_text.replaceAll("\\\n", " ");
  for (let line of splitlines(text)) {
    line = py_strip(line);
    if (!COPY_OR_ADD.test(line)) continue;
    let parts: string[];
    try {
      parts = shlex_split(line)
        .slice(1)
        .filter((p) => !p.startsWith("--"));
    } catch {
      parts = py_split(line).slice(1);
    }
    if (parts.length >= 2) sources.push(...parts.slice(0, -1));
  }
  return sources;
}

/** True when a COPY source would carry `path` into the image. */
export function covers(source: string, path: string): boolean {
  const src = py_rstrip(py_lstrip(source, "./"), "/");
  if (src === "" || src === ".") return true; // `COPY . /app` copies the whole context, local-mode included
  return path === src || path.startsWith(src + "/");
}

export function main(): number {
  const prog = path.basename(process.argv[1] ?? "");
  const usage = `usage: ${prog} [-h]`;
  parse_args(
    usage,
    `${usage}

Check that the local-dev MFA-off hook cannot reach the prod image.

options:
  -h, --help  show this help message and exit
`,
    [],
    {},
  );

  const errors: string[] = [];

  const hook = py_join(REPO, LOCAL_MODE_HOOK);
  if (!fs.existsSync(hook)) {
    print(
      `❌ check_local_mode_isolation: ${LOCAL_MODE_HOOK} not found — this checker's ` +
        "subject moved; update the path here and in deploy/local/docker-compose.local.yml.",
    );
    return 1;
  }

  const dockerfile = read_text(py_join(REPO, DOCKERFILE));
  const sources = copy_sources(dockerfile);
  for (const source of sources) {
    if (covers(source, LOCAL_MODE_HOOK)) {
      errors.push(
        `${DOCKERFILE}: \`COPY ${source}\` carries ${LOCAL_MODE_HOOK} into the prod image — ` +
          "the MFA-off hook must exist in no image; keep it outside every copied path.",
      );
    }
  }

  const hooks_path = py_join(REPO, HOOKS_DIR);
  for (const name of fs.readdirSync(hooks_path).sort(by_code_point)) {
    if (!name.endsWith(".js")) continue;
    const text = read_text(py_join(hooks_path, name));
    if (SUPERUSERS.test(text) && MFA.test(text)) {
      errors.push(
        `${HOOKS_DIR}/${name}: touches _superusers MFA, and ${HOOKS_DIR}/ ships in the ` +
          "prod image — superuser MFA is settled by pb_migrations/, weakened only by " +
          `the local-only ${LOCAL_MODE_HOOK}.`,
      );
    }
  }

  const overlay = read_text(py_join(REPO, OVERLAY));
  if (!overlay.includes(LOCAL_MODE_HOOK)) {
    errors.push(
      `${OVERLAY}: no mount of ${LOCAL_MODE_HOOK} — \`make compose-dev\` would boot with ` +
        "MFA on and seeding would fail; fix the mount path.",
    );
  }

  if (errors.length) {
    print("❌ check_local_mode_isolation: local-dev mode is not isolated from the prod image:");
    for (const e of errors) print(`     • ${e}`);
    return 1;
  }

  print(
    `✅ check_local_mode_isolation: ${LOCAL_MODE_HOOK} is outside all ` +
      `${sources.length} ${DOCKERFILE} COPY/ADD source(s), no ${HOOKS_DIR}/ hook touches ` +
      `_superusers MFA, and ${OVERLAY} mounts it.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

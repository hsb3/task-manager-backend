#!/usr/bin/env bun
// Unit-pin gen_app_docs_seed.ts's digest: a one-byte prose edit to the seed is refused, a comment edit is not (no server, no port).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr } from "../scripts/_py.ts";
import { DEFAULT_OUTPUT, DIGEST, digest_drift, digest_line } from "../scripts/gen_app_docs_seed.ts";

const GEN = path.join(path.dirname(import.meta.dir), "scripts", "gen_app_docs_seed.ts");
let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${py_repr(got)}`);
    console.log(`        want: ${py_repr(want)}`);
  }
}

console.log("════════ test_app_docs_seed_digest.ts — seed prose vs its committed digest ════════");

const seed = fs.readFileSync(DEFAULT_OUTPUT, "utf-8");
const committed = fs.readFileSync(DIGEST, "utf-8");
check("the committed seed matches the committed digest", digest_drift(seed, committed), null);
check("a fresh digest line equals the committed one", digest_line(seed), committed);

const at = seed.indexOf('"body": "') + 20;
const one_byte = seed.slice(0, at) + (seed[at] === "X" ? "Y" : "X") + seed.slice(at + 1);
check(
  "the mutation changed exactly one byte",
  one_byte.length === seed.length && one_byte !== seed,
  true,
);
check(
  "a one-byte edit to a seeded body sentence is refused",
  typeof digest_drift(one_byte, committed),
  "string",
);
check(
  "...and the refusal names the regeneration command",
  digest_drift(one_byte, committed)?.includes("bun scripts/gen_app_docs_seed.ts"),
  true,
);
check(
  "a comment-only edit (the historical-migration comment path) is not refused",
  digest_drift(seed.replace("// Seed app_settings", "// Seeds app_settings"), committed),
  null,
);
check(
  "a digest naming another seed file is refused (a re-seed must regenerate)",
  typeof digest_drift(seed, committed.replace(/\S+\n$/, "v2:another_seed.js\n")),
  "string",
);
check(
  "a digest holding conflict markers is refused",
  typeof digest_drift(seed, `<<<<<<< ours\n${committed}=======\n>>>>>>> theirs\n`),
  "string",
);

// End to end: the generator's own --check (the check-static gate) refuses the one-byte edit.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pb-seed-digest-"));
try {
  const gate = (text: string): [number, string] => {
    const copy = path.join(scratch, path.basename(DEFAULT_OUTPUT));
    fs.writeFileSync(copy, text);
    const proc = Bun.spawnSync([process.execPath, GEN, "--check", "-o", copy]);
    return [proc.exitCode ?? 1, proc.stdout.toString() + proc.stderr.toString()];
  };
  let [rc, out] = gate(seed);
  check("gen_app_docs_seed --check passes the committed seed", rc, 0);
  [rc, out] = gate(one_byte);
  check("gen_app_docs_seed --check exits 1 on the one-byte edit", rc, 1);
  check("...naming the digest", out.includes("app_docs_seed.sha256"), true);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

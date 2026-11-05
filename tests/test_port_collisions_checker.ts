#!/usr/bin/env bun
/**
 * Proof of scripts/check_port_collisions.ts's duplicate-default and ports.md-contract rules.
 *
 * Fixture repos under /tmp/h-repo-portfix/ exercise --repo/--ports-doc: two suites declaring the
 * same literal port is RED naming both file:line, ports.md naming a port its suite never
 * declares is RED, the reviewed smtp_sink.ts/test_hardening.ts SINK_PORT pair is GREEN despite
 * sharing 2527, a third file joining that pair is still RED, a port bound inline collides like a
 * constant, a port only mentioned in prose does not satisfy ports.md, and distinct ports are GREEN.
 * §7 covers what a line regex cannot see: an expression split across lines, an offset held under
 * another name, a shifted literal that lives only inside a string (a mention, not a bind), a
 * web/e2e TypeScript bind, and a leading comment naming a port its own file never declares. §6
 * runs the real checker against the shipped tree.
 *
 * No server, no ports bound. A demonstrated RED carries the checker's refusal glyph, and the
 * battery reads a stray one as this suite failing — so every echoed line is quoted with that
 * glyph spelled out instead.
 */

import fs from "node:fs";
import path from "node:path";
import { py_strip, splitlines } from "../scripts/_py.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const CHECKER = path.join(REPO_ROOT, "scripts", "check_port_collisions.ts");
const SCRATCH = "/tmp/h-repo-portfix";
const REFUSAL = "❌";

const FAILS: string[] = [];

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✅" : REFUSAL}  ${label}`);
  if (!ok) FAILS.push(label);
}

function echo(out: string): void {
  for (const line of splitlines(py_strip(out))) {
    console.log(`    | ${line.replaceAll(REFUSAL, "[refusal glyph]")}`);
  }
}

type Result = { returncode: number; stdout: string };

function run_checker(args: string[], cwd?: string): Result {
  const proc = Bun.spawnSync([process.execPath, CHECKER, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return { returncode: proc.exitCode ?? -1, stdout: proc.stdout.toString() };
}

function run(repo_dir: string, ports_doc: string): Result {
  return run_checker(["--repo", repo_dir, "--ports-doc", ports_doc]);
}

/** A scratch tree with the given tests/scripts files and a ports.md. */
function make_repo(
  name: string,
  files: Record<string, string>,
  ports_doc_body: string,
): [string, string] {
  const repo_dir = path.join(SCRATCH, name);
  fs.rmSync(repo_dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(repo_dir, "tests"), { recursive: true });
  fs.mkdirSync(path.join(repo_dir, "scripts"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(repo_dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf-8");
  }
  const ports_doc = path.join(repo_dir, "ports.md");
  fs.writeFileSync(ports_doc, ports_doc_body, "utf-8");
  return [repo_dir, ports_doc];
}

const OFFSET_LINE = 'const PORT_OFFSET = Number(process.env.PB_PORT_OFFSET ?? "0");\n';

function suite(port: number, name: string = "PORT"): string {
  return `import path from "node:path";\n${OFFSET_LINE}const ${name} = ${port} + PORT_OFFSET;\n`;
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

console.log("── 1. two suites declaring the same literal port → RED, naming both file:line ──");
const [repo1, doc1] = make_repo(
  "same-port",
  { "tests/test_a.ts": suite(9000), "tests/test_b.ts": suite(9000) },
  "",
);
const r1 = run(repo1, doc1);
echo(r1.stdout);
check("exit code is 1", r1.returncode === 1);
check("names tests/test_a.ts:3", r1.stdout.includes("tests/test_a.ts:3"));
check("names tests/test_b.ts:3", r1.stdout.includes("tests/test_b.ts:3"));
check("the refusal carries the refusal glyph", r1.stdout.includes(REFUSAL));

console.log("── 2. ports.md names a port its suite never declares → RED ──");
const [repo2, doc2] = make_repo(
  "doc-lies",
  { "tests/test_c.ts": suite(9001) },
  "prose prose 9002 = test_c more prose\n",
);
const r2 = run(repo2, doc2);
echo(r2.stdout);
check("exit code is 1", r2.returncode === 1);
check("names the false claim", r2.stdout.includes("names port 9002 for test_c"));

console.log("── 3. distinct ports, ports.md correct → GREEN ──");
const [repo3, doc3] = make_repo(
  "distinct",
  { "tests/test_d.ts": suite(9003), "tests/test_e.ts": suite(9004) },
  "9003 = test_d and 9004 = test_e are both self-boot ports\n",
);
const r3 = run(repo3, doc3);
echo(r3.stdout);
check("exit code is 0", r3.returncode === 0);
check("carries the pass glyph", r3.stdout.includes("✅"));
check("no refusal glyph on a clean run", !r3.stdout.includes(REFUSAL));

console.log("── 4. the reviewed smtp_sink.ts/test_hardening.ts SINK_PORT pair is GREEN at 2527 ──");
const [repo4, doc4] = make_repo(
  "exempt-pair",
  {
    "scripts/smtp_sink.ts": suite(2527, "SINK_PORT"),
    "tests/test_hardening.ts": suite(2527, "SINK_PORT"),
  },
  "",
);
const r4 = run(repo4, doc4);
echo(r4.stdout);
check("exit code is 0 despite the shared literal", r4.returncode === 0);
check("no refusal glyph", !r4.stdout.includes(REFUSAL));

console.log("── 5. a THIRD file joining the exempt pair at 2527 is still RED ──");
const [repo5, doc5] = make_repo(
  "exempt-pair-plus-one",
  {
    "scripts/smtp_sink.ts": suite(2527, "SINK_PORT"),
    "tests/test_hardening.ts": suite(2527, "SINK_PORT"),
    "tests/test_f.ts": suite(2527, "SINK_PORT"),
  },
  "",
);
const r5 = run(repo5, doc5);
echo(r5.stdout);
check("exit code is 1 — the exemption covers exactly the reviewed pair", r5.returncode === 1);
check(
  "names all three sites",
  r5.stdout.includes("tests/test_f.ts") && r5.stdout.includes("smtp_sink.ts"),
);

console.log("── 5b. a port bound inline (new Room(...)) collides like a module constant → RED ──");
const [repo5b, doc5b] = make_repo(
  "inline",
  {
    "tests/test_g.ts": suite(9010),
    "tests/test_h.ts": `import path from "node:path";\n${OFFSET_LINE}new Room(9010 + PORT_OFFSET);\n`,
  },
  "",
);
const r5b = run(repo5b, doc5b);
echo(r5b.stdout);
check("exit code is 1", r5b.returncode === 1);
check("names the inline site", r5b.stdout.includes("tests/test_h.ts:3"));

console.log("── 5c. ports.md's port only in the suite's prose, not bound → RED ──");
const [repo5c, doc5c] = make_repo(
  "prose-only",
  { "tests/test_i.ts": "/** Boots on 9020. */\n" + suite(9021) },
  "9020 = test_i\n",
);
const r5c = run(repo5c, doc5c);
echo(r5c.stdout);
check("exit code is 1", r5c.returncode === 1);
check("names the false claim", r5c.stdout.includes("names port 9020 for test_i"));

console.log("── 7a. an expression split across lines is still one declaration → RED ──");
const [repo7a, doc7a] = make_repo(
  "split-lines",
  {
    "tests/test_j.ts": `import path from "node:path";\n${OFFSET_LINE}const PORT = (\n  9030\n  + PORT_OFFSET\n);\n`,
    "tests/test_k.ts": suite(9030),
  },
  "",
);
const r7a = run(repo7a, doc7a);
echo(r7a.stdout);
check("exit code is 1", r7a.returncode === 1);
check("names the split expression at its literal", r7a.stdout.includes("tests/test_j.ts:4"));

console.log("── 7b. an offset held under another name is still the offset → RED ──");
const [repo7b, doc7b] = make_repo(
  "renamed-offset",
  {
    "tests/test_l.ts":
      'import path from "node:path";\nconst port_offset = Number(process.env["PB_PORT_OFFSET"]);\n' +
      "const PORT = 9031 + port_offset;\n",
    "tests/test_m.ts": suite(9031),
  },
  "",
);
const r7b = run(repo7b, doc7b);
echo(r7b.stdout);
check("exit code is 1", r7b.returncode === 1);
check("names the lower-cased offset site", r7b.stdout.includes("tests/test_l.ts:3"));

console.log(
  "── 7c. a shifted literal that lives only inside a string is a mention, not a bind → GREEN ──",
);
const [repo7c, doc7c] = make_repo(
  "string-mention",
  {
    "tests/test_n.ts": suite(9032),
    "tests/test_o.ts":
      `import path from "node:path";\n${OFFSET_LINE}` +
      'const NOTE = "the neighbour boots on 9032 + PORT_OFFSET";\n',
  },
  "",
);
const r7c = run(repo7c, doc7c);
echo(r7c.stdout);
check("exit code is 0 — prose cannot collide with a bind", r7c.returncode === 0);
check("no refusal glyph", !r7c.stdout.includes(REFUSAL));

for (const sibling_path of [
  "web-carbon/e2e/support/room.ts",
  "web-carbon/e2e/support/room.mjs",
  "web-carbon/playwright.config.ts",
]) {
  const [repo, doc] = make_repo(
    "carbon-collision",
    {
      "tests/test_carbon_peer.ts": suite(9098),
      [sibling_path]: "const port = 9098 + PB_PORT_OFFSET;\n",
    },
    "",
  );
  const result = run(repo, doc);
  check(
    `Carbon collision refused at ${sibling_path}`,
    result.returncode === 1 && result.stdout.includes(`${sibling_path}:1`),
  );
}

console.log("── 7d. a web/e2e TypeScript bind collides with a TypeScript suite → RED ──");
const [repo7d, doc7d] = make_repo(
  "web-e2e",
  {
    "tests/test_p.ts": suite(9033),
    "web/e2e/support/room.test.ts":
      "import { PB_PORT_OFFSET } from './ports';\n" + "const ROOM_PORT = 9033 + PB_PORT_OFFSET;\n",
  },
  "",
);
const r7d = run(repo7d, doc7d);
echo(r7d.stdout);
check("exit code is 1", r7d.returncode === 1);
check("names the TypeScript site", r7d.stdout.includes("web/e2e/support/room.test.ts:2"));

console.log(
  "── 7e. a leading comment naming a port the file never binds → RED; naming the one it binds → GREEN ──",
);
const [repo7e, doc7e] = make_repo(
  "docstring-claim",
  { "tests/test_q.ts": "/** Boots on 9034 + PB_PORT_OFFSET. */\n" + suite(9035) },
  "",
);
const r7e = run(repo7e, doc7e);
echo(r7e.stdout);
check("exit code is 1", r7e.returncode === 1);
check("names the contradicted claim", r7e.stdout.includes("docstring names port 9034"));
const [repo7f, doc7f] = make_repo(
  "docstring-claim-true",
  { "tests/test_r.ts": "/** Boots on 9035 + PB_PORT_OFFSET. */\n" + suite(9035) },
  "",
);
const r7f = run(repo7f, doc7f);
echo(r7f.stdout);
check("a docstring that agrees with the bind is GREEN", r7f.returncode === 0);

console.log("── 7g. --print-globs is the gate runners' trigger derivation ──");
const r7g = run_checker(["--print-globs"]);
echo(r7g.stdout);
check("exit code is 0", r7g.returncode === 0);
check("lists the TypeScript family", r7g.stdout.includes("web/e2e/**/*.ts"));
check(
  "lists the suite and script families",
  r7g.stdout.includes("tests/*.ts") && r7g.stdout.includes("scripts/*.ts"),
);

console.log("── 7h. a `//` inside a STRING does not blank a real bind later on the same line ──");
// A URL literal carries `//`. A comment scanner that is not quote-aware treats it as the start
// of a comment and blanks the rest of the line, losing the bind that follows it.
const [repo7h, doc7h] = make_repo(
  "url-then-bind",
  {
    "tests/test_r.ts": suite(9036),
    "web/e2e/support/url.test.ts":
      'const u = "http://x.test";\n' + "const ROOM = 9036 + PB_PORT_OFFSET;\n",
  },
  "",
);
const r7h = run(repo7h, doc7h);
echo(r7h.stdout);
check("exit code is 1", r7h.returncode === 1);
check(
  "the bind after the url string is seen",
  r7h.stdout.includes("web/e2e/support/url.test.ts:2"),
);

console.log("── 6. the shipped tree passes with no arguments ──");
const r6 = run_checker([], REPO_ROOT);
echo(r6.stdout);
check("exit code is 0", r6.returncode === 0);
check("carries the pass glyph", r6.stdout.includes("✅"));

fs.rmSync(SCRATCH, { recursive: true, force: true });

console.log();
if (FAILS.length) {
  console.log(`${REFUSAL} ${FAILS.length} FAILED: ${JSON.stringify(FAILS)}`);
  process.exit(1);
}
console.log("✅ all check_port_collisions proofs passed");

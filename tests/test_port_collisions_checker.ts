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
 * scripts/ bind colliding with a suite, and a leading comment naming a port its own file never declares. §6
 * runs the real checker against the shipped tree.
 *
 * No server; §8c binds one ephemeral listener to prove the live-port refusal. A demonstrated RED carries the checker's refusal glyph, and the
 * battery reads a stray one as this suite failing — so every echoed line is quoted with that
 * glyph spelled out instead.
 */

import fs from "node:fs";
import { once } from "node:events";
import net from "node:net";
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

type Result = { returncode: number; stdout: string; stderr: string };

function run_checker(args: string[], cwd?: string, offset?: string): Result {
  const env = { ...process.env };
  delete env.PB_PORT_OFFSET; // ambient offset must not leak into a case that names none
  if (offset !== undefined) env.PB_PORT_OFFSET = offset;
  const proc = Bun.spawnSync([process.execPath, CHECKER, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    returncode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
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

console.log("── 7d. a scripts/ bind collides with a tests/ suite → RED ──");
const [repo7d, doc7d] = make_repo(
  "script-bind",
  {
    "tests/test_p.ts": suite(9033),
    "scripts/room_peer.ts":
      "import { PB_PORT_OFFSET } from './ports';\n" + "const ROOM_PORT = 9033 + PB_PORT_OFFSET;\n",
  },
  "",
);
const r7d = run(repo7d, doc7d);
echo(r7d.stdout);
check("exit code is 1", r7d.returncode === 1);
check("names the script site", r7d.stdout.includes("scripts/room_peer.ts:2"));

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
check("lists no frontend family", !r7g.stdout.includes("web"));
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
    "scripts/url_peer.ts": 'const u = "http://x.test";\n' + "const ROOM = 9036 + PB_PORT_OFFSET;\n",
  },
  "",
);
const r7h = run(repo7h, doc7h);
echo(r7h.stdout);
check("exit code is 1", r7h.returncode === 1);
check("the bind after the url string is seen", r7h.stdout.includes("scripts/url_peer.ts:2"));

console.log("── 8. an offset that lands a default on a local service port → RED; others silent ──");
const [repo8, doc8] = make_repo(
  "service-port",
  { "tests/test_s.ts": suite(2532, "SINK_PORT") },
  "",
);
const r8_args = ["--repo", repo8, "--ports-doc", doc8];
const r8a = run_checker(r8_args, undefined, "2900");
echo(r8a.stdout);
check("PB_PORT_OFFSET=2900 exits 1", r8a.returncode === 1);
check(
  "names the default, the sum and the suite",
  r8a.stdout.includes("2532") &&
    r8a.stdout.includes("5432") &&
    r8a.stdout.includes("tests/test_s.ts"),
);
const r8b = run_checker([...r8_args, "--offset", "2900"]);
check("--offset 2900 refuses the same way", r8b.returncode === 1 && r8b.stdout.includes("5432"));
const r8c = run_checker(r8_args, undefined, "5700");
check("PB_PORT_OFFSET=5700 is GREEN", r8c.returncode === 0);
const r8d = run_checker(r8_args);
check(
  "no offset at all is GREEN and silent about it",
  r8d.returncode === 0 && !r8d.stdout.includes("5432"),
);

console.log("── 8b. shell-only defaults count; a non-integer offset is one clean line ──");
const [repo8s, doc8s] = make_repo(
  "shell-default",
  { "scripts/battery.sh": "LEGACY_PORT=$((8091 + PB_PORT_OFFSET))\n" },
  "",
);
const r8s = run_checker(["--repo", repo8s, "--ports-doc", doc8s, "--offset", "18926"]);
echo(r8s.stdout);
check(
  "8091 + 18926 = 27017 from a .sh file is refused",
  r8s.returncode === 1 &&
    r8s.stdout.includes("scripts/battery.sh:1") &&
    r8s.stdout.includes("27017"),
);
const r8t = run_checker(["--repo", repo8s, "--ports-doc", doc8s], undefined, "abc");
echo(r8t.stdout + r8t.stderr);
check(
  "PB_PORT_OFFSET=abc exits 2 with one line and no stack",
  r8t.returncode === 2 &&
    r8t.stdout.includes("PB_PORT_OFFSET") &&
    !(r8t.stdout + r8t.stderr).includes("    at "),
);

console.log(
  "── 8c. an explicit --offset landing a default on a live listener → RED; env-only silent ──",
);
const [repo8c, doc8c] = make_repo("live-listener", { "tests/test_t.ts": suite(9037) }, "");
const listener = net.createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const live_port = (listener.address() as net.AddressInfo).port;
const live_offset = String(live_port - 9037);
const live_args = ["--repo", repo8c, "--ports-doc", doc8c];
const r8e = run_checker([...live_args, "--offset", live_offset]);
echo(r8e.stdout);
check(
  "--offset onto a bound port exits 1 naming the port and the site",
  r8e.returncode === 1 &&
    r8e.stdout.includes(String(live_port)) &&
    r8e.stdout.includes("tests/test_t.ts:3"),
);
const r8f = run_checker(live_args, undefined, live_offset);
check("PB_PORT_OFFSET alone does not probe: GREEN", r8f.returncode === 0);
listener.close();
await once(listener, "close");
const r8g = run_checker([...live_args, "--offset", live_offset]);
check("the same --offset once the listener is closed is GREEN", r8g.returncode === 0);

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

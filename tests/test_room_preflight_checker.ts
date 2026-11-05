#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_room_preflight.ts: boot detection, the unconditional same-scope
 * preflight, the undrained-pipe rule, the banned local redefinitions, and every CLI
 * disposition — on synthetic TS sources and a scratch tree (no server, real tree never written).
 * Line refs `py:N` cite the branch of the Python original (git show 85d5dd90:scripts/check_room_preflight.py).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr } from "../scripts/_py.ts";
import { audit, banned_local_defs } from "../scripts/check_room_preflight.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

let failures = 0;

function check(label: string, got: any, want: any): void {
  const ok = Bun.deepEquals(got, want, true);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌ MISMATCH"}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${py_repr(got)}`);
    console.log(`        want: ${py_repr(want)}`);
  }
}

const RK = 'import * as roomkit from "./roomkit.ts";\n';
/** [boots, unguarded, imports_roomkit, piped] of `src`. */
const A = (src: string) => audit(src);

console.log("════════ test_room_preflight_checker.ts — port-preflight checker unit pins ════════");

console.log("\n── (a) what is a boot (py:57-58, 87-91, 101-106, 315-317) ──");
check(
  'a spawn carrying "serve" is a boot, unguarded without a preflight',
  A(RK + 'Bun.spawn([PB, "serve"]);\n'),
  [[2], [2], true, []],
);
check(
  "a --http= argument alone is a boot (py:58)",
  A(RK + "Bun.spawn([PB, `--http=127.0.0.1:${PORT}`]);\n"),
  [[2], [2], true, []],
);
check(
  "SERVE_TOKEN finds `serve` after whitespace in one string (py:38)",
  A(RK + 'run_checked(["sh", "-c", "./pocketbase serve --dir x"]);\n'),
  [[2], [2], true, []],
);
check(
  "a name starting `serve` counts (py:53-54: names are matched too)",
  A(RK + "Bun.spawnSync(serve_argv(d, m));\n"),
  [[2], [2], true, []],
);
check(
  "a property name never counts (py:53: only ast.Name)",
  A(RK + "Bun.spawn([PB, opts.serve]);\n"),
  [[], [], true, []],
);
check(
  "a non-launch call carrying serve is not a boot (py:87-91)",
  A(RK + 'console.log(["serve"]);\n'),
  [[], [], true, []],
);
check(
  "roomkit.serve() is a boot AND its own preflight (py:315-316)",
  A(RK + "await roomkit.serve(PORT, d, m);\n"),
  [[2], [], true, []],
);
check(
  "an aliased namespace import still resolves roomkit.serve (py:113-116)",
  A('import * as rk from "../tests/roomkit.ts";\nawait rk.serve(PORT, d, m);\n'),
  [[2], [], true, []],
);
check("serve on a non-roomkit module is not a boot", A(RK + "await other.serve(PORT);\n"), [
  [],
  [],
  true,
  [],
]);

console.log("\n── (b) serve-carrying names (py:61-81) ──");
check(
  "a const holding a serve argv (py:65-67)",
  A(RK + 'const argv = [PB, "serve"];\nBun.spawn(argv);\n'),
  [[3], [3], true, []],
);
check(
  "a compound assignment (py:68-69)",
  A(RK + 'let argv = [PB];\nargv += "serve";\nBun.spawn(argv);\n'),
  [[4], [4], true, []],
);
check(
  "argv.push(...) (py:70-76: append/extend/insert)",
  A(RK + 'const argv = [PB];\nargv.push("--http=x");\nrun_checked(argv);\n'),
  [[4], [4], true, []],
);
check(
  "a variable with no serve literal is not a carrier",
  A(RK + 'const argv = [PB, "migrate"];\nBun.spawn(argv);\n'),
  [[], [], true, []],
);

console.log(
  "\n── (c) the preflight: unconditional, earlier, same scope (py:237-245, 274-292, 305-320) ──",
);
check(
  "an earlier awaited require_free_port guards the boot",
  A(RK + 'await roomkit.require_free_port(PORT);\nBun.spawn([PB, "serve"]);\n'),
  [[3], [], true, []],
);
check(
  "an un-awaited one guards too",
  A(RK + 'roomkit.require_free_port(PORT);\nBun.spawn([PB, "serve"]);\n'),
  [[3], [], true, []],
);
check(
  "a preflight AFTER the boot does not (py:319)",
  A(RK + 'Bun.spawn([PB, "serve"]);\nroomkit.require_free_port(PORT);\n'),
  [[2], [2], true, []],
);
check(
  "a preflight on the boot's own line does not (py:319 `>=`)",
  A(RK + 'roomkit.require_free_port(PORT); Bun.spawn([PB, "serve"]);\n'),
  [[2], [2], true, []],
);
check(
  "a preflight inside an if never counts (py:274-284)",
  A(RK + 'if (ok) {\n  roomkit.require_free_port(PORT);\n}\nBun.spawn([PB, "serve"]);\n'),
  [[5], [5], true, []],
);
check(
  "a preflight inside a try body counts (py:282-283)",
  A(RK + 'try {\n  roomkit.require_free_port(PORT);\n} finally {}\nBun.spawn([PB, "serve"]);\n'),
  [[5], [], true, []],
);
check(
  "a boot inside a branch is still found (py:262-271)",
  A(RK + 'roomkit.require_free_port(PORT);\nif (ok) {\n  Bun.spawn([PB, "serve"]);\n}\n'),
  [[4], [], true, []],
);
check(
  "a preflight in ANOTHER function does not guard (py:287-292)",
  A(
    RK +
      "async function pre() {\n  await roomkit.require_free_port(PORT);\n}\n" +
      'function boot() {\n  return Bun.spawn([PB, "serve"]);\n}\n',
  ),
  [[6], [6], true, []],
);
check(
  "a method body is its own scope, preflighted inside it",
  A(
    RK +
      "class Room {\n  async start() {\n    await roomkit.require_free_port(this.port);\n" +
      '    this.proc = Bun.spawn([PB, "serve"]);\n  }\n}\n',
  ),
  [[5], [], true, []],
);
check(
  "an arrow function body is its own scope",
  A(RK + 'roomkit.require_free_port(PORT);\nconst boot = () => Bun.spawn([PB, "serve"]);\n'),
  [[3], [3], true, []],
);
check(
  "a directly imported (aliased) require_free_port guards (py:117-120, 245)",
  A(
    'import { require_free_port as rfp } from "./roomkit.ts";\nawait rfp(PORT);\nBun.spawn([PB, "serve"]);\n',
  ),
  [[3], [], true, []],
);
check(
  "no roomkit import at all reads as imports_roomkit=false (py:329)",
  A('Bun.spawn([PB, "serve"]);\n'),
  [[1], [1], false, []],
);

console.log("\n── (d) undrained pipes (py:134-234, 321-328) ──");
check(
  'a boot with stdout: "pipe" is pipe-blocked (py:321-322)',
  A(RK + 'roomkit.require_free_port(P);\nBun.spawn([PB, "serve"], { stdout: "pipe" });\n'),
  [[3], [], true, [3]],
);
check(
  'a non-boot spawn with stderr: "pipe", never read (py:323-328)',
  A('const p = Bun.spawn(["sleep", "9"], { stderr: "pipe" });\n'),
  [[], [], false, [1]],
);
check(
  "an unassigned piping spawn (py:326: no binding)",
  A('Bun.spawn(["sleep", "9"], { stdout: "pipe" });\n'),
  [[], [], false, [1]],
);
check(
  "a handle whose .stdout is read is drained (py:217-234)",
  A('const p = Bun.spawn(["x"], { stdout: "pipe" });\nawait new Response(p.stdout).text();\n'),
  [[], [], false, []],
);
check(
  "a this.proc handle drained through this.proc.stderr (py:194-201)",
  A(
    'class R {\n  go() {\n    this.proc = Bun.spawn(["x"], { stderr: "pipe" });\n' +
      "    return this.proc.stderr;\n  }\n}\n",
  ),
  [[], [], false, []],
);
check(
  "reading ANOTHER handle does not drain this one",
  A('const p = Bun.spawn(["x"], { stdout: "pipe" });\nq.stdout;\n'),
  [[], [], false, [1]],
);
check(
  'a name bound to "pipe", through one more name (py:146-153)',
  A('const P = "pipe";\nconst Q = P;\nBun.spawn(["x"], { stdout: Q });\n'),
  [[], [], false, [3]],
);
check(
  "an options object bound to a name and spread in (py:156-169, 182-183)",
  A('const KW = { stderr: "pipe" };\nBun.spawn(["x"], { ...KW, cwd: d });\n'),
  [[], [], false, [2]],
);
check(
  "...or passed whole as the options argument",
  A('const KW = { stdout: "pipe" };\nBun.spawn(["x"], KW);\n'),
  [[], [], false, [2]],
);
check(
  'stdout: "inherit" / a file descriptor is no pipe',
  A('Bun.spawn(["x"], { stdout: "inherit", stderr: fd });\n'),
  [[], [], false, []],
);
check(
  "spawnSync drains before returning: not long-lived (py:187-191)",
  A('Bun.spawnSync(["x"], { stdout: "pipe" });\n'),
  [[], [], false, []],
);
check(
  "execFileSync of a boot pipes stdout unconditionally (py:94-98, 177-178)",
  A(RK + 'roomkit.require_free_port(P);\nexecFileSync(PB, ["serve"]);\n'),
  [[3], [], true, [3]],
);

console.log("\n── (e) banned local redefinitions (py:37, 332-340) ──");
check(
  "function, const arrow and method spellings are all caught, sorted",
  banned_local_defs(
    "async function wait_for_health() {}\nconst port_is_free = async () => true;\n" +
      "class X {\n  find_free_check() {}\n}\nconst wait_for_port_free = function () {};\n",
  ),
  ["find_free_check", "port_is_free", "wait_for_health", "wait_for_port_free"],
);
check(
  "an alias of roomkit's helper and an unrelated name are not",
  banned_local_defs("const wait_for_health = roomkit.wait_for_health;\nfunction port_free() {}\n"),
  [],
);

console.log("\n── (f) unparseable source raises SyntaxError (py:297, 375) ──");
let raised = "";
try {
  audit("const = ;\n");
} catch (e) {
  raised = e instanceof SyntaxError ? "SyntaxError" : String(e);
}
check("audit() of broken TS throws SyntaxError", raised, "SyntaxError");

console.log("\n── (h) launch spellings, roomkit specifiers, stdio pipes (macro review 3) ──");
check(
  'prose "server" in a carried string is not a serve token (root ruling, MR3)',
  A(RK + 'const args = parse_args("(static, no\\nserver)");\nrun(args.rules_dir);\n'),
  [[], [], true, []],
);
check(
  "...but a shell string with serve as a word still is",
  A(RK + "const cmd = `${PB} serve --dir d`;\nrun(cmd);\n"),
  [[3], [3], true, []],
);
check(
  "a same-module wrapper named run is a launch (py:84: bare run)",
  A(
    RK +
      "function run(argv: string[]) {\n  return Bun.spawnSync(argv);\n}\n" +
      'run([PB, "serve", "--http=127.0.0.1:8190"]);\n',
  ),
  [[5], [5], true, []],
);
check("...and so is one named call (py:84: bare call)", A(RK + 'call([PB, "serve"]);\n'), [
  [2],
  [2],
  true,
  [],
]);
check(
  "exec of a shell string carrying serve is a boot (py: SERVE_TOKEN on a shell=True string)",
  A(RK + "exec(`${PB} serve --http=127.0.0.1:8190`);\n"),
  [[2], [2], true, []],
);
check(
  "execSync and fork are launches too",
  A(RK + 'execSync("./pocketbase serve");\nfork(PB, ["serve"]);\n'),
  [[2, 3], [2, 3], true, []],
);
check(
  "a Bun.$ tagged template carrying serve is a boot",
  A(RK + "const proc = Bun.$`${PB} serve --http=127.0.0.1:8190`;\n"),
  [[2], [2], true, []],
);
check(
  "a Bun.$ template after the preflight is guarded",
  A(RK + "await roomkit.require_free_port(P);\nawait Bun.$`${PB} serve`;\n"),
  [[3], [], true, []],
);
check(
  'roomkit imported as "./roomkit" (no extension) still imports roomkit and preflights',
  A(
    'import * as roomkit from "./roomkit";\nawait roomkit.require_free_port(P);\n' +
      'Bun.spawn([PB, "serve"], { stdout: "ignore", stderr: "ignore" });\n',
  ),
  [[3], [], true, []],
);
check(
  'roomkit imported as "./roomkit.js" resolves roomkit.serve',
  A('import * as rk from "./roomkit.js";\nawait rk.serve(PORT, d, m);\n'),
  [[2], [], true, []],
);
check(
  "a stdio array piping index 1/2 is pipe-blocked (py:172-184, the stdout/stderr=PIPE twin)",
  A(
    RK +
      "await roomkit.require_free_port(P);\n" +
      'const proc = Bun.spawn([PB, "serve"], { stdio: ["ignore", "pipe", "pipe"] });\n',
  ),
  [[3], [], true, [3]],
);
check('stdio: "pipe" pipes every channel', A('Bun.spawn(["sleep", "9"], { stdio: "pipe" });\n'), [
  [],
  [],
  false,
  [1],
]);
check(
  "a stdio array piping only stdin (index 0) is no output pipe",
  A('Bun.spawn(["sleep", "9"], { stdio: ["pipe", "ignore", "inherit"] });\n'),
  [[], [], false, []],
);
check(
  "a stdio array in a spread options object pipes too",
  A('const KW = { stdio: ["ignore", "ignore", "pipe"] };\nBun.spawn(["x"], { ...KW });\n'),
  [[], [], false, [2]],
);

console.log("\n── (g) the CLI on a scratch tree (py:355-463) ──");
const BATTERY_OK = '#!/usr/bin/env bash\nstart_room() {\n  bun tests/roomkit.ts "$1"\n}\n';
const root = fs.mkdtempSync(path.join(os.tmpdir(), "room-preflight-checker-"));
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function run(...args: string[]): [number, string] {
  const proc = Bun.spawnSync(
    [process.execPath, path.join(root, "scripts", "check_room_preflight.ts"), ...args],
    { cwd: root, env: process.env },
  );
  return [proc.exitCode ?? 1, proc.stdout.toString() + proc.stderr.toString()];
}
try {
  fs.mkdirSync(path.join(root, "scripts"));
  for (const f of [
    "check_room_preflight.ts",
    "_argparse.ts",
    "_py.ts",
    "_repo_root.ts",
    "_ts_source.ts",
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", f), path.join(root, "scripts", f));
  }
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"));
  write("scripts/run_suite_battery.sh", BATTERY_OK);
  write("tests/test_quiet.ts", "console.log(1);\n");
  write("tests/test_good.ts", RK + "await roomkit.serve(PORT, d, m);\n");
  write("tests/test_notes.py", 'Bun.spawn([PB, "serve"]);\n');

  let [rc, out] = run();
  check("no roomkit.ts → exit 1 (py:363-365)", rc, 1);
  check("...naming the missing shared preflight", out.includes("roomkit.ts not found"), true);

  write("tests/roomkit.ts", "export {};\n");
  [rc, out] = run("--table");
  check("a clean tree passes (py:458-463)", rc, 0);
  check(
    "...counting the one preflighted file; .py files are out of scope",
    out.includes("✅ check_room_preflight: 1 self-booting file(s)"),
    true,
  );
  check("--table prints the dispositions (py:445-450)", /test_quiet +no server/.test(out), true);
  check("...and the preflighted one", /test_good +preflighted/.test(out), true);
  check("...and the scripts/ files", /\n_py +no server/.test(out), true);

  write("scripts/utilities/boot.ts", 'Bun.spawn([PB, "serve"]);\n');
  write("tests/test_unguarded.ts", RK + 'Bun.spawn([PB, "serve"]);\n');
  write("tests/test_broken.ts", "const = ;\n");
  write("tests/test_dupe.ts", "function port_is_free() {}\n");
  write("tests/test_piped.ts", 'const p = Bun.spawn(["x"], { stdout: "pipe" });\n');
  [rc, out] = run("--table");
  check("planted violations → exit 1 (py:452-456)", rc, 1);
  check(
    "scripts/ is walked recursively; no import → NO IMPORT (py:351, 399-405)",
    out.includes(
      "scripts/utilities/boot.ts: starts a server (line(s) 1) but never imports roomkit",
    ),
    true,
  );
  check(
    "an unguarded boot → UNGUARDED (py:406-412)",
    out.includes("tests/test_unguarded.ts: server start at line(s) 2 is not preceded by an"),
    true,
  );
  check(
    "unparseable → UNPARSEABLE (py:375-378)",
    out.includes("tests/test_broken.ts: could not be parsed (") &&
      /test_broken +❌ UNPARSEABLE/.test(out),
    true,
  );
  check(
    "a banned redefinition is named (py:379-383)",
    out.includes("tests/test_dupe.ts: defines its own port_is_free() — call the tests/roomkit"),
    true,
  );
  check(
    "an undrained pipe → PIPE DEADLOCK (py:384-395)",
    out.includes(
      "tests/test_piped.ts: launches a long-lived child leaving an undrained pipe on stdout/stderr at line(s) 1",
    ) && /test_piped +❌ PIPE DEADLOCK/.test(out),
    true,
  );

  for (const f of ["test_unguarded", "test_broken", "test_dupe", "test_piped"]) {
    fs.rmSync(path.join(root, "tests", `${f}.ts`));
  }
  fs.rmSync(path.join(root, "scripts", "utilities"), { recursive: true });
  write("scripts/run_suite_battery.sh", "start_room() {\n  ./pocketbase serve\n}\n");
  [rc, out] = run();
  check(
    "start_room() not invoking tests/roomkit.ts → exit 1 (py:438-443)",
    [rc, out.includes("start_room() boots a room without invoking tests/roomkit.ts")],
    [1, true],
  );
  write("scripts/run_suite_battery.sh", "start_room () {\n}\n");
  [rc, out] = run();
  check(
    "no start_room() → the parse-assumption error (py:432-437)",
    [rc, out.includes("could not find start_room() in scripts/run_suite_battery.sh")],
    [1, true],
  );
  fs.rmSync(path.join(root, "scripts", "run_suite_battery.sh"));
  [rc, out] = run();
  check(
    "no battery script → `<path> not found` (py:428-429)",
    [rc, out.includes("run_suite_battery.sh not found")],
    [1, true],
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ FAIL — ${failures} check(s) mismatched`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

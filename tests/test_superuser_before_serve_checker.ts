#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_superuser_before_serve.ts: boot/upsert classification, the
 * execution-order walk (try/if bodies, same-module function/method inlining), and every CLI
 * disposition — on synthetic TS sources and a scratch tree (no server, real tree never written).
 * Line refs `py:N` cite the branch of the Python original (git show 85d5dd90:scripts/check_superuser_before_serve.py).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr } from "../scripts/_py.ts";
import { audit } from "../scripts/check_superuser_before_serve.ts";

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
const UP = 'run_checked([PB, "superuser", "upsert", E, P]);\n';
const SERVE = "await roomkit.serve(PORT, d, m);\n";

console.log(
  "════════ test_superuser_before_serve_checker.ts — upsert-before-serve checker unit pins ════════",
);

console.log("\n── (a) classification (py:80-125) ──");
check("upsert then roomkit.serve → ordered (py:114-115, 122-124)", audit(RK + UP + SERVE), [
  [3],
  [],
]);
check("roomkit.serve with no upsert → violation (py:192-196)", audit(RK + SERVE), [[2], [2]]);
check("serve BEFORE the upsert → violation", audit(RK + SERVE + UP), [[2], [2]]);
check(
  "a raw spawn the sibling gate calls a boot is SERVE (py:120-121)",
  audit(UP + 'Bun.spawn([PB, "serve", `--http=127.0.0.1:${PORT}`]);\n'),
  [[2], []],
);
check(
  "an argv carried in a variable is SERVE too (py:186: serve_carrying_names)",
  audit('const argv = [PB, "serve"];\nBun.spawn(argv);\n'),
  [[2], [2]],
);
check(
  "Bun.spawnSync with superuser+upsert is the upsert (py:82-83: attribute launch)",
  audit(RK + 'Bun.spawnSync([PB, "superuser", "upsert", E, P]);\n' + SERVE),
  [[3], []],
);
check(
  "a non-launch call carrying superuser+upsert is not an upsert (py:116-117)",
  audit(RK + 'console.log("superuser", "upsert");\n' + SERVE),
  [[3], [3]],
);
check(
  "upsert without 'superuser' is not an upsert (py:123)",
  audit(RK + 'run_checked([PB, "upsert"]);\n' + SERVE),
  [[3], [3]],
);
check(
  "serve on a non-roomkit module is no boot (py:103-110)",
  audit(RK + "await other.serve(PORT);\n"),
  [[], []],
);
check(
  "an aliased namespace import resolves (py:93-100)",
  audit('import * as rk from "../tests/roomkit.ts";\n' + UP + "await rk.serve(PORT);\n"),
  [[3], []],
);

console.log("\n── (b) the execution-order walk (py:59-77, 137-172) ──");
check(
  "upsert in try, serve in finally (py:67-72)",
  audit(RK + "try {\n  " + UP + "} finally {\n  " + SERVE + "}\n"),
  [[5], []],
);
check(
  "upsert in catch, serve after (py:69-70)",
  audit(RK + "try {\n  x();\n} catch (e) {\n  " + UP + "}\n" + SERVE),
  [[7], []],
);
check(
  "upsert in an if, serve in its else (py:75-77)",
  audit(RK + "if (a) {\n  " + UP + "} else {\n  " + SERVE + "}\n"),
  [[5], []],
);
check(
  "a helper DEFINED above but CALLED after serve is still late (py:150-172)",
  audit(RK + "function setup() {\n  " + UP + "}\n" + SERVE + "setup();\n"),
  [[5], [5]],
);
check(
  "a helper called before serve is inlined at its call site",
  audit(RK + "function setup() {\n  " + UP + "}\nsetup();\n" + SERVE),
  [[6], []],
);
check(
  "an uncalled function's body is never walked (py:65-66)",
  audit(RK + "function boot() {\n  " + SERVE + "}\n"),
  [[], []],
);
check(
  "a method resolved by name through a class (py:143-146)",
  audit(
    RK +
      "class Room {\n  async start() {\n    " +
      UP +
      "    " +
      SERVE +
      "  }\n}\nawait new Room().start();\n",
  ),
  [[5], []],
);
check(
  "a top-level const arrow is indexed like a function",
  audit(RK + "const setup = () => {\n  " + UP + "};\nsetup();\n" + SERVE),
  [[6], []],
);
check(
  "recursion is cut by the visiting set (py:163)",
  audit(RK + "function loop() {\n  loop();\n  " + SERVE + "}\nloop();\n"),
  [[4], [4]],
);
check(
  "a callback passed inline runs at its call site",
  audit(RK + UP + "await quiet(async () => {\n  " + SERVE + "});\n"),
  [[4], []],
);

console.log("\n── (b2) launch spellings, roomkit specifiers, class fields (macro review 3) ──");
check(
  "a same-module wrapper named run is a launch, so its serve is a boot (py:84: bare run)",
  audit(
    "function run(argv: string[]) {\n  return Bun.spawnSync(argv);\n}\n" +
      'run([PB, "migrate", "up"]);\nrun([PB, "serve", "--http=127.0.0.1:8190"]);\n',
  ),
  [[5], [5]],
);
check("...and a wrapper named Popen (py:84: bare Popen)", audit('Popen([PB, "serve"]);\n'), [
  [1],
  [1],
]);
check(
  "a wrapper-run upsert orders a later serve",
  audit('run([PB, "superuser", "upsert", E, P]);\nrun([PB, "serve"]);\n'),
  [[2], []],
);
check(
  "exec of a shell string carrying serve is a boot (py: SERVE_TOKEN on a shell=True string)",
  audit("exec(`${PB} serve --http=127.0.0.1:8190`);\n"),
  [[1], [1]],
);
check(
  "a Bun.$ tagged template carrying serve is a boot",
  audit("const proc = Bun.$`${PB} serve --http=127.0.0.1:8190`;\n"),
  [[1], [1]],
);
check(
  'roomkit imported as "./roomkit" (no extension) resolves roomkit.serve',
  audit('import * as roomkit from "./roomkit";\n' + SERVE),
  [[2], [2]],
);
check(
  'roomkit imported as "./roomkit.js" resolves roomkit.serve',
  audit('import * as roomkit from "./roomkit.js";\n' + SERVE),
  [[2], [2]],
);
check(
  "a non-top-level roomkit import resolves too (py:93-100: ast.walk)",
  audit('declare module "m" {\n  import * as roomkit from "./roomkit.ts";\n}\n' + SERVE),
  [[4], [4]],
);
check(
  "a class field holding an arrow is inlined like a method",
  audit(
    RK +
      "class Early {\n  boot = async () => {\n    " +
      SERVE +
      "  };\n}\nawait new Early().boot();\n" +
      UP +
      "await roomkit.serve(8191, d, m);\n",
  ),
  [[4, 9], [4]],
);
check(
  "...and one holding a function expression",
  audit(
    RK +
      "class Early {\n  boot = function () {\n    " +
      UP +
      "  };\n}\nnew Early().boot();\n" +
      SERVE,
  ),
  [[8], []],
);

console.log("\n── (c) unparseable source raises SyntaxError (py:178, 217) ──");
let raised = "";
try {
  audit("const = ;\n");
} catch (e) {
  raised = e instanceof SyntaxError ? "SyntaxError" : String(e);
}
check("audit() of broken TS throws SyntaxError", raised, "SyntaxError");

console.log("\n── (d) the CLI on a scratch tree (py:200-264) ──");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "superuser-before-serve-checker-"));
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function run(...args: string[]): [number, string] {
  const proc = Bun.spawnSync(
    [process.execPath, path.join(root, "scripts", "check_superuser_before_serve.ts"), ...args],
    { cwd: root, env: process.env },
  );
  return [proc.exitCode ?? 1, proc.stdout.toString() + proc.stderr.toString()];
}
try {
  fs.mkdirSync(path.join(root, "scripts"));
  for (const f of [
    "check_superuser_before_serve.ts",
    "check_room_preflight.ts",
    "_argparse.ts",
    "_py.ts",
    "_ts_source.ts",
    "_repo_root.ts",
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", f), path.join(root, "scripts", f));
  }
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"));
  write("tests/test_quiet.ts", "console.log(1);\n");
  write("tests/test_good.ts", RK + UP + SERVE);
  write("tests/test_notes.py", RK + SERVE);

  let [rc, out] = run("--table");
  check("a clean tree passes (py:259-264)", rc, 0);
  check(
    "...counting the one ordered suite; .py files are out of scope",
    out.includes("✅ check_superuser_before_serve: 1 self-booting suite(s) create"),
    true,
  );
  check("--table prints the dispositions (py:246-251)", /test_quiet +no server/.test(out), true);
  check("...and the ordered one (py:243-244)", /test_good +ordered/.test(out), true);

  write("tests/test_late.ts", RK + SERVE + UP);
  write("tests/test_broken.ts", "const = ;\n");
  // The two gates now share one launch list; they still differ on an uncalled function's body.
  write("tests/test_unclassified.ts", 'function boot() {\n  execFileSync(PB, ["serve"]);\n}\n');
  [rc, out] = run("--table");
  check("planted violations → exit 1 (py:253-257)", rc, 1);
  check(
    "serve before upsert → SERVE-BEFORE-UPSERT (py:236-242)",
    out.includes("test_late: serve at line(s) 2 runs with no superuser upsert earlier") &&
      /test_late +❌ SERVE-BEFORE-UPSERT/.test(out),
    true,
  );
  check(
    "unparseable → UNPARSEABLE (py:215-220)",
    out.includes("test_broken: could not be parsed (") && /test_broken +❌ UNPARSEABLE/.test(out),
    true,
  );
  check(
    "a boot only the sibling gate sees → UNCLASSIFIED BOOT (py:226-233)",
    out.includes("test_unclassified: check_room_preflight sees a room boot here") &&
      /test_unclassified +❌ UNCLASSIFIED BOOT/.test(out),
    true,
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

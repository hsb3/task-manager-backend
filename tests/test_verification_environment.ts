#!/usr/bin/env bun
/** Setup preserves local configuration/data and verification refuses an unprepared tree. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pinned_pb_version } from "../scripts/pb_migrate.ts";
import { decode_text, py_repr, py_strip, read_text } from "../scripts/_py.ts";

const ROOT = path.dirname(import.meta.dir);

const RANGE_CHARS = new Set("^~*<>=,");

/** mise.toml's [tools].lefthook must be a non-empty, exact version — never a range. */
function check_lefthook_pin(root: string): void {
  const pin = (Bun.TOML.parse(read_text(path.join(root, "mise.toml"))) as any).tools.lefthook;
  assert.ok(
    typeof pin === "string" && py_strip(pin),
    "mise.toml [tools] must pin lefthook to a version",
  );
  assert.ok(
    ![...pin].some((c) => RANGE_CHARS.has(c)) && !pin.includes(" - "),
    `lefthook pin ${py_repr(pin)} reads as a version range, not an exact version`,
  );
}

/** subprocess.run(..., capture_output=True, text=True, check=False). */
function run(cmd: string[], cwd: string, env: Record<string, string | undefined>) {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { returncode: r.exitCode, stdout: decode_text(r.stdout), stderr: decode_text(r.stderr) };
}

function write_exe(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

/** The tree-local scripts `make setup` needs to resolve ./pocketbase through pb_migrate.ts. */
function copy_resolver(root: string): void {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "Makefile"), path.join(root, "Makefile"));
  fs.copyFileSync(path.join(ROOT, "Dockerfile"), path.join(root, "Dockerfile"));
  for (const name of ["pb_migrate.ts", "_py.ts", "_argparse.ts"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", name), path.join(root, "scripts", name));
  }
}

function main(): void {
  check_lefthook_pin(ROOT);
  console.log("✅ mise.toml pins lefthook to an exact, non-range version");
  const tools = (Bun.TOML.parse(read_text(path.join(ROOT, "mise.toml"))) as any).tools;
  const bun_pin: string = tools.bun;
  // Stands in for the pinned Bun: answers the pin, skips setup's install (no network here), and
  // runs everything else on this very runtime.
  const pinned_bun_body =
    `#!/bin/sh\n[ "$1" != --version ] || { echo ${bun_pin}; exit 0; }\n` +
    `[ "$1" != install ] || exit 0\n` +
    `exec '${process.execPath}' "$@"\n`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verification-environment-"));
  try {
    const root = fs.realpathSync(scratch);
    for (const d of ["pb_data", "bin", "scripts"]) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, "scripts/verification-env.sh"), "return 0\n");
    copy_resolver(root);
    fs.writeFileSync(path.join(root, ".env.local.example"), "template\n");
    const sentinels: Record<string, string> = {};
    for (const name of [".env", ".env.local", "pb_data/data.db"]) {
      sentinels[name] = "existing local state\n";
    }
    // make setup resolves ./pocketbase through the version check, so the kept binary answers it.
    sentinels["pocketbase"] = `#!/bin/sh\necho "pocketbase version ${pinned_pb_version()}"\n`;
    for (const [name, content] of Object.entries(sentinels)) {
      fs.writeFileSync(path.join(root, name), content);
    }
    fs.chmodSync(path.join(root, "pocketbase"), 0o755);
    for (const name of ["curl", "unzip", "mise"]) {
      write_exe(path.join(root, "bin", name), "#!/bin/sh\nexit 0\n");
    }
    write_exe(path.join(root, "bin/bun"), pinned_bun_body);
    const env = {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      PB_BIN: "",
    };
    // setup activates the pre-commit hook with `git config`, so the scratch must be a repo.
    assert.ok(run(["git", "init", "-q"], root, env).returncode === 0);
    for (let i = 0; i < 2; i++) {
      const result = run(["make", "setup"], root, env);
      assert.ok(result.returncode === 0, result.stdout + result.stderr);
      for (const [name, content] of Object.entries(sentinels)) {
        assert.ok(read_text(path.join(root, name)) === content, `setup clobbered ${name}`);
      }
    }
    console.log("✅ repeated setup preserves config, PocketBase binary, and data");
    fs.copyFileSync(
      path.join(ROOT, "scripts/verification-env.sh"),
      path.join(root, "scripts/verification-env.sh"),
    );
    let result = run(["sh", "-c", ". scripts/verification-env.sh"], root, env);
    assert.ok(result.returncode !== 0, "unprepared tree accepted without root node_modules");
    assert.ok(
      (result.stdout + result.stderr).includes("make setup"),
      result.stdout + result.stderr,
    );
    console.log("✅ unprepared tree refuses without root node_modules, with setup instruction");
    for (const name of ["mise.toml", "package.json"]) {
      fs.copyFileSync(path.join(ROOT, name), path.join(root, name));
    }
    const pins: Record<string, string> = JSON.parse(
      read_text(path.join(ROOT, "package.json")),
    ).devDependencies;
    for (const [name, pin] of Object.entries(pins)) {
      // The lowest version a `^`/`~` pin admits; an exact pin is itself.
      const version = pin.replace(/^[\^~]/, "");
      assert.ok(Bun.semver.satisfies(version, pin), `fixture ${name}@${version} misses ${pin}`);
      const dir = path.join(root, "node_modules", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
    }
    const pinned_bun = path.join(root, "pinned-bun/bin");
    write_exe(path.join(pinned_bun, "bun"), pinned_bun_body);
    write_exe(path.join(root, "bin/bun"), "#!/bin/sh\nexit 99\n");
    write_exe(
      path.join(root, "bin/mise"),
      `#!/bin/sh\ncase "$2" in bun@*) echo '${path.dirname(pinned_bun)}';; esac\n`,
    );
    result = run(["sh", "-c", ". scripts/verification-env.sh && command -v bun"], root, env);
    assert.ok(result.returncode === 0, result.stdout + result.stderr);
    assert.ok(py_strip(result.stdout) === path.join(pinned_bun, "bun"), result.stdout);
    console.log("✅ pinned mise Bun wins over inherited PATH");
    for (const dependency of [
      { prettier: "0.0.0" },
      { typescript: "0.0.0" },
      { "missing-verification-package": "1" },
    ]) {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ devDependencies: dependency }),
      );
      result = run(["sh", "-c", ". scripts/verification-env.sh"], root, env);
      assert.ok(result.returncode !== 0, `accepted ${JSON.stringify(dependency)}`);
      assert.ok((result.stdout + result.stderr).includes("make setup"));
    }
    console.log("✅ wrong/missing root dev-dependency versions refuse with setup instruction");
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(root, "package.json"));
    fs.writeFileSync(path.join(root, "mise.toml"), `[tools]\nbun = "0.0.0"\n`);
    result = run(["sh", "-c", ". scripts/verification-env.sh"], root, env);
    assert.ok(result.returncode !== 0, "wrong Bun runtime accepted");
    assert.ok((result.stdout + result.stderr).includes("Bun 0.0.0 required"));
    console.log("✅ wrong Bun runtime refuses with setup instruction");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main();
}

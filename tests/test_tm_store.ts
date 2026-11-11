#!/usr/bin/env bun
/**
 * tm credential store (clients/tm/src/store.ts): the key goes to the system store when one answers,
 * else to the config file with a note; TM_CREDENTIAL_STORE=file touches the store only to clear the
 * entry a file save or a logout replaces; a failed save puts the store back as it was; logout leaves no usable key behind; the config directory is tightened to 0700; a Node
 * build falls back to the file. No server, no port.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { py_repr, tup } from "../scripts/_py.ts";
import {
  ConfigError,
  config_path,
  forget_config,
  load_config,
  save_config,
  saved_login,
} from "../clients/tm/src/api.ts";
import { backend, store_mode } from "../clients/tm/src/store.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const URL_A = "http://127.0.0.1:1/";
const URL_B = "http://127.0.0.1:2";
const KEY = `tmk_${"S".repeat(40)}`;

let failures = 0;

function check(label: string, got: any, expected: any): void {
  const ok = Bun.deepEquals(got, expected, true);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "✅" : "❌ MISMATCH"}  ${label.padEnd(72)} → ${py_repr(got)} (want ${py_repr(expected)})`,
  );
}

const S = fs.mkdtempSync(path.join(os.tmpdir(), "tm-store-test-"));
const real_secrets = backend.secrets;
delete process.env.TM_URL;
delete process.env.TM_API_KEY;

/** An in-memory store recording every call; `fail` makes each call reject with that error. */
function mem(fail?: Error) {
  const entries = new Map<string, string>();
  const calls: string[] = [];
  const op =
    <T>(name: string, f: (o: any) => T) =>
    async (o: any): Promise<T> => {
      calls.push(name);
      if (fail) throw fail;
      return f(o);
    };
  const api = {
    get: op("get", (o) => entries.get(`${o.service}|${o.name}`) ?? null),
    set: op("set", (o) => void entries.set(`${o.service}|${o.name}`, o.value)),
    delete: op("delete", (o) => entries.delete(`${o.service}|${o.name}`)),
  };
  return { entries, calls, api };
}

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

/** One case in its own XDG_CONFIG_HOME, store mode and backend; stderr captured. */
async function run_case(
  name: string,
  mode: string | undefined,
  secrets: unknown,
  body: (ctx: { file: string; stderr: () => string }) => Promise<void>,
): Promise<void> {
  console.log(`\n── ${name} ──`);
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(S, "xdg-"));
  if (mode === undefined) delete process.env.TM_CREDENTIAL_STORE;
  else process.env.TM_CREDENTIAL_STORE = mode;
  backend.secrets = () => secrets as any;
  let err = "";
  const real_error = console.error;
  console.error = (...a: unknown[]) => void (err += a.join(" ") + "\n");
  try {
    await body({ file: config_path(), stderr: () => err });
  } catch (e) {
    console.error = real_error;
    check(`${name}: no unexpected throw`, String(e), "");
  } finally {
    console.error = real_error;
  }
}

const read = (file: string) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "no refusal",
    (e) => (e instanceof ConfigError ? e.message : `not a ConfigError: ${e}`),
  );

try {
  await run_case(
    "fallback on platform error",
    undefined,
    mem(coded("ERR_SECRETS_PLATFORM_ERROR", "libsecret not available")).api,
    async ({ file, stderr }) => {
      const r = await save_config({ url: URL_B, key: KEY });
      check("save_config returns store file", r, { file, store: "file" });
      check("the file holds url and key", read(file), { url: URL_B, key: KEY });
      check(
        "stderr notes the file fallback, then warns once that an older store entry could not be cleared",
        tup(
          stderr().split("\n")[0],
          stderr()
            .split("\n")
            .filter((l) => l.startsWith("tm: warning:")).length,
        ),
        tup(
          `tm: no credential store is available; the key is saved in ${file}, readable only by this user`,
          1,
        ),
      );
      check("the key is never printed", stderr().includes(KEY), false);
      check("file mode 600", (fs.statSync(file).mode & 0o777).toString(8), "600");
    },
  );

  {
    const m = mem();
    await run_case("os store used", undefined, m.api, async ({ file, stderr }) => {
      const r = await save_config({ url: URL_B, key: KEY });
      check("save_config returns store os", r, { file, store: "os" });
      check("the file is {url} only", read(file), { url: URL_B });
      check("the entry is service tm, name the url", [...m.entries], [[`tm|${URL_B}`, KEY]]);
      check("no stderr note", stderr(), "");
      check("load_config returns the stored key", await load_config(), { url: URL_B, key: KEY });
      check("saved_login reads the key from the store", await saved_login(false), {
        url: URL_B,
        key: KEY,
      });
      await save_config({ url: URL_A, key: KEY });
      check(
        "a login to another url removes the previous entry; trailing slash dropped",
        [...m.entries.keys()],
        ["tm|http://127.0.0.1:1"],
      );
      await forget_config("http://127.0.0.1:1");
      check(
        "forget_config empties the store and removes the file",
        tup(m.entries.size, fs.existsSync(file)),
        tup(0, false),
      );
    });
  }

  await run_case(
    "other rejection",
    undefined,
    mem(coded("EACCES", "the keychain is locked")).api,
    async ({ file }) => {
      check(
        "save_config rejects with the credential store refusal",
        await refusal(save_config({ url: URL_B, key: KEY })),
        "the credential store refused: the keychain is locked",
      );
      fs.writeFileSync(file, JSON.stringify({ url: URL_B }));
      check(
        "load_config rejects the same way",
        await refusal(load_config()),
        "the credential store refused: the keychain is locked",
      );
    },
  );

  {
    const m = mem();
    let touched = 0;
    await run_case("TM_CREDENTIAL_STORE=file", "file", m.api, async ({ file, stderr }) => {
      backend.secrets = () => {
        touched += 1;
        return m.api;
      };
      const r = await save_config({ url: URL_B, key: KEY });
      check("save_config returns store file", r, { file, store: "file" });
      check("the file holds url and key", read(file), { url: URL_B, key: KEY });
      check("no stderr note (the file was asked for)", stderr(), "");
      check("load_config reads the file", await load_config(), { url: URL_B, key: KEY });
      check("saved_login reads the file", await saved_login(true), { url: URL_B, key: KEY });
      check(
        "save only clears the store entry; load and saved_login never call the backend",
        m.calls,
        ["delete"],
      );
      await save_config({ url: URL_A, key: KEY });
      m.calls.length = 0;
      await forget_config(URL_B);
      check("forget_config removes the file", fs.existsSync(file), false);
      check("forget_config clears the store entry even here", m.calls, ["delete"]);
    });
  }

  {
    const m = mem();
    await run_case("os login, then a file-mode save of a newer key", undefined, m.api, async () => {
      await save_config({ url: URL_B, key: "tmk_" + "1".repeat(40) });
      process.env.TM_CREDENTIAL_STORE = "file";
      await save_config({ url: URL_B, key: KEY });
      check("the file-mode save removed the older store entry", [...m.entries.keys()], []);
      delete process.env.TM_CREDENTIAL_STORE;
      check("back in os mode, the newer login is the one used", (await load_config()).key, KEY);
    });
  }

  for (const had of [true, false]) {
    const m = mem();
    const OLD = "tmk_" + "2".repeat(40);
    await run_case(
      `a save whose file cannot be written, store ${had ? "holding" : "without"} an older key`,
      undefined,
      m.api,
      async ({ file }) => {
        if (had) m.entries.set(`tm|${URL_B}`, OLD);
        fs.mkdirSync(path.join(file, "occupied"), { recursive: true }); // the rename onto a full directory fails
        const got = await save_config({ url: URL_B, key: KEY }).then(
          () => "saved",
          () => "refused",
        );
        check(
          "the save is refused and the store is back as it was",
          tup(got, m.entries.get(`tm|${URL_B}`) ?? null),
          tup("refused", had ? OLD : null),
        );
      },
    );
  }

  {
    const m = mem();
    await run_case("os login, then logout in file mode", undefined, m.api, async ({ file }) => {
      await save_config({ url: URL_B, key: KEY });
      process.env.TM_CREDENTIAL_STORE = "file";
      check(
        "forget_config clears the os entry and says so",
        tup(await forget_config(URL_B), m.entries.size, fs.existsSync(file)),
        tup(true, 0, false),
      );
    });
  }

  {
    const old = "tmk_" + "O".repeat(40);
    const entries = new Map([[`tm|${URL_B}`, old]]);
    const stuck = {
      get: async (o: any) => entries.get(`${o.service}|${o.name}`) ?? null,
      set: async () => {},
      delete: async () => {
        throw coded("EACCES", "denied");
      },
    };
    await run_case(
      "store refuses the delete at logout",
      undefined,
      stuck,
      async ({ file, stderr }) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ url: URL_B }));
        const tmp = `${file}.4242.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ url: URL_B, key: old }));
        const kept = path.join(path.dirname(file), "notes.tmp");
        fs.writeFileSync(kept, "mine");
        const got = await forget_config(URL_B).then(
          (r) => r,
          (e) => `threw: ${e}`,
        );
        check(
          "forget_config does not throw, returns false; file and leftover temp gone, other files kept",
          tup(got, fs.existsSync(file), fs.existsSync(tmp), fs.existsSync(kept)),
          tup(false, false, false, true),
        );
        check("saved_login then finds nothing", await saved_login(true), null);
        process.env.TM_URL = URL_B;
        try {
          check(
            "load_config with TM_URL set refuses; the stranded store key is never read",
            await refusal(load_config()),
            "no server or key configured: run `tm login` or set TM_URL and TM_API_KEY",
          );
        } finally {
          delete process.env.TM_URL;
        }
        check("nothing printed", stderr(), "");
      },
    );
  }

  {
    const k1 = "tmk_" + "1".repeat(40);
    const m = mem();
    m.entries.set(`tm|${URL_B}`, k1);
    await run_case(
      "the store is read only for the saved login's URL",
      undefined,
      m.api,
      async ({ file }) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ url: URL_A }));
        process.env.TM_URL = URL_B;
        try {
          check(
            "TM_URL names another server: its store entry is not used",
            await refusal(load_config()),
            "no server or key configured: run `tm login` or set TM_URL and TM_API_KEY",
          );
        } finally {
          delete process.env.TM_URL;
        }
      },
    );
  }

  {
    const failing_get = {
      get: async () => {
        throw coded("EACCES", "the keychain is locked");
      },
      set: async () => {},
      delete: async () => true,
    };
    await run_case(
      "saved_login survives a store read failure",
      undefined,
      failing_get,
      async ({ file }) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ url: URL_B, key: KEY }));
        check(
          "saved_login falls back to the file's key",
          await saved_login(true).catch((e) => `threw: ${e}`),
          { url: URL_B, key: KEY },
        );
      },
    );
  }

  await run_case("relative XDG_CONFIG_HOME", "file", undefined, async () => {
    process.env.XDG_CONFIG_HOME = "relative/xdg";
    check(
      "ignored, as the XDG spec says: ~/.config is used",
      config_path(),
      path.join(os.homedir(), ".config", "tm", "config.json"),
    );
  });

  await run_case("TM_CREDENTIAL_STORE=bogus", "bogus", mem().api, async ({ file }) => {
    const want = "TM_CREDENTIAL_STORE must be os or file";
    let sync = "";
    try {
      store_mode();
    } catch (e) {
      sync = e instanceof ConfigError ? e.message : String(e);
    }
    check("store_mode refuses", sync, want);
    check("save_config refuses", await refusal(save_config({ url: URL_B, key: KEY })), want);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: URL_B, key: KEY }));
    check("load_config refuses even with a good saved login", await refusal(load_config()), want);
  });

  await run_case("old file still read", undefined, mem().api, async ({ file }) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: URL_B, key: KEY }));
    check("load_config takes the key from the file", await load_config(), { url: URL_B, key: KEY });
    check("saved_login takes the key from the file", await saved_login(false), {
      url: URL_B,
      key: KEY,
    });
  });

  await run_case("directory tightened", "file", undefined, async ({ file }) => {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    await save_config({ url: URL_B, key: KEY });
    check("the directory is 0700 after save", (fs.statSync(dir).mode & 0o777).toString(8), "700");
  });

  await run_case("symlinked config file", "file", undefined, async ({ file }) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const victim = path.join(path.dirname(path.dirname(file)), "victim.txt");
    fs.writeFileSync(victim, "untouched\n", { mode: 0o644 });
    fs.symlinkSync(victim, file);
    await save_config({ url: URL_B, key: KEY });
    check(
      "the link's target is neither written nor chmodded; the file replaces the link",
      tup(
        fs.readFileSync(victim, "utf8"),
        (fs.statSync(victim).mode & 0o777).toString(8),
        fs.lstatSync(file).isSymbolicLink(),
        read(file)?.key === KEY,
        (fs.statSync(file).mode & 0o777).toString(8),
      ),
      tup("untouched\n", "644", false, true, "600"),
    );
    check("no temporary file is left beside it", fs.readdirSync(path.dirname(file)), [
      "config.json",
    ]);
  });

  {
    // an earlier login put K1 in the store; the store cannot take K2, so K2 goes to the file
    const entries = new Map<string, string>([[`tm|${URL_B}`, "tmk_" + "1".repeat(40)]]);
    const no_set = {
      get: async (o: any) => entries.get(`${o.service}|${o.name}`) ?? null,
      set: async () => {
        throw coded("ERR_SECRETS_PLATFORM_ERROR", "no bus");
      },
      delete: async (o: any) => entries.delete(`${o.service}|${o.name}`),
    };
    await run_case("a file save clears the older store entry", undefined, no_set, async () => {
      await save_config({ url: URL_B, key: KEY });
      check(
        "the older key is gone from the store; the newer login is the one used",
        tup([...entries.keys()], (await load_config()).key),
        tup([], KEY),
      );
    });
    entries.set(`tm|${URL_B}`, "tmk_" + "1".repeat(40));
    const unreachable = {
      ...no_set,
      delete: async () => {
        throw coded("ERR_SECRETS_PLATFORM_ERROR", "no bus");
      },
    };
    await run_case(
      "the older entry cannot be cleared",
      undefined,
      unreachable,
      async ({ stderr }) => {
        await save_config({ url: URL_B, key: KEY });
        const warn = stderr()
          .split("\n")
          .filter((l) => l.startsWith("tm: warning:"));
        check(
          "one warning line names the url and says to log in again",
          tup(warn.length, warn[0]?.includes(URL_B), warn[0]?.includes("run tm login again")),
          tup(1, true, true),
        );
      },
    );
  }

  await run_case("a failed save leaves no temporary file", "file", undefined, async ({ file }) => {
    fs.mkdirSync(path.join(file, "occupied"), { recursive: true }); // rename onto a full directory fails
    const got = await save_config({ url: URL_B, key: KEY }).then(
      () => "saved",
      () => "refused",
    );
    check(
      "save refused, nothing holding the key left beside the config",
      tup(got, fs.readdirSync(path.dirname(file))),
      tup("refused", ["config.json"]),
    );
  });

  await run_case("no Bun", undefined, undefined, async ({ file, stderr }) => {
    const r = await save_config({ url: URL_B, key: KEY });
    check("save_config returns store file", r, { file, store: "file" });
    check("the file holds the key", read(file)?.key === KEY, true);
    check("stderr notes the fallback", stderr().includes("no credential store is available"), true);
  });

  await run_case("saved login, strict and not", "file", undefined, async ({ file }) => {
    check("no file → null", await saved_login(true), null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: URL_B }));
    check("url only → empty key", await saved_login(false), { url: URL_B, key: "" });
    fs.writeFileSync(file, `{"url":"${URL_B}","key":ZQXsecret}`);
    check("malformed, not strict → null", await saved_login(false), null);
    check("malformed, not strict → file kept", fs.existsSync(file), true);
    const msg = await refusal(saved_login(true));
    check(
      "malformed, strict → load_config's wording, never the parser's",
      tup(msg, msg.includes("ZQXsecret")),
      tup(`${file} is not valid JSON; run \`tm login\` again`, false),
    );
    check("malformed, strict → file removed", fs.existsSync(file), false);
  });

  console.log("\n── under Node ──");
  {
    const found = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
    const version = found.success ? found.stdout.toString().trim() : "";
    const ok = found.success && Bun.semver.satisfies(version.replace(/^v/, ""), ">=22.18.0");
    check(`node 22.18.0 or later is on PATH (found ${version || "no node"})`, ok, true);
    if (ok) {
      const out = path.join(S, "node", "api.mjs");
      const built = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--target=node",
          path.join(REPO_ROOT, "clients/tm/src/api.ts"),
          "--outfile",
          out,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      check(
        "bun build --target=node api.ts",
        tup(built.exitCode, built.stderr.toString()),
        tup(0, ""),
      );
      const xdg = fs.mkdtempSync(path.join(S, "xdg-node-"));
      const { TM_CREDENTIAL_STORE, ...env } = process.env;
      const ran = Bun.spawnSync(
        [
          "node",
          "-e",
          "import(process.env.API_MJS).then(async (m) => console.log(JSON.stringify(await m.save_config({ url: process.env.U, key: process.env.K }))))",
        ],
        {
          env: { ...env, XDG_CONFIG_HOME: xdg, API_MJS: out, U: URL_B, K: KEY },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      let printed: any = null;
      try {
        printed = JSON.parse(ran.stdout.toString());
      } catch {}
      const file = path.join(xdg, "tm", "config.json");
      check(
        "node run exits 0",
        tup(ran.exitCode, ran.stderr.toString().includes(KEY)),
        tup(0, false),
      );
      check("prints store file", printed?.store ?? ran.stderr.toString(), "file");
      check("the file holds the key", read(file), { url: URL_B, key: KEY });
    }
  }
} finally {
  backend.secrets = real_secrets;
  fs.rmSync(S, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("✅ all tm credential store proofs passed");
  process.exit(0);
}

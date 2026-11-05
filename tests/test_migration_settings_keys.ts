#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_migration_settings_keys.ts: the derivation of hook-owned settings
 * keys from onBootstrap hooks, and the shapes it does and does not call a re-assertion
 * (synthetic hook/migration dirs plus one assertion against this repo's real pb_hooks/).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as csk from "../scripts/check_migration_settings_keys.ts";
import { py_repr } from "../scripts/_py.ts";

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

function write_dir(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), body, "utf-8");
  }
  return root;
}

console.log("════════ test_migration_settings_keys.ts — settings-key gate unit pins ════════");

console.log("\n── (a) derivation: only onBootstrap hooks, only real writes ──");
const hooks = write_dir("pb-settings-keys-hooks-", {
  "mail.pb.js":
    'onBootstrap((e) => {\n  settings.smtp.password = key;\n  settings.meta.appName = "x";\n});\n',
  "oauth.pb.js":
    "onBootstrap((e) => {\n  unmarshal({ oauth2: { enabled: true }, rubbish: 1 }, col);\n});\n",
  "commented.pb.js":
    "onBootstrap((e) => {\n  // settings.ghost.key = 1;\n  /* settings.phantom.key = 2; */\n});\n",
  "request_only.pb.js": "onRecordCreateRequest((e) => {\n  settings.notboot.key = 1;\n});\n",
  "notes.md": "settings.markdown.key = 1;\n",
});
const owned = csk.hook_owned_keys(hooks);
check("a settings.<key> assignment in a boot hook is owned", owned.has("smtp"), true);
check("a second key in the same boot hook is owned too", owned.has("meta"), true);
check("an unmarshal() top-level key is owned", owned.has("oauth2"), true);
check("EVERY unmarshal top-level key, not just the first", owned.has("rubbish"), true);
check("a key named only in a // comment is not owned", owned.has("ghost"), false);
check("a key named only in a /* */ comment is not owned", owned.has("phantom"), false);
check("a settings write from a NON-boot hook is not owned", owned.has("notboot"), false);
check("a non-.js file is not read at all", owned.has("markdown"), false);
check("ownership names the hook file", owned.get("smtp"), new Set(["mail.pb.js"]));

console.log("\n── (b) detection: the shapes a migration re-asserting a block actually takes ──");
const keys = new Map([
  ["oauth2", new Set(["oauth.pb.js"])],
  ["smtp", new Set(["mail.pb.js"])],
]);
const migrations = write_dir("pb-settings-keys-mig-", {
  "0001_json_key.js": 'const c = {\n  "name": "users",\n  "oauth2": { "enabled": false }\n};\n',
  "0002_bare_key.js": "unmarshal({\n  oauth2: {\n    enabled: false\n  }\n}, col);\n",
  "0003_settings_write.js":
    "migrate((app) => {\n  const s = app.settings();\n  settings.smtp.enabled = true;\n});\n",
  "0004_comment_only.js":
    "// The oauth2 block is stripped on purpose; settings.smtp too.\n/* oauth2: { enabled: false } */\nmigrate(() => {});\n",
  "0005_escaped_prose.js":
    'const records = [\n  { "body": "PocketBase emits \\"oauth2\\": { enabled } on regeneration; see settings.smtp." },\n];\n',
  "0006_similar_name.js": 'const c = { "oauth2x": 1, "presmtp": 2, "a.oauth2": 3 };\n',
});
const hits = csk.offenders(migrations, keys);
const by_file = new Map<string, Set<string>>();
for (const [name, _line, key, _text] of hits) {
  if (!by_file.has(name)) by_file.set(name, new Set());
  by_file.get(name)!.add(key);
}
check("a quoted JSON object key is a hit", by_file.get("0001_json_key.js"), new Set(["oauth2"]));
check(
  "a bare JS object key opening a block is a hit",
  by_file.get("0002_bare_key.js"),
  new Set(["oauth2"]),
);
check(
  "a direct settings.<key> write is a hit",
  by_file.get("0003_settings_write.js"),
  new Set(["smtp"]),
);
check("prose in a COMMENT is not a hit", by_file.get("0004_comment_only.js"), undefined);
check(
  "an ESCAPED quote inside a string body is not a hit",
  by_file.get("0005_escaped_prose.js"),
  undefined,
);
check(
  "a key that is only a substring of another name is not a hit",
  by_file.get("0006_similar_name.js"),
  undefined,
);
check(
  "a hit carries a 1-based line number",
  hits.filter((h) => h[0] === "0001_json_key.js").map((h) => h[1]),
  [3],
);

console.log("\n── (c) against this repo's own pb_hooks/: the derivation is not empty ──");
const real = csk.hook_owned_keys(path.join(REPO_ROOT, "pb_hooks"));
check("derives the oauth2 family the stripped snapshot block belongs to", real.has("oauth2"), true);
check("derives the smtp family", real.has("smtp"), true);
check("derives the backups family", real.has("backups"), true);
check("derives the file-storage s3 family AGENTS.md does not name", real.has("s3"), true);
check(
  "no migration in this tree re-asserts any of them",
  csk.offenders(path.join(REPO_ROOT, "pb_migrations"), real),
  [],
);

console.log();
if (failures) {
  console.log(`❌ ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("✅ PASS — all checks matched");
process.exit(0);

#!/usr/bin/env bun
/**
 * Unit-pin scripts/check_rescope_guards.ts: pin detection across &&/|| shapes, the anchor
 * predicate, allowlist citation + proof enforcement, and the CLI's stale-entry alarm — all on
 * synthetic rules and scratch schema copies (no server, no DB, real schema/ never written).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { by_code_point, py_repr, read_text } from "../scripts/_py.ts";
import * as rescope from "../scripts/check_rescope_guards.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const CHECKER = path.join(REPO_ROOT, "scripts", "check_rescope_guards.ts");

const GUARD = '@request.auth.id != ""';
const GRANT = "workspace.owner = @request.auth.id";
const PIN = "@request.body.workspace:isset = false";

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

const sorted = (xs: Iterable<string>): string[] => [...xs].sort(by_code_point);

/** A full schema/ + model/current/ copy; caller removes the returned root. */
function scratch_tree(): [string, string, string] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-rescope-checker-"));
  fs.cpSync(path.join(REPO_ROOT, "schema"), path.join(root, "schema"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "scripts", "model", "current"), path.join(root, "current"), {
    recursive: true,
  });
  return [root, path.join(root, "schema"), path.join(root, "current")];
}

/** A scratch tree with one collection's updateRule replaced. */
function scratch_schema(collection: string, update_rule: string): [string, string, string] {
  const [root, dst, model] = scratch_tree();
  const file = path.join(dst, `${collection}.rules.json`);
  const data = JSON.parse(read_text(file));
  data.updateRule = update_rule;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return [root, dst, model];
}

function run_cli(...args: string[]): [number, string] {
  const proc = Bun.spawnSync([process.execPath, CHECKER, ...args]);
  return [proc.exitCode ?? 1, proc.stdout.toString() + proc.stderr.toString()];
}

console.log("════════ test_rescope_guard_checker.ts — rescope-guard checker unit pins ════════");

console.log("\n── (a) find_pin: a top-level && pin binds the whole rule ──");
check(
  "guard && grant && isset-pin → pinned",
  rescope.find_pin(`${GUARD} && (${GRANT}) && ${PIN}`, "workspace"),
  PIN,
);
check(
  "the pin binds even when it sits before the grant",
  rescope.find_pin(`${GUARD} && ${PIN} && (${GRANT})`, "workspace"),
  PIN,
);
check(
  "a pin on ANOTHER field does not pin this one",
  rescope.find_pin(`${GUARD} && (${GRANT}) && @request.body.owner:isset = false`, "workspace"),
  null,
);

console.log(
  "\n── (b) find_pin: a pin inside ONE disjunct binds only that disjunct (#561 shape) ──",
);
const short_circuit = `(${GRANT} && ${PIN}) || assignee = @request.auth.id`;
check(
  "one disjunct pinned, the other grants freely → NOT pinned",
  rescope.find_pin(short_circuit, "workspace"),
  null,
);
check(
  "every disjunct pinned → pinned",
  rescope.find_pin(`(${GRANT} && ${PIN}) || (assignee = @request.auth.id && ${PIN})`, "workspace"),
  `${PIN} || ${PIN}`,
);
check(
  "a && pin outside the || binds every disjunct",
  rescope.find_pin(`(${short_circuit}) && ${PIN}`, "workspace"),
  PIN,
);

console.log("\n── (c) find_pin: the three accepted pin forms, and what is not a pin ──");
check(
  "`@request.body.f = f` (unchanged-value pin)",
  rescope.find_pin(`${GUARD} && @request.body.workspace = workspace`, "workspace"),
  "@request.body.workspace = workspace",
);
check(
  "`@request.body.f = @request.auth.id` (self pin)",
  rescope.find_pin(`${GUARD} && @request.body.user = @request.auth.id`, "user"),
  "@request.body.user = @request.auth.id",
);
check("no pin at all → None", rescope.find_pin(`${GUARD} && (${GRANT})`, "workspace"), null);
check(
  "`:isset = true` is not a pin — it demands the field, it does not constrain it",
  rescope.find_pin(`${GUARD} && @request.body.workspace:isset = true`, "workspace"),
  null,
);
check(
  "`!=` on the body is not a pin",
  rescope.find_pin(`${GUARD} && @request.body.workspace != ""`, "workspace"),
  null,
);
check(
  "a grant naming the field is not a pin (it says WHO, not WHICH value)",
  rescope.find_pin(`${GUARD} && workspace.owner = @request.auth.id`, "workspace"),
  null,
);

console.log("\n── (d) the anchor predicate is name AND target, both from schema/ ──");
check("anchor names", sorted(rescope.ANCHOR_FIELDS), ["owner", "project", "user", "workspace"]);
check("anchor targets", sorted(rescope.ANCHOR_TARGETS), ["projects", "users", "workspaces"]);
const [unpinned, covered, not_analyzed] = rescope.analyze(path.join(REPO_ROOT, "schema"));
const by_key = new Map(covered.map((c) => [JSON.stringify([c.collection, c.field]), c.why]));
check(
  "workspaces.default_project → excluded on NAME (targets projects)",
  by_key.get(JSON.stringify(["workspaces", "default_project"])),
  "not a tenant-anchor NAME (targets `projects`)",
);
check(
  "comments.parent → excluded on NAME (targets comments)",
  by_key.get(JSON.stringify(["comments", "parent"])),
  "not a tenant-anchor NAME (targets `comments`)",
);
check(
  "workspaces.owner → anchor, pinned by rule",
  by_key.get(JSON.stringify(["workspaces", "owner"])),
  "pinned by `@request.body.owner:isset = false`",
);
const unpinned_keys = new Set(unpinned.map((u) => JSON.stringify([u.collection, u.field])));
check(
  "every relation on an analyzed collection is accounted for",
  sorted([...by_key.keys()].filter((k) => unpinned_keys.has(k))),
  [],
);
check(
  "null-updateRule collections are reported as NOT analyzed, never silently dropped",
  sorted(not_analyzed.map((line) => line.split(" — ")[0]!)),
  [
    "app_docs",
    "app_settings",
    "invitation_events",
    "task_activity",
    "task_subscribers",
    "workspace_invitations",
  ],
);

console.log("\n── (e) allowlist entries must carry a citation and a resolving proof ──");
check(
  "a reason with no card/decision token is refused",
  (rescope.check_allowlist_proof({ why: "this one is fine, trust me" }) || "").startsWith(
    "reason cites no card/decision",
  ),
  true,
);
check(
  "PBTT-nnn satisfies the citation rule",
  rescope.check_allowlist_proof({ why: "PBTT-326 ruling: not a tenant edge" }),
  null,
);
check(
  "a decision:<slug> satisfies it",
  rescope.check_allowlist_proof({ why: "ruled in decision:workspace-tenancy: not a tenant edge" }),
  null,
);
check(
  "a bare decision: with no slug does not",
  (rescope.check_allowlist_proof({ why: "ruled in decision: above" }) || "").startsWith(
    "reason cites no card/decision",
  ),
  true,
);
check(
  "a 4-char kata ref satisfies it",
  rescope.check_allowlist_proof({ why: "ruled on card 9fkw: not a tenant edge" }),
  null,
);
check(
  "an empty reason is refused",
  rescope.check_allowlist_proof({ why: "   " }),
  "reason is empty",
);
check(
  "verify pointing at a missing file is refused",
  rescope.check_allowlist_proof({
    why: "PBTT-326",
    verify: "tests/test_nope.py",
    verify_grep: ["x"],
  }),
  "cited test file missing: tests/test_nope.py",
);
check(
  "verify with no verify_grep is refused",
  rescope.check_allowlist_proof({ why: "PBTT-326", verify: "tests/test_scope.ts" }),
  "verify: tests/test_scope.ts with no verify_grep — the file merely existing proves nothing",
);
check(
  "an empty verify_grep literal is refused",
  rescope.check_allowlist_proof({
    why: "PBTT-326",
    verify: "tests/test_scope.ts",
    verify_grep: ["  "],
  }),
  "verify_grep literal is empty — it would match any file",
);
check(
  "a verify_grep literal absent from the cited file is refused",
  rescope.check_allowlist_proof({
    why: "PBTT-326",
    verify: "tests/test_scope.ts",
    verify_grep: ["no such assertion"],
  }),
  "verify_grep 'no such assertion' not found in tests/test_scope.ts",
);
check(
  "every SHIPPED allowlist entry passes its own proof",
  Object.fromEntries(
    [...rescope.ALLOWLIST]
      .filter(([, e]) => rescope.check_allowlist_proof(e))
      .map(([k, e]) => [(JSON.parse(k) as string[]).join("."), rescope.check_allowlist_proof(e)]),
  ),
  {},
);

console.log("\n── (f) CLI: shipped tree green, --no-allowlist red, planted hole red ──");
let [rc, out] = run_cli();
check("shipped configuration exits 0", rc, 0);
check("...and says so", out.includes("✅ check_rescope_guards:"), true);
[rc, out] = run_cli("--no-allowlist");
check("--no-allowlist exits 1", rc, 1);
check(
  "--no-allowlist names projects.workspace (card 9fkw)",
  out.includes("❌ projects.workspace is repointable on update"),
  true,
);
check("--no-allowlist reports 13 findings", out.includes("13 tenant-anchor finding(s)"), true);

let [root, dst, model] = scratch_schema("statuses", `${GUARD} && (${GRANT})`);
try {
  [rc, out] = run_cli("--schema-dir", dst, "--model-dir", model, "--json");
  const report = JSON.parse(out);
  check("a planted unguarded workspace relation exits 1", rc, 1);
  check(
    "...naming collection + field",
    report.findings.map((f: any) => [f.collection, f.field]),
    [["statuses", "workspace"]],
  );
  check("...and reports ok: false", report.ok, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
check("scratch schema copy cleaned up", fs.existsSync(root), false);

console.log("\n── (g) CLI: an allowlist entry that is no longer a finding fails the gate ──");
[root, dst, model] = scratch_schema(
  "labels",
  `${GUARD} && (${GRANT}) && ${PIN} && @request.body.project:isset = false`,
);
try {
  [rc, out] = run_cli("--schema-dir", dst, "--model-dir", model);
  check("pinning an allowlisted field turns the entry stale → exit 1", rc, 1);
  check(
    "...and the gate names the stale entry",
    out.includes("❌ allowlist entry labels.project: no longer a finding"),
    true,
  );
  check("...with no finding of its own", out.includes("0 tenant-anchor finding(s)"), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
check("scratch schema copy cleaned up", fs.existsSync(root), false);

console.log("\n── (h) a tenant pointer renamed off the anchor list is still a finding ──");
check("the tenant root the target-only rule covers", rescope.TENANT_ROOT, "workspaces");
check(
  "no shipped relation targets `workspaces` under an unrecognized name",
  covered
    .filter((c) => c.why.endsWith("(targets `workspaces`)"))
    .map((c) => `${c.collection}.${c.field}`),
  [],
);
[root, dst, model] = scratch_tree();
try {
  let file = path.join(dst, "cycles.json");
  let doc = JSON.parse(read_text(file));
  for (const fld of doc.fields) if (fld.name === "workspace") fld.name = "tenant";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  file = path.join(dst, "cycles.rules.json");
  doc = JSON.parse(read_text(file));
  doc.updateRule = doc.updateRule.replaceAll(` && ${PIN}`, "");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  file = path.join(model, "cycles.yml");
  const text = read_text(file);
  fs.writeFileSync(file, text.replaceAll("field: workspace", "field: tenant"));

  [rc, out] = run_cli("--schema-dir", dst, "--model-dir", model, "--json");
  const report = JSON.parse(out);
  check("renaming workspace -> tenant and dropping the pin exits 1", rc, 1);
  check(
    "...as an unrecognized-tenant-pointer finding, not a silent coverage line",
    report.findings.map((f: any) => [f.collection, f.field, f.kind]),
    [["cycles", "tenant", "unrecognized-tenant-pointer"]],
  );
  check(
    "...and it never lands in coverage",
    report.coverage.filter((c: any) => c.collection === "cycles"),
    [],
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
check("scratch tree cleaned up", fs.existsSync(root), false);

console.log("\n── (i) CLI: a setup error exits 2, distinct from a finding ──");
[root, dst, model] = scratch_tree();
fs.rmSync(path.join(dst, "statuses.json"));
try {
  [rc, out] = run_cli("--schema-dir", dst, "--model-dir", model);
  check("rules with no field list to resolve against exits 2, not 1", rc, 2);
  check(
    "...and names the missing artifact",
    out.includes("schema/statuses.rules.json has no schema/statuses.json"),
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

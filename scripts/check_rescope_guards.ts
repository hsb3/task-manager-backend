#!/usr/bin/env bun
/**
 * CI / pre-commit check: fail an updateRule that leaves a tenant-anchor relation repointable.
 *
 * Reads the generated `schema/` + `scripts/model/current/` only — no server, no DB. A relation
 * whose incoming value the updateRule never constrains can be re-pointed by any caller the rule
 * already lets through, which moves the record into another tenant; that is the bug class this
 * gate closes. Parsing primitives and the schema graph are imported from
 * `scripts/check_rule_auth_guards.ts` rather than restated.
 */

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  glob_sorted,
  json_dumps,
  os_error_text,
  print,
  py_repr,
  py_strip,
  read_text,
} from "./_py.ts";
import {
  MODEL_DIR,
  REPO,
  SCHEMA_DIR,
  StaleModelError,
  get_or,
  load_graph,
  split_comparison,
  split_top_level,
  strip_outer_parens,
} from "./check_rule_auth_guards.ts";

// D4/W4 (content chain), PBTT-326 (membership/settings) and PBTT-427 (taxonomy/tooling) each
// found holes here; a field counts as a tenant anchor only when its NAME is in this set AND
// schema/ resolves its relation target into ANCHOR_TARGETS.
export const ANCHOR_FIELDS = ["workspace", "owner", "user", "project"];
export const ANCHOR_TARGETS = ["workspaces", "projects", "users"];
// Bound kept deliberately narrow: only a `workspaces` pointer is flagged on its target alone.
// A `projects`/`users` target is not — `default_project` and the attribution relations
// (author, assignee, actor, trashed_by) would each need an exception to no benefit.
export const TENANT_ROOT = "workspaces";

export const EQ_OPS = ["=", "?="];

// An allowlist reason without one of these is unreviewable prose, so the gate refuses it.
// `D<n>` is a decision id in the v006 design record.
export const CITATION_RE =
  /PBTT-\p{Nd}+|TASK-\p{Nd}+|decision-\p{Nd}+|decision:[a-z0-9]+(?:[-_][a-z0-9]+)*(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])D\p{Nd}+(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])card [0-9a-z]{4}(?![\p{L}\p{N}_])/u;

export type AllowEntry = Record<string, unknown>;

// [collection, field] -> why the finding is not a hole. `verify`/`verify_grep` are
// required whenever the reason claims a HOOK closes it, and must resolve to a live assertion.
export const ALLOWLIST = new Map<string, AllowEntry>([
  [
    JSON.stringify(["decisions", "workspace"]),
    {
      why:
        "D4 (W4, #67) — the workspace anchor is frozen at the HOOK tier instead of in " +
        "rule text (pb_hooks/scope.pb.js, `WORKSPACE immutability (D4) on update`), proven " +
        "live by a rejected repoint",
      verify: "tests/test_rescope_guard.ts",
      verify_grep: ['[a_dec, "workspace", BWS, alice, "owner Alice"],'],
    },
  ],
  [
    JSON.stringify(["documents", "workspace"]),
    {
      why:
        "D4 (W4, #67) — the workspace anchor is frozen at the HOOK tier instead of in " +
        "rule text (pb_hooks/scope.pb.js, `WORKSPACE immutability (D4) on update`), proven " +
        "live by a rejected repoint",
      verify: "tests/test_rescope_guard.ts",
      verify_grep: ['[a_doc, "workspace", BWS, alice, "owner Alice"],'],
    },
  ],
  [
    JSON.stringify(["milestones", "workspace"]),
    {
      why:
        "D4 (W4, #67) — the workspace anchor is frozen at the HOOK tier instead of in " +
        "rule text (pb_hooks/scope.pb.js, `WORKSPACE immutability (D4) on update`), proven " +
        "live by a rejected repoint",
      verify: "tests/test_rescope_guard.ts",
      verify_grep: ['[a_mile, "workspace", BWS, alice, "owner Alice"],'],
    },
  ],
  [
    JSON.stringify(["tasks", "workspace"]),
    {
      why:
        "D4 (W4, #67) — the workspace anchor is frozen at the HOOK tier instead of in " +
        "rule text (pb_hooks/scope.pb.js, `WORKSPACE immutability (D4) on update`), proven " +
        "live by a rejected repoint",
      verify: "tests/test_rescope_guard.ts",
      verify_grep: ['[a_task, "workspace", BWS, alice, "owner Alice"],'],
    },
  ],
  [
    JSON.stringify(["projects", "workspace"]),
    {
      why:
        "D4 + TASK-071 — a project does not move between workspaces; the anchor is " +
        "frozen at the HOOK tier instead of in rule text (pb_hooks/scope.pb.js, the fifth " +
        "`WORKSPACE immutability (D4)` block), refused for a workspace admin and exempt only " +
        "for a superuser",
      verify: "tests/test_scope.ts",
      verify_grep: [
        "S12: workspace admin patches projects.workspace → 400 (projects-workspace-immutable)",
        "S11: su rescopes the project to ws-B → 200 (superuser exemption, TASK-071)",
      ],
    },
  ],
  [
    JSON.stringify(["saved_views", "owner"]),
    {
      why:
        "PBTT-427 ruling (tests/test_rescope_guard.ts ALLOWLIST): the view's creator is a " +
        "within-workspace attribution, not a tenant-anchor edge — saved_views.workspace is " +
        "rule-pinned, so a repointed view stays inside its own tenant",
    },
  ],
  [
    JSON.stringify(["tasks", "project"]),
    {
      why:
        "D4 (W4, #67) — moving an item between projects of the SAME workspace is a " +
        "product feature; the cross-workspace repoint is refused by the W4 dual-scope hook " +
        "(pb_hooks/scope.pb.js). Classification recorded in tests/test_rescope_guard.ts " +
        "ALLOWLIST",
      verify: "tests/test_scope.ts",
      verify_grep: [
        ": update project to a ws-B project → 400 (project-must-belong-to-workspace)",
        'for (const col of ["tasks", "decisions", "documents", "milestones"]) {',
      ],
    },
  ],
  [
    JSON.stringify(["decisions", "project"]),
    {
      why:
        "D4 (W4, #67) — moving an item between projects of the SAME workspace is a " +
        "product feature; the cross-workspace repoint is refused by the W4 dual-scope hook " +
        "(pb_hooks/scope.pb.js). Classification recorded in tests/test_rescope_guard.ts " +
        "ALLOWLIST",
      verify: "tests/test_scope.ts",
      verify_grep: [
        ": update project to a ws-B project → 400 (project-must-belong-to-workspace)",
        'for (const col of ["tasks", "decisions", "documents", "milestones"]) {',
      ],
    },
  ],
  [
    JSON.stringify(["documents", "project"]),
    {
      why:
        "D4 (W4, #67) — moving an item between projects of the SAME workspace is a " +
        "product feature; the cross-workspace repoint is refused by the W4 dual-scope hook " +
        "(pb_hooks/scope.pb.js). Classification recorded in tests/test_rescope_guard.ts " +
        "ALLOWLIST",
      verify: "tests/test_scope.ts",
      verify_grep: [
        ": update project to a ws-B project → 400 (project-must-belong-to-workspace)",
        'for (const col of ["tasks", "decisions", "documents", "milestones"]) {',
      ],
    },
  ],
  [
    JSON.stringify(["milestones", "project"]),
    {
      why:
        "D4 (W4, #67) — moving an item between projects of the SAME workspace is a " +
        "product feature; the cross-workspace repoint is refused by the W4 dual-scope hook " +
        "(pb_hooks/scope.pb.js). Classification recorded in tests/test_rescope_guard.ts " +
        "ALLOWLIST",
      verify: "tests/test_scope.ts",
      verify_grep: [
        ": update project to a ws-B project → 400 (project-must-belong-to-workspace)",
        'for (const col of ["tasks", "decisions", "documents", "milestones"]) {',
      ],
    },
  ],
  [
    JSON.stringify(["labels", "project"]),
    {
      why:
        "PBTT-427 (classification) + W4 #67 G1 — within-workspace label scoping is a " +
        "product feature; the cross-workspace repoint is refused by the label-project-" +
        "workspace-match hook in pb_hooks/scope.pb.js",
      verify: "tests/test_labels.ts",
      verify_grep: ["PATCH label.project to a DIFFERENT workspace's project → 400"],
    },
  ],
  [
    JSON.stringify(["templates", "project"]),
    {
      why:
        "PBTT-427 (classification) + W4 #67 G3 — within-workspace template scoping is a " +
        "product feature; the cross-workspace repoint is refused by the template-project-" +
        "workspace-match hook in pb_hooks/scope.pb.js",
      verify: "tests/test_templates.ts",
      verify_grep: ["PATCH template.project to a DIFFERENT workspace's project → 400"],
    },
  ],
  [
    JSON.stringify(["saved_views", "project"]),
    {
      why:
        "PBTT-429 — within-workspace view scoping is a product feature; the " +
        "cross-workspace repoint is refused by the view-project-workspace-match hook " +
        "(pb_hooks/scope.pb.js, `PBTT-429 — a saved view's optional project filter must live " +
        "in the view's workspace`)",
      verify: "tests/test_saved_views.ts",
      verify_grep: ["ws-owner PATCHes project to a FOREIGN-workspace project → 400"],
    },
  ],
]);

/** True when `atom` constrains the INCOMING value of `field` (not who the caller is). */
export function is_pin(atom: string, field: string): boolean {
  const parts = split_comparison(strip_outer_parens(atom));
  if (parts === null) return false;
  const [left, op, right] = parts;
  if (!EQ_OPS.includes(op)) return false;
  const body = `@request.body.${field}`;
  for (const [a, b] of [
    [left, right],
    [right, left],
  ]) {
    if (a === `${body}:isset` && b === "false") return true;
    if (a === body && (b === field || b === "@request.auth.id")) return true;
  }
  return false;
}

/** The pinning atom, or null. A `&&` pin binds every disjunct; a `||` one binds only its own. */
export function find_pin(expr: string, field: string): string | null {
  expr = strip_outer_parens(expr);
  const disjuncts = split_top_level(expr, "||");
  if (disjuncts.length > 1) {
    const pins = disjuncts.map((d) => find_pin(d, field));
    return pins.every((p) => p) ? pins.filter((p) => p).join(" || ") : null;
  }
  const conjuncts = split_top_level(expr, "&&");
  if (conjuncts.length > 1) {
    for (const part of conjuncts) {
      const pin = find_pin(part, field);
      if (pin) return pin;
    }
    return null;
  }
  return is_pin(expr, field) ? expr : null;
}

/** Reason the entry's own claim does not hold up, or null. */
export function check_allowlist_proof(entry: AllowEntry): string | null {
  const why = String(entry.why || "");
  if (!py_strip(why)) return "reason is empty";
  if (!CITATION_RE.test(why)) {
    return (
      "reason cites no card/decision (need PBTT-n, TASK-n, decision-n, decision:<slug> or `card abcd`): " +
      py_repr(why)
    );
  }
  const verify = entry.verify;
  let greps: unknown = entry.verify_grep || [];
  if (typeof greps === "string") greps = [greps];
  const grep_list = greps as unknown[];
  if (!verify) return grep_list.length ? "verify_grep without verify" : null;
  const file = path.join(REPO, String(verify));
  if (!fs.existsSync(file)) return `cited test file missing: ${verify}`;
  if (!grep_list.length) {
    return `verify: ${verify} with no verify_grep — the file merely existing proves nothing`;
  }
  const text = read_text(file, "replace");
  for (const pattern of grep_list) {
    if (!py_strip(String(pattern))) return "verify_grep literal is empty — it would match any file";
    if (!text.includes(String(pattern))) {
      return `verify_grep ${py_repr(pattern)} not found in ${verify}`;
    }
  }
  return null;
}

/** collection -> updateRule, for base collections only (views have no write surface). */
export function load_update_rules(schema_dir: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const file of glob_sorted(schema_dir, ".rules.json")) {
    const name = path.basename(file).slice(0, -".rules.json".length);
    out.set(name, get_or(JSON.parse(read_text(file)), "updateRule"));
  }
  return out;
}

/** -> [findings, every other relation with its exclusion reason, not_analyzed collections]. */
export function analyze(
  schema_dir: string,
  model_dir: string = MODEL_DIR,
): [Record<string, any>[], Record<string, any>[], string[]] {
  const graph = load_graph(schema_dir, model_dir);
  const rules = load_update_rules(schema_dir);
  const flagged: Record<string, any>[] = [];
  const covered: Record<string, any>[] = [];
  const not_analyzed: string[] = [];

  for (const collection of [...rules.keys()].sort(by_code_point)) {
    const rule = rules.get(collection)!;
    const fields = graph.collections.get(collection);
    if (fields === undefined) {
      throw new StaleModelError(
        `schema/${collection}.rules.json has no schema/${collection}.json to ` +
          "resolve fields against",
      );
    }
    const relations = [...fields.values()]
      .filter((f) => f.type === "relation")
      .sort((a, b) => by_code_point(a.name, b.name));
    if (rule === null) {
      not_analyzed.push(
        `${collection} — updateRule is null (superuser-only), ` +
          `${relations.length} relation(s) unreachable by any caller`,
      );
      continue;
    }
    for (const spec of relations) {
      if (!ANCHOR_FIELDS.includes(spec.name)) {
        if (spec.target === TENANT_ROOT) {
          flagged.push({
            collection,
            field: spec.name,
            kind: "unrecognized-tenant-pointer",
            rule,
          });
          continue;
        }
        covered.push({
          collection,
          field: spec.name,
          why: `not a tenant-anchor NAME (targets \`${spec.target ?? "None"}\`)`,
        });
        continue;
      }
      if (!ANCHOR_TARGETS.includes(spec.target as string)) {
        covered.push({
          collection,
          field: spec.name,
          why: `anchor name but targets \`${spec.target ?? "None"}\`, not a tenant root`,
        });
        continue;
      }
      const pin = find_pin(rule, spec.name);
      if (pin) {
        covered.push({ collection, field: spec.name, why: `pinned by \`${pin}\`` });
        continue;
      }
      flagged.push({ collection, field: spec.name, kind: "unpinned-anchor", rule });
    }
  }
  return [flagged, covered, not_analyzed];
}

export function main(): number {
  const prog = path.basename(process.argv[1] ?? "");
  const pad = " ".repeat(`usage: ${prog} `.length);
  const usage =
    `usage: ${prog} [-h] [--schema-dir SCHEMA_DIR]\n` +
    `${pad}[--model-dir MODEL_DIR] [--no-allowlist]\n${pad}[--json]`;
  const args = parse_args(
    usage,
    `${usage}

Fail an updateRule that leaves a tenant-anchor relation repointable.

options:
  -h, --help            show this help message and exit
  --schema-dir SCHEMA_DIR
                        default: repo schema/
  --model-dir MODEL_DIR
                        default: repo scripts/model/current/
  --no-allowlist        report every finding, ignoring ALLOWLIST
  --json                machine-readable report

SCOPE BOUNDS: base collections only, updateRule only — createRule mass-
assignment and view collections (no write surface) are out of scope. A null
updateRule is superuser-only and never analyzed. A field is a tenant anchor
when its NAME is one of ${ANCHOR_FIELDS.join("/")} AND schema/ resolves its
target into ${ANCHOR_TARGETS.join("/")}; every other relation is listed under
coverage with the reason it was excluded. One rule runs on TARGET alone, so a
rename cannot escape the gate: a relation targeting \`${TENANT_ROOT}\` under a name
outside ${ANCHOR_FIELDS.join("/")} is a finding in its own right. That bound
stops there — a projects/users target is NOT flagged on its target alone,
because default_project and the attribution relations would each need an
exception. The gate reads RULE TEXT: a hook-enforced guard is invisible to it
and belongs in ALLOWLIST with a live-assertion citation.
`,
    [
      ["--schema-dir", "store", "schema_dir"],
      ["--model-dir", "store", "model_dir"],
      ["--no-allowlist", "store_true", "no_allowlist"],
      ["--json", "store_true", "json"],
    ],
    { schema_dir: SCHEMA_DIR, model_dir: MODEL_DIR, no_allowlist: false, json: false },
  );

  let flagged: Record<string, any>[];
  let covered: Record<string, any>[];
  let not_analyzed: string[];
  try {
    [flagged, covered, not_analyzed] = analyze(args.schema_dir, args.model_dir);
  } catch (exc) {
    print(
      `❌ check_rescope_guards: ${exc instanceof SyntaxError || exc instanceof StaleModelError ? exc.message : os_error_text(exc)}`,
    );
    return 2;
  }

  const findings: Record<string, any>[] = [];
  const allowed: Record<string, any>[] = [];
  const hit = new Set<string>();
  for (const item of flagged) {
    const key = JSON.stringify([item.collection, item.field]);
    if (!args.no_allowlist && ALLOWLIST.has(key)) {
      hit.add(key);
      allowed.push({ ...item, reason: String(ALLOWLIST.get(key)!.why) });
      continue;
    }
    findings.push(item);
  }

  const stale: Record<string, any>[] = [];
  if (!args.no_allowlist) {
    for (const [key, entry] of ALLOWLIST) {
      const [collection, field] = JSON.parse(key) as [string, string];
      if (!hit.has(key)) {
        stale.push({
          collection,
          field,
          why:
            "no longer a finding (now pinned, renamed to a known anchor, " +
            "or the field / collection is gone) — drop the entry",
        });
        continue;
      }
      const problem = check_allowlist_proof(entry);
      if (problem) stale.push({ collection, field, why: problem });
    }
  }

  if (args.json) {
    print(
      json_dumps(
        {
          ok: !findings.length && !stale.length,
          findings,
          allowlisted: allowed,
          bad_allowlist: stale,
          coverage: covered,
          not_analyzed,
        },
        { indent: 2, ensure_ascii: false },
      ),
    );
    return findings.length || stale.length ? 1 : 0;
  }

  for (const item of findings) {
    if (item.kind === "unrecognized-tenant-pointer") {
      print(
        `❌ ${item.collection}.${item.field} points at \`${TENANT_ROOT}\` under a name ` +
          `the anchor list does not know — rename it to one of ` +
          `${ANCHOR_FIELDS.join("/")} so pin detection applies, or allowlist it`,
      );
    } else {
      print(
        `❌ ${item.collection}.${item.field} is repointable on update — the ` +
          "updateRule never constrains the incoming value",
      );
    }
    print(`     rule:   ${item.rule}`);
  }
  for (const item of stale) {
    print(`❌ allowlist entry ${item.collection}.${item.field}: ${item.why}`);
  }

  print(`allowlisted exceptions (${allowed.length}):`);
  for (const item of allowed) print(`  • ${item.collection}.${item.field} — ${item.reason}`);
  print("coverage:");
  for (const item of covered) print(`  • ${item.collection}.${item.field} — ${item.why}`);
  for (const line of not_analyzed) print(`  • NOT analyzed: ${line}`);
  print(
    "  • out of scope: createRule mass-assignment, view collections, and any guard that " +
      "lives in a hook rather than in rule text",
  );

  if (findings.length || stale.length) {
    print(
      `❌ check_rescope_guards: ${findings.length} tenant-anchor finding(s), ` +
        `${stale.length} bad allowlist entr(ies).`,
    );
    return 1;
  }
  const analyzed = new Set([...flagged, ...covered].map((i) => i.collection));
  print(
    `✅ check_rescope_guards: ${flagged.length + covered.length} relation(s) on ` +
      `${analyzed.size} updatable collection(s) checked, no repointable tenant anchor ` +
      `(${allowed.length} allowlisted).`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

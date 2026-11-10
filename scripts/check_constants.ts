#!/usr/bin/env bun
/**
 * CI / pre-commit check: shared constant lists (pooled-JSVM inline mirrors) must
 * stay in sync across every mirror site. Parses each copy out of the generated schema/
 * and pb_hooks/ source text directly (no server, no DB) and cross-checks
 * docs/constants.md against the canonical map held here, so the human doc and the
 * enforced map can't drift from each other.
 *
 * Every site declares the literal it holds — a `block` regex whose group 1 is that copy's
 * list, and an `each` regex for one value inside it — so an EXTRA value, a reordering, or
 * two copies in ONE file disagreeing are all drift, not a silent pass.
 *
 * A constant whose live values ARE a collection's select vocabulary declares `values_from`
 * instead of `values` and is read out of the generated `schema/` file: the migration that
 * last set that select is historical the moment the next one changes it, so a gate anchored
 * there keeps asserting a vocabulary the collection no longer has.
 *
 * TEMPLATE_DATA_KEYS and PRIORITY_UNSET_TOKEN are the exceptions and deliberately have NO
 * entry in that map: their hook IS the source of truth, so the values are parsed out of the
 * JS at a `KEEP IN SYNC:` anchor and every other copy — a sibling handler's inlined array,
 * docs/constants.md — is asserted against them rather than against a list restated here.
 */

import fs from "node:fs";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  py_join,
  py_lstrip,
  py_repr,
  py_strip,
  read_text,
  splitlines,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";

export const REPO = repo_root(import.meta.path);
export const DOC_RELPATH = path.join("docs", "constants.md");

// Any quoting style a JS/TS/JSON list uses; overridden per site where the copy is a row
// table, an escaped SQL literal or a prose list.
export const EACH_DEFAULT = String.raw`["']([^"']*)["']`;

export type Site = {
  file: string;
  block?: string;
  each?: string;
  marker?: string;
  values?: string[];
  emitters?: Record<string, string[]>;
  note?: string;
};
export type Spec = {
  values?: string[];
  values_from?: { file: string; field: string };
  sites: Site[];
};

const count_nl = (s: string): number => s.split("\n").length - 1;
const print = (s: string): void => {
  process.stdout.write(s + "\n");
};

/** A PocketBase select field's own `values` array, located by the field's name. */
export function _select_field(field: string): string {
  return String.raw`"name":\s*"` + field + String.raw`",[\s\S]*?"values":\s*\[([^\]]*)\]`;
}

/** A generated schema/<collection>.json select field's values, in declared order. */
export function _schema_select_values(text: string, field: string): string[] | null {
  for (const entry of JSON.parse(text).fields ?? []) {
    if (entry.name === field) return [...(entry.values || [])];
  }
  return null;
}

// name -> ordered canonical values -> mirror sites. A site may override "values" with
// a documented SUBSET when that site legitimately mirrors fewer than the full list
// (e.g. a bootstrap seed that intentionally omits one category) — never silently.
// A site's "marker" anchors its "block", and owns the file only up to the NEXT marker in
// it: an unbounded anchor slides past its own copy into a byte-identical sibling's.
export const CONSTANTS: Record<string, Spec> = {
  STATUS_CATEGORIES: {
    values: ["triage", "backlog", "unstarted", "started", "completed", "canceled"],
    sites: [
      // schema/, not the migration that last wrote the select: schema/ is regenerated
      // from pb_migrations/, so a rebuilt or renamed baseline cannot leave this blind.
      {
        file: "schema/statuses.json",
        block: _select_field("category"),
        note: "the live statuses.category vocabulary",
      },
      {
        file: "schema/project_stats.view.json",
        block: String.raw`"viewQuery":\s*"([^"]*)"`,
        each: String.raw`s\.category='([^']*)'`,
        note: "project_stats counts one column per category",
      },
      {
        file: "pb_hooks/main.pb.js",
        marker: "KEEP IN SYNC (provision vocab seed)",
        block: String.raw`const _defStatuses = \[([\s\S]*?)\];`,
        each: String.raw`\["[^"]*",\s*"([^"]*)"`,
        values: ["backlog", "unstarted", "started", "completed", "canceled"],
        note: "workspace-provision seed intentionally omits triage (non-default category)",
      },
      // The two sweep copies are byte-identical apart from $app/e.app, so only the
      // block markers can tell them apart — anchor each site on its own marker.
      {
        file: "pb_hooks/cycles.pb.js",
        marker: "── INLINED SWEEP (cron copy, uses $app) — KEEP IN SYNC with the route copy ──",
        block:
          String.raw`\"workspace = \{:w\} && \(([^\"]*)\)\"` +
          String.raw`[\s\S]*?` +
          "── END INLINED SWEEP " +
          String.raw`\(cron copy\) ` +
          "──",
        each: String.raw`category = '([^']*)'`,
        values: ["completed", "canceled"],
        note:
          "cron sweep's resolved-half predicate — 2 of 6 by design: only the " +
          "resolved categories stay behind when a cycle rolls",
      },
      {
        file: "pb_hooks/cycles.pb.js",
        marker: "── INLINED SWEEP (route copy, uses e.app) — KEEP IN SYNC with the cron copy ──",
        block:
          String.raw`\"workspace = \{:w\} && \(([^\"]*)\)\"` +
          String.raw`[\s\S]*?` +
          "── END INLINED SWEEP " +
          String.raw`\(route copy\) ` +
          "──",
        each: String.raw`category = '([^']*)'`,
        values: ["completed", "canceled"],
        note:
          "route sweep's resolved-half predicate — 2 of 6 by design: only the " +
          "resolved categories stay behind when a cycle rolls",
      },
      // The SQL repeats the resolved half per column, so each copy is counted, not set-compared.
      {
        file: "schema/project_items.view.json",
        block: String.raw`"viewQuery":\s*"([^"]*)"`,
        each: String.raw`(?<=category (?:NOT )?IN \([^)]*|category = )'([^']*)'`,
        values: ["completed", "canceled"],
        emitters: {
          completed: ["status_terminal", "open"],
          canceled: ["status_terminal", "status_off_pipeline", "open"],
        },
        note: "project_items' resolved half: status_terminal, status_off_pipeline, open",
      },
      {
        file: "pb_hooks/counts.pb.js",
        marker: "KEEP IN SYNC (below): subtask done",
        each: String.raw`(?<=category IN \([^)]*)'([^']*)'`,
        values: ["completed", "canceled"],
        note: "project_items enrich hook: subtask_done counts children in a resolved-half status",
      },
      {
        file: "pb_hooks/me.pb.js",
        marker: "KEEP IN SYNC: open items",
        each: String.raw`(?<=category IN \([^)]*)'([^']*)'`,
        values: ["completed", "canceled"],
        note: "me route: open_items leaves out tasks in a resolved-half status",
      },
      {
        file: "pb_hooks/counts.pb.js",
        marker: "KEEP IN SYNC (below): statuses enrich: terminal and off_pipeline",
        each: String.raw`category === "([^"]*)"`,
        values: ["completed", "canceled"],
        emitters: {
          completed: ["terminal"],
          canceled: ["terminal", "off_pipeline"],
        },
        note: "statuses enrich hook: the terminal and off_pipeline flags every status record carries",
      },
    ],
  },
  CORE_LABELS: {
    values: ["Bug", "Feature", "Improvement"],
    sites: [
      // The one-time board seed that held the second copy is folded into the baseline;
      // the provision seed is now the only live copy, checked against the list above
      // and against docs/constants.md.
      {
        file: "pb_hooks/main.pb.js",
        marker: "KEEP IN SYNC (provision vocab seed)",
        block: String.raw`const _coreLabels = \[([\s\S]*?)\];`,
        each: String.raw`\["([^"]*)"`,
      },
    ],
  },
  NOTIFICATION_KINDS: {
    // The live select, not whichever migration last wrote it: that one is historical the
    // moment the next migration changes the vocabulary, and a gate reading it goes blind.
    values_from: { file: "schema/notifications.json", field: "kind" },
    sites: [
      {
        file: "pb_hooks/notify.pb.js",
        block: "NOTIFICATION_KINDS = ([a-z_|]+)",
        each: "([a-z_]+)",
        note: "the hook's header comment is this file's only ordered copy",
      },
      {
        file: "pb_hooks/notify.pb.js",
        each: String.raw`set\("kind",\s*"([^"]*)"\)`,
        // One named entry per LIVE emitter: comparing the set of kinds lets a value
        // with two fan-outs lose one and stay green.
        values: ["assigned", "commented", "status_done", "mentioned"],
        emitters: {
          assigned: ["tasks update — assignee changed"],
          commented: ["comments create — subscriber fan-out"],
          status_done: ["tasks update — status moved into a done category"],
          mentioned: [
            "comments create — @mention fan-out",
            "comments update — @mention fan-out on edit",
            "items create — item-prose @mention fan-out",
            "items update — item-prose @mention fan-out on edit",
          ],
        },
        note:
          "emitted kinds — one live emitter per declared fan-out, in hook order; " +
          "the fan-out half of the vocabulary, ownership_transferred excluded. " +
          "Both `mentioned` edit emitters are deduped against the rows already " +
          "sent — per (comment, user) on a comment, per (item, user) on item " +
          "prose — so an edit reaches only somebody newly named",
      },
      {
        file: "pb_hooks/routes.pb.js",
        each: String.raw`set\("kind",\s*"([^"]*)"\)`,
        values: ["ownership_transferred"],
        emitters: {
          ownership_transferred: ["workspaces transfer-ownership route — one notice per party"],
        },
        note: "the one kind emitted from a route rather than a notify.pb.js fan-out",
      },
    ],
  },
  ACTIVITY_FIELDS: {
    values: [
      "status",
      "assignee",
      "priority",
      "due",
      "milestone",
      "project",
      "title",
      "labels",
      "trashed",
      "cycle",
    ],
    sites: [
      {
        file: "pb_hooks/activity.pb.js",
        marker: "KEEP IN SYNC: ACTIVITY_FIELDS",
        block: String.raw`const ACTIVITY_FIELDS = \[([\s\S]*?)\];`,
      },
    ],
  },
  LABEL_TONES: {
    // The two collections' select vocabularies as they stand TODAY, not as whichever
    // migration last touched them — a migration that changes one palette without the
    // other, landed after either historical file, must still be caught.
    values_from: { file: "schema/labels.json", field: "color" },
    sites: [
      {
        file: "schema/statuses.json",
        block: _select_field("color"),
        note: "statuses.color offers the same palette as labels.color",
      },
    ],
  },
  TEMPLATE_TYPES: {
    values: ["task", "document"],
    sites: [
      {
        file: "schema/templates.json",
        block: _select_field("type"),
        note: "the live templates.type vocabulary, regenerated from pb_migrations/",
      },
    ],
  },
  TRASH_VISIBILITY_PREDICATES: {
    values: ["trashed", "project.trashed", "workspace.trashed"],
    sites: [
      {
        file: "schema/tasks.rules.json",
        block: String.raw`"listRule":\s*"((?:[^"\\]|\\.)*)"`,
        each: String.raw`([a-z_.]*trashed) = `,
        note:
          "tasks.listRule — the app's own trash visibility, generated from the " +
          "migrations; the sweep predicates below must hide exactly these states",
      },
      {
        file: "pb_hooks/cycles.pb.js",
        marker: "── INLINED SWEEP (cron copy, uses $app) — KEEP IN SYNC with the route copy ──",
        block:
          String.raw`"(ends_on < \{:today\}[^"]*)"[\s\S]*?` +
          "── END INLINED SWEEP " +
          String.raw`\(cron copy\) ` +
          "──",
        each: String.raw`([a-z_.]*trashed) = ''`,
        values: ["workspace.trashed"],
        note:
          "cron sweep, ended-cycle filter — the predicate that keeps a frozen workspace out of the enumeration entirely, 1 of 3 by design" +
          "; the block is the quoted filter literal, so a commented-out copy cannot satisfy it",
      },
      {
        file: "pb_hooks/cycles.pb.js",
        marker: "── INLINED SWEEP (cron copy, uses $app) — KEEP IN SYNC with the route copy ──",
        block:
          String.raw`"(cycle = \{:c\}[^"]*)"[\s\S]*?` +
          "── END INLINED SWEEP " +
          String.raw`\(cron copy\) ` +
          "──",
        each: String.raw`([a-z_.]*trashed) = ''`,
        values: ["trashed", "project.trashed"],
        note:
          "cron sweep, held-work filter — the task half and the project half, 2 of 3 by design" +
          "; each site anchors on its own INLINED SWEEP marker, so drift is reported against the copy that drifted",
      },
      {
        file: "pb_hooks/cycles.pb.js",
        marker: "── INLINED SWEEP (route copy, uses e.app) — KEEP IN SYNC with the cron copy ──",
        block:
          String.raw`"(ends_on < \{:today\}[^"]*)"[\s\S]*?` +
          "── END INLINED SWEEP " +
          String.raw`\(route copy\) ` +
          "──",
        each: String.raw`([a-z_.]*trashed) = ''`,
        values: ["workspace.trashed"],
        note:
          "route sweep, ended-cycle filter — the predicate that keeps a frozen workspace out of the enumeration entirely, 1 of 3 by design" +
          "; the block is the quoted filter literal, so a commented-out copy cannot satisfy it",
      },
      {
        file: "pb_hooks/cycles.pb.js",
        marker: "── INLINED SWEEP (route copy, uses e.app) — KEEP IN SYNC with the cron copy ──",
        block:
          String.raw`"(cycle = \{:c\}[^"]*)"[\s\S]*?` +
          "── END INLINED SWEEP " +
          String.raw`\(route copy\) ` +
          "──",
        each: String.raw`([a-z_.]*trashed) = ''`,
        values: ["trashed", "project.trashed"],
        note:
          "route sweep, held-work filter — the task half and the project half, 2 of 3 by design" +
          "; each site anchors on its own INLINED SWEEP marker, so drift is reported against the copy that drifted",
      },
    ],
  },
  DEFAULT_PRIORITIES: {
    values: ["urgent", "high", "medium", "low"],
    sites: [
      {
        file: "pb_hooks/main.pb.js",
        marker: "KEEP IN SYNC (default priority vocab)",
        block: String.raw`_defaultPriorityNames = \[([^\]]*)\]`,
      },
      // The backfill that held the second copy is folded into the baseline; the provision
      // seed is now the only live copy, checked against the list above and docs/constants.md.
    ],
  },
};

export const TEMPLATE_KEYS_FILE = "pb_hooks/scope.pb.js";
// Load-bearing, not decorative: each occurrence of this comment anchors one inlined copy.
export const TEMPLATE_KEYS_ANCHOR = "KEEP IN SYNC (below): TEMPLATE_DATA_KEYS";
export const TEMPLATE_KEYS_ARRAYS: Record<string, string> = {
  TEMPLATE_DATA_KEYS_TASK: "TASK_KEYS",
  TEMPLATE_DATA_KEYS_DOCUMENT: "DOC_KEYS",
};

export const PRIORITY_TOKEN_NAME = "PRIORITY_UNSET_TOKEN";
export const PRIORITY_TOKEN_FILE = "pb_hooks/lib/workspace_rules.js";
// Load-bearing: the token is read off the first code line under this comment, so the
// comment must stay directly above the comparison it governs.
export const PRIORITY_TOKEN_ANCHOR = "KEEP IN SYNC (below): PRIORITY_UNSET_TOKEN";

/** Every marker registered against a file — each one ends the region before it. */
export function _markers_of(file: string): string[] {
  const markers = new Set<string>();
  for (const spec of Object.values(CONSTANTS)) {
    for (const site of spec.sites) {
      if (site.marker !== undefined && site.file === file) markers.add(site.marker);
    }
  }
  return [...markers].sort(by_code_point);
}

/**
 * A commented-out copy of the old line must not satisfy a site: blank a whole-line JS
 * comment carrying a quote, unless it carries a marker line; line numbers are kept.
 */
export function _blank_commented_copies(text: string, keep: string[]): string {
  return text.replace(/^(\s*)\/\/.*["'`].*$/gm, (m0: string, g1: string) =>
    keep.some((k) => m0.includes(k)) ? m0 : g1,
  );
}

/**
 * 1-based lines where `pattern` matches VALUES outside every span a registered site took.
 *
 * A site owns its file only from its marker to the NEXT marker, so the last marker's region
 * runs to EOF and a site takes the FIRST match inside its region: either way an extra copy
 * is shadowed by the one the site did match, and only a sweep of the whole file sees it.
 * A match holding no value is not a copy that can drift — the repo's deliberate empty
 * `set("priorities", [])` provision seeds and its `priorities = '[]'` SQL guard are that shape.
 */
export function _unregistered(
  text: string,
  pattern: string,
  each: string,
  accepted: [number, number][],
): number[] {
  const each_re = new RegExp(each);
  return [...text.matchAll(new RegExp(pattern, "g"))]
    .filter((m) => {
      const start = m.index;
      const end = m.index + m[0].length;
      return (
        each_re.test(m[1]!) && !accepted.some(([a_start, a_end]) => start < a_end && a_start < end)
      );
    })
    .map((m) => count_nl(text.slice(0, m.index)) + 1);
}

/**
 * (this copy's values as written, 1-based line, the `block` match's span) — the first two
 * null when the copy isn't there, the span null when the site declares no `block`.
 */
export function _site_values(
  text: string,
  site: Site,
  markers: string[] | null = null,
): [string[] | null, number | null, [number, number] | null] {
  const each = site.each !== undefined ? site.each : EACH_DEFAULT;
  const keep = markers && markers.length ? markers : site.marker !== undefined ? [site.marker] : [];
  text = _blank_commented_copies(text, keep);
  let region = text;
  let base = 0;
  if (site.marker !== undefined) {
    const start = text.indexOf(site.marker);
    if (start < 0) return [null, null, null];
    base = start + site.marker.length;
    // The region STOPS at the next marker: an unterminated anchor matches its block in a
    // sibling copy and reports that copy's line while this one is gone.
    const stops = keep.map((m) => text.indexOf(m, base)).filter((at) => at >= 0);
    region = stops.length ? text.slice(base, Math.min(...stops)) : text.slice(base);
  }
  let body = region;
  let offset = base;
  let span: [number, number] | null = null;
  if (site.block !== undefined) {
    const found = new RegExp(site.block, "d").exec(region);
    if (found === null) return [null, null, null];
    body = found[1]!;
    offset = base + found.indices![1]![0];
    span = [base + found.index, base + found.index + found[0].length];
  }
  const first = new RegExp(each).exec(body);
  if (first === null) return [null, null, span];
  return [
    [...body.matchAll(new RegExp(each, "g"))].map((m) => m[1]!),
    count_nl(text.slice(0, offset + first.index)) + 1,
    span,
  ];
}

export function _parse_doc_values(text: string): Map<string, string[]> {
  const doc_values = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of splitlines(text)) {
    const heading = /^###\s+(\w+)\s*$/.exec(line);
    if (heading) {
      current = heading[1]!;
      continue;
    }
    const values_line = /^Values:\s*(.+)$/.exec(line);
    if (values_line && current) {
      doc_values.set(
        current,
        values_line[1]!.split(",").map((v) => py_strip(v)),
      );
      current = null;
    }
  }
  return doc_values;
}

export const JS_STRING = "[\"'`]([^\"'`]*)[\"'`]";

export function _js_array_re(js_name: string): string {
  return String.raw`\b(?:const|let|var)\s+` + js_name + String.raw`\s*=\s*\[([^\]]*)\]`;
}

export function _js_array_decl(block: string, js_name: string): RegExpExecArray | null {
  return new RegExp(_js_array_re(js_name)).exec(block);
}

/** The declared order is part of the value, so return it as written. */
export function _js_string_array(block: string, js_name: string): string[] | null {
  const declaration = _js_array_decl(block, js_name);
  if (declaration === null) return null;
  return [...declaration[1]!.matchAll(new RegExp(JS_STRING, "g"))].map((m) => m[1]!);
}

/**
 * (verb, human label, source slice, slice offset) per inlined copy — the nearest hook
 * registration above the anchor is what names the copy in a failure message.
 */
export function _template_key_copies(text: string): [string, string, string, number][] {
  const anchors: number[] = [];
  for (
    let at = text.indexOf(TEMPLATE_KEYS_ANCHOR);
    at >= 0;
    at = text.indexOf(TEMPLATE_KEYS_ANCHOR, at + TEMPLATE_KEYS_ANCHOR.length)
  ) {
    anchors.push(at);
  }
  const copies: [string, string, string, number][] = [];
  anchors.forEach((start, index) => {
    const end = index + 1 < anchors.length ? anchors[index + 1]! : text.length;
    const registrations = [
      ...text.slice(0, start).matchAll(/onRecord(Create|Update)Request\s*\(/g),
    ];
    const verb = registrations.length
      ? registrations[registrations.length - 1]![1]!.toLowerCase()
      : "unattached";
    const line = count_nl(text.slice(0, start)) + 1;
    copies.push([
      verb,
      `${verb} handler (${TEMPLATE_KEYS_FILE}:${line})`,
      text.slice(start, end),
      start,
    ]);
  });
  return copies;
}

export function _diff(
  a_label: string,
  a_values: string[],
  b_label: string,
  b_values: string[],
): string | null {
  if (Bun.deepEquals(a_values, b_values, true)) return null;
  const only_a = a_values.filter((v) => !b_values.includes(v));
  const only_b = b_values.filter((v) => !a_values.includes(v));
  if (!only_a.length && !only_b.length) {
    return (
      `${a_label} and ${b_label} list the same keys in a different order: ` +
      `${py_repr(a_values)} vs ${py_repr(b_values)}`
    );
  }
  const parts: string[] = [];
  if (only_a.length) parts.push(`only in ${a_label}: ${py_repr(only_a)}`);
  if (only_b.length) parts.push(`only in ${b_label}: ${py_repr(only_b)}`);
  return `${a_label} and ${b_label} disagree — ` + parts.join("; ");
}

/** Counts, not a set: a kind declared with two emitters must still be emitted twice. */
export function _emitter_diff(
  where: string,
  found: string[],
  name: string,
  declared: Record<string, string[]>,
): string | null {
  const seen = new Map<string, number>();
  for (const v of found) seen.set(v, (seen.get(v) ?? 0) + 1);
  const want = new Map<string, number>(
    Object.entries(declared).map(([v, labels]) => [v, labels.length]),
  );
  const parts: string[] = [];
  for (const value of [...new Set([...seen.keys(), ...want.keys()])].sort(by_code_point)) {
    const s = seen.get(value) ?? 0;
    const w = want.get(value) ?? 0;
    if (s === w) continue;
    const labels = (declared[value] ?? []).join("; ") || "none declared";
    parts.push(`${value}: ${s} emitter(s) in source, ${w} declared (${labels})`);
  }
  if (!parts.length) return null;
  return `${where} and ${name} disagree on live emitters — ` + parts.join(", ");
}

export function _check_template_data_keys(
  text: string | null,
  doc_values: Map<string, string[]>,
): string[] {
  if (text === null) {
    return [`TEMPLATE_DATA_KEYS: source of truth ${TEMPLATE_KEYS_FILE} not found on disk`];
  }

  const errors: string[] = [];
  const copies = _template_key_copies(text);
  for (const verb of ["create", "update"]) {
    if (!copies.some(([v]) => v === verb)) {
      errors.push(
        `TEMPLATE_DATA_KEYS: no '// ${TEMPLATE_KEYS_ANCHOR}' copy found under the ` +
          `${verb} handler in ${TEMPLATE_KEYS_FILE}`,
      );
    }
  }

  for (const [doc_name, js_name] of Object.entries(TEMPLATE_KEYS_ARRAYS)) {
    const parsed: [string, string[]][] = [];
    const accepted: [number, number][] = [];
    for (const [, label, block, offset] of copies) {
      const values = _js_string_array(block, js_name);
      if (values === null) {
        errors.push(`${doc_name}: no ${js_name} array found at ${label}`);
        continue;
      }
      const declaration = _js_array_decl(block, js_name)!;
      accepted.push([
        offset + declaration.index,
        offset + declaration.index + declaration[0].length,
      ]);
      parsed.push([label, values]);
    }
    for (const line of _unregistered(text, _js_array_re(js_name), JS_STRING, accepted)) {
      errors.push(
        `${doc_name}: ${TEMPLATE_KEYS_FILE}:${line} declares another ${js_name} that no ` +
          `'// ${TEMPLATE_KEYS_ANCHOR}' copy covers — an anchor owns its file only up to ` +
          `the next anchor, so this one is never compared against anything`,
      );
    }
    if (parsed.length) errors.push(..._assert_copies(doc_name, parsed, doc_values));
  }
  return errors;
}

/** Every parsed copy must equal the first, and the first must equal the doc. */
export function _assert_copies(
  doc_name: string,
  parsed: [string, string[]][],
  doc_values: Map<string, string[]>,
): string[] {
  const errors: string[] = [];
  const [reference_label, reference] = parsed[0]!;
  for (const [label, values] of parsed.slice(1)) {
    const divergence = _diff(reference_label, reference, label, values);
    if (divergence) errors.push(`${doc_name}: ${divergence}`);
  }

  if (!doc_values.has(doc_name)) {
    errors.push(
      `docs/constants.md: missing '### ${doc_name}' / 'Values:' entry ` +
        `(${reference_label} defines ${py_repr(reference)})`,
    );
    return errors;
  }
  const divergence = _diff(
    reference_label,
    reference,
    "docs/constants.md",
    doc_values.get(doc_name)!,
  );
  if (divergence) errors.push(`${doc_name}: ${divergence}`);
  return errors;
}

export function _check_priority_unset_token(
  text: string | null,
  doc_values: Map<string, string[]>,
): string[] {
  if (text === null) {
    return [`${PRIORITY_TOKEN_NAME}: source of truth ${PRIORITY_TOKEN_FILE} not found on disk`];
  }

  const lines = splitlines(text);
  const anchors = lines.flatMap((line, i) => (line.includes(PRIORITY_TOKEN_ANCHOR) ? [i] : []));
  if (!anchors.length) {
    return [
      `${PRIORITY_TOKEN_NAME}: no '// ${PRIORITY_TOKEN_ANCHOR}' marker found in ` +
        `${PRIORITY_TOKEN_FILE}`,
    ];
  }

  const errors: string[] = [];
  const parsed: [string, string[]][] = [];
  for (const start of anchors) {
    let site = start + 1;
    while (site < lines.length && py_lstrip(lines[site]!).startsWith("//")) site += 1;
    const code = site < lines.length ? lines[site]! : "";
    const comparison = /===\s*(["'`])(.*?)\1/.exec(code);
    if (comparison === null) {
      errors.push(
        `${PRIORITY_TOKEN_NAME}: the marker at ${PRIORITY_TOKEN_FILE}:${start + 1} is not ` +
          `directly above a \`=== "<token>"\` comparison (found ${py_repr(py_strip(code))})`,
      );
      continue;
    }
    parsed.push([`${PRIORITY_TOKEN_FILE}:${site + 1}`, [comparison[2]!]]);
  }

  if (parsed.length) errors.push(..._assert_copies(PRIORITY_TOKEN_NAME, parsed, doc_values));
  return errors;
}

/**
 * Every path this script reads, derived from CONSTANTS — a hook's trigger list built
 * from this call never rots when a site is added here.
 */
export function _mirror_site_paths(): string[] {
  const paths = new Set<string>();
  for (const spec of Object.values(CONSTANTS)) {
    for (const site of spec.sites) paths.add(site.file);
  }
  for (const spec of Object.values(CONSTANTS)) {
    if (spec.values_from) paths.add(spec.values_from.file);
  }
  // This file holds the canonical values, so editing it alone is drift the hook must see.
  for (const p of [TEMPLATE_KEYS_FILE, PRIORITY_TOKEN_FILE, DOC_RELPATH]) paths.add(p);
  paths.add(path.relative(REPO, path.resolve(import.meta.path)));
  return [...paths].sort(by_code_point);
}

const PROG = path.basename(import.meta.path);
const USAGE = `usage: ${PROG} [-h] [--root ROOT] [--print-sites]`;
const HELP = `${USAGE}

shared constant lists must stay in sync across every mirror site

options:
  -h, --help     show this help message and exit
  --root ROOT    tree to check (default: this repo)
  --print-sites  every path this gate reads, one per line
`;

export function main(): number {
  const args = parse_args(
    USAGE,
    HELP,
    [
      ["--root", "store", "root"],
      ["--print-sites", "store_true", "print_sites"],
    ],
    { root: REPO, print_sites: false },
  );
  if (args.print_sites) {
    print(_mirror_site_paths().join("\n"));
    return 0;
  }

  const errors: string[] = [];
  const info: string[] = [];

  const doc = py_join(args.root, DOC_RELPATH);
  if (!fs.existsSync(doc)) {
    print(`❌ check_constants: ${doc} not found.`);
    return 1;
  }
  const doc_values = _parse_doc_values(read_text(doc));

  const file_cache = new Map<string, string>();
  const accepted_spans = new Map<string, [number, number][]>();

  const read = (relpath: string): string | null => {
    if (!file_cache.has(relpath)) {
      const p = py_join(args.root, relpath);
      if (!fs.existsSync(p)) return null;
      file_cache.set(relpath, read_text(p));
    }
    return file_cache.get(relpath)!;
  };

  for (const [name, spec] of Object.entries(CONSTANTS)) {
    let canonical = spec.values;
    const source = spec.values_from;
    if (source !== undefined) {
      const schema_text = read(source.file);
      if (schema_text === null) {
        errors.push(`${name}: vocabulary source ${source.file} not found on disk`);
        continue;
      }
      canonical = _schema_select_values(schema_text, source.field) ?? undefined;
      if (canonical === undefined) {
        errors.push(`${name}: no '${source.field}' select field in ${source.file}`);
        continue;
      }
    }

    if (!doc_values.has(name)) {
      errors.push(
        `docs/constants.md: missing '### ${name}' / 'Values:' entry ` +
          `for constant ${name} (script map has ${py_repr(canonical)})`,
      );
    } else if (!Bun.deepEquals(doc_values.get(name), canonical, true)) {
      errors.push(
        `docs/constants.md drift for ${name}: doc has ${py_repr(doc_values.get(name))}, ` +
          `script map has ${py_repr(canonical)}`,
      );
    }

    for (const site of spec.sites) {
      const relpath = site.file;
      const text = read(relpath);
      if (text === null) {
        errors.push(`${name}: mirror site ${relpath} not found on disk`);
        continue;
      }

      const marker = site.marker;
      if (marker !== undefined && !text.includes(marker)) {
        errors.push(`${name}: expected marker '// ${marker}' not found in ${relpath}`);
        continue;
      }

      const expected = site.values !== undefined ? site.values : canonical!;
      const [found, line, span] = _site_values(text, site, _markers_of(relpath));
      if (span !== null) {
        if (!accepted_spans.has(relpath)) accepted_spans.set(relpath, []);
        accepted_spans.get(relpath)!.push(span);
      }
      if (found === null) {
        const under = marker ? ` under marker '${marker}'` : "";
        errors.push(
          `${name}: no copy of the list found at mirror site ${relpath}${under} ` +
            `(looked for ${py_repr(site.block !== undefined ? site.block : (site.each ?? EACH_DEFAULT))})`,
        );
        continue;
      }

      const where = `${relpath}:${line}`;
      let divergence: string | null;
      if (site.emitters !== undefined) {
        const declared = site.emitters;
        const declared_keys = Object.keys(declared).sort(by_code_point);
        const expected_keys = [...expected].sort(by_code_point);
        if (!Bun.deepEquals(declared_keys, expected_keys, true)) {
          errors.push(
            `❌ ${name}: the emitter declaration for ${relpath} covers ` +
              `${py_repr(declared_keys)}, the constant is ${py_repr(expected_keys)}`,
          );
        }
        divergence = _emitter_diff(where, found, `${name}`, declared);
      } else {
        divergence = _diff(where, found, `${name}`, expected);
      }
      if (divergence) errors.push(`❌ ${name}: ${divergence}`);

      if (site.note !== undefined) {
        info.push(`ℹ️  ${name} @ ${where}: ${site.note}`);
      }
    }
  }

  for (const [name, spec] of Object.entries(CONSTANTS)) {
    for (const site of spec.sites) {
      const relpath = site.file;
      const text = read(relpath);
      if (site.block === undefined || text === null) continue;
      const blanked = _blank_commented_copies(text, _markers_of(relpath));
      const each = site.each !== undefined ? site.each : EACH_DEFAULT;
      for (const line of _unregistered(
        blanked,
        site.block,
        each,
        accepted_spans.get(relpath) ?? [],
      )) {
        errors.push(
          `${name}: ${relpath}:${line} holds another copy matching this site's block ` +
            `that no registered marker covers — the gate compares only the copies it ` +
            `is pointed at, so this one can drift unseen; give it a marker of its own ` +
            `or delete it`,
        );
      }
    }
  }

  errors.push(..._check_template_data_keys(read(TEMPLATE_KEYS_FILE), doc_values));
  errors.push(..._check_priority_unset_token(read(PRIORITY_TOKEN_FILE), doc_values));

  if (errors.length) {
    print("❌ check_constants: drift detected:");
    for (const e of errors) {
      print(`     • ${e}`);
    }
    return 1;
  }

  for (const line of info) {
    print(line);
  }
  const sites_count = Object.values(CONSTANTS).reduce((n, spec) => n + spec.sites.length, 0);
  print(
    `✅ check_constants: ${Object.keys(CONSTANTS).length} constants parsed from source across ` +
      `${sites_count} mirror sites, every copy exact, docs/constants.md in sync.`,
  );
  print(
    `✅ check_constants: TEMPLATE_DATA_KEYS (${TEMPLATE_KEYS_FILE}) and ` +
      `${PRIORITY_TOKEN_NAME} (${PRIORITY_TOKEN_FILE}) parsed from source — every copy ` +
      "agrees with its siblings and with docs/constants.md.",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

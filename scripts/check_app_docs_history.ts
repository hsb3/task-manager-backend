#!/usr/bin/env bun
/**
 * CI / pre-commit check: no prose ever seeded into an app_docs record may silently vanish.
 *
 * Replays `pb_migrations/` INCREMENTALLY into one throwaway data dir (no server, no network),
 * snapshotting `app_docs` after every migration, and asserts that every span of every
 * historical title/body still appears in that record's FINAL text. A re-seed migration is
 * expected to ADD and REWORD; it is not expected to delete a paragraph nobody noticed, which
 * is how the project_items trash-route wording disappeared. Bodies are read only from the
 * replayed sqlite DB — never by grepping migration source, whose quoting cannot be trusted.
 *
 * Span unit: each title/body is cut at line breaks and sentence boundaries, whitespace
 * normalized, and chunks of at least MIN_SPAN_CHARS are tracked. The cut is derived, not
 * picked: run `spans()` over a full replay with the length gate removed and the chunk
 * lengths this corpus produces run min 14 / p10 51 / median 149, so 40 sits below the tenth
 * percentile and excludes about a twentieth of them. What it excludes is one kind of line —
 * short cross-references and one-clause verdicts ("See collection:tasks.", "Auth required.",
 * "RULED (owner-ratified 2026-07-27).") that are retargeted as a matter of course and whose
 * disappearance names no lost content. Raising the cut hides real prose; lowering it reports
 * every retargeted cross-reference.
 *
 * RATCHET: only drops attributed to a migration at or after BASELINE are policed; earlier
 * ones are counted and reported as grandfathered, never as findings. BASELINE is the stamp of
 * the baseline seed (gen_app_docs_seed.ts DEFAULT_OUTPUT), the one migration that seeds the
 * corpus, so the only grandfathered files are the baseline migrations before it, which seed no
 * prose; every re-seed lands above it. One window is narrower than that: a NEW migration
 * hand-stamped between the newest grandfathered file and BASELINE would be grandfathered too,
 * and nothing in this checker refuses it — `make next-migration-slot` cannot produce such a
 * stamp, and tests/test_app_docs_history_checker.ts is what refuses one, by pinning the newest
 * grandfathered file and the next free slot. The filter is on the DROPPING migration,
 * not on when the span was introduced — a span seeded long before the baseline and deleted
 * by a migration after it is still caught.
 *
 * Deliberate historical rewrites live in ALLOWLIST, keyed (dropping migration, slug, span
 * prefix) with a reason that must cite a card or decision; an entry matching no live drop
 * fails the run.
 *
 * Public API (tests/test_app_docs_history_checker.ts imports it): normalize, spans,
 * find_drops, partition_baseline, apply_allowlist, allowlist_problems, Drop, ALLOWLIST.
 * A (slug, field) record key and an ALLOWLIST key are JSON.stringify of the tuple.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse_args } from "./_argparse.ts";
import {
  by_code_point,
  json_dumps,
  print,
  py_int,
  py_repr,
  py_split,
  py_strip,
  PY_WS,
  read_text,
  splitlines,
  tup,
  sqlite_connect,
} from "./_py.ts";
import { repo_root } from "./_repo_root.ts";
import { migrate_up, pb_bin_path } from "./pb_migrate.ts";

export const REPO = repo_root(import.meta.path);
export const PB = pb_bin_path(REPO);
export const MIGRATIONS = path.join(REPO, "pb_migrations");

// Below the tenth percentile of this corpus's chunk lengths — derivation in the docstring.
export const MIN_SPAN_CHARS = 40;

const SPACE = PY_WS;
const WORD = String.raw`[\p{L}\p{N}_]`;

export const SENTENCE_BREAK = new RegExp(`(?<=[.!?])[${SPACE}]+`, "u");
export const CITATION = new RegExp(
  `(?<!${WORD})(PBTT-\\p{Nd}+|TASK-\\p{Nd}+|decision-\\p{Nd}+|decision:[a-z0-9]+(?:[-_][a-z0-9]+)*|card [0-9a-z]{4})(?!${WORD})`,
  "u",
);

// Oldest DROPPING migration this gate polices — ratchet rationale in the docstring.
export const BASELINE = "1785185300";

// JSON([dropping migration basename, slug, span prefix]) -> reason citing the card/decision.
export const ALLOWLIST = new Map<string, string>([
  [
    '["1785191200_seed_app_docs.js", "collection:api_keys", "A key cannot reach this collection: every api_keys route ans"]',
    "A key with manage_keys now lists and revokes keys (decision:api-key-manages-keys); the sentence saying no key can read or revoke keys became false.",
  ],
  [
    '["1785190700_seed_app_docs.js", "collection:oauth_codes", "Fields: code_hash (a fingerprint of the code, never the code), "]',
    "decision:api-key-reach-and-levels: oauth_codes gained the manage and own levels and the workspace choice; the field list now says so",
  ],
  [
    '["1785190500_seed_app_docs.js", "collection:notifications", "**Read.** Access is recipient-only, and list and view share "]',
    "decision:api-key-reach-and-levels: the quoted rule now carries the key reach clause; the record quotes the rule as it stands",
  ],
  [
    '["1785190500_seed_app_docs.js", "collection:projects", "**Create.** The createRule is: @request.auth.id != \\"\\" && (ow"]',
    "decision:api-key-reach-and-levels: the quoted rule now carries the key reach clause; the record quotes the rule as it stands",
  ],
  [
    '["1785190500_seed_app_docs.js", "collection:task_subscribers", "MANUAL: an ACTIVE non-viewer member (or the workspace owner)"]',
    "decision:api-key-reach-and-levels: the quoted rule now carries the key reach clause; the record quotes the rule as it stands",
  ],
  [
    '["1785190300_seed_app_docs.js", "collection:api_keys", "Fields: user (relation to users, required, removed with the "]',
    "decision:api-key-reach-and-levels: scope gained manage and own; the field list now says so",
  ],
  [
    '["1785189200_seed_app_docs.js", "collection:users", "**Verification email.** A signup through POST /api/collectio"]',
    "decision:password-signup-verify-first (fr92): the signup mail now sets the password and its resend is request-password-reset; the record now says so",
  ],
  [
    '["1785189200_seed_app_docs.js", "collection:users", "A failed send keeps the account and is logged; POST /api/col"]',
    "decision:password-signup-verify-first (fr92): the signup mail now sets the password and its resend is request-password-reset; the record now says so",
  ],
  [
    '["1785189100_seed_app_docs.js", "collection:users", "Provider sign-in account linking (GitHub or Google, decision"]',
    "decision:oauth-providers-from-env: an existing provider link or the signed-in account outranks the email fold; the record now says so",
  ],
  [
    '["1785189100_seed_app_docs.js", "decision:oauth-providers-from-env", "A sign-in whose verified email folds onto an existing accoun"]',
    "decision:oauth-providers-from-env: an existing provider link or the signed-in account outranks the email fold; the record now says so",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:app_docs", "A data migration seeds it, so the docs travel with the app a"]',
    "card 9fwr: the record says the server seeds the corpus, not which migration does",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:app_docs", "The namespace, when present, must be one of collection, conc"]',
    "card 9fwr: namespaces are named as slug prefixes with their colon, so hook appears only as a slug prefix",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:app_docs", "The self-documenting collection: one record per collection, "]',
    "card 9fwr: namespaces are named as slug prefixes with their colon, so hook appears only as a slug prefix",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:comments", "**Field guards.** edited is hook-set and tamper-proof: force"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:comments", "A second universal-tier guard there re-counts the targets on"]',
    "card 9fwr: the universal-tier wording becomes the observable guarantee, every write path",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:comments", "A universal-tier hook (pb_hooks/scope.pb.js) therefore re-as"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:comments", "Bounded: a superuser bypasses collection rules, so a re-scop"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:comments", "reactions may be toggled by any caller allowed to react, but"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:cycles", "**Shape.** A create that omits ends_on gets the DEFAULT TWO-"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:cycles", "A cycle is a calendar-day object: a hook normalizes starts_o"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:cycles", "A daily cron runs it at 06:00 UTC unless CYCLE_ROLLOVER_CRON"]',
    "card 9fwr: the scheduled run is described as a daily server run, not as a cron job",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:cycles", "Two guards then run on create and on update, on the universa"]',
    "card 9fwr: the universal-tier wording becomes the observable guarantee, every write path",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:decisions", "The project must belong to the same workspace as the decisio"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:documents", "The project must belong to the same workspace as the documen"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:invitation_events", "A ledger of invitation sends and declines that only the invi"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:invitation_events", "The daily expiry sweep in pb_hooks/invitation_expiry.pb.js d"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:invitation_events", "pb_hooks/invitations.pb.js writes the mint and decline rows,"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:labels", "They are undeletable: a delete hook refuses a core label wit"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:milestones", "**Scope.** Every milestone belongs to exactly one project in"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:notifications", "**Digest.** A daily cron (g2-notification-digest, pb_hooks/n"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:notifications", "**Producers.** The pb_hooks/notify.pb.js fan-out writes assi"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:project_items", "**Realtime.** Like every view collection this one emits no r"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:project_stats", "A VIEW collection backed by SQL: projects LEFT JOIN tasks LE"]',
    "card 9fwr: the view is described as backed by a query, without naming the query language",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:projects", "A creator may choose it, otherwise it is suggested from the "]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:projects", "Collection rules and that hook both stop applying to a super"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:projects", "RETURNING; a PATCH that changes it is refused with 400."]',
    "card 9fwr: the counter is described by its guarantee, assigned atomically, not by the statement behind it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:projects", "The workspace of a project is immutable for ordinary callers"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:projects", "item_seq is the server-owned counter behind the ONE shared n"]',
    "card 9fwr: the counter is described by its guarantee, assigned atomically, not by the statement behind it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:saved_views", "**Stale-write refusal.** pb_hooks/precondition.pb.js guards "]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:saved_views", "The delete guard registers ahead of every other delete hook,"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:statuses", "A hook checks that the status belongs to the workspace of th"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:statuses", "Deleting a status still referenced by a task is refused by a"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:statuses", "The seeding hook runs after any workspace create and skips a"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:statuses", "tasks.completedAt is set and cleared by a hook as the status"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:task_activity", "**Task rows.** pb_hooks/activity.pb.js writes exactly one ro"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:task_subscribers", "**How rows appear.** AUTO: pb_hooks/notify.pb.js subscribes "]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:tasks", "**Status.** status is optional: a hook fills the workspace d"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:tasks", "A hook (pb_hooks/cycles.pb.js, universal create and update t"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:tasks", "RETURNING, and a partial unique index on workspace and key b"]',
    "card 9fwr: the counter is described by its guarantee, assigned atomically, not by the statement behind it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:tasks", "completedAt is set by a hook when the status crosses into th"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:tasks", "pb_hooks/keys.pb.js assigns it at create from projects.item_"]',
    "card 9fwr: the counter is described by its guarantee, assigned atomically, not by the statement behind it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:templates", "**templateData shape.** A hook (pb_hooks/scope.pb.js, create"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:templates", "A template bound to a project must live in the workspace of "]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:user_settings", "**Provisioning.** A hook creates the row when the user is cr"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:users", "A partial unique index on email_key enforces it, and the cre"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:users", "GitHub OAuth account linking matches on the same key (pb_hoo"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:workspace_invitations", "A daily cron sweep deletes rows past it, and the accept rout"]',
    "card 9fwr: the scheduled run is described as a daily server run, not as a cron job",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:workspace_members", "Status moves only from active to suspended and from suspende"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:workspaces", "**Provisioning.** Every workspace, however it is created, ge"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:workspaces", "A daily cron purges workspaces trashed longer than app_setti"]',
    "card 9fwr: the scheduled run is described as a daily server run, not as a cron job",
  ],
  [
    '["1785187800_seed_app_docs.js", "collection:workspaces", "A name made only of whitespace is refused with a 400 error b"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:tracker-export", "Auth required ($apis.requireAuth): an anonymous POST is 401."]',
    "card 9fwr: the auth sentence drops the name of the server function behind it; the auth behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:tracker-inspire", "**Failure.** Every way the upstream can fail answers 502: a "]',
    "card 9fwr: the upstream call is described as the server calling the upstream service, without the runtime API",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:tracker-inspire", "Auth required ($apis.requireAuth): an anonymous GET is 401."]',
    "card 9fwr: the auth sentence drops the name of the server function behind it; the auth behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:tracker-inspire", "The backend calls the upstream through $http.send (the JSVM "]',
    "card 9fwr: the upstream call is described as the server calling the upstream service, without the runtime API",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:tracker-me", "Auth required ($apis.requireAuth); a superuser answers 403, "]',
    "card 9fwr: the auth sentence drops the name of the server function behind it; the auth behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:tracker-trash", "Auth required ($apis.requireAuth); anonymous is 401."]',
    "card 9fwr: the auth sentence drops the name of the server function behind it; the auth behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:workspaces-deletion-impact", "Auth required ($apis.requireAuth); anonymous is 401."]',
    "card 9fwr: the auth sentence drops the name of the server function behind it; the auth behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:workspaces-transfer-ownership", "This route is the only path: the workspaces updateRule refus"]',
    "card 9fwr: a hook becomes the server, a check or a guard; the behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:workspaces-transfer-ownership", "scripts/transfer_workspace_ownership.ts reads the current ow"]',
    "card 9fwr: the record states the behaviour without naming the server file that implements it",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:workspaces-trash", "Auth required ($apis.requireAuth); anonymous is 401."]',
    "card 9fwr: the auth sentence drops the name of the server function behind it; the auth behaviour is unchanged",
  ],
  [
    '["1785187800_seed_app_docs.js", "route:workspaces-vocab", "Auth required ($apis.requireAuth); anonymous is 401."]',
    "card 9fwr: the auth sentence drops the name of the server function behind it; the auth behaviour is unchanged",
  ],
  [
    '["1785187500_seed_app_docs.js", "decision:api-keys", "- **A key can read the metadata of the keys of its owner.** "]',
    "card sq82: a key request naming api_keys is now refused (decision:api-key-reads-refused); the accepted limit is marked superseded",
  ],
  [
    '["1785187500_seed_app_docs.js", "decision:api-keys", "Reading is not managing; closing it needs a marker on the req"]',
    "card sq82: the marker this sentence waited for is replaced by a refusal of key requests naming api_keys (decision:api-key-reads-refused)",
  ],
  [
    '["1785187200_seed_app_docs.js", "collection:project_items", "Any other operator, a modifier, an empty value where one is "]',
    "card 1t2f: status.name and labels.name now filter by name; the record names status.category as the refused path",
  ],
  [
    '["1785187200_seed_app_docs.js", "collection:user_settings", "On save only the 64-character limit on time_zone is enforced"]',
    "card 1853 and card 2ghp: a save now refuses an unknown time zone and an unreadable default pointer; the record says so",
  ],
  [
    '["1785187200_seed_app_docs.js", "collection:user_settings", "When the server counts days for the user, a time_zone that i"]',
    "card 1853: an unknown zone can no longer be saved, so the record says only a value the server cannot load reads as unset",
  ],
  [
    '["1785187200_seed_app_docs.js", "concept:write-normalisation", "This covers workspaces, projects, tasks, documents, decision"]',
    "card 2ghp: users.name joins the trimmed, blank-refused set; the record lists it",
  ],
  [
    '["1785187200_seed_app_docs.js", "route:tracker-user-settings", "The checks of the user_settings update request apply here to"]',
    "card 2ghp and card 1853: the route applies the new name, pointer and time zone checks; the record lists them",
  ],
  [
    '["1785187400_seed_app_docs.js", "collection:notifications", "**Read.** Access is recipient-only, and list and view share "]',
    "card s80p: the quoted notifications rule gained a workspace leg; the record quotes the new rule",
  ],
  [
    '["1785187400_seed_app_docs.js", "collection:notifications", "**Update.** update carries the same access predicate (withou"]',
    "card 06sf: actor and read_at are server-written; the record adds them to the field lock",
  ],
  [
    '["1785187400_seed_app_docs.js", "collection:notifications", "A notification naming no task, document or decision always l"]',
    "card s80p: a row naming a workspace now needs live membership of it; the record says which rows always list",
  ],
  [
    '["1785187400_seed_app_docs.js", "collection:notifications", "Fields: user (relation to users, required, the recipient, re"]',
    "card 06sf: notifications gained actor and read_at; the record lists both fields",
  ],
  [
    '["1785187400_seed_app_docs.js", "collection:notifications", "It covers exactly what the list shows, skips dismissed rows,"]',
    "card 06sf: read-all now stamps read_at; the record says so",
  ],
  [
    '["1785187400_seed_app_docs.js", "collection:notifications", "The list rule does not scope by workspace; a caller filters "]',
    "card s80p: the list rule now checks the workspace a row names; the record says how a caller narrows to one workspace",
  ],
  [
    '["1785186800_seed_app_docs.js", "collection:user_settings", "The server does not interpret time_zone; the 64-character li"]',
    "card tpyx: the server now reads time_zone to count the user's days (decision:viewer-day-values); the record says how",
  ],
  [
    '["1785186800_seed_app_docs.js", "route:tracker-trash", "**Items.** Each item is {collection, record, purge_at}, where"]',
    "card tpyx and card f27c: trash rows also carry purge_days and has_priority; the record names the new item shape",
  ],
  [
    '["1785186800_seed_app_docs.js", "route:tracker-trash", "With group set to project, status, priority, assignee or labe"]',
    "card f27c: the trash route also groups by type; the record lists it",
  ],
  [
    '["1785186900_seed_app_docs.js", "decision:invitation-keyed-by-email", "An owner gets no membership row, and an existing row in any "]',
    "card 06sf: every workspace gives its owner a membership row, so the record now says accepting writes nothing for the owner",
  ],
  [
    '["1785186900_seed_app_docs.js", "collection:workspace_members", "The provisioning paths also give each workspace owner a sel"]',
    "card 06sf: every workspace create gives its owner an admin row, not only the provisioning paths a member row; the record now says so",
  ],
  [
    '["1785187000_seed_app_docs.js", "decision:workspace-trash-cleanup-not-atomic", "An active admin may trash the workspace too, and when it is "]',
    "card te4g: only the owner trashes a workspace through the API, with a DELETE; the record no longer says an admin may trash one",
  ],
  [
    '["1785187000_seed_app_docs.js", "decision:workspace-trash-cleanup-not-atomic", "That is the invariant that every user keeps a live workspace"]',
    "card te4g: only the owner trashes a workspace through the API, with a DELETE; the record no longer says an admin may trash one",
  ],
  [
    '["1785186700_seed_app_docs.js", "route:tracker-summary", "Returns {user, total, byStatus, assignedToMe} for the tasks"]',
    "card vc8g: the summary route counts only workspaces the caller owns or holds an active membership in; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:comments", "A suspended membership reads nothing on the document and dec"]',
    "card vc8g: the comments rules lost the task-assignee branch; the record now says a suspended assignee reads nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:notifications", "**Read.** Access is recipient-only, and list and view share "]',
    "card vc8g: the quoted notifications rule lost its task.assignee leg; the record quotes the new rule",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:project_items", "**Rules.** The listRule reproduces per type exactly what the"]',
    "card vc8g: the view rules lost their assignee branch; the record now describes membership-only task access",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:project_items", "A caller who reaches a task only as its assignee gets counts"]',
    "card vc8g: the view rules lost their assignee branch; the record now describes membership-only task access",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:project_items", "A non-member assignee gets 404 on a trashed task."]',
    "card vc8g: the view rules lost their assignee branch; the record now describes membership-only task access",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:project_items", "For the owner and any active member this discloses nothing n"]',
    "card vc8g: the view rules lost their assignee branch; the record now describes membership-only task access",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:project_stats", "**Access.** List and view are open to the owner of the proje"]',
    "card vc8g: project_stats admits the workspace owner and active members, not the project creator; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:project_stats", "The owner branch checks no membership, so a creator whose me"]',
    "card vc8g: project_stats admits the workspace owner and active members, not the project creator; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:project_stats", "The rules carry no workspace-owner branch of their own."]',
    "card vc8g: project_stats admits the workspace owner and active members, not the project creator; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:projects", "Fields: name (required), description, owner (relation to use"]',
    "card bwpj: projects.owner is optional and emptied on account delete; the record now says the project and its items stay",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:saved_views", "Fields: workspace (relation, required, removed with its work"]',
    "card bwpj: saved_views.owner is optional; the record now says what an account delete does to personal and workspace views",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:task_activity", "A row holding a task is read by the owner or an ACTIVE membe"]',
    "card vc8g: the task_activity rules lost their assignee branch; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:tasks", "**Access.** The workspace owner, an ACTIVE member, or the as"]',
    "card vc8g: the tasks rules lost their assignee branch; the record now describes membership-only access",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:tasks", "The exception is the assignee branch, which is record-relati"]',
    "card vc8g: the tasks rules lost their assignee branch; the record now describes membership-only access",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:workspace_members", "Branches that grant on another basis stay ungated: workspace"]',
    "card vc8g: no rule grants on assignment any more; the record now says a suspended or viewer assignee gains nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:workspace_members", "The assignee branches carry no role guard, so on a task assi"]',
    "card vc8g: no rule grants on assignment any more; the record now says a suspended or viewer assignee gains nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "collection:workspace_members", "The one exception is the task create branch keyed on the ass"]',
    "card vc8g: no rule grants on assignment any more; the record now says a suspended or viewer assignee gains nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:active-membership-grants-access", "- **Task assignees.** A member who leaves has their tasks un"]',
    "card vc8g: assignment grants nothing past an active membership; the record now says a suspended assignee keeps nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:active-membership-grants-access", "A suspended member therefore loses access to the workspace, "]',
    "card vc8g: assignment grants nothing past an active membership; the record now says a suspended assignee keeps nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:active-membership-grants-access", "An assignee of a parent task may also create a subtask under"]',
    "card vc8g: assignment grants nothing past an active membership; the record now says a suspended assignee keeps nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:active-membership-grants-access", "Four paths admit the assignee of a task with no status condi"]',
    "card vc8g: assignment grants nothing past an active membership; the record now says a suspended assignee keeps nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:active-membership-grants-access", "The task-scoped rules of `task_activity`, `task_subscribers`"]',
    "card vc8g: assignment grants nothing past an active membership; the record now says a suspended assignee keeps nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:active-membership-grants-access", "An active workspace membership grants access to the workspac"]',
    "card vc8g: assignment grants nothing past an active membership; the record now says a suspended assignee keeps nothing",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:role-tiers", "A viewer reads what a member reads and writes nothing in the"]',
    "card vc8g: a viewer writes nothing, an assigned task included; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:role-tiers", "Their create, update and delete rules admit the owner and an"]',
    "card vc8g: a viewer writes nothing, an assigned task included; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:search-scoping-standard", "It requires authentication (401 otherwise) and runs one boun"]',
    "card vc8g: the search route lost its assignee leg; the record now scopes tasks by membership only",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:verified-login", "An approved account that never verifies is deleted: the dail"]',
    "card bwpj: the signup purge skips a sole owner of a shared workspace; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:project-stats-membership", "The query selects the project workspace as `workspace`, whic"]',
    "card vc8g: project_stats admits the workspace owner and active members, not the project creator; the record now says so",
  ],
  [
    '["1785186700_seed_app_docs.js", "decision:project-write-access", "Its one effect is a read, the task counts of the project (de"]',
    "card vc8g: projects.owner no longer admits a read of the project task counts; the record now says it grants no read",
  ],
  [
    '["1785186700_seed_app_docs.js", "route:tracker-export", "Per-collection cuts match the live read rules: trashed rows "]',
    "card vc8g: the export returns only the notifications the notifications list rule returns; the record now says so",
  ],
  [
    '["1785188000_seed_app_docs.js", "collection:users", "GitHub OAuth account linking matches on the same key: a prov"]',
    "card 6n7n: provider sign-in linking now covers GitHub and Google (decision:oauth-providers-from-env)",
  ],
  [
    '["1785188000_seed_app_docs.js", "collection:users", "The authRule is verified = true && approved = true: a new ac"]',
    "card 6n7n: the authRule sentence names provider sign-in (GitHub or Google), not GitHub OAuth alone",
  ],
  [
    '["1785188900_seed_app_docs.js", "collection:tasks", "Creating a SUBTASK under a parent mints a new record, so tha"]',
    "card 2vpm: the createRule has no parent or assignee branch, so a viewer assignee of the parent is refused like any viewer; the record now says so",
  ],
  [
    '["1785188900_seed_app_docs.js", "route:tracker-trash", "A TRASHED workspace is refused outright, the owner included,"]',
    "card 7cns: an unknown or inaccessible workspace now answers 404 (decision:inaccessible-workspace-answers-404); the trashed-workspace sentence is reworded around it",
  ],
  [
    '["1785188900_seed_app_docs.js", "route:tracker-trash", "The caller must be the workspace owner or hold an ACTIVE wor"]',
    "card 7cns: the route answers 404, not 403, for a non-member and an unknown id (decision:inaccessible-workspace-answers-404)",
  ],
]);

export class Drop {
  constructor(
    readonly slug: string,
    readonly field: string,
    readonly span: string,
    readonly introduced_by: string,
    readonly last_present_in: string,
    readonly dropped_by: string,
  ) {}
}

type Snapshot = [string, Map<string, string>];
const rec_key = (slug: string, field: string): string => JSON.stringify([slug, field]);

/** Collapse every whitespace run to a single space so re-wrapping is not a difference. */
export function normalize(text: string | null): string {
  return py_strip((text || "").replace(new RegExp(`[${SPACE}]+`, "gu"), " "));
}

/** Cut `text` at line breaks and sentence boundaries -> normalized chunks worth tracking. */
export function spans(text: string | null): string[] {
  const out: string[] = [];
  for (const line of splitlines(text || "")) {
    for (let chunk of line.split(SENTENCE_BREAK)) {
      chunk = normalize(chunk);
      if ([...chunk].length >= MIN_SPAN_CHARS) out.push(chunk);
    }
  }
  return out;
}

/**
 * -> every span present in some snapshot and absent from the LAST one.
 *
 * `snapshots` is (migration basename, {(slug, field): text}) in application order; the
 * final entry is the state the repo actually ships.
 */
export function find_drops(snapshots: Snapshot[]): Drop[] {
  if (!snapshots.length) return [];
  const final = new Map<string, string>();
  for (const [key, text] of snapshots[snapshots.length - 1]![1]) final.set(key, normalize(text));

  const first_seen = new Map<string, number>();
  const last_seen = new Map<string, number>();
  for (const [index, [, records]] of snapshots.entries()) {
    for (const [rk, text] of records) {
      const [slug, field] = JSON.parse(rk) as [string, string];
      for (const span of spans(text)) {
        const key = JSON.stringify([slug, field, span]);
        if (!first_seen.has(key)) first_seen.set(key, index);
        last_seen.set(key, index);
      }
    }
  }

  const drops: Drop[] = [];
  for (const [key, last_index] of last_seen) {
    const [slug, field, span] = JSON.parse(key) as [string, string, string];
    const haystack = final.get(rec_key(slug, field));
    if (haystack !== undefined && haystack.includes(span)) continue;
    drops.push(
      new Drop(
        slug,
        field,
        span,
        snapshots[first_seen.get(key)!]![0],
        snapshots[last_index]![0],
        snapshots[last_index + 1]![0],
      ),
    );
  }
  return drops.sort(
    (a, b) =>
      by_code_point(a.dropped_by, b.dropped_by) ||
      by_code_point(a.slug, b.slug) ||
      by_code_point(a.field, b.field) ||
      by_code_point(a.span, b.span),
  );
}

/** -> the leading timestamp of a migration basename; accepts a bare timestamp too. */
export function stamp(migration: string): number {
  return py_int(py_split(migration, "_", 1)[0]!);
}

/**
 * -> (policed, grandfathered), split on the DROPPING migration's timestamp.
 *
 * When the span was introduced is deliberately irrelevant: a span seeded before `since`
 * and deleted by a migration at or after it is policed.
 */
export function partition_baseline(drops: Drop[], since: number): [Drop[], Drop[]] {
  const policed = drops.filter((d) => stamp(d.dropped_by) >= since);
  return tup(
    policed,
    drops.filter((d) => stamp(d.dropped_by) < since),
  );
}

/** -> one message per malformed entry; a reason with no card/decision token is not one. */
export function allowlist_problems(allowlist: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, reason] of allowlist) {
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      parts = null;
    }
    if (!(
      Array.isArray(parts) &&
      parts.length === 3 &&
      parts.every((p) => typeof p === "string")
    )) {
      problems.push(`${py_repr(key)}: key must be (migration, slug, span prefix)`);
      continue;
    }
    if (typeof reason !== "string" || !py_strip(reason)) {
      problems.push(`${parts[0]} / ${parts[1]}: reason is empty`);
    } else if (!CITATION.test(reason)) {
      problems.push(
        `${parts[0]} / ${parts[1]}: reason cites no card or decision ` +
          `(PBTT-n, TASK-n, decision-n, decision:<slug>, card <ref>): ${py_repr(reason)}`,
      );
    }
  }
  return problems;
}

/**
 * -> (findings, allowed, stale entries). Matching is by span PREFIX, so a reworded tail
 * still matches, but a rewritten opening deliberately does not.
 */
export function apply_allowlist(
  drops: Drop[],
  allowlist: Map<string, string>,
): [Drop[], [Drop, string][], [[string, string, string], string][]] {
  const findings: Drop[] = [];
  const allowed: [Drop, string][] = [];
  const hit = new Set<string>();
  const keys = [...allowlist.keys()].map(
    (k) => [k, JSON.parse(k) as [string, string, string]] as const,
  );
  for (const drop of drops) {
    const match = keys.find(
      ([, key]) =>
        key[0] === drop.dropped_by && key[1] === drop.slug && drop.span.startsWith(key[2]),
    );
    if (match === undefined) {
      findings.push(drop);
      continue;
    }
    hit.add(match[0]);
    allowed.push([drop, allowlist.get(match[0])!]);
  }
  const stale = keys
    .filter(([k]) => !hit.has(k))
    .map(([k, key]): [[string, string, string], string] => [key, allowlist.get(k)!]);
  return [findings, allowed, stale];
}

/** -> {(slug, "title"|"body"): text}; empty before the app_docs collection exists. */
function _read_app_docs(data_dir: string): Map<string, string> {
  const con = sqlite_connect(path.join(data_dir, "data.db"));
  let rows: { slug: string; title: string | null; body: string | null }[];
  try {
    rows = con.query("SELECT slug, title, body FROM app_docs").all() as typeof rows;
  } catch {
    return new Map();
  } finally {
    con.close();
  }
  const out = new Map<string, string>();
  for (const { slug, title, body } of rows) {
    out.set(rec_key(slug, "title"), title || "");
    out.set(rec_key(slug, "body"), body || "");
  }
  return out;
}

/** Apply each migration in order into one data dir, snapshotting app_docs after each. */
export function replay(
  pb: string,
  migrations_dir: string,
  scratch: string,
): [Snapshot[], string | null] {
  const names = fs
    .readdirSync(migrations_dir)
    .filter((n) => n.endsWith(".js"))
    .sort(by_code_point);
  if (!names.length) return [[], `no .js migrations under ${migrations_dir}`];
  const staged = path.join(scratch, "mig");
  const data = path.join(scratch, "pb_data");
  fs.mkdirSync(staged, { recursive: true });
  const snapshots: Snapshot[] = [];
  for (const name of names) {
    fs.copyFileSync(path.join(migrations_dir, name), path.join(staged, name));
    const [ok, out] = migrate_up(pb, data, staged);
    if (!ok) return [snapshots, `\`migrate up\` failed at ${name}:\n${out}`];
    snapshots.push([name, _read_app_docs(data)]);
  }
  return [snapshots, null];
}

const HELP = `usage: check_app_docs_history.ts [-h] [--migrations-dir MIGRATIONS_DIR]
                                 [--since MIGRATION] [--json]

Fail any app_docs prose that a later migration silently dropped (incremental
replay, no server).

options:
  -h, --help            show this help message and exit
  --migrations-dir MIGRATIONS_DIR
                        default: repo pb_migrations/
  --since MIGRATION     police drops at/after this migration or timestamp
                        (default: 1785185300)
  --json                machine-readable report

RATCHET BOUND: only drops attributed to a migration at or after 1785185300 are
policed. Earlier ones are grandfathered and counted in the coverage block of
every run. That is not suppression: a historical migration cannot be edited
(repo law, hook-enforced), so a pre-baseline drop can never change or recur,
and every future re-seed lands above the baseline. The filter is on the
DROPPING migration, so a span seeded before the baseline and deleted after it
is still caught. SCOPE BOUNDS: only app_docs \`title\` and \`body\` are tracked,
and only forward — a span that never reached a snapshot cannot be missed.
Chunks shorter than 40 characters are not tracked. Presence is substring on
the whitespace-normalized FINAL text, so a re-wrap is not a drop but any re-
wording inside a tracked span is. A record deleted outright reports every one
of its spans.`;

export function main(): number {
  const usage = HELP.slice(0, HELP.indexOf("\n\n"));
  const args = parse_args(
    usage,
    HELP + "\n",
    [
      ["--migrations-dir", "store", "migrations_dir"],
      ["--since", "store", "since"],
      ["--json", "store_true", "json"],
    ],
    { migrations_dir: MIGRATIONS, since: BASELINE, json: false },
  );

  let since: number;
  try {
    since = stamp(args.since);
  } catch {
    print(
      `❌ check_app_docs_history: --since needs a migration basename or timestamp, got ${py_repr(args.since)}`,
    );
    return 2;
  }

  const problems = allowlist_problems(ALLOWLIST);
  if (problems.length) {
    for (const problem of problems) {
      print(`❌ check_app_docs_history: malformed ALLOWLIST entry — ${problem}`);
    }
    return 2;
  }
  if (!fs.existsSync(PB)) {
    print(
      `❌ check_app_docs_history: no pocketbase at ${PB} — run \`make pocketbase\`. ` +
        `A missing binary is a setup error, not a reason to pass.`,
    );
    return 2;
  }
  if (!fs.statSync(args.migrations_dir, { throwIfNoEntry: false })?.isDirectory()) {
    print(`❌ check_app_docs_history: no migrations dir at ${args.migrations_dir}`);
    return 2;
  }

  const started = performance.now() / 1000;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pbdocshist_"));
  let snapshots: Snapshot[];
  let error: string | null;
  try {
    [snapshots, error] = replay(PB, args.migrations_dir, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const elapsed = performance.now() / 1000 - started;
  if (error) {
    print(`❌ check_app_docs_history: ${error}`);
    return 2;
  }

  const [policed, grandfathered] = partition_baseline(find_drops(snapshots), since);
  const [findings, allowed, stale] = apply_allowlist(policed, ALLOWLIST);
  const tracked_keys = new Set<string>();
  for (const [, recs] of snapshots) {
    for (const [rk, t] of recs) {
      const [slug, field] = JSON.parse(rk) as [string, string];
      for (const span of spans(t)) tracked_keys.add(JSON.stringify([slug, field, span]));
    }
  }
  const tracked = tracked_keys.size;
  const final_slugs = [
    ...new Set(
      [...snapshots[snapshots.length - 1]![1].keys()]
        .map((rk) => JSON.parse(rk) as [string, string])
        .filter(([, field]) => field === "body")
        .map(([slug]) => slug),
    ),
  ].sort(by_code_point);

  if (args.json) {
    print(
      json_dumps(
        {
          ok: !findings.length && !stale.length,
          migrations_replayed: snapshots.length,
          records: final_slugs.length,
          tracked_spans: tracked,
          seconds: Math.round(elapsed * 10) / 10,
          baseline: args.since,
          grandfathered: grandfathered.length,
          grandfathered_migrations: [...new Set(grandfathered.map((d) => d.dropped_by))].sort(
            by_code_point,
          ),
          findings: findings.map((d) => ({
            slug: d.slug,
            field: d.field,
            span: d.span,
            introduced_by: d.introduced_by,
            last_present_in: d.last_present_in,
            dropped_by: d.dropped_by,
          })),
          allowlisted: allowed.map(([d, reason]) => ({
            slug: d.slug,
            field: d.field,
            span: d.span,
            dropped_by: d.dropped_by,
            reason,
          })),
          stale_allowlist: stale.map(([k, reason]) => ({
            migration: k[0],
            slug: k[1],
            span_prefix: k[2],
            reason,
          })),
        },
        { indent: 2 },
      ),
    );
    return findings.length || stale.length ? 1 : 0;
  }

  for (const drop of findings) {
    print(`❌ ${drop.slug} lost prose from its ${drop.field} — dropped by ${drop.dropped_by}`);
    print(`     span:  ${drop.span}`);
    print(
      `     since: introduced by ${drop.introduced_by}, last present in ${drop.last_present_in}`,
    );
    print(
      "     fix:   re-seed the span in a NEW migration, or allowlist it with the " +
        "card that decided the rewrite",
    );
  }

  for (const [key, reason] of stale) {
    print(`❌ stale allowlist entry ${key[0]} / ${key[1]}: ${reason}`);
    print("     no live drop matches that span prefix any more — drop the entry");
  }

  if (allowed.length) {
    print(`allowlisted rewrites (${allowed.length}):`);
    for (const [drop, reason] of allowed) {
      print(`  • ${drop.slug}.${drop.field} @ ${drop.dropped_by} — ${reason}`);
    }
  }

  print("coverage:");
  print(
    `  • replayed ${snapshots.length} migrations, snapshotting app_docs after each; ` +
      `${tracked} spans of >= ${MIN_SPAN_CHARS} chars tracked across ` +
      `${final_slugs.length} records (${elapsed.toFixed(1)}s)`,
  );
  print(
    `  • NOT tracked: chunks under ${MIN_SPAN_CHARS} chars, and every app_docs column ` +
      "other than title/body",
  );
  print(
    `  • RATCHET: policing drops from ${args.since} onward; ` +
      `${grandfathered.length} earlier drop(s) across ` +
      `${new Set(grandfathered.map((d) => d.dropped_by)).size} migration(s) are grandfathered — those ` +
      "migrations are immutable, so those drops cannot change or recur, and every future " +
      "re-seed lands above the baseline",
  );

  if (findings.length || stale.length) {
    print(
      `❌ check_app_docs_history: ${findings.length} dropped span(s), ` +
        `${stale.length} stale allowlist entr(ies).`,
    );
    return 1;
  }
  print(
    `✅ check_app_docs_history: no unexplained prose loss at or after ${args.since} — ` +
      `${policed.length} drop(s) there, every one accounted for (${allowed.length} allowlisted); ` +
      `${tracked} spans tracked across ${final_slugs.length} records, ` +
      `${grandfathered.length} pre-baseline drop(s) grandfathered.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

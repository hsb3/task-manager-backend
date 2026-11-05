<!--
GENERATED FILE — DO NOT EDIT BY HAND.

Source of truth: the `app_docs` `decision:*` seed migrations under
pb_migrations/. Regenerate with:

    bun scripts/gen_decisions.ts

See docs/self-documenting-app.md for how the app_docs convention works.
-->

# Decisions

## account-delete-sole-owner

- **Slug:** `decision:account-delete-sole-owner`
- **Title:** Decision: block self-delete while sole owner of a shared workspace [R7, D12iv, W1]
- **Ref:** `users`

Why: users.deleteRule is stock self-only, so a self-delete cascades away every owned workspace — including workspaces that other members depend on. How (W1, #64): a users onRecordDeleteRequest hook enforces R7 ONLY on a genuine self-delete by a regular user (superusers bypass to clean up junk accounts): if any workspace the caller owns has another member, throw BadRequestError (→ 400) and veto the delete; otherwise allow it (solo workspaces cascade cleanly). Live-verified the throw vetoes on v0.39.9 (R-2). The guard is hook-only — users.deleteRule is unchanged.

## agent-entry-scoped-api-key

- **Slug:** `decision:agent-entry-scoped-api-key`
- **Title:** decision-066: Agent entry path is a scoped personal API key resolved by a PocketBase middleware; the MCP server is a hosted HTTP route and the CLI speaks the frontend contract through the proxy

Status: Accepted

ACCEPTED as decision-066 (owner ruling 2026-09-19, sign-off card e50q item A). Decision text below unchanged from the Proposed record.

### Context

The owner asked (2026-09-16) for an authenticated way to control the app from an MCP server and a CLI. The umbrella `y1nh` already carries the three laws mined from Kaneo's burns: a key's scope gates independently of the user's role (kaneo PR #1374), agent writes ride the same hook path as UI writes (kaneo issue #1365), and no agent holds owner credentials on a shared board (dogfood cut v398). What needed a ruling was the entry path: how a non-browser caller authenticates, and where the MCP server and CLI attach so that there is exactly one write path. Full design with the measured probe: `~/.local/share/agent-artifacts/task-manager/agent-surface-design-2026-09-16.md`.

### Prior art

- **Linear:** hosted MCP server plus personal API keys, with a read-only option; no OAuth for personal use. This app converges on Linear.
- **Kaneo:** MCP OAuth (PRs #1372, #1381) auto-granted codes to any signed-in session and accepted caller-supplied redirect URIs; bearer keys parsed a scope map then discarded it (#1374); the MCP wrote comments to a different table than the UI (#1365).
- **PocketBase 0.40.4 primitives:** `record.newStaticAuthToken(duration)` and superuser impersonation mint long-lived tokens, but they carry no scope claim and revoking one means `refreshTokenKey()`, which kills every token that user holds, browser session included. A `routerUse` middleware may set `e.auth` and stamp the request with `e.set`; record hooks read the stamp. Measured in a clean room on 2026-09-16: an unparseable bearer is ignored by PB (200, anonymous), a middleware-resolved key lists the user's workspaces, and a `read` stamp makes `onRecordCreateRequest` answer 403.

### Options weighed

**Credential.** (a) PB static auth tokens as keys: no scope, all-or-nothing revocation. (b) An `api_keys` collection (user, name, prefix, sha256 hash, scope read|write, expires, revoked, last_used) resolved by a PB middleware that sets `e.auth` and stamps the scope. (c) OAuth device-code flow: the surface Kaneo got wrong twice, and nothing here needs a third party.

**Where enforcement lives.** (a) In the Next proxy: bypassable by anyone with the PB URL. (b) In PB hooks reading the stamp: applies to the proxy, the MCP server, the CLI and a raw curl alike.

**MCP server placement.** (a) A stdio process each agent runs from a checkout. (b) A Streamable HTTP route in the existing web service, calling the proxy handlers in-process with the key as the session token. (b) is one dependency, no new process, no new deploy target, and every current MCP client speaks HTTP with headers.

**CLI transport.** (a) PB-native client: a second contract to keep true. (b) The frontend contract through `/api/proxy/*` with a bearer key, sharing the generated client the web app uses.

### Decision

1. **Credential = scoped personal API key**, `tmk_` prefix, hashed at rest, shown once, `read` or `write`, revocable one at a time, never deleted. Minted only by a session-authenticated route; a key can neither mint nor revoke keys and is refused on every auth, settings, log, backup and dashboard path.
2. **A PocketBase middleware is the only resolver.** It sets `e.auth` to the key's user and stamps `apiKey {id, scope}` on the request. Scope refusal is a hook in the same file, applied to every record write and every write route under `/api/tracker/*`. Read scope keeps realtime subscribe.
3. **The MCP server is a hosted Streamable HTTP route in the web tier** (`/api/mcp`), stateless, bearer-authenticated, whose tools call the proxy handlers in-process. No OAuth, no stdio wrapper.
4. **The CLI speaks the frontend contract** through the proxy with a bearer key; the proxy accepts `Authorization: Bearer tmk_…` beside the cookie and forwards it verbatim. One write path for browser, MCP tools and CLI.
5. **Login for the CLI is paste-a-key** (the `gh auth login --with-token` shape). Device-code flow, workspace-bound keys, and a TUI are explicitly deferred, each with its trigger named on the design doc.

### Consequences

- `api_keys` is a new collection: its app_docs record, `schema/` regen, `openapi.json` regen and model tree regen ride the same change.
- Every future write route under `/api/tracker/*` must start with the scope check; the api-keys test suite lists the routes it covers and `check_keep_in_sync` couples that list to the route table.
- The frontend contract grows no new paths for MCP or CLI; a CLI verb without a contract path is a contract change first.
- Anything that needs a third party to authorize (OAuth for MCP, SSO-issued keys) is a new decision, not an extension of this one.

## app-settings

- **Slug:** `decision:app-settings`
- **Title:** Decision: a global app_settings key/value store [D8, W2]
- **Ref:** `app_settings`

Why: some configuration is app-wide (not per-user, not per-workspace) and must be operator-controlled — the first case is the trash recovery window W3 (#66) needs. How (W2, #65): an app_settings collection (key text UNIQUE, value json). READ is open to any authenticated user (list/view = @request.auth.id != "") so the SPA can render config-driven copy; WRITE is null → superuser-only, edited via the PocketBase dashboard, because there is no in-app superadmin UI. This mirrors app_docs's superuser-write posture (a non-superuser write 403s). v1 key: trash_retention_days=30 (the NUMBER 30), consumed by W3.

## auto-provision-workspace

- **Slug:** `decision:auto-provision-workspace`
- **Title:** Decision: auto-provision a default workspace on user creation (wave 13, #36)
- **Ref:** `workspaces`

Why: the m10 backfill that stamped `projects.workspace` seeded workspaces only for owners of projects existing at migration time, so every account minted since (open signup wave 4, approval gate wave 11) dead-ended with no workspace and no in-app way to make one (#36). How: a JSVM hook on onRecordAfterCreateSuccess("users") runs that same find-or-create loop for the runtime cohort — a default "My Workspace" plus a self-membership row — when a users record is created. The provisioned workspace's own vocabulary is NOT set here: the universal onRecordAfterCreateSuccess("workspaces") seeder fires on the programmatic create and gives it the 5 default statuses, the 3 core labels (G1 #74, now first-class collections rather than workspace JSON) and the default priority vocabulary urgent/high/medium/low (TASK-153, decision-028) — so a fresh account can set a priority with no manual setup. The after-create-success event fires on EVERY committed create path (API signup, OAuth first-signup, superuser seed) from one registration, and NOT on an OAuth link (which reuses an existing user, so no duplicate). It is idempotent (find-or-create by owner) and defensive (an inner try/catch logs a provisioning failure rather than bricking the signup). Runs as system (bypasses rules) and never reads approved/verified, so provisioning before the approval gate flips is safe: the workspace is owner-scoped and unreachable until the user is approved and can authenticate. Explicit create-workspace UI + a workspace/project switcher are deferred to #38.

## backups-recovery

- **Slug:** `decision:backups-recovery`
- **Title:** Decision: env-driven scheduled S3 backups + a rehearsed restore (module 19)
- **Ref:** `backups`

Why: prod had no configured backups (docs/08 said "Not yet configured") — issue #11. How: the WHOLE settings.backups block (s3 destination + cron + cronMaxKeep) is wired from env at boot by pb_hooks/backups.pb.js, mirroring the mail.pb.js SMTP hook — NO-OP when PB_BACKUPS_S3_* is unset (dev + CI keep local-filesystem backups), so the S3 secret never touches git and a rotated key is re-applied on the next deploy. Not a settings migration (would put the secret in git, and a one-shot apply can't pick up a rotated key) and not a per-instance dashboard click (invisible to git, un-rehearsable). Schedule (owner ruling): daily at 03:00 UTC, cronMaxKeep=30 (~30 days retention); both env-overridable (PB_BACKUPS_CRON / PB_BACKUPS_CRON_MAX_KEEP). Findings proven live: s3.enabled=true routes EVERY backup op to S3 (local pb_data/backups is then ignored), so the recovery rehearsal runs against a real S3 endpoint (MinIO in Docker locally; Railway object storage in prod); cron backups are stamped with an `@auto_` prefix; and restoreBackup is point-in-time and restarts the process in place (UNIX-only, experimental) — so a prod restore is a deliberate op against a throwaway instance, health-polled after the restart, never a live-prod click. S3 credentials live only in Railway variables + the untracked runbook, never in git.

## board-index-exempt-from-content-cap

- **Slug:** `decision:board-index-exempt-from-content-cap`
- **Title:** decision-068: the board index is exempt from the 1200px content cap; lists and documents keep the decision-058 cap

Status: Accepted

ACCEPTED as decision-068 (owner ruling 2026-09-19, sign-off card e50q item D). Supersedes decision-058 (v229) for one screen only: its clause "Both shapes use a left-aligned container with a 1200px maximum and 24px inline padding" no longer binds the board index. Every other clause of decision-058 stands.

### Context

Found by lane U-GRAMMAR (0dmw, PR #751) and recorded on rh6z: with every authenticated screen inside the decision-058 container (`web/components/shell/PageContainer.tsx`), board columns at a 1920px viewport measure about 172px (they were about 290px) and a seventh status column scrolls sideways beside empty screen. A kanban that wastes a third of a wide screen while its columns scroll is the wrong trade.

### Prior art

Linear's board view fills the viewport width; its list and document views are the ones that read as a measured column (session recollection, not re-measured on 2026-09-19; correct this line on the card if a later check disagrees).

### Decision

1. The board index renders full-width: no 1200px maximum on the board's column scroller. The 24px inline inset is kept by the board's toolbar and its column row (rh6z item 1 makes the column inset agree with the toolbar).
2. Lists, tables, settings and documents keep decision-058's cap and inset unchanged.
3. Six status columns still fit at 1440x900 without sideways scroll (y554 AC#2), re-measured after the change.

### Consequences

- The change lands with rh6z (its AC#4). `PageContainer` gains a board shape or the board page opts out; whichever, the register row for the board names this decision.
- Widening any other index screen past the cap is a new decision, not an extension of this one.

## comment-threads-single-level

- **Slug:** `decision:comment-threads-single-level`
- **Title:** Decision: comment threads are single-level (Linear-style) [G2, #74 — owner-ratified]
- **Ref:** `comments`

RULED (owner-ratified 2026-07-27; trail _meta/signoff/2026-07-27-g2-defaults/answers.json). A comment's `parent` must be a TOP-LEVEL comment on the SAME target — no nesting below depth 1. Enforced purely by createRule (no hook): parent = "" || (parent.parent = "" && parent.task = task && parent.document = document && parent.decision = decision). Proven: a top-level comment and a reply-to-top-level are accepted (200); a reply-to-a-reply and a reply whose parent is on a different task are rejected (400). Rationale: single-level threads match Linear and keep rendering/notification semantics simple; deeper nesting can be revisited if a product need appears. See collection:comments.

## decision-001

- **Slug:** `decision:decision-001`
- **Title:** decision-001: Backlog.md is the single task system; code-desk plugin stays enabled

Status: Superseded by decision-002

### Context

The repo ran two task systems: the code-desk `planning-desk` skill driving
`_meta/plans/` (`_config.md` + `_utils/` governance scripts), and Backlog.md
(`backlog/`, CLAUDE.md workflow block). TASK-001 required exactly one to be
authoritative. Disabling the code-desk plugin in `.claude/settings.json` would have
dropped planning-desk but also repo-meta-structure, project-memory, comms,
pptx-themes and board-triage, which stay in use.

### Decision

Superseded 2026-07-28 by decision-002, which rules a FULL cutover — `_meta/` removed
entirely and code-desk disabled for this repo. What follows is the interim ruling this
card carried before that supersession, kept as the record of it.

Interim ruling: Backlog.md is the single authoritative task system for this repo. The
code-desk plugin stays ENABLED in `.claude/settings.json` (no settings change); the
planning-desk skill is simply not used here. The desk machinery is archived at
`_meta/_archive/planning-desk/`.

### Consequences

Consequences as recorded under the interim ruling, overtaken by decision-002:

- CLAUDE.md names Backlog.md as authoritative; `_meta/plans/` holds only closed
  campaign records awaiting TASK-005's archive sweep.
- The `_utils/` governance scripts are archived with no live callers; resurrect from
  `_meta/_archive/planning-desk/` if a future repo wants the desk pattern.
- Sessions must not invoke the planning-desk skill in this repo even though it
  remains installed.

## decision-002

- **Slug:** `decision:decision-002`
- **Title:** decision-002: Full cutover: no _meta directory, backlog.md holds all planning, code-desk disabled

Status: Accepted

### Context

decision-001 kept code-desk enabled and `_meta/` in place (archives, handoff,
operations). The owner then ruled (2026-07-28): get fully off the planning-desk
approach — no `_meta/` directory at all, all planning items in backlog.md, and
Claude Code config updated accordingly. Placements were confirmed via owner
sign-off (four-question batch).

### Decision

Owner ruled 2026-07-28, with the placements confirmed in the four-question sign-off
batch. This supersedes decision-001. The repo has NO `_meta/` directory:

- Planning: backlog.md only (tasks, docs, decisions, milestones via the CLI/MCP).
- `_meta/HANDOFF.md` → `.claude/HANDOFF.md` (tracked; session cold-start bridge).
- `_meta/operations/` → `.claude/operations/` (untracked via .gitignore; secrets,
  live URLs, Henry's personal NOTES.md).
- Historical records (`_archive/`, campaign plans 73/74, `signoff/`) deleted from
  main; git history keeps them — last full-tree commit `83c8eb9` (see doc-001).
- `.claude/settings.json`: `code-desk@dotfiles-agents` DISABLED for this repo
  (drops planning-desk and the `_meta`-standard skills: repo-meta-structure,
  project-memory, mise-en-place, compliance-audit, comms, board-triage).
  pptx-themes / dataviz / diagrams / owner-signoff survive as standalone plugins.
- backlog-md MCP server enabled (owner action, plugin reload 2026-07-28).

### Consequences

- This repo deliberately deviates from the global `_meta/` repo-meta-structure
  standard and the global "secrets in `_meta/operations/`" convention — the
  repo-local convention is `.claude/operations/`.
- The compliance-audit/mise-en-place skills would flag this repo; they are
  disabled here on purpose.
- Pre-backlog history is read via git (`git ls-tree -r 83c8eb9 -- _meta/`), not
  the working tree.

#### Later record

Superseded in part (recorded 2026-08-12, surfaced by the PBTT-298 register compile):
this decision's "backlog.md holds all planning" clause was replaced by the 2026-08-11
board migration — the Kaneo board (this project) is the sole task system, per AGENTS.md
and the migration field guide doc-005 (PBTT-264). The rest of the decision (no `_meta/`,
code-desk disabled) still stands. No earlier comment recorded the supersession; this
entry closes that gap. — [root, session e2966506-20de-42d8-aa6c-0057438a339e]

## decision-003

- **Slug:** `decision:decision-003`
- **Title:** decision-003: Backlog artifact taxonomy: how we use decisions, docs, and drafts

Status: Accepted

### Context

Tasks were already the clear home for committed work, but decisions/docs/drafts were
underused, so pending decisions and descriptive state accreted in `HANDOFF.md` and the
live context window. Goal: offload that context into tracked files so a cold session
recovers it, and the handoff stops being a store.

CLI reality (v-current): `decision` is **create-only** (title + `-s status`; no update or
list). `doc` is full CRUD (`create`/`update`/`list`/`search`/`view`). `draft` is the
proto-task stage (`create` with -d/-a/-s/-l, then `promote`→task or `archive`; no --ac, no
parent).

### Decision

Accepted as recorded on this card; no separately dated owner ruling is on the record —
the taxonomy below was adopted and mirrored into `CLAUDE.md`.

Four artifacts, each with one job, plus a router:

- **tasks** — *committed work* (what we'll build). Full CLI lifecycle. Unchanged.
- **drafts** — *anticipated work* not yet scoped enough to commit. `promote`→task when ready.
- **decisions** — *choices and open questions*, ADR-style, created **early**: born the moment
  a stakes-bearing question appears (as a proposed record), not when resolved. On resolution,
  flip the record's status to `Accepted`/`Rejected` and add a dated `> **Resolved (YYYY-MM-DD):**`
  callout with choice + rationale + evidence. Supersession/correction per the repo ADR doctrine.
  **Lightweight by default** — short Context, the options, the callout; full ADR prose only for
  architectural rulings.
- **docs** — *living reference*: state, registers, crosswalks, specs. Mutate freely via `doc update`.

Split test: *why we chose / what we're deciding* → decision; *what is true / how it maps* → doc.

**Decisions are the sanctioned exception to "don't edit backlog markdown directly."** The CLI
only stamps a title+status stub; bodies and every lifecycle transition are authored by editing
the decision file. Tasks stay CLI-only (they carry CLI-maintained metadata/relationships/history);
docs mutate via `doc update`.

### Consequences

- `HANDOFF.md` becomes a **router**: cold-start orientation + pointers only. Bulky "current
  state" → a living doc; "owner's court / pending" → unresolved decision records; anticipated
  work → drafts.
- The open-decisions list is queryable: `grep -rl '^status: Proposed' backlog/decisions/`
  (anchor `^` to the frontmatter line — decision bodies may quote the string).
- Operative rule mirrored into `CLAUDE.md` (the instruction); this record holds the why.

## decision-004

- **Slug:** `decision:decision-004`
- **Title:** decision-004: Frontend architecture: fidelity-first build behind a proxy adaptation seam

Status: Accepted

### Context

The claude-design handoff (`design/`) mocks a keyboard-first task manager whose stack and
REST convention are fixed by `design/crud-frontend-standard.md` (Next.js App Router · Refine
headless · shadcn/TanStack · react-hook-form/zod · nuqs). It mocks capabilities the current
PocketBase backend cannot yet serve (polymorphic `project_items` over 4 separate collections,
embedded workspace vocabularies, a `viewer` role, `pending_approval`, a normalized error/event
shape). Owner's priority: **the frontend looks and works exactly as mocked**; the backend
catches up dynamically. Two build strategies were on the table — supported-first (build only
what PB backs today) vs fidelity-first (build it all against a stable contract, back gaps with
stubs). Owner chose fidelity-first.

Standard §1/§4 are decisive: the frontend consumes exactly one REST contract; "whatever sits
behind it, and whatever normalization the proxy does, is out of scope for frontend work… if
the spec deviates, fix the backend **or translate in the proxy**. Never fork the generic
components."

### Decision

The owner chose fidelity-first over supported-first (see Context), and this record is
accepted on that basis. Three layers, with the **proxy as the adaptation seam**:

```
Next.js frontend (Refine/shadcn)  → talks ONLY to the §4 REST contract
   └─ /api/proxy/[...path]         → THE SEAM: normalize, inject x-workspace-id, real|stub
        └─ PocketBase (native)     → 4 collections, relation vocab, native errors/realtime
```

- **Two `openapi.json` files, by design.** The existing repo-root `openapi.json` stays the
  PocketBase-native spec (drift-gated from migrations). A **new frontend-contract spec**
  describes the §4 convention and is the codegen source (`@hey-api/openapi-ts`) for the app.
  The proxy is the function between them.
- **Fidelity-first / proxy-mock.** Build all 11 screens to full mock fidelity now. The proxy
  serves real PocketBase where supported and returns **typed stubs** conforming to the contract
  where not. As each backend gap closes, flip that one proxy handler stub→real — **zero
  frontend rework.**
- The proxy carries a **stub register** (which capabilities are real vs mocked); that register
  is TASK-008's backend-gap punch list (tracked as a living doc).

### Consequences

- The frontend is never blocked by backend readiness; mock fidelity is achievable immediately.
- `openapi.json` (native) is NOT reshaped to the §4 convention — the seam absorbs the mismatch.
- Each backend gap the register names is filed as its own task under TASK-008 that flips a
  proxy stub to real; the frontend contract stays stable across those flips.
- New app lives at `web-next/` (clear of the `web/` regression harness). Stack is fixed by the
  standard — not re-litigated.
- Discipline cost: a stub must be typed to the contract and tracked in the register, never a
  silent fake — an untracked stub reads as "supported" when it isn't.

## decision-005

- **Slug:** `decision:decision-005`
- **Title:** decision-005: Item full-page layout: Wide, Rail, or Tabs

Status: Accepted

### Context

`design/screens/05-item-page.md` ships a Wide / Rail / Tabs switcher as a **decision aid,
not a feature** — the prototype defaults to Rail. The full-page layout is the one screen the
handoff leaves unsettled.

### Decision

**Tabs.** Owner ruled 2026-07-28 via the sign-off batch
(`.claude/signoff/2026-07-28-owner-decisions/answers.json`): build the Tabs layout only; do
not build the Wide/Rail variants or the switcher.

The options weighed were **Rail** (prototype default) · **Wide** · **Tabs**. Exactly one is
built; the switcher is not built in any case.

### Consequences

- Affects the screen-05 task only.
- Before the ruling, this record's default stance was "resolve to Rail unless the owner says
  otherwise"; the owner's pick of Tabs overrides that stance.

## decision-006

- **Slug:** `decision:decision-006`
- **Title:** decision-006: Narrow/mobile (<1100px) layout is undesigned

Status: Accepted

### Context

`design/README.md`: nothing below ~1100px is designed — narrow/mobile is **undesigned, not
"responsive by default."** The handoff says raise it rather than improvise a breakpoint.

### Decision

**Desktop-only (≥1100px) for v1.** Owner ruled 2026-07-28 via the sign-off batch, confirming
the record's default stance: build desktop-only for v1 and treat mobile as a separate
design-then-build effort, not an implicit requirement. Screens carry no responsive obligation
below 1100px, and reviews must not flag it.

### Consequences

- Screens carry no responsive obligation below 1100px and reviews won't flag it.
- Mobile/narrow is a separate design+build effort, taken up later.

#### Later record

PBTT-316 re-read (2026-08-14), recorded per that card's AC — nothing here is re-ruled, only
what changed underneath this decision:

This decision's 2026-07-28 resolution (desktop-only ≥1100px, no responsive obligation) was
already narrowed by the owner's 2026-08-10 ruling (phone/tablet in scope; decision-025,
executed by TASK-137: one 768px breakpoint). With PBTT-316, `design/` is now the live plan and
*designs* the sub-768px shell (drawer sidebar, single-column auth, in-container table scroll),
so this card's factual premise — "nothing below ~1100px is designed" — no longer describes the
tree. The intent survives narrowed: **768px–~1100px remains the undesigned band**, and reviews
still must not flag it.

Mechanism change: "undesigned" used to be a permanent property of a frozen packet; the frozen
referent is now the `design-v1-vendored` git tag, and `design/` itself is living. "The design
doesn't cover X" is answered by reading current `design/`; "what was originally designed" is
answered at the tag. — [root, session e199b002-013f-4419-81b4-819ce301d181]

## decision-007

- **Slug:** `decision:decision-007`
- **Title:** decision-007: Scope boundary: undesigned features not to invent

Status: Accepted

### Context

`design/README.md` names features that are **not designed — do not invent**: comment
reactions and resolve/unresolve · notification preferences, digests, per-item mute ·
project-level (vs workspace-level) member scoping.

### Decision

**The boundary holds.** Owner ruled 2026-07-28 via the sign-off batch: none of the named
features (comment reactions + resolve/unresolve · notification preferences/digests/per-item
mute · project-level member scoping · presence) are built or stubbed in v1 UI. They are out
of v1 scope, and each becomes its own design+build effort if wanted later.

Owner's rider: keep the list alive for v2 as backlog **drafts**, one per feature (created the
same day). Presence stays out, which unblocks TASK-008.08's presence question — not in v1.

### Consequences

- Keeps v1 to what's mocked; prevents improvised UI for undesigned surfaces. Any of these
  later starts as a new design pass, then a task.

#### Later record

PBTT-316 re-read (2026-08-14), recorded per that card's AC:

The boundary **holds**, but its enforcement mechanism changed. It relied on the packet being
frozen — silence in `design/` meant stop. With PBTT-316, `design/` is the live plan, so silence
is editable: a feature could be made "designed" by adding a screen file. The rule therefore now
reads as process, which is stronger, not weaker: **a feature enters scope by being deliberately
designed in `design/` first — a reviewed design change — never invented in code.** The original
scope question ("was this in the vendored design?") stays answerable at the
`design-v1-vendored` tag.

The named features are unaffected: comment reactions/resolve (v2 card), notification
preferences/digests/mute (v2 card), project-level member scoping (v2 card), presence (v2, ruled
2026-08-14) all remain tracked in `docs/features.yml` as planned/v2, none designed or stubbed.
— [root, session e199b002-013f-4419-81b4-819ce301d181]

## decision-008

- **Slug:** `decision:decision-008`
- **Title:** decision-008: Trash restore: re-insert into items list in place?

Status: Accepted

### Context

`design/README.md`: trash **restore** removes the row from the trash list, but whether it
re-inserts into the items list **in place** is unspecified. Bulk-trash undo *does* re-insert.

### Decision

**Re-insert at original `position`** — consistent with bulk-undo; position survives trash.
Owner ruled 2026-07-28 via the sign-off batch. The alternative weighed was append/re-sort by
default order.

Owner's rider for edge cases (e.g. restoring an item whose parent project no longer exists):
v1 must **detect the conflict and refuse the in-place restore**, telling the user why; then
offer the item's content pre-filled in a "new <type>" form (minus the conflicting fields) with
save/cancel; on cancel, prompt for permanent deletion of the trashed item. Test for these paths
in the screen-08 work.

### Consequences

- Affects the proxy restore handler (`PATCH { trashed_at: null }`) and the list's optimistic
  update.
- Scoped to the screen-08 task's restore behavior only. Low stakes.

## decision-009

- **Slug:** `decision:decision-009`
- **Title:** decision-009: Deployment topology: two Railway services (decoupled frontend/backend) in one project

Status: Accepted

### Context

Today the backend and frontend ship as **one Railway image**: the Dockerfile builds the vendored
`web/` Vite SPA to static files and PocketBase serves them from `pb_public` alongside its API — one
binary, one process. That single-image simplicity is a *property of the current frontend being a
static SPA*, not a chosen constraint.

The new frontend (`web-next/`) is **Next.js App Router**, and decision-004 fixes an architecture the
design packet reconfirms: all data traffic goes through a Next.js **pass-through proxy**
(`/api/proxy/[...path]`), `/api/auth/*` route handlers, httpOnly session cookies, backend keys only
in route handlers. That is server code requiring a **Node runtime** — it cannot be a static bundle
PocketBase serves. So the single-image shape does not survive the Next.js decision. Three options
were weighed: (A) two Railway services; (B) one multi-process image (PocketBase + Node) behind a
supervisor; (C) collapse the proxy seam into PocketBase and ship Next as a static export.

### Decision

**Option A — two Railway services in the same `learn-pocketbase` project.** Keep the PocketBase
service and its Dockerfile as-is; add a second service for the Next.js app (`next start`). The proxy
reaches PocketBase over Railway's private network. Rejected: B (two runtimes, process supervision,
and — the deciding factor — it **re-couples the deploys** we want independent); C (reopens
decision-004, loses SSR/RSC/middleware, and pushes session + key handling into PocketBase).

**Correction (2026-07-29):** the topology decision (Option A — two services in one project)
**stands and is now executed** by [[decision-011]] (TASK-020). But two consequence premises below
were overtaken: the vendored `web/` SPA is **not** untouched (it is retired, `web-next/` promoted
into `web/`), and the PocketBase service is **not** unchanged (its Dockerfile drops the SPA build,
its watch patterns drop `web/**`, and it moves to `admin.tasks-pocketbase.functionform.ai` while
the frontend takes `tasks-pocketbase.functionform.ai`). The now-false sentences are struck inline
below.

### Consequences

- **Backend and frontend deploy independently** — a frontend change never redeploys PocketBase and
  vice-versa. This also delivers the selective-redeploy control discussed alongside the branching
  question: the `web-next/` path is simply a different service, not a watched path on the PB service.
- ~~The PocketBase service is unchanged; the current Dockerfile, watch patterns, and healthcheck stay
  as they are. `web/` (the regression-harness SPA served from `pb_public`) is untouched.~~
  **(Corrected 2026-07-29 — [[decision-011]]: `web/` retired, `web-next/` promoted into `web/`; the
  PB Dockerfile drops the SPA build and its watch patterns drop `web/**`.)**
- A new service definition + its own Dockerfile/build for `web-next/` is required (own healthcheck,
  own env). Cross-service calls use Railway's internal networking; CORS/origins config per service.
- `web-next/`'s proxy targets PocketBase by its internal URL, not a public domain.
- Superseding this (going back to one image) would require adopting option C and reopening
  decision-004.

## decision-010

- **Slug:** `decision:decision-010`
- **Title:** decision-010: The backups bucket is backups-only; file storage gets its own bucket if it ever moves off-volume

Status: Accepted

### Context

The project has one Railway object-storage bucket (name + credentials in
`.claude/operations/railway.md`, untracked). Today it serves exactly one consumer:
`pb_hooks/backups.pb.js` wires PocketBase's `settings.backups.s3` to it at boot, and the
daily cron writes `@auto_pb_backup_*.zip` archives with `cronMaxKeep=30` retention.
Uploaded files (attachments, avatars) are a **separate** PocketBase storage system
(`settings.s3`) and currently live on the Railway volume, not in any bucket.

### Decision

The bucket is **backups-only**. If file storage ever moves off the volume to S3, that
work provisions a **second, dedicated bucket** rather than sharing this one.

Owner ruled 2026-07-28 with the backup-purge sign-off (item I of that batch, which asked
"is the bucket solely for backups or can we also use it for operational storage
(attachments, avatar images)?").

Why not share: PocketBase's backup retention deletes objects it manages in the bucket,
and a restore treats the archive set as the whole story — mixing an authoritative live
file store into the same namespace couples two different lifecycles (30-day rolling
deletion vs. permanent user content) and makes both restore rehearsals and credential
scoping murkier. Buckets are cheap; separation is free insurance.

### Consequences

- Nothing in the backend or frontend may treat the backups bucket as general object
  storage.
- A future "attachments on S3" effort starts with its own bucket + credentials and
  wires `settings.s3` (file storage), leaving `settings.backups.s3` untouched.
- Pre-v007 backup archives were purged 2026-07-28 (owner-authorized); the bucket holds
  only current-schema backups going forward.

#### Later record

Consequence enacted 2026-08-17 (PBTT-390): file storage moved off the volume exactly as this
decision prescribes — a second dedicated bucket (`pb-files`, Railway iad) now backs
`settings.s3` via the `pb_hooks/files.pb.js` env boot hook (`PB_FILES_S3_*`), with
`settings.backups.s3` untouched (asserted in tests/test_file_storage.py). Proven live: prod
avatar upload landed in `pb-files` (object count 0→1), nothing new under
`/pb/pb_data/storage`. The backups bucket remains backups-only. — [root, session
3643bdfc-89a6-4f2a-bc6b-9954fd203720]

## decision-011

- **Slug:** `decision:decision-011`
- **Title:** decision-011: Sunset web/ SPA, promote web-next/ to web/, two-service deploy

Status: Accepted

### Context

The vendored `web/` Vite SPA is a **regression harness only** — kept green for e2e, zero feature
investment (HANDOFF §1). The real app is `web-next/` (Next.js App Router): all eleven design
screens, the app shell, and realtime shipped and CI-green. **decision-009** already ruled the
target deploy topology — two Railway services in one project — but the frontend service was never
provisioned, and that decision assumed `web/` stays in place and PocketBase keeps serving the SPA
from `pb_public` (one image). TASK-008 left the **fate of `web/`** as an open owner call.

The owner has now made the call (2026-07-29): retire the SPA, promote `web-next/` into `web/`, and
stand up the frontend's own Railway service. Two shaping questions were resolved in the same pass —
repo layout and domains — after checking Railway's model (a domain binds to exactly one
service+port; Railway supports per-service `rootDirectory` + watch paths, so any layout deploys).

### Decision

Owner ruled 2026-07-29:

1. **Sunset the vendored `web/` Vite SPA** — its source and its e2e harness. The browser journeys
   it carried are already covered by the Python suite battery (crosswalk below); its only unique
   asset, `prod-smoke`, is retargeted, not lost (TASK-020.07).
2. **Promote `web-next/` → `web/`.**
3. **Repo layout: leave PocketBase at the repo root** (`pb_migrations/`, `pb_hooks/`, `./pocketbase`,
   `scripts/`, `tests/`, `schema/`); the frontend lives at `web/`. Rejected `backend/`+`frontend/`
   and `apps/{server,web}`: Railway's per-service `rootDirectory` makes a formal monorepo shape
   unnecessary for the two-service deploy, while moving PB out of root would churn the clean-room
   law (CLAUDE.md), all 27+ test suites (each boots `--migrationsDir pb_migrations` root-relative),
   `run_suite_battery.sh`, `check_constants`, `gen_openapi`, `gen_coverage`, the
   `scripts/model/target/*.yml` tree, `.githooks/pre-commit`, `Dockerfile`, `Makefile`, and env
   examples — large risk for cosmetic payoff, all currently green. A monorepo reorg can be its own
   later epic if the shape becomes worth the churn.
4. **Two Railway services in the `learn-pocketbase` project** (this executes decision-009):
   - **PocketBase** — API + `/_/` dashboard only. Its Dockerfile drops the SPA `webbuild` stage and
     the `pb_public` copy; PB serves no frontend at `/`.
   - **Next.js app** — `next start` from an `output: "standalone"` build, its own Dockerfile +
     healthcheck.
   - **Independent deploys** via per-service watch paths: the PB service **drops** `web/**`; the
     frontend service **watches** `web/**`.
5. **Domains** (owner-ruled 2026-07-29):
   - **Frontend → `tasks-pocketbase.functionform.ai`** — the *current* domain, **reassigned** from
     the PB service to the frontend service.
   - **PocketBase → `admin.tasks-pocketbase.functionform.ai`** — a new subdomain, serving the `/_/`
     dashboard **and** `/api/*`, including the **direct browser→PB realtime SSE** channel that
     decision-004 deliberately keeps outside the proxy seam.

**Correction (2026-07-31):** The Consequences section below planned a GitHub OAuth callback move
to the **PocketBase/admin domain**, via PB's own hosted `/api/oauth2-redirect` popup route. TASK-017.19
(2026-07-31) built a different architecture instead — a plain server-side redirect owned by the
Next.js app itself (`web/app/api/auth/oauth/github/{start,callback}/route.ts`), with the callback
staying on the **frontend's own domain**, `https://tasks-pocketbase.functionform.ai/api/auth/oauth/github/callback`.
This was a deliberate call at build time, not an oversight — PB's hosted popup route was never
actually adopted. The GitHub OAuth App is now registered with this new callback (owner-confirmed
live). Struck below.

### Consequences

- **Corrects decision-009 in place** — its "`web/` … is untouched" and single-image premises no
  longer hold (dated erratum added there).
- **Resolves TASK-008's open fate-of-`web/`.** (TASK-008 AC#4 "no silent fakes" is separate and
  stays open.)
- PB's public root `/` no longer serves an SPA — only the API + `/_/` dashboard.
- **Domain move ripples** (for TASK-020.06/.07): `NEXT_PUBLIC_PB_URL` (build-time, inlined into the
  browser SSE channel — `lib/realtime.ts`) and `PB_CORS_ORIGINS` point at
  `admin.tasks-pocketbase.functionform.ai` (the browser SSE + CORS need PB's *public* host); the
  server-side proxy target stays PB's **internal** Railway URL per decision-009, not the public
  domain. Add a Cloudflare CNAME for `admin.tasks-pocketbase` (functionform.ai zone), and reassign
  the `tasks-pocketbase` domain to the frontend service. ~~**The GitHub OAuth callback moves** from the
  PB domain to
  `https://admin.tasks-pocketbase.functionform.ai/api/oauth2-redirect` — update the GitHub OAuth app
  (callback currently on `tasks-pocketbase.functionform.ai`, per the ops runbook).~~ See the
  2026-07-31 correction above — the callback stayed on the frontend domain, at a new Next.js-owned
  path, not PB's hosted popup route.
- **Execution is gated on the new webapp being more stable** — direction is fixed now; timing is the
  owner's. TASK-020 (.01–.07) is the work.

#### Coverage crosswalk — where each retiring `web/e2e` journey lands

The Python suite battery (34 `tests/test_*.py`) already exercises these backend rules; `web-next/e2e`
covers the browser/screen layer. Only `prod-smoke` is unique and is retargeted.

| `web/e2e` spec (retiring)        | Backend coverage kept (Python battery)            | Browser coverage kept (`web-next/e2e`) |
|----------------------------------|---------------------------------------------------|----------------------------------------|
| auth                             | test_auth_rules                                   | login                                  |
| signup                           | test_auth_rules, test_provision, test_email       | login                                  |
| default-provision                | test_provision                                    | shell / workspace-settings             |
| workspace-create                 | test_provision                                    | workspace-settings                     |
| membership                       | test_membership_rules, test_roles                 | admin, workspace-settings              |
| non-owner-gating                 | test_roles, test_membership_rules, test_rules     | admin, settings                        |
| project-crud                     | test_rules, test_provision                        | items, workspace-settings              |
| task-crud                        | test_task_rules                                   | items, composer, peek                  |
| decisions-crud                   | test_scope, test_rules                            | (composer/items — items-only v1)       |
| documents-scope                  | test_documents, test_scope                        | (items-only v1)                        |
| dual-scope-rescope               | test_scope                                        | items                                  |
| drafts                           | test_rules, test_scope                            | items, trash                           |
| decision-draft-visibility        | test_rules, test_scope                            | (backend-rule; no dedicated screen)    |
| realtime-xctx                    | test_realtime                                     | realtime                               |
| reconnect                        | test_realtime                                     | realtime (kill/restart gate)           |
| **prod-smoke**                   | — (live-prod browser check; **no battery analog**)| **RETARGETED in TASK-020.07**          |

## decision-012

- **Slug:** `decision:decision-012`
- **Title:** decision-012: Backlog vocabulary is closed and the Definition of Done is code

Status: Accepted

### Context

`backlog/config.yml` stated 18 of the ~25 keys the CLI actually reads, and the CLI **fills
every omitted key with its own default the next time it writes the file** (a bare `backlog
config list` rewrote a scratch config and silently set `max_column_width: 80`). So the
config was not the control surface it looked like.

Two further facts, proved against v1.48.0 (recorded in `backlog/LESSONS-LEARNED.md`):

- `statuses`, `priorities` and `types` are **hard-validated** by the CLI and normalised
  case-insensitively to the configured casing (`--priority HIGH` → `priority: high`).
- **`labels` are not validated at all.** With `labels: ["backend","frontend"]` configured,
  `backlog task create t1 -l totally-made-up` succeeded and wrote that value to frontmatter.
  Configured labels only feed autocomplete and filters.

The result on the board was 19 distinct label values doing three different jobs at once:
area (`backend`, `frontend`, `web-next`), kind (`bug`, `testing`, `docs`, `cleanup`), and
campaign (`wave-1`…`wave-4`) — the last of which now duplicates the `m-0`…`m-3` wave
milestones outright.

Meanwhile the five `definition_of_done` defaults were prose that fired on every task
regardless of what it touched (react-doctor and the full backend battery on docs-only
tasks), and one of them was **not satisfiable**: `react-doctor` scores `web-next` at 67/100
with 1 error and 75 warnings, so "zero bugs and score ≥90" had never been true. A DoD that
cannot be met is not a gate, it is decoration.

### Decision

Accepted as recorded on this card; no separately dated owner ruling is on the record — the
four rulings below were adopted and executed in the same change.

**1. Two orthogonal axes, both declared in config.**

- `types` = the **kind** of work — `feature`, `bug`, `test`, `chore`, `docs`, `spike`.
  Chosen for this axis because the CLI validates it for free.
- `labels` = the **area or campaign** — `backend`, `frontend`, `contract`, `ops`,
  `tooling`, plus the qualifiers `a11y` and `v2`.
- Time-boxed campaigns are **milestones**, never labels: `wave-N` labels are removed in
  favour of `m-0`…`m-3`.
- `priorities` = `high`, `medium`, `low` (lowercase, matching the values already on disk).

**2. Every key the CLI reads is stated explicitly, in the CLI's own serialization order.**
Nothing is left to default, and a CLI rewrite of `config.yml` is a byte-identical no-op —
which also ends the churn diffs. `config.yml` therefore carries **no comments**: the
serializer rebuilds the file from scratch and would drop them. Deliberately omitted (they
have no default, so omission is stable): `default_assignee`, `default_reporter` (proved not
to populate `assignee` on non-interactive create), `backlog_directory`, and `onStatusChange`.

**3. The Definition of Done is code.** The four defaults are commands, and the first one is
the gate: `bash scripts/dod.sh` (`make dod`). It derives scope from the paths actually
touched (working tree + commits not on `origin/main`), runs only the gates that scope
requires, prints ✅/❌ per gate and exits non-zero naming the failures. `e2e` is opt-in
(`SCOPE=…,e2e`) because CI runs it on every push. Task-specific gates are still added per
task with `--dod`, which appends to these defaults — never `--no-dod-defaults`.

The react-doctor gate becomes `--scope changed --base origin/main --blocking error`: **do
not introduce new errors**, which is enforceable today, instead of an absolute score the
repo has never met. Raising the absolute score stays separate work.

**4. The label gap is closed by an opencode plugin hook, not a git hook.** Agents are the
only writer that matters here, and a `tool.execute.before` hook can refuse the command
*before* a bad value ever reaches a file — a pre-commit hook can only complain afterwards.
`.opencode/plugins/backlog-guard.ts` reads the vocabulary from `config.yml` (single source
of truth, no second copy) and blocks three things: off-vocabulary label values on `backlog
task create|edit`, `--no-dod-defaults`, and direct `write`/`edit` of CLI-managed backlog
markdown.

`onStatusChange` was considered for enforcement and rejected: it runs `sh -c` with
`TASK_ID`/`OLD_STATUS`/`NEW_STATUS`/`TASK_TITLE`, but it is **advisory** — a callback
exiting 1 logs an error and the transition still applies (proved). Nor does the CLI require
DoD checkboxes to be ticked before a task reaches `Done`.

### Consequences

- Every value on the board now comes from a closed list, and the two CLI-validated axes
  (`types`, `priorities`) are enforced by the tool itself.
- **Declared bound:** the guard covers opencode sessions in this repo only. A human editing
  a task file by hand, another agent runtime, or CI can still write an off-vocabulary label.
  Accepted: agents are the primary writer, and the reviewable artifact is the diff.
- `make dod` is the one command that answers "is this done?", so DoD verification stops
  depending on an agent remembering the right five commands for the scope it touched.
- Adding a vocabulary value is now a deliberate act: edit `config.yml`, and say why here or
  in the task. Adding one by accident is impossible in an opencode session.
- `config.yml` is hand-edited for the four list fields (`backlog config set` does not accept
  `labels`/`statuses`/`types`/`priorities`/`definition_of_done`/`onStatusChange`) — this is
  not a violation of "the CLI is the only writer", which governs task/doc/decision records.

## decision-013

- **Slug:** `decision:decision-013`
- **Title:** decision-013: OAuth2 login hook verified+auto-link path: permanent manual-operation coverage disposition

Status: Accepted

### Context

`pb_hooks/oauth.pb.js#onRecordAuthWithOAuth2Request` enforces two behaviours keyed on
GitHub's provider-verified email: (a) mark a first-time OAuth signup `verified=true` so
it isn't locked out by the `users` authRule, and (b) auto-link a verified email to an
existing `users` record instead of minting a duplicate account. `tests/test_oauth.py`
already proves everything headlessly reachable — provider config, PKCE authURL shape,
the `/api/oauth2-redirect` endpoint, secret non-leakage — and its own docstring names
what it cannot reach: "NOT provable here (needs a real GitHub login in a browser): the
full consent round-trip, verified=true on a fresh OAuth record, account-linking, and
profile-populated name/avatar." PocketBase's OAuth2 flow requires a live upstream
provider round-trip (real GitHub consent screen, real authorization code, real token
exchange); there is no supported PocketBase mechanism to inject a synthetic
`e.oAuth2User` into `onRecordAuthWithOAuth2Request` without that live exchange, so a
deterministic in-suite test cannot reach this callback's body at all — only mocking the
entire GitHub OAuth2 provider (a fake upstream server standing in for github.com) could,
which is a materially different and heavier commitment than every other suite in this
repo makes.

### Decision

`hook:oauth.pb.js#onRecordAuthWithOAuth2Request:users` is **permanently dispositioned as
manual-operation** rather than test-landed. It stays proven by manual verification against
a real GitHub OAuth app (prod or a scratch GitHub OAuth app pointed at a local tunnel) —
not by an automated suite — because a deterministic, in-process test cannot reach it
without either a live GitHub round-trip or a full provider-mock harness this project has
not built. `scripts/gen_coverage.py`'s `UNCOVERED` entry for this capability is re-pointed
from `TASK-013.03` to `decision-013` (this ruling) so the allowlist reference no longer
implies open work.

Owner authorized this permanent manual-operation disposition on 2026-07-30, when
authorizing completion of all nine TASK-013 subtasks. TASK-013.03 closes as a ruling rather
than a landed test; its own acceptance criteria are satisfied by this ruling existing and
the allowlist re-point.

### Consequences

- The capability stays outside the automated battery permanently, not pending a future
  test; `docs/coverage.md`'s dispositioned-uncovered table cites `decision-013`.
- Any change to the hook's verified/auto-link logic needs a manual GitHub-login smoke
  check before shipping (dev flow: real GitHub OAuth app credentials in
  `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, sign in, confirm `verified=true` and
  linking behaviour on the resulting `users` record) — there is no CI gate for it.
- If PocketBase ever exposes a way to synthesize an `e.oAuth2User` for testing, or this
  project builds a GitHub-provider mock harness, this decision should be revisited and
  the allowlist entry replaced with a real `# COVERS:` claim.

## decision-014

- **Slug:** `decision:decision-014`
- **Title:** decision-014: Approving a new account is an app-administrator power, not a workspace-admin one

Status: Accepted

### Context

`users.approved` is the gate PocketBase's `authRule` enforces alongside `verified` before
**any** login succeeds — password or OAuth alike (`v1:1785150100_users.js:169`,
`"authRule": "verified = true && approved = true"`). It is an **app-wide** switch: until it
flips, that person cannot reach the app at all, in any workspace.

Two facts make the obvious implementation wrong.

**Nothing can flip it over the API today.** `users.updateRule` is
`id = @request.auth.id && @request.body.approved:isset = false`
(`v1:1785150100_users.js:13`) — a user may patch only their own record, and the
`:isset` guard explicitly forbids `approved` even there. `createRule` carries the same guard.
So the only path is a superuser hand-editing the record in the `/_/` dashboard. TASK-017.21
exists to end that.

**The existing admin tier is the wrong shape to borrow.** `web/app/admin`'s MembersSection
already has an approve action, but it governs `workspace_members.status`
(`pending_approval → active`), which is **per-workspace**. Meanwhile every signup
auto-provisions its own workspace and makes that person its owner
(`pb_hooks/main.pb.js`, the auto-provision hook). Reusing the workspace-admin tier for an
app-wide switch therefore hands the power to *everyone who signs up*: a stranger, admin of
nothing but their own personal workspace, could unlock any other pending account app-wide.
That is privilege escalation across the tenant boundary — the same class of bug caught in
review during TASK-008.08, where a per-tenant realtime topic name turned out not to be
enforcement on its own.

### Decision

**Approval authority is app-level.** Only accounts on an explicit app-administrator list may
see or approve pending accounts. Being an owner or admin of a workspace confers no approval
power whatsoever.

The list is seeded with the project owner and is the single place approval authority is
granted. The approve action is a custom route: PocketBase custom routes bypass collection
rules, so the handler scopes on `e.auth` itself (CLAUDE.md, "Custom routes BYPASS collection
rules") — the `users.updateRule` guard above stays exactly as it is, and no collection rule is
weakened to make this work.

Owner ruled 2026-08-06:

> "for now just app administrators. later will explore how can open up and manage growth. i
> only plan to open up to family and friends in near future."

### Consequences

- The escalation path described above is closed by construction rather than by a rule
  predicate that a later refactor could weaken.
- Cost is one settings field and a route; the rejected alternative (reuse workspace
  owner/admin) was cheaper to build and is why it was offered.
- **Approval does not scale past the family-and-friends stage**, by design and with the owner's
  eyes open. A growth path — self-service, invite codes, or a delegated approver tier — is
  deliberately unbuilt and unblocked by this ruling; revisit when the audience widens.
- Approving remains a human act. Nothing here auto-approves.

### Alternatives rejected

- **Any workspace owner/admin may approve anyone.** Simplest, reuses the tier the members
  screen already has. Rejected: it grants an app-wide power from a per-workspace role, and
  self-signup makes everyone a workspace owner.
- **Scope approval to users pending in a workspace you administer.** Safe, but does not solve
  the actual case: a fresh signup holds no membership in anyone else's workspace, so nobody
  could ever approve them.

## decision-015

- **Slug:** `decision:decision-015`
- **Title:** decision-015: RefineProvider mount point: root layout vs authenticated-area layout

Status: Accepted

### Context

TASK-038's root-cause diagnosis (2026-08-06): `web/app/layout.tsx` mounts `RefineProvider`
over the whole app, and its `<React.Suspense fallback={null}>` around `<Refine>` bails out
of every static prerender (`@refinedev/nextjs-router` calls `useSearchParams()` →
`BailoutToCSRError`). Every statically-prerendered route ships as an empty shell — proven
on the built app for all five auth pages and `/_not-found`. Dynamic routes are unaffected.
Only the authenticated area actually uses Refine hooks; the auth pages don't.

Options weighed:

1. **`fallback={children}`** (one line in `refine-provider.tsx`) — validated end-to-end in a
   clean room by TASK-038's builder; renders the static shell without Refine context.
   Rejected: it double-mounts the tree (fallback and content are the same
   children), and a keystroke typed into the pre-hydration form can be lost when hydration
   swaps the fallback for the Refine-context render.
2. **Move `RefineProvider` off the root layout** so only the authenticated area (`w/`,
   `admin/`) mounts Refine — likely via an `(app)` route group with its own layout. The
   clean end state: auth pages prerender statically with real markup, `_not-found` is fixed,
   no trickery. Cost: a route-group restructure with app-wide e2e re-proof.
3. **`force-dynamic` on `app/(auth)/layout.tsx`** — request-time rendering for the auth
   group; real forms in the served HTML with no double-mount risk, smallest diff.
   Leaves `_not-found` blank and the root cause in place.

### Decision

**Option 2 — relocate `RefineProvider` off the root layout — is the end state.** Owner
ratified it 2026-08-06.

Option 3 shipped first as the interim tactical fix under TASK-038 (a session ruling): auth
pages render per request, and TASK-038's leaf-scoped `useSearchParams` readers stay, which is
exactly what lets the auth group drop `force-dynamic` once the relocation lands. TASK-043
tracked the relocation work, with normal backlog prioritization deciding when it was picked up.
Option 1 was weighed and rejected for the double-mount/lost-keystroke risk described in Context.

The relocation is **built**, verified against the tree on 2026-08-13 (see Later record).

### Consequences

- Auth pages were request-rendered under the interim fix (negligible load; they are light and
  low-traffic); with option 2 built, `force-dynamic` is gone from the auth group.
- `/_not-found` shipped blank while the interim fix stood. Whether it now renders was **not
  re-checked** in the 2026-08-13 pass — stated as unverified, not as fixed.
- Any statically-prerendered route inherited the blank-shell bug until option 2 landed.

#### Later record

**Not open, and already executed.** Checked during the PBTT-324 re-validation pass, 2026-08-13.

The HANDOFF card (PBTT-261) at that time routed the next session here to make a ruling,
describing this card as "mislabeled 'accepted'; body says 'Open for the owner'". That reading
took the older `## Decision` section as current. It wasn't — this card used the same
resolved-leading-blockquote convention the HANDOFF itself clears on
decision-005/006/007/008/017, recording the 2026-08-06 ratification of option 2. That
contradiction between the two layers is what produced the false HANDOFF entry; this record now
states the ruling once, in the Decision section above.

**Option 2 is not merely ratified, it is built.** Verified against the tree:

- `web/providers/refine-provider.tsx:15` defines `RefineProvider`.
- Its only mount is `web/app/(app)/w/[workspace]/layout.tsx:7,19,21` — inside the authenticated
  area, which is exactly what option 2 called for.
- `web/app/layout.tsx` renders a bare `{children}` in `<body>`; no provider wraps the root.
- No `force-dynamic` remains in `web/app/(auth)/layout.tsx` — the interim option-3 fix was
  removed, as the ruling anticipated.

So there is nothing here for the owner to rule on and no relocation work left to schedule.

One follow-up this leaves, and it is not a ruling: the consequence "`/_not-found` still ships
blank until TASK-043 lands" should be re-checked, since the condition it was contingent on has
now been met. Not verified in that pass — stated as unchecked, not as fixed.

Method note: an earlier check in that session appeared to show the provider mounted under a
one-letter component name. That was a tooling artifact — `rg -r` is `--replace`, not
`--recursive`, so the pattern was being rewritten in the output. The findings above come from a
re-run without that flag. — [root, session fe052b42-0438-40a3-8bb4-94a2713bbb4b]

## decision-016

- **Slug:** `decision:decision-016`
- **Title:** decision-016: No-JS login submit: real server-side sign-in or explicit JS-required feedback

Status: Accepted

### Context

TASK-044 (found by the TASK-038 adversarial review, 2026-08-06): with the auth forms now
server-rendered, a scripting-disabled visitor's native login POST reaches `/login`, which has
no POST handler — the server re-renders the page with a 200, no `Set-Cookie`, no error. The
user is silently not signed in. Resolving it needs a product ruling, not just a fix.

#### Options weighed

- **A — true no-JS sign-in:** a server-side POST handler on the login route performs the
  auth against PB and sets the session cookie (the proxy login route already contains the
  auth + cookie logic to reuse). Larger surface: must handle `account_not_ready`, bad
  credentials, and redirect behavior without client JS, and TASK-043's static-prerender end
  state must not regress it.
- **B — explicit JS-required feedback:** the form (or the POST response) tells no-JS
  visitors that sign-in requires JavaScript. Honest and small, but a no-JS user can never
  sign in.

### Decision

**Option A — true no-JS sign-in.** Ruled by the owner on 2026-08-06: "server side seems
like it would be more secure and provide less attack surface... unless compelling reason to
not do server side, proceed with server side fix."

**Correction on the stated rationale, recorded so the reasoning does not propagate.** The
security framing is inverted: the authentication already happens server-side today. The
browser's `fetch` posts to a Next route handler that talks to PocketBase and sets an httpOnly
cookie; no credential check happens in client JS. Option A therefore does not move auth from
the client to the server, because it was never on the client. It adds a **second** entry point
into the same auth logic, which is a mild *increase* in surface, not a reduction.

The decision still stands on its real merits: progressive enhancement (the form works when JS
fails to load, is blocked, or errors during hydration), no silent dead-end, and honest form
semantics — a `method=post` form that nothing handles is a lie in the markup. Browsers without
JS are rare; browsers where JS *failed* on a given page load are not, and that is the case this
actually serves.

Two obligations follow from it being a second entry point, and both are TASK-044 acceptance
concerns rather than optional polish:

- **No drift between the two paths.** The native POST must reuse the existing handler's logic,
  not re-implement it. It has to reproduce the `account_not_ready` branch (decision-014 /
  `authRule`), or a locked-out account gets told its password was wrong.
- **Login CSRF.** A native cross-origin form POST can log a victim into an attacker's account.
  Low severity, but it is a class the `fetch` path largely avoided by construction and the form
  path does not.

#### Implementation constraint discovered while ruling this

Next's App Router will not accept both `app/(auth)/login/page.tsx` and a `route.ts` at the same
path, so "add a POST handler to /login" is not literally available. The implementer picks
between a **Server Action** (which Next progressively enhances to work without JS) and posting
to a **distinct endpoint** that 303-redirects back. Whichever is chosen must not regress
TASK-043's static prerender of `/login` (decision-015) or TASK-029's guarantee that credentials
never reach the query string. Verify the prerender survives rather than assuming it.

### Consequences

TASK-044 proceeds under option A with the two obligations above folded into its acceptance
criteria, plus an e2e test at `javaScriptEnabled: false`. TASK-043's static-prerender end state
is a constraint on the solution, not a blocker.

## decision-017

- **Slug:** `decision:decision-017`
- **Title:** decision-017: Workspace URL keying: slug vs id (DRAFT-016)

Status: Accepted

### Context

DRAFT-016 asks for workspace URLs "constructed from the unique identifier instead of
name because name is not guaranteed to be unique." Recon (2026-08-07) shows the premise
is stale: URLs are keyed by **slug**, not name, and the slug is already unique.

- `[workspace]` route param holds a slug; links are built as `/w/${workspaceSlug}/…`
  (`web/lib/shell/nav-model.ts:51,58,59,65`) and resolved by client-side
  `find(w => w.slug === workspaceSlug)` (`InboxScreen.tsx:36`, `TrashScreen.tsx:38`,
  `WorkspaceSettingsScreen.tsx:43`, `web/lib/show-context.ts:75`).
- `schema/workspaces.json` enforces `CREATE UNIQUE INDEX idx_workspaces_slug ON
  workspaces (slug) WHERE slug != ''`; slug is derived on create from the name with
  deterministic collision suffixing (-2, -3, …) and a record-id fallback for empty
  names — proven by `tests/test_workspace_slug.py`.
- The only remaining sharp edge: editing the slug changes every `/w/<slug>/…` URL with
  no redirect from old links — deliberate and documented in user-facing copy
  (`web/resources/workspace-settings.ts:16`; `WorkspaceSettingsScreen.tsx:110` does
  `router.replace` to the new slug).

So the uniqueness problem DRAFT-016 names does not exist. What id-keyed URLs would
actually buy is **link stability under rename** (and dropping the slug machinery), at
the cost of opaque URLs. A middle option exists: keep slugs, add redirect-from-old-slug
canonicalization.

#### Options weighed

1. **Keep slug-keyed URLs, archive DRAFT-016** (status quo; uniqueness already
   guaranteed; rename-breaks-links stays documented behavior).
2. **Switch to id-keyed URLs** (stable under rename; touches every site in the recon
   list — nav-model, six screens, show-context, AppShell; slug field/test retired or
   kept purely cosmetic).
3. **Keep slugs, add legacy-slug redirects** (stability without opaque URLs; needs a
   slug-history mechanism server-side).

### Decision

**Option 2 — id-keyed URLs.** Ruled by the owner on 2026-08-07. Standing ruling: a text name
is a display name only, never a key. That covers a name-*derived* lookup string as well,
so slug-keyed addressing goes. Execution is TASK-093, sequenced AFTER TASK-085 merges.

Note the resolution arrives for a reason this decision's own recon did not have. That recon
concluded "URLs are keyed by slug, and the slug is already unique" and rated the sharp edge
as merely rename-breaks-links. Both halves turned out to be too generous:

- The shell never read the stored slug. `buildSession` derived one from the *name*
  (TASK-084), so every account after the first addressed its whole shell at the FIRST
  account's workspace. Fixed 2026-08-07, but it means slug-keying had already failed in
  production once.
- **`projects` has no slug column at all** — no stored identifier, no uniqueness index.
  Its URL slug is recomputed from the name on every read
  (`web/lib/proxy/handlers/projects.ts:39`) and resolved by client-side first match
  (`web/lib/show-context.ts:82`). Two projects named the same in one workspace collide and
  the second is unreachable. TASK-092. So "the slug is already unique" was true of
  workspaces and false of projects, which are half the path.

Option 1 (keep slugs) is therefore rejected on evidence, not taste: the invariant it rests
on was never enforced for projects and was not actually read for workspaces. Option 3
(slug history + redirects) was rejected as the most machinery for a property — readable
URLs — the owner does not require.

**Follow-on ruling (same day): the `workspaces.slug` column and its unique index are
DROPPED, not kept as a cosmetic field.** No vestigial columns. A field nothing reads still
costs a migration slot's worth of schema surface, still appears in `schema/`, `openapi.json`
and the model tree, still needs its hooks maintained, and still invites a future reader to
assume it means something. The three slug-derivation hooks in `pb_hooks/main.pb.js` and
`tests/test_workspace_slug.py` go with it. Verified before filing: `project_stats` does not
reference the column, so the detach-view-before-drop recipe does not apply.

### Consequences

DRAFT-016 was a draft while this was open (the CLI has no draft-edit; this decision is its
scoping record). `tests/test_workspace_slug.py` and the settings-screen copy are the coupled
artifacts to update — under the ruling above, both are retired with the column rather than
rewritten.

## decision-018

- **Slug:** `decision:decision-018`
- **Title:** decision-018: Quoted rule text in app_docs gets an exact-equality gate

Status: Accepted

### Context

TASK-062 found an `app_docs` record (`decision:project-stats-membership`) quoting a
`project_stats.listRule` that predated the TASK-051 anonymous-caller guard. An independent
sweep of every `app_docs` record then found three more stale quotes in other collections
(`collection:projects`, `decision:project-create-membership-guard`,
`decision:member-item-writes`).

Nothing caught any of them. `scripts/check_app_docs.py` gates *existence* — that every
collection has a record — and never inspects content. So the self-documenting collection
can drift arbitrarily far from the rules it claims to describe, and the only thing standing
between a reader and false documentation is someone noticing by eye.

The open question was whether this deserves a gate at all, given that `app_docs` prose is
mostly paraphrase and a gate over prose would be brittle.

### Decision

**Gate it, but only over quoted rule text, and only by exact field equality against
`schema/*.rules.json`.** Raised and resolved together during TASK-062 (PR #105) and ruled on
2026-08-07; the gate itself is TASK-074.

Not containment. This is the decisive point and it comes from the bug itself: the stale
`project_stats` quote was a literal **substring** of the live rule, because the TASK-051
fix was added as a *leading conjunct* (`@request.auth.id != "" && (…original…)`). A
`quoted in live_rule` check therefore passes the exact bug the gate exists to catch. Any
guard that is added by conjunction — which is the repo's dominant hardening idiom — produces
a stale quote that a containment check blesses.

Shape:

- A curated `(record_id, refName, ruleField)` registry, so only records that genuinely
  quote a rule are compared and paraphrase records are left alone.
- Exact equality of the quoted fragment against that field in `schema/*.rules.json`.
- **Fail closed:** an `app_docs` body containing rule grammar that is *not* in the registry
  fails the gate rather than being silently ignored, so a new quote cannot be added
  un-gated.

It reuses the existing offline `migrate up` + sqlite machinery, so it costs roughly 1-2s
and needs no server boot — cheap enough for pre-commit as well as the battery.

### Consequences

- Adding a quote to `app_docs` now costs a registry entry. That is deliberate friction: an
  unregistered quote is exactly the thing that rots.
- Prose paraphrases stay ungated, so the gate cannot police accuracy of description — only
  of verbatim quotes. `tasks`, for example, has eight records and quotes no rule syntax at
  all, so this gate says nothing about them. Prose accuracy remains a review-time concern.
- Rule changes now have a second coupled artifact to update, alongside `schema/`,
  `openapi.json`, and the model tree. Consistent with the existing migration coupling law
  in CLAUDE.md.
- Implemented by [TASK-074]; the drift it was born from was fixed in TASK-062 (PR #105).

## decision-019

- **Slug:** `decision:decision-019`
- **Title:** decision-019: projects.workspace immutability keeps a superuser exemption

Status: Accepted

### Context

TASK-071 made `projects.workspace` immutable — the enabling condition for the whole
dual-scope incoherence class that TASK-057 and TASK-075 guard against. The fix is a
Request-tier hook, and it carries a deliberate superuser exemption.

That leaves two ways past it, both by construction rather than oversight:

1. **A superuser** may still move a project between workspaces.
2. **Any programmatic save** — `e.app.save()` from a cron, route handler or hook — because
   `onRecord*Request` hooks do not fire for those at all.

The wave's adversarial reviewer audited every `routerAdd` site and every project write and
confirmed no live bypass exists today: nothing in the repo moves a project programmatically.

TASK-071's AC#1 as written asked for unqualified immutability. That is **not** what shipped,
and saying so is the point of this record.

### Decision

**Keep the exemption, and correct TASK-071's AC#1 wording to match what is actually
enforced.** Raised by the TASK-071 wave, ruled at session level on 2026-08-07.

Without the exemption there is no way to construct an incoherent row at all — and the
leaver-unassign sweep's `touchesScope` predicate exists precisely to *tolerate*
already-incoherent rows without stranding every remaining assignee. Removing the operator's
ability to produce that state would leave a guard whose reason for existing could no longer
be exercised, tested, or recovered from.

The honest statement of what is enforced: **immutable for every tenant actor over the
collection API; superuser- and programmatic-save-exempt.** `scripts/model/target/projects.yml`
already says exactly this. AC#1 is the artifact that overstates, so AC#1 is what gets
corrected — not the code.

### Consequences

- A tenant, including a workspace owner or admin, cannot move a project between workspaces.
  That closes the only public-API route to an incoherent record.
- An operator retains the ability to produce one, deliberately. Recovery from a legitimate
  mis-scoped project stays possible without a migration.
- **The programmatic exemption is a standing hazard, not a feature.** The moment any code
  moves a project via `e.app.save()`, this guard is silent. If that day comes, the guard
  belongs on the universal tier like the TASK-075 family — and it will need its own
  `touchesScope`-style predicate for the same leaver-sweep reason.
- A criterion that overstates enforcement is worse than none, because it reads as proven.
  Recorded here rather than quietly ticked. See also [[decision-018]] for the same instinct
  applied to documentation drift.

## decision-020

- **Slug:** `decision:decision-020`
- **Title:** decision-020: A hand-created workspace gets no default project

Status: Accepted

### Context

TASK-085 adds a way to create a workspace from the GUI, which raises a question the
codebase had never had to answer: does a hand-created workspace get the same "My
Project" seed that a brand-new account gets?

Three hook sites create a default project today, and all three are keyed on *the user
having no workspace at all*, never on a workspace being created:

- `pb_hooks/main.pb.js:331` — user-create auto-provision (the first workspace).
- `pb_hooks/main.pb.js:511` — last-workspace reprovision, when a user's only workspace
  is deleted.
- `pb_hooks/trash.pb.js:257` — last-workspace reprovision via the trash path.

No hook fires on a plain `workspaces` create. Proven in a clean room: a plain user token
POSTing to `/api/collections/workspaces/records` returned 200 with `default_project: ""`
and no project record.

### Decision

**Only the first/default workspace seeds a default project; every other workspace starts
empty and the user creates its projects.** Ruled by the owner on 2026-08-07.

Keep the current behaviour as it is. A workspace created deliberately by a user gets **no**
default project. The seed exists to stop a *fresh account* dead-ending on an empty board
(#57); someone who has just chosen to make a second workspace has already found the app and
does not need to be handed a "My Project" they did not ask for and must then delete.

### Consequences

- TASK-085 must not add default-project creation to the new `POST /workspaces` handler.
  The correct implementation is the one that does nothing extra.
- **This ruling has a prerequisite the tree does not yet meet.** `web/` has no
  create-project affordance at all: `POST /projects` exists in the seam
  (`web/lib/proxy/registry.ts:54`, handler at `web/lib/proxy/handlers/projects.ts:108-125`)
  but nothing in the UI calls it, and `buildNav` omits the Projects section entirely when
  the list is empty (`web/lib/shell/nav-model.ts:45`, "hide, never fake"). So an empty
  workspace currently renders a sidebar with no mention of projects and no way to make
  one. Shipping workspace-create without a project-create affordance would turn every
  new workspace into a dead end — the ruling *requires* that affordance, so TASK-085
  carries it.
- The three provision hooks stay as they are. A reprovisioned last-workspace is still the
  user's first/default workspace, so seeding it remains consistent with this ruling.

## decision-021

- **Slug:** `decision:decision-021`
- **Title:** decision-021: Workspace scope: the URL is the source of truth, the cookie is a landing hint

Status: Accepted

### Context

Two facts in the current build are in direct tension, and TASK-091 is where they collided.

**decision-017 made the URL the key.** Every workspace and project address is keyed by an opaque
record id; a text name is a display name only, never a key. The point of that ruling was
addressability.

**But workspace scope actually lives in a browser-global `ws_id` cookie.** The proxy seam scopes
every list by `ctx.session.wsId` (`web/lib/proxy/handlers/projects.ts:76`), not by the URL segment,
while a screen's chrome is built from the URL-matched workspace object
(`web/lib/show-context.ts:74-75`, `InboxScreen.tsx:94`). So the address and the data had two
different sources, and `w/[workspace]/layout.tsx` had no check that they agreed. Pressing Back
after a workspace switch rendered one workspace's chrome over another workspace's data — the same
cross-tenant-confusion class that waves 7 through 9 spent three releases closing.

TASK-091 shipped the coherence fix: the route boundary now redirects when the URL's workspace
disagrees with the cookie. That is strictly better than rendering one tenant under another's
chrome, and it is what `main` does as of wave 10 release 2 (PR #129).

It also makes a product commitment nobody had written down, which is why this record exists:

- Two tabs can no longer hold two different workspaces. `ws_id` is browser-global, so switching in
  tab B bounces tab A to `/` on its next navigation.
- A teammate's deep link to a workspace you legitimately belong to lands at `/`, silently — no
  toast, no explanation. Prior behaviour was incoherent chrome; new behaviour is a silent bounce.

**Adopt-the-address was investigated and is not available at that tier.** `next@16.2.11` throws
`Cookies can only be modified in a Server Action or Route Handler`
(`request-cookies.js:53`), so a Server Component layout physically cannot adopt the address it was
given. The variant that *is* implementable — bouncing through a Route Handler that adopts the URL's
workspace — trades the data bug for a two-tab thrash bug, because each tab would steal the cookie
back on every navigation. That is not an improvement.

**Prior art (owner ruling, 2026-08-08).** Linear, which this app increasingly resembles in
functionality, puts the workspace in the URL and treats it as the source of truth: switching
workspace navigates, and two tabs on two workspaces simply work. That is the shape this decision
adopts. The owner's standing instruction — recorded in `CLAUDE.md` — is that design questions of
this kind should be answered by looking at how Linear and comparable tools solved them, rather than
reasoned from first principles in isolation.

### Decision

**The URL segment becomes the source of truth for workspace scope. The `ws_id` cookie is demoted to
a landing hint** — it answers "which workspace should `/` send you to", and nothing else.

The direction was owner-approved on 2026-08-08; the carrier question — how a workspace id actually
reaches the seam — was ruled at session level the same day and is recorded under *Ruling* below.
Execution is TASK-109 (carrier + entitlement) and TASK-116 (route move): the direction is settled,
the build is not yet done.

Concretely, the target state:

- The proxy seam scopes by the workspace in the request's address, validated against the caller's
  reach (`canEnterWorkspace`, `web/lib/shell/workspace-options.ts:30-36`), not by `ctx.session.wsId`.
- An address for a workspace you can enter is served, whatever the cookie says. An address for a
  workspace you cannot enter is refused — the existing entry predicate already answers this and
  must keep answering it; loosening it is not part of this decision.
- The cookie is written on sign-in and on an explicit switch, read only when resolving a
  workspace-less route such as `/`.

The redirect shipped in TASK-091 is the correct **interim** behaviour and stays until this lands. It
is a symptom of the cookie being authoritative, not a cause, and it must not be elaborated in place
— specifically, do not build the Route-Handler adopt-bounce, which this decision supersedes.

#### Ruling (2026-08-08): the carrier, and what the redirect was actually holding up

The Decision above said the seam must scope by "the workspace in the request's address" without
saying how a workspace id reaches the seam. It does not reach it today at all: nothing in `web/`
sends one. `client.gen.ts:16` hardcodes `baseUrl` to `'/api/proxy'`, there is no interceptor, and no
workspace parameter appears anywhere in `types.gen.ts`. This section rules on that gap, on the
strength of a source recon run before any brief was written.

##### 1. The workspace rides in the URL PATH, authored once

The wire shape becomes `/api/proxy/w/{workspaceId}/…`.

**The deciding axis is the failure mode, not the churn.** A path segment fails **loud**: a request
that fails to carry a workspace does not match the route and 404s. A header or a query parameter
fails **silent** — `getSession()` would keep answering from the cookie, and a handler that forgot to
read the new carrier would go on quietly serving cookie-scoped data. That silent fallback is the
exact bug class this decision exists to end, so a carrier that can be forgotten without anyone
noticing is disqualified regardless of how much cheaper it is. `Referer`-derivation is rejected for
the same reason plus an undesigned absent-case.

The churn objection that made this look expensive is **withdrawn**: the segment is authored at the
**client base URL**, not by rewriting 30 path strings. The installed generator supports this — a
per-call `baseUrl` is merged over the client's config (`client.gen.ts:42-44`, `types.gen.ts:13-18,
62-66`) and every SDK function already accepts a per-call `client` override (`sdk.gen.ts:9,20`).
So `providers/dataProvider.ts`, already the single choke point for all CRUD, is the one authoring
site.

Binding constraints on the implementation:

- **`web/openapi.contract.json` must tell the truth about the wire.** The workspace segment is a
  server-level concern, so it belongs in `servers`, not in the paths.
- **The 30 paths and `registry.test.ts:10-12`'s `toBe(30)` must not churn.** If a proposed
  implementation moves that number, it has put the segment in the wrong place.
- **`baseUrl` may not be a function** in this generator (`types.gen.ts:137-138` types it `string`),
  and a global `setConfig()` swap is rejected: it is mutable module-singleton state on a
  concurrent-rendering path. Close the workspace id over the data provider instead.
- `route.ts:24-36`'s segment math shifts either way — that cost was never avoidable.
- Two callers bypass the generated client (`admin/PendingAccountsSection.tsx:11,47,60`,
  `form/DangerZone.tsx:35-36`) and `AppShell.tsx:17-33,63-68` skips `/api/proxy` entirely. They must
  be converted or explicitly dispositioned; a bypass that keeps reading the cookie re-opens the hole.

Realtime is already correct and is the precedent, not an exception: `subscribeToItemEvents` scopes
`rt:project_items:{workspaceId}` from the URL-derived prop. The two halves of the app currently
disagree, and this makes the data half match the realtime half.

##### 2. The redirect was masking a session that fabricates membership

`w/[workspace]/layout.tsx:21` is the only line in the render path that compares the URL's workspace
to the caller's entitlement, and removing it is DoD #9 of the executing task. Recon establishes what
that line is really holding up, and it is not what we assumed:

- **PocketBase's own rules already refuse a genuinely foreign workspace.** Every relevant rule
  requires owner-or-member and the six handlers pass the *caller's* token, so a non-member gets
  200-empty or 404 from PB itself. Deleting the redirect does **not** open a cross-tenant data leak
  for the proxied resources.
- **But `buildSession` fabricates entitlement.** `web/lib/proxy/session.ts:161` swallows a denied
  `pbGet("workspaces", …)` with `.catch(() => null)`, and `:169`/`:201` default a caller with no
  membership row to `role: "member", status: "active"`. So a denied workspace renders as an
  authenticated, active member. **This is a defect that exists today**, masked by the redirect.
  **A deny must be a refusal, never a default** — that is a precondition of removing the line, and
  it lands in the same change.
- **No rule anywhere checks `workspace_members.status`.** A suspended member satisfies every PB
  rule identically to an active one, and the app's only status gate (`guardSession`) is called from
  `AppShell` and two pages — **never from the proxy route**. So a suspended member's API calls are
  unguarded right now. That is a live gap independent of this decision; it is filed separately and
  must not be smuggled into the carrier change.

The replacement for the redirect is therefore a `canEnterWorkspace(URL-workspace)` check **at the
proxy boundary**, where every request passes, rather than at a page layout, which most requests skip.
TASK-099's subsumption closure depends on unreachable addresses being refused; that guarantee must
survive, and moving the check onto the request path strengthens it rather than preserving it.

##### 3. Workspace-scoped surfaces belong under the workspace segment

`/`, `/admin` and `/settings` sit outside `w/[workspace]/` yet call workspace-scoped resources —
`useCreate` on projects (`NewProjectForm.tsx:19`), `useList` on memberships and workspaces
(`AdminScreen.tsx:20-24`), `useList` on saved views and projects (`SettingsScreen.tsx:29-31`). They
have no workspace in their address, so under a URL-authoritative rule they cannot be scoped at all.
They are the reason `RefineProvider` sits at `(app)/layout.tsx:8`, above the segment, which is in
turn why the route param cannot reach the data layer.

Prior art settles the direction: **Linear puts member administration and workspace settings under
the workspace key**, and this app is converging on Linear by the owner's standing instruction. So
workspace-scoped surfaces move under `w/[workspace]/`, and `RefineProvider` moves down with them;
genuinely account-level surfaces (profile, theme) may stay outside and must then stop calling
workspace-scoped resources.

**This is a route move, not a carrier change, and it is a separate task.** It is recorded here
because it is the reason the provider placement blocks the carrier, and because doing the carrier
first without knowing this is coming would invite an interim hack.

##### Correction to a recorded premise

`web/lib/proxy/guard.ts` **does not exist**; the proxy dispatcher performs no guard call at all. The
guard module in this tree is `web/lib/auth/guard.ts`, and it is page-render tier only. Any brief
listing `web/lib/proxy/guard.ts` in a blast radius is quoting a file that was never there.

### Consequences

- Removes the whole class rather than the instance: multi-tab, shared deep links, and Back-button
  coherence all stop being separate problems, because there is only one source of scope.
- Restores what decision-017 was for. Id-keyed URLs that a second session cannot open are only
  half a ruling.
- **Not free, and not small.** Every seam handler that reads `ctx.session.wsId` has to take the
  workspace from its address instead, and the reach check moves onto the hot path of every scoped
  list. That is a backend-seam change with a real blast radius, which is why it is a task of its
  own and not a widening of TASK-091.
- The interim redirect stays user-visible until then, including the silent bounce. Accepted
  deliberately: it is strictly safer than the defect it replaced.
- Watch for the inverse failure while this is open — a handler that trusts the URL *without* the
  reach check is a cross-tenant read. TASK-099 was closed as subsumed precisely because the route
  boundary refuses unreachable addresses today; that guarantee has to survive the migration, or
  the per-screen guard comes back.

## decision-022

- **Slug:** `decision:decision-022`
- **Title:** decision-022: Railway native auto-deploy supersedes custom Actions deployment

Status: Accepted

### Context

The custom deployment workflow was introduced after observations that Railway's CI-check timing
could fail open or leave a failed deployment skipped after a green rerun. It called the
undocumented `serviceInstanceDeployV2` mutation with an unattended Railway API token.

On 2026-08-09 the owner rejected those timing observations as untrusted/fluke evidence and
explicitly chose Railway's native GitHub integration instead. A live status readback showed
auto-deploy enabled for both production services, while Railway configuration showed
`source.checkSuites: true` on both.

### Decision

**Use Railway native GitHub auto-deploy for production, retaining `source.checkSuites: true`.**
Ruled by the owner on 2026-08-09: Railway native GitHub auto-deploy remains the production
trigger, and the custom Actions GraphQL deploy path is retired.

It is the owner-approved, supported path; the custom API-token Actions mechanism is retired and
must not be recreated.

The earlier fail-open/fail-closed observations remain historical context in
`docs/ops-recipes.md`; they do not justify a competing production trigger.

### Consequences

- The GitHub `Deploy` workflow is disabled. Its local source deletion is an ordinary pending
  repository change, not a replacement deployment path.
- Do not retain or add an unattended Railway token for deployment automation.
- A later watched-path change should be observed through Railway's native integration; manual
  redeploys remain recovery operations, not deploy-gate evidence.

## decision-023

- **Slug:** `decision:decision-023`
- **Title:** decision-023: A member-created project cannot be updated by its creator — is that intended?

Status: Accepted

### Context

`schema/projects.rules.json` lets any non-viewer member CREATE a project and stamps
`owner = @request.auth.id`, but `updateRule`/`deleteRule` carry no project-owner path —
only workspace owner or workspace-admin role. So a plain member who creates a project can
never rename, configure, or delete it (verified by readback 2026-08-10; the `owner` field
exists on the record and is used by nothing in these two rules).

Prior art (per the CLAUDE.md prior-art law):

- **kaneo #452** hit exactly this shape — a member who created a project was blocked from
  its settings — and treated it as a bug (creator ≠ implicit admin mismatch).
- **Linear** (from model knowledge, not a live check): project attributes (name,
  description, lead, targets) are editable by workspace members generally; admin roles
  gate workspace settings, not per-project edits. If we verify this live it should be
  restated here.

Options weighed:

1. Add `owner = @request.auth.id` as an OR-branch to `updateRule` (and possibly
   `deleteRule`), keeping the existing workspace-owner/admin paths. Field locks
   (`workspace` immutability, decision-019) stay top-level conjuncts per the
   updateRule-evaluates-OLD-record law. The minimal delta that fixes the kaneo-#452
   asymmetry.
2. Widen to all non-viewer members (closer to Linear), making `owner` purely
   informational. The option that tracks Linear most closely.
3. Keep as-is (admin-gated project editing) and declare `projects.owner` display-only —
   then the field is decision-017-adjacent (a field with no authorization consumer).

### Decision

**Option 2 — widen project update rights to all non-viewer members, matching Linear;
`projects.owner` becomes purely informational.** Ruled by the owner on 2026-08-13 on the
sign-off form (PBTT-324 closure plan).

Prior art cited per the repo's standing rule: Linear lets workspace members edit project
attributes generally and gates admin roles at workspace settings rather than per project.
Kaneo #452 treated the creator-blocked-from-own-project shape as a bug. This ruling takes the
Linear shape rather than the minimal option-1 delta.

The premise was re-verified against the current tree before the ruling, not taken from the
card as written: `schema/projects.rules.json:5` still carries an owner-or-admin `updateRule`
with no creator branch, and `gen_schema.py --check` passes, so the schema is current.

**"Project ownership transfer" is rejected as a consequence.** Under option 2 the `owner`
field carries no authority, so transferring it moves nothing. That register row moves to
`rejected` citing this ruling. The owner was shown this coupling on the form and did not
dissent.

### Consequences

- `projects.updateRule` widens to non-viewer members; `deleteRule` needs an explicit call in
  the implementing card — the ruling names update rights, and deletion is a different risk
  profile worth stating rather than assuming.
- Field locks stay top-level conjuncts per the updateRule-evaluates-OLD-record law
  (decision-019 keeps `projects.workspace` immutable).
- `projects.owner` must be documented as informational so it is not later read as an
  authorization field — this is the decision-017-adjacent trap named in option 3 above.
- `tests/test_rules.py`-style role-matrix coverage for projects update/delete needs the
  creator-member row added; it is currently only provable as a denial.
- Option 3, had it been chosen, requires documenting `projects.owner` as display-only so it
  is not read as an authorization field — the same obligation the ruling carries anyway.
- Implementation is filed separately so this card closes as a decision rather than as work.

#### Delivery status (re-validated against the tree, 2026-08-13, PBTT-324 closure pass)

This card is cited as evidence by 2 rows in `docs/features.yml`. The card was already closed,
so rather than trust it, each citing row was re-checked against the current code. Both came
back **genuinely missing** — this card closed without delivering them. Full trail, including
the method for the wider 36-row sweep and its gate evidence (`gen_feature_register.py --check`
and `make dod SCOPE=docs` both exit 0), is in this card's comments.

- *A member who creates a project can then edit it* (Projects; register said `missing`).
  Evidence: `schema/projects.rules.json:5` updateRule is owner-or-admin with no creator
  clause; `gen_schema.py --check` clean. Proof rung: 3 of the PBTT-314 ladder (1 = a named
  test with its run output; 4 = a file existing, which is not proof).
- *Project ownership transfer* (Projects; register said `missing`). Evidence:
  `projects.owner` field exists but no transfer UI/handler/test; `memberships.ts:232` calls
  workspace ownership transfer explicitly unmodeled. Proof rung: 3 of the PBTT-314 ladder.

— [root, session fe052b42-0438-40a3-8bb4-94a2713bbb4b]

## decision-024

- **Slug:** `decision:decision-024`
- **Title:** decision-024: Sidebar reflects a project restore only after a real navigation — in-place refresh race left unfixed

Status: Accepted

### Context

TASK-133 (from TASK-100's restore leg): after restoring a trashed project on `/trash`,
`TrashedProjects.tsx` calls `router.refresh()` in place, and the server-rendered sidebar
intermittently keeps the pre-restore project list until a real navigation. Reproduced
2026-08-10: 0/10 failures on a bare restore, 3/12 on the full interaction flow (danger-zone
trash, conflict dialog, then restore) — the flake needs the fuller history.

Two diagnosis attempts failed honestly (evidence on TASK-133's notes):

- The Link-prefetch-storm hypothesis did not survive its own fix experiment:
  `prefetch={false}` on every sidebar Link produced 6/12 failures vs the 3/12 baseline.
  Reverted as unproven.
- The `net::ERR_ABORTED` trace marker the hypothesis rested on is not diagnostic — a
  passing run shows the `router.refresh()` RSC request with `status=200` AND
  `ERR_ABORTED`, because Next's RSC client cancels the stream reader after consuming the
  flight payload and Chromium's Network domain reports that cancel as a load failure.

The mechanism is therefore unknown. What is known: the committed workaround (the e2e
asserts the sidebar after a real navigation, and a user who navigates sees correct state)
is reliable for what it covers — but a third finding (2026-08-10, 2/16 solo runs) widened
the blast radius: the same race sometimes swallows the restore **toast** entirely (the
restore PATCH returns 200, `push(toast)` runs before `router.refresh()`, and no
`role="alert"` ever renders). So the user-visible defect is: nav text lagging until the
next navigation, plus an occasionally missing restore confirmation. The trash list itself
refetches reliably (the row leaves the list), so the action's outcome is always visible in
place — only the toast is lossy.

Prior art (house law): Linear keeps its nav/project list in client-held state that
mutations patch directly — there is no navigation-triggered server refetch in the loop, so
no fetch exists to lose a race against. Our sidebar is server-rendered per layout render
(`AppShell` → `fetchProjects`) while the rest of the app reads through refine's client
query cache; that split is why a full server round-trip is needed to update the nav at all.

### Decision

Accept the limitation for v1. The navigate-then-assert workaround stands; no further
speculative client patches (each costs an e2e wave to disprove). If in-place nav freshness
ever becomes a requirement, the fix is structural per the Linear prior art: move the
sidebar's project list into client-held state patched by mutations — filed as the
escalation path, not scheduled.

### Consequences

- TASK-133 closes as "reproduced, limitation recorded" per its AC#1.
- The e2e suite keeps asserting sidebar state only after a real navigation, and does NOT
  assert the in-place restore toast (`project-trash.spec.ts` asserts the trash-list
  refetch instead — the reliable in-place signal). Do not "strengthen" either assertion
  without this decision being superseded; the toast assertion was a ~12.5% CI flake.
- Anyone re-attempting a diagnosis starts from TASK-133's notes: the repro requires the
  full interaction flow, and `ERR_ABORTED` on RSC fetches must be ignored as noise.

---
**Label history — corrected 2026-08-13** (PBTT-324 housekeeping): this card's status label
read `Proposed` despite a completed Decision/Consequences section identical in form to
decision-025/026 (both `Accepted`). No content changed — only the stale label. This card
was always resolved; `docs/features.yml`'s citing row is being reclassified from `missing`
to `rejected` in the same pass.

## decision-025

- **Slug:** `decision:decision-025`
- **Title:** decision-025: Mobile and tablet are in scope for v1 — one breakpoint, sidebar becomes a drawer

Status: Accepted

### Context

The design packet designs nothing below ~1100px ("Narrow and mobile widths are
undesigned, not mobile by default. Raise it rather than improvising"). The 2026-08-10 UI
audit measured the consequence (DRAFT-022): at 390px the fixed ~240px sidebar clips
content to ~150px, tables lose columns, the login two-column layout wraps badly. The
draft was parked on an owner scope ruling.

Prior art per the CLAUDE.md law: **Linear** ships a reduced mobile web layout rather
than a redesign — the sidebar becomes an overlay drawer behind a menu button, lists go
single-column, information density drops, feature set stays. The kaneo mining (doc-003)
proved the same shape with exactly ONE breakpoint at 768px: below it the sidebar is a
drawer and content is single-column; above it the desktop layout stands.

### Decision

**Mobile and tablet usability is IN scope for v1.** Ruled by the owner on 2026-08-10:
*"it would be nice if this worked on ipad and iphone as well."*

v1 targets **usable, not redesigned**, on iPhone (~390px) and iPad (~768–1024px):

- ONE breakpoint at **768px**. At and above it the existing desktop layout (with its
  collapsible sidebar) stands; below it the sidebar is hidden and reachable as an
  overlay drawer from a menu button.
- Content below the breakpoint is single-column and fits the viewport width; wide
  tables scroll inside their own container, never the page body.
- No separate mobile designs, no per-screen mobile specs — this is a layout-tier
  adaptation, raised to a design pass only if a screen proves unusable under it.

### Consequences

- DRAFT-022 is promoted to a build task executing this ruling.
- The drawer is a new overlay surface and must hold the empty axe baseline (WCAG A/AA:
  dialog semantics, focus management, escape to close).
- `design/` stays frozen; this divergence is recorded in `docs/design-divergences.md`
  when the layout lands.
- Anything later found unusable at 390px despite the single-column rule becomes its own
  task, not an improvised per-screen fork.

## decision-026

- **Slug:** `decision:decision-026`
- **Title:** decision-026: A trashed workspace address is a 404 refusal; sign-in with only trashed workspaces gets the no-workspace verdict

Status: Accepted

### Context

TASK-121. `buildSession` applied owner-or-membership but never read `workspaces.trashed`,
while the entry predicate `canEnterWorkspace` refuses trashed — so a direct `/w/<trashed-id>`
built a session and rendered a workspace the switcher and landing route both refuse (TASK-120
closed only the landing route). The naive fix (throw on trashed) broke sign-in:
`resolveWorkspaceForUser`'s last-resort fallback could hand back a trashed workspace, and
`attemptLogin` converted the resulting throw into the generic "We couldn't sign you in right
now." fault.

**Prior art (documented product behavior, not live-verified).** Linear never renders a deleted
workspace and never dead-ends sign-in: the user lands on another workspace they can enter, or
on a join/create-workspace surface when none exists. Notion shows a named "you don't have
access" page with actionable options; Slack names the workspace and the state. Common shape:
refuse the dead address, land the user somewhere actionable, and when nothing is enterable,
say why in product language.

Options considered: (a) adopt `canEnterWorkspace` wholesale in `buildSession` — rejected, it
also refuses suspended members and the suspended-state panel must read the workspace to name
it; (b) refuse trashed only, and design the only-trashed sign-in outcome — chosen; (c) build a
join/create-workspace surface (full Linear shape) — deferred, the app has no self-serve
workspace creation (signup and last-workspace-trash both auto-provision, `pb_hooks/trash.pb.js`),
so the surface has nothing to offer yet.

### Decision

Option (b). `buildSession` refuses a trashed workspace with the same `404 not_found` as a
denied or nonexistent read — indistinguishable by design, matching the switch action's single
"That workspace isn't available." philosophy. The existing guard chain then lands a direct visit
on a live workspace via the landing route (Linear's land-somewhere-actionable, already built).
`resolveWorkspaceForUser`'s last-resort fallback (which exists to feed the suspended/pending
panel) skips trashed rows; when nothing non-trashed remains it returns null and sign-in
answers the existing designed verdict: 403, "No workspace is available for this account."
Suspended members are deliberately NOT refused by `buildSession`.

### Consequences

The only-trashed state is rare by construction (auto-provisioning on signup and on
last-workspace trash), reachable mainly by members of a trashed host workspace — the flat
verdict is proportionate. If self-serve workspace creation ever ships, the verdict should be
upgraded to Linear's join/create surface; that is a new task, not this one. The trashed
refusal and the resolver skip must move together: either alone reintroduces a bug
(render-the-trashed, or fault-at-sign-in).

---
**Label history — corrected 2026-08-13** (PBTT-324 housekeeping sweep of all decision-0NN
cards): this card's status label read `Proposed` despite a complete Decision/Consequences
section with an explicit chosen option. No content changed — only the stale label.
`docs/features.yml`'s citing row
(`workspaces-membership.trashed-workspace-refuses-direct-url-entry-404`) was already correctly
`shipped`; no features.yml change needed, this was pure label hygiene.

## decision-027

- **Slug:** `decision:decision-027`
- **Title:** decision-027: Suspended-member and trashed-workspace entry is enforced at the app tier; workspaces rules stay as-is

Status: Superseded by decision-049

### Context

TASK-086 AC#2. `workspaces.viewRule` checks neither `workspace_members.status` nor `trashed`;
`listRule` excludes trashed but not suspended. A suspended member gets 200 on view; view and
list disagree about trashed. TASK-085/109 already fixed every user-visible symptom at the app
tier (`authorizeWorkspaceSwitch`, `canEnterWorkspace` at the proxy boundary `route.ts:47`).
The open question was whether the RULES themselves should enforce it. Verified for this
record: no rule in `schema/*.rules.json` contains the token `status` at all — suspension is
app-enforced everywhere, at one tier — and no workspace-restore UI exists today.

**Prior art (documented product behavior, not live-verified).** Slack enforces member
deactivation at the application tier and shows a named screen ("deactivated on
<workspace>") — which requires the product to still read the workspace's identity. Linear and
Notion likewise render named, explanatory access screens for suspended/removed members rather
than an anonymous 404. The pattern requires read access to survive suspension; enforcement
lives above the storage tier.

Options considered: (1) exclude suspended members in viewRule — rejected: it 404s the exact
read the suspended-state panel depends on to name the workspace, turning a designed
explanation into a bare refusal; (2) add `trashed = ""` to viewRule to fix only the list/view
asymmetry — rejected: it recreates TASK-100's frozen-restore trap (the projects rules
deliberately dropped their trashed clause precisely so trash/restore surfaces can read rows)
and would blind any future workspace-restore surface, while protecting nothing now that
`buildSession` and `authorizeWorkspaceSwitch` both refuse trashed (decision-026); (3) keep
rules as-is and record the app/proxy tier as the DESIGNED enforcement tier — chosen.

### Decision

Option 3. The set a user may READ is intentionally wider than the set they may ENTER. PB rules
answer "may this user read this workspace's identity" (owner-or-member, regardless of status;
by id even when trashed); the app's single entry predicate `canEnterWorkspace` — applied at the
proxy boundary on every request (decision-021), by the switch action, by the resolver, and by
`buildSession` for trashed — answers "may they enter". The list/view asymmetry is likewise
intentional: list is what surfaces OFFER (never trashed), view is what the app may read to
EXPLAIN and to restore.

### Consequences

No migration; `schema/workspaces.rules.json` is correct as written, and this record is what
makes that deliberate rather than an accident. Binding obligation: any NEW path that navigates
a user into a workspace must route through `canEnterWorkspace` — a raw PB read is never an
entry authorization. A future public-API story (tokens hitting PB without the proxy) must
revisit this, because at that point the proxy tier is no longer on every path.

TASK-086 AC#1/AC#3 were already delivered by TASK-085/109 (premise re-validation on the task);
this record closes AC#2.

---
**Label history — corrected 2026-08-13** (PBTT-324 housekeeping): this card's status label
read `Proposed` despite a completed Decision/Consequences section that explicitly chose option
3 over two rejected alternatives. No content changed — only the stale label. This card was
always resolved; `docs/features.yml`'s citing row is being reclassified from `missing` to
`rejected` in the same pass.

## decision-028

- **Slug:** `decision:decision-028`
- **Title:** decision-028: Default priority vocabulary: urgent/high/medium/low, seeded like statuses and labels

Status: Accepted

### Context

TASK-164 (owner ruling 2026-08-11: core dimensions should have defaults) and TASK-153 (its
priorities instance). Re-derived at `d4b39dc`: every workspace-provision path seeds 5 statuses
(Backlog default) and 3 core labels via the universal `onRecordAfterCreateSuccess("workspaces")`
seeder (`pb_hooks/main.pb.js:659-698`), but priorities are set to `[]` at the three provision
sites (`main.pb.js:361,547` + the trash.pb.js reprovision copy) and not touched by the seeder at
all — a direct API workspace create gets whatever the client submits. `tests/test_provision.py:92`
asserts the emptiness. So a real signup lands in a workspace where no priority value is writable
(the TASK-123 hook rejects any non-empty value against an empty vocabulary) and every priority
picker renders an empty list — the client fallback in `web/lib/show-context.ts` only fires on
`null`, never on `[]`.

**Prior art.** Linear ships a FIXED priority scale — No priority, Urgent, High, Medium, Low —
not configurable per team, and renders "no priority" as absence. Jira defaults to
Highest/High/Medium/Low/Lowest, configurable. Our schema already made priorities per-workspace
data (`workspaces.priorities`, a JSON string array), and the glyph system already knows exactly
the keys `urgent`, `high`, `medium`, `low`, `none` (`web/lib/status-glyph.ts` PRIORITY_METER) —
any other string renders no glyph.

Options: (1) seed `["urgent","high","medium","low"]` — Linear's four real levels, all
glyph-backed; "no priority" stays the unset state the TASK-123 hook already always allows;
(2) also include `"none"` as a pickable fifth value — rejected: it duplicates the unset state,
and whether unset renders a middle-dot or nothing is TASK-147's separate open ruling, which a
`"none"` vocabulary entry would pre-empt; (3) leave empty and call it deliberate — rejected: the
owner already ruled the opposite.

### Decision

Option 1. A new workspace's default priority vocabulary is `["urgent","high","medium","low"]`,
seeded in the same universal `onRecordAfterCreateSuccess("workspaces")` seeder that owns statuses
and labels (covering signup, reprovision, and direct API creates alike), idempotent — only when
the submitted/stored value is empty or missing. Existing rows with empty priorities get a
one-time backfill migration. The client-side `DEFAULT_PRIORITIES` fallback aligns to the same
four values. "No priority" remains the unset state, not a vocabulary entry.

Statuses and labels already have defaults (this record documents them as the pattern being
matched). No other core dimension is deliberately empty.

### Consequences

- A fresh signup can set a priority with zero manual setup; TASK-153's symptom disappears on
  every surface (peek editor, composer pill, board grouping).
- The vocabulary stays per-workspace data — owners can still diverge from the default; this
  decision sets the starting point only.
- `tests/test_provision.py`'s `priorities == []` assertion inverts to assert the default; a new
  fresh-workspace-usability suite (TASK-164 AC#2/#3) proves the seeded state accepts a
  prioritized task and goes red if the seeding is removed.
- TASK-147 (how UNSET priority renders) is untouched and stays an open owner call.

---
**Label history — corrected 2026-08-13** (PBTT-324 housekeeping sweep of all decision-0NN
cards): this card's status label read `Proposed` despite a complete Decision/Consequences
section with a fully specified ruling and rejected alternatives. No content changed — only the
stale label. `docs/features.yml`'s citing row
(`items-properties.priority-vocabulary-seeded-by-default-on-a-fresh-workspace`) was already
correctly `shipped`; no features.yml change needed, this was pure label hygiene.

## decision-029

- **Slug:** `decision:decision-029`
- **Title:** decision-029: Component-map ruling: one settings area with separate leaves, no stacked tables; Trash pinned to the sidebar foot with settings-side links

Status: Accepted

### Context

`docs/component-map.html` (TASK-163) put the app's current structure beside a planned one so the
structural batch — TASK-152, TASK-154, TASK-159, TASK-160, TASK-161, TASK-162, TASK-166,
TASK-167, plus adjacent TASK-141 and TASK-168 — could be argued against a rendered artifact
rather than prose. The eleventh session's handoff parked the whole batch on one owner ruling:
ratify or adjust the planned column, and the batch executes against it.

The planned column as authored carried 17 deltas across routes, nav surfaces, list capabilities
and the item-detail screen, hand-derived from doc-004's lessons L3–L7.

### Decision

Ruled 2026-08-11: the planned column is accepted as authored, with three amendments.

**1. Trash sits at the very foot of the sidebar.** Today `buildShellNav`
(`web/lib/shell/nav-model.ts:72-75`) pushes Trash as the last section, so it flows immediately
under the Workspace group and floats wherever the projects list ends. Ruled: it is pinned to the
bottom of the rail, visually set apart from the working set, regardless of how many projects are
above it.

**2. Trash is additionally reachable from the settings side.** Links from the workspace settings
area and from the account/user settings area, as convenience entrances — not as a replacement for
the rail entry. Trash is workspace-scoped, so the account-side link resolves to the current
workspace's trash; if that reads wrong once built, the account-side link is the one to drop.

**3. No screen stacks tables on top of each other.** The settings area's leaves — Members
(including people waiting to be let in), Audit, Projects, Workspace, Account — are separate
destinations, reached by tab or by their own address. The current `/w/:ws/admin` shape (a scroll
of three unrelated tables under four tiles) is exactly what is being ruled out, and a
single-page settings screen that merely relocates that scroll does not satisfy TASK-160.

Prior art per the repo's standing rule: Linear carries one settings area with a grouped sidebar
and one subject per leaf, and pins low-frequency destinations to the rail's foot rather than
interleaving them with the working set. doc-004 already declined Kaneo's stacked tab bar over a
per-tab sidebar as two levels of nav chrome for one job; that decline stands.

### Consequences

- The structural batch is unblocked and executes against the amended planned column.
- `web/scripts/component-map.planned.json` gains the three amendments as deltas/notes; the map
  regenerates under its existing drift gate (`componentmap:check` in dod + CI), so landing any of
  these tasks forces the map to follow.
- TASK-160 gains an acceptance criterion forbidding the stacked-table shape, since "one settings
  area with a shared shell" was satisfiable by a single long scroll as originally written.
- Trash placement + the two settings-side links are their own small nav task (TASK-178), not
  folded into TASK-154, which rules on Trash's list *capabilities* rather than its address.
- Cheap to reverse in all three parts: placement is one section-ordering edit in `nav-model.ts`,
  the settings links are two nav entries, and the no-stacking rule is a shape constraint that
  only binds work not yet built.

## decision-030

- **Slug:** `decision:decision-030`
- **Title:** decision-030: TypeScript stays capped below 7 until the 7.1 API lands and typescript-eslint + hey-api support it

Status: Accepted

### Context

Dependabot PR #120 offered typescript 5.9.3 → 7.0.2. A researched migration report
(2026-08-11, sources on file in the report; key facts re-derivable from PR #120's own CI runs of
2026-08-10) established:

- typescript@7 is the native Go compiler (GA 2026-07-08) and **ships no JavaScript API**; a new
  API is slated for 7.1.
- Two of this repo's gate tools consume that API and hard-crash under 7: typescript-eslint
  (supported range `<6.1.0`, throws at eslint startup; TS ≥7.1 support tracked in
  typescript-eslint#10940) and @hey-api/openapi-ts (dies on the removed factory API; wired as
  `prebuild`, so `next build` and the e2e gate fail with it). Both crashes are proven by the
  PR's own CI, not inferred.
- `tsc --noEmit` itself passed under 7.0.2 and `web/tsconfig.json` uses none of the removed
  options — the compiler is ready, the toolchain is not.
- hey-api's peer range (`>=6.0.0`) semver-matches 7.x, so npm installs cleanly and the failure
  is runtime-only: the cap must be explicit, not left to peer resolution.

### Decision

Ruled by the owner on 2026-08-11: hard-cap the versions and revisit once 7.1 lands.

- `web/package.json` pins typescript exactly (stepping to the latest 6.x per the TypeScript
  team's own migration recommendation — TS 6.0 is the last JS-API release, config-aligned
  with 7).
- `.github/dependabot.yml` ignores `typescript >= 7` in the version-update block so the bump
  is not re-offered; the security-update path is untouched (ignores do not apply to it).
- PR #120 is closed with a comment naming this decision; its CI record stands as the evidence.

### Consequences

- TASK-180 is the revisit trigger: when TS 7.1 ships its API AND typescript-eslint AND
  hey-api release support for it, lift the cap, re-open the bump, and let the gates judge it.
- Until then, TS 6.x picks up the 7-aligned strictness so the eventual jump is small.
- The cap lives in two places (the exact pin and the dependabot ignore); TASK-180's criteria
  name both so lifting one without the other cannot happen silently.

## decision-031

- **Slug:** `decision:decision-031`
- **Title:** decision-031: Are the bound design system's colors, type and spacing amendable for visual quality?

Status: Accepted

### Context

Owner report (2026-08-12): the app "all seems washed out"; asked for aesthetic
recommendations, adding "I'm open to any changes to make this better."

Measured cause — every surface pair sits within 1.1-1.3:1, so the UI has no figure/ground:

```
LIGHT   canvas #f4f4f4 vs row #ffffff     1.10:1
        hairline #e0e0e0 on #ffffff       1.32:1
        hover    #e8e8e8 on #ffffff       1.23:1
DARK    canvas #262626 vs card #393939    1.31:1
        hairline #525252 on #393939       1.48:1
        hover    #474747 on #393939       1.24:1
```

Verified live against `make dev` at 1440x900, both themes, 10 screenshots (login,
workspace, list, board, peek). Dark reads BETTER than light — the dark canvas lets the
blue accent and status glyphs register. Light is the washed-out one.

**The blocker at the time this card was filed:** `design/README.md:54` — "Colors, type,
spacing and copy are **final**, taken from the bound **RaptorXai Reconcile** design system
(Carbon v11 white + g90 dark, IBM Plex Sans, the `--ra-state-*` signal palette)."
`design/PROVENANCE.md` records it as the third design engagement's output, re-vendored
2026-07-28 from Henry's Claude Design project.

So the washed-out appearance was a **faithful implementation of the bound system**, not a
defect. Every meaningful fix amends that system. That was an owner call, not an agent one.

Note the app already contradicts itself in two places, which is the evidence that the
direction taken here is native to the system rather than imported:
- `design/screens/03-items-board.md` — board cards are white on the `--cds-layer` canvas
  with a status-colored top edge. Best-looking screen in the app.
- `design/screens/11-admin.md:11` — audit rows already colour the left edge by verb.
- `design/screens/01-sign-in.md` — the login split (white / `--cds-layer`) gives real
  figure-ground and reads as designed.
The items list (`design/screens/02-items-list.md`) got none of this.

### Decision

Owner ruling 2026-08-12, recorded as a comment on this card: **all four amendments
accepted — A, B, C and E.**

The owner's words: the `design/` folder "got me started but it's garbage" — it is no longer
treated as binding, and `design/README.md:54`'s "colors, type, spacing and copy are final"
does not constrain this work. The owner further authorized deleting `design/` outright,
then directed that the deletion is out of scope for the current work and should be ignored
for now — it stays filed under PBTT-263, not actioned here.

The four accepted amendments, as weighed and ruled:

**A. Widen the surface ladder (amends: colors).** Six hex values in `web/app/tokens.css`.
The hue shift matters more than the lightness: neutral greys at 1.1:1 read as a dirty
monitor; a slight cool cast makes white rows read as a different material.
```
light  --cds-layer #f4f4f4 -> #eceef2 · --cds-layer-hover #e8e8e8 -> #e0e4ea
       --cds-border-subtle #e0e0e0 -> #d2d6dd (1.55:1, visible)
dark   --cds-background #262626 -> #17181b · --cds-layer #393939 -> #232529
       --cds-border-subtle #525252 -> #34373d
```
Dark inverts the move: drop the canvas floor rather than lift the cards.

**B. Un-invert the type hierarchy (amends: type).** Page titles are `28px font-light`
across 14 sites; row titles are `13px/500`. IBM Plex Light at 28px carries *less* optical
weight than the rows beneath it. Carbon uses 300 at display sizes (42px+), not 28px.
Either `font-medium` at 28px, or keep 300 and go to 36-40px. Extract `<PageTitle>` from
the 14 duplicated call sites first so the weight is one line forever.

**C. Give the chrome the layer tone (amends: spacing/surface assignment).** `foundations.md`
assigns the sidebar to `--cds-background` (white). Moving sidebar+footer to `--cds-layer`
gives the app a silhouette — exactly what screen 01 already does.

**E. Status-coloured row left edge (amends: screen 02).** `design/screens/02-items-list.md:33`
specifies "a 2px transparent left edge that turns `--accent` for the cursor/peeked row".
Making it permanent and tinting by status contradicts that line — but it is precisely what
screen 03 (board) and screen 11 (audit) already do. One line in
`web/components/resource/ResourceList.tsx:721`.

A fifth candidate was carried on this card but needed no ruling:

**D. Auto-hide empty columns (behaviour, NOT bound).** On the seeded list, PRI/DUE/LABELS/
SUB/CMT are empty on nearly every row and eat ~35% of the width. **Buildable without this
ruling** — filed separately.

### Consequences

- **A collides with open contrast work.** PBTT-253 and PBTT-254 are unresolved
  `--ra-state-*` / `--cds-border-strong` contrast residuals, and `web/lib/token-contrast.test.ts`
  is the gate. Any A change must keep that gate green and should be sequenced with those
  two, not landed across them. PBTT-255 (board column tones) is adjacent to E.
- Accepting A/B/C/E was weighed as meaning `design/foundations.md` and `design/README.md:54`
  stop being verbatim-bound and become "bound, with a dated amendment log" — the provenance
  guarantee weakens, and future reviews lose a bright line. The ruling went further than
  that: `design/` is not authoritative at all, so no amendment log is needed.
- Rejecting all of them would have been coherent: the answer to "it looks washed out"
  becomes "the bound system looks like this on modern displays", and the only work is D
  plus the genuine defects filed alongside this card. The owner did not take that path.
- Partial acceptance was judged the likely best value — A alone recovers most of the
  perceived quality for six hex values, and is the cheapest to revert — but the ruling
  took all four.
- Verification note that survives the ruling: `design/` is **not** load-bearing for any gate.
  Checked 2026-08-12 — nothing programmatic reads it. The live frontend contract is
  `web/openapi.contract.json` (consumed by `web/openapi-ts.config.ts`, `web/scripts/check-codegen.mjs`,
  `web/lib/proxy/registry.ts`); `scripts/gen_openapi.py` writes repo-root `openapi.json`.
  `design/openapi.json` is a stale duplicate. The only inbound references are prose citations
  in ~8 source comments, `docs/design-divergences.md`, `docs/agent-gotchas.md`, and the
  `frontend-contract-auditor` agent definitions — a citation sweep, not a gate risk.

### Acceptance Criteria

- [x] #1 Owner rules per-option (A/B/C/E) — accept, reject, or defer — and the ruling lands as a dated comment — ruled 2026-08-12
- #2 If any option is accepted, `design/README.md:54` gains an amendment note so the binding claim stays accurate — dispositioned **not applicable** by the ruling (the document is no longer authoritative), rather than met
- [x] #3 Accepted options are split into buildable tasks referencing this decision — PBTT-272 (A + C, coupled), PBTT-273 (B), PBTT-274 (E)

— [root, session 1177cdf1-0fbf-4b87-ba37-93bf6920b748]

## decision-032

- **Slug:** `decision:decision-032`
- **Title:** decision-032: The responsive rule set — breakpoint ladder and content max-width, or none at all

Status: Accepted

### Context

The app had, across all of `web/`, **21 responsive utilities at a single breakpoint**
(`md`) — no `lg:`, no `xl:`, no `@media` rule in `app/globals.css`. Nothing said what a
screen should do as the viewport grows. At ~1990px the list view's title column absorbed
~1200px of surplus while fixed-width property columns wrapped their values onto two lines
(owner screenshot, prod, 2026-08-12).

The `--cds-*` tokens are **colour only** — no spacing scale, no `--breakpoint-*`, no
`--container-*`. The project is Carbon-coloured, not Carbon-gridded.

Full research — Carbon's grid spec, 8 permissive-OSS repos read at source, and a complete
inventory of this app's width bounds, gutters and column widths — is in this card's first
comment (2026-08-12). It is the evidence base for the ruling below and should be read
before acting on any of it. The load-bearing measurements from it:

**This app's state when the card was filed** (all `path:line`-cited by the inventory agent):
- 21 responsive utilities total, one breakpoint (`md`). No `lg:`/`xl:`/`2xl:` anywhere, no
  `@media` rule in either CSS file. Re-verified by hand from repo root across
  `.tsx`/`.ts`/`.css`.
- `--cds-*` are **colour only** — 14 colour vars in `app/tokens.css`. The `@theme` block
  sets colour, font and radius. **No spacing scale, no `--breakpoint-*`, no `--container-*`.**
- `<main>` (`components/shell/ShellChrome.tsx:92`) carries **no padding and no max-width**.
  Each band re-declares `px-6` — 14 sites — while the show/peek/composer family uses `px-5`,
  footer `px-4`, header `px-3`, board `ps-3 pe-6`. There is no single gutter value to change.
- The table declares **neither `table-layout: fixed` nor `min-width`**
  (`ResourceList.tsx:666`), so every `style={{ width }}` is an advisory hint the browser may
  shrink below max-content. Header cells are `whitespace-nowrap` (`:676`); body cells are
  not (`:776`). That is the wrap.
- Column maps mix units: `due: 68px` beside `type: 4.25rem` (`item-cells.tsx:234-243`).
  `html[data-text-size]` sets root to 16/18/20px, so `rem` columns scale 1.25× for a
  large-text user while `px` columns hold — the columns drift from each other, not just
  from the viewport.
- **No test could have caught this.** Both Playwright configs pin a single 1280×720 chromium
  project; no `scrollWidth`/overflow assertion exists anywhere; one board spec drops to 600px
  solely to check the board's own scroll indicator.
- The axe gate enforces the `wcag21aa` tag set, which includes **1.4.10 Reflow** (320px, no
  2-D scroll) — but axe-core cannot detect reflow statically and every scan runs at 1280px.
  That criterion is nominally enforced and actually untested.

**Carbon's measured breakpoint ladder** (`@carbon/grid/scss/_config.scss`, fetched):

| | sm | md | lg | xlg | max |
|---|---|---|---|---|---|
| width | 20rem | 42rem | 66rem | 82rem | 99rem |
| columns | 4 | 8 | 16 | 16 | 16 |
| margin | 0 | 16px | 16px | 16px | 24px |

Gutter 32px wide / 16px narrow / 1px condensed. Breakpoints declared in **rem** — so
`data-text-size` moves the ladder itself. Expressed in px, the same ladder reads
sm <672 · md 672–1056 · lg 1056–1312 · xlg 1312–1584 · max >1584, container max-width 1584px.

Carbon's default grid caps at 99rem centred, **but its usage guidance explicitly excludes
dense product UI from that model**: "High-density interface model … Complex product
interfaces, catalogs and data visualization dashboards typically fall into this category.
This model uses the full width of the browser." The capped models are Editorial (centred)
and Product-and-docs (left-aligned). By Carbon's own rules a task tracker's list is
high-density → full width → the fix is column behaviour, not a page cap.

Carbon's DataTable declares no `table-layout` either (auto), prescribes truncation only for
column *titles*, and caps *measure* on long text inside a full-width table (`50ch`/`80ch`)
rather than capping the table. (That last citation was later found unsourceable — see the
citation corrections in the Decision section.)

**Permissive OSS** (licence read from each LICENSE file; AGPL ones marked study-only):

| Project | Licence | Max-width | Column strategy |
|---|---|---|---|
| Kaneo | MIT | none on list/board | flex rows; title `flex-1 min-w-0 truncate`, properties `flex-shrink-0` |
| shadcn/ui | MIT | none in blocks | auto, no widths, `whitespace-nowrap` on th+td, wrapper `overflow-x-auto` |
| Supabase Studio | Apache-2.0 | full-bleed shell, per-page opt-in (default 1200) | **`table-fixed`** + `w-[40%]`-style heads; sizeless columns split the remainder |
| Medusa admin | MIT | **`max-w-[1600px]` global** | percentage auto-fill `100 / autoFillCount` + truncate-with-tooltip |
| Trigger.dev | Apache-2.0 | none on dense views | `whitespace-nowrap`, narrow columns pinned `w-[1%]`, overflow scrolls |
| Formbricks | AGPL (study only) | none applied | `tableLayout: fixed`, `defaultColumn.size: 300`, surplus → h-scroll |
| Documenso | AGPL (study only) | `max-w-screen-xl` per route | auto; `getSize()` on body cells only |
| TanStack Table | MIT | n/a | defaults `size: 150`, `minSize: 20` |

Recurring across 5+ of 8: shell is full-bleed and capping is a **per-page opt-in expressed
as a named component** (`ScaffoldContainer`, `PageBody`/`MainCenteredContainer`, `Gutter`) —
never sprinkled `max-w-*`. **Zero of eight let a table cell wrap**; `truncate`/`nowrap` is
applied at the primitive. **Nobody redefines Tailwind's breakpoints — they only add**
(`xs: 430`, `xs: 480`, `3xl: 1600`, `4xl: 2000`). Nobody lets one column absorb surplus
unchecked.

Not verified at ruling time: nothing was rendered — all eight OSS projects are source-reads,
the `table-fixed` mechanism is read from source rather than reproduced in a browser, and the
~1990px measurement is the owner's screenshot, not an instrumented run. The Carbon
researcher's inventory of this repo (34 responsive utilities incl. `lg:`/`xl:`) was **wrong**
and is discarded; the hand-verified count is 21, and that researcher's externally-sourced
claims spot-checked clean (Tailwind 4.3.3, `--breakpoint-*` namespace live). IBM Cloud
console's live wide-viewport behaviour was not fetched.

### Decision

**Ruled by the owner 2026-08-12 (board comment on this card). Option 1: fix the columns,
keep the page full-bleed.** **Amended by the owner 2026-08-15 via sign-off form** — clauses
A and C preserved in intent, clause B's ladder retired. The owner chose explicitly to record
that as a dated amendment on this card rather than as a superseding decision ("one decision
per topic"), so what follows is the whole ruling with the amendment folded in.

**A. Content max-width — no page cap.** The shell stays full-bleed. This follows Carbon's
own usage guidance, which excludes dense product UI from its capped models: *"High-density
interface model … Complex product interfaces, catalogs and data visualization dashboards
typically fall into this category. This model uses the full width of the browser."* The OSS
majority agrees independently — 5 of 8 surveyed projects run a full-bleed shell with capping
as a per-page opt-in. The ~1200px gap is therefore a **column-behaviour** defect, not a
missing max-width. The 2026-08-15 amendment **restores** clause A: dropping the table cap
that shipped under clause C's name returns the shell to full-bleed, which clause A required
and which the shipped table cap was arguably in tension with.

**B. Breakpoint ladder — RETIRED by the 2026-08-15 amendment.** As originally ruled, clause B
introduced `--breakpoint-xlg: 82rem` and `--breakpoint-max: 99rem` as new names matching
Carbon's upper ladder, and forbade redefining `md` (Carbon's 42rem would fire all 21 existing
utilities 96px earlier, including the one that makes the sidebar appear; no surveyed project
redefines Tailwind's defaults, and all four that customise breakpoints only add to them).
The amendment deletes both tokens. `--breakpoint-xlg` having zero consumers was **compliance
with clause B, not a defect** — clause B mandated it, and root's earlier framing ("dead token,
delete it or give it a job") was wrong to imply otherwise. What tipped the ruling is that
neither token is inert: declaring a `--breakpoint-*` in `@theme` registers a Tailwind
breakpoint, so each emits a dead `.container` media rung into the shipped CSS
(`@media (min-width:82rem){.container{max-width:82rem}}`) even though `.container` is used
nowhere in `web/`. A mandated setting nothing reads is a trap for the next reader. The
prohibition on redefining `md` stands on its own evidence.

**C. Column sizing — declared widths must bind; the cap goes on the title column, not the
table.** `table-fixed` on the list table so the per-column widths stop being advisory hints,
paired with `truncate` on every cell (mandatory: under fixed layout a too-narrow column clips
instead of pushing). Zero of eight surveyed projects let a table cell wrap. Unify the mixed
`px`/`rem` column units so `html[data-text-size]` scales them together. Surplus goes to the
title column **under a measure cap** — the original ruling cited Carbon's own `50ch`/`80ch`
precedent for capping measure on long text inside a full-width table *rather than capping the
table*.

What shipped in PBTT-305 capped the **table** instead — `max-w-[var(--breakpoint-max)]` on
the `<table>` (`ResourceList.tsx:732`), at clause B's `99rem` grid rung, labelled as a measure
cap (`globals.css:9-10`: "the widest a reading measure is allowed to stretch to"). At the
list's measured glyph density that is ~165–190 characters, against WCAG's 80. Measured
consequence: the title→property gap is **612.95px at 1440** and **1044.95px at 1920**, and the
cap does not engage at all below viewport 1872px. Full numbers on PBTT-380.

The amended mechanism (built under PBTT-380): cap the **title column** at `36rem` (~78
characters, inside WCAG 2.2 SC 1.4.8's 80-character ceiling), add a **trailing spacer column**
to the right of the properties to absorb surplus, and **remove the table's `max-w`**. Capping
the title alone would not have worked — the properties stay viewport-pinned and drift further
— which is why the spacer is part of the ruling rather than an implementation detail.

**D. Enforcement — yes, a viewport matrix.** A Playwright matrix asserting no horizontal page
overflow and no wrapped property cell. This is not optional polish: the axe gate already
enforces the `wcag21aa` tag set, which includes **1.4.10 Reflow**, but axe-core cannot detect
reflow statically and every scan runs at 1280px — the criterion is nominally enforced and
actually untested. Both Playwright configs pin a single 1280×720 project and nothing anywhere
asserts `scrollWidth`.

**Rejected: importing Carbon's grid.** A 16-column grid does nothing for a table, and Carbon's
column machinery (per-column `margin-inline` instead of `gap`, narrow/condensed hang, the
generated span matrix, its flexbox sticky-header workaround) is ~150 lines serving cases this
app does not have. Tailwind's `col-span-*` already covers real grid needs. Revisit only for a
surface with genuinely multi-column content.

**Deferred, not rejected: the named width primitive** (Option 2 — a `Gutter`-style component
owning the gutter and an optional cap, replacing the 14 hand-repeated `px-6` sites and the
ad-hoc `max-w-3xl`/`max-w-[46rem]`/`max-w-2xl` caps on show/composer/settings; dense views opt
out of the cap, prose and forms opt in, with Supabase's `size` prop and its `full` rung as the
escape hatch). Option 1 is a strict subset, so this stays available without rework. The
per-band `px-6` sprawl is what let this defect stay invisible until a screenshot caught it, so
file it when the gutter is next touched.

**Two sources this decision cited that do not hold** (verified by root 2026-08-15, from the
research pass the owner commissioned on PBTT-305 AC#3; neither correction changes what the
decision was trying to achieve, and both are recorded because a decision resting on an
unsourceable citation invites the next reader to re-derive it — or to trust it):

1. **"Linear is closed-source — no LICENSE, no citable source" is FALSE**, and it cost this
   decision its best evidence. The original research recorded that nothing in it derived from
   Linear, despite `AGENTS.md` naming Linear the convergence target, and said a Linear citation
   would need a measured live session. It did not. Linear's production web client is served
   **unauthenticated** from `static.linear.app` with readable module and StyleX class names
   (fetched 2026-08-15, entry `html.D02BdRKD.js`, `Last-Modified: Sat, 15 Aug 2026 09:07:00
   GMT`). The convergence target was citable all along. From the shipped bundle:
   - **No max-width on the issue list at all** — `ListCell.CpkMm5zY.js`: `width:"100%",
     minWidth:0`, no `maxWidth`; zero max-width declarations across `IssueList`,
     `IssueListItems`, `ListCell`, `GroupedList`, `ListGridColumn`, `IssueWidget`.
   - **Metadata pinned hard right on purpose** — the row is a named-line grid, `title` the sole
     `1fr`; badges sit in a `flex-grow:1` container, and with no badges Linear renders a bare
     `<Flex grow={1}/>` **spacer** so the avatar still lands far right. The gap is a deliberate
     unbounded void.
   - **Title takes all surplus** — `1fr`, floor `min-width:200px`, `truncate:true`;
     `ListColumns` accepts an optional `titleColumnConfig.maxWidth` and **no call site passes
     one**.
   - **Linear caps reading surfaces but not lists** — `contentMaxWidth:'80ch'`,
     `--agent-panel-chat-max-width:80ch`, consumed by documents, updates, settings, agent chat.
   - **Wide screens buy more metadata, not a shorter gap** — inline label count switches on
     `{…laptop:1024, normal:1025, large:1400, xlarge:1800}`: 3 inline labels ≤1024px, 4 at
     1025–1400, 6 above 1400. Its answer to 2560px is the split/peek detail pane.

   So on the specific question this decision was ruling, **Linear does what clause A prescribes
   (full-bleed, no page cap) and does NOT cap the list** — which strengthens clause A and
   undercuts the table cap that shipped under clause C's name. It is also why "accept the gap"
   was a genuine option on PBTT-380, and why the owner rejecting it is a deliberate divergence
   from the convergence target rather than an oversight.

2. **Clause C's "Carbon 50ch/80ch measure cap" citation cannot be sourced.** Cloning
   `carbon-design-system/carbon-website` and grepping `src/` for `line-length`, `characters per
   line`, `known as measure` returns zero hits; the v11 and v10 typography pages carry no
   characters-per-line guidance, and the v6/v9 subdomains are dead. **Replacement: WCAG 2.2
   SC 1.4.8** ("no more than 80 characters or glyphs") plus the **CMS Design System** measure
   scale (45/65/80ch) — same guidance, verifiable. Carbon's real, sourceable contribution to
   this decision is its grid ladder, which is what clause B correctly used.

### Consequences

- PBTT-305 is unblocked and its fix is scoped by C and D above.
- PBTT-287 (inbox 390px) and PBTT-288 (SettingsLeafNav) are the same defect from the narrow
  end; they should be re-read against B before being worked, and may collapse into the matrix
  from D.
- The Reflow gate stops passing vacuously once D lands — expect it to surface narrow-viewport
  failures that have always been there.
- As originally scoped, no shell change and no grid import, so the blast radius is
  `ResourceList.tsx`, `item-cells.tsx`, ~4 lines of `@theme`, and the e2e config.
- The 2026-08-15 amendment is built on **PBTT-380**: title column capped at `36rem`, trailing
  spacer column added, the table's `max-w` removed, and both `--breakpoint-xlg` and
  `--breakpoint-max` deleted along with the dead `.container` media rungs they emitted.

### Acceptance Criteria

- [x] Owner rules on A–D, recorded as a comment with the date. — ruled 2026-08-12
- [ ] `Decision` section rewritten with the ruling and its rationale; prior art named and measured where it informed the call.
- [ ] `docs/decisions.md` regenerated (`python3 scripts/gen_decisions.py`) so decision-032 appears.
- [ ] The buildable follow-ups are filed as their own cards; this card carries no code.

### Definition of Done

- [ ] #1 `make dod` exits 0 for the scope this change touches
- [ ] #2 Evidence per acceptance criterion: the command run and its actual output — never a claim, never code presence
- [ ] #3 CI green on the push, watched to completion
- [ ] #4 Closing comment names what changed and how it was verified

— [root, session 785e3859-3418-4193-8f80-25af5d6684ac]
— [root, session 3ffd3661-8616-4771-9911-c5bfe4d9300a] (2026-08-15 citation corrections and amendment)

## decision-033

- **Slug:** `decision:decision-033`
- **Title:** decision-033: The frontend proxy's adaptation layer is the permanent architecture, not a migration path toward native PocketBase collections

Status: Superseded by decision-077

### Context

`docs/features.yml`'s API & integration surface domain carries 7 rows, all citing PBTT-238, all `missing` or `partial`:

- `project_items` as a real polymorphic collection
- `GET /project_items/counts` bucket endpoint
- Generic `audit_log` collection beyond task-scoped activity
- Derived counts (subtask/comment) on the item payload
- Normalized error envelope `{error:{code,message,fields?}}`
- Workspace vocabulary as arrays on the workspace record
- `trashed_at` / `purge_at` as stored contract fields

Each describes the frontend-facing OpenAPI contract having a *native* PocketBase collection or field backing it, where today the server-side proxy synthesizes, reshapes, computes, or normalizes the equivalent on the fly. Two rows already shipped and are treated as architecture, not tech debt: `Frontend-facing OpenAPI contract adapted onto the native one` and `Frontend never talks to PocketBase directly (server-side proxy seam)` — the proxy adaptation IS the design, per those shipped rows' own framing.

Treating each of the 7 as an individual backend gap risks slow-motion architecture drift — a series of small "let's just add the native field" changes that collectively undo the proxy-seam design one row at a time, without ever making that trade-off explicit.

### Decision

Ratified 2026-08-13 during PBTT-324 (feature closure plan) housekeeping — the owner approved this specific finding for cleanup before the rest of the closure plan was ruled on.

The frontend proxy's adaptation layer (synthesizing `project_items`, reshaping `task_activity` into audit-log shape, computing derived counts, normalizing PocketBase's error shape, deriving workspace vocabulary arrays, computing `trashed_at`/`purge_at` on the fly) is the **permanent** architecture for these seven surfaces — not a migration path toward eventually moving each into a native PocketBase collection or stored field. All 7 `docs/features.yml` rows above reclassify from `missing`/`partial` to `rejected`, citing this decision.

### Consequences

- If a *specific* one of these seven is later found to have a real performance or correctness cost that the proxy can't absorb (e.g. the synthesis becomes measurably slow, or a genuine data-integrity gap opens because the field isn't actually stored), that is a new, narrowly-scoped card making its own case — not a reopening of this decision wholesale.
- Any future contract change proposing to move frontend-visible shape into a native PocketBase collection/field should point at this decision and argue why the specific case is an exception, rather than treating the proxy seam as provisional by default.

— [root, session 622953ef-a9ef-48bc-bda8-3ab07731c19d]

## decision-034

- **Slug:** `decision:decision-034`
- **Title:** decision-034: item create stays non-optimistic

Status: Accepted

### Context

The register row `composer-forms.optimistic-create` treated non-optimistic create as a gap. Re-validation (2026-08-14) found three independent sources agreeing it is deliberate: `web/components/resource/composer/ComposerProvider.tsx:6` ("Create is NOT optimistic — submit goes through Refine; the row appears on refetch"), the frontend contract (`web/openapi.contract.json:640` "Optimistic updates are off for create"), and a passing e2e asserting the non-optimistic close (`web/e2e/composer.spec.ts:151-152`).

### Decision

Ruled 2026-08-14 by owner ratification of the PBTT-324 disposition: create remains non-optimistic. The register row flips to `rejected` citing this card.

### Consequences

No optimistic-create work gets filed. Revisit only if create latency becomes a measured UX problem; a future card must supersede this decision explicitly.

— [root, session 4cb2f575-c2c5-4a4c-abef-1e015984e4e9, PBTT-324 ratified disposition]

## decision-035

- **Slug:** `decision:decision-035`
- **Title:** decision-035: a stale status renders the warn glyph, not silent no-status

Status: Accepted

### Context

The register row `board.a-stale-status-renders-as-no-status-not-as-a-warn-glyph` asks for a status missing from the workspace vocabulary to render as no-status. The tree does the opposite on purpose: `web/lib/status-glyph.ts:65-72` returns the ◍ warn glyph with a "not in this workspace's vocabulary" title, per the owner ruling cited inline at `web/lib/status-glyph.ts:47`.

### Decision

Ruled 2026-08-14 by owner ratification of the PBTT-324 disposition: the warn glyph stands — a stale status is surfaced, never silently degraded. The register row flips to `rejected` citing this card.

### Consequences

The row's ask would have reversed an existing ruling; rejected at ratification instead. Any future change must amend the inline-cited ruling first.

— [root, session 4cb2f575-c2c5-4a4c-abef-1e015984e4e9, PBTT-324 ratified disposition]

## decision-036

- **Slug:** `decision:decision-036`
- **Title:** decision-036: no swimlanes on the board

Status: Accepted

### Context

The register row `board.swimlanes` names swimlanes as a possible board capability. No code exists, no card owns it, and the prior-art anchor (Linear) has no swimlane concept.

### Decision

Ruled 2026-08-14 by owner ratification of the PBTT-324 disposition: swimlanes are rejected for this product tier. The register row flips to `rejected` citing this card.

### Consequences

Board grouping stays single-axis (columns). Revisit only with a concrete user-driven need; a new decision card would supersede this one.

— [root, session 4cb2f575-c2c5-4a4c-abef-1e015984e4e9, PBTT-324 ratified disposition]

## decision-037

- **Slug:** `decision:decision-037`
- **Title:** decision-037: no offline support / service worker

Status: Accepted

### Context

The register row `ops-deploy-tooling.offline-support-service-worker` names offline support. No service worker, workbox, or manifest exists anywhere in web/ (rg-verified 2026-08-14), and the app is a realtime multi-user tracker where stale-write reconciliation would dominate the cost.

### Decision

Ruled 2026-08-14 by owner ratification of the PBTT-324 disposition: offline support is rejected for this product tier. The register row flips to `rejected` citing this card.

### Consequences

No service-worker scaffolding gets added. Revisit only alongside a mobile/PWA push; a new decision card would supersede this one.

— [root, session 4cb2f575-c2c5-4a4c-abef-1e015984e4e9, PBTT-324 ratified disposition]

## decision-038

- **Slug:** `decision:decision-038`
- **Title:** decision-038: register-drift gate couples commit-subject card ids to non-shipped rows

Status: Accepted

### Context

PBTT-331: 21 of 36 sampled register rows said "unbuilt" about built features; nothing couples a landed change back to docs/features.yml. Phase-1 measurement (2026-08-14, PBTT-331 thread) over 26 squash-merged PRs, evaluating features.yml AS OF each commit: path→row matching fires on 38% of PRs (a bare `web/` token in five rows' evidence poisons it); card→row matching — the `(PBTT-n)` already in every delivering commit subject against the PBTT ids already cited in row evidence — fires on 25% at ~75% precision, rising when `rejected` rows are excluded. Both couplings already exist in the row data (235/399 rows cite a path token, 251 cite a card); nothing new needs authoring. Closing-discipline enforcement (card cannot close with unticked ACs) needs board credentials and network, which an offline CI gate cannot have.

### Decision

Ruled by root session 194fe161 on 2026-08-14, from the PBTT-331 phase-1 measurements above.

The drift gate is mechanism (a′): inside `gen_feature_register.py --check` (already in the dod docs scope), fail when a commit subject in the change range carries a card id that a `planned`/`partial`/`missing` row cites in its evidence — the row must be revisited in the same change. `rejected` and `shipped` rows never trigger. A per-row override token in the evidence string acknowledges legitimate non-delivery. A second cheap assertion in the same script: every evidence path token containing `/` must resolve on disk. Plain path→row coupling is REJECTED (measured 38% false-fire, directory tokens unusable). Closing-discipline (PBTT-331 AC#4) is REJECTED as a repo gate and split to its own board-process card.

### Consequences

The gate can only see PRs whose commit subject carries a card id (17/26 in the sample; the convention is house style, now load-bearing). Cards cited by several rows may co-fire; the override token is the escape. The register stays honest at the seam where it actually drifted — work landing — rather than by scheduled re-audit.

— ruled by root session 194fe161, 2026-08-14, from PBTT-331 phase-1 measurements

## decision-039

- **Slug:** `decision:decision-039`
- **Title:** decision-039: a non-active membership status revokes read AND write access

Status: Accepted

### Context

PBTT-431 established that `workspace_members.status` is enforced almost nowhere: a `suspended` member keeps full write and read access to every workspace collection. Before building the pervasive enforcement, the open design question (flagged on the HANDOFF, owner's court) was whether a non-active status revokes READ visibility too, or only writes. Prior art: Linear fully revokes access on suspend.

### Decision

Owner ruling 2026-08-30 (direct, in session): **revoke read and write both**. A member whose status is not `active` (suspended, invited, pending_approval) has no visibility into the workspace — not read-only access.

### Consequences

- PBTT-431 builds enforcement as full revocation: every workspace-scoped collection rule (list/view as well as create/update/delete) requires the caller's membership row to be `status = "active"`.
- Realtime subscriptions and any proxy read paths must honor the same predicate.
- Invited / pending_approval members see nothing until activated — the invite flow (PBTT-360) must not depend on pre-activation reads.

— [root, session 5ac9e162-3e3a-40a1-8d13-38c0e121fc51]

## decision-040

- **Slug:** `decision:decision-040`
- **Title:** decision-040: workspace_members create pins role — admins add members only, owners may set any role

Status: Accepted

### Context

PBTT-428: `workspace_members.updateRule` pins `role` (`@request.body.role:isset = false`) but `createRule` places no pin on it, so an admin can mint another admin. Filed from the PBTT-339 create-rule mass-assignment audit as a create/update asymmetry plus an owner design question. Prior art considered: Linear allows admins to manage admins.

### Decision

Owner ruling 2026-08-30 (direct, in session): **create pins role to `member` unless the caller is the workspace owner**. Admins can add members only; role elevation stays an owner action, symmetric with the update rule's pin.

### Consequences

- PBTT-428 builds the create-rule pin: a create by an admin must carry `role = "member"` (or omit it, defaulting to member); an owner may set any role at create.
- Any future "promote to admin" flow is a separate owner-gated surface, not a side effect of member creation.

— [root, session 5ac9e162-3e3a-40a1-8d13-38c0e121fc51]

## decision-041

- **Slug:** `decision:decision-041`
- **Title:** decision-041: escape-layering policy — useEscUnwind as the single entry point, delete-confirm stays raw

Status: Accepted

### Context

PBTT-416 (base-hardening wave 1) renamed the misnamed guard (`isLayerOpen` / `OPEN_LAYER_SELECTOR`) and unified two of three hand-rolled escape-layering sites, discharging its AC#3 with a recorded verdict at the site: `TemplatesSection`'s delete-confirm keeps its unguarded Escape, because every failure mode of not guarding is a recoverable "confirm went away", while guarding risks a primed Delete surviving an Escape the user believed cancelled it. Its AC#4 requires a decision record for the lasting policy, which lives on the board, not in web/.

### Decision

Drafted by lane W + root and approved by the owner on 2026-08-30 (batch sign-off comment on this card), which recorded the policy as standing exactly as drafted.

`useEscUnwind` becomes the one sanctioned entry point for escape layering, taking the guard policy as an argument; the delete confirm stays raw (per the verdict above); enforcement is a gate check flagging any new raw Escape `addEventListener` in web/ outside the sanctioned module. Full Base UI migration is REJECTED for now: the two hand-rolled surfaces exist precisely because Base UI's dismissal does not reach them, so migrating costs a rewrite of both for no behavioral win.

### Consequences

- New escape handling must route through useEscUnwind or trip the gate; the gate's allowlist is the one raw site with its verdict comment.
- The gate lands with the policy (invariants belong in the gate), as its own build card — filed separately, referencing this decision.

— [root, session 5ac9e162-3e3a-40a1-8d13-38c0e121fc51]

## decision-042

- **Slug:** `decision:decision-042`
- **Title:** decision-042: no create-time assignee defaulting — an item created without an assignee is Unassigned

Status: Accepted

### Context

PBTT-386's e2e work surfaced that `pb_hooks/main.pb.js:6-22` silently defaults a bare task create's assignee to the project owner, which makes the board's Unassigned column nearly unreachable. The proxy's `?? owner_id` grouping fallback is separately dead code over a null stub. Full finding: PBTT-456. Prior art: Linear does not default — an issue created without an assignee sits in Unassigned regardless of creator.

### Decision

Owner ruling 2026-08-30 (direct, batch sign-off): **drop the defaulting**. An item created without an assignee is Unassigned.

### Consequences

- PBTT-456 builds it: the defaulting hook path is removed; the PBTT-386 spec's pinned assertion (bare create's stored assignee = owner) flips deliberately in the same change; the dead `?? a.owner_id` fallback and its null-stub field are deleted.
- The Unassigned board column becomes a real destination; bulk loader (PBTT-424) and import (PBTT-437) must not reintroduce defaulting.

— [root, session 5ac9e162-3e3a-40a1-8d13-38c0e121fc51]

## decision-043

- **Slug:** `decision:decision-043`
- **Title:** decision-043: item identity display keys — key follows the item, owner-confirmed prefix at create, one shared per-project sequence

Status: Accepted

### Context

PBTT-422 (two-layer identity, ruling D of the PBTT-406 dogfood sign-off) establishes the uuid as the only real key, with a per-project prefix+number (`ENG-42`) as a display-only label. Three design questions were deliberately left to the owner ("do not guess — surface to owner"): what happens to the key when an item moves projects, how a project gets its prefix, and whether the four item types share one number sequence. Prior art consulted per the standing rule: Linear mints an identifier once and it follows the issue forever; Linear auto-suggests a team key from the name at create, user-confirmable, fixed thereafter; every Linear issue type shares the team's one sequence.

### Decision

Owner ruling 2026-08-31, batch sign-off:

1. **The display key follows the item and never changes.** After a move to another project the prefix no longer matches the new project — that is accepted; no re-keying, so no link, reference, or spoken name ever breaks or gets reused.
2. **Project key prefix: suggested from the name at create, user-editable before confirm, FIXED after.** Never silently derived (names are display-only, never keys — standing ruling); the ~60-project bulk load (PBTT-424) carries explicit keys in its input rather than inventing them.
3. **One shared number sequence per project across all four item types** (tasks, decisions, documents, milestones). A number uniquely names an item within its project; the type shows in the icon/label, never in the counter.

### Consequences

- PBTT-422 is now buildable: all three open design questions are ruled; its AC#4's item-move rule is recorded here.
- PBTT-424 (bulk loader) input format must carry a `key` per project (consequence of #2), and 422 must land first (sequencing ruling J).
- The existing per-workspace `tasks.seq` and the `TSK·` prefix map give way to the per-project shared sequence — migration/compat handling is 422's build concern, designed against this record.

## decision-044

- **Slug:** `decision:decision-044`
- **Title:** decision-044: absent prose subsections get an inline add affordance

Status: Accepted

### Context

Found by the PBTT-480 build and filed as PBTT-491: `attrsProseSections` returns only non-empty sections and `Description.tsx` offers the primary field only when ALL of a type's prose is empty — so a decision with Context but no Consequences can never gain the missing subsection through the UI; the create form was the only path. The house rule (behavior.md) says a section with no data renders null; the one ruled exception today is the generic Description. Prior art per the standing rule: Linear's issue/document surfaces offer empty blocks inline.

### Decision

Owner ruling 2026-08-31, sign-off form: absent prose subsections get an inline add affordance ("Add consequences…"-style) on the item page for roles that can edit; read-only roles see nothing. This amends the render-null rule for a type's OWN prose fields: the affordance renders in place of the absent section, matching the shape of the existing Description exception (writer sees the entry point, reader sees nothing). Rejected: keeping create-form-only.

### Consequences

- PBTT-491's AC#1 is satisfied by this record; that card splits into buildable work (extend the PBTT-480 AttrsProse editing path with per-section add — MarkdownEditor, single-field commit, Escape layering per decision-041).
- behavior.md's render-null rule gains a second ruled exception; the divergence record should cite this decision when the build lands.
- The one-affordance-per-record rule (docs/design-divergences.md, "empty primary field") governs the all-empty overview and stands; how multiple absent subsections present (stacked entry points vs a single control) is a build-time design choice inside this ruling.

## decision-045

- **Slug:** `decision:decision-045`
- **Title:** decision-045: web-e2e scales by sharding across runners, never by workers inside one room

Status: Accepted

### Context

The PBTT-408 spike measured the web-e2e job at 61% of all CI minutes (median 868s job / 791s suite step, n=45) with 712 of 791 suite seconds being test execution — no structural overhead to reclaim. The suite is serial (`workers: 1`) against one shared seeded PocketBase room by design. PBTT-533 built the ruled configuration; canonical record: `decision:web-e2e-sharding` in app_docs (seed migration `1785159600`, rendered in `docs/decisions.md`).

### Decision

Ruled via PBTT-533, which built the configuration and verified it on PR #555.

Scale web-e2e by `--shard` across runners (4 shards via `strategy.matrix`), never by workers inside one room. Each shard runs its own `globalSetup` and gets its own clean room, serial within — a faithful copy of the single-job isolation. Ruled out by measurement, do not revisit without new evidence: `--workers=4 --fully-parallel` (197s, 21 failures) and `--workers=4` file-parallel (192s, 7 failures) — both state collisions against the shared room; bigger runners (only 1.30× on a 12-core M2 Pro — latency-bound, not CPU-bound); build-artifact sharing (`next build` is 4.4% of the job).

### Consequences

- Verified on PR #555 (this ruling's build): four shards green, slowest 5m29s wall (was 13.8m single-job, 2.5×); combined 72+66+68+66 = 272 tests = the single-job count; no state-collision signatures; no retries in any shard log.
- Runner minutes on the job rise ~46% measured (20m13s vs 13.8m; projection said +54%) — accepted cost, stated in the PR.
- Sharding changes no flake behavior (PBTT-412 owned the flake); `retries: 1` stays until PBTT-535 rules on removal.
- PBTT-535/536 evidence counting: one push now yields FOUR web-e2e job logs — state which were counted.
- Supersedes PBTT-377's rate-ceiling premise (`clean-room.ts:88` disables rate limits at room boot). Confirms PBTT-460.

## decision-046

- **Slug:** `decision:decision-046`
- **Title:** decision-046: Board state model on kata — open/closed + labels replace Kaneo lanes

Status: Accepted

### Context

The board moved from Kaneo (eight lanes) to kata (two statuses, open and closed, plus owner, labels, and blocked-by/related/parent links) on 2026-09-02. Kaneo's lanes had to land somewhere; the mapping is a convention kata does not validate, so it needs a record. Prior art: Linear and GitHub Issues both model reference material and decision records as ordinary issues distinguished by label, and treat closed as the terminal, immutable state.

### Decision

- `to-do` → open, unowned, no lane label (the backlog). `up-next` → open + label `up-next`. `in-progress` → owned (`kata claim`). `in-review` → open + label `in-review`. `done` → closed with evidence. `blocked` → `--blocked-by <ref>` for a real prerequisite, label `blocked` otherwise, always with a comment naming the unblock condition. `planned` no longer exists.
- Documents → open + label `doc` (living reference stays listable). Decision records → label `decision`; `Status: Proposed` stays open, any other status closes the issue — closed is kata's word for immutable, which is what an accepted record is (decision-012, PBTT-336 immutability ruling). Supersession is `--related` plus the status line.
- Migrated issues carry `kaneo_task_number`/`kaneo_task_id`/`kaneo_column` metadata and a `kaneo-status:<lane>` provenance label that is never maintained.

Enforced by `scripts/check_decision_cards.py` (label ⇔ title prefix, status line ⇔ open/closed). Written into `.claude/instructions/kata-board.md`.

### Consequences

`kata ready`/`kata next` list open docs (priority 4 sinks them). A decision needs `kata reopen` only to correct a migration mistake, never to change course — course changes are a new record.

## decision-047

- **Slug:** `decision:decision-047`
- **Title:** decision-047: cycles roll unfinished work forward automatically

Status: Accepted

Accepted (owner ruling 2026-09-02, card 55d7). Filed by the root session from the wave K5 manager's draft; wording corrected to match what shipped where the build deviated from the draft.

### Context

Cycles are time-boxed iterations that span a workspace (owner ruling: "cycles are
workspace objects"), default to two weeks, carry custom names, and allow any sensible
custom start and finish date. A cycle is a property an item is assigned to, not a
container the item lives inside, so assigning a cycle never moves an item between
projects.

The question the card left open: when a cycle ends, what happens to the work in it that
is not finished? Two candidates — roll it into the next cycle automatically, or leave it
in the ended cycle and make a person move it.

### Prior art

**Linear Cycles.** Cycles are team-level (the analogue of this app's workspace-level),
upcoming cycles are auto-created ahead of time, a cycle is a property of an issue rather
than a container, an optional cooldown period can sit between cycles, and **unfinished
issues roll into the next cycle automatically at cycle end** — that automatic rollover is
the behaviour users cite as the point of cycles, more than the date range itself. Linear
also permits no overlap between cycles within a team. Jira calls the same object a Sprint
and rolls incomplete issues into the next sprint at sprint close, but only when a person
runs the close ceremony. Plane calls it a Cycle and leaves the work behind by default.

Repo law is prior art first, then rule explicitly (owner ruling 2026-08-08).

### Ruling

**Unfinished work rolls into the next cycle automatically at cycle end** (owner ruling
2026-09-02, agreeing the recommendation). A per-workspace opt-out is later work, not part
of this release.

Consequent rulings taken to make that implementable, each stated rather than assumed:

1. **Unfinished means not resolved, not merely "not done".** A task rolls UNLESS its
   status category is `completed` or `canceled` — so work in triage and work carrying no
   status at all roll too, rather than being stranded. Canceled work is resolved, and
   dragging it forward forever would make every cycle accumulate abandoned work. (The
   negative form is deliberate: a positive list would silently strand any category added
   later.)
2. **Cycles in one workspace may not overlap.** Linear enforces the same within a team,
   and automatic rollover independently requires it: with overlapping cycles "the next
   cycle" has no single answer. A cycle covers its start and end dates inclusively; the
   next cycle begins the day after.
2b. **A cycle is a day object, not an instant.** The owner's words are "any sensible start
   and finish date", the form uses a native date control, and Linear's cycles are
   day-granular. The storage type accepts a time component, so both dates are normalised
   to midnight before anything compares them. Without this the no-overlap rule is not the
   rule it claims to be: a review proved that two cycles could share one calendar day and
   that a cycle could start and end on the same day, which would leave "the next cycle"
   undefined again and make ruling 2 false in practice while reading as true.
3. **The next cycle is auto-created when it does not exist**, the same length as the one
   that ended and following it in contiguous spans of that length, starting on the FIRST
   such span that has not itself already ended — so a workspace left dormant for months
   lands its work in a cycle that is still running, not one already over, and the sweep
   converges. This leaves a hole in a long-dormant workspace's cycle history rather than
   materialising every intermediate span; gap-vs-chain is an owner question (recommendation:
   keep the gap). Linear likewise keeps upcoming cycles created ahead.
4. **An auto-created cycle is named for the date it starts.** Names are display-only and
   never keys (owner ruling), so the generated name is a placeholder a person renames; a
   date-derived name is collision-free precisely because cycles cannot overlap, and needs
   no counter that a delete would desynchronise.
5. **Only tasks carry a cycle.** Linear assigns cycles to issues only. Documents,
   decisions and milestones do not get one; a cycle is a plan for work, and those three
   are not work.
6. **Cycles are not trashable — deleting one is a hard delete.** The trashable set in
   this repo is exactly the item types and their two containers; every workspace-scoped
   configuration object (labels, statuses, saved views, templates) hard-deletes. A cycle
   is configuration an item points at. Deleting a cycle clears the reference from its
   tasks; it never deletes the tasks.
7. **The sweep is idempotent, not transactional.** One run catches up every already-ended
   cycle in date order, so a second run immediately after moves nothing. A run that fails
   part-way leaves a consistent partial result that the next run completes; this is chosen
   over a whole-sweep transaction, which would make one bad row block every workspace.

### Consequences

- A person who wants work to stay in a finished cycle must close or cancel it first;
  there is no per-item "do not roll" flag, and adding one is new work.
- The record of which cycle an item was originally planned into is not retained: a rolled
  item now reads as belonging to the cycle it moved to. Linear behaves the same way and
  keeps that history separately. Filed as a follow-up rather than solved here.
- The per-workspace opt-out named in the owner ruling is deferred, explicitly.

**Supersedes:** nothing. **Related:** card 55d7 (cycles), decision-021 (prior art first),
decision:role-tiers (owner/admin write on workspace configuration).

## decision-048

- **Slug:** `decision:decision-048`
- **Title:** decision-048: tasks have no draft state — drop tasks.draft rather than add author-scoped privacy

Status: Accepted

### Context
`tasks.draft` exists (1785150800) but `tasks` has no `author` field and no rule carries a draft carve-out (8fzz, found by mutation in the wave J zmdt audit). Documents, decisions and milestones got author-scoped draft privacy in 1785154800; tasks were left out because the search route's draft clause 400s without an author column. Today a draft task is visible to every member on every surface, while the frontend contract (`web/openapi.contract.json`) does not expose `draft` on tasks at all — nothing writes it through the proxy.

### Prior art
Linear has no server-side issue drafts: issue creation is atomic, and the composer's unsent draft lives client-side only. Documents in Linear do have a draft/published distinction. That maps exactly onto this app's split — item-level drafts for documents/decisions/milestones, none for tasks.

### Decision
Drop `tasks.draft`: remove the column, any index, hook references (`pb_hooks/activity.pb.js` tracked-field list, search/export arms), its `app_docs` prose and the model-tree vocabulary, in one migration + regen. Tasks gain no author field. A task is never private to its creator; the composer's unsent state stays client-local.

### Consequences
- No vestigial field (owner ruling: delete column + index + hooks + tests together).
- `scripts/model/diff_model.py` must show no unclaimed vocabulary after the drop.
- Reversal would be a new decision adding `author` + the documents-shaped privacy branch to tasks.

### Alternatives rejected
- Add `tasks.author` and the documents-shaped draft branch: more schema, more rules, a privacy surface for a state the product does not use.

## decision-049

- **Slug:** `decision:decision-049`
- **Title:** decision-049: suspended-member and trashed-workspace refusal is enforced at the collection-rule tier as well as the app tier

Status: Accepted

### Context
decision-027 (08y7, PBTT-235) ruled that suspended-member and trashed-workspace entry is enforced at the app tier and the workspaces rules stay as-is. Since then two shipped changes moved that enforcement into rule text without a superseding record: PBTT-431 pinned status = active on every membership grant (now gate-enforced by 5ad2), and edc3 (#597, 2026-09-03) gave workspaces.viewRule the trashed clause its listRule carried, so a trashed workspace is a 404 at the PocketBase tier for every non-superuser. The register curator flagged the register row citing 027 as false.

### Decision
The rule tier is the enforcement point for both refusals; the app tier keeps its own checks as defence in depth and as the source of the user-facing verdict (no-workspace panel, suspended panel). A consequence measured in #597: PocketBase omits an expand the caller cannot view, so every app-tier consumer of an expand must treat an absent expand as the hidden state (memory: pb-expand-omits-hidden-records).

### Consequences
- decision-027 is superseded by this record; its body stays as history.
- Restore of a hidden record can no longer go through a rule-scoped read (htsr, H2).
- The 23c4 visibility suite and the 5ad2 membership gate are the standing proofs.

### Alternatives rejected
- Reverting edc3/PBTT-431 to honour 027 literally: reopens the leaks 23c4 measured.

## decision-050

- **Slug:** `decision:decision-050`
- **Title:** decision-050: trashing a workspace cascades to its contents; active admins enumerate and restore trash

Status: Accepted

### Context
Trashing a workspace today hides only the workspace row. Measured 2026-09-06 in a clean room (g7kg, absorbing w7f6 and 24ed): after a workspace is trashed, all of its projects and tasks stay listable, viewable, editable and open to new task creation by plain members through direct PocketBase auth (`ws view=404 list_n=0 | proj view=200 list_n=1 | task view=200 list_n=1`, `member PATCH task -> 200`, `member CREATE task -> 200`); `rg -n 'workspace.trashed' schema/ pb_migrations/ pb_hooks/` returns nothing. Separately, since edc3 made trash enumeration owner-only, an active admin still passes `workspaces.updateRule` and can restore a workspace it cannot enumerate or view (`admin -> 200` on the un-trash PATCH, `count=0` on enumeration).

### Prior art
Linear: deleting or archiving a team removes its issues from every view, search and list until the team is restored; workspace admins manage archived teams, not only the workspace owner.

### Decision
- R1 Cascade: trashing a workspace hides every project and item under it from every reader (search and export routes, the four item listRules, the `project_items` and `project_stats` views, the session workspace summary) and refuses writes under it (member PATCH and CREATE fail). Un-trashing restores all of them.
- R2 Admin enumeration and restore: trash enumeration and un-trash extend to active admins; owner-only enumeration (edc3) widens to owner + active admin.

Ruled by the owner in the 2026-09-06 sign-off batch (both recommendations accepted, no notes); drafted by root under the standing grant and recorded Accepted on that ruling.

### Consequences
- g7kg builds the cascade (AC#2, #3), the row-hidden visibility cases (AC#4), the five-tier enumerate/un-trash matrix (AC#5) and the coupled regens (AC#6); its migration slots are pre-assigned on bbqd.
- `tests/test_visibility_invariants.py` derives workspace-trashed cases in the ROW-hidden direction (20yb owns the derivation loop; g7kg appends cases).
- The register row `items-properties.trashed-content-excluded-from-search-and-list-surfaces` loses its workspace caveat once g7kg lands.
- The switcher's Trash entry (edc3) reflects owner + active admin.

### Alternatives rejected
- List-only (hide the workspace row alone): leaves every child reachable and editable under a container the user cannot see; contradicts the Linear model.
- Refuse admin restore: an admin who can update the row but cannot see it is a dead end, not a safeguard.

## decision-051

- **Slug:** `decision:decision-051`
- **Title:** decision-051: the Inbox is My items clamped to open work; both share one descriptor; Created/Subscribed tabs deferred

Status: Accepted

### Context
Wave K1 shipped My items (`/my-items`: items assigned to me across every project). `InboxScreen.tsx` is already an assigned-to-me cross-project list clamped to open items and grouped by project (permanent filter `assignee_id = me && open = true`, `forcedGroup="project"`); the notification feed is the header bell. The two screens differ only by the open clamp and the grouping. The shared group control offers `none | status | assignee | priority`; `project` exists in the type but reaches a list only through `forcedGroup`, whose single call site is the Inbox. Linear's My Issues also offers Created and Subscribed tabs (deferred by owner ruling 2026-09-02, tracked only in a code comment).

### Prior art
Linear: My Issues is one screen with Assigned / Created / Subscribed tabs; the Inbox is the notification feed, a different surface with a different job. Grouping by project is a user-selectable display option on any cross-team view.

### Decision
- R1 Keep both surfaces. The Inbox and My items share ONE list descriptor (one definition of "mine": assignee = me), and differ only by their documented clamp: the Inbox is My items restricted to open work, grouped by project by default; My items is the full assigned-to-me set. The notification feed stays the header bell. Neither is a saved view of the other.
- Project grouping becomes a user-selectable value in the shared group control; `forcedGroup` goes away; My items defaults to project grouping; on a single-project list the option is hidden or renders one degenerate-safe group (the build states which).
- R2 Created and Subscribed tabs stay OUT for now. The deferral lives on this record and on card dsw5's closing comment, not in a code comment.

Ruled by the owner in the 2026-09-06 sign-off batch (both recommendations accepted, no notes); drafted by root under the standing grant and recorded Accepted on that ruling. Supersedes nothing (decision-046 is the state model; no earlier record defines the Inbox).

### Consequences
- dsw5 builds it: shared descriptor, group control gains `project`, Inbox drops `forcedGroup`, e2e for both screens assert the ruled behaviour, register rows `inbox-notifications.inbox-screen` and `lists-views.my-issues-assigned-to-me-cross-project-view` updated.
- The `deliberately deferred` code comment in `MyItemsScreen.tsx` is deleted (`rg -n 'deliberately deferred' web/app` → 0).
- A future Created/Subscribed tabs card cites this record; adding them is not a reversal.

### Alternatives rejected
- Inbox as the notification feed rendered as a page: the bell already is that surface; two feeds diverge.
- Inbox as a saved view of My items: a saved view is user-editable and deletable; the Inbox is a fixed entry point.

## decision-052

- **Slug:** `decision:decision-052`
- **Title:** decision-052: project-less items land in an invisible per-workspace shadow project

Status: Accepted

### Context
Items can be created with no project: a plain user POSTing a task with no project gets 200, the row stores `project=''`, and reads it back with 200 (measured 2026-09-06). Owner ruling 2026-08-13 (PBTT-324 sign-off): items created without a project get a default shadow project tied to the workspace. Owner ruling 2026-08-14 against decision-020: the shadow project is an INVISIBLE CONTAINER — the user is never handed a project to delete, so decision-020 stands unamended. Both rulings are quoted verbatim on rq94. The `projects` list and view rules are one shared string (`v1:1785163200_projects_trashed_clause.js`), so one exclusion clause covers list and direct GET. Three hook sites create a default project (`main.pb.js:439` user-create auto-provision; `main.pb.js:644` and `trash.pb.js:524` last-workspace re-provisions). `workspaces.default_project` is a VISIBLE user-set pointer and a different concept; it is not reused.

### Prior art
Linear: every issue belongs to a team; there is no project-less issue. An issue with no project sits in the team's backlog — a container the user never deletes.

### Decision
1. Every workspace owns exactly one shadow project, provisioned by the same code path as the workspace itself (the three hook sites converge on one provisioning helper, inlined per the pooled-JSVM law with KEEP IN SYNC markers). An item created with no project lands in its workspace's shadow project at the rule/hook tier.
2. The shadow project is invisible at the PocketBase tier: excluded from `projects` list AND view for owner, admin and member through the shared rule string; never present in an `expand=project`; absent from the `rt:project_items:{workspaceId}` envelopes. Its items are reachable: they list under the workspace, in My items, in the Inbox and in search.
3. Backfill: one migration creates the shadow project for every existing workspace and moves every existing `project=''` item into it; the hook does the same for new workspaces, so a fresh boot and a migrated database reach the same end state (proven by the two-room diff in eew9 AC#4). Backfills are historical-only.
4. Trash fate: the shadow project follows its workspace — trashed when the workspace is trashed, restored with it (decision-050's cascade), never trashed or purged on its own.
5. Rename and delete: neither. The rule tier refuses update and delete on the shadow project for every role; no UI can reach it because it is never listed.

Ruled by the owner in the 2026-09-06 sign-off batch ("accept the decision record as drafted"); drafted by root under the standing grant with the three open questions answered as above, and recorded Accepted on that ruling. Supersedes nothing; decision-020 stands.

### Consequences
- eew9 builds the PocketBase tier (rules, provisioning hook, backfill migration, visibility-invariants case, fresh-boot parity, register rows `board.a-workspace-items-lane-for-project-less-items`, `comments-activity.project-less-item-comments-get-owner-admin-moderation`, `comments-activity.activity-visible-for-project-less-items`); xfhv builds every web surface.
- "Project-less item" stops existing as a concept; the three register rows carry that verdict.
- A visible "workspace backlog" surface, if ever wanted, is a new decision that reveals the container; it is not a reversal of invisibility.

### Alternatives rejected
- Backfill new-only: leaves two kinds of item forever and breaks fresh-boot parity.
- Reusing `workspaces.default_project`: a visible, user-editable pointer with different semantics.
- Making the shadow project renameable: a name implies a surface; invisibility is the ruling.

## decision-053

- **Slug:** `decision:decision-053`
- **Title:** decision-053: a trashed workspace freezes its configuration and roster; its owner and admins may only restore it or read why it was trashed

Status: Accepted

### Context
Decision-050 ruled on "every project and item under" a trashed workspace, so `labels`, `statuses`, `cycles`, `templates`, `saved_views` and `workspace_members` got no workspace-alive leg. Measured by g7kg's security audit (3d2s): while the workspace 404s, its vocabulary, roster, cycles, templates and shared saved views stay listable AND writable by every active member; the owner can invite a new member into a workspace the app says is gone (`POST /api/collections/labels/records {"workspace":"<trashed>"}` → 200; `GET workspace_members?filter=workspace='<trashed>'` → 200 with the full roster). Separately (5gkp), the web proxy calls `authorizeWorkspaceSwitch` on every request and it 404s a trashed workspace for its own owner, so no stated refusal reaches a browser and the admin restore path decision-050 promised has no proxy route.

### Prior art
Linear freezes a deleted workspace or team entirely during the grace period and offers only restore; admins keep exactly that path.

### Decision
- R1 Freeze: when a workspace is trashed, writes to all six configuration collections under it are refused for every tier (create, update, delete). Reads of those collections stay open only to the owner and active admins, the tier decision-050 lets enumerate and restore; every other reader gets the same hidden state as the content tier. Configuration is what a restore lands back into, so it freezes rather than cascades.
- R2 Proxy: for a trashed workspace the proxy admits exactly two owner/admin actions, restore and reading the trash reason; every other request stays 404 for every tier, byte-identical to today.

Ruled by the owner in the 2026-09-07 sign-off batch (both recommendations accepted, no notes); drafted by root under the standing grant and recorded Accepted on that ruling.

### Consequences
- 3d2s and 5gkp build as one security lane (plan v5, `trashed-workspace-owner`) with an independent auditor: migrations add the workspace-alive leg per collection + app_docs + schema/openapi/model regen; `tests/test_visibility_invariants.py`'s `is_content()` predicate learns the freeze distinction; e2e proves the two admitted proxy actions RED first and every other tier stays 404.
- The admin restore surface from decision-050 gains its proxy route.

### Alternatives rejected
- Leave configuration writable and record it as intended: an owner can grow the roster of a workspace nobody can see; contradicts the Linear model.
- Full read-only owner/admin access through the proxy: widens the surface for no restore-path need.
- Freeze writes but leave reads open to all members: the roster and saved views of a trashed workspace would still be visible to every member while its content is not.

## decision-054

- **Slug:** `decision:decision-054`
- **Title:** decision-054: board labels carry three axes (kind, surface, area) plus a user-facing flag; checked on demand

Status: Accepted

### Context
Decision-012 closed the label vocabulary to two axes (kind; area/campaign) but named `docs` on one axis and `backend`/`frontend` on the other, so by 2026-09-07 24 of 102 open work cards had no kind, 5 had no surface, and "how much of the queue is frontend vs backend, fix vs feature" could not be answered by `kata list`. The owner asked for that breakdown, then for a convention that keeps it answerable, before re-planning waves for velocity. Root's first draft the same hour carried six kinds, four surfaces and an eleven-value area axis; the owner cut it back before any card was filed against it: members of each category MECE, default to fewer labels, add one only for a clear distinction and need, no maintenance burden.

### Prior art
Linear labels are flat but grouped (a label group is an axis with one value per card); GitHub's `type:` convention does the same by name. Both keep the vocabulary small and closed.

### Decision
- Two axes on every open work card: **kind**, exactly one of `bug` (behaviour contradicts a spec, ruling or reasonable expectation) / `feature` (a capability users did not have) / `task` (everything else: tests, gates, docs, refactors, hardening, chores); **surface**, one or more of `backend` / `frontend` / `tooling` (scripts, gates, harnesses, CI, deploy and infra).
- One flag, `security`: an attacker-usable defect or a hardening step; it routes a lane to an independent auditor. A flag, not a kind.
- No area axis: screen or subsystem is answered by `kata search` over titles.
- Retired from open cards, history on closed ones: `chore` `test` `docs` `contract` `e2e` `a11y` `ci` `ops` `spike` `web` `v2` `reference` and `kaneo-status:*`.
- `scripts/check_board_labels.py` enforces the axes and refuses a retired label on an open card; kata-reading, so on demand (same carve-out as `check_decision_cards`).

Ruled by the owner 2026-09-07 ("add these labels and make a project convention for how we use kata"; then "label members in each category should be MECE, default to fewer labels"); applied by root: 114 open cards relabelled, the checker went RED on real misfiles (w6rx, four doc records) before going green.

### Consequences
- `.claude/instructions/kata-board.md` "Board vocabulary" carries the axes; decision-012's closed-vocabulary principle and DoD-as-code stand (this record extends it, it does not supersede it).
- Filing a card means one kind + at least one surface; a triage pass ends with the checker green.
- Velocity views read directly: `kata list --label frontend --label bug`, `--label security`.

### Alternatives rejected
- Six kinds (bug feature chore test docs security): `chore`/`test`/`docs` overlap on most tooling cards and `security` is orthogonal to kind — not MECE.
- An area axis (list-board, show-peek, palette, hooks, gates…): eleven labels to keep current for a question titles already answer; `a11y` cuts across every screen so it was never mutually exclusive.
- Prefix labels (`kind:bug`): kata renders labels flat and the existing 200+ bare labels would need renaming on closed cards.

## decision-055

- **Slug:** `decision:decision-055`
- **Title:** decision-055: a notification kind may ship with a producer outside pb_hooks/notify.pb.js

Status: Accepted

Filed by the root session under the standing grant after wave v6 lane B2 (PR #679) falsified the vocabulary statement inside `decision:notification-mentioned-reserved`. The owner ratifies or vetoes; a veto is a new decision, never a reopen.

### What went false

The live record says:

> the live vocabulary is assigned, commented, status_done, mentioned - four values across five emitters in pb_hooks/notify.pb.js, every one of them a live code path.

Two independent falsehoods as of PR #679:

1. The vocabulary is FIVE values. `schema/notifications.json`'s `kind` select reads assigned, commented, status_done, mentioned, ownership_transferred.
2. "every one of them ... in pb_hooks/notify.pb.js" no longer holds. `ownership_transferred` is emitted from the workspace transfer-ownership route in `pb_hooks/routes.pb.js`, inside that handover's own transaction.

The second is the load-bearing one. The original record's argument was the no-vestigial-fields rule - a kind must ship with its producer - and it located "producer" in one file. That premise is what this wave broke, not the ruling itself.

### The ruling

The `notifications.kind` vocabulary carries five values. This record supersedes the VOCABULARY STATEMENT in `decision:notification-mentioned-reserved`; the ruling that statement supported still stands and that record is not reopened.

What stands: a kind still ships with its producer, and a vocabulary entry nothing can write is still a vestigial field to be removed together with its contract type and its client rendering branch.

What changes: the producer need not live in the fan-out file. `ownership_transferred` is written by the ownership-transfer route inside that transfer's transaction, because the notice must be written or rolled back with the handover it announces. Moving the emission into the fan-out file would mean either a second transaction - which can leave a transfer announced but not performed, or the reverse - or a callback from the route into the fan-out, which buys nothing and hides the coupling.

### Why this is a decision and not a note

The consequence is a gate. A checker that proves the vocabulary by reading one emitter file, or by reading a historical migration's list, cannot see a kind produced elsewhere. `scripts/check_constants.py` did exactly that and reported green over a four-value claim while the live select held five. PR #679 changed it to read the vocabulary from `schema/notifications.json`, which is generated from the migrations, and to make each value declare WHERE its emitter lives - so a kind with no producer anywhere still fails.

### Acceptance Criteria

1. An `app_docs` decision record exists under a new slug, seeded by a new migration, citing this number and `--related` to the record whose vocabulary statement it supersedes.
2. No existing decision record is edited and none is reopened.
3. `docs/generated/decisions.md` is regenerated, not hand-edited.
4. `scripts/check_decision_cards.py` exits 0.

### Definition of Done

1. `make dod` exits 0 on the touched scopes.
2. The seeded body is read back from a replayed DB and quoted at close, not asserted from the migration source.
3. This card's status line moves to Accepted or Rejected only by the owner.
4. Follow-up work discovered while building is filed as its own card referencing this one.

## decision-056

- **Slug:** `decision:decision-056`
- **Title:** decision-056: a superuser ownership transfer names its operator in the audit row

Status: Accepted

Owner ruling 2026-09-08 (sign-off batch `6df6`, item B). Filed by the root session; the owner chose among three options posed on `95s3` by the independent reviewer of PR #679 and has ruled, so this record is Accepted on creation and closed. A change of course is a new record via `--related`, never an edit or a reopen.

### The question

`task_activity.actor` is a relation to `users`. A superuser id lives in `_superusers`, so the transfer-ownership route (`pb_hooks/routes.pb.js`, the `if (!isSuperuser) audit.set("actor", uid)` guard) stores an EMPTY actor for a superuser transfer, and `web/lib/proxy/handlers/audit_log.ts` renders an empty actor as `{ kind: "system" }`. So the one transfer path that can take a workspace from an unwilling owner is the one that reads on the audit screen as an act of the system rather than of a person.

Options posed: (a) leave it as system, break-glass is anonymous by construction; (b) add a plain-text operator column filled only on superuser-initiated writes so the relation stays clean and the row still names someone; (c) require the operator recipe to pass an accountable human user id and refuse without one.

### The ruling

**(b).** `task_activity` gains a text column carrying the operator identity (the superuser record's email) that the transfer route fills ONLY when the caller is a superuser; the `actor` relation stays empty in that case. The audit screen renders a row with an empty actor and a non-empty operator as an operator action naming that identity, never as "system". "system" remains reserved for rows genuinely written by no one.

### Why

- Prior art: GitHub audit logs name the actor for admin actions and mark impersonation explicitly rather than blanking the field. An audit trail whose least-consented event is its least-attributed one is inverted.
- (a) makes break-glass unattributable by construction; (c) forces the operator to borrow a user's identity, which is impersonation dressed as attribution and can pin an act on someone who did not do it.
- The relation stays honest: the column is not a second actor, it is the identity of the hand that acted when no user did.

### Consequence

A build card carries the column, the route write, the rendering branch, the contract type, RED-first proofs and the app_docs record for this number (`gen_decisions.py` output regenerated, never hand-edited). Nothing else changes: transfers by an owner keep writing `actor`.

### Acceptance Criteria

1. This record exists with the ruling above and links to `95s3` (the finding) and `jt4g` (decision-055, the record that made the transfer-audit row's producer explicit).
2. `scripts/check_decision_cards.py` exits 0 with this record present.

### Definition of Done

- [ ] #1 `scripts/check_decision_cards.py` exits 0 (board-reading; not part of `make dod`)
- [ ] #2 Evidence per acceptance criterion: the command run and its actual output — never a claim, never code presence
- [ ] #3 The app_docs record for decision-056 is seeded by the build card, which cites this ref
- [ ] #4 Closing comment names the sign-off batch and the option chosen

## decision-057

- **Slug:** `decision:decision-057`
- **Title:** decision-057: findings fold before they fan out — fix the class, land supplied patches, one hardening card per wave, drafts attach to an open card

Status: Accepted

Owner ruling 2026-09-08, in conversation with the root session, after the owner observed that the board grows about 1.2 cards per card closed whenever agents work it, and asked for the number to go below 1 without ignoring real work. Measured the same day: 65 work cards filed by agents against 56 closed (1.16), 29 of the 65 drafts.

### What was found

Of the 65 filed that day, by kind: about 8 were SIBLING SITES of the thing a card was fixing (k2ah: two more copies of the lookup 90ae fixed; q21s: thirteen more copies of pk8r's assertion; bwfc: the shell twin of cbbx; z2da and btdy: consequences of 8n09 and 5mhz); about 15 were GATE GAPS (a checker that could not have caught the defect just fixed), one card each; about 17 were real defects found by adversarial review; about 6 were rulings and flake sightings; 29 were drafts. The sibling-site and gate-gap cards exist because a lane may only touch its ownership map and a card's acceptance criterion said "fix the site" rather than "fix the class", and because the 2026-08-06 ruling that follow-ups are filed immediately was read as one card per finding.

### The ruling

The 2026-08-06 ruling stands: filing needs no approval and nothing found is dropped. What changes is WHERE a finding lands first. In order:

1. **Fix the class, not the site.** A card that fixes a defect at one site fixes it at every site of the same shape. The premise-gate scout lists the sibling sites of each card's defect, and the brief's ownership map covers them. A builder who finds another site of the shape it is fixing fixes it; a sibling site is never its own card.
2. **Root lands a supplied patch.** A lane report that carries an exact hunk plus its test for a delta of roughly ten lines or fewer outside the lane's ownership is a landing hunk root applies, not a card.
3. **One gate-hardening card per wave.** A checker that could not have caught a fixed defect is appended, as a list item with its falsifier, to the wave's single hardening card; that card is built as a lane in the next batch. The same for flakes: one ledger card per suite, one sighting per line. Never one card per gap or per sighting.
4. **A draft attaches to an open card.** A lane files at most one draft per card it works; later findings of the same shape append to that draft as comments. A draft with no parent is a triage-session artifact, not a lane's.
5. **The ratio is measured per wave** and written in the wave's landing comment: cards filed by lanes during the wave divided by cards closed by it. Derive it, never estimate: filed = \`kata list --status all --limit 0 --json\` filtered by created_at in the wave's window and no doc/decision/handoff label; closed = \`kata audit closes --agent\` rows in the same window.

### Why

The board is the single authoritative task system, so a card is a promise to a reader that this is a unit of work. Eight cards for one defect class are eight promises for one unit, and a backlog that grows faster than it closes stops being readable as a plan — the owner's own words: too flat to tell what features a card enables. Prior art: Linear's own guidance keeps sub-issues under a parent and asks for "one issue per outcome"; GitHub's triage practice folds duplicates and siblings by reference rather than minting. The lazy-senior rule already in this repo's ponytail mode says the same for code: a fix in the shared function beats a guard in every caller.

### Consequence

\`.claude/instructions/kata-board.md\` "Owner rulings" carries this ruling next to the 2026-08-06 one it refines; \`AGENTS.md\`'s follow-up bullet points at it; the wave brief template's "How every card is built" gains the class rule and the premise scout's report gains a sibling-sites line. The next board session (owner ask, same conversation) clusters the flat backlog into feature-enabling groups so a card's parent says what it unlocks. Upstream: the atelier plugin's manager and reviewer escalate every out-of-scope delta with no fold-first step; a feature request is filed on hsb3/dotfiles-agents.

### Acceptance Criteria

1. This record exists, Accepted, related to the 2026-08-06 ruling's home (kata-board.md) and to the triage-session card.
2. \`scripts/check_decision_cards.py\` exits 0 with this record present.

### Definition of Done

- [ ] #1 \`scripts/check_decision_cards.py\` exits 0 (board-reading; not part of \`make dod\`)
- [ ] #2 The rule text lands in kata-board.md and AGENTS.md in the same session (PR named in the closing comment)
- [ ] #3 The upstream feature request URL is in the closing comment
- [ ] #4 Closing comment names the measurement the ruling rests on

## decision-058

- **Slug:** `decision:decision-058`
- **Title:** decision-058: authenticated screens share the accepted index and document page grammar

Status: Accepted

### Context and authority

This records the page grammar already ruled during the UI overhaul; it makes no new design choice. Sources are 0dmw comments 01M21HC3XTE0AZVNZ8N111C1CN and 01M21SHG7YBE8XW2DD4N4HNZ0T, vr4h comment 01M21PGJTJF5VQ0G1R9Y8NC9T6, and the final title/subtitle tightening preserved in merged PR #711 (16fb9328). Implementation and screenshot conformance remain on 0dmw and vr4h.

### Decision

Authenticated screens use two shapes. Index screens (items, board, inbox, my items, trash, members) have one 40px control bar immediately below the 48px app header; a second 36px filter band appears only when a filter is active. Document screens (cycles, project home, settings, item full view) have no control bar and use a 28px title, one-line dek and left-aligned 720px content measure.

Both shapes use a left-aligned container with a 1200px maximum and 24px inline padding. Tables reach the container edge. Spacing follows an 8px rhythm; bands are 40px or 48px, none over 56px, and adjacent form sections have no gap over 80px.

Type roles are page title 28px/500; sentence-case section, column and navigation labels 13px/600; body and cell values 13px/400. The accepted additional key/value-label role is 13px/400 in helper grey so it does not outweigh the value. The 11px uppercase, 0.08em Eyebrow is reserved for the position immediately above a page title.

Persistent chrome identifies the workspace and selected project. The screen control bar carries its title without repeating that location. A subtitle is distinct from a kicker or breadcrumb: 13px/500 secondary, after the title with a middle dot. The final accepted tightening permits subject data such as cycle dates, never guidance explaining a list. My items, Inbox, Trash and Audit omit that guidance; trash retention appears in the empty state and populated rows show their purge countdown.

The primary action is the most prominent control in its row when enabled or disabled. Destructive actions never lead or equal its emphasis and use overflow when the row has three or more actions. Empty states name what fills the screen before presenting the action. The workspace-home project form is behind an explicit action.

The responsive list contract applies the single-row shape at md (768px) and above; narrow widths use explicitly tested stacked rows. The composer property controls may wrap. These preserve the accepted rulings on 8hkc and zeza.

### Prior art and deliberate choices

The original decision sources vr4h and fq64 cite Linear's compact list control bar and conditional filter row; 069p cites its settings navigation replacing the application rail with an explicit return. Those recorded observations supplied the prior art; this transcription does not claim a fresh audit of Linear. The app's two page shapes, fixed maximum measures, padding, typography and rhythm are explicit local design choices, not claims that Linear uses these values.

### Consequences and verification boundary

Removing the duplicated address-derived screen witness reduced workspace-route-coherence checks from four witnesses to three (address, persistent chrome, rows); the original ruling accepts this coverage reduction. PR #711 and n2jh carry implementation and full-suite evidence. This decision's acceptance records the settled grammar; it does not close incomplete screenshot, measurement or conformance criteria on 0dmw, vr4h or their children.

### Acceptance Criteria

- The board record preserves the already accepted grammar, subsequent chrome/subtitle rules and accepted typography/responsive deviations with their sources.
- Conformance and remaining evidence stay on the existing implementation cards; no new product scope is introduced.

### Definition of Done

- Verify the transcription against the cited board comments and merged PR #711.
- Link 0dmw and vr4h and close as an accepted decision with audit evidence.
- Run scripts/check_decision_cards.py after recording it.

## decision-059

- **Slug:** `decision:decision-059`
- **Title:** decision-059: Item editors give the document its own measure

Status: Accepted

### Context

The owner requested a full overhaul of both item editor screens, prioritizing the full page, following approval of n5pw. Current ResourceShow limits the whole page to 768px while reserving 320px for properties; this defeats the document measure and overflows on phones. This decision refines decision-058 for item editors only and preserves decision-005: one tabbed full-page layout, no user-facing layout switcher.

### Prior art

Linear documents its peek as an at-a-glance preview containing description and key properties, with Escape dismissal (https://linear.app/docs/peek). Its project overview distinguishes the document from properties available in a details sidebar (https://linear.app/docs/project-overview). These support keeping prose primary and metadata secondary. This app deliberately keeps an editable side panel and its existing Overview/Subtasks/Activity/Links tabs rather than copying Linear peek behavior.

### Decision

Use the approved palette: canvas #ffffff, inset surface #f7f8fa, ink #1c1e24, muted ink #595959, divider #e1e4e9 and action blue #0f62fe, with existing dark-theme equivalents. Keep IBM Plex Sans. The item title is 28px on the full page and 22px in the panel; prose stays readable and left-aligned.

The full page uses the available 1200px container for a document column of at most 720px plus a quieter properties column. The title belongs to the document, below a compact breadcrumb/action strip; tabs separate document sections below the title. Below the width needed for both columns, properties stack after content. No forced two-column layout on phones. The side panel gets a wider desktop reading measure and a compact single-column version of the same title/prose/properties treatments.

Expose a small formatting toolbar while writing, using the editor capabilities already installed. Clicking formatting must preserve selection and keep the edit open. Existing on-blur save and Escape cancel semantics remain. Preserve role-based editing, deep-linked tabs, comments, relations, subtask rendering, and trash/undo.

The design avoids framing every section as a card: the document remains one continuous surface; spacing, typography and the properties divider establish hierarchy. No new backend fields or save workflow.

### Acceptance Criteria

- Implementation on 6b2t follows this editor-specific refinement and preserves the existing tab contract.
- Desktop, phone, dark-theme and writing-state captures show the hierarchy and responsive behavior.

### Definition of Done

- Record the owner-requested scope and explicit local design choice, with prior-art links.
- Link the implementation and the existing grammar decisions; implementation gates and screenshots remain on 6b2t.


## decision-060

- **Slug:** `decision:decision-060`
- **Title:** decision-060: the web app ships a nonce-based Content-Security-Policy, and HSTS includeSubDomains is ratified as shipped

Status: Accepted

### Context

`2e5k` (security headers residue after x45x) asked two questions that needed a record: which Content-Security-Policy strategy the web app ships, and whether HSTS carries `includeSubDomains` for the deployed apex. The owner ruled both on sign-off batch `gzyv`, item I (2026-09-08); this record writes the ruling down where `features.yml` and later lanes can cite it.

### Prior art (measured 2026-09-15, `curl -sS -D - <url>`)

- **Linear** (`linear.app/login`): `script-src 'self' … 'nonce-…'` (a per-response nonce), `style-src 'self' 'unsafe-inline' …`, `base-uri 'self'`, `frame-ancestors 'self' https://cms.linear.app`; `strict-transport-security: max-age=63072000; includeSubDomains`.
- **GitHub** (`github.com/login`): `script-src github.githubassets.com 'sha256-…'` (hash-based), `style-src 'unsafe-inline' github.githubassets.com`, `frame-ancestors 'none'`, `base-uri 'self'`; `strict-transport-security: max-age=31536000; includeSubdomains; preload`.
- **Vercel** (`vercel.com/login`): `script-src 'self' 'unsafe-eval' 'unsafe-inline' …`, the permissive end.

The app this one converges on (Linear) sends a nonce for scripts and allows inline styles, and the same two-year `includeSubDomains` HSTS this app already sends.

### Decision

1. **HSTS `includeSubDomains`: ratified as shipped.** `web/next.config.ts` sends `Strict-Transport-Security: max-age=63072000; includeSubDomains` on production builds. The live capture on `2e5k` shows Railway's edge adds no HSTS of its own, so there is exactly one header and no conflicting max-age.
2. **Content-Security-Policy: nonce-based, not hash-based.** Hashes break on every inline script change; a fresh per-request nonce minted in `web/proxy.ts` and carried through SSR does not. Scripts: `'self' 'nonce-…' 'strict-dynamic'`, no `'unsafe-inline'`, no `'unsafe-eval'` in production.
3. **Styles keep `'unsafe-inline'`**, as Linear and GitHub do: React `style={{}}` props render as `style=""` attributes and the editor injects `<style>` elements, neither of which a nonce can cover. The accepted cost: injected CSS is still admitted (an independent audit on `2e5k` rated it low severity).
4. **Consequence accepted:** a nonce forces per-request rendering, so the six routes that were static (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`, `/_not-found`) now render on each request.
5. **zod runs `jitless` in the browser** (`web/instrumentation-client.ts`): its JIT probe calls `Function("")`, which the policy refuses; jitless output was byte-identical over 77,700 generated-schema parses.

### Where it is pinned

`web/proxy.test.ts` (policy shape, fresh nonce per request, nonce handed to the render), `web/next.config.test.ts` (HSTS), `web/e2e/csp.spec.ts` (a built app loads with zero policy violations).

## decision-069

- **Slug:** `decision:decision-069`
- **Title:** decision-069: item visibility is gated by membership denormalised onto the row and matched with LIKE, every cross-collection join is removed, and the migrations are rebuilt as one baseline

Status: Accepted

**Accepted** (owner sign-off 2026-09-20, batch `9djx`). Immutable from acceptance: changing course is a NEW decision superseding this one via `--related`, never an edit or a reopen.

### Decision

Item visibility on `project_items` is gated by **membership denormalised onto the row** rather than by cross-collection joins. The view computes three TEXT columns by correlated subselect — `workspace_owner`, `active_members`, `active_admins`, the latter two as comma-delimited id strings of the form `,id1,id2,` — and the list and view rules match the caller with `active_members ~ @request.auth.id` in place of every `@collection.workspaces` and `@collection.workspace_members` leg. No `@collection.` join survives in either rule.

`pb_migrations/` is rebuilt as **one fresh baseline set** as if this design had been known from the start, and this decision **supersedes the historical-only clause of the migration law for that rebuild alone**, naming the two guards it suspends (below). Every other change remains bound by the law.

### Why

The measured cause of the failure is that PocketBase evaluates `@collection.` joins against the whole table, so the cost of one user's list grows with every workspace and membership row in the database, including data that user can never see. At 3 workspaces the list page answers in 0.31 s; at 253 it takes 16.47 s; from 503 it returns HTTP 400 after PocketBase's own 30 s query timeout. The caller's own workspace never grew.

Seven shapes were built or probed and measured on a workspace axis to 1,506 workspaces, and two of them on a second axis to 2,707 projects and 30,007 tasks. The result that decided it: **any shape retaining a `@collection.` join retains the bug**. O1a removes the workspaces join and is flat to 1,003 workspaces, then dies at the membership step exactly as O0 does, because `@collection.workspace_members` is unscoped in the same way. The chosen shape answers in 0.07 s at every step of both axes.

Rejected, each for a measured reason:

- **O1b**, keeping relation typing on the view column so a back-relation rule applies: infeasible. PocketBase cannot parse a top-level `UNION` in a view query, and wrapping it degrades a relation column to `json`.
- **O2**, the same denormalisation matched with `?=`: not visibility-equivalent. `?=` does no any-element matching against a plain json column on this build and returns **zero rows with HTTP 200**, silently. Fail-closed, so nothing leaked, but two principals lost items they should see.
- **O3**, membership denormalised on the auth record: equally fast, but it answers **HTTP 500 on the counts route for every caller including the workspace owner**, because `pb_hooks/counts.pb.js` binds only `@request.auth.id`, and its fields go stale on any membership change without a maintaining hook.
- **O4**, a real stored `items` collection using the scoped back-relation: the fastest thing measured (0.02 s) and it exposes no roster, but it was never built, its number comes from timing the `tasks` collection as a proxy on one axis only, no visibility equivalence was ever proven for it, and it rewrites roughly 46 suites. Declined **for this wave**, carded as a follow-on.
- **O5**, a JS route replacing the rule: fast through its own endpoint, but it leaves the collection endpoint and the counts route exactly as broken as today, and it silently ignores `fields`.

The `json_each` over `workspaces.priorities` named in the originating card is **cleared**: stubbing it out makes the query marginally slower, not faster (17.46 s against 16.47 s at 253 workspaces). The joins are the whole cost.

Prior art was consulted first (Linear, Jira Cloud, GitHub Projects v2). None exposes a materialised visibility table in its public contract, and whether any denormalises internally is not sourceable; the nearest analogue to the chosen shape is Linear's per-issue shared-access user list, which is an overlay rather than the base gate. Whether the three denormalise visibility internally is explicitly unknown, so prior art constrains the contract, not the storage.

### What this decision accepts as a cost

1. **The active-member, admin and owner id roster is readable** by any principal who can already see one item in that workspace, including a principal who reaches it only as a task's assignee. There is no technical mitigation on this build: a view field **cannot** be marked hidden (the PATCH and a migration both read back `false`, while the same change on a base collection sticks), and no traversal rule can replace the columns because the view's `workspace` column is `CAST ... AS TEXT`, not a relation. The owner ruled this acceptable on 2026-09-20, on the measured narrowing that any signed-in account can already list every user id, so the new disclosure is the association and not the ids.
2. **Three columns become permanent, filterable, sortable API surface**, carrying the full coupling cost on every future change.
3. **The rule puts the caller's id on the pattern side of a LIKE.** `%` is a live wildcard there, so an id containing one would match every row. This is closed today only by `users.id` validation (pattern `^[a-z0-9]+$`, min = max = 15, not bypassable by a superuser on create, immutable on update) — an invariant in a different collection that nothing asserts. The build wave adds the assertion.

### Guards this decision suspends, once, for the baseline rebuild

- `.claude/hooks/protect_historical_migrations/hook.sh` (PreToolUse) and the `historical-migrations` pre-commit job in `lefthook.yml`, both via `scripts/check_historical_migrations.py`, which refuse any edit, delete or rename of a migration already on `origin/main`.
- `scripts/check_app_docs_history.py` `BASELINE` moves from `1785150000` to the new set's first timestamp.

This is safe only because there are no real users and every database — dev, clean rooms, staging, production — is recreated from the migration set. Both guards resume in full force after the rebuild lands.

### Acceptance bar this decision binds the work to

At fixture S4 (1,506 workspaces with 1,500 foreign membership rows) and at fixture P2 (203 workspaces, 2,707 projects, 30,007 tasks), each of the list page, the counts-shaped read and the counts route stays within **3× that same option's own 3-workspace median for that request kind**, and returns HTTP 200 with the baseline row count. Stated per request kind and per fixture deliberately: the three shapes degrade differently, and no single fixture combines S4's workspace count with P2's task count.

### Evidence

`~/.local/share/agent-artifacts/task-manager/pb1e-packet/reports/`: `PACKET.md` (the owner-facing packet), `measurements.md` (both axes, every option, every command and output), `reviewer-O2b.md` (independent re-derivation of visibility equivalence, verdict CONFIRMED), `probe-o2b-guards.md` (the hidden-field refutation and the auth-id invariant), `prior-art.md`, `schema-shape.md`, `test-impact.md`, `worker-*.md`. Root independently reproduced two cells before acceptance: O2b at S4 and the O1a-vs-O0 six-principal differential.

## decision-070

- **Slug:** `decision:decision-070`
- **Title:** decision-070: a pending invitation waits in the workspace switcher instead of deciding where you land at sign-in

Status: Accepted

### Decision

**Accepted 2026-09-20** on the wave-v9a coordinator's verdict for lane S-INVITE,
under the owner's delegation of 2026-09-20 (sign-off batch `9djx`, question F: rule now,
fix in parallel with the rebuild). Immutable from here: changing course is a NEW decision
superseding this one via `--related`, never an edit and never a reopen.

An invitation to someone else's workspace **waits**; it never decides where you land.

`resolveWorkspaceForUser` (`web/lib/proxy/session.ts`) ranks a signed-in person's landing
workspace in this order:

| # | Candidate |
|---|-----------|
| 1 | a workspace you own |
| 2 | a workspace you are an **active** member of |
| 3 | a workspace you have only been **invited** to |
| 4 | the earliest non-trashed membership, so the sign-in screen can draw the suspended panel |

Only #3 moves: it was first. A pending invitation therefore still decides the landing in the
one case where that is right — when the person has nowhere else to go.

Because an invitation no longer comes to you, you go to it: the header workspace switcher
carries an **Invitations** group, one row per pending invitation, each a link to that
workspace's address, which draws the existing accept-or-decline screen. Accept and decline
themselves are unchanged.

`canEnterWorkspace` is **not** widened. It is the single entry test shared by the switcher's
option list and the switch action, and an invitation is precisely not an entry — so the
invitation rows are links, not switch actions, and the predicate keeps its one reading.

### Why

Today the invitation is ranked first, with the deliberate reasoning that "every account
auto-owns a workspace, so an invitation ranked below it would never be seen". That reasoning
is sound and the fix keeps it — by building the place where it is seen, rather than by
buying visibility with displacement.

The cost of the displacement was measured, not assumed. Re-validated in a clean room against
`3ad5b973`: with B holding an `invited` row for A, A's landing resolves to **B's** workspace
before A's own workspace lookup ever runs, and the shell then draws the join screen with no
chrome and no switcher. There is no in-app route back to A's own work — only a typed URL. So
anyone who knows your email address decides what you see when you next sign in.

What it is **not**: landing on that address does not hand over any of B's data. Every item
rule carries a same-row `status ?= "active"` conjunct, so an invited principal reads nothing.
The harm is displacement and the missing way back, not exposure.

### Prior art

Consulted first, per the owner's 2026-08-08 ruling. Three tools, one rule — an invitation is
a waiting item surfaced in your account or workspace list, never a displacement:

- **Linear** (the tool this app converges on): a pending invite is reached from the workspace
  switcher — "click on your current workspace icon, hover over **Switch workspace**, select
  **Create or join a workspace**" — and a number beside that item is how you know one is
  waiting. Your current workspace is what you are still looking at.
  <https://linear.app/docs/invite-members>
- **Slack**: joining a workspace *adds* it to your workspace sidebar; the ones you were
  already in stay signed in.
  <https://slack.com/help/articles/212681477-Sign-in-to-Slack>,
  <https://slack.com/help/articles/1500002200741-Switch-between-workspaces>
- **GitHub**: an organization invitation never changes your dashboard. It waits under
  Settings → Organizations with Accept and Decline, plus a header badge.
  <https://github.blog/changelog/2021-11-10-repository-invites-are-now-more-accessible-on-github-com/>

None of them lets the inviter decide where the invited person lands.

### What this decision costs

1. **An invitation is quieter than it was.** Someone with an active workspace of their own
   now has to open the switcher to find it. That is the trade the prior art makes too, and it
   is the price of not letting a stranger choose your screen. A louder signal — a count on the
   switcher the way Linear does it, or a notification — is a further step this decision leaves
   open rather than takes.
2. **Three more shell components carry a prop.** The invitation list threads from the shell
   through the header into the switcher.
3. **`canEnterWorkspace` now has a neighbour.** A second, narrower selector answers "which
   invitations are pending", and a reader has to know which question each one answers. The
   alternative — one widened predicate — was rejected because it would make the switcher offer
   a workspace the switch action refuses.

### Scope

The sign-in ranking and the switcher entrance only. The member-lookup route repaired in the
same card is a security fix rather than a change of course, and its record is `51a0` and its
evidence, not this decision.

### Evidence

Clean-room re-validation against `3ad5b973` (PocketBase 0.40.4, isolated room): commands,
raw responses and the replayed ranking logic are the premise comment on `51a0`. The build's
own proof — the resolved landing and the route taken to the invitation — closes `51a0`.

## decision-072

- **Slug:** `decision:decision-072`
- **Title:** decision-072: a draft is private to its author, the workspace owner and active admins, and Publish is one-way

Status: Accepted

Accepted 2026-09-21 by the owner (sign-off record x262).

**Proposed 2026-09-21** by wave-7 lane P-PUBLISH, as acceptance criterion AC5 of `xfvq`
(carried there when `z8jw` closed as its duplicate). `project_items.draft` has been real
product state with no product surface: the backend hides an unpublished prose item and
suppresses the notifications it would send, and no user can see that state or act on it.
This record rules the lifecycle; the build in the same wave follows it. Accepted or
rejected at the next owner sign-off, and never edited once accepted.

### Decision

A draft is private to its author, the workspace owner and active workspace admins, and
Publish is an explicit one-way action.

#### 1. Three item kinds carry a draft, not two

`xfvq` and `z8jw` both say "decisions and documents". That is wrong by one. The column
lives on `decisions`, `documents` AND `milestones` (`schema/decisions.json`,
`schema/documents.json`, `schema/milestones.json`, all three seeded by
`pb_migrations/1785180100_collections_snapshot.js`), and every tier already treats the
three identically: the same draft clause on listRule, viewRule, updateRule and deleteRule
in all three rule files, three real `draft` columns in the `project_items` union against
a literal `0` on the task arm, a draft suppression block on every realtime handler of each
of the three, and the same three-way carve-out in the trash route filter and in search and
export.

Tasks are out, and stay out: decision-048 dropped `tasks.draft` because a task has no
author, so a draft task was a flag without the privacy. The view forces `draft = 0` on
the task arm to keep that true.

Surfacing two of the three would be worse than today, not better: a milestone draft would
stay invisible and unpublishable while its two siblings gained a control. The frontend
keys the surface off the item kind not being a task, which is also the smaller change.

Drafts stay a FLAG on the item, never a separate draft object. That was already ruled and
the feature register carries it as `rejected` with its reason
(`items-properties.drafts-as-a-separate-object-rather-than-a-flag`); this record does not
reopen it.

#### 2. Who can read a draft

The author, the workspace owner, and a workspace admin whose membership is active. That is
what the rules already say on the surfaces that carry the clause: the three collection rule
files, the `project_items` view rule, the realtime broadcast filter, the trash route filter,
search and export. This record ratifies that set rather than changing it.

It does NOT ratify the surfaces that lack the clause. An independent audit of this very
change found two, both reproduced live in a clean room, neither introduced by it:

- The trash route applied the carve-out to its own filter and then expanded a trashed task
  relation through a privileged call, handing a plain member and an active viewer a draft
  milestone in full, name and description and author. The route already declared the opposite
  intent in its own comment, so it was a defect against a stated invariant rather than a
  design choice; it is fixed in the same change as this record, and the per-role suite now
  drives the task-expand shape that let it survive a green run.
- Comments carry no draft clause at all. An unfiltered comments read hands a plain member and
  an active viewer the existence of a draft and the prose its author wrote about it, and the
  same caller can post a comment onto an item they cannot open. Closing that needs a rules
  migration and a ruling of its own about comments written before publication, so it is card
  `6hf3` rather than part of this one, and this record names it as a KNOWN exception, open
  until that card closes.

One accepted limit, named rather than fixed: a draft is hidden but its existence can be
counted. Item keys are a single per-project sequence shared by all four kinds and the project
counter is readable, so a member seeing five keys against a counter of ten can tell that five
items exist which they cannot open. It reveals a count, never a field value, and trashed items
confound it.

A second limit of the same family, also named rather than fixed: attaching a task to a real
draft milestone id succeeds, while a bogus id is refused as out of scope, so the pair of
answers confirms a guessed id. It is negligible on its own, because confirming an id needs
the id already, and a PocketBase id is fifteen characters; it mattered only as the first step
of the trash route leak above, which is closed.

So "author-private" is shorthand, and the product copy must not overstate it. A draft is
private FROM the workspace at large; the two roles that can already read everything in the
workspace can read it too. Any UI line describing the state names all three readers.

Who may publish is the same set, because the update rule is the same clause: the author,
the workspace owner, an active admin. No new authorization tier is invented for it.

#### 3. What Publish does

Publish sets the flag to published. There is no second effect to design, because every
consequence already exists and fires off that value:

- the item becomes readable by every active member of the workspace, on the list, the item
  view, expand, search, export, the trash listing and the realtime stream;
- `pb_hooks/notify.pb.js` resolves the mentions in the item prose and notifies the people
  named in them. Its own comment states the reason: a draft names nobody, because the
  members it would name cannot read it, so publishing sends them.

Two honest limits on that second bullet, which the acceptance evidence has to respect:

- Publishing notifies the people MENTIONED in the prose, not the workspace. A published
  document does not announce itself to members it never named. This record does not add a
  subscriber fan-out; if one is wanted it is a separate decision.
- The mention pass is not a transition detector. It reads the value being saved, so it
  runs on every save that lands published and notifies mentions not already notified. The
  first publish is therefore the first fan-out, and a later edit that adds a new mention
  notifies that person too. That is correct behaviour and is being named, not changed.

Publish is explicit: it is a request that carries the field on purpose, never a byte that
rides along on an ordinary edit. An edit that does not carry the field cannot publish, and
the app tier offers no other way to set it.

#### 4. Unpublish does not exist, and is refused rather than merely unoffered

Draft goes to Published. Published is terminal.

Prior art, per decision-041: Linear has no draft on issues, and on the surfaces where it
does have one — documents and project updates — Publish is a one-way action; a posted
project update is edited, not un-posted. Cited, and then ruled explicitly here rather than
inherited.

The reason to rule it rather than leave it open is that un-publishing produces a state
worse than either endpoint. Publishing already sent notifications, and nothing can retract
them. Going back to draft would leave a member who was told about the item, in writing, and
then quietly lost both the item and the notification row: the inbox count and list queries
in `pb_hooks/notify.pb.js` exclude a notification whose linked item is a draft the reader
cannot open, so the row does not vanish, it becomes invisible to exactly the person who was
notified. A user cannot distinguish that from a bug.

Withdrawal already has a product answer, and it is Trash, which is visible, reversible and
already understood.

This is a refusal, not an omission. Today nothing anywhere blocks the published-to-draft
direction: the update rules are symmetric and no hook inspects the direction, so a caller
against the collection endpoint can redraft at will. The build adds the guard that makes
the rule true, so the comment in `notify.pb.js` about a draft naming nobody stays true for
the life of an item rather than only until someone writes the field back.

The guard refuses the direction for every authenticated caller, including one writing
straight at the collection endpoint rather than through the app tier, and exempts only a
superuser, because seeding, import and migration are superuser writes and a rule that
blocked them would block the fixtures that prove the rest of this record. So the inbox
exclusion described above is NOT removed: it stays as the defence for exactly that one
remaining case.

#### 5. What this does not change

The read rules, the view SQL, the realtime suppression, the trash route filter, the search
and export carve-outs, and the notification visibility joins are re-proven per role rather
than rewritten. No collection gains or loses a field. No migration changes schema. Two
backend behaviours move: the one-way guard of section 4, and the trash route expand named in
section 2. The comments hole named there is left to its own card and is NOT fixed here.

#### 6. The words

Proposed rendered strings, so the review has something to check rather than infer. They
describe what the user gets, never how it is stored:

- the state, on the item and on its row: `Draft`
- the action: `Publish`
- the line that explains the state: `Only you, the workspace owner and workspace admins
  can see this until you publish it.`
- the confirmation, because the action cannot be taken back and it notifies people:
  `Publishing cannot be undone.`
- after it lands: `Published. Everyone in this workspace can see it now.`

The role words are whatever this app already calls those roles on its own members screen,
matched rather than invented.

### Consequences

- The contract stops dispositioning `draft` as an enforcement column and declares it on the
  three prose item variants, so `scripts/check_contract_mirror.py` counts it mirrored. The
  task variant keeps no `draft` property, which is the truthful shape.
- The proxy handler for items gains the field on the update path, accepting the published
  value only, so the refusal exists at the app tier as well as in the hook.
- The composer can create a prose item as a draft; the item panel shows the state and
  carries the action.
- A new hook guard refuses the published-to-draft direction on all three collections.
- Tiers touched: the contract and its generated client, one proxy handler, the composer and
  the item panel, one new hook guard, one backend suite, one end-to-end spec, the feature
  register. The generated client and the register renderings ride along by the coupling law
  in AGENTS.md. No file count is claimed here, because one was not measured.
- Risk accepted: the guard is enforcement of a ruling that is still Proposed. It is
  observable to nobody today, since no surface can reach the field, so a veto at sign-off
  costs one hook guard and its suite.

## decision-073

- **Slug:** `decision:decision-073`
- **Title:** decision-073: an invitation is a record keyed by the email address, so an address with no account can be invited and the roster stops telling the inviter who is registered

Status: Accepted

Accepted 2026-09-21 by the owner (sign-off record x262).

**Proposed 2026-09-21** by wave-7 lane M-MODEL, under the owner's ruling of 2026-09-21
(sign-off record `6vpz`, item D): the five design questions on `729j` are answered as a
decision record inside the data-model wave, so the address-keyed invitation lands in the
fresh baseline rather than as a migration on top of it. This record decides the design; the
build is the next wave. Accepted or rejected at the next sign-off — never edited once accepted.

**Revised 2026-09-21**, in place while still Proposed, after an independent review returned it:
one argument REFUTED and withdrawn in section 1, which now rests on four other grounds; two wrong
consequence claims removed; six missed consequences added, the largest being that this touches
about fifty files rather than nine, and that it widens the open defect `f9ba`. Three questions it
raises sit in the owner's court, named where they arise.

### Decision

An invitation is a record keyed by the **email address**, in its own collection, and it
exists whether or not an account does.

#### 1. A new collection, not a nullable user column

`workspace_invitations`, one row per pending invitation:

| field | shape |
|---|---|
| `workspace` | relation to `workspaces`, required, cascade-delete |
| `email` | text, required — the address as typed, trimmed and lowercased |
| `email_key` | text, required — the fold (below), and the only column ever compared |
| `role` | select `admin` \| `member` \| `viewer`, required |
| `invited_by` | relation to `users`, optional, no cascade (see section 6) |

`CREATE UNIQUE INDEX ON workspace_invitations (workspace, email_key)` — one pending invitation
per address per workspace.

The alternative was a user-less row on `workspace_members`. It is rejected, but **not** for the
reason an earlier draft gave, and the correction is kept because the refuted argument is the one
a reader reaches for first.

**Withdrawn:** that draft argued SQLite treats NULLs in a UNIQUE index as distinct, so
`UNIQUE (workspace, user)` would stop guarding duplicates. True of SQLite, inapplicable here —
PocketBase declares every single-value relation column `NOT NULL` with an empty-string default,
so an unset relation stores `''` and the index guards that branch like any other. Measured on the
replayed baseline: the column is `user TEXT DEFAULT '' NOT NULL`, and a second row with the same
workspace and an empty user is refused, `UNIQUE constraint failed`.

The rejection stands on four grounds, each about what a shared table costs rather than what it
fails to enforce:

1. **One index cannot express both uniqueness rules** — membership is unique per
   `(workspace, user)`, an invitation per `(workspace, address)`; in one table that is a second
   partial index over a different column pair.
2. **`user` is required with cascade delete**; relaxing it changes an invariant every reader of
   that table relies on, for rows that are not memberships.
3. **Different lifecycles** — an invitation expires, a membership does not, so retention logic
   must ask which kind each row is before acting.
4. **Pending state in the roster IS the disclosure** this record closes, so keeping it in the
   roster table keeps the coupling alive however the column is shaped.

A separate collection gets all four for free: membership rules and the correlated subselects
decision-069 put in the `project_items` view never see an invitation, because it is not in their
table.

#### 2. Pending invitations are the ONLY pending store, for every address alike

`workspace_members` stops holding pending state. An invitation to a **registered** address writes
the same `workspace_invitations` row as one to an unregistered address; a `workspace_members` row
appears only on **acceptance**.

This closes `729j`'s AC3 by construction rather than by mitigation. Today the inviter's roster is
the oracle: an address with an account produces a membership row whose `expand=user` yields the
user id, display name, avatar, signup timestamp and verified/approved state, and an address
without one produces nothing. When the invitation is the same object either way, the roster has
nothing left to differ by. The cost is named below: `invited` leaves `workspace_members.status`.

#### 3. The key is the fold, not the spelling

`email_key` — trim, lowercase, and for `gmail.com` and `googlemail.com` only, drop every `.` in
the local part and everything from the first `+` to the `@`. That is this app's existing rule for
what makes one address one account (`pb_hooks/auth_identity.pb.js`, unique index
`idx_email_key__pb_users_auth_` on `users`), and the invitation must mean the same thing by it.

Keying on `LOWER(email)` — what the invite route does today — is a defect this decision also
settles. Measured on `729j`: inviting `probe.alias770@gmail.com` when the account is
`probealias770@gmail.com` answers `200 {"invited":true}` and creates nothing, because the route's
lookup misses the account the fold would have found. `email` is still stored as typed, for the
reason `users` stores it: it is what the admin sees and what mail would be addressed to. Only
`email_key` is compared.

**Two consequences, accepted rather than solved.** Outside the two Gmail domains the fold keeps
dots and plus-tags significant, so an invitation to `a@corp.com` is unreachable by someone signing
up as `a+work@corp.com` — the row sits pending forever and the inviter was told it happened. And
the fold is recomputed on an address change, so changing yours gains or loses pending invitations
without you acting. Both are the price of one address being one account.

#### 4. What claims the invitation

**Acceptance claims it, not signup.** The invited person — new account or long-standing — opens
their pending invitations and accepts; that one action creates the `workspace_members` row with
`status = "active"` and deletes the invitation, in one transaction. Declining deletes the
invitation and creates nothing. They reach it through the entrance decision-070 already built:
the **Invitations** group in the header workspace switcher.

**decision-070's ruling stands; its mechanism moves, at two sites, and an earlier draft wrongly
said it was untouched.** Both read the `invited` status this design retires: the switcher's
Invitations group, and — the one easy to miss — `web/lib/proxy/session.ts`, where the sign-in
landing falls through to the first invited row so a person with no workspace of their own still
lands somewhere. Both read the invitation record instead. What does not change is what
decision-070 ruled: an invitation waits, ranked below a workspace you own and one you are an
active member of, deciding the landing only when there is nowhere else to go.

**A system route, not a collection rule**, answers "which invitations are mine": `email_key` is
hidden on `users` and PocketBase drops hidden fields from filter matching — the property that
forced the member-lookup route to exist at all (`PBTT-359`) — so a rule comparing the invitation
against the caller's own folded address would return an empty 200 for everyone, the person it
serves included. The build verifies that live before relying on it either way.

#### 5. Rules, and who reads the pending list

| rule | who |
|---|---|
| `create` | the workspace owner, or an **active** admin member — and an active admin mints only `member`, exactly as `workspace_members.createRule` already binds the route |
| `list` / `view` | the workspace owner and its active admins **only** |
| `delete` | the same — this is revocation |
| `update` | nobody: an invitation is revoked and re-issued, never edited |

The read is deliberately narrower than the membership roster, readable today by every active
member and viewer of the workspace (measured on `729j`: `roster as member -> 200 n=31`, `roster
as viewer -> 200 n=31`). A pending invitation is an administrative act in progress, so the people
who can perform it are the people who can see it.

#### 6. Expiry and revocation

- **Revocation** is a delete by the owner or an active admin, surfaced as a Revoke action beside
  each pending row.
- **Expiry** is configurable, not a constant in a hook: one `app_settings` row,
  `invitation_expiry_days`, beside `trash_retention_days`, defaulting to **7** for the reasoning
  in the prior art below.

  **Where it runs, because a rule cannot.** PocketBase rules do no date arithmetic and read no
  settings row, so expiry is not expressible as a rule — an earlier draft left that unsaid. Two
  places, both with a precedent here: a **daily cron sweep** deletes rows past the window, the
  shape `pb_hooks/signup_purge.pb.js` already runs for unclaimed signups and
  `pb_hooks/trash.pb.js` already uses to read a retention value from `app_settings`; and the
  **accept route re-checks the window**, since a daily sweep would otherwise leave a whole day in
  which an expired invitation is still acceptable. Acceptance already lives there, so this costs
  no new surface. An expired row is **deleted** by the sweep; until swept it shows as expired and
  refuses acceptance. GitHub retains and offers retry; this does not, because retry is resend and
  resend has nothing to send while the emailed link is out of scope.
- **The invitation outlives the person who sent it.** `invited_by` is an audit stamp — NOT
  required and NOT cascade-deleting, deliberately against this app's convention for a relation
  into `users`. An invitation is a grant the WORKSPACE makes; one admin leaving must not silently
  revoke access the workspace still intends. With the inviter gone the stamp is empty and the row
  names the workspace rather than a person.
- **A trashed workspace** resolves nobody: every membership rule here already carries
  `workspace.trashed = ""` and the invite route 404s a trashed workspace for its owner too, so
  the invitation collection carries the same conjunct and a pending invitation into a trashed
  workspace is unlistable, unacceptable and unrevocable until restore. Permanent deletion takes
  it by cascade, as `workspace_members.workspace` already does.

#### 7. The reverse oracle

Can a stranger learn that an address was invited? No: the collection grants no read outside the
workspace's owner-and-active-admin tier, and the claim path runs system-side. Two narrower cases,
stated so the build proves rather than assumes them. **The duplicate create** — a second
invitation to an already-invited address collides on the unique index, which is not an oracle
because it is observable only inside a workspace whose pending list the caller may already read
in full; that is precisely what is NOT true of today's route, whose collision had to be made
uniform because the caller could not read what they collided with, so the build asserts the
containment rather than inheriting this conclusion. **The invitee's own view** — someone who
signs up learns which workspaces invited their address, which is the feature and what every
comparable tool does.

### Why

You cannot invite someone who does not have an account yet. Typing a colleague's address into
Members does nothing, and the inviter is not told why. That is `729j`'s first half: a product gap
with no workaround, because there is no way to say "this address is welcome here" before that
person exists.

The second half is a security residual, and why this is a release gate. `51a0` closed the
member-lookup route as an account-existence oracle — it now answers identically whether or not
the address resolves. What that fix cannot reach is the roster one request later. Measured live:
an ordinary account, acting on the workspace its own signup provisioned, invites an address and
reads its own roster, and gets the user id verbatim, the display name, the avatar, the signup
timestamp and the verified/approved state through `expand=user` — repeatably, because
`deleteRule` lets the same caller delete the row and try the next address.

That cannot be closed by narrowing a rule, because what is disclosed is the EXISTENCE of the row,
and the row is the invitation. It closes only by making the invitation exist in both cases.

### Prior art

Consulted first, per the owner's 2026-08-08 ruling, fetched 2026-09-21. Three tools, one shape:
**an invitation is sent to an email address, and no account has to exist first.**

- **GitHub** (organization invitations). Invite by username OR email; the REST object takes
  `email` "Required unless you provide invitee_id", so the invitation is keyed by the address.
  Pending invitations live in their OWN list on the People tab, cancellable only by owners, and
  expire automatically after seven days. Acceptance is bound to the address: the invitee can
  accept only if it matches a verified email on their personal account. Both facts are current;
  paraphrased, because the sentence an older draft quoted verbatim is no longer in the docs in
  that wording.
  <https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization>
- **Linear** (the tool this app converges on). Invite by address; Members settings filters to
  "Pending invites"; accepting works even when signed in as a different account, so the
  invitation attaches by address rather than by session. No expiry documented. **Linear's claims
  are the weakest sourcing here** — its docs and changelog as read on 2026-09-21, unconfirmed
  against a second source. <https://linear.app/docs/invite-members>
- **Slack**. Invite by address; a pending person is already a presence (others can add them to
  channels and message them) and the account activates on first sign-in. Only owners and admins
  manage pending invitations, which expire after 30 days.
  <https://slack.com/help/articles/360060363633-Manage-pending-invitations-and-invite-links-for-your-workspace>

**What the three settle.** The invitation is keyed by the address and lives in its own list, not
in the roster; only owners and admins read, revoke or resend it; it expires on its own. The
7-day default is GitHub's figure rather than one invented here — Slack's is 30, Linear publishes
none, and of the two sourced values the shorter is safer for a standing grant of access.

**Where this record leaves the prior art.** (1) **All three email a link; this design does not,
yet** — the largest deviation and a real loss of usefulness, carded as the follow-on; what makes
it survivable is that GitHub's acceptance rule is the ADDRESS, not the link. (2) **GitHub's
pending-invitation API leaks the residual this record closes** — a null `login` means the invitee
is not a member, so prior art does NOT close the account-existence oracle, it lives with it; this
record goes further on purpose, because `729j` is a release gate and because an app where every
signup auto-provisions a workspace hands that probe to every account rather than to organization
owners. (3) **None documents how an invited address is matched to an account**, so the fold is
decided on this app's own rule rather than borrowed.

### What this decision costs

1. **`invited` leaves `workspace_members.status`, and the change is wider than either earlier
   draft counted.** The first named five sites and four suites; the second said about fifty files,
   which counted only the hand-written tiers. Measured on the head: **80 files** tree-wide, of
   which 51 are hand-written and 24 are the generated model tree under `scripts/model/`, plus
   `openapi.json` — and `AGENTS.md`'s coupling law makes that generated tier mandatory on exactly
   this kind of change, so it is cost, not an afterthought. The hand-written tiers: the status
   enum and the two rule clauses that create and accept an invitation; the hook policing status
   transitions, whose invited-to-active branch and whose refusal to move a row back both go away;
   the proxy's status union, accepted-status filter, synthetic invited-at and invited-by nulls,
   invite acknowledgement stub, resend-invite handler and sign-in landing; the frozen contract's
   status enum, acknowledgement schema, invited-at and invited-by properties, resend-invite route
   and four prose descriptions asserting a membership is only ever active, invited or suspended,
   plus every generated type, zod schema and SDK method from them; the app shell, switcher, status
   chip and the login view's invited arm; seeded app_docs prose; and thirteen suites and e2e specs
   beyond the four named.

   The price of AC3, worth paying only because nothing cheaper works: while a registered address
   produces a membership row and an unregistered one produces nothing, the roster distinguishes
   them and no rule hides that. **Nothing has to be migrated** — one fresh baseline every database
   boots from, so no historical `invited` rows exist, and no real users on the deployed app.

2. **Nobody is told they were invited.** With no emailed link the invitation is silent until the
   person signs up and opens their switcher, so the admin tells them out of band — a real
   regression against the tools this app converges on, carded as the follow-on.

3. **A second collection to keep honest**, so the coupling law applies to both — the contract
   included, which this change edits rather than merely accompanies.

4. **It widens an open defect, and the build inherits a constraint.** `f9ba` records that a
   stranger can place chosen text in your workspace switcher, which renders a workspace name raw
   with no cap, no inviter identity and no generic label. Today that needs the victim's address
   to be REGISTERED. Under this design an invitation to any address is minted, so chosen text can
   be pre-planted against an address with no account and is seen at that person's first sign-in,
   as their introduction to the product — a reach and persistence increase on a surface that
   already gates the release. The constraint: **either `f9ba`'s rendering fix lands first, or this
   build renders a pending invitation through a label it controls rather than the raw workspace
   name.** The second is cheap because the invited person's read is already a system route. This
   record does not settle `f9ba`'s ruling; it states which way it constrains it.

### Scope

In: the collection, its rules and index, the accept path, the route rewrite, the switcher and
sign-in-landing sources, and the retirement of the `invited` membership status.

Out, each for a stated reason. **An emailed invitation link** — a second claim path with its own
bearer token, expiry, revocation and enumeration surface, and the gap this record closes does not
need it, since the person signs up with the address and the invitation is there; a separate card
and decision, and the owner's court holds whether that is acceptable for a release-gate design.
**Onboarding, seat counting and billing** — untouched. **The existing route's timing difference**,
measured on `729j` at 0.56 ms against 0.35 ms at the PocketBase tier and not measurable at the
proxy, deliberately not mitigated: when invitation and membership stop being two branches the
cause stops existing, so the build states the new measurement rather than claiming the old one
was fixed.

### Evidence

`729j` carries the live clean-room probes this rests on: the roster read and what `expand=user`
yields, who can read it (every active member and every active viewer, against `n=1` for an
invited, suspended or non-member principal), the 21-cell ownership-by-role matrix for who can
mint an invitation, and the Gmail-fold miss. `51a0` carries what the route fix did and did not
close. The relation-column measurement in section 1 was taken against the current baseline
replayed offline, and it REFUTES an argument an earlier draft made rather than supporting one
this record makes. The build re-runs `729j`'s invite-then-read-roster probe against a registered
and an unregistered address and shows the outputs identical — DoD item 5 on that card.


## decision-074

- **Slug:** `decision:decision-074`
- **Title:** decision-074: the heavy CI matrix runs once per pull request, and a draft pays only the cheap gates

Status: Accepted

Accepted 2026-09-21 by the owner (sign-off record x262).

Proposed by the T-TOOLING lane of wave 7 on card `t0wq`, 2026-09-21, under the owner ruling of the
same day: the repository runs far too much on hosted runners, and a trigger and scheduling strategy
must run only what is needed without losing a per-sha verdict on main.

### Context

September 2026 (1st-21st) consumed 21,111 hosted runner-minutes on `hsb3/task-manager` and
exhausted the Actions budget for the account on 2026-09-21, freezing every landing until the owner raised
it. Two jobs are the whole problem: `web-e2e` at 10,850 minutes (51%) and `suite-battery` at 6,049
(29%). The measurement, its method and its bounds are in the scout report
`waves-v11/reports/ci-minutes-september.md`; the recomputation this record cites is
`waves-v11/reports/ci-minutes-projection.md`, produced by `ci-minutes-projection.py` from the same
cached run/job data.

Recomputed from the same cached data by the script on this card (reproduction PASS on all nine
rows of the scout report), the September ledger reads: P1, already landed, 4,063 heavy minutes on
106 qualifying landings; P2, this record, 958 minutes under the stated owner ritual and 3,012 at
its upper bound; P3 NEGATIVE at every plausible transfer cost; P4 +562, and +311 once P2 is in; P5
at most 2,660 by a proxy whose like-for-like against the prior report is 661 against 617. P1 plus
the P2 ritual model takes 21,053 CI minutes to 16,032.

decision-074 is the second half of a pair. Card `v08c` (PR #787, merged 418f3264, ruled by the
owner on the card rather than by a decision record) removed the duplicate heavy run at LANDING: a push to main whose merge tree is identical
to the one on its PR head, and whose PR head already carries green heavy check runs, inherits that verdict
instead of re-running the matrix. This record removes the duplicate heavy runs BEFORE landing,
which is the larger half.

### Decision

1. **A draft pull request is judged by the cheap gates only.** `changes`, `static-checks`,
   `app-docs-coverage`, `web-gates`, `register-docs` and `landing-verdict` run on every event as
   before. `suite-battery`, `battery-verify`, `web-e2e` and `web-image` additionally require
   `needs.changes.outputs.heavy == 'true'`.
2. **`heavy` is computed in a step, and only a literal `true` on `github.event.pull_request.draft`
   withholds the matrix.** A push to main, a `workflow_dispatch`, and any interpolation that comes
   back empty all run the matrix. The failure direction is "spend minutes", never "skip a gate and
   call it correct" — the pure-expression form of the same rule fails the other way, because an
   empty `heavy` output also satisfies `!= 'true'` on every heavy job while `landing-verdict` would
   agree that each of them was rightly skipped.
3. **`ready_for_review` and `labeled` join the `types` list of the trigger.** Neither is in the GitHub default
   set (`opened, synchronize, reopened`), so without them a draft marked ready would run nothing
   heavy until its next push — the one shape that could let an unproven tree reach a merge button.
4. **The on-demand force is the `ci-full` label, and NOT `workflow_dispatch`.** Adding `ci-full` to
   a draft fires a run immediately and the `heavy` step reads it on that same event; removing it
   returns the PR to cheap gates on its next event. Because a label is added for many reasons and
   only `ci-full` is asking for CI, the `changes` job — which every other job needs — carries
   `github.event.action != 'labeled' || github.event.label.name == 'ci-full'`, and
   `landing-verdict` carries the same guard so that a run where nothing was scheduled records no
   verdict instead of reading its own skip as a fault.
   **`workflow_dispatch` was built first and removed on live evidence.** A dispatch carries no
   `github.event.before`, so the workflow-level `BASE` resolves to the empty string and every job
   whose first act is `git rev-parse --verify "$BASE^{commit}"` dies there. Measured on PR #795,
   run 35639781110: all four `suite-battery` shards failed at the `Verify change range` step with
   the battery itself skipped, and `battery-verify` failed with them. A dispatch would therefore
   have been a force that cannot complete the very gates it exists to force. (`register-docs` was
   skipped on that run with no steps at all — its ordinary `register_only` skip, since a dispatch
   falls to `full()`. It is not evidence for this and an earlier draft of this record wrongly
   cited it.) The label route has no such
   problem, because a `labeled` event IS a `pull_request` event and `BASE` is the base sha of the PR,
   exactly as on every other event. Giving `workflow_dispatch` a `BASE` fallback was considered and
   rejected: the only expressible ancestor is the default branch, which for a dispatch ON main
   makes `BASE..HEAD` empty and silently turns the register coupling gate into one that passes by
   seeing nothing — the exact failure the `fetch-depth: 0` comment in `ci.yml` already warns about.
5. **Main is untouched.** `push: branches: [main]` still runs everything the path filter and the
   `proven` predicate allow, `cancel-in-progress` stays off there, and `landing-verdict` still
   records a pass/fail for the sha of main itself, naming the inherited head.
6. **Ready means locally green.** The ritual is in the wave-coordinator skill and in the
   common brief of the wave: a lane opens with `gh pr create --draft` and runs `gh pr ready` only once its
   local `make dod` is green. This is not decoration. A PR merged without a green heavy run on its
   head CANNOT inherit at landing, so main pays the full matrix and the minutes are spent twice.

#### What is NOT being done, and why

- **Build the Next app once and fan the output to the four `web-e2e` shards** (card item 3).
  REJECTED, by measurement.
  It is not void on the ground the card feared — `NEXT_PUBLIC_PB_URL` is inlined from `8192 +
  PB_PORT_OFFSET` (`Makefile:246`) and no shard sets an offset, so the four separate runners all
  build the identical URL and one build would serve all four. It is void on cost. The build step of a shard
  has a median of 41.0 s, under the whole-minute ceiling GitHub bills, so removing it changes
  the billed minute on only 308 of 1,260 measured shard jobs (24.4%); the build job it adds bills 2
  whole minutes on EVERY e2e run. With artifact transfer priced at zero — physically impossible —
  the ceiling is +141 minutes a month, 0.7% of the September CI total. At a transfer cost of about 6 s
  each way it turns negative, and the three stated transfer points (10 / 20 / 40 s) give -113, -322
  and -629 minutes a month. The conclusion does not depend on the transfer guess, which is the one
  number here that could not be measured.
- **`web-e2e` 4 shards to 3** (card item 4). REJECTED, and it is the closest call in this record.
  Measured saving 562 minutes a month on the September e2e population, 311 after P2 model (b) — more
  than P3 and P5 together, and structural rather than sub-minute, because dropping a shard removes the
  fixed overhead of a whole job. Three reasons it still does not ship here. **First, it partially
  reverses decision-045** (`web-e2e` sharding, card `h7eq`, PR #555), which deliberately BOUGHT wall
  clock with runner minutes: h7eq measured the per-shard floor at 156 s and stated "returns die past
  4 shards", so shard count is a dial the owner already set with that trade in front of them. Undoing
  half of it belongs in a record that supersedes decision-045, not in a clause of a trigger-policy
  record. **Second, the measured cost is understated**: +0.85 min median on the critical path assumes
  the test seconds of a run split into exact thirds, and Playwright shards by FILE, so real thirds are
  lumpier and the longest shard is worse than modelled. **Third, it retires a record it cannot
  replace**: the 0 flakes in 408 shard jobs recorded at `ci.yml:258` were measured at shards of
  ~68-159 tests, and a third fewer shards means a third more tests per room, per boot — which is
  where order-dependence surfaces. The number is recorded here so a future ruling does not have to
  re-measure it.
- **Widen the `register_only` allowlist** (card item 5). REJECTED, by measurement and by gate topology.
  The generous upper bound is 2,660 minutes a month, of which 1,992 are heavy-job minutes — but that
  is a branch-name and commit-subject proxy, because the runs API carries no file list, and on the
  narrower population of the prior report (docs-only DIRECT commits to main) the same proxy finds 661
  minutes against its git-verified 617. Read it as an order of magnitude, never as a target. More
  decisively, the population it would have served has stopped: the 116 direct-commit pushes to main,
  3,735 minutes, all fall between 2026-09-03 and 2026-09-11, followed by 10 consecutive clean days —
  five times the longest quiet gap seen while the class was active. That is consistent with the
  landing-station lock eliminating it, though the data cannot prove the attribution, since the
  effective date of the lock is not in it.
  Independently of the minutes, the widening is not a one-line change: `make ci-register-docs` runs
  `gen_feature_register.py --check`, the three readout builders, `check_doc_frontmatter.py`,
  `check_decision_citations.py`, `check_keep_in_sync.py` and `tests/test_ci_changes.py`, but NOT
  `gen_decisions.py --check` and NOT `tests/test_agent_layout.py` — and those two read
  `docs/generated/decisions.md` and `.agents/` respectively. Any new allowlist path whose gate is
  outside that list is a gate silently skipped, which is candidate D of `jtph` again.

### Prior art

- **Card `s3t1`** ("Run web-e2e LESS OFTEN without losing it as a gate", closed) evaluated five
  options and is the nearest prior art. Its option 3, an opt-in trigger by label or `/e2e` comment,
  is the same shape as the force in this record, and `s3t1` names its own objection: an opt-in trigger
  "relies on author judgement, which is exactly what a gate exists to not rely on." **This record
  answers that objection structurally rather than by promising discipline: GitHub refuses to merge a
  draft pull request at all.** The heavy matrix therefore cannot be skipped on the way to a merge —
  it can only be deferred until the author says the work is finished. Marking ready fires it; a
  merge without it costs main the full matrix and says so in `landing-verdict`. So this is opt-OUT
  while drafting, not opt-IN before merging, and the guarantee of the gate survives.
- `s3t1` option 1 (GitHub merge queue) remains the purpose-built answer for a multi-PR day and is
  not foreclosed by this record; it needs merge-required checks, which this repo deliberately does
  not have (rulesets enforce PR and no-force-push only).
- **Card `jtph`** already rejected candidate C (a frontend-only battery skip, because
  `check_focus_visible.py` parses `web/**/*.tsx`) and candidate D (a blanket docs glob for
  `register_only`, because `docs/generated/*` are drift-gated), and excluded `CI_FAST_MODE` as a
  solution. None of those are re-proposed here.
- **Already settled, not re-proposed**: the unrestricted `push:` trigger (removed deliberately,
  `ci.yml:4-7`) and `cancel-in-progress` on PR branches (already present, `ci.yml:12-15`).

### Where it is pinned

`.github/workflows/ci.yml` (the `heavy` step and output, the four heavy `if:` conditions, the four
`landing-verdict` expectation rows, the `types:` list and `workflow_dispatch`);
`tests/test_ci_changes.py`, which pins each condition as text AND executes the own shell of the
`heavy` step over five (DRAFT, FORCED) combinations, so a sense inversion that would make a push skip the
matrix is caught by behaviour rather than by a string match, and which refuses a trigger that
leaves `BASE` empty; `scripts/ci_proven.sh` (a one-line
constraint: no tag carries `heavy`, because it is a draft condition and that script runs only on a
push); `.agents/skills/wave-coordinator/SKILL.md` and the `brief-common.md` of the wave (the ritual).
Gate homes are the ones `tests/test_ci_changes.py` already occupies: `scripts/dod.sh:189`,
`lefthook.yml:29`, `scripts/battery_shards.tsv` row `test_ci_changes`.

### Bounds this record declares

- **NO CI check is merge-required in this repository, and this policy widens that gap.** Three
  rulesets govern `main` (`guard-main`, `main`, `main-core`); each carries `deletion`,
  `non_fast_forward` and `pull_request` rules and NONE carries `required_status_checks`, and
  `/branches/main/protection` answers 404. So a `landing-verdict` that is skipped, or a heavy
  matrix still in flight, neither blocks a merge nor satisfies anything — the gate is a ritual the
  lane performs, not a mechanism GitHub enforces. Before this record the exposure needed a merge
  during an in-flight run; with a draft policy `gh pr ready && gh pr merge` can merge a tree whose
  heavy matrix has not even been scheduled yet, and main then pays the full matrix with nothing to
  inherit. The fix is a required check on `landing-verdict`, or a ruleset carrying
  `required_status_checks`; it is NOT made here, because adding a ruleset to land a workflow change
  is a separate unit of work with its own blast radius. Tracked as a line on the successor gate
  ledger `pvq7`.
- **`ci-full` matches case-insensitively in both places.** The GitHub `==` and `contains()` are
  case-insensitive for strings, so `CI-Full` forces the matrix too. The direction is safe (more
  runs, never fewer) and neither site documents it.
- **The saving this record claims is a range, and the low end is smaller than the scout report
  headline.** The runs API carries no draft flag, so the P2 saving cannot be observed, only modelled:
  958-3,012 September minutes depending on how many pushes precede "ready". The stated owner ritual
  (heavy on the final ready push plus the pre-merge rebase) gives 958 minutes, 4.6% of the September CI,
  because 179 of 235 September PRs had only ONE run and therefore lose nothing. The upper bound of
  3,012, 14.3%, needs lanes to push several times while drafting, which is what the ritual encourages
  and what the September data cannot confirm. The ~2,851 headline in the scout report was the upper bound
  on a different question ("non-final PR runs"), and this record does not repeat it as the expected
  figure. **Together with the 4,063 minutes measured on card `v08c`, P1 and P2(b) take the 21,053
  September CI minutes to 16,032, 23.8% removed.**
- **No figure here is an invoice.** `/timing` returns `billable.UBUNTU.total_ms = 0` on this repo, so
  every minute is per-job `completed_at - started_at` ceiled to whole minutes. The reproduction check
  matches the scout report on all nine rows using plain `ceil`, not the `max(1, ceil(...))` its prose
  describes.
- **A single 21-day window** spanning an unusually heavy wave campaign. None of these are steady-state
  rates.
- **The own side effects of a trigger are not testable offline, and that cost one build.** Nothing in
  `tests/test_ci_changes.py` models `github.event.before`, so the `workflow_dispatch` force passed
  every local gate and failed on its first live run. The test now refuses a trigger that leaves
  `BASE` empty, which is a pin on the one failure that was measured — not a general guarantee that
  a future trigger is safe. A new trigger type still has to be exercised live before it is trusted.
- **`ready_for_review` cannot be made cheaper than one full run.** Marking ready re-runs the cheap
  gates too, because a new event is a new run; concurrency cancels any in-flight draft run, which is
  the only recovery available.

## decision-075

- **Slug:** `decision:decision-075`
- **Title:** decision-075: an account can send at most 50 invitations a day, and a decline blocks a repeat from that workspace until an ignored invitation would have expired

Status: Accepted

Accepted 2026-09-23 by the owner (sign-off record pkhr).

**Proposed 2026-09-23** by wave-8 lane I-INVITE for card `6pz8` ("a stranger can send unlimited invitations"). The expiry question on that card is already ruled by decision-073 (`invitation_expiry_days`, default 7, daily sweep), so this record covers the two remaining questions: a limit on how many invitations one account can send, and whether declining an invitation stops a repeat. Accepted or returned at the next sign-off; once accepted it is never edited.

### Prior art

- **GitHub** (docs, "Inviting users to join your organization", checked 2026-09-23): "you can only create 50 organization invitations within a 24-hour period"; "If your organization is more than one month old or on a paid plan, the limit is 500 invitations per 24 hour period"; "If an invitee does not accept the invitation within seven days, the pending invitation expires automatically"; a flagged account "won't be able to accept any new or pending invitations". GitHub counts per **organization**.
- **Linear, Slack**: no published invitation limit found. That is UNVERIFIED, not proof that no limit exists.
- No surveyed tool documents decline suppression. The number below is therefore derived from this app's own expiry, not borrowed.

### Decision

#### 1. Invitations are limited per inviting account: 50 in any rolling 24 hours

- The limit applies to the **account that sends the invitation**, across every workspace it owns or administers. GitHub counts per organization, but here any account can create as many workspaces as it likes (`workspaces.createRule` has no cap), so a per-workspace limit could be bypassed with one extra workspace.
- The value is the `app_settings` row `invitation_mint_limit_per_day`, default **50**, which is GitHub's figure for a new organization. GitHub's 500 tier (older than a month or paid) is not adopted: this app has no paid plans and no account-age signal. If one appears, raising the setting is enough.
- Every invitation counts toward the limit, including ones later accepted, declined, revoked or expired. If only invitations still pending counted, sending, revoking and re-sending would reset the limit. The count comes from an append-only ledger (section 3), not from the invitations table.
- Enforced in the universal create hook on `workspace_invitations`, which both the invite route and a direct collection create pass through. A superuser create is exempt from this limit and from the decline block in section 2.
- The 51st invitation is refused with **429**. The UI shows the server's message verbatim, so the message is user copy: it says the daily invitation limit was reached and to try again later. It names no setting or mechanism.

Scenarios at 50/day:

| scenario | invitations | outcome |
|---|---|---|
| small team onboarding | 5–10 | same day |
| 40-person company, day one | 40 | same day |
| 120-person company | 120 | three days, or raise the setting |
| one hostile account, fresh recipients | 50/day | at most 350 standing (50 × 7-day expiry) |
| one hostile account, one victim, many workspaces | 50/day | the victim gets at most 50 a day from that account, and at most 350 standing in the victim's switcher (a per-workspace limit would allow unlimited) |
| many hostile accounts | — | out of scope: signup throttling bounds it, not this record |

#### 2. A decline blocks a repeat from that workspace for `invitation_expiry_days`

- Declining must never leave the recipient worse off than ignoring. An ignored invitation occupies the `(workspace, email_key)` slot for `invitation_expiry_days` and no repeat is possible meanwhile. Today a decline frees that slot at once, so the inviter can re-send immediately. That makes declining worse than ignoring.
- So a decline records a tombstone, and an invitation to the same `email_key` from the same workspace is refused until `invitation_expiry_days` have passed since the decline. With the default setting that is 7 days. There is no new constant: the window equals the one an ignored invitation already holds.
- Only a decline sets a tombstone. Revoke, accept, expiry and the suspension cleanup do not. Revoke is the inviter's own act, and accept or expiry end in membership or silence.
- The refusal is **409**, with user copy saying this person recently declined an invitation to this workspace and can be invited again later.
- Disclosed consequence: the 409 tells the inviting workspace that this address declined, beyond what its pending list shows. The row does disappear early on a decline, but after an ignored invitation expires a re-invite answers 200, while after a decline it answers 409 until the window ends. So the refusal names the decline to that one workspace. That is accepted: the alternative is answering 200 and silently sending nothing, which leaves the inviter unable to tell why the invitation never arrives.
- Consequence of a mistaken decline: that workspace cannot re-invite the address for `invitation_expiry_days`. Only a superuser create bypasses the block. The recipient can still ask to be invited from another workspace, and the block lapses on its own.
- An `invitation_expiry_days` of 0 disables the block, because the tombstone check uses the setting as it stands. The ledger sweep still keeps at least a day of rows, so the daily limit is not affected.

#### 3. One hidden ledger collection

`invitation_events` has `kind` (`mint` | `decline`), `inviter` (users relation, for `mint`), `workspace` (optional relation, not cascade-delete: deleting a workspace clears the field and keeps the row, so deleting a workspace does not refund its sends), `email_key`, and `created`. All five API rules are null, so it is reachable by a superuser only. It is indexed on `(inviter, created)` and on `(workspace, email_key, kind, created)`. The existing daily expiry sweep also prunes events older than `max(1, invitation_expiry_days)` days.

### Consequences

- Invitations that already exist are untouched. Nothing migrates the invitations table, and the ledger starts empty, so every account's count starts at zero when this deploys. Production has no real users, and rooms boot fresh.
- A new collection brings its usual coupling: app_docs record, `schema/` and `openapi.json` regen, and the model tree.
- The UI needs no change. The proxy already maps 409 and 429, and the invite form renders the server's message.
- Not adopted: GitHub's flagged-account rule. This app has no flagging.


## decision-077

- **Slug:** `decision:decision-077`
- **Title:** decision-077: Business rules and derived values live in the backend; the proxy only adapts shape and the frontends only render (supersedes decision-033)

Status: Accepted (owner ruling 2026-10-23, in session; supersedes decision-033 `c380`)

### Context

A 2026-10-23 audit of `web/` and `web-carbon/` (artifact: `~/.local/share/agent-artifacts/task-manager/backend-move-audit-2026-10-23.md`, main `575358d8`) found the Next proxy and both frontends computing rules that the backend owns or should own, with concrete costs:

- the trash purge date is hard-coded to 30 days in the proxy (`web/lib/proxy/handlers/project_items.ts:148-153`) while the purge cron reads a configurable retention (`pb_hooks/trash.pb.js`);
- saving workspace settings is two non-atomic writes (`web/lib/proxy/handlers/workspaces.ts:310-321`);
- the trash list is filtered, sorted, paged and counted in memory over a route that truncates;
- item lists make two backend calls per row for comment and subtask counts, and the subtask done count stops at 500 children;
- board card positions are computed in the browser by halving gaps (`web/components/resource/use-board-drop.ts:71-83`);
- done/open status logic, role capability sets, inbox reasons and overdue thresholds are copied across the proxy, `web/` and `web-carbon/` (one copy, `web-carbon/src/item/ItemDetail.tsx:193`, already disagrees);
- `web-carbon/src/data/mock.ts` re-implements filtering, sorting, keys, audit and trash as a second backend.

decision-033 ruled the proxy's synthesis of derived counts, purge dates and vocabulary permanent. Its exception clause (one narrow card per proven cost) would leave most of the list in place.

### Decision

decision-033 is superseded. **PocketBase owns every business rule and every derived value**: status categories (done/open), retention and purge dates, comment and subtask counts, milestone progress, ordering and positions, workspace capability sets, inbox reasons and due-date policy, list filtering, sorting, paging and counting, and every user action that writes more than one record (one transaction per action).

- **The Next proxy stays the frontend's only seam** ("frontend never talks to PocketBase directly" stands). It keeps only adaptation: the session cookie and auth, path scoping, field renames and id tails, timestamp format, and normalising PocketBase's error envelope into the contract's. A proxy validation that duplicates a backend rule is removed; the proxy maps the backend refusal to the same contract error.
- **The frontends render server-provided fields** and keep presentation only: formatting in the viewer's time zone, colour, layout, URL and list state. A client copy of a rule is allowed only as an optimistic preview that the server's response replaces.
- **web-carbon's offline mode stays** (its README design), but its mock is checked against the contract schemas and implements no rule the backend does not.

### Consequences

- The seven `docs/readouts/features.yml` rows rejected under decision-033 reopen and flip as the delivery lanes land.
- The frontend contract (`web/openapi.contract.json`) gains server-computed fields (purge date, counts, open/done, capabilities, inbox reason, due days).
- Delivery is wave v14 under the parent card that cites this decision.

## dual-scope-items-w4

- **Slug:** `decision:dual-scope-items-w4`
- **Title:** Decision: dual-scope items (workspace + project) [D1, D2, W4 — BUILT]
- **Ref:** `workspaces`

BUILT (W4, #67). tasks, decisions, and documents now carry BOTH a required `workspace` and an OPTIONAL `project` (cascadeDelete=TRUE on both), so content can live at the workspace level or be scoped to one project inside it; milestones carry a REQUIRED project instead (R9, its own decision). How: a create/update hook (pb_hooks/scope.pb.js) rejects a project whose workspace differs from the item's workspace (400, D1); a second hook blocks changing workspace on update (workspace is IMMUTABLE, D4) — rescope (moving project within the SAME workspace) stays a plain update, gated by the existing member-open updateRules. See `decision:dual-scope-mechanism-w4`, `collection:tasks`, `collection:decisions`, `collection:documents`.

## dual-scope-mechanism-w4

- **Slug:** `decision:dual-scope-mechanism-w4`
- **Title:** Decision: cascadeDelete=TRUE + traversal-not-hooks D5 + defaulting hooks [D5, W4]
- **Ref:** `tasks`

Why: the D5 ruling is "project delete trashes project + its project-scoped items together; restore restores both; purge/expiry deletes both" (design.md:74-75) — this needed one shape call PocketBase's schema does not make for you (cascadeDelete true/false), and a mechanism call for how the trash-together half is realized. How (W4, #67): (1) cascadeDelete=TRUE on ALL FOUR item project relations (tasks, decisions, documents, milestones). `cascadeDelete=false` would CLEAR the relation on project delete and RE-SCOPE the item to the workspace — the ruling's REJECTED D5 option (a), not the ruling; `cascadeDelete=true` makes a real project delete (purge / cron expiry) DELETE the item, matching the ruling. (2) ZERO new D5 hooks — the trash/restore half rides W3's LIST-traversal mechanism unchanged: trashing a project sets `project.trashed` (no row delete), and the item listRules' empty-safe traversal (`project = "" || project.trashed = ""` on tasks/decisions/documents; `project.trashed = ""` on the required-project milestones) hides project-scoped items while the project is trashed and un-hides them on restore, with no per-item marker; the purge half is then the FK cascade, not a hook. (3) two DEFAULTING create hooks (pb_hooks/scope.pb.js) — tasks default `workspace` from `project.workspace` when a client sends project-only; milestones default `project` from `workspace.default_project` (fallback: the workspace's earliest project) when a client sends workspace-only. These shrink the required-field blast radius from 29 existing create-payload sites (24 task + 5 milestone across tests/seed/e2e) to zero edits — every pre-W4 create call keeps working. See `decision:dual-scope-items-w4`, `decision:milestones-project-scope-w4`.

## file-storage-on-volume

- **Slug:** `decision:file-storage-on-volume`
- **Title:** Decision: file storage lives on the Railway volume (v003) — SUPERSEDED 2026-08-17: prod files live in the pb-files bucket
- **Ref:** `tasks`

Why: module 15 adds real file uploads (avatars + task attachments), so files need a durable home in prod. How: files are stored on the local filesystem under pb_data/storage (dev) / the mounted Railway volume at /pb/pb_data/storage (prod) — the same volume already mounted for the SQLite database. Tradeoff: the volume is zero-config, consistent with the DB's durability, and needs no extra service; an S3-compatible object store (PocketBase's other supported backend) would add CDN reach, horizontal scaling, and off-box backups, at the cost of a bucket + credentials + settings change. For v003 the volume is sufficient. RESOLVED (owner ruling 2026-07-25): stay on the volume; revisit S3 together with #11 (which provisions a bucket anyway). S3 file backups/retention are module 19's concern, out of scope here. SUPERSEDED (owner ruling 2026-08-17, PBTT-390): prod file storage moved OFF the volume into its own S3 bucket, `pb-files` — distinct from the backups bucket, whose policy stays backups-only. How: pb_hooks/files.pb.js writes settings.s3 (the FILE-storage block, never settings.backups.s3) at boot from PB_FILES_S3_BUCKET / PB_FILES_S3_SECRET / PB_FILES_S3_ENDPOINT / PB_FILES_S3_REGION / PB_FILES_S3_ACCESS_KEY, the same env-boot-hook shape as pb_hooks/backups.pb.js: the credential never touches git and a rotated key re-applies on the next deploy, neither of which a settings migration could do. The hook NO-OPS unless both bucket and secret are set, so dev and the CI battery keep local-filesystem storage under pb_data/storage and only prod reads from the bucket — the volume still holds the SQLite database either way. Verified: the 2026-08-17 prod cutover put a real upload in the bucket (object count 0 -> 1) with nothing new on the volume, and tests/test_file_storage.py proves both halves in clean rooms (env set: settings.s3 wired, settings.backups.s3 untouched, no migration written; env unset: a local-filesystem upload round-trips byte-identical).

## in-app-project-crud

- **Slug:** `decision:in-app-project-crud`
- **Title:** Decision: in-app project CRUD retires the resolve-off-a-task workaround (wave 13, #36)
- **Ref:** `projects`

Why: with no in-app project creation, a fresh user's board resolved its project by reading it off the first visible task — and threw "No project resolvable" when none existed, a dead-end (#36 AC3). How: the client (web/src/lib/pb-client.ts) gains workspace-scoped project CRUD (listProjects/createProject/renameProject/deleteProject) surfaced as a Projects section in Settings plus a board empty-state that prompts creating the first project; resolveProjectId now looks up the first project in the resolved workspace instead of sniffing a task. No rule change was needed — `projects` create/update/delete are already owner-only with a create-time owner-spoof guard, and m14 opened list/view to workspace members. Multi-project selection (a switcher) is #38; this wave creates into the first project only.

## label-attachment-contract

- **Slug:** `decision:label-attachment-contract`
- **Title:** Decision: task label attachment = select from existing workspace labels; creation is owner/admin [G1, #74]
- **Ref:** `labels`

RULED (owner-approved, G1 #74). API contract for the new frontend: a task attaches labels by referencing EXISTING label ids from its workspace's labels collection (the seeded Bug/Feature/Improvement plus any custom labels); CREATING a new label is a separate owner/admin action (labels.createRule = owner/admin, decision:role-tiers), NOT part of task authoring. The backend enforces the shape: tasks.labels is a multi-relation, and pb_hooks/scope.pb.js validates every attached label belongs to the task's workspace (400 otherwise). KNOWN LIMITATION (accepted): the vendored SPA under web/ is now a REGRESSION HARNESS ONLY — its legacy free-text label ChipInput silently drops a typed name (a free string is not a valid label id), so label attach/management is NOT implemented there; that UX moves to the new frontend, which implements this select-from-existing contract. The relation→name resolution in the SPA's SDK layer (expand=status,labels) is retained purely so the harness keeps rendering. See collection:labels, decision:role-tiers, decision:vocab-first-class-collections.

## label-core-undeletable

- **Slug:** `decision:label-core-undeletable`
- **Title:** Decision: core labels are undeletable; custom-label deletes clean up natively [G1, #74]
- **Ref:** `labels`

Why (G1, #74): the three seeded core labels (Bug/Feature/Improvement, Linear's defaults) are part of every workspace's baseline vocabulary and must not be removable, while custom labels must be freely deletable without stranding dangling ids on tasks. How: an onRecordDeleteRequest("labels") hook throws BadRequestError when core===true — proven to block regular users AND superusers alike (the record persists). No strip hook is needed for custom-label deletes: with cascadeDelete=false on the tasks.labels multi-relation, PocketBase NATIVELY removes a deleted label's id from every referencing task (proven with hooks disabled); cascadeDelete=true was rejected because it would DELETE the referencing tasks. A test_labels gate proves the behaviour: deleting a custom label referenced by k tasks cleans exactly those k tasks and leaves a control task untouched. See collection:labels.

## last-workspace-autoprovision

- **Slug:** `decision:last-workspace-autoprovision`
- **Title:** Decision: re-provision a workspace when a user deletes their last one [D12i, W1]
- **Ref:** `workspaces`

Ruled: NO last-workspace protection — a user may delete their last workspace, but the app must not strand them on an empty account. How (W1, #64): a workspaces onRecordAfterDeleteSuccess hook, after guarding that the owner user still exists, re-runs the auto-provision block (workspace + owner self-membership role="member" + default project) when the owner has no workspace left. The user-exists guard also prevents an orphan during ACCOUNT self-delete: PB cascades parent-first, so the owner is already gone when the hook fires and it correctly skips (live-verified, R-3).

## member-item-writes

- **Slug:** `decision:member-item-writes`
- **Title:** Decision: members create/edit decisions and milestones [W1]
- **Ref:** `decisions`

Why: decisions and milestones were owner-only for writes even after members got READ (wave 14); the matrix opens item authoring to the whole team. How (W1, #64), since hardened by the read-only viewer tier (TASK-008.06) and draft privacy (TASK-017.17): createRule on both collections opens to the workspace owner or any ACTIVE workspace member whose role is not viewer, and milestones.createRule is byte-identical to this decisions.createRule: @request.auth.id != "" && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= "viewer" && workspace.workspace_members_via_workspace.status ?= "active")) && (workspace = "" || workspace.trashed = "") && (project = "" || project.workspace.trashed = ""). UPDATE and DELETE on decisions and milestones are all four byte-identical to each other: that same member-non-viewer predicate ANDed with the draft-visibility clause that also gates list/view (a draft is reachable only by its author, the workspace owner, and admin members — see `collection:decisions`). So DELETE is NOT owner-or-admin as this record previously claimed: a non-viewer member may delete a decision or milestone they can see, which is that member's W3 trash step (see `decision:trash-mechanism-w3`). This supersedes the earlier `decision:workspace-membership-rules` note that milestones/decisions stayed owner-only. decision-050 adds two clauses to that same create rule on both collections: the submitted workspace must not be in the trash, and neither must the workspace of the submitted project. The second clause is what refuses the form that names only a project, because the workspace is filled in from it only after the rule has already read the submitted values.

## member-read-milestones-decisions

- **Slug:** `decision:member-read-milestones-decisions`
- **Title:** Decision: open member READ on workspaces, milestones and decisions (m15 OQ1)
- **Ref:** `workspaces`

Why: m14 opened projects/tasks/comments to workspace members but left workspaces/milestones/decisions owner-only, so a member could not enumerate or read a workspace they belong to (breaking the workspace switcher, #38) nor read its milestones/decisions (the deferred m14 OQ1). How (wave 14): one rule migration adds a member-OR clause to list/view on all three, traversing the workspace_members back-relation (workspace_members_via_workspace, any-match ?=) — one hop from workspaces itself, workspace.-first from milestones/decisions. Create/update/delete stay owner-only everywhere — only READ opens. The workspaces opening was forced by the switcher (a member must read a shared workspace's name/config), not just the OQ1 ruling. Proven e2e: member list/view 200, non-member list-empty/view-404, member writes still 400 (create) / 404 (update/delete). Owner still manages membership.

## milestones-project-scope-w4

- **Slug:** `decision:milestones-project-scope-w4`
- **Title:** Decision: milestones gain a project scope [R9, W4 — BUILT]
- **Ref:** `milestones`

BUILT (W4, #67). Milestones were workspace-scoped only through W1; the ratified design scopes them to a project as well (R9, dual-scope items). How: a REQUIRED `project` relation (→projects, cascadeDelete=TRUE) added alongside the existing required `workspace`, backfilled in the same migration from `workspace.default_project` (fallback: the workspace's earliest project); a defaulting create hook fills it from the same source when a client omits it, so every pre-W4 workspace-only milestone create payload keeps working. See `decision:dual-scope-mechanism-w4`, `collection:milestones`.

## notification-fanout-semantics

- **Slug:** `decision:notification-fanout-semantics`
- **Title:** Decision: fan-out is to subscribers-minus-actor, exactly once [G2, #74]
- **Ref:** `notifications`

How G2 collaboration notifies. The subscriber set (collection:task_subscribers) grows automatically: task create → creator (+ assignee if set); assign → new assignee; task comment → commenter. Three triggers fan out a notification (collection:notifications) to the current subscribers of the task minus the actor, and each of the three subtracts one further set: an assign (kind `assigned`), a status crossing INTO a `completed`-category status (kind `status_done`), and a task comment (kind `commented`). EVERY TRIGGER EXCLUDES MORE THAN THE ACTOR: a subscriber whom the SAME write names is told once, by the mention, and never twice. On a task comment, a subscriber whom that comment body resolves as a mention gets the mention row (kind `mentioned`) and no `commented` row. On an assign or a status crossing, the subtracted set is whoever GAINED a task-description mention row during that same update, so a PATCH that names a subscriber in the description while it reassigns the task sends that person the mention and no `assigned` row; somebody mentioned in the description by an EARLIER update is not subtracted, having been told nothing by this one. That still holds once they dismissed that earlier mention (card vx7y): dismissing marks the row dismissed and never deletes it, so the next update finds the row, writes no fresh mention from description prose that did not change, and a reassign sends that person the `assigned` row. A subscriber nobody named still gets the trigger row exactly as before, and a mention of a workspace member who is not subscribed is a mention row only. That behaviour is deliberate, follows Linear, and is stated at each fan-out site in pb_hooks/notify.pb.js on the KEEP IN SYNC (fan-out) marker; only this record was stale. THE COUNT OF THREE IS STILL RIGHT and does not need reopening: it counts the triggers that READ the subscriber set, and neither kind added since is one — `mentioned` targets the people a body resolves rather than the subscribers, and `ownership_transferred` is written per party by the workspace transfer-ownership route with no subscriber read at all (decision-055). EXACTLY-ONCE is guaranteed by capturing original() values BEFORE the e.next() bridge and only firing when the value genuinely changed — a no-op replay PATCH (same assignee, same status) fans out nothing; unsubscribing (deleting one's task_subscribers row) stops all future fan-out. THE load-bearing constraint (both rehearsal reviewers, independently): e.auth is UNDEFINED in onRecordAfter*Success hooks, so every actor-dependent step (actor attribution, creator auto-subscribe, minus-actor fan-out) runs in an onRecord*Request hook via the e.next() bridge (pb_hooks/notify.pb.js, pb_hooks/activity.pb.js). Document/decision comments have no subscriber model and do not fan out. A daily digest cron emails each user one unread-summary. See collection:notifications, collection:task_subscribers, collection:task_activity.

## notification-kinds-producer-outside-fanout

- **Slug:** `decision:notification-kinds-producer-outside-fanout`
- **Title:** Decision: a notification kind may ship with a producer outside the fan-out file, superseding the vocabulary statement of decision:notification-mentioned-reserved [decision-055, card jt4g]
- **Ref:** `notifications`

RULED as decision-055 (card jt4g). The notifications.kind vocabulary carries FIVE values: assigned, commented, status_done, mentioned and ownership_transferred. This record SUPERSEDES ONLY THE VOCABULARY STATEMENT of decision:notification-mentioned-reserved, which recorded four values and located every emitter in pb_hooks/notify.pb.js. That count and that location are both false since card 95s3; the ruling those words supported is not superseded and stands unchanged. WHAT STANDS: the no-vestigial-fields rule that record established. A kind still ships with its producer, and a vocabulary entry nothing can write is still a vestigial field, taken out together with its contract type and its client rendering branch rather than parked for a producer nobody scheduled. WHAT CHANGES: the producer need not live in the fan-out file. ownership_transferred is written by the workspace transfer-ownership route in pb_hooks/routes.pb.js, one notice per party, inside the same transaction as the owner flip and the audit row, because a notice must be written or rolled back with the handover it announces. Moving that emission into the fan-out file would mean either a second transaction, which can leave a transfer announced but not performed or performed but not announced, or a callback from the route into the fan-out, which buys nothing and hides the coupling. THE CONSEQUENCE FOR THE GATE is why this is a decision rather than a note: a checker that proves the vocabulary by reading one emitter file, or by reading a historical migration list, cannot see a kind produced anywhere else. scripts/check_constants.py was built that way, on a hardcoded four-value list plus the list inside migration 1785171300, so its sites agreed with each other no matter what the live select held and a fifth value emitted from a route changed nothing it read. It now takes the vocabulary from schema/notifications.json, which is generated from the migrations, and every value declares WHERE its emitter lives, so a kind with no producer anywhere still fails. See collection:notifications, decision:notification-mentioned-reserved, decision:notification-fanout-semantics.

## notification-mentioned-reserved

- **Slug:** `decision:notification-mentioned-reserved`
- **Title:** Decision: the `mentioned` notification kind ships with its producer, superseding both its 2026-07-27 reservation and its 2026-09-02 removal [owner-ratified]
- **Ref:** `notifications`

RULED (owner-ratified 2026-09-07). This record supersedes the 2026-09-02 removal it used to carry: notifications.kind offers `mentioned` again, and the live vocabulary is assigned, commented, status_done, mentioned — every value in it written by a live emitter in pb_hooks/notify.pb.js, every one of them a live code path. The value returns together with its producer, the mention parser in pb_hooks/notify.pb.js, which resolves an @handle against the active members of the workspace plus that workspace owner and writes one notification per resolved member — in a comment body, and since card zr3d in the prose of a task, document or decision; that is exactly the condition the 2026-09-02 removal named for bringing the value back. The history stands as recorded: on 2026-07-27 the value was reserved ahead of any producer, and on 2026-09-02 it was removed for still lacking one. Why the reversal: the reserved value had no emitter anywhere, and a vocabulary entry nothing can write is a vestigial field, so the standing no-vestigial-fields ruling takes the enum entry, the contract type and the client rendering branch out together instead of parking them until a producer that was never scheduled arrives. The 2026-07-27 argument was that reserving the value kept schema, openapi and the frontend stable for a future mention parser; nothing ever consumed that stability, while every reader of the contract got a wrong answer about what an inbox row can hold. The narrowing migration refuses to apply while any stored row still holds a removed kind, naming the kind and the count, so no row is ever orphaned by it. See collection:notifications.

## notifications-scoped-to-active-workspace

- **Slug:** `decision:notifications-scoped-to-active-workspace`
- **Title:** decision-062: the notification list is scoped to the active workspace, stamped at write time; rows with no workspace list everywhere

Status: Accepted

ACCEPTED as decision-062 (owner sign-off 2026-09-16, ruling record afhx). Decision text below unchanged from the Proposed record; the summary seeded at acceptance follows it.

### Context

`yfnk` (owner report 2026-09-09): a member of two workspaces sees notifications about items in workspace B while working in workspace A, and the bell builds their link under A, so the item opens in the wrong editing context. Measured on main 1746d767: the notifications list carried no workspace scope, and no item-linked notification row carried a workspace (only the ownership-transfer notice did). The owner offered three policies: A (warn, then switch), B (show only the active workspace), C (a user setting).

### Prior art

Linear: "The Inbox is your notification center in Linear and where you will find important updates on issues in your workspace" (https://linear.app/docs/inbox). A Linear inbox belongs to one workspace; switching workspace switches inbox. Linear docs checked 2026-09-15 describe no cross-workspace inbox and no setting to merge them.

### Decision

1. Policy B (owner ruling 2026-09-15, sign-off record `17tf`): the notification list, its unread count and "Mark all as read" cover the active workspace only. A and C are not adopted: B removes the mismatch by construction, and a setting would carry an unasked-for second mode.
2. Mechanism (root ruling under the standing grant, 2026-09-15): every notification is stamped at write time with the workspace of the item it is about (`notifications.workspace`, filled by every emitter in `pb_hooks/notify.pb.js`; the ownership notice already carried it). The list filters on `workspace = <active>` or an empty workspace; a row with no workspace (legacy or system) lists in every workspace, like a notice carrying no item. One backfill migration stamps existing rows from their linked item. Rejected: a query-time join through the item, which would put three relation legs into every list, count and mark-all-read statement.
3. Mark-all-read takes the same scope as the list, so clearing the pile in A never silently reads notices in B that were never shown. The daily digest email stays account-wide: it is not a workspace screen.
4. The bell keeps building an item link under the active workspace: under B every listed item belongs to it.

### Consequences

- A notice about B is visible only after switching to B. No cross-workspace unread hint exists yet (Linear shows one on its workspace switcher); that is feature work, out of the bug-fix batch.
- The contract `Notification.workspace` stays set only for notices about no item; item rows carry the stamp in storage but not on the wire.

### Accepted summary

ACCEPTED as decision-062 (owner sign-off 2026-09-16, card e9y2; proposed by root under the standing grant 2026-09-15, card yfnk). THE NOTIFICATION LIST IS SCOPED TO THE ACTIVE WORKSPACE. The inbox list, the unread count behind it and the bulk mark all as read cover the active workspace only, plus rows that carry no workspace at all. WHAT WENT WRONG (owner report 2026-09-09, card yfnk). A member of two workspaces saw notifications about items in workspace B while working in workspace A, and the bell built the link under A, so the item opened in the wrong editing context. Measured on main at that time, the list carried no workspace scope and no item-linked notification row carried a workspace; only the ownership transfer notice did. THREE POLICIES WERE OFFERED AND THE OWNER CHOSE THE SECOND: warn the reader and then switch workspace, show only the active workspace, or add a user setting. Showing only the active workspace removes the mismatch by construction, while a setting would carry an unasked for second mode. MECHANISM. Every notification is stamped at write time with the workspace of the item it is about, filled by every emitter in the notification hooks; for a comment that is the workspace of its task, and the ownership notice already carried it. The list matches rows whose workspace is the active one, or which carry no workspace, so a legacy or system row lists in every workspace the way a notice carrying no item does. One backfill migration stamped the rows written before that from their linked item, and a row whose item could not be found keeps an empty workspace. A query time join through the item was rejected: it would put three relation legs into every list, count and mark all read statement. MARK ALL AS READ TAKES THE SAME SCOPE AS THE LIST, so clearing the pile in one workspace never silently reads notices in another that were never shown. The daily digest email stays account wide, because it is not a workspace screen. THE BELL KEEPS BUILDING ITS LINK UNDER THE ACTIVE WORKSPACE, which is now always right: every listed item belongs to that workspace. PRIOR ART. Linear describes its inbox as the notification center where a reader finds important updates on issues in their workspace; a Linear inbox belongs to one workspace, switching workspace switches the inbox, and the Linear documentation read on 2026-09-15 describes no cross workspace inbox and no setting that merges them. CONSEQUENCES. A notice about another workspace is visible only after switching to it, and no cross workspace unread hint exists yet, which Linear does show on its workspace switcher; that is feature work rather than part of the bug fix batch. The wire contract keeps the workspace field set only for a notice about no item, so an item row carries the stamp in storage but not on the wire.

## oauth-account-linking

- **Slug:** `decision:oauth-account-linking`
- **Title:** Decision: GitHub OAuth account linking + verified-on-signup (v004)
- **Ref:** `users`

Module 17 wires "Sign in with GitHub" via OAuth2. Two semantics are DECIDED here (Ruling 4) and enforced by pb_hooks/oauth.pb.js's onRecordAuthWithOAuth2Request("users") request hook: (a) a first-time GitHub signup whose provider-VERIFIED email is non-empty is treated as verified=true — GitHub's verified email satisfies our authRule (verified = true) without a PocketBase verification email, so the OAuth account is not bricked (a verified=false OAuth record would be inert / 403, the pre-m16 password gap). (b) Account linking is auto-link by verified email: a GitHub login whose verified email matches an EXISTING users record links to THAT record (no silent duplicate). This is safe precisely because the provider email (auth.AuthUser.email) is VERIFIED-only — it is empty if GitHub could not verify ownership, so matching on it never links an unverified claim. These semantics are enforced DEFENSIVELY and IDEMPOTENTLY by the request hook: the decided behavior HOLDS regardless of what PocketBase v0.39.9's engine defaults turn out to be — if the engine already does either, the hook is a no-op. The engine's observed defaults are documented from the prod browser round-trip run post-merge (a real GitHub login is the only way to prove them; a headless clean-room cannot). Separately, the provider config itself (clientId/clientSecret) is env-driven — pb_hooks/oauth.pb.js reads GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET at boot and sets the users collection's oauth2 config — because a migration cannot carry it: PocketBase strips providers[] from the auto-diff on a collection edit, keeping only oauth2.enabled.

## observability-performance

- **Slug:** `decision:observability-performance`
- **Title:** Decision: error-rate alerting + evidence-based performance indexes (module 20)
- **Ref:** `observability`

Why: Part 1 never looked at PocketBase's request logs, never added an index beyond automigrate, and had no alerting for prod errors — issue #12. Alerting (owner ruling: "email the owner on downtime"): an in-process cron CANNOT detect full process-DOWN (a dead process sends no mail), so the honest in-scope reading is an ERROR-RATE alert. pb_hooks/alerts.pb.js registers a cronAdd job that scans the trailing window of _logs (via $app.logQuery()) for HTTP 5xx / ERROR-level entries and, on a threshold breach, emails ALERT_EMAIL through the module-16 Resend transport ($app.newMailClient().send()). It is env-gated and NO-OP when ALERT_EMAIL is unset (dev/CI/battery boot inert), mirroring mail.pb.js/backups.pb.js. Full external UPTIME paging needs a third-party monitor (out of scope — don't invent infra); Railway's /api/health healthcheck (module 16) already restarts the container on health failure. Indexes (from EVIDENCE, not suspicion): a migration adds one index per hot-path relation filter — idx_tasks_project, idx_tasks_assignee, idx_projects_workspace, idx_workspaces_owner, idx_decisions_workspace, idx_milestones_workspace, idx_comments_task — via each collection's PB-native `indexes` array. EXPLAIN QUERY PLAN on a scaled synthetic dataset showed every one flipping SCAN -> SEARCH USING INDEX, and scripts/load_smoketest.py measured p50/p95 before/after (e.g. the tasks-by-project list ~17ms -> ~3ms p50). An index only helps when the filtered column is SELECTIVE: PocketBase runs ANALYZE, so a single-tenant column (every row one value) is correctly SCANned even with an index — the index earns its keep as the data diversifies. Logs findings: PB's built-in Logs API (/api/logs, /api/logs/stats) stores every request with execTime/status/url; settings.logs default retention is maxDays=5 (a prod observation must be captured in-window); request logs flush ASYNCHRONOUSLY (poll, don't read once). The ALERT_EMAIL value + any prod log excerpts live only in the untracked runbook (_meta/operations/railway.md), never in git.

## owner-only-projects

- **Slug:** `decision:owner-only-projects`
- **Title:** Decision: projects started owner-only (superseded by membership in m14)
- **Ref:** `projects`

Why (v001–v002): a project was private to its owner. How: owner = @request.auth.id on all ops, with a create-time guard against owner spoofing. UPDATE (module 14, 2026-07-25): the parked "revisit if team-shared access is added" follow-up is now resolved — list/view open to workspace members while write stays owner-only. See `decision:workspace-membership-rules`.

## ownership-transfer-operator

- **Slug:** `decision:ownership-transfer-operator`
- **Title:** Decision: a superuser-run ownership transfer names its operator [decision-056, card n28f]
- **Ref:** `task_activity`

RULED as decision-056 (owner ruling 2026-09-08, card n28f, option b). A transfer run by a superuser left no trace of who ran it: the audit row set no actor at all, because actor is a relation to users and a superuser id belongs to _superusers, so the handover read as a system event and the person behind it was unrecoverable. RULING: task_activity gains operator, a plain text column holding the email address of the superuser who made the call, filled ONLY on that path. The two identity columns are mutually exclusive by construction: an owner-initiated transfer fills actor and leaves operator empty, and a superuser-run one fills operator and leaves actor empty, so a row carrying neither is an unattributed write, a shape no writer produces. REJECTED: widening actor to free text (it breaks every expand of the relation, and the app tier reads the expanded user), and a separate collection for operator actions (two places to read one history, and the reader would have to merge them to answer who changed this). The audit reader renders a row with an empty actor and a non-empty operator as an operator action naming that identity, and reaches the system wording only when both are empty. Proven by tests/test_owner_transfer.py. See collection:task_activity. EXTENDED (av1r acceptance criterion 6, owner sign-off afhx 2026-09-16): the same operator column is also filled when a superuser edits a task directly, so the phrase filled ONLY on that path no longer holds; see collection:task_activity. A row carrying neither identity is a server-side consequence such as a cycle rollover, shown as a system action, not an unattributed person.

## production-hardening

- **Slug:** `decision:production-hardening`
- **Title:** Decision: production hardening — rate limits, batch, superuser MFA, CORS-as-flag (module 18)

Module 18 puts operational config under migration control for the first time. (1) RATE LIMITS (settings-as-migration, enabled): a 10/60s cap on both users' and superusers' auth-with-password and a 5/60s cap on request-otp (credential-stuffing / OTP-spam), plus a generous 300/60s /api/ ceiling for normal SPA traffic. Rules use method-qualified COMPLETE PATHS because a generated tag (e.g. *:list) outranks a path-prefix rule; SUPERUSERS BYPASS the limiter, so the 429 only bites guests/regular users. trustedProxy trusts X-Forwarded-For (useLeftmostIP=false) so the limiter keys the real client IP behind Railway's proxy, not one shared proxy IP. Thresholds are owner-tunable (runbook). (2) BATCH API (settings-as-migration): enabled, maxRequests=50, timeout=3s — the /api/batch endpoint runs multiple writes in ONE atomic transaction (any failing op rolls back all) and still enforces each op's per-collection API rules (a guest write inside a batch is 403 -> the whole batch 400s). (3) CORS is NOT an app.settings() field on v0.39.9 — it is the `serve --origins` flag, wired in the Dockerfile as --origins=${PB_CORS_ORIGINS:-*} (env-driven; default * preserves current behavior; the concrete allow-list is a Railway variable, not git). (4) SUPERUSER MFA (collection migration on _superusers): mfa+otp enabled, so every superuser completes an email OTP second factor (auth-with-password -> 401 mfaId; request-otp -> otpId; auth-with-otp -> token). This HARD-depends on module 16 SMTP — without mail the superuser is locked out — so m18 merges AFTER m16 (module order). Settings down() reverts values on this version; a PROD revert still ships as a new up-migration (never edit history).

## project-create-membership-guard

- **Slug:** `decision:project-create-membership-guard`
- **Title:** Decision: project create requires the workspace owner or a non-viewer member [R2, W1]
- **Ref:** `projects`

Why: projects.createRule was `owner = @request.auth.id` only — it guarded against owner-spoofing but never checked membership on the target workspace, so any authed user who learned a workspace id could create a project in it. How (W1, #64), since hardened by the read-only viewer tier (TASK-008.06) and then by decision-052: AND a workspace guard onto create — the workspace OWNER passes with no workspace_members row, anyone else needs a membership row whose role is not viewer and whose status is active (PBTT-431) — and AND a refusal of any body that carries the shadow marker, so no member can mint the invisible per-workspace project; the live projects.createRule now reads: @request.auth.id != "" && (owner = "" || owner = @request.auth.id) && (workspace.owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.role ?!= "viewer" && workspace.workspace_members_via_workspace.status ?= "active")) && (workspace = "" || workspace.trashed = "") && @request.body.shadow:isset = false. A viewer is a member but cannot create a project. Consequence (OQ-1): originally ruled follow-the-matrix, so a member who created a project in a workspace they did not own could not then edit it — SUPERSEDED by decision-023 (safety wave, owner-ruled): UPDATE now admits any non-viewer member, so a member can edit a project they created. DELETE stays owner/admin (Linear gates project deletion to admins; a member trashing a project pulls shared task surfaces out from under every member, and a safety wave does not widen destructive rights). `owner` is now purely informational: no rule reads it as an authorization signal. decision-050 adds one clause to the same rule: a create is also refused when the target workspace is in the trash, so a trashed workspace accepts no new project from anyone until it is restored.

## project-stats-membership

- **Slug:** `decision:project-stats-membership`
- **Title:** Decision: project_stats readable by workspace members [D13, R5, W1]
- **Ref:** `project_stats`

Why: the project_stats VIEW stayed owner-only after m14 opened projects to members, so a member could see a project but not its task counts. How (W1, #64): rebuild the view (drop + recreate) to add a `workspace` column (SELECT p.workspace AS workspace); PocketBase auto-types it as a relation to workspaces (live-verified, R-5), so the read rule traverses membership, now hardened with an authRequired guard (an anonymous caller's empty auth id had matched the empty back-relation join on a workspace-less/member-less project) and, since PBTT-431, a same-row active-status conjunct — the view query carries NO membership join of its own, so list/view are the only tenant control on it: @request.auth.id != "" && (owner = @request.auth.id || (workspace.workspace_members_via_workspace.user ?= @request.auth.id && workspace.workspace_members_via_workspace.status ?= "active")). Read-only view (create/update/delete null).

## reactions-own-id-toggle

- **Slug:** `decision:reactions-own-id-toggle`
- **Title:** Decision: reactions — any viewing member may react, own id only [G2, #74 — owner-ratified]
- **Ref:** `comments`

RULED (owner-ratified 2026-07-27). `comments.reactions` is a JSON map emoji → array of user ids. ANY member who can view the comment's target may react — so the comment updateRule carries a member branch that permits a PATCH touching ONLY `reactions` (all other fields field-locked via @request.body.<field>:isset = false; a member editing `body` still 404s). A hook (pb_hooks/notify.pb.js onRecordUpdateRequest("comments")) enforces that every id ADDED or REMOVED across all emoji keys equals the actor's own id, so a user can toggle only their own reaction (proven: own id → 200, another user's id → 400); superusers bypass. The JSON value arrives as a PocketBase JsonRaw wrapper (typeof object but not a native JS object) — the hook parses it via String()+JSON.parse. See collection:comments.

## role-tiers

- **Slug:** `decision:role-tiers`
- **Title:** Decision: three per-workspace role tiers (owner / admin / member) [D11, R5, W1]
- **Ref:** `workspace_members`

Why: owner-vs-member was binary; the ratified section-4c matrix needs a middle tier that can edit settings, add members, and moderate/delete content without being able to change roles or delete the workspace. How (W1, #64): a `role` select (admin/member) on workspace_members. The OWNER's powers keep coming from workspaces.owner (independent of any membership row). ADMIN is expressed in rules as a SAME-ROW back-relation match: workspace_members_via_workspace.user ?= @request.auth.id && workspace_members_via_workspace.role ?= "admin" (both `?=` on the same joined membership row — live-verified on v0.39.9, R-1: a plain member in a workspace that has some OTHER admin is NOT granted admin). An empty role is rule-equivalent to a plain member. Matrix summary — every membership tier below means an ACTIVE membership, since PBTT-431 revoked read AND write for suspended/invited/pending_approval: settings edit = owner/admin; add member = owner/admin, but PBTT-428 pins the role an admin may mint so an admin may only add a plain member and only the OWNER may add another admin or a viewer; role change = owner-only; item create/edit = any non-viewer member; destructive delete = owner/admin (interim, until W3 trash). Since card janq: pending_approval is no longer a membership status, so a non-active membership named above is an invited or suspended one; workspace_members.status is active, invited or suspended (owner ruling: the vestigial value, which nothing ever set, was deleted whole).

## saved-views-visibility

- **Slug:** `decision:saved-views-visibility`
- **Title:** Decision: saved_views visibility is scope-driven, pure-rule [G3, #74]
- **Ref:** `saved_views`

RULED (G3 #74; rehearsal Reviewer F, full matrix + owner-spoof proven). saved_views visibility is enforced by pure API rules (NO hook). A `personal` view is visible only to its owner; a `workspace` view is visible to every ACTIVE member of its workspace (list/view rule: active-member-of-ws AND (scope="workspace" OR owner=auth)); PBTT-431 hides every workspace view from a suspended, invited or pending_approval membership. create is gated by @request.body.owner = @request.auth.id — the body-owner guard ALONE blocks a member from creating a view owned by someone else (owner-spoof → 400). update/delete are permitted to the view's owner OR the workspace owner OR an ACTIVE workspace admin (the +ws-owner/admin lean HOLDS — a workspace owner edited AND deleted a member's view, 200/204). Full role matrix proven with the status idiom: a personal view is list-omitted and 404s on view for other members. See collection:saved_views. Since card janq: pending_approval is no longer a membership status, so a non-active membership named above is an invited or suspended one; workspace_members.status is active, invited or suspended (owner ruling: the vestigial value, which nothing ever set, was deleted whole).

## search-scoping-standard

- **Slug:** `decision:search-scoping-standard`
- **Title:** Decision: /api/tracker/search self-scopes to list-rule parity [G3, #74]
- **Ref:** `tasks`

RULED (G3 #74; rehearsal Reviewer E, lead-reverified live). GET /api/tracker/search?q= is a CUSTOM route (pb_hooks/routes.pb.js) and custom routes BYPASS collection rules, so the handler SELF-SCOPES by e.auth membership: one bound-parameter SQL per collection (tasks/decisions/documents/milestones/projects) whose scope predicate is EXISTS(a workspace owned by the caller) OR EXISTS(a workspace_members row for the caller with status = active; pb_hooks/routes.pb.js) — tasks additionally match the caller as assignee. The honest standard is PARITY WITH LIST RULES: search returns only what the caller could already list. Proven: anon → 401 ($apis.requireAuth()); a NON-MEMBER gets ZERO results for data in a workspace that is not theirs (the critical no-leakage proof, reverified by the lead across six matching terms); a member sees the same non-draft hits as the owner; drafts follow the carve-out below. Trash is excluded for everyone (trashed='' plus a project-trash subquery per collection shape). DRAFTS ARE AUTHOR-PRIVATE and search mirrors that: decisions, documents and milestones each carry an author field and a draft branch in their list rules, so a draft reaches only its author, the workspace owner, and an active admin member. Search resolves that same test per ROW rather than once per workspace, because a single query spans every workspace the caller can reach. This supersedes the earlier ruling on this record that drafts were member-visible content and that author-private drafts were out of scope. Ranking: title-hit (rank 0) sorts before body-only-hit (rank 1), sort-before-slice, capped at 20. Case-insensitivity is LOWER()+LIKE; NOTE SQLite case-folding is ASCII-only. LIKE metacharacters and injection strings are neutralized by escaping [\\%_] + ESCAPE + bound params. See collection:tasks. An optional workspace query parameter scopes every per-collection query to that one workspace BEFORE the cap of 20 is applied, so the twenty rows returned are the top twenty inside the addressed workspace rather than across every workspace the caller can reach. Each collection query fetches 21 rows and the combined results are interleaved by rank then by per-collection fetch position before the cap is applied, so within one rank tier a crowded collection cannot bury the equally ranked hits of a sparser one; rank still dominates the sort ahead of that interleave, so a collection whose only hits rank lower (body-only matches) can still be crowded out of the cap entirely by another collection that alone fills it with higher-ranked (title) hits. The response now carries a boolean truncated field, true whenever more matching rows existed across every collection than the cap of 20 could return. A RUN of control characters in the query text is replaced by ONE space before the text is escaped, so a null byte or another control byte in q no longer truncates the LIKE pattern early and never fuses the fragments either side of it into a word the caller never typed; a query made only of control characters reduces to nothing and takes the same empty-query path a blank query takes. Paste-heavy input is why a control byte is repaired rather than refused. DECLARED BOUND: the substitution happens before the pattern is built, so a title that genuinely holds a control byte cannot be reached by spelling it verbatim, only by one of the fragments around it. The workspace query parameter stays OPTIONAL and omitting it still searches every workspace the caller can reach, but sending it present and empty is refused with a 400 rather than read as that cross-workspace mode, the same way the trash route refuses a workspace parameter it needs and was given nothing for; the web tier reports any 400 from this route to its callers as validation_failed. Each hit is {collection, id, title, project, rank}. project is the project id of an item hit and an empty string for a project hit, so the Next proxy maps project_id from the hit itself with no follow-up list call.

## searchable-picker-button-over-popover

- **Slug:** `decision:searchable-picker-button-over-popover`
- **Title:** decision-064: the searchable picker is a button over a popover that holds the search box, so the page behind the open list is no longer hidden but focusable

Status: Accepted

ACCEPTED as decision-064 (owner sign-off 2026-09-16, ruling record afhx). Decision text below unchanged from the Proposed record; the summary seeded at acceptance follows it.

PROPOSED as decision-064 (root ruling in lane F2 under the owner's standing grant, 2026-09-15, card zk62; the owner accepts or vetoes). Recorded here because the ruling itself was made on sign-off card 17tf and needs a record a reader can land on.

THE SEARCHABLE PICKER IS A BUTTON OVER A POPOVER THAT HOLDS THE SEARCH BOX. The account-settings Time zone field is no longer a text box you type into in place. It is a button showing the zone in force; pressing it opens a panel whose first element is the search box, typing there narrows the list, and the choice returns focus to the button.

WHY. Base UI's combobox puts the rest of the page into a modal-grade hidden state whenever the search input lives OUTSIDE the popup, whichever way the modal option is set: the popup computes its focus-manager modal flag as "the input is not inside the popup, OR modal" (@base-ui/react 1.8.0, combobox/popup/ComboboxPopup.mjs:103). The underlying floating-ui helper then marks those nodes hidden from assistive technology but leaves them in the tab order, and the popup is presentational rather than a dialog, so an accessibility scanner's usual amnesty for content behind an open dialog never applies. Measured on this app: ten hidden-but-focusable findings per theme, held in the accessibility baseline against card zk62 since 2026-09-07. Two earlier lanes (v6 batch A, v7 batch D) refused to clear those held findings because the violations still reproduced, so the entries stayed and the card stayed open through four waves.

Moving the search box inside the popup is not a workaround, it is the shape the library supports: with the input inside, the popup becomes a real dialog, the page behind it is no longer marked hidden at all, and the button that opens it is the combobox. The app was asking for a shape the library only offers with modal hiding attached. Nothing in Base UI 1.7.0 or 1.8.0 changed this mechanism, so waiting for a dependency release was never a route.

OPTIONS NOT TAKEN.

Compensating in the app by also marking the hidden nodes unfocusable was measured to clear all ten findings per theme while keeping a typeable box (lane F6, 2026-09-09). It was NOT shipped: it leaves the app permanently correcting a library behaviour on every release, its keyboard and screen-reader behaviour was never validated, and the scan result was the only evidence for it. The owner ruled against it on 2026-09-15.

Forking or patching the dependency so the hiding also removes focusability was costed and rejected on the same maintenance ground.

An upstream issue does not apply. AC#1 of card zk62 asks for one "if the fix is theirs". It is not theirs: the mechanism is intended library behaviour, documented in its own source and consistent across 1.6.0, 1.7.0 and 1.8.0, and the app was using an unsupported shape. There is no defect to report, so no issue is filed and that criterion closes as not applicable rather than unmet.

PRIOR ART. Linear's settings pickers are a button over a popover that holds the search box, which is exactly this shape. shadcn/ui's Combobox, already a dependency here, puts its search input inside the popover content for the same reason. Radix ships no combobox at all, and its non-modal popovers hide nothing behind them. So the button-over-popover form is the convergent answer among the tools this app follows, not a concession this codebase makes to one library.

WHAT A READER GIVES UP. You can no longer type a zone without first opening the field, which is one extra key press for a keyboard user (the button opens on Enter, Space or Down). In exchange the page behind the open list is genuinely inert to assistive technology instead of being announced as hidden while still reachable by Tab, and the ten held findings per theme are deleted rather than carried.

WHAT WOULD SUPERSEDE THIS. A Base UI release that decouples the aria-hiding from the input's position, or that marks the hidden nodes unfocusable as well, would let the field be a text box again without the finding; that would be a new decision naming this one.

### Accepted summary

ACCEPTED as decision-064 (owner ruling 2026-09-16, delegated to root after sign-off afhx, card 1fm2; proposed in lane F2 under the standing grant 2026-09-15, card zk62). THE SEARCHABLE PICKER IS A BUTTON OVER A POPOVER THAT HOLDS THE SEARCH BOX. The account settings Time zone field is no longer a text box typed into in place. It is a button showing the zone in force; pressing it opens a panel whose first element is the search box, typing there narrows the list, and the choice returns focus to the button. WHY. The Base UI combobox puts the rest of the page into a modal grade hidden state whenever the search input lives OUTSIDE the popup, whichever way the modal option is set: the popup computes its focus manager modal flag as the input is not inside the popup, OR modal (@base-ui/react 1.8.0, combobox/popup/ComboboxPopup.mjs:103). The underlying floating-ui helper then marks those nodes hidden from assistive technology but leaves them in the tab order, and the popup is presentational rather than a dialog, so the usual amnesty an accessibility scanner grants to content behind an open dialog never applies. Measured on this app: ten hidden but focusable findings per theme, held in the accessibility baseline against card zk62 since 2026-09-07. Two earlier lanes (v6 batch A, v7 batch D) refused to clear those held findings because the violations still reproduced, so the entries stayed and the card stayed open through four waves. Moving the search box inside the popup is not a workaround, it is the shape the library supports: with the input inside, the popup becomes a real dialog, the page behind it is no longer marked hidden at all, and the button that opens it is the combobox. The app was asking for a shape the library only offers with modal hiding attached. OPTIONS NOT TAKEN. Compensating in the app by also marking the hidden nodes unfocusable was measured to clear all ten findings per theme while keeping a typeable box (lane F6, 2026-09-09). It was NOT shipped: it leaves the app permanently correcting a library behaviour on every release, its keyboard and screen reader behaviour was never validated, and the scan result was the only evidence for it. The owner ruled against it on 2026-09-15. Forking or patching the dependency so the hiding also removes focusability was costed and rejected on the same maintenance ground. Waiting for a dependency release was never a route either: nothing in Base UI 1.7.0 or 1.8.0 changed this mechanism. AN UPSTREAM ISSUE DOES NOT APPLY. AC number 1 of card zk62 asks for one if the fix is theirs. It is not theirs: the mechanism is intended library behaviour, documented in its own source and consistent across 1.6.0, 1.7.0 and 1.8.0, and the app was using an unsupported shape. There is no defect to report, so no issue is filed and that criterion closes as not applicable rather than unmet. PRIOR ART. The Linear settings pickers are a button over a popover that holds the search box, which is exactly this shape. The shadcn/ui Combobox, already a dependency here, puts its search input inside the popover content for the same reason. Radix ships no combobox at all, and its non-modal popovers hide nothing behind them. So the button over popover form is the convergent answer among the tools this app follows, not a concession this codebase makes to one library. WHAT A READER GIVES UP. A zone can no longer be typed without first opening the field, which is one extra key press for a keyboard user (the button opens on Enter, Space or Down). In exchange the page behind the open list is genuinely inert to assistive technology instead of being announced as hidden while still reachable by Tab, and the ten held findings per theme are deleted rather than carried. WHAT WOULD SUPERSEDE THIS. A Base UI release that decouples the aria hiding from where the input sits, or that marks the hidden nodes unfocusable as well, would let the field be a text box again without the finding; that would be a new decision naming this one.

## self-leave-unassign

- **Slug:** `decision:self-leave-unassign`
- **Title:** Decision: a leaver's assigned tasks are unassigned [D10, W1]
- **Ref:** `workspace_members`

Why: when a member leaves a workspace (deletes their own membership row) their tasks must not stay assigned to a non-member (the validateTaskAssignee hook forbids assigning to non-members, so a stale assignee is an invariant violation). How (W1, #64): a workspace_members onRecordAfterDeleteSuccess hook finds tasks in that workspace assigned to the leaver and clears assignee (programmatic save bypasses the REQUEST-scoped validation hook). Wrapped in try/catch so it is a harmless no-op on cascade deletes (workspace or user removal), where the tasks are themselves being deleted.

## settings-menu-same-for-every-role

- **Slug:** `decision:settings-menu-same-for-every-role`
- **Title:** decision-065: every role sees the same settings menu, and a settings page the role cannot open explains who can

Status: Accepted

ACCEPTED as decision-065 (owner ruling 2026-09-15, revised the same day, recorded on sign-off card 17tf and on card 01vq; narrow read scope ruled on sign-off afhx item C6, 2026-09-16). EVERY ROLE SEES THE SAME SETTINGS MENU. In every workspace, owners, admins, members and viewers see the same settings entries in the same order, and every entry is an ordinary link. The command palette lists the same entries from the same model. WHY. Someone who belongs to several workspaces with different roles should not see one menu in one workspace and a different menu in another and wonder why. A PAGE THE ROLE CANNOT OPEN EXPLAINS ITSELF. An entry with a read only view for the role opens that view: Workspace and Projects open for every role, read only where the role cannot edit. An entry with nothing the role may see (Members, Audit and Templates below owner or admin) opens a short explainer instead: what the page is for, who can open it, and who to ask. A direct link to such a page shows the same explainer, never a redirect or a bare refusal. The explainer names the workspace owner and admins by display name through its own narrow read made with the reader session, and names the role instead when that read yields no names; it never shows an email address, and it makes none of the management reads the real page makes. REVISION. The first version of this ruling showed unavailable entries inactive with a note. Root pushed back: an inactive entry is a dead end, disabled menu items are a common accessibility failure, and a direct link would still behave differently from the menu. The owner accepted the explainer version, which supersedes the first within the same day. OPTIONS NOT TAKEN. Hiding entries by role, the behaviour before this ruling and the behaviour of the tools below, keeps the menu different per workspace. Inactive entries with a note were the first version and are replaced by the explainer. A new role gate on the membership list was ruled out of this decision (afhx item C6); if it is wanted it is its own security card. PRIOR ART, AND THE DIVERGENCE. Linear hides administration from non admins: its members and roles documentation says members cannot access workspace level administration pages, and guests cannot access settings beyond their own Account tab. Notion does the same: its workspace settings help says only workspace owners can access these workspace settings, and many settings are only visible to an admin. This decision deliberately goes further than both for consistency across workspaces; neither tool is cited as support for showing the entries. CONSEQUENCES. A member or viewer sees entries they cannot use, one click from an explanation of who can. The explainer copy is per page and must stay in user language, never a role key, route or permission name.

## shell-flat-slot-layout

- **Slug:** `decision:shell-flat-slot-layout`
- **Title:** decision-063: shell layout is a flat slot model on one CSS grid, pinned sidebar and docked peek at 768px and wider, focus mode is a session gesture

Status: Accepted

ACCEPTED as decision-063 (owner sign-off 2026-09-16, ruling record afhx). Decision text below unchanged from the Proposed record; the summary seeded at acceptance follows it.

### Context

The owner asked (2026-09-15) for the shell to behave the way VS Code and ChatGPT desktop do: major surfaces as coexisting panels that share the window, any one of which can be focused to fill the window and then restored. The inventory of the current tree and the prior-art research are on the cluster parent and `doc-010` (both linked). Three things need a ruling before a builder can start: the layout data model, the rendering approach, and what persists.

The current tree diverges from decision-025 (`wcww`): that record rules a pinned collapsible sidebar at and above 768px with a drawer below, but `ShellChrome.tsx` renders the drawer at every width and `sidebar-navigation.spec.ts` pins that behaviour. This record supersedes decision-025's layout clause; its scope ruling (mobile and tablet in scope, one breakpoint at 768px, wide tables scroll in their container) stands.

### Prior art (doc-010)

- **VS Code** stores no layout tree for the workbench; each part is `{visible, size}` and the grid is rebuilt from those every boot. A hidden part keeps its last size. Zen mode restores only the parts it hid (`zenMode.exitInfo.wasVisible`). Sizes are profile-scoped, visibility workspace-scoped.
- **Linear** (this app's anchor): `[` collapses the sidebar; Space peeks (preview overlay); a persistent "split" display mode puts the list beside the focused issue; Enter opens full. Display options persist per user.
- **Apple HIG:** pane minimum and maximum sizes, never hide the sidebar by default, full screen keeps a visible exit.
- **ARIA APG:** a docked side panel is `complementary`, not a dialog; a divider is the Window Splitter pattern.

### Options weighed

**Model.** (a) A serialized layout tree (grid of splits, as dockview / flexlayout / VS Code editor groups). (b) A flat set of named slots, each `{visible, size}`, plus one `focus` override carrying a snapshot of what it hid. This app has three surfaces with fixed positions; (a) buys arbitrary splits and tabs nobody has asked for and makes every migration of the persisted shape a hazard.

**Rendering.** (a) A docking library (dockview 85 kB, flexlayout 53 kB). (b) A split-pane library for the dividers only (react-resizable-panels 11 kB, the shadcn Resizable primitive; allotment 9.6 kB). (c) One CSS grid on the shell, `grid-template-columns: var(--nav) minmax(0,1fr) var(--peek)`, custom properties set from state, a hand-rolled `role=separator` handle. (c) is the smallest diff and keeps the existing breakpoint and overlay code paths intact below 768px.

**Persistence.** What VS Code and Linear both persist: sidebar visibility and per-slot sizes. What neither persists sensibly: focus mode (a reload landing full-window with no visible exit is the failure to avoid) and which item is peeked (already in the URL).

### Decision

1. **Flat slot model.** `nav`, `main`, `peek`; `nav` and `peek` carry `{visible, size}`; `main` is `minmax(0,1fr)`. One `focus: Slot | null` plus `focusExit: {nav: boolean, peek: boolean} | null`. Maximize sets `focus`, snapshots visibility into `focusExit`, hides the rest; restore copies the snapshot back and clears both. Sizes are never touched by focus.
2. **One CSS grid, no docking library.** Column widths are custom properties driven by the state. Below 768px the grid is one column and `nav`/`peek` render as the overlays they are today. The divider follows the Window Splitter pattern; `react-resizable-panels` is the sanctioned fallback if the hand-rolled handle's a11y grows past roughly the size of the component it serves. Transitions on `grid-template-columns` are disabled under `prefers-reduced-motion`.
3. **The docked peek is a `complementary` landmark, not a dialog:** no scrim, no Tab trap, no `aria-modal`, the list stays interactive. The modal `PeekPanel` survives only below 768px.
4. **Persisted:** `nav.visible`, `nav.size`, `peek.size`, in localStorage keyed `tracker:layout:<userId>:<workspaceId>`, read through the `fold-store.ts` pattern, with a no-flash attribute set by the existing `noFlashPrefs` inline script so the sidebar does not jump on hydration. **Not persisted:** `focus`, `focusExit`, `peek.visible` (the route owns it). A reload always lands un-focused.
5. **Keyboard and controls:** `[` toggles the sidebar (already bound; now toggles the pinned column at ≥768px). Escape exits focus mode only when no inner layer is open (the existing one-layer-per-press unwind). Every focused slot shows a visible "Exit focus" control in its header. Command palette entries mirror every toggle.
6. **Decision-025's layout clause is superseded** by items 1–3; its scope ruling stands.

### Consequences

- `sidebar-navigation.spec.ts` inverts at ≥768px: opening nav now resizes `main`. The spec is rewritten by the sidebar child, not deleted.
- The peek loses its modal contract at ≥768px, so `overlay-contract.spec.ts` and `peek.spec.ts` need a viewport split: modal assertions below 768px, landmark assertions above.
- Full-page item view (decision-005, Tabs) is unchanged; focus mode on the full page hides only `nav`.
- Anything needing arbitrary splits or tabs inside a slot is a NEW decision, not an extension of this one.

### Accepted summary

ACCEPTED as decision-063 (owner sign-off 2026-09-16, card g9xd). THE SHELL LAYOUT IS A FLAT SLOT MODEL. Three named slots make up the shell: nav, main and peek. The nav and peek slots each carry a visibility flag and a size; main takes the width left over and may shrink to nothing. One focus slot reference, plus a snapshot of what was visible when focus was entered, covers focus mode: maximizing a slot records that snapshot, hides the rest and sets the focus, while restoring copies the snapshot back and clears both. Focus never changes a stored size. A serialized layout tree of splits, the shape a docking library persists, was weighed and rejected: this app has three surfaces in fixed positions, so a tree buys arbitrary splits and tabs nobody has asked for and turns every later change of the persisted shape into a migration hazard. ONE CSS GRID, NO DOCKING LIBRARY. The shell renders as a single CSS grid whose column widths are custom properties driven by the slot state; there is no docking library and no split pane library. Below 768px the grid collapses to one column and nav and peek render as the overlays they are today. The resize handle follows the window splitter pattern of the ARIA authoring practices, and column width transitions are disabled when the reader asks for reduced motion. A sanctioned fallback exists if the hand rolled handle grows past roughly the size of the component it serves: react-resizable-panels, the primitive behind the resizable component already installed. THE DOCKED PEEK IS A COMPLEMENTARY LANDMARK, NOT A DIALOG. At 768px and wider the peek docks beside the list: no scrim, no tab trap, no modal attribute, and the list stays interactive. The modal peek panel survives only below 768px. WHAT PERSISTS. Nav visibility, nav size and peek size persist per user and per workspace in local storage, read through the same store pattern the fold state uses, with the no flash attribute the existing preference script already sets so the sidebar does not jump when the page hydrates. Focus, the focus snapshot and peek visibility are NOT persisted: the route owns whether a peek is open, and a reload always lands un-focused, because a reload landing full window with no visible exit is the failure to avoid. KEYBOARD AND CONTROLS. The existing bracket shortcut toggles the sidebar, and at 768px and wider that means the pinned column rather than a drawer. Escape leaves focus mode only when no inner layer is open, following the existing one layer per press unwind. Every focused slot shows a visible exit control in its header, and the command palette mirrors every toggle. THIS SUPERSEDES THE LAYOUT CLAUSE OF DECISION-025. decision-025 ruled a pinned collapsible sidebar at and above 768px with a drawer below it, while the shipped shell renders the drawer at every width and a spec pins that behaviour. The layout clause of decision-025 is superseded by the slot model, the single grid and the docked peek stated above. The scope ruling of decision-025 stands unchanged: mobile and tablet are in scope, there is one breakpoint at 768px, and wide tables scroll inside their container. PRIOR ART. VS Code stores no layout tree for its workbench: each part carries visibility and a size, the grid is rebuilt from those on every boot, a hidden part keeps its last size, and zen mode restores only the parts it hid. Linear, the app this one converges on, collapses its sidebar with a bracket key, peeks an issue as a preview overlay, offers a persistent split display mode that puts the list beside the focused issue, and persists display options per user. The Apple human interface guidelines ask for pane minimum and maximum sizes, for never hiding the sidebar by default, and for a visible exit from full screen. The ARIA authoring practices treat a docked side panel as a complementary landmark rather than a dialog, and a divider as the window splitter pattern. CONSEQUENCES. The sidebar navigation spec inverts at 768px and wider, where opening the nav resizes main rather than covering it; that spec is rewritten, not deleted. The peek loses its modal contract at 768px and wider, so the overlay contract and peek specs split by viewport: modal assertions below the breakpoint, landmark assertions above it. The full page item view of decision-005 is unchanged, and focus mode on that page hides only the nav. Anything that needs arbitrary splits, or tabs inside a slot, is a NEW decision rather than an extension of this one.

## signup-approval

- **Slug:** `decision:signup-approval`
- **Title:** Decision: new accounts need owner approval before login (v005, #30)
- **Ref:** `users`

Owner ruling 2026-07-26: prod signup stays open but no new account gets access until it is approved (anti-flood / anti-abuse). Mechanism (module 19): users gains `approved` (bool, default false); authRule becomes `verified = true && approved = true`. A verified-but-unapproved account 403s on its own token until approved; both flags true → 200. Self-approval is blocked declaratively: createRule and updateRule carry `@request.body.approved:isset = false`, so any signup or self-PATCH that even mentions `approved` is rejected (create 400, update 404) — proven live. A backfill migration set approved=true on all accounts existing at migrate time (the owner's account + dev seeds) so nothing already working broke; scripts/seed.py sets approved=true on the users it creates (it runs as superuser, AFTER migrations, so the backfill can't cover them). OAUTH COMPOSITION: pb_hooks/oauth.pb.js is UNCHANGED — it still sets verified=true from GitHub's provider-verified email (correct), but approved stays false, so a fresh GitHub signup lands unapproved and is denied its token until approved, exactly like a password signup. A signup rate limit (POST /api/collections/users/records, 5/60s) caps record-flood at the limiter. APPROVAL WORKFLOW (SUPERSEDED 2026-08-06 by TASK-017.21): this record previously said the owner flips `approved` in the /admin dashboard users list and that no bespoke admin UI was built. There IS one now — web/'s admin screen lists waiting accounts and approves them, so no dashboard step is needed. WHO may approve is a deliberate ruling (backlog decision-014): approval is an APP-LEVEL power held by accounts named in the APP_ADMIN_EMAILS deployment setting, NOT the per-workspace owner/admin tier. Reusing the workspace tier would have been an escalation hole, because every signup auto-provisions its own workspace and becomes its owner — so any signup could have unlocked any other pending account app-wide. Denied callers get 404 (no existence leak). Approval remains a human act; nothing auto-approves.

## status-delete-referenced

- **Slug:** `decision:status-delete-referenced`
- **Title:** Decision: deleting a referenced status is blocked [G1, #74 — owner-ratified]
- **Ref:** `statuses`

RULED (owner-ratified 2026-07-27; sign-off trail _meta/signoff/2026-07-27-status-deletion/answers.json). Plan §3 left status-deletion policy open ("blocked while referenced, or a reassign policy per ruling"). Ruling: DELETE of a status referenced by ≥1 task is BLOCKED by an onRecordDeleteRequest("statuses") hook (throws → client error, row survives); unreferenced statuses are deletable, INCLUDING an is_default one (the workspace can designate another). A reassign-then-delete flow is composed CLIENT-SIDE by the frontend (repoint the referencing tasks to another status, then delete) — the backend keeps the single hard invariant that a referenced status never vanishes out from under a task. Rationale: conservative and reversible, mirrors the labels impact-count UX; keeps the reassign policy in the UI where it belongs without backend migration pain. See collection:statuses, decision:vocab-first-class-collections.

## tenancy-model

- **Slug:** `decision:tenancy-model`
- **Title:** Decision: wrap the app in a workspace tenancy layer
- **Ref:** `workspaces`

Why: the app is hosted and multi-user, but Backlog.md is local-first (one folder, one implicit user). How: module 10 adds user → workspace → project → task by migration, exactly one owner per workspace, per-workspace config replacing the config file. v002 is single-player: owner-only rules only. Collaboration (membership access, assignee capabilities) is deferred to module 14.

## trash-mechanism-w3

- **Slug:** `decision:trash-mechanism-w3`
- **Title:** Decision: soft-delete trash mechanism — DELETE-interception, second-delete-purges, superuser hard-purge [W3, #66]
- **Ref:** `workspaces`

Why: R8/D15 ruled a 30-day (configurable) soft-delete window instead of destructive delete (see `decision:trash-window-w3` for the ruling + interim owner/admin gate this wave replaces on the four item collections). How (W3, #66): a `trashed` date field (empty string = live) on all six workspace-scoped collections (workspaces, projects, tasks, decisions, milestones, documents). PocketBase evaluates deleteRule before a delete-request hook fires, so the four ITEM deleteRules (tasks/decisions/milestones/documents) are OPENED to the member tier — matching the matrix's trash actor set; projects/workspaces deleteRules are UNCHANGED (already owner/admin and owner-only, which is exactly their trash-AND-purge actor set, one rule serving both verbs). Six per-collection `onRecordDeleteRequest` hooks in `pb_hooks/trash.pb.js` decide the verb by the record's current `trashed` state: (1) a SUPERUSER DELETE always calls e.next() — a hard-purge escape hatch for cleanup, since delete-request hooks fire for superusers too (proven by the users R7 guard's isSuperuser check). (2) A first DELETE (not yet trashed) sets `trashed` to now via a programmatic save (bypasses request hooks) and returns `e.noContent(204)` — a bare return yields HTTP 200, which would silently break the ten status-only cleanup suites asserting `== 204`, so the explicit 204 is load-bearing. (3) A SECOND DELETE (already trashed) is a PURGE attempt: for items, the hook re-checks owner/admin authorization inline (walk to the owning workspace; allow the workspace owner OR a `workspace_members` row with role="admin"; unauthorized → `BadRequestError` → 400 veto, row survives; authorized → e.next(), real delete); for projects/workspaces the deleteRule already gates to the purge actor set, so it's a bare e.next(). TRASHED ROW READS (card htsr, migration 1785163100) supersede the M3 surface-exclusion note this record used to carry: on the four BASE item collections — tasks, decisions, documents and milestones — list and view are narrowed together, because that migration assigns each viewRule the listRule of the same collection. A trashed row, or a row under a trashed project, is therefore no longer retrievable by id from its OWN collection, and no longer expands through any relation pointing at it. Since migration 1785164900 it is not retrievable from the project_items view either — that view carries the same trashed and trashed-project exclusion, so a by-id read is 404 at every tier. Restore never reads through the narrowed rule: GET /api/tracker/trash enumerates a workspace trash for any active member, and the restore PATCH runs under an updateRule that names no trash state at all, so the v1 concern about restoring without a trash-listing UI no longer applies. `project_stats` excludes trashed projects/tasks via its VIEW QUERY (`WHERE p.trashed = ''`, task JOIN filtered `AND t.trashed = ''`), not a rule. Restore is a plain PATCH clearing `trashed`, gated by the existing (unchanged) updateRule — no new rule or hook. Project-trash cascade (M4): trashing a project does NOT stamp a marker on its tasks; instead `tasks.listRule` gains `&& project.trashed = ""` (single-hop traversal, the repo's existing idiom), so a trashed project's tasks vanish from every list without a task-level marker, and restoring the project (clearing its `trashed`) brings its tasks back automatically — a task individually trashed BEFORE its project stays hidden after project restore. Project/workspace PURGE cascades to their tasks/projects via the existing `cascadeDelete` relations. Expiry (M6): a daily cron (`cronAdd`, default `0 4 * * *`, env-overridable `TRASH_PURGE_CRON`) in `pb_hooks/trash.pb.js` reads `app_settings.trash_retention_days` (JsonRaw byte-array decode, falls back to 30 on any read error or missing row) and purges every row across all six collections trashed longer than that window (parents first, so cascade shrinks later leaf-collection queries); `app.delete` is programmatic, so the trash request hooks above do NOT re-fire, but `onRecordAfterDeleteSuccess` hooks in main.pb.js still do (harmless, already-guarded). A daily cron cannot be waited on in the battery, so a superuser-only `POST /api/tracker/trash/purge` route runs the byte-identical inlined sweep on demand and returns `{purged: <count>}`, giving tests a deterministic trigger. See `decision:trash-window-w3` (the R8/D15 window ruling this wave implements), `decision:role-tiers`. Card 1h9m (migration 1785176300): a PocketBase purge cascade scans for children once, so a task, document, decision or milestone created while its project is being purged can commit after that scan and outlive the project. The purge sweep, the daily cron and the superuser purge route alike, still deletes such a row on its next pass and nothing deletes it at create or delete time, because both preventive remedies cost valid concurrent creates. Until the sweep runs the row is now hidden exactly like an item in a trashed project: the list and view rules of all four item collections also require the project record to exist (the rule reads the created stamp of the project, because a relation id alone resolves without reading the projects table and so cannot tell a missing project from a live one), the project_items flag reads 1 for it, and POST /api/tracker/export applies the same predicate. The rows hanging off such an item are hidden with it: comments, task activity, task subscriptions and notifications carry the same project existence guard in every rule that reads the project of their parent, and the per user summary route stops counting the task. A member therefore lists nothing, reads 404 by id and exports nothing for it, while a superuser still sees it. An item with no project and an item in a live project are unaffected. Proven by tests/test_dangling_project.py for the workspace owner and an active member, including a real race of member creates against a superuser purge.

## trash-window-w3

- **Slug:** `decision:trash-window-w3`
- **Title:** Decision: destructive deletes stay owner/admin until W3 adds a trash window [R8]
- **Ref:** `tasks`

Ruled but built later (W3, #66). Until trash / soft-delete exists, destructive DELETE on every workspace-scoped item collection (tasks, decisions, milestones, documents, comments) sits at the workspace OWNER or a workspace ADMIN — nothing ships more permissive-destructive than the matrix's PURGE column. W3 will add a delete-to-trash affordance for any member with a recovery window; this record is seeded now so the rationale for the interim owner/admin gate is documented in place.

## user-settings

- **Slug:** `decision:user-settings`
- **Title:** Decision: per-user 1:1 settings, self-only [D6, W2]
- **Ref:** `user_settings`

Why: users need personal UI preferences (theme, font) that only they can see or change. How (W2, #65): a user_settings collection, exactly one row per user (UNIQUE index on `user` → a second row 400s). All five rules are SELF-ONLY and identical (@request.auth.id != "" && user = @request.auth.id). A row is auto-provisioned at signup by a hook (theme="system", font="system") and backfilled for accounts minted before the hook shipped (1785110640), so every user always has exactly one. cascadeDelete true — a deleted user's settings go with them.

## user-settings-font-migration

- **Slug:** `decision:user-settings-font-migration`
- **Title:** Decision: removing the serif font option is data-first [G3, #74]
- **Ref:** `user_settings`

RULED (G3 #74; rehearsal Reviewer F, the trap is real and characterized). Removing the `serif` option from user_settings.font is DATA-FIRST and the step order is MANDATORY. The single up(): (1) UPDATE user_settings SET font='system' WHERE font='serif' FIRST, (2) narrow the select options to [system,sans,mono], (3) add font_size (integer, min 12, max 24, onlyInt). THE TRAP: narrowing the options while an orphan serif row still exists SILENTLY SUCCEEDS and reads stay fine, but that row becomes UN-PATCHABLE forever — any later update 400s 'Invalid value serif', locking the user out of their own settings. Proven (test_user_settings_font): a pre-existing serif row is migrated to system LOSSLESSLY; post-migration font='serif' → 400; font_size 8/40/16.5 → 400, 16 → 200. See collection:user_settings.

## verified-login

- **Slug:** `decision:verified-login`
- **Title:** Decision: email verification is required to log in
- **Ref:** `users`

Why: open signup (createRule "") means anyone can create an account; requiring verified = true (authRule) keeps unverified accounts inert. How: the verification email carries a 24h token; confirm-verification flips the flag. Superusers bypass authRule. Dev note: without SMTP configured PocketBase hands mail to the OS sendmail and it silently vanishes — run scripts/smtp_sink.py and point Settings > Mail at 127.0.0.1:2525 to capture tokens locally.

## vocab-first-class-collections

- **Slug:** `decision:vocab-first-class-collections`
- **Title:** Decision: task vocabulary (statuses, labels) becomes first-class collections [G1, #74]
- **Ref:** `tasks`

Why (G1, #74): per-workspace statuses and labels lived as JSON blobs on the workspace record and tasks.status was free text / tasks.labels a JSON string array — unqueryable, un-joinable (project_stats bucketed by hard-coded name), and impossible to attach metadata (color, category, is_default, core) to. How: two new collections, statuses (Linear's six categories) and labels (with a core flag), each workspace-scoped and seeded on provision; tasks.status became a relation→statuses and tasks.labels a multi-relation→labels; a lossless data migration converted every pre-existing workspace's JSON vocab into rows and re-pointed every task's text/JSON values at the new relation ids in one migration. Mechanism findings proven pre-build: (1) an in-place PB field TYPE swap (text→relation) is silently ignored — the conversion adds a new relation field alongside the old text field, copies row-by-row, detaches project_stats (which hard-references t.status), drops the old field, renames the new one, and rebuilds the view. (2) tasks.seq (a per-workspace human number) CANNOT use read-max+1 in the create hook — it collided 9/20 under concurrency — so seq rides a UNIQUE INDEX (workspace, seq) plus an atomic per-workspace counter (workspaces.seq_counter, incremented by a single SQL UPDATE…RETURNING); seq is immutable via an update-hook. (3) project_stats is rebucketed by statuses.category. Access tier (ruled G1, owner-approved): labels and statuses CRUD is OWNER/ADMIN write, MEMBER read — they are workspace configuration and replace the workspaces.statuses/labels JSON that was owner/admin-edited, mirroring decision:role-tiers ('settings edit = owner/admin'). Core-label delete is the one exception that is blocked for owner/admin/superuser alike regardless of tier (decision:label-core-undeletable). See collection:statuses, collection:labels, collection:tasks, decision:role-tiers, decision:label-core-undeletable, decision:status-delete-referenced. SUPERSEDED IN PART (PBTT-422, decision-043): finding (2) above describes tasks.seq, a per-WORKSPACE number fed by workspaces.seq_counter. Both columns are removed. The item number is per PROJECT now and SHARED by tasks, decisions, documents and milestones: projects.item_seq feeds a stored, immutable `key` on each item — the prefix of the project plus that number — so the type shows in the icon rather than a sigil. The concurrency finding still holds and the same UPDATE...RETURNING idiom carries it; what changed is the scope of the counter and the shape of the label.

## web-e2e-sharding

- **Slug:** `decision:web-e2e-sharding`
- **Title:** Decision: web-e2e scales by sharding across runners, never by workers inside one room [PBTT-533, decision-045]

The suite costs 13m11s (CI median, n=45) because it is 269 tests at 2.50s median, serial, `workers: 1`, against one shared seeded PocketBase room. 712 of the 791 suite seconds are test execution — there is no overhead to reclaim. Raising workers against that shared room was measured and rejected: `--workers=4 --fully-parallel` cut wall clock to 197s and produced 21 failures against the baseline's 1; `--workers=4` file-parallel gave 192s and 7 failures. The failures are state collisions, not timeouts (`tbody tr` Expected 6 Received 7; a second worker's toast tripping a strict-mode locator). `fullyParallel` bought no speed over file-parallel and tripled the damage — it is ruled out permanently. Isolating per worker would mean a workspace-per-worker rewrite across every spec's fixtures; that cost is not paid for a 3x wall clock we can get another way. `--shard` splits across processes, so each shard runs its own `globalSetup` and gets its own room, serial within — a faithful copy of today's isolation. Measured 2-way: 319s + 277s, 270 passed, 1 failure (a render race, matching the baseline's rate). Shards land on separate runners, so no `PB_PORT_OFFSET` and no build change are needed, and `blob`/`merge-reports` is optional since each shard reports its own verdict. 4 shards project to 5.6 min wall (2.6x) for +54% runner minutes on this job. Bigger runners are rejected: a 12-core M2 Pro beats the 4-vCPU runner by only 1.30x on the identical serial suite, so the workload is latency-bound, not CPU-bound. Build-artifact sharing is rejected: `web-gates` runs no `next build` (only web-e2e does, 38s of 868s = 4.4%). Sharding does not change the flake rate and must not be sold as if it does. The measured flake burden was 6 retry-masked flakes across 43 green jobs (14%), of which 5 were `templates-settings.spec.ts:206` — one post-mutation list-refresh race, not a family, since fixed under PBTT-412. `retries: 1` stays until PBTT-535 evaluates its removal against accumulated post-412 runs. Supersedes the premise of PBTT-377 (shared-room rate ceiling): `clean-room.ts:88` disables rate limits at room boot, so the ceiling does not exist. Confirms PBTT-460.

## workspace-configuration-freeze

- **Slug:** `decision:workspace-configuration-freeze`
- **Title:** Decision: a trashed workspace freezes its configuration and roster, and keeps them readable only to the tier that can restore it [decision-053, card 3d2s]
- **Ref:** `workspaces`

RULED as decision-053 (owner ruling 2026-09-07, card 3d2s, built with card 5gkp as one security lane); every migration header, board card and sibling record cites this ruling by that number. PRIOR ART: Linear freezes a deleted workspace entirely for the grace period and offers nothing but restore. decision-050 hid and froze everything UNDER a trashed workspace — its projects and the tasks, documents, decisions and milestones inside them — but ruled on nothing else, so the workspace vocabulary, its cycles, its templates, its shared saved views and its member list stayed listable AND writable by every active member while the workspace itself answered as gone: the owner could invite a new member into a workspace the app says does not exist. That is the hole this record closes. WRITES FREEZE ON ALL SIX CONFIGURATION COLLECTIONS — labels, statuses, cycles, templates, saved_views and workspace_members. While the workspace is in the trash a create is refused and an update or a delete answers exactly as an unknown id does, for the workspace owner and an active admin as much as for a plain member, a viewer and a suspended member. Leaving a workspace is a write on the roster, so a member cannot leave a workspace that is in the trash either; restoring it is what makes leaving possible again. Nothing is stamped on any of those rows, so a restore brings all of them back unchanged, with no per-row bookkeeping to undo. READS NARROW TO THE TIER THAT CAN RESTORE: the workspace owner and an ACTIVE ADMIN keep listing and reading the configuration and the roster of a trashed workspace — the same set decision-050 gave the trashed-workspace listing and the restore itself — while a plain member, a viewer, a suspended member and a non-member all get an empty listing and the unknown-id answer. Configuration is what a restore lands back into, the status a task points at and the membership row that authorises the restore, so the people who can restore keep seeing it and the people who cannot are told nothing. THE PROXY CARVE-OUT (card 5gkp) is the same ruling seen from the web tier: through the proxy an owner or admin of a trashed workspace may do exactly two things, restore it and read why it was trashed, and every other request answers as not found for every tier. This record SUPERSEDES NOTHING and decision-050 stands unchanged: the CONTENTS of a trashed workspace stay hidden and frozen for everyone, the owner and an active admin included. Priorities are a fixed vocabulary rather than a collection, so nothing about them changes. Proven by tests/test_visibility_invariants.py, which DERIVES the frozen set rather than listing it: a collection that carries a workspace relation and no trash state of its own is configuration. See collection:workspaces, decision:role-tiers.

## workspace-default-project

- **Slug:** `decision:workspace-default-project`
- **Title:** Decision: optional default_project relation on workspaces [D7, W2]
- **Ref:** `workspaces`

Why: a workspace should open to a chosen project rather than an arbitrary one. How (W2, #65): an OPTIONAL default_project relation on workspaces (→projects, maxSelect 1). cascadeDelete is FALSE so deleting the pointed-at project clears the pointer, not the workspace. Editable by the workspace owner or admin (the W1 workspaces updateRule, unchanged by W2). The same-workspace VALUE guard — default_project must belong to THIS workspace — is enforced by a HOOK, not a rule: a rule denial on update yields 404 (the requirement is a clean 400), and @request.body relation traversal is unproven on v0.39.9, so the hook throws a BadRequestError. Set at provision time and backfilled (1785110650: prefer the "My Project" default, else the earliest-created project, skip project-less workspaces).

## workspace-membership-rules

- **Slug:** `decision:workspace-membership-rules`
- **Title:** Decision: workspace membership drives collaborative access (module 14)
- **Ref:** `workspaces`

Why: the app is multi-user; owner-only rules (v002) let a team share nothing. How: rules traverse the workspace_members back-relation (workspace_members_via_workspace, any-match ?=) so an ACTIVE member sees all workspace projects, reads/updates their tasks, and comments — PBTT-431 added a same-row active-status conjunct to every membership branch, so a suspended, invited or pending_approval membership carries no access at all, read or write; an assignee keeps task-relative access; an assignee of a parent may create a subtask under it. Owner adds/removes members. Assignment is restricted to members via a validation HOOK (a rule denial on update yields 404, but the requirement is a 400). CORRECTION (W1, #64): the module-14 claim that "milestones/decisions stay owner-only this module" is SUPERSEDED — members now create/edit milestones and decisions, and the owner/admin delete them (section-4c matrix). See `decision:member-item-writes` and `decision:role-tiers`. Since card janq: pending_approval is no longer a membership status, so a non-active membership named above is an invited or suspended one; workspace_members.status is active, invited or suspended (owner ruling: the vestigial value, which nothing ever set, was deleted whole).

## workspace-trash-cleanup-not-atomic

- **Slug:** `decision:workspace-trash-cleanup-not-atomic`
- **Title:** decision-061: the workspace trash cleanup is not atomic with the trash, and an admin trashing the owner last workspace still reprovisions it
- **Ref:** `workspaces`

Status: Accepted

ACCEPTED as decision-061 (owner sign-off 2026-09-16, ruling record afhx). Decision text below unchanged from the Proposed record; the summary seeded at acceptance follows it.

### Context

`6f1x` asked for the workspace trash and its cleanup (the notification cascade and the last-workspace reprovision) to succeed or roll back together. Owner ruling K on sign-off batch `gzyv` (2026-09-08) chose one transactional record-level step. Lane B5 (plan v7, PR #704) built it and measured it unsafe; the atomicity half is the only part of ruling K that did not land. This record states the ceiling so it is a decision, not an accident. Root ruled it under the owner's standing grant (plan v8 batch 2, 2026-09-15); the owner accepts or vetoes.

### Measurements (lane B5, 2026-09-09, comments on `6f1x`)

- **Transactional hook, `e.app` reassigned to the transaction handle.** Single-threaded it rolled back correctly. Under 8 concurrent trashes (8 workspaces, 1500 notifications each) the committed state contradicted the response both ways: `204 x4, 400 x3, 500 x1`, three 204s with the cascade never run, two 400s trashed and fully cascaded. It also broke unrelated traffic: 20 concurrent task creates in an untouched workspace went `17 200 / 2 400 / 1 500` with `sql: transaction has already been committed or rolled back`. Base was `204 x8` and `20 200`. Mechanism: the event's app binding is shared across in-flight requests in the pooled JSVM, so the reassignment escapes its request (`.agents/rules/pocketbase.md`).
- **`onRecordUpdateExecute` without the reassignment.** No rollback at all once re-measured in a clean room.
- **Cleanup on the update tier, no transaction.** Holds the write path for the whole cascade: `{500: 3, 204: 3, 200: 2}`, 8 contradictions.
- **Shipped: `onRecordAfterUpdateSuccess`.** `{204:8}` with 0 contradictions on two of three samples and `{500:1, 204:7}` with 0 contradictions on the third; unrelated creates 20/20 every time. Parity with base on committed state.

### Decision

1. **The cleanup is not atomic with the trash; this is the accepted ceiling.** It runs once, after the write, for every writer (request, programmatic save, cron, superuser). A cleanup that fails part-way leaves the workspace trashed with some notifications already dropped; the failure is logged and the trash stands. `tests/test_workspace_trash.py` section (10b) pins that behaviour.
2. **The remedy is an eventual sweep, not a transaction.** If a half-finished cleanup is ever observed, a purge-time sweep that drops notifications pointing into a trashed workspace (the same shape the project purge already uses for rows whose project is gone, `pb_hooks/trash.pb.js`) closes it. It is not built now: no half-finished cleanup has been observed outside a forced failure. A PocketBase-level mechanism that pulls the request write into a transaction without mutating a shared event would supersede this record.
3. **A non-owner active admin trashing the owner's last live workspace reprovisions a workspace in the owner's account: accepted and documented.** The workspace update rule lets the owner or an active admin trash it, and the reprovision fires on the write, not on who wrote it. That is the app's own invariant firing (every user keeps a live workspace to land in), not an action taken on the admin's authority: the admin gains nothing in the new workspace and cannot reach it. The invariant itself is the design question, and it stays as built.

### Prior art

- **Linear**, workspace deletion (`linear.app/docs/workspaces`, read 2026-09-15): "Workspace owners can start the deletion process, and admins may also be able to depending on workspace restrictions." Deletion is scheduled 48 hours out, "all admins are notified by email", and "Any admin can cancel during the 48-hour window". So an admin other than the owner can remove the workspace the owner lands in.
- **Linear**, a user left with no workspace is pointed to **Create or join a workspace** from the workspace switcher (same docs). Linear lands that user in onboarding; this app instead provisions a fresh workspace so the user never sees an empty app. Both treat "user without a workspace" as a state the product must answer, independent of who removed the last one, which is why decision point 3 keeps the reprovision unconditional on the writer.
- Atomicity has no product prior art to borrow: it is a platform constraint of the pooled JSVM.

### Where it is pinned

`pb_hooks/trash.pb.js` (the `onRecordAfterUpdateSuccess` workspaces hook and its comment), `tests/test_workspace_trash.py` (10b), `.agents/rules/pocketbase.md` (the `e.app = txApp` hazard), the app_docs record `decision:workspace-trash-cleanup-not-atomic`.

### Accepted summary

ACCEPTED as decision-061 (owner sign-off 2026-09-16, card 6ytp; proposed by root under the standing grant 2026-09-15, card 6f1x). THE CLEANUP IS NOT ATOMIC WITH THE TRASH. When a workspace is trashed, dropping the notifications about work inside it and provisioning a replacement for an owner left with no live workspace run once, after the trash is written, for every writer: a request, a programmatic save, a scheduled job or a superuser. A cleanup that fails part way leaves the workspace trashed with some notifications already dropped; the failure is logged and the trash stands. WHY NOT A TRANSACTION (measured by lane B5, 2026-09-09). Pulling the request write into a transaction needs the shared event to carry the transaction, and in the pooled script runtime that escapes its request: under 8 concurrent trashes the committed state contradicted the response both ways, and 20 unrelated concurrent task creates failed 3 times. Running the cleanup on the write path instead held that path and turned concurrent trashes into failures. Running it after the write matched the prior behaviour on committed state. THE REMEDY IS AN EVENTUAL SWEEP. If a half finished cleanup is ever observed, a purge time sweep that drops notifications pointing into a trashed workspace closes it, the same shape the project purge already uses for rows whose project is gone. A platform mechanism that makes the request write transactional without sharing the event would supersede this record. AN ADMIN TRASHING THE OWNER LAST WORKSPACE STILL REPROVISIONS IT. An active admin may trash the workspace, and when it was the last live workspace its owner has, the owner gets a fresh workspace, membership and project. That is the app invariant that every user keeps a live workspace to land in, not an action on the admin authority: the admin is not a member of the new workspace and gains nothing. PRIOR ART: Linear lets admins as well as owners delete a workspace, depending on workspace restrictions, and points a user left with no workspace to create or join one, so the product answers a user without a workspace regardless of who removed the last one.

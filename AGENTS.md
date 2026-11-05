# task-manager

PocketBase task-tracker (course complete; now the base for a backend v1 build-out +
frontend rebuild). **The kata board (project `task-manager`, bound by `.kata.toml`) is the
single authoritative task system.** In a main session, read the board's `HANDOFF` issue
first (`kata show 91s4 --render`) — it routes current in-flight state and next actions; the
remaining-work plan and owner queue live on `czfw`. No `_meta/`, no `backlog/`, and no in-repo handoff file:
delivery planning lives on the board, pre-backlog history in git history. The board moved from
Kaneo on 2026-09-02; a historical `PBTT-NNN` reference resolves with
`kata list --status all --meta kaneo_task_number=NNN`.

Detail law lives next door. Nothing below auto-loads for non-Claude agents (and the
memory index loads for no agent) — read the file before touching what it governs:

- `.agents/rules/pocketbase.md` — PB gotchas + test-suite house style (pb_hooks/, pb_migrations/, API rules, tests/)
- `.agents/rules/ports.md` — port bands, `PB_PORT_OFFSET`, legacy-suite solo recipe (anything that binds a port)
- `.agents/rules/bun.md` — Bun commands plus npm/Node compatibility boundary (web/, package scripts, Makefile, CI, Docker)
- `.agents/context/kata-board.md` — DoD text, board vocabulary, state model, artifacts, owner rulings (any board write)
- `.agents/context/deploy.md` — Railway topology (session-owned)
- `.agents/memory/MEMORY.md` — project memory index (owner rulings, burns, gotchas); one line per fact file, follow the link before relying on it

Shared agent material lives in `.agents/`; native paths link to it. Agent definitions
use `.agents/agents/claude/` (Markdown) and `.agents/agents/codex/` (TOML), with matching
instruction bodies checked by `tests/test_agent_layout.ts`. See `.agents/README.md`.

## Frontend design preparation

Preserve the entire existing `web/` frontend. Build any future frontend in a separate
top-level sibling; establish its agent ownership, DoD/CI and browser/build gates before
claiming coverage. Today's frontend roles and gates cover `web/` only.

Design requirements, Impeccable context and editable visuals live in the separate local
OpenSpec Store `task-manager-design`; `openspec/config.yaml` is only its pointer. Resolve
it with `openspec context`. Do not create local specs/changes or duplicate canonical
design documents in this application repo. Resolve Impeccable's absolute skill base from
the current skill catalog, then run
`<skill-base>/scripts/impeccable context --target <resolved-store-root>` from this checkout
to load that authoritative context; use a brief path there for a named surface. There is
no project-local launcher. The living process is Kata `dg70`; setup evidence and reusable
lessons are on `wxm8` (baseline readiness: `1gne`). Kata remains
the sole execution task/status ledger and owner-acceptance record; acceptance and delivery
tasks cite exact design revisions and requirement IDs. Artifact completion is not approval.

Impeccable is the primary UX/design workflow; use Operate mode for application surfaces.
Its creative guidance and Ponytail minimalism remain subject to product truth, Carbon
core/IBM Products contracts, accessibility and project gates. Atelier owns orchestration
and independent review; repository root-only Git rules override generic worker-commit
guidance. Load required skills explicitly in execution briefs. Use Browser for visual
inspection and the CLI test harnesses for repeatable acceptance. Shape Up is optional
shaping guidance, not another tracker; Mobbin and image generation are not prerequisites.

## Commands

```bash
make dev                                    # one command: web http://127.0.0.1:3000 + PB http://127.0.0.1:8090, seeds a fresh DB (`make` lists all targets; `make otp` = dashboard OTP)
make dod                                    # the Definition of Done as code — runs the gates your touched paths require (`make dod ARGS=-n` plans; SCOPE=backend,frontend,e2e,image,docs,ci,compose forces)
make dod-strict                             # dod for piped/redirected callers — re-checks .dod-exit + fails on any ❌ glyph
make next-migration-slot                    # next free migration timestamp — collision-free slots for parallel agents
./pocketbase serve --http=127.0.0.1:8090   # dev server (dashboard: /_/)
bun scripts/seed.ts                     # sample data (alice@/bob@example.com, test123456)
bash scripts/run_suite_battery.sh           # WHOLE battery (all suites + app_docs) — what CI runs, in four shards; a new run_suite label needs a scripts/battery_shards.tsv row
bun tests/test_rules.ts                 # one suite, targeted (any tests/test_*.ts runs solo)
bun scripts/gen_openapi.ts --check      # openapi.json drift gate (also: gen_schema.ts, gen_decisions.ts, check_app_docs.ts; regen: drop --check)
```

**Gate law:** never chain another command after a gate (`gate | tee`, `gate; tail` — you
read the LAST command's status, not the gate's). Run the gate alone and check `$?`; a
piped caller reads `.dod-exit` or uses `make dod-strict`. Under `-n` neither discriminates:
every plan leaves `.dod-exit` at 1, so the `❌` line is the only refusal signal.

## Clean-room law (every test/probe boots its own server)

Dev 8090 is off-limits to tests. Boot a room: `./pocketbase serve --http=127.0.0.1:<port>
--dir <scratch>/pb_data --migrationsDir <COPY of pb_migrations> --hooksDir <COPY of
pb_hooks>` — ALWAYS scratch COPIES of both (rooms auto-write migrations into their
migrationsDir; PB watches its hooksDir, and macOS FSEvents re-delivers a stale edit from
any other process as a mid-run restart — suites get the copy via `tests/roomkit.ts`'s
`hooks_dir(scratch)`). For plain superuser API auth, delete `*superuser_mfa.js` from the
MIGRATIONS copy — it is a migration, not a hook, so deleting it from the hooks copy is a
no-op and you keep hitting MFA. Superuser in a room: `./pocketbase superuser upsert probe@example.com probe123456
--dir <that pb_data>`. Never hand-pick a port — use your band's default plus
`PB_PORT_OFFSET` (≥100; two concurrent consumers ≥200 apart). **A collision is SILENT**:
a suite treats any healthy server on its port as its own and passes green against a
stranger's database. Bands + recipes: `.agents/rules/ports.md`.

## Migration + schema laws

- `pb_migrations/` is the source of truth; `schema/` is GENERATED from it by
  `scripts/gen_schema.ts` (PB never reads it) — never hand-edit, regen in the same
  change; `--check` drift-gated in dod/battery/pre-commit like `openapi.json`.
- Never edit historical migrations (a PreToolUse hook blocks edits to any migration
  already on origin/main). New files only; timestamps monotonic, current band
  `1785180500+` step 100, **stay below `1785200000`** (battery scratch band);
  `make next-migration-slot` prints the next free slot.
- **A false statement gets corrected where a reader lands on it — every artifact has exactly
  one path.** Generated file ⇒ fix the source and regenerate. Historical migration's *comment*
  ⇒ `Edit` it, comment lines only on both sides (the hook allows that and refuses a mixed or
  whole-file change). Historical migration's *behaviour* ⇒ never edited, it already ran;
  supersede it with a new migration naming the one it corrects. Commit message already pushed
  to a shared branch ⇒ never corrected by rewriting history; the correction goes in the PR
  body, and in the card's closing comment when it has one. PR #768: the commit says an
  undeclared `attrs` key is "refused 400 validation_failed, naming every offending key"; the
  PR body records that when a milestone sends `status` too, "the more specific status refusal
  wins and names only the status". **If a falsehood has no path, that is a bug in this law —
  file it rather than leaving the falsehood.**
- Add/change a collection ⇒ SAME change carries: its `app_docs` record (data-seed
  migration), `schema/` regen, `openapi.json` regen, model tree regen. CI enforces.
- Secret-bearing settings (smtp/oauth/backups S3) ride env boot hooks, NEVER
  migrations — a migration re-asserting them clobbers the hook on fresh boot.
- Backfills are historical only — every DB (dev, rooms, prod, staging) boots fresh
  from the current set.

## Agent conduct

- For substantial implementation or cleanup, load `atelier:delegation` and use
  manager teams with scoped builders and independent reviewers. Root owns strategy,
  integration, board lifecycle and final gates. Reserve child slots before launching
  managers; report dispatch failures instead of silently taking over their work.
- Workers/leads: read-only git (`status/diff/log/show`). Commits, pushes, merges,
  tags = the main session only.
- The main checkout is a landing station, locked read-only by `scripts/land.sh --lock`
  (immutable flags; the `no_agent_writes_on_main` hook names the rule): change files in a
  worktree, land by PR, then `make land` in main (bare `git pull` there fails closed).
- After every PR merge, review `docs/readouts/features.yml` against what the PR actually shipped
  and flip the rows it moved (the `--check` coupling gate only catches rows citing a
  delivered card, not new or uncited ones); then regen every rendering it feeds, because each
  one is separately `--check`-gated and a missed one blocks the next commit:
  `bun scripts/gen_feature_register.ts` (the register) and
  `bun scripts/gen_status.ts` (the status page: status map, row table with closure
  plan, and release readout).
- Own only the files your brief names; report — don't touch — everything else. The one
  exception is an incidental REPAIR your own change breaks or reveals — a stale assertion,
  a moved selector, a renamed label, formatter drift: fix it, disclose it in the report,
  and say how to revert. Verify the premise before repairing; new behaviour and anything
  needing a decision your brief cannot settle still gets reported, not touched
  (owner ruling 2026-09-08, `.agents/memory/feedback-incidental-fixes-allowed.md`).
- Evidence = command + actual output, never claims. Bounded coverage must be declared.
- `.claude/operations/NOTES.md` is Henry's personal file — never edit, commit, or delete.
- Secrets/live URLs live in `.claude/operations/` (untracked) — never in docs or git.
- Comments state only a constraint the code cannot show — one line, at the site it
  governs; file header = one line of purpose; `KEEP IN SYNC:` markers are load-bearing.
  Never write a count into a comment ("18 suites") — it rots into a lie. Prefer the
  decision record or the collection and field over a migration filename; a filename you
  do name is versioned (`v1:`/`v2:`), never bare.
- UI copy describes user-facing behavior/benefit ONLY — never the mechanism (attribute
  names, "hydration", hook/cron/endpoint names, HTML tags). Translate design-doc
  phrasing into plain user language; never paste it as the rendered string.
- Product/UX design questions: look to prior art first (functionally this app converges
  on **Linear**) — cite the tool's behaviour in the decision record, then still make the
  call explicitly (owner ruling 2026-08-08, worked example decision-021).

<CRITICAL_INSTRUCTION>

## Kata Workflow

This project's execution tasks, acceptance decisions and process docs live on the kata board;
frontend design artifacts use the separate Store described above. No
`backlog.md` / `TODO.md` / task file gets written in their place. **Before acting on any
user request here, run `kata quickstart`** — it carries the ref model (short ids, never
numbers), the search-before-create rule, the close contract (evidence + substantive
message, never a batch), and the claim/attention protocol; the kata-custody plugin's
kata-workflow skill is its work-attention contract. Level model: the root session claims, closes
and edits; managers comment and create; workers hold no board tools.

Repo deltas over kata's generic guidance:

- **Every task body carries `## Acceptance Criteria` and `## Definition of Done`**
  (default four items: `.agents/context/kata-board.md`). Without them it is a
  draft, not ready to start.
- **State model:** an open, unowned issue is the backlog (`to-do`). **File new work
  there.** `up-next` is a label for a short lane of already-re-validated next work, not a
  second backlog; claiming (`kata claim`) is `in-progress`; `in-review` is a label; a
  real prerequisite is a `--blocked-by` link, a soft block is the `blocked` label — and
  either way the issue carries a comment naming what would unblock it. Closing is `done`
  and asserts verified completion. There is no planned state. Reference material carries
  the `doc` label and stays open only while consulted (a sign-off record closes once its
  rulings are executed); decision records carry `decision` and close on
  acceptance — immutable from then on: changing course is a NEW decision that supersedes
  the old via `--related`, never an edit or a reopen (PBTT-336). Neither is work.
- **`make dod` IS the DoD gate** — "DoD met" is a command result, never a claim.
- **File follow-up work immediately** as a board task referencing the discovering
  task/PR (a `draft` card when unscoped). Filing needs no approval; starting does. **But a
  finding folds before it fans out** (decision-057): fix every site of the shape you are
  fixing; a small out-of-scope patch goes in your report for root to land; a gate gap or a
  flake is a line on the wave's one hardening card or the suite's one flake ledger; a draft
  attaches to an open card. One card per unit of work, never per finding.
- **Re-validate a stale task's premise before starting**: run the command that would
  falsify it against the CURRENT tree and quote the output; if falsified, the deviation
  is the deliverable (full ruling: `.agents/memory/feedback-revalidate-task-premise.md`).
  **A wave launches only after every card in it has been re-validated this way**, verdict
  commented on each card, falsified cards out of the wave before any brief is written.

</CRITICAL_INSTRUCTION>

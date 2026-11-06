# task-manager-backend

PocketBase task-tracker backend. **The kata board (project `task-manager-backend`, bound by
`.kata.toml`) is the single authoritative task system.** In a main session, read its
`handoff`-labelled card first (`kata list --label handoff`); there is no in-repo handoff file.

Detail law lives next door; none of it auto-loads for every agent — read the file before touching what it governs:

- `.agents/rules/pocketbase.md` — this repo's PB gotchas + test-suite house style (pb_hooks/, pb_migrations/, API rules, tests/)
- `.agents/rules/ports.md` — port bands, `PB_PORT_OFFSET`, legacy-suite solo recipe (anything that binds a port)
- `.agents/context/deploy.md` — Railway topology (session-owned)
- `.agents/memory/MEMORY.md` — project memory index (owner rulings, burns, gotchas); one line per fact file, follow the link before relying on it

Shared agent material lives in `.agents/`; native paths link to it (`.agents/README.md`).

## Commands

```bash
make setup                                  # install pinned runtimes + deps, activate the pre-commit hook (once per clone)
make dev                                    # PocketBase http://127.0.0.1:8090, seeds a fresh DB (`make` lists all targets; `make otp` = dashboard OTP)
make check                                  # THE gate: check-static, then the whole suite battery — what CI runs, sharded
make check-static                           # its server-free half: format, typecheck, every gen_*.ts --check, every check_*.ts
make next-migration-slot                    # next free migration timestamp — collision-free slots for parallel agents
bun scripts/seed.ts                         # sample data (alice@/bob@example.com, test123456)
bun tests/test_rules.ts                     # one suite, targeted (any tests/test_*.ts runs solo); a new run_suite label needs a scripts/battery_shards.tsv row
bun scripts/gen_openapi.ts --check          # openapi.json drift gate (also: gen_schema.ts, gen_decisions.ts, check_app_docs.ts; regen: drop --check)
```

**Gate law:** run a gate alone and check `$?`; never chain after it (`gate | tee`, `gate; tail` read the LAST command's status).

## Clean-room law (every test/probe boots its own server)

Dev 8090 is off-limits to tests. Boot a room: `./pocketbase serve --http=127.0.0.1:<port> --dir
<scratch>/pb_data --migrationsDir <COPY of pb_migrations> --hooksDir <COPY of pb_hooks>` — ALWAYS
scratch COPIES of both (rooms auto-write migrations into their migrationsDir; PB watches its
hooksDir, and macOS FSEvents re-delivers a stale edit from any other process as a mid-run restart —
suites get the copy via `tests/roomkit.ts`'s `hooks_dir(scratch)`). For plain superuser API auth,
delete `*superuser_mfa.js` from the MIGRATIONS copy (it is a migration, not a hook). Superuser in a
room: `./pocketbase superuser upsert probe@example.com probe123456 --dir <that pb_data>`. Never
hand-pick a port — use your band's default plus `PB_PORT_OFFSET` (≥100; two concurrent consumers
≥200 apart). **A collision is SILENT**: a suite treats any healthy server on its port as its own and
passes green against a stranger's database. Bands + recipes: `.agents/rules/ports.md`.

## Migration + schema laws

- `pb_migrations/` is the source of truth; `schema/` is GENERATED from it by
  `scripts/gen_schema.ts` (PB never reads it) — never hand-edit, regen in the same
  change; `--check` drift-gated in `make check` and pre-commit like `openapi.json`.
- Never edit historical migrations (a PreToolUse hook blocks edits to any migration
  already on origin/main). New files only; timestamps monotonic, step 100, starting after
  the baseline (`make next-migration-slot` prints the next free slot), **stay below
  `1785200000`** (battery scratch band).
- **A false statement gets corrected where a reader lands on it — every artifact has exactly one
  path.** Generated file ⇒ fix the source and regenerate. Historical migration's *comment* ⇒ `Edit`
  it, comment lines only on both sides (the hook refuses a mixed or whole-file change). Historical
  migration's *behaviour* ⇒ never edited; supersede it with a new migration naming the one it
  corrects. Pushed commit message ⇒ never rewritten; the correction goes in the PR body and the
  card's closing comment. **A falsehood with no path is a bug in this law — file it.**
- Add/change a collection ⇒ SAME change carries: its `app_docs` record (data-seed
  migration), `schema/` regen, `openapi.json` regen, model tree regen. CI enforces.
- Secret-bearing settings (smtp/oauth/backups S3) ride env boot hooks, NEVER
  migrations — a migration re-asserting them clobbers the hook on fresh boot.
- Backfills are historical only — every DB (dev, rooms, prod) boots fresh from the current set; a migration never repairs rows (decision:every-database-boots-from-the-migration-set).

## Agent conduct

- For substantial implementation or cleanup, load `atelier:delegation` and use manager teams
  with scoped builders and independent reviewers. Root owns strategy, integration, board
  lifecycle and final gates. Reserve child slots before launching managers; report dispatch
  failures instead of silently taking over their work.
- Workers/leads: read-only git (`status/diff/log/show`). Commits, pushes, merges, tags = the main
  session only. Change files in a worktree and land by PR.
- Own only the files your brief names; report — don't touch — everything else. The one exception
  is an incidental REPAIR your own change breaks or reveals (a stale assertion, formatter drift):
  fix it, disclose it, and say how to revert. New behaviour and anything needing a decision your
  brief cannot settle still gets reported, not touched (owner ruling 2026-09-08).
- Evidence = command + actual output, never claims. Bounded coverage must be declared.
- `.claude/operations/` is untracked: secrets and live URLs live there, never in docs or git;
  its `NOTES.md` is Henry's personal file — never edit, commit, or delete.
- Comments state only a constraint the code cannot show — one line, at the site it governs;
  file header = one line of purpose; `KEEP IN SYNC:` markers are load-bearing. Never write a count
  into a comment ("18 suites") — it rots into a lie. Prefer the decision record or the collection
  and field over a migration filename; a filename you do name is versioned (`v1:`/`v2:`).
- User-facing copy (hook refusal/validation messages, mail text a client shows) describes behaviour, never mechanism.
- Product/API design questions: look to prior art first (functionally this app converges on
  **Linear**) — cite the tool's behaviour in the decision record, then still make the call
  explicitly (owner ruling 2026-08-08).

<CRITICAL_INSTRUCTION>

## Kata Workflow

Execution tasks, acceptance decisions and process docs live on the board; no `backlog.md` /
`TODO.md` / task file is written in their place. **Before acting on any user request here, run
`kata quickstart`**; the kata-custody plugin's kata-workflow skill is its work-attention contract.
Root claims, closes and edits; managers comment and create; workers hold no board tools. Repo deltas:

- **Every card body carries `## Acceptance Criteria` and `## Definition of Done`.** Without them
  it is a draft, not ready to start. "DoD met" is a `make check` result, never a claim.
- Decision records carry `decision`, close on acceptance and are immutable from then on: changing course is a NEW decision superseding the old via `--related`, never an edit or reopen.
- **File follow-up work immediately** as a board card referencing the discovering card/PR (a
  `draft` card when unscoped). Filing needs no approval; starting does. **But a finding folds
  before it fans out**: fix every site of the shape you are fixing; a small
  out-of-scope patch goes in your report for root to land. One card per unit of work.
- **Re-validate a stale card's premise before starting**: run the command that would falsify it
  against the CURRENT tree and quote the output; if falsified, the deviation is the deliverable.
  A wave launches only after every card in it is re-validated, verdict commented on each card.

</CRITICAL_INSTRUCTION>

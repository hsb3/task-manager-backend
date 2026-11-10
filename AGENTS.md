# task-manager-backend

PocketBase task-tracker backend: the laws every change obeys. Detail lives in the rule file for
the paths you touch.

**Terms.** **root** = the main session: it owns strategy, integration, the board lifecycle, every
commit, push, merge and tag, and the final gates. A **manager** leads one lane; a **worker**
(builder, reviewer) carries out one brief in a worktree. A **card** is a kata board item; a
**decision record** is a card labelled `decision`. A **gate** is a command whose exit status is the verdict.

## Where things live

- **The kata board is the single authoritative task system** (project `task-manager-backend`, bound
  by `.kata.toml`). A main session reads its handoff card first (`kata list --label handoff`); there
  is no in-repo handoff file.
- Designs live in OpenSpec (`openspec/`, schema `contract-first`, `docs/openspec.md`): a card names its
  change with `--meta change=<id>`, a change never lists cards; `make change ID=<id>` resolves one.
- Rule files (Claude Code loads each when you touch its `paths:`; other harnesses read it first):
  `.agents/rules/pocketbase.md` PB gotchas + test-suite house style · `.agents/rules/ports.md` port
  bands, `PB_PORT_OFFSET`, `PB_BIN`, legacy-suite recipe · `.agents/rules/deploy.md` Railway.
- `.agents/memory/MEMORY.md` indexes project memory (owner rulings, burns, gotchas). It is not
  auto-loaded; follow the link before relying on a fact.
- `.env` (gitignored; `make env` writes one with a fictitious superuser) is read by the Makefile,
  `scripts/seed.ts` and the suites needing `PB_*` vars. Templates: `.env.example` (deployment
  variables), `.env.local.example` (local testing knobs you export yourself).
- Secrets and live URLs live only in `.claude/operations/` (gitignored), never in docs or git.
  `NOTES.md` at the repo root and `.claude/operations/NOTES.md` are Henry's personal files: never
  edit, commit or delete either.

## Commands

```bash
make setup                         # pinned runtimes, deps, pre-commit hook; scripts/verification-env.sh checks them
make dev                           # PocketBase on 8090 + seed; ignores PB_PORT_OFFSET: use `make dev PB_PORT=<n>`
make                               # lists the documented targets (`make otp` = dashboard OTP)
make check                         # THE gate: check-static, then the battery (every suite; CI runs it sharded)
make check-static                  # server-free half: format, typecheck, gen_*.ts --check, check_*.ts
make smoke                         # live probes against the production Docker image (e2e/smoke.ts); needs Docker
make next-migration-slot           # next free migration timestamp
bun tests/test_labels.ts           # one self-booting suite; a legacy suite needs a room (ports.md)
bun scripts/gen_openapi.ts --check # drift gate (also gen_schema, gen_decisions); drop --check to regen
bun scripts/check_app_docs.ts      # checker, no --check: every collection has its app_docs record
```

- **Gate law:** run a gate alone and check `$?`; never chain after it (`gate | tee` and
  `gate; tail` report the LAST command's status).
- `make -n dev` is not a dry run: its recipe calls `$(MAKE)`, so it boots a real server.

## Clean-room law

Every test and probe boots its own **room** (a throwaway PocketBase server); the dev server is
off-limits to tests. A room ALWAYS serves scratch COPIES of `pb_migrations` and `pb_hooks` (`serve
--dir <scratch>/pb_data --migrationsDir <copy> --hooksDir <copy>`): rooms auto-write migrations into
their migrationsDir, and PB watches its hooksDir, where macOS FSEvents re-delivers another process's
stale edit as a mid-run restart (suites get the copy from `tests/roomkit.ts`'s `hooks_dir`). For
plain superuser API auth, delete `*superuser_mfa.js` from the migrations copy (a migration, not a
hook). Before `serve`, run `./pocketbase superuser upsert probe@example.com probe123456 --dir
<scratch>/pb_data --migrationsDir <copy>` (`scripts/check_superuser_before_serve.ts` gates the
order). Never hand-pick a port: use your **band**'s default port plus `PB_PORT_OFFSET` (100 or more;
concurrent consumers at least 200 apart). **A collision is SILENT**: a suite treats any healthy
server on its port as its own and passes green against a stranger's database.

## Migration + schema laws

- `pb_migrations/` is the source of truth. `schema/` is generated from it by
  `scripts/gen_schema.ts` (PB never reads it): never hand-edit it, regenerate in the same change.
- Never edit a **historical migration** (one already on `origin/main`; a PreToolUse hook and the
  pre-commit hook refuse it). New files only, timestamp from `make next-migration-slot` (step 100,
  below the battery's `1785200000` scratch band).
- **A false statement gets corrected where a reader lands on it; every artifact has exactly one
  path.** Generated file: fix the source and regenerate. Historical migration's *comment*: `Edit`
  it, comment lines only on both sides (the hook refuses a mixed or whole-file change). Historical
  migration's *behaviour*: never edited; a new migration supersedes it and names it. Pushed commit
  message: never rewritten; the correction goes in the PR body and the card's closing comment.
  **A falsehood with no path is a bug in this law: file it.**
- A collection add/change carries, in the SAME change: its `app_docs` record (data-seed
  migration) and the `schema/`, `openapi.json` and `scripts/model/` regens (check-static enforces).
- Secret-bearing settings (smtp, oauth, backups S3) ride env boot hooks, NEVER migrations: a
  migration re-asserting them clobbers the hook on a fresh boot.
- Backfills are historical only: every database (dev, rooms, prod) boots fresh from the current set;
  a migration never repairs rows (decision:every-database-boots-from-the-migration-set).

## Agent conduct

- Substantial work: load `atelier:delegation`; run manager teams with scoped builders and
  independent reviewers. Reserve child slots first; report a dispatch failure, never absorb it.
- Managers and workers: read-only git (`git status/diff/log/show`), edits in a worktree, root lands by PR.
- Own only the files your brief names; report everything else. The one exception is an incidental
  REPAIR your own change breaks or reveals (a stale assertion, formatter drift): fix it, disclose
  it, say how to revert it. New behaviour, or anything needing a decision your brief cannot
  settle, is reported, not touched (owner ruling 2026-09-08).
- Evidence is a command plus its actual output, never a claim. Declare bounded coverage.
- A behaviour change is probed against the production image with `make smoke` (a probe function in
  `e2e/smoke.ts`) before it is reported done, never against production.
- Comments state only a constraint the code cannot show, in one line at its site; a file header is
  one line of purpose; `KEEP IN SYNC:` markers are load-bearing; never a count (it rots). Cite a
  decision record or collection and field over a migration filename, and version one (`v1:`/`v2:`).
- User-facing copy (hook refusals, validation messages, client-visible mail) describes behaviour,
  never mechanism.
- Product/API design: prior art first (this app converges on **Linear**); cite its behaviour in
  the decision record, then still make the call explicitly (owner ruling 2026-08-08).

<CRITICAL_INSTRUCTION>

## Kata Workflow

Execution tasks, acceptance decisions and process docs live on the board; no `backlog.md`,
`TODO.md` or other task file stands in for it. **Before acting on any user request here, run
`kata quickstart`**; the kata-custody plugin's kata-workflow skill is its work-attention contract.
Root claims, closes and edits; managers comment and create; workers hold no board tools. Repo deltas:

- **Every card body carries `## Acceptance Criteria` and `## Definition of Done`.** Without them
  it is a draft, not ready to start. "DoD met" is a `make check` result, never a claim.
- A decision record closes on acceptance and is immutable from then on: changing course is a NEW
  decision superseding the old via `--related`, never an edit or a reopen.
- **File follow-up work immediately** as a card referencing the discovering card or PR (a `draft`
  card when unscoped). Filing needs no approval; starting does. **But a finding folds before it
  fans out**: fix every site of the shape you are fixing; a small out-of-scope patch goes in your
  report for root to land. One card per unit of work.
- **Re-validate a stale card's premise before starting**: run the command that would falsify it
  against the CURRENT tree and quote the output; if it is falsified, the deviation is the
  deliverable. A wave launches only after every card in it is re-validated, with the verdict
  commented on each card.

</CRITICAL_INSTRUCTION>

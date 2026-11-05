---
name: fresh-worktree-lacks-gitignored-files
description: "[unconfirmed: fork-point half] A new worktree has no .env or ./pocketbase because both are gitignored; copy .env in. Worktrees were observed to fork from the last PUSHED commit, not local main"
metadata:
  type: project
---

`.env` and `/pocketbase` are gitignored (`git check-ignore -v .env pocketbase` → `.gitignore:2`,
`.gitignore:6`), so a fresh worktree has neither. `scripts/seed.ts` reads `PB_*` from `.env`
(`load_env`), so copy it in with `command cp`; for the binary use `PB_BIN`
(`.agents/rules/ports.md`).

**[unconfirmed]** Worktrees were recorded as forking from the last PUSHED commit rather than local
`main`. Not re-verified 2026-10-24: this agent worktree, local `main` and `origin/main` all sat on
the same commit, so the claim could not be told apart. Check `git rev-parse HEAD main origin/main`
in a new worktree before relying on either.

**How to apply:** after creating a worktree, copy `.env`, set `PB_BIN`, and confirm the base
commit is the one you meant. Moving local main: [[main-checkout-locked]].

---
# This repo's handoff is not a file. It is kata issue 91s4 (`handoff` label, project
# task-manager). External mode means atelier's freshness hooks stat `stamp` instead of
# searching for a HANDOFF.md that deliberately does not exist here.
handoff:
  mode: external
  stamp: .agents/handoff.stamp
  location: kata issue 91s4 (project task-manager, label handoff) — `kata show 91s4 --render`

# A lane MANAGER gets its own git worktree; the builders it dispatches write inside that
# worktree under the manager's file-ownership map (one file, one owner). Isolating builders
# too nests a worktree per builder and the manager has to import their files by hand
# (measured 2026-09-06, wave 1: three of four builders could not write into the lane tree).
# A builder dispatched straight from the root session still needs isolation — dispatch a
# manager, or pass `isolation: worktree` on that call explicitly.
isolate: [manager, general-purpose]
---

`/handoff` rewrites 91s4's body (`kata edit 91s4 --body "$(cat …)"` — a whole-body
replace), then touches `.agents/handoff.stamp`. **Board first, stamp last** — the guard
reads the stamp's age, never the board's content, so touching it early certifies a handoff
that has not happened yet.

91s4 is the handoff (Kaneo PBTT-261 before 2026-09-02). 5t7t (PBTT-243) is an older mirror
issue that still names a deleted in-repo file as the source of truth; do not follow it.

In a wave lane worktree, the handoff is the lane's own kata card nested under 91s4 (labels
`doc` + `handoff`, `work.branch` set to the lane branch — `kata list --label handoff --meta
work.branch=<branch>` finds it), never 91s4 itself, and the per-worktree
`.agents/handoff.stamp` is that card's freshness signal, not 91s4's.

This file is tracked on purpose: it is project policy, not machine state, and it has to
survive a fresh clone or a move to another machine. The stamp is gitignored, because an
mtime is exactly the thing that should not travel. A fresh clone therefore has no stamp,
and the first manual `/compact` is refused until `/handoff` runs — the intended answer,
not a bug.

The `isolate` list rewrites every dispatch it names to carry `isolation: "worktree"`, so
two writers in one wave never share an index. The hook strips a plugin prefix before
matching (`atelier:builder` counts as `builder`) but does no other fuzzy matching, so a
repo-local agent has to be spelled out or it silently stays in this checkout — that is why
the alias `writers` is not used here. `pb-reviewer`, `scout`, `reviewer`, `Explore`,
`Plan`, `fork`, and this repo's verifier agents (`clean-room-test-runner`,
`frontend-contract-auditor`, `frontend-quality-verifier`,
`pb-security-auditor`) stay in this checkout on purpose: a worktree is a clean
checkout of a ref, so the session's uncommitted work does not exist inside it, and a
reviewer sent there would re-derive its claims from a different tree.

**A worktree is not a commit guard.** It shares this repo's `.git` and its remote, so a
worker whose HEAD is on `main` commits to the real `main`. The repo law that commits,
pushes, merges and tags belong to the main session is enforced by
`.claude/hooks/no_agent_writes_on_main/hook.ts` — `PreToolUse` on `Bash`, subagents only,
denying `commit`/`merge`/`rebase`/`cherry-pick`/`revert`/`am` while HEAD is `main`, and any
`push` aimed at it. `--no-verify` does not reach it. Self-check: `bun test_hook.ts` in
that directory. Behind it sits the only layer a local process cannot talk its way past:
`main` is covered by repository **rulesets**, not classic branch protection, so
`gh api repos/{owner}/{repo}/branches/main/protection` answers 404 and tells you nothing —
read `gh api repos/{owner}/{repo}/rulesets` instead. A direct push, a force-push and a
branch deletion are all rejected server-side for everyone, admins included.

A worktree of this repo boots without `web/node_modules`, and a symlink to the root's
copy passes tsc/lint/vitest then dies in Turbopack. Hardlink it (`cp -Rl`) and delete
`.cache`: `.agents/memory/worktree-node-modules-hardlink.md`.

`enforce`, `protected`, and `effort` are absent on purpose. Confirm what is live rather
than what is written, from the project root:

    python3 "${CLAUDE_PLUGIN_ROOT}/skills/activation/scripts/activation.py" check

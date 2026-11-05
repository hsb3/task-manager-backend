---
# This repo's handoff is not a file. It is the kata card labelled `handoff` in project
# task-manager-backend. External mode means atelier's freshness hooks stat `stamp` instead of
# searching for a HANDOFF.md that deliberately does not exist here.
handoff:
  mode: external
  stamp: .agents/handoff.stamp
  location: kata project task-manager-backend, label handoff — `kata list --label handoff`

# A lane MANAGER gets its own git worktree; the builders it dispatches write inside that
# worktree under the manager's file-ownership map (one file, one owner). Isolating builders
# too nests a worktree per builder and the manager has to import their files by hand
# (measured 2026-09-06, wave 1: three of four builders could not write into the lane tree).
# A builder dispatched straight from the root session still needs isolation — dispatch a
# manager, or pass `isolation: worktree` on that call explicitly.
isolate: [manager, general-purpose]
---

`/handoff` rewrites the handoff card's body (a whole-body replace), then touches
`.agents/handoff.stamp`. **Board first, stamp last** — the guard reads the stamp's age,
never the board's content, so touching it early certifies a handoff that has not happened yet.

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
`Plan`, `fork`, and this repo's verifier agent `clean-room-test-runner` stay in this
checkout on purpose: a worktree is a clean checkout of a ref, so the session's uncommitted
work does not exist inside it, and a reviewer sent there would re-derive its claims from a
different tree.

`enforce`, `protected`, and `effort` are absent on purpose. Confirm what is live rather
than what is written, from the project root:

    python3 "${CLAUDE_PLUGIN_ROOT}/skills/activation/scripts/activation.py" check

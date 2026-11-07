# Shared agent material

Edit the sources here. Claude Code keeps its native entry points as relative symlinks,
so a checkout carries both.

| Source | Native entry points |
| --- | --- |
| `memory/` | `.claude/memory` |
| `rules/` | `.claude/rules` |
| `agents/claude/` | `.claude/agents` |

Root `AGENTS.md` points at the rules; project memory is indexed in `memory/MEMORY.md`.

Native settings and hook registrations stay in `.claude/` (`settings.json`, `hooks/`),
which remains a real directory. Personal operations and runtime state stay in their
existing ignored locations.

`atelier.local.md` is the sole shared policy, discovered directly by Atelier.
Update the Kata handoff before touching the ignored `handoff.stamp`. A fresh clone
has no stamp until its first handoff update.

## Model tiers

The root strategist reserves Astra/Fable. Project judgment reviewers use Sol/Opus, builders
use Terra/Sonnet, and command-only test/verifier roles use Luna/Haiku. Plugin hooks and
existing project permissions stay enabled; supply the relevant project rules and required
skill paths in each scoped worker brief.

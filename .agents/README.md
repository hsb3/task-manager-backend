# Shared agent material

Edit the sources here. Claude Code and Codex keep their native entry points as
relative symlinks or explicit configuration references, so a checkout carries both.

| Source | Native entry points |
| --- | --- |
| `context/` | `.claude/instructions`, `.codex/context` |
| `memory/` | `.claude/memory`, `.codex/memory` |
| `rules/` | `.claude/rules`, `.codex/rules` |
| `agents/claude/` | `.claude/agents` |
| `agents/codex/` | `agents.<name>.config_file` in `.codex/config.toml` |
| `commands/claude/` | `.claude/commands` |
| `skills/` | `.claude/skills` (Claude-native skills; Codex loads them by path) |
| `scripts/` | `.claude/scripts` |
| `hooks/` | Matching shared hook files under `.claude/hooks` and `.codex/hooks` |

Agent bodies match, while Markdown frontmatter and TOML retain each tool's native
format. `bun tests/test_agent_layout.ts` checks their parity and native references.
Codex uses explicit configuration references because symlinked profiles did not launch
in the native discovery probe. See the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Root `AGENTS.md` directs agents to the applicable context, memory and rules;
directory links alone do not make Codex automatically load scoped rules.

Native settings, hook registrations and protocol adapters stay in `.claude/` and
`.codex/`. These roots and `.codex/agents/` remain real directories; Atelier setup
owns its generated native role files. Personal operations and runtime state stay
in their existing ignored locations.

`atelier.local.md` is the sole shared policy, discovered directly by Atelier.
Update the Kata handoff before touching the ignored `handoff.stamp`. A fresh clone
has no stamp until its first handoff update.

## Model tiers

The root strategist reserves Astra/Fable. Project judgment reviewers use Sol/Opus, builders
and the docs curator use Terra/Sonnet, and command-only test/verifier roles use Luna/Haiku.
Codex profiles declare `model_reasoning_effort` explicitly and omit the automatic skill catalog
and hosted Apps connectors. Plugin hooks and existing project permissions stay enabled; supply
the relevant project rules and required skill paths in each scoped worker brief.

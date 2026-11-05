---
name: scratch-dirs-must-be-unique
description: "PB_PORT_OFFSET separates ports, not scratch directories; a fixed scratch name under a shared temp root lets one agent rm -rf another agent's live rooms"
metadata:
  type: project
---

2026-08-08: a reviewer on one branch `rm -rf`'d a scratch tree it did not own under the shared
temp root of the agent harness in use then, destroying three live PocketBase servers on another
branch mid-run (their `mig`/`hooks` dirs vanished under running processes). It produced a
confidently wrong finding that cost a full re-verification.

**Why:** `PB_PORT_OFFSET` moves ports only. Two agents that agree on a directory NAME collide
silently, the same class as a port collision one layer down.

**How to apply:** every worker makes its scratch with `mktemp -d` (as the recipe in
`.agents/rules/ports.md` does) or a PID-unique path, never a fixed name under a shared temp
root, and deletes only what it created.

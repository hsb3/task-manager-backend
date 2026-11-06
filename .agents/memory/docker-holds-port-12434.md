---
name: docker-holds-port-12434
description: On the owner's Mac, Docker Desktop listens on 127.0.0.1:12434 and ollama on 11434, so PB_PORT_OFFSET=4300 lands test_stale_write (default 8134) on a taken port; lsof the band before assigning a lane offset
metadata:
  type: project
---

Docker Desktop (com.docker) holds 127.0.0.1:12434 and ollama holds 11434 on this machine.
Offset 4300 puts test_stale_write's default port 8134 exactly on 12434; a room boot there fails
or, worse, the suite treats the already-healthy listener as its own server (a collision is
silent, see the clean-room law in AGENTS.md). Found by the registry2 lane 2026-11-06; it ran at
4500 instead.

**Why:** `check_port_collisions` refuses the four well-known database ports and ports inside
the repo; it knows nothing about local apps.

**How to apply:** before handing a lane an offset, run
`lsof -nP -iTCP -sTCP:LISTEN | grep 127.0.0.1:1` and avoid any band whose defaults (8090-8199
plus the offset) hit a listener; 4300 is burned while Docker runs. Related:
[[scratch-dirs-must-be-unique]], [[pkill-by-script-name-kills-other-lanes]].

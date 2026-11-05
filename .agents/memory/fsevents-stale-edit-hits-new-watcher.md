---
name: fsevents-stale-edit-hits-new-watcher
description: "macOS FSEvents re-delivers a stale pb_hooks edit to each NEW watcher, so a freshly booted room can restart just after going healthy; settle, then re-check health, and reproduce only with a separate OS process"
metadata:
  type: project
---

The clean-room law's scratch hooks copy (AGENTS.md) stops another process's edit from restarting
a running suite server. A separate trap remains: FSEvents re-delivers a stale hook edit to each
NEWLY started watcher, so a room booted right after something touched `pb_hooks/` can go healthy
and then restart.

**To reproduce it the toucher must be a SEPARATE OS PROCESS**: a same-process JS timer touching
the file produced zero restarts.

**How to apply:** wherever a probe boots a room right after touching `pb_hooks/`, wait a settle
interval and re-run the health check before trusting the room. Related:
[[battery-hang-surviving-room]].

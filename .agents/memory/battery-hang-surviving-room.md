---
name: battery-hang-surviving-room
description: "The battery can HANG outright when a legacy room's pocketbase serve survives its suite; frozen output plus a lone serve child under run_suite_battery means kill that pid"
metadata:
  type: project
---

A legacy room's server once survived its suite and the battery blocked on it forever.
`stop_room` in `scripts/run_suite_battery.sh` sends a plain `kill` and then `wait`s on the pid,
so a server that outlives the signal stalls the whole run with no output.

The other mid-run restart class (FSEvents re-delivering a stale hook edit) is closed: every room
boots from a scratch COPY of `pb_hooks` (AGENTS.md clean-room law). `test_app_admin_approval`'s
`api()` still absorbs one refused connection; its ⚠ retry line is normal output.

**How to apply:** output frozen + a lone `pocketbase serve` child under `run_suite_battery.sh` =
kill that pid by number (scratch room, safe) and the battery resumes. Never pattern-kill:
[[pkill-by-script-name-kills-other-lanes]].

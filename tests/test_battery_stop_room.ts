#!/usr/bin/env bun
// Battery stop_room escalates to SIGKILL when a child ignores SIGTERM.

import assert from "node:assert/strict";
import path from "node:path";
import { read_text } from "../scripts/_py.ts";

const BATTERY = path.resolve(import.meta.dir, "../scripts/run_suite_battery.sh");
const text = read_text(BATTERY);
const start = text.indexOf("\nstop_room() {");
assert.ok(start >= 0, "stop_room definition moved");
const end = text.indexOf("\n}\n", start);
assert.ok(end > start, "stop_room end boundary moved");
const STOP_ROOM = text.slice(start, end + 3);

const BOUND_MS = 20_000;
const script = `${STOP_ROOM}
bash -c 'trap "" TERM; exec sleep 30' &
pid=$!
sleep 0.3
stop_room "$pid"
if kill -0 "$pid" 2>/dev/null; then echo "child alive"; kill -9 "$pid"; exit 1; fi
echo "child dead"
`;
const t0 = Date.now();
// The timeout makes a hanging stop_room FAIL here instead of stalling the battery.
const r = Bun.spawnSync(["bash", "-c", script], {
  timeout: BOUND_MS + 5000,
  killSignal: "SIGKILL",
});
const elapsed = Date.now() - t0;
const out = r.stdout.toString() + r.stderr.toString();
assert.ok(
  r.exitCode === 0,
  `stop_room did not finish cleanly (exit ${r.exitCode}, ${elapsed}ms): ${out}`,
);
assert.ok(out.includes("child dead"), out);
assert.ok(elapsed < BOUND_MS, `stop_room took ${elapsed}ms`);
console.log(`✅ stop_room escalates to SIGKILL for a TERM-ignoring child (${elapsed}ms)`);

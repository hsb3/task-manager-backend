#!/usr/bin/env bun
/**Smoke suite: live probes against the production image (repo-root Dockerfile) booted by deploy/local/compose.yaml.

Usage: `make smoke`, or `bun e2e/smoke.ts [--root DIR]` (DIR: the tree to build, default this repo).
Each run builds the image, publishes it on a Docker-picked 127.0.0.1 port under its own compose
project `pb-smoke-<pid>` with a fresh volume, runs the probes in order, and always ends with
`down -v --rmi local`. It never touches the developer's `pb-local` project or port 8090.
A later behaviour probe is one async function in PROBES; a 429 masks signup for 60s, so the
rate-limit probe stays last.

Not covered: OAuth sign-in (needs a live provider). Mail (signup verification, OTP): it would
take an SMTP host/port env override in pb_hooks/mail.pb.js (today it hardcodes smtp.resend.com
behind RESEND_API_KEY), scripts/smtp_sink.ts listening on a host-gateway address instead of
127.0.0.1, and `extra_hosts: host-gateway` in the compose file.
*/

import path from "node:path";

const args = process.argv.slice(2);
const ROOT = path.resolve(
  args[0] === "--root" && args[1] ? args[1] : path.join(import.meta.dir, ".."),
);
const PROJECT = `pb-smoke-${process.pid}`;
const COMPOSE = [
  "docker",
  "compose",
  "-p",
  PROJECT,
  "-f",
  path.join(ROOT, "deploy/local/compose.yaml"),
];
const HEALTH_TIMEOUT_MS = 120_000;
const SIGNUP_LIMIT = 5; // settings rateLimits rule "POST /api/collections/users/records"

let BASE_URL = "";
let failures = 0;

function check(label: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✅" : "❌ MISMATCH"} ${label}: got ${JSON.stringify(got)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`,
  );
}

function run(cmd: string[], env: Record<string, string> = {}): { code: number; out: string } {
  if (!Bun.which(cmd[0])) return { code: 127, out: `${cmd[0]}: not found on PATH` };
  const p = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(BASE_URL + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ── Probes, run in this order ──

async function probe_health(): Promise<void> {
  const r = await fetch(BASE_URL + "/api/health");
  check("GET /api/health", r.status, 200);
}

async function batch_signup(method: string): Promise<void> {
  const r = await post("/api/batch", {
    requests: [
      {
        method,
        url: "/api/collections/users/records",
        body: { email: `batch-${method}@example.com` },
      },
    ],
  });
  check(`anonymous batch ${method} signup status`, r.status, 400);
  check(
    `anonymous batch ${method} signup inner message`,
    r.json?.data?.requests?.["0"]?.response?.message,
    "Sign up with a single request, not inside a batch.",
  );
}

async function probe_batch_create(): Promise<void> {
  await batch_signup("POST");
}

async function probe_batch_upsert(): Promise<void> {
  await batch_signup("PUT");
}

async function probe_password_signup(): Promise<void> {
  const r = await post("/api/collections/users/records", {
    email: "with-password@example.com",
    password: "probe123456",
    passwordConfirm: "probe123456",
  });
  check("signup carrying a password status", r.status, 400);
  check(
    "signup carrying a password code",
    r.json?.data?.password?.code,
    "validation_signup_password",
  );
}

async function probe_signup_rate_limit(): Promise<void> {
  const statuses: number[] = [];
  for (let i = 0; i < SIGNUP_LIMIT + 1; i++) {
    statuses.push(
      (await post("/api/collections/users/records", { email: `direct-${i}@example.com` })).status,
    );
  }
  // The password probe already spent one slot of this IP's minute.
  const expected = [...Array(SIGNUP_LIMIT - 1).fill(200), 429, 429];
  check(`direct signups x${SIGNUP_LIMIT + 1}`, statuses, expected);
}

const PROBES = [
  probe_health,
  probe_batch_create,
  probe_batch_upsert,
  probe_password_signup,
  probe_signup_rate_limit,
];

// ── Lifecycle ──

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  const r = run([...COMPOSE, "down", "-v", "--rmi", "local"]);
  if (r.code !== 0) failures += 1; // a leaked volume or image must fail the run
  console.log(
    r.code === 0 ? `cleanup: ${PROJECT} removed` : `cleanup FAILED for ${PROJECT}:\n${r.out}`,
  );
}

for (const [sig, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(code);
  });
}

async function main(): Promise<number> {
  if (run(["docker", "info"]).code !== 0) {
    console.error(
      "Docker is not installed or not running: start Docker Desktop / the daemon, then rerun `make smoke`.",
    );
    return 2;
  }
  try {
    console.log(`building and booting ${ROOT} as compose project ${PROJECT}`);
    const up = run([...COMPOSE, "up", "-d", "--build"], { PB_PORT: "0" });
    if (up.code !== 0) {
      console.error(`❌ compose up failed:\n${up.out}`);
      return 1;
    }
    const port = Number(
      run([...COMPOSE, "port", "pocketbase", "8080"])
        .out.trim()
        .split(":")
        .pop(),
    );
    if (!port || port === 8090) {
      console.error(
        `❌ refusing published port ${port}: expected a Docker-picked port other than 8090`,
      );
      return 1;
    }
    BASE_URL = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (
      (await fetch(BASE_URL + "/api/health").then(
        (r) => r.status,
        () => 0,
      )) !== 200
    ) {
      if (Date.now() > deadline) {
        console.error(
          `❌ no healthy /api/health within ${HEALTH_TIMEOUT_MS / 1000}s; container log:`,
        );
        console.error(run([...COMPOSE, "logs", "--no-color"]).out);
        return 1;
      }
      await Bun.sleep(500);
    }
    console.log(`healthy at ${BASE_URL}`);
    for (const probe of PROBES) await probe();
  } finally {
    cleanup();
  }
  console.log(failures === 0 ? "\nALL SMOKE PROBES PASSED" : `\n${failures} SMOKE CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());

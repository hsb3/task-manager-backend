# Dev runner: local PocketBase + the standing dev-loop targets, and `make check`, the repo's one gate.
# `make` lists targets. Dev URL: PocketBase http://127.0.0.1:8090 (dashboard /_/) — test bands never touch it.
# Targets that destroy or stop LOCAL state are labeled in help.

# PB_VERSION must equal the Dockerfile's ARG PB_VERSION, the canonical pin (scripts/check_pb_pin.ts).
PB_VERSION := 0.40.4
PB_PORT    := 8090
# `:=` + export (not `?=`): PB_PORT is the single knob — dev boots its server on PB_PORT,
# so a stale env PB_URL must not steer seeds at a different database. A PB_URL line in .env
# cannot defeat that: this `:=` re-wins in the sub-make `dev` hands the seed to (measured).
PB_URL     := http://127.0.0.1:$(PB_PORT)
export PB_URL
# The address `make env` writes into a local .env — `dev` compares against it, so the
# fictitious-credentials line is only claimed for the account this Makefile invented.
DEV_SUPERUSER_EMAIL := admin@example.com
# The repo's one binary resolver: $PB_BIN, ./pocketbase, the main checkout's, version-checked.
# Every call passes --dir pb_data: without it PocketBase serves the data dir next to the BINARY.
PB = $(shell bun scripts/pb_migrate.ts --print-bin)

define env_creds
e=$$(grep '^PB_SUPERUSER_EMAIL=' .env 2>/dev/null | cut -d= -f2-); p=$$(grep '^PB_SUPERUSER_PASSWORD=' .env 2>/dev/null | cut -d= -f2-); [ -n "$$e" ] && [ -n "$$p" ] || { echo "$(1): .env has no PB_SUPERUSER_EMAIL/PB_SUPERUSER_PASSWORD (make env writes a local .env when none exists)"; exit 1; }
endef

# A live WAL DB refuses read-only opens (SQLITE_CANTOPEN) — count rows in a throwaway
# copy of data.db AND its -wal/-shm siblings, opened writable so the WAL is replayed
# (immutable=1 skips the WAL and reads stale rows); a missing data.db or table counts as 0
# (fresh), but a missing sqlite3 refuses — it would otherwise read as 0 on a full database.
define row_count
command -v sqlite3 >/dev/null || { echo "$@: needs sqlite3 to tell whether pb_data is empty — install sqlite3 and run this again"; exit 1; }; d=$$(mktemp -d); cp pb_data/data.db* "$$d/" 2>/dev/null; n=$$(sqlite3 "$$d/data.db" "select count(*) from $(1)" 2>/dev/null || echo 0); rm -rf "$$d"
endef

.DEFAULT_GOAL := help
.PHONY: help dev backend seed seed-if-fresh superuser superuser-password superuser-if-missing reset clean setup stop status env pocketbase next-migration-slot check check-static battery ci-battery-verify openapi

help: ## list targets
	@grep -E '^[a-z][a-zA-Z0-9_-]*:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

dev: pocketbase env ## boot PocketBase http://127.0.0.1:8090 in the foreground; seeds a fresh DB
	@bash -c ' \
	  set -e; \
	  set -a; . ./.env; set +a; \
	  if curl -sf $(PB_URL)/api/health >/dev/null 2>&1; then \
	    echo "PocketBase already running on $(PB_PORT) — reusing it"; PB_PID=; \
	  else \
	    $(MAKE) --no-print-directory superuser-if-missing || { echo "make dev: stopped at the superuser step (above); PocketBase was never started"; exit 1; }; \
	    "$(PB)" serve --http=127.0.0.1:$(PB_PORT) --dir pb_data > pb.log 2>&1 & PB_PID=$$!; \
	    trap "kill $$PB_PID 2>/dev/null || true" EXIT INT TERM; \
	    for i in $$(seq 1 50); do curl -sf $(PB_URL)/api/health >/dev/null 2>&1 && break; sleep 0.2; done; \
	    curl -sf $(PB_URL)/api/health >/dev/null || { echo "PocketBase failed to boot — see pb.log"; exit 1; }; \
	  fi; \
	  $(MAKE) --no-print-directory seed-if-fresh || { echo "make dev: seeding failed (above); PocketBase is up$${PB_PID:+ and will stop as this command exits} (make reset starts from an empty pb_data)"; exit 1; }; \
	  echo; \
	  echo "  PocketBase  $(PB_URL)   (dashboard: $(PB_URL)/_/)"; \
	  echo "  Sign in:    alice@example.com / test123456   (also in .env.local)"; \
	  if [ "$$PB_SUPERUSER_EMAIL" = "$(DEV_SUPERUSER_EMAIL)" ]; then \
	    echo "  Dashboard:  superuser OTP via make otp (email is fictitious — OTP prints here)"; \
	  else \
	    echo "  Dashboard:  superuser OTP via make otp (OTP prints here)"; \
	  fi; \
	  echo; \
	  [ -z "$$PB_PID" ] || wait $$PB_PID'

backend: pocketbase env ## PocketBase alone, foreground (http://127.0.0.1:8090)
	@$(MAKE) --no-print-directory superuser-if-missing || { echo "make backend: stopped at the superuser step (above); PocketBase was never started"; exit 1; }
	@set -a; . ./.env; set +a; "$(PB)" serve --http=127.0.0.1:$(PB_PORT) --dir pb_data

seed: ## seed sample data (append-only — refuses on a non-empty DB; needs server up)
	@$(call row_count,users); \
	[ "$$n" = "0" ] || { echo "Refusing: DB already has $$n users and scripts/seed.ts is append-only. make reset for a fresh start."; exit 1; }; \
	bun scripts/seed.ts

seed-if-fresh:
	@$(call row_count,users); \
	if [ "$$n" = "0" ]; then $(MAKE) --no-print-directory seed; else echo "DB already seeded ($$n users) — skipping seed"; fi

otp: pocketbase ## mint + print a dashboard OTP for the dev superuser (no email needed — paste Id + Pass at /_/ step 3/3)
	@e=$$(grep '^PB_SUPERUSER_EMAIL=' .env 2>/dev/null | cut -d= -f2-); \
	[ -n "$$e" ] || { echo "otp: .env has no PB_SUPERUSER_EMAIL (make env writes a local .env when none exists)"; exit 1; }; \
	"$(PB)" superuser otp "$$e" --dir pb_data

superuser: pocketbase env ## create the dev superuser from .env (make dev/backend run it before serving a pb_data that has none)
	@$(call env_creds,superuser); \
	"$(PB)" superuser create "$$e" "$$p" --dir pb_data || { echo "superuser: PocketBase refused to create $$e (reason above) — for an account that already exists, make superuser-password sets its password to the one in .env"; exit 1; }

superuser-password: pocketbase env ## set an existing dev superuser's password to the one in .env (signs out any dashboard session already open)
	@$(call env_creds,superuser-password); \
	"$(PB)" superuser update "$$e" "$$p" --dir pb_data || { echo "superuser-password: PocketBase refused to update $$e (reason above); make superuser creates the account when it does not exist yet"; exit 1; }

# A failed create still leaves a data.db behind, and a bare serve leaves PB's placeholder installer
# row, so "no real superuser row" is the test.
superuser-if-missing:
	@$(call row_count,_superusers where email != '__pbinstaller@example.com'); [ "$$n" != "0" ] || $(MAKE) --no-print-directory superuser

reset: ## [DESTRUCTIVE: local data] wipe pb_data for a fresh boot+seed via make dev (asks first; FORCE=1 skips the prompt)
	@[ "$(FORCE)" = "1" ] || { printf "Wipe pb_data/ (all local data)? [y/N] "; read a; [ "$$a" = "y" ] || { echo "aborted"; exit 1; }; }; \
	$(MAKE) stop; rm -rf pb_data; echo "pb_data wiped — make dev boots fresh and reseeds"

clean: ## [DESTRUCTIVE: generated files] remove the downloaded PocketBase, caches, and logs
	rm -rf pocketbase pb.zip
	find . -not -path './.git/*' -type d \( -name logs -o -name '*_cache' \) -prune -exec rm -rf {} +
	find . -not -path './.git/*' -type f \( -name '*.log' -o -name '*.tsbuildinfo' \) -delete

setup: pocketbase env ## install pinned runtimes and dependencies; preserve local config/data
	mise install
	bun install --frozen-lockfile

stop: ## [stops local processes] kill whatever listens on the dev port (8090)
	@for p in $(PB_PORT); do \
	  pids=$$(lsof -ti tcp:$$p -sTCP:LISTEN 2>/dev/null); \
	  if [ -n "$$pids" ]; then kill $$pids && echo "killed port $$p ($$pids)"; else echo "port $$p free"; fi; \
	done

status: ## show the listener on the dev port
	@for p in $(PB_PORT); do \
	  printf "%-5s " $$p; \
	  lsof -nP -iTCP:$$p -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 || true; \
	  lsof -ti tcp:$$p -sTCP:LISTEN >/dev/null 2>&1 || echo "free"; \
	done

env: ## write gitignored local-dev .env + .env.local files with fictitious creds; never clobbers
	@if [ ! -f .env ]; then \
	  printf '%s\n' \
	    '# Local dev (make env) — gitignored. Fictitious dashboard superuser for this checkout; deployment variables: .env.example.' \
	    'PB_SUPERUSER_EMAIL=$(DEV_SUPERUSER_EMAIL)' \
	    'PB_SUPERUSER_PASSWORD=changeme123456' \
	    > .env && echo "wrote .env"; \
	fi
	@if [ ! -f .env.local ]; then \
	  printf '%s\n' \
	    '# Local dev (make dev) — gitignored. Accounts seeded by scripts/seed.ts.' \
	    'PB_URL=http://127.0.0.1:$(PB_PORT)' \
	    'SEED_USER_EMAIL=alice@example.com' \
	    'SEED_USER_PASSWORD=test123456' \
	    'SEED_USER_2_EMAIL=bob@example.com' \
	    'SEED_USER_2_PASSWORD=test123456' \
	    > .env.local && echo "wrote .env.local"; \
	fi
pocketbase: ## resolve the PocketBase binary (PB_BIN, ./pocketbase, main checkout); download the pinned one only without PB_BIN
	@pb=$$(bun scripts/pb_migrate.ts --print-bin); [ -x "$$pb" ] && exit 0; \
	[ -z "$$PB_BIN" ] || { echo "pocketbase: PB_BIN is not a usable binary: $$pb"; exit 1; }; \
	os=$$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$$(uname -m); [ "$$arch" = "x86_64" ] && arch=amd64; \
	url="https://github.com/pocketbase/pocketbase/releases/download/v$(PB_VERSION)/pocketbase_$(PB_VERSION)_$${os}_$${arch}.zip"; \
	echo "downloading $$url"; \
	curl -fsSL "$$url" -o /tmp/pb_dl.zip && unzip -o /tmp/pb_dl.zip pocketbase -d . && rm -f /tmp/pb_dl.zip && chmod +x ./pocketbase \
	  || { echo "pocketbase: downloading $$url failed"; exit 1; }; \
	pb=$$(bun scripts/pb_migrate.ts --print-bin); [ -x "$$pb" ] || { echo "pocketbase: the download is not usable: $$pb"; exit 1; }

next-migration-slot: ## print the next free pb_migrations timestamp (step 100; refuses at the 1785200000 battery band)
	@last=$$(ls pb_migrations | sed -n 's/^\([0-9]\{10,\}\)_.*/\1/p' | sort -n | tail -1); \
	[ -n "$$last" ] || { echo "no timestamped migrations found in pb_migrations/"; exit 1; }; \
	next=$$(( (last / 100 + 1) * 100 )); \
	[ "$$next" -lt 1785200000 ] || { echo "band exhausted: $$next reaches the 1785200000 battery scratch band"; exit 1; }; \
	echo "$$next"

# Generators must answer --check; check_historical_migrations judges only the STAGED diff, so it
# takes --staged below; check_migration_citations resolves the migrations-v1 tag, which this
# repository does not carry, so it cannot judge a v1: citation here.
GENERATORS := $(wildcard scripts/gen_*.ts)
CHECKERS   := $(filter-out scripts/check_historical_migrations.ts,$(wildcard scripts/check_*.ts))

check: check-static battery ## the gate: check-static, then the whole suite battery (BATTERY_SHARD=i/N runs one shard)

check-static: pocketbase ## format, typecheck, every generator --check, every scripts/check_*.ts gate (no server)
	bun run format:check
	bun run typecheck
	@for g in $(GENERATORS); do echo "· $$g --check"; bun "$$g" --check || exit 1; done
	bun scripts/model/extract_current.ts --check
	@for c in $(CHECKERS); do echo "· $$c"; bun "$$c" || exit 1; done
	bun scripts/check_historical_migrations.ts --staged
	@for f in .github/workflows/*.yml .github/dependabot.yml; do bun -e 'Bun.YAML.parse(await Bun.file(process.argv[1]).text())' "$$f" || { echo "invalid YAML: $$f"; exit 1; }; done

battery: ## the whole suite battery; BATTERY_SHARD=i/N runs one shard of scripts/battery_shards.tsv
	bash scripts/run_suite_battery.sh

ci-battery-verify: ## fail unless CI's shard manifests ran every battery suite exactly once
	bun scripts/check_battery_suites.ts --manifests battery-manifests/*.txt

openapi: ## regenerate openapi.json + docs/generated/decisions.md
	bun scripts/gen_openapi.ts && bun scripts/gen_decisions.ts

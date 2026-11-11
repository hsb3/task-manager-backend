---
paths:
  - "tests/**"
  - "scripts/**"
  - "Makefile"
---

# Port bands + PB_PORT_OFFSET (anything that binds a port)

**Port bands are DEFAULTS, not reservations.** Every port a `tests/test_*.ts` suite or
`scripts/run_suite_battery.sh` binds is `<default> + PB_PORT_OFFSET` (env, default `0`), so a
whole run relocates with one variable instead of a file edit: `PB_PORT_OFFSET=200 bash
scripts/run_suite_battery.sh` shifts every room and SMTP sink by 200. Use 200 or more, and
TWO CONCURRENT consumers at least 200 apart: a smaller offset lands one default on another.
Some larger offsets collide too (the sinks sit far below the rooms):
`scripts/check_port_collisions.ts` prints the lowest safe offset for the current layout, refuses
any offset (or stated minimum) that lands one default on another, and goes red when this file or
`AGENTS.md` states a minimum the layout no longer supports. It checks one offset at a time, never
the distance between two concurrent runs. Write the offset as a plain
decimal (the battery re-parses it with `py_int()` (`scripts/_py.ts`) so bash can't read `010` as octal, and
both halves reject a non-integer loudly). Need a room while something else is running? Set
`PB_PORT_OFFSET` — do NOT hand-pick a raw number out of a band. **A collision is SILENT if nothing preflights:** a suite treats any healthy server on its port as
its own, so it will seed and pass green against a stranger's database. Every self-booting
`tests/test_*.ts` and `scripts/load_smoketest.ts` preflights through `tests/roomkit.ts`
(gated by `scripts/check_room_preflight.ts`, which prints the current count) — that is what makes
a RUNTIME clash loud, not the band; `scripts/check_port_collisions.ts` is what makes two suites
sharing the same DEFAULT loud, before either ever boots. **The one thing the
offset does NOT move** is the container's `PORT` — `Dockerfile`'s `EXPOSE` is a build-time
directive that cannot read it, so that literal stays. `scripts/smtp_sink.ts`'s `SINK_PORT`
DOES shift with it. Per-site vars still win where they
exist (`PB_URL`, `PB_PUBLIC_URL`, `MAIL_SINK_PORT`, `PB_SINK_PORT`, `SINK_PORT`). `roomkit.serve` defaults `PB_PUBLIC_URL` to the room's own URL so `{APP_URL}` in mail follows the shifted port; a hand-booted room gets `mail.pb.js`'s 8090.

**Defaults** (every default listed once; `scripts/check_port_collisions.ts` gates the list): 8090
dev (off-limits to tests) · 8091-8093 battery rooms · 8094/8095/8098/8099 "probes", which are ALSO
the defaults of test_oauth, test_backups, test_observability, test_vocab_flow, test_item_keys (which
boots THREE sequential servers on its one port, so 8099 stays busy for the whole suite) and
`scripts/load_smoketest.ts`, so treat the band as taken · suite self-boot (solo runs): 8100 =
test_labels · 8101 = test_activity · 8102 = test_comments · 8103 = test_search · 8104 =
test_collab_flow · 8105 = test_export · 8106 = test_name_validation · 8107 = test_realtime · 8108 =
test_signup · 8109 = test_app_admin_approval · 8110 = test_account_deletion · 8111 = test_provision
· 8112/8113 = test_file_storage · 8114 = test_bulk_load_projects · 8115 = test_email_collision_audit
· 8116 = test_project_items_view · 8117 = test_cycles · 8118 = test_visibility_invariants · 8119 =
test_workspace_trash · 8120 = test_ordinal · 8121 = test_dangling_project · 8122 =
test_boot_refusals · 8123 = test_shadow_project · 8124 = test_hook_files_loaded · 8125 =
test_relations · 8126 = test_notifications_mentions · 8127 = test_notifications_workspace · 8128 =
test_app_docs_schema_guards · 8129 = test_scale_membership · 8130 = test_statuses · 8131 =
test_templates · 8132 = test_saved_views · 8133 = test_stale_write · 8134 =
test_subscribers_notifications · 8135 = test_productivity_flow · 8136 = test_user_settings_font ·
8137 = test_vocab_upsert · 8138 = test_fresh_workspace · 8139 = test_rescope_guard · 8140 =
test_priority_vocab · 8141 = test_inspire · 8142 = test_notifications_trash_cascade · 8143 =
test_counts_route · 8144 = test_invite_mirror · 8145 = test_mutation_proof · 8146 = test_api_keys ·
8147 = test_pb_refusal_statuses · 8148 = test_draft_publish · 8149 = test_invitations · 8150 =
test_invitation_limits · 8151 = test_workspace_save_tx · 8152 = test_agent_probe · 8153 =
test_write_hygiene · 8154 = test_user_settings_me · 8155 = test_signup_verification · 8156 =
test_access_rule_holes · 8158 = test_item_write_refusals · 8159 = test_item_list_filters · 8160 =
test_e2e_world · 8165 = test_path_scope · 8166 = test_owner_defaults · 8170 = test_due_window · 8171
= test_counts_type_trash · 8172 = test_next_milestone · 8173 = test_unknown_keys · 8174 =
test_owner_row · 8175 = test_trash_entry · 8176 = test_delete_impact · 8177 = test_me_route · 8178 =
test_notification_actor · 8179 = test_notifications_suspended · 8185 = test_invitation_expiry_list ·
8186 = test_landing · 8187 = test_invitation_mail · 8193 = test_tm_cli · 8194 = test_tm_mcp · 8195 =
test_route_errors · 8200 = test_internal_caller · 8201 = test_oauth_token · 8202/8203 = test_oauth_authorize · 9700 = test_script_help (a port it expects closed).
SMTP sinks:
2526 battery email · 2527 battery hardening · 2528-2531 test_observability · 2532
test_collab_flow · 2533 test_subscribers_notifications · 2534 test_signup_verification · 2535 test_invitation_mail. `scripts/check_port_collisions.ts`
prints the ports shared by design (the dev port, the probe band, the one hardening sink). With `PB_PORT_OFFSET` set (or `--offset N`) it also refuses an offset that lands any default on 5432/6379/3306/27017 (local Postgres/Redis/MySQL/MongoDB; 2900 puts test_collab_flow's 2532 sink on 5432), and `scripts/run_suite_battery.sh` runs it first so a battery at such an offset refuses before booting anything. With `--offset N` (N != 0) it also refuses a default that offset lands on a port something is listening on right now (offset 4300 puts test_subscribers_notifications's 8134 on Docker's 12434), and the battery runs it that way before booting anything; env-only `PB_PORT_OFFSET` (check-static) does not probe, because it runs beside the caller's own and sibling lanes' live rooms.

# Two kinds of suite

Most `tests/test_*.ts` boot their OWN room (they import `roomkit` and call
`hooks_dir(scratch)`). The ones in `scripts/run_suite_battery.sh`'s `LEGACY_SUITES` do
NOT — they only read `PB_URL` (plus `PB_SUPERUSER_EMAIL`/`PB_SUPERUSER_PASSWORD` from env or
`.env`) and expect an already-seeded room, which the battery builds fresh for EACH of them.
That freshness is load-bearing: PB's auth rate limiter lives in server memory and only a
RESTART resets it, so a second legacy suite pointed at the same room 429s on login. Both
failure modes name themselves via `roomkit.die_no_server`/`roomkit.token_of` instead of
dying on `KeyError: 'token'`. Solo-run recipe — **one legacy suite per room**:

```bash
find pb_migrations pb_hooks -type l   # must print nothing: a copied symlink aliases the real tree
S=$(mktemp -d); cp -R pb_migrations "$S/mig"; rm -f "$S/mig/"*superuser_mfa.js; cp -R pb_hooks "$S/hooks"
./pocketbase superuser upsert probe@example.com probe123456 --dir "$S/pb_data" --migrationsDir "$S/mig"
./pocketbase serve --http=127.0.0.1:8091 --dir "$S/pb_data" --migrationsDir "$S/mig" --hooksDir "$S/hooks" &
export PB_SUPERUSER_EMAIL=probe@example.com PB_SUPERUSER_PASSWORD=probe123456 PB_URL=http://127.0.0.1:8091
bun scripts/seed.ts && bun tests/test_roles.ts
```

8091 is the battery's own legacy port — shift the whole recipe with `PB_PORT_OFFSET` if a
battery is running.

# PB_BIN — which pocketbase binary a room boots

`./pocketbase` is gitignored, so a fresh worktree has none and the recipe above dies on
`No such file or directory`. `PB_BIN=/path/to/pocketbase` relocates the BINARY the way
`PB_PORT_OFFSET` relocates the ports, and every consumer reads it: self-booting suites via
`tests/roomkit.ts`'s `pb_bin()`, `scripts/seed.ts` (its old `PB_BINARY` spelling still works
but loses to `PB_BIN`), `scripts/gen_*.ts`, the Makefile's
`dev`/`backend`/`superuser`/`otp` (all through `scripts/pb_migrate.ts --print-bin`), and
`scripts/run_suite_battery.sh` — which exports it to every child, and with an inbound value
uses that binary AS-IS: it refuses on a version other than its pinned `PB_VERSION` instead of
downloading over a path it does not own (it only downloads/chmods when the resolved path is
the repo's own `./pocketbase`). Substitute it in the recipe above for `./pocketbase` too.

---
title: Railway configuration
status: current
version: 1
updated: 2026-09-09
---

# Railway configuration

Run these commands from the repository root. The topology is defined here;
`.railway/railway.ts` re-exports it so the CLI can discover it.
Application Dockerfiles and Railway service roots are unchanged.

```txt
deploy/railway/railway.ts
```

Use this file to describe the Railway project you want: services, databases, buckets, custom domains, replicas, groups, and environment variables.

## Common commands

Preview what Railway would change:

```bash
railway config plan
```

Apply the planned changes:

```bash
railway config apply
```

For a pinned plan, use a clean committed checkout and cover the whole repository tree,
including both the discovery entry and the topology it imports:

```bash
railway config plan --source-tree "$(git rev-parse HEAD:)" --out /tmp/task-manager-railway-plan.json
railway config apply --plan /tmp/task-manager-railway-plan.json
```

The CLI's default source tree covers only `.railway/` and misses the imported topology.

## Notes

- `railway config plan` is safe and does not change Railway.
- `railway config apply` previews changes and asks before applying unless you pass `--yes`.
- Destructive changes in non-interactive or agent sessions require `railway config apply --confirm-destructive` after reviewing the plan.
- Services already managed by `railway.json` must be migrated before `deploy/railway/railway.ts` can manage them.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Use `group("Name", [resources])` to keep large projects organized on the Railway canvas.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import.

The environment-specific superuser helper is `deploy/railway/set_railway_superuser.sh`.
Use `--dry-run` to inspect its command without changing an account.

`railway config pull` writes the discovery file at `.railway/railway.ts`. If importing
updated topology, reconcile its output into `deploy/railway/railway.ts` and restore the
re-export; do not leave two topology definitions.

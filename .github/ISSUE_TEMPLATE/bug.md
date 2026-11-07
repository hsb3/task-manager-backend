---
name: Bug
about: Something is broken or behaves wrong.
title: "fix: "
labels: bug
---

> **Tracking:** #<n>, <origin / how found>. <one-line framing>.

## What's wrong

The observed behavior vs the expected behavior, grounded in source (`path:line`) or a repro.

## Repro

Steps / inputs that trigger it; the environment if it matters.

## Acceptance criteria

How we know it's fixed — independently verifiable (a regression test that fails before and passes
after; the bad output no longer occurs).

- [ ]
- [ ]

## Dependencies & gates

Which repo gates fire for this fix (see `AGENTS.md` Commands + CI); anything this blocks on.

-

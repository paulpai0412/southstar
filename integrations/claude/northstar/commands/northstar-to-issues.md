---
description: Northstar issue draft or creation flow
argument-hint: <spec-path> <plan-path>
allowed-tools: [Read, Glob, Grep, Bash]
---

Use `__NORTHSTAR_ROOT__/docs/agent-playbooks/northstar-operator.md`.

The user invoked `/northstar-to-issues` with: $ARGUMENTS

Generate tracer-bullet vertical slices. Dry-run first with `node --run northstar -- plan-issues --config <config> --spec <spec> --plan <plan> --dry-run`. Create issues only after the GitHub Mutation Gate is approved with `--apply --confirmed`.

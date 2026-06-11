---
description: Northstar planning grill
argument-hint: <brief-path>
allowed-tools: [Read, Glob, Grep, Bash]
---

Use `__NORTHSTAR_ROOT__/docs/agent-playbooks/northstar-operator.md`.

The user invoked `/northstar-grill` with: $ARGUMENTS

Ask exactly one planning question at a time. If a brief path is provided, run `node --run northstar -- plan-grill --config <config> --brief <brief> --dry-run` from `__NORTHSTAR_ROOT__`, then present only `nextQuestion`.

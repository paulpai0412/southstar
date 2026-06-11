---
description: Northstar setup and doctor checks
argument-hint: [config-path]
allowed-tools: [Read, Glob, Grep, Bash]
---

Use `__NORTHSTAR_ROOT__/docs/agent-playbooks/northstar-operator.md`.

The user invoked `/northstar-setup` with: $ARGUMENTS

Run read-only discovery and doctor checks first. Do not write `.northstar.yaml` or mutate GitHub/Project state until the relevant gate is approved.

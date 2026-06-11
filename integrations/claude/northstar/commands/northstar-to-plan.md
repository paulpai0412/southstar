---
description: Northstar implementation plan generation
argument-hint: <spec-path> <plan-out>
allowed-tools: [Read, Glob, Grep, Bash]
---

Use `__NORTHSTAR_ROOT__/docs/agent-playbooks/northstar-operator.md`.

The user invoked `/northstar-to-plan` with: $ARGUMENTS

Create a `northstar:implementation-planning` execution contract with checkbox steps, exact commands, expected outcomes, commit boundaries, workflow-stage mapping, issue-slicing hints, and runtime/Project evidence expectations. Use `node --run northstar -- plan-implementation --config <config> --spec <spec> --out <plan>` when paths are available.

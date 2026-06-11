---
description: Northstar PRD/spec generation
argument-hint: <brief-path> <answers-path> <spec-out>
allowed-tools: [Read, Glob, Grep, Bash]
---

Use `__NORTHSTAR_ROOT__/docs/agent-playbooks/northstar-operator.md`.

The user invoked `/northstar-to-spec` with: $ARGUMENTS

Synthesize known context into a PRD/spec. Do not restart the interview. Use `node --run northstar -- plan-spec --config <config> --brief <brief> --answers <answers> --out <spec>` when paths are available.

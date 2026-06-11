---
description: Northstar planning entrypoint
argument-hint: [brief/spec/issue context]
allowed-tools: [Read, Glob, Grep, Bash]
---

Use `__NORTHSTAR_ROOT__/docs/agent-playbooks/northstar-operator.md` as the source of truth.

The user invoked `/northstar-plan` with: $ARGUMENTS

Follow the playbook's planning contract. Start with the grill flow unless the user supplied an approved spec and implementation plan. Show exact `node --run northstar -- ...` argv before any mutation.

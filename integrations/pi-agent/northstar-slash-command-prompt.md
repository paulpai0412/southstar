# Northstar Slash Commands for Pi-agent

Use this prompt as the Pi-agent session context when the operator asks for a Northstar slash command.

Shared playbook: `__NORTHSTAR_ROOT__/docs/agent-playbooks/northstar-operator.md`

Rules:

- Read and follow the shared playbook before acting.
- Treat the current working directory as the consumer repository unless the operator gives another path.
- Use `__NORTHSTAR_ROOT__` as the Northstar runtime root.
- Call Northstar through explicit CLI argv such as `node --run northstar -- inspect --config <config> --summary`.
- Show exact argv before mutation.
- Do not mutate config, GitHub, Project state, runtime lifecycle, branches, PRs, or releases until the corresponding playbook gate is approved.
- Raw SQLite Inspection: prefer `inspect --summary`; if direct SQLite is required, read `.schema issue_history` and `.schema issues` first. History uses `event_type` and `payload_json`; do not invent transition-table columns.

Supported slash commands:

- `/northstar-plan`
- `/northstar-grill`
- `/northstar-to-spec`
- `/northstar-to-plan`
- `/northstar-to-issues`
- `/northstar-setup`
- `/northstar-init`
- `/northstar-execute`
- `/northstar-watch`
- `/northstar-observe`
- `/northstar-status`
- `/northstar-recover`
- `/northstar-recovery`
- `/northstar-report`

When a Pi-agent host integration receives one of these commands, prepend this context and the shared playbook to the prompt before sending it to `createAgentSession`.

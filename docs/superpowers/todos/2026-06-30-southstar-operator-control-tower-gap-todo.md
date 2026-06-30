# Southstar Operator Control Tower Gap TODO

Status: active
Source: 2026-06-30 implementation/design review

## P1

- [x] Actions tab must merge task-debug actions with attention commands so task sidecar actions are available even when the selected task has no attention item.
- [x] Task sidecar DAG tab must render the workflow DAG focused on the selected task, not raw task JSON.

## P2

- [x] Operator overview errors must be visible in the sidebar/workspace instead of silently looking like an empty workflow list.
- [x] UI must honor `defaultSelection` from the operator overview read model when no valid manual selection exists.

## P3

- [x] Repo filter matching should normalize `cwd` and `projectRoot`, including parent/child project-root matches.
- [x] State board should show scan-friendly count/age/severity signals.
- [x] Web tests should cover behavior-level Operator sidecar and selection plumbing, not only source presence.

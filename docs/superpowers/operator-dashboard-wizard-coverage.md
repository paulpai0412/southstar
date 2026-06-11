# Northstar Operator Dashboard Wizard Coverage

Date: 2026-06-02

Scope: Northstar owns the operator local API, read models, guided wizard state, command plans, and confirmation gates. pi-web owns the UI component source (`~/apps/pi-web/components/northstar`) and Next.js API route surface.

## Acceptance Evidence

| Requirement | Evidence |
| --- | --- |
| Wizard phases are exactly `plan`, `setup`, `execute`, `monitor`, `recovery`, `report`. | `tests/operator-dashboard/wizard.test.ts` verifies the phase list. Browser verification on `northstar-todo` showed the six phases in the Wizard tab. |
| Operator actions are allowlisted to `intake`, `start`, `reconcile`, `release`, `repair-runtime`, `retry-sync`, `resume`, `inspect`. | `src/operator-dashboard/local-api.ts` validates the server-side allowlist and resume guardrails; `tests/operator-dashboard/local-api.test.ts` verifies action validation and execution behavior. |
| High-impact `release` requires confirmation. | `tests/operator-dashboard/local-api.test.ts` verifies unconfirmed release is rejected. pi-web extension confirms release before posting the action. |
| Host adapter parity keeps `codex`, `opencode`, and `pi`. | `tests/operator-dashboard/wizard.test.ts` verifies all three choices. `NorthstarProjectSummary.capabilities.hostAdapters` exposes the same set in the local API model. |
| Optional `skill` and `model` parameters are represented. | `NorthstarProjectSummary.capabilities.optionalParameters` exposes `skill` and `model` as optional operator design inputs. |
| MCP is included in design only, not implemented as server config. | `NorthstarProjectSummary.capabilities.mcpServers` reports `status: "design_only"`, `configurable: false`, and `supported: false`. No MCP server configuration is created. |
| Board groups runtime issues by lifecycle. | `tests/operator-dashboard/read-model.test.ts` verifies grouping. Browser verification using `/home/timmypai/apps/northstar-todo/.northstar.yaml` showed Ready 0, Release Pending 1, Completed 24, Cancelled 2, and other lifecycle columns. |
| Issue detail displays compact timeline, inspect model, and session links. | `tests/operator-dashboard/read-model.test.ts` verifies timeline redaction and Pi session links. Browser verification opened issue #54 in `northstar-todo` and showed source URL, labels, accepted artifacts, inspect JSON, and compact event rows. |
| Pi-backed runs can link to pi-web session viewer; Codex/OpenCode runs remain normalized metadata. | `tests/operator-dashboard/read-model.test.ts` verifies Pi `/?session=` links. The `northstar-todo` runtime fixture used in browser verification had Codex metadata and no Pi session links, so no Pi link was rendered. |
| Wizard command plan displays argv array, expected effects, risk, and confirmation status. | `tests/operator-dashboard/wizard.test.ts` verifies argv arrays and blocked plan creation. Browser verification clicked Generate Plan and showed `ARGV []`, high risk, confirmation required, expected effects, and blocked gate text. |
| Pi assistant is read-only. | Browser verification in pi-web showed prompt context rendering only; mutation controls were absent while board actions remained in the board/drawer surfaces. |
| GitHub issue/PR/project projection is bounded summary only. | `tests/operator-dashboard/read-model.test.ts` verifies redacted, capped timeline previews and bounded accepted artifact summaries. Raw transcript, terminal log, and full JSONL payloads are suppressed. |
| pi-web integration preserves future pi-web upgradeability. | Northstar exposes stable operator data/action contracts from `src/operator-dashboard/*`; pi-web consumes them without copying UI sources back into Northstar. |

## Browser Verification

The pi-web dev server was exercised at `http://localhost:3030` with the custom workspace `/home/timmypai/apps/northstar-todo`.

Verified screens:

- Northstar Board loaded project `northstar-todo` and repo `paulpai0412/northstar-todo`.
- Board grouped lifecycle columns and showed issue #54 in Release Pending.
- Issue detail for #54 rendered source URL, labels, accepted artifacts, inspect JSON, and timeline rows.
- Wizard Generate Plan opened the expected blocked gate because production `northstar plan-issues` CLI is not available.
- Pi view rendered read-only operator context and prompt JSON without mutation controls.

## Known Limitation

Spec-to-GitHub issue creation remains intentionally blocked until a production `northstar plan-issues` CLI exists. The wizard must keep showing a blocked confirmation gate for that path instead of pretending issue creation is available.

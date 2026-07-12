# Case 32 — Vocabulary Goal Browser E2E Checklist

## Scenario

Drive the Southstar browser UI from Library vocabulary authoring through a completed local vocabulary trainer goal in `/home/timmypai/apps/southstar-vocab`.

The test must use the real LLM Library importer, Goal interpreter/designer, Composer, Postgres runtime, Tork/Pi executor, and browser snapshots. It must not seed vocabulary objects, inject a fixture composition, mock the executor, or assert fixed LLM-generated slice names.

## Goal Contract

Create a local flashcard vocabulary system that can:

- add and list words with translations and examples;
- run a flashcard quiz;
- persist answer history;
- report per-session and cumulative accuracy;
- stay local to the workspace with no external service integration;
- provide implement and verify evidence for every blocking requirement.

## Browser checklist and snapshot contract

| ID | Browser action | Snapshot | Required observable result |
| --- | --- | --- | --- |
| C32-01 | Open Workflow mode and set project CWD | `01-workflow-cwd` | Workflow panel is active; the selected CWD is `/home/timmypai/apps/southstar-vocab`; chat input is enabled. |
| C32-02 | Submit the one Goal prompt | `02-goal-submitted` | The user message is visible; the workflow stream shows an accepted Goal draft. |
| C32-03 | Wait for missing vocabulary result | `03-needs-library-input` | `needs_library_input` is visible; at least one structured vocabulary gap is visible; no DAG or executor action is present. |
| C32-04 | Switch to Library mode | `04-library-mode` | `mode-library` is active; Library chat uses the same project scope/CWD. |
| C32-05 | Submit the Library import request | `05-library-import-candidates` | `library-import-candidates` is visible; candidates include only allowed vocabulary kinds and schema fields. |
| C32-06 | Review candidates and click Install selected | `06-library-install-progress` | `library-install-sse-frames` contains install and sync events; no `library.error` frame exists. |
| C32-07 | Confirm the installed graph | `07-library-approved-graph` | `library-install-graph` is visible; installed objects are approved and include the domain/capability/artifact/evaluator kinds required by the Goal. |
| C32-08 | Return to Workflow and continue the existing Goal | `08-goal-retry` | The same draft ID is reused; the UI reports approved vocabulary retry, not a new unrelated Goal. |
| C32-09 | Observe the generated slice plan | `09-slice-plan-ready` | `goal-slice-plan-block` is `ready_for_review`; it has at least one slice, requirement IDs, expected artifacts, evaluator refs, and package hash. |
| C32-10 | Click a slice plan item | `10-slice-sidecar` | `goal-slice-editor` opens in the existing sidecar; the selected slice ID and package hash match the message block. |
| C32-11 | Confirm and compose the DAG | `11-dag-composed` | `goal-design-confirm-compose` completes; `workflow-dag-block` appears with non-empty nodes and edges. |
| C32-12 | Observe the confirmed runtime DAG | `12-run-created` | The confirmation response contains a persisted run ID; the DAG carries runtime scope and a scheduling/approval status. |
| C32-13 | Open Operator mode | `13-execution-started` | The same run is selected; task rows move out of pending as the scheduler submits executor jobs. |
| C32-14 | Wait for executor completion | `14-run-completed` | The selected run is `completed`; all tasks have terminal success; evaluator evidence is visible. |
| C32-15 | Inspect completed Goal Contract | `15-goal-satisfied` | Goal outcome is `satisfied`; every blocking requirement has producer/evaluator coverage and passed evidence. |
| C32-16 | Inspect workspace result | `16-workspace-acceptance` | `/home/timmypai/apps/southstar-vocab` contains the generated vocabulary trainer and its tests; the acceptance command passes. |

## Snapshot normalization

Snapshots must normalize UUIDs, draft/run IDs, hashes, timestamps, elapsed durations, and model prose that is not part of a schema contract. Assertions are semantic: object kind, status, required fields, coverage, evidence kinds, and terminal state. Generated slice IDs and task names are never hardcoded.

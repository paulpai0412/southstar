# Postgres/Tork/Pi Real E2E Cases

This directory is the canonical real E2E surface for the new Southstar v2 Postgres/async runtime.

## Rules

- Run **one case at a time**. Do not aggregate real workflow cases into one long suite.
- Do **not** reintroduce legacy SQLite E2E or local API harnesses.
- Do **not** add UI/browser flows here. Future UI flows will be redesigned separately.
- No fake/mock/smoke/test-only shortcuts in real cases.
- Deterministic in-process providers are allowed only when the asserted behavior is Southstar's durable Postgres state, not external Tork/Pi provider behavior.
- Cases must fail closed when required real infra is missing.
- Prefer lifecycle evidence from Postgres tables/read-models over console output.

## Required environment

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
TORK_BASE_URL=http://127.0.0.1:8000
PI_HARNESS_ENDPOINT=http://127.0.0.1:<pi-harness> # or Pi SDK available
PI_PLANNER_ENDPOINT=http://127.0.0.1:<pi-planner> # optional if Pi SDK available
SOUTHSTAR_CALLBACK_HOST=172.17.0.1               # host reachable from Tork worker containers
```

## Implemented case order

Run these individually:

```bash
npm run test:e2e:postgres:00   # infra preflight
npm run test:e2e:postgres:01   # db:init/schema contract
npm run test:e2e:postgres:02   # planner/run/read-model/envelope API contract
npm run test:e2e:postgres:03   # normal software run through Tork/Pi callbacks
npm run test:e2e:postgres:04   # artifact failure + recovery dispatch
npm run test:e2e:postgres:05   # session checkpoint + recovery rerun
npm run test:e2e:postgres:06   # executor binding drift/lost reconcile
npm run test:e2e:postgres:07   # evolution learning signals/cards/deltas/wiki
npm run test:e2e:postgres:08   # evolution sandbox baseline/candidate through Tork/Pi
npm run test:e2e:postgres:09   # regression monitor rollback/alert policy
npm run test:e2e:postgres:10   # managed brain crash wake
npm run test:e2e:postgres:11   # managed hand reprovision
npm run test:e2e:postgres:12   # managed credential isolation
npm run test:e2e:postgres:13   # per-task Tork hand runtime scheduling
npm run test:e2e:postgres:14   # stale queued Tork hand execution recovery
npm run test:e2e:postgres:15   # stale running Tork hand execution recovery
npm run test:e2e:postgres:16   # stale callback from superseded attempt
npm run test:e2e:postgres:17   # tool proxy runtime enforcement
npm run test:e2e:postgres:18   # work item intake to run execution
npm run test:e2e:postgres:19   # completion gate blocks unresolved exception
npm run test:e2e:postgres:20   # operator-approved recovery path
npm run test:e2e:postgres:21   # recovery decision apply requeue
npm run test:e2e:postgres:22   # recovery decision apply reprovision
npm run test:e2e:postgres:23   # operator-approved recovery apply
npm run test:e2e:postgres:24   # provider unreachable apply failure
npm run test:e2e:postgres:25   # normal managed context/session/memory propagation
npm run test:e2e:postgres:26   # abnormal managed context/session/memory recovery
```

`npm run test:e2e:postgres` intentionally runs only the static manifest/boundary checks. It does not run all real cases.

## Target case matrix

| Case | Status | Purpose | Evidence |
| --- | --- | --- | --- |
| 00 infra preflight | implemented | Verify real Postgres, Tork, Pi planner/harness reachability | schema metadata, endpoint probes |
| 01 db schema init | implemented | Verify `db:init`, schema metadata, simplified table model | `southstar.schema_metadata`, no dedicated forbidden tables |
| 02 runtime API contract | implemented | Verify planner draft, run creation, task envelope, run inspection | Postgres rows + `/api/v2/read-models/...` |
| 03 normal software run | implemented | Real software task through planner -> Tork -> Pi -> callback -> completed artifact | `workflow_history`, accepted artifact, completed task/run |
| 04 artifact repair/recovery | implemented | Failed callback evidence triggers repair/recovery decision apply and successful retry | `repair.requested`, `recovery_decision.applied`, recovered hand execution/task |
| 05 session recovery | implemented | Failed session callback gets checkpointed and rerun under new root session id | checkpoint resource, rerun context packet/envelope, `checkpoint.created`, scheduler resubmission |
| 06 executor reconcile | implemented | Lost executor binding is classified and actioned without mutating run/task lifecycle | lost binding status, reconcile result resource, executor action commands/history |
| 07 evolution learning | implemented | Runtime-linked signals synthesize cards, deltas, and wiki backlinks with read-model evidence | `learning_nodes`, `learning_edges`, delta resource, evolution control center counts |
| 08 evolution sandbox | implemented | Baseline/candidate sandbox jobs execute through Tork/Pi and evaluate decision | sandbox run contexts, callback history, decision resource |
| 09 regression rollback | implemented | Regression monitor auto-rolls back low-risk asset and raises high-risk approval alert | rolled_back/active asset statuses, rollback lineage edges, acknowledged alert |
| 10 managed brain wake | implemented | Session log failure evidence wakes a replacement managed brain | brain binding resource, recovery decision |
| 11 managed hand reprovision | implemented | Hand failure evidence provisions a replacement managed hand | hand binding resource, recovery decision |
| 12 managed credential isolation | implemented | Tool proxy lease/call surfaces keep credential values out of persisted runtime evidence | vault lease, tool proxy call, redacted persisted surfaces |
| 13 per-task Tork runtime | implemented | Runnable task scheduling queues a per-task hand execution and callback gates completion | hand execution, task intent, accepted artifact, completed run |
| 14 Tork queue timeout recovery | implemented | Stale queued hand execution is observed and classified for requeue | `tork_queue_timeout`, `requeue-hand-execution`, history |
| 15 Tork running hang recovery | implemented | Stale running hand execution is observed and classified for reprovision | `tork_running_hang`, `reprovision-hand`, read-model/history |
| 16 stale callback superseded attempt | implemented | Older attempt callback is recorded but does not reopen the current task/hand | `stale_callback`, observe-only decision, current hand unchanged |
| 17 tool proxy runtime enforcement | implemented | Pre-execution raw credential payload blocks hand execution and redacts evidence | `tool_proxy_violation`, blocking exception, operator decision |
| 18 work item intake to run execution | implemented | Work item materialization links provenance before per-task scheduling and callback completion | work item run refs, run context, hand execution, accepted artifact |
| 19 completion gate unresolved exception | implemented | Completion gate fails completed work while a runtime exception is unresolved, then passes after resolution | failed/passed evaluator results, exception resolution history |
| 20 operator-approved recovery path | implemented | Operator-required rollback decision is exposed through the exception read model | rollback decision, `operatorApprovalRequired`, operator read model |
| 21 recovery decision apply requeue | implemented | Applying a queued hand recovery decision releases the task and marks the stale hand lost | pending task, lost hand execution, succeeded recovery execution, resolved exception |
| 22 recovery decision apply reprovision | implemented | Applying a running hand recovery decision provisions a replacement hand and releases the task | replacement hand binding, checkpoint, lost old hand, succeeded recovery execution |
| 23 operator-approved recovery apply | implemented | Operator approval gates an operator-required recovery decision before apply | skipped pre-approval apply, approval resource/history, blocked task/execution after approval |
| 24 provider unreachable apply failure | implemented | Provider cancel failure is retained as redacted action evidence while the task is released | redacted provider action, pending task, lost hand, succeeded recovery execution |
| 25 normal context/session/memory flow | implemented | Downstream task receives prior artifact and run-local memory through managed context | context packet refs, task envelope, completed hands/tasks, accepted artifacts |
| 26 abnormal context/session/memory recovery | implemented | Consumer Tork/Pi runner validation failure points to the producer artifact, records lineage repair context, resets the session, and rebuilds retry context from checkpoint, producer artifact, and run-local memory | producer hand, failed consumer hand, rejected artifact, `failedArtifactRefs`, `artifact_repair_marker`, `runtime.fault_injected`, session reset, checkpoint refs, memory refs, retry envelope, resolved exception |

## Adding a new case

1. Add `tests/e2e-postgres/cases/NN-description.test.ts`.
2. Add a package script `test:e2e:postgres:NN`.
3. Update this README and `postgres-real-matrix-static.test.ts`.
4. Keep the case independent: create its own Postgres database and clean it up.
5. Assert real lifecycle/read-model evidence, not just successful HTTP responses.

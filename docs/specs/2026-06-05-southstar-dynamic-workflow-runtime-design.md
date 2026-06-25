# Southstar Generic Multi-Agent Workflow Runtime Design

日期：2026-06-05

> Current-state note (2026-06-25): Southstar v2 Postgres runtime now uses the layered model documented in `docs/superpowers/southstar-current-postgres-state-model.md`. Sections in this older spec that describe `runtime_status` / `workflow_state` as physical current-schema columns should be read as historical target design or semantic projection language, not current schema truth.

## 目標

Southstar 是一套 generic multi-agent workflow runtime，不是 Northstar 的 migration branch，也不是只服務 software delivery 的 Northstar v2。Northstar v1 只作為經驗來源，可參考 host adapter、source/projection integration、doctor/watch、artifact validation、operator dashboard 等做法；Southstar 不承接 Northstar v1 的固定 lifecycle state、單 role stage、`runtime_context_json.child_runs`，也不保留 hard-coded `issue_to_pr_release` cycle。

Southstar 的目標是讓使用者透過 workflow skill 互動產生 domain workflow design spec、agent catalog、workflow YAML draft，再由 runtime 以 work item、stage root session 與 task/subagent graph 執行。系統必須支援 task-level prompt、artifact criteria、routing、completion、exception/recovery policy，並從第一版就納入 race condition 與 idempotency 設計。

Northstar/software delivery 應被降級為 Southstar 的第一個 domain pack，而不是 Southstar core 本體。

## 非目標

- 不做 Northstar v1 SQLite migration。
- 不要求 workflow v1 schema 相容現有 Northstar validator。
- 不把 GitHub issue、PR、repo 或 software delivery 當 runtime core 語意。
- 不在第一版支援單一 workflow 跨多個 source/project 執行；資料表保留跨 source work item 管理能力即可。
- 不用 exception policy 承載正常 conditional branching。
- 不把複雜 workflow YAML 當主要人類編輯介面；主要 authoring surface 是 Southstar workflow skill。
- 不做 generic automation platform、Zapier、BPMN、n8n 替代品；Southstar 的核心是 multi-agent execution 與 artifact-governed state machine。

## 命名與檔案邊界

Southstar 是完整新系統：

```text
repo: southstar
cli: southstar
config: .southstar.yaml
runtime dir: .southstar/runtime
agent catalog: .southstar/agents.yaml
workflow dir: .southstar/workflows/*.yaml
domain packs: .southstar/packs/<domain>/
```

Northstar 可以被 clone 作為起點，但實作時應視為 clean-slate generic runtime。可搬可改的部份包括 config/YAML parsing、host adapter integration 經驗、source/projection 經驗、doctor/watch CLI 形狀、artifact validation 測試方法；不搬 v1 runtime state machine 的單 stage 單 child 假設。

Southstar core 使用通用命名；domain pack 才能引入 domain-specific 名稱：

```text
Southstar core: work_item, stage, task, artifact, policy, session, source, projection
software_delivery pack: issue, repo, PR, review, release
incident_ops pack: alert, diagnosis, remediation
research pack: question, evidence, synthesis, memo
support pack: ticket, customer, response, escalation
```

## 核心模型

Southstar 的 workflow runtime 以 work item、stage 與 task 分層：

```text
workflow
  -> work item
       -> stage
            -> stage attempt / root session
                 -> tasks / subagent child runs
```

語意定義：

- Stage 是 workflow 的語意邊界與 root session boundary。
- 每次 stage attempt 建立一個 root session。
- Task 是最小可執行單位，對應 subagent 或 host child run。
- Work item 是任何可被 workflow 處理的工作單位，例如 software issue、incident alert、research request、support ticket、document request。
- Task 產生 artifact，artifact 是 routing、completion、exception 判斷的 canonical fact。
- Host 原生 shared memory 可作為 optimization，但 runtime 正確性以 Southstar artifact/fact store 為準。

每個 work item 有兩層狀態：

```text
runtime_status: Southstar operational state
workflow_state: workflow-defined domain state
```

第一版固定 runtime status：

```text
ready
active
waiting
exception
completed
failed
quarantined
cancelled
```

Workflow state 由 workflow/domain pack 定義，例如 `implementing`、`diagnosing`、`researching`、`waiting_for_customer`、`publishing`。

Core rule:

- `runtime_status` 固定，由 Southstar core 管理。
- `workflow_state` 可由 domain/workflow 自定義。
- 每個 workflow state 必須映射到一個 runtime status。
- lock、resume、retry、quarantine、dashboard operational filter 只看 `runtime_status`。
- domain dashboard 或 pack-specific UI 可以顯示 `workflow_state`。

## 三表 Runtime Schema

Southstar 第一版採三張核心表：

```text
work_items
work_item_tasks
work_item_history
```

這個設計保留足夠查詢效能與 dashboard 能力，同時避免過度正規化導致表太多、操作難管理。

### work_items

`work_items` 是 canonical work item 主表。它使用內部 ID，不把任何外部 source id 當 runtime primary key。

```text
id                      internal opaque id, e.g. wi_<uuid>
version                 optimistic lock version
domain                  software_delivery | incident_ops | research | data_analysis | support | custom
work_type               issue | alert | ticket | request | document | custom
source_provider         local | github | linear | jira | slack | notion | email | api | custom
source_scope            repo/project/channel/workspace/account, nullable for local-only work
source_number           external numeric id, nullable
source_external_id      external stable id, nullable
source_ref              local:wi_xxx or github:owner/name#123 or jira:PROJ-123
source_url              nullable
title
runtime_status          ready | active | waiting | exception | completed | failed | quarantined | cancelled
workflow_state          workflow-defined state
workflow_id
workflow_version
workflow_fingerprint
current_stage
current_stage_attempt
root_session_id         current active stage root session id, nullable
priority
projection_json         optional source/projection adapter state
workflow_json           resolved immutable workflow snapshot
state_json              graph evaluator state, routing summary, carry-forward context
snapshot_json           debug/read-model projection
lock_owner              nullable process/watch owner id
lock_expires_at         nullable
created_at
updated_at
completed_at
```

Key rules:

- `work_items.id` is opaque and stable.
- `domain/work_type` are Southstar-visible classification fields; domain packs define allowed values.
- `source_provider/source_scope/source_number/source_external_id/source_ref/source_url` are source metadata.
- `workflow_json` is resolved at work item start or workflow run start and does not follow template changes automatically.
- Workflow migration or resume onto a newer workflow is an explicit operator action.
- `projection_json` tracks optional projection adapter state; projection failures do not block runtime unless policy explicitly requires it.

Recommended indexes:

```text
work_items(domain, runtime_status)
work_items(runtime_status, priority)
work_items(source_provider, source_scope, source_number)
work_items(source_provider, source_external_id)
work_items(workflow_id, workflow_state)
work_items(source_ref)
```

### work_item_tasks

`work_item_tasks` stores both stage root sessions and task/subagent runs. Artifacts live on task rows.

```text
id
work_item_id
stage_name
stage_attempt
task_id
task_attempt
kind                    stage_root | task_child
parent_task_id          stage root row id for task_child
role_name
agent_profile
host_adapter
root_session_id
session_id
child_run_id
idempotency_key
status                  queued | running | succeeded | failed | blocked | lost
started_at
last_seen_at
completed_at
depends_on_json
input_json
artifact_kind
artifact_status
artifact_json
error_json
context_json
```

Key rules:

- Every stage attempt has one `stage_root` row.
- Every executable task/subagent has one `task_child` row per attempt.
- `root_session_id`, `session_id`, and `child_run_id` are first-class fields so the dashboard can show every active session.
- Artifact fields are stored both as JSON and selected top-level columns for query performance.
- Task identity is idempotent by `(work_item_id, stage_name, stage_attempt, task_id, task_attempt)` or equivalent idempotency key.

Recommended indexes:

```text
work_item_tasks(work_item_id, stage_name, stage_attempt)
work_item_tasks(work_item_id, status)
work_item_tasks(session_id)
work_item_tasks(root_session_id)
work_item_tasks(child_run_id)
work_item_tasks(artifact_kind, artifact_status)
work_item_tasks(idempotency_key)
```

### work_item_history

`work_item_history` is append-only audit.

```text
id
work_item_id
sequence
event_type
payload_json
idempotency_key nullable
created_at
```

It records:

- work item created/intaken/projected
- workflow resolved
- stage root started/completed
- task queued/started/completed
- artifact accepted/rejected
- routing decision
- completion decision
- exception raised/resolved
- operator action
- source/projection adapter result
- lock acquisition/release and stale lock diagnostics

Recommended indexes:

```text
work_item_history(work_item_id, sequence)
work_item_history(event_type)
work_item_history(idempotency_key)
```

## Source And Projection Model

Southstar's canonical runtime source of truth is SQLite `work_items`. External systems are optional sources or projections.

Supported first-version modes:

```text
local mode:
  workflow skill/API -> work_items table only

remote mode:
  external source -> Southstar intake -> work_items table

hybrid mode:
  workflow skill/API -> work_items table -> projection worker creates/syncs external record later
```

Config shape:

```yaml
intake:
  mode: local # local | remote | hybrid

sources:
  github:
    enabled: true
  jira:
    enabled: false

projection:
  github:
    enabled: true
    blocks_runtime: false
```

Rules:

- Source/projection adapter failure does not block runtime by default.
- Projection can be made blocking by workflow or policy only when required.
- Local work items can run without external credentials.
- Remote intake remains available for teams that want an external system as source of record.
- Hybrid mode is preferred long term because Southstar can create runtime work first and project outward.
- GitHub, Jira, Linear, Slack, Notion, email, and API records are adapter concerns, not core runtime concepts.

## Domain Pack Contract

Southstar is generic at the core and specialized through domain packs.

Domain pack contents:

```text
.southstar/packs/<domain>/
  pack.yaml
  agents.yaml
  workflows/*.yaml
  prompts/*.md
  artifact-schemas/*.yaml
  fixtures/*.yaml
  source-mapping.yaml
  projection-mapping.yaml
  dashboard-view.yaml
  lint-rules.yaml
```

`pack.yaml` is the manifest and must declare:

```yaml
pack:
  id: software_delivery
  version: "0.1"
  display_name: Software Delivery
  work_types:
    - issue
    - request
  workflows:
    - software_delivery_basic
  artifact_kinds:
    - repo_inspection
    - implementation_result
    - verification_result
  sources:
    - github
    - local
  projections:
    - github
  dashboard_views:
    - delivery_board
```

Pack rules:

- A pack is installable, explainable, lintable, and snapshotable.
- A pack can define work types, workflow templates, agent profiles, artifact schemas, prompt refs, source mappings, projection mappings, dashboard views, fixtures, and pack-specific lint rules.
- Southstar core must not import domain-specific code paths from a pack. It loads pack assets through explicit contracts.
- Pack assets can be overridden at the project level, but resolved work item snapshots must include the effective pack version and resolved assets.
- Pack version changes do not affect active work items unless an operator explicitly migrates or restarts them on the new pack version.
- `southstar pack lint` must validate manifest references, workflow ids, artifact schemas, prompt refs, mappings, fixtures, and dashboard view references.
- `southstar pack explain` must summarize work types, workflows, artifacts, source/projection mappings, and operational risks.

First domain packs to support:

```text
software_delivery
incident_ops
research
data_analysis
support_escalation
```

Northstar becomes a `software_delivery` pack:

```text
Northstar concepts:
  GitHub issue -> work_item.source_provider=github, work_type=issue
  repo -> source_scope or artifact field
  PR -> projection/artifact
  review/release -> workflow states and tasks
```

Southstar core must remain usable without installing the software delivery pack.

## Agent Catalog

Agent settings are extracted from workflow definitions into project-level or pack-level catalog:

```text
.southstar/agents.yaml
.southstar/packs/<domain>/agents.yaml
```

Agent profile defines who the subagent is and its stable defaults:

```yaml
agents:
  context_analyst:
    display_name: Context Analyst
    host_adapter: pi
    agent: analyze
    model: github-copilot/gpt-5.3-codex
    load_skills:
      - evidence-gathering
    timeout_seconds: 3600
    persona:
      summary: Read-only context analyst.
      rules:
        - Do not edit files.
        - Prefer concrete source references.
    artifact_defaults:
      context_analysis:
        required_fields:
          - relevant_sources
          - key_findings
          - risks
          - recommended_plan
        success_statuses:
          - success
        failure_statuses:
          - blocked
          - failed_retryable
          - failed_terminal
```

Workflow tasks reference agent profiles and can override locally:

```yaml
tasks:
  browser_verify:
    agent_profile: browser_verifier
    agent_overrides:
      timeout_seconds: 7200
      load_skills:
        add:
          - playwright
```

Override rules:

- Agent artifact defaults are baseline contracts.
- Task must specify output artifact kind.
- Task artifact contract defaults to `mode: extend`.
- `mode: replace` must be explicit.
- Resolved work item workflow snapshot includes resolved agent profiles, preventing catalog changes from affecting active work items.

## Workflow YAML Schema

Workflow definitions live in:

```text
.southstar/workflows/<workflow-id>.yaml
```

Example:

```yaml
workflow:
  id: generic_request_resolution
  version: "0.1"
  domain: custom

  states:
    analyzing:
      runtime_status: active
    executing:
      runtime_status: active
    waiting_for_external_input:
      runtime_status: waiting
    completed:
      runtime_status: completed

  work_item:
    accepted_types:
      - request
      - issue
      - ticket

  stages:
    analysis:
      workflow_state: analyzing
      root_session:
        scope: stage_attempt

      tasks:
        inspect_context:
          agent_profile: context_analyst
          objective: Inspect the work item and available context to produce an execution path.
          inputs:
            include_work_item: true
            include_source_context: true
          output:
            artifact_kind: context_analysis

      routing_policy:
        rules: []

      completion_policy:
        all_success:
          - inspect_context
        on_satisfied:
          type: next_stage
          stage: execution

      exception_policy:
        rules:
          - name: retry_failed_analysis
            match:
              task: inspect_context
              status: failed_retryable
            action:
              type: retry_stage

    execution:
      workflow_state: executing
      root_session:
        scope: stage_attempt

      tasks:
        execute_plan:
          agent_profile: execution_agent
          objective: Execute the accepted plan and report the result.
          inputs:
            artifacts:
              - context_analysis
          output:
            artifact_kind: execution_result
            artifact:
              mode: extend
              required_fields:
                - actions_taken
                - commands_run

      completion_policy:
        all_success:
          - execute_plan
        on_satisfied:
          type: complete_work_item
          workflow_state: completed
```

Composition primitives for v1:

- stages
- tasks
- task dependencies by `depends_on`
- routing_policy
- completion_policy
- exception_policy

Out of scope for v1:

- nested stages
- loop over dynamic collections
- arbitrary script predicates
- direct external-system predicate inside routing
- single workflow execution spanning multiple source scopes

## Workflow Graph And DAG Constraints

Southstar workflow execution is a constrained DAG plus bounded recovery actions. DAG controls normal execution topology; fixed runtime state controls operational lifecycle.

Normal graph rules:

- Stage graph for normal flow must be directed and acyclic.
- Task graph inside each stage must be directed and acyclic.
- `depends_on` forms task-level DAG edges inside the same stage.
- `completion_policy.on_satisfied.type=next_stage` forms normal stage-level DAG edges.
- `routing_policy.action.start_tasks` can only activate predeclared task nodes in the current stage.
- `routing_policy` can skip or activate nodes, but cannot create new task/stage nodes at runtime.
- `completion_policy` can move to a declared next stage or complete the work item.
- Normal routing loops are not allowed in v1.

Recovery rules:

- `exception_policy` may retry task, retry stage, return to a previous stage, quarantine, fail, or cancel.
- Retry/return actions are recovery edges, not normal DAG edges.
- Every retry/return action must be bounded by max attempts or an equivalent guard.
- Artifact from a previous stage attempt cannot satisfy dependencies in the current stage attempt unless explicitly carried forward by policy.

Workflow lint must reject:

- Missing task or stage references.
- Cycles in task-level normal flow.
- Cycles in stage-level normal flow.
- Routing policies that reference undeclared tasks.
- Completion policies that reference undeclared tasks or stages.
- Recovery actions without bounded attempts.
- Workflow states that do not map to fixed `runtime_status`.

The evaluator is therefore both a DAG scheduler and a state reducer:

```text
DAG scheduler = decides which declared task/stage nodes are ready
state reducer = applies task/artifact/policy events to runtime_status and workflow_state
```

## Software Delivery Pack Example

The software delivery pack can specialize the generic model without changing Southstar core:

```yaml
workflow:
  id: software_delivery_basic
  version: "0.1"
  domain: software_delivery

  work_item:
    accepted_types:
      - issue
      - request

  states:
    implementing:
      runtime_status: active
    verifying:
      runtime_status: active
    waiting_for_release:
      runtime_status: waiting
    completed:
      runtime_status: completed

  stages:
    implementation:
      workflow_state: implementing
      tasks:
        inspect_repo:
          agent_profile: repo_inspector
          output:
            artifact_kind: repo_inspection
        implement_change:
          agent_profile: implementation_agent
          depends_on:
            - inspect_repo
          output:
            artifact_kind: implementation_result
```

## Prompt And Artifact Contracts

Role and task are separated:

```text
agent profile = host/model/skills/persona/default artifact contracts
task = objective/inputs/output/dependencies/routing participation
artifact = runtime-validated canonical output
```

Each task/subagent has its own prompt contract and artifact criteria. Agent profile may define persona and baseline artifact schema, but task defines the concrete objective and output kind.

Long prompts should support `prompt_ref` from the first version:

```yaml
tasks:
  execute_plan:
    agent_profile: execution_agent
    prompt_ref: prompts/execute-plan.md
    output:
      artifact_kind: execution_result
```

The workflow resolver must inline prompt content or store prompt hash/content in the work item's resolved `workflow_json` so active work items do not drift when prompt files change.

## Artifact Registry

Artifacts are Southstar's canonical decision facts. Prompts can be changed, agents can vary, and host adapters can behave differently, but the runtime only routes, completes, retries, or quarantines based on validated artifacts and task state.

Artifact kind registry:

```yaml
artifacts:
  context_analysis:
    schema_ref: artifact-schemas/context-analysis.yaml
    status_field: status
    success_statuses:
      - success
    failure_statuses:
      - blocked
      - failed_retryable
      - failed_terminal
    required_fields:
      - relevant_sources
      - key_findings
      - risks
      - recommended_plan
    query_fields:
      - status
      - risk_level
      - requires_human
```

Artifact rules:

- Every task must declare exactly one primary `artifact_kind`.
- A task may emit supplemental artifacts, but policy decisions in v1 use the primary artifact unless explicitly configured.
- Artifact schemas come from the domain pack or project override and are resolved into the work item's immutable snapshot.
- Artifact validation must happen before routing, completion, or exception policy evaluation.
- Artifact status must normalize into runtime-understood categories: success, blocked, failed_retryable, failed_terminal, or custom informational status.
- Runtime decisions use normalized status plus declared query fields, not arbitrary JSON traversal.
- Secrets must not be stored in `artifact_json`; artifacts may store secret references only if the host adapter marks them safe.
- Artifact lineage must record producing task row, stage attempt, task attempt, schema version, validation result, and accepted/rejected decision.
- A rejected artifact is audited in history but cannot advance runtime state.

Storage rules:

- `work_item_tasks.artifact_json` stores the accepted primary artifact for that task attempt.
- `artifact_kind` and `artifact_status` remain top-level columns for fast filtering.
- Frequently queried artifact fields can be duplicated into `context_json` or a future read model, but the canonical artifact remains on the task row.
- Southstar v1 keeps artifact storage in `work_item_tasks` to preserve the three-table model. A dedicated artifact table is a future optimization only if query or retention pressure requires it.

## Policy Model

Southstar separates normal branching, completion, and abnormal recovery:

```text
routing_policy = normal conditional branching
completion_policy = stage graph completion
exception_policy = abnormal failure/recovery
```

Routing policy can use first-version predicates:

- artifact field
- task status
- stage attempt or retry attempt
- runtime config flag
- known runtime metadata such as a projection record exists

External state must be captured by a task/adapter artifact before routing uses it. For example, do not route directly on GitHub PR mergeability, Jira SLA state, or a support ticket status. Instead run an adapter inspection task that produces a validated artifact, then route on that artifact field.

Example:

```yaml
routing_policy:
  rules:
    - name: high_risk_result_needs_specialist_review
      after: execute_plan
      when:
        all:
          - artifact_field:
              artifact: execution_result
              field: risk_level
              equals: high
      action:
        start_tasks:
          - specialist_review
```

Completion policy checks canonical task/artifact state:

```yaml
completion_policy:
  all_success:
    - execute_plan
  one_of:
    - specialist_verify
    - human_verify
  on_satisfied:
    type: complete_work_item
    workflow_state: completed
```

Exception policy handles abnormal path only:

```yaml
exception_policy:
  rules:
    - name: review_failed_returns_to_execution
      match:
        artifact_kind: review_result
        status: failed_retryable
      action:
        type: return_to_stage
        target_stage: execution
        carry_forward:
          - feedback_for_execution
```

The evaluator implementation can share predicate/action machinery across routing, completion, and exception, but event semantics must remain separate.

## Runtime Component Boundaries

Southstar is a control plane. The evaluator owns decisions; other components submit facts or execute commands.

Components:

```text
store = transactional persistence for work_items, work_item_tasks, work_item_history
evaluator = validates facts, reduces state, decides next graph actions
scheduler = computes ready declared DAG nodes from workflow snapshot and task state
dispatcher = turns evaluator dispatch commands into host adapter calls
host adapter = executes root sessions/task children and reports events/artifacts
projection worker = syncs source/projection systems and reports projection results
dashboard/read model = observes store and history, never mutates lifecycle directly
operator action handler = records explicit human actions for evaluator processing
```

Boundary rules:

- Evaluator is the only component that mutates `runtime_status`, `workflow_state`, `current_stage`, and `current_stage_attempt`.
- Scheduler does not mutate state; it proposes ready nodes from immutable workflow snapshot and current task rows.
- Dispatcher does not choose workflow direction; it executes evaluator-issued dispatch commands idempotently.
- Host adapters do not decide success of the workflow; they report task events, session ids, and artifacts.
- Projection workers do not fail or complete work items directly; they report projection artifacts/events consumed by evaluator.
- Dashboard actions are operator events; evaluator decides whether they resume, cancel, quarantine, or retry.
- All component outputs must be written through `work_item_history` with idempotency keys before or within the same transaction that changes runtime state.
- Southstar v1 does not add a separate dispatch table; dispatch commands are represented by `work_item_tasks` rows in `queued` state plus `work_item_history` dispatch events.

Decision flow:

```text
event/artifact/operator action
  -> store append/history
  -> evaluator validates and reduces
  -> scheduler computes ready nodes
  -> evaluator writes state/task/history transaction
  -> dispatcher executes pending dispatch commands
  -> host/projection adapters report new facts
```

## Runtime Evaluator

Every task update or artifact submission runs the evaluator.

Order:

```text
1. Apply task status/artifact update.
2. Validate artifact schema, work item binding, task binding, and secret safety.
3. If abnormal status or validation failure, evaluate exception_policy.
4. Otherwise evaluate routing_policy.
5. Use scheduler to compute newly ready declared DAG nodes.
6. Evaluate completion_policy.
7. If stage completed, transition to next stage or terminal runtime_status.
8. Persist work_items, work_item_tasks, work_item_history, and dispatch commands transactionally.
9. Dispatcher executes pending dispatch commands idempotently.
```

Stage start:

```text
work_item.current_stage = analysis
work_item.current_stage_attempt = previous attempt + 1
work_item.root_session_id = new stage root session
work_item.runtime_status = active
work_item.workflow_state = workflow.stages.analysis.workflow_state
work_item_tasks kind=stage_root inserted
```

Task dispatch:

```text
ready task = no dependencies, or all dependency task attempts succeeded
```

The host adapter maps `task_child` to whatever the host supports:

- Codex native subagent if available, otherwise thread/child-run adapter.
- Pi agent session or child prompt.
- OpenCode child session/prompt.
- Simulated child run if host lacks native subagent, while preserving Southstar task semantics.

## Race Condition Controls

Southstar v1 must treat race control as part of the runtime design, not an afterthought.

Required controls:

- `work_items.version` optimistic lock.
- Transaction boundary around every update to `work_items`, `work_item_tasks`, and `work_item_history`.
- Idempotency key for task dispatch and history writes.
- Unique task identity by work item, stage, stage attempt, task id, and task attempt.
- Artifact submissions must include task run id and stage attempt.
- Artifact from old stage attempt is audited but cannot advance current work item state.
- Evaluator is the only code allowed to mutate `work_items.runtime_status`, `work_items.workflow_state`, `current_stage`, and `current_stage_attempt`.
- Host callbacks can record events/artifacts but cannot directly mutate work item state.
- Terminal statuses cannot be changed back to active except by explicit operator action.

Race cases to test:

- Two watchers start the same work item.
- Two evaluator cycles dispatch the same task.
- Routing policy tries to start the same downstream task twice.
- Task artifact arrives after stage retry moved to a new attempt.
- Completion policy and exception policy compete after near-simultaneous task outcomes.
- Heartbeat and task failure update the same work item concurrently.
- Operator resume and background reconcile happen concurrently.

Optimistic update shape:

```sql
UPDATE work_items
SET version = version + 1, ...
WHERE id = ? AND version = ?
```

If no row is updated, the evaluator must reload current state and re-evaluate.

## Southstar Workflow Skill

The workflow skill is the primary authoring tool. It produces:

```text
workflow design spec
.southstar/agents.yaml draft
.southstar/packs/<domain>/ draft
.southstar/workflows/<workflow-id>.yaml draft
```

Interaction shape:

```text
1. Workflow objective
2. Domain and work item type
3. Source/projection mode
4. Agent team design
5. Stage list
6. Tasks per stage
7. Task dependencies
8. Artifacts and success criteria
9. Routing branches
10. Completion policy
11. Exception/retry policy
12. Output review
```

The skill should not ask users to hand-author YAML. It should ask domain questions, generate human-readable design spec, generate YAML, run validation, show summary/diff/risk, then ask before writing.

Required supporting CLI:

```bash
southstar workflow lint .southstar/workflows/<id>.yaml
southstar workflow explain .southstar/workflows/<id>.yaml
southstar workflow simulate --workflow .southstar/workflows/<id>.yaml --fixture <work-item-fixture>
southstar pack explain .southstar/packs/<domain>
```

## CLI Surface

Southstar v1 should expose:

```bash
southstar doctor --config .southstar.yaml
southstar work create --workflow <id> --type <type>
southstar work import --source <provider>
southstar intake --source <provider>
southstar projection sync --provider <provider>
southstar pack list
southstar pack install <domain>
southstar pack lint <domain-or-path>
southstar pack explain <domain>
southstar workflow lint
southstar workflow explain
southstar workflow simulate
southstar watch
southstar inspect --work <id-or-source-ref>
```

`work create` can be implemented by skill helper first, but runtime should expose an eventual CLI path that writes SQLite directly for local/hybrid modes.

## Testing Strategy

Minimum test groups:

- Workflow parser accepts dynamic stage/task graph and rejects broken references.
- Workflow parser enforces workflow_state to fixed runtime_status mapping.
- Domain pack loader validates `pack.yaml`, agents, prompts, artifact schemas, fixtures, source mapping, projection mapping, dashboard views, and lint rules.
- Domain pack overrides resolve deterministically into work item snapshots.
- Agent catalog resolver applies defaults and task overrides.
- Prompt refs are resolved into immutable work item workflow snapshot.
- Artifact registry validates required fields, normalized statuses, query fields, and schema versions.
- Rejected artifacts are audited and cannot advance runtime state.
- Artifact lineage records producing task row, stage attempt, task attempt, schema version, and validation result.
- Local mode creates SQLite work item without external credentials.
- Remote mode creates/intakes external source record.
- Hybrid mode creates SQLite work item and later projection state.
- Evaluator is the only component that mutates work item lifecycle fields.
- Scheduler computes ready DAG nodes without mutating state.
- Dispatcher executes queued task rows idempotently and does not choose workflow direction.
- Host adapter and projection worker events are consumed as facts, not direct lifecycle mutations.
- Evaluator dispatches dependency-free tasks.
- Evaluator waits for dependencies before downstream task.
- Routing policy starts conditional task from artifact field.
- Completion policy handles `all_success` and `one_of`.
- Exception policy retries task/stage and quarantines on exhausted attempts.
- Artifact from stale stage attempt is audited but ignored for state progression.
- Duplicate dispatch is idempotent.
- Optimistic lock conflict reloads and re-evaluates.
- Dashboard/read-model can list root and task sessions from `work_item_tasks`.
- Software delivery pack can map GitHub issue/PR concepts without changing core tables.

## Acceptance Criteria

- Southstar can create a local SQLite work item with no external credentials.
- Southstar can lint and explain a domain pack manifest, workflows, agents, prompts, artifact schemas, mappings, fixtures, and dashboard view references.
- Southstar can resolve `.southstar/agents.yaml`, domain pack assets, and workflow YAML into an immutable work item workflow snapshot.
- A workflow state must map to one fixed runtime status.
- A stage starts a root session and records it as `work_item_tasks.kind=stage_root`.
- A task starts a child/subagent run and records session ids as `work_item_tasks.kind=task_child`.
- A task artifact is stored on `work_item_tasks.artifact_json` with queryable `artifact_kind` and `artifact_status`.
- A task artifact must validate against the resolved artifact registry before policies can use it.
- Rejected artifacts are recorded in history but cannot route, complete, retry, or fail the work item.
- Evaluator, scheduler, dispatcher, host adapter, projection worker, and dashboard boundaries are testable as separate contracts.
- Routing policy can branch based on artifact field without entering exception state.
- Completion policy advances stage only after configured task graph conditions are met.
- Exception policy handles failed/blocked task outcomes separately from normal routing.
- Concurrent duplicate starts do not create duplicate task runs.
- Projection adapter failure does not block runtime when projection policy says non-blocking.
- Workflow skill can produce design spec, agents draft, domain pack draft, workflow YAML draft, and run lint/explain/simulate before writing.
- Software delivery can be installed as a domain pack, and Southstar core remains runnable without it.

## Implementation Direction

Implementation should start from a new `southstar` repo cloned from Northstar for reusable code context only. The first implementation plan should avoid migration and instead build generic core first:

1. New config paths and CLI naming.
2. Three-table SQLite store with `work_items`, `work_item_tasks`, and `work_item_history`.
3. Domain pack manifest, loader, lint, explain, override, and snapshot resolver.
4. Artifact registry, schema validation, normalized statuses, lineage, and rejected-artifact history.
5. Agent catalog and workflow parser/resolver with DAG constraints.
6. Work item creation in local mode.
7. Evaluator, scheduler, dispatcher, host adapter callback, and projection worker boundaries.
8. Stage root and task dispatch evaluator.
9. Policy evaluation using validated artifact facts only.
10. Race/idempotency tests.
11. Workflow lint/explain/simulate.
12. Software delivery pack as first pack.
13. Workflow skill authoring support that generates pack assets, not just workflow YAML.
14. Optional remote/hybrid source/projection adapters.

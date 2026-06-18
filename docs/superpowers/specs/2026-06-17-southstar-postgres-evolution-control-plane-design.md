# Southstar Postgres Evolution Control Plane Design

Date: 2026-06-17
Status: proposed

## 1. Purpose

Southstar should evolve from a workflow runner with ad-hoc memory into a self-improving control plane. The target loop is:

```text
observe -> distill -> improve -> validate -> promote -> monitor -> rollback
```

This design intentionally avoids mem0, RAG, embedding search, and runtime semantic retrieval in the first version. Southstar stores canonical learning/evolution truth in its own Postgres schema, distills repeated evidence into Knowledge Cards, deterministically selects relevant cards for future tasks, and uses those cards to generate bounded prompt, skill, agent profile, and flow deltas.

## 2. Goals

- Use a single Postgres database with separate `tork` and `southstar` schemas.
- Make `southstar` schema the canonical runtime, learning, knowledge, evolution, and audit store.
- Keep Tork executor-only; Southstar must not directly read/write Tork internal tables.
- Remove SQLite fallback and use Postgres-only tests.
- Avoid mem0, RAG, `recall_documents`, and pgvector in the first version.
- Store memory as typed Knowledge Cards in the Southstar learning graph.
- Support self-evolution of:
  - Knowledge Cards,
  - prompt templates,
  - skills,
  - agent profiles,
  - workflow / flow policy proposals.
- Require sandbox validation before asset promotion.
- Auto-activate low/medium-risk Knowledge Cards after validation; require human approval for high-risk cards.
- Auto-promote low-risk prompt, skill, and agent profile changes when sandbox validation passes.
- Use canary for medium-risk agent profile changes.
- Require human approval for flow changes and high-risk profile/security changes.
- Provide an Evolution Control Center UI with graph visualization.

## 3. Non-goals

- No mem0 integration in the first version.
- No RAG retriever, vector memory store, runtime semantic query planner, or embedding model requirement.
- No `recall_documents` table in the first version.
- No SQLite runtime fallback.
- No SQLite-to-Postgres migration path; the project is still in development and can switch directly.
- No migration framework in the first version.
- No direct SQL coupling to `tork.*` tables.
- No use of Tork job status as Southstar task completion truth.
- No full transcript long-term memory extraction.
- No cloud embedding API.
- No automatic flow promotion.
- No automatic tool/MCP grant expansion.
- No graph database dependency such as Neo4j, Apache AGE, or ArangoDB in the first version.
- No full RBAC in the first version; every mutating command must still record actor, reason, and audit event.

## 4. Postgres storage model

### 4.1 Database layout

Use one Postgres database with two schemas:

```text
automation database
  ├─ tork       -- owned by Tork
  └─ southstar  -- owned by Southstar
```

Southstar runtime must treat Postgres as shared infrastructure, not shared truth. Tork observation still goes through `TorkClient` / executor adapter APIs.

### 4.2 Schema initialization

Provide an explicit initialization command:

```bash
npm run southstar -- db:init --config .northstar.yaml
```

The command creates and validates `southstar` schema objects:

- `CREATE SCHEMA IF NOT EXISTS southstar`.
- Required UUID support, for example `pgcrypto`.
- Runtime tables.
- Learning graph tables.
- Asset version and evolution resource tables where dedicated tables are useful.
- `southstar.schema_metadata` with schema name and version.

Runtime startup must not auto-create or mutate schema. It should validate schema metadata and fail fast with a clear message if `db:init` has not run.

### 4.3 Postgres-only tests

All DB-backed tests use Postgres. Each test run creates a unique test database:

```text
create database southstar_test_<uuid>
run db:init
run tests
drop database
```

Pure unit tests may avoid DB. There is no SQLite test fallback.

## 5. Runtime truth boundaries

The existing Southstar runtime truth model remains:

```text
southstar.workflow_runs
southstar.workflow_tasks
southstar.workflow_history
southstar.runtime_resources
```

Rules:

- `workflow_history` is event/audit truth.
- `runtime_resources` stores durable resources/projections/asset records.
- Resource mutation and relevant history append must happen in one Southstar transaction.
- External executor observations cannot directly complete workflow tasks.
- Artifact validation, evaluator pipelines, and stop conditions remain completion truth.
- Southstar code and tests must reject direct SQL references to `tork.*`.

## 6. Learning graph

The learning graph is canonical evolution memory. It captures evidence, causality, asset lineage, validation outcomes, promotion, rollback, and Knowledge Cards.

### 6.1 Tables

#### `southstar.learning_nodes`

Fields:

```text
id
node_type
scope
status
run_id
task_id
session_id
resource_ref
payload_jsonb
summary_text
created_at
updated_at
```

Node types include:

```text
run
task
session_checkpoint
context_packet
artifact
evaluator_result
repair_attempt
failure_kind
learning_signal
knowledge_card
delta_proposal
prompt_version
skill_version
agent_profile_version
flow_policy_version
sandbox_experiment
promotion
rollback
```

#### `southstar.learning_edges`

Fields:

```text
id
from_node_id
edge_type
to_node_id
weight
evidence_jsonb
created_at
```

Edge types include:

```text
USED_PROFILE
USED_PROMPT
USED_SKILL
INJECTED_CARD
PRODUCED
EVALUATED_BY
FOUND_FAILURE
FIXED_FAILURE
DERIVED_FROM
SUPPORTED_BY
BASED_ON
TESTED
PROMOTED_TO
SUPERSEDES
ROLLED_BACK_TO
HELPED
HURT
CONFLICTS_WITH
```

### 6.2 Queries the graph must support

- Which agent profile version works best for an intent/task family?
- Which skill version lowered repair count?
- Which prompt delta increased cost or failure rate?
- Which Knowledge Cards were injected into successful or failed tasks?
- Which sandbox experiment justified an asset promotion?
- Which rollback target is safe for a regressed asset?
- What evidence supports a Knowledge Card claim?
- What downstream deltas/promotions were based on a Knowledge Card?

## 7. Knowledge Cards

Knowledge Cards replace runtime semantic recall. Southstar does not search arbitrary chunks at runtime. Instead, it periodically distills repeated evidence into typed, cited cards and later selects cards deterministically from task metadata.

A Knowledge Card is stored as:

```text
learning_nodes.node_type = 'knowledge_card'
learning_nodes.payload_jsonb = full card payload
```

A dedicated `southstar.knowledge_cards` table may be added later as a read-optimized projection, but the canonical first-version representation is the graph node.

### 7.1 Card schema

```ts
type KnowledgeCard = {
  cardType:
    | "failure_lesson"
    | "success_pattern"
    | "profile_lesson"
    | "flow_lesson"
    | "preference"
    | "domain_pattern";
  topicKey: string;
  scope: string;
  title: string;
  summary: string;
  appliesTo: {
    intents?: string[];
    roles?: string[];
    artifactTypes?: string[];
    agentProfiles?: string[];
    promptTemplates?: string[];
    skills?: string[];
    flowTemplates?: string[];
  };
  claims: Array<{
    text: string;
    evidenceNodeRefs: string[];
  }>;
  confidence: number;
  successScore: number;
  status: "candidate" | "active" | "pending_approval" | "stale" | "superseded" | "rejected" | "do_not_inject";
  riskTier: "low" | "medium" | "high";
};
```

Rules:

- Every claim must cite existing evidence nodes.
- Cards cannot include raw transcripts, large logs, or secret-like payloads.
- Cards are concise; they summarize stable lessons, not entire conversations.
- Cards carry explicit `appliesTo` fields so runtime selection is deterministic.

### 7.2 Example

```json
{
  "cardType": "failure_lesson",
  "topicKey": "implementation-report-self-check",
  "scope": "software",
  "title": "Implementation report self-check",
  "summary": "Implementation agents often miss commandsRun and risks unless the prompt or skill includes a final artifact checklist.",
  "appliesTo": {
    "intents": ["implement_feature", "fix_bug"],
    "roles": ["maker"],
    "artifactTypes": ["implementation_report"],
    "agentProfiles": ["software-maker-pi"]
  },
  "claims": [
    {
      "text": "Adding a final artifact checklist reduces schema repair loops.",
      "evidenceNodeRefs": ["eval-123", "repair-456", "experiment-789"]
    }
  ],
  "confidence": 0.86,
  "successScore": 0.81,
  "status": "active",
  "riskTier": "low"
}
```

### 7.3 Card lifecycle

```text
candidate -> active
candidate -> pending_approval -> active
candidate -> rejected
active -> stale
active -> superseded
active -> do_not_inject
```

Activation policy:

- low/medium-risk cards: validator pass -> active,
- high-risk cards: validator pass -> pending approval,
- rejected cards remain auditable,
- superseded cards are not injected,
- do-not-inject cards are excluded from ContextBuilder.

High-risk cards include lessons that recommend tool/MCP changes, broad memory scope changes, model/provider changes, flow/retry strategy changes, release/deploy/security changes, or claims that conflict with existing high-confidence cards.

## 8. Learning signal pipeline

The runtime records learning signals immediately, but synthesizes Knowledge Cards in batch.

### 8.1 Runtime signal capture

Structured sources only:

- accepted artifact summaries,
- evaluator results,
- repair requested / repair succeeded,
- failure summaries,
- session checkpoint `transcriptSummary`,
- context packets,
- Knowledge Card injection traces,
- workflow generation plans,
- cost, duration, retry, and tool-call metrics,
- sandbox experiment outcomes,
- promotion regression outcomes.

Full transcripts are not extracted into long-term memory.

Example signal:

```json
{
  "signalKind": "repair_success",
  "runId": "run-123",
  "taskId": "implement-feature",
  "roleRef": "maker",
  "agentProfileRef": "software-maker-pi",
  "artifactType": "implementation_report",
  "failureKind": "missing_required_field",
  "missingFields": ["commandsRun", "risks"],
  "repairInstruction": "include commandsRun and risks",
  "outcome": "passed_after_repair",
  "sourceRefs": ["artifact-1", "eval-1", "checkpoint-1"]
}
```

### 8.2 Batch Knowledge Card synthesis

Trigger card synthesis by:

- manual command from Evolution UI,
- run completed event,
- every N learning signals,
- scheduled background job after the first version is stable.

First-version default should support manual trigger and run-completed batch. Avoid making a single task failure immediately become active long-term knowledge.

Pipeline:

```text
LearningSignalCollector
  -> SignalClusterer
  -> CardCandidateBuilder
  -> CardSynthesizer
  -> CardValidator
  -> CardPromoter
```

### 8.3 Signal clustering

Cluster signals with deterministic structured keys, not embeddings:

```text
scope
intent
roleRef
artifactType
failureKind
missingFields
agentProfileRef
skillRef
promptTemplateRef
flowTemplateRef
```

Example cluster key:

```text
software:maker:implementation_report:missing_required_field:commandsRun-risks
```

### 8.4 Candidate thresholds

A cluster can become a card candidate when:

- support count is at least 2 or 3,
- or there is high-value evidence such as repair success plus sandbox pass,
- or evaluator failure repeats across runs,
- or an operator manually marks the cluster for synthesis.

Candidate mapping:

| Signal pattern | Card type |
| --- | --- |
| evaluator failure + repair success | `failure_lesson` |
| accepted artifacts repeatedly use same pattern | `success_pattern` |
| profile/model/skill correlation | `profile_lesson` |
| workflow repeatedly needs fork/checker | `flow_lesson` |
| repeated user/operator preference | `preference` |
| architecture/evaluator rule discovered | `domain_pattern` |

### 8.5 Card synthesis and validation

An LLM may summarize a signal cluster into card JSON, but it only acts as a bounded summarizer. It cannot invent evidence, access full transcripts, change assets, or promote cards.

Validator checks:

- stable `topicKey`,
- valid `appliesTo` fields,
- every claim has existing `evidenceNodeRefs`,
- no secret-like values,
- no raw transcript/log dump,
- summary and claims stay under size limits,
- no unhandled conflict with an active high-confidence card,
- high-risk cards are routed to approval instead of auto-activation.

## 9. ContextBuilder card selection

ContextBuilder does not perform semantic search. It selects active Knowledge Cards by matching typed task metadata.

```text
Task context:
  intent
  role
  artifact contracts
  agent profile
  prompt template
  skills
  flow template

ContextBuilder:
  -> query active knowledge_card nodes
  -> match appliesTo fields
  -> exclude superseded / do_not_inject / conflicting cards
  -> rank by evidence strength + successScore + confidence + recency
  -> inject top N as ContextBlocks
  -> persist knowledge_card_injection_trace
```

Selection is deterministic and explainable. The injection trace records:

- matched task metadata,
- selected card refs,
- excluded card refs,
- exclusion reasons,
- evidence score,
- confidence/success score,
- context token contribution.

This replaces `memory_injection_trace` with a card-specific trace. The old term may remain as a compatibility alias only if needed by existing UI.

## 10. Delta generation from Knowledge Cards

Delta generation consumes active cards, evidence subgraphs, and asset performance metrics.

```text
active Knowledge Cards
+ evidence subgraph
+ asset performance metrics
-> deterministic hypothesis
-> schema-valid DeltaProposal
```

### 10.1 Card type to delta type

| Knowledge Card | Likely Delta |
| --- | --- |
| `failure_lesson` | `prompt_delta` / `skill_delta` |
| `success_pattern` | `skill_delta` / card reinforcement |
| `profile_lesson` | `agent_profile_delta` |
| `flow_lesson` | `flow_delta` |
| `preference` | `prompt_delta` / context policy hint |
| `domain_pattern` | `skill_delta` / `flow_delta` |

### 10.2 Rule examples

```text
IF cardType=failure_lesson
AND failureKind=missing_required_field
AND appliesTo.artifactTypes includes implementation_report
THEN propose prompt_delta adding final artifact self-check instruction.
```

```text
IF same failure_lesson has supportCount >= 3
AND summary describes repeatable procedure
THEN propose skill_delta adding a checklist/section.
```

```text
IF skill_version is linked to lower repair rate
AND cardType=profile_lesson
THEN propose agent_profile_delta adding or preferring that skill version.
```

```text
IF cardType=flow_lesson
AND repeated checker/fork repair improves outcome
THEN propose flow_delta adding a generator policy hint or checker stage.
```

### 10.3 Delta proposal schema

```ts
type DeltaProposal = {
  id: string;
  deltaKind:
    | "knowledge_card_delta"
    | "prompt_delta"
    | "skill_delta"
    | "agent_profile_delta"
    | "flow_delta";
  targetRef?: string;
  targetVersion?: string;
  sourceCardRefs: string[];
  sourceNodeRefs: string[];
  evidenceSubgraphHash: string;
  hypothesis: string;
  patch: unknown;
  riskTier: "low" | "medium" | "high";
  validationPlan: {
    regressionSuiteRefs: string[];
    replayRunRefs: string[];
    maxCostRegressionPercent: number;
    maxDurationRegressionPercent: number;
    minReplayFixRate?: number;
  };
  rollbackPlan: {
    previousVersionRef?: string;
    strategy: "revert-version" | "disable-delta" | "manual";
  };
  status:
    | "proposed"
    | "validating"
    | "validated"
    | "rejected"
    | "promoted"
    | "rolled_back";
};
```

Persist proposals in `runtime_resources(resource_type='delta_proposal')` and as learning graph nodes/edges. A dedicated `delta_proposals` table can be added later if query volume requires it.

### 10.4 Delta validation

Validators reject:

- nonexistent targets,
- wrong target version,
- invalid source cards or source nodes,
- secret-like payloads,
- raw transcript or oversized logs,
- patch outside allowed fields/sections,
- runtime invariant changes,
- flow delta auto-promotion.

## 11. Delta kinds

### 11.1 Knowledge card delta

Creates, updates, supersedes, or marks Knowledge Cards stale/do-not-inject. Activation follows card risk policy.

### 11.2 Prompt delta

Changes prompt template versions, usually by appending or replacing bounded sections. Low-risk prompt deltas auto-promote after sandbox pass.

### 11.3 Skill delta

Creates a new skill version, usually by adding or updating a documented procedure/checklist. Low-risk skill deltas auto-promote after sandbox pass. Promotions create versioned assets and rollback targets.

### 11.4 Agent profile delta

Agent profile is a versioned capability bundle:

```text
model
promptTemplateRef
skillRefs
knowledgeCardScopes
contextPolicyRef
sessionPolicyRef
toolPolicy
budgetPolicy
```

Risk model:

| Change | Risk |
| --- | --- |
| Use already validated skill version | low |
| Switch model inside allowed pool | medium |
| Modest budget change | medium |
| Add tool/MCP grant | high |
| Broaden Knowledge Card scope | high |
| Change role default mapping globally | high |

Promotion:

- low risk: auto-promote after sandbox pass,
- medium risk: canary after sandbox pass,
- high risk: human approval.

### 11.5 Flow delta

Changes workflow template hints, generator policy hints, task DAG strategy, checker/fork/retry strategy. Flow delta always requires human approval in the first version, even after sandbox pass.

## 12. Sandbox validation

Sandbox validation proves that a candidate delta is no worse than baseline and fixes the targeted issue when applicable.

### 12.1 Strategy

Use mixed evaluation:

```text
fixed regression suite
+ recent failure replay
+ cost/time guard
```

### 12.2 Experiment structure

Each `DeltaProposal` creates a `SandboxExperiment` resource and graph node.

```text
DeltaProposal
  -> SandboxExperiment
      -> baseline trials
      -> candidate trials
      -> comparison
      -> decision
```

Example experiment payload:

```json
{
  "deltaProposalId": "delta-123",
  "baselineAssetRefs": ["prompt-software-maker@v3"],
  "candidateAssetRefs": ["prompt-software-maker@v4-candidate"],
  "regressionSuiteRefs": ["software-core-regression"],
  "replayRunRefs": ["run-101", "run-102"],
  "maxCostRegressionPercent": 10,
  "maxDurationRegressionPercent": 15
}
```

### 12.3 Case sources

Fixed regression suites prevent broad regressions. Each case defines:

- input prompt,
- domain/intent,
- expected artifact contract,
- evaluator pipeline,
- optional fixture repo/worktree,
- success criteria,
- cost/duration limits.

Recent failure replay uses evidence behind the source Knowledge Card or learning signal. Replay cases preserve:

- same goal prompt or summarized task input,
- same artifact contract,
- same evaluator pipeline,
- same relevant context summary,
- same workspace snapshot when available.

### 12.4 Baseline vs candidate execution

For each case, run two variants:

```text
baseline: active asset versions
candidate: active versions + candidate delta version
```

Examples:

- prompt delta: baseline prompt v3 vs candidate prompt v4-candidate,
- skill delta: baseline skill v1 vs candidate skill v2-candidate,
- profile delta: baseline profile v3 vs candidate profile v4-candidate,
- flow delta: baseline workflow generation vs candidate generation with flow hint.

### 12.5 Sandbox isolation

Sandbox cannot pollute production runs.

Use the normal Southstar/Tork/Pi execution path but mark all records:

```text
run_mode = "sandbox"
sandbox_experiment_id = "exp-123"
```

Sandbox creates isolated resources:

```text
sandbox_run
sandbox_task
sandbox_session
sandbox_worktree
sandbox_context_packet
sandbox_artifact
sandbox_evaluator_result
```

Tork still only executes Docker tasks. Tork completion does not mean sandbox pass; evaluator/comparison decides.

Sandbox Tork tasks receive environment markers:

```text
SOUTHSTAR_RUN_MODE=sandbox
SOUTHSTAR_SANDBOX_EXPERIMENT_ID=...
```

Workspace isolation uses temporary git worktrees, fixture copies, or read-only replay when no mutation is needed.

### 12.6 Trial lifecycle

```text
queued -> materializing -> running -> evaluating -> passed / failed / cancelled
```

Trial payload:

```json
{
  "trialId": "trial-1",
  "experimentId": "exp-123",
  "variant": "baseline",
  "caseRef": "replay-run-101",
  "runId": "sandbox-exp-123-baseline-1",
  "assetRefs": ["prompt@v3"],
  "status": "passed",
  "artifactRef": "artifact-...",
  "evaluatorResultRefs": ["eval-..."],
  "metrics": {
    "durationMs": 120000,
    "tokens": 10000,
    "costMicrosUsd": 3000,
    "repairCount": 0,
    "toolCalls": 12
  }
}
```

### 12.7 Decision rules

Candidate passes when:

- candidate pass rate is at least baseline pass rate,
- targeted replay failure is fixed,
- cost stays within threshold,
- duration stays within threshold,
- no blocked/high-risk failure kind is introduced,
- required evaluator gates pass.

First-version shortcut:

- support prompt and skill sandbox first,
- use existing Tork/Pi harness execution path,
- require at least one regression case and one replay case when available,
- run baseline/candidate once per case initially,
- flow delta only performs dry-run DAG validation plus human approval,
- medium-risk profile delta requires canary even after sandbox pass.

## 13. Asset versioning and promotion

Promotion never overwrites current content. It creates a new asset version.

```ts
type AssetVersion = {
  id: string;
  assetKind: "prompt_template" | "skill" | "agent_profile" | "flow_policy";
  assetRef: string;
  version: string;
  parentVersion?: string;
  contentHash: string;
  payload: unknown;
  status: "candidate" | "active" | "canary" | "superseded" | "rolled_back" | "rejected";
  promotedByDeltaId?: string;
  createdAt: string;
};
```

Promotion matrix:

| Delta kind | First-version behavior |
| --- | --- |
| `knowledge_card_delta` | Low/medium auto-active after validation; high-risk approval |
| `prompt_delta` | Auto-promote after sandbox pass |
| `skill_delta` | Auto-promote after sandbox pass |
| Low-risk `agent_profile_delta` | Auto-promote after sandbox pass |
| Medium-risk `agent_profile_delta` | Canary after sandbox pass |
| High-risk `agent_profile_delta` | Human approval |
| `flow_delta` | Human approval |

## 14. Canary and rollback

### 14.1 Canary routing

`AgentProfileResolver` chooses baseline or candidate by deterministic hash of run/task identity and canary percentage. Canary state is stored as asset/promotion metadata.

### 14.2 Regression monitor

A background job monitors recently promoted or canary assets:

- evaluator failure rate,
- repair count,
- replay pass rate,
- cost/duration,
- token usage,
- new failure kinds.

Regression triggers rollback for auto-promoted low-risk assets or an approval alert for high-risk assets.

### 14.3 Rollback

Rollback never deletes history or versions. It appends rollback facts, marks bad versions, restores the previous active version, and creates a learning signal such as `promotion_regressed`.

## 15. Graph API and visualization

Postgres stores the graph; it does not draw it. Southstar exposes graph read models, and the UI renders them.

### 15.1 Graph API

```text
GET /api/v2/evolution/graph?nodeId=...
GET /api/v2/evolution/graph/card/:cardId
GET /api/v2/evolution/graph/delta/:deltaId
GET /api/v2/evolution/graph/asset/:assetVersionId
```

Read models return:

```ts
type GraphReadModel = {
  centerNodeId: string;
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    status?: string;
    summary?: string;
    payload?: unknown;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    type: string;
    weight?: number;
  }>;
};
```

Backend helpers:

```text
getEvidenceSubgraph(nodeId, depth, filters)
getLineage(nodeId)
getImpactGraph(assetVersionId)
getKnowledgeCardEvidence(cardId)
```

Use SQL edge queries and recursive CTEs where needed. Do not introduce a graph database or graph extension in the first version.

### 15.2 UI visualization

Use a frontend graph visualization library, preferably React Flow for the first version, to render local subgraphs:

- Knowledge Card evidence graph,
- Delta proposal evidence graph,
- Sandbox experiment graph,
- Asset version lineage graph,
- Rollback impact graph.

Do not render the entire graph by default. Load small local neighborhoods around the selected node.

## 16. Evolution Control Center UI

Self-evolution needs a dedicated top-level UI surface, not a subpanel inside Sessions/Memory.

### 16.1 Questions the UI must answer

- What has Southstar recently learned?
- Which Knowledge Cards are active, pending approval, stale, or do-not-inject?
- Which deltas are proposed, validating, promoted, rejected, or awaiting approval?
- Which sandbox experiments passed or failed?
- Which prompt/skill/profile versions are active?
- Which flow deltas need human approval?
- Why was an asset promoted?
- Did a promotion cause regression?
- What rollback target is available?
- Which cards helped or hurt?

### 16.2 Page sections

- Evolution Health Overview.
- Learning Signal Feed.
- Knowledge Card Library.
- Delta Proposal Queue.
- Sandbox Experiments.
- Asset Version Registry.
- Canary / Regression Monitor.
- Graph Viewer.

### 16.3 API surface

```text
GET  /api/v2/evolution/overview
GET  /api/v2/evolution/signals
GET  /api/v2/evolution/cards
GET  /api/v2/evolution/cards/:id
POST /api/v2/evolution/cards/:id/approve
POST /api/v2/evolution/cards/:id/reject
POST /api/v2/evolution/cards/synthesize
GET  /api/v2/evolution/deltas
GET  /api/v2/evolution/deltas/:id
POST /api/v2/evolution/deltas/:id/approve
POST /api/v2/evolution/deltas/:id/reject
POST /api/v2/evolution/deltas/:id/run-sandbox
GET  /api/v2/evolution/experiments
GET  /api/v2/evolution/assets
GET  /api/v2/evolution/assets/:id
POST /api/v2/evolution/assets/:id/rollback
GET  /api/v2/evolution/graph?nodeId=...
```

All mutating commands record actor, reason, command id, and audit event.

## 17. Testing strategy

### 17.1 Test bootstrap

```text
create database southstar_test_<uuid>
run db:init
run tests
drop database
```

### 17.2 Required test groups

- Schema/init tests.
- Runtime compatibility tests.
- No direct `tork.*` SQL tests.
- Learning graph node/edge/lineage/evidence tests.
- Learning signal capture tests.
- Signal clustering and Knowledge Card synthesis tests.
- Knowledge Card validation, approval, supersede, and do-not-inject tests.
- ContextBuilder deterministic card selection and injection trace tests.
- Delta classifier and validator tests.
- Sandbox baseline/candidate tests.
- Promotion/canary/rollback tests.
- Graph read model/API tests.
- Evolution UI read model/API tests.

## 18. Risks and mitigations

### Scope risk

This is a large change. Implement in phases: Postgres store, learning graph, signals, Knowledge Cards, deterministic card selection, delta model, sandbox, promotion, UI.

### Postgres setup burden

Provide clear `db:init`, test bootstrap, configuration examples, and fail-fast startup validation.

### Knowledge drift

Require evidence-backed card claims, card validation, human approval for high-risk cards, deterministic selection, sandbox validation for deltas, regression monitoring, and rollback.

### Weak semantic recall without RAG

This is an explicit first-version tradeoff. Southstar prioritizes deterministic, evidence-backed knowledge over fuzzy recall. If needed later, a separate recall index can be introduced as a non-canonical helper.

### Security/tooling drift

Tool/MCP grants, broad Knowledge Card scope changes, large budget increases, and flow changes are high-risk and require human approval.

### Tork coupling

Keep schemas separate and ban direct SQL references to `tork.*` in Southstar code/tests. Tork remains executor-only.

### Graph complexity

Only render local subgraphs and provide bounded graph queries. Avoid whole-graph visualization and external graph DB dependency in the first version.

## 19. Success criteria

The first version succeeds when:

1. Southstar runs on Postgres `southstar` schema without SQLite fallback.
2. DB-backed tests run Postgres-only with per-run test databases.
3. Southstar does not directly read/write `tork.*` tables.
4. Learning graph captures task, artifact, evaluator, repair, context, Knowledge Card, delta, experiment, promotion, and rollback lineage.
5. A repair success can produce a learning signal.
6. Repeated learning signals can synthesize a schema-valid Knowledge Card with cited evidence.
7. Low/medium-risk Knowledge Cards auto-activate after validation; high-risk cards require approval.
8. ContextBuilder injects Knowledge Cards deterministically by role/intent/artifact/profile and records an injection trace.
9. Active Knowledge Cards can produce schema-valid prompt/skill/profile/flow deltas.
10. Sandbox validation compares baseline and candidate against regression/replay/cost guards.
11. Prompt and skill deltas can auto-promote after sandbox pass.
12. Low-risk profile deltas can auto-promote; medium-risk profile deltas canary; high-risk profile and flow deltas require human approval.
13. Rollback restores previous asset versions without deleting history.
14. Evolution Control Center read models expose signals, cards, deltas, experiments, assets, graph views, canaries, and rollback targets.

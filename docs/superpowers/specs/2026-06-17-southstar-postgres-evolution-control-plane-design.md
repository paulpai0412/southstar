# Southstar Postgres Evolution Control Plane Design

Date: 2026-06-17
Status: proposed

## 1. Purpose

Southstar should evolve from a workflow runner with memory injection into a self-improving control plane. The target loop is:

```text
observe -> recall -> hypothesize -> validate -> promote -> monitor -> rollback
```

The system must learn from accepted artifacts, evaluator results, repair outcomes, checkpoint summaries, context packets, and runtime metrics. It must then propose bounded changes to prompts, skills, agent profiles, memory items, and workflow flow policy. Those changes must be validated in sandbox runs before activation.

This design replaces the earlier mem0 direction with a Postgres-first architecture. Southstar stores canonical learning/evolution truth in its own Postgres schema and uses Postgres full-text search, graph queries, and optional vector search for recall.

## 2. Goals

- Use a single Postgres database with separate `tork` and `southstar` schemas.
- Make `southstar` schema the canonical runtime, learning, recall, evolution, and audit store.
- Keep Tork executor-only; Southstar must not directly read/write Tork internal tables.
- Remove SQLite fallback and use Postgres-only tests.
- Avoid mem0; implement memory/recall with Southstar-owned learning graph and recall index.
- Support self-evolution of:
  - memory / recall items,
  - prompt templates,
  - skills,
  - agent profiles,
  - workflow / flow policy proposals.
- Require sandbox validation before promotion.
- Auto-promote low-risk prompt, skill, and agent profile changes when validation passes.
- Use canary for medium-risk agent profile changes.
- Require human approval for flow changes and high-risk profile/security changes.
- Provide an Evolution Control Center UI/read model.

## 3. Non-goals

- No mem0 integration in the first version.
- No SQLite runtime fallback.
- No SQLite-to-Postgres migration path; the project is still in development and can switch directly.
- No migration framework in the first version.
- No direct SQL coupling to `tork.*` tables.
- No use of Tork job status as Southstar task completion truth.
- No full transcript long-term memory extraction.
- No cloud embedding API.
- No automatic flow promotion.
- No automatic tool/MCP grant expansion.
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
- Required extensions where available:
  - UUID support, for example `pgcrypto`.
  - `pg_trgm` optional for fuzzy search.
  - `vector` optional for pgvector recall tier.
- Runtime tables.
- Learning graph tables.
- Recall index tables and indexes.
- Evolution asset/delta/experiment tables.
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

The learning graph is canonical evolution memory. It captures evidence, causality, asset lineage, validation outcomes, promotion, and rollback.

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
memory_item
learning_signal
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
INJECTED_MEMORY
PRODUCED
EVALUATED_BY
FOUND_FAILURE
FIXED_FAILURE
DERIVED_FROM
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
- Which injected memories helped or hurt evaluator outcomes?
- Which sandbox experiment justified an asset promotion?
- Which rollback target is safe for a regressed asset?

## 7. Recall index

Recall replaces mem0. It is not the source of truth; it is an index over learning graph nodes.

### 7.1 `southstar.recall_documents`

Fields:

```text
id
node_id
scope
kind
text
tsv
embedding optional vector
metadata_jsonb
status
created_at
updated_at
```

`node_id` points to a canonical learning node. Recall documents without resolvable graph nodes are invalid for injection or delta generation.

### 7.2 Recall tiers

Tier 1 is required and default:

```text
Postgres full-text search + graph scoring
```

Tier 2 is optional:

```text
pgvector semantic recall
```

The first version should include provider interfaces and optional vector columns/indexes when available, but runtime defaults to FTS + graph scoring. Tests use deterministic embeddings only when testing vector-specific behavior.

### 7.3 ContextBuilder retrieval pipeline

```text
ContextBuilder
  -> recall search
  -> resolve candidates through learning graph
  -> apply memory policy
  -> rank candidates
  -> persist memory_injection_trace
  -> ContextPacket.selectedMemories
```

Policy checks include:

- scope match,
- allowed kind,
- token budget,
- confidence and success score,
- superseded status,
- do-not-inject decision,
- conflict exclusion,
- harmful/stale penalty.

Ranking combines:

```text
FTS score
+ graph evidence score
+ success score
+ recency
+ confidence
- harmful/stale penalties
```

## 8. Memory model

Memory is a learning graph node plus recall document, not an external black-box store.

Memory kinds remain:

```text
preference
architecture_decision
domain_pattern
failure_lesson
artifact_summary
workflow_learning
```

Example memory payload:

```json
{
  "kind": "failure_lesson",
  "scope": "software",
  "text": "For implementation reports, self-check commandsRun and risks before submitting.",
  "tags": ["artifact", "schema"],
  "confidence": 0.85,
  "successScore": 0.8,
  "sourceRefs": ["eval-123", "repair-456"]
}
```

Memory governance is represented in the graph:

- `SUPERSEDES` for replacement.
- `CONFLICTS_WITH` for incompatible memories.
- do-not-inject decision node/edge for exclusion.
- `HELPED` and `HURT` edges from downstream evaluator outcomes.

## 9. Learning signal pipeline

The runtime records learning signals immediately, but generates deltas in batch.

### 9.1 Runtime signal capture

Structured sources only:

- accepted artifact summaries,
- evaluator results,
- repair requested / repair succeeded,
- failure summaries,
- session checkpoint `transcriptSummary`,
- context packets,
- memory injection traces,
- workflow generation plans,
- cost, duration, retry, tool-call metrics.

Full transcripts are not extracted into long-term memory.

### 9.2 Batch evolution cycle

```text
gather recent learning signals
cluster similar patterns
retrieve related recall documents
build evidence subgraph
generate delta hypotheses
generate schema-valid delta proposals
validate proposals
run sandbox experiments
promote / queue approval / reject
```

## 10. Delta generation

Delta generation is rule-first with optional constrained LLM wording.

### 10.1 Deterministic classifier

Rules produce hypotheses:

```text
missing required field -> prompt_delta for artifact self-check
repeated failure lesson -> skill_delta for durable guidance
validated skill lowers repair count -> agent_profile_delta to use that skill
high cost without quality gain -> agent_profile_delta for cheaper model candidate
repeated task-family repair/fork -> flow_delta generator hint
accepted reusable pattern -> memory_delta
```

### 10.2 Constrained proposal generator

A generator may draft the final JSON, but only inside a schema and policy boundary. Validators reject:

- nonexistent targets,
- wrong target version,
- invalid source references,
- secret-like payloads,
- raw transcript or oversized logs,
- patch outside allowed fields/sections,
- runtime invariant changes,
- flow delta auto-promotion.

### 10.3 `DeltaProposal`

```ts
type DeltaProposal = {
  id: string;
  deltaKind:
    | "memory_delta"
    | "prompt_delta"
    | "skill_delta"
    | "agent_profile_delta"
    | "flow_delta";
  targetRef?: string;
  targetVersion?: string;
  sourceNodeRefs: string[];
  relatedRecallDocumentRefs: string[];
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

Persist proposals in `southstar.delta_proposals`, `runtime_resources`, and learning graph nodes/edges.

## 11. Delta kinds

### 11.1 Memory delta

Creates or updates memory graph nodes and recall documents. Promotion depends on memory policy.

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
memoryScopes
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
| Broaden memory scope | high |
| Change role default mapping globally | high |

Promotion:

- low risk: auto-promote after sandbox pass,
- medium risk: canary after sandbox pass,
- high risk: human approval.

### 11.5 Flow delta

Changes workflow template hints, generator policy hints, task DAG strategy, checker/fork/retry strategy. Flow delta always requires human approval in the first version, even after sandbox pass.

## 12. Sandbox validation

Every nontrivial delta requires sandbox validation.

### 12.1 Strategy

Use mixed evaluation:

```text
fixed regression suite
+ recent failure replay
+ cost/time guard
```

### 12.2 Baseline vs candidate

Baseline uses active asset versions. Candidate uses the proposed version(s) with the same task input, artifact contracts, evaluator pipelines, and stop conditions.

Compare:

- artifact pass rate,
- required field completeness,
- domain evaluator score,
- test/evidence score,
- repair count,
- retry count,
- tool calls,
- duration,
- tokens,
- cost,
- failure kinds.

Candidate must not lower required evaluator pass rate, must fix the replay failure when specified, must stay within cost/duration thresholds, and must not introduce high-risk failures.

### 12.3 `SandboxExperiment`

```ts
type SandboxExperiment = {
  id: string;
  deltaProposalId: string;
  baselineAssetRefs: string[];
  candidateAssetRefs: string[];
  regressionSuiteRefs: string[];
  replayRunRefs: string[];
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  metrics: {
    baseline: ExperimentMetrics;
    candidate: ExperimentMetrics;
    comparison: ExperimentComparison;
  };
  evaluatorResultRefs: string[];
  failureReasons: string[];
};
```

Persist experiments in `southstar.sandbox_experiments` and as learning graph nodes.

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
| `memory_delta` | Policy-controlled |
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

## 15. Evolution Control Center UI

Self-evolution needs a dedicated top-level UI surface, not a subpanel inside Sessions/Memory.

### 15.1 Questions the UI must answer

- What has Southstar recently learned?
- Which deltas are proposed, validating, promoted, rejected, or awaiting approval?
- Which sandbox experiments passed or failed?
- Which prompt/skill/profile versions are active?
- Which flow deltas need human approval?
- Why was an asset promoted?
- Did a promotion cause regression?
- What rollback target is available?
- Which memories helped or hurt?

### 15.2 Page sections

- Evolution Health Overview.
- Learning Signal Feed.
- Delta Proposal Queue.
- Sandbox Experiments.
- Asset Version Registry.
- Canary / Regression Monitor.
- Recall / Memory Quality.

### 15.3 API surface

```text
GET  /api/v2/evolution/overview
GET  /api/v2/evolution/signals
GET  /api/v2/evolution/deltas
GET  /api/v2/evolution/deltas/:id
POST /api/v2/evolution/deltas/:id/approve
POST /api/v2/evolution/deltas/:id/reject
POST /api/v2/evolution/deltas/:id/run-sandbox
GET  /api/v2/evolution/experiments
GET  /api/v2/evolution/assets
GET  /api/v2/evolution/assets/:id
POST /api/v2/evolution/assets/:id/rollback
GET  /api/v2/evolution/recall
GET  /api/v2/evolution/graph?nodeId=...
```

All mutating commands record actor, reason, command id, and audit event.

## 16. Testing strategy

### 16.1 Test bootstrap

```text
create database southstar_test_<uuid>
run db:init
run tests
drop database
```

### 16.2 Required test groups

- Schema/init tests.
- Runtime compatibility tests.
- No direct `tork.*` SQL tests.
- Learning graph node/edge/lineage/evidence tests.
- Recall FTS and governance tests.
- Learning signal capture tests.
- Delta classifier and validator tests.
- Sandbox baseline/candidate tests.
- Promotion/canary/rollback tests.
- Evolution UI read model/API tests.

## 17. Risks and mitigations

### Scope risk

This is a large change. Implement in phases: Postgres store, learning graph, recall, signal pipeline, delta model, sandbox, promotion, UI.

### Postgres setup burden

Provide clear `db:init`, test bootstrap, configuration examples, and fail-fast startup validation.

### Evolution drift

Require evidence subgraphs, sandbox validation, human approval for high-risk changes, regression monitoring, and rollback.

### Recall quality

Start with FTS + graph scoring. Keep optional pgvector tier for future local embedding improvements.

### Security/tooling drift

Tool/MCP grants, broad memory scope changes, large budget increases, and flow changes are high-risk and require human approval.

### Tork coupling

Keep schemas separate and ban direct SQL references to `tork.*` in Southstar code/tests. Tork remains executor-only.

## 18. Success criteria

The first version succeeds when:

1. Southstar runs on Postgres `southstar` schema without SQLite fallback.
2. DB-backed tests run Postgres-only with per-run test databases.
3. Southstar does not directly read/write `tork.*` tables.
4. Learning graph captures task, artifact, evaluator, repair, context, memory, delta, experiment, promotion, and rollback lineage.
5. Recall works with Postgres FTS + graph scoring and persists injection traces.
6. A repair success can produce a learning signal.
7. Batch evolution can produce schema-valid prompt/skill/profile/flow deltas.
8. Sandbox validation compares baseline and candidate against regression/replay/cost guards.
9. Prompt and skill deltas can auto-promote after sandbox pass.
10. Low-risk profile deltas can auto-promote; medium-risk profile deltas canary; high-risk profile and flow deltas require human approval.
11. Rollback restores previous asset versions without deleting history.
12. Evolution Control Center read models expose signals, deltas, experiments, assets, recall quality, canaries, and rollback targets.

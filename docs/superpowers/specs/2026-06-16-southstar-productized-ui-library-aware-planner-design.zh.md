# Southstar 產品化 UI 與 Library-aware Planner 設計文件

日期：2026-06-16

## 1. 目標

Southstar v1 產品化 UI 的核心不是 runtime dashboard，也不是讓使用者手動挑 workflow template 的 catalog。它應該是：

> **Goal-first Workflow OS**：使用者輸入目標後，Southstar 自動從 Library / Agent Repository / Skills / MCP grants / Evaluators 中選擇或組合 workflow 與 agent team，產生可理解的 DAG，讓使用者 review、必要時 customize，然後執行、觀測與修復。

本設計範圍包含：

- 重新規劃產品化 UI，可不受現有 UI 形狀限制。
- 建立統一主視覺：**Calm Workflow OS**。
- 以 **Workspace** 作為主入口。
- 以 **Floating Operator Sheet** 作為注意事項與修復入口。
- 第一版即納入 **LLM-assisted Library-aware Planner**，不是未來階段。
- 內建 **Software Engineering Starter Library v1**，讓 Planner 有可檢索、可組合、可驗證的 workflow / agent / profile / skill / MCP / evaluator 素材。
- 採用 task-level parallelism 表達多 agent 並行。
- 納入 coding reviewer、spec alignment、browser QA、release lane agents。
- 納入 **Context Economy**，避免多 agent 重複探索與浪費 context。
- 設計真實 E2E 驗證案例與量化驗證標準；E2E 不再使用 calc 測試案例。

## 2. 非目標

- 不做 marketing landing page。
- 不把首頁做成塞滿 logs、metrics、tables 的 dense dashboard。
- 不做完整 low-code workflow editor。
- 不在 v1 做 editable Studio；v1 Library 是 read-only / selectable / explainable。
- 不把 LLM output 當 canonical truth；runtime validation、library snapshots、SQLite history 才是 truth。
- 不用 calc 作為產品核心 E2E 測試案例。
- 不把多 agent 並行塞在同一 task 內；v1 用 workflow DAG task-level parallelism。

## 3. 產品定位

Southstar 的產品心智：

```text
Prompt → Southstar plans → User reviews DAG → Southstar runs → Operator handles attention
```

使用者不需要一開始知道該選哪個 template 或哪個 agent。Southstar 必須自己做：

```text
Requirement extraction
→ Library search
→ Template selection / adaptation
→ Agent composition
→ Profile / skill / MCP grant selection
→ Artifact / evaluator selection
→ Validation / repair loop
→ Draft DAG review
```

UI 要讓使用者理解 Southstar 的規劃，而不是要求使用者手動完成規劃。

## 4. 主視覺：Calm Workflow OS

設計語言：

- 淺色工作區，低壓、清晰、可靠。
- 墨藍作為主色，不使用 AI-purple gradient。
- 冷灰背景，白色主要 surface，細 border。
- 青綠只用於 ready / safe / passed。
- Amber 用於 needs attention / approval。
- Red 僅用於 destructive / failed。
- 每個畫面只有一個 primary action。
- 不塞滿資訊；用 progressive disclosure 與 floating sheet 承載進階資訊。

建議 tokens：

```text
background: #f6f8fb
surface: #ffffff
primary: #102033
text-primary: #102033
text-muted: #64748b
border: #d8e1ec
success/safe: #0f766e / #eaf6f3
warning: #d97706 / #fff7ed
danger: #dc2626 / #fef2f2
radius: 10-18px, 同一層級一致
```

Typography：

- 產品 UI 使用清晰 sans，避免裝飾 serif。
- 標題可用緊湊 tracking，建立 Workflow OS 的產品感。
- 數字、run id、artifact id 可用 monospace，但不讓整頁變成 terminal。

Motion：

- 150–300ms。
- 用於 state transition、sheet open、DAG node selection、planning progress。
- 必須支援 `prefers-reduced-motion`。

## 5. Information Architecture

```text
Workspace              主入口：goal → draft DAG → run → observe
Library                Read-only repository：templates / agents / profiles / skills / MCP / evaluators
Operator Sheet         Floating attention layer：approvals / stuck tasks / recovery suggestions
Studio                 deferred：完整 editable workflow / agent / profile management
```

### 5.1 Workspace 狀態

Workspace 有四個主要狀態：

```text
1. Empty / New Goal
2. Planning
3. Draft Review
4. Active Run
```

#### Empty / New Goal

主畫面是 Progressive Brief：

- 大型 prompt composer。
- `Plan` 為 primary CTA。
- domain hint、repo/context、risk preference、approval mode 預設收合。
- 不在初始畫面顯示 workflow catalog。

#### Planning

顯示可審計的 planning pipeline：

```text
Extracting requirements
Searching Library
Selecting workflow template
Selecting agent team
Checking artifact contracts
Checking MCP/tool risk
Validating DAG
```

這讓使用者知道 Southstar 不是 chat，而是在做可驗證的 orchestration planning。

#### Draft Review

prompt 後顯示 DAG Flow：

- 中央：DAG Review Canvas。
- 右側：Task Inspector。
- 頂部摘要：template、agents、confidence、risk。
- Actions：`Run`、`Revise`、`Customize this run`、`Save draft`。

Task Inspector 預設 read-only。按 `Customize this run` 後才可做 run-level override。

#### Active Run

執行後同一 Workspace 切換為 active DAG：

- DAG node 顯示 task status / evaluator status / attention state。
- selected task inspector 顯示 current context、artifact、evaluator、recovery actions。
- 深層 logs 與 executor detail 放入 drill-down 或 Operator Sheet，不塞在主畫面。

### 5.2 Floating Operator

Operator 不做成首頁第二大欄。它是 attention layer。

收合：

```text
Operator · 2
```

展開：右側 floating sheet。

顯示：

- approval requests
- failed tasks
- heartbeat lost
- callback missing
- stuck runs
- release/merge approval
- suggested recovery actions

未來可加 command palette，但 v1 不依賴 command palette。

## 6. Library-aware Planner

新增核心模組：

```text
LibraryAwareWorkflowPlanner
```

### 6.1 Input

```ts
{
  userPrompt: string;
  projectContext?: ProjectContext;
  repoContext?: RepoContext;
  policy: PlanningPolicy;
  librarySnapshot: LibrarySnapshot;
  availableHarnesses: HarnessCapability[];
}
```

### 6.2 Output

```ts
{
  draftId: string;
  requirementSpec: RequirementSpec;
  workflowDag: WorkflowDraftDag;
  selectedTemplateRefs: string[];
  selectedAgentDefinitionRefs: string[];
  selectedAgentProfileRefs: string[];
  selectedSkillRefs: string[];
  selectedMcpGrantRefs: string[];
  selectedArtifactContractRefs: string[];
  selectedEvaluatorRefs: string[];
  rationale: PlannerRationale;
  confidence: "high" | "medium" | "low";
  risk: "low" | "medium" | "high";
  requiredClarifications: ClarificationRequest[];
  requiredApprovals: ApprovalRequestDraft[];
  generatedComponents: GeneratedDraftComponent[];
  validation: ValidationResult;
}
```

### 6.3 Planner skill

新增 planner skill：

```text
southstar.workflow-planner.library-selection
```

Skill 負責 LLM 行為約束：

- 從 prompt 萃取 requirement spec。
- 搜尋與比較 workflow templates。
- 搜尋與比較 agent definitions / profiles。
- 選 skill refs、MCP/tool grants、artifact contracts、evaluator pipelines。
- 判斷 reuse / adapt / generate。
- 輸出 schema-valid planner result。
- 說明 selection rationale 與 unresolved risks。

Skill 不擁有 truth。Runtime 必須驗證：

```text
schema validation
DAG validation
agent/profile capability validation
MCP/tool risk validation
artifact/evaluator validation
budget validation
approval policy validation
```

### 6.4 Hybrid missing-capability policy

Library 不足時採 Hybrid：

```text
Low-risk gap:
  LLM can generate draft component
  component marked generated/unvalidated
  runtime validates
  user can review

High-risk gap:
  ask user or require approval
```

低風險例子：

- 缺 summary task。
- 缺 docs checker。
- 缺 non-destructive evaluator wording。
- 缺 read-only repo inspection profile。

高風險例子：

- 缺 write-capable agent。
- 需要 external network write。
- 需要 secret / vault access。
- 需要 destructive git/worktree operation。
- 需要 merge、release、publish、PR write。
- stop condition 無法被 evaluator 驗證。

## 7. Software Engineering Starter Library v1

v1 內建 5 個 workflow templates：

1. Feature Implementation
2. Bug Diagnosis & Fix
3. Test & Coverage Improvement
4. Refactor with Safety Net
5. Documentation / README Update

### 7.1 Workflow Templates

#### Feature Implementation

```text
explorer
→ implementer
→ parallel:
    coding-reviewer
    spec-alignment
    browser-qa?                      conditional: UI/web repo detected
→ release-operator.commit-curation?  conditional: releaseMode != none
→ release-operator.merge-readiness?  conditional: releaseMode >= merge-ready
→ release-operator.merge-operation?  gated: releaseMode == merge-and-release
→ release-reporter?                  conditional: releaseMode != none
→ summarizer
```

#### Bug Diagnosis & Fix

```text
reproducer
→ diagnoser
→ fixer
→ parallel:
    regression-checker
    coding-reviewer
    spec-alignment
→ release lane?            policy-driven
→ summarizer
```

#### Test & Coverage Improvement

```text
explorer
→ test-writer
→ parallel:
    test-runner-checker
    spec-alignment
→ release-operator.commit-curation?
→ summarizer
```

#### Refactor with Safety Net

```text
explorer
→ baseline-checker
→ refactorer
→ parallel:
    regression-checker
    coding-reviewer
    spec-alignment
→ release lane?            stricter approval defaults
→ summarizer
```

#### Documentation / README Update

```text
explorer
→ doc-writer
→ parallel:
    doc-checker
    spec-alignment
→ release-operator.commit-curation?
→ release-reporter?
→ summarizer
```

### 7.2 Agent Definitions

Seed these agent definitions:

```text
software.explorer
software.implementer
software.checker
software.reproducer
software.diagnoser
software.test-writer
software.test-runner-checker
software.refactorer
software.baseline-checker
software.regression-checker
software.doc-writer
software.doc-checker
software.coding-reviewer
software.spec-alignment
software.browser-qa
software.release-operator
software.release-reporter
software.summarizer
```

Each definition includes:

```ts
{
  id: string;
  purpose: string;
  strengths: string[];
  limitations: string[];
  requiredCapabilities: string[];
  producedArtifacts: string[];
  preferredWorkflowTemplates: string[];
  riskLevel: "low" | "medium" | "high";
  compatibleProfileRefs: string[];
}
```

### 7.3 Required new reviewer agents

#### Coding Reviewer

```text
software.coding-reviewer
```

Responsibilities:

- Review diff and implementation quality.
- Check minimal patch discipline.
- Catch risky or over-broad changes.
- Inspect test evidence.
- Produce `code_review_report`.

Default profile: read-only.

#### Spec Alignment

```text
software.spec-alignment
```

Responsibilities:

- Compare user prompt, requirement spec, DAG, and artifacts.
- Check acceptance criteria coverage.
- Detect scope drift or missing requirement.
- Produce `spec_alignment_report`.

Default profile: read-only, can-reject.

#### Browser QA

```text
software.browser-qa
```

Responsibilities:

- Run local preview when available.
- Verify browser behavior and accessibility smoke checks.
- Capture browser QA evidence.
- Produce `browser_qa_report`.

Default profile: browser-local, no external network by default.

### 7.4 Release Lane agents

Release side effects are split by risk, but the first three stages share one agent family. This keeps the product model simple while preserving task/profile/artifact/approval separation.

#### Release Operator

```text
software.release-operator
```

Purpose:

- Manage code finalization, local commit, merge readiness, and approved merge operations under policy.
- Use different skills and profiles per release task mode.
- Never let a high-risk merge operation inherit read-only readiness permissions by accident.

Task modes / skills:

```text
release-operator.commit-curation
  skill: software.commit-curation
  profile: software.release-operator.commit-local
  artifacts: commit_plan, commit_result
  risk: medium

release-operator.merge-readiness
  skill: software.merge-readiness
  profile: software.release-operator.readiness-readonly
  artifacts: merge_readiness_report
  risk: low

release-operator.merge-operation
  skill: software.merge-operation
  profile: software.release-operator.merge-approved
  artifacts: merge_result
  risk: high; approval required by default
```

Responsibilities by mode:

- Commit curation: inspect workspace diff, confirm allowed changed files, produce commit plan/message, create local commit when policy allows.
- Merge readiness: check branch state, accepted artifacts, tests, evaluator results, blocking approvals, and merge safety without mutating state.
- Merge operation: perform merge / PR merge only after approval, stop and report on conflict, record merge SHA / PR state / result.

Artifact contracts remain separate so audit, retry, and approval gates can identify exactly which release stage passed or failed.

#### Release Reporter

```text
software.release-reporter
```

Responsibilities:

- Generate release notes / final release report.
- Aggregate commit, merge, artifact, test evidence.
- Prepare external comment/close summary when allowed.
- Produce `release_report` and `release_result`.

Risk: medium; external write requires approval.

### 7.5 Agent Profiles

Profiles are execution settings, not roles.

Examples:

```text
software.explorer.codex.readonly
software.implementer.pi.workspace-write
software.coding-reviewer.codex.readonly
software.spec-alignment.codex.readonly
software.browser-qa.pi.browser-local
software.release-operator.commit-local
software.release-operator.readiness-readonly
software.release-operator.merge-approved
software.release-reporter.codex.readonly
software.summarizer.codex.readonly
```

Each profile includes:

```ts
{
  id: string;
  agentDefinitionRef: string;
  provider: "pi" | "codex" | "opencode";
  model: string;
  harnessRef: string;
  allowedTools: string[];
  deniedTools: string[];
  skillRefs: string[];
  mcpGrantRefs: string[];
  contextPolicyRef: string;
  sessionPolicyRef: string;
  budgetPolicy: BudgetPolicy;
  approvalPolicy: ProfileApprovalPolicy;
}
```

### 7.6 Skills

Seed skill refs:

```text
software.repo-inspection
software.minimal-patch
software.test-evidence
software.bug-reproduction
software.regression-check
software.refactor-safety
software.docs-update
software.code-review
software.spec-alignment
software.browser-qa
software.commit-curation
software.merge-readiness
software.merge-operation
software.release-reporting
software.completion-report
```

### 7.7 MCP / Tool Grants

Seed grant model:

```text
filesystem.readonly
filesystem.workspace-write
git.readonly
git.workspace-patch
shell.test-runner
browser.local-preview
network.disabled
github.readonly
github.pr-write approval-required
github.issue-comment approval-required
```

Planner must choose grants according to task risk.

### 7.8 Artifact Contracts

Seed artifact contracts:

```text
requirement_spec
run_brief
repo_fact_cache
implementation_plan
implementation_report
verification_report
code_review_report
spec_alignment_report
browser_qa_report
bug_reproduction_report
diagnosis_report
regression_test_report
refactor_report
docs_update_report
doc_check_report
commit_plan
commit_result
merge_readiness_report
merge_result
release_report
release_result
completion_report
```

### 7.9 Evaluator Profiles

Seed evaluator profiles:

```text
software.requirement-spec-quality
software.plan-quality
software.implementation-evidence
software.verification-evidence
software.code-review-quality
software.spec-alignment-quality
software.browser-qa-quality
software.regression-safety
software.docs-quality
software.commit-safety
software.merge-readiness-quality
software.release-result-quality
software.completion-gate
```

## 8. Parallelism model

v1 uses **task-level parallelism**.

Planner must generate separate tasks for parallel reviewers:

```text
implementer
→ coding-reviewer
→ spec-alignment
→ browser-qa
```

Each task has its own:

- agent profile
- ContextPacket
- artifact contract
- evaluator result
- retry/recovery path

v1 does not use intra-task parallel subagents as a product requirement. Manifest has `subagents`, but current execution path is effectively one task → one root session / agent profile / harness run / artifact gate. Keeping parallelism at DAG task level is clearer for UI, audit, recovery, and evidence.

Future intra-task subagent fan-out can be added later with child-run persistence, child artifact contracts, nested fan-in, and nested UI graph.

## 9. Execution image, skill, and MCP delivery

v1 uses a fixed generic runner image. Planner output must not create ad hoc Docker image names for each workflow, agent, or task.

```text
Docker image = generic runner capability
Task specialization = TaskEnvelopeV2 + materialized skill snapshots + ContextPacket + MCP/tool grants + workspace mounts
```

Default runner image:

```text
southstar/pi-agent:local
```

Rules:

1. Library-aware Planner may select agent definitions, profiles, skills, and MCP/tool grants, but it must not invent per-workflow Docker images.
2. Approved agent profiles may reference an approved runner capability; runtime normalizes task execution to the approved image set.
3. Skill instructions are delivered through resolved skill snapshots in `TaskEnvelopeV2` and materialized under the per-task run root.
4. Docker receives the materialized run root mounted read-only at `/southstar-runs`.
5. Workspace access is delivered through explicit workspace mounts and MCP/tool grant metadata.
6. MCP grants in v1 are capability/policy metadata in `TaskEnvelopeV2` and `ContextPacket`; a grant is not assumed to mean a live MCP server is running inside the container unless the runtime has an adapter for it.
7. The UI must explain selected skills and MCP/tool grants in the task inspector without implying they are baked into the image.

This keeps image management simple while allowing each task to behave differently through envelope, context, skills, grants, and mounts.

## 10. Context Economy

As agent count grows, Southstar must avoid repeated context discovery.

Principle:

```text
Read once, summarize once, reuse many times.
```

### 10.1 Shared context artifacts

v1 must produce and reuse:

#### Run Brief

Contains:

- user goal
- requirement spec
- acceptance criteria
- selected workflow template
- selected agents
- planned DAG summary
- risk / approval policy

#### Repo Fact Cache

Contains:

- package manager
- test command
- framework
- relevant files
- entry points
- docs paths
- local preview command if web app
- known constraints

#### Artifact Summaries

Every task output must have a summary suitable for downstream tasks:

- files changed
- commands run
- evidence refs
- validator refs
- risk notes
- follow-up requirements

#### Task ContextPacket

Each task gets:

```text
run brief summary
+ relevant repo facts
+ upstream artifact summaries
+ task-specific instruction
+ selected memories
+ skill / MCP grant summaries
```

#### Memory Injection Trace

Preserve included/excluded memory and exclusion reasons.

### 10.2 Context source UI

Task Inspector must show:

```text
Context Sources
- Run Brief
- Repo Facts
- Upstream Artifacts
- Selected Memories
- Skills
- MCP Grants

Excluded Context
- duplicate
- over budget
- kind mismatch
- low score
- wrong scope
```

### 10.3 Planner rule

LLM Planner must design workflows so explorer/planner tasks generate shared context artifacts for downstream agents. Reviewers and release agents should consume summaries and evidence refs, not redo broad repository discovery.

## 11. UI details

### 11.1 Workspace Draft Review summary

Show:

```text
Planned from: Feature Implementation
Agents: explorer / implementer / coding-reviewer / spec-alignment / browser-qa / summarizer
Confidence: High
Risk: Low
Release mode: commit-only
```

### 11.2 Task Inspector

Default read-only:

```text
Task: Coding Review
Agent: software.coding-reviewer
Profile: codex.readonly
Artifact: code_review_report
Why selected:
- implementation changes need independent quality review
- profile is read-only
- produces reviewer gate before release lane
```

Actions:

```text
Customize this run
View alternatives
Revise instruction
```

### 11.3 Customize this run

Only after explicit click. Changes affect this draft/run only.

Allowed overrides:

- replace agent profile
- adjust context budget
- add task instruction
- change approval mode within policy
- add/remove non-destructive evaluator

Not allowed from Workspace:

- edit library default template
- publish agent profile
- permanently change skill
- silently grant external write

### 11.4 Library Side Sheet

Use for viewing alternatives:

- matched templates
- alternative agents
- alternative profiles
- skill requirements
- MCP/tool grants
- rejected alternatives and reasons

Primary purpose is explainability and run-level replacement, not full editing.

## 12. Runtime gaps to implement

Current repository already has:

- deterministic constrained workflow generator
- software domain pack
- design-library storage model
- template reuse / compile prototypes
- ContextPacket
- memory provider
- memory injection trace
- session graph
- upstream artifact summary refresh foundation

Required gaps:

1. Library-aware planner path integrated into `createPlannerDraft`.
2. Planner skill for library selection.
3. Software Engineering Starter Library v1 seed expansion.
4. Library search/scoring over workflow templates, agent definitions, profiles, skills, MCP grants, artifact contracts, evaluators.
5. Agent composition trace.
6. Template selection/adaptation trace.
7. Hybrid missing-capability policy.
8. Runtime validation for generated planner result.
9. Run Brief resource.
10. Repo Fact Cache resource.
11. Artifact Summary contract enforcement.
12. UI read model for planner rationale and context sources.
13. Workspace UI states: New Goal, Planning, Draft Review, Active Run.
14. Floating Operator Sheet.
15. Execution image / skill / MCP delivery gates.
16. Real E2E cases and quantitative gates.

## 13. Real E2E scenarios

E2E must verify actual product behavior, not static fixtures or calc examples. It must run after implementation and produce durable SQLite evidence, runtime events, accepted artifacts, evaluator results, and UI-readable draft/run state.

### 12.1 Scenario A: Todo Web Feature Workflow

Goal prompt:

```text
在 todo-web fixture repo 中新增 priority labels、due dates、overdue filter，保持 localStorage persistence，並更新 README usage。需要瀏覽器層級 QA 與 spec alignment review。
```

Expected planner behavior:

- Selects Feature Implementation template.
- Adds browser-qa because repo is web/UI oriented.
- Adds coding-reviewer and spec-alignment.
- Adds docs-related requirement through artifact/evaluator, not necessarily Docs workflow.
- Selects implementer with workspace-write profile.
- Selects browser.local-preview only if local preview command is discovered.
- Produces DAG with task-level parallel review lane.
- Produces Run Brief and Repo Fact Cache.

Expected execution evidence:

- Implementation artifact references changed files.
- Browser QA artifact includes local preview / UI behavior evidence or a clearly classified environment gap.
- Spec alignment artifact maps every acceptance criterion to evidence.
- Coding review artifact accepts or requests repair.
- Final completion only after evaluator and stop condition pass.

### 12.2 Scenario B: Markdown Table Parser Bugfix

Goal prompt:

```text
在 markdown-notes fixture repo 中診斷並修復 table parser 在 escaped pipe 與 code span 中切欄錯誤的 bug。先重現失敗，再修復，最後補 regression tests。
```

Expected planner behavior:

- Selects Bug Diagnosis & Fix template.
- Includes reproducer, diagnoser, fixer, regression-checker, coding-reviewer, spec-alignment.
- Does not include browser-qa unless repo context indicates browser behavior.
- Uses test-evidence and bug-reproduction skills.
- Release mode defaults to none or commit-only depending policy.

Expected execution evidence:

- Reproduction artifact includes failing case before fix.
- Diagnosis artifact identifies root cause.
- Fix artifact includes changed parser code and regression tests.
- Regression checker artifact includes post-fix command output.
- Spec alignment confirms escaped pipe and code span criteria.

### 12.3 Scenario C: Docs-only CLI Usage Update

Goal prompt:

```text
在 notes-cli fixture repo 中更新 README 與 docs，補上 import/export 指令的使用範例、錯誤處理說明與常見問題。不要修改 runtime code。
```

Expected planner behavior:

- Selects Documentation / README Update template.
- Uses doc-writer, doc-checker, spec-alignment, summarizer.
- Does not select implementer with workspace code-write unless docs write profile is needed.
- Does not include browser-qa.
- MCP/tool grants are docs-scoped and low risk.

Expected execution evidence:

- Docs update artifact lists changed docs files only.
- Doc checker verifies examples and no runtime code changes.
- Spec alignment maps required doc sections to evidence.
- Stop condition rejects if code files changed unexpectedly.

### 12.4 Scenario D: Refactor Safety Net

Goal prompt:

```text
在 task-runner fixture repo 中重構 command execution module，降低重複邏輯但不可改變公開 CLI 行為。先建立 baseline tests，再重構，最後跑 regression suite。
```

Expected planner behavior:

- Selects Refactor with Safety Net template.
- Includes baseline-checker before refactorer.
- Includes regression-checker, coding-reviewer, spec-alignment.
- Release lane requires stricter approval if merge requested.

Expected execution evidence:

- Baseline artifact records current behavior tests.
- Refactor artifact lists changed modules and non-goals.
- Regression artifact proves behavior preserved.
- Coding review checks over-broad changes.
- Spec alignment confirms public CLI behavior unchanged.

## 14. Quantitative gates

A new verifier should be added, for example:

```text
src/v2/quality/productized-ui-library-planner-gates.ts
```

Required gates per E2E run:

### Planner gates

- Planner creates draft within 180s.
- Library search trace includes at least:
  - 1 workflow template candidate.
  - 5 agent definition/profile candidates for Feature/Bug/Refactor workflows.
  - selected skill refs.
  - selected artifact contracts.
  - selected evaluator refs.
- Draft includes selection rationale for every task.
- Draft validation result is ok before Run is enabled.
- Generated/unvalidated components count is 0 for Starter Library covered scenarios, unless explicitly expected by scenario.

### DAG gates

- Feature scenario DAG has at least 6 tasks.
- Bugfix scenario DAG has at least 6 tasks.
- Docs scenario DAG has 4–5 tasks and no code implementer profile.
- Refactor scenario DAG has at least 6 tasks including baseline-checker and regression-checker.
- Parallel review lane exists where expected:
  - coding-reviewer and spec-alignment both depend on implementation/fix/refactor task.
  - browser-qa appears only for web/UI scenario.
- No intra-task parallelism is required for v1; parallel reviewers are separate tasks.

### Context Economy gates

- Every run has exactly one `run_brief` resource.
- Every software run has at least one `repo_fact_cache` resource.
- Every task has a ContextPacket before executor submission.
- Every task has memory injection trace before executor submission.
- Downstream review tasks include upstream artifact summary refs.
- Review/release agents consume artifact summaries or evidence refs; they must not be missing all upstream context refs.
- Average ContextPacket token estimate stays under configured policy budget.
- Duplicate memory exclusions are recorded when applicable.

### Execution image / skill / MCP gates

- Every task execution image is from the approved runner image set; v1 default is `southstar/pi-agent:local`.
- Planner output does not introduce ad hoc per-workflow image names.
- Every selected skill ref appears in the task envelope skill snapshot list or a fail-closed validation issue is recorded.
- Docker execution spec mounts the materialized run root read-only at `/southstar-runs`.
- MCP/tool grants appear in both TaskEnvelopeV2 and ContextPacket summaries.
- UI task inspector displays skills and MCP/tool grants as task-delivered capabilities, not image-baked dependencies.

### Agent / Library gates

- Every task resolves to an agent definition ref and agent profile ref.
- Every profile resolves skill refs and MCP/tool grants.
- Write-capable profiles are used only for tasks that need write access.
- Read-only review agents do not receive workspace-write grants.
- Merge operator is not present unless prompt/policy requests merge/release.
- Any high-risk grant creates approval evidence.

### Artifact / evaluator gates

- Each task produces an artifact matching its contract.
- Each artifact has accepted or needs_repair status; completion requires accepted required artifacts.
- Spec alignment report maps all acceptance criteria.
- Coding review report exists for Feature/Bug/Refactor workflows.
- Browser QA report exists for UI/web scenario, or an environment-gap artifact is explicitly classified and policy-accepted.
- Stop condition result must be passed before run status becomes passed/completed.

### UI gates

- Browser E2E visits Workspace New Goal.
- Browser E2E submits prompt from UI.
- Browser E2E observes Planning state.
- Browser E2E observes Draft Review DAG.
- Browser E2E opens task inspector and sees agent/profile/rationale.
- Browser E2E opens Library alternatives side sheet.
- Browser E2E sees Context Sources section.
- Browser E2E opens Operator sheet when an approval or attention item exists.
- Browser E2E starts run only after draft validation passes.

### Performance gates

Initial thresholds:

```text
runtime server start <= 5s
planner draft generation <= 180s
manifest validation <= 3s
first planning progress event <= 10s
Draft Review visible in UI <= 5s after draft ready
Operator sheet open interaction <= 300ms
Simple Workspace route load <= 3s in local browser E2E
E2E scenario completion <= 25 minutes per scenario
```

### Evidence integrity gates

- E2E must use fixture repos other than calc.
- E2E cannot use static canned planner output as the final proof.
- E2E cannot bypass runtime server.
- E2E cannot mark run complete based only on agent self-report.
- E2E must verify durable SQLite resources and history events.
- E2E must preserve planner decision trace for audit.

## 15. Acceptance criteria

This design is accepted when implementation can demonstrate:

1. User can submit a non-calc software goal from Workspace.
2. Southstar plans via Library-aware Planner, not manual template selection.
3. Software Engineering Starter Library v1 contains 5 workflow templates and required agents/profiles/skills/MCP/artifacts/evaluators.
4. Draft Review shows DAG, agent team, profiles, and rationale.
5. User can inspect but not accidentally edit agent/profile until `Customize this run` is clicked.
6. Context Economy resources are produced and visible.
7. Floating Operator handles attention items.
8. Fixed generic runner image is preserved; task specialization is delivered by TaskEnvelopeV2, skill snapshots, MCP/tool grants, context packets, and mounts.
9. Real E2E scenarios run against fixture repos other than calc.
10. Quantitative gates fail closed when evidence is missing.
11. Completion requires accepted artifacts, evaluator pass, and stop condition pass.

## 16. Recommended implementation milestones

1. Expand Software Engineering Starter Library seed.
2. Add planner result schema and validator.
3. Add planner skill and LLM-assisted planner orchestration.
4. Integrate Library-aware Planner into planner draft creation.
5. Add Run Brief / Repo Fact Cache / Artifact Summary resources.
6. Add UI read models for planner rationale and context sources.
7. Implement Workspace productized UI states.
8. Implement Floating Operator Sheet.
9. Implement Library alternatives side sheet.
10. Add real non-calc fixture repos and E2E scenarios.
11. Add execution image / skill / MCP delivery gates.
12. Add quantitative gate verifier.
13. Run full unit, integration, web build, and real E2E gates.

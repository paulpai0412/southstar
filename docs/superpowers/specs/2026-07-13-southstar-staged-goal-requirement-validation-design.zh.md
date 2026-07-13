# Southstar Staged Goal Requirement、Validation 與 Visual Contract 設計

**日期：** 2026-07-13
**狀態：** Proposed，等待使用者確認
**範圍：** Workflow Goal Design、Requirement 討論、Library validation resolution、Slice Plan、DAG composition、UI requirement visual review

## 1. 決策摘要

Southstar 應在既有 Workflow chat、Goal Design Package、Library graph、Composer、Postgres runtime resource、DAG canvas 與右側 viewer 基礎上，將 Goal-to-DAG 流程調整為可恢復的階段式設計：

```text
Goal Prompt
  -> Requirement Draft 與討論
  -> Requirement Confirm
  -> Validation Resolution
  -> 缺 Library object 時自動建立 Import Candidate
  -> 人工 Review / Approve / Import
  -> 原 Goal 自動重新 Resolution
  -> Slice Plan 與確認
  -> Frozen Goal Design Package
  -> Composer
  -> Validated DAG
  -> Existing Runtime Execution / Evaluation / Completion Gate
```

本設計不建立第二套 Goal 系統、Library、Composer、workflow engine、UI layout 或 persistence model。主要改動是將目前一次完成的 Goal Design 拆成可持久化階段、把 validation candidate resolution 前移、補強 evaluator profile 與 requirement binding，並讓含 UI layout 的 requirement 在既有右側 viewer 中完成 visual review。

核心產品保證：

1. 缺 candidate 不可能在理解 Goal 前預知，但必須在 Goal Design 階段顯示並解決；進入 Composer 前不得仍有 unresolved validation gap。
2. Requirement 先經使用者討論與確認，LLM 才能建立正式 validation binding 與 Slice Plan。
3. 每個 blocking requirement 都要有可執行、可追溯的 validation binding，但不為每個 Goal 新增 Library evaluator。
4. Library 保存可重用的 domain、capability、artifact contract 與 evaluator profile；Goal 保存本次 acceptance criteria、UI interaction contract 與 validation binding。
5. LLM 提議語意內容；程式擁有 schema、版本、hash、approval、coverage、證據與完成判定。

## 2. 與既有設計的關係

本設計是下列文件的 delta，不取代其 runtime foundation：

- `docs/superpowers/specs/2026-07-10-southstar-one-prompt-goal-contract-runtime-design.zh.md`
- `docs/superpowers/specs/2026-07-12-southstar-library-vocabulary-gap-import-design.zh.md`
- `docs/superpowers/plans/2026-07-11-southstar-goal-design-run-strategies-implementation-plan.zh.md`

仍然有效的既有決策：

- Workflow tab 的 chat input 是 Goal Design 入口。
- UI 保留現有 message stream、Goal card、右側 viewer/editor 與 DAG canvas。
- `GoalContractV1`、`GoalDesignPackageV1`、Slice Plan、Library version refs 與 requirement coverage 持久化於既有 Postgres resource/run model。
- Composer 只使用 approved Library graph，production 維持 LLM-only、fail-closed。
- blocking requirement 必須由一個 Slice 擁有，並具 producer、artifact 與 independent evaluator coverage。
- run 建立後 freeze Goal Contract hash、Library snapshot、manifest 與 coverage。
- completion 由 evidence-backed requirement results 決定，不由 worker self-report 決定。

本設計修正的既有決策：

- 不再一次產生完整 Goal Contract、evaluator contracts 與 Slice Plan 後只確認一次。
- `review_before_compose` 改為至少兩個產品 gate：Requirement Confirm 與 Slice Confirm。Library approval 是既有治理 gate，不計為 Goal Design 的文字確認。
- Goal interpreter 不應因自然語言 requirement 尚未映射 approved Library ref 而中止 Requirement 討論。
- candidate resolution 不再延後到 Composer；Validation Resolution 必須在 Slice Confirm 前完成。
- Requirement evaluator contract 不再只是 LLM 產生的 criteria/evidence kinds；它必須綁定真實、已版本化的 Library evaluator profile 與 artifact contract。
- Goal-scoped UI layout 不寫入 Library；它是 Goal Design artifact，只有可重用的 UI evaluator/profile 才屬於 Library。

## 3. 現況與問題

現有 `src/v2/` 已具備大部分必要模組，但目前 seam 排序造成產品摩擦。

### 3.1 Goal Design 一次產生太多衍生資料

`src/v2/orchestration/goal-design.ts` 目前要求 LLM 在同一份回應內輸出：

- `evaluatorContracts`
- `slicePlan`
- `compositionStrategy`

這讓尚未經使用者確認的 Requirement 直接衍生 evaluator contracts 與 Slices。使用者後續調整 Requirement 時，系統必須重生整個 package，也難以區分 Requirement 問題、Library gap 或 Slice 問題。

### 3.2 Vocabulary gap 與 Requirement 討論耦合

`preparePostgresGoalDesignDraft()` 會先載入 approved Library vocabulary，Goal Contract interpreter 發現 vocabulary gap 時可建立 Library import draft。這能 fail closed，但使用者可能在 Requirement 還沒確認前就被要求處理 candidate。

正確順序應是：討論自然語言 outcome 與 acceptance criteria、顯示 coverage preview、確認 Requirement，之後才為真實 gap 建立 candidate。

### 3.3 Validation binding 尚未綁定真實 evaluator profile

目前 `RequirementEvaluatorContractV1` 包含 requirement id、acceptance criteria、required evidence kinds、independence 與 failure classifications，但沒有：

- approved evaluator profile ref/version；
- artifact contract refs/version；
- criterion-level check mapping；
- profile 支援的 verification procedure。

它描述「需要證據」，但尚不是完整可執行 binding。

### 3.4 Artifact contract 仍有 placeholder 行為

`compileGoalDesignArtifactContracts()` 目前對 Goal Design artifact 建立固定 `requiredFields: ["summary"]` 與固定 evidence fields。這不是來源自 Library 的真實 artifact contract，也無法證明 UI、文件、資料或程式產出符合各自 schema。

### 3.5 UI requirement 缺 visual confirmation artifact

文字 AC 可以表達行為，但無法完整確認 layout、navigation、screen state、responsive rule 與 interaction transition。若等到 DAG 執行後才第一次看到畫面，Requirement 已經太晚才被具體化。

## 4. 目標與非目標

### 4.1 目標

1. 使用者在 Workflow chat 輸入 Goal 後，可與 LLM 討論 Requirement list，並在 message box 與右側 editor 中精準修改。
2. Requirement 在產生正式 Slice Plan 前確認，且所有修改具 revision、diff、undo 與 downstream invalidation。
3. Requirement 討論期間即時顯示 Library coverage preview，但只在 Requirement Confirm 後建立 missing candidate。
4. candidate 經人工 review/approve/import 後，原 Goal 自動重新 resolution，不要求重新輸入 prompt。
5. 每個 blocking requirement 在 Composer 前具有 approved、version-pinned、可執行的 validation binding。
6. 含 UI layout 的 requirement 可在右側 viewer 中檢視 screen、state、flow、viewport 與 element，並以 chat 或 structured editor 修正。
7. DAG、runtime evaluator 與 completion gate 能逐 criterion 追蹤 evidence 與 verdict。
8. 不加入 domain-specific hardcode、seed、fixture fallback、fake、mock 或 canned DAG。

### 4.2 非目標

- 不建立獨立 Goal page、第二個 Workflow layout、第二套 chat、Figma clone 或新 DAG canvas。
- 不取代 Postgres、Tork、scheduler、TaskEnvelope、Library graph、Composer、runtime resources 或 completion gate。
- 不要求每個 Goal、Requirement、Screen 或 Slice 都新增 Library object。
- 不讓 LLM approve Library object、宣告 execution pass、修改 frozen run contract 或繞過 human approval。
- 不在 Requirement 階段決定 framework、檔案、API route、task count 或 implementation order。
- 不在本設計加入 child-run；既有 single-run 與 per-slice-runs 決策維持不變。
- 不要求初版提供像素級自由拖拉 UI editor；visual review 以結構化低擬真 contract 為主。

## 5. Canonical Domain Model

### 5.1 Goal Requirement Draft

Requirement 討論需要比 runtime `GoalContractV1` 更豐富、可編輯的 draft，但不需要建立新 table。新增 goal-scoped `GoalRequirementDraftV1`，持久化於既有 planner draft/resource payload：

```ts
type GoalRequirementDraftV1 = {
  schemaVersion: "southstar.goal_requirement_draft.v1";
  revision: number;
  parentRevision?: number;
  originalPrompt: string;
  workspace: { cwd: string; projectRef?: string };
  summary: string;
  requirements: Array<{
    id: string;
    title: string;
    statement: string;
    source: "explicit" | "inferred";
    blocking: boolean;
    userVisibleBehaviors: string[];
    businessRules: string[];
    acceptanceCriteria: Array<{
      id: string;
      statement: string;
      evidenceIntent: string[];
    }>;
    expectedOutcomeArtifacts: Array<{
      description: string;
      mediaType?: string;
    }>;
    verificationIntent: string[];
    assumptions: string[];
    openQuestions: string[];
    riskTags: string[];
    interactionContractRefs: string[];
    status: "needs_clarification" | "ready" | "confirmed" | "superseded";
  }>;
  nonGoals: string[];
  blockingInputs: string[];
  draftHash: string;
};
```

Host 擁有 requirement id、criterion id、revision、parentRevision 與 hash。LLM 只能提議 semantic fields。

Requirement Confirm 時，由同一個 Goal Contract module 將 confirmed draft 投影成現有 `GoalContractV1`：

- `statement`、`blocking`、`source`、`expectedArtifacts` 直接保留；
- `acceptanceCriteria[].statement` 投影回現有 `string[]`；
- criterion id 與 draft detail 保留於 Goal Design resource，供 validation binding 與 UI 使用；
- `RequirementSpecV2` 繼續只是 compatibility projection；
- 不新增第二份 mutable Goal truth。

### 5.2 Goal Contract

Goal Contract 是經使用者確認、可 hash 與 freeze 的 outcome contract。它不包含 Slice、DAG node、agent、tool 或 evaluator implementation。

### 5.3 Requirement Validation Binding

現有 `RequirementEvaluatorContractV1` 可保留 code name 以降低 migration，但產品與 read model 應稱為 `RequirementValidationBinding`，並擴充：

```ts
type RequirementValidationBindingV1 = {
  schemaVersion: "southstar.requirement_validation_binding.v1";
  id: string;
  requirementId: string;
  criterionIds: string[];
  acceptanceCriteria: string[];
  artifactContractRefs: string[];
  artifactContractVersionRefs: string[];
  evaluatorProfileRef: string;
  evaluatorProfileVersionRef: string;
  verificationMode:
    | "deterministic"
    | "browser_interaction"
    | "semantic_review"
    | "human_approval";
  criterionChecks: Array<{
    criterionId: string;
    procedureRef: string;
    expectedEvidenceKinds: string[];
  }>;
  requiredEvidenceKinds: string[];
  independence: "independent";
  failureClassifications: string[];
};
```

每個 blocking requirement 必須有 binding。多個 bindings 可以重用同一個 Library evaluator profile；因此每個 Goal 都有 goal-scoped bindings，但不會每個 Goal 都新增 Library evaluator。

### 5.4 Library Artifact Contract

Library `artifact_contract` 必須描述真實可重用產出契約，而不是 goal-specific filename 或固定 `summary` placeholder。最小有效內容包括：

- artifact type 與 applicable media types；
- required fields/content rules；
- validation rules 或 schema ref；
- acceptable evidence kinds；
- provenance requirements。

Goal requirement 的 `expectedOutcomeArtifacts` 描述本次交付；Validation Resolution 將它映射到 approved artifact contract。

### 5.5 Library Evaluator Profile

Library `evaluator_profile` 描述可重用的「如何驗證」：

```ts
type LibraryEvaluatorProfileStateV1 = {
  validatesArtifactRefs: string[];
  verificationModes: string[];
  requiredInputs: string[];
  verificationProcedures: Array<{
    id: string;
    checkKind: string;
    instruction: string;
    allowedEvidenceKinds: string[];
  }>;
  evidenceKinds: string[];
  resultSchemaRef: string;
  independencePolicy: "independent";
  failureClassifications: string[];
};
```

Profile 可以是 domain-specific，例如 flashcard review verifier，只要能被後續同 domain goals 重用；可重用不等於跨所有 domain。

### 5.6 UI Interaction Contract

含 visual layout 的 requirement 使用 goal-scoped `UiInteractionContractV1`：

```ts
type UiInteractionContractV1 = {
  schemaVersion: "southstar.ui_interaction_contract.v1";
  id: string;
  revision: number;
  requirementIds: string[];
  screens: Array<{
    id: string;
    title: string;
    purpose: string;
    layout: {
      regions: Array<{
        id: string;
        role: string;
        position: string;
        childRefs: string[];
      }>;
    };
    elements: Array<{
      id: string;
      type: string;
      label?: string;
      visibleInStates: string[];
      enabledInStates: string[];
    }>;
    states: string[];
    actions: Array<{
      id: string;
      triggerElementId: string;
      fromState: string;
      toState: string;
      targetScreenId?: string;
      expectedEffect: string;
    }>;
    responsiveRules: string[];
    accessibilityRules: string[];
  }>;
  flows: Array<{
    id: string;
    steps: string[];
    successOutcome: string;
  }>;
  criterionBindings: Array<{
    criterionId: string;
    screenIds: string[];
    elementIds: string[];
    actionIds: string[];
  }>;
  contractHash: string;
};
```

這份 contract 存在既有 runtime resource/planner draft，透過 Goal Design Package、node prompt/context packet 傳給 producer 與 evaluator。它不是 Library file。

## 6. Target State Machine

```text
requirements_draft
  -> requirements_review
  -> requirements_confirmed
  -> validation_resolving
       -> library_review          when gaps exist
       -> validation_ready        when all blocking bindings resolve
  -> slice_review
  -> ready_to_compose
  -> composing
  -> dag_validated
```

狀態為既有 planner draft/runtime resource 的 phase/status projection，不新增 workflow engine。

### 6.1 Revision invalidation

- 修改 Requirement：建立新 Requirement Draft revision；舊 Goal Contract confirmation、bindings、Slice Plan 與未執行 DAG draft 標記 stale。
- 修改 UI Interaction Contract：若 criterion、screen flow 或 required state 改變，對應 binding、Slice Plan 與 DAG draft stale；純 presentation metadata 可只更新 visual contract revision，但仍需重新確認 visual requirement。
- 修改 validation binding：Slice Plan 可保留 requirement ownership，但必須重新驗證 artifact dependency 與 evaluator coverage。
- 修改 Slice：Goal Contract 與 validation binding 保持有效；Slice Plan/package hash 更新，舊 confirmation 與未執行 DAG stale。
- run 建立後：run 保持 frozen；新的需求修改建立 planner/Goal revision，不原地改寫執行中的 run。

所有 stale transitions 都保留歷史與 parent hash，不刪除舊 resource。

## 7. Requirement Discussion UX

### 7.1 Existing Workflow chat remains the interaction seam

Workflow chat input 根據目前 Goal Design phase 路由：

- `requirements_draft/review`：解讀為 Requirement revision/clarification；
- `library_review`：解讀為 candidate review、替換或 requirement verification strategy revision；
- `slice_review`：解讀為 Slice revision；
- `ready_to_compose`：明確確認才呼叫 Composer。

Chat 不直接修改資料庫 JSON；它呼叫既有 Goal Design revision module，module 解析、驗證、持久化新 revision，然後 read model 更新 message block。

### 7.2 Requirement List message block

沿用 `MessageView` 與 Goal message block，新增 Requirement list presentation，不新增 page：

```text
Requirements · Draft revision 4

R1 Card management
Explicit · Blocking · 3 AC · Validation ready

R2 Review flow
Inferred · Blocking · 4 AC · Evaluator missing · Visual review required

0 blocking questions · 1 validation gap

[Review changes] [Add Requirement] [Confirm Requirements]
```

每列顯示：

- explicit/inferred；
- blocking/non-blocking；
- AC count；
- `needs_clarification | ready | confirmed`；
- Library coverage `ready | partial | missing | manual`；
- visual review status。

### 7.3 Right-side Requirement editor

點擊 Requirement 時，沿用目前 `GoalSliceEditor` 所在右側 viewer seam，顯示 structured editor：

- statement；
- user-visible behaviors；
- business rules；
- acceptance criteria 與 evidence intent；
- expected outcome artifacts；
- verification intent；
- assumptions、questions、risks；
- Library coverage preview；
- linked UI Interaction Contracts。

不新增另一個 sidecar/layout。實作可新增 viewer content kind，但仍由 `AppShell` 的同一 selection/viewer state 管理。

### 7.4 Requirement domain actions

支援：

- Create；
- Read；
- Update；
- Supersede/restore；
- Split；
- Merge；
- Undo revision。

普通文字修改儲存為新 draft revision，不逐欄確認。刪除 explicit requirement、將 blocking 改為 non-blocking、刪除最後 AC、Split/Merge 或修改已確認 Requirement 時，UI 顯示 impact confirmation。

### 7.5 Requirement confirmation gate

Confirm 按鈕只在下列條件通過時啟用：

- blocking requirement 至少一條非空 AC；
- blocking question 為空；
- statement 與必要 outcome 不為空；
- inferred requirement 已在 summary 中揭露；
- required visual requirement 已完成 visual review；
- draft hash 與 UI 顯示 revision 一致。

缺 Library evaluator/artifact 不阻止 Requirement Confirm；它在下一階段處理。

Confirm 前顯示整批摘要與 diff。確認後呼叫 host finalizer 產生 canonical `GoalContractV1` 與 hash。

## 8. Visual Requirement UX

### 8.1 Detection and timing

LLM 可將 Requirement 標為 `visual review suggested`，但是否為 required 由 host rule與使用者確認。符合下列情況時應在 Requirement Confirm 前建立 UI Interaction Contract：

- layout、navigation 或 information hierarchy 影響需求；
- interaction state/transition 具有產品意義；
- responsive behavior 是 acceptance condition；
- loading、empty、error 或 accessibility state 影響完成判定。

CSS 細節、framework、component library、檔案結構與非必要 visual polish 留到 Slice/DAG。

### 8.2 Existing right viewer renders structured preview

點擊 visual requirement 後，右側 viewer 顯示：

- screen selector；
- state selector；
- desktop/mobile viewport；
- low-fidelity structured layout；
- flow preview；
- element selection/inspector；
- revision diff；
- expand-to-large-view action。

Renderer 消費 `UiInteractionContractV1`，不將 LLM HTML 當作 canonical contract，也不允許 preview 任意執行外部 script。

### 8.3 Revision interaction

使用者可在 chat 說明修改，也可點選 element 後在 inspector 修改 label、visibility、state/action linkage。兩種入口皆產生相同 structured patch 與 revision。

Visual confirmation 必須覆蓋：

- required screens；
- major regions與 controls；
- interaction transitions；
- loading/empty/error/ready states；
- required viewport rules；
- criterion-to-screen/element/action bindings。

### 8.4 Validation usage

UI Interaction Contract 會被 producer task 與 browser evaluator task共同消費。UI validation 不能只做 screenshot similarity，應組合：

- DOM/accessible role existence；
- state-specific visibility/enabled checks；
- real interaction transitions；
- desktop/mobile viewport；
- loading/empty/error state；
- screenshot evidence；
- accessibility checks；
- 必要時 human visual approval。

## 9. Validation Resolution and Library Import

### 9.1 Coverage preview during discussion

Requirement draft 期間，新的 `GoalValidationResolver` 以 semantic intent 查詢 approved Library graph並回傳 preview：

```ts
type RequirementCoveragePreviewV1 = {
  requirementId: string;
  status: "ready" | "partial" | "missing" | "manual";
  artifactCandidates: Array<{ ref: string; versionRef: string; reason: string }>;
  evaluatorCandidates: Array<{ ref: string; versionRef: string; reason: string }>;
  missingKinds: Array<"artifact" | "evaluator" | "capability" | "domain">;
};
```

Preview 不建立、approve 或寫入 Library object。LLM 可做 semantic ranking，程式只能回傳 approved candidates。

### 9.2 Resolution after Requirement Confirm

Requirements Confirm 後，resolver 對每個 blocking requirement：

1. 將 expected outcome artifact 映射 approved artifact contract；
2. 透過 graph edge 找出能驗證該 artifact/check mode 的 approved evaluator profile；
3. 驗證 profile verification procedure 能產生 requirement 需要的 evidence；
4. 建立 criterion-level binding；
5. 若缺口仍存在，產生 structured gap。

### 9.3 Candidate generation and approval

confirmed gap 自動呼叫現有 Library import draft path。使用者不需要先按「建立 candidate」，但 approve/import 永遠需要明確操作。

Candidate change set 應包含必要且相互依賴的 object，例如 artifact contract + evaluator profile；不得因單一 Goal 自動建立與 gap 無關的 domain/capability/profile。

Candidate message block沿用現有 `LibraryCandidateMessageBlock`，點選後使用同一個 Library viewer/editor。顯示：

- candidate 完整內容；
- source requirement/criteria；
- reusable applicability；
- graph edge proposal；
- duplicate/conflict/reference diagnostics；
- 將會解除哪些 Goal gaps。

Approve/import 後：

1. 使用現有 file write + catalog reconcile + graph version path；
2. 發出 Library snapshot/update event；
3. 重新執行同一 draft 的 Validation Resolution；
4. 更新 bindings 與 coverage read model；
5. 全部 blocking bindings ready 後自動轉入 `slice_review`。

使用者拒絕 candidate 時，Goal 保持 `library_review`，可選：

- 使用既有 profile；
- 修改 verification intent/AC；
- 選擇 human approval profile；
- 放棄或改成 non-blocking requirement，並建立 Goal revision。

## 10. Slice Plan and Composer

### 10.1 Slice generation timing

Slice Plan 只能在 canonical Goal Contract 與 blocking validation bindings ready 後產生。LLM 依 confirmed Requirements、artifact ownership、mutation boundary、UI contract與 validation bindings提出 Slices。

Slice 不得新增 Requirement 或 Acceptance Criterion。若 Slice 設計發現 Requirement 不完整，回到 Requirement revision。

### 10.2 Slice confirmation

沿用現有 `GoalSlicePlanBlock` 與 `GoalSliceEditor`：

- message block 顯示 slice、owned requirement ids、validation readiness與 artifact dependencies；
- 點選後在既有右側 viewer 編輯；
- program validator 繼續檢查 requirement owner count、unknown refs、dependency artifact flow與 cycle；
- Confirm 後 freeze Goal Design Package hashes並進入 `ready_to_compose`。

### 10.3 Composer precondition

呼叫 Composer 前，程式必須確認：

- Requirement confirmation hash有效；
- UI contract confirmation/hash有效；
- blocking requirement bindings完整；
- 所有 artifact/evaluator refs approved且 version-pinned；
- Library closed set有效；
- Slice Plan validator通過；
- 沒有 unresolved import candidate。

Composer 只負責：

- 將 frozen slices/bindings編譯成最小可執行 DAG；
- 選擇 approved agent/skill/tool/MCP/instruction primitives；
- 產生 nodePromptSpec與 generated run profile；
- 建立 producer/evaluator task artifact flow。

Composer 不得新增 Requirement、改寫 AC、批准 candidate或以 invented evaluator ref補 gap。

## 11. Evaluator Execution Semantics

### 11.1 Criterion-level result

Evaluator task輸出應擴充為 criterion-level payload：

```ts
type RequirementEvaluatorResultV2 = {
  schemaVersion: "southstar.requirement_evaluator_result.v2";
  requirementIds: string[];
  artifactRefs: string[];
  evaluatorTaskId: string;
  evaluatorProfileRef: string;
  evaluatorProfileVersionRef: string;
  criteriaResults: Array<{
    criterionId: string;
    verdict: "passed" | "failed" | "blocked";
    evidenceRefs: string[];
    findings: string[];
  }>;
  verdict: "passed" | "failed" | "blocked";
  evidenceRefs: string[];
  findings: string[];
};
```

LLM evaluator可以執行 semantic review並提出 findings，但 host validator必須：

- 驗證 output schema與 allowed values；
- 驗證每個 binding criterion皆有 result；
- 驗證 evidence provenance、freshness與required kinds；
- 驗證 evaluator task與producer task獨立；
- 依 blocking criteria results計算總 verdict；
- 拒絕只宣告 `passed`、沒有 criterion evidence的輸出。

### 11.2 Reuse existing completion gate

現有 `requirement-evaluator-results.ts` 與 `completion-gate.ts` 已能驗證 accepted producer artifacts、independent evaluator task、profile ref與frozen coverage。實作應深化這個 seam，加入 criterion coverage與profile version，而不是建立另一個 evaluator runtime。

## 12. Responsibility Matrix

### 12.1 LLM

- 從 Goal prompt提出 Requirement draft；
- 標記 explicit/inferred並提出 blocking clarification；
- 提議 observable acceptance criteria、evidence intent與visual review需求；
- 根據 approved candidates做semantic ranking；
- 對 confirmed gap提出可重用 Library candidate；
- 將 criteria映射到profile procedure形成check plan；
- 產生 Slice proposal與DAG composition；
- evaluator task執行被profile允許的semantic judgement並輸出structured findings。

### 12.2 Program

- 建立stable ids、revision、hash、parent lineage與idempotency；
- parse strict schema、allowed values、size limits與exact keys；
- 保存chat/editor revision與diff；
- 阻止未確認 Requirement進入validation binding；
- 只回傳approved/versioned Library candidates；
- 驗證artifact/evaluator graph applicability與closed set；
- 自動建立但不自動approve import draft；
- import後resume同一Goal；
- 驗證criteria preservation、slice ownership、dependency flow與DAG；
- freeze Goal/Library/manifest/coverage；
- 驗證evidence與criterion results並計算completion。

### 12.3 User

- 討論與確認inferred Requirements/AC；
- 確認required visual layout/flow；
- review、修改與approve Library candidate；
- 確認Slice Plan；
- 執行human approval類verification與高風險effect approval。

## 13. Existing Modules to Deepen

本設計優先深化既有 module，避免 parallel implementation。

### 13.1 Runtime/orchestration

- `src/v2/orchestration/goal-contract.ts`
  - 增加 Requirement Draft finalization interface與criteria identity projection；保留現有 Goal Contract/hash。
- `src/v2/orchestration/goal-design.ts`
  - 保留Slice/package types與validators；將一次輸出拆成Requirement discussion、validation binding與Slice design interfaces。
- `src/v2/orchestration/goal-design-draft-service.ts`
  - 成為phase/revision orchestration module；持久化Requirement Draft、UI contracts、bindings、Slice revisions與stale transitions。
- `src/v2/orchestration/candidate-resolver.ts`
  - 抽出/深化GoalValidationResolver；在Composer前完成artifact/evaluator resolution。
- `src/v2/orchestration/composition-compiler.ts`
  - 讀取真實Library artifact contract與validation binding；移除固定summary placeholder。
- `src/v2/orchestration/composition-validator.ts`
  - 驗證resolved bindings、profile versions與criterion coverage。
- `src/v2/ui-api/postgres-run-api.ts`
  - 保留planner draft/run materialization；只接受ready_to_compose package。
- `src/v2/evaluators/requirement-evaluator-results.ts`
  - 深化為criterion-level result與profile version驗證。
- `src/v2/evaluators/completion-gate.ts`
  - 沿用現有coverage gate並加入criterion completeness。

### 13.2 Library

- `src/v2/design-library/importers/library-llm-import-analyzer.ts`
  - 擴充artifact/evaluator candidate semantic schema與可填值規範。
- `src/v2/design-library/files/library-file-parser.ts`
  - 驗證新增profile/contract fields與allowed values。
- `src/v2/design-library/files/library-file-store.ts`
  - 沿用file-to-graph refs projection；新增必要procedure/schema edges時維持同一graph。
- 現有candidate install/reconcile/approval path維持唯一write path。

### 13.3 HTTP and UI

- `src/v2/server/planner-routes.ts`
  - 在既有planner draft routes加入Requirement patch/confirm、visual contract patch/confirm與resume resolution；保持thin route。
- `web/hooks/useAgentSession.ts`
  - 根據Goal phase處理SSE/read model，不在browser重建truth。
- `web/components/MessageView.tsx`
  - 渲染Requirement/validation/visual state block。
- 現有Goal/Slice block與editor pattern
  - 重用selection與right viewer seam。
- 現有`LibraryCandidateMessageBlock`
  - 顯示Goal validation gap change set與resume status。
- `web/components/AppShell.tsx`
  - 保留既有layout，只增加viewer content selection。

不新增新的top-level navigation、page shell、state store或parallel REST client。

## 14. Product Error and Recovery Semantics

- LLM Requirement JSON invalid：同階段一次repair；仍失敗則保留draft與可讀error，不建立Goal Contract。
- Requirement有blocking ambiguity：保持`requirements_review`並提出一個具體question。
- Library preview缺candidate：顯示gap，不阻止Requirement討論。
- Confirm後candidate generation失敗：保持`library_review`並可retry，不回退confirmed Goal Contract。
- Candidate schema/reference invalid：保留import draft供修改，不write/sync。
- Candidate rejected：Goal保持library_review，要求替代profile或Requirement revision。
- Import成功但仍有gap：同一Goal再次顯示剩餘gap，不進Slice/Composer。
- Library version在confirm前變更：binding stale並重新resolve。
- Slice invalid：保持slice_review並顯示deterministic issues。
- Composer發現validation ref missing：視為precondition bug，fail closed；不得叫LLM invent ref。
- UI preview renderer失敗：canonical UI contract仍保留，顯示structured fallback與錯誤；不破壞Goal truth。
- run開始後Requirement修改：建立新planner revision/run，不改既有frozen run。

## 15. Acceptance Scenarios

### 15.1 Existing evaluator reuse

1. 使用者輸入已由approved Library支援的Goal。
2. LLM提出Requirements與AC。
3. 使用者修正並confirm。
4. resolver綁定existing artifact/evaluator versions，沒有import candidate。
5. 產生Slice Plan並confirm。
6. Composer收到zero-gap package並產生DAG。

### 15.2 Missing evaluator auto-candidate and resume

1. Requirement discussion時顯示evaluator missing preview。
2. 使用者confirm Requirement。
3. 系統自動建立Library import draft與candidate message block。
4. 使用者在右側viewer修改並approve/import。
5. Library reconcile完成。
6. 同一Goal draft自動re-resolve；Requirement id/hash不因import重建。
7. binding ready後進Slice review。

### 15.3 Requirement revision after validation

1. Requirement已confirmed且binding ready。
2. 使用者修改AC。
3. UI顯示bindings、Slice與DAG invalidation impact。
4. 新Requirement revision建立；舊衍生resources標記stale。
5. 重新confirm與resolve；舊Library object不被刪除。

### 15.4 Visual requirement review

1. Goal包含重要UI layout與interaction flow。
2. Requirement message block標記visual review required。
3. 右側viewer渲染structured low-fidelity screens/states。
4. 使用者以chat與element inspector修改，產生revision/diff。
5. screen/state/flow/criterion bindings完整後confirm。
6. resolver綁定browser/accessibility evaluator profiles；若缺少則建立candidate。
7. DAG producer與evaluator共同收到frozen UI contract。
8. runtime保存real browser interaction、screenshot、accessibility與criterion results。

### 15.5 No late candidate surprise

1. Goal在`ready_to_compose`前執行precondition validation。
2. 任一blocking requirement缺artifact/evaluator/profile version時，不呼叫Composer。
3. Composer僅收到approved/version-pinned graph closure。
4. runtime不因Goal vocabulary/evaluator缺口才第一次失敗。

### 15.6 Criterion-level completion

1. producer產生accepted artifact。
2. independent evaluator執行profile procedure。
3. 每條criterion具有valid evidence與verdict。
4. host由criterion results計算requirement verdict。
5. Completion Gate只在所有blocking criteria passed時標記Goal satisfied。

## 16. Rollout Boundaries

為控制改動範圍，建議依現有 seam 分批，但共用一份canonical design：

1. Requirement Draft/review/confirm與phase-aware chat；
2. GoalValidationResolver、binding與Library auto-resume；
3. Slice generation timing與Composer preconditions；
4. evaluator/artifact schema深化與criterion-level runtime結果；
5. UI Interaction Contract與right-viewer preview；
6. browser visual evaluator integration與完整E2E。

每一批都沿用同一 planner draft/resource lineage；不得為Visual Goal、Library Gap或Evaluator另建一條workflow creation path。

## 17. 最終產品行為

使用者只需要在既有Workflow chat說明Goal。Southstar先讓使用者看懂並修正「要完成什麼、如何判斷完成」，再處理Library是否具備可重用的驗證能力。若缺能力，系統在同一Goal context中提出candidate，人工approve後自動續跑。含UI的需求在同一右側viewer確認screen/layout/state，而不是等執行後才發現理解不同。只有當Requirement、visual contract、validation binding與Slice Plan都一致且版本化後，Composer才產生DAG。

這個流程深化既有Goal Design module的interface與persistence locality，不建立新的平台。

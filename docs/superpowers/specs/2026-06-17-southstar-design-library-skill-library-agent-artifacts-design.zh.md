# Southstar Design Library Skill Library 與 Agent Artifact 輸出可靠性設計

日期：2026-06-17
狀態：Draft，待使用者審閱

## 1. 背景與問題

在真實 E2E `tests/e2e-real/design-library-template-real.test.ts` 中，Design Library 產生的 todo-web workflow 透過 Pi agent 與本地 Tork 執行。Checker task 失敗，原因不是 Tork 或 SQLite 設定，而是 agent 產出的 artifact 不符合 `verification_report` contract。

觀察到的失敗：

- 第一次 artifact：
  - 回傳 `{"artifact":"/workspace/repo/verification-report.md", "progress":"complete", "metrics": ...}`。
  - 問題：回傳檔案路徑而不是 contract-valid JSON 內容。
- Repair attempt artifact：
  - 回傳 `{"summary":"Now I'll create a comprehensive verification report with all required fields:"}`。
  - 問題：只有 partial summary，缺少 `commandsRun`, `testResults`, `checkerFindings`, `risks`。
- Evidence validator 失敗：
  - missing `command-output` evidence。
  - missing `test-result` evidence。

目前 prompt 有說明 required top-level keys，但缺少可重用、結構化的 agent 執行指引、field-level guidance、輸出格式自我驗證，以及能與 repair instruction 精準對應的 skill metadata。

## 2. 目標

建立 Design Library-backed Skill Library，讓 agent 在 workflow 生成與執行時取得可版本化、可重用、可驗證的 skill instructions。每個 skill 必須明確定義：

1. Input：agent 可用資訊、上游 artifact、repo path、acceptance criteria、contract required fields。
2. Process steps：角色專屬執行步驟與 evidence 收集方式。
3. Output：精確 JSON 結構、欄位型別、範例與反例。
4. Self-validation：提交前檢查所有 required fields、JSON 格式、evidence completeness。
5. Repair alignment：repair instruction 可格式化引用 skill 中對應欄位與章節。

## 3. 非目標

- 不新增新的控制平面資料表。仍使用現有 `library_objects` / `library_history` 與 `runtime_resources`。
- 不建立與現有 `src/v2/skills/*` 平行的新 skill runtime 管線。
- 不依賴 agent 在 Docker 內自行 `cat` Design Library skill 檔案作為 P0 行為。
- 不以 calc、fake、mock、smoke 測試作為驗收依據。
- 不改變 fixed lifecycle state 或 runtime core lifecycle invariants。

## 4. 核心設計決策

### 4.1 復用現有 Skill Runtime

目前 Southstar 已有：

- `src/v2/skills/types.ts`
  - `SkillSourceDefinition`
  - `ResolvedSkillSnapshot`
  - `SkillCatalog`
- `src/v2/skills/catalog.ts`
  - 目前內建 `software.calc-cli`
- `src/v2/skills/resolver.ts`
  - `resolveSkillSnapshots(...)`
  - 寫入 `runtime_resources` 的 `skill_snapshot`
- `TaskEnvelopeV2.skills`
- `pi-sdk-harness.ts` 的 `resolvedSkillInstructions(...)`

因此本設計不新增平行機制，而是加入 Design Library-backed catalog：

```text
Design Library skill_spec
  -> LibraryBackedSkillCatalog
  -> resolveSkillSnapshots()
  -> runtime_resources skill_snapshot
  -> TaskEnvelopeV2.skills
  -> pi-sdk-harness prompt injection
  -> agent produces contract-valid artifact
```

### 4.2 Skill Library 是 Design Library 的 first-class object

新增 `LibraryDefinitionKind`：

```ts
| "skill_spec"
```

Skill 與 agent specs、contracts、validators、workflow templates 一樣由 Design Library 管理、版本化、seed、編譯與引用。

### 4.3 Base + Specialized Skill 結構

建立 1 個 base skill 與 5 個 specialized skills：

- `software-dev.skill.artifact-generator-base`
- `software-dev.skill.explorer-context`
- `software-dev.skill.planner-planning`
- `software-dev.skill.implementer-implementation`
- `software-dev.skill.checker-verification`
- `software-dev.skill.summarizer-completion`

Base skill 定義所有 artifact 共同規則：JSON 格式、自我驗證、repair 行為、常見錯誤。

Specialized skill 定義角色/任務專屬的 input、process steps、field guidance、output example、role-specific self-validation。

### 4.4 Base skill 由 runtime 解析，不由 agent 自己查找

Specialized skill 的 payload 可包含：

```ts
baseSkillRef: "software-dev.skill.artifact-generator-base"
```

解析發生在 runtime/compiler/skill resolver 側：

```text
load specialized skill
  -> resolve baseSkillRef first
  -> dedupe by skillId/version
  -> inject base + specialized instructions into TaskEnvelopeV2.skills
```

P0 不依賴 agent 讀 `/southstar/pi-agent/skills/...`。未來可選擇 materialize readonly skill files，但不是本設計的必要條件。

## 5. Skill Spec Schema

新增 `skill_spec` payload schema：

```ts
type SkillSpecPayload = {
  schemaVersion: "southstar.library.skill_spec.v1";
  skillType: "base" | "specialized";
  title: string;
  description: string;
  baseSkillRef?: string;

  instructions: {
    format: "markdown";
    content: string;
  };

  domainRefs: string[];
  roleRefs?: string[];
  taskRefs?: string[];
  contractRefs?: string[];
  designedFor: Array<"pi-agent" | "codex" | "opencode">;

  fieldGuidance?: Record<string, {
    sectionId: string;
    description: string;
    dataType: "string" | "array" | "object" | "boolean" | "number";
    generationSteps: string[];
    example: unknown;
    validation: string[];
  }>;

  repairGuidance?: {
    template: string;
    fieldReferenceFormat: string;
  };

  provenance: {
    source: "seed" | "user" | "llm-proposal" | "migration" | "runtime-evidence";
    createdBy: "user" | "system" | "migration" | "llm" | "validator" | "runtime";
    sourceRefs?: string[];
  };
};
```

## 6. SkillSourceDefinition 擴展

現有 `SkillSourceDefinition` 需要支援 repair metadata，但仍保持 resolver 與 envelope snapshot 的單一路徑。

建議擴展：

```ts
type SkillSourceDefinition = {
  skillId: string;
  version: string;
  instructions: string;
  allowedTools: string[];
  requiredMounts: string[];
  mcpRequirements: string[];
  artifactContracts: string[];

  // 新增
  fieldGuidance?: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
  baseSkillRefs?: string[];
};
```

`ResolvedSkillSnapshot` 保留 `contentHash` 與 `mountPath`，但 `mountPath` 在 P0 中只是 metadata，不代表實際檔案一定存在。

## 7. Skill 內容結構

### 7.1 Base Skill: `artifact-generator-base`

Base skill markdown 包含：

1. Overview
2. Critical Requirements
3. JSON Output Format
   - 必須整個回應都是單一 JSON object
   - top-level keys: `artifact`, `progress`, `metrics`
   - response starts with `{` and ends with `}`
   - no text before/after JSON
   - no markdown code fences
4. Common Mistakes
   - 回傳檔案路徑而不是 artifact content
   - 在 JSON 前寫說明文字
   - required fields 巢狀放錯位置
   - partial artifact
5. Self-Validation Checklist
   - JSON syntax
   - top-level keys
   - all required fields present
   - no placeholders
   - evidence fields present where applicable
6. Repair Attempt Rules
   - read repair instruction
   - identify missing fields
   - use field guidance sections
   - regenerate complete artifact
   - validate before submit

### 7.2 Checker Skill: `checker-verification`

Checker skill 必須包含：

- Input
  - task goal
  - acceptance criteria
  - repo path `/workspace/repo`
  - prior implementation artifacts
  - verification_report contract
- Process steps
  - `cd /workspace/repo`
  - run `npm test`
  - run targeted timezone checks where relevant
  - inspect implementation without editing
  - verify each acceptance criterion
  - collect command/test evidence
- Field Generation Guide
  - `summary` section id `#field-summary`
  - `commandsRun` section id `#field-commandsRun`
  - `testResults` section id `#field-testResults`
  - `checkerFindings` section id `#field-checkerFindings`
  - `risks` section id `#field-risks`
- Output example
  - full JSON object with `artifact`, `progress`, `metrics`
- Checker-specific self-validation
  - `commandsRun` includes `npm test`
  - `testResults` includes command, passed, output, exitCode
  - `checkerFindings` covers all acceptance criteria
  - `risks` is array, possibly empty

### 7.3 Other Specialized Skills

#### Explorer Context Skill

Purpose：讀取 repo 與 issue context，產出 implementation plan。Required fields：

- `summary`
- `filesToInspect`
- `commandsToRun`
- `risks`

#### Planner Planning Skill

Purpose：將 issue 與 repo facts 轉成可執行計畫。若當前 runtime 將 planner task 映射到 explorer profile，compiler 仍需根據 task node id/name 選擇 planner skill。

Required fields 通常同 `implementation_plan`：

- `summary`
- `filesToInspect`
- `commandsToRun`
- `risks`

#### Implementer Implementation Skill

Purpose：實作功能、執行測試、回報 implementation artifact。Required fields：

- `summary`
- `filesChanged`
- `commandsRun`
- `testResults`
- `risks`
- `artifactEvidence`

#### Summarizer Completion Skill

Purpose：只在上游 implementation/verification accepted 後彙整完成報告。Required fields：

- `summary`
- `acceptedArtifacts`
- `tests`
- `risks`
- `followUps`

## 8. Task 與 Role/Profile 映射

真實 todo-web workflow 有 5 個 task：

- Explorer
- Planner
- Implementer
- Checker
- Summarizer

目前 compiler profile 映射可能只有 4 類：

- explorer
- maker
- checker
- summarizer

因此 skill 選擇不能只靠 role/profile。Compiler 必須根據 `node.id`, `node.name`, `node.roleRef`, artifact contract 共同決定 `skillRefs`。

建議映射：

```text
Explorer task     -> software-dev.skill.explorer-context
Planner task      -> software-dev.skill.planner-planning
Implementer task  -> software-dev.skill.implementer-implementation
Checker task      -> software-dev.skill.checker-verification
Summarizer task   -> software-dev.skill.summarizer-completion
```

每個 specialized skill 同時會解析並注入 base skill。

## 9. Design Library-backed Skill Catalog

新增 `LibraryBackedSkillCatalog`，實作現有 `SkillCatalog` interface：

```ts
class LibraryBackedSkillCatalog implements SkillCatalog {
  constructor(private db: SouthstarDb) {}
  resolve(skillId: string): SkillSourceDefinition {
    // find library object by key
    // load head version
    // ensure definitionKind === "skill_spec"
    // map SkillSpecPayload -> SkillSourceDefinition
  }
}
```

Resolver 必須支援 base skill 展開：

```text
resolveSkillSnapshots(skillRefs)
  -> resolve specialized skill
  -> resolve baseSkillRef recursively
  -> dedupe
  -> create snapshots
  -> persist runtime_resources skill_snapshot
```

如果循環引用，應失敗並報出 stable error：

```text
skill base dependency cycle: A -> B -> A
```

## 10. Compiler 改進

Compiler 需要：

1. 從 template node / agent spec / contract 推導 `task.skillRefs`。
2. 將 task-specific skillRefs 寫入 `WorkflowTaskDefinition.skillRefs`。
3. 將 skill library version refs 加入 `compiledFrom.libraryVersionRefs`，確保 workflow 可審計。
4. 不直接把 skill instructions 寫死進 task prompt；instructions 透過現有 `resolveTaskSkills()` -> `TaskEnvelopeV2.skills` 注入。
5. `ContextPacket.skillInstructions` 可保留摘要，但不能作為唯一 instruction source。

Acceptance：

- `runtime_resources` 中存在 `skill_snapshot`。
- `task_envelope.payload_json.skills.length > 0`。
- Pi prompt 中出現完整 skill instructions，而不是只有 `Use skill snapshot ...`。

## 11. Runtime Repair Instruction 改進

### 11.1 問題

目前 `evaluateArtifactGate` 是純函數，不應直接讀 DB 或 Design Library。Repair guidance 不能硬編碼 field guidance。

### 11.2 設計

把 repair metadata 放入 `ResolvedSkillSnapshot`，隨 envelope 傳入 agent-runner。

`runTaskEnvelope()` 在呼叫 `evaluateArtifactGate()` 時，提供 repair context：

```ts
type RepairContext = {
  contractId: string;
  fieldGuidance: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
};
```

`evaluateArtifactGate()` 仍保持純函數：

```ts
evaluateArtifactGate({
  artifact,
  requiredFields,
  attempt,
  maxRepairAttempts,
  repairContext,
})
```

Repair instruction 使用 skill metadata 動態生成：

```text
## Repair Required (Attempt 2/2)

Missing fields: summary, commandsRun, testResults, checkerFindings, risks

For each missing field, refer to your skill sections:
- summary -> #field-summary: Brief summary of verification outcome
- commandsRun -> #field-commandsRun: Record of commands executed
- testResults -> #field-testResults: Test execution data
- checkerFindings -> #field-checkerFindings: Verification outcomes
- risks -> #field-risks: Identified risks

Then:
1. Collect data for ALL missing fields
2. Generate complete JSON with ALL required fields
3. Self-validate using your skill checklist
4. Submit only after validation passes
```

No field-specific guidance is hardcoded in runtime code.

## 12. Harness Prompt Injection

`pi-sdk-harness.ts` already has `resolvedSkillInstructions(...)`。需強化格式：

```text
=== SKILL INSTRUCTIONS ===

## software-dev.skill.artifact-generator-base@version
...

## software-dev.skill.checker-verification@version
...

=== END SKILL INSTRUCTIONS ===
```

Repair instruction 應出現在 skill instructions 之後，讓 agent 先讀 skill，再讀本次修復目標。

Prompt order：

1. agentPrompt/context
2. skill instructions
3. workspace directive
4. attempt number
5. repair instruction

## 13. Seed 與版本管理

新增 seed function：

```ts
seedSoftwareDevSkills(db, { actorType: "migration" })
```

可由 `seedSoftwareDevDesignLibrary(...)` 呼叫，建立 6 個 `skill_spec` objects 與 versions。

Seed 需 idempotent：

- 若 objectKey 已存在，不重複 create object。
- 若內容 hash 不變，不新增 version。
- 若內容變更，新增 version 並更新 head。

Skill version refs 應寫入 workflow `compiledFrom.libraryVersionRefs`。

## 14. 測試策略

### 14.1 Unit Tests

新增或更新：

- `tests/v2/design-library/skill-seed.test.ts`
  - seeds 6 skill specs
  - each specialized skill has `baseSkillRef`
  - checker skill has fieldGuidance for all verification fields
- `tests/v2/skills/library-backed-catalog.test.ts`
  - resolves skill_spec from library
  - expands baseSkillRef
  - dedupes base skill
  - detects cycles
- `tests/v2/skills/resolver.test.ts`
  - persists `skill_snapshot`
  - snapshot includes fieldGuidance / repairGuidance
- `tests/v2/agent-runner/root-session-repair.test.ts`
  - missing fields produce formatted repair instruction
  - repair instruction references skill section IDs
  - no hardcoded checker-specific field guidance in runtime
- `tests/v2/design-library/compiler-skillrefs.test.ts`
  - todo-web template produces 5 task-specific skillRefs
  - planner and explorer can receive different skills even if same role/profile

### 14.2 Integration Tests

- Compile design-library todo-web template。
- Create run draft。
- Assert each task envelope has:
  - base skill snapshot
  - task-specific skill snapshot
  - non-empty instructions
  - skill snapshots persisted in SQLite

### 14.3 Real E2E Test：不可 calc / fake / mock / smoke

必須以真實 todo-web scenario 驗收，不可使用 calc。

Primary test：

```text
tests/e2e-real/design-library-template-real.test.ts
```

維持並強化現有 guard：

```ts
assert.equal(/calc\s+sum|software-change|assertCalcSum|softwareGoalPrompt/.test(source), false);
assert.equal(/fake|mock|smoke|codex|opencode|builtin-agent/i.test(source), false);
```

E2E 環境：

```bash
TORK_BASE_URL=http://localhost:8000
SOUTHSTAR_DB=/tmp/southstar-e2e-test.db
npm run test:e2e:design-library-real
```

驗收條件：

1. 使用真實 Tork，本地 port 8000。
2. 使用真實 SQLite `SOUTHSTAR_DB`。
3. 使用 Pi host adapter path，不使用 builtin agent。
4. Workflow issue 是 todo-web feature，不含 calc prompt/helper/assertion。
5. Tork job completed。
6. Workflow run status `passed` 或 `completed`。
7. `task_envelope` for Checker contains skills:
   - `software-dev.skill.artifact-generator-base`
   - `software-dev.skill.checker-verification`
8. Checker artifact contains all required fields:
   - `summary`
   - `commandsRun`
   - `testResults`
   - `checkerFindings`
   - `risks`
9. Evidence packet marks present:
   - `command-output`
   - `test-result`
10. Validator results pass:
   - schema
   - evidence
   - policy
11. `assertTodoWebFeatureImplemented(repo)` passes。
12. No fake/mock/smoke shortcut in test source or runtime path。

## 15. Implementation Impact Summary

Expected files to modify/create：

```text
src/v2/design-library/types.ts
src/v2/design-library/software-dev-seed.ts
src/v2/skills/types.ts
src/v2/skills/resolver.ts
src/v2/skills/catalog.ts or new library-backed-catalog.ts
src/v2/design-library/compiler.ts
src/v2/agent-runner/root-session.ts
src/v2/harness/pi-sdk-harness.ts
tests/v2/...
tests/e2e-real/design-library-template-real.test.ts
```

不需要新增 DB table。

## 16. Risks 與 Mitigations

### Risk: Prompt 過長

Mitigation：Base skill 精簡，specialized skill 只保留必要流程與欄位 guidance。Context policy 若超 budget，需在 builder 中給出 explicit error。

### Risk: Skill 內容與 contract drift

Mitigation：Seed/unit tests assert skill `fieldGuidance` keys match contract required/evidence fields。

### Risk: Repair metadata 遺漏

Mitigation：Resolver tests ensure snapshots include repair metadata；root-session repair tests assert formatted references。

### Risk: Agent 仍輸出自然語言

Mitigation：Base skill 明確禁止 JSON 前後文字；repair instruction 再次提醒；E2E 驗證 artifact accepted 與 evidence present。

### Risk: Planner / Explorer 映射混淆

Mitigation：Compiler skill selection uses task node id/name + contract ref, not only role/profile。

## 17. Acceptance Criteria

本設計完成後，必須滿足：

1. `skill_spec` 是 Design Library first-class object。
2. 6 個 software-dev skills seeded and versioned。
3. Existing `src/v2/skills` runtime path is reused。
4. Task envelopes contain resolved skill snapshots。
5. Pi prompt includes actual skill instructions。
6. Repair instruction is structured and references skill section IDs。
7. No runtime hardcoded per-field checker guidance。
8. Todo-web real E2E passes with local Tork and local SQLite。
9. E2E does not use calc, fake, mock, smoke, codex, opencode, or builtin-agent path。

## 18. Open Questions

目前沒有待定設計問題。若 implementation 中發現 `ResolvedSkillSnapshot.mountPath` 需要真實 materialization，應作為後續獨立設計，不阻塞 P0。

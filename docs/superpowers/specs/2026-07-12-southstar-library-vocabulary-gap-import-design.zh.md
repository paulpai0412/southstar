# Southstar Library Vocabulary Gap Import 設計

**日期：** 2026-07-12  
**狀態：** Approved  
**適用範圍：** Goal Design、Library import、Goal Contract vocabulary mapping

## 決策

Goal Design 不得為了完成單一 Goal 而直接發明 domain、capability、artifact 或 evaluator Library refs。Goal requirement 與 slice 先以自然語言形成，再映射至 approved Library vocabulary。

Library vocabulary 是可重用、可審核、可版本化的組織知識，不是每個 requirement 的執行輸出。只有 approved vocabulary 無法覆蓋 Goal 時，系統才建立 vocabulary gap proposal。

本設計取代主規格中「Goal 可自行建立 safe normalized child scope」的舊決策。新 scope 必須先成為 approved Library domain object，之後才能進入 Goal Contract 與 Composer。

## 資料流

```text
Goal prompt
  -> LLM 產生自然語言 requirements / slices
  -> host 對 approved Library vocabulary 做 mapping
  -> 全部匹配：完成 Goal Contract
  -> 存在缺口：persist vocabulary_gap，停止 composition
  -> LLM 只針對 gap 產生 Library import draft
  -> schema / reference / duplicate validators
  -> 使用者 review / approve
  -> 寫入 Library files 並同步 graph/version
  -> 重新執行 vocabulary mapping
  -> Goal Contract -> Composer DAG
```

Composer 與 runtime execution 不得建立或批准 vocabulary。它們只能消費 Goal Design 已解析且已版本化的 approved Library closure。

## Vocabulary authoring

Library import 支援以下一等 vocabulary candidates：

- `domain` -> `domain_taxonomy`
- `capability` -> `capability_spec`
- `artifact` -> `artifact_contract`
- `evaluator` -> `evaluator_profile`

LLM 只提出 candidate semantic fields、理由與關係。Host 擁有 schemaVersion、status、版本、檔案路徑正規化與最終 graph identity。LLM output 不得直接寫入 approved graph。

來源可為 Library Chat 貼入內容、GitHub repository、Library file editor，或 Goal vocabulary gap。Goal prompt 作為來源時，proposal 必須保留來源與 gap rationale，不能假裝為既有組織規範。

## Approval 與模式

預設 `confirm`：Goal Design 顯示 vocabulary gaps，使用者選擇是否建立 import draft。

`auto`：系統可自動建立 draft，但仍不得自動 approve。自動 approve 是獨立治理政策，不屬於 Goal Design mode。

Approve 必須先完成 preflight；成功後才以同一 transaction 同步 Library graph，失敗則不留下部分安裝結果。

## Contract 與 evaluator 分界

- Library `artifact_contract` 定義可重用的格式與證據規則。
- Goal requirement `expectedArtifacts` 定義本次 Goal 的具體交付物。
- Requirement evaluator contract 依 Goal acceptance criteria 產生並綁定 requirement；它不是每次都要新增的 Library vocabulary。
- Library evaluator profile 是可重用的 evaluator 執行能力，只有缺少適合 profile 時才進入 vocabulary gap。

## Failure semantics

- 未知或未 approved refs：回傳 `needs_library_input`，不得讓 interpreter 以 invented ref repair。
- Candidate schema invalid：draft 保持可修訂，不寫檔、不 sync。
- ObjectKey/路徑重複：preflight fail，要求選擇 reuse、revision 或 rename。
- Approve 後 mapping 仍有 gap：保留同一 Goal Design revision，再次呈現剩餘 gap；不得進 Composer。

## 驗收條件

1. Library import LLM schema 能產生四種 vocabulary candidate，並明確限制可填 kind 與欄位。
2. Candidate 經 host validator 後才能形成 Library file proposal。
3. Goal Design 只讀 approved domain/capability/artifact/evaluator objects。
4. 缺少 vocabulary 時 persisted draft 回傳 `needs_library_input` 與結構化 gaps，不會 invent refs 或進 Composer。
5. `confirm` 不自動建立 import draft；`auto` 可建立 draft但不 approve。
6. Approve/sync 後，同一 Goal 可重試 mapping 並繼續產生 Goal Contract/DAG。
7. 不新增 seed、fixture fallback、fake、mock 或 production hardcode。

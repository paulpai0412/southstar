---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.southstar-slice-to-dag-composer
title: "Southstar Slice to DAG Composer"
scope: "global"
status: approved
purpose: composer_guidance
---

# Southstar Slice to DAG Composer

Translate a finalized Goal Contract and Goal Design package into a workflow composition plan without inventing requirements, fixed task counts, or worker primitives.

## SOP

1. Treat `GoalDesignPackage.slicePlan` as the source of slice ownership; do not move requirement ownership or invent slice ids.
2. For each slice, create the smallest executable producer work needed for that slice outcome and expected artifacts.
3. Use dependency edges only when a task consumes a declared upstream `outputArtifactRef` through `inputArtifactRefs`.
4. Keep independent producer slices dependency-independent so the scheduler may run them in parallel.
5. Create verify/review tasks from evaluator contracts, not from task names. A verify/review task may cover multiple slices only when it depends on the producer artifacts it evaluates and lists the covered requirement ids.
6. When multiple producer branches contribute to one combined accepted outcome, use a downstream verify/review or integration task that consumes those producer artifacts.
7. Do not add repair/reverify nodes to the initial DAG. Runtime repair creates new revision nodes after evaluator failure.
8. Use summary or coordination nodes only for explicit handoff/aggregation; they may have empty requirement ids.

## Output Rules

Return only the host-requested workflow composition JSON. Every task must include `sliceId`, `requirementIds`, `dependsOn`, `inputArtifactRefs`, `outputArtifactRefs`, and `nodePromptSpec`. Select runtime primitives only from `GraphMetadataCandidates`; this SOP is guidance and must never be selected as a DAG skill.

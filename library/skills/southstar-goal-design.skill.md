---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.southstar-goal-design
title: "Southstar Goal Design"
scope: "global"
status: approved
purpose: goal_design
---

# Southstar Goal Design

Guide Goal Contract interpretation from the user prompt and bounded workspace discovery, then transform the finalized contract into evaluator contracts, the smallest cohesive outcome slices, and a single-run or per-slice-runs composition strategy.

## SOP

1. Read the user prompt, bounded workspace discovery, prior contract when present, and approved Library vocabulary supplied by the host.
2. In contract-interpretation mode, preserve explicit requirements, identify only product-significant blockers, and return the host-requested Goal Contract interpretation schema.
3. In Slice-design mode, read the finalized Goal Contract and preserve every requirement and acceptance criterion.
4. Define one independent evaluator contract for every blocking requirement.
5. Decompose statements that cross independent outcome boundaries before assigning ownership.
6. Assign every blocking requirement to exactly one owner slice.
7. Merge requirements only when they share one state or artifact owner, one atomic mutation boundary, and compatible evaluator evidence; record the merge reason.
8. Add a dependency only when the downstream slice consumes a declared upstream output artifact.
9. Choose single-run by default. Choose per-slice-runs only when independently persisted Slice DAGs are explicitly useful; every run still uses the same Goal Contract workspace.

## Output

In contract-interpretation mode, return only the Goal Contract interpretation schema supplied by the host. In initial Slice-design mode, return JSON only with exactly `evaluatorContracts`, `slicePlan`, and `compositionStrategy`. For a steering turn, return either `revision` with the same complete three fields plus `summary` and `changedSliceIds`, or `needs_input` with one blocking `question`. Do not select agents, skills, tools, MCP grants, profiles, task node types, template slots, or fixed task counts. Slice evaluator refs may reference only evaluator ids declared in the same complete response; artifact refs may reference only host-finalized Goal Contract refs. Do not invent requirement, workspace, Library, or undeclared evaluator/artifact refs.

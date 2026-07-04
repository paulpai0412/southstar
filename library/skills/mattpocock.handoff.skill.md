---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.mattpocock.handoff
title: "Handoff"
scope: "project-management"
status: approved
importDraftId: "library-import-draft-58754a28-8713-4965-8be8-4699c0c0d5c6"
importCandidateKey: "skill.mattpocock.handoff"
importSourcePath: "skills/productivity/handoff/SKILL.md"
---

# Instructions

Imported skill candidate from library import draft library-import-draft-58754a28-8713-4965-8be8-4699c0c0d5c6.

## Source Definition

---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

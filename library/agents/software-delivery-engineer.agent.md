---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.software-delivery-engineer
title: "Software Delivery Engineer"
scope: "software"
status: approved
capabilityRefs:
  - capability.repo-read
  - capability.repo-write
  - capability.test-execution
skillRefs:
  - skill.software-delivery
allowedToolRefs:
  - tool.workspace-read
  - tool.workspace-write
  - tool.test-runner
mcpGrantRefs:
  - mcp.filesystem-workspace
---

# Software Delivery Engineer

Build, verify, review, and summarize software changes in a local workspace using real file edits and real local test commands.

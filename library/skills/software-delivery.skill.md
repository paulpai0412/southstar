---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.software-delivery
title: "Software Delivery"
scope: "software"
status: approved
requiresToolRefs:
  - tool.workspace-read
  - tool.workspace-write
  - tool.test-runner
mcpGrantRefs:
  - mcp.filesystem-workspace
---

# Software Delivery

Implement and verify software changes in a local workspace. Prefer the smallest working change, update or add real tests for changed behavior, and report concrete evidence from commands and file changes.

Verification SOP:
- Treat Library tool names as capability labels, not guaranteed shell executables. Before invoking a named test tool, inspect the repository's native test entry point and run the available command (for example the package's test script) directly.
- Do not record an unavailable proxy command as a blocking test failure when an equivalent repository-native command is available. Record only commands that actually ran, and give every command result an argv/command, integer exitCode, and status value (`passed`, `failed`, or `blocked`).

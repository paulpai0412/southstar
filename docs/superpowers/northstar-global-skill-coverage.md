# Northstar Global Skill Coverage

| Requirement | Test Files | Implementation Files |
| --- | --- | --- |
| Bootstrap config draft requires confirmation | `tests/skills/northstar-config-renderer.test.ts` | `skills/northstar/scripts/lib/config-renderer.mjs`, `skills/northstar/scripts/render-config.mjs` |
| Global sync overwrites target | `tests/skills/northstar-sync.test.ts`, `tests/skills/northstar-platform.test.ts` | `skills/northstar/scripts/sync-global.mjs`, `skills/northstar/scripts/lib/platform.mjs` |
| Doctor reports platform, SQLite, git, gh, CLI, SDK | `tests/skills/northstar-doctor.test.ts` | `skills/northstar/scripts/lib/doctor.mjs`, `skills/northstar/scripts/doctor.mjs` |
| Project setup requires confirmation and defines fields/views | `tests/skills/northstar-project-viewer.test.ts` | `skills/northstar/scripts/lib/project-viewer.mjs` |
| Operator issue commands map to argv arrays | `tests/skills/northstar-operator-commands.test.ts` | `skills/northstar/scripts/lib/operator-commands.mjs` |
| Recovery scenarios and risk gates | `tests/skills/northstar-recovery.test.ts` | `skills/northstar/scripts/lib/recovery.mjs` |
| Linux/macOS/Windows path fixtures and no Unix-only hardcoding | `tests/skills/northstar-portability.test.ts`, `tests/skills/northstar-platform.test.ts` | `skills/northstar/scripts/lib/platform.mjs`, `skills/northstar/scripts/*.mjs` |
| Skill source instructions exist | `tests/skills/northstar-skill-files.test.ts` | `skills/northstar/SKILL.md`, `skills/northstar/README.md`, `skills/northstar/templates/northstar.yaml`, `skills/northstar/templates/workflow.issue-to-pr-release.yaml` |

# Runtime Dependency Decisions

## Status

- Date: 2026-05-29
- Status: accepted for first implementation slice

## Decisions

- npm package name: `@northstar/runtime`
- OpenCode SDK package and version range: `@opencode-ai/sdk@^1.15.12`
- Codex SDK package and version range: `@openai/codex-sdk@^0.135.0`
- SQLite package: Node built-in `node:sqlite`, pinned by runtime engine requirement `node >=22.22.2`
- Workflow package format for version 1: YAML documents parsed into typed `WorkflowDefinition` values

## Rationale

The first slice needs a clean TypeScript runtime that can run in this workspace without blocking on native package installation. Node 22 already provides `node:sqlite`, which lets the store own a real SQLite database while keeping `npm test` dependency-free for the foundation tests.

OpenCode and Codex adapter packages are pinned as dependency decisions but are not imported by unit tests. Runtime code talks through `HostAdapter`; concrete SDK-backed adapters are loaded through dynamic SDK loader boundaries. The OpenCode SDK package was updated from `opencode-ai` to `@opencode-ai/sdk` after live smoke showed `opencode-ai@1.15.12` is a CLI binary wrapper with no JavaScript module entrypoint, while `@opencode-ai/sdk@1.15.12` exposes ESM SDK entrypoints. The Codex SDK range was updated to `^0.135.0` after registry verification showed `@openai/codex-sdk` is published at `0.135.0`, while the earlier `^0.1.0` range did not resolve to an installable package version.

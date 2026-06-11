# Northstar Skill

This directory is the source of truth for the Northstar Codex skill.

## Sync

Run from the Northstar repo root:

```bash
npm run skill:sync
```

This overwrites the global skill at `~/.codex/skills/northstar` or `%USERPROFILE%\.codex\skills\northstar`.

## Doctor

Run from the Northstar repo root. For a consumer repo, pass its config explicitly and keep `NORTHSTAR_ROOT` pointed at the real Northstar checkout:

```bash
export NORTHSTAR_ROOT=/path/to/northstar
npm run skill:doctor -- --json
npm run northstar -- doctor --config /path/to/consumer/.northstar.yaml --json
```

## Render Consumer Config

Run from a consumer repo:

```bash
npm run skill:render-config -- --cwd /path/to/consumer --json
```

Write only after reviewing the draft:

```bash
npm run skill:render-config -- --cwd /path/to/consumer --write --confirmed
```

## Operate A Consumer Issue

Use explicit config paths and let Northstar workers own feature git operations:

```bash
npm run northstar -- inspect --config /path/to/consumer/.northstar.yaml --issue 15 --json
npm run northstar -- watch --config /path/to/consumer/.northstar.yaml --bounded --max-cycles 40 --idle-timeout-seconds 120
npm run northstar -- release --config /path/to/consumer/.northstar.yaml --issue 15 --confirmed
npm run northstar -- reconcile --config /path/to/consumer/.northstar.yaml --issue 15
```

`release_pending` means waiting for operator approval; `releasing` means release worker active. Implementation, verification, browser/UI validation, PR merge, branch/worktree cleanup, and release git operations belong to workers, not the operator.

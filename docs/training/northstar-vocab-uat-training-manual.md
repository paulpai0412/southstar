# Northstar Vocabulary UAT Training Manual

Date: 2026-05-31

## 1. Overview And Goals

This manual records a real Northstar UAT executed against the consumer repository `paulpai0412/northstar-vocab-uat`.

The UAT goal is to use the Northstar skill to create a GitHub Project, create ordered GitHub issues, run Northstar software-development automation, merge real PRs, close real issues, verify the finished English vocabulary web app in a real browser, and document the process for future operators.

## 2. Evidence Log

| Time | Operator Intent | Northstar Skill Action | Evidence | Result |
| --- | --- | --- | --- | --- |
| 2026-05-31T12:33:01+08:00 | Start real UAT evidence capture | Created training manual and metrics file | `docs/training/northstar-vocab-uat-training-manual.md`, `docs/training/northstar-vocab-uat-metrics.json` | Passed |
| 2026-05-31T12:33:01+08:00 | Verify Northstar CLI readiness | Ran `node --run northstar -- --help` and `node --run northstar -- watch --help` | CLI help output listed command surface and watch options | Passed |
| 2026-05-31T12:33:01+08:00 | Verify Northstar coverage gate | Ran `npm run test:coverage` | 317 tests passed; requirement coverage 100%; code coverage total 94.73% statements, 85.69% branches, 96.89% functions, 94.73% lines | Passed |
| 2026-05-31T12:33:01+08:00 | Verify GitHub auth without exposing token | Ran `gh auth status` and `gh auth token >/dev/null` | Authenticated as `paulpai0412`; token value not printed | Passed |
| 2026-05-31T12:34:12+08:00 | Create real UAT consumer repository | Created GitHub repo and cloned it locally | [paulpai0412/northstar-vocab-uat](https://github.com/paulpai0412/northstar-vocab-uat), `/home/timmypai/apps/northstar-vocab-uat` | Passed |
| 2026-05-31T12:34:12+08:00 | Verify clean issue numbering precondition | Listed all GitHub issues in the new repo | `gh issue list` returned `[]`; issue #1-#6 plan remains valid | Passed |
| 2026-05-31T12:35:42+08:00 | Bootstrap Northstar in consumer repo | Ran Northstar skill config renderer for `/home/timmypai/apps/northstar-vocab-uat` | `.northstar.yaml` created with `software_development`, `issue_to_pr_release`, `northstar:ready`, `auto_release: true`, and env-based GitHub credential reference | Passed |
| 2026-05-31T12:35:42+08:00 | Verify config safety | Scanned `.northstar.yaml` for required signals and secret patterns | Required signals found; no `ghp_`, `github_pat_`, `sk-`, `OPENAI_API_KEY`, or `token:` secret values found | Passed |
| 2026-05-31T12:35:42+08:00 | Verify config load behavior | Ran `node --run northstar -- init --config /home/timmypai/apps/northstar-vocab-uat/.northstar.yaml --dry-run` after finding `inspect` requires `--issue` | Config loaded successfully; root cause recorded as plan/CLI mismatch, not runtime failure | Passed |
| 2026-05-31T12:35:42+08:00 | Publish consumer bootstrap config | Committed and pushed `.northstar.yaml` to consumer repo main | Consumer commit `7312a68` | Passed |
| 2026-05-31T15:55:31+08:00 | Create GitHub Project monitoring | Created a real GitHub Project by copying existing Project #3 to preserve 5 real views, then added 14 Northstar fields | [Northstar Vocabulary UAT Project #28](https://github.com/users/paulpai0412/projects/28); 35 total fields; 5 views | Passed |
| 2026-05-31T15:55:31+08:00 | Link Project to consumer repo | Ran `gh project link 28 --owner paulpai0412 --repo paulpai0412/northstar-vocab-uat` | Project #28 linked to `paulpai0412/northstar-vocab-uat` | Passed |
| 2026-05-31T15:55:31+08:00 | Enable Project sync in consumer config | Updated `.northstar.yaml` with `github.project.enabled: true` and `project_id: PVT_kwHOEEXCNM4BZSEq` | Consumer commit `c4cbe50`; config dry-run loaded successfully; no secret patterns found | Passed |
| 2026-05-31T15:55:31+08:00 | Record discarded Project setup path | The initial empty Project #27 has only 1 API-created view because GitHub exposes no public create-view mutation; it is not used as UAT evidence | Active UAT Project is #28 | Informational |
| 2026-05-31T15:59:37+08:00 | Create ordered UAT issues | Created six real GitHub issues with `northstar:ready` label | [#1](https://github.com/paulpai0412/northstar-vocab-uat/issues/1), [#2](https://github.com/paulpai0412/northstar-vocab-uat/issues/2), [#3](https://github.com/paulpai0412/northstar-vocab-uat/issues/3), [#4](https://github.com/paulpai0412/northstar-vocab-uat/issues/4), [#5](https://github.com/paulpai0412/northstar-vocab-uat/issues/5), [#6](https://github.com/paulpai0412/northstar-vocab-uat/issues/6) | Passed |
| 2026-05-31T15:59:37+08:00 | Configure issue dependency ordering | Added marker dependencies and Project order fields | Dependency edges: #2 -> #1, #3 -> #2, #4 -> #2, #5 -> #3/#4, #6 -> #5; `gh issue edit` exposes no native dependency flag in this environment | Passed |
| 2026-05-31T15:59:37+08:00 | Add issues to Project #28 | Added six issues to the Project and set `Northstar Issue Order`, `Northstar Blocked By`, and `Northstar Lifecycle=ready` | `gh project item-list 28 --owner paulpai0412 --limit 100` returned six UAT issue items | Passed |
| 2026-05-31T17:02:00+08:00 | Recover from pre-validation Northstar defects | Fixed Northstar runtime defects found before the final clean validation window: parent runtime DB directory creation, Codex worker network access, dependency parsing/scheduling, worktree commit SHA/resume, worktree base sync, SDK timeout wiring, prompt guardrails, watch cycle phasing, and `release_pending` retry | Last Northstar fix commit before final validation: `87f7ef6` | Passed |
| 2026-05-31T17:23:25+08:00 | Reset UAT stability window | Closed stale conflicting PR #10, removed Northstar labels from pre-fix issues #4-#6, and archived pre-fix runtime state | Runtime archive: `.northstar/runtime-archived-before-stability-20260531-172325` in consumer repo | Passed |
| 2026-05-31T17:25:00+08:00 | Create clean 5-issue validation set | Created issues #11-#15 with dependency graph #11 -> #12/#13 -> #14 -> #15 | Issues: [#11](https://github.com/paulpai0412/northstar-vocab-uat/issues/11), [#12](https://github.com/paulpai0412/northstar-vocab-uat/issues/12), [#13](https://github.com/paulpai0412/northstar-vocab-uat/issues/13), [#14](https://github.com/paulpai0412/northstar-vocab-uat/issues/14), [#15](https://github.com/paulpai0412/northstar-vocab-uat/issues/15) | Passed |
| 2026-05-31T17:25:05+08:00 | Run production Northstar watch | Ran `node --run northstar -- watch --config /home/timmypai/apps/northstar-vocab-uat/.northstar.yaml --max-cycles 240 --interval-ms 2000 --log-json` with real GitHub, real Codex SDK worker, local issue worktrees, real PRs, and auto release | Watch events showed dependency-gated starts and ended with `active_issues=0`; no Northstar code changes during this 5-issue window | Passed |
| 2026-05-31T17:29:00+08:00 | Complete issue #11 | Northstar created and merged PR #16 | [PR #16](https://github.com/paulpai0412/northstar-vocab-uat/pull/16), merge SHA `d958e8d641862c7701695c728de431fbcf84c90a` | Passed |
| 2026-05-31T17:34:00+08:00 | Complete issue #12 | Northstar created and merged PR #17 | [PR #17](https://github.com/paulpai0412/northstar-vocab-uat/pull/17), merge SHA `1363fb1c83672e7f1c21ce40cd3f388b382355c7` | Passed |
| 2026-05-31T17:39:00+08:00 | Complete issue #13 | Northstar created and merged PR #18 | [PR #18](https://github.com/paulpai0412/northstar-vocab-uat/pull/18), merge SHA `6d92213373b6533ecdaa1ac6231c70859ddf6c69` | Passed |
| 2026-05-31T17:48:00+08:00 | Complete issue #14 | Northstar created and merged PR #19 | [PR #19](https://github.com/paulpai0412/northstar-vocab-uat/pull/19), merge SHA `196c2f180b6be5e1bdb9d3dc3db84781cc299b20` | Passed |
| 2026-05-31T17:59:00+08:00 | Complete issue #15 | Northstar created and merged PR #20 | [PR #20](https://github.com/paulpai0412/northstar-vocab-uat/pull/20), merge SHA `fe84ba174843973a98d35df92c5dab7b8aab8afb` | Passed |
| 2026-05-31T18:05:00+08:00 | Verify final app build | Ran `npm run build` in consumer repo after pulling latest main | Vite production build passed | Passed |
| 2026-05-31T18:06:00+08:00 | Detect consumer verification config defect | Ran `npm test` and `npm run test:coverage`; Vitest discovered `.northstar/runtime/worktrees/**` and nested `node_modules` | Root cause: consumer Vitest config did not exclude Northstar runtime artifacts. This was treated as a consumer app defect, not a Northstar runtime defect. | Failed then recovered |
| 2026-05-31T18:10:00+08:00 | Auto-recover consumer verification defect | Created issue #21 and let Northstar implement it through the same production watch flow | [Issue #21](https://github.com/paulpai0412/northstar-vocab-uat/issues/21), [PR #22](https://github.com/paulpai0412/northstar-vocab-uat/pull/22), merge SHA `d79b6e56780cc60436a23ff8c971f1eef7097548` | Passed |
| 2026-05-31T18:16:00+08:00 | Verify consumer build/unit/coverage after recovery | Ran `npm run build`, `npm test`, and `npm run test:coverage` in consumer repo | Build passed; 3 test files / 18 tests passed; coverage: statements 100%, branches 96.72%, functions 100%, lines 100% | Passed |
| 2026-05-31T18:16:30+08:00 | Verify real browser UAT | Ran `npm run test:e2e` in consumer repo | 12 Playwright tests passed across desktop Chromium and mobile Chromium | Passed |

## 3. Final Consumer Repository

- Repository: [paulpai0412/northstar-vocab-uat](https://github.com/paulpai0412/northstar-vocab-uat)
- Project: [Northstar Vocabulary UAT Project #28](https://github.com/users/paulpai0412/projects/28)
- Local path: `/home/timmypai/apps/northstar-vocab-uat`
- Runtime config: `/home/timmypai/apps/northstar-vocab-uat/.northstar.yaml`

## 4. Issue Dependency Graph

The final clean validation window started after Northstar commit `87f7ef6`.

```text
#11 foundation
  -> #12 keyboard study flow
  -> #13 quiz streak scoring
#12 + #13
  -> #14 progress review panel
#14
  -> #15 responsive polish and browser acceptance
```

Issue #21 was a recovery issue created after final verification found a consumer test configuration defect. It was handled by Northstar through the same production flow.

## 5. Final PR And Merge Evidence

| Issue | PR | Merge SHA | Result |
| --- | --- | --- | --- |
| [#11](https://github.com/paulpai0412/northstar-vocab-uat/issues/11) | [#16](https://github.com/paulpai0412/northstar-vocab-uat/pull/16) | `d958e8d641862c7701695c728de431fbcf84c90a` | Merged, issue closed |
| [#12](https://github.com/paulpai0412/northstar-vocab-uat/issues/12) | [#17](https://github.com/paulpai0412/northstar-vocab-uat/pull/17) | `1363fb1c83672e7f1c21ce40cd3f388b382355c7` | Merged, issue closed |
| [#13](https://github.com/paulpai0412/northstar-vocab-uat/issues/13) | [#18](https://github.com/paulpai0412/northstar-vocab-uat/pull/18) | `6d92213373b6533ecdaa1ac6231c70859ddf6c69` | Merged, issue closed |
| [#14](https://github.com/paulpai0412/northstar-vocab-uat/issues/14) | [#19](https://github.com/paulpai0412/northstar-vocab-uat/pull/19) | `196c2f180b6be5e1bdb9d3dc3db84781cc299b20` | Merged, issue closed |
| [#15](https://github.com/paulpai0412/northstar-vocab-uat/issues/15) | [#20](https://github.com/paulpai0412/northstar-vocab-uat/pull/20) | `fe84ba174843973a98d35df92c5dab7b8aab8afb` | Merged, issue closed |
| [#21](https://github.com/paulpai0412/northstar-vocab-uat/issues/21) | [#22](https://github.com/paulpai0412/northstar-vocab-uat/pull/22) | `d79b6e56780cc60436a23ff8c971f1eef7097548` | Merged, issue closed |

## 6. Operator Procedure

1. Confirm `gh auth status` is authenticated and `gh auth token` works without printing the token.
2. Create or select a consumer repository.
3. Use the Northstar skill/config renderer to create `.northstar.yaml`.
4. Optional but recommended: create a GitHub Project and enable `github.project.enabled`.
5. Create GitHub issues with the `northstar:ready` label and explicit dependency markers such as `Depends-On: #11`.
6. Run:

```bash
GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_ROOT=/home/timmypai/apps/northstar node --run northstar -- watch --config /path/to/consumer/.northstar.yaml --max-cycles 240 --interval-ms 2000 --log-json
```

7. Monitor GitHub issues, PRs, and Project fields for `northstar:running`, `northstar:verifying`, `northstar:verified`, and `northstar:completed`.
8. Pull consumer `main` and run final verification:

```bash
npm ci
npm run build
npm test
npm run test:coverage
npm run test:e2e
```

## 7. Recovery Notes

- Pre-validation Northstar bugs were fixed in Northstar and committed before the final 5-issue stability window.
- Stale pre-fix runtime state was archived instead of deleted.
- Stale PR #10 was closed and excluded from final evidence.
- Consumer issue #21 proves recovery through Northstar itself: the final verification defect was fixed through a new GitHub issue, production watch, PR merge, and issue close.

## 8. Final Acceptance Summary

- Clean validation issues completed: 5/5.
- Additional recovery issue completed: 1/1.
- Dependency ordering violations: 0.
- Duplicate PRs in clean validation: 0.
- Secret leaks observed in prompts, logs, issues, or history: 0.
- Consumer build: passed.
- Consumer unit tests: 18/18 passed.
- Consumer coverage: statements 100%, branches 96.72%, functions 100%, lines 100%.
- Browser UAT: 12/12 Playwright tests passed across desktop and mobile Chromium.

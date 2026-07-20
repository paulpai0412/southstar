# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations and infer `paulpai0412/southstar` from the repository remote.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --json number,title,body,state,url,labels,comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the issue and its comments.

## Pull requests as a triage surface

PRs as a request surface: **no**. Triage issues only; do not pull external PRs into the issue triage queue.

## Wayfinding operations

Use one issue labelled `wayfinder:map` as the map and GitHub sub-issues as child tickets. Represent blocking relationships with GitHub issue dependencies when available; otherwise add `Blocked by: #<number>` to the child issue. A ticket is ready only when all blockers are closed and it is unassigned. Claim it with `gh issue edit <number> --add-assignee @me`.

---
name: stack-ship
description: >-
  Ship the current stax branch through the quality pipeline: gate on roborev
  per-commit reviews (bounded auto-fix loop on failure), squash-submit one
  clean commit upstream as a PR via stax, then run blinded cross-provider
  adversarial review on that PR. Use when asked to "stack-ship", "ship this
  branch", or to present a stacked branch upstream for review.
---

# stack-ship

Pipeline: roborev gate → `st stack submit --squash` → `/z-adversarial-review`.
Never submit on a red gate. Arguments: `--draft` (open the PR as a draft),
`--skip-adversarial` (stop after submit; state in the report that adversarial
review was skipped and why).

Assumes: `st` (stax) initialized in the repo, roborev hook installed
(`roborev init`), z-adversarial-review skill installed. `check-pipeline.sh`,
shipped alongside this skill, verifies all of it:
`bash ~/.claude/skills/stack-ship/check-pipeline.sh`.

## 1. Preflight — every check must pass or stop with BLOCKED

- Feature branch: `git rev-parse --abbrev-ref HEAD` is not the trunk branch.
- Clean tree: `git status --porcelain --untracked-files=no` prints nothing.
  Untracked files can't leak into a squash submit; modified tracked files can.
- Daemon up: `roborev status` succeeds. If down, run `roborev daemon start`
  and re-check once; still down = BLOCKED (report the error output).
- No in-flight reviews: poll until
  `roborev list --json --status queued` and `--status running` are both empty.
  Cap at 5 minutes; pending is not failure — keep waiting, do not skip.

## 2. Gate — deterministic, branch-state authoritative

Per-commit verdicts can be orphaned by restacks (post-rewrite re-enqueues, but
history rewrites still shuffle SHAs), so the gate reviews the branch as it
stands, not the historic ledger:

```bash
roborev review --branch --wait
```

Then the mechanical pass check — reviews stay "open" in the ledger until
explicitly closed even when they PASS, so gate on failing verdicts, not on
open count:

```bash
# Fail-closed: exits non-zero on any F verdict among completed jobs, any
# crashed (failed) review job, a non-array response, or a done-job verdict
# outside P/F (schema drift must break the gate, not pass it). A failed job
# means a commit went unreviewed — re-run it (roborev review <sha>) or close
# it deliberately before submitting; a branch of all-crashed reviews must
# not submit as if it were green. Queued/running/canceled jobs carry
# verdict:null and are excluded — preflight already drained the queue, and
# this very gate's --branch review enqueues jobs the moment it runs.
# --branch pins the scope explicitly rather than trusting the CLI's
# current-branch default.
roborev list --json --open --branch "$(git branch --show-current)" | jq -e '
  (. // [])
  | type=="array"
  and all(.[]; .status=="queued" or .status=="running" or .status=="done"
               or .status=="failed" or .status=="canceled")
  and all(.[] | select(.status=="done"); .verdict=="P" or .verdict=="F")
  and all(.[] | select(.status!="done"); .verdict==null)
  and ([.[] | select(.status=="done" and .verdict=="F")] | length == 0)
  and ([.[] | select(.status=="failed")] | length == 0)' >/dev/null
```

A failing review whose findings a later commit already addressed (confirmed
by the branch-level re-review passing) is stale: close it with
`roborev close <id>` — the CLI has no comment flag, so name the fixing
commit in the ship report instead.

**Red gate → bounded auto-fix, single retry:**

```bash
roborev refine --max-iterations 3
```

then re-run the gate exactly once. Still red = stop: list each open finding
(job id, severity, one-line summary) from `roborev list --json --open`, end
with BLOCKED. The refine loop is the only retry; never loop the gate itself.

## 3. Submit — one clean commit upstream

```bash
st stack submit --squash --ai --yes        # add --draft when flagged
```

Squashes all commits on each branch into one before pushing, creates/updates
the PR with AI title/body. Stacks of 2+ PRs auto-register as GitHub native
stacks via gh-stack (stax default `native_stack = "auto"`); single-PR stacks
are skipped — normal for a one-branch flow.

Resolve the PR: `gh pr view --json number,url`.

## 4. Adversarial review

Invoke the z-adversarial-review skill on that PR number with skeptic seats
codex, agy, claude — i.e. `--skeptic-models '["codex","agy","inherit"]'`
(`inherit` = the Claude seat). Skipped only when `--skip-adversarial` was
passed.

## 5. Report

- PR URL and draft/published state.
- Gate: passed first try, or refine iterations used.
- Adversarial verdict, confidence, and skeptic quorum (received/of).
- Whether local branch SHAs were rewritten by the squash (note it so the
  next session knows the ledger reset).
- Completion status: exactly one of DONE (all steps ran, gate green,
  evidence for every claim), DONE_WITH_CONCERNS (shipped, but list each
  concern with severity), or BLOCKED (state what stopped the pipeline and
  what was tried). "Partially done" is not a status.

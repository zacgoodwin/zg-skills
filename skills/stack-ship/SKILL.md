---
name: stack-ship
description: >-
  Ship the current stax branch through the quality pipeline: gate on roborev
  per-commit reviews (bounded auto-fix loop on failure), squash-submit one
  clean commit upstream as a PR via stax, run blinded cross-provider
  adversarial review on that PR, then patch-bump VERSION on the shipped PR.
  Use when asked to "stack-ship", "ship this branch", or to present a stacked
  branch upstream for review.
---

# stack-ship

Pipeline: roborev gate → `st stack submit --squash` → `/z-adversarial-review`
→ version bump.
Never submit on a red gate. Arguments: `--draft` (open the PR as a draft),
`--skip-adversarial` (stop after submit; state in the report that adversarial
review was skipped and why).

Assumes: `st` (stax) initialized in the repo, roborev hook installed
(`roborev init`), z-adversarial-review skill installed. `check-pipeline.sh`,
shipped alongside this skill, verifies all of it. Resolve the repo-local
install first, `$HOME` as fallback for a global-only install:
`PACK=".claude/skills/stack-ship"; [ -d "$PACK" ] || PACK="$HOME/.claude/skills/stack-ship"; bash "$PACK/check-pipeline.sh"`.

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
open count. The filter ships as `gate.jq` next to this file (its header
comment says what it rejects and why); run the file, never an inline copy,
so no shell or hook between you and jq can rewrite it:

```bash
# Fail-closed: any F verdict, crashed job with no later covering review,
# schema drift, or a null/empty ledger exits non-zero. --branch pins the
# scope explicitly rather than trusting the CLI's current-branch default. A
# trunk other than origin's default (roborev's --base) never matches
# GATE_RANGE: fail-closed.
PACK=".claude/skills/stack-ship"; [ -d "$PACK" ] || PACK="$HOME/.claude/skills/stack-ship"
trunk=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
range="$(git merge-base "${trunk:-origin/main}" HEAD)..$(git rev-parse HEAD)"
roborev list --json --open --branch "$(git branch --show-current)" |
  GATE_RANGE="$range" jq -e -f "$PACK/gate.jq" >/dev/null
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

## 5. Version bump — only on a shippable verdict

Patch-bump the shipping repo's root `VERSION` after the adversarial verdict
comes back mergeable, so the shipped diff carries its own version. With
`--skip-adversarial`, bump right after submit. Skip the bump (and say why in
the report) when the verdict is do-not-merge. The block below skips it on its
own, printing a `bump skipped:` line, when `VERSION` is missing, untracked
(a stray file some tool left at the root is not this repo's version), or not
a dotted version.

```bash
# Bumps the last dot component (1.2.3 -> 1.2.4); 10# keeps "08" decimal.
# ponytail: dotless or suffixed versions (e.g. "3", "1.2.3-rc1") are skipped,
# not bumped; adopt a semver tool if a repo ever needs them.
v="$(tr -d '[:space:]' 2>/dev/null < VERSION)"
if ! git ls-files --error-unmatch VERSION >/dev/null 2>&1; then
  echo "bump skipped: VERSION not tracked"
elif ! printf '%s\n' "$v" | grep -Eqx '[0-9]+([.][0-9]+)+'; then
  echo "bump skipped: VERSION malformed: '$v'"
else
  printf '%s\n' "${v%.*}.$((10#${v##*.} + 1))" > VERSION
  git add VERSION
  git commit -m "chore: bump version to $(cat VERSION)"
  st stack submit --squash --yes    # update the PR; no --ai, keep title/body
fi
```

The bump commit re-triggers the roborev post-commit hook; its review lands
after this run ends — normal, the next run's preflight drains it.

## 6. Report

- PR URL and draft/published state.
- Gate: passed first try, or refine iterations used.
- Adversarial verdict, confidence, and skeptic quorum (received/of).
- New version after the bump, or why it was skipped: do-not-merge verdict,
  or the step-5 `bump skipped:` line verbatim (VERSION not tracked, or the
  malformed value).
- Whether local branch SHAs were rewritten by the squash (note it so the
  next session knows the ledger reset).
- Completion status: exactly one of DONE (all steps ran, gate green,
  evidence for every claim), DONE_WITH_CONCERNS (shipped, but list each
  concern with severity), or BLOCKED (state what stopped the pipeline and
  what was tried). "Partially done" is not a status.

---
name: adversarial-review
description: |
  Blinded adversarial review for any GitHub PR. Assembles a blinded four-key
  input (spec, acceptance criteria, diff, throwaway worktree), spawns one
  fresh reviewer agent holding nothing else, fans out 3 independent skeptic
  sub-agents on non-trivial diffs, and reports a confidence-scored verdict
  with the skeptic quorum counted off disk. Read-only by default; posting the
  review to the PR is an explicit opt-in.
  Use when asked to "adversarial-review", "adversarially review this PR",
  "review PR <N> with skeptics", or for a blinded second opinion on any pull
  request.
---

# /adversarial-review — Blinded Adversarial PR Review

The reviewer is **blinded by design**: it receives EXACTLY the spec, the
acceptance criteria, the diff, and a throwaway worktree of the head commit —
no PR discussion, no CI status, no author narrative beyond what is disclosed
as such, and none of YOUR context. On a non-trivial diff it spawns 3
independent skeptic sub-agents tasked to REFUTE the diff. Every verdict is a
**file**: the reviewer and each skeptic write `verdict.json` in their own
artifact directories, and the quorum is counted off those files — never off
anyone's prose.

Everything decidable is decided in code (`lib/review.ts`): spec selection,
acceptance-criteria extraction, diff generation, worktree lifecycle, fan-out
activation, skeptic briefs, verdict validation, quorum counting. Your latent
work is exactly three things: spawn the reviewer, relay the collected verdict
as a report, and exercise judgment on anything the verdict asks a human to
settle.

**Prerequisites:** run from inside a git checkout of the repo under review;
`bun` and an authenticated GitHub CLI on PATH.

## Step 1 — Assemble the blinded input (deterministic)

`$PR_ARG` is the PR number from the user's invocation
(`/adversarial-review 123`); leave it empty to review the current branch's
open PR.

```bash
PACK="$HOME/.claude/skills/adversarial-review"
[ -d "$PACK" ] || PACK="$(cd "$(dirname "${BASH_SOURCE:-$0}")" && pwd -P)"
TMP=$(mktemp -d)

# PR metadata (read-only)
gh pr view $PR_ARG --json number,title,url,body,headRefOid,baseRefOid,baseRefName,labels,closingIssuesReferences > "$TMP/pr.json"

# Linked closing issue (read-only, optional): the preferred spec source,
# because it is independent of the diff author's own narrative
SPEC_ISSUE=$(jq -r '.closingIssuesReferences[0].number // empty' "$TMP/pr.json")
[ -n "$SPEC_ISSUE" ] && gh issue view "$SPEC_ISSUE" --json body,labels > "$TMP/issue.json"

bun "$PACK/lib/review.ts" prepare --pr-json "$TMP/pr.json" \
  ${SPEC_ISSUE:+--issue-json "$TMP/issue.json"} \
  --repo . --out-dir "$TMP" > "$TMP/manifest.json"
cat "$TMP/manifest.json"
```

`prepare` fetches the PR head if it is not local, writes the merge-base diff
with lockfiles excluded (falling back to unfiltered when the PR is
lockfile-only), creates a throwaway worktree of the head commit under the
repo's own `.worktrees/review-pr-<N>` (self-healing if a previous run left one
behind), writes the blinded `input-pr-<N>.json` — EXACTLY the four keys
`{ticketBody, acceptanceCriteria, diff, worktreePath}`, enforced by a
compile-time + runtime gate — mints a one-shot run identity for the verdict
envelope, and builds the reviewer prompt (skeptic briefs included, composed in
code). The manifest tells you everything you need:

- `adversarial` — whether the skeptic fan-out is active. Computed, never your
  call: `always`/`off` by mode, `non-trivial` (the default) on a diff of >= 10
  changed lines or any `security`/`migration`/`payments`/`auth` label. The
  user can override with "review with skeptics" / "single pass" — pass
  `--adversarial-mode always` or `off` to `prepare`.
- `specSource` — where the spec came from. `linked issue #N` is the honest
  yardstick; `PR description (author-authored)` or `none` is a caveat your
  report MUST repeat, because the reviewer had no spec independent of the
  diff's author.
- `runId`, `runRoot`, `verdictPath` — the verdict envelope Step 3 validates
  against; pass them back verbatim.
- `stub` — the ~400-byte pointer prompt for the spawn below.

## Step 2 — Spawn the reviewer (one fresh agent, synchronous)

Spawn ONE fresh agent with the Agent tool:

- `prompt`: the manifest's `stub` value, verbatim. Never read `prompt-pr-<N>.txt`
  or `input-pr-<N>.json` yourself — your context is not blinded, and the
  worker reads its own instructions from disk; anything you read back just
  pollutes your window.
- `run_in_background: false` — REQUIRED. The reviewer must finish inside this
  tool call. This skill sends the reviewer exactly one message; a backgrounded
  reviewer that ends its turn waiting is a review nobody will ever collect.
- No `model` override: the reviewer inherits your session's model.

The reviewer executes in the throwaway worktree (typecheck + the tests the
diff touches), and on an adversarial pass spawns its 3 skeptics itself, inside
its own turn, from the verbatim briefs its prompt carries. Its final message
is just "verdict written" — the review itself lands as files. Expect several
minutes of wall clock; that is the review running, not a hang.

## Step 3 — Collect the verdict (deterministic)

Never read the verdict files yourself and never trust the agent's prose —
validate and count in code, with the manifest's own envelope values:

```bash
bun "$PACK/lib/review.ts" collect --verdict "$VERDICT_PATH" \
  --run-root "$RUN_ROOT" --run "$RUN_ID" --ticket "$PR_NUM"
```

Prints `{ok, result, notes, confidence, quorum}`. `result` is one of
`REVIEW-APPROVE`, `REVIEW-FINDINGS`, `NEEDS-HUMAN`, `BLOCKED`, `CONFUSED`.
`quorum` is `{received, of, unrefuted, invalid}` counted off the skeptic
verdict files on disk (`null` on a single pass). An `{ok: false, reason}` —
missing file, mis-addressed envelope, pasted placeholder — means the review
FAILED: relay the reason, clean up, and offer to re-run; never reconstruct a
verdict from the transcript.

## Step 4 — Report, then clean up

Render the report to the user (and to `"$TMP/report.md"` if it may be posted):

```markdown
## Adversarial review — PR #<pr> <title>

**Verdict:** <result>
**Confidence:** <confidence>/100 (skeptics upheld <unrefuted>/<received> of <of> spawned — omit when quorum is null)
**Mode:** <adversarial? "adversarial (3 skeptics)" : "single pass"> over <diffLines> changed lines
**Spec:** <specSource — with the caveat, verbatim, when it is not a linked issue:
"criteria came from the diff author's own description; treat the approval floor accordingly">

<the findings / evidence from `notes`, numbered, each with file:line>
```

- `REVIEW-FINDINGS` → list every finding; recommend the PR not merge until
  each is addressed or explicitly waived by a human.
- `NEEDS-HUMAN` / `BLOCKED` / `CONFUSED` → relay `notes` verbatim; that is a
  real outcome for the human, not a failure to hide.
- A `REVIEW-APPROVE` with `confidence` below 70, with `quorum.received` short
  of `quorum.of`, or with anything in `quorum.invalid`, is an approval with an
  asterisk — say so plainly (70 is the suggested floor; the final call is the
  user's).

**Post to the PR only when the user explicitly asks** (a review is outward
once posted):

```bash
gh pr comment "$PR_NUM" --body-file "$TMP/report.md"
```

**Always clean up**, whatever the verdict — including after a failed spawn
(`worktreePath` from the manifest):

```bash
bun "$PACK/lib/review.ts" cleanup --repo . --worktree "$WORKTREE"
```

## Honesty limits worth knowing

- **A PR-description spec is the author's own narrative.** The blindness
  contract withholds exactly that; standalone there may be nothing else to
  hold the diff to. The reviewer is told the spec's provenance, and the report
  repeats the caveat. Linking PRs to issues (`Closes #N`) gets you the honest
  yardstick.
- **Verdicts are self-reported files.** What is enforced is the envelope, the
  result union, and the off-disk quorum count. The reviewer can still be
  wrong; the point of the skeptics, the quorum, and the disclosure is that it
  cannot be QUIETLY wrong in the ways this design has already seen.

# Tutorial: your first blinded review

You'll run a complete blinded adversarial review of a real GitHub PR and end
with a confidence-scored verdict whose skeptic quorum was counted off disk —
plus an understanding of every artifact the pipeline produced along the way.

Two ways to drive it: the skill (Claude Code does the orchestration) or the
CLI by hand. The skill is the product; the CLI walkthrough below is the same
pipeline with you as the session, which is the fastest way to understand it.

## What you'll need

- [bun](https://bun.sh), git, [jq](https://jqlang.github.io/jq/), and an
  authenticated [GitHub CLI](https://cli.github.com) (`gh auth status`).
- A checkout of a repo with at least one open PR. Best first target: a PR
  that links a closing issue (`Closes #N`) — you'll see the honest-yardstick
  path instead of the author-authored caveat.

## The short way: the skill

```bash
git clone https://github.com/zacgoodwin/z-adversarial-review.git ~/.claude/skills/z-adversarial-review
```

Restart Claude Code, open a session inside the repo under review, and:

```
/z-adversarial-review 123
```

Claude runs `prepare`, spawns the blinded reviewer, runs `collect`, renders
the report, and cleans up. The rest of this tutorial does those same steps
by hand so you can see each one.

## Step 1: Fetch the PR metadata

From inside the repo under review (substitute your PR number for `123`, and
your clone path if it differs):

```bash
PACK="$HOME/.claude/skills/z-adversarial-review"
TMP=$(mktemp -d)
gh pr view 123 --json number,title,url,body,headRefOid,baseRefOid,baseRefName,labels,closingIssuesReferences > "$TMP/pr.json"
SPEC_ISSUE=$(jq -r '.closingIssuesReferences[0].number // empty' "$TMP/pr.json")
[ -n "$SPEC_ISSUE" ] && gh issue view "$SPEC_ISSUE" --json body,labels > "$TMP/issue.json"
```

This is the only place `gh` is used — everything after runs offline against
these two JSON files.

## Step 2: Assemble the blinded input

```bash
"$PACK/bin/z-adversarial-review" prepare --pr-json "$TMP/pr.json" \
  ${SPEC_ISSUE:+--issue-json "$TMP/issue.json"} \
  --repo . --out-dir "$TMP" | tee "$TMP/manifest.json"
```

You just got a JSON manifest — the review's control panel. Three fields
worth reading right now:

- `adversarial` — `true` means this diff earned the 3-skeptic fan-out
  (≥ 10 changed lines, or a `security`/`migration`/`payments`/`auth`
  label). Computed, never anyone's call.
- `specSource` — `linked issue #N` is the independent yardstick; `PR
  description (author-authored)` means the reviewer is judging the diff
  against the author's own narrative, disclosed as such.
- `stub` — a ~400-byte pointer prompt. The full reviewer prompt sits in a
  file; whoever spawns the reviewer only ever holds this stub, so the
  spawning context never contains the spec or the diff.

Also on disk now: the four-key blinded input (`input-pr-123.json` — exactly
`ticketBody`, `acceptanceCriteria`, `diff`, `worktreePath`), the diff, a
throwaway worktree of the PR head under `.worktrees/review-pr-123`, and an
empty artifact tree under `$TMP/runs/<runId>/` waiting for verdict files.

## Step 3: Run the reviewer

In the skill, this step is one Agent-tool spawn with the manifest's `stub`
as the whole prompt, `run_in_background: false`. Driving it by hand with
local Claude Code:

```bash
STUB=$(jq -r .stub "$TMP/manifest.json")
WORKTREE=$(jq -r .worktreePath "$TMP/manifest.json")
( cd "$WORKTREE" && claude -p "$STUB" --add-dir "$TMP" )
```

Expect several minutes of wall clock — the reviewer typechecks, runs the
tests the diff touches, and on an adversarial pass launches its three
skeptics and collects them inside its single turn. Its final message is
just `verdict written`: the review itself landed as files.

## Step 4: Collect the verdict

Never trust the prose — validate the file against the exact run identity
`prepare` minted:

```bash
"$PACK/bin/z-adversarial-review" collect \
  --verdict "$(jq -r .verdictPath "$TMP/manifest.json")" \
  --run-root "$(jq -r .runRoot "$TMP/manifest.json")" \
  --run "$(jq -r .runId "$TMP/manifest.json")" \
  --ticket "$(jq -r .pr "$TMP/manifest.json")"
```

A healthy adversarial run prints something like:

```json
{ "ok": true, "result": "REVIEW-FINDINGS", "notes": "1. src/limiter.ts:41 …",
  "confidence": 67,
  "quorum": { "received": 3, "of": 3, "unrefuted": 2, "invalid": [] } }
```

That `quorum` was counted by reading the three skeptic verdict files off
disk — the reviewer's own tally is never consulted. An
`{"ok": false, "reason": …}` means the review failed (missing file,
mis-addressed envelope, pasted placeholder): the reason is the answer;
re-run rather than reconstructing a verdict from the transcript.

## Step 5: Clean up

Always, whatever the verdict:

```bash
"$PACK/bin/z-adversarial-review" cleanup --repo . --worktree "$WORKTREE"
```

Prints `removed`. Safe to run twice (`absent`).

## What you built

A complete blinded review: a reviewer that saw only the spec, the criteria,
the diff, and a scratch worktree; three independent skeptics that tried to
refute it; and a verdict you validated against a one-shot run identity
instead of taking anyone's word. The `$TMP/runs/` tree is the full audit
trail — every stage's `verdict.json` is there to read.

Next steps:

- Every flag, manifest field, and schema: [CLI reference](reference-cli.md)
- Put skeptic seats on codex/gemini/agy:
  [cross-provider how-to](howto-cross-provider-skeptics.md)
- Why it's built this way: [design explanation](explanation-design.md)
- Verify the fan-out earns its cost: [eval how-to](howto-run-the-eval.md)

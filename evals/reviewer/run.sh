#!/usr/bin/env bash
# The runnable adversarial-reviewer eval harness, extracted from zstack
# (evals/reviewer/run.sh) and adapted to this product's verdict-file contract.
# Every LLM call goes through **local Claude Code** ($CLAUDE_CMD, default
# `claude -p`) -- never a hosted API.
#
#   CLAUDE_CMD="$HERE/mock-claude.sh" evals/reviewer/run.sh 1   # free, structural
#   evals/reviewer/run.sh 5                                     # real, paid (nightly)
#
# What it measures (rubric.md holds the contract): RECALL and the VERDICT FILE.
# Two independent gates, ANDed by evals/lib/recall.ts:
#   1. recall -- the adversarial fan-out names strictly more planted defects
#      than the single pass in >= 80% of trials;
#   2. verdict -- every reviewer stage wrote a valid verdict file. This gate is
#      deterministic here: the "marker" recall.ts scores is the verdict file's
#      own `result`, read via lib/verdict.ts check, or NONE when the file is
#      missing/invalid. One silent stage fails the run.
#
# The latent/deterministic split: the live grader answers ONLY "did this output
# name defect D<n>?", and every count, mean, delta and threshold is computed by
# evals/lib/recall.ts under gate tests (tests/recall.test.ts).
#
# Requires: bun, git, jq.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
FIX="$HERE/fixtures/multi-defect"
RUNS="${1:-5}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
OUT="$(mktemp -d)"

# CLAUDE_CMD may be a repo-relative script (the mock). The reviewer passes
# below run from inside the throwaway worktree, so absolutize a relative
# script path now or the cd would break it.
CMD_FIRST="${CLAUDE_CMD%% *}"
if [ -f "$CMD_FIRST" ]; then
  CMD_REST="${CLAUDE_CMD#"$CMD_FIRST"}"
  CLAUDE_CMD="$(cd "$(dirname "$CMD_FIRST")" && pwd -P)/$(basename "$CMD_FIRST")$CMD_REST"
fi

# 1. Materialize diff.patch into a real throwaway directory so `worktreePath`
#    is a live filesystem path the reviewer can actually inspect and run tests
#    in. The fixture carries no git history, so a plain `git apply` into a
#    fresh scratch dir is the equivalent of production's worktree add.
WORKTREE="$(mktemp -d)"
git apply --unsafe-paths --directory="$WORKTREE" "$FIX/diff.patch"

# 2. Assemble the BLINDED four-key reviewer input from the fixture. The AC
#    section is extracted with the same rule lib/review.ts uses. defects.json
#    is NEVER part of this input -- it is the grader's answer key.
AC="$(awk '/^#+ Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$FIX/ticket.md")"
bun -e "import {readFileSync,writeFileSync} from 'node:fs';
  writeFileSync(process.argv[5], JSON.stringify({
    ticketBody: readFileSync(process.argv[1],'utf8'),
    acceptanceCriteria: process.argv[2],
    diff: readFileSync(process.argv[3],'utf8'),
    worktreePath: process.argv[4],
  }));" "$FIX/ticket.md" "$AC" "$FIX/diff.patch" "$WORKTREE" "$OUT/input.json"

RUN_ID="run-20260101-000000-aaaa"
TICKET=151
ATTEMPT=1

# The verdict file's `result`, read deterministically -- or NONE when the file
# is missing or invalid. This is gate 2's input; no model prose is consulted.
verdict_result() { # $1 = verdict path
  bun "$ROOT/lib/verdict.ts" check "$1" --run "$RUN_ID" --ticket "$TICKET" --stage reviewer --attempt "$ATTEMPT" \
    | jq -r 'if .ok then .verdict.result else "NONE" end'
}

for i in $(seq 1 "$RUNS"); do
  for mode in single adversarial; do
    # 3. Per trial+mode artifact tree in the canonical runs/<runId>/t<ticket>/
    #    shape, so the skeptic-quorum path-trust rule applies as in production.
    R="$OUT/$mode-$i"
    RDIR="$R/runs/$RUN_ID/t$TICKET/reviewer-1"
    mkdir -p "$RDIR/skeptic-1" "$RDIR/skeptic-2" "$RDIR/skeptic-3"
    VP="$RDIR/verdict.json"
    AMODE=$([ "$mode" = adversarial ] && echo always || echo off)
    bun "$ROOT/lib/prompts.ts" prompt "$OUT/input.json" --adversarial-mode "$AMODE" \
      --verdict-path "$VP" --run "$RUN_ID" --ticket "$TICKET" --attempt "$ATTEMPT" \
      --skeptic-dirs "[\"$RDIR/skeptic-1\",\"$RDIR/skeptic-2\",\"$RDIR/skeptic-3\"]" > "$R/prompt.txt"

    # 4. Drive the prompt through a fresh live Agent (local Claude Code) from
    #    inside the throwaway worktree, granted only $OUT on top: the answer
    #    key lives in the repo tree, and blindness must not rest on the subject
    #    honoring "do not look anywhere else".
    ( cd "$WORKTREE" && $CLAUDE_CMD "$(cat "$R/prompt.txt")" --add-dir "$OUT" ) > "$R/final.txt"
  done

  # 5. Grade by MATCHING findings to the answer key -- the one latent step.
  #    The reviewer's findings live in its verdict file's notes; hand the
  #    grader both verdict files (or empty placeholders when missing).
  for mode in single adversarial; do
    VP="$OUT/$mode-$i/runs/$RUN_ID/t$TICKET/reviewer-1/verdict.json"
    [ -f "$VP" ] && cp "$VP" "$OUT/$mode-$i-verdict.json" || echo '{}' > "$OUT/$mode-$i-verdict.json"
  done
  $CLAUDE_CMD "Grade one reviewer trial by MATCHING findings to a known defect list.
    The defect list is $FIX/defects.json. The single-pass reviewer's verdict file is
    $OUT/single-$i-verdict.json and the adversarial one is $OUT/adversarial-$i-verdict.json
    (findings are in each file's \"notes\"; an empty {} means that reviewer wrote nothing).
    For EACH defect id in the list, decide whether that reviewer's notes actually
    name that defect -- the same site and the same mechanism, in its own words.
    A finding that gestures at the right file but describes a different problem
    is NOT a match. Count findings matching no listed defect separately.
    Return ONLY this JSON object, with every defect id present in both maps:
    {\"single\":{\"D1\":true|false,...},\"adversarial\":{\"D1\":true|false,...},
     \"singleUnmatched\":<int>,\"adversarialUnmatched\":<int>}" \
    --add-dir "$OUT" --add-dir "$HERE" > "$OUT/grade-raw-$i.txt"

  # 6. Fold gate 2 in deterministically: the verdict-file result per mode,
  #    merged into the grade as the "marker" fields recall.ts scores.
  SM="$(verdict_result "$OUT/single-$i/runs/$RUN_ID/t$TICKET/reviewer-1/verdict.json")"
  AM="$(verdict_result "$OUT/adversarial-$i/runs/$RUN_ID/t$TICKET/reviewer-1/verdict.json")"
  bun "$ROOT/evals/lib/merge-grade.ts" "$OUT/grade-raw-$i.txt" "$SM" "$AM" > "$OUT/grade-$i.json"
done

# 7. Score deterministically. recall.ts prints the per-defect catch table, both
#    means, and the trial count against the threshold, then exits 0 (pass), 1
#    (below threshold or a missing verdict) or 2 (HARNESS ERROR -- at least one
#    grade was unreadable, so no measurement was taken).
set +e
bun "$ROOT/evals/lib/recall.ts" "$FIX/defects.json" "$OUT"/grade-*.json
STATUS=$?
set -e

echo "artifacts in $OUT"
echo "materialized worktree in $WORKTREE"
case "$STATUS" in
  0) echo "PASS" ;;
  1) echo "FAIL: recall below threshold, or a reviewer stage wrote no valid verdict file" ;;
  *) echo "HARNESS ERROR: no score was taken -- rerun; do not record this run in run.md" ;;
esac
exit "$STATUS"

# How to run the reviewer eval

Run the paid eval that measures whether the skeptic fan-out is worth its
cost, or its free structural smoke. End result: a per-defect recall report
and a PASS/FAIL against the rubric's two gates.

The eval's contract lives in [rubric.md](../evals/reviewer/rubric.md);
recorded runs live in [run.md](../evals/reviewer/run.md). This page is the
operating manual.

## Prerequisites

- `bun`, `git`, `jq` on PATH.
- For the real run: local Claude Code (`claude` on PATH). Every LLM call
  goes through it — this repo never calls a hosted API.
- The free smoke needs no model at all.

## Steps

1. Start with the free structural smoke — it exercises every branch of the
   harness with a mock model and costs nothing:

   ```bash
   CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1
   ```

   Expect the per-defect table and `PASS`, exit 0.

2. Optionally smoke the failure paths — each env var forces one gate to
   trip, proving the harness can actually fail:

   ```bash
   MOCK_CLAUDE_PASS=false        CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1  # gate 1 fails (exit 1)
   MOCK_CLAUDE_SILENT=adversarial CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1  # gate 2 fails (exit 1)
   MOCK_CLAUDE_GRADE_WRAP=garbage CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1  # harness error (exit 2)
   ```

3. Run the real, paid eval (nightly / pre-ship cadence, never per-commit):

   ```bash
   evals/reviewer/run.sh 5
   ```

   Each of the 5 trials drives BOTH prompt modes — single pass and
   adversarial — against the 771-line `multi-defect` fixture diff hiding
   eight verified defects, then a fresh grader matches each reviewer's
   verdict `notes` against the answer key. Expect real wall-clock and real
   spend: 10 live reviewer runs plus 5 grader calls.

4. Record the run: append date, trial count, per-gate outcome, and mean
   recall per mode to `evals/reviewer/run.md`. Exit-2 runs are never
   recorded — no measurement was taken.

## Verification

Exit code is the verdict:

- `0` — PASS: both gates held.
- `1` — FAIL: gate 1 (the fan-out must name strictly more planted defects
  than the single pass in ≥ 80% of trials — `ceil(0.8 × N)`, so 4/5 at the
  default; a tie is not a win) or gate 2 (every reviewer stage wrote a
  valid verdict file — 2N of 2N, one silent stage fails the run) tripped.
- `2` — HARNESS ERROR: at least one grader output was unreadable, so no
  score was taken. Rerun; do not record.

The report names everything: the per-defect catch table
(`single -> adversarial` per defect), both means, the trial-pass count
against its threshold, and — on gate-2 failure — exactly which trial and
mode reported no marker. All arithmetic is done in `evals/lib/recall.ts`
under gate tests; the live grader only answers "did this output name that
defect?".

## Troubleshooting

- **Exit 2 with `no JSON object found in grader output`** — the grader
  wrote prose instead of the JSON contract. This is deliberate: schema
  drift is a harness fault, never scored as a miss. Rerun; if it repeats,
  read `grade-raw-<i>.txt` in the printed artifacts dir.
- **Gate 2 fails on a real run** — a reviewer ended its turn without
  writing its verdict file, the exact lost-review failure the design guards
  (see [the foreground rule](explanation-design.md#the-foreground-rule)).
  The report names the trial and mode; the raw prompt and final message are
  in the artifacts dir.
- **Artifacts** — the run prints `artifacts in <dir>` and
  `materialized worktree in <dir>` (both `mktemp -d`). Everything is there:
  per-trial prompts, verdict files, raw and merged grades.
- **`run.sh 1` passing gate 1** — expected: the threshold scales
  (`ceil(0.8 × 1)` = 1), so single-trial smokes are winnable by design
  rather than structurally unpassable.

## Related

- [Rubric — the contract and its history](../evals/reviewer/rubric.md)
- [run.md — commands and recorded results](../evals/reviewer/run.md)
- [Explanation — why the fan-out needs auditing at all](explanation-design.md#skeptics-one-reader-agrees-with-itself)

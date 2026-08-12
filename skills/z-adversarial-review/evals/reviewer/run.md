# Reviewer eval — how to run, and results

## Commands

```bash
# Free structural smoke (mock model; exercises every branch of the harness):
CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1

# Failure-path smokes:
MOCK_CLAUDE_PASS=false  CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1  # gate 1 fails
MOCK_CLAUDE_SILENT=adversarial CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1  # gate 2 fails
MOCK_CLAUDE_GRADE_WRAP=garbage CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 1  # harness error (exit 2)

# Real, paid (local Claude Code; nightly / pre-ship):
evals/reviewer/run.sh 5
```

Exit codes: 0 = PASS, 1 = a gate failed, 2 = harness error (no measurement
taken; rerun, and do not record the run below).

## Results

No paid runs recorded yet for this repo. The fixture and metric carry over
from zstack's `evals/reviewer` lane, whose recorded runs (in that repo's
`run.md`) measured the fan-out's value at +0.2–0.6 defects per review on this
fixture family. Record each paid run here: date, trial count, per-gate
outcome, mean recall per mode.

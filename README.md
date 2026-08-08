# adversarial-review

Blinded adversarial review for any GitHub pull request, as a Claude Code
skill. One fresh reviewer agent that sees **only** the spec, the acceptance
criteria, the diff, and a throwaway worktree — plus, on non-trivial diffs,
three independent skeptic sub-agents tasked to refute the change. Verdicts
are files with a validated envelope; the skeptic quorum is counted off disk,
never off anyone's prose.

Extracted from [zstack](https://github.com/zacgoodwin/zstack)'s dev-loop
Review lane, where this design accumulated its scar tissue across dozens of
unattended runs. This repo is that lane as a standalone product: no board, no
loop, no config — one clone and it reviews PRs.

## Why blinded, why skeptics, why files

- **Blinded.** A reviewer that reads the PR discussion, the CI checkmarks,
  and the author's description inherits the author's framing. This reviewer
  receives exactly four inputs, enforced by a compile-time and runtime gate;
  when the only available spec IS the author's description, that provenance
  is disclosed to the reviewer and flagged in the report rather than
  laundered.
- **Skeptics.** One reader agrees with itself. On any diff of ≥ 10 changed
  lines (or any `security`/`migration`/`payments`/`auth` label), the reviewer
  spawns three independent skeptics whose only job is refutation, then
  aggregates their verdicts through a fixed confidence table — a lookup, not
  model arithmetic.
- **Files.** Each agent reports by writing `verdict.json` into a per-spawn
  directory stamped with a one-shot run identity. A verdict that is missing,
  mis-addressed, out of its result union, or still carrying the template's
  placeholder is INVALID — named, never reinterpreted. The quorum the report
  shows is counted from the skeptic files on disk, so a reviewer cannot claim
  agreement that never landed.

## Install

Requires [bun](https://bun.sh), git, [jq](https://jqlang.github.io/jq/), and
an authenticated [GitHub CLI](https://cli.github.com).

```bash
git clone https://github.com/zacgoodwin/adversarial-review.git ~/.claude/skills/adversarial-review
```

Restart Claude Code (the skill list is scanned at session start). That's the
whole install: the repo root is the skill.

## Use

From a session inside a checkout of the repo whose PR you want reviewed:

```
/adversarial-review 123        # review PR #123
/adversarial-review            # review the current branch's open PR
```

Ask for "single pass" or "with skeptics" to override the automatic fan-out
decision. The review is read-only; posting the report as a PR comment happens
only when you explicitly ask.

You get a report: verdict (`REVIEW-APPROVE` / `REVIEW-FINDINGS` /
`NEEDS-HUMAN` / `BLOCKED` / `CONFUSED`), confidence 0-100, the skeptic quorum
(received / upheld / anything invalid, counted off disk), diff size, and a
spec-provenance caveat when the criteria came from the diff author's own
description.

There is also a plain CLI for the deterministic core:

```bash
bin/adversarial-review prepare --pr-json pr.json --repo . --out-dir /tmp/rev
bin/adversarial-review collect --verdict <path> --run-root <dir> --run <id> --ticket <n>
bin/adversarial-review cleanup --repo . --worktree <path>
```

## How a review runs

1. **`prepare`** (code): picks the spec — the PR's linked closing issue if
   one exists, else the PR description explicitly marked author-authored,
   else a named "no spec" fallback; slices the `### Acceptance Criteria`
   section; writes the merge-base diff with lockfiles excluded (unfiltered
   fallback for lockfile-only PRs); makes a throwaway worktree of the head
   commit under `.worktrees/`; mints the run identity; builds the reviewer
   prompt with three code-composed skeptic briefs embedded.
2. **One fresh agent** is spawned holding a ~400-byte pointer stub — the
   session that spawned it never reads the spec or diff itself. The reviewer
   typechecks and runs the touched tests in the worktree; on an adversarial
   pass it launches its three skeptics in one message with
   `run_in_background: false`, so every verdict lands inside its single turn.
3. **`collect`** (code): validates the reviewer's verdict envelope against
   the exact spawn `prepare` minted and counts the skeptic quorum off disk.
4. The session renders the report; `cleanup` removes the worktree.

## Tests and evals

Two lanes with different budgets:

- **Gate tests** (`bun test`, free, seconds): input assembly, the blindness
  gate, activation, verdict envelope checks, off-disk quorum, worktree
  lifecycle, the SKILL.md gh-invocation allowlist, and the eval scorer
  itself.
- **Paid eval** (`evals/reviewer/run.sh`, local Claude Code only, nightly /
  pre-ship): drives both prompt modes against a 771-line fixture diff hiding
  eight verified defects, grades recall by matching against the answer key,
  and gates on (1) the fan-out naming strictly more defects than the single
  pass in ≥ 80% of trials and (2) every reviewer having written a valid
  verdict file. `CLAUDE_CMD=evals/reviewer/mock-claude.sh evals/reviewer/run.sh 1`
  is the free structural smoke.

Before calling any change done: `bun test && bun run typecheck`.

## Limits, stated plainly

- The verdict is self-reported; what is enforced is the envelope, the result
  union, and the quorum count. The reviewer can be wrong — the design makes
  it hard for it to be *quietly* wrong.
- A PR with no linked issue is reviewed against the author's own narrative,
  disclosed as such. Link PRs to issues (`Closes #N`) to give the reviewer an
  independent yardstick.
- LLM calls (the review itself, the paid eval) run through your local Claude
  Code session — this repo never calls a hosted model API.

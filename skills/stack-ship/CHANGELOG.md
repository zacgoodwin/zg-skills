# Changelog

All notable changes to the `stack-ship` skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [1.0.4] - 2026-10-22

### Fixed

- The step-2 gate failed to compile on Windows (`jq: error: Invalid escape
  ... '"\.\."'`): something between the agent and jq, most likely a
  command-rewriting hook, ate one level of backslash from the inline filter.
  It failed closed, so every ship blocked. The filter now ships as
  `gate.jq`, run with `jq -e -f`, and SKILL.md carries no inline jq program.
  `check-pipeline.sh` checks the file exists and compiles.
- The step-5 version bump ran on any root `VERSION`, including an empty,
  untracked one a review seat left behind, and wrote `.1` into it, ready to
  be committed into the shipped PR. The bump now runs only on a tracked
  `VERSION` holding a dotted version; otherwise it prints `bump skipped:`
  with the reason (not tracked, or the malformed value) and the report
  repeats it. A zero-padded last component (`1.2.09`) bumps as decimal
  instead of crashing bash's octal arithmetic.

## [1.0.3] - 2026-10-20

### Fixed

- A crashed (`failed`) review job blocked the gate forever: roborev can
  neither close nor cancel a failed job, so re-running the review never
  cleared it. A failed job now counts as superseded by a later (higher id)
  `done` review of the same `git_ref`, or of exactly `<merge-base>..<HEAD>`
  (`GATE_RANGE`, what `--branch` records for the branch as it stands). Any
  other range, such as a `--since` review or a branch review of an older
  HEAD, supersedes nothing. A failed job with no later done review,
  including a crashed `--branch` review, still blocks, and so does any job
  without a numeric `id` and string `git_ref` (jq orders numbers above
  `null` and treats `null == null`).

## [1.0.2] - 2026-08-12

### Fixed

- Gate jq normalized a null `roborev list` response (API error) to `[]` via
  `(. // [])`, then passed the fail-closed check vacuously since an empty
  array satisfies every `all(...)` clause — submitting with zero completed
  review evidence. The gate now rejects non-array/null responses outright
  and requires at least one `done`+`P` verdict before it passes.
  ([Chapterhouse#96](https://github.com/zacgoodwin/Chapterhouse/issues/96))

## [1.0.1] - 2026-08-12

### Fixed

- `check-pipeline.sh`'s documented invocation resolved only
  `$HOME/.claude/skills/stack-ship/check-pipeline.sh`, so a repo that
  vendors its own copy of the skill (and has no global install under
  `$HOME`) couldn't run it. SKILL.md and README.md now resolve the
  repo-local install first, falling back to `$HOME` only when no
  repo-local copy exists.

## [1.0.0] - 2026-08-12

Initial release as part of the `zg-skills` monorepo. Carries forward the
full commit history of the standalone
[stack-ship](https://github.com/zacgoodwin/stack-ship) repo (now archived).

- Roborev gate with bounded auto-fix retry.
- `st stack submit --squash --ai` upstream submit.
- z-adversarial-review invocation with cross-provider skeptic seats.
- Patch version bump on the shipped repo after a mergeable verdict.

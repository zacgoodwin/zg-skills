# Changelog

All notable changes to the `stack-ship` skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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

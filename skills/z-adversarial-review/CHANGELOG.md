# Changelog

All notable changes to the `z-adversarial-review` skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [1.4.1] - 2026-08-12

### Fixed

- `collect` no longer trusts the reviewer's self-reported
  `evidence.skepticVerdictPaths` to decide which skeptic verdicts to count.
  It now derives the three canonical `skeptic-<1,2,3>/verdict.json` paths
  itself from `--run-root`/`--ticket` (the same layout `prepare` wrote), so
  a reviewer that omits or under-lists that field can no longer make a
  disagreeing or unread skeptic verdict disappear from the quorum. `collect`
  now requires `--adversarial <true|false>` (the manifest's own field) to
  gate whether a quorum is counted at all.
- Two concurrent reviews of the same PR (or a crashed run's leftover) no
  longer share a worktree path. `prepare` now mints the run identity before
  creating the worktree and names it `review-pr-<N>-<runId>`, so one run's
  `cleanup` can never remove another run's still-active checkout.
- SKILL.md and docs now resolve the skill's own directory repo-local first
  (`.claude/skills/z-adversarial-review`), falling back to
  `$HOME/.claude/skills/z-adversarial-review` only when no repo-local copy
  exists — a vendored, version-pinned copy in a project repo no longer gets
  silently shadowed by whatever happens to be installed globally.

## [1.4.0] - 2026-08-12

### Added

- A first-run skeptic-fleet chooser. The first time a user runs
  `/z-adversarial-review`, Step 0 asks (AskUserQuestion) which outside CLIs —
  `codex`, `agy`, both, or Claude-only — should staff the three skeptic
  seats, validates the pick with `setup --providers`, and saves it so every
  later review reuses it silently.
- `lib/models.ts preference` — get/set the saved per-user skeptic-seat lineup
  backing that chooser (`~/.claude/z-adversarial-review/skeptic-preference.json`).
  `prepare` now falls back to it whenever `--skeptic-models` is omitted
  entirely (an explicit `'[]'` still means all-Claude for that one run).
- `setup --providers <csv>` — scope the validation table to a chosen subset
  instead of the whole fleet.

## [1.3.0] - 2026-08-12

### Removed

- The `gemini` skeptic provider. The cross-provider fleet is now `codex` and
  `agy` (Antigravity, which fronts Gemini models — `agy:gemini-3-pro` still
  seats one). `gemini` / `gemini:<model>` seat tokens are now an unknown-token
  error, and the `setup` table drops its row.

## [1.2.0] - 2026-08-12

Moved into the `zg-skills` monorepo at `skills/z-adversarial-review`. Carries
forward the full commit history of the standalone
[z-adversarial-review](https://github.com/zacgoodwin/z-adversarial-review)
repo (now archived). Version number carried over unchanged from
`package.json` at the time of the move; see the archived repo's history for
everything before this point.

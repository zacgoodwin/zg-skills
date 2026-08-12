# Changelog

All notable changes to the `z-adversarial-review` skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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

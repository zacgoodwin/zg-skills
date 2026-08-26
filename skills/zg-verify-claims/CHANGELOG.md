# Changelog

All notable changes to the `zg-verify-claims` skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-08-25

Extracted from a documentation watchdog built in another repo, where the
verifier was entangled with that repo's own inventory checks. This is the half
that was never repo-specific.

### Added

- `bin/verify-claims.mjs`, a zero-dependency Node verifier for agent-authored
  claims. Four evidence types: `file_exists`, `line_content`, `count`,
  `cross_reference`. A claim survives only if every piece of its evidence
  reproduces off the filesystem.
- `SKILL.md`, the `/zg-verify-claims` audit discipline: deterministic checks
  first, then a parallel fan-out that may only emit structured claims, then
  verification, then a report whose discard list is mandatory.
- `tests/gate.sh`, covering the verifier's self-test, every exit code, and
  parity between the evidence types SKILL.md hands to subagents and the ones
  the code actually handles.

### Notes on the extraction

- The verifier no longer imports a reference resolver from its old sibling.
  `cross_reference` resolves markdown links itself and accepts a bare mention
  when the target exists, so it needs no per-repo configuration.
- The root is resolved per run from `--root`, the enclosing git checkout, or
  the working directory, never from the script's own location. The tool is
  installed once and pointed at whatever repo you are standing in.
- Git is used when present, because tracked files are the better inventory: an
  untracked file is not in a clone, so it cannot be evidence. It falls back to
  a filesystem walk when the target is not a checkout.
- The self-test builds a temp fixture from scratch rather than asserting
  against a host repo, including a CRLF file, so the suite travels.
- `count` is declarative rather than a command to execute, so agent-authored
  JSON cannot run anything.
- A malformed regex from an agent fails that claim instead of crashing the run.
  This was not hypothetical: the first real run of the parent tool discarded a
  finding whose evidence used a Python-style `(?i)` flag.

[Unreleased]: https://github.com/zacgoodwin/zg-skills/compare/zg-verify-claims@v0.1.0...HEAD
[0.1.0]: https://github.com/zacgoodwin/zg-skills/releases/tag/zg-verify-claims@v0.1.0

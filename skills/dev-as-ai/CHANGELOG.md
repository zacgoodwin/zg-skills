# Changelog

All notable changes to the `dev-as-ai` skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-08-12

Initial release.

- `/dev-as-ai` switches the active `gh` CLI account to `tordek-ai` and writes
  `Tordek Holderhek <301414961+tordek-ai@users.noreply.github.com>` into the
  repo's `--local` git config.
- Command-only (`disable-model-invocation: true`) — identity switching changes
  public attribution, so Claude never fires it on its own judgment.
- The switch reads back the account `gh` reports as active and exits non-zero
  unless it's `tordek-ai`, so a switch that quietly didn't take fails instead of
  printing a reassuring line about the old account. Under `set -e`, a `gh`
  failure aborts before any `git config` runs.
- Gate test runs the switch published in SKILL.md against a throwaway repo and
  a stateful stub `gh`, asserting the exact name, email and account, plus both
  ways a switch can fail to happen: `gh` erroring, and `gh` exiting 0 with the
  active account unchanged.

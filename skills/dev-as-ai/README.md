# dev-as-ai

Claude Code skill that attributes work to the AI dev bot account instead of
Zac. One command, two halves:

1. `gh auth switch -u tordek-ai` — every subsequent `gh` call (PRs, issues,
   comments) comes from the bot.
2. `git config --local user.name/user.email` — commits in this repo are authored
   by `Tordek Holderhek <301414961+tordek-ai@users.noreply.github.com>`, the
   noreply address GitHub maps back to that account.

Both halves are printed after the run — the only confirmation the switch took,
since a commit under the wrong identity fails nothing at runtime. The account
line is an assertion, not a display: the block reads back the account `gh`
reports as active and exits non-zero unless it's the bot, so a switch that
quietly didn't take can't print a reassuring line about the old account. Under
`set -e`, a `gh` failure aborts before any `git config` runs, leaving the repo's
identity untouched rather than half-switched.

Trigger in Claude Code: `/dev-as-ai`. Reverse: [`/dev-as-human`](../dev-as-human).

## Scope

Git config is `--local`, this repo only. The `gh` account switch is machine-wide
— `gh` has no per-repo account concept — so every other repo's `gh` calls use
the bot too until `/dev-as-human` runs. That asymmetry is accepted, not solved.

Command-only: `disable-model-invocation: true` keeps Claude from firing it on
its own judgment. Public attribution is too consequential for ambient
auto-invoke.

## Install

```bash
npx skills add zacgoodwin/zg-skills --skill dev-as-ai
```

Lives at [skills/dev-as-ai](.) in the
[zg-skills](https://github.com/zacgoodwin/zg-skills) monorepo, versioned and
released independently of any other skill there.

## Requirements

`git`, `gh`, and a `gh` login for `tordek-ai` (`gh auth login -u tordek-ai`
once per machine — `gh auth status` lists who's logged in).

## Files

- `SKILL.md` — the skill itself; the switch the agent runs lives here.
- `tests/gate.sh` — package gate test. Extracts the switch from SKILL.md so the
  tested program is exactly the shipped one, runs it against a throwaway repo
  and a stub `gh`, and asserts the name, email, account, and the no-half-switch
  guard.
- `VERSION` / `CHANGELOG.md` — this skill's own release version, independent of
  any other skill in the monorepo. See
  [../../scripts/bump-version.sh](../../scripts/bump-version.sh).

## Test

```bash
bash tests/gate.sh
```

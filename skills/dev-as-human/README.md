# dev-as-human

Claude Code skill that returns work to Zac's own account after
[`/dev-as-ai`](../dev-as-ai). One command, two halves:

1. `gh auth switch -u zacgoodwin` — every subsequent `gh` call (PRs, issues,
   comments) comes from the human account again.
2. `git config --local user.name/user.email` — commits in this repo are authored
   by `Zac Goodwin <zac.goodwin@gmail.com>`.

The identity is written explicitly rather than unset: `git config --local
--unset` would fall through to whatever `~/.gitconfig` holds at the time (today
`qa <qa@zstack.local>`), restoring an identity nobody chose.

Both halves are printed after the run — the only confirmation the switch took,
since a commit under the wrong identity fails nothing at runtime. The account
line is an assertion, not a display: the block reads back the account `gh`
reports as active and exits non-zero unless it's `zacgoodwin`, so a switch that
quietly didn't take can't print a reassuring line about the bot. Under `set -e`,
a `gh` failure aborts before any `git config` runs, leaving the repo visibly on
the bot identity rather than half-switched.

Trigger in Claude Code: `/dev-as-human`.

## Scope

Git config is `--local`, this repo only. The `gh` account switch is machine-wide
— `gh` has no per-repo account concept — so this also returns every other repo's
`gh` calls to `zacgoodwin`.

Command-only: `disable-model-invocation: true` keeps Claude from firing it on
its own judgment. Public attribution is too consequential for ambient
auto-invoke.

## Install

```bash
npx skills add zacgoodwin/zg-skills --skill dev-as-human
```

Lives at [skills/dev-as-human](.) in the
[zg-skills](https://github.com/zacgoodwin/zg-skills) monorepo, versioned and
released independently of any other skill there.

## Requirements

`git`, `gh`, and a `gh` login for `zacgoodwin` (`gh auth status` lists who's
logged in).

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

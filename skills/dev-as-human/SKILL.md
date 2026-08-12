---
name: dev-as-human
description: >-
  Switch this repo's git commit identity and the gh CLI account back to Zac
  Goodwin.
disable-model-invocation: true
---

# dev-as-human

Attribute this repo's commits, and every subsequent `gh` call on this machine,
to the human account `zacgoodwin` (Zac Goodwin). Run from inside the target
repo:

```bash
set -e
gh auth switch -u zacgoodwin
git config --local user.name "Zac Goodwin"
git config --local user.email "zac.goodwin@gmail.com"
echo "git identity: $(git config --local user.name) <$(git config --local user.email)>"
gh auth status --active 2>&1 | grep "account zacgoodwin "
```

Report both printed lines back verbatim. They are the only confirmation the
switch took: a commit made under the wrong identity crashes nothing, GitHub
just attributes it to the wrong account.

The closing `grep` is an assertion, not a display: it reads back the account
`gh` reports as active and exits non-zero if that isn't `zacgoodwin`, so a
switch that quietly didn't take fails the block instead of printing a
reassuring line about the bot account. With `set -e`, a `gh` failure also
aborts before any `git config` runs, leaving the repo on the bot identity —
visibly, with a non-zero exit — rather than half-switched. Non-zero exit means
you are still committing as the bot; report it and stop.

The human identity is written explicitly rather than unset. `git config --local
--unset` would fall through to whatever `~/.gitconfig` holds at the time (today
`qa <qa@zstack.local>`), so unsetting restores an identity nobody chose. Writing
it is deterministic.

Scope: git config is `--local`, this repo only. The `gh` account switch is
machine-wide — `gh` has no per-repo account concept — so this also returns every
other repo's `gh` calls to `zacgoodwin`.

The AI direction is `/dev-as-ai`.

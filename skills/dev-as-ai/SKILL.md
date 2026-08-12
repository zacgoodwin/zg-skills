---
name: dev-as-ai
description: >-
  Switch this repo's git commit identity and the gh CLI account to the AI dev
  bot (tordek-ai).
disable-model-invocation: true
---

# dev-as-ai

Attribute this repo's commits, and every subsequent `gh` call on this machine,
to the AI dev account `tordek-ai` (Tordek Holderhek). Run from inside the target
repo:

```bash
set -e
gh auth switch -u tordek-ai
git config --local user.name "Tordek Holderhek"
git config --local user.email "301414961+tordek-ai@users.noreply.github.com"
echo "git identity: $(git config --local user.name) <$(git config --local user.email)>"
gh auth status --active 2>&1 | grep "account tordek-ai "
```

Report both printed lines back verbatim. They are the only confirmation the
switch took: a commit made under the wrong identity crashes nothing, GitHub
just attributes it to the wrong account.

The closing `grep` is an assertion, not a display: it reads back the account
`gh` reports as active and exits non-zero if that isn't `tordek-ai`, so a
switch that quietly didn't take fails the block instead of printing a
reassuring line about the old account. With `set -e`, a `gh` failure also
aborts before any `git config` runs, leaving the repo's identity untouched
rather than half-switched. Non-zero exit means the switch did not happen —
report it and stop.

Scope: git config is `--local`, this repo only. The `gh` account switch is
machine-wide — `gh` has no per-repo account concept — so every other repo's
`gh` calls use `tordek-ai` too until `/dev-as-human` runs.

The email must be the noreply form. `tordek-ai`'s public email is private, and
`301414961+tordek-ai@users.noreply.github.com` is the only address GitHub maps
back to that account.

Reverse with `/dev-as-human`.

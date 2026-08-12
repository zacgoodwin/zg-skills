# zg-skills

Claude Code / Agent Skills, one repo, independently versioned and released.
Layout follows the [Agent Skills](https://github.com/vercel-labs/skills)
convention: each skill lives at `skills/<name>/SKILL.md`.

## Skills

| Skill | Version | What it does |
|---|---|---|
| [stack-ship](skills/stack-ship) | [![](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzacgoodwin%2Fzg-skills%2Fmain%2Fskills%2Fstack-ship%2FVERSION&query=%24&label=)](skills/stack-ship/CHANGELOG.md) | Ships a stax branch through a roborev gate, squash-submit, adversarial review, and version bump. |
| [z-adversarial-review](skills/z-adversarial-review) | [![](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzacgoodwin%2Fzg-skills%2Fmain%2Fskills%2Fz-adversarial-review%2Fpackage.json&query=%24.version&label=)](skills/z-adversarial-review/CHANGELOG.md) | Blinded adversarial review for any GitHub PR: one fresh reviewer, three skeptics, verdicts as files. |

`stack-ship` invokes `z-adversarial-review` as part of its pipeline, but
each skill is self-contained (own tests, own version, own CHANGELOG) and
installs independently.

## Install

Install everything:

```bash
npx skills add zacgoodwin/zg-skills
```

Install one skill:

```bash
npx skills add zacgoodwin/zg-skills --skill stack-ship
npx skills add zacgoodwin/zg-skills --skill z-adversarial-review
```

Or clone straight into Claude Code's skills directory the way the previous
standalone repos did:

```bash
git clone --filter=blob:none --sparse https://github.com/zacgoodwin/zg-skills.git ~/.claude/skills/zg-skills
cd ~/.claude/skills/zg-skills && git sparse-checkout set skills/stack-ship skills/z-adversarial-review
```

## Layout

```
skills/
  stack-ship/              SKILL.md, README.md, VERSION, CHANGELOG.md, tests/
  z-adversarial-review/    SKILL.md, README.md, package.json (version), CHANGELOG.md, bin/, lib/, tests/, evals/, docs/
scripts/
  bump-version.sh           bump a skill's VERSION or package.json version
  release-ci.sh             CI step: tag + release any skill not yet tagged
.github/workflows/
  ci.yml                     runs each skill's own test suite when its path changes
  release.yml                 tags + releases on push to main when a version file changes
```

## Versioning and releases

Each skill owns its version: `skills/stack-ship/VERSION` (plain text) or
`skills/z-adversarial-review/package.json`'s `version` field. There is no
repo-wide version.

To cut a release:

```bash
bash scripts/bump-version.sh stack-ship patch   # or minor / major
# edit skills/stack-ship/CHANGELOG.md: move Unreleased entries under the new version
git add skills/stack-ship
git commit -m "release(stack-ship): vX.Y.Z"
git push
```

On push to `main`, `.github/workflows/release.yml` runs
`scripts/release-ci.sh`, which tags any skill whose current version has no
matching `<skill>@v<version>` tag yet and creates a GitHub release for it.
Idempotent — safe to push docs-only commits, nothing re-releases unless a
version file actually changed to a value that isn't tagged.

## History

Both skills were previously standalone repos, now archived:
[stack-ship](https://github.com/zacgoodwin/stack-ship),
[z-adversarial-review](https://github.com/zacgoodwin/z-adversarial-review).
Their full commit history was merged in via `git subtree` under
`skills/<name>/` — `git log skills/stack-ship` and
`git log skills/z-adversarial-review` still work.

# stack-ship

Claude Code skill that ships the current stax (`st`) branch through a
four-stage quality pipeline:

1. **Gate** — `roborev review --branch --wait`, then a fail-closed jq check
   over the review ledger. Any failing verdict, crashed review job, or schema
   drift blocks the submit. Red gate gets one bounded auto-fix pass
   (`roborev refine --max-iterations 3`) and a single retry.
2. **Submit** — `st stack submit --squash --ai --yes`: one clean squashed
   commit per branch, PR created/updated with AI title and body.
3. **Adversarial review** — [z-adversarial-review](../z-adversarial-review)
   on the resulting PR with cross-provider skeptic seats (codex, agy, claude).
4. **Version bump** — patch-bump the repo's root `VERSION` on the PR once the
   verdict is mergeable. Skipped when the repo has no `VERSION` file or the
   verdict is do-not-merge.

Trigger in Claude Code: `/stack-ship`, "ship this branch". Flags: `--draft`,
`--skip-adversarial`.

## Install

```bash
npx skills add zacgoodwin/zg-skills --skill stack-ship
```

Lives at [skills/stack-ship](.) in the
[zg-skills](https://github.com/zacgoodwin/zg-skills) monorepo, versioned and
released independently of any other skill there.

## Requirements

`st` (stax), `roborev` (with its post-commit hook: `roborev init`), `jq`,
`gh` + the `gh-stack` extension, `git`, and the z-adversarial-review skill
(whose runtime needs `bun`). Verify the wiring of the repo you intend to
ship from — repo-local install first, `$HOME` fallback for a global-only
install:

```bash
PACK=".claude/skills/stack-ship"
[ -d "$PACK" ] || PACK="$HOME/.claude/skills/stack-ship"
bash "$PACK/check-pipeline.sh"
```

## Files

- `SKILL.md` — the skill itself; the jq gate the agent runs lives here.
- `check-pipeline.sh` — deterministic wiring check (<2s, offline except the
  local roborev daemon).
- `tests/gate.sh` — package gate test. Extracts the jq gate and the
  version-bump line from SKILL.md so the tested programs are exactly the
  shipped ones, and asserts pass/fail fixtures (F verdicts, crashed jobs,
  schema drift, null payloads, semver patch bumps).
- `setup` — idempotent pack setup for bootstrap installers; just runs the
  gate test.
- `VERSION` / `CHANGELOG.md` — this skill's own release version, independent
  of any other skill in the monorepo. See [../../scripts/bump-version.sh](../../scripts/bump-version.sh).

## Test

```bash
bash tests/gate.sh
```

# z-adversarial-review

Blinded adversarial review for any GitHub pull request, as a Claude Code
skill. One fresh reviewer agent that sees **only** the spec, the acceptance
criteria, the diff, and a throwaway worktree — plus, on non-trivial diffs,
three independent skeptic sub-agents tasked to refute the change. Verdicts
are files with a validated envelope; the skeptic quorum is counted off disk,
never off anyone's prose.

Extracted from [zstack](https://github.com/zacgoodwin/zstack)'s dev-loop
Review lane, where this design accumulated its scar tissue across dozens of
unattended runs. This repo is that lane as a standalone product: no board, no
loop, no config — one clone and it reviews PRs.

## Why blinded, why skeptics, why files

- **Blinded.** A reviewer that reads the PR discussion, the CI checkmarks,
  and the author's description inherits the author's framing. This reviewer
  receives exactly four inputs, enforced by a compile-time and runtime gate;
  when the only available spec IS the author's description, that provenance
  is disclosed to the reviewer and flagged in the report rather than
  laundered.
- **Skeptics.** One reader agrees with itself. On any diff of ≥ 10 changed
  lines (or any `security`/`migration`/`payments`/`auth` label), the reviewer
  spawns three independent skeptics whose only job is refutation, then
  aggregates their verdicts through a fixed confidence table — a lookup, not
  model arithmetic.
- **Files.** Each agent reports by writing `verdict.json` into a per-spawn
  directory stamped with a one-shot run identity. A verdict that is missing,
  mis-addressed, out of its result union, or still carrying the template's
  placeholder is INVALID — named, never reinterpreted. The quorum the report
  shows is counted from the skeptic files on disk, so a reviewer cannot claim
  agreement that never landed.

## Install

Requires [bun](https://bun.sh), git, [jq](https://jqlang.github.io/jq/), and
an authenticated [GitHub CLI](https://cli.github.com).

```bash
git clone https://github.com/zacgoodwin/z-adversarial-review.git ~/.claude/skills/z-adversarial-review
```

Restart Claude Code (the skill list is scanned at session start). That's the
whole install: the repo root is the skill.

## Use

From a session inside a checkout of the repo whose PR you want reviewed:

```
/z-adversarial-review 123      # review PR #123
/z-adversarial-review          # review the current branch's open PR
/z-adversarial-review setup    # validate the cross-provider skeptic fleet
```

Ask for "single pass" or "with skeptics" to override the automatic fan-out
decision. The review is read-only; posting the report as a PR comment happens
only when you explicitly ask.

## Documentation

- [Tutorial: your first blinded review](docs/tutorial-first-review.md) — skill and by-hand CLI walkthrough, zero to verdict
- [CLI reference](docs/reference-cli.md) — every verb, flag, manifest field, seat token, and the verdict file schema
- [How to run skeptic seats on other vendors' CLIs](docs/howto-cross-provider-skeptics.md) — codex / gemini / agy setup and troubleshooting
- [How to run the reviewer eval](docs/howto-run-the-eval.md) — free smoke, paid run, reading the report
- [Why blinded, why skeptics, why files](docs/explanation-design.md) — the design rationale and its trade-offs

## Cross-provider skeptics (per-seat model selection)

Three skeptics on one model share that model's blind spots. Each skeptic
seat can instead run on another vendor's locally installed CLI — OpenAI's
`codex`, Google's `gemini`, or Antigravity's `agy` — or on a named Claude
model via the Agent tool. Ask for it in words ("skeptics on codex, gemini,
agy") or pass the flags yourself:

```bash
bin/z-adversarial-review prepare ... --skeptic-models '["codex","gemini","agy"]'
bin/z-adversarial-review prepare ... --skeptic-models '["codex"]'   # seats 2-3 stay Claude
bin/z-adversarial-review prepare ... --reviewer-model opus          # reviewer is Claude-only
```

Tokens: `inherit` | `haiku` | `sonnet` | `opus` | `fable` (any seat), or
`codex[:<model>]` | `gemini[:<model>]` | `agy[:<model>]` (alias
`antigravity`; skeptic seats only — the reviewer's orchestration prompt is
Claude-harness-specific). Fewer than three tokens gap-fill with `inherit`;
no flags means all-Claude, byte-identical to the pre-feature behavior. A
requested CLI missing from PATH fails `prepare` immediately, before any
worktree is created. The verdict contract is provider-neutral: any process
that writes a well-addressed `verdict.json` counts in the quorum, and a CLI
seat that dies simply reports as a short quorum — never impersonated.

`setup` validates the fleet before a review depends on it (binary + version,
auth, folder trust; one row per provider; exit 0 all-green):

```bash
bin/z-adversarial-review setup            # deterministic, free
bin/z-adversarial-review setup --trust    # write the codex trust entry (idempotent)
bin/z-adversarial-review setup --probe    # opt-in live micro-call per CLI (paid)
```

You get a report: verdict (`REVIEW-APPROVE` / `REVIEW-FINDINGS` /
`NEEDS-HUMAN` / `BLOCKED` / `CONFUSED`), confidence 0-100, the skeptic quorum
(received / upheld / anything invalid, counted off disk), diff size, and a
spec-provenance caveat when the criteria came from the diff author's own
description.

There is also a plain CLI for the deterministic core:

```bash
bin/z-adversarial-review prepare --pr-json pr.json --repo . --out-dir /tmp/rev
bin/z-adversarial-review collect --verdict <path> --run-root <dir> --run <id> --ticket <n>
bin/z-adversarial-review cleanup --repo . --worktree <path>
```

## How a review runs

1. **`prepare`** (code): picks the spec — the PR's linked closing issue if
   one exists, else the PR description explicitly marked author-authored,
   else a named "no spec" fallback; slices the `Acceptance Criteria`
   section (any heading level); writes the merge-base diff with lockfiles excluded (unfiltered
   fallback for lockfile-only PRs); makes a throwaway worktree of the head
   commit under `.worktrees/`; mints the run identity; builds the reviewer
   prompt with three code-composed skeptic briefs embedded.
2. **One fresh agent** is spawned holding a ~400-byte pointer stub — the
   session that spawned it never reads the spec or diff itself. The reviewer
   typechecks and runs the touched tests in the worktree; on an adversarial
   pass it launches its three skeptics in one message with
   `run_in_background: false`, so every verdict lands inside its single turn.
3. **`collect`** (code): validates the reviewer's verdict envelope against
   the exact spawn `prepare` minted and counts the skeptic quorum off disk.
4. The session renders the report; `cleanup` removes the worktree.

## Tests and evals

Two lanes with different budgets:

- **Gate tests** (`bun test`, free, seconds): input assembly, the blindness
  gate, activation, verdict envelope checks, off-disk quorum, worktree
  lifecycle, the SKILL.md gh-invocation allowlist, and the eval scorer
  itself.
- **Paid eval** (`evals/reviewer/run.sh`, local Claude Code only, nightly /
  pre-ship): drives both prompt modes against a 771-line fixture diff hiding
  eight verified defects, grades recall by matching against the answer key,
  and gates on (1) the fan-out naming strictly more defects than the single
  pass in ≥ 80% of trials and (2) every reviewer having written a valid
  verdict file. `CLAUDE_CMD=evals/reviewer/mock-claude.sh evals/reviewer/run.sh 1`
  is the free structural smoke.

Before calling any change done: `bun test && bun run typecheck`.

## Limits, stated plainly

- The verdict is self-reported; what is enforced is the envelope, the result
  union, and the quorum count. The reviewer can be wrong — the design makes
  it hard for it to be *quietly* wrong.
- A PR with no linked issue is reviewed against the author's own narrative,
  disclosed as such. Link PRs to issues (`Closes #N`) to give the reviewer an
  independent yardstick.
- LLM calls (the review itself, the paid eval) run through locally installed
  CLIs — your Claude Code session, and for cross-provider skeptic seats the
  `codex`/`gemini`/`agy` binaries you installed and authed. This repo never
  calls a hosted model API itself.
- CLI skeptics run under their own vendor's sandbox with permission prompts
  skipped, inside a throwaway worktree of **the PR author's code** — the
  same exposure the Claude reviewer already accepts by running the PR's
  tests. Review code you would not execute at your peril, whatever the
  provider.

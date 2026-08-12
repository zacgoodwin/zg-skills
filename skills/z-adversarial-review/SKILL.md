---
name: z-adversarial-review
description: |
  Blinded adversarial review for any GitHub PR. Assembles a blinded four-key
  input (spec, acceptance criteria, diff, throwaway worktree), spawns one
  fresh reviewer agent holding nothing else, fans out 3 independent skeptic
  sub-agents on non-trivial diffs, and reports a confidence-scored verdict
  with the skeptic quorum counted off disk. Skeptic seats can run on other
  vendors' CLIs (codex, agy) for cross-provider blind spots. On the first
  ever run it asks which of those CLIs (if any) should staff the seats,
  validates the choice, and saves it so later runs never ask again; the
  setup verb re-validates that fleet on demand. Read-only by default;
  posting the review to the PR is an explicit opt-in.
  Use when asked to "z-adversarial-review", "adversarially review this PR",
  "review PR <N> with skeptics", or for a blinded second opinion on any pull
  request.
---

# /z-adversarial-review — Blinded Adversarial PR Review

The reviewer is **blinded by design**: it receives EXACTLY the spec, the
acceptance criteria, the diff, and a throwaway worktree of the head commit —
no PR discussion, no CI status, no author narrative beyond what is disclosed
as such, and none of YOUR context. On a non-trivial diff it spawns 3
independent skeptic sub-agents tasked to REFUTE the diff. Every verdict is a
**file**: the reviewer and each skeptic write `verdict.json` in their own
artifact directories, and the quorum is counted off those files — never off
anyone's prose.

Everything decidable is decided in code (`lib/review.ts`): spec selection,
acceptance-criteria extraction, diff generation, worktree lifecycle, fan-out
activation, skeptic briefs, verdict validation, quorum counting. Your latent
work is exactly three things: spawn the reviewer, relay the collected verdict
as a report, and exercise judgment on anything the verdict asks a human to
settle.

**Prerequisites:** run from inside a git checkout of the repo under review;
`bun` and an authenticated GitHub CLI on PATH.

## Step 0 — First run: choose your skeptic fleet (once, ever)

Before Step 1, check whether this user has already chosen a skeptic-seat
lineup. It is a one-time, per-user choice — saved under
`~/.claude/z-adversarial-review/` (`lib/models.ts preference`), not per-repo.
Once saved, every future review reuses it silently and this step is a no-op.

```bash
PACK=".claude/skills/z-adversarial-review"
[ -d "$PACK" ] || PACK="$HOME/.claude/skills/z-adversarial-review"
bun "$PACK/lib/models.ts" preference
```

- `{"exists": true, ...}` — a choice is already saved. Skip straight to
  Step 1; `prepare` loads the saved lineup automatically when you don't pass
  `--skeptic-models` yourself. An explicit "skeptics on X" in the user's
  current message still overrides it for this one run, same as always.
- `{"exists": false, ...}` — first run, nothing saved yet.
  - If the user's OWN phrasing this turn already names a lineup (see Step 1's
    "Per-seat models"), use those tokens below instead of asking — you
    already have the answer.
  - Otherwise, before doing anything else, ask with the AskUserQuestion tool:
    "Which outside CLIs should staff the skeptic seats?" with four options —
    "Claude only (default)" (tokens `[]`), "codex only" (`["codex"]`), "agy
    only" (`["agy"]`), "codex + agy" (`["codex","agy"]`). The answer's tokens
    drive both steps below.

**Validate before saving** (skip when the tokens are `[]` — nothing to
validate for Claude-only). Pass only the CLI providers actually chosen,
comma-separated:

```bash
bun "$PACK/lib/models.ts" setup --repo . --providers codex,agy
```

Relay the table as-is. A MISSING/FAILED row names its own fix — tell the
user, but don't block on it: save the choice anyway (below) so they're asked
only once, and let `prepare`'s own preflight (Step 1) enforce it with the
same fix message on the run that actually needs that seat.

**Save the choice**, so this is truly one-time:

```bash
bun "$PACK/lib/models.ts" preference --set '["codex","agy"]'
```

Then carry the same tokens into Step 1's `--skeptic-models` flag for this
run — don't rely on the just-written file being re-read in the same turn.

## Step 1 — Assemble the blinded input (deterministic)

`$PR_ARG` is the PR number from the user's invocation
(`/z-adversarial-review 123`); leave it empty to review the current branch's
open PR.

**Per-seat models** (optional): map the user's phrasing to `prepare` flags.
Tokens are `inherit`/`haiku`/`sonnet`/`opus`/`fable` (Agent tool, any seat)
or `codex[:<model>]`/`agy[:<model>]` (CLI providers, skeptic seats only).
Fewer than 3 skeptic tokens gap-fill with `inherit`. Pass nothing and
`prepare` falls back to the Step 0 saved preference on its own.

- "skeptics on codex and agy" → `--skeptic-models '["codex","agy"]'` (seat 3 stays Claude)
- "with a codex skeptic" / "with codex skeptics" → `--skeptic-models '["codex"]'` (seats 2-3 stay Claude)
- "reviewer on opus" → `--reviewer-model opus` (Claude models only; CLI
  tokens are rejected here by design)

A requested CLI provider missing from PATH fails `prepare` immediately with
the install fix — relay that error; never substitute a seat silently. Step 0
already runs this validation once for a new user; `/z-adversarial-review
setup` (below) re-runs it any time, e.g. after installing a CLI.

```bash
PACK=".claude/skills/z-adversarial-review"
[ -d "$PACK" ] || PACK="$HOME/.claude/skills/z-adversarial-review"
TMP=$(mktemp -d)

# PR metadata (read-only)
gh pr view $PR_ARG --json number,title,url,body,headRefOid,baseRefOid,baseRefName,labels,closingIssuesReferences > "$TMP/pr.json"

# Linked closing issue (read-only, optional): the preferred spec source,
# because it is independent of the diff author's own narrative
SPEC_ISSUE=$(jq -r '.closingIssuesReferences[0].number // empty' "$TMP/pr.json")
[ -n "$SPEC_ISSUE" ] && gh issue view "$SPEC_ISSUE" --json body,labels > "$TMP/issue.json"

bun "$PACK/lib/review.ts" prepare --pr-json "$TMP/pr.json" \
  ${SPEC_ISSUE:+--issue-json "$TMP/issue.json"} \
  --repo . --out-dir "$TMP" > "$TMP/manifest.json"
cat "$TMP/manifest.json"
```

`prepare` fetches the PR head if it is not local, writes the merge-base diff
with lockfiles excluded (falling back to unfiltered when the PR is
lockfile-only), creates a throwaway worktree of the head commit under the
repo's own `.worktrees/review-pr-<N>-<runId>` (the runId keeps two
concurrent reviews of the same PR from ever sharing one), writes the blinded
`input-pr-<N>.json` — EXACTLY the four keys
`{ticketBody, acceptanceCriteria, diff, worktreePath}`, enforced by a
compile-time + runtime gate — mints a one-shot run identity for the verdict
envelope, and builds the reviewer prompt (skeptic briefs included, composed in
code). The manifest tells you everything you need:

- `adversarial` — whether the skeptic fan-out is active. Computed, never your
  call: `always`/`off` by mode, `non-trivial` (the default) on a diff of >= 10
  changed lines or any `security`/`migration`/`payments`/`auth` label. The
  user can override with "review with skeptics" / "single pass" — pass
  `--adversarial-mode always` or `off` to `prepare`.
- `specSource` — where the spec came from. `linked issue #N` is the honest
  yardstick; `PR description (author-authored)` or `none` is a caveat your
  report MUST repeat, because the reviewer had no spec independent of the
  diff's author.
- `reviewerModel`, `skepticModels` — the RESOLVED per-seat lineup (gap-fills
  included). `skepticModels` is what the Step 4 report shows; `reviewerModel`
  drives the Step 2 spawn.
- `runId`, `runRoot`, `verdictPath` — the verdict envelope Step 3 validates
  against; pass them back verbatim.
- `stub` — the ~400-byte pointer prompt for the spawn below.

## Step 2 — Spawn the reviewer (one fresh agent, synchronous)

Spawn ONE fresh agent with the Agent tool:

- `prompt`: the manifest's `stub` value, verbatim. Never read `prompt-pr-<N>.txt`
  or `input-pr-<N>.json` yourself — your context is not blinded, and the
  worker reads its own instructions from disk; anything you read back just
  pollutes your window.
- `run_in_background: false` — REQUIRED. The reviewer must finish inside this
  tool call. This skill sends the reviewer exactly one message; a backgrounded
  reviewer that ends its turn waiting is a review nobody will ever collect.
- `model`: pass the manifest's `reviewerModel` when it is not `"inherit"`;
  on `"inherit"` set no `model` param, so the reviewer runs on your session's
  model.

The reviewer executes in the throwaway worktree (typecheck + the tests the
diff touches), and on an adversarial pass launches its 3 skeptics itself,
inside its own turn, exactly as its prompt directs per seat — Agent tool
spawns from the verbatim briefs, and/or the exact composed CLI commands
(codex/agy) run foreground through its Bash tool. Its final message
is just "verdict written" — the review itself lands as files. Expect several
minutes of wall clock; that is the review running, not a hang.

## Step 3 — Collect the verdict (deterministic)

Never read the verdict files yourself and never trust the agent's prose —
validate and count in code, with the manifest's own envelope values.
`--adversarial` is the manifest's `adversarial` field, passed verbatim —
`collect` never infers it from the verdict, and never trusts the reviewer's
own `evidence.skepticVerdictPaths` to decide what to count:

```bash
bun "$PACK/lib/review.ts" collect --verdict "$VERDICT_PATH" \
  --run-root "$RUN_ROOT" --run "$RUN_ID" --ticket "$PR_NUM" \
  --adversarial "$ADVERSARIAL"
```

Prints `{ok, result, notes, confidence, quorum}`. `result` is one of
`REVIEW-APPROVE`, `REVIEW-FINDINGS`, `NEEDS-HUMAN`, `BLOCKED`, `CONFUSED`.
`quorum` is `{received, of, unrefuted, invalid}` counted off the canonical
skeptic verdict files `prepare` itself laid out on disk (`null` when
`--adversarial` is `false`). An `{ok: false, reason}` — missing file,
mis-addressed envelope, pasted placeholder — means the review FAILED: relay
the reason, clean up, and offer to re-run; never reconstruct a verdict from
the transcript.

## Step 4 — Report, then clean up

Render the report to the user (and to `"$TMP/report.md"` if it may be posted):

```markdown
## Adversarial review — PR #<pr> <title>

**Verdict:** <result>
**Confidence:** <confidence>/100 (skeptics upheld <unrefuted>/<received> of <of> spawned — omit when quorum is null)
**Mode:** <adversarial? "adversarial (skeptics: <skepticModels, comma-joined>)" : "single pass"> over <diffLines> changed lines
**Spec:** <specSource — with the caveat, verbatim, when it is not a linked issue:
"criteria came from the diff author's own description; treat the approval floor accordingly">

<the findings / evidence from `notes`, numbered, each with file:line>
```

- `REVIEW-FINDINGS` → list every finding; recommend the PR not merge until
  each is addressed or explicitly waived by a human.
- `NEEDS-HUMAN` / `BLOCKED` / `CONFUSED` → relay `notes` verbatim; that is a
  real outcome for the human, not a failure to hide.
- A `REVIEW-APPROVE` with `confidence` below 70, with `quorum.received` short
  of `quorum.of`, or with anything in `quorum.invalid`, is an approval with an
  asterisk — say so plainly (70 is the suggested floor; the final call is the
  user's).

**Post to the PR only when the user explicitly asks** (a review is outward
once posted):

```bash
gh pr comment "$PR_NUM" --body-file "$TMP/report.md"
```

**Always clean up**, whatever the verdict — including after a failed spawn
(`worktreePath` from the manifest):

```bash
bun "$PACK/lib/review.ts" cleanup --repo . --worktree "$WORKTREE"
```

## Setup — validate the cross-provider fleet

`/z-adversarial-review setup` checks each CLI provider (codex, agy)
BEFORE a review depends on it — binary on PATH + version, auth, folder
trust. Deterministic, free, one row per provider; exit 0 all-green else 1:

```bash
PACK=".claude/skills/z-adversarial-review"
[ -d "$PACK" ] || PACK="$HOME/.claude/skills/z-adversarial-review"
bun "$PACK/lib/models.ts" setup --repo .
```

- `--trust` — writes the codex `config.toml` trust entry for the repo root
  (idempotent; prints exactly what it changed). agy needs no persisted
  trust: its adapter bypasses per run.
- `--probe` — opt-in live micro-call per CLI ("Reply with exactly OK"), the
  only paid check; run it only when the user asks for end-to-end proof.
- `--providers codex,agy` — scope the table to a subset (Step 0 uses this to
  validate only the providers the user actually picked).

Relay the table as-is. A MISSING row names its own fix (install command,
sign-in step, or the stale-session restart).

This is what Step 0 runs automatically the first time a given user runs this
skill; re-run it by hand any time — after installing a CLI, or if a skeptic
seat starts failing — to re-check without touching the saved choice.

**Changing the saved skeptic fleet**: the choice lives in one file
(`lib/models.ts preference`); overwrite it directly rather than deleting it:

```bash
bun "$PACK/lib/models.ts" preference --set '["codex","agy"]'
```

`preference` with no `--set` prints the current saved choice
(`{"exists": bool, "skepticModels": [...]}`) without changing anything.

## Honesty limits worth knowing

- **A PR-description spec is the author's own narrative.** The blindness
  contract withholds exactly that; standalone there may be nothing else to
  hold the diff to. The reviewer is told the spec's provenance, and the report
  repeats the caveat. Linking PRs to issues (`Closes #N`) gets you the honest
  yardstick.
- **Verdicts are self-reported files.** What is enforced is the envelope, the
  result union, and the off-disk quorum count. The reviewer can still be
  wrong; the point of the skeptics, the quorum, and the disclosure is that it
  cannot be QUIETLY wrong in the ways this design has already seen.
- **CLI skeptics execute the PR author's code with their vendor's
  permission prompts skipped**, sandboxed to the throwaway worktree — the
  same exposure the Claude reviewer already accepts by running the PR's
  tests. Stated plainly, not hidden.

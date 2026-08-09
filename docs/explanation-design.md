# Why blinded, why skeptics, why files

The design rationale behind z-adversarial-review. This document explains the
problems each mechanism exists to solve and what each one trades away.
Factual descriptions of the commands and schemas live in the
[CLI reference](reference-cli.md); this page is the *why*.

The design was extracted from [zstack](https://github.com/zacgoodwin/zstack)'s
dev-loop Review lane, where it accumulated its scar tissue across dozens of
unattended runs. Several rules below cite the specific failure that produced
them.

## The problem

An LLM reviewer with access to the PR page is an agreeable reviewer. It reads
the author's description, the reassuring CI checkmarks, and the discussion
thread, and it inherits the author's framing before it reads a line of the
diff. Worse, in an unattended pipeline, its output is prose — and prose can
claim anything: "all three skeptics agreed", "tests pass", "verdict:
approve". Nothing structurally prevents a review that is confidently,
quietly wrong.

Three mechanisms attack this, one per failure mode.

## Blindness: the reviewer gets four keys, enforced

The reviewer receives exactly `{ticketBody, acceptanceCriteria, diff,
worktreePath}` — no PR discussion, no CI status, no author narrative, and
none of the spawning session's context.

This is enforced twice in `lib/prompts.ts`, not assumed:

- **Compile time**: a type identity (`Exact<keyof ReviewerPromptInput,
  REVIEWER_INPUT_KEYS>`) stops typechecking if the input type ever gains or
  loses a key.
- **Runtime**: TypeScript types erase, so `assertReviewerInput` rejects any
  object whose key set is not exactly the four — a JS caller smuggling in a
  fifth field (`prDescription`, `ciStatus`, …) throws.

The session that spawns the reviewer never reads the spec or diff either.
`prepare` writes the full prompt to disk and hands the session a ~400-byte
pointer stub; the reviewer reads its own instructions from the file. The
stub's length depends on the path alone, so the spawning session's context
stays flat however large the diff is — and a session that never held the
inputs cannot leak them into the spawn.

**The honest limit**: when the PR links no closing issue, the only available
spec IS the author's description — the exact narrative blindness exists to
withhold. That cannot be fixed by hiding it (there is no other spec), so it
is disclosed instead: the assembled spec opens with a provenance note the
reviewer weighs, and the manifest's `specSource` makes the final report
repeat the caveat to the human.

## Skeptics: one reader agrees with itself

A single reviewer, however capable, confirms its own first reading. On any
diff worth worrying about — ≥ 10 changed lines, or any
`security`/`migration`/`payments`/`auth` label regardless of size — the
reviewer spawns three independent skeptics whose only task is *refutation*:
find the criterion the diff violates, the edge it breaks, a test that passes
without the change.

Independence is structural, not aspirational:

- Each skeptic is a fresh context. Its brief is composed in code
  (`skepticBrief`) and passed verbatim; the reviewer may not edit it. A
  reworded brief is how blindness leaks.
- No skeptic sees another skeptic's verdict, and a brief never tells a
  skeptic what model it is.
- The reviewer maps skeptic outcomes to a confidence score through a fixed
  lookup table (3 UPHELD of 3 → 100, 2 → 67, 1 → 33, 0 → 0), never
  arithmetic in a model reply. A criterion any skeptic REFUTED with concrete
  evidence is a finding, not a vote to be outnumbered.

The fan-out decision itself is a pure predicate in code
(`adversarialActive`): mode, changed-line count, labels. The model never
decides whether it gets second-guessed.

**Why the threshold exists at all**: three skeptics cost roughly four times
a single pass. The eval ([rubric](../evals/reviewer/rubric.md)) exists to
keep that spend honest — the fan-out must name strictly more planted defects
than the single pass, reliably, or it isn't worth running.

## Files: a verdict is a deliberate structured act

Every stage — reviewer and each skeptic — reports by writing `verdict.json`
into its own run-scoped directory. Prose is never parsed.

The alternative, scanning the agent's final message for a marker like
`REVIEW-APPROVE`, fails a specific way: prose can *quote* a marker (out of
its own instructions, or out of a ticket that contains one) without
reporting it, so a marker parser needs token-position discipline that a file
write simply deletes. An echo in prose is inert; a file is an act.

The verdict is still self-reported — an agent can write a false one; the
path is in its prompt. The enforcement is downstream and deterministic:

- **The envelope.** Every verdict carries `{schema, runId, ticket, stage,
  attempt}` and is validated against the exact spawn `prepare` minted. The
  runId (`run-<UTCstamp>-<4hex>`) is minted fresh per prepare, so a stale
  file from an earlier attempt can never speak for this run, and a verdict
  copied into another spawn's directory is mis-addressed — INVALID.
- **INVALID is one bucket, on purpose.** Unreadable, malformed,
  mis-addressed, out of the result union, or still carrying the template's
  `<placeholder>`: all named with a reason, never reinterpreted or partially
  trusted. `collect` exits 0 with `{ok: false, reason}` — an invalid verdict
  is an *answer* the session relays, not an exception to retry around.
- **The quorum is counted off disk.** The reviewer lists the skeptic verdict
  paths it saw, but the count the report shows comes from reading those
  files at collect time (`quorumFromDisk`). A listed path must resolve
  inside this run's own `runs/<runId>/t<ticket>/` subtree — an outside path
  (another run, an invented `/tmp` file, a traversal) is invalid, and
  listing it was the lie. The reviewer writing "3/3 agreed" has no effect on
  anything.

## The foreground rule

The prompts spend a conspicuous number of words on one instruction: run
everything in the foreground, collect the skeptics inside the single turn,
never end the turn "waiting". This is scar tissue from a measured failure
(zstack #318): the Agent tool's default is a *background* spawn whose only
delivery channel is a task notification between turns — and a one-message
worker gets no next turn. An adversarial reviewer that backgrounds its
skeptics and ends its turn waiting produces a finished, green, committed
review that reaches nobody. The eval's gate 2 (every stage wrote a valid
verdict file, no exceptions) exists to keep this failure unreachable.

## The latent/deterministic split

The organizing principle: everything decidable is decided in code, and the
model only judges the diff. Spec selection, AC extraction, diff generation,
worktree lifecycle, fan-out activation, brief composition, CLI command
composition, verdict validation, quorum counting, confidence mapping, eval
scoring — all deterministic, all gate-tested for free. The latent surface is
exactly: the reviewer's judgment, each skeptic's refutation attempt, and the
eval grader's "does this finding name that defect?" matching.

This is why the repo reads as a thin skill file over a fat `lib/`: the skill
prose can drift, the code cannot.

## Trade-offs, named

- **Blindness costs context.** The reviewer cannot see the PR discussion
  where the author explains a deliberate trade-off; it may flag things a
  human already litigated. `NEEDS-HUMAN` is the sanctioned exit for exactly
  that, and the human makes the final call.
- **Skeptics cost money.** ~4× a single pass. Bounded by running them only
  on non-trivial diffs, and audited by the recall eval.
- **Files cost ceremony.** Every stage needs the envelope in its prompt, a
  validator, and an artifact tree. Bought with it: a review that cannot be
  quietly lost or quietly forged, which is the point.
- **Self-report remains.** The design makes the reviewer hard to be
  *quietly* wrong — it does not make it right. A `REVIEW-APPROVE` at
  confidence 33 with one skeptic missing is reported as exactly that, and
  the human decides.

## Related

- [CLI reference](reference-cli.md) — the schemas and commands these
  mechanisms live in
- [Tutorial: your first blinded review](tutorial-first-review.md)
- [How-to: run the reviewer eval](howto-run-the-eval.md) — the measurement
  that keeps the fan-out honest

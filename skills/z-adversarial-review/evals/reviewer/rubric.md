# Reviewer eval rubric

Scores the adversarial reviewer against the `multi-defect` fixture: one
realistic diff that typechecks, ships a green 55-test suite, and hides eight
independent defects. The question this eval answers is **how much of what is
wrong does one review cycle surface?** — so the metric is RECALL over a known
defect list, and the pass contract is a trial-count threshold.

This is the **paid lane** (LLM calls) and is NOT part of the gate suite
(`bun test`). Every LLM call goes through **local Claude Code** — never a
hosted API. The deterministic half (the activation predicate, the diff
counter, the prompt-branch content, the four-key gate, the verdict envelope,
the quorum count, this eval's own scoring) is gate-tested for free in
`tests/`.

Fixture, defect mix, and the history of why the metric is recall rather than
"single-pass misses a planted needle" are inherited from zstack's
`evals/reviewer` lane, where the original contract was falsified by
measurement (16 real single-pass reads over four fixture redesigns: a planted
defect must violate a stated criterion to be gradable, so the criteria index
the defect and a code-executing reviewer audits its way to it every time).
The mix here is weighted toward stateful-interaction defects, the class that
measurement showed carries the single-vs-adversarial delta.

## The fixture

`fixtures/multi-defect/` is a 771-line diff adding a keyed rate limiter
(`src/window.ts`, `src/limiter.ts`) and its HTTP edge (`src/middleware.ts`),
against a 12-criterion ticket. Its 55 shipped tests are green with every
defect present. `defects.json` is the answer key: eight entries, each with the
site, the mechanism, the criterion it violates, and a reproduction.
`defects.json` never enters the reviewer's input — the reviewer stays blinded
to the same four keys as in production.

## Per-trial grading

Each trial drives BOTH prompts, built from the SAME blinded four-key input,
through a fresh live Agent: single-pass (`--adversarial-mode off`) and
adversarial (`--adversarial-mode always`). Each reviewer reports by writing
its verdict file, exactly as in production.

A fresh local grader then does the ONE latent job in this eval: matching. For
each defect id it decides whether each reviewer's verdict `notes` actually
name that defect — same site, same mechanism, in the reviewer's own words. A
finding that gestures at the right file while describing a different problem
is not a match. Everything after that is code (`evals/lib/recall.ts`):

1. **Grader schema drift is UNREADABLE, never a graded miss.** A missing
   defect id or a non-boolean fails the run with exit 2 instead of silently
   scoring that defect as missed.
2. **The pass rule is a trial count, not a mean**, so one lopsided trial
   cannot carry a run that lost the rest.

## Pass threshold

Two gates, both computed in `evals/lib/recall.ts`, ANDed.

### Gate 1 — recall

**Adversarial names strictly more planted defects in ≥ 80% of trials**
(`ceil(0.8 × N)` wins over N trials; 4/5 at the default N=5). A tie is not a
win: equal recall is no evidence for a mode that costs four times as much.

### Gate 2 — the verdict file

**Every reviewer stage must have written a valid verdict file: 2N of 2N, no
exceptions.** Unlike zstack's original marker-based gate, this one is fully
deterministic here: run.sh reads each verdict file with `lib/verdict.ts
check` and feeds the file's own `result` (or `NONE` when missing/invalid)
into the scorer. The graded property is that a verdict was *reported*, not
that it was favorable — `CONFUSED` counts; silence fails. One silent stage in
a run is a reproduction of the lost-review defect this design exists to
prevent, so one occurrence fails the run.

### Cadence

Periodic / pre-ship — nightly or before a release, never on every commit.

The report also prints, for diagnosis and never as a gate: each mode's mean
recall, the per-defect catch rate, and how many findings matched no planted
defect.

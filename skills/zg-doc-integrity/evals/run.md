# Running the eval

Measures what the gate tests cannot: whether the AGENTS actually find the
seeded defects and leave the traps alone. Costs real model calls, so it runs
before a release and when a prompt or a constant changes — not on every commit.

The deterministic half is already a gate test (`tests/fixture.test.ts`): every
seeded defect becomes a candidate cluster, and every trap stays out of one. If
that suite is red, fix it before spending anything here — the agents are being
asked the wrong questions and no model quality compensates.

## What is being measured

`evals/fixtures/drifted/` holds two documents and `defects.json`, the ground
truth: seven seeded defects that a review should find, and seven traps that look
like defects and must not be reported.

The traps are the point. A review that reports everything scores perfect recall
and is worthless, because a human stops reading a plan that cries wolf. Read the
extras list every time.

## Run it

```bash
cd skills/zg-doc-integrity
FIX="$PWD/evals/fixtures/drifted"

bun lib/run.ts prepare guide.md reference.md --repo "$FIX"
```

Run every spawn the manifest lists exactly as SKILL.md describes — Agent tool
for a spawn with no `command`, Bash for one with. Then:

```bash
RUN=$(ls -d "$FIX"/.doc-integrity/runs/* | tail -1)
bun lib/run.ts merge --run "$RUN"     # run the reduce spawn, then again
bun lib/run.ts merge --run "$RUN"     # run the refute spawns
bun lib/run.ts collect --run "$RUN"
bun evals/lib/score.ts "$FIX/defects.json" "$RUN/r1/plan.json"
```

Clean up with `rm -rf "$FIX/.doc-integrity"` — the fixture directory is a
working repo for the duration of a run.

## Reading the result

```
recall            7/7 (100%) found
surfaced          6/7 (86%) reached the main list
reported          7 findings
not in ground truth 0 (0%)
mean confidence   matched 74 · other -
```

- **recall vs surfaced** — the gap between them is defects the review found and
  then buried in an appendix. Watch `surfaced`; it is what a reader acts on.
  `recall` alone will happily report a perfect score for a plan whose findings
  all got refuted.
- **recall** — below 5/7 means a lens or a brief regressed. `MISSED` names which
  seat should have caught each one; that tells you where to look.
- **not in ground truth** — check each against the trap list by hand before
  calling it a false positive. These documents are realistic prose and can
  contain real defects nobody seeded; a genuine find belongs in `defects.json`,
  not in the failure count.
- **mean confidence** — the calibration number. Matched findings should score
  clearly above the rest. If the two means are close, the confidence formula is
  not separating signal from noise and the constants in `lib/findings.ts` need
  re-tuning, starting with `CONFIDENCE_APPENDIX_FLOOR`. Note that with zero
  false positives there is nothing to separate FROM, so a clean run gives you no
  calibration signal at all — that number only becomes useful on a run that
  reports something wrong.

## What the first run actually taught us

Every one of these was invisible to the 300-plus gate tests and cost a real
multi-agent run to find. Expect the next surprise to be the same shape: a place
where two independently reasonable components disagree about what a thing means.

- **Seats do not quote the same span.** Three seats found the same timeout
  conflict and quoted three different slices of the same two sentences. Identity
  keyed on quote text, so nothing merged: one defect appeared three times, each
  copy claiming single-seat confidence while three seats had actually agreed.
  Within-round identity is now the resolved SITES.
- **Seats do not agree on `kind` either.** The same collision came back as
  `term-collision` from one seat and `contradiction` from another. Kind is no
  longer part of identity; the most specific label wins.
- **Refuters will kill a fact if you let them.** The duplicate-heading finding
  is computed in code, and three refuters voted it down anyway — on impact
  grounds, which is severity's job. Deterministic findings now skip refutation.
- **A weak seeded defect is a fixture bug, not a skill failure.** The
  Friday-deploy case first read "deploy during business hours" against "never
  deploy at end of week", which are jointly satisfiable. The refuters were
  right to kill it. It was rewritten to be unambiguous, and a gate test now
  asserts its two sides share no content word — the property it exists to test.

## The one case worth checking by hand

`friday-deploys` is a contradiction with no shared vocabulary: "Shipping on a
Friday afternoon is fine" against "Never deploy at the end of the week". No
inventory can join those, so it is reachable ONLY through the claim ledger and
the reduce pass. If recall is otherwise fine and this one is missing, the ledger
is the thing that regressed — check that the shard seats wrote `claims.json` and
that the reduce spawn ran.

In the first run it worked exactly as designed: the shard reader saw both
documents and did NOT report the conflict, but did record both claims, and the
reduce pass joined them. A single reader with full visibility missed what the
ledger structure caught, which is the best evidence so far that the mechanism
earns its cost.

**But this fixture cannot isolate the reduce pass, and you should know that
before trusting the number.** At ~130 lines the whole set is one shard, so the
shard reader always sees both documents and can reach any cross-document defect
without the ledger — on the second run, with the defect's wording sharpened, it
did exactly that. The no-shared-vocabulary property is still gate-tested, but
"only the reduce pass can find this" is a claim this fixture cannot support.

Proving it needs a fixture large enough to shard, with the two halves of a
conflict deliberately placed in different shards. That is the most valuable
thing to add to this eval next.

## Thresholds

Release blocks on recall below 5/7, or on any seeded defect marked
`deterministic: true` being missed — those come out of code and have no excuse.
Everything else is a judgment call to record in the CHANGELOG.

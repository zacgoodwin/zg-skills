# Changelog

All notable changes to `zg-doc-integrity`.

## [Unreleased]

## [0.1.0] - 2026-08-25

First release.

### Added

- **Five lenses over a document set read as one document**: contradiction,
  term-collision, term-split, numeric-conflict, and structure. Style and tone
  are deliberately out of scope.
- **Quote-based citation.** Agents emit verbatim quotes; `lib/findings.ts`
  resolves each to every place it occurs. A quote that resolves nowhere is
  dropped to an Unverifiable appendix rather than becoming a citation.
- **Four deterministic inventories** built before any model runs, so the
  cross-document comparison happens in code and the agents read small clusters
  instead of the full text.
- **A structure lens that needs no model** — dangling anchors, duplicate
  headings, contents-list drift — plus the rule that a reference to a document
  outside the review set is recorded as unverifiable, never reported as broken.
- **A claim ledger and reduce pass** for contradictions that share no
  vocabulary, which no inventory can join.
- **Region tagging** for the four biggest false-positive sources: code fences,
  changelog and history sections, quoted and example passages, front matter.
  Exclusion is per-lens — the numeric lens reads code fences on purpose.
- **Sharding** with a 25,000-line ceiling, a 12-agent cap, and every cap that
  bites stated in the plan.
- **Computed severity and confidence**: `(modality × detectability) + blast +
  hazard` for severity, a discovery base plus a refutation delta for confidence.
  Never asserted by an agent, so both stay stable across rounds.
- **Cross-provider seats** (`codex`, `agy`/Antigravity) for independent
  discovery and adversarial refutation, with the fleet check, the codex trust
  writer, and a per-user preference that borrows an existing
  `z-adversarial-review` choice rather than asking twice.
- **The human gate**: a plan file where each finding takes one of its option
  letters, "change nothing", or a comment. Any comment anywhere sends the round
  back for targeted regeneration; settled answers carry forward pre-filled; a
  "change nothing" is remembered for the rest of the run.
- **Apply safety**: snapshots before any write, edits grouped one agent per
  file, and a blast-radius check that fails the run when anything outside an
  approved site changed — including changes that improve the document.
- 330+ gate tests with no network and no model calls, plus an eval fixture
  carrying seven seeded defects and seven deliberate traps.

### Found by the first live eval run

Two bugs that only a real multi-agent run could surface, both now gate tests:

- **Cross-seat dedup did not work.** The merge keyed identity on exact quote
  text, and seats do not agree on how much of a sentence to quote. One timeout
  conflict came back as three separate findings because three seats each quoted
  a different span of the same two sentences; the fixture produced eleven
  findings for six defects. Worse than the duplication: because the copies never
  merged, each one carried the confidence of a single-seat finding while three
  independent seats had in fact agreed — the formula's strongest input was being
  silently discarded. Identity is now split in two. Within a round, two findings
  are the same when they are the same kind and share two resolved sites (or
  their only site); across rounds, the quote-based fingerprint still carries the
  decisions ledger, because lines move when documents are edited and quotes do
  not.
- **Refuters killed a fact.** The duplicate-heading finding is produced in code
  by reading the document graph: `reference.md` either has two `## Errors`
  headings or it does not. Three refuters nonetheless voted it down, evidently
  on the grounds that it did not matter — which is a severity judgment, and
  severity is computed elsewhere. Findings from the structure lens are now
  marked `deterministic`, skip refutation entirely, and carry a confidence that
  says "verified in code" rather than "several models agreed". The count of
  findings that skipped refutation is reported like every other cap.
- **The scorer could not see a buried true positive.** Recall said 7/7 while the
  reader would have acted on 5, because two real defects had been routed to the
  refuted appendix. It now reports `surfaced` alongside `found`, and names every
  defect that was found and then buried.
- **A ground-truth defect was wrong, and the refuters were right about it.** The
  Friday-deploy case originally read "Deploy during business hours" against
  "Never deploy at the end of the week" — two rules that are jointly satisfiable
  by deploying Monday to Thursday. Three refuters correctly killed it. The
  fixture was rewritten so the case is unambiguous, since it exists to measure
  whether the claim ledger can join statements sharing no vocabulary, not
  whether refuters can spot a weak claim. A gate test now asserts the two sides
  share no content word.
- **SKILL.md contradicted itself** — fitting, for this skill. It told the
  orchestrator to pass "the literal file contents of its briefPath" and, four
  lines later, never to read a shard. A brief contains the shard. Spawns now
  carry a `stub`: a ~300-byte pointer the orchestrator passes instead, so the
  seat reads its own brief off disk and the material under review never enters
  the context that writes the report.

### Known eval limitation

The `drifted` fixture is ~130 lines, which is a single shard, so its shard
reader always sees every document. That means the fixture cannot isolate the
claim-ledger reduce pass: any cross-document defect is reachable without it. The
first run happened to demonstrate the mechanism anyway — the shard reader had
both documents and still missed the no-shared-vocabulary conflict that the
ledger caught — but that is an observation, not a controlled result. A fixture
large enough to shard, with the two halves of a conflict placed in different
shards, is the most valuable thing to add next.

### Found by running the skill on its own documentation

Dogfooding before release caught four candidate-quality bugs, each now a gate
test:

- `25,000` scanned as the two numbers `25` and `000`, so every mention of the
  line ceiling reported a conflict with itself. Grouped numbers are now one
  value.
- Sequential `## Step N` headings were read as six conflicting quantities. A
  number in a heading is a label, not a measurement.
- Two numbers on one line ("medium 4–7") were reported as a conflict. A conflict
  needs two distinct places; one sentence cannot disagree with itself.
- The terminology bar counted any sentence containing "must" as definitional,
  which on real technical prose qualifies nearly everything — 79 candidates from
  six documents. Commands are the directive inventory's job; the term inventory
  now requires two genuine definitions.

The same pass removed the "this term is spelled two ways" signal entirely.
`normalizeTerm` collapses exactly case, hyphenation, separator and plurality, so
two surfaces sharing a key differ only by those — that is spelling
inconsistency, which is the style lens this skill deliberately does not have.

### Notes

- `lib/cli.ts` is a byte-identical copy of `z-adversarial-review`'s, guarded by
  a test that skips when that skill is not installed alongside. This skill runs
  standalone.
- The severity and confidence constants are a starting point calibrated against
  the eval fixture, not derived truth. `evals/run.md` documents how to re-tune
  them.
- A boundary worth watching: a mixed-modality cross-document conflict scores 7
  and bands as medium, one point under the high cutoff. `tests/findings.test.ts`
  marks the case; if the eval shows these dominating real findings, the cutoff
  moves from 8 to 7.

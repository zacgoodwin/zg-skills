# zg-doc-integrity

Finds internal contradictions and language drift across one or many documents
reviewed **as a single document**, cites every instance, and edits nothing until
a human decides.

```bash
/zg-doc-integrity docs/guide.md docs/reference.md "specs/*.md"
```

## What it looks for

| Kind | Example |
|---|---|
| contradiction | "run migrations before deploying" in one document, "never run migrations before a deploy" in another |
| term-collision | "API key" defined as a long-lived credential in one place and a one-hour token in another |
| term-split | the same concept called two different things, so a reader misses half the documentation |
| numeric-conflict | a 30s timeout in the quickstart, 60s in the reference, and a third value in a config sample |
| structure | a link to `#setup` where no such heading exists, a contents list pointing at removed sections, two headings that collide |

Style, tone, and formatting are deliberately **not** checked. That lens has the
worst signal-to-noise ratio of any of them.

## What makes it different

**Agents never count lines.** They emit verbatim quotes and code resolves each
one to every place it occurs. A hallucinated citation is impossible rather than
unlikely — a quote that resolves nowhere is dropped to an appendix — and one
issue automatically yields every instance of itself.

**The cross-document work is deterministic.** Four inventories (term, numeric,
directive, structure) are built in code over the whole set before any model
runs. Structure findings come out with no LLM at all. The rest become small
clusters — "this term appears at 14 sites, here are the contexts" — and those,
not the full text, are what the agents read. That is what makes a 25,000-line
review affordable.

**A claim ledger catches what shares no words.** "Shipping on a Friday afternoon
is fine" and "never deploy at the end of the week" have no term or number in
common, so no index can pair them. Each shard reader also records one line per
claim it saw; a single reduce pass compares those across the whole set.

**Nothing outside the documents is visible.** Reviewers work in a throwaway
directory holding copies of the documents and nothing else — no repo, no git, no
web. A reference to a document you did not pass is recorded as unverifiable,
never chased.

**No finding names a winner.** Each one presents its sides and its ways out with
what each costs and drags along. Which passage is right is a judgment the
documents cannot make.

## The loop

```
prepare → discovery seats → merge → reduce → refute → collect → plan.md
                                                                    ↓
                                        ┌──────── you edit it ──────┘
                                        ↓
                            any comment? ──yes──→ targeted regeneration → new round
                                        │ no
                                        ↓
                              apply (one agent per file) → verify
```

For each finding you tick exactly one box: an option letter, **change nothing**,
or **comment**. Any comment anywhere sends the round back before anything is
edited. Findings you already settled carry forward pre-filled. A "change
nothing" is remembered, so the same finding is not raised at you twice.

Apply groups edits by file so two agents never touch one document, snapshots
every file first, and afterwards diffs against the snapshot: an agent that also
fixed a typo fails the run, because that change was reviewed by nobody.

## Cross-provider seats

Outside CLIs can staff two jobs: an independent discovery pass over the same
clusters, and adversarial refutation of individual findings.

```bash
bun lib/providers.ts setup --repo . --trust
bun lib/providers.ts preference --set '["codex","agy"]'
```

Supported: `codex` (OpenAI Codex CLI) and `agy` (Google Antigravity, alias
`antigravity`). Asked once ever, then remembered. If you already chose a lineup
for `z-adversarial-review`, that choice is borrowed rather than asked again.

## Severity and confidence

Both are computed in code from facts the agents supply, never asserted by an
agent, so they stay comparable between seats and stable across rounds.

**Severity** = `(modality × detectability) + blast + hazard`, banded high ≥ 8,
medium 4–7, low ≤ 3. Modality is whether a reader *acts* on the text;
detectability is whether they can see both sides at once. They multiply because
they compound.

**Confidence** starts at 30 for a single seat, gains 12 per additional
independent seat (capped at 3), 10 when the seats span vendors, and 6 when every
quote resolved exactly. Refutation then adds +25 (all upheld) down to −60 (all
refuted). Below 40 a finding moves to an appendix — written out in full, never
deleted.

Findings the structure lens computed are exempt from all of that. A duplicate
heading either exists or it does not, so there is no claim for an adversary to
attack: they skip refutation and score 95, labelled "verified in code". The
first eval run is why — three refuters voted down a real duplicate heading,
evidently because it did not seem important, which is severity's job.

**The constants are a starting point, not derived truth.** `evals/run.md`
calibrates them against seeded defects and deliberate traps, and records what
the first live run changed.

## Measured, once

One live run against the eval fixture: 7 of 7 seeded defects found, 6 surfaced
in the main list, 0 false positives out of 7 reported. The seventh was refuted
by three adversaries, and they were right — that seeded defect was two rules
that could both be satisfied at once. `evals/run.md` has the numbers, the four
bugs the run exposed, and how to reproduce it.

One run on one fixture is a smoke test, not a benchmark. It says the machinery
works end to end; it does not say what recall you will get on your documents.

## Limits worth knowing

- A clean report means "nothing found", not "nothing there". Every cap that bit
  and every seat that went silent is stated in the plan.
- Markdown and plain text only (`.md .mdx .txt .rst`). No conversion layer:
  citations into a converted PDF would point at text you cannot edit.
- 25,000 lines per review, enforced. Past that the shard budget and the time
  estimate stop being honest.
- The decisions ledger is per-run. A "change nothing" today does not suppress
  the same finding on next month's review.

## Layout

```
lib/bundle.ts       documents, region tagging, the throwaway bundle directory
lib/inventory.ts    the four deterministic inventories
lib/findings.ts     quote resolution, severity, confidence, merge
lib/structure.ts    the lens that needs no model
lib/shard.ts        shard boundaries and rendering
lib/prompts.ts      every brief, composed in code
lib/verdict.ts      the verdict contract and the off-disk quorum
lib/providers.ts    codex / agy adapters, setup, preference
lib/plan.ts         plan render, disposition parser, decisions ledger
lib/regenerate.ts   the comment loop
lib/apply.ts        snapshots, per-file grouping, blast-radius verify
lib/run.ts          the orchestrator: prepare / merge / collect / continue / verify
```

`lib/cli.ts` is a byte-identical copy of `z-adversarial-review`'s, guarded by a
test. This skill installs and runs with that one absent.

## Install

```bash
npx skills add zacgoodwin/zg-skills --skill zg-doc-integrity
```

## Develop

```bash
bun install
bun test          # 300+ gate tests, no network, no model
bun run typecheck
```

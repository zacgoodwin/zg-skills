# Why it is built this way

Five decisions carry most of the design. Each one is a response to a specific
way this kind of tool fails.

## Agents emit quotes; code produces line numbers

**The failure:** a reviewer says "docs/api.md:114 contradicts docs/auth.md:57"
and one of those lines says nothing of the sort. Line numbers are the easiest
thing in the world for a language model to be confidently wrong about, and a
plan full of wrong citations is worse than no plan — every one costs a human a
trip to a file to discover nothing is there.

**The response:** no agent ever reports a line number. Every finding points at
text with a verbatim quote, and `resolveQuote` maps it to every place it occurs.
Three consequences fall out:

1. A hallucinated citation is impossible rather than unlikely. A quote that
   resolves nowhere means the agent paraphrased, and the finding is dropped to
   an appendix with the reason.
2. "All instances of a particular issue" comes free. If a sentence appears in
   five places, all five are cited without anyone having to find the other four.
3. Findings become stable across edits. A fingerprint over quotes survives
   documents being edited around it, which is what lets a "change nothing"
   decision suppress the same finding in a later round.

The cost is that an agent must copy text exactly, which they are worse at than
you would hope. Whitespace-normalized matching absorbs the common failure and
marks the result as a weaker match, priced into confidence.

**A quote is the right handle for a citation and the wrong one for identity.**
That distinction was learned the expensive way. Identity was originally the
quote text, and the first live eval run produced one timeout conflict three
times over, because three seats each quoted a different slice of the same two
sentences. Nothing merged, so the plan carried three copies — and each claimed
the confidence of a single-seat finding while three independent seats had in
fact agreed, quietly discarding the strongest input the confidence formula has.

So identity is split by timescale. WITHIN a round it is the resolved sites: two
findings are the same when they indict the same places, sharing two sites (or
their only site). Kind is not part of it either, since seats disagree about
whether a collision is a `term-collision` or a `contradiction` and the
disagreement carries no information; the more specific label wins. ACROSS rounds
identity stays the quotes, because lines move when documents are edited and the
decisions ledger has to survive that.

## The cross-document work happens in code

**The failure:** "find contradictions across 25,000 lines" is O(n²) comparison
and does not fit in any context window. The naive fix — give each agent a chunk
— finds only contradictions that happen to land in one chunk, which are the
least interesting ones, because a reader can usually see those too.

**The response:** four inventories, built deterministically over the whole set
before any model runs.

- **Term** collapses case, hyphenation, separator style and plurality, so
  `apiKey`, `API key` and `api-key` are one entry with three spellings.
- **Numeric** extracts durations, sizes, percentages, versions, dates, ports and
  bare counts with a two-word subject, then discards agreement and unit-only
  differences.
- **Directive** keys sentences carrying MUST/NEVER/SHOULD on their two content
  words, sorted, so "run migrations before deploy" and "migrations must never
  run" land in one group.
- **Structure** is not a candidate list at all: dangling anchors, duplicate
  headings and contents-list drift are decided outright, with no model involved.

What reaches an agent is a cluster — "this term appears at 14 sites, here are
the 14 contexts" — not the text. Cross-document comparison therefore costs
almost nothing, and the agents spend their judgment on the only question that
needs it: *is this actually a conflict?*

The subject keys are crude on purpose. They are join keys for candidate pairing,
and precision is the agent's job. A key that is too clever produces fewer
candidates and hides real defects.

## A claim ledger for what shares no words

**The failure:** the inventories join on vocabulary. "Deploy during business
hours" and "never ship at the end of the week" are the same claim in opposition
with not one word in common. No index can pair them, and they sit in different
shards, so no shard reader sees both.

**The response:** each shard reader has a second job. Alongside its findings it
writes one line per normative claim it saw — subject, assertion, and the
verbatim quote. Even at the 25,000-line ceiling those ledgers total a few
hundred lines, which one reduce agent can hold at once. It hunts for pairs that
cannot both be true, working by meaning rather than string overlap, and is
required to verify the contradiction in the QUOTED source text before reporting
it, because the one-line assertions are another reader's paraphrase.

This is the least proven part of the design, which is why the eval fixture
carries a defect reachable only this way.

## Exclusion is per-lens, not global

**The failure:** the biggest source of false positives in a document review is
text that is *supposed* to disagree with the current state. A changelog
describing old behavior. An anti-pattern example showing the wrong way. A quoted
excerpt. Report those and a human stops trusting the tool by the third finding.

The obvious fix — skip those regions — is wrong in one specific way that
matters: a config sample showing `timeout: 30` while the prose says 60 is among
the most common real defects in developer documentation, and a global skip of
code fences makes it invisible.

**The response:** regions are tagged once and each lens declares what it must
not read. Contradiction and terminology skip everything. Numeric skips history
and examples but **reads code fences on purpose**. Structure reads history and
example sections, because their headings are real headings that belong in a
contents list and their links really can dangle.

Withheld lines are replaced by a marker rather than removed, so line numbers
stay true and the agent can see that something was withheld rather than reading
a document with silent holes.

## The gate refuses rather than guesses

**The failure:** a tool that edits prose on a plausible reading of an ambiguous
instruction. Every ambiguity is a chance to change something nobody approved,
and prose has no test suite to catch it.

**The response:** every ambiguity resolves toward not editing.

- Comment text on a finding overrides any ticked box, so nothing under
  discussion is ever edited — and the human does not have to remember to also
  change the tick.
- Zero boxes, two boxes, an option letter the finding does not offer, or a
  ticked "comment" with nothing written: all block, named by finding id.
- A wholly untouched plan is reported as "not reviewed", not as a hundred
  separate mistakes.
- Two chosen options editing the same line block, because applying either
  silently would make the other's stated consequence false.

And after the edits land, the diff is checked against what the chosen option
declared it would touch. An apply agent that also fixed a typo fails the run.
That rule holds even when the extra change is obviously correct, because the
approved edits were reviewed by a human and the extra one was not — and nothing
downstream can tell a good unreviewed change from a bad one.

## Some findings are facts, and facts are not refutable

The structure lens reads the document graph: a duplicate heading either exists
or it does not, and code can say which. Everything else here is a model reading
prose and forming a judgment.

Treating those two the same was a bug, and the first eval run found it. Three
adversaries were handed a genuine duplicate heading and all three killed it —
evidently by reasoning that a reader would not really be misled, which is a
statement about how much it MATTERS, not about whether it is TRUE. Severity
already answers that question, mechanically and elsewhere.

So findings from the structure lens are marked deterministic. They skip
refutation, because there is no claim to attack; they score 95, labelled
"verified in code"; and the plan says which they are, so a reader can tell a
computed fact from three models agreeing. A model that independently reports the
same duplicate heading is welcome, and does not make it any less a fact.

The general shape is worth keeping in mind when adding a lens: an adversarial
check is only meaningful against something that could be wrong.

## What is deliberately absent

**No style lens.** Heading case, tense, tone. It has the worst signal-to-noise
ratio of any lens and would bury the findings that matter.

**No automatic authority.** Not first-document-wins, not newest-wins, not
most-sites-wins. Each option states its cost and consequence and stops there.
Which passage is correct depends on intent the documents do not record.

**No conversion layer.** Markdown and plain text only. A citation into a
converted PDF points at text the user cannot edit, and apply could not write
back.

**No shared package with `z-adversarial-review`.** `lib/cli.ts` is a copy,
guarded by a byte-identity test that skips when the sibling is absent. The two
skills install independently, and that constraint is worth more than the
duplication costs.

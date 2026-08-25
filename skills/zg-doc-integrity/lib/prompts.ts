// Every brief an agent receives, composed HERE in code.
//
// Nothing about the contract is left to the orchestrator to phrase: the quote
// rule, the option rule, the output shape and the exit contract are identical
// for every seat, every round, and every provider. A brief the model writes for
// another model is a contract that drifts.
//
// The rules below repeat in every brief on purpose. They are the three ways an
// agent can waste the whole run -- paraphrasing a quote, naming a winner, and
// reaching outside the bundle -- and each is cheaper to over-state than to
// detect afterwards.
import { type Bundle } from "./bundle.ts";
import { type Cluster, type DirectiveMeta, type NumericMeta, type Site, type TermMeta } from "./inventory.ts";
import { type Shard } from "./shard.ts";

// -- the shared contract ---------------------------------------------------------

const QUOTE_RULE = `## Quotes are your only way to point at text

You do not report line numbers. You report VERBATIM QUOTES, and the harness
resolves each one to every place it occurs. This is checked mechanically:

- A quote must be copied character-for-character from the text you were given.
  A paraphrase, a tidied-up version, or a quote with an ellipsis resolves to
  nothing and your whole finding is discarded as unverifiable.
- Quote enough to be unique -- usually a full sentence or clause. If the same
  sentence appears in five places, that is correct and useful: the harness will
  cite all five without you having to find them.
- Never invent a quote to illustrate a point. If you cannot quote it, you cannot
  report it.`;

const OPTION_RULE = `## Offer options, never a verdict

For every finding, give the reader the ways out and let them choose. You are
explicitly NOT deciding which passage is right -- that judgment belongs to the
human, who knows things the documents do not say.

- Give 2 or more options. Usually "align on X" and "align on Y"; sometimes a
  third such as "split into two distinct terms" or "state both with their
  scopes".
- Each option lists the exact edits it requires, as quotes that already exist in
  the text, and a \`consequence\` naming what it costs and what it drags along:
  the number of edits, and anything elsewhere that would then need to change.
- Stating that one option is 1 edit and another is 3 is a FACT and belongs in
  the consequence. Saying one is "better", "correct", or "recommended" is a
  verdict and does not belong anywhere in your output.
- An option that changes nothing is not an option; the reader already has that
  choice.`;

const SCOPE_RULE = `## You see the documents and nothing else

This review is strictly internal to the text you were given. Do not use a web
search, do not read files outside the material in your brief, and do not rely on
what you happen to know about this project, product, or tool. If the documents
disagree with the world, that is not your finding. If they disagree with each
other, that is.

A reference to a document that is not in this set is NOT a broken reference --
it is simply outside the review. Ignore it.`;

const FALSE_POSITIVE_RULE = `## What is not a finding

Report a real conflict a reader could act on wrongly. These are not that:

- Prose variety. English uses different words for the same thing constantly.
  Two spellings of a concept only matter when the text DEFINES or COMMANDS with
  both, and a reader could take them for different things.
- Different levels of detail. A summary saying less than a reference is correct.
- Text that is supposed to disagree: historical notes, deliberate anti-pattern
  examples, quoted third-party material. Most of it has already been withheld
  from you; if you see some anyway, skip it.
- Anything you would have to leave these documents to check.

A short list of real findings beats a long list you padded. Returning zero
findings is a legitimate, useful answer.`;

function outputContract(findingsPath: string): string {
  return `## Output contract -- write ONE file, then one line

Your findings are a FILE, not prose. Prose you print is not read by anything.
Before your final message write EXACTLY this file:

${findingsPath}

with EXACTLY this JSON shape:

{
  "findings": [
    {
      "kind": "contradiction" | "term-collision" | "term-split" | "numeric-conflict",
      "title": "<one line naming the conflict>",
      "summary": "<2-3 sentences: what disagrees, and why a reader would be misled>",
      "sides": [
        { "label": "<short label>", "quote": "<VERBATIM text>", "note": "<optional>" }
      ],
      "options": [
        {
          "label": "<what this option does>",
          "edits": [{ "quote": "<VERBATIM text to change>", "replacement": "<optional exact new text>" }],
          "consequence": "<how many edits, and what else it drags along>"
        }
      ]
    }
  ]
}

Rules the harness enforces, so getting them wrong loses the finding:
- Every "quote" must resolve verbatim in the text you were given.
- "sides" needs at least one entry; a contradiction needs two.
- "options" needs at least two entries, each with at least one edit.
- No severity, no confidence, no priority fields. Those are computed from your
  facts, not asserted by you.

If you found nothing, write {"findings": []}. That is a real answer.

You may add "severityOverride": {"direction": "up"|"down", "reason": "<one line>"}
to a single finding when the mechanical score cannot see the stakes -- an
innocuous-looking value that would break something badly, or a scary-looking one
that is cosmetic. It moves the band by one step and your reason is printed.

After writing the file, make your final message exactly:
findings written`;
}

// -- the spawn stub ---------------------------------------------------------------

// What the ORCHESTRATOR passes to a seat: a pointer, never the brief itself.
//
// The brief contains the shard text, the clusters, or the finding under attack.
// An orchestrator that reads it to pass it along has read the documents, which
// is exactly what the blinding contract withholds -- and it then summarizes the
// review from a context polluted by the material. The seat reads its own
// instructions off disk; this is all the orchestrator ever holds.
export function spawnStub(briefPath: string, finalLine: string): string {
  return `You are one seat in a document-integrity review. Your complete, self-contained instructions are in this file:

${briefPath}

Read that file and follow it EXACTLY.

- The brief is your ONLY source of material. Do not read any other file, do not
  search the web, and do not use anything you happen to know about the subject
  matter. Everything you need is in the brief.
- Write the output file(s) it names, at the exact absolute paths it gives, in
  the exact JSON shape it specifies.
- Every quote you emit must be copied character-for-character from text in the
  brief. A paraphrase resolves to nothing and the finding is discarded.

When you are done, your final message must be exactly:
${finalLine}`;
}

export const FINDINGS_FINAL_LINE = "findings written";
export const VERDICT_FINAL_LINE = "verdict written";

// -- discovery briefs ---------------------------------------------------------------

export interface ShardBriefInput {
  bundle: Bundle;
  shard: Shard;
  shardText: string;
  findingsPath: string;
  claimsPath: string;
}

// The shard seat has two jobs, and the second one is the reason cross-shard
// contradictions are findable at all: a compact ledger of what this stretch of
// text CLAIMS, which a later agent reads in place of the text itself.
export function shardBrief(input: ShardBriefInput): string {
  return `You are reviewing one stretch of a document set for internal contradictions.

${SCOPE_RULE}

${QUOTE_RULE}

${OPTION_RULE}

${FALSE_POSITIVE_RULE}

## Your first job: contradictions inside this stretch

Read the text below and find places where it contradicts itself -- an
instruction that conflicts with another instruction, a stated fact that
conflicts with another stated fact, a term used two ways.

## Your second job: the claim ledger

Contradictions whose two halves sit far apart cannot be seen from here. So you
also record what this stretch CLAIMS, and a later pass compares those records
across the whole set.

Write ${input.claimsPath} with EXACTLY this shape:

{
  "claims": [
    { "subject": "<2-4 words: what the claim is about>",
      "assertion": "<one short sentence in your own words>",
      "quote": "<VERBATIM source text>" }
  ]
}

Record every claim a reader could ACT on or be MISLED by: requirements,
defaults, limits, orderings, prohibitions, guarantees, stated behaviors. Skip
narration, motivation, and history. Aim for one claim per real assertion --
typically 10 to 40 for a stretch this size. The "quote" must resolve verbatim,
same rule as everywhere else.

${outputContract(input.findingsPath)}

Write BOTH files. Then the one-line final message.

===== THE TEXT (${input.shard.id}, ${input.shard.lines} lines) =====

${input.shardText}`;
}

function renderSites(sites: Site[], cap = 40): string {
  const shown = sites.slice(0, cap);
  const lines = shown.map((s) => `- ${s.docId} ${s.relPath}:${s.line} | ${s.context}`);
  if (sites.length > cap) lines.push(`- ... and ${sites.length - cap} more occurrences`);
  return lines.join("\n");
}

export function termBrief(clusters: Cluster<TermMeta>[], findingsPath: string): string {
  const body = clusters
    .map(
      (c, i) =>
        `### Cluster ${i + 1}: "${c.key}"\nSpellings seen: ${c.meta.surfaces.map((s) => `"${s}"`).join(", ")}\n\n${renderSites(c.sites)}`
    )
    .join("\n\n");

  return `You are checking one document set for terminology drift, across every document at once.

${SCOPE_RULE}

${QUOTE_RULE}

${OPTION_RULE}

## What you are looking for

Each cluster below is a term the harness found used in more than one place, in
at least one context that DEFINES it or COMMANDS with it. Two failure modes:

- **term-collision** -- one term, two meanings. The dangerous one: a reader
  carries the meaning from one section into another where it is wrong.
- **term-split** -- two terms, one meaning. A reader thinks they are two things,
  or searches for one name and misses half the documentation.

${FALSE_POSITIVE_RULE}

Most clusters below are NOT findings. They are candidates the harness could not
rule out mechanically. Expect to discard the large majority, and say nothing
about the ones you discard.

${outputContract(findingsPath)}

===== TERM CLUSTERS (${clusters.length}) =====

${body}`;
}

export function numericBrief(clusters: Cluster<NumericMeta>[], findingsPath: string): string {
  const body = clusters
    .map(
      (c, i) =>
        `### Cluster ${i + 1}: ${c.meta.kind} for "${c.meta.subject}"\nValues seen: ${c.meta.values.join(", ")}\n\n${renderSites(c.sites)}`
    )
    .join("\n\n");

  return `You are checking one document set for conflicting numbers, across every document at once.

${SCOPE_RULE}

${QUOTE_RULE}

${OPTION_RULE}

## What you are looking for

Each cluster is one subject carrying more than one value. The harness has
already discarded agreement and unit-only differences ("60s" and "1m" are the
same number). What it cannot decide is whether the remaining differences are
CONFLICTS or legitimately different things that happen to share a subject
phrase.

Genuinely different things that are not findings: a default versus a maximum, a
free-tier limit versus a paid one, a value that differs by platform or
environment, a per-request value versus a per-day one. If the surrounding text
scopes the two values differently, they do not conflict.

Note that code samples ARE included here, deliberately: a config sample showing
one value while the prose states another is one of the most common real defects
in a document set, and it is a finding.

${FALSE_POSITIVE_RULE}

${outputContract(findingsPath)}

===== NUMERIC CLUSTERS (${clusters.length}) =====

${body}`;
}

export function directiveBrief(clusters: Cluster<DirectiveMeta>[], findingsPath: string): string {
  const body = clusters
    .map(
      (c, i) =>
        `### Cluster ${i + 1}: instructions about "${c.meta.subject}"\nDirections seen: ${c.meta.polarities.join(", ")} | Strengths seen: ${c.meta.strengths.join(", ")}\n\n${renderSites(c.sites)}`
    )
    .join("\n\n");

  return `You are checking one document set for conflicting instructions, across every document at once.

${SCOPE_RULE}

${QUOTE_RULE}

${OPTION_RULE}

## What you are looking for

Each cluster is a set of instructions the harness found about the same action,
where the instructions disagree either in DIRECTION (do it / never do it) or in
STRENGTH (must / should / may). Both matter: a reader who is told "must" in one
place and "may" in another does not know whether they can skip it.

Not findings: instructions that apply under different conditions and say so
("must in production, may in development"), a general rule and its stated
exception, or the same instruction phrased twice.

${FALSE_POSITIVE_RULE}

${outputContract(findingsPath)}

===== DIRECTIVE CLUSTERS (${clusters.length}) =====

${body}`;
}

// -- the cross-shard reduce brief -------------------------------------------------

export interface ClaimRecord {
  shardId: string;
  subject: string;
  assertion: string;
  quote: string;
}

// The pass that catches contradictions sharing no vocabulary -- "deploy on
// Fridays is fine" against "never ship at end of week". Neither the term nor
// the numeric inventory can join those; two one-line claims side by side can.
export function reduceBrief(claims: ClaimRecord[], findingsPath: string): string {
  const body = claims
    .map((c, i) => `${String(i + 1).padStart(3)}. [${c.shardId}] (${c.subject}) ${c.assertion}\n     quote: ${c.quote}`)
    .join("\n");

  return `You are comparing claims collected from every part of a document set, looking for pairs that cannot both be true.

${SCOPE_RULE}

${QUOTE_RULE}

${OPTION_RULE}

## What you are looking for

Below is one line per claim, gathered from across the whole document set by
readers who each saw only their own stretch. Your job is the comparison none of
them could make: find pairs, or small groups, that CONTRADICT each other.

The valuable finds here are the ones that share no vocabulary. "Anyone in the
support group can archive a ticket" and "only an administrator may remove
customer records" are in opposition -- if a ticket is a customer record, the
first grants what the second withholds -- and they have almost no word in
common. No mechanical index can join a pair like that, which is why you are
reading this list rather than a keyword report.

Work by meaning, not by string overlap. Claims about the same subject with
different wording are exactly the target.

## Verify before you report

The one-line assertions are another reader's paraphrase and may be wrong or
lossy. Before reporting a pair, look at both \`quote\` values: the contradiction
must be visible in the QUOTED SOURCE TEXT, not only in the paraphrase. Use the
quotes, verbatim, as your finding's sides.

${FALSE_POSITIVE_RULE}

${outputContract(findingsPath)}

===== CLAIMS (${claims.length}) =====

${body}`;
}

// -- refutation ---------------------------------------------------------------------

export interface RefuteBriefInput {
  findingTitle: string;
  findingSummary: string;
  kind: string;
  sides: { label: string; quote: string; context: string }[];
  verdictPath: string;
  verdictBlock: string;
}

// The refuter is adversarial by construction: its job is to KILL the finding,
// and its default on uncertainty is REFUTED. That asymmetry is deliberate --
// discovery is already biased toward finding things, so the counterweight has
// to lean the other way to be worth anything.
export function refuteBrief(input: RefuteBriefInput): string {
  const sides = input.sides
    .map((s) => `### ${s.label}\n\nQuoted: ${JSON.stringify(s.quote)}\n\nSurrounding text:\n\n${s.context}`)
    .join("\n\n");

  return `Your job is to REFUTE the claim below. You are not reviewing it; you are trying to kill it.

Someone reported that a document set contradicts itself. They may be wrong.
Assume they are wrong and look for the reason.

${SCOPE_RULE}

## The claim under attack

**${input.findingTitle}**
Kind: ${input.kind}

${input.findingSummary}

${sides}

## How to kill it

Any ONE of these means the claim is refuted:

- The two passages are not actually incompatible -- they are scoped to different
  situations, different audiences, different environments, or different times,
  whether or not the text says so plainly nearby.
- One passage is illustrative, historical, or hypothetical rather than a
  statement of current fact.
- The wording only looks contradictory: the same word is doing different
  grammatical work, or the apparent conflict is a summary against a detail.
- A reader following either passage would not be harmed or misled, because they
  cannot reach both, or because the difference does not change what they do.
- The quoted text does not say what the claim says it says.

## Your default is REFUTED

If you cannot see a clear, concrete way a reader is misled, return REFUTED. An
uncertain finding is not a finding. UPHELD means you tried the lines of attack
above, none worked, and you can state in one sentence exactly how a reader gets
hurt.

CONFUSED means you could not evaluate it at all -- not "I am unsure". Unsure is
REFUTED.

${input.verdictBlock}`;
}

export { QUOTE_RULE, OPTION_RULE, SCOPE_RULE, FALSE_POSITIVE_RULE, outputContract };

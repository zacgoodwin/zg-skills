// The comment loop: turning a human's notes back into a new round.
//
// Regeneration is TARGETED. A round with four comments costs four small agents,
// not a re-run of the whole fan-out, because only the commented findings are in
// question -- everything the human already settled carries forward with its
// answer filled in, and everything they never mentioned stays exactly as it was.
//
// The one rule that keeps the loop honest: a carried-forward answer is only
// valid while the question is unchanged. If a comment adds a third way out or
// removes one, the old pick is dropped and the finding asks again, saying why.
import { type Bundle, contextWindow, docById } from "./bundle.ts";
import {
  type Finding,
  type RawFinding,
  fingerprintOf,
  normalizeWhitespace,
} from "./findings.ts";
import { type CarriedDecision, type PlanFile, type PlanStatus } from "./plan.ts";
import { FALSE_POSITIVE_RULE, OPTION_RULE, QUOTE_RULE, SCOPE_RULE, outputContract } from "./prompts.ts";

// Stop rather than loop. Five rounds is far more conversation than a document
// review should need; hitting the cap means something is wrong with the
// findings, the comments, or both, and the human should see that plainly.
export const MAX_ROUNDS = 5;

export const CONTEXT_WINDOW = 12;

// -- the targeted brief ---------------------------------------------------------

export interface RegenBriefInput {
  finding: Finding;
  comment: string;
  globalComment: string;
  bundle: Bundle;
  findingsPath: string;
}

function siteContext(bundle: Bundle, f: Finding): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const side of f.sides) {
    for (const inst of side.instances) {
      const key = `${inst.docId}:${inst.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(`--- ${inst.relPath}:${inst.line} ---\n${contextWindow(docById(bundle, inst.docId), inst.line, CONTEXT_WINDOW)}`);
    }
  }
  return blocks.join("\n\n");
}

export function regenBrief(input: RegenBriefInput): string {
  const f = input.finding;
  const options = f.options.map((o) => `- **${o.id} · ${o.label}** — ${o.consequence}`).join("\n");
  const global =
    input.globalComment.trim() === ""
      ? ""
      : `\n## A standing instruction for this whole review\n\nThe reader also left this note, which applies to every finding including this one:\n\n${input.globalComment.trim()}\n`;

  return `A reader reviewed a finding from a document-integrity review and left a comment on it. Your job is to act on that comment.

${SCOPE_RULE}

${QUOTE_RULE}

${OPTION_RULE}

## The finding as it stands

**${f.title}**
Kind: ${f.kind}

${f.summary}

Sides:
${f.sides.map((s) => `- ${s.label}: ${JSON.stringify(s.quote)} at ${s.instances.map((i) => `${i.relPath}:${i.line}`).join(", ")}`).join("\n")}

Options currently offered:
${options}

## The reader's comment

${input.comment.trim()}
${global}
## What to do with it

Read the comment for what it is actually asking, then return one of:

- **The finding, corrected.** The reader disputed the framing, the summary, or
  an option's consequence. Return the finding with that fixed. Keep the same
  sides if the sides were not what they questioned.
- **The finding, with different options.** The reader wants a way out you did
  not offer, or thinks one you offered is wrong. Return it with the option list
  they need. Adding or removing an option is expected here.
- **Nothing.** The reader has convinced you it is not a real finding. Return
  {"findings": []}. That is a complete, correct answer and the finding is
  dropped with the comment recorded as the reason.
- **More findings.** The comment pointed at something you missed -- "the same
  problem is in section 5". Return the original finding (corrected or as-is,
  whichever the comment implies) PLUS the new ones. New findings follow every
  rule above, including verbatim quotes.

The reader is describing THEIR documents and knows things the text does not say.
When the comment asserts a fact about intent or scope, take it as true. When it
asks a question, answer it by changing the finding, not by arguing in prose --
nothing you write outside the file is read.

${FALSE_POSITIVE_RULE}

${outputContract(input.findingsPath)}

## The text around each site

${siteContext(input.bundle, f)}`;
}

// -- carry-forward ----------------------------------------------------------------

// Two findings are the same question when they have the same identity AND the
// same ways out. A comment that changed the options changed the question.
export function optionsMatch(a: Finding, b: Finding): boolean {
  if (a.options.length !== b.options.length) return false;
  const key = (f: Finding) =>
    f.options
      .map((o) => `${o.id}|${normalizeWhitespace(o.label).toLowerCase()}|${o.editSites.map((e) => `${e.docId}:${e.line}`).sort().join(",")}`)
      .join(" ;; ");
  return key(a) === key(b);
}

export interface CarryForward {
  carried: Record<string, CarriedDecision>;
  reopened: { fingerprint: string; title: string; reason: string }[];
}

// Everything the human already answered, keyed by fingerprint so it survives
// the renumbering that happens when findings are added or dropped.
export function carryForward(
  prior: PlanFile,
  status: PlanStatus,
  next: Finding[],
  round: number
): CarryForward {
  const priorById = new Map(prior.findings.map((f) => [f.id, f]));
  const nextByFingerprint = new Map(next.map((f) => [f.fingerprint, f]));
  const carried: Record<string, CarriedDecision> = {};
  const reopened: CarryForward["reopened"] = [];

  // Answers from rounds before this one stay in force unless re-answered.
  for (const [fp, decision] of Object.entries(prior.carried ?? {})) {
    if (nextByFingerprint.has(fp)) carried[fp] = decision;
  }

  const settle = (id: string, decision: CarriedDecision) => {
    const before = priorById.get(id);
    if (!before) return;
    const after = nextByFingerprint.get(before.fingerprint);
    if (!after) return; // the finding is gone; the answer goes with it
    if (decision.disposition === "option" && !optionsMatch(before, after)) {
      reopened.push({
        fingerprint: before.fingerprint,
        title: after.title,
        reason: `the options changed since you chose ${decision.optionId}, so this needs answering again`,
      });
      return;
    }
    carried[before.fingerprint] = decision;
  };

  for (const r of status.resolved) settle(r.id, { disposition: "option", optionId: r.optionId, round });
  for (const id of status.declined) settle(id, { disposition: "change-nothing", round });

  return { carried, reopened };
}

// -- assembling the next round -------------------------------------------------------

export interface RegenBatch {
  seat: string;
  findings: RawFinding[];
}

export interface NextRoundInput {
  prior: PlanFile;
  status: PlanStatus;
  regenerated: { findingId: string; findings: RawFinding[] }[];
}

// Findings the human never commented on are not re-derived: re-running a lens
// over untouched text to get the same answer costs money and risks a different
// one. They are carried across verbatim, and only the commented ones are
// replaced by whatever their targeted agent returned.
export function assembleNextRound(input: NextRoundInput): {
  untouched: Finding[];
  replacements: RegenBatch[];
  dropped: { title: string; reason: string }[];
} {
  const commented = new Set(input.status.comments.map((c) => c.id));
  const untouched = input.prior.findings.filter((f) => !commented.has(f.id));
  const replacements: RegenBatch[] = [];
  const dropped: { title: string; reason: string }[] = [];

  for (const r of input.regenerated) {
    const before = input.prior.findings.find((f) => f.id === r.findingId);
    if (r.findings.length === 0) {
      dropped.push({
        title: before?.title ?? r.findingId,
        reason: input.status.comments.find((c) => c.id === r.findingId)?.text ?? "withdrawn after review",
      });
      continue;
    }
    replacements.push({ seat: `regen:${r.findingId}`, findings: r.findings });
  }
  return { untouched, replacements, dropped };
}

// A finding carried across rounds unchanged keeps its identity; this is the
// check that a regeneration did not quietly renumber the world.
export function sameFinding(a: Finding, b: Finding): boolean {
  return a.fingerprint === b.fingerprint;
}

export function fingerprintOfFinding(f: Pick<Finding, "kind" | "sides">): string {
  return fingerprintOf(f.kind, f.sides.map((s) => s.quote));
}

// The findings core: what an agent may claim, how a claim becomes a citation,
// and the two ranking functions.
//
// The load-bearing rule of this whole skill lives here. Agents NEVER count
// lines -- they emit verbatim quotes, and code resolves each quote to every
// place it occurs. That makes a hallucinated citation impossible rather than
// unlikely: a quote that resolves nowhere is dropped to the Unverifiable
// appendix, and a quote occurring three times yields three cited instances
// without anyone having to notice the other two.
//
// Severity and confidence are computed HERE, from facts agents supply, never
// assigned by an agent. That keeps them comparable between seats and stable
// across regeneration rounds -- a finding's numbers only move when its facts do.
import { createHash } from "node:crypto";
import { type Bundle, type Doc, docById, enclosingHeading } from "./bundle.ts";
import { ZError } from "./cli.ts";
import { DIRECTIVE_RE } from "./inventory.ts";

export const FINDINGS_SCHEMA_VERSION = 1;

export const FINDING_KINDS = [
  "contradiction", // two passages give incompatible instructions or facts
  "term-collision", // one term, two meanings
  "term-split", // two terms, one meaning
  "numeric-conflict", // same subject, different values
  "structure", // dangling reference, TOC drift, duplicate heading
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

// -- what an agent emits (untrusted) ---------------------------------------------

// `atLine` narrows a quote to one occurrence. It exists for the structure lens,
// which computes exact lines in code and would otherwise be unable to tell two
// identical headings apart -- quote resolution alone maps both to both. It is
// deliberately absent from the agent-facing output contract: a model reporting
// a line number is the failure this whole design removes, and a lens that
// derived the line arithmetically is not doing that.
export interface RawSide {
  label: string;
  quote: string;
  note?: string;
  atLine?: number;
}

export interface RawEdit {
  quote: string; // must already exist in a document
  replacement?: string; // absent means "rewrite in place", spelled out in consequence
  atLine?: number;
}

export interface RawOption {
  label: string;
  edits: RawEdit[];
  consequence: string;
}

export interface RawFinding {
  kind: FindingKind;
  title: string;
  summary: string;
  sides: RawSide[];
  options: RawOption[];
  // An agent may argue severity one band either way when the mechanical factors
  // cannot see the stakes. Capped at one band so severity cannot float.
  severityOverride?: { direction: "up" | "down"; reason: string };
}

// -- resolved shapes --------------------------------------------------------------

export type MatchQuality = "exact" | "normalized";

export interface Instance {
  docId: string;
  relPath: string;
  line: number;
  quote: string;
  quality: MatchQuality;
}

export interface ResolvedSide {
  label: string;
  quote: string;
  note?: string;
  instances: Instance[];
}

export interface ResolvedOption {
  id: string; // A, B, C ... in the order the sites appear
  label: string;
  consequence: string;
  editSites: Instance[];
  replacements: (string | undefined)[]; // parallel to editSites
}

export type SeverityBand = "high" | "medium" | "low";

export interface SeverityFactors {
  modality: 1 | 2 | 3;
  detectability: 1 | 2 | 3;
  blast: 0 | 1 | 2;
  hazard: 0 | 2;
}

export interface Severity {
  score: number;
  band: SeverityBand;
  factors: SeverityFactors;
  override?: { direction: "up" | "down"; reason: string; from: SeverityBand };
}

export type RefutationOutcome =
  | "unrefuted"
  | "all-upheld"
  | "majority-upheld"
  | "split"
  | "majority-refuted"
  | "all-refuted";

export interface Confidence {
  base: number;
  delta: number;
  score: number;
  outcome: RefutationOutcome;
  upheld: number;
  refuted: number;
  confused: number;
}

export interface Finding {
  id: string; // F-01, assigned at render time
  kind: FindingKind;
  title: string;
  summary: string;
  sides: ResolvedSide[];
  options: ResolvedOption[];
  severity: Severity;
  confidence: Confidence;
  seats: string[]; // which discovery seats produced it, deduped
  fingerprint: string;
  // Produced by code reading the document graph, not by a model reading prose.
  // A duplicate heading either exists or it does not; there is no claim to
  // attack, so these never go to refuters. The eval caught why this matters:
  // three refuters killed a verifiable duplicate-heading fact, evidently by
  // arguing it did not matter -- which is a severity judgment, and severity is
  // computed elsewhere.
  deterministic?: boolean;
}

// A claim that could not be grounded. Kept and shown -- never deleted, because
// "the agent said something we could not verify" is information.
export interface Unverifiable {
  kind: FindingKind;
  title: string;
  seat: string;
  reason: string;
}

// -- quote resolution ---------------------------------------------------------------

// Collapsing whitespace is the only normalization allowed. Anything looser
// (case, punctuation, stemming) would let a paraphrase pass as a citation,
// which is the exact failure this function exists to prevent.
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface NormIndex {
  text: string;
  lineOf: number[]; // char offset -> 1-based source line
}

const normCache = new WeakMap<Doc, NormIndex>();

function normIndex(doc: Doc): NormIndex {
  const cached = normCache.get(doc);
  if (cached) return cached;
  let text = "";
  const lineOf: number[] = [];
  for (let ln = 1; ln <= doc.lines.length; ln++) {
    const collapsed = normalizeWhitespace(doc.lines[ln - 1]);
    if (collapsed === "") continue;
    if (text !== "") {
      text += " ";
      lineOf.push(ln);
    }
    for (let i = 0; i < collapsed.length; i++) lineOf.push(ln);
    text += collapsed;
  }
  const idx = { text, lineOf };
  normCache.set(doc, idx);
  return idx;
}

// Every place a quote occurs, across every document, in document order. An
// empty result is the caller's signal that the agent paraphrased.
export function resolveQuote(bundle: Bundle, quote: string): Instance[] {
  const trimmed = quote.trim();
  if (trimmed === "") throw new ZError(`resolveQuote: empty quote.`);
  const out: Instance[] = [];

  // Pass 1: verbatim inside a single source line. The overwhelmingly common
  // case, and the only one that earns the confidence bonus.
  for (const doc of bundle.docs) {
    for (let ln = 1; ln <= doc.lines.length; ln++) {
      if (doc.lines[ln - 1].includes(trimmed)) {
        out.push({ docId: doc.id, relPath: doc.relPath, line: ln, quote: trimmed, quality: "exact" });
      }
    }
  }
  if (out.length > 0) return out;

  // Pass 2: whitespace-normalized, which also covers a quote spanning a line
  // wrap. Reported as a weaker match so confidence can price it.
  const needle = normalizeWhitespace(trimmed);
  if (needle === "") return out;
  for (const doc of bundle.docs) {
    const { text, lineOf } = normIndex(doc);
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      const line = lineOf[at];
      if (line !== undefined && !out.some((i) => i.docId === doc.id && i.line === line)) {
        out.push({ docId: doc.id, relPath: doc.relPath, line, quote: trimmed, quality: "normalized" });
      }
      from = at + 1;
    }
  }
  return out;
}

// -- severity -----------------------------------------------------------------------

// Consequence of acting on the wrong passage. Deliberately a short, auditable
// list rather than a model's judgment.
export const HAZARD_RE =
  /\b(delete[sd]?|deleting|drop(?:s|ped|ping)?|rm\b|truncate|purge|wipe|destroy|force|--force|overwrite|production|prod\b|credential|secret|password|token|api[\s-]?key|private[\s-]?key|migration|migrate|irreversible|permanent|billing|payment|charge|invoice|auth(?:entication|orization)?|permission|privilege|sudo|root)\b/i;

// Sections a reader hits first, where a wrong instruction does the most damage.
export const ENTRY_HEADING_RE =
  /\b(quick\s?start|getting\s+started|install(?:ation)?|setup|set\s+up|first\s+steps?|overview|introduction|tl;?dr)\b/i;

export const SEVERITY_BANDS = { high: 8, medium: 4 } as const;

export function bandFor(score: number): SeverityBand {
  return score >= SEVERITY_BANDS.high ? "high" : score >= SEVERITY_BANDS.medium ? "medium" : "low";
}

function shiftBand(band: SeverityBand, direction: "up" | "down"): SeverityBand {
  const order: SeverityBand[] = ["low", "medium", "high"];
  const i = order.indexOf(band);
  return order[Math.min(order.length - 1, Math.max(0, i + (direction === "up" ? 1 : -1)))];
}

// Does a reader ACT on this text, or merely learn from it? A wrong instruction
// costs more than a wrong fact.
function modalityOf(bundle: Bundle, sides: ResolvedSide[]): 1 | 2 | 3 {
  const directive = sides.map((s) =>
    s.instances.some((i) => {
      const doc = docById(bundle, i.docId);
      return DIRECTIVE_RE.test(doc.lines[i.line - 1] ?? "") || DIRECTIVE_RE.test(s.quote);
    })
  );
  const count = directive.filter(Boolean).length;
  if (count === 0) return 1;
  return count === directive.length && directive.length >= 2 ? 3 : 2;
}

// Can a reader see both sides at once? Distance is what turns a contradiction
// from embarrassing into dangerous: cross-document, they follow one and never
// learn the other exists.
function detectabilityOf(bundle: Bundle, sides: ResolvedSide[]): 1 | 2 | 3 {
  const all = sides.flatMap((s) => s.instances);
  if (all.length === 0) return 1;
  if (new Set(all.map((i) => i.docId)).size > 1) return 3;
  const doc = docById(bundle, all[0].docId);
  const sections = new Set(all.map((i) => enclosingHeading(doc, i.line)?.line ?? 0));
  return sections.size > 1 ? 2 : 1;
}

function blastOf(bundle: Bundle, sides: ResolvedSide[]): 0 | 1 | 2 {
  const all = sides.flatMap((s) => s.instances);
  const inEntrySection = all.some((i) => {
    const h = enclosingHeading(docById(bundle, i.docId), i.line);
    return h !== null && ENTRY_HEADING_RE.test(h.text);
  });
  if (all.length >= 4 || inEntrySection) return 2;
  return all.length >= 2 ? 1 : 0;
}

function hazardOf(bundle: Bundle, sides: ResolvedSide[]): 0 | 2 {
  const hit = sides.some(
    (s) =>
      HAZARD_RE.test(s.quote) ||
      s.instances.some((i) => HAZARD_RE.test(docById(bundle, i.docId).lines[i.line - 1] ?? ""))
  );
  return hit ? 2 : 0;
}

// severity = (modality x detectability) + blast + hazard, banded high >= 8,
// medium 4-7, low <= 3. The first two multiply because they compound: an
// instruction you will follow wrongly AND cannot see is the failure this skill
// exists for.
export function scoreSeverity(
  bundle: Bundle,
  sides: ResolvedSide[],
  override?: RawFinding["severityOverride"]
): Severity {
  const factors: SeverityFactors = {
    modality: modalityOf(bundle, sides),
    detectability: detectabilityOf(bundle, sides),
    blast: blastOf(bundle, sides),
    hazard: hazardOf(bundle, sides),
  };
  const score = factors.modality * factors.detectability + factors.blast + factors.hazard;
  const mechanical = bandFor(score);
  if (!override) return { score, band: mechanical, factors };
  const shifted = shiftBand(mechanical, override.direction);
  return {
    score,
    band: shifted,
    factors,
    override: { direction: override.direction, reason: override.reason, from: mechanical },
  };
}

// -- confidence ----------------------------------------------------------------------

export const CONFIDENCE_BASE_FLOOR = 30;
export const CONFIDENCE_PER_EXTRA_SEAT = 12;
export const CONFIDENCE_EXTRA_SEAT_CAP = 24;
export const CONFIDENCE_MULTI_VENDOR = 10;
export const CONFIDENCE_CLEAN_QUOTES = 6;

// Which vendor a discovery seat ran on. Two Claude seats agreeing is weaker
// evidence than Claude and codex agreeing, because correlated errors are the
// entire reason cross-provider seats exist.
export function seatVendor(seat: string): string {
  const head = seat.split(/[:\-]/)[0].toLowerCase();
  return head === "codex" || head === "agy" || head === "antigravity" ? (head === "antigravity" ? "agy" : head) : "claude";
}

export function confidenceBase(seats: string[], allExact: boolean): number {
  const unique = [...new Set(seats)];
  const extra = Math.min(CONFIDENCE_PER_EXTRA_SEAT * Math.max(0, unique.length - 1), CONFIDENCE_EXTRA_SEAT_CAP);
  const vendors = new Set(unique.map(seatVendor));
  return (
    CONFIDENCE_BASE_FLOOR +
    extra +
    (vendors.size > 1 ? CONFIDENCE_MULTI_VENDOR : 0) +
    (allExact ? CONFIDENCE_CLEAN_QUOTES : 0)
  );
}

export const REFUTATION_DELTA: Record<RefutationOutcome, number> = {
  unrefuted: 0,
  "all-upheld": 25,
  "majority-upheld": 10,
  split: -15,
  "majority-refuted": -35,
  "all-refuted": -60,
};

// CONFUSED counts as neither upheld nor refuted -- an adversary that could not
// reach a verdict has not defended the finding and has not killed it.
export function refutationOutcome(upheld: number, refuted: number): RefutationOutcome {
  const decided = upheld + refuted;
  if (decided === 0) return "unrefuted";
  if (refuted === 0) return decided >= 2 ? "all-upheld" : "majority-upheld";
  if (upheld === 0) return "all-refuted";
  if (upheld === refuted) return "split";
  return upheld > refuted ? "majority-upheld" : "majority-refuted";
}

export function scoreConfidence(
  seats: string[],
  allExact: boolean,
  quorum: { upheld: number; refuted: number; confused: number } = { upheld: 0, refuted: 0, confused: 0 }
): Confidence {
  const base = confidenceBase(seats, allExact);
  const outcome = refutationOutcome(quorum.upheld, quorum.refuted);
  const delta = REFUTATION_DELTA[outcome];
  return {
    base,
    delta,
    score: Math.max(0, Math.min(100, base + delta)),
    outcome,
    upheld: quorum.upheld,
    refuted: quorum.refuted,
    confused: quorum.confused,
  };
}

// A finding computed from the document graph is not a claim with a confidence;
// it is a fact. It still carries a number so the plan can sort and band
// uniformly, and that number says "verified in code" rather than "several
// models agreed".
export const CONFIDENCE_DETERMINISTIC = 95;

export function deterministicConfidence(): Confidence {
  return {
    base: CONFIDENCE_DETERMINISTIC,
    delta: 0,
    score: CONFIDENCE_DETERMINISTIC,
    outcome: "unrefuted",
    upheld: 0,
    refuted: 0,
    confused: 0,
  };
}

export const CONFIDENCE_APPENDIX_FLOOR = 40;

export type Placement = "main" | "low-confidence" | "refuted";

export function placementOf(f: Finding): Placement {
  if (f.confidence.outcome === "all-refuted" || f.confidence.outcome === "majority-refuted") return "refuted";
  return f.confidence.score < CONFIDENCE_APPENDIX_FLOOR ? "low-confidence" : "main";
}

// Adversaries go where the stakes are highest and the discovery evidence is
// thinnest. A finding three vendors already agree on is a poor use of a refuter.
export function refutationPriority(f: Finding): number {
  return f.severity.score * (100 - f.confidence.base);
}

// -- resolution and merging -------------------------------------------------------------

export interface Resolution {
  findings: Finding[];
  unverifiable: Unverifiable[];
}

// Two identities, for two different jobs. Collapsing them into one was a real
// bug, caught by the eval: three seats each quoted a slightly different span of
// the same two sentences, so one timeout conflict was reported three times --
// and because the copies never merged, every one of them showed the confidence
// of a single-seat finding when three independent seats had actually agreed.
//
// ACROSS ROUNDS, identity is the QUOTES. Lines move when documents are edited;
// quotes do not. This is what lets the decisions ledger suppress a finding the
// human already declined, after the text around it has shifted.
export function fingerprintOf(kind: FindingKind, quotes: string[]): string {
  const norm = [...new Set(quotes.map((q) => normalizeWhitespace(q).toLowerCase()))].sort();
  return createHash("sha256").update(`${kind} ${norm.join(" ")}`).digest("hex").slice(0, 16);
}

// WITHIN a round, identity is WHERE a finding points. Seats do not agree on how
// much of a sentence to quote and should not have to: what makes two reports
// the same report is that they indict the same places.
export function siteKeys(f: Pick<Finding, "sides">): Set<string> {
  return new Set(f.sides.flatMap((s) => s.instances.map((i) => `${i.docId}:${i.line}`)));
}

// A contradiction is identified by the PAIR of places that disagree, so sharing
// two sites means sharing the conflict. A finding that cites only one place --
// a duplicate heading, a dangling anchor -- is identified by that place.
export const SHARED_SITES_TO_MERGE = 2;

// Kind is NOT part of identity. Seats disagree about it constantly and the
// disagreement is not informative: in the eval one seat filed the API-key
// collision as `term-collision` and another as `contradiction`, and requiring
// the labels to match left the same defect in the plan twice with its
// confidence split between the copies.
//
// Accepted risk: two genuinely distinct defects at the same pair of lines -- a
// term collision AND a numeric conflict in one sentence -- merge into one. The
// merged finding keeps the richer option set, so the human still gets ways out,
// and the duplication this avoids was observed while that case is theoretical.
export function sameFindingAs(a: Pick<Finding, "kind" | "sides">, b: Pick<Finding, "kind" | "sides">): boolean {
  const x = siteKeys(a);
  const y = siteKeys(b);
  let shared = 0;
  for (const k of x) if (y.has(k)) shared++;
  if (shared === 0) return false;
  if (shared >= SHARED_SITES_TO_MERGE) return true;
  // The one-site shortcut needs BOTH to be one-site findings. A duplicate
  // heading must not be swallowed by a contradiction that merely quotes the
  // same line as one of its two sides.
  return x.size === 1 && y.size === 1;
}

// When merged findings disagree about kind, the most specific label wins.
// "contradiction" is the catch-all; every other kind tells the reader something
// the catch-all does not.
const KIND_SPECIFICITY: Record<FindingKind, number> = {
  structure: 4,
  "term-collision": 3,
  "term-split": 3,
  "numeric-conflict": 2,
  contradiction: 1,
};

export function mostSpecificKind(a: FindingKind, b: FindingKind): FindingKind {
  return KIND_SPECIFICITY[b] > KIND_SPECIFICITY[a] ? b : a;
}

// The seat name the structure lens files under. Findings from it are computed,
// not claimed.
export const DETERMINISTIC_SEATS = new Set(["structure-lens"]);

function resolveOne(bundle: Bundle, raw: RawFinding, seat: string): { finding: Omit<Finding, "id"> } | { reason: string } {
  if (!FINDING_KINDS.includes(raw.kind)) return { reason: `unknown kind ${JSON.stringify(raw.kind)}` };
  if (!Array.isArray(raw.sides) || raw.sides.length === 0) return { reason: `no sides` };
  if (!Array.isArray(raw.options) || raw.options.length === 0) return { reason: `no resolution options` };

  // A quote pinned to a line keeps only that occurrence. A pin that misses is a
  // bug in whatever produced it, not a narrowing to nothing.
  const pin = (instances: Instance[], atLine: number | undefined, what: string): Instance[] | { reason: string } => {
    if (atLine === undefined) return instances;
    const kept = instances.filter((i) => i.line === atLine);
    if (kept.length === 0) {
      return { reason: `${what} pinned to line ${atLine}, where its quote does not appear` };
    }
    return kept;
  };

  const sides: ResolvedSide[] = [];
  for (const s of raw.sides) {
    if (typeof s?.quote !== "string" || s.quote.trim() === "") return { reason: `a side has no quote` };
    const found = resolveQuote(bundle, s.quote);
    if (found.length === 0) {
      return { reason: `quote not found in any document: ${JSON.stringify(s.quote.slice(0, 80))}` };
    }
    const instances = pin(found, s.atLine, "a side");
    if ("reason" in instances) return instances;
    sides.push({ label: s.label ?? "", quote: s.quote.trim(), note: s.note, instances });
  }

  const options: ResolvedOption[] = [];
  for (let i = 0; i < raw.options.length; i++) {
    const o = raw.options[i];
    if (!Array.isArray(o?.edits) || o.edits.length === 0) {
      return { reason: `option ${i + 1} declares no edits; an option that changes nothing is "change nothing"` };
    }
    const editSites: Instance[] = [];
    const replacements: (string | undefined)[] = [];
    for (const e of o.edits) {
      if (typeof e?.quote !== "string" || e.quote.trim() === "") return { reason: `option ${i + 1} has an edit with no quote` };
      const found = resolveQuote(bundle, e.quote);
      if (found.length === 0) {
        return { reason: `option ${i + 1} edit quote not found: ${JSON.stringify(e.quote.slice(0, 80))}` };
      }
      const pinned = pin(found, e.atLine, `option ${i + 1}'s edit`);
      if ("reason" in pinned) return pinned;
      for (const f of pinned) {
        // The same site reached twice by one option is one edit, not two: an
        // option's declared edit count is what the apply gate checks against.
        if (editSites.some((s) => s.docId === f.docId && s.line === f.line)) continue;
        editSites.push(f);
        replacements.push(e.replacement);
      }
    }
    options.push({
      id: String.fromCharCode(65 + i),
      label: o.label ?? `Option ${String.fromCharCode(65 + i)}`,
      consequence: o.consequence ?? "",
      editSites,
      replacements,
    });
  }

  const allInstances = [...sides.flatMap((s) => s.instances), ...options.flatMap((o) => o.editSites)];
  const allExact = allInstances.every((i) => i.quality === "exact");

  const deterministic = DETERMINISTIC_SEATS.has(seat);
  return {
    finding: {
      kind: raw.kind,
      title: raw.title ?? "",
      summary: raw.summary ?? "",
      sides,
      options,
      severity: scoreSeverity(bundle, sides, raw.severityOverride),
      confidence: deterministic ? deterministicConfidence() : scoreConfidence([seat], allExact),
      seats: [seat],
      fingerprint: fingerprintOf(raw.kind, sides.map((s) => s.quote)),
      ...(deterministic ? { deterministic: true } : {}),
    },
  };
}

// Discovery seats produce overlapping findings by design -- that overlap IS the
// confidence signal. Merging keeps the richest variant and unions the seats.
export function resolveAndMerge(
  bundle: Bundle,
  batches: { seat: string; findings: RawFinding[] }[],
  declined: ReadonlySet<string> = new Set()
): Resolution {
  const merged: Omit<Finding, "id">[] = [];
  const unverifiable: Unverifiable[] = [];

  for (const batch of batches) {
    for (const raw of batch.findings) {
      let outcome: ReturnType<typeof resolveOne>;
      try {
        outcome = resolveOne(bundle, raw, batch.seat);
      } catch (e) {
        outcome = { reason: (e as Error).message };
      }
      if ("reason" in outcome) {
        unverifiable.push({
          kind: (raw?.kind ?? "contradiction") as FindingKind,
          title: raw?.title ?? "(untitled)",
          seat: batch.seat,
          reason: outcome.reason,
        });
        continue;
      }
      const f = outcome.finding;
      if (declined.has(f.fingerprint)) continue; // the human already said "change nothing"

      const at = merged.findIndex((prior) => sameFindingAs(prior, f));
      if (at === -1) {
        merged.push(f);
        continue;
      }
      const prior = merged[at];
      const seats = [...new Set([...prior.seats, ...f.seats])];
      // Keep whichever variant offers the human more ways out; on a tie, the one
      // that cites more places. Ties beyond that keep the first, so merge order
      // never changes the plan.
      const better =
        f.options.length !== prior.options.length
          ? f.options.length > prior.options.length
            ? f
            : prior
          : siteKeys(f).size > siteKeys(prior).size
            ? f
            : prior;
      const allExact = [...prior.sides, ...f.sides].every((s) => s.instances.every((i) => i.quality === "exact"));
      const kind = mostSpecificKind(prior.kind, f.kind);
      // A model agreeing with the structure lens does not make the fact less of
      // a fact, and does not turn it into a claim worth attacking.
      const deterministic = Boolean(prior.deterministic || f.deterministic);
      merged[at] = {
        ...better,
        kind,
        seats,
        deterministic: deterministic || undefined,
        confidence: deterministic ? deterministicConfidence() : scoreConfidence(seats, allExact),
        // The cross-round fingerprint follows the finding that actually shipped,
        // so a decision recorded against it matches on the next run.
        fingerprint: fingerprintOf(kind, better.sides.map((s) => s.quote)),
      };
    }
  }

  // Worst first: severity, then confidence, then a stable tiebreak.
  const findings = merged
    .sort(
      (a, b) =>
        b.severity.score - a.severity.score ||
        b.confidence.score - a.confidence.score ||
        a.fingerprint.localeCompare(b.fingerprint)
    )
    .map((f, i) => ({ ...f, id: `F-${String(i + 1).padStart(2, "0")}` }));

  return { findings, unverifiable };
}

// The deterministic pre-pass: four inventories over the whole bundle, built in
// code before any agent runs.
//
// This is what makes a 25k-line review affordable. Cross-document work happens
// HERE, on normalized tokens, and the agents downstream read the resulting
// CLUSTERS -- "this term appears at 14 sites, here are the 14 contexts" --
// rather than the full text. Structure findings come out of this file with no
// model involved at all.
//
// Inventories index only what their lens is allowed to see (lib/bundle.ts
// LENS_IGNORES), so a changelog's stale numbers never reach the numeric lens
// and a code fence's `#` never becomes a heading.
import { type Bundle, type Doc, type LensId, lensSeesLine, slugify } from "./bundle.ts";

// -- shared shapes ---------------------------------------------------------------

export interface Site {
  docId: string;
  relPath: string;
  line: number;
  context: string; // the trimmed source line, capped
}

const CONTEXT_CAP = 200;

function site(doc: Doc, line: number): Site {
  const raw = doc.lines[line - 1] ?? "";
  const trimmed = raw.trim();
  return {
    docId: doc.id,
    relPath: doc.relPath,
    line,
    context: trimmed.length > CONTEXT_CAP ? `${trimmed.slice(0, CONTEXT_CAP - 1)}…` : trimmed,
  };
}

// A cluster is what one agent reads: a normalized key plus every place it
// occurs. Small by construction, and cross-document by construction.
export interface Cluster<T = Record<string, unknown>> {
  key: string;
  sites: Site[];
  meta: T;
}

// Clusters spanning one document only are still worth showing -- a term used
// two ways inside one file is a real defect -- but ordering puts the
// cross-document ones first, because those are the ones a reader cannot see.
function byReach(a: Cluster<any>, b: Cluster<any>): number {
  const docs = (c: Cluster<any>) => new Set(c.sites.map((s) => s.docId)).size;
  return docs(b) - docs(a) || b.sites.length - a.sites.length || a.key.localeCompare(b.key);
}

function forEachVisibleLine(bundle: Bundle, lens: LensId, fn: (doc: Doc, line: number, text: string) => void): void {
  for (const doc of bundle.docs) {
    for (let ln = 1; ln <= doc.lines.length; ln++) {
      if (!lensSeesLine(doc, ln, lens)) continue;
      fn(doc, ln, doc.lines[ln - 1]);
    }
  }
}

// -- term inventory ---------------------------------------------------------------

// Terms worth tracking are multi-word noun phrases and distinctive single
// tokens -- not English. A stopword list beats a part-of-speech tagger here
// because the output only has to be a CANDIDATE list an agent then judges.
const STOPWORDS = new Set(
  ("a an and are as at be been but by can could do does for from had has have how i if in into is it its may might must " +
    "no not of on or should so such than that the their then there these they this those to use used using was we were " +
    "what when where which while who will with would you your all any each other some more most only own same too very " +
    "just also here about after before between during under over again once because both few many now off out up down " +
    "his her him she he them us our my me on'e it's don't")
    .split(/\s+/)
);

// Case, hyphenation, separator style and plurality are the four ways the same
// concept gets written differently. Collapsing them is exactly the "two words,
// one thing" detector.
export function normalizeTerm(raw: string): string {
  return raw
    // camelCase splits BEFORE lowercasing -- afterwards the boundary is gone.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-/.]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/(?:ies)$/, "y").replace(/(?:sses|shes|ches|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, "$1"))
    .join(" ");
}

// A surface form, and whether it appeared as code rather than prose. That
// distinction is the terminology lens's main noise filter: technical writing
// deliberately spells one thing two ways, `planMd` in a field list and "plan.md"
// in a sentence, and reporting that as drift buries the real findings.
interface Surface {
  text: string;
  code: boolean;
}

// camelCase must split BEFORE lowercasing, so do that first and keep the
// surface form for display.
function candidateTerms(text: string): Surface[] {
  const out: Surface[] = [];
  // Backticked identifiers and Capitalized/camel/snake tokens are the
  // distinctive singles worth tracking on their own.
  const codeSpans: [number, number][] = [];
  for (const m of text.matchAll(/`([^`]{2,60})`/g)) {
    out.push({ text: m[1], code: true });
    codeSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const inCode = (i: number) => codeSpans.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(/\b([a-z]+(?:[A-Z][a-z0-9]+)+|[A-Za-z][a-z0-9]*(?:[_-][A-Za-z0-9]+)+)\b/g)) {
    // A camelCase or snake_case token is an identifier whether or not someone
    // remembered the backticks.
    out.push({ text: m[1], code: true });
  }
  void inCode;

  // Multi-word phrases: runs of 2-4 non-stopword words. These carry most of the
  // real terminology.
  const words = text.match(/\b[\p{L}][\p{L}\p{N}'-]*\b/gu) ?? [];
  const keep = words.map((w) => (STOPWORDS.has(w.toLowerCase()) ? null : w));
  let run: string[] = [];
  for (const w of [...keep, null]) {
    if (w === null) {
      for (let n = 2; n <= 4 && n <= run.length; n++) {
        for (let i = 0; i + n <= run.length; i++) out.push({ text: run.slice(i, i + n).join(" "), code: false });
      }
      run = [];
    } else {
      run.push(w);
    }
  }
  return out;
}

export interface TermMeta {
  surfaces: string[]; // the distinct spellings seen, in first-seen order
  definitional: number; // sites that look like a definition or a directive
}

// A sentence that DEFINES carries the term's intended meaning; a passing
// mention does not. This is the terminology lens's main false-positive
// suppressor -- prose varies wording constantly and almost none of it matters.
//
// Deliberately NOT including modals. An earlier version counted any sentence
// containing "must" or "should" as definitional, which on real technical prose
// makes nearly every sentence qualify: running this skill on its own
// documentation produced sixty candidates, most of them phrases that merely
// shared a line with the word "must". A term used in a COMMAND is a directive
// signal, and the directive inventory already owns that.
const DEFINITIONAL_RE =
  /\b(is|are|was|were)\s+(?:a|an|the|not|one|two|any|every|always|never|only|exactly|simply|just|deliberately)?\s*\w|\b(means?|refers?\s+to|defined?\s+as|denotes?|represents?|consists?\s+of|comprises?|called|known\s+as|stands?\s+for)\b|:\s*$/i;

export const MIN_TERM_SITES = 2;

export function buildTermInventory(bundle: Bundle): Cluster<TermMeta>[] {
  const byKey = new Map<
    string,
    { sites: Site[]; surfaces: string[]; prose: Set<string>; definitional: number; seen: Set<string> }
  >();

  forEachVisibleLine(bundle, "terminology", (doc, line, text) => {
    const isDefinitional = DEFINITIONAL_RE.test(text);
    const perLine = new Set<string>();
    for (const surface of candidateTerms(text)) {
      const key = normalizeTerm(surface.text);
      if (key.length < 3 || /^\d+$/.test(key)) continue;
      if (key.split(" ").every((w) => STOPWORDS.has(w))) continue;
      if (perLine.has(key)) continue; // one line contributes one site per term
      perLine.add(key);

      let entry = byKey.get(key);
      if (!entry) {
        entry = { sites: [], surfaces: [], prose: new Set(), definitional: 0, seen: new Set() };
        byKey.set(key, entry);
      }
      entry.sites.push(site(doc, line));
      if (isDefinitional) entry.definitional++;
      const trimmed = surface.text.trim();
      if (!surface.code) entry.prose.add(trimmed.toLowerCase());
      if (!entry.seen.has(trimmed)) {
        entry.seen.add(trimmed);
        entry.surfaces.push(trimmed);
      }
    }
  });

  const clusters: Cluster<TermMeta>[] = [];
  for (const [key, e] of byKey) {
    if (e.sites.length < MIN_TERM_SITES) continue;
    // The bar is TWO DEFINITIONAL sites, and nothing else qualifies.
    //
    // The tempting second signal -- "this term is spelled more than one way" --
    // is not one. normalizeTerm collapses exactly case, hyphenation, separator
    // and plurality, so two surfaces sharing a key differ ONLY by those. That
    // is spelling inconsistency, which is the style lens this skill
    // deliberately does not have, and on real technical prose it produced ten
    // times more candidates than the definitional bar did.
    //
    // What survives is the term-COLLISION detector: a term that two or more
    // places take the trouble to define or command with, where an agent judges
    // whether those two meanings can both be true.
    if (e.definitional < 2) continue;
    clusters.push({ key, sites: e.sites, meta: { surfaces: e.surfaces, definitional: e.definitional } });
  }
  return clusters.sort(byReach);
}

// -- numeric and version inventory --------------------------------------------------

export type NumericKind = "duration" | "size" | "count" | "percent" | "version" | "date" | "port";

export interface NumericMeta {
  kind: NumericKind;
  subject: string; // the normalized words around the number: what it measures
  values: string[]; // the distinct values seen, in first-seen order
}

const DURATION_RE = /\b(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?|y|years?)\b/gi;
const SIZE_RE = /\b(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)\b/gi;
const PERCENT_RE = /\b(\d+(?:\.\d+)?)\s*%/g;
const SEMVER_RE = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/g;
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const PORT_RE = /\b(?:port|listen(?:ing)?\s+on|:)\s*(\d{2,5})\b/gi;

// Durations only compare meaningfully in one unit.
const DURATION_MS: Record<string, number> = {
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3,
  m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
  h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5,
  d: 864e5, day: 864e5, days: 864e5,
  w: 6048e5, week: 6048e5, weeks: 6048e5,
  month: 2592e6, months: 2592e6,
  y: 31536e6, year: 31536e6, years: 31536e6,
};

export function durationToMs(value: number, unit: string): number | null {
  const ms = DURATION_MS[unit.toLowerCase()];
  return ms === undefined ? null : value * ms;
}

const SIZE_BYTES: Record<string, number> = {
  b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4,
};

// What the number is ABOUT: the nearest meaningful words before it. This is the
// crude join key that groups "timeout is 30s" with "timeout: 60s" while keeping
// them apart from "retry after 30s".
//
// Two words, not three. Three makes the key too specific to join real pairs --
// "the request timeout is 30s" and "set the request timeout to 60s" differ only
// in a leading verb, and a 3-word window keeps that verb and splits the cluster.
export const SUBJECT_WORDS = 2;

// Verbs that merely connect a subject to its number. They must not consume a
// slot in a two-word window: "the free tier allows 100" has to key on "free
// tier", not "tier allows", or it joins with "the paid tier allows 1000" and
// reports a scope difference as a conflict.
const CONNECTIVE_RE =
  /^(?:allows?|allowed|permits?|equals?|defaults?|sets?|uses?|takes?|returns?|gives?|supports?|contains?|holds?|caps?|limits?|accepts?|expects?|requires?|costs?|spends?)$/i;

export function numericSubject(text: string, matchIndex: number): string {
  const before = text.slice(0, matchIndex);
  const words = (before.match(/\b[\p{L}][\p{L}\p{N}_-]*\b/gu) ?? [])
    .filter((w) => !STOPWORDS.has(w.toLowerCase()) && !CONNECTIVE_RE.test(w))
    .slice(-SUBJECT_WORDS);
  return normalizeTerm(words.join(" "));
}

interface RawNumeric {
  kind: NumericKind;
  value: string;
  comparable: number | null;
  subject: string;
  doc: Doc;
  line: number;
}

// A bare integer with a subject: "allows 100 requests" against "allows 200
// requests" is one of the most common real conflicts, and none of the typed
// patterns above sees it. Scanned last, and only over text no typed pattern
// already claimed, so "30s" never also counts as the number 30.
//
// Grouped forms come first in the alternation. Without that, "25,000" scans as
// the two numbers 25 and 000 and manufactures a conflict out of one value --
// found by running this skill on its own documentation.
const COUNT_RE = /\b(\d{1,3}(?:[,_]\d{3})+|\d{1,9})\b/g;
// A markdown list marker is not a quantity.
const LIST_MARKER_RE = /^\s*\d+[.)]\s/;
// Nor is a number in a heading: "## Step 3" is a label in a sequence, and a
// document with steps 0 through 5 is not six conflicting values.
function isHeadingLine(doc: Doc, line: number): boolean {
  return doc.headings.some((h) => h.line === line);
}

function scanNumerics(bundle: Bundle): RawNumeric[] {
  const out: RawNumeric[] = [];
  forEachVisibleLine(bundle, "numeric", (doc, line, text) => {
    const claimed: [number, number][] = [];
    const push = (kind: NumericKind, value: string, comparable: number | null, m: RegExpMatchArray) => {
      const index = m.index ?? 0;
      claimed.push([index, index + m[0].length]);
      out.push({ kind, value, comparable, subject: numericSubject(text, index), doc, line });
    };
    for (const m of text.matchAll(DURATION_RE)) push("duration", `${m[1]}${m[2]}`, durationToMs(Number(m[1]), m[2]), m);
    for (const m of text.matchAll(SIZE_RE)) push("size", `${m[1]}${m[2]}`, Number(m[1]) * (SIZE_BYTES[m[2].toLowerCase()] ?? NaN), m);
    for (const m of text.matchAll(PERCENT_RE)) push("percent", `${m[1]}%`, Number(m[1]), m);
    for (const m of text.matchAll(ISO_DATE_RE)) push("date", m[1], Date.parse(m[1]), m);
    for (const m of text.matchAll(PORT_RE)) push("port", m[1], Number(m[1]), m);
    for (const m of text.matchAll(SEMVER_RE)) {
      if (/\d{4}-\d{2}-\d{2}/.test(m[0])) continue; // already claimed as a date
      push("version", m[1], null, m);
    }

    if (isHeadingLine(doc, line)) return;
    const listOffset = LIST_MARKER_RE.exec(text)?.[0].length ?? 0;
    for (const m of text.matchAll(COUNT_RE)) {
      const start = m.index ?? 0;
      if (start < listOffset) continue;
      if (claimed.some(([a, b]) => start >= a && start < b)) continue;
      const digits = m[1].replace(/[,_]/g, "");
      out.push({ kind: "count", value: m[1], comparable: Number(digits), subject: numericSubject(text, start), doc, line });
    }
  });
  return out;
}

// Only clusters where the SAME subject carries DIFFERENT values are worth an
// agent's attention. Agreement is the common case and produces nothing.
export function buildNumericInventory(bundle: Bundle): Cluster<NumericMeta>[] {
  const byKey = new Map<string, RawNumeric[]>();
  for (const n of scanNumerics(bundle)) {
    if (n.subject === "") continue; // a bare number with no subject joins nothing
    const key = `${n.kind}:${n.subject}`;
    const list = byKey.get(key);
    if (list) list.push(n);
    else byKey.set(key, [n]);
  }

  const clusters: Cluster<NumericMeta>[] = [];
  for (const [key, group] of byKey) {
    const values: string[] = [];
    for (const g of group) if (!values.includes(g.value)) values.push(g.value);
    if (values.length < 2) continue;

    // Two values on ONE line are a range or a list ("medium 4-7", "capped at 3,
    // 10 when..."), not a conflict. A conflict needs two places that disagree,
    // and one sentence cannot disagree with itself.
    const sites = new Set(group.map((g) => `${g.doc.id}:${g.line}`));
    if (sites.size < 2) continue;

    // Same magnitude in different units ("60s" and "1m") is a spelling
    // difference, not a conflict.
    const comparables = group.map((g) => g.comparable);
    if (comparables.every((c) => c !== null && Number.isFinite(c))) {
      if (new Set(comparables as number[]).size < 2) continue;
    }
    clusters.push({
      key,
      sites: group.map((g) => site(g.doc, g.line)),
      meta: { kind: group[0].kind, subject: group[0].subject, values },
    });
  }
  return clusters.sort(byReach);
}

// -- directive inventory ------------------------------------------------------------

export interface DirectiveMeta {
  subject: string;
  polarities: ("positive" | "negative")[];
  strengths: ("must" | "should" | "may")[];
}

const NEGATIVE_RE = /\b(never|do\s+not|don'?t|must\s+not|should\s+not|shouldn'?t|cannot|can'?t|avoid|refuse|forbidden|prohibited|no\s+longer)\b/i;
const STRENGTH_RE = /\b(must|required|shall|always|never)\b|\b(should|recommended|prefer(?:red)?|avoid)\b|\b(may|optional|can)\b/i;
export const DIRECTIVE_RE =
  /\b(must(?:\s+not)?|shall(?:\s+not)?|should(?:\s+not)?|shouldn'?t|never|always|required|do\s+not|don'?t|cannot|can'?t|avoid|prohibited|forbidden|need\s+to|have\s+to)\b/i;

function directiveStrength(text: string): "must" | "should" | "may" {
  const m = STRENGTH_RE.exec(text);
  if (!m) return "should";
  return m[1] ? "must" : m[2] ? "should" : "may";
}

// The action a directive governs: the verb-ish words after the modal. Crude on
// purpose -- it is a join key for candidate pairing, and the agent decides
// whether two directives with the same key actually conflict.
// Modal and negation words carry the DIRECTION of an instruction, never its
// subject. They are dropped before the key is built, because the whole point is
// to join "you must run migrations" with "migrations must never run".
const MODAL_WORD_RE =
  /^(?:must|shall|should|shouldn't|shouldnt|never|always|not|no|do|don't|dont|does|cannot|can't|cant|can|avoid|prohibited|forbidden|required|require|requires|need|needs|have|has|may|might|will|would|please|ensure|make|sure)$/i;

// The two most salient content words of the sentence, SORTED.
//
// Sorted because word order carries no information here and costs matches: the
// same instruction appears as "run migrations before deploy" and "migrations
// must never run before a deploy", and an order-sensitive key splits them.
// Taken from the whole sentence rather than only after the modal, because
// English puts the subject on either side of it.
//
// Known limit: when the disagreement IS in the first two content words
// ("indent with tabs" against "indent with spaces"), no subject key can join
// them. That is what the claim ledger and the reduce pass exist for.
export function directiveSubject(text: string): string {
  const words = (text.match(/\b[\p{L}][\p{L}\p{N}_-]*\b/gu) ?? []).filter(
    (w) => !STOPWORDS.has(w.toLowerCase()) && !MODAL_WORD_RE.test(w)
  );
  return words
    .slice(0, SUBJECT_WORDS)
    .map((w) => normalizeTerm(w))
    .filter((w) => w !== "")
    .sort()
    .join(" ");
}

// Abbreviations whose trailing period is not a sentence end. Short list on
// purpose: a wrong split only costs the directive lens a little precision.
const ABBREV_RE = /\b(?:e\.g|i\.e|etc|vs|cf|approx|fig|no|vol|eq|al|dr|mr|ms|inc|ltd|jr|sr|st)$/i;

// Sentence splitting that does not trip over a version number or "e.g.".
// Written as a scan rather than a regex because the "digit on both sides"
// exception is not expressible as one pattern without the engine backtracking
// into a later start position and silently eating the front of the sentence.
export function splitSentences(text: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!".!?".includes(text[i])) continue;
    let j = i;
    while (j + 1 < text.length && ".!?".includes(text[j + 1])) j++;
    const prev = text[i - 1] ?? "";
    const next = text[j + 1];

    // A decimal point or a version separator: digits either side.
    if (text[i] === "." && /\d/.test(prev) && /\d/.test(next ?? "")) {
      i = j;
      continue;
    }
    // A known abbreviation's period.
    if (text[i] === "." && ABBREV_RE.test(text.slice(start, i))) {
      i = j;
      continue;
    }
    // A terminator ends a sentence only at whitespace or end of line.
    if (next === undefined || /\s/.test(next)) {
      const t = text.slice(start, j + 1).trim();
      if (t !== "") out.push({ text: t, index: start });
      start = j + 1;
    }
    i = j;
  }
  const tail = text.slice(start).trim();
  if (tail !== "") out.push({ text: tail, index: start });
  return out;
}

export function buildDirectiveInventory(bundle: Bundle): Cluster<DirectiveMeta>[] {
  const byKey = new Map<string, { sites: Site[]; polarities: Set<"positive" | "negative">; strengths: Set<"must" | "should" | "may"> }>();

  forEachVisibleLine(bundle, "contradiction", (doc, line, text) => {
    for (const sentence of splitSentences(text)) {
      if (!DIRECTIVE_RE.test(sentence.text)) continue;
      const subject = directiveSubject(sentence.text);
      if (subject === "") continue;
      let entry = byKey.get(subject);
      if (!entry) {
        entry = { sites: [], polarities: new Set(), strengths: new Set() };
        byKey.set(subject, entry);
      }
      entry.sites.push(site(doc, line));
      entry.polarities.add(NEGATIVE_RE.test(sentence.text) ? "negative" : "positive");
      entry.strengths.add(directiveStrength(sentence.text));
    }
  });

  const clusters: Cluster<DirectiveMeta>[] = [];
  for (const [subject, e] of byKey) {
    // Two directives about the same action only interest us when they disagree
    // about direction or about how binding they are.
    if (e.polarities.size < 2 && e.strengths.size < 2) continue;
    clusters.push({
      key: subject,
      sites: e.sites,
      meta: { subject, polarities: [...e.polarities], strengths: [...e.strengths] },
    });
  }
  return clusters.sort(byReach);
}

// -- structure inventory --------------------------------------------------------------

export interface LinkRef {
  docId: string;
  line: number;
  raw: string;
  target: string; // the href as written
  anchor: string | null; // the #fragment, when present
  filePart: string | null; // the path part, when present
}

const MD_LINK_RE = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
// A prose cross-reference with no link at all: "see section 4", "in the
// Configuration section". These dangle just as easily and no linter catches them.
const PROSE_REF_RE = /\b(?:see|refer\s+to|described\s+in|documented\s+in|per)\s+(?:the\s+)?(?:section\s+)?["“]?([A-Z][\w '-]{2,60}?)["”]?\s*(?:section|below|above)?\b/g;

export function buildLinkInventory(bundle: Bundle): LinkRef[] {
  const out: LinkRef[] = [];
  for (const doc of bundle.docs) {
    for (let ln = 1; ln <= doc.lines.length; ln++) {
      if (!lensSeesLine(doc, ln, "structure")) continue;
      for (const m of doc.lines[ln - 1].matchAll(MD_LINK_RE)) {
        const target = m[2];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue; // external
        const hash = target.indexOf("#");
        out.push({
          docId: doc.id,
          line: ln,
          raw: m[0],
          target,
          anchor: hash === -1 ? null : target.slice(hash + 1),
          filePart: hash === -1 ? target : hash === 0 ? null : target.slice(0, hash),
        });
      }
    }
  }
  return out;
}

export interface Inventories {
  terms: Cluster<TermMeta>[];
  numerics: Cluster<NumericMeta>[];
  directives: Cluster<DirectiveMeta>[];
  links: LinkRef[];
}

export function buildInventories(bundle: Bundle): Inventories {
  return {
    terms: buildTermInventory(bundle),
    numerics: buildNumericInventory(bundle),
    directives: buildDirectiveInventory(bundle),
    links: buildLinkInventory(bundle),
  };
}

export { PROSE_REF_RE, slugify };

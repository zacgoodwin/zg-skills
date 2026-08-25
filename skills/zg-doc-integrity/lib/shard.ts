// Sharding: cutting the bundle into pieces one agent can hold.
//
// Boundaries follow headings, because a section is the unit a document already
// divides itself into and splitting mid-section hands an agent half an
// argument. Sections too small to be worth an agent are packed together;
// sections too large to fit are split at paragraph breaks.
//
// Sharding alone cannot find a contradiction whose two halves land in different
// shards. That is what the claim ledger and the cross-document inventories are
// for -- this file only has to make each piece readable and each piece's
// addresses honest.
import { type Bundle, type Doc, type LensId, lensSeesLine, sectionEnd } from "./bundle.ts";
import { ZError } from "./cli.ts";

// Lines, not tokens: a token estimate would be a second guess layered on a
// first. At ~1500 lines a shard is comfortably inside any current context with
// room for the brief and the reply.
export const TARGET_SHARD_LINES = 1500;
export const MAX_SHARD_LINES = 2200;
export const MIN_SHARD_LINES = 200;

// Above this many shards, shards batch several to an agent rather than fanning
// out further. 12 agents is already a wide fan-out for one round.
export const MAX_SHARD_AGENTS = 12;

export interface ShardPiece {
  docId: string;
  relPath: string;
  startLine: number;
  endLine: number;
  heading: string | null;
}

export interface Shard {
  id: string; // shard-1, shard-2, ...
  pieces: ShardPiece[];
  lines: number;
}

interface Section {
  doc: Doc;
  startLine: number;
  endLine: number;
  heading: string | null;
  lines: number;
}

// A document with no headings is one section; otherwise every heading opens
// one, plus a preamble section when the file does not start with a heading.
function sectionsOf(doc: Doc): Section[] {
  const total = doc.lines.length;
  if (total === 0) return [];
  const out: Section[] = [];
  const heads = doc.headings;

  if (heads.length === 0) {
    return [{ doc, startLine: 1, endLine: total, heading: null, lines: total }];
  }
  if (heads[0].line > 1) {
    out.push({ doc, startLine: 1, endLine: heads[0].line - 1, heading: null, lines: heads[0].line - 1 });
  }
  for (let i = 0; i < heads.length; i++) {
    // Only top-level-ish sections become their own boundary; deeper headings
    // ride inside their parent unless the parent is oversized (handled below).
    const start = heads[i].line;
    const end = sectionEnd(heads, i, total);
    // Skip a heading fully contained in an earlier section at the same or
    // shallower level -- sectionEnd already accounted for it.
    if (out.length > 0 && start <= out[out.length - 1].endLine && heads[i].level > 1) {
      const prev = out[out.length - 1];
      if (prev.heading !== null && end <= prev.endLine) continue;
    }
    out.push({ doc, startLine: start, endLine: end, heading: heads[i].text, lines: end - start + 1 });
  }

  // Collapse overlaps introduced by nested headings: keep the outermost span.
  const flat: Section[] = [];
  for (const s of out) {
    const prev = flat[flat.length - 1];
    if (prev && s.startLine <= prev.endLine) {
      if (s.endLine > prev.endLine) prev.endLine = s.endLine;
      prev.lines = prev.endLine - prev.startLine + 1;
      continue;
    }
    flat.push({ ...s });
  }
  return flat;
}

// A section larger than one shard is cut at blank lines, which are paragraph
// boundaries in every format this skill reads.
function splitOversized(s: Section): Section[] {
  if (s.lines <= MAX_SHARD_LINES) return [s];
  const out: Section[] = [];
  let start = s.startLine;
  while (start <= s.endLine) {
    let end = Math.min(start + TARGET_SHARD_LINES - 1, s.endLine);
    if (end < s.endLine) {
      // Walk back to the nearest blank line so a paragraph stays whole.
      let cut = end;
      const floor = Math.max(start + MIN_SHARD_LINES, start);
      while (cut > floor && s.doc.lines[cut - 1].trim() !== "") cut--;
      if (cut > floor) end = cut;
    }
    out.push({
      doc: s.doc,
      startLine: start,
      endLine: end,
      heading: out.length === 0 ? s.heading : `${s.heading ?? "(preamble)"} (continued)`,
      lines: end - start + 1,
    });
    start = end + 1;
  }
  return out;
}

// Sections pack into shards in document order, so a shard is always a
// contiguous readable stretch rather than a scattered sample.
export function planShards(bundle: Bundle): Shard[] {
  const sections = bundle.docs.flatMap((d) => sectionsOf(d).flatMap(splitOversized));
  const shards: Shard[] = [];
  let current: ShardPiece[] = [];
  let currentLines = 0;

  const flush = () => {
    if (current.length === 0) return;
    shards.push({ id: `shard-${shards.length + 1}`, pieces: current, lines: currentLines });
    current = [];
    currentLines = 0;
  };

  for (const s of sections) {
    if (currentLines > 0 && currentLines + s.lines > MAX_SHARD_LINES) flush();
    current.push({ docId: s.doc.id, relPath: s.doc.relPath, startLine: s.startLine, endLine: s.endLine, heading: s.heading });
    currentLines += s.lines;
    if (currentLines >= TARGET_SHARD_LINES) flush();
  }
  flush();
  return shards;
}

// When shards outnumber the agent cap, several ride on one agent. Grouping
// keeps document order so each agent still reads contiguous material.
export function batchShards(shards: Shard[], cap = MAX_SHARD_AGENTS): Shard[][] {
  if (shards.length <= cap) return shards.map((s) => [s]);
  const per = Math.ceil(shards.length / cap);
  const out: Shard[][] = [];
  for (let i = 0; i < shards.length; i += per) out.push(shards.slice(i, i + per));
  return out;
}

// The text an agent actually reads. Lines its lens must not see are replaced by
// a marker rather than removed, so line numbers stay true and the agent can see
// that something was withheld instead of silently reading a document with holes.
export function renderShard(bundle: Bundle, shard: Shard, lens: LensId): string {
  const byId = new Map(bundle.docs.map((d) => [d.id, d]));
  const out: string[] = [];
  for (const piece of shard.pieces) {
    const doc = byId.get(piece.docId);
    if (!doc) throw new ZError(`renderShard: unknown document ${piece.docId}.`);
    out.push(`===== ${doc.id} ${doc.relPath} lines ${piece.startLine}-${piece.endLine} =====`);
    let skipped = 0;
    for (let ln = piece.startLine; ln <= piece.endLine; ln++) {
      if (!lensSeesLine(doc, ln, lens)) {
        skipped++;
        continue;
      }
      if (skipped > 0) {
        out.push(`  [... ${skipped} line(s) withheld: excluded region for this lens ...]`);
        skipped = 0;
      }
      out.push(doc.lines[ln - 1]);
    }
    if (skipped > 0) out.push(`  [... ${skipped} line(s) withheld: excluded region for this lens ...]`);
    out.push("");
  }
  return out.join("\n");
}

export function shardSummary(shards: Shard[]): string {
  return shards
    .map((s) => `${s.id}: ${s.lines} lines, ${s.pieces.map((p) => `${p.docId}:${p.startLine}-${p.endLine}`).join(" ")}`)
    .join("\n");
}

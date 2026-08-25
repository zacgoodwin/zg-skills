// The structure lens: findings produced entirely in code.
//
// Dangling anchors, links to documents outside the review set, duplicate
// headings, and table-of-contents drift are all decidable by reading the
// document graph. No model is involved, which makes this lens free, instant,
// and incapable of hallucinating -- so it runs on every review regardless of
// budget.
//
// The one rule it obeys that a naive link checker would not: a reference to a
// document that was NOT passed to this review is recorded as unverifiable, not
// reported as broken. The review is strictly internal; chasing that file would
// mean reading outside the bundle.
import { basename } from "node:path";
import { type Bundle, type Doc, lensSeesLine, slugify } from "./bundle.ts";
import { type RawFinding } from "./findings.ts";
import { buildLinkInventory, type LinkRef } from "./inventory.ts";

export interface StructureResult {
  findings: RawFinding[];
  // References the review deliberately did not judge, surfaced so "no findings"
  // never quietly means "did not look".
  unverifiableRefs: { docId: string; relPath: string; line: number; target: string; reason: string }[];
}

export const STRUCTURE_SEAT = "structure-lens";

function anchorsOf(doc: Doc): Set<string> {
  const out = new Set<string>();
  for (const h of doc.headings) if (h.slug !== "") out.add(h.slug);
  // Explicit HTML anchors are common in hand-maintained docs.
  for (let ln = 1; ln <= doc.lines.length; ln++) {
    if (!lensSeesLine(doc, ln, "structure")) continue;
    for (const m of doc.lines[ln - 1].matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) out.add(m[1].toLowerCase());
    for (const m of doc.lines[ln - 1].matchAll(/\{#([A-Za-z0-9_-]+)\}/g)) out.add(m[1].toLowerCase());
  }
  return out;
}

// Which document a link's file part points at, when that document is in the
// review set. Matching is by basename because a relative path from one document
// resolves against its own directory, and the bundle is flat.
function targetDoc(bundle: Bundle, link: LinkRef): Doc | null {
  if (link.filePart === null || link.filePart === "") {
    return bundle.docs.find((d) => d.id === link.docId) ?? null;
  }
  const want = basename(link.filePart.replace(/\\/g, "/")).toLowerCase();
  return bundle.docs.find((d) => basename(d.relPath).toLowerCase() === want) ?? null;
}

// A quote must be verbatim source text, because resolveQuote grounds it against
// the document. The raw link markup is exactly that.
function quoteFor(doc: Doc, line: number, fallback: string): string {
  const text = (doc.lines[line - 1] ?? "").trim();
  return text === "" ? fallback : text;
}

export function structureFindings(bundle: Bundle): StructureResult {
  const findings: RawFinding[] = [];
  const unverifiableRefs: StructureResult["unverifiableRefs"] = [];
  const byId = new Map(bundle.docs.map((d) => [d.id, d]));
  const anchors = new Map(bundle.docs.map((d) => [d.id, anchorsOf(d)]));

  // -- dangling anchors and out-of-set references --------------------------------
  for (const link of buildLinkInventory(bundle)) {
    const from = byId.get(link.docId);
    if (!from) continue;
    const to = targetDoc(bundle, link);

    if (to === null) {
      unverifiableRefs.push({
        docId: link.docId,
        relPath: from.relPath,
        line: link.line,
        target: link.target,
        reason: "points at a document outside this review set",
      });
      continue;
    }
    if (link.anchor === null) continue;

    const slug = decodeURIComponent(link.anchor).toLowerCase();
    if (anchors.get(to.id)?.has(slug)) continue;

    const quote = quoteFor(from, link.line, link.raw);
    const nearest = [...(anchors.get(to.id) ?? [])]
      .filter((a) => a.startsWith(slug.slice(0, 4)) || slug.startsWith(a.slice(0, 4)))
      .slice(0, 3);
    findings.push({
      kind: "structure",
      title: `Dangling anchor #${slug} in ${from.relPath}`,
      summary:
        `The link at ${from.relPath}:${link.line} points at #${slug} in ${to.relPath}, ` +
        `which has no heading or anchor by that name.` +
        (nearest.length > 0 ? ` Closest existing anchors: ${nearest.map((n) => `#${n}`).join(", ")}.` : ""),
      sides: [{ label: "the reference", quote, note: `resolves to ${to.relPath}#${slug}`, atLine: link.line }],
      options: [
        {
          label: nearest.length > 0 ? `Repoint the link at #${nearest[0]}` : "Repoint the link at an existing anchor",
          edits: [{ quote, atLine: link.line }],
          consequence:
            nearest.length > 0
              ? `1 edit. Assumes #${nearest[0]} is the section the author meant.`
              : `1 edit. Requires deciding which section was intended.`,
        },
        {
          label: `Add a heading or anchor named ${slug} to ${to.relPath}`,
          edits: [{ quote, atLine: link.line }],
          consequence: `1 edit in ${to.relPath}. Right when the target section was dropped or never written.`,
        },
      ],
    });
  }

  // -- duplicate headings ----------------------------------------------------------
  for (const doc of bundle.docs) {
    const bySlug = new Map<string, number[]>();
    for (const h of doc.headings) {
      if (h.slug === "") continue;
      const list = bySlug.get(h.slug);
      if (list) list.push(h.line);
      else bySlug.set(h.slug, [h.line]);
    }
    for (const [slug, lines] of bySlug) {
      if (lines.length < 2) continue;
      // Duplicate headings quote IDENTICAL text, so quote resolution alone maps
      // every occurrence to every line. The lens already knows the exact lines;
      // pinning each one is what keeps the citations distinguishable.
      const at = lines.map((ln) => ({ line: ln, quote: doc.lines[ln - 1].trim() }));
      findings.push({
        kind: "structure",
        title: `Duplicate heading "${slug}" in ${doc.relPath}`,
        summary:
          `${doc.relPath} has ${lines.length} headings that slug to #${slug} (lines ${lines.join(", ")}). ` +
          `Any link to #${slug} silently reaches only the first, and a reader searching the document finds two answers.`,
        sides: at.map((a, i) => ({ label: `occurrence ${i + 1} (line ${a.line})`, quote: a.quote, atLine: a.line })),
        options: [
          {
            label: "Rename the later headings so each slug is unique",
            edits: at.slice(1).map((a) => ({ quote: a.quote, atLine: a.line })),
            consequence: `${at.length - 1} edit(s). Any existing link to the later sections keeps resolving to the first.`,
          },
          {
            label: "Merge the sections into one",
            edits: at.map((a) => ({ quote: a.quote, atLine: a.line })),
            consequence: `${at.length} edit(s) plus the body text. Right when the duplication is genuine redundancy.`,
          },
        ],
      });
    }
  }

  // -- table-of-contents drift -------------------------------------------------------
  for (const doc of bundle.docs) {
    const toc = tocEntries(doc);
    if (toc.length < 2) continue;
    const present = anchors.get(doc.id) ?? new Set<string>();
    const missing = toc.filter((t) => t.anchor !== null && !present.has(t.anchor));
    if (missing.length === 0) continue;
    findings.push({
      kind: "structure",
      title: `Table of contents lists ${missing.length} section(s) that do not exist in ${doc.relPath}`,
      summary:
        `${doc.relPath}'s contents list points at ${missing.map((m) => `#${m.anchor}`).join(", ")}, ` +
        `which no heading in the document provides. Either the sections were removed and the list was not, or they were renamed.`,
      sides: missing.map((m) => ({ label: `list entry (line ${m.line})`, quote: m.quote, atLine: m.line })),
      options: [
        {
          label: "Remove the stale entries from the contents list",
          edits: missing.map((m) => ({ quote: m.quote, atLine: m.line })),
          consequence: `${missing.length} edit(s). Right when the sections were deliberately dropped.`,
        },
        {
          label: "Repoint the entries at the headings that replaced them",
          edits: missing.map((m) => ({ quote: m.quote, atLine: m.line })),
          consequence: `${missing.length} edit(s). Requires deciding which current heading each entry meant.`,
        },
      ],
    });
  }

  return { findings, unverifiableRefs };
}

interface TocEntry {
  line: number;
  anchor: string | null;
  quote: string;
}

// A contents list is a run of list items that are mostly same-document anchor
// links. Detecting it by shape rather than by a "Table of Contents" heading
// catches the many docs that never name it.
export function tocEntries(doc: Doc): TocEntry[] {
  const entries: TocEntry[] = [];
  let run: TocEntry[] = [];
  let best: TocEntry[] = [];

  const flush = () => {
    if (run.length > best.length) best = run;
    run = [];
  };

  for (let ln = 1; ln <= doc.lines.length; ln++) {
    const text = doc.lines[ln - 1];
    if (!lensSeesLine(doc, ln, "structure")) continue;
    const isListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(text);
    if (!isListItem) {
      if (text.trim() !== "") flush();
      continue;
    }
    const m = /\[([^\]]*)\]\(\s*#([^)\s]+)\s*\)/.exec(text);
    if (!m) {
      flush();
      continue;
    }
    run.push({ line: ln, anchor: decodeURIComponent(m[2]).toLowerCase(), quote: text.trim() });
  }
  flush();
  entries.push(...best);
  return entries;
}

export { slugify };

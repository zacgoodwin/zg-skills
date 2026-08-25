// Document loading, region tagging, and the throwaway bundle directory.
//
// The bundle is the prose analogue of z-adversarial-review's throwaway
// worktree: a directory holding copies of ONLY the documents under review, so
// an agent scoped to it cannot reach the rest of the repo, the network, or the
// orchestrator's context. Everything downstream addresses text as
// `<docId>:<line>`, assigned here and nowhere else.
//
// Region tagging exists because the biggest false-positive source in a document
// review is text that is SUPPOSED to disagree with the current state: a
// changelog describing old behavior, an anti-pattern example, a quoted excerpt.
// Exclusion is per-lens, not global -- the numeric lens deliberately reads code
// fences so a sample showing `timeout: 30` can be caught contradicting prose
// that says 60.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZError } from "./cli.ts";

// -- what counts as a reviewable document -------------------------------------

export const DOC_EXTENSIONS = [".md", ".mdx", ".txt", ".rst"] as const;

// A hard ceiling, not a performance tuning knob: past this the sharding budget
// and the wall-clock estimate stop being honest. Raise deliberately.
export const MAX_BUNDLE_LINES = 25_000;

export function hasDocExtension(p: string): boolean {
  const lower = p.toLowerCase();
  return DOC_EXTENSIONS.some((e) => lower.endsWith(e));
}

// -- regions -------------------------------------------------------------------

// `code`        fenced code blocks, fence lines included
// `frontmatter` a leading YAML/TOML block delimited by --- or +++
// `history`     a section whose heading says it describes the past
// `example`     a section whose heading says its content is illustrative
// `quote`       blockquote lines
export type RegionKind = "code" | "frontmatter" | "history" | "example" | "quote";

// Section headings whose content is describing what USED to be true. A
// contradiction between these and current prose is the document working as
// intended.
const HISTORY_HEADING_RE =
  /^\s*(?:change\s?log|history|revision\s+history|release\s+notes|migration(?:s|\s+guide|\s+notes)?|upgrading|upgrade\s+guide|deprecat\w*|legacy|previously|prior\s+behaviou?r|older\s+versions?|archive)\b/i;

// Section headings whose content is deliberately illustrative -- including the
// deliberately WRONG kind.
const EXAMPLE_HEADING_RE =
  /^\s*(?:examples?|sample(?:s|\s+\w+)?|for\s+instance|before(?:\s*(?:\/|and|vs\.?)\s*after)?|after|anti[-\s]?patterns?|don'?ts?|do\s+not|bad(?:\s+\w+)?|wrong|incorrect|what\s+not\s+to\s+do|counter[-\s]?examples?)\b/i;

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const ATX_HEADING_RE = /^(\s{0,3})(#{1,6})(\s+.*|)$/;
const SETEXT_UNDERLINE_RE = /^(\s{0,3})(=+|-{2,})\s*$/;
const BLOCKQUOTE_RE = /^\s{0,3}>/;

export interface Heading {
  line: number; // 1-based, the heading's own line
  level: number; // 1-6
  text: string;
  slug: string;
}

export interface Doc {
  id: string; // D1, D2, ... assigned in argument order
  path: string; // absolute, as read
  relPath: string; // repo-relative, what citations print
  lines: string[]; // 0-based array; line N of the doc is lines[N-1]
  regions: RegionKind[][]; // parallel to lines; [] means plain prose
  headings: Heading[];
}

// GitHub-flavored anchor slug: lowercase, punctuation dropped, spaces to
// hyphens. Anchors are compared, not generated, so matching the common
// convention matters more than matching any one renderer exactly.
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link text survives, target does not
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// Fences first, because a `#` inside a fence is not a heading and a `>` inside
// one is not a quote. Every later pass consults this result rather than
// re-scanning the raw text.
function tagFencesAndFrontmatter(lines: string[]): RegionKind[][] {
  const regions: RegionKind[][] = lines.map(() => []);
  let i = 0;

  // Frontmatter only counts as the very first line of the file; a `---` further
  // down is a horizontal rule or a setext underline.
  if (lines.length > 0 && /^(---|\+\+\+)\s*$/.test(lines[0])) {
    const delim = lines[0].trim();
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === delim) {
        end = j;
        break;
      }
    }
    // An unterminated opener is a horizontal rule, not frontmatter -- tagging
    // the whole file would silence the entire review.
    if (end !== -1) {
      for (let j = 0; j <= end; j++) regions[j].push("frontmatter");
      i = end + 1;
    }
  }

  let fenceMarker: string | null = null;
  for (; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]);
    if (fenceMarker === null) {
      if (m) {
        fenceMarker = m[2];
        regions[i].push("code");
      }
      continue;
    }
    regions[i].push("code");
    // A closing fence is the same character, at least as long, and carries no
    // info string.
    if (m && m[2][0] === fenceMarker[0] && m[2].length >= fenceMarker.length && m[3].trim() === "") {
      fenceMarker = null;
    }
  }
  return regions;
}

export function parseHeadings(lines: string[], regions: RegionKind[][]): Heading[] {
  const headings: Heading[] = [];
  const skip = (idx: number) => regions[idx].includes("code") || regions[idx].includes("frontmatter");
  for (let i = 0; i < lines.length; i++) {
    if (skip(i)) continue;
    const atx = ATX_HEADING_RE.exec(lines[i]);
    if (atx) {
      const text = atx[3].trim().replace(/\s+#+\s*$/, "");
      headings.push({ line: i + 1, level: atx[2].length, text, slug: slugify(text) });
      continue;
    }
    // Setext: an underline directly beneath a non-blank line that is not itself
    // structural. Older docs lean on this, and without it they shard as one
    // undifferentiated blob.
    const under = SETEXT_UNDERLINE_RE.exec(lines[i]);
    if (under && i > 0 && !skip(i - 1)) {
      const prev = lines[i - 1];
      if (prev.trim() !== "" && !ATX_HEADING_RE.test(prev) && !FENCE_RE.test(prev) && !BLOCKQUOTE_RE.test(prev)) {
        const text = prev.trim();
        headings.push({ line: i - 1 + 1, level: under[2][0] === "=" ? 1 : 2, text, slug: slugify(text) });
      }
    }
  }
  return headings;
}

// A section runs from its heading to the line before the next heading of the
// same or higher level -- the same rule a reader applies.
export function sectionEnd(headings: Heading[], index: number, totalLines: number): number {
  const h = headings[index];
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= h.level) return headings[j].line - 1;
  }
  return totalLines;
}

export function tagRegions(lines: string[]): { regions: RegionKind[][]; headings: Heading[] } {
  const regions = tagFencesAndFrontmatter(lines);
  const headings = parseHeadings(lines, regions);

  for (let i = 0; i < lines.length; i++) {
    if (regions[i].includes("code") || regions[i].includes("frontmatter")) continue;
    if (BLOCKQUOTE_RE.test(lines[i])) regions[i].push("quote");
  }

  for (let hi = 0; hi < headings.length; hi++) {
    const h = headings[hi];
    const kind: RegionKind | null = HISTORY_HEADING_RE.test(h.text)
      ? "history"
      : EXAMPLE_HEADING_RE.test(h.text)
        ? "example"
        : null;
    if (!kind) continue;
    const end = sectionEnd(headings, hi, lines.length);
    for (let ln = h.line; ln <= end; ln++) {
      if (!regions[ln - 1].includes(kind)) regions[ln - 1].push(kind);
    }
  }
  return { regions, headings };
}

// -- per-lens visibility --------------------------------------------------------

export type LensId = "contradiction" | "terminology" | "numeric" | "structure";

// Which region kinds each lens must NOT read. Deliberately not uniform:
//  - numeric reads code, so a sample showing `timeout: 30` can contradict prose
//    saying 60 -- the single most common real drift in developer docs.
//  - structure reads history and example sections, because their headings are
//    real headings that belong in a table of contents, and their links are real
//    links that can dangle.
export const LENS_IGNORES: Record<LensId, readonly RegionKind[]> = {
  contradiction: ["code", "frontmatter", "history", "example", "quote"],
  terminology: ["code", "frontmatter", "history", "example", "quote"],
  numeric: ["frontmatter", "history", "example", "quote"],
  structure: ["code", "frontmatter"],
};

export function lensSeesLine(doc: Doc, line: number, lens: LensId): boolean {
  const regions = doc.regions[line - 1];
  if (regions === undefined) return false;
  const ignored = LENS_IGNORES[lens];
  return !regions.some((r) => ignored.includes(r));
}

// The 1-based line numbers a lens is allowed to consider, in order.
export function visibleLines(doc: Doc, lens: LensId): number[] {
  const out: number[] = [];
  for (let ln = 1; ln <= doc.lines.length; ln++) {
    if (lensSeesLine(doc, ln, lens)) out.push(ln);
  }
  return out;
}

// The heading a line sits under, or null above the first heading. Detectability
// scoring needs it: two contradicting sentences under one heading are visible
// to a reader in a way two in different sections are not.
export function enclosingHeading(doc: Doc, line: number): Heading | null {
  let found: Heading | null = null;
  for (const h of doc.headings) {
    if (h.line > line) break;
    found = h;
  }
  return found;
}

// -- loading --------------------------------------------------------------------

// CRLF is normalized away so a quote captured on Windows resolves against a
// document checked out with either ending. The trailing-newline split artifact
// is dropped so `lines.length` matches what an editor shows.
export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function loadDoc(absPath: string, id: string, repoRoot: string): Doc {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (e) {
    throw new ZError(`Cannot read document ${absPath}: ${(e as Error).message}`);
  }
  const lines = splitLines(raw);
  const { regions, headings } = tagRegions(lines);
  const rel = relative(repoRoot, absPath);
  return {
    id,
    path: absPath,
    // Forward slashes always: citations are compared as strings and pasted into
    // shell commands, and a backslash path breaks both.
    relPath: (rel.startsWith("..") || isAbsolute(rel) ? absPath : rel).split(sep).join("/"),
    lines,
    regions,
    headings,
  };
}

const GLOB_CHARS = /[*?[\]{}]/;

// Argument order is meaningful: it assigns D1, D2, ... and those ids order the
// options a finding offers. Globs expand in sorted order so a given invocation
// is reproducible.
export function expandPaths(patterns: string[], cwd: string): string[] {
  if (patterns.length === 0) throw new ZError(`No documents given. Pass one or more file paths or globs.`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let matches: string[];
    if (GLOB_CHARS.test(pattern)) {
      const scanned = [...new Bun.Glob(pattern).scanSync({ cwd, onlyFiles: true })].sort();
      matches = scanned.map((m) => resolve(cwd, m));
      if (matches.length === 0) throw new ZError(`Pattern ${JSON.stringify(pattern)} matched no files.`);
    } else {
      const abs = resolve(cwd, pattern);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        throw new ZError(`${pattern} is not a file. Pass document paths or globs.`);
      }
      matches = [abs];
    }
    for (const m of matches) {
      if (!hasDocExtension(m)) {
        // A glob that swept up a .png is the user's pattern being loose; a named
        // file with the wrong extension is a mistake worth stopping on.
        if (GLOB_CHARS.test(pattern)) continue;
        throw new ZError(
          `${pattern} has an unsupported extension. This skill reads ${DOC_EXTENSIONS.join(", ")} (no conversion layer).`
        );
      }
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  if (out.length === 0) {
    throw new ZError(`No readable documents matched. Supported extensions: ${DOC_EXTENSIONS.join(", ")}.`);
  }
  return out;
}

export interface Bundle {
  docs: Doc[];
  totalLines: number;
  repoRoot: string;
}

export function loadBundle(patterns: string[], cwd: string, repoRoot: string): Bundle {
  const paths = expandPaths(patterns, cwd);
  const docs = paths.map((p, i) => loadDoc(p, `D${i + 1}`, repoRoot));
  const totalLines = docs.reduce((n, d) => n + d.lines.length, 0);
  if (totalLines > MAX_BUNDLE_LINES) {
    throw new ZError(
      `Bundle is ${totalLines} lines across ${docs.length} documents; the ceiling is ${MAX_BUNDLE_LINES}. ` +
        `Split the review into smaller sets -- past this the shard budget and the time estimate stop being honest.`
    );
  }
  return { docs, totalLines, repoRoot };
}

export function docById(bundle: Bundle, id: string): Doc {
  const doc = bundle.docs.find((d) => d.id === id);
  if (!doc) throw new ZError(`Unknown document id ${JSON.stringify(id)}. Known: ${bundle.docs.map((d) => d.id).join(", ")}.`);
  return doc;
}

// -- the throwaway bundle directory ---------------------------------------------

export interface BundleManifest {
  docs: { id: string; relPath: string; file: string; lines: number }[];
  totalLines: number;
}

// Copies are flat and renamed to `<id>-<basename>`: an agent granted this
// directory sees the documents and nothing else, and cannot infer repo layout
// from a nested path it was never meant to know.
export function writeBundleDir(bundle: Bundle, dir: string): BundleManifest {
  mkdirSync(dir, { recursive: true });
  const docs = bundle.docs.map((d) => {
    const file = `${d.id}-${basename(d.path)}`;
    writeFileSync(join(dir, file), d.lines.join("\n") + "\n");
    return { id: d.id, relPath: d.relPath, file, lines: d.lines.length };
  });
  const manifest: BundleManifest = { docs, totalLines: bundle.totalLines };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// The bounded read an agent gets instead of filesystem access: N lines either
// side of a site, numbered, from inside the bundle only.
export function contextWindow(doc: Doc, line: number, window: number): string {
  if (!Number.isInteger(line) || line < 1 || line > doc.lines.length) {
    throw new ZError(`context: line ${line} is outside ${doc.id} (1..${doc.lines.length}).`);
  }
  if (!Number.isInteger(window) || window < 0) {
    throw new ZError(`context: window must be a non-negative integer, got ${JSON.stringify(window)}.`);
  }
  const start = Math.max(1, line - window);
  const end = Math.min(doc.lines.length, line + window);
  const width = String(end).length;
  const out: string[] = [];
  for (let ln = start; ln <= end; ln++) {
    out.push(`${String(ln).padStart(width)}${ln === line ? " >" : "  "} ${doc.lines[ln - 1]}`);
  }
  return out.join("\n");
}

// Appends `.doc-integrity/` to the repo's .gitignore once. Run artifacts are
// working state, and a plan full of quoted document text does not belong in
// version control by accident.
export function ensureGitignored(repoRoot: string, entry = ".doc-integrity/"): "added" | "already-present" | "no-gitignore" {
  const p = join(repoRoot, ".gitignore");
  if (!existsSync(p)) return "no-gitignore";
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return "no-gitignore";
  }
  const present = text.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === entry.replace(/\/$/, ""));
  if (present) return "already-present";
  writeFileSync(p, text.endsWith("\n") || text === "" ? `${text}${entry}\n` : `${text}\n${entry}\n`);
  return "added";
}

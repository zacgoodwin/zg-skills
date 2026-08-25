// Apply: the only part of this skill that writes to the user's documents.
//
// Three safeguards, in order. Originals are snapshotted before any write, so
// every change is reversible from disk rather than from memory. Edits are
// grouped BY FILE with one agent per file, so two agents can never race on the
// same document. And afterwards the diff is checked against what the chosen
// option declared it would touch -- an option that promised two edits and made
// five fails the run, because a well-meaning tidy-up is still an unreviewed
// change to the user's prose.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Bundle, type Doc, docById, splitLines } from "./bundle.ts";
import { ZError } from "./cli.ts";
import { type Finding, type Instance, normalizeWhitespace } from "./findings.ts";
import { type PlanFile, type PlanStatus } from "./plan.ts";

// How far outside a declared edit site a change may land before it counts as
// blast. One line of slack absorbs a rewrap; more would let an agent rewrite a
// neighbouring paragraph unnoticed.
export const BLAST_SLACK_LINES = 1;

export interface PlannedEdit {
  findingId: string;
  optionId: string;
  optionLabel: string;
  site: Instance;
  replacement?: string;
}

export interface FileWorkUnit {
  docId: string;
  relPath: string;
  absPath: string;
  edits: PlannedEdit[];
}

// One unit per FILE, never per finding: two findings touching the same document
// must be the same agent's work or they will clobber each other.
export function planEdits(bundle: Bundle, plan: PlanFile, status: PlanStatus): FileWorkUnit[] {
  const byId = new Map(plan.findings.map((f) => [f.id, f]));
  const units = new Map<string, FileWorkUnit>();

  for (const r of status.resolved) {
    const finding = byId.get(r.id);
    if (!finding) throw new ZError(`Plan resolves ${r.id}, which is not in this run's findings.`);
    const option = finding.options.find((o) => o.id === r.optionId);
    if (!option) throw new ZError(`${r.id}: option ${JSON.stringify(r.optionId)} is not one of its options.`);

    option.editSites.forEach((site, i) => {
      const doc = docById(bundle, site.docId);
      let unit = units.get(site.docId);
      if (!unit) {
        unit = { docId: doc.id, relPath: doc.relPath, absPath: doc.path, edits: [] };
        units.set(site.docId, unit);
      }
      unit.edits.push({
        findingId: finding.id,
        optionId: option.id,
        optionLabel: option.label,
        site,
        replacement: option.replacements[i],
      });
    });
  }

  const out = [...units.values()];
  for (const u of out) u.edits.sort((a, b) => a.site.line - b.site.line);
  return out;
}

// Two chosen options that both edit the same line are a conflict the human has
// to settle -- applying either one silently would make the other's promise
// false.
export function conflictingEdits(units: FileWorkUnit[]): string[] {
  const conflicts: string[] = [];
  for (const u of units) {
    const byLine = new Map<number, PlannedEdit[]>();
    for (const e of u.edits) {
      const list = byLine.get(e.site.line) ?? [];
      list.push(e);
      byLine.set(e.site.line, list);
    }
    for (const [line, edits] of byLine) {
      const findings = [...new Set(edits.map((e) => e.findingId))];
      if (findings.length > 1) {
        conflicts.push(
          `${u.relPath}:${line} is edited by ${findings.join(" and ")}; resolve one of them differently, or mark one "change nothing"`
        );
      }
    }
  }
  return conflicts;
}

// -- snapshots --------------------------------------------------------------------

export interface Snapshot {
  relPath: string;
  absPath: string;
  snapshotPath: string;
}

// Flat, id-prefixed, alongside the run's other artifacts. Written before the
// first edit so a failed apply is always recoverable with a copy command the
// report prints.
export function snapshotFiles(units: FileWorkUnit[], snapshotDir: string): Snapshot[] {
  mkdirSync(snapshotDir, { recursive: true });
  return units.map((u) => {
    const snapshotPath = join(snapshotDir, `${u.docId}-${basename(u.absPath)}`);
    copyFileSync(u.absPath, snapshotPath);
    return { relPath: u.relPath, absPath: u.absPath, snapshotPath };
  });
}

// -- verification ----------------------------------------------------------------------

export interface LineChange {
  line: number; // 1-based in the ORIGINAL file
  kind: "changed" | "removed" | "added";
}

// A line-level diff, enough to answer "what moved" without a diff library. Not
// a minimal edit script: it walks both sides with a small lookahead, which is
// sufficient because an approved edit is a local rewrite, not a reorganization.
export function diffLines(before: string[], after: string[]): LineChange[] {
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  const LOOKAHEAD = 20;

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i++;
      j++;
      continue;
    }
    // Did a line get inserted? Look for before[i] a little further into after.
    const ins = after.slice(j, j + LOOKAHEAD).findIndex((l) => l === before[i]);
    // Did a line get deleted? Look for after[j] a little further into before.
    const del = before.slice(i, i + LOOKAHEAD).findIndex((l) => l === after[j]);

    if (ins > 0 && (del <= 0 || ins <= del)) {
      for (let k = 0; k < ins; k++) changes.push({ line: i + 1, kind: "added" });
      j += ins;
      continue;
    }
    if (del > 0) {
      for (let k = 0; k < del; k++) changes.push({ line: i + 1 + k, kind: "removed" });
      i += del;
      continue;
    }
    changes.push({ line: i + 1, kind: "changed" });
    i++;
    j++;
  }
  for (; i < before.length; i++) changes.push({ line: i + 1, kind: "removed" });
  for (; j < after.length; j++) changes.push({ line: before.length + 1, kind: "added" });
  return changes;
}

export interface VerifyResult {
  ok: boolean;
  relPath: string;
  applied: string[]; // findingId:optionId whose quote is gone as intended
  notApplied: string[]; // declared edits whose quote is still there untouched
  blast: string[]; // changes outside every declared site
}

// The gate. Two questions, both answerable from the file: did every promised
// edit happen, and did anything else change?
export function verifyFile(unit: FileWorkUnit, beforeText: string, afterText: string): VerifyResult {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const applied: string[] = [];
  const notApplied: string[] = [];

  for (const e of unit.edits) {
    const original = before[e.site.line - 1] ?? "";
    const stillPresentSomewhere = after.some((l) => l.includes(e.site.quote));
    const lineChanged = (after[e.site.line - 1] ?? "") !== original;
    const label = `${e.findingId}:${e.optionId}`;
    if (!stillPresentSomewhere || lineChanged) applied.push(label);
    else notApplied.push(`${label} at ${unit.relPath}:${e.site.line} — the quoted text is unchanged`);
  }

  const allowed = unit.edits.map((e) => e.site.line);
  const blast: string[] = [];
  for (const change of diffLines(before, after)) {
    const near = allowed.some((line) => Math.abs(change.line - line) <= BLAST_SLACK_LINES);
    if (!near) {
      blast.push(`${unit.relPath}:${change.line} ${change.kind}, outside every site this plan approved`);
    }
  }

  return {
    ok: notApplied.length === 0 && blast.length === 0,
    relPath: unit.relPath,
    applied: [...new Set(applied)],
    notApplied,
    blast,
  };
}

export function verifyUnit(unit: FileWorkUnit, snapshot: Snapshot): VerifyResult {
  return verifyFile(unit, readFileSync(snapshot.snapshotPath, "utf8"), readFileSync(unit.absPath, "utf8"));
}

export interface ApplyReport {
  ok: boolean;
  results: VerifyResult[];
  restoreHints: string[];
}

export function verifyAll(units: FileWorkUnit[], snapshots: Snapshot[]): ApplyReport {
  const byPath = new Map(snapshots.map((s) => [s.absPath, s]));
  const results: VerifyResult[] = [];
  for (const u of units) {
    const snap = byPath.get(u.absPath);
    if (!snap) throw new ZError(`No snapshot recorded for ${u.relPath}; refusing to verify an unprotected edit.`);
    results.push(verifyUnit(u, snap));
  }
  const ok = results.every((r) => r.ok);
  const restoreHints = ok
    ? []
    : results
        .filter((r) => !r.ok)
        .map((r) => {
          const snap = snapshots.find((s) => s.relPath === r.relPath)!;
          return `cp "${snap.snapshotPath}" "${snap.absPath}"`;
        });
  return { ok, results, restoreHints };
}

// -- the per-file agent brief ------------------------------------------------------------

export function applyBrief(unit: FileWorkUnit, doc: Doc): string {
  const edits = unit.edits
    .map((e, i) => {
      const replacement =
        e.replacement !== undefined
          ? `Replace it with EXACTLY:\n\n${e.replacement}`
          : `No exact replacement was specified. Rewrite the quoted text so it agrees with the chosen resolution, changing as few words as possible.`;
      return `### Edit ${i + 1} — ${unit.relPath}:${e.site.line}

Chosen resolution: ${e.optionLabel}

Find this text:

${e.site.quote}

${replacement}`;
    })
    .join("\n\n");

  return `You are making a specific, approved set of edits to one document. A human has already
decided what changes to make; you are carrying out their decision, not revisiting it.

## The file

${unit.absPath}

## The edits, and nothing else

${edits}

## Rules

- Make EXACTLY these edits. Every one of them, and nothing more.
- Do not fix spelling, reflow paragraphs, adjust headings, update a table of
  contents, or improve anything you notice along the way. The file is diffed
  against a snapshot afterwards and a change outside these sites FAILS the run
  and gets rolled back -- including changes that improve the document.
- Do not touch any other file.
- Preserve the surrounding indentation, list markers, and formatting exactly.
- If an edit's quoted text is not in the file, or appears somewhere you did not
  expect, make the other edits and say which one you skipped and why. Do not
  guess at what was meant.

## Why the constraint is this tight

Everything you are about to change was reviewed by a human as a specific,
bounded change. Anything else you change was not reviewed by anyone. That is the
whole distinction, and it holds even when the extra change is obviously correct.

When you are done, your final message should be one line naming how many edits
you made and any you skipped.`;
}

export function loadDocFor(bundle: Bundle, docId: string): Doc {
  return docById(bundle, docId);
}

// Convenience for the report: which findings actually landed.
export function appliedFindings(report: ApplyReport): string[] {
  return [...new Set(report.results.flatMap((r) => r.applied.map((a) => a.split(":")[0])))].sort();
}

export { normalizeWhitespace, existsSync, writeFileSync };

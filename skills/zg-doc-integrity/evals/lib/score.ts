// Scoring one eval run against the fixture's ground truth.
//
// Two numbers, and the second matters more. RECALL is how many seeded defects
// the review actually found. PRECISION-ON-TRAPS is how many of the deliberate
// non-defects it wrongly reported -- a review that finds everything by
// reporting everything is worse than useless, because a human stops reading it.
//
// Matching is by QUOTE OVERLAP, never by title similarity. A finding matches a
// seeded defect when they point at the same text, whatever either one calls it.
import { readFileSync } from "node:fs";

// A side is a list of interchangeable distinctive phrases, any one of which
// identifies that side of the defect. Ground truth is written this way because
// a reviewer legitimately chooses how much of a sentence to quote, and a
// correct finding must not score as a miss for quoting a different span --
// which is exactly what a flat list of full-sentence quotes did.
export interface SeededDefect {
  id: string;
  kind: string;
  summary: string;
  sides: string[][];
  reachableBy?: string[];
}

export interface Trap {
  id: string;
  why: string;
  region?: string;
}

export interface GroundTruth {
  seeded: SeededDefect[];
  traps: Trap[];
}

export interface ScoredFinding {
  id: string;
  kind: string;
  title: string;
  quotes: string[];
  severity: string;
  confidence: number;
  seats: string[];
  // Where the plan actually puts it. A defect found and then buried in the
  // refuted appendix has not reached the reader, and a recall number that
  // ignores placement hides exactly that.
  placement: "main" | "low-confidence" | "refuted";
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// One quote matches another when either contains the other after whitespace
// normalization. Containment rather than equality, because a reviewer may
// legitimately quote a longer or shorter span of the same sentence.
export function quotesOverlap(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x.length < 12 || y.length < 12) return x === y;
  return x.includes(y) || y.includes(x);
}

// A defect is found when ONE finding reaches at least two of its sides -- or
// its only side, for a one-sided defect. A finding that quotes one half of a
// contradiction has not identified the contradiction, and two findings that
// each quote a different half have not either.
export function sidesHit(defect: SeededDefect, finding: ScoredFinding): number {
  return defect.sides.filter((phrases) =>
    phrases.some((p) => finding.quotes.some((fq) => quotesOverlap(p, fq)))
  ).length;
}

export function defectMatched(defect: SeededDefect, finding: ScoredFinding): boolean {
  const hits = sidesHit(defect, finding);
  return defect.sides.length === 1 ? hits === 1 : hits >= 2;
}

export interface Score {
  seeded: number;
  found: number;
  recall: number;
  // Found AND placed where a reader will see it. This is the number that
  // matters; `recall` counts a defect that the refuters then buried.
  surfaced: number;
  surfacedRecall: number;
  buried: { id: string; summary: string; placement: string }[];
  missed: { id: string; summary: string; reachableBy?: string[] }[];
  reported: number;
  extra: { id: string; title: string; severity: string; confidence: number }[];
  extraRate: number;
  // Confidence separation is what the appendix threshold should be tuned on:
  // if true positives and everything else do not separate, the formula is wrong.
  meanConfidenceMatched: number | null;
  meanConfidenceExtra: number | null;
}

export function score(truth: GroundTruth, findings: ScoredFinding[]): Score {
  const matchedFindingIds = new Set<string>();
  const missed: Score["missed"] = [];
  const buried: Score["buried"] = [];
  let found = 0;
  let surfaced = 0;

  for (const d of truth.seeded) {
    const hit = findings.find((f) => defectMatched(d, f));
    if (hit) {
      found++;
      matchedFindingIds.add(hit.id);
      if (hit.placement === "main") surfaced++;
      else buried.push({ id: d.id, summary: d.summary, placement: hit.placement });
    } else {
      missed.push({ id: d.id, summary: d.summary, reachableBy: d.reachableBy });
    }
  }

  const extra = findings
    .filter((f) => !matchedFindingIds.has(f.id))
    .map((f) => ({ id: f.id, title: f.title, severity: f.severity, confidence: f.confidence }));

  const mean = (xs: number[]) => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

  return {
    seeded: truth.seeded.length,
    found,
    recall: truth.seeded.length === 0 ? 1 : found / truth.seeded.length,
    surfaced,
    surfacedRecall: truth.seeded.length === 0 ? 1 : surfaced / truth.seeded.length,
    buried,
    missed,
    reported: findings.length,
    extra,
    extraRate: findings.length === 0 ? 0 : extra.length / findings.length,
    meanConfidenceMatched: mean(findings.filter((f) => matchedFindingIds.has(f.id)).map((f) => f.confidence)),
    meanConfidenceExtra: mean(extra.map((f) => f.confidence)),
  };
}

// Findings come out of plan.json; ground truth out of the fixture.
// Mirrors lib/findings.ts placementOf. Duplicated on purpose: the eval must
// measure what the plan actually did, not re-derive it from the same code path
// whose bug it might be looking for.
function placementOf(f: any): ScoredFinding["placement"] {
  const o = f.confidence?.outcome;
  if (o === "all-refuted" || o === "majority-refuted") return "refuted";
  return (f.confidence?.score ?? 0) < 40 ? "low-confidence" : "main";
}

export function findingsFromPlan(planPath: string): ScoredFinding[] {
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  return (plan.findings ?? []).map((f: any) => ({
    id: f.id,
    kind: f.kind,
    title: f.title,
    quotes: (f.sides ?? []).map((s: any) => s.quote),
    severity: f.severity?.band ?? "unknown",
    confidence: f.confidence?.score ?? 0,
    seats: f.seats ?? [],
    placement: placementOf(f),
  }));
}

export function render(s: Score): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const out: string[] = [];
  out.push(`recall            ${s.found}/${s.seeded} (${pct(s.recall)}) found`);
  out.push(`surfaced          ${s.surfaced}/${s.seeded} (${pct(s.surfacedRecall)}) reached the main list`);
  out.push(`reported          ${s.reported} findings`);
  out.push(`not in ground truth ${s.extra.length} (${pct(s.extraRate)})`);
  out.push(`mean confidence   matched ${s.meanConfidenceMatched ?? "-"} · other ${s.meanConfidenceExtra ?? "-"}`);
  if (s.buried.length > 0) {
    out.push("");
    out.push("FOUND BUT BURIED (a real defect the reader will not act on):");
    for (const bq of s.buried) out.push(`  ${bq.id} -> ${bq.placement} — ${bq.summary}`);
  }
  if (s.missed.length > 0) {
    out.push("");
    out.push("MISSED:");
    for (const m of s.missed) out.push(`  ${m.id} — ${m.summary}${m.reachableBy ? ` [reachable by: ${m.reachableBy.join(", ")}]` : ""}`);
  }
  if (s.extra.length > 0) {
    out.push("");
    out.push("NOT IN GROUND TRUTH (check each against the trap list before calling it a false positive):");
    for (const e of s.extra) out.push(`  ${e.id} ${e.severity}/${e.confidence} — ${e.title}`);
  }
  return out.join("\n");
}

if (import.meta.main) {
  const [truthPath, planPath] = process.argv.slice(2);
  if (!truthPath || !planPath) {
    console.error("usage: bun evals/lib/score.ts <defects.json> <plan.json>");
    process.exit(1);
  }
  const truth = JSON.parse(readFileSync(truthPath, "utf8")) as GroundTruth;
  console.log(render(score(truth, findingsFromPlan(planPath))));
}

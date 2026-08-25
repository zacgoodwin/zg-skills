// The plan: what the human reads, edits, and hands back.
//
// Two files, on purpose. `plan-vN.md` is the human surface -- prose, quotes,
// options, and a checkbox line per finding. `plan-vN.json` is the machine
// truth: the findings with their resolved sites and declared edit sites.
// Nothing in the markdown body is trusted on the way back in. The parser reads
// exactly two things per finding -- which box is ticked and what the comment
// says -- so reformatting, rewording, or annotating the prose cannot break it
// or change what gets edited.
//
// The parser's bias is fixed in one direction: every ambiguity resolves toward
// NOT editing. An untouched plan applies nothing, a half-filled plan blocks
// with the gaps named, and any comment text anywhere sends the round back for
// regeneration rather than through to apply.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ZError } from "./cli.ts";
import {
  type Finding,
  type Unverifiable,
  placementOf,
  type Placement,
} from "./findings.ts";

export const PLAN_SCHEMA_VERSION = 1;

export interface PlanMeta {
  runId: string;
  round: number;
  documents: { id: string; relPath: string; lines: number }[];
  seats: string[];
  refutedCount: number; // how many findings were dispatched to refuters
  skipped: string[]; // every cap that bit, stated rather than hidden
}

// A disposition the human already gave in an earlier round, carried into this
// one pre-filled. Keyed by fingerprint rather than id, because ids renumber
// between rounds while the fingerprint follows the finding.
export interface CarriedDecision {
  disposition: "option" | "change-nothing";
  optionId?: string;
  round: number;
}

export interface PlanFile {
  schema: number;
  meta: PlanMeta;
  findings: Finding[];
  unverifiable: Unverifiable[];
  outsideRefs: { relPath: string; line: number; target: string; reason: string }[];
  carried?: Record<string, CarriedDecision>;
}

// -- rendering ------------------------------------------------------------------

function citeInstances(f: Finding, sideIndex: number): string {
  return f.sides[sideIndex].instances.map((i) => `\`${i.relPath}:${i.line}\``).join(", ");
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function renderFinding(f: Finding, carried?: CarriedDecision): string {
  const out: string[] = [];
  out.push(`### ${f.id} · ${f.kind} · ${f.severity.band} · confidence ${f.confidence.score}/100`);
  out.push("");
  if (f.summary.trim() !== "") {
    out.push(f.summary.trim());
    out.push("");
  }

  f.sides.forEach((side, i) => {
    const label = side.label.trim() === "" ? `Site ${String.fromCharCode(65 + i)}` : side.label.trim();
    out.push(`**${label}** — ${citeInstances(f, i)}`);
    out.push("");
    out.push(quoteBlock(side.quote));
    if (side.note) out.push(`\n_${side.note}_`);
    out.push("");
  });

  out.push("**Your options**");
  out.push("");
  for (const o of f.options) {
    const sites = o.editSites.map((e) => `\`${e.relPath}:${e.line}\``).join(", ");
    out.push(`- **${o.id} · ${o.label}** — ${o.consequence}${sites ? ` Edits: ${sites}` : ""}`);
  }
  out.push("");

  const provenance: string[] = [`Found by ${f.seats.join(", ")}`];
  provenance.push(
    f.deterministic
      ? "computed from the document itself, not judged by a model — this one is a fact, not a claim"
      : f.confidence.outcome === "unrefuted"
        ? "not refuted (below the refutation cap) — confidence reflects discovery only"
        : `refuters ${f.confidence.upheld} upheld / ${f.confidence.refuted} refuted${f.confidence.confused > 0 ? ` / ${f.confidence.confused} inconclusive` : ""}`
  );
  if (f.severity.override) {
    provenance.push(
      `severity moved ${f.severity.override.direction} from ${f.severity.override.from} — ${f.severity.override.reason}`
    );
  }
  out.push(`_${provenance.join(" · ")}_`);
  out.push("");

  if (carried) {
    out.push(
      carried.disposition === "change-nothing"
        ? `_You marked this "change nothing" in round ${carried.round}; it is filled in below. Change it if you have changed your mind._`
        : `_You chose option ${carried.optionId} in round ${carried.round}; it is filled in below. Change it if you have changed your mind._`
    );
    out.push("");
  }

  // The two lines the parser reads. Everything above is for the human.
  const tickIf = (cond: boolean) => (cond ? "[x]" : "[ ]");
  const boxes = [
    ...f.options.map((o) => `${tickIf(carried?.disposition === "option" && carried.optionId === o.id)} ${o.id}`),
    `${tickIf(carried?.disposition === "change-nothing")} change nothing`,
    "[ ] comment",
  ];
  out.push(`**Resolution:** ${boxes.join("  ·  ")}`);
  out.push("");
  out.push("**Comment:**");
  out.push("");
  return out.join("\n");
}

const HOW_TO_USE = `## How to use this plan

For each finding, tick exactly one box on its **Resolution:** line:

- **an option letter** — make that change. The apply step edits only the sites
  that option declares, and nothing else.
- **change nothing** — this is not a problem, or not one worth fixing. It is
  recorded, and the same finding will not be raised again in a later round.
- **comment** — write anything under **Comment:** and this finding goes back for
  another look instead of being edited.

No option is recommended. Each one states what it costs and what it drags along;
which passage is actually right is a judgment the documents cannot make.

Any comment text anywhere in this file sends the whole round back for
regeneration — nothing is edited until the plan comes back with no comments on
it. Findings you have already settled carry forward with their answer filled in.

Leaving a finding untouched is not an answer: apply will stop and name it.`;

export function renderPlan(plan: PlanFile): string {
  const byPlacement = (p: Placement) => plan.findings.filter((f) => placementOf(f) === p);
  const main = byPlacement("main");
  const low = byPlacement("low-confidence");
  const refuted = byPlacement("refuted");

  const out: string[] = [];
  out.push(`# Document integrity review — round ${plan.meta.round}`);
  out.push("");
  out.push(
    `${plan.meta.documents.length} document(s), ${plan.meta.documents.reduce((n, d) => n + d.lines, 0)} lines, ` +
      `reviewed as one. Run \`${plan.meta.runId}\`.`
  );
  out.push("");
  for (const d of plan.meta.documents) out.push(`- ${d.id} \`${d.relPath}\` (${d.lines} lines)`);
  out.push("");
  out.push(`Seats: ${plan.meta.seats.join(", ")}.`);
  out.push("");

  if (plan.meta.skipped.length > 0) {
    out.push("**What this run did not do**");
    out.push("");
    for (const s of plan.meta.skipped) out.push(`- ${s}`);
    out.push("");
  }

  out.push(HOW_TO_USE);
  out.push("");
  out.push("---");
  out.push("");
  out.push(`## Findings (${main.length})`);
  out.push("");
  if (main.length === 0) {
    out.push("_Nothing found above the confidence floor. The appendices below are still worth a look._");
    out.push("");
  }
  for (const f of main) {
    out.push(renderFinding(f, plan.carried?.[f.fingerprint]));
    out.push("---");
    out.push("");
  }

  if (low.length > 0) {
    out.push(`## Low confidence (${low.length})`);
    out.push("");
    out.push(
      "_Below the confidence floor. Written out in full rather than dropped — a weak signal is not the same as no signal. These are resolvable exactly like the findings above._"
    );
    out.push("");
    for (const f of low) {
      out.push(renderFinding(f, plan.carried?.[f.fingerprint]));
      out.push("---");
      out.push("");
    }
  }

  if (refuted.length > 0) {
    out.push(`## Refuted (${refuted.length})`);
    out.push("");
    out.push("_Adversarial review killed these. Listed so you can see what was considered and rejected, and why._");
    out.push("");
    for (const f of refuted) {
      out.push(`### ${f.id} · ${f.kind} · refuted (${f.confidence.refuted} of ${f.confidence.upheld + f.confidence.refuted})`);
      out.push("");
      out.push(f.summary.trim());
      out.push("");
      for (const s of f.sides) out.push(`- ${s.instances.map((i) => `\`${i.relPath}:${i.line}\``).join(", ")} — ${quoteInline(s.quote)}`);
      out.push("");
    }
  }

  if (plan.unverifiable.length > 0) {
    out.push(`## Unverifiable claims (${plan.unverifiable.length})`);
    out.push("");
    out.push("_A reviewer reported these but could not ground them in the text. Not dropped silently — but not actionable either._");
    out.push("");
    for (const u of plan.unverifiable) out.push(`- **${u.title}** (${u.seat}) — ${u.reason}`);
    out.push("");
  }

  if (plan.outsideRefs.length > 0) {
    out.push(`## References outside the review set (${plan.outsideRefs.length})`);
    out.push("");
    out.push("_Not checked, by design: this review reads only the documents you passed. Pass these too if you want them verified._");
    out.push("");
    for (const r of plan.outsideRefs) out.push(`- \`${r.relPath}:${r.line}\` → \`${r.target}\``);
    out.push("");
  }

  out.push("## Comments");
  out.push("");
  out.push(
    "_Anything here applies to the whole next round rather than one finding — for example \"stop flagging synonym variation\" or \"treat the spec as authoritative throughout\". Leave it empty if you have nothing to add._"
  );
  out.push("");
  return out.join("\n");
}

function quoteInline(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

export function writePlan(plan: PlanFile, mdPath: string, jsonPath: string): void {
  writeFileSync(mdPath, renderPlan(plan));
  writeFileSync(jsonPath, JSON.stringify(plan, null, 2));
}

// -- parsing --------------------------------------------------------------------------

export type Disposition =
  | { kind: "option"; optionId: string }
  | { kind: "change-nothing" }
  | { kind: "comment"; text: string }
  | { kind: "undecided" }
  | { kind: "error"; reason: string };

export interface ParsedPlan {
  dispositions: Map<string, Disposition>;
  globalComment: string;
  errors: { id: string; reason: string }[];
  unknownIds: string[]; // headings in the markdown with no counterpart in the JSON
  missingIds: string[]; // findings in the JSON with no block in the markdown
}

const FINDING_HEADING_RE = /^###\s+(F-\d+)\b/;
const RESOLUTION_RE = /^\s*(?:\*\*)?Resolution:?(?:\*\*)?\s*(.*)$/i;
const COMMENT_RE = /^\s*(?:\*\*)?Comment:?(?:\*\*)?\s*(.*)$/i;
const GLOBAL_COMMENTS_RE = /^##\s+Comments\s*$/i;
// A ticked box is [x], [X] or [*]; anything else in the brackets is unticked.
const BOX_RE = /\[\s*([xX*])?\s*\]\s*([^[\]·|]+)/g;

// Text the renderer itself put in the comment area. If the human left it alone,
// it is not a comment -- treating boilerplate as feedback would loop forever.
function isBoilerplate(text: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  if (/^_.*_$/s.test(t)) return true; // the italic hint line
  return false;
}

interface Block {
  id: string;
  lines: string[];
}

function splitBlocks(md: string): { blocks: Block[]; globalComment: string } {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let current: Block | null = null;
  let globalFrom = -1;

  for (let i = 0; i < lines.length; i++) {
    if (GLOBAL_COMMENTS_RE.test(lines[i])) {
      if (current) blocks.push(current);
      current = null;
      globalFrom = i + 1;
      continue;
    }
    if (globalFrom !== -1) continue; // everything after ## Comments is global
    const m = FINDING_HEADING_RE.exec(lines[i]);
    if (m) {
      if (current) blocks.push(current);
      current = { id: m[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(lines[i]);
  }
  if (current) blocks.push(current);

  const globalComment = globalFrom === -1 ? "" : lines.slice(globalFrom).join("\n");
  return { blocks, globalComment: isBoilerplate(globalComment) ? "" : globalComment.trim() };
}

// The comment area runs from the Comment: marker to the end of the block, so a
// human can type freely -- multiple paragraphs, lists, quoted text -- without
// tripping a delimiter.
function commentTextOf(block: Block): string {
  const idx = block.lines.findIndex((l) => COMMENT_RE.test(l));
  if (idx === -1) return "";
  const first = COMMENT_RE.exec(block.lines[idx])?.[1] ?? "";
  const rest = block.lines.slice(idx + 1);
  const stop = rest.findIndex((l) => /^---\s*$/.test(l) || /^##\s/.test(l));
  const body = (stop === -1 ? rest : rest.slice(0, stop)).join("\n");
  const text = `${first}\n${body}`.trim();
  return isBoilerplate(text) ? "" : text;
}

function tickedLabels(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(BOX_RE)) {
    if (m[1]) out.push(m[2].trim().replace(/\*+/g, "").toLowerCase());
  }
  return out;
}

function dispositionOf(block: Block, optionIds: string[]): Disposition {
  const comment = commentTextOf(block);
  const resLine = block.lines.find((l) => RESOLUTION_RE.test(l));

  // Comment text wins over any box. Never edit something the human was still
  // talking about -- and never make them remember to also change the tick.
  if (comment !== "") return { kind: "comment", text: comment };

  if (resLine === undefined) return { kind: "error", reason: "no Resolution line found in this finding's block" };
  const ticked = tickedLabels(RESOLUTION_RE.exec(resLine)?.[1] ?? "");

  if (ticked.length === 0) return { kind: "undecided" };
  if (ticked.length > 1) {
    return { kind: "error", reason: `${ticked.length} boxes ticked (${ticked.join(", ")}); tick exactly one` };
  }
  const choice = ticked[0];
  if (choice === "change nothing") return { kind: "change-nothing" };
  if (choice === "comment") {
    return { kind: "error", reason: `"comment" is ticked but no comment text was written` };
  }
  const match = optionIds.find((id) => id.toLowerCase() === choice);
  if (!match) {
    return {
      kind: "error",
      reason: `${JSON.stringify(choice)} is not one of this finding's options (${optionIds.join(", ")})`,
    };
  }
  return { kind: "option", optionId: match };
}

export function parsePlan(md: string, plan: PlanFile): ParsedPlan {
  const { blocks, globalComment } = splitBlocks(md);
  const byId = new Map(plan.findings.map((f) => [f.id, f]));
  const dispositions = new Map<string, Disposition>();
  const errors: { id: string; reason: string }[] = [];
  const unknownIds: string[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const finding = byId.get(block.id);
    if (!finding) {
      unknownIds.push(block.id);
      continue;
    }
    if (seen.has(block.id)) {
      errors.push({ id: block.id, reason: "appears more than once in the plan" });
      continue;
    }
    seen.add(block.id);

    // Refuted findings are shown for the record and carry no Resolution line.
    if (placementOf(finding) === "refuted") continue;

    const d = dispositionOf(block, finding.options.map((o) => o.id));
    dispositions.set(block.id, d);
    if (d.kind === "error") errors.push({ id: block.id, reason: d.reason });
  }

  const missingIds = plan.findings
    .filter((f) => placementOf(f) !== "refuted" && !seen.has(f.id))
    .map((f) => f.id);

  return { dispositions, globalComment, errors, unknownIds, missingIds };
}

// -- what the harness does next ------------------------------------------------------------

export type PlanAction = "APPLY" | "REGENERATE" | "BLOCKED" | "NOT-REVIEWED" | "NOTHING-TO-DO";

export interface PlanStatus {
  action: PlanAction;
  reasons: string[];
  comments: { id: string; text: string }[];
  globalComment: string;
  resolved: { id: string; optionId: string }[];
  declined: string[];
  undecided: string[];
}

export function planStatus(parsed: ParsedPlan): PlanStatus {
  const comments: { id: string; text: string }[] = [];
  const resolved: { id: string; optionId: string }[] = [];
  const declined: string[] = [];
  const undecided: string[] = [];

  for (const [id, d] of parsed.dispositions) {
    if (d.kind === "comment") comments.push({ id, text: d.text });
    else if (d.kind === "option") resolved.push({ id, optionId: d.optionId });
    else if (d.kind === "change-nothing") declined.push(id);
    else if (d.kind === "undecided") undecided.push(id);
  }

  const reasons: string[] = [];
  const base: Omit<PlanStatus, "action"> = {
    reasons,
    comments,
    globalComment: parsed.globalComment,
    resolved,
    declined,
    undecided,
  };

  // A malformed plan is never guessed at, whatever else it also says.
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) reasons.push(`${e.id}: ${e.reason}`);
    for (const id of parsed.unknownIds) reasons.push(`${id}: appears in the plan but not in this run's findings`);
    for (const id of parsed.missingIds) reasons.push(`${id}: is in this run's findings but its block is missing from the plan`);
    return { ...base, action: "BLOCKED" };
  }
  if (parsed.missingIds.length > 0) {
    for (const id of parsed.missingIds) reasons.push(`${id}: is in this run's findings but its block is missing from the plan`);
    return { ...base, action: "BLOCKED" };
  }
  if (parsed.dispositions.size === 0) {
    reasons.push("this run produced no findings that need a decision");
    return { ...base, action: "NOTHING-TO-DO" };
  }
  // Wholly untouched is "not read yet", not a hundred separate mistakes.
  if (undecided.length === parsed.dispositions.size && parsed.globalComment === "") {
    reasons.push("no finding has been given a disposition yet — the plan has not been reviewed");
    return { ...base, action: "NOT-REVIEWED" };
  }
  // Any comment sends the round back before anything is edited.
  if (comments.length > 0 || parsed.globalComment !== "") {
    if (comments.length > 0) reasons.push(`${comments.length} finding(s) carry comments`);
    if (parsed.globalComment !== "") reasons.push("the plan carries a global comment");
    return { ...base, action: "REGENERATE" };
  }
  if (undecided.length > 0) {
    for (const id of undecided) reasons.push(`${id}: no box ticked`);
    return { ...base, action: "BLOCKED" };
  }
  if (resolved.length === 0) {
    reasons.push("every finding was marked \"change nothing\" — there is nothing to edit");
    return { ...base, action: "NOTHING-TO-DO" };
  }
  return { ...base, action: "APPLY" };
}

// -- decisions ledger -------------------------------------------------------------------------

// Keyed by fingerprint, which is derived from quotes rather than line numbers,
// so a decision survives the documents being edited around it.
export interface Decisions {
  declined: { fingerprint: string; title: string; round: number }[];
  resolved: { fingerprint: string; optionId: string; round: number }[];
}

export function emptyDecisions(): Decisions {
  return { declined: [], resolved: [] };
}

export function readDecisions(path: string): Decisions {
  if (!existsSync(path)) return emptyDecisions();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      declined: Array.isArray(raw?.declined) ? raw.declined : [],
      resolved: Array.isArray(raw?.resolved) ? raw.resolved : [],
    };
  } catch {
    // A corrupt ledger must not silently resurrect declined findings, but it
    // also must not stop the run. Empty is the honest read; the round simply
    // re-asks, which is annoying rather than wrong.
    return emptyDecisions();
  }
}

export function writeDecisions(path: string, d: Decisions): void {
  writeFileSync(path, JSON.stringify(d, null, 2));
}

export function recordDecisions(
  prior: Decisions,
  plan: PlanFile,
  status: PlanStatus,
  round: number
): Decisions {
  const byId = new Map(plan.findings.map((f) => [f.id, f]));
  const next: Decisions = { declined: [...prior.declined], resolved: [...prior.resolved] };
  const haveDeclined = new Set(next.declined.map((d) => d.fingerprint));
  const haveResolved = new Set(next.resolved.map((d) => d.fingerprint));

  for (const id of status.declined) {
    const f = byId.get(id);
    if (!f || haveDeclined.has(f.fingerprint)) continue;
    next.declined.push({ fingerprint: f.fingerprint, title: f.title, round });
    haveDeclined.add(f.fingerprint);
  }
  for (const r of status.resolved) {
    const f = byId.get(r.id);
    if (!f || haveResolved.has(f.fingerprint)) continue;
    next.resolved.push({ fingerprint: f.fingerprint, optionId: r.optionId, round });
    haveResolved.add(f.fingerprint);
  }
  return next;
}

export function declinedFingerprints(d: Decisions): Set<string> {
  return new Set(d.declined.map((x) => x.fingerprint));
}

export function loadPlanFile(path: string): PlanFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Cannot read plan JSON at ${path}: ${(e as Error).message}`);
  }
  const p = raw as Partial<PlanFile>;
  if (p?.schema !== PLAN_SCHEMA_VERSION) {
    throw new ZError(`Plan schema ${JSON.stringify(p?.schema)} (this binary understands ${PLAN_SCHEMA_VERSION}).`);
  }
  if (!Array.isArray(p.findings)) throw new ZError(`Plan JSON at ${path} has no findings array.`);
  return p as PlanFile;
}

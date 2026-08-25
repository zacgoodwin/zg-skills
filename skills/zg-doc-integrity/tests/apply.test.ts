// Gate tests for lib/apply.ts and lib/regenerate.ts.
//
// Apply is the only code here that writes to the user's files, so the tests
// that matter most are the ones asserting it REFUSES: an unapproved change, a
// promised edit that never happened, two findings fighting over one line.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appliedFindings,
  applyBrief,
  conflictingEdits,
  diffLines,
  planEdits,
  snapshotFiles,
  verifyAll,
  verifyFile,
  type FileWorkUnit,
} from "../lib/apply.ts";
import { loadBundle, type Bundle } from "../lib/bundle.ts";
import { type Finding } from "../lib/findings.ts";
import { parsePlan, planStatus, PLAN_SCHEMA_VERSION, renderPlan, type PlanFile } from "../lib/plan.ts";
import { assembleNextRound, carryForward, MAX_ROUNDS, optionsMatch, regenBrief } from "../lib/regenerate.ts";

let scratch: string;
let n = 0;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "apply-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

function bundleOf(docs: Record<string, string>): Bundle {
  const dir = join(scratch, `b${n++}`);
  mkdirSync(dir, { recursive: true });
  const names = Object.keys(docs);
  for (const name of names) writeFileSync(join(dir, name), docs[name]);
  return loadBundle(names, dir, dir);
}

const DOCS = {
  "api.md": "# API\n\nTokens expire after 24 hours.\n\nMore prose here.\n",
  "auth.md": "# Auth\n\nTokens are valid for 7 days.\n\nOther text.\n",
};

function finding(bundle: Bundle, over: Partial<Finding> = {}): Finding {
  // Single-document bundles are used by tests that override sides and options
  // outright; the defaults just have to be constructible.
  const second = bundle.docs[1] ?? bundle.docs[0];
  const inA = { docId: "D1", relPath: bundle.docs[0].relPath, line: 3, quote: "Tokens expire after 24 hours.", quality: "exact" as const };
  const inB = { docId: second.id, relPath: second.relPath, line: 3, quote: "Tokens are valid for 7 days.", quality: "exact" as const };
  return {
    id: "F-01",
    kind: "contradiction",
    title: "Token lifetime disagrees",
    summary: "s",
    sides: [
      { label: "A", quote: inA.quote, instances: [inA] },
      { label: "B", quote: inB.quote, instances: [inB] },
    ],
    options: [
      { id: "A", label: "align on 24 hours", consequence: "1 edit.", editSites: [inB], replacements: ["Tokens expire after 24 hours."] },
      { id: "B", label: "align on 7 days", consequence: "1 edit.", editSites: [inA], replacements: ["Tokens are valid for 7 days."] },
    ],
    severity: { score: 11, band: "high", factors: { modality: 3, detectability: 3, blast: 1, hazard: 0 } },
    confidence: { base: 70, delta: 25, score: 95, outcome: "all-upheld", upheld: 3, refuted: 0, confused: 0 },
    seats: ["shard-1"],
    fingerprint: "fp-one",
    ...over,
  };
}

function planFile(bundle: Bundle, findings: Finding[]): PlanFile {
  return {
    schema: PLAN_SCHEMA_VERSION,
    meta: {
      runId: "run-20260102-030405-abcd",
      round: 1,
      documents: bundle.docs.map((d) => ({ id: d.id, relPath: d.relPath, lines: d.lines.length })),
      seats: ["shard-1"],
      refutedCount: 1,
      skipped: [],
    },
    findings,
    unverifiable: [],
    outsideRefs: [],
  };
}

function tick(md: string, id: string, label: string): string {
  const start = md.indexOf(`### ${id} `);
  const nextHeading = md.indexOf("\n### ", start + 1);
  const end = nextHeading === -1 ? md.length : nextHeading;
  const block = md.slice(start, end).replace(new RegExp(`\\[ \\] ${label}\\b`), `[x] ${label}`);
  return md.slice(0, start) + block + md.slice(end);
}

function statusFor(plan: PlanFile, picks: [string, string][]) {
  let md = renderPlan(plan);
  for (const [id, label] of picks) md = tick(md, id, label);
  return planStatus(parsePlan(md, plan));
}

describe("planEdits", () => {
  test("groups by file so two agents never share a document", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b), finding(b, { id: "F-02", fingerprint: "fp-two" })]);
    // Both findings pick option A, which edits auth.md.
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "A"], ["F-02", "A"]]));
    expect(units).toHaveLength(1);
    expect(units[0].relPath).toContain("auth.md");
    expect(units[0].edits).toHaveLength(2);
  });

  test("only the chosen option's sites are planned", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "B"]]));
    expect(units).toHaveLength(1);
    expect(units[0].relPath).toContain("api.md");
    expect(units[0].edits[0].optionId).toBe("B");
  });

  test("a declined finding contributes no edits", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    expect(planEdits(b, plan, statusFor(plan, [["F-01", "change nothing"]]))).toEqual([]);
  });

  test("edits within a file are ordered by line", () => {
    const b = bundleOf({ "a.md": "one\ntwo\nthree\nfour\n" });
    const site = (line: number, quote: string) => ({ docId: "D1", relPath: "a.md", line, quote, quality: "exact" as const });
    const f = finding(b, {
      sides: [{ label: "A", quote: "one", instances: [site(1, "one")] }],
      options: [
        {
          id: "A",
          label: "fix",
          consequence: "",
          editSites: [site(3, "three"), site(1, "one")],
          replacements: ["THREE", "ONE"],
        },
        { id: "B", label: "other", consequence: "", editSites: [site(2, "two")], replacements: ["TWO"] },
      ],
    });
    const plan = planFile(b, [f]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "A"]]));
    expect(units[0].edits.map((e) => e.site.line)).toEqual([1, 3]);
  });
});

describe("conflictingEdits", () => {
  test("two findings editing one line is a conflict the human must settle", () => {
    const site = { docId: "D1", relPath: "a.md", line: 3, quote: "x", quality: "exact" as const };
    const units: FileWorkUnit[] = [
      {
        docId: "D1",
        relPath: "a.md",
        absPath: "/tmp/a.md",
        edits: [
          { findingId: "F-01", optionId: "A", optionLabel: "one", site },
          { findingId: "F-02", optionId: "A", optionLabel: "two", site },
        ],
      },
    ];
    expect(conflictingEdits(units)[0]).toMatch(/edited by F-01 and F-02/);
  });

  test("one finding editing a line twice is not a conflict", () => {
    const site = { docId: "D1", relPath: "a.md", line: 3, quote: "x", quality: "exact" as const };
    const units: FileWorkUnit[] = [
      {
        docId: "D1",
        relPath: "a.md",
        absPath: "/tmp/a.md",
        edits: [
          { findingId: "F-01", optionId: "A", optionLabel: "one", site },
          { findingId: "F-01", optionId: "A", optionLabel: "one", site },
        ],
      },
    ];
    expect(conflictingEdits(units)).toEqual([]);
  });
});

describe("diffLines", () => {
  test("an unchanged file has no changes", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  test("a modified line is reported at its original position", () => {
    expect(diffLines(["a", "b", "c"], ["a", "B", "c"])).toEqual([{ line: 2, kind: "changed" }]);
  });

  test("insertions and deletions are located, not smeared across the file", () => {
    expect(diffLines(["a", "c"], ["a", "b", "c"])).toEqual([{ line: 2, kind: "added" }]);
    expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual([{ line: 2, kind: "removed" }]);
  });

  test("trailing changes are caught", () => {
    expect(diffLines(["a"], ["a", "b"])).toEqual([{ line: 2, kind: "added" }]);
    expect(diffLines(["a", "b"], ["a"])).toEqual([{ line: 2, kind: "removed" }]);
  });
});

describe("verifyFile", () => {
  const unit = (): FileWorkUnit => ({
    docId: "D1",
    relPath: "a.md",
    absPath: "/tmp/a.md",
    edits: [
      {
        findingId: "F-01",
        optionId: "A",
        optionLabel: "align",
        site: { docId: "D1", relPath: "a.md", line: 3, quote: "Tokens last 7 days.", quality: "exact" },
        replacement: "Tokens last 1 day.",
      },
    ],
  });

  const before = "# Doc\n\nTokens last 7 days.\n\nOther prose.\n";

  test("the approved edit, made exactly, passes", () => {
    const after = "# Doc\n\nTokens last 1 day.\n\nOther prose.\n";
    const r = verifyFile(unit(), before, after);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(["F-01:A"]);
    expect(r.blast).toEqual([]);
  });

  test("a promised edit that never happened fails", () => {
    const r = verifyFile(unit(), before, before);
    expect(r.ok).toBe(false);
    expect(r.notApplied[0]).toMatch(/the quoted text is unchanged/);
  });

  test("a helpful extra change fails the run -- it was reviewed by nobody", () => {
    const after = "# Doc\n\nTokens last 1 day.\n\nOther prose, tidied up.\n";
    const r = verifyFile(unit(), before, after);
    expect(r.ok).toBe(false);
    expect(r.blast[0]).toMatch(/a\.md:5 changed, outside every site this plan approved/);
  });

  test("an unrelated insertion elsewhere fails", () => {
    const after = "# Doc\n\nTokens last 1 day.\n\nOther prose.\n\nA new paragraph.\n";
    expect(verifyFile(unit(), before, after).ok).toBe(false);
  });

  test("a one-line rewrap at the site is inside the slack", () => {
    const after = "# Doc\n\nTokens last\n1 day.\n\nOther prose.\n";
    const r = verifyFile(unit(), before, after);
    expect(r.blast).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("deleting the whole file's contents is caught, not read as a big edit", () => {
    expect(verifyFile(unit(), before, "").ok).toBe(false);
  });
});

describe("snapshot and verifyAll", () => {
  test("snapshots are taken before edits and drive the restore hint", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "B"]]));
    const snapDir = join(scratch, `snap${n++}`);
    const snaps = snapshotFiles(units, snapDir);

    expect(readFileSync(snaps[0].snapshotPath, "utf8")).toBe(DOCS["api.md"]);

    // An agent that did the edit AND something else.
    writeFileSync(units[0].absPath, "# API\n\nTokens are valid for 7 days.\n\nMore prose, improved.\n");
    const report = verifyAll(units, snaps);
    expect(report.ok).toBe(false);
    expect(report.restoreHints[0]).toContain(snaps[0].snapshotPath);
  });

  test("a clean apply reports ok with the findings that landed", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "B"]]));
    const snaps = snapshotFiles(units, join(scratch, `snap${n++}`));
    writeFileSync(units[0].absPath, "# API\n\nTokens are valid for 7 days.\n\nMore prose here.\n");
    const report = verifyAll(units, snaps);
    expect(report.ok).toBe(true);
    expect(appliedFindings(report)).toEqual(["F-01"]);
  });

  test("verifying without a snapshot is refused rather than skipped", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "B"]]));
    expect(() => verifyAll(units, [])).toThrow(/No snapshot recorded/);
  });
});

describe("applyBrief", () => {
  test("names the file, the exact edits, and forbids everything else", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "B"]]));
    const brief = applyBrief(units[0], b.docs[0]);
    expect(brief).toContain(units[0].absPath);
    expect(brief).toContain("Tokens expire after 24 hours.");
    expect(brief).toContain("Tokens are valid for 7 days.");
    expect(brief).toMatch(/Do not fix spelling/);
    expect(brief).toMatch(/including changes that improve the document/);
  });

  test("the agent is never shown the option that was not chosen", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "B"]]));
    const brief = applyBrief(units[0], b.docs[0]);
    expect(brief).toContain("align on 7 days");
    expect(brief).not.toContain("align on 24 hours");
  });

  test("an option with no stated replacement asks for the smallest rewrite", () => {
    const b = bundleOf(DOCS);
    const f = finding(b);
    f.options[1].replacements = [undefined];
    const plan = planFile(b, [f]);
    const units = planEdits(b, plan, statusFor(plan, [["F-01", "B"]]));
    expect(applyBrief(units[0], b.docs[0])).toMatch(/changing as few words as possible/);
  });
});

describe("regeneration", () => {
  test("optionsMatch sees a changed option list", () => {
    const b = bundleOf(DOCS);
    const before = finding(b);
    const after = finding(b);
    expect(optionsMatch(before, after)).toBe(true);

    const withThird = finding(b);
    withThird.options = [...withThird.options, { id: "C", label: "split", consequence: "", editSites: [], replacements: [] }];
    expect(optionsMatch(before, withThird)).toBe(false);

    const relabelled = finding(b);
    relabelled.options[0].label = "align on one day instead";
    expect(optionsMatch(before, relabelled)).toBe(false);
  });

  test("a settled answer carries forward pre-filled", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const status = statusFor(plan, [["F-01", "A"]]);
    const { carried, reopened } = carryForward(plan, status, [finding(b)], 1);
    expect(carried["fp-one"]).toEqual({ disposition: "option", optionId: "A", round: 1 });
    expect(reopened).toEqual([]);
  });

  test("a carried answer is dropped when the options changed, and says why", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const status = statusFor(plan, [["F-01", "A"]]);
    const changed = finding(b);
    changed.options = [...changed.options, { id: "C", label: "split", consequence: "", editSites: [], replacements: [] }];
    const { carried, reopened } = carryForward(plan, status, [changed], 1);
    expect(carried["fp-one"]).toBeUndefined();
    expect(reopened[0].reason).toMatch(/options changed/);
  });

  test("a 'change nothing' carries forward even when the options changed", () => {
    // The answer was about the finding, not about which way out to take.
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const status = statusFor(plan, [["F-01", "change nothing"]]);
    const changed = finding(b);
    changed.options = [changed.options[0]];
    const { carried } = carryForward(plan, status, [changed], 1);
    expect(carried["fp-one"]).toEqual({ disposition: "change-nothing", round: 1 });
  });

  test("an answer to a finding that no longer exists is discarded", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const status = statusFor(plan, [["F-01", "A"]]);
    expect(carryForward(plan, status, [], 1).carried).toEqual({});
  });

  test("answers from earlier rounds stay in force", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b, { id: "F-02", fingerprint: "fp-two" })]);
    plan.carried = { "fp-one": { disposition: "change-nothing", round: 1 } };
    const kept = finding(b);
    const { carried } = carryForward(plan, statusFor(plan, [["F-02", "A"]]), [kept, finding(b, { fingerprint: "fp-two" })], 2);
    expect(carried["fp-one"]).toEqual({ disposition: "change-nothing", round: 1 });
  });

  test("the carried tick is rendered pre-filled with a note", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    plan.carried = { "fp-one": { disposition: "option", optionId: "B", round: 1 } };
    const md = renderPlan(plan);
    expect(md).toContain("[ ] A  ·  [x] B");
    expect(md).toMatch(/You chose option B in round 1/);
    // And it parses straight back to that answer.
    expect(planStatus(parsePlan(md, plan)).resolved).toEqual([{ id: "F-01", optionId: "B" }]);
  });

  test("only commented findings are re-derived; the rest carry across verbatim", () => {
    const b = bundleOf(DOCS);
    const f1 = finding(b);
    const f2 = finding(b, { id: "F-02", fingerprint: "fp-two" });
    const plan = planFile(b, [f1, f2]);
    const status = {
      ...statusFor(plan, [["F-01", "A"], ["F-02", "A"]]),
      comments: [{ id: "F-02", text: "this is scoped to staging" }],
    };
    const next = assembleNextRound({ prior: plan, status, regenerated: [{ findingId: "F-02", findings: [] }] });
    expect(next.untouched.map((f) => f.id)).toEqual(["F-01"]);
    expect(next.dropped[0].reason).toBe("this is scoped to staging");
    expect(next.replacements).toEqual([]);
  });

  test("a regeneration that returns findings replaces the commented one", () => {
    const b = bundleOf(DOCS);
    const plan = planFile(b, [finding(b)]);
    const status = { ...statusFor(plan, [["F-01", "A"]]), comments: [{ id: "F-01", text: "add a third way" }] };
    const raw = { kind: "contradiction" as const, title: "t", summary: "s", sides: [], options: [] };
    const next = assembleNextRound({ prior: plan, status, regenerated: [{ findingId: "F-01", findings: [raw] }] });
    expect(next.untouched).toEqual([]);
    expect(next.replacements[0].seat).toBe("regen:F-01");
  });

  test("the regen brief carries the comment, the options, and the surrounding text", () => {
    const b = bundleOf(DOCS);
    const brief = regenBrief({
      finding: finding(b),
      comment: "these are scoped to different environments",
      globalComment: "",
      bundle: b,
      findingsPath: "/run/f.json",
    });
    expect(brief).toContain("these are scoped to different environments");
    expect(brief).toContain("align on 24 hours");
    expect(brief).toContain("Tokens expire after 24 hours.");
    expect(brief).toMatch(/Return\s+\{"findings": \[\]\}/);
    expect(brief).toMatch(/strictly internal/);
  });

  test("a global comment is injected as a standing instruction", () => {
    const b = bundleOf(DOCS);
    const brief = regenBrief({
      finding: finding(b),
      comment: "look again",
      globalComment: "stop flagging synonym variation",
      bundle: b,
      findingsPath: "/run/f.json",
    });
    expect(brief).toMatch(/standing instruction for this whole review/);
    expect(brief).toContain("stop flagging synonym variation");
  });

  test("the round cap exists and is small enough to actually stop a loop", () => {
    expect(MAX_ROUNDS).toBeLessThanOrEqual(5);
  });
});

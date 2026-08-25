// Gate tests for the eval scorer. A scorer that quietly over-credits is worse
// than no eval, so the cases here are mostly about what must NOT count as a
// match.
import { describe, expect, test } from "bun:test";
import { defectMatched, quotesOverlap, render, score, type GroundTruth, type ScoredFinding } from "../evals/lib/score.ts";

const truth: GroundTruth = {
  seeded: [
    {
      id: "timeout",
      kind: "numeric-conflict",
      summary: "30s vs 60s",
      sides: [["The request timeout is 30s by default."], ["The request timeout is 60s by default."]],
    },
    {
      id: "dupe-heading",
      kind: "structure",
      summary: "two #errors headings",
      sides: [["## Errors"]],
    },
  ],
  traps: [{ id: "changelog", why: "historical" }],
};

const finding = (over: Partial<ScoredFinding> = {}): ScoredFinding => ({
  id: "F-01",
  kind: "numeric-conflict",
  title: "Timeout disagrees",
  quotes: ["The request timeout is 30s by default.", "The request timeout is 60s by default."],
  severity: "high",
  confidence: 95,
  seats: ["shard-1"],
  placement: "main",
  ...over,
});

describe("quotesOverlap", () => {
  test("matches a longer or shorter span of the same sentence", () => {
    expect(quotesOverlap("The request timeout is 30s by default.", "request timeout is 30s")).toBe(true);
  });

  test("ignores whitespace and case differences", () => {
    expect(quotesOverlap("The  request   timeout is 30s.", "the request timeout is 30s.")).toBe(true);
  });

  test("does not match different sentences that share words", () => {
    expect(quotesOverlap("The request timeout is 30s.", "The request timeout is 60s.")).toBe(false);
  });

  test("short strings must match exactly, so a fragment cannot claim a defect", () => {
    expect(quotesOverlap("30s", "timeout 30s")).toBe(false);
    expect(quotesOverlap("## Errors", "## Errors")).toBe(true);
  });
});

describe("defectMatched", () => {
  test("a two-sided defect needs both sides -- half a contradiction is not a find", () => {
    expect(defectMatched(truth.seeded[0], finding())).toBe(true);
    expect(defectMatched(truth.seeded[0], finding({ quotes: ["The request timeout is 30s by default."] }))).toBe(false);
  });

  test("a one-quote defect needs its quote", () => {
    expect(defectMatched(truth.seeded[1], finding({ quotes: ["## Errors"] }))).toBe(true);
    expect(defectMatched(truth.seeded[1], finding({ quotes: ["## Configuration"] }))).toBe(false);
  });

  test("a finding with the right title but the wrong quotes does not count", () => {
    expect(defectMatched(truth.seeded[0], finding({ title: "timeout", quotes: ["something else entirely here"] }))).toBe(false);
  });
});

describe("score", () => {
  test("full recall with no extras", () => {
    const s = score(truth, [finding(), finding({ id: "F-02", quotes: ["## Errors"] })]);
    expect(s.found).toBe(2);
    expect(s.recall).toBe(1);
    expect(s.extra).toEqual([]);
  });

  test("a missed defect is named with the seat that should have caught it", () => {
    const withReach: GroundTruth = {
      ...truth,
      seeded: [{ ...truth.seeded[0], reachableBy: ["numeric-cluster"] }],
    };
    const s = score(withReach, []);
    expect(s.recall).toBe(0);
    expect(s.missed[0].reachableBy).toEqual(["numeric-cluster"]);
  });

  test("a finding matching nothing in ground truth is counted separately, not as a match", () => {
    const s = score(truth, [finding(), finding({ id: "F-09", title: "Invented", quotes: ["nothing like the fixture text"] })]);
    expect(s.found).toBe(1);
    expect(s.extra).toHaveLength(1);
    expect(s.extra[0].id).toBe("F-09");
  });

  test("one finding cannot be credited with two defects", () => {
    const s = score(truth, [finding({ quotes: [...truth.seeded[0].sides.flat(), "## Errors"] })]);
    expect(s.found).toBe(2);
    // Still one finding, so nothing is left over.
    expect(s.extra).toEqual([]);
  });

  test("confidence separation between matched and unmatched is reported", () => {
    const s = score(truth, [
      finding({ confidence: 90 }),
      finding({ id: "F-09", quotes: ["unrelated"], confidence: 30 }),
    ]);
    expect(s.meanConfidenceMatched).toBe(90);
    expect(s.meanConfidenceExtra).toBe(30);
  });

  test("an empty run scores zero recall rather than dividing by zero", () => {
    const s = score(truth, []);
    expect(s.recall).toBe(0);
    expect(s.extraRate).toBe(0);
  });
});

describe("placement", () => {
  test("a defect buried in the refuted appendix counts as found but NOT surfaced", () => {
    // The first eval run refuted a verifiable duplicate heading. Recall said
    // 7/7 and the reader would have acted on 5 -- the gap this reports.
    const s = score(truth, [finding({ placement: "refuted" }), finding({ id: "F-02", quotes: ["## Errors"] })]);
    expect(s.found).toBe(2);
    expect(s.surfaced).toBe(1);
    expect(s.buried).toHaveLength(1);
    expect(s.buried[0].placement).toBe("refuted");
  });

  test("a low-confidence defect is also not surfaced", () => {
    const s = score(truth, [finding({ placement: "low-confidence" })]);
    expect(s.found).toBe(1);
    expect(s.surfaced).toBe(0);
  });

  test("the render names buried defects separately from missed ones", () => {
    const text = render(score(truth, [finding({ placement: "refuted" })]));
    expect(text).toContain("FOUND BUT BURIED");
    expect(text).toContain("MISSED:");
  });
});

describe("render", () => {
  test("names what was missed and what was extra, never just a number", () => {
    const text = render(score(truth, [finding({ id: "F-09", quotes: ["unrelated text here please"] })]));
    expect(text).toMatch(/recall\s+0\/2/);
    expect(text).toContain("MISSED:");
    expect(text).toContain("NOT IN GROUND TRUTH");
  });
});

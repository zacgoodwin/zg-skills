// Gate tests for the vendored eval scorer (evals/lib/recall.ts): the paid
// lane's every count, mean, and threshold is computed there in code, so the
// scoring itself must be free to verify.
import { describe, expect, test } from "bun:test";
import {
  hasExitMarker,
  readTrialGrade,
  requiredPasses,
  scoreRun,
  type DefectKey,
  type TrialGrade,
} from "../evals/lib/recall.ts";

const DEFECTS: DefectKey[] = [
  { id: "D1", site: "a.ts", summary: "x" },
  { id: "D2", site: "b.ts", summary: "y" },
];

function grade(single: boolean[], adversarial: boolean[], marker = "REVIEW-FINDINGS"): TrialGrade {
  return {
    single: { D1: single[0]!, D2: single[1]! },
    adversarial: { D1: adversarial[0]!, D2: adversarial[1]! },
    singleUnmatched: 0,
    adversarialUnmatched: 0,
    singleMarker: marker,
    adversarialMarker: marker,
  };
}

describe("readTrialGrade", () => {
  const raw = (j: string) => readTrialGrade(j, DEFECTS);

  test("bare JSON parses", () => {
    const r = raw('{"single":{"D1":true,"D2":false},"adversarial":{"D1":true,"D2":true},"singleMarker":"REVIEW-FINDINGS","adversarialMarker":"REVIEW-FINDINGS"}');
    expect(r.status).toBe("ok");
  });

  test("fenced JSON parses (the real grader's observed shape)", () => {
    const r = raw('```json\n{"single":{"D1":true,"D2":false},"adversarial":{"D1":true,"D2":true}}\n```');
    expect(r.status).toBe("ok");
  });

  test("a missing defect id is UNREADABLE, never a graded miss", () => {
    const r = raw('{"single":{"D1":true},"adversarial":{"D1":true,"D2":true}}');
    expect(r.status).toBe("unreadable");
  });

  test("prose with no JSON is UNREADABLE with a preview", () => {
    const r = raw("I could not grade this trial.");
    expect(r.status).toBe("unreadable");
  });
});

describe("scoreRun", () => {
  test("passes at 4/5 strict wins with all verdicts reported", () => {
    const win = grade([true, false], [true, true]);
    const tie = grade([true, false], [true, false]);
    const run = scoreRun([win, win, win, win, tie], DEFECTS);
    expect(run.passes).toBe(4);
    expect(run.pass).toBe(true);
  });

  test("fails below the ratio threshold", () => {
    const win = grade([true, false], [true, true]);
    const tie = grade([true, false], [true, false]);
    expect(scoreRun([win, win, win, tie, tie], DEFECTS).pass).toBe(false);
  });

  test("one silent stage fails the run even at 5/5 recall wins", () => {
    const win = grade([true, false], [true, true]);
    const silent = { ...grade([true, false], [true, true]), adversarialMarker: "NONE" };
    const run = scoreRun([win, win, win, win, silent], DEFECTS);
    expect(run.passes).toBe(5);
    expect(run.markersPass).toBe(false);
    expect(run.pass).toBe(false);
    expect(run.markerMisses).toEqual([{ trial: 5, mode: "adversarial", reported: "NONE" }]);
  });
});

describe("thresholds and markers", () => {
  test("requiredPasses keeps the 80% ratio at every trial count", () => {
    expect(requiredPasses(5)).toBe(4);
    expect(requiredPasses(3)).toBe(3);
    expect(requiredPasses(1)).toBe(1);
  });

  test("hasExitMarker accepts decorated verdicts and rejects silence", () => {
    expect(hasExitMarker("REVIEW-APPROVE: all criteria hold")).toBe(true);
    expect(hasExitMarker("`CONFUSED`")).toBe(true);
    expect(hasExitMarker("NONE")).toBe(false);
    expect(hasExitMarker("the reviewer wrote a summary")).toBe(false);
  });
});

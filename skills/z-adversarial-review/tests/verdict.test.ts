// Gate tests for lib/verdict.ts: the envelope check and the off-disk quorum.
// INVALID is an answer, and every invalid shape must be named, never
// reinterpreted.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  quorumFromDisk,
  readVerdict,
  VERDICT_SCHEMA_VERSION,
  verdictInstructions,
  type ExpectedSpawn,
} from "../lib/verdict.ts";

const RUN = "run-20260101-000000-aaaa";
const EXPECT: ExpectedSpawn = { runId: RUN, ticket: 7, stage: "reviewer", attempt: 1 };

const scratch = mkdtempSync(join(tmpdir(), "verdict-test-"));
let n = 0;
function writeFile(content: string): string {
  const p = join(scratch, `v-${++n}.json`);
  writeFileSync(p, content);
  return p;
}
function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: VERDICT_SCHEMA_VERSION,
    runId: RUN,
    ticket: 7,
    stage: "reviewer",
    attempt: 1,
    result: "REVIEW-FINDINGS",
    notes: "1. util.ts:4 breaks AC1",
    ...overrides,
  });
}

describe("readVerdict", () => {
  test("a well-addressed verdict round-trips", () => {
    const r = readVerdict(writeFile(envelope()), EXPECT);
    if (!r.ok) throw new Error(r.reason);
    expect(r.verdict.result).toBe("REVIEW-FINDINGS");
  });

  test("missing file, bad JSON, and a non-object are INVALID with reasons", () => {
    expect(readVerdict(join(scratch, "nope.json"), EXPECT).ok).toBe(false);
    expect(readVerdict(writeFile("{not json"), EXPECT).ok).toBe(false);
    expect(readVerdict(writeFile('"a string"'), EXPECT).ok).toBe(false);
  });

  test("every mis-addressed envelope field is INVALID and names the field", () => {
    for (const [key, bad] of [
      ["runId", "run-20990101-000000-ffff"],
      ["ticket", 8],
      ["stage", "skeptic"],
      ["attempt", 2],
      ["schema", VERDICT_SCHEMA_VERSION + 1],
    ] as const) {
      const r = readVerdict(writeFile(envelope({ [key]: bad })), EXPECT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(key === "schema" ? "schema" : key);
    }
  });

  test("a result outside the stage's union is INVALID", () => {
    const r = readVerdict(writeFile(envelope({ result: "LGTM" })), EXPECT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("union");
  });

  test("a pasted template (placeholder notes) is INVALID", () => {
    const r = readVerdict(writeFile(envelope({ notes: "<numbered findings, each with file:line>" })), EXPECT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("placeholder");
  });

  test("evidence must be an object when present", () => {
    const r = readVerdict(writeFile(envelope({ evidence: [1, 2] })), EXPECT);
    expect(r.ok).toBe(false);
  });
});

describe("quorumFromDisk", () => {
  // Build the run tree the path-trust rule expects: runRoot/t7/reviewer-1/skeptic-k.
  const runRoot = join(scratch, "runs", RUN);
  const reviewerDir = join(runRoot, "t7", "reviewer-1");
  function skepticFile(k: number, result: string): string {
    const p = join(reviewerDir, `skeptic-${k}`, "verdict.json");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, envelope({ stage: "skeptic", result, notes: "attacked X" }));
    return p;
  }

  test("counts valid files, tallies UPHELD, names every unusable path", () => {
    const s1 = skepticFile(1, "UPHELD");
    const s2 = skepticFile(2, "REFUTED");
    const missing = join(reviewerDir, "skeptic-3", "verdict.json");
    const outside = join(scratch, "elsewhere.json");
    writeFileSync(outside, envelope({ stage: "skeptic", result: "UPHELD" }));

    const q = quorumFromDisk([s1, s2, missing, outside, s1], runRoot, EXPECT);
    expect(q.received).toBe(2);
    expect(q.unrefuted).toBe(1);
    expect(q.of).toBe(3);
    // missing file + outside-tree path + duplicate listing, each named.
    expect(q.invalid).toHaveLength(3);
    expect(q.invalid.join("\n")).toContain("outside");
    expect(q.invalid.join("\n")).toContain("listed twice");
  });
});

describe("verdictInstructions", () => {
  test("renders the path, the envelope values, the union, and the fixed final line", () => {
    const t = verdictInstructions("skeptic", "/tmp/sk1/verdict.json", { ...EXPECT, stage: "skeptic" });
    expect(t).toContain("/tmp/sk1/verdict.json");
    expect(t).toContain(`"runId": "${RUN}"`);
    expect(t).toContain('"REFUTED"');
    expect(t).toContain('"UPHELD"');
    expect(t).toContain("verdict written");
  });
});

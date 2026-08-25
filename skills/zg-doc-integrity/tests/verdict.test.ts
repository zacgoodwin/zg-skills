// Gate tests for lib/verdict.ts. Every branch that turns a verdict INVALID has
// a case, because each one is a way an agent could otherwise speak for a spawn
// it does not represent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZError } from "../lib/cli.ts";
import { mintRunId, runRoot, stageDest } from "../lib/run-id.ts";
import {
  pathInsideRunTree,
  quorumFromDisk,
  readVerdict,
  STAGE_RESULTS,
  VERDICT_SCHEMA_VERSION,
  verdictInstructions,
  type ExpectedSpawn,
} from "../lib/verdict.ts";

let scratch: string;
const RUN = mintRunId(Date.parse("2026-01-02T03:04:05Z"), "abcd");
const EXPECT: ExpectedSpawn = { runId: RUN, round: 1, stage: "refute", attempt: 1 };

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "verdict-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

let seq = 0;
function writeVerdict(body: unknown): string {
  const dir = join(scratch, `v${seq++}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "verdict.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

const good = (over: Record<string, unknown> = {}) => ({
  schema: VERDICT_SCHEMA_VERSION,
  runId: RUN,
  round: 1,
  stage: "refute",
  attempt: 1,
  result: "UPHELD",
  notes: "a reader following the first passage deletes the wrong table",
  ...over,
});

describe("readVerdict", () => {
  test("accepts a well-addressed verdict", () => {
    const check = readVerdict(writeVerdict(good()), EXPECT);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.verdict.result).toBe("UPHELD");
  });

  test("a missing file is an answer, not a throw", () => {
    const check = readVerdict(join(scratch, "nope", "verdict.json"), EXPECT);
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toMatch(/no verdict file/);
  });

  test("malformed JSON is invalid", () => {
    const check = readVerdict(writeVerdict("{ not json"), EXPECT);
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toMatch(/not valid JSON/);
  });

  test("a JSON array is not a verdict", () => {
    const check = readVerdict(writeVerdict([1, 2]), EXPECT);
    if (!check.ok) expect(check.reason).toMatch(/not a JSON object/);
  });

  test("a future or absent schema is invalid", () => {
    for (const schema of [2, undefined, "1"]) {
      const check = readVerdict(writeVerdict(good({ schema })), EXPECT);
      expect(check.ok).toBe(false);
    }
  });

  test("every envelope field must address this exact spawn", () => {
    for (const over of [{ runId: mintRunId(Date.now(), "0000") }, { round: 2 }, { stage: "discover" }, { attempt: 2 }]) {
      const check = readVerdict(writeVerdict(good(over)), EXPECT);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toMatch(/does not match this spawn/);
    }
  });

  test("a result outside the stage union is invalid", () => {
    // FINDINGS is a real result -- for the other stage. Borrowing it is invalid.
    const check = readVerdict(writeVerdict(good({ result: "FINDINGS" })), EXPECT);
    if (!check.ok) expect(check.reason).toMatch(/is not in refute's union/);
  });

  test("a pasted template placeholder is invalid rather than reinterpreted", () => {
    const check = readVerdict(writeVerdict(good({ notes: "<one line: the reason>" })), EXPECT);
    if (!check.ok) expect(check.reason).toMatch(/placeholder/);
  });

  test("evidence must be an object when present", () => {
    expect(readVerdict(writeVerdict(good({ evidence: "nope" })), EXPECT).ok).toBe(false);
    expect(readVerdict(writeVerdict(good({ evidence: ["a"] })), EXPECT).ok).toBe(false);
    expect(readVerdict(writeVerdict(good({ evidence: { attack: "scope" } })), EXPECT).ok).toBe(true);
  });

  test("a bad expectation is a caller bug and throws", () => {
    expect(() => readVerdict(writeVerdict(good()), { ...EXPECT, runId: "not-a-run-id" })).toThrow(ZError);
    expect(() => readVerdict(writeVerdict(good()), { ...EXPECT, stage: "nonsense" as any })).toThrow(ZError);
  });
});

describe("quorumFromDisk", () => {
  const root = () => {
    const state = join(scratch, `q${seq++}`);
    return { state, root: runRoot(state, RUN) };
  };

  function refuterVerdict(dir: string, result: string, over: Record<string, unknown> = {}): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "verdict.json");
    writeFileSync(p, JSON.stringify(good({ result, ...over })));
    return p;
  }

  test("counts upheld, refuted and confused off the files", () => {
    const { state, root: r } = root();
    const paths = [
      refuterVerdict(stageDest(state, RUN, 1, "refute", 1), "UPHELD"),
      refuterVerdict(join(stageDest(state, RUN, 1, "refute", 1), "b"), "REFUTED"),
      refuterVerdict(join(stageDest(state, RUN, 1, "refute", 1), "c"), "CONFUSED"),
    ];
    const q = quorumFromDisk(paths, r, EXPECT, 3);
    expect(q).toMatchObject({ received: 3, of: 3, upheld: 1, refuted: 1, confused: 1, invalid: [] });
  });

  test("a path outside the run subtree is invalid, however plausible it looks", () => {
    const { state, root: r } = root();
    const outside = refuterVerdict(join(scratch, "elsewhere"), "UPHELD");
    const q = quorumFromDisk([outside], r, EXPECT, 1);
    expect(q.received).toBe(0);
    expect(q.invalid[0]).toMatch(/outside this review's run subtree/);
  });

  test("a traversal out of the subtree is rejected", () => {
    const { state, root: r } = root();
    refuterVerdict(join(scratch, "elsewhere2"), "UPHELD");
    const sneaky = join(r, "..", "..", "elsewhere2", "verdict.json");
    expect(pathInsideRunTree(sneaky, r)).toBe(false);
    expect(quorumFromDisk([sneaky], r, EXPECT, 1).received).toBe(0);
  });

  test("the same path listed twice counts once and is flagged", () => {
    const { state, root: r } = root();
    const p = refuterVerdict(stageDest(state, RUN, 1, "refute", 1), "UPHELD");
    const q = quorumFromDisk([p, p], r, EXPECT, 2);
    expect(q.received).toBe(1);
    expect(q.invalid[0]).toMatch(/listed twice/);
  });

  test("a missing verdict lowers received without inventing a result", () => {
    const { state, root: r } = root();
    const p = refuterVerdict(stageDest(state, RUN, 1, "refute", 1), "UPHELD");
    const ghost = join(stageDest(state, RUN, 1, "refute", 1), "ghost", "verdict.json");
    const q = quorumFromDisk([p, ghost], r, EXPECT, 2);
    expect(q).toMatchObject({ received: 1, of: 2, upheld: 1 });
    expect(q.invalid[0]).toMatch(/no verdict file/);
  });

  test("`of` is what was dispatched, never inferred from what came back", () => {
    const { state, root: r } = root();
    const p = refuterVerdict(stageDest(state, RUN, 1, "refute", 1), "UPHELD");
    expect(quorumFromDisk([p], r, EXPECT, 3).of).toBe(3);
  });
});

describe("verdictInstructions", () => {
  test("prints exactly the union the reader enforces", () => {
    for (const stage of ["discover", "refute"] as const) {
      const text = verdictInstructions(stage, "/run/verdict.json", { ...EXPECT, stage });
      for (const r of STAGE_RESULTS[stage]) expect(text).toContain(`"${r}"`);
      // The other stage's results must not leak in.
      const other = stage === "discover" ? "refute" : "discover";
      for (const r of STAGE_RESULTS[other]) {
        if (!(STAGE_RESULTS[stage] as readonly string[]).includes(r)) expect(text).not.toContain(`"${r}"`);
      }
    }
  });

  test("carries the exact envelope the spawn will be validated against", () => {
    const text = verdictInstructions("refute", "/run/verdict.json", EXPECT);
    expect(text).toContain(`"runId": "${RUN}"`);
    expect(text).toContain(`"round": 1`);
    expect(text).toContain(`"attempt": 1`);
    expect(text).toContain("/run/verdict.json");
    expect(text).toContain("verdict written");
  });

  test("the notes template it ships would not itself be rejected as a placeholder", () => {
    // The contract used to hand out `<one line: ...>` and then reject it on the
    // way back in. Any example text here must survive its own reader.
    const text = verdictInstructions("refute", "/run/verdict.json", EXPECT);
    const notes = /"notes": "([^"]*)"/.exec(text)?.[1] ?? "";
    const check = readVerdict(writeVerdict(good({ notes })), EXPECT);
    expect(check.ok).toBe(true);
  });
});

// Gate tests for lib/prompts.ts: the blindness gate, the activation predicate,
// and the load-bearing lines of the prompt text. The prompt's QUALITY is the
// paid eval's job (evals/reviewer); these pin the mechanisms that must never
// silently drift.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MODELS, CLI_PROVIDERS, resolveSkepticSeats } from "../lib/models.ts";
import {
  ADVERSARIAL_DIFF_THRESHOLD,
  ADVERSARIAL_TRIGGER_LABELS,
  adversarialActive,
  countDiffLines,
  reviewerPrompt,
  skepticBrief,
  spawnStub,
  type ReviewerPromptInput,
  type VerdictTarget,
} from "../lib/prompts.ts";
import { STAGE_RESULTS, verdictPath } from "../lib/verdict.ts";
import { ZError } from "../lib/cli.ts";

const INPUT: ReviewerPromptInput = {
  ticketBody: "the spec",
  acceptanceCriteria: "- AC1",
  diff: "+one\n-two",
  worktreePath: "/tmp/wt",
};

const TARGET: VerdictTarget = {
  path: "/tmp/out/runs/run-20260101-000000-aaaa/t7/reviewer-1/verdict.json",
  runId: "run-20260101-000000-aaaa",
  ticket: 7,
  attempt: 1,
  skepticDirs: ["/tmp/sk1", "/tmp/sk2", "/tmp/sk3"],
};

describe("blindness gate", () => {
  test("a fifth key is rejected at runtime, not silently carried", () => {
    const smuggled = { ...INPUT, prDescription: "trust me" } as unknown as ReviewerPromptInput;
    expect(() => reviewerPrompt(smuggled, "/tmp/input.json", TARGET)).toThrow(/blinded by design/);
  });

  test("an empty input value is rejected", () => {
    expect(() => reviewerPrompt({ ...INPUT, diff: "" }, "/tmp/input.json", TARGET)).toThrow(ZError);
  });
});

describe("adversarialActive", () => {
  test("off never fans out; always always does", () => {
    expect(adversarialActive("off", 1000, ["security"])).toBe(false);
    expect(adversarialActive("always", 0, [])).toBe(true);
  });

  test("non-trivial fans out at the diff threshold or any trigger label", () => {
    expect(adversarialActive("non-trivial", ADVERSARIAL_DIFF_THRESHOLD, [])).toBe(true);
    expect(adversarialActive("non-trivial", ADVERSARIAL_DIFF_THRESHOLD - 1, [])).toBe(false);
    for (const label of ADVERSARIAL_TRIGGER_LABELS) {
      expect(adversarialActive("non-trivial", 1, [label])).toBe(true);
    }
    expect(adversarialActive("non-trivial", 1, ["docs"])).toBe(false);
  });
});

describe("countDiffLines", () => {
  test("counts +/- lines, excluding the file headers", () => {
    const diff = "--- a/x\n+++ b/x\n+added\n-removed\n context\n+more";
    expect(countDiffLines(diff)).toBe(3);
  });
});

describe("reviewerPrompt", () => {
  test("single pass carries no super-truth block and no skeptic briefs", () => {
    const p = reviewerPrompt(INPUT, "/tmp/input.json", TARGET, false);
    expect(p).not.toContain("Super-truth pass");
    expect(p).not.toContain("SKEPTIC-1-BRIEF");
  });

  test("adversarial pass carries the in-turn collection mechanics and the confidence table", () => {
    const p = reviewerPrompt(INPUT, "/tmp/input.json", TARGET, true);
    // The mechanism, not exhortation: the exact flag, in one message.
    expect(p).toContain("run_in_background: false");
    expect(p).toContain("Spawn all three in ONE message");
    // The lookup table -- arithmetic never happens in a model reply.
    expect(p).toContain("k=3: 3 UPHELD -> 100, 2 -> 67, 1 -> 33, 0 -> 0");
    expect(p).toContain("k=2: 2 UPHELD -> 100, 1 -> 50, 0 -> 0");
    // All three briefs, verbatim-embedded with their heredoc-style markers.
    for (const k of [1, 2, 3]) expect(p).toContain(`SKEPTIC-${k}-BRIEF`);
  });

  test("adversarial pass demands exactly 3 skeptic dirs", () => {
    expect(() => reviewerPrompt(INPUT, "/tmp/input.json", { ...TARGET, skepticDirs: [] }, true)).toThrow(
      /exactly 3 skeptic/
    );
  });

  test("the exit contract renders the verdict path, the envelope, and the exact result union", () => {
    const p = reviewerPrompt(INPUT, "/tmp/input.json", TARGET, false);
    expect(p).toContain(TARGET.path);
    expect(p).toContain(`"runId": "${TARGET.runId}"`);
    expect(p).toContain("verdict written");
    for (const r of STAGE_RESULTS.reviewer) expect(p).toContain(`"${r}"`);
  });

  test("the payload is a pointer: spec and diff bodies never appear in the prompt", () => {
    const big = { ...INPUT, diff: "+SENTINEL-DIFF-LINE\n".repeat(50), ticketBody: "SENTINEL-SPEC" };
    const p = reviewerPrompt(big, "/tmp/input.json", TARGET, false);
    expect(p).not.toContain("SENTINEL-DIFF-LINE");
    expect(p).not.toContain("SENTINEL-SPEC");
  });
});

describe("skepticBrief", () => {
  test("carries the blinded pointer, the refutation task, and its own verdict contract", () => {
    const spawn = { runId: TARGET.runId, ticket: 7, stage: "skeptic" as const, attempt: 1 };
    const b = skepticBrief(2, INPUT, "/tmp/input.json", "/tmp/sk2", spawn);
    expect(b).toContain("SKEPTIC 2 of 3");
    expect(b).toContain("/tmp/input.json");
    expect(b).toContain(INPUT.worktreePath);
    expect(b).toContain("REFUTE");
    // The verdict path is rendered platform-joined (backslashes on Windows).
    expect(b).toContain(verdictPath("/tmp/sk2"));
    for (const r of STAGE_RESULTS.skeptic) expect(b).toContain(`"${r}"`);
  });
});

// -- per-seat model selection --------------------------------------------------

// Golden fixtures were generated from the PRE-FEATURE code (backslashes
// normalized to / for platform stability). The all-inherit path must stay
// byte-identical to them forever; the mixed fixture pins the per-seat variant.
const FIXTURES = join(import.meta.dir, "fixtures");
// \r stripped on read: .gitattributes pins these -text, but a clone that
// predates the pin (or a tool that rewrote the file) must not fail the
// byte-identity test over line endings it never authored.
const golden = (name: string) => readFileSync(join(FIXTURES, name), "utf8").replace(/\r\n/g, "\n");
const norm = (s: string) => s.replace(/\\/g, "/");

describe("per-seat lineups", () => {
  test("no seats arg and explicit all-inherit are both byte-identical to the pre-feature goldens", () => {
    expect(norm(reviewerPrompt(INPUT, "/tmp/input.json", TARGET, false))).toBe(golden("golden-prompt-single.txt"));
    expect(norm(reviewerPrompt(INPUT, "/tmp/input.json", TARGET, true))).toBe(
      golden("golden-prompt-adversarial-inherit.txt")
    );
    expect(norm(reviewerPrompt(INPUT, "/tmp/input.json", TARGET, true, resolveSkepticSeats([])))).toBe(
      golden("golden-prompt-adversarial-inherit.txt")
    );
  });

  test("mixed lineup matches its golden: model line per Agent seat, exact command per CLI seat, briefs verbatim", () => {
    const seats = resolveSkepticSeats(["codex", "agy:gemini-3-pro", "haiku"]);
    const p = norm(reviewerPrompt(INPUT, "/tmp/input.json", TARGET, true, seats));
    expect(p).toBe(golden("golden-prompt-adversarial-mixed.txt"));
    // Load-bearing lines, asserted independently of the fixture bytes:
    expect(p).toContain('Skeptic 3 -- Agent seat: one Agent tool call, `model: "haiku"`, `run_in_background: false`');
    expect(p).toContain('codex exec -s workspace-write --cd "/tmp/wt"');
    expect(p).toContain("--dangerously-skip-permissions --print-timeout 9m30s --model gemini-3-pro");
    for (const k of [1, 2, 3]) expect(p).toContain(`SKEPTIC-${k}-BRIEF`);
  });

  test("an inherit Agent seat renders no model line; a wrong seat count throws", () => {
    const seats = resolveSkepticSeats(["codex"]); // seats 2..3 gap-fill to inherit
    const p = reviewerPrompt(INPUT, "/tmp/input.json", TARGET, true, seats);
    expect(p).toContain("Skeptic 2 -- Agent seat: one Agent tool call, `run_in_background: false`");
    expect(p).not.toContain('`model: "inherit"`');
    expect(() =>
      reviewerPrompt(INPUT, "/tmp/input.json", TARGET, true, [{ kind: "agent", model: "haiku" }])
    ).toThrow(/exactly 3 resolved skeptic seats/);
  });

  test("blindness: no seat token ever reaches a skeptic brief", () => {
    const spawn = { runId: TARGET.runId, ticket: 7, stage: "skeptic" as const, attempt: 1 };
    const b = skepticBrief(1, INPUT, "/tmp/input.json", "/tmp/sk1", spawn);
    for (const token of [...AGENT_MODELS.filter((m) => m !== "inherit"), ...CLI_PROVIDERS, "antigravity"]) {
      expect(b).not.toContain(token);
    }
  });
});

describe("spawnStub", () => {
  test("points at the prompt file and names the unreadable-prompt fallback", () => {
    const s = spawnStub("/tmp/prompt.txt");
    expect(s).toContain("/tmp/prompt.txt");
    expect(s).toContain("BLOCKED: could not read reviewer prompt");
    // Size-invariance is the point: the stub depends on the path alone.
    expect(s.length).toBeLessThan(600);
  });
});

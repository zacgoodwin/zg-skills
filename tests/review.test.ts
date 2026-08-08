// Gate tests for lib/review.ts. All deterministic and offline: the fixture
// "PR" is a pair of local commits in a scratch repo, so prepare's fetch path
// is never taken except in the test that proves its failure mode.
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AC_FALLBACK,
  NO_SPEC_FALLBACK,
  chooseSpec,
  cleanup,
  collect,
  extractAcceptanceCriteria,
  prepare,
} from "../lib/review.ts";
import { REVIEWER_INPUT_KEYS } from "../lib/prompts.ts";
import { isRunId } from "../lib/run-id.ts";
import { VERDICT_SCHEMA_VERSION } from "../lib/verdict.ts";
import { ZError } from "../lib/cli.ts";

// -- fixture repo -------------------------------------------------------------

let root: string; // scratch parent: fixture repo + out-dirs
let repo: string;
let baseSha: string;
let bigHeadSha: string; // 12+ changed code lines + a yarn.lock change
let lockOnlySha: string; // yarn.lock change only
let smallHeadSha: string; // one changed line

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  }
  return p.stdout.toString().trim();
}

function commitAll(msg: string): string {
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--no-verify", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "adversarial-review-test-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "util.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "yarn.lock"), "lock-v1\n");
  baseSha = commitAll("base");

  const twelveLines = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join("\n");
  writeFileSync(join(repo, "util.ts"), `${twelveLines}\n`);
  writeFileSync(join(repo, "yarn.lock"), "lock-v2\n");
  bigHeadSha = commitAll("big change");

  git(repo, "checkout", "-q", baseSha);
  writeFileSync(join(repo, "yarn.lock"), "lock-v3\n");
  lockOnlySha = commitAll("lockfile only");

  git(repo, "checkout", "-q", baseSha);
  writeFileSync(join(repo, "util.ts"), "export const a = 2;\n");
  smallHeadSha = commitAll("small change");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {} // Windows can hold a handle briefly; the OS temp dir is self-cleaning
});

// pr.json exactly as `gh pr view --json <fields>` shapes it, defaults
// overridable per scenario. Distinct numbers keep worktree paths distinct.
function prJson(
  n: number,
  overrides: Record<string, unknown> = {}
): { prPath: string; outDir: string } {
  const outDir = join(root, `out-${n}`);
  mkdirSync(outDir, { recursive: true });
  const meta = {
    number: n,
    title: `Fixture PR ${n}`,
    url: `https://example.invalid/pr/${n}`,
    body: "PR body prose.",
    headRefOid: bigHeadSha,
    baseRefOid: baseSha,
    baseRefName: "main",
    labels: [],
    closingIssuesReferences: [],
    ...overrides,
  };
  const prPath = join(outDir, "pr.json");
  writeFileSync(prPath, JSON.stringify(meta));
  return { prPath, outDir };
}

function runPrepare(n: number, overrides: Record<string, unknown> = {}, extraFlags: Record<string, string> = {}) {
  const { prPath, outDir } = prJson(n, overrides);
  return prepare({ "pr-json": prPath, repo, "out-dir": outDir, ...extraFlags });
}

// -- acceptance-criteria extraction -------------------------------------------

describe("extractAcceptanceCriteria", () => {
  test("extracts the section and stops at the next heading of any level", () => {
    const spec = "## Plan\nstuff\n### Acceptance Criteria\n- AC1\n- AC2\n#### Notes\nnot ac\n";
    expect(extractAcceptanceCriteria(spec)).toBe("- AC1\n- AC2");
  });

  test("returns empty string when the section is absent", () => {
    expect(extractAcceptanceCriteria("## Plan\nno criteria here\n")).toBe("");
  });

  test("a second AC heading re-opens the section", () => {
    const spec = "### Acceptance Criteria\n- AC1\n## Other\nx\n### Acceptance Criteria\n- AC2\n";
    expect(extractAcceptanceCriteria(spec)).toBe("- AC1\n- AC2");
  });
});

// -- spec selection -----------------------------------------------------------

describe("chooseSpec", () => {
  test("linked issue body wins over the PR description", () => {
    const c = chooseSpec("pr body", { number: 7, body: "issue body" });
    expect(c.spec).toBe("issue body");
    expect(c.specSource).toBe("linked issue #7");
  });

  test("PR description fallback is disclosed as author-authored, in both the spec and the source", () => {
    const c = chooseSpec("pr body", undefined);
    expect(c.spec).toContain("written by the diff's author");
    expect(c.spec).toContain("pr body");
    expect(c.specSource).toBe("PR description (author-authored)");
  });

  test("no body and no issue yields the named no-spec fallback, never an empty ticketBody", () => {
    const c = chooseSpec("   ", { number: null, body: " " });
    expect(c.spec).toBe(NO_SPEC_FALLBACK);
    expect(c.specSource).toBe("none");
  });
});

// -- prepare ------------------------------------------------------------------

describe("prepare", () => {
  test("big diff: blinded four-key input, lockfile-excluded diff, detached worktree, adversarial prompt", () => {
    const m = runPrepare(101);

    // Blindness: exactly the four keys, all non-empty.
    const input = JSON.parse(readFileSync(m.inputPath, "utf8"));
    expect(Object.keys(input).sort()).toEqual([...REVIEWER_INPUT_KEYS].sort());
    for (const k of REVIEWER_INPUT_KEYS) expect(input[k].length).toBeGreaterThan(0);

    // Lockfile hunks excluded; the code change present.
    expect(input.diff).toContain("util.ts");
    expect(input.diff).not.toContain("yarn.lock");

    // Throwaway worktree: exists, detached at the PR head, under repo/.worktrees.
    expect(m.worktreePath).toBe(join(repo, ".worktrees", "review-pr-101"));
    expect(git(m.worktreePath, "rev-parse", "HEAD")).toBe(bigHeadSha);

    // 12 changed lines >= threshold under the default non-trivial mode.
    expect(m.adversarialMode).toBe("non-trivial");
    expect(m.adversarial).toBe(true);
    expect(readFileSync(m.promptPath, "utf8")).toContain("Super-truth pass");

    // No AC section in the PR body -> the named fallback, flagged in the manifest.
    expect(m.acFound).toBe(false);
    expect(input.acceptanceCriteria).toBe(AC_FALLBACK);
    expect(m.specSource).toBe("PR description (author-authored)");

    // The stub is the worker's whole spawn payload: points at the prompt file,
    // carries the unreadable-prompt fallback.
    expect(m.stub).toContain(m.promptPath);
    expect(m.stub).toContain("BLOCKED: could not read reviewer prompt");

    // One-shot run identity: the verdict path sits in the reviewer's stage dir
    // under runs/<runId>/t<pr>/, with the three skeptic dirs (whose briefs the
    // prompt embeds) pre-created beneath it.
    expect(isRunId(m.runId)).toBe(true);
    const reviewerDir = dirname(m.verdictPath);
    expect(reviewerDir).toBe(join(m.runRoot, "t101", "reviewer-1"));
    const prompt = readFileSync(m.promptPath, "utf8");
    for (const k of [1, 2, 3]) {
      expect(existsSync(join(reviewerDir, `skeptic-${k}`))).toBe(true);
      expect(prompt).toContain(`SKEPTIC-${k}-BRIEF`);
    }
  });

  test("re-running prepare for the same PR self-heals the leftover worktree", () => {
    const m = runPrepare(101);
    expect(git(m.worktreePath, "rev-parse", "HEAD")).toBe(bigHeadSha);
  });

  test("linked issue: its body is the spec verbatim, its AC slice is extracted, labels union in", () => {
    const { outDir } = prJson(0); // scratch dir for the issue file only
    const issuePath = join(outDir, "issue.json");
    writeFileSync(
      issuePath,
      JSON.stringify({
        body: "Ticket.\n### Acceptance Criteria\n- holds\n## Out of scope\nx\n",
        labels: [{ name: "security" }],
      })
    );
    const m = runPrepare(
      103,
      { headRefOid: smallHeadSha, closingIssuesReferences: [{ number: 7 }], labels: [{ name: "docs" }] },
      { "issue-json": issuePath }
    );
    const input = JSON.parse(readFileSync(m.inputPath, "utf8"));
    expect(input.ticketBody.startsWith("Ticket.")).toBe(true);
    expect(input.acceptanceCriteria).toBe("- holds");
    expect(m.acFound).toBe(true);
    expect(m.specSource).toBe("linked issue #7");
    expect(m.labels).toEqual(["docs", "security"]);
    // One changed line -- under the diff threshold -- but the security label
    // still fans out (the blast-radius rule).
    expect(m.diffLines).toBeLessThan(10);
    expect(m.adversarial).toBe(true);
  });

  test("small unlabeled diff under non-trivial mode is a single pass", () => {
    const m = runPrepare(104, { headRefOid: smallHeadSha });
    expect(m.adversarial).toBe(false);
    expect(readFileSync(m.promptPath, "utf8")).not.toContain("Super-truth pass");
  });

  test("--adversarial-mode off never fans out; always always does", () => {
    expect(runPrepare(105, {}, { "adversarial-mode": "off" }).adversarial).toBe(false);
    expect(
      runPrepare(106, { headRefOid: smallHeadSha }, { "adversarial-mode": "always" }).adversarial
    ).toBe(true);
  });

  test("lockfile-only PR falls back to the unfiltered diff instead of an empty one", () => {
    const m = runPrepare(107, { headRefOid: lockOnlySha });
    const input = JSON.parse(readFileSync(m.inputPath, "utf8"));
    expect(input.diff).toContain("yarn.lock");
  });

  test("identical head and base is a loud empty-diff error", () => {
    expect(() => runPrepare(108, { headRefOid: baseSha })).toThrow(/empty/);
  });

  test("a commit that is not local and cannot be fetched names the fetch that failed", () => {
    // The fixture repo has no origin, so the bounded fetch fails and the error
    // must say what to do -- never a silent empty diff or a broken worktree.
    const bogus = "0123456789012345678901234567890123456789";
    expect(() => runPrepare(109, { headRefOid: bogus })).toThrow(/not present locally/);
  });

  test("a pr.json missing a required field names the field and the fields list to re-fetch", () => {
    expect(() => runPrepare(110, { headRefOid: "" })).toThrow(/headRefOid/);
  });

  test("an unknown adversarial mode is rejected", () => {
    expect(() => runPrepare(111, {}, { "adversarial-mode": "sometimes" })).toThrow(ZError);
  });
});

// -- collect ------------------------------------------------------------------

// Fixture verdict files in the exact envelope readVerdict enforces; the
// quorum numbers must come from the FILES on disk, never the reviewer's tally.
describe("collect", () => {
  function writeVerdict(
    path: string,
    m: { runId: string },
    ticket: number,
    stage: "reviewer" | "skeptic",
    result: string,
    evidence?: Record<string, unknown>,
    notes = "fixture notes"
  ) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema: VERDICT_SCHEMA_VERSION,
        runId: m.runId,
        ticket,
        stage,
        attempt: 1,
        result,
        evidence,
        notes,
      })
    );
  }

  test("adversarial approve: quorum counted off the skeptic files, not the reviewer's word", () => {
    const m = runPrepare(120);
    const reviewerDir = dirname(m.verdictPath);
    const s1 = join(reviewerDir, "skeptic-1", "verdict.json");
    const s2 = join(reviewerDir, "skeptic-2", "verdict.json");
    const missing = join(reviewerDir, "skeptic-3", "verdict.json");
    writeVerdict(s1, m, 120, "skeptic", "UPHELD", { lens: "refutation", claimChecked: "x" });
    writeVerdict(s2, m, 120, "skeptic", "REFUTED", { lens: "refutation", claimChecked: "y" });
    writeVerdict(m.verdictPath, m, 120, "reviewer", "REVIEW-APPROVE", {
      confidence: 33,
      skepticVerdictPaths: [s1, s2, missing], // reviewer lists a file that never landed
    });

    const r = collect(m.verdictPath, m.runRoot, m.runId, 120);
    if (!r.ok) throw new Error(r.reason);
    expect(r.result).toBe("REVIEW-APPROVE");
    expect(r.confidence).toBe(33);
    expect(r.quorum).toMatchObject({ received: 2, of: 3, unrefuted: 1 });
    expect(r.quorum!.invalid).toHaveLength(1); // the missing third file, named
    cleanup(repo, m.worktreePath);
  });

  test("single pass: no skeptic list means no quorum, confidence still read", () => {
    const m = runPrepare(121, { headRefOid: smallHeadSha });
    writeVerdict(m.verdictPath, m, 121, "reviewer", "REVIEW-FINDINGS", { confidence: 80 });
    const r = collect(m.verdictPath, m.runRoot, m.runId, 121);
    if (!r.ok) throw new Error(r.reason);
    expect(r.result).toBe("REVIEW-FINDINGS");
    expect(r.confidence).toBe(80);
    expect(r.quorum).toBeNull();
    cleanup(repo, m.worktreePath);
  });

  test("a missing verdict file is INVALID with the reason, not a throw", () => {
    const m = runPrepare(122, { headRefOid: smallHeadSha });
    const r = collect(m.verdictPath, m.runRoot, m.runId, 122);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no verdict file");
    cleanup(repo, m.worktreePath);
  });

  test("a verdict addressed to another spawn never speaks for this one", () => {
    const m = runPrepare(123, { headRefOid: smallHeadSha });
    writeVerdict(m.verdictPath, { runId: "run-20200101-000000-abcd" }, 123, "reviewer", "REVIEW-APPROVE", {
      confidence: 100,
    });
    const r = collect(m.verdictPath, m.runRoot, m.runId, 123);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("runId");
    cleanup(repo, m.worktreePath);
  });
});

// -- cleanup ------------------------------------------------------------------

describe("cleanup", () => {
  test("removes the worktree, is idempotent, and leaves the repo healthy", () => {
    const m = runPrepare(112);
    expect(cleanup(repo, m.worktreePath)).toBe("removed");
    expect(existsSync(m.worktreePath)).toBe(false);
    expect(cleanup(repo, m.worktreePath)).toBe("absent");
    // The main repo still functions and can mint a fresh worktree at the same path.
    const again = runPrepare(112);
    expect(git(again.worktreePath, "rev-parse", "HEAD")).toBe(bigHeadSha);
    cleanup(repo, again.worktreePath);
  });
});

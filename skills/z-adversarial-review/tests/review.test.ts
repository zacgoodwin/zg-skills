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
import { AGENT_MODELS, CLI_PROVIDERS, briefPath, cliCommand, writeSkepticPreference, type ProviderDeps } from "../lib/models.ts";
import { REVIEWER_INPUT_KEYS } from "../lib/prompts.ts";
import { isRunId } from "../lib/run-id.ts";
import { VERDICT_SCHEMA_VERSION, quorumFromDisk, verdictPath } from "../lib/verdict.ts";
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
  root = mkdtempSync(join(tmpdir(), "z-adversarial-review-test-"));
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

// Injected provider deps: every CLI binary "exists" and versions cleanly, so
// prepare's preflight passes offline. Tests that exercise the miss inject
// their own.
const okDeps: ProviderDeps = {
  run: () => ({ ok: true, stdout: "9.9.9", stderr: "" }),
  which: (bin) => `/fake/bin/${bin}`,
  env: {},
  home: "/fake/home",
};

function runPrepare(
  n: number,
  overrides: Record<string, unknown> = {},
  extraFlags: Record<string, string> = {},
  deps: ProviderDeps = okDeps
) {
  const { prPath, outDir } = prJson(n, overrides);
  return prepare({ "pr-json": prPath, repo, "out-dir": outDir, ...extraFlags }, deps);
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

  test("a level-2 heading works too (spec issues use ##, zstack tickets ###)", () => {
    const spec = "## Context\nx\n## Acceptance Criteria\n1. AC1\n2. AC2\n## Testing Plan\nnot ac\n";
    expect(extractAcceptanceCriteria(spec)).toBe("1. AC1\n2. AC2");
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

    // Throwaway worktree: exists, detached at the PR head, under repo/.worktrees,
    // its name carrying this run's own runId (never shared across runs).
    expect(m.worktreePath).toBe(join(repo, ".worktrees", `review-pr-101-${m.runId}`));
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

  test("re-running prepare for the same PR mints a fresh worktree", () => {
    const m = runPrepare(101);
    expect(git(m.worktreePath, "rev-parse", "HEAD")).toBe(bigHeadSha);
  });

  test("two concurrent prepares of the same PR never share a worktree path (issue #99)", () => {
    // Two overlapping reviews of PR 101 (e.g. two sessions racing the same
    // PR): each prepare() must get its own worktree, both must exist
    // simultaneously, and cleaning up one must never touch the other's.
    const a = runPrepare(101);
    const b = runPrepare(101);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(existsSync(a.worktreePath)).toBe(true);
    expect(existsSync(b.worktreePath)).toBe(true);
    expect(git(a.worktreePath, "rev-parse", "HEAD")).toBe(bigHeadSha);
    expect(git(b.worktreePath, "rev-parse", "HEAD")).toBe(bigHeadSha);

    cleanup(repo, a.worktreePath);
    expect(existsSync(a.worktreePath)).toBe(false);
    expect(existsSync(b.worktreePath)).toBe(true); // b survives a's cleanup
    cleanup(repo, b.worktreePath);
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

// -- per-seat model selection through prepare ---------------------------------

describe("prepare per-seat models", () => {
  // The manifest's full key set before this feature, pinned so AC1's "identical
  // except the two new fields" stays checkable forever.
  const LEGACY_MANIFEST_KEYS = [
    "pr", "title", "url", "specSource", "acFound", "diffLines", "labels",
    "adversarialMode", "adversarial", "runId", "runRoot", "verdictPath",
    "inputPath", "promptPath", "diffPath", "worktreePath", "stub",
  ];

  test("no flags: manifest carries exactly the legacy keys plus the two defaults", () => {
    const m = runPrepare(130);
    expect(Object.keys(m).sort()).toEqual(
      [...LEGACY_MANIFEST_KEYS, "reviewerModel", "skepticModels"].sort()
    );
    expect(m.reviewerModel).toBe("inherit");
    expect(m.skepticModels).toEqual(["inherit", "inherit", "inherit"]);
    // Default lineup renders the legacy prompt: no per-seat sections.
    expect(readFileSync(m.promptPath, "utf8")).not.toContain("CLI seat");
    cleanup(repo, m.worktreePath);
  });

  test("gap-fill through the flag: [\"codex\"] resolves seats 2..3 to inherit in the manifest", () => {
    const m = runPrepare(131, {}, { "skeptic-models": '["codex"]' });
    expect(m.skepticModels).toEqual(["codex", "inherit", "inherit"]);
    cleanup(repo, m.worktreePath);
  });

  test("full CLI lineup: briefs written per CLI seat, exact commands in the prompt, blindness intact", () => {
    const m = runPrepare(132, {}, {
      "skeptic-models": '["codex","agy","agy:gemini-3-pro"]',
      "reviewer-model": "fable",
    });
    expect(m.reviewerModel).toBe("fable");
    expect(m.skepticModels).toEqual(["codex", "agy", "agy:gemini-3-pro"]);

    const reviewerDir = dirname(m.verdictPath);
    const prompt = readFileSync(m.promptPath, "utf8");
    for (const [idx, provider] of (["codex", "agy", "agy"] as const).entries()) {
      const brief = readFileSync(briefPath(join(reviewerDir, `skeptic-${idx + 1}`)), "utf8");
      expect(brief).toContain(`SKEPTIC ${idx + 1} of 3`);
      expect(prompt).toContain(`CLI seat (${provider})`);
      // Blindness: the brief never names any seat's model or provider.
      for (const token of [...AGENT_MODELS.filter((t) => t !== "inherit"), ...CLI_PROVIDERS]) {
        expect(brief).not.toContain(token);
      }
    }
    // Blindness: the four-key input file carries no seat token either.
    const inputRaw = readFileSync(m.inputPath, "utf8");
    expect(Object.keys(JSON.parse(inputRaw)).sort()).toEqual([...REVIEWER_INPUT_KEYS].sort());
    for (const token of [...AGENT_MODELS.filter((t) => t !== "inherit"), ...CLI_PROVIDERS]) {
      expect(inputRaw).not.toContain(token);
    }
    cleanup(repo, m.worktreePath);
  });

  test("a single pass writes no brief files even for a CLI lineup", () => {
    const m = runPrepare(133, { headRefOid: smallHeadSha }, { "skeptic-models": '["codex"]' });
    expect(m.adversarial).toBe(false);
    expect(existsSync(briefPath(join(dirname(m.verdictPath), "skeptic-1")))).toBe(false);
    cleanup(repo, m.worktreePath);
  });

  test("fail-fast: a missing CLI aborts before any worktree or prompt write, naming the fix", () => {
    const miss: ProviderDeps = { ...okDeps, which: () => null };
    const wt = join(repo, ".worktrees", "review-pr-134");
    expect(() => runPrepare(134, {}, { "skeptic-models": '["agy"]' }, miss)).toThrow(
      /"agy" failed preflight: not found on PATH/
    );
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(root, "out-134", "prompt-pr-134.txt"))).toBe(false);
  });

  test("a CLI token in the reviewer seat and malformed flag JSON are named errors", () => {
    expect(() => runPrepare(135, {}, { "reviewer-model": "codex" })).toThrow(
      /reviewer seat runs on the Claude harness only/
    );
    expect(() => runPrepare(136, {}, { "skeptic-models": "codex" })).toThrow(/JSON array/);
    expect(() => runPrepare(137, {}, { "skeptic-models": '["what"]' })).toThrow(/Unknown model token/);
  });

  // -- first-run preference fallback -------------------------------------------

  test("no flag but a saved preference: prepare resolves the saved lineup", () => {
    const home = join(root, "home-pref-138");
    mkdirSync(home, { recursive: true });
    const deps = { ...okDeps, home };
    writeSkepticPreference(["codex"], deps);
    const m = runPrepare(138, {}, {}, deps);
    expect(m.skepticModels).toEqual(["codex", "inherit", "inherit"]);
    cleanup(repo, m.worktreePath);
  });

  test("an explicit --skeptic-models flag overrides a saved preference", () => {
    const home = join(root, "home-pref-139");
    mkdirSync(home, { recursive: true });
    const deps = { ...okDeps, home };
    writeSkepticPreference(["codex"], deps);
    const m = runPrepare(139, {}, { "skeptic-models": '["agy"]' }, deps);
    expect(m.skepticModels).toEqual(["agy", "inherit", "inherit"]);
    cleanup(repo, m.worktreePath);
  });

  test("an explicit empty flag ('[]') overrides a saved preference back to all-inherit", () => {
    const home = join(root, "home-pref-140");
    mkdirSync(home, { recursive: true });
    const deps = { ...okDeps, home };
    writeSkepticPreference(["codex"], deps);
    const m = runPrepare(140, {}, { "skeptic-models": "[]" }, deps);
    expect(m.skepticModels).toEqual(["inherit", "inherit", "inherit"]);
    cleanup(repo, m.worktreePath);
  });
});

// -- mock provider end-to-end (one parameterized mock, two invocations) -------

describe("mock-provider verdicts count in the quorum", () => {
  // codex runs through its REAL composed command, with an executable `codex`
  // script first on PATH standing in for the CLI (a real program, because the
  // command wraps codex in GNU timeout, which cannot run shell functions). The
  // brief points codex at the in-worktree drop dir (the only place its Windows
  // sandbox can write) and the command must move the file to the canonical seat
  // path that collect counts.
  const codexSeat = { kind: "cli", provider: "codex" } as const;
  const dropFromBrief = (dir: string) =>
    dirname(readFileSync(briefPath(dir), "utf8").split(/\r?\n/).find((line) => line.includes(".z-review-") && line.endsWith("verdict.json"))!);
  const runCodexCommand = (m: { worktreePath: string; inputPath: string }, dir: string, fakeCodexBody: string, shellPrelude = "") => {
    const bin = mkdtempSync(join(tmpdir(), "zar-fake-codex-"));
    writeFileSync(join(bin, "codex"), `#!/usr/bin/env bash\n${fakeCodexBody}\n`, { mode: 0o755 });
    const b = bin.replace(/\\/g, "/");
    // Git Bash wants a POSIX path in PATH (C:/x has a ':' that would split it); cygpath exists only there.
    const pathFix = `PATH="$(cygpath -u "${b}" 2>/dev/null || echo "${b}"):$PATH"`;
    const prelude = shellPrelude === "" ? "" : `${shellPrelude}; `;
    const p = Bun.spawnSync(["bash", "-c", `${pathFix}; ${prelude}${cliCommand(codexSeat, m.worktreePath, dir, m.inputPath, dropFromBrief(dir))}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(bin, { recursive: true, force: true });
    return p;
  };

  test("codex verdict written in the worktree drop dir lands countable in the seat dir", () => {
    const n = 141;
    const m = runPrepare(n, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const drop = dropFromBrief(dir);
    expect(readFileSync(briefPath(dir), "utf8")).toContain(verdictPath(drop));
    const mock = join(REPO_ROOT_FOR_MOCK, "evals", "reviewer", "mock-provider.sh").replace(/\\/g, "/");
    const p = runCodexCommand(m, dir, `exec bash "${mock}" codex`);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("verdict written");
    const q = quorumFromDisk([join(dir, "verdict.json")], m.runRoot, { runId: m.runId, ticket: n, stage: "reviewer", attempt: 1 });
    expect(q).toMatchObject({ received: 1, unrefuted: 1, invalid: [] });
    expect(existsSync(drop)).toBe(false);
    cleanup(repo, m.worktreePath);
  });

  test("a stray file left beside the verdict does not keep the drop dir alive", () => {
    const m = runPrepare(153, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const drop = dropFromBrief(dir);
    const d = drop.replace(/\\/g, "/");
    // A cut-off mid-write leaves the atomic-write temp file next to the last complete verdict.
    const p = runCodexCommand(m, dir, `cat >/dev/null; printf '{}' > "${d}/verdict.json"; printf 'partial' > "${d}/verdict.json.tmp"; exit 0`);
    expect(p.exitCode).toBe(0);
    expect(existsSync(join(dir, "verdict.json"))).toBe(true);
    expect(existsSync(drop)).toBe(false);
    cleanup(repo, m.worktreePath);
  });

  test("an existing codex drop dir aborts before launch and keeps its stale verdict", () => {
    const m = runPrepare(149, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const drop = dropFromBrief(dir);
    const launched = join(root, "codex-launched");
    mkdirSync(drop, { recursive: true });
    writeFileSync(verdictPath(drop), "stale");
    const p = runCodexCommand(m, dir, `touch "${launched.replace(/\\/g, "/")}"; exit 0`);
    expect(p.exitCode).not.toBe(0);
    expect(existsSync(launched)).toBe(false);
    expect(readFileSync(verdictPath(drop), "utf8")).toBe("stale");
    expect(existsSync(join(dir, "verdict.json"))).toBe(false);
    cleanup(repo, m.worktreePath);
  });

  test("a vanished worktree aborts before codex launches and is not re-created", () => {
    const m = runPrepare(150, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const launched = join(root, "codex-launched-150");
    cleanup(repo, m.worktreePath);
    const p = runCodexCommand(m, dir, `touch "${launched.replace(/\\/g, "/")}"; exit 0`);
    expect(p.exitCode).not.toBe(0);
    expect(existsSync(launched)).toBe(false);
    expect(existsSync(m.worktreePath)).toBe(false);
  });

  test("a codex run that dies keeps its exit status and leaves no verdict to count", () => {
    const n = 142;
    const m = runPrepare(n, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const p = runCodexCommand(m, dir, "cat >/dev/null; exit 3");
    expect(p.exitCode).toBe(3);
    const q = quorumFromDisk([join(dir, "verdict.json")], m.runRoot, { runId: m.runId, ticket: n, stage: "reviewer", attempt: 1 });
    expect(q.received).toBe(0);
    cleanup(repo, m.worktreePath);
  });

  test("a successful codex run without a verdict fails", () => {
    const m = runPrepare(145, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    expect(runCodexCommand(m, dir, "cat >/dev/null; exit 0").exitCode).toBe(1);
    cleanup(repo, m.worktreePath);
  });

  test("a successful codex run fails when its verdict cannot be moved", () => {
    const m = runPrepare(146, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const target = verdictPath(dropFromBrief(dir)).replace(/\\/g, "/");
    const body = `cat >/dev/null; printf '{}' > "${target}"; exit 0`;
    expect(runCodexCommand(m, dir, body, "mv() { return 9; }").exitCode).toBe(9);
    cleanup(repo, m.worktreePath);
  });

  test("a codex run cut off after its provisional verdict still counts, with timeout's 124", () => {
    const n = 144;
    const m = runPrepare(n, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const brief = readFileSync(briefPath(dir), "utf8");
    expect(brief).toContain("Cut-off rule (this seat is stopped after 570s");
    expect(brief).toContain('write the COMPLETE verdict file with result "CONFUSED"');
    const provisional = JSON.stringify({
      schema: VERDICT_SCHEMA_VERSION, runId: m.runId, ticket: n, stage: "skeptic", attempt: 1, result: "UPHELD",
      evidence: { lens: "refutation", claimChecked: "first read" }, notes: "PROVISIONAL: read the diff, tests not run yet",
    });
    const target = verdictPath(dropFromBrief(dir)).replace(/\\/g, "/");
    // Writes the provisional file, then is "stopped" the way GNU timeout reports a cut-off.
    const p = runCodexCommand(m, dir, `cat >/dev/null; printf '%s\\n' '${provisional}' > "${target}"; exit 124`);
    expect(p.exitCode).toBe(124);
    const q = quorumFromDisk([join(dir, "verdict.json")], m.runRoot, { runId: m.runId, ticket: n, stage: "reviewer", attempt: 1 });
    expect(q).toMatchObject({ received: 1, unrefuted: 0, invalid: [] });
    expect(JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).notes).toStartWith("PROVISIONAL: ");
    cleanup(repo, m.worktreePath);
  });

  // macOS: no GNU timeout. `command` is shadowed so the lookup misses it, as it would there.
  const hide = (names: string) => `command() { case "$2" in ${names}) return 1;; esac; builtin command "$@"; }`;

  test("without timeout or gtimeout, the watchdog cuts codex off, reports 124, and the provisional verdict still counts", () => {
    const n = 147;
    const m = runPrepare(n, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const target = verdictPath(dropFromBrief(dir)).replace(/\\/g, "/");
    const provisional = JSON.stringify({
      schema: VERDICT_SCHEMA_VERSION, runId: m.runId, ticket: n, stage: "skeptic", attempt: 1, result: "UPHELD",
      evidence: { lens: "refutation", claimChecked: "first read" }, notes: "PROVISIONAL: tests not run yet",
    });
    // 1s watchdog sleeps instead of 570s/10s; codex hangs well past them in a CHILD process,
    // as a real codex's tool calls do, and both IGNORE TERM, so only the KILL follow-up
    // stops them. The child must die with codex (the whole process group), or it outlives
    // the command holding the Bash tool's output pipe.
    const childPid = join(root, "codex-child.pid").replace(/\\/g, "/");
    const prelude = `${hide("timeout|gtimeout")}; sleep() { builtin command sleep 1; }`;
    const body = `trap '' TERM; cat >/dev/null; printf '%s\\n' '${provisional}' > "${target}"; sleep 30 & echo $! > "${childPid}"; wait`;
    const p = runCodexCommand(m, dir, body, prelude);
    expect(p.exitCode).toBe(124);
    const alive = Bun.spawnSync(["bash", "-c", `pid=$(cat "${childPid}"); kill -0 "$pid" 2>/dev/null && { kill "$pid"; echo alive; }`]);
    expect(alive.stdout.toString()).not.toContain("alive");
    const q = quorumFromDisk([join(dir, "verdict.json")], m.runRoot, { runId: m.runId, ticket: n, stage: "reviewer", attempt: 1 });
    expect(q).toMatchObject({ received: 1, unrefuted: 0, invalid: [] });
    cleanup(repo, m.worktreePath);
  });

  test("without timeout, gtimeout wraps codex", () => {
    const m = runPrepare(148, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const prelude = `${hide("timeout")}; gtimeout() { echo GTIMEOUT >&2; builtin command timeout "$@"; }`;
    const p = runCodexCommand(m, dir, "cat >/dev/null; exit 3", prelude);
    expect(p.exitCode).toBe(3);
    expect(p.stderr.toString()).toContain("GTIMEOUT");
    cleanup(repo, m.worktreePath);
  });

  test.each([
    [151, "watchdog", `${hide("timeout|gtimeout")}; sleep() { builtin command sleep 1; }`],
    [152, "timeout", `timeout() { shift 3; exec "$(type -P timeout)" -k 5s 1s "$@"; }`],
  ] as const)("%i %s path: a TERM-ignoring child dies with the group after codex exits", (n, _path, prelude) => {
    const m = runPrepare(n, {}, { "skeptic-models": `["codex"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const childPid = join(root, `codex-child-${n}.pid`).replace(/\\/g, "/");
    const body = `cat >/dev/null; ( trap '' TERM; exec sleep 30 ) & echo $! > "${childPid}"; wait`;
    const p = runCodexCommand(m, dir, body, prelude);
    expect(p.exitCode).toBe(124);
    const alive = Bun.spawnSync(["bash", "-c", `pid=$(cat "${childPid}"); kill -0 "$pid" 2>/dev/null && { kill -KILL "$pid"; echo alive; }`]);
    expect(alive.stdout.toString()).not.toContain("alive");
    cleanup(repo, m.worktreePath);
  });

  test.each(["agy"] as const)("%s mock writes a countable skeptic verdict", (provider) => {
    const n = { agy: 143 }[provider];
    const m = runPrepare(n, {}, { "skeptic-models": `["${provider}"]` });
    const dir = join(dirname(m.verdictPath), "skeptic-1");
    const brief = readFileSync(briefPath(dir), "utf8");
    const mock = join(REPO_ROOT_FOR_MOCK, "evals", "reviewer", "mock-provider.sh");

    // Mirror each adapter's real input mode: codex feeds the brief on stdin,
    // agy passes it as the -p argument.
    const args = provider === "agy" ? ["bash", mock, provider, brief] : ["bash", mock, provider];
    const p = Bun.spawnSync(args, {
      stdin: provider === "agy" ? "ignore" : Buffer.from(brief),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("verdict written");

    const vp = join(dir, "verdict.json");
    const q = quorumFromDisk([vp], m.runRoot, {
      runId: m.runId,
      ticket: n,
      stage: "reviewer",
      attempt: 1,
    });
    expect(q).toMatchObject({ received: 1, unrefuted: 1, invalid: [] });
    cleanup(repo, m.worktreePath);
  });
});

const REPO_ROOT_FOR_MOCK = join(import.meta.dir, "..");

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
    expect(m.adversarial).toBe(true);
    const reviewerDir = dirname(m.verdictPath);
    const s1 = join(reviewerDir, "skeptic-1", "verdict.json");
    const s2 = join(reviewerDir, "skeptic-2", "verdict.json");
    const missing = join(reviewerDir, "skeptic-3", "verdict.json");
    writeVerdict(s1, m, 120, "skeptic", "UPHELD", { lens: "refutation", claimChecked: "x" });
    writeVerdict(s2, m, 120, "skeptic", "REFUTED", { lens: "refutation", claimChecked: "y" });
    writeVerdict(m.verdictPath, m, 120, "reviewer", "REVIEW-APPROVE", {
      confidence: 50,
      skepticVerdictPaths: [s1, s2, missing], // reviewer lists a file that never landed
    });

    const r = collect(m.verdictPath, m.runRoot, m.runId, 120, m.adversarial);
    if (!r.ok) throw new Error(r.reason);
    expect(r.result).toBe("REVIEW-APPROVE");
    expect(r.confidence).toBe(50);
    expect(r.quorum).toMatchObject({ received: 2, of: 3, unrefuted: 1 });
    expect(r.quorum!.invalid).toHaveLength(1); // the missing third file, named
    cleanup(repo, m.worktreePath);
  });

  // Issue #98: collect() must never trust the reviewer's own
  // evidence.skepticVerdictPaths to decide which files to count -- a reviewer
  // that omits the field (or lists fewer than what actually landed) must not
  // be able to spoof "single pass, no quorum to check" past an adversarial
  // run whose skeptics disagreed.
  test("a reviewer that hides skepticVerdictPaths cannot spoof the quorum (issue #98)", () => {
    const m = runPrepare(124);
    expect(m.adversarial).toBe(true);
    const reviewerDir = dirname(m.verdictPath);
    writeVerdict(join(reviewerDir, "skeptic-1", "verdict.json"), m, 124, "skeptic", "UPHELD", {
      lens: "refutation",
      claimChecked: "x",
    });
    writeVerdict(join(reviewerDir, "skeptic-2", "verdict.json"), m, 124, "skeptic", "UPHELD", {
      lens: "refutation",
      claimChecked: "y",
    });
    writeVerdict(join(reviewerDir, "skeptic-3", "verdict.json"), m, 124, "skeptic", "REFUTED", {
      lens: "refutation",
      claimChecked: "z",
    });
    // The reviewer's own verdict omits skepticVerdictPaths entirely -- the
    // pre-fix code read that as "single pass" and reported quorum: null even
    // though all three skeptics actually ran and one refuted the diff.
    writeVerdict(m.verdictPath, m, 124, "reviewer", "REVIEW-APPROVE", { confidence: 90 });

    const r = collect(m.verdictPath, m.runRoot, m.runId, 124, m.adversarial);
    if (!r.ok) throw new Error(r.reason);
    expect(r.quorum).toMatchObject({ received: 3, of: 3, unrefuted: 2, invalid: [] });
    expect(r.confidence).toBe(67);
    cleanup(repo, m.worktreePath);
  });

  test("provisional UPHELD does not increase collected confidence", () => {
    const m = runPrepare(125);
    const reviewerDir = dirname(m.verdictPath);
    writeVerdict(
      join(reviewerDir, "skeptic-1", "verdict.json"),
      m,
      125,
      "skeptic",
      "UPHELD",
      { lens: "refutation", claimChecked: "first read" },
      "PROVISIONAL: tests not run"
    );
    writeVerdict(m.verdictPath, m, 125, "reviewer", "REVIEW-APPROVE", { confidence: 100 });

    const r = collect(m.verdictPath, m.runRoot, m.runId, 125, m.adversarial);
    if (!r.ok) throw new Error(r.reason);
    expect(r.quorum).toMatchObject({ received: 1, unrefuted: 0 });
    expect(r.confidence).toBe(0);
    cleanup(repo, m.worktreePath);
  });

  test("adversarial run with zero skeptic verdicts caps the reviewer's own 100 at 99", () => {
    const m = runPrepare(126);
    expect(m.adversarial).toBe(true);
    writeVerdict(m.verdictPath, m, 126, "reviewer", "REVIEW-APPROVE", { confidence: 100 });
    const r = collect(m.verdictPath, m.runRoot, m.runId, 126, m.adversarial);
    if (!r.ok) throw new Error(r.reason);
    expect(r.quorum).toMatchObject({ received: 0, of: 3 });
    expect(r.confidence).toBe(99);
    cleanup(repo, m.worktreePath);
  });

  test("single pass (adversarial: false): quorum is null regardless of any evidence", () => {
    const m = runPrepare(121, { headRefOid: smallHeadSha });
    expect(m.adversarial).toBe(false);
    // Even a (malformed/lying) evidence.skepticVerdictPaths must not matter:
    // adversarial:false is what gates quorum, never the reviewer's evidence.
    writeVerdict(m.verdictPath, m, 121, "reviewer", "REVIEW-FINDINGS", {
      confidence: 80,
      skepticVerdictPaths: ["/tmp/invented.json"],
    });
    const r = collect(m.verdictPath, m.runRoot, m.runId, 121, m.adversarial);
    if (!r.ok) throw new Error(r.reason);
    expect(r.result).toBe("REVIEW-FINDINGS");
    expect(r.confidence).toBe(80);
    expect(r.quorum).toBeNull();
    cleanup(repo, m.worktreePath);
  });

  test("a missing verdict file is INVALID with the reason, not a throw", () => {
    const m = runPrepare(122, { headRefOid: smallHeadSha });
    const r = collect(m.verdictPath, m.runRoot, m.runId, 122, m.adversarial);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no verdict file");
    cleanup(repo, m.worktreePath);
  });

  test("a verdict addressed to another spawn never speaks for this one", () => {
    const m = runPrepare(123, { headRefOid: smallHeadSha });
    writeVerdict(m.verdictPath, { runId: "run-20200101-000000-abcd" }, 123, "reviewer", "REVIEW-APPROVE", {
      confidence: 100,
    });
    const r = collect(m.verdictPath, m.runRoot, m.runId, 123, m.adversarial);
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

// Deterministic core for the z-adversarial-review skill. Three verbs:
//
//   prepare   assemble the blinded four-key reviewer input from PR metadata,
//             generate the lockfile-excluded diff, create the throwaway
//             worktree, mint a one-shot run identity, and build the prompt +
//             spawn stub
//   collect   read the reviewer's verdict FILE and count its skeptic quorum
//             off disk -- prose is never parsed
//   cleanup   remove the throwaway worktree (idempotent)
//
// The latent/deterministic split this file enforces: everything decidable is
// decided here in code (spec selection, AC extraction, diff generation,
// worktree lifecycle, fan-out activation, verdict validation, quorum
// counting); the model only judges the diff.
//
// One semantic worth naming: a bare PR has no independent ticket. The spec
// (ticketBody) comes from the PR's linked closing issue when one exists, else
// the PR description -- and a PR-description spec is AUTHOR-AUTHORED, the
// exact narrative the blindness contract exists to withhold. That cannot be
// fixed by hiding it (there is no other spec), so it is disclosed instead:
// the assembled ticketBody opens with a one-line source note the reviewer
// weighs, and the manifest carries `specSource` so the session's report
// repeats the caveat to the human.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { handleCliError, parseFlags, readJson, requireFlag, str, ZError } from "./cli.ts";
import {
  briefPath,
  cliProvidersIn,
  parseReviewerSeat,
  preflightProviders,
  realDeps,
  resolveSkepticSeats,
  seatToken,
  type ProviderDeps,
  type Seat,
} from "./models.ts";
import {
  ADVERSARIAL_MODES,
  DEFAULT_ADVERSARIAL_MODE,
  adversarialActive,
  countDiffLines,
  reviewerPrompt,
  skepticBrief,
  spawnStub,
  type AdversarialMode,
  type ReviewerPromptInput,
  type VerdictTarget,
} from "./prompts.ts";
import { mintRunId, stageDest } from "./run-id.ts";
import {
  quorumFromDisk,
  readVerdict,
  verdictPath,
  type ExpectedSpawn,
  type QuorumFromDisk,
} from "./verdict.ts";

// -- spec selection -----------------------------------------------------------

// The acceptance-criteria slice: lines after an `Acceptance Criteria` heading
// (any level -- zstack tickets use ###, /spec issues use ##), up to the next
// heading of ANY level; a second AC heading re-opens the section. Returns ""
// when the spec has no AC section. The heading-level tolerance came out of the
// adversarial review of PR #2, which reviewed against the fallback because the
// spec's own criteria sat under a level-2 heading.
export function extractAcceptanceCriteria(spec: string): string {
  const out: string[] = [];
  let inSection = false;
  for (const line of spec.split(/\r?\n/)) {
    if (/^#{1,6} Acceptance Criteria/.test(line)) {
      inSection = true;
      continue;
    }
    if (/^#/.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join("\n").trim();
}

// The reviewer input keys must be non-empty strings (assertReviewerInput), and
// an absent AC section is itself a reviewable fact -- so the fallback names
// the gap instead of inventing criteria, and tells the reviewer to treat the
// gap as a finding rather than a license to approve.
export const AC_FALLBACK =
  "(The spec has no `Acceptance Criteria` heading. Derive the implied contract from the spec above and hold the diff to it as strictly as written criteria; the missing section is itself a finding worth reporting.)";

export const NO_SPEC_FALLBACK =
  "(This PR carries no description and links no closing issue: there is no spec independent of the diff. Judge the diff on its own coherence -- tests that actually exercise it, no silent behavior changes, no scope a title cannot justify -- and report the missing spec as a finding.)";

export interface SpecChoice {
  spec: string; // becomes ticketBody (with the source note prepended where noted)
  specSource: string; // for the manifest + the session's report caveat
}

// Preference order: linked closing issue (independent of the diff author's
// narrative), then the PR description (disclosed as author-authored), then the
// named fallback.
export function chooseSpec(
  prBody: string,
  issue?: { number: number | null; body: string }
): SpecChoice {
  if (issue && issue.body.trim() !== "") {
    const n = issue.number != null ? `#${issue.number}` : "(number unknown)";
    return { spec: issue.body, specSource: `linked issue ${n}` };
  }
  if (prBody.trim() !== "") {
    return {
      spec: `(Spec source: the PR's own description, written by the diff's author. It is a claim about the work, not an independent yardstick -- weigh it accordingly.)\n\n${prBody}`,
      specSource: "PR description (author-authored)",
    };
  }
  return { spec: NO_SPEC_FALLBACK, specSource: "none" };
}

// -- git plumbing -------------------------------------------------------------

// Lockfile pathspec excludes: generated code floods the reviewer without
// informing it. A lockfile-ONLY diff falls back to unfiltered so the reviewer
// still sees what actually changed.
export const DIFF_LOCKFILE_EXCLUDES = [
  ":(exclude)*.lock",
  ":(exclude)package-lock.json",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)yarn.lock",
] as const;

function git(
  repo: string,
  args: string[],
  allowFail = false
): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = { ok: p.exitCode === 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  if (!out.ok && !allowFail) {
    throw new ZError(
      `git ${args.join(" ")} failed in ${repo}: ${out.stderr.trim() || out.stdout.trim()}`
    );
  }
  return out;
}

function hasCommit(repo: string, sha: string): boolean {
  return git(repo, ["cat-file", "-e", `${sha}^{commit}`], true).ok;
}

// -- prepare ------------------------------------------------------------------

interface PrMeta {
  number: number;
  title: string;
  url: string;
  body: string;
  headRefOid: string;
  baseRefOid: string;
  baseRefName: string;
  labels: { name: string }[];
  closingIssuesReferences: { number: number }[];
}

// Field-by-field validation with the fix in the message: the JSON comes from a
// `gh pr view --json <fields>` the skill runs, and a missing field means that
// list was trimmed, not that GitHub is down.
const PR_FIELDS =
  "number,title,url,body,headRefOid,baseRefOid,baseRefName,labels,closingIssuesReferences";

function readPrMeta(path: string): PrMeta {
  const raw = readJson(path);
  const strField = (k: string): string => {
    const v = raw[k];
    if (typeof v !== "string" || v === "") {
      throw new ZError(
        `PR metadata at ${path} is missing "${k}". Fetch it with: gh pr view <N> --json ${PR_FIELDS}`
      );
    }
    return v;
  };
  if (typeof raw.number !== "number") {
    throw new ZError(
      `PR metadata at ${path} is missing "number". Fetch it with: gh pr view <N> --json ${PR_FIELDS}`
    );
  }
  return {
    number: raw.number,
    title: strField("title"),
    url: strField("url"),
    body: typeof raw.body === "string" ? raw.body : "", // legitimately empty on bodyless PRs
    headRefOid: strField("headRefOid"),
    baseRefOid: strField("baseRefOid"),
    baseRefName: strField("baseRefName"),
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    closingIssuesReferences: Array.isArray(raw.closingIssuesReferences)
      ? raw.closingIssuesReferences
      : [],
  };
}

export interface ReviewManifest {
  pr: number;
  title: string;
  url: string;
  specSource: string;
  acFound: boolean;
  diffLines: number;
  labels: string[];
  adversarialMode: AdversarialMode;
  adversarial: boolean;
  // Per-seat model selection, RESOLVED (gap-fills included): the reviewer's
  // Agent-tool token and the canonical 3-seat skeptic lineup.
  reviewerModel: string;
  skepticModels: string[];
  // One-shot run identity, minted fresh per prepare so a re-run can never
  // mis-address the previous attempt's verdict as its own.
  runId: string;
  runRoot: string;
  verdictPath: string;
  inputPath: string;
  promptPath: string;
  diffPath: string;
  worktreePath: string;
  stub: string;
}

// The standalone review is always this spawn: one reviewer, first attempt.
// A re-run mints a fresh runId instead of incrementing, so the envelope check
// in readVerdict still rejects any stale file.
const STANDALONE_ATTEMPT = 1;

export function prepare(
  flags: Record<string, string | boolean>,
  deps: ProviderDeps = realDeps()
): ReviewManifest {
  const repo = resolve(requireFlag(flags, "repo"));
  const outDir = resolve(requireFlag(flags, "out-dir"));
  const pr = readPrMeta(requireFlag(flags, "pr-json"));
  const modeArg = str(flags, "adversarial-mode");
  const mode = (modeArg ?? DEFAULT_ADVERSARIAL_MODE) as AdversarialMode;
  if (!ADVERSARIAL_MODES.includes(mode)) {
    throw new ZError(
      `--adversarial-mode must be one of "off", "non-trivial", "always", got ${JSON.stringify(modeArg)}.`
    );
  }

  // Per-seat model selection, fail-fast BEFORE any worktree or prompt write:
  // parse tokens (the reviewer seat rejects CLI providers by name), then
  // preflight each distinct requested CLI with the same check `setup` uses.
  const reviewerModel = parseReviewerSeat(str(flags, "reviewer-model") ?? "inherit");
  const skepticModelsRaw = str(flags, "skeptic-models");
  let tokens: string[] = [];
  if (skepticModelsRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(skepticModelsRaw);
    } catch (e) {
      throw new ZError(`--skeptic-models must be a JSON array of 0-3 tokens: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== "string")) {
      throw new ZError(`--skeptic-models must be a JSON array of 0-3 tokens (strings).`);
    }
    tokens = parsed as string[];
  }
  const skepticSeats: Seat[] = resolveSkepticSeats(tokens);
  preflightProviders(cliProvidersIn(skepticSeats), deps);

  if (!existsSync(join(repo, ".git"))) {
    throw new ZError(`--repo ${repo} is not a git checkout (no .git).`);
  }

  // Optional linked-issue JSON ({body, labels}) fetched by the skill; its
  // number lives on the PR's closingIssuesReferences, not in that file.
  const issueJsonPath = str(flags, "issue-json");
  let issue: { number: number | null; body: string; labels: { name: string }[] } | undefined;
  if (issueJsonPath) {
    const raw = readJson(issueJsonPath);
    issue = {
      number: pr.closingIssuesReferences[0]?.number ?? null,
      body: typeof raw.body === "string" ? raw.body : "",
      labels: Array.isArray(raw.labels) ? raw.labels : [],
    };
  }

  // Both commits locally present, or one bounded fetch of the PR head + base
  // ref. GitHub serves any PR's head at pull/<N>/head whether or not the fork
  // branch is a local remote-tracking ref.
  if (!hasCommit(repo, pr.headRefOid) || !hasCommit(repo, pr.baseRefOid)) {
    git(repo, ["fetch", "origin", pr.baseRefName, `pull/${pr.number}/head`], true);
    for (const sha of [pr.headRefOid, pr.baseRefOid]) {
      if (!hasCommit(repo, sha)) {
        throw new ZError(
          `Commit ${sha} is not present locally and \`git fetch origin ${pr.baseRefName} pull/${pr.number}/head\` did not bring it in. Fetch it manually, then re-run prepare.`
        );
      }
    }
  }

  // merge-base diff (three-dot), lockfiles excluded; a lockfile-only PR falls
  // back to the unfiltered diff so the reviewer is never handed an empty one.
  let diff = git(repo, [
    "diff",
    `${pr.baseRefOid}...${pr.headRefOid}`,
    "--",
    ".",
    ...DIFF_LOCKFILE_EXCLUDES,
  ]).stdout;
  if (diff.trim() === "") {
    diff = git(repo, ["diff", `${pr.baseRefOid}...${pr.headRefOid}`]).stdout;
  }
  if (diff.trim() === "") {
    throw new ZError(
      `PR #${pr.number}'s diff (${pr.baseRefOid}...${pr.headRefOid}) is empty -- nothing to review.`
    );
  }

  // Throwaway worktree of the head commit, under the repo's own .worktrees/
  // (never a system temp dir: reviewers run real test suites in here, and some
  // suites reach through homedir()/tmp during cleanup). Self-healing: a
  // leftover from an earlier run of the same PR is removed and re-added, so a
  // crashed review never wedges the next one.
  const worktreePath = join(repo, ".worktrees", `review-pr-${pr.number}`);
  git(repo, ["worktree", "prune"], true);
  if (existsSync(worktreePath)) {
    git(repo, ["worktree", "remove", "--force", worktreePath], true);
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    git(repo, ["worktree", "prune"], true);
  }
  git(repo, ["worktree", "add", "--detach", worktreePath, pr.headRefOid]);

  const { spec, specSource } = chooseSpec(pr.body, issue);
  const ac = extractAcceptanceCriteria(spec);
  const labels = [
    ...new Set([...pr.labels, ...(issue?.labels ?? [])].map((l) => l.name).filter(Boolean)),
  ].sort();

  mkdirSync(outDir, { recursive: true });
  const input: ReviewerPromptInput = {
    ticketBody: spec,
    acceptanceCriteria: ac !== "" ? ac : AC_FALLBACK,
    diff,
    worktreePath: resolve(worktreePath),
  };
  const inputPath = join(outDir, `input-pr-${pr.number}.json`);
  writeFileSync(inputPath, JSON.stringify(input, null, 2));
  const diffPath = join(outDir, `diff-pr-${pr.number}.patch`);
  writeFileSync(diffPath, diff);

  // Run identity + artifact tree (run-id.ts stageDest), rooted at out-dir: the
  // reviewer's verdict.json lands in its stage dir, each skeptic's in a
  // skeptic-<k>/ under it -- which is what lets quorumFromDisk's path-trust
  // rule apply unchanged.
  const runId = mintRunId(Date.now());
  const runRoot = join(outDir, "runs", runId);
  const reviewerDir = stageDest(outDir, runId, pr.number, "reviewer", STANDALONE_ATTEMPT);
  const skepticDirs = [1, 2, 3].map((k) => join(reviewerDir, `skeptic-${k}`));
  mkdirSync(reviewerDir, { recursive: true });
  for (const d of skepticDirs) mkdirSync(d, { recursive: true });
  const target: VerdictTarget = {
    path: verdictPath(reviewerDir),
    runId,
    ticket: pr.number,
    attempt: STANDALONE_ATTEMPT,
    skepticDirs,
  };

  // The constructor decides the fan-out: mode + the diff's own changed-line
  // count + labels. reviewerPrompt re-runs the four-key blindness gate on the
  // input we just wrote and composes the three skeptic briefs itself.
  const adversarial = adversarialActive(mode, countDiffLines(diff), labels);

  // A CLI seat's brief is a FILE its composed command feeds to the provider;
  // written here so the reviewer never pastes prompt text into a shell. Same
  // brief content as an Agent seat's -- a brief never names its seat's model.
  if (adversarial) {
    skepticSeats.forEach((seat, idx) => {
      if (seat.kind !== "cli") return;
      const k = idx + 1;
      writeFileSync(
        briefPath(skepticDirs[idx]),
        skepticBrief(k, input, inputPath, skepticDirs[idx], {
          runId,
          ticket: pr.number,
          stage: "skeptic",
          attempt: STANDALONE_ATTEMPT,
        })
      );
    });
  }

  const promptPath = join(outDir, `prompt-pr-${pr.number}.txt`);
  writeFileSync(promptPath, reviewerPrompt(input, inputPath, target, adversarial, skepticSeats));

  return {
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    specSource,
    acFound: ac !== "",
    diffLines: countDiffLines(diff),
    labels,
    adversarialMode: mode,
    adversarial,
    reviewerModel,
    skepticModels: skepticSeats.map(seatToken),
    runId,
    runRoot,
    verdictPath: target.path,
    inputPath,
    promptPath,
    diffPath,
    worktreePath: resolve(worktreePath),
    stub: spawnStub(promptPath),
  };
}

// -- collect ------------------------------------------------------------------

// Validate the reviewer's verdict file against the spawn prepare minted, then
// COUNT the skeptic quorum off disk (the reviewer's own tally is never read).
// INVALID is an answer, not a throw: the session relays the reason and treats
// the review as failed.
export type CollectResult =
  | {
      ok: true;
      result: string;
      notes: string;
      confidence: number | null;
      quorum: QuorumFromDisk | null; // null on a single pass (no skeptics listed)
    }
  | { ok: false; reason: string };

export function collect(
  verdictFile: string,
  runRoot: string,
  runId: string,
  ticket: number
): CollectResult {
  const expect: ExpectedSpawn = {
    runId,
    ticket,
    stage: "reviewer",
    attempt: STANDALONE_ATTEMPT,
  };
  const check = readVerdict(verdictFile, expect);
  if (!check.ok) return { ok: false, reason: check.reason };
  const v = check.verdict;
  const conf = (v.evidence as { confidence?: unknown } | undefined)?.confidence;
  const listed = (v.evidence as { skepticVerdictPaths?: unknown } | undefined)?.skepticVerdictPaths;
  const paths = Array.isArray(listed) ? listed.filter((p): p is string => typeof p === "string") : [];
  return {
    ok: true,
    result: v.result,
    notes: v.notes ?? "",
    confidence: typeof conf === "number" && conf >= 0 && conf <= 100 ? conf : null,
    quorum: Array.isArray(listed) ? quorumFromDisk(paths, runRoot, expect) : null,
  };
}

// -- cleanup ------------------------------------------------------------------

// Idempotent: absent worktree is success (prints "absent"), and a stale
// registration without a directory is pruned either way.
export function cleanup(repo: string, worktreePath: string): "removed" | "absent" {
  const wt = resolve(worktreePath);
  if (!existsSync(wt)) {
    git(repo, ["worktree", "prune"], true);
    return "absent";
  }
  git(repo, ["worktree", "remove", "--force", wt], true);
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  git(repo, ["worktree", "prune"], true);
  return "removed";
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `review <command> [args]

  prepare --pr-json <pr.json> --repo <dir> --out-dir <dir>
          [--issue-json <issue.json>] [--adversarial-mode <off|non-trivial|always>]
          [--reviewer-model <inherit|haiku|sonnet|opus|fable>]
          [--skeptic-models '<json array of 0-3 seat tokens>']
      Assemble the blinded reviewer input for a PR: spec (linked issue body,
      else PR description), acceptance-criteria slice, lockfile-excluded diff,
      throwaway worktree of the head commit, one-shot run identity -- then
      build the reviewer prompt (verdict-file exit contract, skeptic briefs
      when adversarial) and spawn stub. Prints a JSON manifest; pass its
      "stub" as the Agent spawn's prompt.
      pr.json:    gh pr view output with fields ${PR_FIELDS}
      issue.json: optional linked-issue fetch with fields body,labels
      Seat tokens: inherit|haiku|sonnet|opus|fable (Agent tool), or
      codex[:<m>]|gemini[:<m>]|agy[:<m>] (skeptic seats only; preflighted).
      Short lineups gap-fill with inherit; see lib/models.ts setup.

  collect --verdict <verdict.json> --run-root <dir> --run <runId> --ticket <n>
      Validate the reviewer's verdict file against the spawn prepare minted
      (all four values are in prepare's manifest), count the skeptic quorum
      off disk, and print JSON: {ok, result, notes, confidence, quorum} or
      {ok:false, reason}. Exit 0 both ways -- INVALID is an answer.

  cleanup --repo <dir> --worktree <path>
      Remove the throwaway worktree. Idempotent; prints "removed" or "absent".`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1));
    if (cmd === "prepare") {
      console.log(JSON.stringify(prepare(flags), null, 2));
      return 0;
    }
    if (cmd === "collect") {
      const ticketRaw = requireFlag(flags, "ticket");
      const ticket = Number(ticketRaw);
      if (!Number.isInteger(ticket) || ticket <= 0) {
        throw new ZError(`--ticket must be a positive integer, got ${JSON.stringify(ticketRaw)}.`);
      }
      console.log(
        JSON.stringify(
          collect(
            requireFlag(flags, "verdict"),
            requireFlag(flags, "run-root"),
            requireFlag(flags, "run"),
            ticket
          ),
          null,
          2
        )
      );
      return 0;
    }
    if (cmd === "cleanup") {
      const repo = resolve(requireFlag(flags, "repo"));
      console.log(cleanup(repo, requireFlag(flags, "worktree")));
      return 0;
    }
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

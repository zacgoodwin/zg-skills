// Prompt constructors for the blinded adversarial reviewer and its skeptics,
// extracted from zstack (lib/stage-prompts.ts, reviewer + skeptic surface).
// Prompt construction is deterministic space: each constructor is a pure
// function of a TYPED input object, so every spawn is a fresh context
// assembled from data -- no transcript, no conversation id, nothing latent
// can leak in.
//
// POINTER PROMPTS: each constructor takes a second arg, `inputPath` -- the
// absolute path of the review's input.json -- and inlines only small/fixed
// fields plus the discipline/exit-contract boilerplate. The large payload
// (ticketBody, acceptanceCriteria, diff) is NOT embedded; the prompt tells the
// worker to read those fields FROM inputPath. So the printed prompt is
// size-invariant to the payload, and the session that spawns the reviewer
// never holds the spec or the diff in its own context.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleCliError, parseFlags, str, ZError } from "./cli.ts";
import { INHERIT_SEAT, SKEPTIC_SEAT_COUNT, allInherit, briefPath, cliCommand, type Seat } from "./models.ts";
import { verdictInstructions, verdictPath, type ExpectedSpawn } from "./verdict.ts";

// -- adversarial mode ----------------------------------------------------------

export const ADVERSARIAL_MODES = ["off", "non-trivial", "always"] as const;
export type AdversarialMode = (typeof ADVERSARIAL_MODES)[number];
export const DEFAULT_ADVERSARIAL_MODE: AdversarialMode = "non-trivial";

// -- verdict target ------------------------------------------------------------

// Where this spawn's verdict file goes, plus the envelope values that go
// INSIDE it. `skepticDirs` is the three pre-computed skeptic artifact
// directories whose verdict paths the briefs name -- composed by the caller in
// code, never by the reviewer, which is what makes the quorum count
// enforceable.
export interface VerdictTarget {
  path: string; // the reviewer's own verdict.json
  runId: string;
  ticket: number;
  attempt: number;
  skepticDirs?: string[];
}

function spawnFor(t: VerdictTarget, stage: "reviewer" | "skeptic"): ExpectedSpawn {
  return { runId: t.runId, ticket: t.ticket, stage, attempt: t.attempt };
}

// -- spawn stub ----------------------------------------------------------------

// The pointer trick applied one level up: the session sends only a path, and
// the worker reads its own instructions. The stub's length depends on the path
// alone -- never on the prompt -- so the spawning session's context stays flat
// however large the spec and diff are. The explicit BLOCKED fallback matters:
// an unreadable prompt file must surface as a parseable outcome, never as a
// worker improvising a review with no instructions.
export function spawnStub(promptPath: string): string {
  return `You are the REVIEWER for a blinded adversarial code review, running UNATTENDED in a fresh context. No user is available.

Read this file NOW, before anything else, and follow it exactly. It is your complete instructions -- inputs, discipline, and the exit contract your run must satisfy:
${promptPath}

If you cannot read it, do nothing else and make your final message exactly:
BLOCKED: could not read reviewer prompt at ${promptPath}`;
}

// -- the blindness contract ----------------------------------------------------

// The reviewer sees the spec, the acceptance criteria, the diff, and a
// throwaway worktree path. NOTHING else -- no PR discussion, no CI status, no
// author narrative beyond what the spec itself discloses.
export interface ReviewerPromptInput {
  ticketBody: string;
  acceptanceCriteria: string;
  diff: string;
  worktreePath: string;
}

export const REVIEWER_INPUT_KEYS = [
  "ticketBody",
  "acceptanceCriteria",
  "diff",
  "worktreePath",
] as const;

// Compile-time half of the blindness gate: if ReviewerPromptInput ever gains or
// loses a key, this constant stops typechecking (Exact<A,B> collapses to never).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _reviewerKeysExact: Exact<keyof ReviewerPromptInput, (typeof REVIEWER_INPUT_KEYS)[number]> = true;
void _reviewerKeysExact;

// Runtime half: TS types erase, so a JS caller could smuggle a fifth field
// (prDescription, ciStatus...) into the object. Reject any key set that is not
// exactly the four -- blindness is enforced, not assumed.
export function assertReviewerInput(input: ReviewerPromptInput): void {
  const keys = Object.keys(input).sort();
  const want = [...REVIEWER_INPUT_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, idx) => k !== want[idx])) {
    throw new ZError(
      `Reviewer input must have exactly the keys {${want.join(", ")}}, got {${keys.join(", ")}}. The reviewer is blinded by design; nothing else may reach it.`
    );
  }
  for (const k of REVIEWER_INPUT_KEYS) {
    if (typeof input[k] !== "string" || input[k] === "") {
      throw new ZError(`Reviewer input "${k}" must be a non-empty string.`);
    }
  }
}

// -- adversarial activation ----------------------------------------------------

// The trigger labels the "non-trivial" mode escalates on regardless of diff
// size: a one-line change to any of these blast-radius surfaces still earns
// the skeptic fan-out.
export const ADVERSARIAL_TRIGGER_LABELS = ["security", "migration", "payments", "auth"] as const;

// The "non-trivial" mode's diff-size threshold (>= this many changed lines
// fans out). Named so the boundary is one constant, not a literal in a branch.
export const ADVERSARIAL_DIFF_THRESHOLD = 10;

// Changed-line count of a unified diff: lines added or removed, excluding the
// +++/--- file headers. The blast-radius proxy the "non-trivial" mode gates
// on. Deterministic space: line-counting is code, never model work.
export function countDiffLines(diff: string): number {
  return diff.split(/\r?\n/).filter(
    (l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")
  ).length;
}

// Pure activation predicate: does this review fan out skeptics? off -> never;
// always -> always; non-trivial -> diff >= threshold OR any trigger label.
export function adversarialActive(mode: AdversarialMode, diffLineCount: number, labels: string[]): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  const trig = new Set<string>(ADVERSARIAL_TRIGGER_LABELS);
  return diffLineCount >= ADVERSARIAL_DIFF_THRESHOLD || labels.some((l) => trig.has(l));
}

// -- shared discipline ---------------------------------------------------------

// Extracted with its scar tissue intact: agents that background a test suite
// (or a sub-agent) and end their turn "to wait" produce a run whose result
// reaches nobody -- the harness that spawned this reviewer sends it exactly
// one message and reads its result when the turn ends. zstack measured this
// failure repeatedly before wording it this way; the mechanism note lives in
// its lib/stage-prompts.ts history.
function foregroundRule(): string {
  return `## Verification runs in the FOREGROUND
Every command you verify with -- the test suite, typecheck, build, anything you would cite as evidence -- must run to completion IN THE FOREGROUND before you write your verdict file. Never background a gate and end your turn waiting on it: no one will wake you (the harness that spawned you sends exactly one message, by design), so the run's result reaches nobody. The same goes for anything else you are waiting on, a sub-agent included: report what you actually hold. Ending your turn with a background job still pending and no verdict file written loses your judgment entirely. Waiting is affordable: a test suite that takes a few minutes fits comfortably inside your budget. If a check is too slow to finish, write the verdict naming what you actually ran and what you did not.`;
}

// -- skeptic brief -------------------------------------------------------------

// One skeptic's complete brief: composed HERE, deterministically, so blindness
// and the verdict path are enforceable rather than whatever prose the reviewer
// improvises. The reviewer is told to pass each brief VERBATIM as an Agent
// spawn's prompt; the only thing it may not do is edit them. Each brief
// carries its own verdict-file contract, so a skeptic's report is a file the
// HARNESS counts -- the reviewer summarizing "3/3 agreed" has no effect on the
// quorum the report reads.
export function skepticBrief(k: number, input: ReviewerPromptInput, inputPath: string, dir: string, spawn: ExpectedSpawn): string {
  return `You are SKEPTIC ${k} of 3, a fresh context inside a blinded adversarial code review, blinded exactly as your reviewer is: your ONLY inputs are the ticket body, the acceptance criteria, and the diff, read from ${inputPath} (fields \`ticketBody\`, \`acceptanceCriteria\`, \`diff\`), plus the throwaway worktree at ${input.worktreePath} (yours to execute; nothing you do in it lands anywhere). No other skeptic's verdict reaches you and yours reaches no one but the harness.

Your task is to REFUTE that the diff satisfies the acceptance criteria: find the one criterion it violates, the edge it breaks, a test that passes without the change. Concrete evidence only -- file:line, a command you ran, an input that misbehaves.

${verdictInstructions("skeptic", verdictPath(dir), spawn)}

Result meanings: "REFUTED" = you found concrete evidence the diff fails a criterion -- name it in notes with file:line and the failing input. "UPHELD" = you genuinely tried and could not refute it; notes says what you attacked. "CONFUSED" = the inputs are unusable. Put your lens ("refutation") and the one claim you checked hardest in evidence.`;
}

// -- reviewer prompt -----------------------------------------------------------

// `inputPath` and `verdict` are constructor parameters, never input keys -- the
// four-key blindness gate fires first and neither the pointer path nor the
// verdict envelope reaches the reviewer as review data. `adversarial` false is
// the single pass; true folds in the super-truth skeptic fan-out.
//
// The super-truth block's collection mechanics are the hard-won part, kept
// verbatim from zstack (#318 there): sub-agents spawned with the Agent tool
// default to BACKGROUND, whose only delivery channel is a task notification
// BETWEEN turns -- and a one-message worker gets no next turn. The flag that
// makes collection happen inside the turn is named explicitly, the degraded
// path (k < 3) is sanctioned explicitly, and the k-to-confidence mapping is a
// lookup table, never arithmetic in a model reply.
//
// `skepticSeats` (per-seat model selection): 3 resolved seats, composed by the
// caller in code. All-inherit renders the pre-feature prompt BYTE-IDENTICALLY
// (golden-pinned); any other lineup renders the per-seat variant, where each
// seat's section names its exact launch mechanics -- an Agent tool spawn (with
// its `model` value when not inherit) or one exact CLI command for the Bash
// tool. Seat tokens are constructor params like `inputPath`, never input keys,
// and a brief never tells a skeptic what model it is.
const SKEPTIC_SHARED_TAIL = `You therefore never wait for a skeptic, and you never re-count for one either: each skeptic reports by WRITING ITS OWN VERDICT FILE, and the harness counts those files itself -- a skeptic that lands after you return still counts, and a tally you write cannot vouch for a file that is not there. Once your three tool calls return, read whichever skeptic verdict files exist, weigh any refutation's evidence in your own judgment, and write YOUR verdict. Do not spawn replacements, do not re-ping, and do not end your turn to "wait", "check back", or "await completion notifications" -- those are not slower routes to a verdict, they are how your review gets thrown away.

In your verdict file's evidence, set "skepticVerdictPaths" to the paths of ONLY the skeptic verdict files that exist when you look (0-3 of them; list none that you cannot read). Set "confidence" off this table over the k verdicts you actually hold -- do no arithmetic:
- k=3: 3 UPHELD -> 100, 2 -> 67, 1 -> 33, 0 -> 0
- k=2: 2 UPHELD -> 100, 1 -> 50, 0 -> 0
- k=1: 1 UPHELD -> 100, 0 -> 0
- k=0: nobody looked. Your OWN single-pass certainty that every criterion holds -- never 100, which would claim three independent agreements that never happened.
A criterion any skeptic REFUTED with concrete evidence is a finding, not a vote to be outnumbered -- surface it in your notes. An honest short list costs one more review pass; a padded one approves a diff nobody refuted.`;

function heredocBrief(k: number, brief: string): string {
  return `<<<SKEPTIC-${k}-BRIEF\n${brief}\nSKEPTIC-${k}-BRIEF`;
}

function seatSection(k: number, seat: Seat, brief: string, input: ReviewerPromptInput, dir: string, inputPath: string): string {
  if (seat.kind === "agent") {
    const modelClause = seat.model === "inherit" ? "" : `, \`model: "${seat.model}"\``;
    return `### Skeptic ${k} -- Agent seat: one Agent tool call${modelClause}, \`run_in_background: false\`, prompt = the brief below VERBATIM (edit nothing)\n\n${heredocBrief(k, brief)}`;
  }
  const command = cliCommand(seat, input.worktreePath, dir, inputPath);
  return `### Skeptic ${k} -- CLI seat (${seat.provider}): run this EXACT command with the Bash tool, in the FOREGROUND (edit nothing), with the Bash tool's \`timeout\` parameter set to 600000 -- the tool's DEFAULT 2-minute timeout would kill this CLI mid-review

\`\`\`bash
${command}
\`\`\`

The command itself feeds this seat's brief -- already on disk at ${briefPath(dir)} -- to the CLI. The brief is reproduced below for the record only; the command reads the FILE, so paste nothing:

${heredocBrief(k, brief)}`;
}

export function reviewerPrompt(
  input: ReviewerPromptInput,
  inputPath: string,
  verdict: VerdictTarget,
  adversarial: boolean = false,
  skepticSeats?: Seat[]
): string {
  assertReviewerInput(input);
  const skepticDirs = verdict.skepticDirs ?? [];
  if (adversarial && skepticDirs.length !== 3) {
    throw new ZError(
      `An adversarial reviewer prompt needs exactly 3 skeptic artifact directories (verdict.skepticDirs), got ${skepticDirs.length}. The caller composes them in code; the reviewer never invents paths.`
    );
  }
  const seats = skepticSeats ?? Array(SKEPTIC_SEAT_COUNT).fill(INHERIT_SEAT);
  if (adversarial && seats.length !== SKEPTIC_SEAT_COUNT) {
    throw new ZError(
      `An adversarial reviewer prompt needs exactly ${SKEPTIC_SEAT_COUNT} resolved skeptic seats, got ${seats.length}. resolveSkepticSeats gap-fills short lineups; the caller passes the resolved 3.`
    );
  }
  const legacyLineup = allInherit(seats);
  const briefs = adversarial
    ? skepticDirs
        .map((dir, idx) => {
          const k = idx + 1;
          const brief = skepticBrief(k, input, inputPath, dir, spawnFor(verdict, "skeptic"));
          return legacyLineup
            ? `### Skeptic ${k}'s brief -- pass VERBATIM as one Agent spawn's prompt (edit nothing)\n\n${heredocBrief(k, brief)}`
            : seatSection(k, seats[idx], brief, input, dir, inputPath);
        })
        .join("\n\n")
    : "";
  const superTruth = !adversarial
    ? ""
    : legacyLineup
      ? `
## Super-truth pass (adversarial mode active)
This diff's blast radius earned an adversarial review; do NOT trust your single read. Spawn 3 INDEPENDENT skeptic sub-agents with the Agent tool -- nested \`claude -p\` is denied by the classifier, so use the Agent tool, not headless claude. Their briefs are WRITTEN FOR YOU below, one per skeptic, each already carrying the blinded inputs pointer and its own verdict-file contract. Pass each brief verbatim as that spawn's prompt; the composition is not yours to edit -- a reworded brief is how blindness leaks and how verdict files end up where nothing counts them.

COLLECT THEM INSIDE THIS TURN. Spawn all three in ONE message, as three Agent tool calls each carrying \`run_in_background: false\`. That flag is the entire mechanism: it makes the three returns come back as tool results in this same turn, and the three still run concurrently because they were launched together. The DEFAULT is a background spawn, whose only delivery channel is a task notification BETWEEN turns -- and you get no next turn, because this harness sends you exactly one message by design. A backgrounded skeptic is one you will never hear from, however long you wait.

${SKEPTIC_SHARED_TAIL}

${briefs}
`
      : `
## Super-truth pass (adversarial mode active)
This diff's blast radius earned an adversarial review; do NOT trust your single read. Launch 3 INDEPENDENT skeptics -- this review runs a PER-SEAT lineup, and each seat's section below names its exact launch mechanics: an Agent tool spawn (nested \`claude -p\` is denied by the classifier, so use the Agent tool, not headless claude) or one EXACT CLI command for the Bash tool. The briefs are WRITTEN FOR YOU below, one per skeptic, each already carrying the blinded inputs pointer and its own verdict-file contract. Pass each Agent seat's brief verbatim as that spawn's prompt and run each CLI seat's command character-for-character; the composition is not yours to edit -- a reworded brief or an edited command is how blindness leaks and how verdict files end up where nothing counts them.

COLLECT THEM INSIDE THIS TURN. Launch all three in ONE message: each Agent seat as one Agent tool call carrying \`run_in_background: false\` (plus the \`model\` value its section names, when it names one), each CLI seat as one Bash tool call running its command in the FOREGROUND -- never backgrounded. Launched together they still run concurrently, and every return comes back as a tool result in this same turn. The Agent tool's DEFAULT is a background spawn, whose only delivery channel is a task notification BETWEEN turns -- and you get no next turn, because this harness sends you exactly one message by design. A backgrounded seat is one you will never hear from, however long you wait.

A CLI seat that errors or times out has written no verdict file: that is a real, reportable outcome, and the harness reports a short quorum honestly. Do not retry it, do not spawn a substitute, and NEVER write a verdict file on a dead seat's behalf -- you speak only for yourself.

${SKEPTIC_SHARED_TAIL}

${briefs}
`;
  return `You are an ADVERSARIAL REVIEWER in a fresh context, running UNATTENDED. You are blinded by design: your ONLY inputs are the spec, its acceptance criteria, the diff, and a throwaway worktree of the head commit. There is no PR discussion, no CI status, no author or reviewer transcript -- and any claim you cannot verify from these inputs yourself is unverified. Your job is to find the reasons this diff should NOT merge.

## Your inputs (read from the file -- do not look anywhere else)
Read \`ticketBody\`, \`acceptanceCriteria\`, and \`diff\` from ${inputPath}. That file holds EXACTLY those three fields plus this worktree path and nothing else -- no PR discussion, no CI status, no author transcript reaches you. The acceptance criteria are the yardstick; hold the diff to them as written, and weigh any provenance note the spec itself carries.

## Throwaway worktree (head commit checked out; yours to execute)
${input.worktreePath}
Run the typecheck and the tests this diff touches here. Nothing you do in it lands anywhere; discard it when done.

## Hunt for
- Acceptance criteria silently weakened, skipped, or asserted less strictly than written.
- Paths the diff adds but no test exercises; tests that pass without the change.
- Scope creep, dead code, abstractions the spec never asked for.
- Security holes at trust boundaries; data-loss edges; error paths that swallow failures.
${superTruth}
${foregroundRule()}

${verdictInstructions("reviewer", verdict.path, spawnFor(verdict, "reviewer"))}

Result meanings for this stage: "REVIEW-APPROVE" = every criterion verified against the diff, typecheck + touched tests green; evidence.confidence is your certainty every criterion holds, 0-100 (${adversarial ? "read it off the super-truth table above" : "self-assessed on this single pass"}) -- a low score is reported to the human as an approval with an asterisk, never hidden. "REVIEW-FINDINGS" = numbered findings in notes, each with file:line and why it blocks the merge. "NEEDS-HUMAN" = a genuine spec ambiguity a human must settle. "BLOCKED" = the throwaway worktree is unusable -- can't check out or execute the diff at all. "CONFUSED" = the inputs make no sense${adversarial ? `, including a skeptic fan-out so broken you cannot judge the diff at all (name what happened in notes)` : ""}.`;
}

// -- CLI ----------------------------------------------------------------------

// Used by evals/reviewer/run.sh (and hand debugging): build the reviewer
// prompt or the spawn stub from files, with the verdict target as flags. The
// production path (SKILL.md) goes through lib/review.ts prepare, which calls
// these constructors directly.
const USAGE = `prompts <command> [args]

  prompt <input.json> --verdict-path <p> --run <runId> --ticket <n> --attempt <k>
         [--adversarial-mode <off|non-trivial|always>] [--labels <json-array>]
         [--skeptic-dirs <json-array-of-3>]
      print the reviewer prompt; mode + the diff's own changed-line count +
      labels decide the super-truth fan-out deterministically

  stub <prompt.txt>
      print the spawn stub pointing at an already-written prompt file`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { positionals, flags } = parseFlags(argv.slice(1));
    if (cmd === "prompt") {
      const path = positionals[0];
      if (!path) throw new ZError("Usage: prompts prompt <input.json> --verdict-path <p> --run <r> --ticket <n> --attempt <k> [...]");
      let input: any;
      try {
        input = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new ZError(`Cannot read input JSON at ${path}: ${(e as Error).message}`);
      }
      const modeArg = str(flags, "adversarial-mode");
      const mode = (modeArg ?? DEFAULT_ADVERSARIAL_MODE) as AdversarialMode;
      if (!ADVERSARIAL_MODES.includes(mode)) {
        throw new ZError(`--adversarial-mode must be one of "off", "non-trivial", "always", got ${JSON.stringify(modeArg)}.`);
      }
      const jsonArray = (name: string): string[] | undefined => {
        const raw = str(flags, name);
        if (raw === undefined) return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new ZError(`--${name} must be a JSON array of strings: ${(e as Error).message}`);
        }
        if (!Array.isArray(parsed) || parsed.some((l) => typeof l !== "string")) {
          throw new ZError(`--${name} must be a JSON array of strings.`);
        }
        return parsed as string[];
      };
      const labels = jsonArray("labels") ?? [];
      const skepticDirs = jsonArray("skeptic-dirs");
      const num = (name: string): number => {
        const raw = str(flags, name);
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new ZError(`--${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
        return n;
      };
      const target: VerdictTarget = {
        path: str(flags, "verdict-path") ?? (() => { throw new ZError("Missing required --verdict-path."); })(),
        runId: str(flags, "run") ?? (() => { throw new ZError("Missing required --run."); })(),
        ticket: num("ticket"),
        attempt: num("attempt"),
        skepticDirs,
      };
      const active = adversarialActive(mode, countDiffLines(typeof input.diff === "string" ? input.diff : ""), labels);
      console.log(reviewerPrompt(input, resolve(path), target, active));
      return 0;
    }
    if (cmd === "stub") {
      const promptPath = positionals[0];
      if (!promptPath) throw new ZError("Usage: prompts stub <prompt.txt>");
      try {
        readFileSync(promptPath, "utf8");
      } catch (e) {
        throw new ZError(`Cannot read reviewer prompt at ${promptPath}: ${(e as Error).message}`);
      }
      console.log(spawnStub(resolve(promptPath)));
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

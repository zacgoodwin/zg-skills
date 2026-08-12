// The verdict contract, extracted from zstack (lib/verdict.ts, contract C2):
// a review stage reports its outcome by WRITING ONE FILE -- verdict.json in
// its own run-scoped artifact directory -- and the harness reads that file.
// Prose is never parsed.
//
// Why a file and not a final-message marker: a marker scanner reads the
// stage's prose, and prose can QUOTE a marker (out of its own instructions, or
// out of a ticket that contains one) without reporting it. A file is a
// deliberate structured act: an echo in prose is inert, and the whole
// token-position discipline a marker parser needs deletes with the problem
// class it bounded.
//
// The verdict is still SELF-REPORTED -- an agent can deliberately write a
// false one; the path is in its prompt. The enforcement is downstream and
// deterministic: the reviewer's skeptic quorum is COUNTED off the skeptic
// verdict files on disk rather than believed, and INVALID is one bucket on
// purpose -- a verdict that is unreadable, malformed, mis-addressed (wrong
// run/ticket/stage/attempt for the directory it sits in), out of its stage's
// result union, or carrying a placeholder payload is never reinterpreted or
// partially trusted.
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { handleCliError, parseFlags, requireFlag, ZError } from "./cli.ts";
import { isRunId } from "./run-id.ts";

export const VERDICT_SCHEMA_VERSION = 1;

// The file name inside a stage's artifact directory. One name, owned here.
export const VERDICT_BASENAME = "verdict.json";

export function verdictPath(stageDir: string): string {
  return join(stageDir, VERDICT_BASENAME);
}

// Per-stage result unions. CONFUSED is everywhere: "I cannot reach a verdict"
// needs a sanctioned spelling on every path or it gets spelled by silence.
// The skeptic is a first-class stage: its verdicts are files the harness
// counts, not prose the reviewer summarizes.
export const STAGE_RESULTS = {
  reviewer: ["REVIEW-APPROVE", "REVIEW-FINDINGS", "NEEDS-HUMAN", "BLOCKED", "CONFUSED"],
  skeptic: ["REFUTED", "UPHELD", "CONFUSED"],
} as const;

export type VerdictStage = keyof typeof STAGE_RESULTS;
export type VerdictResult = (typeof STAGE_RESULTS)[VerdictStage][number];

// What a stage writes. `notes` carries the human-facing line: the findings
// list, the question, the reason.
export interface StageVerdict {
  schema: number;
  runId: string;
  ticket: number;
  stage: VerdictStage;
  attempt: number;
  result: string;
  // Present per stage; validated shallowly here, deterministically downstream:
  //   reviewer { confidence, skepticVerdictPaths }  quorum counted off disk
  //   skeptic  { lens, claimChecked }
  evidence?: Record<string, unknown>;
  notes?: string;
}

// A verdict the stage was QUOTING rather than reporting: the contract's own
// template pasted with its placeholder intact.
const PLACEHOLDER_RE = /<(one-line|numbered|reason|what|the exact|the judgment|placeholder)[^>]*>/i;

export type VerdictCheck =
  | { ok: true; verdict: StageVerdict }
  | { ok: false; reason: string };

export interface ExpectedSpawn {
  runId: string;
  ticket: number;
  stage: VerdictStage;
  attempt: number;
}

// Validates one verdict file against the spawn the harness KNOWS it made.
// Never throws for content problems -- INVALID is an answer (`ok: false`);
// only a caller bug (bad `expect`) throws.
export function readVerdict(path: string, expect: ExpectedSpawn): VerdictCheck {
  if (!isRunId(expect.runId)) throw new ZError(`readVerdict: expected runId ${JSON.stringify(expect.runId)} is not a runId.`);
  if (!(expect.stage in STAGE_RESULTS)) throw new ZError(`readVerdict: unknown stage ${JSON.stringify(expect.stage)}.`);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: `no verdict file at ${path} (${(e as Error).message})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `verdict at ${path} is not valid JSON (${(e as Error).message})` };
  }
  const v = parsed as Partial<StageVerdict>;
  if (typeof v !== "object" || v === null) return { ok: false, reason: `verdict at ${path} is not a JSON object` };
  if (v.schema !== VERDICT_SCHEMA_VERSION) {
    return { ok: false, reason: `verdict schema ${JSON.stringify(v.schema)} (this binary understands ${VERDICT_SCHEMA_VERSION})` };
  }
  // Mis-addressed = INVALID: a verdict copied (or maliciously written) into
  // another spawn's directory must never speak for that spawn.
  for (const [key, want] of [
    ["runId", expect.runId],
    ["ticket", expect.ticket],
    ["stage", expect.stage],
    ["attempt", expect.attempt],
  ] as const) {
    if (v[key] !== want) {
      return { ok: false, reason: `verdict ${key} ${JSON.stringify(v[key])} does not match this spawn's ${key} ${JSON.stringify(want)}` };
    }
  }
  const allowed = STAGE_RESULTS[expect.stage] as readonly string[];
  if (typeof v.result !== "string" || !allowed.includes(v.result)) {
    return { ok: false, reason: `result ${JSON.stringify(v.result)} is not in ${expect.stage}'s union {${allowed.join(", ")}}` };
  }
  if (typeof v.notes === "string" && PLACEHOLDER_RE.test(v.notes)) {
    return { ok: false, reason: `notes still carry the contract's own placeholder -- the template was pasted, not filled` };
  }
  if (v.evidence !== undefined && (typeof v.evidence !== "object" || v.evidence === null || Array.isArray(v.evidence))) {
    return { ok: false, reason: `evidence must be an object when present` };
  }
  return { ok: true, verdict: v as StageVerdict };
}

// -- reviewer quorum, counted off disk ----------------------------------------

// Path-trust rule: a skeptic verdict path the reviewer lists must resolve
// INSIDE the same runs/<runId>/t<ticket>/ subtree after normalization. A path
// outside it (another run's directory, a /tmp file the reviewer invented, a
// traversal) is invalid -- listing it was the lie.
export function pathInsideTicketTree(p: string, runRoot: string, ticket: number): boolean {
  const base = resolve(runRoot, `t${ticket}`) + sep;
  const target = resolve(p);
  return target.startsWith(base);
}

export interface QuorumFromDisk {
  received: number; // valid skeptic verdict files actually on disk
  of: number; // how many the reviewer was told to spawn
  unrefuted: number; // valid verdicts whose result is UPHELD
  invalid: string[]; // one reason per listed-but-unusable path
}

// The number the report trusts. The reviewer's own tally is never read; the
// DIRECTORY is read at collect time, not the reviewer's memory, so a skeptic
// verdict that landed after the reviewer returned still counts.
export function quorumFromDisk(
  skepticVerdictPaths: string[],
  runRoot: string,
  expect: ExpectedSpawn,
  of = 3
): QuorumFromDisk {
  const invalid: string[] = [];
  let received = 0;
  let unrefuted = 0;
  const seen = new Set<string>();
  for (const p of skepticVerdictPaths) {
    const key = resolve(p);
    if (seen.has(key)) {
      invalid.push(`${p}: listed twice`);
      continue;
    }
    seen.add(key);
    if (!pathInsideTicketTree(p, runRoot, expect.ticket)) {
      invalid.push(`${p}: outside this review's run subtree`);
      continue;
    }
    const check = readVerdict(p, { ...expect, stage: "skeptic" });
    if (!check.ok) {
      invalid.push(`${p}: ${check.reason}`);
      continue;
    }
    received++;
    if (check.verdict.result === "UPHELD") unrefuted++;
  }
  return { received, of, unrefuted, invalid };
}

// -- prompt-side contract text -------------------------------------------------

// The exit-contract block every prompt renders. Owned HERE so the writer
// instructions and this reader can never drift: the prompts import this
// function, and the union it prints is the union readVerdict enforces.
//
// The final message is one fixed line -- the stage's report IS the file. That
// also bounds the return cost: the spawner reads back one line, never a
// findings essay.
export function verdictInstructions(stage: VerdictStage, path: string, spawn: ExpectedSpawn): string {
  const results = STAGE_RESULTS[stage]
    .map((r) => `  "${r}"`)
    .join("\n");
  const evidenceHint = {
    reviewer: `"evidence": { "confidence": <0-100>, "skepticVerdictPaths": [<the skeptic verdict paths you were given, ONLY those that exist>] },`,
    skeptic: `"evidence": { "lens": "<your assigned lens>", "claimChecked": "<one line>" },`,
  }[stage];
  return `## Exit contract -- write ONE file, then end with one line (machine-read)
Your verdict is a FILE, not prose. Before your final message, write EXACTLY this file:

${path}

with EXACTLY this JSON shape (fill every value; a verdict still carrying a <placeholder> is invalid):

{
  "schema": ${VERDICT_SCHEMA_VERSION},
  "runId": "${spawn.runId}",
  "ticket": ${spawn.ticket},
  "stage": "${stage}",
  "attempt": ${spawn.attempt},
  "result": <one of the values below>,
  ${evidenceHint}
  "notes": "<one line: the summary, the question, the numbered findings, or the reason>"
}

"result" MUST be exactly one of:
${results}

There is no path out of this stage that ends without this file: finished, failed, out of budget, or waiting on something that never arrived -- write the file with the honest result ("BLOCKED" or "CONFUSED" are real, actionable verdicts; a missing file is not) and put the detail in "notes". Nothing you print in prose is read by the harness: a result named only in your final message does not exist. After writing the file, make your final message exactly:
verdict written`;
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `verdict <command> [args]

  check <verdict.json> --run <runId> --ticket <n> --stage <reviewer|skeptic> --attempt <k>
        validate one verdict file against the spawn it must speak for; prints
        {"ok":true,"verdict":{...}} or {"ok":false,"reason":"..."} (exit 0 both
        ways -- INVALID is an answer; exit 1 is a usage/caller error)`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { positionals, flags } = parseFlags(argv.slice(1));
    if (cmd === "check") {
      const path = positionals[0];
      if (!path) throw new ZError(`Usage: verdict check <verdict.json> --run <runId> --ticket <n> --stage <stage> --attempt <k>`);
      const stage = requireFlag(flags, "stage") as VerdictStage;
      if (!(stage in STAGE_RESULTS)) throw new ZError(`--stage must be one of ${Object.keys(STAGE_RESULTS).join(", ")}, got ${JSON.stringify(stage)}.`);
      const num = (name: string): number => {
        const raw = requireFlag(flags, name);
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new ZError(`--${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
        return n;
      };
      const expect: ExpectedSpawn = { runId: requireFlag(flags, "run"), ticket: num("ticket"), stage, attempt: num("attempt") };
      console.log(JSON.stringify(readVerdict(path, expect)));
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

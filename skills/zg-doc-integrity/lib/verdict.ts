// The verdict contract, adapted from z-adversarial-review/lib/verdict.ts.
//
// A stage reports its outcome by WRITING ONE FILE in its own run-scoped
// directory, and the harness reads that file. Prose is never parsed: a marker
// scanner reads the stage's own words, and words can QUOTE a marker -- out of
// their instructions, or out of a document that happens to contain one --
// without reporting it. A file is a deliberate structured act.
//
// The verdict is still SELF-REPORTED. What is enforced is the envelope, the
// result union, and the fact that the quorum is COUNTED off the files on disk
// rather than believed from anyone's summary. INVALID is one bucket on purpose:
// a verdict that is unreadable, malformed, mis-addressed, out of its stage's
// union, or carrying a placeholder is never partially trusted.
//
// Differs from the sibling skill in two ways: the stages are this pipeline's
// (`discover`, `refute`) rather than reviewer/skeptic, and a spawn is addressed
// by review ROUND rather than by ticket, because the comment loop re-runs the
// same documents.
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { handleCliError, parseFlags, parseJson, requireFlag, ZError } from "./cli.ts";
import { isRunId } from "./run-id.ts";

export const VERDICT_SCHEMA_VERSION = 1;
export const VERDICT_BASENAME = "verdict.json";
export const FINDINGS_BASENAME = "findings.json";
export const CLAIMS_BASENAME = "claims.json";

export function verdictPath(stageDir: string): string {
  return join(stageDir, VERDICT_BASENAME);
}

// Per-stage result unions. CONFUSED is on every stage: "I cannot reach a
// verdict" needs a sanctioned spelling everywhere, or it gets spelled by
// silence.
export const STAGE_RESULTS = {
  discover: ["FINDINGS", "CLEAN", "BLOCKED", "CONFUSED"],
  refute: ["REFUTED", "UPHELD", "CONFUSED"],
} as const;

export type VerdictStage = keyof typeof STAGE_RESULTS;
export type VerdictResult = (typeof STAGE_RESULTS)[VerdictStage][number];

export interface StageVerdict {
  schema: number;
  runId: string;
  round: number;
  stage: VerdictStage;
  attempt: number;
  result: string;
  evidence?: Record<string, unknown>;
  notes?: string;
}

// A verdict the stage was QUOTING rather than reporting: the contract's own
// template pasted with its placeholder intact.
const PLACEHOLDER_RE = /<(one-line|one\s|the exact|the reason|reason|what|your|VERBATIM|short|optional|placeholder)[^>]*>/i;

export type VerdictCheck = { ok: true; verdict: StageVerdict } | { ok: false; reason: string };

export interface ExpectedSpawn {
  runId: string;
  round: number;
  stage: VerdictStage;
  attempt: number;
}

// Validates one verdict file against the spawn the harness KNOWS it made.
// Content problems never throw -- INVALID is an answer; only a caller bug does.
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
    parsed = parseJson(raw);
  } catch (e) {
    return { ok: false, reason: `verdict at ${path} is not valid JSON (${(e as Error).message})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `verdict at ${path} is not a JSON object` };
  }
  const v = parsed as Partial<StageVerdict>;
  if (v.schema !== VERDICT_SCHEMA_VERSION) {
    return { ok: false, reason: `verdict schema ${JSON.stringify(v.schema)} (this binary understands ${VERDICT_SCHEMA_VERSION})` };
  }
  // Mis-addressed = INVALID: a verdict copied into another spawn's directory
  // must never speak for that spawn.
  for (const [key, want] of [
    ["runId", expect.runId],
    ["round", expect.round],
    ["stage", expect.stage],
    ["attempt", expect.attempt],
  ] as const) {
    if (v[key] !== want) {
      return {
        ok: false,
        reason: `verdict ${key} ${JSON.stringify(v[key])} does not match this spawn's ${key} ${JSON.stringify(want)}`,
      };
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

// -- refutation quorum, counted off disk -------------------------------------------

// Path-trust rule: a verdict path must resolve INSIDE this run's own subtree.
// A path outside it -- another run's directory, a temp file the agent invented,
// a traversal -- is invalid, and listing it was the lie.
export function pathInsideRunTree(p: string, runRoot: string): boolean {
  const base = resolve(runRoot) + sep;
  return resolve(p).startsWith(base);
}

export interface Quorum {
  received: number; // valid verdict files actually on disk
  of: number; // how many refuters were dispatched
  upheld: number;
  refuted: number;
  confused: number;
  invalid: string[]; // one reason per listed-but-unusable path
}

// The numbers confidence is priced from. The DIRECTORY is read at collect time,
// not any agent's memory, so a verdict that landed late still counts.
export function quorumFromDisk(paths: string[], runRoot: string, expect: ExpectedSpawn, of: number): Quorum {
  const q: Quorum = { received: 0, of, upheld: 0, refuted: 0, confused: 0, invalid: [] };
  const seen = new Set<string>();
  for (const p of paths) {
    const key = resolve(p);
    if (seen.has(key)) {
      q.invalid.push(`${p}: listed twice`);
      continue;
    }
    seen.add(key);
    if (!pathInsideRunTree(p, runRoot)) {
      q.invalid.push(`${p}: outside this review's run subtree`);
      continue;
    }
    const check = readVerdict(p, { ...expect, stage: "refute" });
    if (!check.ok) {
      q.invalid.push(`${p}: ${check.reason}`);
      continue;
    }
    q.received++;
    if (check.verdict.result === "UPHELD") q.upheld++;
    else if (check.verdict.result === "REFUTED") q.refuted++;
    else q.confused++;
  }
  return q;
}

// -- prompt-side contract text --------------------------------------------------------

// The exit-contract block every verdict-writing prompt renders. Owned HERE so
// the writer instructions and this reader can never drift: the prompt imports
// this function, and the union it prints is the union readVerdict enforces.
export function verdictInstructions(stage: VerdictStage, path: string, spawn: ExpectedSpawn): string {
  const results = STAGE_RESULTS[stage].map((r) => `  "${r}"`).join("\n");
  const evidenceHint = {
    discover: `"evidence": { "findingsPath": "<the findings file you wrote>", "count": <how many findings> },`,
    refute: `"evidence": { "attack": "<which line of attack you used, or the one that failed>" },`,
  }[stage];
  // Name only THIS stage's escape hatches. Offering a refuter "BLOCKED" -- a
  // discover-stage result -- invites a verdict its own reader would reject.
  const escapes = (STAGE_RESULTS[stage] as readonly string[]).filter((r) => r === "BLOCKED" || r === "CONFUSED");
  const escapeClause =
    escapes.length === 1
      ? `("${escapes[0]}" is a real, actionable verdict; a missing file is not)`
      : `(${escapes.map((e) => `"${e}"`).join(" and ")} are real, actionable verdicts; a missing file is not)`;
  return `## Exit contract -- write ONE file, then end with one line (machine-read)

Your verdict is a FILE, not prose. Before your final message, write EXACTLY this file:

${path}

with EXACTLY this JSON shape (fill every value; a verdict still carrying a placeholder in angle brackets is invalid):

{
  "schema": ${VERDICT_SCHEMA_VERSION},
  "runId": "${spawn.runId}",
  "round": ${spawn.round},
  "stage": "${stage}",
  "attempt": ${spawn.attempt},
  "result": <one of the values below>,
  ${evidenceHint}
  "notes": "one line: the summary, the reason, or the judgment"
}

"result" MUST be exactly one of:
${results}

There is no path out of this stage that ends without this file: finished,
failed, out of budget, or waiting on something that never arrived -- write the
file with the honest result ${escapeClause} and put the detail in "notes". Nothing you
print in prose is read by the harness: a result named only in your final message
does not exist. After writing the file, make your final message exactly:
verdict written`;
}

// -- CLI ------------------------------------------------------------------------------

const USAGE = `verdict <command> [args]

  check <verdict.json> --run <runId> --round <n> --stage <discover|refute> --attempt <k>
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
      if (!path) throw new ZError(`Usage: verdict check <verdict.json> --run <runId> --round <n> --stage <stage> --attempt <k>`);
      const stage = requireFlag(flags, "stage") as VerdictStage;
      if (!(stage in STAGE_RESULTS)) {
        throw new ZError(`--stage must be one of ${Object.keys(STAGE_RESULTS).join(", ")}, got ${JSON.stringify(stage)}.`);
      }
      const num = (name: string): number => {
        const raw = requireFlag(flags, name);
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new ZError(`--${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
        return n;
      };
      const expect: ExpectedSpawn = { runId: requireFlag(flags, "run"), round: num("round"), stage, attempt: num("attempt") };
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

// The orchestrator: every verb the skill runs, and all the state that lives
// between them.
//
// Everything decidable is decided here, in code -- which seats to spawn, which
// briefs they get, which findings earn a refuter, what the plan says, whether
// the edited plan means apply or regenerate, and whether the edits that landed
// were the ones approved. The model's job is to run the spawns this file
// describes and relay what it prints.
//
// One run = one directory. `continue` re-reads that directory rather than
// remembering anything, so a review survives the session that started it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Bundle,
  ensureGitignored,
  loadBundle,
  writeBundleDir,
} from "./bundle.ts";
import { handleCliError, parseFlags, readJsonFile, str, ZError } from "./cli.ts";
import {
  type Finding,
  type RawFinding,
  type Unverifiable,
  refutationPriority,
  resolveAndMerge,
  scoreConfidence,
  seatBase,
  seatPartName,
} from "./findings.ts";
import { buildInventories } from "./inventory.ts";
import {
  declinedFingerprints,
  emptyDecisions,
  loadPlanFile,
  parsePlan,
  planStatus,
  PLAN_SCHEMA_VERSION,
  readDecisions,
  recordDecisions,
  type PlanFile,
  type PlanStatus,
  writeDecisions,
  writePlan,
} from "./plan.ts";
import {
  cliDiscoverBrief,
  directiveBrief,
  FINDINGS_FINAL_LINE,
  numericBrief,
  reduceBrief,
  refuteBrief,
  shardBrief,
  spawnStub,
  splitCliDiscoverBrief,
  termBrief,
  VERDICT_FINAL_LINE,
  type ClaimRecord,
} from "./prompts.ts";
import {
  applyBrief,
  conflictingEdits,
  planEdits,
  snapshotFiles,
  verifyAll,
  type FileWorkUnit,
  type Snapshot,
} from "./apply.ts";
import {
  briefPath,
  CLI_BRIEF_CAP,
  briefFits,
  cliCommand,
  ndjsonBrief,
  ndjsonBriefPath,
  realDeps,
  parseSeatTokens,
  preflightProviders,
  providersIn,
  readProviderPreference,
  type CliSeat,
  type ProviderDeps,
} from "./providers.ts";
import { assembleNextRound, carryForward, MAX_ROUNDS, regenBrief } from "./regenerate.ts";
import { mintRunId, roundSegment, runRoot } from "./run-id.ts";
import { batchShards, planShards, renderShard, type Shard } from "./shard.ts";
import { structureFindings, STRUCTURE_SEAT } from "./structure.ts";
import { quorumFromDisk, verdictInstructions, type ExpectedSpawn } from "./verdict.ts";

export const STATE_DIR = ".doc-integrity";
export const REFUTE_CAP = 15;
export const MAX_CLUSTERS_PER_BRIEF = 30;
export const REFUTERS_PER_FINDING = 3;

// -- run state -------------------------------------------------------------------

export interface RunState {
  schema: number;
  runId: string;
  round: number;
  patterns: string[];
  cwd: string;
  repoRoot: string;
  providers: string[];
  documents: { id: string; relPath: string; lines: number }[];
}

function statePath(root: string): string {
  return join(root, "state.json");
}

function readState(root: string): RunState {
  const p = statePath(root);
  if (!existsSync(p)) throw new ZError(`No run state at ${p}. Start a review with \`prepare\` first.`);
  const s = readJsonFile(p) as RunState;
  if (s.schema !== 1) throw new ZError(`Run state schema ${s.schema} (this binary understands 1).`);
  return s;
}

// Written through a temporary file and renamed, because latestRun treats the
// presence of this file as "this run is complete and runnable". A direct write
// interrupted partway would leave a state.json that exists and does not parse,
// which is the same masking problem one layer down. rename within a directory
// is atomic on both POSIX and Windows, so the file is either absent or whole.
// Exported for the fault-injection test, which blocks the temporary path and
// asserts nothing gets published. Not part of the verb surface.
export function writeState(root: string, s: RunState): void {
  const p = statePath(root);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}

// The newest run under the state directory. Lets `continue` work with no
// arguments, which is the whole point of a one-verb gate.
export function latestRun(repoRoot: string): string | null {
  const runs = join(repoRoot, STATE_DIR, "runs");
  if (!existsSync(runs)) return null;
  // state.json is the LAST thing prepare writes, so a run directory without one
  // is a setup that died partway -- bundle and briefs on disk, nothing runnable.
  // Those must not win the "latest" race: a crashed prepare would otherwise mask
  // the last usable review and send every argument-less merge, collect and
  // continue at a run that cannot answer.
  const ids = readdirSync(runs)
    .filter((d) => /^run-\d{8}-\d{6}-[0-9a-f]{4}$/.test(d) && existsSync(join(runs, d, "state.json")))
    .sort();
  return ids.length === 0 ? null : join(runs, ids[ids.length - 1]);
}

function resolveRunRoot(flags: Record<string, string | boolean>, repoRoot: string): string {
  const explicit = str(flags, "run");
  if (explicit) return resolve(explicit);
  const latest = latestRun(repoRoot);
  if (!latest) throw new ZError(`No review found under ${join(repoRoot, STATE_DIR)}. Start one with \`prepare\`.`);
  return latest;
}

function roundDir(root: string, round: number): string {
  return join(root, roundSegment(round));
}

function rebuildBundle(state: RunState): Bundle {
  return loadBundle(state.patterns, state.cwd, state.repoRoot);
}

// -- prepare ------------------------------------------------------------------------

export interface Spawn {
  seat: string;
  kind: "shard" | "term" | "numeric" | "directive" | "reduce" | "cli-discover" | "refute" | "apply" | "regen";
  briefPath: string;
  outPath: string; // findings.json or verdict.json, whichever the seat writes
  claimsPath?: string;
  command?: string; // set for CLI seats: run this verbatim, foreground
  // The ~300-byte pointer the orchestrator passes to an Agent-tool seat. Filled
  // in by withStubs below so no construction site can forget it.
  stub?: string;
}

// Every spawn leaves this file carrying its stub, and the orchestrator passes
// THAT rather than the brief. Reading a brief to relay it would put the shard
// text, the clusters, or the finding under attack into the orchestrator's own
// context -- which is precisely what the blinding contract withholds from the
// seats, and the orchestrator is the one who then writes the report.
function withStubs(spawns: Spawn[]): Spawn[] {
  for (const s of spawns) {
    if (s.command) continue; // a CLI seat is launched by its command, not a prompt
    const finalLine =
      s.kind === "refute"
        ? VERDICT_FINAL_LINE
        : s.kind === "apply"
          ? "one line naming how many edits you made and any you skipped"
          : FINDINGS_FINAL_LINE;
    s.stub = spawnStub(s.briefPath, finalLine);
  }
  return spawns;
}

export interface PrepareManifest {
  runId: string;
  round: number;
  runRoot: string;
  bundleDir: string;
  documents: RunState["documents"];
  totalLines: number;
  spawns: Spawn[];
  structureFindings: number;
  inventory: { terms: number; numerics: number; directives: number };
  skipped: string[];
  nextCommand: string;
}

// Caps accumulate across phases and must all reach the plan. prepare and merge
// each report their own to the orchestrator, but the PLAN is what the human
// reads, and a cap that bit in an earlier phase is exactly what "we checked
// everything" would otherwise be hiding.
function recordSkipped(roundDirPath: string, notes: string[]): void {
  if (notes.length === 0) return;
  const p = join(roundDirPath, "skipped.json");
  let prior: string[] = [];
  if (existsSync(p)) {
    try {
      const raw = readJsonFile(p);
      if (Array.isArray(raw)) prior = raw.filter((x) => typeof x === "string");
    } catch {
      // An unreadable ledger must not lose the note we are adding now.
    }
  }
  writeFileSync(p, JSON.stringify([...new Set([...prior, ...notes])], null, 2));
}

function writeBrief(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const p = briefPath(dir);
  writeFileSync(p, text);
  return p;
}

// A CLI seat gets its brief twice: as text, and as the one-line NDJSON message
// agy's stdin mode reads. Written unconditionally rather than behind a size
// check, so the file is never the reason a command that chose the stdin form
// fails. brief.txt stays the readable record either way.
function writeCliBrief(dir: string, text: string): string {
  const p = writeBrief(dir, text);
  writeFileSync(ndjsonBriefPath(dir), ndjsonBrief(text));
  return p;
}

export function prepare(opts: {
  patterns: string[];
  cwd: string;
  repoRoot: string;
  providerTokens: string[];
  now: number;
  // Injected only by tests, so the CLI-seat path can be exercised on a machine
  // that has neither vendor installed.
  deps?: ProviderDeps;
}): PrepareManifest {
  const cliSeats: CliSeat[] = parseSeatTokens(opts.providerTokens);
  // Fail before any directory is created: half a review is worse than none.
  preflightProviders(providersIn(cliSeats), opts.deps ?? realDeps());

  const bundle = loadBundle(opts.patterns, opts.cwd, opts.repoRoot);
  const runId = mintRunId(opts.now);
  const root = runRoot(join(opts.repoRoot, STATE_DIR), runId);
  const round = 1;
  const rDir = roundDir(root, round);
  mkdirSync(rDir, { recursive: true });
  ensureGitignored(opts.repoRoot, `${STATE_DIR}/`);

  const bundleDir = join(root, "bundle");
  writeBundleDir(bundle, bundleDir);

  const inv = buildInventories(bundle);
  const shards = planShards(bundle);
  const batches = batchShards(shards);
  const skipped: string[] = [];
  if (batches.length < shards.length) {
    skipped.push(`${shards.length} shards ran on ${batches.length} agents (shard-agent cap); several shards share a reader`);
  }

  const spawns: Spawn[] = [];
  const seatDir = (seat: string) => join(rDir, "discover", seat);

  batches.forEach((group, i) => {
    const seat = `shard-${i + 1}`;
    const dir = seatDir(seat);
    const text = group.map((s: Shard) => renderShard(bundle, s, "contradiction")).join("\n");
    const findingsPath = join(dir, "findings.json");
    const claimsPath = join(dir, "claims.json");
    const brief = writeBrief(
      dir,
      shardBrief({ bundle, shard: { ...group[0], id: seat, lines: group.reduce((n, s) => n + s.lines, 0) }, shardText: text, findingsPath, claimsPath })
    );
    spawns.push({ seat, kind: "shard", briefPath: brief, outPath: findingsPath, claimsPath });
  });

  // Clusters are already sorted by reach, so a cap keeps the widest-spread
  // candidates -- the cross-document ones a reader cannot see for themselves.
  const capped = <T>(list: T[], label: string): T[] => {
    if (list.length <= MAX_CLUSTERS_PER_BRIEF) return list;
    skipped.push(
      `${list.length} ${label} clusters found; the ${MAX_CLUSTERS_PER_BRIEF} with the widest spread were reviewed`
    );
    return list.slice(0, MAX_CLUSTERS_PER_BRIEF);
  };
  const terms = capped(inv.terms, "term");
  const numerics = capped(inv.numerics, "numeric");
  const directives = capped(inv.directives, "directive");

  const cluster = (seat: string, kind: Spawn["kind"], text: string) => {
    const dir = seatDir(seat);
    const findingsPath = join(dir, "findings.json");
    spawns.push({ seat, kind, briefPath: writeBrief(dir, text), outPath: findingsPath });
  };
  if (terms.length > 0) cluster("term-cluster", "term", termBrief(terms, join(seatDir("term-cluster"), "findings.json")));
  if (numerics.length > 0) cluster("numeric-cluster", "numeric", numericBrief(numerics, join(seatDir("numeric-cluster"), "findings.json")));
  if (directives.length > 0) cluster("directive-cluster", "directive", directiveBrief(directives, join(seatDir("directive-cluster"), "findings.json")));

  // Outside CLIs read the clusters, not every shard: their value is a different
  // vendor's judgment on the same candidates, not a second full sweep. The
  // CAPPED lists, same as the Claude cluster seats -- handing the CLI the full
  // inventory instead is what produced a 1.4M-char brief that killed both seats
  // before either read a word, one on codex's input cap and one on the argv cap.
  for (const seat of cliSeats) {
    const name = `cli-${seat.provider}${seat.model ? `-${seat.model}` : ""}`;
    // Two different paths, on purpose. The unsplit seat writes to its own
    // directory, so THAT is the path that decides whether a split is needed at
    // all -- sizing the question with a suffix the seat will never carry splits
    // a near-limit brief for no reason and files a cap note that did not happen.
    // Once a split IS needed, each part's directory carries a "~part-NofM"
    // suffix and the findings path is embedded in the brief several times, so
    // the parts are sized against the LONGEST path any part could be given. A
    // split cannot produce more parts than there are clusters, so that bound is
    // exact and needs no margin guess.
    const group = { terms, numerics, directives };
    const unsplitPath = join(seatDir(name), "findings.json");
    const maxParts = Math.max(1, terms.length + numerics.length + directives.length);
    const sizingPath = join(seatDir(seatPartName(name, maxParts - 1, maxParts)), "findings.json");
    const parts =
      cliDiscoverBrief(group, unsplitPath).length <= CLI_BRIEF_CAP
        ? [group]
        : splitCliDiscoverBrief(group, sizingPath, CLI_BRIEF_CAP);
    if (parts.length > 1) {
      skipped.push(
        `seat ${name}'s brief was over the ${CLI_BRIEF_CAP}-char provider input cap and ran as ${parts.length} parts; each part is a whole seat and its silence is reported separately`
      );
    }
    parts.forEach((group, i) => {
      const partName = seatPartName(name, i, parts.length);
      const dir = seatDir(partName);
      const findingsPath = join(dir, "findings.json");
      const text = cliDiscoverBrief(group, findingsPath);
      spawns.push({
        seat: partName,
        kind: "cli-discover",
        briefPath: writeCliBrief(dir, text),
        outPath: findingsPath,
        command: cliCommand(seat, bundleDir, dir, text.length),
      });
    });
  }

  const structure = structureFindings(bundle);
  writeFileSync(join(rDir, "structure.json"), JSON.stringify(structure, null, 2));

  // The skipped ledger before the state, so state.json really is the last file
  // prepare writes. latestRun reads its presence as "this run is complete", and
  // that is only true if nothing else is still outstanding when it lands.
  recordSkipped(rDir, skipped);

  const documents = bundle.docs.map((d) => ({ id: d.id, relPath: d.relPath, lines: d.lines.length }));
  writeState(root, {
    schema: 1,
    runId,
    round,
    patterns: opts.patterns,
    cwd: opts.cwd,
    repoRoot: opts.repoRoot,
    providers: opts.providerTokens,
    documents,
  });

  return {
    runId,
    round,
    runRoot: root,
    bundleDir,
    documents,
    totalLines: bundle.totalLines,
    spawns: withStubs(spawns),
    structureFindings: structure.findings.length,
    inventory: { terms: inv.terms.length, numerics: inv.numerics.length, directives: inv.directives.length },
    skipped,
    nextCommand: `merge --run "${root}"`,
  };
}

// -- merge ----------------------------------------------------------------------------

function readFindingsFile(path: string): RawFinding[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readJsonFile(path);
    return Array.isArray(raw?.findings) ? raw.findings : [];
  } catch {
    return [];
  }
}

function readClaimsFile(path: string, shardId: string): ClaimRecord[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readJsonFile(path);
    if (!Array.isArray(raw?.claims)) return [];
    return raw.claims
      .filter((c: any) => typeof c?.quote === "string" && typeof c?.assertion === "string")
      .map((c: any) => ({ shardId, subject: String(c.subject ?? ""), assertion: String(c.assertion), quote: String(c.quote) }));
  } catch {
    return [];
  }
}

export interface MergeManifest {
  runId: string;
  round: number;
  findings: number;
  unverifiable: number;
  seatsHeardFrom: string[];
  seatsSilent: string[];
  reduceSpawn: Spawn | null;
  refuteSpawns: Spawn[];
  skipped: string[];
  nextCommand: string;
}

// Two phases in one verb: gather what the discovery seats wrote, and dispatch
// the reduce pass plus the refuters that the results earn.
export function merge(root: string, opts: { reduceDone?: boolean } = {}): MergeManifest {
  const state = readState(root);
  const bundle = rebuildBundle(state);
  const rDir = roundDir(root, state.round);
  const discoverDir = join(rDir, "discover");
  const seats = existsSync(discoverDir) ? readdirSync(discoverDir).sort() : [];

  const batches: { seat: string; findings: RawFinding[] }[] = [];
  const claims: ClaimRecord[] = [];
  const heard: string[] = [];
  const silent: string[] = [];

  for (const seat of seats) {
    const dir = join(discoverDir, seat);
    const findingsPath = join(dir, "findings.json");
    if (existsSync(findingsPath)) heard.push(seat);
    else silent.push(seat);
    batches.push({ seat: seatBase(seat), findings: readFindingsFile(findingsPath) });
    claims.push(...readClaimsFile(join(dir, "claims.json"), seat));
  }

  // The structure lens needs no agent and never goes silent.
  const structure = existsSync(join(rDir, "structure.json"))
    ? readJsonFile(join(rDir, "structure.json"))
    : { findings: [], unverifiableRefs: [] };
  batches.push({ seat: STRUCTURE_SEAT, findings: structure.findings });

  // The reduce pass reads the claim ledgers, so it can only run once the shard
  // seats have written them.
  let reduceSpawn: Spawn | null = null;
  const reduceDir = join(discoverDir, "reduce");
  if (!opts.reduceDone && claims.length > 0 && !existsSync(join(reduceDir, "findings.json"))) {
    const findingsPath = join(reduceDir, "findings.json");
    reduceSpawn = {
      seat: "reduce",
      kind: "reduce",
      briefPath: writeBrief(reduceDir, reduceBrief(claims, findingsPath)),
      outPath: findingsPath,
    };
  }

  const decisions = readDecisions(join(root, "decisions.json"));
  const { findings, unverifiable } = resolveAndMerge(bundle, batches, declinedFingerprints(decisions));
  writeFileSync(join(rDir, "merged.json"), JSON.stringify({ findings, unverifiable }, null, 2));

  const skipped: string[] = [];
  if (silent.length > 0) skipped.push(`${silent.length} discovery seat(s) wrote nothing: ${silent.join(", ")}`);

  // Refutation goes where the stakes are highest and the discovery evidence is
  // thinnest. Anything below the cap ships marked unrefuted rather than
  // quietly presented as verified.
  // A finding the structure lens computed is a fact about the document graph,
  // not a claim, so there is nothing for an adversary to attack. Sending them
  // anyway wastes refuters and -- as the first eval run showed -- lets three of
  // them kill a verifiable duplicate heading on the grounds that it did not
  // matter, which is a severity judgment made in the wrong place.
  const refutable = findings.filter((f) => !f.deterministic);
  const ranked = [...refutable].sort((a, b) => refutationPriority(b) - refutationPriority(a));
  const chosen = ranked.slice(0, REFUTE_CAP);
  if (findings.length > refutable.length) {
    skipped.push(
      `${findings.length - refutable.length} finding(s) were computed in code and skip refutation; they are facts about the document graph, not claims`
    );
  }
  if (ranked.length > chosen.length) {
    skipped.push(`refutation ran on the top ${chosen.length} of ${ranked.length} findings (cap); the rest are marked unrefuted`);
  }

  const cliSeats = parseSeatTokens(state.providers);
  const refuteSpawns: Spawn[] = [];
  if (reduceSpawn === null) {
    for (const f of chosen) {
      const claudeSeats = Math.max(0, REFUTERS_PER_FINDING - cliSeats.length);
      const seatNames = [
        ...Array.from({ length: claudeSeats }, (_, i) => `claude-${i + 1}`),
        ...cliSeats.map((s) => `${s.provider}${s.model ? `-${s.model}` : ""}`),
      ];
      seatNames.forEach((name, i) => {
        const dir = join(rDir, "refute", `${f.id}-${name}`);
        const verdictPath = join(dir, "verdict.json");
        const spawn: ExpectedSpawn = { runId: state.runId, round: state.round, stage: "refute", attempt: 1 };
        const cli = cliSeats.find((s) => `${s.provider}${s.model ? `-${s.model}` : ""}` === name);
        const briefText = refuteBrief({
          findingTitle: f.title,
          findingSummary: f.summary,
          kind: f.kind,
          sides: f.sides.map((s) => ({
            label: s.label,
            quote: s.quote,
            context: s.instances
              .map((inst) => `${inst.relPath}:${inst.line}\n${contextOf(bundle, inst.docId, inst.line)}`)
              .join("\n\n"),
          })),
          verdictPath,
          verdictBlock: verdictInstructions("refute", verdictPath, spawn),
        });
        // A refute brief cannot be split the way a discovery brief can: a
        // refuter shown half a finding is judging a different finding. So an
        // oversized one costs that finding ONE seat, recorded, rather than
        // throwing out of a merge that has already spent every discovery seat.
        // `of` is the number of refuter directories on disk, so a seat that is
        // never dispatched lowers the quorum honestly instead of going missing.
        if (cli && !briefFits(briefText.length)) {
          skipped.push(
            `refuter ${name} for ${f.id} was not dispatched: its brief is ${briefText.length} chars, over the ${CLI_BRIEF_CAP}-char provider input cap; the finding is judged by its remaining refuters`
          );
          return;
        }
        refuteSpawns.push({
          seat: `${f.id}-${name}`,
          kind: "refute",
          briefPath: cli ? writeCliBrief(dir, briefText) : writeBrief(dir, briefText),
          outPath: verdictPath,
          command: cli ? cliCommand(cli, join(root, "bundle"), dir, briefText.length) : undefined,
        });
      });
    }
  }

  recordSkipped(rDir, skipped);

  return {
    runId: state.runId,
    round: state.round,
    findings: findings.length,
    unverifiable: unverifiable.length,
    seatsHeardFrom: heard,
    seatsSilent: silent,
    reduceSpawn: reduceSpawn ? withStubs([reduceSpawn])[0] : null,
    refuteSpawns: withStubs(refuteSpawns),
    skipped,
    nextCommand: reduceSpawn ? `merge --run "${root}"` : `collect --run "${root}"`,
  };
}

function contextOf(bundle: Bundle, docId: string, line: number): string {
  const doc = bundle.docs.find((d) => d.id === docId);
  if (!doc) return "";
  const start = Math.max(1, line - 8);
  const end = Math.min(doc.lines.length, line + 8);
  const out: string[] = [];
  for (let ln = start; ln <= end; ln++) out.push(`${ln}${ln === line ? " >" : "  "} ${doc.lines[ln - 1]}`);
  return out.join("\n");
}

// -- collect ---------------------------------------------------------------------------

export interface CollectManifest {
  runId: string;
  round: number;
  planMd: string;
  planJson: string;
  counts: { main: number; lowConfidence: number; refuted: number; unverifiable: number };
  skipped: string[];
  nextCommand: string;
}

export function collect(root: string): CollectManifest {
  const state = readState(root);
  const rDir = roundDir(root, state.round);
  const mergedPath = join(rDir, "merged.json");
  if (!existsSync(mergedPath)) throw new ZError(`No merged findings at ${mergedPath}. Run \`merge\` first.`);
  const merged = readJsonFile(mergedPath) as { findings: Finding[]; unverifiable: Unverifiable[] };

  // Quorum is counted off the verdict files on disk, never off any agent's
  // account of what its refuters said.
  const refuteDir = join(rDir, "refute");
  const dirs = existsSync(refuteDir) ? readdirSync(refuteDir) : [];
  const expect: ExpectedSpawn = { runId: state.runId, round: state.round, stage: "refute", attempt: 1 };

  const findings = merged.findings.map((f) => {
    if (f.deterministic) return f;
    const mine = dirs.filter((d) => d.startsWith(`${f.id}-`)).map((d) => join(refuteDir, d, "verdict.json"));
    if (mine.length === 0) return f;
    const q = quorumFromDisk(mine, root, expect, mine.length);
    const allExact = [...f.sides, ...f.options.flatMap((o) => ({ instances: o.editSites }))].every((s: any) =>
      (s.instances ?? []).every((i: any) => i.quality === "exact")
    );
    return { ...f, confidence: scoreConfidence(f.seats, allExact, { upheld: q.upheld, refuted: q.refuted, confused: q.confused }) };
  });

  const structure = existsSync(join(rDir, "structure.json"))
    ? readJsonFile(join(rDir, "structure.json"))
    : { unverifiableRefs: [] };

  const priorPlanPath = state.round > 1 ? join(roundDir(root, state.round - 1), "plan.json") : null;
  const carried = priorPlanPath && existsSync(priorPlanPath) ? loadPlanFile(priorPlanPath).carried : undefined;

  const skipped: string[] = [];
  const skippedPath = join(rDir, "skipped.json");
  if (existsSync(skippedPath)) skipped.push(...readJsonFile(skippedPath));

  const plan: PlanFile = {
    schema: PLAN_SCHEMA_VERSION,
    meta: {
      runId: state.runId,
      round: state.round,
      documents: state.documents,
      seats: [...new Set(findings.flatMap((f) => f.seats))].sort(),
      refutedCount: dirs.length,
      skipped,
    },
    findings,
    unverifiable: merged.unverifiable,
    outsideRefs: (structure.unverifiableRefs ?? []).map((r: any) => ({
      relPath: r.relPath,
      line: r.line,
      target: r.target,
      reason: r.reason,
    })),
    carried,
  };

  const planMd = join(rDir, "plan.md");
  const planJson = join(rDir, "plan.json");
  writePlan(plan, planMd, planJson);

  const placement = (p: string) => findings.filter((f) => {
    const s = f.confidence;
    if (s.outcome === "all-refuted" || s.outcome === "majority-refuted") return p === "refuted";
    return p === (s.score < 40 ? "low" : "main");
  }).length;

  return {
    runId: state.runId,
    round: state.round,
    planMd,
    planJson,
    counts: {
      main: placement("main"),
      lowConfidence: placement("low"),
      refuted: placement("refuted"),
      unverifiable: merged.unverifiable.length,
    },
    skipped,
    nextCommand: `continue --run "${root}"  (after you have filled in ${planMd})`,
  };
}

// -- continue: the one gate verb ------------------------------------------------------------

export interface ContinueManifest {
  runId: string;
  round: number;
  action: PlanStatus["action"];
  reasons: string[];
  resolved: number;
  declined: number;
  comments: number;
  regenSpawns: Spawn[];
  applySpawns: Spawn[];
  conflicts: string[];
  reopened: { title: string; reason: string }[];
  nextCommand: string;
}

// What happens next is decided by the plan's own contents, not by a flag: any
// comment means another round, a complete plan means apply, and anything
// ambiguous means stop and say why.
export function continueRun(root: string): ContinueManifest {
  const state = readState(root);
  const rDir = roundDir(root, state.round);
  const planJson = join(rDir, "plan.json");
  const planMd = join(rDir, "plan.md");
  if (!existsSync(planJson)) throw new ZError(`No plan at ${planJson}. Run \`collect\` first.`);
  if (!existsSync(planMd)) throw new ZError(`No plan markdown at ${planMd} -- that is the file you edit.`);

  const plan = loadPlanFile(planJson);
  const parsed = parsePlan(readFileSync(planMd, "utf8"), plan);
  const status = planStatus(parsed);
  const bundle = rebuildBundle(state);

  const base = {
    runId: state.runId,
    round: state.round,
    action: status.action,
    reasons: status.reasons,
    resolved: status.resolved.length,
    declined: status.declined.length,
    comments: status.comments.length + (status.globalComment === "" ? 0 : 1),
    regenSpawns: [] as Spawn[],
    applySpawns: [] as Spawn[],
    conflicts: [] as string[],
    reopened: [] as { title: string; reason: string }[],
  };

  if (status.action !== "APPLY" && status.action !== "REGENERATE") {
    return { ...base, nextCommand: `edit ${planMd}, then: continue --run "${root}"` };
  }

  // Decisions are recorded whichever way the round goes, so a "change nothing"
  // survives into later rounds even when the round itself regenerates.
  const decisionsPath = join(root, "decisions.json");
  writeDecisions(decisionsPath, recordDecisions(readDecisions(decisionsPath), plan, status, state.round));

  if (status.action === "REGENERATE") {
    if (state.round >= MAX_ROUNDS) {
      return {
        ...base,
        action: "BLOCKED",
        reasons: [`round ${state.round} is the cap (${MAX_ROUNDS}); stopping rather than looping. Settle the remaining findings by hand.`],
        nextCommand: `edit ${planMd} to remove the comments, then: continue --run "${root}"`,
      };
    }
    const next = state.round + 1;
    const nextDir = roundDir(root, next);
    mkdirSync(join(nextDir, "discover"), { recursive: true });

    const byId = new Map(plan.findings.map((f) => [f.id, f]));
    const regenSpawns: Spawn[] = [];
    for (const c of status.comments) {
      const f = byId.get(c.id);
      if (!f) continue;
      const dir = join(nextDir, "discover", `regen-${f.id}`);
      const findingsPath = join(dir, "findings.json");
      regenSpawns.push({
        seat: `regen-${f.id}`,
        kind: "regen",
        briefPath: writeBrief(
          dir,
          regenBrief({ finding: f, comment: c.text, globalComment: status.globalComment, bundle, findingsPath })
        ),
        outPath: findingsPath,
      });
    }

    // Findings nobody commented on are carried across rather than re-derived:
    // re-running a lens over untouched text costs money and risks a different
    // answer to the same question.
    const assembled = assembleNextRound({ prior: plan, status, regenerated: [] });
    writeFileSync(join(nextDir, "carried-findings.json"), JSON.stringify({ findings: assembled.untouched }, null, 2));
    const { carried, reopened } = carryForward(plan, status, assembled.untouched, state.round);
    writeFileSync(join(nextDir, "carried.json"), JSON.stringify(carried, null, 2));

    writeState(root, { ...state, round: next });
    return {
      ...base,
      regenSpawns: withStubs(regenSpawns),
      reopened: reopened.map((r) => ({ title: r.title, reason: r.reason })),
      nextCommand: `merge --run "${root}"`,
    };
  }

  // APPLY.
  const units = planEdits(bundle, plan, status);
  const conflicts = conflictingEdits(units);
  if (conflicts.length > 0) {
    return {
      ...base,
      action: "BLOCKED",
      reasons: conflicts,
      conflicts,
      nextCommand: `edit ${planMd} to resolve the overlap, then: continue --run "${root}"`,
    };
  }

  const snapshots = snapshotFiles(units, join(root, "snapshots"));
  writeFileSync(join(rDir, "work-units.json"), JSON.stringify({ units, snapshots }, null, 2));

  const applySpawns: Spawn[] = units.map((u) => {
    const dir = join(rDir, "apply", u.docId);
    const doc = bundle.docs.find((d) => d.id === u.docId)!;
    return {
      seat: `apply-${u.docId}`,
      kind: "apply" as const,
      briefPath: writeBrief(dir, applyBrief(u, doc)),
      outPath: u.absPath,
    };
  });

  return { ...base, applySpawns: withStubs(applySpawns), nextCommand: `verify --run "${root}"` };
}

// -- verify ------------------------------------------------------------------------------------

export interface VerifyManifest {
  runId: string;
  ok: boolean;
  files: { relPath: string; applied: string[]; notApplied: string[]; blast: string[] }[];
  restoreHints: string[];
  nextCommand: string;
}

export function verify(root: string): VerifyManifest {
  const state = readState(root);
  const rDir = roundDir(root, state.round);
  const p = join(rDir, "work-units.json");
  if (!existsSync(p)) throw new ZError(`No apply was planned in this round (${p} is missing).`);
  const { units, snapshots } = readJsonFile(p) as { units: FileWorkUnit[]; snapshots: Snapshot[] };
  const report = verifyAll(units, snapshots);
  return {
    runId: state.runId,
    ok: report.ok,
    files: report.results.map((r) => ({ relPath: r.relPath, applied: r.applied, notApplied: r.notApplied, blast: r.blast })),
    restoreHints: report.restoreHints,
    nextCommand: report.ok
      ? `done. To re-review the edited documents: prepare ${state.patterns.map((x) => JSON.stringify(x)).join(" ")}`
      : `restore from the snapshots above, then re-run: continue --run "${root}"`,
  };
}

// -- CLI ------------------------------------------------------------------------------------------

const USAGE = `run <command> [args]

  prepare <path-or-glob>... [--repo <dir>] [--providers '<json array>']
      Load the documents, build the bundle directory and the four inventories,
      plan the shards, emit the structure findings, and write every discovery
      brief. Prints a manifest of spawns to run.

  merge [--run <dir>]
      Gather what the discovery seats wrote, resolve every quote to its
      citations, merge duplicates across seats, and dispatch the reduce pass and
      the refuters that the findings earn.

  collect [--run <dir>]
      Count the refutation quorum off disk, score confidence, and write
      plan.md (the file you edit) plus plan.json (the machine truth).

  continue [--run <dir>]
      Read the edited plan and do what it says: regenerate if it carries any
      comment, apply if it is complete, stop and explain if it is neither.

  verify [--run <dir>]
      Check the edits that landed against the ones the plan approved.

  setup / preference
      See \`providers --help\`.`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { positionals, flags } = parseFlags(argv.slice(1));
    const repoRoot = resolve(str(flags, "repo") ?? ".");

    if (cmd === "prepare") {
      const providersRaw = str(flags, "providers");
      let tokens: string[];
      if (providersRaw !== undefined) {
        const parsed = JSON.parse(providersRaw);
        if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== "string")) {
          throw new ZError(`--providers must be a JSON array of provider tokens.`);
        }
        tokens = parsed;
      } else {
        tokens = readProviderPreference().providers;
      }
      // Document paths resolve against --repo, not the process cwd. --repo
      // names the repository holding the documents, so `--repo ../other-project
      // docs/a.md` means that project's docs/a.md. With --repo omitted both are
      // ".", which is the common case and behaves identically.
      console.log(
        JSON.stringify(
          prepare({ patterns: positionals, cwd: repoRoot, repoRoot, providerTokens: tokens, now: Date.now() }),
          null,
          2
        )
      );
      return 0;
    }
    if (cmd === "merge") {
      console.log(JSON.stringify(merge(resolveRunRoot(flags, repoRoot)), null, 2));
      return 0;
    }
    if (cmd === "collect") {
      console.log(JSON.stringify(collect(resolveRunRoot(flags, repoRoot)), null, 2));
      return 0;
    }
    if (cmd === "continue") {
      const m = continueRun(resolveRunRoot(flags, repoRoot));
      console.log(JSON.stringify(m, null, 2));
      return m.action === "BLOCKED" ? 1 : 0;
    }
    if (cmd === "verify") {
      const m = verify(resolveRunRoot(flags, repoRoot));
      console.log(JSON.stringify(m, null, 2));
      return m.ok ? 0 : 1;
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

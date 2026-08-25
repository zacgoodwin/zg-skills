// Run identity. One review = one runId = one artifact root
// (.doc-integrity/runs/<runId>/). The runId is stamped into every verdict
// file's envelope, which is what lets a verdict be validated against the exact
// spawn it must speak for -- a stale file from an earlier round can never be
// mis-read as this round's.
//
// Adapted from z-adversarial-review/lib/run-id.ts. The one difference: that
// skill scopes artifacts by PR number (`t<ticket>`), and a document review has
// no ticket. The scope segment here is a free-form slug -- the review round --
// so the same subtree holds `r1/`, `r2/` as the comment loop iterates.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ZError } from "./cli.ts";

// Format: run-<UTCyyyymmdd-hhmmss>-<4hex>. Readable and sortable on purpose:
// the operator-facing directory name says when the review ran. The 4-hex
// suffix (crypto) breaks the tie when two runs start within the same second.
const RUN_ID_RE = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;

export function isRunId(s: string): boolean {
  return RUN_ID_RE.test(s);
}

// `suffix` is injectable for tests only; production always takes the crypto
// default. Throws on a malformed injected suffix rather than minting an id
// isRunId would then reject.
export function mintRunId(nowMs: number, suffix?: string): string {
  const d = new Date(nowMs);
  if (!Number.isFinite(nowMs) || Number.isNaN(d.getTime())) {
    throw new ZError(`mintRunId: nowMs must be a millisecond epoch, got ${JSON.stringify(nowMs)}.`);
  }
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `-${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;
  const hex = suffix ?? randomBytes(2).toString("hex");
  const id = `run-${stamp}-${hex}`;
  if (!isRunId(id)) {
    throw new ZError(`mintRunId: minted "${id}" which is not a valid runId -- suffix must be 4 lowercase hex chars.`);
  }
  return id;
}

// A review round. Round 1 is the first plan; each comment cycle increments it.
// Kept as a positive integer so it orders naturally and renders as `r<n>`.
export function roundSegment(round: number): string {
  if (!Number.isInteger(round) || round <= 0) {
    throw new ZError(`roundSegment: round must be a positive integer, got ${JSON.stringify(round)}.`);
  }
  return `r${round}`;
}

// The canonical on-disk home of one spawn's artifacts:
// <stateDir>/runs/<runId>/r<round>/<stage>-<attempt>. Composed HERE, in code,
// and nowhere else, so attempt collisions and cross-round bleed are
// structurally impossible rather than convention.
export function stageDest(
  stateDir: string,
  runId: string,
  round: number,
  stage: string,
  attempt: number
): string {
  if (!isRunId(runId)) {
    throw new ZError(`stageDest: "${runId}" is not a runId (run-<yyyymmdd>-<hhmmss>-<4hex>).`);
  }
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new ZError(`stageDest: attempt must be a positive integer, got ${JSON.stringify(attempt)}.`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(stage)) {
    throw new ZError(`stageDest: stage ${JSON.stringify(stage)} must be a lowercase slug (it becomes a directory name).`);
  }
  return join(stateDir, "runs", runId, roundSegment(round), `${stage}-${attempt}`);
}

// The run root for one review: everything a run writes lives under here, and
// the path-trust rule downstream is "resolves inside this subtree".
export function runRoot(stateDir: string, runId: string): string {
  if (!isRunId(runId)) {
    throw new ZError(`runRoot: "${runId}" is not a runId.`);
  }
  return join(stateDir, "runs", runId);
}

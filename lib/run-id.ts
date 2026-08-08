// Run identity, extracted from zstack (lib/run-id.ts): one review = one runId
// = one artifact root (runs/<runId>/ under the review's out-dir). The runId is
// stamped into every verdict file's envelope, which is what lets a verdict be
// validated against the exact spawn it must speak for -- a stale file from an
// earlier attempt can never be mis-read as this run's.
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

// The canonical on-disk home of one spawn's artifacts:
// <stateDir>/runs/<runId>/t<ticket>/<stage>-<attempt>. Composed HERE, in code,
// and nowhere else, so attempt collisions and cross-run bleed are structurally
// impossible rather than convention.
export function stageDest(stateDir: string, runId: string, ticket: number, stage: string, attempt: number): string {
  if (!isRunId(runId)) {
    throw new ZError(`stageDest: "${runId}" is not a runId (run-<yyyymmdd>-<hhmmss>-<4hex>).`);
  }
  return join(stateDir, "runs", runId, `t${ticket}`, `${stage}-${attempt}`);
}

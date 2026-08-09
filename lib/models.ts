// Per-seat model selection for the adversarial review: the seat-token
// grammar, the gap-fill that resolves a short lineup to 3 seats, the three
// cross-provider CLI adapters (codex / gemini / agy), the preflight that
// fail-fasts prepare on a missing CLI, and the `setup` verb that validates
// the provider fleet before a review ever depends on it.
//
// The verdict contract is already provider-neutral (lib/verdict.ts): any
// process that writes a well-addressed verdict.json counts. This file's job
// is only to get the right process launched -- composed HERE, in code, and
// rendered verbatim into the reviewer prompt, never improvised by the model.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { handleCliError, parseFlags, str, ZError } from "./cli.ts";

// -- seat-token grammar --------------------------------------------------------

// Agent-tool tokens: any seat. `inherit` omits the Agent `model` param so the
// spawn runs on the session's model -- the pre-feature behavior, byte for byte.
export const AGENT_MODELS = ["inherit", "haiku", "sonnet", "opus", "fable"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

// CLI tokens: skeptic seats ONLY. The reviewer's orchestration prompt is
// Claude-harness-specific (Agent tool mechanics, run_in_background
// discipline), so the reviewer seat rejects these with a named error.
export const CLI_PROVIDERS = ["codex", "gemini", "agy"] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];
const PROVIDER_ALIASES: Record<string, CliProvider> = { antigravity: "agy" };

export type Seat =
  | { kind: "agent"; model: AgentModel }
  | { kind: "cli"; provider: CliProvider; model?: string };

export const SKEPTIC_SEAT_COUNT = 3;
export const INHERIT_SEAT: Seat = { kind: "agent", model: "inherit" };

export const TOKEN_GRAMMAR =
  "inherit | haiku | sonnet | opus | fable | codex[:<model>] | gemini[:<model>] | agy[:<model>] (alias antigravity)";

// Provider model suffixes are spliced into a shell command; the charset is the
// injection boundary, not a vendor catalog (unknown-but-well-formed models are
// the provider's own error to raise).
const CLI_MODEL_RE = /^[A-Za-z0-9._/-]+$/;

export function parseSeatToken(token: string): Seat {
  if ((AGENT_MODELS as readonly string[]).includes(token)) {
    return { kind: "agent", model: token as AgentModel };
  }
  const colon = token.indexOf(":");
  const head = colon === -1 ? token : token.slice(0, colon);
  const provider = (CLI_PROVIDERS as readonly string[]).includes(head)
    ? (head as CliProvider)
    : PROVIDER_ALIASES[head];
  if (!provider) {
    throw new ZError(`Unknown model token ${JSON.stringify(token)}. Allowed: ${TOKEN_GRAMMAR}.`);
  }
  if (colon === -1) return { kind: "cli", provider };
  const model = token.slice(colon + 1);
  if (model === "" || !CLI_MODEL_RE.test(model)) {
    throw new ZError(
      `Token ${JSON.stringify(token)}: the model suffix after ":" must be non-empty and match ${CLI_MODEL_RE} (it is spliced into a shell command).`
    );
  }
  return { kind: "cli", provider, model };
}

// Canonical token render, recorded in the manifest (alias-normalized).
export function seatToken(seat: Seat): string {
  return seat.kind === "agent" ? seat.model : seat.model ? `${seat.provider}:${seat.model}` : seat.provider;
}

// Gap-fill: tokens take seats 1..k in order, remaining seats inherit (Claude,
// session model). Absent flag / [] resolves all-inherit -- byte-identical to
// the pre-feature lineup.
export function resolveSkepticSeats(tokens: string[]): Seat[] {
  if (tokens.length > SKEPTIC_SEAT_COUNT) {
    throw new ZError(
      `--skeptic-models takes at most ${SKEPTIC_SEAT_COUNT} tokens (one per skeptic seat), got ${tokens.length}.`
    );
  }
  const seats = tokens.map(parseSeatToken);
  while (seats.length < SKEPTIC_SEAT_COUNT) seats.push(INHERIT_SEAT);
  return seats;
}

// The reviewer seat is Claude-only; a CLI token here gets the rule by name.
export function parseReviewerSeat(token: string): AgentModel {
  const seat = parseSeatToken(token);
  if (seat.kind === "cli") {
    throw new ZError(
      `--reviewer-model ${JSON.stringify(token)}: the reviewer seat runs on the Claude harness only (its orchestration prompt is Agent-tool-specific). Allowed: ${AGENT_MODELS.join(" | ")}. CLI providers are for --skeptic-models.`
    );
  }
  return seat.model;
}

export function allInherit(seats: Seat[]): boolean {
  return seats.every((s) => s.kind === "agent" && s.model === "inherit");
}

export function cliProvidersIn(seats: Seat[]): CliProvider[] {
  return [...new Set(seats.filter((s): s is Seat & { kind: "cli" } => s.kind === "cli").map((s) => s.provider))];
}

// -- CLI adapters --------------------------------------------------------------

// Forward slashes on purpose: the composed command runs under the reviewer's
// Bash tool (Git Bash on Windows), where backslash paths get eaten; Windows
// APIs accept D:/x/y just as well.
function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function briefPath(skepticDir: string): string {
  return join(skepticDir, "brief.txt");
}

// One exact command per provider, cwd = the throwaway worktree, verdict dir
// granted explicitly, run FOREGROUND via the reviewer's Bash tool. The brief
// is a FILE (prepare writes it) so no prompt text rides the command line
// except agy's, whose headless mode takes the prompt as an argument.
//
// gemini and agy sandbox READS to their granted directories, and the brief
// points every skeptic at the blinded input file -- so those two are granted
// the input file's directory as well as their own verdict dir. codex's
// workspace-write sandbox restricts only writes, so its grant stays the
// verdict dir alone.
export function cliCommand(
  seat: Seat & { kind: "cli" },
  worktreePath: string,
  skepticDir: string,
  inputPath: string
): string {
  const wt = shPath(worktreePath);
  const dir = shPath(skepticDir);
  const inputDir = shPath(dirname(inputPath));
  const brief = `${dir}/brief.txt`;
  switch (seat.provider) {
    case "codex":
      return `codex exec -s workspace-write --cd "${wt}" -c 'sandbox_workspace_write.writable_roots=["${dir}"]'${seat.model ? ` -m ${seat.model}` : ""} --skip-git-repo-check - < "${brief}"`;
    case "gemini":
      // --skip-trust = per-session folder trust, no config writes.
      return `cd "${wt}" && gemini -y --skip-trust --include-directories "${dir},${inputDir}"${seat.model ? ` -m ${seat.model}` : ""} -p "Follow the review brief on stdin exactly." < "${brief}"`;
    case "agy":
      // --print-timeout raised from agy's 5m default to fit the Bash tool's 10-min cap.
      return `cd "${wt}" && agy -p "$(cat "${brief}")" --add-dir "${dir}" --add-dir "${inputDir}" --dangerously-skip-permissions --print-timeout 9m30s${seat.model ? ` --model ${seat.model}` : ""}`;
  }
}

// -- injectable process/filesystem seams ---------------------------------------

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface ProviderDeps {
  run: (cmd: string[], stdin?: string) => RunResult;
  which: (bin: string) => string | null;
  env: Record<string, string | undefined>;
  home: string;
}

export function realDeps(): ProviderDeps {
  return {
    run: (cmd, stdin) => {
      try {
        const p = Bun.spawnSync(cmd, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
        return { ok: p.exitCode === 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
      } catch (e) {
        return { ok: false, stdout: "", stderr: (e as Error).message };
      }
    },
    which: (bin) => Bun.which(bin),
    env: process.env,
    home: homedir(),
  };
}

// -- binary preflight ----------------------------------------------------------

const INSTALL_HINTS: Record<CliProvider, string> = {
  codex: "npm install -g @openai/codex",
  gemini: "npm install -g @google/gemini-cli",
  agy: "install Google Antigravity (ships the agy CLI): https://antigravity.google",
};

// Where a binary lands when its installer ran but this session's PATH predates
// it -- the stale-session case the error must name instead of "not found".
function knownInstallPaths(provider: CliProvider, deps: ProviderDeps): string[] {
  const local = deps.env["LOCALAPPDATA"];
  if (provider === "agy" && local) return [join(local, "agy", "bin", "agy.exe")];
  return [];
}

export interface BinaryCheck {
  ok: boolean;
  detail: string; // version on ok; the named fix on miss
}

export function checkBinary(provider: CliProvider, deps: ProviderDeps): BinaryCheck {
  const found = deps.which(provider);
  if (!found) {
    const installed = knownInstallPaths(provider, deps).find((p) => existsSync(p));
    if (installed) {
      return {
        ok: false,
        detail: `installed at ${installed} but not on this session's PATH -- restart the terminal/session so the PATH update lands, then re-run`,
      };
    }
    return {
      ok: false,
      detail: `not found on PATH. Install: ${INSTALL_HINTS[provider]}. If you installed it during this session, restart the terminal/session so the PATH change lands`,
    };
  }
  const v = deps.run([provider, "--version"]);
  if (!v.ok) {
    return { ok: false, detail: `found at ${found} but \`${provider} --version\` failed: ${v.stderr.trim() || v.stdout.trim() || "non-zero exit"}` };
  }
  return { ok: true, detail: (v.stdout.trim() || v.stderr.trim()).split(/\r?\n/)[0] };
}

// Fail-fast for prepare: every distinct requested CLI must pass the same
// binary check setup uses, BEFORE any worktree or prompt write.
export function preflightProviders(providers: CliProvider[], deps: ProviderDeps = realDeps()): void {
  for (const p of providers) {
    const b = checkBinary(p, deps);
    if (!b.ok) {
      throw new ZError(`Skeptic provider "${p}" failed preflight: ${b.detail}.`);
    }
  }
}

// -- codex trust (the one persisted, opt-in artifact) --------------------------

export function codexConfigPath(deps: ProviderDeps): string {
  return join(deps.home, ".codex", "config.toml");
}

// codex on Windows records project paths as TOML basic strings with escaped
// backslashes; a hand-edited config may carry the literal-string form instead.
// Both are accepted; only the basic-string form is ever written.
export function codexTrustHeader(repoRoot: string): string {
  return `[projects."${repoRoot.replace(/\\/g, "\\\\")}"]`;
}

export function hasCodexTrust(configText: string, repoRoot: string): boolean {
  const headers = [codexTrustHeader(repoRoot), `[projects.'${repoRoot}']`];
  const lines = configText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!headers.includes(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length && !lines[j].trim().startsWith("["); j++) {
      if (/^trust_level\s*=\s*"trusted"$/.test(lines[j].trim())) return true;
    }
  }
  return false;
}

// Idempotent append-only write: an existing entry is left alone, and a config
// that cannot be READ (permissions, encoding) is never touched -- only a
// cleanly absent file is created.
export function writeCodexTrust(configPath: string, repoRoot: string): "written" | "already-trusted" {
  let text = "";
  if (existsSync(configPath)) {
    try {
      text = readFileSync(configPath, "utf8");
    } catch (e) {
      throw new ZError(`Cannot read ${configPath} (${(e as Error).message}); refusing to modify a config I cannot parse.`);
    }
    if (hasCodexTrust(text, repoRoot)) return "already-trusted";
  }
  const entry = `${codexTrustHeader(repoRoot)}\ntrust_level = "trusted"\n`;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  if (existsSync(configPath)) {
    appendFileSync(configPath, `${sep}\n${entry}`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, entry);
  }
  return "written";
}

// -- setup verb ----------------------------------------------------------------

export interface SetupRow {
  provider: CliProvider;
  binary: string;
  auth: string;
  trust: string;
  probe?: string;
  green: boolean;
}

export interface SetupReport {
  rows: SetupRow[];
  ok: boolean; // all-green -> exit 0
  actions: string[]; // exactly what --trust changed, if anything
}

function checkAuth(provider: CliProvider, deps: ProviderDeps): { ok: boolean; detail: string } {
  if (provider === "codex") {
    const r = deps.run(["codex", "login", "status"]);
    return r.ok ? { ok: true, detail: "ok" } : { ok: false, detail: "not logged in -- run: codex login" };
  }
  if (provider === "agy") {
    const r = deps.run(["agy", "models"]);
    return r.ok ? { ok: true, detail: "ok" } : { ok: false, detail: "not authed -- run agy once interactively to sign in" };
  }
  // gemini has no status subcommand; the credentials artifact under ~/.gemini
  // (or an explicit API key in the environment) is the deterministic signal.
  const geminiDir = join(deps.home, ".gemini");
  const artifacts = ["oauth_creds.json", "google_accounts.json"].map((f) => join(geminiDir, f));
  if (artifacts.some((p) => existsSync(p)) || deps.env["GEMINI_API_KEY"]) return { ok: true, detail: "ok" };
  return { ok: false, detail: `no credentials under ${geminiDir} -- run gemini once interactively to sign in` };
}

export function setupCheck(
  opts: { repo: string; trust: boolean; probe: boolean },
  deps: ProviderDeps = realDeps()
): SetupReport {
  const repoRoot = resolve(opts.repo);
  const actions: string[] = [];
  const rows: SetupRow[] = [];

  for (const provider of CLI_PROVIDERS) {
    const bin = checkBinary(provider, deps);
    const row: SetupRow = {
      provider,
      binary: bin.ok ? `ok ${bin.detail}` : `MISSING -- ${bin.detail}`,
      auth: "-",
      trust: "-",
      green: false,
    };
    if (bin.ok) {
      const auth = checkAuth(provider, deps);
      row.auth = auth.ok ? "ok" : `MISSING -- ${auth.detail}`;
      if (provider === "codex") {
        const cfg = codexConfigPath(deps);
        let trusted = existsSync(cfg) && hasCodexTrust(readFileSync(cfg, "utf8"), repoRoot);
        if (!trusted && opts.trust) {
          const wrote = writeCodexTrust(cfg, repoRoot);
          if (wrote === "written") actions.push(`wrote ${codexTrustHeader(repoRoot)} trust_level = "trusted" to ${cfg}`);
          trusted = true;
        }
        row.trust = trusted ? "trusted" : `missing -- run: setup --trust (writes ${cfg})`;
      } else {
        // gemini passes --skip-trust, agy passes --dangerously-skip-permissions:
        // per-run bypass, nothing persisted, nothing to set up.
        row.trust = "bypassed-per-run";
      }
      row.green = auth.ok && !row.trust.startsWith("missing");
      if (opts.probe && row.green) {
        const probeCmd: Record<CliProvider, { cmd: string[]; stdin?: string }> = {
          codex: { cmd: ["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "-"], stdin: "Reply with exactly OK" },
          gemini: { cmd: ["gemini", "-p", "Reply with exactly OK"] },
          agy: { cmd: ["agy", "-p", "Reply with exactly OK"] },
        };
        const { cmd, stdin } = probeCmd[provider];
        const r = deps.run(cmd, stdin);
        const answered = r.ok && /\bOK\b/.test(r.stdout);
        row.probe = answered ? "ok" : `FAILED -- ${r.stderr.trim().split(/\r?\n/)[0] || r.stdout.trim().split(/\r?\n/)[0] || "no output"}`;
        row.green = row.green && answered;
      }
    }
    rows.push(row);
  }
  return { rows, ok: rows.every((r) => r.green), actions };
}

export function renderSetupTable(report: SetupReport): string {
  const cols: (keyof SetupRow)[] = report.rows.some((r) => r.probe !== undefined)
    ? ["provider", "binary", "auth", "trust", "probe"]
    : ["provider", "binary", "auth", "trust"];
  const cell = (r: SetupRow, c: keyof SetupRow) => String(r[c] ?? "-");
  const widths = cols.map((c) => Math.max(String(c).length, ...report.rows.map((r) => cell(r, c).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(cols.map(String)), ...report.rows.map((r) => line(cols.map((c) => cell(r, c))))];
  for (const a of report.actions) out.push(`\n${a}`);
  out.push(report.ok ? "\nall green" : "\nNOT green -- fix the MISSING/FAILED rows above before a review depends on them");
  return out.join("\n");
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `models <command> [args]

  setup [--repo <dir>] [--trust] [--probe]
      Validate the cross-provider skeptic fleet (codex, gemini, agy): binary on
      PATH + --version, auth, and folder trust. Prints one row per provider;
      exit 0 all-green, else 1 (scriptable).
      --trust  write the codex config.toml trust entry for the repo root
               (idempotent; prints exactly what it changed)
      --probe  opt-in live micro-call per CLI ("Reply with exactly OK") --
               the only paid check; end-to-end auth proof`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1), ["trust", "probe"]);
    if (cmd === "setup") {
      const report = setupCheck({
        repo: str(flags, "repo") ?? ".",
        trust: flags["trust"] === true,
        probe: flags["probe"] === true,
      });
      console.log(renderSetupTable(report));
      return report.ok ? 0 : 1;
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

// Cross-provider seats: the codex and agy (Antigravity) CLI adapters, the
// preflight that fail-fasts before any work is done, the `setup` verb, and the
// per-user provider preference.
//
// Adapted from z-adversarial-review/lib/models.ts. The adapters and the setup
// checks are the same shape -- a CLI login is a per-machine fact and does not
// change between skills -- but the seat model differs: this skill has two
// distinct jobs for an outside CLI (independent DISCOVERY over the whole bundle,
// and adversarial REFUTATION of one finding), where the sibling has one.
//
// The contract downstream is provider-neutral: any process that writes a
// well-addressed findings.json or verdict.json counts. This file's only job is
// getting the right process launched, with the command composed HERE, in code,
// and rendered verbatim into the orchestrating prompt -- never improvised.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { handleCliError, parseFlags, readJsonFile, str, ZError } from "./cli.ts";

export const CLI_PROVIDERS = ["codex", "agy"] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];
const PROVIDER_ALIASES: Record<string, CliProvider> = { antigravity: "agy" };

// What an outside CLI is being asked to do. Both jobs are available to both
// providers; the difference is only which brief the seat is handed.
export const CLI_ROLES = ["discover", "refute"] as const;
export type CliRole = (typeof CLI_ROLES)[number];

export interface CliSeat {
  provider: CliProvider;
  model?: string;
}

// A model suffix is spliced into a shell command; the charset is the injection
// boundary, not a vendor catalog (an unknown-but-well-formed model is the
// provider's own error to raise).
const CLI_MODEL_RE = /^[A-Za-z0-9._/-]+$/;

export const TOKEN_GRAMMAR = "codex[:<model>] | agy[:<model>] (alias antigravity)";

export function parseSeatToken(token: string): CliSeat {
  const colon = token.indexOf(":");
  const head = colon === -1 ? token : token.slice(0, colon);
  const provider = (CLI_PROVIDERS as readonly string[]).includes(head)
    ? (head as CliProvider)
    : PROVIDER_ALIASES[head.toLowerCase()];
  if (!provider) {
    throw new ZError(`Unknown provider token ${JSON.stringify(token)}. Allowed: ${TOKEN_GRAMMAR}.`);
  }
  if (colon === -1) return { provider };
  const model = token.slice(colon + 1);
  if (model === "" || !CLI_MODEL_RE.test(model)) {
    throw new ZError(
      `Token ${JSON.stringify(token)}: the model suffix after ":" must be non-empty and match ${CLI_MODEL_RE} (it is spliced into a shell command).`
    );
  }
  return { provider, model };
}

export function seatToken(seat: CliSeat): string {
  return seat.model ? `${seat.provider}:${seat.model}` : seat.provider;
}

export function parseSeatTokens(tokens: string[]): CliSeat[] {
  const seats = tokens.map(parseSeatToken);
  const seen = new Set<string>();
  return seats.filter((s) => {
    const k = seatToken(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function providersIn(seats: CliSeat[]): CliProvider[] {
  return [...new Set(seats.map((s) => s.provider))];
}

// -- CLI adapters --------------------------------------------------------------------

// Forward slashes on purpose: the composed command runs under the orchestrator's
// Bash tool (Git Bash on Windows), where a backslash path gets eaten. Windows
// APIs accept D:/x/y just as well.
function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}

// codex rejects an oversized prompt server-side before the model reads a word:
// `input_error_code: input_too_large, max_chars: 1048576`. It is the only
// published cap of the two, and agy's is unknown, so the same ceiling stands for
// both -- a brief past it is beyond what either vendor handles anyway. A seat
// whose brief exceeds this is SPLIT, never truncated and never silently skipped.
export const CLI_BRIEF_CAP = 1_048_576;

// agy's headless text mode takes the prompt as an argv value, and Windows caps a
// whole command line at 32,767 characters, so an inlined brief of any real size
// dies with "Argument list too long" (exit 126) before agy starts. Above this
// budget -- the argv limit less room for the rest of the command -- the brief
// goes in on stdin instead. Below it, the historical command is unchanged.
export const CLI_ARGV_BUDGET = 24_000;

// agy's stdin mode reads NDJSON, one message per line, and needs no prompt on
// the command line. This is the exact envelope it accepts; any other `event`
// value is warned about and ignored, which would look like a silent seat.
export function ndjsonBrief(text: string): string {
  return `${JSON.stringify({ event: "user", message: { role: "user", content: text } })}\n`;
}

// One exact command per provider. cwd is the throwaway BUNDLE directory, which
// is the whole point: a CLI seat scoped there can read the documents under
// review and nothing else in the repo.
//
// The brief is a FILE in every form, so no seat is ever asked to go find its own
// material and decide how much of it to read -- a codex seat handed that choice
// read 400 of 14,440 lines and reported a clean bill of health. Both providers
// are granted their own output directory explicitly; agy additionally needs a
// read grant, because it sandboxes reads to its granted directories while
// codex's workspace-write sandbox restricts only writes.
// Ask before composing, where a caller has somewhere better to go than a throw.
// A refute brief cannot be split -- a refuter that saw half a finding is judging
// a different finding -- so its caller drops that one seat and records it,
// rather than aborting a merge that has already cost every discovery seat.
export function briefFits(briefChars: number): boolean {
  return briefChars <= CLI_BRIEF_CAP;
}

export function cliCommand(seat: CliSeat, bundleDir: string, outDir: string, briefChars: number): string {
  const cwd = shPath(bundleDir);
  const out = shPath(outDir);
  const brief = `${out}/brief.txt`;
  if (!briefFits(briefChars)) {
    throw new ZError(
      `Brief for seat "${seatToken(seat)}" is ${briefChars} chars, over the ${CLI_BRIEF_CAP}-char provider input cap. ` +
        `Split it before composing the command, or narrow the document patterns for this review.`
    );
  }
  switch (seat.provider) {
    case "codex":
      return `codex exec -s workspace-write --cd "${cwd}" -c 'sandbox_workspace_write.writable_roots=["${out}"]'${seat.model ? ` -m ${seat.model}` : ""} --skip-git-repo-check - < "${brief}"`;
    case "agy":
      // --print-timeout raised from agy's 5m default to fit the Bash tool's 10-minute cap.
      if (briefChars <= CLI_ARGV_BUDGET) {
        return `cd "${cwd}" && agy -p "$(cat "${brief}")" --add-dir "${out}" --dangerously-skip-permissions --print-timeout 9m30s${seat.model ? ` --model ${seat.model}` : ""}`;
      }
      return `cd "${cwd}" && agy --input-format stream-json --output-format stream-json --add-dir "${out}" --dangerously-skip-permissions --print-timeout 9m30s${seat.model ? ` --model ${seat.model}` : ""} < "${out}/brief.ndjson"`;
  }
}

export function briefPath(outDir: string): string {
  return join(outDir, "brief.txt");
}

export function ndjsonBriefPath(outDir: string): string {
  return join(outDir, "brief.ndjson");
}

// -- injectable process/filesystem seams -----------------------------------------------

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
        const p = Bun.spawnSync(cmd, {
          stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
          stdout: "pipe",
          stderr: "pipe",
        });
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

// -- binary preflight ---------------------------------------------------------------------

const INSTALL_HINTS: Record<CliProvider, string> = {
  codex: "npm install -g @openai/codex",
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
    return {
      ok: false,
      detail: `found at ${found} but \`${provider} --version\` failed: ${v.stderr.trim() || v.stdout.trim() || "non-zero exit"}`,
    };
  }
  return { ok: true, detail: (v.stdout.trim() || v.stderr.trim()).split(/\r?\n/)[0] };
}

// Fail-fast: every requested CLI must pass the same check `setup` uses, BEFORE
// any bundle directory or brief is written. Half a review is worse than none.
export function preflightProviders(providers: CliProvider[], deps: ProviderDeps = realDeps()): void {
  for (const p of providers) {
    const b = checkBinary(p, deps);
    if (!b.ok) throw new ZError(`Provider "${p}" failed preflight: ${b.detail}.`);
  }
}

// -- codex trust (the one persisted, opt-in artifact) ----------------------------------------

export function codexConfigPath(deps: ProviderDeps): string {
  return join(deps.home, ".codex", "config.toml");
}

// codex on Windows records project paths as TOML basic strings with escaped
// backslashes; a hand-edited config may carry the literal-string form instead.
// Both are accepted; only the basic-string form is ever written.
export function codexTrustHeader(root: string): string {
  return `[projects."${root.replace(/\\/g, "\\\\")}"]`;
}

export function hasCodexTrust(configText: string, root: string): boolean {
  const headers = [codexTrustHeader(root), `[projects.'${root}']`];
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
// that cannot be READ is never touched -- only a cleanly absent file is created.
export function writeCodexTrust(configPath: string, root: string): "written" | "already-trusted" {
  let text = "";
  if (existsSync(configPath)) {
    try {
      text = readFileSync(configPath, "utf8");
    } catch (e) {
      throw new ZError(`Cannot read ${configPath} (${(e as Error).message}); refusing to modify a config I cannot parse.`);
    }
    if (hasCodexTrust(text, root)) return "already-trusted";
  }
  const entry = `${codexTrustHeader(root)}\ntrust_level = "trusted"\n`;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  if (existsSync(configPath)) {
    appendFileSync(configPath, `${sep}\n${entry}`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, entry);
  }
  return "written";
}

// -- setup verb -------------------------------------------------------------------------------

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
  ok: boolean;
  actions: string[];
}

function checkAuth(provider: CliProvider, deps: ProviderDeps): { ok: boolean; detail: string } {
  if (provider === "codex") {
    const r = deps.run(["codex", "login", "status"]);
    return r.ok ? { ok: true, detail: "ok" } : { ok: false, detail: "not logged in -- run: codex login" };
  }
  const r = deps.run(["agy", "models"]);
  return r.ok ? { ok: true, detail: "ok" } : { ok: false, detail: "not authed -- run agy once interactively to sign in" };
}

export function setupCheck(
  opts: { repo: string; trust: boolean; probe: boolean; providers?: CliProvider[] },
  deps: ProviderDeps = realDeps()
): SetupReport {
  const repoRoot = resolve(opts.repo);
  const actions: string[] = [];
  const rows: SetupRow[] = [];

  for (const provider of opts.providers ?? CLI_PROVIDERS) {
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
        // agy passes --dangerously-skip-permissions: a per-run bypass, nothing
        // persisted, nothing to set up.
        row.trust = "bypassed-per-run";
      }
      row.green = auth.ok && !row.trust.startsWith("missing");
      if (opts.probe && row.green) {
        const probeCmd: Record<CliProvider, { cmd: string[]; stdin?: string }> = {
          codex: { cmd: ["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "-"], stdin: "Reply with exactly OK" },
          agy: { cmd: ["agy", "-p", "Reply with exactly OK"] },
        };
        const { cmd, stdin } = probeCmd[provider];
        const r = deps.run(cmd, stdin);
        const answered = r.ok && /\bOK\b/.test(r.stdout);
        row.probe = answered
          ? "ok"
          : `FAILED -- ${r.stderr.trim().split(/\r?\n/)[0] || r.stdout.trim().split(/\r?\n/)[0] || "no output"}`;
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

// -- provider preference (first-run persisted choice) ---------------------------------------------

// Global to the user: a CLI login is a per-machine fact, not a per-repo one.
// Deliberately NOT under the skill directory, which may just be a dev checkout.
export function preferencePath(deps: ProviderDeps): string {
  return join(deps.home, ".claude", "zg-doc-integrity", "provider-preference.json");
}

// Where the SIBLING skill keeps the same choice. Read-only, and only when this
// skill has no preference of its own: a user who already answered "which CLIs"
// for z-adversarial-review should not be asked again. Its absence is the normal
// case and never an error -- this skill does not depend on that one.
export function siblingPreferencePath(deps: ProviderDeps): string {
  return join(deps.home, ".claude", "z-adversarial-review", "skeptic-preference.json");
}

export interface ProviderPreference {
  providers: string[];
}

function readTokenFile(p: string, key: string): string[] | null {
  if (!existsSync(p)) return null;
  try {
    const raw = readJsonFile(p);
    const list = raw?.[key];
    if (!Array.isArray(list) || list.some((t: unknown) => typeof t !== "string")) return null;
    return list;
  } catch {
    return null;
  }
}

export interface PreferenceLookup {
  exists: boolean;
  providers: string[];
  source: "own" | "sibling" | "none";
}

// An absent file, unreadable JSON, or the wrong shape all mean "not chosen yet"
// -- i.e. first run -- never a thrown error.
export function readProviderPreference(deps: ProviderDeps = realDeps()): PreferenceLookup {
  const own = readTokenFile(preferencePath(deps), "providers");
  if (own !== null) return { exists: true, providers: own, source: "own" };

  const sibling = readTokenFile(siblingPreferencePath(deps), "skepticModels");
  if (sibling !== null) {
    // The sibling's tokens include Claude model names, which mean nothing here;
    // keep only the CLI providers, and only if any survive.
    const cli = sibling.filter((t) => {
      try {
        parseSeatToken(t);
        return true;
      } catch {
        return false;
      }
    });
    if (cli.length > 0) return { exists: true, providers: cli, source: "sibling" };
  }
  return { exists: false, providers: [], source: "none" };
}

export function writeProviderPreference(tokens: string[], deps: ProviderDeps = realDeps()): void {
  tokens.forEach(parseSeatToken); // throws ZError naming the grammar on a bad token
  const p = preferencePath(deps);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ providers: tokens }, null, 2));
}

export function parseProvidersCsv(raw: string): CliProvider[] {
  const providers = raw.split(",").map((s) => s.trim()) as CliProvider[];
  for (const p of providers) {
    if (!(CLI_PROVIDERS as readonly string[]).includes(p)) {
      throw new ZError(`--providers: unknown provider ${JSON.stringify(p)}. Allowed: ${CLI_PROVIDERS.join(", ")}.`);
    }
  }
  return providers;
}

// -- CLI ---------------------------------------------------------------------------------------

const USAGE = `providers <command> [args]

  setup [--repo <dir>] [--trust] [--probe] [--providers <csv>]
      Validate the cross-provider fleet (codex, agy): binary on PATH +
      --version, auth, and folder trust. One row per provider; exit 0 all-green,
      else 1 (scriptable).
      --trust      write the codex config.toml trust entry for the repo root
                   (idempotent; prints exactly what it changed)
      --probe      opt-in live micro-call per CLI ("Reply with exactly OK") --
                   the only paid check
      --providers  comma-separated subset of codex,agy to check

  preference [--set '<json array of provider tokens>']
      No --set: prints {"exists": bool, "providers": [...], "source": ...}.
      source "sibling" means the choice was read from an existing
      z-adversarial-review preference rather than chosen here.
      --set: validates and persists the choice (grammar: ${TOKEN_GRAMMAR}).`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1), ["trust", "probe"]);
    if (cmd === "setup") {
      const providersRaw = str(flags, "providers");
      const report = setupCheck({
        repo: str(flags, "repo") ?? ".",
        trust: flags["trust"] === true,
        probe: flags["probe"] === true,
        providers: providersRaw !== undefined ? parseProvidersCsv(providersRaw) : undefined,
      });
      console.log(renderSetupTable(report));
      return report.ok ? 0 : 1;
    }
    if (cmd === "preference") {
      const setRaw = str(flags, "set");
      if (setRaw !== undefined) {
        let tokens: unknown;
        try {
          tokens = JSON.parse(setRaw);
        } catch (e) {
          throw new ZError(`--set must be a JSON array of provider tokens: ${(e as Error).message}`);
        }
        if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== "string")) {
          throw new ZError(`--set must be a JSON array of provider tokens (strings).`);
        }
        writeProviderPreference(tokens as string[]);
        console.log(JSON.stringify({ saved: true, providers: tokens }, null, 2));
        return 0;
      }
      console.log(JSON.stringify(readProviderPreference(), null, 2));
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

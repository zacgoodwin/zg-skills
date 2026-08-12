// Gate tests for lib/models.ts: the seat-token grammar, the gap-fill, the
// reviewer-seat rejection, the three CLI adapter commands, the preflight
// fail-fast, and the setup verb's statuses -- all offline via injected deps.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_MODELS,
  cliCommand,
  cliProvidersIn,
  codexTrustHeader,
  hasCodexTrust,
  parseReviewerSeat,
  parseSeatToken,
  preflightProviders,
  resolveSkepticSeats,
  seatToken,
  setupCheck,
  writeCodexTrust,
  type ProviderDeps,
  type Seat,
} from "../lib/models.ts";
import { ZError } from "../lib/cli.ts";

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "models-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

function fakeDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    run: () => ({ ok: true, stdout: "9.9.9", stderr: "" }),
    which: (bin) => `/fake/bin/${bin}`,
    env: {},
    home: join(scratch, "home-default"),
    ...overrides,
  };
}

// -- token grammar ------------------------------------------------------------

describe("parseSeatToken", () => {
  test("every agent token parses to an agent seat", () => {
    for (const m of AGENT_MODELS) {
      expect(parseSeatToken(m)).toEqual({ kind: "agent", model: m });
    }
  });

  test("bare and model-suffixed CLI tokens parse; antigravity aliases to agy", () => {
    expect(parseSeatToken("codex")).toEqual({ kind: "cli", provider: "codex" });
    expect(parseSeatToken("gemini:gemini-2.5-flash")).toEqual({
      kind: "cli",
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(parseSeatToken("antigravity:gemini-3-pro")).toEqual({
      kind: "cli",
      provider: "agy",
      model: "gemini-3-pro",
    });
  });

  test("an unknown token is a ZError naming the allowed set", () => {
    expect(() => parseSeatToken("gpt5")).toThrow(/Allowed: inherit \| haiku \| sonnet \| opus \| fable \| codex/);
  });

  test("a model suffix that could escape the shell command is rejected", () => {
    expect(() => parseSeatToken("codex:")).toThrow(ZError);
    expect(() => parseSeatToken('codex:o3"; rm -rf /')).toThrow(/spliced into a shell command/);
  });

  test("seatToken renders the canonical, alias-normalized token", () => {
    expect(seatToken(parseSeatToken("antigravity"))).toBe("agy");
    expect(seatToken(parseSeatToken("codex:o3"))).toBe("codex:o3");
    expect(seatToken(parseSeatToken("inherit"))).toBe("inherit");
  });
});

// -- gap-fill -----------------------------------------------------------------

describe("resolveSkepticSeats", () => {
  test("k=0: empty (and thus the absent flag) resolves all-inherit", () => {
    expect(resolveSkepticSeats([]).map(seatToken)).toEqual(["inherit", "inherit", "inherit"]);
  });

  test("k=1: specified token takes seat 1, the rest gap-fill with inherit", () => {
    expect(resolveSkepticSeats(["codex"]).map(seatToken)).toEqual(["codex", "inherit", "inherit"]);
  });

  test("k=2 and k=3 keep seat order", () => {
    expect(resolveSkepticSeats(["gemini", "haiku"]).map(seatToken)).toEqual(["gemini", "haiku", "inherit"]);
    expect(resolveSkepticSeats(["codex", "gemini", "agy"]).map(seatToken)).toEqual(["codex", "gemini", "agy"]);
  });

  test("more than 3 tokens is a named error", () => {
    expect(() => resolveSkepticSeats(["codex", "gemini", "agy", "haiku"])).toThrow(/at most 3 tokens/);
  });
});

// -- reviewer seat ------------------------------------------------------------

describe("parseReviewerSeat", () => {
  test("agent tokens pass through", () => {
    expect(parseReviewerSeat("inherit")).toBe("inherit");
    expect(parseReviewerSeat("fable")).toBe("fable");
  });

  test("a CLI token in the reviewer seat is rejected with the rule by name", () => {
    expect(() => parseReviewerSeat("codex")).toThrow(/reviewer seat runs on the Claude harness only/);
  });
});

// -- CLI adapter commands -----------------------------------------------------

describe("cliCommand", () => {
  const WT = "D:\\repo\\.worktrees\\review-pr-9";
  const DIR = "D:\\out\\runs\\r\\t9\\reviewer-1\\skeptic-1";
  const INPUT_PATH = "D:\\out\\input-pr-9.json";

  test("codex: workspace-write sandbox scoped to the worktree, verdict dir granted, brief on stdin", () => {
    const c = cliCommand({ kind: "cli", provider: "codex" }, WT, DIR, INPUT_PATH);
    expect(c).toBe(
      `codex exec -s workspace-write --cd "D:/repo/.worktrees/review-pr-9" -c 'sandbox_workspace_write.writable_roots=["D:/out/runs/r/t9/reviewer-1/skeptic-1"]' --skip-git-repo-check - < "D:/out/runs/r/t9/reviewer-1/skeptic-1/brief.txt"`
    );
    expect(cliCommand({ kind: "cli", provider: "codex", model: "o3" }, WT, DIR, INPUT_PATH)).toContain(" -m o3 ");
  });

  test("gemini: yolo + per-run trust bypass, verdict dir AND input dir included, brief on stdin, cwd = worktree", () => {
    const c = cliCommand({ kind: "cli", provider: "gemini" }, WT, DIR, INPUT_PATH);
    expect(c).toBe(
      `cd "D:/repo/.worktrees/review-pr-9" && gemini -y --skip-trust --include-directories "D:/out/runs/r/t9/reviewer-1/skeptic-1,D:/out" -p "Follow the review brief on stdin exactly." < "D:/out/runs/r/t9/reviewer-1/skeptic-1/brief.txt"`
    );
  });

  test("agy: brief as the -p argument, verdict AND input dirs added, permissions skipped per-run, print timeout under the Bash cap", () => {
    const c = cliCommand({ kind: "cli", provider: "agy", model: "gemini-3-pro" }, WT, DIR, INPUT_PATH);
    expect(c).toBe(
      `cd "D:/repo/.worktrees/review-pr-9" && agy -p "$(cat "D:/out/runs/r/t9/reviewer-1/skeptic-1/brief.txt")" --add-dir "D:/out/runs/r/t9/reviewer-1/skeptic-1" --add-dir "D:/out" --dangerously-skip-permissions --print-timeout 9m30s --model gemini-3-pro`
    );
  });
});

// -- preflight ----------------------------------------------------------------

describe("preflightProviders", () => {
  test("all binaries present and versioned: silence", () => {
    expect(() => preflightProviders(["codex", "gemini", "agy"], fakeDeps())).not.toThrow();
  });

  test("a missing binary names the CLI and the install fix", () => {
    const deps = fakeDeps({ which: () => null });
    expect(() => preflightProviders(["codex"], deps)).toThrow(/"codex" failed preflight: not found on PATH. Install: npm install -g @openai\/codex/);
  });

  test("an installed-but-not-on-PATH binary names the stale-session case", () => {
    const local = join(scratch, "localappdata");
    mkdirSync(join(local, "agy", "bin"), { recursive: true });
    writeFileSync(join(local, "agy", "bin", "agy.exe"), "");
    const deps = fakeDeps({ which: () => null, env: { LOCALAPPDATA: local } });
    expect(() => preflightProviders(["agy"], deps)).toThrow(/not on this session's PATH -- restart the terminal\/session/);
  });

  test("cliProvidersIn dedupes and ignores agent seats", () => {
    const seats: Seat[] = [
      { kind: "cli", provider: "codex", model: "o3" },
      { kind: "agent", model: "haiku" },
      { kind: "cli", provider: "codex" },
    ];
    expect(cliProvidersIn(seats)).toEqual(["codex"]);
  });
});

// -- codex trust --------------------------------------------------------------

describe("codex trust", () => {
  test("--trust write is idempotent and scan accepts both TOML string forms", () => {
    const cfg = join(scratch, "codex-config", "config.toml");
    mkdirSync(join(scratch, "codex-config"), { recursive: true });
    const repoRoot = resolve(join(scratch, "some-repo"));
    expect(writeCodexTrust(cfg, repoRoot)).toBe("written");
    expect(writeCodexTrust(cfg, repoRoot)).toBe("already-trusted");
    const text = readFileSync(cfg, "utf8");
    expect(text.split(codexTrustHeader(repoRoot)).length - 1).toBe(1); // exactly one entry
    expect(hasCodexTrust(text, repoRoot)).toBe(true);
    // Literal-string form (hand-edited config) is also recognized.
    expect(hasCodexTrust(`[projects.'${repoRoot}']\ntrust_level = "trusted"\n`, repoRoot)).toBe(true);
    // A different project's trust never vouches for this repo.
    expect(hasCodexTrust(text, join(scratch, "other-repo"))).toBe(false);
  });

  test("an existing config keeps its content; the entry is appended", () => {
    const cfg = join(scratch, "codex-config2", "config.toml");
    mkdirSync(join(scratch, "codex-config2"), { recursive: true });
    writeFileSync(cfg, 'model = "o3"\n');
    const repoRoot = resolve(join(scratch, "repo2"));
    expect(writeCodexTrust(cfg, repoRoot)).toBe("written");
    const text = readFileSync(cfg, "utf8");
    expect(text.startsWith('model = "o3"\n')).toBe(true);
    expect(hasCodexTrust(text, repoRoot)).toBe(true);
  });
});

// -- setup --------------------------------------------------------------------

describe("setupCheck", () => {
  const repo = ".";

  test("all installed + authed + trusted: every row green, exit-ok", () => {
    const home = join(scratch, "home-green");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `${codexTrustHeader(resolve(repo))}\ntrust_level = "trusted"\n`
    );
    const r = setupCheck({ repo, trust: false, probe: false }, fakeDeps({ home }));
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.provider)).toEqual(["codex", "gemini", "agy"]);
    expect(r.rows[0].trust).toBe("trusted");
    expect(r.rows[1].trust).toBe("bypassed-per-run");
    expect(r.rows[2].trust).toBe("bypassed-per-run");
  });

  test("missing binary: row named MISSING, not green, auth not attempted", () => {
    const r = setupCheck({ repo, trust: false, probe: false }, fakeDeps({ which: () => null }));
    expect(r.ok).toBe(false);
    for (const row of r.rows) {
      expect(row.binary).toContain("MISSING");
      expect(row.auth).toBe("-");
      expect(row.green).toBe(false);
    }
  });

  test("unauthed provider: binary ok, auth MISSING with the fix, not green", () => {
    const home = join(scratch, "home-unauthed"); // no ~/.gemini artifact
    mkdirSync(home, { recursive: true });
    const deps = fakeDeps({
      home,
      // versions succeed; codex login status and agy models fail
      run: (cmd) => (cmd[1] === "--version" ? { ok: true, stdout: "1.0.0", stderr: "" } : { ok: false, stdout: "", stderr: "unauthed" }),
    });
    const r = setupCheck({ repo, trust: false, probe: false }, deps);
    expect(r.ok).toBe(false);
    expect(r.rows[0].auth).toContain("codex login");
    expect(r.rows[1].auth).toContain("sign in");
    expect(r.rows[2].auth).toContain("sign in");
  });

  test("--trust writes the codex entry once and reports exactly what changed", () => {
    const home = join(scratch, "home-trust");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "google_accounts.json"), "{}");
    const deps = fakeDeps({ home });
    const first = setupCheck({ repo, trust: true, probe: false }, deps);
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]).toContain("trust_level");
    expect(first.rows[0].trust).toBe("trusted");
    const second = setupCheck({ repo, trust: true, probe: false }, deps);
    expect(second.actions).toHaveLength(0); // idempotent
    expect(second.rows[0].trust).toBe("trusted");
  });
});

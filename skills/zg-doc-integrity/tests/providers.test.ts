// Gate tests for lib/providers.ts -- all offline, via injected deps. The two
// things worth guarding hardest: the composed commands (they are spliced shell
// strings scoped to a sandbox) and the sibling-preference borrow (it must be a
// convenience that degrades to nothing, never a dependency).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ZError } from "../lib/cli.ts";
import {
  checkBinary,
  CLI_ARGV_BUDGET,
  CLI_BRIEF_CAP,
  cliCommand,
  codexTrustHeader,
  hasCodexTrust,
  ndjsonBrief,
  parseProvidersCsv,
  parseSeatToken,
  parseSeatTokens,
  preferencePath,
  preflightProviders,
  providersIn,
  readProviderPreference,
  renderSetupTable,
  seatToken,
  setupCheck,
  siblingPreferencePath,
  writeCodexTrust,
  writeProviderPreference,
  type ProviderDeps,
} from "../lib/providers.ts";

let scratch: string;
let seq = 0;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "prov-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

function homeDir(): string {
  const h = join(scratch, `home${seq++}`);
  mkdirSync(h, { recursive: true });
  return h;
}

function fakeDeps(over: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    run: () => ({ ok: true, stdout: "1.0.0", stderr: "" }),
    which: () => "/usr/bin/thing",
    env: {},
    home: homeDir(),
    ...over,
  };
}

describe("seat tokens", () => {
  test("bare providers and the antigravity alias", () => {
    expect(parseSeatToken("codex")).toEqual({ provider: "codex" });
    expect(parseSeatToken("agy")).toEqual({ provider: "agy" });
    expect(parseSeatToken("antigravity")).toEqual({ provider: "agy" });
    expect(parseSeatToken("Antigravity")).toEqual({ provider: "agy" });
  });

  test("a model suffix round-trips through the canonical token", () => {
    expect(seatToken(parseSeatToken("codex:o3-mini"))).toBe("codex:o3-mini");
    expect(seatToken(parseSeatToken("antigravity:gemini-3"))).toBe("agy:gemini-3");
  });

  test("an unknown provider names the grammar", () => {
    expect(() => parseSeatToken("gpt5")).toThrow(/Allowed: codex/);
  });

  test("a shell-unsafe model suffix is rejected, since it is spliced into a command", () => {
    for (const bad of ["codex:", 'codex:a"; rm -rf /', "codex:a b", "codex:$(x)", "agy:`x`"]) {
      expect(() => parseSeatToken(bad)).toThrow(ZError);
    }
  });

  test("duplicate seats collapse", () => {
    expect(parseSeatTokens(["codex", "codex", "agy"]).map(seatToken)).toEqual(["codex", "agy"]);
    // A model variant is a distinct seat, not a duplicate.
    expect(parseSeatTokens(["codex", "codex:o3"]).map(seatToken)).toEqual(["codex", "codex:o3"]);
  });

  test("providersIn dedupes to bare providers", () => {
    expect(providersIn(parseSeatTokens(["codex:o3", "codex", "agy"]))).toEqual(["codex", "agy"]);
  });
});

describe("cliCommand", () => {
  const bundle = "C:\\work\\bundle";
  const out = "C:\\work\\run\\seat-1";
  const SMALL = 1000;

  test("codex is sandboxed to write only its own output directory", () => {
    const cmd = cliCommand({ provider: "codex" }, bundle, out, SMALL);
    expect(cmd).toContain('--cd "C:/work/bundle"');
    expect(cmd).toContain('sandbox_workspace_write.writable_roots=["C:/work/run/seat-1"]');
    expect(cmd).toContain('< "C:/work/run/seat-1/brief.txt"');
    expect(cmd).toContain("-s workspace-write");
  });

  test("agy runs in the bundle directory with its output directory granted", () => {
    const cmd = cliCommand({ provider: "agy" }, bundle, out, SMALL);
    expect(cmd).toContain('cd "C:/work/bundle"');
    expect(cmd).toContain('--add-dir "C:/work/run/seat-1"');
    expect(cmd).toContain('$(cat "C:/work/run/seat-1/brief.txt")');
    expect(cmd).toContain("--print-timeout 9m30s");
  });

  test("no backslash survives into either command", () => {
    for (const provider of ["codex", "agy"] as const) {
      expect(cliCommand({ provider }, bundle, out, SMALL)).not.toContain("\\");
      expect(cliCommand({ provider }, bundle, out, CLI_ARGV_BUDGET + 1)).not.toContain("\\");
    }
  });

  test("a model is passed with the provider's own flag", () => {
    expect(cliCommand({ provider: "codex", model: "o3" }, bundle, out, SMALL)).toContain("-m o3");
    expect(cliCommand({ provider: "agy", model: "gemini-3" }, bundle, out, SMALL)).toContain("--model gemini-3");
    // Also on the stdin form, which is a separate string and has forgotten it before.
    expect(cliCommand({ provider: "agy", model: "gemini-3" }, bundle, out, CLI_ARGV_BUDGET + 1)).toContain("--model gemini-3");
  });

  test("the working directory is the bundle, never the repo", () => {
    // The blinding contract in one assertion: an outside CLI is launched inside
    // the copied documents and is never told where they came from.
    const cmd = cliCommand({ provider: "agy" }, "/tmp/run/bundle", "/tmp/run/seat-1", SMALL);
    expect(cmd).toContain('cd "/tmp/run/bundle"');
    expect(cmd).not.toContain("repo");
  });

  // The argv cap is the OS's, not agy's: Windows stops a command line at 32,767
  // characters, so an inlined brief of any real size died with "Argument list
  // too long" before agy started. Nothing in the composer noticed.
  test("agy inlines a small brief and switches to stdin above the argv budget", () => {
    const inline = cliCommand({ provider: "agy" }, bundle, out, CLI_ARGV_BUDGET);
    expect(inline).toContain('$(cat "C:/work/run/seat-1/brief.txt")');
    expect(inline).not.toContain("stream-json");

    const piped = cliCommand({ provider: "agy" }, bundle, out, CLI_ARGV_BUDGET + 1);
    expect(piped).not.toContain("$(cat");
    expect(piped).toContain("--input-format stream-json");
    expect(piped).toContain("--output-format stream-json");
    expect(piped).toContain('< "C:/work/run/seat-1/brief.ndjson"');
    // -p and stdin input are mutually exclusive; agy refuses the pair outright.
    expect(piped).not.toContain(" -p ");
    expect(piped.length).toBeLessThan(CLI_ARGV_BUDGET);
  });

  test("codex never needs the argv form, so its command does not change with size", () => {
    expect(cliCommand({ provider: "codex" }, bundle, out, SMALL)).toBe(
      cliCommand({ provider: "codex" }, bundle, out, CLI_ARGV_BUDGET + 1)
    );
  });

  test("a brief over the provider input cap is refused, naming the cap", () => {
    for (const provider of ["codex", "agy"] as const) {
      expect(() => cliCommand({ provider }, bundle, out, CLI_BRIEF_CAP + 1)).toThrow(ZError);
      expect(() => cliCommand({ provider }, bundle, out, CLI_BRIEF_CAP)).not.toThrow();
    }
    try {
      cliCommand({ provider: "codex" }, bundle, out, CLI_BRIEF_CAP + 1);
    } catch (e) {
      expect((e as Error).message).toContain(String(CLI_BRIEF_CAP));
    }
  });
});

describe("ndjsonBrief", () => {
  // agy warns and ignores any event value it does not know, which would look
  // exactly like a seat that ran and found nothing.
  test("is one line agy accepts, carrying the whole brief", () => {
    const line = ndjsonBrief('a brief with "quotes" and\nnewlines');
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      event: "user",
      message: { role: "user", content: 'a brief with "quotes" and\nnewlines' },
    });
  });
});

describe("checkBinary", () => {
  test("reports the version when present", () => {
    const c = checkBinary("codex", fakeDeps({ run: () => ({ ok: true, stdout: "codex 1.2.3\nextra", stderr: "" }) }));
    expect(c).toEqual({ ok: true, detail: "codex 1.2.3" });
  });

  test("a missing binary names the install command", () => {
    const c = checkBinary("codex", fakeDeps({ which: () => null }));
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/npm install -g @openai\/codex/);
  });

  test("an installed-but-not-on-PATH binary names the restart, not 'not found'", () => {
    const local = join(scratch, "local");
    mkdirSync(join(local, "agy", "bin"), { recursive: true });
    writeFileSync(join(local, "agy", "bin", "agy.exe"), "");
    const c = checkBinary("agy", fakeDeps({ which: () => null, env: { LOCALAPPDATA: local } }));
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/restart the terminal/);
    expect(c.detail).not.toMatch(/not found on PATH/);
  });

  test("a binary that fails --version is not ok", () => {
    const c = checkBinary("agy", fakeDeps({ run: () => ({ ok: false, stdout: "", stderr: "boom" }) }));
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/boom/);
  });
});

describe("preflightProviders", () => {
  test("passes when every provider checks out", () => {
    expect(() => preflightProviders(["codex", "agy"], fakeDeps())).not.toThrow();
  });

  test("fails fast and names the provider", () => {
    expect(() => preflightProviders(["codex"], fakeDeps({ which: () => null }))).toThrow(/Provider "codex" failed preflight/);
  });
});

describe("codex trust", () => {
  test("detects both the escaped and the literal TOML forms", () => {
    const root = "C:\\repo";
    expect(hasCodexTrust(`${codexTrustHeader(root)}\ntrust_level = "trusted"\n`, root)).toBe(true);
    expect(hasCodexTrust(`[projects.'C:\\repo']\ntrust_level = "trusted"\n`, root)).toBe(true);
  });

  test("a trust entry under a different project does not count", () => {
    expect(hasCodexTrust(`[projects."C:\\\\other"]\ntrust_level = "trusted"\n`, "C:\\repo")).toBe(false);
  });

  test("a header with no trust_level does not count", () => {
    expect(hasCodexTrust(`${codexTrustHeader("/repo")}\nother = 1\n`, "/repo")).toBe(false);
  });

  test("writing is idempotent and creates a missing config", () => {
    const cfg = join(scratch, `codex${seq++}`, "config.toml");
    expect(writeCodexTrust(cfg, "/repo")).toBe("written");
    expect(writeCodexTrust(cfg, "/repo")).toBe("already-trusted");
    expect(readFileSync(cfg, "utf8").match(/trust_level/g)).toHaveLength(1);
  });

  test("an existing config is appended to, not replaced", () => {
    const cfg = join(scratch, `codex${seq++}`, "config.toml");
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, "model = 'o3'\n");
    writeCodexTrust(cfg, "/repo");
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain("model = 'o3'");
    expect(text).toContain("trust_level");
  });
});

describe("setupCheck", () => {
  test("all green when binaries, auth and trust check out", () => {
    const deps = fakeDeps();
    writeCodexTrust(join(deps.home, ".codex", "config.toml"), process.cwd());
    const report = setupCheck({ repo: ".", trust: false, probe: false }, deps);
    expect(report.ok).toBe(true);
    expect(report.rows.map((r) => r.provider)).toEqual(["codex", "agy"]);
  });

  test("agy needs no persisted trust", () => {
    const report = setupCheck({ repo: ".", trust: false, probe: false, providers: ["agy"] }, fakeDeps());
    expect(report.rows[0].trust).toBe("bypassed-per-run");
    expect(report.ok).toBe(true);
  });

  test("missing codex trust is not green, and --trust fixes it and says what it did", () => {
    const deps = fakeDeps();
    const before = setupCheck({ repo: ".", trust: false, probe: false, providers: ["codex"] }, deps);
    expect(before.ok).toBe(false);
    expect(before.rows[0].trust).toMatch(/setup --trust/);

    const after = setupCheck({ repo: ".", trust: true, probe: false, providers: ["codex"] }, deps);
    expect(after.ok).toBe(true);
    expect(after.actions[0]).toMatch(/trust_level = "trusted"/);
  });

  test("failed auth is reported with its fix", () => {
    const deps = fakeDeps({
      run: (cmd) => (cmd[1] === "login" || cmd[1] === "models" ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: "1.0", stderr: "" }),
    });
    const report = setupCheck({ repo: ".", trust: true, probe: false }, deps);
    expect(report.ok).toBe(false);
    expect(report.rows.find((r) => r.provider === "codex")!.auth).toMatch(/codex login/);
    expect(report.rows.find((r) => r.provider === "agy")!.auth).toMatch(/interactively/);
  });

  test("the probe column appears only when asked, and a silent probe fails", () => {
    const deps = fakeDeps({
      run: (cmd) => (cmd.includes("exec") || cmd.includes("-p") ? { ok: true, stdout: "", stderr: "" } : { ok: true, stdout: "1.0", stderr: "" }),
    });
    const plain = setupCheck({ repo: ".", trust: true, probe: false }, deps);
    expect(plain.rows[0].probe).toBeUndefined();
    const probed = setupCheck({ repo: ".", trust: true, probe: true }, deps);
    expect(probed.rows[0].probe).toMatch(/FAILED/);
    expect(probed.ok).toBe(false);
  });

  test("the table renders every row and a verdict line", () => {
    const text = renderSetupTable(setupCheck({ repo: ".", trust: true, probe: false }, fakeDeps()));
    expect(text).toContain("provider");
    expect(text).toContain("codex");
    expect(text).toContain("agy");
    expect(text).toMatch(/all green/);
  });
});

describe("provider preference", () => {
  test("nothing chosen anywhere reads as first run", () => {
    expect(readProviderPreference(fakeDeps())).toEqual({ exists: false, providers: [], source: "none" });
  });

  test("a saved choice round-trips", () => {
    const deps = fakeDeps();
    writeProviderPreference(["codex", "agy"], deps);
    expect(readProviderPreference(deps)).toEqual({ exists: true, providers: ["codex", "agy"], source: "own" });
  });

  test("an invalid token is rejected before it is persisted", () => {
    const deps = fakeDeps();
    expect(() => writeProviderPreference(["nonsense"], deps)).toThrow(ZError);
    expect(readProviderPreference(deps).exists).toBe(false);
  });

  test("the sibling's choice is borrowed when this skill has none", () => {
    const deps = fakeDeps();
    const sib = siblingPreferencePath(deps);
    mkdirSync(dirname(sib), { recursive: true });
    // The sibling stores Claude model tokens alongside CLI ones; only the CLI
    // tokens mean anything here.
    writeFileSync(sib, JSON.stringify({ skepticModels: ["codex", "opus", "agy"] }));
    expect(readProviderPreference(deps)).toEqual({ exists: true, providers: ["codex", "agy"], source: "sibling" });
  });

  test("this skill's own choice wins over the sibling's", () => {
    const deps = fakeDeps();
    const sib = siblingPreferencePath(deps);
    mkdirSync(dirname(sib), { recursive: true });
    writeFileSync(sib, JSON.stringify({ skepticModels: ["codex", "agy"] }));
    writeProviderPreference([], deps);
    expect(readProviderPreference(deps)).toEqual({ exists: true, providers: [], source: "own" });
  });

  test("a sibling file with no CLI tokens is not a choice", () => {
    const deps = fakeDeps();
    const sib = siblingPreferencePath(deps);
    mkdirSync(dirname(sib), { recursive: true });
    writeFileSync(sib, JSON.stringify({ skepticModels: ["opus", "sonnet"] }));
    expect(readProviderPreference(deps).exists).toBe(false);
  });

  test("a corrupt file on either side degrades to first run rather than throwing", () => {
    const deps = fakeDeps();
    for (const p of [preferencePath(deps), siblingPreferencePath(deps)]) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "{ not json");
    }
    expect(readProviderPreference(deps).exists).toBe(false);
  });

  test("the preference lives outside the skill directory, under the user's home", () => {
    const deps = fakeDeps();
    expect(preferencePath(deps).startsWith(deps.home)).toBe(true);
  });
});

describe("parseProvidersCsv", () => {
  test("accepts a subset and rejects anything else by name", () => {
    expect(parseProvidersCsv("codex, agy")).toEqual(["codex", "agy"]);
    expect(() => parseProvidersCsv("codex,nope")).toThrow(/unknown provider "nope"/);
    // This selects table rows, not seats, so the alias is deliberately not expanded.
    expect(() => parseProvidersCsv("antigravity")).toThrow(ZError);
  });
});

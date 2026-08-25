// End-to-end tests for lib/run.ts: the whole loop driven with stubbed agent
// output, so every wire between the phases is exercised without a model.
//
// The agents are simulated by writing the files they would write. That is
// exactly the contract -- a seat's output IS its file -- so a stub is a faithful
// stand-in for everything except the judgment inside it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collect, continueRun, merge, prepare, verify, type PrepareManifest, type Spawn } from "../lib/run.ts";
import { VERDICT_SCHEMA_VERSION } from "../lib/verdict.ts";

let scratch: string;
let n = 0;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "run-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

const API_MD = `# API Guide

## Quickstart

Tokens expire after 24 hours.

## Details

Read the [auth notes](auth.md#tokens) for more.
`;

const AUTH_MD = `# Auth

## Tokens

Tokens are valid for 7 days.

See [the missing part](#nowhere) for details.
`;

function repo(docs: Record<string, string> = { "api.md": API_MD, "auth.md": AUTH_MD }): string {
  const dir = join(scratch, `repo${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  for (const [name, body] of Object.entries(docs)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function start(root: string, patterns = ["api.md", "auth.md"]): PrepareManifest {
  return prepare({ patterns, cwd: root, repoRoot: root, providerTokens: [], now: Date.parse("2026-03-04T05:06:07Z") + n });
}

// Write what a seat would have written.
function seatFindings(spawn: Spawn, findings: unknown[]): void {
  mkdirSync(dirname(spawn.outPath), { recursive: true });
  writeFileSync(spawn.outPath, JSON.stringify({ findings }));
}

function seatClaims(spawn: Spawn, claims: unknown[]): void {
  if (!spawn.claimsPath) return;
  mkdirSync(dirname(spawn.claimsPath), { recursive: true });
  writeFileSync(spawn.claimsPath, JSON.stringify({ claims }));
}

function refuterVerdict(spawn: Spawn, runId: string, round: number, result: string): void {
  mkdirSync(dirname(spawn.outPath), { recursive: true });
  writeFileSync(
    spawn.outPath,
    JSON.stringify({
      schema: VERDICT_SCHEMA_VERSION,
      runId,
      round,
      stage: "refute",
      attempt: 1,
      result,
      notes: "a reader following the first passage uses the wrong lifetime",
    })
  );
}

const TOKEN_FINDING = {
  kind: "contradiction",
  title: "Token lifetime disagrees",
  summary: "Two passages give different token lifetimes.",
  sides: [
    { label: "Site A", quote: "Tokens expire after 24 hours." },
    { label: "Site B", quote: "Tokens are valid for 7 days." },
  ],
  options: [
    { label: "align on 24 hours", edits: [{ quote: "Tokens are valid for 7 days.", replacement: "Tokens expire after 24 hours." }], consequence: "1 edit." },
    { label: "align on 7 days", edits: [{ quote: "Tokens expire after 24 hours.", replacement: "Tokens are valid for 7 days." }], consequence: "1 edit." },
  ],
};

function tick(md: string, id: string, label: string): string {
  const start = md.indexOf(`### ${id} `);
  if (start === -1) throw new Error(`no block ${id} in plan`);
  const next = md.indexOf("\n### ", start + 1);
  const end = next === -1 ? md.length : next;
  return md.slice(0, start) + md.slice(start, end).replace(new RegExp(`\\[ \\] ${label}\\b`), `[x] ${label}`) + md.slice(end);
}

function comment(md: string, id: string, text: string): string {
  const start = md.indexOf(`### ${id} `);
  const next = md.indexOf("\n### ", start + 1);
  const end = next === -1 ? md.length : next;
  return md.slice(0, start) + md.slice(start, end).replace(/\*\*Comment:\*\*\n/, `**Comment:**\n\n${text}\n`) + md.slice(end);
}

describe("prepare", () => {
  test("writes the bundle, the briefs, and a manifest of spawns", () => {
    const root = repo();
    const m = start(root);
    expect(m.documents.map((d) => d.id)).toEqual(["D1", "D2"]);
    expect(existsSync(join(m.bundleDir, "D1-api.md"))).toBe(true);
    expect(m.spawns.length).toBeGreaterThan(0);
    for (const s of m.spawns) expect(existsSync(s.briefPath)).toBe(true);
    expect(m.nextCommand).toMatch(/^merge /);
  });

  test("every Agent-tool spawn carries a stub, and the stub is a pointer not the brief", () => {
    // The orchestrator passes the stub. If it had to pass the brief's contents,
    // it would have to READ them -- and a brief holds the shard text, so the one
    // context that must stay blinded would be the one that saw everything.
    const m = start(repo());
    for (const s of m.spawns) {
      if (s.command) continue;
      expect(s.stub, s.seat).toBeDefined();
      expect(s.stub!).toContain(s.briefPath);
      expect(s.stub!.length).toBeLessThan(1200);
      // The fixture's own prose must not have leaked into the pointer.
      expect(s.stub!).not.toContain("Tokens expire after 24 hours");
    }
  });

  test("a CLI spawn is launched by its command and needs no stub", () => {
    const m = start(repo());
    for (const s of m.spawns) if (s.command) expect(s.stub).toBeUndefined();
  });

  test("the structure lens has already produced findings, with no agent", () => {
    // auth.md links to #nowhere, which no heading provides.
    expect(start(repo()).structureFindings).toBeGreaterThan(0);
  });

  test("the bundle directory holds the documents and nothing else", () => {
    const root = repo({ "api.md": API_MD, "secret/notes.md": "# Secret\n" });
    const m = prepare({ patterns: ["api.md"], cwd: root, repoRoot: root, providerTokens: [], now: Date.now() });
    expect(existsSync(join(m.bundleDir, "D1-api.md"))).toBe(true);
    expect(existsSync(join(m.bundleDir, "secret"))).toBe(false);
  });

  test("the state directory is gitignored on the first run", () => {
    const root = repo();
    start(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".doc-integrity/");
  });

  test("an unknown provider token fails before anything is written", () => {
    const root = repo();
    expect(() =>
      prepare({ patterns: ["api.md"], cwd: root, repoRoot: root, providerTokens: ["nonsense"], now: Date.now() })
    ).toThrow();
    expect(existsSync(join(root, ".doc-integrity"))).toBe(false);
  });
});

describe("the full loop", () => {
  function runToPlan(root: string, findings: unknown[] = [TOKEN_FINDING]) {
    const prepared = start(root);
    const shard = prepared.spawns.find((s) => s.kind === "shard")!;
    seatFindings(shard, findings);
    seatClaims(shard, [
      { subject: "token lifetime", assertion: "tokens last 24 hours", quote: "Tokens expire after 24 hours." },
    ]);
    for (const s of prepared.spawns.filter((s) => s.kind !== "shard")) seatFindings(s, []);

    // First merge dispatches the reduce pass, which has not run yet.
    const first = merge(prepared.runRoot);
    expect(first.reduceSpawn).not.toBeNull();
    seatFindings(first.reduceSpawn!, []);

    const second = merge(prepared.runRoot);
    expect(second.reduceSpawn).toBeNull();
    return { prepared, merged: second };
  }

  test("prepare, merge, refute, collect produces a plan citing every instance", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    expect(merged.findings).toBeGreaterThanOrEqual(1);
    expect(merged.refuteSpawns.length).toBeGreaterThan(0);

    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);
    const md = readFileSync(c.planMd, "utf8");
    expect(md).toContain("api.md:5");
    expect(md).toContain("auth.md:5");
    expect(md).toContain("**Resolution:**");
  });

  test("a finding upheld by every refuter scores higher than an unrefuted one", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);
    const plan = JSON.parse(readFileSync(c.planJson, "utf8"));
    const token = plan.findings.find((f: any) => f.title.includes("Token lifetime"));
    expect(token.confidence.outcome).toBe("all-upheld");
    expect(token.confidence.score).toBeGreaterThan(token.confidence.base);
  });

  test("a finding every refuter kills lands in the refuted appendix, not the main list", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "REFUTED");
    const c = collect(prepared.runRoot);
    expect(readFileSync(c.planMd, "utf8")).toContain("## Refuted");
    expect(c.counts.refuted).toBeGreaterThan(0);
  });

  test("an ungrounded finding never reaches the plan, and is listed as unverifiable", () => {
    const root = repo();
    const bogus = { ...TOKEN_FINDING, title: "Invented", sides: [{ label: "A", quote: "This sentence is nowhere in the documents." }] };
    const { prepared, merged } = runToPlan(root, [bogus]);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);
    const md = readFileSync(c.planMd, "utf8");
    // Absent from the actionable findings, present in the appendix: an
    // ungrounded claim is dropped from the plan but never hidden.
    const findingsSection = md.slice(md.indexOf("## Findings"), md.indexOf("## Unverifiable claims"));
    expect(findingsSection).not.toContain("Invented");
    expect(md).toContain("## Unverifiable claims");
    expect(md).toMatch(/\*\*Invented\*\* \(shard-1\) — quote not found/);
  });

  test("an untouched plan stops rather than editing anything", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    collect(prepared.runRoot);
    const c = continueRun(prepared.runRoot);
    expect(c.action).toBe("NOT-REVIEWED");
    expect(c.applySpawns).toEqual([]);
    expect(readFileSync(join(root, "api.md"), "utf8")).toBe(API_MD);
  });

  test("a completed plan applies, and verify confirms exactly the approved edit", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);

    let md = readFileSync(c.planMd, "utf8");
    const ids = [...md.matchAll(/^### (F-\d+) /gm)].map((m) => m[1]);
    for (const id of ids) md = tick(md, id, id === ids[0] ? "B" : "change nothing");
    writeFileSync(c.planMd, md);

    const cont = continueRun(prepared.runRoot);
    expect(cont.action).toBe("APPLY");
    expect(cont.applySpawns.length).toBeGreaterThan(0);

    // Stand in for the apply agent: make exactly the approved edit.
    const unit = JSON.parse(readFileSync(join(prepared.runRoot, "r1", "work-units.json"), "utf8"));
    for (const u of unit.units) {
      let text = readFileSync(u.absPath, "utf8");
      for (const e of u.edits) text = text.replace(e.site.quote, e.replacement ?? e.site.quote);
      writeFileSync(u.absPath, text);
    }
    const v = verify(prepared.runRoot);
    expect(v.ok).toBe(true);
    expect(v.files[0].blast).toEqual([]);
  });

  test("an apply agent that also tidies something else fails verification with a restore hint", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);
    let md = readFileSync(c.planMd, "utf8");
    const ids = [...md.matchAll(/^### (F-\d+) /gm)].map((m) => m[1]);
    for (const id of ids) md = tick(md, id, id === ids[0] ? "B" : "change nothing");
    writeFileSync(c.planMd, md);
    continueRun(prepared.runRoot);

    const unit = JSON.parse(readFileSync(join(prepared.runRoot, "r1", "work-units.json"), "utf8"));
    for (const u of unit.units) {
      let text = readFileSync(u.absPath, "utf8");
      for (const e of u.edits) text = text.replace(e.site.quote, e.replacement ?? e.site.quote);
      writeFileSync(u.absPath, `${text}\nAn unrequested improvement.\n`);
    }
    const v = verify(prepared.runRoot);
    expect(v.ok).toBe(false);
    expect(v.files.some((f) => f.blast.length > 0)).toBe(true);
    expect(v.restoreHints.length).toBeGreaterThan(0);
  });

  test("a comment opens a new round with a targeted brief and no edits", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);

    let md = readFileSync(c.planMd, "utf8");
    const ids = [...md.matchAll(/^### (F-\d+) /gm)].map((m) => m[1]);
    for (const id of ids) md = tick(md, id, "change nothing");
    md = comment(md, ids[0], "these two are scoped to different environments");
    writeFileSync(c.planMd, md);

    const cont = continueRun(prepared.runRoot);
    expect(cont.action).toBe("REGENERATE");
    expect(cont.round).toBe(1);
    expect(cont.regenSpawns).toHaveLength(1);
    expect(readFileSync(cont.regenSpawns[0].briefPath, "utf8")).toContain("scoped to different environments");
    // Nothing was written to the documents.
    expect(readFileSync(join(root, "api.md"), "utf8")).toBe(API_MD);
  });

  test("a 'change nothing' in one round suppresses the same finding in the next", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);

    let md = readFileSync(c.planMd, "utf8");
    const ids = [...md.matchAll(/^### (F-\d+) /gm)].map((m) => m[1]);
    for (const id of ids) md = tick(md, id, "change nothing");
    md += "\nAlso: stop flagging anchors entirely.\n"; // a global comment forces a round 2
    writeFileSync(c.planMd, md);
    continueRun(prepared.runRoot);

    const declined = JSON.parse(readFileSync(join(prepared.runRoot, "decisions.json"), "utf8"));
    expect(declined.declined.length).toBe(ids.length);

    // Round 2: the same discovery output must now produce nothing.
    const r2 = join(prepared.runRoot, "r2", "discover", "seat");
    mkdirSync(r2, { recursive: true });
    writeFileSync(join(r2, "findings.json"), JSON.stringify({ findings: [TOKEN_FINDING] }));
    const m2 = merge(prepared.runRoot);
    expect(m2.findings).toBe(0);
  });

  test("the round cap stops the loop instead of spinning", () => {
    const root = repo();
    const { prepared, merged } = runToPlan(root);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);

    // Fast-forward the run to the cap.
    const statePath = join(prepared.runRoot, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, round: 5 }));
    mkdirSync(join(prepared.runRoot, "r5"), { recursive: true });
    writeFileSync(join(prepared.runRoot, "r5", "plan.json"), readFileSync(c.planJson, "utf8"));
    let md = readFileSync(c.planMd, "utf8");
    const ids = [...md.matchAll(/^### (F-\d+) /gm)].map((m) => m[1]);
    for (const id of ids) md = tick(md, id, "change nothing");
    md = comment(md, ids[0], "still not right");
    writeFileSync(join(prepared.runRoot, "r5", "plan.md"), md);

    const cont = continueRun(prepared.runRoot);
    expect(cont.action).toBe("BLOCKED");
    expect(cont.reasons[0]).toMatch(/cap/);
  });

  test("two findings fighting over one line block apply rather than racing", () => {
    const root = repo();
    const twin = { ...TOKEN_FINDING, title: "Same line, other finding" };
    const { prepared, merged } = runToPlan(root, [TOKEN_FINDING]);
    for (const s of merged.refuteSpawns) refuterVerdict(s, prepared.runId, 1, "UPHELD");
    const c = collect(prepared.runRoot);

    // Inject a second finding that edits the same site, as a regeneration might.
    const plan = JSON.parse(readFileSync(c.planJson, "utf8"));
    const first = plan.findings.find((f: any) => f.title.includes("Token lifetime"));
    plan.findings.push({ ...first, id: "F-99", fingerprint: "fp-twin", title: twin.title });
    writeFileSync(c.planJson, JSON.stringify(plan));

    let md = readFileSync(c.planMd, "utf8");
    const ids = [...md.matchAll(/^### (F-\d+) /gm)].map((m) => m[1]);
    for (const id of ids) md = tick(md, id, id === first.id ? "B" : "change nothing");
    // Render the injected block by hand, ticked the same way.
    md = md.replace("## Comments", `### F-99 · contradiction · high · confidence 95/100\n\n**Resolution:** [x] B  ·  [ ] change nothing  ·  [ ] comment\n\n**Comment:**\n\n## Comments`);
    writeFileSync(c.planMd, md);

    const cont = continueRun(prepared.runRoot);
    expect(cont.action).toBe("BLOCKED");
    expect(cont.conflicts[0]).toMatch(/edited by/);
  });
});

describe("caps are stated, never silent", () => {
  test("a seat that wrote nothing is named, not quietly counted as clean", () => {
    const root = repo();
    const prepared = start(root);
    // No seat answers at all -- the difference between "found nothing" and
    // "never reported" has to survive into the manifest.
    const m = merge(prepared.runRoot);
    expect(m.seatsSilent).toContain("shard-1");
    expect(m.skipped.some((s) => s.includes("wrote nothing"))).toBe(true);
  });

  test("a cap reported during merge reaches the PLAN, not just the manifest", () => {
    // The first eval run exposed this: merge said one finding skipped
    // refutation, and the plan the human reads said nothing at all. A cap
    // reported once to the orchestrator and then dropped is exactly the silent
    // truncation this design forbids.
    const root = repo();
    const prepared = start(root);
    const shard = prepared.spawns.find((s) => s.kind === "shard")!;
    seatFindings(shard, []);
    seatClaims(shard, []);
    const m = merge(prepared.runRoot);
    expect(m.skipped.length).toBeGreaterThan(0);

    const c = collect(prepared.runRoot);
    expect(c.skipped).toEqual(expect.arrayContaining(m.skipped));
    const md = readFileSync(c.planMd, "utf8");
    expect(md).toContain("What this run did not do");
    for (const s of m.skipped) expect(md).toContain(s);
  });

  test("caps from prepare and from merge both survive into the plan", () => {
    const root = repo();
    const prepared = start(root);
    // Structure produced a finding, so merge will report the refutation skip.
    const shard = prepared.spawns.find((s) => s.kind === "shard")!;
    seatFindings(shard, []);
    seatClaims(shard, []);
    merge(prepared.runRoot);
    const again = merge(prepared.runRoot);
    const c = collect(prepared.runRoot);
    // Recorded once each, never duplicated by re-running a phase.
    for (const note of again.skipped) {
      expect(c.skipped.filter((s) => s === note)).toHaveLength(1);
    }
  });

  test("a seat that answered with an empty list is not silent", () => {
    const root = repo();
    const prepared = start(root);
    const shard = prepared.spawns.find((s) => s.kind === "shard")!;
    seatFindings(shard, []);
    const m = merge(prepared.runRoot);
    expect(m.seatsHeardFrom).toContain("shard-1");
    expect(m.seatsSilent).not.toContain("shard-1");
  });
});

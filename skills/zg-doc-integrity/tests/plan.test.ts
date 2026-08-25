// Gate tests for lib/plan.ts -- the human gate.
//
// The parser is the only place a human's intent becomes an edit, so every way
// of expressing "no" or "not yet" must reach a non-editing outcome, and every
// ambiguity must block rather than guess. The round-trip test (render, edit as
// a human would, parse) is the one that catches format drift between the two
// halves.
import { describe, expect, test } from "bun:test";
import {
  declinedFingerprints,
  emptyDecisions,
  parsePlan,
  planStatus,
  PLAN_SCHEMA_VERSION,
  recordDecisions,
  renderPlan,
  type PlanFile,
} from "../lib/plan.ts";
import { type Finding } from "../lib/findings.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-01",
    kind: "contradiction",
    title: "Token lifetime disagrees",
    summary: "Two passages state different token lifetimes.",
    sides: [
      {
        label: "Site A",
        quote: "Tokens expire after 24 hours.",
        instances: [{ docId: "D1", relPath: "docs/api.md", line: 114, quote: "Tokens expire after 24 hours.", quality: "exact" }],
      },
      {
        label: "Site B",
        quote: "Tokens are valid for 7 days.",
        instances: [
          { docId: "D2", relPath: "docs/auth.md", line: 57, quote: "Tokens are valid for 7 days.", quality: "exact" },
          { docId: "D3", relPath: "README.md", line: 203, quote: "Tokens are valid for 7 days.", quality: "exact" },
        ],
      },
    ],
    options: [
      {
        id: "A",
        label: "align on 24 hours",
        consequence: "2 edits.",
        editSites: [{ docId: "D2", relPath: "docs/auth.md", line: 57, quote: "Tokens are valid for 7 days.", quality: "exact" }],
        replacements: ["Tokens expire after 24 hours."],
      },
      {
        id: "B",
        label: "align on 7 days",
        consequence: "1 edit.",
        editSites: [{ docId: "D1", relPath: "docs/api.md", line: 114, quote: "Tokens expire after 24 hours.", quality: "exact" }],
        replacements: ["Tokens are valid for 7 days."],
      },
    ],
    severity: { score: 11, band: "high", factors: { modality: 3, detectability: 3, blast: 1, hazard: 0 } },
    confidence: { base: 70, delta: 25, score: 95, outcome: "all-upheld", upheld: 3, refuted: 0, confused: 0 },
    seats: ["shard-2", "codex"],
    fingerprint: "fp-one",
    ...over,
  };
}

function planFile(findings: Finding[]): PlanFile {
  return {
    schema: PLAN_SCHEMA_VERSION,
    meta: {
      runId: "run-20260102-030405-abcd",
      round: 1,
      documents: [{ id: "D1", relPath: "docs/api.md", lines: 200 }],
      seats: ["shard-1", "codex"],
      refutedCount: 1,
      skipped: [],
    },
    findings,
    unverifiable: [],
    outsideRefs: [],
  };
}

// How a human edits the file: replace "[ ] X" with "[x] X" on the Resolution
// line of one finding, and optionally type under its Comment: marker.
function tick(md: string, id: string, label: string): string {
  return editBlock(md, id, (block) =>
    block.replace(new RegExp(`\\[ \\] ${label}\\b`), `[x] ${label}`)
  );
}

function comment(md: string, id: string, text: string): string {
  return editBlock(md, id, (block) => block.replace(/\*\*Comment:\*\*\n/, `**Comment:**\n\n${text}\n`));
}

function editBlock(md: string, id: string, fn: (block: string) => string): string {
  const start = md.indexOf(`### ${id} `);
  if (start === -1) throw new Error(`no block for ${id}`);
  const nextHeading = md.indexOf("\n### ", start + 1);
  const end = nextHeading === -1 ? md.length : nextHeading;
  return md.slice(0, start) + fn(md.slice(start, end)) + md.slice(end);
}

describe("renderPlan", () => {
  test("cites every instance of every side", () => {
    const md = renderPlan(planFile([finding()]));
    expect(md).toContain("`docs/api.md:114`");
    expect(md).toContain("`docs/auth.md:57`, `README.md:203`");
  });

  test("no finding recommends an option, and the plan says so out loud", () => {
    const md = renderPlan(planFile([finding()]));
    // The disclaimer is in the preamble; the findings themselves must be free
    // of any word that reads as a verdict on which side is right.
    const findingsSection = md.slice(md.indexOf("## Findings"));
    for (const verdict of [/recommend/i, /\bbetter\b/i, /\bcorrect(?!ness)\b/i, /\bshould use\b/i, /\bprefer\b/i]) {
      expect(findingsSection).not.toMatch(verdict);
    }
    expect(md).toMatch(/No option is recommended/);
  });

  test("offers exactly this finding's options plus the two terminal choices", () => {
    const md = renderPlan(planFile([finding()]));
    expect(md).toContain("**Resolution:** [ ] A  ·  [ ] B  ·  [ ] change nothing  ·  [ ] comment");
  });

  test("a three-option finding gets three letters", () => {
    const f = finding({
      options: [
        ...finding().options,
        { id: "C", label: "split the term", consequence: "3 edits.", editSites: [], replacements: [] },
      ],
    });
    expect(renderPlan(planFile([f]))).toContain("[ ] A  ·  [ ] B  ·  [ ] C  ·  [ ] change nothing");
  });

  test("an unrefuted finding says so rather than implying it was verified", () => {
    const f = finding({ confidence: { base: 70, delta: 0, score: 70, outcome: "unrefuted", upheld: 0, refuted: 0, confused: 0 } });
    expect(renderPlan(planFile([f]))).toMatch(/not refuted \(below the refutation cap\)/);
  });

  test("a severity override is disclosed with its reason", () => {
    const f = finding({
      severity: {
        score: 4,
        band: "high",
        factors: { modality: 1, detectability: 3, blast: 1, hazard: 0 },
        override: { direction: "up", reason: "this value bricks the cluster", from: "medium" },
      },
    });
    expect(renderPlan(planFile([f]))).toMatch(/severity moved up from medium — this value bricks the cluster/);
  });

  test("low-confidence findings are written out in full, not summarized away", () => {
    const f = finding({ confidence: { base: 30, delta: -15, score: 15, outcome: "split", upheld: 1, refuted: 1, confused: 0 } });
    const md = renderPlan(planFile([f]));
    expect(md).toContain("## Low confidence (1)");
    expect(md).toContain("Tokens expire after 24 hours.");
    expect(md).toContain("**Resolution:**");
  });

  test("refuted findings are listed for the record and carry no resolution line", () => {
    const f = finding({ confidence: { base: 36, delta: -60, score: 0, outcome: "all-refuted", upheld: 0, refuted: 3, confused: 0 } });
    const md = renderPlan(planFile([f]));
    expect(md).toContain("## Refuted (1)");
    expect(md.slice(md.indexOf("## Refuted"))).not.toContain("**Resolution:**");
  });

  test("caps that bit are stated in the plan itself", () => {
    const p = planFile([finding()]);
    p.meta.skipped = ["refutation ran on the top 15 of 32 findings"];
    expect(renderPlan(p)).toMatch(/What this run did not do[\s\S]*top 15 of 32/);
  });

  test("unverifiable claims and outside references get their own sections", () => {
    const p = planFile([finding()]);
    p.unverifiable = [{ kind: "contradiction", title: "something", seat: "shard-1", reason: "quote not found" }];
    p.outsideRefs = [{ relPath: "a.md", line: 3, target: "CONTRIBUTING.md", reason: "outside" }];
    const md = renderPlan(p);
    expect(md).toContain("## Unverifiable claims (1)");
    expect(md).toContain("## References outside the review set (1)");
  });
});

describe("parsePlan and planStatus", () => {
  const p = () => planFile([finding(), finding({ id: "F-02", fingerprint: "fp-two" })]);

  test("an untouched plan is 'not reviewed', not a pile of errors", () => {
    const plan = p();
    const status = planStatus(parsePlan(renderPlan(plan), plan));
    expect(status.action).toBe("NOT-REVIEWED");
    expect(status.reasons).toHaveLength(1);
  });

  test("a fully answered plan applies", () => {
    const plan = p();
    let md = renderPlan(plan);
    md = tick(md, "F-01", "A");
    md = tick(md, "F-02", "change nothing");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("APPLY");
    expect(status.resolved).toEqual([{ id: "F-01", optionId: "A" }]);
    expect(status.declined).toEqual(["F-02"]);
  });

  test("a half-answered plan blocks and names the gap", () => {
    const plan = p();
    const md = tick(renderPlan(plan), "F-01", "A");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("BLOCKED");
    expect(status.reasons).toEqual(["F-02: no box ticked"]);
  });

  test("any comment sends the round back before anything is edited", () => {
    const plan = p();
    let md = renderPlan(plan);
    md = tick(md, "F-01", "A");
    md = comment(md, "F-02", "this is scoped to staging only");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("REGENERATE");
    expect(status.comments).toEqual([{ id: "F-02", text: "this is scoped to staging only" }]);
  });

  test("comment text beats a ticked option -- never edit what is still under discussion", () => {
    const plan = p();
    let md = renderPlan(plan);
    md = tick(md, "F-01", "A");
    md = comment(md, "F-01", "actually, are these the same thing?");
    md = tick(md, "F-02", "change nothing");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("REGENERATE");
    expect(status.resolved).toEqual([]);
    expect(status.comments[0].id).toBe("F-01");
  });

  test("a multi-paragraph comment survives intact", () => {
    const plan = planFile([finding()]);
    const md = comment(renderPlan(plan), "F-01", "First thought.\n\n- a list item\n- another\n\nSecond thought.");
    const status = planStatus(parsePlan(md, plan));
    expect(status.comments[0].text).toContain("a list item");
    expect(status.comments[0].text).toContain("Second thought.");
  });

  test("two boxes ticked blocks rather than picking one", () => {
    const plan = planFile([finding()]);
    let md = tick(renderPlan(plan), "F-01", "A");
    md = tick(md, "F-01", "B");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("BLOCKED");
    expect(status.reasons[0]).toMatch(/2 boxes ticked/);
  });

  test("ticking comment without writing one is an error, not a silent skip", () => {
    const plan = planFile([finding()]);
    const md = tick(renderPlan(plan), "F-01", "comment");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("BLOCKED");
    expect(status.reasons[0]).toMatch(/no comment text/);
  });

  test("an option letter this finding does not offer is an error", () => {
    const plan = planFile([finding()]);
    const md = renderPlan(plan).replace("[ ] change nothing", "[x] Z");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("BLOCKED");
    expect(status.reasons[0]).toMatch(/not one of this finding's options \(A, B\)/);
  });

  test("a deleted finding block blocks rather than being treated as declined", () => {
    const plan = p();
    const md = tick(renderPlan(plan), "F-01", "A").replace(/### F-02[\s\S]*?(?=\n---)/, "");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("BLOCKED");
    expect(status.reasons.some((r) => r.includes("F-02") && r.includes("missing"))).toBe(true);
  });

  test("a heading for a finding this run never produced is reported", () => {
    const plan = planFile([finding()]);
    // Inserted before the Comments section, since everything after that heading
    // is global comment text by design.
    const md = renderPlan(plan).replace("## Comments", "### F-99 · invented\n\n**Resolution:** [x] A\n\n## Comments");
    const parsed = parsePlan(md, plan);
    expect(parsed.unknownIds).toEqual(["F-99"]);
  });

  test("a finding block pasted after the Comments heading reads as global text, not a finding", () => {
    const plan = planFile([finding()]);
    const md = tick(renderPlan(plan), "F-01", "A") + "\n### F-99 · invented\n";
    const parsed = parsePlan(md, plan);
    expect(parsed.unknownIds).toEqual([]);
    expect(planStatus(parsed).action).toBe("REGENERATE");
  });

  test("[X] and [*] count as ticked", () => {
    const plan = planFile([finding()]);
    for (const mark of ["X", "*"]) {
      const md = renderPlan(plan).replace("[ ] B", `[${mark}] B`);
      expect(planStatus(parsePlan(md, plan)).resolved).toEqual([{ id: "F-01", optionId: "B" }]);
    }
  });

  test("reformatting the prose does not change the parse", () => {
    const plan = planFile([finding()]);
    let md = tick(renderPlan(plan), "F-01", "A");
    md = md.replace("Two passages state different token lifetimes.", "I rewrote this summary entirely, and added notes.");
    md = md.replace("**Your options**", "**My notes on the options**");
    expect(planStatus(parsePlan(md, plan)).resolved).toEqual([{ id: "F-01", optionId: "A" }]);
  });

  test("the global comments section triggers regeneration on its own", () => {
    const plan = planFile([finding()]);
    let md = tick(renderPlan(plan), "F-01", "A");
    md += "\nStop flagging synonym variation entirely.\n";
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("REGENERATE");
    expect(status.globalComment).toContain("Stop flagging synonym variation");
  });

  test("the rendered boilerplate under Comments is not mistaken for a comment", () => {
    const plan = planFile([finding()]);
    const md = tick(renderPlan(plan), "F-01", "A");
    expect(planStatus(parsePlan(md, plan)).action).toBe("APPLY");
  });

  test("every finding declined means there is nothing to do", () => {
    const plan = planFile([finding()]);
    const md = tick(renderPlan(plan), "F-01", "change nothing");
    expect(planStatus(parsePlan(md, plan)).action).toBe("NOTHING-TO-DO");
  });

  test("a run with no findings needing a decision is nothing to do, not not-reviewed", () => {
    const plan = planFile([]);
    expect(planStatus(parsePlan(renderPlan(plan), plan)).action).toBe("NOTHING-TO-DO");
  });

  test("refuted findings need no disposition and never block apply", () => {
    const refuted = finding({
      id: "F-02",
      fingerprint: "fp-two",
      confidence: { base: 36, delta: -60, score: 0, outcome: "all-refuted", upheld: 0, refuted: 3, confused: 0 },
    });
    const plan = planFile([finding(), refuted]);
    const md = tick(renderPlan(plan), "F-01", "A");
    const status = planStatus(parsePlan(md, plan));
    expect(status.action).toBe("APPLY");
    expect(status.undecided).toEqual([]);
  });

  test("low-confidence findings DO need a disposition", () => {
    const low = finding({
      id: "F-02",
      fingerprint: "fp-two",
      confidence: { base: 30, delta: -15, score: 15, outcome: "split", upheld: 1, refuted: 1, confused: 0 },
    });
    const plan = planFile([finding(), low]);
    const md = tick(renderPlan(plan), "F-01", "A");
    expect(planStatus(parsePlan(md, plan)).action).toBe("BLOCKED");
  });
});

describe("decisions ledger", () => {
  test("records declines and resolutions by fingerprint", () => {
    const plan = planFile([finding(), finding({ id: "F-02", fingerprint: "fp-two" })]);
    let md = renderPlan(plan);
    md = tick(md, "F-01", "A");
    md = tick(md, "F-02", "change nothing");
    const status = planStatus(parsePlan(md, plan));
    const d = recordDecisions(emptyDecisions(), plan, status, 1);
    expect(d.resolved).toEqual([{ fingerprint: "fp-one", optionId: "A", round: 1 }]);
    expect(d.declined).toEqual([{ fingerprint: "fp-two", title: "Token lifetime disagrees", round: 1 }]);
  });

  test("re-recording the same decision does not duplicate it", () => {
    const plan = planFile([finding()]);
    const md = tick(renderPlan(plan), "F-01", "change nothing");
    const status = planStatus(parsePlan(md, plan));
    const once = recordDecisions(emptyDecisions(), plan, status, 1);
    const twice = recordDecisions(once, plan, status, 2);
    expect(twice.declined).toHaveLength(1);
    expect(twice.declined[0].round).toBe(1);
  });

  test("declinedFingerprints is what suppression reads", () => {
    const d = { declined: [{ fingerprint: "fp-two", title: "t", round: 1 }], resolved: [] };
    expect(declinedFingerprints(d).has("fp-two")).toBe(true);
    expect(declinedFingerprints(d).has("fp-one")).toBe(false);
  });
});
